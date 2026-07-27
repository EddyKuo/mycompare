/**
 * RAR fixture construction, shared by the unit tests and the e2e.
 *
 * Lives here rather than inside a test file because both layers need the same
 * bytes, and a second hand-rolled copy of a binary format is a second thing to
 * get subtly wrong. Nothing here is a decoder — every archive this produces is
 * handed to 7-Zip for validation before the code under test sees it.
 *
 * One import crosses from the module under test into this builder: `blake2sp`,
 * used to fill a RAR 5 file-hash record. Normally that would be the
 * self-consistency trap this file exists to avoid — but 7-Zip verifies the
 * hash record when it tests the archive, and refuses the archive outright if
 * it is wrong (proven: a record filled with 0xaa makes `7z t` report
 * `CRC Failed`). So the shared function is graded by an outside judge, not by
 * agreement with itself.
 */
import { blake2sp } from '../../src/main/rar.js'

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
export function crc32(b) {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** @param {number} n @returns {Buffer} */
export function vint(n) {
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
export function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n & 0xffff, 0)
  return b
}

/** @param {number} n @returns {Buffer} */
export function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

/** @param {bigint|number} n @returns {Buffer} */
export function u64(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n), 0)
  return b
}

/**
 * CRC-32 + vint(size) + body, which is the shape of every RAR 5 block.
 *
 * @param {Buffer[]} parts header body, from the type field onwards
 * @returns {Buffer}
 */
export function block(parts) {
  const body = Buffer.concat(parts)
  const covered = Buffer.concat([vint(body.length), body])
  return Buffer.concat([u32(crc32(covered)), covered])
}

export const SIG5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
export const SIG4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])

/* ------------------------------------------------------------------ *
 *  RAR 5
 * ------------------------------------------------------------------ */

/**
 * One RAR 5 extra-area record: vint(size of the rest) + vint(type) + body.
 *
 * @param {number} type
 * @param {Buffer} body
 * @returns {Buffer}
 */
export function extraRecord(type, body) {
  const rest = Buffer.concat([vint(type), body])
  return Buffer.concat([vint(rest.length), rest])
}

/**
 * An `htime` (0x03) record.
 *
 * @param {{mtime?: Date, ctime?: Date, atime?: Date, unix?: boolean}} t
 * @returns {Buffer}
 */
export function htimeRecord(t) {
  const unix = t.unix !== false
  let flags = unix ? 0x0001 : 0
  /** @type {Buffer[]} */
  const times = []
  /** @param {Date} d @returns {Buffer} */
  const encode = (d) => (unix
    ? u32(Math.floor(d.getTime() / 1000))
    // Windows FILETIME: 100-nanosecond ticks since 1601.
    : u64((BigInt(d.getTime()) + 11644473600000n) * 10000n))
  if (t.mtime) { flags |= 0x0002; times.push(encode(t.mtime)) }
  if (t.ctime) { flags |= 0x0004; times.push(encode(t.ctime)) }
  if (t.atime) { flags |= 0x0008; times.push(encode(t.atime)) }
  return extraRecord(0x03, Buffer.concat([vint(flags), ...times]))
}

/**
 * A file-hash (0x02) record carrying the entry's real BLAKE2sp.
 *
 * @param {Buffer} data
 * @param {Buffer} [override] wrong bytes, to forge a mismatch
 * @returns {Buffer}
 */
export function hashRecord(data, override) {
  return extraRecord(0x02, Buffer.concat([vint(0), override ?? blake2sp(data)]))
}

/**
 * A redirection (0x05) record.
 *
 * @param {{kind?: number, isDirectory?: boolean, target: string}} r
 * @returns {Buffer}
 */
export function redirectRecord(r) {
  const target = Buffer.from(r.target, 'utf8')
  return extraRecord(0x05, Buffer.concat([
    vint(r.kind ?? 1),
    vint(r.isDirectory ? 1 : 0),
    vint(target.length),
    target,
  ]))
}

/**
 * @typedef {Object} FixtureFile
 * @property {string} name
 * @property {Buffer} [data]      contents; omitted for a directory
 * @property {boolean} [isDirectory]
 * @property {number} [method]    0 = store (default)
 * @property {number} [crc]       override the data CRC, to forge a mismatch
 * @property {number} [declaredSize] override the unpacked size field
 * @property {boolean} [encrypted] emit a file-encryption extra record
 * @property {Buffer[]} [extra]   extra-area records, in order
 */

/**
 * Assemble a RAR 5 archive.
 *
 * @param {FixtureFile[]} files
 * @returns {Buffer}
 */
export function buildRar5(files) {
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

    /** @type {Buffer[]} */
    const records = [...(f.extra ?? [])]
    if (f.encrypted) {
      records.unshift(extraRecord(0x01, Buffer.from([0x00, 0x00])))
    }
    const extra = Buffer.concat(records)

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
 *  RAR 4 — an entirely different container, not a variant of RAR 5
 * ------------------------------------------------------------------ */

/**
 * A RAR 4 block: HEAD_CRC(2) + HEAD_TYPE(1) + HEAD_FLAGS(2) + HEAD_SIZE(2),
 * then the type's own fixed fields. The CRC is a standard CRC-32 over
 * everything from HEAD_TYPE to the header's end, truncated to 16 bits.
 *
 * @param {number} type
 * @param {number} flags
 * @param {Buffer} rest everything after HEAD_SIZE
 * @returns {Buffer}
 */
export function block4(type, flags, rest) {
  const size = 7 + rest.length
  const head = Buffer.concat([Buffer.alloc(2), Buffer.from([type]), u16(flags), u16(size), rest])
  head.writeUInt16LE(crc32(head.subarray(2)) & 0xffff, 0)
  return head
}

/**
 * Pack a Date into MS-DOS's 32-bit date-time, which is what RAR 4 stores.
 * The components are local time, with no zone recorded.
 *
 * @param {Date} d
 * @returns {number}
 */
export function dosTime(d) {
  return (((d.getFullYear() - 1980) << 25)
    | ((d.getMonth() + 1) << 21)
    | (d.getDate() << 16)
    | (d.getHours() << 11)
    | (d.getMinutes() << 5)
    | (d.getSeconds() >> 1)) >>> 0
}

/**
 * Encode a name in RAR 4's Unicode file-name form: the ASCII fallback, a NUL,
 * a high byte, then a stream of two-bit opcodes.
 *
 * Only opcodes 0 (literal byte), 1 (byte plus the run's high byte) and 2 (raw
 * 16-bit code unit) are emitted here; opcode 3 copies a run from the ASCII
 * name and is exercised by a hand-built field in the tests instead.
 *
 * @param {string} name
 * @returns {Buffer}
 */
export function unicodeName4(name) {
  const chars = [...name].map((c) => c.charCodeAt(0))
  const ascii = Buffer.from(chars.map((c) => (c < 0x80 ? c : 0x5f)))

  // The high byte that makes opcode 1 usable: whichever one most of the
  // non-Latin-1 characters share.
  /** @type {Map<number, number>} */
  const tally = new Map()
  for (const c of chars) {
    if (c >= 0x100) tally.set(c >> 8, (tally.get(c >> 8) ?? 0) + 1)
  }
  let highByte = 0
  let best = 0
  for (const [k, n] of tally) if (n > best) { best = n; highByte = k }

  /** @type {number[]} */
  const stream = []
  /** @type {number[]} */
  const ops = []
  for (const c of chars) {
    if (c < 0x100) { ops.push(0); stream.push(c) }
    else if ((c >> 8) === highByte) { ops.push(1); stream.push(c & 0xff) }
    else { ops.push(2); stream.push(c & 0xff, c >> 8) }
  }

  // Two-bit opcodes pack MSB-first, and each flag byte precedes the four
  // operands it describes.
  /** @type {number[]} */
  const enc = [highByte]
  let si = 0
  for (let i = 0; i < ops.length; i += 4) {
    let flagByte = 0
    const group = ops.slice(i, i + 4)
    for (let j = 0; j < group.length; j++) flagByte |= group[j] << (6 - j * 2)
    enc.push(flagByte)
    for (const op of group) {
      enc.push(stream[si++])
      if (op === 2) enc.push(stream[si++])
    }
  }
  return Buffer.concat([ascii, Buffer.from([0]), Buffer.from(enc)])
}

/**
 * @typedef {Object} FixtureFile4
 * @property {string} name
 * @property {Buffer} [data]
 * @property {boolean} [isDirectory]
 * @property {number} [method]      0x30 = store (default)
 * @property {number} [crc]         override the data CRC, to forge a mismatch
 * @property {number} [declaredSize] override UNP_SIZE
 * @property {number} [hostOs]      2 = Win32 (default), 3 = Unix
 * @property {Date} [mtime]
 * @property {Buffer} [nameField]   a pre-encoded name field, with LHD_UNICODE set
 * @property {number} [extraFlags]  OR-ed into the block's HEAD_FLAGS
 */

/**
 * Assemble a RAR 4 archive.
 *
 * @param {FixtureFile4[]} files
 * @param {{mainFlags?: number}} [opts]
 * @returns {Buffer}
 */
export function buildRar4(files, opts = {}) {
  const parts = [SIG4]
  // Main archive header (0x73): HighPosAV(2) + PosAV(4).
  parts.push(block4(0x73, opts.mainFlags ?? 0, Buffer.concat([u16(0), u32(0)])))

  for (const f of files) {
    const isDir = Boolean(f.isDirectory)
    const data = isDir ? Buffer.alloc(0) : (f.data ?? Buffer.alloc(0))
    const declared = f.declaredSize ?? data.length
    const nameField = f.nameField ?? Buffer.from(f.name, 'utf8')

    // 0x8000 LONG_BLOCK is always set on a file header: PACK_SIZE doubles as
    // the block's ADD_SIZE.
    let flags = 0x8000 | (f.extraFlags ?? 0)
    if (isDir) flags |= 0x00e0 // all three dictionary bits: "directory"
    if (f.nameField) flags |= 0x0200 // LHD_UNICODE

    const rest = Buffer.alloc(25 + nameField.length)
    rest.writeUInt32LE(data.length, 0) // PACK_SIZE (also ADD_SIZE)
    rest.writeUInt32LE(isDir ? 0 : declared, 4) // UNP_SIZE
    rest.writeUInt8(f.hostOs ?? 2, 8) // HOST_OS
    rest.writeUInt32LE(f.crc ?? crc32(data), 9) // FILE_CRC
    rest.writeUInt32LE(dosTime(f.mtime ?? new Date(2026, 6, 28, 12, 34, 56)), 13) // FTIME
    rest.writeUInt8(20, 17) // UNP_VER — RAR 2.0, which is what a stored entry needs
    rest.writeUInt8(f.method ?? 0x30, 18) // METHOD
    rest.writeUInt16LE(nameField.length, 19) // NAME_SIZE
    rest.writeUInt32LE(isDir ? 0x10 : 0x20, 21) // ATTR
    nameField.copy(rest, 25)

    parts.push(block4(0x74, flags, rest))
    if (data.length > 0) parts.push(data)
  }

  // End of archive (0x7b). 0x4000 is SKIP_IF_UNKNOWN, which is what RAR sets.
  parts.push(block4(0x7b, 0x4000, Buffer.alloc(0)))
  return Buffer.concat(parts)
}
