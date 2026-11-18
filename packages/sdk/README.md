# @lusorbe/sdk

SDK oficial da API da Lusorbe para TypeScript e JavaScript. Funciona no browser e em Node 20+,
não tem dependências e pesa ~22 KB antes de comprimir.

- **Tipado a partir do contrato.** Os tipos vêm do OpenAPI da API (`openapi.json`); o CI falha se divergirem.
- **Seguro por omissão.** Só `https` (exceto `localhost`), sem seguir redirecionamentos, sem cache, e nunca regista corpos, cookies ou emails.
- **Resiliente.** Novas tentativas com espera exponencial, respeito por `Retry-After`, tempo limite e cancelamento.
- **Erros que se tratam.** Uma classe por situação (`RateLimitError`, `PermissionDeniedError`…), todas filhas de `LusorbeError`.

## Índice

1. [Início rápido](#início-rápido)
2. [Configuração](#configuração)
3. [Autenticação](#autenticação)
4. [Operações](#operações)
5. [Erros](#erros)
6. [Novas tentativas](#novas-tentativas)
7. [Tempo limite e cancelamento](#tempo-limite-e-cancelamento)
8. [Paginação](#paginação)
9. [Diagnóstico](#diagnóstico)
10. [Contrato e geração de tipos](#contrato-e-geração-de-tipos)
11. [Versões](#versões)

## Início rápido

```ts
import { LusorbeClient, RateLimitError } from '@lusorbe/sdk'

const lusorbe = new LusorbeClient({ baseUrl: 'https://api.exemplo.pt' })

// Lista de espera (pública)
try {
  await lusorbe.waitlist.join({ email: 'ana@escola.pt', interest: 'escolas', consent: true })
} catch (err) {
  if (err instanceof RateLimitError) console.log(`Tenta daqui a ${err.retryAfterSeconds ?? 60} s`)
  else throw err
}

// Sessão atual
const user = await lusorbe.auth.session() // null se não houver sessão
```

Cria **um** cliente por aplicação e reutiliza-o.

## Configuração

```ts
new LusorbeClient({
  baseUrl: 'https://api.exemplo.pt', // obrigatório; https fora de localhost
  timeoutMs: 30_000,                 // por tentativa
  retry: { maxRetries: 3, retryDelayMs: 800, maxRetryDelayMs: 30_000 },
  credentials: 'include',            // 'omit' para páginas públicas sem sessão
  applicationId: 'painel-escolas/2.1', // aparece no User-Agent (só Node)
  logger: console,                   // opcional
  onRequest: (info) => {},           // método, caminho, tentativa
  onResponse: (info) => {},          // + estado e duração
  fetch: customFetch,                // opcional (testes, proxies)
})
```

| Opção | Por omissão | Notas |
|---|---|---|
| `baseUrl` | — | Só a origem. Caminhos extra são ignorados. |
| `timeoutMs` | `30000` | Por tentativa. Pode ser substituído em cada chamada. |
| `retry.maxRetries` | `3` | `0` desliga. |
| `retry.retryDelayMs` | `800` | Base da espera exponencial (800, 1600, 3200 ms ± 20 %). |
| `retry.maxRetryDelayMs` | `30000` | Se a API pedir mais (`Retry-After`), o SDK não espera e lança o erro. |
| `credentials` | `include` | A sessão é um cookie httpOnly; o SDK nunca toca em tokens. |

## Autenticação

A Lusorbe usa um **cookie de sessão httpOnly**, cifrado e inacessível a JavaScript. O SDK não guarda
nem envia tokens: basta `credentials: 'include'` (por omissão) e o browser faz o resto.

- **Login social:** `auth.oauthStart('google')` devolve `authorize_url`; redireciona o browser para lá.
- **Passkeys:** o SDK trata do HTTP; a cerimónia WebAuthn corre no browser.

  ```ts
  const { challengeId, options } = await lusorbe.auth.passkeys.loginOptions(email)
  const credential = await navigator.credentials.get({ publicKey: decode(options) })
  await lusorbe.auth.passkeys.loginVerify({ challengeId, credential: credential.toJSON() })
  ```

- **Administração:** exige sessão iniciada **com passkey**. Alterações exigem login recente (step-up);
  se tiver passado o prazo, recebes `PermissionDeniedError` e deves pedir novo login.

## Operações

| Área | Método | Descrição |
|---|---|---|
| `auth` | `providers()` | Métodos de login ativos. |
| | `session()` | Utilizador da sessão ou `null`. |
| | `oauthStart(provider)` | Início do login social. |
| | `logout()` | Termina a sessão. |
| | `passkeys.registerOptions()` / `registerVerify()` | Registar uma passkey. |
| | `passkeys.loginOptions(email)` / `loginVerify()` | Entrar com passkey. |
| | `recovery.generate()` / `redeem()` | Códigos de recuperação. |
| | `recordConsent(body)` | Aceitação de Termos e Privacidade. |
| `waitlist` | `consent()` | Texto e versão do consentimento. |
| | `join(body)` | Inscrição (resposta igual para novos e repetidos). |
| `admin` | `me()` · `overview()` · `roles()` · `securityPosture()` | Leituras gerais. |
| | `users.list()` · `users.get(id)` | Paginado; emails mascarados sem `users.read_pii`. |
| | `users.suspend` · `reactivate` · `revokeSessions` · `setRoles` | Exigem `{ reason }` (≥ 10 caracteres). |
| | `approvals.list()` · `approvals.decide(id, …)` | Regra das duas pessoas. |
| | `audit.list()` · `audit.verify()` · `audit.export()` | `export` devolve um `Blob` CSV. |
| | `waitlist.overview()` · `waitlist.export()` · `waitlist.delete()` | Gestão da lista de espera. |

Os campos das respostas seguem a API (`snake_case`), sem tradução, para nunca divergirem do contrato.
Cada método aceita, no fim, `{ abortSignal, timeoutMs }`.

## Erros

```
LusorbeError
├── ApiError                 (a API respondeu com erro: status, operation, body, requestId)
│   ├── AuthenticationError  401 — sem sessão ou sessão expirada
│   ├── PermissionDeniedError 403 — sem permissão, origem não permitida ou step-up
│   ├── NotFoundError        404
│   ├── ConflictError        409 — estado mudou entretanto (ex.: pedido já decidido)
│   ├── ValidationError      422 — .fields com cada campo inválido
│   ├── RateLimitError       429 — .retryAfterSeconds
│   └── ServerError          5xx
├── ConnectionError          sem resposta (rede, DNS, CORS)
├── TimeoutError             excedeu timeoutMs
└── AbortError               cancelado pelo chamador
```

```ts
import { ValidationError } from '@lusorbe/sdk'

try {
  await lusorbe.admin.users.suspend(id, { reason })
} catch (err) {
  if (err instanceof ValidationError) {
    for (const f of err.fields) showFieldError(f.location.at(-1), f.message)
  } else throw err
}
```

As mensagens de erro vêm da API em português e podem ser mostradas ao utilizador.
`operation` traz só o método e o caminho, nunca o corpo do pedido.

## Novas tentativas

O SDK só repete o que é **seguro repetir**:

| Situação | GET / PUT / DELETE | POST |
|---|---|---|
| Falha de rede, tempo limite | repete | **não repete** (pode já ter sido aplicado) |
| 408, 500, 502, 503, 504 | repete | **não repete** |
| 429 | repete | repete (a API rejeita antes de processar) |
| Outros 4xx | não repete | não repete |

A espera é exponencial com variação aleatória de ± 20 %. Se a API enviar `Retry-After`, o SDK usa esse
valor; se for maior que `maxRetryDelayMs`, não espera e lança `RateLimitError` com o tempo pedido.

## Tempo limite e cancelamento

```ts
const ctrl = new AbortController()
const pending = lusorbe.admin.overview({ abortSignal: ctrl.signal, timeoutMs: 5_000 })
ctrl.abort() // → AbortError, sem novas tentativas
```

Em React, cancela no fim do efeito:

```ts
useEffect(() => {
  const ctrl = new AbortController()
  lusorbe.admin.me({ abortSignal: ctrl.signal }).then(setMe).catch(ignoreAbort)
  return () => ctrl.abort()
}, [])
```

## Paginação

```ts
// item a item: o SDK pede as páginas quando precisa
for await (const user of lusorbe.admin.users.list({ status: 'suspended' })) {
  console.log(user.id)
}

// página a página (ex.: tabelas)
for await (const page of lusorbe.admin.users.list().byPage({ maxPageSize: 50 })) {
  render(page.items, page.total)
}

// continuar mais tarde a partir de uma página
const next = lusorbe.admin.users.list().byPage({ continuationToken: savedToken })
```

## Diagnóstico

```ts
const lusorbe = new LusorbeClient({
  baseUrl,
  logger: console, // "GET /api/admin/me → 200 em 34 ms"
  onResponse: ({ method, url, status, durationMs, attempt }) => metrics.record(...),
})
```

O registo nunca inclui corpos, cookies, emails nem parâmetros de pesquisa.
Em Node, o `User-Agent` identifica o SDK (`lusorbe-sdk-js/0.1.0 (node/24.x)`), prefixado pelo
`applicationId`. No browser não se envia nenhum cabeçalho próprio, para evitar um pedido CORS
extra (preflight) por chamada.

## Contrato e geração de tipos

```
API (FastAPI + modelos Pydantic)
   └─ services/api-python/scripts/export_openapi.py → packages/sdk/openapi.json
         └─ pnpm --filter @lusorbe/sdk generate → src/generated/schema.ts
```

- Cada resposta da API tem um modelo Pydantic; o FastAPI valida e filtra o que sai.
- O CI falha se `openapi.json` não corresponder à API (`export_openapi.py --check`)
  ou se os tipos gerados estiverem desatualizados (`pnpm check:generated`).
- Depois de mudar a API: `python scripts/export_openapi.py` e `pnpm --filter @lusorbe/sdk generate`.

## Versões

O SDK segue [Semantic Versioning](https://semver.org/lang/pt-BR/). Mudanças estão no [CHANGELOG](./CHANGELOG.md).
Antes da 1.0.0, versões menores (0.x) podem trazer mudanças incompatíveis, sempre assinaladas.

## Princípios de desenho

Baseado nas [Azure SDK Design Guidelines](https://azure.github.io/azure-sdk/typescript_introduction.html)
(cliente único com sub-áreas, opções num objeto, `abortSignal`, paginação com `byPage`, política de
novas tentativas) e no desenho dos SDKs da Stripe (erros tipados por situação, campos iguais aos da API).
