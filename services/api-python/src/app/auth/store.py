"""Persistência de contas e desafios de autenticação no PostgreSQL."""
from __future__ import annotations

import base64
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select

from src.app.database import session_factory
from src.app.models import (
    Agency,
    AgencyMember,
    AuthChallenge,
    ClientAccess,
    OAuthIdentity,
    User,
)


@dataclass
class UserRecord:
    id: str
    email: str | None = None
    email_verified: bool = False
    name: str | None = None
    linked_methods: set[str] = field(default_factory=set)
    webauthn_credentials: dict[str, dict[str, Any]] = field(default_factory=dict)
    backup_code_hashes: list[str] = field(default_factory=list)
    consent: dict | None = None


def _record(row: User) -> UserRecord:
    return UserRecord(
        id=row.id,
        email=row.email,
        email_verified=row.email_verified,
        name=row.name,
        linked_methods=set(row.linked_methods or []),
        webauthn_credentials=row.webauthn_credentials or {},
        backup_code_hashes=row.backup_code_hashes or [],
        consent=row.consent,
    )


class Store:
    async def get_user(self, user_id: str) -> UserRecord | None:
        async with session_factory()() as session:
            row = await session.get(User, user_id)
            return _record(row) if row else None

    async def get_user_by_email(self, email: str) -> UserRecord | None:
        normalized_email = email.strip().casefold()
        async with session_factory()() as session:
            row = await session.scalar(select(User).where(User.email == normalized_email))
            return _record(row) if row else None

    async def get_or_create_user(
        self,
        email: str | None,
        name: str | None,
        method: str,
        email_verified: bool = False,
    ) -> UserRecord:
        normalized_email = email.strip().casefold() if email else None
        if not normalized_email or not email_verified:
            raise ValueError("Não é possível criar uma conta com um email não verificado.")
        async with session_factory()() as session:
            async with session.begin():
                row = None
                if normalized_email:
                    row = await session.scalar(
                        select(User).where(User.email == normalized_email).with_for_update()
                    )
                if row is None:
                    row = User(
                        id=str(uuid.uuid4()),
                        email=normalized_email,
                        email_verified=email_verified,
                        name=name,
                        linked_methods=[method],
                        webauthn_credentials={},
                        backup_code_hashes=[],
                    )
                    session.add(row)
                    await session.flush()
                    agency = Agency(id=str(uuid.uuid4()), name=f"{(name or 'A minha').strip()[:90]} — Agência")
                    session.add(agency)
                    session.add(AgencyMember(agency_id=agency.id, user_id=row.id, role="owner"))
                else:
                    methods = set(row.linked_methods or [])
                    methods.add(method)
                    row.linked_methods = sorted(methods)
                    row.email_verified = True
                    if name and not row.name:
                        row.name = name
            return _record(row)

    async def get_or_create_oauth_user(
        self,
        provider: str,
        subject: str,
        email: str | None,
        name: str | None,
        email_verified: bool,
    ) -> UserRecord:
        if not provider or not subject.strip():
            raise ValueError("O provedor e o identificador OAuth são obrigatórios.")

        normalized_email = email.strip().casefold() if email and email_verified else None
        async with session_factory()() as session, session.begin():
            identity = await session.get(
                OAuthIdentity, (provider, subject), with_for_update=True
            )
            if identity:
                row = await session.get(User, identity.user_id, with_for_update=True)
                if row is None:
                    raise LookupError("A identidade OAuth aponta para uma conta inexistente.")
                if normalized_email and not row.email:
                    existing_user_id = await session.scalar(
                        select(User.id).where(
                            User.email == normalized_email,
                            User.id != row.id,
                        )
                    )
                    if existing_user_id is None:
                        row.email = normalized_email
                        row.email_verified = True
                methods = set(row.linked_methods or [])
                methods.add(provider)
                row.linked_methods = sorted(methods)
                if name and not row.name:
                    row.name = name
                return _record(row)

            row = None
            if normalized_email:
                row = await session.scalar(
                    select(User).where(User.email == normalized_email).with_for_update()
                )
            if row is None:
                row = User(
                    id=str(uuid.uuid4()),
                    email=normalized_email,
                    email_verified=bool(normalized_email),
                    name=name,
                    linked_methods=[provider],
                    webauthn_credentials={},
                    backup_code_hashes=[],
                )
                session.add(row)
                await session.flush()
                agency = Agency(
                    id=str(uuid.uuid4()),
                    name=f"{(name or 'A minha').strip()[:90]} — Agência",
                )
                session.add(agency)
                session.add(AgencyMember(agency_id=agency.id, user_id=row.id, role="owner"))
            else:
                methods = set(row.linked_methods or [])
                methods.add(provider)
                row.linked_methods = sorted(methods)
                if name and not row.name:
                    row.name = name

            session.add(
                OAuthIdentity(provider=provider, subject=subject, user_id=row.id)
            )
            await session.flush()
            return _record(row)

    async def save_user(self, record: UserRecord) -> None:
        async with session_factory()() as session:
            async with session.begin():
                row = await session.get(User, record.id, with_for_update=True)
                if row is None:
                    raise LookupError("A conta autenticada deixou de existir.")
                row.name = record.name
                row.email_verified = record.email_verified
                row.linked_methods = sorted(record.linked_methods)
                row.webauthn_credentials = record.webauthn_credentials
                row.backup_code_hashes = record.backup_code_hashes
                row.consent = record.consent

    async def set_challenge(
        self, challenge_id: str, user_id: str | None, challenge: bytes, ttl_seconds: int
    ) -> None:
        encoded = base64.urlsafe_b64encode(challenge).decode("ascii")
        async with session_factory()() as session:
            async with session.begin():
                await session.execute(
                    delete(AuthChallenge).where(AuthChallenge.expires_at <= datetime.now(UTC))
                )
                session.add(
                    AuthChallenge(
                        id=challenge_id,
                        user_id=user_id,
                        challenge=encoded,
                        expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
                    )
                )

    async def pop_challenge(self, challenge_id: str) -> tuple[str | None, bytes] | None:
        async with session_factory()() as session:
            async with session.begin():
                row = await session.scalar(
                    select(AuthChallenge).where(AuthChallenge.id == challenge_id).with_for_update()
                )
                if row is None:
                    return None
                await session.delete(row)
                if row.expires_at <= datetime.now(UTC):
                    return None
                challenge = base64.urlsafe_b64decode(row.challenge)
                return row.user_id, challenge

    async def accept_invitation(self, token_hash: str, email: str) -> bool:
        from src.app.models import AgencyInvitation, ClientWorkspace

        normalized_email = email.strip().casefold()
        async with session_factory()() as session:
            async with session.begin():
                invitation = await session.scalar(
                    select(AgencyInvitation)
                    .where(
                        AgencyInvitation.token_hash == token_hash,
                        AgencyInvitation.email == normalized_email,
                        AgencyInvitation.accepted_at.is_(None),
                        AgencyInvitation.expires_at > datetime.now(UTC),
                    )
                    .with_for_update()
                )
                if invitation is None:
                    return False
                user_id = await self._user_id(session, normalized_email)
                if user_id is None:
                    return False
                valid_clients = await session.scalar(
                    select(func.count())
                    .select_from(ClientWorkspace)
                    .where(
                        ClientWorkspace.id.in_(invitation.client_ids),
                        ClientWorkspace.agency_id == invitation.agency_id,
                    )
                ) if invitation.client_ids else 0
                if valid_clients != len(invitation.client_ids):
                    return False
                member = await session.get(AgencyMember, (invitation.agency_id, user_id))
                if member is None:
                    session.add(
                        AgencyMember(
                            agency_id=invitation.agency_id,
                            user_id=user_id,
                            role=invitation.agency_role,
                        )
                    )
                for client_id in invitation.client_ids:
                    if await session.get(ClientAccess, (client_id, user_id)) is None:
                        session.add(ClientAccess(client_id=client_id, user_id=user_id, role="analyst"))
                invitation.accepted_at = datetime.now(UTC)
                return True

    @staticmethod
    async def _user_id(session, email: str) -> str | None:
        return await session.scalar(select(User.id).where(User.email == email))


store = Store()
