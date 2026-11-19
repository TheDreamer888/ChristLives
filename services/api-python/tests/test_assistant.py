"""Assistente: só com conta, com consentimento, com limites e sem guardar conversas."""
import os

os.environ["ENV"] = "development"
os.environ.setdefault("SESSION_JWT_SECRET", "x" * 40)
os.environ["PUBLIC_FRONTEND_URL"] = "http://localhost:5173"

from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("SESSION_ENC_KEY", Fernet.generate_key().decode())

from src.app import assistant
from src.app.auth import routes as auth_routes
from src.app.auth.store import store
from src.app.auth.tokens import SESSION_COOKIE_NAME, issue_session_token

app = FastAPI()
app.include_router(assistant.router)
ORIGIN = {"Origin": "http://localhost:5173"}
ONE = {"messages": [{"role": "user", "content": "Como reconheço um email de phishing?"}], "consent": True}


class FakeMessages:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.reply = SimpleNamespace(
            stop_reason="end_turn", content=[SimpleNamespace(type="text", text="Verifica o remetente.")]
        )
        self.error: Exception | None = None

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.reply


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    monkeypatch.setenv("ASSISTANT_DAILY_LIMIT", "3")
    msgs = FakeMessages()
    assistant.set_client(SimpleNamespace(beta=SimpleNamespace(messages=msgs)))
    store.clear()
    auth_routes.limiter.clear()
    yield msgs
    assistant.set_client(None)


def _login(email="ana@example.com") -> TestClient:
    user = store.get_or_create_oauth_user("google", f"sub-{email}", email, "Ana", True)
    c = TestClient(app)
    c.cookies.set(SESSION_COOKIE_NAME, issue_session_token(user.id, ["oauth"]))
    return c


def test_exige_sessao(fake):
    r = TestClient(app).post("/api/assistant/messages", json=ONE, headers=ORIGIN)
    assert r.status_code == 401
    assert fake.calls == []


def test_exige_consentimento(fake):
    r = _login().post("/api/assistant/messages", json={**ONE, "consent": False}, headers=ORIGIN)
    assert r.status_code == 422
    assert fake.calls == []


def test_origem_estranha_bloqueada(fake):
    r = _login().post("/api/assistant/messages", json=ONE, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_responde_e_envia_so_o_necessario(fake):
    r = _login().post("/api/assistant/messages", json=ONE, headers=ORIGIN)
    assert r.status_code == 200, r.text
    assert r.json() == {"reply": "Verifica o remetente.", "refused": False}
    call = fake.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["messages"] == [{"role": "user", "content": ONE["messages"][0]["content"]}]
    assert call["fallbacks"] == "default"
    # O identificador enviado é um hash, nunca o email nem o id interno.
    assert "ana@example.com" not in str(call["metadata"])
    assert len(call["metadata"]["user_id"]) == 64


def test_limite_diario_por_conta(fake):
    c = _login()
    for _ in range(3):
        assert c.post("/api/assistant/messages", json=ONE, headers=ORIGIN).status_code == 200
    r = c.post("/api/assistant/messages", json=ONE, headers=ORIGIN)
    assert r.status_code == 429
    assert "Retry-After" in r.headers
    # Outra conta tem a sua própria quota.
    assert _login("rui@example.com").post("/api/assistant/messages", json=ONE, headers=ORIGIN).status_code == 200


def test_conversa_mal_formada(fake):
    c = _login()
    bad = {"messages": [{"role": "assistant", "content": "olá"}], "consent": True}
    assert c.post("/api/assistant/messages", json=bad, headers=ORIGIN).status_code == 422
    seguidas = {"messages": [{"role": "user", "content": "a"}, {"role": "user", "content": "b"}], "consent": True}
    assert c.post("/api/assistant/messages", json=seguidas, headers=ORIGIN).status_code == 422
    longa = {"messages": [{"role": "user", "content": "x" * 4001}], "consent": True}
    assert c.post("/api/assistant/messages", json=longa, headers=ORIGIN).status_code == 422
    assert fake.calls == []


def test_recusa_devolve_mensagem_clara(fake):
    fake.reply = SimpleNamespace(stop_reason="refusal", content=[])
    r = _login().post("/api/assistant/messages", json=ONE, headers=ORIGIN)
    assert r.status_code == 200
    assert r.json()["refused"] is True


def test_desligado_sem_chave(fake, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    c = _login()
    assert c.get("/api/assistant/status").json()["enabled"] is False
    assert c.post("/api/assistant/messages", json=ONE, headers=ORIGIN).status_code == 503


def test_erro_do_fornecedor_nao_expoe_detalhes(fake):
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    fake.error = anthropic.APIConnectionError(request=req)
    r = _login().post("/api/assistant/messages", json=ONE, headers=ORIGIN)
    assert r.status_code == 502
    assert "anthropic.com" not in r.text
