"""Firewall da aplicação (middleware ASGI, em memória, uma instância).

Camadas, por ordem:
1. IP banido temporariamente -> 403.
2. Sondagens conhecidas (/.env, /.git, /wp-admin...) -> 404 e contam para ban.
3. Limite de pedidos por IP -> 429.
4. Corpo acima do limite (Content-Length ou stream) -> 413.
5. Headers de segurança em todas as respostas.
Respostas 401/403/429 também contam como infrações; ao acumular infrações o
IP é banido durante algum tempo.

Atrás de um proxy, configura o uvicorn com --proxy-headers e
--forwarded-allow-ips, senão o IP visto é o do proxy. Para várias instâncias,
mover o estado para Redis.
"""
from __future__ import annotations

import os
import re
import time
from collections import defaultdict, deque

from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_BODY_BYTES = int(os.getenv("FIREWALL_MAX_BODY_BYTES", str(1024 * 1024)))
RATE_LIMIT = int(os.getenv("FIREWALL_RATE_PER_MINUTE", "120"))
STRIKE_LIMIT = int(os.getenv("FIREWALL_STRIKES_BEFORE_BAN", "20"))
STRIKE_WINDOW = 600
BAN_SECONDS = int(os.getenv("FIREWALL_BAN_SECONDS", "900"))
_MAX_TRACKED_IPS = 50_000

_PROBE = re.compile(
    r"^/(\.env|\.git|\.svn|\.aws|\.ssh|wp-(admin|login|content|includes)|xmlrpc\.php|phpmyadmin"
    r"|admin\.php|config\.php|server-status|actuator|cgi-bin|vendor/phpunit|boaform)",
    re.IGNORECASE,
)
_STRIKE_STATUSES = {401, 403, 429}

_BASE_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-site"),
    (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"),
    (b"cache-control", b"no-store"),
]
_HSTS = (b"strict-transport-security", b"max-age=63072000; includeSubDomains")


class _State:
    def __init__(self) -> None:
        self.hits: dict[str, deque[float]] = defaultdict(deque)
        self.strikes: dict[str, deque[float]] = defaultdict(deque)
        self.banned: dict[str, float] = {}

    def _prune(self, now: float) -> None:
        if len(self.hits) + len(self.strikes) < _MAX_TRACKED_IPS:
            return
        for table, window in ((self.hits, 60), (self.strikes, STRIKE_WINDOW)):
            for ip in [ip for ip, q in table.items() if not q or now - q[-1] > window]:
                del table[ip]
        for ip in [ip for ip, until in self.banned.items() if until <= now]:
            del self.banned[ip]

    def is_banned(self, ip: str, now: float) -> bool:
        until = self.banned.get(ip)
        if until is None:
            return False
        if until <= now:
            del self.banned[ip]
            return False
        return True

    def over_rate(self, ip: str, now: float) -> bool:
        self._prune(now)
        q = self.hits[ip]
        while q and now - q[0] >= 60:
            q.popleft()
        if len(q) >= RATE_LIMIT:
            return True
        q.append(now)
        return False

    def strike(self, ip: str, now: float, weight: int = 1) -> None:
        q = self.strikes[ip]
        while q and now - q[0] >= STRIKE_WINDOW:
            q.popleft()
        q.extend([now] * weight)
        if len(q) >= STRIKE_LIMIT:
            self.banned[ip] = now + BAN_SECONDS
            q.clear()


class FirewallMiddleware:
    def __init__(self, app: ASGIApp, production: bool | None = None) -> None:
        self.app = app
        self.state = _State()
        if production is None:
            production = os.getenv("ENV", "production").lower() not in {"development", "dev", "test"}
        self.headers = _BASE_HEADERS + ([_HSTS] if production else [])

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        client = scope.get("client")
        ip = client[0] if client else "unknown"
        now = time.monotonic()
        st = self.state

        if st.is_banned(ip, now):
            await self._reject(send, 403, b"Acesso temporariamente bloqueado.")
            return
        if _PROBE.match(scope.get("path", "")):
            st.strike(ip, now, weight=5)
            await self._reject(send, 404, b"Not Found")
            return
        if st.over_rate(ip, now):
            st.strike(ip, now)
            await self._reject(send, 429, b"Demasiados pedidos.", extra=[(b"retry-after", b"60")])
            return

        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    too_big = int(value) > MAX_BODY_BYTES
                except ValueError:
                    too_big = True
                if too_big:
                    await self._reject(send, 413, b"Pedido demasiado grande.")
                    return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_BODY_BYTES:
                    raise _BodyTooLarge
            return message

        started = False

        async def secured_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                if message["status"] in _STRIKE_STATUSES:
                    st.strike(ip, time.monotonic())
                existing = {k.lower() for k, _ in message.get("headers", [])}
                message.setdefault("headers", [])
                message["headers"] = list(message["headers"]) + [
                    h for h in self.headers if h[0] not in existing
                ]
            await send(message)

        try:
            await self.app(scope, limited_receive, secured_send)
        except _BodyTooLarge:
            if not started:
                await self._reject(send, 413, b"Pedido demasiado grande.")

    async def _reject(self, send: Send, status: int, body: bytes, extra: list[tuple[bytes, bytes]] | None = None) -> None:
        headers = [(b"content-type", b"text/plain; charset=utf-8"), (b"content-length", str(len(body)).encode())]
        await send({"type": "http.response.start", "status": status, "headers": headers + self.headers + (extra or [])})
        await send({"type": "http.response.body", "body": body})


class _BodyTooLarge(Exception):
    pass
