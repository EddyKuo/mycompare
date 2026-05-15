import { describe, it, expect } from 'vitest'
import { detectEol } from '../../src/renderer/src/core/eol-detect.js'

describe('detectEol', () => {
  it('should return LF for empty string', () => {
    expect(detectEol('')).toBe('LF')
  })

  it('should return LF for null/undefined (falsy)', () => {
    expect(detectEol(null)).toBe('LF')
    expect(detectEol(undefined)).toBe('LF')
  })

  it('should return LF for Unix line endings', () => {
    expect(detectEol('line1\nline2\nline3\n')).toBe('LF')
  })

  it('should return CRLF for Windows line endings', () => {
    expect(detectEol('line1\r\nline2\r\nline3\r\n')).toBe('CRLF')
  })

  it('should return CR for old Mac line endings', () => {
    expect(detectEol('line1\rline2\rline3\r')).toBe('CR')
  })

  it('should detect dominant CRLF in mixed content', () => {
    expect(detectEol('a\r\nb\r\nc\r\nd\n')).toBe('CRLF')
  })

  it('should detect dominant LF in mixed content', () => {
    expect(detectEol('a\nb\nc\nd\r\n')).toBe('LF')
  })

  it('should return LF for a single line with no line ending', () => {
    expect(detectEol('hello world')).toBe('LF')
  })

  it('should return CRLF when CRLF count equals LF count and both > 0', () => {
    // 1 CRLF + 1 bare LF → CRLF wins by >= condition
    expect(detectEol('a\r\nb\n')).toBe('CRLF')
  })
})
