/**
 * @file bzip2.js
 * @description Pure-JavaScript bzip2 decompressor (decode only).
 *
 *   Node ships zlib but nothing for bzip2, and this project forbids new npm
 *   dependencies, so `.bz2` containers were previously reported as
 *   `unsupported`. The format is a published specification and its decode side
 *   is small enough to carry in-tree; the encode side (the suffix sort) is the
 *   expensive half and is not needed to browse an archive.
 *
 *   Every byte handled here comes from a file the user did not write, so the
 *   decoder is written defensively: each length, index and table lookup is
 *   range-checked before use, and the output is capped, because both the
 *   Huffman stage and the inverse BWT can be steered into unbounded loops or
 *   out-of-range reads by hand-crafted input.
 *
 *   Pipeline (compressor order, so decoding runs bottom-up):
 *     original bytes → RLE1 → BWT → MTF+RLE2 → Huffman → bits
 */

/** Error thrown for every bzip2 problem, mirroring ArchiveError's shape. */
export class Bzip2Error extends Error {
  /**
   * @param {string} message
   * @param {'corrupt'|'limit'|'unsupported'} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'Bzip2Error'
    this.code = code
  }
}

/** Fallback cap; archive.js always passes its own {@link DEFAULT_LIMITS}-derived value. */
export const DEFAULT_MAX_OUTPUT = 512 * 1024 * 1024

const BLOCK_MAGIC_HI = 0x314159
const BLOCK_MAGIC_LO = 0x265359
const EOS_MAGIC_HI = 0x177245
const EOS_MAGIC_LO = 0x385090

/** Symbols per Huffman selector group, fixed by the format. */
const GROUP_SIZE = 50
const MIN_GROUPS = 2
const MAX_GROUPS = 6
/** Code lengths are delta-coded from a 5-bit seed and must stay in [1, 20]. */
const MAX_CODE_LEN = 23
const MAX_SYMBOL_LEN = 20

const OUT_CHUNK = 64 * 1024

/**
 * bzip2 uses a CRC-32 variant that differs from zlib's: the same polynomial
 * (0x04C11DB7) but processed most-significant-bit first with no input/output
 * reflection. Reusing a stock zlib CRC here would silently reject every valid
 * file, which is why the table is built locally rather than imported.
 *
 * @type {Int32Array}
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 24
    for (let bit = 0; bit < 8; bit++) {
      c = (c & 0x80000000) !== 0 ? (c << 1) ^ 0x04c11db7 : c << 1
    }
    table[i] = c
  }
  return table
})()

/** MSB-first bit reader over a byte buffer. */
class BitReader {
  /** @param {Buffer|Uint8Array} buf */
  constructor(buf) {
    this.buf = buf
    /** byte index of the next byte to pull into the accumulator */
    this.pos = 0
    /** accumulator; only the low {@link bitCount} bits are meaningful */
    this.bitBuf = 0
    this.bitCount = 0
  }

  /**
   * @param {number} n 1..24 — the accumulator is a 32-bit int, and refilling
   *        never pushes it past 31 live bits at this width
   * @returns {number}
   */
  read(n) {
    while (this.bitCount < n) {
      if (this.pos >= this.buf.length) {
        throw new Bzip2Error('Truncated bzip2 stream: ran out of bits', 'corrupt')
      }
      this.bitBuf = (this.bitBuf << 8) | this.buf[this.pos++]
      this.bitCount += 8
    }
    this.bitCount -= n
    const value = (this.bitBuf >>> this.bitCount) & (n === 32 ? -1 : (1 << n) - 1)
    // Drop the consumed high bits so the accumulator never overflows 31 bits.
    this.bitBuf &= (1 << this.bitCount) - 1
    return value >>> 0
  }

  /** @returns {number} 0 or 1 */
  readBit() {
    return this.read(1)
  }

  /** @returns {number} unsigned 32-bit value */
  read32() {
    return ((this.read(16) << 16) | this.read(16)) >>> 0
  }

  /** Discard the partial byte so a following stream starts byte-aligned. */
  alignToByte() {
    this.bitCount = 0
    this.bitBuf = 0
  }

  /** @returns {number} bytes not yet pulled into the accumulator */
  bytesRemaining() {
    return this.buf.length - this.pos
  }
}

/**
 * Growable byte sink that also maintains the running block CRC.
 *
 * The cap is enforced on every write rather than at the end: a bzip2 bomb's
 * RLE1 layer can turn a handful of block bytes into gigabytes, so refusing
 * after the fact would already have exhausted memory.
 */
class OutputSink {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    /** @type {Buffer[]} */
    this.chunks = []
    this.buf = Buffer.allocUnsafe(OUT_CHUNK)
    this.used = 0
    this.total = 0
    this.crc = 0xffffffff
  }

  /** Restart the per-block CRC accumulator. */
  resetCrc() {
    this.crc = 0xffffffff
  }

  /** @returns {number} the finished CRC for the current block */
  finishCrc() {
    return (this.crc ^ 0xffffffff) >>> 0
  }

  /**
   * @param {number} byte
   * @param {number} count
   */
  write(byte, count) {
    if (count <= 0) return
    if (this.total + count > this.maxBytes) {
      throw new Bzip2Error(
        `bzip2 stream expands past the ${this.maxBytes} byte limit`,
        'limit',
      )
    }
    this.total += count
    let crc = this.crc
    for (let i = 0; i < count; i++) {
      if (this.used === this.buf.length) {
        this.chunks.push(this.buf)
        this.buf = Buffer.allocUnsafe(OUT_CHUNK)
        this.used = 0
      }
      this.buf[this.used++] = byte
      crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0
    }
    this.crc = crc
  }

  /** @returns {Buffer} */
  finish() {
    this.chunks.push(this.buf.subarray(0, this.used))
    return Buffer.concat(this.chunks, this.total)
  }
}

/**
 * @typedef {Object} HuffTable
 * @property {number} minLen
 * @property {number} maxLen
 * @property {Int32Array} limit  largest code value of each length
 * @property {Int32Array} base   offset subtracted from a code to index `perm`
 * @property {Int32Array} perm   symbols in canonical (length, symbol) order
 */

/**
 * Build the limit/base/perm triple used for canonical Huffman decoding.
 *
 * The tables let the decoder consume `minLen` bits up front and then extend one
 * bit at a time, comparing against `limit[len]`, instead of walking a tree —
 * the same shape bzip2's own `hbCreateDecodeTables` produces.
 *
 * @param {Uint8Array} lengths code length per symbol
 * @param {number} alphaSize
 * @returns {HuffTable}
 */
function buildHuffTable(lengths, alphaSize) {
  let minLen = MAX_SYMBOL_LEN
  let maxLen = 1
  for (let i = 0; i < alphaSize; i++) {
    if (lengths[i] > maxLen) maxLen = lengths[i]
    if (lengths[i] < minLen) minLen = lengths[i]
  }

  const perm = new Int32Array(alphaSize)
  let pp = 0
  for (let len = minLen; len <= maxLen; len++) {
    for (let sym = 0; sym < alphaSize; sym++) {
      if (lengths[sym] === len) perm[pp++] = sym
    }
  }

  const base = new Int32Array(MAX_CODE_LEN + 2)
  const limit = new Int32Array(MAX_CODE_LEN + 2)
  for (let i = 0; i < alphaSize; i++) base[lengths[i] + 1]++
  for (let i = 1; i < base.length; i++) base[i] += base[i - 1]

  let vec = 0
  for (let len = minLen; len <= maxLen; len++) {
    vec += base[len + 1] - base[len]
    limit[len] = vec - 1
    vec <<= 1
  }
  for (let len = minLen + 1; len <= maxLen; len++) {
    base[len] = ((limit[len - 1] + 1) << 1) - base[len]
  }

  return { minLen, maxLen, limit, base, perm }
}

/**
 * @param {BitReader} br
 * @param {HuffTable} table
 * @param {number} alphaSize
 * @returns {number} the decoded symbol
 */
function decodeSymbol(br, table, alphaSize) {
  let len = table.minLen
  let code = br.read(len)
  // A corrupt table can describe an over-subscribed code where no length ever
  // satisfies the limit test; capping at maxLen turns that into an error
  // instead of a read loop that runs off the end of the buffer.
  while (len > table.maxLen || code > table.limit[len]) {
    len++
    if (len > table.maxLen) {
      throw new Bzip2Error('Corrupt bzip2 block: undecodable Huffman code', 'corrupt')
    }
    code = ((code << 1) | br.readBit()) >>> 0
  }
  const index = code - table.base[len]
  if (index < 0 || index >= alphaSize) {
    throw new Bzip2Error('Corrupt bzip2 block: Huffman code out of range', 'corrupt')
  }
  return table.perm[index]
}

/**
 * Read the 16+16-bit sparse map of which byte values occur in this block.
 *
 * @param {BitReader} br
 * @returns {Uint8Array} the used byte values, ascending
 */
function readSymbolMap(br) {
  const used = new Uint8Array(256)
  const groupsUsed = br.read(16)
  let count = 0
  for (let group = 0; group < 16; group++) {
    if ((groupsUsed & (0x8000 >>> group)) === 0) continue
    const bits = br.read(16)
    for (let bit = 0; bit < 16; bit++) {
      if ((bits & (0x8000 >>> bit)) !== 0) used[count++] = group * 16 + bit
    }
  }
  if (count === 0) {
    throw new Bzip2Error('Corrupt bzip2 block: empty symbol map', 'corrupt')
  }
  return used.subarray(0, count)
}

/**
 * Read the per-group table selectors.
 *
 * Neighbouring groups overwhelmingly reuse the same Huffman table, so the
 * encoder stores the selector sequence move-to-front coded, turning long runs
 * of "same table as last time" into a stream of zeroes that the unary code
 * below spends a single bit on. Skipping this MTF inversion yields a decoder
 * that works only on files with one Huffman table.
 *
 * @param {BitReader} br
 * @param {number} nGroups
 * @param {number} nSelectors
 * @returns {Uint8Array}
 */
function readSelectors(br, nGroups, nSelectors) {
  const selectors = new Uint8Array(nSelectors)
  const pos = new Uint8Array(nGroups)
  for (let i = 0; i < nGroups; i++) pos[i] = i

  for (let i = 0; i < nSelectors; i++) {
    let j = 0
    while (br.readBit() === 1) {
      j++
      if (j >= nGroups) {
        throw new Bzip2Error('Corrupt bzip2 block: selector index out of range', 'corrupt')
      }
    }
    const chosen = pos[j]
    for (let k = j; k > 0; k--) pos[k] = pos[k - 1]
    pos[0] = chosen
    selectors[i] = chosen
  }
  return selectors
}

/**
 * @param {BitReader} br
 * @param {number} nGroups
 * @param {number} alphaSize
 * @returns {HuffTable[]}
 */
function readHuffTables(br, nGroups, alphaSize) {
  /** @type {HuffTable[]} */
  const tables = []
  for (let t = 0; t < nGroups; t++) {
    const lengths = new Uint8Array(alphaSize)
    // Lengths are delta-coded against the previous symbol's length, which is
    // why a single out-of-range value poisons the rest of the table; validate
    // on every step rather than once at the end.
    let curr = br.read(5)
    for (let i = 0; i < alphaSize; i++) {
      for (;;) {
        if (curr < 1 || curr > MAX_SYMBOL_LEN) {
          throw new Bzip2Error('Corrupt bzip2 block: Huffman code length out of range', 'corrupt')
        }
        if (br.readBit() === 0) break
        if (br.readBit() === 0) curr++
        else curr--
      }
      lengths[i] = curr
    }
    tables.push(buildHuffTable(lengths, alphaSize))
  }
  return tables
}

/**
 * Decode one block's MTF+RLE2 layer into the BWT column `tt`.
 *
 * @param {BitReader} br
 * @param {HuffTable[]} tables
 * @param {Uint8Array} selectors
 * @param {Uint8Array} symMap
 * @param {Uint32Array} tt destination; low 8 bits of each slot receive a byte
 * @param {Int32Array} counts per-byte occurrence tally, zeroed by the caller
 * @returns {number} number of bytes written to `tt`
 */
function decodeMtfRle2(br, tables, selectors, symMap, tt, counts) {
  const symCount = symMap.length
  const alphaSize = symCount + 2
  const eob = alphaSize - 1
  const limit = tt.length

  // The MTF list starts as the used byte values in ascending order.
  const mtf = Uint8Array.from(symMap)

  let groupNo = -1
  let groupPos = 0
  /** @type {HuffTable} */
  let table = tables[0]

  const nextSymbol = () => {
    if (groupPos === 0) {
      groupNo++
      if (groupNo >= selectors.length) {
        throw new Bzip2Error('Corrupt bzip2 block: selector list exhausted', 'corrupt')
      }
      groupPos = GROUP_SIZE
      table = tables[selectors[groupNo]]
      if (!table) {
        throw new Bzip2Error('Corrupt bzip2 block: selector names a missing table', 'corrupt')
      }
    }
    groupPos--
    return decodeSymbol(br, table, alphaSize)
  }

  let n = 0
  let runLength = 0
  let runBit = 0
  let sym = nextSymbol()

  const flushRun = () => {
    if (runLength === 0) return
    const byte = mtf[0]
    if (n + runLength > limit) {
      throw new Bzip2Error('Corrupt bzip2 block: run overflows the block size', 'corrupt')
    }
    counts[byte] += runLength
    for (let i = 0; i < runLength; i++) tt[n++] = byte
    runLength = 0
    runBit = 0
  }

  while (sym !== eob) {
    if (sym === 0 || sym === 1) {
      // RUNA/RUNB form a bijective base-2 numeral: each contributes 1 or 2
      // scaled by its position, so a run of the current MTF-front byte costs
      // O(log n) symbols instead of n.
      runLength += (sym === 0 ? 1 : 2) << runBit
      runBit++
      if (runBit > 30) {
        throw new Bzip2Error('Corrupt bzip2 block: run length overflow', 'corrupt')
      }
      sym = nextSymbol()
      continue
    }

    flushRun()

    const index = sym - 1
    if (index < 1 || index >= symCount) {
      // index 0 is unreachable: MTF value 0 is always coded as RUNA/RUNB.
      throw new Bzip2Error('Corrupt bzip2 block: MTF index out of range', 'corrupt')
    }
    const byte = mtf[index]
    for (let k = index; k > 0; k--) mtf[k] = mtf[k - 1]
    mtf[0] = byte

    if (n >= limit) {
      throw new Bzip2Error('Corrupt bzip2 block: more data than the block size allows', 'corrupt')
    }
    counts[byte]++
    tt[n++] = byte
    sym = nextSymbol()
  }
  flushRun()

  if (n === 0) {
    throw new Bzip2Error('Corrupt bzip2 block: block is empty', 'corrupt')
  }
  return n
}

/**
 * Invert the Burrows-Wheeler transform in place over `tt`.
 *
 * The compressor sorted every rotation of the block and kept only the last
 * column (which groups equal bytes together, making MTF+RLE2 effective) plus
 * `origPtr`, the row that held the original text. Recovery works because the
 * first column is just the last column sorted, so a stable rank mapping from
 * each position to its predecessor can be built from byte counts alone. That
 * mapping is packed into the free upper 24 bits of `tt`, which is safe only
 * because a block never exceeds 900 000 entries.
 *
 * @param {Uint32Array} tt
 * @param {number} n number of live entries in `tt`
 * @param {Int32Array} counts per-byte tallies from {@link decodeMtfRle2}
 * @param {number} origPtr
 * @returns {number} the starting position for the output walk
 */
function inverseBwt(tt, n, counts, origPtr) {
  if (origPtr < 0 || origPtr >= n) {
    throw new Bzip2Error('Corrupt bzip2 block: BWT pointer outside the block', 'corrupt')
  }

  const cumulative = new Int32Array(256)
  let running = 0
  for (let i = 0; i < 256; i++) {
    cumulative[i] = running
    running += counts[i]
  }
  if (running !== n) {
    throw new Bzip2Error('Corrupt bzip2 block: byte tallies disagree with block length', 'corrupt')
  }

  for (let i = 0; i < n; i++) {
    const byte = tt[i] & 0xff
    tt[cumulative[byte]++] |= i << 8
  }
  return tt[origPtr] >>> 8
}

/**
 * Undo RLE1 while walking the inverted BWT, writing straight to the sink.
 *
 * RLE1 is the compressor's first stage: four identical bytes are followed by a
 * count byte giving 0–255 further repeats. It exists to stop the suffix sort
 * from degenerating on long runs, so it must be undone last.
 *
 * @param {Uint32Array} tt
 * @param {number} n
 * @param {number} startPos
 * @param {OutputSink} out
 */
function decodeRle1(tt, n, startPos, out) {
  let pos = startPos
  let runCount = 0
  let lastByte = -1

  for (let i = 0; i < n; i++) {
    if (pos < 0 || pos >= n) {
      throw new Bzip2Error('Corrupt bzip2 block: BWT walk left the block', 'corrupt')
    }
    const entry = tt[pos]
    const byte = entry & 0xff
    pos = entry >>> 8

    if (runCount === 4) {
      out.write(lastByte, byte)
      runCount = 0
      lastByte = -1
      continue
    }
    if (byte === lastByte) runCount++
    else {
      runCount = 1
      lastByte = byte
    }
    out.write(byte, 1)
  }

  if (runCount === 4) {
    throw new Bzip2Error('Corrupt bzip2 block: RLE run has no length byte', 'corrupt')
  }
}

/** @param {Buffer|Uint8Array} buf @returns {boolean} */
export function isBzip2(buf) {
  return (
    (Buffer.isBuffer(buf) || buf instanceof Uint8Array) &&
    buf.length >= 4 &&
    buf[0] === 0x42 &&
    buf[1] === 0x5a &&
    buf[2] === 0x68 &&
    buf[3] >= 0x31 &&
    buf[3] <= 0x39
  )
}

/**
 * Decompress a complete bzip2 file.
 *
 * Concatenated streams (what `cat a.bz2 b.bz2` produces, and what pbzip2 emits)
 * are handled by restarting at the next byte-aligned `BZh` header.
 *
 * @param {Buffer|Uint8Array} input
 * @param {number} [maxBytes] hard cap on the decompressed size
 * @returns {Buffer}
 * @throws {Bzip2Error}
 */
export function bunzip2(input, maxBytes = DEFAULT_MAX_OUTPUT) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new Bzip2Error('Not a bzip2 stream: expected a buffer', 'corrupt')
  }
  if (!isBzip2(input)) {
    throw new Bzip2Error('Not a bzip2 stream: bad magic number', 'corrupt')
  }
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Bzip2Error('Invalid bzip2 output limit', 'limit')
  }

  const br = new BitReader(input)
  const out = new OutputSink(maxBytes)

  for (;;) {
    const header = br.read(24)
    const level = br.read(8) - 0x30
    if (header !== 0x425a68 || level < 1 || level > 9) {
      throw new Bzip2Error('Not a bzip2 stream: bad stream header', 'corrupt')
    }

    const blockLimit = level * 100000
    const maxSelectors = 2 + Math.floor(blockLimit / GROUP_SIZE)
    const counts = new Int32Array(256)
    // Allocated on the first real block so an empty stream costs nothing, then
    // reused for every later block of the same stream.
    /** @type {Uint32Array|null} */
    let tt = null
    let combinedCrc = 0

    for (;;) {
      const hi = br.read(24)
      const lo = br.read(24)

      if (hi === EOS_MAGIC_HI && lo === EOS_MAGIC_LO) {
        const storedCrc = br.read32()
        if (storedCrc !== combinedCrc) {
          throw new Bzip2Error(
            `bzip2 stream CRC mismatch: expected ${storedCrc}, got ${combinedCrc}`,
            'corrupt',
          )
        }
        break
      }
      if (hi !== BLOCK_MAGIC_HI || lo !== BLOCK_MAGIC_LO) {
        throw new Bzip2Error('Corrupt bzip2 stream: bad block magic', 'corrupt')
      }

      const blockCrc = br.read32()
      if (br.readBit() === 1) {
        // Deprecated in bzip2 0.9.5 and never produced since; supporting it
        // would mean carrying the 512-entry randomisation table for files that
        // effectively no longer exist.
        throw new Bzip2Error('Randomised bzip2 blocks are not supported', 'unsupported')
      }
      const origPtr = br.read(24)

      const symMap = readSymbolMap(br)
      const alphaSize = symMap.length + 2

      const nGroups = br.read(3)
      if (nGroups < MIN_GROUPS || nGroups > MAX_GROUPS) {
        throw new Bzip2Error('Corrupt bzip2 block: bad Huffman group count', 'corrupt')
      }
      const nSelectors = br.read(15)
      if (nSelectors < 1 || nSelectors > maxSelectors) {
        throw new Bzip2Error('Corrupt bzip2 block: bad selector count', 'corrupt')
      }

      const selectors = readSelectors(br, nGroups, nSelectors)
      const tables = readHuffTables(br, nGroups, alphaSize)

      if (tt === null) tt = new Uint32Array(blockLimit)
      counts.fill(0)
      const n = decodeMtfRle2(br, tables, selectors, symMap, tt, counts)
      const startPos = inverseBwt(tt, n, counts, origPtr)

      out.resetCrc()
      decodeRle1(tt, n, startPos, out)
      const actualCrc = out.finishCrc()
      if (actualCrc !== blockCrc) {
        throw new Bzip2Error(
          `bzip2 block CRC mismatch: expected ${blockCrc}, got ${actualCrc}`,
          'corrupt',
        )
      }

      // Rotate-then-xor, as specified; a plain xor would let two swapped
      // blocks pass verification.
      combinedCrc = (((combinedCrc << 1) | (combinedCrc >>> 31)) ^ blockCrc) >>> 0
    }

    br.alignToByte()
    if (br.bytesRemaining() < 4 || !isBzip2(input.subarray(br.pos))) break
  }

  return out.finish()
}
