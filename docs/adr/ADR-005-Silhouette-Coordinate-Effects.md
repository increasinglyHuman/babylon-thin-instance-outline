# ADR-005 — Silhouette-Coordinate Effects (centroid-angle rim flow)

**Status:** ✅ Accepted
**Date:** 2026-07-01
**Author:** Allen Partridge + Claude
**Depends on:** ADR-002 (inverted-hull technique), ADR-004 (effects framework)
**Relates to:** ADR-004 §3.3 ("true silhouette-following sweep: v1.2 candidate") and §3.4 (sizzle — the effect that does NOT need this coordinate)

---

## 1. Context

ADR-004 rejected silhouette-following effects for v1.1 as "camera-dependent and intractable in real-time without depth peeling." That rejection was about *finding* the silhouette. Two later realizations changed the picture:

1. **The inverted hull already finds the silhouette.** The only outline fragments that survive rendering are the ones poking out past the host's front faces — every visible outline pixel is on the rim *by construction*. Effects that just need to *appear on* the edge (sizzle crackle, ADR-004 §3.4) need no coordinate at all.
2. **Effects that *travel around* the rim need only an angular coordinate, not the silhouette curve itself.** A hot-spot orbiting the visible edge doesn't care about the exact silhouette topology — it needs a stable, cyclic [0..1) parameter that wraps the shape as seen from the camera. That's obtainable per-vertex with two matrix multiplies: the **centroid-angle approximation**.

This ADR specs that coordinate and the first effect built on it: `rimFlow`.

## 2. Decision

### 2.1 The coordinate: centroid angle in view space

For each vertex of the outline mesh, compute in the vertex shader:

```glsl
vec4 viewVert     = view * finalWorld * vec4(displaced, 1.0);
vec4 viewCentroid = view * finalWorld * vec4(geomCentroid, 1.0);
vRimDir = viewVert.xy - viewCentroid.xy;   // varying, vec2
```

- `geomCentroid` is the object-space **bounding-box center** of the outline geometry, computed CPU-side at attach (min/max over the copied positions). Bbox center over vertex average: robust to non-uniform vertex density, already half-computed for edgeFlow, and cheap.
- `view` is Babylon's standard view-matrix uniform (auto-bound by ShaderMaterial when listed).
- Per-instance correctness falls out for free: `finalWorld` is the *instance* matrix, so each thin instance gets its own centroid and its own rim coordinate.

The fragment shader recovers the angle:

```glsl
float rimAngle = atan(vRimDir.y, vRimDir.x);       // [-PI, PI]
float u = rimAngle / TAU + 0.5;                    // [0, 1) — cyclic rim coordinate
```

**Why the varying is a direction vector, not the angle itself:** an angle varying has a hard seam at ±π — triangles spanning the discontinuity interpolate through garbage. Interpolating the (unnormalized) direction vector is smooth everywhere; `atan` runs per-fragment. Degenerate case (fragment at the exact centroid, `vRimDir ≈ 0`) can't occur on visible rim fragments of a hull that pokes *outward*.

### 2.2 The effect: `rimFlow`

A bright hot-spot that orbits the visible silhouette:

```glsl
float hs = fract(u - t * rimSpeed);                      // t includes per-instance phase
float rimDist = abs(hs - 0.5);                           // cyclic distance to hot-spot
float rimIntensity = 1.0 - smoothstep(0.0, rimWidth, rimDist);
base.rgb += rimBoost * rimIntensity * rimAccentColor;
```

Same shape as edgeFlow's band math; the coordinate is what's new. The cyclic `fract` + centered distance means the hot-spot wraps seamlessly.

**API (mirrors the ADR-004 effect pattern exactly):**

```ts
outliner.attach(mesh, {
  rimFlow: {
    speed: 0.4,                       // orbits per second; negative reverses direction
    width: 0.12,                      // hot-spot width as fraction [0..1] of the rim
    accentColor: new Color3(1, 1, 1), // additive; default white
    boost: 2.0,                       // peak brightness; default 1
  },
})
```

Compiled in via `#define OUTLINE_RIM_FLOW`; all parameters uniform-backed → `setEffectParams`-tunable; per-instance `phase` de-syncs orbits across instances.

### 2.3 Composition order (extends ADR-004 §2.5)

```
colorCycle → edgeFlow → rimFlow → sizzle → pulse
```

Additive effects stack in flow → rim → sizzle order (broad band, orbiting hot-spot, fine crackle on top); pulse stays the master dimmer over everything.

## 3. Known limitations (documented, accepted)

- **Concave / multi-lobed topology:** all rim points at the same centroid angle light together — on a torus knot the hot-spot appears on several lobes at once, and can "jump" between them as the camera moves. This is inherent to a 1-D angular approximation of a potentially multi-curve silhouette. The demo shows it deliberately; for convex-ish shapes (weapons, pickups, characters) it reads perfectly.
- **View-dependence is the point:** the coordinate rotates with the camera (the hot-spot stays "3 o'clock on screen" only if speed=0). This is correct for the intended visual — an orbiting energy — and is what ADR-004 §3.3 warned about for *bands*; a compact hot-spot reads as stable where a full band would visibly swim.
- **Extreme perspective:** with the camera very close, the 2-D view-space projection of the centroid can land outside the visible silhouette, skewing the angular distribution. Not visible at normal viewing distances; not worth a depth-aware fix.

## 4. Alternatives rejected

- **Screen-space edge detection (post-process):** finds the true silhouette, but breaks the lib's single-draw-call composability, costs a full-screen pass per frame, and entangles us with the consumer's rendering pipeline. Charter violation (ADR-001).
- **Geometric silhouette extraction (CPU, per frame):** exact, and exactly the "intractable" path ADR-004 rejected — O(edges) per instance per frame with camera-dependent results that can't be cached.
- **Arc-length parameterization of the silhouette:** would make the hot-spot speed uniform along the curve (centroid-angle speed varies with local radius), but requires knowing the curve — same intractability. Angular speed variation is invisible in practice for a soft hot-spot.

## 5. Tests

- Define + uniform wiring (`OUTLINE_RIM_FLOW`, `rimSpeed/rimWidth/rimAccentColor/rimBoost`, `geomCentroid`, `view` in the uniforms list).
- Centroid computation: unit-cube host → `geomCentroid ≈ (0,0,0)`; translated geometry → bbox center, not origin.
- `setEffectParams` partial updates; silently ignored when attached without rimFlow.
- Visual correctness (the orbit actually orbiting) is demo-verified per the repo's testing charter.
