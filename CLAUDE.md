# CLAUDE.md

Guia para o Claude Code neste repositório. Escreve código, comentários, commits e
textos da interface em **português de Portugal**.

## O que é

Lusorbe: espaço de segurança digital, literacia financeira e aprendizagem, com
admin, lista de espera, SDK e assistente opcional. Monorepo poliglota:

```
apps/frontend/          React 19 + Vite + TS — a app (workspace, admin, assistente)
packages/sdk/           @lusorbe/sdk — cliente TS gerado a partir do OpenAPI da API
services/api-python/    FastAPI — a API real (auth, admin, lista de espera, assistente, DNS)
services/api-rust/      Axum — esqueleto (só /health)
services/api-dotnet/    ASP.NET — esqueleto (só /health)
apps/frontend/public/legal/  Termos e privacidade (HTML estático)
```

Só `services/api-python` tem lógica de produto. Antes de assumir que uma rota existe,
vê os `include_router` em `services/api-python/src/app/main.py`.

## Comandos

```bash
# Tudo o que o CI corre (ver .github/workflows/ci.yml)
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @lusorbe/sdk check:generated && pnpm --filter @lusorbe/sdk typecheck && pnpm --filter @lusorbe/sdk test
pnpm --filter frontend lint && pnpm --filter frontend test && pnpm --filter frontend build

cd services/api-python
poetry check --lock && poetry install
poetry run python scripts/export_openapi.py --check
poetry run pytest -q          # testes de Postgres/Redis só correm com essas envs
poetry run uvicorn src.app.main:app --reload   # http://localhost:8000
```

`pnpm --filter frontend dev` arranca a app em http://localhost:5173 (compila o SDK antes).

## Regras que não se partem

- **Contrato API ↔ SDK:** ao mudar uma rota com tag do SDK (`SDK_TAGS` em
  `scripts/export_openapi.py`), corre `pnpm run sdk:generate` e faz commit de
  `packages/sdk/openapi.json` e `src/generated/schema.ts`. O CI falha se divergirem.
  Atualiza também `packages/sdk/CHANGELOG.md`.
- **Textos legais:** se uma funcionalidade passa a tratar dados novos ou a enviá-los a
  outra empresa, atualiza `privacy.html` e `terms.html` no mesmo PR. Nunca inventes
  dados do responsável, prazos ou fornecedores: usa `<span class="todo">…</span>`.
- **Textos da app em várias línguas:** nada de texto fixo nos componentes da app
  (exceto a consola de administração, que é interna e fica em pt-PT). Acrescenta a
  chave em `apps/frontend/src/i18n/pt-PT.ts` e a tradução em `en`, `es`, `fr`, `de` e
  `pt-BR`; o tipo `Messages` e o teste `tests/i18n.test.mjs` falham se faltar alguma.
- **Sem dados internos no site público:** nada de nomes, emails, números de PR ou
  métricas internas na landing ou nas páginas legais.
- **Segredos:** nunca em código nem no frontend. `ANTHROPIC_API_KEY`,
  `CLOUDFLARE_API_TOKEN`, chaves de sessão, etc. vivem só no servidor (`.env`, segredos
  do alojamento). Nunca leias nem escrevas `.env` reais.
- **Sessões:** tokens nunca em `localStorage`/`sessionStorage`. Cookie httpOnly
  cifrado (`auth/tokens.py`); no browser só um perfil não sensível em IndexedDB com
  chave não exportável (`apps/frontend/src/auth/secureStore.ts`).
- **pnpm endurecido de propósito** (`pnpm-workspace.yaml`: `frozenLockfile`,
  `ignoreScripts`, `minimumReleaseAge`, `blockExoticSubdeps`…). Não afrouxes para
  desbloquear uma instalação; resolve a dependência.
- **docker-compose:** portas só em `127.0.0.1`, passwords de Postgres/Redis sem valor
  por omissão.

## Arquitetura da API (services/api-python/src/app/)

- `auth/` — OAuth (PKCE) + passkeys + códigos de recuperação. `routes.py` documenta o
  modelo de segurança. `_require_user` e `_require_same_origin` protegem rotas novas;
  `auth_routes.limiter` (Redis ou memória) é o limitador partilhado.
- `auth/store.py` — `MemoryStore` sem `DATABASE_URL`, `SqlStore` com ela
  (concorrência otimista por `version`).
- `admin/` — RBAC, regra de duas pessoas, auditoria só de inserção (ver `admin/README.md`).
- `waitlist.py` — inscrição com consentimento versionado e expiração a 365 dias.
- `assistant.py` — Claude via SDK `anthropic`; desligado sem `ANTHROPIC_API_KEY`;
  exige sessão, Origin e `consent: true`; limites por conta; não guarda conversas.
  Nos testes injeta um cliente falso com `set_client()`.
- `config.py` — `Settings` e `redact()`: usa-o antes de registar corpos de pedidos.
- `/api/protect/risk-score` é uma heurística por hash, **não** um modelo: não a
  apresentes como deteção real.

## Testes

- Python: `services/api-python/tests/`. Rotas novas precisam de testes de sessão,
  Origin, limites e erros sem fuga de detalhes (segue `test_assistant.py`).
- SDK: `packages/sdk/test/` com `fetch` falso.
- Mudanças visíveis na app: verifica no browser, incluindo 375 px sem scroll lateral.

Comandos prontos em `.claude/commands/` e revisores em `.claude/agents/`.
