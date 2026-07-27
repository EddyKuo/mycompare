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
 *   Three compression types are handled. `NONE` is a copy. `MSZIP` is raw
 *   deflate per block behind a `CK` signature, and each block is compressed
 *   with the previous block's output as its dictionary — which is why blocks
 *   cannot be decoded independently or out of order.
 *
 *   `LZX` is decoded here too (see the block below). It has the same
 *   cross-block continuity property as MSZIP and then some: the whole folder
 *   is one bitstream and one sliding window, so a folder's blocks are even
 *   less separable than MSZIP's.
 *
 *   Quantum is recognised and refused by name rather than mis-decoded, and
 *   the reason has been checked rather than inherited: `makecab` rejects
 *   `CompressionType=QUANTUM`, and a scan of all 42 cabinets under
 *   C:\Windows found only MSZIP and LZX. With no Quantum cabinet obtainable,
 *   a decoder here could only ever be checked against itself, and one that
 *   agrees only with itself is worse than an honest refusal.
 *
 *   Say that carefully, because LZX carried the identical stated reason and
 *   it was simply false — `makecab /D CompressionType=LZX` works. Two more
 *   refusals in this file's history turned out the same way. Before writing
 *   "no tool here can produce one", run the tool.
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
 *   folders: Array<{coffData: number, blocks: number, compress: number, windowBits: number}>,
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
    // The typeCompress word carries the method in its low nibble and, for LZX
    // only, the window size exponent in bits 8..12. Masking the whole word down
    // to the nibble — as this used to — throws away the one number an LZX
    // decoder cannot guess: the window size decides the position-slot count.
    const typeCompress = u16(buf, at + 6)
    folders.push({
      coffData: u32(buf, at),
      blocks: u16(buf, at + 4),
      compress: typeCompress & 0x000f,
      windowBits: (typeCompress >> 8) & 0x1f,
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
 * Walk a folder's CFDATA chain without decompressing anything.
 *
 * Splitting this out is what lets LZX see the whole folder at once: its
 * bitstream runs across every block, and the size of the final frame can only
 * be known once every block header has been read.
 *
 * @param {Uint8Array} buf
 * @param {{coffData: number, blocks: number}} folder
 * @param {{data: number}} reserve
 * @returns {{blocks: Array<{data: Buffer, cbUncomp: number}>, totalUncomp: number}}
 */
function readFolderBlocks(buf, folder, reserve) {
  /** @type {Array<{data: Buffer, cbUncomp: number}>} */
  const blocks = []
  let totalUncomp = 0
  let at = folder.coffData

  for (let i = 0; i < folder.blocks; i++) {
    if (at + 8 > buf.length) throw new CabError('CAB 資料區塊標頭被截斷')
    const csum = u32(buf, at)
    const cbData = u16(buf, at + 4)
    const cbUncomp = u16(buf, at + 6)
    const headerAt = at
    at += 8 + reserve.data
    if (at + cbData > buf.length) throw new CabError('CAB 資料區塊超出檔案範圍')

    // Zero means "no checksum"; a reserved area means the bytes it covers are
    // not established here, so it is not checked rather than checked wrongly.
    // This is the only integrity check a cabinet carries: an LZX block of type
    // "uncompressed" holds the file's bytes verbatim, so damage inside one is
    // otherwise indistinguishable from the file having said that all along.
    if (csum !== 0 && reserve.data === 0) {
      const seed = cabChecksum(buf, headerAt + 4, 4, 0)
      if (cabChecksum(buf, at, cbData, seed) !== csum) {
        throw new CabError(`CAB 資料區塊 ${i} 的檢查碼不符（檔案已損壞）`)
      }
    }

    blocks.push({ data: Buffer.from(buf.subarray(at, at + cbData)), cbUncomp })
    at += cbData
    totalUncomp += cbUncomp
  }

  return { blocks, totalUncomp }
}

/**
 * The cabinet's own block checksum: XOR of the data as 32-bit little-endian
 * words, with any trailing 1–3 bytes folded in from the top down.
 *
 * @param {Uint8Array} buf @param {number} start @param {number} len @param {number} seed
 * @returns {number}
 */
function cabChecksum(buf, start, len, seed) {
  let c = seed >>> 0
  let i = start
  for (let words = len >> 2; words-- > 0; i += 4) c = (c ^ u32(buf, i)) >>> 0
  let tail = 0
  if ((len & 3) === 3) tail |= buf[i++] << 16
  if ((len & 3) >= 2) tail |= buf[i++] << 8
  if ((len & 3) >= 1) tail |= buf[i]
  return (c ^ tail) >>> 0
}

/**
 * Decompress one folder's data blocks into a single buffer.
 *
 * @param {Uint8Array} buf
 * @param {{coffData: number, blocks: number, compress: number, windowBits?: number}} folder
 * @param {{data: number}} reserve
 * @param {number} maxBytes
 * @returns {Buffer}
 */
export function decodeFolder(buf, folder, reserve, maxBytes = DEFAULT_MAX_BYTES) {
  const name = UNSUPPORTED_NAMES[folder.compress]
  if (name) {
    throw new CabError(`CAB 使用了 ${name} 壓縮，此讀取器不支援`, 'unsupported')
  }
  if (folder.compress !== COMPRESS.none &&
      folder.compress !== COMPRESS.mszip &&
      folder.compress !== COMPRESS.lzx) {
    throw new CabError(`CAB 使用了未知的壓縮類型 ${folder.compress}`, 'unsupported')
  }

  const { blocks, totalUncomp } = readFolderBlocks(buf, folder, reserve)

  if (folder.compress === COMPRESS.lzx) {
    return decodeLzxFolder(blocks, totalUncomp, folder.windowBits ?? 0, maxBytes)
  }

  /** @type {Buffer[]} */
  const parts = []
  let total = 0
  /** Previous block's output: MSZIP compresses each block against it. */
  let dictionary = null

  for (const { data: raw, cbUncomp } of blocks) {
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
 * Decode a whole LZX folder.
 *
 * Every block's payload is one slice of a single bitstream, so they are joined
 * before decoding rather than decoded one at a time. The declared uncompressed
 * sizes only supply the total, which is what fixes the length of the final
 * (short) frame.
 *
 * @param {Array<{data: Buffer, cbUncomp: number}>} blocks
 * @param {number} totalUncomp
 * @param {number} windowBits
 * @param {number} maxBytes
 * @returns {Buffer}
 */
function decodeLzxFolder(blocks, totalUncomp, windowBits, maxBytes) {
  // The window exponent comes from the cabinet, i.e. from an attacker, so it is
  // range-checked before anything is sized from it. 15..21 caps the window at
  // 2 MiB, and the output ceiling is applied before allocating the output.
  if (windowBits < LZX_MIN_WINDOW_BITS || windowBits > LZX_MAX_WINDOW_BITS) {
    throw new CabError(`LZX 視窗大小 2^${windowBits} 不在允許範圍（2^15–2^21）`, 'unsupported')
  }
  for (const b of blocks) {
    if (b.cbUncomp === 0 || b.cbUncomp > LZX_FRAME_SIZE) {
      throw new CabError(`LZX 區塊宣告的解壓長度 ${b.cbUncomp} 不合法`)
    }
  }
  if (totalUncomp > maxBytes) {
    throw new CabError('CAB 解壓縮結果超過允許的大小上限', 'limit')
  }

  const input = blocks.length === 1 ? blocks[0].data : Buffer.concat(blocks.map((b) => b.data))
  const out = lzxDecompress(input, totalUncomp, windowBits)

  // Each CFDATA is exactly one LZX frame, so a folder whose blocks do not line
  // up on frame boundaries is malformed even though the total may add up.
  let seen = 0
  for (let i = 0; i < blocks.length; i++) {
    const expect = i === blocks.length - 1 ? totalUncomp - seen : LZX_FRAME_SIZE
    if (blocks[i].cbUncomp !== expect) {
      throw new CabError(
        `LZX 區塊 ${i} 宣告 ${blocks[i].cbUncomp} 位元組，但 frame 邊界要求 ${expect}`)
    }
    seen += blocks[i].cbUncomp
  }

  return out
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

/* ------------------------------------------------------------------------- *
 *  LZX
 *
 *  Structure follows Stuart Caie's libmspack `lzxd.c`, which is the reference
 *  everyone else checks against; Microsoft's own LZX document disagrees with
 *  Microsoft's own implementation in at least four places (aligned-offset tree
 *  ordering, the extra_bits == 3 case, the uncompressed block's length field,
 *  and the position-slot table for 1 MiB and 2 MiB windows). Where they
 *  differ, the implementation wins, because that is what `makecab` emits.
 *
 *  Things that are easy to get backwards, spelled out:
 *   - the bitstream is a run of 16-bit little-endian words, and bits are taken
 *     from each word most-significant first;
 *   - the trees persist across blocks. A block header carries a *delta* against
 *     the lengths left over from the previous block, so decoding block N
 *     requires having decoded block N-1's header. Single-block input never
 *     shows this;
 *   - the window and the repeated-offset queue also persist across blocks and
 *     across CFDATA boundaries — a folder is one continuous stream;
 *   - the input is re-aligned to a 16-bit boundary at the end of every 32 KiB
 *     frame, which is invisible until a frame's last symbol ends mid-word.
 * ------------------------------------------------------------------------- */

/** LZX emits output in fixed 32 KiB frames; a CAB data block is one frame. */
const LZX_FRAME_SIZE = 32768

/** Window exponents LZX-in-CAB permits. Anything else is refused, not clamped. */
const LZX_MIN_WINDOW_BITS = 15
const LZX_MAX_WINDOW_BITS = 21

/** Literal symbols occupy the bottom of the main tree; matches follow. */
const LZX_NUM_CHARS = 256

/** Match lengths 0..6 ride in the main symbol; 7 means "read the length tree". */
const LZX_NUM_PRIMARY_LENGTHS = 7

/** Length tree element count. The table is built for 250 with the last unused. */
const LZX_NUM_SECONDARY_LENGTHS = 249

/** Shortest match LZX can encode. */
const LZX_MIN_MATCH = 2

/** Pre-tree used to delta-code the other trees' lengths. */
const LZX_PRETREE_ELEMENTS = 20

/** Aligned-offset tree: eight symbols, lengths stored raw in 3 bits each. */
const LZX_ALIGNED_ELEMENTS = 8

/** Longest Huffman code LZX allows. */
const LZX_MAX_CODE_BITS = 16

/** Run codes may write past the requested range; libmspack calls this slop. */
const LZX_LENTABLE_SAFETY = 64

/** Position slots per window exponent, indexed by windowBits - 15. */
const LZX_POSITION_SLOTS = Object.freeze([30, 32, 34, 36, 38, 42, 50])

/** Block types. 0 is never valid. */
const LZX_BLOCK_VERBATIM = 1
const LZX_BLOCK_ALIGNED = 2
const LZX_BLOCK_UNCOMPRESSED = 3

/** extra_bits[i] = 0 (i<4), floor(i/2)-1 (4<=i<36), 17 (i>=36). */
const LZX_EXTRA_BITS = (() => {
  const t = new Uint8Array(51)
  for (let i = 0; i < t.length; i++) t[i] = i < 4 ? 0 : i >= 36 ? 17 : (i >> 1) - 1
  return t
})()

/** position_base[0] = 0; position_base[i] = prev + (1 << extra_bits[i-1]). */
const LZX_POSITION_BASE = (() => {
  const t = new Uint32Array(51)
  for (let i = 1; i < t.length; i++) t[i] = t[i - 1] + (1 << LZX_EXTRA_BITS[i - 1])
  return t
})()

/** Powers of two as exact doubles, so the bit buffer can exceed 31 bits. */
const POW2 = (() => {
  const t = new Float64Array(34)
  for (let i = 0; i < t.length; i++) t[i] = 2 ** i
  return t
})()

/**
 * The LZX bitstream: 16-bit little-endian words, MSB-first inside each word.
 *
 * The buffer is held as a plain number rather than a 32-bit integer because it
 * legitimately reaches 32 valid bits when a 17-bit read tops up a 16-bit
 * remainder, and `<<` in JavaScript would quietly lose the top bit there.
 */
class LzxBitReader {
  /** @param {Buffer} input */
  constructor(input) {
    /** @type {Buffer} */
    this.input = input
    /** Byte cursor. Bits already buffered have been consumed from here. */
    this.pos = 0
    /** Buffered bits, right-aligned; the next bit is the highest of `cnt`. */
    this.buf = 0
    /** How many bits in `buf` are valid. */
    this.cnt = 0
    /** Zero bytes invented past the end of input. Two are legal; more is not. */
    this.padded = 0
  }

  /** @returns {number} the next byte, or a counted zero past the end. */
  nextByte() {
    if (this.pos < this.input.length) return this.input[this.pos++]
    // A decoder is allowed to look slightly past the end because it always
    // tops the buffer up to 16 bits before decoding a symbol, even when the
    // symbol needs fewer. Beyond that slack the stream really has run out.
    if (++this.padded > 2) {
      throw new CabError('LZX 位元流讀取超出資料結尾（檔案被截斷或損壞）')
    }
    return 0
  }

  /** @param {number} n */
  ensure(n) {
    while (this.cnt < n) {
      const b0 = this.nextByte()
      const b1 = this.nextByte()
      this.buf = this.buf * 65536 + ((b1 << 8) | b0)
      this.cnt += 16
    }
  }

  /** @param {number} n @returns {number} */
  peek(n) {
    return Math.floor(this.buf / POW2[this.cnt - n])
  }

  /** @param {number} n */
  drop(n) {
    this.cnt -= n
    this.buf %= POW2[this.cnt]
  }

  /** @param {number} n @returns {number} */
  read(n) {
    if (n === 0) return 0
    this.ensure(n)
    const v = this.peek(n)
    this.drop(n)
    return v
  }

  /**
   * End-of-frame re-alignment. Buffered bits are topped up to a whole word and
   * the partial remainder discarded, so the next frame starts on a word.
   */
  alignFrame() {
    if (this.cnt > 0) this.ensure(16)
    if (this.cnt & 15) this.drop(this.cnt & 15)
  }

  /** Abandon the bit buffer and continue reading whole bytes at `pos`. */
  dropToByteStream() {
    if (this.cnt === 0) this.ensure(16)
    this.cnt = 0
    this.buf = 0
  }

  /** @param {number} n @returns {Buffer} raw bytes, bypassing the bit buffer. */
  rawBytes(n) {
    if (this.pos + n > this.input.length) {
      throw new CabError('LZX 未壓縮區塊超出資料結尾（檔案被截斷或損壞）')
    }
    const out = this.input.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  /** Skip the pad byte an odd-length uncompressed block leaves behind. */
  skipByte() {
    if (this.pos < this.input.length) this.pos++
    else if (++this.padded > 2) {
      throw new CabError('LZX 位元流讀取超出資料結尾（檔案被截斷或損壞）')
    }
  }
}

/**
 * A canonical Huffman decoder built from code lengths.
 *
 * Completeness is enforced: libmspack's table builder rejects both an
 * over-subscribed and an under-subscribed tree, and so does this. The single
 * exception is an entirely empty length tree, which real cabinets do contain
 * whenever a block happens to hold no matches.
 */
class LzxHuffman {
  /**
   * @param {Uint8Array} lens
   * @param {number} nsyms
   * @param {boolean} [allowEmpty]
   */
  constructor(lens, nsyms, allowEmpty = false) {
    const counts = new Int32Array(LZX_MAX_CODE_BITS + 1)
    let used = 0
    for (let s = 0; s < nsyms; s++) {
      const l = lens[s]
      if (l > LZX_MAX_CODE_BITS) throw new CabError(`LZX Huffman 碼長 ${l} 超過 16`)
      if (l > 0) { counts[l]++; used++ }
    }

    /** @type {boolean} */
    this.empty = used === 0
    /** @type {Int32Array} */
    this.counts = counts
    /** @type {Int32Array} */
    this.symbols = new Int32Array(0)
    if (this.empty) {
      if (!allowEmpty) throw new CabError('LZX Huffman 樹是空的，但此處不允許')
      return
    }

    let left = 1
    for (let l = 1; l <= LZX_MAX_CODE_BITS; l++) {
      left = (left << 1) - counts[l]
      if (left < 0) throw new CabError('LZX Huffman 樹的碼長過度分配')
    }
    if (left > 0) throw new CabError('LZX Huffman 樹不完整')

    const offsets = new Int32Array(LZX_MAX_CODE_BITS + 2)
    for (let l = 1; l <= LZX_MAX_CODE_BITS; l++) offsets[l + 1] = offsets[l] + counts[l]
    const symbols = new Int32Array(used)
    for (let s = 0; s < nsyms; s++) {
      if (lens[s] > 0) symbols[offsets[lens[s]]++] = s
    }
    this.symbols = symbols
  }

  /** @param {LzxBitReader} bits @returns {number} */
  decode(bits) {
    if (this.empty) throw new CabError('LZX 需要一個符號，但該 Huffman 樹是空的')
    bits.ensure(LZX_MAX_CODE_BITS)
    const lookahead = bits.peek(LZX_MAX_CODE_BITS)
    let first = 0
    let index = 0
    for (let len = 1; len <= LZX_MAX_CODE_BITS; len++) {
      const code = lookahead >>> (LZX_MAX_CODE_BITS - len)
      const count = this.counts[len]
      if (code - first < count) {
        bits.drop(len)
        return this.symbols[index + code - first]
      }
      index += count
      first = (first + count) << 1
    }
    throw new CabError('LZX 位元流中出現無效的 Huffman 碼')
  }
}

/**
 * Read one tree's code lengths, which are a delta against the lengths already
 * held. This is why trees persist: `lens` comes in holding the previous
 * block's values and is modified in place.
 *
 * @param {LzxBitReader} bits
 * @param {Uint8Array} lens
 * @param {number} first
 * @param {number} last
 */
function lzxReadLens(bits, lens, first, last) {
  const preLens = new Uint8Array(LZX_PRETREE_ELEMENTS)
  for (let x = 0; x < LZX_PRETREE_ELEMENTS; x++) preLens[x] = bits.read(4)
  const pre = new LzxHuffman(preLens, LZX_PRETREE_ELEMENTS)

  let x = first
  while (x < last) {
    let z = pre.decode(bits)
    if (z === 17) {
      let y = bits.read(4) + 4
      while (y-- > 0) lens[x++] = 0
    } else if (z === 18) {
      let y = bits.read(5) + 20
      while (y-- > 0) lens[x++] = 0
    } else if (z === 19) {
      let y = bits.read(1) + 4
      z = pre.decode(bits)
      z = lens[x] - z
      if (z < 0) z += 17
      while (y-- > 0) lens[x++] = z
    } else {
      z = lens[x] - z
      if (z < 0) z += 17
      lens[x++] = z
    }
    // Runs may legitimately overshoot `last`; they may not overshoot the slop
    // libmspack reserves for exactly that, which is where corruption shows up.
    if (x >= lens.length) throw new CabError('LZX 樹的碼長編碼超出表格範圍')
  }
}

/**
 * Undo the x86 call translation over one frame, in place.
 *
 * The encoder rewrote the operand of every `E8` (near call) from relative to
 * absolute so that repeated calls to the same target compress; this puts them
 * back. `curpos` is the frame's start offset in the output, which is why this
 * cannot be done on the concatenated output afterwards without tracking it.
 *
 * @param {Buffer} frame
 * @param {number} frameStart
 * @param {number} filesize
 */
function lzxUndoE8(frame, frameStart, filesize) {
  const end = frame.length - 10
  let curpos = frameStart
  let d = 0
  while (d < end) {
    if (frame[d++] !== 0xe8) { curpos++; continue }
    const absOff = frame.readInt32LE(d)
    if (absOff >= -curpos && absOff < filesize) {
      const relOff = absOff >= 0 ? absOff - curpos : absOff + filesize
      frame.writeInt32LE(relOff | 0, d)
    }
    d += 4
    curpos += 5
  }
}

/**
 * Decode a complete LZX stream.
 *
 * @param {Buffer} input concatenated CFDATA payloads for one folder
 * @param {number} outputLength total uncompressed size of the folder
 * @param {number} windowBits window exponent, already range-checked
 * @returns {Buffer}
 */
function lzxDecompress(input, outputLength, windowBits) {
  const windowSize = 1 << windowBits
  const window = Buffer.alloc(windowSize)
  const out = Buffer.alloc(outputLength)
  const bits = new LzxBitReader(input)

  const numOffsets = LZX_POSITION_SLOTS[windowBits - LZX_MIN_WINDOW_BITS] << 3
  const mainSymbols = LZX_NUM_CHARS + numOffsets

  const mainLens = new Uint8Array(mainSymbols + LZX_LENTABLE_SAFETY)
  const lengthLens = new Uint8Array(LZX_NUM_SECONDARY_LENGTHS + 1 + LZX_LENTABLE_SAFETY)
  const alignedLens = new Uint8Array(LZX_ALIGNED_ELEMENTS)

  /** @type {LzxHuffman|null} */
  let mainTree = null
  /** @type {LzxHuffman|null} */
  let lengthTree = null
  /** @type {LzxHuffman|null} */
  let alignedTree = null

  let windowPosn = 0
  let framePosn = 0
  let frame = 0
  let offset = 0
  let r0 = 1
  let r1 = 1
  let r2 = 1
  let headerRead = false
  let intelFilesize = 0
  let intelStarted = false
  let blockType = 0
  let blockLength = 0
  let blockRemaining = 0

  while (offset < outputLength) {
    if (!headerRead) {
      // One bit, then — only if set — a 32-bit E8 translation size, sent as
      // two 16-bit halves, high half first.
      let hi = 0
      let lo = 0
      if (bits.read(1)) { hi = bits.read(16); lo = bits.read(16) }
      intelFilesize = (hi * 65536 + lo) | 0
      headerRead = true
    }

    const frameSize = Math.min(LZX_FRAME_SIZE, outputLength - offset)
    let bytesTodo = framePosn + frameSize - windowPosn

    while (bytesTodo > 0) {
      if (blockRemaining === 0) {
        // An odd-length uncompressed block leaves one pad byte behind.
        if (blockType === LZX_BLOCK_UNCOMPRESSED && (blockLength & 1)) bits.skipByte()

        blockType = bits.read(3)
        blockLength = bits.read(16) * 256 + bits.read(8)
        blockRemaining = blockLength

        if (blockType === LZX_BLOCK_ALIGNED) {
          for (let i = 0; i < LZX_ALIGNED_ELEMENTS; i++) alignedLens[i] = bits.read(3)
          alignedTree = new LzxHuffman(alignedLens, LZX_ALIGNED_ELEMENTS)
        }

        if (blockType === LZX_BLOCK_ALIGNED || blockType === LZX_BLOCK_VERBATIM) {
          lzxReadLens(bits, mainLens, 0, LZX_NUM_CHARS)
          lzxReadLens(bits, mainLens, LZX_NUM_CHARS, mainSymbols)
          mainTree = new LzxHuffman(mainLens, mainSymbols)
          // If 0xE8 can appear as a literal at all, the frame may need the
          // call translation undone. Frames before the first such block never
          // do, and translating them would corrupt them.
          if (mainLens[0xe8] !== 0) intelStarted = true
          lzxReadLens(bits, lengthLens, 0, LZX_NUM_SECONDARY_LENGTHS)
          lengthTree = new LzxHuffman(lengthLens, LZX_NUM_SECONDARY_LENGTHS + 1, true)
        } else if (blockType === LZX_BLOCK_UNCOMPRESSED) {
          intelStarted = true
          bits.dropToByteStream()
          const q = bits.rawBytes(12)
          r0 = q.readUInt32LE(0)
          r1 = q.readUInt32LE(4)
          r2 = q.readUInt32LE(8)
        } else {
          throw new CabError(`LZX 區塊類型 ${blockType} 不合法`)
        }
      }

      let thisRun = Math.min(blockRemaining, bytesTodo)
      bytesTodo -= thisRun
      blockRemaining -= thisRun

      if (blockType === LZX_BLOCK_UNCOMPRESSED) {
        bits.rawBytes(thisRun).copy(window, windowPosn)
        windowPosn += thisRun
        thisRun = 0
      } else {
        const main = /** @type {LzxHuffman} */ (mainTree)
        while (thisRun > 0) {
          let symbol = main.decode(bits)
          if (symbol < LZX_NUM_CHARS) {
            window[windowPosn++] = symbol
            thisRun--
            continue
          }

          symbol -= LZX_NUM_CHARS
          let matchLength = symbol & LZX_NUM_PRIMARY_LENGTHS
          if (matchLength === LZX_NUM_PRIMARY_LENGTHS) {
            matchLength += /** @type {LzxHuffman} */ (lengthTree).decode(bits)
          }
          matchLength += LZX_MIN_MATCH

          let matchOffset = symbol >> 3
          if (matchOffset === 0) {
            matchOffset = r0
          } else if (matchOffset === 1) {
            matchOffset = r1; r1 = r0; r0 = matchOffset
          } else if (matchOffset === 2) {
            matchOffset = r2; r2 = r0; r0 = matchOffset
          } else {
            if (matchOffset >= LZX_POSITION_BASE.length) {
              throw new CabError(`LZX 位置槽 ${matchOffset} 超出視窗允許的範圍`)
            }
            const extra = matchOffset >= 36 ? 17 : LZX_EXTRA_BITS[matchOffset]
            matchOffset = LZX_POSITION_BASE[matchOffset] - 2
            if (extra >= 3 && blockType === LZX_BLOCK_ALIGNED) {
              // The low three bits of the offset come from the aligned tree,
              // not from the raw bitstream. Reading them as raw bits is the
              // classic way an aligned block decodes into plausible garbage.
              if (extra > 3) matchOffset += bits.read(extra - 3) * 8
              matchOffset += /** @type {LzxHuffman} */ (alignedTree).decode(bits)
            } else if (extra) {
              matchOffset += bits.read(extra)
            }
            r2 = r1; r1 = r0; r0 = matchOffset
          }

          if (matchOffset <= 0 || matchOffset > windowSize) {
            throw new CabError(`LZX match offset ${matchOffset} 超出視窗範圍`)
          }
          if (windowPosn + matchLength > windowSize) {
            throw new CabError('LZX match 跨過視窗結尾')
          }
          if (matchOffset > windowPosn && matchOffset - windowPosn > offset + windowPosn) {
            throw new CabError('LZX match 指向串流開始之前')
          }

          // Byte at a time on purpose: LZX matches may overlap themselves
          // (offset 1, length 200 is a run), so a block copy is wrong.
          let src = windowPosn - matchOffset
          if (src < 0) src += windowSize
          for (let i = 0; i < matchLength; i++) {
            window[windowPosn++] = window[src++]
            if (src === windowSize) src = 0
          }

          thisRun -= matchLength
        }
      }

      // A match may reach past the end of the requested run, which is legal so
      // long as it stays inside the block.
      if (thisRun < 0) {
        if (-thisRun > blockRemaining) throw new CabError('LZX match 超出區塊宣告的長度')
        blockRemaining += thisRun
      }
    }

    if (windowPosn - framePosn !== frameSize) {
      throw new CabError('LZX 解出的資料越過了 frame 邊界')
    }

    bits.alignFrame()

    let frameBuf = window.subarray(framePosn, framePosn + frameSize)
    if (intelStarted && intelFilesize !== 0 && frame < 32768 && frameSize > 10) {
      // Translated into a copy: the window is still the match dictionary and
      // must keep the untranslated bytes.
      frameBuf = Buffer.from(frameBuf)
      lzxUndoE8(frameBuf, offset, intelFilesize)
    }
    frameBuf.copy(out, offset)

    offset += frameSize
    framePosn += frameSize
    frame++
    if (windowPosn === windowSize) windowPosn = 0
    if (framePosn === windowSize) framePosn = 0
  }

  return out
}
