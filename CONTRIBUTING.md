# Contribuição

Obrigado por contribuir para o Aegis.

## Fluxo de branches

- `main` deve ficar sempre pronta para release.
- Todo o trabalho deve entrar por Pull Request.
- Não faça push direto para `main`.
- Use branches curtas com prefixos descritivos, por exemplo:
  - `feat/...`
  - `fix/...`
  - `chore/...`
  - `docs/...`

## Pull Requests

- Abra PR pequeno e focado numa única mudança.
- Preencha o template com contexto, validação e impacto de segurança.
- Resolva todas as conversas antes do merge.
- Aguarde os checks obrigatórios antes de pedir merge.

## Checks obrigatórios recomendados no GitHub

Configure a proteção da branch `main` para exigir estes checks:

- `Frontend`
- `Python API`
- `Rust API`
- `.NET API`
- `Dependency security`
- `CodeQL JavaScript/TypeScript`
- `CodeQL Python`
- `CodeQL Rust`
- `CodeQL CSharp`

Também é recomendado exigir:

- pelo menos 1 aprovação
- branch atualizada antes do merge
- resolução de todas as conversas
- bloqueio de push direto para `main`

## Labels e triagem

Crie e mantenha pelo menos estes labels no repositório:

- `bug`
- `enhancement`
- `documentation`
- `infra`
- `security`
- `dependencies`

Use milestones para agrupar entregas maiores e manter visibilidade do roadmap.

## Variáveis, secrets e environments

Padronize no GitHub:

- **Secrets**
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ZONE_ID`
- **Variables**
  - `DNS_RECORD_NAME`
  - `DNS_RECORD_TYPE`
  - `DNS_RECORD_CONTENT`
  - `DNS_TTL`
  - `DNS_PROXIED`
- **Environment**
  - `infra-production`

O workflow de DNS deve usar o environment `infra-production`, com aprovação manual se a alteração for sensível.

## Segurança do repositório

Ative nas definições do GitHub:

- Dependabot alerts
- Dependabot security updates
- Code scanning
- Secret scanning
- Push protection

Nunca faça commit de `.env`, tokens, chaves ou dumps com dados reais.
