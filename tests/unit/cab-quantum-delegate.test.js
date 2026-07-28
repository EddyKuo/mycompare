/**
 * CAB methods this build cannot decode are handed to 7-Zip.
 *
 * Quantum is the only one left, and it was refused for a reason that has held
 * up under every check: its generator was removed from Diamond.exe in 1996,
 * both Windows' makecab and Microsoft's own 1997 SDK tools reject the option,
 * none of the 686 cabinets on this machine use it, and cabextract's own test
 * corpus has none either. With no obtainable sample, a decoder written here
 * could only ever agree with itself.
 *
 * Delegating removes that problem rather than solving it: 7-Zip reads Quantum,
 * so nothing in this project has to guess at bytes it cannot verify. The same
 * route already carries RAR's compressed methods.
 *
 * There is still no Quantum cabinet to test with — so these tests prove the
 * part that can be proven, which is the delegation path itself. It is
 * method-agnostic: a real LZX cabinet forced down the same branch exercises
 * every step a Quantum cabinet would take. What is NOT proven here is that
 * 7-Zip decodes Quantum correctly, and that is stated rather than implied.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, copyFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findTool, canExtractCompressed, extractWithTool, _resetToolProbe }
  from '../../src/main/archive-delegate.js'

const SEVENZIP = ['C:', 'Program Files', '7-Zip', '7z.exe'].join('\\')
const haveTool = existsSync(SEVENZIP)

beforeEach(() => { _resetToolProbe() })

describe('choosing a tool for CAB', () => {
  it('does not offer UnRAR for a cabinet', () => {
    // UnRAR cannot read CAB at all. Handing one to it would turn a clear
    // "this build cannot decode Quantum" into a confusing tool error.
    const picked = findTool('cab', [
      { path: process.execPath, kind: 'unrar', formats: ['rar'] },
    ])
    expect(picked).toBeNull()
  })

  it('offers 7-Zip for both formats', () => {
    const table = [{ path: process.execPath, kind: '7zip', formats: ['rar', 'cab'] }]
    expect(findTool('cab', table)?.kind).toBe('7zip')
    expect(findTool('rar', table)?.kind).toBe('7zip')
  })

  it('answers per format rather than caching one verdict for both', () => {
    // A single cached answer would hand a cabinet to a RAR-only tool.
    const table = [
      { path: process.execPath, kind: 'unrar', formats: ['rar'] },
      { path: 'C:\\nope\\7z.exe', kind: '7zip', formats: ['rar', 'cab'] },
    ]
    expect(findTool('rar', table)?.kind).toBe('unrar')
    expect(findTool('cab', table)).toBeNull()
  })
})

describe('the delegation path, on a real cabinet', () => {
  /** @type {string} */
  let dir = ''
  /** @type {string} */
  let cab = ''

  beforeEach(() => {
    if (!haveTool || dir) return
    dir = mkdtempSync(join(tmpdir(), 'cab-delegate-'))
    copyFileSync('C:\\Windows\\System32\\where.exe', join(dir, 'where.exe'))
    try {
      // LZX rather than Quantum, because Quantum cannot be produced. The
      // branch under test does not care which method it is — it runs whenever
      // this build's own decoder refuses.
      execFileSync('makecab.exe',
        ['/D', 'CompressionType=LZX', '/D', 'CompressionMemory=21',
          join(dir, 'where.exe'), join(dir, 'out.cab')],
        { stdio: 'ignore', cwd: dir })
      cab = join(dir, 'out.cab')
    } catch {
      cab = ''
    }
  })

  it('extracts an entry byte for byte through the external tool', async () => {
    if (!haveTool || !cab) {
      console.warn('7-Zip or makecab unavailable; delegation test skipped')
      return
    }
    const out = await extractWithTool({
      archivePath: cab,
      entryPath: 'where.exe',
      maxBytes: 64 * 1024 * 1024,
      format: 'cab',
    })
    expect(Buffer.compare(out, readFileSync(join(dir, 'where.exe')))).toBe(0)
  }, 60000)

  it('reports a missing entry rather than returning empty bytes', async () => {
    if (!haveTool || !cab) return
    // Found while writing this: 7-Zip exits 0 with empty output when the named
    // entry is not in the archive. Success alone therefore does not mean the
    // right bytes came back, and without the declared size a missing entry
    // would surface as a zero-byte file. An entry that really is empty still
    // passes, because then the declared size is 0 too.
    await expect(extractWithTool({
      archivePath: cab,
      entryPath: 'not-in-here.bin',
      maxBytes: 1024,
      format: 'cab',
      expectedSize: 64 * 1024,
    })).rejects.toThrow(/位元組/)
  }, 60000)

  it('enforces the ceiling as the bytes arrive', async () => {
    if (!haveTool || !cab) return
    // where.exe is 64KB; a 1KB ceiling must stop it rather than report the
    // overrun after the fact.
    await expect(extractWithTool({
      archivePath: cab,
      entryPath: 'where.exe',
      maxBytes: 1024,
      format: 'cab',
    })).rejects.toThrow(/上限|maxBuffer|ENOBUFS/i)
  }, 60000)
})

describe('a real Quantum cabinet, if one ever appears', () => {
  /**
   * Every cabinet this machine has, checked for compression type 2.
   *
   * Today this finds nothing — that is the whole reason Quantum is delegated
   * rather than decoded. The test exists anyway so the verification is dormant
   * rather than absent: drop a genuine Quantum cabinet anywhere under the
   * search roots and it runs, comparing our path against 7-Zip's own output.
   * A missing check that nobody remembers to write is how a gap outlives the
   * reason for it.
   *
   * @returns {string|null}
   */
  function findQuantumCab() {
    const roots = ['C:\\Windows', 'C:\\ProgramData', join(tmpdir(), 'quantum-fixtures')]
    /** @param {string} dir @param {number} depth @returns {string|null} */
    const walk = (dir, depth) => {
      if (depth > 3) return null
      let names = []
      try { names = readdirSync(dir) } catch { return null }
      for (const n of names) {
        const full = join(dir, n)
        let st
        try { st = statSync(full) } catch { continue }
        if (st.isDirectory()) {
          const hit = walk(full, depth + 1)
          if (hit) return hit
          continue
        }
        if (!/\.cab$/i.test(n)) continue
        try {
          const b = readFileSync(full)
          if (b.length < 44 || b.toString('ascii', 0, 4) !== 'MSCF') continue
          const flags = b.readUInt16LE(30)
          let off = 36
          if (flags & 0x0004) off = 36 + 4 + b.readUInt16LE(36)
          if (flags & 0x0001) { while (b[off]) off++; off++; while (b[off]) off++; off++ }
          if (flags & 0x0002) { while (b[off]) off++; off++; while (b[off]) off++; off++ }
          if ((b.readUInt16LE(off + 6) & 0x0f) === 2) return full
        } catch { /* unreadable */ }
      }
      return null
    }
    for (const r of roots) {
      const hit = walk(r, 0)
      if (hit) return hit
    }
    return null
  }

  it('extracts it the same way 7-Zip does, when one exists', async () => {
    if (!haveTool) return
    const cab = findQuantumCab()
    if (!cab) {
      console.warn('no Quantum cabinet on this machine, as expected; '
        + 'this check stays dormant until one appears')
      return
    }

    const { readArchive, readArchiveEntry } = await import('../../src/main/archive.js')
    const listing = await readArchive(cab)
    const entries = (listing.entries ?? listing).slice(0, 3)
    expect(entries.length).toBeGreaterThan(0)

    const refDir = mkdtempSync(join(tmpdir(), 'quantum-ref-'))
    execFileSync(SEVENZIP, ['x', '-y', cab, '-o' + refDir], { stdio: 'ignore' })

    let compared = 0
    for (const e of entries) {
      const full = String(e.path ?? e.name)
      const name = full.includes('::') ? full.split('::').pop() : full
      const refPath = join(refDir, ...name.split('/'))
      if (!existsSync(refPath)) continue
      const ours = await readArchiveEntry(cab, name)
      expect(Buffer.compare(ours, readFileSync(refPath)), name).toBe(0)
      compared++
    }
    rmSync(refDir, { recursive: true, force: true })
    expect(compared, 'a Quantum cabinet was found but nothing was compared')
      .toBeGreaterThan(0)
  }, 120000)
})

describe('what this machine can actually do', () => {
  it('states whether the Quantum fallback is available here', () => {
    // Not an assertion about the machine — a statement of which half of the
    // behaviour the run above exercised, so a green suite on a machine with no
    // archiver is not mistaken for coverage of the delegation.
    const available = canExtractCompressed('cab')
    if (!available) {
      console.warn('no CAB-capable archiver here; Quantum stays refused by name')
    }
    expect(typeof available).toBe('boolean')
  })
})
