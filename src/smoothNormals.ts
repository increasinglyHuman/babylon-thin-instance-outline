/**
 * smoothNormals.ts — averages normals across coincident vertex positions.
 * Depends on: nothing (pure typed-array math)
 * Depended on by: ThinInstanceOutliner.ts (internal)
 *
 * Why this exists: Babylon's `MeshBuilder.CreateBox` produces 24 vertices for a
 * cube — 4 per face, 6 faces — each with its own face-aligned normal. At each
 * physical corner of the cube, 3 vertices coincide in position but have 3
 * different normals (one per face that meets there). The inverted-hull vertex
 * shader displaces each vertex along its own normal:
 *
 *     displaced = position + normal * thickness
 *
 * With per-face normals at corners, the 3 originally-coincident vertices push
 * outward in 3 different directions → triangles tear visibly at corners.
 *
 * Fix: average the normals across vertices that share a position. The corner's
 * three vertices then push in the same averaged direction (the diagonal),
 * stay coincident, and the outline mesh's silhouette is continuous.
 *
 * The cube's GEOMETRY is not modified — vertex POSITIONS stay sharp. Only the
 * `normal` attribute changes, and only on the OUTLINE mesh's geometry (the host
 * keeps its original face-shaded normals so its lighting still looks crisp).
 *
 * O(n²) in vertex count. Acceptable for typical thin-instance hosts (cubes,
 * primitives, asset-imported meshes <10k verts). Spatial hashing would speed
 * this up for larger meshes; deferred until someone hits that limit.
 */

const DEFAULT_EPSILON = 1e-5

/**
 * Replace the values in `normals` with averaged normals across all vertices
 * sharing the same position (within `epsilon` distance). Mutates in place.
 *
 * Both arrays are stride-3 (xyz xyz xyz ...). They must have the same vertex
 * count; mismatched lengths are silently no-op (decorative system).
 */
export function averageNormalsAtSharedPositions(
  positions: ArrayLike<number>,
  normals: Float32Array,
  epsilon: number = DEFAULT_EPSILON,
): void {
  const vertexCount = positions.length / 3
  if (vertexCount * 3 !== normals.length) return

  const epsilonSq = epsilon * epsilon
  const result = new Float32Array(normals.length)

  for (let i = 0; i < vertexCount; i++) {
    const px = positions[i * 3]
    const py = positions[i * 3 + 1]
    const pz = positions[i * 3 + 2]

    let sx = 0
    let sy = 0
    let sz = 0

    for (let j = 0; j < vertexCount; j++) {
      const dx = positions[j * 3] - px
      const dy = positions[j * 3 + 1] - py
      const dz = positions[j * 3 + 2] - pz
      if (dx * dx + dy * dy + dz * dz <= epsilonSq) {
        sx += normals[j * 3]
        sy += normals[j * 3 + 1]
        sz += normals[j * 3 + 2]
      }
    }

    const len = Math.sqrt(sx * sx + sy * sy + sz * sz)
    if (len > 1e-9) {
      result[i * 3] = sx / len
      result[i * 3 + 1] = sy / len
      result[i * 3 + 2] = sz / len
    } else {
      // Degenerate (sum cancelled to zero — e.g., a vertex on a sphere where
      // every face normal points outward but the average is undefined). Fall
      // back to the original normal so we never write NaN to the buffer.
      result[i * 3] = normals[i * 3]
      result[i * 3 + 1] = normals[i * 3 + 1]
      result[i * 3 + 2] = normals[i * 3 + 2]
    }
  }

  normals.set(result)
}
