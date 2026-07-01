# ADR-003 — API Surface & Lifecycle Contract

**Status:** 🟢 Accepted (governs v1 public API)
**Date:** 2026-05-07
**Author:** Allen Partridge + Claude
**Depends on:** ADR-001 (charter), ADR-002 (technique)

---

## 1. Context

ADR-001 says what the library does. ADR-002 says how it draws. This ADR locks the API surface so consumers (starting with poqpoq-world) can integrate against a stable contract and we don't accidentally grow surface area beyond charter.

## 2. Public API (the v1 contract)

```ts
import { ThinInstanceOutliner, type OutlineOptions } from '@p0qp0q/babylon-thin-instance-outline'
import type { Scene, Mesh, Color3 } from '@babylonjs/core'
```

### 2.1 Constructor

```ts
new ThinInstanceOutliner(scene: Scene)
```

One outliner per scene. Multiple scenes = multiple outliners. The outliner doesn't auto-detect existing thin-instance hosts; consumer attaches them explicitly.

### 2.2 Attach / detach lifecycle

```ts
attach(hostMesh: Mesh, options?: AttachOptions): void
```

Wires the outliner to a host mesh. Creates the parallel outline mesh, allocates matrix buffer of size `hostMesh.thinInstanceCount * 16` (all ZERO_SCALE — nothing visible until `highlight` is called).

> **Amendment 2026-07-01 (ADR-004 §2.2 single-mesh mode).** `thinInstanceCount > 0` is no longer a pre-condition. A host with zero thin instances attaches in **single-mesh mode**: the outline gets an internal 1-element thin instance (address it as index `0`) whose matrix mirrors `hostMesh.getWorldMatrix()` — the full absolute transform, so parent chains and bone attachments track — every frame while highlighted. The remaining hard pre-condition is that the host has position AND normal vertex data; a mesh without either is a silent no-op per §5.

Idempotent: calling `attach` twice on the same host is a no-op (returns immediately, no duplicate outline mesh).

`AttachOptions` (all optional):
- `thickness?: number` — outline scale offset, default 0.03 (3% expansion)
- `color?: Color3` — outline color, default `new Color3(0.5, 0.7, 1.0)` (pale blue, SL convention)
- `renderingGroupOffset?: number` — outline renders this many groups before host. Default `-1`. Must result in valid renderingGroupId (≥0). If host is in group 0, defaults to using `alwaysSelectAsActiveMesh + renderPriority` instead.

Pre-conditions:
- `hostMesh` has position and normal vertex data.
- For thin-instance mode: `thinInstanceCount > 0` with a bound matrix buffer (zero instances → single-mesh mode per the amendment above).
- `hostMesh.material` must be set.

Post-conditions:
- `hostMesh.metadata.outlineMesh` is set to the parallel outline mesh (consumer-readable, do-not-mutate).

```ts
detach(hostMesh: Mesh): void
```

Disposes the outline mesh, clears all state for this host. Idempotent (no-op if not attached).

### 2.3 Highlight / clear

```ts
highlight(hostMesh: Mesh, instanceIndex: number, options?: HighlightOptions): void
```

Make instance `instanceIndex` visible in the outline. Writes the source's current matrix (read from host's matrix buffer at the same index) into the outline mesh's matrix buffer at `instanceIndex`.

`HighlightOptions` (all optional):
- `color?: Color3` — **per-instance** color override. If provided, sets the outline color for this slot. Persists across show/hide cycles until changed again. If omitted, the slot keeps its current color (default = the per-attach color from the first `attach` call).
- `thickness?: number` — reserved for v2; ignored in v1 (thickness is a single ShaderMaterial uniform set at attach).

**Note (revised 2026-05-07):** Per-instance color was originally deferred to v2 in this ADR's first revision. It's been promoted to v1 because the implementation cost was small (a single custom thin-instance attribute, vec4 RGBA) and Allen's first hands-on use surfaced the need immediately. v2 still owns per-instance thickness (would require a second buffer + shader change).

Pre-condition: `attach` was called for this host.
Out-of-range index: silent no-op (logs warning in dev mode).

```ts
clear(hostMesh: Mesh, instanceIndex: number): void
```

Hide instance `instanceIndex` from the outline. Writes ZERO_SCALE matrix at that index.

```ts
clearAll(hostMesh: Mesh): void
```

Hide all outlines on this host. Iterates over all currently-shown indices, writes ZERO_SCALE.

```ts
isHighlighted(hostMesh: Mesh, instanceIndex: number): boolean
```

Query whether instance `instanceIndex` currently shows an outline. Useful for toggle UX.

### 2.4 Refresh (for moving thin-instances)

```ts
refresh(hostMesh: Mesh, instanceIndex?: number): void
```

If the host's matrix buffer was updated (instance moved), the outline mesh's matrix buffer is now stale for any currently-shown instances. `refresh` re-reads the host's matrices and re-writes the shown ones.

If `instanceIndex` is omitted, refreshes all currently-shown instances.

This is a v1 manual hook; v2 may auto-detect host buffer changes via observable subscription.

### 2.5 Disposal

```ts
dispose(): void
```

Detaches all hosts; disposes all outline meshes; clears all state. After `dispose`, the outliner is unusable.

## 3. State model (internal — informative only)

```ts
class ThinInstanceOutliner {
  private scene: Scene
  private attached: Map<Mesh, AttachedHost>
  // ...
}

interface AttachedHost {
  outlineMesh: Mesh
  matrixBuffer: Float32Array          // mirrors source size
  shownIndices: Set<number>
  options: AttachOptions
}
```

Consumers don't see this. Documented to keep contributors aligned on the data model.

## 4. Type exports

Public type exports from `src/index.ts`:

```ts
export { ThinInstanceOutliner }
export type { AttachOptions, HighlightOptions }
```

Nothing else. Internal helpers stay internal.

## 5. Error handling

- Pre-condition violations (called before `attach`, out-of-range index, attached without matrix buffer): silent no-ops in production, `console.warn` in dev mode.
- Babylon-side failures (mesh disposed mid-call): caught and logged; outliner state is left consistent (treat as auto-detach).
- No throws from the public API in v1 — outline is decorative; failures shouldn't break the consumer's app.

## 6. Versioning compatibility

- v1.x is API-stable per this ADR. Additions (new methods, new options) are minor-version bumps. Removals or breaking changes require a major bump.
- v2.x may expand `HighlightOptions` to actually accept per-instance color/thickness once a per-instance buffer is added.
- Per-instance color/thickness is the most likely v2 feature; consumers should NOT depend on `options` being meaningful in v1.

## 7. Consumer integration example

The poqpoq-world `ThinInstanceHighlighter` will replace its current per-instance color tint with this lib:

```ts
// poqpoq-world: src/world/ThinInstanceHighlighter.ts (post-migration)
import { ThinInstanceOutliner } from '@p0qp0q/babylon-thin-instance-outline'

export class ThinInstanceHighlighter {
  private outliner: ThinInstanceOutliner

  constructor(scene: Scene) {
    this.outliner = new ThinInstanceOutliner(scene)
  }

  applyHighlight(host: Mesh, index: number): void {
    this.outliner.attach(host)  // idempotent
    this.outliner.highlight(host, index)
  }

  clearAll(): void {
    // Track attached hosts; iterate outliner.clearAll(host) for each
  }
}
```

The poqpoq-world wrapper retains its own state-tracking layer (Map<Mesh, Set<index>>) for its own clear-all semantics; the lib doesn't enforce any external tracking.

## 8. Open questions for v2+

- Should `attach` auto-detect new matrix entries when host grows? Currently no; consumer must `detach + attach` to resize.
- Should we expose per-instance color via a `colorAt(host, index, color)` method? Probably yes, in v2.
- Should the lib offer a "subscribe to host matrix changes" API, or stay manual via `refresh`? Manual is simpler; auto needs decisions about subscription cost.

These questions are explicitly NOT decided here. v1 ships the minimum surface; v2 negotiates expansion.
