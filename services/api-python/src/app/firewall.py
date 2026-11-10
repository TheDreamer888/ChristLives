"""Firewall da aplicação (WAF) para a API.

Camadas, por ordem de avaliação em cada pedido:
1. allowlist (FIREWALL_ALLOWLIST) — passa sempre;
2. blocklist manual (FIREWALL_BLOCKLIST + bloqueios do centro de segurança) e banimentos
   automáticos — 403;
3. reputação de IP com listas públicas reais (FireHOL nível 1, Spamhaus DROP, Emerging
   Threats), atualizadas em segundo plano a cada 6 h — 403;
4. método HTTP e tamanho do corpo — 405/413;
5. assinaturas no caminho, query string e User-Agent (path traversal, ficheiros sensíveis,
   SQLi, XSS, injeção de comandos, SSRF para metadados cloud, scanners) — 403;
6. limite de pedidos por IP (token bucket) — 429.

Cada bloqueio gera um evento em memória (últimas 24 h, máx. 5000) e conta como violação;
demasiadas violações num intervalo de 10 min dão banimento temporário. O corpo dos pedidos
não é inspecionado por assinaturas: o chat recebe legitimamente texto com SQL ou código.

O estado é por processo. Com várias réplicas, cada uma aplica os seus limites; a defesa de
perímetro (Cloudflare WAF, ver infra/scripts/cloudflare-waf.sh) complementa esta camada.
"""
from __future__ import annotations

import asyncio
import bisect
import ipaddress
import re
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import unquote_plus

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from src.app.config import settings
from src.pylibrary.logging import get_logger

logger = get_logger(__name__)

IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

THREAT_FEEDS: dict[str, str] = {
    "FireHOL nível 1": "https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset",
    "Spamhaus DROP": "https://www.spamhaus.org/drop/drop.txt",
    "Emerging Threats (comprometidos)": "https://rules.emergingthreats.net/blockrules/compromised-ips.txt",
}
FEED_REFRESH_SECONDS = 6 * 3600
FEED_RETRY_SECONDS = 300
FEED_MAX_BYTES = 8 * 1024 * 1024
ALLOWED_METHODS = {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
# Rotas com uploads legítimos maiores do que o limite geral.
BODY_LIMIT_OVERRIDES = {"/api/ai/analyze-pdf": 9_000_000}
VIOLATION_WINDOW_SECONDS = 600
EVENT_RETENTION_SECONDS = 24 * 3600

SIGNATURES: tuple[tuple[str, str, re.Pattern[str]], ...] = (
    ("path_traversal", "Travessia de diretórios", re.compile(r"(?:\.\./|\.\.\\|/\.\.(?:/|$)|%2e%2e)", re.IGNORECASE)),
    ("sensitive_file", "Ficheiro ou painel sensível", re.compile(
        r"/(?:\.env|\.git|\.svn|\.hg|\.htaccess|\.htpasswd|\.ds_store|wp-admin|wp-login\.php|xmlrpc\.php"
        r"|phpmyadmin|server-status|config\.php|web\.config|id_rsa|\.aws/credentials|actuator/env)(?:[/?]|$)", re.IGNORECASE)),
    ("sql_injection", "Injeção SQL", re.compile(
        r"(?:\bunion\b[\s(]+(?:all\s+)?select\b|'\s*or\s*'?\d+'?\s*=\s*'?\d|\bor\s+1\s*=\s*1\b|\bsleep\s*\(\s*\d"
        r"|\bbenchmark\s*\(|\binformation_schema\b|;\s*(?:drop|truncate|alter)\s+table\b|\bxp_cmdshell\b)", re.IGNORECASE)),
    ("xss", "Cross-site scripting", re.compile(
        r"(?:<\s*script\b|javascript\s*:|\bon(?:error|load|mouseover|focus|click)\s*=|<\s*(?:svg|img|iframe)\b[^>]*\bon\w+\s*=|document\.cookie)", re.IGNORECASE)),
    ("command_injection", "Injeção de comandos", re.compile(
        r"(?:[;|`]|\$\(|&&|\|\|)\s*(?:cat|wget|curl|bash|sh|nc|ncat|powershell|python|perl|rm|chmod)\b", re.IGNORECASE)),
    ("ssrf", "Acesso a metadados cloud (SSRF)", re.compile(
        r"(?:169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200|fd00:ec2::254)", re.IGNORECASE)),
)
SCANNER_UA = re.compile(
    r"(?:sqlmap|nikto|nmap|masscan|zgrab|nuclei|acunetix|wpscan|dirbuster|gobuster|ffuf|feroxbuster|"
    r"havij|netsparker|w3af|openvas|nessus|jaeles|commix)", re.IGNORECASE)


def _parse_networks(raw: str) -> list[IPNetwork]:
    networks: list[IPNetwork] = []
    for item in raw.replace(";", ",").split(","):
        item = item.strip()
        if not item:
            continue
        try:
            networks.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            logger.warning("Entrada de rede inválida ignorada na configuração do firewall: %r", item)
    return networks


def parse_feed(text: str) -> list[IPNetwork]:
    """Linhas `CIDR` ou `IP`, com comentários `#`/`;`. Ignora redes não públicas (bogons)."""
    networks: list[IPNetwork] = []
    for line in text.splitlines():
        token = line.split(";", 1)[0].split("#", 1)[0].strip()
        if not token:
            continue
        try:
            network = ipaddress.ip_network(token, strict=False)
        except ValueError:
            continue
        # As listas incluem bogons (10/8, 127/8, 0/8…); bloqueá-los derrubava tráfego interno.
        if network.is_global and network.prefixlen >= 8:
            networks.append(network)
    return networks


class IPRangeSet:
    """Pesquisa O(log n) de um IP num conjunto de redes (intervalos fundidos)."""

    def __init__(self, networks: list[IPNetwork] | None = None) -> None:
        self._starts: dict[int, list[int]] = {4: [], 6: []}
        self._ends: dict[int, list[int]] = {4: [], 6: []}
        self.size = 0
        if networks:
            self.replace(networks)

    def replace(self, networks: list[IPNetwork]) -> None:
        for version in (4, 6):
            ranges = sorted(
                (int(n.network_address), int(n.broadcast_address)) for n in networks if n.version == version
            )
            merged: list[list[int]] = []
            for start, end in ranges:
                if merged and start <= merged[-1][1] + 1:
                    merged[-1][1] = max(merged[-1][1], end)
                else:
                    merged.append([start, end])
            self._starts[version] = [r[0] for r in merged]
            self._ends[version] = [r[1] for r in merged]
        self.size = len(networks)

    def __contains__(self, address: IPAddress) -> bool:
        value = int(address)
        starts, ends = self._starts[address.version], self._ends[address.version]
        index = bisect.bisect_right(starts, value) - 1
        return index >= 0 and value <= ends[index]


@dataclass
class TokenBucket:
    tokens: float
    updated: float


@dataclass
class ManualBlock:
    network: IPNetwork
    reason: str
    created_at: datetime
    expires_at: datetime | None
    source: str = "manual"

    def active(self, now: datetime) -> bool:
        return self.expires_at is None or self.expires_at > now

    def public(self) -> dict[str, Any]:
        return {
            "network": str(self.network),
            "reason": self.reason,
            "source": self.source,
            "created_at": self.created_at.isoformat(timespec="seconds"),
            "expires_at": self.expires_at.isoformat(timespec="seconds") if self.expires_at else None,
        }


@dataclass
class FirewallState:
    events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=5000))
    buckets: dict[str, TokenBucket] = field(default_factory=dict)
    violations: dict[str, deque[float]] = field(default_factory=dict)
    blocks: list[ManualBlock] = field(default_factory=list)
    feeds: IPRangeSet = field(default_factory=IPRangeSet)
    feed_sources: dict[str, int] = field(default_factory=dict)
    feeds_updated_at: str | None = None
    feeds_error: str | None = None
    allowed_requests: int = 0


class Firewall:
    def __init__(self) -> None:
        self.state = FirewallState()
        self._task: asyncio.Task[None] | None = None
        self.reload_config()

    # ---------- configuração ----------
    def reload_config(self) -> None:
        self.allowlist = _parse_networks(settings.firewall_allowlist)
        self.static_blocklist = _parse_networks(settings.firewall_blocklist)
        self.trusted_proxies = _parse_networks(settings.trusted_proxies)

    def reset(self) -> None:
        self.state = FirewallState()
        self.reload_config()

    # ---------- IP do cliente ----------
    def client_ip(self, request: Request) -> IPAddress | None:
        raw = request.client.host if request.client else None
        try:
            peer = ipaddress.ip_address(raw) if raw else None
        except ValueError:
            return None
        if peer is None or not any(peer in net for net in self.trusted_proxies):
            return peer
        # Só confia no X-Forwarded-For quando o par TCP é um proxy configurado; usa o
        # endereço mais à direita que não seja de um proxy de confiança.
        forwarded = request.headers.get("x-forwarded-for", "")
        for hop in reversed([h.strip() for h in forwarded.split(",") if h.strip()]):
            try:
                address = ipaddress.ip_address(hop)
            except ValueError:
                return peer
            if not any(address in net for net in self.trusted_proxies):
                return address
        return peer

    # ---------- bloqueios manuais ----------
    def add_block(self, network: str, reason: str, minutes: int | None, source: str = "manual") -> ManualBlock:
        parsed = ipaddress.ip_network(network.strip(), strict=False)
        if any(parsed.overlaps(net) for net in self.allowlist if net.version == parsed.version):
            raise ValueError("A rede está na allowlist do firewall.")
        now = datetime.now(UTC)
        block = ManualBlock(parsed, reason.strip()[:200], now, now + timedelta(minutes=minutes) if minutes else None, source)
        self.state.blocks = [b for b in self.state.blocks if b.network != parsed] + [block]
        return block

    def remove_block(self, network: str) -> bool:
        parsed = ipaddress.ip_network(network.strip(), strict=False)
        before = len(self.state.blocks)
        self.state.blocks = [b for b in self.state.blocks if b.network != parsed]
        self.state.violations.pop(str(parsed.network_address), None)
        return len(self.state.blocks) != before

    def active_blocks(self) -> list[ManualBlock]:
        now = datetime.now(UTC)
        self.state.blocks = [b for b in self.state.blocks if b.active(now)]
        return list(self.state.blocks)

    # ---------- decisão ----------
    def _record(self, ip: IPAddress | None, request: Request, rule: str, label: str, status: int) -> None:
        now = time.time()
        while self.state.events and now - self.state.events[0]["ts"] > EVENT_RETENTION_SECONDS:
            self.state.events.popleft()
        self.state.events.append({
            "ts": now,
            "at": datetime.fromtimestamp(now, UTC).isoformat(timespec="seconds"),
            "ip": str(ip) if ip else "desconhecido",
            "method": request.method,
            "path": request.url.path[:200],
            "rule": rule,
            "label": label,
            "status": status,
            "user_agent": request.headers.get("user-agent", "")[:160],
        })
        if ip is None or rule in {"blocklist", "auto_ban"}:
            return
        key = str(ip)
        window = self.state.violations.setdefault(key, deque())
        window.append(now)
        while window and now - window[0] > VIOLATION_WINDOW_SECONDS:
            window.popleft()
        if len(window) >= settings.firewall_ban_threshold and not any(
            b.source == "auto" and ip in b.network for b in self.active_blocks()
        ):
            self.add_block(key, f"Banimento automático: {len(window)} violações em 10 min", settings.firewall_ban_minutes, "auto")
            logger.warning("Firewall: IP banido automaticamente após %s violações.", len(window))

    def _rate_limited(self, ip: IPAddress) -> bool:
        now = time.monotonic()
        rate = settings.firewall_requests_per_minute / 60
        capacity = float(settings.firewall_burst)
        bucket = self.state.buckets.get(str(ip))
        if bucket is None:
            bucket = self.state.buckets[str(ip)] = TokenBucket(capacity, now)
        bucket.tokens = min(capacity, bucket.tokens + (now - bucket.updated) * rate)
        bucket.updated = now
        if len(self.state.buckets) > 50_000:
            stale = [k for k, b in self.state.buckets.items() if now - b.updated > 600]
            for key in stale:
                self.state.buckets.pop(key, None)
        if bucket.tokens < 1:
            return True
        bucket.tokens -= 1
        return False

    def inspect(self, request: Request) -> tuple[int, str, str] | None:
        """Devolve (status, regra, motivo) para bloquear, ou None para deixar passar."""
        ip = self.client_ip(request)
        if ip is not None and any(ip in net for net in self.allowlist):
            return None
        if ip is not None:
            if any(ip in net for net in self.static_blocklist):
                return 403, "blocklist", "Endereço na blocklist do firewall"
            for block in self.active_blocks():
                if ip in block.network:
                    return 403, "auto_ban" if block.source == "auto" else "blocklist", block.reason or "Bloqueado"
            if ip.is_global and ip in self.state.feeds:
                return 403, "threat_intel", "IP presente em listas públicas de ameaças"

        if request.method.upper() not in ALLOWED_METHODS:
            return 405, "method", "Método HTTP não permitido"
        length = request.headers.get("content-length")
        limit = BODY_LIMIT_OVERRIDES.get(request.url.path, settings.firewall_max_body_bytes)
        if length is not None:
            if not length.isdigit():
                return 400, "body", "Content-Length inválido"
            if int(length) > limit:
                return 413, "body", "Pedido demasiado grande"

        target = unquote_plus(unquote_plus(request.url.path + ("?" + request.url.query if request.url.query else "")))
        for rule, label, pattern in SIGNATURES:
            if pattern.search(target):
                return 403, rule, label
        if SCANNER_UA.search(request.headers.get("user-agent", "")):
            return 403, "scanner", "Ferramenta de varrimento automático"

        if ip is not None and self._rate_limited(ip):
            return 429, "rate_limit", "Demasiados pedidos"
        return None

    async def __call__(self, request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        if not settings.firewall_enabled or request.url.path in {"/health", "/health/ready"}:
            return await call_next(request)
        verdict = self.inspect(request)
        if verdict is None:
            self.state.allowed_requests += 1
            return await call_next(request)
        status, rule, label = verdict
        self._record(self.client_ip(request), request, rule, label, status)
        headers = {"Retry-After": "60"} if status == 429 else {}
        return JSONResponse(
            {"detail": "Pedido bloqueado pelo firewall do Aegis." if status == 403 else label, "rule": rule},
            status_code=status,
            headers=headers,
        )

    # ---------- listas de ameaças ----------
    async def refresh_feeds(self, client: httpx.AsyncClient | None = None) -> None:
        own = client is None
        client = client or httpx.AsyncClient(timeout=30, follow_redirects=False, headers={"User-Agent": "Aegis-Firewall/1.0"})
        networks: list[IPNetwork] = []
        sources: dict[str, int] = {}
        errors: list[str] = []
        try:
            for name, url in THREAT_FEEDS.items():
                try:
                    response = await client.get(url)
                    response.raise_for_status()
                    if len(response.content) > FEED_MAX_BYTES:
                        raise ValueError("lista demasiado grande")
                    parsed = parse_feed(response.text)
                    if not parsed:
                        raise ValueError("lista vazia ou com formato inválido")
                    networks.extend(parsed)
                    sources[name] = len(parsed)
                except (httpx.HTTPError, ValueError, UnicodeError) as exc:
                    errors.append(f"{name}: {type(exc).__name__}")
        finally:
            if own:
                await client.aclose()
        if networks:
            self.state.feeds.replace(networks)
            self.state.feed_sources = sources
            self.state.feeds_updated_at = datetime.now(UTC).isoformat(timespec="seconds")
        self.state.feeds_error = "; ".join(errors) or None
        logger.info("Firewall: %s redes carregadas de listas de ameaças (%s).", len(networks), sources)

    async def _refresh_loop(self) -> None:
        while True:
            try:
                await self.refresh_feeds()
            except Exception:
                logger.exception("Falha inesperada ao atualizar listas de ameaças.")
            # Se alguma lista falhou, tenta de novo mais cedo em vez de esperar 6 h.
            await asyncio.sleep(FEED_RETRY_SECONDS if self.state.feeds_error else FEED_REFRESH_SECONDS)

    def start(self) -> None:
        if settings.firewall_enabled and settings.firewall_threat_feeds and (self._task is None or self._task.done()):
            self._task = asyncio.create_task(self._refresh_loop())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    # ---------- relatórios ----------
    def recent_events(self, limit: int = 200) -> list[dict[str, Any]]:
        now = time.time()
        events = [e for e in self.state.events if now - e["ts"] <= EVENT_RETENTION_SECONDS]
        return [{k: v for k, v in e.items() if k != "ts"} for e in reversed(events)][:limit]

    def summary(self) -> dict[str, Any]:
        events = self.recent_events(5000)
        by_rule: dict[str, int] = {}
        by_ip: dict[str, int] = {}
        for event in events:
            by_rule[event["label"]] = by_rule.get(event["label"], 0) + 1
            by_ip[event["ip"]] = by_ip.get(event["ip"], 0) + 1
        return {
            "enabled": settings.firewall_enabled,
            "blocked_24h": len(events),
            "allowed_requests": self.state.allowed_requests,
            "by_rule": dict(sorted(by_rule.items(), key=lambda kv: kv[1], reverse=True)),
            "top_sources": sorted(by_ip.items(), key=lambda kv: kv[1], reverse=True)[:10],
            "active_blocks": len(self.active_blocks()),
            "rules": [label for _, label, _ in SIGNATURES] + ["Scanners automáticos", "Limite de pedidos", "Tamanho do pedido", "Reputação de IP"],
            "limits": {
                "requests_per_minute": settings.firewall_requests_per_minute,
                "burst": settings.firewall_burst,
                "ban_threshold": settings.firewall_ban_threshold,
                "ban_minutes": settings.firewall_ban_minutes,
                "max_body_bytes": settings.firewall_max_body_bytes,
            },
            "threat_intel": {
                "networks": self.state.feeds.size,
                "sources": self.state.feed_sources,
                "updated_at": self.state.feeds_updated_at,
                "error": self.state.feeds_error,
            },
        }


firewall = Firewall()
