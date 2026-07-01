/**
 * demo.ts — visual smoke-test for ThinInstanceOutliner against real WebGL.
 * Renders 100 thin-instanced cubes (3 pre-outlined; click toggles per-instance;
 * R clears all; A outlines all) plus an orbiting torus knot exercising
 * single-mesh mode — its outline must visibly track the motion.
 *
 * This file is intentionally thick on inline comments because it doubles as the
 * canonical "how to use this library" example for newcomers.
 */

import {
  ArcRotateCamera,
  Color3,
  Color4,
  Engine,
  HemisphericLight,
  Matrix,
  MeshBuilder,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core'
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

outliner.attach(knot, { color: new Color3(1.0, 0.45, 0.9), thickness: 0.06 })
outliner.highlight(knot, 0)

let knotAngle = 0
scene.onBeforeRenderObservable.add(() => {
  knotAngle += engine.getDeltaTime() * 0.0005
  const orbit = ((GRID - 1) / 2 + 3) * SPACING
  knot.position.set(Math.cos(knotAngle) * orbit, 1.2, Math.sin(knotAngle) * orbit)
  knot.rotation.y = -knotAngle
  knot.rotation.x = knotAngle * 0.7
})

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
  if (pickInfo.pickedMesh === knot) {
    // Single-mesh host: always slot 0.
    if (outliner.isHighlighted(knot, 0)) outliner.clear(knot, 0)
    else outliner.highlight(knot, 0)
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

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase()
  if (key === 'r') outliner.clearAll(host)
  else if (key === 'a') {
    // Random rainbow assignment for the visual flex
    for (let i = 0; i < COUNT; i++) {
      const hue = (i * 137.5) % 360 // golden-angle hue spread
      outliner.highlight(host, i, { color: hslToColor3(hue, 0.7, 0.65) })
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
