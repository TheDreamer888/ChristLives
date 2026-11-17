"""Limitador de pedidos (janela deslizante) com dois motores.

* Sem `REDIS_URL` → `RateLimiter` em memória (uma instância / desenvolvimento).
* Com `REDIS_URL` → `RedisRateLimiter`: todas as instâncias da API partilham os
  contadores, por isso o limite é o mesmo seja qual for a instância que recebe
  o pedido. Um script Lua faz a contagem de forma atómica e usa o relógio do
  Redis, para que instâncias com relógios desacertados contem igual.

Se o Redis falhar, o limitador recorre ao motor em memória (degradado, mas
nunca "aberto": continua a haver limite por instância).
"""
from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from collections import defaultdict, deque

log = logging.getLogger(__name__)

_MAX_KEYS = 50_000


class RateLimiter:
    """Janela deslizante em memória.

    Cada chave guarda a sua própria janela. A cada minuto apagam-se as chaves
    sem pedidos dentro da janela delas, para os IPs não ficarem em memória mais
    tempo do que o necessário (a política de privacidade promete isto).
    """

    shared = False
    PRUNE_EVERY = 60.0

    def __init__(self, clock=time.monotonic) -> None:
        self._clock = clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._windows: dict[str, int] = {}
        self._lock = threading.Lock()
        self._last_prune = clock()

    def hit(self, key: str, limit: int, window_seconds: int) -> int | None:
        """Regista um pedido. Devolve os segundos de espera se o limite foi excedido."""
        now = self._clock()
        with self._lock:
            if now - self._last_prune >= self.PRUNE_EVERY or len(self._hits) > _MAX_KEYS:
                self._prune(now)
            self._windows[key] = max(window_seconds, self._windows.get(key, 0))
            hits = self._hits[key]
            while hits and now - hits[0] >= window_seconds:
                hits.popleft()
            if len(hits) >= limit:
                return max(1, int(window_seconds - (now - hits[0])))
            hits.append(now)
            return None

    def _prune(self, now: float) -> None:
        self._last_prune = now
        for key in [k for k, v in self._hits.items() if not v or now - v[-1] >= self._windows.get(k, 0)]:
            del self._hits[key]
            self._windows.pop(key, None)

    def __len__(self) -> int:
        return len(self._hits)

    def clear(self) -> None:
        with self._lock:
            self._hits.clear()
            self._windows.clear()


# KEYS[1] = chave; ARGV = limite, janela (ms), id único do pedido.
# Devolve 0 se o pedido passa, ou os segundos de espera.
_SLIDING_WINDOW_LUA = """
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
if redis.call('ZCARD', key) >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local wait = math.ceil((tonumber(oldest[2]) + window - now) / 1000)
  if wait < 1 then wait = 1 end
  return wait
end
redis.call('ZADD', key, now, ARGV[3])
redis.call('PEXPIRE', key, window)
return 0
"""


class RedisRateLimiter:
    shared = True

    def __init__(self, client, prefix: str = "lusorbe:rl:") -> None:
        self._client = client
        self._prefix = prefix
        self._script = client.register_script(_SLIDING_WINDOW_LUA)
        self._fallback = RateLimiter()
        self._degraded_since: float | None = None

    @property
    def degraded(self) -> bool:
        return self._degraded_since is not None

    def hit(self, key: str, limit: int, window_seconds: int) -> int | None:
        try:
            wait = int(self._script(keys=[self._prefix + key], args=[limit, window_seconds * 1000, uuid.uuid4().hex]))
        except Exception as exc:  # redis.RedisError, timeouts, DNS…
            if self._degraded_since is None:
                self._degraded_since = time.time()
                log.warning("Redis indisponível (%s); a usar limites locais.", type(exc).__name__)
            return self._fallback.hit(key, limit, window_seconds)
        if self._degraded_since is not None:
            log.warning("Redis recuperado; limites partilhados de novo.")
            self._degraded_since = None
        return wait or None

    def clear(self) -> None:
        self._fallback.clear()
        for k in self._client.scan_iter(match=self._prefix + "*"):
            self._client.delete(k)


def make_limiter() -> RateLimiter | RedisRateLimiter:
    url = (os.getenv("REDIS_URL") or "").strip()
    if not url:
        return RateLimiter()
    import redis

    client = redis.Redis.from_url(url, socket_timeout=0.5, socket_connect_timeout=0.5)
    return RedisRateLimiter(client)


limiter = make_limiter()
