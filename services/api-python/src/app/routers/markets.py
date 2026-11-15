"""Dados de mercado: notícias globais e cotações.

Fontes:
- Finnhub (https://finnhub.io) — notícias e cotações, se FINNHUB_API_KEY estiver definida;
- feeds RSS públicos de editores financeiros (BBC, CNBC, MarketWatch, BCE, FXStreet,
  Investing.com, CoinDesk, Cointelegraph) — títulos e ligações, sem chave;
- GDELT DOC 2.0 (https://www.gdeltproject.org) — pesquisa global sem chave, usada quando
  os feeds não têm resultados para a pesquisa (limite: 1 pedido a cada 5 s por IP).

As respostas são normalizadas, validadas e guardadas em cache de memória por poucos minutos
para respeitar os limites dos fornecedores. A chave nunca sai do servidor.
"""
from __future__ import annotations

import asyncio
import html
import re
import time
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException
from fastapi import APIRouter, HTTPException, Query

from src.app.config import settings
from src.pylibrary.logging import get_logger

router = APIRouter(prefix="/api/markets", tags=["markets"])
logger = get_logger(__name__)

FINNHUB_BASE = "https://finnhub.io/api/v1"
GDELT_DOC = "https://api.gdeltproject.org/api/v2/doc/doc"
NEWS_TTL = 300
QUOTE_TTL = 30
SYMBOL_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9.:\-^=]{0,19}$")
Category = Literal["general", "forex", "crypto", "merger"]
GDELT_QUERIES: dict[str, str] = {
    "general": '(stock market OR "central bank" OR inflation OR "interest rates" OR economy)',
    "forex": '(forex OR "exchange rate" OR dollar OR euro OR currency)',
    "crypto": "(bitcoin OR ethereum OR crypto OR cryptocurrency)",
    "merger": '(merger OR acquisition OR takeover OR IPO)',
}

RSS_FEEDS: dict[str, tuple[str, str]] = {
    "bbc": ("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    "cnbc_markets": ("CNBC Markets", "https://www.cnbc.com/id/20910258/device/rss/rss.html"),
    "cnbc_finance": ("CNBC Finance", "https://www.cnbc.com/id/10000664/device/rss/rss.html"),
    "cnbc_top": ("CNBC", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    "marketwatch": ("MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
    "ecb": ("BCE", "https://www.ecb.europa.eu/rss/press.html"),
    "fxstreet": ("FXStreet", "https://www.fxstreet.com/rss/news"),
    "investing": ("Investing.com", "https://www.investing.com/rss/news_1.rss"),
    "coindesk": ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    "cointelegraph": ("Cointelegraph", "https://cointelegraph.com/rss"),
}
CATEGORY_FEEDS: dict[str, tuple[str, ...]] = {
    "general": ("bbc", "cnbc_markets", "cnbc_finance", "marketwatch", "ecb"),
    "forex": ("fxstreet", "investing", "ecb"),
    "crypto": ("coindesk", "cointelegraph"),
    "merger": ("cnbc_top", "cnbc_finance", "marketwatch", "bbc"),
}
MERGER_PATTERN = re.compile(r"\b(merger|merge|acquisition|acquire[sd]?|takeover|buyout|ipo|deal|bid)\b", re.IGNORECASE)
_TAG = re.compile(r"<[^>]+>")
MAX_FEED_BYTES = 2_000_000

_cache: dict[str, tuple[float, Any]] = {}
# O GDELT aceita no máximo um pedido a cada 5 s por IP: os pedidos são serializados.
GDELT_MIN_INTERVAL = 5.5
_gdelt_lock = asyncio.Lock()
_gdelt_last = 0.0


async def _gdelt_get(client: httpx.AsyncClient, params: dict[str, str]) -> httpx.Response:
    global _gdelt_last
    async with _gdelt_lock:
        for attempt in range(2):
            wait = GDELT_MIN_INTERVAL - (time.monotonic() - _gdelt_last)
            if wait > 0:
                await asyncio.sleep(wait)
            response = await client.get(GDELT_DOC, params=params)
            _gdelt_last = time.monotonic()
            if response.status_code != 429 or attempt:
                return response
        return response


def _stale(key: str) -> Any | None:
    hit = _cache.get(key)
    return hit[1] if hit else None


def _cached(key: str, ttl: int) -> Any | None:
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    return None


def _store(key: str, value: Any) -> Any:
    if len(_cache) > 512:
        _cache.clear()
    _cache[key] = (time.monotonic(), value)
    return value


def _http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=12, follow_redirects=False, headers={"User-Agent": "Aegis/1.0"})


def _safe_url(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 2048:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        return None
    return value


def _clean(value: Any, limit: int) -> str:
    return " ".join(value.split())[:limit] if isinstance(value, str) else ""


def normalize_finnhub_news(items: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        url, title = _safe_url(item.get("url")), _clean(item.get("headline"), 300)
        if not url or not title:
            continue
        ts = item.get("datetime")
        published = datetime.fromtimestamp(ts, UTC).isoformat() if isinstance(ts, int) and ts > 0 else ""
        out.append({
            "title": title,
            "url": url,
            "source": _clean(item.get("source"), 80) or urlparse(url).hostname or "",
            "published_at": published,
            "summary": _clean(item.get("summary"), 600),
        })
    return out[:30]


def normalize_gdelt_news(payload: Any) -> list[dict[str, str]]:
    articles = payload.get("articles") if isinstance(payload, dict) else None
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in articles if isinstance(articles, list) else []:
        if not isinstance(item, dict):
            continue
        url, title = _safe_url(item.get("url")), _clean(item.get("title"), 300)
        if not url or not title or title.lower() in seen:
            continue
        seen.add(title.lower())
        raw = item.get("seendate")
        published = ""
        if isinstance(raw, str) and re.fullmatch(r"\d{8}T\d{6}Z", raw):
            published = datetime.strptime(raw, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC).isoformat()
        out.append({
            "title": title,
            "url": url,
            "source": _clean(item.get("domain"), 80) or urlparse(url).hostname or "",
            "published_at": published,
            "summary": "",
        })
    return out[:30]


def parse_rss(xml: bytes | str, source: str) -> list[dict[str, str]]:
    """RSS 2.0 → artigos normalizados. defusedxml bloqueia entidades e DTDs maliciosos."""
    try:
        root = ElementTree.fromstring(xml)
    except (ElementTree.ParseError, DefusedXmlException, ValueError):
        return []
    out: list[dict[str, str]] = []
    for item in root.iter("item"):
        title = _clean(html.unescape(item.findtext("title") or ""), 300)
        url = _safe_url((item.findtext("link") or "").strip())
        if not title or not url:
            continue
        published = ""
        raw_date = item.findtext("pubDate")
        if raw_date:
            try:
                parsed = parsedate_to_datetime(raw_date.strip())
                published = (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).astimezone(UTC).isoformat()
            except (TypeError, ValueError, IndexError):
                published = ""
        summary = _clean(html.unescape(_TAG.sub(" ", item.findtext("description") or "")), 400)
        out.append({"title": title, "url": url, "source": source, "published_at": published, "summary": summary})
    return out


def merge_articles(groups: list[list[dict[str, str]]], query: str = "", category: str = "general") -> list[dict[str, str]]:
    terms = [t for t in query.casefold().split() if len(t) >= 2]
    seen: set[str] = set()
    merged: list[dict[str, str]] = []
    for article in (a for group in groups for a in group):
        key = re.sub(r"\W+", "", article["title"].casefold())
        if key in seen:
            continue
        text = f"{article['title']} {article['summary']}".casefold()
        if terms and not all(t in text for t in terms):
            continue
        if category == "merger" and not MERGER_PATTERN.search(article["title"]):
            continue
        seen.add(key)
        merged.append(article)
    merged.sort(key=lambda a: a["published_at"], reverse=True)
    return merged[:30]


async def _fetch_feed(client: httpx.AsyncClient, feed_id: str) -> list[dict[str, str]]:
    source, url = RSS_FEEDS[feed_id]
    try:
        response = await client.get(url, follow_redirects=True)
        response.raise_for_status()
        if len(response.content) > MAX_FEED_BYTES:
            return []
        return parse_rss(response.content, source)
    except httpx.HTTPError:
        logger.warning("Feed RSS indisponível: %s", feed_id)
        return []


async def rss_news(client: httpx.AsyncClient, category: str, query: str) -> list[dict[str, str]]:
    feeds = CATEGORY_FEEDS[category] if not query else tuple(dict.fromkeys(f for ids in CATEGORY_FEEDS.values() for f in ids))
    groups = await asyncio.gather(*(_fetch_feed(client, feed_id) for feed_id in feeds))
    return merge_articles(list(groups), query, category if not query else "general")


@router.get("/news")
async def market_news(
    category: Category = "general",
    q: str | None = Query(default=None, min_length=2, max_length=80),
) -> dict:
    query = _clean(q, 80) if q else ""
    if query and not re.fullmatch(r"[\w\s.,&'\-]+", query):
        raise HTTPException(status_code=422, detail="Usa apenas letras, números e espaços na pesquisa.")
    key = f"news:{category}:{query.lower()}"
    if (hit := _cached(key, NEWS_TTL)) is not None:
        return hit

    articles: list[dict[str, str]] = []
    source = ""
    async with _http_client() as client:
        if settings.finnhub_api_key and not query:
            try:
                response = await client.get(
                    f"{FINNHUB_BASE}/news", params={"category": category},
                    headers={"X-Finnhub-Token": settings.finnhub_api_key},
                )
                response.raise_for_status()
                articles, source = normalize_finnhub_news(response.json()), "Finnhub"
            except (httpx.HTTPError, ValueError):
                logger.warning("Finnhub indisponível; a usar feeds RSS para notícias.")
        if not articles:
            articles = await rss_news(client, category, query)
            if len(articles) >= (3 if query else 1):
                source = ", ".join(sorted({a["source"] for a in articles}))
        if len(articles) < (3 if query else 1):
            search = f'"{query}" sourcelang:english' if query else f"{GDELT_QUERIES[category]} sourcelang:english"
            try:
                response = await _gdelt_get(client, {
                    "query": search, "mode": "artlist", "format": "json",
                    "maxrecords": "40", "sort": "datedesc", "timespan": "3d",
                })
                response.raise_for_status()
                gdelt = normalize_gdelt_news(response.json())
                if len(gdelt) > len(articles):
                    articles, source = gdelt, "GDELT Project"
            except (httpx.HTTPError, ValueError) as exc:
                if articles:
                    source = ", ".join(sorted({a["source"] for a in articles}))
                elif (stale := _stale(key)) is not None:
                    return {**stale, "notice": f"{stale['notice']} (Dados em cache: o fornecedor está temporariamente indisponível.)"}
                else:
                    raise HTTPException(status_code=502, detail="Não foi possível obter notícias de mercado agora. Tenta dentro de alguns segundos.") from exc

    if not source:
        source = ", ".join(sorted({a["source"] for a in articles})) or "—"
    return _store(key, {
        "articles": articles,
        "source": source,
        "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "notice": "Títulos e ligações de terceiros. Confirma na fonte; não é aconselhamento financeiro.",
    })


def parse_symbols(raw: str) -> list[str]:
    symbols = list(dict.fromkeys(s.strip().upper() for s in raw.split(",") if s.strip()))
    if not symbols or len(symbols) > 12 or not all(SYMBOL_PATTERN.fullmatch(s) for s in symbols):
        raise HTTPException(status_code=422, detail="Indica entre 1 e 12 símbolos válidos, separados por vírgulas.")
    return symbols


def normalize_quote(symbol: str, data: Any) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    fields = {"price": "c", "change": "d", "change_percent": "dp", "high": "h", "low": "l", "open": "o", "previous_close": "pc"}
    quote: dict[str, Any] = {"symbol": symbol}
    for name, key in fields.items():
        value = data.get(key)
        quote[name] = float(value) if isinstance(value, (int, float)) else None
    if not quote["price"]:
        return None  # Finnhub devolve 0 para símbolos desconhecidos.
    ts = data.get("t")
    quote["as_of"] = datetime.fromtimestamp(ts, UTC).isoformat() if isinstance(ts, int) and ts > 0 else None
    return quote


@router.get("/quotes")
async def market_quotes(symbols: str = Query(min_length=1, max_length=200)) -> dict:
    wanted = parse_symbols(symbols)
    if not settings.finnhub_api_key:
        raise HTTPException(status_code=503, detail="As cotações precisam de uma chave Finnhub configurada no servidor.")
    quotes: list[dict[str, Any]] = []
    missing: list[str] = []
    async with _http_client() as client:
        for symbol in wanted:
            key = f"quote:{symbol}"
            hit = _cached(key, QUOTE_TTL)
            if hit is None:
                try:
                    response = await client.get(
                        f"{FINNHUB_BASE}/quote", params={"symbol": symbol},
                        headers={"X-Finnhub-Token": settings.finnhub_api_key},
                    )
                    if response.status_code == 429:
                        raise HTTPException(status_code=429, detail="Limite do fornecedor de cotações atingido. Tenta dentro de um minuto.")
                    response.raise_for_status()
                    hit = _store(key, normalize_quote(symbol, response.json()) or {})
                except HTTPException:
                    raise
                except (httpx.HTTPError, ValueError) as exc:
                    raise HTTPException(status_code=502, detail="Não foi possível obter cotações agora.") from exc
            if hit:
                quotes.append(hit)
            else:
                missing.append(symbol)
    return {
        "quotes": quotes,
        "missing": missing,
        "source": "Finnhub",
        "notice": "Cotações podem ter atraso. Apenas para informação; não é aconselhamento financeiro.",
    }
