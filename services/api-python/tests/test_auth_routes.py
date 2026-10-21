"""Testes das rotas de autenticação (store em memória, sem rede)."""
import os
import time

os.environ["ENV"] = "development"  # cookies sem Secure para o TestClient (http)
os.environ.setdefault("SESSION_JWT_SECRET", "x" * 40)
os.environ.setdefault("SESSION_ENC_KEY", "ZmFrZS1rZXktZm9yLXRlc3RzLW9ubHktMzItYnl0ZXM=")
os.environ["PUBLIC_FRONTEND_URL"] = "http://localhost:5173"

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ["SESSION_ENC_KEY"] = Fernet.generate_key().decode()

from src.app.auth import routes
from src.app.auth.ratelimit import RateLimiter
from src.app.auth.recovery import generate_backup_codes
from src.app.auth.store import store
from src.app.auth.tokens import SESSION_COOKIE_NAME, issue_session_token

app = FastAPI()
app.include_router(routes.router)


@pytest.fixture(autouse=True)
def _clean():
    store.users.clear()
    store.email_index.clear()
    store.oauth_index.clear()
    routes.limiter._hits.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


def _user_with_codes(email="a@example.com"):
    user = store.get_or_create_oauth_user("google", "sub-1", email, "A", email_verified=True)
    plaintext, hashes = generate_backup_codes(2)
    user.backup_code_hashes = hashes
    return user, plaintext


def test_unverified_email_does_not_take_over_account():
    victim = store.get_or_create_oauth_user("google", "g-1", "v@example.com", "V", True)
    attacker = store.get_or_create_oauth_user("microsoft", "m-1", "v@example.com", "X", False)
    assert attacker.id != victim.id
    assert attacker.email is None
    # mesmo subject volta à mesma conta
    again = store.get_or_create_oauth_user("microsoft", "m-1", None, None, False)
    assert again.id == attacker.id


def test_verified_email_links_to_existing_account():
    first = store.get_or_create_oauth_user("google", "g-1", "v@example.com", "V", True)
    second = store.get_or_create_oauth_user("github", "42", "v@example.com", "V", True)
    assert first.id == second.id
    assert {"google", "github"} <= second.linked_methods


def test_redeem_is_one_time_and_generic_errors(client):
    user, codes = _user_with_codes()
    ok = client.post("/api/auth/recovery/backup-codes/redeem", json={"email": "a@example.com", "code": codes[0]})
    assert ok.status_code == 200 and ok.json()["remaining_codes"] == 1
    assert SESSION_COOKIE_NAME in ok.cookies
    reuse = client.post("/api/auth/recovery/backup-codes/redeem", json={"email": "a@example.com", "code": codes[0]})
    unknown = client.post("/api/auth/recovery/backup-codes/redeem", json={"email": "nobody@example.com", "code": "aaaa-bbbb"})
    assert reuse.status_code == unknown.status_code == 400
    assert reuse.json() == unknown.json()  # sem enumeração


def test_redeem_rate_limited_per_account(client):
    _user_with_codes()
    statuses = [
        client.post("/api/auth/recovery/backup-codes/redeem", json={"email": "a@example.com", "code": "bad-code1"}).status_code
        for _ in range(7)
    ]
    assert statuses[:5] == [400] * 5
    assert statuses[5] == 429


def test_credentials_not_accepted_in_query_string(client):
    r = client.post("/api/auth/recovery/backup-codes/redeem?email=a@example.com&code=aaaa-bbbb")
    assert r.status_code == 422


def test_login_options_same_shape_for_known_and_unknown(client):
    _user_with_codes()
    known = client.post("/api/auth/webauthn/login/options", json={"email": "a@example.com"})
    unknown = client.post("/api/auth/webauthn/login/options", json={"email": "ghost@example.com"})
    assert known.status_code == unknown.status_code == 200
    import json

    k, u = json.loads(known.json()["options"]), json.loads(unknown.json()["options"])
    assert len(k["allowCredentials"]) == len(u["allowCredentials"]) == 1


def test_step_up_blocks_stale_session(client, monkeypatch):
    user, _ = _user_with_codes()
    token = issue_session_token(user.id, list(user.linked_methods))
    client.cookies.set(SESSION_COOKIE_NAME, token)
    assert client.post("/api/auth/recovery/backup-codes/generate").status_code == 200

    real_time = time.time
    monkeypatch.setattr(routes.time, "time", lambda: real_time() + routes._STEP_UP_SECONDS + 60)
    assert client.post("/api/auth/recovery/backup-codes/generate").status_code == 403


def test_cross_origin_write_rejected(client):
    r = client.post(
        "/api/auth/logout",
        headers={"Origin": "https://evil.example"},
    )
    assert r.status_code == 403
    assert client.post("/api/auth/logout", headers={"Origin": "http://localhost:5173"}).status_code == 200


def test_oauth_callback_errors_clear_flow_cookie(client):
    client.cookies.set("oauth_flow", "google:abc:verifier")
    r = client.get("/api/auth/oauth/google/callback", params={"error": "access_denied"})
    assert r.status_code == 400
    assert "oauth_flow=" in r.headers["set-cookie"] and "Max-Age=0" in r.headers["set-cookie"]
    bad = client.get("/api/auth/oauth/google/callback", params={"code": "c", "state": "wrong"})
    assert bad.status_code == 400


def test_rate_limiter_window():
    rl = RateLimiter()
    assert all(rl.hit("k", 2, 60) is None for _ in range(2))
    assert isinstance(rl.hit("k", 2, 60), int)
    assert rl.hit("other", 2, 60) is None
