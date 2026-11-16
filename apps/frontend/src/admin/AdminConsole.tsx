import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AdminError, adminClient } from './adminClient'
import type { Approval, AuditItem, Me, Overview, Posture, RoleInfo } from './adminClient'
import './admin.css'

type Section = 'overview' | 'users' | 'approvals' | 'roles' | 'audit' | 'security'

const SECTIONS: { id: Section; label: string; perm?: string }[] = [
  { id: 'overview', label: 'Visão geral', perm: 'users.read' },
  { id: 'users', label: 'Utilizadores', perm: 'users.read' },
  { id: 'approvals', label: 'Aprovações', perm: 'users.read' },
  { id: 'roles', label: 'Funções e permissões' },
  { id: 'audit', label: 'Registo de auditoria', perm: 'audit.read' },
  { id: 'security', label: 'Postura de segurança', perm: 'security.read' },
]

const ROLE_LABEL: Record<string, string> = {
  owner: 'Proprietário',
  admin: 'Administrador',
  security_analyst: 'Analista de segurança',
  support: 'Suporte',
  auditor: 'Auditor',
}

const ACTION_LABEL: Record<string, string> = {
  'user.suspend': 'Conta suspensa',
  'user.reactivate': 'Conta reativada',
  'user.revoke_sessions': 'Sessões revogadas',
  'user.roles': 'Funções alteradas',
  'approval.request': 'Elevação pedida',
  'approval.decide': 'Pedido decidido',
  'audit.export': 'Auditoria exportada',
  'audit.verify': 'Integridade verificada',
  'admin.access': 'Acesso à consola',
  'admin.permission': 'Permissão em falta',
  'admin.bootstrap_owner': 'Primeiro proprietário',
  'admin.rate_limited': 'Limite de ritmo',
}

const STATUS_LABEL: Record<Approval['status'], string> = { pending: 'Pendente', approved: 'Aprovado', rejected: 'Rejeitado', expired: 'Expirado' }

const fmtDate = (ts: number | null) =>
  ts ? new Intl.DateTimeFormat('pt-PT', { dateStyle: 'short', timeStyle: 'medium' }).format(ts * 1000) : '—'
const shortId = (id: string | null) => (id ? id.slice(0, 8) : '—')
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

function sectionFromHash(): Section {
  const part = location.hash.replace(/^#admin\/?/, '')
  return (SECTIONS.find((s) => s.id === part)?.id ?? 'overview') as Section
}

// ---- Componentes base ---------------------------------------------------------

function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`adm-badge adm-${tone}`}>{children}</span>
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="adm-empty">{children}</div>
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const reload = useCallback(() => {
    setBusy(true)
    load()
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Erro inesperado.'))
      .finally(() => setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(reload, [reload])
  return { data, error, busy, reload }
}

interface ConfirmSpec {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  typeToConfirm?: string
  run: (reason: string) => Promise<unknown>
}

/** Diálogo com justificação obrigatória (fica no registo de auditoria). */
function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec; onClose: (done: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  const ready = reason.trim().length >= 10 && (!spec.typeToConfirm || typed === spec.typeToConfirm)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    try {
      await spec.run(reason.trim())
      onClose(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falhou.')
      setBusy(false)
    }
  }
  return (
    <dialog ref={ref} className="adm-dialog" onCancel={() => onClose(false)} aria-labelledby="adm-dialog-title">
      <form onSubmit={submit}>
        <h2 id="adm-dialog-title">{spec.title}</h2>
        <p>{spec.body}</p>
        <label>
          <span>Justificação <small>(obrigatória, mínimo 10 caracteres — fica na auditoria)</small></span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} required autoFocus placeholder="Ex.: Ticket SEC-1234 — conta comprometida" />
        </label>
        {spec.typeToConfirm && (
          <label>
            <span>Escreve <b>{spec.typeToConfirm}</b> para confirmar</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        )}
        {error && <p className="adm-error" role="alert">{error}</p>}
        <div className="adm-dialog-actions">
          <button type="button" className="adm-btn" onClick={() => onClose(false)}>Cancelar</button>
          <button type="submit" className={spec.danger ? 'adm-btn adm-btn-danger' : 'adm-btn adm-btn-primary'} disabled={!ready || busy}>
            {busy ? 'A aplicar…' : spec.confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  )
}

// ---- Secções ------------------------------------------------------------------

function OverviewView({ go }: { go: (s: Section) => void }) {
  const { data, error } = useLoad<Overview>(() => adminClient.overview(), [])
  if (error) return <p className="adm-error">{error}</p>
  if (!data) return <p className="adm-muted" role="status">A carregar…</p>
  const kpis = [
    { label: 'Utilizadores', value: data.users_total, hint: `${data.users_active_24h} ativos em 24 h` },
    { label: 'Com passkey', value: data.users_with_passkey, hint: data.users_total ? `${Math.round((100 * data.users_with_passkey) / data.users_total)}% da base` : '—' },
    { label: 'Suspensos', value: data.users_suspended, hint: 'Sessões invalidadas' },
    { label: 'Aprovações pendentes', value: data.approvals_pending, hint: 'Regra das duas pessoas', action: () => go('approvals') },
    { label: 'Eventos 24 h', value: data.audit_events_24h, hint: `${data.denied_24h} negados` },
  ]
  return (
    <>
      <div className="adm-kpis">
        {kpis.map((k) => (
          <button key={k.label} type="button" className="adm-kpi" onClick={k.action} disabled={!k.action}>
            <span>{k.label}</span>
            <strong>{k.value.toLocaleString('pt-PT')}</strong>
            <small>{k.hint}</small>
          </button>
        ))}
      </div>
      <div className="adm-grid-2">
        <section className="adm-card">
          <header><h3>Integridade da auditoria</h3>{data.audit_chain.valid ? <Badge tone="ok">Íntegra</Badge> : <Badge tone="bad">Adulterada</Badge>}</header>
          <p className="adm-muted">
            {data.audit_chain.valid
              ? `${data.audit_chain.checked} entradas encadeadas por HMAC-SHA256 verificadas.`
              : `Cadeia quebrada na entrada #${data.audit_chain.broken_at}. Trata como incidente.`}
          </p>
          <h4>Equipa por função</h4>
          <ul className="adm-bars">
            {Object.entries(data.staff).map(([role, n]) => (
              <li key={role}><span>{ROLE_LABEL[role] ?? role}</span><b>{n}</b></li>
            ))}
          </ul>
        </section>
        <section className="adm-card">
          <header><h3>Atividade recente</h3><button type="button" className="adm-link" onClick={() => go('audit')}>Ver tudo</button></header>
          <AuditTable items={data.recent} compact />
        </section>
      </div>
    </>
  )
}

function AuditTable({ items, compact = false }: { items: AuditItem[]; compact?: boolean }) {
  if (!items.length) return <Empty>Sem eventos.</Empty>
  return (
    <div className="adm-table-wrap">
      <table className="adm-table">
        <thead>
          <tr>
            <th>#</th><th>Quando</th><th>Ação</th><th>Resultado</th><th>Ator</th><th>Alvo</th>
            {!compact && <><th>IP</th><th>Justificação</th></>}
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.seq}>
              <td className="adm-mono">{e.seq}</td>
              <td>{fmtDate(e.ts)}</td>
              <td title={e.action}>{ACTION_LABEL[e.action] ?? e.action}</td>
              <td><Badge tone={e.outcome === 'success' ? 'ok' : e.outcome === 'denied' ? 'warn' : 'bad'}>{e.outcome === 'success' ? 'sucesso' : e.outcome === 'denied' ? 'negado' : 'erro'}</Badge></td>
              <td className="adm-mono">{shortId(e.actor_id)}</td>
              <td className="adm-mono">{shortId(e.target)}</td>
              {!compact && <><td className="adm-mono">{e.ip ?? '—'}</td><td className="adm-reason">{e.reason ?? ''}</td></>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function UsersView({ me, roles, onConfirm }: { me: Me; roles: RoleInfo[]; onConfirm: (s: ConfirmSpec) => Promise<boolean> }) {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [role, setRole] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string | null>(null)
  const list = useLoad(() => adminClient.users({ q: query, role, status, page }), [query, role, status, page])
  useEffect(() => {
    const t = window.setTimeout(() => { setQuery(q); setPage(1) }, 300)
    return () => window.clearTimeout(t)
  }, [q])
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.page_size)) : 1
  return (
    <div className={selected ? 'adm-split' : ''}>
      <section className="adm-card">
        <div className="adm-toolbar">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar por nome, email ou ID" aria-label="Procurar utilizadores" />
          <select value={role} onChange={(e) => { setRole(e.target.value); setPage(1) }} aria-label="Filtrar por função">
            <option value="">Todas as funções</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="Filtrar por estado">
            <option value="">Todos os estados</option>
            <option value="active">Ativos</option>
            <option value="suspended">Suspensos</option>
          </select>
          <span className="adm-muted">{list.data ? `${list.data.total} resultados` : ''}</span>
        </div>
        {list.error && <p className="adm-error">{list.error}</p>}
        {list.data && (list.data.items.length ? (
          <div className="adm-table-wrap">
            <table className="adm-table adm-clickable">
              <thead><tr><th>Utilizador</th><th>Funções</th><th>Estado</th><th>MFA</th><th>Último acesso</th></tr></thead>
              <tbody>
                {list.data.items.map((u) => (
                  <tr key={u.id} className={selected === u.id ? 'adm-selected' : ''} onClick={() => setSelected(u.id)} onKeyDown={(e) => { if (e.key === 'Enter') setSelected(u.id) }} tabIndex={0}>
                    <td><b>{u.name ?? 'Sem nome'}</b><small className="adm-block adm-muted">{u.email ?? shortId(u.id)}</small></td>
                    <td>{u.roles.length ? u.roles.map((r) => <Badge key={r} tone="info">{ROLE_LABEL[r] ?? r}</Badge>) : <span className="adm-muted">—</span>}</td>
                    <td>{u.status === 'active' ? <Badge tone="ok">Ativo</Badge> : <Badge tone="bad">Suspenso</Badge>}</td>
                    <td>{u.mfa ? <Badge tone="ok">Passkey</Badge> : <Badge tone="warn">Sem MFA</Badge>}</td>
                    <td>{fmtDate(u.last_login_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Nenhum utilizador corresponde aos filtros.</Empty>)}
        <div className="adm-pager">
          <button type="button" className="adm-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <span>Página {page} de {pages}</span>
          <button type="button" className="adm-btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>Seguinte</button>
        </div>
      </section>
      {selected && <UserDrawer key={selected} id={selected} me={me} roles={roles} onClose={() => setSelected(null)} onChanged={list.reload} onConfirm={onConfirm} />}
    </div>
  )
}

function UserDrawer({ id, me, roles, onClose, onChanged, onConfirm }: { id: string; me: Me; roles: RoleInfo[]; onClose: () => void; onChanged: () => void; onConfirm: (s: ConfirmSpec) => Promise<boolean> }) {
  const detail = useLoad(() => adminClient.user(id), [id])
  const [draft, setDraft] = useState<string[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const can = (p: string) => me.permissions.includes(p)
  const u = detail.data?.user
  if (detail.error) return <aside className="adm-card adm-drawer"><p className="adm-error">{detail.error}</p></aside>
  if (!u) return <aside className="adm-card adm-drawer"><p className="adm-muted">A carregar…</p></aside>
  const self = u.id === me.id
  const privilegedTarget = u.roles.some((r) => r === 'owner' || r === 'admin')
  const blocked = self || (privilegedTarget && !me.roles.includes('owner'))
  const after = (msg: string) => async (done: boolean) => {
    if (!done) return
    setNotice(msg)
    detail.reload()
    onChanged()
  }
  const roleDraft = draft ?? u.roles
  const toggle = (r: string) => setDraft(roleDraft.includes(r) ? roleDraft.filter((x) => x !== r) : [...roleDraft, r])
  const dirty = draft !== null && [...draft].sort().join() !== [...u.roles].sort().join()

  return (
    <aside className="adm-card adm-drawer" aria-label="Detalhes do utilizador">
      <header>
        <div>
          <h3>{u.name ?? 'Sem nome'}</h3>
          <p className="adm-muted adm-mono">{u.id}</p>
        </div>
        <button type="button" className="adm-icon-btn" onClick={onClose} aria-label="Fechar detalhes">×</button>
      </header>
      {notice && <p className="adm-notice" role="status">{notice}</p>}
      <dl className="adm-dl">
        <dt>Email</dt><dd>{u.email ?? '—'}</dd>
        <dt>Estado</dt><dd>{u.status === 'active' ? <Badge tone="ok">Ativo</Badge> : <Badge tone="bad">Suspenso</Badge>}</dd>
        <dt>Métodos</dt><dd>{u.methods.join(', ') || '—'}</dd>
        <dt>Passkeys</dt><dd>{u.passkeys}</dd>
        <dt>Criado</dt><dd>{fmtDate(u.created_at)}</dd>
        <dt>Último acesso</dt><dd>{fmtDate(u.last_login_at)}</dd>
      </dl>

      {blocked && <p className="adm-muted">{self ? 'Não podes alterar a tua própria conta (separação de funções).' : 'Só um proprietário pode alterar contas privilegiadas.'}</p>}

      {!blocked && (
        <div className="adm-actions">
          {can('users.revoke_sessions') && (
            <button type="button" className="adm-btn" onClick={() => onConfirm({
              title: 'Revogar todas as sessões',
              body: 'Termina de imediato todas as sessões ativas desta conta em todos os dispositivos.',
              confirmLabel: 'Revogar sessões',
              run: (reason) => adminClient.revokeSessions(u.id, reason),
            }).then(after('Sessões revogadas.'))}>Revogar sessões</button>
          )}
          {can('users.suspend') && (u.status === 'active' ? (
            <button type="button" className="adm-btn adm-btn-danger" onClick={() => onConfirm({
              title: 'Suspender conta',
              body: 'A conta deixa de conseguir iniciar sessão e todas as sessões terminam já.',
              confirmLabel: 'Suspender',
              danger: true,
              typeToConfirm: 'SUSPENDER',
              run: (reason) => adminClient.suspend(u.id, reason),
            }).then(after('Conta suspensa.'))}>Suspender</button>
          ) : (
            <button type="button" className="adm-btn adm-btn-primary" onClick={() => onConfirm({
              title: 'Reativar conta',
              body: 'A pessoa volta a poder iniciar sessão.',
              confirmLabel: 'Reativar',
              run: (reason) => adminClient.reactivate(u.id, reason),
            }).then(after('Conta reativada.'))}>Reativar</button>
          ))}
        </div>
      )}

      {!blocked && can('roles.assign') && (
        <section>
          <h4>Funções</h4>
          <ul className="adm-checks">
            {roles.map((r) => (
              <li key={r.id}>
                <label>
                  <input type="checkbox" checked={roleDraft.includes(r.id)} onChange={() => toggle(r.id)} disabled={r.privileged && !can('roles.request_privileged')} />
                  <span><b>{r.label}</b>{r.privileged && <Badge tone="warn">privilegiada</Badge>}<small className="adm-block adm-muted">{r.description}</small></span>
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="adm-btn adm-btn-primary" disabled={!dirty} onClick={() => onConfirm({
            title: 'Alterar funções',
            body: 'Funções privilegiadas (Proprietário, Administrador) ficam pendentes até outro proprietário aprovar. A pessoa terá de iniciar sessão de novo.',
            confirmLabel: 'Aplicar',
            run: async (reason) => {
              const r = await adminClient.setRoles(u.id, roleDraft, reason)
              if (r.pending_approvals.length) setNotice(`${r.pending_approvals.length} pedido(s) de elevação aguardam segunda aprovação.`)
            },
          }).then(async (done) => { if (done) { setDraft(null); detail.reload(); onChanged() } })}>Guardar funções</button>
        </section>
      )}

      <h4>Histórico desta conta</h4>
      <AuditTable items={detail.data?.history ?? []} compact />
    </aside>
  )
}

function ApprovalsView({ me, onConfirm }: { me: Me; onConfirm: (s: ConfirmSpec) => Promise<boolean> }) {
  const { data, error, reload } = useLoad(() => adminClient.approvals(), [])
  const canDecide = me.permissions.includes('approvals.decide')
  if (error) return <p className="adm-error">{error}</p>
  if (!data) return <p className="adm-muted">A carregar…</p>
  const tone = (s: Approval['status']) => (s === 'approved' ? 'ok' : s === 'pending' ? 'info' : s === 'rejected' ? 'bad' : 'neutral')
  return (
    <section className="adm-card">
      <p className="adm-muted">Dar uma função privilegiada exige o pedido de uma pessoa e a aprovação de outro proprietário. Os pedidos expiram em 24 h.</p>
      {data.items.length ? (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead><tr><th>Pedido</th><th>Função</th><th>Alvo</th><th>Pedido por</th><th>Justificação</th><th>Estado</th><th /></tr></thead>
            <tbody>
              {data.items.map((a) => {
                const own = a.requested_by === me.id || a.target_user_id === me.id
                return (
                  <tr key={a.id}>
                    <td>{fmtDate(a.created_at)}</td>
                    <td><Badge tone="warn">{ROLE_LABEL[a.role] ?? a.role}</Badge></td>
                    <td className="adm-mono">{shortId(a.target_user_id)}</td>
                    <td className="adm-mono">{shortId(a.requested_by)}</td>
                    <td className="adm-reason">{a.reason}</td>
                    <td><Badge tone={tone(a.status)}>{STATUS_LABEL[a.status]}</Badge></td>
                    <td className="adm-row-actions">
                      {a.status === 'pending' && canDecide && (own ? <small className="adm-muted">Precisa de outra pessoa</small> : <>
                        <button type="button" className="adm-btn adm-btn-primary" onClick={() => onConfirm({
                          title: `Aprovar ${ROLE_LABEL[a.role] ?? a.role}`,
                          body: 'A conta recebe a função de imediato e terá de iniciar sessão de novo.',
                          confirmLabel: 'Aprovar',
                          typeToConfirm: 'APROVAR',
                          run: (note) => adminClient.decide(a.id, true, note),
                        }).then((d) => d && reload())}>Aprovar</button>
                        <button type="button" className="adm-btn" onClick={() => onConfirm({
                          title: 'Rejeitar pedido',
                          body: 'O pedido fica fechado e registado.',
                          confirmLabel: 'Rejeitar',
                          danger: true,
                          run: (note) => adminClient.decide(a.id, false, note),
                        }).then((d) => d && reload())}>Rejeitar</button>
                      </>)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : <Empty>Sem pedidos de elevação.</Empty>}
    </section>
  )
}

function RolesView({ roles, twoPerson }: { roles: RoleInfo[]; twoPerson: boolean }) {
  const perms = useMemo(() => [...new Set(roles.flatMap((r) => r.permissions))].sort(), [roles])
  return (
    <section className="adm-card">
      <header><h3>Matriz de permissões</h3>{twoPerson ? <Badge tone="ok">Regra das duas pessoas ativa</Badge> : <Badge tone="bad">Regra das duas pessoas desligada</Badge>}</header>
      <div className="adm-table-wrap">
        <table className="adm-table adm-matrix">
          <thead><tr><th>Permissão</th>{roles.map((r) => <th key={r.id}>{r.label}<small className="adm-block adm-muted">{r.members} membro(s)</small></th>)}</tr></thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p}><td className="adm-mono">{p}</td>{roles.map((r) => <td key={r.id} className="adm-center">{r.permissions.includes(p) ? <span className="adm-yes" aria-label="sim">●</span> : <span className="adm-no" aria-label="não">·</span>}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function AuditView({ me }: { me: Me }) {
  const [outcome, setOutcome] = useState('')
  const [action, setAction] = useState('')
  const { data, error, reload } = useLoad(() => adminClient.audit({ outcome, action }), [outcome, action])
  const [chain, setChain] = useState<string | null>(null)
  const [exportErr, setExportErr] = useState<string | null>(null)
  const verify = async () => {
    try {
      const r = await adminClient.verifyAudit()
      setChain(r.valid ? `Íntegra: ${r.checked} entradas verificadas.` : `ADULTERADA na entrada #${r.broken_at}.`)
      reload()
    } catch (e) {
      setChain(e instanceof Error ? e.message : 'Falhou.')
    }
  }
  return (
    <section className="adm-card">
      <div className="adm-toolbar">
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filtrar por ação">
          <option value="">Todas as ações</option>
          <option value="user.">Contas</option>
          <option value="approval.">Aprovações</option>
          <option value="admin.">Acesso à consola</option>
          <option value="audit.">Auditoria</option>
        </select>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Filtrar por resultado">
          <option value="">Todos os resultados</option>
          <option value="success">Sucesso</option>
          <option value="denied">Negado</option>
        </select>
        <span className="adm-spacer" />
        <button type="button" className="adm-btn" onClick={verify}>Verificar integridade</button>
        {me.permissions.includes('audit.export') && (
          <button type="button" className="adm-btn adm-btn-primary" onClick={() => adminClient.exportAudit().catch((e: Error) => setExportErr(e.message))}>Exportar CSV</button>
        )}
      </div>
      {chain && <p className="adm-notice" role="status">{chain}</p>}
      {(error || exportErr) && <p className="adm-error">{error ?? exportErr}</p>}
      {data && <AuditTable items={data.items} />}
    </section>
  )
}

const REMEDIATION: Record<string, string> = {
  env_production: 'Define ENV=production no servidor.',
  passkey_required: 'Não desligues ADMIN_REQUIRE_PASSKEY.',
  two_person_rule: 'Define ADMIN_TWO_PERSON_RULE=true.',
  ip_allowlist: 'Define ADMIN_IP_ALLOWLIST com a rede da empresa ou VPN (CIDR).',
  audit_key: 'Define AUDIT_HMAC_KEY (segredo longo e aleatório) para a cadeia sobreviver a reinícios.',
  audit_export: 'Define AUDIT_LOG_PATH e envia o ficheiro para um SIEM ou armazenamento imutável.',
  short_admin_sessions: 'Mantém ADMIN_SESSION_MAX_AGE em 3600 segundos ou menos.',
  multiple_owners: 'Nomeia um segundo proprietário para não depender de uma só pessoa.',
}

function SecurityView() {
  const { data, error } = useLoad<Posture>(() => adminClient.posture(), [])
  if (error) return <p className="adm-error">{error}</p>
  if (!data) return <p className="adm-muted">A carregar…</p>
  const tone = data.score >= 85 ? 'ok' : data.score >= 60 ? 'warn' : 'bad'
  return (
    <div className="adm-grid-2">
      <section className="adm-card adm-score">
        <div className={`adm-ring adm-ring-${tone}`} style={{ ['--p' as string]: `${data.score}` }}><strong>{data.score}</strong><span>/100</span></div>
        <p className="adm-muted">Pontuação dos controlos da administração. Cada controlo em falta tem a correção ao lado.</p>
      </section>
      <section className="adm-card">
        <ul className="adm-posture">
          {data.checks.map((c) => (
            <li key={c.id}>
              {c.ok ? <Badge tone="ok">OK</Badge> : <Badge tone="bad">Falta</Badge>}
              <div><b>{c.label}</b>{!c.ok && <small className="adm-block adm-muted">{REMEDIATION[c.id]}</small>}</div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

// ---- Consola ------------------------------------------------------------------

export default function AdminConsole() {
  const [section, setSection] = useState<Section>(sectionFromHash)
  const [me, setMe] = useState<Me | null>(null)
  const [fatal, setFatal] = useState<{ status: number; message: string } | null>(null)
  const [roles, setRoles] = useState<RoleInfo[]>([])
  const [twoPerson, setTwoPerson] = useState(true)
  const [remaining, setRemaining] = useState(0)
  const [stepUp, setStepUp] = useState(0)
  const [confirm, setConfirm] = useState<{ spec: ConfirmSpec; resolve: (d: boolean) => void } | null>(null)

  useEffect(() => {
    Promise.all([adminClient.me(), adminClient.roles()])
      .then(([m, r]) => {
        setMe(m)
        setRoles(r.roles)
        setTwoPerson(r.two_person_rule)
        setRemaining(m.session_expires_in)
        setStepUp(m.step_up_valid_for)
      })
      .catch((e: unknown) => setFatal(e instanceof AdminError ? { status: e.status, message: e.message } : { status: 0, message: 'Sem ligação à API.' }))
  }, [])

  useEffect(() => {
    if (!me) return
    const t = window.setInterval(() => {
      setRemaining((s) => Math.max(0, s - 1))
      setStepUp((s) => Math.max(0, s - 1))
    }, 1000)
    return () => window.clearInterval(t)
  }, [me])

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (s: Section) => window.location.assign(`#admin/${s}`)
  const onConfirm = (spec: ConfirmSpec) => new Promise<boolean>((resolve) => setConfirm({ spec, resolve }))

  if (fatal) {
    const msg = fatal.status === 401
      ? 'Inicia sessão para aceder à administração.'
      : fatal.status === 404
        ? 'Esta conta não tem acesso à administração.'
        : fatal.message
    return (
      <main className="adm-gate">
        <div className="adm-card">
          <p className="adm-eyebrow">Aegis · Administração</p>
          <h1>Acesso restrito</h1>
          <p>{msg}</p>
          {fatal.status === 403 && <p className="adm-muted">Os administradores entram com chave de acesso (passkey), a partir de redes autorizadas.</p>}
          <a className="adm-btn adm-btn-primary" href="#account">Ir para a conta</a>
        </div>
      </main>
    )
  }
  if (!me) return <main className="adm-gate"><p className="adm-muted" role="status">A verificar acesso…</p></main>

  const visible = SECTIONS.filter((s) => !s.perm || me.permissions.includes(s.perm))
  const current = visible.find((s) => s.id === section) ?? visible[0]
  const env = import.meta.env.MODE === 'production' ? 'Produção' : 'Desenvolvimento'

  return (
    <div className="adm">
      <aside className="adm-side">
        <a className="adm-brand" href="#overview">Λ <span>AEGIS</span> <small>Admin</small></a>
        <nav aria-label="Administração">
          {visible.map((s) => (
            <button key={s.id} type="button" className={current?.id === s.id ? 'adm-nav adm-nav-on' : 'adm-nav'} aria-current={current?.id === s.id ? 'page' : undefined} onClick={() => go(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="adm-side-foot">
          <span>{me.name ?? shortId(me.id)}</span>
          <div>{me.roles.map((r) => <Badge key={r} tone="info">{ROLE_LABEL[r] ?? r}</Badge>)}</div>
        </div>
      </aside>
      <div className="adm-main">
        <header className="adm-top">
          <div>
            <p className="adm-eyebrow">Administração</p>
            <h1>{current?.label}</h1>
          </div>
          <div className="adm-top-meta">
            <Badge tone={env === 'Produção' ? 'bad' : 'info'}>{env}</Badge>
            <Badge tone={stepUp > 0 ? 'ok' : 'warn'}>{stepUp > 0 ? `Alterações permitidas · ${mmss(stepUp)}` : 'Só leitura · reautentica para alterar'}</Badge>
            <Badge tone={remaining > 300 ? 'neutral' : 'warn'}>Sessão {mmss(remaining)}</Badge>
          </div>
        </header>
        {remaining === 0 && <p className="adm-error" role="alert">A sessão de administração expirou. <a href="#account">Inicia sessão de novo</a>.</p>}
        <div className="adm-content">
          {current?.id === 'overview' && <OverviewView go={go} />}
          {current?.id === 'users' && <UsersView me={me} roles={roles} onConfirm={onConfirm} />}
          {current?.id === 'approvals' && <ApprovalsView me={me} onConfirm={onConfirm} />}
          {current?.id === 'roles' && <RolesView roles={roles} twoPerson={twoPerson} />}
          {current?.id === 'audit' && <AuditView me={me} />}
          {current?.id === 'security' && <SecurityView />}
        </div>
      </div>
      {confirm && <ConfirmDialog spec={confirm.spec} onClose={(done) => { confirm.resolve(done); setConfirm(null) }} />}
    </div>
  )
}
