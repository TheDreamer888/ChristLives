import time
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.app.routers.protection import ThreatFeed, inspect_url, router


class ProtectionTests(unittest.TestCase):
    def test_local_rules(self):
        for value in (
            "http://example.com", "https://user:pass@example.com",
            "https://127.0.0.1", "https://[::1]", "localhost",
            "https://example.local", "https://example.com:8443",
            "https://example.com/payload%2Eexe", "https://example.com/run.ps1",
        ):
            with self.subTest(value=value):
                self.assertTrue(inspect_url(value)[1])

    def test_normalizes_domain_without_fetching(self):
        self.assertEqual(inspect_url("EXAMPLE.COM."), ("example.com", []))
        self.assertEqual(inspect_url("https://example.com/a?q=setup.exe")[1], [])

    def test_invalid_urls(self):
        from fastapi import HTTPException
        for value in ("", "javascript://alert", "https://exa mple.com", "https://example.com:invalid", "https://evil.com\\@example.com"):
            with self.subTest(value=value), self.assertRaises(HTTPException):
                inspect_url(value)

    def test_api_verdicts_and_parent_matching(self):
        app = FastAPI()
        app.include_router(router)
        with patch("src.app.routers.protection.feed.get", new_callable=AsyncMock, return_value=frozenset({"evil.example"})):
            with TestClient(app) as client:
                for url, verdict in (
                    ("https://evil.example", "blocked"),
                    ("https://sub.evil.example", "blocked"),
                    ("https://notevil.example", "not_listed"),
                    ("https://example.com", "not_listed"),
                    ("http://example.com", "blocked"),
                ):
                    response = client.post("/api/protect/check-url", json={"url": url})
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()["verdict"], verdict)
                self.assertEqual(client.post("/api/protect/check-url", json={"url": "x" * 2049}).status_code, 422)


class ThreatFeedTests(unittest.IsolatedAsyncioTestCase):
    async def test_download_and_format_validation(self):
        from fastapi import HTTPException
        for text, valid in (("# Source\nbad.example\n", True), ("<html>error</html>", False), ("# empty", False)):
            cache = ThreatFeed()
            transport = httpx.MockTransport(lambda request: httpx.Response(200, text=text))
            client = httpx.AsyncClient(transport=transport)
            with patch("src.app.routers.protection.httpx.AsyncClient", return_value=client):
                if valid:
                    self.assertEqual(await cache.get(), frozenset({"bad.example"}))
                    self.assertIsNotNone(cache.updated_at)
                else:
                    with self.assertRaises(HTTPException) as error:
                        await cache.get()
                    self.assertEqual(error.exception.status_code, 503)

    async def test_expired_feed_failure_is_explicit(self):
        from fastapi import HTTPException
        cache = ThreatFeed()
        cache.domains = frozenset({"old.example"})
        cache.refreshed = time.monotonic() - 9 * 3600
        with patch("src.app.routers.protection.httpx.AsyncClient") as client:
            client.return_value.__aenter__.side_effect = httpx.ConnectError("offline")
            with self.assertRaises(HTTPException) as error:
                await cache.get()
        self.assertEqual(error.exception.status_code, 503)
        with self.assertRaises(HTTPException):
            await cache.get()

    async def test_fresh_cache_does_not_download(self):
        cache = ThreatFeed()
        cache.domains = frozenset({"evil.example"})
        cache.refreshed = time.monotonic()
        with patch("src.app.routers.protection.httpx.AsyncClient") as client:
            self.assertEqual(await cache.get(), cache.domains)
            client.assert_not_called()
