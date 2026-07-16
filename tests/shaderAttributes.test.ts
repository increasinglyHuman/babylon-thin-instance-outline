/**
 * shaderAttributes.test.ts — regression guard for #15 (WebGPU pipeline validation).
 *
 * The outline ShaderMaterial must NOT declare world0..world3 in its attributes
 * list. Babylon's ShaderMaterial appends `options.attributes` verbatim and then
 * calls PushAttributesForInstances(), which adds world0..3 itself whenever the
 * mesh uses instances — always true for the outline mesh, a thin-instance host
 * by construction.
 *
 * Declaring them ourselves duplicated them: world0 resolved to shader location 2
 * twice. WebGL binds attributes by name and tolerates it. WebGPU validates the
 * whole vertex state and rejects the pipeline —
 *   "Attribute shader location (2) is used more than once"
 * — which took down the ENTIRE scene, not just the outline. Every published
 * version through 1.3.0 was unusable on WebGPU because of this line.
 *
 * NullEngine cannot catch that (no GPU pipeline validation), so this asserts the
 * precondition directly. Visual proof lives in the demo's `?webgpu` mode.
 *
 * Depends on: @babylonjs/core (NullEngine, real Mesh/Scene), src/ThinInstanceOutliner
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Color3, Matrix, Mesh, MeshBuilder, NullEngine, Scene, ShaderMaterial } from '@babylonjs/core'
import { ThinInstanceOutliner } from '../src'
import { _resetForTest } from '../src/outlineShader'

let engine: NullEngine
let scene: Scene
let outliner: ThinInstanceOutliner

/** The attributes list handed to Babylon's ShaderMaterial for the outline mesh. */
function outlineAttributes(host: Mesh): string[] {
  const outline = host.metadata.outlineMesh as Mesh
  const material = outline.material as ShaderMaterial
  return (material as unknown as { _options: { attributes: string[] } })._options.attributes
}

function buildHost(scene: Scene): Mesh {
  const host = MeshBuilder.CreateBox('host', { size: 1 }, scene)
  const matrices = new Float32Array(3 * 16)
  for (let i = 0; i < 3; i++) Matrix.Translation(i * 2, 0, 0).copyToArray(matrices, i * 16)
  host.thinInstanceSetBuffer('matrix', matrices, 16, false)
  return host
}

beforeEach(() => {
  _resetForTest()
  engine = new NullEngine()
  scene = new Scene(engine)
  outliner = new ThinInstanceOutliner(scene)
})

afterEach(() => {
  outliner.dispose()
  scene.dispose()
  engine.dispose()
})

describe('#15 — outline shader attribute registration', () => {
  it('does NOT declare world0..world3 (Babylon adds them for instanced meshes)', () => {
    const host = buildHost(scene)
    outliner.attach(host)
    const attrs = outlineAttributes(host)

    for (const world of ['world0', 'world1', 'world2', 'world3']) {
      expect(attrs, `"${world}" must not be declared — PushAttributesForInstances adds it`).not.toContain(world)
    }
  })

  it('declares no duplicate attributes', () => {
    const host = buildHost(scene)
    outliner.attach(host)
    const attrs = outlineAttributes(host)
    expect(attrs.length).toBe(new Set(attrs).size)
  })

  it('still declares what the shader actually needs from us', () => {
    const host = buildHost(scene)
    outliner.attach(host)
    const attrs = outlineAttributes(host)
    expect(attrs).toContain('position')
    expect(attrs).toContain('normal')
    expect(attrs).toContain('outlineInstanceColor')
  })

  it('adds the phase attribute only when an effect consumes it', () => {
    const plain = buildHost(scene)
    outliner.attach(plain)
    expect(outlineAttributes(plain)).not.toContain('outlineInstancePhase')

    const fancy = buildHost(scene)
    fancy.name = 'fancy'
    outliner.attach(fancy, { pulse: { speed: 2, amplitude: 0.5 } })
    expect(outlineAttributes(fancy)).toContain('outlineInstancePhase')
  })

  it('holds for every effect combination (each compiles its own variant)', () => {
    const combos = [
      { colorCycle: { period: 3 } },
      { edgeFlow: { axis: 'y' as const, speed: 1, width: 0.2 } },
      { rimFlow: { speed: 0.5, width: 0.15 } },
      { sizzle: { scale: 8, speed: 3 } },
      {
        pulse: { speed: 2, amplitude: 0.4 },
        colorCycle: { period: 4 },
        sizzle: { scale: 6, speed: 2 },
        color: new Color3(1, 0, 0),
      },
    ]
    combos.forEach((opts, i) => {
      const host = buildHost(scene)
      host.name = `combo${i}`
      outliner.attach(host, opts)
      const attrs = outlineAttributes(host)
      expect(attrs, `combo ${i} leaked world0`).not.toContain('world0')
      expect(attrs.length, `combo ${i} has duplicates`).toBe(new Set(attrs).size)
    })
  })
})
