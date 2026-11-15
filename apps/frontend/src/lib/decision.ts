/**
 * Lista de verificação educativa para decisões online (comprar, clicar, partilhar).
 * Tudo corre no browser: nada é enviado nem guardado. Não é aconselhamento e não
 * garante segurança — serve apenas para abrandar decisões feitas sob pressão.
 */
export type DecisionCheck = {
  id: string
  title: string
  text: string
}

export const DECISION_CHECKS: readonly DecisionCheck[] = [
  { id: 'source', title: 'Conheço a origem', text: 'Sei quem enviou ou publicou e consigo confirmar por outro canal.' },
  { id: 'urgency', title: 'Não há pressão de urgência', text: 'Prazos curtos, prémios inesperados ou ameaças são sinais habituais de burla.' },
  { id: 'link', title: 'Verifiquei a ligação', text: 'O domínio é o esperado, usa HTTPS e não pede credenciais fora do site oficial.' },
  { id: 'data', title: 'Partilho só o necessário', text: 'Não envio palavras-passe, códigos, IBAN ou documentos sem necessidade clara.' },
  { id: 'compare', title: 'Comparei antes de decidir', text: 'Vi preços, condições e opiniões em fontes independentes.' },
]

export type DecisionLevel = 'pause' | 'review' | 'ready'

export type DecisionSummary = {
  level: DecisionLevel
  done: number
  total: number
  percent: number
  title: string
  advice: string
  pending: readonly DecisionCheck[]
}

export function summarizeDecision(checked: readonly string[]): DecisionSummary {
  const valid = new Set(checked.filter(id => DECISION_CHECKS.some(check => check.id === id)))
  const total = DECISION_CHECKS.length
  const done = valid.size
  const pending = DECISION_CHECKS.filter(check => !valid.has(check.id))
  const percent = Math.round((done / total) * 100)
  if (done === total) {
    return { level: 'ready', done, total, percent, pending, title: 'Boa base para decidir.', advice: 'Confirmaste os pontos essenciais. Mesmo assim, decide sem pressa e guarda comprovativos.' }
  }
  if (done >= 3) {
    return { level: 'review', done, total, percent, pending, title: 'Quase lá.', advice: 'Revê os pontos em aberto antes de avançar.' }
  }
  return { level: 'pause', done, total, percent, pending, title: 'Faz uma pausa.', advice: 'Ainda há sinais por confirmar. Na dúvida, não cliques, não pagues e pede uma segunda opinião.' }
}
