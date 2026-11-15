from __future__ import annotations

import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from src.app.routers import chat as chat_module
from src.app.routers import economy as economy_module
from src.app.routers import markets as markets_module
from src.app.routers import organize as organize_module
from src.app.supervisor import Verdict
from src.app.routers.chat import (
    ADULT_REFUSAL,
    build_system_prompt,
    contains_credentials,
    is_adult_request,
)


def _app(*routers) -> FastAPI:
    app = FastAPI()
    for router in routers:
        app.include_router(router)
    return app


def _client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _mock_http(handler):
    """Substitui o _http_client de um módulo por um cliente com transporte simulado."""
    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))


class ChatSafetyTests(unittest.TestCase):
    def test_adult_terms_are_detected_with_accents_and_case(self) -> None:
        self.assertTrue(is_adult_request("Escreve uma história ERÓTICA"))
        self.assertTrue(is_adult_request("links de porn"))
        self.assertFalse(is_adult_request("Explica o mercado de ações em Portugal"))
        self.assertFalse(is_adult_request("Sexta-feira há reunião"))

    def test_credentials_are_detected(self) -> None:
        self.assertTrue(contains_credentials("a minha password: hunter2abc"))
        self.assertTrue(contains_credentials("usa sk-abcdefghijklmnopqrstuv"))
        self.assertFalse(contains_credentials("como crio uma palavra-passe forte?"))

    def test_system_prompt_wraps_context_as_untrusted_data(self) -> None:
        prompt = build_system_prompt("trading", "AAPL 190 USD")
        self.assertIn("conteúdo sexual", prompt)
        self.assertIn("não executas ordens", prompt)
        self.assertIn("<contexto>\nAAPL 190 USD\n</contexto>", prompt)
        self.assertNotIn("<contexto>", build_system_prompt("general", "   "))


class ChatRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        chat_module._WINDOWS.clear()
        # O supervisor tem testes próprios (test_security_center.py); aqui fica desligado.
        patcher = patch.object(chat_module, "review_answer", AsyncMock(return_value=Verdict("disabled")))
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_models_only_lists_configured_providers(self) -> None:
        with (
            patch.object(chat_module.settings, "anthropic_api_key", "key"),
            patch.object(chat_module.settings, "ai_api_key", None),
            patch.object(chat_module.settings, "xai_api_key", "key"),
        ):
            async with _client(_app(chat_module.router)) as client:
                body = (await client.get("/api/chat/models")).json()
        self.assertEqual([m["id"] for m in body["models"]], ["claude", "grok"])
        self.assertEqual(body["default"], "claude")
        self.assertEqual(body["models"][0]["model"], "claude-opus-5-5")

    async def test_unknown_model_is_503_and_adult_request_never_reaches_provider(self) -> None:
        complete = AsyncMock(return_value="não devia ser chamado")
        with (
            patch.object(chat_module.settings, "anthropic_api_key", "key"),
            patch.object(chat_module, "complete", complete),
        ):
            async with _client(_app(chat_module.router)) as client:
                missing = await client.post("/api/chat", json={"model": "grok", "message": "olá"})
                adult = await client.post("/api/chat", json={"model": "claude", "message": "conteúdo nsfw por favor"})
        self.assertEqual(missing.status_code, 503)
        self.assertEqual(adult.json(), {"answer": ADULT_REFUSAL, "model": "claude", "blocked": True})
        complete.assert_not_awaited()

    async def test_credentials_in_history_are_rejected(self) -> None:
        with patch.object(chat_module.settings, "anthropic_api_key", "key"):
            async with _client(_app(chat_module.router)) as client:
                response = await client.post("/api/chat", json={
                    "model": "claude", "message": "continua",
                    "history": [{"role": "user", "content": "token=abcdefgh123"}],
                })
        self.assertEqual(response.status_code, 422)

    async def test_history_starts_with_user_and_mode_reaches_system_prompt(self) -> None:
        complete = AsyncMock(return_value="Resposta")
        with (
            patch.object(chat_module.settings, "anthropic_api_key", "key"),
            patch.object(chat_module, "complete", complete),
        ):
            async with _client(_app(chat_module.router)) as client:
                response = await client.post("/api/chat", json={
                    "model": "claude", "mode": "tutor", "message": "O que é inflação?",
                    "history": [
                        {"role": "assistant", "content": "Olá! Em que posso ajudar?"},
                        {"role": "user", "content": "Sou estudante"},
                        {"role": "assistant", "content": "Ótimo"},
                    ],
                    "context": "Inflação PT 2023: 4.3%",
                })
        self.assertEqual(response.json()["answer"], "Resposta")
        model, system, messages = complete.await_args.args
        self.assertEqual(model.id, "claude")
        self.assertIn("tutor de economia", system)
        self.assertIn("Inflação PT 2023", system)
        self.assertEqual([m["role"] for m in messages], ["user", "assistant", "user"])
        self.assertEqual(messages[-1]["content"], "O que é inflação?")

    async def test_rate_limit_applies_per_client(self) -> None:
        with (
            patch.object(chat_module.settings, "anthropic_api_key", "key"),
            patch.object(chat_module.settings, "chat_requests_per_hour", 2),
            patch.object(chat_module, "complete", AsyncMock(return_value="ok")),
        ):
            async with _client(_app(chat_module.router)) as client:
                codes = [(await client.post("/api/chat", json={"model": "claude", "message": "oi"})).status_code for _ in range(3)]
        self.assertEqual(codes, [200, 200, 429])

    async def test_claude_adapter_uses_fallbacks_and_handles_refusal(self) -> None:
        create = AsyncMock(return_value=SimpleNamespace(stop_reason="refusal", content=[]))
        fake_client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)), close=AsyncMock())
        with patch.object(chat_module.anthropic, "AsyncAnthropic", return_value=fake_client):
            answer = await chat_module._ask_claude("claude-opus-5-5", "sys", [{"role": "user", "content": "x"}])
        self.assertIn("Não posso ajudar", answer)
        kwargs = create.await_args.kwargs
        self.assertEqual(kwargs["fallbacks"], "default")
        self.assertEqual(kwargs["betas"], ["server-side-fallback-2026-07-01"])
        self.assertEqual(kwargs["model"], "claude-opus-5-5")
        fake_client.close.assert_awaited_once()

    async def test_claude_adapter_joins_text_blocks(self) -> None:
        content = [SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text="Olá "),
                   SimpleNamespace(type="text", text="mundo")]
        create = AsyncMock(return_value=SimpleNamespace(stop_reason="end_turn", content=content))
        fake_client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)), close=AsyncMock())
        with patch.object(chat_module.anthropic, "AsyncAnthropic", return_value=fake_client):
            self.assertEqual(await chat_module._ask_claude("m", "s", []), "Olá mundo")


class MarketsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        markets_module._cache.clear()
        markets_module._gdelt_last = 0.0

    async def test_gdelt_rate_limit_is_retried_once_then_served_from_stale_cache(self) -> None:
        calls: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host != "api.gdeltproject.org":
                return httpx.Response(503)  # feeds RSS em baixo → recurso ao GDELT
            calls.append(1)
            if len(calls) == 1:
                return httpx.Response(429, text="Please limit requests")
            if len(calls) == 2:
                return httpx.Response(200, json={"articles": [{"url": "https://n.example/1", "title": "Bonds rally"}]})
            return httpx.Response(429, text="Please limit requests")

        with (
            patch.object(markets_module.settings, "finnhub_api_key", None),
            patch.object(markets_module, "GDELT_MIN_INTERVAL", 0),
            patch.object(markets_module, "NEWS_TTL", 0),
            patch.object(markets_module, "_http_client", _mock_http(handler)),
        ):
            async with _client(_app(markets_module.router)) as client:
                first = await client.get("/api/markets/news")
                second = await client.get("/api/markets/news")
        self.assertEqual(first.json()["articles"][0]["title"], "Bonds rally")
        self.assertEqual(second.status_code, 200)
        self.assertIn("cache", second.json()["notice"])

    def test_gdelt_normalization_drops_unsafe_urls_and_duplicates(self) -> None:
        payload = {"articles": [
            {"url": "https://news.example/a", "title": "Fed holds rates", "domain": "news.example", "seendate": "20261109T101500Z"},
            {"url": "https://other.example/b", "title": "fed holds rates", "domain": "other.example"},
            {"url": "javascript:alert(1)", "title": "XSS"},
            {"url": "https://user:pw@evil.example/", "title": "Credenciais"},
        ]}
        articles = markets_module.normalize_gdelt_news(payload)
        self.assertEqual(len(articles), 1)
        self.assertEqual(articles[0]["published_at"], "2026-11-09T10:15:00+00:00")

    def test_rss_parser_normalizes_items_and_rejects_entity_attacks(self) -> None:
        feed = b"""<?xml version="1.0"?><rss><channel>
          <item><title>Fed &amp; ECB hold rates</title><link>https://bbc.example/a</link>
            <pubDate>Mon, 09 Nov 2026 10:15:00 GMT</pubDate><description>&lt;p&gt;Central banks&lt;/p&gt; pause</description></item>
          <item><title>Bad link</title><link>javascript:alert(1)</link></item>
        </channel></rss>"""
        [article] = markets_module.parse_rss(feed, "BBC Business")
        self.assertEqual(article["title"], "Fed & ECB hold rates")
        self.assertEqual(article["published_at"], "2026-11-09T10:15:00+00:00")
        self.assertEqual(article["summary"], "Central banks pause")
        bomb = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><rss><channel><item><title>&b;</title><link>https://x.example</link></item></channel></rss>'
        self.assertEqual(markets_module.parse_rss(bomb, "x"), [])
        self.assertEqual(markets_module.parse_rss(b"<not xml", "x"), [])

    def test_merge_dedupes_sorts_and_filters(self) -> None:
        a = {"title": "Nvidia beats estimates", "url": "https://a.example", "source": "A", "published_at": "2026-11-09T10:00:00+00:00", "summary": ""}
        b = {"title": "NVIDIA beats estimates!", "url": "https://b.example", "source": "B", "published_at": "2026-11-09T11:00:00+00:00", "summary": ""}
        c = {"title": "Pfizer to acquire biotech in $5bn deal", "url": "https://c.example", "source": "C", "published_at": "2026-11-09T12:00:00+00:00", "summary": ""}
        merged = markets_module.merge_articles([[a, c], [b]])
        self.assertEqual([m["url"] for m in merged], ["https://c.example", "https://a.example"])
        self.assertEqual([m["url"] for m in markets_module.merge_articles([[a, c]], query="nvidia")], ["https://a.example"])
        self.assertEqual([m["url"] for m in markets_module.merge_articles([[a, c]], category="merger")], ["https://c.example"])

    async def test_news_uses_rss_feeds_for_category(self) -> None:
        seen_hosts: set[str] = set()

        def handler(request: httpx.Request) -> httpx.Response:
            seen_hosts.add(request.url.host)
            return httpx.Response(200, content=f"<rss><channel><item><title>Story from {request.url.host}</title><link>https://{request.url.host}/s</link></item></channel></rss>".encode())

        with (
            patch.object(markets_module.settings, "finnhub_api_key", None),
            patch.object(markets_module, "_http_client", _mock_http(handler)),
        ):
            async with _client(_app(markets_module.router)) as client:
                body = (await client.get("/api/markets/news?category=crypto")).json()
        self.assertEqual(seen_hosts, {"www.coindesk.com", "cointelegraph.com"})
        self.assertEqual(body["source"], "CoinDesk, Cointelegraph")
        self.assertEqual(len(body["articles"]), 2)

    async def test_news_falls_back_to_gdelt_when_feeds_fail(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host != "api.gdeltproject.org":
                return httpx.Response(500)
            return httpx.Response(200, json={"articles": [{"url": "https://n.example/x", "title": "Markets rally", "domain": "n.example"}]})

        with (
            patch.object(markets_module.settings, "finnhub_api_key", None),
            patch.object(markets_module, "_http_client", _mock_http(handler)),
        ):
            async with _client(_app(markets_module.router)) as client:
                body = (await client.get("/api/markets/news?category=crypto")).json()
        self.assertEqual(body["source"], "GDELT Project")
        self.assertEqual(body["articles"][0]["title"], "Markets rally")

    async def test_news_query_rejects_operators(self) -> None:
        async with _client(_app(markets_module.router)) as client:
            response = await client.get('/api/markets/news?q=a" OR domain:evil')
        self.assertEqual(response.status_code, 422)

    async def test_quotes_require_key_and_validate_symbols(self) -> None:
        async with _client(_app(markets_module.router)) as client:
            with patch.object(markets_module.settings, "finnhub_api_key", None):
                self.assertEqual((await client.get("/api/markets/quotes?symbols=AAPL")).status_code, 503)
            with patch.object(markets_module.settings, "finnhub_api_key", "k"):
                self.assertEqual((await client.get("/api/markets/quotes?symbols=../etc")).status_code, 422)

    async def test_quotes_normalize_and_report_unknown_symbols(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers["X-Finnhub-Token"], "k")
            if request.url.params["symbol"] == "AAPL":
                return httpx.Response(200, json={"c": 190.5, "d": 1.5, "dp": 0.79, "h": 191, "l": 188, "o": 189, "pc": 189, "t": 1762682400})
            return httpx.Response(200, json={"c": 0, "d": None, "dp": None, "h": 0, "l": 0, "o": 0, "pc": 0, "t": 0})

        with (
            patch.object(markets_module.settings, "finnhub_api_key", "k"),
            patch.object(markets_module, "_http_client", _mock_http(handler)),
        ):
            async with _client(_app(markets_module.router)) as client:
                body = (await client.get("/api/markets/quotes?symbols=aapl,ZZZZ")).json()
        self.assertEqual(body["quotes"][0]["symbol"], "AAPL")
        self.assertEqual(body["quotes"][0]["price"], 190.5)
        self.assertEqual(body["missing"], ["ZZZZ"])


class EconomyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        economy_module._cache.clear()

    async def test_indicator_series_is_sorted_and_validated(self) -> None:
        payload = [{"page": 1}, [
            {"country": {"value": "Portugal"}, "date": "2023", "value": 4.3},
            {"country": {"value": "Portugal"}, "date": "2022", "value": 7.8},
            {"country": {"value": "Portugal"}, "date": "2021", "value": None},
        ]]

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertIn("/country/PT/indicator/FP.CPI.TOTL.ZG", request.url.path)
            return httpx.Response(200, json=payload)

        with patch.object(economy_module, "_http_client", _mock_http(handler)):
            async with _client(_app(economy_module.router)) as client:
                body = (await client.get("/api/economy/indicators?country=pt&indicator=inflation")).json()
                bad_country = await client.get("/api/economy/indicators?country=P1")
                bad_indicator = await client.get("/api/economy/indicators?indicator=../x")
        self.assertEqual(body["country_name"], "Portugal")
        self.assertEqual([p["year"] for p in body["points"]], [2022, 2023])
        self.assertEqual(bad_country.status_code, 422)
        self.assertEqual(bad_indicator.status_code, 422)


class OrganizeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        organize_module._writes.clear()

    async def test_status_is_honest_about_mail_connectors(self) -> None:
        with (
            patch.object(organize_module.settings, "notion_token", None),
            patch.object(organize_module.settings, "gmail_client_id", None),
            patch.object(organize_module.settings, "outlook_client_id", None),
        ):
            async with _client(_app(organize_module.router)) as client:
                body = (await client.get("/api/organize/status")).json()
        statuses = {c["id"]: c["status"] for c in body["connectors"]}
        self.assertEqual(statuses, {"notion": "not-configured", "gmail": "not-configured", "outlook": "not-configured"})

    async def test_notion_requires_session(self) -> None:
        with patch.object(organize_module, "_current_user", AsyncMock(return_value=None)):
            async with _client(_app(organize_module.router)) as client:
                response = await client.post("/api/organize/notion/tasks", json={"title": "x"})
        self.assertEqual(response.status_code, 401)

    def test_notion_page_payload(self) -> None:
        task = organize_module.NotionTask(title=" Pagar fatura ", notes="Ver email da EDP", due=date(2026, 11, 20))
        page = organize_module.build_notion_page(task, "a" * 32, "Name")
        self.assertEqual(page["parent"], {"database_id": "a" * 32})
        self.assertEqual(page["properties"]["Name"]["title"][0]["text"]["content"], "Pagar fatura")
        self.assertEqual(len(page["children"]), 2)

    async def test_notion_create_task_calls_api_with_server_token(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers["Authorization"], "Bearer secret_x")
            self.assertEqual(request.url.path, "/v1/pages")
            return httpx.Response(200, json={"id": "p1", "url": "https://www.notion.so/p1"})

        with (
            patch.object(organize_module, "_current_user", AsyncMock(return_value=SimpleNamespace(id="u1"))),
            patch.object(organize_module.settings, "notion_token", "secret_x"),
            patch.object(organize_module.settings, "notion_database_id", "b" * 32),
            patch.object(organize_module, "_http_client", _mock_http(handler)),
        ):
            async with _client(_app(organize_module.router)) as client:
                response = await client.post("/api/organize/notion/tasks", json={"title": "Rever orçamento"})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["url"], "https://www.notion.so/p1")


if __name__ == "__main__":
    unittest.main()
