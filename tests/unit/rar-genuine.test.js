/**
 * Archives produced by RARLAB's own packer.
 *
 * Everything else about RAR here is checked against hand-built fixtures that
 * 7-Zip certifies as well-formed. That is a real gate, but it has a stated
 * limit which was written into rar.js's header comment: *no archive written by
 * a real packer had ever been read*. 7-Zip proving a fixture is acceptable is
 * not the same as a genuine packer having produced it — our fixtures only
 * contain the constructs we thought to emit.
 *
 * That limit is now gone. The fixtures below were written by RARLAB's
 * `Rar.exe` (7.13 for RAR5, 6.24 for RAR4, which is the last generation that
 * still creates the older format), from the official winrar distribution.
 * They are committed as base64 because they are small and because the packer
 * is not present on a normal machine — a test that always skips proves
 * nothing.
 *
 * Each archive holds the same three files, one of them with a non-ASCII name
 * and one inside a subdirectory, so entry-name handling is exercised against a
 * real packer's encoding rather than against our own.
 *
 * The compressed pair matters as much as the stored pair. RAR's compression is
 * proprietary and stays refused; what these prove is that a real compressed
 * archive still *lists* correctly and refuses *by name* at extraction, rather
 * than failing to parse or, far worse, returning packed bytes as content.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { parseRar, extractRarEntry } from '../../src/main/rar.js'

/** @type {Record<string, string>} */
const FIXTURES = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures-rar-genuine.json', import.meta.url)), 'utf-8'))

/** @param {string} name @returns {Buffer} */
const bytes = (name) => Buffer.from(FIXTURES[name], 'base64')

/** What the packer was given, byte for byte. */
const CONTENTS = {
  'note.txt': Buffer.from('genuine packer fixture\n', 'utf-8'),
  'sub/inner.txt': Buffer.from('nested\n', 'utf-8'),
  '測試.txt': Buffer.from('unicode\n', 'utf-8'),
}

/** @param {ReturnType<typeof parseRar>} parsed @returns {string[]} */
const names = (parsed) => parsed.entries.map((e) => e.path).sort()

describe('archives written by RARLAB Rar.exe', () => {
  it('has the fixtures at all, so a broken loader cannot pass this vacuously', () => {
    for (const k of ['fx5store', 'fx5comp', 'fx4store', 'fx4comp']) {
      expect(bytes(k).length, k).toBeGreaterThan(100)
    }
    // The signatures the two generations actually carry.
    expect(bytes('fx5store').subarray(0, 8))
      .toEqual(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]))
    expect(bytes('fx4store').subarray(0, 7))
      .toEqual(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))
  })

  for (const [label, key] of [['RAR5', 'fx5store'], ['RAR4', 'fx4store']]) {
    describe(`${label}, stored`, () => {
      it('lists every entry the packer put in, including the non-ASCII name', () => {
        const parsed = parseRar(bytes(key))
        const listed = names(parsed)
        for (const want of Object.keys(CONTENTS)) {
          expect(listed, `${label} is missing ${want}`).toContain(want)
        }
      })

      it('extracts each one byte for byte', () => {
        // Against what went into the packer, not against anything this
        // codebase produced.
        const raw = bytes(key)
        const parsed = parseRar(raw)
        for (const [name, expected] of Object.entries(CONTENTS)) {
          const got = extractRarEntry(raw, parsed, name)
          expect(Buffer.compare(got, expected), `${label} ${name} differs`).toBe(0)
        }
      })
    })
  }

  describe('the refusals, against archives the real packer produced', () => {
    // Hand-built fixtures can only prove a refusal fires on what we thought to
    // construct. These are the awkward cases as RARLAB's packer actually emits
    // them, which is the only way to know the refusal triggers on the real
    // shape rather than on our approximation of it.
    it('verifies a BLAKE2sp record the packer itself wrote (-htb)', () => {
      const raw = bytes('g_blake')
      const parsed = parseRar(raw)
      const got = extractRarEntry(raw, parsed, 'note.txt')
      expect(Buffer.compare(got, CONTENTS['note.txt'])).toBe(0)
    })

    it('refuses per-file encryption by name (-p)', () => {
      expect(() => parseRar(bytes('g_enc'))).toThrow(/加密/)
    })

    it('refuses an encrypted header by name (-hp)', () => {
      // The whole block table is ciphertext here, so this must be recognised
      // rather than parsed as garbage — the failure mode is a confident list
      // of nonsense entry names.
      expect(() => parseRar(bytes('g_hdrenc'))).toThrow(/標頭|加密/)
    })

    it('refuses a solid block by name (-s)', () => {
      // A solid entry cannot be decoded without the entries before it.
      // Returning its bytes alone would be a wrong answer, not a partial one.
      expect(() => parseRar(bytes('g_solid'))).toThrow(/solid/i)
    })

    it('names what it refused rather than failing generically', () => {
      for (const [key, pattern] of [
        ['g_enc', /note\.txt/],
        ['g_solid', /note\.txt/],
      ]) {
        let message = ''
        try { parseRar(bytes(key)) } catch (err) { message = String(err.message) }
        expect(message, key).toMatch(pattern)
      }
    })
  })

  for (const [label, key] of [['RAR5', 'fx5comp'], ['RAR4', 'fx4comp']]) {
    describe(`${label}, compressed`, () => {
      it('still lists the contents rather than failing to parse', () => {
        // Refusing at the listing stage would render an empty folder, which
        // reads as "this archive has nothing in it".
        const listed = names(parseRar(bytes(key)))
        for (const want of Object.keys(CONTENTS)) {
          expect(listed, `${label} is missing ${want}`).toContain(want)
        }
      })

      it('refuses a compressed entry by name instead of returning packed bytes', () => {
        const raw = bytes(key)
        const parsed = parseRar(raw)
        // The packer stores anything it cannot shrink, so some entries in a
        // "compressed" archive are genuinely stored and must still come out.
        let refusals = 0
        let extracted = 0
        for (const [name, expected] of Object.entries(CONTENTS)) {
          try {
            const got = extractRarEntry(raw, parsed, name)
            expect(Buffer.compare(got, expected), `${label} ${name} differs`).toBe(0)
            extracted++
          } catch (err) {
            expect(String(err.message)).toMatch(/壓縮方法|method/)
            refusals++
          }
        }
        // Whatever the split, nothing may come back as wrong bytes.
        expect(refusals + extracted).toBe(Object.keys(CONTENTS).length)
      })
    })
  }
})
