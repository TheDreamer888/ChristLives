"""Funções e permissões da consola de administração (RBAC, menor privilégio).

Cada função dá só as permissões de que precisa. As funções privilegiadas
(owner/admin) só se atribuem com a regra das duas pessoas (ver approvals.py).
"""
from __future__ import annotations

from dataclasses import dataclass

# Permissões granulares --------------------------------------------------------
USERS_READ = "users.read"
USERS_READ_PII = "users.read_pii"  # ver emails completos
USERS_SUSPEND = "users.suspend"
USERS_REVOKE_SESSIONS = "users.revoke_sessions"
ROLES_ASSIGN = "roles.assign"  # funções não privilegiadas
ROLES_REQUEST_PRIVILEGED = "roles.request_privileged"
APPROVALS_DECIDE = "approvals.decide"
AUDIT_READ = "audit.read"
AUDIT_EXPORT = "audit.export"
SECURITY_READ = "security.read"
WAITLIST_EXPORT = "waitlist.export"  # emails completos em CSV
WAITLIST_DELETE = "waitlist.delete"  # direito ao apagamento (RGPD art. 17)

ALL_PERMISSIONS = frozenset(
    {
        USERS_READ,
        USERS_READ_PII,
        USERS_SUSPEND,
        USERS_REVOKE_SESSIONS,
        ROLES_ASSIGN,
        ROLES_REQUEST_PRIVILEGED,
        APPROVALS_DECIDE,
        AUDIT_READ,
        AUDIT_EXPORT,
        SECURITY_READ,
        WAITLIST_EXPORT,
        WAITLIST_DELETE,
    }
)


@dataclass(frozen=True)
class Role:
    id: str
    label: str
    description: str
    permissions: frozenset[str]
    privileged: bool = False


ROLES: dict[str, Role] = {
    r.id: r
    for r in (
        Role(
            "owner",
            "Proprietário",
            "Controlo total. Aprova a atribuição de funções privilegiadas.",
            ALL_PERMISSIONS,
            privileged=True,
        ),
        Role(
            "admin",
            "Administrador",
            "Gere utilizadores e funções não privilegiadas. Pede elevações.",
            frozenset(
                {
                    USERS_READ,
                    USERS_READ_PII,
                    USERS_SUSPEND,
                    USERS_REVOKE_SESSIONS,
                    ROLES_ASSIGN,
                    ROLES_REQUEST_PRIVILEGED,
                    AUDIT_READ,
                    SECURITY_READ,
                    WAITLIST_EXPORT,
                    WAITLIST_DELETE,
                }
            ),
            privileged=True,
        ),
        Role(
            "security_analyst",
            "Analista de segurança",
            "Investiga incidentes, revoga sessões e exporta a auditoria.",
            frozenset({USERS_READ, USERS_REVOKE_SESSIONS, AUDIT_READ, AUDIT_EXPORT, SECURITY_READ}),
        ),
        Role(
            "support",
            "Suporte",
            "Consulta contas com emails mascarados. Não altera nada.",
            frozenset({USERS_READ}),
        ),
        Role(
            "auditor",
            "Auditor",
            "Só leitura da auditoria e da postura de segurança.",
            frozenset({AUDIT_READ, AUDIT_EXPORT, SECURITY_READ}),
        ),
    )
}

PRIVILEGED_ROLES = frozenset(r.id for r in ROLES.values() if r.privileged)


def permissions_for(roles: set[str] | frozenset[str]) -> frozenset[str]:
    perms: set[str] = set()
    for role_id in roles:
        role = ROLES.get(role_id)
        if role:
            perms |= role.permissions
    return frozenset(perms)


def is_staff(roles: set[str]) -> bool:
    return any(r in ROLES for r in roles)
