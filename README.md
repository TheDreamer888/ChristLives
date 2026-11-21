# Lusorbe

Monorepo organizado em três áreas: `apps/`, `services/` e `infra/`.

## Estrutura

```
apps/
  frontend/          React + Vite + TypeScript (UI, autenticação/WebAuthn)
services/
  api-python        FastAPI (API principal, DNS via Cloudflare, scoring de risco)
  api-rust          Axum (API de alta performance, Postgres/Redis)
  api-dotnet        ASP.NET (serviço .NET 10)
infra/
  scripts/            Scripts de manutenção e verificação
  arquitetura.sh      Diagrama textual da arquitetura em camadas
.github/workflows/    CI/CD (inclui sincronização de DNS com a Cloudflare)
```

## Pré-requisitos

- Node.js 24 e pnpm 10
- Python 3.12 e Poetry
- Rust e Cargo
- .NET SDK 10
- Docker Desktop, para executar a stack completa

## Comandos pela raiz

```powershell
pnpm install
pnpm run build
pnpm run lint:frontend
pnpm run check:python
pnpm run check:rust
pnpm run check:dotnet
```

Os comandos `check:*` dependem do SDK correspondente instalado no ambiente. O
workspace pnpm gerencia somente `apps/*`; cada serviço mantém o próprio
manifesto e ciclo de build.

## Como executar cada serviço

### Frontend (`apps/frontend`)
```powershell
pnpm --filter frontend dev
pnpm --filter frontend test
pnpm --filter frontend lint
pnpm --filter frontend build
```

### API Python (`services/api-python`)
```powershell
cd services/api-python
poetry install
poetry run uvicorn src.app.main:app --reload
```

### API Rust (`services/api-rust`)
```powershell
cd services/api-rust
cargo run
```

### API .NET (`services/api-dotnet`)
```powershell
cd services/api-dotnet/WebApplication1
dotnet run
```

## Stack completa com Docker

```powershell
docker compose up --build
```

Serviços publicados localmente: frontend em `http://localhost:5173`, API
Python em `http://localhost:8000`, API Rust em `http://localhost:3000` e API
.NET em `http://localhost:8080`.

## Variáveis de ambiente

Copie `.env.example` e `.env.auth.example` para os serviços que precisar. Nunca
faça commit de ficheiros `.env` reais.

## Contribuição e governança

- Veja `CONTRIBUTING.md` para o fluxo de branches, checks obrigatórios e organização do GitHub.
- Veja `SECURITY.md` para a política de reporte de vulnerabilidades.
