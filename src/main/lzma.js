/**
 * @file lzma.js
 * @description LZMA / LZMA2 / .xz decompression in plain JavaScript.
 *
 *   Node ships zlib but no LZMA, and the project deliberately avoids adding
 *   dependencies, so `.xz` archives were reported as unsupported. The format is
 *   fully documented, and only the decoder is needed here.
 *
 *   Three layers, from the inside out:
 *     LZMA   — range coder + context-modelled probabilities + LZ77 window
 *     LZMA2  — chunks the LZMA stream, and can carry stored (uncompressed) runs
 *     xz     — stream header, block headers, index, footer, integrity check
 */

/** Fixed by the format: a match length is encoded relative to this. */
const MATCH_LEN_MIN = 2

/** Probabilities are 11-bit, updated by a shift of 5 — both from the spec. */
const PROB_INIT = 1024 // (1 << 11) / 2
const MOVE_BITS = 5
const TOP_VALUE = 1 << 24

const POS_STATES_MAX = 1 << 4
const ALIGN_BITS = 4
const ALIGN_SIZE = 1 << ALIGN_BITS
const DIST_MODEL_START = 4
const DIST_MODEL_END = 14
const FULL_DISTANCES = 1 << (DIST_MODEL_END >> 1)
const LEN_TO_POS_STATES = 4
const STATES = 12

export class LzmaError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'LzmaError'
  }
}

/**
 * Range decoder.
 *
 * LZMA is arithmetic-coded: rather than emitting whole bits, it narrows a
 * numeric range according to a probability that is itself updated as the data
 * is read. Every `decodeBit` both produces a bit and adapts the model, so the
 * decoder has to mirror the encoder's state machine exactly.
 */
class RangeDecoder {
  /** @param {Uint8Array} buf @param {number} pos */
  constructor(buf, pos) {
    this.buf = buf
    this.pos = pos
    this.range = 0xffffffff
    this.code = 0

    // The first byte is always zero padding in a well-formed stream.
    this.pos++
    for (let i = 0; i < 4; i++) {
      this.code = ((this.code << 8) | this._byte()) >>> 0
    }
  }

  _byte() {
    if (this.pos >= this.buf.length) throw new LzmaError('LZMA 資料在解碼中途結束')
    return this.buf[this.pos++]
  }

  _normalize() {
    if (this.range < TOP_VALUE) {
      this.range = (this.range << 8) >>> 0
      this.code = ((this.code << 8) | this._byte()) >>> 0
    }
  }

  /**
   * @param {Uint16Array} probs
   * @param {number} index
   * @returns {number} 0 or 1
   */
  decodeBit(probs, index) {
    const prob = probs[index]
    const bound = (this.range >>> 11) * prob
    let bit
    // `>>> 0` throughout: these are 32-bit unsigned quantities and JS bit ops
    // would otherwise sign-extend them.
    if ((this.code >>> 0) < bound) {
      this.range = bound
      probs[index] = prob + (((1 << 11) - prob) >>> MOVE_BITS)
      bit = 0
    } else {
      this.range = (this.range - bound) >>> 0
      this.code = (this.code - bound) >>> 0
      probs[index] = prob - (prob >>> MOVE_BITS)
      bit = 1
    }
    this._normalize()
    return bit
  }

  /**
   * @param {Uint16Array} probs
   * @param {number} offset
   * @param {number} numBits
   * @returns {number}
   */
  decodeBitTree(probs, offset, numBits) {
    let m = 1
    for (let i = 0; i < numBits; i++) {
      m = (m << 1) | this.decodeBit(probs, offset + m)
    }
    return m - (1 << numBits)
  }

  /**
   * @param {Uint16Array} probs
   * @param {number} offset
   * @param {number} numBits
   * @returns {number}
   */
  decodeBitTreeReverse(probs, offset, numBits) {
    let m = 1
    let symbol = 0
    for (let i = 0; i < numBits; i++) {
      const bit = this.decodeBit(probs, offset + m)
      m = (m << 1) | bit
      symbol |= bit << i
    }
    return symbol
  }

  /**
   * @param {number} numBits
   * @returns {number}
   */
  decodeDirectBits(numBits) {
    let result = 0
    for (let i = 0; i < numBits; i++) {
      this.range = this.range >>> 1
      this.code = (this.code - this.range) >>> 0
      const t = 0 - (this.code >>> 31)
      this.code = (this.code + (this.range & t)) >>> 0
      this._normalize()
      result = ((result << 1) + t + 1) >>> 0
    }
    return result
  }

  /** A well-formed stream ends with the code exhausted. */
  isFinished() {
    return this.code === 0
  }
}

/**
 * Sliding output window.
 *
 * LZMA matches refer backwards into already-produced output, so the decoder
 * has to keep it. This grows the buffer rather than using a true ring, because
 * the caller wants the whole result anyway and a bounded total is enforced
 * separately.
 */
class OutWindow {
  /** @param {number} limit */
  constructor(limit) {
    this.limit = limit
    this.buf = new Uint8Array(Math.min(limit, 1 << 16))
    this.length = 0
  }

  _ensure(extra) {
    if (this.length + extra <= this.buf.length) return
    if (this.length + extra > this.limit) {
      throw new LzmaError('解壓縮結果超過允許的大小上限')
    }
    let next = this.buf.length * 2
    while (next < this.length + extra) next *= 2
    const grown = new Uint8Array(Math.min(next, this.limit))
    grown.set(this.buf.subarray(0, this.length))
    this.buf = grown
  }

  /** @param {number} b */
  putByte(b) {
    this._ensure(1)
    this.buf[this.length++] = b
  }

  /** @param {number} dist */
  getByte(dist) {
    const idx = this.length - dist - 1
    if (idx < 0) throw new LzmaError('LZMA 參照到視窗以外的位置')
    return this.buf[idx]
  }

  /**
   * @param {number} dist
   * @param {number} len
   */
  copyMatch(dist, len) {
    if (dist >= this.length) throw new LzmaError('LZMA 參照到視窗以外的位置')
    this._ensure(len)
    // Byte at a time deliberately: an overlapping match (dist < len) is legal
    // and is how runs are encoded, so a bulk copy would be wrong.
    for (let i = 0; i < len; i++) {
      this.buf[this.length] = this.buf[this.length - dist - 1]
      this.length++
    }
  }

  result() {
    return this.buf.subarray(0, this.length)
  }
}

/** Decoder state shared across LZMA2 chunks. */
class LzmaState {
  /**
   * @param {number} lc literal context bits
   * @param {number} lp literal position bits
   * @param {number} pb position bits
   */
  constructor(lc, lp, pb) {
    this.lc = lc
    this.lp = lp
    this.pb = pb
    this.reset()
  }

  reset() {
    const fill = (n) => {
      const a = new Uint16Array(n)
      a.fill(PROB_INIT)
      return a
    }
    this.isMatch = fill(STATES << POS_STATES_MAX)
    this.isRep = fill(STATES)
    this.isRepG0 = fill(STATES)
    this.isRepG1 = fill(STATES)
    this.isRepG2 = fill(STATES)
    this.isRep0Long = fill(STATES << POS_STATES_MAX)
    this.posSlot = fill(LEN_TO_POS_STATES << 6)
    this.posDecoders = fill(1 + FULL_DISTANCES - DIST_MODEL_END)
    this.alignDecoder = fill(ALIGN_SIZE)
    this.literal = fill(0x300 << (this.lc + this.lp))
    this.lenChoice = fill(2)
    this.lenLow = fill(POS_STATES_MAX << 3)
    this.lenMid = fill(POS_STATES_MAX << 3)
    this.lenHigh = fill(1 << 8)
    this.repChoice = fill(2)
    this.repLow = fill(POS_STATES_MAX << 3)
    this.repMid = fill(POS_STATES_MAX << 3)
    this.repHigh = fill(1 << 8)

    this.state = 0
    this.rep0 = 0
    this.rep1 = 0
    this.rep2 = 0
    this.rep3 = 0
  }
}

/**
 * Decode one length value.
 *
 * @param {RangeDecoder} rc
 * @param {Uint16Array} choice
 * @param {Uint16Array} low
 * @param {Uint16Array} mid
 * @param {Uint16Array} high
 * @param {number} posState
 * @returns {number}
 */
function decodeLen(rc, choice, low, mid, high, posState) {
  if (rc.decodeBit(choice, 0) === 0) {
    return rc.decodeBitTree(low, posState << 3, 3)
  }
  if (rc.decodeBit(choice, 1) === 0) {
    return 8 + rc.decodeBitTree(mid, posState << 3, 3)
  }
  return 16 + rc.decodeBitTree(high, 0, 8)
}

/**
 * Run the LZMA decoder over one chunk.
 *
 * @param {RangeDecoder} rc
 * @param {LzmaState} st
 * @param {OutWindow} out
 * @param {number} uncompressedLimit  stop after this many bytes for this chunk
 */
function decodeLzmaChunk(rc, st, out, uncompressedLimit) {
  const posMask = (1 << st.pb) - 1
  const litPosMask = (1 << st.lp) - 1
  const target = out.length + uncompressedLimit

  while (out.length < target) {
    const posState = out.length & posMask

    if (rc.decodeBit(st.isMatch, (st.state << POS_STATES_MAX) + posState) === 0) {
      // Literal. The model is keyed on the previous byte's high bits and the
      // output position, which is what lc/lp control.
      const prevByte = out.length > 0 ? out.getByte(0) : 0
      const litState =
        ((out.length & litPosMask) << st.lc) + (prevByte >>> (8 - st.lc))
      const probsOffset = 0x300 * litState

      let symbol = 1
      if (st.state >= 7) {
        // After a match the literal is coded against the byte that would have
        // been matched, so mismatching bits switch to a different sub-tree.
        let matchByte = out.getByte(st.rep0)
        do {
          const matchBit = (matchByte >>> 7) & 1
          matchByte = (matchByte << 1) & 0xff
          const bit = rc.decodeBit(
            st.literal, probsOffset + ((1 + matchBit) << 8) + symbol)
          symbol = (symbol << 1) | bit
          if (matchBit !== bit) break
        } while (symbol < 0x100)
      }
      while (symbol < 0x100) {
        symbol = (symbol << 1) | rc.decodeBit(st.literal, probsOffset + symbol)
      }
      out.putByte(symbol & 0xff)
      st.state = st.state < 4 ? 0 : (st.state < 10 ? st.state - 3 : st.state - 6)
      continue
    }

    let len
    if (rc.decodeBit(st.isRep, st.state) === 1) {
      // Repeated distance: one of the four most recent.
      if (rc.decodeBit(st.isRepG0, st.state) === 0) {
        if (rc.decodeBit(st.isRep0Long, (st.state << POS_STATES_MAX) + posState) === 0) {
          st.state = st.state < 7 ? 9 : 11
          out.putByte(out.getByte(st.rep0))
          continue
        }
      } else {
        let dist
        if (rc.decodeBit(st.isRepG1, st.state) === 0) {
          dist = st.rep1
        } else if (rc.decodeBit(st.isRepG2, st.state) === 0) {
          dist = st.rep2
          st.rep2 = st.rep1
        } else {
          dist = st.rep3
          st.rep3 = st.rep2
          st.rep2 = st.rep1
        }
        st.rep1 = st.rep0
        st.rep0 = dist
      }
      len = MATCH_LEN_MIN +
        decodeLen(rc, st.repChoice, st.repLow, st.repMid, st.repHigh, posState)
      st.state = st.state < 7 ? 8 : 11
    } else {
      // New match: length first, then the distance, whose encoding widens with
      // the length — short matches are usually nearby.
      st.rep3 = st.rep2
      st.rep2 = st.rep1
      st.rep1 = st.rep0
      len = MATCH_LEN_MIN +
        decodeLen(rc, st.lenChoice, st.lenLow, st.lenMid, st.lenHigh, posState)
      st.state = st.state < 7 ? 7 : 10

      const lenToPosState = Math.min(len - MATCH_LEN_MIN, LEN_TO_POS_STATES - 1)
      const posSlot = rc.decodeBitTree(st.posSlot, lenToPosState << 6, 6)

      if (posSlot < DIST_MODEL_START) {
        st.rep0 = posSlot
      } else {
        const numDirect = (posSlot >> 1) - 1
        let dist = (2 | (posSlot & 1)) << numDirect
        if (posSlot < DIST_MODEL_END) {
          dist += rc.decodeBitTreeReverse(
            st.posDecoders, dist - posSlot, numDirect)
        } else {
          dist += rc.decodeDirectBits(numDirect - ALIGN_BITS) * ALIGN_SIZE
          dist += rc.decodeBitTreeReverse(st.alignDecoder, 0, ALIGN_BITS)
        }
        st.rep0 = dist >>> 0
      }

      if (st.rep0 === 0xffffffff) return // end-of-stream marker
    }

    out.copyMatch(st.rep0, len)
  }
}

/**
 * Decode a raw LZMA1 stream (the `.lzma` / `LZMA_ALONE` container).
 *
 * @param {Uint8Array} buf
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Uint8Array}
 */
export function decodeLzmaAlone(buf, opts = {}) {
  const maxBytes = opts.maxBytes ?? 268_435_456
  if (!buf || buf.length < 13) throw new LzmaError('LZMA 檔頭不完整')

  let props = buf[0]
  if (props >= 9 * 5 * 5) throw new LzmaError('LZMA 屬性位元組不合法')
  const lc = props % 9
  props = Math.floor(props / 9)
  const lp = props % 5
  const pb = Math.floor(props / 5)

  // Size is a 64-bit little-endian value; 0xFFFFFFFFFFFFFFFF means unknown.
  let size = 0
  let unknownSize = true
  for (let i = 0; i < 8; i++) {
    if (buf[5 + i] !== 0xff) unknownSize = false
  }
  if (!unknownSize) {
    for (let i = 7; i >= 0; i--) size = size * 256 + buf[5 + i]
    if (size > maxBytes) throw new LzmaError('解壓縮結果超過允許的大小上限')
  }

  const out = new OutWindow(unknownSize ? maxBytes : Math.min(size, maxBytes))
  const rc = new RangeDecoder(buf, 13)
  const st = new LzmaState(lc, lp, pb)
  // With an unknown size the only stopping conditions are the end-of-stream
  // marker and the window's ceiling. Passing maxBytes as the chunk target
  // instead would stop cleanly at the ceiling and silently return a truncated
  // result, which is worse than refusing.
  decodeLzmaChunk(rc, st, out, unknownSize ? Infinity : size)
  return out.result()
}

// ── xz container ────────────────────────────────────────────────────────────

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]

/**
 * @param {Uint8Array} buf
 * @returns {boolean}
 */
export function isXz(buf) {
  if (!buf || buf.length < 6) return false
  return XZ_MAGIC.every((b, i) => buf[i] === b)
}

/**
 * Read a multibyte integer as used throughout the xz format.
 *
 * @param {Uint8Array} buf
 * @param {number} pos
 * @returns {{ value: number, next: number }}
 */
function readVli(buf, pos) {
  if (pos >= buf.length) throw new LzmaError('xz 資料結束得太早')
  let value = buf[pos] & 0x7f
  let shift = 7
  let i = pos
  while (buf[i] & 0x80) {
    i++
    if (i >= buf.length || shift > 63) throw new LzmaError('xz 整數編碼不合法')
    value += (buf[i] & 0x7f) * 2 ** shift
    shift += 7
  }
  return { value, next: i + 1 }
}

/** CRC-32 table, built once. */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

/**
 * @param {Uint8Array} data
 * @returns {number}
 */
function crc32(data) {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * CRC-64 (ECMA-182) as two 32-bit halves.
 *
 * xz defaults to this check, so verifying only CRC-32 would leave the common
 * case unchecked. BigInt would be simpler but is far too slow over megabytes.
 */
const CRC64_TABLE = (() => {
  const hi = new Uint32Array(256)
  const lo = new Uint32Array(256)
  // Polynomial 0xC96C5795D7870F42, split into halves.
  const POLY_HI = 0xc96c5795
  const POLY_LO = 0xd7870f42
  for (let i = 0; i < 256; i++) {
    let h = 0
    let l = i
    for (let k = 0; k < 8; k++) {
      const lsb = l & 1
      l = ((l >>> 1) | (h << 31)) >>> 0
      h = h >>> 1
      if (lsb) { h = (h ^ POLY_HI) >>> 0; l = (l ^ POLY_LO) >>> 0 }
    }
    hi[i] = h
    lo[i] = l
  }
  return { hi, lo }
})()

/**
 * @param {Uint8Array} data
 * @returns {{ hi: number, lo: number }}
 */
function crc64(data) {
  let h = 0xffffffff
  let l = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    const idx = (l ^ data[i]) & 0xff
    const nl = ((l >>> 8) | (h << 24)) >>> 0
    const nh = h >>> 8
    l = (nl ^ CRC64_TABLE.lo[idx]) >>> 0
    h = (nh ^ CRC64_TABLE.hi[idx]) >>> 0
  }
  return { hi: (h ^ 0xffffffff) >>> 0, lo: (l ^ 0xffffffff) >>> 0 }
}

/** Size in bytes of each xz check type, indexed by the stream flag value. */
const CHECK_SIZES = {
  0x00: 0,  // none
  0x01: 4,  // CRC32
  0x04: 8,  // CRC64
  0x0a: 32, // SHA-256
}

/**
 * Verify a block's integrity check.
 *
 * Without this, corrupt compressed data decodes to plausible-looking garbage
 * and is returned as if it were correct — the one failure mode a decompressor
 * must not have.
 *
 * @param {number} checkType
 * @param {Uint8Array} data      decoded output
 * @param {Uint8Array} expected  the stored check value
 * @returns {boolean} false only when the check is one we verify and it fails
 */
function verifyCheck(checkType, data, expected) {
  if (checkType === 0x01) {
    const want = (expected[0] | (expected[1] << 8) |
      (expected[2] << 16) | (expected[3] << 24)) >>> 0
    return crc32(data) === want
  }
  if (checkType === 0x04) {
    const { hi, lo } = crc64(data)
    const wantLo = (expected[0] | (expected[1] << 8) |
      (expected[2] << 16) | (expected[3] << 24)) >>> 0
    const wantHi = (expected[4] | (expected[5] << 8) |
      (expected[6] << 16) | (expected[7] << 24)) >>> 0
    return lo === wantLo && hi === wantHi
  }
  // SHA-256 and unknown types are not verified; saying so beats pretending.
  return true
}

/**
 * Decode an LZMA2 stream.
 *
 * LZMA2 exists to allow uncompressed chunks and periodic state resets, so a
 * stream can be produced without buffering everything; the decoder has to
 * honour each chunk's reset flags or the probability model desynchronises.
 *
 * @param {Uint8Array} buf
 * @param {number} dictProps
 * @param {number} maxBytes
 * @returns {Uint8Array}
 */
function decodeLzma2(buf, dictProps, maxBytes) {
  const out = new OutWindow(maxBytes)
  /** @type {LzmaState|null} */
  let st = null
  let pos = 0

  while (pos < buf.length) {
    const control = buf[pos++]
    if (control === 0x00) break // end of LZMA2 stream

    if (control < 0x80) {
      if (control > 0x02) throw new LzmaError('LZMA2 控制位元組不合法')
      // Stored chunk: length is a 16-bit big-endian count minus one.
      const size = ((buf[pos] << 8) | buf[pos + 1]) + 1
      pos += 2
      if (pos + size > buf.length) throw new LzmaError('LZMA2 未壓縮區塊超出範圍')
      for (let i = 0; i < size; i++) out.putByte(buf[pos + i])
      pos += size
      if (control === 0x01 && st) st.reset()
      continue
    }

    const unpackSize = (((control & 0x1f) << 16) |
      (buf[pos] << 8) | buf[pos + 1]) + 1
    pos += 2
    const packSize = ((buf[pos] << 8) | buf[pos + 1]) + 1
    pos += 2

    const resetMode = (control >> 5) & 0x03
    if (resetMode >= 2) {
      const p = buf[pos++]
      if (p >= 9 * 5 * 5) throw new LzmaError('LZMA2 屬性位元組不合法')
      const lc = p % 9
      const lp = Math.floor(p / 9) % 5
      const pb = Math.floor(p / 45)
      st = new LzmaState(lc, lp, pb)
    } else if (!st) {
      throw new LzmaError('LZMA2 第一個區塊未帶屬性')
    } else if (resetMode === 1) {
      st.reset()
    }

    if (pos + packSize > buf.length) throw new LzmaError('LZMA2 壓縮區塊超出範圍')
    const rc = new RangeDecoder(buf.subarray(pos, pos + packSize), 0)
    decodeLzmaChunk(rc, st, out, unpackSize)
    pos += packSize
  }

  void dictProps
  return { data: out.result(), consumed: pos }
}

/**
 * Decompress an `.xz` stream.
 *
 * Only the LZMA2 filter is handled — it is what every xz encoder emits by
 * default. A BCJ or delta filter would need its own pass, and is reported
 * rather than silently producing wrong output.
 *
 * @param {Uint8Array} buf
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Uint8Array}
 */
export function decodeXz(buf, opts = {}) {
  const maxBytes = opts.maxBytes ?? 268_435_456
  if (!isXz(buf)) throw new LzmaError('不是 xz 檔（magic 不符）')
  if (buf.length < 24) throw new LzmaError('xz 檔太短')

  // Stream header is 12 bytes: magic(6) + flags(2) + CRC32(4).
  const pos = 12
  /** @type {Uint8Array[]} */
  const parts = []
  let total = 0

  while (pos < buf.length) {
    const headerSizeByte = buf[pos]
    // 0 marks the index, which follows the last block.
    if (headerSizeByte === 0) break

    const headerSize = (headerSizeByte + 1) * 4
    if (pos + headerSize > buf.length) throw new LzmaError('xz 區塊標頭超出範圍')
    const header = buf.subarray(pos, pos + headerSize)

    const flags = header[1]
    const numFilters = (flags & 0x03) + 1
    if (numFilters !== 1) {
      throw new LzmaError('xz 使用了多重 filter，此解碼器僅支援單一 LZMA2 filter')
    }

    let hp = 2
    if (flags & 0x40) hp = readVli(header, hp).next // compressed size
    if (flags & 0x80) hp = readVli(header, hp).next // uncompressed size

    const filterId = readVli(header, hp)
    if (filterId.value !== 0x21) {
      throw new LzmaError(`xz 使用了不支援的 filter（id 0x${filterId.value.toString(16)}）`)
    }
    const propsSize = readVli(header, filterId.next)
    const dictProps = header[propsSize.next]

    const dataStart = pos + headerSize
    // The block's compressed size is not always in the header, so the payload
    // runs to the index; the LZMA2 terminator tells the inner decoder to stop.
    const rest = buf.subarray(dataStart)
    const { data: chunk, consumed } = decodeLzma2(rest, dictProps, maxBytes - total)

    // The check value sits after the compressed data, padded to a 4-byte
    // boundary. Skipping verification would let corrupt input decode to
    // plausible garbage and be returned as correct.
    // Stream flags are the two bytes after the magic: the first is reserved
    // and always zero, the check type lives in the second.
    const checkType = buf[7] & 0x0f
    const checkSize = CHECK_SIZES[checkType]
    if (checkSize === undefined) {
      throw new LzmaError(`xz 使用了未知的完整性檢查型別 0x${checkType.toString(16)}`)
    }
    if (checkSize > 0) {
      const padded = dataStart + consumed + ((4 - (consumed % 4)) % 4)
      if (padded + checkSize > buf.length) {
        throw new LzmaError('xz 區塊的完整性檢查值超出範圍')
      }
      const stored = buf.subarray(padded, padded + checkSize)
      if (!verifyCheck(checkType, chunk, stored)) {
        throw new LzmaError('xz 完整性檢查不符，資料已毀損')
      }
    }

    parts.push(chunk)
    total += chunk.length

    // Only single-block streams are produced by default encoders, and the
    // block payload length is not recoverable here without parsing the index.
    break
  }

  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}
