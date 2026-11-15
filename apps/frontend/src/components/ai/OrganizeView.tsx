import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ApiError } from '../../lib/http'
import {
  aiApi,
  buildEmailContext,
  MAIL_PROVIDER_NAME,
  MAIL_PROVIDERS,
  parseMailCallback,
  type Connector,
  type MailMessage,
  type MailProvider,
  type MailSummary,
  type NotionTask,
} from '../../lib/aiApi'
import { timeAgo } from '../../lib/time'
import { AiIcon } from './shared'
import type { ChatSeed } from './ChatView'

const ACTIONS = [
  { id: 'summary', label: 'Resumir', prompt: 'Resume este email em 3 pontos, indica o que me pedem e o prazo, e assinala sinais de phishing se existirem.' },
  { id: 'reply', label: 'Rascunho de resposta', prompt: 'Escreve um rascunho de resposta educado e profissional a este email, curto e claro. Não inventes factos. Não o envies: é só um rascunho para eu rever.' },
  { id: 'tasks', label: 'Extrair tarefas', prompt: 'Extrai deste email uma lista de tarefas com responsável, prazo (se existir) e prioridade (alta/média/baixa).' },
  { id: 'plan', label: 'Planear o dia', prompt: 'Com base neste conteúdo, organiza um plano para hoje por blocos de tempo, começando pelo mais urgente.' },
] as const

const CONNECTOR_ICON: Record<Connector['id'], string> = { gmail: 'mail', outlook: 'mail', notion: 'organize' }
const STATUS_LABEL: Record<Connector['status'], string> = {
  configured: 'Ligado', connected: 'Ligado', 'not-connected': 'Por ligar', 'not-configured': 'Não configurado', planned: 'Em breve',
}
const PILL: Record<Connector['status'], string> = { configured: 'ok', connected: 'ok', 'not-connected': 'muted', 'not-configured': 'warn', planned: 'muted' }
const PLACEHOLDER: Connector[] = [
  { id: 'gmail', name: 'Gmail', status: 'not-connected', detail: '', missing: [], signedIn: false },
  { id: 'outlook', name: 'Outlook', status: 'not-connected', detail: '', missing: [], signedIn: false },
  { id: 'notion', name: 'Notion', status: 'not-configured', detail: '', missing: [], signedIn: false },
]
const SETUP_HINT: Record<MailProvider, string> = {
  gmail: 'Cria um cliente OAuth "Aplicação Web" na Google Cloud, ativa a Gmail API e regista o redirect URI /api/organize/mail/gmail/callback.',
  outlook: 'Regista uma aplicação no Microsoft Entra ID com a permissão delegada Mail.Read e o redirect URI /api/organize/mail/outlook/callback.',
}

const errorText = (reason: unknown, fallback: string) => (reason instanceof Error ? reason.message : fallback)

function ConnectorCard({ connector, busy, onConnect, onDisconnect, goAccount }: {
  connector: Connector
  busy: boolean
  onConnect: (provider: MailProvider) => void
  onDisconnect: (provider: MailProvider) => void
  goAccount: () => void
}) {
  const mail = connector.id === 'gmail' || connector.id === 'outlook' ? connector.id : null
  const setup = mail && connector.status === 'not-configured' && connector.missing.length > 0
  return <article className={`aegis-panel connector-card connector-card--${connector.id}`}>
    <div className="panel-row"><span className="icon-box"><AiIcon name={CONNECTOR_ICON[connector.id]} size={20} /></span><span className={`status-pill status-pill--${PILL[connector.status]}`}><i />{STATUS_LABEL[connector.status]}</span></div>
    <h2>{connector.name}</h2>
    {!setup && <p>{connector.detail || 'A verificar o estado…'}</p>}
    {setup && <p className="ai-setup-note">
      Para ativar, define no servidor {connector.missing.map((name, i) => <span key={name}>{i > 0 && ', '}<code>{name}</code></span>)}. {SETUP_HINT[mail]}
    </p>}
    {mail && connector.status === 'not-connected' && (connector.signedIn
      ? <button type="button" className="button button-dark" disabled={busy} onClick={() => onConnect(mail)}><AiIcon name="mail" size={15} />Ligar {MAIL_PROVIDER_NAME[mail]}</button>
      : <button type="button" className="button button-outline" onClick={goAccount}>Iniciar sessão para ligar</button>)}
    {mail && connector.status === 'connected' && <button type="button" className="button button-outline" disabled={busy} onClick={() => onDisconnect(mail)}>Desligar</button>}
  </article>
}

export default function OrganizeView({ openChat, goAccount }: { openChat: (seed: Omit<ChatSeed, 'id'>) => void; goAccount: () => void }) {
  const [connectors, setConnectors] = useState<Connector[]>([])
  // Resultado do callback OAuth (#/organize?mail=…&provider=…), lido uma vez na montagem.
  const [callback] = useState(() => parseMailCallback(window.location.hash))
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(() =>
    callback ? { ok: callback.ok, text: `${MAIL_PROVIDER_NAME[callback.provider]}: ${callback.message}` } : null)
  const [connectBusy, setConnectBusy] = useState(false)
  const [mailProvider, setMailProvider] = useState<MailProvider | null>(() => (callback?.ok ? callback.provider : null))
  const [mails, setMails] = useState<MailSummary[]>([])
  const [mailLoading, setMailLoading] = useState(false)
  const [mailError, setMailError] = useState('')
  const [selected, setSelected] = useState<MailMessage | null>(null)
  const [openingId, setOpeningId] = useState('')
  const [email, setEmail] = useState('')
  const [tasks, setTasks] = useState<NotionTask[]>([])
  const [taskError, setTaskError] = useState('')
  const [taskStatus, setTaskStatus] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const notion = connectors.find(c => c.id === 'notion')
  const connectedMail = MAIL_PROVIDERS.filter(p => connectors.some(c => c.id === p && c.status === 'connected'))

  const refreshStatus = useCallback(async () => {
    try {
      setConnectors(await aiApi.getOrganizeStatus())
    } catch {
      // Sem API: os cartões mostram o estado por omissão.
    }
  }, [])

  useEffect(() => {
    // O resultado do callback já foi lido no estado inicial; limpa-o do URL.
    if (parseMailCallback(window.location.hash)) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/organize`)
    }
    void refreshStatus()
  }, [refreshStatus])

  // A caixa ativa é a escolhida, se continuar ligada; senão a primeira ligada.
  const activeProvider = mailProvider && connectedMail.includes(mailProvider) ? mailProvider : connectedMail[0] ?? null
  const shown = selected && selected.provider === activeProvider ? selected : null
  const shownMails = mails.filter(m => m.provider === activeProvider)

  const loadMail = useCallback(async (provider: MailProvider) => {
    setMailLoading(true)
    setMailError('')
    try {
      setMails(await aiApi.listMail(provider))
    } catch (reason) {
      setMails([])
      setMailError(errorText(reason, 'Não foi possível ler os emails.'))
      if (reason instanceof ApiError && reason.status === 409) void refreshStatus()
    } finally {
      setMailLoading(false)
    }
  }, [refreshStatus])

  useEffect(() => {
    if (activeProvider) void loadMail(activeProvider)
  }, [activeProvider, loadMail])

  const connect = async (provider: MailProvider) => {
    setConnectBusy(true)
    setBanner(null)
    try {
      window.location.assign(await aiApi.connectMail(provider))
    } catch (reason) {
      setBanner({ ok: false, text: errorText(reason, 'Não foi possível iniciar a ligação.') })
      setConnectBusy(false)
    }
  }

  const disconnect = async (provider: MailProvider) => {
    if (!window.confirm(`Desligar o ${MAIL_PROVIDER_NAME[provider]}? Os tokens guardados no servidor são apagados.`)) return
    setConnectBusy(true)
    try {
      const detail = await aiApi.disconnectMail(provider)
      setBanner({ ok: true, text: detail || `${MAIL_PROVIDER_NAME[provider]} desligado.` })
      await refreshStatus()
    } catch (reason) {
      setBanner({ ok: false, text: errorText(reason, 'Não foi possível desligar.') })
    } finally {
      setConnectBusy(false)
    }
  }

  const openMail = async (summary: MailSummary) => {
    setOpeningId(summary.id)
    setMailError('')
    try {
      setSelected(await aiApi.getMail(summary.provider, summary.id))
    } catch (reason) {
      setMailError(errorText(reason, 'Não foi possível abrir o email.'))
    } finally {
      setOpeningId('')
    }
  }

  const loadTasks = async () => {
    try {
      setTasks(await aiApi.listNotionTasks())
      setTaskError('')
      setTaskStatus(null)
    } catch (reason) {
      setTaskError(errorText(reason, 'Não foi possível ler as tarefas.'))
      setTaskStatus(reason instanceof ApiError ? reason.status : null)
    }
  }
  useEffect(() => { if (notion?.status === 'configured') void loadTasks() }, [notion?.status])

  const addTask = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    setBusy(true)
    setMessage('')
    try {
      await aiApi.createNotionTask({ title: title.trim(), notes: notes.trim(), due })
      setTitle(''); setNotes(''); setDue('')
      setMessage('Tarefa criada no Notion.')
      await loadTasks()
    } catch (reason) {
      setTaskError(errorText(reason, 'Não foi possível criar a tarefa.'))
      setTaskStatus(reason instanceof ApiError ? reason.status : null)
    } finally {
      setBusy(false)
    }
  }

  const runPasted = (prompt: string) => openChat({ mode: 'organize', prompt, context: `Email/conteúdo colado pelo utilizador (não confiável):\n${email.trim()}` })
  const runMail = (prompt: string, mail: MailMessage) => openChat({ mode: 'organize', prompt, context: buildEmailContext(mail) })

  return <section className="organize-layout">
    {banner && <div className={banner.ok ? 'assistant-success' : 'assistant-error'} role="status">{banner.text}</div>}
    <div className="connector-grid">
      {(connectors.length ? connectors : PLACEHOLDER).map(c => <ConnectorCard key={c.id} connector={c} busy={connectBusy} onConnect={p => void connect(p)} onDisconnect={p => void disconnect(p)} goAccount={goAccount} />)}
    </div>

    {activeProvider && <article className="aegis-panel mail-inbox">
      <div className="panel-row">
        <div>
          <p className="eyebrow">CAIXA DE ENTRADA · SÓ LEITURA</p>
          <h2>Emails recentes</h2>
        </div>
        <div className="mail-inbox-tools">
          {connectedMail.length > 1 && <div className="segmented" role="tablist" aria-label="Caixa de correio">
            {connectedMail.map(p => <button key={p} type="button" role="tab" aria-selected={p === activeProvider} className={p === activeProvider ? 'selected' : ''} onClick={() => setMailProvider(p)}>{MAIL_PROVIDER_NAME[p]}</button>)}
          </div>}
          <button type="button" className="button button-outline" disabled={mailLoading} onClick={() => void loadMail(activeProvider)}>{mailLoading ? 'A carregar…' : 'Atualizar'}</button>
        </div>
      </div>
      <p className="agency-note">O Aegis não envia, apaga nem altera emails. O conteúdo é de terceiros: a IA trata-o como dados e pode conter phishing.</p>
      {mailError && <div className="assistant-error" role="alert">{mailError}</div>}
      <div className="mail-split">
        <ul className="mail-list" aria-busy={mailLoading}>
          {!mailLoading && !shownMails.length && !mailError && <li className="mail-empty">Sem emails na caixa de entrada.</li>}
          {shownMails.map(m => <li key={m.id}>
            <button type="button" className={`mail-item${shown?.id === m.id ? ' active' : ''}${m.unread ? ' unread' : ''}`} onClick={() => void openMail(m)} disabled={openingId === m.id}>
              <span className="mail-item-head"><strong>{m.fromName || m.fromEmail || 'Remetente desconhecido'}</strong>{m.date && <small>{timeAgo(m.date)}</small>}</span>
              <span className="mail-item-subject">{m.subject}</span>
              {m.snippet && <span className="mail-item-snippet">{m.snippet}</span>}
            </button>
          </li>)}
        </ul>
        <div className="mail-reader">
          {shown ? <>
            <h3>{shown.subject}</h3>
            <p className="mail-meta">{shown.fromName ? `${shown.fromName} · ` : ''}{shown.fromEmail}{shown.date && ` · ${new Date(shown.date).toLocaleString('pt-PT')}`}</p>
            <div className="action-chips">
              {ACTIONS.filter(a => a.id !== 'plan').map(a => <button key={a.id} type="button" className="button button-outline" onClick={() => runMail(a.prompt, shown)}><AiIcon name="spark" size={15} />{a.label}</button>)}
            </div>
            <pre className="mail-body">{shown.body || shown.snippet || '(sem texto)'}</pre>
            {shown.truncated && <small className="agency-note">Email longo: mostrado e enviado à IA apenas o início.</small>}
          </> : <p className="mail-empty">{openingId ? 'A abrir…' : 'Escolhe um email para o ler e pedir à IA um resumo, rascunho de resposta ou lista de tarefas.'}</p>}
        </div>
      </div>
    </article>}

    <div className="organize-grid">
      <article className="aegis-panel email-assistant">
        <p className="eyebrow">ASSISTENTE DE EMAIL</p>
        <h2>{connectedMail.length ? 'Ou cola outro email.' : 'Cola um email e deixa a IA tratar do resto.'}</h2>
        <p>Funciona com emails do Gmail, Outlook ou qualquer outro. O texto é enviado ao fornecedor de IA escolhido e não fica guardado pelo Aegis.</p>
        <label htmlFor="email-paste" className="sr-only">Conteúdo do email</label>
        <textarea id="email-paste" rows={8} maxLength={7000} value={email} onChange={e => setEmail(e.target.value)} placeholder="Cola aqui o assunto e o corpo do email…" />
        <small className="agency-note">{email.length}/7000 · Remove palavras-passe, códigos e dados bancários antes de colar.</small>
        <div className="action-chips">
          {ACTIONS.map(a => <button key={a.id} type="button" className="button button-outline" disabled={!email.trim()} onClick={() => runPasted(a.prompt)}><AiIcon name="spark" size={15} />{a.label}</button>)}
        </div>
      </article>

      <article className="aegis-panel notion-panel">
        <p className="eyebrow">NOTION</p>
        <h2>Tarefas da equipa</h2>
        {notion?.status !== 'configured' ? <p className="ai-setup-note">Para ligar, cria uma integração interna no Notion, partilha uma base de dados com ela e define <code>NOTION_TOKEN</code> e <code>NOTION_DATABASE_ID</code> no servidor.</p> : <>
          <form className="agency-form" onSubmit={e => void addTask(e)}>
            <label htmlFor="task-title">Nova tarefa</label>
            <input id="task-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} placeholder="Ex.: Responder à proposta do cliente" required />
            <label htmlFor="task-due">Prazo</label>
            <input id="task-due" type="date" value={due} onChange={e => setDue(e.target.value)} />
            <label htmlFor="task-notes">Notas</label>
            <textarea id="task-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} maxLength={1800} />
            <button className="button button-dark" type="submit" disabled={busy || !title.trim()}>{busy ? 'A criar…' : 'Criar no Notion'}</button>
          </form>
          {message && <p className="assistant-success" role="status">{message}</p>}
          {taskError && <div className="assistant-error" role="alert">{taskError}{taskStatus === 401 && <> <button className="link-button" type="button" onClick={goAccount}>Iniciar sessão</button></>}</div>}
          {tasks.length > 0 && <ul className="task-list">{tasks.map(t => <li key={t.id}><a href={t.url} target="_blank" rel="noopener noreferrer">{t.title}</a><small>{timeAgo(t.created_at)}</small></li>)}</ul>}
        </>}
      </article>
    </div>
  </section>
}
