import { useEffect, useState, type ReactNode } from 'react'
import { aiApi, type ChatModelInfo } from '../../lib/aiApi'
import { parseMarkdown, type Inline } from '../../lib/markdown'

export function AiIcon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z',
    trading: 'M3 3v18h18 M7 14l4-4 3 3 6-7 M16 6h4v4',
    news: 'M4 5h13v14H6a2 2 0 0 1-2-2Z M17 9h3v8a2 2 0 0 1-2 2 M8 9h5 M8 13h5',
    courses: 'M2 9l10-6 10 6-10 6Z M6 12v6l6 3 6-3v-6',
    organize: 'M9 6h11 M9 12h11 M9 18h11 M4 6l1 1 2-2 M4 12l1 1 2-2 M4 18l1 1 2-2',
    home: 'M3 11l9-8 9 8 M5 9.5V20h14V9.5 M10 20v-6h4v6',
    send: 'M5 12h14 M13 6l6 6-6 6',
    stop: 'M7 7h10v10H7z',
    plus: 'M12 5v14 M5 12h14',
    copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
    retry: 'M4 4v6h6 M20 20v-6h-6 M5.5 15a7 7 0 0 0 12.1 2.2 M18.5 9A7 7 0 0 0 6.4 6.8',
    spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
    mail: 'M3 6h18v12H3z M3 7l9 6 9-6',
    check: 'M5 12l5 5 9-10',
    external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
    shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7Z',
    menu: 'M4 7h16 M4 12h16 M4 17h10',
    trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  }
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] ?? paths['spark']} /></svg>
}

function renderInline(parts: Inline[]): ReactNode[] {
  return parts.map((part, index) => {
    switch (part.type) {
      case 'strong': return <strong key={index}>{part.text}</strong>
      case 'em': return <em key={index}>{part.text}</em>
      case 'code': return <code key={index}>{part.text}</code>
      case 'link': return <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
      default: return part.text
    }
  })
}

/** Resposta da IA renderizada a partir de markdown seguro (sem HTML). */
export function AiAnswer({ text }: { text: string }) {
  return <div className="ai-answer">
    {parseMarkdown(text).map((block, index) => {
      switch (block.type) {
        case 'heading': {
          const Tag = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5'
          return <Tag key={index}>{renderInline(block.content)}</Tag>
        }
        case 'list': {
          const items = block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)
          return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
        }
        case 'code': return <pre key={index}><code>{block.text}</code></pre>
        case 'quote': return <blockquote key={index}>{renderInline(block.content)}</blockquote>
        default: return <p key={index}>{renderInline(block.content)}</p>
      }
    })}
  </div>
}

export type ModelsState = { models: ChatModelInfo[]; selected: string; setSelected: (id: string) => void; loading: boolean; error: string }

// Última escolha de modelo nesta sessão (sobrevive à navegação entre áreas).
let lastSelected = ''

export function useChatModels(): ModelsState {
  const [models, setModels] = useState<ChatModelInfo[]>([])
  const [selected, setSelectedState] = useState(lastSelected)
  const setSelected = (id: string) => { lastSelected = id; setSelectedState(id) }
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    aiApi.getChatModels()
      .then(result => {
        if (!active) return
        setModels(result.models)
        const keep = result.models.some(m => m.id === lastSelected) ? lastSelected : result.defaultId || ''
        lastSelected = keep
        setSelectedState(keep)
      })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Não foi possível obter os modelos.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  return { models, selected, setSelected, loading, error }
}

export function ModelPicker({ state, compact = false }: { state: ModelsState; compact?: boolean }) {
  if (state.loading) return <span className="model-pill model-pill--muted">A carregar modelos…</span>
  if (!state.models.length) return <span className="model-pill model-pill--warn" title={state.error || undefined}>Nenhuma IA configurada</span>
  return <div className={compact ? 'model-picker model-picker--compact' : 'model-picker'} role="radiogroup" aria-label="Modelo de IA">
    {state.models.map(model => <button key={model.id} type="button" role="radio" aria-checked={state.selected === model.id}
      className={state.selected === model.id ? 'selected' : ''} title={`${model.description} (${model.model})`} onClick={() => state.setSelected(model.id)}>
      <span className={`model-dot model-dot--${model.id}`} aria-hidden="true" />{model.label}
    </button>)}
  </div>
}

export function NoAiNotice() {
  return <p className="ai-setup-note">Para ativar a IA, define no servidor <code>ANTHROPIC_API_KEY</code> (Claude), <code>AI_API_KEY</code> (ChatGPT) ou <code>XAI_API_KEY</code> (Grok).</p>
}
