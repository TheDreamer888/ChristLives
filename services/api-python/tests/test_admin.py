"""Testes da consola de administração (RBAC, auditoria, duas pessoas)."""
import os

os.environ["ENV"] = "development"
os.environ.setdefault("SESSION_JWT_SECRET", "x" * 40)
os.environ["PUBLIC_FRONTEND_URL"] = "http://localhost:5173"

import time

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ["SESSION_ENC_KEY"] = Fernet.generate_key().decode()

from src.app.admin import routes as admin_routes
from src.app.admin.approvals import approvals
from src.app.admin.audit import AuditLog, audit_log
from src.app.auth import routes as auth_routes
from src.app.auth.store import store
from src.app.auth.tokens import SESSION_COOKIE_NAME, issue_session_token

app = FastAPI()
app.include_router(auth_routes.router)
app.include_router(admin_routes.router)

ORIGIN = {"Origin": "http://localhost:5173"}
REASON = "Pedido do ticket SEC-1234 aprovado"


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    for var in ("ADMIN_IP_ALLOWLIST", "ADMIN_BOOTSTRAP_EMAILS", "ADMIN_REQUIRE_PASSKEY", "ADMIN_TWO_PERSON_RULE"):
        monkeypatch.delenv(var, raising=False)
    store.clear()
    auth_routes.limiter.clear()
    audit_log.clear()
    approvals.clear()
    yield


def _user(sub, roles=(), email=None):
    user = store.get_or_create_oauth_user("google", sub, email or f"{sub}@example.com", sub.upper(), True)
    user.roles = set(roles)
    return user


def _client(user, method="passkey", age=0):
    client = TestClient(app)
    token = issue_session_token(user.id, [method])
    if age:
        # recria o token com iat no passado
        import jwt as pyjwt

        from src.app.auth import tokens

        claims = {"sub": user.id, "amr": [method], "jti": "t", "iat": int(time.time()) - age, "exp": int(time.time()) + 3600}
        signed = pyjwt.encode(claims, tokens._signing_key(), algorithm="HS256")
        token = tokens._fernet().encrypt(signed.encode()).decode()
    client.cookies.set(SESSION_COOKIE_NAME, token)
    return client


def test_non_staff_gets_404_and_anonymous_401():
    assert TestClient(app).get("/api/admin/me").status_code == 401
    assert _client(_user("plain")).get("/api/admin/me").status_code == 404


def test_admin_requires_passkey_login():
    owner = _user("own", ["owner"])
    r = _client(owner, method="google").get("/api/admin/me")
    assert r.status_code == 403
    assert audit_log.entries()[-1].details["why"] == "passkey_required"
    assert _client(owner).get("/api/admin/me").json()["roles"] == ["owner"]


def test_admin_session_expires_after_max_age():
    owner = _user("own", ["owner"])
    assert _client(owner, age=4000).get("/api/admin/me").status_code == 401


def test_ip_allowlist(monkeypatch):
    owner = _user("own", ["owner"])
    monkeypatch.setenv("ADMIN_IP_ALLOWLIST", "10.0.0.0/8")
    assert _client(owner).get("/api/admin/me").status_code == 403  # o TestClient não está em 10/8
    assert audit_log.entries()[-1].details["why"] == "ip_not_allowed"


def test_support_sees_masked_emails_and_cannot_write():
    support = _user("sup", ["support"])
    _user("victim", email="victim@example.com")
    client = _client(support)
    items = client.get("/api/admin/users").json()["items"]
    emails = {u["email"] for u in items}
    assert "v***@example.com" in emails and "victim@example.com" not in emails
    target = store.find_by_email("victim@example.com").id
    r = client.post(f"/api/admin/users/{target}/suspend", json={"reason": REASON}, headers=ORIGIN)
    assert r.status_code == 403
    assert audit_log.entries()[-1].outcome == "denied"


def test_suspend_kills_sessions_and_blocks_login():
    admin = _user("adm", ["admin"])
    victim = _user("vic")
    victim_client = _client(victim)
    assert victim_client.get("/api/auth/session").json()["id"] == victim.id
    r = _client(admin).post(f"/api/admin/users/{victim.id}/suspend", json={"reason": REASON}, headers=ORIGIN)
    assert r.status_code == 200
    assert victim_client.get("/api/auth/session").json() is None
    entry = audit_log.entries()[-1]
    assert (entry.action, entry.target, entry.reason) == ("user.suspend", victim.id, REASON)


def test_reason_is_mandatory_and_origin_checked():
    admin = _user("adm", ["admin"])
    victim = _user("vic")
    client = _client(admin)
    assert client.post(f"/api/admin/users/{victim.id}/suspend", json={"reason": "x"}, headers=ORIGIN).status_code == 422
    bad = {"Origin": "https://evil.example"}
    assert client.post(f"/api/admin/users/{victim.id}/suspend", json={"reason": REASON}, headers=bad).status_code == 403


def test_step_up_required_for_writes():
    admin = _user("adm", ["admin"])
    victim = _user("vic")
    client = _client(admin, age=auth_routes._STEP_UP_SECONDS + 60)
    assert client.get("/api/admin/me").status_code == 200  # leitura ainda dentro de 1 h
    r = client.post(f"/api/admin/users/{victim.id}/suspend", json={"reason": REASON}, headers=ORIGIN)
    assert r.status_code == 403


def test_cannot_act_on_self_or_admin_on_privileged():
    admin = _user("adm", ["admin"])
    other_admin = _user("adm2", ["admin"])
    client = _client(admin)
    assert client.post(f"/api/admin/users/{admin.id}/suspend", json={"reason": REASON}, headers=ORIGIN).status_code == 403
    r = client.post(f"/api/admin/users/{other_admin.id}/suspend", json={"reason": REASON}, headers=ORIGIN)
    assert r.status_code == 403


def test_last_owner_protected():
    owner = _user("own", ["owner"])
    owner2 = _user("own2", ["owner"])
    client = _client(owner)
    assert client.post(f"/api/admin/users/{owner2.id}/suspend", json={"reason": REASON}, headers=ORIGIN).status_code == 200
    # agora só resta um proprietário activo: own2 não pode tirar o owner a own (e own não pode a si mesmo)
    r = client.post(f"/api/admin/users/{owner.id}/roles", json={"roles": [], "reason": REASON}, headers=ORIGIN)
    assert r.status_code == 403  # self


def test_privileged_role_needs_second_person():
    admin = _user("adm", ["admin"])
    owner = _user("own", ["owner"])
    target = _user("tgt")
    r = _client(admin).post(
        f"/api/admin/users/{target.id}/roles", json={"roles": ["admin", "support"], "reason": REASON}, headers=ORIGIN
    )
    body = r.json()
    assert r.status_code == 200 and len(body["pending_approvals"]) == 1
    assert target.roles == {"support"}  # o não privilegiado aplica-se já

    req_id = body["pending_approvals"][0]
    # quem pede não aprova
    r = _client(admin).post(f"/api/admin/approvals/{req_id}/decide", json={"approve": True}, headers=ORIGIN)
    assert r.status_code == 403
    r = _client(owner).post(f"/api/admin/approvals/{req_id}/decide", json={"approve": True}, headers=ORIGIN)
    assert r.status_code == 200
    assert target.roles == {"admin", "support"}
    # não pode decidir duas vezes
    r = _client(owner).post(f"/api/admin/approvals/{req_id}/decide", json={"approve": True}, headers=ORIGIN)
    assert r.status_code == 409


def test_owner_cannot_self_approve_own_request():
    owner = _user("own", ["owner"])
    target = _user("tgt")
    r = _client(owner).post(f"/api/admin/users/{target.id}/roles", json={"roles": ["owner"], "reason": REASON}, headers=ORIGIN)
    req_id = r.json()["pending_approvals"][0]
    r = _client(owner).post(f"/api/admin/approvals/{req_id}/decide", json={"approve": True}, headers=ORIGIN)
    assert r.status_code == 403
    assert "owner" not in target.roles


def test_role_change_invalidates_target_sessions():
    owner = _user("own", ["owner"])
    target = _user("tgt", ["support"])
    target_client = _client(target)
    assert target_client.get("/api/admin/me").status_code == 200
    _client(owner).post(f"/api/admin/users/{target.id}/roles", json={"roles": ["auditor"], "reason": REASON}, headers=ORIGIN)
    assert target_client.get("/api/admin/me").status_code == 401


def test_bootstrap_first_owner_only_once(monkeypatch):
    monkeypatch.setenv("ADMIN_BOOTSTRAP_EMAILS", "boss@example.com,second@example.com")
    boss = _user("boss", email="boss@example.com")
    second = _user("second", email="second@example.com")
    assert _client(boss).get("/api/admin/me").json()["roles"] == ["owner"]
    assert _client(second).get("/api/admin/me").status_code == 404  # já existe proprietário
    assert audit_log.entries()[0].action == "admin.bootstrap_owner"


def test_audit_chain_detects_tampering_and_export_is_safe():
    owner = _user("own", ["owner"])
    victim = _user("vic")
    client = _client(owner)
    client.post(f"/api/admin/users/{victim.id}/suspend", json={"reason": "=HYPERLINK(evil) ticket 1"}, headers=ORIGIN)
    assert client.get("/api/admin/audit/verify").json()["valid"] is True
    csv_text = client.get("/api/admin/audit/export").text
    assert "'=HYPERLINK" in csv_text
    audit_log.entries()  # cópia
    audit_log._entries[0].reason = "editado"
    result = client.get("/api/admin/audit/verify").json()
    assert result == {"valid": False, "checked": 0, "total": result["total"], "broken_at": 1}


def test_audit_log_unit():
    log = AuditLog(key=b"k" * 32)
    for i in range(3):
        log.record("x", "success", "u", details={"i": i})
    assert log.verify()["valid"]
    del log._entries[1]
    assert log.verify() == {"valid": False, "checked": 1, "total": 2, "broken_at": 3}


def test_security_posture_and_overview():
    owner = _user("own", ["owner"])
    client = _client(owner)
    posture = client.get("/api/admin/security").json()
    assert 0 <= posture["score"] <= 100
    assert any(c["id"] == "passkey_required" and c["ok"] for c in posture["checks"])
    ov = client.get("/api/admin/overview").json()
    assert ov["users_total"] == 1 and ov["staff"]["owner"] == 1
    assert client.get("/api/admin/me").headers["cache-control"] == "no-store"
