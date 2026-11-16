"""Base de dados (SQLAlchemy Core, síncrono).

`DATABASE_URL` escolhe o motor:
  * `postgresql://utilizador:senha@host:5432/aegis` (produção; usa o driver psycopg)
  * `sqlite:///./aegis.db` (local)
Sem `DATABASE_URL` a API usa memória (só desenvolvimento).

As tabelas são criadas no arranque se não existirem. A aplicação só insere em
`audit_log`; em produção dá ao papel da API apenas INSERT e SELECT nessa tabela
(ver src/app/admin/README.md), para que nem uma API comprometida a possa reescrever.
"""
from __future__ import annotations

import os

from sqlalchemy import (
    Column,
    Float,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    event,
    select,
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

__all__ = ["IntegrityError", "select", "get_engine", "metadata"]

metadata = MetaData()

users = Table(
    "users",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("email", String(320), unique=True, nullable=True),
    Column("data", Text, nullable=False),
    Column("version", Integer, nullable=False),
    Column("created_at", Float, nullable=False, index=True),
)

oauth_identities = Table(
    "oauth_identities",
    metadata,
    Column("provider", String(32), primary_key=True),
    Column("subject", String(255), primary_key=True),
    Column("user_id", String(36), nullable=False, index=True),
)

ephemeral = Table(
    "auth_ephemeral",
    metadata,
    Column("key", String(128), primary_key=True),
    Column("value", Text, nullable=False),
    Column("expires_at", Float, nullable=False, index=True),
)

audit_log = Table(
    "audit_log",
    metadata,
    Column("seq", Integer, primary_key=True, autoincrement=False),
    Column("ts", Float, nullable=False, index=True),
    Column("actor_id", String(36), nullable=True, index=True),
    Column("action", String(64), nullable=False, index=True),
    Column("outcome", String(16), nullable=False),
    Column("target", String(64), nullable=True, index=True),
    Column("ip", String(64), nullable=True),
    Column("reason", Text, nullable=True),
    Column("details", Text, nullable=False),
    Column("prev_hash", String(64), nullable=False),
    Column("hash", String(64), nullable=False),
)

approvals = Table(
    "admin_approvals",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("status", String(16), nullable=False, index=True),
    Column("created_at", Float, nullable=False, index=True),
    Column("data", Text, nullable=False),
    Column("version", Integer, nullable=False),
)


def database_url() -> str | None:
    url = (os.getenv("DATABASE_URL") or "").strip()
    if not url:
        return None
    # Os fornecedores (Heroku, Render, Supabase…) dão "postgres://"; o SQLAlchemy quer o driver explícito.
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


_engine: Engine | None = None
_engine_url: str | None = None


def get_engine() -> Engine | None:
    """Cria (uma vez) o engine e as tabelas. Devolve None sem DATABASE_URL."""
    global _engine, _engine_url
    url = database_url()
    if url is None:
        return None
    if _engine is None or _engine_url != url:
        engine = create_engine(url, pool_pre_ping=True)
        if engine.dialect.name == "sqlite":
            @event.listens_for(engine, "connect")
            def _sqlite_pragmas(dbapi_conn, _record):  # pragma: no cover - trivial
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.close()
        metadata.create_all(engine)
        _engine, _engine_url = engine, url
    return _engine
