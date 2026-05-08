/**
 * Behavioral tests for ThinInstanceOutliner against Babylon's NullEngine.
 * No WebGL required; real Mesh/Scene/ShaderMaterial objects are used so the
 * tests exercise the actual API surface, not a mocked surrogate.
 *
 * Visual correctness (the outline actually appearing around the host) is verified
 * separately via demo/index.html — those concerns are out of scope for unit tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  NullEngine,
  Scene,
} from '@babylonjs/core'
import { ThinInstanceOutliner } from '../src'
import { _resetForTest } from '../src/outlineShader'

const HOST_INSTANCE_COUNT = 5

function buildHostWithThinInstances(scene: Scene): Mesh {
  const host = MeshBuilder.CreateBox('host', { size: 1 }, scene)
  const buf = new Float32Array(HOST_INSTANCE_COUNT * 16)
  for (let i = 0; i < HOST_INSTANCE_COUNT; i++) {
    Matrix.Translation(i * 2, 0, 0).copyToArray(buf, i * 16)
  }
  host.thinInstanceSetBuffer('matrix', buf, 16, false)
  return host
}

describe('ThinInstanceOutliner', () => {
  let engine: NullEngine
  let scene: Scene
  let host: Mesh
  let outliner: ThinInstanceOutliner

  beforeEach(() => {
    _resetForTest()
    engine = new NullEngine()
    scene = new Scene(engine)
    host = buildHostWithThinInstances(scene)
    outliner = new ThinInstanceOutliner(scene)
  })

  afterEach(() => {
    outliner.dispose()
    scene.dispose()
    engine.dispose()
  })

  describe('attach', () => {
    it('creates an outline mesh as a parallel sibling of the host', () => {
      outliner.attach(host)
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(outlineMesh).toBeDefined()
      // sibling, NEVER child — see ADR-001 §3.4
      expect(outlineMesh.parent).toBeNull()
      expect(outlineMesh.metadata.isOutlineFor).toBe(host.uniqueId)
    })

    it('mirrors the host thinInstanceCount on the outline mesh', () => {
      outliner.attach(host)
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(outlineMesh.thinInstanceCount).toBe(HOST_INSTANCE_COUNT)
    })

    it('renders the outline before the host (renderingGroupId offset = -1 by default, clamped to 0 when host is in 0)', () => {
      outliner.attach(host)
      const outlineMesh: Mesh = host.metadata.outlineMesh
      // Host defaults to renderingGroupId 0, so outline clamps to 0 (not -1)
      expect(outlineMesh.renderingGroupId).toBe(0)
    })

    it('honors a positive renderingGroupOffset when feasible', () => {
      host.renderingGroupId = 2
      outliner.attach(host, { renderingGroupOffset: -1 })
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(outlineMesh.renderingGroupId).toBe(1)
    })

    it('is idempotent (re-attaching same host is a no-op)', () => {
      outliner.attach(host)
      const first: Mesh = host.metadata.outlineMesh
      outliner.attach(host)
      expect(host.metadata.outlineMesh).toBe(first)
    })

    it('silently no-ops when host has zero thin instances', () => {
      const empty = MeshBuilder.CreateBox('empty', { size: 1 }, scene)
      outliner.attach(empty)
      expect(empty.metadata?.outlineMesh).toBeUndefined()
    })

    it('configures the material for back-face-only rendering (cullBackFaces = false culls FRONT)', () => {
      outliner.attach(host)
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(outlineMesh.material).toBeDefined()
      expect(outlineMesh.material!.backFaceCulling).toBe(true)
      expect(outlineMesh.material!.cullBackFaces).toBe(false)
    })
  })

  describe('highlight / clear', () => {
    beforeEach(() => outliner.attach(host))

    it('highlight + isHighlighted track per-instance state', () => {
      expect(outliner.isHighlighted(host, 2)).toBe(false)
      outliner.highlight(host, 2)
      expect(outliner.isHighlighted(host, 2)).toBe(true)
    })

    it('writes the source matrix at the outline buffer at the same index when highlighting', () => {
      outliner.highlight(host, 2)
      const outlineMesh: Mesh = host.metadata.outlineMesh
      const outlineMatrices = outlineMesh.thinInstanceGetWorldMatrices()
      const sourceMatrices = host.thinInstanceGetWorldMatrices()
      // Match within float tolerance; exact byte equality is implementation detail.
      const a = outlineMatrices[2].m
      const b = sourceMatrices[2].m
      for (let i = 0; i < 16; i++) {
        expect(a[i]).toBeCloseTo(b[i], 6)
      }
    })

    it('writes ZERO_SCALE at the outline buffer when clearing', () => {
      outliner.highlight(host, 2)
      outliner.clear(host, 2)
      expect(outliner.isHighlighted(host, 2)).toBe(false)

      const outlineMesh: Mesh = host.metadata.outlineMesh
      const outlineMatrices = outlineMesh.thinInstanceGetWorldMatrices()
      const m = outlineMatrices[2].m
      // columns 0,1,2 zero; column 3 = (0,0,0,1)
      for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 4; row++) {
          expect(m[col * 4 + row]).toBeCloseTo(0, 6)
        }
      }
      expect(m[15]).toBeCloseTo(1, 6)
    })

    it('clearAll hides every shown instance in one batch', () => {
      outliner.highlight(host, 0)
      outliner.highlight(host, 2)
      outliner.highlight(host, 4)
      outliner.clearAll(host)
      expect(outliner.isHighlighted(host, 0)).toBe(false)
      expect(outliner.isHighlighted(host, 2)).toBe(false)
      expect(outliner.isHighlighted(host, 4)).toBe(false)
    })

    it('out-of-range index is a silent no-op', () => {
      outliner.highlight(host, 999)
      outliner.highlight(host, -1)
      expect(outliner.isHighlighted(host, 999)).toBe(false)
    })

    it('highlight on un-attached host is a silent no-op', () => {
      const other = buildHostWithThinInstances(scene)
      outliner.highlight(other, 0)
      expect(outliner.isHighlighted(other, 0)).toBe(false)
    })
  })

  describe('refresh', () => {
    it('re-mirrors the host matrices for currently-shown instances', () => {
      outliner.attach(host)
      outliner.highlight(host, 1)

      // Move the host's instance 1 to a new position
      const newMatrix = Matrix.Translation(100, 50, -25)
      host.thinInstanceSetMatrixAt(1, newMatrix)

      // Outline buffer is now stale until refresh()
      outliner.refresh(host, 1)

      const outlineMesh: Mesh = host.metadata.outlineMesh
      const outlineMatrices = outlineMesh.thinInstanceGetWorldMatrices()
      // Translation lives in column 3 (elements 12-14)
      expect(outlineMatrices[1].m[12]).toBeCloseTo(100, 6)
      expect(outlineMatrices[1].m[13]).toBeCloseTo(50, 6)
      expect(outlineMatrices[1].m[14]).toBeCloseTo(-25, 6)
    })

    it('refresh without index refreshes all currently-shown instances', () => {
      outliner.attach(host)
      outliner.highlight(host, 0)
      outliner.highlight(host, 3)

      host.thinInstanceSetMatrixAt(0, Matrix.Translation(7, 0, 0))
      host.thinInstanceSetMatrixAt(3, Matrix.Translation(0, 7, 0))

      outliner.refresh(host)

      const outlineMesh: Mesh = host.metadata.outlineMesh
      const ms = outlineMesh.thinInstanceGetWorldMatrices()
      expect(ms[0].m[12]).toBeCloseTo(7, 6)
      expect(ms[3].m[13]).toBeCloseTo(7, 6)
    })

    it('refresh on un-attached host is a silent no-op', () => {
      expect(() => outliner.refresh(host)).not.toThrow()
    })
  })

  describe('detach / dispose', () => {
    it('detach disposes the outline mesh and clears host metadata', () => {
      outliner.attach(host)
      const outlineMesh: Mesh = host.metadata.outlineMesh
      outliner.detach(host)
      expect(outlineMesh.isDisposed()).toBe(true)
      expect(host.metadata.outlineMesh).toBeUndefined()
    })

    it('detach is idempotent', () => {
      outliner.attach(host)
      outliner.detach(host)
      expect(() => outliner.detach(host)).not.toThrow()
    })

    it('dispose detaches every host', () => {
      const otherHost = buildHostWithThinInstances(scene)
      outliner.attach(host)
      outliner.attach(otherHost)
      const a: Mesh = host.metadata.outlineMesh
      const b: Mesh = otherHost.metadata.outlineMesh

      outliner.dispose()
      expect(a.isDisposed()).toBe(true)
      expect(b.isDisposed()).toBe(true)
    })

    it('attach after dispose is a silent no-op', () => {
      outliner.dispose()
      const fresh = buildHostWithThinInstances(scene)
      outliner.attach(fresh)
      expect(fresh.metadata?.outlineMesh).toBeUndefined()
    })
  })

  describe('options', () => {
    it('accepts custom thickness and color at attach', () => {
      outliner.attach(host, { thickness: 0.1, color: new Color3(1, 0, 0) })
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(outlineMesh.material).toBeDefined()
      // ShaderMaterial uniforms aren't introspectable directly without compiling the
      // effect; the meaningful assertion is that attach completed without error and
      // produced a material. Visual verification lives in the demo HTML page.
    })
  })
})
