"""Indicadores económicos do Banco Mundial (API pública, sem chave, licença CC BY 4.0).

Usado pelos cursos de economia para mostrar dados reais em cada lição. Só aceita uma lista
fechada de indicadores e códigos de país ISO, para não transformar o endpoint num proxy aberto.
"""
from __future__ import annotations

import re
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query

router = APIRouter(prefix="/api/economy", tags=["economy"])

WORLD_BANK = "https://api.worldbank.org/v2"
TTL = 6 * 3600
INDICATORS: dict[str, dict[str, str]] = {
    "inflation": {"code": "FP.CPI.TOTL.ZG", "label": "Inflação (preços no consumidor)", "unit": "% anual"},
    "gdp_growth": {"code": "NY.GDP.MKTP.KD.ZG", "label": "Crescimento do PIB", "unit": "% anual"},
    "unemployment": {"code": "SL.UEM.TOTL.ZS", "label": "Desemprego", "unit": "% da população ativa"},
    "gdp_per_capita": {"code": "NY.GDP.PCAP.CD", "label": "PIB per capita", "unit": "USD correntes"},
    "real_interest": {"code": "FR.INR.RINR", "label": "Taxa de juro real", "unit": "%"},
    "debt": {"code": "GC.DOD.TOTL.GD.ZS", "label": "Dívida do governo central", "unit": "% do PIB"},
}
COUNTRY_PATTERN = re.compile(r"^(?:[A-Z]{2}|[A-Z]{3})$")
_cache: dict[str, tuple[float, Any]] = {}


def _http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=15, follow_redirects=False)


def normalize_series(payload: Any) -> tuple[str, list[dict[str, Any]]]:
    if not isinstance(payload, list) or len(payload) < 2 or not isinstance(payload[1], list):
        message = None
        if isinstance(payload, list) and payload and isinstance(payload[0], dict):
            message = payload[0].get("message")
        raise ValueError(f"Resposta inesperada do Banco Mundial: {message!r}")
    country = ""
    points: list[dict[str, Any]] = []
    for row in payload[1]:
        if not isinstance(row, dict):
            continue
        name = row.get("country", {}).get("value") if isinstance(row.get("country"), dict) else None
        if isinstance(name, str) and not country:
            country = name[:80]
        year, value = row.get("date"), row.get("value")
        if isinstance(year, str) and year.isdigit() and isinstance(value, (int, float)):
            points.append({"year": int(year), "value": round(float(value), 3)})
    points.sort(key=lambda p: p["year"])
    return country, points


@router.get("/indicators")
async def indicator(
    country: str = Query(default="PT", min_length=2, max_length=3),
    indicator: str = Query(default="inflation"),
    years: int = Query(default=15, ge=3, le=40),
) -> dict:
    iso = country.strip().upper()
    if not COUNTRY_PATTERN.fullmatch(iso):
        raise HTTPException(status_code=422, detail="Usa um código de país ISO (ex.: PT, BR, US) ou WLD para o mundo.")
    meta = INDICATORS.get(indicator)
    if meta is None:
        raise HTTPException(status_code=422, detail=f"Indicador desconhecido. Opções: {', '.join(INDICATORS)}.")
    key = f"{iso}:{indicator}:{years}"
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < TTL:
        return hit[1]
    try:
        async with _http_client() as client:
            response = await client.get(
                f"{WORLD_BANK}/country/{iso}/indicator/{meta['code']}",
                params={"format": "json", "mrv": str(years), "per_page": str(years)},
            )
            response.raise_for_status()
            name, points = normalize_series(response.json())
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Não foi possível obter dados do Banco Mundial agora.") from exc
    if not points:
        raise HTTPException(status_code=404, detail="Não há dados recentes para este país e indicador.")
    result = {
        "country": iso,
        "country_name": name or iso,
        "indicator": indicator,
        "label": meta["label"],
        "unit": meta["unit"],
        "points": points,
        "source": "Banco Mundial — World Development Indicators (CC BY 4.0)",
    }
    if len(_cache) > 256:
        _cache.clear()
    _cache[key] = (time.monotonic(), result)
    return result


@router.get("/indicators/catalog")
async def indicator_catalog() -> dict:
    return {"indicators": [{"id": key, "label": v["label"], "unit": v["unit"]} for key, v in INDICATORS.items()]}
