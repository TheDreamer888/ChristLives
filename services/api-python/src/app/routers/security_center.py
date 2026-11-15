"""Centro de segurança: estado do firewall, eventos, blocklist e triagem por IA.

- `GET /api/security/status` é público e só devolve contagens (sem IPs).
- O resto exige sessão de um utilizador com email verificado listado em
  SECURITY_ADMIN_EMAILS. As recomendações da IA nunca são aplicadas automaticamente.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from src.app.auth.routes import _current_user
from src.app.config import settings
from src.app.firewall import firewall
from src.app.supervisor import supervisor_configured, triage

router = APIRouter(prefix="/api/security", tags=["security"])


def _admin_emails() -> set[str]:
    return {e.strip().casefold() for e in settings.security_admin_emails.split(",") if e.strip()}


async def require_security_admin(request: Request) -> Any:
    user = await _current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Inicia sessão para aceder ao centro de segurança.")
    email = (user.email or "").casefold()
    if not user.email_verified or not email or email not in _admin_emails():
        raise HTTPException(status_code=403, detail="Só administradores de segurança podem ver estes dados.")
    return user


class BlockRequest(BaseModel):
    network: str = Field(min_length=2, max_length=64)
    reason: str = Field(min_length=3, max_length=200)
    minutes: int | None = Field(default=1440, ge=1, le=525_600)


@router.get("/status")
async def status() -> dict[str, Any]:
    summary = firewall.summary()
    return {
        "firewall": {
            "enabled": summary["enabled"],
            "blocked_24h": summary["blocked_24h"],
            "by_rule": summary["by_rule"],
            "rules": summary["rules"],
            "limits": summary["limits"],
            "active_blocks": summary["active_blocks"],
            "threat_intel": summary["threat_intel"],
        },
        "supervisor": {"enabled": supervisor_configured(), "model": settings.supervisor_model if supervisor_configured() else None},
        "admin_configured": bool(_admin_emails()),
    }


@router.get("/me")
async def me(request: Request) -> dict[str, bool]:
    user = await _current_user(request)
    email = (user.email or "").casefold() if user else ""
    return {"is_admin": bool(user and user.email_verified and email in _admin_emails())}


@router.get("/firewall/events")
async def events(request: Request, limit: int = 200) -> dict[str, Any]:
    await require_security_admin(request)
    return {"events": firewall.recent_events(max(1, min(limit, 1000))), "summary": firewall.summary()}


@router.get("/firewall/blocks")
async def list_blocks(request: Request) -> dict[str, Any]:
    await require_security_admin(request)
    return {"blocks": [b.public() for b in firewall.active_blocks()]}


@router.post("/firewall/blocks", status_code=201)
async def add_block(body: BlockRequest, request: Request) -> dict[str, Any]:
    user = await require_security_admin(request)
    try:
        block = firewall.add_block(body.network, f"{body.reason} (por {user.email})", body.minutes)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Rede inválida ou protegida: {exc}") from exc
    return block.public()


@router.delete("/firewall/blocks")
async def remove_block(network: str, request: Request) -> dict[str, bool]:
    await require_security_admin(request)
    try:
        removed = firewall.remove_block(network)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Rede inválida.") from exc
    return {"removed": removed}


@router.post("/firewall/refresh-feeds")
async def refresh_feeds(request: Request) -> dict[str, Any]:
    await require_security_admin(request)
    await firewall.refresh_feeds()
    return firewall.summary()["threat_intel"]


@router.post("/supervisor/triage")
async def supervisor_triage(request: Request) -> dict[str, Any]:
    await require_security_admin(request)
    if not supervisor_configured():
        raise HTTPException(status_code=503, detail="A IA supervisora precisa de ANTHROPIC_API_KEY no servidor.")
    events_ = firewall.recent_events(300)
    if not events_:
        return {"severity": "baixa", "summary": "Sem bloqueios nas últimas 24 horas.", "findings": [],
                "block_recommendations": [], "events_analyzed": 0, "model": settings.supervisor_model}
    try:
        return await triage(firewall.summary(), events_)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="A IA supervisora não conseguiu concluir a análise.") from exc
