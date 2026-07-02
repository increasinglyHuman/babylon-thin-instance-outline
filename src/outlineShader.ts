/**
 * outlineShader.ts — vertex/fragment GLSL for the inverted-hull outline pass.
 * Depends on: @babylonjs/core (Effect.ShadersStore for registration)
 * Depended on by: ThinInstanceOutliner.ts (internal)
 *
 * The shader pair is registered into Babylon's global ShadersStore under a namespaced
 * key the first time an outliner is constructed. ShaderMaterial then references the
 * pair by `OUTLINE_SHADER_PATH`. Registration is idempotent.
 *
 * The vertex shader expects Babylon's standard thin-instance attribute layout:
 * `world0..world3` are vec4 columns of the per-instance world matrix. We do NOT use
 * `#include<instancesDeclaration>` etc. because those chunks expand into branches
 * we don't need (rigid bones, baked vertex animation, multiview). Inlining keeps
 * the shader minimal and easy to audit.
 *
 * Animated effects (ADR-004): ONE source with `#ifdef` blocks per effect —
 * OUTLINE_PULSE, OUTLINE_COLOR_CYCLE, OUTLINE_EDGE_FLOW — plus
 * OUTLINE_HAS_EFFECTS gating the per-instance phase attribute. Defines are
 * injected per-material via ShaderMaterial's `options.defines`, so hosts
 * without effects compile the same minimal shader v1.0 shipped
 * (pay-for-what-you-use, ADR-004 §2.5).
 */

import { Effect } from '@babylonjs/core'

/** Namespaced key for ShadersStore — avoids collision with user shaders. */
export const OUTLINE_SHADER_PATH = 'p0qp0qThinInstanceOutline'

/**
 * Custom thin-instance attribute name for per-instance outline color (vec4 RGBA).
 * NOT named "color" because Babylon silently renames `kind === 'color'` to
 * `'colorInstance'` inside `thinInstanceRegisterAttribute` (a backward-compat
 * shim for `VertexBuffer.ColorKind` vs `ColorInstanceKind`). Using our own name
 * avoids the rename surprise entirely.
 */
export const OUTLINE_COLOR_ATTRIBUTE = 'outlineInstanceColor'

/**
 * Per-instance time-offset for animated effects, in fraction-of-cycle units
 * [0..1] (multiplied by TAU in the fragment shader — ADR-004 §2.4). Only
 * registered on the outline mesh when at least one effect is enabled.
 */
export const OUTLINE_PHASE_ATTRIBUTE = 'outlineInstancePhase'

const VERTEX_SOURCE = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;

// Babylon thin-instance per-instance world matrix (4 vec4 columns)
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;

// Per-thin-instance outline color (vec4 RGBA)
attribute vec4 outlineInstanceColor;

uniform mat4 viewProjection;
uniform float thickness;

varying vec4 vOutlineColor;

#ifdef OUTLINE_HAS_EFFECTS
attribute float outlineInstancePhase;
varying float vPhase;
#endif

#ifdef OUTLINE_EDGE_FLOW
// Geometry extent along FLOW_AXIS, computed CPU-side at attach: the band
// coordinate must be normalized [0..1] regardless of mesh size or centering.
uniform float flowMin;
uniform float flowInvLength;
varying float vFlowCoord;
#endif

#ifdef OUTLINE_SIZZLE
varying vec3 vObjPos;
#endif

#ifdef OUTLINE_RIM_FLOW
uniform mat4 view;
uniform vec3 geomCentroid; // object-space bbox center, computed at attach
// Direction from instance centroid to vertex in VIEW space (ADR-005 §2.1).
// A vec2 direction, NOT the angle: an angle varying has a hard seam at ±π
// where interpolation breaks; the direction interpolates smoothly and the
// fragment shader runs atan per-pixel.
varying vec2 vRimDir;
#endif

void main() {
    mat4 finalWorld = mat4(world0, world1, world2, world3);
    // Push the vertex outward along its normal in object space, then transform.
    // Object-space displacement is correct for uniform-scale instances; non-uniform
    // scale will produce slightly skewed outlines (acceptable for v1 — see ADR-002 §4).
    vec3 displaced = position + normal * thickness;
    gl_Position = viewProjection * finalWorld * vec4(displaced, 1.0);
    vOutlineColor = outlineInstanceColor;
#ifdef OUTLINE_HAS_EFFECTS
    vPhase = outlineInstancePhase;
#endif
#ifdef OUTLINE_EDGE_FLOW
    // FLOW_AXIS is a define (0/1/2) — constant vector index, valid in GLSL ES.
    vFlowCoord = (position[FLOW_AXIS] - flowMin) * flowInvLength;
#endif
#ifdef OUTLINE_SIZZLE
    vObjPos = position; // pre-displacement object space: view-stable noise domain
#endif
#ifdef OUTLINE_RIM_FLOW
    vec4 viewVert = view * finalWorld * vec4(displaced, 1.0);
    vec4 viewCentroid = view * finalWorld * vec4(geomCentroid, 1.0);
    vRimDir = viewVert.xy - viewCentroid.xy;
#endif
}
`

const FRAGMENT_SOURCE = `
precision highp float;

varying vec4 vOutlineColor;

// Elapsed seconds from the outliner-global clock (ADR-004 §2.3). Declared
// unconditionally so the uniform contract is stable; without effect defines
// it's unused and the compiler strips it (setFloat degrades to a no-op).
uniform float time;

#ifdef OUTLINE_HAS_EFFECTS
varying float vPhase;
#endif

#ifdef OUTLINE_PULSE
uniform float pulseSpeed;     // radians per second
uniform float pulseAmplitude; // [0..1] modulation depth
#endif

#ifdef OUTLINE_COLOR_CYCLE
uniform float cyclePeriod; // seconds per full hue rotation

// HSL round-trip so hue rotates while saturation/lightness are preserved
// (ADR-004 §3.2). Compiled only when the effect is on.
vec3 rgb2hsl(vec3 c) {
    float maxc = max(max(c.r, c.g), c.b);
    float minc = min(min(c.r, c.g), c.b);
    float l = (maxc + minc) * 0.5;
    float h = 0.0;
    float s = 0.0;
    float d = maxc - minc;
    if (d > 1e-5) {
        s = l > 0.5 ? d / (2.0 - maxc - minc) : d / (maxc + minc);
        if (maxc == c.r)      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
        else if (maxc == c.g) h = (c.b - c.r) / d + 2.0;
        else                  h = (c.r - c.g) / d + 4.0;
        h /= 6.0;
    }
    return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t) {
    t = fract(t);
    if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
    if (t < 0.5)       return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    return p;
}

vec3 hsl2rgb(vec3 hsl) {
    if (hsl.y < 1e-5) return vec3(hsl.z);
    float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
    float p = 2.0 * hsl.z - q;
    return vec3(
        hue2rgb(p, q, hsl.x + 1.0 / 3.0),
        hue2rgb(p, q, hsl.x),
        hue2rgb(p, q, hsl.x - 1.0 / 3.0)
    );
}
#endif

#ifdef OUTLINE_EDGE_FLOW
varying float vFlowCoord;
uniform float flowSpeed;      // bands per second
uniform float flowWidth;      // band half-width, normalized [0..1] axis fraction
uniform vec3 flowAccentColor; // additive band color
uniform float flowBoost;      // band peak brightness multiplier
#endif

#ifdef OUTLINE_RIM_FLOW
varying vec2 vRimDir;
uniform float rimSpeed;      // orbits per second (negative reverses)
uniform float rimWidth;      // hot-spot width, fraction [0..1] of the rim
uniform vec3 rimAccentColor; // additive hot-spot color
uniform float rimBoost;      // hot-spot peak brightness
#endif

#ifdef OUTLINE_SIZZLE
varying vec3 vObjPos;
uniform float sizzleScale;     // noise feature density, object-space units
uniform float sizzleSpeed;     // flicker speed
uniform float sizzleThreshold; // fleck coverage: higher = sparser
uniform vec3 sizzleColor;      // additive fleck color
uniform float sizzleBoost;     // fleck brightness

// Hash-based value noise — pure GLSL, no textures (zero-dep rule, ADR-004 §3.4).
float sizzleHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float sizzleNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(mix(sizzleHash(i),                   sizzleHash(i + vec3(1, 0, 0)), f.x),
            mix(sizzleHash(i + vec3(0, 1, 0)),   sizzleHash(i + vec3(1, 1, 0)), f.x), f.y),
        mix(mix(sizzleHash(i + vec3(0, 0, 1)),   sizzleHash(i + vec3(1, 0, 1)), f.x),
            mix(sizzleHash(i + vec3(0, 1, 1)),   sizzleHash(i + vec3(1, 1, 1)), f.x), f.y),
        f.z);
}
#endif

void main() {
    vec4 base = vOutlineColor;

#ifdef OUTLINE_HAS_EFFECTS
    // Per-instance phase shifts the effective time (ADR-004 §2.4) so
    // simultaneously-highlighted instances animate out of lockstep.
    float t = time + vPhase * 6.28318530718;
#endif

    // Effect order is deliberate (ADR-004 §2.5, extended by ADR-005 §2.3):
    // cycle hue, then additive layers broad-to-fine (flow band → rim hot-spot
    // → sizzle flecks), THEN multiply pulse — the master intensity over all.
#ifdef OUTLINE_COLOR_CYCLE
    vec3 hsl = rgb2hsl(base.rgb);
    hsl.x = fract(hsl.x + t / cyclePeriod);
    base.rgb = hsl2rgb(hsl);
#endif

#ifdef OUTLINE_EDGE_FLOW
    float bandPos = fract(vFlowCoord + t * flowSpeed);
    float bandDist = abs(bandPos - 0.5); // 0 = band center, 0.5 = farthest
    // NOT smoothstep(width, 0.0, dist): reversed edges are undefined behavior
    // in GLSL. The complement form is equivalent and well-defined.
    float bandIntensity = 1.0 - smoothstep(0.0, flowWidth, bandDist);
    base.rgb += flowBoost * bandIntensity * flowAccentColor;
#endif

#ifdef OUTLINE_RIM_FLOW
    // Centroid-angle silhouette coordinate (ADR-005 §2.1): the fragment's
    // angle around the instance centroid in view space, mapped to cyclic [0,1).
    float rimAngle = atan(vRimDir.y, vRimDir.x);   // [-PI, PI]
    float rimU = rimAngle * 0.15915494309 + 0.5;   // (1/TAU) → [0, 1)
    float rimHs = fract(rimU - t * rimSpeed);
    float rimDist = abs(rimHs - 0.5);              // cyclic distance to hot-spot
    float rimIntensity = 1.0 - smoothstep(0.0, rimWidth, rimDist);
    base.rgb += rimBoost * rimIntensity * rimAccentColor;
#endif

#ifdef OUTLINE_SIZZLE
    // Two octaves, animated in object space (view-stable), thresholded to
    // flecks. Every visible fragment IS the silhouette (inverted-hull property,
    // ADR-004 §3.4) — no edge detection needed.
    float sn = 0.65 * sizzleNoise(vObjPos * sizzleScale + vec3(0.0, t * sizzleSpeed, t * sizzleSpeed * 0.7))
             + 0.35 * sizzleNoise(vObjPos * sizzleScale * 2.7 + vec3(t * sizzleSpeed * 1.3, 0.0, 0.0));
    float flecks = smoothstep(sizzleThreshold, 1.0, sn);
    base.rgb += sizzleBoost * flecks * sizzleColor;
#endif

#ifdef OUTLINE_PULSE
    float intensity = 1.0 - pulseAmplitude + pulseAmplitude * (0.5 + 0.5 * sin(t * pulseSpeed));
    base.rgb *= intensity;
#endif

    gl_FragColor = base;
}
`

let registered = false

/**
 * Idempotent registration of the outline shader pair into Effect.ShadersStore.
 * Safe to call from every outliner constructor.
 */
export function registerOutlineShader(): void {
  if (registered) return
  Effect.ShadersStore[`${OUTLINE_SHADER_PATH}VertexShader`] = VERTEX_SOURCE
  Effect.ShadersStore[`${OUTLINE_SHADER_PATH}FragmentShader`] = FRAGMENT_SOURCE
  registered = true
}

/** Test-only escape hatch: lets the test suite reset the registration flag. */
export function _resetForTest(): void {
  registered = false
  delete Effect.ShadersStore[`${OUTLINE_SHADER_PATH}VertexShader`]
  delete Effect.ShadersStore[`${OUTLINE_SHADER_PATH}FragmentShader`]
}
