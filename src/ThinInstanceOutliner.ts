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

import { Color3, Mesh, Scene, ShaderMaterial } from '@babylonjs/core'
import { ZERO_SCALE_MATRIX, fillBufferWithZeroScale } from './matrixHelpers'
import { OUTLINE_SHADER_PATH, registerOutlineShader } from './outlineShader'

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
}

/**
 * Options for {@link ThinInstanceOutliner.highlight}.
 *
 * v1 limitation: per-instance overrides are reserved but inert. Color and thickness
 * are per-host (set at attach). v2 will add per-instance buffers via
 * `thinInstanceRegisterAttribute` — see ADR-003 §6.
 */
export interface HighlightOptions {
  color?: Color3
  thickness?: number
}

interface AttachedHost {
  outlineMesh: Mesh
  material: ShaderMaterial
  shownIndices: Set<number>
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

    // Clone the host. Babylon's Mesh.clone shares geometry (same vertex buffer)
    // but the clone gets its own thin-instance state — exactly what we need:
    // zero geometry duplication, independent matrix buffer for show/hide.
    const outlineMesh = host.clone(`${host.name}_outline`, null, true)
    if (!outlineMesh) return
    outlineMesh.parent = null // sibling, NEVER child — see ADR-001 §3.4

    // The outline mesh's bounding info is irrelevant — we don't pick or cull against
    // the outline as a separate object, and many of its instances are degenerate
    // (zero-scale). Disable the auto-sync so per-frame highlight/clear don't trigger
    // bounds recomputation across all instances.
    outlineMesh.doNotSyncBoundingInfo = true

    // Material: ShaderMaterial with FRONT-face culling (so only back faces render).
    // See ADR-002 §3.2 for why `cullBackFaces = false` means cull-front-faces.
    const material = new ShaderMaterial(
      `${host.name}_outlineMat`,
      this.scene,
      OUTLINE_SHADER_PATH,
      {
        attributes: ['position', 'normal', 'world0', 'world1', 'world2', 'world3'],
        uniforms: ['viewProjection', 'thickness', 'outlineColor'],
      },
    )
    material.backFaceCulling = true
    material.cullBackFaces = false
    material.setFloat('thickness', thickness)
    material.setColor3('outlineColor', color)
    outlineMesh.material = material

    // Allocate independent matrix buffer, all zero-scale (nothing visible yet).
    const matrixBuffer = new Float32Array(count * 16)
    fillBufferWithZeroScale(matrixBuffer, count)
    outlineMesh.thinInstanceSetBuffer('matrix', matrixBuffer, 16, false) // updateable
    outlineMesh.thinInstanceCount = count

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
   * No-op if `attach` wasn't called or index is out of range.
   */
  highlight(host: Mesh, instanceIndex: number, _options?: HighlightOptions): void {
    const state = this.attached.get(host)
    if (!state) return
    if (instanceIndex < 0 || instanceIndex >= host.thinInstanceCount) return

    const sourceMatrices = host.thinInstanceGetWorldMatrices()
    const sourceMatrix = sourceMatrices[instanceIndex]
    if (!sourceMatrix) return

    state.outlineMesh.thinInstanceSetMatrixAt(instanceIndex, sourceMatrix, true)
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
