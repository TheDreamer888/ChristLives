"""Contrato das respostas da administração e da lista de espera.

Estes modelos são a fonte de verdade do OpenAPI de onde o SDK é gerado.
O FastAPI valida e filtra cada resposta por eles: um campo que não esteja
aqui nunca sai da API, mesmo que um handler o devolva por engano.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Outcome = Literal["success", "denied", "error"]
UserStatus = Literal["active", "suspended"]
ApprovalStatus = Literal["pending", "approved", "rejected", "expired"]
Interest = Literal["familias", "escolas", "empresas", "outro"]


class Ok(BaseModel):
    ok: Literal[True] = True


class AdminUser(BaseModel):
    id: str
    email: str | None = Field(description="Completo com users.read_pii; mascarado (a***@dominio) sem essa permissão.")
    name: str | None
    roles: list[str]
    status: UserStatus
    methods: list[str]
    mfa: bool
    passkeys: int
    created_at: float = Field(description="Segundos desde a época Unix (UTC).")
    last_login_at: float | None


class AuditEntry(BaseModel):
    seq: int
    ts: float
    actor_id: str | None
    action: str
    outcome: Outcome
    target: str | None
    ip: str | None
    reason: str | None
    details: dict[str, object]
    hash: str = Field(description="HMAC-SHA256 da entrada, encadeado à anterior.")


class ChainStatus(BaseModel):
    valid: bool
    checked: int
    total: int
    broken_at: int | None


class Me(BaseModel):
    id: str
    name: str | None
    roles: list[str]
    permissions: list[str]
    session_expires_in: int = Field(description="Segundos até a sessão de administração expirar.")
    step_up_valid_for: int = Field(description="Segundos em que ainda são permitidas alterações sem novo login.")


class RoleInfo(BaseModel):
    id: str
    label: str
    description: str
    privileged: bool
    permissions: list[str]
    members: int


class RolesResponse(BaseModel):
    roles: list[RoleInfo]
    two_person_rule: bool


class Overview(BaseModel):
    users_total: int
    users_active_24h: int
    users_suspended: int
    users_with_passkey: int
    staff: dict[str, int]
    approvals_pending: int
    audit_events_24h: int
    denied_24h: int
    audit_chain: ChainStatus
    recent: list[AuditEntry]


class UserPage(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[AdminUser]


class UserDetail(BaseModel):
    user: AdminUser
    history: list[AuditEntry]


class AuditPage(BaseModel):
    total: int
    items: list[AuditEntry]


class PostureCheck(BaseModel):
    id: str
    label: str
    ok: bool


class Posture(BaseModel):
    score: int = Field(ge=0, le=100)
    checks: list[PostureCheck]


class Approval(BaseModel):
    id: str
    action: str
    target_user_id: str
    role: str
    requested_by: str
    reason: str
    created_at: float
    status: ApprovalStatus
    decided_by: str | None
    decided_at: float | None
    decision_note: str | None


class ApprovalList(BaseModel):
    items: list[Approval]


class UserResult(Ok):
    user: AdminUser


class RolesResult(UserResult):
    pending_approvals: list[str] = Field(description="Pedidos criados para funções privilegiadas (regra das duas pessoas).")


class DecisionResult(Ok):
    request: Approval


class WaitlistItem(BaseModel):
    email: str
    interest: Interest
    consent_version: str
    created_at: float


class WaitlistOverview(BaseModel):
    total: int
    last_7_days: int
    by_interest: dict[str, int]
    daily_14d: list[int] = Field(min_length=14, max_length=14, description="Inscrições por dia, do mais antigo para hoje.")
    retention_days: int
    consent_version: str
    items: list[WaitlistItem]
