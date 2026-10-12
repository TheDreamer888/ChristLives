"""Ligação partilhada à base de dados PostgreSQL."""
from __future__ import annotations

from collections.abc import AsyncIterator
from functools import lru_cache

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from src.app.config import settings


@lru_cache(maxsize=1)
def _engine() -> AsyncEngine:
    return create_async_engine(settings.sqlalchemy_database_url, pool_pre_ping=True)


@lru_cache(maxsize=1)
def session_factory() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(_engine(), expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with session_factory()() as session:
        yield session


async def dispose_database() -> None:
    if _engine.cache_info().currsize:
        await _engine().dispose()
    session_factory.cache_clear()
    _engine.cache_clear()
