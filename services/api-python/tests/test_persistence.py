"""Persistência em SQL (SQLite): os dados sobrevivem a reinícios e a
concorrência otimista impede escritas perdidas entre instâncias."""
import os

os.environ["ENV"] = "development"
os.environ.setdefault("SESSION_JWT_SECRET", "x" * 40)
os.environ["PUBLIC_FRONTEND_URL"] = "http://localhost:5173"

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, update

os.environ.setdefault("SESSION_ENC_KEY", Fernet.generate_key().decode())

from src.app import db
from src.app.admin import routes as admin_routes
from src.app.admin.approvals import ApprovalConflict, SqlApprovalQueue
from src.app.admin.audit import SqlAuditLog
from src.app.auth import routes as auth_routes
from src.app.auth.store import ConcurrentUpdate, SqlStore
from src.app.auth.tokens import SESSION_COOKIE_NAME, issue_session_token

ORIGIN = {"Origin": "http://localhost:5173"}
REASON = "Ticket SEC-1 conta comprometida"


@pytest.fixture(params=["sqlite", "postgres"])
def engine(request, tmp_path):
    if request.param == "sqlite":
        eng = create_engine(f"sqlite:///{tmp_path / 'aegis.db'}")
    else:
        url = os.getenv("TEST_DATABASE_URL")
        if not url:
            pytest.skip("TEST_DATABASE_URL não definido (o CI corre isto contra Postgres)")
        eng = create_engine(url.replace("postgresql://", "postgresql+psycopg://", 1))
        db.metadata.drop_all(eng)
    db.metadata.create_all(eng)
    yield eng
    eng.dispose()


def test_user_survives_restart_with_passkey_bytes(engine):
    store = SqlStore(engine)
    user = store.get_or_create_oauth_user("google", "g-1", "a@example.com", "A", True)
    user.webauthn_credentials["cred"] = {"public_key": b"\x00\x01binary", "sign_count": 3, "label": "YubiKey"}
    user.roles.add("auditor")
    store.save(user)

    restarted = SqlStore(engine)  # nova instância, mesma base de dados
    again = restarted.find_by_email("a@example.com")
    assert again.id == user.id
    assert again.webauthn_credentials["cred"]["public_key"] == b"\x00\x01binary"
    assert again.roles == {"auditor"} and again.linked_methods == {"google"}
    # mesma identidade OAuth → mesma conta
    assert restarted.get_or_create_oauth_user("google", "g-1", None, None, False).id == user.id


def test_unverified_email_never_links(engine):
    store = SqlStore(engine)
    victim = store.get_or_create_oauth_user("google", "g-1", "v@example.com", "V", True)
    attacker = store.get_or_create_oauth_user("github", "h-1", "v@example.com", "X", False)
    assert attacker.id != victim.id and attacker.email is None


def test_optimistic_locking_blocks_lost_update(engine):
    a, b = SqlStore(engine), SqlStore(engine)  # duas instâncias da API
    user = a.get_or_create_oauth_user("google", "g-1", "a@example.com", "A", True)
    user.backup_code_hashes = ["h1", "h2"]
    a.save(user)

    copy_a, copy_b = a.get_user(user.id), b.get_user(user.id)
    copy_a.backup_code_hashes.pop(0)
    a.save(copy_a)
    copy_b.backup_code_hashes.pop(0)  # o mesmo código consumido na outra instância
    with pytest.raises(ConcurrentUpdate):
        b.save(copy_b)
    assert a.get_user(user.id).backup_code_hashes == ["h2"]


def test_challenges_are_single_use_across_instances(engine):
    a, b = SqlStore(engine), SqlStore(engine)
    a.webauthn_challenges.set("c1", ("user-1", b"\xffchallenge"))
    assert b.webauthn_challenges.pop("c1") == ("user-1", b"\xffchallenge")
    assert a.webauthn_challenges.pop("c1") is None


def test_audit_chain_in_database_detects_tampering(engine):
    key = b"k" * 32
    log = SqlAuditLog(engine, key=key)
    for i in range(3):
        log.record("user.suspend", "success", "admin", target=f"u{i}", reason="motivo de teste")
    assert SqlAuditLog(engine, key=key).verify()["valid"]  # depois de "reiniciar"
    with engine.begin() as conn:
        conn.execute(update(db.audit_log).where(db.audit_log.c.seq == 2).values(reason="apagado"))
    assert log.verify() == {"valid": False, "checked": 1, "total": 3, "broken_at": 2}


def test_two_instances_interleave_audit_without_breaking_chain(engine):
    key = b"k" * 32
    a, b = SqlAuditLog(engine, key=key), SqlAuditLog(engine, key=key)
    for i in range(5):
        (a if i % 2 else b).record("x", "success", "u", details={"i": i})
    result = a.verify()
    assert result["valid"] and result["total"] == 5


def test_approval_cannot_be_decided_twice(engine):
    a, b = SqlApprovalQueue(engine), SqlApprovalQueue(engine)
    req = a.create("target", "admin", "requester", "pedido com justificação")
    first, second = a.get(req.id), b.get(req.id)
    first.status = "approved"
    a.save(first)
    second.status = "rejected"
    with pytest.raises(ApprovalConflict):
        b.save(second)
    assert b.get(req.id).status == "approved"


def test_admin_flow_persists_end_to_end(engine, monkeypatch):
    store = SqlStore(engine)
    audit = SqlAuditLog(engine, key=b"k" * 32)
    monkeypatch.setattr(auth_routes, "store", store)
    monkeypatch.setattr(admin_routes, "store", store)
    monkeypatch.setattr(admin_routes, "audit_log", audit)
    monkeypatch.setattr(admin_routes, "approvals", SqlApprovalQueue(engine))
    auth_routes.limiter._hits.clear()

    app = FastAPI()
    app.include_router(auth_routes.router)
    app.include_router(admin_routes.router)

    owner = store.get_or_create_oauth_user("google", "o", "owner@example.com", "O", True)
    owner.roles = {"owner"}
    store.save(owner)
    victim = store.get_or_create_oauth_user("google", "v", "victim@example.com", "V", True)

    def client_for(user):
        c = TestClient(app)
        c.cookies.set(SESSION_COOKIE_NAME, issue_session_token(user.id, ["passkey"]))
        return c

    victim_client = client_for(victim)
    assert victim_client.get("/api/auth/session").json()["id"] == victim.id
    r = client_for(owner).post(f"/api/admin/users/{victim.id}/suspend", json={"reason": REASON}, headers=ORIGIN)
    assert r.status_code == 200

    # "Reinício": novas instâncias leem o estado da base de dados.
    restarted = SqlStore(engine)
    assert restarted.get_user(victim.id).suspended is True
    monkeypatch.setattr(auth_routes, "store", restarted)
    assert victim_client.get("/api/auth/session").json() is None
    entries = SqlAuditLog(engine, key=b"k" * 32).entries()
    assert [e.action for e in entries] == ["user.suspend"] and entries[0].reason == REASON
