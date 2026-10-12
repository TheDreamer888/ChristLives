# Aegis API (Python)

API principal em FastAPI: autenticação, DNS (Cloudflare), scoring de risco (ver `src/ml`) e análise autenticada de PDFs com IA.

## Setup local (venv)

```powershell
..\.venv\Scripts\python.exe -m pip install -e .
```

Cria um `.env` nesta pasta (não commitado) com pelo menos `SECRET_KEY`,
`SESSION_ENC_KEY` e `SESSION_JWT_SECRET` — ver `.env.example` na raiz do
repositório. A app recusa arrancar sem `SECRET_KEY` (`settings.require_secret_key()`).

## Login local com Google, Microsoft e GitHub

Os Client IDs e Client Secrets são emitidos pelos próprios provedores — não são
gerados por esta aplicação. Cria uma aplicação OAuth em cada consola oficial e
regista os callbacks locais exatamente como abaixo:

| Provedor | Callback local |
| --- | --- |
| Google | `http://localhost:8000/api/auth/oauth/google/callback` |
| Microsoft | `http://localhost:8000/api/auth/oauth/microsoft/callback` |
| GitHub | `http://localhost:8000/api/auth/oauth/github/callback` |

Regista os URLs em **Authorized redirect URIs** no Google Cloud Console, em
**Authentication > Web > Redirect URI** no Microsoft Entra e em
**Authorization callback URL** na GitHub OAuth App. No Microsoft Entra, a
autoridade atual usa `/common`; configura o registo para os tipos de conta que
queres aceitar. Guarda os IDs e segredos no backend:
para Docker Compose, copia `.env.auth.example` para `.env.auth` na raiz e
preenche os valores; para executar a API diretamente, coloca-os em
`services/api-python/.env`. O Compose carrega o ficheiro `.env.auth` apenas no
serviço Python. Não os coloques em variáveis `VITE_*`, no frontend, no Git ou
em mensagens. A aplicação só mostra cada botão quando ambos os valores estão
configurados.

Gera as chaves de sessão localmente com os comandos PowerShell nos comentários
de `.env.auth.example`; não reutilizes o Client Secret OAuth como chave de sessão.

Os endereços acima são para desenvolvimento local por HTTP, não para produção.
OAuth continua a comunicar com os provedores pela Internet e por HTTPS; o
retorno HTTP só aponta para `localhost`. Usa o mesmo nome de host em todo o
fluxo (`localhost`, sem alternar para `127.0.0.1`). Se o frontend estiver em
`http://localhost:5174`, define também `PUBLIC_FRONTEND_URL` e
`WEBAUTHN_ORIGIN` para essa origem. As origens Vite em `localhost:5173` e
`localhost:5174` estão permitidas por omissão em desenvolvimento; define
`CORS_ORIGINS` explicitamente se usares outra origem. No Compose,
`PUBLIC_API_URL`, `PUBLIC_FRONTEND_URL` e `CORS_ORIGINS` vêm do `.env` da raiz.
Define `PUBLIC_API_URL` como a origem pública da API (por exemplo,
`https://api.exemplo.com`) e regista o callback
`{PUBLIC_API_URL}/api/auth/oauth/{provedor}/callback` em cada provedor OAuth.
O URL tem de ser o mesmo no início e no retorno do fluxo. Em desenvolvimento,
o Compose usa `http://localhost:8000` por omissão.

O Microsoft UserInfo pode não devolver `email_verified`. Nesse caso, a conta
fica separada e identificada pelo `sub` da Microsoft; o email não é guardado
como verificado nem usado para associar contas. As identidades OAuth são
persistidas em `oauth_identities` pela migração Alembic seguinte.

O login local não torna o serviço totalmente offline: Google, Microsoft ou
GitHub processam a autenticação e recebem os dados necessários ao fluxo. O
modo local mantém aplicação, base de dados e segredos de configuração no
dispositivo, mas não evita essa comunicação com o provedor escolhido. Os
textos legais existentes são modelos e não certificam conformidade com RGPD,
LGPD ou outras leis; antes de produção, adapta-os à entidade responsável,
países, finalidades, prazos e subprocessadores e obtém revisão jurídica.

Um `401` em `GET /api/agency/agencies` sem sessão iniciada é esperado; não
removas a autenticação dessa rota para esconder o aviso. `GET /api/agency/plans`
pode responder `200` sem sessão. Depois do login, confirma
`GET /api/auth/session`; se não houver sessão, verifica os callbacks e mantém o
mesmo host no frontend (`localhost`, sem alternar para `127.0.0.1`), além de
ajustar `PUBLIC_FRONTEND_URL`, `CORS_ORIGINS` e `WEBAUTHN_ORIGIN` para a origem
local em uso.

Para ativar o assistente documental, melhoria de texto e análise de PDFs,
configura no servidor `AI_API_KEY`, opcionalmente `AI_BASE_URL` (por omissão
`https://api.openai.com/v1`) e `AI_MODEL` (por omissão `gpt-4o-mini`). A chave
fica apenas no backend. Nunca a coloques no frontend nem a envies num pedido
do navegador. O assistente responde apenas com excertos da documentação do
produto, não guarda histórico e devolve links para as fontes. As mensagens são
enviadas ao fornecedor configurado; avalia os termos, a retenção e as opções
de não utilização para treino desse fornecedor antes de produção. O assistente
não presta aconselhamento jurídico, médico ou financeiro.
O chat também rejeita entradas que pareçam conter emails, números de telefone
ou credenciais antes de as enviar ao fornecedor. Esta deteção é uma salvaguarda
adicional, não uma garantia de anonimização; não introduzas dados sensíveis.
O estudo bíblico também usa `POST /api/assistant/bible-chat`, com o mesmo
fornecedor, limite por endereço IP e salvaguardas para entradas sensíveis. O
endpoint não consulta nem cita uma tradução bíblica em tempo real: recomenda
confirmar referências numa Bíblia publicada. Aceita até 10 mensagens anteriores
para dar contexto à conversa. A funcionalidade é grátis para o visitante, mas o
fornecedor configurado pode cobrar ao operador. A pergunta e o contexto são
encaminhados ao fornecedor e não são persistidos pelo Aegis.

## Conhecimento legal e de segurança do assistente

O catálogo curado está em `src/app/knowledge/catalog.json`; as regras de
resposta estão em `assistant_policy.md`, e as sínteses legíveis para revisão
humana em `legal-pt-eu.md` e `security-guidance.md`. O catálogo é carregado pelo
backend no arranque e incluído nos pacotes Poetry. A pesquisa é local, limitada
a fontes aprovadas em HTTPS e não faz pesquisa web em tempo real.

`GET /api/assistant/knowledge/sources` lista as referências aprovadas e
`GET /api/assistant/knowledge/search?q=...&limit=...` devolve correspondências
locais. As citações incluem autoridade e data de revisão manual; essa data não
significa que a lei tenha sido sincronizada automaticamente. Para atualizar,
confirma a fonte oficial, revê os excertos e a política e atualiza a data em
`catalog.json`. A síntese não é parecer jurídico nem certificação de segurança.

O pedido de contato comercial é separado do chat e exige confirmação de 18+
e consentimento explícito. Guarda apenas nome e email, cifrados com
`SALES_LEAD_ENC_KEY` (chave Fernet separada de `SESSION_ENC_KEY`), em
`SALES_LEAD_DB_PATH`. O prazo configurável é `SALES_LEAD_RETENTION_DAYS`
(1–365; 30 por omissão); um processo de limpeza remove pedidos expirados e o
formulário devolve um código para apagar o pedido antes do prazo. A base de
dados SQLite deve ficar num volume persistente e privado. Para múltiplas
réplicas, substitui-a por armazenamento transacional partilhado e limita o
assistente num gateway/WAF; o limite local de pedidos não coordena réplicas.
Não coloques a chave de cifra no repositório. A chave perdida torna os contatos
armazenados irrecuperáveis.

O texto extraído do PDF é enviado ao fornecedor de IA configurado e não é
guardado pelo Aegis. Esse endpoint exige sessão autenticada.

## Agências, workspaces e faturação

As contas, chaves WebAuthn, códigos de recuperação, workspaces de cliente,
permissões, convites e estado das subscrições ficam no PostgreSQL. As migrações
Alembic criam o esquema; em Docker Compose o serviço `api-migrate` executa-as
antes de iniciar a API. Fora do Compose, aplica-as uma vez antes de publicar:

```powershell
poetry run alembic upgrade head
```

Cada utilizador autenticado é proprietário da sua agência inicial. Workspaces
de cliente só podem ser criados com uma subscrição ativa. A API aplica limites
por plano: Starter (5), Growth (25) e Scale (100). Membros convidados recebem
acesso apenas aos clientes selecionados; administradores gerem todos os
clientes. As rotas aceitam `X-Agency-ID` para selecionar uma agência à qual o
utilizador já pertença.

Para ativar checkout, configura `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` e
um `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH` e `STRIPE_PRICE_SCALE`
correspondente a cada preço recorrente criado no Stripe. Regista
`POST /api/agency/stripe/webhook` como webhook Stripe. O checkout e o portal de
faturação são criados no backend; o plano só é ativado/alterado depois de
validar a assinatura de um evento Stripe. Os links de convite expiram em 7 dias
e são devolvidos uma única vez pela API; não há envio de email configurado.

Os limites antigos de operações de IA permanecem um protótipo independente:
as quotas Free ainda residem em memória, não são faturadas nem ligadas aos
planos Starter/Growth/Scale. Não anunciar quotas de IA como capacidade
contratual até persistir e associar esse uso à subscrição.

## Correr o servidor

### Painel de filtros de proteção

`POST /api/protect/check-url` aceita `{"url":"https://example.com"}` ou um
domínio. O painel Segurança consulta no servidor a lista pública
[HaGeZi TIF mini](https://github.com/hagezi/dns-blocklists), que agrega malware,
phishing e outras ameaças, incluindo correspondências de domínios-pai.
A lista é descarregada por HTTPS no primeiro pedido e renovada após oito
horas; o processo mantém a cópia em memória e nunca envia o URL submetido
à fonte. A data apresentada indica a descarga, não a revisão de cada entrada.
Falhas de atualização devolvem 503, sem apresentar um destino como seguro.

As regras locais bloqueiam HTTP, credenciais incorporadas, destinos locais/IPs,
portas não habituais e caminhos terminados em extensões executáveis/scripts.
Os resultados são `blocked` ou `not_listed` — este último **não garante
segurança**. Não se visitam destinos, não se analisam ficheiros, conteúdo ou
redirecionamentos, e não há botão para abrir o URL no painel. Não introduzir
dados pessoais ou segredos. Falsos positivos devem ser revistos na fonte.
Não é um antivírus nem um filtro de rede/browser: aplica-se apenas aos URLs
submetidos à aplicação. Defender, SmartScreen, firewall e políticas Microsoft
não são modificados. A lista externa não é redistribuída com o código;
consultar a licença e o disclaimer do projeto HaGeZi.

```powershell
.\.venv\Scripts\python.exe -m uvicorn src.app.main:app --reload
```

Os testes focados do router de IA podem ser executados com:

```powershell
..\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Antes de lançar comercialmente, identifica o responsável pelo tratamento,
publica contatos e prazos reais, valida a base legal para cada finalidade e
revê os contratos de subprocessamento, transferência internacional e direitos
de titulares conforme os países atendidos. Esta documentação não é parecer
jurídico.

## Controlos de segurança da aplicação

As sessões de autenticação duram até 8 horas e são persistidas no PostgreSQL
para permitir revogação imediata. A área **Conta** lista as sessões ativas e
permite terminar outras sessões; o **Centro de Segurança** apresenta eventos
de login, passkeys, códigos de recuperação e revogações. Os eventos guardam
apenas o tipo, a gravidade e metadados mínimos, são visíveis apenas à conta
associada e são eliminados após 90 dias. Um login com código de recuperação e
a regeneração de códigos aparecem como alertas na aplicação; não é enviado
email nem webhook.

A migração Alembic `20261010_0003` cria as tabelas necessárias e é aplicada
automaticamente pelo serviço `api-migrate` do Compose. Depois da primeira
atualização, as sessões anteriores não têm um registo revogável no servidor;
os utilizadores terão de iniciar sessão novamente.

Os pontos de entrada OAuth, passkey e recuperação partilham um limite por
endereço de origem e janela, configurável por `AUTH_REQUESTS_PER_MINUTE`
(10 por minuto por omissão). O contador é atómico e partilhado entre réplicas
através do PostgreSQL; o endereço original não é guardado — a chave do bucket
é um HMAC com `SECRET_KEY`. O Aegis não confia em `X-Forwarded-For`; em
produção atrás de um proxy, configura também limites no gateway/WAF para
mitigar ataques distribuídos e garantir identificação correta na borda.

A API e o Nginx do frontend enviam cabeçalhos contra MIME sniffing, framing,
referer excessivo e acesso desnecessário a sensores. A API ativa HSTS apenas
em produção quando `PUBLIC_API_URL` está configurado com HTTPS. Mantém TLS no
proxy/gateway e define `ENV=production` no ambiente de produção.

## Segurança de dependências ("antivírus de pacotes")

Ferramentas de scan já declaradas no grupo `dev` do `pyproject.toml`
(`bandit`, `safety`) mais `pip-audit`, instaladas à parte no venv:

```powershell
.\.venv\Scripts\python.exe -m pip install pip-audit bandit
.\.venv\Scripts\python.exe -m pip_audit          # vulnerabilidades conhecidas (OSV/PyPI Advisory)
.\.venv\Scripts\python.exe -m bandit -r src       # padrões de código inseguro
```

Corre estas verificações antes de cada release e sempre que uma dependência
for adicionada ou atualizada.

## Verificação de certificados TLS

O script `infra/scripts/check-cert-expiry.py` (na raiz do repositório) valida
a validade/expiração dos certificados TLS dos domínios usados pela app
(`PUBLIC_API_URL`, `PUBLIC_FRONTEND_URL`, domínio Cloudflare):

```powershell
python ../../infra/scripts/check-cert-expiry.py api.exemplo.com app.exemplo.com
```

Alerta (exit code != 0) quando um certificado expira em menos de 15 dias.
