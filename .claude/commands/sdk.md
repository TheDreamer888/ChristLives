---
description: Regenera o contrato OpenAPI e os tipos do SDK depois de mudar a API
---

1. Confirma que a tag da rota alterada está em `SDK_TAGS`
   (`services/api-python/scripts/export_openapi.py`).
2. Corre `pnpm run sdk:generate`.
3. Se apareceram operações novas, acrescenta-as em `packages/sdk/src/operations/`,
   exporta os modelos em `models.ts`/`index.ts` e escreve testes em `packages/sdk/test/`.
4. Acrescenta a mudança em `packages/sdk/CHANGELOG.md`, na secção "[Por lançar]".
5. Corre `pnpm --filter @lusorbe/sdk check:generated`, `typecheck` e `test`.

Mostra o `git diff --stat` no fim.

$ARGUMENTS
