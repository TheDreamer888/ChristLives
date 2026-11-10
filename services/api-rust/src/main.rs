//! api-rust — serviço Axum com Postgres.
//!
//! Arranca mesmo que o Postgres ainda não esteja pronto (pool "lazy"): a liveness
//! responde logo e a readiness devolve 503 até a base de dados aceitar ligações.
//! Termina de forma ordenada com Ctrl+C ou SIGTERM, deixando os pedidos em curso
//! acabar.
//!
//! `api-rust --healthcheck` faz um pedido a `/health/live` no próprio contentor e
//! sai com 0/1 — usado pelo HEALTHCHECK do Dockerfile, sem precisar de curl/wget.

mod app;
mod config;
mod error;

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

use crate::app::{router, AppState};
use crate::config::Config;

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        return healthcheck();
    }

    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("api_rust=info,tower_http=info")),
        )
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            tracing::error!(%error, "configuração inválida");
            return ExitCode::FAILURE;
        }
    };

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(%error, "não foi possível iniciar o runtime");
            return ExitCode::FAILURE;
        }
    };

    match runtime.block_on(serve(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "o servidor terminou com erro");
            ExitCode::FAILURE
        }
    }
}

async fn serve(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let db = PgPoolOptions::new()
        .max_connections(config.db_max_connections)
        .acquire_timeout(config.db_acquire_timeout)
        .connect_lazy(&config.database_url)?;

    let state = Arc::new(AppState {
        db: db.clone(),
        started_at: Instant::now(),
    });
    let app = router(state, &config);

    let listener = tokio::net::TcpListener::bind(config.addr()).await?;
    tracing::info!(addr = %listener.local_addr()?, version = env!("CARGO_PKG_VERSION"), "servidor Rust à escuta");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    db.close().await;
    tracing::info!("servidor terminado");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::warn!(%error, "não foi possível escutar Ctrl+C");
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::warn!(%error, "não foi possível escutar SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("sinal de paragem recebido; a terminar pedidos em curso");
}

/// Sonda HTTP mínima, só com a biblioteca padrão (a imagem final não tem curl/wget).
fn healthcheck() -> ExitCode {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(3000);
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let probe = || -> std::io::Result<bool> {
        let timeout = Duration::from_secs(3);
        let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        stream.write_all(
            b"GET /health/live HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )?;
        let mut head = Vec::with_capacity(64);
        stream.take(64).read_to_end(&mut head)?;
        Ok(head.starts_with(b"HTTP/1.1 200"))
    };
    match probe() {
        Ok(true) => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}
