# --- build stage ---
FROM rust:1.90-slim AS build
WORKDIR /app

# Compila primeiro só as dependências (camada em cache enquanto Cargo.toml/lock não mudarem).
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src target/release/deps/api_rust* target/release/api-rust*

COPY src ./src
RUN cargo build --release --locked

# --- runtime stage ---
# Sem OpenSSL: a ligação ao Postgres é interna à rede do compose.
FROM debian:bookworm-20250908-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/api-rust ./api-rust

RUN useradd --create-home --shell /bin/false appuser
USER appuser

EXPOSE 3000
# O próprio binário faz a sonda (a imagem slim não tem curl nem wget).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["./api-rust", "--healthcheck"]

CMD ["./api-rust"]
