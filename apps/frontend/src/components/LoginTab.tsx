import { useEffect, useState } from "react";
import { authClient, type ProviderInfo, type SessionUser } from "../auth/authClient";
import type { AuthSession } from "../lib/api";
import { runUnauthenticatedGuard } from "../lib/loginTabGuard";
import "./LoginTab.css";

const PROVIDER_ICONS: Record<string, string> = {
  google: "🟢",
  microsoft: "🟦",
  github: "🐙",
  gitlab: "🦊",
  apple: "🍎",
  discord: "🎮",
};

type Mode = "providers" | "passkey" | "recovery";
type AuthState = "loading" | "ready" | "unavailable";

/** Adaptable, secure login tab: OAuth (Google/Microsoft/GitHub/...), passkeys
 *  / hardware security keys, and account-recovery when a factor is lost. */
export default function LoginTab({ onAuthenticated }: { onAuthenticated?: () => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [passkeyOk, setPasskeyOk] = useState(false);
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [authRetry, setAuthRetry] = useState(0);
  const [mode, setMode] = useState<Mode>("providers");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [session, setSession] = useState<SessionUser | null>(null);
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authClient.listProviders().then((res) => {
      if (cancelled) return;
      setProviders(res.oauth);
      setPasskeyOk(res.webauthn && authClient.passkeySupported());
      setAuthState("ready");
    }).catch(() => {
      if (cancelled) return;
      setAuthState("unavailable");
    });
    authClient.getSession().then((currentSession) => {
      if (!cancelled) {
        setSession(currentSession);
        if (!currentSession) {
          setSessions([]);
          return;
        }
        authClient.listSessions().then((activeSessions) => {
          if (!cancelled) setSessions(activeSessions);
        }).catch((reason) => {
          if (!cancelled) setStatus(reason instanceof Error ? reason.message : "Não foi possível carregar as sessões.");
        });
      }
    }).catch((reason) => {
      if (!cancelled) setStatus(reason instanceof Error ? reason.message : "Não foi possível verificar a sessão.");
    });
    return () => { cancelled = true; };
  }, [authRetry]);

  const legalOk = termsAccepted && privacyAccepted;
  const inviteToken = window.location.hash.match(/^#\/invite\/([A-Za-z0-9_-]{32,128})(?:\?.*)?$/)?.[1];

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
      const currentSession = await authClient.getSession()
      setSession(currentSession)
      if (currentSession) {
        setSessions(await authClient.listSessions())
        onAuthenticated?.()
      } else {
        setSessions([])
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Ocorreu um erro.");
    } finally {
      setBusy(false);
    }
  };

  if (session) {
    const revokeSession = async (sessionId: string) => {
      setBusy(true);
      setStatus(null);
      try {
        await authClient.revokeSession(sessionId);
        setSessions(await authClient.listSessions());
        setStatus("A sessão selecionada foi terminada.");
      } catch (err) {
        setStatus(err instanceof Error ? err.message : "Não foi possível terminar a sessão.");
      } finally {
        setBusy(false);
      }
    };
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
        <section className="login-tab__sessions" aria-label="Sessões ativas">
          <h3>Sessões ativas</h3>
          {sessions.length === 0 && <p role="status">Não foi possível apresentar sessões ativas.</p>}
          {sessions.map((activeSession) => (
            <div className="login-tab__session" key={activeSession.id}>
              <p>
                {activeSession.is_current ? "Esta sessão" : "Outra sessão"} · iniciada{" "}
                {activeSession.created_at ? new Date(activeSession.created_at).toLocaleString("pt-PT") : "em data indisponível"}
              </p>
              {!activeSession.is_current && (
                <button disabled={busy} onClick={() => void revokeSession(activeSession.id)}>
                  Terminar sessão
                </button>
              )}
            </div>
          ))}
        </section>
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
        <button type="button" aria-pressed={mode === "providers"} className={mode === "providers" ? "active" : ""} onClick={() => setMode("providers")}>
          Contas
        </button>
        {passkeyOk && (
          <button type="button" aria-pressed={mode === "passkey"} className={mode === "passkey" ? "active" : ""} onClick={() => setMode("passkey")}>
            Chave de segurança
          </button>
        )}
        <button type="button" aria-pressed={mode === "recovery"} className={mode === "recovery" ? "active" : ""} onClick={() => setMode("recovery")}>
          Perdi o acesso
        </button>
      </div>

      {mode === "providers" && (
        <div className="login-tab__providers">
          {authState === "loading" && <p role="status">A verificar as opções de autenticação…</p>}
          {authState === "ready" && providers.length === 0 && <p>Nenhuma conta externa está configurada neste momento. Se tiveres uma chave de segurança ou um código de recuperação, podes usar esses métodos.</p>}
          {providers.map((p) => (
            <button
              key={p.id}
              className="login-tab__provider-btn"
              disabled={busy || authState !== "ready"}
              onClick={() => withGuard(() => authClient.loginWithProvider(
                p.id,
                inviteToken ? `invite/${inviteToken}` : undefined,
              ))}
            >
              <span aria-hidden>{PROVIDER_ICONS[p.id] ?? "🔑"}</span> Continuar com {p.name}
            </button>
          ))}
        </div>
      )}

      {mode === "passkey" && (
        <div className="login-tab__passkey">
          <label htmlFor="login-email-passkey">Email associado à conta</label>
          <input
            id="login-email-passkey"
            type="email"
            autoComplete="email"
            placeholder="nome@exemplo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="button" disabled={busy || authState !== "ready" || !email} onClick={() => withGuard(() => authClient.loginWithPasskey(email))}>
            Entrar com passkey / chave USB
          </button>
        </div>
      )}

      {mode === "recovery" && (
        <div className="login-tab__recovery">
          <p>Se ainda tiveres acesso a outro método, escolhe-o no separador «Contas». Caso contrário, introduz o email associado à conta e um código de recuperação.</p>
          <label htmlFor="login-email-recovery">Email associado à conta</label>
          <input
            id="login-email-recovery"
            type="email"
            autoComplete="email"
            placeholder="nome@exemplo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="login-backup-code">Código de recuperação</label>
          <input
            id="login-backup-code"
            autoComplete="one-time-code"
            placeholder="xxxxxxxx-xxxxxxxx"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || authState !== "ready" || !email || !code}
            onClick={() => withGuard(() => authClient.loginWithBackupCode(email, code))}
          >
            Recuperar acesso
          </button>
        </div>
      )}

      <fieldset className="login-tab__legal">
        <legend>Confirmação necessária para continuar</legend>
        <label>
          <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} />
          Li e aceito os <a href="/legal/terms.html" target="_blank" rel="noreferrer">Termos de Serviço</a>
        </label>
        <label>
          <input type="checkbox" checked={privacyAccepted} onChange={(e) => setPrivacyAccepted(e.target.checked)} />
          Li e aceito a <a href="/legal/privacy.html" target="_blank" rel="noreferrer">Política de Privacidade</a>{" "}
          (RGPD/LGPD)
        </label>
      </fieldset>

      {authState === "unavailable" && (
        <div className="login-tab__unavailable" role="alert">
          <p>Não foi possível ligar ao serviço de autenticação. Verifica se a API está disponível.</p>
          <button type="button" onClick={() => { setStatus(null); setAuthState("loading"); setAuthRetry((retry) => retry + 1); }}>
            Tentar novamente
          </button>
        </div>
      )}
      {status && <p className="login-tab__status" role="alert">{status}</p>}
    </div>
  );
}
