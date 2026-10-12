"""OAuth2/OIDC provider registry.

Only standards-based flows are used (Authorization Code + PKCE), which is the
flow recommended by OAuth 2.0 Security Best Current Practice (RFC 9700) for
browser-based clients. Client secrets never reach the frontend: the SPA only
ever talks to our own backend, which holds the secrets and performs the
code<->token exchange server-side.

To add another provider ("todas as alternativas"), add an entry to
``PROVIDERS`` — no other code needs to change, since routes.py is generic.
"""
from __future__ import annotations

from dataclasses import dataclass
from src.app.config import env


@dataclass(frozen=True)
class OAuthProvider:
    name: str
    display_name: str
    authorize_url: str
    token_url: str
    userinfo_url: str
    scope: str
    client_id: str | None
    client_secret: str | None
    # Maps provider-specific userinfo JSON keys to our normalized schema.
    id_field: str = "id"
    email_field: str = "email"
    name_field: str = "name"
    email_verified_field: str = "email_verified"


def _provider(
    name: str,
    display_name: str,
    authorize_url: str,
    token_url: str,
    userinfo_url: str,
    scope: str,
    id_field: str = "id",
    email_field: str = "email",
    name_field: str = "name",
    email_verified_field: str = "email_verified",
) -> OAuthProvider:
    prefix = name.upper()
    return OAuthProvider(
        name=name,
        display_name=display_name,
        authorize_url=authorize_url,
        token_url=token_url,
        userinfo_url=userinfo_url,
        scope=scope,
        client_id=env(f"{prefix}_CLIENT_ID"),
        client_secret=env(f"{prefix}_CLIENT_SECRET"),
        id_field=id_field,
        email_field=email_field,
        name_field=name_field,
        email_verified_field=email_verified_field,
    )


PROVIDERS: dict[str, OAuthProvider] = {
    p.name: p
    for p in [
        _provider(
            "google",
            "Google",
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://oauth2.googleapis.com/token",
            "https://openidconnect.googleapis.com/v1/userinfo",
            "openid email profile",
            id_field="sub",
        ),
        _provider(
            "microsoft",
            "Microsoft",
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            "https://graph.microsoft.com/oidc/userinfo",
            "openid email profile",
            id_field="sub",
        ),
        _provider(
            "github",
            "GitHub",
            "https://github.com/login/oauth/authorize",
            "https://github.com/login/oauth/access_token",
            "https://api.github.com/user",
            "read:user user:email",
            id_field="id",
            email_field="email",
            name_field="name",
            email_verified_field="verified",
        ),
        # Extra alternatives ("todas as alternativas") — enabled automatically
        # once the matching *_CLIENT_ID / *_CLIENT_SECRET env vars are set.
        _provider(
            "gitlab",
            "GitLab",
            "https://gitlab.com/oauth/authorize",
            "https://gitlab.com/oauth/token",
            "https://gitlab.com/api/v4/user",
            "read_user",
            email_verified_field="confirmed_at",
        ),
        _provider(
            "apple",
            "Apple",
            "https://appleid.apple.com/auth/authorize",
            "https://appleid.apple.com/auth/token",
            "",
            "name email",
        ),
        _provider(
            "discord",
            "Discord",
            "https://discord.com/api/oauth2/authorize",
            "https://discord.com/api/oauth2/token",
            "https://discord.com/api/users/@me",
            "identify email",
            email_verified_field="verified",
        ),
    ]
}


def enabled_providers() -> list[OAuthProvider]:
    """Providers with credentials configured — what the login tab may show."""
    return [
        p
        for p in PROVIDERS.values()
        if p.client_id and p.client_secret and p.userinfo_url
    ]
