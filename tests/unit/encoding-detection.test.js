import { describe, it, expect } from 'vitest'
import { decodeBuffer } from '../../src/main/encoding.js'

describe('decodeBuffer', () => {
  it('should handle empty buffer', () => {
    const result = decodeBuffer(Buffer.alloc(0))
    expect(result.content).toBe('')
    expect(result.encoding).toBe('UTF-8')
  })

  it('should decode UTF-8 text correctly', () => {
    const buf = Buffer.from('Hello World', 'utf-8')
    const result = decodeBuffer(buf)
    expect(result.content).toBe('Hello World')
  })

  it('should strip UTF-8 BOM and decode correctly', () => {
    const bom = Buffer.from([0xEF, 0xBB, 0xBF])
    const text = Buffer.from('Hello', 'utf-8')
    const buf = Buffer.concat([bom, text])
    const result = decodeBuffer(buf)
    expect(result.content).not.toContain('﻿') // BOM char removed
    expect(result.content).toContain('Hello')
  })

  it('should return UTF-8 for ASCII-only content', () => {
    const buf = Buffer.from('const x = 1;', 'utf-8')
    const result = decodeBuffer(buf)
    expect(result.encoding).toBeTruthy()
    expect(result.content).toBe('const x = 1;')
  })
})
