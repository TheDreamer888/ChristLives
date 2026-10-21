"""Limitador de pedidos em memória (janela deslizante).

Tal como o `Store`, é local ao processo: serve para uma única instância/dev.
Em produção com várias instâncias deve ser substituído por Redis, mantendo
a mesma interface (`hit`).
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

_MAX_KEYS = 50_000


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window_seconds: int) -> int | None:
        """Regista um pedido. Devolve os segundos de espera se o limite foi excedido."""
        now = time.monotonic()
        with self._lock:
            if len(self._hits) > _MAX_KEYS:
                self._prune(now, window_seconds)
            hits = self._hits[key]
            while hits and now - hits[0] >= window_seconds:
                hits.popleft()
            if len(hits) >= limit:
                return max(1, int(window_seconds - (now - hits[0])))
            hits.append(now)
            return None

    def _prune(self, now: float, window_seconds: int) -> None:
        for key in [k for k, v in self._hits.items() if not v or now - v[-1] >= window_seconds]:
            del self._hits[key]


limiter = RateLimiter()
