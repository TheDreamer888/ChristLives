/**
 * Assistente opcional (Claude, via API da Lusorbe).
 *
 * - Só com sessão; a API aplica os limites por conta.
 * - Antes da primeira mensagem, a pessoa vê e aceita o aviso de dados.
 * - A conversa vive só nesta página (memória). Não vai para localStorage nem
 *   para o servidor da Lusorbe; "Nova conversa" apaga-a.
 * - As respostas são mostradas como texto simples (sem HTML), por segurança.
 */
import { useEffect, useRef, useState } from 'react'
import { AuthenticationError, LusorbeError, RateLimitError, ValidationError } from '@lusorbe/sdk'
import type { AssistantStatus, ChatMessage } from '@lusorbe/sdk'

import { lusorbe } from '../lusorbe'
import './Assistant.css'

const MAX_CHARS = 4000
const MAX_TURNS = 20
const SUGGESTIONS = [
  'Recebi um SMS do banco a pedir para clicar num link. O que faço?',
  'Explica-me a diferença entre juros simples e compostos.',
  'Como crio uma passkey e porque é melhor do que uma palavra-passe?',
  'O que devo verificar antes de correr um script que encontrei online?',
]

type Phase = 'loading' | 'signed-out' | 'disabled' | 'ready' | 'error'

/** Mantém a conversa dentro do limite da API, sem a fazer começar numa resposta. */
function trim(history: ChatMessage[]): ChatMessage[] {
  let h = history.slice(-MAX_TURNS)
  while (h.length && h[0]!.role !== 'user') h = h.slice(1)
  return h
}

function friendly(err: unknown): string {
  if (err instanceof RateLimitError) {
    const s = err.retryAfterSeconds
    const wait = s === undefined ? '' : s >= 3600 ? ` Volta daqui a cerca de ${Math.ceil(s / 3600)} h.` : ` Tenta daqui a ${Math.max(1, Math.ceil(s / 60))} min.`
    return `${err.message}${wait}`
  }
  if (err instanceof AuthenticationError) return 'A tua sessão terminou. Entra de novo na tua conta.'
  if (err instanceof ValidationError) return 'A conversa ficou demasiado longa ou tem um formato inválido. Começa uma nova.'
  if (err instanceof LusorbeError) return err.message || 'O assistente não conseguiu responder. Tenta de novo.'
  return 'Sem ligação. Verifica a internet e tenta de novo.'
}

export default function Assistant({ onSignIn }: { onSignIn: () => void }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [consent, setConsent] = useState(false)
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
      const res = await lusorbe.assistant.send({ messages: next, consent: true }, { abortSignal: ctrl.signal })
      setHistory(h => [...h, { role: 'assistant', content: res.reply }])
    } catch (err) {
      if (ctrl.signal.aborted) return
      setError(friendly(err))
      if (err instanceof AuthenticationError) setPhase('signed-out')
      // A mensagem não teve resposta: volta para a caixa, para não se perder.
      setHistory(h => h.slice(0, -1))
      setDraft(content)
    } finally {
      setBusy(false)
    }
  }

  const reset = () => { abortRef.current?.abort(); setHistory([]); setDraft(''); setError(''); setBusy(false) }

  if (phase === 'loading') return <section className="aegis-panel assistant"><p role="status">A verificar o assistente…</p></section>
  if (phase === 'signed-out') return (
    <section className="aegis-panel assistant assistant-gate">
      <p className="eyebrow">ASSISTENTE · SÓ COM CONTA</p>
      <h2>Entra para conversar.</h2>
      <p className="muted">O assistente usa um modelo de IA com custos reais, por isso só está disponível com conta e com um limite diário de mensagens.</p>
      <button className="button button-dark" onClick={onSignIn}>Entrar na conta</button>
    </section>
  )
  if (phase === 'disabled' || phase === 'error') return (
    <section className="aegis-panel assistant assistant-gate">
      <p className="eyebrow">ASSISTENTE</p>
      <h2>{phase === 'disabled' ? 'Indisponível neste momento.' : 'Não foi possível ligar ao assistente.'}</h2>
      <p className="muted">{phase === 'disabled' ? 'O assistente está desligado neste servidor. As outras ferramentas continuam a funcionar.' : 'Verifica a ligação e tenta de novo mais tarde.'}</p>
    </section>
  )

  return (
    <section className="aegis-panel assistant" aria-label="Conversa com o assistente">
      <div className="panel-top">
        <div><p className="eyebrow">ASSISTENTE · CLAUDE</p><h2>Pergunta o que precisares.</h2></div>
        <span className="subtle-tag">{status?.daily_limit} mensagens/dia</span>
      </div>

      {!consent ? (
        <div className="assistant-consent">
          <p>{status?.data_notice}</p>
          <ul className="plain-list">
            <li><b>Para que serve</b><span>Segurança digital, dinheiro e estudo. Não dá conselhos de investimento personalizados.</span></li>
            <li><b>Pode errar</b><span>Confirma informação importante numa fonte oficial ou com um profissional.</span></li>
          </ul>
          <label className="switch-label"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>Percebi e quero usar o assistente</label>
        </div>
      ) : (
        <>
          <div className="assistant-log" aria-live="polite" ref={logRef}>
            {history.length === 0 && (
              <div className="assistant-suggestions">
                {SUGGESTIONS.map(s => <button key={s} onClick={() => void send(s)}>{s}</button>)}
              </div>
            )}
            {history.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                <span className="sr-only">{m.role === 'user' ? 'Tu disseste:' : 'O assistente respondeu:'}</span>
                {m.content}
              </div>
            ))}
            {busy && <div className="bubble assistant typing" role="status">A pensar…</div>}
          </div>
          {error && <p role="alert" className="error-text">{error}</p>}
          <form className="assistant-form" onSubmit={e => { e.preventDefault(); void send(draft) }}>
            <label className="sr-only" htmlFor="assistant-input">Mensagem para o assistente</label>
            <textarea
              id="assistant-input"
              rows={3}
              maxLength={MAX_CHARS}
              value={draft}
              placeholder="Escreve a tua pergunta… (Enter envia, Shift+Enter muda de linha)"
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft) } }}
            />
            <div className="input-meta">
              <span>{draft.length.toLocaleString('pt-PT')} / {MAX_CHARS.toLocaleString('pt-PT')}</span>
              <div className="button-row">
                <button type="button" className="button button-quiet" onClick={reset} disabled={!history.length && !draft}>Nova conversa</button>
                <button type="submit" className="button button-dark" disabled={busy || !draft.trim()}>{busy ? 'A enviar…' : 'Enviar'}</button>
              </div>
            </div>
          </form>
          <p className="caption">A conversa fica só nesta página e é apagada ao fechar ou ao começar uma nova. Não escrevas palavras-passe nem dados bancários.</p>
        </>
      )}
    </section>
  )
}
