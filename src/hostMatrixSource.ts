/**
 * hostMatrixSource.ts — reads a host's thin-instance matrices from ground truth.
 * Depends on: @babylonjs/core (Mesh)
 * Depended on by: ThinInstanceOutliner.ts (internal; not part of the public API)
 *
 * This is the ONLY file in the library that touches a Babylon internal, and it does
 * so deliberately (ADR-006). It is quarantined here so that when Babylon grows a
 * public non-memoised matrix accessor, exactly one file changes.
 *
 * Why not the public `Mesh.thinInstanceGetWorldMatrices()`: it is memoised, and the
 * cache has exactly ONE invalidation site (`thinInstanceSetBuffer`). It is therefore
 * silently stale for the two most common ways to move a thin instance:
 *
 *   1. Writing into your own Float32Array, then `thinInstanceBufferUpdated('matrix')`
 *      — the bulk path. `thinInstanceBufferUpdated` never touches the cache.
 *   2. Reusing one scratch Matrix across `thinInstanceSetMatrixAt` calls — the cache
 *      stores the Matrix BY REFERENCE (`worldMatrices[i] = matrix`, no clone), so every
 *      slot aliases the same object and reads back the last value written.
 *
 * `_thinInstanceDataStorage.matrixData` is the array Babylon uploads to the GPU. It is
 * ground truth by construction: immune to both failure modes above, and always current
 * across buffer growth (which replaces the array wholesale — a reference we cached
 * ourselves would be silently orphaned, which is why we re-read it on every access
 * rather than storing it at attach).
 */

import type { Mesh } from '@babylonjs/core'

const FLOATS_PER_MATRIX = 16

interface ThinInstanceStorage {
  matrixData?: Float32Array | null
}

function getStorage(host: Mesh): ThinInstanceStorage | null {
  return (
    (host as unknown as { _thinInstanceDataStorage?: ThinInstanceStorage })._thinInstanceDataStorage ??
    null
  )
}

/**
 * True when the ground-truth matrix array is reachable. False means Babylon changed
 * its internal layout and {@link copyHostMatrixInto} is running on the stale-prone
 * public fallback — `attach()` warns once per host in that case.
 */
export function hasDirectMatrixAccess(host: Mesh): boolean {
  return !!getStorage(host)?.matrixData
}

/**
 * Copy the host's thin-instance matrix at `sourceIndex` into `dest` at `destIndex`
 * (both stride-16). Returns false if either index is out of range, leaving `dest`
 * untouched.
 *
 * Copies raw floats rather than materializing a Matrix: allocation-free, so a moving
 * host can be re-mirrored every frame without GC churn.
 */
export function copyHostMatrixInto(
  host: Mesh,
  sourceIndex: number,
  dest: Float32Array,
  destIndex: number,
): boolean {
  const destOffset = destIndex * FLOATS_PER_MATRIX
  if (destIndex < 0 || destOffset + FLOATS_PER_MATRIX > dest.length) return false

  const src = getStorage(host)?.matrixData
  if (src) {
    const srcOffset = sourceIndex * FLOATS_PER_MATRIX
    if (sourceIndex < 0 || srcOffset + FLOATS_PER_MATRIX > src.length) return false
    for (let k = 0; k < FLOATS_PER_MATRIX; k++) dest[destOffset + k] = src[srcOffset + k]
    return true
  }

  // Fallback: Babylon renamed or removed the field. Stale-prone per the header —
  // strictly better than not rendering, and attach() has already warned.
  const matrix = host.thinInstanceGetWorldMatrices()[sourceIndex]
  if (!matrix) return false
  matrix.copyToArray(dest, destOffset)
  return true
}
