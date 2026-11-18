"""Consola de administração — controlos ao nível de uma empresa grande.

Camadas de proteção em TODOS os pedidos /api/admin:
  1. Sessão válida e utilizador com função de staff (senão 404: a consola não
     se anuncia a quem não tem acesso).
  2. Autenticação forte: o login desta sessão tem de ter sido com passkey
     (FIDO2, resistente a phishing) — ADMIN_REQUIRE_PASSKEY=true por omissão.
  3. Sessão de admin curta (ADMIN_SESSION_MAX_AGE, 1 h por omissão).
  4. Lista de IPs/redes permitidas opcional (ADMIN_IP_ALLOWLIST, CIDR).
  5. Permissão granular por endpoint (rbac.py), negações também auditadas.
Nas escritas, além disso: Origin igual ao frontend, step-up (login recente),
justificação obrigatória, limite de ritmo por administrador, proibição de
agir sobre a própria conta e proteção do último proprietário.
"""
from __future__ import annotations

import csv
import hashlib
import io
import ipaddress
import os
import time
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from src.app.admin import rbac
from src.app.admin import schemas as s
from src.app.admin.approvals import ApprovalConflict, approvals, two_person_rule_enabled
from src.app.admin.audit import audit_log
from src.app.auth import routes as auth_routes
from src.app.auth.store import ConcurrentUpdate, UserRecord, store
from src.app import waitlist as wl



def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"  # dados de admin nunca em cache


router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(_no_store)])

_ACTION_LIMIT = int(os.getenv("ADMIN_ACTIONS_PER_MINUTE", "20"))


# ---- Configuração -----------------------------------------------------------

def _flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _require_passkey() -> bool:
    return _flag("ADMIN_REQUIRE_PASSKEY", True)


def _session_max_age() -> int:
    return int(os.getenv("ADMIN_SESSION_MAX_AGE", "3600"))


def _ip_allowlist() -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    nets = []
    for part in os.getenv("ADMIN_IP_ALLOWLIST", "").split(","):
        part = part.strip()
        if part:
            nets.append(ipaddress.ip_network(part, strict=False))
    return nets


def _bootstrap_emails() -> set[str]:
    return {e.strip().lower() for e in os.getenv("ADMIN_BOOTSTRAP_EMAILS", "").split(",") if e.strip()}


# ---- Contexto do pedido -----------------------------------------------------

class AdminContext:
    def __init__(self, user: UserRecord, claims: dict, ip: str | None) -> None:
        self.user = user
        self.claims = claims
        self.ip = ip
        self.permissions = rbac.permissions_for(user.roles)

    def audit(self, action: str, outcome: str = "success", **kw) -> None:
        audit_log.record(action, outcome, self.user.id, ip=self.ip, **kw)


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _owners() -> list[UserRecord]:
    return [u for u in store.all_users() if "owner" in u.roles and not u.suspended]


def _maybe_bootstrap(user: UserRecord, ip: str | None) -> None:
    """Primeiro proprietário: só se ainda não houver nenhum e o email (verificado
    pelo provedor) estiver em ADMIN_BOOTSTRAP_EMAILS. Fica auditado."""
    if user.roles or _owners() or not user.email:
        return
    if user.email.lower() in _bootstrap_emails():
        user.roles.add("owner")
        store.save(user)
        audit_log.record("admin.bootstrap_owner", "success", user.id, target=user.id, ip=ip)


def _admin_context(request: Request) -> AdminContext:
    ip = _client_ip(request)
    claims = auth_routes._session_claims(request)
    user = store.get_user(claims["sub"]) if claims else None
    if not claims or not auth_routes._session_usable(claims, user):
        raise HTTPException(401, "Autentica-te primeiro.")
    assert user is not None
    _maybe_bootstrap(user, ip)
    if not rbac.is_staff(user.roles):
        raise HTTPException(404, "Not Found")

    allow = _ip_allowlist()
    if allow:
        try:
            addr = ipaddress.ip_address(ip or "")
        except ValueError:
            addr = None
        if addr is None or not any(addr in net for net in allow):
            audit_log.record("admin.access", "denied", user.id, ip=ip, details={"why": "ip_not_allowed"})
            raise HTTPException(403, "Acesso à administração não permitido a partir desta rede.")

    if _require_passkey() and "passkey" not in (claims.get("amr") or []):
        audit_log.record("admin.access", "denied", user.id, ip=ip, details={"why": "passkey_required"})
        raise HTTPException(403, "A administração exige início de sessão com chave de acesso (passkey).")

    iat = claims.get("iat")
    if not isinstance(iat, (int, float)) or time.time() - iat > _session_max_age():
        raise HTTPException(401, "A sessão de administração expirou. Inicia sessão novamente.")
    return AdminContext(user, claims, ip)


def require(permission: str) -> Callable[[Request], AdminContext]:
    def dep(request: Request) -> AdminContext:
        ctx = _admin_context(request)
        if permission not in ctx.permissions:
            ctx.audit("admin.permission", "denied", details={"permission": permission, "path": request.url.path})
            raise HTTPException(403, "Não tens permissão para esta operação.")
        return ctx

    return dep


def require_write(permission: str) -> Callable[[Request], AdminContext]:
    base = require(permission)

    def dep(request: Request) -> AdminContext:
        auth_routes._require_same_origin(request)
        ctx = base(request)
        iat = ctx.claims.get("iat", 0)
        if time.time() - iat > auth_routes._STEP_UP_SECONDS:
            raise HTTPException(403, "Confirma a tua identidade (inicia sessão de novo) antes desta alteração.")
        retry = auth_routes.limiter.hit(f"admin:{ctx.user.id}", limit=_ACTION_LIMIT, window_seconds=60)
        if retry is not None:
            ctx.audit("admin.rate_limited", "denied")
            raise auth_routes._too_many(retry)
        return ctx

    return dep


# ---- Modelos ----------------------------------------------------------------

class ReasonBody(BaseModel):
    reason: str = Field(min_length=10, max_length=500)


class RolesBody(ReasonBody):
    roles: list[str] = Field(max_length=10)


class DecisionBody(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=500)


# ---- Utilitários de apresentação -----------------------------------------------

def _mask_email(email: str | None) -> str | None:
    if not email or "@" not in email:
        return email
    local, domain = email.split("@", 1)
    return f"{local[:1]}***@{domain}"


def _user_view(user: UserRecord, ctx: AdminContext) -> dict:
    pii = rbac.USERS_READ_PII in ctx.permissions
    return {
        "id": user.id,
        "email": user.email if pii else _mask_email(user.email),
        "name": user.name,
        "roles": sorted(user.roles),
        "status": "suspended" if user.suspended else "active",
        "methods": sorted(user.linked_methods),
        "mfa": bool(user.webauthn_credentials),
        "passkeys": len(user.webauthn_credentials),
        "created_at": user.created_at,
        "last_login_at": user.last_login_at,
    }


def _entry_view(e) -> dict:
    return {
        "seq": e.seq,
        "ts": e.ts,
        "actor_id": e.actor_id,
        "action": e.action,
        "outcome": e.outcome,
        "target": e.target,
        "ip": e.ip,
        "reason": e.reason,
        "details": e.details,
        "hash": e.hash,
    }


def _get_target(user_id: str) -> UserRecord:
    user = store.get_user(user_id)
    if not user:
        raise HTTPException(404, "Utilizador não encontrado.")
    return user


def _save(user: UserRecord) -> None:
    try:
        store.save(user)
    except ConcurrentUpdate as exc:
        raise HTTPException(409, "A conta foi alterada entretanto. Atualiza e tenta de novo.") from exc


def _guard_target(ctx: AdminContext, target: UserRecord, action: str) -> None:
    if target.id == ctx.user.id:
        ctx.audit(action, "denied", target=target.id, details={"why": "self_action"})
        raise HTTPException(403, "Não podes executar esta ação sobre a tua própria conta.")
    # Só um proprietário age sobre contas privilegiadas.
    if target.roles & rbac.PRIVILEGED_ROLES and "owner" not in ctx.user.roles:
        ctx.audit(action, "denied", target=target.id, details={"why": "privileged_target"})
        raise HTTPException(403, "Só um proprietário pode alterar contas privilegiadas.")


# ---- Endpoints de leitura -------------------------------------------------------

@router.get("/me")
def me(ctx: AdminContext = Depends(_admin_context)) -> s.Me:  # type: ignore[return-value]
    return {
        "id": ctx.user.id,
        "name": ctx.user.name,
        "roles": sorted(ctx.user.roles),
        "permissions": sorted(ctx.permissions),
        "session_expires_in": max(0, int(_session_max_age() - (time.time() - ctx.claims["iat"]))),
        "step_up_valid_for": max(0, int(auth_routes._STEP_UP_SECONDS - (time.time() - ctx.claims["iat"]))),
    }


@router.get("/roles")
def roles(ctx: AdminContext = Depends(_admin_context)) -> s.RolesResponse:  # type: ignore[return-value]
    all_users = store.all_users()
    return {
        "roles": [
            {
                "id": r.id,
                "label": r.label,
                "description": r.description,
                "privileged": r.privileged,
                "permissions": sorted(r.permissions),
                "members": sum(1 for u in all_users if r.id in u.roles),
            }
            for r in rbac.ROLES.values()
        ],
        "two_person_rule": two_person_rule_enabled(),
    }


@router.get("/overview")
def overview(ctx: AdminContext = Depends(require(rbac.USERS_READ))) -> s.Overview:  # type: ignore[return-value]
    now = time.time()
    users = store.all_users()
    entries = audit_log.entries()
    day = [e for e in entries if now - e.ts <= 86400]
    return {
        "users_total": len(users),
        "users_active_24h": sum(1 for u in users if u.last_login_at and now - u.last_login_at <= 86400),
        "users_suspended": sum(1 for u in users if u.suspended),
        "users_with_passkey": sum(1 for u in users if u.webauthn_credentials),
        "staff": {r: sum(1 for u in users if r in u.roles) for r in rbac.ROLES},
        "approvals_pending": approvals.pending_count(),
        "audit_events_24h": len(day),
        "denied_24h": sum(1 for e in day if e.outcome == "denied"),
        "audit_chain": audit_log.verify(),
        "recent": [_entry_view(e) for e in entries[-8:][::-1]],
    }


@router.get("/users")
def list_users(
    ctx: AdminContext = Depends(require(rbac.USERS_READ)),
    q: str = Query(default="", max_length=100),
    role: str = Query(default="", max_length=40),
    status: str = Query(default="", pattern="^(|active|suspended)$"),
    page: int = Query(default=1, ge=1, le=10_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> s.UserPage:  # type: ignore[return-value]
    needle = q.strip().lower()
    items = []
    for user in store.all_users():
        if role and role not in user.roles:
            continue
        if status == "suspended" and not user.suspended or status == "active" and user.suspended:
            continue
        if needle and not any(needle in (v or "").lower() for v in (user.email, user.name, user.id)):
            continue
        items.append(user)
    items.sort(key=lambda u: u.created_at, reverse=True)
    start = (page - 1) * page_size
    return {
        "total": len(items),
        "page": page,
        "page_size": page_size,
        "items": [_user_view(u, ctx) for u in items[start : start + page_size]],
    }


@router.get("/users/{user_id}")
def get_user(user_id: str, ctx: AdminContext = Depends(require(rbac.USERS_READ))) -> s.UserDetail:  # type: ignore[return-value]
    user = _get_target(user_id)
    history = [_entry_view(e) for e in audit_log.entries() if e.target == user_id][-20:][::-1]
    return {"user": _user_view(user, ctx), "history": history}


@router.get("/audit")
def audit(
    ctx: AdminContext = Depends(require(rbac.AUDIT_READ)),
    action: str = Query(default="", max_length=60),
    outcome: str = Query(default="", pattern="^(|success|denied|error)$"),
    actor: str = Query(default="", max_length=64),
    limit: int = Query(default=100, ge=1, le=500),
) -> s.AuditPage:  # type: ignore[return-value]
    items = [
        e
        for e in audit_log.entries()
        if (not action or e.action.startswith(action))
        and (not outcome or e.outcome == outcome)
        and (not actor or e.actor_id == actor)
    ]
    return {"total": len(items), "items": [_entry_view(e) for e in items[-limit:][::-1]]}


@router.get("/audit/verify")
def audit_verify(ctx: AdminContext = Depends(require(rbac.AUDIT_READ))) -> s.ChainStatus:  # type: ignore[return-value]
    result = audit_log.verify()
    ctx.audit("audit.verify", details={"valid": result["valid"]})
    return result


def _csv_safe(value: object) -> str:
    text = "" if value is None else str(value)
    # Evita injeção de fórmulas quando o CSV é aberto no Excel.
    return "'" + text if text[:1] in {"=", "+", "-", "@", "\t", "\r"} else text


@router.get(
    "/audit/export",
    responses={200: {"content": {"text/csv": {}}, "description": "CSV (UTF-8)."}},
    response_class=StreamingResponse,
)
def audit_export(ctx: AdminContext = Depends(require(rbac.AUDIT_EXPORT))) -> StreamingResponse:
    entries = audit_log.entries()
    ctx.audit("audit.export", details={"rows": len(entries)})
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["seq", "ts_utc", "actor_id", "action", "outcome", "target", "ip", "reason", "hash"])
    for e in entries:
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(e.ts))
        writer.writerow([_csv_safe(v) for v in (e.seq, ts, e.actor_id, e.action, e.outcome, e.target, e.ip, e.reason, e.hash)])
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="lusorbe-auditoria.csv"', "Cache-Control": "no-store"},
    )


@router.get("/security")
def security_posture(ctx: AdminContext = Depends(require(rbac.SECURITY_READ))) -> s.Posture:  # type: ignore[return-value]
    production = os.getenv("ENV", "production").lower() not in {"development", "dev", "test"}
    checks = [
        ("env_production", "Ambiente em modo produção", production),
        ("passkey_required", "Admins obrigados a usar passkey", _require_passkey()),
        ("two_person_rule", "Regra das duas pessoas para funções privilegiadas", two_person_rule_enabled()),
        ("ip_allowlist", "Administração restrita a redes conhecidas", bool(_ip_allowlist())),
        ("audit_key", "Chave HMAC da auditoria persistente", not audit_log.key_is_ephemeral),
        ("audit_export", "Auditoria copiada para ficheiro/SIEM", bool(os.getenv("AUDIT_LOG_PATH"))),
        ("short_admin_sessions", "Sessões de admin com no máximo 1 h", _session_max_age() <= 3600),
        ("multiple_owners", "Pelo menos 2 proprietários (sem ponto único de falha)", len(_owners()) >= 2),
        ("persistent_storage", "Dados guardados em base de dados (não em memória)", store.persistent),
        (
            "shared_rate_limits",
            "Limites de pedidos partilhados entre instâncias (Redis)",
            getattr(auth_routes.limiter, "shared", False) and not getattr(auth_routes.limiter, "degraded", False),
        ),
    ]
    items = [{"id": cid, "label": label, "ok": ok} for cid, label, ok in checks]
    return {"score": round(100 * sum(c["ok"] for c in items) / len(items)), "checks": items}


@router.get("/approvals")
def list_approvals(ctx: AdminContext = Depends(require(rbac.USERS_READ))) -> s.ApprovalList:  # type: ignore[return-value]
    return {"items": [r.public() for r in approvals.all()[:100]]}


# ---- Endpoints de escrita -------------------------------------------------------

@router.post("/users/{user_id}/suspend")
def suspend(user_id: str, body: ReasonBody, ctx: AdminContext = Depends(require_write(rbac.USERS_SUSPEND))) -> s.UserResult:  # type: ignore[return-value]
    target = _get_target(user_id)
    _guard_target(ctx, target, "user.suspend")
    if "owner" in target.roles and len(_owners()) <= 1:
        raise HTTPException(409, "Não podes suspender o último proprietário.")
    target.suspended = True
    target.sessions_valid_after = time.time()
    _save(target)
    ctx.audit("user.suspend", target=target.id, reason=body.reason)
    return {"ok": True, "user": _user_view(target, ctx)}


@router.post("/users/{user_id}/reactivate")
def reactivate(user_id: str, body: ReasonBody, ctx: AdminContext = Depends(require_write(rbac.USERS_SUSPEND))) -> s.UserResult:  # type: ignore[return-value]
    target = _get_target(user_id)
    _guard_target(ctx, target, "user.reactivate")
    target.suspended = False
    _save(target)
    ctx.audit("user.reactivate", target=target.id, reason=body.reason)
    return {"ok": True, "user": _user_view(target, ctx)}


@router.post("/users/{user_id}/revoke-sessions")
def revoke_sessions(
    user_id: str, body: ReasonBody, ctx: AdminContext = Depends(require_write(rbac.USERS_REVOKE_SESSIONS))
) -> s.Ok:  # type: ignore[return-value]
    target = _get_target(user_id)
    _guard_target(ctx, target, "user.revoke_sessions")
    target.sessions_valid_after = time.time()
    _save(target)
    ctx.audit("user.revoke_sessions", target=target.id, reason=body.reason)
    return {"ok": True}


@router.post("/users/{user_id}/roles")
def set_roles(user_id: str, body: RolesBody, ctx: AdminContext = Depends(require_write(rbac.ROLES_ASSIGN))) -> s.RolesResult:  # type: ignore[return-value]
    target = _get_target(user_id)
    _guard_target(ctx, target, "user.roles")
    wanted = set(body.roles)
    unknown = wanted - set(rbac.ROLES)
    if unknown:
        raise HTTPException(422, f"Funções desconhecidas: {', '.join(sorted(unknown))}.")

    added, removed = wanted - target.roles, target.roles - wanted
    is_owner = "owner" in ctx.user.roles
    if "owner" in removed and len(_owners()) <= 1:
        raise HTTPException(409, "Não podes remover o último proprietário.")
    if removed & rbac.PRIVILEGED_ROLES and not is_owner:
        raise HTTPException(403, "Só um proprietário pode retirar funções privilegiadas.")

    privileged_added = added & rbac.PRIVILEGED_ROLES
    pending = []
    if privileged_added:
        if rbac.ROLES_REQUEST_PRIVILEGED not in ctx.permissions:
            raise HTTPException(403, "Não podes pedir funções privilegiadas.")
        if two_person_rule_enabled():
            for role in sorted(privileged_added):
                req = approvals.create(target.id, role, ctx.user.id, body.reason)
                pending.append(req.id)
                ctx.audit("approval.request", target=target.id, reason=body.reason, details={"role": role, "request": req.id})
            added -= privileged_added
        elif not is_owner:
            raise HTTPException(403, "Só um proprietário pode dar funções privilegiadas.")

    target.roles = (target.roles - removed) | added
    if added or removed:
        target.sessions_valid_after = time.time()  # novas permissões exigem novo login
        _save(target)
        ctx.audit(
            "user.roles",
            target=target.id,
            reason=body.reason,
            details={"added": sorted(added), "removed": sorted(removed)},
        )
    return {"ok": True, "user": _user_view(target, ctx), "pending_approvals": pending}


@router.post("/approvals/{request_id}/decide")
def decide(
    request_id: str, body: DecisionBody, ctx: AdminContext = Depends(require_write(rbac.APPROVALS_DECIDE))
) -> s.DecisionResult:  # type: ignore[return-value]
    with approvals.lock:
        req = approvals.get(request_id)
        if not req:
            raise HTTPException(404, "Pedido não encontrado.")
        if req.status != "pending":
            raise HTTPException(409, f"Este pedido já está {req.status}.")
        if req.requested_by == ctx.user.id:
            ctx.audit("approval.decide", "denied", target=req.target_user_id, details={"why": "self_approval"})
            raise HTTPException(403, "Quem pede não pode aprovar o próprio pedido (regra das duas pessoas).")
        if req.target_user_id == ctx.user.id:
            raise HTTPException(403, "Não podes aprovar uma elevação para ti próprio.")
        target = _get_target(req.target_user_id)
        req.status = "approved" if body.approve else "rejected"
        req.decided_by, req.decided_at, req.decision_note = ctx.user.id, time.time(), body.note or None
        try:
            approvals.save(req)  # falha se outro proprietário decidiu primeiro
        except ApprovalConflict as exc:
            raise HTTPException(409, "Este pedido acabou de ser decidido por outra pessoa.") from exc
        if body.approve:
            target.roles.add(req.role)
            target.sessions_valid_after = time.time()
            _save(target)
    ctx.audit(
        "approval.decide",
        target=req.target_user_id,
        reason=body.note or None,
        details={"request": req.id, "role": req.role, "approved": body.approve},
    )
    return {"ok": True, "request": req.public()}


# ---- Lista de espera ------------------------------------------------------------

class WaitlistDeleteBody(ReasonBody):
    email: str = Field(min_length=3, max_length=254)


def _email_ref(email: str) -> str:
    """Referência ao email na auditoria sem o guardar (a auditoria não se apaga)."""
    return "wl:" + hashlib.sha256(email.strip().lower().encode()).hexdigest()[:16]


@router.get("/waitlist")
def waitlist_overview(ctx: AdminContext = Depends(require(rbac.USERS_READ))) -> s.WaitlistOverview:  # type: ignore[return-value]
    wl.purge_expired()
    entries = wl.waitlist.all()
    now = time.time()
    pii = rbac.USERS_READ_PII in ctx.permissions
    days = []
    for d in range(13, -1, -1):  # últimos 14 dias, do mais antigo para hoje
        start = now - (d + 1) * 86400
        end = now - d * 86400
        days.append(sum(1 for e in entries if start <= e.created_at < end))
    return {
        "total": len(entries),
        "last_7_days": sum(1 for e in entries if now - e.created_at <= 7 * 86400),
        "by_interest": {k: sum(1 for e in entries if e.interest == k) for k in wl.INTERESTS},
        "daily_14d": days,
        "retention_days": int(wl._retention_seconds() // 86400),
        "consent_version": wl.CONSENT_VERSION,
        "items": [
            {
                "email": e.email if pii else _mask_email(e.email),
                "interest": e.interest,
                "consent_version": e.consent_version,
                "created_at": e.created_at,
            }
            for e in entries[:200]
        ],
    }


@router.get(
    "/waitlist/export",
    responses={200: {"content": {"text/csv": {}}, "description": "CSV (UTF-8)."}},
    response_class=StreamingResponse,
)
def waitlist_export(ctx: AdminContext = Depends(require(rbac.WAITLIST_EXPORT))) -> StreamingResponse:
    entries = wl.waitlist.all()
    ctx.audit("waitlist.export", details={"rows": len(entries)})
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["email", "interesse", "versao_consentimento", "inscrito_em_utc"])
    for e in entries:
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(e.created_at))
        writer.writerow([_csv_safe(v) for v in (e.email, e.interest, e.consent_version, ts)])
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="lusorbe-lista-espera.csv"', "Cache-Control": "no-store"},
    )


@router.post("/waitlist/delete")
def waitlist_delete(body: WaitlistDeleteBody, ctx: AdminContext = Depends(require_write(rbac.WAITLIST_DELETE))) -> s.Ok:  # type: ignore[return-value]
    removed = wl.waitlist.delete(body.email.strip().lower())
    ctx.audit("waitlist.delete", "success" if removed else "error", target=_email_ref(body.email), reason=body.reason)
    if not removed:
        raise HTTPException(404, "Esse email não está na lista.")
    return {"ok": True}
