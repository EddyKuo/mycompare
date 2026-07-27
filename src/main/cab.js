/**
 * @file cab.js
 * @description Reading Microsoft cabinet (`.cab`) archives.
 *
 *   A cabinet is a header, a list of folders (compression units), a list of
 *   files, and a run of data blocks per folder. Files are addressed by an
 *   offset into their folder's *decompressed* stream, so extracting one file
 *   means decompressing its folder up to that point — the same shape as a
 *   solid 7z archive.
 *
 *   Two compression types are handled. `NONE` is a copy. `MSZIP` is raw
 *   deflate per block behind a `CK` signature, and each block is compressed
 *   with the previous block's output as its dictionary — which is why blocks
 *   cannot be decoded independently or out of order.
 *
 *   Quantum and LZX are recognised and refused by name rather than
 *   mis-decoded. Both are proprietary-era formats whose bitstreams this cannot
 *   verify against a reference implementation, and a decoder that agrees only
 *   with itself is worse than an honest refusal.
 */
import { inflateRawSync } from 'zlib'

/** Signature at the start of every cabinet. */
const SIGNATURE = 'MSCF'

/** Fixed size of CFHEADER, before any reserved area. */
const HEADER_SIZE = 36

/** Compression type codes from the folder's typeCompress field. */
const COMPRESS = Object.freeze({
  none: 0,
  mszip: 1,
  quantum: 2,
  lzx: 3,
})

/** Names for the types recognised but not decoded. */
const UNSUPPORTED_NAMES = Object.freeze({
  [COMPRESS.quantum]: 'Quantum',
  [COMPRESS.lzx]: 'LZX',
})

/** Header flag: reserved areas are present and must be skipped. */
const FLAG_RESERVE_PRESENT = 0x0004

/** MSZIP resets its window every 32 KiB block; nothing may exceed it. */
const MSZIP_BLOCK_MAX = 32 * 1024

/** Ceiling on one extraction, matching the other archive readers. */
const DEFAULT_MAX_BYTES = 268_435_456

/** Every failure here, so a caller can branch on one type. */
export class CabError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'corrupt') {
    super(message)
    this.name = 'CabError'
    this.code = code
  }
}

/**
 * @param {Uint8Array|Buffer|null|undefined} buf
 * @returns {boolean}
 */
export function isCab(buf) {
  if (!buf || buf.length < HEADER_SIZE) return false
  return String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) === SIGNATURE
}

/** Little-endian readers; a cabinet is little-endian throughout. */
const u16 = (b, o) => b[o] | (b[o + 1] << 8)
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

/**
 * Parse a cabinet's structure without decompressing anything.
 *
 * @param {Uint8Array} buf
 * @returns {{
 *   entries: Array<{path: string, size: number, mtime: string, isDirectory: boolean,
 *                   folderIndex: number, offsetInFolder: number}>,
 *   folders: Array<{coffData: number, blocks: number, compress: number}>,
 *   reserve: {header: number, folder: number, data: number},
 * }}
 */
export function parseCab(buf) {
  if (!isCab(buf)) throw new CabError('不是 CAB 檔（magic 不符）', 'unsupported')

  const cbCabinet = u32(buf, 8)
  const coffFiles = u32(buf, 16)
  const cFolders = u16(buf, 26)
  const cFiles = u16(buf, 28)
  const flags = u16(buf, 30)

  if (cbCabinet > buf.length) {
    throw new CabError(`CAB 標頭宣告 ${cbCabinet} 位元組，實際只有 ${buf.length}`)
  }
  if (coffFiles >= buf.length) throw new CabError('CAB 檔案表位置超出檔案範圍')

  // A reserved area, when present, shifts every following structure. Reading
  // past it is how a cabinet written by a tool that uses reserves decodes into
  // nonsense rather than failing.
  let at = HEADER_SIZE
  const reserve = { header: 0, folder: 0, data: 0 }
  if (flags & FLAG_RESERVE_PRESENT) {
    if (at + 4 > buf.length) throw new CabError('CAB 保留區標頭被截斷')
    reserve.header = u16(buf, at)
    reserve.folder = buf[at + 2]
    reserve.data = buf[at + 3]
    at += 4 + reserve.header
  }

  const folders = []
  for (let i = 0; i < cFolders; i++) {
    if (at + 8 > buf.length) throw new CabError('CAB folder 表被截斷')
    folders.push({
      coffData: u32(buf, at),
      blocks: u16(buf, at + 4),
      compress: u16(buf, at + 6) & 0x000f,
    })
    at += 8 + reserve.folder
  }

  const entries = []
  let fo = coffFiles
  for (let i = 0; i < cFiles; i++) {
    if (fo + 16 > buf.length) throw new CabError('CAB 檔案表被截斷')
    const size = u32(buf, fo)
    const offsetInFolder = u32(buf, fo + 4)
    const folderIndex = u16(buf, fo + 8)
    const date = u16(buf, fo + 12)
    const time = u16(buf, fo + 14)
    fo += 16

    const nameStart = fo
    while (fo < buf.length && buf[fo] !== 0) fo++
    if (fo >= buf.length) throw new CabError('CAB 檔名沒有結束符')
    // Backslashes are the cabinet's own separator for a path inside it.
    const raw = Buffer.from(buf.subarray(nameStart, fo)).toString('latin1')
    fo++

    entries.push({
      path: raw.replace(/\\/g, '/'),
      size,
      mtime: dosDateTime(date, time),
      isDirectory: false,
      folderIndex,
      offsetInFolder,
    })
  }

  return { entries, folders, reserve }
}

/**
 * DOS packed date and time to an ISO string.
 *
 * @param {number} date @param {number} time
 * @returns {string}
 */
function dosDateTime(date, time) {
  const year = 1980 + ((date >> 9) & 0x7f)
  const month = (date >> 5) & 0x0f
  const day = date & 0x1f
  const hour = (time >> 11) & 0x1f
  const min = (time >> 5) & 0x3f
  const sec = (time & 0x1f) * 2
  const d = new Date(Date.UTC(year, Math.max(0, month - 1), day || 1, hour, min, sec))
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(0).toISOString()
}

/**
 * Decompress one folder's data blocks into a single buffer.
 *
 * @param {Uint8Array} buf
 * @param {{coffData: number, blocks: number, compress: number}} folder
 * @param {{data: number}} reserve
 * @param {number} maxBytes
 * @returns {Buffer}
 */
export function decodeFolder(buf, folder, reserve, maxBytes = DEFAULT_MAX_BYTES) {
  const name = UNSUPPORTED_NAMES[folder.compress]
  if (name) {
    throw new CabError(`CAB 使用了 ${name} 壓縮，此讀取器不支援`, 'unsupported')
  }
  if (folder.compress !== COMPRESS.none && folder.compress !== COMPRESS.mszip) {
    throw new CabError(`CAB 使用了未知的壓縮類型 ${folder.compress}`, 'unsupported')
  }

  /** @type {Buffer[]} */
  const parts = []
  let total = 0
  let at = folder.coffData
  /** Previous block's output: MSZIP compresses each block against it. */
  let dictionary = null

  for (let i = 0; i < folder.blocks; i++) {
    if (at + 8 > buf.length) throw new CabError('CAB 資料區塊標頭被截斷')
    const cbData = u16(buf, at + 4)
    const cbUncomp = u16(buf, at + 6)
    at += 8 + reserve.data
    if (at + cbData > buf.length) throw new CabError('CAB 資料區塊超出檔案範圍')
    const raw = Buffer.from(buf.subarray(at, at + cbData))
    at += cbData

    let out
    if (folder.compress === COMPRESS.none) {
      out = raw
    } else {
      if (raw.length < 2 || raw[0] !== 0x43 || raw[1] !== 0x4b) {
        throw new CabError('MSZIP 區塊缺少 CK 標記')
      }
      try {
        // Each block is deflated against the previous block's output. Passing
        // it as the dictionary is what makes block 2 onwards decode at all;
        // without it they inflate to garbage or fail outright.
        out = inflateRawSync(raw.subarray(2), {
          maxOutputLength: MSZIP_BLOCK_MAX,
          ...(dictionary ? { dictionary } : {}),
        })
      } catch (err) {
        throw new CabError(`MSZIP 區塊解壓失敗：${err instanceof Error ? err.message : err}`)
      }
      dictionary = out
    }

    // The header says how long the block should be; a mismatch means the
    // stream and the structure disagree, which no later check would catch.
    if (cbUncomp !== 0 && out.length !== cbUncomp) {
      throw new CabError(`CAB 區塊長度不符：標頭宣告 ${cbUncomp}，解出 ${out.length}`)
    }

    total += out.length
    if (total > maxBytes) {
      throw new CabError('CAB 解壓縮結果超過允許的大小上限', 'limit')
    }
    parts.push(out)
  }

  return Buffer.concat(parts, total)
}

/**
 * Extract one entry's bytes.
 *
 * @param {Uint8Array} buf
 * @param {ReturnType<typeof parseCab>} parsed
 * @param {string} path
 * @param {{maxBytes?: number}} [opts]
 * @returns {Buffer}
 */
export function extractCabEntry(buf, parsed, path, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const entry = parsed.entries.find((e) => e.path === path)
  if (!entry) throw new CabError(`CAB 內找不到項目：${path}`, 'notfound')

  const folder = parsed.folders[entry.folderIndex]
  if (!folder) throw new CabError(`CAB 項目指向不存在的 folder：${path}`)

  const whole = decodeFolder(buf, folder, parsed.reserve, maxBytes)
  const start = entry.offsetInFolder
  const end = start + entry.size
  if (end > whole.length) {
    throw new CabError(`CAB 項目超出其 folder 的資料範圍：${path}`)
  }
  return whole.subarray(start, end)
}
