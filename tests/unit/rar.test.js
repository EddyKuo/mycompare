/**
 * RAR 5 container reading.
 *
 * The problem with testing a hand-written archive reader is the one `cab.js`
 * and the SFTP client both ran into: if the fixture is produced by the same
 * understanding of the format as the parser, the test proves only that the
 * code is self-consistent. RAR makes that worse than usual, because nothing on
 * this machine can *write* a RAR — WinRAR is absent and 7-Zip's `a -t rar`
 * refuses — so there is no packer to generate fixtures with.
 *
 * The way out is that 7-Zip can *read* RAR. Every fixture below is assembled
 * byte-by-byte by {@link buildRar5} and then handed to 7-Zip, which lists it,
 * tests it (verifying the stored CRC-32 independently) and extracts it. If
 * 7-Zip agrees, the bytes are a genuine RAR and not merely something our own
 * parser likes. Only then is `rar.js` pointed at the same bytes.
 *
 * 7-Zip is a development tool, not a project dependency. Without it the
 * externally-validated tests skip with a warning rather than fail, matching
 * how `sftp-interop.test.js` behaves without paramiko. The pure-logic tests
 * (traversal, truncation, ceilings) do not need it and always run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  isRar,
  rarGeneration,
  parseRar,
  extractRarEntry,
  RarError,
} from '../../src/main/rar.js'
import { readArchive, readArchiveEntry, detectFormat, ArchiveError } from '../../src/main/archive.js'

/* ------------------------------------------------------------------ *
 *  Fixture builder — writes RAR 5 bytes, believing nothing.
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

/** @param {Uint8Array} b @returns {number} */
function crc32(b) {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** @param {number} n @returns {Buffer} */
function vint(n) {
  const out = []
  let v = BigInt(n)
  for (;;) {
    const b = Number(v & 0x7fn)
    v >>= 7n
    if (v === 0n) { out.push(b); break }
    out.push(b | 0x80)
  }
  return Buffer.from(out)
}

/** @param {number} n @returns {Buffer} */
function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

/**
 * CRC-32 + vint(size) + body, which is the shape of every RAR 5 block.
 *
 * @param {Buffer[]} parts header body, from the type field onwards
 * @returns {Buffer}
 */
function block(parts) {
  const body = Buffer.concat(parts)
  const covered = Buffer.concat([vint(body.length), body])
  return Buffer.concat([u32(crc32(covered)), covered])
}

const SIG5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
const SIG4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])

/**
 * @typedef {Object} FixtureFile
 * @property {string} name
 * @property {Buffer} [data]      contents; omitted for a directory
 * @property {boolean} [isDirectory]
 * @property {number} [method]    0 = store (default)
 * @property {number} [crc]       override the data CRC, to forge a mismatch
 * @property {number} [declaredSize] override the unpacked size field
 * @property {boolean} [encrypted] emit a file-encryption extra record
 */

/**
 * Assemble a RAR 5 archive.
 *
 * @param {FixtureFile[]} files
 * @returns {Buffer}
 */
function buildRar5(files) {
  const parts = [SIG5]
  // main archive header: type 1, no flags, archive flags 0
  parts.push(block([vint(1), vint(0), vint(0)]))

  for (const f of files) {
    const isDir = Boolean(f.isDirectory)
    const data = isDir ? Buffer.alloc(0) : (f.data ?? Buffer.alloc(0))
    const name = Buffer.from(f.name, 'utf8')
    const method = f.method ?? 0
    const declared = f.declaredSize ?? data.length

    let fileFlags = 0
    if (isDir) fileFlags |= 0x0001
    if (!isDir) fileFlags |= 0x0004 // CRC present

    let extra = Buffer.alloc(0)
    if (f.encrypted) {
      // One extra record: vint(size-of-rest) + vint(type=1) + a stub body.
      const recBody = Buffer.concat([vint(1), Buffer.from([0x00, 0x00])])
      extra = Buffer.concat([vint(recBody.length), recBody])
    }

    let blockFlags = 0
    if (data.length > 0) blockFlags |= 0x0002
    if (extra.length > 0) blockFlags |= 0x0001

    const body = [vint(2), vint(blockFlags)]
    if (extra.length > 0) body.push(vint(extra.length))
    if (data.length > 0) body.push(vint(data.length))
    body.push(
      vint(fileFlags),
      vint(isDir ? 0 : declared),
      vint(isDir ? 0x10 : 0x20),
    )
    if (!isDir) body.push(u32(f.crc ?? crc32(data)))
    body.push(
      vint((method & 0x07) << 7),
      vint(0), // host OS
      vint(name.length),
      name,
    )
    if (extra.length > 0) body.push(extra)

    parts.push(block(body))
    if (data.length > 0) parts.push(data)
  }

  parts.push(block([vint(5), vint(0), vint(0)])) // end of archive
  return Buffer.concat(parts)
}

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
 * @param {string} fileName
 * @param {Buffer} bytes
 * @returns {string} path on disk
 */
function writeValidated(fileName, bytes) {
  const p = join(dir, fileName)
  writeFileSync(p, bytes)
  const list = spawnSync(SEVENZIP, ['l', p], { encoding: 'utf8' })
  expect(list.status, `7z l said:\n${list.stdout}${list.stderr}`).toBe(0)
  expect(list.stdout).toContain('Rar5')
  const test = spawnSync(SEVENZIP, ['t', p], { encoding: 'utf8' })
  expect(test.status, `7z t said:\n${test.stdout}${test.stderr}`).toBe(0)
  expect(test.stdout).toContain('Everything is Ok')
  return p
}

const HELLO = Buffer.from('Hello, RAR5 stored world!\n', 'utf8')

/* ------------------------------------------------------------------ *
 *  Externally validated
 * ------------------------------------------------------------------ */

describeWith7z('RAR 5 fixtures validated by 7-Zip', () => {
  it('7-Zip lists, tests and extracts a hand-built stored archive, and so do we', () => {
    const bytes = buildRar5([{ name: 'hello.txt', data: HELLO }])
    const p = writeValidated('hello.rar', bytes)

    const out = join(dir, 'out-hello')
    const x = spawnSync(SEVENZIP, ['x', '-y', p, `-o${out}`], { encoding: 'utf8' })
    expect(x.status, x.stdout + x.stderr).toBe(0)
    // 7-Zip's bytes are the reference; ours must equal them, not merely equal
    // what we put in.
    const reference = readFileSync(join(out, 'hello.txt'))
    expect(reference.equals(HELLO)).toBe(true)

    const parsed = parseRar(bytes)
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
    const list = spawnSync(SEVENZIP, ['l', '-sccUTF-8', p], { encoding: 'utf8' })
    for (const n of ['a.txt', 'b.bin', '測試.txt']) expect(list.stdout).toContain(n)

    const out = join(dir, 'out-multi')
    expect(spawnSync(SEVENZIP, ['x', '-y', p, `-o${out}`], { encoding: 'utf8' }).status).toBe(0)

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
    const out = join(dir, 'out-big')
    expect(spawnSync(SEVENZIP, ['x', '-y', p, `-o${out}`], { encoding: 'utf8' }).status).toBe(0)

    const parsed = parseRar(bytes)
    expect(extractRarEntry(bytes, parsed, 'big.bin').equals(readFileSync(join(out, 'big.bin')))).toBe(true)
    expect(extractRarEntry(bytes, parsed, 'empty.txt').length).toBe(0)
  })

  it('7-Zip agrees a forged CRC is corrupt, and so do we', () => {
    // Built with a deliberately wrong data CRC: the container is still
    // well-formed — 7-Zip lists it — but testing it fails on the CRC alone.
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
 *  Refusals and hostile input — no external tool needed.
 * ------------------------------------------------------------------ */

describe('RAR detection', () => {
  it('recognises both generations and nothing else', () => {
    expect(isRar(buildRar5([{ name: 'a', data: HELLO }]))).toBe(true)
    expect(rarGeneration(buildRar5([{ name: 'a', data: HELLO }]))).toBe('rar5')
    expect(rarGeneration(Buffer.concat([SIG4, Buffer.alloc(20)]))).toBe('rar4')
    expect(rarGeneration(Buffer.from('PK\u0003\u0004xxxx'))).toBe(null)
    expect(isRar(null)).toBe(false)
    expect(isRar(Buffer.from('Rar'))).toBe(false)
  })
})

describe('RAR refusals by name', () => {
  it('refuses RAR 4 by name rather than guessing at its container', () => {
    const bytes = Buffer.concat([SIG4, Buffer.alloc(64)])
    expect(() => parseRar(bytes)).toThrow(RarError)
    expect(() => parseRar(bytes)).toThrow(/RAR 4.*容器結構不同.*不支援/s)
  })

  it('refuses RAR 4 by name at the detection layer too', () => {
    const bytes = Buffer.concat([SIG4, Buffer.alloc(64)])
    const err = (() => {
      try {
        detectFormat('/x/a.rar', bytes)
        return null
      } catch (e) { return e }
    })()
    expect(err).toBeInstanceOf(ArchiveError)
    expect(err.code).toBe('unsupported')
    expect(err.message).toMatch(/RAR 4/)
  })

  it.each([[1], [2], [3], [4], [5]])('refuses compression method %i by name', (method) => {
    const bytes = buildRar5([{ name: 'packed.bin', data: HELLO, method }])
    // Listing still works — a user must see what is in the archive.
    const parsed = parseRar(bytes)
    expect(parsed.entries[0].method).toBe(method)
    expect(parsed.entries[0].size).toBe(HELLO.length)
    // Extraction refuses, naming the method. It never returns the packed bytes.
    expect(() => extractRarEntry(bytes, parsed, 'packed.bin'))
      .toThrow(new RegExp(`RAR 壓縮方法 ${method}.*需要專有解壓演算法，本版本不支援`))
  })

  it('surfaces the compressed-method refusal through the app path', async () => {
    const bytes = buildRar5([{ name: 'packed.bin', data: HELLO, method: 3 }])
    const p = join(dir, 'packed.rar')
    writeFileSync(p, bytes)
    // The listing succeeds, so the user sees the file rather than an empty folder.
    const listing = await readArchive(p)
    expect(listing.entries.map((e) => e.path)).toEqual([`${p}::packed.bin`])
    await expect(readArchiveEntry(p, `${p}::packed.bin`))
      .rejects.toThrow(/RAR 壓縮方法 3.*不支援/)
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
})

describe('RAR hostile input', () => {
  it.each([
    ['../escape.txt', /逃出封存根目錄/],
    ['a/../../b.txt', /逃出封存根目錄/],
    ['/etc/passwd', /絕對路徑/],
    ['C:/Windows/x.txt', /絕對路徑/],
    ['dir\\..\\..\\x', /反斜線/],
    ['weird::name', /「::」/],
  ])('rejects the traversal name %s', (name, pattern) => {
    const bytes = buildRar5([{ name, data: HELLO }])
    expect(() => parseRar(bytes)).toThrow(pattern)
    try {
      parseRar(bytes)
    } catch (err) {
      expect(err.code).toBe('traversal')
    }
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

  it('throws when the end-of-archive block is missing entirely', () => {
    const full = buildRar5([{ name: 'a.txt', data: HELLO }])
    const noEnd = full.subarray(0, full.length - 7)
    expect(() => parseRar(noEnd)).toThrow(RarError)
  })

  it('detects a corrupted block header through its CRC', () => {
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO }])
    const i = bytes.indexOf(Buffer.from('a.txt'))
    bytes[i] = 0x62 // flip a name byte; the header CRC no longer matches
    expect(() => parseRar(bytes)).toThrow(/標頭的 CRC32 不符/)
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

  it('refuses a total past the whole-archive ceiling', () => {
    const bytes = buildRar5([
      { name: 'a.bin', data: HELLO },
      { name: 'b.bin', data: HELLO },
      { name: 'c.bin', data: HELLO },
    ])
    expect(() => parseRar(bytes, { maxBytes: 40 })).toThrow(/解開後超過 40 位元組的上限/)
  })

  it('refuses more entries than the ceiling allows', () => {
    const files = []
    for (let i = 0; i < 6; i++) files.push({ name: `f${i}.txt`, data: HELLO })
    expect(() => parseRar(buildRar5(files), { maxEntries: 3 })).toThrow(/項目數超過 3 的上限/)
  })

  it('refuses a stored entry whose declared size disagrees with its data area', () => {
    // Under the ceiling, so it survives parsing and has to be caught at
    // extraction — where believing the field would slice past the data.
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO, declaredSize: HELLO.length + 500 }])
    const parsed = parseRar(bytes)
    expect(() => extractRarEntry(bytes, parsed, 'a.txt')).toThrow(/宣告 \d+ 位元組，但資料區有/)
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
    const parsed = parseRar(bytes)
    expect(() => extractRarEntry(bytes, parsed, 'sub')).toThrow(/找不到項目/)
  })

  it('surfaces a corrupt RAR as an ArchiveError through the app path', async () => {
    const bytes = buildRar5([{ name: 'a.txt', data: HELLO }])
    const p = join(dir, 'corrupt.rar')
    writeFileSync(p, bytes.subarray(0, bytes.length - 12))
    await expect(readArchive(p)).rejects.toThrow(ArchiveError)
  })
})
