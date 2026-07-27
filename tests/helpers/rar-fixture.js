/**
 * RAR 5 fixture construction, shared by the unit tests and the e2e.
 *
 * Lives here rather than inside a test file because both layers need the same
 * bytes, and a second hand-rolled copy of a binary format is a second thing to
 * get subtly wrong. Nothing here is a decoder — every archive this produces is
 * handed to 7-Zip for validation before the code under test sees it.
 */
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
export function u32(n) {
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
export function block(parts) {
  const body = Buffer.concat(parts)
  const covered = Buffer.concat([vint(body.length), body])
  return Buffer.concat([u32(crc32(covered)), covered])
}

export const SIG5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
export const SIG4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])

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
