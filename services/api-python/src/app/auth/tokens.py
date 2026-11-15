"""Session issuance/verification.

Design choice: session tokens are kept in an httpOnly, Secure, SameSite=Lax
cookie and are never exposed to JavaScript at all — this is stronger than
"encrypted but readable by JS" storage (OWASP ASVS 3.4 / MDN guidance: avoid
localStorage for tokens because any XSS can read it). The cookie payload
itself is a JWE (encrypted JWT) so even the browser/user cannot read claims,
only the server can decrypt it with SESSION_ENC_KEY.
"""
from __future__ import annotations

import os
import time
import uuid
from typing import Any

import jwt
from cryptography.fernet import Fernet, InvalidToken

SESSION_COOKIE_NAME = "protectia_session"
SESSION_TTL_SECONDS = 60 * 60 * 8  # 8h


def _fernet() -> Fernet:
    key = os.getenv("SESSION_ENC_KEY")
    if not key:
        raise RuntimeError("SESSION_ENC_KEY não definido no ambiente.")
    return Fernet(key.encode())


def _signing_key() -> str:
    key = os.getenv("SESSION_JWT_SECRET")
    if not key:
        raise RuntimeError("SESSION_JWT_SECRET não definido no ambiente.")
    return key


def issue_session_token(
    user_id: str, methods: list[str], session_id: str | None = None
) -> str:
    """Sign then encrypt the session claims -> opaque cookie value."""
    now = int(time.time())
    claims = {
        "sub": user_id,
        "amr": methods,  # authentication methods used (google, passkey, ...)
        "jti": session_id or str(uuid.uuid4()),
        "iat": now,
        "exp": now + SESSION_TTL_SECONDS,
    }
    signed = jwt.encode(claims, _signing_key(), algorithm="HS256")
    return _fernet().encrypt(signed.encode()).decode()


def verify_session_token(token: str) -> dict[str, Any] | None:
    try:
        signed = _fernet().decrypt(token.encode()).decode()
        return jwt.decode(signed, _signing_key(), algorithms=["HS256"])
    except (InvalidToken, jwt.InvalidTokenError):
        return None
