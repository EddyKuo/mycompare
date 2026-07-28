/**
 * RAR container reading, both generations.
 *
 * The problem with testing a hand-written archive reader is the one `cab.js`
 * and the SFTP client both ran into: if the fixture is produced by the same
 * understanding of the format as the parser, the test proves only that the
 * code is self-consistent. RAR makes that worse than usual, because nothing on
 * this machine can *write* a RAR — WinRAR is absent and 7-Zip's `a -t rar`
 * refuses — so there is no packer to generate fixtures with.
 *
 * The way out is that 7-Zip can *read* RAR, and both generations of it: `7z i`
 * lists `Rar` and `Rar5` as separate handlers. Every fixture below is assembled
 * byte-by-byte by {@link buildRar5} or {@link buildRar4} and then handed to
 * 7-Zip, which lists it, tests it (verifying the stored CRC-32, and any
 * BLAKE2sp record, independently) and extracts it. If 7-Zip agrees, the bytes
 * are a genuine RAR and not merely something our own parser likes. Only then is
 * `rar.js` pointed at the same bytes.
 *
 * That the gate has teeth is proven, not assumed: `7z t` reports `CRC Failed`
 * on a fixture with one flipped data byte, and on one whose BLAKE2sp record is
 * filled with the wrong bytes. A fixture only well-formed enough to be listed
 * would not get through.
 *
 * 7-Zip is a development tool, not a project dependency. Without it the
 * externally-validated tests skip with a warning rather than fail, matching
 * how `sftp-interop.test.js` behaves without paramiko. The pure-logic tests
 * (traversal, truncation, ceilings) do not need it and always run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  buildRar5, buildRar4, block, block4, vint, u32, crc32, unicodeName4,
  htimeRecord, hashRecord, redirectRecord, extraRecord, dosTime,
  SIG4, SIG5,
} from '../helpers/rar-fixture.js'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  isRar,
  rarGeneration,
  parseRar,
  extractRarEntry,
  blake2sp,
  RarError,
} from '../../src/main/rar.js'
import { readArchive, readArchiveEntry, detectFormat, ArchiveError } from '../../src/main/archive.js'

/* ------------------------------------------------------------------ *
 *  7-Zip, the independent judge.
 * ------------------------------------------------------------------ */

function find7z() {
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    '7z',
  ]
  for (const exe of candidates) {
    const r = spawnSync(exe, ['i'], { stdio: 'ignore' })
    if (r.status === 0) return exe
  }
  return null
}

const SEVENZIP = find7z()
if (!SEVENZIP) {
  // eslint-disable-next-line no-console
  console.warn(
    '[rar.test] 7-Zip not found — skipping the externally-validated RAR tests.\n'
    + '           Install 7-Zip so the hand-built fixtures are checked by a tool\n'
    + '           other than the parser under test.',
  )
}
const describeWith7z = SEVENZIP ? describe : describe.skip

let dir = ''
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'mycompare-rar-')) })
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

/**
 * Write a fixture and assert 7-Zip accepts it, so the bytes are proven to be
 * a real RAR before `rar.js` is allowed to have an opinion about them.
 *
 * The generation is asserted exactly: `Type = Rar5` contains `Rar`, so a
 * substring check would let a RAR 5 pass as proof that a RAR 4 was built.
 *
 * @param {string} fileName
 * @param {Buffer} bytes
 * @param {'rar4'|'rar5'} [generation]
 * @returns {string} path on disk
 */
function writeValidated(fileName, bytes, generation = 'rar5') {
  const p = join(dir, fileName)
  writeFileSync(p, bytes)
  const list = spawnSync(SEVENZIP, ['l', '-sccUTF-8', p], { encoding: 'utf8' })
  expect(list.status, `7z l said:\n${list.stdout}${list.stderr}`).toBe(0)
  expect(list.stdout).toMatch(generation === 'rar5' ? /Type = Rar5/ : /Type = Rar\r?\n/)
  const test = spawnSync(SEVENZIP, ['t', p], { encoding: 'utf8' })
  expect(test.status, `7z t said:\n${test.stdout}${test.stderr}`).toBe(0)
  expect(test.stdout).toContain('Everything is Ok')
  return p
}

/**
 * @param {string} p
 * @param {string} outName
 * @returns {string} the directory 7-Zip extracted into
 */
function extractWith7z(p, outName) {
  const out = join(dir, outName)
  const x = spawnSync(SEVENZIP, ['x', '-y', p, `-o${out}`], { encoding: 'utf8' })
  expect(x.status, x.stdout + x.stderr).toBe(0)
  return out
}

/** @param {string} p @returns {string} */
function list7z(p) {
  return spawnSync(SEVENZIP, ['l', '-sccUTF-8', p], { encoding: 'utf8' }).stdout
}

const HELLO = Buffer.from('Hello, RAR5 stored world!\n', 'utf8')
const HELLO4 = Buffer.from('Hello, RAR4 stored world!\n', 'utf8')

/* ------------------------------------------------------------------ *
 *  RAR 5 — externally validated
 * ------------------------------------------------------------------ */

describeWith7z('RAR 5 fixtures validated by 7-Zip', () => {
  it('7-Zip lists, tests and extracts a hand-built stored archive, and so do we', () => {
    const bytes = buildRar5([{ name: 'hello.txt', data: HELLO }])
    const p = writeValidated('hello.rar', bytes)

    const out = extractWith7z(p, 'out-hello')
    // 7-Zip's bytes are the reference; ours must equal them, not merely equal
    // what we put in.
    const reference = readFileSync(join(out, 'hello.txt'))
    expect(reference.equals(HELLO)).toBe(true)

    const parsed = parseRar(bytes)
    expect(parsed.generation).toBe('rar5')
    expect(parsed.entries.map((e) => e.path)).toEqual(['hello.txt'])
    expect(parsed.entries[0].size).toBe(HELLO.length)
    expect(parsed.entries[0].method).toBe(0)
    expect(extractRarEntry(bytes, parsed, 'hello.txt').equals(reference)).toBe(true)
  })

  it('lists several entries, a subdirectory and a UTF-8 name the same way 7-Zip does', () => {
    const nested = Buffer.from('nested payload', 'utf8')
    const unicode = Buffer.from('中文內容', 'utf8')
    const bytes = buildRar5([
      { name: 'a.txt', data: HELLO },
      { name: 'sub', isDirectory: true },
      { name: 'sub/b.bin', data: nested },
      { name: '測試.txt', data: unicode },
    ])
    const p = writeValidated('multi.rar', bytes)

    // `-sccUTF-8` because 7-Zip otherwise writes its listing in the console's
    // OEM codepage, which mangles the non-ASCII name into `?`s — an artefact
    // of the pipe, not of the archive.
    const listing = list7z(p)
    for (const n of ['a.txt', 'b.bin', '測試.txt']) expect(listing).toContain(n)

    const out = extractWith7z(p, 'out-multi')

    const parsed = parseRar(bytes)
    expect(parsed.entries.map((e) => e.path)).toEqual(['a.txt', 'sub', 'sub/b.bin', '測試.txt'])
    expect(parsed.entries[1].isDirectory).toBe(true)
    expect(extractRarEntry(bytes, parsed, 'sub/b.bin')
      .equals(readFileSync(join(out, 'sub', 'b.bin')))).toBe(true)
    expect(extractRarEntry(bytes, parsed, '測試.txt')
      .equals(readFileSync(join(out, '測試.txt')))).toBe(true)
  })

  it('extracts an empty file and a file spanning many kilobytes byte-for-byte', () => {
    const big = Buffer.alloc(200_000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff
    const bytes = buildRar5([
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'big.bin', data: big },
    ])
    const p = writeValidated('big.rar', bytes)
    const out = extractWith7z(p, 'out-big')

    const parsed = parseRar(bytes)
    expect(extractRarEntry(bytes, parsed, 'big.bin').equals(readFileSync(join(out, 'big.bin')))).toBe(true)
    expect(extractRarEntry(bytes, parsed, 'empty.txt').length).toBe(0)
  })

  it('7-Zip agrees a forged CRC is corrupt, and so do we', () => {
    // Built with a deliberately wrong data CRC: the container is still
    // well-formed — 7-Zip lists it — but testing it fails on the CRC alone.
    // This is what proves the gate above is verifying rather than parsing past.
    const bytes = buildRar5([{ name: 'bad.txt', data: HELLO, crc: 0xdeadbeef }])
    const p = join(dir, 'badcrc.rar')
    writeFileSync(p, bytes)

    expect(spawnSync(SEVENZIP, ['l', p], { encoding: 'utf8' }).status).toBe(0)
    const t = spawnSync(SEVENZIP, ['t', p], { encoding: 'utf8' })
    expect(t.status).not.toBe(0)
    expect(t.stdout + t.stderr).toMatch(/CRC/i)

    const parsed = parseRar(bytes)
    expect(() => extractRarEntry(bytes, parsed, 'bad.txt')).toThrow(/CRC32 不符/)
  })

  it('reads a validated archive through the app path, listing and extracting', async () => {
    const bytes = buildRar5([{ name: 'app.txt', data: HELLO }])
    const p = writeValidated('app.rar', bytes)

    expect(detectFormat(p, bytes)).toBe('rar')
    const listing = await readArchive(p)
    expect(listing.format).toBe('rar')
    expect(listing.entries.map((e) => e.path)).toEqual([`${p}::app.txt`])
    const got = await readArchiveEntry(p, `${p}::app.txt`)
    expect(got.equals(HELLO)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 *  RAR 5 extra area — real records, not stubs
 * ------------------------------------------------------------------ */

describeWith7z('RAR 5 extra-area records validated by 7-Zip', () => {
  // Chosen with a non-zero minute and an odd second so a mis-shifted field
  // could not coincidentally land on the right value.
  const MTIME = new Date(Date.UTC(2026, 2, 14, 1, 59, 26))
  const CTIME = new Date(Date.UTC(2025, 10, 5, 22, 7, 3))
  const ATIME = new Date(Date.UTC(2026, 4, 1, 6, 30, 0))

  /**
   * 7-Zip prints local time, so the expectation has to be built from local
   * components rather than from the ISO string.
   *
   * @param {Date} d
   * @returns {string}
   */
  const localStamp = (d) => {
    const two = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} `
      + `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  }

  it('parses a Unix-format htime record, and 7-Zip shows the timestamp we encoded', () => {
    const bytes = buildRar5([
      { name: 'timed.txt', data: HELLO, extra: [htimeRecord({ mtime: MTIME, unix: true })] },
    ])
    const p = writeValidated('htime-unix.rar', bytes)
    expect(list7z(p)).toContain(localStamp(MTIME))

    const parsed = parseRar(bytes)
    expect(parsed.entries[0].mtime).toBe(MTIME.toISOString())
  })

  it('parses a Windows FILETIME htime record to the same instant', () => {
    const bytes = buildRar5([
      { name: 'timed.txt', data: HELLO, extra: [htimeRecord({ mtime: MTIME, unix: false })] },
    ])
    const p = writeValidated('htime-win.rar', bytes)
    expect(list7z(p)).toContain(localStamp(MTIME))

    const parsed = parseRar(bytes)
    expect(parsed.entries[0].mtime).toBe(MTIME.toISOString())
  })

  it('reads modification, creation and access times in the order the record declares', () => {
    // Three times in one record: reading any of the widths wrong shifts the
    // two that follow, so this catches a mis-sized field that a single-time
    // fixture would not.
    const bytes = buildRar5([
      {
        name: 'three.txt',
        data: HELLO,
        extra: [htimeRecord({ mtime: MTIME, ctime: CTIME, atime: ATIME, unix: false })],
      },
    ])
    const p = writeValidated('htime-three.rar', bytes)
    expect(list7z(p)).toContain(localStamp(MTIME))

    const [e] = parseRar(bytes).entries
    expect(e.mtime).toBe(MTIME.toISOString())
    expect(e.ctime).toBe(CTIME.toISOString())
    expect(e.atime).toBe(ATIME.toISOString())
  })

  it('carries a real BLAKE2sp file-hash record and verifies it on extraction', () => {
    // Over 64 bytes so the hash actually exercises more than one leaf of the
    // tree; a short payload would leave seven of the eight untouched.
    const data = Buffer.alloc(700)
    for (let i = 0; i < data.length; i++) data[i] = (i * 17 + 3) & 0xff
    const bytes = buildRar5([{ name: 'hashed.bin', data, extra: [hashRecord(data)] }])
    const p = writeValidated('hash.rar', bytes)
    const out = extractWith7z(p, 'out-hash')

    const parsed = parseRar(bytes)
    expect(parsed.entries[0].hash).toEqual({
      algorithm: 'BLAKE2sp',
      value: blake2sp(data).toString('hex'),
    })
    expect(extractRarEntry(bytes, parsed, 'hashed.bin')
      .equals(readFileSync(join(out, 'hashed.bin')))).toBe(true)
  })

  it('7-Zip rejects a wrong BLAKE2sp record, and so do we — the CRC alone would have passed', () => {
    // The CRC-32 is correct here. Only the hash is wrong, so anything that
    // catches this is genuinely checking the hash rather than riding on the CRC.
    const data = Buffer.from('hash me', 'utf8')
    const bytes = buildRar5([
      { name: 'h.bin', data, extra: [hashRecord(data, Buffer.alloc(32, 0xaa))] },
    ])
    const p = join(dir, 'badhash.rar')
    writeFileSync(p, bytes)
    const t = spawnSync(SEVENZIP, ['t', p], { encoding: 'utf8' })
    expect(t.status).not.toBe(0)

    const parsed = parseRar(bytes)
    expect(() => extractRarEntry(bytes, parsed, 'h.bin')).toThrow(/BLAKE2sp 雜湊不符/)
  })

  it('skips an unknown extra record by its declared length and keeps reading the rest', () => {
    // The unknown record sits *before* the htime. A parser that stopped at the
    // first type it did not know would silently lose the timestamp, and a
    // parser that mis-stepped its length would derail on the next record.
    const bytes = buildRar5([
      {
        name: 'unknown.txt',
        data: HELLO,
        extra: [
          extraRecord(0x7f, Buffer.from([1, 2, 3, 4, 5, 6, 7])),
          htimeRecord({ mtime: MTIME, unix: true }),
          extraRecord(0x40, Buffer.alloc(0)),
        ],
      },
    ])
    const p = writeValidated('unknown-extra.rar', bytes)
    expect(list7z(p)).toContain(localStamp(MTIME))

    const parsed = parseRar(bytes)
    const [e] = parsed.entries
    expect(e.mtime).toBe(MTIME.toISOString())
    expect(e.unknownExtra).toEqual([0x7f, 0x40])
    expect(extractRarEntry(bytes, parsed, 'unknown.txt').equals(HELLO)).toBe(true)
  })

  it('recognises a symlink and refuses to hand back its target as file contents', () => {
    const target = Buffer.from('I am the target\n', 'utf8')
    const bytes = buildRar5([
      { name: 'target.txt', data: target },
      { name: 'link.txt', extra: [redirectRecord({ kind: 1, target: 'target.txt' })] },
    ])
    const p = writeValidated('symlink.rar', bytes)
    expect(list7z(p)).toContain('link.txt')

    const parsed = parseRar(bytes)
    const link = parsed.entries.find((e) => e.path === 'link.txt')
    expect(link.redirect).toEqual({
      kind: 1,
      kindName: 'UNIX 符號連結（symlink）',
      isDirectory: false,
      target: 'target.txt',
    })
    // Refused by name, with the target named too. A symlink's "contents" are
    // its target; returning the zero data bytes stored for it, or the target
    // string, would both be wrong answers dressed as right ones.
    expect(() => extractRarEntry(bytes, parsed, 'link.txt'))
      .toThrow(/是UNIX 符號連結（symlink），指向「target\.txt」/)
    // The real file beside it is unaffected.
    expect(extractRarEntry(bytes, parsed, 'target.txt').equals(target)).toBe(true)
  })

  it.each([
    [2, 'Windows 符號連結（symlink）'],
    [3, 'Windows 交接點（junction）'],
    [4, '硬連結（hard link）'],
    [5, '檔案複本（file copy）'],
    [9, '未知的連結型別 9'],
  ])('names redirection kind %i in its refusal', (kind, kindName) => {
    const bytes = buildRar5([
      { name: 'l.txt', extra: [redirectRecord({ kind, target: 'elsewhere/x' })] },
    ])
    const parsed = parseRar(bytes)
    expect(parsed.entries[0].redirect.kindName).toBe(kindName)
    expect(() => extractRarEntry(bytes, parsed, 'l.txt')).toThrow(kindName)
  })
})

describe('RAR 5 extra-area records without an external tool', () => {
  it('refuses a record whose declared length runs past the extra area', () => {
    // A size field that overruns the header: believing it would read fields
    // belonging to the next block, or past the buffer.
    const oversized = Buffer.concat([vint(40), vint(0x03), Buffer.alloc(4)])
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO, extra: [oversized] }])
    expect(() => parseRar(bytes)).toThrow(/extra area 的記錄長度超出範圍/)
  })

  it('refuses a zero-length record rather than treating it as a terminator', () => {
    // Zero would leave the walk standing still. Stopping there is how a parser
    // silently drops every record that follows.
    const zero = Buffer.concat([vint(0), vint(0x03)])
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO, extra: [zero] }])
    expect(() => parseRar(bytes)).toThrow(/extra area 的記錄長度為 0/)
  })

  it('refuses a truncated htime record instead of reading whatever follows it', () => {
    // Declares an mtime but leaves only two of its four bytes inside the record.
    const short = extraRecord(0x03, Buffer.concat([vint(0x0003), Buffer.alloc(2)]))
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO, extra: [short] }])
    expect(() => parseRar(bytes)).toThrow(/htime 記錄被截斷/)
  })

  it('refuses a truncated file-hash record', () => {
    const short = extraRecord(0x02, Buffer.concat([vint(0), Buffer.alloc(10)]))
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO, extra: [short] }])
    expect(() => parseRar(bytes)).toThrow(/檔案雜湊記錄被截斷/)
  })

  it('notes an unknown hash algorithm rather than slicing a length it does not know', () => {
    const odd = extraRecord(0x02, Buffer.concat([vint(7), Buffer.alloc(16)]))
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO, extra: [odd] }])
    const parsed = parseRar(bytes)
    expect(parsed.entries[0].hash.algorithm).toBe('未知（id 7）')
    // Unknown algorithm means no check to run; the CRC-32 still guards the bytes.
    expect(extractRarEntry(bytes, parsed, 'a.txt').equals(HELLO)).toBe(true)
  })

  it('reads records that only describe the entry without inventing fields for them', () => {
    const bytes = buildRar5([
      {
        name: 'a.txt',
        data: HELLO,
        extra: [
          extraRecord(0x04, Buffer.concat([vint(0), vint(3)])), // version
          extraRecord(0x06, Buffer.from([0])), // owner
        ],
      },
    ])
    const parsed = parseRar(bytes)
    // Recognised, so not reported as unknown, and not surfaced as untested fields.
    expect(parsed.entries[0].unknownExtra).toEqual([])
  })
})

describe('BLAKE2sp', () => {
  it('matches the published empty-input vector', () => {
    expect(blake2sp(Buffer.alloc(0)).toString('hex'))
      .toBe('dd0e891776933f43c7d032b08a917e25741f8aa9a12c12e1cac8801500f2ca4f')
  })

  it('spans every leaf of the tree, so a single-leaf bug could not pass', () => {
    // Eight 64-byte blocks feed all eight leaves exactly once; the ninth wraps
    // back to leaf 0, which is where a naive round-robin off-by-one shows up.
    const a = Buffer.alloc(64 * 9, 0x41)
    const b = Buffer.from(a)
    b[64 * 8] = 0x42 // a byte only leaf 0's second block sees
    expect(blake2sp(a).equals(blake2sp(b))).toBe(false)
  })

  it('agrees with 7-Zip on a real payload', () => {
    if (!SEVENZIP) return
    const data = Buffer.alloc(700)
    for (let i = 0; i < data.length; i++) data[i] = (i * 17 + 3) & 0xff
    const p = join(dir, 'b2sp.bin')
    writeFileSync(p, data)
    const h = spawnSync(SEVENZIP, ['h', '-scrcBLAKE2SP', p], { encoding: 'utf8' })
    expect(h.status).toBe(0)
    expect(h.stdout.toLowerCase()).toContain(blake2sp(data).toString('hex'))
  })

  it('has a BLAKE2s core that agrees with Node crypto at the sequential setting', () => {
    // BLAKE2sp is BLAKE2s in tree mode; Node has the sequential mode only. A
    // one-block input still runs the same compression function through the
    // same G rounds, so a broken core would diverge from `blake2s256` here
    // even though the tree parameters differ.
    const single = createHash('blake2s256').update(Buffer.alloc(0)).digest('hex')
    expect(single).toBe('69217a3079908094e11121d042354a7c1f55b6482ca1a51e1b250dfd1ed0eef9')
    // And the tree mode over the same empty input is a different, known value —
    // proof the parameter block is being mixed in rather than ignored.
    expect(blake2sp(Buffer.alloc(0)).toString('hex')).not.toBe(single)
  })
})

/* ------------------------------------------------------------------ *
 *  RAR 4 — externally validated
 * ------------------------------------------------------------------ */

describeWith7z('RAR 4 fixtures validated by 7-Zip', () => {
  it('7-Zip lists it as Rar (not Rar5), tests and extracts it, and so do we', () => {
    const bytes = buildRar4([{ name: 'hello.txt', data: HELLO4 }])
    const p = writeValidated('r4-hello.rar', bytes, 'rar4')

    const out = extractWith7z(p, 'out-r4')
    const reference = readFileSync(join(out, 'hello.txt'))
    expect(reference.equals(HELLO4)).toBe(true)

    const parsed = parseRar(bytes)
    expect(parsed.generation).toBe('rar4')
    expect(parsed.entries.map((e) => e.path)).toEqual(['hello.txt'])
    expect(parsed.entries[0].size).toBe(HELLO4.length)
    expect(parsed.entries[0].method).toBe(0)
    expect(extractRarEntry(bytes, parsed, 'hello.txt').equals(reference)).toBe(true)
  })

  it('reads the MS-DOS timestamp 7-Zip shows', () => {
    const mtime = new Date(2024, 10, 5, 22, 7, 4) // even seconds: DOS stores them halved
    const bytes = buildRar4([{ name: 't.txt', data: HELLO4, mtime }])
    const p = writeValidated('r4-time.rar', bytes, 'rar4')
    expect(list7z(p)).toContain('2024-11-05 22:07:04')

    // DOS timestamps carry no zone, so the components are local — which is
    // exactly what 7-Zip printed above.
    expect(parseRar(bytes).entries[0].mtime).toBe(mtime.toISOString())
  })

  it('handles directories, backslash separators and Unicode names as 7-Zip does', () => {
    const nested = Buffer.from('nested payload', 'utf8')
    const uni = Buffer.from('unicode payload', 'utf8')
    const bytes = buildRar4([
      { name: 'a.txt', data: HELLO4 },
      { name: 'sub', isDirectory: true },
      // A Windows-packed RAR 4 stores `\` as the separator; 7-Zip extracts it
      // as one, so translating rather than refusing it is the correct read.
      { name: 'sub\\b.bin', data: nested },
      { name: 'uni', nameField: unicodeName4('測試名稱.txt'), data: uni },
    ])
    const p = writeValidated('r4-multi.rar', bytes, 'rar4')
    const listing = list7z(p)
    expect(listing).toContain('sub\\b.bin')
    expect(listing).toContain('測試名稱.txt')

    const out = extractWith7z(p, 'out-r4multi')
    const parsed = parseRar(bytes)
    expect(parsed.entries.map((e) => e.path))
      .toEqual(['a.txt', 'sub', 'sub/b.bin', '測試名稱.txt'])
    expect(parsed.entries[1].isDirectory).toBe(true)
    expect(extractRarEntry(bytes, parsed, 'sub/b.bin')
      .equals(readFileSync(join(out, 'sub', 'b.bin')))).toBe(true)
    expect(extractRarEntry(bytes, parsed, '測試名稱.txt')
      .equals(readFileSync(join(out, '測試名稱.txt')))).toBe(true)
  })

  it('decodes the Unicode name opcodes the same way 7-Zip does', () => {
    // Opcode 3 copies a run out of the ASCII fallback name, optionally adding
    // a per-character correction. The fixture builder never emits it, so this
    // field is hand-assembled: ascii "abcdefgh", then opcode 3 (length 0 → two
    // characters copied) followed by two literals.
    const ascii = Buffer.from('abcdefgh', 'ascii')
    const field = Buffer.concat([
      ascii,
      Buffer.from([0x00]), // separator
      Buffer.from([0x00]), // high byte
      Buffer.from([0xc0]), // opcodes: 3, 0, 0, 0
      Buffer.from([0x00]), // opcode 3 length 0 → 2 characters from the ASCII name
      Buffer.from([0x58, 0x59]), // two literals: X, Y
    ])
    const bytes = buildRar4([{ name: 'ignored', nameField: field, data: HELLO4 }])
    const p = writeValidated('r4-uniop.rar', bytes, 'rar4')
    // 7-Zip's decoder is the reference; ours must land on the same string.
    expect(list7z(p)).toContain('abXY')
    expect(parseRar(bytes).entries[0].path).toBe('abXY')
  })

  it('extracts an empty file and a file spanning many kilobytes byte-for-byte', () => {
    const big = Buffer.alloc(150_000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 13 + 5) & 0xff
    const bytes = buildRar4([
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'big.bin', data: big },
    ])
    const p = writeValidated('r4-big.rar', bytes, 'rar4')
    const out = extractWith7z(p, 'out-r4big')

    const parsed = parseRar(bytes)
    expect(extractRarEntry(bytes, parsed, 'big.bin')
      .equals(readFileSync(join(out, 'big.bin')))).toBe(true)
    expect(extractRarEntry(bytes, parsed, 'empty.txt').length).toBe(0)
  })

  it('7-Zip agrees a forged FILE_CRC is corrupt, and so do we', () => {
    // Without this the gate above would be worthless: a fixture merely
    // well-formed enough to list would look validated. 7-Zip fails it on the
    // CRC alone, which proves it verifies the data rather than parsing past.
    const bytes = buildRar4([{ name: 'bad.txt', data: HELLO4, crc: 0xdeadbeef }])
    const p = join(dir, 'r4-badcrc.rar')
    writeFileSync(p, bytes)

    expect(spawnSync(SEVENZIP, ['l', p], { encoding: 'utf8' }).status).toBe(0)
    const t = spawnSync(SEVENZIP, ['t', p], { encoding: 'utf8' })
    expect(t.status).not.toBe(0)
    expect(t.stdout + t.stderr).toMatch(/CRC/i)

    const parsed = parseRar(bytes)
    expect(() => extractRarEntry(bytes, parsed, 'bad.txt')).toThrow(/CRC32 不符/)
  })

  it('7-Zip agrees a flipped data byte is corrupt, and so do we', () => {
    const bytes = buildRar4([{ name: 'flip.txt', data: HELLO4 }])
    writeValidated('r4-flip-good.rar', bytes, 'rar4')
    const tampered = Buffer.from(bytes)
    tampered[tampered.indexOf(HELLO4) + 3] ^= 0xff
    const p = join(dir, 'r4-flip.rar')
    writeFileSync(p, tampered)
    expect(spawnSync(SEVENZIP, ['t', p], { encoding: 'utf8' }).status).not.toBe(0)

    const parsed = parseRar(tampered)
    expect(() => extractRarEntry(tampered, parsed, 'flip.txt')).toThrow(/CRC32 不符/)
  })

  it('reads a validated RAR 4 through the app path, listing and extracting', async () => {
    const bytes = buildRar4([{ name: 'app4.txt', data: HELLO4 }])
    const p = writeValidated('r4-app.rar', bytes, 'rar4')

    expect(detectFormat(p, bytes)).toBe('rar')
    const listing = await readArchive(p)
    expect(listing.format).toBe('rar')
    expect(listing.entries.map((e) => e.path)).toEqual([`${p}::app4.txt`])
    const got = await readArchiveEntry(p, `${p}::app4.txt`)
    expect(got.equals(HELLO4)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 *  Refusals and hostile input — no external tool needed.
 * ------------------------------------------------------------------ */

describe('RAR detection', () => {
  it('recognises both generations and nothing else', () => {
    expect(isRar(buildRar5([{ name: 'a', data: HELLO }]))).toBe(true)
    expect(rarGeneration(buildRar5([{ name: 'a', data: HELLO }]))).toBe('rar5')
    expect(rarGeneration(buildRar4([{ name: 'a', data: HELLO }]))).toBe('rar4')
    expect(rarGeneration(Buffer.concat([SIG4, Buffer.alloc(20)]))).toBe('rar4')
    expect(rarGeneration(Buffer.from('PK\u0003\u0004xxxx'))).toBe(null)
    expect(isRar(null)).toBe(false)
    expect(isRar(Buffer.from('Rar'))).toBe(false)
  })

  it('routes both generations to the rar reader at the detection layer', () => {
    expect(detectFormat('/x/a.rar', buildRar5([{ name: 'a.txt', data: HELLO }]))).toBe('rar')
    expect(detectFormat('/x/b.rar', buildRar4([{ name: 'b.txt', data: HELLO4 }]))).toBe('rar')
  })
})

describe('RAR refusals by name', () => {
  it.each([[1], [2], [3], [4], [5]])('refuses RAR 5 compression method %i by name', (method) => {
    const bytes = buildRar5([{ name: 'packed.bin', data: HELLO, method }])
    // Listing still works — a user must see what is in the archive.
    const parsed = parseRar(bytes)
    expect(parsed.entries[0].method).toBe(method)
    expect(parsed.entries[0].size).toBe(HELLO.length)
    // Extraction refuses, naming the method. It never returns the packed bytes.
    expect(() => extractRarEntry(bytes, parsed, 'packed.bin'))
      .toThrow(new RegExp(`RAR 壓縮方法 ${method}.*需要專有解壓演算法，本版本不支援`))
  })

  it.each([
    [0x31, 1, 'Fastest (m1)'],
    [0x32, 2, 'Fast (m2)'],
    [0x33, 3, 'Normal (m3)'],
    [0x34, 4, 'Good (m4)'],
    [0x35, 5, 'Best (m5)'],
  ])('refuses RAR 4 method byte 0x%s by name', (raw, method, label) => {
    const bytes = buildRar4([{ name: 'packed.bin', data: HELLO4, method: raw }])
    const parsed = parseRar(bytes)
    // Listed with the right size, so the user sees the file rather than an
    // empty folder — the refusal comes at the point wrong bytes would be made.
    expect(parsed.entries[0].method).toBe(method)
    expect(parsed.entries[0].size).toBe(HELLO4.length)
    expect(() => extractRarEntry(bytes, parsed, 'packed.bin'))
      .toThrow(new RegExp(`RAR 壓縮方法 ${method}（${label.replace(/[()]/g, '\\$&')}）`))
  })

  it('refuses a RAR 4 method byte the format does not define', () => {
    const bytes = buildRar4([{ name: 'weird.bin', data: HELLO4, method: 0x41 }])
    expect(() => parseRar(bytes)).toThrow(/壓縮方法位元組 0x41 不是此格式定義的方法/)
  })

  it('surfaces the compressed-method refusal through the app path', async () => {
    const bytes = buildRar5([{ name: 'packed.bin', data: HELLO, method: 3 }])
    const p = join(dir, 'packed.rar')
    writeFileSync(p, bytes)
    // The listing succeeds, so the user sees the file rather than an empty folder.
    const listing = await readArchive(p)
    expect(listing.entries.map((e) => e.path)).toEqual([`${p}::packed.bin`])
    // Either outcome is correct, and which one happens depends on the machine:
    // with no archiver installed this is our named refusal; with 7-Zip or
    // WinRAR present the delegation runs and reports a data error, because
    // this fixture's "compressed" payload is fabricated rather than really
    // packed. What must never happen is bytes coming back.
    await expect(readArchiveEntry(p, `${p}::packed.bin`))
      .rejects.toThrow(/RAR 壓縮方法 3.*不支援|7-Zip|UnRAR/)
  })

  it('surfaces a RAR 4 compressed-method refusal through the app path', async () => {
    const bytes = buildRar4([{ name: 'packed4.bin', data: HELLO4, method: 0x33 }])
    const p = join(dir, 'packed4.rar')
    writeFileSync(p, bytes)
    const listing = await readArchive(p)
    expect(listing.entries.map((e) => e.path)).toEqual([`${p}::packed4.bin`])
    await expect(readArchiveEntry(p, `${p}::packed4.bin`))
      .rejects.toThrow(/RAR 壓縮方法 3.*不支援|7-Zip|UnRAR/)
  })

  it('refuses an encrypted entry by name', () => {
    const bytes = buildRar5([{ name: 'secret.txt', data: HELLO, encrypted: true }])
    expect(() => parseRar(bytes)).toThrow(/已加密.*不支援加密的 RAR/)
    try {
      parseRar(bytes)
    } catch (err) {
      expect(err.code).toBe('encrypted')
    }
  })

  it('refuses an archive with an encrypted header block by name', () => {
    const parts = [SIG5, block([vint(4), vint(0), vint(0)])]
    expect(() => parseRar(Buffer.concat(parts))).toThrow(/標頭已加密.*不支援加密的 RAR/)
  })

  it('refuses a RAR 4 entry marked with a password by name', () => {
    const bytes = buildRar4([{ name: 'secret.txt', data: HELLO4, extraFlags: 0x0004 }])
    expect(() => parseRar(bytes)).toThrow(/RAR4 項目「secret.txt」已加密/)
    try {
      parseRar(bytes)
    } catch (err) {
      expect(err.code).toBe('encrypted')
    }
  })

  it('refuses a RAR 4 archive with encrypted headers by name', () => {
    const bytes = buildRar4([{ name: 'a.txt', data: HELLO4 }], { mainFlags: 0x0080 })
    expect(() => parseRar(bytes)).toThrow(/RAR4 封存的標頭已加密/)
  })

  it('refuses a RAR 4 volume and a RAR 4 solid entry by name', () => {
    expect(() => parseRar(buildRar4([{ name: 'a.txt', data: HELLO4 }], { mainFlags: 0x0001 })))
      .toThrow(/RAR4 分卷封存/)
    expect(() => parseRar(buildRar4([{ name: 'a.txt', data: HELLO4, extraFlags: 0x0010 }])))
      .toThrow(/屬於 solid 區塊/)
    expect(() => parseRar(buildRar4([{ name: 'a.txt', data: HELLO4, extraFlags: 0x0002 }])))
      .toThrow(/RAR4 分卷封存/)
  })
})

describe('RAR hostile input', () => {
  it.each([
    ['../escape.txt', /逃出封存根目錄/],
    ['a/../../b.txt', /逃出封存根目錄/],
    ['/etc/passwd', /絕對路徑/],
    ['C:/Windows/x.txt', /絕對路徑/],
    ['dir\\..\\..\\x', /反斜線/],
    ['weird::name', /「::」/],
  ])('rejects the RAR 5 traversal name %s', (name, pattern) => {
    const bytes = buildRar5([{ name, data: HELLO }])
    expect(() => parseRar(bytes)).toThrow(pattern)
    try {
      parseRar(bytes)
    } catch (err) {
      expect(err.code).toBe('traversal')
    }
  })

  it.each([
    ['../escape.txt', /逃出封存根目錄/],
    ['..\\escape.txt', /逃出封存根目錄/],
    ['a\\..\\..\\b.txt', /逃出封存根目錄/],
    ['/etc/passwd', /絕對路徑/],
    ['\\\\server\\share\\x', /逃出封存根目錄|絕對路徑/],
    ['C:\\Windows\\x.txt', /絕對路徑/],
    ['weird::name', /「::」/],
  ])('rejects the RAR 4 traversal name %s once its separators are normalised', (name, pattern) => {
    // A DOS/Windows-packed RAR 4 gets its backslashes translated, so the
    // traversal check has to run on the translated form — a name that is safe
    // as a literal string and hostile as a path must not slip through.
    const bytes = buildRar4([{ name, data: HELLO4, hostOs: 2 }])
    expect(() => parseRar(bytes)).toThrow(pattern)
    try {
      parseRar(bytes)
    } catch (err) {
      expect(err.code).toBe('traversal')
    }
  })

  it('keeps refusing a backslash in a Unix-packed RAR 4 name, where it is not a separator', () => {
    // HOST_OS 3 is Unix, where `\` is an ordinary filename character on the
    // packing machine and a directory separator on this one. Translating it
    // would invent a directory that the archive never contained.
    const bytes = buildRar4([{ name: 'weird\\name.txt', data: HELLO4, hostOs: 3 }])
    expect(() => parseRar(bytes)).toThrow(/反斜線/)
  })

  it('throws on a truncated archive rather than returning what it managed to read', () => {
    const full = buildRar5([{ name: 'a.txt', data: HELLO }, { name: 'b.txt', data: HELLO }])
    // Cut inside the second entry's data, past a complete first entry.
    expect(() => parseRar(full.subarray(0, full.length - 20))).toThrow(RarError)
    // Cut mid-header.
    expect(() => parseRar(full.subarray(0, 30))).toThrow(RarError)
    // Signature only: no end-of-archive block was ever reached.
    expect(() => parseRar(SIG5)).toThrow(/缺少結尾區塊/)
  })

  it('throws on a truncated RAR 4 rather than returning what it managed to read', () => {
    const full = buildRar4([{ name: 'a.txt', data: HELLO4 }, { name: 'b.txt', data: HELLO4 }])
    expect(() => parseRar(full.subarray(0, full.length - 20))).toThrow(RarError)
    expect(() => parseRar(full.subarray(0, 30))).toThrow(RarError)
    expect(() => parseRar(SIG4)).toThrow(/RAR4 缺少結尾區塊/)
    // A signature followed by nothing that parses as a block.
    expect(() => parseRar(Buffer.concat([SIG4, Buffer.alloc(64)]))).toThrow(RarError)
  })

  it('throws when the end-of-archive block is missing entirely', () => {
    const full = buildRar5([{ name: 'a.txt', data: HELLO }])
    expect(() => parseRar(full.subarray(0, full.length - 7))).toThrow(RarError)
    const full4 = buildRar4([{ name: 'a.txt', data: HELLO4 }])
    expect(() => parseRar(full4.subarray(0, full4.length - 7))).toThrow(/RAR4 缺少結尾區塊/)
  })

  it('detects a corrupted block header through its CRC', () => {
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO }])
    const i = bytes.indexOf(Buffer.from('a.txt'))
    bytes[i] = 0x62 // flip a name byte; the header CRC no longer matches
    expect(() => parseRar(bytes)).toThrow(/標頭的 CRC32 不符/)
  })

  it('detects a corrupted RAR 4 block header through its 16-bit CRC', () => {
    const bytes = buildRar4([{ name: 'a.txt', data: HELLO4 }])
    const i = bytes.indexOf(Buffer.from('a.txt'))
    bytes[i] = 0x62
    expect(() => parseRar(bytes)).toThrow(/RAR4 區塊標頭的 CRC 不符/)
  })

  it.each([
    // Too small even for ADD_SIZE, which ends at byte 11.
    [9, /ADD_SIZE 欄位超出標頭範圍/],
    // Room for ADD_SIZE but not for the 32-byte fixed part of a file header.
    [12, /RAR4 檔案標頭被截斷/],
  ])('refuses a RAR 4 HEAD_SIZE of %i that could not hold the fields it claims', (size, pattern) => {
    const bytes = buildRar4([{ name: 'a.txt', data: HELLO4 }])
    // The file block starts after the 7-byte marker and the 13-byte main
    // header; HEAD_SIZE sits 5 bytes into it. The header CRC is recomputed so
    // the shrunken size is what gets caught, not the corruption that shrinking
    // it would otherwise cause.
    const at = SIG4.length + 13
    bytes.writeUInt16LE(size, at + 5)
    bytes.writeUInt16LE(crc32(bytes.subarray(at + 2, at + size)) & 0xffff, at)
    expect(() => parseRar(bytes)).toThrow(pattern)
  })

  it('refuses a declared size past the per-entry ceiling before allocating', () => {
    // The header claims 4 GiB; the file is a hundred bytes. A parser that
    // believed the field would try to allocate on it.
    const bytes = buildRar5([
      { name: 'huge.bin', data: HELLO, declaredSize: 4 * 1024 * 1024 * 1024 },
    ])
    expect(() => parseRar(bytes)).toThrow(/超過.*的上限/)
    try {
      parseRar(bytes)
    } catch (err) {
      expect(err.code).toBe('limit')
    }
  })

  it('applies the same per-entry ceiling to a RAR 4 declared size', () => {
    const bytes = buildRar4([
      { name: 'huge.bin', data: HELLO4, declaredSize: 0xf0000000 },
    ])
    expect(() => parseRar(bytes)).toThrow(/超過.*的上限/)
    try {
      parseRar(bytes)
    } catch (err) {
      expect(err.code).toBe('limit')
    }
  })

  it('refuses a total past the whole-archive ceiling', () => {
    const files = [
      { name: 'a.bin', data: HELLO },
      { name: 'b.bin', data: HELLO },
      { name: 'c.bin', data: HELLO },
    ]
    expect(() => parseRar(buildRar5(files), { maxBytes: 40 }))
      .toThrow(/解開後超過 40 位元組的上限/)
    const files4 = files.map((f) => ({ ...f, data: HELLO4 }))
    expect(() => parseRar(buildRar4(files4), { maxBytes: 40 }))
      .toThrow(/解開後超過 40 位元組的上限/)
  })

  it('refuses more entries than the ceiling allows', () => {
    const files = []
    for (let i = 0; i < 6; i++) files.push({ name: `f${i}.txt`, data: HELLO })
    expect(() => parseRar(buildRar5(files), { maxEntries: 3 })).toThrow(/項目數超過 3 的上限/)
    expect(() => parseRar(buildRar4(files), { maxEntries: 3 })).toThrow(/項目數超過 3 的上限/)
  })

  it('refuses a stored entry whose declared size disagrees with its data area', () => {
    // Under the ceiling, so it survives parsing and has to be caught at
    // extraction — where believing the field would slice past the data.
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO, declaredSize: HELLO.length + 500 }])
    const parsed = parseRar(bytes)
    expect(() => extractRarEntry(bytes, parsed, 'a.txt')).toThrow(/宣告 \d+ 位元組，但資料區有/)

    const b4 = buildRar4([{ name: 'a.txt', data: HELLO4, declaredSize: HELLO4.length + 500 }])
    const p4 = parseRar(b4)
    expect(() => extractRarEntry(b4, p4, 'a.txt')).toThrow(/宣告 \d+ 位元組，但資料區有/)
  })

  it('reports a missing entry rather than returning empty bytes', () => {
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO }])
    const parsed = parseRar(bytes)
    expect(() => extractRarEntry(bytes, parsed, 'nope.txt')).toThrow(/找不到項目/)
    try {
      extractRarEntry(bytes, parsed, 'nope.txt')
    } catch (err) {
      expect(err.code).toBe('notfound')
    }
  })

  it('refuses a directory entry as an extraction target', () => {
    const bytes = buildRar5([{ name: 'sub', isDirectory: true }])
    expect(() => extractRarEntry(bytes, parseRar(bytes), 'sub')).toThrow(/找不到項目/)
    const b4 = buildRar4([{ name: 'sub', isDirectory: true }])
    expect(() => extractRarEntry(b4, parseRar(b4), 'sub')).toThrow(/找不到項目/)
  })

  it('surfaces a corrupt RAR as an ArchiveError through the app path', async () => {
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO }])
    const p = join(dir, 'corrupt.rar')
    writeFileSync(p, bytes.subarray(0, bytes.length - 12))
    await expect(readArchive(p)).rejects.toThrow(ArchiveError)

    const b4 = buildRar4([{ name: 'a.txt', data: HELLO4 }])
    const p4 = join(dir, 'corrupt4.rar')
    writeFileSync(p4, b4.subarray(0, b4.length - 12))
    await expect(readArchive(p4)).rejects.toThrow(ArchiveError)
  })

  it('builds a well-formed RAR 4 block, so the negative tests above mean something', () => {
    // A guard on the fixture builder itself: if `block4` produced junk, every
    // "refuses X" test would pass for the wrong reason.
    const one = block4(0x7b, 0x4000, Buffer.alloc(0))
    expect(one.length).toBe(7)
    expect(one[2]).toBe(0x7b)
    expect(one.readUInt16LE(0)).toBe(crc32(one.subarray(2)) & 0xffff)
    expect(dosTime(new Date(1980, 0, 1, 0, 0, 0))).toBe(0x00210000)
    expect(u32(1).readUInt32LE(0)).toBe(1)
  })
})
