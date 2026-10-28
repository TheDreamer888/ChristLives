"""Testes do middleware de firewall com uma app mínima."""
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from src.app import firewall
from src.app.firewall import FirewallMiddleware


def make_client(production: bool = False) -> TestClient:
    app = FastAPI()

    @app.get("/ok")
    def ok():
        return {"ok": True}

    @app.post("/echo")
    async def echo(request: Request):
        return {"size": len(await request.body())}

    @app.get("/secret")
    def secret():
        raise HTTPException(401, "não")

    app.add_middleware(FirewallMiddleware, production=production)
    return TestClient(app)


def test_security_headers_present():
    r = make_client().get("/ok")
    assert r.status_code == 200
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert "strict-transport-security" not in r.headers


def test_hsts_in_production():
    assert "strict-transport-security" in make_client(production=True).get("/ok").headers


def test_probe_paths_blocked_and_lead_to_ban(monkeypatch):
    monkeypatch.setattr(firewall, "STRIKE_LIMIT", 10)
    c = make_client()
    assert c.get("/.env").status_code == 404
    assert c.get("/wp-admin/setup.php").status_code == 404  # 2 sondagens x 5 = ban
    r = c.get("/ok")
    assert r.status_code == 403


def test_rate_limit(monkeypatch):
    monkeypatch.setattr(firewall, "RATE_LIMIT", 3)
    c = make_client()
    codes = [c.get("/ok").status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


def test_body_too_large_by_content_length(monkeypatch):
    monkeypatch.setattr(firewall, "MAX_BODY_BYTES", 10)
    c = make_client()
    assert c.post("/echo", content=b"x" * 5).json() == {"size": 5}
    assert c.post("/echo", content=b"x" * 50).status_code == 413


def test_body_too_large_streamed(monkeypatch):
    monkeypatch.setattr(firewall, "MAX_BODY_BYTES", 10)
    c = make_client()

    def chunks():
        yield b"x" * 8
        yield b"x" * 8

    assert c.post("/echo", content=chunks()).status_code == 413


def test_repeated_auth_failures_ban(monkeypatch):
    monkeypatch.setattr(firewall, "STRIKE_LIMIT", 3)
    c = make_client()
    for _ in range(3):
        assert c.get("/secret").status_code == 401
    assert c.get("/ok").status_code == 403
