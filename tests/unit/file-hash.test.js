import { describe, it, expect } from 'vitest'
import { computeMd5 } from '../../src/main/file-hash.js'

describe('computeMd5', () => {
  it('should return 32-character hex string', () => {
    const result = computeMd5(Buffer.from('test'))
    expect(result).toHaveLength(32)
    expect(result).toMatch(/^[0-9a-f]+$/)
  })

  it('should return consistent hash for same input', () => {
    const buf = Buffer.from('hello world')
    expect(computeMd5(buf)).toBe(computeMd5(buf))
  })

  it('should return different hash for different input', () => {
    expect(computeMd5(Buffer.from('aaa'))).not.toBe(computeMd5(Buffer.from('bbb')))
  })

  it('should handle empty buffer', () => {
    const result = computeMd5(Buffer.alloc(0))
    expect(result).toHaveLength(32)
  })

  it('should return known MD5 for known input', () => {
    // MD5 of 'hello world' is 5eb63bbbe01eeed093cb22bb8f5acdc3
    expect(computeMd5(Buffer.from('hello world'))).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3')
  })
})
