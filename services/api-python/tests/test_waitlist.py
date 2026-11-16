"""Lista de espera: RGPD, anti-spam, anti-enumeração e gestão no admin."""
import os

os.environ["ENV"] = "development"
os.environ.setdefault("SESSION_JWT_SECRET", "x" * 40)
os.environ["PUBLIC_FRONTEND_URL"] = "http://localhost:5173"

import time

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

os.environ.setdefault("SESSION_ENC_KEY", Fernet.generate_key().decode())

from src.app import db
from src.app import waitlist as wl
from src.app.admin import routes as admin_routes
from src.app.admin.audit import audit_log
from src.app.auth import routes as auth_routes
from src.app.auth.store import store
from src.app.auth.tokens import SESSION_COOKIE_NAME, issue_session_token

app = FastAPI()
app.include_router(wl.router)
app.include_router(admin_routes.router)
ORIGIN = {"Origin": "http://localhost:5173"}


@pytest.fixture(autouse=True)
def _clean():
    wl.waitlist.clear()
    store.clear()
    audit_log.clear()
    auth_routes.limiter.clear()
    yield


def _join(client, email="ana@example.com", **kw):
    body = {"email": email, "interest": "escolas", "consent": True, **kw}
    return client.post("/api/waitlist", json=body, headers=ORIGIN)


def _staff(roles):
    user = store.get_or_create_oauth_user("google", f"s-{'-'.join(roles)}", f"{roles[0]}@aegis.pt", "S", True)
    user.roles = set(roles)
    store.save(user)
    c = TestClient(app)
    c.cookies.set(SESSION_COOKIE_NAME, issue_session_token(user.id, ["passkey"]))
    return c


def test_join_stores_only_minimum_data():
    r = _join(TestClient(app), email="  Ana@Example.com ")
    assert r.status_code == 202
    [entry] = wl.waitlist.all()
    assert entry.email == "ana@example.com"
    assert set(entry.__dict__) == {"email", "interest", "consent_version", "created_at"}  # sem IP nem rastreio


def test_consent_is_mandatory():
    assert _join(TestClient(app), consent=False).status_code == 422
    assert wl.waitlist.all() == []


def test_duplicate_and_bot_get_identical_response():
    c = TestClient(app)
    first = _join(c).json()
    again = _join(c).json()
    bot = _join(c, email="bot@spam.example", website="http://spam").json()
    assert first == again == bot
    assert [e.email for e in wl.waitlist.all()] == ["ana@example.com"]  # o bot não ficou


def test_rate_limit_per_ip():
    c = TestClient(app)
    codes = [_join(c, email=f"p{i}@example.com").status_code for i in range(6)]
    assert codes[:5] == [202] * 5 and codes[5] == 429


def test_foreign_origin_rejected():
    r = TestClient(app).post(
        "/api/waitlist", json={"email": "a@example.com", "consent": True}, headers={"Origin": "https://evil.example"}
    )
    assert r.status_code == 403


def test_retention_purges_old_entries(monkeypatch):
    wl.waitlist.add(wl.Entry("old@example.com", "outro", "v0", time.time() - 400 * 86400))
    _join(TestClient(app))
    assert [e.email for e in wl.waitlist.all()] == ["ana@example.com"]


def test_admin_sees_masked_for_support_and_full_for_admin():
    _join(TestClient(app))
    support = _staff(["support"]).get("/api/admin/waitlist").json()
    assert support["items"][0]["email"] == "a***@example.com"
    assert support["by_interest"]["escolas"] == 1 and support["total"] == 1
    admin = _staff(["admin"]).get("/api/admin/waitlist").json()
    assert admin["items"][0]["email"] == "ana@example.com"


def test_export_needs_permission_and_is_audited():
    _join(TestClient(app), email="=cmd@example.com")
    assert _staff(["support"]).get("/api/admin/waitlist/export").status_code == 403
    r = _staff(["owner"]).get("/api/admin/waitlist/export")
    assert r.status_code == 200 and "'=cmd@example.com" in r.text  # sem injeção de fórmulas
    assert audit_log.entries()[-1].action == "waitlist.export"


def test_erasure_is_audited_without_storing_the_email():
    _join(TestClient(app))
    owner = _staff(["owner"])
    r = owner.post(
        "/api/admin/waitlist/delete",
        json={"email": "ana@example.com", "reason": "Pedido de apagamento RGPD por email"},
        headers=ORIGIN,
    )
    assert r.status_code == 200 and wl.waitlist.all() == []
    entry = audit_log.entries()[-1]
    assert entry.action == "waitlist.delete" and entry.target.startswith("wl:")
    assert "ana@example.com" not in str(entry.__dict__)


def test_sql_waitlist(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'w.db'}")
    db.metadata.create_all(engine)
    store_ = wl.SqlWaitlist(engine)
    assert store_.add(wl.Entry("a@example.com", "familias", "v1", time.time()))
    assert not store_.add(wl.Entry("a@example.com", "outro", "v1", time.time()))  # sem duplicados
    assert wl.SqlWaitlist(engine).all()[0].interest == "familias"  # sobrevive a reinício
    assert store_.delete("a@example.com") and store_.all() == []
