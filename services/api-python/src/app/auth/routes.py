"""Auth routes: OAuth (Google/Microsoft/GitHub/...), WebAuthn passkeys,
backup-code recovery, session, and legal consent.

Security notes:
- Authorization Code + PKCE for every OAuth provider (RFC 9700); client
  secrets stay server-side only.
- `state` and the PKCE `code_verifier` travel in a short-lived HttpOnly,
  SameSite cookie, never in JavaScript-readable storage. The cookie is cleared
  on every exit path, so a flow can't be replayed.
- The final session is an httpOnly/Secure/SameSite cookie (see tokens.py) —
  JavaScript never sees a bearer token.
- Cookies are Secure unless ENV is explicitly a development value (fail closed).
- Credentials (emails, backup codes) travel in POST bodies, never in URLs.
- Actions that create durable access (new passkey, new backup codes) need a
  recently issued session (step-up); mutating routes check the Origin header.
- Unknown-email and known-email paths are indistinguishable for WebAuthn
  options and backup-code redemption (no user enumeration).
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import os
import re
import secrets
import time
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from src.app.auth import webauthn as wa
from src.app.auth.providers import PROVIDERS, OAuthProvider, enabled_providers
from src.app.auth.recovery import generate_backup_codes, verify_backup_code
from src.app.auth.schemas import (
    BackupCodesResponse,
    ConsentRequest,
    OAuthStartResponse,
    SessionUser,
    WebAuthnLoginVerify,
    WebAuthnRegisterVerify,
)
from src.app.auth.store import UserRecord, store
from src.app.auth.tokens import (
    SESSION_COOKIE_NAME,
    issue_session_token,
    verify_session_token,
)
from src.app.security import (
    consume_auth_rate_limit,
    create_auth_session,
    is_auth_session_active,
    list_auth_sessions,
    list_security_events,
    record_security_event,
    revoke_auth_session,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

_OAUTH_FLOW_COOKIE = "oauth_flow"
_IS_DEV = os.getenv("ENV", "production").lower() in {"development", "dev", "test"}
_SECURE_COOKIES = not _IS_DEV
_INVITE_RETURN_PATH = re.compile(r"invite/[A-Za-z0-9_-]{32,128}\Z")
_STEP_UP_SECONDS = int(os.getenv("AUTH_STEP_UP_SECONDS", "900"))
_ENUM_SECRET = (os.getenv("AUTH_ENUM_SECRET") or secrets.token_hex(32)).encode()
_GENERIC_RECOVERY_ERROR = "Código inválido ou já utilizado."
_GENERIC_PASSKEY_ERROR = "Chave de segurança inválida ou desafio expirado."
# Burns the same hashing work when the e-mail is unknown (timing parity).
_DUMMY_HASHES = generate_backup_codes()[1][:1]

# Serialises read-modify-write of backup codes per user inside this process.
# Multi-worker deployments still need an atomic compare-and-remove in the store.
_REDEEM_LOCKS = [asyncio.Lock() for _ in range(64)]


class EmailBody(BaseModel):
    email: str = Field(min_length=3, max_length=254)


class RedeemBody(EmailBody):
    code: str = Field(min_length=4, max_length=64)


# ---- helpers ---------------------------------------------------------------

def _safe_oauth_return_path(value: str | None) -> str:
    if value and _INVITE_RETURN_PATH.fullmatch(value):
        return value
    return "overview"


def _oauth_subject(provider: str, info: dict, config: OAuthProvider) -> str:
    subject = info.get(config.id_field)
    if isinstance(subject, str) and subject.strip():
        value = subject.strip()
        if len(value) <= 255:
            return value
    if isinstance(subject, int) and not isinstance(subject, bool):
        return str(subject)
    raise HTTPException(502, f"O provedor {provider} não devolveu um identificador válido.")


def _verified_oauth_email(
    provider: str, info: dict, config: OAuthProvider
) -> tuple[str | None, bool]:
    email = info.get(config.email_field)
    verification = info.get(config.email_verified_field)
    verified = verification is True or (
        config.email_verified_field == "confirmed_at"
        and isinstance(verification, str)
        and bool(verification)
    )
    if provider == "microsoft" and not verified:
        # Microsoft e-mails are attacker-controllable (nOAuth): never link by them.
        return None, False
    if not isinstance(email, str) or not email.strip():
        raise HTTPException(403, "O provedor de autenticação não disponibilizou um e-mail.")
    if not verified:
        raise HTTPException(403, "O provedor de autenticação não confirmou que o email está verificado.")
    return email.strip(), True


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _oauth_redirect_uri(provider: str) -> str:
    public_api_url = os.getenv("PUBLIC_API_URL", "http://localhost:8000").rstrip("/")
    return f"{public_api_url}/api/auth/oauth/{provider}/callback"


def _set_secure_cookie(response: Response, name: str, value: str, max_age: int) -> None:
    response.set_cookie(
        name,
        value,
        max_age=max_age,
        httponly=True,
        secure=_SECURE_COOKIES,
        samesite="lax",
        path="/",
    )


def _clear_cookie_header() -> dict[str, str]:
    """Set-Cookie header that deletes the OAuth flow cookie (usable on errors)."""
    value = f"{_OAUTH_FLOW_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=lax"
    if _SECURE_COOKIES:
        value += "; Secure"
    return {"Set-Cookie": value}


def _flow_error(status: int, message: str) -> HTTPException:
    return HTTPException(status, message, headers=_clear_cookie_header())


def _client_key(request: Request) -> str | None:
    # Behind a reverse proxy configure uvicorn `--proxy-headers` with a trusted
    # `--forwarded-allow-ips`, otherwise this is the proxy's address.
    return request.client.host if request.client else None


async def _enforce_auth_rate_limit(request: Request) -> None:
    retry_after = await consume_auth_rate_limit(_client_key(request))
    if retry_after is not None:
        raise HTTPException(
            429,
            "Demasiadas tentativas de autenticação. Tenta novamente mais tarde.",
            headers={"Retry-After": str(retry_after)},
        )


async def _enforce_account_rate_limit(email: str) -> None:
    """Per-account budget so distributed IPs can't brute-force one account."""
    key = "acct:" + hashlib.sha256(email.strip().lower().encode()).hexdigest()
    retry_after = await consume_auth_rate_limit(key)
    if retry_after is not None:
        raise HTTPException(
            429,
            "Demasiadas tentativas de autenticação. Tenta novamente mais tarde.",
            headers={"Retry-After": str(retry_after)},
        )


async def _require_same_origin(request: Request) -> None:
    """Defence in depth on top of SameSite=Lax for cookie-authenticated writes."""
    origin = request.headers.get("origin")
    if origin is None:
        return  # non-browser client; browsers always send Origin on cross-site writes
    allowed = os.getenv("PUBLIC_FRONTEND_URL", "http://localhost:5173").rstrip("/")
    if origin.rstrip("/") != allowed:
        raise HTTPException(403, "Origem não permitida.")


def _require_fresh_session(claims: dict) -> None:
    """Step-up: durable-access changes need a recently issued session."""
    iat = claims.get("iat")
    if not isinstance(iat, (int, float)) or time.time() - iat > _STEP_UP_SECONDS:
        raise HTTPException(
            403,
            "Por segurança, inicia sessão novamente antes de alterar os métodos de acesso.",
        )


def _fake_credential_ids(email: str) -> list[bytes]:
    """Deterministic decoy so unknown e-mails look like accounts with one key."""
    digest = hmac.new(_ENUM_SECRET, email.strip().lower().encode(), hashlib.sha256).digest()
    return [digest]


async def _start_authenticated_session(
    user: UserRecord,
    response: Response,
    method: str,
    severity: str = "info",
) -> None:
    session_id = str(uuid.uuid4())
    await create_auth_session(user.id, session_id)
    await record_security_event(
        user.id,
        "login",
        severity=severity,
        details={"method": method},
    )
    token = issue_session_token(user.id, list(user.linked_methods), session_id)
    _set_secure_cookie(response, SESSION_COOKIE_NAME, token, max_age=8 * 3600)


async def _session_claims(request: Request) -> dict | None:
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None
    claims = verify_session_token(token)
    if not claims or not isinstance(claims.get("sub"), str) or not isinstance(claims.get("jti"), str):
        return None
    if not await is_auth_session_active(claims["sub"], claims["jti"]):
        return None
    return claims


async def _require_claims(request: Request) -> dict:
    claims = await _session_claims(request)
    if not claims:
        raise HTTPException(401, "Autentica-te primeiro.")
    return claims


async def _current_user(request: Request) -> UserRecord | None:
    claims = await _session_claims(request)
    if not claims:
        return None
    return await store.get_user(claims["sub"])


async def _require_user(request: Request) -> UserRecord:
    user = await _current_user(request)
    if not user:
        raise HTTPException(401, "Autentica-te primeiro.")
    return user


# ---- OAuth -----------------------------------------------------------------

@router.get("/providers")
def list_providers() -> dict:
    """What the login tab renders — adapts automatically to configured env vars."""
    return {
        "oauth": [{"id": p.name, "name": p.display_name} for p in enabled_providers()],
        "webauthn": True,
        "backup_codes": True,
    }


@router.get(
    "/oauth/{provider}/start",
    response_model=OAuthStartResponse,
    dependencies=[Depends(_enforce_auth_rate_limit)],
)
def oauth_start(
    provider: str,
    response: Response,
    return_to: str | None = Query(default=None, max_length=140),
) -> OAuthStartResponse:
    p = PROVIDERS.get(provider)
    if not p or not (p.client_id and p.client_secret and p.userinfo_url):
        raise HTTPException(404, "Provedor indisponível")

    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(64)
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())

    query = httpx.QueryParams(
        {
            "client_id": p.client_id,
            "redirect_uri": _oauth_redirect_uri(provider),
            "response_type": "code",
            "scope": p.scope,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    return_path = _safe_oauth_return_path(return_to)
    _set_secure_cookie(
        response,
        _OAUTH_FLOW_COOKIE,
        f"{provider}:{state}:{verifier}:{return_path}",
        max_age=600,
    )
    return OAuthStartResponse(authorize_url=f"{p.authorize_url}?{query}", state=state)


async def _github_verified_email(client: httpx.AsyncClient, access_token: str) -> str:
    resp = await client.get(
        "https://api.github.com/user/emails",
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/vnd.github+json"},
    )
    resp.raise_for_status()
    entries = resp.json()
    if isinstance(entries, list):
        for entry in entries:
            if isinstance(entry, dict) and entry.get("primary") is True and entry.get("verified") is True:
                email = entry.get("email")
                if isinstance(email, str) and email.strip():
                    return email.strip()
    raise HTTPException(403, "A conta GitHub não tem um email principal verificado.")


@router.get("/oauth/{provider}/callback", dependencies=[Depends(_enforce_auth_rate_limit)])
async def oauth_callback(
    provider: str,
    request: Request,
    response: Response,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    flow = request.cookies.get(_OAUTH_FLOW_COOKIE)
    if not flow:
        raise _flow_error(400, "Fluxo de login expirado, tenta novamente.")
    if error:
        raise _flow_error(400, "Autorização recusada ou cancelada no provedor.")
    if not code or not state:
        raise _flow_error(400, "Resposta de autorização incompleta.")
    try:
        saved_provider, saved_state, verifier, return_path = flow.split(":", 3)
    except ValueError as exc:
        raise _flow_error(400, "Fluxo de login inválido — tenta novamente.") from exc
    if saved_provider != provider or not secrets.compare_digest(saved_state, state):
        raise _flow_error(400, "State inválido — possível CSRF.")
    return_path = _safe_oauth_return_path(return_path)

    p = PROVIDERS.get(provider)
    if not p or not p.userinfo_url:
        raise _flow_error(404, "Provedor indisponível")

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            token_resp = await client.post(
                p.token_url,
                data={
                    "client_id": p.client_id,
                    "client_secret": p.client_secret,
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": _oauth_redirect_uri(provider),
                    "code_verifier": verifier,
                },
                headers={"Accept": "application/json"},
            )
            token_resp.raise_for_status()
            access_token = token_resp.json().get("access_token")
            if not isinstance(access_token, str) or not access_token:
                raise HTTPException(502, "Resposta inválida do provedor de autenticação.")

            userinfo_resp = await client.get(
                p.userinfo_url,
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            )
            userinfo_resp.raise_for_status()
            info = userinfo_resp.json()
            if not isinstance(info, dict):
                raise HTTPException(502, "Resposta inválida do provedor de autenticação.")

            if provider == "github":
                email, email_verified = await _github_verified_email(client, access_token), True
            else:
                email, email_verified = _verified_oauth_email(provider, info, p)
    except HTTPException as exc:
        raise _flow_error(exc.status_code, exc.detail) from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise _flow_error(502, "Falha na comunicação com o provedor de autenticação.") from exc

    try:
        subject = _oauth_subject(provider, info, p)
    except HTTPException as exc:
        raise _flow_error(exc.status_code, exc.detail) from exc
    name = info.get(p.name_field)
    user = await store.get_or_create_oauth_user(
        provider=provider,
        subject=subject,
        email=email,
        name=name if isinstance(name, str) else None,
        email_verified=email_verified,
    )

    await _start_authenticated_session(user, response, provider)
    response.delete_cookie(_OAUTH_FLOW_COOKIE, path="/")

    frontend_url = os.getenv("PUBLIC_FRONTEND_URL", "http://localhost:5173")
    response.status_code = 302
    response.headers["Location"] = f"{frontend_url}/#/{return_path}"
    return response


# ---- Session ---------------------------------------------------------------

@router.get("/session", response_model=SessionUser | None)
async def session(request: Request):
    user = await _current_user(request)
    if not user:
        return None
    return SessionUser(
        id=user.id,
        email=user.email,
        name=user.name,
        linked_methods=sorted(user.linked_methods),
        mfa_enrolled=bool(user.webauthn_credentials or user.backup_code_hashes),
    )


@router.post("/logout", dependencies=[Depends(_require_same_origin)])
async def logout(request: Request, response: Response) -> dict:
    claims = await _session_claims(request)
    if claims:
        await record_security_event(claims["sub"], "logout")
        await revoke_auth_session(claims["sub"], claims["jti"])
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/sessions")
async def get_sessions(request: Request) -> dict:
    claims = await _require_claims(request)
    return {"sessions": await list_auth_sessions(claims["sub"], claims["jti"])}


@router.delete("/sessions/{session_id}", dependencies=[Depends(_require_same_origin)])
async def end_session(session_id: str, request: Request) -> dict:
    claims = await _require_claims(request)
    if session_id == claims["jti"]:
        raise HTTPException(400, "Usa «Terminar sessão» para terminar a sessão atual.")
    if not await revoke_auth_session(claims["sub"], session_id):
        raise HTTPException(404, "Sessão ativa não encontrada.")
    await record_security_event(claims["sub"], "session_revoked")
    return {"ok": True}


@router.get("/security/events")
async def get_security_events(request: Request) -> dict:
    user = await _require_user(request)
    return {"events": await list_security_events(user.id)}


# ---- WebAuthn passkeys / security keys ("keys/pen") -------------------------

@router.post("/webauthn/register/options", dependencies=[Depends(_require_same_origin)])
async def webauthn_register_options(request: Request) -> dict:
    claims = await _require_claims(request)
    _require_fresh_session(claims)
    user = await store.get_user(claims["sub"])
    if not user:
        raise HTTPException(401, "Autentica-te primeiro com um dos provedores.")
    existing_ids = [_b64url_decode(cid) for cid in user.webauthn_credentials]
    options, options_json = wa.build_registration_options(user.id, user.email or user.id, existing_ids)
    challenge_id = secrets.token_urlsafe(16)
    await store.set_challenge(challenge_id, user.id, options.challenge, ttl_seconds=300)
    return {"challenge_id": challenge_id, "options": options_json}


@router.post("/webauthn/register/verify", dependencies=[Depends(_require_same_origin)])
async def webauthn_register_verify(body: WebAuthnRegisterVerify, request: Request) -> dict:
    claims = await _require_claims(request)
    _require_fresh_session(claims)
    user = await store.get_user(claims["sub"])
    if not user:
        raise HTTPException(401, "Autentica-te primeiro.")
    entry = await store.pop_challenge(body.challenge_id)
    if not entry or entry[0] != user.id:
        raise HTTPException(400, "Desafio expirado.")
    _, challenge = entry
    try:
        verification = wa.verify_registration(body.credential, challenge)
    except Exception as exc:
        await record_security_event(user.id, "passkey_register_failed", severity="warning")
        raise HTTPException(400, "Não foi possível registar a chave de segurança.") from exc
    cred_id_b64 = _b64url(verification.credential_id)
    credentials = user.webauthn_credentials or {}
    credentials[cred_id_b64] = {
        "public_key": verification.credential_public_key,
        "sign_count": verification.sign_count,
        "label": (body.device_label or "Chave de segurança").strip()[:64],
    }
    user.webauthn_credentials = credentials
    user.linked_methods.add("passkey")
    await store.save_user(user)
    await record_security_event(user.id, "passkey_registered")
    return {"ok": True}


@router.post(
    "/webauthn/login/options",
    dependencies=[Depends(_enforce_auth_rate_limit), Depends(_require_same_origin)],
)
async def webauthn_login_options(body: EmailBody) -> dict:
    await _enforce_account_rate_limit(body.email)
    user = await store.get_user_by_email(body.email)
    allowed_ids = [_b64url_decode(cid) for cid in user.webauthn_credentials] if user else []
    if not allowed_ids:
        # Unknown e-mail, or no keys: respond like an account with one key.
        allowed_ids = _fake_credential_ids(body.email)
    options, options_json = wa.build_authentication_options(allowed_ids)
    challenge_id = secrets.token_urlsafe(16)
    await store.set_challenge(
        challenge_id,
        user.id if user and user.webauthn_credentials else None,
        options.challenge,
        ttl_seconds=300,
    )
    return {"challenge_id": challenge_id, "options": options_json}


@router.post(
    "/webauthn/login/verify",
    dependencies=[Depends(_enforce_auth_rate_limit), Depends(_require_same_origin)],
)
async def webauthn_login_verify(body: WebAuthnLoginVerify, response: Response) -> dict:
    entry = await store.pop_challenge(body.challenge_id)
    if not entry:
        raise HTTPException(400, _GENERIC_PASSKEY_ERROR)
    user_id, challenge = entry
    user = await store.get_user(user_id) if user_id else None
    if not user:
        raise HTTPException(400, _GENERIC_PASSKEY_ERROR)

    cred_id_b64 = body.credential.get("id") if isinstance(body.credential, dict) else None
    cred = user.webauthn_credentials.get(cred_id_b64) if isinstance(cred_id_b64, str) else None
    if not cred:
        await record_security_event(user.id, "passkey_failed", severity="warning")
        raise HTTPException(400, _GENERIC_PASSKEY_ERROR)
    try:
        verification = wa.verify_authentication(
            body.credential, challenge, cred["public_key"], cred["sign_count"]
        )
    except Exception as exc:
        await record_security_event(user.id, "passkey_failed", severity="warning")
        raise HTTPException(400, _GENERIC_PASSKEY_ERROR) from exc
    cred["sign_count"] = verification.new_sign_count
    await store.save_user(user)

    await _start_authenticated_session(user, response, "passkey")
    return {"ok": True}


# ---- Recovery when a factor is lost -----------------------------------------

@router.post(
    "/recovery/backup-codes/generate",
    response_model=BackupCodesResponse,
    dependencies=[Depends(_require_same_origin)],
)
async def generate_codes(request: Request) -> BackupCodesResponse:
    claims = await _require_claims(request)
    _require_fresh_session(claims)
    user = await store.get_user(claims["sub"])
    if not user:
        raise HTTPException(401, "Autentica-te primeiro.")
    plaintext, hashes = generate_backup_codes()
    user.backup_code_hashes = hashes
    await store.save_user(user)
    await record_security_event(user.id, "backup_codes_generated", severity="warning")
    return BackupCodesResponse(codes=plaintext)  # shown once, never stored/logged in plaintext


@router.post(
    "/recovery/backup-codes/redeem",
    dependencies=[Depends(_enforce_auth_rate_limit), Depends(_require_same_origin)],
)
async def redeem_code(body: RedeemBody, response: Response) -> dict:
    await _enforce_account_rate_limit(body.email)
    user = await store.get_user_by_email(body.email)
    if not user:
        verify_backup_code(body.code, _DUMMY_HASHES)  # timing parity
        raise HTTPException(400, _GENERIC_RECOVERY_ERROR)

    lock = _REDEEM_LOCKS[hash(user.id) % len(_REDEEM_LOCKS)]
    async with lock:
        fresh = await store.get_user(user.id) or user  # re-read inside the lock
        idx = verify_backup_code(body.code, fresh.backup_code_hashes)
        if idx is None:
            await record_security_event(fresh.id, "recovery_failed", severity="warning")
            raise HTTPException(400, _GENERIC_RECOVERY_ERROR)
        fresh.backup_code_hashes.pop(idx)  # one-time use
        await store.save_user(fresh)
    await _start_authenticated_session(fresh, response, "backup_code", severity="warning")
    return {"ok": True, "remaining_codes": len(fresh.backup_code_hashes)}


# ---- Legal / consent (GDPR Art. 7, LGPD Art. 8: freely given, recorded consent) ----

@router.post("/consent", dependencies=[Depends(_require_same_origin)])
async def record_consent(body: ConsentRequest, request: Request) -> dict:
    user = await _require_user(request)
    if not (body.terms_accepted and body.privacy_accepted):
        raise HTTPException(400, "É necessário aceitar os Termos e a Política de Privacidade.")
    user.consent = {**body.model_dump(), "recorded_at": time.time()}
    await store.save_user(user)
    return {"ok": True}
