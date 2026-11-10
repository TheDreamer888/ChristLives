from __future__ import annotations

import base64
import hashlib
import time
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

import httpx
from cryptography.fernet import Fernet
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from src.app.auth import mail_connectors as mc
from src.app.routers import mailbox
from src.app.routers import organize as organize_module

FRONTEND = "http://localhost:5173"


def _client() -> AsyncClient:
    app = FastAPI()
    app.include_router(organize_module.router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="https://test")


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


class FakeMailStore:
    """Substitui a tabela mail_connections (sem PostgreSQL nos testes)."""

    def __init__(self) -> None:
        self.data: dict[tuple[str, str], mc.MailTokens] = {}
        self.saves = 0

    async def get(self, user_id: str, provider: str) -> mc.MailTokens | None:
        return self.data.get((user_id, provider))

    async def save(self, user_id: str, provider: str, tokens: mc.MailTokens) -> None:
        self.saves += 1
        self.data[(user_id, provider)] = tokens

    async def delete(self, user_id: str, provider: str):
        existed = (user_id, provider) in self.data
        return existed, self.data.pop((user_id, provider), None)

    async def providers(self, user_id: str) -> set[str]:
        return {p for (u, p) in self.data if u == user_id}


def _tokens(access: str = "at-1", refresh: str | None = "rt-1", ttl: float = 3600,
            scope: str = mc.GMAIL_SCOPE) -> mc.MailTokens:
    return mc.MailTokens(access_token=access, refresh_token=refresh, expires_at=time.time() + ttl, scope=scope)


class MailTestCase(unittest.IsolatedAsyncioTestCase):
    user_id = "user-1"

    def setUp(self) -> None:
        organize_module._mail_reads.clear()
        self.store = FakeMailStore()
        self.events = AsyncMock()
        self.user = SimpleNamespace(id=self.user_id)
        self.current_user = AsyncMock(return_value=self.user)
        self.requests: list[httpx.Request] = []
        self.handler = lambda request: httpx.Response(500)
        self.stack = ExitStack()
        settings = organize_module.settings
        for name, value in {
            "gmail_client_id": "gmail-client", "gmail_client_secret": "gmail-secret", "gmail_redirect_uri": None,
            "outlook_client_id": "outlook-client", "outlook_client_secret": "outlook-secret",
            "outlook_redirect_uri": None, "outlook_tenant": "common",
            "mail_token_enc_key": Fernet.generate_key().decode(),
            "public_api_url": "https://api.example.com", "public_frontend_url": FRONTEND,
            "mail_requests_per_hour": 120,
        }.items():
            self.stack.enter_context(patch.object(settings, name, value))

        def transport(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            return self.handler(request)

        self.stack.enter_context(patch.object(organize_module, "mail_store", self.store))
        self.stack.enter_context(patch.object(organize_module, "_current_user", self.current_user))
        self.stack.enter_context(patch.object(organize_module, "record_security_event", self.events))
        self.stack.enter_context(patch.object(
            organize_module, "_http_client",
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(transport)),
        ))

    def tearDown(self) -> None:
        self.stack.close()


class MailStatusTests(MailTestCase):
    async def test_without_configuration_status_lists_missing_variables(self) -> None:
        with (
            patch.object(organize_module.settings, "gmail_client_id", None),
            patch.object(organize_module.settings, "outlook_client_secret", None),
            patch.object(organize_module.settings, "mail_token_enc_key", "not-a-fernet-key"),
            patch.object(organize_module.settings, "notion_token", None),
        ):
            async with _client() as client:
                body = (await client.get("/api/organize/status")).json()
        connectors = {c["id"]: c for c in body["connectors"]}
        self.assertEqual(connectors["gmail"]["status"], "not-configured")
        self.assertEqual(connectors["gmail"]["missing"], ["GMAIL_CLIENT_ID", "MAIL_TOKEN_ENC_KEY"])
        self.assertIn("GMAIL_CLIENT_ID", connectors["gmail"]["detail"])
        self.assertEqual(connectors["outlook"]["missing"], ["OUTLOOK_CLIENT_SECRET", "MAIL_TOKEN_ENC_KEY"])
        self.assertEqual(connectors["notion"]["status"], "not-configured")

    async def test_status_is_per_user(self) -> None:
        self.store.data[(self.user_id, "gmail")] = _tokens()
        self.store.data[("someone-else", "outlook")] = _tokens()
        async with _client() as client:
            mine = {c["id"]: c for c in (await client.get("/api/organize/status")).json()["connectors"]}
            self.current_user.return_value = None
            anonymous = {c["id"]: c for c in (await client.get("/api/organize/status")).json()["connectors"]}
        self.assertEqual((mine["gmail"]["status"], mine["outlook"]["status"]), ("connected", "not-connected"))
        self.assertTrue(mine["gmail"]["signed_in"])
        self.assertEqual((anonymous["gmail"]["status"], anonymous["outlook"]["status"]), ("not-connected", "not-connected"))
        self.assertFalse(anonymous["gmail"]["signed_in"])


class MailOAuthFlowTests(MailTestCase):
    async def _connect(self, client: AsyncClient, provider: str = "gmail") -> tuple[dict[str, list[str]], str]:
        response = await client.post(f"/api/organize/mail/{provider}/connect")
        self.assertEqual(response.status_code, 200)
        query = parse_qs(urlsplit(response.json()["authorize_url"]).query)
        cookie_header = response.headers["set-cookie"]
        self.assertIn("Path=/api/organize/mail", cookie_header)
        self.assertIn("HttpOnly", cookie_header)
        cookie = response.cookies[mc.MAIL_FLOW_COOKIE]
        client.cookies.clear()  # o cookie de fluxo é enviado explicitamente em cada teste
        return query, cookie

    async def test_connect_requires_session_and_same_origin(self) -> None:
        async with _client() as client:
            self.current_user.return_value = None
            self.assertEqual((await client.post("/api/organize/mail/gmail/connect")).status_code, 401)
            self.current_user.return_value = self.user
            foreign = await client.post("/api/organize/mail/gmail/connect", headers={"Origin": "https://evil.example"})
            unknown = await client.post("/api/organize/mail/yahoo/connect")
        self.assertEqual(foreign.status_code, 403)
        self.assertEqual(unknown.status_code, 422)

    async def test_connect_uses_pkce_minimal_scope_and_encrypted_flow_cookie(self) -> None:
        async with _client() as client:
            query, cookie = await self._connect(client)
            outlook, _ = await self._connect(client, "outlook")
        self.assertEqual(query["scope"], [mc.GMAIL_SCOPE])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(query["access_type"], ["offline"])
        self.assertEqual(query["redirect_uri"], ["https://api.example.com/api/organize/mail/gmail/callback"])
        self.assertNotIn("client_secret", query)
        # O cookie é opaco: nem o state nem o utilizador aparecem em claro.
        self.assertNotIn(query["state"][0], cookie)
        self.assertNotIn(self.user_id, cookie)
        flow = mc.read_flow(cookie)
        self.assertEqual((flow["p"], flow["s"], flow["u"]), ("gmail", query["state"][0], self.user_id))
        self.assertEqual(outlook["scope"], ["offline_access https://graph.microsoft.com/Mail.Read"])

    async def test_callback_exchanges_code_with_verifier_and_stores_tokens(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            form = parse_qs(request.content.decode())
            self.assertEqual(str(request.url), "https://oauth2.googleapis.com/token")
            self.assertEqual(form["grant_type"], ["authorization_code"])
            self.assertEqual(form["code"], ["the-code"])
            verifier = form["code_verifier"][0]
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            self.assertEqual(challenge, self.challenge)
            return httpx.Response(200, json={"access_token": "at-new", "refresh_token": "rt-new",
                                             "expires_in": 3599, "scope": mc.GMAIL_SCOPE, "token_type": "Bearer"})

        self.handler = handler
        async with _client() as client:
            query, cookie = await self._connect(client)
            self.challenge = query["code_challenge"][0]
            response = await client.get(
                "/api/organize/mail/gmail/callback",
                params={"code": "the-code", "state": query["state"][0]},
                headers={"Cookie": f"{mc.MAIL_FLOW_COOKIE}={cookie}"},
            )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], f"{FRONTEND}/#/organize?mail=connected&provider=gmail")
        self.assertIn(f'{mc.MAIL_FLOW_COOKIE}=""', response.headers["set-cookie"])
        stored = self.store.data[(self.user_id, "gmail")]
        self.assertEqual((stored.access_token, stored.refresh_token), ("at-new", "rt-new"))
        self.events.assert_awaited_once_with(self.user_id, "mail_connected", details={"provider": "gmail"})

    async def test_callback_rejects_bad_state_other_session_expired_and_missing_scope(self) -> None:
        self.handler = lambda request: httpx.Response(200, json={
            "access_token": "at", "refresh_token": "rt", "expires_in": 3600,
            "scope": "openid https://www.googleapis.com/auth/userinfo.email"})
        async with _client() as client:
            query, cookie = await self._connect(client)
            state = query["state"][0]

            async def callback(**params) -> str:
                response = await client.get("/api/organize/mail/gmail/callback", params=params,
                                            headers={"Cookie": f"{mc.MAIL_FLOW_COOKIE}={cookie}"})
                return parse_qs(response.headers["location"].split("?", 1)[1])["mail"][0]

            self.assertEqual(await callback(code="c", state="forged"), "error")
            self.assertEqual(await callback(code="c", state=state + "ção"), "error")
            self.assertEqual(await callback(error="access_denied", state=state), "denied")
            self.current_user.return_value = SimpleNamespace(id="attacker")
            self.assertEqual(await callback(code="c", state=state), "session")
            self.current_user.return_value = self.user
            self.assertEqual(len(self.requests), 0)  # nenhuma troca de código até aqui
            self.assertEqual(await callback(code="c", state=state), "scope")
            missing = await client.get("/api/organize/mail/gmail/callback", params={"code": "c", "state": state})
            outlook = await client.get("/api/organize/mail/outlook/callback", params={"code": "c", "state": state},
                                       headers={"Cookie": f"{mc.MAIL_FLOW_COOKIE}={cookie}"})
        self.assertIn("mail=expired", missing.headers["location"])
        self.assertIn("mail=error", outlook.headers["location"])
        self.assertEqual(self.store.data, {})

    def test_flow_cookie_expires_and_rejects_tampering(self) -> None:
        provider = mc.mail_provider("gmail")
        _, cookie = mc.start_flow(provider, "u")
        self.assertIsNotNone(mc.read_flow(cookie))
        self.assertIsNone(mc.read_flow(cookie[:-4] + "AAAA"))
        with patch("cryptography.fernet.time.time", return_value=time.time() + mc.FLOW_TTL_SECONDS + 5):
            self.assertIsNone(mc.read_flow(cookie))

    def test_tokens_are_encrypted_at_rest(self) -> None:
        tokens = _tokens(access="ya29.secret-access", refresh="1//secret-refresh")
        ciphertext = mc.encrypt_tokens(tokens)
        self.assertNotIn("secret", ciphertext)
        self.assertEqual(mc.decrypt_tokens(ciphertext), tokens)
        with patch.object(organize_module.settings, "mail_token_enc_key", Fernet.generate_key().decode()):
            self.assertIsNone(mc.decrypt_tokens(ciphertext))  # chave rodada → tratado como não ligado


class MailReadTests(MailTestCase):
    async def test_gmail_list_returns_metadata_only(self) -> None:
        self.store.data[(self.user_id, "gmail")] = _tokens()

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers["Authorization"], "Bearer at-1")
            if request.url.path.endswith("/messages"):
                self.assertEqual(request.url.params["maxResults"], "20")
                return httpx.Response(200, json={"messages": [{"id": "18c0aa"}, {"id": "18c0bb"}, {"id": "../etc"}]})
            self.assertEqual(request.url.params["format"], "metadata")
            if request.url.path.endswith("18c0bb"):
                return httpx.Response(404)
            return httpx.Response(200, json={
                "id": "18c0aa", "labelIds": ["INBOX", "UNREAD"], "snippet": "Fatura &amp; recibo\u202e de outubro",
                "internalDate": "1762682400000",
                "payload": {"headers": [
                    {"name": "From", "value": '"EDP Comercial" <faturas@edp.example>'},
                    {"name": "Subject", "value": "Fatura disponível"},
                    {"name": "Date", "value": "Mon, 09 Nov 2026 10:15:00 +0000"},
                ]},
            })

        self.handler = handler
        async with _client() as client:
            response = await client.get("/api/organize/mail/messages")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        body = response.json()
        self.assertEqual(body["provider"], "gmail")
        self.assertEqual(body["messages"], [{
            "id": "18c0aa", "from_name": "EDP Comercial", "from_email": "faturas@edp.example",
            "subject": "Fatura disponível", "date": "2026-11-09T10:15:00+00:00",
            "snippet": "Fatura & recibo de outubro", "unread": True,
        }])
        self.assertEqual(len(self.requests), 3)  # listagem + 2 metadados; id inválido ignorado

    async def test_outlook_list_refreshes_expired_token_first(self) -> None:
        self.store.data[(self.user_id, "outlook")] = _tokens(access="old", refresh="rt-old", ttl=-10,
                                                              scope="https://graph.microsoft.com/Mail.Read")

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "login.microsoftonline.com":
                form = parse_qs(request.content.decode())
                self.assertEqual(request.url.path, "/common/oauth2/v2.0/token")
                self.assertEqual(form["grant_type"], ["refresh_token"])
                self.assertEqual(form["refresh_token"], ["rt-old"])
                return httpx.Response(200, json={"access_token": "fresh", "refresh_token": "rt-rotated",
                                                 "expires_in": 3600, "scope": "Mail.Read"})
            self.assertEqual(request.headers["Authorization"], "Bearer fresh")
            self.assertEqual(request.url.path, "/v1.0/me/mailFolders/inbox/messages")
            self.assertEqual(request.url.params["$top"], "20")
            self.assertNotIn("body", request.url.params["$select"].split(","))
            return httpx.Response(200, json={"value": [{
                "id": "AAMkAGI2THVSAAA=", "subject": "Reunião", "isRead": False,
                "receivedDateTime": "2026-11-09T08:00:00Z", "bodyPreview": "Olá equipa",
                "from": {"emailAddress": {"name": "Ana", "address": "ana@contoso.example"}},
            }, {"id": "x"}]})

        self.handler = handler
        async with _client() as client:
            body = (await client.get("/api/organize/mail/messages", params={"provider": "outlook"})).json()
        self.assertEqual([m["subject"] for m in body["messages"]], ["Reunião"])
        self.assertEqual(body["messages"][0]["from_email"], "ana@contoso.example")
        stored = self.store.data[(self.user_id, "outlook")]
        self.assertEqual((stored.access_token, stored.refresh_token), ("fresh", "rt-rotated"))

    async def test_revoked_refresh_token_disconnects(self) -> None:
        self.store.data[(self.user_id, "gmail")] = _tokens(ttl=-10)
        self.handler = lambda request: httpx.Response(400, json={"error": "invalid_grant"})
        async with _client() as client:
            response = await client.get("/api/organize/mail/messages?provider=gmail")
        self.assertEqual(response.status_code, 409)
        self.assertIn("Liga a conta novamente", response.json()["detail"])
        self.assertEqual(self.store.data, {})

    async def test_provider_401_triggers_one_refresh_and_retry(self) -> None:
        self.store.data[(self.user_id, "gmail")] = _tokens(access="revoked-early")

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "oauth2.googleapis.com":
                return httpx.Response(200, json={"access_token": "renewed", "expires_in": 3600})
            if request.headers["Authorization"] == "Bearer revoked-early":
                return httpx.Response(401)
            return httpx.Response(200, json={"resultSizeEstimate": 0})

        self.handler = handler
        async with _client() as client:
            response = await client.get("/api/organize/mail/messages")
        self.assertEqual(response.json(), {"provider": "gmail", "messages": []})
        stored = self.store.data[(self.user_id, "gmail")]
        self.assertEqual((stored.access_token, stored.refresh_token), ("renewed", "rt-1"))  # refresh mantido

    async def test_messages_require_session_and_connection(self) -> None:
        async with _client() as client:
            self.current_user.return_value = None
            anonymous = await client.get("/api/organize/mail/messages")
            self.current_user.return_value = self.user
            none_connected = await client.get("/api/organize/mail/messages")
            with patch.object(organize_module.settings, "gmail_client_secret", None):
                unconfigured = await client.get("/api/organize/mail/messages?provider=gmail")
        self.assertEqual(anonymous.status_code, 401)
        self.assertEqual(none_connected.status_code, 409)
        self.assertEqual(unconfigured.status_code, 503)
        self.assertIn("GMAIL_CLIENT_SECRET", unconfigured.json()["detail"])

    async def test_gmail_message_body_prefers_plain_text_and_is_limited(self) -> None:
        self.store.data[(self.user_id, "gmail")] = _tokens()
        long_text = "linha\n" * 2000

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.params["format"], "full")
            return httpx.Response(200, json={
                "id": "18c0aa", "snippet": "x", "labelIds": [],
                "payload": {"mimeType": "multipart/mixed", "headers": [{"name": "Subject", "value": "Contrato"}], "parts": [
                    {"mimeType": "multipart/alternative", "parts": [
                        {"mimeType": "text/plain", "body": {"data": _b64(long_text)}},
                        {"mimeType": "text/html", "body": {"data": _b64("<p>html</p>")}},
                    ]},
                    {"mimeType": "text/plain", "filename": "anexo.txt", "body": {"attachmentId": "a1"}},
                ]},
            })

        self.handler = handler
        async with _client() as client:
            response = await client.get("/api/organize/mail/messages/18c0aa?provider=gmail")
        message = response.json()["message"]
        self.assertEqual(message["subject"], "Contrato")
        self.assertTrue(message["truncated"])
        self.assertEqual(len(message["body"]), mailbox.MAX_BODY_CHARS)
        self.assertNotIn("html", message["body"])

    async def test_outlook_message_requests_plain_text_body(self) -> None:
        self.store.data[(self.user_id, "outlook")] = _tokens(scope="Mail.Read")

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers["Prefer"], 'outlook.body-content-type="text"')
            self.assertEqual(request.url.raw_path.split(b"?")[0], b"/v1.0/me/messages/AAMkAD%2Babc%3D%3D")
            return httpx.Response(200, json={
                "id": "AAMkAD+abc==", "subject": "Proposta", "receivedDateTime": "2026-11-09T08:00:00Z",
                "body": {"contentType": "text", "content": "Segue a proposta.\r\n\r\n\r\n\r\nCumprimentos"},
                "from": {"emailAddress": {"name": "Rui", "address": "rui@example.com"}},
            })

        self.handler = handler
        async with _client() as client:
            response = await client.get("/api/organize/mail/messages/AAMkAD+abc==", params={"provider": "outlook"})
        message = response.json()["message"]
        self.assertEqual(message["body"], "Segue a proposta.\n\nCumprimentos")
        self.assertFalse(message["truncated"])

    async def test_invalid_and_missing_message_ids(self) -> None:
        self.store.data[(self.user_id, "gmail")] = _tokens()
        self.handler = lambda request: httpx.Response(404)
        async with _client() as client:
            invalid = await client.get("/api/organize/mail/messages/zz..zz-zz?provider=gmail")
            missing = await client.get("/api/organize/mail/messages/18c0ff?provider=gmail")
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(missing.status_code, 404)

    async def test_read_limit_per_user(self) -> None:
        self.store.data[(self.user_id, "gmail")] = _tokens()
        self.handler = lambda request: httpx.Response(200, json={})
        with patch.object(organize_module.settings, "mail_requests_per_hour", 2):
            async with _client() as client:
                codes = [(await client.get("/api/organize/mail/messages")).status_code for _ in range(3)]
        self.assertEqual(codes, [200, 200, 429])


class MailDisconnectTests(MailTestCase):
    async def test_gmail_disconnect_revokes_at_google_and_deletes_tokens(self) -> None:
        self.store.data[(self.user_id, "gmail")] = _tokens(refresh="rt-to-revoke")

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(str(request.url), "https://oauth2.googleapis.com/revoke")
            self.assertEqual(parse_qs(request.content.decode())["token"], ["rt-to-revoke"])
            return httpx.Response(200)

        self.handler = handler
        async with _client() as client:
            foreign = await client.delete("/api/organize/mail/gmail", headers={"Origin": "https://evil.example"})
            response = await client.delete("/api/organize/mail/gmail")
        self.assertEqual(foreign.status_code, 403)
        self.assertEqual(response.json()["revoked_at_provider"], True)
        self.assertEqual(self.store.data, {})
        self.events.assert_awaited_once_with(self.user_id, "mail_disconnected", details={"provider": "gmail"})

    async def test_outlook_disconnect_deletes_locally_without_calling_microsoft(self) -> None:
        self.store.data[(self.user_id, "outlook")] = _tokens()
        async with _client() as client:
            body = (await client.delete("/api/organize/mail/outlook")).json()
        self.assertEqual((body["was_connected"], body["revoked_at_provider"]), (True, False))
        self.assertIn("Microsoft", body["detail"])
        self.assertEqual(self.requests, [])
        self.assertEqual(self.store.data, {})


class MailboxParsingTests(unittest.TestCase):
    def test_html_is_reduced_to_text_without_scripts(self) -> None:
        text = mailbox.html_to_text(
            "<html><head><style>p{}</style></head><body><p>Olá&nbsp;<b>Ana</b></p>"
            "<script>alert(1)</script><a href='https://evil.example'>clica</a></body></html>")
        cleaned = mailbox.clean_text(text, 500)
        self.assertEqual(cleaned, "Olá Ana\nclica")

    def test_clean_text_drops_control_and_bidi_characters(self) -> None:
        self.assertEqual(mailbox.clean_text("a\x00b\u202ec\u200b\td", 10), "abc\td")
        self.assertEqual(mailbox.clean_text(None, 10), "")

    def test_message_ids_are_validated_per_provider(self) -> None:
        self.assertTrue(mailbox.valid_message_id("gmail", "18c0aa"))
        self.assertFalse(mailbox.valid_message_id("gmail", "AAMk-not-hex"))
        self.assertTrue(mailbox.valid_message_id("outlook", "AAMkAGI2THVSAAA="))
        self.assertFalse(mailbox.valid_message_id("outlook", "../../me/sendMail"))


if __name__ == "__main__":
    unittest.main()
