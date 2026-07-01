/**
 * demo.ts — visual smoke-test for ThinInstanceOutliner against real WebGL.
 * Renders 100 thin-instanced cubes (3 pre-outlined; click toggles per-instance;
 * R clears all; A outlines a phased rainbow), an orbiting torus knot exercising
 * single-mesh mode, and a slowly-turning greatsword GLB running the full
 * ADR-004 effects stack (edgeFlow along the blade + pulse + colorCycle on
 * the knot). Every outline must visibly track its host's motion.
 *
 * This file is intentionally thick on inline comments because it doubles as the
 * canonical "how to use this library" example for newcomers.
 */

import {
  AbstractMesh,
  ArcRotateCamera,
  Color3,
  Color4,
  Engine,
  HemisphericLight,
  ImportMeshAsync,
  Matrix,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF' // registers the .glb loader (side effect)
import { ThinInstanceOutliner } from '../src'

const canvas = document.getElementById('render') as HTMLCanvasElement

const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true })
const scene = new Scene(engine)
scene.clearColor = new Color4(0.05, 0.07, 0.1, 1)

const camera = new ArcRotateCamera('cam', -Math.PI / 3, Math.PI / 3.2, 28, Vector3.Zero(), scene)
camera.attachControl(canvas, true)
camera.wheelPrecision = 30

new HemisphericLight('h', new Vector3(0.4, 1, 0.3), scene)

// --- Host mesh: a 10x10 grid of thin-instanced cubes
const GRID = 10
const SPACING = 1.6
const COUNT = GRID * GRID

const host = MeshBuilder.CreateBox('host', { size: 1 }, scene)
const hostMaterial = new StandardMaterial('hostMat', scene)
hostMaterial.diffuseColor = new Color3(0.45, 0.5, 0.6)
hostMaterial.specularColor = new Color3(0.1, 0.1, 0.12)
host.material = hostMaterial

const matrixBuffer = new Float32Array(COUNT * 16)
for (let i = 0; i < COUNT; i++) {
  const x = (i % GRID) - (GRID - 1) / 2
  const z = Math.floor(i / GRID) - (GRID - 1) / 2
  Matrix.Translation(x * SPACING, 0, z * SPACING).copyToArray(matrixBuffer, i * 16)
}
host.thinInstanceSetBuffer('matrix', matrixBuffer, 16, false)
host.thinInstanceEnablePicking = true

// --- Outliner: pale blue default, 0.045 thickness for chunky readability
const outliner = new ThinInstanceOutliner(scene)
outliner.attach(host, {
  color: new Color3(0.55, 0.8, 1.0),
  thickness: 0.045,
  // Per-host pulse: every highlighted cube breathes. The 'A' rainbow assigns
  // per-instance phases so the grid pulses as a traveling wave, not in lockstep.
  pulse: { speed: 2.5, amplitude: 0.4 },
})

// Pre-outline 3 instances with different per-instance colors:
// red, lime, gold — demonstrates per-call HighlightOptions.color override.
const PRESET_COLORS: Array<[number, Color3]> = [
  [8,  new Color3(1.0, 0.25, 0.25)],
  [42, new Color3(0.4, 1.0, 0.3)],
  [73, new Color3(1.0, 0.85, 0.2)],
]
for (const [idx, color] of PRESET_COLORS) outliner.highlight(host, idx, { color })

// --- Single-mesh mode (ADR-004 §2.2): an orbiting torus knot with ZERO thin
// instances. attach() detects that and mirrors the knot's world matrix into an
// internal 1-element thin instance every frame — the outline tracks the motion
// with no consumer code (no refresh() calls). Click the knot to toggle.
const knot = MeshBuilder.CreateTorusKnot(
  'knot',
  { radius: 0.9, tube: 0.28, radialSegments: 96, tubularSegments: 24 },
  scene,
)
const knotMaterial = new StandardMaterial('knotMat', scene)
knotMaterial.diffuseColor = new Color3(0.75, 0.55, 0.35)
knotMaterial.specularColor = new Color3(0.2, 0.18, 0.12)
knot.material = knotMaterial

// Knot effects: colorCycle rotates the outline hue continuously; pulse breathes
// it. Both driven by the outliner-global clock — zero per-frame consumer code.
outliner.attach(knot, {
  color: new Color3(1.0, 0.45, 0.9),
  thickness: 0.06,
  colorCycle: { period: 5 },
  pulse: { speed: 1.8, amplitude: 0.3 },
})
outliner.highlight(knot, 0)

let knotAngle = 0
scene.onBeforeRenderObservable.add(() => {
  knotAngle += engine.getDeltaTime() * 0.0005
  const orbit = ((GRID - 1) / 2 + 3) * SPACING
  knot.position.set(Math.cos(knotAngle) * orbit, 1.2, Math.sin(knotAngle) * orbit)
  knot.rotation.y = -knotAngle
  knot.rotation.x = knotAngle * 0.7
})

// --- Greatsword GLB: the ADR-004 motivating use case — "energy traveling
// along a sword's edge". edgeFlow sends a bright band down the blade's long
// axis while pulse breathes the whole outline. Single-mesh mode again: the
// sword turns slowly and the outline tracks via the world-matrix mirror.
let sword: Mesh | null = null
ImportMeshAsync('./assets/greatsword.glb', scene)
  .then((result) => {
    // Rigged GLBs carry transform nodes and possibly multiple primitives —
    // outline the largest mesh that actually has geometry.
    const withGeometry = result.meshes.filter(
      (m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0,
    )
    if (withGeometry.length === 0) return
    sword = withGeometry.reduce((a, b) => (a.getTotalVertices() >= b.getTotalVertices() ? a : b))

    // Deterministic look without an environment texture: GLB PBR materials
    // render near-black with only a hemispheric light, so swap in steel.
    const steel = new StandardMaterial('steel', scene)
    steel.diffuseColor = new Color3(0.55, 0.58, 0.65)
    steel.specularColor = new Color3(0.5, 0.5, 0.55)
    for (const m of withGeometry) m.material = steel

    // Float the sword above the grid, point-up, turning like a legendary drop.
    const root = result.meshes[0] as AbstractMesh
    root.position.set(0, 3.2, 0)
    root.scaling.setAll(1.5)
    scene.onBeforeRenderObservable.add(() => {
      root.rotation.y += engine.getDeltaTime() * 0.0004
    })

    // The blade's long axis in OBJECT space: measure the geometry extents and
    // pick the dominant one, so the demo doesn't care how the asset was authored.
    const ext = sword.getBoundingInfo().boundingBox.extendSize
    const axis: 'x' | 'y' | 'z' =
      ext.x > ext.y ? (ext.x > ext.z ? 'x' : 'z') : ext.y > ext.z ? 'y' : 'z'

    outliner.attach(sword, {
      color: new Color3(0.35, 0.65, 1.0),
      thickness: 0.02,
      pulse: { speed: 1.5, amplitude: 0.35 },
      edgeFlow: { axis, speed: 0.5, width: 0.08, accentColor: new Color3(0.8, 1.0, 1.0), boost: 2.0 },
    })
    outliner.highlight(sword, 0)
  })
  .catch((e) => console.warn('[demo] greatsword failed to load:', e))

// --- Picking: click to toggle outline per-instance
// Cycles through a small palette so each click can introduce a new color.
const PALETTE: Color3[] = [
  new Color3(0.55, 0.8, 1.0),    // pale blue (default)
  new Color3(1.0, 0.4, 0.6),     // pink
  new Color3(0.6, 0.4, 1.0),     // violet
  new Color3(0.3, 1.0, 0.85),    // teal
  new Color3(1.0, 0.7, 0.2),     // amber
]
let paletteCursor = 0

scene.onPointerObservable.add((info) => {
  if (info.type !== PointerEventTypes.POINTERDOWN) return
  const pickInfo = info.pickInfo
  if (!pickInfo?.hit) return
  if (pickInfo.pickedMesh === knot || (sword && pickInfo.pickedMesh === sword)) {
    // Single-mesh hosts: always slot 0.
    const m = pickInfo.pickedMesh as Mesh
    if (outliner.isHighlighted(m, 0)) outliner.clear(m, 0)
    else outliner.highlight(m, 0)
    return
  }
  if (pickInfo.pickedMesh !== host) return
  const idx = pickInfo.thinInstanceIndex
  if (idx === undefined || idx < 0) return
  if (outliner.isHighlighted(host, idx)) {
    outliner.clear(host, idx)
  } else {
    const color = PALETTE[paletteCursor++ % PALETTE.length]
    outliner.highlight(host, idx, { color })
  }
})

// Live-tuning showcase (setEffectParams — no shader recompile): [ ] adjust the
// sword's flow-band width, - = adjust its outline thickness.
let swordFlowWidth = 0.08
let swordThickness = 0.02

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase()
  if (sword && (key === '[' || key === ']')) {
    swordFlowWidth = Math.min(0.5, Math.max(0.02, swordFlowWidth + (key === ']' ? 0.02 : -0.02)))
    outliner.setEffectParams(sword, { edgeFlow: { width: swordFlowWidth } })
    return
  }
  if (sword && (key === '-' || key === '=')) {
    swordThickness = Math.min(0.12, Math.max(0.005, swordThickness + (key === '=' ? 0.005 : -0.005)))
    outliner.setEffectParams(sword, { thickness: swordThickness })
    return
  }
  if (key === 'r') {
    outliner.clearAll(host)
    outliner.clear(knot, 0)
    if (sword) outliner.clear(sword, 0)
  }
  else if (key === 'a') {
    // Random rainbow assignment for the visual flex; phase spreads the pulse
    // across the grid so it reads as a wave (ADR-004 §2.4).
    for (let i = 0; i < COUNT; i++) {
      const hue = (i * 137.5) % 360 // golden-angle hue spread
      outliner.highlight(host, i, { color: hslToColor3(hue, 0.7, 0.65), phase: i / COUNT })
    }
  }
})

function hslToColor3(h: number, s: number, l: number): Color3 {
  // Pulled inline to avoid pulling another helper file into the demo.
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    h < 60  ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] :
              [c, 0, x]
  return new Color3(r + m, g + m, b + m)
}

// --- Render loop
engine.runRenderLoop(() => scene.render())
window.addEventListener('resize', () => engine.resize())

// Debug handle (used by tests/playwright; harmless in shipped lib since this is the demo)
;(window as unknown as { __demo: unknown }).__demo = { engine, scene, host, outliner }
