/**
 * Cena 3D da Lusorbe: o orbe guardião, estrelas, nebulosa e escudo de partículas.
 *
 * Sem ficheiros de imagem: brilhos e nebulosa são gradientes gerados em canvas,
 * os reflexos vêm de um ambiente procedimental (RoomEnvironment). O modelo GLB
 * (gerado no Higgsfield) substitui o orbe procedimental quando acaba de carregar;
 * se falhar, o procedimental fica — a página nunca depende dele.
 *
 * Desempenho: resolução adaptativa (baixa o DPR se os fotogramas ficarem lentos),
 * pausa com o separador escondido, e com prefers-reduced-motion só desenha
 * quando o scroll ou o rato mudam alguma coisa.
 */
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Clock,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  PointLight,
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

import { hopf, rotation4D, tesseract } from './hyper'
import { createGlassOrb } from './orb'

export interface SceneHandle {
  setProgress(p: number): void
  /** Posição pelo índice de zona (0…STAGES-1), fracionário para transições. */
  setStage(stage: number): void
  setAccent(hex: string): void
  pulse(): void
  dispose(): void
}

interface Options {
  canvas: HTMLCanvasElement
  reducedMotion: boolean
  onProgress?: (ratio: number) => void
  onReady?: () => void
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const damp = (a: number, b: number, lambda: number, dt: number) => lerp(a, b, 1 - Math.exp(-lambda * dt))

function radialTexture(stops: [number, string][], size = 256): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (const [o, col] of stops) grad.addColorStop(o, col)
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  return tex
}

function starfield(count: number, radius: number): Points {
  const pos = new Float32Array(count * 3)
  const col = new Float32Array(count * 3)
  const c = new Color()
  for (let i = 0; i < count; i++) {
    // distribuição numa casca esférica, mais densa longe do centro
    const r = radius * (0.35 + 0.65 * Math.cbrt(Math.random()))
    const th = Math.random() * Math.PI * 2
    const ph = Math.acos(2 * Math.random() - 1)
    pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph)], i * 3)
    c.setHSL(0.5 + Math.random() * 0.25, 0.4, 0.6 + Math.random() * 0.4)
    col.set([c.r, c.g, c.b], i * 3)
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('color', new BufferAttribute(col, 3))
  const mat = new PointsMaterial({
    size: 0.06,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: AdditiveBlending,
    map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,.6)'], [1, 'rgba(255,255,255,0)']], 64),
  })
  return new Points(geo, mat)
}

export function createScene(opts: Options): SceneHandle {
  const { canvas, reducedMotion } = opts
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 1)

  // Até 2x: num monitor 4K a 150-200 % desenha à resolução nativa. A resolução
  // adaptativa baixa sozinha se a placa gráfica não acompanhar.
  const maxDpr = Math.min(window.devicePixelRatio || 1, 2)
  let dpr = maxDpr
  renderer.setPixelRatio(dpr)

  const scene = new Scene()
  const pmrem = new PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

  const camera = new PerspectiveCamera(40, 1, 0.1, 200)
  camera.position.set(0, 0, 7)

  const accent = new Color('#5eead4')
  const targetAccent = new Color('#5eead4')

  // --- Mundo -------------------------------------------------------------------
  const stars = starfield(reducedMotion ? 1500 : 3500, 60)
  scene.add(stars)

  const nebulaTex = radialTexture([
    [0, 'rgba(94,234,212,.35)'],
    [0.35, 'rgba(129,140,248,.14)'],
    [1, 'rgba(0,0,0,0)'],
  ])
  const nebulae: Sprite[] = []
  for (const [x, y, z, s] of [
    [-9, 4, -30, 34],
    [12, -6, -40, 46],
    [2, 9, -55, 60],
  ] as const) {
    const sp = new Sprite(new SpriteMaterial({ map: nebulaTex, transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.7 }))
    sp.position.set(x, y, z)
    sp.scale.setScalar(s)
    nebulae.push(sp)
    scene.add(sp)
  }

  const rig = new Group() // move-se com o scroll
  scene.add(rig)
  const tilt = new Group() // inclina-se para o cursor
  rig.add(tilt)
  const spin = new Group() // gira (arrastar + inércia)
  tilt.add(spin)

  // Orbe de vidro desenhado em código (conceito gerado no Higgsfield; ver orb.ts).
  const glassOrb = createGlassOrb(reducedMotion)
  spin.add(glassOrb.group)
  let viewHalf = 450

  const glow = new Sprite(
    new SpriteMaterial({
      map: radialTexture([[0, 'rgba(255,255,255,.95)'], [0.18, 'rgba(255,255,255,.35)'], [1, 'rgba(255,255,255,0)']]),
      color: accent,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  )
  glow.scale.setScalar(1.3)
  tilt.add(glow)

  const coreLight = new PointLight(accent, 30, 12, 2)
  tilt.add(coreLight)

  // --- 4D: fibração de Hopf (escudo) e hipercubo, rodados e projetados no shader ---
  const hopfObj = hopf(reducedMotion ? 40 : 56, reducedMotion ? 30 : 40)
  hopfObj.material.uniforms['uScale']!.value = 1.55
  hopfObj.material.uniforms['uSize']!.value = 0.032
  const tess = tesseract(reducedMotion ? 16 : 26)
  tess.material.uniforms['uScale']!.value = 0.7
  tess.material.uniforms['uSize']!.value = 0.04
  // O hipercubo é uma "lua" em 4D que orbita o orbe: pequeno o suficiente para se ler a forma.
  const moon = new Group()
  moon.add(tess.points)
  // O hipercubo existe (hyper.ts) mas não entra na cena: dentro do orbe só criava ruído.
  tilt.add(hopfObj.points)
  const hyperMats = [hopfObj.material, tess.material]
  let wAngle = 0 // rotação extra na 4.ª dimensão ao arrastar
  const colorB = new Color()

  // ondas de choque (clique)
  const waves: { mesh: Mesh; age: number }[] = []
  const waveGeo = new RingGeometry(0.98, 1, 96)
  function pulse() {
    const mesh = new Mesh(
      waveGeo,
      new MeshBasicMaterial({ color: accent.clone(), transparent: true, opacity: 0.9, side: DoubleSide, blending: AdditiveBlending, depthWrite: false }),
    )
    mesh.lookAt(camera.position)
    tilt.add(mesh)
    waves.push({ mesh, age: 0 })
    if (waves.length > 6) {
      const old = waves.shift()!
      tilt.remove(old.mesh)
      ;(old.mesh.material as MeshBasicMaterial).dispose()
    }
    kick = Math.min(kick + 0.9, 2)
    invalidate()
  }

  setTimeout(() => opts.onReady?.(), 0)

  // --- Interação ------------------------------------------------------------------
  const pointer = new Vector2(0, 0)
  const pointerTarget = new Vector2(0, 0)
  let dragging = false
  let lastX = 0
  let lastY = 0
  let velX = 0.12 // rotação base lenta
  let velY = 0
  let kick = 0

  const onMove = (e: PointerEvent) => {
    pointerTarget.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
    if (dragging) {
      velX = (e.clientX - lastX) * 0.01
      velY = (e.clientY - lastY) * 0.01
      lastX = e.clientX
      lastY = e.clientY
    }
    invalidate()
  }
  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('a,button,input,select,label,form')) return
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
  }
  const onUp = () => {
    dragging = false
  }
  addEventListener('pointermove', onMove, { passive: true })
  addEventListener('pointerdown', onDown, { passive: true })
  addEventListener('pointerup', onUp, { passive: true })

  // --- Scroll: posição do orbe por secção -------------------------------------------
  let progress = 0
  // [x, y, z, escala] ao longo da página
  const path: [number, number, number, number][] = [
    [0.58, 0, 0, 0.78], // topo: texto à esquerda, orbe à direita
    [-0.62, 0.1, -0.5, 0.7], // defesa: texto à direita
    [0.62, -0.1, -0.6, 0.7], // mercados
    [-0.62, 0.1, -0.6, 0.7], // educação
    [1.9, 2.4, -9, 0.4], // conteúdo: o orbe sai de cena para o texto ficar limpo
    [0, 2.3, -3.2, 0.6], // privacidade: texto ao centro, orbe recua para cima
    [0, 3.1, -4.5, 0.5], // lista de espera
  ]
  function pathAt(p: number): [number, number, number, number] {
    const f = Math.min(Math.max(p, 0), 1) * (path.length - 1)
    const i = Math.min(Math.floor(f), path.length - 2)
    const t = f - i
    const s = t * t * (3 - 2 * t)
    const a = path[i]!
    const b = path[i + 1]!
    return [lerp(a[0], b[0], s), lerp(a[1], b[1], s), lerp(a[2], b[2], s), lerp(a[3], b[3], s)]
  }

  const clock = new Clock()
  let raf = 0
  let running = false
  let frameAvg = 16
  let narrow = false

  // --- Ciclo -----------------------------------------------------------------------
  function resize() {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    renderer.setSize(w, h, false)
    syncViewHalf()
    camera.aspect = w / h
    // em ecrãs estreitos afasta a câmara para o orbe caber
    narrow = w / h < 0.8
    camera.position.z = narrow ? 10 : 7
    camera.updateProjectionMatrix()
    invalidate()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(canvas)
  resize()

  function syncViewHalf() {
    const half = renderer.getDrawingBufferSize(new Vector2()).y / 2
    viewHalf = half
    for (const m of hyperMats) m.uniforms['uViewHalf']!.value = half
  }

  function invalidate() {
    if (!running && !document.hidden) start()
  }

  function frame() {
    raf = 0
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime

    pointer.x = damp(pointer.x, pointerTarget.x, 4, dt)
    pointer.y = damp(pointer.y, pointerTarget.y, 4, dt)
    accent.lerp(targetAccent, 1 - Math.exp(-3 * dt))

    // posição pelo scroll
    let [px, py, pz, ps] = pathAt(progress)
    // fração da meia-largura visível → unidades da cena
    const halfWidth = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z * camera.aspect
    px *= halfWidth
    if (narrow) {
      // ecrã estreito: o texto fica em baixo, o orbe centrado em cima
      px = 0
      py = Math.max(py, 3.25)
      ps *= 0.46
    }
    rig.position.set(damp(rig.position.x, px, 5, dt), damp(rig.position.y, py, 5, dt), damp(rig.position.z, pz, 5, dt))
    rig.scale.setScalar(damp(rig.scale.x, ps, 5, dt))

    // inclinação para o cursor
    tilt.rotation.y = damp(tilt.rotation.y, pointer.x * 0.5, 5, dt)
    tilt.rotation.x = damp(tilt.rotation.x, -pointer.y * 0.35, 5, dt)

    // rotação com inércia
    if (!dragging && !reducedMotion) {
      velX = damp(velX, 0.12, 0.8, dt)
      velY = damp(velY, 0, 1.2, dt)
    }
    spin.rotation.y += velX * dt * (reducedMotion ? 0 : 1) + (dragging ? velX * 0.5 : 0)
    spin.rotation.x += velY * dt + (dragging ? velY * 0.5 : 0)

    kick = damp(kick, 0, 2.5, dt)
    const breathe = reducedMotion ? 1 : 1 + Math.sin(t * 1.6) * 0.05
    glow.material.color.copy(accent)
    glow.scale.setScalar(1.3 * breathe * (1 + kick * 0.5))
    coreLight.color.copy(accent)
    coreLight.intensity = 4 * (1 + kick)
    glassOrb.update(t, accent, kick, viewHalf)

    // 4D: só se atualizam uniforms; cada ponto é rodado e projetado no shader
    const r = reducedMotion ? 0 : t
    wAngle += velX * dt * 0.8
    colorB.copy(accent).offsetHSL(0.17, 0, 0.06)
    for (const m of hyperMats) {
      const u = m.uniforms
      u['uTime']!.value = r
      u['uKick']!.value = kick
      ;(u['uPointer']!.value as Vector3).set(pointer.x * 2.6, pointer.y * 2.6, 1.8)
      ;(u['uColorA']!.value as Color).copy(accent)
      ;(u['uColorB']!.value as Color).copy(colorB)
    }
    rotation4D(hopfObj.material.uniforms['uRot']!.value, r * 0.11 + pointer.x * 0.9 + wAngle, r * 0.07 + pointer.y * 0.9, progress * Math.PI * 1.5 + r * 0.05, r * 0.03)
    const orbit = r * 0.22 + progress * Math.PI
    // órbita elíptica: quando passa para o lado do texto vai por trás (z negativo) e fica mais pequena
    // órbita vertical: passa por cima e por baixo do orbe, nunca para o lado do texto
    moon.position.set(0.35 + Math.sin(orbit) * 0.5, Math.cos(orbit) * 2.1, Math.sin(orbit) * 1.4)
    ;(tess.material.uniforms['uPointer']!.value as Vector3).set(0, 0, 100) // a lua não se deforma com o cursor
    rotation4D(tess.material.uniforms['uRot']!.value, r * 0.31 + pointer.x * 1.2 + wAngle * 1.5, r * 0.23 - pointer.y * 1.2, r * 0.17 + progress * Math.PI * 2, r * 0.13)

    // ondas
    for (const w of waves) {
      w.age += dt
      const s = 1 + w.age * 4.5
      w.mesh.scale.setScalar(s)
      ;(w.mesh.material as MeshBasicMaterial).opacity = Math.max(0, 0.9 - w.age * 0.9)
    }

    // estrelas e câmara
    stars.rotation.y += dt * 0.006
    stars.rotation.x = pointer.y * 0.04
    camera.position.x = damp(camera.position.x, pointer.x * 0.35, 3, dt)
    camera.position.y = damp(camera.position.y, pointer.y * 0.25 - progress * 0.6, 3, dt)
    camera.lookAt(rig.position.x * 0.35, rig.position.y * 0.5, rig.position.z)

    const t0 = performance.now()
    renderer.render(scene, camera)
    const cost = performance.now() - t0 + dt * 1000 * 0.25
    frameAvg = frameAvg * 0.95 + cost * 0.05

    // resolução adaptativa: menos píxeis se o GPU estiver a sofrer
    if (frameAvg > 14 && dpr > 1) {
      dpr = Math.max(1, dpr - 0.25)
      renderer.setPixelRatio(dpr)
      syncViewHalf()
      frameAvg = 10
    } else if (frameAvg < 6 && dpr < maxDpr) {
      dpr = Math.min(maxDpr, dpr + 0.25)
      renderer.setPixelRatio(dpr)
      syncViewHalf()
      frameAvg = 10
    }

    const settling = Math.abs(pointer.x - pointerTarget.x) + Math.abs(pointer.y - pointerTarget.y) > 0.001 || kick > 0.01 || waves.some((w) => w.age < 1)
    if (!reducedMotion || settling || dragging) raf = requestAnimationFrame(frame)
    else running = false
  }

  function start() {
    if (running) return
    running = true
    clock.getDelta()
    raf = requestAnimationFrame(frame)
  }

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf)
      raf = 0
      running = false
    } else start()
  }
  document.addEventListener('visibilitychange', onVisibility)
  start()

  return {
    setProgress(p) {
      progress = p
      invalidate()
    },
    setStage(stage) {
      progress = Math.min(1, Math.max(0, stage / (path.length - 1)))
      invalidate()
    },
    setAccent(hex) {
      targetAccent.set(hex)
      invalidate()
    },
    pulse,
    dispose() {
      cancelAnimationFrame(raf)
      ro.disconnect()
      removeEventListener('pointermove', onMove)
      removeEventListener('pointerdown', onDown)
      removeEventListener('pointerup', onUp)
      document.removeEventListener('visibilitychange', onVisibility)
      renderer.dispose()
      pmrem.dispose()
    },
  }
}
