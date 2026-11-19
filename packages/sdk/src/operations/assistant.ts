import type { AssistantReply, AssistantStatus, ChatMessage } from '../models.ts'
import type { HttpPipeline, OperationOptions } from '../pipeline.ts'

export interface SendAssistantMessage {
  /** Conversa completa, a começar e acabar numa mensagem do utilizador (máx. 20). */
  messages: ChatMessage[]
  /** Tem de ser `true`: a pessoa aceitou que o texto é enviado à Anthropic. */
  consent: true
}

/**
 * Assistente opcional (exige sessão). A conversa vive no cliente: o servidor não a guarda.
 *
 * Erros comuns: `AuthenticationError` (sem sessão), `RateLimitError` (limite diário
 * ou por minuto; vê `retryAfter`), `ApiError` com estado 503 (assistente desligado).
 */
export class AssistantOperations {
  private readonly http: HttpPipeline

  constructor(http: HttpPipeline) {
    this.http = http
  }

  /** Se o assistente está ligado, o limite diário e o aviso de dados a mostrar. */
  status(options?: OperationOptions): Promise<AssistantStatus> {
    return this.http.send({ method: 'GET', path: '/api/assistant/status', options })
  }

  /**
   * Envia a conversa e devolve a resposta. Nunca é repetido automaticamente
   * depois de chegar ao servidor (é um POST que gasta quota).
   */
  send(body: SendAssistantMessage, options?: OperationOptions): Promise<AssistantReply> {
    return this.http.send({
      method: 'POST',
      path: '/api/assistant/messages',
      body: { messages: body.messages, consent: body.consent },
      options,
    })
  }
}
