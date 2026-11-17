/**
 * Modelos públicos, tirados do contrato OpenAPI gerado (src/generated/schema.ts).
 * Os nomes de campos seguem a API (snake_case), para não haver tradução que possa divergir.
 */
import type { components } from './generated/schema.ts'

type S = components['schemas']

// Autenticação
export type SessionUser = S['SessionUser']
export type ProviderInfo = S['ProviderInfo']
export type Providers = S['ProvidersResponse']
export type OAuthStart = S['OAuthStartResponse']
export type BackupCodes = S['BackupCodesResponse']
export type RedeemResult = S['RedeemResult']
export type ConsentRequest = S['ConsentRequest']

// Lista de espera
export type WaitlistJoin = S['JoinBody']
export type WaitlistJoinResult = S['JoinResult']
export type WaitlistConsent = S['ConsentInfo']
export type Interest = NonNullable<WaitlistJoin['interest']>

// Administração
export type AdminMe = S['Me']
export type AdminUser = S['AdminUser']
export type UserDetail = S['UserDetail']
export type AuditEntry = S['AuditEntry']
export type ChainStatus = S['ChainStatus']
export type Overview = S['Overview']
export type RoleInfo = S['RoleInfo']
export type Roles = S['RolesResponse']
export type Posture = S['Posture']
export type Approval = S['Approval']
export type UserResult = S['UserResult']
export type RolesResult = S['RolesResult']
export type DecisionResult = S['DecisionResult']
export type WaitlistOverview = S['WaitlistOverview']
export type WaitlistItem = S['WaitlistItem']

/** Opções da passkey prontas para `navigator.credentials.create/get` (depois de converter base64url). */
export interface PasskeyOptions {
  challengeId: string
  /** `PublicKeyCredentialCreationOptionsJSON` ou `PublicKeyCredentialRequestOptionsJSON`. */
  options: Record<string, unknown>
}
