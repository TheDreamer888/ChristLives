"""Configuração central da aplicação (settings, diretórios, redação de segredos)."""
from __future__ import annotations

import os
import time
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
LOG_DIR = BASE_DIR / "logs"

REDACTED = "***REDACTED***"
_SENSITIVE_KEYS = {"password", "secret", "token", "key", "authorization", "api_key"}


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


def env(name: str) -> str | None:
    """Lê uma variável de ambiente; vazio conta como não definida."""
    value = os.getenv(name, "").strip()
    return value or None


_ensure_dirs(DATA_DIR, LOG_DIR)


class Settings(BaseSettings):
    """Configuração da aplicação, carregada de variáveis de ambiente / .env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Aegis"
    debug: bool = False

    # Origens autorizadas para CORS (frontend em dev/produção), separadas por vírgula.
    cors_origins: str = "http://localhost:5173"

    # A chave deve ser fornecida em produção; não existe fallback previsível.
    secret_key: str = ""

    # Cloudflare DNS API
    cloudflare_api_token: str | None = None
    cloudflare_zone_id: str | None = None
    cloudflare_account_id: str | None = None

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    def require_secret_key(self) -> str:
        environment = os.getenv("ENV", "development").lower()
        if environment == "production" and not self.secret_key:
            raise RuntimeError("SECRET_KEY não definido em produção — abortando.")
        return self.secret_key


settings = Settings()
