/**
 * Desenha a resposta do assistente: parágrafos, negrito, código e fórmulas.
 * O KaTeX só é descarregado quando a resposta tem matemática.
 */
import { useEffect, useMemo, useState } from 'react'

import { hasMath, parseRich } from '../lib/richText'
import type { Inline } from '../lib/richText'

type Katex = typeof import('katex').default
let katexPromise: Promise<Katex> | null = null
const loadKatex = () => (katexPromise ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => m.default))

function Formula({ tex, display, katex }: { tex: string; display: boolean; katex: Katex | null }) {
  const html = useMemo(() => {
    if (!katex) return null
    try {
      // trust:false → sem \href, \htmlClass, etc.; limites contra fórmulas gigantes.
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', maxSize: 20, maxExpand: 200, output: 'htmlAndMathml' })
    } catch {
      return null
    }
  }, [tex, display, katex])
  if (!html) return <code className={display ? 'math-raw block' : 'math-raw'}>{tex}</code>
  const Tag = display ? 'div' : 'span'
  return <Tag className={display ? 'math-block' : 'math-inline'} dangerouslySetInnerHTML={{ __html: html }}/>
}

function Parts({ parts, katex }: { parts: Inline[]; katex: Katex | null }) {
  return <>{parts.map((p, i) => {
    if (p.kind === 'bold') return <strong key={i}>{p.value}</strong>
    if (p.kind === 'code') return <code key={i}>{p.value}</code>
    if (p.kind === 'math') return <Formula key={i} tex={p.value} display={false} katex={katex}/>
    return <span key={i}>{p.value}</span>
  })}</>
}

export default function RichText({ text }: { text: string }) {
  const blocks = useMemo(() => parseRich(text), [text])
  const needsKatex = useMemo(() => hasMath(blocks), [blocks])
  const [katex, setKatex] = useState<Katex | null>(null)

  useEffect(() => {
    if (!needsKatex || katex) return
    let alive = true
    loadKatex().then(k => { if (alive) setKatex(() => k) }).catch(() => { /* fica o TeX em bruto */ })
    return () => { alive = false }
  }, [needsKatex, katex])

  return <div className="rich">{blocks.map((b, i) => {
    if (b.kind === 'codeblock') return <pre key={i} data-lang={b.lang || undefined}><code>{b.value}</code></pre>
    if (b.kind === 'math') return <Formula key={i} tex={b.value} display katex={katex}/>
    return <p key={i}><Parts parts={b.parts} katex={katex}/></p>
  })}</div>
}
