/**
 * matrixHelpers.ts — pure helpers for the outline matrix buffer.
 * Depends on: @babylonjs/core (Matrix only)
 * Depended on by: ThinInstanceOutliner.ts (internal)
 *
 * Hosts the ZERO_SCALE_MATRIX idiom — the central trick that makes per-instance
 * show/hide work without mutating thinInstanceCount or removing entries.
 */

import { Matrix } from '@babylonjs/core'

/**
 * A degenerate transform matrix used as the "hidden" state for an outline instance.
 *
 * Why this matrix specifically:
 *   For any input vertex v = (x, y, z, 1), `ZERO_SCALE_MATRIX * v = (0, 0, 0, 1)`.
 *   Every vertex of the instance collapses to the world origin → the triangles
 *   degenerate (zero area) → the rasterizer emits no fragments → invisible.
 *
 * Why not just lower thinInstanceCount or skip the index:
 *   - Index stability: highlight(host, 7) writes at slot 7. If we shrink the buffer
 *     to remove hidden slots, every other index shifts and the consumer's mental model
 *     breaks. Zero-scale preserves the 1-to-1 source-index ↔ outline-index mapping.
 *   - GPU-cheap: one matrix write, no buffer realloc, no count adjustment.
 *
 * Layout: identity-shaped homogeneous row, all other rows zero. In the column-major
 * thin-instance attribute layout (world0..world3), this is c0=c1=c2=(0,0,0,0),
 * c3=(0,0,0,1) — verified safe for any source vertex value.
 */
export const ZERO_SCALE_MATRIX: Readonly<Matrix> = Matrix.FromValues(
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 1,
)

/**
 * Fill a Float32Array of stride-16 matrix entries with ZERO_SCALE_MATRIX.
 * Used at attach() to initialize the outline buffer such that no instance is visible
 * until the consumer calls highlight().
 */
export function fillBufferWithZeroScale(buffer: Float32Array, instanceCount: number): void {
  const stride = 16
  // Use the underlying Float32Array directly — `.m` is Babylon's stable public field
  // for matrix raw storage and avoids allocating per-call.
  const zeroFloats = ZERO_SCALE_MATRIX.m
  for (let i = 0; i < instanceCount; i++) {
    buffer.set(zeroFloats, i * stride)
  }
}
