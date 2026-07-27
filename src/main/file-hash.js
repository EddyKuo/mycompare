import { createHash } from 'crypto'

/**
 * 計算 buffer 的 MD5 hex digest。
 * @param {Buffer} buffer
 * @returns {string} 32 位元 hex 字串
 */
export function computeMd5(buffer) {
  return createHash('md5').update(buffer).digest('hex')
}

/**
 * CRC-32 table for the reflected polynomial 0xEDB88320.
 *
 * This is the CRC every tool the user might cross-check against uses — zip,
 * PNG, gzip, BC's own checksum column. Built once at load rather than per call
 * because the folder view hashes hundreds of files in a burst.
 */
const CRC32_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/**
 * CRC-32 of a buffer, as eight uppercase hex digits.
 *
 * Separate from MD5 rather than a relabelling of it. The folder view's checksum
 * column existed backed by MD5, which is a fine integrity check but is not what
 * "CRC" means anywhere else — a user comparing the value against the CRC that
 * unzip or `7z l` prints would find it does not match and have no way to know
 * why. Offering both, each under its real name, is the fix.
 *
 * @param {Buffer} buffer
 * @returns {string} eight uppercase hex digits, zero-padded
 */
export function computeCrc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  // `>>> 0` because the accumulator is signed; without it every CRC with the
  // high bit set would render as a negative number.
  return ((crc ^ -1) >>> 0).toString(16).toUpperCase().padStart(8, '0')
}
