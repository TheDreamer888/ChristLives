import { useState, type FormEvent } from 'react'
import { COURSES, courseProgress, readProgress } from '../../lib/courses'
import { timeAgo } from '../../lib/time'
import { AiIcon, ModelPicker, useChatModels } from './shared'
import { useNews } from './useNews'
import type { ChatSeed } from './ChatView'

type Area = 'chat' | 'trading' | 'news' | 'courses' | 'organize' | 'security'

const TILES: { id: Area; icon: string; title: string; text: string; tone: string }[] = [
  { id: 'chat', icon: 'chat', title: 'Chat IA', text: 'Claude, ChatGPT e Grok num só lugar.', tone: 'violet' },
  { id: 'trading', icon: 'trading', title: 'Trading IA', text: 'Cotações, cenários e gestão de risco.', tone: 'green' },
  { id: 'news', icon: 'news', title: 'Notícias globais', text: 'O que move os mercados, agora.', tone: 'blue' },
  { id: 'courses', icon: 'courses', title: 'Cursos de economia', text: 'Lições com dados reais e tutor IA.', tone: 'amber' },
  { id: 'organize', icon: 'organize', title: 'Organização', text: 'Emails, tarefas e Notion.', tone: 'rose' },
  { id: 'security', icon: 'shield', title: 'Proteção digital', text: 'Verifica ligações suspeitas.', tone: 'slate' },
]

export default function HomeView({ go, openChat }: { go: (area: Area) => void; openChat: (seed: Omit<ChatSeed, 'id'>) => void }) {
  const models = useChatModels()
  const [prompt, setPrompt] = useState('')
  const { feed, loading } = useNews('general', '')
  const done = readProgress()
  const nextCourse = COURSES.map(c => ({ course: c, progress: courseProgress(c, done) })).find(c => c.progress < 100) ?? { course: COURSES[0]!, progress: 100 }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (prompt.trim()) openChat({ prompt: prompt.trim(), mode: 'general' })
  }

  return <section className="home-layout">
    <article className="home-hero">
      <div className="home-hero-glow" aria-hidden="true" />
      <p className="home-kicker"><AiIcon name="spark" size={14} />IA PARA DECIDIR, APRENDER E ORGANIZAR</p>
      <h2>Pergunta qualquer coisa.<br /><span>Decide com dados.</span></h2>
      <form className="home-prompt" onSubmit={submit}>
        <label htmlFor="home-prompt" className="sr-only">Pergunta à IA</label>
        <input id="home-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} placeholder="Ex.: Explica o impacto das taxas de juro nas ações tecnológicas" />
        <button type="submit" disabled={!prompt.trim()} aria-label="Perguntar"><AiIcon name="send" size={18} /></button>
      </form>
      <div className="home-models"><span>Modelos:</span><ModelPicker state={models} compact /></div>
    </article>

    <div className="home-tiles">
      {TILES.map(tile => <button key={tile.id} type="button" className={`home-tile home-tile--${tile.tone}`} onClick={() => go(tile.id)}>
        <span className="home-tile-icon"><AiIcon name={tile.icon} size={22} /></span>
        <strong>{tile.title}</strong>
        <small>{tile.text}</small>
      </button>)}
    </div>

    <div className="home-grid">
      <article className="aegis-panel home-news">
        <div className="panel-row"><div><p className="eyebrow">MERCADOS AGORA</p><h2>Últimas notícias</h2></div><button className="link-button" type="button" onClick={() => go('news')}>Ver todas</button></div>
        {loading && !feed && <ul className="headline-list" aria-hidden="true">{[0, 1, 2, 3].map(i => <li key={i} className="skeleton-line" />)}</ul>}
        {feed && feed.articles.length > 0 ? <ul className="headline-list">
          {feed.articles.slice(0, 5).map(a => <li key={a.url}><a href={a.url} target="_blank" rel="noopener noreferrer"><strong>{a.title}</strong><small>{a.source}{a.published_at ? ` · ${timeAgo(a.published_at)}` : ''}</small></a></li>)}
        </ul> : !loading && <p className="agency-note">As notícias aparecem quando a API estiver disponível.</p>}
      </article>
      <article className="aegis-panel home-course">
        <p className="eyebrow">CONTINUA A APRENDER</p>
        <h2>{nextCourse.course.title}</h2>
        <p>{nextCourse.course.description}</p>
        <span className="progress"><i style={{ width: `${nextCourse.progress}%` }} /></span>
        <small className="agency-note">{nextCourse.progress}% concluído</small>
        <button className="button button-dark" type="button" onClick={() => go('courses')}>Continuar curso</button>
      </article>
    </div>
  </section>
}
