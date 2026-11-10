import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ApiError } from '../../lib/http'
import { securityClient, type FirewallBlock, type FirewallEvent, type SecurityStatus, type TriageReport } from '../../lib/api'
import { timeAgo } from '../../lib/time'
import { AiIcon } from './shared'
import './Security.css'

const SEVERITY_LABEL: Record<TriageReport['severity'], string> = { baixa: 'Baixa', media: 'Média', alta: 'Alta', critica: 'Crítica' }

function StatCard({ icon, title, value, detail, tone }: { icon: string; title: string; value: string; detail: string; tone: 'ok' | 'warn' | 'muted' }) {
  return <article className={`aegis-panel sec-stat sec-stat--${tone}`}>
    <span className="sec-stat-icon"><AiIcon name={icon} size={20} /></span>
    <p className="eyebrow">{title}</p>
    <strong>{value}</strong>
    <small>{detail}</small>
  </article>
}

function AdminPanel({ onChange }: { onChange: () => void }) {
  const [events, setEvents] = useState<FirewallEvent[]>([])
  const [blocks, setBlocks] = useState<FirewallBlock[]>([])
  const [report, setReport] = useState<TriageReport | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [network, setNetwork] = useState('')
  const [reason, setReason] = useState('')
  const [minutes, setMinutes] = useState('1440')

  const load = useCallback(async () => {
    try {
      const [e, b] = await Promise.all([securityClient.events(), securityClient.blocks()])
      setEvents(e)
      setBlocks(b)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível carregar os eventos.')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label)
    setError('')
    try {
      await action()
      await load()
      onChange()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'A operação falhou.')
    } finally {
      setBusy('')
    }
  }

  const block = (event: FormEvent) => {
    event.preventDefault()
    void run('block', () => securityClient.addBlock(network.trim(), reason.trim(), minutes === 'forever' ? null : Number(minutes)).then(() => { setNetwork(''); setReason('') }))
  }

  const applyRecommendation = (target: string, why: string) => {
    if (!window.confirm(`Bloquear ${target} durante 24 h?\n\nMotivo (IA supervisora): ${why}`)) return
    void run(`rec-${target}`, () => securityClient.addBlock(target, `Recomendação da IA supervisora: ${why}`, 1440))
  }

  return <section className="sec-admin" aria-label="Administração de segurança">
    {error && <p className="assistant-error" role="alert">{error}</p>}

    <article className="aegis-panel sec-supervisor">
      <div className="panel-row">
        <div><p className="eyebrow">IA SUPERVISORA</p><h2>Triagem dos eventos das últimas 24 h</h2></div>
        <button className="button button-dark" type="button" disabled={!!busy} onClick={() => void run('triage', async () => setReport(await securityClient.triage()))}>
          <AiIcon name="spark" size={16} />{busy === 'triage' ? 'A analisar…' : 'Analisar com IA'}
        </button>
      </div>
      <p className="agency-note">A IA analisa padrões e propõe ações. Nada é aplicado sem a tua confirmação.</p>
      {report && <div className="sec-report" aria-live="polite">
        <div className="panel-row"><span className={`severity severity--${report.severity}`}>Severidade {SEVERITY_LABEL[report.severity]}</span><small className="agency-note">{report.events_analyzed} eventos · {report.model}</small></div>
        <p className="sec-report-summary">{report.summary}</p>
        {report.findings.length > 0 && <ol className="sec-findings">{report.findings.map(f => <li key={f.title}><strong>{f.title}</strong><span>{f.evidence}</span><em>{f.recommendation}</em></li>)}</ol>}
        {report.block_recommendations.length > 0 && <div className="sec-recs"><h3>Bloqueios recomendados</h3>
          {report.block_recommendations.map(r => <div key={r.network} className="sec-rec"><code>{r.network}</code><span>{r.reason}</span>
            <button className="button button-outline" type="button" disabled={!!busy || blocks.some(b => b.network.startsWith(r.network))} onClick={() => applyRecommendation(r.network, r.reason)}>Bloquear</button></div>)}
        </div>}
      </div>}
    </article>

    <div className="sec-admin-grid">
      <article className="aegis-panel">
        <div className="panel-row"><div><p className="eyebrow">BLOCKLIST</p><h2>Bloqueios ativos</h2></div>
          <button className="button button-quiet" type="button" disabled={!!busy} onClick={() => void run('feeds', securityClient.refreshFeeds)}><AiIcon name="retry" size={15} />{busy === 'feeds' ? 'A atualizar…' : 'Atualizar listas'}</button></div>
        <form className="agency-form sec-block-form" onSubmit={block}>
          <label htmlFor="block-net">IP ou rede (CIDR)</label>
          <input id="block-net" value={network} onChange={e => setNetwork(e.target.value)} placeholder="Ex.: 203.0.113.7 ou 198.51.100.0/24" maxLength={64} required />
          <label htmlFor="block-reason">Motivo</label>
          <input id="block-reason" value={reason} onChange={e => setReason(e.target.value)} minLength={3} maxLength={200} required />
          <label htmlFor="block-time">Duração</label>
          <select id="block-time" value={minutes} onChange={e => setMinutes(e.target.value)}>
            <option value="60">1 hora</option><option value="1440">24 horas</option><option value="10080">7 dias</option><option value="forever">Permanente</option>
          </select>
          <button className="button button-dark" type="submit" disabled={!!busy}>Bloquear</button>
        </form>
        {blocks.length === 0 ? <p className="agency-note">Sem bloqueios manuais ou automáticos ativos.</p> : <ul className="sec-block-list">
          {blocks.map(b => <li key={b.network}><div><code>{b.network}</code><small>{b.source === 'auto' ? 'Automático' : 'Manual'} · {b.reason}{b.expires_at ? ` · até ${new Date(b.expires_at).toLocaleString('pt-PT')}` : ' · permanente'}</small></div>
            <button className="button button-quiet" type="button" disabled={!!busy} onClick={() => void run(`rm-${b.network}`, () => securityClient.removeBlock(b.network))}>Desbloquear</button></li>)}
        </ul>}
      </article>

      <article className="aegis-panel">
        <div className="panel-row"><div><p className="eyebrow">REGISTO</p><h2>Pedidos bloqueados</h2></div><button className="button button-quiet" type="button" onClick={() => void load()}><AiIcon name="retry" size={15} />Atualizar</button></div>
        {events.length === 0 ? <p className="agency-note">Nenhum pedido bloqueado nas últimas 24 horas.</p> : <div className="sec-events" role="table" aria-label="Pedidos bloqueados">
          {events.slice(0, 60).map((e, i) => <div className="sec-event" role="row" key={`${e.at}-${i}`}>
            <span role="cell" className={`sec-code sec-code--${e.status}`}>{e.status}</span>
            <span role="cell"><strong>{e.label}</strong><small><code>{e.ip}</code> · {e.method} {e.path}</small></span>
            <time role="cell" dateTime={e.at}>{timeAgo(e.at)}</time>
          </div>)}
        </div>}
      </article>
    </div>
  </section>
}

export default function SecurityCenter() {
  const [status, setStatus] = useState<SecurityStatus | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    securityClient.status().then(s => { if (active) { setStatus(s); setError('') } })
      .catch(reason => { if (active) setError(reason instanceof ApiError || reason instanceof Error ? reason.message : 'Estado indisponível.') })
    securityClient.isAdmin().then(v => { if (active) setIsAdmin(v) }).catch(() => undefined)
    return () => { active = false }
  }, [reload])

  if (error) return <p className="assistant-error" role="alert">{error}</p>
  if (!status) return <div className="sec-stats" aria-hidden="true">{[0, 1, 2, 3].map(i => <div key={i} className="aegis-panel skeleton sec-stat" />)}</div>
  const fw = status.firewall
  const intel = fw.threat_intel
  const categories = Object.entries(fw.by_rule)
  const maxCount = Math.max(1, ...categories.map(([, n]) => n))

  return <section className="security-center" aria-label="Centro de segurança">
    <div className="sec-stats">
      <StatCard icon="shield" title="FIREWALL" value={fw.enabled ? 'Ativo' : 'Desligado'} tone={fw.enabled ? 'ok' : 'warn'} detail={`${fw.blocked_24h} pedidos bloqueados em 24 h`} />
      <StatCard icon="news" title="REPUTAÇÃO DE IP" value={intel.networks ? intel.networks.toLocaleString('pt-PT') : '—'} tone={intel.networks ? 'ok' : 'warn'}
        detail={intel.networks ? `redes maliciosas · ${Object.keys(intel.sources).length} fontes${intel.updated_at ? ` · ${timeAgo(intel.updated_at)}` : ''}` : intel.error ? 'Listas indisponíveis' : 'A carregar listas…'} />
      <StatCard icon="spark" title="IA SUPERVISORA" value={status.supervisor.enabled ? 'Ativa' : 'Desligada'} tone={status.supervisor.enabled ? 'ok' : 'muted'}
        detail={status.supervisor.enabled ? `Revê cada resposta do chat · ${status.supervisor.model}` : 'Requer ANTHROPIC_API_KEY no servidor'} />
      <StatCard icon="organize" title="LIMITES" value={`${fw.limits.requests_per_minute}/min`} tone="muted" detail={`por IP · banimento após ${fw.limits.ban_threshold} violações (${fw.limits.ban_minutes} min)`} />
    </div>

    <div className="sec-grid">
      <article className="aegis-panel">
        <p className="eyebrow">CAMADAS DE PROTEÇÃO</p>
        <h2>O que o firewall inspeciona</h2>
        <ul className="concept-chips sec-rules">{fw.rules.map(r => <li key={r}>{r}</li>)}</ul>
        <p className="agency-note">Cada pedido à API passa por: allowlist → blocklist e banimentos → reputação de IP → método e tamanho → assinaturas de ataque → limite de pedidos. O texto das mensagens não é inspecionado por assinaturas, para não bloquear conversas legítimas.</p>
        {Object.keys(intel.sources).length > 0 && <ul className="sec-sources">{Object.entries(intel.sources).map(([name, n]) => <li key={name}><span>{name}</span><b>{n.toLocaleString('pt-PT')}</b></li>)}</ul>}
        {intel.error && <p className="agency-note">Falhas na última atualização: {intel.error}</p>}
      </article>
      <article className="aegis-panel">
        <p className="eyebrow">ÚLTIMAS 24 HORAS</p>
        <h2>Bloqueios por categoria</h2>
        {categories.length === 0 ? <p className="agency-note">Nenhum ataque bloqueado nas últimas 24 horas.</p> : <ul className="sec-bars">
          {categories.map(([label, n]) => <li key={label}><span>{label}</span><i style={{ width: `${(n / maxCount) * 100}%` }} /><b>{n}</b></li>)}
        </ul>}
      </article>
    </div>

    {isAdmin ? <AdminPanel onChange={() => setReload(n => n + 1)} /> : <p className="ai-setup-note">
      {status.admin_configured ? 'Os registos detalhados, a blocklist e a triagem por IA estão disponíveis para administradores de segurança.' : <>Para gerir o firewall e usar a triagem por IA, define <code>SECURITY_ADMIN_EMAILS</code> no servidor com o teu email verificado e inicia sessão.</>}
    </p>}
  </section>
}
