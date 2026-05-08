import { describe, it, expect } from 'vitest'
import { ZERO_SCALE_MATRIX, fillBufferWithZeroScale } from '../src/matrixHelpers'

describe('ZERO_SCALE_MATRIX', () => {
  it('collapses any vertex to the homogeneous origin (0,0,0,1)', () => {
    // Babylon stores matrices column-major in `.m`. For our claim "any vertex v
    // mapped through this matrix produces (0,0,0,1)" to hold, columns 0,1,2 must
    // be all zero and column 3 must be (0,0,0,1).
    const m = ZERO_SCALE_MATRIX.m
    expect(m.length).toBe(16)
    // columns 0,1,2 entirely zero
    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 4; row++) {
        expect(m[col * 4 + row]).toBe(0)
      }
    }
    // column 3 = (0, 0, 0, 1)
    expect(m[12]).toBe(0)
    expect(m[13]).toBe(0)
    expect(m[14]).toBe(0)
    expect(m[15]).toBe(1)
  })
})

describe('fillBufferWithZeroScale', () => {
  it('writes ZERO_SCALE_MATRIX at every stride-16 slot', () => {
    const count = 4
    const buf = new Float32Array(count * 16)
    // Pre-fill with garbage to ensure overwrite happens
    buf.fill(99)

    fillBufferWithZeroScale(buf, count)

    for (let i = 0; i < count; i++) {
      const base = i * 16
      // every entry except the homogeneous w (offset 15) should be 0
      for (let off = 0; off < 15; off++) {
        expect(buf[base + off]).toBe(0)
      }
      expect(buf[base + 15]).toBe(1)
    }
  })

  it('handles zero-count buffers without writing', () => {
    const buf = new Float32Array(0)
    expect(() => fillBufferWithZeroScale(buf, 0)).not.toThrow()
  })
})
