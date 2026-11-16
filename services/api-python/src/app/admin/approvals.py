"""Regra das duas pessoas: dar uma função privilegiada exige um pedido e a
aprovação de OUTRO proprietário. Os pedidos expiram ao fim de 24 h."""
from __future__ import annotations

import os
import threading
import time
import uuid
from dataclasses import dataclass

APPROVAL_TTL_SECONDS = 24 * 3600


def two_person_rule_enabled() -> bool:
    return os.getenv("ADMIN_TWO_PERSON_RULE", "true").lower() not in {"0", "false", "no", "off"}


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

    def expired(self, now: float | None = None) -> bool:
        return (now or time.time()) - self.created_at > APPROVAL_TTL_SECONDS


class ApprovalQueue:
    def __init__(self) -> None:
        self._items: dict[str, ApprovalRequest] = {}
        self.lock = threading.Lock()

    def create(self, target_user_id: str, role: str, requested_by: str, reason: str) -> ApprovalRequest:
        with self.lock:
            for item in self._items.values():
                if (
                    item.status == "pending"
                    and not item.expired()
                    and item.target_user_id == target_user_id
                    and item.role == role
                ):
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
            self._items[req.id] = req
            return req

    def get(self, request_id: str) -> ApprovalRequest | None:
        item = self._items.get(request_id)
        if item and item.status == "pending" and item.expired():
            item.status = "expired"
        return item

    def all(self) -> list[ApprovalRequest]:
        items = list(self._items.values())
        for item in items:
            if item.status == "pending" and item.expired():
                item.status = "expired"
        return sorted(items, key=lambda r: r.created_at, reverse=True)

    def pending_count(self) -> int:
        return sum(1 for r in self.all() if r.status == "pending")

    def clear(self) -> None:
        self._items.clear()


approvals = ApprovalQueue()
