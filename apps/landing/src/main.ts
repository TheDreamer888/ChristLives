import './style.css'
import { initWaitlist } from './waitlist'

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const loader = document.getElementById('loader')!
const bar = document.getElementById('loader-bar')!
const canvas = document.getElementById('scene') as HTMLCanvasElement
const panels = [...document.querySelectorAll<HTMLElement>('.panel')]

initWaitlist()

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
    const max = document.documentElement.scrollHeight - innerHeight
    scene.setProgress(max > 0 ? scrollY / max : 0)
    const mid = innerHeight / 2
    const active = panels.find((p) => {
      const r = p.getBoundingClientRect()
      return r.top <= mid && r.bottom >= mid
    })
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
