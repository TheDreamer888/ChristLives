import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ApiError } from '../../lib/http'
import { aiApi, type ChatMode, type ChatStyle, type ChatTurn, type Supervision } from '../../lib/aiApi'
import { AiAnswer, AiIcon, ModelPicker, NoAiNotice, useChatModels } from './shared'
import './ChatExtras.css'

export type ChatSeed = { id: number; prompt: string; mode: ChatMode; context?: string }

type Message = ChatTurn & { id: number; model?: string; error?: boolean; supervision?: Supervision | null }

const STYLES: { id: ChatStyle; label: string }[] = [
  { id: 'concise', label: 'Curta' },
  { id: 'balanced', label: 'Equilibrada' },
  { id: 'detailed', label: 'Detalhada' },
]

const SUPERVISION_LABEL: Record<Supervision['status'], string> = {
  approved: 'Verificada pela IA supervisora',
  blocked: 'Retida pela IA supervisora',
  unavailable: 'Supervisor indisponível — não verificada',
  disabled: 'Sem supervisão',
}

function exportConversation(title: string, messages: Message[]) {
  const lines = [`# ${title}`, '', `Exportado do Aegis em ${new Date().toLocaleString('pt-PT')}`, '']
  for (const m of messages) lines.push(`## ${m.role === 'user' ? 'Tu' : 'IA'}${m.model ? ` (${m.model})` : ''}`, '', m.content, '')
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `aegis-conversa-${new Date().toISOString().slice(0, 10)}.md`
  link.click()
  URL.revokeObjectURL(url)
}
type Conversation = { id: number; title: string; mode: ChatMode; messages: Message[]; context?: string }

const MODES: { id: ChatMode; label: string; hint: string }[] = [
  { id: 'general', label: 'Geral', hint: 'Qualquer pergunta' },
  { id: 'trading', label: 'Trading', hint: 'Mercados e risco' },
  { id: 'tutor', label: 'Tutor', hint: 'Economia passo a passo' },
  { id: 'organize', label: 'Organização', hint: 'Emails e tarefas' },
]

const SUGGESTIONS: { mode: ChatMode; title: string; prompt: string }[] = [
  { mode: 'trading', title: 'Analisa o risco', prompt: 'Explica como avaliar o risco antes de comprar uma ação volátil, com um exemplo numérico.' },
  { mode: 'tutor', title: 'Aprende economia', prompt: 'Explica-me a inflação como se eu tivesse 15 anos e faz-me 3 perguntas no fim.' },
  { mode: 'organize', title: 'Organiza a semana', prompt: 'Ajuda-me a planear a semana: tenho 3 entregas, 2 reuniões e quero ir ao ginásio 3 vezes.' },
  { mode: 'general', title: 'Escreve melhor', prompt: 'Reescreve este texto de forma clara e profissional: ' },
]

// As conversas vivem só na memória deste separador (sobrevivem à navegação, não a recarregar).
let store: Conversation[] = []
let nextId = 1

export default function ChatView({ seed, onSeedUsed, supportPanel }: { seed: ChatSeed | null; onSeedUsed: () => void; supportPanel?: ReactNode }) {
  const models = useChatModels()
  const [tab, setTab] = useState<'chat' | 'support'>('chat')
  const [conversations, setConversations] = useState<Conversation[]>(store)
  const [activeId, setActiveId] = useState<number | null>(store[0]?.id ?? null)
  const [mode, setMode] = useState<ChatMode>('general')
  const [style, setStyle] = useState<ChatStyle>('balanced')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  const active = conversations.find(c => c.id === activeId) ?? null
  useEffect(() => { store = conversations }, [conversations])
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }) }, [active?.messages.length, sending])

  const update = (id: number, change: (c: Conversation) => Conversation) => setConversations(list => list.map(c => (c.id === id ? change(c) : c)))

  const ask = async (conversation: Conversation, question: string, history: Message[]) => {
    if (!models.selected) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setSending(true)
    try {
      const reply = await aiApi.sendChat({
        model: models.selected, mode: conversation.mode, message: question, style,
        history: history.filter(m => !m.error).map(({ role, content }) => ({ role, content })),
        ...(conversation.context ? { context: conversation.context } : {}),
      }, controller.signal)
      update(conversation.id, c => ({ ...c, messages: [...c.messages, { id: nextId++, role: 'assistant', content: reply.answer, model: reply.model, supervision: reply.supervision }] }))
    } catch (reason) {
      if (controller.signal.aborted) {
        update(conversation.id, c => ({ ...c, messages: [...c.messages, { id: nextId++, role: 'assistant', content: 'Resposta cancelada.', error: true }] }))
      } else {
        const text = reason instanceof ApiError || reason instanceof Error ? reason.message : 'Não foi possível obter resposta.'
        update(conversation.id, c => ({ ...c, messages: [...c.messages, { id: nextId++, role: 'assistant', content: text, error: true }] }))
      }
    } finally {
      if (abort.current === controller) abort.current = null
      setSending(false)
    }
  }

  const send = (text: string, options?: { mode?: ChatMode; context?: string; fresh?: boolean }) => {
    const question = text.trim()
    if (!question || sending || !models.selected) return
    const chosenMode = options?.mode ?? active?.mode ?? mode
    let conversation = options?.fresh || !active ? null : active
    const userMessage: Message = { id: nextId++, role: 'user', content: question }
    if (!conversation) {
      conversation = { id: nextId++, title: question.slice(0, 60), mode: chosenMode, messages: [userMessage], ...(options?.context ? { context: options.context } : {}) }
      const created = conversation
      setConversations(list => [created, ...list].slice(0, 30))
      setActiveId(created.id)
      setMode(chosenMode)
      void ask(created, question, [])
    } else {
      const current = conversation
      update(current.id, c => ({ ...c, messages: [...c.messages, userMessage] }))
      void ask(current, question, current.messages)
    }
    setDraft('')
  }

  // Pedido vindo de outra área (Trading, Notícias, Cursos, Organização, Início).
  useEffect(() => {
    if (!seed || models.loading) return
    onSeedUsed()
    setTab('chat')
    if (!models.selected) { setDraft(seed.prompt); return }
    send(seed.prompt, { mode: seed.mode, ...(seed.context ? { context: seed.context } : {}), fresh: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, models.loading, models.selected])

  const regenerate = () => {
    if (!active || sending) return
    const messages = [...active.messages]
    while (messages.length && messages[messages.length - 1]?.role === 'assistant') messages.pop()
    const last = messages[messages.length - 1]
    if (!last) return
    update(active.id, c => ({ ...c, messages }))
    void ask({ ...active, messages }, last.content, messages.slice(0, -1))
  }

  const copy = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(message.id)
      window.setTimeout(() => setCopied(current => (current === message.id ? null : current)), 1500)
    } catch { /* clipboard bloqueado */ }
  }

  const onSubmit = (event: FormEvent) => { event.preventDefault(); send(draft) }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(draft) }
  }
  const newChat = () => { setActiveId(null); setListOpen(false); input.current?.focus() }
  const remove = (id: number) => { setConversations(list => list.filter(c => c.id !== id)); if (activeId === id) setActiveId(null) }

  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [draft])

  const currentMode = active?.mode ?? mode
  const lastAssistant = active ? [...active.messages].reverse().find(m => m.role === 'assistant') : undefined

  return <section className="chat-page">
    <div className="chat-tabs" role="tablist" aria-label="Chat ou suporte">
      <button role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}><AiIcon name="chat" size={16} />Chat IA</button>
      {supportPanel && <button role="tab" aria-selected={tab === 'support'} onClick={() => setTab('support')}><AiIcon name="shield" size={16} />Suporte Aegis</button>}
    </div>

    {tab === 'support' ? supportPanel : <div className={listOpen ? 'chat-shell list-open' : 'chat-shell'}>
      <aside className="chat-list" aria-label="Conversas">
        <button className="chat-new" type="button" onClick={newChat}><AiIcon name="plus" size={16} />Nova conversa</button>
        <p className="chat-list-label">Recentes</p>
        {conversations.length === 0 && <p className="chat-list-empty">As conversas ficam só neste separador e desaparecem ao recarregar.</p>}
        <ul>
          {conversations.map(c => <li key={c.id} className={c.id === activeId ? 'active' : ''}>
            <button type="button" onClick={() => { setActiveId(c.id); setListOpen(false) }}>
              <span className={`mode-tag mode-tag--${c.mode}`}>{MODES.find(m => m.id === c.mode)?.label}</span>
              <span className="chat-list-title">{c.title}</span>
            </button>
            <button type="button" className="chat-remove" aria-label={`Apagar conversa ${c.title}`} onClick={() => remove(c.id)}><AiIcon name="trash" size={15} /></button>
          </li>)}
        </ul>
      </aside>

      <div className="chat-main">
        <header className="chat-head">
          <button className="chat-list-toggle" type="button" aria-expanded={listOpen} onClick={() => setListOpen(v => !v)}><AiIcon name="menu" size={18} /><span className="sr-only">Conversas</span></button>
          <ModelPicker state={models} />
          <div className="style-picker" role="radiogroup" aria-label="Tamanho da resposta">
            {STYLES.map(s => <button key={s.id} type="button" role="radio" aria-checked={style === s.id} className={style === s.id ? 'selected' : ''} onClick={() => setStyle(s.id)}>{s.label}</button>)}
          </div>
          {active && active.messages.length > 0 && <button className="chat-export" type="button" onClick={() => exportConversation(active.title, active.messages)} title="Exportar conversa (Markdown)"><AiIcon name="external" size={15} /><span className="sr-only">Exportar conversa</span></button>}
          <label className="mode-select">
            <span className="sr-only">Modo</span>
            <select value={currentMode} disabled={!!active} onChange={event => setMode(event.target.value as ChatMode)} title={active ? 'O modo é fixo por conversa — abre uma nova para mudar.' : undefined}>
              {MODES.map(m => <option key={m.id} value={m.id}>{m.label} — {m.hint}</option>)}
            </select>
          </label>
        </header>

        <div className="chat-scroll" ref={scroller} aria-live="polite">
          {!active ? <div className="chat-empty">
            <span className="chat-orb" aria-hidden="true"><AiIcon name="spark" size={30} /></span>
            <h2>Em que posso ajudar hoje?</h2>
            <p>Pergunta, analisa mercados, aprende economia ou organiza o teu trabalho — com Claude, ChatGPT ou Grok.</p>
            {!models.loading && !models.models.length && <NoAiNotice />}
            <div className="chat-suggestions">
              {SUGGESTIONS.map(s => <button key={s.title} type="button" disabled={!models.selected} onClick={() => {
                if (s.prompt.endsWith(': ')) { setMode(s.mode); setDraft(s.prompt); input.current?.focus() } else send(s.prompt, { mode: s.mode, fresh: true })
              }}>
                <strong>{s.title}</strong><span>{s.prompt}</span>
              </button>)}
            </div>
          </div> : <ol className="chat-messages">
            {active.context && <li className="chat-context-note"><AiIcon name="spark" size={14} />Esta conversa inclui dados de contexto (cotações, notícias, lição ou email) enviados à IA.</li>}
            {active.messages.map(message => <li key={message.id} className={`chat-msg chat-msg--${message.role}${message.error ? ' chat-msg--error' : ''}`}>
              {message.role === 'assistant' && <span className="chat-avatar" aria-hidden="true"><AiIcon name="spark" size={16} /></span>}
              <div className="chat-bubble">
                {message.role === 'assistant' && !message.error ? <AiAnswer text={message.content} /> : <p>{message.content}</p>}
                {message.role === 'assistant' && !message.error && <div className="chat-actions">
                  <button type="button" onClick={() => void copy(message)}><AiIcon name={copied === message.id ? 'check' : 'copy'} size={14} />{copied === message.id ? 'Copiado' : 'Copiar'}</button>
                  {message === lastAssistant && <button type="button" onClick={regenerate} disabled={sending}><AiIcon name="retry" size={14} />Regenerar</button>}
                  {message.model && <span className="chat-model-tag">{models.models.find(m => m.id === message.model)?.label ?? message.model}</span>}
                  {message.supervision && message.supervision.status !== 'disabled' && <span className={`supervision-badge supervision-badge--${message.supervision.status}`} title={message.supervision.reason || undefined}>
                    <AiIcon name="shield" size={13} />{SUPERVISION_LABEL[message.supervision.status]}
                  </span>}
                </div>}
                {message.error && message === lastAssistant && <button className="chat-retry" type="button" onClick={regenerate} disabled={sending}><AiIcon name="retry" size={14} />Tentar novamente</button>}
              </div>
            </li>)}
            {sending && <li className="chat-msg chat-msg--assistant"><span className="chat-avatar" aria-hidden="true"><AiIcon name="spark" size={16} /></span><div className="chat-bubble"><span className="typing" role="status" aria-label="A IA está a escrever"><i /><i /><i /></span></div></li>}
          </ol>}
        </div>

        <form className="chat-composer" onSubmit={onSubmit}>
          <label htmlFor="chat-input" className="sr-only">Mensagem</label>
          <textarea id="chat-input" ref={input} rows={1} maxLength={4000} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown}
            placeholder={models.selected ? 'Escreve uma mensagem… (Enter envia, Shift+Enter muda de linha)' : 'Configura uma IA no servidor para começar'} disabled={!models.selected} />
          {sending
            ? <button type="button" className="chat-send chat-send--stop" onClick={() => abort.current?.abort()} aria-label="Parar resposta"><AiIcon name="stop" size={18} /></button>
            : <button type="submit" className="chat-send" disabled={!draft.trim() || !models.selected} aria-label="Enviar mensagem"><AiIcon name="send" size={18} /></button>}
        </form>
        <p className="chat-footnote">A IA pode errar — confirma informação importante. Sem conteúdo adulto. Não partilhes palavras-passe nem dados sensíveis. Não é aconselhamento financeiro.</p>
      </div>
    </div>}
  </section>
}
