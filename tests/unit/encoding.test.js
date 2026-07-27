/**
 * Encoding detection and write-back.
 *
 * The validator is checked against Node's own `TextDecoder` in fatal mode
 * rather than against a list of cases someone thought of: a hand-written UTF-8
 * validator that only agrees with its author is exactly the kind of code that
 * accepts an overlong sequence for years.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import {
  decodeBuffer,
  encodeContent,
  detectBom,
  isValidUtf8,
  splitBomName,
  COMMON_ENCODINGS,
} from '../../src/main/encoding.js'

const require = createRequire(import.meta.url)
const iconv = require('iconv-lite')

describe('isValidUtf8', () => {
  const cases = [
    ['ascii', Buffer.from('hello world')],
    ['multi-byte', Buffer.from('中文字 héllo 🎉')],
    ['empty', Buffer.alloc(0)],
    ['overlong NUL', Buffer.from([0xc0, 0x80])],
    ['overlong 3-byte', Buffer.from([0xe0, 0x80, 0x80])],
    ['lone surrogate', Buffer.from([0xed, 0xa0, 0x80])],
    ['above U+10FFFF', Buffer.from([0xf5, 0x80, 0x80, 0x80])],
    ['truncated sequence', Buffer.from([0xe4, 0xb8])],
    ['stray continuation', Buffer.from([0x80])],
    ['max code point', Buffer.from([0xf4, 0x8f, 0xbf, 0xbf])],
    ['big5 text', iconv.encode('中文字測試', 'Big5')],
    ['shift-jis text', iconv.encode('日本語テキスト', 'Shift_JIS')],
  ]

  it.each(cases)('agrees with TextDecoder on %s', (_name, buf) => {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let reference = true
    try { decoder.decode(buf) } catch { reference = false }
    expect(isValidUtf8(buf)).toBe(reference)
  })
})

describe('detectBom', () => {
  it('finds each mark, longest first', () => {
    // UTF-32LE starts with the UTF-16LE mark, so a shorter-first scan
    // misreports every UTF-32LE file as UTF-16LE.
    expect(detectBom(Buffer.from([0xff, 0xfe, 0x00, 0x00])))
      .toEqual({ encoding: 'UTF-32LE', length: 4 })
    expect(detectBom(Buffer.from([0xff, 0xfe, 0x41, 0x00])))
      .toEqual({ encoding: 'UTF-16LE', length: 2 })
    expect(detectBom(Buffer.from([0xef, 0xbb, 0xbf])))
      .toEqual({ encoding: 'UTF-8', length: 3 })
  })

  it('reports nothing for a file without one', () => {
    expect(detectBom(Buffer.from('plain text'))).toBeNull()
    expect(detectBom(Buffer.from([0xef]))).toBeNull()
    expect(detectBom(null)).toBeNull()
  })
})

describe('decodeBuffer', () => {
  it('never calls invalid UTF-8 "UTF-8"', () => {
    // This is the bug that matters: decoding Big5 as UTF-8 does not fail, it
    // substitutes U+FFFD. The file opens as a page of question marks and
    // nothing reports a problem.
    const big5 = iconv.encode('中文字測試內容'.repeat(3), 'Big5')
    const r = decodeBuffer(big5)
    expect(r.encoding).not.toMatch(/^utf-?8$/i)
    expect(r.content).not.toContain('�')
    expect(r.content).toBe('中文字測試內容'.repeat(3))
  })

  it('keeps UTF-8 when the bytes really are UTF-8', () => {
    const r = decodeBuffer(Buffer.from('中文字 héllo'))
    expect(r.encoding).toBe('UTF-8')
    expect(r.content).toBe('中文字 héllo')
    expect(r.hasBom).toBe(false)
  })

  it('admits that pure ASCII carries no evidence', () => {
    // Every candidate encoding decodes ASCII identically, so a high confidence
    // here would be an invention.
    const r = decodeBuffer(Buffer.from('plain ascii only'))
    expect(r.encoding).toBe('UTF-8')
    expect(r.confidence).toBe(0)
  })

  it('takes a byte-order mark as fact', () => {
    for (const enc of ['UTF-8', 'UTF-16LE', 'UTF-16BE']) {
      const r = decodeBuffer(iconv.encode('héllo', enc, { addBOM: true }))
      expect(r).toMatchObject({ encoding: `${enc}-BOM`, hasBom: true, content: 'héllo' })
    }
  })

  it('lets an explicit choice override detection', () => {
    const big5 = iconv.encode('中文字測試內容'.repeat(3), 'Big5')
    const r = decodeBuffer(big5, 'ISO-8859-1')
    expect(r.encoding).toBe('ISO-8859-1')
    expect(r.detected).toBe(false)
  })

  it('handles an empty file', () => {
    expect(decodeBuffer(Buffer.alloc(0))).toMatchObject({ content: '', encoding: 'UTF-8' })
  })

  it('cannot identify a very short non-UTF-8 sample, and does not pretend to', () => {
    // Six bytes of Big5 are six valid Latin-1 bytes; no detector can tell them
    // apart without more text. What matters is that the answer is a
    // byte-preserving single-byte encoding rather than UTF-8, so nothing is
    // destroyed and the manual override can fix the label.
    const short = iconv.encode('中文字', 'Big5')
    const r = decodeBuffer(short)
    expect(r.encoding).not.toMatch(/^utf-?8$/i)
    expect(encodeContent(r.content, r.encoding).equals(short)).toBe(true)
  })
})

describe('encodeContent', () => {
  it('writes back in the encoding the file arrived in', () => {
    for (const enc of ['Big5', 'Shift_JIS', 'GBK', 'windows-1252']) {
      const text = enc === 'windows-1252' ? 'héllo' : '中文'
      const original = iconv.encode(text, enc)
      const r = decodeBuffer(original, enc)
      expect(encodeContent(r.content, r.encoding).equals(original)).toBe(true)
    }
  })

  it('preserves a byte-order mark across a read and a write', () => {
    for (const enc of ['UTF-8', 'UTF-16LE', 'UTF-16BE']) {
      const original = iconv.encode('héllo\nworld', enc, { addBOM: true })
      const r = decodeBuffer(original)
      expect(encodeContent(r.content, r.encoding).equals(original)).toBe(true)
    }
  })

  it('does not invent a mark for a file that had none', () => {
    // A BOM added to a shell script breaks its shebang. The user did not ask
    // for one, so it must not appear.
    const original = Buffer.from('#!/bin/sh\necho hi\n')
    const r = decodeBuffer(original)
    expect(encodeContent(r.content, r.encoding).equals(original)).toBe(true)
  })

  it('falls back to UTF-8 for an encoding it does not know', () => {
    expect(encodeContent('hi', 'not-a-real-encoding').toString()).toBe('hi')
    expect(encodeContent('hi', undefined).toString()).toBe('hi')
  })
})

describe('splitBomName', () => {
  it('separates the mark from the encoding', () => {
    expect(splitBomName('UTF-8-BOM')).toEqual({ base: 'UTF-8', bom: true })
    expect(splitBomName('UTF-8')).toEqual({ base: 'UTF-8', bom: false })
    expect(splitBomName('')).toEqual({ base: '', bom: false })
  })
})

describe('COMMON_ENCODINGS', () => {
  it('lists only names iconv can actually use', () => {
    for (const name of COMMON_ENCODINGS) {
      expect(iconv.encodingExists(splitBomName(name).base)).toBe(true)
    }
  })
})
