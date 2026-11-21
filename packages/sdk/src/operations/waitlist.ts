import type { Interest, WaitlistConsent, WaitlistJoinResult } from '../models.ts'
import type { HttpPipeline, OperationOptions } from '../pipeline.ts'

export interface JoinWaitlist {
  email: string
  interest?: Interest | undefined
  /** Tem de ser `true`: a pessoa marcou a caixa de consentimento. */
  consent: true
  /** Campo-isco anti-bot. Passa o valor do campo escondido do formulário (deve ficar vazio). */
  honeypot?: string | undefined
}

/** Lista de espera pública. */
export class WaitlistOperations {
  private readonly http: HttpPipeline

  constructor(http: HttpPipeline) {
    this.http = http
  }

  /** Texto e versão do consentimento a mostrar junto do formulário. */
  consent(options?: OperationOptions): Promise<WaitlistConsent> {
    return this.http.send({ method: 'GET', path: '/api/waitlist/consent', options })
  }

  /**
   * Inscreve um email. A resposta é igual para emails novos e repetidos,
   * para não revelar quem já está inscrito.
   */
  join(body: JoinWaitlist, options?: OperationOptions): Promise<WaitlistJoinResult> {
    return this.http.send({
      method: 'POST',
      path: '/api/waitlist',
      body: { email: body.email, interest: body.interest ?? 'outro', consent: body.consent, website: body.honeypot ?? '' },
      options,
    })
  }
}
