/**
 * HexCompare — Hex 二進位比對視圖
 * src/renderer/src/views/hex-compare.js
 *
 * 依規格實作：
 *  - Virtual scroll（ROW_HEIGHT = 20px）
 *  - 左右 pane 同步捲動
 *  - Byte-by-byte diff（按 offset 對齊）
 *  - 最大 10MB；超過截斷並顯示警告
 *  - 動態注入 CSS
 *  - 無外部套件，純 DOM API
 *  - T10: Ctrl+F 搜尋 hex/ASCII（find bar）
 *  - T11: Offset 跳轉（goto-offset input）
 */

import { showContextMenu, closeContextMenu } from '../core/context-menu.js'
import { el, formatSize } from '../core/utils.js'
import { isActive } from '../core/active-view.js'
import { renderTextTable, reportHeader } from '../core/report.js'
import { tagConfig, readConfig } from '../core/named-config-store.js'
import { stepDiffIndex, navResult, getNavOptions } from '../core/diff-nav.js'
import { SettingsStore } from '../core/settings-store.js'
import { toast } from '../core/toast.js'
import '../styles/hex-compare.css'

const _settings = new SettingsStore()

/** @typedef {import('../core/diff-nav.js').NavResult} NavResult */

// ── Constants ─────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 20            // px，固定列高
const MAX_BYTES  = 10_485_760    // 10 MB

/**
 * Edit-distance budget for Complete-mode byte diff. Myers back-trace keeps
 * one trimmed V snapshot per round, so trace memory is ~4·(D+1)² bytes —
 * 4096 ⇒ ~67 MB worst case, reached only when the two files genuinely differ
 * by that many bytes after prefix/suffix trimming.
 */
const HEX_COMPLETE_MAX_D = 4096

/** P2-22: cap on the undo and redo stacks (each). */
const MAX_UNDO_STACK = 500

/** P2-22: how long re-colouring waits after the last keystroke, in ms. */
const EDIT_REFLOW_MS = 120

// S14-M10: rAF throttle — coalesce calls to the next animation frame.
function _rafThrottle(fn) {
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => { scheduled = false; fn() })
  }
}

// ── Pure Functions (exported for unit testing) ────────────────────────────────

/**
 * 在 haystack 中搜尋 needle 的所有命中 offset（KMP-style 暴力搜尋）
 * @param {Uint8Array} haystack
 * @param {Uint8Array} needle
 * @returns {number[]} 命中起始 offset 陣列
 */
/**
 * T78 — Complete-mode byte diff. Runs an LCS-style alignment over two
 * byte arrays and returns a map from "left offset" → 'same'|'diff' and
 * "right offset" → 'same'|'diff'. Insert/Delete bytes (i.e. bytes that
 * have no aligned partner) are classified as 'diff'.
 *
 * Implemented as: common prefix/suffix trim, then Myers O(ND) over the
 * differing middle region with a bounded edit-distance budget. Memory is
 * O(D²) rather than O(n·m), so multi-MB inputs are safe.
 *
 * If the edit distance exceeds `maxEditDistance`, the middle region degrades
 * to a positional byte compare and `truncated: true` is returned.
 *
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @param {{ maxEditDistance?: number }} [opts]
 * @returns {{ leftClass: Uint8Array, rightClass: Uint8Array, truncated: boolean }} 0=same, 1=diff
 */
export function hexCompleteByteDiff(left, right, opts = {}) {
  const n = left.length
  const m = right.length
  const leftClass  = new Uint8Array(n)
  const rightClass = new Uint8Array(m)
  // Default everything to 'diff'; matched pairs get flipped to 'same' below.
  leftClass.fill(1)
  rightClass.fill(1)

  // ── Trim common prefix / suffix. For binaries this usually removes the
  //    overwhelming majority of the input, keeping Myers cheap. ──
  const minLen = n < m ? n : m
  let pre = 0
  while (pre < minLen && left[pre] === right[pre]) {
    leftClass[pre] = 0
    rightClass[pre] = 0
    pre++
  }
  let suf = 0
  while (suf < minLen - pre && left[n - 1 - suf] === right[m - 1 - suf]) {
    leftClass[n - 1 - suf] = 0
    rightClass[m - 1 - suf] = 0
    suf++
  }

  const aLen = n - suf - pre
  const bLen = m - suf - pre
  if (aLen === 0 || bLen === 0) {
    return { leftClass, rightClass, truncated: false }
  }

  const a = left.subarray(pre, pre + aLen)
  const b = right.subarray(pre, pre + bLen)
  const maxD = opts.maxEditDistance ?? HEX_COMPLETE_MAX_D
  const matches = _myersBytes(a, b, maxD)

  if (matches === null) {
    // Budget exhausted — fall back to a positional compare over the middle.
    const lim = aLen < bLen ? aLen : bLen
    for (let i = 0; i < lim; i++) {
      if (a[i] === b[i]) {
        leftClass[pre + i] = 0
        rightClass[pre + i] = 0
      }
    }
    return { leftClass, rightClass, truncated: true }
  }

  for (let i = 0; i < matches.length; i += 2) {
    leftClass[pre + matches[i]] = 0
    rightClass[pre + matches[i + 1]] = 0
  }
  return { leftClass, rightClass, truncated: false }
}

/**
 * Myers O(ND) diff over two byte arrays.
 *
 * Per-round V snapshots are stored trimmed to the reachable diagonal band
 * (2d+1 entries), so total trace memory is ~4·(D+1)² bytes instead of the
 * O(D·(N+M)) a full-width snapshot would cost.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {number} maxD  edit-distance budget; returns null when exceeded
 * @returns {Int32Array|null} flat [aIdx, bIdx, aIdx, bIdx, …] matched pairs
 */
function _myersBytes(a, b, maxD) {
  const N = a.length
  const M = b.length
  const limit = Math.min(maxD, N + M)
  const off = limit + 1
  const V = new Int32Array(2 * limit + 3)
  /** @type {Int32Array[]} */
  const trace = []
  let found = -1

  outer: for (let d = 0; d <= limit; d++) {
    // Snapshot of V as it stands after d-1 rounds, trimmed to k ∈ [-d, d].
    trace.push(V.slice(off - d, off + d + 1))
    for (let k = -d; k <= d; k += 2) {
      const ki = k + off
      let x
      if (k === -d || (k !== d && V[ki - 1] < V[ki + 1])) {
        x = V[ki + 1] // move down (insert)
      } else {
        x = V[ki - 1] + 1 // move right (delete)
      }
      let y = x - k
      while (x < N && y < M && a[x] === b[y]) {
        x++
        y++
      }
      V[ki] = x
      if (x >= N && y >= M) {
        found = d
        break outer
      }
    }
  }
  if (found < 0) return null

  // Back-trace. Matches are collected in reverse; order is irrelevant to the
  // caller, which only uses them to flip classification bits.
  const matches = new Int32Array(2 * Math.min(N, M))
  let count = 0
  let x = N
  let y = M
  for (let d = found; d > 0; d--) {
    const Vprev = trace[d] // index of diagonal k is (k + d)
    const k = x - y
    const prevK = (k === -d || (k !== d && Vprev[k - 1 + d] < Vprev[k + 1 + d]))
      ? k + 1
      : k - 1
    const prevX = Vprev[prevK + d]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      matches[count++] = x
      matches[count++] = y
    }
    if (x === prevX) y--
    else x--
  }
  while (x > 0 && y > 0) {
    x--
    y--
    matches[count++] = x
    matches[count++] = y
  }
  return matches.subarray(0, count)
}

/**
 * S16 — Aggregate differing byte offsets into contiguous "difference regions".
 *
 * Navigation works on regions rather than raw bytes because a single logical
 * edit in a binary usually spans many consecutive bytes; stepping byte-by-byte
 * would make Next Difference useless on real files.
 *
 * Offsets past the end of one side count as differing (orphan bytes) in Fast
 * mode. In Complete mode the caller supplies the pre-computed classifications,
 * so a byte that Myers matched at a shifted position is *not* a difference even
 * though the two sides disagree positionally.
 *
 * @param {Uint8Array|null} left
 * @param {Uint8Array|null} right
 * @param {{ leftClass?: Uint8Array|null, rightClass?: Uint8Array|null }} [opts]
 * @returns {Array<{ start: number, end: number, length: number }>} end is exclusive
 */
export function computeHexDiffRegions(left, right, opts = {}) {
  const lLen = left ? left.length : 0
  const rLen = right ? right.length : 0
  const lc = opts.leftClass ?? null
  const rc = opts.rightClass ?? null
  const useClass = lc !== null && rc !== null

  const maxLen = lLen > rLen ? lLen : rLen
  /** @type {Array<{ start: number, end: number, length: number }>} */
  const regions = []
  if (maxLen === 0) return regions

  let start = -1
  for (let o = 0; o < maxLen; o++) {
    let isDiff
    if (useClass) {
      isDiff = (o < lc.length && lc[o] === 1) || (o < rc.length && rc[o] === 1)
    } else if (o >= lLen || o >= rLen) {
      isDiff = true
    } else {
      isDiff = left[o] !== right[o]
    }

    if (isDiff) {
      if (start < 0) start = o
    } else if (start >= 0) {
      regions.push({ start, end: o, length: o - start })
      start = -1
    }
  }
  if (start >= 0) {
    regions.push({ start, end: maxLen, length: maxLen - start })
  }
  return regions
}

export function searchHexBytes(haystack, needle) {
  /** @type {number[]} */
  const results = []
  if (!haystack || !needle || needle.length === 0 || haystack.length < needle.length) {
    return results
  }
  const hLen = haystack.length
  const nLen = needle.length
  outer: for (let i = 0; i <= hLen - nLen; i++) {
    for (let j = 0; j < nLen; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    results.push(i)
  }
  return results
}

// ── P2-22: byte-level editing primitives (pure, exported for unit testing) ────

/**
 * A hex document: the bytes themselves plus a parallel "was this byte modified
 * by the user" flag array. The flags travel with the bytes through every splice
 * so that insert/delete keeps every marker attached to the byte it describes,
 * instead of to an offset that has since moved.
 *
 * @typedef {{ bytes: Uint8Array, flags: Uint8Array }} HexDoc
 */

/**
 * One reversible edit. `before`/`after` are the byte runs that occupy
 * [offset, offset + length) before and after the edit, so a single splice
 * expresses overwrite (equal lengths), insert (empty before) and delete
 * (empty after), and the inverse is obtained by swapping the two pairs.
 *
 * @typedef {{ offset: number, before: Uint8Array, beforeFlags: Uint8Array,
 *             after: Uint8Array, afterFlags: Uint8Array }} HexEdit
 */

/** @type {Uint8Array} */
const EMPTY_BYTES = new Uint8Array(0)

/**
 * @param {number} n
 * @returns {Uint8Array} n flags all set to "modified"
 */
function onesFlags(n) {
  const out = new Uint8Array(n)
  out.fill(1)
  return out
}

/**
 * Build a document, tolerating a missing or mis-sized flag array.
 * @param {Uint8Array|null} bytes
 * @param {Uint8Array|null} [flags]
 * @returns {HexDoc}
 */
export function makeHexDoc(bytes, flags = null) {
  const b = bytes ?? EMPTY_BYTES
  if (flags && flags.length === b.length) return { bytes: b, flags }
  const f = new Uint8Array(b.length)
  if (flags) f.set(flags.subarray(0, Math.min(flags.length, b.length)), 0)
  return { bytes: b, flags: f }
}

/**
 * Replace `removeCount` bytes at `offset` with `insertBytes`.
 *
 * Returns new arrays rather than mutating: the undo stack holds references to
 * byte runs, and an in-place edit would rewrite history.
 *
 * @param {HexDoc} doc
 * @param {number} offset
 * @param {number} removeCount
 * @param {Uint8Array|null} [insertBytes]
 * @param {Uint8Array|null} [insertFlags]
 * @returns {HexDoc}
 */
export function spliceHexDoc(doc, offset, removeCount, insertBytes = null, insertFlags = null) {
  const src = makeHexDoc(doc.bytes, doc.flags)
  const len = src.bytes.length
  const start = Math.max(0, Math.min(Math.trunc(offset), len))
  const remove = Math.max(0, Math.min(Math.trunc(removeCount), len - start))
  const ins = insertBytes ?? EMPTY_BYTES
  const insFlags = insertFlags && insertFlags.length === ins.length
    ? insertFlags
    : onesFlags(ins.length)

  const outLen = len - remove + ins.length
  const bytes = new Uint8Array(outLen)
  const flags = new Uint8Array(outLen)

  bytes.set(src.bytes.subarray(0, start), 0)
  flags.set(src.flags.subarray(0, start), 0)
  bytes.set(ins, start)
  flags.set(insFlags, start)
  bytes.set(src.bytes.subarray(start + remove), start + ins.length)
  flags.set(src.flags.subarray(start + remove), start + ins.length)

  return { bytes, flags }
}

/**
 * @param {HexDoc} doc
 * @param {number} offset
 * @param {Uint8Array|number[]} values
 * @returns {HexEdit|null} null when out of range or when nothing would change
 */
export function makeOverwriteEdit(doc, offset, values) {
  const src = makeHexDoc(doc.bytes, doc.flags)
  const after = Uint8Array.from(values)
  const start = Math.trunc(offset)
  if (after.length === 0) return null
  if (start < 0 || start + after.length > src.bytes.length) return null

  const before = src.bytes.slice(start, start + after.length)
  const beforeFlags = src.flags.slice(start, start + after.length)
  // Re-typing the value a byte already has, on a byte already marked, changes
  // nothing — recording it would put a no-op on the undo stack.
  let identical = true
  for (let i = 0; i < after.length; i++) {
    if (before[i] !== after[i] || beforeFlags[i] !== 1) { identical = false; break }
  }
  if (identical) return null

  return { offset: start, before, beforeFlags, after, afterFlags: onesFlags(after.length) }
}

/**
 * @param {HexDoc} doc
 * @param {number} offset  clamped to [0, length]; appending at the end is legal
 * @param {Uint8Array|number[]} values
 * @returns {HexEdit|null}
 */
export function makeInsertEdit(doc, offset, values) {
  const src = makeHexDoc(doc.bytes, doc.flags)
  const after = Uint8Array.from(values)
  if (after.length === 0) return null
  const start = Math.max(0, Math.min(Math.trunc(offset), src.bytes.length))
  return {
    offset: start,
    before: EMPTY_BYTES,
    beforeFlags: EMPTY_BYTES,
    after,
    afterFlags: onesFlags(after.length),
  }
}

/**
 * @param {HexDoc} doc
 * @param {number} offset
 * @param {number} [count=1]
 * @returns {HexEdit|null}
 */
export function makeDeleteEdit(doc, offset, count = 1) {
  const src = makeHexDoc(doc.bytes, doc.flags)
  const start = Math.trunc(offset)
  if (start < 0 || start >= src.bytes.length) return null
  const n = Math.max(0, Math.min(Math.trunc(count), src.bytes.length - start))
  if (n === 0) return null
  return {
    offset: start,
    before: src.bytes.slice(start, start + n),
    beforeFlags: src.flags.slice(start, start + n),
    after: EMPTY_BYTES,
    afterFlags: EMPTY_BYTES,
  }
}

/**
 * @param {HexDoc} doc
 * @param {HexEdit} edit
 * @returns {HexDoc}
 */
export function applyHexEdit(doc, edit) {
  return spliceHexDoc(doc, edit.offset, edit.before.length, edit.after, edit.afterFlags)
}

/**
 * @param {HexEdit} edit
 * @returns {HexEdit}
 */
export function invertHexEdit(edit) {
  return {
    offset: edit.offset,
    before: edit.after,
    beforeFlags: edit.afterFlags,
    after: edit.before,
    afterFlags: edit.beforeFlags,
  }
}

/**
 * Push onto a bounded stack, dropping the oldest entries when full.
 *
 * Bounded because each entry pins the byte runs it replaced; an unbounded
 * history of large-region edits would retain more memory than the file itself.
 *
 * @template T
 * @param {T[]} stack
 * @param {T} item
 * @param {number} limit
 * @returns {T[]} the same array, mutated
 */
export function pushBounded(stack, item, limit) {
  stack.push(item)
  if (limit > 0 && stack.length > limit) stack.splice(0, stack.length - limit)
  return stack
}

/**
 * Net change in the number of bytes marked modified.
 * @param {HexEdit} edit
 * @returns {number}
 */
export function modifiedDelta(edit) {
  let sum = 0
  for (let i = 0; i < edit.afterFlags.length; i++) sum += edit.afterFlags[i]
  for (let i = 0; i < edit.beforeFlags.length; i++) sum -= edit.beforeFlags[i]
  return sum
}

/**
 * @param {string} ch
 * @returns {number} 0–15, or -1 when not a hex digit
 */
export function hexNibbleValue(ch) {
  if (ch.length !== 1) return -1
  const code = ch.charCodeAt(0)
  if (code >= 48 && code <= 57) return code - 48        // 0-9
  if (code >= 97 && code <= 102) return code - 87       // a-f
  if (code >= 65 && code <= 70) return code - 55        // A-F
  return -1
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * 從 base64 字串解碼為 Uint8Array
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

/**
 * Bytes → a string whose char codes are the byte values, for a latin1 write.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads every byte onto the
 * argument stack and overflows well before the view's 10 MB limit.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToLatin1(bytes) {
  const CHUNK = 0x8000
  let out = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return out
}

/**
 * 將 byte 值格式化為 2 位大寫 hex，例如 255 → "FF"
 * @param {number} byte
 * @returns {string}
 */
function toHex(byte) {
  return byte.toString(16).toUpperCase().padStart(2, '0')
}

/**
 * 將 byte 值轉成可顯示的 ASCII 字元；控制字元及 >127 顯示 '.'
 * @param {number} byte
 * @returns {string}
 */
function toAsciiChar(byte) {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'
}

/**
 * 格式化 offset 為 8 位大寫 hex，例如 256 → "00000100"
 * @param {number} offset
 * @returns {string}
 */
function formatOffset(offset) {
  return offset.toString(16).toUpperCase().padStart(8, '0')
}

// ── Hex Details: numeric interpretations of the bytes under the cursor ────────

/**
 * @typedef {object} HexDetailRow
 * @property {string} key        stable identifier, used by tests and by the DOM
 * @property {string} label      display label
 * @property {string} value      formatted value, or the reason it is unreadable
 * @property {boolean} available false when the file ends before the type fits
 */

/**
 * Describe one byte as a character without pretending an unprintable byte is
 * one: BC shows a dot in the grid, but the details panel is where the user
 * comes precisely to find out *what* that dot is.
 *
 * @param {number} b
 * @returns {string}
 */
function describeChar(b) {
  if (b >= 0x20 && b <= 0x7e) return `'${String.fromCharCode(b)}'`
  if (b === 0x7f) return '控制字元 DEL (0x7F)'
  if (b < 0x20) return `控制字元 (0x${toHex(b)})`
  return `非 ASCII 位元組 (0x${toHex(b)})`
}

/**
 * @param {number} v
 * @returns {string}
 */
function formatFloat(v) {
  if (Number.isNaN(v)) return 'NaN'
  if (!Number.isFinite(v)) return v > 0 ? '+Infinity' : '-Infinity'
  // Object.is separates -0 from 0; String() would print both as "0" and hide
  // the sign bit, which is exactly the bit a hex editor user is inspecting.
  if (Object.is(v, -0)) return '-0'
  return String(v)
}

/**
 * Every numeric reading of the bytes starting at `offset`.
 *
 * A type that runs past the end of the data is reported as unavailable with
 * the shortfall spelled out — reading it from a zero-padded buffer would show
 * a number that is not in the file.
 *
 * @param {Uint8Array|null} bytes
 * @param {number} offset
 * @returns {HexDetailRow[]} empty when the offset is outside the data
 */
export function hexDetailRows(bytes, offset) {
  const len = bytes ? bytes.length : 0
  const idx = Math.trunc(offset)
  if (!bytes || len === 0 || !Number.isFinite(idx) || idx < 0 || idx >= len) return []

  const avail = Math.min(8, len - idx)
  // A fixed 8-byte window copied out of the source: DataView over the original
  // buffer would need byteOffset arithmetic and would happily read past the
  // logical end of a truncated view.
  const view = new DataView(new ArrayBuffer(8))
  for (let i = 0; i < avail; i++) view.setUint8(i, bytes[idx + i])

  /** @type {HexDetailRow[]} */
  const rows = []
  /**
   * @param {string} key
   * @param {string} label
   * @param {number} size
   * @param {() => string} read
   */
  const push = (key, label, size, read) => {
    rows.push(avail >= size
      ? { key, label, value: read(), available: true }
      : { key, label, value: `需要 ${size} 位元組，此位置只剩 ${avail}`, available: false })
  }

  const b = bytes[idx]
  rows.push({ key: 'hex', label: '位元組 (hex)', value: `0x${toHex(b)}`, available: true })
  rows.push({
    key: 'binary',
    label: '二進位',
    value: b.toString(2).padStart(8, '0').replace(/^(\d{4})(\d{4})$/, '$1 $2'),
    available: true,
  })
  rows.push({ key: 'octal', label: '八進位', value: `0o${b.toString(8).padStart(3, '0')}`, available: true })
  rows.push({ key: 'char', label: '字元', value: describeChar(b), available: true })

  push('int8', 'int8', 1, () => String(view.getInt8(0)))
  push('uint8', 'uint8', 1, () => String(view.getUint8(0)))
  push('int16le', 'int16 (LE)', 2, () => String(view.getInt16(0, true)))
  push('int16be', 'int16 (BE)', 2, () => String(view.getInt16(0, false)))
  push('uint16le', 'uint16 (LE)', 2, () => String(view.getUint16(0, true)))
  push('uint16be', 'uint16 (BE)', 2, () => String(view.getUint16(0, false)))
  push('int32le', 'int32 (LE)', 4, () => String(view.getInt32(0, true)))
  push('int32be', 'int32 (BE)', 4, () => String(view.getInt32(0, false)))
  push('uint32le', 'uint32 (LE)', 4, () => String(view.getUint32(0, true)))
  push('uint32be', 'uint32 (BE)', 4, () => String(view.getUint32(0, false)))
  push('int64le', 'int64 (LE)', 8, () => view.getBigInt64(0, true).toString())
  push('int64be', 'int64 (BE)', 8, () => view.getBigInt64(0, false).toString())
  push('uint64le', 'uint64 (LE)', 8, () => view.getBigUint64(0, true).toString())
  push('uint64be', 'uint64 (BE)', 8, () => view.getBigUint64(0, false).toString())
  push('float32le', 'float32 (LE)', 4, () => formatFloat(view.getFloat32(0, true)))
  push('float32be', 'float32 (BE)', 4, () => formatFloat(view.getFloat32(0, false)))
  push('float64le', 'float64 (LE)', 8, () => formatFloat(view.getFloat64(0, true)))
  push('float64be', 'float64 (BE)', 8, () => formatFloat(view.getFloat64(0, false)))

  return rows
}

/**
 * Column labels for the ruler above each pane.
 *
 * The hex side carries the full column index so a 32-byte row stays readable;
 * the ASCII side only has one character of width per byte, so it wraps at 16.
 *
 * @param {number} bytesPerRow
 * @returns {{ hex: string[], ascii: string[] }}
 */
export function rulerCells(bytesPerRow) {
  const bpr = Math.max(0, Math.trunc(bytesPerRow) || 0)
  /** @type {string[]} */
  const hex = []
  /** @type {string[]} */
  const ascii = []
  for (let i = 0; i < bpr; i++) {
    hex.push(i.toString(16).toUpperCase().padStart(2, '0'))
    ascii.push((i % 16).toString(16).toUpperCase())
  }
  return { hex, ascii }
}

// ── HexCompare Class ──────────────────────────────────────────────────────────

export class HexCompare {
  /**
   * @param {object} [options]
   * @param {number} [options.bytesPerRow=16]
   * @param {'fast'|'complete'} [options.diffAlgorithm='fast']
   * @param {boolean} [options.showDetails=false]   顯示 Hex Details 面板
   * @param {boolean} [options.showFileInfo=false]  顯示 File Info 面板
   * @param {boolean} [options.showRuler=false]     顯示欄位標尺
   */
  constructor(options = {}) {
    /** @type {number} */
    this._bytesPerRow = options.bytesPerRow ?? 16

    // T78: diff algorithm mode — 'fast' (linear byte equality) or 'complete' (LCS)
    /** @type {'fast'|'complete'} */
    this._diffAlgorithm = options.diffAlgorithm ?? 'fast'

    /** @type {Uint8Array|null} Cached complete-mode classifications (left) */
    this._completeLeftClass = null
    /** @type {Uint8Array|null} Cached complete-mode classifications (right) */
    this._completeRightClass = null

    /** @type {string|null} */
    this._leftPath = null
    /** @type {string|null} */
    this._rightPath = null

    /** @type {Uint8Array|null} */
    this._leftBytes = null
    /** @type {Uint8Array|null} */
    this._rightBytes = null

    /** @type {boolean} 超過 MAX_BYTES 截斷警告 */
    this._leftTruncated = false
    /** @type {boolean} */
    this._rightTruncated = false

    /** @type {number} 原始 byte 大小（截斷前） */
    this._leftOriginalSize  = 0
    /** @type {number} */
    this._rightOriginalSize = 0

    /** @type {boolean} 防止滾動同步迴圈 */
    this._syncingScroll = false

    /** @type {Record<string, Function[]>} */
    this._handlers = {}

    /** @type {HTMLElement|null} */
    this._container = null

    /** @type {Record<string, HTMLElement>} 快取 DOM 節點 */
    this._dom = {}

    /** @type {boolean} */
    this._styleInjected = false

    /** @type {HTMLLinkElement|null} */
    this._injectedStyleEl = null

    // S14-M10: rAF-throttled scroll handlers instead of trailing-edge debounce
    // — debounce drops events during fast wheel scrolling and shows blank rows.
    this._debouncedScrollLeft  = _rafThrottle(() => this._onScrollLeft())
    this._debouncedScrollRight = _rafThrottle(() => this._onScrollRight())

    // T10: Find bar state
    /**
     * @type {Array<{side: 'left'|'right', rowIndex: number, byteOffset: number}>}
     */
    this._findMatches = []
    /** @type {number} */
    this._findCurrentIdx = -1
    /** @type {Function|null} Ctrl+F keydown handler reference (for removeEventListener) */
    this._ctrlFHandler = null

    /** @type {(() => void)|null} Removes the drag & drop listeners on destroy */
    this._dropCleanup = null

    // S16: byte-level difference navigation
    /** @type {Array<{ start: number, end: number, length: number }>} */
    this._diffRegions = []
    /** @type {number} -1 = no region selected yet */
    this._currentDiffIdx = -1
    /** @type {boolean} set by setLeft/setRight, consumed after the next diff */
    this._pendingFirstDiff = false

    // P2-36: Show filter. Rows are filtered in the data layer rather than
    // hidden with CSS, because the virtual scroller derives both the scroll
    // height and every row's `top` from the row index — a display:none row
    // still occupies its slot in that arithmetic and would desynchronise the
    // two panes.
    /** @type {'all'|'diff'|'same'} */
    this._showFilter = 'all'
    /**
     * Source row indices that survive the filter, ascending. `null` means the
     * identity mapping, so the unfiltered case allocates nothing.
     * @type {Int32Array|null}
     */
    this._filteredRows = null
    /**
     * Source row → visual index. Hidden rows map to the nearest visible row at
     * or after them so that "go to offset" style jumps still land somewhere
     * sensible instead of failing.
     * @type {Int32Array|null}
     */
    this._rowToVisual = null

    // ── P2-22: byte editing ───────────────────────────────────────────────────
    /** @type {boolean} */
    this._editMode = false
    /**
     * Per-byte "modified" markers, parallel to _leftBytes / _rightBytes. Kept in
     * the data model rather than on the DOM nodes because the virtual scroller
     * throws rows away as soon as they leave the viewport.
     * @type {{ left: Uint8Array|null, right: Uint8Array|null }}
     */
    this._flags = { left: null, right: null }
    /** @type {{ left: number, right: number }} bytes currently marked modified */
    this._modifiedCount = { left: 0, right: 0 }
    /**
     * @type {{ side: 'left'|'right', offset: number, field: 'hex'|'ascii',
     *          nibble: 0|1 }|null}
     */
    this._cursor = null
    /** @type {Array<{ side: 'left'|'right', edit: HexEdit }>} */
    this._undoStack = []
    /** @type {Array<{ side: 'left'|'right', edit: HexEdit }>} */
    this._redoStack = []
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._reflowTimer = null
    /** @type {((e: Event) => void)|null} */
    this._closeGuard = null
    /** @type {((e: KeyboardEvent) => void)|null} */
    this._closeKeyGuard = null

    // ── P2-40: side panels ────────────────────────────────────────────────────
    /** @type {boolean} Hex Details（游標位元組的多種解讀） */
    this._showDetails = options.showDetails ?? false
    /** @type {boolean} File Info（路徑/大小/差異位元組數/是否截斷） */
    this._showFileInfo = options.showFileInfo ?? false
    /** @type {boolean} 欄位標尺 */
    this._showRuler = options.showRuler ?? false
    /**
     * mtime per path, filled in lazily from read-dir. Cached because the panel
     * repaints on every cursor move and re-listing the folder each time would
     * be an IPC round trip per keystroke.
     * @type {Map<string, string>}
     */
    this._mtimeCache = new Map()
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * 掛載至 containerEl
   * @param {HTMLElement} containerEl
   */
  mount(containerEl) {
    this._container = containerEl
    this._render()
    this._bindEvents()
  }

  /** 卸載並清除 DOM 及事件 */
  destroy() {
    closeContextMenu()
    if (this._ctrlFHandler) {
      document.removeEventListener('keydown', this._ctrlFHandler)
      this._ctrlFHandler = null
    }
    if (this._dropCleanup) {
      this._dropCleanup()
      this._dropCleanup = null
    }
    this._removeCloseGuards()
    if (this._reflowTimer !== null) {
      clearTimeout(this._reflowTimer)
      this._reflowTimer = null
    }
    // T27: 清除所有 hx-selected 高亮
    // S14-M04: scope to this container so we don't wipe highlights on other hex tabs.
    const scope = this._container ?? document
    scope.querySelectorAll('.hx-selected').forEach(el => el.classList.remove('hx-selected'))
    if (this._container) {
      this._container.innerHTML = ''
      this._container = null
    }
    this._handlers = {}
    if (this._injectedStyleEl) {
      this._injectedStyleEl.remove()
      this._injectedStyleEl = null
    }
    this._dom = {}
    this._leftBytes  = null
    this._rightBytes = null
    this._findMatches = []
    this._findCurrentIdx = -1
    this._diffRegions = []
    this._currentDiffIdx = -1
    this._filteredRows = null
    this._rowToVisual = null
    this._cursor = null
    this._undoStack = []
    this._redoStack = []
    this._flags = { left: null, right: null }
    this._modifiedCount = { left: 0, right: 0 }
  }

  /**
   * 開啟左側二進位檔案（呼叫 IPC）
   * @returns {Promise<void>}
   */
  async openLeft() {
    try {
      const result = await window.electronAPI.openFileBinary()
      if (!result) return
      this.setLeft(result.path, result.base64)
    } catch (err) {
      console.error('HexCompare openLeft error:', err)
    }
  }

  /**
   * 開啟右側二進位檔案（呼叫 IPC）
   * @returns {Promise<void>}
   */
  async openRight() {
    try {
      const result = await window.electronAPI.openFileBinary()
      if (!result) return
      this.setRight(result.path, result.base64)
    } catch (err) {
      console.error('HexCompare openRight error:', err)
    }
  }

  /**
   * 直接設定左側資料
   * @param {string} path
   * @param {string} base64
   */
  setLeft(path, base64) {
    this._leftPath = path
    const raw = base64ToBytes(base64)
    this._leftOriginalSize = raw.byteLength
    this._leftTruncated = raw.byteLength > MAX_BYTES
    this._leftBytes = this._leftTruncated ? raw.slice(0, MAX_BYTES) : raw
    this._resetEditState('left')
    this._pendingFirstDiff = true
    this._updatePathDisplay('left', path)
    this._updateSizeInfo()
    this.refresh()
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
  }

  /**
   * 直接設定右側資料
   * @param {string} path
   * @param {string} base64
   */
  setRight(path, base64) {
    this._rightPath = path
    const raw = base64ToBytes(base64)
    this._rightOriginalSize = raw.byteLength
    this._rightTruncated = raw.byteLength > MAX_BYTES
    this._rightBytes = this._rightTruncated ? raw.slice(0, MAX_BYTES) : raw
    this._resetEditState('right')
    this._pendingFirstDiff = true
    this._updatePathDisplay('right', path)
    this._updateSizeInfo()
    this.refresh()
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
  }

  /** 重新渲染兩側 pane */
  /** Focus the search box. The find bar is always visible in this view. */
  openFind() {
    const input = this._dom.findInput
    if (input) {
      input.focus()
      input.select()
    }
  }

  refresh() {
    this._recomputeCompleteIfNeeded()
    this._recomputeDiffRegions()
    if (this._showRuler) this._renderRulers()
    this._updateDetailsPanel()
    this._updateFileInfoPanel()
    requestAnimationFrame(() => {
      this._renderPaneContent('left')
      this._renderPaneContent('right')
    })
  }

  // ── Public: settings snapshot ───────────────────────────────────────────────

  /**
   * Snapshot of the view's comparison settings, for the named-config store.
   * Paths and file contents are deliberately excluded — a saved config is
   * meant to be applied to any pair of files.
   *
   * @returns {Record<string, unknown>}
   */
  getConfig() {
    return tagConfig('hex', {
      bytesPerRow: this._bytesPerRow,
      diffAlgorithm: this._diffAlgorithm,
      showFilter: this._showFilter,
      showDetails: this._showDetails,
      showFileInfo: this._showFileInfo,
      showRuler: this._showRuler,
    })
  }

  /**
   * @param {unknown} cfg
   */
  applyConfig(cfg) {
    const settings = readConfig('hex', cfg)
    if (!settings) return
    if ([8, 16, 32].includes(settings.bytesPerRow)) this._bytesPerRow = settings.bytesPerRow
    if (settings.diffAlgorithm === 'fast' || settings.diffAlgorithm === 'complete') {
      this._diffAlgorithm = settings.diffAlgorithm
    }
    if (['all', 'diff', 'same'].includes(settings.showFilter)) {
      this._showFilter = settings.showFilter
    }
    if (typeof settings.showDetails === 'boolean') this._showDetails = settings.showDetails
    if (typeof settings.showFileInfo === 'boolean') this._showFileInfo = settings.showFileInfo
    if (typeof settings.showRuler === 'boolean') this._showRuler = settings.showRuler
    this._applyPanelVisibility()
    this._syncConfigControls()
    this.refresh()
  }

  /** Reflect the applied settings back onto the toolbar controls. */
  _syncConfigControls() {
    const bpr = this._dom.bprSelect
    if (bpr) bpr.value = String(this._bytesPerRow)
    const algo = this._dom.algoSelect
    if (algo) algo.value = this._diffAlgorithm
    this._syncShowButtons()
  }

  // ── Public: reports ─────────────────────────────────────────────────────────

  /**
   * Summary statistics for the current comparison.
   * @returns {{ leftBytes: number, rightBytes: number, regions: number, diffBytes: number }}
   */
  getStats() {
    const regions = this._diffRegions ?? []
    return {
      leftBytes: this._leftBytes?.length ?? 0,
      rightBytes: this._rightBytes?.length ?? 0,
      regions: regions.length,
      diffBytes: regions.reduce((sum, r) => sum + r.length, 0),
    }
  }

  /**
   * Plain-text report of the differing regions.
   *
   * Regions rather than individual bytes, and capped, because a binary that
   * differs throughout would otherwise produce a report far larger than the
   * files themselves.
   *
   * @param {{ generatedAt?: Date, maxRegions?: number }} [opts]
   * @returns {string}
   */
  buildTextReport(opts = {}) {
    const maxRegions = opts.maxRegions ?? 500
    const stats = this.getStats()
    const header = reportHeader({
      title: 'Hex 比對報告',
      leftPath: this._leftPath,
      rightPath: this._rightPath,
      generatedAt: opts.generatedAt,
    })

    const summary = stats.regions === 0
      ? '無差異'
      : `差異區塊 ${stats.regions}，差異位元組 ${stats.diffBytes}` +
        `（左 ${stats.leftBytes} bytes，右 ${stats.rightBytes} bytes）`

    const shown = (this._diffRegions ?? []).slice(0, maxRegions)
    const rows = shown.map((r) => [
      `0x${r.start.toString(16).toUpperCase().padStart(8, '0')}`,
      String(r.length),
      this._bytesPreview(this._leftBytes, r),
      this._bytesPreview(this._rightBytes, r),
    ])

    const table = rows.length
      ? renderTextTable(
          [{ title: 'Offset' }, { title: '長度', align: 'right' },
           { title: '左' }, { title: '右' }],
          rows)
      : '（兩側內容相同）'

    const omitted = (this._diffRegions?.length ?? 0) - shown.length
    const note = omitted > 0 ? `\n\n（另有 ${omitted} 個差異區塊未列出）` : ''
    return `${header}${summary}\n\n${table}${note}\n`
  }

  /**
   * Hex preview of one region, clipped so a long run stays readable.
   * @param {Uint8Array|null} bytes
   * @param {{ start: number, end: number }} region
   * @returns {string}
   */
  _bytesPreview(bytes, region) {
    if (!bytes) return '（無）'
    const MAX = 8
    const end = Math.min(region.end, bytes.length)
    if (region.start >= end) return '（無）'
    const slice = bytes.subarray(region.start, Math.min(end, region.start + MAX))
    const hex = Array.from(slice, toHex).join(' ')
    return end - region.start > MAX ? `${hex} …` : hex
  }

  /**
   * Self-contained HTML report of the differing regions.
   *
   * Capped like the plain-text report, and for the same reason: a binary that
   * differs throughout would otherwise emit a document larger than the inputs.
   *
   * @param {{ generatedAt?: Date, maxRegions?: number }} [opts]
   * @returns {string}
   */
  buildHtmlReport(opts = {}) {
    const maxRegions = opts.maxRegions ?? 500
    const esc = (s) => String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const stats = this.getStats()
    const timestamp = (opts.generatedAt ?? new Date()).toLocaleString('zh-TW')

    const shown = (this._diffRegions ?? []).slice(0, maxRegions)
    const rows = shown.map((r) => `<tr>
  <td class="off">0x${r.start.toString(16).toUpperCase().padStart(8, '0')}</td>
  <td class="len">${r.length}</td>
  <td class="hex del">${esc(this._bytesPreview(this._leftBytes, r))}</td>
  <td class="hex ins">${esc(this._bytesPreview(this._rightBytes, r))}</td>
</tr>`).join('\n')

    const omitted = (this._diffRegions?.length ?? 0) - shown.length
    const note = omitted > 0
      ? `<p class="note">另有 ${omitted} 個差異區塊未列出。</p>`
      : ''
    const body = rows
      ? `<table>
<thead><tr><th>Offset</th><th>長度</th><th>左</th><th>右</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>${note}`
      : '<p class="note">兩側內容相同。</p>'

    return `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8">
<title>MyCompare — Hex 比對報告</title>
<style>
body{font-family:monospace;font-size:13px;background:#fff;color:#222;margin:16px}
h2{font-family:sans-serif;margin-bottom:4px}
.paths{font-family:sans-serif;font-size:12px;color:#666;margin-bottom:12px}
.report-stats{font-family:sans-serif;font-size:12px;display:flex;flex-wrap:wrap;
  gap:10px;padding:8px 12px;background:#f5f5f5;border:1px solid #ddd;
  border-radius:4px;margin-bottom:12px}
.report-stats .stat-mod{color:#996c00;font-weight:600}
.report-stats .stat-eq{color:#666;font-weight:600}
.report-stats .ts{margin-left:auto;color:#888}
.note{font-family:sans-serif;font-size:12px;color:#666}
table{border-collapse:collapse;width:100%}
th{background:#f0f0f0;border-bottom:2px solid #aaa;padding:2px 6px;text-align:left}
td{padding:1px 6px;border-bottom:1px solid #eee;white-space:pre-wrap;word-break:break-all}
.off{color:#555}
.len{text-align:right}
.del{background:#ffd7d7}
.ins{background:#d7ffd7}
@media print{
  body{margin:8mm;font-size:11px}
  .no-print{display:none !important}
  h2{font-size:14px}
  .paths,.report-stats{font-size:10px}
  table{page-break-inside:auto}
  tr{page-break-inside:avoid;page-break-after:auto}
}
</style>
</head><body>
<h2>Hex 比對報告</h2>
<div class="paths">左：${esc(this._leftPath || '（未知）')} &nbsp;|&nbsp; 右：${esc(this._rightPath || '（未知）')}</div>
<div class="report-stats">
  <div>差異區塊: <span class="stat-mod">${stats.regions}</span></div>
  <div>差異位元組: <span class="stat-mod">${stats.diffBytes}</span></div>
  <div>左側: <span class="stat-eq">${stats.leftBytes}</span> bytes</div>
  <div>右側: <span class="stat-eq">${stats.rightBytes}</span> bytes</div>
  <div class="ts">生成時間: ${esc(timestamp)}</div>
</div>
${body}
</body></html>`
  }

  /**
   * @param {{ print?: boolean }} [opts] print=true opens the report in a blob
   *   window and calls print() instead of writing it to disk.
   * @returns {Promise<void>}
   */
  async exportHtml(opts = {}) {
    const html = this.buildHtmlReport()
    if (opts.print) {
      const blob = new Blob([html], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      const win = window.open(url, '_blank')
      if (win) {
        win.addEventListener('load', () => {
          try { win.print() } catch { /* 使用者取消列印 */ }
        })
        return
      }
      // Pop-up blocked — fall back to saving rather than doing nothing.
      this._notify('無法開啟列印視窗，改為另存報告', true)
    }
    await window.electronAPI.saveFile(
      'hex-report.html', html,
      [{ name: 'HTML', extensions: ['html'] }, { name: '所有檔案', extensions: ['*'] }])
  }

  /** Save the plain-text report. */
  async exportTextReport() {
    await window.electronAPI.saveFile(
      'hex-report.txt',
      this.buildTextReport(),
      [{ name: '純文字', extensions: ['txt'] }, { name: '所有檔案', extensions: ['*'] }])
  }

  // ── Public: copy a difference to the other side (P1-10) ─────────────────────

  /**
   * Overwrite the current difference region in the right-hand file with the
   * bytes from the left-hand file.
   * @returns {Promise<boolean>} true when the file was written
   */
  copyToRight() { return this._copyRegionToSide('right') }

  /**
   * Overwrite the current difference region in the left-hand file with the
   * bytes from the right-hand file.
   * @returns {Promise<boolean>} true when the file was written
   */
  copyToLeft() { return this._copyRegionToSide('left') }

  /**
   * Splice one side's bytes into the other at the same offsets.
   *
   * Pure so the byte arithmetic — which decides what gets written over a user's
   * file — is testable without a DOM or an IPC bridge.
   *
   * @param {Uint8Array} target bytes being modified
   * @param {Uint8Array} source bytes being copied from
   * @param {{ start: number, end: number }} region
   * @returns {Uint8Array}
   */
  static spliceRegion(target, source, region) {
    const start = Math.min(region.start, target.length)
    const end = Math.min(Math.max(region.end, start), target.length)
    const srcStart = Math.min(region.start, source.length)
    const srcEnd = Math.min(Math.max(region.end, srcStart), source.length)

    const middle = source.subarray(srcStart, srcEnd)
    const out = new Uint8Array(start + middle.length + (target.length - end))
    out.set(target.subarray(0, start), 0)
    out.set(middle, start)
    out.set(target.subarray(end), start + middle.length)
    return out
  }

  /**
   * @param {'left'|'right'} targetSide
   * @returns {Promise<boolean>}
   */
  async _copyRegionToSide(targetSide) {
    const region = this._diffRegions[this._currentDiffIdx]
    if (!region) {
      this._notify('請先選取一個差異區塊（使用 ▲ / ▼ 導航）', true)
      return false
    }
    const target = targetSide === 'left' ? this._leftBytes : this._rightBytes
    const source = targetSide === 'left' ? this._rightBytes : this._leftBytes
    const targetPath = targetSide === 'left' ? this._leftPath : this._rightPath
    if (!target || !source) {
      this._notify('兩側都必須先載入檔案才能複製', true)
      return false
    }
    if (!targetPath) {
      this._notify('目標側沒有檔案路徑，無法寫入', true)
      return false
    }
    if (this._leftTruncated || this._rightTruncated) {
      // The in-memory copy is only the first 10 MB; writing it back would
      // silently discard the rest of the file.
      this._notify('檔案超過 10 MB 已截斷顯示，為避免資料遺失禁止寫入', true)
      return false
    }

    const sideName = targetSide === 'left' ? '左側' : '右側'
    const length = Math.min(region.end, source.length) - Math.min(region.start, source.length)
    const ok = window.confirm(
      `即將以對側的 ${length} 個位元組覆寫${sideName}檔案：\n${targetPath}\n\n` +
      `位移 0x${region.start.toString(16).toUpperCase().padStart(8, '0')}。此操作會寫入磁碟，是否繼續？`)
    if (!ok) return false

    const merged = HexCompare.spliceRegion(target, source, region)

    let result
    try {
      result = await window.electronAPI.saveFile(
        targetPath,
        // latin1 round-trips every byte 0x00–0xFF unchanged; any text codec
        // would mangle bytes that are not valid in it.
        bytesToLatin1(merged),
        [{ name: '所有檔案', extensions: ['*'] }],
        'binary',
        _settings.getPref('backupOnSave'))
    } catch (err) {
      this._notify(`寫入失敗：${err instanceof Error ? err.message : String(err)}`, true)
      return false
    }
    // A cancelled save dialog returns falsy — treating it as success would
    // leave the view showing bytes that were never written.
    if (!result) return false

    if (targetSide === 'left') this._leftBytes = merged
    else this._rightBytes = merged
    this._updateSizeInfo()
    this.refresh()

    const backup = result.backup
    if (backup?.backedUp) this._notify(`已寫入${sideName}，備份於 ${backup.path}`, false)
    else if (backup?.reason) this._notify(`已寫入${sideName}，但備份失敗：${backup.reason}`, true)
    else this._notify(`已寫入${sideName}`, false)
    return true
  }

  /**
   * Show a message in the toolbar's status slot.
   *
   * Failures also raise an alert: this view has no status bar of its own, and a
   * refused write that only tinted a label would read as a silent no-op.
   *
   * @param {string} message
   * @param {boolean} isError
   */
  _notify(message, isError) {
    const warning = this._dom.warning
    if (warning) {
      warning.style.display = ''
      warning.textContent = isError ? `⚠ ${message}` : message
    }
    if (isError) window.alert(message)
  }

  // ── Public: byte editing (P2-22) ────────────────────────────────────────────

  /**
   * Drop every edit-related state for one side. Called when that side is
   * (re)loaded: the undo history describes bytes that no longer exist.
   * @param {'left'|'right'} side
   */
  _resetEditState(side) {
    const bytes = side === 'left' ? this._leftBytes : this._rightBytes
    this._flags[side] = new Uint8Array(bytes ? bytes.length : 0)
    this._modifiedCount[side] = 0
    this._undoStack = this._undoStack.filter((e) => e.side !== side)
    this._redoStack = this._redoStack.filter((e) => e.side !== side)
    if (this._cursor?.side === side) this._cursor = null
    this._syncEditControls()
  }

  /**
   * @param {'left'|'right'} side
   * @returns {HexDoc}
   */
  _doc(side) {
    const bytes = side === 'left' ? this._leftBytes : this._rightBytes
    return makeHexDoc(bytes, this._flags[side])
  }

  /**
   * @param {'left'|'right'} side
   * @param {HexDoc} doc
   */
  _setDoc(side, doc) {
    if (side === 'left') this._leftBytes = doc.bytes
    else this._rightBytes = doc.bytes
    this._flags[side] = doc.flags
  }

  /** @returns {boolean} */
  isEditMode() { return this._editMode }

  /**
   * @param {boolean} on
   * @returns {boolean} the mode actually in effect
   */
  setEditMode(on) {
    const want = Boolean(on)
    if (want && this._leftTruncated && this._rightTruncated) {
      this._notify(this._truncatedReason('兩側'), true)
      return this._editMode
    }
    this._editMode = want
    if (!this._editMode) this._cursor = null
    if (this._dom.root) this._dom.root.classList.toggle('hx-editing', this._editMode)
    if (this._dom.btnEdit) this._dom.btnEdit.classList.toggle('active', this._editMode)
    this._syncEditControls()
    this._renderPaneContent('left')
    this._renderPaneContent('right')
    return this._editMode
  }

  /** @returns {boolean} */
  toggleEditMode() { return this.setEditMode(!this._editMode) }

  /**
   * @param {string} label
   * @returns {string}
   */
  _truncatedReason(label) {
    return `${label}檔案超過 ${formatSize(MAX_BYTES)}，只載入了前段內容。` +
      '編輯後存檔會把未載入的部分整段截掉，因此這個檔案不允許編輯或寫入。'
  }

  /**
   * @param {'left'|'right'} side
   * @param {boolean} [quiet] suppress the message (used by UI enable/disable)
   * @returns {boolean}
   */
  _canEdit(side, quiet = false) {
    if (!this._editMode) {
      if (!quiet) this._notify('請先按「✎ 編輯」進入編輯模式', true)
      return false
    }
    const bytes = side === 'left' ? this._leftBytes : this._rightBytes
    const sideName = side === 'left' ? '左側' : '右側'
    if (!bytes) {
      if (!quiet) this._notify(`${sideName}尚未載入檔案，無法編輯`, true)
      return false
    }
    if (side === 'left' ? this._leftTruncated : this._rightTruncated) {
      if (!quiet) this._notify(this._truncatedReason(sideName), true)
      return false
    }
    return true
  }

  /**
   * Overwrite bytes in place (file length unchanged).
   * @param {'left'|'right'} side
   * @param {number} offset
   * @param {Uint8Array|number[]} values
   * @returns {boolean} true when the document changed
   */
  overwriteBytes(side, offset, values) {
    if (!this._canEdit(side)) return false
    return this._applyEdit(side, makeOverwriteEdit(this._doc(side), offset, values))
  }

  /**
   * Insert bytes, growing the file.
   * @param {'left'|'right'} side
   * @param {number} offset
   * @param {Uint8Array|number[]} values
   * @returns {boolean}
   */
  insertBytesAt(side, offset, values) {
    if (!this._canEdit(side)) return false
    return this._applyEdit(side, makeInsertEdit(this._doc(side), offset, values))
  }

  /**
   * Delete bytes, shrinking the file.
   * @param {'left'|'right'} side
   * @param {number} offset
   * @param {number} [count=1]
   * @returns {boolean}
   */
  deleteBytesAt(side, offset, count = 1) {
    if (!this._canEdit(side)) return false
    return this._applyEdit(side, makeDeleteEdit(this._doc(side), offset, count))
  }

  /**
   * @param {'left'|'right'} side
   * @param {HexEdit|null} edit
   * @returns {boolean}
   */
  _applyEdit(side, edit) {
    if (!edit) return false
    this._applyEditRaw(side, edit)
    pushBounded(this._undoStack, { side, edit }, MAX_UNDO_STACK)
    this._redoStack = []
    this._afterEdit(side, edit)
    return true
  }

  /**
   * Splice one edit into a side and keep the modified-byte counter in step.
   * The counter is maintained incrementally because rescanning a 10 MB flag
   * array on every keystroke would be the most expensive thing in the view.
   * @param {'left'|'right'} side
   * @param {HexEdit} edit
   */
  _applyEditRaw(side, edit) {
    this._setDoc(side, applyHexEdit(this._doc(side), edit))
    this._modifiedCount[side] = Math.max(0, this._modifiedCount[side] + modifiedDelta(edit))
  }

  /** @returns {boolean} true when an edit was undone */
  undo() {
    const entry = this._undoStack.pop()
    if (!entry) return false
    this._applyEditRaw(entry.side, invertHexEdit(entry.edit))
    pushBounded(this._redoStack, entry, MAX_UNDO_STACK)
    this._moveCursorTo(entry.side, entry.edit.offset)
    this._afterEdit(entry.side, entry.edit)
    return true
  }

  /** @returns {boolean} true when an edit was redone */
  redo() {
    const entry = this._redoStack.pop()
    if (!entry) return false
    this._applyEditRaw(entry.side, entry.edit)
    pushBounded(this._undoStack, entry, MAX_UNDO_STACK)
    this._moveCursorTo(entry.side, entry.edit.offset)
    this._afterEdit(entry.side, entry.edit)
    return true
  }

  /** @returns {boolean} */
  canUndo() { return this._undoStack.length > 0 }
  /** @returns {boolean} */
  canRedo() { return this._redoStack.length > 0 }

  /**
   * @param {'left'|'right'} [side]
   * @returns {boolean} whether that side (or either side) has unsaved edits
   */
  hasUnsavedEdits(side) {
    if (side) return this._modifiedCount[side] > 0
    return this._modifiedCount.left > 0 || this._modifiedCount.right > 0
  }

  /**
   * @param {'left'|'right'} side
   * @returns {number} number of bytes marked modified on that side
   */
  getModifiedCount(side) { return this._modifiedCount[side] }

  /**
   * @param {'left'|'right'} side
   * @returns {Uint8Array} per-byte modified markers (live reference; read only)
   */
  getModifiedFlags(side) { return this._flags[side] ?? new Uint8Array(0) }

  /**
   * Post-edit bookkeeping: repaint the edited side now (cheap — only the rows
   * on screen) and defer the expensive re-diff so that held-down typing is not
   * quadratic in file size.
   * @param {'left'|'right'} side
   * @param {HexEdit} edit
   */
  _afterEdit(side, edit) {
    if (edit.before.length !== edit.after.length) this._invalidateFind()
    this._updateSizeInfo()
    this._syncEditControls()
    this._renderPaneContent(side)
    this._scheduleEditReflow()
  }

  /**
   * Search hits are byte offsets; an insert or delete moves every offset after
   * it, so the stale hit list is discarded rather than silently mis-highlighted.
   */
  _invalidateFind() {
    if (this._findMatches.length === 0) return
    this._clearFindHighlights()
    this._findMatches = []
    this._findCurrentIdx = -1
    const { findCount } = this._dom
    if (findCount) findCount.textContent = '內容已變更，請重新搜尋'
  }

  /** Debounced re-diff / repaint after edits. */
  _scheduleEditReflow() {
    if (this._reflowTimer !== null) return
    this._reflowTimer = setTimeout(() => {
      this._reflowTimer = null
      this._editReflowNow()
    }, EDIT_REFLOW_MS)
  }

  /** Immediate version of the debounced reflow. */
  _editReflowNow() {
    if (this._reflowTimer !== null) {
      clearTimeout(this._reflowTimer)
      this._reflowTimer = null
    }
    this._recomputeCompleteIfNeeded()
    this._recomputeDiffRegions()
    this._renderPaneContent('left')
    this._renderPaneContent('right')
  }

  // ── Public: saving edited bytes ─────────────────────────────────────────────

  /**
   * Write one side's edited bytes back to its file.
   * @param {'left'|'right'} side
   * @returns {Promise<boolean>} true when the file was written
   */
  async saveSide(side) {
    const sideName = side === 'left' ? '左側' : '右側'
    const bytes = side === 'left' ? this._leftBytes : this._rightBytes
    const path = side === 'left' ? this._leftPath : this._rightPath
    const truncated = side === 'left' ? this._leftTruncated : this._rightTruncated

    if (!bytes) {
      this._notify(`${sideName}尚未載入檔案`, true)
      return false
    }
    if (truncated) {
      // The in-memory copy stops at MAX_BYTES; writing it back would delete
      // everything past that point.
      this._notify(this._truncatedReason(sideName), true)
      return false
    }
    if (!path) {
      this._notify(`${sideName}沒有檔案路徑，無法寫入`, true)
      return false
    }
    if (this._modifiedCount[side] === 0) {
      this._notify(`${sideName}沒有未儲存的修改`, false)
      return false
    }

    let result
    try {
      result = await window.electronAPI.saveFile(
        path,
        // latin1 round-trips every byte 0x00–0xFF unchanged.
        bytesToLatin1(bytes),
        [{ name: '所有檔案', extensions: ['*'] }],
        'binary',
        _settings.getPref('backupOnSave'))
    } catch (err) {
      this._notify(`寫入失敗：${err instanceof Error ? err.message : String(err)}`, true)
      return false
    }
    if (!result) return false

    // The saved bytes are now the file's bytes, so nothing is "modified" any
    // more; the undo history stays, and undoing past this point marks it again.
    this._flags[side] = new Uint8Array(bytes.length)
    this._modifiedCount[side] = 0
    this._syncEditControls()
    this._renderPaneContent(side)

    const backup = result.backup
    if (backup?.backedUp) this._notify(`已儲存${sideName}，備份於 ${backup.path}`, false)
    else if (backup?.reason) this._notify(`已儲存${sideName}，但備份失敗：${backup.reason}`, true)
    else this._notify(`已儲存${sideName}`, false)
    return true
  }

  /** @returns {Promise<boolean>} */
  saveLeft() { return this.saveSide('left') }
  /** @returns {Promise<boolean>} */
  saveRight() { return this.saveSide('right') }

  /**
   * Ask before throwing unsaved edits away.
   * @returns {boolean} true when it is safe to close
   */
  confirmClose() {
    if (!this.hasUnsavedEdits()) return true
    const sides = []
    if (this._modifiedCount.left > 0) sides.push(`左側 ${this._modifiedCount.left} 個位元組`)
    if (this._modifiedCount.right > 0) sides.push(`右側 ${this._modifiedCount.right} 個位元組`)
    return window.confirm(
      `Hex 比對有尚未儲存的修改（${sides.join('、')}）。\n關閉後這些修改會遺失，確定要關閉嗎？`)
  }

  // ── Private: cursor ─────────────────────────────────────────────────────────

  /**
   * @param {'left'|'right'} side
   * @param {number} offset
   * @param {'hex'|'ascii'} [field]
   */
  _moveCursorTo(side, offset, field) {
    const bytes = side === 'left' ? this._leftBytes : this._rightBytes
    const len = bytes ? bytes.length : 0
    if (len === 0) { this._cursor = null; return }
    const clamped = Math.max(0, Math.min(Math.trunc(offset), len - 1))
    this._cursor = {
      side,
      offset: clamped,
      field: field ?? this._cursor?.field ?? 'hex',
      nibble: 0,
    }
    this._updateDetailsPanel()
  }

  /**
   * @returns {{ side: 'left'|'right', offset: number, field: 'hex'|'ascii', nibble: 0|1 }|null}
   */
  getCursor() {
    return this._cursor
  }

  /** Scroll the cursor's row into view without disturbing the position otherwise. */
  _ensureCursorVisible() {
    if (!this._cursor) return
    const scroll = this._dom[`scroll_${this._cursor.side}`]
    if (!scroll) return
    const visual = this._visualIndexOf(Math.floor(this._cursor.offset / this._bytesPerRow))
    const top = visual * ROW_HEIGHT
    const viewHeight = scroll.clientHeight || 300
    if (top < scroll.scrollTop) scroll.scrollTop = top
    else if (top + ROW_HEIGHT > scroll.scrollTop + viewHeight) {
      scroll.scrollTop = top + ROW_HEIGHT - viewHeight
    }
  }

  // ── Private: keyboard editing ───────────────────────────────────────────────

  /**
   * Typing, navigation and insert/delete inside a pane.
   * @param {KeyboardEvent} e
   * @param {'left'|'right'} side
   */
  _onEditKeyDown(e, side) {
    // Ctrl/Alt combinations belong to the document-level handler; handling them
    // here as well would run undo twice for one Ctrl+Z.
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (!this._editMode) return
    const cursor = this._cursor
    if (!cursor || cursor.side !== side) return

    const bpr = this._bytesPerRow
    const bytes = side === 'left' ? this._leftBytes : this._rightBytes
    if (!bytes) return

    /** @param {number} next */
    const moveTo = (next) => {
      this._moveCursorTo(side, next, cursor.field)
      this._ensureCursorVisible()
      this._renderPaneContent(side)
    }

    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); moveTo(cursor.offset - 1); return
      case 'ArrowRight': e.preventDefault(); moveTo(cursor.offset + 1); return
      case 'ArrowUp':    e.preventDefault(); moveTo(cursor.offset - bpr); return
      case 'ArrowDown':  e.preventDefault(); moveTo(cursor.offset + bpr); return
      case 'Home':       e.preventDefault(); moveTo(cursor.offset - (cursor.offset % bpr)); return
      case 'End':        e.preventDefault(); moveTo(cursor.offset - (cursor.offset % bpr) + bpr - 1); return
      case 'Tab':
        e.preventDefault()
        this._cursor = { ...cursor, field: cursor.field === 'hex' ? 'ascii' : 'hex', nibble: 0 }
        this._renderPaneContent(side)
        return
      case 'Insert':
        e.preventDefault()
        if (this.insertBytesAt(side, cursor.offset, [0x00])) {
          this._moveCursorTo(side, cursor.offset, cursor.field)
          this._renderPaneContent(side)
        }
        return
      case 'Delete':
        e.preventDefault()
        if (this.deleteBytesAt(side, cursor.offset, 1)) {
          this._moveCursorTo(side, cursor.offset, cursor.field)
          this._renderPaneContent(side)
        }
        return
      case 'Backspace':
        e.preventDefault()
        if (cursor.offset > 0 && this.deleteBytesAt(side, cursor.offset - 1, 1)) {
          this._moveCursorTo(side, cursor.offset - 1, cursor.field)
          this._renderPaneContent(side)
        }
        return
      default:
        break
    }

    if (e.key.length !== 1) return

    if (cursor.field === 'ascii') {
      const code = e.key.charCodeAt(0)
      if (code > 0xff) return
      e.preventDefault()
      if (this.overwriteBytes(side, cursor.offset, [code])) {
        this._moveCursorTo(side, cursor.offset + 1, 'ascii')
        this._ensureCursorVisible()
        this._renderPaneContent(side)
      }
      return
    }

    const nibble = hexNibbleValue(e.key)
    if (nibble < 0) return
    e.preventDefault()
    const current = bytes[cursor.offset]
    const value = cursor.nibble === 0
      ? ((nibble << 4) | (current & 0x0f))
      : ((current & 0xf0) | nibble)
    const changed = this.overwriteBytes(side, cursor.offset, [value])
    // The cursor advances even when the byte already held that value, so typing
    // "41" over an existing 0x41 still walks forward as the user expects.
    if (cursor.nibble === 0) {
      this._cursor = { side, offset: cursor.offset, field: 'hex', nibble: 1 }
    } else {
      this._moveCursorTo(side, cursor.offset + 1, 'hex')
      this._ensureCursorVisible()
    }
    if (!changed) this._renderPaneContent(side)
  }

  /** Enable/disable the edit toolbar controls and refresh the dirty marker. */
  _syncEditControls() {
    const { btnUndo, btnRedo, btnSaveLeft, btnSaveRight, dirtyInfo, btnEdit } = this._dom
    if (btnUndo instanceof HTMLButtonElement) btnUndo.disabled = !this.canUndo()
    if (btnRedo instanceof HTMLButtonElement) btnRedo.disabled = !this.canRedo()
    if (btnSaveLeft instanceof HTMLButtonElement) {
      btnSaveLeft.disabled = this._modifiedCount.left === 0 || this._leftTruncated
    }
    if (btnSaveRight instanceof HTMLButtonElement) {
      btnSaveRight.disabled = this._modifiedCount.right === 0 || this._rightTruncated
    }
    if (btnEdit) btnEdit.classList.toggle('active', this._editMode)
    if (dirtyInfo) {
      const parts = []
      if (this._modifiedCount.left > 0) parts.push(`左 ${this._modifiedCount.left}`)
      if (this._modifiedCount.right > 0) parts.push(`右 ${this._modifiedCount.right}`)
      dirtyInfo.textContent = parts.length ? `● 未儲存（${parts.join('、')} bytes）` : ''
      dirtyInfo.style.display = parts.length ? '' : 'none'
    }
  }

  // ── Public: difference navigation (S16) ─────────────────────────────────────

  /**
   * 目前的差異區塊清單（唯讀快照）
   * @returns {Array<{ start: number, end: number, length: number }>}
   */
  getDiffRegions() {
    return this._diffRegions
  }

  /** @returns {number} 目前選取的差異索引；-1 表示尚未選取 */
  getCurrentDiffIndex() {
    return this._currentDiffIdx
  }

  /** 跳至下一個差異區塊（是否環繞依 Next Difference 設定）。 @returns {NavResult} */
  nextDifference() { return this._stepDiff(1) }

  /** 跳至上一個差異區塊（是否環繞依 Next Difference 設定）。 @returns {NavResult} */
  prevDifference() { return this._stepDiff(-1) }

  /** 跳至第一個差異區塊 @returns {NavResult} */
  firstDifference() { return this._jumpDiff(0) }

  /** 跳至最後一個差異區塊 @returns {NavResult} */
  lastDifference() { return this._jumpDiff(this._diffRegions.length - 1) }

  /**
   * @param {number} delta
   * @returns {NavResult}
   */
  _stepDiff(delta) {
    const total = this._diffRegions.length
    const from = this._currentDiffIdx
    const to = stepDiffIndex(from, total, delta)
    if (to >= 0) this._gotoDiff(to)
    return navResult(from, to, total)
  }

  /**
   * @param {number} target
   * @returns {NavResult}
   */
  _jumpDiff(target) {
    const total = this._diffRegions.length
    const from = this._currentDiffIdx
    if (total === 0 || target < 0) return navResult(from, -1, total)
    this._gotoDiff(target)
    return navResult(from, target, total)
  }

  /**
   * 交換兩側所有成對狀態並重算差異。
   * Complete-mode 分類直接互換而非留待 refresh 重算，避免重算前的短暫錯誤著色。
   */
  swap() {
    ;[this._leftBytes, this._rightBytes] = [this._rightBytes, this._leftBytes]
    ;[this._leftPath, this._rightPath] = [this._rightPath, this._leftPath]
    ;[this._leftTruncated, this._rightTruncated] = [this._rightTruncated, this._leftTruncated]
    ;[this._leftOriginalSize, this._rightOriginalSize] =
      [this._rightOriginalSize, this._leftOriginalSize]
    ;[this._completeLeftClass, this._completeRightClass] =
      [this._completeRightClass, this._completeLeftClass]
    ;[this._flags.left, this._flags.right] = [this._flags.right, this._flags.left]
    ;[this._modifiedCount.left, this._modifiedCount.right] =
      [this._modifiedCount.right, this._modifiedCount.left]
    // Undo entries name a side, so they have to be relabelled rather than left
    // pointing at bytes that are now on the other pane.
    for (const entry of [...this._undoStack, ...this._redoStack]) {
      entry.side = entry.side === 'left' ? 'right' : 'left'
    }
    if (this._cursor) this._cursor.side = this._cursor.side === 'left' ? 'right' : 'left'
    this._syncEditControls()

    this._updatePathDisplay('left', this._leftPath ?? '（未選擇）')
    this._updatePathDisplay('right', this._rightPath ?? '（未選擇）')
    this._updateSizeInfo()
    // Find hits carry a side tag, so they must be rebuilt rather than relabelled.
    this._runFind()
    this.refresh()
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
  }

  /** 立即同步渲染（scroll 事件用，不需要 rAF 因為 layout 已穩定） */
  _refreshSync() {
    this._renderPaneContent('left')
    this._renderPaneContent('right')
  }

  /**
   * 訂閱事件
   * @param {string} event
   * @param {Function} handler
   * @returns {this}
   */
  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = []
    this._handlers[event].push(handler)
    return this
  }

  /**
   * 取消訂閱事件
   * @param {string} event
   * @param {Function} handler
   * @returns {this}
   */
  off(event, handler) {
    if (!this._handlers[event]) return this
    this._handlers[event] = this._handlers[event].filter((h) => h !== handler)
    return this
  }

  // ── Private: emit ────────────────────────────────────────────────────────────

  /**
   * @param {string} event
   * @param {object} payload
   */
  _emit(event, payload) {
    const handlers = this._handlers[event] ?? []
    for (const h of handlers) {
      try { h(payload) } catch (e) {
        console.error(`HexCompare event "${event}" handler error:`, e)
      }
    }
  }

  // ── Private: Initial render ──────────────────────────────────────────────────

  _render() {
    if (!this._container) return
    this._container.innerHTML = ''

    const root = el('div', { className: 'hex-compare' })

    root.appendChild(this._buildToolbar())
    root.appendChild(this._buildBody())
    root.appendChild(this._buildPanels())

    this._container.appendChild(root)
    this._dom.root = root

    // 初始空狀態
    this._showEmptyState('left')
    this._showEmptyState('right')
    this._applyPanelVisibility()
  }

  /**
   * The Details / File Info drawer.
   *
   * It sits below `.hx-body` as a sibling, never inside `.hx-scroll`, so the
   * virtual scroller's row arithmetic is untouched — only the viewport gets
   * shorter, which it already handles on window resize.
   *
   * @returns {HTMLElement}
   */
  _buildPanels() {
    const panels = el('div', { className: 'hx-panels' })

    const details = el('div', { className: 'hx-details' })
    details.appendChild(el('div', { className: 'hx-panel-title' }, 'Hex Details'))
    const detailsBody = el('div', { className: 'hx-details-body' })
    this._dom.detailsBody = detailsBody
    details.appendChild(detailsBody)
    this._dom.detailsPanel = details

    const info = el('div', { className: 'hx-fileinfo' })
    info.appendChild(el('div', { className: 'hx-panel-title' }, 'File Info'))
    const infoBody = el('div', { className: 'hx-fileinfo-body' })
    this._dom.fileInfoBody = infoBody
    info.appendChild(infoBody)
    this._dom.fileInfoPanel = info

    panels.appendChild(details)
    panels.appendChild(info)
    this._dom.panels = panels
    return panels
  }

  _buildToolbar() {
    const toolbar = el('div', { className: 'hx-toolbar' })

    // bytes-per-row label
    toolbar.appendChild(el('label', { textContent: '每列位元組數：' }))

    // bytes-per-row select
    const bprSelect = el('select', { className: 'hx-bpr-select' })
    for (const val of [8, 16, 32]) {
      const opt = el('option', { value: String(val) }, String(val))
      if (val === this._bytesPerRow) opt.setAttribute('selected', '')
      bprSelect.appendChild(opt)
    }
    this._dom.bprSelect = bprSelect
    toolbar.appendChild(bprSelect)

    // 刷新按鈕
    const btnRefresh = el('button', { className: 'hx-btn-refresh' }, '↺ 重新整理')
    this._dom.btnRefresh = btnRefresh
    toolbar.appendChild(btnRefresh)

    // T78: Algorithm switch (Fast | Complete)
    toolbar.appendChild(el('label', { textContent: '演算法：' }))
    const algoSelect = el('select', { className: 'hx-algo-select' })
    for (const [val, text] of [['fast', 'Fast'], ['complete', 'Complete']]) {
      const opt = el('option', { value: val }, text)
      if (val === this._diffAlgorithm) opt.setAttribute('selected', '')
      algoSelect.appendChild(opt)
    }
    this._dom.algoSelect = algoSelect
    toolbar.appendChild(algoSelect)

    // ── S16: 差異導航 ──────────────────────────────────────────────────────────
    const navBar = el('div', { className: 'hx-nav-bar' })
    const btnDiffFirst = el('button', { className: 'hx-nav-btn', title: '第一個差異（Alt+Home）' }, '⤒')
    const btnDiffPrev  = el('button', { className: 'hx-nav-btn', title: '上一個差異（F7）' }, '▲')
    const btnDiffNext  = el('button', { className: 'hx-nav-btn', title: '下一個差異（F8）' }, '▼')
    const btnDiffLast  = el('button', { className: 'hx-nav-btn', title: '最後一個差異（Alt+End）' }, '⤓')
    const diffCount    = el('span', { className: 'hx-diff-count' }, '無差異')
    this._dom.btnDiffFirst = btnDiffFirst
    this._dom.btnDiffPrev  = btnDiffPrev
    this._dom.btnDiffNext  = btnDiffNext
    this._dom.btnDiffLast  = btnDiffLast
    this._dom.diffCount    = diffCount
    navBar.appendChild(btnDiffFirst)
    navBar.appendChild(btnDiffPrev)
    navBar.appendChild(btnDiffNext)
    navBar.appendChild(btnDiffLast)
    navBar.appendChild(diffCount)
    toolbar.appendChild(navBar)

    // ── P2-36: Show filter ─────────────────────────────────────────────────────
    const showBar = el('div', { className: 'hx-show-bar' })
    const btnShowAll  = el('button', { className: 'hx-show-btn active', title: '顯示全部位元組' }, '全部')
    const btnShowDiff = el('button', { className: 'hx-show-btn', title: '只顯示含差異的列' }, '差異')
    const btnShowSame = el('button', { className: 'hx-show-btn', title: '只顯示完全相同的列' }, '相同')
    this._dom.btnShowAll  = btnShowAll
    this._dom.btnShowDiff = btnShowDiff
    this._dom.btnShowSame = btnShowSame
    showBar.appendChild(btnShowAll)
    showBar.appendChild(btnShowDiff)
    showBar.appendChild(btnShowSame)
    toolbar.appendChild(showBar)

    // ── P1-10: copy the current difference to the other side ───────────────────
    const btnCopyRight = el('button', { className: 'hx-btn-copy', title: '將目前差異區塊複製到右側檔案' }, '▶ 複製到右')
    const btnCopyLeft  = el('button', { className: 'hx-btn-copy', title: '將目前差異區塊複製到左側檔案' }, '◀ 複製到左')
    this._dom.btnCopyRight = btnCopyRight
    this._dom.btnCopyLeft  = btnCopyLeft
    toolbar.appendChild(btnCopyRight)
    toolbar.appendChild(btnCopyLeft)

    // ── P2-22: byte editing ────────────────────────────────────────────────────
    const editBar = el('div', { className: 'hx-edit-bar' })
    const btnEdit = el('button', { className: 'hx-btn-edit', title: '切換編輯模式（可直接輸入 hex 或 ASCII）' }, '✎ 編輯')
    const btnUndo = el('button', { className: 'hx-btn-edit', title: '復原（Ctrl+Z）' }, '↶')
    const btnRedo = el('button', { className: 'hx-btn-edit', title: '重做（Ctrl+Y）' }, '↷')
    const btnSaveLeft  = el('button', { className: 'hx-btn-edit', title: '儲存左側檔案' }, '💾 存左')
    const btnSaveRight = el('button', { className: 'hx-btn-edit', title: '儲存右側檔案' }, '💾 存右')
    const dirtyInfo = el('span', { className: 'hx-dirty-info' })
    dirtyInfo.style.display = 'none'
    this._dom.btnEdit = btnEdit
    this._dom.btnUndo = btnUndo
    this._dom.btnRedo = btnRedo
    this._dom.btnSaveLeft = btnSaveLeft
    this._dom.btnSaveRight = btnSaveRight
    this._dom.dirtyInfo = dirtyInfo
    editBar.appendChild(btnEdit)
    editBar.appendChild(btnUndo)
    editBar.appendChild(btnRedo)
    editBar.appendChild(btnSaveLeft)
    editBar.appendChild(btnSaveRight)
    editBar.appendChild(dirtyInfo)
    toolbar.appendChild(editBar)

    // ── P2-40: view panels ─────────────────────────────────────────────────────
    const panelBar = el('div', { className: 'hx-panel-bar' })
    const btnDetails = el('button',
      { className: 'hx-panel-btn', id: 'hx-btn-details', title: '顯示 / 隱藏 Hex Details 面板' }, '🔢 詳細')
    const btnFileInfo = el('button',
      { className: 'hx-panel-btn', id: 'hx-btn-fileinfo', title: '顯示 / 隱藏檔案資訊面板' }, 'ℹ 檔案資訊')
    const btnRuler = el('button',
      { className: 'hx-panel-btn', id: 'hx-btn-ruler', title: '顯示 / 隱藏欄位標尺' }, '📏 標尺')
    this._dom.btnDetails = btnDetails
    this._dom.btnFileInfo = btnFileInfo
    this._dom.btnRuler = btnRuler
    panelBar.appendChild(btnDetails)
    panelBar.appendChild(btnFileInfo)
    panelBar.appendChild(btnRuler)
    toolbar.appendChild(panelBar)

    // S16: Swap sides
    const btnSwap = el('button', { className: 'hx-btn-swap', title: '交換左右兩側' }, '⇄ 交換')
    this._dom.btnSwap = btnSwap
    toolbar.appendChild(btnSwap)

    // P1-20: HTML report
    const btnReport = el('button', { className: 'hx-btn-report', title: '匯出 HTML 報告' }, '⬇ HTML')
    const btnPrint  = el('button', { className: 'hx-btn-report', title: '列印 / 匯出 PDF' }, '🖨 列印')
    this._dom.btnReport = btnReport
    this._dom.btnPrint  = btnPrint
    toolbar.appendChild(btnReport)
    toolbar.appendChild(btnPrint)

    // 大小資訊（動態更新）
    const sizeInfo = el('span', { className: 'hx-size-info' })
    this._dom.sizeInfo = sizeInfo
    toolbar.appendChild(sizeInfo)

    // 截斷警告（初始隱藏）
    const warning = el('span', { className: 'hx-warning' })
    warning.style.display = 'none'
    this._dom.warning = warning
    toolbar.appendChild(warning)

    // ── T10: Find bar ──────────────────────────────────────────────────────────
    const findBar = el('div', { className: 'hx-find-bar' })

    // Mode toggle: checked = hex, unchecked = ascii
    const findModeLabel = el('label', { className: 'hx-find-mode-label' })
    /** @type {HTMLInputElement} */
    const modeCheckbox = el('input', { type: 'checkbox', id: 'hx-find-mode' })
    modeCheckbox.checked = true
    findModeLabel.appendChild(modeCheckbox)
    findModeLabel.appendChild(document.createTextNode(' Hex'))
    this._dom.findModeCheck = modeCheckbox
    findBar.appendChild(findModeLabel)

    // Search input
    const findInput = el('input', {
      type: 'text',
      id: 'hx-find-input',
      className: 'hx-find-input',
      placeholder: 'Hex: FF 00 1A  或 ASCII: hello',
    })
    this._dom.findInput = findInput
    findBar.appendChild(findInput)

    // Clear button
    const btnFindClear = el('button', { className: 'hx-find-btn' }, '✕')
    this._dom.btnFindClear = btnFindClear
    findBar.appendChild(btnFindClear)

    // Prev / Next buttons
    const btnFindPrev = el('button', { className: 'hx-find-btn' }, '◀')
    const btnFindNext = el('button', { className: 'hx-find-btn' }, '▶')
    this._dom.btnFindPrev = btnFindPrev
    this._dom.btnFindNext = btnFindNext
    findBar.appendChild(btnFindPrev)
    findBar.appendChild(btnFindNext)

    // Match count display
    const findCount = el('span', { id: 'hx-find-count', className: 'hx-find-count' }, '')
    this._dom.findCount = findCount
    findBar.appendChild(findCount)

    toolbar.appendChild(findBar)

    // ── T11: Goto offset ───────────────────────────────────────────────────────
    const gotoInput = el('input', {
      type: 'text',
      id: 'hx-goto-offset',
      className: 'hx-goto-input',
      placeholder: '跳轉到 offset（hex）',
    })
    this._dom.gotoInput = gotoInput
    toolbar.appendChild(gotoInput)

    return toolbar
  }

  _buildPathRow() {
    const row = el('div', { className: 'hx-path-row' })

    // Left cell
    const leftCell = el('div', { className: 'hx-path-cell' })
    const btnLeft  = el('button', { className: 'hx-open-btn' }, '開啟檔案…')
    const dispLeft = el('span', { className: 'hx-path-display' }, '（未選擇）')
    this._dom.btnOpenLeft = btnLeft
    this._dom.dispLeft    = dispLeft
    leftCell.appendChild(btnLeft)
    leftCell.appendChild(dispLeft)

    // Right cell
    const rightCell = el('div', { className: 'hx-path-cell' })
    const btnRight  = el('button', { className: 'hx-open-btn' }, '開啟檔案…')
    const dispRight = el('span', { className: 'hx-path-display' }, '（未選擇）')
    this._dom.btnOpenRight = btnRight
    this._dom.dispRight    = dispRight
    rightCell.appendChild(btnRight)
    rightCell.appendChild(dispRight)

    row.appendChild(leftCell)
    row.appendChild(rightCell)
    return row
  }

  _buildBody() {
    const body = el('div', { className: 'hx-body' })

    body.appendChild(this._buildPane('left'))
    body.appendChild(this._buildPane('right'))

    return body
  }

  /**
   * 建立單側 pane（header + virtual scroll container）
   * @param {'left'|'right'} side
   * @returns {HTMLElement}
   */
  _buildPane(side) {
    const pane = el('div', { className: 'hx-pane', 'data-side': side })

    // 標題列
    const header = el('div', { className: 'hx-header' })
    header.appendChild(el('div', { className: 'hx-header-offset', textContent: 'Offset' }))
    header.appendChild(el('div', { className: 'hx-header-hex',    textContent: 'Hex Bytes' }))
    header.appendChild(el('div', { className: 'hx-header-ascii',  textContent: 'ASCII' }))
    pane.appendChild(header)

    // P2-40: column ruler. Static (one per pane) rather than per row, and laid
    // out with the same grid + monospace metrics as .hx-row so the labels line
    // up with the byte columns beneath them.
    const ruler = el('div', { className: 'hx-ruler' })
    this._dom[`ruler_${side}`] = ruler
    pane.appendChild(ruler)

    // Virtual scroll 容器
    // tabindex: editing needs key events, and the rows themselves are recycled
    // by the virtual scroller, so the scroller is the stable focus holder.
    const scroll = el('div', { className: 'hx-scroll', tabindex: '0' })
    this._dom[`scroll_${side}`] = scroll

    // Inner（高度由 JS 設定）
    const inner = el('div', { className: 'hx-inner' })
    this._dom[`inner_${side}`] = inner
    scroll.appendChild(inner)

    pane.appendChild(scroll)
    this._dom[`pane_${side}`] = pane
    return pane
  }

  // ── Private: Event binding ────────────────────────────────────────────────────

  _bindEvents() {
    const {
      bprSelect, btnRefresh,
      scroll_left, scroll_right,
      findInput, findModeCheck, btnFindClear, btnFindPrev, btnFindNext,
      gotoInput,
    } = this._dom

    bprSelect.addEventListener('change', () => {
      this._bytesPerRow = parseInt(bprSelect.value, 10)
      if (this._showRuler) this._renderRulers()
      // Row boundaries moved, so which rows are "all same" moved with them.
      this._recomputeRowFilter()
      // Re-run search with new layout
      this._runFind()
      this._renderPaneContent('left')
      this._renderPaneContent('right')
    })

    btnRefresh.addEventListener('click', () => this._refreshSync())

    // T78: algorithm switch
    const algoSelect = this._dom.algoSelect
    if (algoSelect) {
      algoSelect.addEventListener('change', () => {
        const v = /** @type {HTMLSelectElement} */ (algoSelect).value
        if (v === 'fast' || v === 'complete') {
          this._diffAlgorithm = v
          this._recomputeCompleteIfNeeded()
          this._recomputeDiffRegions()
          this._refreshSync()
        }
      })
    }

    // 同步捲動
    scroll_left.addEventListener('scroll',  this._debouncedScrollLeft)
    scroll_right.addEventListener('scroll', this._debouncedScrollRight)

    // Context menu
    scroll_left.addEventListener('contextmenu',  (e) => this._onHexContextMenu(e, 'left'))
    scroll_right.addEventListener('contextmenu', (e) => this._onHexContextMenu(e, 'right'))

    // T27: Hex byte ↔ ASCII 欄位點擊同步高亮
    const onHexPaneClick = (e) => {
      // 清除舊的高亮
      document.querySelectorAll('.hx-selected').forEach(el => el.classList.remove('hx-selected'))

      const target = e.target instanceof Element ? e.target : null
      const rowEl = target?.closest('.hx-row')
      if (!rowEl) return

      const hexCol   = rowEl.querySelector('.hx-hex')
      const asciiCol = rowEl.querySelector('.hx-ascii')
      if (!hexCol || !asciiCol) return

      const hexSpans   = [...hexCol.querySelectorAll('.hx-byte')]
      const asciiSpans = [...asciiCol.querySelectorAll('.hx-ascii-char')]

      let clickedIdx = -1

      // 找出被點擊的 span 的索引
      if (target?.classList.contains('hx-byte')) {
        clickedIdx = hexSpans.indexOf(target)
      } else if (target?.classList.contains('hx-ascii-char')) {
        clickedIdx = asciiSpans.indexOf(target)
      }

      if (clickedIdx < 0) return

      // 高亮對應的 hex + ascii span
      hexSpans[clickedIdx]?.classList.add('hx-selected')
      asciiSpans[clickedIdx]?.classList.add('hx-selected')

      // P2-22: the same click places the edit cursor.
      const sourceRow = parseInt(rowEl.dataset.row ?? '', 10)
      if (Number.isNaN(sourceRow)) return
      const side = rowEl.closest('.hx-pane')?.dataset.side
      if (side !== 'left' && side !== 'right') return
      const field = target?.classList.contains('hx-ascii-char') ? 'ascii' : 'hex'
      this._moveCursorTo(side, sourceRow * this._bytesPerRow + clickedIdx, field)
      if (this._editMode) this._renderPaneContent(side)
    }

    scroll_left.addEventListener('click',  onHexPaneClick)
    scroll_right.addEventListener('click', onHexPaneClick)

    // ── P2-22: byte editing ────────────────────────────────────────────────────
    scroll_left.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => this._onEditKeyDown(e, 'left'))
    scroll_right.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => this._onEditKeyDown(e, 'right'))

    const { btnEdit, btnUndo, btnRedo, btnSaveLeft, btnSaveRight } = this._dom
    btnEdit.addEventListener('click', () => this.toggleEditMode())
    btnUndo.addEventListener('click', () => this.undo())
    btnRedo.addEventListener('click', () => this.redo())
    btnSaveLeft.addEventListener('click',  () => void this.saveSide('left'))
    btnSaveRight.addEventListener('click', () => void this.saveSide('right'))
    this._syncEditControls()
    this._installCloseGuards()

    // ── T10: Find bar ──────────────────────────────────────────────────────────
    findInput.addEventListener('input', () => this._runFind())
    findModeCheck.addEventListener('change', () => {
      // Mode switch → clear results and re-search
      this._clearFindHighlights()
      this._runFind()
    })
    btnFindClear.addEventListener('click', () => {
      findInput.value = ''
      this._clearFind()
    })
    btnFindPrev.addEventListener('click', () => this._stepFind(-1))
    btnFindNext.addEventListener('click', () => this._stepFind(1))

    // Ctrl+F opens find bar and focuses input; Ctrl+Z/Y/S/E drive editing.
    // Editing accelerators live here rather than on the panes so that one key
    // press cannot be handled twice as the event bubbles.
    this._ctrlFHandler = (/** @type {KeyboardEvent} */ e) => {
      if (!isActive('hex')) return
      if (!(e.ctrlKey || e.metaKey)) return
      const inField = e.target instanceof Element &&
        e.target.matches('input, textarea, select')
      const key = e.key.toLowerCase()

      if (key === 'f') {
        e.preventDefault()
        findInput.focus()
        findInput.select()
        return
      }
      if (inField) return
      if (key === 'e') {
        e.preventDefault()
        this.toggleEditMode()
      } else if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        this.undo()
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault()
        this.redo()
      } else if (key === 's') {
        e.preventDefault()
        const side = e.shiftKey ? 'right' : (this._cursor?.side ?? 'left')
        void this.saveSide(side)
      }
    }
    document.addEventListener('keydown', this._ctrlFHandler)

    // ── T11: Goto offset ───────────────────────────────────────────────────────
    gotoInput.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Enter') {
        this._gotoOffset(gotoInput.value.trim())
      }
    })

    // ── S16: difference navigation + swap ──────────────────────────────────────
    const { btnDiffFirst, btnDiffPrev, btnDiffNext, btnDiffLast, btnSwap } = this._dom
    btnDiffFirst.addEventListener('click', () => this.firstDifference())
    btnDiffPrev.addEventListener('click',  () => this.prevDifference())
    btnDiffNext.addEventListener('click',  () => this.nextDifference())
    btnDiffLast.addEventListener('click',  () => this.lastDifference())
    btnSwap.addEventListener('click',      () => this.swap())

    const {
      btnShowAll, btnShowDiff, btnShowSame,
      btnCopyRight, btnCopyLeft, btnReport, btnPrint,
    } = this._dom
    btnShowAll.addEventListener('click',  () => this.setShowFilter('all'))
    btnShowDiff.addEventListener('click', () => this.setShowFilter('diff'))
    btnShowSame.addEventListener('click', () => this.setShowFilter('same'))
    btnCopyRight.addEventListener('click', () => void this.copyToRight())
    btnCopyLeft.addEventListener('click',  () => void this.copyToLeft())
    btnReport.addEventListener('click', () => void this.exportHtml())
    btnPrint.addEventListener('click',  () => void this.exportHtml({ print: true }))

    const { btnDetails, btnFileInfo, btnRuler } = this._dom
    btnDetails.addEventListener('click', () => this.toggleDetails())
    btnFileInfo.addEventListener('click', () => this.toggleFileInfo())
    btnRuler.addEventListener('click', () => this.toggleRuler())

    // Diff-navigation keys are owned solely by app.js's SettingsStore binding,
    // which routes to whichever view is active. Binding them here as well made
    // every F8 press advance two differences.

    this._setupDropTargets()
  }

  // ── Private: unsaved-changes guards (P2-22) ─────────────────────────────────

  /**
   * Warn before unsaved bytes are thrown away.
   *
   * The host closes tabs without asking the view, so the guards run in the
   * capture phase and cancel the event when the user says no. `confirmClose()`
   * is also public so the host can call it directly once it grows a hook.
   */
  _installCloseGuards() {
    this._closeGuard = (/** @type {Event} */ e) => {
      if (!this.hasUnsavedEdits() || !isActive('hex')) return
      const target = e.target instanceof Element ? e.target : null
      const btn = target?.closest('.tab-close')
      // Only the active tab's close button can be closing *this* view.
      if (!btn || !btn.closest('.tab-item--active')) return
      if (this.confirmClose()) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    document.addEventListener('click', this._closeGuard, true)

    this._closeKeyGuard = (/** @type {KeyboardEvent} */ e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'w') return
      if (!this.hasUnsavedEdits() || !isActive('hex')) return
      if (this.confirmClose()) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    document.addEventListener('keydown', this._closeKeyGuard, true)

    // No beforeunload guard: in Electron a renderer that cancels beforeunload
    // leaves the window unclosable unless the main process handles
    // 'will-prevent-unload', which this view cannot arrange from here. Guarding
    // the window close is therefore left to the main process.
  }

  /** Remove the guards installed by _installCloseGuards. */
  _removeCloseGuards() {
    if (this._closeGuard) {
      document.removeEventListener('click', this._closeGuard, true)
      this._closeGuard = null
    }
    if (this._closeKeyGuard) {
      document.removeEventListener('keydown', this._closeKeyGuard, true)
      this._closeKeyGuard = null
    }
  }

  // ── Private: Drag & drop ─────────────────────────────────────────────────────

  /**
   * Accept binaries dropped onto either pane.
   *
   * The pane that took the drop chooses the side, so one file can be replaced
   * without disturbing the other; dropping two at once fills both.
   */
  _setupDropTargets() {
    /** @type {Array<[HTMLElement, 'left'|'right']>} */
    const targets = [
      [this._dom.pane_left, 'left'],
      [this._dom.pane_right, 'right'],
    ].filter(([node]) => Boolean(node))

    /** @type {Array<() => void>} */
    const cleanups = []

    for (const [node, side] of targets) {
      const onOver = (/** @type {DragEvent} */ e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        node.classList.add('hx-drop-target')
      }
      const onLeave = () => node.classList.remove('hx-drop-target')
      const onDrop = (/** @type {DragEvent} */ e) => {
        e.preventDefault()
        e.stopPropagation()
        node.classList.remove('hx-drop-target')
        void this._acceptDrop(e, side)
      }
      node.addEventListener('dragenter', onOver)
      node.addEventListener('dragover', onOver)
      node.addEventListener('dragleave', onLeave)
      node.addEventListener('drop', onDrop)
      cleanups.push(() => {
        node.removeEventListener('dragenter', onOver)
        node.removeEventListener('dragover', onOver)
        node.removeEventListener('dragleave', onLeave)
        node.removeEventListener('drop', onDrop)
      })
    }

    this._dropCleanup = () => { for (const fn of cleanups) fn() }
  }

  /**
   * Report a drop failure where the user will actually see it.
   *
   * The host wires a 'status' listener; without one the message would vanish,
   * so a toast is the fallback rather than a console line. Not an alert: a
   * modal dialog raised from a drop handler blocks the renderer.
   *
   * @param {string} message
   */
  _dropError(message) {
    this._emit('status', { message, level: 'error' })
    if (!this._handlers.status?.length) toast(message, { type: 'error' })
  }

  /**
   * @param {DragEvent} e
   * @param {'left'|'right'} side  the pane the drop landed on
   * @returns {Promise<void>}
   */
  async _acceptDrop(e, side) {
    const files = [...(e.dataTransfer?.files ?? [])]
    if (!files.length) return

    let entries
    try {
      // The File objects go across as they are: Electron 32 removed File.path,
      // and letting the renderer name a path would be self-authorisation.
      entries = await window.electronAPI?.acceptDroppedFiles?.(files)
    } catch (err) {
      this._dropError(`無法接受拖放的檔案：${err instanceof Error ? err.message : String(err)}`)
      return
    }

    if (!entries?.length) {
      // preload resolves a path only for a File the OS really handed over.
      this._dropError('無法取得拖放檔案的路徑')
      return
    }

    const usable = entries.filter((entry) => entry && !entry.isDirectory)
    if (!usable.length) {
      this._dropError('請拖放檔案，而非資料夾')
      return
    }

    const plan = usable.length > 1
      ? /** @type {Array<['left'|'right', { path: string }]>} */ ([['left', usable[0]], ['right', usable[1]]])
      : /** @type {Array<['left'|'right', { path: string }]>} */ ([[side, usable[0]]])

    for (const [target, entry] of plan) {
      await this._loadDroppedFile(target, entry.path)
    }
  }

  /**
   * @param {'left'|'right'} side
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _loadDroppedFile(side, path) {
    let result
    try {
      result = await window.electronAPI.readFileBinary(path, MAX_BYTES)
    } catch (err) {
      this._dropError(`載入 ${path} 失敗：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!result) return
    if (side === 'left') this.setLeft(result.path, result.base64)
    else this.setRight(result.path, result.base64)
    if (result.truncated) {
      this._dropError(`${path} 超過大小上限 ${formatSize(MAX_BYTES)}，僅載入前段內容`)
    }
  }

  // ── Private: Find (T10) ──────────────────────────────────────────────────────

  /**
   * 將搜尋字串解析為 Uint8Array needle
   * @param {string} text
   * @param {boolean} hexMode
   * @returns {Uint8Array|null}
   */
  _parseNeedle(text, hexMode) {
    const trimmed = text.trim()
    if (!trimmed) return null
    if (hexMode) {
      // 移除所有空白，將「FF 00 1A」解析為 bytes
      const tokens = trimmed.replace(/\s+/g, '')
      if (tokens.length === 0 || tokens.length % 2 !== 0) return null
      const bytes = []
      for (let i = 0; i < tokens.length; i += 2) {
        const byte = parseInt(tokens.slice(i, i + 2), 16)
        if (isNaN(byte)) return null
        bytes.push(byte)
      }
      return new Uint8Array(bytes)
    } else {
      // ASCII 模式：將字串轉為 UTF-8 bytes（限 latin1 範圍）
      return new Uint8Array(Array.from(trimmed, (c) => c.charCodeAt(0) & 0xff))
    }
  }

  /**
   * 執行搜尋並更新高亮
   */
  _runFind() {
    const { findInput, findModeCheck, findCount } = this._dom
    if (!findInput) return

    const text    = findInput.value
    const hexMode = /** @type {HTMLInputElement} */ (findModeCheck).checked
    const needle  = this._parseNeedle(text, hexMode)

    // Clear previous highlights before rebuilding
    this._clearFindHighlights()
    this._findMatches     = []
    this._findCurrentIdx  = -1

    if (!needle || needle.length === 0) {
      if (findCount) findCount.textContent = ''
      return
    }

    /** @type {Array<{side: 'left'|'right', rowIndex: number, byteOffset: number}>} */
    const matches = []

    for (const side of /** @type {('left'|'right')[]} */ (['left', 'right'])) {
      const bytes = side === 'left' ? this._leftBytes : this._rightBytes
      if (!bytes) continue
      const offsets = searchHexBytes(bytes, needle)
      for (const offset of offsets) {
        const rowIndex = Math.floor(offset / this._bytesPerRow)
        matches.push({ side, rowIndex, byteOffset: offset })
      }
    }

    this._findMatches = matches

    if (findCount) {
      findCount.textContent = matches.length > 0 ? `0 / ${matches.length}` : '無結果'
    }

    if (matches.length > 0) {
      this._findCurrentIdx = 0
      this._applyFindHighlights()
      this._scrollToMatch(0)
      if (findCount) findCount.textContent = `1 / ${matches.length}`
    }
  }

  /**
   * 移動到上一個 / 下一個匹配
   * @param {1|-1} direction
   */
  _stepFind(direction) {
    if (this._findMatches.length === 0) return
    const total = this._findMatches.length
    this._clearFindHighlights()
    this._findCurrentIdx = ((this._findCurrentIdx + direction) % total + total) % total
    this._applyFindHighlights()
    this._scrollToMatch(this._findCurrentIdx)
    const { findCount } = this._dom
    if (findCount) findCount.textContent = `${this._findCurrentIdx + 1} / ${total}`
  }

  /**
   * 清除所有高亮並重置狀態
   */
  _clearFind() {
    this._clearFindHighlights()
    this._findMatches    = []
    this._findCurrentIdx = -1
    const { findCount } = this._dom
    if (findCount) findCount.textContent = ''
  }

  /**
   * 移除現有的 hx-find-match / hx-find-match-active class（直接操作 DOM spans）
   */
  _clearFindHighlights() {
    if (!this._container) return
    for (const el of this._container.querySelectorAll('.hx-find-match, .hx-find-match-active')) {
      el.classList.remove('hx-find-match', 'hx-find-match-active')
    }
  }

  /**
   * 在 DOM 中為所有命中 bytes 加上 hx-find-match；當前命中加 hx-find-match-active
   */
  _applyFindHighlights() {
    if (!this._container) return
    const needle = this._parseNeedle(
      /** @type {HTMLInputElement} */ (this._dom.findInput)?.value ?? '',
      /** @type {HTMLInputElement} */ (this._dom.findModeCheck)?.checked ?? true,
    )
    if (!needle || needle.length === 0) return

    for (let mi = 0; mi < this._findMatches.length; mi++) {
      const match    = this._findMatches[mi]
      const isActive = mi === this._findCurrentIdx
      const inner    = this._dom[`inner_${match.side}`]
      if (!inner) continue

      for (let ni = 0; ni < needle.length; ni++) {
        const absOffset = match.byteOffset + ni
        const rowIndex  = Math.floor(absOffset / this._bytesPerRow)
        const colIndex  = absOffset % this._bytesPerRow

        const rowEl = inner.querySelector(`.hx-row[data-row="${rowIndex}"]`)
        if (!rowEl) continue

        const hexSpans   = rowEl.querySelectorAll('.hx-hex .hx-byte')
        const asciiSpans = rowEl.querySelectorAll('.hx-ascii .hx-ascii-char')

        // colIndex accounts for the mid-group text node gap — index directly
        const hexSpan   = hexSpans[colIndex]
        const asciiSpan = asciiSpans[colIndex]

        const cls = isActive ? 'hx-find-match-active' : 'hx-find-match'
        if (hexSpan)   hexSpan.classList.add(cls)
        if (asciiSpan) asciiSpan.classList.add(cls)
      }
    }
  }

  /**
   * 滾動兩側 pane 到指定 match index 的列
   * @param {number} matchIdx
   */
  _scrollToMatch(matchIdx) {
    const match = this._findMatches[matchIdx]
    if (!match) return
    const targetTop = this._visualIndexOf(match.rowIndex) * ROW_HEIGHT
    for (const side of /** @type {('left'|'right')[]} */ (['left', 'right'])) {
      const scroll = this._dom[`scroll_${side}`]
      if (scroll) {
        scroll.scrollTo({ top: targetTop, behavior: 'smooth' })
      }
    }
    // Re-render to ensure row is in DOM, then apply highlights
    this._renderVisibleRows(match.side, this._dom[`scroll_${match.side}`])
    this._applyFindHighlights()
  }

  // ── Private: Goto offset (T11) ────────────────────────────────────────────────

  /**
   * 解析 hex offset 字串並滾動到對應列
   * @param {string} text
   */
  _gotoOffset(text) {
    const offset = parseInt(text, 16)
    if (isNaN(offset) || offset < 0) return

    // 以左側檔案大小為主；若無左側資料則用右側
    const maxOffset = Math.max(
      this._leftBytes  ? this._leftBytes.byteLength  : 0,
      this._rightBytes ? this._rightBytes.byteLength : 0,
    )
    if (offset >= maxOffset) return

    const rowIndex = Math.floor(offset / this._bytesPerRow)
    const targetTop = this._visualIndexOf(rowIndex) * ROW_HEIGHT

    for (const side of /** @type {('left'|'right')[]} */ (['left', 'right'])) {
      const scroll = this._dom[`scroll_${side}`]
      if (scroll) {
        scroll.scrollTo({ top: targetTop, behavior: 'smooth' })
      }
    }
  }

  // ── Private: difference navigation (S16) ──────────────────────────────────────

  /** 依當前演算法模式重算差異區塊，並把選取索引夾回合法範圍 */
  _recomputeDiffRegions() {
    const useComplete = this._diffAlgorithm === 'complete'
      && this._completeLeftClass !== null && this._completeRightClass !== null
    this._diffRegions = computeHexDiffRegions(
      this._leftBytes,
      this._rightBytes,
      useComplete
        ? { leftClass: this._completeLeftClass, rightClass: this._completeRightClass }
        : {},
    )
    if (this._diffRegions.length === 0) {
      this._currentDiffIdx = -1
    } else if (this._currentDiffIdx >= this._diffRegions.length) {
      this._currentDiffIdx = this._diffRegions.length - 1
    }
    this._recomputeRowFilter()
    this._updateDiffCounter()
    this._consumePendingFirstDiff()
  }

  // ── Private: Show filter (P2-36) ──────────────────────────────────────────────

  /**
   * Rebuild the visible-row list from the current diff regions.
   *
   * A row counts as differing when any difference region overlaps it, so the
   * filter agrees with the colouring and with difference navigation by
   * construction rather than by a second, parallel comparison.
   */
  _recomputeRowFilter() {
    if (this._showFilter === 'all') {
      this._filteredRows = null
      this._rowToVisual = null
      return
    }

    const bpr = this._bytesPerRow
    const maxRows = Math.max(this._totalRows('left'), this._totalRows('right'))
    if (maxRows === 0) {
      this._filteredRows = new Int32Array(0)
      this._rowToVisual = new Int32Array(0)
      return
    }

    const isDiffRow = new Uint8Array(maxRows)
    for (const region of this._diffRegions) {
      const from = Math.floor(region.start / bpr)
      const to = Math.min(maxRows - 1, Math.floor((region.end - 1) / bpr))
      for (let r = from; r <= to; r++) isDiffRow[r] = 1
    }

    const wantDiff = this._showFilter === 'diff'
    const visible = new Int32Array(maxRows)
    let count = 0
    for (let r = 0; r < maxRows; r++) {
      if ((isDiffRow[r] === 1) === wantDiff) visible[count++] = r
    }
    this._filteredRows = visible.slice(0, count)

    // Walk backwards so each hidden row inherits the next visible row's index.
    const toVisual = new Int32Array(maxRows)
    let next = count - 1
    for (let r = maxRows - 1; r >= 0; r--) {
      if (next >= 0 && this._filteredRows[next] === r) {
        toVisual[r] = next
        next--
      } else {
        toVisual[r] = Math.max(0, next + 1)
      }
    }
    this._rowToVisual = toVisual
  }

  /**
   * Number of rows the scroller must account for on one side.
   * @param {'left'|'right'} side
   * @returns {number}
   */
  _visibleRowCount(side) {
    return this._filteredRows ? this._filteredRows.length : this._totalRows(side)
  }

  /**
   * @param {number} visualIdx
   * @returns {number} source row index, or -1 when out of range
   */
  _sourceRowAt(visualIdx) {
    if (!this._filteredRows) return visualIdx
    return visualIdx >= 0 && visualIdx < this._filteredRows.length
      ? this._filteredRows[visualIdx]
      : -1
  }

  /**
   * @param {number} sourceRow
   * @returns {number} visual index used for scroll positioning
   */
  _visualIndexOf(sourceRow) {
    const map = this._rowToVisual
    if (!map) return sourceRow
    if (map.length === 0) return 0
    if (sourceRow < 0) return 0
    return sourceRow < map.length ? map[sourceRow] : map.length - 1
  }

  /** @returns {'all'|'diff'|'same'} */
  getShowFilter() {
    return this._showFilter
  }

  /**
   * @param {'all'|'diff'|'same'} mode
   * @returns {'all'|'diff'|'same'} the mode actually in effect
   */
  setShowFilter(mode) {
    if (mode !== 'all' && mode !== 'diff' && mode !== 'same') return this._showFilter
    this._showFilter = mode
    this._recomputeRowFilter()
    this._syncShowButtons()
    this._renderPaneContent('left')
    this._renderPaneContent('right')
    return this._showFilter
  }

  /** Reflect the active filter on the toolbar buttons. */
  _syncShowButtons() {
    for (const [mode, key] of [['all', 'btnShowAll'], ['diff', 'btnShowDiff'], ['same', 'btnShowSame']]) {
      const btn = this._dom[key]
      if (btn) btn.classList.toggle('active', this._showFilter === mode)
    }
  }

  /**
   * BC's "when loading new files, go to first difference". Gated on a flag set
   * by setLeft/setRight so that a mere option or algorithm change — which also
   * recomputes regions — does not yank the user's scroll position.
   */
  _consumePendingFirstDiff() {
    if (!this._pendingFirstDiff) return
    this._pendingFirstDiff = false
    if (!this._diffRegions.length) return
    if (!getNavOptions().firstDiffOnLoad) return
    this._gotoDiff(0)
  }

  /**
   * 選取並捲動至指定差異區塊
   * @param {number} idx
   */
  _gotoDiff(idx) {
    const region = this._diffRegions[idx]
    if (!region) return
    this._currentDiffIdx = idx
    this._clearCurrentDiffHighlight()

    const rowIndex = this._visualIndexOf(Math.floor(region.start / this._bytesPerRow))
    for (const side of /** @type {('left'|'right')[]} */ (['left', 'right'])) {
      const scroll = this._dom[`scroll_${side}`]
      if (!scroll) continue
      const viewHeight = scroll.clientHeight || 300
      // 置中；smooth 捲動會讓 scrollTop 還沒更新就渲染，故直接指派
      const top = Math.max(0, rowIndex * ROW_HEIGHT - Math.floor(viewHeight / 2) + ROW_HEIGHT)
      scroll.scrollTop = top
      this._renderVisibleRows(side, scroll)
    }

    this._applyCurrentDiffHighlight()
    this._updateDiffCounter()
  }

  /** 移除目前差異區塊的高亮 */
  _clearCurrentDiffHighlight() {
    if (!this._container) return
    for (const node of this._container.querySelectorAll('.hx-current-diff')) {
      node.classList.remove('hx-current-diff')
    }
  }

  /**
   * 為目前差異區塊在已渲染的列上加上 hx-current-diff。
   * 只掃描 DOM 中存在的列，因此成本與可視區大小成正比，而非與區塊大小成正比。
   */
  _applyCurrentDiffHighlight() {
    const region = this._diffRegions[this._currentDiffIdx]
    if (!region) return
    const bpr = this._bytesPerRow

    for (const side of /** @type {('left'|'right')[]} */ (['left', 'right'])) {
      const inner = this._dom[`inner_${side}`]
      if (!inner) continue
      for (const rowEl of inner.querySelectorAll('.hx-row[data-row]')) {
        const rowStart = parseInt(rowEl.dataset.row, 10) * bpr
        if (rowStart + bpr <= region.start || rowStart >= region.end) continue

        const hexSpans   = rowEl.querySelectorAll('.hx-hex .hx-byte')
        const asciiSpans = rowEl.querySelectorAll('.hx-ascii .hx-ascii-char')
        const from = Math.max(region.start - rowStart, 0)
        const to   = Math.min(region.end - rowStart, bpr)
        for (let c = from; c < to; c++) {
          hexSpans[c]?.classList.add('hx-current-diff')
          asciiSpans[c]?.classList.add('hx-current-diff')
        }
      }
    }
  }

  /** 更新「第 X / N 個差異」顯示與導航按鈕可用狀態 */
  _updateDiffCounter() {
    const total = this._diffRegions.length
    const label = this._dom.diffCount
    if (label) {
      label.textContent = total === 0
        ? '無差異'
        : this._currentDiffIdx < 0
          ? `共 ${total} 個差異`
          : `第 ${this._currentDiffIdx + 1} / ${total} 個差異`
    }
    for (const key of ['btnDiffFirst', 'btnDiffPrev', 'btnDiffNext', 'btnDiffLast']) {
      const btn = this._dom[key]
      if (btn instanceof HTMLButtonElement) btn.disabled = total === 0
    }
  }

  /**
   * @param {MouseEvent} e
   * @param {'left'|'right'} side
   */
  _onHexContextMenu(e, side) {
    const rowEl = (e.target instanceof Element ? e.target : null)?.closest('.hx-row')
    if (!rowEl) return

    const hexEl   = rowEl.querySelector('.hx-hex')
    const asciiEl = rowEl.querySelector('.hx-ascii')
    const offsetEl= rowEl.querySelector('.hx-offset')

    const hexText   = hexEl   ? hexEl.textContent.trim()   : ''
    const asciiText = asciiEl ? asciiEl.textContent        : ''
    const offsetText= offsetEl? offsetEl.textContent.trim(): ''

    const items = [
      {
        label: '複製 Hex（此列）',
        action: () => navigator.clipboard.writeText(hexText)
      },
      {
        label: '複製 ASCII（此列）',
        action: () => navigator.clipboard.writeText(asciiText.replace(/\s+/g, ''))
      },
      { separator: true },
      {
        label: `複製 Offset：${offsetText}`,
        disabled: !offsetText,
        action: () => navigator.clipboard.writeText(offsetText)
      },
    ]

    // P1-10: writing to the other side acts on whichever difference region the
    // clicked row belongs to, so the menu selects it before offering the copy.
    const sourceRow = parseInt(rowEl.dataset.row ?? '', 10)
    const regionIdx = Number.isNaN(sourceRow)
      ? -1
      : this._regionIndexAtRow(sourceRow)
    if (regionIdx >= 0) {
      items.push({ separator: true })
      items.push({
        label: '將此差異區塊複製到右側檔案…',
        disabled: !this._rightPath,
        action: () => { this._gotoDiff(regionIdx); void this.copyToRight() },
      })
      items.push({
        label: '將此差異區塊複製到左側檔案…',
        disabled: !this._leftPath,
        action: () => { this._gotoDiff(regionIdx); void this.copyToLeft() },
      })
    }

    // P0-5: every other view offers this; hex was the only one without it.
    const path = side === 'left' ? this._leftPath : this._rightPath
    items.push({ separator: true })
    items.push({
      label: '在檔案總管中顯示',
      disabled: !path,
      action: () => window.electronAPI.showInExplorer(path),
    })

    showContextMenu(e, items)
  }

  /**
   * @param {number} sourceRow
   * @returns {number} index of the difference region covering that row, or -1
   */
  _regionIndexAtRow(sourceRow) {
    const bpr = this._bytesPerRow
    const rowStart = sourceRow * bpr
    const rowEnd = rowStart + bpr
    for (let i = 0; i < this._diffRegions.length; i++) {
      const r = this._diffRegions[i]
      if (r.start < rowEnd && r.end > rowStart) return i
    }
    return -1
  }

  // ── Private: Synchronized scroll ─────────────────────────────────────────────

  _onScrollLeft() {
    if (this._syncingScroll) return
    this._syncingScroll = true
    const { scroll_left, scroll_right } = this._dom
    scroll_right.scrollTop  = scroll_left.scrollTop
    scroll_right.scrollLeft = scroll_left.scrollLeft
    this._renderVisibleRows('left',  scroll_left)
    this._renderVisibleRows('right', scroll_right)
    this._syncingScroll = false
  }

  _onScrollRight() {
    if (this._syncingScroll) return
    this._syncingScroll = true
    const { scroll_left, scroll_right } = this._dom
    scroll_left.scrollTop  = scroll_right.scrollTop
    scroll_left.scrollLeft = scroll_right.scrollLeft
    this._renderVisibleRows('left',  scroll_left)
    this._renderVisibleRows('right', scroll_right)
    this._syncingScroll = false
  }

  // ── Private: Pane rendering ───────────────────────────────────────────────────

  /**
   * 顯示空狀態（無資料時）
   * @param {'left'|'right'} side
   */
  _showEmptyState(side) {
    const inner = this._dom[`inner_${side}`]
    if (!inner) return
    inner.style.height = '100%'
    inner.innerHTML = ''
    inner.appendChild(
      el('div', { className: 'hx-empty-state' },
        el('span', { className: 'hx-empty-icon' }, '💾'),
        el('span', {}, '請選擇二進位檔案')
      )
    )
  }

  /**
   * 計算當前 side 的總列數
   * @param {'left'|'right'} side
   * @returns {number}
   */
  _totalRows(side) {
    const bytes = side === 'left' ? this._leftBytes : this._rightBytes
    if (!bytes || bytes.byteLength === 0) return 0
    return Math.ceil(bytes.byteLength / this._bytesPerRow)
  }

  /**
   * 重新設定 inner 高度並觸發可視列渲染
   * @param {'left'|'right'} side
   */
  _renderPaneContent(side) {
    const bytes  = side === 'left' ? this._leftBytes : this._rightBytes
    const inner  = this._dom[`inner_${side}`]
    const scroll = this._dom[`scroll_${side}`]
    if (!inner || !scroll) return

    if (!bytes || bytes.byteLength === 0) {
      this._showEmptyState(side)
      return
    }

    const visualRows = this._visibleRowCount(side)
    if (visualRows === 0) {
      inner.style.height = '100%'
      inner.innerHTML = ''
      inner.appendChild(
        el('div', { className: 'hx-empty-state' },
          el('span', { className: 'hx-empty-icon' }, '🔍'),
          el('span', {}, this._showFilter === 'diff' ? '無差異列' : '無相同列'),
        ),
      )
      return
    }
    inner.style.height = `${visualRows * ROW_HEIGHT}px`
    // 清除舊的 absolute 子節點（保留 empty-state 等非 hx-row 節點）
    inner.innerHTML = ''

    this._renderVisibleRows(side, scroll)
  }

  /**
   * 依 scrollTop 計算可視範圍，只渲染可見列（Virtual Scroll）
   * @param {'left'|'right'} side
   * @param {HTMLElement} scroll
   */
  _renderVisibleRows(side, scroll) {
    const bytes  = side === 'left' ? this._leftBytes : this._rightBytes
    const inner  = this._dom[`inner_${side}`]
    if (!bytes || bytes.byteLength === 0 || !inner) return

    const totalRows   = this._visibleRowCount(side)
    const viewHeight  = scroll.clientHeight || 300
    const scrollTop   = scroll.scrollTop
    const visibleRows = Math.ceil(viewHeight / ROW_HEIGHT)

    // Indices here are *visual* (post-filter) positions; `data-row` keeps the
    // source row index because the find and diff highlighters address rows by
    // byte offset.
    const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 2)
    const endRow   = Math.min(totalRows - 1, startRow + visibleRows + 4)

    // 移除超出範圍的列（保留 [startRow, endRow]）
    const existing = inner.querySelectorAll('.hx-row[data-vrow]')
    for (const rowEl of existing) {
      const idx = parseInt(rowEl.dataset.vrow, 10)
      if (idx < startRow || idx > endRow) {
        rowEl.remove()
      }
    }

    // 建立尚未存在的列
    const existingSet = new Set()
    for (const rowEl of inner.querySelectorAll('.hx-row[data-vrow]')) {
      existingSet.add(parseInt(rowEl.dataset.vrow, 10))
    }

    const sideRows = this._totalRows(side)
    const fragment = document.createDocumentFragment()
    for (let i = startRow; i <= endRow; i++) {
      if (existingSet.has(i)) continue
      const sourceRow = this._sourceRowAt(i)
      // A filtered view is shared by both panes, so a row may exist on one side
      // only; leaving its slot empty keeps the two panes aligned.
      if (sourceRow < 0 || sourceRow >= sideRows) continue
      const rowEl = this._buildHexRow(side, sourceRow, bytes)
      rowEl.style.top = `${i * ROW_HEIGHT}px`
      rowEl.dataset.row = String(sourceRow)
      rowEl.dataset.vrow = String(i)
      fragment.appendChild(rowEl)
    }
    inner.appendChild(fragment)

    // Re-apply find highlights for newly rendered rows
    if (this._findMatches.length > 0) {
      this._applyFindHighlights()
    }
    if (this._currentDiffIdx >= 0) {
      this._applyCurrentDiffHighlight()
    }
  }

  /**
   * 建立單列 hex 資料的 DOM 節點
   * @param {'left'|'right'} side
   * @param {number} rowIndex
   * @param {Uint8Array} bytes
   * @returns {HTMLElement}
   */
  _buildHexRow(side, rowIndex, bytes) {
    const bpr    = this._bytesPerRow
    const offset = rowIndex * bpr
    const end    = Math.min(offset + bpr, bytes.byteLength)

    // 對側 bytes（用於 diff 著色）
    const otherBytes = side === 'left' ? this._rightBytes : this._leftBytes
    const flags = this._flags[side]
    const cursor = this._cursor && this._cursor.side === side ? this._cursor : null

    const rowEl = el('div', { className: 'hx-row' })

    // ── Offset column ──
    rowEl.appendChild(
      el('div', { className: 'hx-offset', textContent: formatOffset(offset) })
    )

    // ── Hex bytes column ──
    const hexCol   = el('div', { className: 'hx-hex' })
    // ── ASCII column ──
    const asciiCol = el('div', { className: 'hx-ascii' })

    for (let i = 0; i < bpr; i++) {
      const byteOffset = offset + i

      // 中間額外空格（第 8 byte 後）
      if (i === Math.floor(bpr / 2)) {
        hexCol.appendChild(document.createTextNode(' '))
      }

      if (byteOffset >= end) {
        // 超出當前 side 範圍 → 空格佔位
        hexCol.appendChild(document.createTextNode('   '))
        asciiCol.appendChild(document.createTextNode(' '))
        continue
      }

      const byteVal  = bytes[byteOffset]
      const diffClass = this._getDiffClass(side, byteOffset, byteVal, otherBytes)

      // Hex span
      // P2-22: the modified marker comes from the data model, so it survives a
      // row being discarded and rebuilt by the virtual scroller.
      const extra = []
      if (diffClass) extra.push(diffClass)
      if (flags && flags[byteOffset] === 1) extra.push('hx-modified')
      const cls = extra.length ? ` ${extra.join(' ')}` : ''
      const atCursor = cursor !== null && cursor.offset === byteOffset
      const hexCursor = atCursor && cursor.field === 'hex'
        ? ` hx-cursor hx-cursor-n${cursor.nibble}`
        : ''
      const asciiCursor = atCursor && cursor.field === 'ascii' ? ' hx-cursor' : ''

      const hexSpan = el('span', { className: `hx-byte${cls}${hexCursor}` },
        toHex(byteVal) + (i < bpr - 1 ? ' ' : '')
      )
      hexCol.appendChild(hexSpan)

      // ASCII span
      const asciiSpan = el('span',
        { className: `hx-ascii-char${cls}${asciiCursor}` },
        toAsciiChar(byteVal)
      )
      asciiCol.appendChild(asciiSpan)
    }

    rowEl.appendChild(hexCol)
    rowEl.appendChild(asciiCol)
    return rowEl
  }

  /**
   * 依 byte offset 與對側資料決定 diff CSS class
   * @param {'left'|'right'} side
   * @param {number} offset
   * @param {number} byteVal
   * @param {Uint8Array|null} otherBytes
   * @returns {string} '' | 'diff' | 'left-only' | 'right-only'
   */
  _getDiffClass(side, offset, byteVal, otherBytes) {
    // T78: complete-mode uses pre-computed classification per offset.
    if (this._diffAlgorithm === 'complete') {
      const cls = side === 'left' ? this._completeLeftClass : this._completeRightClass
      if (cls && offset < cls.length) {
        return cls[offset] === 1 ? 'diff' : ''
      }
      // Fall through to fast logic for offsets without classification.
    }
    if (!otherBytes) {
      // 對側無資料 → 本側為孤兒 byte
      return side === 'left' ? 'left-only' : 'right-only'
    }
    if (offset >= otherBytes.byteLength) {
      // 本側超出對側長度範圍 → 孤兒
      return side === 'left' ? 'left-only' : 'right-only'
    }
    const otherVal = otherBytes[offset]
    if (byteVal !== otherVal) return 'diff'
    return ''
  }

  /**
   * T78: (re)compute complete-mode classification if both sides are
   * available and within the 1MB cap. Falls back silently otherwise.
   */
  _recomputeCompleteIfNeeded() {
    if (this._diffAlgorithm !== 'complete') {
      this._completeLeftClass = null
      this._completeRightClass = null
      return
    }
    if (!this._leftBytes || !this._rightBytes) {
      this._completeLeftClass = null
      this._completeRightClass = null
      return
    }
    // Myers cost is O((N+M)·D). Scale the edit-distance budget by input size so
    // worst-case work stays within ~2·10^8 byte comparisons regardless of file
    // size; oversized diffs degrade to a positional compare rather than hanging.
    const total = this._leftBytes.length + this._rightBytes.length + 1
    const maxEditDistance = Math.max(64, Math.min(HEX_COMPLETE_MAX_D, Math.floor(2e8 / total)))
    const result = hexCompleteByteDiff(this._leftBytes, this._rightBytes, { maxEditDistance })
    this._completeLeftClass  = result.leftClass
    this._completeRightClass = result.rightClass
    const warning = this._dom.warning
    if (result.truncated && warning) {
      warning.style.display = ''
      warning.textContent =
        `⚠ 差異量超過 Complete 演算法上限（編輯距離 > ${maxEditDistance}），此區段以位置對齊近似`
    }
  }

  // ── P2-40: Details / File Info / Ruler ──────────────────────────────────────

  /** @returns {boolean} */
  isDetailsVisible() { return this._showDetails }

  /** @returns {boolean} */
  isFileInfoVisible() { return this._showFileInfo }

  /** @returns {boolean} */
  isRulerVisible() { return this._showRuler }

  /**
   * @param {boolean} on
   * @returns {boolean} the state now in effect
   */
  setDetailsVisible(on) {
    this._showDetails = Boolean(on)
    this._applyPanelVisibility()
    return this._showDetails
  }

  /** @returns {boolean} */
  toggleDetails() { return this.setDetailsVisible(!this._showDetails) }

  /**
   * @param {boolean} on
   * @returns {boolean} the state now in effect
   */
  setFileInfoVisible(on) {
    this._showFileInfo = Boolean(on)
    this._applyPanelVisibility()
    return this._showFileInfo
  }

  /** @returns {boolean} */
  toggleFileInfo() { return this.setFileInfoVisible(!this._showFileInfo) }

  /**
   * @param {boolean} on
   * @returns {boolean} the state now in effect
   */
  setRulerVisible(on) {
    this._showRuler = Boolean(on)
    this._applyPanelVisibility()
    return this._showRuler
  }

  /** @returns {boolean} */
  toggleRuler() { return this.setRulerVisible(!this._showRuler) }

  /** Push the three panel flags onto the DOM and repaint whatever became visible. */
  _applyPanelVisibility() {
    const { detailsPanel, fileInfoPanel, panels, btnDetails, btnFileInfo, btnRuler } = this._dom
    if (detailsPanel) detailsPanel.style.display = this._showDetails ? '' : 'none'
    if (fileInfoPanel) fileInfoPanel.style.display = this._showFileInfo ? '' : 'none'
    if (panels) panels.style.display = (this._showDetails || this._showFileInfo) ? '' : 'none'
    btnDetails?.classList.toggle('active', this._showDetails)
    btnFileInfo?.classList.toggle('active', this._showFileInfo)
    btnRuler?.classList.toggle('active', this._showRuler)

    for (const side of /** @type {const} */ (['left', 'right'])) {
      const ruler = this._dom[`ruler_${side}`]
      if (ruler) ruler.style.display = this._showRuler ? '' : 'none'
    }
    if (this._showRuler) this._renderRulers()
    if (this._showDetails) this._updateDetailsPanel()
    if (this._showFileInfo) this._updateFileInfoPanel()
  }

  /** Rebuild both rulers for the current bytes-per-row. */
  _renderRulers() {
    const { hex, ascii } = rulerCells(this._bytesPerRow)
    const bpr = this._bytesPerRow
    for (const side of /** @type {const} */ (['left', 'right'])) {
      const ruler = this._dom[`ruler_${side}`]
      if (!ruler) continue
      ruler.innerHTML = ''
      ruler.appendChild(el('div', { className: 'hx-offset', textContent: '欄' }))
      const hexCol = el('div', { className: 'hx-hex' })
      const asciiCol = el('div', { className: 'hx-ascii' })
      for (let i = 0; i < bpr; i++) {
        // Mirrors _buildHexRow's mid-row gap, or the labels drift by one space
        // from the middle of the row onwards.
        if (i === Math.floor(bpr / 2)) hexCol.appendChild(document.createTextNode(' '))
        hexCol.appendChild(el('span', { className: 'hx-ruler-cell' },
          hex[i] + (i < bpr - 1 ? ' ' : '')))
        asciiCol.appendChild(el('span', { className: 'hx-ruler-cell' }, ascii[i]))
      }
      ruler.appendChild(hexCol)
      ruler.appendChild(asciiCol)
    }
  }

  /** Repaint the Details panel from the current cursor. */
  _updateDetailsPanel() {
    const body = this._dom.detailsBody
    if (!body || !this._showDetails) return
    body.innerHTML = ''

    const cursor = this._cursor
    if (!cursor) {
      body.appendChild(el('div', { className: 'hx-panel-empty' }, '點選任一位元組以檢視解讀值'))
      return
    }
    const bytes = cursor.side === 'left' ? this._leftBytes : this._rightBytes
    const rows = hexDetailRows(bytes, cursor.offset)
    if (rows.length === 0) {
      body.appendChild(el('div', { className: 'hx-panel-empty' }, '游標位置已超出檔案範圍'))
      return
    }

    body.appendChild(el('div', { className: 'hx-detail-head' },
      `${cursor.side === 'left' ? '左側' : '右側'} · offset 0x${formatOffset(cursor.offset)}`))

    const grid = el('div', { className: 'hx-detail-grid' })
    for (const row of rows) {
      grid.appendChild(el('span', { className: 'hx-detail-label' }, row.label))
      grid.appendChild(el('span',
        { className: `hx-detail-value${row.available ? '' : ' hx-detail-value--na'}` }, row.value))
    }
    body.appendChild(grid)
  }

  /**
   * Repaint the File Info panel.
   *
   * Modified time is not part of the binary payload the view is handed, so it
   * is fetched separately and cached; a failure is shown in the panel rather
   * than swallowed, because "no date" and "could not read the folder" are
   * different answers.
   */
  _updateFileInfoPanel() {
    const body = this._dom.fileInfoBody
    if (!body || !this._showFileInfo) return
    body.innerHTML = ''

    const stats = this.getStats()
    for (const side of /** @type {const} */ (['left', 'right'])) {
      const path = side === 'left' ? this._leftPath : this._rightPath
      const bytes = side === 'left' ? this._leftBytes : this._rightBytes
      const truncated = side === 'left' ? this._leftTruncated : this._rightTruncated
      const original = side === 'left' ? this._leftOriginalSize : this._rightOriginalSize

      const box = el('div', { className: 'hx-fileinfo-side' })
      box.appendChild(el('div', { className: 'hx-fileinfo-head' }, side === 'left' ? '左側' : '右側'))
      const grid = el('div', { className: 'hx-detail-grid' })
      /**
       * @param {string} label
       * @param {string} value
       */
      const add = (label, value) => {
        grid.appendChild(el('span', { className: 'hx-detail-label' }, label))
        grid.appendChild(el('span', { className: 'hx-detail-value' }, value))
      }
      add('路徑', path ?? '（未選擇）')
      add('大小', bytes ? formatSize(original || bytes.byteLength) : '—')
      add('已載入', bytes ? `${formatSize(bytes.byteLength)}（${bytes.byteLength} 位元組）` : '—')
      add('截斷', truncated ? `是（僅前 ${formatSize(MAX_BYTES)}）` : '否')
      add('差異位元組', String(stats.diffBytes))
      add('差異區塊', String(stats.regions))
      add('修改中位元組', String(this._modifiedCount[side]))
      add('修改時間', path ? (this._mtimeCache.get(path) ?? '讀取中…') : '—')
      box.appendChild(grid)
      this._dom[`fileInfoGrid_${side}`] = grid
      body.appendChild(box)
    }

    void this._loadMtimes()
  }

  /**
   * Fill `_mtimeCache` for the loaded paths by listing their parent folders.
   *
   * There is no per-file stat IPC; `read-dir` is the narrowest existing channel
   * that carries mtime. One listing per folder, cached by path.
   *
   * @returns {Promise<void>}
   */
  async _loadMtimes() {
    const readDir = window.electronAPI?.readDir
    if (typeof readDir !== 'function') {
      this._setMtimeText('（此環境無法讀取修改時間）')
      return
    }
    /** @type {string[]} */
    const wanted = [this._leftPath, this._rightPath]
      .filter((p) => typeof p === 'string' && p && !this._mtimeCache.has(p))
    if (wanted.length === 0) {
      this._paintMtimes()
      return
    }

    for (const path of wanted) {
      const dir = path.replace(/[\\/][^\\/]*$/, '')
      if (!dir || dir === path) {
        this._mtimeCache.set(path, '（無法判斷所在資料夾）')
        continue
      }
      try {
        const entries = await readDir(dir)
        const hit = (entries ?? []).find((entry) => entry?.path === path || entry?.name === path.slice(dir.length + 1))
        this._mtimeCache.set(path, hit?.mtime ? new Date(hit.mtime).toLocaleString() : '（找不到此檔案）')
      } catch (err) {
        this._mtimeCache.set(path, `（讀取失敗：${err instanceof Error ? err.message : String(err)}）`)
      }
    }
    this._paintMtimes()
  }

  /**
   * @param {string} text
   */
  _setMtimeText(text) {
    for (const side of /** @type {const} */ (['left', 'right'])) {
      const grid = this._dom[`fileInfoGrid_${side}`]
      const value = grid?.lastElementChild
      if (value) value.textContent = text
    }
  }

  /** Write the cached mtimes into the already-rendered panel. */
  _paintMtimes() {
    for (const side of /** @type {const} */ (['left', 'right'])) {
      const grid = this._dom[`fileInfoGrid_${side}`]
      const value = grid?.lastElementChild
      const path = side === 'left' ? this._leftPath : this._rightPath
      if (value) value.textContent = path ? (this._mtimeCache.get(path) ?? '—') : '—'
    }
  }

  // ── Private: UI helpers ───────────────────────────────────────────────────────

  /**
   * 更新工具列的大小資訊與截斷警告
   */
  _updateSizeInfo() {
    const { sizeInfo, warning } = this._dom
    if (!sizeInfo) return

    const leftSize  = this._leftBytes  ? this._leftBytes.byteLength  : null
    const rightSize = this._rightBytes ? this._rightBytes.byteLength : null

    const parts = []
    if (leftSize !== null)  parts.push(`左側 ${formatSize(leftSize)}`)
    if (rightSize !== null) parts.push(`右側 ${formatSize(rightSize)}`)
    sizeInfo.textContent = parts.length ? parts.join(' / ') : ''

    // 截斷警告
    const truncated = this._leftTruncated || this._rightTruncated
    if (warning) {
      warning.style.display = truncated ? '' : 'none'
      if (truncated) {
        const sides = []
        if (this._leftTruncated)  sides.push(`左側（前 ${formatSize(MAX_BYTES)} / 共 ${formatSize(this._leftOriginalSize)}）`)
        if (this._rightTruncated) sides.push(`右側（前 ${formatSize(MAX_BYTES)} / 共 ${formatSize(this._rightOriginalSize)}）`)
        warning.textContent = `⚠ ${sides.join('、')}超過 10 MB，已截斷顯示`
      }
    }

    // Sizes, modified counts and diff totals all live in the File Info panel,
    // and every caller of this method has just changed one of them.
    this._updateFileInfoPanel()
    this._updateDetailsPanel()
  }

  /**
   * 更新路徑顯示
   * @param {'left'|'right'} side
   * @param {string} path
   */
  _updatePathDisplay(side, path) {
    const dom = side === 'left' ? this._dom.dispLeft : this._dom.dispRight
    if (dom) dom.textContent = path
  }
}

export { formatSize }
