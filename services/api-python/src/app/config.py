"""Configuração central da aplicação (settings, diretórios, redação de segredos)."""
from __future__ import annotations

import os
import time
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL, make_url

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
LOG_DIR = BASE_DIR / "logs"

REDACTED = "***REDACTED***"
_SENSITIVE_KEYS = {"password", "secret", "token", "key", "authorization", "api_key"}

load_dotenv()


def env(name: str, default: str | None = None) -> str | None:
    return os.getenv(name, default)


def _is_sensitive(key: str) -> bool:
    key_lower = key.lower()
    return any(marker in key_lower for marker in _SENSITIVE_KEYS)


def redact(value: Any) -> Any:
    """Redação profunda e segura de estruturas de dados (dicts/listas/tuplos)."""
    if isinstance(value, Mapping):
        return {
            str(k): (REDACTED if _is_sensitive(str(k)) else redact(v))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return type(value)(redact(v) for v in value)
    if isinstance(value, Iterable) and not isinstance(value, (str, bytes)):
        try:
            return [redact(v) for v in value]
        except Exception:
            return value
    return value


def _ensure_dirs(*dirs: Path) -> None:
    """Criação segura e idempotente de diretórios; nunca quebra a app."""
    for d in dirs:
        try:
            d.mkdir(parents=True, exist_ok=True)
            try:
                d.chmod(0o700)
            except Exception:
                pass
        except Exception:
            continue


def _auto_cleanup(path: Path, days: int = 30) -> None:
    """Remove ficheiros mais antigos que X dias e diretórios vazios."""
    if not path.exists():
        return
    cutoff = time.time() - (days * 86400)
    for item in path.iterdir():
        try:
            if item.is_symlink():
                continue
            if item.is_file():
                if item.stat().st_mtime < cutoff:
                    item.unlink()
                continue
            if item.is_dir():
                _auto_cleanup(item, days=days)
                if not any(item.iterdir()):
                    item.rmdir()
        except Exception:
            continue


_ensure_dirs(DATA_DIR, LOG_DIR)


class Settings(BaseSettings):
    """Configuração da aplicação, carregada de variáveis de ambiente / .env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Aegis"
    debug: bool = False

    # Origens autorizadas para CORS (frontend em dev/produção), separadas por vírgula.
    cors_origins: str = "http://localhost:5173,http://localhost:5174"

    # A chave deve ser fornecida em produção; não existe fallback previsível.
    secret_key: str = ""

    # PostgreSQL de contas, workspaces e faturação.
    database_url: str | None = None
    database_host: str = "localhost"
    database_port: int = Field(default=5432, ge=1, le=65535)
    database_name: str = "protectia"
    database_user: str = "protectia"
    database_password: str | None = None

    # Cloudflare DNS API
    cloudflare_api_token: str | None = None
    cloudflare_zone_id: str | None = None
    cloudflare_account_id: str | None = None

    # Assistente de IA compatível com a API Chat Completions da OpenAI.
    ai_api_key: str | None = None
    ai_base_url: str = "https://api.openai.com/v1"
    ai_model: str = "gpt-4o-mini"

    # Chat multi-IA (/api/chat). Cada fornecedor só aparece se a chave estiver definida.
    # Claude usa o SDK oficial; OpenAI e xAI (Grok) usam a API compatível com Chat Completions.
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-opus-5-5"
    anthropic_effort: str = Field(default="medium", pattern="^(low|medium|high|xhigh|max)$")
    xai_api_key: str | None = None
    xai_base_url: str = "https://api.x.ai/v1"
    xai_model: str = "grok-4"
    chat_requests_per_hour: int = Field(default=60, ge=1, le=1000)

    # Firewall da aplicação (WAF) — ver src/app/firewall.py.
    firewall_enabled: bool = True
    firewall_requests_per_minute: int = Field(default=240, ge=10, le=10_000)
    firewall_burst: int = Field(default=60, ge=5, le=2_000)
    firewall_ban_threshold: int = Field(default=20, ge=3, le=1_000)
    firewall_ban_minutes: int = Field(default=60, ge=1, le=10_080)
    firewall_max_body_bytes: int = Field(default=2_000_000, ge=10_000, le=50_000_000)
    firewall_threat_feeds: bool = True
    # Listas separadas por vírgulas de IPs/CIDR. A blocklist bloqueia sempre; a allowlist
    # nunca é bloqueada nem limitada. TRUSTED_PROXIES: proxies cujo X-Forwarded-For é aceite.
    firewall_blocklist: str = ""
    firewall_allowlist: str = ""
    trusted_proxies: str = ""

    # Supervisão por IA (Claude): revê respostas do chat e faz triagem de eventos de segurança.
    supervisor_enabled: bool = True
    supervisor_model: str = "claude-opus-5-5"
    # Emails (verificados) com acesso ao centro de segurança, separados por vírgulas.
    security_admin_emails: str = ""

    # Mercados: Finnhub (cotações e notícias) se houver chave; GDELT (sem chave) para notícias.
    finnhub_api_key: str | None = None

    # Organização: integração interna do Notion (token do servidor, base de dados de tarefas).
    notion_token: str | None = None
    notion_database_id: str | None = None
    notion_version: str = "2022-06-28"
    notion_title_property: str = "Name"

    # Organização: leitura de email por utilizador (OAuth Authorization Code + PKCE, só leitura).
    # Clientes OAuth próprios, separados do login. Os tokens ficam cifrados com MAIL_TOKEN_ENC_KEY.
    gmail_client_id: str | None = None
    gmail_client_secret: str | None = None
    gmail_redirect_uri: str | None = None
    outlook_client_id: str | None = None
    outlook_client_secret: str | None = None
    outlook_tenant: str = Field(default="common", pattern=r"^[A-Za-z0-9.-]{1,64}$")
    outlook_redirect_uri: str | None = None
    mail_token_enc_key: str | None = None
    mail_requests_per_hour: int = Field(default=120, ge=1, le=2000)
    public_api_url: str = "http://localhost:8000"


    # Contactos comerciais: cifrados individualmente e conservados por prazo limitado.
    sales_lead_enc_key: str | None = None
    sales_lead_db_path: Path = DATA_DIR / "sales_leads.sqlite3"
    sales_lead_retention_days: int = Field(default=30, ge=1, le=365)
    assistant_requests_per_hour: int = Field(default=20, ge=1, le=300)
    auth_requests_per_minute: int = Field(default=10, ge=1, le=300)

    # Stripe Checkout e portal; IDs de preço são configurados no Dashboard Stripe.
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None
    stripe_price_starter: str | None = None
    stripe_price_growth: str | None = None
    stripe_price_scale: str | None = None
    public_frontend_url: str = "http://localhost:5173"

    @property
    def sqlalchemy_database_url(self) -> URL:
        if self.database_url and self.database_url.strip():
            url = make_url(self.database_url)
            if url.drivername in {"postgres", "postgresql"}:
                url = url.set(drivername="postgresql+asyncpg")
            return url
        if not self.database_password:
            raise RuntimeError("DATABASE_URL ou DATABASE_PASSWORD não definido.")
        return URL.create(
            "postgresql+asyncpg",
            username=self.database_user,
            password=self.database_password,
            host=self.database_host,
            port=self.database_port,
            database=self.database_name,
        )

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    def require_secret_key(self) -> str:
        environment = os.getenv("ENV", "development").lower()
        if environment == "production" and not self.secret_key:
            raise RuntimeError("SECRET_KEY não definido em produção — abortando.")
        if environment == "production" and not (self.database_url or self.database_password):
            raise RuntimeError("DATABASE_URL/DATABASE_PASSWORD não definido em produção — abortando.")
        return self.secret_key


settings = Settings()
