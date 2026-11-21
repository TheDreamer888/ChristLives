/**
 * Cerimónias WebAuthn no browser (passkeys e chaves USB).
 *
 * O servidor (py_webauthn) devolve as opções no formato JSON do WebAuthn Level 3,
 * ao nível de topo: { challenge, rp, user, ... } — SEM o invólucro `publicKey`.
 * Usa a conversão nativa do browser quando existe e uma manual nos restantes.
 */

type Json = Record<string, unknown>

function b64urlToBuffer(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(b64url.length + ((4 - (b64url.length % 4)) % 4), '=')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function bufferToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Aceita as opções com ou sem invólucro `publicKey`. */
function unwrap(options: Json): Json {
  const inner = options['publicKey']
  return inner && typeof inner === 'object' ? (inner as Json) : options
}

/** Converte a lista de credenciais (ids em base64url) e omite a chave se não existir. */
function withList(key: 'excludeCredentials' | 'allowCredentials', o: Json): Record<string, PublicKeyCredentialDescriptor[]> {
  const list = o[key]
  if (!Array.isArray(list)) return {}
  return { [key]: list.map((c: Json) => ({ ...c, id: b64urlToBuffer(String(c['id'])) }) as unknown as PublicKeyCredentialDescriptor) }
}

type NativeParsers = {
  parseCreationOptionsFromJSON?: (o: Json) => PublicKeyCredentialCreationOptions
  parseRequestOptionsFromJSON?: (o: Json) => PublicKeyCredentialRequestOptions
}
const native = () => (typeof window !== 'undefined' ? (window.PublicKeyCredential as unknown as NativeParsers | undefined) : undefined)

export function toCreationOptions(raw: Json): PublicKeyCredentialCreationOptions {
  const o = unwrap(raw)
  const parse = native()?.parseCreationOptionsFromJSON
  if (parse) return parse(o)
  const user = o['user'] as Json
  return {
    ...(o as unknown as PublicKeyCredentialCreationOptions),
    challenge: b64urlToBuffer(String(o['challenge'])),
    user: { ...(user as unknown as PublicKeyCredentialUserEntity), id: b64urlToBuffer(String(user['id'])) },
    ...withList('excludeCredentials', o),
  } as PublicKeyCredentialCreationOptions
}

export function toRequestOptions(raw: Json): PublicKeyCredentialRequestOptions {
  const o = unwrap(raw)
  const parse = native()?.parseRequestOptionsFromJSON
  if (parse) return parse(o)
  return {
    ...(o as unknown as PublicKeyCredentialRequestOptions),
    challenge: b64urlToBuffer(String(o['challenge'])),
    ...withList('allowCredentials', o),
  } as PublicKeyCredentialRequestOptions
}

export function isPasskeySupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential
}

export async function createPasskey(options: Json): Promise<Json> {
  const credential = (await navigator.credentials.create({ publicKey: toCreationOptions(options) })) as PublicKeyCredential
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      attestationObject: bufferToB64url(response.attestationObject),
    },
  }
}

export async function getPasskeyAssertion(options: Json): Promise<Json> {
  const credential = (await navigator.credentials.get({ publicKey: toRequestOptions(options) })) as PublicKeyCredential
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      authenticatorData: bufferToB64url(response.authenticatorData),
      signature: bufferToB64url(response.signature),
      userHandle: response.userHandle ? bufferToB64url(response.userHandle) : null,
    },
  }
}
