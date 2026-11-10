//! Router HTTP e middleware.
//!
//! Rotas:
//! - `GET /health/live`  — liveness: o processo responde (não toca na base de dados).
//! - `GET /health/ready` — readiness: confirma a ligação ao Postgres (503 se indisponível).
//! - `GET /health`       — alias de readiness, mantido por compatibilidade.
//! - `GET /api/hello`    — rota de exemplo.
//! - `GET /api/version`  — nome e versão do serviço.
//!
//! Middleware (de fora para dentro): request-id, tracing, timeout, limite de corpo,
//! CORS com lista explícita de origens e cabeçalhos de segurança.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use sqlx::PgPool;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::config::Config;
use crate::error::AppError;

const REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");
/// Tempo máximo para a verificação de readiness — um Postgres pendurado não pode
/// pendurar também a sonda do orquestrador.
const READY_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_BODY_BYTES: usize = 64 * 1024;

pub struct AppState {
    pub db: PgPool,
    pub started_at: Instant,
}

pub fn router(state: Arc<AppState>, config: &Config) -> Router {
    let origins: Vec<HeaderValue> = config
        .cors_origins
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::ACCEPT])
        .expose_headers([REQUEST_ID])
        .max_age(Duration::from_secs(600));

    Router::new()
        .route("/api/hello", get(hello))
        .route("/api/version", get(version))
        .route("/health", get(ready))
        .route("/health/ready", get(ready))
        .route("/health/live", get(live))
        .fallback(not_found)
        .with_state(state)
        .layer(cors)
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            config.request_timeout,
        ))
        .layer(PropagateRequestIdLayer::new(REQUEST_ID))
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::new(REQUEST_ID, MakeRequestUuid))
}

#[derive(Serialize)]
struct Message {
    text: &'static str,
}

async fn hello() -> Json<Message> {
    Json(Message {
        text: "Olá do backend Rust!",
    })
}

#[derive(Serialize)]
struct Version {
    service: &'static str,
    version: &'static str,
}

async fn version() -> Json<Version> {
    Json(Version {
        service: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    uptime_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    database: Option<&'static str>,
}

/// Liveness — nunca depende de serviços externos, para o orquestrador não reiniciar
/// o processo só porque o Postgres está em baixo.
async fn live(State(state): State<Arc<AppState>>) -> Json<Health> {
    Json(Health {
        status: "healthy",
        uptime_seconds: state.started_at.elapsed().as_secs(),
        database: None,
    })
}

/// Readiness — confirma que a ligação à base de dados está viva.
async fn ready(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Health>, (StatusCode, Json<Health>)> {
    let probe = tokio::time::timeout(
        READY_PROBE_TIMEOUT,
        sqlx::query("SELECT 1").execute(&state.db),
    )
    .await;
    let unhealthy = |reason: &str| {
        tracing::warn!(reason, "readiness falhou: base de dados indisponível");
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Health {
                status: "unhealthy",
                uptime_seconds: state.started_at.elapsed().as_secs(),
                database: Some("down"),
            }),
        )
    };
    match probe {
        Ok(Ok(_)) => Ok(Json(Health {
            status: "healthy",
            uptime_seconds: state.started_at.elapsed().as_secs(),
            database: Some("up"),
        })),
        Ok(Err(e)) => Err(unhealthy(&e.to_string())),
        Err(_) => Err(unhealthy("timeout")),
    }
}

async fn not_found() -> AppError {
    AppError::NotFound
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    /// Router com uma pool "lazy" que aponta para uma porta fechada: as rotas que
    /// não usam a base de dados funcionam e a readiness falha depressa.
    fn test_app() -> Router {
        let config = Config::from_lookup(|key| match key {
            "DATABASE_URL" => Some("postgres://user:pass@127.0.0.1:1/db".into()),
            "CORS_ORIGINS" => Some("https://app.example".into()),
            _ => None,
        })
        .unwrap();
        let db = PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(300))
            .connect_lazy(&config.database_url)
            .unwrap();
        router(
            Arc::new(AppState {
                db,
                started_at: Instant::now(),
            }),
            &config,
        )
    }

    async fn call(
        app: Router,
        request: Request<Body>,
    ) -> (StatusCode, axum::http::HeaderMap, serde_json::Value) {
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, headers, json)
    }

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn hello_returns_json_message() {
        let (status, _, body) = call(test_app(), get("/api/hello")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["text"], "Olá do backend Rust!");
    }

    #[tokio::test]
    async fn version_reports_package_metadata() {
        let (status, _, body) = call(test_app(), get("/api/version")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["service"], "api-rust");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn liveness_does_not_depend_on_the_database() {
        let (status, _, body) = call(test_app(), get("/health/live")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "healthy");
        assert!(body.get("database").is_none());
    }

    #[tokio::test]
    async fn readiness_reports_503_when_database_is_down() {
        for path in ["/health", "/health/ready"] {
            let (status, _, body) = call(test_app(), get(path)).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}");
            assert_eq!(body["status"], "unhealthy");
            assert_eq!(body["database"], "down");
        }
    }

    #[tokio::test]
    async fn unknown_routes_return_json_404() {
        let (status, _, body) = call(test_app(), get("/nao-existe")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "not_found");
    }

    #[tokio::test]
    async fn responses_carry_security_headers_and_request_id() {
        let (_, headers, _) = call(test_app(), get("/api/hello")).await;
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY");
        assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert!(!headers[REQUEST_ID].is_empty());
    }

    #[tokio::test]
    async fn incoming_request_id_is_propagated() {
        let request = Request::builder()
            .uri("/api/hello")
            .header(REQUEST_ID, "teste-123")
            .body(Body::empty())
            .unwrap();
        let (_, headers, _) = call(test_app(), request).await;
        assert_eq!(headers[REQUEST_ID], "teste-123");
    }

    #[tokio::test]
    async fn cors_allows_only_configured_origins() {
        let preflight = |origin: &str| {
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/api/hello")
                .header(header::ORIGIN, origin)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                .body(Body::empty())
                .unwrap()
        };
        let (_, allowed, _) = call(test_app(), preflight("https://app.example")).await;
        assert_eq!(
            allowed[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://app.example"
        );
        let (_, denied, _) = call(test_app(), preflight("https://evil.example")).await;
        assert!(denied.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    #[tokio::test]
    async fn non_get_methods_are_rejected() {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/hello")
            .body(Body::empty())
            .unwrap();
        let response = test_app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
