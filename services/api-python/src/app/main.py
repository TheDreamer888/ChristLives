import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from src.app.auth.routes import router as auth_router
from src.app.config import settings
from src.app.database import dispose_database, session_factory
from src.app.routers.agency import router as agency_router
from src.app.routers.ai import router as ai_router
from src.app.routers.assistant import router as assistant_router
from src.app.routers.dns import router as dns_router
from src.app.routers.protection import router as protection_router
from src.ml.model import RiskModel
from src.pylibrary.logging import get_logger

logger = get_logger(__name__)
settings.require_secret_key()


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        yield
    finally:
        await dispose_database()


app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def apply_security_controls(request: Request, call_next):
    response = await call_next(request)

    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.path.startswith("/api/auth/"):
        response.headers["Cache-Control"] = "no-store"
    if (
        os.getenv("ENV", "development").lower() == "production"
        and os.getenv("PUBLIC_API_URL", "").startswith("https://")
    ):
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


app.include_router(dns_router)
app.include_router(ai_router)
app.include_router(assistant_router)
app.include_router(auth_router)
app.include_router(agency_router)
app.include_router(protection_router)

risk_model = RiskModel()

class RiskScoreRequest(BaseModel):
    finding_ids: list[str] = Field(default_factory=list, max_length=50)
    finding_count: int = Field(ge=0, le=50)


@app.get("/health")
def health():
    """Liveness/readiness probe — não expõe detalhes internos."""
    return {"status": "healthy"}


@app.get("/health/ready")
async def readiness():
    try:
        async with session_factory()() as session:
            await session.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        logger.error("Verificação de prontidão da base de dados falhou.")
        raise HTTPException(status_code=503, detail="Base de dados indisponível.") from exc
    return {"status": "ready"}


@app.get("/api/protect/status")
def status():
    return {"status": "ok", "app": settings.app_name}

@app.post("/api/protect/risk-score")
def risk_score(payload: RiskScoreRequest):
    score = risk_model.score(payload.model_dump())
    logger.info(f"Risk score computed: {score}")
    return {"score": score}
