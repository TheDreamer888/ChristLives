import { ConvexError } from 'convex/values'

const KEY_VERSION = 'v1' as const
const KEY_ENV = 'CONVEX_PREFERENCES_MASTER_KEY_V1'
const KEY_SALT = new TextEncoder().encode('aegis:convex:preferences:v1')
const encoder = new TextEncoder()

export type Product = 'veytrion' | 'sentryvora' | 'terravoryx' | 'petralume'
export type Locale = 'pt-PT' | 'en'
export type Preference = {
  owner: string
  product: Product
  locale: Locale
}

export type EncryptedPreference = {
  lookupKey: string
  keyVersion: typeof KEY_VERSION
  iv: string
  ciphertext: string
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

function decodeBase64(value: string, errorCode: string): Uint8Array {
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error('Invalid base64')
    }
    return Uint8Array.from(atob(value), character => character.charCodeAt(0))
  } catch {
    throw new ConvexError(errorCode)
  }
}

function masterKeyBytes(): Uint8Array {
  const configuredKey = process.env[KEY_ENV]
  if (!configuredKey) throw new ConvexError('PREFERENCES_ENCRYPTION_KEY_MISSING')

  const key = decodeBase64(configuredKey, 'PREFERENCES_ENCRYPTION_KEY_INVALID')
  if (key.length !== 32) throw new ConvexError('PREFERENCES_ENCRYPTION_KEY_INVALID')
  return key
}

async function deriveKey(
  purpose: 'encryption' | 'lookup',
): Promise<CryptoKey> {
  const masterKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(masterKeyBytes()),
    'HKDF',
    false,
    ['deriveKey'],
  )
  const info = encoder.encode(`aegis:convex:preferences:${purpose}:${KEY_VERSION}`)
  const parameters = {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: toArrayBuffer(KEY_SALT),
    info: toArrayBuffer(info),
  } as const

  if (purpose === 'encryption') {
    return crypto.subtle.deriveKey(
      parameters,
      masterKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  }

  return crypto.subtle.deriveKey(
    parameters,
    masterKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
}

async function getLookupKey(owner: string, product: Product): Promise<string> {
  const key = await deriveKey('lookup')
  const tag = await crypto.subtle.sign(
    'HMAC',
    key,
    toArrayBuffer(encoder.encode(`${owner}\u0000${product}`)),
  )
  return encodeBase64(new Uint8Array(tag))
}

export async function encryptPreference(
  preference: Preference,
): Promise<EncryptedPreference> {
  const keyVersion = KEY_VERSION
  const lookupKey = await getLookupKey(preference.owner, preference.product)
  const iv = Uint8Array.from({ length: 12 }, () => Math.floor(Math.random() * 256))
  const additionalData = encoder.encode(`${keyVersion}:${lookupKey}`)
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(additionalData),
      tagLength: 128,
    },
    await deriveKey('encryption'),
    toArrayBuffer(encoder.encode(JSON.stringify(preference))),
  )

  return {
    lookupKey,
    keyVersion,
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  }
}

export async function decryptPreference(
  record: EncryptedPreference,
): Promise<Preference> {
  if (record.keyVersion !== KEY_VERSION) {
    throw new ConvexError('PREFERENCES_ENCRYPTION_KEY_VERSION_UNSUPPORTED')
  }

  const iv = decodeBase64(record.iv, 'PREFERENCES_CIPHERTEXT_INVALID')
  if (iv.length !== 12) throw new ConvexError('PREFERENCES_CIPHERTEXT_INVALID')
  const ciphertext = decodeBase64(record.ciphertext, 'PREFERENCES_CIPHERTEXT_INVALID')
  const key = await deriveKey('encryption')

  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(
          encoder.encode(`${record.keyVersion}:${record.lookupKey}`),
        ),
        tagLength: 128,
      },
      key,
      toArrayBuffer(ciphertext),
    )
  } catch {
    throw new ConvexError('PREFERENCES_DECRYPTION_FAILED')
  }

  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    throw new ConvexError('PREFERENCES_CIPHERTEXT_INVALID')
  }

  if (typeof value !== 'object' || value === null || !('owner' in value) || !('product' in value) || !('locale' in value)) {
    throw new ConvexError('PREFERENCES_CIPHERTEXT_INVALID')
  }

  const owner = value.owner
  const preferenceProduct = value.product
  const preferenceLocale = value.locale
  if (
    typeof owner !== 'string' ||
    (preferenceProduct !== 'veytrion' &&
      preferenceProduct !== 'sentryvora' &&
      preferenceProduct !== 'terravoryx' &&
      preferenceProduct !== 'petralume') ||
    (preferenceLocale !== 'pt-PT' && preferenceLocale !== 'en')
  ) {
    throw new ConvexError('PREFERENCES_CIPHERTEXT_INVALID')
  }

  return { owner, product: preferenceProduct, locale: preferenceLocale }
}

export { getLookupKey }
