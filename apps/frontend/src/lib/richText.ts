/**
 * Divide a resposta do assistente em pedaços seguros para desenhar.
 *
 * Nunca produz HTML: devolve uma lista de segmentos (texto, negrito, código,
 * bloco de código, fórmula) que o React desenha como elementos. Só as fórmulas
 * passam pelo KaTeX, configurado sem `trust` (sem links, classes nem HTML).
 */
export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'math'; value: string; display: false }

export type Block =
  | { kind: 'para'; parts: Inline[] }
  | { kind: 'codeblock'; lang: string; value: string }
  | { kind: 'math'; value: string; display: true }

const FENCE = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g
const DISPLAY = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g
// $...$ só conta como fórmula se não for dinheiro ("custa $5 e $10"): sem espaço junto aos $.
const INLINE = /\\\((.+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)|\*\*([^*\n]+?)\*\*|`([^`\n]+?)`/g

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0
    if (i > last) out.push({ kind: 'text', value: text.slice(last, i) })
    if (m[1] !== undefined || m[2] !== undefined) out.push({ kind: 'math', value: (m[1] ?? m[2])!.trim(), display: false })
    else if (m[3] !== undefined) out.push({ kind: 'bold', value: m[3] })
    else out.push({ kind: 'code', value: m[4]! })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
  return out
}

function parseProse(text: string, out: Block[]) {
  let last = 0
  const para = (s: string) => { if (s.trim()) out.push({ kind: 'para', parts: parseInline(s.replace(/^\n+|\n+$/g, '')) }) }
  for (const m of text.matchAll(DISPLAY)) {
    const i = m.index ?? 0
    para(text.slice(last, i))
    out.push({ kind: 'math', value: (m[1] ?? m[2])!.trim(), display: true })
    last = i + m[0].length
  }
  para(text.slice(last))
}

export function parseRich(text: string): Block[] {
  const out: Block[] = []
  let last = 0
  for (const m of text.matchAll(FENCE)) {
    const i = m.index ?? 0
    parseProse(text.slice(last, i), out)
    out.push({ kind: 'codeblock', lang: m[1] ?? '', value: (m[2] ?? '').replace(/\n$/, '') })
    last = i + m[0].length
  }
  parseProse(text.slice(last), out)
  return out
}

export function hasMath(blocks: Block[]): boolean {
  return blocks.some(b => b.kind === 'math' || (b.kind === 'para' && b.parts.some(p => p.kind === 'math')))
}
