/**
 * Markdown mínimo e seguro para respostas de IA: nunca produz HTML, só uma árvore de
 * blocos e segmentos que o React renderiza como texto. Ligações só http(s).
 */
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string }

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; content: Inline[] }
  | { type: 'paragraph'; content: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'code'; language: string; text: string }
  | { type: 'quote'; content: Inline[] }

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|(?<![\w*])\*[^*\n]+\*(?!\w)|(?<!\w)_[^_\n]+_(?!\w))/g

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const token = match[0]
    const index = match.index ?? 0
    if (index > last) out.push({ type: 'text', text: text.slice(last, index) })
    if (token.startsWith('**')) out.push({ type: 'strong', text: token.slice(2, -2) })
    else if (token.startsWith('`')) out.push({ type: 'code', text: token.slice(1, -1) })
    else if (token.startsWith('[')) {
      const [, label = '', href = ''] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token) ?? []
      out.push(/^https?:\/\//i.test(href) ? { type: 'link', text: label, href } : { type: 'text', text: token })
    } else out.push({ type: 'em', text: token.slice(1, -1) })
    last = index + token.length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', content: parseInline(paragraph.join(' ')) })
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) code.push(lines[i++] ?? '')
      blocks.push({ type: 'code', language: fence[1] ?? '', text: code.join('\n') })
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: (heading[1]?.length ?? 1) as 1 | 2 | 3, content: parseInline(heading[2] ?? '') })
      continue
    }
    const listItem = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (listItem) {
      flush()
      const ordered = !listItem[1]
      const items: Inline[][] = []
      while (i < lines.length) {
        const item = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(lines[i] ?? '')
        if (!item || !item[1] !== ordered) break
        items.push(parseInline(item[3] ?? ''))
        i++
      }
      i--
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flush()
      blocks.push({ type: 'quote', content: parseInline(quote[1] ?? '') })
      continue
    }
    if (!line.trim()) flush()
    else paragraph.push(line.trim())
  }
  flush()
  return blocks
}
