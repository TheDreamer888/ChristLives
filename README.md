# ProtectIA

Plataforma modular com gestão de agências e controlos de segurança digital,
acompanhada pela área editorial Aegis de fé, reflexão e estudo bíblico. São
experiências distintas na mesma aplicação — a área Aegis não é uma capacidade
de segurança. O frontend usa React; a API principal está em
`services/api-python`. Os serviços Rust e .NET são protótipos independentes,
não substitutos da API principal.

## Índice

- [Estrutura](#estrutura)
- [Funcionalidades](#funcionalidades)
- [Pré-requisitos](#pré-requisitos)
- [Executar a stack completa](#executar-a-stack-completa)
- [Desenvolvimento local](#desenvolvimento-local)
- [Build, lint e testes](#build-lint-e-testes)
- [Configuração e segurança](#configuração-e-segurança)
- [Infraestrutura e deployment](#infraestrutura-e-deployment)
- [Estado de comercialização](#estado-de-comercialização)

## Estrutura

```text
apps/
  frontend/                   React 19, TypeScript e Vite
services/
  api-python/                 FastAPI: autenticação, agências, IA e proteção
  api-rust/                   Axum: API mínima ligada ao PostgreSQL
  api-dotnet/
    WebApplication1/          ASP.NET: API mínima
infra/
  azure/                      Infraestrutura Azure em Bicep
  terraform/                  Módulos Terraform para Azure, AWS e Cloudflare
  scripts/                    Scripts de manutenção
.github/workflows/          CI, segurança, DNS e deployment
```

Cada serviço tem o seu próprio ciclo de dependências e compilação. O workspace
pnpm inclui apenas `apps/*`.

## Funcionalidades

- **Frontend:** gestão de agências e workspaces de clientes, autenticação,
  passkeys, área de segurança e assistentes.
- **Autenticação:** OAuth, WebAuthn, códigos de recuperação e sessões
  revogáveis persistidas no PostgreSQL.
- **Agências:** membros, permissões, convites e planos; o checkout e o portal
  Stripe são opcionais e exigem configuração.
- **Assistente:** pesquisa local de documentação aprovada, análise de PDFs e
  chat; algumas operações enviam conteúdo ao fornecedor de IA configurado.
- **Proteção de URLs:** verifica indicadores contra a lista pública HaGeZi TIF
  mini e regras locais. Um resultado `not_listed` não garante que um URL seja
  seguro; esta funcionalidade não é um antivírus nem um filtro de rede.
- **Outras integrações:** DNS Cloudflare e scoring heurístico de risco.

OneDrive, Dropbox, Word e antivírus são requisitos planeados, não integrações
implementadas. O scoring atual é um placeholder e não representa uma avaliação
de risco real. Consulte os READMEs do
[frontend](apps/frontend/README.md) e da
[API Python](services/api-python/README.md) para os limites, privacidade e
configuração detalhados.

## Estado de comercialização

Este repositório ainda não define uma licença de distribuição para o produto
completo, uma versão de produção, níveis de suporte ou condições comerciais.
O metadado de licença do pacote Python não concede, por si só, uma licença
uniforme para o frontend, os serviços e os materiais de terceiros. Não
distribua nem anuncie direitos de revenda antes de rever a titularidade do
código, as licenças das dependências e os direitos das integrações.

O rascunho de oferta encontra-se em
[sales/fiverr/ProtectIA-Draft.md](sales/fiverr/ProtectIA-Draft.md). É material
interno, não uma licença nem uma oferta pronta a publicar: faltam decisões de
licenciamento, preço, suporte, versão e entrega, além da validação final da
instalação e da experiência comercial. Não se anuncia proteção antivírus,
garantia de segurança de URLs ou scoring de risco real.

## Pré-requisitos

- Node.js 24 e pnpm 10.15.1
- Python 3.12 e Poetry 2.2.1
- Rust stable e Cargo
- .NET SDK 10
- Docker Desktop, para executar a stack completa

## Executar a stack completa

1. Copie `.env.example` para `.env` na raiz e defina, pelo menos,
   `POSTGRES_PASSWORD` e `REDIS_PASSWORD` com valores locais não reutilizados.
2. Para ativar OAuth, copie `.env.auth.example` para `.env.auth` na raiz,
   configure as credenciais no fornecedor OAuth e registe os callbacks locais
   documentados em [services/api-python/README.md](services/api-python/README.md).
   O `.env.auth` é carregado apenas pelo backend e está ignorado pelo Git.
3. Inicie os serviços:

   ```powershell
   docker compose up --build
   ```

O Compose inicia PostgreSQL, Redis, as três APIs, o frontend e a migração
Alembic (`api-migrate`) antes da API Python. As portas ficam limitadas a
`127.0.0.1`:

| Serviço | URL |
| --- | --- |
| Frontend | <http://localhost:5173> |
| API Python | <http://localhost:8000> |
| API Rust | <http://localhost:3000> |
| API .NET | <http://localhost:8080> |
| PostgreSQL | `localhost:5432` |
| Redis | `localhost:6379` |

O backend Python usa PostgreSQL para os dados da aplicação. O Redis está
disponível na stack, mas não é atualmente o armazenamento de sessões nem o
limiter da autenticação. As ligações aos serviços de dados não devem ser
expostas fora da máquina local sem revisão da configuração.

## Desenvolvimento local

### Instalar dependências do frontend

Na raiz:

```powershell
pnpm install
pnpm --filter frontend dev
```

O servidor Vite fica em <http://localhost:5173> e encaminha `/api` para
`http://localhost:8000`. Para apontar para outra API, define
`VITE_API_PROXY_TARGET`. Não coloques segredos em variáveis `VITE_*`.

### API Python

Inicia PostgreSQL e cria `services/api-python/.env` com a configuração local.
Usa as chaves de sessão e credenciais descritas em
[services/api-python/README.md](services/api-python/README.md). Depois:

```powershell
cd services/api-python
poetry install
poetry run alembic upgrade head
poetry run uvicorn src.app.main:app --reload
```

A API fica em <http://localhost:8000>. O endpoint `/health/ready` verifica a
ligação à base de dados; `/health` é a verificação de liveness.

### APIs Rust e .NET

O serviço Rust requer `DATABASE_URL` e aceita `PORT` (por omissão `3000`):

```powershell
cd services/api-rust
cargo run
```

Rotas: `/health/live` (liveness, não toca na base de dados), `/health/ready` e
`/health` (readiness, 503 se o Postgres estiver indisponível), `/api/hello` e
`/api/version`. Arranca mesmo com o Postgres em baixo e termina de forma ordenada
com Ctrl+C/SIGTERM. Variáveis opcionais: `HOST` (por omissão `0.0.0.0`),
`CORS_ORIGINS` (lista separada por vírgulas; por omissão `http://localhost:5173`),
`DB_MAX_CONNECTIONS` (10), `DB_ACQUIRE_TIMEOUT_SECS` (3), `REQUEST_TIMEOUT_SECS`
(15) e `RUST_LOG`. Valores inválidos impedem o arranque. `api-rust --healthcheck`
é a sonda usada pelo `HEALTHCHECK` do Dockerfile.

O serviço .NET inclui `/health` e o endpoint de exemplo `/weatherforecast`:

```powershell
cd services/api-dotnet/WebApplication1
dotnet run
```

## Build, lint e testes

Os comandos abaixo podem ser executados a partir da raiz, salvo indicação em
contrário:

```powershell
pnpm --filter frontend lint
pnpm --filter frontend test
pnpm --filter frontend build
pnpm run check:python
pnpm run check:rust
pnpm run check:dotnet
```

Os testes da API Python:

```powershell
cd services/api-python
poetry run python -m unittest discover -s tests -v
```

Os comandos `check:*` são verificações locais independentes; os workflows de CI
em `.github/workflows/ci.yml` são a referência para os passos executados em
pull requests e na branch `main`.

## Configuração e segurança

- `.env.example` documenta a configuração local do Compose. Não faça commit de
  `.env`, `.env.auth` ou de outros ficheiros com credenciais.
- Para OAuth, registe os callbacks exatos no fornecedor e mantenha o mesmo
  hostname (`localhost`, sem alternar para `127.0.0.1`) durante o fluxo.
- `SECRET_KEY`, `SESSION_ENC_KEY` e `SESSION_JWT_SECRET` são segredos do backend;
  gere valores próprios e não reutilize segredos OAuth como chaves de sessão.
- A chave da API de IA e as credenciais Cloudflare/Stripe ficam apenas no
  backend. O envio de prompts ou de texto extraído de PDFs ao fornecedor de IA
  depende da configuração e das funcionalidades usadas.
- Os textos legais fornecidos são modelos, não certificam conformidade legal.
  Reveja-os para a entidade, jurisdições, finalidades e subprocessadores reais
  antes de disponibilizar o serviço.
- Os limites locais de pedidos não substituem controlos de gateway/WAF numa
  implantação com múltiplas réplicas.

Consulte [SECURITY.md](SECURITY.md) e a documentação de cada serviço antes de
uma implantação pública.

## Infraestrutura e deployment

- [Bicep para Azure](infra/azure/README.md)
- [Terraform](infra/terraform/README.md)
- Plano e workflow de deployment Azure: [`.azure/`](.azure/) e
  [`.github/workflows/azure-deploy.yml`](.github/workflows/azure-deploy.yml)
- Sincronização de DNS Cloudflare:
  [`.github/workflows/cloudflare-dns.yml`](.github/workflows/cloudflare-dns.yml)

Revise os valores, segredos e permissões de cada ambiente antes de executar
qualquer deployment.
