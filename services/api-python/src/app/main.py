from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.app.config import settings
from src.app.routers.dns import router as dns_router
from src.app.auth.routes import router as auth_router
from src.app.admin.routes import router as admin_router
from src.app.waitlist import router as waitlist_router
from src.ml.model import RiskModel
from src.pylibrary.logging import get_logger

logger = get_logger(__name__)
settings.require_secret_key()


def _require_production_storage() -> None:
    """Em produção, memória perde contas e auditoria a cada reinício: não arranca."""
    import os

    if os.getenv("ENV", "development").lower() != "production":
        return
    missing = [name for name in ("DATABASE_URL", "AUDIT_HMAC_KEY") if not os.getenv(name)]
    if missing:
        raise RuntimeError(f"Em produção é obrigatório definir: {', '.join(missing)}.")


_require_production_storage()
app = FastAPI(title=settings.app_name, version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dns_router)
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(waitlist_router)

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

