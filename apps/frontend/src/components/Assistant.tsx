/**
 * Assistente opcional (Claude, via API da Lusorbe).
 *
 * - Só com sessão; a API aplica os limites por conta.
 * - Antes da primeira mensagem, a pessoa vê e aceita o aviso de dados.
 * - A conversa vive só nesta página (memória). Não vai para localStorage nem
 *   para o servidor da Lusorbe; "Nova conversa" apaga-a.
 * - As respostas são desenhadas por `RichText` (parágrafos, código e fórmulas),
 *   sem nunca injetar o HTML do modelo; só o KaTeX gera HTML, sem `trust`.
 * - A pessoa escolhe a habilidade (matemática, segurança, …) e a língua da resposta.
 * - Os textos da interface vêm de `i18n`. Em "Automático", o assistente responde
 *   na língua em que a pessoa escreve.
 */
import { useEffect, useRef, useState } from 'react'
import { AuthenticationError, LusorbeError, RateLimitError, ValidationError } from '@lusorbe/sdk'
import type { AssistantSkillId, AssistantStatus, ChatMessage } from '@lusorbe/sdk'

import { lusorbe } from '../lusorbe'
import RichText from './RichText'
import { useI18n } from '../i18n/context'
import type { Messages } from '../i18n/pt-PT'
import './Assistant.css'

const MAX_CHARS = 4000
const MAX_TURNS = 20

type Phase = 'loading' | 'signed-out' | 'disabled' | 'ready' | 'error'

/** Mantém a conversa dentro do limite da API, sem a fazer começar numa resposta. */
function trim(history: ChatMessage[]): ChatMessage[] {
  let h = history.slice(-MAX_TURNS)
  while (h.length && h[0]!.role !== 'user') h = h.slice(1)
  return h
}

/** Mensagem de erro na língua da interface. Em pt-PT usa o texto do servidor, que é mais preciso. */
function friendly(err: unknown, m: Messages, isPt: boolean): string {
  const e = m.assistant.errors
  if (err instanceof RateLimitError) {
    const s = err.retryAfterSeconds
    const wait = s === undefined ? '' : s >= 3600 ? e.backInHours(Math.ceil(s / 3600)) : e.tryInMinutes(Math.max(1, Math.ceil(s / 60)))
    return `${isPt && err.message ? err.message : e.rateLimited} ${wait}`.trim()
  }
  if (err instanceof AuthenticationError) return e.session
  if (err instanceof ValidationError) return e.invalid
  if (err instanceof LusorbeError) return (isPt && err.message) || e.failed
  return e.offline
}

export default function Assistant({ onSignIn }: { onSignIn: () => void }) {
  const { m, lang, locale } = useI18n()
  const a = m.assistant
  const isPt = lang === 'pt-PT'
  const [phase, setPhase] = useState<Phase>('loading')
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [consent, setConsent] = useState(false)
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [skill, setSkill] = useState<AssistantSkillId>('geral')
  const [language, setLanguage] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    lusorbe.assistant
      .status({ abortSignal: ctrl.signal })
      .then(s => { setStatus(s); setPhase(s.enabled ? 'ready' : 'disabled') })
      .catch(err => { if (!ctrl.signal.aborted) setPhase(err instanceof AuthenticationError ? 'signed-out' : 'error') })
    return () => { ctrl.abort(); abortRef.current?.abort() }
  }, [])

  // Desloca só a conversa (não a página), para a caixa de texto continuar visível.
  useEffect(() => { const log = logRef.current; if (log) log.scrollTop = log.scrollHeight }, [history, busy])

  const send = async (text: string) => {
    const content = text.trim()
    if (!content || busy || !consent) return
    const next = trim([...history, { role: 'user', content }])
    setHistory(next)
    setDraft('')
    setError('')
    setBusy(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await lusorbe.assistant.send({ messages: next, consent: true, skill, ...(language ? { language } : {}) }, { abortSignal: ctrl.signal })
      setHistory(h => [...h, { role: 'assistant', content: res.reply }])
    } catch (err) {
      if (ctrl.signal.aborted) return
      setError(friendly(err, m, isPt))
      if (err instanceof AuthenticationError) setPhase('signed-out')
      // A mensagem não teve resposta: volta para a caixa, para não se perder.
      setHistory(h => h.slice(0, -1))
      setDraft(content)
    } finally {
      setBusy(false)
    }
  }

  const reset = () => { abortRef.current?.abort(); setHistory([]); setDraft(''); setError(''); setBusy(false) }

  if (phase === 'loading') return <section className="aegis-panel assistant"><p role="status">{a.checking}</p></section>
  if (phase === 'signed-out') return (
    <section className="aegis-panel assistant assistant-gate">
      <p className="eyebrow">{a.gateKicker}</p>
      <h2>{a.gateTitle}</h2>
      <p className="muted">{a.gateText}</p>
      <button className="button button-dark" onClick={onSignIn}>{a.signIn}</button>
    </section>
  )
  if (phase === 'disabled' || phase === 'error') return (
    <section className="aegis-panel assistant assistant-gate">
      <p className="eyebrow">{a.kicker}</p>
      <h2>{phase === 'disabled' ? a.unavailable : a.cantConnect}</h2>
      <p className="muted">{phase === 'disabled' ? a.disabledText : a.errorText}</p>
    </section>
  )

  return (
    <section className="aegis-panel assistant" aria-label={a.regionLabel}>
      <div className="panel-top">
        <div><p className="eyebrow">{a.kicker} · CLAUDE</p><h2>{a.title}</h2></div>
        <span className="subtle-tag">{a.perDay(status?.daily_limit ?? 0)}</span>
      </div>

      {!consent ? (
        <div className="assistant-consent">
          <p>{isPt ? status?.data_notice : a.dataNotice}</p>
          <ul className="plain-list">
            <li><b>{a.whatFor}</b><span>{a.whatForText}</span></li>
            <li><b>{a.canErr}</b><span>{a.canErrText}</span></li>
          </ul>
          <label className="switch-label"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>{a.accept}</label>
        </div>
      ) : (
        <>
          <div className="assistant-tools">
            <div className="skill-chips" role="radiogroup" aria-label={a.skillsLabel}>
              {(status?.skills ?? []).map(s => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={skill === s.id}
                  className={skill === s.id ? 'chip active' : 'chip'}
                  title={s.description}
                  onClick={() => setSkill(s.id as AssistantSkillId)}
                >{a.skills[s.id] ?? s.name}</button>
              ))}
            </div>
            <label className="lang-select">
              <span>{a.replyIn}</span>
              <select value={language} onChange={e => setLanguage(e.target.value)}>
                <option value="">{a.auto}</option>
                {(status?.languages ?? []).map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </label>
          </div>
          <div className="assistant-log" aria-live="polite" ref={logRef}>
            {history.length === 0 && (
              <div className="assistant-suggestions">
                {(a.suggestions[skill] ?? a.suggestions['geral'] ?? []).map(s => <button key={s} onClick={() => s.endsWith('…') ? setDraft(s.slice(0, -1)) : void send(s)}>{s}</button>)}
              </div>
            )}
            {history.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                <span className="sr-only">{m.role === 'user' ? a.youSaid : a.replied}</span>
                {m.role === 'assistant' ? <RichText text={m.content}/> : m.content}
              </div>
            ))}
            {busy && <div className="bubble assistant typing" role="status">{skill === 'matematica' ? a.solving : a.thinking}</div>}
          </div>
          {error && <p role="alert" className="error-text">{error}</p>}
          <form className="assistant-form" onSubmit={e => { e.preventDefault(); void send(draft) }}>
            <label className="sr-only" htmlFor="assistant-input">{a.inputLabel}</label>
            <textarea
              id="assistant-input"
              rows={3}
              maxLength={MAX_CHARS}
              value={draft}
              placeholder={a.placeholder}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft) } }}
            />
            <div className="input-meta">
              <span>{draft.length.toLocaleString(locale)} / {MAX_CHARS.toLocaleString(locale)}</span>
              <div className="button-row">
                <button type="button" className="button button-quiet" onClick={reset} disabled={!history.length && !draft}>{a.newChat}</button>
                <button type="submit" className="button button-dark" disabled={busy || !draft.trim()}>{busy ? a.sending : a.send}</button>
              </div>
            </div>
          </form>
          <p className="caption">{a.caption}</p>
        </>
      )}
    </section>
  )
}
