"""Leitura de caixas de correio (Gmail API e Microsoft Graph) e normalização.

Todo o conteúdo devolvido aqui é dado NÃO CONFIÁVEL de terceiros: é convertido para texto
simples, sem HTML, com caracteres de controlo removidos e tamanho limitado. A UI mostra-o
como texto e o chat recebe-o marcado como contexto não confiável.
Só leitura: nenhuma função envia, move, marca ou apaga emails.
"""
from __future__ import annotations

import asyncio
import base64
import html
import re
from datetime import UTC, datetime
from email.utils import getaddresses, parsedate_to_datetime
from html.parser import HTMLParser
from typing import Any, ClassVar
from urllib.parse import quote

import httpx

GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
GRAPH_API = "https://graph.microsoft.com/v1.0/me"
LIST_LIMIT = 20
SNIPPET_CHARS = 300
SUBJECT_CHARS = 300
MAX_BODY_CHARS = 8000
_MAX_PART_DEPTH = 8
_METADATA_CONCURRENCY = 5

_GMAIL_ID = re.compile(r"[0-9a-fA-F]{6,32}")
_GRAPH_ID = re.compile(r"[A-Za-z0-9_=+-]{10,512}")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]")
_BLANKS = re.compile(r"\n[ \t]*\n(?:[ \t]*\n)+")
_SPACES = re.compile(r"[ \t ]{2,}")


class MailboxAuthError(Exception):
    """O fornecedor recusou o token (401): ligação revogada ou expirada."""


class MailboxNotFound(Exception):
    """Mensagem inexistente ou inacessível."""


def valid_message_id(provider: str, message_id: str) -> bool:
    pattern = _GMAIL_ID if provider == "gmail" else _GRAPH_ID
    return bool(pattern.fullmatch(message_id))


def clean_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = _CONTROL.sub("", value.replace("\r\n", "\n").replace("\r", "\n").replace(" ", " "))
    text = _SPACES.sub(" ", text)
    text = _BLANKS.sub("\n\n", text).strip()
    return text[:limit]


class _TextExtractor(HTMLParser):
    _SKIP: ClassVar[frozenset[str]] = frozenset({"script", "style", "head", "title", "noscript", "template", "svg"})
    _BLOCK: ClassVar[frozenset[str]] = frozenset(
        {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "hr"}
    )

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            self.parts.append(data)


def html_to_text(markup: str) -> str:
    """HTML de email → texto simples (sem tags, scripts, estilos nem ligações ativas)."""
    parser = _TextExtractor()
    try:
        parser.feed(markup[: MAX_BODY_CHARS * 20])
        parser.close()
    except (AssertionError, ValueError):  # HTML muito malformado: fica o que já foi extraído
        return "".join(parser.parts)
    return "".join(parser.parts)


def _iso(value: datetime | None) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat()


def _parse_from(value: Any) -> tuple[str, str]:
    if not isinstance(value, str):
        return "", ""
    pairs = getaddresses([value])
    name, address = pairs[0] if pairs else ("", "")
    return clean_text(name, 200), clean_text(address, 320)


def _summary(message_id: str, sender: tuple[str, str], subject: Any, date: str,
             snippet: Any, unread: bool) -> dict[str, Any]:
    return {
        "id": message_id,
        "from_name": sender[0],
        "from_email": sender[1],
        "subject": clean_text(subject, SUBJECT_CHARS) or "(sem assunto)",
        "date": date,
        "snippet": clean_text(snippet, SNIPPET_CHARS),
        "unread": unread,
    }


# ---- Gmail ---------------------------------------------------------------------

def _gmail_headers(payload: dict[str, Any]) -> dict[str, str]:
    headers = payload.get("payload", {}).get("headers") if isinstance(payload.get("payload"), dict) else None
    result: dict[str, str] = {}
    for header in headers if isinstance(headers, list) else []:
        if isinstance(header, dict) and isinstance(header.get("name"), str) and isinstance(header.get("value"), str):
            result.setdefault(header["name"].lower(), header["value"])
    return result


def _gmail_date(headers: dict[str, str], payload: dict[str, Any]) -> str:
    raw = headers.get("date")
    if raw:
        try:
            return _iso(parsedate_to_datetime(raw))
        except (TypeError, ValueError, IndexError):
            pass
    internal = payload.get("internalDate")
    try:
        return _iso(datetime.fromtimestamp(int(internal) / 1000, tz=UTC))
    except (TypeError, ValueError, OverflowError, OSError):
        return ""


def parse_gmail_message(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str):
        return None
    if not valid_message_id("gmail", payload["id"]):
        return None
    headers = _gmail_headers(payload)
    labels = payload.get("labelIds") if isinstance(payload.get("labelIds"), list) else []
    # Os snippets da Gmail API vêm com entidades HTML escapadas.
    snippet = html.unescape(payload["snippet"]) if isinstance(payload.get("snippet"), str) else ""
    return _summary(payload["id"], _parse_from(headers.get("from")), headers.get("subject"),
                    _gmail_date(headers, payload), snippet, "UNREAD" in labels)


def _decode_b64url(data: str) -> str:
    try:
        raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
    except (ValueError, TypeError):
        return ""
    return raw.decode("utf-8", errors="replace")


def extract_gmail_body(payload: Any) -> str:
    """Prefere text/plain; recorre a text/html convertido em texto. Ignora anexos."""
    plain: list[str] = []
    markup: list[str] = []

    def walk(part: Any, depth: int) -> None:
        if not isinstance(part, dict) or depth > _MAX_PART_DEPTH:
            return
        mime = str(part.get("mimeType", "")).lower()
        body = part.get("body") if isinstance(part.get("body"), dict) else {}
        data = body.get("data") if isinstance(body.get("data"), str) else None
        is_attachment = bool(part.get("filename")) or "attachmentId" in body
        if data and not is_attachment:
            if mime == "text/plain":
                plain.append(_decode_b64url(data))
            elif mime == "text/html":
                markup.append(_decode_b64url(data))
        for child in part.get("parts") if isinstance(part.get("parts"), list) else []:
            walk(child, depth + 1)

    walk(payload.get("payload") if isinstance(payload, dict) else None, 0)
    if any(p.strip() for p in plain):
        return "\n\n".join(plain)
    return "\n\n".join(html_to_text(m) for m in markup)


# ---- Microsoft Graph -----------------------------------------------------------

def _graph_sender(item: dict[str, Any]) -> tuple[str, str]:
    sender = item.get("from") if isinstance(item.get("from"), dict) else {}
    address = sender.get("emailAddress") if isinstance(sender.get("emailAddress"), dict) else {}
    return clean_text(address.get("name"), 200), clean_text(address.get("address"), 320)


def _graph_date(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    try:
        return _iso(datetime.fromisoformat(value))
    except ValueError:
        return ""


def parse_graph_message(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict) or not isinstance(item.get("id"), str):
        return None
    if not valid_message_id("outlook", item["id"]):
        return None
    return _summary(item["id"], _graph_sender(item), item.get("subject"),
                    _graph_date(item.get("receivedDateTime")), item.get("bodyPreview"),
                    item.get("isRead") is False)


def extract_graph_body(item: Any) -> str:
    body = item.get("body") if isinstance(item, dict) and isinstance(item.get("body"), dict) else {}
    content = body.get("content") if isinstance(body.get("content"), str) else ""
    if str(body.get("contentType", "")).lower() == "html":
        return html_to_text(content)
    return content


# ---- pedidos -------------------------------------------------------------------

async def _get_json(client: httpx.AsyncClient, url: str, token: str,
                    params: Any = None, headers: dict[str, str] | None = None) -> Any:
    response = await client.get(
        url, params=params,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json", **(headers or {})},
    )
    if response.status_code == 401:
        raise MailboxAuthError()
    if response.status_code in (400, 404):
        raise MailboxNotFound()
    response.raise_for_status()
    return response.json()


async def list_messages(client: httpx.AsyncClient, provider: str, token: str) -> list[dict[str, Any]]:
    if provider == "gmail":
        listing = await _get_json(client, f"{GMAIL_API}/messages", token,
                                  params={"maxResults": str(LIST_LIMIT), "labelIds": "INBOX"})
        refs = listing.get("messages") if isinstance(listing, dict) else None
        ids = [r["id"] for r in refs if isinstance(r, dict) and isinstance(r.get("id"), str)
               and valid_message_id("gmail", r["id"])] if isinstance(refs, list) else []
        limiter = asyncio.Semaphore(_METADATA_CONCURRENCY)

        async def metadata(message_id: str) -> dict[str, Any] | None:
            async with limiter:
                try:
                    payload = await _get_json(
                        client, f"{GMAIL_API}/messages/{message_id}", token,
                        params=[("format", "metadata"), ("metadataHeaders", "From"),
                                ("metadataHeaders", "Subject"), ("metadataHeaders", "Date")],
                    )
                except MailboxNotFound:
                    return None  # apagada entre a listagem e a leitura
            return parse_gmail_message(payload)

        results = await asyncio.gather(*(metadata(i) for i in ids[:LIST_LIMIT]))
        return [r for r in results if r]

    listing = await _get_json(client, f"{GRAPH_API}/mailFolders/inbox/messages", token, params={
        "$top": str(LIST_LIMIT),
        "$select": "id,subject,from,receivedDateTime,bodyPreview,isRead",
        "$orderby": "receivedDateTime desc",
    })
    items = listing.get("value") if isinstance(listing, dict) else None
    parsed = (parse_graph_message(i) for i in items) if isinstance(items, list) else ()
    return [m for m in parsed if m][:LIST_LIMIT]


async def get_message(client: httpx.AsyncClient, provider: str, token: str, message_id: str) -> dict[str, Any]:
    if provider == "gmail":
        payload = await _get_json(client, f"{GMAIL_API}/messages/{message_id}", token, params={"format": "full"})
        summary = parse_gmail_message(payload)
        raw_body = extract_gmail_body(payload)
    else:
        payload = await _get_json(
            client, f"{GRAPH_API}/messages/{quote(message_id, safe='')}", token,
            params={"$select": "id,subject,from,receivedDateTime,body,bodyPreview,isRead"},
            headers={"Prefer": 'outlook.body-content-type="text"'},
        )
        summary = parse_graph_message(payload)
        raw_body = extract_graph_body(payload)
    if summary is None:
        raise MailboxNotFound()
    body = clean_text(raw_body, MAX_BODY_CHARS + 1)
    return {**summary, "body": body[:MAX_BODY_CHARS], "truncated": len(body) > MAX_BODY_CHARS}
