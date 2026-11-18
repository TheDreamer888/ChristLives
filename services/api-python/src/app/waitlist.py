"""Lista de espera, pensada para o RGPD desde o início.

* Guarda só o necessário: email, interesse e a versão do texto de consentimento.
  Não guarda IP, user-agent, referrer nem identificadores de rastreio.
* Consentimento explícito (caixa obrigatória) e finalidade única: avisar do
  lançamento. A versão do texto fica registada como prova do consentimento.
* Resposta igual para emails novos e repetidos: não revela quem está inscrito.
* Anti-spam sem CAPTCHA de terceiros: campo-isco invisível, limite por IP e
  limite global por hora.
* Retenção limitada: inscrições mais antigas que WAITLIST_RETENTION_DAYS
  (365 por omissão) são apagadas automaticamente.
"""
from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field

from src.app import db
from src.app.auth import routes as auth_routes

CONSENT_VERSION = "2026-11-v1"
CONSENT_TEXT = (
    "Aceito que a Lusorbe guarde o meu email apenas para me avisar do lançamento. "
    "Posso pedir a remoção a qualquer momento."
)
Interest = Literal["familias", "escolas", "empresas", "outro"]
INTERESTS: dict[str, str] = {"familias": "Famílias", "escolas": "Escolas", "empresas": "Empresas", "outro": "Outro"}

router = APIRouter(prefix="/api/waitlist", tags=["waitlist"])


def _retention_seconds() -> float:
    return float(os.getenv("WAITLIST_RETENTION_DAYS", "365")) * 86400


@dataclass
class Entry:
    email: str
    interest: str
    consent_version: str
    created_at: float


class MemoryWaitlist:
    def __init__(self) -> None:
        self._items: dict[str, Entry] = {}
        self._lock = threading.Lock()

    def add(self, entry: Entry) -> bool:
        with self._lock:
            if entry.email in self._items:
                return False
            self._items[entry.email] = entry
            return True

    def all(self) -> list[Entry]:
        return sorted(self._items.values(), key=lambda e: e.created_at, reverse=True)

    def delete(self, email: str) -> bool:
        with self._lock:
            return self._items.pop(email, None) is not None

    def purge_older_than(self, cutoff: float) -> int:
        with self._lock:
            old = [k for k, v in self._items.items() if v.created_at < cutoff]
            for k in old:
                del self._items[k]
            return len(old)

    def clear(self) -> None:
        self._items.clear()


class SqlWaitlist(MemoryWaitlist):
    def __init__(self, engine) -> None:
        super().__init__()
        self._engine = engine

    def add(self, entry: Entry) -> bool:
        try:
            with self._engine.begin() as conn:
                conn.execute(db.waitlist.insert().values(**entry.__dict__))
            return True
        except db.IntegrityError:
            return False

    def all(self) -> list[Entry]:
        t = db.waitlist
        with self._engine.connect() as conn:
            rows = conn.execute(db.select(t).order_by(t.c.created_at.desc())).all()
        return [Entry(r.email, r.interest, r.consent_version, r.created_at) for r in rows]

    def delete(self, email: str) -> bool:
        with self._engine.begin() as conn:
            return conn.execute(db.waitlist.delete().where(db.waitlist.c.email == email)).rowcount == 1

    def purge_older_than(self, cutoff: float) -> int:
        with self._engine.begin() as conn:
            return conn.execute(db.waitlist.delete().where(db.waitlist.c.created_at < cutoff)).rowcount

    def clear(self) -> None:
        with self._engine.begin() as conn:
            conn.execute(db.waitlist.delete())


def make_waitlist() -> MemoryWaitlist:
    engine = db.get_engine()
    return SqlWaitlist(engine) if engine is not None else MemoryWaitlist()


waitlist = make_waitlist()


def purge_expired() -> int:
    return waitlist.purge_older_than(time.time() - _retention_seconds())


class JoinBody(BaseModel):
    email: EmailStr = Field(max_length=254)
    interest: Interest = "outro"
    consent: bool
    website: str = Field(default="", max_length=200)  # isco: humanos não veem este campo


class JoinResult(BaseModel):
    ok: Literal[True] = True
    message: str


class ConsentInfo(BaseModel):
    version: str
    text: str
    interests: dict[str, str]


def _limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    for key, limit, window in ((f"wl:ip:{ip}", 5, 3600), ("wl:global", 500, 3600)):
        retry = auth_routes.limiter.hit(key, limit=limit, window_seconds=window)
        if retry is not None:
            raise auth_routes._too_many(retry)


@router.get("/consent")
def consent_text() -> ConsentInfo:  # type: ignore[return-value]
    return {"version": CONSENT_VERSION, "text": CONSENT_TEXT, "interests": INTERESTS}


@router.post("", status_code=202, dependencies=[Depends(auth_routes._require_same_origin), Depends(_limit)])
def join(body: JoinBody) -> JoinResult:  # type: ignore[return-value]
    if not body.consent:
        raise HTTPException(422, "É preciso aceitar para entrar na lista.")
    if not body.website:  # bots preenchem o isco; respondem igual mas nada é guardado
        purge_expired()
        waitlist.add(
            Entry(
                email=str(body.email).strip().lower(),
                interest=body.interest,
                consent_version=CONSENT_VERSION,
                created_at=time.time(),
            )
        )
    # Mesma resposta para novo, repetido ou bot: não revela quem está inscrito.
    return {"ok": True, "message": "Obrigado! Avisamos-te quando abrirmos."}
