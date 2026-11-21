---
description: Corre as mesmas verificações do CI (SDK, frontend e API Python) e resume o resultado
---

Corre, por esta ordem, e para no primeiro erro que não consigas resolver:

1. `pnpm install --frozen-lockfile --ignore-scripts`
2. `pnpm --filter @lusorbe/sdk check:generated`, `typecheck` e `test`
3. `pnpm --filter frontend lint`, `test` e `build`
4. Em `services/api-python`: `poetry check --lock`,
   `poetry run python scripts/export_openapi.py --check` e `poetry run pytest -q`

No fim, mostra uma tabela curta: passo, resultado (passou / falhou / ignorado) e,
se falhou, a primeira linha útil do erro. Os testes de Postgres/Redis ignorados sem
essas envs contam como "ignorado", não como falha. Não alteres código sem perguntar.

$ARGUMENTS
