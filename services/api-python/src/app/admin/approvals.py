"""Regra das duas pessoas: dar uma função privilegiada exige um pedido e a
aprovação de OUTRO proprietário. Os pedidos expiram ao fim de 24 h.

Com DATABASE_URL os pedidos ficam na tabela `admin_approvals`; a decisão usa
concorrência otimista, por isso dois proprietários não decidem o mesmo pedido.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass

from src.app import db

APPROVAL_TTL_SECONDS = 24 * 3600


def two_person_rule_enabled() -> bool:
    return os.getenv("ADMIN_TWO_PERSON_RULE", "true").lower() not in {"0", "false", "no", "off"}


class ApprovalConflict(Exception):
    """O pedido foi decidido por outra pessoa entretanto."""


@dataclass
class ApprovalRequest:
    id: str
    action: str  # grant_role
    target_user_id: str
    role: str
    requested_by: str
    reason: str
    created_at: float
    status: str = "pending"  # pending | approved | rejected | expired
    decided_by: str | None = None
    decided_at: float | None = None
    decision_note: str | None = None
    version: int = 0

    def expired(self, now: float | None = None) -> bool:
        return (now or time.time()) - self.created_at > APPROVAL_TTL_SECONDS

    def public(self) -> dict:
        data = asdict(self)
        data.pop("version")
        return data


class ApprovalQueue:
    """Motor em memória."""

    def __init__(self) -> None:
        self._items: dict[str, ApprovalRequest] = {}
        self.lock = threading.RLock()

    # -- armazenamento (substituído no motor SQL) --
    def _load_all(self) -> list[ApprovalRequest]:
        return list(self._items.values())

    def _load(self, request_id: str) -> ApprovalRequest | None:
        return self._items.get(request_id)

    def save(self, req: ApprovalRequest) -> None:
        with self.lock:
            current = self._items.get(req.id)
            if current is not None and current is not req and current.version != req.version:
                raise ApprovalConflict(req.id)
            req.version += 1
            self._items[req.id] = req

    # -- operações --
    @staticmethod
    def _refresh(item: ApprovalRequest) -> ApprovalRequest:
        if item.status == "pending" and item.expired():
            item.status = "expired"
        return item

    def create(self, target_user_id: str, role: str, requested_by: str, reason: str) -> ApprovalRequest:
        with self.lock:
            for item in self.all():
                if item.status == "pending" and item.target_user_id == target_user_id and item.role == role:
                    return item  # idempotente: não duplica pedidos iguais
            req = ApprovalRequest(
                id=str(uuid.uuid4()),
                action="grant_role",
                target_user_id=target_user_id,
                role=role,
                requested_by=requested_by,
                reason=reason,
                created_at=time.time(),
            )
            self.save(req)
            return req

    def get(self, request_id: str) -> ApprovalRequest | None:
        item = self._load(request_id)
        return self._refresh(item) if item else None

    def all(self) -> list[ApprovalRequest]:
        return sorted((self._refresh(i) for i in self._load_all()), key=lambda r: r.created_at, reverse=True)

    def pending_count(self) -> int:
        return sum(1 for r in self.all() if r.status == "pending")

    def clear(self) -> None:
        self._items.clear()


class SqlApprovalQueue(ApprovalQueue):
    def __init__(self, engine) -> None:
        super().__init__()
        self._engine = engine

    @staticmethod
    def _from_row(r) -> ApprovalRequest:
        return ApprovalRequest(**json.loads(r.data), version=r.version)

    def _load_all(self) -> list[ApprovalRequest]:
        t = db.approvals
        with self._engine.connect() as conn:
            rows = conn.execute(db.select(t.c.data, t.c.version).order_by(t.c.created_at.desc()).limit(500)).all()
        return [self._from_row(r) for r in rows]

    def _load(self, request_id: str) -> ApprovalRequest | None:
        t = db.approvals
        with self._engine.connect() as conn:
            r = conn.execute(db.select(t.c.data, t.c.version).where(t.c.id == request_id)).first()
        return self._from_row(r) if r else None

    def save(self, req: ApprovalRequest) -> None:
        t = db.approvals
        values = {"status": req.status, "data": json.dumps(req.public()), "version": req.version + 1}
        with self._engine.begin() as conn:
            if req.version == 0:
                conn.execute(t.insert().values(id=req.id, created_at=req.created_at, **values))
            elif conn.execute(t.update().where(t.c.id == req.id, t.c.version == req.version).values(**values)).rowcount != 1:
                raise ApprovalConflict(req.id)
        req.version += 1

    def clear(self) -> None:
        with self._engine.begin() as conn:
            conn.execute(db.approvals.delete())


def make_approvals() -> ApprovalQueue:
    engine = db.get_engine()
    return SqlApprovalQueue(engine) if engine is not None else ApprovalQueue()


approvals = make_approvals()
