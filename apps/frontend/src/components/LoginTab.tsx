import { useEffect, useState } from "react";
import { authClient, type ProviderInfo, type SessionUser } from "../auth/authClient";
import { runUnauthenticatedGuard } from "../lib/loginTabGuard";
import "./LoginTab.css";
import { links } from '../lib/links'

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
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [passkeyOk, setPasskeyOk] = useState(false);
  const [mode, setMode] = useState<Mode>("providers");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [session, setSession] = useState<SessionUser | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authClient.listProviders().then((res) => {
      setProviders(res.oauth);
      setPasskeyOk(res.webauthn && authClient.passkeySupported());
    }).catch(() => setStatus("API de autenticação indisponível. Tenta novamente quando o serviço estiver configurado."));
    authClient.getSession().then(setSession);
  }, []);

  const legalOk = termsAccepted && privacyAccepted;

  const withGuard = async (action: () => Promise<void>) => {
    if (!session && !legalOk) {
      setStatus("Aceita os Termos e a Política de Privacidade para continuar.");
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
      setStatus(err instanceof Error ? err.message : "Ocorreu um erro.");
    } finally {
      setBusy(false);
    }
  };

  if (session) {
    return (
      <div className="login-tab">
        <h2>Sessão iniciada</h2>
        <p>
          Bem-vindo{session.name ? `, ${session.name}` : ""}. Métodos ligados:{" "}
          {session.linked_methods.join(", ") || "nenhum"}.
        </p>
        {!session.mfa_enrolled && (
          <p className="login-tab__hint">
            Recomendado: adiciona uma chave de segurança e gera códigos de recuperação, para nunca perderes o
            acesso.
          </p>
        )}
        <div className="login-tab__actions">
          <button disabled={busy} onClick={() => withGuard(() => authClient.registerPasskey())}>
            Adicionar chave de segurança / passkey
          </button>
          <button
            disabled={busy}
            onClick={() =>
              withGuard(async () => {
                const codes = await authClient.generateBackupCodes();
                setStatus(`Guarda estes códigos: ${codes.join(", ")}`);
              })
            }
          >
            Gerar códigos de recuperação
          </button>
          <button disabled={busy} onClick={() => withGuard(() => authClient.logout())}>
            Terminar sessão
          </button>
        </div>
        {status && <p className="login-tab__status">{status}</p>}
      </div>
    );
  }

  return (
    <div className="login-tab">
      <h2>Iniciar sessão</h2>

      <div className="login-tab__tabs">
        <button className={mode === "providers" ? "active" : ""} onClick={() => setMode("providers")}>
          Contas
        </button>
        {passkeyOk && (
          <button className={mode === "passkey" ? "active" : ""} onClick={() => setMode("passkey")}>
            Chave de segurança
          </button>
        )}
        <button className={mode === "recovery" ? "active" : ""} onClick={() => setMode("recovery")}>
          Perdi o acesso
        </button>
      </div>

      {mode === "providers" && (
        <div className="login-tab__providers">
          {providers.length === 0 && <p>Nenhum provedor configurado ainda.</p>}
          {providers.map((p) => (
            <button
              key={p.id}
              className="login-tab__provider-btn"
              disabled={busy}
              onClick={() => withGuard(() => authClient.loginWithProvider(p.id))}
            >
              <span aria-hidden>{PROVIDER_ICONS[p.id] ?? "🔑"}</span> Continuar com {p.name}
            </button>
          ))}
        </div>
      )}

      {mode === "passkey" && (
        <div className="login-tab__passkey">
          <input
            type="email"
            placeholder="O teu email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button disabled={busy || !email} onClick={() => withGuard(() => authClient.loginWithPasskey(email))}>
            Entrar com passkey / chave USB
          </button>
        </div>
      )}

      {mode === "recovery" && (
        <div className="login-tab__recovery">
          <p>Perdeste o telemóvel ou a chave de segurança? Liga-te com outra conta acima, ou usa um código de recuperação:</p>
          <input
            type="email"
            placeholder="O teu email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            placeholder="Código de recuperação (xxxxxxxx-xxxxxxxx)"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            disabled={busy || !email || !code}
            onClick={() => withGuard(() => authClient.loginWithBackupCode(email, code))}
          >
            Recuperar acesso
          </button>
        </div>
      )}

      <fieldset className="login-tab__legal">
        <label>
          <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} />
          Li e aceito os <a href={links.terms} target="_blank" rel="noreferrer">Termos de Serviço</a>
        </label>
        <label>
          <input type="checkbox" checked={privacyAccepted} onChange={(e) => setPrivacyAccepted(e.target.checked)} />
          Li e aceito a <a href={links.privacy} target="_blank" rel="noreferrer">Política de Privacidade</a>{" "}
          (RGPD/LGPD)
        </label>
      </fieldset>

      {status && <p className="login-tab__status">{status}</p>}
    </div>
  );
}
