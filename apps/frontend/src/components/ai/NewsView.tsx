import { useState, type FormEvent } from 'react'
import { buildMarketContext, type NewsCategory } from '../../lib/aiApi'
import { timeAgo } from '../../lib/time'
import { AiIcon } from './shared'
import { useNews } from './useNews'
import type { ChatSeed } from './ChatView'

const CATEGORIES: { id: NewsCategory; label: string }[] = [
  { id: 'general', label: 'Mercados' },
  { id: 'forex', label: 'Câmbios' },
  { id: 'crypto', label: 'Cripto' },
  { id: 'merger', label: 'Fusões e IPO' },
]

export default function NewsView({ openChat }: { openChat: (seed: Omit<ChatSeed, 'id'>) => void }) {
  const [category, setCategory] = useState<NewsCategory>('general')
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const { feed, error, loading, refresh } = useNews(category, query)
  const articles = feed?.articles ?? []

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = draft.trim()
    setQuery(value.length >= 2 ? value : '')
  }

  const briefing = () => openChat({
    mode: 'trading',
    prompt: 'Faz um briefing de mercado a partir destes títulos: 5 temas principais, impacto possível por classe de ativos (ações, obrigações, câmbios, cripto) e o que acompanhar nos próximos dias. Indica incertezas.',
    context: buildMarketContext([], articles),
  })

  return <section className="news-layout">
    <article className="aegis-panel news-toolbar">
      <div className="panel-row">
        <div><p className="eyebrow">NOTÍCIAS GLOBAIS</p><h2>O que está a mexer com os mercados</h2></div>
        <div className="button-row">
          <button className="button button-quiet" type="button" onClick={refresh} disabled={loading}><AiIcon name="retry" size={15} />Atualizar</button>
          <button className="button button-dark" type="button" onClick={briefing} disabled={!articles.length}><AiIcon name="spark" size={16} />Briefing com IA</button>
        </div>
      </div>
      <div className="news-controls">
        <div className="segmented" role="tablist" aria-label="Categoria">
          {CATEGORIES.map(c => <button key={c.id} type="button" role="tab" aria-selected={category === c.id} className={category === c.id ? 'selected' : ''} onClick={() => { setCategory(c.id); setQuery(''); setDraft('') }}>{c.label}</button>)}
        </div>
        <form className="inline-form" onSubmit={submit}>
          <label htmlFor="news-search" className="sr-only">Pesquisar notícias</label>
          <input id="news-search" type="search" value={draft} onChange={e => setDraft(e.target.value)} maxLength={80} placeholder="Pesquisar: Nvidia, BCE, petróleo…" />
          <button className="button button-outline" type="submit">Pesquisar</button>
        </form>
      </div>
      {query && <p className="agency-note">Resultados para «{query}». <button className="link-button" type="button" onClick={() => { setQuery(''); setDraft('') }}>Limpar</button></p>}
    </article>

    {error && <p className="assistant-error" role="alert">{error}</p>}
    {loading && !articles.length && <div className="news-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="news-card skeleton" />)}</div>}
    {!loading && !error && !articles.length && <article className="aegis-panel client-empty"><h2>Sem notícias para mostrar.</h2><p>Experimenta outra categoria ou pesquisa.</p></article>}

    {articles.length > 0 && <div className="news-grid">
      {articles.map((article, index) => <a key={article.url} className={index === 0 ? 'news-card news-card--lead' : 'news-card'} href={article.url} target="_blank" rel="noopener noreferrer">
        <span className="news-meta"><b>{article.source}</b>{article.published_at && <time dateTime={article.published_at}>{timeAgo(article.published_at)}</time>}</span>
        <strong>{article.title}</strong>
        {article.summary && <p>{article.summary}</p>}
        <span className="news-open">Abrir fonte <AiIcon name="external" size={13} /></span>
      </a>)}
    </div>}
    {feed && <p className="legal-note">Fonte: {feed.source}. {feed.notice} Os títulos podem estar em inglês e são de terceiros.</p>}
  </section>
}
