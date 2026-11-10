//! Erros da API com resposta JSON uniforme: `{ "error": "<código>", "message": "<texto>" }`.
//!
//! Novos erros acrescentam-se aqui como variantes; os detalhes internos (ex.:
//! mensagens do Postgres) devem ir apenas para os logs, nunca para o cliente.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("recurso não encontrado")]
    NotFound,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    message: &'static str,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                ErrorBody {
                    error: "not_found",
                    message: "O recurso pedido não existe.",
                },
            ),
        };
        (status, Json(body)).into_response()
    }
}
