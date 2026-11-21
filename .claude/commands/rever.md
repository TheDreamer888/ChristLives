---
description: Revê as alterações do branch atual (segurança e privacidade) com os revisores do projeto
---

1. Vê o que mudou: `git diff --stat main...HEAD` e `git diff main...HEAD`.
2. Pede ao agente `revisor-seguranca` que reveja o diff.
3. Se o diff toca em dados pessoais, em fornecedores externos ou em
   `apps/frontend/public/legal/`, pede também ao agente `revisor-privacidade`.
4. Junta os resultados numa lista única, do mais grave para o menos grave, com
   `ficheiro:linha` e uma correção proposta. Não apliques correções sem perguntar.

$ARGUMENTS
