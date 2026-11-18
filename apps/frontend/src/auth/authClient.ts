/**
 * authClient — the app's auth "SDK". Everything a UI needs to sign in with
 * Google/Microsoft/GitHub/passkeys/backup-codes lives behind this small API.
 *
 * Session tokens are httpOnly cookies (never touched here). This client previously
 * caches a non-sensitive profile snapshot, encrypted at rest (see
 * secureStore.ts) but cached data must never establish an authenticated session.
 */
import { secureClear } from "./secureStore";
import { createPasskey, getPasskeyAssertion, isPasskeySupported } from "./webauthn";

const API_BASE = import.meta.env['VITE_API_BASE_URL'] ?? "http://localhost:8000";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include", // send/receive the httpOnly session cookie
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Falha no pedido (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export interface ProviderInfo {
  id: string;
  name: string;
}

export interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  linked_methods: string[];
  mfa_enrolled: boolean;
}

export const authClient = {
  passkeySupported: isPasskeySupported,

  async listProviders(): Promise<{ oauth: ProviderInfo[]; webauthn: boolean; backup_codes: boolean }> {
    return api("/api/auth/providers");
  },

  /** Redirects the browser to the provider's consent screen (Google/Microsoft/GitHub/...). */
  async loginWithProvider(providerId: string): Promise<void> {
    const { authorize_url } = await api<{ authorize_url: string; state: string }>(
      `/api/auth/oauth/${providerId}/start`,
    );
    window.location.assign(authorize_url);
  },

  async getSession(): Promise<SessionUser | null> {
    try {
      const user = await api<SessionUser | null>("/api/auth/session");
      return user;
    } catch {
      return null; // Only the server can confirm an authenticated session.
    }
  },

  async logout(): Promise<void> {
    await api("/api/auth/logout", { method: "POST" });
    await secureClear();
  },

  /** Registers a new passkey / hardware security key for the signed-in user. */
  async registerPasskey(deviceLabel?: string): Promise<void> {
    const { challenge_id, options } = await api<{ challenge_id: string; options: string }>(
      "/api/auth/webauthn/register/options",
      { method: "POST" },
    );
    const credential = await createPasskey(options);
    await api("/api/auth/webauthn/register/verify", {
      method: "POST",
      body: JSON.stringify({ credential, challenge_id, device_label: deviceLabel }),
    });
  },

  /** Signs in with an already-registered passkey / security key. */
  async loginWithPasskey(email: string): Promise<void> {
    const { challenge_id, options } = await api<{ challenge_id: string; options: string }>(
      "/api/auth/webauthn/login/options",
      { method: "POST", body: JSON.stringify({ email }) },
    );
    const credential = await getPasskeyAssertion(options);
    await api("/api/auth/webauthn/login/verify", {
      method: "POST",
      body: JSON.stringify({ credential, challenge_id }),
    });
  },

  /** Account recovery when every other method (phone/passkey) is lost. */
  async generateBackupCodes(): Promise<string[]> {
    const { codes } = await api<{ codes: string[] }>("/api/auth/recovery/backup-codes/generate", {
      method: "POST",
    });
    return codes;
  },

  async loginWithBackupCode(email: string, code: string): Promise<void> {
    await api("/api/auth/recovery/backup-codes/redeem", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
  },

  async recordConsent(termsAccepted: boolean, privacyAccepted: boolean, marketingOptIn = false): Promise<void> {
    await api("/api/auth/consent", {
      method: "POST",
      body: JSON.stringify({
        terms_accepted: termsAccepted,
        privacy_accepted: privacyAccepted,
        marketing_opt_in: marketingOptIn,
      }),
    });
  },
};
