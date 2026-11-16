export type Finding = { id: string; title: string; detail: string; severity: 'Atenção' | 'Elevado' }

const patterns: { id: string; pattern: RegExp; title: string; detail: string; severity: Finding['severity'] }[] = [
  { id: 'remote-execution', pattern: /(?:curl|wget)[^\n]{0,500}\|\s*(?:ba)?sh\b|(?:iex|invoke-expression)\s*\(?[^\n]*(?:downloadstring|invoke-webrequest)/i, title: 'Transferência seguida de execução', detail: 'O conteúdo remoto pode mudar. Descarrega sem executar e verifica a origem e a assinatura.', severity: 'Elevado' },
  { id: 'encoded-command', pattern: /(?:powershell|pwsh)[^\n]{0,200}-(?:enc|encodedcommand)\b|\b(?:eval|exec)\s*\([^\n]*(?:atob|base64)/i, title: 'Comando codificado', detail: 'A codificação dificulta a revisão. Solicita uma versão legível antes de executar.', severity: 'Atenção' },
  { id: 'tls-bypass', pattern: /(?:curl\s[^\n]*--insecure|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0)/i, title: 'Validação TLS desativada', detail: 'Sem validação de certificados, a ligação pode ser intercetada. Mantém TLS ativo.', severity: 'Elevado' },
  { id: 'credential', pattern: /(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i, title: 'Possível credencial no texto', detail: 'Não publiques o original. Confirma se é um segredo real e, se foi exposto, revoga-o no serviço de origem.', severity: 'Elevado' },
  { id: 'destructive', pattern: /\brm\s+-[a-z]*r[a-z]*f\b|Remove-Item[^\n]*-Recurse[^\n]*-Force/i, title: 'Remoção recursiva', detail: 'Confirma o caminho resolvido e uma cópia de segurança antes de qualquer operação destrutiva.', severity: 'Atenção' },
]

// Static, local heuristics only. Never execute input or retrieve embedded URLs.
export function inspectText(input: string): Finding[] {

  if (input.length > 100_000) throw new Error('O limite é 100 000 caracteres por análise.')
  if (!input.trim()) throw new Error('Cola primeiro o texto que queres analisar.')
  if (input.split('\n').some(line => line.length > 2000)) throw new Error('O limite por linha é 2000 caracteres. Divide linhas longas antes da análise.')
  return patterns.filter((rule) => rule.pattern.test(input)).map(({ id, title, detail, severity }) => ({ id, title, detail, severity }))
}

export function simulatePosition(capital: number, entry: number, exit: number, feePercent: number) {
  if (![capital, entry, exit, feePercent].every(Number.isFinite) || capital <= 0 || capital > 1e12 || entry <= 0 || exit < 0 || feePercent < 0 || feePercent >= 100) {
    throw new Error('Usa capital e entrada positivos, saída não negativa e custos entre 0 e 99,99%.')
  }
  const fee = feePercent / 100
  const units = capital / (entry * (1 + fee))
  const finalValue = units * exit * (1 - fee)
  if (![units, finalValue, (finalValue / capital - 1) * 100].every(Number.isFinite)) throw new Error('Os valores excedem a capacidade do simulador.')
  return { units, finalValue, profit: finalValue - capital, percent: (finalValue / capital - 1) * 100 }
}

export type LocalEvent = { id: number; at: string; rules: string[]; count: number }
export function exportEvents(events: LocalEvent[]) {
  // Explicit allowlist: never include source text, file names, IPs or credentials.
  return JSON.stringify({ format: 'lusorbe-local-review-v1', kind: 'user-submitted-static-review', events: events.map(({ at, rules, count }) => ({ at, rules, count })) }, null, 2)
}
