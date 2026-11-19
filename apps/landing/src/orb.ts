/**
 * Orbe de vidro: esfera iridescente com um redemoinho de luz no interior e dois
 * anéis de titânio. Desenhado em código a partir do conceito gerado no Higgsfield.
 *
 * - Vidro: MeshPhysicalMaterial transparente, com iridescência, clearcoat e
 *   reflexos do ambiente; uma borda (fresnel) acende-se nas arestas.
 * - Redemoinho: milhares de pontos em braços espirais, animados no shader
 *   (custo de processador zero por partícula).
 * - Núcleo: brilho aditivo que pulsa com os cliques.
 */
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  Points,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  MeshStandardMaterial,
  MeshBasicMaterial,
} from 'three'

const R = 1.6

const swirlVertex = /* glsl */ `
  attribute vec3 aSpiral;   // (raio, ângulo inicial, altura)
  attribute float aSeed;
  uniform float uTime;
  uniform float uViewHalf;
  uniform float uKick;
  varying float vGlow;
  void main() {
    float r = aSpiral.x;
    // Rotação diferencial: o centro gira mais depressa do que a periferia, como uma galáxia.
    float a = aSpiral.y + uTime * (0.55 / (0.25 + r));
    // Disco fino com um bojo arredondado no centro (como uma galáxia vista de lado).
    float h = aSpiral.z * (0.06 + 0.55 * exp(-r * r * 14.0)) + sin(uTime * 0.6 + aSeed * 6.28) * 0.015;
    vec3 p = vec3(cos(a) * r, h, sin(a) * r) * ${R.toFixed(2)} * 0.9;
    // Inclina o disco para se ver o redemoinho de frente.
    p = vec3(p.x, p.y * 0.55 + p.z * 0.45, p.z * 0.55 - p.y * 0.45);
    vGlow = mix(1.0, 0.3, r) * (0.5 + 0.5 * aSeed) * (1.0 + uKick * 0.8);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (0.02 + 0.03 * (1.0 - r)) * uViewHalf / -mv.z;
  }
`

const swirlFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vGlow;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vGlow;
    if (a < 0.01) discard;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), vGlow * 0.35) * a * 2.2, a);
    #include <colorspace_fragment>
  }
`

const rimVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`

const rimFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float f = pow(1.0 - max(dot(vNormal, vView), 0.0), 3.0);
    // Iridescência na borda: o tom roda com o ângulo, como numa bolha de sabão.
    vec3 iri = 0.5 + 0.5 * cos(6.2831 * (f * 1.4 + vec3(0.0, 0.33, 0.67) + uTime * 0.03));
    vec3 col = mix(uColor, iri, 0.55) * f * 1.4;
    gl_FragColor = vec4(col, f);
    #include <colorspace_fragment>
  }
`

export interface GlassOrb {
  group: Group
  update(time: number, accent: Color, kick: number, viewHalf: number): void
}

export function createGlassOrb(reducedMotion: boolean): GlassOrb {
  const group = new Group()

  // Redemoinho interior (desenhado primeiro, visto através do vidro).
  const count = reducedMotion ? 4000 : 9000
  const spiral = new Float32Array(count * 3)
  const seeds = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const arm = i % 3
    const r = Math.pow(Math.random(), 0.8)
    const angle = arm * ((Math.PI * 2) / 3) + r * 6.0 + (Math.random() - 0.5) * (0.18 + r * 0.35)
    spiral.set([r, angle, (Math.random() - 0.5) * 0.5], i * 3)
    seeds[i] = Math.random()
  }
  const swirlGeo = new BufferGeometry()
  swirlGeo.setAttribute('aSpiral', new BufferAttribute(spiral, 3))
  swirlGeo.setAttribute('aSeed', new BufferAttribute(seeds, 1))
  swirlGeo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3))
  const swirlMat = new ShaderMaterial({
    vertexShader: swirlVertex,
    fragmentShader: swirlFragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uViewHalf: { value: 450 }, uKick: { value: 0 }, uColor: { value: new Color('#2dd4bf') } },
  })
  const swirl = new Points(swirlGeo, swirlMat)
  swirl.frustumCulled = false
  swirl.renderOrder = 1
  group.add(swirl)

  // Interior escuro e fumado: dá profundidade ao vidro.
  const inner = new Mesh(
    new SphereGeometry(R * 0.995, 96, 96),
    new MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.9, side: BackSide, depthWrite: false }),
  )
  inner.renderOrder = 0
  group.add(inner)

  // Casca de vidro: reflexos, clearcoat e iridescência.
  const glass = new Mesh(
    new SphereGeometry(R, 128, 128),
    new MeshPhysicalMaterial({
      color: '#0a1413',
      metalness: 0.1,
      roughness: 0.04,
      transparent: true,
      opacity: 0.07,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      iridescence: 1,
      iridescenceIOR: 1.35,
      iridescenceThicknessRange: [120, 640],
      envMapIntensity: 1.5,
      depthWrite: false,
    }),
  )
  glass.renderOrder = 2
  group.add(glass)

  // Borda luminosa (fresnel).
  const rimMat = new ShaderMaterial({
    vertexShader: rimVertex,
    fragmentShader: rimFragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uColor: { value: new Color('#5eead4') }, uTime: { value: 0 } },
  })
  const rim = new Mesh(new SphereGeometry(R * 1.004, 96, 96), rimMat)
  rim.renderOrder = 3
  group.add(rim)

  // Anéis de titânio polido, finos, em ângulos diferentes.
  const ringMat = new MeshStandardMaterial({ color: '#d8dee6', metalness: 1, roughness: 0.16, envMapIntensity: 1.6 })
  const ringA = new Mesh(new TorusGeometry(R * 1.13, 0.016, 24, 256), ringMat)
  const ringB = new Mesh(new TorusGeometry(R * 1.2, 0.013, 24, 256), ringMat)
  ringA.rotation.set(1.25, 0.35, 0.2)
  ringB.rotation.set(0.35, -0.9, 1.1)
  ringA.renderOrder = ringB.renderOrder = 4
  group.add(ringA, ringB)

  return {
    group,
    update(time, accent, kick, viewHalf) {
      swirlMat.uniforms['uTime']!.value = reducedMotion ? 0 : time
      swirlMat.uniforms['uKick']!.value = kick
      swirlMat.uniforms['uViewHalf']!.value = viewHalf
      ;(swirlMat.uniforms['uColor']!.value as Color).copy(accent)
      ;(rimMat.uniforms['uColor']!.value as Color).copy(accent)
      rimMat.uniforms['uTime']!.value = time
      if (!reducedMotion) {
        ringA.rotation.z += 0.0025
        ringB.rotation.z -= 0.0018
      }
    },
  }
}
