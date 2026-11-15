/**
 * Calculadora de gestão de risco (dimensionamento de posição). Determinística e local:
 * não usa dados de mercado nem envia nada. Educativa — não é recomendação de investimento.
 */
export type PositionInput = {
  capital: number
  riskPercent: number
  entry: number
  stop: number
  target?: number
  side: 'long' | 'short'
}

export type PositionResult =
  | { ok: false; error: string }
  | {
      ok: true
      units: number
      positionValue: number
      maxLoss: number
      riskPerUnit: number
      exposurePercent: number
      rewardRisk: number | null
      potentialGain: number | null
      warnings: string[]
    }

const finite = (n: number) => Number.isFinite(n)

export function sizePosition(input: PositionInput): PositionResult {
  const { capital, riskPercent, entry, stop, target, side } = input
  if (![capital, riskPercent, entry, stop].every(finite) || capital <= 0 || entry <= 0 || stop <= 0) {
    return { ok: false, error: 'Indica capital, entrada e stop maiores que zero.' }
  }
  if (riskPercent <= 0 || riskPercent > 100) return { ok: false, error: 'O risco por operação tem de estar entre 0 e 100%.' }
  if (side === 'long' && stop >= entry) return { ok: false, error: 'Numa compra (long), o stop tem de ficar abaixo da entrada.' }
  if (side === 'short' && stop <= entry) return { ok: false, error: 'Numa venda (short), o stop tem de ficar acima da entrada.' }

  const riskPerUnit = Math.abs(entry - stop)
  const budget = capital * (riskPercent / 100)
  const units = Math.floor((budget / riskPerUnit) * 10_000) / 10_000
  if (units <= 0) return { ok: false, error: 'O risco escolhido não chega para uma unidade com este stop.' }
  const positionValue = units * entry
  const maxLoss = units * riskPerUnit

  let rewardRisk: number | null = null
  let potentialGain: number | null = null
  if (target !== undefined && finite(target) && target > 0) {
    const valid = side === 'long' ? target > entry : target < entry
    if (!valid) return { ok: false, error: side === 'long' ? 'O objetivo tem de ficar acima da entrada.' : 'O objetivo tem de ficar abaixo da entrada.' }
    potentialGain = units * Math.abs(target - entry)
    rewardRisk = Math.abs(target - entry) / riskPerUnit
  }

  const warnings: string[] = []
  if (riskPercent > 2) warnings.push('Arriscar mais de 1–2% do capital por operação aumenta muito a probabilidade de perdas grandes.')
  if (positionValue > capital) warnings.push('A posição excede o capital: implica alavancagem, com risco de perder mais do que o investido.')
  if (rewardRisk !== null && rewardRisk < 1.5) warnings.push('A relação ganho/risco é baixa (inferior a 1,5).')

  return {
    ok: true,
    units,
    positionValue: round(positionValue),
    maxLoss: round(maxLoss),
    riskPerUnit: round(riskPerUnit),
    exposurePercent: round((positionValue / capital) * 100),
    rewardRisk: rewardRisk === null ? null : round(rewardRisk),
    potentialGain: potentialGain === null ? null : round(potentialGain),
    warnings,
  }
}

const round = (n: number) => Math.round(n * 100) / 100

export const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SPY', 'BINANCE:BTCUSDT']

export function parseWatchlist(raw: string): string[] {
  const symbols = raw.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
  return [...new Set(symbols)].filter(s => /^[A-Z0-9][A-Z0-9.:\-^=]{0,19}$/.test(s)).slice(0, 12)
}
