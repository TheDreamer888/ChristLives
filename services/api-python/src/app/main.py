import os
from contextlib import asynccontextmanager

# Usa o repositório de certificados do sistema operativo para pedidos HTTPS de saída
# (Claude, World Bank, GDELT, Finnhub, Notion). Necessário em redes/antivírus que
# intercetam TLS com uma raiz instalada só no sistema; inofensivo nos restantes casos.
# Desativar com TRUSTSTORE=0.
if os.getenv("TRUSTSTORE", "1") != "0":
    try:
        import truststore

        truststore.inject_into_ssl()
    except ImportError:  # pragma: no cover - dependência declarada no pyproject
        pass

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from starlette.middleware.base import BaseHTTPMiddleware

from src.app.auth.routes import router as auth_router
from src.app.config import settings
from src.app.database import dispose_database, session_factory
from src.app.firewall import firewall
from src.app.routers.agency import router as agency_router
from src.app.routers.ai import router as ai_router
from src.app.routers.assistant import router as assistant_router
from src.app.routers.chat import router as chat_router
from src.app.routers.dns import router as dns_router
from src.app.routers.economy import router as economy_router
from src.app.routers.markets import router as markets_router
from src.app.routers.organize import router as organize_router
from src.app.routers.protection import router as protection_router
from src.app.routers.security_center import router as security_center_router
from src.pylibrary.logging import get_logger

logger = get_logger(__name__)
settings.require_secret_key()


@asynccontextmanager
async def lifespan(app: FastAPI):
    firewall.start()  # descarrega listas de ameaças reais em segundo plano
    try:
        yield
    finally:
        await firewall.stop()
        await dispose_database()


app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)

# Ordem (de fora para dentro): cabeçalhos de segurança → CORS → firewall → rotas.
# Assim as respostas bloqueadas pelo firewall também levam cabeçalhos de segurança e CORS.
app.add_middleware(BaseHTTPMiddleware, dispatch=firewall)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def apply_security_controls(request: Request, call_next):
    response = await call_next(request)

    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    # A API só devolve JSON: nenhum conteúdo dela deve executar scripts ou ser incorporado.
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "same-site"
    if request.url.path.startswith(("/api/auth/", "/api/security/", "/api/chat", "/api/organize/")):
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
app.include_router(chat_router)
app.include_router(markets_router)
app.include_router(economy_router)
app.include_router(organize_router)
app.include_router(security_center_router)


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
