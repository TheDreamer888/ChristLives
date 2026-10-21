// Movimento leve: revela elementos e só anima o que está no ecrã.
// Sem ciclos contínuos em JavaScript — o trabalho fica nas animações CSS
// (transform/opacity, compostas na GPU), que pausam fora do ecrã.
(() => {
  const root = document.documentElement
  root.classList.add('js')
  if (!('IntersectionObserver' in window)) {
    root.classList.add('no-io')
    return
  }

  // Revelar uma vez e deixar de observar.
  const reveal = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in')
        reveal.unobserve(e.target)
      }
    }
  }, { rootMargin: '0px 0px -10% 0px' })
  document.querySelectorAll('.reveal').forEach((el) => reveal.observe(el))

  // Animações contínuas só correm quando a secção está visível.
  const live = new IntersectionObserver((entries) => {
    for (const e of entries) e.target.classList.toggle('live', e.isIntersecting)
  })
  document.querySelectorAll('.stage').forEach((el) => live.observe(el))

  // Barra de navegação sólida depois do hero (sem listener de scroll).
  const hero = document.querySelector('.hero')
  const nav = document.querySelector('.nav')
  if (hero && nav) {
    new IntersectionObserver(([e]) => nav.classList.toggle('solid', !e.isIntersecting), {
      rootMargin: '-80px 0px 0px 0px',
    }).observe(hero)
  }

  // Parallax com o rato: só em ponteiros finos e sem movimento reduzido.
  // O ciclo de animação só existe enquanto o rato se mexe e para quando
  // estabiliza; as variáveis só são escritas nas secções visíveis.
  const calm = matchMedia('(prefers-reduced-motion: reduce)')
  const fine = matchMedia('(hover: hover) and (pointer: fine)')
  let tx = 0, ty = 0, x = 0, y = 0, px = innerWidth / 2, py = innerHeight / 2, frame = 0

  const step = () => {
    x += (tx - x) * 0.08
    y += (ty - y) * 0.08
    for (const s of document.querySelectorAll('.stage.live')) {
      const r = s.getBoundingClientRect()
      s.style.setProperty('--mx', x.toFixed(4))
      s.style.setProperty('--my', y.toFixed(4))
      s.style.setProperty('--px', `${Math.round(px - r.left)}px`)
      s.style.setProperty('--py', `${Math.round(py - r.top)}px`)
    }
    frame = Math.abs(tx - x) + Math.abs(ty - y) > 0.002 ? requestAnimationFrame(step) : 0
  }

  addEventListener('pointermove', (ev) => {
    if (calm.matches || !fine.matches || ev.pointerType !== 'mouse') return
    px = ev.clientX
    py = ev.clientY
    tx = (ev.clientX / innerWidth) * 2 - 1
    ty = (ev.clientY / innerHeight) * 2 - 1
    root.classList.add('pointer')
    if (!frame) frame = requestAnimationFrame(step)
  }, { passive: true })

  // Fechar o menu móvel ao escolher um destino, com Escape ou ao tocar fora.
  const menu = document.querySelector('.menu')
  if (menu) {
    const close = () => menu.removeAttribute('open')
    menu.addEventListener('click', (ev) => {
      if (ev.target instanceof HTMLAnchorElement) close()
    })
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && menu.open) {
        close()
        menu.querySelector('summary')?.focus()
      }
    })
    document.addEventListener('click', (ev) => {
      if (menu.open && !menu.contains(ev.target)) close()
    })
  }
})()
