/**
 * @file encoding.js
 * @description Deciding what encoding a file is in, and writing it back the same way.
 *
 *   Getting this wrong is silent: the file opens, the text looks plausible,
 *   and the damage only shows up in whatever tool opens it next. So the order
 *   here is deliberate — a byte-order mark is a statement of fact and wins
 *   outright; a buffer that decodes cleanly as UTF-8 is treated as UTF-8; and
 *   only then is chardet asked, whose answer is a guess and is checked before
 *   it is used.
 */
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const chardet = require('chardet')
const iconv = require('iconv-lite')

/**
 * Encoding names carrying an explicit BOM. iconv does not know these; they are
 * unwrapped here.
 *
 * The suffix exists so the mark survives a round trip. It is not decoration:
 * dropping the BOM from a UTF-8 file changes how Excel, MSBuild and a good
 * deal of Windows tooling read it, and adding one to a file that had none can
 * break a shell script's shebang. Either way the user never asked for it.
 */
const BOM_SUFFIX = '-BOM'

/** @type {Array<{bytes: number[], encoding: string}>} */
const BOMS = [
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'UTF-32BE' },
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'UTF-32LE' },
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'UTF-8' },
  { bytes: [0xfe, 0xff], encoding: 'UTF-16BE' },
  { bytes: [0xff, 0xfe], encoding: 'UTF-16LE' },
]

/**
 * Identify a leading byte-order mark.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {{ encoding: string, length: number }|null}
 */
export function detectBom(buffer) {
  if (!buffer || buffer.length < 2) return null
  for (const { bytes, encoding } of BOMS) {
    if (buffer.length < bytes.length) continue
    if (bytes.every((b, i) => buffer[i] === b)) {
      return { encoding, length: bytes.length }
    }
  }
  return null
}

/**
 * Whether every byte in the buffer forms a well-formed UTF-8 sequence.
 *
 * This is the check that makes a guess safe to reject. chardet answers UTF-8
 * readily for a short sample, and decoding non-UTF-8 bytes as UTF-8 does not
 * fail — it substitutes U+FFFD, so a Big5 file opens as a page of question
 * marks with nothing reported as wrong. Overlong forms and surrogate
 * code points are rejected too, since accepting them is how a validator gets
 * used to smuggle bytes past something downstream.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {boolean}
 */
export function isValidUtf8(buffer) {
  if (!buffer) return true
  let i = 0
  const n = buffer.length
  while (i < n) {
    const b = buffer[i]
    if (b < 0x80) { i++; continue }

    let need
    let cp
    if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0x0f }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x07 }
    else return false // 0x80-0xBF stray continuation, 0xC0/0xC1 overlong, 0xF5+ out of range

    if (i + need >= n) return false // truncated sequence at the end
    for (let k = 1; k <= need; k++) {
      const c = buffer[i + k]
      if ((c & 0xc0) !== 0x80) return false
      cp = (cp << 6) | (c & 0x3f)
    }
    if (need === 2 && cp < 0x800) return false // overlong
    if (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) return false
    if (cp >= 0xd800 && cp <= 0xdfff) return false // lone surrogate
    i += need + 1
  }
  return true
}

/**
 * Whether the buffer holds any byte a single-byte encoding would treat
 * differently from UTF-8. Pure ASCII decodes identically either way, so
 * naming a specific encoding for it would be inventing information.
 *
 * @param {Buffer|Uint8Array} buffer
 */
function hasNonAscii(buffer) {
  for (let i = 0; i < buffer.length; i++) if (buffer[i] >= 0x80) return true
  return false
}

/**
 * Ask chardet, and refuse an answer the bytes contradict.
 *
 * @param {Buffer} buffer
 * @returns {{ encoding: string, confidence: number }}
 */
function guessEncoding(buffer) {
  const utf8Possible = isValidUtf8(buffer)
  let candidates = []
  try {
    candidates = chardet.analyse(buffer) ?? []
  } catch {
    candidates = []
  }

  for (const c of candidates) {
    const name = c?.name
    if (!name || !iconv.encodingExists(name)) continue
    // A UTF-8 answer for bytes that are not valid UTF-8 is simply wrong, and
    // acting on it produces replacement characters rather than an error.
    if (/^utf-?8$/i.test(name) && !utf8Possible) continue
    return { encoding: name, confidence: c.confidence ?? 0 }
  }
  return { encoding: utf8Possible ? 'UTF-8' : 'windows-1252', confidence: 0 }
}

/**
 * Decode a buffer, deciding the encoding unless told.
 *
 * @param {Buffer} buffer
 * @param {string} [forced] an encoding the user picked, which always wins
 * @returns {{ content: string, encoding: string, detected: boolean,
 *             confidence: number, hasBom: boolean }}
 */
export function decodeBuffer(buffer, forced) {
  if (!buffer || buffer.length === 0) {
    return {
      content: '',
      encoding: forced || 'UTF-8',
      detected: false,
      confidence: 0,
      hasBom: false,
    }
  }

  if (forced) {
    const { base, bom } = splitBomName(forced)
    if (iconv.encodingExists(base)) {
      return {
        content: iconv.decode(buffer, base),
        encoding: forced,
        detected: false,
        confidence: 100,
        hasBom: bom || Boolean(detectBom(buffer)),
      }
    }
  }

  // A mark is not a guess. iconv strips it on decode, so it has to be recorded
  // here or it is lost by the time anything writes the file back.
  const bom = detectBom(buffer)
  if (bom && iconv.encodingExists(bom.encoding)) {
    return {
      content: iconv.decode(buffer, bom.encoding),
      encoding: bom.encoding + BOM_SUFFIX,
      detected: true,
      confidence: 100,
      hasBom: true,
    }
  }

  // Valid UTF-8 with a multi-byte sequence in it is UTF-8 in practice: no
  // other common encoding produces well-formed UTF-8 by chance at any length.
  if (isValidUtf8(buffer)) {
    if (!hasNonAscii(buffer)) {
      // Pure ASCII. Every candidate agrees, so say the neutral one and admit
      // the detection carried no information.
      return {
        content: iconv.decode(buffer, 'UTF-8'),
        encoding: 'UTF-8',
        detected: true,
        confidence: 0,
        hasBom: false,
      }
    }
    return {
      content: iconv.decode(buffer, 'UTF-8'),
      encoding: 'UTF-8',
      detected: true,
      confidence: 100,
      hasBom: false,
    }
  }

  const { encoding, confidence } = guessEncoding(buffer)
  return {
    content: iconv.decode(buffer, encoding),
    encoding,
    detected: true,
    confidence,
    hasBom: false,
  }
}

/**
 * Split an encoding name into its iconv name and whether a BOM goes with it.
 * @param {string} name
 * @returns {{ base: string, bom: boolean }}
 */
export function splitBomName(name) {
  const s = String(name ?? '')
  if (s.toUpperCase().endsWith(BOM_SUFFIX)) {
    return { base: s.slice(0, -BOM_SUFFIX.length), bom: true }
  }
  return { base: s, bom: false }
}

/**
 * Encodings offered in the manual picker.
 *
 * The `-BOM` variants are listed separately because whether a file carries a
 * mark is a property the user may need to control, not an implementation
 * detail of the encoding.
 *
 * @type {string[]}
 */
export const COMMON_ENCODINGS = [
  'UTF-8', 'UTF-8-BOM', 'UTF-16LE', 'UTF-16LE-BOM', 'UTF-16BE', 'UTF-16BE-BOM',
  'Big5', 'GBK', 'GB18030',
  'Shift_JIS', 'EUC-JP', 'EUC-KR',
  'windows-1252', 'ISO-8859-1',
]

/**
 * Encode a string for writing, in the encoding the file came in as.
 *
 * Writing UTF-8 unconditionally turns a Big5 or Shift-JIS file into mojibake
 * in every other tool, and does it silently. An unknown encoding falls back to
 * UTF-8 rather than refusing, since by this point the user has already
 * committed to saving.
 *
 * @param {string} content
 * @param {string} [encoding] as returned by decodeBuffer, `-BOM` suffix and all
 * @returns {Buffer}
 */
export function encodeContent(content, encoding = 'UTF-8') {
  const { base, bom } = splitBomName(encoding)
  const target = base && iconv.encodingExists(base) ? base : 'UTF-8'
  // addBOM is iconv's own option, so the mark matches the target encoding
  // rather than being pasted on as fixed bytes.
  return iconv.encode(content ?? '', target, bom ? { addBOM: true } : undefined)
}
