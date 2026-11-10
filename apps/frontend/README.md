# Frontend Aegis

Interface React + TypeScript + Vite de um espaço de IA para conversar, analisar
mercados, aprender economia e organizar o trabalho, mantendo a gestão de agências
e clientes.

## Áreas

- **Início** (`#overview`): pergunta rápida à IA, atalhos, últimas notícias e
  progresso nos cursos.
- **Chat IA** (`#chat`): conversas com Claude, ChatGPT ou Grok (cada um só aparece
  se o backend tiver a chave), modos Geral/Trading/Tutor/Organização, respostas em
  markdown seguro, copiar/regenerar/parar. As conversas ficam só na memória do
  separador. Inclui o separador **Suporte Aegis** (assistente documental e contacto
  comercial).
- **Trading IA** (`#trading`): cotações (Finnhub), análise por IA com cotações e
  títulos como contexto, calculadora de risco e lista de decisão. Não executa
  ordens nem é aconselhamento financeiro.
- **Notícias** (`#news`): notícias globais de mercado por categoria e pesquisa,
  com briefing por IA.
- **Cursos** (`#courses`): lições de economia com dados do Banco Mundial, quizzes
  e tutor IA; o progresso fica no `localStorage` deste browser.
- **Organização** (`#organize`): assistente de email (texto colado), tarefas no
  Notion e estado das ligações Gmail/Outlook.
- **Proteção digital**, **Integrações**, **Clientes**, **Plano e faturação** e
  **Privacidade** mantêm-se.
- Endereços antigos (`#assistant`, `#markets`, `#intelligence`, `#education`,
  `#worship`) redirecionam para as áreas novas.

### Leveza e infraestrutura

Cada área é carregada por `React.lazy`, com SVGs locais e fontes do sistema. Não
carrega imagens externas, vídeos automáticos, fontes remotas, bibliotecas de
animação ou modelos de IA no dispositivo. Isto reduz trabalho evitável, mas não
constitui garantia de fluidez em todos os dispositivos.

Esta alteração não provisiona Cloudflare nem modifica DNS, WAF ou faturação.
Uma futura publicação deve manter APIs autenticadas fora de cache público e
separar assets estáticos de respostas privadas. Custos de IA requerem limites e
monitorização no servidor; não é prometida rentabilidade.

Documentação oficial consultada:
[React lazy](https://react.dev/reference/react/lazy),
[animações de alto desempenho](https://web.dev/articles/animations-guide),
[movimento reduzido](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion),
[cache Cloudflare](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/) e
[custos Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/).

## Workspace e integrações

- A área **Clientes** usa a API de agências: lista clientes acessíveis, pesquisa por
  nome, cria/elimina workspaces e mantém o fluxo de convites existente. As permissões
  e a capacidade continuam a ser impostas pelo servidor.
- Carregamento, ausência de acesso, sessão em falta e falha de ligação têm estados
  explícitos. A interface não substitui respostas em falta por clientes fictícios.
- O catálogo em [integrations.ts](src/lib/integrations.ts) distingue conectores
  planeados de capacidades implementadas. OneDrive, Dropbox, Word e antivírus
  **não estão implementados**; abrir os requisitos não autoriza acesso a ficheiros.
- A configuração de IA é consultada através de `GET /api/ai/plans`, com sessão
  httpOnly. `ai_configured` indica apenas a presença de configuração no backend:
  não confirma disponibilidade, fornecedor, conformidade ou ligação por cliente.
- O Chat IA usa `POST /api/chat`; a mensagem, até 20 mensagens anteriores e o
  contexto escolhido (cotações, títulos, lição ou email colado) são enviados ao
  fornecedor de IA configurado, que pode cobrar ao operador. Nada fica guardado
  pelo Aegis.
- Não são guardadas credenciais de integração no browser. A app não é um antivírus
  e não foi publicada na Play Store por esta alteração.

### Referências e limites

As respostas da IA podem conter erros e não são verificadas automaticamente. O
modo Trading é educativo: não é aconselhamento financeiro e não executa ordens.
O chat recusa conteúdo adulto e rejeita mensagens com palavras-passe ou chaves.

Os requisitos do catálogo apontam para documentação oficial:
[Microsoft Graph](https://learn.microsoft.com/en-us/graph/permissions-reference),
[Word Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/word/word-add-ins-programming-overview),
[Dropbox OAuth](https://developers.dropbox.com/oauth-guide),
[OpenAI](https://platform.openai.com/docs/api-reference/introduction) e
[ClamAV](https://docs.clamav.net/).
A minimização de dados e a privacidade por defeito são orientadas pelo
[RGPD](https://eur-lex.europa.eu/eli/reg/2016/679/oj), sem alegação de certificação.
Não existe integração ou afiliação com SpaceX nesta entrega.

Para monetização, mantém-se o fluxo de planos de agência existente; não são
inventados preços, pagamentos nem projeções de rendimento. Uma futura publicação
Android exige revisão própria das regras de
[pagamentos Google Play](https://support.google.com/googleplay/android-developer/answer/9858738)
e [Data safety](https://support.google.com/googleplay/android-developer/answer/10787469);
o checkout web existente não deve ser considerado automaticamente adequado à loja.

### Validação

```sh
pnpm --filter frontend lint
pnpm --filter frontend build
pnpm --filter frontend test
```

## Configuração Vite

Em desenvolvimento, ambos os clientes (autenticação e produto) usam `/api` na
origem do frontend. O proxy Vite encaminha os pedidos para
`http://127.0.0.1:8000` (IPv4 explícito, porque o Node resolve `localhost` para
`::1`); define `VITE_API_PROXY_TARGET` para outro backend.
Isto evita pedidos cross-site entre `127.0.0.1` e `localhost`, sem alterar
`SameSite=Lax`, httpOnly nem as permissões impostas pela API.

`VITE_API_BASE_URL` continua a permitir uma origem explícita, incluindo em
produção. Nesse modo, configura CORS para a origem exata do frontend e usa
frontend/API no mesmo site para os cookies `SameSite=Lax`. Os cookies de
`localhost` não são partilhados com `127.0.0.1`: usa o mesmo hostname durante
todo o fluxo OAuth e configura `PUBLIC_FRONTEND_URL` e o redirect OAuth em
conformidade. Depois de mudar de hostname, inicia uma nova sessão.

A área de agências verifica a sessão antes de pedir dados protegidos.
Uma sessão ausente pede autenticação; indisponibilidade de rede ou respostas
inválidas são erros explícitos, não uma sessão anónima. Pedidos GET idênticos
em curso são partilhados, mas as respostas não ficam em cache.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
