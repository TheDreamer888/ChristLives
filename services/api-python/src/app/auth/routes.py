"""Auth routes: OAuth (Google/Microsoft/GitHub/...), WebAuthn passkeys,
backup-code recovery, session, and legal consent.

Security notes:
- Authorization Code + PKCE for every OAuth provider (RFC 9700 recommendation
  for public/browser clients); client secrets stay server-side only.
- `state` and the PKCE `code_verifier` travel in a short-lived HttpOnly cookie,
  never in client-readable storage, to prevent CSRF/replay. The cookie is
  cleared on every exit path of the callback.
- The final session is an httpOnly/Secure/SameSite cookie (see tokens.py) —
  JavaScript never sees a bearer token.
- Cookies são Secure por omissão; só ficam sem Secure se ENV for de desenvolvimento.
- Contas OAuth são identificadas por (provedor, subject); o email só liga a uma
  conta existente quando o provedor o confirmou como verificado.
- Credenciais (email, código de backup) viajam no corpo do POST, nunca no URL.
- Registar passkey e gerar códigos exigem uma sessão recente (step-up) e os
  pedidos de escrita validam o header Origin.
- Pedidos de autenticação têm limite por IP e por conta; email desconhecido e
  conhecido são indistinguíveis (sem enumeração de utilizadores).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import threading
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from passlib.hash import bcrypt
from pydantic import BaseModel, Field

from src.app.auth.providers import PROVIDERS, enabled_providers
from src.app.auth.ratelimit import limiter
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
from src.app.auth.tokens import SESSION_COOKIE_NAME, issue_session_token, verify_session_token
from src.app.auth import webauthn as wa

router = APIRouter(prefix="/api/auth", tags=["auth"])

_OAUTH_FLOW_COOKIE = "oauth_flow"
_IS_DEV = os.getenv("ENV", "production").lower() in {"development", "dev", "test"}
_SECURE_COOKIES = not _IS_DEV
_STEP_UP_SECONDS = int(os.getenv("AUTH_STEP_UP_SECONDS", "900"))
_ENUM_SECRET = (os.getenv("AUTH_ENUM_SECRET") or secrets.token_hex(32)).encode()
_GENERIC_RECOVERY_ERROR = "Código inválido ou já utilizado."
_GENERIC_PASSKEY_ERROR = "Chave de segurança inválida ou desafio expirado."
_DUMMY_HASH = bcrypt.hash("dummy-code-for-timing-parity")  # igualar tempo quando o email não existe
_REDEEM_LOCK = threading.Lock()  # consumo atómico dos códigos (store em memória, uma instância)

# Campo "email verificado" devolvido por cada provedor no userinfo.
# Provedores ausentes (ex.: Microsoft) não garantem a verificação: o email é ignorado.
_EMAIL_VERIFIED_FIELD = {"google": "email_verified", "discord": "verified", "gitlab": "confirmed_at"}


class EmailBody(BaseModel):
    email: str = Field(min_length=3, max_length=254)


class RedeemBody(EmailBody):
    code: str = Field(min_length=4, max_length=64)


# ---- helpers ---------------------------------------------------------------

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _norm_email(email: str) -> str:
    return email.strip().lower()


def _redirect_uri(provider: str) -> str:
    base = os.getenv("PUBLIC_API_URL", "http://localhost:8000").rstrip("/")
    return f"{base}/api/auth/oauth/{provider}/callback"


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


def _flow_error(status: int, message: str) -> HTTPException:
    """Erro que também apaga o cookie do fluxo OAuth (impede repetição)."""
    cookie = f"{_OAUTH_FLOW_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=lax"
    if _SECURE_COOKIES:
        cookie += "; Secure"
    return HTTPException(status, message, headers={"Set-Cookie": cookie})


def _too_many(retry_after: int) -> HTTPException:
    return HTTPException(
        429,
        "Demasiadas tentativas de autenticação. Tenta novamente mais tarde.",
        headers={"Retry-After": str(retry_after)},
    )


def _rate_limit_ip(request: Request) -> None:
    # Atrás de um proxy configura o uvicorn com --proxy-headers/--forwarded-allow-ips,
    # senão este IP é o do proxy e todos os utilizadores partilham o mesmo limite.
    ip = request.client.host if request.client else "unknown"
    retry_after = limiter.hit(f"ip:{ip}", limit=30, window_seconds=60)
    if retry_after is not None:
        raise _too_many(retry_after)


def _rate_limit_account(scope: str, email: str, limit: int, window_seconds: int) -> None:
    key = f"{scope}:" + hashlib.sha256(_norm_email(email).encode()).hexdigest()
    retry_after = limiter.hit(key, limit=limit, window_seconds=window_seconds)
    if retry_after is not None:
        raise _too_many(retry_after)


def _require_same_origin(request: Request) -> None:
    """Defesa em profundidade além de SameSite=Lax para escritas com cookie."""
    origin = request.headers.get("origin")
    if origin is None:
        return  # cliente não-browser; os browsers enviam sempre Origin em escritas cross-site
    allowed = os.getenv("PUBLIC_FRONTEND_URL", "http://localhost:5173").rstrip("/")
    if origin.rstrip("/") != allowed:
        raise HTTPException(403, "Origem não permitida.")


def _session_claims(request: Request) -> dict | None:
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None
    claims = verify_session_token(token)
    if not claims or not isinstance(claims.get("sub"), str):
        return None
    return claims


def _current_user(request: Request) -> UserRecord | None:
    claims = _session_claims(request)
    if not claims:
        return None
    return store.users.get(claims["sub"])


def _require_user(request: Request) -> UserRecord:
    user = _current_user(request)
    if not user:
        raise HTTPException(401, "Autentica-te primeiro.")
    return user


def _require_fresh_user(request: Request) -> UserRecord:
    """Step-up: alterações que dão acesso duradouro exigem sessão recente."""
    claims = _session_claims(request)
    user = store.users.get(claims["sub"]) if claims else None
    if not claims or not user:
        raise HTTPException(401, "Autentica-te primeiro.")
    iat = claims.get("iat")
    if not isinstance(iat, (int, float)) or time.time() - iat > _STEP_UP_SECONDS:
        raise HTTPException(
            403,
            "Por segurança, inicia sessão novamente antes de alterar os métodos de acesso.",
        )
    return user


def _start_session(user: UserRecord, response: Response) -> None:
    token = issue_session_token(user.id, list(user.linked_methods))
    _set_secure_cookie(response, SESSION_COOKIE_NAME, token, max_age=8 * 3600)


def _fake_credential_ids(email: str) -> list[bytes]:
    """Isco determinístico: emails desconhecidos parecem contas com uma chave."""
    return [hmac.new(_ENUM_SECRET, _norm_email(email).encode(), hashlib.sha256).digest()]


def _find_user_by_email(email: str) -> UserRecord | None:
    user_id = store.email_index.get(email) or store.email_index.get(_norm_email(email))
    return store.users.get(user_id) if user_id else None


def _subject(info: dict, id_field: str) -> str | None:
    value = info.get(id_field)
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str) and value.strip() and len(value.strip()) <= 255:
        return value.strip()
    return None


def _verified_email(provider: str, info: dict, email_field: str) -> tuple[str | None, bool]:
    email = info.get(email_field)
    field = _EMAIL_VERIFIED_FIELD.get(provider)
    flag = info.get(field) if field else None
    verified = flag is True or (field == "confirmed_at" and isinstance(flag, str) and bool(flag))
    if not verified or not isinstance(email, str) or not email.strip():
        return None, False
    return _norm_email(email), True


def _github_verified_email(client: httpx.Client, access_token: str) -> str | None:
    resp = client.get(
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
                    return _norm_email(email)
    return None


# ---- OAuth -----------------------------------------------------------------

@router.get("/providers")
def list_providers() -> dict:
    """What the login tab renders — adapts automatically to configured env vars."""
    return {
        "oauth": [{"id": p.name, "name": p.display_name} for p in enabled_providers() if p.userinfo_url],
        "webauthn": True,
        "backup_codes": True,
    }


@router.get(
    "/oauth/{provider}/start",
    response_model=OAuthStartResponse,
    dependencies=[Depends(_rate_limit_ip)],
)
def oauth_start(provider: str, response: Response) -> OAuthStartResponse:
    p = PROVIDERS.get(provider)
    if not p or not (p.client_id and p.client_secret and p.userinfo_url):
        raise HTTPException(404, "Provedor indisponível")

    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(64)
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())

    query = httpx.QueryParams(
        {
            "client_id": p.client_id,
            "redirect_uri": _redirect_uri(provider),
            "response_type": "code",
            "scope": p.scope,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    _set_secure_cookie(response, _OAUTH_FLOW_COOKIE, f"{provider}:{state}:{verifier}", max_age=600)
    return OAuthStartResponse(authorize_url=f"{p.authorize_url}?{query}", state=state)


@router.get("/oauth/{provider}/callback", dependencies=[Depends(_rate_limit_ip)])
def oauth_callback(
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
    parts = flow.split(":", 2)
    if len(parts) != 3:
        raise _flow_error(400, "Fluxo de login inválido — tenta novamente.")
    saved_provider, saved_state, verifier = parts
    if saved_provider != provider or not secrets.compare_digest(saved_state, state):
        raise _flow_error(400, "State inválido — possível CSRF.")

    p = PROVIDERS.get(provider)
    if not p or not (p.client_id and p.client_secret and p.userinfo_url):
        raise _flow_error(404, "Provedor indisponível")

    try:
        with httpx.Client(timeout=10) as client:
            token_resp = client.post(
                p.token_url,
                data={
                    "client_id": p.client_id,
                    "client_secret": p.client_secret,
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": _redirect_uri(provider),
                    "code_verifier": verifier,
                },
                headers={"Accept": "application/json"},
            )
            token_resp.raise_for_status()
            access_token = token_resp.json().get("access_token")
            if not isinstance(access_token, str) or not access_token:
                raise _flow_error(502, "Resposta inválida do provedor de autenticação.")

            userinfo_resp = client.get(
                p.userinfo_url,
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            )
            userinfo_resp.raise_for_status()
            info = userinfo_resp.json()
            if not isinstance(info, dict):
                raise _flow_error(502, "Resposta inválida do provedor de autenticação.")

            if provider == "github":
                email = _github_verified_email(client, access_token)
                email_verified = email is not None
            else:
                email, email_verified = _verified_email(provider, info, p.email_field)
    except HTTPException:
        raise
    except (httpx.HTTPError, ValueError) as exc:
        raise _flow_error(502, "Falha na comunicação com o provedor de autenticação.") from exc

    subject = _subject(info, p.id_field)
    if subject is None:
        raise _flow_error(502, f"O provedor {provider} não devolveu um identificador válido.")
    name = info.get(p.name_field)
    user = store.get_or_create_oauth_user(
        provider=provider,
        subject=subject,
        email=email,
        name=name if isinstance(name, str) else None,
        email_verified=email_verified,
    )

    _start_session(user, response)
    response.delete_cookie(_OAUTH_FLOW_COOKIE, path="/")

    frontend_url = os.getenv("PUBLIC_FRONTEND_URL", "http://localhost:5173")
    response.status_code = 302
    response.headers["Location"] = f"{frontend_url}/#/login-success"
    return response


# ---- Session ---------------------------------------------------------------

@router.get("/session", response_model=SessionUser | None)
def session(request: Request):
    user = _current_user(request)
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
def logout(response: Response) -> dict:
    # Sem lista de sessões no servidor não há revogação: o token expira em 8h.
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    return {"ok": True}


# ---- WebAuthn passkeys / security keys ("keys/pen") ----

@router.post("/webauthn/register/options", dependencies=[Depends(_require_same_origin)])
def webauthn_register_options(request: Request) -> dict:
    user = _require_fresh_user(request)
    existing_ids = [_b64url_decode(cid) for cid in user.webauthn_credentials]
    options, options_json = wa.build_registration_options(user.id, user.email or user.id, existing_ids)
    challenge_id = secrets.token_urlsafe(16)
    store.webauthn_challenges.set(challenge_id, (user.id, options.challenge))
    return {"challenge_id": challenge_id, "options": options_json}


@router.post("/webauthn/register/verify", dependencies=[Depends(_require_same_origin)])
def webauthn_register_verify(body: WebAuthnRegisterVerify, request: Request) -> dict:
    user = _require_fresh_user(request)
    entry = store.webauthn_challenges.pop(body.challenge_id)
    if not entry or entry[0] != user.id:
        raise HTTPException(400, "Desafio expirado.")
    _, challenge = entry
    try:
        verification = wa.verify_registration(body.credential, challenge)
    except Exception as exc:
        raise HTTPException(400, "Não foi possível registar a chave de segurança.") from exc
    cred_id_b64 = _b64url(verification.credential_id)
    user.webauthn_credentials[cred_id_b64] = {
        "public_key": verification.credential_public_key,
        "sign_count": verification.sign_count,
        "label": (body.device_label or "Chave de segurança").strip()[:64],
    }
    user.linked_methods.add("passkey")
    return {"ok": True}


@router.post(
    "/webauthn/login/options",
    dependencies=[Depends(_rate_limit_ip), Depends(_require_same_origin)],
)
def webauthn_login_options(body: EmailBody) -> dict:
    _rate_limit_account("pk", body.email, limit=10, window_seconds=60)
    user = _find_user_by_email(body.email)
    allowed_ids = [_b64url_decode(cid) for cid in user.webauthn_credentials] if user else []
    has_keys = bool(allowed_ids)
    if not has_keys:
        # Email desconhecido ou sem chaves: responde como uma conta com uma chave.
        allowed_ids = _fake_credential_ids(body.email)
    options, options_json = wa.build_authentication_options(allowed_ids)
    challenge_id = secrets.token_urlsafe(16)
    store.webauthn_challenges.set(challenge_id, (user.id if user and has_keys else None, options.challenge))
    return {"challenge_id": challenge_id, "options": options_json}


@router.post(
    "/webauthn/login/verify",
    dependencies=[Depends(_rate_limit_ip), Depends(_require_same_origin)],
)
def webauthn_login_verify(body: WebAuthnLoginVerify, response: Response) -> dict:
    entry = store.webauthn_challenges.pop(body.challenge_id)
    if not entry:
        raise HTTPException(400, _GENERIC_PASSKEY_ERROR)
    user_id, challenge = entry
    user = store.users.get(user_id) if user_id else None
    if not user:
        raise HTTPException(400, _GENERIC_PASSKEY_ERROR)
    cred_id_b64 = body.credential.get("id") if isinstance(body.credential, dict) else None
    cred = user.webauthn_credentials.get(cred_id_b64) if isinstance(cred_id_b64, str) else None
    if not cred:
        raise HTTPException(400, _GENERIC_PASSKEY_ERROR)
    try:
        verification = wa.verify_authentication(
            body.credential, challenge, cred["public_key"], cred["sign_count"]
        )
    except Exception as exc:
        raise HTTPException(400, _GENERIC_PASSKEY_ERROR) from exc
    cred["sign_count"] = verification.new_sign_count

    _start_session(user, response)
    return {"ok": True}


# ---- Recovery when a factor is lost ----

@router.post(
    "/recovery/backup-codes/generate",
    response_model=BackupCodesResponse,
    dependencies=[Depends(_require_same_origin)],
)
def generate_codes(request: Request) -> BackupCodesResponse:
    user = _require_fresh_user(request)
    plaintext, hashes = generate_backup_codes()
    user.backup_code_hashes = hashes
    return BackupCodesResponse(codes=plaintext)  # shown once, never stored/logged in plaintext


@router.post(
    "/recovery/backup-codes/redeem",
    dependencies=[Depends(_rate_limit_ip), Depends(_require_same_origin)],
)
def redeem_code(body: RedeemBody, response: Response) -> dict:
    _rate_limit_account("rc", body.email, limit=5, window_seconds=900)
    user = _find_user_by_email(body.email)
    if not user:
        bcrypt.verify(body.code, _DUMMY_HASH)  # igualar o tempo de resposta
        raise HTTPException(400, _GENERIC_RECOVERY_ERROR)
    with _REDEEM_LOCK:
        idx = verify_backup_code(body.code, user.backup_code_hashes)
        if idx is None:
            raise HTTPException(400, _GENERIC_RECOVERY_ERROR)
        user.backup_code_hashes.pop(idx)  # one-time use
        remaining = len(user.backup_code_hashes)
    _start_session(user, response)
    return {"ok": True, "remaining_codes": remaining}


# ---- Legal / consent (GDPR Art. 7, LGPD Art. 8: freely given, recorded consent) ----

@router.post("/consent", dependencies=[Depends(_require_same_origin)])
def record_consent(body: ConsentRequest, request: Request) -> dict:
    user = _require_user(request)
    if not (body.terms_accepted and body.privacy_accepted):
        raise HTTPException(400, "É necessário aceitar os Termos e a Política de Privacidade.")
    user.consent = {**body.model_dump(), "recorded_at": time.time()}
    return {"ok": True}
