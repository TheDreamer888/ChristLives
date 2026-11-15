from __future__ import annotations

import ipaddress
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from starlette.middleware.base import BaseHTTPMiddleware

from src.app import firewall as firewall_module
from src.app import supervisor as supervisor_module
from src.app.firewall import Firewall, IPRangeSet, parse_feed
from src.app.routers import chat as chat_module
from src.app.routers import security_center as center_module
from src.app.security import is_auth_session_active


def _app_with_firewall(fw: Firewall) -> FastAPI:
    app = FastAPI()
    app.add_middleware(BaseHTTPMiddleware, dispatch=fw)

    @app.get("/api/ping")
    async def ping(q: str = "") -> dict[str, str]:
        return {"ok": "yes"}

    @app.post("/api/echo")
    async def echo() -> dict[str, str]:
        return {"ok": "yes"}

    return app


def _client(app: FastAPI, ip: str = "203.0.113.10") -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app, client=(ip, 1234)), base_url="http://test")


class FirewallRuleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.fw = Firewall()

    async def test_clean_requests_pass_and_attacks_are_blocked_with_category(self) -> None:
        attacks = {
            "/api/ping?q=../../etc/passwd": "path_traversal",
            "/.env": "sensitive_file",
            "/wp-login.php": "sensitive_file",
            "/api/ping?q=1%27%20OR%20%271%27%3D%271": "sql_injection",
            "/api/ping?q=1 UNION SELECT password FROM users": "sql_injection",
            "/api/ping?q=<script>alert(1)</script>": "xss",
            "/api/ping?q=x;cat /etc/passwd": "command_injection",
            "/api/ping?url=http://169.254.169.254/latest/meta-data": "ssrf",
        }
        async with _client(_app_with_firewall(self.fw)) as client:
            self.assertEqual((await client.get("/api/ping?q=Como funciona a inflação?")).status_code, 200)
            self.assertEqual((await client.get("/api/ping?q=rock and roll")).status_code, 200)
            for path, rule in attacks.items():
                response = await client.get(path)
                self.assertEqual(response.status_code, 403, path)
                self.assertEqual(response.json()["rule"], rule, path)
            scanner = await client.get("/api/ping", headers={"User-Agent": "sqlmap/1.8"})
            self.assertEqual(scanner.json()["rule"], "scanner")
        self.assertEqual(len(self.fw.recent_events()), len(attacks) + 1)

    async def test_body_size_and_methods(self) -> None:
        async with _client(_app_with_firewall(self.fw)) as client:
            big = await client.post("/api/echo", content=b"x" * 10, headers={"Content-Length": "99999999"})
            self.assertEqual(big.status_code, 413)
            self.assertEqual((await client.request("TRACE", "/api/ping")).status_code, 405)

    async def test_rate_limit_then_auto_ban(self) -> None:
        with (
            patch.object(firewall_module.settings, "firewall_requests_per_minute", 10),
            patch.object(firewall_module.settings, "firewall_burst", 3),
            patch.object(firewall_module.settings, "firewall_ban_threshold", 4),
        ):
            async with _client(_app_with_firewall(self.fw)) as client:
                codes = [(await client.get("/api/ping")).status_code for _ in range(5)]
                self.assertEqual(codes[:3], [200, 200, 200])
                self.assertEqual(codes[3:], [429, 429])
                for _ in range(2):
                    await client.get("/.git/config")  # 4.ª violação → banimento
                banned = await client.get("/api/ping")
                self.assertEqual(banned.status_code, 403)
                self.assertEqual(banned.json()["rule"], "auto_ban")
            async with _client(_app_with_firewall(self.fw), ip="198.51.100.7") as other:
                self.assertEqual((await other.get("/api/ping")).status_code, 200)

    async def test_allowlist_wins_and_manual_blocks_expire_or_can_be_removed(self) -> None:
        with patch.object(firewall_module.settings, "firewall_allowlist", "203.0.113.0/24"):
            self.fw.reload_config()
            with self.assertRaises(ValueError):
                self.fw.add_block("203.0.113.10", "teste", 10)
            async with _client(_app_with_firewall(self.fw)) as client:
                # Allowlist: o firewall deixa passar e a rota inexistente devolve 404.
                self.assertEqual((await client.get("/.env")).status_code, 404)
        self.fw.reload_config()
        self.fw.add_block("198.51.100.0/24", "abuso", 10)
        async with _client(_app_with_firewall(self.fw), ip="198.51.100.9") as client:
            self.assertEqual((await client.get("/api/ping")).status_code, 403)
            self.assertTrue(self.fw.remove_block("198.51.100.0/24"))
            self.assertEqual((await client.get("/api/ping")).status_code, 200)

    async def test_forwarded_for_is_only_trusted_from_configured_proxies(self) -> None:
        self.fw.add_block("192.0.2.55", "atacante", 10)
        headers = {"X-Forwarded-For": "192.0.2.55"}
        async with _client(_app_with_firewall(self.fw), ip="198.51.100.20") as client:
            # Sem proxy de confiança o cabeçalho é ignorado (impede falsificar o IP).
            self.assertEqual((await client.get("/api/ping", headers=headers)).status_code, 200)
        with patch.object(firewall_module.settings, "trusted_proxies", "198.51.100.20/32"):
            self.fw.reload_config()
            async with _client(_app_with_firewall(self.fw), ip="198.51.100.20") as client:
                self.assertEqual((await client.get("/api/ping", headers=headers)).status_code, 403)


class ThreatIntelTests(unittest.IsolatedAsyncioTestCase):
    def test_feed_parser_skips_bogons_comments_and_garbage(self) -> None:
        text = "# header\n0.0.0.0/8\n10.0.0.0/8\n127.0.0.0/8\n1.10.16.0/20 ; SBL256894\n45.9.148.3\nnot-an-ip\n"
        self.assertEqual([str(n) for n in parse_feed(text)], ["1.10.16.0/20", "45.9.148.3/32"])

    def test_range_set_lookup(self) -> None:
        ranges = IPRangeSet([ipaddress.ip_network(n) for n in ("1.10.16.0/20", "1.10.24.0/21", "8.8.8.8/32")])
        self.assertIn(ipaddress.ip_address("1.10.20.1"), ranges)
        self.assertIn(ipaddress.ip_address("8.8.8.8"), ranges)
        self.assertNotIn(ipaddress.ip_address("8.8.4.4"), ranges)
        self.assertNotIn(ipaddress.ip_address("2001:db8::1"), ranges)

    async def test_refresh_loads_real_format_and_blocks_listed_ip(self) -> None:
        bodies = {
            "raw.githubusercontent.com": "# FireHOL\n0.0.0.0/8\n45.9.148.0/24\n",
            "www.spamhaus.org": "; Spamhaus DROP\n1.10.16.0/20 ; SBL256894\n",
            "rules.emergingthreats.net": "101.206.210.3\n",
        }
        transport = httpx.MockTransport(lambda request: httpx.Response(200, text=bodies[request.url.host]))
        fw = Firewall()
        async with httpx.AsyncClient(transport=transport) as client:
            await fw.refresh_feeds(client)
        self.assertEqual(fw.state.feeds.size, 3)
        self.assertIsNone(fw.state.feeds_error)
        async with _client(_app_with_firewall(fw), ip="45.9.148.77") as listed:
            response = await listed.get("/api/ping")
            self.assertEqual(response.json()["rule"], "threat_intel")

    async def test_feed_failure_keeps_previous_data_and_reports_error(self) -> None:
        fw = Firewall()
        fw.state.feeds.replace([ipaddress.ip_network("45.9.148.0/24")])
        transport = httpx.MockTransport(lambda request: httpx.Response(503))
        async with httpx.AsyncClient(transport=transport) as client:
            await fw.refresh_feeds(client)
        self.assertIn(ipaddress.ip_address("45.9.148.1"), fw.state.feeds)
        self.assertIn("FireHOL", fw.state.feeds_error)


def _claude_response(payload: dict | None, stop_reason: str = "end_turn") -> SimpleNamespace:
    content = [SimpleNamespace(type="text", text=json.dumps(payload))] if payload is not None else []
    return SimpleNamespace(stop_reason=stop_reason, content=content)


class SupervisorTests(unittest.IsolatedAsyncioTestCase):
    def _fake_client(self, response: SimpleNamespace) -> tuple[SimpleNamespace, AsyncMock]:
        create = AsyncMock(return_value=response)
        return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)), close=AsyncMock()), create

    async def test_disabled_without_key(self) -> None:
        with patch.object(supervisor_module.settings, "anthropic_api_key", None):
            self.assertEqual((await supervisor_module.review_answer("q", "a", "general")).status, "disabled")

    async def test_block_verdict_uses_structured_output_and_fallbacks(self) -> None:
        client, create = self._fake_client(_claude_response({"verdict": "block", "categories": ["promessa_financeira", "inventada"], "reason": "Promete lucro garantido."}))
        with (
            patch.object(supervisor_module.settings, "anthropic_api_key", "k"),
            patch.object(supervisor_module, "_client", return_value=client),
        ):
            verdict = await supervisor_module.review_answer("Ganho dinheiro?", "Lucro garantido de 50%!", "trading")
        self.assertEqual(verdict.status, "blocked")
        self.assertEqual(verdict.categories, ["promessa_financeira"])
        kwargs = create.await_args.kwargs
        self.assertEqual(kwargs["output_config"]["format"]["type"], "json_schema")
        self.assertEqual(kwargs["fallbacks"], "default")
        self.assertIn("<resposta>", kwargs["messages"][0]["content"])

    async def test_refusal_blocks_and_api_error_is_reported_as_unavailable(self) -> None:
        refused, _ = self._fake_client(_claude_response(None, "refusal"))
        with patch.object(supervisor_module.settings, "anthropic_api_key", "k"), patch.object(supervisor_module, "_client", return_value=refused):
            self.assertEqual((await supervisor_module.review_answer("q", "a", "general")).status, "blocked")
        failing = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(side_effect=supervisor_module.anthropic.APIConnectionError(request=httpx.Request("POST", "https://x"))))), close=AsyncMock())
        with patch.object(supervisor_module.settings, "anthropic_api_key", "k"), patch.object(supervisor_module, "_client", return_value=failing):
            self.assertEqual((await supervisor_module.review_answer("q", "a", "general")).status, "unavailable")

    async def test_triage_only_keeps_public_ips_seen_in_events(self) -> None:
        report = {"severity": "alta", "summary": "Varrimento.", "findings": [],
                  "block_recommendations": [{"network": "45.9.148.3", "reason": "scanner"},
                                            {"network": "10.0.0.1", "reason": "privado"},
                                            {"network": "8.8.8.8", "reason": "não aparece"}]}
        client, _ = self._fake_client(_claude_response(report))
        events = [{"ip": "45.9.148.3", "path": "/.env", "rule": "sensitive_file"}, {"ip": "10.0.0.1", "path": "/x", "rule": "xss"}]
        with patch.object(supervisor_module.settings, "anthropic_api_key", "k"), patch.object(supervisor_module, "_client", return_value=client):
            result = await supervisor_module.triage({"blocked_24h": 2}, events)
        self.assertEqual([r["network"] for r in result["block_recommendations"]], ["45.9.148.3"])
        self.assertEqual(result["events_analyzed"], 2)


class ChatSupervisionTests(unittest.IsolatedAsyncioTestCase):
    async def test_blocked_answer_is_replaced(self) -> None:
        chat_module._WINDOWS.clear()
        app = FastAPI()
        app.include_router(chat_module.router)
        with (
            patch.object(chat_module.settings, "anthropic_api_key", "k"),
            patch.object(chat_module, "complete", AsyncMock(return_value="Compra já: lucro garantido!")),
            patch.object(chat_module, "review_answer", AsyncMock(return_value=supervisor_module.Verdict("blocked", ["promessa_financeira"], "x"))),
        ):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                body = (await client.post("/api/chat", json={"model": "claude", "message": "Devo comprar?", "style": "concise"})).json()
        self.assertTrue(body["blocked"])
        self.assertEqual(body["answer"], chat_module.SUPERVISOR_BLOCKED)
        self.assertEqual(body["supervision"]["status"], "blocked")

    def test_style_reaches_system_prompt(self) -> None:
        self.assertIn("curta e direta", chat_module.build_system_prompt("general", None, "concise"))
        self.assertIn("detalhado", chat_module.build_system_prompt("general", None, "detailed"))


class SecurityCenterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        firewall_module.firewall.reset()
        self.app = FastAPI()
        self.app.include_router(center_module.router)

    async def test_public_status_has_no_ip_addresses(self) -> None:
        firewall_module.firewall._record(ipaddress.ip_address("45.9.148.3"), MagicMock(method="GET", url=MagicMock(path="/.env"), headers={}), "sensitive_file", "Ficheiro", 403)
        async with AsyncClient(transport=ASGITransport(app=self.app), base_url="http://test") as client:
            body = (await client.get("/api/security/status")).json()
        self.assertEqual(body["firewall"]["blocked_24h"], 1)
        self.assertNotIn("45.9.148.3", json.dumps(body))

    async def test_admin_routes_require_verified_admin_email(self) -> None:
        cases = [
            (None, 401),
            (SimpleNamespace(email="user@example.com", email_verified=True), 403),
            (SimpleNamespace(email="admin@example.com", email_verified=False), 403),
            (SimpleNamespace(email="Admin@Example.com", email_verified=True), 200),
        ]
        for user, expected in cases:
            with (
                patch.object(center_module, "_current_user", AsyncMock(return_value=user)),
                patch.object(center_module.settings, "security_admin_emails", "admin@example.com"),
            ):
                async with AsyncClient(transport=ASGITransport(app=self.app), base_url="http://test") as client:
                    self.assertEqual((await client.get("/api/security/firewall/events")).status_code, expected, user)

    async def test_admin_can_block_and_unblock(self) -> None:
        admin = SimpleNamespace(email="admin@example.com", email_verified=True)
        with (
            patch.object(center_module, "_current_user", AsyncMock(return_value=admin)),
            patch.object(center_module.settings, "security_admin_emails", "admin@example.com"),
        ):
            async with AsyncClient(transport=ASGITransport(app=self.app), base_url="http://test") as client:
                created = await client.post("/api/security/firewall/blocks", json={"network": "45.9.148.0/24", "reason": "varrimento", "minutes": 60})
                self.assertEqual(created.status_code, 201)
                self.assertEqual(len((await client.get("/api/security/firewall/blocks")).json()["blocks"]), 1)
                self.assertEqual((await client.post("/api/security/firewall/blocks", json={"network": "nope", "reason": "xxx"})).status_code, 422)
                self.assertTrue((await client.delete("/api/security/firewall/blocks?network=45.9.148.0/24")).json()["removed"])


class SessionLookupRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_active_session_lookup_opens_a_real_session(self) -> None:
        class Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def scalar(self, statement):
                return "session-id"

        maker = MagicMock(return_value=Session())
        with patch("src.app.security.session_factory", return_value=maker):
            self.assertTrue(await is_auth_session_active("user", "session-id"))
        maker.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
