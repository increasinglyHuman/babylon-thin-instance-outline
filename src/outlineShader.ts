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

void main() {
    mat4 finalWorld = mat4(world0, world1, world2, world3);
    // Push the vertex outward along its normal in object space, then transform.
    // Object-space displacement is correct for uniform-scale instances; non-uniform
    // scale will produce slightly skewed outlines (acceptable for v1 — see ADR-002 §4).
    vec3 displaced = position + normal * thickness;
    gl_Position = viewProjection * finalWorld * vec4(displaced, 1.0);
    vOutlineColor = outlineInstanceColor;
}
`

const FRAGMENT_SOURCE = `
precision highp float;

varying vec4 vOutlineColor;

void main() {
    gl_FragColor = vOutlineColor;
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
