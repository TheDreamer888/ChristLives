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
| `DATABASE_URL` | — | Postgres (produção) ou SQLite. **Obrigatória em produção.** |
| `REDIS_URL` | — | Limites de pedidos partilhados entre instâncias. |

## Primeiro acesso

1. Define `ADMIN_BOOTSTRAP_EMAILS` com o teu email e `AUDIT_HMAC_KEY` com um segredo longo.
2. Entra com Google/Microsoft/GitHub (email verificado) e regista uma passkey.
3. Sai e volta a entrar **com a passkey**. Abre `/#admin`.
4. Nomeia um segundo proprietário (a postura de segurança pede-o).

## Base de dados

Define `DATABASE_URL` (por exemplo `postgresql://aegis:SENHA@host:5432/aegis`).
Com `ENV=production` a API **não arranca** sem `DATABASE_URL` e `AUDIT_HMAC_KEY`.

As tabelas são criadas no primeiro arranque. Ficam guardados os utilizadores, as
identidades OAuth, os desafios das passkeys, as aprovações e a auditoria, e várias
instâncias da API podem partilhá-los. As escritas usam concorrência otimista:
dois pedidos simultâneos nunca se sobrepõem em silêncio.

Para que nem uma API comprometida consiga reescrever a auditoria, cria as tabelas
com um papel dono e dá à API um papel com permissões mínimas:

```sql
CREATE ROLE aegis_api LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON users, oauth_identities, auth_ephemeral, admin_approvals TO aegis_api;
GRANT SELECT, INSERT ON audit_log TO aegis_api;   -- sem UPDATE nem DELETE
```

## Limites de pedidos (Redis)

Define `REDIS_URL` (por exemplo `redis://:SENHA@host:6379/0`). Os limites passam a ser
partilhados por todas as instâncias da API: um atacante não ganha mais tentativas
por cair noutra instância. A contagem é atómica (script Lua) e usa o relógio do
Redis. Se o Redis falhar, a API continua a limitar com contadores locais e a página
de postura de segurança mostra o controlo em falta até o Redis voltar.
