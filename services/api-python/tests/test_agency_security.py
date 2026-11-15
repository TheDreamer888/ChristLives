from __future__ import annotations

import hashlib
import hmac
import time
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from src.app.auth.routes import _safe_oauth_return_path
from src.app.auth.store import Store
from src.app.routers import agency
from src.app.routers.agency import _verify_stripe_signature


class OAuthReturnPathTests(unittest.TestCase):
    def test_only_invitation_hash_paths_are_preserved(self) -> None:
        token = "A" * 43
        self.assertEqual(_safe_oauth_return_path(f"invite/{token}"), f"invite/{token}")
        self.assertEqual(_safe_oauth_return_path("https://attacker.example/"), "overview")
        self.assertEqual(_safe_oauth_return_path("../admin"), "overview")
        self.assertEqual(_safe_oauth_return_path(None), "overview")


class VerifiedEmailTests(unittest.IsolatedAsyncioTestCase):
    async def test_unverified_email_cannot_create_an_account_or_agency(self) -> None:
        with self.assertRaisesRegex(ValueError, "email não verificado"):
            await Store().get_or_create_user(
                email="invitee@example.com",
                name="Invitee",
                method="provider",
            )


class StripeSignatureTests(unittest.TestCase):
    def test_accepts_a_valid_signature(self) -> None:
        payload = b'{"id":"evt_test","type":"checkout.session.completed"}'
        secret = "whsec_test"
        timestamp = str(int(time.time()))
        digest = hmac.new(
            secret.encode(),
            timestamp.encode() + b"." + payload,
            hashlib.sha256,
        ).hexdigest()

        with patch("src.app.routers.agency.settings.stripe_webhook_secret", secret):
            self.assertTrue(_verify_stripe_signature(payload, f"t={timestamp},v1={digest}"))

    def test_rejects_tampered_payload_and_stale_signature(self) -> None:
        payload = b'{"id":"evt_test"}'
        secret = "whsec_test"
        timestamp = str(int(time.time()) - 301)
        digest = hmac.new(
            secret.encode(),
            timestamp.encode() + b"." + payload,
            hashlib.sha256,
        ).hexdigest()

        with patch("src.app.routers.agency.settings.stripe_webhook_secret", secret):
            self.assertFalse(_verify_stripe_signature(payload + b" ", f"t={timestamp},v1={digest}"))
            self.assertFalse(
                _verify_stripe_signature(
                    payload,
                    f"t={int(time.time())},v1={'0' * 64}",
                )
            )


class TeamSecurityEventsRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_manager_can_list_team_events(self) -> None:
        user = object()
        agency_ref = type("AgencyRef", (), {"id": "agency-1"})()
        request = object()
        mocked_events = [{"id": "event-1", "event_type": "login"}]

        with (
            patch("src.app.routers.agency._require_user", new=AsyncMock(return_value=user)),
            patch("src.app.routers.agency._current_agency", new=AsyncMock(return_value=(agency_ref, "owner"))),
            patch("src.app.routers.agency.list_agency_security_events", new=AsyncMock(return_value=mocked_events)) as loader,
        ):
            response = await agency.list_team_security_events(request)

        self.assertEqual(response, {"events": mocked_events})
        loader.assert_awaited_once_with("agency-1")

    async def test_member_cannot_list_team_events(self) -> None:
        user = object()
        agency_ref = type("AgencyRef", (), {"id": "agency-1"})()
        request = object()

        with (
            patch("src.app.routers.agency._require_user", new=AsyncMock(return_value=user)),
            patch("src.app.routers.agency._current_agency", new=AsyncMock(return_value=(agency_ref, "member"))),
            patch("src.app.routers.agency.list_agency_security_events", new=AsyncMock()) as loader,
            self.assertRaises(HTTPException) as raised,
        ):
            await agency.list_team_security_events(request)

        self.assertEqual(raised.exception.status_code, 403)
        loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
