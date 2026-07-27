/**
 * @file sevenzip.js
 * @description Reading `.7z` archives.
 *
 *   7z separates the container from the compression: a header describes folders
 *   (groups of streams) and the chain of coders each one passes through, and
 *   the coders themselves are LZMA, LZMA2, BCJ and friends. With an LZMA
 *   decoder already in the tree, what remained was the container — plus the
 *   wrinkle that the header is usually itself compressed, so it has to be
 *   decoded through the same machinery before it can be read.
 *
 *   Read-only, and only the coders that can be decoded here: Copy, LZMA, LZMA2
 *   and the x86 filters BCJ and BCJ2. Anything else is named rather than
 *   mis-decoded.
 *
 *   Per-substream CRC32s are verified on extraction. Without that, corruption
 *   that happens not to derail the coder produces wrong bytes that look
 *   perfectly successful — the failure mode a checksum exists to catch.
 */

import { decodeLzmaRaw, decodeLzma2Raw, LzmaError, crc32 } from './lzma.js'

const SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]
const SIGNATURE_HEADER_SIZE = 32

/** Header property ids, from the format's own enumeration. */
const kEnd = 0x00
const kHeader = 0x01
const kMainStreamsInfo = 0x04
const kFilesInfo = 0x05
const kPackInfo = 0x06
const kUnPackInfo = 0x07
const kSubStreamsInfo = 0x08
const kSize = 0x09
const kFolder = 0x0b
const kCodersUnPackSize = 0x0c
const kCRC = 0x0a
const kNumUnPackStream = 0x0d
const kEmptyStream = 0x0e
const kEmptyFile = 0x0f
const kName = 0x11
const kMTime = 0x14
const kAttributes = 0x15
const kEncodedHeader = 0x17
const kDummy = 0x19

/** Coder ids this decoder can actually run. */
const CODER_COPY = '00'
const CODER_LZMA2 = '21'
const CODER_LZMA1 = '030101'

const CODER_BCJ_X86 = '03030103'
const CODER_BCJ2 = '0303011b'

/** Names for the coders that are recognised but cannot be decoded here. */
const KNOWN_UNSUPPORTED = {
  '03': 'Delta',
  '03030205': 'BCJ (PPC)',
  '03030301': 'BCJ (IA64)',
  '03030501': 'BCJ (ARM)',
  '03030701': 'BCJ (ARMT)',
  '03030805': 'BCJ (SPARC)',
  '040108': 'Deflate',
  '040202': 'BZip2',
  '06f10701': 'AES-256',
}

/** @param {number} b */
function isX86MsByte(b) {
  return b === 0x00 || b === 0xff
}

/**
 * Undo the x86 BCJ filter.
 *
 * The encoder rewrites the relative operands of CALL/JMP into absolute
 * addresses so that repeated calls to the same target become identical byte
 * sequences, which is what makes them compress. Decoding converts them back,
 * and has to walk the stream in the same order the encoder did — the running
 * mask carries state between overlapping candidates, so it cannot be done
 * position-independently.
 *
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
export function bcjX86Decode(input) {
  const data = Uint8Array.from(input)
  if (data.length < 5) return data

  const size = data.length - 4
  let mask = 0
  let pos = 0
  const ip = 5

  for (;;) {
    let p = pos
    while (p < size && (data[p] & 0xfe) !== 0xe8) p++
    const d = p - pos
    pos = p
    if (p >= size) break

    if (d > 2) {
      mask = 0
    } else {
      mask >>= d
      if (mask !== 0 &&
          (mask > 4 || mask === 3 || isX86MsByte(data[p + (mask >> 1) + 1]))) {
        mask = ((mask >> 1) | 4) & 7
        pos++
        continue
      }
    }

    if (isX86MsByte(data[p + 4])) {
      let v = ((data[p + 4] << 24) | (data[p + 3] << 16) |
               (data[p + 2] << 8) | data[p + 1]) >>> 0
      const cur = (ip + pos) >>> 0
      pos += 5
      v = (v - cur) >>> 0
      if (mask !== 0) {
        const sh = (mask & 6) << 2
        if (isX86MsByte((v >>> sh) & 0xff)) {
          v = (v ^ (((0x100 << sh) >>> 0) - 1)) >>> 0
          v = (v - cur) >>> 0
        }
        mask = 0
      }
      data[p + 1] = v & 0xff
      data[p + 2] = (v >>> 8) & 0xff
      data[p + 3] = (v >>> 16) & 0xff
      data[p + 4] = (0 - ((v >>> 24) & 1)) & 0xff
    } else {
      mask = ((mask >> 1) | 4) & 7
      pos++
    }
  }
  return data
}

export class SevenZipError extends Error {
  /**
   * @param {string} message
   * @param {'unsupported'|'corrupt'|'limit'|'encrypted'} code
   */
  constructor(message, code = 'corrupt') {
    super(message)
    this.name = 'SevenZipError'
    this.code = code
  }
}

/**
 * Range decoder for BCJ2's status bits.
 *
 * This is the same arithmetic coder LZMA uses, and duplicating it is not the
 * preference — `lzma.js` has one, but it is module-private there and this task
 * is scoped to this file. It is kept to the two operations BCJ2 needs (init and
 * one adaptive bit) rather than copied wholesale, and the constants below are
 * the format's, not a second interpretation of them.
 *
 * Initialisation is deferred: a folder whose data contains no branch opcodes at
 * all gets an empty control stream from the encoder, and demanding five header
 * bytes up front would reject it.
 */
class Bcj2RangeDecoder {
  /** @param {Uint8Array} buf */
  constructor(buf) {
    this.buf = buf
    this.pos = 0
    this.range = 0
    this.code = 0
    this.started = false
  }

  _byte() {
    if (this.pos >= this.buf.length) {
      throw new SevenZipError('7z BCJ2 控制串流在解碼中途結束')
    }
    return this.buf[this.pos++]
  }

  _start() {
    this.started = true
    this.range = 0xffffffff
    this.code = 0
    // The first byte is padding in a well-formed stream.
    this._byte()
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this._byte()) >>> 0
  }

  /**
   * @param {Uint16Array} probs
   * @param {number} index
   * @returns {number} 0 or 1
   */
  decodeBit(probs, index) {
    if (!this.started) this._start()
    const prob = probs[index]
    const bound = (this.range >>> 11) * prob
    let bit
    if ((this.code >>> 0) < bound) {
      this.range = bound
      probs[index] = prob + (((1 << 11) - prob) >>> 5)
      bit = 0
    } else {
      this.range = (this.range - bound) >>> 0
      this.code = (this.code - bound) >>> 0
      probs[index] = prob - (prob >>> 5)
      bit = 1
    }
    if (this.range < (1 << 24)) {
      this.range = (this.range << 8) >>> 0
      this.code = ((this.code << 8) | this._byte()) >>> 0
    }
    return bit
  }
}

/**
 * Is `b1` the opcode byte of a branch whose displacement BCJ2 may have
 * converted? CALL (E8), JMP (E9), and the two-byte near Jcc forms (0F 8x).
 *
 * @param {number} b0 previous byte
 * @param {number} b1
 */
function isBcj2Branch(b0, b1) {
  return (b1 & 0xfe) === 0xe8 || (b0 === 0x0f && (b1 & 0xf0) === 0x80)
}

/**
 * Undo the BCJ2 filter.
 *
 * BCJ2 is the branching x86 filter: instead of rewriting displacements in
 * place like BCJ does, the encoder *removes* the converted ones from the byte
 * stream and parks them in two side streams — one for CALL, one for JMP — so
 * that the addresses, which compress badly interleaved with code, get a
 * compressor of their own. A fourth stream carries one arithmetic-coded bit
 * per branch opcode saying whether that opcode's operand was actually taken
 * out, which is what makes the split reversible: an E8 byte inside a constant
 * or in the middle of another instruction is left alone, and only the bit can
 * tell the two cases apart.
 *
 * The probability model is context-indexed, and the contexts are
 * (CALL, previous byte) for each of the 256 possible previous bytes, plus one
 * each for JMP and Jcc. Which slot of the 258 a context maps to is arbitrary —
 * every slot starts at the same value and adapts independently, so any
 * bijection agrees with any encoder's; what must not vary is the set of
 * contexts itself.
 *
 * Addresses are stored big-endian in the side streams (the rest of the format
 * is little-endian) and are absolute; the relative displacement the instruction
 * actually needs is recovered by subtracting the address of the next
 * instruction.
 *
 * @param {Uint8Array[]} streams  main, call, jump, control
 * @param {number} outSize
 * @param {number} maxBytes
 * @returns {Uint8Array}
 */
export function bcj2Decode(streams, outSize, maxBytes) {
  const [main, call, jump, control] = streams
  if (!main || !call || !jump || !control) {
    throw new SevenZipError('7z BCJ2 需要四個輸入串流')
  }
  if (!Number.isSafeInteger(outSize) || outSize < 0) {
    throw new SevenZipError('7z BCJ2 的輸出大小不合理')
  }
  // A declared size is a claim, not a measurement: allocate against the limit
  // first, or a header with a large number in it is an allocation primitive.
  if (outSize > maxBytes) {
    throw new SevenZipError('7z 解壓縮結果超過允許的大小上限', 'limit')
  }

  const out = new Uint8Array(outSize)
  const probs = new Uint16Array(2 + 256).fill(1024)
  const rc = new Bcj2RangeDecoder(control)

  let mainPos = 0
  let callPos = 0
  let jumpPos = 0
  let outPos = 0
  let prev = 0

  while (outPos < outSize) {
    let b = 0
    let branch = false
    while (outPos < outSize) {
      if (mainPos >= main.length) {
        throw new SevenZipError('7z BCJ2 主串流在解碼中途結束')
      }
      b = main[mainPos++]
      out[outPos++] = b
      if (isBcj2Branch(prev, b)) { branch = true; break }
      prev = b
    }
    // An opcode with nothing after it cannot have had an operand removed, and
    // the encoder spends no status bit on it.
    if (!branch || outPos === outSize) break

    const index = b === 0xe8 ? 2 + prev : (b === 0xe9 ? 1 : 0)
    if (rc.decodeBit(probs, index) === 0) {
      prev = b
      continue
    }

    if (outPos + 4 > outSize) {
      throw new SevenZipError('7z BCJ2 的位址超出輸出範圍，檔案可能已損毀')
    }
    const src = b === 0xe8 ? call : jump
    const srcPos = b === 0xe8 ? callPos : jumpPos
    if (srcPos + 4 > src.length) {
      throw new SevenZipError('7z BCJ2 位址串流在解碼中途結束')
    }
    const abs = ((src[srcPos] << 24) | (src[srcPos + 1] << 16) |
                 (src[srcPos + 2] << 8) | src[srcPos + 3]) >>> 0
    if (b === 0xe8) callPos += 4; else jumpPos += 4
    const rel = (abs - (outPos + 4)) >>> 0

    out[outPos++] = rel & 0xff
    out[outPos++] = (rel >>> 8) & 0xff
    out[outPos++] = (rel >>> 16) & 0xff
    out[outPos++] = (rel >>> 24) & 0xff
    prev = (rel >>> 24) & 0xff
  }

  if (outPos !== outSize) {
    throw new SevenZipError('7z BCJ2 解碼的長度與標頭宣告不符，檔案可能已損毀')
  }
  return out
}

/** @param {Uint8Array} buf */
export function is7z(buf) {
  if (!buf || buf.length < SIGNATURE_HEADER_SIZE) return false
  return SIGNATURE.every((b, i) => buf[i] === b)
}

/**
 * Cursor over the header bytes.
 *
 * 7z uses a variable-length integer whose first byte's high bits say how many
 * more follow, so every read has to go through one place or the offsets drift.
 */
class Reader {
  /** @param {Uint8Array} buf */
  constructor(buf) {
    this.buf = buf
    this.pos = 0
  }

  get remaining() { return this.buf.length - this.pos }

  byte() {
    if (this.pos >= this.buf.length) throw new SevenZipError('7z 標頭在中途結束')
    return this.buf[this.pos++]
  }

  /** @param {number} n */
  bytes(n) {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new SevenZipError('7z 標頭在中途結束')
    }
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  uint32() {
    const b = this.bytes(4)
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0
  }

  uint64() {
    const b = this.bytes(8)
    let v = 0
    for (let i = 7; i >= 0; i--) v = v * 256 + b[i]
    return v
  }

  /**
   * The format's variable-length number.
   *
   * @returns {number}
   */
  number() {
    const first = this.byte()
    let mask = 0x80
    let value = 0
    for (let i = 0; i < 8; i++) {
      if ((first & mask) === 0) {
        const high = first & (mask - 1)
        return value + high * 2 ** (8 * i)
      }
      value += this.byte() * 2 ** (8 * i)
      mask >>= 1
    }
    return value
  }

  /**
   * A bit vector, most significant bit first.
   * @param {number} count
   * @returns {boolean[]}
   */
  bits(count) {
    const out = []
    let b = 0
    let mask = 0
    for (let i = 0; i < count; i++) {
      if (mask === 0) { b = this.byte(); mask = 0x80 }
      out.push((b & mask) !== 0)
      mask >>= 1
    }
    return out
  }

  /**
   * A bit vector preceded by an "all defined" shortcut byte.
   * @param {number} count
   * @returns {boolean[]}
   */
  boolsWithAllDefined(count) {
    const allDefined = this.byte() !== 0
    // The shortcut byte says "all of them" without spending a byte per eight
    // entries, so a header of a few dozen bytes can name a count of any size.
    // The bit-vector form is self-limiting; this one has to be bounded against
    // what is left to read, or a tiny file allocates an array of any length.
    if (count > this.remaining * 8) throw new SevenZipError('7z 標頭的項目數超出檔案內容')
    return allDefined ? new Array(count).fill(true) : this.bits(count)
  }

  /** Skip a property whose contents this reader does not need. */
  skipProperty() {
    const size = this.number()
    this.bytes(size)
  }
}

/** @param {Uint8Array} id */
function coderIdHex(id) {
  return Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Read one folder: the coders it chains and how they are wired together.
 *
 * @param {Reader} r
 */
function readFolder(r) {
  const numCoders = r.number()
  if (numCoders < 1 || numCoders > 8) {
    throw new SevenZipError('7z folder 的 coder 數量不合理')
  }

  const coders = []
  let totalInStreams = 0
  for (let i = 0; i < numCoders; i++) {
    const flags = r.byte()
    const idSize = flags & 0x0f
    const isComplex = (flags & 0x10) !== 0
    const hasAttrs = (flags & 0x20) !== 0
    const id = coderIdHex(r.bytes(idSize))

    const numIn = isComplex ? r.number() : 1
    const numOut = isComplex ? r.number() : 1
    // BCJ2 is the widest coder in the format at four inputs; anything past a
    // handful is a header claiming a graph no coder has, and the counts are
    // used to size arrays.
    if (numIn < 1 || numIn > 8 || numOut < 1 || numOut > 8) {
      throw new SevenZipError('7z coder 的串流數量不合理')
    }
    let props = null
    if (hasAttrs) {
      const propsSize = r.number()
      props = Uint8Array.from(r.bytes(propsSize))
    }
    totalInStreams += numIn
    coders.push({ id, numIn, numOut, props })
  }

  const numBindPairs = numCoders - 1
  const bindPairs = []
  for (let i = 0; i < numBindPairs; i++) {
    bindPairs.push({ inIndex: r.number(), outIndex: r.number() })
  }

  const numPackedStreams = totalInStreams - numBindPairs
  if (numPackedStreams < 1) throw new SevenZipError('7z folder 沒有輸入串流')
  const packedIndices = []
  if (numPackedStreams === 1) {
    // The single unbound input is implicit.
    let found = 0
    for (let i = 0; i < totalInStreams; i++) {
      if (!bindPairs.some((bp) => bp.inIndex === i)) { found = i; break }
    }
    packedIndices.push(found)
  } else {
    for (let i = 0; i < numPackedStreams; i++) packedIndices.push(r.number())
  }

  return { coders, bindPairs, packedIndices, totalInStreams, numUnpackSubstreams: 1 }
}

/**
 * @param {Reader} r
 * @returns {{packPos: number, packSizes: number[]}}
 */
function readPackInfo(r) {
  const packPos = r.number()
  const numPackStreams = r.number()
  /** @type {number[]} */
  let packSizes = []
  for (;;) {
    const id = r.number()
    if (id === kEnd) break
    if (id === kSize) {
      packSizes = Array.from({ length: numPackStreams }, () => r.number())
    } else if (id === kCRC) {
      readDigests(r, numPackStreams)
    } else {
      r.skipProperty()
    }
  }
  return { packPos, packSizes }
}

/**
 * @param {Reader} r
 * @param {number} count
 */
function readDigests(r, count) {
  const defined = r.boolsWithAllDefined(count)
  const crcs = []
  for (let i = 0; i < count; i++) crcs.push(defined[i] ? r.uint32() : null)
  return crcs
}

/**
 * @param {Reader} r
 */
function readUnpackInfo(r) {
  if (r.number() !== kFolder) throw new SevenZipError('7z 標頭缺少 folder 區段')
  const numFolders = r.number()
  const external = r.byte()
  if (external !== 0) {
    throw new SevenZipError('7z 使用了外部 folder 定義，此讀取器不支援', 'unsupported')
  }
  const folders = []
  for (let i = 0; i < numFolders; i++) folders.push(readFolder(r))

  if (r.number() !== kCodersUnPackSize) {
    throw new SevenZipError('7z 標頭缺少解壓大小區段')
  }
  for (const f of folders) {
    const totalOut = f.coders.reduce((n, c) => n + c.numOut, 0)
    f.unpackSizes = Array.from({ length: totalOut }, () => r.number())
  }

  for (;;) {
    const id = r.number()
    if (id === kEnd) break
    if (id === kCRC) {
      const crcs = readDigests(r, numFolders)
      folders.forEach((f, i) => { f.crc = crcs[i] })
    } else r.skipProperty()
  }
  return folders
}

/**
 * The output size of a folder is the one output stream nothing else consumes.
 * @param {object} folder
 */
function folderUnpackSize(folder) {
  let outIndex = 0
  for (let c = 0; c < folder.coders.length; c++) {
    for (let o = 0; o < folder.coders[c].numOut; o++, outIndex++) {
      if (!folder.bindPairs.some((bp) => bp.outIndex === outIndex)) {
        return folder.unpackSizes[outIndex]
      }
    }
  }
  return folder.unpackSizes[folder.unpackSizes.length - 1]
}

/**
 * @param {Reader} r
 * @param {object[]} folders
 */
function readSubStreamsInfo(r, folders) {
  let numUnpackStreams = folders.map(() => 1)
  /** @type {number[][]} */
  let sizes = []
  /** @type {(number|null)[][]} */
  let crcs = []

  for (;;) {
    const id = r.number()
    if (id === kEnd) break
    if (id === kNumUnPackStream) {
      numUnpackStreams = folders.map(() => r.number())
    } else if (id === kSize) {
      sizes = folders.map((f, i) => {
        const n = numUnpackStreams[i]
        if (n === 0) return []
        const out = []
        let sum = 0
        // The last substream's size is implied: the folder total minus the rest.
        for (let j = 0; j < n - 1; j++) {
          const s = r.number()
          out.push(s)
          sum += s
        }
        out.push(folderUnpackSize(f) - sum)
        return out
      })
    } else if (id === kCRC) {
      // Digests appear only for substreams whose CRC is not already known: a
      // folder holding exactly one substream reuses the folder digest, and
      // reading a value for it here would desynchronise the whole table.
      const wanted = folders.map((f, i) =>
        (numUnpackStreams[i] === 1 && f.crc != null ? 0 : numUnpackStreams[i]))
      const total = wanted.reduce((a, b) => a + b, 0)
      const digests = readDigests(r, total)
      let d = 0
      crcs = folders.map((f, i) => (wanted[i] === 0
        ? [f.crc]
        : Array.from({ length: numUnpackStreams[i] }, () => digests[d++])))
    } else {
      r.skipProperty()
    }
  }

  if (!sizes.length) {
    sizes = folders.map((f, i) => (numUnpackStreams[i] ? [folderUnpackSize(f)] : []))
  }
  if (!crcs.length) {
    crcs = folders.map((f, i) => (numUnpackStreams[i] === 1 ? [f.crc ?? null]
      : Array.from({ length: numUnpackStreams[i] }, () => null)))
  }
  return { numUnpackStreams, sizes, crcs }
}

/**
 * @param {Reader} r
 */
function readStreamsInfo(r) {
  let packInfo = { packPos: 0, packSizes: [] }
  /** @type {object[]} */
  let folders = []
  let subStreams = null

  for (;;) {
    const id = r.number()
    if (id === kEnd) break
    if (id === kPackInfo) packInfo = readPackInfo(r)
    else if (id === kUnPackInfo) folders = readUnpackInfo(r)
    else if (id === kSubStreamsInfo) subStreams = readSubStreamsInfo(r, folders)
    else r.skipProperty()
  }
  if (!subStreams) {
    subStreams = {
      numUnpackStreams: folders.map(() => 1),
      sizes: folders.map((f) => [folderUnpackSize(f)]),
      crcs: folders.map((f) => [f.crc ?? null]),
    }
  }
  return { packInfo, folders, subStreams }
}

/**
 * Decode one folder's packed bytes through its coder chain.
 *
 * The chain is a graph, not a line: a coder input is fed either by another
 * coder's output (a bind pair) or straight from one of the folder's packed
 * streams, and BCJ2 has four inputs of which three are usually other coders and
 * one is packed. Resolving each input separately rather than assuming "the
 * previous coder's output" is what makes the branching case work.
 *
 * @param {Uint8Array|Uint8Array[]} packed  one stream, or the folder's packed
 *   streams in `packedIndices` order
 * @param {object} folder
 * @param {number} maxBytes
 * @returns {Uint8Array}
 */
export function decodeFolder(packed, folder, maxBytes) {
  const packedStreams = Array.isArray(packed) ? packed : [packed]
  if (packedStreams.length !== folder.packedIndices.length) {
    throw new SevenZipError('7z folder 的封裝串流數量與標頭不符')
  }

  // Coders are listed in no particular order; the bind pairs say which output
  // feeds which input. Running them in array order happens to work for a
  // single coder and is wrong for every chain — a BCJ+LZMA2 folder lists the
  // filter first, but the packed bytes go to LZMA2.
  const inStart = []
  const outStart = []
  let ins = 0
  let outs = 0
  for (const c of folder.coders) {
    inStart.push(ins)
    outStart.push(outs)
    ins += c.numIn
    outs += c.numOut
  }
  /** @param {number} globalOut */
  const coderForOut = (globalOut) =>
    folder.coders.findIndex((c, i) =>
      globalOut >= outStart[i] && globalOut < outStart[i] + c.numOut)

  let finalOut = -1
  for (let o = 0; o < outs; o++) {
    if (!folder.bindPairs.some((bp) => bp.outIndex === o)) { finalOut = o; break }
  }
  if (finalOut < 0) throw new SevenZipError('7z folder 沒有輸出串流')

  const depth = { n: 0 }
  /**
   * @param {number} coderIdx
   * @returns {Uint8Array}
   */
  const run = (coderIdx) => {
    if (++depth.n > 16) throw new SevenZipError('7z coder 鏈過深或成環')
    const coder = folder.coders[coderIdx]

    /** @param {number} globalIn @returns {Uint8Array} */
    const input = (globalIn) => {
      const bind = folder.bindPairs.find((bp) => bp.inIndex === globalIn)
      if (bind) return run(coderForOut(bind.outIndex))
      const k = folder.packedIndices.indexOf(globalIn)
      if (k < 0) throw new SevenZipError('7z folder 的輸入串流沒有來源')
      return packedStreams[k]
    }

    const size = folder.unpackSizes[outStart[coderIdx]]

    if (coder.id === CODER_BCJ2) {
      if (coder.numIn !== 4) {
        throw new SevenZipError('7z BCJ2 的輸入串流數量不是四個', 'corrupt')
      }
      // Checked before the sub-streams are decoded: an oversized declaration
      // should not first cost three LZMA decodes' worth of memory.
      if (size > maxBytes) {
        throw new SevenZipError('7z 解壓縮結果超過允許的大小上限', 'limit')
      }
      return bcj2Decode(
        Array.from({ length: 4 }, (_, i) => input(inStart[coderIdx] + i)),
        size, maxBytes)
    }

    const sources = Array.from({ length: coder.numIn },
      (_, i) => input(inStart[coderIdx] + i))
    const source = sources[0]
    if (coder.numIn !== 1) {
      const name = KNOWN_UNSUPPORTED[coder.id]
      throw new SevenZipError(
        `7z 使用了多輸入的 ${name ?? coder.id} 編碼，此讀取器不支援`, 'unsupported')
    }

    if (coder.id === CODER_COPY) return source
    if (coder.id === CODER_BCJ_X86) return bcjX86Decode(source)
    // Decoder failures are re-thrown as 7z errors: a caller branching on the
    // code should not have to know which decoder happened to be in the chain.
    try {
      if (coder.id === CODER_LZMA1) {
        if (!coder.props?.length) throw new SevenZipError('7z LZMA coder 缺少屬性')
        return decodeLzmaRaw(source, { props: coder.props[0], unpackSize: size, maxBytes })
      }
      if (coder.id === CODER_LZMA2) return decodeLzma2Raw(source, { maxBytes })
    } catch (err) {
      if (err instanceof SevenZipError) throw err
      if (err instanceof LzmaError) {
        throw new SevenZipError(err.message, /大小上限/.test(err.message) ? 'limit' : 'corrupt')
      }
      throw new SevenZipError(`7z 解碼失敗：${err instanceof Error ? err.message : err}`)
    }

    const name = KNOWN_UNSUPPORTED[coder.id]
    const code = coder.id === '06f10701' ? 'encrypted' : 'unsupported'
    throw new SevenZipError(
      name
        ? `7z 使用了 ${name} 編碼，此讀取器不支援`
        : `7z 使用了不支援的編碼（id ${coder.id}）`,
      code)
  }

  const data = run(coderForOut(finalOut))

  if (data.length > maxBytes) {
    throw new SevenZipError('7z 解壓縮結果超過允許的大小上限', 'limit')
  }
  return data
}

/**
 * @param {Reader} r
 * @param {number} size  byte length of the property, including the external flag
 * @returns {string[]}
 */
function readNames(r, size) {
  const external = r.byte()
  if (external !== 0) {
    throw new SevenZipError('7z 使用了外部檔名表，此讀取器不支援', 'unsupported')
  }
  const raw = r.bytes(size - 1)
  // One UTF-16LE run of NUL-terminated names, back to back.
  const text = Buffer.from(raw).toString('utf16le')
  const names = text.split('\0')
  if (names.length && names[names.length - 1] === '') names.pop()
  return names
}

/**
 * @param {Reader} r
 */
function readFilesInfo(r) {
  const numFiles = r.number()
  // Every entry costs at least a two-byte UTF-16 name terminator, so a count
  // larger than the header can describe is a lie — and acting on it allocates
  // several arrays of that size before any entry limit is consulted.
  if (numFiles > r.remaining / 2) {
    throw new SevenZipError('7z 標頭宣告的檔案數超出檔案內容')
  }
  /** @type {string[]} */
  let names = []
  /** @type {boolean[]|null} */
  let emptyStream = null
  /** @type {boolean[]|null} */
  let emptyFile = null
  /** @type {(number|null)[]|null} */
  let mtimes = null
  /** @type {(number|null)[]|null} */
  let attributes = null

  for (;;) {
    const type = r.number()
    if (type === kEnd) break
    const size = r.number()
    const next = r.pos + size

    if (type === kName) {
      names = readNames(r, size)
    } else if (type === kEmptyStream) {
      emptyStream = r.bits(numFiles)
    } else if (type === kEmptyFile) {
      const numEmpty = (emptyStream ?? []).filter(Boolean).length
      emptyFile = r.bits(numEmpty)
    } else if (type === kMTime) {
      const defined = r.boolsWithAllDefined(numFiles)
      if (r.byte() !== 0) throw new SevenZipError('7z 使用了外部時間表，此讀取器不支援', 'unsupported')
      mtimes = []
      for (let i = 0; i < numFiles; i++) {
        mtimes.push(defined[i] ? r.uint64() : null)
      }
    } else if (type === kAttributes) {
      const defined = r.boolsWithAllDefined(numFiles)
      if (r.byte() !== 0) throw new SevenZipError('7z 使用了外部屬性表，此讀取器不支援', 'unsupported')
      attributes = []
      for (let i = 0; i < numFiles; i++) {
        attributes.push(defined[i] ? r.uint32() : null)
      }
    } else if (type === kDummy) {
      // Padding, deliberately ignored.
    }
    r.pos = next
  }

  return { numFiles, names, emptyStream, emptyFile, mtimes, attributes }
}

/**
 * Windows FILETIME (100ns since 1601) to an ISO timestamp.
 * @param {number|null} ft
 */
function filetimeToIso(ft) {
  if (!ft) return new Date(0).toISOString()
  const ms = ft / 10000 - 11644473600000
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(0).toISOString()
}

/**
 * Parse a 7z archive's structure.
 *
 * @param {Uint8Array} buf
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ entries: Array<{path: string, size: number, mtime: string, isDirectory: boolean,
 *             folderIndex: number|null, offsetInFolder: number}>, streams: object }}
 */
export function parse7z(buf, opts = {}) {
  const maxBytes = opts.maxBytes ?? 268_435_456
  if (!is7z(buf)) throw new SevenZipError('不是 7z 檔（magic 不符）', 'unsupported')

  const sig = new Reader(buf.subarray(12, SIGNATURE_HEADER_SIZE))
  const nextHeaderOffset = sig.uint64()
  const nextHeaderSize = sig.uint64()

  const headerStart = SIGNATURE_HEADER_SIZE + nextHeaderOffset
  if (headerStart + nextHeaderSize > buf.length) {
    throw new SevenZipError('7z 標頭超出檔案範圍')
  }
  if (nextHeaderSize === 0) return { entries: [], streams: null }

  let header = new Reader(buf.subarray(headerStart, headerStart + nextHeaderSize))
  let id = header.number()

  if (id === kEncodedHeader) {
    // The header is itself a compressed folder, so it has to be decoded before
    // anything else can be read.
    const info = readStreamsInfo(header)
    const folder = info.folders[0]
    if (!folder) throw new SevenZipError('7z 壓縮標頭缺少 folder')
    const packed = folderPackedStreams(buf, info, 0)
    const decoded = decodeFolder(packed, folder, maxBytes)
    header = new Reader(decoded)
    id = header.number()
  }

  if (id !== kHeader) throw new SevenZipError('7z 標頭格式無法辨識')

  /** @type {ReturnType<typeof readStreamsInfo>|null} */
  let streams = null
  /** @type {ReturnType<typeof readFilesInfo>|null} */
  let files = null

  for (;;) {
    const prop = header.number()
    if (prop === kEnd) break
    if (prop === kMainStreamsInfo) streams = readStreamsInfo(header)
    else if (prop === kFilesInfo) files = readFilesInfo(header)
    else header.skipProperty()
  }

  if (!files) return { entries: [], streams }

  // Files with no stream are directories, or empty files when flagged.
  const entries = []
  let streamIdx = 0
  let emptyIdx = 0
  /** @type {{folder: number, offset: number}[]} */
  const streamPositions = []
  if (streams) {
    streams.subStreams.sizes.forEach((sizes, folderIdx) => {
      let offset = 0
      sizes.forEach((s, j) => {
        streamPositions.push({
          folder: folderIdx,
          offset,
          size: s,
          crc: streams.subStreams.crcs?.[folderIdx]?.[j] ?? null,
        })
        offset += s
      })
    })
  }

  for (let i = 0; i < files.numFiles; i++) {
    const hasStream = !(files.emptyStream?.[i])
    const name = (files.names[i] ?? `entry-${i}`).replace(/\\/g, '/')
    const mtime = filetimeToIso(files.mtimes?.[i] ?? null)

    if (hasStream) {
      const pos = streamPositions[streamIdx++]
        ?? { folder: null, offset: 0, size: 0, crc: null }
      entries.push({
        path: name,
        size: pos.size,
        mtime,
        isDirectory: false,
        folderIndex: pos.folder,
        offsetInFolder: pos.offset,
        crc: pos.crc,
      })
    } else {
      const isEmptyFile = Boolean(files.emptyFile?.[emptyIdx])
      emptyIdx++
      entries.push({
        path: name,
        size: 0,
        mtime,
        isDirectory: !isEmptyFile,
        folderIndex: null,
        offsetInFolder: 0,
      })
    }
  }

  return { entries, streams }
}

/**
 * Packed bytes for one folder.
 *
 * @param {Uint8Array} buf
 * @param {object} streams
 * @param {number} folderIndex
 * @returns {Uint8Array}
 */
export function folderPackedBytes(buf, streams, folderIndex) {
  return folderPackedStreams(buf, streams, folderIndex)[0]
}

/**
 * All of a folder's packed streams, in `packedIndices` order.
 *
 * Pack streams are laid out end to end across the whole archive and handed to
 * folders in order, so a folder's own streams are found by skipping however
 * many the folders before it claimed — a folder with one input is the common
 * case, not the rule.
 *
 * @param {Uint8Array} buf
 * @param {object} streams
 * @param {number} folderIndex
 * @returns {Uint8Array[]}
 */
export function folderPackedStreams(buf, streams, folderIndex) {
  let packStreamIdx = 0
  for (let i = 0; i < folderIndex; i++) {
    packStreamIdx += streams.folders[i].packedIndices.length
  }
  let start = SIGNATURE_HEADER_SIZE + streams.packInfo.packPos
  for (let i = 0; i < packStreamIdx; i++) start += streams.packInfo.packSizes[i]

  const count = streams.folders[folderIndex].packedIndices.length
  /** @type {Uint8Array[]} */
  const out = []
  for (let i = 0; i < count; i++) {
    const size = streams.packInfo.packSizes[packStreamIdx + i]
    if (size == null || start + size > buf.length) {
      throw new SevenZipError('7z 的封裝串流超出檔案範圍')
    }
    out.push(buf.subarray(start, start + size))
    start += size
  }
  return out
}

/**
 * Extract one entry's bytes.
 *
 * A folder decodes as a unit, so pulling one file out of a solid archive
 * necessarily decodes its whole folder; the slice comes afterwards.
 *
 * @param {Uint8Array} buf
 * @param {object} parsed  result of parse7z
 * @param {string} path
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Uint8Array}
 */
export function extract7zEntry(buf, parsed, path, opts = {}) {
  const maxBytes = opts.maxBytes ?? 268_435_456
  const entry = parsed.entries.find((e) => e.path === path && !e.isDirectory)
  if (!entry) throw new SevenZipError(`7z 內找不到項目：${path}`, 'corrupt')
  if (entry.folderIndex === null) return new Uint8Array(0)

  const folder = parsed.streams.folders[entry.folderIndex]
  const packed = folderPackedStreams(buf, parsed.streams, entry.folderIndex)
  const decoded = decodeFolder(packed, folder, maxBytes)
  const out = decoded.subarray(entry.offsetInFolder, entry.offsetInFolder + entry.size)

  if (entry.crc != null && crc32(out) !== entry.crc) {
    throw new SevenZipError(`7z 項目 CRC 不符，檔案可能已損毀：${path}`, 'corrupt')
  }
  return out
}
