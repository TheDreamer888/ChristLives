import { AdminOperations } from './operations/admin.ts'
import { AuthOperations } from './operations/auth.ts'
import { WaitlistOperations } from './operations/waitlist.ts'
import { HttpPipeline, type ClientOptions } from './pipeline.ts'

/**
 * Cliente da API da Lusorbe. Cria um por aplicação e reutiliza-o.
 *
 * ```ts
 * import { LusorbeClient } from '@lusorbe/sdk'
 *
 * const lusorbe = new LusorbeClient({ baseUrl: 'https://api.exemplo.pt' })
 * const me = await lusorbe.auth.session()
 * ```
 */
export class LusorbeClient {
  readonly auth: AuthOperations
  readonly waitlist: WaitlistOperations
  readonly admin: AdminOperations

  constructor(options: ClientOptions) {
    const http = new HttpPipeline(options)
    this.auth = new AuthOperations(http)
    this.waitlist = new WaitlistOperations(http)
    this.admin = new AdminOperations(http)
  }
}
