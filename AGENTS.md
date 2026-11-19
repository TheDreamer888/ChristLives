# AGENTS.md

Guia para agentes de código (Codex, Claude Code, etc.). Detalhes adicionais em `CLAUDE.md`.

## Estrutura
- `apps/frontend/` — React 19 + Vite + TypeScript (UI, cliente WebAuthn/OAuth)
- `services/api-python/` — FastAPI (auth OAuth + WebAuthn, DNS Cloudflare, risco)
- `services/api-rust/` — Axum (esqueleto, Postgres)
- `services/api-dotnet/` — ASP.NET (esqueleto)
- `site/` — landing estática publicada no GitHub Pages (raiz); a app fica em `/app/`
- `infra/` — scripts de manutenção

Não há build partilhado entre linguagens; cada serviço gere as suas dependências.

## Setup
```bash
bash scripts/codex-setup.sh      # pnpm install --frozen-lockfile --ignore-scripts
```

## Verificação (antes de propor alterações)
```bash
pnpm --filter frontend lint
pnpm --filter frontend test
pnpm --filter frontend build
cd services/api-python && poetry install && poetry run python -m compileall -q src
```
A CI (`.github/workflows/ci.yml`) é a referência do que bloqueia PRs.

## Convenções
- Comentários, docstrings e mensagens de commit em português; seguir o estilo do código existente.
- Dependências com versão exata; manter `pnpm-lock.yaml` consistente (`--frozen-lockfile`).
- Alterações pequenas e focadas; abrir PR, nunca commit direto em `main`.

## Segurança (obrigatório)
- Nunca incluir segredos, chaves ou tokens no repositório; credenciais ficam no servidor.
- Nunca executar comandos ou código submetidos por utilizadores.
- Sem analytics, anúncios ou fontes remotas no frontend.
- Cookies de sessão: HttpOnly, Secure, SameSite; sem tokens em armazenamento acessível por JavaScript.
- Ver `SECURITY.md` para reportar vulnerabilidades.
