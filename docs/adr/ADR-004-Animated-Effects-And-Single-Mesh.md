# ADR-004 — Animated Effects + Single-Mesh Outline (v1.1 architecture)

**Status:** ✅ Accepted (ratified 2026-07-01, with amendments)
**Date:** 2026-05-08 (proposed) · 2026-07-01 (accepted)
**Author:** Allen Partridge + Claude
**Depends on:** ADR-001 (charter), ADR-002 (technique), ADR-003 (API)
**Amends:** ADR-001 §2.1 (charter expansion: per-mesh case becomes co-equal with thin-instance case)

> **Ratification amendments (2026-07-01).** Four changes were folded in at acceptance:
> 1. §2.2 — single-mesh hosts are tracked per frame (moving weapons are THE use case; a rigid mesh parented to an animated bone now works, and only truly skinned geometry stays v2).
> 2. §2.3 / §8 — the per-host vs scene-global time question is resolved **now**, in favor of a shared clock, for re-attach phase continuity (World rebuilds linksets constantly).
> 3. §2.5 — the effect composition order is declared deliberate (pulse is a master dimmer).
> 4. §7 — explicit boundary vs World's GPU projectile/spell effects system, and the attach-time-only effect contract.
> Construction language throughout defers to ADR-002 §3.1 as amended 2026-07-01 (fresh geometry, never `clone()`).

---

## 1. Context

v1.0 shipped the inverted-hull outline for thin-instance hosts with per-instance color, smooth-normals preprocess, and the camera-cull fix. The first real consumer (poqpoq-world's `ThinInstanceHighlighter` per [PR #338](https://github.com/increasinglyHuman/poqpoq-world/pull/338)) validated the API.

Two follow-on directions surfaced in early use:

1. **Per-mesh case.** ADR-001 §2.1 originally excluded per-mesh outline ("Babylon's `EdgesRenderer` already covers that"). But `EdgesRenderer` produces line-primitive aliased edges — visually distinct from the inverted-hull silhouette aesthetic that's the differentiator of this lib. Many consumers want the same look on plain `Mesh` instances, asset-imported GLB nodes, and `InstancedMesh` clones. Generalizing here is a real fill, not duplicating Babylon.

2. **Animated effects.** The inverted-hull mesh is a thin geometric shell that ONLY appears along the silhouette. Anything painted on it shows up as edge-effect "for free." Use cases: pulsing magic weapons, rainbow-cycling pickups, energy flowing along a sword. Pure shader-side work; no architectural change to the outliner-as-sibling-mesh pattern.

This ADR governs both because they share design decisions (time uniform, per-instance vs per-host attributes, shader bifurcation cost). Splitting into two ADRs would force redundant context.

## 2. Decision

### 2.1 Charter amendment (extends ADR-001 §2.1)

Per-mesh outline using the inverted-hull technique IS in scope as of v1.1. `EdgesRenderer` continues to be the right tool for line-primitive edge rendering and is unaffected by this lib. The two coexist: consumers pick based on visual taste.

The lib's npm package name (`@p0qp0q/babylon-thin-instance-outline`) stays. Thin-instance support remains the most differentiated feature versus stock Babylon; per-mesh support is a "we also do this" expansion, not a renaming concern.

### 2.2 Single shader, both cases (the "always thin-instance" pattern)

Rather than maintaining two ShaderMaterial variants with `#define THIN_INSTANCE` / `#define SINGLE_MESH` branches, **the single-mesh path internally creates a 1-element thin-instance**. Babylon supports thin-instances on any `Mesh`, so a "single-mesh" outline is just `thinInstanceCount = 1` with the matrix being the host's world transform.

User-facing, this is invisible: `outliner.attach(mesh)` works for any `Mesh` regardless of whether the consumer set up thin-instances. Internally the outliner detects `thinInstanceCount === 0` and falls into a wrapper that adds a single thin-instance mirroring the mesh's world matrix.

The outline mesh itself is constructed per ADR-002 §3.1 as amended 2026-07-01: a fresh `Mesh` with copied position/normal/index data — never `host.clone()` (the shared-geometry lifecycle disturbed host thin-instance bindings on WebGPU; see issue #3).

**Moving hosts (amendment 2026-07-01).** Single meshes *move* — a held weapon's world matrix changes every frame via hand-bone parenting, and "magic weapon in a hand" is the canonical use case for this whole feature. The v1.1 design as proposed mirrored the host's world matrix once at attach, which would leave the outline behind on the first swing. Ratified behavior: the per-host `scene.onBeforeRenderObservable` subscription that drives the `time` uniform (§2.3) ALSO re-mirrors `host.getWorldMatrix()` into the single thin-instance matrix slot each frame, in the single-mesh case only. Consequences:

- A **rigid** mesh attached to an animated bone (sword in hand) tracks correctly — `getWorldMatrix()` reflects bone-driven transforms. This narrows the §7 skinned-mesh limitation: only *actually-skinned* geometry (vertices deformed by bone weights) remains v2.
- Thin-instance hosts are unchanged: consumers drive matrix updates via `refresh()` exactly as in v1.0. No per-frame mirroring for N-instance hosts — that would be a hidden O(N) cost the consumer didn't ask for.
- The per-frame mirror is one 16-float write + buffer update; cost is negligible against the observer already firing for `time`.

**Cost:** one extra thin-instance per single-mesh attach (negligible). **Benefit:** one shader, one code path, one set of tests.

### 2.3 Time uniform via scene observable

A `time` uniform feeds every animated effect. Driven automatically from `scene.onBeforeRenderObservable` — the outliner subscribes once per attached host and updates the material's `time` uniform each frame. Consumer doesn't drive it; consumer doesn't need to.

**Time is OUTLINER-GLOBAL, not per-host (amendment 2026-07-01 — resolves former §8 open question 1).** The clock is a single elapsed-seconds counter anchored at outliner construction, shared by every attached host. The originally-proposed per-host `attachedAt` anchor had a consumer-visible flaw: detach/re-attach resets the phase, and World rebuilds linksets (detach → re-attach) constantly — a pulsing weapon would visibly snap to full brightness on every rebuild. A shared clock makes effects continuous across re-attach cycles, and gets choreographed multi-host sync for free.

Rationale for automatic driving: the alternative (consumer-driven `setTime(t)`) shifts work onto the consumer for no benefit. Pause/resume semantics — if needed — can layer on top via `outliner.setTimeScale(host, 0.0)` (deferred to v1.2; not in v1.1).

### 2.4 Per-instance phase via thin-instance attribute

A `vec1` (single float) thin-instance attribute named `outlineInstancePhase` joins the existing `outlineInstanceColor` attribute on the outline mesh. Default 0. User overrides via `highlight(host, idx, { phase: 0.7 })`.

The phase shifts the time argument in the effect shader: `effective_time = time + phase * TAU`. So 3 weapons highlighted at the same moment with different phases (0, 0.33, 0.67) pulse out of sync, creating a more organic look than lockstep.

For the single-mesh case (1-element thin-instance), the phase attribute still applies — the user sets it via the same `highlight(mesh, { phase })` call, with `idx` defaulting to 0.

### 2.5 Effect composition (pulse + colorCycle + edgeFlow can stack)

The fragment shader runs the three effects in this order:

```
1. base = outlineInstanceColor                                  // per-instance base color
2. base = applyColorCycle(base, time + phase * TAU, period)     // optional hue rotation
3. base = base + applyEdgeFlow(local_pos, time, phase, ...)     // optional additive flow band
4. base.rgb *= applyPulse(time + phase * TAU, speed, amplitude) // optional intensity modulation
5. gl_FragColor = base
```

Each effect is enabled by an `AttachOptions` field (`pulse`, `colorCycle`, `edgeFlow`). When the field is absent, the corresponding shader path is skipped via a `#define` — pay-for-what-you-use compilation cost.

**The ordering is deliberate (amendment 2026-07-01):** pulse multiplies LAST, so it acts as a master intensity over everything — base color, cycled hue, and the additive flow band all breathe together. A steady flow band over a pulsing base is intentionally NOT expressible in v1.1; if real demand appears, a `pulse.affectsFlow: false` flag is the v1.2-shaped answer, not a reordering.

## 3. Effects in detail

### 3.1 Pulse modulation

**Visual:** the outline brightness oscillates with a sine wave. Magic-weapon glow.

**Math:**
```glsl
float intensity = 1.0 - amplitude + amplitude * (0.5 + 0.5 * sin(t * speed));
gl_FragColor.rgb *= intensity;
```
Where `amplitude ∈ [0, 1]` controls the depth of the modulation (0 = no pulse, 1 = full off-to-bright cycle), and `speed` is in radians per second.

**API:**
```ts
outliner.attach(mesh, {
  color: new Color3(0.5, 0.7, 1.0),
  pulse: { speed: 2.0, amplitude: 0.5 },  // pulses 2× per ~3 seconds at half-depth
})
```

**Per-instance offset:** `phase` shifts the sine argument so concurrent pulses don't lockstep.

### 3.2 Color cycling

**Visual:** the outline hue rotates around the color wheel over time. Plasma / rainbow look. Useful for power-ups, rare items, debuff indicators.

**Math:** convert the base color to HSL, rotate H by `t * 360° / period`, convert back.

```glsl
vec3 hsl = rgb_to_hsl(base.rgb);
hsl.x = mod(hsl.x + t / period, 1.0);
base.rgb = hsl_to_rgb(hsl);
```

**API:**
```ts
outliner.attach(mesh, {
  colorCycle: { period: 4.0 },  // full hue rotation every 4 seconds
})
```

`period` in seconds. The per-instance `outlineInstanceColor` defines the starting hue (saturation and lightness preserved during rotation).

### 3.3 Edge flow (NOT "sweep")

**Visual:** a bright glow band travels along an axis through the geometry. NOT silhouette-following — that's camera-dependent and intractable in real-time without depth peeling. Instead, an axis-aligned flow that produces "energy traveling along the object" — a sword's edge, a pillar's height, a tube's length.

**Why not silhouette-following:** the silhouette is a view-dependent set of edges between front-facing and back-facing geometry. Producing a "rolling" coordinate that follows the silhouette as the camera rotates would require camera-dependent vertex processing and gets visually unstable. Axis-aligned flow gives 90% of the visual impact for 10% of the implementation cost, and looks more controllable (consumer picks the axis).

**Math:**
```glsl
float band_pos = fract((local_pos[axis] - axis_min) * inv_axis_length + t * speed);
float band_dist = abs(band_pos - 0.5);  // 0 = center of band, 0.5 = far from band
// Complement form, NOT smoothstep(width, 0.0, dist): reversed smoothstep
// edges are undefined behavior in GLSL. (Corrected at implementation, v1.1.)
float band_intensity = 1.0 - smoothstep(0.0, width, band_dist);
gl_FragColor.rgb += boost * band_intensity * accent_color;
```

**API:**
```ts
outliner.attach(mesh, {
  edgeFlow: {
    axis: 'y',                        // along Y in object space
    speed: 1.0,                        // bands per second
    width: 0.15,                       // band width in normalized [0..1] axis fraction
    accentColor: new Color3(1, 1, 1),  // additive color of the band
    boost: 1.5,                        // how bright the peak of the band is
  },
})
```

**Per-instance offset:** phase shifts the band position. Three pickups at different phases get bands at different points along their respective axes.

**Documented limitations:**
- The `axis` is in OBJECT space. Rotating the host rotates the flow direction with it (intentional — feels physical for held weapons).
- Highly concave geometry (e.g. a torus knot, a hollow ring) produces a band that "jumps" around the topology. Demo will show this.
- For radially-symmetric shapes where you actually want the band to sweep around the silhouette, this approach won't deliver. That's a v1.2 candidate (centroid-angle approximation per §2.3 of the v1.1 design exploration).

## 4. API surface (v1.1 additions)

The v1.0 surface is unchanged. v1.1 extends `AttachOptions` and `HighlightOptions`:

```ts
export interface AttachOptions {
  // … v1.0 fields (color, thickness, smoothNormals, renderingGroupOffset)

  /** Pulse modulation. Omit for static intensity. */
  pulse?: { speed: number; amplitude: number }

  /** Hue rotation. Omit for static color. */
  colorCycle?: { period: number }

  /** Axis-aligned flowing band. Omit for solid outline. */
  edgeFlow?: {
    axis: 'x' | 'y' | 'z'
    speed: number
    width: number
    accentColor?: Color3
    boost?: number
  }
}

export interface HighlightOptions {
  // … v1.0 fields (color)

  /** Per-instance time-offset for animated effects, in fraction-of-cycle units (0..1). */
  phase?: number
}
```

For single-mesh case, `idx` becomes optional in highlight/clear:

```ts
outliner.highlight(mesh)              // single-mesh shorthand (idx=0)
outliner.highlight(mesh, { phase: 0.5 })  // single-mesh with options
outliner.highlight(mesh, idx, { phase: 0.5 })  // thin-instance — unchanged
```

The single-mesh shorthand is implemented via overloads — TypeScript-wise, both signatures coexist.

## 5. State model additions (internal — informative)

```ts
interface AttachedHost {
  // … v1.0 fields (outlineMesh, material, shownIndices)

  effects: {
    pulse: PulseOptions | null
    colorCycle: ColorCycleOptions | null
    edgeFlow: EdgeFlowOptions | null
  }

  timeObserver: Observer<Scene> | null  // unsubscribed in detach()
  isSingleMesh: boolean                 // true → observer also mirrors host world matrix (§2.2)
}
```

The clock is outliner-level (§2.3 amendment), anchored once at construction:
```ts
// on the outliner instance
private readonly clockOrigin = performance.now()

// in each host's observer callback
material.setFloat('time', (performance.now() - this.clockOrigin) / 1000)
if (state.isSingleMesh) {
  // computeWorldMatrix(true), NOT getWorldMatrix(): the non-forced path
  // early-returns the cached matrix whenever the scene's renderId hasn't
  // advanced (an OR with isSynchronized() short-circuits the dirty check),
  // serving stale transforms for same-frame moves and never-rendered scenes.
  state.outlineMesh.thinInstanceSetMatrixAt(0, host.computeWorldMatrix(true), true) // §2.2 moving-host mirror
}
```

## 6. Implementation order (governs v1.1 PR sequencing)

Step-by-step, each shippable independently:

1. **Single-mesh internal generalization** — detect `thinInstanceCount === 0` in `attach`, set up a 1-element thin-instance internally, AND the per-frame world-matrix mirror from §2.2 (this pulls the observer subscribe/unsubscribe lifecycle forward from step 2 — a static single-mesh outline that detaches from a moving host is not shippable). No new public API, just behavior expansion. Ship as v1.0.1 patch.
2. **Time uniform infrastructure** — outliner-global clock (§2.3), `time` uniform always present, riding the observer lifecycle from step 1. No visible behavior change. Ship as v1.0.2 patch (groundwork).
3. **Pulse effect** — first effect to ship. Smallest math, cleanest API. Ship as v1.1.0.
4. **Color cycling** — second effect, ship as v1.1.0 alongside pulse (similar shader complexity).
5. **Edge flow** — most complex. Ship as v1.1.0 alongside pulse + cycle, OR defer to v1.1.1 if it slips.
6. **Phase attribute** — required for any of the effects to look good with multiple highlighted instances. Lands with the first effect.

Total: probably one v1.0.1 patch (single-mesh) followed by one v1.1.0 (effects bundle).

## 7. Limitations & explicit non-goals for v1.1

- **Boundary vs GPU particle/spell effects (amendment 2026-07-01).** poqpoq World renders projectiles, spells, explosions, and auras as GPU effects (particles, trails, billboards) — free-flying, volumetric, world-space. This lib's effects are **surface-bound**: they live on the inverted-hull shell, hug the host's silhouette, track its transform, and are per-instance addressable through `highlight()`. The division of labor: *bound to an object's surface/silhouette and needs per-instance addressing → this lib; volumetric/emissive/spatial → the consumer's GPU effects system.* The one visual both could produce — a glowing enchanted blade — belongs here when it must scale (one shader on one sibling mesh serves hundreds of thin-instanced weapons; a particle system per weapon does not) and there when it must billow. **No particles, no trails, no world-space emitters in this lib, ever** — that is charter-level (ADR-001 single responsibility), not a v-next deferral.
- **Skinned meshes:** narrowed by the §2.2 amendment. A **rigid** mesh parented to an animated bone (sword in hand) works — the per-frame world-matrix mirror tracks bone-driven transforms. Only *actually-skinned* geometry (vertices deformed by bone weights) remains v2: the outline mesh's geometry is static, so a deforming source has a misaligned outline. ADR-002 §4 unchanged.
- **Effects are fixed at attach (amendment 2026-07-01).** The effect set compiles into the shader via `#define`s (§2.5), so changing which effects a host has — "this weapon just became enchanted" — requires `detach()` → `attach()` with new options (a shader recompile). This is the documented contract, not a bug; effect *parameters* that are uniforms (speed, period, amplitude) could become mutable in v1.2 via `setEffectParams()`, but the effect *set* stays attach-time.
- **Per-instance thickness:** still v2. Composes poorly with edge-flow (the flow band coordinate assumes uniform thickness in the geometry).
- **Texture-based effects** (animated noise, lightning patterns): out of scope. Sibling repo or v2 work.
- **True silhouette-following sweep:** v1.2 candidate, requires the centroid-angle approximation work flagged in §3.3.
- **Pause/resume per host:** `setTimeScale(host, 0.0)` is a v1.2 candidate. v1.1 always plays at 1× speed.
- **Multiple effect layers per host** (e.g. two pulses at different speeds): single instance of each effect type per attach. Composition across types is supported (pulse + cycle + flow stacked) but you can't have two simultaneous pulses on one host in v1.1.

## 8. Open questions deferred to v1.2

- ~~Should the `time` uniform be per-host or scene-global?~~ **Resolved at ratification (2026-07-01): outliner-global — see §2.3 amendment.** Per-host time resets effect phase on every detach/re-attach, and World's linkset rebuilds re-attach constantly; the pop was consumer-visible, so this stopped being an aesthetic question.
- Should `phase` be in `[0, 1]` or radians? Currently `[0, 1]` with internal multiplication by TAU; document clearly so the user doesn't have to think in radians.
- Should we expose a `setPhase(host, idx, phase)` separately from `highlight()`? Currently phase comes through `highlight()` only.
- Should uniform-backed effect *parameters* (speed, period, amplitude — not the effect set itself) become mutable post-attach via a `setEffectParams()`? See §7 attach-time contract.

Not decided here (except as marked). These shape v1.2.

## 9. References

- ADR-001 §2.1 — charter (now amended to include per-mesh)
- ADR-002 §3 — inverted-hull mechanics
- ADR-003 §2 — v1 API surface
- Inverted-hull animated effect references:
  - [Roystan toon shader](https://roystan.net/articles/toon-shader/) — base technique
  - [Ronja's hull outlines](https://www.ronja-tutorials.com/post/020-hull-outline/) — vertex displacement primer
  - [Catlike Coding hue rotation in HLSL](https://catlikecoding.com/) — color-cycle math (HSL conversion)
- Babylon `Scene.onBeforeRenderObservable` — drives the time uniform
