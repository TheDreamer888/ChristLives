"""Organização: tarefas no Notion e leitura de email (Gmail/Outlook) por utilizador.

Notion: integração interna (token do servidor) com uma base de dados de tarefas partilhada.
Como escreve num espaço da equipa, exige sessão iniciada e tem limite por utilizador.

Gmail e Outlook: OAuth por utilizador, só leitura (gmail.readonly / Mail.Read), num fluxo
separado do login — ver ``src/app/auth/mail_connectors.py``. Os tokens ficam cifrados no
servidor e nunca chegam ao browser. O conteúdo dos emails é dado não confiável
(``routers/mailbox.py`` converte-o em texto simples limitado). Nenhuma rota envia, apaga
ou altera emails.
"""
from __future__ import annotations

import re
import secrets
import time
from datetime import date
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from src.app.auth import mail_connectors as mc
from src.app.auth.mail_connectors import mail_store
from src.app.auth.routes import _SECURE_COOKIES, _current_user, _require_same_origin
from src.app.config import settings
from src.app.routers import mailbox
from src.app.security import record_security_event

router = APIRouter(prefix="/api/organize", tags=["organize"])

NOTION_API = "https://api.notion.com/v1"
_writes: dict[str, list[float]] = {}
_mail_reads: dict[str, list[float]] = {}
WRITES_PER_HOUR = 30
MailProviderId = Literal["gmail", "outlook"]


def _http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=15, follow_redirects=False)


def notion_configured() -> bool:
    return bool(settings.notion_token and settings.notion_database_id)


def _database_id() -> str:
    raw = (settings.notion_database_id or "").replace("-", "")
    if not re.fullmatch(r"[0-9a-fA-F]{32}", raw):
        raise HTTPException(status_code=503, detail="O identificador da base de dados Notion é inválido.")
    return raw


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.notion_token}",
        "Notion-Version": settings.notion_version,
        "Content-Type": "application/json",
    }


async def _user_id(request: Request) -> str:
    user = await _current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Inicia sessão para usar o Notion da equipa.")
    return user.id


class NotionTask(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    notes: str | None = Field(default=None, max_length=1800)
    due: date | None = None


def build_notion_page(task: NotionTask, database_id: str, title_property: str) -> dict[str, Any]:
    page: dict[str, Any] = {
        "parent": {"database_id": database_id},
        "properties": {title_property: {"title": [{"text": {"content": task.title.strip()}}]}},
    }
    children: list[dict[str, Any]] = []
    if task.due:
        children.append(_paragraph(f"Prazo: {task.due.isoformat()}"))
    if task.notes and task.notes.strip():
        children.append(_paragraph(task.notes.strip()))
    if children:
        page["children"] = children
    return page


def _paragraph(text: str) -> dict[str, Any]:
    return {"object": "block", "type": "paragraph",
            "paragraph": {"rich_text": [{"type": "text", "text": {"content": text[:1900]}}]}}


def parse_notion_pages(payload: Any, title_property: str) -> list[dict[str, str]]:
    results = payload.get("results") if isinstance(payload, dict) else None
    tasks: list[dict[str, str]] = []
    for page in results if isinstance(results, list) else []:
        if not isinstance(page, dict):
            continue
        prop = page.get("properties", {}).get(title_property, {}) if isinstance(page.get("properties"), dict) else {}
        parts = prop.get("title") if isinstance(prop, dict) else None
        title = "".join(p.get("plain_text", "") for p in parts if isinstance(p, dict)) if isinstance(parts, list) else ""
        url = page.get("url")
        if title and isinstance(url, str) and url.startswith("https://www.notion.so/"):
            tasks.append({"id": str(page.get("id", ""))[:64], "title": title[:200], "url": url,
                          "created_at": str(page.get("created_time", ""))[:40]})
    return tasks


def _check_limit(bucket: dict[str, list[float]], user_id: str, limit: int, detail: str) -> None:
    now = time.monotonic()
    recent = [t for t in bucket.get(user_id, []) if now - t < 3600]
    if len(recent) >= limit:
        raise HTTPException(status_code=429, detail=detail)
    recent.append(now)
    bucket[user_id] = recent


def _check_write_limit(user_id: str) -> None:
    _check_limit(_writes, user_id, WRITES_PER_HOUR, "Limite de tarefas por hora atingido.")


_MAIL_DETAIL = {
    "gmail": "Lê os teus emails recentes do Gmail (só leitura) para os resumir com a IA.",
    "outlook": "Lê os teus emails recentes do Outlook/Microsoft 365 (só leitura) para os resumir com a IA.",
}


async def _mail_connector_status(provider_id: str, user_id: str | None, connected: set[str]) -> dict:
    provider = mc.mail_provider(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="Fornecedor de email desconhecido.")
    missing = mc.missing_config(provider)
    if missing:
        state, detail = "not-configured", f"Falta configurar no servidor: {', '.join(missing)}."
    elif user_id is None:
        state, detail = "not-connected", "Inicia sessão para ligar a tua caixa de correio."
    elif provider_id in connected:
        state, detail = "connected", _MAIL_DETAIL[provider_id]
    else:
        state, detail = "not-connected", _MAIL_DETAIL[provider_id]
    return {"id": provider_id, "name": provider.name, "status": state, "detail": detail,
            "missing": missing, "signed_in": user_id is not None}


@router.get("/status")
async def status(request: Request, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    user = await _current_user(request)
    user_id = user.id if user else None
    connected = await mail_store.providers(user_id) if user_id and mc.mail_key_valid() else set()
    return {
        "connectors": [
            {"id": "notion", "name": "Notion", "status": "configured" if notion_configured() else "not-configured",
             "detail": "Cria e lista tarefas numa base de dados partilhada da equipa.",
             "missing": [] if notion_configured() else
             [n for n, v in (("NOTION_TOKEN", settings.notion_token), ("NOTION_DATABASE_ID", settings.notion_database_id)) if not v]},
            *[await _mail_connector_status(p, user_id, connected) for p in mc.MAIL_PROVIDER_IDS],
        ]
    }


@router.get("/notion/tasks")
async def list_notion_tasks(request: Request) -> dict:
    await _user_id(request)
    if not notion_configured():
        raise HTTPException(status_code=503, detail="O Notion não está configurado no servidor.")
    try:
        async with _http_client() as client:
            response = await client.post(
                f"{NOTION_API}/databases/{_database_id()}/query",
                headers=_headers(),
                json={"page_size": 20, "sorts": [{"timestamp": "created_time", "direction": "descending"}]},
            )
            response.raise_for_status()
            tasks = parse_notion_pages(response.json(), settings.notion_title_property)
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Não foi possível ler as tarefas do Notion.") from exc
    return {"tasks": tasks}


@router.post("/notion/tasks", status_code=201)
async def create_notion_task(task: NotionTask, request: Request) -> dict:
    user_id = await _user_id(request)
    if not notion_configured():
        raise HTTPException(status_code=503, detail="O Notion não está configurado no servidor.")
    if not task.title.strip():
        raise HTTPException(status_code=422, detail="Indica um título para a tarefa.")
    _check_write_limit(user_id)
    try:
        async with _http_client() as client:
            response = await client.post(
                f"{NOTION_API}/pages", headers=_headers(),
                json=build_notion_page(task, _database_id(), settings.notion_title_property),
            )
            response.raise_for_status()
            page = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="O Notion não aceitou a tarefa. Confirma a configuração da base de dados.") from exc
    url = page.get("url") if isinstance(page, dict) else None
    return {"id": str(page.get("id", "")) if isinstance(page, dict) else "", "url": url if isinstance(url, str) else None}


# ---- Email (Gmail / Outlook), só leitura ----------------------------------------

async def _mail_user_id(request: Request) -> str:
    user = await _current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Inicia sessão para ligar a tua caixa de correio.")
    return user.id


def _configured_provider(provider_id: str) -> mc.MailProvider:
    provider = mc.mail_provider(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="Fornecedor de email desconhecido.")
    missing = mc.missing_config(provider)
    if missing:
        raise HTTPException(status_code=503,
                            detail=f"O {provider.name} não está configurado no servidor. Falta: {', '.join(missing)}.")
    return provider


def _check_mail_limit(user_id: str) -> None:
    _check_limit(_mail_reads, user_id, settings.mail_requests_per_hour,
                 "Limite de pedidos de email por hora atingido. Tenta mais tarde.")


def _not_connected(provider: mc.MailProvider) -> HTTPException:
    return HTTPException(status_code=409,
                         detail=f"O {provider.name} não está ligado ou a autorização expirou. Liga a conta novamente.")


async def _resolve_provider(user_id: str, provider_id: str | None) -> mc.MailProvider:
    if provider_id:
        return _configured_provider(provider_id)
    connected = await mail_store.providers(user_id)
    for candidate in mc.MAIL_PROVIDER_IDS:
        if candidate in connected:
            return _configured_provider(candidate)
    raise HTTPException(status_code=409, detail="Ainda não ligaste nenhuma caixa de correio.")


async def _refresh_or_disconnect(client: httpx.AsyncClient, user_id: str, provider: mc.MailProvider,
                                 tokens: mc.MailTokens) -> mc.MailTokens:
    try:
        tokens = await mc.refresh_tokens(client, provider, tokens)
    except mc.MailAuthExpired as exc:
        await mail_store.delete(user_id, provider.id)
        raise _not_connected(provider) from exc
    await mail_store.save(user_id, provider.id, tokens)
    return tokens


async def _with_mailbox(user_id: str, provider: mc.MailProvider, operation):
    """Executa uma leitura com token válido; renova uma vez se o fornecedor responder 401."""
    try:
        async with _http_client() as client:
            tokens = await mail_store.get(user_id, provider.id)
            if tokens is None:
                raise _not_connected(provider)
            if tokens.expired():
                tokens = await _refresh_or_disconnect(client, user_id, provider, tokens)
            try:
                return await operation(client, tokens.access_token)
            except mailbox.MailboxAuthError:
                tokens = await _refresh_or_disconnect(client, user_id, provider, tokens)
                try:
                    return await operation(client, tokens.access_token)
                except mailbox.MailboxAuthError as exc:
                    await mail_store.delete(user_id, provider.id)
                    raise _not_connected(provider) from exc
    except mailbox.MailboxNotFound as exc:
        raise HTTPException(status_code=404, detail="Email não encontrado.") from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"Não foi possível ler os emails do {provider.name}.") from exc


@router.get("/mail/messages")
async def list_mail_messages(
    request: Request, response: Response, provider: MailProviderId | None = Query(default=None)
) -> dict:
    """Últimos 20 emails da caixa de entrada: remetente, assunto, data e excerto (sem corpo)."""
    response.headers["Cache-Control"] = "no-store"
    user_id = await _mail_user_id(request)
    mail_provider = await _resolve_provider(user_id, provider)
    _check_mail_limit(user_id)
    messages = await _with_mailbox(
        user_id, mail_provider, lambda client, token: mailbox.list_messages(client, mail_provider.id, token)
    )
    return {"provider": mail_provider.id, "messages": messages}


@router.get("/mail/messages/{message_id}")
async def read_mail_message(
    request: Request,
    response: Response,
    message_id: str = Path(min_length=6, max_length=512),
    provider: MailProviderId | None = Query(default=None),
) -> dict:
    """Um email em texto simples (sem HTML, tamanho limitado)."""
    response.headers["Cache-Control"] = "no-store"
    user_id = await _mail_user_id(request)
    mail_provider = await _resolve_provider(user_id, provider)
    if not mailbox.valid_message_id(mail_provider.id, message_id):
        raise HTTPException(status_code=422, detail="Identificador de email inválido.")
    _check_mail_limit(user_id)
    message = await _with_mailbox(
        user_id, mail_provider,
        lambda client, token: mailbox.get_message(client, mail_provider.id, token, message_id),
    )
    return {"provider": mail_provider.id, "message": message}


@router.post("/mail/{provider_id}/connect", dependencies=[Depends(_require_same_origin)])
async def connect_mail(provider_id: MailProviderId, request: Request, response: Response) -> dict:
    """Inicia o OAuth (PKCE). O browser navega para ``authorize_url``."""
    user_id = await _mail_user_id(request)
    provider = _configured_provider(provider_id)
    _check_mail_limit(user_id)
    authorize_url, flow_cookie = mc.start_flow(provider, user_id)
    response.set_cookie(
        mc.MAIL_FLOW_COOKIE, flow_cookie, max_age=mc.FLOW_TTL_SECONDS, httponly=True,
        secure=_SECURE_COOKIES, samesite="lax", path=mc.MAIL_FLOW_COOKIE_PATH,
    )
    response.headers["Cache-Control"] = "no-store"
    return {"authorize_url": authorize_url}


def _back_to_app(result: str, provider_id: str) -> RedirectResponse:
    """Volta à página Organização; o cookie de fluxo é apagado em todas as saídas."""
    frontend = settings.public_frontend_url.rstrip("/")
    redirect = RedirectResponse(f"{frontend}/#/organize?mail={result}&provider={provider_id}", status_code=302)
    redirect.delete_cookie(mc.MAIL_FLOW_COOKIE, path=mc.MAIL_FLOW_COOKIE_PATH, secure=_SECURE_COOKIES,
                           httponly=True, samesite="lax")
    redirect.headers["Cache-Control"] = "no-store"
    return redirect


def _same(a: str, b: str) -> bool:
    return secrets.compare_digest(a.encode(), b.encode())


@router.get("/mail/{provider_id}/callback")
async def mail_callback(
    provider_id: MailProviderId,
    request: Request,
    code: str | None = Query(default=None, max_length=4096),
    state: str | None = Query(default=None, max_length=256),
    error: str | None = Query(default=None, max_length=256),
) -> RedirectResponse:
    flow = mc.read_flow(request.cookies.get(mc.MAIL_FLOW_COOKIE))
    if flow is None:
        return _back_to_app("expired", provider_id)
    if flow["p"] != provider_id or not state or not _same(flow["s"], state):
        return _back_to_app("error", provider_id)  # state inválido: possível CSRF
    if error:
        return _back_to_app("denied", provider_id)
    if not code:
        return _back_to_app("error", provider_id)
    user = await _current_user(request)
    if not user or not _same(user.id, flow["u"]):
        # O fluxo pertence à sessão que o iniciou; nunca liga a caixa a outra conta.
        return _back_to_app("session", provider_id)
    provider = mc.mail_provider(provider_id)
    if provider is None or mc.missing_config(provider):
        return _back_to_app("not-configured", provider_id)
    try:
        async with _http_client() as client:
            tokens = await mc.exchange_code(client, provider, code, flow["v"])
    except mc.MailScopeMissing:
        return _back_to_app("scope", provider_id)
    except (httpx.HTTPError, ValueError):
        return _back_to_app("error", provider_id)
    await mail_store.save(user.id, provider_id, tokens)
    await record_security_event(user.id, "mail_connected", details={"provider": provider_id})
    return _back_to_app("connected", provider_id)


@router.delete("/mail/{provider_id}", dependencies=[Depends(_require_same_origin)])
async def disconnect_mail(provider_id: MailProviderId, request: Request) -> dict:
    """Apaga os tokens guardados e, na Google, revoga também a autorização."""
    user_id = await _mail_user_id(request)
    provider = mc.mail_provider(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="Fornecedor de email desconhecido.")
    existed, tokens = await mail_store.delete(user_id, provider_id)
    revoked = False
    if tokens is not None and provider.revoke_url:
        async with _http_client() as client:
            revoked = await mc.revoke_tokens(client, provider, tokens)
    if existed:
        await record_security_event(user_id, "mail_disconnected", details={"provider": provider_id})
    if provider.revoke_url:
        detail = ("Ligação removida e autorização revogada na Google." if revoked else
                  "Ligação removida. Confirma em myaccount.google.com/permissions que o acesso foi retirado.")
    else:
        detail = ("Ligação removida e tokens apagados. Para retirar também a autorização na Microsoft, "
                  "remove a aplicação nas definições de privacidade da tua conta Microsoft.")
    return {"ok": True, "was_connected": existed, "revoked_at_provider": revoked, "detail": detail}
