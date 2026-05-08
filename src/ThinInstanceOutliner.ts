/**
 * ThinInstanceOutliner.ts — public class for per-thin-instance outline rendering.
 * Implements ADR-002 (inverted-hull technique) and ADR-003 (lifecycle contract).
 * Depends on: @babylonjs/core (Mesh, Scene, ShaderMaterial, Color3), matrixHelpers, outlineShader
 * Depended on by: src/index.ts (public barrel)
 *
 * Lifecycle:
 *   constructor(scene) → attach(host, opts?) → highlight(host, idx) / clear(host, idx) → detach(host)
 *
 * Per ADR-001 §3.4 / CLAUDE.md: the outline mesh is a parallel sibling of the host
 * (parent = null), NEVER a child. Children inherit transforms; we need independent
 * matrix buffers that we mutate per-instance.
 */

import { Color3, Mesh, Scene, ShaderMaterial, VertexBuffer } from '@babylonjs/core'
import { ZERO_SCALE_MATRIX, fillBufferWithZeroScale } from './matrixHelpers'
import { OUTLINE_COLOR_ATTRIBUTE, OUTLINE_SHADER_PATH, registerOutlineShader } from './outlineShader'
import { averageNormalsAtSharedPositions } from './smoothNormals'

/** Options for {@link ThinInstanceOutliner.attach}. All fields optional. */
export interface AttachOptions {
  /** Outline scale offset along normals, in object-space units. Default 0.03. */
  thickness?: number
  /** Outline color (unlit). Default `Color3(0.5, 0.7, 1.0)` — pale blue, SL convention. */
  color?: Color3
  /**
   * Render the outline mesh in `host.renderingGroupId + offset`. Default `-1`
   * (one group earlier than the host, so the outline is occluded by the host's
   * front faces). If the resulting group would be `< 0`, the outline stays in
   * group 0 — the technique still works in most cases via depth ordering.
   */
  renderingGroupOffset?: number
  /**
   * Average vertex normals across coincident positions on the outline mesh's
   * geometry, so that hard-edge meshes (e.g. cubes from `MeshBuilder.CreateBox`)
   * produce continuous outlines at corners instead of tearing apart. Default
   * true. The HOST mesh is not affected — its lighting stays crisp; only the
   * outline's displacement direction at corners is smoothed. Disable for
   * stylized "split outline" looks or to skip the O(n²) preprocess on very
   * large meshes.
   */
  smoothNormals?: boolean
}

/**
 * Options for {@link ThinInstanceOutliner.highlight}.
 *
 * `color` is per-instance: if provided, overrides the per-host attach color
 * for this slot. Persists across show/hide until explicitly changed again.
 *
 * `thickness` is per-host in v1 (one ShaderMaterial uniform); v2 may add
 * per-instance thickness via a second buffer.
 */
export interface HighlightOptions {
  color?: Color3
  /** v1: ignored (thickness is per-host). Reserved for v2. */
  thickness?: number
}

interface AttachedHost {
  outlineMesh: Mesh
  material: ShaderMaterial
  shownIndices: Set<number>
}

/** Write a Color3 + alpha=1 to the color buffer at the given instance slot. */
function writeColorAt(buffer: Float32Array, index: number, color: Color3): void {
  const base = index * 4
  buffer[base + 0] = color.r
  buffer[base + 1] = color.g
  buffer[base + 2] = color.b
  buffer[base + 3] = 1
}

const DEFAULT_THICKNESS = 0.03
const DEFAULT_COLOR = new Color3(0.5, 0.7, 1.0)
const DEFAULT_RENDERING_GROUP_OFFSET = -1

export class ThinInstanceOutliner {
  private readonly scene: Scene
  private readonly attached: Map<Mesh, AttachedHost> = new Map()
  private disposed = false

  constructor(scene: Scene) {
    this.scene = scene
    registerOutlineShader()
  }

  /**
   * Wire the outliner to a thin-instance host. Idempotent: re-attaching the same
   * host is a silent no-op. The outline mesh is created with all instances hidden;
   * call {@link highlight} to make individual ones visible.
   *
   * Pre-conditions:
   *   - `host.thinInstanceCount > 0`
   *   - host has a bound matrix buffer (i.e., `thinInstanceSetBuffer('matrix', ...)`
   *     or repeated `thinInstanceAdd` calls were already made)
   *
   * Violations are silent no-ops (decorative system; never throws — see ADR-003 §5).
   */
  attach(host: Mesh, options: AttachOptions = {}): void {
    if (this.disposed) return
    if (this.attached.has(host)) return
    const count = host.thinInstanceCount
    if (!count || count <= 0) return

    const thickness = options.thickness ?? DEFAULT_THICKNESS
    const color = options.color ?? DEFAULT_COLOR
    const groupOffset = options.renderingGroupOffset ?? DEFAULT_RENDERING_GROUP_OFFSET
    const smoothNormals = options.smoothNormals ?? true

    // Clone the host. Babylon's Mesh.clone shares the underlying Geometry, and
    // thin-instance state lives on the geometry — so without makeGeometryUnique()
    // the outline mesh's thinInstanceSetBuffer would clobber the host's matrix
    // buffer on the shared geometry, suppressing every host instance whose slot
    // is zero-scale in the outline buffer (i.e., every un-highlighted instance).
    // The Babylon thin-instance docs call this out explicitly:
    //   "If you want to create a thin instance from a cloned mesh, you have to
    //    first make sure that you call clonedMesh.makeGeometryUnique()."
    const outlineMesh = host.clone(`${host.name}_outline`, null, true)
    if (!outlineMesh) return
    outlineMesh.makeGeometryUnique()
    outlineMesh.parent = null // sibling, NEVER child — see ADR-001 §3.4

    // Smooth normals at shared positions so hard-edge meshes don't tear at
    // corners during inverted-hull displacement. Mutates only the outline
    // mesh's normals — host's normals are untouched (host kept its own
    // geometry instance via makeGeometryUnique above).
    if (smoothNormals) {
      const positions = outlineMesh.getVerticesData(VertexBuffer.PositionKind)
      const normals = outlineMesh.getVerticesData(VertexBuffer.NormalKind)
      if (positions && normals) {
        const normalsArr = normals instanceof Float32Array ? normals : new Float32Array(normals)
        averageNormalsAtSharedPositions(positions, normalsArr)
        outlineMesh.updateVerticesData(VertexBuffer.NormalKind, normalsArr)
      }
    }

    // The outline mesh's bounding info is irrelevant for our purposes — we don't
    // pick against the outline, and most of its instances are degenerate (zero-
    // scale at origin) so any aggregate bounds would be misleading. Two flags work
    // together here:
    //   1. doNotSyncBoundingInfo — skip the per-frame refresh on every matrix
    //      mutation, since highlight()/clear() trigger this constantly.
    //   2. alwaysSelectAsActiveMesh — opt out of frustum culling for the outline,
    //      since stale bounds combined with no-refresh would (and DID, pre-fix)
    //      cause the outline to vanish whenever the camera frustum doesn't happen
    //      to include world origin. Trivial cost: the outline mesh always enters
    //      the active list. The actual rendered fragments are still GPU-clipped.
    outlineMesh.doNotSyncBoundingInfo = true
    outlineMesh.alwaysSelectAsActiveMesh = true

    // Material: ShaderMaterial with FRONT-face culling (so only back faces render).
    // See ADR-002 §3.2 for why `cullBackFaces = false` means cull-front-faces.
    const material = new ShaderMaterial(
      `${host.name}_outlineMat`,
      this.scene,
      OUTLINE_SHADER_PATH,
      {
        attributes: ['position', 'normal', 'world0', 'world1', 'world2', 'world3', OUTLINE_COLOR_ATTRIBUTE],
        uniforms: ['viewProjection', 'thickness'],
      },
    )
    material.backFaceCulling = true
    material.cullBackFaces = false
    material.setFloat('thickness', thickness)
    outlineMesh.material = material

    // Allocate independent matrix buffer, all zero-scale (nothing visible yet).
    const matrixBuffer = new Float32Array(count * 16)
    fillBufferWithZeroScale(matrixBuffer, count)
    outlineMesh.thinInstanceSetBuffer('matrix', matrixBuffer, 16, false) // updateable
    outlineMesh.thinInstanceCount = count

    // Per-instance color buffer: every slot starts at the per-attach default.
    // highlight(idx, { color }) overrides individual slots; clear() doesn't touch
    // color so a re-highlighted slot keeps its last color until explicitly changed.
    const colorBuffer = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) writeColorAt(colorBuffer, i, color)
    outlineMesh.thinInstanceSetBuffer(OUTLINE_COLOR_ATTRIBUTE, colorBuffer, 4, false)

    // Render order: outline before host so host's front faces occlude outline's front.
    const targetGroup = host.renderingGroupId + groupOffset
    outlineMesh.renderingGroupId = targetGroup >= 0 ? targetGroup : 0

    // Consumer-readable tag (do-not-mutate contract per ADR-003 §2.2).
    if (!host.metadata) host.metadata = {}
    host.metadata.outlineMesh = outlineMesh
    if (!outlineMesh.metadata) outlineMesh.metadata = {}
    outlineMesh.metadata.isOutlineFor = host.uniqueId

    this.attached.set(host, { outlineMesh, material, shownIndices: new Set() })
  }

  /**
   * Show the outline at `instanceIndex`. Reads the host's current matrix at that
   * index and writes it to the outline mesh's buffer at the same index.
   * If `options.color` is provided, the per-instance color slot is overwritten;
   * otherwise the slot keeps whatever color was last set (defaulting to the
   * per-attach color from the first attach call).
   * No-op if `attach` wasn't called or index is out of range.
   */
  highlight(host: Mesh, instanceIndex: number, options?: HighlightOptions): void {
    const state = this.attached.get(host)
    if (!state) return
    if (instanceIndex < 0 || instanceIndex >= host.thinInstanceCount) return

    const sourceMatrices = host.thinInstanceGetWorldMatrices()
    const sourceMatrix = sourceMatrices[instanceIndex]
    if (!sourceMatrix) return

    state.outlineMesh.thinInstanceSetMatrixAt(instanceIndex, sourceMatrix, true)
    if (options?.color) {
      const c = options.color
      state.outlineMesh.thinInstanceSetAttributeAt(
        OUTLINE_COLOR_ATTRIBUTE,
        instanceIndex,
        [c.r, c.g, c.b, 1],
        true,
      )
    }
    state.shownIndices.add(instanceIndex)
  }

  /** Hide the outline at `instanceIndex`. No-op if not currently shown. */
  clear(host: Mesh, instanceIndex: number): void {
    const state = this.attached.get(host)
    if (!state) return
    if (!state.shownIndices.has(instanceIndex)) return

    state.outlineMesh.thinInstanceSetMatrixAt(instanceIndex, ZERO_SCALE_MATRIX, true)
    state.shownIndices.delete(instanceIndex)
  }

  /** Hide all outlines on this host. Single GPU sync after the batch. */
  clearAll(host: Mesh): void {
    const state = this.attached.get(host)
    if (!state || state.shownIndices.size === 0) return

    for (const i of state.shownIndices) {
      state.outlineMesh.thinInstanceSetMatrixAt(i, ZERO_SCALE_MATRIX, false)
    }
    state.outlineMesh.thinInstanceBufferUpdated('matrix')
    state.shownIndices.clear()
  }

  /** Query current visibility for a specific instance. */
  isHighlighted(host: Mesh, instanceIndex: number): boolean {
    const state = this.attached.get(host)
    return state ? state.shownIndices.has(instanceIndex) : false
  }

  /**
   * Re-mirror source matrices for currently-shown instances. Call this after the
   * consumer has updated the host's matrix buffer (e.g. an instance moved) so the
   * outline tracks the new position. If `instanceIndex` is omitted, all currently-
   * shown instances are refreshed in one batched GPU sync.
   */
  refresh(host: Mesh, instanceIndex?: number): void {
    const state = this.attached.get(host)
    if (!state) return

    const sourceMatrices = host.thinInstanceGetWorldMatrices()
    const targets =
      instanceIndex !== undefined
        ? state.shownIndices.has(instanceIndex)
          ? [instanceIndex]
          : []
        : Array.from(state.shownIndices)

    if (targets.length === 0) return

    for (const i of targets) {
      const m = sourceMatrices[i]
      if (m) state.outlineMesh.thinInstanceSetMatrixAt(i, m, false)
    }
    state.outlineMesh.thinInstanceBufferUpdated('matrix')
  }

  /** Dispose the outline mesh and material; clear all state for this host. */
  detach(host: Mesh): void {
    const state = this.attached.get(host)
    if (!state) return

    state.outlineMesh.dispose()
    state.material.dispose()

    if (host.metadata && host.metadata.outlineMesh === state.outlineMesh) {
      delete host.metadata.outlineMesh
    }
    this.attached.delete(host)
  }

  /** Detach every host; the outliner is unusable after this returns. */
  dispose(): void {
    if (this.disposed) return
    for (const host of Array.from(this.attached.keys())) {
      this.detach(host)
    }
    this.disposed = true
  }
}
