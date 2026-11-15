"""Gestão isolada de agências, workspaces de clientes e subscrições."""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from src.app.auth.routes import _current_user
from src.app.auth.store import UserRecord, store
from src.app.config import settings
from src.app.database import session_factory
from src.app.models import (
    Agency,
    AgencyInvitation,
    AgencyMember,
    ClientAccess,
    ClientWorkspace,
    StripeWebhookEvent,
    User,
)
from src.app.security import list_agency_security_events

router = APIRouter(prefix="/api/agency", tags=["agency"])

PLANS = {
    "starter": {"name": "Starter", "max_clients": 5, "price_setting": "stripe_price_starter"},
    "growth": {"name": "Growth", "max_clients": 25, "price_setting": "stripe_price_growth"},
    "scale": {"name": "Scale", "max_clients": 100, "price_setting": "stripe_price_scale"},
}
ACTIVE_SUBSCRIPTION_STATUSES = {"active", "trialing"}
STRIPE_API = "https://api.stripe.com/v1"


class ClientWorkspaceInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=2, max_length=120)


class InvitationInput(BaseModel):
    email: EmailStr
    role: Literal["admin", "member"]
    client_ids: list[str] = Field(default_factory=list, max_length=100)


class InvitationAcceptInput(BaseModel):
    token: str = Field(min_length=32, max_length=128)


class CheckoutInput(BaseModel):
    plan_id: Literal["starter", "growth", "scale"]


async def _current_agency(
    user: UserRecord, agency_id: str | None
) -> tuple[Agency, str]:
    async with session_factory()() as session:
        query = (
            select(Agency, AgencyMember.role)
            .join(AgencyMember, AgencyMember.agency_id == Agency.id)
            .where(AgencyMember.user_id == user.id)
        )
        if agency_id:
            query = query.where(Agency.id == agency_id)
        result = (await session.execute(query.order_by(Agency.created_at))).first()
    if not result:
        raise HTTPException(status_code=404, detail="Agência não encontrada ou sem acesso.")
    return result[0], result[1]


async def _require_user(request: Request) -> UserRecord:
    user = await _current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Inicia sessão para continuar.")
    if not user.email or not user.email_verified:
        raise HTTPException(status_code=403, detail="A conta precisa de um endereço de e-mail verificado.")
    return user


def _require_manager(role: str) -> None:
    if role not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="Só proprietários e administradores podem gerir a agência.")


def _require_stripe() -> str:
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="A faturação ainda não está configurada.")
    return settings.stripe_secret_key


def _stripe_price_id(plan_id: str) -> str:
    value = getattr(settings, PLANS[plan_id]["price_setting"])
    if not value:
        raise HTTPException(status_code=503, detail=f"O preço Stripe do plano {plan_id} não está configurado.")
    return value


async def _stripe_post(path: str, data: dict[str, str]) -> dict[str, Any]:
    key = _require_stripe()
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                f"{STRIPE_API}{path}",
                data=data,
                headers={"Authorization": f"Bearer {key}"},
            )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Não foi possível concluir o pedido ao Stripe.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="Resposta inválida do Stripe.")
    return payload


@router.get("")
async def agency_summary(
    request: Request, x_agency_id: str | None = Header(default=None)
) -> dict[str, Any]:
    user = await _require_user(request)
    agency, role = await _current_agency(user, x_agency_id)
    plan = PLANS.get(agency.plan_id or "")
    async with session_factory()() as session:
        client_count = await session.scalar(
            select(func.count()).select_from(ClientWorkspace).where(ClientWorkspace.agency_id == agency.id)
        )
    return {
        "id": agency.id,
        "name": agency.name,
        "role": role,
        "plan_id": agency.plan_id,
        "plan_name": plan["name"] if plan else None,
        "max_clients": plan["max_clients"] if plan else 0,
        "subscription_status": agency.subscription_status,
        "clients_used": client_count or 0,
        "has_billing_customer": bool(agency.stripe_customer_id),
        "has_subscription": bool(agency.stripe_subscription_id),
    }


@router.get("/agencies")
async def list_agencies(request: Request) -> dict[str, Any]:
    user = await _require_user(request)
    async with session_factory()() as session:
        rows = (
            await session.execute(
                select(Agency.id, Agency.name, AgencyMember.role)
                .join(AgencyMember, AgencyMember.agency_id == Agency.id)
                .where(AgencyMember.user_id == user.id)
                .order_by(Agency.created_at)
            )
        ).all()
    return {
        "agencies": [
            {"id": agency_id, "name": name, "role": role}
            for agency_id, name, role in rows
        ]
    }


@router.get("/plans")
async def list_plans() -> dict[str, Any]:
    return {
        "plans": [
            {
                "id": plan_id,
                "name": plan["name"],
                "max_clients": plan["max_clients"],
                "available": bool(settings.stripe_secret_key and getattr(settings, plan["price_setting"])),
            }
            for plan_id, plan in PLANS.items()
        ]
    }


@router.get("/clients")
async def list_clients(
    request: Request, x_agency_id: str | None = Header(default=None)
) -> dict[str, Any]:
    user = await _require_user(request)
    agency, role = await _current_agency(user, x_agency_id)
    async with session_factory()() as session:
        query = select(ClientWorkspace).where(ClientWorkspace.agency_id == agency.id)
        if role == "member":
            query = query.join(ClientAccess, ClientAccess.client_id == ClientWorkspace.id).where(
                ClientAccess.user_id == user.id
            )
        clients = (await session.scalars(query.order_by(ClientWorkspace.name))).all()
    return {
        "clients": [
            {"id": client.id, "name": client.name, "created_at": client.created_at}
            for client in clients
        ]
    }


@router.post("/clients", status_code=201)
async def create_client(
    body: ClientWorkspaceInput,
    request: Request,
    x_agency_id: str | None = Header(default=None),
) -> dict[str, Any]:
    user = await _require_user(request)
    agency, role = await _current_agency(user, x_agency_id)
    _require_manager(role)
    async with session_factory()() as session:
        async with session.begin():
            locked_agency = await session.scalar(
                select(Agency).where(Agency.id == agency.id).with_for_update()
            )
            if locked_agency is None:
                raise HTTPException(status_code=404, detail="Agência não encontrada.")
            plan = PLANS.get(locked_agency.plan_id or "")
            if locked_agency.subscription_status not in ACTIVE_SUBSCRIPTION_STATUSES or not plan:
                raise HTTPException(status_code=402, detail="Ativa uma subscrição para adicionar clientes.")
            count = await session.scalar(
                select(func.count())
                .select_from(ClientWorkspace)
                .where(ClientWorkspace.agency_id == locked_agency.id)
            )
            if (count or 0) >= plan["max_clients"]:
                raise HTTPException(status_code=409, detail="O limite de clientes do plano foi atingido.")
            client = ClientWorkspace(
                id=str(uuid.uuid4()), agency_id=locked_agency.id, name=body.name.strip()
            )
            session.add(client)
            await session.flush()
    return {"client": {"id": client.id, "name": client.name, "created_at": client.created_at}}


@router.patch("/clients/{client_id}")
async def rename_client(
    client_id: str,
    body: ClientWorkspaceInput,
    request: Request,
    x_agency_id: str | None = Header(default=None),
) -> dict[str, Any]:
    user = await _require_user(request)
    agency, role = await _current_agency(user, x_agency_id)
    _require_manager(role)
    async with session_factory()() as session:
        async with session.begin():
            client = await session.scalar(
                select(ClientWorkspace)
                .where(ClientWorkspace.id == client_id, ClientWorkspace.agency_id == agency.id)
                .with_for_update()
            )
            if client is None:
                raise HTTPException(status_code=404, detail="Cliente não encontrado.")
            client.name = body.name.strip()
    return {"client": {"id": client.id, "name": client.name, "created_at": client.created_at}}


@router.delete("/clients/{client_id}", status_code=204)
async def delete_client(
    client_id: str,
    request: Request,
    x_agency_id: str | None = Header(default=None),
) -> None:
    user = await _require_user(request)
    agency, role = await _current_agency(user, x_agency_id)
    _require_manager(role)
    async with session_factory()() as session:
        async with session.begin():
            client = await session.scalar(
                select(ClientWorkspace)
                .where(ClientWorkspace.id == client_id, ClientWorkspace.agency_id == agency.id)
                .with_for_update()
            )
            if client is None:
                raise HTTPException(status_code=404, detail="Cliente não encontrado.")
            await session.delete(client)


@router.get("/members")
async def list_members(
    request: Request, x_agency_id: str | None = Header(default=None)
) -> dict[str, Any]:
    user = await _require_user(request)
    agency, role = await _current_agency(user, x_agency_id)
    _require_manager(role)
    async with session_factory()() as session:
        rows = (
            await session.execute(
                select(User.id, User.email, User.name, AgencyMember.role)
                .join(AgencyMember, AgencyMember.user_id == User.id)
                .where(AgencyMember.agency_id == agency.id)
                .order_by(User.email)
            )
        ).all()
        access_rows = (
            await session.execute(
                select(ClientAccess.user_id, ClientAccess.client_id)
                .join(ClientWorkspace, ClientWorkspace.id == ClientAccess.client_id)
                .where(ClientWorkspace.agency_id == agency.id)
            )
        ).all()
    clients_by_user: dict[str, list[str]] = {}
    for member_id, client_id in access_rows:
        clients_by_user.setdefault(member_id, []).append(client_id)
    return {
        "members": [
            {
                "id": member_id,
                "email": email,
                "name": name,
                "role": member_role,
                "client_ids": clients_by_user.get(member_id, []),
            }
            for member_id, email, name, member_role in rows
        ]
    }


@router.get("/security/events")
async def list_team_security_events(
    request: Request, x_agency_id: str | None = Header(default=None)
) -> dict[str, Any]:
    user = await _require_user(request)
    agency, role = await _current_agency(user, x_agency_id)
    _require_manager(role)
    return {"events": await list_agency_security_events(agency.id)}


@router.post("/invitations", status_code=201)
async def create_invitation(
    body: InvitationInput,
    request: Request,
    x_agency_id: str | None = Header(default=None),
) -> dict[str, str]:
    user = await _require_user(request)
    agency, role = await _current_agency(user, x_agency_id)
    _require_manager(role)
    if body.role == "admin" and role != "owner":
        raise HTTPException(status_code=403, detail="Só o proprietário pode convidar administradores.")
    email = str(body.email).strip().casefold()
    client_ids = list(dict.fromkeys(body.client_ids))
    if body.role == "admin" and client_ids:
        raise HTTPException(status_code=422, detail="Administradores têm acesso a todos os clientes.")
    if body.role == "member" and not client_ids:
        raise HTTPException(status_code=422, detail="Indica pelo menos um cliente para este membro.")
    raw_token = secrets.token_urlsafe(32)
    async with session_factory()() as session:
        async with session.begin():
            if client_ids:
                valid_count = await session.scalar(
                    select(func.count()).select_from(ClientWorkspace).where(
                        ClientWorkspace.agency_id == agency.id,
                        ClientWorkspace.id.in_(client_ids),
                    )
                )
                if valid_count != len(client_ids):
                    raise HTTPException(status_code=404, detail="Um ou mais clientes não pertencem a esta agência.")
            session.add(
                AgencyInvitation(
                    id=str(uuid.uuid4()),
                    agency_id=agency.id,
                    email=email,
                    agency_role=body.role,
                    client_ids=client_ids,
                    token_hash=hashlib.sha256(raw_token.encode()).hexdigest(),
                    expires_at=datetime.now(UTC) + timedelta(days=7),
                )
            )
    invite_url = f"{settings.public_frontend_url.rstrip('/')}/#/invite/{raw_token}"
    return {"invite_url": invite_url, "expires_in_days": 7}


@router.post("/invitations/accept")
async def accept_invitation(
    body: InvitationAcceptInput, request: Request
) -> dict[str, bool]:
    user = await _require_user(request)
    token_hash = hashlib.sha256(body.token.encode()).hexdigest()
    try:
        accepted = await store.accept_invitation(token_hash, user.email or "")
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="O convite já foi utilizado.") from exc
    if not accepted:
        raise HTTPException(status_code=404, detail="Convite inválido, expirado ou destinado a outro e-mail.")
    return {"accepted": True}


@router.post("/checkout")
async def create_checkout(
    body: CheckoutInput,
    request: Request,
    x_agency_id: str | None = Header(default=None),
) -> dict[str, str]:
    user = await _require_user(request)
    agency, role = await _current_agency(user, x_agency_id)
    _require_manager(role)
    if agency.stripe_subscription_id:
        raise HTTPException(
            status_code=409,
            detail="Esta agência já tem uma subscrição. Gere alterações no portal de faturação.",
        )
    price_id = _stripe_price_id(body.plan_id)
    data = {
        "mode": "subscription",
        "line_items[0][price]": price_id,
        "line_items[0][quantity]": "1",
        "success_url": f"{settings.public_frontend_url.rstrip('/')}/#/billing?checkout=success",
        "cancel_url": f"{settings.public_frontend_url.rstrip('/')}/#/billing?checkout=cancelled",
        "client_reference_id": agency.id,
        "metadata[agency_id]": agency.id,
        "metadata[plan_id]": body.plan_id,
        "subscription_data[metadata][agency_id]": agency.id,
        "subscription_data[metadata][plan_id]": body.plan_id,
    }
    if agency.stripe_customer_id:
        data["customer"] = agency.stripe_customer_id
    else:
        data["customer_email"] = user.email or ""
    result = await _stripe_post("/checkout/sessions", data)
    if not isinstance(result.get("url"), str):
        raise HTTPException(status_code=502, detail="O Stripe não devolveu um URL de checkout.")
    return {"url": result["url"]}


@router.post("/billing-portal")
async def create_billing_portal(
    request: Request,
    x_agency_id: str | None = Header(default=None),
) -> dict[str, str]:
    user = await _require_user(request)
    agency, role = await _current_agency(user, x_agency_id)
    _require_manager(role)
    if not agency.stripe_customer_id:
        raise HTTPException(status_code=409, detail="Ainda não existe um cliente Stripe para esta agência.")
    result = await _stripe_post(
        "/billing_portal/sessions",
        {
            "customer": agency.stripe_customer_id,
            "return_url": f"{settings.public_frontend_url.rstrip('/')}/#/billing",
        },
    )
    if not isinstance(result.get("url"), str):
        raise HTTPException(status_code=502, detail="O Stripe não devolveu um URL do portal.")
    return {"url": result["url"]}


def _verify_stripe_signature(payload: bytes, signature_header: str | None) -> bool:
    secret = settings.stripe_webhook_secret
    if not secret or not signature_header:
        return False
    parts: dict[str, list[str]] = {}
    for item in signature_header.split(","):
        key, separator, value = item.partition("=")
        if separator:
            parts.setdefault(key, []).append(value)
    timestamp = (parts.get("t") or [""])[0]
    try:
        signed_at = int(timestamp)
    except ValueError:
        return False
    if abs(time.time() - signed_at) > 300:
        return False
    signed_payload = timestamp.encode() + b"." + payload
    expected = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, candidate) for candidate in parts.get("v1", []))


def _extract_id(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and isinstance(value.get("id"), str):
        return value["id"]
    return None


def _plan_for_price(price_id: str | None) -> str | None:
    if not price_id:
        return None
    for plan_id, plan in PLANS.items():
        if getattr(settings, plan["price_setting"]) == price_id:
            return plan_id
    return None


@router.post("/stripe/webhook", include_in_schema=False)
async def stripe_webhook(
    request: Request, stripe_signature: str | None = Header(default=None)
) -> dict[str, bool]:
    payload = await request.body()
    if not _verify_stripe_signature(payload, stripe_signature):
        raise HTTPException(status_code=400, detail="Assinatura Stripe inválida.")
    try:
        event = json.loads(payload)
        event_id = event["id"]
        event_type = event["type"]
        obj = event["data"]["object"]
        if not all(isinstance(value, str) for value in (event_id, event_type)):
            raise ValueError("Invalid event identifiers")
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Evento Stripe inválido.") from exc

    async with session_factory()() as session:
        async with session.begin():
            if await session.get(StripeWebhookEvent, event_id):
                return {"received": True}

            agency = None
            plan_id = None
            subscription_id = None
            customer_id = _extract_id(obj.get("customer"))
            status = None
            if event_type == "checkout.session.completed":
                metadata = obj.get("metadata") or {}
                agency_id = metadata.get("agency_id") or obj.get("client_reference_id")
                agency = await session.get(Agency, agency_id) if isinstance(agency_id, str) else None
                plan_id = metadata.get("plan_id")
                subscription_id = _extract_id(obj.get("subscription"))
                status = "active" if obj.get("payment_status") in {"paid", "no_payment_required"} else "incomplete"
            elif event_type.startswith("customer.subscription."):
                subscription_id = _extract_id(obj)
                metadata = obj.get("metadata") or {}
                agency_id = metadata.get("agency_id")
                if isinstance(agency_id, str):
                    agency = await session.get(Agency, agency_id)
                if agency is None and subscription_id:
                    agency = await session.scalar(
                        select(Agency).where(Agency.stripe_subscription_id == subscription_id)
                    )
                if agency is None and customer_id:
                    agency = await session.scalar(
                        select(Agency).where(Agency.stripe_customer_id == customer_id)
                    )
                items = (obj.get("items") or {}).get("data") or []
                price = items[0].get("price") if items and isinstance(items[0], dict) else None
                plan_id = _plan_for_price(_extract_id(price))
                status = obj.get("status") if isinstance(obj.get("status"), str) else "inactive"
                if event_type == "customer.subscription.deleted":
                    status = "canceled"
            if agency is not None:
                if customer_id:
                    agency.stripe_customer_id = customer_id
                if subscription_id:
                    agency.stripe_subscription_id = subscription_id
                if plan_id in PLANS:
                    agency.plan_id = plan_id
                if status:
                    agency.subscription_status = status
                if status in {"canceled", "unpaid", "incomplete_expired"}:
                    agency.plan_id = None
                    agency.stripe_subscription_id = None
            session.add(StripeWebhookEvent(id=event_id, event_type=event_type))
            try:
                await session.flush()
            except IntegrityError:
                raise HTTPException(status_code=409, detail="Evento Stripe duplicado.") from None
    return {"received": True}
