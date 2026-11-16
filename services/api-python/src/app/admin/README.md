# Consola de administração

Abre em `/#admin` no frontend. A API está em `/api/admin/*`.

## O que protege cada pedido

| Controlo | Como funciona |
|---|---|
| Acesso escondido | Quem não tem função de staff recebe `404`: a consola não se anuncia. |
| Autenticação forte | O login dessa sessão tem de ter sido com **passkey** (FIDO2, resistente a phishing). |
| Sessão curta | As sessões de admin valem no máximo 1 h (`ADMIN_SESSION_MAX_AGE`). |
| Redes autorizadas | `ADMIN_IP_ALLOWLIST` limita o acesso a redes conhecidas (CIDR). |
| Menor privilégio | 5 funções com permissões granulares (`rbac.py`). |
| Step-up | Alterações exigem login nos últimos 15 min. |
| Justificação | Cada alteração exige um motivo (≥ 10 caracteres), que fica na auditoria. |
| Regra das duas pessoas | Proprietário/Administrador só com pedido + aprovação de **outro** proprietário. |
| Separação de funções | Ninguém altera a própria conta nem aprova os próprios pedidos. |
| Último proprietário | Não pode ser suspenso nem perder a função. |
| Revogação imediata | Suspender, revogar sessões ou mudar funções invalida já os tokens existentes. |
| Auditoria inviolável | Registo só de acrescentar, encadeado por HMAC-SHA256; `/audit/verify` deteta edições. |
| Negações auditadas | Tentativas sem permissão, sem passkey ou fora da rede também ficam registadas. |
| Exportação segura | CSV com proteção contra injeção de fórmulas no Excel. |
| Sem cache | Todas as respostas levam `Cache-Control: no-store`. |

## Funções

| Função | Pode |
|---|---|
| Proprietário | Tudo, incluindo aprovar elevações. |
| Administrador | Gerir contas e funções não privilegiadas; pedir elevações. |
| Analista de segurança | Ver contas, revogar sessões, ler e exportar auditoria. |
| Suporte | Ver contas com emails mascarados. |
| Auditor | Ler e exportar auditoria; ver a postura de segurança. |

## Variáveis de ambiente

| Variável | Omissão | Para quê |
|---|---|---|
| `ADMIN_BOOTSTRAP_EMAILS` | — | Email(s) verificados que se tornam o **primeiro** proprietário. Só funciona enquanto não houver nenhum. |
| `ADMIN_REQUIRE_PASSKEY` | `true` | Exigir passkey nas sessões de admin. |
| `ADMIN_TWO_PERSON_RULE` | `true` | Regra das duas pessoas. |
| `ADMIN_SESSION_MAX_AGE` | `3600` | Duração máxima da sessão de admin (segundos). |
| `ADMIN_IP_ALLOWLIST` | — | Ex.: `10.0.0.0/8,203.0.113.7/32`. |
| `ADMIN_ACTIONS_PER_MINUTE` | `20` | Limite de alterações por administrador. |
| `AUDIT_HMAC_KEY` | aleatória | **Obrigatória em produção**, senão a cadeia não sobrevive a reinícios. |
| `AUDIT_LOG_PATH` | — | Cópia JSONL para enviar a um SIEM ou armazenamento imutável. |

## Primeiro acesso

1. Define `ADMIN_BOOTSTRAP_EMAILS` com o teu email e `AUDIT_HMAC_KEY` com um segredo longo.
2. Entra com Google/Microsoft/GitHub (email verificado) e regista uma passkey.
3. Sai e volta a entrar **com a passkey**. Abre `/#admin`.
4. Nomeia um segundo proprietário (a postura de segurança pede-o).

## Limites conhecidos

O `Store` ainda é em memória, numa só instância. Para produção com várias instâncias,
utilizadores, aprovações e auditoria têm de passar para Postgres (com a auditoria
numa tabela só de inserção) e os limites de ritmo para Redis.
