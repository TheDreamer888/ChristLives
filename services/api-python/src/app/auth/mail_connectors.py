"""Conectores de email por utilizador (Gmail e Outlook), apenas leitura.

Fluxo separado do login (``routes.py``), com clientes OAuth próprios:
- Authorization Code + PKCE (S256); o ``client_secret`` nunca sai do servidor.
- ``state``, ``code_verifier`` e o utilizador que iniciou o fluxo viajam num cookie
  HttpOnly cifrado com Fernet (MAIL_TOKEN_ENC_KEY), com prazo de 10 minutos e caminho
  restrito a ``/api/organize/mail``. O callback exige a mesma sessão que iniciou o fluxo.
- Scopes mínimos: ``gmail.readonly`` (Google) e ``Mail.Read`` + ``offline_access``
  (Microsoft Graph). Nada aqui envia, apaga ou altera emails.
- Tokens de acesso/refresh guardados cifrados (Fernet) na tabela ``mail_connections``,
  associados ao utilizador; nunca são devolvidos ao browser nem registados em logs.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

import httpx
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import delete, select

from src.app.config import settings
from src.app.database import session_factory
from src.app.models import MailConnection

MAIL_FLOW_COOKIE = "mail_oauth_flow"
MAIL_FLOW_COOKIE_PATH = "/api/organize/mail"
FLOW_TTL_SECONDS = 600
EXPIRY_SKEW_SECONDS = 60

GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
OUTLOOK_SCOPE = "offline_access https://graph.microsoft.com/Mail.Read"


@dataclass(frozen=True)
class MailProvider:
    id: str
    name: str
    authorize_url: str
    token_url: str
    scope: str
    revoke_url: str | None
    client_id: str | None
    client_secret: str | None
    redirect_uri: str
    env_prefix: str
    extra_authorize_params: tuple[tuple[str, str], ...] = ()

    def has_required_scope(self, granted: str) -> bool:
        scopes = {s.strip().lower() for s in granted.split() if s.strip()}
        if self.id == "gmail":
            return GMAIL_SCOPE in scopes
        # A Microsoft devolve o scope ora como URI completo, ora abreviado.
        return any(s == "mail.read" or s.endswith("/mail.read") for s in scopes)


MAIL_PROVIDER_IDS = ("gmail", "outlook")


def _redirect_uri(provider_id: str, configured: str | None) -> str:
    if configured and configured.strip():
        return configured.strip()
    return f"{settings.public_api_url.rstrip('/')}/api/organize/mail/{provider_id}/callback"


def mail_provider(provider_id: str) -> MailProvider | None:
    """Configuração lida no momento (permite alterar settings sem reiniciar nos testes)."""
    if provider_id == "gmail":
        return MailProvider(
            id="gmail",
            name="Gmail",
            authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
            # URL pública do endpoint de token (falso positivo do bandit B106).
            token_url="https://oauth2.googleapis.com/token",  # nosec B106
            scope=GMAIL_SCOPE,
            revoke_url="https://oauth2.googleapis.com/revoke",
            client_id=settings.gmail_client_id,
            client_secret=settings.gmail_client_secret,
            redirect_uri=_redirect_uri("gmail", settings.gmail_redirect_uri),
            env_prefix="GMAIL",
            # offline + consent: garante refresh_token; sem herdar outros scopes já concedidos.
            extra_authorize_params=(("access_type", "offline"), ("prompt", "consent"),
                                    ("include_granted_scopes", "false")),
        )
    if provider_id == "outlook":
        tenant = settings.outlook_tenant
        base = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0"
        return MailProvider(
            id="outlook",
            name="Outlook",
            authorize_url=f"{base}/authorize",
            token_url=f"{base}/token",
            scope=OUTLOOK_SCOPE,
            # A Microsoft não tem revogação por token; o utilizador remove o acesso na conta.
            revoke_url=None,
            client_id=settings.outlook_client_id,
            client_secret=settings.outlook_client_secret,
            redirect_uri=_redirect_uri("outlook", settings.outlook_redirect_uri),
            env_prefix="OUTLOOK",
            extra_authorize_params=(("response_mode", "query"), ("prompt", "select_account")),
        )
    return None


def mail_key_valid() -> bool:
    try:
        _fernet()
    except RuntimeError:
        return False
    return True


def missing_config(provider: MailProvider) -> list[str]:
    """Variáveis de ambiente em falta para este conector (mostradas na UI)."""
    missing = []
    if not provider.client_id:
        missing.append(f"{provider.env_prefix}_CLIENT_ID")
    if not provider.client_secret:
        missing.append(f"{provider.env_prefix}_CLIENT_SECRET")
    if not mail_key_valid():
        missing.append("MAIL_TOKEN_ENC_KEY")
    return missing


def _fernet() -> Fernet:
    key = settings.mail_token_enc_key
    if not key:
        raise RuntimeError("MAIL_TOKEN_ENC_KEY não definido.")
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise RuntimeError("MAIL_TOKEN_ENC_KEY não é uma chave Fernet válida.") from exc


# ---- fluxo OAuth -------------------------------------------------------------

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def start_flow(provider: MailProvider, user_id: str) -> tuple[str, str]:
    """Devolve (authorize_url, valor cifrado do cookie de fluxo)."""
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(64)
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    query = httpx.QueryParams({
        "client_id": provider.client_id or "",
        "redirect_uri": provider.redirect_uri,
        "response_type": "code",
        "scope": provider.scope,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        **dict(provider.extra_authorize_params),
    })
    flow = json.dumps({"p": provider.id, "s": state, "v": verifier, "u": user_id})
    cookie = _fernet().encrypt(flow.encode()).decode()
    return f"{provider.authorize_url}?{query}", cookie


def read_flow(cookie: str | None) -> dict[str, str] | None:
    """Decifra o cookie de fluxo; None se ausente, adulterado ou expirado."""
    if not cookie:
        return None
    try:
        raw = _fernet().decrypt(cookie.encode(), ttl=FLOW_TTL_SECONDS)
        data = json.loads(raw)
    except (InvalidToken, RuntimeError, ValueError):
        return None
    if not isinstance(data, dict) or not all(isinstance(data.get(k), str) and data.get(k) for k in "psvu"):
        return None
    return data


# ---- tokens ------------------------------------------------------------------

class MailAuthExpired(Exception):
    """O refresh token foi revogado/expirou: é preciso ligar a conta de novo."""


class MailScopeMissing(Exception):
    """O utilizador não concedeu a permissão de leitura pedida."""


@dataclass
class MailTokens:
    access_token: str
    refresh_token: str | None
    expires_at: float
    scope: str

    def expired(self, now: float | None = None) -> bool:
        return self.expires_at - EXPIRY_SKEW_SECONDS <= (now if now is not None else time.time())


def encrypt_tokens(tokens: MailTokens) -> str:
    return _fernet().encrypt(json.dumps(asdict(tokens)).encode()).decode()


def decrypt_tokens(ciphertext: str) -> MailTokens | None:
    try:
        data = json.loads(_fernet().decrypt(ciphertext.encode()))
        return MailTokens(
            access_token=str(data["access_token"]),
            refresh_token=data.get("refresh_token") if isinstance(data.get("refresh_token"), str) else None,
            expires_at=float(data["expires_at"]),
            scope=str(data.get("scope", "")),
        )
    except (InvalidToken, RuntimeError, ValueError, KeyError, TypeError):
        return None


def parse_token_response(
    provider: MailProvider, payload: object, previous: MailTokens | None = None
) -> MailTokens:
    if not isinstance(payload, dict):
        # ValueError (não TypeError): as rotas tratam-no como resposta inválida do fornecedor.
        raise ValueError("Resposta de token inválida.")  # noqa: TRY004
    access = payload.get("access_token")
    if not isinstance(access, str) or not access or len(access) > 16384:
        raise ValueError("Resposta de token sem access_token.")
    expires_in = payload.get("expires_in")
    try:
        lifetime = max(0, min(int(expires_in), 24 * 3600))
    except (TypeError, ValueError):
        lifetime = 3600
    refresh = payload.get("refresh_token")
    if not isinstance(refresh, str) or not refresh:
        refresh = previous.refresh_token if previous else None
    scope = payload.get("scope")
    if not isinstance(scope, str) or not scope.strip():
        scope = previous.scope if previous else ""
    if not provider.has_required_scope(scope):
        raise MailScopeMissing(provider.id)
    return MailTokens(access_token=access, refresh_token=refresh,
                      expires_at=time.time() + lifetime, scope=scope)


async def exchange_code(
    client: httpx.AsyncClient, provider: MailProvider, code: str, verifier: str
) -> MailTokens:
    response = await client.post(
        provider.token_url,
        data={
            "client_id": provider.client_id,
            "client_secret": provider.client_secret,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": provider.redirect_uri,
            "code_verifier": verifier,
            **({"scope": provider.scope} if provider.id == "outlook" else {}),
        },
        headers={"Accept": "application/json"},
    )
    response.raise_for_status()
    return parse_token_response(provider, response.json())


async def refresh_tokens(
    client: httpx.AsyncClient, provider: MailProvider, tokens: MailTokens
) -> MailTokens:
    if not tokens.refresh_token:
        raise MailAuthExpired(provider.id)
    response = await client.post(
        provider.token_url,
        data={
            "client_id": provider.client_id,
            "client_secret": provider.client_secret,
            "grant_type": "refresh_token",
            "refresh_token": tokens.refresh_token,
            **({"scope": provider.scope} if provider.id == "outlook" else {}),
        },
        headers={"Accept": "application/json"},
    )
    if response.status_code in (400, 401):
        # invalid_grant: revogado pelo utilizador, palavra-passe alterada ou expirado.
        raise MailAuthExpired(provider.id)
    response.raise_for_status()
    try:
        return parse_token_response(provider, response.json(), previous=tokens)
    except MailScopeMissing as exc:
        raise MailAuthExpired(provider.id) from exc


async def revoke_tokens(client: httpx.AsyncClient, provider: MailProvider, tokens: MailTokens) -> bool:
    """Revoga no fornecedor quando existe endpoint (Google). Melhor esforço."""
    if not provider.revoke_url:
        return False
    token = tokens.refresh_token or tokens.access_token
    try:
        response = await client.post(
            provider.revoke_url, data={"token": token},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    except httpx.HTTPError:
        return False
    return response.status_code == 200


# ---- persistência --------------------------------------------------------------

class MailTokenStore:
    """Tokens cifrados por (utilizador, fornecedor) no PostgreSQL."""

    async def get(self, user_id: str, provider: str) -> MailTokens | None:
        async with session_factory()() as session:
            row = await session.get(MailConnection, (user_id, provider))
        # Chave rodada ou dados corrompidos: tratado como "não ligado".
        return decrypt_tokens(row.token_ciphertext) if row else None

    async def save(self, user_id: str, provider: str, tokens: MailTokens) -> None:
        ciphertext = encrypt_tokens(tokens)
        async with session_factory()() as session, session.begin():
            row = await session.get(MailConnection, (user_id, provider), with_for_update=True)
            if row is None:
                session.add(MailConnection(user_id=user_id, provider=provider, token_ciphertext=ciphertext))
            else:
                row.token_ciphertext = ciphertext
                row.updated_at = datetime.now(UTC)

    async def delete(self, user_id: str, provider: str) -> tuple[bool, MailTokens | None]:
        """Remove a ligação; devolve (existia, tokens decifrados para revogação)."""
        async with session_factory()() as session, session.begin():
            row = await session.get(MailConnection, (user_id, provider), with_for_update=True)
            if row is None:
                return False, None
            tokens = decrypt_tokens(row.token_ciphertext)
            await session.execute(
                delete(MailConnection).where(
                    MailConnection.user_id == user_id, MailConnection.provider == provider
                )
            )
            return True, tokens

    async def providers(self, user_id: str) -> set[str]:
        async with session_factory()() as session:
            rows = await session.scalars(
                select(MailConnection.provider).where(MailConnection.user_id == user_id)
            )
            return set(rows.all())


mail_store = MailTokenStore()
