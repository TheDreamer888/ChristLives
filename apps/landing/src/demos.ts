/**
 * Demonstrações reais no site, com o mesmo código da app (@lusorbe/core).
 * Tudo corre no browser: nada é executado nem enviado para servidores.
 */
import { inspectText, simulatePosition } from '@lusorbe/core'

const eur = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' })
const pct = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 2, signDisplay: 'always' })

function item(cls: string, title: string, detail: string, sev?: string): HTMLLIElement {
  const li = document.createElement('li')
  li.className = cls
  if (sev) li.dataset['sev'] = sev
  const b = document.createElement('b')
  b.textContent = title
  const span = document.createElement('span')
  span.textContent = detail
  li.append(b, span)
  return li
}

function initReview(): void {
  const form = document.getElementById('demo-review') as HTMLFormElement | null
  const input = document.getElementById('review-input') as HTMLTextAreaElement | null
  const out = document.getElementById('review-out')
  if (!form || !input || !out) return

  const run = () => {
    out.replaceChildren()
    try {
      const findings = inspectText(input.value)
      if (!findings.length) {
        out.append(item('ok', 'Nada de suspeito nos padrões conhecidos', 'Isto não garante que seja seguro: revê sempre a origem antes de executar.'))
        return
      }
      for (const f of findings) out.append(item('', `${f.severity} · ${f.title}`, f.detail, f.severity))
    } catch (err) {
      out.append(item('err', 'Não foi possível analisar', err instanceof Error ? err.message : 'Erro inesperado.'))
    }
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    run()
  })
}

function initSimulator(): void {
  const form = document.getElementById('demo-sim') as HTMLFormElement | null
  const out = document.getElementById('sim-out')
  if (!form || !out) return
  const num = (name: string) => Number((form.elements.namedItem(name) as HTMLInputElement).value.replace(',', '.'))

  const run = () => {
    out.replaceChildren()
    try {
      const r = simulatePosition(num('capital'), num('entry'), num('exit'), num('fee'))
      const big = document.createElement('b')
      big.className = r.profit >= 0 ? 'up' : 'down'
      big.textContent = `${eur.format(r.finalValue)} (${pct.format(r.percent)} %)`
      const detail = document.createElement('span')
      detail.textContent = `${r.profit >= 0 ? 'Ganho' : 'Perda'} de ${eur.format(Math.abs(r.profit))} depois de custos na compra e na venda. Simulação educativa: não é aconselhamento.`
      out.append(big, detail)
    } catch (err) {
      out.textContent = err instanceof Error ? err.message : 'Valores inválidos.'
    }
  }
  form.addEventListener('input', run)
  form.addEventListener('submit', (e) => e.preventDefault())
  run()
}

export function initDemos(): void {
  initReview()
  initSimulator()
}
