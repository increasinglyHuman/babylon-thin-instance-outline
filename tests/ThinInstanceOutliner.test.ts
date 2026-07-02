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
  Quaternion,
  Scene,
  VertexBuffer,
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

    it('a host with zero thin instances attaches in single-mesh mode (ADR-004 §2.2)', () => {
      // v1.0.0 no-op'd here; since ADR-004 ratification a plain mesh gets an
      // internal 1-element thin-instance outline.
      const plain = MeshBuilder.CreateBox('plain', { size: 1 }, scene)
      outliner.attach(plain)
      const outlineMesh: Mesh = plain.metadata.outlineMesh
      expect(outlineMesh).toBeDefined()
      expect(outlineMesh.thinInstanceCount).toBe(1)
    })

    it('silently no-ops when host has no vertex data', () => {
      const bare = new Mesh('bare', scene)
      outliner.attach(bare)
      expect(bare.metadata?.outlineMesh).toBeUndefined()
    })

    it('configures the material for back-face-only rendering (cullBackFaces = false culls FRONT)', () => {
      outliner.attach(host)
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(outlineMesh.material).toBeDefined()
      expect(outlineMesh.material!.backFaceCulling).toBe(true)
      expect(outlineMesh.material!.cullBackFaces).toBe(false)
    })

    it('REGRESSION: outline mesh always enters the active list (no frustum culling)', () => {
      // Without alwaysSelectAsActiveMesh = true, the outline mesh's stale
      // bounding info (tied to the local geometry, not the spread-out thin-
      // instance positions) gets frustum-culled whenever the camera target is
      // far from world origin — observed by Allen 2026-05-07 on a closeup of
      // cube 8 at world (5.6, 0, -7.2). Lock it in.
      outliner.attach(host)
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(outlineMesh.alwaysSelectAsActiveMesh).toBe(true)
    })

    it('REGRESSION: outline mesh has unique geometry so its matrix buffer cannot clobber host', () => {
      // Thin-instance state lives on the Geometry. The outline mesh is built
      // from scratch with copied vertex data (NOT cloned — clone shares the
      // geometry, and even clone→makeGeometryUnique disturbed the host's
      // thin-instance bindings on WebGPU; see the test below). Lock in that the
      // geometries are distinct and the copy is complete.
      outliner.attach(host)
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(outlineMesh.geometry).not.toBe(host.geometry)
      expect(outlineMesh.getTotalVertices()).toBe(host.getTotalVertices())
      expect(outlineMesh.getTotalIndices()).toBe(host.getTotalIndices())
    })

    it('REGRESSION: attach leaves the host thin-instance state fully intact (WebGPU blanking, 2026-07-01)', () => {
      // On WebGPU, building the outline via host.clone() + makeGeometryUnique()
      // disturbed the host's world0..3 bindings: the host's own thin instances
      // stopped rendering (first attach per host, imported-GLB meshes) until
      // its matrix buffer was re-set. Assert the host's observable thin-instance
      // state is byte-identical and still bound after attach.
      const geometryBefore = host.geometry
      const matricesBefore = host.thinInstanceGetWorldMatrices().map((m) => Array.from(m.m))

      outliner.attach(host)

      expect(host.geometry).toBe(geometryBefore)
      expect(host.thinInstanceCount).toBe(HOST_INSTANCE_COUNT)
      const matricesAfter = host.thinInstanceGetWorldMatrices().map((m) => Array.from(m.m))
      expect(matricesAfter).toEqual(matricesBefore)
      for (const kind of ['world0', 'world1', 'world2', 'world3']) {
        expect(host.getVertexBuffer(kind)).toBeTruthy()
      }
    })

    it('REGRESSION: attach preserves a host thinInstanceCount smaller than its buffer capacity', () => {
      // The defensive matrix-buffer re-set inside attach() must not silently
      // bump thinInstanceCount back up to buffer capacity.
      const bigHost = MeshBuilder.CreateBox('bigHost', { size: 1 }, scene)
      const buf = new Float32Array(10 * 16)
      for (let i = 0; i < 10; i++) {
        Matrix.Translation(i, 0, 0).copyToArray(buf, i * 16)
      }
      bigHost.thinInstanceSetBuffer('matrix', buf, 16, false)
      bigHost.thinInstanceCount = 6 // render fewer than capacity
      outliner.attach(bigHost)
      expect(bigHost.thinInstanceCount).toBe(6)
    })

    it('mirrors the host local transform onto the outline mesh (independent copies)', () => {
      host.position.set(3, 4, 5)
      host.scaling.set(2, 2, 2)
      host.rotationQuaternion = Quaternion.FromEulerAngles(0, Math.PI / 2, 0)
      outliner.attach(host)
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(outlineMesh.position.asArray()).toEqual([3, 4, 5])
      expect(outlineMesh.scaling.asArray()).toEqual([2, 2, 2])
      expect(outlineMesh.rotationQuaternion?.equals(host.rotationQuaternion)).toBe(true)
      // Copies, not references — mutating the host later must not drag the outline.
      expect(outlineMesh.position).not.toBe(host.position)
      expect(outlineMesh.rotationQuaternion).not.toBe(host.rotationQuaternion)
      expect(outlineMesh.isPickable).toBe(false)
    })

    it('does not pollute pre-existing host metadata (GLB hosts carry gltf extras)', () => {
      // With clone(), the outline mesh shared the host's metadata OBJECT, so
      // tagging the outline also wrote isOutlineFor into the host's metadata.
      host.metadata = { gltf: { extras: true } }
      outliner.attach(host)
      expect(host.metadata.isOutlineFor).toBeUndefined()
      expect(host.metadata.gltf).toEqual({ extras: true })
      expect(host.metadata.outlineMesh.metadata).not.toBe(host.metadata)
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

  describe('per-instance color', () => {
    /** Read the color buffer slot at `index`. Reaches into Babylon's user-thin-
     * instance buffer storage; OK in tests because we own the attribute name. */
    function readColorAt(outlineMesh: Mesh, index: number): [number, number, number, number] {
      const data = outlineMesh._userThinInstanceBuffersStorage?.data?.outlineInstanceColor
      if (!data) throw new Error('color buffer not initialized')
      const base = index * 4
      return [data[base], data[base + 1], data[base + 2], data[base + 3]]
    }

    it('initializes every color slot to the per-attach default', () => {
      outliner.attach(host, { color: new Color3(0.2, 0.5, 0.9) })
      const outlineMesh: Mesh = host.metadata.outlineMesh
      for (let i = 0; i < HOST_INSTANCE_COUNT; i++) {
        const [r, g, b, a] = readColorAt(outlineMesh, i)
        expect(r).toBeCloseTo(0.2, 6)
        expect(g).toBeCloseTo(0.5, 6)
        expect(b).toBeCloseTo(0.9, 6)
        expect(a).toBeCloseTo(1, 6)
      }
    })

    it('highlight with options.color overrides only the targeted slot', () => {
      outliner.attach(host, { color: new Color3(0.2, 0.5, 0.9) })
      outliner.highlight(host, 2, { color: new Color3(1, 0, 0) })
      const outlineMesh: Mesh = host.metadata.outlineMesh

      // Slot 2 → red override
      expect(readColorAt(outlineMesh, 2)).toEqual([1, 0, 0, 1])
      // Other slots → still the attach default
      const [r, g, b] = readColorAt(outlineMesh, 0)
      expect(r).toBeCloseTo(0.2, 6)
      expect(g).toBeCloseTo(0.5, 6)
      expect(b).toBeCloseTo(0.9, 6)
    })

    it('highlight without color leaves the slot color unchanged', () => {
      outliner.attach(host, { color: new Color3(0.2, 0.5, 0.9) })
      outliner.highlight(host, 2, { color: new Color3(1, 0, 0) }) // set red
      outliner.highlight(host, 2)                                 // no color arg
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(readColorAt(outlineMesh, 2)).toEqual([1, 0, 0, 1])
    })

    it('clear does not reset color; a later re-highlight preserves the override', () => {
      outliner.attach(host, { color: new Color3(0.2, 0.5, 0.9) })
      outliner.highlight(host, 2, { color: new Color3(0, 1, 0) })
      outliner.clear(host, 2)
      // Color preserved
      expect(readColorAt(host.metadata.outlineMesh, 2)).toEqual([0, 1, 0, 1])
      // Re-highlight with no color: still green
      outliner.highlight(host, 2)
      expect(readColorAt(host.metadata.outlineMesh, 2)).toEqual([0, 1, 0, 1])
    })
  })

  describe('single-mesh mode (ADR-004 §2.2)', () => {
    let plain: Mesh

    beforeEach(() => {
      plain = MeshBuilder.CreateBox('plain', { size: 1 }, scene)
    })

    it('outline sits at identity; the instance slot carries the host WORLD matrix', () => {
      plain.position.set(3, 4, 5)
      outliner.attach(plain)
      outliner.highlight(plain, 0)

      const outlineMesh: Mesh = plain.metadata.outlineMesh
      // Outline transform must stay identity — the world matrix goes into the
      // slot; mirroring TRS too would double-apply the transform.
      expect(outlineMesh.position.asArray()).toEqual([0, 0, 0])
      const m = outlineMesh.thinInstanceGetWorldMatrices()[0].m
      expect(m[12]).toBeCloseTo(3, 6)
      expect(m[13]).toBeCloseTo(4, 6)
      expect(m[14]).toBeCloseTo(5, 6)
    })

    it('parent transforms are honored (world matrix, not local TRS)', () => {
      const parent = MeshBuilder.CreateBox('parent', { size: 1 }, scene)
      parent.position.set(100, 0, 0)
      plain.parent = parent
      plain.position.set(0, 2, 0)

      outliner.attach(plain)
      outliner.highlight(plain, 0)

      const m = (plain.metadata.outlineMesh as Mesh).thinInstanceGetWorldMatrices()[0].m
      expect(m[12]).toBeCloseTo(100, 6)
      expect(m[13]).toBeCloseTo(2, 6)
    })

    it('render observer tracks a moving host while highlighted', () => {
      outliner.attach(plain)
      outliner.highlight(plain, 0)

      plain.position.set(10, -2, 7)
      scene.onBeforeRenderObservable.notifyObservers(scene)

      const m = (plain.metadata.outlineMesh as Mesh).thinInstanceGetWorldMatrices()[0].m
      expect(m[12]).toBeCloseTo(10, 6)
      expect(m[13]).toBeCloseTo(-2, 6)
      expect(m[14]).toBeCloseTo(7, 6)
    })

    it('render observer does NOT resurrect a cleared outline', () => {
      outliner.attach(plain)
      outliner.highlight(plain, 0)
      outliner.clear(plain, 0)

      plain.position.set(10, 0, 0)
      scene.onBeforeRenderObservable.notifyObservers(scene)

      const m = (plain.metadata.outlineMesh as Mesh).thinInstanceGetWorldMatrices()[0].m
      // Still zero-scale (hidden), despite the host moving
      for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 4; row++) {
          expect(m[col * 4 + row]).toBeCloseTo(0, 6)
        }
      }
    })

    it('detach removes the render observer', () => {
      expect(scene.onBeforeRenderObservable.hasObservers()).toBe(false)
      outliner.attach(plain)
      expect(scene.onBeforeRenderObservable.hasObservers()).toBe(true)
      outliner.detach(plain)
      // hasObservers, not observers.length: Observable.remove() defers the
      // actual splice to a setTimeout(0) but decrements the live count.
      expect(scene.onBeforeRenderObservable.hasObservers()).toBe(false)
    })

    it('every attached host registers a render observer (time driver — ADR-004 §2.3)', () => {
      // v1.0.1 registered observers only for single-mesh hosts (matrix mirror);
      // since v1.0.2 thin-instance hosts get one too, driving the `time` uniform.
      const before = scene.onBeforeRenderObservable.observers.length
      outliner.attach(host) // the thin-instanced fixture
      expect(scene.onBeforeRenderObservable.observers.length).toBe(before + 1)
      outliner.detach(host)
      expect(scene.onBeforeRenderObservable.hasObservers()).toBe(false)
    })

    it('bounds-checks against the single slot (index 1 is a silent no-op)', () => {
      outliner.attach(plain)
      outliner.highlight(plain, 1)
      expect(outliner.isHighlighted(plain, 1)).toBe(false)
    })
  })

  describe('animated effects (ADR-004)', () => {
    /** Read the effect defines off the outline material (public options getter). */
    function definesOf(m: Mesh): string[] {
      return (m.material as import('@babylonjs/core').ShaderMaterial).options.defines
    }

    /** Read the phase buffer slot; same internals-peek pattern as readColorAt. */
    function readPhaseAt(outlineMesh: Mesh, index: number): number | undefined {
      return outlineMesh._userThinInstanceBuffersStorage?.data?.outlineInstancePhase?.[index]
    }

    it('no effects → no effect defines, no phase buffer (v1.0 shader unchanged)', () => {
      outliner.attach(host)
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(definesOf(outlineMesh)).toEqual([])
      expect(readPhaseAt(outlineMesh, 0)).toBeUndefined()
    })

    it('each effect compiles in via its own define', () => {
      outliner.attach(host, {
        pulse: { speed: 2, amplitude: 0.5 },
        colorCycle: { period: 4 },
        edgeFlow: { axis: 'y', speed: 1, width: 0.15 },
      })
      const defines = definesOf(host.metadata.outlineMesh)
      expect(defines).toContain('#define OUTLINE_HAS_EFFECTS')
      expect(defines).toContain('#define OUTLINE_PULSE')
      expect(defines).toContain('#define OUTLINE_COLOR_CYCLE')
      expect(defines).toContain('#define OUTLINE_EDGE_FLOW')
      expect(defines).toContain('#define FLOW_AXIS 1')
    })

    it('any effect allocates the per-instance phase buffer, defaulted to 0', () => {
      outliner.attach(host, { pulse: { speed: 2, amplitude: 0.5 } })
      const outlineMesh: Mesh = host.metadata.outlineMesh
      for (let i = 0; i < HOST_INSTANCE_COUNT; i++) {
        expect(readPhaseAt(outlineMesh, i)).toBe(0)
      }
    })

    it('highlight with phase writes only the targeted slot', () => {
      outliner.attach(host, { pulse: { speed: 2, amplitude: 0.5 } })
      outliner.highlight(host, 2, { phase: 0.7 })
      const outlineMesh: Mesh = host.metadata.outlineMesh
      expect(readPhaseAt(outlineMesh, 2)).toBeCloseTo(0.7, 6)
      expect(readPhaseAt(outlineMesh, 0)).toBe(0)
    })

    it('phase is silently ignored when the host has no effects', () => {
      outliner.attach(host)
      expect(() => outliner.highlight(host, 2, { phase: 0.7 })).not.toThrow()
      expect(outliner.isHighlighted(host, 2)).toBe(true)
    })

    it('sizzle and rimFlow compile in via their defines with uniform defaults (ADR-004 §3.4 / ADR-005)', () => {
      outliner.attach(host, {
        sizzle: { scale: 6, speed: 1.5 },
        rimFlow: { speed: 0.4, width: 0.12 },
      })
      const defines = definesOf(host.metadata.outlineMesh)
      expect(defines).toContain('#define OUTLINE_SIZZLE')
      expect(defines).toContain('#define OUTLINE_RIM_FLOW')
      const material = (host.metadata.outlineMesh as Mesh).material as unknown as {
        _floats: Record<string, number>
      }
      expect(material._floats.sizzleThreshold).toBeCloseTo(0.6, 6) // default
      expect(material._floats.rimSpeed).toBeCloseTo(0.4, 6)
    })

    it('rimFlow computes the object-space bbox center as the rim centroid (ADR-005 §2.1)', () => {
      // Unit cube is origin-centered → centroid (0,0,0). Assert against a
      // translated-geometry host too, so the bbox math (not just origin luck)
      // is what's locked in.
      outliner.attach(host, { rimFlow: { speed: 0.4, width: 0.12 } })
      const centered = (
        (host.metadata.outlineMesh as Mesh).material as unknown as {
          _vectors3: Record<string, { x: number; y: number; z: number }>
        }
      )._vectors3.geomCentroid
      expect(centered.x).toBeCloseTo(0, 6)
      expect(centered.y).toBeCloseTo(0, 6)
      expect(centered.z).toBeCloseTo(0, 6)

      const shifted = MeshBuilder.CreateBox('shifted', { size: 2 }, scene)
      const pos = shifted.getVerticesData(VertexBuffer.PositionKind)!
      const moved = Float32Array.from(pos)
      for (let i = 0; i < moved.length; i += 3) moved[i] += 10 // shift +10 on X
      shifted.setVerticesData(VertexBuffer.PositionKind, moved)
      outliner.attach(shifted, { rimFlow: { speed: 0.4, width: 0.12 } })
      const off = (
        (shifted.metadata.outlineMesh as Mesh).material as unknown as {
          _vectors3: Record<string, { x: number; y: number; z: number }>
        }
      )._vectors3.geomCentroid
      expect(off.x).toBeCloseTo(10, 6)
      expect(off.y).toBeCloseTo(0, 6)
    })

    it('setEffectParams live-tunes sizzle and rimFlow; ignores them when absent', () => {
      outliner.attach(host, { sizzle: { scale: 6, speed: 1.5 } })
      outliner.setEffectParams(host, {
        sizzle: { threshold: 0.8, boost: 3 },
        rimFlow: { speed: 9 }, // not attached with rimFlow — must not write
      })
      const material = (host.metadata.outlineMesh as Mesh).material as unknown as {
        _floats: Record<string, number>
      }
      expect(material._floats.sizzleThreshold).toBeCloseTo(0.8, 6)
      expect(material._floats.sizzleBoost).toBeCloseTo(3, 6)
      expect(material._floats.sizzleScale).toBeCloseTo(6, 6) // preserved
      expect(material._floats.rimSpeed).toBeUndefined()
    })

    it('setEffectParams live-tunes uniform-backed params without recompile', () => {
      outliner.attach(host, {
        pulse: { speed: 2, amplitude: 0.5 },
        edgeFlow: { axis: 'y', speed: 1, width: 0.15 },
      })
      outliner.setEffectParams(host, {
        thickness: 0.09,
        pulse: { speed: 4 }, // partial update: amplitude untouched
        edgeFlow: { width: 0.3, boost: 2.5 },
      })
      const material = (host.metadata.outlineMesh as Mesh).material as unknown as {
        _floats: Record<string, number>
      }
      expect(material._floats.thickness).toBeCloseTo(0.09, 6)
      expect(material._floats.pulseSpeed).toBeCloseTo(4, 6)
      expect(material._floats.pulseAmplitude).toBeCloseTo(0.5, 6) // preserved
      expect(material._floats.flowWidth).toBeCloseTo(0.3, 6)
      expect(material._floats.flowBoost).toBeCloseTo(2.5, 6)
    })

    it('setEffectParams ignores effects the host was not attached with', () => {
      outliner.attach(host, { pulse: { speed: 2, amplitude: 0.5 } })
      // colorCycle uniforms don't exist in this compiled shader — must not write
      outliner.setEffectParams(host, { colorCycle: { period: 9 }, thickness: 0.07 })
      const material = (host.metadata.outlineMesh as Mesh).material as unknown as {
        _floats: Record<string, number>
      }
      expect(material._floats.cyclePeriod).toBeUndefined()
      expect(material._floats.thickness).toBeCloseTo(0.07, 6) // thickness always works
    })

    it('setEffectParams on an un-attached host is a silent no-op', () => {
      const other = buildHostWithThinInstances(scene)
      expect(() => outliner.setEffectParams(other, { thickness: 0.1 })).not.toThrow()
    })

    it('edgeFlow measures the geometry extent along the flow axis', () => {
      // Unit cube spans [-0.5, 0.5] on every axis → flowMin -0.5, invLength 1.
      outliner.attach(host, { edgeFlow: { axis: 'y', speed: 1, width: 0.15 } })
      const material = (host.metadata.outlineMesh as Mesh).material as unknown as {
        _floats: Record<string, number>
      }
      expect(material._floats.flowMin).toBeCloseTo(-0.5, 6)
      expect(material._floats.flowInvLength).toBeCloseTo(1, 6)
    })
  })

  describe('smoothNormals', () => {
    /** Snapshot a normal vector at vertex `i` from a vertices-data array. */
    const normalAt = (data: ArrayLike<number>, i: number) => [
      data[i * 3],
      data[i * 3 + 1],
      data[i * 3 + 2],
    ]

    it('default behavior averages outline normals at shared positions (cubes get continuous outlines)', () => {
      outliner.attach(host) // smoothNormals defaults to true
      const outlineMesh: Mesh = host.metadata.outlineMesh
      const outlineNormals = outlineMesh.getVerticesData(VertexBuffer.NormalKind)!
      // A box has 24 vertices, 4 per face. Without smoothing, each face's 4
      // vertices share a single face-axis normal (one of (±1,0,0), (0,±1,0),
      // (0,0,±1)). After smoothing, every vertex sits at a corner shared by 3
      // faces, so the smoothed normal points along the diagonal — magnitude of
      // each component is ~1/√3. Test: no normal in the output is purely axis-
      // aligned anymore.
      let foundNonAxisAligned = false
      for (let i = 0; i < outlineNormals.length / 3; i++) {
        const [x, y, z] = normalAt(outlineNormals, i)
        const isAxisAligned =
          (Math.abs(Math.abs(x) - 1) < 1e-3 && Math.abs(y) < 1e-3 && Math.abs(z) < 1e-3) ||
          (Math.abs(x) < 1e-3 && Math.abs(Math.abs(y) - 1) < 1e-3 && Math.abs(z) < 1e-3) ||
          (Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3 && Math.abs(Math.abs(z) - 1) < 1e-3)
        if (!isAxisAligned) {
          foundNonAxisAligned = true
          break
        }
      }
      expect(foundNonAxisAligned).toBe(true)
    })

    it('smoothNormals=false leaves outline normals as face-aligned', () => {
      outliner.attach(host, { smoothNormals: false })
      const outlineMesh: Mesh = host.metadata.outlineMesh
      const outlineNormals = outlineMesh.getVerticesData(VertexBuffer.NormalKind)!
      // With smoothing off, every cube vertex normal should still be face-aligned
      for (let i = 0; i < outlineNormals.length / 3; i++) {
        const [x, y, z] = normalAt(outlineNormals, i)
        const sumSq = x * x + y * y + z * z
        // Unit-length sanity
        expect(sumSq).toBeCloseTo(1, 4)
        // Exactly one component is ±1, others zero
        const oneCount = [x, y, z].filter((c) => Math.abs(Math.abs(c) - 1) < 1e-3).length
        expect(oneCount).toBe(1)
      }
    })

    it('host normals are NEVER touched by smoothNormals (smoothing applies only to outline geometry)', () => {
      // Snapshot host normals BEFORE attach
      const before = Array.from(host.getVerticesData(VertexBuffer.NormalKind)!)
      outliner.attach(host) // default smoothNormals = true
      const after = Array.from(host.getVerticesData(VertexBuffer.NormalKind)!)
      expect(after).toEqual(before)
    })
  })
})
