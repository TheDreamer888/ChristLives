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
  Box3,
  BufferGeometry,
  CanvasTexture,
  Clock,
  Color,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
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
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export interface SceneHandle {
  setProgress(p: number): void
  setAccent(hex: string): void
  pulse(): void
  dispose(): void
}

interface Options {
  canvas: HTMLCanvasElement
  modelUrl: string
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

function proceduralOrb(accent: Color): Group {
  const orb = new Group()
  const shell = new Mesh(
    new IcosahedronGeometry(1, 2),
    new MeshPhysicalMaterial({
      color: 0x05070b,
      metalness: 0.2,
      roughness: 0.08,
      transmission: 0.35,
      thickness: 1.2,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      flatShading: true,
      envMapIntensity: 1.4,
    }),
  )
  const core = new Mesh(new IcosahedronGeometry(0.46, 3), new MeshBasicMaterial({ color: accent }))
  core.name = 'core'
  const ringMat = new MeshStandardMaterial({ color: 0xc9d2dc, metalness: 1, roughness: 0.25, envMapIntensity: 1.2 })
  const ringA = new Mesh(new TorusGeometry(1.45, 0.018, 12, 160), ringMat)
  const ringB = new Mesh(new TorusGeometry(1.7, 0.012, 12, 180), ringMat)
  ringA.rotation.set(1.2, 0.2, 0)
  ringB.rotation.set(0.4, 1.1, 0.3)
  ringA.name = 'ringA'
  ringB.name = 'ringB'
  orb.add(shell, core, ringA, ringB)
  return orb
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

/** Escudo: partículas numa esfera que se afastam do cursor. */
function shield(count: number): { points: Points; base: Float32Array } {
  const base = new Float32Array(count * 3)
  // espiral de Fibonacci: distribuição uniforme e bonita
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const t = golden * i
    base.set([Math.cos(t) * r * 2.3, y * 2.3, Math.sin(t) * r * 2.3], i * 3)
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(base.slice(), 3))
  const mat = new PointsMaterial({
    size: 0.025,
    color: 0x5eead4,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  return { points: new Points(geo, mat), base }
}

export function createScene(opts: Options): SceneHandle {
  const { canvas, reducedMotion } = opts
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setClearColor(0x000000, 1)

  const maxDpr = Math.min(window.devicePixelRatio || 1, 1.75)
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

  let orb: Object3D = proceduralOrb(accent)
  const glowMats: MeshStandardMaterial[] = [] // núcleo emissivo do modelo do Higgsfield
  spin.add(orb)

  const glow = new Sprite(
    new SpriteMaterial({
      map: radialTexture([[0, 'rgba(255,255,255,.95)'], [0.18, 'rgba(255,255,255,.35)'], [1, 'rgba(255,255,255,0)']]),
      color: accent,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  )
  glow.scale.setScalar(4.2)
  tilt.add(glow)

  const coreLight = new PointLight(accent, 30, 12, 2)
  tilt.add(coreLight)

  const { points: shieldPts, base: shieldBase } = shield(reducedMotion ? 900 : 2200)
  tilt.add(shieldPts)

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

  // --- Modelo do Higgsfield ---------------------------------------------------------
  new GLTFLoader().load(
    opts.modelUrl,
    (gltf) => {
      const model = gltf.scene
      // normaliza: centra e ajusta ao tamanho do orbe procedimental
      model.traverse((o) => {
        const mat = (o as Mesh).material as MeshStandardMaterial | undefined
        if (mat && 'envMapIntensity' in mat) mat.envMapIntensity = 1.3
        if (mat?.emissiveMap) glowMats.push(mat)
      })
      const bounds = new Box3().setFromObject(model)
      const box = bounds.getSize(new Vector3())
      const center = bounds.getCenter(new Vector3())
      const scale = 3.2 / Math.max(box.x, box.y, box.z)
      model.position.copy(center).multiplyScalar(-scale)
      model.scale.setScalar(scale)
      const holder = new Group()
      holder.add(model)
      spin.remove(orb)
      orb = holder
      spin.add(orb)
      opts.onReady?.()
      invalidate()
    },
    (ev) => {
      if (ev.lengthComputable) opts.onProgress?.(ev.loaded / ev.total)
    },
    () => opts.onReady?.(), // falhou: fica o orbe procedimental
  )

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
    [2.1, 0, 0, 1], // topo: texto à esquerda, orbe à direita
    [-2.3, 0.1, -0.5, 0.78], // defesa: texto à direita
    [2.3, -0.1, -0.6, 0.78], // mercados
    [-2.3, 0.1, -0.6, 0.78], // educação
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
  const tmp = new Vector3()

  // --- Ciclo -----------------------------------------------------------------------
  function resize() {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    renderer.setSize(w, h, false)
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
    // afasta o orbe do texto conforme a largura: mais ecrã, mais para o lado
    px *= Math.min(1.45, Math.max(1, camera.aspect / 1.5))
    if (narrow) {
      // ecrã estreito: o texto fica em baixo, o orbe centrado em cima
      px = 0
      py = Math.max(py, 1.5)
      ps *= 0.9
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

    // anéis e núcleo do orbe procedimental
    const ringA = orb.getObjectByName('ringA')
    const ringB = orb.getObjectByName('ringB')
    if (ringA) ringA.rotation.z += dt * 0.6
    if (ringB) ringB.rotation.z -= dt * 0.4
    const core = orb.getObjectByName('core') as Mesh | undefined
    if (core) (core.material as MeshBasicMaterial).color.copy(accent)

    kick = damp(kick, 0, 2.5, dt)
    const breathe = reducedMotion ? 1 : 1 + Math.sin(t * 1.6) * 0.05
    glow.material.color.copy(accent)
    glow.scale.setScalar(4.2 * breathe * (1 + kick * 0.35))
    coreLight.color.copy(accent)
    coreLight.intensity = 30 * (1 + kick)
    for (const m of glowMats) m.emissiveIntensity = (1.1 + kick * 1.6) * breathe

    // escudo: repele as partículas da direção do cursor
    const attr = shieldPts.geometry.getAttribute('position') as BufferAttribute
    const arr = attr.array as Float32Array
    tmp.set(pointer.x * 2.3, pointer.y * 2.3, 1.6)
    for (let i = 0; i < arr.length; i += 3) {
      const bx = shieldBase[i]!
      const by = shieldBase[i + 1]!
      const bz = shieldBase[i + 2]!
      const dx = bx - tmp.x
      const dy = by - tmp.y
      const dz = bz - tmp.z
      const d2 = dx * dx + dy * dy + dz * dz
      const push = 0.9 / (1 + d2 * 2.2) + kick * 0.25
      const wobble = reducedMotion ? 0 : Math.sin(t * 2 + i) * 0.015
      arr[i] = bx * (1 + push * 0.18) + wobble
      arr[i + 1] = by * (1 + push * 0.18)
      arr[i + 2] = bz * (1 + push * 0.18)
    }
    attr.needsUpdate = true
    ;(shieldPts.material as PointsMaterial).color.copy(accent)
    shieldPts.rotation.y += dt * 0.05

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
      frameAvg = 10
    } else if (frameAvg < 6 && dpr < maxDpr) {
      dpr = Math.min(maxDpr, dpr + 0.25)
      renderer.setPixelRatio(dpr)
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
