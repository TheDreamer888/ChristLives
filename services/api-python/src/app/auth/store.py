"""Minimal persistence placeholder.

The project already depends on SQLAlchemy/asyncpg/redis (see pyproject.toml)
for real persistence; wiring actual tables/migrations is a separate task.
This module gives the auth routes a working, swappable storage interface
(`Store`) so the feature is fully functional end-to-end today, and can be
swapped for a Postgres/Redis-backed implementation without touching routes.py.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class UserRecord:
    id: str
    email: str | None = None
    name: str | None = None
    linked_methods: set[str] = field(default_factory=set)
    webauthn_credentials: dict[str, dict] = field(default_factory=dict)  # cred_id(b64) -> {public_key, sign_count, label}
    backup_code_hashes: list[str] = field(default_factory=list)
    consent: dict | None = None


class _TTLCache:
    def __init__(self, ttl_seconds: int = 300):
        self._ttl = ttl_seconds
        self._data: dict[str, tuple[float, object]] = {}

    def set(self, key: str, value: object) -> None:
        self._data[key] = (time.time() + self._ttl, value)

    def pop(self, key: str) -> object | None:
        item = self._data.pop(key, None)
        if not item:
            return None
        expires_at, value = item
        return value if expires_at >= time.time() else None


class Store:
    """Process-local store. Single-instance/dev only — replace with
    Postgres (users/credentials) + Redis (short-lived challenges) for
    multi-instance production deployments."""

    def __init__(self) -> None:
        self.users: dict[str, UserRecord] = {}
        self.email_index: dict[str, str] = {}
        self.oauth_index: dict[tuple[str, str], str] = {}  # (provider, subject) -> user id
        self.oauth_states = _TTLCache(ttl_seconds=600)
        self.webauthn_challenges = _TTLCache(ttl_seconds=300)

    def get_or_create_oauth_user(
        self,
        provider: str,
        subject: str,
        email: str | None,
        name: str | None,
        email_verified: bool,
    ) -> UserRecord:
        """Identifica o utilizador por (provedor, subject), nunca só pelo email.

        O email só liga a uma conta existente (ou a reivindica) quando o provedor
        o confirmou como verificado — evita tomada de conta por email falso.
        """
        import uuid

        known_id = self.oauth_index.get((provider, subject))
        if known_id and known_id in self.users:
            user = self.users[known_id]
            user.linked_methods.add(provider)
            return user

        user = None
        if email and email_verified and email in self.email_index:
            user = self.users[self.email_index[email]]
            user.linked_methods.add(provider)
        if user is None:
            user = UserRecord(
                id=str(uuid.uuid4()),
                email=email if email_verified else None,
                name=name,
                linked_methods={provider},
            )
            self.users[user.id] = user
            if email and email_verified:
                self.email_index[email] = user.id
        self.oauth_index[(provider, subject)] = user.id
        return user

    def get_or_create_user(self, email: str | None, name: str | None, method: str) -> UserRecord:
        if email and email in self.email_index:
            user = self.users[self.email_index[email]]
            user.linked_methods.add(method)
            return user
        import uuid

        user = UserRecord(id=str(uuid.uuid4()), email=email, name=name, linked_methods={method})
        self.users[user.id] = user
        if email:
            self.email_index[email] = user.id
        return user


store = Store()
