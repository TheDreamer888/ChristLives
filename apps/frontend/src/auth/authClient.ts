/**
 * Autenticação da app, por cima do SDK oficial (@lusorbe/sdk).
 *
 * A sessão é um cookie httpOnly (nunca tocado aqui). Os dados em cache local
 * (secureStore.ts) nunca servem para considerar alguém autenticado: só o servidor
 * confirma a sessão.
 */
import { LusorbeError } from '@lusorbe/sdk'
import type { ProviderInfo, Providers, SessionUser } from '@lusorbe/sdk'

import { lusorbe } from '../lusorbe'
import { secureClear } from './secureStore'
import { createPasskey, getPasskeyAssertion, isPasskeySupported } from './webauthn'

export type { ProviderInfo, SessionUser }

export const authClient = {
  passkeySupported: isPasskeySupported,

  listProviders(): Promise<Providers> {
    return lusorbe.auth.providers()
  },

  /** Redireciona o browser para o ecrã de consentimento do provedor. */
  async loginWithProvider(providerId: string): Promise<void> {
    const { authorize_url } = await lusorbe.auth.oauthStart(providerId)
    window.location.assign(authorize_url)
  },

  async getSession(): Promise<SessionUser | null> {
    try {
      return await lusorbe.auth.session()
    } catch (err) {
      if (err instanceof LusorbeError) return null // só o servidor confirma a sessão
      throw err
    }
  },

  async logout(): Promise<void> {
    await lusorbe.auth.logout()
    await secureClear()
  },

  /** Regista uma passkey ou chave de segurança para o utilizador com sessão. */
  async registerPasskey(deviceLabel?: string): Promise<void> {
    const { challengeId, options } = await lusorbe.auth.passkeys.registerOptions()
    const credential = await createPasskey(options)
    await lusorbe.auth.passkeys.registerVerify({ challengeId, credential, deviceLabel })
  },

  /** Entra com uma passkey já registada. */
  async loginWithPasskey(email: string): Promise<void> {
    const { challengeId, options } = await lusorbe.auth.passkeys.loginOptions(email)
    const credential = await getPasskeyAssertion(options)
    await lusorbe.auth.passkeys.loginVerify({ challengeId, credential })
  },

  /** Recuperação quando todos os outros métodos se perderam. */
  async generateBackupCodes(): Promise<string[]> {
    return (await lusorbe.auth.recovery.generate()).codes
  },

  async loginWithBackupCode(email: string, code: string): Promise<void> {
    await lusorbe.auth.recovery.redeem({ email, code })
  },

  async recordConsent(termsAccepted: boolean, privacyAccepted: boolean, marketingOptIn = false): Promise<void> {
    await lusorbe.auth.recordConsent({
      terms_accepted: termsAccepted,
      privacy_accepted: privacyAccepted,
      marketing_opt_in: marketingOptIn,
    })
  },
}
