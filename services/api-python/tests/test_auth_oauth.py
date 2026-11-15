from __future__ import annotations

import unittest
from dataclasses import replace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response

from src.app.auth import routes
from src.app.auth.providers import PROVIDERS
from src.app.auth.routes import _oauth_subject, _verified_oauth_email
from src.app.auth.store import UserRecord
from src.app.models import OAuthIdentity


class OAuthClaimTests(unittest.TestCase):
    def test_oauth_start_uses_public_api_url_without_trailing_slash(self) -> None:
        provider = replace(
            PROVIDERS["google"],
            client_id="test-client",
            client_secret="test-secret",
        )
        response = Response()

        with (
            patch.dict(routes.PROVIDERS, {"google": provider}),
            patch.dict("os.environ", {"PUBLIC_API_URL": "https://api.example.com/"}),
        ):
            result = routes.oauth_start("google", response, None)

        query = routes.httpx.QueryParams(result.authorize_url.partition("?")[2])
        self.assertEqual(
            query["redirect_uri"],
            "https://api.example.com/api/auth/oauth/google/callback",
        )
        self.assertIn("oauth_flow=", response.headers["set-cookie"])

    def test_microsoft_email_without_verification_is_not_used_for_account_linking(self) -> None:
        email, verified = _verified_oauth_email(
            "microsoft",
            {"email": "person@example.com"},
            PROVIDERS["microsoft"],
        )

        self.assertIsNone(email)
        self.assertFalse(verified)

    def test_unverified_google_email_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            _verified_oauth_email(
                "google",
                {"email": "person@example.com"},
                PROVIDERS["google"],
            )

        self.assertEqual(raised.exception.status_code, 403)

    def test_verified_google_email_is_normalized(self) -> None:
        email, verified = _verified_oauth_email(
            "google",
            {"email": " person@example.com ", "email_verified": True},
            PROVIDERS["google"],
        )

        self.assertEqual(email, "person@example.com")
        self.assertTrue(verified)

    def test_subject_accepts_string_and_github_numeric_ids(self) -> None:
        self.assertEqual(
            _oauth_subject("google", {"sub": "google-subject"}, PROVIDERS["google"]),
            "google-subject",
        )
        self.assertEqual(
            _oauth_subject("github", {"id": 1234}, PROVIDERS["github"]),
            "1234",
        )

    def test_missing_subject_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            _oauth_subject("microsoft", {}, PROVIDERS["microsoft"])

        self.assertEqual(raised.exception.status_code, 502)

    def test_external_identity_is_unique_per_provider_and_subject(self) -> None:
        primary_key = {column.name for column in OAuthIdentity.__table__.primary_key.columns}
        user_id_fk = next(iter(OAuthIdentity.__table__.c.user_id.foreign_keys))

        self.assertEqual(primary_key, {"provider", "subject"})
        self.assertEqual(user_id_fk.target_fullname, "users.id")
        self.assertEqual(user_id_fk.ondelete, "CASCADE")


class OAuthCallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_microsoft_callback_uses_subject_without_trusting_email(self) -> None:
        class MockOAuthClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, traceback):
                return None

            async def post(self, *args, **kwargs):
                return routes.httpx.Response(
                    200,
                    json={"access_token": "test-access-token"},
                    request=routes.httpx.Request("POST", args[0]),
                )

            async def get(self, *args, **kwargs):
                return routes.httpx.Response(
                    200,
                    json={
                        "sub": "microsoft-subject",
                        "email": "unverified@example.com",
                        "name": "Local User",
                    },
                    request=routes.httpx.Request("GET", args[0]),
                )

        request = Request(
            {
                "type": "http",
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/api/auth/oauth/microsoft/callback",
                "query_string": b"",
                "headers": [(b"cookie", b"oauth_flow=microsoft:state:verifier:overview")],
                "server": ("localhost", 8000),
                "client": ("127.0.0.1", 54321),
            }
        )
        response = Response()
        user = UserRecord(id="user-id", linked_methods={"microsoft"})

        with (
            patch.object(routes.httpx, "AsyncClient", return_value=MockOAuthClient()),
            patch.object(routes.store, "get_or_create_oauth_user", new_callable=AsyncMock) as get_user,
            patch.object(routes, "create_auth_session", new_callable=AsyncMock),
            patch.object(routes, "record_security_event", new_callable=AsyncMock),
            patch.object(routes, "issue_session_token", return_value="session-token"),
        ):
            get_user.return_value = user
            await routes.oauth_callback("microsoft", request, response, "code", "state")

        get_user.assert_awaited_once_with(
            provider="microsoft",
            subject="microsoft-subject",
            email=None,
            name="Local User",
            email_verified=False,
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "http://localhost:5173/#/overview")


if __name__ == "__main__":
    unittest.main()
