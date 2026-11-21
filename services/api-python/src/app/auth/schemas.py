"""Pydantic schemas for the auth module."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, EmailStr, Field


class OAuthStartResponse(BaseModel):
    authorize_url: str
    state: str


class SessionUser(BaseModel):
    id: str
    email: EmailStr | None = None
    name: str | None = None
    linked_methods: list[str] = []
    mfa_enrolled: bool = False


class WebAuthnRegisterVerify(BaseModel):
    credential: dict
    challenge_id: str
    device_label: str | None = None


class WebAuthnLoginVerify(BaseModel):
    credential: dict
    challenge_id: str


class BackupCodesResponse(BaseModel):
    codes: list[str]


class ConsentRequest(BaseModel):
    terms_accepted: bool
    privacy_accepted: bool
    marketing_opt_in: bool = False


class Ok(BaseModel):
    ok: Literal[True] = True


class ProviderInfo(BaseModel):
    id: str
    name: str


class ProvidersResponse(BaseModel):
    oauth: list[ProviderInfo]
    webauthn: bool
    backup_codes: bool


class WebAuthnOptions(BaseModel):
    challenge_id: str = Field(description="Devolve-o no passo de verificação. Uso único, expira em 5 minutos.")
    options: str = Field(description="PublicKeyCredential*Options em JSON (WebAuthn Level 3), para o navegador.")


class RedeemResult(Ok):
    remaining_codes: int
