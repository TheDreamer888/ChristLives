import { useEffect, useState } from 'react'
import { aiApi, type NewsCategory, type NewsFeed } from '../../lib/aiApi'

export function useNews(category: NewsCategory, query: string) {
  const [feed, setFeed] = useState<NewsFeed | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    aiApi.getNews(category, query)
      .then(result => { if (active) setFeed(result) })
      .catch(reason => { if (active) { setFeed(null); setError(reason instanceof Error ? reason.message : 'Não foi possível obter notícias.') } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [category, query, reload])
  return { feed, error, loading, refresh: () => setReload(n => n + 1) }
}
