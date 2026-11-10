import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { ApiError } from '../../lib/http'
import { aiApi, buildMarketContext, type NewsArticle, type Quote } from '../../lib/aiApi'
import { DECISION_CHECKS, summarizeDecision } from '../../lib/decision'
import { DEFAULT_WATCHLIST, parseWatchlist, sizePosition, type PositionInput } from '../../lib/trading'
import { AiIcon } from './shared'
import type { ChatSeed } from './ChatView'

type OpenChat = (seed: Omit<ChatSeed, 'id'>) => void

const fmt = (value: number | null, digits = 2) => (value == null ? '—' : value.toLocaleString('pt-PT', { minimumFractionDigits: digits, maximumFractionDigits: digits }))

function Watchlist({ onAnalyze }: { onAnalyze: (quotes: Quote[], symbol?: string) => void }) {
  const [raw, setRaw] = useState(DEFAULT_WATCHLIST.join(', '))
  const [symbols, setSymbols] = useState<string[]>(DEFAULT_WATCHLIST)
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [missing, setMissing] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (list: string[]) => {
    setLoading(true)
    setError('')
    try {
      const feed = await aiApi.getQuotes(list)
      setQuotes(feed.quotes)
      setMissing(feed.missing)
      setNotice(feed.notice)
      setStatus(null)
    } catch (reason) {
      setQuotes([])
      setError(reason instanceof Error ? reason.message : 'Não foi possível obter cotações.')
      setStatus(reason instanceof ApiError ? reason.status : null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(symbols) }, [symbols, load])
  useEffect(() => {
    if (status === 503) return
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(symbols) }, 60_000)
    return () => window.clearInterval(timer)
  }, [symbols, load, status])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseWatchlist(raw)
    if (parsed.length) setSymbols(parsed)
  }

  return <article className="aegis-panel trade-watchlist">
    <div className="panel-row">
      <div><p className="eyebrow">COTAÇÕES</p><h2>Lista de acompanhamento</h2></div>
      <button className="button button-quiet" type="button" onClick={() => void load(symbols)} disabled={loading}><AiIcon name="retry" size={15} />{loading ? 'A atualizar…' : 'Atualizar'}</button>
    </div>
    <form className="inline-form" onSubmit={submit}>
      <label htmlFor="watchlist" className="sr-only">Símbolos</label>
      <input id="watchlist" value={raw} onChange={e => setRaw(e.target.value)} placeholder="AAPL, MSFT, BINANCE:BTCUSDT" maxLength={200} />
      <button className="button button-outline" type="submit">Aplicar</button>
    </form>
    {error && <div className={status === 503 ? 'ai-setup-note' : 'assistant-error'} role="alert">{error}{status === 503 && <> Define <code>FINNHUB_API_KEY</code> (plano gratuito disponível em finnhub.io).</>}</div>}
    {quotes.length > 0 && <div className="quote-table" role="table" aria-label="Cotações">
      <div className="quote-row quote-head" role="row"><span role="columnheader">Símbolo</span><span role="columnheader">Preço</span><span role="columnheader">Variação</span><span role="columnheader">Intervalo do dia</span><span role="columnheader"><span className="sr-only">Ações</span></span></div>
      {quotes.map(q => {
        const up = (q.change_percent ?? 0) >= 0
        return <div className="quote-row" role="row" key={q.symbol}>
          <strong role="cell">{q.symbol}</strong>
          <span role="cell" className="num">{fmt(q.price)}</span>
          <span role="cell" className={`num chip ${up ? 'chip--up' : 'chip--down'}`}>{q.change_percent == null ? '—' : `${up ? '▲' : '▼'} ${fmt(Math.abs(q.change_percent))}%`}</span>
          <span role="cell" className="range">
            <span className="range-bar" style={{ '--pos': q.high != null && q.low != null && q.price != null && q.high > q.low ? `${((q.price - q.low) / (q.high - q.low)) * 100}%` : '50%' } as CSSProperties}><i /></span>
            <small>{fmt(q.low)} – {fmt(q.high)}</small>
          </span>
          <span role="cell"><button className="link-button" type="button" onClick={() => onAnalyze(quotes, q.symbol)}>Analisar com IA</button></span>
        </div>
      })}
    </div>}
    {missing.length > 0 && <p className="agency-note">Sem dados para: {missing.join(', ')}.</p>}
    {notice && <p className="agency-note">{notice}</p>}
    {quotes.length > 0 && <button className="button button-dark" type="button" onClick={() => onAnalyze(quotes)}><AiIcon name="spark" size={16} />Análise IA da lista completa</button>}
  </article>
}

function RiskCalculator() {
  const [form, setForm] = useState({ capital: '10000', riskPercent: '1', entry: '50', stop: '48', target: '56', side: 'long' as PositionInput['side'] })
  const value = (key: keyof typeof form) => (key === 'side' ? form.side : Number(form[key].replace(',', '.')))
  const result = sizePosition({
    capital: value('capital') as number, riskPercent: value('riskPercent') as number,
    entry: value('entry') as number, stop: value('stop') as number,
    ...(form.target.trim() ? { target: value('target') as number } : {}), side: form.side,
  })
  const field = (key: Exclude<keyof typeof form, 'side'>, label: string, suffix = '') => <label className="calc-field">
    <span>{label}</span>
    <span className="calc-input"><input inputMode="decimal" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />{suffix && <i>{suffix}</i>}</span>
  </label>

  return <article className="aegis-panel risk-calc">
    <p className="eyebrow">GESTÃO DE RISCO</p>
    <h2>Calculadora de posição</h2>
    <div className="segmented" role="radiogroup" aria-label="Direção">
      {(['long', 'short'] as const).map(side => <button key={side} type="button" role="radio" aria-checked={form.side === side} className={form.side === side ? 'selected' : ''} onClick={() => setForm(f => ({ ...f, side }))}>{side === 'long' ? 'Compra (long)' : 'Venda (short)'}</button>)}
    </div>
    <div className="calc-grid">
      {field('capital', 'Capital', '€')}
      {field('riskPercent', 'Risco por operação', '%')}
      {field('entry', 'Entrada')}
      {field('stop', 'Stop-loss')}
      {field('target', 'Objetivo (opcional)')}
    </div>
    {result.ok ? <div className="calc-result" aria-live="polite">
      <div><span>Quantidade</span><strong>{result.units.toLocaleString('pt-PT')}</strong></div>
      <div><span>Valor da posição</span><strong>{fmt(result.positionValue)} €</strong></div>
      <div><span>Perda máxima</span><strong className="neg">{fmt(result.maxLoss)} €</strong></div>
      <div><span>Ganho/risco</span><strong>{result.rewardRisk == null ? '—' : `${fmt(result.rewardRisk, 1)} : 1`}</strong></div>
      {result.warnings.map(w => <p key={w} className="calc-warning">{w}</p>)}
    </div> : <p className="assistant-error" role="alert">{result.error}</p>}
    <p className="agency-note">Cálculo local e educativo. Não considera comissões, gaps nem liquidez.</p>
  </article>
}

function DecisionChecklist() {
  const [checked, setChecked] = useState<string[]>([])
  const summary = summarizeDecision(checked)
  return <article className="aegis-panel decision-panel" aria-labelledby="decision-title">
    <div className="decision-head">
      <div><p className="eyebrow">ANTES DE DECIDIR</p><h2 id="decision-title">Lista de decisão segura</h2><p>Marca o que confirmaste antes de investir, pagar ou partilhar.</p></div>
      <div className={`decision-meter decision-meter--${summary.level}`} role="img" aria-label={`${summary.done} de ${summary.total} verificações`} style={{ '--progress': `${summary.percent}%` } as CSSProperties}>
        <strong>{summary.done}<small>/{summary.total}</small></strong>
      </div>
    </div>
    <ul className="decision-list">
      {DECISION_CHECKS.map(check => <li key={check.id}>
        <label className={checked.includes(check.id) ? 'decision-item checked' : 'decision-item'}>
          <input type="checkbox" checked={checked.includes(check.id)} onChange={e => setChecked(c => e.target.checked ? [...c, check.id] : c.filter(id => id !== check.id))} />
          <span><strong>{check.title}</strong><small>{check.text}</small></span>
        </label>
      </li>)}
    </ul>
    <div className={`decision-result decision-result--${summary.level}`} role="status"><strong>{summary.title}</strong><p>{summary.advice}</p></div>
  </article>
}

export default function TradingView({ openChat }: { openChat: OpenChat }) {
  const [question, setQuestion] = useState('')
  const [headlines, setHeadlines] = useState<NewsArticle[]>([])
  const [lastQuotes, setLastQuotes] = useState<Quote[]>([])

  useEffect(() => {
    let active = true
    aiApi.getNews('general').then(feed => { if (active) setHeadlines(feed.articles) }).catch(() => undefined)
    return () => { active = false }
  }, [])

  const analyze = (quotes: Quote[], symbol?: string) => {
    setLastQuotes(quotes)
    const prompt = symbol
      ? `Faz uma análise educativa de ${symbol}: contexto do preço de hoje, cenários de alta e de baixa, riscos principais, o que invalidaria cada cenário e como dimensionar o risco. Usa os dados do contexto.`
      : 'Faz um resumo do dia para esta lista: quem se destaca, possíveis motivos (com base nos títulos), correlações e riscos. Usa os dados do contexto.'
    openChat({ prompt, mode: 'trading', context: buildMarketContext(symbol ? quotes.filter(q => q.symbol === symbol) : quotes, headlines) })
  }

  const ask = (event: FormEvent) => {
    event.preventDefault()
    if (!question.trim()) return
    openChat({ prompt: question.trim(), mode: 'trading', context: buildMarketContext(lastQuotes, headlines) })
    setQuestion('')
  }

  return <section className="trading-layout">
    <article className="aegis-panel trade-hero">
      <div>
        <p className="eyebrow">TRADING IA</p>
        <h2>Pergunta ao mercado — com dados, não com palpites.</h2>
        <p>A IA recebe as cotações e os títulos mais recentes como contexto e explica cenários, riscos e o que pode correr mal. Não executa ordens nem promete lucros.</p>
      </div>
      <form className="trade-ask" onSubmit={ask}>
        <label htmlFor="trade-question" className="sr-only">Pergunta sobre mercados</label>
        <input id="trade-question" value={question} onChange={e => setQuestion(e.target.value)} maxLength={600} placeholder="Ex.: O que a subida das taxas de juro significa para as tecnológicas?" />
        <button className="button button-dark" type="submit" disabled={!question.trim()}><AiIcon name="spark" size={16} />Analisar</button>
      </form>
    </article>
    <Watchlist onAnalyze={analyze} />
    <div className="trading-grid">
      <RiskCalculator />
      <DecisionChecklist />
    </div>
    <p className="legal-note">Informação educativa. O Aegis não é intermediário financeiro nem consultor de investimento; investir envolve risco de perda do capital. Desempenho passado não garante resultados futuros.</p>
  </section>
}
