/**
 * Objetos em 4 dimensões, desenhados inteiramente na placa gráfica.
 *
 * - Tesseract (hipercubo): 16 vértices e 32 arestas em 4D. Ao rodar num plano
 *   que envolve o eixo W, os cubos interiores "atravessam-se" — é o que
 *   denuncia a 4.ª dimensão.
 * - Fibração de Hopf: círculos sobre a 3-esfera (S³). Cada ponto da esfera
 *   comum (S²) corresponde a um círculo em 4D; projetados em perspetiva 4D
 *   formam anéis entrelaçados que se reorganizam ao rodar na 4.ª dimensão.
 *
 * A geometria fica guardada em coordenadas 4D (atributo `a4`). Em cada
 * fotograma o JavaScript só atualiza uma matriz 4×4 de rotação; a rotação e a
 * projeção 4D→3D de cada ponto correm no shader. Custo no processador: zero
 * por partícula.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix4,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three'

const vertexShader = /* glsl */ `
  attribute vec4 a4;
  attribute float aSeed;
  uniform mat4 uRot;          // rotação em 4D
  uniform int uProjection;    // 0 = estereográfica, 1 = perspetiva 4D
  uniform float uDist;        // distância do observador no eixo W (perspetiva)
  uniform float uScale;
  uniform float uSize;
  uniform float uViewHalf;   // metade da altura do ecrã em píxeis reais (como o PointsMaterial)
  uniform float uKick;
  uniform float uTime;
  uniform vec3 uPointer;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec4 p = uRot * a4;
    vec3 q;
    float fade = 1.0;
    if (uProjection == 0) {
      // Projeção estereográfica a partir do polo w = 1: S³ → R³.
      float d = 1.0 - p.w;
      fade = smoothstep(0.08, 0.5, d);       // perto do polo os pontos fugem para o infinito: esconde-os
      q = p.xyz / max(d, 0.08);
      q *= 0.55;
    } else {
      // Perspetiva 4D: um observador em w = 3 olha para o hipercubo.
      q = p.xyz * (uDist / (uDist - p.w));
      fade = smoothstep(-1.0, 0.2, p.w) * 0.6 + 0.4; // o lado "de trás" em W fica mais ténue
    }
    q *= uScale;

    // O cursor empurra os pontos; o clique dá um impulso.
    vec3 away = q - uPointer;
    float push = 0.9 / (1.0 + dot(away, away) * 2.2) + uKick * 0.25;
    q += normalize(q + 1e-4) * push * 0.35;
    q += 0.012 * vec3(sin(uTime * 1.7 + aSeed * 6.28), cos(uTime * 1.3 + aSeed * 4.0), 0.0);

    // Cor pela coordenada W: o que está "mais fundo" na 4.ª dimensão muda de tom.
    float w01 = clamp(p.w * 0.5 + 0.5, 0.0, 1.0);
    vColor = mix(uColorA, uColorB, w01);
    vAlpha = fade * (0.55 + 0.45 * (1.0 - w01 * 0.6));

    vec4 mv = modelViewMatrix * vec4(q, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * fade * (uViewHalf / -mv.z) * (1.0 + uKick * 0.3);
  }
`

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * a * 1.8, a);
    #include <colorspace_fragment>
  }
`

export interface HyperObject {
  points: Points
  material: ShaderMaterial
}

function makeMaterial(projection: 0 | 1, size: number, scale: number, dist = 3): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uRot: { value: new Matrix4() },
      uProjection: { value: projection },
      uDist: { value: dist },
      uScale: { value: scale },
      uSize: { value: size },
      uViewHalf: { value: 450 },
      uKick: { value: 0 },
      uTime: { value: 0 },
      uPointer: { value: new Vector3(0, 0, 10) },
      uColorA: { value: new Color('#5eead4') },
      uColorB: { value: new Color('#818cf8') },
    },
  })
}

function geometry(points4: number[], seeds?: number[]): BufferGeometry {
  const n = points4.length / 4
  const geo = new BufferGeometry()
  geo.setAttribute('a4', new BufferAttribute(new Float32Array(points4), 4))
  geo.setAttribute('aSeed', new BufferAttribute(new Float32Array(seeds ?? Array.from({ length: n }, () => Math.random())), 1))
  // O three.js precisa de "position" para contar vértices; o shader não o usa.
  geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3))
  return geo
}

/** Hipercubo: arestas desenhadas como pontos, vértices mais brilhantes. */
export function tesseract(pointsPerEdge = 28): HyperObject {
  const verts: number[][] = []
  for (let i = 0; i < 16; i++) verts.push([0, 1, 2, 3].map((b) => ((i >> b) & 1 ? 1 : -1) * 0.5))
  const pts: number[] = []
  for (let i = 0; i < 16; i++) {
    for (let b = 0; b < 4; b++) {
      const j = i ^ (1 << b)
      if (j < i) continue // cada aresta uma vez: 32 arestas
      const a = verts[i]!
      const c = verts[j]!
      for (let k = 0; k <= pointsPerEdge; k++) {
        const t = k / pointsPerEdge
        pts.push(a[0]! + (c[0]! - a[0]!) * t, a[1]! + (c[1]! - a[1]!) * t, a[2]! + (c[2]! - a[2]!) * t, a[3]! + (c[3]! - a[3]!) * t)
      }
    }
  }
  const material = makeMaterial(1, 0.035, 1.55)
  const points = new Points(geometry(pts), material)
  points.frustumCulled = false
  return { points, material }
}

/** Fibração de Hopf: `fibers` círculos de S³, cada um com `perFiber` pontos. */
export function hopf(fibers = 72, perFiber = 40): HyperObject {
  const pts: number[] = []
  const seeds: number[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let f = 0; f < fibers; f++) {
    // Pontos base bem distribuídos na esfera S² (espiral de Fibonacci), longe do polo sul.
    const c = 0.92 - (f / (fibers - 1)) * 1.75
    const r = Math.sqrt(1 - c * c)
    const a = Math.cos(golden * f) * r
    const b = Math.sin(golden * f) * r
    const k = 1 / Math.sqrt(2 * (1 + c))
    for (let i = 0; i < perFiber; i++) {
      const t = (i / perFiber) * Math.PI * 2
      const ct = Math.cos(t)
      const st = Math.sin(t)
      // Fibra de Hopf sobre (a, b, c) ∈ S²: um círculo em S³ ⊂ R⁴.
      pts.push(k * (1 + c) * ct, k * (a * st - b * ct), k * (a * ct + b * st), k * (1 + c) * st)
      seeds.push(f / fibers)
    }
  }
  // Perspetiva 4D em vez de estereográfica: nenhum círculo foge para o infinito.
  const material = makeMaterial(1, 0.03, 1.0, 2.2)
  const points = new Points(geometry(pts, seeds), material)
  points.frustumCulled = false
  return { points, material }
}

const tmp = new Matrix4()

/** Rotação 4D composta: planos XW, YW, ZW e XY. */
export function rotation4D(out: Matrix4, xw: number, yw: number, zw: number, xy: number): Matrix4 {
  const c1 = Math.cos(xw), s1 = Math.sin(xw)
  const c2 = Math.cos(yw), s2 = Math.sin(yw)
  const c3 = Math.cos(zw), s3 = Math.sin(zw)
  const c4 = Math.cos(xy), s4 = Math.sin(xy)
  // Matrix4.set recebe por linhas; aqui funciona como matriz genérica 4×4 sobre (x, y, z, w).
  out.set(c1, 0, 0, -s1, 0, 1, 0, 0, 0, 0, 1, 0, s1, 0, 0, c1)
  out.multiply(tmp.set(1, 0, 0, 0, 0, c2, 0, -s2, 0, 0, 1, 0, 0, s2, 0, c2))
  out.multiply(tmp.set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, c3, -s3, 0, 0, s3, c3))
  out.multiply(tmp.set(c4, -s4, 0, 0, s4, c4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1))
  return out
}
