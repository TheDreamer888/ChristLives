"""Rotas para gestão de registos DNS através da API da Cloudflare.

Requer as variáveis de ambiente CLOUDFLARE_API_TOKEN e CLOUDFLARE_ZONE_ID
(ver .env.example). O token deve ter a permissão "Zone.DNS:Edit" apenas
para a zona necessária (princípio do menor privilégio).

Segurança: estas rotas controlam o domínio (site e email). Só um proprietário
com sessão iniciada por passkey lhes acede (permissão dns.manage); alterações
exigem login recente e ficam na auditoria com o motivo. O `record_id` é
validado para não permitir chamar outros endpoints da Cloudflare com o token.
"""
from __future__ import annotations

from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from src.app.admin import rbac
from src.app.admin.routes import AdminContext, require, require_write
from src.app.config import settings
from src.pylibrary.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/dns", tags=["dns"], dependencies=[Depends(require(rbac.DNS_MANAGE))])

# Os ids de registos da Cloudflare são 32 caracteres hexadecimais.
RecordId = Path(pattern=r"^[a-f0-9]{32}$", description="Id do registo na Cloudflare")

CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"


class DNSRecordIn(BaseModel):
    reason: str = Field(min_length=10, max_length=500, exclude=True, description="Justificação (auditoria)")
    type: Literal["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV"]
    name: str = Field(..., description="Nome do registo, ex: www.exemplo.com")
    content: str = Field(..., description="Valor do registo, ex: 1.2.3.4")
    ttl: int = Field(default=1, ge=1, description="TTL em segundos (1 = automático)")
    proxied: bool = Field(default=False, description="Ativar o proxy/CDN da Cloudflare")


class DNSRecordUpdate(BaseModel):
    reason: str = Field(min_length=10, max_length=500, exclude=True, description="Justificação (auditoria)")
    type: Literal["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV"] | None = None
    name: str | None = None
    content: str | None = None
    ttl: int | None = Field(default=None, ge=1)
    proxied: bool | None = None


def _require_config() -> tuple[str, str]:
    if not settings.cloudflare_api_token or not settings.cloudflare_zone_id:
        raise HTTPException(
            status_code=503,
            detail=(
                "Cloudflare não configurado — defina CLOUDFLARE_API_TOKEN e "
                "CLOUDFLARE_ZONE_ID nas variáveis de ambiente."
            ),
        )
    return settings.cloudflare_api_token, settings.cloudflare_zone_id


def _client(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=CLOUDFLARE_API_BASE,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=10.0,
    )


async def _raise_on_cf_error(resp: httpx.Response) -> dict[str, Any]:
    data = resp.json()
    if resp.status_code >= 400 or not data.get("success", False):
        errors = data.get("errors") or [{"message": resp.text}]
        logger.warning("Erro na API da Cloudflare: %s", errors)
        raise HTTPException(status_code=resp.status_code or 502, detail=errors)
    return data


@router.get("/records")
async def list_records(name: str | None = None, type: str | None = None) -> dict[str, Any]:
    """Lista os registos DNS da zona configurada, com filtros opcionais."""
    token, zone_id = _require_config()
    params = {k: v for k, v in {"name": name, "type": type}.items() if v}
    async with _client(token) as client:
        resp = await client.get(f"/zones/{zone_id}/dns_records", params=params)
        data = await _raise_on_cf_error(resp)
    return {"records": data.get("result", [])}


@router.post("/records", status_code=201)
async def create_record(record: DNSRecordIn, ctx: AdminContext = Depends(require_write(rbac.DNS_MANAGE))) -> dict[str, Any]:
    """Cria um novo registo DNS na zona configurada."""
    token, zone_id = _require_config()
    async with _client(token) as client:
        resp = await client.post(f"/zones/{zone_id}/dns_records", json=record.model_dump())
        data = await _raise_on_cf_error(resp)
    logger.info("Registo DNS criado: %s %s -> %s", record.type, record.name, record.content)
    ctx.audit("dns.create", target=record.name, reason=record.reason, details={"type": record.type, "content": record.content})
    return {"record": data.get("result")}


@router.patch("/records/{record_id}")
async def update_record(
    record: DNSRecordUpdate,
    record_id: str = RecordId,
    ctx: AdminContext = Depends(require_write(rbac.DNS_MANAGE)),
) -> dict[str, Any]:
    """Atualiza parcialmente um registo DNS existente."""
    token, zone_id = _require_config()
    payload = record.model_dump(exclude_none=True)
    if not payload:
        raise HTTPException(status_code=400, detail="Nenhum campo para atualizar.")
    async with _client(token) as client:
        resp = await client.patch(f"/zones/{zone_id}/dns_records/{record_id}", json=payload)
        data = await _raise_on_cf_error(resp)
    logger.info("Registo DNS %s atualizado", record_id)
    ctx.audit("dns.update", target=record_id, reason=record.reason, details=payload)
    return {"record": data.get("result")}


@router.post("/records/{record_id}/delete")
async def delete_record(
    body: DeleteBody,
    record_id: str = RecordId,
    ctx: AdminContext = Depends(require_write(rbac.DNS_MANAGE)),
) -> dict[str, Any]:
    """Remove um registo DNS."""
    token, zone_id = _require_config()
    async with _client(token) as client:
        resp = await client.delete(f"/zones/{zone_id}/dns_records/{record_id}")
        data = await _raise_on_cf_error(resp)
    logger.info("Registo DNS %s removido", record_id)
    ctx.audit("dns.delete", target=record_id, reason=body.reason)
    return {"deleted": data.get("result")}


class DeleteBody(BaseModel):
    reason: str = Field(min_length=10, max_length=500)
