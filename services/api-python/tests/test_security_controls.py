from __future__ import annotations

import unittest
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from src.app.auth.routes import _enforce_auth_rate_limit
from src.app.security import consume_auth_rate_limit


class AuthenticationRateLimitDependencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_exceeded_bucket_returns_retry_after(self) -> None:
        request = MagicMock()
        request.client.host = "127.0.0.1"
        with (
            patch("src.app.auth.routes.consume_auth_rate_limit", new_callable=AsyncMock, return_value=17),
            self.assertRaises(HTTPException) as raised,
        ):
            await _enforce_auth_rate_limit(request)
        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(raised.exception.headers, {"Retry-After": "17"})

    async def test_allowed_attempt_continues(self) -> None:
        request = MagicMock()
        request.client.host = "127.0.0.1"
        with patch("src.app.auth.routes.consume_auth_rate_limit", new_callable=AsyncMock, return_value=None):
            await _enforce_auth_rate_limit(request)


class _AsyncContext:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None


class _Session(_AsyncContext):
    def __init__(self, result) -> None:
        self.result = result
        self.statements = []

    def begin(self):
        return _AsyncContext()

    async def execute(self, statement):
        self.statements.append(statement)
        if len(self.statements) == 1:
            return None
        return self.result


class _Result:
    def __init__(self, count: int, started_at: datetime) -> None:
        self.row = (count, started_at)

    def one(self):
        return self.row


class DistributedRateLimitTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_retry_after_when_the_shared_bucket_exceeds_limit(self) -> None:
        now = datetime.now(UTC)
        database_session = _Session(_Result(3, now))
        factory = MagicMock(return_value=database_session)

        with (
            patch("src.app.security.session_factory", return_value=factory),
            patch("src.app.security.settings.auth_requests_per_minute", 2),
        ):
            retry_after = await consume_auth_rate_limit("127.0.0.1")

        self.assertIsNotNone(retry_after)
        self.assertGreaterEqual(retry_after, 1)
        self.assertEqual(len(database_session.statements), 2)
        parameters = database_session.statements[1].compile().params
        self.assertNotIn("127.0.0.1", repr(parameters))

    async def test_allows_requests_inside_the_shared_bucket_limit(self) -> None:
        database_session = _Session(_Result(2, datetime.now(UTC)))
        factory = MagicMock(return_value=database_session)

        with (
            patch("src.app.security.session_factory", return_value=factory),
            patch("src.app.security.settings.auth_requests_per_minute", 2),
        ):
            retry_after = await consume_auth_rate_limit("127.0.0.1")

        self.assertIsNone(retry_after)


if __name__ == "__main__":
    unittest.main()
