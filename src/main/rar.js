/**
 * @file rar.js
 * @description Reading RAR 5 archives — container only, STORED entries only.
 *
 *   RAR's *container* is documented and unencumbered: a signature, then a
 *   chain of blocks, each one a CRC-32 over a self-describing header, with
 *   file data following its header inline. That much can be parsed, and — the
 *   part that matters — it can be *checked against something other than
 *   itself*, because an archive assembled byte-by-byte here is either a real
 *   RAR that WinRAR and 7-Zip accept or it is nothing.
 *
 *   RAR's *compression* is a different matter. The algorithms behind methods
 *   1..5 are proprietary, and no tool on this machine can produce a RAR at all
 *   (WinRAR is absent; 7-Zip extracts RAR but `7z a -t rar` refuses; a
 *   full-disk search found no `.rar` to borrow). A decoder written under those
 *   conditions could only ever be graded by the code that wrote it, and a
 *   decoder that agrees only with itself is worse than an honest refusal —
 *   it returns wrong bytes and calls them right. So methods 1..5 are named
 *   and refused. Same for RAR 4, which is a different container generation
 *   whose layout would likewise be guessed rather than verified.
 *
 *   That leaves method 0, STORE, where the packed bytes *are* the unpacked
 *   bytes. It is implementable and it is verifiable, and this file does only
 *   that. Read `cab.js`'s note on Quantum before extending any of this: two
 *   refusals in that file's history were inherited rather than checked, and
 *   both turned out to be false. Before writing "no tool here can produce
 *   one", run the tool.
 *
 *   The fixtures under `tests/unit/rar.test.js` are hand-built and then
 *   handed to 7-Zip, which lists, tests and extracts them independently.
 *
 *   Everything in an archive is attacker-controlled: names, declared sizes,
 *   block lengths. Nothing here allocates on a declared number before that
 *   number has been checked against both the ceiling and the bytes actually
 *   present.
 */

import { crc32 } from './lzma.js'

/** RAR 5 signature: `Rar!\x1a\x07\x01\x00`. */
const SIGNATURE_5 = Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])

/** RAR 4 (and older) signature: `Rar!\x1a\x07\x00`. */
const SIGNATURE_4 = Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])

/** Block header types. */
const BLOCK = Object.freeze({
  main: 1,
  file: 2,
  service: 3,
  encryption: 4,
  end: 5,
})

/** Common block header flags. */
const HFLAG = Object.freeze({
  extraArea: 0x0001,
  dataArea: 0x0002,
  splitBefore: 0x0008,
  splitAfter: 0x0010,
})

/** File header flags. */
const FFLAG = Object.freeze({
  directory: 0x0001,
  mtimeUnix: 0x0002,
  crcPresent: 0x0004,
  unknownSize: 0x0008,
})

/** Extra-area record type marking a per-file encrypted entry. */
const EXTRA_FILE_ENCRYPTION = 0x01

/** Compression methods. Only `store` carries no proprietary algorithm. */
const METHOD_STORE = 0

/**
 * Names for the methods recognised but deliberately not decoded, so a refusal
 * says which algorithm was met rather than just "unsupported".
 */
const METHOD_NAMES = Object.freeze({
  1: 'Fastest (m1)',
  2: 'Fast (m2)',
  3: 'Normal (m3)',
  4: 'Good (m4)',
  5: 'Best (m5)',
})

/** Ceilings, matching the other archive readers in this directory. */
const DEFAULT_MAX_BYTES = 268_435_456
const DEFAULT_MAX_ENTRY_BYTES = 134_217_728
const DEFAULT_MAX_ENTRIES = 20_000

/**
 * A header longer than this is a corrupt or hostile length field, not a real
 * archive: RAR caps its own header size well below it, and the value is only
 * ever used to slice a buffer we have already bounds-checked.
 */
const MAX_HEADER_SIZE = 1 << 20

/** Entry names above this are refused before the bytes are turned into a string. */
const MAX_NAME_BYTES = 4096

/** Every failure here, so a caller can branch on one type. */
export class RarError extends Error {
  /**
   * @param {string} message
   * @param {'unsupported'|'corrupt'|'limit'|'traversal'|'notfound'|'encrypted'} [code]
   */
  constructor(message, code = 'corrupt') {
    super(message)
    this.name = 'RarError'
    this.code = code
  }
}

/**
 * @param {Uint8Array|Buffer|null|undefined} buf
 * @param {Uint8Array} sig
 * @returns {boolean}
 */
function startsWith(buf, sig) {
  if (!buf || buf.length < sig.length) return false
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false
  return true
}

/**
 * Does this look like a RAR of any generation?
 *
 * @param {Uint8Array|Buffer|null|undefined} buf
 * @returns {boolean}
 */
export function isRar(buf) {
  return startsWith(buf, SIGNATURE_5) || startsWith(buf, SIGNATURE_4)
}

/**
 * Which container generation, if any.
 *
 * The two are told apart by the eighth signature byte, so the RAR 5 test has
 * to come first — RAR 4's shorter signature is a prefix of neither, but the
 * check reads clearer in this order.
 *
 * @param {Uint8Array|Buffer|null|undefined} buf
 * @returns {'rar5'|'rar4'|null}
 */
export function rarGeneration(buf) {
  if (startsWith(buf, SIGNATURE_5)) return 'rar5'
  if (startsWith(buf, SIGNATURE_4)) return 'rar4'
  return null
}

/**
 * A RAR 5 variable-length integer: 7 bits per byte, little-endian, high bit
 * set on every byte but the last.
 *
 * The value is accumulated in a Number rather than a BigInt because every
 * consumer here compares it against a byte ceiling far below 2^53; anything
 * needing more than that is refused outright instead of silently losing
 * precision, which is how an oversized length field turns into a wrong slice.
 *
 * @param {Uint8Array} buf
 * @param {number} at
 * @param {number} end exclusive bound the integer may not read past
 * @returns {{value: number, next: number}}
 */
function readVint(buf, at, end) {
  let value = 0
  let shift = 0
  let i = at
  for (;;) {
    if (i >= end) throw new RarError('RAR vint 在資料結束前被截斷')
    if (shift > 63) throw new RarError('RAR vint 超過 64 位元')
    const byte = buf[i]
    value += (byte & 0x7f) * 2 ** shift
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new RarError('RAR vint 的數值超出安全整數範圍')
    }
    i++
    if ((byte & 0x80) === 0) return { value, next: i }
    shift += 7
  }
}

/**
 * @param {Uint8Array} buf
 * @param {number} at
 * @returns {number}
 */
function readU32(buf, at) {
  return (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0
}

/**
 * Walk a header's extra area looking for the records that change what an
 * entry *is* rather than merely describing it.
 *
 * Only encryption is acted on. An unknown record is skipped, which is what the
 * format intends — but an encrypted entry read as if it were plaintext would
 * hand back ciphertext and call it the file, so that one is not optional.
 *
 * @param {Uint8Array} buf
 * @param {number} at start of the extra area
 * @param {number} end exclusive end of the extra area
 * @returns {{encrypted: boolean}}
 */
function scanExtraArea(buf, at, end) {
  let encrypted = false
  let i = at
  while (i < end) {
    const size = readVint(buf, i, end)
    // The record's size counts everything after its own size field.
    const bodyEnd = size.next + size.value
    if (size.value < 0 || bodyEnd > end || bodyEnd < size.next) {
      throw new RarError('RAR extra area 的記錄長度超出範圍')
    }
    if (bodyEnd === size.next) break // zero-length record: nothing more to read
    const type = readVint(buf, size.next, bodyEnd)
    if (type.value === EXTRA_FILE_ENCRYPTION) encrypted = true
    i = bodyEnd
  }
  return { encrypted }
}

/**
 * @typedef {Object} RarEntry
 * @property {string} path        name as stored, normalised to `/`
 * @property {number} size        unpacked size in bytes
 * @property {string} mtime       ISO 8601
 * @property {boolean} isDirectory
 * @property {number} method      compression method, 0 = stored
 * @property {number|null} crc    stored CRC-32 of the unpacked data, if present
 * @property {number} dataOffset  absolute offset of the packed bytes
 * @property {number} dataSize    packed byte count
 */

/**
 * @typedef {Object} RarParsed
 * @property {RarEntry[]} entries
 * @property {boolean} sawEnd  whether an end-of-archive block was reached
 */

/**
 * Parse a RAR 5 container without decompressing anything.
 *
 * Compressed entries are *listed*, not refused: a user opening an archive
 * should see what is in it and be told why one file cannot be opened, rather
 * than be shown an empty folder. The refusal happens in
 * {@link extractRarEntry}, at the point where wrong bytes would otherwise be
 * produced.
 *
 * @param {Uint8Array} buf
 * @param {{maxEntries?: number, maxEntryBytes?: number, maxBytes?: number}} [opts]
 * @returns {RarParsed}
 */
export function parseRar(buf, opts = {}) {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  const generation = rarGeneration(buf)
  if (generation === null) throw new RarError('不是 RAR 檔（signature 不符）', 'unsupported')
  if (generation === 'rar4') {
    // Refused by name rather than guessed at. RAR 4's block layout differs
    // from RAR 5's throughout — not a variant of it — and with no way to make
    // a RAR 4 file on this machine, a parser for it could not be checked
    // against anything but its own author's reading of the spec.
    throw new RarError(
      'RAR 4（含）以前的封存格式與 RAR 5 的容器結構不同，本版本不支援；'
      + '請以 RAR 5 格式重新封存',
      'unsupported',
    )
  }

  /** @type {RarEntry[]} */
  const entries = []
  let total = 0
  let sawEnd = false
  let at = SIGNATURE_5.length

  while (at < buf.length) {
    // A trailing run shorter than the smallest possible block is truncation,
    // not padding: RAR ends with an explicit end-of-archive block.
    if (at + 4 >= buf.length) throw new RarError('RAR 區塊標頭被截斷')

    const storedCrc = readU32(buf, at)
    const sizeField = at + 4
    const size = readVint(buf, sizeField, buf.length)
    const headerSize = size.value
    if (headerSize === 0 || headerSize > MAX_HEADER_SIZE) {
      throw new RarError(`RAR 區塊標頭長度不合法：${headerSize}`)
    }
    const bodyStart = size.next
    const bodyEnd = bodyStart + headerSize
    if (bodyEnd > buf.length) throw new RarError('RAR 區塊標頭超出檔案範圍')

    // The CRC covers the size field and the header body, but not the CRC itself.
    if (crc32(buf.subarray(sizeField, bodyEnd)) !== storedCrc) {
      throw new RarError('RAR 區塊標頭的 CRC32 不符，檔案已損壞')
    }

    let p = bodyStart
    const typeRead = readVint(buf, p, bodyEnd)
    const type = typeRead.value
    p = typeRead.next
    const flagsRead = readVint(buf, p, bodyEnd)
    const flags = flagsRead.value
    p = flagsRead.next

    let extraSize = 0
    if (flags & HFLAG.extraArea) {
      const r = readVint(buf, p, bodyEnd)
      extraSize = r.value
      p = r.next
    }
    let dataSize = 0
    if (flags & HFLAG.dataArea) {
      const r = readVint(buf, p, bodyEnd)
      dataSize = r.value
      p = r.next
    }

    const extraStart = bodyEnd - extraSize
    if (extraSize < 0 || extraStart < p) {
      throw new RarError('RAR extra area 長度與標頭長度矛盾')
    }
    const fieldsEnd = extraStart

    const dataStart = bodyEnd
    const dataEnd = dataStart + dataSize
    if (dataEnd > buf.length || dataEnd < dataStart) {
      throw new RarError('RAR 區塊的資料區超出檔案範圍')
    }

    if (type === BLOCK.encryption) {
      throw new RarError(
        'RAR 封存的標頭已加密，需要密碼才能讀取，本版本不支援加密的 RAR', 'encrypted',
      )
    }

    if (type === BLOCK.end) {
      sawEnd = true
      break
    }

    if (type === BLOCK.file) {
      if (flags & (HFLAG.splitBefore | HFLAG.splitAfter)) {
        throw new RarError('RAR 分卷封存（split volume）本版本不支援', 'unsupported')
      }
      const entry = readFileHeader(buf, p, fieldsEnd, extraStart, bodyEnd, {
        dataOffset: dataStart,
        dataSize,
      })

      if (!entry.isDirectory) {
        if (entry.size > maxEntryBytes) {
          throw new RarError(
            `RAR 項目「${entry.path}」為 ${entry.size} 位元組，超過 ${maxEntryBytes} 的上限`,
            'limit',
          )
        }
        total += entry.size
        if (total > maxBytes) {
          throw new RarError(`RAR 解開後超過 ${maxBytes} 位元組的上限`, 'limit')
        }
      }
      entries.push(entry)
      if (entries.length > maxEntries) {
        throw new RarError(`RAR 項目數超過 ${maxEntries} 的上限`, 'limit')
      }
    }
    // BLOCK.main and BLOCK.service (recovery records, comments, quick-open
    // indexes) carry nothing a listing needs; their data area is skipped by
    // the same arithmetic as everything else.

    if (dataEnd <= at) throw new RarError('RAR 區塊沒有前進，檔案已損壞')
    at = dataEnd
  }

  if (!sawEnd) {
    throw new RarError('RAR 缺少結尾區塊（end of archive），檔案可能被截斷')
  }

  return { entries, sawEnd }
}

/**
 * Read the type-specific part of a file header.
 *
 * @param {Uint8Array} buf
 * @param {number} at first byte after the common header fields
 * @param {number} fieldsEnd exclusive end of the named fields (start of extra area)
 * @param {number} extraStart
 * @param {number} bodyEnd
 * @param {{dataOffset: number, dataSize: number}} data
 * @returns {RarEntry}
 */
function readFileHeader(buf, at, fieldsEnd, extraStart, bodyEnd, data) {
  let p = at
  const fileFlagsRead = readVint(buf, p, fieldsEnd)
  const fileFlags = fileFlagsRead.value
  p = fileFlagsRead.next

  const unpackedRead = readVint(buf, p, fieldsEnd)
  let unpackedSize = unpackedRead.value
  p = unpackedRead.next

  const attrRead = readVint(buf, p, fieldsEnd)
  p = attrRead.next

  let mtime = new Date(0)
  if (fileFlags & FFLAG.mtimeUnix) {
    if (p + 4 > fieldsEnd) throw new RarError('RAR 檔案標頭的時間欄位被截斷')
    mtime = new Date(readU32(buf, p) * 1000)
    p += 4
  }

  /** @type {number|null} */
  let crc = null
  if (fileFlags & FFLAG.crcPresent) {
    if (p + 4 > fieldsEnd) throw new RarError('RAR 檔案標頭的 CRC 欄位被截斷')
    crc = readU32(buf, p)
    p += 4
  }

  const compRead = readVint(buf, p, fieldsEnd)
  const compInfo = compRead.value
  p = compRead.next

  const osRead = readVint(buf, p, fieldsEnd)
  p = osRead.next

  const nameLenRead = readVint(buf, p, fieldsEnd)
  const nameLen = nameLenRead.value
  p = nameLenRead.next
  if (nameLen === 0) throw new RarError('RAR 項目的名稱長度為 0')
  if (nameLen > MAX_NAME_BYTES) {
    throw new RarError(`RAR 項目的名稱長度 ${nameLen} 超過上限`)
  }
  if (p + nameLen > fieldsEnd) throw new RarError('RAR 項目名稱超出標頭範圍')
  const rawName = Buffer.from(buf.subarray(p, p + nameLen)).toString('utf8')

  if (extraStart < bodyEnd) {
    const extra = scanExtraArea(buf, extraStart, bodyEnd)
    if (extra.encrypted) {
      throw new RarError(
        `RAR 項目「${rawName}」已加密，需要密碼才能解開，本版本不支援加密的 RAR`,
        'encrypted',
      )
    }
  }

  const isDirectory = Boolean(fileFlags & FFLAG.directory)
  if (fileFlags & FFLAG.unknownSize) {
    // Without a size there is nothing to bound an allocation with, and for a
    // stored entry the size is the only thing that says where the file ends.
    throw new RarError(`RAR 項目「${rawName}」未宣告解開後的大小，本版本不支援`, 'unsupported')
  }
  if (isDirectory) unpackedSize = 0

  // Compression info packs the format version in bits 0..5, the solid flag in
  // bit 6, the method in bits 7..9 and the dictionary size in bits 10..13.
  const method = (compInfo >> 7) & 0x07
  const solid = Boolean((compInfo >> 6) & 0x01)
  if (solid) {
    throw new RarError(
      `RAR 項目「${rawName}」屬於 solid 區塊，需要先解開前面的項目，本版本不支援`,
      'unsupported',
    )
  }

  return {
    path: normaliseName(rawName),
    size: unpackedSize,
    mtime: mtime.toISOString(),
    isDirectory,
    method,
    crc,
    dataOffset: data.dataOffset,
    dataSize: data.dataSize,
  }
}

/**
 * Reject a name that could escape the extraction root.
 *
 * The same rules as `archive.js`'s `sanitizeEntryPath`, applied here as well
 * as there rather than only there: this module's `parseRar` is callable on its
 * own, and a traversal name should never survive long enough to reach a
 * caller who might not re-check it. RAR stores `/` as the separator, so a
 * literal backslash in a name is a filename character on the machine that
 * packed it and a directory separator on this one — refused, not translated.
 *
 * @param {string} name
 * @returns {string}
 */
function normaliseName(name) {
  if (name.length === 0) throw new RarError('RAR 項目的名稱是空的', 'traversal')
  if (name.includes('\0')) {
    throw new RarError(`RAR 項目名稱含有 NUL 位元組：${name}`, 'traversal')
  }
  if (name.includes('\\')) {
    throw new RarError(`RAR 項目名稱含有反斜線：${name}`, 'traversal')
  }
  if (name.includes('::')) {
    throw new RarError(`RAR 項目名稱含有「::」：${name}`, 'traversal')
  }
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new RarError(`RAR 項目名稱是絕對路徑：${name}`, 'traversal')
  }
  const parts = []
  for (const part of name.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      throw new RarError(`RAR 項目名稱逃出封存根目錄：${name}`, 'traversal')
    }
    parts.push(part)
  }
  if (parts.length === 0) throw new RarError(`RAR 項目名稱解析後是空的：${name}`, 'traversal')
  return parts.join('/')
}

/**
 * Extract one entry's bytes.
 *
 * Only method 0 (STORE) is decoded. Every other method is refused by name,
 * because the alternative — returning the packed bytes, or a best guess at
 * them — is a wrong answer presented as a right one.
 *
 * @param {Uint8Array} buf
 * @param {RarParsed} parsed
 * @param {string} path
 * @param {{maxBytes?: number}} [opts]
 * @returns {Buffer}
 */
export function extractRarEntry(buf, parsed, path, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const entry = parsed.entries.find((e) => e.path === path && !e.isDirectory)
  if (!entry) throw new RarError(`RAR 內找不到項目：${path}`, 'notfound')

  if (entry.method !== METHOD_STORE) {
    const name = METHOD_NAMES[entry.method] ?? `方法 ${entry.method}`
    throw new RarError(
      `RAR 壓縮方法 ${entry.method}（${name}）需要專有解壓演算法，本版本不支援；`
      + '僅支援未壓縮（store）的項目',
      'unsupported',
    )
  }

  if (entry.size > maxBytes) {
    throw new RarError(
      `RAR 項目「${path}」為 ${entry.size} 位元組，超過 ${maxBytes} 的上限`, 'limit',
    )
  }
  // For a stored entry the packed and unpacked lengths are the same thing; a
  // header claiming otherwise is describing bytes that are not there.
  if (entry.dataSize !== entry.size) {
    throw new RarError(
      `RAR 未壓縮項目「${path}」宣告 ${entry.size} 位元組，但資料區有 ${entry.dataSize}`,
    )
  }
  const end = entry.dataOffset + entry.size
  if (end > buf.length) throw new RarError(`RAR 項目「${path}」的資料超出檔案範圍`)

  const out = Buffer.from(buf.subarray(entry.dataOffset, end))
  if (entry.crc !== null && crc32(out) !== entry.crc) {
    throw new RarError(`RAR 項目「${path}」的 CRC32 不符，資料已損壞`)
  }
  return out
}
