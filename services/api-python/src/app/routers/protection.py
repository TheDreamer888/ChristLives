"""Filtros locais de URLs; nunca visita os destinos submetidos."""
from __future__ import annotations

import asyncio
import ipaddress
import re
import time
from datetime import datetime, timezone
from urllib.parse import unquote, urlsplit

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.pylibrary.logging import get_logger

router = APIRouter(prefix="/api/protect", tags=["protection"])
logger = get_logger(__name__)
FEED_URL = "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.mini-onlydomains.txt"
DOMAIN = re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
EXECUTABLES = (".exe", ".msi", ".scr", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".jar", ".apk")


class UrlCheckRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class ThreatFeed:
    def __init__(self) -> None:
        self.domains: frozenset[str] = frozenset()
        self.updated_at: str | None = None
        self.refreshed = 0.0
        self.retry_after = 0.0
        self.lock = asyncio.Lock()

    async def get(self) -> frozenset[str]:
        async with self.lock:
            now = time.monotonic()
            if self.refreshed and now - self.refreshed < 8 * 3600 and self.domains:
                return self.domains
            if now < self.retry_after:
                raise HTTPException(503, "Lista de ameaças indisponível. Tenta novamente mais tarde.")
            try:
                async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
                    async with client.stream("GET", FEED_URL) as response:
                        response.raise_for_status()
                        content = bytearray()
                        async for chunk in response.aiter_bytes():
                            content.extend(chunk)
                            if len(content) > 16 * 1024 * 1024:
                                raise ValueError("Lista de ameaças demasiado grande.")
                lines = content.decode("utf-8").splitlines()
                entries = [line.strip().lower() for line in lines if line.strip() and not line.startswith("#")]
                if not entries or any(DOMAIN.fullmatch(entry) is None for entry in entries):
                    raise ValueError("Formato da lista de ameaças inválido.")
                self.domains = frozenset(entries)
                self.refreshed = time.monotonic()
                self.updated_at = datetime.now(timezone.utc).isoformat()
                return self.domains
            except (httpx.HTTPError, ValueError, UnicodeError) as exc:
                self.retry_after = time.monotonic() + 60
                logger.error("Não foi possível atualizar a lista de ameaças: %s", type(exc).__name__)
                # Uma lista expirada não autoriza um resultado aparentemente limpo.
                raise HTTPException(503, "Lista de ameaças indisponível. Não foi possível concluir a verificação.") from exc


feed = ThreatFeed()


def inspect_url(value: str) -> tuple[str, list[str]]:
    value = value.strip()
    if not value or re.search(r"[\s\\\x00-\x1f\x7f]", value):
        raise HTTPException(422, "URL/domínio inválido: não uses espaços, controlos ou barras invertidas.")
    try:
        parsed = urlsplit(value if "://" in value else f"https://{value}")
        host = (parsed.hostname or "").rstrip(".").encode("idna").decode("ascii").lower()
        port = parsed.port
    except (ValueError, UnicodeError) as exc:
        raise HTTPException(422, "URL/domínio inválido.") from exc
    if parsed.scheme not in {"http", "https"} or not host:
        raise HTTPException(422, "Usa um domínio ou um URL HTTP/HTTPS.")
    reasons: list[str] = []
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal")) or "." not in host:
            reasons.append("Destino local ou privado.")
        elif DOMAIN.fullmatch(host) is None:
            raise HTTPException(422, "Nome de domínio inválido.")
    else:
        if not address.is_global:
            reasons.append("Endereço IP privado, reservado ou local.")
        else:
            reasons.append("URL com endereço IP em vez de domínio.")
    if parsed.username is not None or parsed.password is not None:
        reasons.append("URL com credenciais incorporadas, possível disfarce do destino.")
    if parsed.scheme == "http":
        reasons.append("Ligação sem HTTPS.")
    if port is not None and port not in {80, 443}:
        reasons.append("Porta não habitual para navegação web.")
    if unquote(parsed.path).lower().endswith(EXECUTABLES):
        reasons.append("Download de ficheiro executável ou script.")
    return host, reasons


@router.post("/check-url")
async def check_url(payload: UrlCheckRequest):
    host, reasons = inspect_url(payload.url)
    domains = await feed.get()
    labels = host.split(".")
    if any(".".join(labels[index:]) in domains for index in range(len(labels) - 1)):
        reasons.insert(0, "Domínio ou domínio-pai presente na lista de ameaças (malware, phishing e outras ameaças).")
    return {
        "verdict": "blocked" if reasons else "not_listed",
        "host": host,
        "reasons": reasons,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "feed_updated_at": feed.updated_at,
        "source": "HaGeZi Threat Intelligence Feeds mini",
        "notice": "Não estar na lista não garante segurança. Não são analisados conteúdo, ficheiros ou redirecionamentos.",
    }
