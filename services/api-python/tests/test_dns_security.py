"""As rotas de DNS controlam o domínio: só proprietários, com auditoria e ids validados."""
import os

os.environ["ENV"] = "development"
os.environ.setdefault("SESSION_JWT_SECRET", "x" * 40)
os.environ["PUBLIC_FRONTEND_URL"] = "http://localhost:5173"

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("SESSION_ENC_KEY", Fernet.generate_key().decode())

from src.app.admin.audit import audit_log
from src.app.auth import routes as auth_routes
from src.app.auth.store import store
from src.app.auth.tokens import SESSION_COOKIE_NAME, issue_session_token
from src.app.config import settings
from src.app.routers import dns

app = FastAPI()
app.include_router(dns.router)
ORIGIN = {"Origin": "http://localhost:5173"}
REASON = "Mudança de servidor pedida no ticket OPS-7"
VALID_ID = "0123456789abcdef0123456789abcdef"


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    store.clear()
    audit_log.clear()
    auth_routes.limiter.clear()
    # Sem Cloudflare configurada: um pedido autorizado chega ao 503 "não configurado".
    monkeypatch.setattr(settings, "cloudflare_api_token", None)
    monkeypatch.setattr(settings, "cloudflare_zone_id", None)
    yield


def _client(roles=(), method="passkey"):
    c = TestClient(app)
    user = store.get_or_create_oauth_user("google", f"u-{'-'.join(roles) or 'x'}", f"{roles[0] if roles else 'x'}@ex.pt", "U", True)
    user.roles = set(roles)
    store.save(user)
    c.cookies.set(SESSION_COOKIE_NAME, issue_session_token(user.id, [method]))
    return c


def test_anonymous_cannot_touch_dns():
    c = TestClient(app)
    assert c.get("/api/dns/records").status_code == 401
    r = c.post("/api/dns/records", json={"type": "A", "name": "x.ex.pt", "content": "1.2.3.4", "reason": REASON}, headers=ORIGIN)
    assert r.status_code == 401


def test_regular_user_and_non_owner_staff_are_refused():
    assert _client().get("/api/dns/records").status_code == 404  # sem função de staff
    assert _client(["admin"]).get("/api/dns/records").status_code == 403  # admin não chega
    assert _client(["support"]).get("/api/dns/records").status_code == 403


def test_owner_needs_passkey():
    assert _client(["owner"], method="google").get("/api/dns/records").status_code == 403


def test_owner_with_passkey_passes_auth():
    assert _client(["owner"]).get("/api/dns/records").status_code == 503  # chegou à Cloudflare (não configurada)


def test_writes_need_reason():
    r = _client(["owner"]).post("/api/dns/records", json={"type": "A", "name": "x.ex.pt", "content": "1.2.3.4"}, headers=ORIGIN)
    assert r.status_code == 422


def test_record_id_cannot_escape_to_other_cloudflare_endpoints():
    c = _client(["owner"])
    for bad in ["..%2F..%2Fuser%2Ftokens", "abc", "0123456789ABCDEF0123456789ABCDEF", VALID_ID + "/x"]:
        r = c.patch(f"/api/dns/records/{bad}", json={"content": "1.2.3.4", "reason": REASON}, headers=ORIGIN)
        assert r.status_code in (404, 422), bad
    r = c.patch(f"/api/dns/records/{VALID_ID}", json={"content": "1.2.3.4", "reason": REASON}, headers=ORIGIN)
    assert r.status_code == 503  # formato válido: segue para a Cloudflare


def test_denied_attempts_are_audited():
    _client(["admin"]).get("/api/dns/records")
    entry = audit_log.entries()[-1]
    assert entry.outcome == "denied" and entry.details["permission"] == "dns.manage"
