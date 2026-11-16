"""Persistência dos utilizadores e dos desafios de autenticação.

Dois motores com a mesma interface, escolhidos por `DATABASE_URL`:

* sem `DATABASE_URL` → `MemoryStore` (desenvolvimento e testes; perde tudo ao
  reiniciar e só serve uma instância);
* com `DATABASE_URL` → `SqlStore` (Postgres em produção, SQLite local). Os dados
  sobrevivem a reinícios e várias instâncias da API partilham o mesmo estado.

Regra de utilização: ler com `get_user`/`find_by_email`/`all_users`, alterar o
`UserRecord` e chamar `save(user)`. O `save` usa concorrência otimista
(coluna `version`): se outra instância alterou a conta entretanto, levanta
`ConcurrentUpdate` em vez de sobrescrever — é isto que torna atómico, por
exemplo, o consumo de um código de recuperação.
"""
from __future__ import annotations

import base64
import json
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

from src.app import db


class ConcurrentUpdate(Exception):
    """A conta foi alterada por outro pedido entre a leitura e a escrita."""


@dataclass
class UserRecord:
    id: str
    email: str | None = None
    name: str | None = None
    linked_methods: set[str] = field(default_factory=set)
    webauthn_credentials: dict[str, dict] = field(default_factory=dict)  # cred_id(b64) -> {public_key, sign_count, label}
    backup_code_hashes: list[str] = field(default_factory=list)
    consent: dict | None = None
    # Administração (RBAC). Nunca vem do cliente: só o módulo admin altera isto.
    roles: set[str] = field(default_factory=set)
    suspended: bool = False
    sessions_valid_after: float = 0.0  # tokens com iat anterior deixam de valer
    created_at: float = field(default_factory=time.time)
    last_login_at: float | None = None
    version: int = 0  # concorrência otimista; 0 = ainda não guardado


# ---- Serialização (JSON, sem pickle) -------------------------------------------

def _user_to_json(user: UserRecord) -> str:
    data = asdict(user)
    data.pop("version")
    data["linked_methods"] = sorted(user.linked_methods)
    data["roles"] = sorted(user.roles)
    data["webauthn_credentials"] = {
        cid: {**cred, "public_key": base64.b64encode(cred["public_key"]).decode()}
        for cid, cred in user.webauthn_credentials.items()
    }
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


def _user_from_json(raw: str, version: int) -> UserRecord:
    data = json.loads(raw)
    data["linked_methods"] = set(data.get("linked_methods", []))
    data["roles"] = set(data.get("roles", []))
    data["webauthn_credentials"] = {
        cid: {**cred, "public_key": base64.b64decode(cred["public_key"])}
        for cid, cred in data.get("webauthn_credentials", {}).items()
    }
    known = UserRecord.__dataclass_fields__
    return UserRecord(**{k: v for k, v in data.items() if k in known}, version=version)


def _challenge_to_json(value: tuple[str | None, bytes]) -> str:
    user_id, challenge = value
    return json.dumps({"u": user_id, "c": base64.b64encode(challenge).decode()})


def _challenge_from_json(raw: str) -> tuple[str | None, bytes]:
    data = json.loads(raw)
    return data["u"], base64.b64decode(data["c"])


# ---- Desafios de curta duração (uso único) ----------------------------------------

class _TTLCache:
    def __init__(self, ttl_seconds: int = 300):
        self._ttl = ttl_seconds
        self._data: dict[str, tuple[float, object]] = {}
        self._lock = threading.Lock()

    def set(self, key: str, value: object) -> None:
        with self._lock:
            now = time.time()
            self._data = {k: v for k, v in self._data.items() if v[0] >= now}  # limpa expirados
            self._data[key] = (now + self._ttl, value)

    def pop(self, key: str) -> Any:
        with self._lock:
            item = self._data.pop(key, None)
        if not item:
            return None
        expires_at, value = item
        return value if expires_at >= time.time() else None

    def clear(self) -> None:
        self._data.clear()


class _SqlChallenges:
    """Desafios WebAuthn numa tabela: qualquer instância pode validar a resposta."""

    def __init__(self, engine, kind: str, ttl_seconds: int) -> None:
        self._engine = engine
        self._kind = kind
        self._ttl = ttl_seconds

    def set(self, key: str, value: tuple[str | None, bytes]) -> None:
        t = db.ephemeral
        now = time.time()
        with self._engine.begin() as conn:
            conn.execute(t.delete().where(t.c.expires_at < now))
            conn.execute(
                t.insert().values(key=f"{self._kind}:{key}", value=_challenge_to_json(value), expires_at=now + self._ttl)
            )

    def pop(self, key: str) -> tuple[str | None, bytes] | None:
        t = db.ephemeral
        full = f"{self._kind}:{key}"
        with self._engine.begin() as conn:
            row = conn.execute(db.select(t.c.value, t.c.expires_at).where(t.c.key == full)).first()
            if row is None:
                return None
            # Só quem consegue apagar a linha fica com o desafio: uso único entre instâncias.
            if conn.execute(t.delete().where(t.c.key == full)).rowcount != 1:
                return None
        return _challenge_from_json(row.value) if row.expires_at >= time.time() else None

    def clear(self) -> None:
        with self._engine.begin() as conn:
            conn.execute(db.ephemeral.delete().where(db.ephemeral.c.key.like(f"{self._kind}:%")))


# ---- Motores ------------------------------------------------------------------------

class MemoryStore:
    """Processo único, sem persistência. Para desenvolvimento e testes."""

    persistent = False

    def __init__(self) -> None:
        self._users: dict[str, UserRecord] = {}
        self._email_index: dict[str, str] = {}
        self._oauth_index: dict[tuple[str, str], str] = {}  # (provider, subject) -> user id
        self._lock = threading.RLock()
        self.webauthn_challenges = _TTLCache(ttl_seconds=300)

    def get_user(self, user_id: str | None) -> UserRecord | None:
        return self._users.get(user_id) if user_id else None

    def find_by_email(self, email: str) -> UserRecord | None:
        uid = self._email_index.get(email)
        return self._users.get(uid) if uid else None

    def all_users(self) -> list[UserRecord]:
        return list(self._users.values())

    def save(self, user: UserRecord) -> None:
        with self._lock:
            current = self._users.get(user.id)
            if current is not None and current is not user and current.version != user.version:
                raise ConcurrentUpdate(user.id)
            user.version += 1
            self._users[user.id] = user
            if user.email:
                self._email_index.setdefault(user.email, user.id)

    def _identity(self, provider: str, subject: str) -> str | None:
        return self._oauth_index.get((provider, subject))

    def _link_identity(self, provider: str, subject: str, user_id: str) -> None:
        self._oauth_index[(provider, subject)] = user_id

    def clear(self) -> None:
        self._users.clear()
        self._email_index.clear()
        self._oauth_index.clear()
        self.webauthn_challenges.clear()

    def get_or_create_oauth_user(
        self,
        provider: str,
        subject: str,
        email: str | None,
        name: str | None,
        email_verified: bool,
    ) -> UserRecord:
        """Identifica o utilizador por (provedor, subject), nunca só pelo email.

        O email só liga a uma conta existente quando o provedor o confirmou como
        verificado — evita tomada de conta por email falso.
        """
        with self._lock:
            user = self.get_user(self._identity(provider, subject))
            if user is None and email and email_verified:
                user = self.find_by_email(email)
            if user is None:
                user = UserRecord(id=str(uuid.uuid4()), email=email if email_verified else None, name=name)
            user.linked_methods.add(provider)
            self.save(user)
            self._link_identity(provider, subject, user.id)
            return user


class SqlStore(MemoryStore):
    """Postgres/SQLite via SQLAlchemy. Lê sempre da base de dados (sem cache)."""

    persistent = True

    def __init__(self, engine) -> None:
        super().__init__()
        self._engine = engine
        self.webauthn_challenges = _SqlChallenges(engine, "webauthn", 300)

    def _row_to_user(self, row) -> UserRecord | None:
        return _user_from_json(row.data, row.version) if row else None

    def get_user(self, user_id: str | None) -> UserRecord | None:
        if not user_id:
            return None
        u = db.users
        with self._engine.connect() as conn:
            return self._row_to_user(conn.execute(db.select(u.c.data, u.c.version).where(u.c.id == user_id)).first())

    def find_by_email(self, email: str) -> UserRecord | None:
        u = db.users
        with self._engine.connect() as conn:
            return self._row_to_user(conn.execute(db.select(u.c.data, u.c.version).where(u.c.email == email)).first())

    def all_users(self) -> list[UserRecord]:
        u = db.users
        with self._engine.connect() as conn:
            rows = conn.execute(db.select(u.c.data, u.c.version).order_by(u.c.created_at)).all()
        return [_user_from_json(r.data, r.version) for r in rows]

    def save(self, user: UserRecord) -> None:
        u = db.users
        values = {"email": user.email, "data": _user_to_json(user), "version": user.version + 1}
        with self._engine.begin() as conn:
            if user.version == 0:
                try:
                    conn.execute(u.insert().values(id=user.id, created_at=user.created_at, **values))
                except db.IntegrityError as exc:
                    raise ConcurrentUpdate(user.id) from exc
            else:
                res = conn.execute(u.update().where(u.c.id == user.id, u.c.version == user.version).values(**values))
                if res.rowcount != 1:
                    raise ConcurrentUpdate(user.id)
        user.version += 1

    def _identity(self, provider: str, subject: str) -> str | None:
        t = db.oauth_identities
        with self._engine.connect() as conn:
            return conn.execute(
                db.select(t.c.user_id).where(t.c.provider == provider, t.c.subject == subject)
            ).scalar_one_or_none()

    def _link_identity(self, provider: str, subject: str, user_id: str) -> None:
        t = db.oauth_identities
        with self._engine.begin() as conn:
            exists = conn.execute(
                db.select(t.c.user_id).where(t.c.provider == provider, t.c.subject == subject)
            ).first()
            if exists is None:
                conn.execute(t.insert().values(provider=provider, subject=subject, user_id=user_id))

    def get_or_create_oauth_user(self, provider, subject, email, name, email_verified) -> UserRecord:
        # Dois logins simultâneos da mesma pessoa podem colidir: tenta de novo com o estado atual.
        for attempt in range(3):
            try:
                return super().get_or_create_oauth_user(provider, subject, email, name, email_verified)
            except ConcurrentUpdate:
                if attempt == 2:
                    raise
        raise AssertionError("unreachable")

    def clear(self) -> None:
        with self._engine.begin() as conn:
            for table in (db.oauth_identities, db.users, db.ephemeral):
                conn.execute(table.delete())


def make_store() -> MemoryStore:
    engine = db.get_engine()
    return SqlStore(engine) if engine is not None else MemoryStore()


store = make_store()
