# Frontend Aegis

Interface React + TypeScript + Vite para a gestão de agências e clientes.

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
- O Assistente separa pesquisa de mercado, pesquisa de lojas por cidade/código
  postal em Portugal, estudo bíblico com IA e suporte documental Aegis. Pesquisas
  de mercado e lojas abrem resultados externos; preços, stock e horários não são
  recolhidos nem validados pela aplicação. O estudo bíblico usa
  `POST /api/assistant/bible-chat`; é grátis para visitantes, mas o fornecedor
  de IA configurado pode cobrar ao operador. A pergunta e até 10 mensagens
  anteriores são encaminhadas ao fornecedor, mas não ficam guardadas pelo Aegis.
- Não são guardadas credenciais de integração no browser. A app não é um antivírus
  e não foi publicada na Play Store por esta alteração.

### Referências e limites

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
`http://localhost:8000`; define `VITE_API_PROXY_TARGET` para outro backend.
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
