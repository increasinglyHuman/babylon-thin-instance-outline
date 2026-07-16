/**
 * matrixSourceOfTruth.test.ts — regression tests for ADR-006.
 *
 * Guards the two consumer patterns that Babylon's memoised
 * `thinInstanceGetWorldMatrices()` silently serves stale data to:
 *   1. writing directly into your own matrix Float32Array (the bulk path), and
 *   2. reusing one scratch Matrix across `thinInstanceSetMatrixAt` calls.
 *
 * Both froze outlines in place before ADR-006. Every test here fails on the
 * pre-ADR-006 read path — that is the point of them.
 *
 * Depends on: @babylonjs/core (NullEngine, real Mesh/Scene), src/ThinInstanceOutliner
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Matrix, Mesh, MeshBuilder, NullEngine, Scene } from '@babylonjs/core'
import { ThinInstanceOutliner } from '../src'
import { _resetForTest } from '../src/outlineShader'

const COUNT = 5

let engine: NullEngine
let scene: Scene
let outliner: ThinInstanceOutliner

/** Read the outline mesh's matrix buffer — what the GPU would actually draw. */
function outlineMatrixX(host: Mesh, index: number): number {
  const outline = host.metadata.outlineMesh as Mesh
  const data = (
    outline as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } }
  )._thinInstanceDataStorage.matrixData
  return data[index * 16 + 12] // translation.x
}

function buildHost(scene: Scene): { host: Mesh; matrices: Float32Array } {
  const host = MeshBuilder.CreateBox('host', { size: 1 }, scene)
  const matrices = new Float32Array(COUNT * 16)
  for (let i = 0; i < COUNT; i++) Matrix.Translation(i * 2, 0, 0).copyToArray(matrices, i * 16)
  host.thinInstanceSetBuffer('matrix', matrices, 16, false)
  return { host, matrices }
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

describe('ADR-006 — matrix source of truth', () => {
  it('refresh() tracks an instance moved by a DIRECT buffer write', () => {
    const { host, matrices } = buildHost(scene)
    outliner.attach(host)
    outliner.highlight(host, 1)
    expect(outlineMatrixX(host, 1)).toBe(2)

    // The documented bulk path: mutate the array we own, then tell Babylon.
    Matrix.Translation(999, 0, 0).copyToArray(matrices, 1 * 16)
    host.thinInstanceBufferUpdated('matrix')
    outliner.refresh(host)

    expect(outlineMatrixX(host, 1)).toBe(999)
  })

  it('highlight() reads a post-attach direct write, not the attach-time value', () => {
    const { host, matrices } = buildHost(scene)
    outliner.attach(host)
    outliner.highlight(host, 0) // populates Babylon's cache at the old value
    outliner.clear(host, 0)

    Matrix.Translation(42, 0, 0).copyToArray(matrices, 3 * 16)
    host.thinInstanceBufferUpdated('matrix')
    outliner.highlight(host, 3)

    expect(outlineMatrixX(host, 3)).toBe(42)
  })

  it('refresh() is correct when the consumer REUSES one scratch Matrix', () => {
    const { host } = buildHost(scene)
    outliner.attach(host)
    for (let i = 0; i < COUNT; i++) outliner.highlight(host, i)

    // Standard perf pattern: allocate once, reuse. Babylon's cache stores this
    // by reference, so every cached slot ends up aliasing the SAME object.
    const scratch = Matrix.Identity()
    for (let i = 0; i < COUNT; i++) {
      scratch.copyFrom(Matrix.Translation(i * 100, 0, 0))
      host.thinInstanceSetMatrixAt(i, scratch, false)
    }
    host.thinInstanceBufferUpdated('matrix')
    outliner.refresh(host)

    // Without ADR-006 every slot reads 400 (the last value written).
    for (let i = 0; i < COUNT; i++) expect(outlineMatrixX(host, i)).toBe(i * 100)
  })

  it('refresh(index) tracks a single moved instance', () => {
    const { host, matrices } = buildHost(scene)
    outliner.attach(host)
    outliner.highlight(host, 2)

    Matrix.Translation(77, 0, 0).copyToArray(matrices, 2 * 16)
    host.thinInstanceBufferUpdated('matrix')
    outliner.refresh(host, 2)

    expect(outlineMatrixX(host, 2)).toBe(77)
  })

  it('attach() leaves a STATIC host buffer static (no silent flip to updatable)', () => {
    const host = MeshBuilder.CreateBox('host', { size: 1 }, scene)
    const matrices = new Float32Array(COUNT * 16)
    for (let i = 0; i < COUNT; i++) Matrix.Translation(i * 2, 0, 0).copyToArray(matrices, i * 16)
    host.thinInstanceSetBuffer('matrix', matrices, 16, true) // STATIC — Babylon's default

    const storage = (
      host as unknown as { _thinInstanceDataStorage: { matrixBuffer: { isUpdatable(): boolean } } }
    )._thinInstanceDataStorage
    const bufferBefore = storage.matrixBuffer
    expect(storage.matrixBuffer.isUpdatable()).toBe(false)

    outliner.attach(host)

    expect(storage.matrixBuffer.isUpdatable()).toBe(false)
    expect(storage.matrixBuffer).toBe(bufferBefore) // not disposed + recreated
  })

  it('attach() does not disturb the host matrix array identity or values', () => {
    const { host, matrices } = buildHost(scene)
    outliner.attach(host)

    const live = (
      host as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } }
    )._thinInstanceDataStorage.matrixData
    expect(live).toBe(matrices)
    expect(host.thinInstanceCount).toBe(COUNT)
    for (let i = 0; i < COUNT; i++) expect(matrices[i * 16 + 12]).toBe(i * 2)
  })
})
