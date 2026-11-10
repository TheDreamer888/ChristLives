# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Aegis (repo name "ProtectIA") is a polyglot monorepo with three independent backend
services and one frontend, unified only by Docker Compose and CI — there is no shared
build system across languages. Comments, docstrings, and commit messages are
predominantly in Portuguese; match that when editing existing files.

```
apps/frontend/      React 19 + Vite + TypeScript — UI, WebAuthn/OAuth auth client
services/api-python/  FastAPI — main API: OAuth+WebAuthn auth, Cloudflare DNS, risk scoring
services/api-rust/    Axum — Postgres-backed service (currently a minimal skeleton)
services/api-dotnet/  ASP.NET (.NET 10) — minimal API skeleton
infra/scripts/         Maintenance scripts (cert expiry check, monorepo migration helper)
```

Each service manages its own dependency manifest and lifecycle (Poetry, Cargo, dotnet
CLI). The pnpm workspace (`pnpm-workspace.yaml`) covers only `apps/*`.

## Commands

### Root (pnpm)
```bash
pnpm install                # installs apps/frontend only (workspace = apps/*)
pnpm run build               # = build:frontend
pnpm run lint:frontend       # oxlint
pnpm run check:python        # python -m compileall over services/api-python/src
pnpm run check:rust          # cargo check --manifest-path services/api-rust/Cargo.toml
pnpm run check:dotnet        # dotnet build (no-restore) on the WebApplication1 project
pnpm run audit:security      # pnpm audit --audit-level high
```
`check:*` scripts require the respective SDK installed locally; they're thin wrappers,
not full CI parity — see `.github/workflows/ci.yml` for what actually gates PRs.

### Frontend (`apps/frontend`)
```bash
pnpm --filter frontend dev       # Vite dev server, http://localhost:5173
pnpm --filter frontend lint      # oxlint
pnpm --filter frontend build     # tsc -b && vite build
pnpm --filter frontend preview
```

### API Python (`services/api-python`)
```bash
cd services/api-python
poetry install
poetry run uvicorn src.app.main:app --reload   # http://localhost:8000
```
Requires a `.env` in this directory with at least `SECRET_KEY`, `SESSION_ENC_KEY`,
`SESSION_JWT_SECRET` — the app refuses to boot in production without `SECRET_KEY`
(`settings.require_secret_key()` in `src/app/config.py`). No test suite exists yet
despite pytest/pytest-asyncio/pytest-cov being declared as dev dependencies; CI only
runs `python -m compileall`. Dev-dependency scanners available but not wired into CI:
```bash
poetry run bandit -r src
poetry run pip-audit   # (install separately: not a poetry dependency)
```

### API Rust (`services/api-rust`)
```bash
cd services/api-rust
cargo run             # http://localhost:3000, needs DATABASE_URL (Postgres) and PORT
cargo check --locked
cargo test --locked
```

### API .NET (`services/api-dotnet/WebApplication1`)
```bash
cd services/api-dotnet/WebApplication1
dotnet restore
dotnet run             # http://localhost:8080
dotnet build --no-restore --configuration Release
```

### Full stack via Docker
```bash
docker compose up --build
```
Ports: frontend `:5173`, api-python `:8000`, api-rust `:3000`, api-dotnet `:8080`,
postgres `:5432`, redis `:6379` (all bound to `127.0.0.1` only). `POSTGRES_PASSWORD`
and `REDIS_PASSWORD` are required env vars with no defaults — compose fails fast if
unset.

## Architecture notes

### api-python is the real backend; api-rust/api-dotnet are skeletons
`services/api-python` holds essentially all product logic: full auth stack, Cloudflare
DNS management, and risk scoring. `api-rust` exposes only health probes
(`/health/live`, `/health/ready`, `/health`), `/api/hello` and `/api/version` over a
lazy Postgres pool (modules: `config.rs` env validation, `app.rs` router +
middleware + tests, `error.rs` JSON errors); `api-dotnet` is the default ASP.NET minimal-API
template plus `/health`. Don't assume feature parity across services — check
`src/app/main.py` (Python) for the actual mounted routers before assuming a route
exists elsewhere.

### Auth flow (services/api-python/src/app/auth/)
This is the most complex subsystem in the repo. Key files:
- `routes.py` — all `/api/auth/*` endpoints (OAuth start/callback, WebAuthn
  register/login, backup-code recovery, session, consent). Read the module
  docstring — it documents the security model directly.
- `tokens.py` — session issuance/verification. The session cookie value is a JWT
  (HS256, `SESSION_JWT_SECRET`) further encrypted with Fernet (`SESSION_ENC_KEY`),
  so the browser holds an opaque blob it cannot decode even with devtools. Set as
  httpOnly/SameSite=Lax (Secure when `ENV=production`).
  - `providers.py` — OAuth provider registry (Google/Microsoft/GitHub/...);
  `enabled_providers()` reflects whichever client id/secret env vars are set.
- `webauthn.py` — passkey/security-key registration and assertion verification.
- `recovery.py` — one-time backup codes (hashed at rest, popped on redemption).
- `store.py` — **`Store` is an explicit process-local, in-memory placeholder**
  (dict-backed, single-instance/dev only — data is lost on restart and doesn't work
  across multiple instances). The docstring says to swap it for Postgres (users/
  credentials) + Redis (short-lived challenges) without touching `routes.py`, even
  though sqlalchemy/asyncpg/redis are already in `pyproject.toml`. Don't assume
  persistence works beyond a single dev process.

Every OAuth provider uses Authorization Code + PKCE; `state` and `code_verifier`
travel in a short-lived encrypted cookie, never in JS-readable storage.

### Frontend auth client (apps/frontend/src/auth/)
- `authClient.ts` is the single entry point the UI uses for all auth operations; it
  talks to `services/api-python` via `fetch` with `credentials: "include"` so the
  httpOnly session cookie flows automatically. It never touches the session token
  directly — real tokens never reach JS.
- `secureStore.ts` caches only a non-sensitive profile snapshot in IndexedDB,
  encrypted with a non-extractable (`extractable: false`) AES-GCM `CryptoKey`, so not
  even this module's own code can ever export the raw key material. Used as an
  offline fallback in `getSession()` only.
- Styling is layered: `Workspace.css` → `WorkspaceTheme.css` → `WorkspaceModern.css`
  (tokens, type scale, mobile bottom nav) → `WorkspaceDark.css` (dark mode, active on
  `<html data-theme="dark">`). Theme preference (`src/lib/theme.ts`) lives in
  localStorage as a purely visual setting and is applied pre-render by
  `public/theme-init.js` (external file because CSP forbids inline scripts) — keep the
  two in sync; `tests/theme.test.mjs` checks the shared key and colors.
- `VITE_API_BASE_URL` selects the backend origin (defaults to
  `http://localhost:8000`).

### AI product surface (chat, markets, economy, organize)
The site is an AI workspace (the earlier faith/Bible theme was replaced; old hashes
`#assistant`, `#markets`, `#intelligence`, `#education`, `#worship` redirect via
`LEGACY_VIEWS` in `WorkspaceApp.tsx`). Backend routers in `services/api-python/src/app/routers/`:
- `chat.py` — `/api/chat` multi-provider chat. Claude via the official `anthropic` SDK
  (`claude-opus-5-5`, `fallbacks="default"` server-side refusal fallback); ChatGPT and
  Grok via OpenAI-compatible Chat Completions. A provider is listed only if its key is
  set. Adult-content input filter, credential rejection, per-IP hourly limit, modes
  `general|trading|tutor|organize`; client-sent context is wrapped as untrusted data.
  History is never stored server-side.
- `markets.py` — `/api/markets/news` (Finnhub if `FINNHUB_API_KEY`, else public RSS
  feeds parsed with `defusedxml`, GDELT as a rate-limited fallback) and
  `/api/markets/quotes` (Finnhub only, 503 without a key). In-memory TTL cache.
- `economy.py` — `/api/economy/indicators`, World Bank WDI proxy with a closed
  indicator allow-list.
- `organize.py` — Notion task create/list (server token, requires session) and per-user
  read-only mail (Gmail `gmail.readonly`, Outlook Graph `Mail.Read`): own OAuth+PKCE flow
  in `auth/mail_connectors.py` (encrypted flow cookie bound to the session user, tokens
  Fernet-encrypted with `MAIL_TOKEN_ENC_KEY` in `mail_connections`), mailbox reading and
  plain-text normalization in `routers/mailbox.py`. `/status` reports
  `connected`/`not-connected`/`not-configured` (+ missing env var names) per user.
`main.py` calls `truststore.inject_into_ssl()` so outbound HTTPS trusts the OS store
(needed behind TLS-intercepting AV/proxies). Frontend views live in
`apps/frontend/src/components/ai/` (lazy-loaded), with testable logic in
`src/lib/{aiApi,markdown,trading,courses,time}.ts`. AI answers render through the
safe markdown parser — never `dangerouslySetInnerHTML`.

### Firewall and AI supervisor (services/api-python/src/app/)
- `firewall.py` — application WAF registered as middleware in `main.py` (order, outside
  in: security headers → CORS → firewall → routes). Per request: allowlist → manual/auto
  blocks → IP reputation from real public feeds (FireHOL level 1, Spamhaus DROP,
  Emerging Threats; refreshed every 6 h, retried after 5 min on failure; bogons are
  dropped) → method/body size → regex signatures on path + query + User-Agent → token
  bucket per IP. Violations auto-ban after `FIREWALL_BAN_THRESHOLD` in 10 min. Request
  bodies are deliberately not signature-scanned (chat text legitimately contains SQL or
  code). State is per process. `X-Forwarded-For` is honoured only from `TRUSTED_PROXIES`.
- `supervisor.py` — Claude as an independent reviewer: `review_answer` checks every chat
  answer (from any provider) via structured output before it is returned
  (`chat.py`); `triage` analyses firewall events and proposes IPs to block — never
  applied automatically. If unconfigured or failing, answers are labelled
  unsupervised, never "verified".
- `routers/security_center.py` — `/api/security/status` (public, counts only) plus
  admin-only events/blocklist/refresh/triage for verified emails in
  `SECURITY_ADMIN_EMAILS`.
- The old hash-based `RiskModel` / `POST /api/protect/risk-score` placeholder was removed
  (nothing simulated is served).
- Perimeter scripts in `infra/scripts/` (bash + curl/wget): `security-smoke.sh` (live
  checks of headers and firewall blocks), `update-nginx-blocklist.sh` (feeds → nginx
  `geo` include used by `apps/frontend/nginx.conf`), `cloudflare-waf.sh` (Rulesets API;
  dry-run unless `--apply`, which replaces the zone's custom/ratelimit rules).

### Cloudflare DNS management (services/api-python/src/app/routers/dns.py)
Thin proxy over the Cloudflare API v4 (`/zones/{zone_id}/dns_records`) requiring
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID`; returns 503 if unconfigured. Also
synced independently via `.github/workflows/cloudflare-dns.yml` in CI.

### Config and secret handling (services/api-python/src/app/config.py)
`Settings` (pydantic-settings) loads from `.env` + environment. `redact()` deep-scrubs
dict/list/tuple/set structures for any key matching password/secret/token/key/
authorization/api_key before logging — reuse it rather than hand-rolling redaction
when logging request/response bodies.

## Security posture (intentional, don't "fix")

- pnpm is locked down hard in `pnpm-workspace.yaml`: `frozenLockfile`,
  `ignoreScripts`, `strictSsl`, `blockExoticSubdeps`, `minimumReleaseAge: 1440`
  (packages must be 24h old), and `allowBuilds.esbuild: false`. These are
  deliberate supply-chain hardening choices — don't loosen them to unblock an
  install; find the underlying dependency issue instead.
- Session tokens are never stored in localStorage/sessionStorage by design (XSS
  mitigation) — keep new client-side state out of those APIs for anything
  session-related; use `secureStore.ts`'s pattern (non-extractable key,
  IndexedDB) or httpOnly cookies instead.
- All service ports in `docker-compose.yml` bind to `127.0.0.1` only, and
  Postgres/Redis passwords have no defaults (`:?Set ... in .env`) — preserve
  both patterns when adding services.
- The frontend nginx only serves GET/HEAD, hides dotfiles/config extensions, rate-limits
  per IP, includes the IP blocklist and sends a strict CSP (`style-src 'unsafe-inline'`
  is needed for React style attributes; `connect-src https:` allows a separate API
  origin). Don't add inline scripts — CSP blocks them (hence `public/theme-init.js`).
- Session DB access is `session_factory()()` (the function returns the sessionmaker);
  `session_factory()` alone silently breaks session checks.

## CI (.github/workflows/ci.yml)

Four independent jobs, each scoped to one part of the tree — a change to one
service doesn't need the others' toolchains to pass:
- **frontend**: `pnpm install --frozen-lockfile --ignore-scripts` → lint → build
- **python**: Poetry install → `python -m compileall` (no tests currently run in CI)
- **rust**: `cargo check --locked` → `cargo test --locked`
- **dotnet**: `dotnet restore` → `dotnet build --configuration Release`

Two more workflows: `cloudflare-dns.yml` (DNS sync) and `npm-pnpm-security.yml`
(dependency security scanning).
