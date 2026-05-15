/**
 * Unit tests for searchHexBytes pure function
 * tests/unit/hex-utils.test.js
 *
 * Environment: node (vitest.config.js default)
 * Tests: searchHexBytes(haystack: Uint8Array, needle: Uint8Array) => number[]
 */

import { describe, it, expect } from 'vitest'
import { searchHexBytes, formatSize } from '../../src/renderer/src/views/hex-compare.js'

describe('searchHexBytes', () => {
  it('should return empty array when needle is empty', () => {
    const haystack = new Uint8Array([0x01, 0x02, 0x03])
    const needle   = new Uint8Array([])
    expect(searchHexBytes(haystack, needle)).toEqual([])
  })

  it('should return empty array when haystack is empty', () => {
    const haystack = new Uint8Array([])
    const needle   = new Uint8Array([0x01])
    expect(searchHexBytes(haystack, needle)).toEqual([])
  })

  it('should find single-byte needle at offset 0', () => {
    const haystack = new Uint8Array([0xFF, 0x00, 0x1A])
    const needle   = new Uint8Array([0xFF])
    expect(searchHexBytes(haystack, needle)).toEqual([0])
  })

  it('should find single-byte needle at multiple offsets', () => {
    const haystack = new Uint8Array([0xAA, 0xBB, 0xAA, 0xCC, 0xAA])
    const needle   = new Uint8Array([0xAA])
    expect(searchHexBytes(haystack, needle)).toEqual([0, 2, 4])
  })

  it('should find multi-byte needle at correct offset', () => {
    const haystack = new Uint8Array([0x00, 0xFF, 0x00, 0x1A, 0x00])
    const needle   = new Uint8Array([0xFF, 0x00, 0x1A])
    expect(searchHexBytes(haystack, needle)).toEqual([1])
  })

  it('should return empty array when needle is not found', () => {
    const haystack = new Uint8Array([0x01, 0x02, 0x03, 0x04])
    const needle   = new Uint8Array([0xDE, 0xAD])
    expect(searchHexBytes(haystack, needle)).toEqual([])
  })

  it('should handle partial match at end of haystack (not found)', () => {
    // haystack ends with 0xFF 0x00 but needle is 0xFF 0x00 0x1A — partial match only
    const haystack = new Uint8Array([0x01, 0xFF, 0x00])
    const needle   = new Uint8Array([0xFF, 0x00, 0x1A])
    expect(searchHexBytes(haystack, needle)).toEqual([])
  })

  it('should not go out of bounds when needle is longer than haystack', () => {
    const haystack = new Uint8Array([0x01, 0x02])
    const needle   = new Uint8Array([0x01, 0x02, 0x03])
    expect(searchHexBytes(haystack, needle)).toEqual([])
  })

  it('should find overlapping matches', () => {
    // Pattern: AA AA AA — needle AA AA appears at 0 and 1
    const haystack = new Uint8Array([0xAA, 0xAA, 0xAA])
    const needle   = new Uint8Array([0xAA, 0xAA])
    expect(searchHexBytes(haystack, needle)).toEqual([0, 1])
  })

  it('should find needle that spans the full haystack length', () => {
    const data = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])
    expect(searchHexBytes(data, data)).toEqual([0])
  })

  it('should return empty array when haystack is null-like (undefined inputs)', () => {
    // Guard: passing null/undefined should not throw
    expect(searchHexBytes(null, new Uint8Array([0x01]))).toEqual([])
    expect(searchHexBytes(new Uint8Array([0x01]), null)).toEqual([])
  })

  it('should correctly find ASCII-encoded needle bytes', () => {
    // 'hello' = 0x68 0x65 0x6C 0x6C 0x6F
    const haystack = new Uint8Array([0x00, 0x68, 0x65, 0x6C, 0x6C, 0x6F, 0x00])
    const needle   = new Uint8Array([0x68, 0x65, 0x6C, 0x6C, 0x6F])
    expect(searchHexBytes(haystack, needle)).toEqual([1])
  })
})

describe('formatSize', () => {
  it('should return "0 B" for 0 bytes', () => {
    expect(formatSize(0)).toBe('0 B')
  })

  it('should return "1 B" for 1 byte', () => {
    expect(formatSize(1)).toBe('1 B')
  })

  it('should return "1.0 KB" for 1024 bytes', () => {
    expect(formatSize(1024)).toBe('1.0 KB')
  })

  it('should return "10.0 MB" for 10 * 1024 * 1024 bytes', () => {
    expect(formatSize(10 * 1024 * 1024)).toBe('10.0 MB')
  })
})
