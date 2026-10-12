"""Controlo distribuído de tentativas, sessões revogáveis e eventos de segurança."""
from __future__ import annotations

import hashlib
import hmac
import math
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import case, delete, select
from sqlalchemy.dialects.postgresql import insert

from src.app.auth.tokens import SESSION_TTL_SECONDS
from src.app.config import settings
from src.app.database import session_factory
from src.app.models import (
    AgencyMember,
    AuthSession,
    SecurityEvent,
    SecurityRateLimit,
    User,
)

SECURITY_EVENT_RETENTION_DAYS = 90
AUTH_RATE_LIMIT_WINDOW_SECONDS = 60


async def create_auth_session(user_id: str, session_id: str) -> None:
    now = datetime.now(UTC)
    async with session_factory()() as session, session.begin():
        await session.execute(
            delete(AuthSession).where(AuthSession.expires_at <= now)
        )
        session.add(
            AuthSession(
                id=session_id,
                user_id=user_id,
                expires_at=now + timedelta(seconds=SESSION_TTL_SECONDS),
            )
        )


async def is_auth_session_active(user_id: str, session_id: str) -> bool:
    now = datetime.now(UTC)
    async with session_factory() as session:
        return bool(
            await session.scalar(
                select(AuthSession.id).where(
                    AuthSession.id == session_id,
                    AuthSession.user_id == user_id,
                    AuthSession.revoked_at.is_(None),
                    AuthSession.expires_at > now,
                )
            )
        )


async def list_auth_sessions(user_id: str, current_session_id: str) -> list[dict[str, Any]]:
    now = datetime.now(UTC)
    async with session_factory() as session:
        rows = (
            await session.scalars(
                select(AuthSession)
                .where(
                    AuthSession.user_id == user_id,
                    AuthSession.revoked_at.is_(None),
                    AuthSession.expires_at > now,
                )
                .order_by(AuthSession.created_at.desc())
                .limit(20)
            )
        ).all()
    return [
        {
            "id": row.id,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "expires_at": row.expires_at.isoformat(),
            "is_current": row.id == current_session_id,
        }
        for row in rows
    ]


async def revoke_auth_session(user_id: str, session_id: str) -> bool:
    async with session_factory()() as session, session.begin():
        row = await session.scalar(
            select(AuthSession)
            .where(
                AuthSession.id == session_id,
                AuthSession.user_id == user_id,
                AuthSession.revoked_at.is_(None),
            )
            .with_for_update()
        )
        if row is None:
            return False
        row.revoked_at = datetime.now(UTC)
        return True


async def record_security_event(
    user_id: str,
    event_type: str,
    severity: str = "info",
    details: dict[str, str] | None = None,
) -> None:
    if severity not in {"info", "warning"}:
        raise ValueError("Severidade de evento de segurança inválida.")
    created_at = datetime.now(UTC)
    async with session_factory()() as session, session.begin():
        await session.execute(
            delete(SecurityEvent).where(
                SecurityEvent.created_at
                < created_at - timedelta(days=SECURITY_EVENT_RETENTION_DAYS)
            )
        )
        session.add(
            SecurityEvent(
                id=str(uuid.uuid4()),
                user_id=user_id,
                event_type=event_type,
                severity=severity,
                details=details or {},
            )
        )


async def list_security_events(user_id: str, limit: int = 50) -> list[dict[str, Any]]:
    async with session_factory()() as session:
        rows = (
            await session.scalars(
                select(SecurityEvent)
                .where(SecurityEvent.user_id == user_id)
                .order_by(SecurityEvent.created_at.desc())
                .limit(limit)
            )
        ).all()
    return [
        {
            "id": row.id,
            "event_type": row.event_type,
            "severity": row.severity,
            "details": row.details,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
        for row in rows
    ]


async def list_agency_security_events(agency_id: str, limit: int = 100) -> list[dict[str, Any]]:
    async with session_factory()() as session:
        rows = (
            await session.execute(
                select(SecurityEvent, User.name)
                .join(User, User.id == SecurityEvent.user_id)
                .join(AgencyMember, AgencyMember.user_id == SecurityEvent.user_id)
                .where(AgencyMember.agency_id == agency_id)
                .order_by(SecurityEvent.created_at.desc())
                .limit(limit)
            )
        ).all()
    return [
        {
            "id": event.id,
            "event_type": event.event_type,
            "severity": event.severity,
            "details": event.details,
            "created_at": event.created_at.isoformat() if event.created_at else None,
            "actor_name": actor_name,
        }
        for event, actor_name in rows
    ]


async def consume_auth_rate_limit(client_ip: str | None) -> int | None:
    now = datetime.now(UTC)
    window_start = now - timedelta(seconds=AUTH_RATE_LIMIT_WINDOW_SECONDS)
    source = client_ip or "unknown"
    bucket_key = hmac.new(
        settings.secret_key.encode(),
        f"auth:{source}".encode(),
        hashlib.sha256,
    ).hexdigest()
    expired = SecurityRateLimit.window_started_at <= window_start
    statement = (
        insert(SecurityRateLimit)
        .values(
            bucket_key=bucket_key,
            window_started_at=now,
            request_count=1,
        )
        .on_conflict_do_update(
            index_elements=[SecurityRateLimit.bucket_key],
            set_={
                "window_started_at": case(
                    (expired, now),
                    else_=SecurityRateLimit.window_started_at,
                ),
                "request_count": case(
                    (expired, 1),
                    else_=SecurityRateLimit.request_count + 1,
                ),
            },
        )
        .returning(SecurityRateLimit.request_count, SecurityRateLimit.window_started_at)
    )
    async with session_factory()() as session, session.begin():
        await session.execute(
            delete(SecurityRateLimit).where(
                SecurityRateLimit.window_started_at < now - timedelta(days=1)
            )
        )
        row = (await session.execute(statement)).one()
    count, started_at = row
    if count <= settings.auth_requests_per_minute:
        return None
    retry_after = (started_at + timedelta(seconds=AUTH_RATE_LIMIT_WINDOW_SECONDS) - now).total_seconds()
    return max(1, math.ceil(retry_after))
