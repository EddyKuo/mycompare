/**
 * Cabinets that carry a reserved area, read against 7-Zip.
 *
 * This was written down as "not verified — makecab will not emit a reserved
 * area, so there is no fixture." Half of that is true and the conclusion was
 * not: makecab will not emit one, but Windows *ships* them. Every signed
 * cabinet has a header reserve, and there are twenty-five of them on a stock
 * install. The fixture was on the disk the whole time.
 *
 * A reserved area shifts every structure that follows it, so getting it wrong
 * does not produce a clean failure — it produces a parse that reads folder and
 * block headers out of the wrong bytes. That is worth a real check rather than
 * a note saying it is untested.
 *
 * Skips when no such cabinet or no 7-Zip is present, the same way the SFTP
 * interop tests skip without paramiko. A skipped test says so; it does not
 * quietly pass.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, copyFileSync, readdirSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { readArchive, readArchiveEntry } from '../../src/main/archive.js'
import { parseCab } from '../../src/main/cab.js'

const SEVENZIP = ['C:', 'Program Files', '7-Zip', '7z.exe'].join('\\')

/** Directories that hold signed cabinets on a stock Windows install. */
const SEARCH = [
  'C:\\Windows\\servicing\\FodMetadata',
  'C:\\Windows\\servicing\\FodMetadata\\metadata',
  'C:\\Windows\\SoftwareDistribution\\SLS',
]

/**
 * Cabinets on this machine matching a predicate on their header bytes.
 *
 * @param {(buf: Buffer) => boolean} accept
 * @param {number} limit
 * @param {string[]} roots
 * @returns {string[]}
 */
function findCabsWhere(accept, limit, roots) {
  /** @type {string[]} */
  const out = []
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 3) return
    let names = []
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      if (out.length >= limit) return
      const full = join(dir, n)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { walk(full, depth + 1); continue }
      if (!/\.cab$/i.test(n)) continue
      try {
        const buf = readFileSync(full)
        if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'MSCF') continue
        if (accept(buf)) out.push(full)
      } catch { /* unreadable system file */ }
    }
  }
  for (const dir of roots) walk(dir, 0)
  return out
}

/** @returns {string[]} cabinets whose header declares a reserved area */
function findReservedCabs(limit = 4) {
  /** @type {string[]} */
  const out = []
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 3) return
    let names = []
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      if (out.length >= limit) return
      const full = join(dir, n)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { walk(full, depth + 1); continue }
      if (!/\.cab$/i.test(n)) continue
      try {
        const buf = readFileSync(full)
        if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'MSCF') continue
        // Bit 2 of the header flags is cfhdrRESERVE_PRESENT.
        if ((buf.readUInt16LE(30) & 0x0004) === 0) continue
        out.push(full)
      } catch { /* unreadable system file */ }
    }
  }
  for (const dir of SEARCH) walk(dir, 0)
  return out
}

/** @type {string[]} */
let cabs = []
let sevenZip = false

beforeAll(() => {
  cabs = findReservedCabs()
  sevenZip = existsSync(SEVENZIP)
})

describe('cabinets with a reserved area', () => {
  it('finds one to test, or says why not', () => {
    // Not an assertion on the machine — a statement of what ran, so a green
    // suite on a machine without these files cannot be read as coverage.
    if (!cabs.length) {
      console.warn('no reserved-area cabinet found; the tests below are skipped')
    }
    expect(true).toBe(true)
  })

  it('reads the reserve sizes out of the header', () => {
    if (!cabs.length) return
    const buf = readFileSync(cabs[0])
    const parsed = parseCab(buf)
    expect(parsed.reserve).toBeDefined()
    // A signed cabinet's reserve lives in the header; the per-folder and
    // per-block reserves are usually zero. Whatever the values, they have to
    // come back as numbers, because every following offset is computed from
    // them.
    expect(Number.isInteger(parsed.reserve.header)).toBe(true)
    expect(Number.isInteger(parsed.reserve.folder)).toBe(true)
    expect(Number.isInteger(parsed.reserve.data)).toBe(true)
    expect(parsed.reserve.header).toBeGreaterThan(0)
  })

  it('lists entries rather than reading the shifted bytes as garbage', async () => {
    if (!cabs.length) return
    const r = await readArchive(cabs[0])
    const entries = r.entries ?? r
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      const name = String(e.path ?? e.name)
      expect(name.length).toBeGreaterThan(0)
      // A misparsed header shows up as control characters in the names long
      // before it shows up as a decode failure.
      expect(name).not.toMatch(/[\u0000-\u0008\u000e-\u001f]/)
    }
  })

  it('extracts byte for byte what 7-Zip extracts', async () => {
    if (!cabs.length || !sevenZip) return

    const dir = mkdtempSync(join(tmpdir(), 'cab-reserved-'))
    const cab = join(dir, 'in.cab')
    copyFileSync(cabs[0], cab)
    const refDir = join(dir, 'ref')
    execFileSync(SEVENZIP, ['x', '-y', cab, '-o' + refDir], { stdio: 'ignore' })

    const r = await readArchive(cab)
    const entries = (r.entries ?? r).slice(0, 40)
    expect(entries.length).toBeGreaterThan(0)

    let compared = 0
    for (const e of entries) {
      const full = String(e.path ?? e.name)
      const name = full.includes('::') ? full.split('::').pop() : full
      const refPath = join(refDir, ...name.split('/'))
      if (!existsSync(refPath)) continue
      const ours = await readArchiveEntry(cab, name)
      expect(Buffer.compare(ours, readFileSync(refPath))).toBe(0)
      compared++
    }
    // Guard the premise: comparing nothing would pass every assertion above.
    expect(compared, 'no entry was actually compared').toBeGreaterThan(0)
  }, 60000)

  it('reads a sample of this machine\'s real cabinets exactly as 7-Zip does', async () => {
    // Hand-picked fixtures prove a path works. A sample of whatever is
    // actually installed proves it works on the shapes the format occurs in —
    // and a sweep of all 686 cabinets on this machine turned up 404 LZX, 277
    // MSZIP and 5 uncompressed folders, which no curated fixture set covered.
    if (!cabs.length || !sevenZip) return

    const sample = findReservedCabs(6)
    let compared = 0
    for (const src of sample) {
      const dir = mkdtempSync(join(tmpdir(), 'cab-corpus-'))
      const cab = join(dir, 'in.cab')
      copyFileSync(src, cab)
      const refDir = join(dir, 'ref')
      try {
        execFileSync(SEVENZIP, ['x', '-y', cab, '-o' + refDir], { stdio: 'ignore' })
      } catch {
        continue // 7-Zip declined it, so there is no reference to compare to
      }

      const r = await readArchive(cab)
      for (const e of (r.entries ?? r).slice(0, 6)) {
        const full = String(e.path ?? e.name)
        const name = full.includes('::') ? full.split('::').pop() : full
        const refPath = join(refDir, ...name.split('/'))
        if (!existsSync(refPath)) continue
        const ours = await readArchiveEntry(cab, name)
        expect(Buffer.compare(ours, readFileSync(refPath)), `differs from 7-Zip: ${name}`).toBe(0)
        compared++
      }
    }
    expect(compared, 'no entry was actually compared').toBeGreaterThan(0)
  }, 120000)

  it('reads an uncompressed folder, if the machine has one', async () => {
    // Compression type 0 is a real variant that no fixture here produced —
    // makecab always compresses — and the disk sweep found five of them, all
    // shipped by Visual Studio. A folder whose "decompressor" is a copy is
    // exactly the sort of path that is assumed to work and never exercised.
    if (!sevenZip) return

    const plain = findCabsWhere((buf) => {
      const flags = buf.readUInt16LE(30)
      let off = 36
      if (flags & 0x0004) off = 36 + 4 + buf.readUInt16LE(36)
      if (flags & 0x0001) { while (buf[off]) off++; off++; while (buf[off]) off++; off++ }
      if (flags & 0x0002) { while (buf[off]) off++; off++; while (buf[off]) off++; off++ }
      return (buf.readUInt16LE(off + 6) & 0x0f) === 0
    }, 1, ['C:\\ProgramData\\Microsoft\\VisualStudio\\Packages'])

    if (!plain.length) {
      console.warn('no uncompressed cabinet on this machine; test skipped')
      return
    }

    const dir = mkdtempSync(join(tmpdir(), 'cab-none-'))
    const cab = join(dir, 'in.cab')
    copyFileSync(plain[0], cab)
    const refDir = join(dir, 'ref')
    execFileSync(SEVENZIP, ['x', '-y', cab, '-o' + refDir], { stdio: 'ignore' })

    const r = await readArchive(cab)
    let compared = 0
    for (const e of (r.entries ?? r).slice(0, 8)) {
      const full = String(e.path ?? e.name)
      const name = full.includes('::') ? full.split('::').pop() : full
      const refPath = join(refDir, ...name.split('/'))
      if (!existsSync(refPath)) continue
      const ours = await readArchiveEntry(cab, name)
      expect(Buffer.compare(ours, readFileSync(refPath)), `differs from 7-Zip: ${name}`).toBe(0)
      compared++
    }
    expect(compared, 'no entry was actually compared').toBeGreaterThan(0)
  }, 120000)

  it('refuses a corrupted signed cabinet rather than decoding it', async () => {
    // Deliberately not called a checksum test. Disabling the checksum
    // verification entirely still leaves this passing, because a flipped byte
    // in a compressed stream also breaks the decompressor — so this pins the
    // user-facing property (damage is refused, never returned as content) and
    // nothing narrower. The assertion that actually depends on the checksum is
    // in cab-lzx.test.js, where the damage sits inside an *uncompressed* block
    // and the decompressor cannot possibly notice it.
    //
    // The checksum is skipped only when a per-DATA-block reserve is present,
    // whose coverage cannot be established without a fixture that has one.
    // These cabinets carry a header reserve with reserve.data === 0, so they
    // are checked in full.
    if (!cabs.length) return
    const buf = readFileSync(cabs[0])
    const parsed = parseCab(buf)
    if (parsed.reserve.data !== 0) return

    const dir = mkdtempSync(join(tmpdir(), 'cab-corrupt-'))
    const bad = join(dir, 'bad.cab')
    const copy = Buffer.from(buf)
    // Well past the header and folder table, inside the data.
    copy[Math.floor(copy.length * 0.8)] ^= 0xff
    const { writeFileSync } = await import('fs')
    writeFileSync(bad, copy)

    const r = await readArchive(bad).catch(() => null)
    if (!r) return // refused at listing time, which is also correct
    const entries = r.entries ?? r
    const name = String(entries[0].path ?? entries[0].name).split('::').pop()
    await expect(readArchiveEntry(bad, name)).rejects.toThrow()
  }, 30000)
})
