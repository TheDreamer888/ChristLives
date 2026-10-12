from __future__ import annotations

import hashlib
import hmac
import time
import unittest
from unittest.mock import patch

from src.app.auth.routes import _safe_oauth_return_path
from src.app.auth.store import Store
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


if __name__ == "__main__":
    unittest.main()
