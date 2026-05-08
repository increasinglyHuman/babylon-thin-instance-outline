/**
 * demo.ts — visual smoke-test for ThinInstanceOutliner against real WebGL.
 * Renders 100 thin-instanced cubes. 3 are pre-outlined. Click toggles per-instance.
 * R clears all; A outlines all.
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

// --- Outliner: pale blue, 0.045 thickness for chunky readability
const outliner = new ThinInstanceOutliner(scene)
outliner.attach(host, {
  color: new Color3(0.55, 0.8, 1.0),
  thickness: 0.045,
})

// Pre-outline 3 instances per the README quick-start contract
for (const idx of [8, 42, 73]) outliner.highlight(host, idx)

// --- Picking: click to toggle outline per-instance
scene.onPointerObservable.add((info) => {
  if (info.type !== PointerEventTypes.POINTERDOWN) return
  const pickInfo = info.pickInfo
  if (!pickInfo?.hit || pickInfo.pickedMesh !== host) return
  // For thin-instances, Babylon exposes the chosen index via `thinInstanceIndex`
  const idx = pickInfo.thinInstanceIndex
  if (idx === undefined || idx < 0) return
  if (outliner.isHighlighted(host, idx)) outliner.clear(host, idx)
  else outliner.highlight(host, idx)
})

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase()
  if (key === 'r') outliner.clearAll(host)
  else if (key === 'a') {
    for (let i = 0; i < COUNT; i++) outliner.highlight(host, i)
  }
})

// --- Render loop
engine.runRenderLoop(() => scene.render())
window.addEventListener('resize', () => engine.resize())
