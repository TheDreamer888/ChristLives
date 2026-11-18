import './style.css'
import { initDemos } from './demos'
import { initWaitlist } from './waitlist'

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const loader = document.getElementById('loader')!
const bar = document.getElementById('loader-bar')!
const canvas = document.getElementById('scene') as HTMLCanvasElement
const panels = [...document.querySelectorAll<HTMLElement>('.panel, .content')]
// Cada zona marcada com data-orb corresponde a uma posição do orbe (ver scene.ts).
const stages = [...document.querySelectorAll<HTMLElement>('[data-orb]')]
const accents = [...document.querySelectorAll<HTMLElement>('[data-accent]')]

initWaitlist()
initDemos()

function hideLoader() {
  loader.classList.add('done')
  document.body.classList.add('ready')
}

// Navegação opaca depois do topo.
const nav = document.querySelector('.nav')!
const onScrollNav = () => nav.classList.toggle('solid', scrollY > 40)
addEventListener('scroll', onScrollNav, { passive: true })
onScrollNav()

// Fecha o menu móvel ao escolher uma secção.
document.querySelectorAll('.menu a').forEach((a) =>
  a.addEventListener('click', () => (document.querySelector('.menu') as HTMLDetailsElement).removeAttribute('open')),
)

// Texto entra quando a secção chega ao ecrã.
const io = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.target.classList.toggle('in', e.isIntersecting)),
  { threshold: 0.35 },
)
panels.forEach((p) => io.observe(p))

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

async function boot3d() {
  if (!webglAvailable()) {
    document.body.classList.add('no-webgl')
    hideLoader()
    return
  }
  // A cena (three.js) é carregada à parte: o texto aparece logo, o 3D chega depois.
  const { createScene } = await import('./scene')
  const scene = createScene({
    canvas,
    modelUrl: `${import.meta.env.BASE_URL}3d/lusorbe.glb`,
    modelUrl4k: `${import.meta.env.BASE_URL}3d/lusorbe-4k.glb`,
    reducedMotion,
    onProgress: (r) => (bar.style.transform = `scaleX(${r})`),
    onReady: hideLoader,
  })
  setTimeout(hideLoader, 6000) // nunca prender a página no ecrã de carregamento

  // Scroll → percurso do orbe e cor da secção ativa.
  let ticking = false
  const update = () => {
    ticking = false
    const mid = innerHeight / 2
    const contains = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      return r.top <= mid && r.bottom >= mid
    }
    // Posição do orbe: zona visível + quanto dela já passou (transição suave entre zonas).
    const zone = stages.find(contains)
    if (zone) {
      const r = zone.getBoundingClientRect()
      const within = Math.min(1, Math.max(0, (mid - r.top) / r.height))
      const index = Number(zone.dataset['orb'])
      const next = stages[stages.indexOf(zone) + 1]
      const span = next ? Number(next.dataset['orb']) - index : 0
      // Só se aproxima da posição seguinte na metade final da zona.
      const t = within < 0.5 ? 0 : (within - 0.5) * 2
      scene.setStage(index + span * t * t * (3 - 2 * t))
    }
    // Cor: a secção mais específica (dentro da zona de conteúdo há várias).
    const active = accents.filter(contains).pop()
    if (active?.dataset.accent) {
      scene.setAccent(active.dataset.accent)
      document.documentElement.style.setProperty('--accent', active.dataset.accent)
    }
  }
  addEventListener(
    'scroll',
    () => {
      if (!ticking) {
        ticking = true
        requestAnimationFrame(update)
      }
    },
    { passive: true },
  )
  update()

  // Clique no espaço (fora de botões e campos) → onda de choque.
  addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a,button,input,select,label,form,summary')) return
    scene.pulse()
  })
}

void boot3d()
