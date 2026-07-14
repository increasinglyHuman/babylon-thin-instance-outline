# babylon-thin-instance-outline

Per-instance outline rendering for Babylon.js thin-instances — using the classic inverted-hull technique. The outline lives on a sibling thin-instance host whose matrix buffer mirrors the source's, with per-instance show/hide via matrix scale.

**🎮 Live demo:** https://poqpoq.com/babylon-outline/ — click a cube, the orbiting torus knot, or the greatsword.
**Status:** v1.3.1 — stable public API for single-mesh static thin-instances, with per-instance color, smooth-normals preprocessing, and animated silhouette effects.
**Author:** Allen Partridge ([@increasinglyHuman](https://github.com/increasinglyHuman)) + Claude. Part of the [BlackBox creative suite](https://poqpoq.com).
**License:** [MIT](LICENSE).

---

## Why this library exists

Babylon.js exposes [thin-instances](https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances) for high-volume static-geometry rendering — one draw call for thousands of placements. They're essential whenever you have repeated geometry: foliage, building tile sets, item drops, pickups, particle systems.

But Babylon's [`EdgesRenderer`](https://doc.babylonjs.com/features/featuresDeepDive/mesh/displayingEdges) — the canonical "show edges / outline this mesh" API — operates **per host mesh, not per thin-instance**. There's no public API to outline a single thin-instance entry without lighting up every other instance sharing the same host.

This is a real gap. It surfaces in any scene where you want to:
- Highlight a selected member of a thin-instanced group (linksets, item tooltips, group editing)
- Indicate hovered / pickable state per-instance
- Build a stylized cel-shaded look that respects per-instance boundaries

This library closes that gap with a small, focused API and zero patches to Babylon source.

## Approach: inverted hull outline

The outline isn't drawn by edge rendering at all. It's a parallel **outline mesh** that mirrors the source's geometry, slightly scaled outward, rendered with **back-face only + flipped winding**. The source mesh occludes the front of the outline mesh; only the slightly-larger silhouette pokes out around the edges, producing a clean outline.

Critically: the outline mesh is **itself a thin-instance host**. Its matrix buffer mirrors the source's at the same indices. To highlight instance `i`, write the source's matrix at index `i` into the outline mesh's buffer. To clear instance `i`, write a scale-zero matrix at index `i` (instance is technically still drawn but compresses to a point — invisible).

This technique is well-known in 3D rendering — Pixar's RenderMan, every modern toon shader, lots of Unity/Unreal stylized games use it. It composes cleanly with thin-instances because per-instance show/hide via matrix-scale is the natural Babylon idiom.

```
    [host mesh — original geometry, full opacity]
              ↓
    [outline mesh — same geometry, scaled 1.03x, back-face culled,
                    rendered FIRST, flat color, drawn behind via depth bias]
              ↓
    [host mesh occludes outline's front; visible silhouette = the outline]
```

## Quick start

```bash
npm install @poqpoq/babylon-thin-instance-outline
```

```ts
import { ThinInstanceOutliner } from '@poqpoq/babylon-thin-instance-outline'
import { Color3 } from '@babylonjs/core'

const outliner = new ThinInstanceOutliner(scene)

// Wire the outliner to an existing thin-instance host.
// Creates the parallel outline mesh, mirrors matrix buffer.
outliner.attach(myHostMesh)

// Highlight a specific instance (pale blue per the attach default)
outliner.highlight(myHostMesh, 7)

// Highlight with a per-instance color override (red just for slot 12)
outliner.highlight(myHostMesh, 12, { color: new Color3(1.0, 0.3, 0.3) })

// Clear one
outliner.clear(myHostMesh, 7)

// Clear all on this host
outliner.clearAll(myHostMesh)

// Detach (disposes the outline mesh)
outliner.detach(myHostMesh)
```

## API

| Method | Purpose |
|---|---|
| `new ThinInstanceOutliner(scene)` | Construct. One outliner per scene typically. |
| `attach(hostMesh)` | Create the parallel outline mesh + bind matrix buffer mirror. Idempotent. |
| `highlight(hostMesh, instanceIndex, opts?)` | Show outline for one instance. |
| `clear(hostMesh, instanceIndex)` | Hide outline for one instance. |
| `clearAll(hostMesh)` | Hide all outlines on this host. |
| `detach(hostMesh)` | Dispose outline mesh; remove all state for this host. |
| `dispose()` | Detach all hosts; clean up. |

## What this does and doesn't do

This library renders a per-instance silhouette outline. Mental model:

- **Per-instance, not per-group.** Outlining instances 3, 7, and 12 produces three independent outlines. Even if the instances are touching, each gets its own outline; they don't merge into a single border around the union. For a unified group outline (one continuous border around multiple meshes), use a stencil-based or screen-space approach like Babylon's `SelectionOutlineLayer`.
- **Surface-following, not edge-detecting.** The outline traces the silhouette of the mesh's surface as seen from the camera. CSG cuts, hollows, and concave geometry are part of the surface — they get outlined too (sometimes in visually surprising ways for concave shapes; ADR-002 §4 covers the edge cases).
- **Hard-edge meshes are handled.** A cube has discontinuous vertex normals at corners by default — without intervention, the outline tears apart there. The outliner averages normals across coincident vertex positions on the *outline* mesh only (host stays crisp), so the silhouette is continuous around sharp 90° corners. Default on; opt out with `attach(host, { smoothNormals: false })` for stylized split-outline looks or to skip the O(n²) preprocess on very large meshes.

## Status & roadmap

**Shipped (v1.0 → v1.3):** core inverted-hull outline for single-mesh static thin-instances · **per-instance color** (`highlight(host, idx, { color })`) · **smooth-normals preprocess** for hard-edge meshes (default on) · **animated silhouette effects** — pulse, colorCycle, edgeFlow, sizzle, rimFlow · **live param tuning** via `setEffectParams` (no recompile).

**Next:** multi-mesh hosts (skeleton-shared) · animated mesh outline (skeleton-clone) · per-instance thickness.

## Born from

This library was extracted from [poqpoq-world](https://github.com/increasinglyHuman/poqpoq-world)'s linkset selection substrate work (ADR-120) — where OAR-imported linksets needed per-thin-instance member highlighting that Babylon doesn't natively support. Rather than patch Babylon source or build the technique inline, the cleaner long-term answer was a focused, reusable library. Same pattern as poqpoq-IK-Solver.

If your project hits the same Babylon gap, this library is for you. Issues and PRs welcome.

## License

[MIT](LICENSE) © [Allen Partridge (p0qp0q)](https://poqpoq.com). Use freely, attribute kindly.

Part of the [BlackBox creative suite](https://poqpoq.com) — see also [Animator](https://poqpoq.com/animator/), [Skinner](https://poqpoq.com/skinner/), and [`@poqpoq/voxel-skinner`](https://www.npmjs.com/package/@poqpoq/voxel-skinner).
