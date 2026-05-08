import { describe, expect, it } from 'vitest'
import { averageNormalsAtSharedPositions } from '../src/smoothNormals'

describe('averageNormalsAtSharedPositions', () => {
  it('averages normals across vertices at the same position', () => {
    // Three coincident vertices at origin with cardinal-axis normals
    const positions = [0, 0, 0,  0, 0, 0,  0, 0, 0]
    const normals = new Float32Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ])
    averageNormalsAtSharedPositions(positions, normals)
    // Each vertex should now have the diagonal-direction unit vector
    const expected = 1 / Math.sqrt(3)
    for (let i = 0; i < 3; i++) {
      expect(normals[i * 3]).toBeCloseTo(expected, 6)
      expect(normals[i * 3 + 1]).toBeCloseTo(expected, 6)
      expect(normals[i * 3 + 2]).toBeCloseTo(expected, 6)
    }
  })

  it('leaves a vertex with no shared neighbors unchanged', () => {
    const positions = [0, 0, 0,  10, 0, 0]
    const normals = new Float32Array([1, 0, 0,  0, 1, 0])
    averageNormalsAtSharedPositions(positions, normals)
    expect(normals[0]).toBeCloseTo(1, 6)
    expect(normals[1]).toBeCloseTo(0, 6)
    expect(normals[2]).toBeCloseTo(0, 6)
    expect(normals[3]).toBeCloseTo(0, 6)
    expect(normals[4]).toBeCloseTo(1, 6)
    expect(normals[5]).toBeCloseTo(0, 6)
  })

  it('handles cube-corner case: 3 face-aligned normals → diagonal unit vector', () => {
    // Simulate one cube corner: 3 vertices at (1,1,1), each with one face-axis normal
    const positions = [1, 1, 1,  1, 1, 1,  1, 1, 1]
    const normals = new Float32Array([
      1, 0, 0,  // +X face
      0, 1, 0,  // +Y face
      0, 0, 1,  // +Z face
    ])
    averageNormalsAtSharedPositions(positions, normals)
    // All three vertices should now point along the (1,1,1) diagonal, normalized
    const expected = 1 / Math.sqrt(3)
    for (let i = 0; i < 3; i++) {
      expect(normals[i * 3]).toBeCloseTo(expected, 6)
      expect(normals[i * 3 + 1]).toBeCloseTo(expected, 6)
      expect(normals[i * 3 + 2]).toBeCloseTo(expected, 6)
    }
  })

  it('does not write NaN when summed normals cancel to zero', () => {
    // Two coincident vertices with opposing normals → sum = 0 → fallback path
    const positions = [0, 0, 0,  0, 0, 0]
    const normals = new Float32Array([1, 0, 0,  -1, 0, 0])
    averageNormalsAtSharedPositions(positions, normals)
    for (let i = 0; i < normals.length; i++) {
      expect(Number.isNaN(normals[i])).toBe(false)
    }
  })

  it('respects epsilon for "close enough" position matching', () => {
    // Two vertices microscopically close — should be treated as coincident
    const positions = [0, 0, 0,  1e-7, 0, 0]
    const normals = new Float32Array([1, 0, 0,  0, 1, 0])
    averageNormalsAtSharedPositions(positions, normals, 1e-5)
    const expected = 1 / Math.sqrt(2)
    expect(normals[0]).toBeCloseTo(expected, 6)
    expect(normals[1]).toBeCloseTo(expected, 6)
  })
})
