import type {
  BackupCodes,
  ConsentRequest,
  OAuthStart,
  PasskeyOptions,
  Providers,
  RedeemResult,
  SessionUser,
} from '../models.ts'
import type { HttpPipeline, OperationOptions } from '../pipeline.ts'

const enc = encodeURIComponent

/** Autenticação: sessão, login social, passkeys e códigos de recuperação. */
export class AuthOperations {
  private readonly http: HttpPipeline

  constructor(http: HttpPipeline) {
    this.http = http
  }

  /** Métodos de login ativos no servidor. */
  providers(options?: OperationOptions): Promise<Providers> {
    return this.http.send({ method: 'GET', path: '/api/auth/providers', options })
  }

  /** Utilizador da sessão atual, ou `null` sem sessão. */
  session(options?: OperationOptions): Promise<SessionUser | null> {
    return this.http.send({ method: 'GET', path: '/api/auth/session', options })
  }

  /** Inicia o login social. Redireciona o navegador para `authorize_url`. */
  oauthStart(provider: string, options?: OperationOptions): Promise<OAuthStart> {
    return this.http.send({ method: 'GET', path: `/api/auth/oauth/${enc(provider)}/start`, options })
  }

  logout(options?: OperationOptions): Promise<{ ok: true }> {
    return this.http.send({ method: 'POST', path: '/api/auth/logout', options })
  }

  /** Passkeys (WebAuthn). O SDK trata do HTTP; a cerimónia corre no navegador. */
  readonly passkeys = {
    /** Passo 1 do registo. Exige sessão recente (step-up). */
    registerOptions: async (options?: OperationOptions): Promise<PasskeyOptions> =>
      parseOptions(await this.http.send({ method: 'POST', path: '/api/auth/webauthn/register/options', options })),

    /** Passo 2 do registo, com a credencial devolvida por `navigator.credentials.create`. */
    registerVerify: (
      body: { challengeId: string; credential: Record<string, unknown>; deviceLabel?: string | undefined },
      options?: OperationOptions,
    ): Promise<{ ok: true }> =>
      this.http.send({
        method: 'POST',
        path: '/api/auth/webauthn/register/verify',
        body: { challenge_id: body.challengeId, credential: body.credential, device_label: body.deviceLabel },
        options,
      }),

    /** Passo 1 do login. Responde sempre igual, exista ou não a conta (anti-enumeração). */
    loginOptions: async (email: string, options?: OperationOptions): Promise<PasskeyOptions> =>
      parseOptions(await this.http.send({ method: 'POST', path: '/api/auth/webauthn/login/options', body: { email }, options })),

    /** Passo 2 do login. Cria a sessão (cookie). */
    loginVerify: (
      body: { challengeId: string; credential: Record<string, unknown> },
      options?: OperationOptions,
    ): Promise<{ ok: true }> =>
      this.http.send({
        method: 'POST',
        path: '/api/auth/webauthn/login/verify',
        body: { challenge_id: body.challengeId, credential: body.credential },
        options,
      }),
  }

  /** Códigos de recuperação de uso único. */
  readonly recovery = {
    /** Gera 10 códigos novos (os anteriores deixam de valer). Mostra-os uma vez; o servidor só guarda hashes. */
    generate: (options?: OperationOptions): Promise<BackupCodes> =>
      this.http.send({ method: 'POST', path: '/api/auth/recovery/backup-codes/generate', options }),

    /** Entra com um código. Cria a sessão (cookie). */
    redeem: (body: { email: string; code: string }, options?: OperationOptions): Promise<RedeemResult> =>
      this.http.send({ method: 'POST', path: '/api/auth/recovery/backup-codes/redeem', body, options }),
  }

  /** Regista a aceitação dos Termos e da Política de Privacidade. */
  recordConsent(body: ConsentRequest, options?: OperationOptions): Promise<{ ok: true }> {
    return this.http.send({ method: 'POST', path: '/api/auth/consent', body, options })
  }
}

function parseOptions(raw: { challenge_id: string; options: string }): PasskeyOptions {
  return { challengeId: raw.challenge_id, options: JSON.parse(raw.options) as Record<string, unknown> }
}
