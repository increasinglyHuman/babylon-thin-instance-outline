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

import { Color3, Logger, Mesh, Scene, ShaderMaterial, Vector3, VertexBuffer } from '@babylonjs/core'
import type { Nullable, Observer } from '@babylonjs/core'
import { copyHostMatrixInto, hasDirectMatrixAccess } from './hostMatrixSource'
import { ZERO_SCALE_MATRIX, fillBufferWithZeroScale } from './matrixHelpers'
import {
  OUTLINE_COLOR_ATTRIBUTE,
  OUTLINE_PHASE_ATTRIBUTE,
  OUTLINE_SHADER_PATH,
  registerOutlineShader,
} from './outlineShader'
import { averageNormalsAtSharedPositions } from './smoothNormals'

/** Pulse modulation: outline brightness oscillates on a sine (ADR-004 §3.1). */
export interface PulseOptions {
  /** Sine speed in radians per second. */
  speed: number
  /** Modulation depth in [0, 1]: 0 = no visible pulse, 1 = full off-to-bright. */
  amplitude: number
}

/** Hue rotation around the color wheel over time (ADR-004 §3.2). The
 * per-instance color defines the starting hue; saturation and lightness
 * are preserved during rotation. */
export interface ColorCycleOptions {
  /** Seconds per full hue rotation. */
  period: number
}

/**
 * Axis-aligned flowing glow band (ADR-004 §3.3). Deliberately NOT
 * silhouette-following — the band travels along an OBJECT-space axis
 * ("energy along a sword's edge") and rotates with the host.
 */
export interface EdgeFlowOptions {
  /** Object-space axis the band travels along. */
  axis: 'x' | 'y' | 'z'
  /** Bands per second. */
  speed: number
  /** Band half-width as a normalized [0..1] fraction of the axis extent. */
  width: number
  /** Additive band color. Default white. */
  accentColor?: Color3
  /** Band peak brightness multiplier. Default 1. */
  boost?: number
}

/**
 * Traveling hot-spot that orbits the VISIBLE silhouette (ADR-005). Uses the
 * centroid-angle view-space coordinate — correct per instance, seamless wrap.
 * Reads best on convex-ish shapes; concave topology lights multiple lobes at
 * the same angle (documented limitation, ADR-005 §3).
 */
export interface RimFlowOptions {
  /** Orbits per second around the rim. Negative reverses direction. */
  speed: number
  /** Hot-spot width as a fraction [0..1] of the rim circumference. */
  width: number
  /** Additive hot-spot color. Default white. */
  accentColor?: Color3
  /** Hot-spot peak brightness multiplier. Default 1. */
  boost?: number
}

/**
 * Electric crackle along the outline (ADR-004 §3.4). Animated object-space
 * value noise thresholded to flecks — view-stable, and needs no silhouette
 * detection: every visible outline fragment IS the rim (inverted-hull property).
 */
export interface SizzleOptions {
  /** Noise feature density in object-space units (bigger = finer flecks). */
  scale: number
  /** Flicker speed. */
  speed: number
  /** Fleck coverage threshold [0..1): higher = sparser flecks. Default 0.6. */
  threshold?: number
  /** Additive fleck color. Default white. */
  color?: Color3
  /** Fleck brightness multiplier. Default 1. */
  boost?: number
}

/**
 * Live-tunable parameter updates for {@link ThinInstanceOutliner.setEffectParams}.
 * Everything here is uniform-backed — updates apply on the next frame with no
 * shader recompile. What CANNOT change post-attach: the effect SET (which
 * effects exist) and `edgeFlow.axis` — those are compile-time #defines;
 * changing them requires detach() → attach().
 */
export interface EffectParamUpdates {
  /** Outline displacement thickness (always updatable, effects or not). */
  thickness?: number
  /** Ignored unless the host was attached WITH pulse. */
  pulse?: Partial<PulseOptions>
  /** Ignored unless the host was attached WITH colorCycle. */
  colorCycle?: Partial<ColorCycleOptions>
  /** Ignored unless the host was attached WITH edgeFlow. `axis` is fixed. */
  edgeFlow?: Partial<Omit<EdgeFlowOptions, 'axis'>>
  /** Ignored unless the host was attached WITH rimFlow. */
  rimFlow?: Partial<RimFlowOptions>
  /** Ignored unless the host was attached WITH sizzle. */
  sizzle?: Partial<SizzleOptions>
}

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
  /**
   * Animated effects (ADR-004 §2.5). Each enabled effect compiles its shader
   * path in via a #define — omitted effects cost nothing. The effect SET is
   * fixed at attach; changing it requires detach() → attach() (shader
   * recompile). Composition order is deliberate: hue cycle, then additive
   * flow band, then pulse as a master intensity over everything.
   */
  pulse?: PulseOptions
  colorCycle?: ColorCycleOptions
  edgeFlow?: EdgeFlowOptions
  rimFlow?: RimFlowOptions
  sizzle?: SizzleOptions
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
  /**
   * Per-instance time offset for animated effects, in fraction-of-cycle units
   * [0..1] (ADR-004 §2.4) — concurrent highlights with different phases animate
   * out of lockstep. Ignored (silently) when the host was attached without any
   * effects. Persists across clear/re-highlight like `color`.
   */
  phase?: number
}

interface AttachedHost {
  outlineMesh: Mesh
  material: ShaderMaterial
  /** The outline mesh's matrix buffer — allocated and owned by us, so writing raw
   * floats into it is our own business, not a reach into Babylon. Bypasses
   * `thinInstanceSetMatrixAt`, which would store a Matrix by reference into the
   * outline's own worldMatrices cache and re-introduce the aliasing hazard
   * ADR-006 exists to remove. Never grown in place — see `slotCount`. */
  outlineMatrices: Float32Array
  shownIndices: Set<number>
  /** Outline buffer capacity, frozen at attach time. Bounds-checks use THIS,
   * not the host's live thinInstanceCount — a host that grows after attach
   * must be re-attached (ADR-003), and a host that shrinks must not let
   * highlight() write past the outline buffer. */
  slotCount: number
  /** True when the host had no thin instances at attach — ADR-004 §2.2
   * single-mesh mode (internal 1-element thin instance, world-matrix mirror). */
  isSingleMesh: boolean
  /** Per-frame driver: updates the `time` uniform for every host, and
   * additionally mirrors the world matrix for single-mesh hosts. */
  renderObserver: Nullable<Observer<Scene>>
  /** True when a per-instance phase buffer exists (any effect enabled). */
  hasPhaseBuffer: boolean
  /** Which effects were compiled in at attach — setEffectParams() only touches
   * uniforms that exist in the compiled shader. */
  effects: { pulse: boolean; colorCycle: boolean; edgeFlow: boolean; rimFlow: boolean; sizzle: boolean }
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
  /** Outliner-global clock origin (ADR-004 §2.3): one shared `time` anchor for
   * every attached host, so detach/re-attach (constant during linkset rebuilds)
   * never resets effect phase — a per-host anchor would visibly pop. */
  private readonly clockOrigin: number = performance.now()

  constructor(scene: Scene) {
    this.scene = scene
    registerOutlineShader()
  }

  /**
   * Wire the outliner to a host mesh. Idempotent: re-attaching the same host is
   * a silent no-op. The outline mesh is created with all instances hidden; call
   * {@link highlight} to make individual ones visible.
   *
   * Two modes, selected automatically (ADR-004 §2.2):
   *   - Thin-instance host (`thinInstanceCount > 0` with a bound matrix buffer):
   *     one outline slot per instance, matrices consumer-driven via highlight/refresh.
   *   - Single-mesh host (`thinInstanceCount === 0`): the outline is an internal
   *     1-element thin instance whose matrix mirrors `host.getWorldMatrix()` every
   *     frame while highlighted — a rigid mesh parented to an animated bone (sword
   *     in a hand) tracks correctly. Use `highlight(host, 0)`.
   *
   * A host missing position or normal data is a silent no-op (decorative system;
   * never throws — see ADR-003 §5).
   */
  attach(host: Mesh, options: AttachOptions = {}): void {
    if (this.disposed) return
    if (this.attached.has(host)) return
    const hostCount = host.thinInstanceCount
    const isSingleMesh = !hostCount || hostCount <= 0
    const count = isSingleMesh ? 1 : hostCount

    const thickness = options.thickness ?? DEFAULT_THICKNESS
    const color = options.color ?? DEFAULT_COLOR
    const groupOffset = options.renderingGroupOffset ?? DEFAULT_RENDERING_GROUP_OFFSET
    const smoothNormals = options.smoothNormals ?? true
    const pulse = options.pulse ?? null
    const colorCycle = options.colorCycle ?? null
    const edgeFlow = options.edgeFlow ?? null
    const rimFlow = options.rimFlow ?? null
    const sizzle = options.sizzle ?? null
    const hasEffects = !!(pulse || colorCycle || edgeFlow || rimFlow || sizzle)

    // Build the outline mesh from scratch with its OWN geometry — never clone
    // the host. Mesh.clone shares the underlying Geometry (thin-instance
    // world0..3 vertex buffers live on the geometry), and even with
    // makeGeometryUnique() called immediately after, the share→un-share
    // lifecycle disturbs the host's thin-instance GPU bindings on WebGPU: the
    // host's own instances stop rendering until its matrix buffer is re-set.
    // Observed 2026-07-01 in poqpoq World with imported-GLB hosts (primitive
    // hosts were unaffected). Copying vertex data into a fresh mesh means the
    // host's geometry is never shared, so nothing in this method can touch the
    // host's buffers. See ADR-002 §3.1 (amended 2026-07-01).
    const positions = host.getVerticesData(VertexBuffer.PositionKind, false, true)
    const normals = host.getVerticesData(VertexBuffer.NormalKind, false, true)
    if (!positions || !normals) return // inverted hull needs both — silent no-op per ADR-003 §5
    const indices = host.getIndices(false, true)

    const outlineMesh = new Mesh(`${host.name}_outline`, this.scene)
    outlineMesh.setVerticesData(VertexBuffer.PositionKind, positions, false)
    // Normals set updatable: the smoothNormals preprocess below rewrites them.
    const normalsArr = normals instanceof Float32Array ? normals : new Float32Array(normals)
    outlineMesh.setVerticesData(VertexBuffer.NormalKind, normalsArr, true)
    if (indices && indices.length > 0) outlineMesh.setIndices(indices)

    // Transform strategy differs by mode. The outline is a parallel sibling in
    // both (parent stays null — ADR-001 §3.4).
    //   - Thin-instance host: mirror the host's LOCAL TRS, because thin-instance
    //     matrices are host-local; the mirrored per-instance matrices then land
    //     at the same world positions. Copies, not references — the host must
    //     stay free to mutate its transform without implicitly dragging the outline.
    //   - Single-mesh host: leave the outline at IDENTITY. Its one instance slot
    //     carries host.getWorldMatrix() — the full absolute transform, including
    //     any parent chain or bone attachment — so mirroring TRS here would
    //     double-apply the transform.
    if (!isSingleMesh) {
      outlineMesh.position.copyFrom(host.position)
      outlineMesh.rotation.copyFrom(host.rotation)
      outlineMesh.rotationQuaternion = host.rotationQuaternion ? host.rotationQuaternion.clone() : null
      outlineMesh.scaling.copyFrom(host.scaling)
    }
    // Winding parity: front-face culling (§3.2) is winding-relative, and
    // imported-GLB meshes are typically counter-clockwise. Without this the
    // outline would render its FRONT faces on GLB hosts and cover the host.
    outlineMesh.sideOrientation = host.sideOrientation
    outlineMesh.isPickable = false // decorative; never intercept picks meant for the host

    // Smooth normals at shared positions so hard-edge meshes don't tear at
    // corners during inverted-hull displacement. Mutates only the outline
    // mesh's normals — the host's buffers are force-copied above, never shared.
    if (smoothNormals) {
      averageNormalsAtSharedPositions(positions, normalsArr)
      outlineMesh.updateVerticesData(VertexBuffer.NormalKind, normalsArr)
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
    // Effects compile in via #defines (ADR-004 §2.5) — the attribute/uniform
    // lists must match, or Babylon binds attributes the shader never declared.
    // NOTE: world0..world3 are deliberately ABSENT here (#15). ShaderMaterial appends
    // our `options.attributes` verbatim and THEN calls PushAttributesForInstances(),
    // which adds world0..3 itself whenever the mesh uses instances — always true for
    // the outline mesh, which is a thin-instance host by construction. Listing them
    // ourselves duplicated them, so world0 resolved to shader location 2 twice.
    // WebGL binds by name and shrugs; WebGPU validates the vertex state and rejects
    // the whole pipeline ("Attribute shader location (2) is used more than once"),
    // taking the entire scene down with it. The GLSL still declares world0..3 — that
    // is what assigns the locations; only the duplicate registration is removed.
    const attributes = ['position', 'normal', OUTLINE_COLOR_ATTRIBUTE]
    const uniforms = ['viewProjection', 'thickness', 'time']
    const defines: string[] = []
    if (hasEffects) {
      attributes.push(OUTLINE_PHASE_ATTRIBUTE)
      defines.push('#define OUTLINE_HAS_EFFECTS')
    }
    if (pulse) {
      defines.push('#define OUTLINE_PULSE')
      uniforms.push('pulseSpeed', 'pulseAmplitude')
    }
    if (colorCycle) {
      defines.push('#define OUTLINE_COLOR_CYCLE')
      uniforms.push('cyclePeriod')
    }
    const flowAxisIndex = edgeFlow ? { x: 0, y: 1, z: 2 }[edgeFlow.axis] : 0
    if (edgeFlow) {
      defines.push('#define OUTLINE_EDGE_FLOW', `#define FLOW_AXIS ${flowAxisIndex}`)
      uniforms.push('flowMin', 'flowInvLength', 'flowSpeed', 'flowWidth', 'flowAccentColor', 'flowBoost')
    }
    if (rimFlow) {
      defines.push('#define OUTLINE_RIM_FLOW')
      // 'view' is a Babylon-recognized uniform name — auto-bound each frame.
      uniforms.push('view', 'geomCentroid', 'rimSpeed', 'rimWidth', 'rimAccentColor', 'rimBoost')
    }
    if (sizzle) {
      defines.push('#define OUTLINE_SIZZLE')
      uniforms.push('sizzleScale', 'sizzleSpeed', 'sizzleThreshold', 'sizzleColor', 'sizzleBoost')
    }

    const material = new ShaderMaterial(
      `${host.name}_outlineMat`,
      this.scene,
      OUTLINE_SHADER_PATH,
      { attributes, uniforms, defines },
    )
    material.backFaceCulling = true
    material.cullBackFaces = false
    material.setFloat('thickness', thickness)
    material.setFloat('time', 0)
    if (pulse) {
      material.setFloat('pulseSpeed', pulse.speed)
      material.setFloat('pulseAmplitude', pulse.amplitude)
    }
    if (colorCycle) {
      material.setFloat('cyclePeriod', colorCycle.period)
    }
    if (edgeFlow) {
      // The band coordinate must be normalized [0..1] along the flow axis
      // regardless of mesh size or centering — measure the geometry extent
      // from the copied positions (stride 3).
      let axisMin = Infinity
      let axisMax = -Infinity
      for (let i = flowAxisIndex; i < positions.length; i += 3) {
        const v = positions[i]
        if (v < axisMin) axisMin = v
        if (v > axisMax) axisMax = v
      }
      const axisLength = axisMax - axisMin
      material.setFloat('flowMin', axisMin)
      material.setFloat('flowInvLength', axisLength > 1e-6 ? 1 / axisLength : 0)
      material.setFloat('flowSpeed', edgeFlow.speed)
      material.setFloat('flowWidth', edgeFlow.width)
      material.setColor3('flowAccentColor', edgeFlow.accentColor ?? new Color3(1, 1, 1))
      material.setFloat('flowBoost', edgeFlow.boost ?? 1)
    }
    if (rimFlow) {
      // Object-space bbox center = the centroid the rim angle wraps around
      // (ADR-005 §2.1). Bbox over vertex-average: robust to vertex density.
      let minX = Infinity, minY = Infinity, minZ = Infinity
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
      material.setVector3(
        'geomCentroid',
        new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
      )
      material.setFloat('rimSpeed', rimFlow.speed)
      material.setFloat('rimWidth', rimFlow.width)
      material.setColor3('rimAccentColor', rimFlow.accentColor ?? new Color3(1, 1, 1))
      material.setFloat('rimBoost', rimFlow.boost ?? 1)
    }
    if (sizzle) {
      material.setFloat('sizzleScale', sizzle.scale)
      material.setFloat('sizzleSpeed', sizzle.speed)
      material.setFloat('sizzleThreshold', sizzle.threshold ?? 0.6)
      material.setColor3('sizzleColor', sizzle.color ?? new Color3(1, 1, 1))
      material.setFloat('sizzleBoost', sizzle.boost ?? 1)
    }
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

    // Per-instance phase (stride 1), only when an effect consumes it. All slots
    // start at 0 (lockstep) until highlight(..., { phase }) overrides — ADR-004 §2.4.
    if (hasEffects) {
      outlineMesh.thinInstanceSetBuffer(OUTLINE_PHASE_ATTRIBUTE, new Float32Array(count), 1, false)
    }

    // Render order: outline before host so host's front faces occlude outline's front.
    const targetGroup = host.renderingGroupId + groupOffset
    outlineMesh.renderingGroupId = targetGroup >= 0 ? targetGroup : 0

    // Consumer-readable tag (do-not-mutate contract per ADR-003 §2.2).
    if (!host.metadata) host.metadata = {}
    host.metadata.outlineMesh = outlineMesh
    if (!outlineMesh.metadata) outlineMesh.metadata = {}
    outlineMesh.metadata.isOutlineFor = host.uniqueId

    // NOTE: v1.3 re-set the host's matrix buffer here as a "belt-and-suspenders"
    // guard against the WebGPU blanking regression (#3). It is gone as of ADR-006,
    // and deleting it FIXED a bug rather than risking one:
    //   - It never fixed #3. `git log -S"_thinInstanceDataStorage"` shows it was born
    //     in bb80269 — the same commit as the real fix (build the outline from fresh
    //     geometry, never clone the host). It was insurance that was never load-bearing.
    //   - Nothing is left for it to repair. Every other host access in this method is
    //     a read or a forced copy (`getVerticesData(kind, false, true)`), so the host's
    //     buffers are never disturbed in the first place.
    //   - It was not free. `thinInstanceSetBuffer(..., staticBuffer=false)` silently
    //     flipped a STATIC host buffer (Babylon's default!) to updatable and disposed +
    //     recreated the GPU buffer underneath the consumer — an unrequested mutation of
    //     their state. Regression-tested in tests/matrixSourceOfTruth.test.ts.
    // If #3 ever returns on WebGPU, the fresh-geometry build is the thing to examine.

    // Warn once per host if ground truth is unreachable — the read path still works via
    // Babylon's memoised public getter, but silently stops tracking direct buffer writes
    // (ADR-006 §2.3). Loud beats a frozen outline nobody can explain.
    if (!isSingleMesh && !hasDirectMatrixAccess(host)) {
      Logger.Warn(
        `[thin-instance-outline] Cannot read host "${host.name}" thin-instance matrices directly ` +
          `(Babylon internal layout changed?). Falling back to thinInstanceGetWorldMatrices(), which ` +
          `is memoised: outlines will NOT track instances moved by direct matrix-buffer writes. See ADR-006.`,
      )
    }

    const state: AttachedHost = {
      outlineMesh,
      material,
      outlineMatrices: matrixBuffer,
      shownIndices: new Set(),
      slotCount: count,
      isSingleMesh,
      renderObserver: null,
      hasPhaseBuffer: hasEffects,
      effects: {
        pulse: !!pulse,
        colorCycle: !!colorCycle,
        edgeFlow: !!edgeFlow,
        rimFlow: !!rimFlow,
        sizzle: !!sizzle,
      },
    }

    // Per-frame driver, one observer per attached host (ADR-004 §2.3 / §2.2):
    //   1. Feed the `time` uniform from the outliner-global clock (all hosts —
    //      animated effects consume it; without effects it's a cheap no-op set).
    //   2. Single-mesh hosts MOVE (a held weapon's world matrix changes every
    //      frame via bone parenting) — mirror the host's world matrix into the
    //      one instance slot, but ONLY while highlighted: writing it
    //      unconditionally would resurrect a cleared (zero-scale) outline.
    // computeWorldMatrix(true): the non-forced path early-returns the cached
    // matrix whenever the scene's renderId hasn't advanced since the last
    // compute — an OR with isSynchronized(), so vector dirtiness is never even
    // checked (transformNode.ts). That serves stale matrices for same-frame
    // moves and never-rendered scenes. Forced compose for ONE mesh is trivial.
    state.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      material.setFloat('time', (performance.now() - this.clockOrigin) / 1000)
      if (state.isSingleMesh && state.shownIndices.has(0)) {
        host.computeWorldMatrix(true).copyToArray(state.outlineMatrices, 0)
        state.outlineMesh.thinInstanceBufferUpdated('matrix')
      }
    })

    this.attached.set(host, state)
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
    // Bounds-check against the attach-time buffer capacity, not the host's live
    // count: a single-mesh host reports thinInstanceCount 0 but has slot 0, and
    // a thin-instance host that grew after attach has no outline slots for the
    // new indices (re-attach required per ADR-003).
    if (instanceIndex < 0 || instanceIndex >= state.slotCount) return

    // Read from ground truth, not Babylon's memoised worldMatrices cache (ADR-006).
    if (state.isSingleMesh) {
      // Full absolute transform (forced — see attach observer note); outline sits at identity.
      host.computeWorldMatrix(true).copyToArray(state.outlineMatrices, instanceIndex * 16)
    } else if (!copyHostMatrixInto(host, instanceIndex, state.outlineMatrices, instanceIndex)) {
      return
    }
    state.outlineMesh.thinInstanceBufferUpdated('matrix')

    if (options?.color) {
      const c = options.color
      state.outlineMesh.thinInstanceSetAttributeAt(
        OUTLINE_COLOR_ATTRIBUTE,
        instanceIndex,
        [c.r, c.g, c.b, 1],
        true,
      )
    }
    if (options?.phase !== undefined && state.hasPhaseBuffer) {
      state.outlineMesh.thinInstanceSetAttributeAt(
        OUTLINE_PHASE_ATTRIBUTE,
        instanceIndex,
        [options.phase],
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

    state.outlineMatrices.set(ZERO_SCALE_MATRIX.m, instanceIndex * 16)
    state.outlineMesh.thinInstanceBufferUpdated('matrix')
    state.shownIndices.delete(instanceIndex)
  }

  /** Hide all outlines on this host. Single GPU sync after the batch. */
  clearAll(host: Mesh): void {
    const state = this.attached.get(host)
    if (!state || state.shownIndices.size === 0) return

    for (const i of state.shownIndices) {
      state.outlineMatrices.set(ZERO_SCALE_MATRIX.m, i * 16)
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

    const targets =
      instanceIndex !== undefined
        ? state.shownIndices.has(instanceIndex)
          ? [instanceIndex]
          : []
        : Array.from(state.shownIndices)

    if (targets.length === 0) return

    // Re-read ground truth per index (ADR-006). Allocation-free, so a moving host
    // can be re-mirrored every frame without GC churn. Single-mesh hosts self-refresh
    // via the render observer; an explicit call is still honored for symmetry (e.g.
    // force an update between a transform change and the next render).
    for (const i of targets) {
      if (state.isSingleMesh) {
        host.computeWorldMatrix(true).copyToArray(state.outlineMatrices, i * 16)
      } else {
        copyHostMatrixInto(host, i, state.outlineMatrices, i)
      }
    }
    state.outlineMesh.thinInstanceBufferUpdated('matrix')
  }

  /**
   * Live-tune uniform-backed parameters — thickness and effect params — with
   * no shader recompile (applies next frame). Updates for effects the host
   * wasn't attached with are silently ignored (their uniforms don't exist in
   * the compiled shader); enabling/disabling effects or changing the edgeFlow
   * axis requires detach() → attach(). No-op if the host isn't attached.
   */
  setEffectParams(host: Mesh, updates: EffectParamUpdates): void {
    const state = this.attached.get(host)
    if (!state) return
    const m = state.material

    if (updates.thickness !== undefined) m.setFloat('thickness', updates.thickness)
    if (updates.pulse && state.effects.pulse) {
      if (updates.pulse.speed !== undefined) m.setFloat('pulseSpeed', updates.pulse.speed)
      if (updates.pulse.amplitude !== undefined) m.setFloat('pulseAmplitude', updates.pulse.amplitude)
    }
    if (updates.colorCycle && state.effects.colorCycle) {
      if (updates.colorCycle.period !== undefined) m.setFloat('cyclePeriod', updates.colorCycle.period)
    }
    if (updates.edgeFlow && state.effects.edgeFlow) {
      const f = updates.edgeFlow
      if (f.speed !== undefined) m.setFloat('flowSpeed', f.speed)
      if (f.width !== undefined) m.setFloat('flowWidth', f.width)
      if (f.accentColor) m.setColor3('flowAccentColor', f.accentColor)
      if (f.boost !== undefined) m.setFloat('flowBoost', f.boost)
    }
    if (updates.rimFlow && state.effects.rimFlow) {
      const r = updates.rimFlow
      if (r.speed !== undefined) m.setFloat('rimSpeed', r.speed)
      if (r.width !== undefined) m.setFloat('rimWidth', r.width)
      if (r.accentColor) m.setColor3('rimAccentColor', r.accentColor)
      if (r.boost !== undefined) m.setFloat('rimBoost', r.boost)
    }
    if (updates.sizzle && state.effects.sizzle) {
      const s = updates.sizzle
      if (s.scale !== undefined) m.setFloat('sizzleScale', s.scale)
      if (s.speed !== undefined) m.setFloat('sizzleSpeed', s.speed)
      if (s.threshold !== undefined) m.setFloat('sizzleThreshold', s.threshold)
      if (s.color) m.setColor3('sizzleColor', s.color)
      if (s.boost !== undefined) m.setFloat('sizzleBoost', s.boost)
    }
  }

  /** Dispose the outline mesh and material; clear all state for this host. */
  detach(host: Mesh): void {
    const state = this.attached.get(host)
    if (!state) return

    if (state.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(state.renderObserver)
    }
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
