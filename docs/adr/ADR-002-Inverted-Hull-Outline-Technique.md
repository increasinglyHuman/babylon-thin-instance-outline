# ADR-002 — Inverted Hull as the Outline Technique

**Status:** 🟢 Accepted
**Date:** 2026-05-07
**Author:** Allen Partridge + Claude
**Depends on:** ADR-001

---

## 1. Context

ADR-001 establishes that this lib renders per-thin-instance outlines. This ADR specifies the rendering technique used to actually draw them.

Several techniques exist for outline rendering in real-time 3D. Most don't compose well with thin-instances. This ADR walks through the alternatives and commits to the inverted-hull approach.

## 2. Alternatives considered

### 2.1 Per-mesh `EdgesRenderer` (Babylon native) — REJECTED

Babylon's built-in [`EdgesRenderer`](https://doc.babylonjs.com/features/featuresDeepDive/mesh/displayingEdges) draws edge geometry derived from the source mesh's topology, rendered as line primitives. Effective for cloned meshes (per-mesh enable/disable). **Doesn't work for thin-instances:** `enableEdgesRendering()` is per-host, lighting up every instance sharing the host. No per-instance enable API.

Patching `EdgesRenderer` to accept a per-instance mask buffer would require:
- Modifying its shader to consume an instance-mask vertex attribute
- Hooking the modified shader into Babylon's render loop
- Maintaining the patch across Babylon version upgrades

Rejected: scope explosion, fragile against Babylon upgrades, defeats the standalone-library goal.

### 2.2 Per-instance vertex color tint — REJECTED for outline use

Babylon's `mesh.thinInstanceSetBuffer('color', ...)` sets a per-instance color that multiplies into the rendered fragment. Cheap, well-supported, simple.

**Why it fails for outline-replacement:**
- It's multiplicative against material albedo. Cannot brighten or add; can only darken or hue-shift.
- On saturated colored content (red brick, painted metal, dark wood), the tint shifts hue subtly but not visibly enough to act as selection feedback.
- Increases above 1.0 may or may not clamp depending on material and tone-mapping.
- Doesn't give the "outline" affordance users associate with selection in SL/OS-style UX — users see a tinted prim, not an outlined one.

This is the v0 approach used in poqpoq-world's `ThinInstanceHighlighter`. Empirically validated 2026-05-07 by Allen: tint is too subtle on real OAR content.

Note: the color buffer is **complementary** to outline rendering, not a replacement. A future v2 of this library may expose tint methods alongside outline methods. For v1, scope = outline only.

### 2.3 Custom shader pass with per-instance mask — REJECTED for v1 (revisit in v2+)

Write a custom `ShaderMaterial` or `NodeMaterial` that:
- Accepts a per-instance "isOutlined" attribute (1.0 or 0.0)
- Renders an outline overlay pass conditional on the mask
- Uses standard outline tricks (Sobel filter on depth, screen-space, post-process)

**Why rejected for v1:**
- Significant shader expertise required.
- Tightly couples to the source material's pipeline (outline pass needs to know about the source's depth/normal output).
- Doesn't compose with arbitrary user materials (the consumer would need to use OUR material, breaking the "drop-in lib" promise).
- v1 needs to ship in days, not weeks.

Revisit for v2 if community feedback wants higher visual fidelity.

### 2.3b Babylon's `SelectionOutlineLayer` (post-process) — REJECTED for this lib

Babylon 8.x ships `SelectionOutlineLayer` / `ThinSelectionOutlineLayer` (the "Thin" prefix here means *lightweight effect layer*, NOT thin-instance — different word). It's a screen-space outline post-process that draws an outline around enabled meshes in a separate pass.

**Why rejected:**
- Per-mesh enable, same gap as `EdgesRenderer` — no per-thin-instance API.
- Requires the consumer to opt into a full-scene effect layer, which is heavier than a single sibling-mesh draw call.
- Visually different (uniform-thickness screen-space outline regardless of distance), which is a different aesthetic than the silhouette-following inverted hull.

Worth noting so future contributors understand we considered it. Babylon's internal `OutlineRenderer` does have a `#define THIN_INSTANCES` shader path, but again the user-facing enable is per-mesh.

### 2.4 Inverted hull outline — ACCEPTED

The inverted-hull technique is a well-established outline approach used in toon shaders, stylized rendering, Pixar's RenderMan, every Unity/Unreal toon shader pack, etc.

**Mechanics:**
1. Create a parallel "outline mesh" — same source geometry, slightly scaled outward (typically 1.02x – 1.05x)
2. Outline mesh's material renders **back-face only** (`material.backFaceCulling = false` + `cullBackFaces = true` in inverse), with **flat color** (no lighting)
3. Render the outline mesh BEFORE the source mesh
4. The source mesh's normal front-face render then occludes the front of the outline mesh
5. What remains visible: only the slightly-larger silhouette poking out around the source's edges → clean outline

**Per-instance show/hide:**
The outline mesh is itself a thin-instance host with its own matrix buffer. To highlight instance `i` of the source, write the source's matrix at index `i` into the outline mesh's buffer. To hide, write a scale-zero matrix at index `i`. The outline instance is technically still drawn but compresses to a degenerate point — not visible.

```
Frame:
  1. Render outline mesh's thin-instances (scale-zero ones invisible; visible ones at 1.03x source size)
  2. Render source mesh's thin-instances (full opacity, occludes outline fronts)
  3. Net visible: outline silhouette where it pokes out around the source

Per highlight:
  - Show:  outlineMesh.thinInstanceSetAttributeAt('matrix', i, sourceMatrix.scaled(1.03))
  - Hide:  outlineMesh.thinInstanceSetAttributeAt('matrix', i, ZERO_SCALE_MATRIX)
```

**Why this is the right answer for this lib:**
- Pure public Babylon APIs. No source patches.
- Lightweight: one extra draw call per host.
- Composes with any source material — outline mesh has its own material, source's material is untouched.
- Per-instance show/hide via matrix-scale is the natural Babylon thin-instance idiom.
- Visually convincing for "selection" UX — produces a clear outline that reads as "this thing is selected."
- Failure modes are graceful (concave geometry produces somewhat odd-looking outlines, but never worse than no outline).

## 3. Implementation specifics

### 3.1 Outline mesh creation

When `attach(hostMesh)` is called:
- Clone the host's geometry (Babylon `Mesh.clone(name, parent, doNotCloneChildren)`)
- Set `outlineMesh.name = ${hostMesh.name}_outline`
- Set `outlineMesh.parent = null` (NEVER child — see ADR-001 §3.4 / CLAUDE.md architecture rules)
- Apply the outline material (see §3.2)
- Allocate matrix buffer of size `hostMesh.thinInstanceCount * 16`, all entries = `ZERO_SCALE_MATRIX`
- `outlineMesh.thinInstanceSetBuffer('matrix', buffer, 16, false)` — non-static (we mutate)
- `outlineMesh.thinInstanceCount = hostMesh.thinInstanceCount`
- Tag the outline mesh: `outlineMesh.metadata = { isOutlineFor: hostMesh.uniqueId }`

### 3.2 Outline material

We use a `ShaderMaterial` because the technique requires (a) per-vertex displacement along the normal — only available via custom shader — and (b) per-instance world-matrix decoding from Babylon's thin-instance attribute layout (`world0/world1/world2/world3`). A `StandardMaterial` cannot satisfy (a) without monkey-patching.

The "render only back faces" effect is achieved through Babylon's two-flag culling API (verified against `packages/dev/core/src/Materials/material.ts` `_backFaceCulling` / `_cullBackFaces`):

```ts
mat.backFaceCulling = true   // default — culling is enabled at all
mat.cullBackFaces   = false  // when true (default), back faces are culled.
                             // false → FRONT faces are culled, only back faces render.
```

This is the canonical Babylon idiom for the back-face-only half of the inverted-hull pattern. No `gl_FrontFacing` discard, no `sideOrientation` gymnastics, no Babylon-internal patches. Worth calling out because the flag pair reads ambiguously: `cullBackFaces` looks like a culling on/off, but it actually selects *which* face gets culled when culling is enabled. The matching flag in Unity-land is `Cull Front`; same idea.

See `outlineShader.ts` for the vertex/fragment pair (vertex displaces along normal; fragment emits the unlit outline color).

### 3.3 Vertex displacement (the "scaled outward" part)

The outline mesh's vertices are pushed along their normals by `thickness` units. This happens in the vertex shader:

```glsl
attribute vec3 position;
attribute vec3 normal;
uniform float thickness;
uniform mat4 worldViewProjection;

void main() {
  vec3 displaced = position + normal * thickness;
  gl_Position = worldViewProjection * vec4(displaced, 1.0);
}
```

`thickness` is per-host (set when `attach` is called or via `setThickness()`); not per-instance in v1. Per-instance thickness would require a second buffer and is deferred to v2.

### 3.4 Render order + depth

The outline mesh must render BEFORE the source mesh. Two ways to enforce:
- `outlineMesh.renderingGroupId = host.renderingGroupId - 1` (renders in earlier group)
- OR `outlineMesh.alwaysSelectAsActiveMesh = true` + manual `renderPriority`

v1: use `renderingGroupId` displacement. Simpler. Document the limitation: the host's existing `renderingGroupId` shouldn't be `0` (else the outline mesh's `-1` is invalid; clamp to 0 with a warning).

### 3.5 Show / hide via matrix scale

`ZERO_SCALE_MATRIX` is the identity matrix with `[0][0] = [1][1] = [2][2] = 0`. A vertex multiplied by this collapses to the origin → triangle degenerate → not rasterized.

`SHOW_MATRIX(sourceMatrix)` is `sourceMatrix * scaling(1 + thickness)` — actually we apply thickness in the vertex shader, so the SHOW matrix is just `sourceMatrix` (identity-relative). The outline mesh's vertex shader pushes outward; the matrix just positions/orients the instance.

Implementation lives in `matrixHelpers.ts`.

## 4. Limitations & edge cases

- **Concave geometry:** the inverted hull can render bizarre internal faces visible through concavities. Acceptable for v1; document.
- **Hard-edge meshes:** vertex-normal displacement can split at hard edges, producing a discontinuous outline. v2 may add normal-smoothing as preprocess.
- **Skinned meshes:** the outline mesh's geometry is static; skinned source meshes will have a misaligned outline. v2 explicit feature.
- **Animated source matrices:** if the host's matrix buffer is dynamic (instances move), the outline lib needs to mirror updates. v1 polls on `attach`-time; future could subscribe to source's buffer change events. Document workaround: call `outliner.refresh(host)` after source matrix updates.

## 5. Performance notes

- One extra draw call per host. Negligible for normal use.
- One extra ShaderMaterial / StandardMaterial per host. Pool if many hosts share geometry (v2).
- Matrix buffer for outline = same size as source's. Memory cost: 64 bytes × instanceCount × number of hosts.
- No per-frame CPU work; all per-instance updates are direct GPU buffer writes.

## 6. Refs

- Toon shader inverted-hull origin: well-documented, e.g. https://roystan.net/articles/toon-shader/
- Babylon thin-instance API: https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances
- `gl_FrontFacing` for back-face-only rendering: WebGL 2.0 standard fragment shader builtin
