"""Limitador partilhado em Redis e recurso ao limitador local quando o Redis falha."""
import os
import time

import pytest

from src.app.auth.ratelimit import RateLimiter, RedisRateLimiter


class _BrokenRedis:
    """Cliente que falha sempre, como um Redis em baixo."""

    def register_script(self, _lua):
        def run(**_kw):
            raise ConnectionError("redis down")

        return run


def test_memory_limiter_window():
    rl = RateLimiter()
    assert rl.hit("k", limit=2, window_seconds=60) is None
    assert rl.hit("k", limit=2, window_seconds=60) is None
    assert rl.hit("k", limit=2, window_seconds=60) >= 1


class _Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_memory_limiter_forgets_ips_after_their_window():
    clock = _Clock()
    rl = RateLimiter(clock=clock)
    rl.hit("ip:1.2.3.4", limit=5, window_seconds=60)
    clock.t += 61
    rl.hit("ip:5.6.7.8", limit=5, window_seconds=60)  # dispara a limpeza
    assert len(rl) == 1  # o IP antigo foi apagado


def test_short_window_does_not_reset_long_window_counters():
    clock = _Clock()
    rl = RateLimiter(clock=clock)
    assert rl.hit("wl:ip:9.9.9.9", limit=1, window_seconds=3600) is None
    clock.t += 120
    rl.hit("ip:1.1.1.1", limit=30, window_seconds=60)  # limpeza com janela curta
    assert rl.hit("wl:ip:9.9.9.9", limit=1, window_seconds=3600) is not None  # continua bloqueado


def test_redis_down_falls_back_to_local_limits():
    rl = RedisRateLimiter(_BrokenRedis())
    assert rl.hit("k", limit=1, window_seconds=60) is None
    assert rl.hit("k", limit=1, window_seconds=60) >= 1  # continua a limitar
    assert rl.degraded


@pytest.fixture
def redis_client():
    url = os.getenv("TEST_REDIS_URL")
    if not url:
        pytest.skip("TEST_REDIS_URL não definido (o CI corre isto contra Redis)")
    import redis

    client = redis.Redis.from_url(url)
    client.flushdb()
    yield client
    client.flushdb()


def test_limits_are_shared_between_instances(redis_client):
    a, b = RedisRateLimiter(redis_client), RedisRateLimiter(redis_client)  # duas instâncias da API
    assert a.hit("ip:1.2.3.4", limit=3, window_seconds=60) is None
    assert b.hit("ip:1.2.3.4", limit=3, window_seconds=60) is None
    assert a.hit("ip:1.2.3.4", limit=3, window_seconds=60) is None
    wait = b.hit("ip:1.2.3.4", limit=3, window_seconds=60)
    assert wait is not None and 1 <= wait <= 60
    assert a.hit("ip:5.6.7.8", limit=3, window_seconds=60) is None  # outras chaves não são afetadas
    assert not a.degraded


def test_window_slides(redis_client):
    rl = RedisRateLimiter(redis_client)
    assert rl.hit("k", limit=1, window_seconds=1) is None
    assert rl.hit("k", limit=1, window_seconds=1) == 1
    time.sleep(1.1)
    assert rl.hit("k", limit=1, window_seconds=1) is None
    assert redis_client.pttl("lusorbe:rl:k") <= 1000  # as chaves expiram sozinhas
