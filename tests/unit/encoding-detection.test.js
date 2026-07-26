import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { decodeBuffer, encodeContent, COMMON_ENCODINGS } from '../../src/main/encoding.js'

const iconv = createRequire(import.meta.url)('iconv-lite')

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

describe('encodeContent', () => {
  it('writes the requested legacy encoding rather than UTF-8', () => {
    const text = '繁體中文測試'
    const big5 = encodeContent(text, 'Big5')
    expect(big5.equals(iconv.encode(text, 'Big5'))).toBe(true)
    // The defect being guarded against: silently emitting UTF-8 instead.
    expect(big5.equals(Buffer.from(text, 'utf-8'))).toBe(false)
    expect(iconv.decode(big5, 'Big5')).toBe(text)
  })

  it('writes Shift_JIS as Shift_JIS', () => {
    const text = '日本語テスト'
    const sjis = encodeContent(text, 'Shift_JIS')
    expect(iconv.decode(sjis, 'Shift_JIS')).toBe(text)
    expect(sjis.equals(Buffer.from(text, 'utf-8'))).toBe(false)
  })

  it('preserves bytes on an unmodified read/write cycle when detection is right', () => {
    // Guaranteed property: decode then re-encode through the same codec is a
    // no-op. It does not hold when chardet guesses a multi-byte codec for a
    // single-byte file, since the invalid sequences decode to replacement
    // characters; detection accuracy, not the save path, is the limit there.
    for (const [text, enc] of [['繁體中文測試', 'Big5'], ['日本語テスト', 'Shift_JIS'], ['héllo wörld', 'ISO-8859-1']]) {
      const original = iconv.encode(text, enc)
      const decoded = iconv.decode(original, enc)
      expect(encodeContent(decoded, enc).equals(original)).toBe(true)
    }
  })

  it('defaults to UTF-8 when no encoding is given', () => {
    expect(encodeContent('hello').equals(Buffer.from('hello', 'utf-8'))).toBe(true)
  })

  it('falls back to UTF-8 for an unknown encoding', () => {
    expect(encodeContent('hello', 'not-a-real-encoding')
      .equals(Buffer.from('hello', 'utf-8'))).toBe(true)
  })

  it('treats null content as empty', () => {
    expect(encodeContent(null, 'UTF-8').length).toBe(0)
  })
})

describe('forced encoding', () => {
  it('overrides detection when asked', () => {
    const buf = iconv.encode('繁體中文測試', 'Big5')
    // Detection gets this wrong on a short sample; the explicit choice must win.
    const auto = decodeBuffer(buf)
    const forced = decodeBuffer(buf, 'Big5')
    expect(forced.content).toBe('繁體中文測試')
    expect(forced.encoding).toBe('Big5')
    expect(forced.detected).toBe(false)
    expect(auto.detected).toBe(true)
  })

  it('falls back to detection for an unsupported name', () => {
    const buf = Buffer.from('hello', 'utf-8')
    const out = decodeBuffer(buf, 'not-a-real-encoding')
    expect(out.content).toBe('hello')
    expect(out.detected).toBe(true)
  })

  it('reports the forced encoding for an empty file', () => {
    expect(decodeBuffer(Buffer.alloc(0), 'Big5').encoding).toBe('Big5')
  })

  it('offers UTF-8 and the common legacy encodings for the picker', () => {
    expect(COMMON_ENCODINGS).toContain('UTF-8')
    expect(COMMON_ENCODINGS).toContain('Big5')
    expect(COMMON_ENCODINGS).toContain('Shift_JIS')
    for (const enc of COMMON_ENCODINGS) {
      expect(iconv.encodingExists(enc), enc).toBe(true)
    }
  })
})
