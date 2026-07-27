/**
 * LZX decompression for Microsoft cabinets.
 *
 * Every fixture in this file is produced by Windows' own `makecab.exe` at test
 * time, and every expectation is "the decoded bytes equal the file that was
 * fed to makecab". Nothing here is produced by an encoder written in this
 * repository, on purpose: a hand-written decoder checked against a
 * hand-written encoder only proves the two share one reading of the spec, and
 * LZX has at least four places where Microsoft's own document and Microsoft's
 * own implementation disagree. One test additionally cross-checks against
 * `expand.exe`, so the claim does not rest solely on "makecab round-trips".
 *
 * LZX was previously refused by name here, on the stated grounds that nothing
 * on this machine could produce a cabinet to verify against. That was simply
 * untrue — `makecab /D CompressionType=LZX` has always worked. Quantum's
 * refusal stands because `makecab` really does reject
 * `CompressionType=QUANTUM`, so a Quantum decoder could only agree with
 * itself.
 *
 * Generation happens at test time rather than being committed as base64
 * because the interesting fixtures are large (a 230 KB text file and a real
 * .exe), and because the window size — which changes the position-slot table
 * and so is the classic source of LZX bugs — has seven legal values that all
 * want covering. On a machine without `makecab.exe` the whole suite skips.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, readdirSync, statSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseCab, extractCabEntry, decodeFolder, CabError } from '../../src/main/cab.js'

/** Where the generated cabinets live for this run. */
let dir = ''

/** Set when `makecab.exe` proved itself on a trivial input. */
let haveMakecab = false

/** Path of the .exe fixture, or '' when System32 offered nothing suitable. */
let exeName = ''

/**
 * A tiny LCG, so "random" fixture bytes are identical on every run and a
 * failure can be reproduced rather than merely re-rolled.
 *
 * @param {number} seed @param {number} n @returns {Buffer}
 */
function pseudoRandom(seed, n) {
  const out = Buffer.alloc(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = (s >>> 24) & 0xff
  }
  return out
}

/**
 * Compressible but not trivially so: real words in varying order, which is
 * what makes makecab emit matches and long literal runs rather than one giant
 * repeat.
 *
 * @param {number} words @returns {Buffer}
 */
function proseFixture(words) {
  const vocab = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
  const parts = []
  let s = 12345
  for (let i = 0; i < words; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    parts.push(vocab[(s >>> 16) & 7])
    parts.push(i % 17 === 0 ? '\n' : ' ')
  }
  return Buffer.from(parts.join(''), 'utf-8')
}

/**
 * Run makecab for one file at one window size.
 *
 * `execFile` is used without a shell deliberately. Invoking makecab through a
 * POSIX shell on Windows rewrites `/D` into a path (`D:/`) and the switch is
 * silently lost; passing argv straight to CreateProcess avoids that entirely,
 * which is why no PowerShell wrapper is needed here.
 *
 * @param {string} source @param {string} out @param {number} windowBits
 */
function makecab(source, out, windowBits) {
  execFileSync('makecab.exe',
    ['/D', 'CompressionType=LZX', '/D', `CompressionMemory=${windowBits}`, source, out],
    { stdio: 'ignore' })
}

/** @param {string} name @returns {Buffer} */
const cab = (name) => readFileSync(join(dir, name))

/** @param {string} name @returns {Buffer} */
const source = (name) => readFileSync(join(dir, name))

/** The cabinet's own block checksum, so a doctored fixture can stay plausible. */
const u32at = (b, o) => b.readUInt32LE(o)

/**
 * @param {Buffer} buf @param {number} start @param {number} len @param {number} seed
 * @returns {number}
 */
function cabChecksum(buf, start, len, seed) {
  let c = seed >>> 0
  let i = start
  for (let w = len >> 2; w-- > 0; i += 4) c = (c ^ u32at(buf, i)) >>> 0
  let tail = 0
  if ((len & 3) === 3) tail |= buf[i++] << 16
  if ((len & 3) >= 2) tail |= buf[i++] << 8
  if ((len & 3) >= 1) tail |= buf[i]
  return (c ^ tail) >>> 0
}

/**
 * Byte offset of the folder's last CFDATA header.
 *
 * @param {Buffer} buf @param {ReturnType<typeof parseCab>} parsed @returns {number}
 */
function lastBlockHeader(buf, parsed) {
  let at = parsed.folders[0].coffData
  for (let i = 0; i < parsed.folders[0].blocks - 1; i++) {
    at += 8 + parsed.reserve.data + buf.readUInt16LE(at + 4)
  }
  return at
}

try {
  dir = mkdtempSync(join(tmpdir(), 'mycompare-lzx-'))
  writeFileSync(join(dir, 'probe.txt'), 'probe\n')
  makecab(join(dir, 'probe.txt'), join(dir, 'probe.cab'), 21)
  haveMakecab = readFileSync(join(dir, 'probe.cab')).subarray(0, 4).toString() === 'MSCF'
} catch {
  haveMakecab = false
}

const suite = haveMakecab ? describe : describe.skip

suite('LZX cabinets from makecab', () => {
  beforeAll(() => {
    writeFileSync(join(dir, 'text.txt'), proseFixture(150))
    writeFileSync(join(dir, 'big.txt'), proseFixture(40000))
    // Incompressible: makecab falls back to LZX "uncompressed" blocks, which
    // have their own alignment and repeated-offset rules and are otherwise
    // never reached.
    writeFileSync(join(dir, 'rand.bin'), pseudoRandom(999, 200_000))

    // A real x86 binary, so the E8 call translation actually fires. Text never
    // exercises it, and a decoder that skips it still passes every text test.
    const sys32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    for (const name of readdirSync(sys32).filter((f) => f.toLowerCase().endsWith('.exe')).sort()) {
      try {
        const size = statSync(join(sys32, name)).size
        if (size > 80_000 && size < 250_000) {
          copyFileSync(join(sys32, name), join(dir, 'sample.exe'))
          exeName = name
          break
        }
      } catch { /* unreadable or vanished; try the next one */ }
    }

    for (let w = 15; w <= 21; w++) makecab(join(dir, 'text.txt'), join(dir, `text.w${w}.cab`), w)
    for (const w of [15, 18, 21]) makecab(join(dir, 'big.txt'), join(dir, `big.w${w}.cab`), w)
    for (const w of [15, 21]) makecab(join(dir, 'rand.bin'), join(dir, `rand.w${w}.cab`), w)
    if (exeName) {
      for (const w of [15, 21]) makecab(join(dir, 'sample.exe'), join(dir, `sample.w${w}.cab`), w)
    }

    // Two files in one LZX folder, which is the only way to exercise an entry
    // whose offsetInFolder is not zero.
    const ddf = [
      '.OPTION EXPLICIT',
      '.Set CabinetNameTemplate=multi.cab',
      `.Set DiskDirectory1=${dir}`,
      '.Set CompressionType=LZX',
      '.Set CompressionMemory=18',
      '.Set Compress=ON',
      '.Set Cabinet=ON',
      '.Set MaxDiskSize=0',
      '.Set UniqueFiles=OFF',
      `.Set InfFileName=${join(dir, 'multi.inf')}`,
      `.Set RptFileName=${join(dir, 'multi.rpt')}`,
      `"${join(dir, 'text.txt')}"`,
      `"${join(dir, 'big.txt')}"`,
    ].join('\r\n')
    writeFileSync(join(dir, 'multi.ddf'), ddf, 'ascii')
    execFileSync('makecab.exe', ['/f', join(dir, 'multi.ddf')], { stdio: 'ignore', cwd: dir })
  }, 120_000)

  it('is reported as LZX with the window size makecab was asked for', () => {
    for (let w = 15; w <= 21; w++) {
      const { folders } = parseCab(cab(`text.w${w}.cab`))
      expect(folders).toHaveLength(1)
      expect(folders[0].compress).toBe(3)
      // The window exponent lives in bits 8..12 of typeCompress. Masking it
      // away leaves the decoder guessing at the position-slot table.
      expect(folders[0].windowBits).toBe(w)
    }
  })

  it.each([15, 16, 17, 18, 19, 20, 21])('decodes text at a 2^%i window', (w) => {
    const out = extractCabEntry(cab(`text.w${w}.cab`), parseCab(cab(`text.w${w}.cab`)), 'text.txt')
    expect(out.equals(source('text.txt'))).toBe(true)
  })

  it.each([15, 18, 21])('decodes input spanning many blocks at a 2^%i window', (w) => {
    const buf = cab(`big.w${w}.cab`)
    const parsed = parseCab(buf)
    // More than one CFDATA means more than one 32 KiB frame, which is what
    // exercises the persistent window, the persistent repeated-offset queue
    // and the end-of-frame re-alignment. Single-block input shows none of it.
    expect(parsed.folders[0].blocks).toBeGreaterThan(1)
    expect(extractCabEntry(buf, parsed, 'big.txt').equals(source('big.txt'))).toBe(true)
  })

  it('wraps the window when the output is longer than the window itself', () => {
    // A 2^15 window is exactly one frame, so a 230 KB file wraps it seven
    // times. A decoder that treated the window as a flat buffer would still
    // pass every 2^21 test above.
    const buf = cab('big.w15.cab')
    const out = extractCabEntry(buf, parseCab(buf), 'big.txt')
    expect(out.length).toBeGreaterThan(7 * 32768)
    expect(out.equals(source('big.txt'))).toBe(true)
  })

  it.each([15, 21])('decodes incompressible data at a 2^%i window', (w) => {
    const buf = cab(`rand.w${w}.cab`)
    expect(extractCabEntry(buf, parseCab(buf), 'rand.bin').equals(source('rand.bin'))).toBe(true)
  })

  it.each([15, 21])('decodes an x86 executable at a 2^%i window', (w) => {
    // Not skipped when System32 yields nothing: on a machine where makecab
    // exists, an .exe of a few hundred KB does too, and a silent pass here
    // would mean the E8 path is untested without anyone noticing.
    expect(exeName).not.toBe('')
    const buf = cab(`sample.w${w}.cab`)
    const want = source('sample.exe')
    // The E8 call translation rewrites the operand of every near call, so a
    // decoder that skips it produces a file of exactly the right length with
    // scattered wrong bytes. Byte equality against the original is the check;
    // the count below is here so a fixture that happened to contain no calls
    // would fail loudly rather than pass vacuously.
    expect(want.filter((b) => b === 0xe8).length).toBeGreaterThan(100)
    expect(extractCabEntry(buf, parseCab(buf), 'sample.exe').equals(want)).toBe(true)
  })

  it('agrees with expand.exe, not just with makecab', () => {
    // makecab and this decoder round-tripping proves the pair are consistent.
    // Microsoft's own extractor reading the same cabinet is the independent
    // half of the claim.
    const out = join(dir, 'expanded')
    mkdirSync(out, { recursive: true })
    // The absolute path matters: on a machine with Git for Windows on PATH,
    // the bare name resolves to GNU coreutils' `expand`, which is a tab
    // expander and will happily exit non-zero at us.
    const expandExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'expand.exe')
    execFileSync(expandExe, [join(dir, 'big.w21.cab'), '-F:*', out], { stdio: 'ignore' })
    const byExpand = readdirSync(out).map((f) => readFileSync(join(out, f)))
    expect(byExpand).toHaveLength(1)
    const buf = cab('big.w21.cab')
    expect(extractCabEntry(buf, parseCab(buf), 'big.txt').equals(byExpand[0])).toBe(true)
  })

  it('extracts a file that does not start at the beginning of its folder', () => {
    const buf = cab('multi.cab')
    const parsed = parseCab(buf)
    expect(parsed.folders).toHaveLength(1)
    expect(parsed.entries.map((e) => e.path).sort()).toEqual(['big.txt', 'text.txt'])
    const second = parsed.entries.find((e) => e.path === 'big.txt')
    expect(second?.offsetInFolder).toBeGreaterThan(0)
    for (const e of parsed.entries) {
      expect(extractCabEntry(buf, parsed, e.path).equals(source(e.path))).toBe(true)
    }
  })
})

suite('LZX cabinets that are damaged', () => {
  it('refuses a file cut in half rather than returning the part it could read', () => {
    const orig = cab('big.w18.cab')
    const half = Buffer.from(orig.subarray(0, Math.floor(orig.length * 0.6)))
    // The declared cabinet size is repaired so the truncation has to be caught
    // by the data path rather than by the header's own length check.
    half.writeUInt32LE(half.length, 8)
    expect(() => extractCabEntry(half, parseCab(half), 'big.txt')).toThrow(CabError)
  })

  it('refuses a stream truncated behind a checksum that still matches', () => {
    // The nastiest shape: bytes removed from the end of the compressed stream
    // and every structural field, including the block checksum, made
    // consistent again. Only the LZX layer can notice, and it must — the
    // alternative is emitting a short frame of plausible garbage.
    const orig = cab('big.w18.cab')
    const parsed = parseCab(orig)
    const hdr = lastBlockHeader(orig, parsed)
    const cbData = orig.readUInt16LE(hdr + 4)
    const cut = 24
    const doctored = Buffer.concat([
      orig.subarray(0, hdr + 8 + cbData - cut),
      orig.subarray(hdr + 8 + cbData),
    ])
    doctored.writeUInt16LE(cbData - cut, hdr + 4)
    doctored.writeUInt32LE(doctored.length, 8)
    doctored.writeUInt32LE(
      cabChecksum(doctored, hdr + 8, cbData - cut, cabChecksum(doctored, hdr + 4, 4, 0)), hdr)

    expect(() => extractCabEntry(doctored, parseCab(doctored), 'big.txt')).toThrow(CabError)
  })

  it('refuses a block whose bytes no longer match its checksum', () => {
    const buf = Buffer.from(cab('rand.w15.cab'))
    const parsed = parseCab(buf)
    // Damage inside an LZX "uncompressed" block is invisible to the
    // decompressor by construction — the bytes are the file. The cabinet's own
    // per-block checksum is the only thing standing between that and silently
    // handing back the wrong file.
    const at = parsed.folders[0].coffData + 8 + 100
    buf[at] ^= 0xff
    expect(() => extractCabEntry(buf, parsed, 'rand.bin')).toThrow(/檢查碼/)
  })

  it('refuses a window size outside what LZX allows instead of sizing from it', () => {
    // typeCompress is attacker-controlled; 2^31 must not become an allocation.
    for (const windowBits of [0, 14, 22, 31]) {
      expect(() => decodeFolder(cab('text.w21.cab'),
        { coffData: parseCab(cab('text.w21.cab')).folders[0].coffData, blocks: 1, compress: 3, windowBits },
        { data: 0 })).toThrow(/視窗大小/)
    }
  })

  it('still applies the output ceiling to LZX', () => {
    const buf = cab('big.w18.cab')
    expect(() => extractCabEntry(buf, parseCab(buf), 'big.txt', { maxBytes: 1000 }))
      .toThrow(/上限/)
  })
})
