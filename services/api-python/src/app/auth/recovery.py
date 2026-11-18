"""Account recovery when a factor is lost ("se perdeu vai ter de mudar/conectar
com outras alternativas").

Two legally-common, audited approaches are combined:
1. One-time backup codes (like GitHub/Google) generated at enrollment and
   hashed at rest (never stored in plaintext) — used when every linked
   provider/passkey is unavailable.
2. Multi-provider account linking: an account can have several sign-in
   methods attached at once, so losing one (e.g. a broken phone with the
   passkey) still allows sign-in via Google/Microsoft/GitHub etc., after
   which the user can register a replacement factor.
"""
from __future__ import annotations

import secrets

import bcrypt

# Os códigos têm 17 bytes; o limite de 72 do bcrypt nunca é atingido. O passlib
# foi removido (sem manutenção desde 2020 e incompatível com o bcrypt 5).


def hash_code(code: str) -> str:
    return bcrypt.hashpw(code.encode(), bcrypt.gensalt()).decode()


def check_code(code: str, stored: str) -> bool:
    raw = code.encode()
    if len(raw) > 72:
        return False
    try:
        return bcrypt.checkpw(raw, stored.encode())
    except ValueError:
        return False


def generate_backup_codes(count: int = 10) -> tuple[list[str], list[str]]:
    """Returns (plaintext_codes_to_show_once, hashes_to_persist)."""
    plaintext = [f"{secrets.token_hex(4)}-{secrets.token_hex(4)}" for _ in range(count)]
    hashed = [hash_code(code) for code in plaintext]
    return plaintext, hashed


def verify_backup_code(code: str, stored_hashes: list[str]) -> int | None:
    """Returns the index of the matching (and now consumed) hash, or None."""
    for idx, stored in enumerate(stored_hashes):
        if check_code(code, stored):
            return idx
    return None
