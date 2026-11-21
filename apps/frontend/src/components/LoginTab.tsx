import { useEffect, useState } from "react";
import { authClient, type ProviderInfo, type SessionUser } from "../auth/authClient";
import { runUnauthenticatedGuard } from "../lib/loginTabGuard";
import "./LoginTab.css";
import { useI18n } from "../i18n/context";

const PROVIDER_ICONS: Record<string, string> = {
  google: "🟢",
  microsoft: "🟦",
  github: "🐙",
  gitlab: "🦊",
  apple: "🍎",
  discord: "🎮",
};

type Mode = "providers" | "passkey" | "recovery";

/** Adaptable, secure login tab: OAuth (Google/Microsoft/GitHub/...), passkeys
 *  / hardware security keys, and account-recovery when a factor is lost. */
export default function LoginTab() {
  const { m } = useI18n();
  const l = m.login;
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [passkeyOk, setPasskeyOk] = useState(false);
  const [mode, setMode] = useState<Mode>("providers");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [session, setSession] = useState<SessionUser | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [apiDown, setApiDown] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authClient.listProviders().then((res) => {
      setProviders(res.oauth);
      setPasskeyOk(res.webauthn && authClient.passkeySupported());
    }).catch(() => setApiDown(true));
    authClient.getSession().then(setSession);
  }, []);

  const legalOk = termsAccepted && privacyAccepted;

  const withGuard = async (action: () => Promise<void>) => {
    if (!session && !legalOk) {
      setStatus(l.acceptFirst);
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await runUnauthenticatedGuard(
        Boolean(session),
        termsAccepted,
        privacyAccepted,
        (terms, privacy) => authClient.recordConsent(terms, privacy),
        action,
      );
      setSession(await authClient.getSession());
    } catch (err) {
      setStatus(err instanceof Error ? err.message : l.error);
    } finally {
      setBusy(false);
    }
  };

  if (session) {
    return (
      <div className="login-tab">
        <h2>{l.signedIn}</h2>
        <p>
          {l.welcome(session.name)} {l.methods}{" "}
          {session.linked_methods.join(", ") || l.none}.
        </p>
        {!session.mfa_enrolled && (
          <p className="login-tab__hint">
            {l.recommend}
          </p>
        )}
        <div className="login-tab__actions">
          <button disabled={busy} onClick={() => withGuard(() => authClient.registerPasskey())}>
            {l.addPasskey}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              withGuard(async () => {
                const codes = await authClient.generateBackupCodes();
                setStatus(l.keepCodes(codes.join(", ")));
              })
            }
          >
            {l.genCodes}
          </button>
          <button disabled={busy} onClick={() => withGuard(() => authClient.logout())}>
            {l.signOut}
          </button>
        </div>
        {(status ?? (apiDown ? l.apiDown : null)) && <p className="login-tab__status">{status ?? l.apiDown}</p>}
      </div>
    );
  }

  return (
    <div className="login-tab">
      <h2>{l.signIn}</h2>

      <div className="login-tab__tabs">
        <button className={mode === "providers" ? "active" : ""} onClick={() => setMode("providers")}>
          {l.accounts}
        </button>
        {passkeyOk && (
          <button className={mode === "passkey" ? "active" : ""} onClick={() => setMode("passkey")}>
            {l.securityKey}
          </button>
        )}
        <button className={mode === "recovery" ? "active" : ""} onClick={() => setMode("recovery")}>
          {l.lostAccess}
        </button>
      </div>

      {mode === "providers" && (
        <div className="login-tab__providers">
          {providers.length === 0 && <p>{l.noProviders}</p>}
          {providers.map((p) => (
            <button
              key={p.id}
              className="login-tab__provider-btn"
              disabled={busy}
              onClick={() => withGuard(() => authClient.loginWithProvider(p.id))}
            >
              <span aria-hidden>{PROVIDER_ICONS[p.id] ?? "🔑"}</span> {l.continueWith(p.name)}
            </button>
          ))}
        </div>
      )}

      {mode === "passkey" && (
        <div className="login-tab__passkey">
          <input
            type="email"
            placeholder={l.email}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button disabled={busy || !email} onClick={() => withGuard(() => authClient.loginWithPasskey(email))}>
            {l.passkeyLogin}
          </button>
        </div>
      )}

      {mode === "recovery" && (
        <div className="login-tab__recovery">
          <p>{l.lostText}</p>
          <input
            type="email"
            placeholder={l.email}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            placeholder={l.codePlaceholder}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            disabled={busy || !email || !code}
            onClick={() => withGuard(() => authClient.loginWithBackupCode(email, code))}
          >
            {l.recover}
          </button>
        </div>
      )}

      <fieldset className="login-tab__legal">
        <label>
          <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} />
          {l.acceptTerms[0]}<a href="/legal/terms.html" target="_blank" rel="noreferrer">{l.acceptTerms[1]}</a>
        </label>
        <label>
          <input type="checkbox" checked={privacyAccepted} onChange={(e) => setPrivacyAccepted(e.target.checked)} />
          {l.acceptPrivacy[0]}<a href="/legal/privacy.html" target="_blank" rel="noreferrer">{l.acceptPrivacy[1]}</a>{l.acceptPrivacy[2]}
        </label>
      </fieldset>

      {(status ?? (apiDown ? l.apiDown : null)) && <p className="login-tab__status">{status ?? l.apiDown}</p>}
      <p className="admin-entry">
        <a href="#admin">{l.adminLink}</a>{l.adminOnly}
      </p>
    </div>
  );
}
