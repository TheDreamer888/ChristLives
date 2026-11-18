"""Passkeys / hardware security keys (WebAuthn, FIDO2) — the "keys/pen" option.

Uses the `webauthn` package (py_webauthn), the standard library for this in
Python. Passkeys are phishing-resistant and are the account-recovery-proof
alternative recommended by FIDO Alliance / NIST SP 800-63B for the "what if
the user loses a factor" scenario: a user can register *multiple* keys
(phone, USB key, platform authenticator) and any one of them logs them in.
"""
from __future__ import annotations

import os

from webauthn import (
    generate_registration_options,
    generate_authentication_options,
    verify_registration_response,
    verify_authentication_response,
    options_to_json,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    UserVerificationRequirement,
    ResidentKeyRequirement,
    PublicKeyCredentialDescriptor,
)

RP_ID = os.getenv("WEBAUTHN_RP_ID", "localhost")
RP_NAME = "Lusorbe"
ORIGIN = os.getenv("WEBAUTHN_ORIGIN", "http://localhost:5173")


def build_registration_options(user_id: str, username: str, existing_credential_ids: list[bytes]):
    options = generate_registration_options(
        rp_id=RP_ID,
        rp_name=RP_NAME,
        user_id=user_id.encode(),
        user_name=username,
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=cred_id) for cred_id in existing_credential_ids
        ],
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
    )
    return options, options_to_json(options)


def verify_registration(credential: dict, expected_challenge: bytes):
    return verify_registration_response(
        credential=credential,
        expected_challenge=expected_challenge,
        expected_origin=ORIGIN,
        expected_rp_id=RP_ID,
    )


def build_authentication_options(allowed_credential_ids: list[bytes]):
    options = generate_authentication_options(
        rp_id=RP_ID,
        allow_credentials=[
            PublicKeyCredentialDescriptor(id=cred_id) for cred_id in allowed_credential_ids
        ],
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    return options, options_to_json(options)


def verify_authentication(credential: dict, expected_challenge: bytes, public_key: bytes, sign_count: int):
    return verify_authentication_response(
        credential=credential,
        expected_challenge=expected_challenge,
        expected_origin=ORIGIN,
        expected_rp_id=RP_ID,
        credential_public_key=public_key,
        credential_current_sign_count=sign_count,
    )
