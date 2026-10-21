import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.app.config import settings
from src.app.firewall import FirewallMiddleware
from src.app.routers.dns import router as dns_router
from src.app.auth.routes import router as auth_router
from src.ml.model import RiskModel
from src.pylibrary.logging import get_logger

logger = get_logger(__name__)
settings.require_secret_key()
_PRODUCTION = os.getenv("ENV", "production").lower() not in {"development", "dev", "test"}
# Em produção não se expõe a documentação interativa nem o esquema OpenAPI.
app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    docs_url=None if _PRODUCTION else "/docs",
    redoc_url=None if _PRODUCTION else "/redoc",
    openapi_url=None if _PRODUCTION else "/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)
# Adicionado por último para ser a camada mais externa (corre antes do CORS).
app.add_middleware(FirewallMiddleware)

app.include_router(dns_router)
app.include_router(auth_router)

risk_model = RiskModel()


@app.get("/health")
def health():
    """Liveness/readiness probe — não expõe detalhes internos."""
    return {"status": "healthy"}


@app.get("/api/protect/status")
def status():
    return {"status": "ok", "app": settings.app_name}

@app.post("/api/protect/risk-score")
def risk_score(payload: dict):
    score = risk_model.score(payload)
    logger.info(f"Risk score computed: {score}")
    return {"score": score}

