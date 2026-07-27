/**
 * TableCompare — CSV/TSV 表格比對視圖
 * src/renderer/src/views/table-compare.js
 *
 * 公開 API：
 *   constructor(options)  mount(el)  destroy()
 *   openLeft()  openRight()
 *   setLeft(path, content)  setRight(path, content)
 *   refresh()  on(event, handler)  off(event, handler)
 *   swap()
 *   openFind()  closeFind()  findNext()  findPrev()
 *   nextDifference()  prevDifference()  firstDifference()  lastDifference()
 *   getKeyColumns()  setKeyColumns()  getColumnRules()  setColumnRule()  setColumnRules()
 *   openColumnSettings()  closeColumnSettings()  resizeColumnsToFit()
 *   getColumnMapping()  setColumnMapping()  resetColumnMapping()  suggestColumnMapping()
 *   openColumnMapping()  closeColumnMapping()  applyColumnMappingDraft()
 *   getColumnDisplayName()  setColumnDisplayName()  setColumnDisplayNames()
 *   getShowFilter()  setShowFilter('all'|'diff'|'same'|'none')
 *   recompareFiles()
 *   openSessionSettings()  closeSessionSettings()
 *   getDelimiterOverride()  setDelimiterOverride()
 *   getEncodingOverride()  setEncodingOverride()
 *   getSessionInfo()  setSessionInfo()
 *
 * 事件：
 *   'paths-changed' → { left: string, right: string }
 */

import { isActive } from '../core/active-view.js'
import { renderTextTable, reportHeader, reportSummary } from '../core/report.js'
import { showContextMenu, closeContextMenu } from '../core/context-menu.js'
import { el, formatSize } from '../core/utils.js'
import { tagConfig, readConfig } from '../core/named-config-store.js'
import { stepDiffIndex, navResult, getNavOptions } from '../core/diff-nav.js'
import { toast } from '../core/toast.js'
import '../styles/table-compare.css'

/** @typedef {import('../core/diff-nav.js').NavResult} NavResult */

/** Extra rows rendered above and below the viewport to hide scroll seams. */
const TABLE_OVERSCAN = 10

/** Display font size, in px, matching text compare's range. */
const MIN_TABLE_FONT_SIZE = 10
const MAX_TABLE_FONT_SIZE = 24
const DEFAULT_TABLE_FONT_SIZE = 12

/**
 * @param {unknown} size
 * @returns {number}
 */
function clampTableFontSize(size) {
  const n = Math.round(Number(size))
  if (!Number.isFinite(n)) return DEFAULT_TABLE_FONT_SIZE
  return Math.max(MIN_TABLE_FONT_SIZE, Math.min(MAX_TABLE_FONT_SIZE, n))
}

/**
 * Row height for a given display font size.
 *
 * Virtual scrolling positions rows arithmetically, so this must stay the single
 * source of truth for both the stylesheet variable and the scroll maths — a
 * disagreement of even one pixel accumulates into rows landing off-viewport.
 *
 * @param {number} fontSize
 * @returns {number}
 */
function rowHeightForFont(fontSize) {
  return fontSize + 12
}

/**
 * Whether a path names a file the OS file manager could actually reveal.
 *
 * Archive entries, snapshots and remote objects have no folder to open, and
 * the main process's path validator would refuse the call regardless.
 *
 * @param {string|null|undefined} path
 * @returns {boolean}
 */
function isRealFilePath(path) {
  if (!path) return false
  return !path.includes('::') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)
}

/**
 * Ceiling on the thumbnail's segment count.
 *
 * The thumbnail is an overview of the whole table, so its cost must depend on
 * its own height rather than on the row count — one node per row would make a
 * 100k-row overview more expensive than the table it summarises.
 */
const THUMB_MAX_MARKS = 400

/** Assumed thumbnail height where the environment reports none (jsdom, hidden). */
const THUMB_FALLBACK_HEIGHT = 300

/** Coalesce scroll-driven re-renders onto the next frame. */
function _rafThrottle(fn) {
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => { scheduled = false; fn() })
  }
}

// ── HTML Escape ──────────────────────────────────────────────────────────────

/**
 * 將字串中的 HTML 特殊字元轉義，防止 XSS
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── CSV/TSV Parser ────────────────────────────────────────────────────────────

/**
 * 偵測分隔符：第一行含 Tab 則用 Tab，否則用逗號
 * @param {string} content
 * @returns {'\t'|','}
 */
function detectDelimiter(content) {
  const firstLine = content.split('\n')[0] ?? ''
  return firstLine.includes('\t') ? '\t' : ','
}

/**
 * 解析 CSV/TSV 內容為二維陣列。
 * 支援雙引號欄位（含逗號、換行）。
 *
 * @param {string} content  原始文字內容
 * @param {'\t'|','} [delimiter]  若不傳，自動偵測
 * @returns {string[][]}  每列為一個字串陣列
 */
function parseTable(content, delimiter) {
  const sep = delimiter ?? detectDelimiter(content)
  const rows = []
  let row = []
  let cell = ''
  let inQuote = false
  let i = 0

  while (i < content.length) {
    const ch = content[i]
    const next = content[i + 1]

    if (inQuote) {
      if (ch === '"' && next === '"') {
        // Escaped double-quote
        cell += '"'
        i += 2
        continue
      }
      if (ch === '"') {
        inQuote = false
        i++
        continue
      }
      cell += ch
      i++
      continue
    }

    // Not in quote
    if (ch === '"') {
      inQuote = true
      i++
      continue
    }

    if (ch === sep) {
      row.push(cell)
      cell = ''
      i++
      continue
    }

    if (ch === '\r' && next === '\n') {
      row.push(cell)
      cell = ''
      rows.push(row)
      row = []
      i += 2
      continue
    }

    if (ch === '\n') {
      row.push(cell)
      cell = ''
      rows.push(row)
      row = []
      i++
      continue
    }

    cell += ch
    i++
  }

  // Flush last cell/row
  row.push(cell)
  // Only add last row if it contains content (skip trailing empty line)
  if (row.some((c) => c !== '')) {
    rows.push(row)
  }

  return rows
}

// ── S16: Column handling (numeric / date tolerance, ignored columns) ──────────

/**
 * @typedef {'text'|'numeric'|'date'|'ignore'} ColumnMode
 * @typedef {{ mode: ColumnMode, tolerance: number }} ColumnRule
 * @typedef {Record<number, ColumnRule>|Array<ColumnRule|null|undefined>|null|undefined} ColumnRuleSet
 */

/** @type {ColumnRule} */
const DEFAULT_COLUMN_RULE = Object.freeze({ mode: 'text', tolerance: 0 })

/** @type {ReadonlySet<string>} */
const COLUMN_MODES = new Set(['text', 'numeric', 'date', 'ignore'])

/**
 * 取得某欄的比對規則；未設定或設定無效時回傳預設的字串比對。
 *
 * @param {ColumnRuleSet} rules
 * @param {number} index
 * @returns {ColumnRule}
 */
function columnRuleAt(rules, index) {
  const raw = rules ? rules[index] : null
  if (!raw || !COLUMN_MODES.has(raw.mode)) return DEFAULT_COLUMN_RULE
  const tolerance = Number(raw.tolerance)
  return { mode: raw.mode, tolerance: Number.isFinite(tolerance) ? Math.abs(tolerance) : 0 }
}

/**
 * Make whitespace inside a cell visible: space → `·`, tab → `→`.
 *
 * Deliberately a local copy of text-compare's helper rather than an import:
 * pulling that module in would drag the whole text view (and its lazy syntax
 * highlighter) into this view's bundle for two `replace` calls.
 *
 * @param {string} str
 * @returns {string}
 */
function visibleWhitespace(str) {
  // Tabs first: replacing spaces first would then hit the arrow glyph's own
  // surroundings on some inputs.
  return String(str ?? '').replace(/\t/g, '→').replace(/ /g, '·')
}

/**
 * Fold "excluded" columns into a rule set as `ignore`.
 *
 * Excluding a column is a display decision *and* a comparison decision, and
 * the comparison half is already expressible as an ignore rule — so rather
 * than teaching `cellsEqual` about a second concept, the exclusion set is
 * projected onto the rules the compare pass already consumes.
 *
 * @param {ColumnRuleSet} rules
 * @param {Iterable<number>|null|undefined} excluded
 * @returns {Record<number, ColumnRule>}
 */
function mergeIgnoredColumns(rules, excluded) {
  /** @type {Record<number, ColumnRule>} */
  const out = {}
  if (rules) {
    for (const key of Object.keys(rules)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0) continue
      out[index] = columnRuleAt(rules, index)
    }
  }
  for (const raw of excluded ?? []) {
    const index = Number(raw)
    if (!Number.isInteger(index) || index < 0) continue
    out[index] = { mode: 'ignore', tolerance: 0 }
  }
  return out
}

/**
 * Human-readable name for a delimiter character.
 * @param {string} d
 * @returns {string}
 */
function describeDelimiter(d) {
  if (d === '	') return 'Tab'
  if (d === ',') return '逗號 (,)'
  if (d === ';') return '分號 (;)'
  if (d === '|') return '直線 (|)'
  return d ? `「${d}」` : '（未知）'
}

/**
 * Delimiters offered by Session Settings ▸ Type.
 *
 * `char: null` marks the two entries that are not themselves a delimiter:
 * "auto" defers to detection, "custom" defers to the adjacent text box.
 *
 * @type {ReadonlyArray<{ value: string, label: string, char: string|null }>}
 */
const DELIMITER_PRESETS = Object.freeze([
  { value: 'auto', label: '自動偵測', char: null },
  { value: ',', label: '逗號 (,)', char: ',' },
  { value: '\t', label: 'Tab', char: '\t' },
  { value: ';', label: '分號 (;)', char: ';' },
  { value: '|', label: '直線 (|)', char: '|' },
  { value: 'custom', label: '自訂字元…', char: null },
])

/**
 * Encodings offered by Session Settings ▸ Conversion.
 *
 * Mirrors `src/main/encoding.js`'s COMMON_ENCODINGS. It is duplicated rather
 * than imported because that module is main-process only (it pulls in
 * `iconv-lite` through `createRequire`), and the renderer must not load it.
 *
 * @type {ReadonlyArray<string>}
 */
const TABLE_ENCODINGS = Object.freeze([
  'UTF-8', 'UTF-8-BOM', 'UTF-16LE', 'UTF-16LE-BOM', 'UTF-16BE', 'UTF-16BE-BOM',
  'Big5', 'GBK', 'GB18030',
  'Shift_JIS', 'EUC-JP', 'EUC-KR',
  'windows-1252', 'ISO-8859-1',
])

/**
 * Normalise a user-supplied column list to unique, ascending, valid indices.
 *
 * @param {unknown} raw
 * @returns {number[]}
 */
function toColumnList(raw) {
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw])
  /** @type {number[]} */
  const out = []
  for (const v of list) {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || out.includes(n)) continue
    out.push(n)
  }
  return out.sort((a, b) => a - b)
}

/** Reject anything that `Number()` would coerce loosely (''、'0x10'、'  12abc'). */
const NUMERIC_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * 將儲存格文字解析為數字；無法解析時回傳 null（呼叫端須退回字串比對）。
 *
 * @param {string|null|undefined} raw
 * @returns {number|null}
 */
function parseNumericValue(raw) {
  if (raw == null) return null
  // Thousands separators are presentation, not value.
  const s = String(raw).trim().replace(/,/g, '')
  if (!NUMERIC_RE.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * 將儲存格文字解析為 epoch 毫秒；無法解析時回傳 null。
 *
 * 支援 `YYYY-MM-DD`、`YYYY/MM/DD`、`MM/DD/YYYY`、`MM-DD-YYYY`，
 * 後面可再接 `HH:MM` 或 `HH:MM:SS`（以 `T` 或空白分隔）。
 *
 * @param {string|null|undefined} raw
 * @returns {number|null}
 */
function parseDateValue(raw) {
  if (raw == null) return null
  const s = String(raw).trim().replace(/Z$/i, '').trim()
  if (s === '') return null

  const parts = s.split(/[T\s]+/)
  if (parts.length > 2) return null
  const [datePart, timePart] = parts

  let year, month, day
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(datePart)
  if (m) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3])
  } else {
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(datePart)
    if (!m) return null
    month = Number(m[1]); day = Number(m[2]); year = Number(m[3])
  }

  let hh = 0, mm = 0, ss = 0
  if (timePart) {
    const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timePart)
    if (!tm) return null
    hh = Number(tm[1]); mm = Number(tm[2]); ss = tm[3] ? Number(tm[3]) : 0
    if (hh > 23 || mm > 59 || ss > 59) return null
  }

  // UTC keeps results independent of the machine's timezone and of DST.
  const ms = Date.UTC(year, month - 1, day, hh, mm, ss)
  const dt = new Date(ms)
  // Date.UTC silently rolls overflow over (2024-02-31 → 2024-03-02); a bogus
  // date must fail parsing rather than compare equal to a real one.
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null
  }
  return ms
}

/**
 * 依欄位規則判定兩個儲存格是否視為相同。
 *
 * @param {string|null|undefined} left
 * @param {string|null|undefined} right
 * @param {ColumnRule} [rule]
 * @returns {boolean}
 */
function cellsEqual(left, right, rule = DEFAULT_COLUMN_RULE) {
  const a = left ?? ''
  const b = right ?? ''
  if (rule.mode === 'ignore') return true

  if (rule.mode === 'numeric') {
    const na = parseNumericValue(a)
    const nb = parseNumericValue(b)
    // A wide tolerance must never mask unparseable text as "equal"; anything
    // the parser rejects is compared literally instead.
    if (na != null && nb != null) {
      // `100.01 - 100.00` lands at 1.0000000000005e-2 in binary floating point,
      // so an exactly-at-tolerance pair needs a magnitude-scaled slack or the
      // user's "tolerance 0.01" would not actually cover a 0.01 difference.
      const slack = Number.EPSILON * 8 * Math.max(1, Math.abs(na), Math.abs(nb))
      return Math.abs(na - nb) <= rule.tolerance + slack
    }
    return a === b
  }

  if (rule.mode === 'date') {
    const da = parseDateValue(a)
    const db = parseDateValue(b)
    // Tolerance is expressed in seconds; epochs are milliseconds.
    if (da != null && db != null) return Math.abs(da - db) <= rule.tolerance * 1000
    return a === b
  }

  return a === b
}

/**
 * 將 key 欄設定正規化為索引陣列。空陣列代表「按位置對齊」。
 *
 * 接受單一數字（向後相容既有的 `keyColumn: 0` / `-1`）或數字陣列。
 *
 * @param {number|number[]|null|undefined} keyColumn
 * @returns {number[]}
 */
function normaliseKeyColumns(keyColumn) {
  const raw = Array.isArray(keyColumn) ? keyColumn : [keyColumn]
  /** @type {number[]} */
  const out = []
  for (const v of raw) {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
    if (!Number.isInteger(n) || n < 0) continue
    if (!out.includes(n)) out.push(n)
  }
  return out
}

/** Unit separator — cannot appear in parsed CSV cells, so keys stay unambiguous. */
const KEY_SEPARATOR = '\u001F'

/**
 * @param {string} value
 * @param {ColumnRule} rule
 * @returns {string}
 */
function canonicalKeyPart(value, rule) {
  if (rule.mode === 'numeric') {
    const n = parseNumericValue(value)
    // `100` / `100.0` / `100.00` must land in the same bucket, otherwise the
    // two rows never meet and both look like orphans.
    if (n != null) return `n:${n}`
  } else if (rule.mode === 'date') {
    const d = parseDateValue(value)
    if (d != null) return `d:${d}`
  }
  return value
}

/**
 * 由一或多個 key 欄組出對齊用的複合鍵。
 *
 * @param {string[]|null|undefined} row
 * @param {number[]} keyCols
 * @param {ColumnRuleSet} [rules]
 * @returns {string}
 */
function buildRowKey(row, keyCols, rules) {
  return keyCols
    .map((c) => canonicalKeyPart(row?.[c] ?? '', columnRuleAt(rules, c)))
    .join(KEY_SEPARATOR)
}

/** Wide (CJK/fullwidth) glyphs occupy roughly two Latin cells. */
const WIDE_CHAR_RE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/

/**
 * @param {string|null|undefined} text
 * @returns {number}
 */
function displayWidth(text) {
  let n = 0
  for (const ch of String(text ?? '')) n += WIDE_CHAR_RE.test(ch) ? 2 : 1
  return n
}

/**
 * 依取樣內容估算每欄合適的像素寬度（Resize Columns to Fit）。
 *
 * 只吃傳入的取樣列，呼叫端負責限制取樣範圍，避免掃描整張表。
 *
 * @param {Array<string[]|null|undefined>} sampleRows
 * @param {number} colCount
 * @param {string[]|null} [headers]
 * @param {{ charWidth?: number, padding?: number, min?: number, max?: number }} [opts]
 * @returns {number[]} 像素寬度
 */
function measureColumnWidths(sampleRows, colCount, headers = null, opts = {}) {
  const charWidth = opts.charWidth ?? 7
  const padding = opts.padding ?? 18
  const min = opts.min ?? 40
  const max = opts.max ?? 480

  /** @type {number[]} */
  const widths = []
  for (let c = 0; c < colCount; c++) {
    let widest = headers ? displayWidth(headers[c]) : 0
    for (const row of sampleRows) {
      if (!row) continue
      const w = displayWidth(row[c])
      if (w > widest) widest = w
    }
    widths.push(Math.min(max, Math.max(min, Math.round(widest * charWidth + padding))))
  }
  return widths
}

// ── Comparison Logic ──────────────────────────────────────────────────────────

/**
 * 重新排序 row 的欄位，使欄位順序與 targetHeaders 一致。
 * 若 targetHeaders 中有 row 沒有的欄位，補空字串。
 *
 * @param {string[]} row
 * @param {string[]} sourceHeaders
 * @param {string[]} targetHeaders
 * @returns {string[]}
 */
function reorderRow(row, sourceHeaders, targetHeaders) {
  const map = new Map(sourceHeaders.map((h, i) => [h, i]))
  return targetHeaders.map((h) => {
    const idx = map.get(h)
    return idx != null ? (row[idx] ?? '') : ''
  })
}

// ── S27: arbitrary N:M column mapping ────────────────────────────────────────

/**
 * One displayed column and the source column it reads from on each side.
 * @typedef {{ left: number, right: number }} ColumnPair
 */

/** "This side has no column here." Kept out of band from a real index. */
const NO_COLUMN = -1

/**
 * One side of a pair read as a column index.
 *
 * `Number()` alone is not enough: null, undefined, '' and false all coerce to
 * 0, and 0 is a perfectly valid column — so the natural JSON spelling of
 * "unmapped" would silently pair a display column with source column 0.
 * Only a real number, or a string that is entirely a number, names a column.
 *
 * @param {unknown} value
 * @returns {number} NO_COLUMN 代表這一側沒有對應欄
 */
function columnIndexOf(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : NO_COLUMN
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isInteger(n) && n >= 0 ? n : NO_COLUMN
  }
  return NO_COLUMN
}

/**
 * Normalise a user- or config-supplied mapping.
 *
 * A pair with neither side describes nothing at all; keeping it would add a
 * permanently blank column that no later edit could give meaning to.
 *
 * @param {unknown} raw
 * @returns {ColumnPair[]|null} null 代表沿用「顯示欄＝來源欄」的預設對應
 */
function normaliseColumnMapping(raw) {
  if (!Array.isArray(raw)) return null
  /** @type {ColumnPair[]} */
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const left = columnIndexOf(/** @type {{ left?: unknown }} */ (item).left)
    const right = columnIndexOf(/** @type {{ right?: unknown }} */ (item).right)
    if (left === NO_COLUMN && right === NO_COLUMN) continue
    out.push({ left, right })
  }
  return out.length ? out : null
}

/**
 * The plain positional mapping, with the narrower side left unmapped past its
 * own width rather than padded with columns it does not have.
 *
 * @param {number} leftCount
 * @param {number} rightCount
 * @returns {ColumnPair[]}
 */
function identityColumnMapping(leftCount, rightCount) {
  /** @type {ColumnPair[]} */
  const out = []
  const n = Math.max(leftCount, rightCount)
  for (let i = 0; i < n; i++) {
    out.push({
      left: i < leftCount ? i : NO_COLUMN,
      right: i < rightCount ? i : NO_COLUMN,
    })
  }
  return out
}

/**
 * Header text reduced to the form a name match should compare.
 * @param {unknown} name
 * @returns {string}
 */
function headerMatchKey(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[\s_\-.]+/g, '')
}

/**
 * Propose a mapping from the two header rows: exact name matches first, then
 * containment, and finally whatever is left over as a one-sided column.
 *
 * Leftovers deliberately become one-sided columns rather than being dropped —
 * a column that quietly disappears reads as "the files agree here".
 *
 * @param {string[]|null|undefined} leftHeaders
 * @param {string[]|null|undefined} rightHeaders
 * @param {number} [leftCount]  欄數（資料列可能比標題列寬）
 * @param {number} [rightCount]
 * @returns {ColumnPair[]}
 */
function suggestColumnMapping(leftHeaders, rightHeaders, leftCount = 0, rightCount = 0) {
  const lCount = Math.max(leftCount, leftHeaders?.length ?? 0)
  const rCount = Math.max(rightCount, rightHeaders?.length ?? 0)
  if (!leftHeaders || !rightHeaders) return identityColumnMapping(lCount, rCount)

  /** @type {string[]} */
  const lKeys = []
  /** @type {string[]} */
  const rKeys = []
  for (let i = 0; i < lCount; i++) lKeys.push(headerMatchKey(leftHeaders[i]))
  for (let j = 0; j < rCount; j++) rKeys.push(headerMatchKey(rightHeaders[j]))

  /** @type {Set<number>} */
  const takenRight = new Set()
  /** @type {number[]} */
  const partner = new Array(lCount).fill(NO_COLUMN)

  const claim = (/** @type {(key: string, idx: number) => boolean} */ pred) => {
    for (let i = 0; i < lCount; i++) {
      if (partner[i] !== NO_COLUMN || lKeys[i] === '') continue
      for (let j = 0; j < rCount; j++) {
        if (takenRight.has(j) || rKeys[j] === '') continue
        if (!pred(rKeys[j], i)) continue
        partner[i] = j
        takenRight.add(j)
        break
      }
    }
  }
  claim((key, i) => key === lKeys[i])
  claim((key, i) => key.includes(lKeys[i]) || lKeys[i].includes(key))

  /** @type {ColumnPair[]} */
  const out = []
  for (let i = 0; i < lCount; i++) out.push({ left: i, right: partner[i] })
  for (let j = 0; j < rCount; j++) {
    if (!takenRight.has(j)) out.push({ left: NO_COLUMN, right: j })
  }
  return out
}

/**
 * Read one source row through a column map, producing display-space cells.
 *
 * @param {string[]|null|undefined} row
 * @param {number[]} colMap  顯示欄 → 來源欄，-1 代表該側沒有這一欄
 * @returns {string[]}
 */
function projectRow(row, colMap) {
  const out = new Array(colMap.length)
  for (let i = 0; i < colMap.length; i++) {
    const src = colMap[i]
    out[i] = src >= 0 ? (row?.[src] ?? '') : ''
  }
  return out
}

/**
 * Split a mapping into the two per-side lookup arrays the view indexes by
 * display column.
 *
 * @param {ColumnPair[]} mapping
 * @returns {{ left: number[], right: number[] }}
 */
function columnMapSides(mapping) {
  return {
    left: mapping.map((p) => p.left),
    right: mapping.map((p) => p.right),
  }
}

/**
 * Sort rows by the very key the alignment pass will use.
 *
 * Decorated rather than compared in place: a hundred-thousand-row sort would
 * otherwise rebuild each key O(log n) times, and each key build projects a row.
 *
 * @param {string[][]} data
 * @param {number[]|null} colMap
 * @param {number[]} sortCols  display column indices
 * @param {ColumnRuleSet} rules
 * @returns {string[][]}
 */
function sortByDisplayKey(data, colMap, sortCols, rules) {
  const decorated = data.map((row, i) => ({
    row,
    i,
    key: buildRowKey(colMap ? projectRow(row, colMap) : row, sortCols, rules),
  }))
  // The index tie-break keeps equal keys in file order; Array#sort is only
  // guaranteed stable for the comparator's own verdicts, not for ties we ignore.
  decorated.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i))
  return decorated.map((d) => d.row)
}

/**
 * @typedef {{ status: 'same'|'different'|'left-only'|'right-only', leftRow: string[]|null, rightRow: string[]|null, leftIdx: number, rightIdx: number }} AlignedRow
 */

/**
 * 依 keyColumn 將左右兩側的資料列對齊，產生 AlignedRow[]。
 *
 * @param {string[][]} leftData   左側資料（不含標題行，若 hasHeader=true）
 * @param {string[][]} rightData  右側資料
 * @param {number|number[]} keyCol  key 欄索引；單一數字（-1 代表按位置對齊）或多欄組合鍵
 * @param {string[]|null} leftHeaders   左側標題行（ignoreColumnOrder 用）
 * @param {string[]|null} rightHeaders  右側標題行
 * @param {boolean} ignoreColumnOrder
 * @param {ColumnRuleSet} [columnRules]  每欄比對規則（numeric/date/ignore）
 * @returns {AlignedRow[]}
 */
function alignRows(leftData, rightData, keyCol, leftHeaders, rightHeaders, ignoreColumnOrder, columnRules) {
  // 若需要忽略欄位排序，先將右側資料欄位重排成左側順序
  let normalizedRight = rightData
  let normalizedRightHeaders = rightHeaders
  if (ignoreColumnOrder && leftHeaders && rightHeaders) {
    normalizedRight = rightData.map((row) => reorderRow(row, rightHeaders, leftHeaders))
    normalizedRightHeaders = leftHeaders
  }

  const keyCols = normaliseKeyColumns(keyCol)

  if (keyCols.length === 0) {
    // 按位置對齊
    const len = Math.max(leftData.length, normalizedRight.length)
    const result = []
    for (let i = 0; i < len; i++) {
      const lRow = leftData[i] ?? null
      const rRow = normalizedRight[i] ?? null
      result.push({
        status: computeRowStatus(lRow, rRow, columnRules),
        leftRow: lRow,
        rightRow: rRow,
        leftIdx: i,
        rightIdx: i,
      })
    }
    return result
  }

  // 按 key 欄位對齊
  const leftMap = new Map()
  for (let i = 0; i < leftData.length; i++) {
    const key = buildRowKey(leftData[i], keyCols, columnRules)
    if (!leftMap.has(key)) leftMap.set(key, [])
    leftMap.get(key).push({ row: leftData[i], idx: i })
  }

  const rightMap = new Map()
  for (let i = 0; i < normalizedRight.length; i++) {
    const key = buildRowKey(normalizedRight[i], keyCols, columnRules)
    if (!rightMap.has(key)) rightMap.set(key, [])
    rightMap.get(key).push({ row: normalizedRight[i], idx: i })
  }

  // Merge keys in order: left-order first, then right-only keys
  const allKeys = []
  const seen = new Set()
  for (const key of leftMap.keys()) {
    if (!seen.has(key)) { seen.add(key); allKeys.push(key) }
  }
  for (const key of rightMap.keys()) {
    if (!seen.has(key)) { seen.add(key); allKeys.push(key) }
  }

  const result = []
  for (const key of allKeys) {
    const leftGroup = leftMap.get(key) ?? []
    const rightGroup = rightMap.get(key) ?? []
    const len = Math.max(leftGroup.length, rightGroup.length)
    for (let i = 0; i < len; i++) {
      const lEntry = leftGroup[i] ?? null
      const rEntry = rightGroup[i] ?? null
      result.push({
        status: computeRowStatus(lEntry?.row ?? null, rEntry?.row ?? null, columnRules),
        leftRow: lEntry?.row ?? null,
        rightRow: rEntry?.row ?? null,
        leftIdx: lEntry?.idx ?? -1,
        rightIdx: rEntry?.idx ?? -1,
      })
    }
  }
  return result
}

/**
 * 計算單列的比對狀態
 * @param {string[]|null} left
 * @param {string[]|null} right
 * @param {ColumnRuleSet} [columnRules]
 * @returns {'same'|'different'|'left-only'|'right-only'}
 */
function computeRowStatus(left, right, columnRules) {
  if (!right) return 'left-only'
  if (!left) return 'right-only'
  const maxLen = Math.max(left.length, right.length)
  for (let i = 0; i < maxLen; i++) {
    if (!cellsEqual(left[i], right[i], columnRuleAt(columnRules, i))) return 'different'
  }
  return 'same'
}

/**
 * 計算每一欄是否有差異（用於 cell-diff 標記）
 * @param {string[]|null} leftRow
 * @param {string[]|null} rightRow
 * @param {number} colCount
 * @param {ColumnRuleSet} [columnRules]
 * @returns {boolean[]}
 */
function computeCellDiffs(leftRow, rightRow, colCount, columnRules) {
  const diffs = []
  for (let i = 0; i < colCount; i++) {
    diffs.push(!cellsEqual(leftRow?.[i], rightRow?.[i], columnRuleAt(columnRules, i)))
  }
  return diffs
}

// ── S16: Navigation & search primitives ───────────────────────────────────────

/**
 * @typedef {{ rowIndex: number, side: 'left'|'right', col: number }} CellMatch
 */

/**
 * 掃描對齊列的所有儲存格，回傳符合 query 的位置。
 *
 * Matches are ordered row-major, left pane before right pane, so that
 * "next match" walks the table the way the user reads it.
 *
 * @param {AlignedRow[]} rows
 * @param {string} query
 * @param {boolean} [caseSensitive]
 * @returns {CellMatch[]}
 */
function findCellMatches(rows, query, caseSensitive = false) {
  if (!query) return []
  const needle = caseSensitive ? query : query.toLowerCase()
  /** @type {CellMatch[]} */
  const matches = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    for (const side of /** @type {const} */ (['left', 'right'])) {
      const cells = side === 'left' ? row.leftRow : row.rightRow
      if (!cells) continue
      for (let col = 0; col < cells.length; col++) {
        const raw = cells[col] ?? ''
        const hay = caseSensitive ? raw : raw.toLowerCase()
        if (hay.includes(needle)) matches.push({ rowIndex, side, col })
      }
    }
  }
  return matches
}

/**
 * 取得所有非 'same' 對齊列的索引（列級差異導航用）。
 *
 * @param {AlignedRow[]} rows
 * @returns {number[]}
 */
function diffRowIndices(rows) {
  const out = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].status !== 'same') out.push(i)
  }
  return out
}

/**
 * 差異導航用的位移：到頭到尾即停，與 text-compare.js 的
 * navigateNext/navigatePrev 相同（不環繞）。
 *
 * @param {number} current
 * @param {number} total
 * @param {number} delta
 * @returns {number} -1 when there is nothing to navigate
 */
function stepIndexClamped(current, total, delta) {
  if (total <= 0) return -1
  return Math.min(Math.max(current + delta, 0), total - 1)
}

/**
 * 搜尋導航用的位移：環繞，與 text-compare.js 的 find 導航相同。
 *
 * @param {number} current
 * @param {number} total
 * @param {number} delta
 * @returns {number} -1 when there is nothing to navigate
 */
function stepIndexWrapped(current, total, delta) {
  if (total <= 0) return -1
  return ((current + delta) % total + total) % total
}

// ── P2-45: difference magnitude grading ──────────────────────────────────────

/**
 * 兩個儲存格的「差異程度」，0 = 相同，1 = 完全不同。
 *
 * 不用編輯距離：那是 O(n·m)，而這個值要對整個視窗內的每一格算一次。共同前綴
 * 與共同後綴的裁剪是 O(n) 且單調——改一個字元恆得到小值，整格換掉恆得到 1。
 *
 * 數字欄另外處理：`1000` 與 `1001` 只差一個字元，但字串量測會說它們差 25%，
 * 而實際的量值差距是 0.1%。分級是給人看差多少，不是差幾個字元。
 *
 * @param {string|null|undefined} left
 * @param {string|null|undefined} right
 * @returns {number} 0..1
 */
function cellDiffRatio(left, right) {
  const a = String(left ?? '')
  const b = String(right ?? '')
  if (a === b) return 0

  const na = parseNumericValue(a)
  const nb = parseNumericValue(b)
  if (na != null && nb != null) {
    const scale = Math.max(Math.abs(na), Math.abs(nb))
    // 0 → 非 0 沒有可用的相對尺度，只能算完全不同。
    if (scale === 0) return 1
    return Math.min(1, Math.abs(na - nb) / scale)
  }

  const max = Math.max(a.length, b.length)
  if (max === 0) return 0
  const min = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < min && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < min - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  return Math.min(1, (max - prefix - suffix) / max)
}

/** 分級門檻。落在「差異」這個語意內，只改深淺，不改色相。 */
const SEVERITY_THRESHOLDS = Object.freeze([0.25, 0.6])

/**
 * 把差異程度換成 0（相同）/ 1（輕微）/ 2（中等）/ 3（大量）。
 *
 * @param {number} ratio
 * @returns {0|1|2|3}
 */
function severityLevel(ratio) {
  if (!(ratio > 0)) return 0
  if (ratio <= SEVERITY_THRESHOLDS[0]) return 1
  if (ratio <= SEVERITY_THRESHOLDS[1]) return 2
  return 3
}

/**
 * 逐欄的差異等級。已判定相同的欄（含 ignore 規則）一律 0，因為分級只是把
 * 既有的「不同」再細分，不能讓一個被規則判為相同的欄變成有顏色。
 *
 * @param {string[]|null} leftRow
 * @param {string[]|null} rightRow
 * @param {boolean[]} cellDiffs  computeCellDiffs 的結果
 * @returns {number[]}
 */
function computeCellLevels(leftRow, rightRow, cellDiffs) {
  /** @type {number[]} */
  const out = []
  for (let i = 0; i < cellDiffs.length; i++) {
    out.push(cellDiffs[i] ? severityLevel(cellDiffRatio(leftRow?.[i], rightRow?.[i])) : 0)
  }
  return out
}

// ── P2-46: thumbnail (whole-table difference overview) ───────────────────────

/**
 * @typedef {{ status: 'same'|'different'|'left-only'|'right-only',
 *             start: number, end: number }} ThumbBucket
 */

/**
 * 把整張表壓成固定數量的區段，供縮圖繪製。
 *
 * 一個像素高的區段可能涵蓋數百列，取「數量最多的非相同狀態」而不是取多數：
 * 十萬列裡的三列差異若被多數決吃掉，縮圖就失去存在的理由。
 *
 * @param {Array<{ status: string }>} rows
 * @param {number} bucketCount
 * @returns {ThumbBucket[]}
 */
function thumbnailBuckets(rows, bucketCount) {
  const total = rows?.length ?? 0
  const n = Math.min(Math.floor(bucketCount), total)
  if (total === 0 || n <= 0) return []

  /** @type {ThumbBucket[]} */
  const out = []
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * total) / n)
    const end = Math.max(start + 1, Math.floor(((i + 1) * total) / n))
    /** @type {Record<string, number>} */
    const counts = { different: 0, 'left-only': 0, 'right-only': 0 }
    for (let r = start; r < end && r < total; r++) {
      const st = rows[r]?.status
      if (st && st !== 'same') counts[st] = (counts[st] ?? 0) + 1
    }
    /** @type {ThumbBucket['status']} */
    let status = 'same'
    let best = 0
    for (const st of /** @type {Array<ThumbBucket['status']>} */ (['different', 'left-only', 'right-only'])) {
      if (counts[st] > best) { best = counts[st]; status = st }
    }
    out.push({ status, start, end })
  }
  return out
}

// ── P2-43: Go To ─────────────────────────────────────────────────────────────

/**
 * 解析「跳至」輸入。接受 `12`、`12,3`、`12:3`（列, 欄），空白忽略。
 *
 * @param {string|null|undefined} text
 * @returns {{ row: number, col: number|null }|null} null 代表格式不合法
 */
function parseGotoInput(text) {
  const s = String(text ?? '').trim()
  if (s === '') return null
  const m = /^(\d+)\s*(?:[,:]\s*(\d+))?$/.exec(s)
  if (!m) return null
  const row = Number(m[1])
  if (!Number.isInteger(row) || row < 1) return null
  const col = m[2] == null ? null : Number(m[2])
  if (col != null && (!Number.isInteger(col) || col < 0)) return null
  return { row, col }
}

// ── P2-21 / P2-33: serialisation and alternative table sources ───────────────

/**
 * 將二維陣列序列化回 CSV/TSV 文字（存檔與「重新解析」共用同一條路徑）。
 *
 * @param {string[][]} rows
 * @param {string} [delimiter]
 * @returns {string}
 */
function serializeTable(rows, delimiter = ',') {
  return rows
    .map((row) => (row ?? [])
      .map((cell) => {
        const v = String(cell ?? '')
        return (v.includes(delimiter) || v.includes('"') || v.includes('\n') || v.includes('\r'))
          ? `"${v.replace(/"/g, '""')}"`
          : v
      })
      .join(delimiter))
    .join('\n')
}

/**
 * 擷取 HTML 內的每個 `<table>`，各自轉為二維陣列。
 *
 * `colspan` 以重複同一個值展開，讓左右兩側的欄位索引仍然對得起來；`rowspan`
 * 不展開，因為攤平後的列數必須等於原始 `<tr>` 數，否則列號會與來源對不上。
 *
 * @param {string} html
 * @returns {Array<{ name: string, rows: string[][] }>}
 */
function parseHtmlTables(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html')
  /** @type {Array<{ name: string, rows: string[][] }>} */
  const out = []
  const tables = [...doc.querySelectorAll('table')]
  for (let t = 0; t < tables.length; t++) {
    const table = tables[t]
    /** @type {string[][]} */
    const rows = []
    // A nested table's rows belong to the nested table, not to this one.
    for (const tr of table.querySelectorAll('tr')) {
      if (tr.closest('table') !== table) continue
      /** @type {string[]} */
      const cells = []
      for (const cell of tr.querySelectorAll('th,td')) {
        if (cell.closest('tr') !== tr) continue
        const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim()
        const span = Math.max(1, parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1)
        for (let i = 0; i < span; i++) cells.push(text)
      }
      if (cells.length) rows.push(cells)
    }
    const caption = table.querySelector('caption')?.textContent?.trim()
    out.push({ name: caption || `表格 ${t + 1}`, rows })
  }
  return out
}

/**
 * 換成 `.csv` 副檔名，並去掉顯示用的 `[工作表]` 後綴。
 * @param {string} path
 * @returns {string}
 */
/**
 * 由「列物件」反查它在已解析陣列中的索引。
 * @param {string[][]|null} parsed
 * @returns {Map<string[], number>}
 */
function _buildRowIndexMap(parsed) {
  /** @type {Map<string[], number>} */
  const map = new Map()
  if (!parsed) return map
  for (let i = 0; i < parsed.length; i++) map.set(parsed[i], i)
  return map
}

function csvPathFor(path) {
  const base = String(path ?? '').replace(/\s*\[[^\]]*\]\s*$/, '')
  if (!base) return 'table.csv'
  return base.replace(/\.[^./\\]*$/, '') + '.csv'
}

/**
 * Ceiling on the cell-edit history, in entries.
 *
 * Each entry keeps two cell strings, so an unbounded stack would grow with the
 * session rather than with the document — the oldest edits are dropped instead.
 */
export const MAX_EDIT_HISTORY = 200

/**
 * Ceiling for a dropped delimited-text file, in characters.
 *
 * Parsing allocates several arrays per row, so a file large enough to be worth
 * refusing has to be refused before it is parsed rather than after.
 */
export const MAX_TABLE_CHARS = 20_000_000

// ── TableCompare Class ────────────────────────────────────────────────────────

export class TableCompare {
  /**
   * @param {object} [options]
   * @param {boolean} [options.hasHeader]          第一行是否為標題行（預設 true）
   * @param {number|number[]} [options.keyColumn]  對齊用的 key 欄索引；單一數字（-1 表示按位置，
   *                                               預設 0）或多欄組合鍵（如 `[0, 2]`）
   * @param {boolean} [options.ignoreColumnOrder]  忽略欄位排序差異（預設 false）
   * @param {ColumnRuleSet} [options.columnRules]  每欄比對規則（text/numeric/date/ignore）
   */
  constructor(options = {}) {
    this._hasHeader = options.hasHeader ?? true
    /** @type {number[]} 空陣列代表按位置對齊 */
    this._keyColumns = normaliseKeyColumns(options.keyColumn ?? 0)
    this._ignoreColumnOrder = options.ignoreColumnOrder ?? false

    /** @type {Record<number, ColumnRule>} 只存非預設規則，預設 text 一律不落地 */
    this._columnRules = {}
    this._applyColumnRuleSet(options.columnRules)

    /** @type {{ left: number[]|null, right: number[]|null }} Resize-to-fit 結果 */
    this._colWidths = { left: null, right: null }

    /** @type {string|null} */
    this._leftPath = null
    /** @type {string|null} */
    this._rightPath = null
    /** @type {string|null} */
    this._leftContent = null
    /** @type {string|null} */
    this._rightContent = null

    /** @type {string[][]|null} 解析後的左側所有行（含標題） */
    this._leftParsed = null
    /** @type {string[][]|null} */
    this._rightParsed = null

    /** @type {AlignedRow[]} */
    this._alignedRows = []

    // ── P2-21: cell editing ───────────────────────────────────────────────────
    /** @type {{ left: boolean, right: boolean }} 未儲存的編輯 */
    this._modified = { left: false, right: false }

    /** @type {{ left: string, right: string }} 解析時偵測到的分隔符，存檔時沿用 */
    this._delimiter = { left: ',', right: ',' }

    /**
     * 由已解析的列物件反查它在 `_leftParsed` / `_rightParsed` 的索引。
     *
     * 編輯必須寫回「解析後的模型」而不是 DOM——這個視圖是虛擬捲動的，寫進
     * DOM 的值捲出畫面就沒了。用物件識別做索引，是因為排序與 key 對齊都會
     * 改變列的順序，只有列物件本身在整個比對流程中是同一個。
     *
     * @type {{ left: Map<string[], number>, right: Map<string[], number> }}
     */
    this._rowIndexMap = { left: new Map(), right: new Map() }

    /**
     * @typedef {{ kind?: 'cell', side: 'left'|'right', rowIdx: number, col: number,
     *             before: string, after: string, rowRef?: string[]|null }} CellEdit
     * @typedef {{ kind: 'row', op: 'replace'|'insert', side: 'left'|'right', rowIdx: number,
     *             before: string[]|null, after: string[]|null, rowRef: string[] }} RowEdit
     * @typedef {{ kind: 'batch', side: 'left'|'right', edits: CellEdit[] }} BatchEdit
     * @typedef {CellEdit|RowEdit|BatchEdit} EditEntry
     */
    /** @type {EditEntry[]} */
    this._undoStack = []
    /** @type {EditEntry[]} */
    this._redoStack = []

    /** @type {{ side: 'left'|'right', visibleRowIdx: number, col: number,
     *            td: HTMLElement, input: HTMLInputElement, original: string }|null} */
    this._editing = null

    // ── P2-33: multi-sheet / multi-table sources ──────────────────────────────
    /**
     * @typedef {{ path: string, kind: 'excel'|'html',
     *             parts: Array<{ name: string, text: string }>, active: string|null }} TableSource
     * @type {{ left: TableSource|null, right: TableSource|null }}
     */
    this._sources = { left: null, right: null }

    /** @type {{ left: 'text'|'excel'|'html', right: 'text'|'excel'|'html' }} */
    this._sourceKind = { left: 'text', right: 'text' }

    /** @type {AlignedRow[]} 通過顯示篩選的列；虛擬捲動與導航都以此為座標系 */
    this._visibleRows = []

    // S16-T1: find state
    /** @type {CellMatch[]} */
    this._findMatches = []
    /** @type {Map<number, CellMatch[]>} rowIndex → matches，供窗格重繪時 O(1) 查詢 */
    this._findMatchMap = new Map()
    this._findCurrentIdx = -1
    this._findQuery = ''
    this._findCaseSensitive = false
    /** @type {((e: KeyboardEvent) => void)|null} */
    this._keyHandler = null

    /** @type {(() => void)|null} Removes the drag & drop listeners on destroy */
    this._dropCleanup = null

    // S16-T2: row-level difference navigation
    /** @type {number[]} */
    this._diffRows = []
    this._currentDiffIdx = 0
    /** @type {boolean} set by setLeft/setRight, consumed after the next render */
    this._pendingFirstDiff = false

    // Visibility filters
    this._showSame = true
    this._showDiff = true

    // T15: sort before compare
    this._sortBeforeCompare = false

    // P1-9: pane arrangement, matching the other views' Side/Over toggle.
    /** @type {'side-by-side'|'over-under'} */
    this._layoutMode = options.layoutMode === 'over-under' ? 'over-under' : 'side-by-side'

    // T22: last compare timestamp (ms since epoch, or null before first compare)
    /** @type {number|null} */
    this._lastCompareTime = null

    // Event handlers
    this._handlers = {}

    // DOM container (set by mount)
    this._container = null

    // Cached DOM refs
    this._dom = {}

    // Style injected flag
    this._styleInjected = false

    // ── P2-41: column visibility, whitespace, side panels ─────────────────────
    /** @type {Set<number>} 只隱藏顯示，仍參與比對 */
    this._hiddenColumns = new Set(toColumnList(options.hiddenColumns))
    /** @type {Set<number>} 完全排除：不比對也不顯示 */
    this._ignoredColumns = new Set(toColumnList(options.ignoredColumns))
    /** @type {boolean} 儲存格內的空白字元可視化 */
    this._showWhitespace = options.showWhitespace ?? false
    /** @type {boolean} Text Details 面板 */
    this._showDetails = options.showDetails ?? false
    /** @type {boolean} File Info 面板 */
    this._showFileInfo = options.showFileInfo ?? false
    /** @type {{ side: 'left'|'right', visibleRowIdx: number, col: number }|null} */
    this._selectedCell = null
    /** @type {{ left: string|null, right: string|null }} 開檔時 IPC 回報的編碼 */
    this._encoding = { left: null, right: null }
    /** @type {Map<string, { size: number, mtime: string }>} 由 read-dir 補齊，見 _loadFileStats */
    this._statCache = new Map()
    /** @type {Set<string>} paths already looked up, successfully or not */
    this._statAttempted = new Set()
    /** @type {Record<number, ColumnRule>|null} memoised _effectiveRules() result */
    this._rulesCache = null

    // ── P2-45 / P2-46: difference grading and the thumbnail ───────────────────
    /** @type {boolean} 依儲存格差異大小深淺分級（仍在「差異＝紅」的語意內） */
    this._showSeverity = options.showSeverity ?? false
    /** @type {boolean} 整表差異縮圖 */
    this._showThumbnail = options.showThumbnail ?? false
    /** @type {ThumbBucket[]} 目前繪出的縮圖區段，供點擊換算成列號 */
    this._thumbBuckets = []

    // ── S25: row numbers, range selection, display font ───────────────────────
    /** @type {boolean} 列號欄的顯示開關（比照 text compare 的 T48） */
    this._showRowNumbers = options.showRowNumbers ?? true

    /**
     * @typedef {{ side: 'left'|'right', top: number, bottom: number,
     *             leftCol: number, rightCol: number }} SelectionRange
     * 以可見列索引與顯示欄索引表示，兩端皆含。
     * @type {SelectionRange|null}
     */
    this._selectionRange = null

    /** @type {number} 顯示字級（px）；列高由 rowHeightForFont 導出 */
    this._fontSize = clampTableFontSize(options.fontSize ?? DEFAULT_TABLE_FONT_SIZE)
    /** @type {number} */
    this._rowHeight = rowHeightForFont(this._fontSize)

    /** @type {number} 「上/下一處編輯」導航目前落在第幾筆；-1 代表尚未開始 */
    this._editNavIdx = -1

    // ── S27: N:M column mapping ───────────────────────────────────────────────
    /** @type {ColumnPair[]|null} null 代表「顯示欄＝來源欄」 */
    this._columnMapping = normaliseColumnMapping(options.columnMapping)
    /** @type {number[]|null} 顯示欄 → 左側來源欄；null 代表 1:1 */
    this._leftColMap = null
    /** @type {number[]|null} 顯示欄 → 右側來源欄；null 代表 1:1 */
    this._rightColMap = null
    /** @type {{ left: string[]|null, right: string[]|null }} 投影後的標題列 */
    this._displayHeaders = { left: null, right: null }
    /** @type {Record<number, string>} 顯示層改名，不影響比對讀到的資料 */
    this._columnNames = {}
    /**
     * 只存在於單側的欄位是否計入差異。
     * 預設 true：一欄只有一邊有，兩邊在那一欄就是不一樣。
     * @type {boolean}
     */
    this._unmatchedIsDiff = options.unmatchedIsDiff ?? true
    /** @type {ColumnPair[]|null} 對應對話框的工作副本（按「套用」才落地） */
    this._mapDraft = null

    // ── S27: session settings (Type / Conversion / Specs) ─────────────────────
    /** @type {{ left: string|null, right: string|null }} 手動指定的分隔符，null=自動 */
    this._delimiterOverride = { left: null, right: null }
    /** @type {{ left: string|null, right: string|null }} 手動指定的編碼，null=自動 */
    this._encodingOverride = { left: null, right: null }
    /** @type {{ name: string, description: string }} Specs 分頁的 session 說明 */
    this._sessionInfo = { name: '', description: '' }
    /** @type {'type'|'conversion'|'specs'} 對話框上次停留的分頁 */
    this._sessionTab = 'type'
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * 把 UI 渲染到 containerEl
   * @param {HTMLElement} containerEl
   */
  mount(containerEl) {
    this._container = containerEl
    this._render()
    this._bindEvents()
  }

  /** 清除 DOM、移除事件、移除注入的 style */
  destroy() {
    closeContextMenu()
    this._cancelCellEdit()
    if (this._beforeUnload) {
      window.removeEventListener('beforeunload', this._beforeUnload)
      this._beforeUnload = null
    }
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler)
      this._keyHandler = null
    }
    if (this._dropCleanup) {
      this._dropCleanup()
      this._dropCleanup = null
    }
    if (this._container) {
      this._container.innerHTML = ''
      this._container = null
    }
    this._handlers = {}
    if (this._injectedStyleEl) {
      this._injectedStyleEl.remove()
      this._injectedStyleEl = null
    }
    this._styleInjected = false
  }

  /** @returns {Array<{ name: string, extensions: string[] }>} */
  static get openFilters() {
    return [
      { name: '表格檔案', extensions: ['csv', 'tsv', 'txt', 'xlsx', 'xls', 'html', 'htm'] },
      { name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] },
      { name: 'Excel', extensions: ['xlsx', 'xls'] },
      { name: 'HTML', extensions: ['html', 'htm'] },
      { name: '所有檔案', extensions: ['*'] },
    ]
  }

  /**
   * Record the encoding a file was decoded with, for the File Info panel.
   *
   * Public because most files reach this view through the host's smart routing
   * rather than through `openLeft`/`openRight`, and only the caller that did
   * the decoding knows the answer.
   *
   * @param {'left'|'right'} side
   * @param {string|null} encoding
   * @returns {this}
   */
  setEncoding(side, encoding) {
    if (side !== 'left' && side !== 'right') return this
    this._encoding[side] = encoding ? String(encoding) : null
    this._updateFileInfoPanel()
    return this
  }

  /**
   * @param {'left'|'right'} side
   * @returns {string|null}
   */
  getEncoding(side) {
    return this._encoding[side] ?? null
  }

  /** 呼叫 electronAPI.openFile()，讀取左側 CSV/TSV/XLSX/HTML */
  async openLeft() { await this._openInto('left') }

  /** 呼叫 electronAPI.openFile()，讀取右側 CSV/TSV/XLSX/HTML */
  async openRight() { await this._openInto('right') }

  /**
   * @param {'left'|'right'} side
   * @returns {Promise<void>}
   */
  async _openInto(side) {
    const result = await window.electronAPI.openFile({ filters: TableCompare.openFilters })
    if (!result) return
    // The only place the decoder's verdict reaches this view; File Info would
    // otherwise have to guess, and guessing an encoding is how files get
    // silently corrupted on save.
    this.setEncoding(side, result.encoding ?? null)
    await this._acceptFileInto(side, result.path, result.content)
  }

  /**
   * Route a file's contents into one side by its format.
   *
   * Shared by opening and reloading so the two cannot drift: reloading an
   * .xlsx through the CSV path would fill the grid with the raw zip container
   * and report success.
   *
   * @param {'left'|'right'} side
   * @param {string} path
   * @param {string} content
   * @returns {Promise<void>}
   */
  async _acceptFileInto(side, path, content) {
    const lower = String(path ?? '').toLowerCase()
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      await this._openExcel(side, path)
    } else if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      this._openHtmlContent(side, path, content)
    } else if (side === 'left') {
      this.setLeft(path, content)
    } else {
      this.setRight(path, content)
    }
  }

  /**
   * Re-read one side from disk, discarding the in-memory copy.
   *
   * "重新整理" only re-runs the comparison over what is already loaded. This is
   * the separate BC action for picking up a file another program has changed —
   * without it the only way to see an external edit was to close the session
   * and open the file again. Hex Compare has had this; the table view did not.
   *
   * Unsaved cell edits are confirmed first, because reloading destroys them
   * exactly as closing would.
   *
   * @param {'left'|'right'} side
   * @param {{ confirmed?: boolean }} [opts] `confirmed` skips the prompt when
   *   the caller already asked (reloading both sides asks once)
   * @returns {Promise<boolean>} true when the side was re-read
   */
  async reloadSide(side, opts = {}) {
    const sideName = side === 'left' ? '左側' : '右側'
    const path = side === 'left' ? this._leftPath : this._rightPath
    if (!path) {
      this._reportError(`${sideName}沒有檔案路徑，無法重新載入`)
      return false
    }
    if (!opts.confirmed && this._modified[side]) {
      const ok = window.confirm(
        `${sideName}有未儲存的儲存格修改。\n` +
        '重新載入會從磁碟讀回檔案，這些修改會遺失。要繼續嗎？')
      if (!ok) return false
    }

    let result
    try {
      result = await window.electronAPI.readFile(path)
    } catch (err) {
      this._reportError(
        `重新載入${sideName}失敗：${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    if (!result || typeof result.content !== 'string') {
      this._reportError(`重新載入${sideName}失敗：讀不到檔案內容`)
      return false
    }

    this.setEncoding(side, result.encoding ?? null)
    await this._acceptFileInto(side, result.path ?? path, result.content)
    // setLeft/setRight rebuild the parsed table, which is what clears the
    // modified flag and the edit history for that side.
    return true
  }

  /**
   * Re-read whichever sides have a path.
   * @returns {Promise<boolean>} true when at least one side was re-read
   */
  async reloadAll() {
    /** @type {Array<'left'|'right'>} */
    const sides = []
    if (this._leftPath) sides.push('left')
    if (this._rightPath) sides.push('right')
    if (sides.length === 0) {
      this._reportError('尚未載入任何檔案，無法重新載入')
      return false
    }
    if (this.hasUnsavedChanges()) {
      const ok = window.confirm(
        '有尚未儲存的修改。重新載入會從磁碟讀回檔案，這些修改會遺失。要繼續嗎？')
      if (!ok) return false
    }
    let any = false
    for (const side of sides) {
      if (await this.reloadSide(side, { confirmed: true })) any = true
    }
    return any
  }

  /**
   * P2-33: 以 electronAPI.readExcel() 讀取活頁簿的**所有**工作表，
   * 預設載入第一個（或與對側同名的那個），其餘可從路徑列的下拉選單切換。
   *
   * @param {'left'|'right'} side
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _openExcel(side, path) {
    let result
    try {
      result = await window.electronAPI.readExcel(path)
    } catch (err) {
      this._reportError(`讀取 Excel 失敗：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (result?.error) {
      this._reportError(`讀取 Excel 失敗：${result.error}`)
      return
    }
    const names = result?.sheetNames ?? []
    if (!names.length) {
      this._reportError(`${path} 沒有任何工作表`)
      return
    }
    this._setSource(side, path, 'excel',
      names.map((name) => ({ name, text: result.sheets?.[name] ?? '' })))
  }

  /**
   * P2-33: 擷取 HTML 內的所有 `<table>`，預設載入第一個。
   *
   * @param {'left'|'right'} side
   * @param {string} path
   * @param {string} html
   * @returns {boolean} false 代表檔案裡沒有表格
   */
  _openHtmlContent(side, path, html) {
    const tables = parseHtmlTables(html)
    if (!tables.length) {
      this._reportError(`${path} 內找不到 <table>`)
      return false
    }
    this._setSource(side, path, 'html',
      tables.map((t) => ({ name: t.name, text: serializeTable(t.rows) })))
    return true
  }

  /**
   * 記錄一個多分頁來源（Excel 活頁簿 / HTML 檔），並載入預設的那一頁。
   *
   * @param {'left'|'right'} side
   * @param {string} path
   * @param {'excel'|'html'} kind
   * @param {Array<{ name: string, text: string }>} parts
   */
  _setSource(side, path, kind, parts) {
    this._sources[side] = { path, kind, parts, active: null }
    this._sourceKind[side] = kind

    const other = side === 'left' ? 'right' : 'left'
    const otherActive = this._sources[other]?.active
    // Same-named sheets are almost always the intended pair. Differently-named
    // ones still pair fine — each side keeps its own selector.
    const preferred = (otherActive && parts.some((p) => p.name === otherActive))
      ? otherActive
      : parts[0].name

    this._syncSourceSelect(side)
    this.selectSourcePart(side, preferred)
  }

  /**
   * 目前這一側可選的工作表 / 表格名稱（一般文字檔為空陣列）。
   * @param {'left'|'right'} side
   * @returns {string[]}
   */
  getSourceParts(side) {
    return (this._sources[side]?.parts ?? []).map((p) => p.name)
  }

  /**
   * 目前這一側載入中的工作表 / 表格名稱。
   * @param {'left'|'right'} side
   * @returns {string|null}
   */
  getActiveSourcePart(side) {
    return this._sources[side]?.active ?? null
  }

  /**
   * 切換這一側要比對的工作表 / 表格。
   *
   * @param {'left'|'right'} side
   * @param {string} name
   * @returns {boolean} false 代表找不到該名稱
   */
  selectSourcePart(side, name) {
    const src = this._sources[side]
    if (!src) return false
    const part = src.parts.find((p) => p.name === name)
    if (!part) {
      this._reportError(`找不到工作表 / 表格「${name}」`)
      return false
    }
    src.active = part.name
    const sel = this._dom[side === 'left' ? 'selLeft' : 'selRight']
    if (sel) sel.value = part.name
    const display = src.parts.length > 1 ? `${src.path} [${part.name}]` : src.path
    this._setSideContent(side, display, part.text)
    return true
  }

  /**
   * 依目前的來源重建下拉選單（只有超過一頁時才顯示）。
   * @param {'left'|'right'} side
   */
  _syncSourceSelect(side) {
    const sel = this._dom[side === 'left' ? 'selLeft' : 'selRight']
    if (!sel) return
    const src = this._sources[side]
    sel.innerHTML = ''
    if (!src || src.parts.length <= 1) {
      sel.style.display = 'none'
      return
    }
    for (const part of src.parts) {
      sel.appendChild(el('option', { value: part.name }, part.name))
    }
    if (src.active) sel.value = src.active
    sel.style.display = ''
  }

  /**
   * 直接設定左側內容（如 session 還原）
   * @param {string} path
   * @param {string} content
   */
  setLeft(path, content) {
    this._sources.left = null
    this._sourceKind.left = 'text'
    this._syncSourceSelect('left')
    this._setSideContent('left', path, content)
  }

  /**
   * 直接設定右側內容（如 session 還原）
   * @param {string} path
   * @param {string} content
   */
  setRight(path, content) {
    this._sources.right = null
    this._sourceKind.right = 'text'
    this._syncSourceSelect('right')
    this._setSideContent('right', path, content)
  }

  /**
   * 載入一側的內容。公開的 setLeft/setRight 會先清掉多分頁來源資訊再走這裡；
   * 切換工作表則保留來源資訊。
   *
   * @param {'left'|'right'} side
   * @param {string} path
   * @param {string} content
   */
  _setSideContent(side, path, content) {
    // New content replaces the parsed rows, so every history entry — which
    // addresses rows by index into that parse — no longer refers to anything.
    this._cancelCellEdit()
    this._clearHistory()
    this._modified[side] = false
    // A selection names a row index in the old data; keeping it would point the
    // details panel at an unrelated row.
    this._selectedCell = null

    if (side === 'left') {
      this._leftPath = path
      this._leftContent = content
    } else {
      this._rightPath = path
      this._rightContent = content
    }
    this._pendingFirstDiff = true
    this._updatePathDisplay(side, path)
    // The virtual scroller skips repaints when the row window is unchanged;
    // a new data source must invalidate it or the panes keep the old rows.
    this._windowFirst = null
    this._windowLast = null
    this._parseAndRefresh()
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
  }

  /** 重新解析並重新渲染 */
  refresh() {
    this._parseAndRefresh()
  }

  /**
   * S16-T3: 交換左右兩側的所有成對狀態，重新比對並重繪。
   * @returns {this}
   */
  swap() {
    // History entries name a side, so keeping them across a swap would apply
    // the next undo to the wrong file.
    this._cancelCellEdit()
    this._clearHistory()
    ;[this._sources.left, this._sources.right] = [this._sources.right, this._sources.left]
    ;[this._sourceKind.left, this._sourceKind.right] = [this._sourceKind.right, this._sourceKind.left]
    ;[this._modified.left, this._modified.right] = [this._modified.right, this._modified.left]
    ;[this._delimiter.left, this._delimiter.right] = [this._delimiter.right, this._delimiter.left]
    ;[this._encoding.left, this._encoding.right] = [this._encoding.right, this._encoding.left]
    ;[this._rowIndexMap.left, this._rowIndexMap.right] = [this._rowIndexMap.right, this._rowIndexMap.left]
    this._syncSourceSelect('left')
    this._syncSourceSelect('right')
    ;[this._leftPath, this._rightPath] = [this._rightPath, this._leftPath]
    ;[this._leftContent, this._rightContent] = [this._rightContent, this._leftContent]
    ;[this._leftParsed, this._rightParsed] = [this._rightParsed, this._leftParsed]
    ;[this._leftHeaders, this._rightHeaders] = [this._rightHeaders, this._leftHeaders]
    this._colWidths = { left: this._colWidths.right, right: this._colWidths.left }
    // S27: the per-side overrides and the column mapping name a side too; a
    // swap that left them behind would re-parse the moved file with the other
    // one's delimiter.
    ;[this._delimiterOverride.left, this._delimiterOverride.right] =
      [this._delimiterOverride.right, this._delimiterOverride.left]
    ;[this._encodingOverride.left, this._encodingOverride.right] =
      [this._encodingOverride.right, this._encodingOverride.left]
    if (this._columnMapping) {
      this._columnMapping = this._columnMapping.map((p) => ({ left: p.right, right: p.left }))
    }

    this._updatePathDisplay('left', this._leftPath ?? '（未選擇）')
    this._updatePathDisplay('right', this._rightPath ?? '（未選擇）')

    // Alignment is key-order dependent, so the row set itself changes on a
    // swap — every navigation index computed from the old order is stale.
    this._currentDiffIdx = 0
    this._compare()
    this._renderTable()
    this._recomputeFind()
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
    return this
  }

  // ── P2-21: cell editing, undo/redo, save ─────────────────────────────────────

  /**
   * 把「可見列 + 顯示欄」換算成「解析後模型的列索引 + 來源欄索引」。
   *
   * 兩者不是同一個座標系：可見列會被篩選、排序與 key 對齊重排，而忽略欄位
   * 排序時右側的顯示欄也已被重排過。編輯必須寫回來源座標，否則存檔會把值
   * 放到別的欄。
   *
   * @param {'left'|'right'} side
   * @param {number} visibleRowIdx  index into this._visibleRows
   * @param {number} col            display column index
   * @returns {{ parsedRowIdx: number, sourceCol: number, rowRef: string[] }|null} null 代表不可編輯
   */
  _resolveCell(side, visibleRowIdx, col) {
    if (!Number.isInteger(col) || col < 0) return null
    const aligned = this._visibleRows?.[visibleRowIdx]
    if (!aligned) return null
    // A phantom cell has no row on this side to write into.
    const dataIdx = side === 'left' ? aligned.leftIdx : aligned.rightIdx
    if (dataIdx == null || dataIdx < 0) return null

    const data = side === 'left' ? this._leftData : this._rightData
    const rowRef = data?.[dataIdx]
    if (!rowRef) return null
    const parsedRowIdx = this._rowIndexMap[side]?.get(rowRef)
    if (parsedRowIdx == null) return null

    const sourceCol = this._sourceColFor(side, col)
    // Under a column mapping a displayed column may have no counterpart here.
    if (sourceCol == null || sourceCol < 0) return null
    return { parsedRowIdx, sourceCol, rowRef }
  }

  /**
   * 找出某一側在某個可見列的來源列物件；該側在這一列是幻影列時回傳 null。
   *
   * @param {'left'|'right'} side
   * @param {number} visibleRowIdx
   * @returns {{ parsedRowIdx: number, rowRef: string[] }|null}
   */
  _resolveRow(side, visibleRowIdx) {
    const aligned = this._visibleRows?.[visibleRowIdx]
    if (!aligned) return null
    const dataIdx = side === 'left' ? aligned.leftIdx : aligned.rightIdx
    if (dataIdx == null || dataIdx < 0) return null
    const data = side === 'left' ? this._leftData : this._rightData
    const rowRef = data?.[dataIdx]
    if (!rowRef) return null
    const parsedRowIdx = this._rowIndexMap[side]?.get(rowRef)
    if (parsedRowIdx == null) return null
    return { parsedRowIdx, rowRef }
  }

  /**
   * @param {'left'|'right'} side
   * @param {number} rowIdx  index into _leftParsed / _rightParsed
   * @param {number} col
   * @returns {string}
   */
  _readParsedCell(side, rowIdx, col) {
    const parsed = side === 'left' ? this._leftParsed : this._rightParsed
    return parsed?.[rowIdx]?.[col] ?? ''
  }

  /**
   * @param {'left'|'right'} side
   * @param {number} rowIdx
   * @param {number} col
   * @param {string} value
   * @returns {boolean}
   */
  _writeParsedCell(side, rowIdx, col, value) {
    const parsed = side === 'left' ? this._leftParsed : this._rightParsed
    const row = parsed?.[rowIdx]
    if (!row) return false
    // A ragged row may be shorter than the widest one; pad rather than leave
    // holes, which would serialise as `undefined`.
    while (row.length < col) row.push('')
    row[col] = value
    return true
  }

  /**
   * 讀取某個可見儲存格目前的值（測試與右鍵選單用）。
   * @param {'left'|'right'} side
   * @param {number} visibleRowIdx
   * @param {number} col
   * @returns {string|null}
   */
  getCellValue(side, visibleRowIdx, col) {
    const t = this._resolveCell(side, visibleRowIdx, col)
    if (!t) return null
    return this._readParsedCell(side, t.parsedRowIdx, t.sourceCol)
  }

  /**
   * 修改一個儲存格並記入 undo 堆疊，接著重新計算該列的差異狀態。
   *
   * @param {'left'|'right'} side
   * @param {number} visibleRowIdx  index into the currently visible rows
   * @param {number} col            display column index
   * @param {string} value
   * @returns {boolean} false 代表該儲存格不可編輯
   */
  editCell(side, visibleRowIdx, col, value) {
    const target = this._resolveCell(side, visibleRowIdx, col)
    if (!target) return false

    const before = this._readParsedCell(side, target.parsedRowIdx, target.sourceCol)
    const after = String(value ?? '')
    if (before === after) return true

    if (!this._writeParsedCell(side, target.parsedRowIdx, target.sourceCol, after)) return false
    // rowRef, not just rowIdx: inserting a row shifts every index below it, and
    // an undo replayed against the shifted index would edit the wrong row.
    this._pushHistory({
      kind: 'cell', side, rowIdx: target.parsedRowIdx, col: target.sourceCol,
      before, after, rowRef: target.rowRef,
    })
    this._afterEdit(side)
    return true
  }

  /**
   * @param {EditEntry} entry
   */
  _pushHistory(entry) {
    this._undoStack.push(entry)
    if (this._undoStack.length > MAX_EDIT_HISTORY) this._undoStack.shift()
    // A new edit invalidates the redo branch.
    this._redoStack.length = 0
  }

  _clearHistory() {
    this._undoStack.length = 0
    this._redoStack.length = 0
  }

  /** @returns {boolean} 是否還有可以還原的編輯 */
  canUndo() { return this._undoStack.length > 0 }

  /** @returns {boolean} 是否還有可以重做的編輯 */
  canRedo() { return this._redoStack.length > 0 }

  /**
   * 還原上一次的儲存格編輯。
   * @returns {boolean} false 代表堆疊已空
   */
  undo() {
    this._cancelCellEdit()
    const entry = this._undoStack.pop()
    if (!entry) return false
    if (!this._applyHistory(entry, 'undo')) {
      // Putting it back keeps the stack honest: a failed undo must not silently
      // consume the entry and leave the user one step further from their data.
      this._undoStack.push(entry)
      this._reportError('無法還原這一步：對應的來源資料列已不存在')
      return false
    }
    this._redoStack.push(entry)
    if (this._redoStack.length > MAX_EDIT_HISTORY) this._redoStack.shift()
    // The file on disk still differs from what is on screen after an undo, so
    // the modified flag stays set rather than guessing the file is pristine.
    this._afterEdit(entry.side, entry.kind === 'row')
    return true
  }

  /**
   * 重做上一次被還原的編輯。
   * @returns {boolean} false 代表堆疊已空
   */
  redo() {
    this._cancelCellEdit()
    const entry = this._redoStack.pop()
    if (!entry) return false
    if (!this._applyHistory(entry, 'redo')) {
      this._redoStack.push(entry)
      this._reportError('無法重做這一步：對應的來源資料列已不存在')
      return false
    }
    this._undoStack.push(entry)
    if (this._undoStack.length > MAX_EDIT_HISTORY) this._undoStack.shift()
    this._afterEdit(entry.side, entry.kind === 'row')
    return true
  }

  /**
   * 套用一筆歷史紀錄的其中一個方向。
   *
   * @param {EditEntry} entry
   * @param {'undo'|'redo'} direction
   * @returns {boolean}
   */
  _applyHistory(entry, direction) {
    if (entry.kind === 'batch') {
      // All-or-nothing: a batch that applied to only some of its cells would
      // leave the table in a state no further undo could describe.
      const applied = []
      for (const sub of entry.edits) {
        if (this._applyHistory(sub, direction)) { applied.push(sub); continue }
        const back = direction === 'undo' ? 'redo' : 'undo'
        for (const done of applied) this._applyHistory(done, back)
        return false
      }
      return true
    }
    if (entry.kind === 'row') {
      if (entry.op === 'insert') {
        return direction === 'undo'
          ? this._spliceRow(entry.side, entry.rowIdx, entry.rowRef, 'remove')
          : this._spliceRow(entry.side, entry.rowIdx, entry.rowRef, 'insert')
      }
      return this._writeRowContents(
        entry.side, entry, direction === 'undo' ? entry.before : entry.after)
    }
    const rowIdx = this._historyRowIndex(entry)
    if (rowIdx == null) return false
    return this._writeParsedCell(
      entry.side, rowIdx, entry.col, direction === 'undo' ? entry.before : entry.after)
  }

  /**
   * 歷史紀錄指向的列在目前解析結果中的索引。優先用列物件反查，因為插入 /
   * 刪除會讓當初記下的索引失效。
   *
   * @param {{ side: 'left'|'right', rowIdx: number, rowRef?: string[]|null }} entry
   * @returns {number|null}
   */
  _historyRowIndex(entry) {
    const parsed = entry.side === 'left' ? this._leftParsed : this._rightParsed
    if (!parsed) return null
    if (entry.rowRef) {
      const byRef = this._rowIndexMap[entry.side]?.get(entry.rowRef)
      if (byRef != null) return byRef
      // The row object is gone (file reloaded); the index is the only lead left.
    }
    return (entry.rowIdx >= 0 && entry.rowIdx < parsed.length) ? entry.rowIdx : null
  }

  /**
   * 就地改寫一整列的內容。刻意不換掉陣列物件——列物件的識別是編輯、對齊與
   * `_rowIndexMap` 三者之間唯一的連結。
   *
   * @param {'left'|'right'} side
   * @param {{ rowIdx: number, rowRef?: string[]|null }} locator
   * @param {string[]|null} values
   * @returns {boolean}
   */
  _writeRowContents(side, locator, values) {
    const parsed = side === 'left' ? this._leftParsed : this._rightParsed
    const idx = this._historyRowIndex({ side, rowIdx: locator.rowIdx, rowRef: locator.rowRef })
    const row = idx == null ? null : parsed?.[idx]
    if (!row) return false
    row.length = 0
    for (const v of values ?? []) row.push(String(v ?? ''))
    return true
  }

  /**
   * 在解析結果中插入或移除一整列。
   *
   * @param {'left'|'right'} side
   * @param {number} rowIdx
   * @param {string[]} rowRef
   * @param {'insert'|'remove'} mode
   * @returns {boolean}
   */
  _spliceRow(side, rowIdx, rowRef, mode) {
    const parsed = side === 'left' ? this._leftParsed : this._rightParsed
    if (!parsed) return false
    if (mode === 'remove') {
      const at = this._rowIndexMap[side]?.get(rowRef) ?? rowIdx
      if (at < 0 || at >= parsed.length || parsed[at] !== rowRef) return false
      parsed.splice(at, 1)
      return true
    }
    const at = Math.min(Math.max(rowIdx, 0), parsed.length)
    parsed.splice(at, 0, rowRef)
    return true
  }

  // ── P2-44: row-level commands (Copy to Left/Right, Insert Row) ──────────────

  /** @returns {number} 目前顯示的欄數（左右取大） */
  _displayColCount() {
    return this._colCount
      ?? Math.max(this._leftColCount ?? 0, this._rightColCount ?? 0)
  }

  /**
   * 顯示欄索引 → 該側檔案中的來源欄索引。有欄位對應時兩者不同。
   *
   * @param {'left'|'right'} side
   * @param {number} displayCol
   * @returns {number} -1 代表該側沒有對應欄
   */
  _sourceColFor(side, displayCol) {
    const map = side === 'left' ? this._leftColMap : this._rightColMap
    if (!map) return displayCol
    return map[displayCol] ?? NO_COLUMN
  }

  /**
   * 這一側在某個顯示欄有沒有來源欄。沒有的欄要畫成「單側獨有」而不是空白，
   * 否則使用者看到的是一欄相同的空格。
   *
   * @param {'left'|'right'} side
   * @param {number} displayCol
   * @returns {boolean}
   */
  _hasSourceColumn(side, displayCol) {
    const map = side === 'left' ? this._leftColMap : this._rightColMap
    if (!map) return true
    return (map[displayCol] ?? NO_COLUMN) >= 0
  }

  /**
   * 幻影列（該側沒有資料）要插在解析結果的哪個位置。
   *
   * 往上找最近一個在該側真的有資料的可見列，插在它後面；整張表在它之上都沒有
   * 該側資料時，插在標題列之後。
   *
   * @param {'left'|'right'} side
   * @param {number} visibleRowIdx
   * @returns {number}
   */
  _insertionPointFor(side, visibleRowIdx) {
    for (let i = Math.min(visibleRowIdx, (this._visibleRows?.length ?? 0)) - 1; i >= 0; i--) {
      const found = this._resolveRow(side, i)
      if (found) return found.parsedRowIdx + 1
    }
    return this._hasHeader ? 1 : 0
  }

  /**
   * 目前的作用列：以選取的儲存格為準，沒有選取時退回目前的差異列。
   * @returns {number|null}
   */
  _currentRowIndex() {
    const sel = this._selectedCell?.visibleRowIdx
    if (sel != null && this._visibleRows?.[sel]) return sel
    const fromDiff = this._diffRows?.[this._currentDiffIdx]
    return fromDiff != null ? fromDiff : null
  }

  /**
   * 把一整列複製到對側。目標側已有這一列就整列改寫，是幻影列就插入新的一列。
   *
   * 走的是與儲存格編輯同一條路徑（寫回解析後的模型、記入 undo 堆疊、重新比對），
   * 不直接動 DOM——這個視圖是虛擬捲動的，寫進 DOM 的值捲出畫面就沒了。
   *
   * @param {'left'|'right'} fromSide
   * @param {number} [visibleRowIdx]  預設取目前作用列
   * @returns {boolean}
   */
  copyRowToOtherSide(fromSide, visibleRowIdx) {
    this._commitCellEdit()
    const rowIdx = visibleRowIdx ?? this._currentRowIndex()
    if (rowIdx == null) {
      this._reportError('請先選取一列，或先跳到一個差異列')
      return false
    }
    const aligned = this._visibleRows?.[rowIdx]
    if (!aligned) {
      this._reportError('選取的列已不在目前的篩選結果中')
      return false
    }

    const toSide = fromSide === 'left' ? 'right' : 'left'
    const srcValues = fromSide === 'left' ? aligned.leftRow : aligned.rightRow
    if (!srcValues) {
      this._reportError(`${fromSide === 'left' ? '左' : '右'}側這一列沒有資料，無法複製`)
      return false
    }
    const targetParsed = toSide === 'left' ? this._leftParsed : this._rightParsed
    if (!targetParsed) {
      this._reportError(`${toSide === 'left' ? '左' : '右'}側尚未載入檔案，無法貼上`)
      return false
    }

    /** @type {string[]} */
    const values = []
    /** @type {number[]} */
    const dropped = []
    const n = Math.max(srcValues.length, this._displayColCount())
    for (let i = 0; i < n; i++) {
      const sourceCol = this._sourceColFor(toSide, i)
      if (sourceCol < 0) {
        if ((srcValues[i] ?? '') !== '') dropped.push(i)
        continue
      }
      while (values.length <= sourceCol) values.push('')
      values[sourceCol] = srcValues[i] ?? ''
    }

    const existing = this._resolveRow(toSide, rowIdx)
    if (existing) {
      const before = [...(targetParsed[existing.parsedRowIdx] ?? [])]
      const locator = { rowIdx: existing.parsedRowIdx, rowRef: existing.rowRef }
      if (!this._writeRowContents(toSide, locator, values)) {
        this._reportError('複製失敗：找不到目標側的來源資料列')
        return false
      }
      this._pushHistory({
        kind: 'row', op: 'replace', side: toSide, rowIdx: existing.parsedRowIdx,
        before, after: [...values], rowRef: existing.rowRef,
      })
      this._afterEdit(toSide)
    } else {
      const at = this._insertionPointFor(toSide, rowIdx)
      const rowRef = [...values]
      if (!this._spliceRow(toSide, at, rowRef, 'insert')) {
        this._reportError('複製失敗：目標側無法插入新的列')
        return false
      }
      this._pushHistory({
        kind: 'row', op: 'insert', side: toSide, rowIdx: at,
        before: null, after: [...values], rowRef,
      })
      this._afterEdit(toSide, true)
    }

    // Silently dropping data would be the worst outcome of "ignore column
    // order": the row looks copied and one column's value is simply gone.
    if (dropped.length) {
      this._reportError(
        `第 ${dropped.join('、')} 欄在目標檔案中沒有同名欄位，這些值未被複製`)
    }
    return true
  }

  /** Copy the current row from the left pane to the right. @returns {boolean} */
  copyRowToRight() { return this.copyRowToOtherSide('left') }

  /** Copy the current row from the right pane to the left. @returns {boolean} */
  copyRowToLeft() { return this.copyRowToOtherSide('right') }

  /**
   * 在某一側插入一列空白列，記入 undo 堆疊。
   *
   * @param {'left'|'right'} side
   * @param {number} [visibleRowIdx]  預設取目前作用列
   * @param {'above'|'below'} [where]
   * @returns {boolean}
   */
  insertRow(side, visibleRowIdx, where = 'below') {
    this._commitCellEdit()
    const parsed = side === 'left' ? this._leftParsed : this._rightParsed
    if (!parsed) {
      this._reportError(`${side === 'left' ? '左' : '右'}側尚未載入檔案，無法插入列`)
      return false
    }

    const rowIdx = visibleRowIdx ?? this._currentRowIndex()
    let at
    if (rowIdx == null) {
      // Nothing selected and nothing to anchor to — append.
      at = parsed.length
    } else {
      const anchor = this._resolveRow(side, rowIdx)
      at = anchor
        ? (where === 'above' ? anchor.parsedRowIdx : anchor.parsedRowIdx + 1)
        : this._insertionPointFor(side, rowIdx)
    }

    const cols = side === 'left' ? (this._leftColCount ?? 0) : (this._rightColCount ?? 0)
    const rowRef = new Array(Math.max(1, cols)).fill('')
    if (!this._spliceRow(side, at, rowRef, 'insert')) {
      this._reportError('插入列失敗')
      return false
    }
    this._pushHistory({
      kind: 'row', op: 'insert', side, rowIdx: at,
      before: null, after: [...rowRef], rowRef,
    })
    this._afterEdit(side, true)
    return true
  }

  /**
   * 編輯落地後：同步文字內容、標示未儲存、重新比對並重繪（保留捲動位置）。
   * @param {'left'|'right'} side
   * @param {boolean} [structural]  列數有變動（插入 / 刪除），需重建列索引
   */
  _afterEdit(side, structural = false) {
    const parsed = (side === 'left' ? this._leftParsed : this._rightParsed) ?? []
    // The map is keyed by position, so an insert invalidates every entry below
    // the insertion point — and with it every pending undo that resolves by index.
    if (structural) this._rowIndexMap[side] = _buildRowIndexMap(parsed)
    const text = serializeTable(parsed, this._delimiter[side])
    if (side === 'left') this._leftContent = text
    else this._rightContent = text

    this._modified[side] = true
    this._updatePathDisplay(side, (side === 'left' ? this._leftPath : this._rightPath) ?? '（未選擇）')
    this._emit('modified-changed', { left: this._modified.left, right: this._modified.right })

    const keepTop = this._dom.leftScroll?.scrollTop ?? 0
    this._compare()
    this._renderTable()
    // _renderTable rebuilds both panes from scratch, which drops scrollTop;
    // an edit must not teleport the user back to the top of a 100k-row file.
    if (this._dom.leftScroll) this._dom.leftScroll.scrollTop = keepTop
    if (this._dom.rightScroll) this._dom.rightScroll.scrollTop = keepTop
    this._windowFirst = null
    this._windowLast = null
    this._renderTableWindow()
    this._syncEditButtons()
  }

  /** @returns {boolean} 是否有未儲存的儲存格編輯 */
  hasUnsavedChanges() {
    return this._modified.left || this._modified.right
  }

  /** @returns {{ left: boolean, right: boolean }} */
  getModified() {
    return { left: this._modified.left, right: this._modified.right }
  }

  /**
   * 關閉分頁 / 視窗前呼叫：有未儲存的修改時詢問使用者。
   * @returns {boolean} true 代表可以繼續關閉
   */
  confirmDiscardChanges() {
    if (!this.hasUnsavedChanges()) return true
    return window.confirm('表格比對有未儲存的修改，關閉後將遺失。確定要關閉嗎？')
  }

  /** 儲存左側（Excel / HTML 來源只能另存為 CSV） @returns {Promise<boolean>} */
  async saveLeft() { return this._saveSide('left') }

  /** 儲存右側（Excel / HTML 來源只能另存為 CSV） @returns {Promise<boolean>} */
  async saveRight() { return this._saveSide('right') }

  /**
   * @param {'left'|'right'} side
   * @returns {Promise<boolean>} true 代表確實寫入了檔案
   */
  async _saveSide(side) {
    this._commitCellEdit()
    const parsed = side === 'left' ? this._leftParsed : this._rightParsed
    if (!parsed) {
      this._reportError('這一側沒有載入資料，無法儲存')
      return false
    }

    const src = this._sources[side]
    const displayPath = (side === 'left' ? this._leftPath : this._rightPath) ?? ''
    let defaultPath = src?.path ?? displayPath
    const kind = this._sourceKind[side]

    if (kind !== 'text') {
      const label = kind === 'excel' ? 'Excel 工作表' : 'HTML 表格'
      // There is no xlsx/html writer in this app. Writing a CSV under the
      // original name and reporting success would tell the user their .xlsx
      // was updated when it was not.
      const ok = window.confirm(
        `${label}無法原樣寫回，只能另存為 CSV（原始檔案不會被修改）。要繼續嗎？`)
      if (!ok) return false
      defaultPath = csvPathFor(defaultPath)
    }

    const content = serializeTable(parsed, this._delimiter[side])
    // Write back in the encoding the file was read in. Writing UTF-8
    // unconditionally turns a Big5 or Shift-JIS table into mojibake, silently.
    const encoding = this._encodingOverride[side] ?? this._encoding[side] ?? undefined
    let result
    try {
      result = await window.electronAPI.saveFile(
        defaultPath || 'table.csv',
        content,
        [{ name: 'CSV', extensions: ['csv'] },
         { name: 'TSV', extensions: ['tsv'] },
         { name: '所有檔案', extensions: ['*'] }],
        encoding)
    } catch (err) {
      this._reportError(`儲存失敗：${err instanceof Error ? err.message : String(err)}`)
      return false
    }

    // Cancelling the dialog returns falsy. Clearing the flag anyway would tell
    // the user their edits were saved and let the tab close without a prompt.
    if (!result) return false

    this._modified[side] = false
    const savedPath = typeof result === 'object' ? result.path : null
    if (savedPath) {
      // What is on disk now is a plain CSV, so further saves need no warning.
      this._sources[side] = null
      this._sourceKind[side] = 'text'
      this._delimiter[side] = ','
      this._syncSourceSelect(side)
      if (side === 'left') this._leftPath = savedPath
      else this._rightPath = savedPath
      this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
    }
    this._updatePathDisplay(side, (side === 'left' ? this._leftPath : this._rightPath) ?? '（未選擇）')
    this._emit('modified-changed', { left: this._modified.left, right: this._modified.right })
    this._syncEditButtons()
    return true
  }

  // ── P2-21: inline cell editor ────────────────────────────────────────────────

  /**
   * Resolve the cell under a mouse event to (visible row, display column).
   * @param {MouseEvent} e
   * @param {'left'|'right'} side
   * @returns {{ visibleRowIdx: number, col: number, td: HTMLElement }|null}
   */
  _cellFromEvent(e, side) {
    const target = e.target instanceof Element ? e.target : null
    const td = target?.closest('td.tc-cell')
    const tr = td?.closest('tr.tc-row')
    const tbody = this._dom[`${side}Tbody`]
    if (!td || !tr || !tbody || tr.parentElement !== tbody) return null
    const rowOffset = [...tbody.children].indexOf(tr)
    if (rowOffset < 0) return null
    // -1 skips the leading row-number cell.
    const col = [...tr.children].indexOf(td) - 1
    if (col < 0) return null
    return { visibleRowIdx: (this._windowFirst ?? 0) + rowOffset, col, td }
  }

  /**
   * @param {MouseEvent} e
   * @param {'left'|'right'} side
   */
  _onCellClick(e, side) {
    const hit = this._cellFromEvent(e, side)
    if (!hit) return
    if (e.shiftKey && this.extendSelectionTo(side, hit.visibleRowIdx, hit.col)) return
    this.selectCell(side, hit.visibleRowIdx, hit.col)
  }

  /**
   * @param {MouseEvent} e
   * @param {'left'|'right'} side
   */
  _onCellDblClick(e, side) {
    const hit = this._cellFromEvent(e, side)
    if (!hit) return
    if (hit.td.closest('tr.tc-row')?.classList.contains('phantom')) return
    this._beginCellEdit(side, hit.visibleRowIdx, hit.col, hit.td)
  }

  /**
   * @param {'left'|'right'} side
   * @param {number} visibleRowIdx
   * @param {number} col
   * @param {HTMLElement} td
   */
  _beginCellEdit(side, visibleRowIdx, col, td) {
    this._commitCellEdit()
    if (!this._resolveCell(side, visibleRowIdx, col)) {
      this._reportError('這個儲存格沒有對應的來源資料，無法編輯')
      return
    }

    // Read the model, not the cell: with visible whitespace on, td.textContent
    // holds `·` and `→` glyphs that must never be written back as data.
    const original = this.getCellValue(side, visibleRowIdx, col) ?? td.textContent ?? ''
    const input = el('input', { type: 'text', className: 'tc-cell-input' })
    input.value = original
    td.textContent = ''
    td.classList.add('tc-cell--editing')
    td.appendChild(input)
    this._editing = { side, visibleRowIdx, col, td, input, original }

    input.addEventListener('keydown', (/** @type {KeyboardEvent} */ ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        ev.stopPropagation()
        this._commitCellEdit()
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        this._cancelCellEdit()
      }
    })
    input.addEventListener('blur', () => this._commitCellEdit())
    input.focus()
    input.select()
  }

  /** 套用編輯中的儲存格；沒有編輯中的儲存格時為 no-op。 */
  _commitCellEdit() {
    const editing = this._editing
    if (!editing) return
    // Cleared first: editCell re-renders, which calls back into here.
    this._editing = null

    const value = editing.input.value
    editing.td.classList.remove('tc-cell--editing')
    const restore = this._showWhitespace ? visibleWhitespace(editing.original) : editing.original
    if (value === editing.original) {
      editing.td.textContent = restore
      return
    }
    if (!this.editCell(editing.side, editing.visibleRowIdx, editing.col, value)) {
      editing.td.textContent = restore
      this._reportError('儲存格編輯失敗：找不到對應的來源資料列')
    }
  }

  /** 放棄編輯中的儲存格，還原原本的顯示值。 */
  _cancelCellEdit() {
    const editing = this._editing
    if (!editing) return
    this._editing = null
    editing.td.classList.remove('tc-cell--editing')
    editing.td.textContent =
      this._showWhitespace ? visibleWhitespace(editing.original) : editing.original
  }

  /** 讓 undo / redo / 儲存按鈕反映目前狀態。 */
  _syncEditButtons() {
    const { btnUndo, btnRedo, btnSaveLeft, btnSaveRight, btnPrevEdit, btnNextEdit } = this._dom
    if (btnUndo) btnUndo.disabled = !this.canUndo()
    if (btnRedo) btnRedo.disabled = !this.canRedo()
    // Cheaper than getEditedRows(): whether any edit exists at all does not
    // need the visible-row scan, and this runs after every keystroke commit.
    const hasEdits = this._undoStack.length > 0 || this._redoStack.length > 0
    if (btnPrevEdit) btnPrevEdit.disabled = !hasEdits
    if (btnNextEdit) btnNextEdit.disabled = !hasEdits
    if (btnSaveLeft) btnSaveLeft.classList.toggle('tc-btn--dirty', this._modified.left)
    if (btnSaveRight) btnSaveRight.classList.toggle('tc-btn--dirty', this._modified.right)
  }

  // ── S16: Column handling ─────────────────────────────────────────────────────

  /**
   * 目前的 key 欄組合。空陣列代表按位置對齊。
   * @returns {number[]}
   */
  getKeyColumns() {
    return [...this._keyColumns]
  }

  /**
   * 設定 key 欄。接受單一數字（-1 = 按位置）或多欄陣列。
   * @param {number|number[]} cols
   * @returns {this}
   */
  setKeyColumns(cols) {
    this._keyColumns = normaliseKeyColumns(cols)
    this._syncKeyInput()
    this._parseAndRefresh()
    return this
  }

  /**
   * 目前所有非預設的欄位規則（欄索引 → 規則）。
   * @returns {Record<number, ColumnRule>}
   */
  getColumnRules() {
    return { ...this._columnRules }
  }

  /**
   * 設定單一欄位的比對方式。傳 null 或 mode='text' 代表還原為預設字串比對。
   *
   * @param {number} index
   * @param {{ mode: ColumnMode, tolerance?: number }|null} rule
   * @returns {this}
   */
  setColumnRule(index, rule) {
    if (!Number.isInteger(index) || index < 0) return this
    if (!rule || rule.mode === 'text' || !COLUMN_MODES.has(rule.mode)) {
      delete this._columnRules[index]
    } else {
      this._columnRules[index] = columnRuleAt({ [index]: rule }, index)
    }
    this._invalidateRules()
    this._recompare()
    return this
  }

  /**
   * 批次覆寫欄位規則（未列出的欄位還原為預設）。
   * @param {ColumnRuleSet} rules
   * @returns {this}
   */
  setColumnRules(rules) {
    this._columnRules = {}
    this._applyColumnRuleSet(rules)
    this._invalidateRules()
    this._recompare()
    return this
  }

  /** 開啟欄位設定面板 */
  openColumnSettings() {
    if (!this._dom.root) return
    this._buildColumnPanel()
    if (this._dom.colPanel) this._dom.colPanel.style.display = 'flex'
  }

  /** 關閉欄位設定面板 */
  closeColumnSettings() {
    if (this._dom.colPanel) this._dom.colPanel.style.display = 'none'
  }

  /**
   * 依內容自動調整欄寬。再呼叫一次會還原為自動配寬。
   *
   * 只取樣目前虛擬視窗內的列（必要時退回前 200 列），因為量測整張表在
   * 十萬列的 CSV 上要掃描全部資料，卻不會讓結果更好。
   *
   * @returns {this}
   */
  resizeColumnsToFit() {
    if (this._colWidths.left || this._colWidths.right) {
      this._colWidths = { left: null, right: null }
      this._applyColumnWidths()
      return this
    }

    const rows = this._visibleRows ?? []
    const first = this._windowFirst ?? 0
    const last = this._windowLast ?? Math.min(rows.length, first + 200)
    const sample = rows.slice(first, last)

    const leftCols = this._leftColCount ?? (this._leftParsed?.[0]?.length ?? 0)
    const rightCols = this._rightColCount ?? (this._rightParsed?.[0]?.length ?? 0)

    // Display-space headers: the widths are applied to the rendered columns.
    this._colWidths = {
      left: measureColumnWidths(
        sample.map((r) => r.leftRow), leftCols,
        this._hasHeader ? (this._displayHeaders?.left ?? null) : null),
      right: measureColumnWidths(
        sample.map((r) => r.rightRow), rightCols,
        this._hasHeader ? (this._displayHeaders?.right ?? null) : null),
    }
    this._applyColumnWidths()
    return this
  }

  // ── S27: N:M column mapping ─────────────────────────────────────────────────

  /**
   * 目前的欄位對應；null 代表「顯示欄＝來源欄」的預設。
   * @returns {ColumnPair[]|null}
   */
  getColumnMapping() {
    return this._columnMapping ? this._columnMapping.map((p) => ({ ...p })) : null
  }

  /**
   * 設定欄位對應。傳 null 還原為預設 1:1。
   *
   * @param {ColumnPair[]|null} mapping
   * @returns {this}
   */
  setColumnMapping(mapping) {
    this._commitCellEdit()
    this._columnMapping = normaliseColumnMapping(mapping)
    // Every per-column setting is keyed by display column, and a new mapping
    // just renumbered those; an index past the new width names nothing.
    // Resetting to the default is not "no width": the default is the identity
    // mapping, whose width is the wider side of the parsed data. Treating it as
    // unbounded left stale indices alive — a key column past the new width kept
    // showing in the key field, and a stale rule came back if the mapping was
    // later widened. Nothing parsed yet has no width to measure against, and
    // truncating to zero there would discard settings made before load.
    const n = this._columnMapping
      ? this._columnMapping.length
      : this._defaultColumnWidth()
    this._hiddenColumns = new Set([...this._hiddenColumns].filter((i) => i < n))
    this._ignoredColumns = new Set([...this._ignoredColumns].filter((i) => i < n))
    this._keyColumns = this._keyColumns.filter((i) => i < n)
    for (const key of Object.keys(this._columnRules)) {
      if (Number(key) >= n) delete this._columnRules[Number(key)]
    }
    for (const key of Object.keys(this._columnNames)) {
      if (Number(key) >= n) delete this._columnNames[Number(key)]
    }
    this._selectedCell = null
    this._colWidths = { left: null, right: null }
    this._invalidateRules()
    this._syncKeyInput()
    this._recompare()
    return this
  }

  /**
   * 沒有欄位對應時的顯示欄數（＝identity mapping 的長度）。
   * @returns {number} Infinity 代表尚未載入任何資料，無從判斷寬度
   */
  _defaultColumnWidth() {
    if (!this._leftParsed && !this._rightParsed) return Infinity
    return Math.max(
      this._leftParsed?.[0]?.length ?? 0,
      this._rightParsed?.[0]?.length ?? 0,
    )
  }

  /** 還原為預設 1:1 對應。 @returns {this} */
  resetColumnMapping() {
    return this.setColumnMapping(null)
  }

  /**
   * 依兩側標題名稱提出一份建議對應（不會自動套用）。
   * @returns {ColumnPair[]}
   */
  suggestColumnMapping() {
    const leftHeaders = this._hasHeader ? this._leftHeaders : null
    const rightHeaders = this._hasHeader ? this._rightHeaders : null
    return suggestColumnMapping(
      leftHeaders, rightHeaders,
      this._leftParsed?.[0]?.length ?? 0,
      this._rightParsed?.[0]?.length ?? 0,
    )
  }

  /** @returns {boolean} 單側獨有的欄位是否計入差異 */
  isUnmatchedCountedAsDiff() { return this._unmatchedIsDiff }

  /**
   * @param {boolean} on
   * @returns {this}
   */
  setUnmatchedCountedAsDiff(on) {
    const next = Boolean(on)
    if (next === this._unmatchedIsDiff) return this
    this._unmatchedIsDiff = next
    this._invalidateRules()
    this._recompare()
    return this
  }

  // ── S27: display-only column renaming ───────────────────────────────────────

  /**
   * @param {number} index  display column index
   * @returns {string|null} null 代表沿用檔案裡的欄名
   */
  getColumnDisplayName(index) {
    return this._columnNames[index] ?? null
  }

  /** @returns {Record<number, string>} */
  getColumnDisplayNames() { return { ...this._columnNames } }

  /**
   * 只改標題列顯示的字，不動任何被比對的資料。
   *
   * @param {number} index
   * @param {string|null} name  空字串或 null 還原為原本的欄名
   * @returns {this}
   */
  setColumnDisplayName(index, name) {
    if (!Number.isInteger(index) || index < 0) return this
    const text = String(name ?? '').trim()
    if (text) this._columnNames[index] = text
    else delete this._columnNames[index]
    // Display-only: the comparison reads cells, not labels — repaint, don't
    // re-align.
    this._renderTable()
    return this
  }

  /**
   * 批次設定顯示名稱（未列出的欄位還原）。
   * @param {Record<number|string, string>|null} names
   * @returns {this}
   */
  setColumnDisplayNames(names) {
    this._columnNames = {}
    for (const key of Object.keys(names ?? {})) {
      const index = Number(key)
      const text = String(names?.[key] ?? '').trim()
      if (Number.isInteger(index) && index >= 0 && text) this._columnNames[index] = text
    }
    this._renderTable()
    return this
  }

  // ── S27: Recompare Files ────────────────────────────────────────────────────

  /**
   * BC's Session ▸ Recompare Files.
   *
   * Distinct from 「重新整理」, which re-runs the comparison and leaves the undo
   * history in place: this starts the session's edit history over, so it asks
   * first when there are unsaved edits that would become unrevertable.
   *
   * @returns {boolean} false 代表使用者取消
   */
  recompareFiles() {
    this._commitCellEdit()
    if (this.hasUnsavedChanges()) {
      const ok = window.confirm(
        '重新比對會清除復原歷程，目前未儲存的修改將無法再還原（檔案內容不受影響）。要繼續嗎？')
      if (!ok) return false
    }
    this._clearHistory()
    this._selectedCell = null
    this._selectionRange = null
    this._editNavIdx = -1
    this._currentDiffIdx = 0
    this._findMatches = []
    this._findMatchMap = new Map()
    this._findCurrentIdx = -1
    // The virtual scroller skips repaints when the row window is unchanged.
    this._windowFirst = null
    this._windowLast = null
    this._pendingFirstDiff = true
    this._parseAndRefresh()
    this._syncEditButtons()
    this._emit('status', '已重新比對，復原歷程已清除')
    return true
  }

  // ── S27: Session Settings（Type / Conversion / Specs）────────────────────────

  /**
   * @param {'left'|'right'} side
   * @returns {string|null} null 代表自動偵測
   */
  getDelimiterOverride(side) { return this._delimiterOverride[side] ?? null }

  /**
   * 手動指定分隔符，覆寫自動偵測。
   *
   * 重新解析會丟掉尚未儲存的儲存格編輯，所以先問過。
   *
   * @param {'left'|'right'} side
   * @param {string|null} ch  單一字元；null 還原為自動偵測
   * @returns {boolean} false 代表未套用
   */
  setDelimiterOverride(side, ch) {
    const next = (typeof ch === 'string' && ch.length === 1) ? ch : null
    if (next === (this._delimiterOverride[side] ?? null)) return true
    if (this._modified[side]) {
      const sideName = side === 'left' ? '左側' : '右側'
      if (!window.confirm(
        `更改分隔符會重新解析${sideName}，未儲存的儲存格修改會遺失。要繼續嗎？`)) return false
    }
    this._delimiterOverride[side] = next
    this._commitCellEdit()
    this._clearHistory()
    this._parseAndRefresh()
    this._syncEditButtons()
    return true
  }

  /**
   * @param {'left'|'right'} side
   * @returns {string|null} null 代表自動偵測
   */
  getEncodingOverride(side) { return this._encodingOverride[side] ?? null }

  /**
   * 手動指定編碼，覆寫自動偵測；檔案會以該編碼重讀，之後存檔也用同一個編碼寫回。
   *
   * @param {'left'|'right'} side
   * @param {string|null} encoding  null 還原為自動偵測
   * @returns {Promise<boolean>} false 代表未套用
   */
  async setEncodingOverride(side, encoding) {
    const sideName = side === 'left' ? '左側' : '右側'
    const next = encoding ? String(encoding) : null
    // Independent of whether an encoding was asked for: "還原為自動偵測" on an
    // Excel/HTML side used to fall through and re-read the raw .xlsx bytes as
    // text, then record chardet's guess as that side's detected encoding.
    if (this._sourceKind[side] !== 'text') {
      this._reportError(`${sideName}是 Excel / HTML 來源，沒有文字編碼可以指定或還原`)
      return false
    }
    const path = side === 'left' ? this._leftPath : this._rightPath
    if (!path) {
      this._reportError(`${sideName}沒有檔案路徑，無法以指定編碼重讀`)
      return false
    }
    if (this._modified[side]) {
      if (!window.confirm(
        `更改編碼會重新讀取${sideName}，未儲存的儲存格修改會遺失。要繼續嗎？`)) return false
    }

    let result
    try {
      result = await window.electronAPI.readFile(path, next ?? undefined)
    } catch (err) {
      this._reportError(
        `以 ${next ?? '自動'} 重讀${sideName}失敗：${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    if (!result || typeof result.content !== 'string') {
      this._reportError(`以 ${next ?? '自動'} 重讀${sideName}失敗：讀不到檔案內容`)
      return false
    }

    this._encodingOverride[side] = next
    // The decoder's verdict, not the request: asking for "auto" has to end up
    // recording what it actually decided, because saving writes that back.
    this.setEncoding(side, result.encoding ?? null)
    await this._acceptFileInto(side, result.path ?? path, result.content)
    return true
  }

  /** @returns {{ name: string, description: string }} */
  getSessionInfo() { return { ...this._sessionInfo } }

  /**
   * Specs 分頁的 session 名稱與說明（只做紀錄，不影響比對）。
   * @param {{ name?: string, description?: string }} info
   * @returns {this}
   */
  setSessionInfo(info) {
    if (typeof info?.name === 'string') this._sessionInfo.name = info.name
    if (typeof info?.description === 'string') this._sessionInfo.description = info.description
    this._renderStats()
    return this
  }

  // ── P2-41: column visibility ────────────────────────────────────────────────

  /**
   * The rule set the comparison actually runs on: the user's per-column rules
   * with every excluded column forced to `ignore`.
   * @returns {Record<number, ColumnRule>}
   */
  _effectiveRules() {
    // Memoised: the per-row diff pass asks for this once per row, and a large
    // table would otherwise rebuild the same object a hundred thousand times.
    if (!this._rulesCache) {
      const merged = mergeIgnoredColumns(this._columnRules, this._ignoredColumns)
      if (!this._unmatchedIsDiff && this._leftColMap && this._rightColMap) {
        // With this off, a column only one side has says nothing about whether
        // the rows agree, so it must not turn every row red.
        for (let i = 0; i < this._leftColMap.length; i++) {
          if (this._leftColMap[i] < 0 || this._rightColMap[i] < 0) {
            merged[i] = { mode: 'ignore', tolerance: 0 }
          }
        }
      }
      this._rulesCache = merged
    }
    return this._rulesCache
  }

  /** Drop the memoised rule set after the rules or the exclusion set change. */
  _invalidateRules() {
    this._rulesCache = null
  }

  /** @returns {number[]} 只隱藏顯示的欄位 */
  getHiddenColumns() { return [...this._hiddenColumns].sort((a, b) => a - b) }

  /** @returns {number[]} 完全排除（不比對也不顯示）的欄位 */
  getIgnoredColumns() { return [...this._ignoredColumns].sort((a, b) => a - b) }

  /**
   * Columns that must not be painted — hidden plus excluded.
   * @param {number} index
   * @returns {boolean}
   */
  isColumnHidden(index) {
    return this._hiddenColumns.has(index) || this._ignoredColumns.has(index)
  }

  /**
   * @param {Iterable<number>|null} cols
   * @returns {this}
   */
  setHiddenColumns(cols) {
    this._hiddenColumns = new Set(toColumnList(cols ? [...cols] : []))
    // Display-only: nothing about the comparison changed, so repaint rather
    // than re-align.
    this._renderTable()
    return this
  }

  /**
   * @param {number} index
   * @param {boolean} hidden
   * @returns {this}
   */
  setColumnHidden(index, hidden) {
    if (!Number.isInteger(index) || index < 0) return this
    if (hidden) this._hiddenColumns.add(index)
    else this._hiddenColumns.delete(index)
    this._renderTable()
    return this
  }

  /**
   * @param {Iterable<number>|null} cols
   * @returns {this}
   */
  setIgnoredColumns(cols) {
    this._ignoredColumns = new Set(toColumnList(cols ? [...cols] : []))
    this._invalidateRules()
    // Excluding changes what "different" means, so the rows have to be
    // re-classified, not just repainted.
    this._recompare()
    return this
  }

  /**
   * @param {number} index
   * @param {boolean} ignored
   * @returns {this}
   */
  setColumnIgnored(index, ignored) {
    if (!Number.isInteger(index) || index < 0) return this
    if (ignored) this._ignoredColumns.add(index)
    else this._ignoredColumns.delete(index)
    this._invalidateRules()
    this._recompare()
    return this
  }

  // ── S27: Show All / Diff / Same / None ──────────────────────────────────────

  /**
   * 目前的顯示篩選，與 text / folder 視圖的四態同語意。
   * @returns {'all'|'diff'|'same'|'none'}
   */
  getShowFilter() {
    if (this._showSame && this._showDiff) return 'all'
    if (this._showDiff) return 'diff'
    if (this._showSame) return 'same'
    return 'none'
  }

  /**
   * @param {'all'|'diff'|'same'|'none'} mode
   * @returns {'all'|'diff'|'same'|'none'} 實際套用的模式
   */
  setShowFilter(mode) {
    switch (mode) {
      case 'diff': this._showSame = false; this._showDiff = true; break
      case 'same': this._showSame = true; this._showDiff = false; break
      case 'none': this._showSame = false; this._showDiff = false; break
      default: this._showSame = true; this._showDiff = true; break
    }
    this._syncShowFilterUi()
    this._renderTable()
    return this.getShowFilter()
  }

  /** Reflect the filter onto the four buttons and the two legacy checkboxes. */
  _syncShowFilterUi() {
    const mode = this.getShowFilter()
    for (const [key, value] of /** @type {const} */ ([
      ['btnShowAll', 'all'], ['btnShowDiff', 'diff'],
      ['btnShowSame', 'same'], ['btnShowNone', 'none'],
    ])) {
      this._dom[key]?.classList.toggle('active', mode === value)
    }
    if (this._dom.cbSame) this._dom.cbSame.checked = this._showSame
    if (this._dom.cbDiffOnly) this._dom.cbDiffOnly.checked = mode === 'diff'
  }

  // ── P2-41: whitespace, panels, cell selection ───────────────────────────────

  /** @returns {boolean} */
  isWhitespaceVisible() { return this._showWhitespace }

  /**
   * @param {boolean} on
   * @returns {boolean} the state now in effect
   */
  setWhitespaceVisible(on) {
    this._showWhitespace = Boolean(on)
    this._dom.btnWhitespace?.classList.toggle('active', this._showWhitespace)
    // Purely presentational: repaint the window, do not re-align.
    this._windowFirst = null
    this._windowLast = null
    this._renderTableWindow()
    this._updateDetailsPanel()
    return this._showWhitespace
  }

  /** @returns {boolean} */
  toggleWhitespace() { return this.setWhitespaceVisible(!this._showWhitespace) }

  // ── P2-45: difference magnitude grading ─────────────────────────────────────

  /** @returns {boolean} */
  isSeverityShaded() { return this._showSeverity }

  /**
   * 依儲存格差異大小為差異上深淺。色相不變——紅仍然只代表「重要差異」，
   * 分級只是在這個語意裡再細分，不新增語意。
   *
   * @param {boolean} on
   * @returns {boolean} the state now in effect
   */
  setSeverityShading(on) {
    this._showSeverity = Boolean(on)
    this._dom.btnSeverity?.classList.toggle('active', this._showSeverity)
    // Presentational only: repaint the window, do not re-align.
    this._windowFirst = null
    this._windowLast = null
    this._renderTableWindow()
    return this._showSeverity
  }

  /** @returns {boolean} */
  toggleSeverityShading() { return this.setSeverityShading(!this._showSeverity) }

  // ── P2-46: thumbnail ────────────────────────────────────────────────────────

  /** @returns {boolean} */
  isThumbnailVisible() { return this._showThumbnail }

  /**
   * @param {boolean} on
   * @returns {boolean} the state now in effect
   */
  setThumbnailVisible(on) {
    this._showThumbnail = Boolean(on)
    this._dom.btnThumb?.classList.toggle('active', this._showThumbnail)
    if (this._dom.thumb) this._dom.thumb.style.display = this._showThumbnail ? '' : 'none'
    this._dom.body?.classList.toggle('with-thumb', this._showThumbnail)
    this._renderThumbnail()
    return this._showThumbnail
  }

  /** @returns {boolean} */
  toggleThumbnail() { return this.setThumbnailVisible(!this._showThumbnail) }

  /** @returns {boolean} */
  isDetailsVisible() { return this._showDetails }

  /**
   * @param {boolean} on
   * @returns {boolean}
   */
  setDetailsVisible(on) {
    this._showDetails = Boolean(on)
    this._applyPanelVisibility()
    return this._showDetails
  }

  /** @returns {boolean} */
  toggleDetails() { return this.setDetailsVisible(!this._showDetails) }

  /** @returns {boolean} */
  isFileInfoVisible() { return this._showFileInfo }

  /**
   * @param {boolean} on
   * @returns {boolean}
   */
  setFileInfoVisible(on) {
    this._showFileInfo = Boolean(on)
    this._applyPanelVisibility()
    return this._showFileInfo
  }

  /** @returns {boolean} */
  toggleFileInfo() { return this.setFileInfoVisible(!this._showFileInfo) }

  // ── S25-T1: Row Numbers（比照 text compare 的 T48） ──────────────────────────

  /** @returns {boolean} */
  isRowNumbersVisible() { return this._showRowNumbers }

  /**
   * @param {boolean} on
   * @returns {boolean} 套用後的狀態
   */
  setRowNumbersVisible(on) {
    this._showRowNumbers = Boolean(on)
    this._applyRowNumbers()
    return this._showRowNumbers
  }

  /** @returns {boolean} */
  toggleRowNumbers() { return this.setRowNumbersVisible(!this._showRowNumbers) }

  /**
   * Hide the row-number column with a class rather than by skipping the cell.
   *
   * Every index-based lookup in this view (cell editing, find highlighting,
   * context menus) assumes `td[0]` is the row number and data starts at `td[1]`.
   * Removing the node would shift all of them by one.
   */
  _applyRowNumbers() {
    this._dom.root?.classList.toggle('tc-hide-row-numbers', !this._showRowNumbers)
    this._dom.btnRowNums?.classList.toggle('active', this._showRowNumbers)
  }

  // ── S25-T2: 顯示字級 ────────────────────────────────────────────────────────

  /** @returns {number} */
  getFontSize() { return this._fontSize }

  /**
   * @param {number} size  px，鉗制於 [10, 24]
   * @returns {number} 套用後的字級
   */
  setFontSize(size) {
    const clamped = clampTableFontSize(size)
    if (clamped === this._fontSize) return this._fontSize
    this._fontSize = clamped
    this._rowHeight = rowHeightForFont(clamped)
    this._applyFontSize()
    // The spacer's height is rowCount × rowHeight, so this is not a repaint of
    // the current window — the whole scroll geometry changed.
    this._renderTable()
    return this._fontSize
  }

  /** @returns {number} */
  increaseFontSize() { return this.setFontSize(this._fontSize + 1) }

  /** @returns {number} */
  decreaseFontSize() { return this.setFontSize(this._fontSize - 1) }

  /** @returns {number} */
  resetFontSize() { return this.setFontSize(DEFAULT_TABLE_FONT_SIZE) }

  _applyFontSize() {
    const root = this._dom.root
    if (!root) return
    root.style.setProperty('--tc-font-size', `${this._fontSize}px`)
    root.style.setProperty('--tc-row-height', `${this._rowHeight}px`)
  }

  // ── S25-T3: Explorer ───────────────────────────────────────────────────────

  /**
   * Reveal one side's file in the OS file manager.
   *
   * @param {'left'|'right'} side
   * @returns {Promise<boolean>}
   */
  async revealInExplorer(side) {
    const path = side === 'left' ? this._leftPath : this._rightPath
    if (!path) {
      this._reportError(`${side === 'left' ? '左' : '右'}側還沒有開啟檔案`)
      return false
    }
    if (!isRealFilePath(path)) {
      this._reportError('這是壓縮檔內容 / 快照 / 遠端檔案，磁碟上沒有對應位置')
      return false
    }
    try {
      await window.electronAPI.showInExplorer(path)
      return true
    } catch (err) {
      this._reportError(`無法顯示檔案位置：${err?.message ?? err}`)
      return false
    }
  }

  // ── S25-T4: Select All + 範圍選取 ──────────────────────────────────────────

  /** @returns {SelectionRange|null} */
  getSelectionRange() {
    return this._selectionRange ? { ...this._selectionRange } : null
  }

  /** 清除範圍選取（單一儲存格的選取不受影響）。 */
  clearSelectionRange() {
    if (!this._selectionRange) return
    this._selectionRange = null
    this._applySelectionHighlight()
  }

  /**
   * BC Edit ▸ Select All：選取該側目前可見的所有列與所有顯示欄。
   *
   * 只記四個數字，不逐列標記 DOM——十萬列的表格若在選取時就替每個儲存格加上
   * class，這個指令本身就會凍住畫面。實際上色只發生在虛擬捲動視窗內。
   *
   * @param {'left'|'right'} [side] 預設沿用目前選取的儲存格所在側
   * @returns {{ rows: number, cols: number }|null} null 代表沒有可選的內容
   */
  selectAll(side) {
    const target = side ?? this._selectedCell?.side ?? 'left'
    const rows = this._visibleRows?.length ?? 0
    const cols = target === 'left' ? (this._leftColCount ?? 0) : (this._rightColCount ?? 0)
    if (rows === 0 || cols === 0) {
      this._reportError('目前沒有可選取的表格內容')
      return null
    }
    this._selectionRange = {
      side: target, top: 0, bottom: rows - 1, leftCol: 0, rightCol: cols - 1,
    }
    this._applySelectionHighlight()
    return { rows, cols }
  }

  /**
   * Shift-click / programmatic range extension from the selected cell.
   *
   * @param {'left'|'right'} side
   * @param {number} visibleRowIdx
   * @param {number} col
   * @returns {boolean}
   */
  extendSelectionTo(side, visibleRowIdx, col) {
    const anchor = this._selectedCell
    if (!anchor || anchor.side !== side) return false
    this._selectionRange = {
      side,
      top: Math.min(anchor.visibleRowIdx, visibleRowIdx),
      bottom: Math.max(anchor.visibleRowIdx, visibleRowIdx),
      leftCol: Math.min(anchor.col, col),
      rightCol: Math.max(anchor.col, col),
    }
    this._applySelectionHighlight()
    return true
  }

  /**
   * The selected range as tab-separated text, read from the parsed model.
   *
   * Reading the DOM instead would return only the rows that happen to be inside
   * the virtual window, and would carry the `·`/`→` whitespace glyphs as data.
   *
   * @returns {string}
   */
  getSelectionText() {
    const range = this._selectionRange
    if (!range) return ''
    const { side, top, bottom, leftCol, rightCol } = range
    const parsed = side === 'left' ? this._leftParsed : this._rightParsed
    const colMap = (side === 'right') ? this._rightColMap : null
    /** @type {string[]} */
    const lines = []
    for (let r = top; r <= bottom; r++) {
      // One row lookup instead of one per cell: a 100k × 20 selection would
      // otherwise do two million Map lookups.
      const located = this._resolveRow(side, r)
      const row = located ? parsed?.[located.parsedRowIdx] : null
      /** @type {string[]} */
      const cells = []
      for (let c = leftCol; c <= rightCol; c++) {
        const sourceCol = colMap ? colMap[c] : c
        cells.push((sourceCol == null || sourceCol < 0) ? '' : (row?.[sourceCol] ?? ''))
      }
      lines.push(cells.join('\t'))
    }
    return lines.join('\n')
  }

  /**
   * Copy the selected range — or, with no range, the selected cell.
   * @returns {Promise<boolean>}
   */
  async copySelection() {
    const text = this._selectionRange
      ? this.getSelectionText()
      : (this._selectedCell
          ? this.getCellValue(
              this._selectedCell.side, this._selectedCell.visibleRowIdx, this._selectedCell.col)
          : null)
    if (text == null) {
      this._reportError('沒有選取任何儲存格')
      return false
    }
    return this._writeClipboard(text)
  }

  // ── S25-T5: 儲存格 Cut / Copy / Paste / Delete ─────────────────────────────

  /**
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async _writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (err) {
      this._reportError(`無法寫入剪貼簿：${err?.message ?? err}`)
      return false
    }
  }

  /**
   * 剪下目前的儲存格：先複製，成功後才清空——複製失敗還照清的話，資料就沒了。
   * @returns {Promise<boolean>}
   */
  async cutCell() {
    const sel = this._selectedCell
    if (!sel) { this._reportError('沒有選取任何儲存格'); return false }
    const value = this.getCellValue(sel.side, sel.visibleRowIdx, sel.col)
    if (value == null) { this._reportError('這個儲存格沒有對應的來源資料'); return false }
    if (!await this._writeClipboard(value)) return false
    return this.deleteCell()
  }

  /**
   * 把剪貼簿內容貼入目前的儲存格。
   * @returns {Promise<boolean>}
   */
  async pasteCell() {
    const sel = this._selectedCell
    if (!sel) { this._reportError('沒有選取任何儲存格'); return false }
    let text
    try {
      text = await navigator.clipboard.readText()
    } catch (err) {
      this._reportError(`無法讀取剪貼簿：${err?.message ?? err}`)
      return false
    }
    if (!this.editCell(sel.side, sel.visibleRowIdx, sel.col, text)) {
      this._reportError('這個儲存格沒有對應的來源資料，無法貼上')
      return false
    }
    return true
  }

  /**
   * 清空選取範圍內的儲存格；沒有範圍時只清目前的儲存格。
   *
   * 整個範圍記成一筆歷史，所以一次 Ctrl+Z 就能全部復原。每一格仍各自帶著
   * 自己的列物件參照，插入列造成的索引位移不會讓復原寫到別的列。
   *
   * @returns {boolean}
   */
  deleteCell() {
    const range = this._selectionRange
    if (!range) {
      const sel = this._selectedCell
      if (!sel) { this._reportError('沒有選取任何儲存格'); return false }
      if (!this.editCell(sel.side, sel.visibleRowIdx, sel.col, '')) {
        this._reportError('這個儲存格沒有對應的來源資料，無法清除')
        return false
      }
      return true
    }

    const { side, top, bottom, leftCol, rightCol } = range
    /** @type {CellEdit[]} */
    const edits = []
    for (let r = top; r <= bottom; r++) {
      for (let c = leftCol; c <= rightCol; c++) {
        const target = this._resolveCell(side, r, c)
        if (!target) continue
        const before = this._readParsedCell(side, target.parsedRowIdx, target.sourceCol)
        if (before === '') continue
        if (!this._writeParsedCell(side, target.parsedRowIdx, target.sourceCol, '')) continue
        edits.push({
          kind: 'cell', side, rowIdx: target.parsedRowIdx, col: target.sourceCol,
          before, after: '', rowRef: target.rowRef,
        })
      }
    }
    if (edits.length === 0) {
      this._reportError('選取範圍內沒有可清除的儲存格')
      return false
    }
    this._pushHistory({ kind: 'batch', side, edits })
    this._afterEdit(side)
    return true
  }

  // ── S25-T6: Next / Previous Edit ───────────────────────────────────────────

  /**
   * 目前可見列之中，哪幾列被編輯過（依可見順序排序）。
   *
   * 來源是 undo 堆疊記下的**列物件**而非列索引：插入列會讓索引位移，用索引
   * 找回來的會是別人的列。
   *
   * @returns {number[]} indices into this._visibleRows
   */
  getEditedRows() {
    /** @type {{ left: Set<string[]>, right: Set<string[]> }} */
    const touched = { left: new Set(), right: new Set() }
    /** @param {EditEntry} entry */
    const collect = (entry) => {
      if (entry.kind === 'batch') { for (const e of entry.edits) collect(e); return }
      if (entry.rowRef) touched[entry.side].add(entry.rowRef)
    }
    for (const entry of this._undoStack) collect(entry)
    for (const entry of this._redoStack) collect(entry)
    if (touched.left.size === 0 && touched.right.size === 0) return []

    /** @type {number[]} */
    const rows = []
    const visible = this._visibleRows ?? []
    for (let i = 0; i < visible.length; i++) {
      const aligned = visible[i]
      const leftRef = aligned.leftIdx != null && aligned.leftIdx >= 0
        ? this._leftData?.[aligned.leftIdx] : null
      const rightRef = aligned.rightIdx != null && aligned.rightIdx >= 0
        ? this._rightData?.[aligned.rightIdx] : null
      if ((leftRef && touched.left.has(leftRef)) || (rightRef && touched.right.has(rightRef))) {
        rows.push(i)
      }
    }
    return rows
  }

  /** @returns {boolean} */
  nextEdit() { return this._stepEdit(1) }

  /** @returns {boolean} */
  prevEdit() { return this._stepEdit(-1) }

  /**
   * @param {1|-1} delta
   * @returns {boolean}
   */
  _stepEdit(delta) {
    const rows = this.getEditedRows()
    if (rows.length === 0) {
      this._reportError('這個 session 還沒有任何編輯過的列')
      return false
    }
    // Re-anchor on the current position rather than on the last visit: filters
    // and re-alignment move rows, so a stored index can point anywhere.
    const from = this._selectedCell?.visibleRowIdx ?? -1
    let idx
    if (delta > 0) {
      idx = rows.findIndex(r => r > from)
      if (idx < 0) idx = 0
    } else {
      idx = -1
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i] < from || from < 0) { idx = i; break }
      }
      if (idx < 0) idx = rows.length - 1
    }
    this._editNavIdx = idx
    const rowIndex = rows[idx]
    this._scrollToVisibleRow(rowIndex)
    this.selectCell(this._selectedCell?.side ?? 'left', rowIndex, this._selectedCell?.col ?? 0)
    this._emit('status', { message: `編輯 ${idx + 1} / ${rows.length}（第 ${rowIndex + 1} 列）` })
    return true
  }

  _applyPanelVisibility() {
    const { detailsPanel, fileInfoPanel, panels, btnDetails, btnFileInfo, btnWhitespace } = this._dom
    if (detailsPanel) detailsPanel.style.display = this._showDetails ? '' : 'none'
    if (fileInfoPanel) fileInfoPanel.style.display = this._showFileInfo ? '' : 'none'
    if (panels) panels.style.display = (this._showDetails || this._showFileInfo) ? '' : 'none'
    btnDetails?.classList.toggle('active', this._showDetails)
    btnFileInfo?.classList.toggle('active', this._showFileInfo)
    btnWhitespace?.classList.toggle('active', this._showWhitespace)
    // The panes just changed height, so the number of rows that fit changed.
    this._windowFirst = null
    this._windowLast = null
    this._renderTableWindow()
    this._updateDetailsPanel()
    this._updateFileInfoPanel()
  }

  /**
   * @returns {{ side: 'left'|'right', visibleRowIdx: number, col: number }|null}
   */
  getSelectedCell() {
    return this._selectedCell ? { ...this._selectedCell } : null
  }

  /**
   * Select a cell and show it in the Text Details panel.
   *
   * @param {'left'|'right'} side
   * @param {number} visibleRowIdx
   * @param {number} col
   * @returns {this}
   */
  selectCell(side, visibleRowIdx, col) {
    this._selectedCell = { side, visibleRowIdx, col }
    // Picking a single cell replaces whatever range was active; leaving the old
    // range painted would make a following Delete act on cells the user can no
    // longer see they selected.
    this._selectionRange = null
    this._applySelectionHighlight()
    this._updateDetailsPanel()
    return this
  }

  /**
   * Re-apply the selection mark after a virtual repaint.
   *
   * The selected row may be outside the current window, in which case there is
   * nothing to mark — the selection itself survives in `_selectedCell`.
   */
  _applySelectionHighlight() {
    for (const side of /** @type {const} */ (['left', 'right'])) {
      const tbody = this._dom[`${side}Tbody`]
      if (!tbody) continue
      for (const td of tbody.querySelectorAll('.tc-cell--selected, .tc-cell--in-range')) {
        td.classList.remove('tc-cell--selected')
        td.classList.remove('tc-cell--in-range')
      }
    }
    const first = this._windowFirst
    const last = this._windowLast
    if (first == null || last == null) return

    // The range may span the whole table; only the rows inside the virtual
    // window exist as DOM, so the loop is bounded by the viewport, not the data.
    const range = this._selectionRange
    if (range) {
      const tbody = this._dom[`${range.side}Tbody`]
      const from = Math.max(range.top, first)
      const to = Math.min(range.bottom, last - 1)
      for (let r = from; r <= to; r++) {
        const tr = tbody?.children[r - first]
        if (!tr) continue
        for (let c = range.leftCol; c <= range.rightCol; c++) {
          // +1 skips the row-number cell.
          tr.children[c + 1]?.classList.add('tc-cell--in-range')
        }
      }
    }

    const sel = this._selectedCell
    if (!sel) return
    if (sel.visibleRowIdx < first || sel.visibleRowIdx >= last) return
    const tbody = this._dom[`${sel.side}Tbody`]
    const tr = tbody?.children[sel.visibleRowIdx - first]
    tr?.children[sel.col + 1]?.classList.add('tc-cell--selected')
  }

  /** Repaint the Text Details panel from the current selection. */
  _updateDetailsPanel() {
    const body = this._dom.detailsBody
    if (!body || !this._showDetails) return
    body.innerHTML = ''

    const sel = this._selectedCell
    if (!sel) {
      body.appendChild(el('div', { className: 'tc-panel-empty' }, '點選任一儲存格以檢視完整內容'))
      return
    }
    const row = this._visibleRows?.[sel.visibleRowIdx]
    if (!row) {
      body.appendChild(el('div', { className: 'tc-panel-empty' }, '選取的列已不在目前的篩選結果中'))
      return
    }

    const header = this._columnNames[sel.col] ?? (this._hasHeader
      ? ((sel.side === 'left' ? this._displayHeaders?.left : this._displayHeaders?.right)?.[sel.col] ?? '')
      : '')
    const leftVal = row.leftRow?.[sel.col] ?? null
    const rightVal = row.rightRow?.[sel.col] ?? null

    body.appendChild(el('div', { className: 'tc-detail-head' },
      `第 ${sel.visibleRowIdx + 1} 列 · 第 ${sel.col} 欄${header ? ` (${header})` : ''}`
      + ` · ${sel.side === 'left' ? '左側' : '右側'}`))

    const grid = el('div', { className: 'tc-detail-grid' })
    /**
     * @param {string} label
     * @param {string|null} value
     */
    const add = (label, value) => {
      grid.appendChild(el('span', { className: 'tc-detail-label' }, label))
      const box = el('span', { className: 'tc-detail-value' })
      if (value == null) {
        box.classList.add('tc-detail-value--na')
        box.textContent = '（此側無此列）'
      } else {
        box.textContent = this._showWhitespace ? visibleWhitespace(value) : value
      }
      grid.appendChild(box)
    }
    add('左側', leftVal)
    add('右側', rightVal)
    add('長度', `左 ${leftVal?.length ?? 0} / 右 ${rightVal?.length ?? 0} 字元`)
    add('比對規則', columnRuleAt(this._effectiveRules(), sel.col).mode)
    body.appendChild(grid)
  }

  /** Repaint the File Info panel. */
  _updateFileInfoPanel() {
    const body = this._dom.fileInfoBody
    if (!body || !this._showFileInfo) return
    body.innerHTML = ''

    for (const side of /** @type {const} */ (['left', 'right'])) {
      const path = side === 'left' ? this._leftPath : this._rightPath
      const content = side === 'left' ? this._leftContent : this._rightContent
      const parsed = side === 'left' ? this._leftParsed : this._rightParsed
      const dataRows = parsed ? Math.max(0, parsed.length - (this._hasHeader ? 1 : 0)) : 0
      const cols = side === 'left' ? (this._leftColCount ?? 0) : (this._rightColCount ?? 0)

      const box = el('div', { className: 'tc-fileinfo-side' })
      box.appendChild(el('div', { className: 'tc-fileinfo-head' }, side === 'left' ? '左側' : '右側'))
      const grid = el('div', { className: 'tc-detail-grid' })
      /**
       * @param {string} label
       * @param {string} value
       */
      const add = (label, value) => {
        grid.appendChild(el('span', { className: 'tc-detail-label' }, label))
        grid.appendChild(el('span', { className: 'tc-detail-value' }, value))
      }
      const stat = path ? this._statCache.get(path) : null
      add('路徑', path ?? '（未選擇）')
      add('大小', stat
        ? formatSize(stat.size)
        : (content != null ? `${content.length} 字元（尚未取得磁碟大小）` : '—'))
      add('修改時間', path ? (stat ? new Date(stat.mtime).toLocaleString() : '讀取中…') : '—')
      add('列數', parsed ? `${dataRows}${this._hasHeader ? '（不含標題）' : ''}` : '—')
      add('欄數', parsed ? String(cols) : '—')
      add('編碼', this._encoding[side] ?? '（未提供）')
      add('分隔符', parsed ? describeDelimiter(this._delimiter[side]) : '—')
      add('未儲存變更', this._modified[side] ? '是' : '否')
      box.appendChild(grid)
      this._dom[`fileInfoGrid_${side}`] = grid
      body.appendChild(box)
    }

    void this._loadFileStats()
  }

  /**
   * Fill `_statCache` from `read-dir` on the containing folders.
   *
   * There is no per-file stat channel; listing the parent folder is the
   * narrowest existing one. Failures are written into the panel rather than
   * swallowed — "unknown" and "permission denied" are different answers.
   *
   * @returns {Promise<void>}
   */
  async _loadFileStats() {
    const statFile = window.electronAPI?.statFile
    if (typeof statFile !== 'function') return
    // `_statAttempted` and not just `_statCache`: a path whose folder cannot be
    // listed never lands in the cache, and repainting the panel calls back into
    // here — without this the pair would loop.
    const wanted = [this._leftPath, this._rightPath]
      .filter((p) => typeof p === 'string' && p && !this._statAttempted.has(p))
    if (wanted.length === 0) return
    for (const path of wanted) this._statAttempted.add(String(path))

    /** @type {string[]} */
    const failures = []
    for (const path of wanted) {
      try {
        const info = await statFile(path)
        if (info) this._statCache.set(String(path), { size: info.size, mtime: info.mtime })
      } catch (err) {
        failures.push(`${path}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (failures.length) this._reportError(`無法讀取檔案資訊 — ${failures.join('；')}`)
    // Values arrived after the panel was painted; repaint with what we have.
    if (this._showFileInfo) this._updateFileInfoPanel()
  }

  /**
   * @param {ColumnRuleSet} rules
   */
  _applyColumnRuleSet(rules) {
    if (!rules) return
    for (const key of Object.keys(rules)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0) continue
      const rule = columnRuleAt(rules, index)
      if (rule.mode !== 'text') this._columnRules[index] = rule
    }
  }

  /** 規則或 key 欄變更後重新比對並重繪（不需重新解析檔案內容） */
  _recompare() {
    this._compare()
    this._renderTable()
  }

  // ── S16-T1: Find ─────────────────────────────────────────────────────────────

  /** 開啟搜尋列並聚焦輸入框 */
  openFind() {
    const { findBar, findInput } = this._dom
    if (!findBar) return
    findBar.style.display = 'flex'
    findInput?.focus()
    findInput?.select()
  }

  /** 關閉搜尋列並清除所有命中標記 */
  closeFind() {
    const { findBar } = this._dom
    if (findBar) findBar.style.display = 'none'
    this._findQuery = ''
    if (this._dom.findInput) this._dom.findInput.value = ''
    this._recomputeFind()
  }

  /** 跳到下一個搜尋命中（環繞） */
  findNext() { this._stepFind(1) }

  /** 跳到上一個搜尋命中（環繞） */
  findPrev() { this._stepFind(-1) }

  // ── P2-43: Go To ─────────────────────────────────────────────────────────────

  /** 開啟「跳至」列並聚焦輸入框 */
  openGoto() {
    const { gotoBar, gotoInput } = this._dom
    if (!gotoBar) return
    gotoBar.style.display = 'flex'
    if (gotoInput) {
      gotoInput.focus()
      gotoInput.select()
    }
  }

  /** 關閉「跳至」列 */
  closeGoto() {
    const { gotoBar, gotoError } = this._dom
    if (gotoBar) gotoBar.style.display = 'none'
    if (gotoError) gotoError.textContent = ''
  }

  /**
   * 跳到第 row 列（1-based，以目前篩選後的可見列為準）、第 col 欄（0-based）。
   *
   * 列號用可見列而不是檔案列：畫面上的列號欄顯示的就是可見列序號，跳到一個
   * 使用者在畫面上看不到的號碼只會讓人以為功能壞了。
   *
   * @param {number} row  1-based
   * @param {number|null} [col]  0-based；null 保留目前欄
   * @returns {boolean}
   */
  gotoRowCol(row, col = null) {
    const rows = this._visibleRows ?? []
    if (!rows.length) {
      this._reportError('目前沒有可跳至的列')
      return false
    }
    if (!Number.isInteger(row) || row < 1 || row > rows.length) {
      this._reportError(`列號必須介於 1 與 ${rows.length} 之間`)
      return false
    }
    const maxCol = Math.max(0, this._displayColCount() - 1)
    if (col != null && (col < 0 || col > maxCol)) {
      this._reportError(`欄號必須介於 0 與 ${maxCol} 之間`)
      return false
    }

    const side = this._selectedCell?.side ?? 'left'
    const targetCol = col ?? this._selectedCell?.col ?? 0
    this._scrollToVisibleRow(row - 1)
    this.selectCell(side, row - 1, targetCol)
    this._scrollColumnIntoView(side, row - 1, targetCol)
    return true
  }

  /**
   * @param {'left'|'right'} side
   * @param {number} visibleRowIdx
   * @param {number} col
   */
  _scrollColumnIntoView(side, visibleRowIdx, col) {
    const first = this._windowFirst
    if (first == null) return
    const tbody = this._dom[`${side}Tbody`]
    const tr = tbody?.children[visibleRowIdx - first]
    // +1 skips the row-number cell.
    const td = tr?.children[col + 1]
    // jsdom has no layout, so scrollIntoView is absent there.
    if (td && typeof td.scrollIntoView === 'function') {
      td.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }

  /** 讀取輸入框並執行跳轉；格式不合法時把原因寫在列上。 */
  _submitGoto() {
    const { gotoInput, gotoError } = this._dom
    const parsed = parseGotoInput(gotoInput?.value)
    if (!parsed) {
      if (gotoError) gotoError.textContent = '格式：列號 或 列號,欄號'
      return
    }
    if (gotoError) gotoError.textContent = ''
    if (this.gotoRowCol(parsed.row, parsed.col)) this.closeGoto()
  }

  // ── S16-T2: Row-level difference navigation ──────────────────────────────────

  /** @returns {number} 目前選取的差異列索引；-1 表示尚未選取 */
  getCurrentDiffIndex() {
    return this._currentDiffIdx
  }

  /** 跳到下一個差異列（是否環繞依 Next Difference 設定）。 @returns {NavResult} */
  nextDifference() { return this._navTo(stepDiffIndex(this._currentDiffIdx, this._diffRows.length, 1)) }

  /** 跳到上一個差異列（是否環繞依 Next Difference 設定）。 @returns {NavResult} */
  prevDifference() { return this._navTo(stepDiffIndex(this._currentDiffIdx, this._diffRows.length, -1)) }

  /** 跳到第一個差異列 @returns {NavResult} */
  firstDifference() { return this._navTo(this._diffRows.length ? 0 : -1) }

  /** 跳到最後一個差異列 @returns {NavResult} */
  lastDifference() { return this._navTo(this._diffRows.length - 1) }

  /**
   * @param {number} target index into _diffRows, -1 when there is none
   * @returns {NavResult}
   */
  _navTo(target) {
    const total = this._diffRows.length
    const from = this._currentDiffIdx
    this._gotoDiff(target)
    return navResult(from, target, total)
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

  // ── T14: Export HTML ─────────────────────────────────────────────────────────

  // ── P1-9: layout mode ────────────────────────────────────────────────────────

  /** @returns {'side-by-side'|'over-under'} */
  getLayoutMode() {
    return this._layoutMode
  }

  /**
   * Toggle between left/right panes and stacked panes.
   * @returns {'side-by-side'|'over-under'} the mode now in effect
   */
  toggleLayout() {
    this._layoutMode = this._layoutMode === 'side-by-side' ? 'over-under' : 'side-by-side'
    this._applyLayout()
    return this._layoutMode
  }

  /**
   * @param {'side-by-side'|'over-under'} mode
   * @returns {'side-by-side'|'over-under'}
   */
  setLayoutMode(mode) {
    if (mode !== 'side-by-side' && mode !== 'over-under') return this._layoutMode
    this._layoutMode = mode
    this._applyLayout()
    return this._layoutMode
  }

  /** Apply the layout mode as a class on .tc-body and refresh the row window. */
  _applyLayout() {
    const body = this._dom.body
    const isOverUnder = this._layoutMode === 'over-under'
    if (body) body.classList.toggle('over-under', isOverUnder)
    const btn = this._dom.btnLayout
    if (btn) {
      btn.textContent = isOverUnder ? '⊟ Over' : '⬛ Side'
      btn.classList.toggle('active', isOverUnder)
    }
    // Each pane is now roughly half as tall, so the virtual scroller's idea of
    // how many rows fit is stale; forcing a rebuild avoids a half-empty pane.
    this._windowFirst = null
    this._windowLast = null
    this._renderTableWindow()
    this._renderThumbnail()
  }

  /**
   * 匯出比對結果為 self-contained HTML 檔案。
   * 呼叫 window.electronAPI.saveFile('table-report.html', html)。
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
      window.alert('無法開啟列印視窗，改為另存 HTML 報告')
    }
    await window.electronAPI.saveFile('table-report.html', html)
  }

  /**
   * Build the self-contained HTML report string.
   * Split out of exportHtml so print preview and disk export share one payload.
   * @returns {string}
   */
  buildHtmlReport() {
    const statusColors = {
      same:        '#ffffff',
      different:   '#fffbe6',
      'left-only': '#e6ffed',
      'right-only':'#ffebe6',
    }

    // The report must show what the panes show, mapping and renames included.
    const nameOf = (/** @type {string[]|null} */ hs, /** @type {number} */ i) =>
      this._columnNames[i] ?? (hs?.[i] ?? '')
    const leftHeaders  = this._hasHeader
      ? (this._displayHeaders?.left ?? []).map((_, i, hs) => nameOf(hs, i)) : null
    const rightHeaders = this._hasHeader
      ? (this._displayHeaders?.right ?? []).map((_, i, hs) => nameOf(hs, i)) : null

    const leftColCount  = this._leftParsed  ? (this._leftParsed[0]?.length  ?? 0) : 0
    const rightColCount = this._rightParsed ? (this._rightParsed[0]?.length ?? 0) : 0
    const colCount = this._leftColMap?.length ?? Math.max(leftColCount, rightColCount)

    /**
     * Build an HTML <tr> string for one side.
     * @param {string[]|null} rowData
     * @param {string} status
     * @param {number} num
     * @param {number} cols
     * @param {boolean[]|null} diffs
     * @param {'left'|'right'} side
     * @returns {string}
     */
    const buildTr = (rowData, status, num, cols, diffs, side) => {
      const isPhantom =
        (side === 'left'  && status === 'right-only') ||
        (side === 'right' && status === 'left-only')

      const bg = statusColors[status] ?? '#ffffff'
      let cells = `<td style="width:2em;text-align:center;background:${bg}">${isPhantom ? '' : String(num)}</td>`

      for (let i = 0; i < cols; i++) {
        const val = isPhantom ? '' : escHtml(rowData?.[i] ?? '')
        const cellBg = (!isPhantom && diffs && diffs[i]) ? '#ffd700' : bg
        cells += `<td style="background:${cellBg};padding:2px 6px">${val}</td>`
      }
      return `<tr>${cells}</tr>`
    }

    const buildHeaderRow = (headers, cols) => {
      if (!headers) return ''
      let cells = '<th style="width:2em">#</th>'
      for (let i = 0; i < cols; i++) {
        cells += `<th style="padding:2px 6px">${escHtml(headers[i] ?? '')}</th>`
      }
      return `<tr>${cells}</tr>`
    }

    let leftTbody  = ''
    let rightTbody = ''
    let rowNum = 1
    for (const alignedRow of this._alignedRows) {
      const { status, leftRow, rightRow } = alignedRow
      const diffs = status === 'different'
        ? this._cellDiffsFor(alignedRow, colCount)
        : null

      leftTbody  += buildTr(leftRow,  status, rowNum, leftColCount,  diffs, 'left')
      rightTbody += buildTr(rightRow, status, rowNum, rightColCount, diffs, 'right')
      rowNum++
    }

    const tableStyle = 'border-collapse:collapse;font-family:monospace;font-size:13px;width:100%'
    const thStyle = 'background:#f0f0f0;border-bottom:2px solid #aaa;padding:2px 6px;text-align:left'

    return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<title>Table Compare Report — ${escHtml(this._leftPath ?? '')} vs ${escHtml(this._rightPath ?? '')}</title>
<style>
  body { margin: 0; padding: 8px; font-family: sans-serif; }
  .tc-wrap { display: flex; gap: 8px; }
  .tc-side { flex: 1; overflow-x: auto; }
  h3 { margin: 4px 0; font-size: 14px; }
  table { ${tableStyle} }
  th { ${thStyle} }
  td { border-bottom: 1px solid #eee; }
  @media print {
    body { padding: 0; margin: 8mm; font-size: 11px; }
    .no-print { display: none !important; }
    .tc-side { overflow-x: visible; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; page-break-after: auto; }
    thead { display: table-header-group; }
  }
</style>
</head>
<body>
<p style="font-size:12px;color:#666">Generated: ${new Date().toISOString()} &nbsp;|&nbsp; Left: ${escHtml(this._leftPath ?? '(none)')} &nbsp;|&nbsp; Right: ${escHtml(this._rightPath ?? '(none)')}</p>
<div class="tc-wrap">
  <div class="tc-side">
    <h3>Left</h3>
    <table>
      <thead>${buildHeaderRow(leftHeaders, leftColCount)}</thead>
      <tbody>${leftTbody}</tbody>
    </table>
  </div>
  <div class="tc-side">
    <h3>Right</h3>
    <table>
      <thead>${buildHeaderRow(rightHeaders, rightColCount)}</thead>
      <tbody>${rightTbody}</tbody>
    </table>
  </div>
</div>
</body>
</html>`
  }

  // ── T22: getStats ─────────────────────────────────────────────────────────────

  /**
   * 回傳比對統計物件（同步）。
   *
   * @typedef {{ compareTime: number|null, total: number, same: number, different: number,
   *             leftOnly: number, rightOnly: number,
   *             columnDiffCounts: Record<string, number> }} TableStats
   * @returns {TableStats}
   */
  getStats() {
    const counts = { same: 0, different: 0, leftOnly: 0, rightOnly: 0 }

    /** @type {Record<string, number>} */
    const columnDiffCounts = {}

    const leftColCount  = this._leftParsed  ? (this._leftParsed[0]?.length  ?? 0) : 0
    const rightColCount = this._rightParsed ? (this._rightParsed[0]?.length ?? 0) : 0
    // Display space: a mapping renumbers the columns the diffs are keyed by.
    const colCount = this._leftColMap?.length ?? Math.max(leftColCount, rightColCount)

    const headers = this._hasHeader
      ? (this._displayHeaders?.left ?? this._leftHeaders ?? [])
      : null

    for (const row of this._alignedRows) {
      switch (row.status) {
        case 'same':       counts.same++;      break
        case 'different':  counts.different++;  break
        case 'left-only':  counts.leftOnly++;   break
        case 'right-only': counts.rightOnly++;  break
      }

      if (row.status === 'different') {
        const diffs = this._cellDiffsFor(row, colCount)
        for (let i = 0; i < diffs.length; i++) {
          if (!diffs[i]) continue
          const colName = this._columnNames[i]
            ?? ((headers && headers[i] != null && headers[i] !== '') ? headers[i] : `col${i}`)
          columnDiffCounts[colName] = (columnDiffCounts[colName] ?? 0) + 1
        }
      }
    }

    return {
      compareTime:     this._lastCompareTime,
      total:           this._alignedRows.length,
      same:            counts.same,
      different:       counts.different,
      leftOnly:        counts.leftOnly,
      rightOnly:       counts.rightOnly,
      columnDiffCounts,
    }
  }

  /**
   * Snapshot of the view's comparison settings, for the named-config store.
   * @returns {object}
   */
  getConfig() {
    return tagConfig('table', {
      hasHeader: this._hasHeader,
      keyColumns: this.getKeyColumns(),
      ignoreColumnOrder: this._ignoreColumnOrder,
      columnRules: JSON.parse(JSON.stringify(this.getColumnRules() ?? {})),
      // Measured widths are data-dependent, so only the on/off state travels;
      // applyConfig re-measures against whatever table is loaded.
      fitColumns: Boolean(this._colWidths.left || this._colWidths.right),
      layoutMode: this._layoutMode,
      hiddenColumns: this.getHiddenColumns(),
      ignoredColumns: this.getIgnoredColumns(),
      showWhitespace: this._showWhitespace,
      showDetails: this._showDetails,
      showFileInfo: this._showFileInfo,
      showSeverity: this._showSeverity,
      showThumbnail: this._showThumbnail,
      showRowNumbers: this._showRowNumbers,
      fontSize: this._fontSize,
      // S27
      columnMapping: this.getColumnMapping(),
      columnNames: this.getColumnDisplayNames(),
      unmatchedIsDiff: this._unmatchedIsDiff,
      showFilter: this.getShowFilter(),
      delimiterOverride: { ...this._delimiterOverride },
      // Only the override travels; the detected encoding belongs to the file
      // that happens to be open, not to the saved settings.
      encodingOverride: { ...this._encodingOverride },
      sessionInfo: this.getSessionInfo(),
    })
  }

  /**
   * @param {unknown} cfg
   */
  applyConfig(cfg) {
    const settings = readConfig('table', cfg)
    if (!settings) return
    if (typeof settings.hasHeader === 'boolean') this._hasHeader = settings.hasHeader
    if (typeof settings.ignoreColumnOrder === 'boolean') {
      this._ignoreColumnOrder = settings.ignoreColumnOrder
    }
    // S27: the mapping renumbers display columns, so it must land before the
    // settings that are keyed by display column (key columns, rules, names).
    if (settings.columnMapping !== undefined) {
      this._columnMapping = normaliseColumnMapping(settings.columnMapping)
    }
    if (typeof settings.unmatchedIsDiff === 'boolean') {
      this._unmatchedIsDiff = settings.unmatchedIsDiff
      this._invalidateRules()
    }
    if (settings.columnNames !== undefined) {
      this._columnNames = {}
      for (const key of Object.keys(settings.columnNames ?? {})) {
        const index = Number(key)
        const text = String(settings.columnNames[key] ?? '').trim()
        if (Number.isInteger(index) && index >= 0 && text) this._columnNames[index] = text
      }
    }
    if (settings.delimiterOverride && typeof settings.delimiterOverride === 'object') {
      for (const side of /** @type {const} */ (['left', 'right'])) {
        const ch = settings.delimiterOverride[side]
        this._delimiterOverride[side] = (typeof ch === 'string' && ch.length === 1) ? ch : null
      }
    }
    if (settings.encodingOverride && typeof settings.encodingOverride === 'object') {
      for (const side of /** @type {const} */ (['left', 'right'])) {
        const enc = settings.encodingOverride[side]
        this._encodingOverride[side] = typeof enc === 'string' && enc ? enc : null
      }
    }
    if (settings.sessionInfo && typeof settings.sessionInfo === 'object') {
      this.setSessionInfo(settings.sessionInfo)
    }
    if (settings.showFilter !== undefined) {
      const mode = settings.showFilter
      this._showSame = mode === 'all' || mode === 'same'
      this._showDiff = mode === 'all' || mode === 'diff'
    }
    if (settings.keyColumns !== undefined) this.setKeyColumns(settings.keyColumns)
    if (settings.columnRules && typeof settings.columnRules === 'object') {
      this.setColumnRules(settings.columnRules)
    }
    if (settings.layoutMode === 'side-by-side' || settings.layoutMode === 'over-under') {
      this._layoutMode = settings.layoutMode
    }
    if (settings.hiddenColumns !== undefined) {
      this._hiddenColumns = new Set(toColumnList(settings.hiddenColumns))
    }
    if (settings.ignoredColumns !== undefined) {
      this._ignoredColumns = new Set(toColumnList(settings.ignoredColumns))
      this._invalidateRules()
    }
    if (typeof settings.showWhitespace === 'boolean') this._showWhitespace = settings.showWhitespace
    if (typeof settings.showDetails === 'boolean') this._showDetails = settings.showDetails
    if (typeof settings.showFileInfo === 'boolean') this._showFileInfo = settings.showFileInfo
    if (typeof settings.showSeverity === 'boolean') this.setSeverityShading(settings.showSeverity)
    if (typeof settings.showThumbnail === 'boolean') this.setThumbnailVisible(settings.showThumbnail)
    if (typeof settings.showRowNumbers === 'boolean') {
      this.setRowNumbersVisible(settings.showRowNumbers)
    }
    if (settings.fontSize !== undefined) {
      // Assigned rather than routed through setFontSize: the refresh() below
      // already rebuilds the table, and setFontSize would render it twice.
      this._fontSize = clampTableFontSize(settings.fontSize)
      this._rowHeight = rowHeightForFont(this._fontSize)
      this._applyFontSize()
    }
    this._applyPanelVisibility()
    this._applyLayout()
    this._syncConfigControls()
    this.refresh()
    if (typeof settings.fitColumns === 'boolean') {
      const fitted = Boolean(this._colWidths.left || this._colWidths.right)
      // resizeColumnsToFit() toggles, so only call it when the states disagree.
      if (fitted !== settings.fitColumns) this.resizeColumnsToFit()
    }
  }

  /** Reflect the applied settings back onto the toolbar controls. */
  _syncConfigControls() {
    const cbHeader = this._dom.cbHeader
    if (cbHeader) cbHeader.checked = this._hasHeader
    const cbColOrder = this._dom.cbColOrder
    if (cbColOrder) cbColOrder.checked = this._ignoreColumnOrder
    this._syncShowFilterUi()
  }

  /**
   * Plain-text report of the differing rows.
   *
   * Lists differences only, and caps the listing: a table that differs
   * throughout would otherwise produce a report larger than the source data.
   *
   * @param {{ generatedAt?: Date, maxRows?: number }} [opts]
   * @returns {string}
   */
  buildTextReport(opts = {}) {
    const maxRows = opts.maxRows ?? 1000
    const stats = this.getStats()
    const header = reportHeader({
      title: '表格比對報告',
      leftPath: this._leftPath,
      rightPath: this._rightPath,
      generatedAt: opts.generatedAt,
    })
    const summary = reportSummary(stats, {
      same: '相同', different: '不同', leftOnly: '僅左側', rightOnly: '僅右側',
    })

    const label = {
      different: '不同', 'left-only': '僅左側', 'right-only': '僅右側',
    }
    const differing = (this._alignedRows ?? []).filter((r) => r.status !== 'same')
    const shown = differing.slice(0, maxRows)
    const join = (row) => (row ?? []).join(' | ')

    const rows = shown.map((r, i) => [
      String(i + 1),
      label[r.status] ?? r.status,
      join(r.leftRow),
      join(r.rightRow),
    ])

    const table = rows.length
      ? renderTextTable(
          [{ title: '#', align: 'right' }, { title: '狀態' },
           { title: '左' }, { title: '右' }],
          rows)
      : '（兩側內容相同）'

    const omitted = differing.length - shown.length
    const note = omitted > 0 ? `\n\n（另有 ${omitted} 列未列出）` : ''
    return `${header}${summary}\n\n${table}${note}\n`
  }

  /** Save the plain-text report. */
  async exportTextReport() {
    await window.electronAPI.saveFile(
      'table-report.txt',
      this.buildTextReport(),
      [{ name: '純文字', extensions: ['txt'] }, { name: '所有檔案', extensions: ['*'] }])
  }

  // ── Private: emit ────────────────────────────────────────────────────────────

  /**
   * @param {string} event
   * @param {unknown} payload
   */
  _emit(event, payload) {
    const handlers = this._handlers[event] ?? []
    for (const h of handlers) {
      try { h(payload) } catch (e) {
        console.error(`TableCompare event "${event}" handler error:`, e)
      }
    }
  }

  // ── Private: Initial render ───────────────────────────────────────────────────

  _render() {
    if (!this._container) return
    this._container.innerHTML = ''

    const root = el('div', { className: 'table-compare' })

    // S15-UX: path row first so "開啟…" sits at the same row as other views.
    root.appendChild(this._buildPathRow())
    root.appendChild(this._buildToolbar())
    root.appendChild(this._buildFindBar())
    root.appendChild(this._buildGotoBar())

    const body = el('div', { className: 'tc-body' })
    this._dom.body = body

    // Left pane
    const leftPane = el('div', { className: 'tc-pane' })
    this._dom.leftHeader = el('div', { className: 'tc-table-header' })
    this._dom.leftScroll = el('div', { className: 'tc-table-scroll' })
    leftPane.appendChild(this._dom.leftHeader)
    leftPane.appendChild(this._dom.leftScroll)
    this._dom.leftPane = leftPane

    // Right pane
    const rightPane = el('div', { className: 'tc-pane' })
    this._dom.rightHeader = el('div', { className: 'tc-table-header' })
    this._dom.rightScroll = el('div', { className: 'tc-table-scroll' })
    rightPane.appendChild(this._dom.rightHeader)
    rightPane.appendChild(this._dom.rightScroll)
    this._dom.rightPane = rightPane

    body.appendChild(leftPane)
    body.appendChild(rightPane)
    body.appendChild(this._buildThumbnail())
    root.appendChild(body)

    // P2-41: Text Details / File Info drawer. A sibling of .tc-body, never
    // inside a scroller, so the virtual row window is unaffected — the panes
    // just get shorter, which the window recomputation already handles.
    root.appendChild(this._buildPanels())

    // Stats bar
    const stats = el('div', { className: 'tc-stats' })
    this._dom.stats = stats
    root.appendChild(stats)

    // Column settings overlay — contents are built on open, because the column
    // list depends on whichever files are loaded at that moment.
    const colPanel = el('div', { className: 'tc-col-panel' })
    colPanel.style.display = 'none'
    this._dom.colPanel = colPanel
    colPanel.addEventListener('click', (e) => {
      if (e.target === colPanel) this.closeColumnSettings()
    })
    root.appendChild(colPanel)

    // S27: column mapping and session settings overlays. Same lifecycle as the
    // column panel — built on open, because both depend on the loaded files.
    for (const [key, className, close] of /** @type {const} */ ([
      ['mapPanel', 'tc-col-panel tc-map-panel', () => this.closeColumnMapping()],
      ['sessionPanel', 'tc-col-panel tc-session-panel', () => this.closeSessionSettings()],
    ])) {
      const panel = el('div', { className })
      panel.style.display = 'none'
      panel.addEventListener('click', (e) => { if (e.target === panel) close() })
      this._dom[key] = panel
      root.appendChild(panel)
    }

    this._container.appendChild(root)
    this._dom.root = root

    this._applyLayout()
    this._renderEmptyState()
    this._applyPanelVisibility()
    this.setThumbnailVisible(this._showThumbnail)
    this._dom.btnSeverity?.classList.toggle('active', this._showSeverity)
    this._applyRowNumbers()
    this._applyFontSize()
  }

  /**
   * 整表差異縮圖：一條與窗格等高的色帶，加上目前視窗的位置指示。
   * @returns {HTMLElement}
   */
  _buildThumbnail() {
    const thumb = el('div', { className: 'tc-thumb', title: '整表差異縮圖（點擊跳至該處）' })
    const strip = el('div', { className: 'tc-thumb-strip' })
    const viewport = el('div', { className: 'tc-thumb-viewport' })
    strip.appendChild(viewport)
    thumb.appendChild(strip)
    thumb.style.display = 'none'
    this._dom.thumb = thumb
    this._dom.thumbStrip = strip
    this._dom.thumbViewport = viewport
    return thumb
  }

  /**
   * 重畫縮圖。
   *
   * 每列一個節點在十萬列的表上就是十萬個節點——縮圖本身會變成比表格更貴的東西。
   * 因此先把列壓成至多 THUMB_MAX_MARKS 個區段再畫。
   */
  _renderThumbnail() {
    const strip = this._dom.thumbStrip
    const viewport = this._dom.thumbViewport
    if (!strip || !viewport) return
    if (!this._showThumbnail) {
      this._thumbBuckets = []
      return
    }

    const rows = this._visibleRows ?? []
    // jsdom reports 0 for every measurement; fall back so the buckets (and the
    // tests that read them) are still meaningful without layout.
    const height = strip.clientHeight || THUMB_FALLBACK_HEIGHT
    const buckets = thumbnailBuckets(rows, Math.min(THUMB_MAX_MARKS, Math.max(1, height)))
    this._thumbBuckets = buckets

    const frag = document.createDocumentFragment()
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i]
      // A "same" band is the background; drawing it would double the node count
      // for no visible difference.
      if (bucket.status === 'same') continue
      const mark = el('div', { className: `tc-thumb-mark ${bucket.status}` })
      mark.style.top = `${(i / buckets.length) * 100}%`
      mark.style.height = `${Math.max(100 / buckets.length, 0.4)}%`
      frag.appendChild(mark)
    }
    strip.replaceChildren(viewport, frag)
    this._updateThumbViewport()
  }

  /** 讓縮圖上的視窗指示對應目前的捲動位置。 */
  _updateThumbViewport() {
    const viewport = this._dom.thumbViewport
    const scroll = this._dom.leftScroll
    if (!viewport || !scroll || !this._showThumbnail) return
    const total = (this._visibleRows?.length ?? 0) * this._rowHeight
    if (total <= 0) {
      viewport.style.top = '0%'
      viewport.style.height = '100%'
      return
    }
    const top = Math.min(100, Math.max(0, (scroll.scrollTop / total) * 100))
    const height = Math.min(100 - top, Math.max(2, ((scroll.clientHeight || 0) / total) * 100))
    viewport.style.top = `${top}%`
    viewport.style.height = `${height}%`
  }

  /**
   * 縮圖上的相對位置 → 捲到對應的列。
   * @param {number} fraction  0..1
   * @returns {number} 跳到的可見列索引；沒有列時 -1
   */
  scrollToThumbFraction(fraction) {
    const rows = this._visibleRows ?? []
    if (!rows.length) return -1
    const f = Math.min(1, Math.max(0, Number(fraction) || 0))
    const target = Math.min(rows.length - 1, Math.floor(f * rows.length))
    this._scrollToVisibleRow(target)
    this._updateThumbViewport()
    return target
  }

  /** @returns {HTMLElement} */
  _buildPanels() {
    const panels = el('div', { className: 'tc-panels' })

    const details = el('div', { className: 'tc-details' })
    details.appendChild(el('div', { className: 'tc-panel-title' }, 'Text Details'))
    const detailsBody = el('div', { className: 'tc-details-body' })
    this._dom.detailsBody = detailsBody
    details.appendChild(detailsBody)
    this._dom.detailsPanel = details

    const info = el('div', { className: 'tc-fileinfo' })
    info.appendChild(el('div', { className: 'tc-panel-title' }, 'File Info'))
    const infoBody = el('div', { className: 'tc-fileinfo-body' })
    this._dom.fileInfoBody = infoBody
    info.appendChild(infoBody)
    this._dom.fileInfoPanel = info

    panels.appendChild(details)
    panels.appendChild(info)
    this._dom.panels = panels
    return panels
  }

  _buildToolbar() {
    const toolbar = el('div', { className: 'tc-toolbar' })

    // hasHeader toggle
    const cbHeader = this._buildCheckbox('tc-has-header', '首行為標題', this._hasHeader)
    this._dom.cbHeader = cbHeader.querySelector('input')
    toolbar.appendChild(cbHeader)

    // Separator
    toolbar.appendChild(el('span', { className: 'tc-toolbar-sep' }))

    // Key column input — comma-separated so composite keys ("0,2") fit the
    // same control that used to take a single index.
    const keyLabel = el('label')
    keyLabel.appendChild(document.createTextNode('Key 欄（-1=無）：'))
    const keyInput = el('input', {
      type: 'text',
      className: 'tc-key-input',
      value: this._keyColumnsText(),
    })
    keyInput.title = '對齊用的 key 欄索引，可用逗號組合多欄（例：0,2）；-1 表示按位置對齊'
    this._dom.keyInput = keyInput
    keyLabel.appendChild(keyInput)
    toolbar.appendChild(keyLabel)

    // Column settings + resize-to-fit
    const btnColumns = el('button', { id: 'tc-btn-columns', className: 'tc-btn' }, '⚙ 欄位設定…')
    this._dom.btnColumns = btnColumns
    toolbar.appendChild(btnColumns)

    // S27: arbitrary N:M column mapping and the multi-tab session settings
    const btnColMap = el('button',
      { id: 'tc-btn-colmap', className: 'tc-btn', title: '設定左右欄位的任意對應關係' }, '⇄ 欄位對應…')
    this._dom.btnColMap = btnColMap
    toolbar.appendChild(btnColMap)

    const btnSession = el('button',
      { id: 'tc-btn-session-settings', className: 'tc-btn', title: 'Session 設定（分隔符 / 編碼 / 說明）' },
      '🛠 Session 設定…')
    this._dom.btnSessionSettings = btnSession
    toolbar.appendChild(btnSession)

    const btnFit = el('button', { id: 'tc-btn-fit', className: 'tc-btn' }, '↔ 自動欄寬')
    btnFit.title = '依內容調整欄寬（再按一次還原）'
    this._dom.btnFit = btnFit
    toolbar.appendChild(btnFit)

    // P2-41: view panels + visible whitespace
    const btnDetails = el('button',
      { id: 'tc-btn-details', className: 'tc-btn', title: '顯示 / 隱藏 Text Details 面板' }, '📄 內容')
    const btnFileInfo = el('button',
      { id: 'tc-btn-fileinfo', className: 'tc-btn', title: '顯示 / 隱藏檔案資訊面板' }, 'ℹ 檔案資訊')
    const btnWhitespace = el('button',
      { id: 'tc-btn-whitespace', className: 'tc-btn', title: '顯示儲存格內的空白與 Tab' }, '␣ 空白')
    this._dom.btnDetails = btnDetails
    this._dom.btnFileInfo = btnFileInfo
    this._dom.btnWhitespace = btnWhitespace
    toolbar.appendChild(btnDetails)
    toolbar.appendChild(btnFileInfo)
    toolbar.appendChild(btnWhitespace)

    // S25-T1 / S25-T2: row numbers and display font size
    const btnRowNums = el('button',
      { id: 'tc-btn-row-numbers', className: 'tc-btn', title: '顯示 / 隱藏列號欄' }, '№ 列號')
    this._dom.btnRowNums = btnRowNums
    toolbar.appendChild(btnRowNums)

    const btnFontSmaller = el('button',
      { id: 'tc-btn-font-smaller', className: 'tc-btn', title: '縮小字級（Ctrl+-）' }, 'A-')
    const btnFontLarger = el('button',
      { id: 'tc-btn-font-larger', className: 'tc-btn', title: '放大字級（Ctrl+=）' }, 'A+')
    const btnFontReset = el('button',
      { id: 'tc-btn-font-reset', className: 'tc-btn', title: '還原預設字級（Ctrl+0）' }, 'A0')
    this._dom.btnFontSmaller = btnFontSmaller
    this._dom.btnFontLarger = btnFontLarger
    this._dom.btnFontReset = btnFontReset
    toolbar.appendChild(btnFontSmaller)
    toolbar.appendChild(btnFontLarger)
    toolbar.appendChild(btnFontReset)

    // Separator
    toolbar.appendChild(el('span', { className: 'tc-toolbar-sep' }))

    // ignoreColumnOrder toggle
    const cbColOrder = this._buildCheckbox('tc-ignore-col-order', '忽略欄位排序', this._ignoreColumnOrder)
    this._dom.cbColOrder = cbColOrder.querySelector('input')
    toolbar.appendChild(cbColOrder)

    // Separator
    toolbar.appendChild(el('span', { className: 'tc-toolbar-sep' }))

    // S27: the four-state Show filter every other view has. The two checkboxes
    // below stay as the pre-existing entry points and are kept in sync.
    for (const [key, id, label, title] of /** @type {const} */ ([
      ['btnShowAll', 'tc-btn-show-all', '全部', '顯示所有列'],
      ['btnShowDiff', 'tc-btn-show-diff', '差異', '只顯示有差異的列'],
      ['btnShowSame', 'tc-btn-show-same', '相同', '只顯示相同的列'],
      ['btnShowNone', 'tc-btn-show-none', '無', '隱藏所有列'],
    ])) {
      const btn = el('button', { id, className: 'tc-btn tc-btn-show', title }, label)
      this._dom[key] = btn
      toolbar.appendChild(btn)
    }

    // Show same rows
    const cbSame = this._buildCheckbox('tc-show-same', '顯示相同行', this._showSame)
    this._dom.cbSame = cbSame.querySelector('input')
    toolbar.appendChild(cbSame)

    // Show diff only
    const cbDiff = this._buildCheckbox('tc-show-diff', '只顯示差異', !this._showSame)
    this._dom.cbDiffOnly = cbDiff.querySelector('input')
    toolbar.appendChild(cbDiff)

    // T15: sort before compare toggle
    toolbar.appendChild(el('span', { className: 'tc-toolbar-sep' }))

    const cbSort = this._buildCheckbox('tc-sort-before-compare', '排序後比對', this._sortBeforeCompare)
    this._dom.cbSort = cbSort.querySelector('input')
    toolbar.appendChild(cbSort)

    // Separator
    toolbar.appendChild(el('span', { className: 'tc-toolbar-sep' }))

    // S16-T2: row-level difference navigation
    const btnPrevDiff = el('button', { id: 'tc-btn-prev-diff', className: 'tc-btn' }, '▲')
    btnPrevDiff.title = '上一個差異列'
    const btnNextDiff = el('button', { id: 'tc-btn-next-diff', className: 'tc-btn' }, '▼')
    btnNextDiff.title = '下一個差異列'
    const diffCount = el('span', { id: 'tc-diff-count', className: 'tc-diff-count' }, '')
    this._dom.btnPrevDiff = btnPrevDiff
    this._dom.btnNextDiff = btnNextDiff
    this._dom.diffCount = diffCount
    toolbar.appendChild(btnPrevDiff)
    toolbar.appendChild(btnNextDiff)
    toolbar.appendChild(diffCount)

    // S16-T3: swap sides
    // P1-9: Side-by-side ↔ Over-under
    const btnLayout = el('button', { id: 'tc-btn-layout', className: 'tc-btn', title: '切換左右並排 / 上下堆疊' }, '⬛ Side')
    this._dom.btnLayout = btnLayout
    toolbar.appendChild(btnLayout)

    const btnSwap = el('button', { id: 'tc-btn-swap', className: 'tc-btn' }, '⇄ 交換')
    this._dom.btnSwap = btnSwap
    toolbar.appendChild(btnSwap)

    // P2-21: cell editing controls
    toolbar.appendChild(el('span', { className: 'tc-toolbar-sep' }))

    const btnUndo = el('button', { id: 'tc-btn-undo', className: 'tc-btn', title: '還原儲存格編輯（Ctrl+Z）' }, '↶')
    const btnRedo = el('button', { id: 'tc-btn-redo', className: 'tc-btn', title: '重做儲存格編輯（Ctrl+Y）' }, '↷')
    btnUndo.disabled = true
    btnRedo.disabled = true
    this._dom.btnUndo = btnUndo
    this._dom.btnRedo = btnRedo
    toolbar.appendChild(btnUndo)
    toolbar.appendChild(btnRedo)

    // S25-T6: navigate between the rows this session has edited
    const btnPrevEdit = el('button',
      { id: 'tc-btn-prev-edit', className: 'tc-btn', title: '上一處編輯過的列' }, '✎▲')
    const btnNextEdit = el('button',
      { id: 'tc-btn-next-edit', className: 'tc-btn', title: '下一處編輯過的列' }, '✎▼')
    btnPrevEdit.disabled = true
    btnNextEdit.disabled = true
    this._dom.btnPrevEdit = btnPrevEdit
    this._dom.btnNextEdit = btnNextEdit
    toolbar.appendChild(btnPrevEdit)
    toolbar.appendChild(btnNextEdit)

    // S25-T4: Select All
    const btnSelectAll = el('button',
      { id: 'tc-btn-select-all', className: 'tc-btn', title: '全選這一側的表格內容（Ctrl+A）' }, '⬚ 全選')
    this._dom.btnSelectAll = btnSelectAll
    toolbar.appendChild(btnSelectAll)

    // P2-44: row-level edit commands
    const btnCopyRight = el('button',
      { id: 'tc-btn-copy-right', className: 'tc-btn', title: '把目前的列複製到右側（Alt+→）' }, '⇥ 複製到右')
    const btnCopyLeft = el('button',
      { id: 'tc-btn-copy-left', className: 'tc-btn', title: '把目前的列複製到左側（Alt+←）' }, '⇤ 複製到左')
    const btnInsertRow = el('button',
      { id: 'tc-btn-insert-row', className: 'tc-btn', title: '在目前的列下方插入空白列（Ctrl+I）' }, '➕ 插入列')
    this._dom.btnCopyRight = btnCopyRight
    this._dom.btnCopyLeft = btnCopyLeft
    this._dom.btnInsertRow = btnInsertRow
    toolbar.appendChild(btnCopyRight)
    toolbar.appendChild(btnCopyLeft)
    toolbar.appendChild(btnInsertRow)

    // P2-43 / P2-45 / P2-46
    toolbar.appendChild(el('span', { className: 'tc-toolbar-sep' }))

    const btnGoto = el('button',
      { id: 'tc-btn-goto', className: 'tc-btn', title: '跳至指定的列 / 欄（Ctrl+G）' }, '⤓ 跳至')
    const btnSeverity = el('button',
      { id: 'tc-btn-severity', className: 'tc-btn', title: '依差異大小為儲存格深淺分級' }, '🌡 差異程度')
    const btnThumb = el('button',
      { id: 'tc-btn-thumb', className: 'tc-btn', title: '顯示 / 隱藏整表差異縮圖' }, '🗺 縮圖')
    this._dom.btnGoto = btnGoto
    this._dom.btnSeverity = btnSeverity
    this._dom.btnThumb = btnThumb
    toolbar.appendChild(btnGoto)
    toolbar.appendChild(btnSeverity)
    toolbar.appendChild(btnThumb)

    toolbar.appendChild(el('span', { className: 'tc-toolbar-sep' }))

    const btnSaveLeft = el('button',
      { id: 'tc-btn-save-left', className: 'tc-btn', title: '儲存左側（Ctrl+S）' }, '💾 左')
    const btnSaveRight = el('button',
      { id: 'tc-btn-save-right', className: 'tc-btn', title: '儲存右側（Ctrl+Shift+S）' }, '💾 右')
    this._dom.btnSaveLeft = btnSaveLeft
    this._dom.btnSaveRight = btnSaveRight
    toolbar.appendChild(btnSaveLeft)
    toolbar.appendChild(btnSaveRight)

    // Refresh button
    const btnRefresh = el('button', { className: 'tc-btn tc-btn-refresh' }, '↺ 重新整理')
    this._dom.btnRefresh = btnRefresh
    toolbar.appendChild(btnRefresh)

    // S27: BC's Recompare Files — re-runs the comparison *and* starts the edit
    // history over, which 「重新整理」 deliberately does not.
    const btnRecompare = el('button',
      { id: 'tc-btn-recompare', className: 'tc-btn', title: '重新比對並清除復原歷程' }, '⟲ 重新比對')
    this._dom.btnRecompare = btnRecompare
    toolbar.appendChild(btnRecompare)

    // T14: Export HTML button
    const btnExport = el('button', { id: 'tc-btn-export', className: 'tc-btn' }, '⬇ 匯出 HTML')
    this._dom.btnExport = btnExport
    toolbar.appendChild(btnExport)

    // T22: Export stats button
    // P2-27: printing goes through the browser's own print dialog, so the HTML
    // report doubles as the print layout rather than needing a second renderer.
    const btnPrint = el('button', { id: 'tc-btn-print', className: 'tc-btn', title: '列印 / 匯出 PDF' }, '🖨 列印')
    this._dom.btnPrint = btnPrint
    toolbar.appendChild(btnPrint)

    const btnExportStats = el('button', { id: 'tc-btn-export-stats', className: 'tc-btn' }, '📋 統計')
    this._dom.btnExportStats = btnExportStats
    toolbar.appendChild(btnExportStats)

    return toolbar
  }

  /**
   * S16-T1: 搜尋列（預設隱藏，Ctrl+F 開啟）
   * @returns {HTMLElement}
   */
  _buildFindBar() {
    const bar = el('div', { className: 'tc-find-bar' })
    bar.style.display = 'none'

    const input = el('input', {
      type: 'text',
      id: 'tc-find-input',
      className: 'tc-find-input',
      placeholder: '搜尋儲存格內容…',
    })
    this._dom.findInput = input
    bar.appendChild(input)

    const cbCase = this._buildCheckbox('tc-find-case', 'Aa', this._findCaseSensitive)
    cbCase.title = '大小寫敏感'
    this._dom.cbFindCase = cbCase.querySelector('input')
    bar.appendChild(cbCase)

    const btnPrev = el('button', { id: 'tc-find-prev', className: 'tc-find-btn' }, '◀')
    const btnNext = el('button', { id: 'tc-find-next', className: 'tc-find-btn' }, '▶')
    this._dom.btnFindPrev = btnPrev
    this._dom.btnFindNext = btnNext
    bar.appendChild(btnPrev)
    bar.appendChild(btnNext)

    const count = el('span', { id: 'tc-find-count', className: 'tc-find-count' }, '')
    this._dom.findCount = count
    bar.appendChild(count)

    const btnClose = el('button', { id: 'tc-find-close', className: 'tc-find-btn' }, '✕')
    this._dom.btnFindClose = btnClose
    bar.appendChild(btnClose)

    this._dom.findBar = bar
    return bar
  }

  /**
   * P2-43: 「跳至」列（預設隱藏，Ctrl+G 開啟）
   * @returns {HTMLElement}
   */
  _buildGotoBar() {
    const bar = el('div', { className: 'tc-find-bar tc-goto-bar' })
    bar.style.display = 'none'

    bar.appendChild(el('span', { className: 'tc-goto-label' }, '跳至列 / 欄：'))

    const input = el('input', {
      type: 'text',
      id: 'tc-goto-input',
      className: 'tc-find-input tc-goto-input',
      placeholder: '例：120 或 120,3',
    })
    input.title = '輸入列號，或「列號,欄號」；列號以目前篩選後的顯示列為準'
    this._dom.gotoInput = input
    bar.appendChild(input)

    const btnGo = el('button', { id: 'tc-goto-go', className: 'tc-find-btn' }, '前往')
    this._dom.btnGotoGo = btnGo
    bar.appendChild(btnGo)

    const err = el('span', { id: 'tc-goto-error', className: 'tc-goto-error' }, '')
    this._dom.gotoError = err
    bar.appendChild(err)

    const btnClose = el('button', { id: 'tc-goto-close', className: 'tc-find-btn' }, '✕')
    this._dom.btnGotoClose = btnClose
    bar.appendChild(btnClose)

    this._dom.gotoBar = bar
    return bar
  }

  /**
   * @param {string} id
   * @param {string} labelText
   * @param {boolean} checked
   * @returns {HTMLLabelElement}
   */
  _buildCheckbox(id, labelText, checked) {
    const cb = el('input', { type: 'checkbox', id })
    cb.checked = checked
    const lbl = el('label')
    lbl.appendChild(cb)
    lbl.appendChild(document.createTextNode(' ' + labelText))
    return lbl
  }

  /** @returns {string} */
  _keyColumnsText() {
    return this._keyColumns.length ? this._keyColumns.join(',') : '-1'
  }

  _syncKeyInput() {
    if (this._dom.keyInput) this._dom.keyInput.value = this._keyColumnsText()
  }

  /** @returns {number} 顯示欄數：有欄位對應時為對應表長度，否則兩側欄數的最大值 */
  _totalColumnCount() {
    if (this._leftColMap) return this._leftColMap.length
    return Math.max(
      this._leftParsed?.[0]?.length ?? 0,
      this._rightParsed?.[0]?.length ?? 0,
    )
  }

  /**
   * 產生欄位設定面板的內容。每次開啟都重建，因為欄數與標題會隨載入的檔案改變。
   */
  _buildColumnPanel() {
    const panel = this._dom.colPanel
    if (!panel) return
    panel.innerHTML = ''

    const box = el('div', { className: 'tc-col-panel-box' })
    box.appendChild(el('h3', { className: 'tc-col-panel-title' }, '欄位設定'))

    const colCount = this._totalColumnCount()
    const headers = this._hasHeader
      ? (this._displayHeaders?.left ?? this._displayHeaders?.right ?? null)
      : null

    const list = el('div', { className: 'tc-col-panel-list' })
    if (colCount === 0) {
      list.appendChild(el('div', { className: 'tc-col-panel-empty' }, '尚未載入資料'))
    }

    for (let i = 0; i < colCount; i++) {
      list.appendChild(this._buildColumnPanelRow(i, headers?.[i] ?? ''))
    }
    box.appendChild(list)

    const footer = el('div', { className: 'tc-col-panel-footer' })
    const btnReset = el('button', { className: 'tc-btn' }, '全部還原')
    btnReset.addEventListener('click', () => {
      this.setColumnRules(null)
      this._buildColumnPanel()
    })
    const btnClose = el('button', { className: 'tc-btn' }, '關閉')
    btnClose.addEventListener('click', () => this.closeColumnSettings())
    footer.appendChild(btnReset)
    footer.appendChild(btnClose)
    box.appendChild(footer)

    panel.appendChild(box)
  }

  /**
   * @param {number} index
   * @param {string} headerName
   * @returns {HTMLElement}
   */
  _buildColumnPanelRow(index, headerName) {
    const rule = columnRuleAt(this._columnRules, index)
    const row = el('div', { className: 'tc-col-row' })

    row.appendChild(el('span', { className: 'tc-col-name' },
      headerName ? `${index} · ${headerName}` : `第 ${index} 欄`))

    const keyBox = el('input', { type: 'checkbox', className: 'tc-col-key' })
    keyBox.checked = this._keyColumns.includes(index)
    const keyLabel = el('label', { className: 'tc-col-key-label' })
    keyLabel.appendChild(keyBox)
    keyLabel.appendChild(document.createTextNode(' Key'))
    row.appendChild(keyLabel)

    // P2-41: per-column show / exclude. "顯示" only hides the column; "排除"
    // additionally takes it out of the comparison, so a row that differs only
    // in an excluded column counts as identical.
    const showBox = el('input', { type: 'checkbox', className: 'tc-col-show' })
    showBox.checked = !this._hiddenColumns.has(index)
    const showLabel = el('label', { className: 'tc-col-key-label', title: '在兩側表格中顯示此欄' })
    showLabel.appendChild(showBox)
    showLabel.appendChild(document.createTextNode(' 顯示'))
    row.appendChild(showLabel)

    const skipBox = el('input', { type: 'checkbox', className: 'tc-col-skip' })
    skipBox.checked = this._ignoredColumns.has(index)
    const skipLabel = el('label',
      { className: 'tc-col-key-label', title: '完全排除：不參與比對，也不顯示' })
    skipLabel.appendChild(skipBox)
    skipLabel.appendChild(document.createTextNode(' 排除'))
    row.appendChild(skipLabel)

    showBox.addEventListener('change', () => this.setColumnHidden(index, !showBox.checked))
    skipBox.addEventListener('change', () => {
      this.setColumnIgnored(index, skipBox.checked)
      // Excluding overrides "顯示", so reflect that rather than leaving a
      // ticked box next to an invisible column.
      showBox.disabled = skipBox.checked
    })
    showBox.disabled = skipBox.checked

    const modeSel = el('select', { className: 'tc-col-mode' })
    for (const [value, label] of [
      ['text', '文字'], ['numeric', '數值'], ['date', '日期'], ['ignore', '忽略'],
    ]) {
      const opt = el('option', { value }, label)
      modeSel.appendChild(opt)
    }
    modeSel.value = rule.mode
    row.appendChild(modeSel)

    const tolInput = el('input', {
      type: 'number', step: 'any', min: '0', className: 'tc-col-tol', value: String(rule.tolerance),
    })
    const unit = el('span', { className: 'tc-col-tol-unit' }, rule.mode === 'date' ? '秒' : '')
    const syncTolState = () => {
      const usesTolerance = modeSel.value === 'numeric' || modeSel.value === 'date'
      tolInput.disabled = !usesTolerance
      unit.textContent = modeSel.value === 'date' ? '秒' : ''
    }
    syncTolState()
    row.appendChild(tolInput)
    row.appendChild(unit)

    const apply = () => {
      syncTolState()
      const mode = /** @type {ColumnMode} */ (modeSel.value)
      this.setColumnRule(index, { mode, tolerance: Number(tolInput.value) || 0 })
    }
    modeSel.addEventListener('change', apply)
    tolInput.addEventListener('change', apply)

    keyBox.addEventListener('change', () => {
      const next = keyBox.checked
        ? [...this._keyColumns, index]
        : this._keyColumns.filter((c) => c !== index)
      this.setKeyColumns(next)
    })

    // S27: display-only rename. Left last so the row still reads
    // "which column · how it compares", with the label as an aside.
    const nameInput = el('input', {
      type: 'text', className: 'tc-col-rename',
      value: this._columnNames[index] ?? '',
      placeholder: '顯示名稱',
    })
    nameInput.title = '只改標題列顯示的字，不影響比對讀到的資料'
    nameInput.addEventListener('change', () => this.setColumnDisplayName(index, nameInput.value))
    row.appendChild(nameInput)

    return row
  }

  // ── S27: column mapping dialog ──────────────────────────────────────────────

  /**
   * @typedef {{ left: number, right: number, name: string }} ColumnPairDraft
   */

  /**
   * 開啟欄位對應對話框。編輯的是工作副本，按「套用」才會改變比對結果。
   * @returns {this}
   */
  openColumnMapping() {
    if (!this._dom.mapPanel) return this
    const current = this.getColumnMapping()
      ?? identityColumnMapping(
        this._leftParsed?.[0]?.length ?? 0,
        this._rightParsed?.[0]?.length ?? 0)
    // The name rides on the pair rather than on the display index so that
    // moving or deleting a column carries its label with it.
    this._mapDraft = current.map((p, i) => ({
      left: p.left, right: p.right, name: this._columnNames[i] ?? '',
    }))
    this._buildColumnMapPanel()
    this._dom.mapPanel.style.display = 'flex'
    return this
  }

  /** @returns {this} */
  closeColumnMapping() {
    if (this._dom.mapPanel) this._dom.mapPanel.style.display = 'none'
    this._mapDraft = null
    return this
  }

  /**
   * 套用對話框中的對應與顯示名稱。
   * @returns {this}
   */
  applyColumnMappingDraft() {
    const draft = /** @type {ColumnPairDraft[]} */ (this._mapDraft ?? [])
    /** @type {Record<number, string>} */
    const names = {}
    draft.forEach((p, i) => { if (p.name) names[i] = p.name })
    this.setColumnMapping(draft.map((p) => ({ left: p.left, right: p.right })))
    this.setColumnDisplayNames(names)
    this.closeColumnMapping()
    return this
  }

  /** 產生欄位對應對話框的內容。每次變更都重建，欄數不大且狀態只有一份。 */
  _buildColumnMapPanel() {
    const panel = this._dom.mapPanel
    if (!panel) return
    panel.innerHTML = ''

    const draft = /** @type {ColumnPairDraft[]} */ (this._mapDraft ?? [])
    const leftCount = this._leftParsed?.[0]?.length ?? 0
    const rightCount = this._rightParsed?.[0]?.length ?? 0
    const leftHeaders = this._hasHeader ? this._leftHeaders : null
    const rightHeaders = this._hasHeader ? this._rightHeaders : null

    const box = el('div', { className: 'tc-col-panel-box tc-map-box' })
    box.appendChild(el('h3', { className: 'tc-col-panel-title' }, '欄位對應'))
    box.appendChild(el('p', { className: 'tc-map-hint' },
      '左右欄位可任意對應。設為「（無）」的一側代表這一欄只有另一側有，'
      + '會以單側獨有的樣式顯示，而不是靜靜消失。'))

    const list = el('div', { className: 'tc-col-panel-list tc-map-list' })
    if (draft.length === 0) {
      list.appendChild(el('div', { className: 'tc-col-panel-empty' }, '尚未載入資料'))
    }

    /**
     * @param {'left'|'right'} side
     * @param {number} value
     * @param {number} count
     * @param {string[]|null} headers
     * @param {number} rowIdx
     * @returns {HTMLSelectElement}
     */
    const buildSideSelect = (side, value, count, headers, rowIdx) => {
      const sel = el('select', { className: `tc-map-select tc-map-${side}` })
      const none = el('option', { value: String(NO_COLUMN) }, '（無）')
      sel.appendChild(none)
      for (let c = 0; c < count; c++) {
        const label = headers?.[c] ? `${c} · ${headers[c]}` : `第 ${c} 欄`
        sel.appendChild(el('option', { value: String(c) }, label))
      }
      sel.value = String(value >= 0 && value < count ? value : NO_COLUMN)
      sel.addEventListener('change', () => {
        const next = Number(sel.value)
        const pair = draft[rowIdx]
        const other = side === 'left' ? pair.right : pair.left
        if (next < 0 && other < 0) {
          // Both sides "none" would be a column that reads from nothing.
          this._reportError('左右不能同時設為「（無）」；請改用「移除」')
          this._buildColumnMapPanel()
          return
        }
        if (side === 'left') pair.left = next
        else pair.right = next
        this._buildColumnMapPanel()
      })
      return sel
    }

    draft.forEach((pair, i) => {
      const row = el('div', { className: 'tc-col-row tc-map-row' })
      row.appendChild(el('span', { className: 'tc-col-name' }, `#${i}`))
      row.appendChild(buildSideSelect('left', pair.left, leftCount, leftHeaders, i))
      row.appendChild(el('span', { className: 'tc-map-arrow' }, '↔'))
      row.appendChild(buildSideSelect('right', pair.right, rightCount, rightHeaders, i))

      const nameInput = el('input', {
        type: 'text', className: 'tc-map-name', value: pair.name,
        placeholder: '顯示名稱（可留空）',
      })
      nameInput.addEventListener('input', () => { pair.name = nameInput.value })
      row.appendChild(nameInput)

      const move = (/** @type {number} */ delta) => {
        const to = i + delta
        if (to < 0 || to >= draft.length) return
        const [moved] = draft.splice(i, 1)
        draft.splice(to, 0, moved)
        this._buildColumnMapPanel()
      }
      const btnUp = el('button', { className: 'tc-btn tc-map-move', title: '上移' }, '▲')
      const btnDown = el('button', { className: 'tc-btn tc-map-move', title: '下移' }, '▼')
      const btnDel = el('button', { className: 'tc-btn tc-map-del', title: '移除這個顯示欄' }, '✕')
      btnUp.disabled = i === 0
      btnDown.disabled = i === draft.length - 1
      btnUp.addEventListener('click', () => move(-1))
      btnDown.addEventListener('click', () => move(1))
      btnDel.addEventListener('click', () => {
        draft.splice(i, 1)
        this._buildColumnMapPanel()
      })
      row.appendChild(btnUp)
      row.appendChild(btnDown)
      row.appendChild(btnDel)
      list.appendChild(row)
    })
    box.appendChild(list)

    const cbUnmatched = this._buildCheckbox(
      'tc-map-unmatched', '單側獨有的欄位計入差異', this._unmatchedIsDiff)
    const cbUnmatchedInput = /** @type {HTMLInputElement|null} */ (cbUnmatched.querySelector('input'))
    cbUnmatched.title = '關閉後，只有一側有的欄位會被當成「忽略」，不會讓整張表都變成差異'
    cbUnmatchedInput?.addEventListener('change', () => {
      this.setUnmatchedCountedAsDiff(cbUnmatchedInput.checked)
    })
    box.appendChild(cbUnmatched)

    const footer = el('div', { className: 'tc-col-panel-footer' })

    const btnAdd = el('button', { id: 'tc-map-add', className: 'tc-btn' }, '＋ 新增欄')
    btnAdd.addEventListener('click', () => {
      draft.push({ left: leftCount ? 0 : NO_COLUMN, right: rightCount ? 0 : NO_COLUMN, name: '' })
      this._buildColumnMapPanel()
    })

    const btnSuggest = el('button',
      { id: 'tc-map-suggest', className: 'tc-btn', title: '依標題名稱比對出一份建議' }, '✨ 自動建議')
    btnSuggest.addEventListener('click', () => {
      this._mapDraft = this.suggestColumnMapping().map((p) => ({ ...p, name: '' }))
      this._buildColumnMapPanel()
    })

    const btnReset = el('button', { id: 'tc-map-reset', className: 'tc-btn' }, '↺ 重設為 1:1')
    btnReset.addEventListener('click', () => {
      this._mapDraft = identityColumnMapping(leftCount, rightCount)
        .map((p) => ({ ...p, name: '' }))
      this._buildColumnMapPanel()
    })

    const btnApply = el('button', { id: 'tc-map-apply', className: 'tc-btn' }, '套用')
    btnApply.addEventListener('click', () => this.applyColumnMappingDraft())

    const btnClose = el('button', { id: 'tc-map-close', className: 'tc-btn' }, '關閉')
    btnClose.addEventListener('click', () => this.closeColumnMapping())

    for (const b of [btnAdd, btnSuggest, btnReset, btnApply, btnClose]) footer.appendChild(b)
    box.appendChild(footer)
    panel.appendChild(box)
  }

  // ── S27: Session Settings dialog（Type / Conversion / Specs）─────────────────

  /**
   * @param {'type'|'conversion'|'specs'} [tab]
   * @returns {this}
   */
  openSessionSettings(tab = 'type') {
    if (!this._dom.sessionPanel) return this
    this._sessionTab = tab
    this._buildSessionPanel()
    this._dom.sessionPanel.style.display = 'flex'
    return this
  }

  /** @returns {this} */
  closeSessionSettings() {
    if (this._dom.sessionPanel) this._dom.sessionPanel.style.display = 'none'
    return this
  }

  /** 產生 Session 設定對話框（分頁式）。 */
  _buildSessionPanel() {
    const panel = this._dom.sessionPanel
    if (!panel) return
    panel.innerHTML = ''

    const active = this._sessionTab ?? 'type'
    const box = el('div', { className: 'tc-col-panel-box tc-session-box' })
    box.appendChild(el('h3', { className: 'tc-col-panel-title' }, 'Session 設定'))

    const tabs = el('div', { className: 'tc-session-tabs' })
    for (const [key, label] of /** @type {const} */ ([
      ['type', 'Type（格式）'],
      ['conversion', 'Conversion（編碼）'],
      ['specs', 'Specs（說明）'],
    ])) {
      const btn = el('button',
        { id: `tc-session-tab-${key}`, className: `tc-btn tc-session-tab${active === key ? ' active' : ''}` },
        label)
      btn.addEventListener('click', () => {
        this._sessionTab = key
        this._buildSessionPanel()
      })
      tabs.appendChild(btn)
    }
    box.appendChild(tabs)

    const body = el('div', { className: 'tc-session-body' })
    if (active === 'type') this._buildSessionTypeTab(body)
    else if (active === 'conversion') this._buildSessionConversionTab(body)
    else this._buildSessionSpecsTab(body)
    box.appendChild(body)

    const footer = el('div', { className: 'tc-col-panel-footer' })
    const btnClose = el('button', { id: 'tc-session-close', className: 'tc-btn' }, '關閉')
    btnClose.addEventListener('click', () => this.closeSessionSettings())
    footer.appendChild(btnClose)
    box.appendChild(footer)

    panel.appendChild(box)
  }

  /**
   * Type：手動指定分隔符，覆寫「看第一行有沒有 Tab」的自動偵測。
   * @param {HTMLElement} body
   */
  _buildSessionTypeTab(body) {
    for (const side of /** @type {const} */ (['left', 'right'])) {
      const label = side === 'left' ? '左側' : '右側'
      const row = el('div', { className: 'tc-session-row' })
      row.appendChild(el('span', { className: 'tc-session-label' }, `${label}分隔符`))

      const current = this._delimiterOverride[side]
      const preset = DELIMITER_PRESETS.find((p) => p.char === current)
      const sel = el('select', { id: `tc-session-delim-${side}`, className: 'tc-session-select' })
      for (const p of DELIMITER_PRESETS) {
        sel.appendChild(el('option', { value: p.value }, p.label))
      }
      sel.value = current == null ? 'auto' : (preset?.value ?? 'custom')

      const custom = el('input', {
        type: 'text', id: `tc-session-delim-custom-${side}`, className: 'tc-session-custom',
        maxLength: 1, value: (current != null && !preset) ? current : '',
        placeholder: '單一字元',
      })
      custom.style.display = sel.value === 'custom' ? '' : 'none'

      const applyDelimiter = () => {
        if (sel.value === 'auto') { this.setDelimiterOverride(side, null); return }
        if (sel.value === 'custom') {
          if (custom.value.length !== 1) return
          this.setDelimiterOverride(side, custom.value)
          return
        }
        this.setDelimiterOverride(side, DELIMITER_PRESETS.find((p) => p.value === sel.value)?.char ?? null)
      }
      sel.addEventListener('change', () => {
        custom.style.display = sel.value === 'custom' ? '' : 'none'
        applyDelimiter()
      })
      custom.addEventListener('change', applyDelimiter)

      row.appendChild(sel)
      row.appendChild(custom)
      row.appendChild(el('span', { className: 'tc-session-note' },
        `目前實際使用：${describeDelimiter(this._delimiter[side])}`))
      body.appendChild(row)
    }
    body.appendChild(el('p', { className: 'tc-map-hint' },
      '更改分隔符會重新解析該側的內容；未儲存的儲存格修改會先詢問。'))
  }

  /**
   * Conversion：手動指定編碼，並以該編碼重讀檔案。
   * @param {HTMLElement} body
   */
  _buildSessionConversionTab(body) {
    for (const side of /** @type {const} */ (['left', 'right'])) {
      const label = side === 'left' ? '左側' : '右側'
      const row = el('div', { className: 'tc-session-row' })
      row.appendChild(el('span', { className: 'tc-session-label' }, `${label}編碼`))

      const sel = el('select', { id: `tc-session-enc-${side}`, className: 'tc-session-select' })
      sel.appendChild(el('option', { value: '' }, '自動偵測'))
      for (const enc of TABLE_ENCODINGS) sel.appendChild(el('option', { value: enc }, enc))
      sel.value = this._encodingOverride[side] ?? ''
      sel.addEventListener('change', () => {
        void this.setEncodingOverride(side, sel.value || null).then((ok) => {
          // A rejected change must not leave the control claiming it applied.
          if (!ok) sel.value = this._encodingOverride[side] ?? ''
          this._buildSessionPanel()
        })
      })
      row.appendChild(sel)
      row.appendChild(el('span', { className: 'tc-session-note' },
        `目前解碼結果：${this._encoding[side] ?? '（未知）'}`))
      body.appendChild(row)
    }
    body.appendChild(el('p', { className: 'tc-map-hint' },
      '存檔會以同一個編碼寫回，不會把非 UTF-8 的檔案改寫成 UTF-8。'))
  }

  /**
   * Specs：session 的名稱與說明。只做紀錄，不影響比對。
   * @param {HTMLElement} body
   */
  _buildSessionSpecsTab(body) {
    const nameRow = el('div', { className: 'tc-session-row' })
    nameRow.appendChild(el('span', { className: 'tc-session-label' }, '名稱'))
    const nameInput = el('input', {
      type: 'text', id: 'tc-session-name', className: 'tc-session-text',
      value: this._sessionInfo.name, placeholder: '這個比對的名稱',
    })
    nameInput.addEventListener('input', () => this.setSessionInfo({ name: nameInput.value }))
    nameRow.appendChild(nameInput)
    body.appendChild(nameRow)

    const descRow = el('div', { className: 'tc-session-row tc-session-row--tall' })
    descRow.appendChild(el('span', { className: 'tc-session-label' }, '說明'))
    const desc = el('textarea', {
      id: 'tc-session-description', className: 'tc-session-textarea',
      placeholder: '這個比對在做什麼、資料從哪裡來、有哪些已知的差異…',
    })
    desc.value = this._sessionInfo.description
    desc.addEventListener('input', () => this.setSessionInfo({ description: desc.value }))
    descRow.appendChild(desc)
    body.appendChild(descRow)

    body.appendChild(el('p', { className: 'tc-map-hint' },
      '說明會顯示在狀態列，並隨 Session 設定一起儲存。'))
  }

  _buildPathRow() {
    const row = el('div', { className: 'tc-path-row' })

    // Left
    const leftCell = el('div', { className: 'tc-path-cell' })
    const btnLeft = el('button', { className: 'tc-open-btn' }, '開啟檔案…')
    const dispLeft = el('span', { className: 'tc-path-display' }, this._leftPath ?? '（未選擇）')
    // P2-33: only shown once a source actually has more than one sheet/table.
    const selLeft = el('select', { className: 'tc-source-select', title: '選擇工作表 / 表格' })
    selLeft.style.display = 'none'
    this._dom.btnOpenLeft = btnLeft
    this._dom.dispLeft = dispLeft
    this._dom.selLeft = selLeft
    // S25-T3: BC's File ▸ Explorer, per side — the path it acts on is the one
    // shown right next to it, so there is nothing to guess.
    const btnExpLeft = el('button',
      { id: 'tc-btn-explorer-left', className: 'tc-open-btn', title: '在檔案總管中顯示左側檔案' }, '📁')
    this._dom.btnExplorerLeft = btnExpLeft
    leftCell.appendChild(btnLeft)
    leftCell.appendChild(dispLeft)
    leftCell.appendChild(selLeft)
    leftCell.appendChild(btnExpLeft)

    // Right
    const rightCell = el('div', { className: 'tc-path-cell' })
    const btnRight = el('button', { className: 'tc-open-btn' }, '開啟檔案…')
    const dispRight = el('span', { className: 'tc-path-display' }, this._rightPath ?? '（未選擇）')
    const selRight = el('select', { className: 'tc-source-select', title: '選擇工作表 / 表格' })
    selRight.style.display = 'none'
    this._dom.btnOpenRight = btnRight
    this._dom.dispRight = dispRight
    this._dom.selRight = selRight
    const btnExpRight = el('button',
      { id: 'tc-btn-explorer-right', className: 'tc-open-btn', title: '在檔案總管中顯示右側檔案' }, '📁')
    this._dom.btnExplorerRight = btnExpRight
    rightCell.appendChild(btnRight)
    rightCell.appendChild(dispRight)
    rightCell.appendChild(selRight)
    rightCell.appendChild(btnExpRight)

    row.appendChild(leftCell)
    row.appendChild(rightCell)
    return row
  }

  // ── Private: Event binding ────────────────────────────────────────────────────

  _bindEvents() {
    const { btnOpenLeft, btnOpenRight, btnRefresh,
            cbHeader, cbSame, cbDiffOnly, cbColOrder, keyInput,
            btnExport, btnExportStats, cbSort, btnColumns, btnFit } = this._dom

    btnOpenLeft.addEventListener('click', () => this.openLeft())
    btnOpenRight.addEventListener('click', () => this.openRight())
    btnRefresh.addEventListener('click', () => this.refresh())

    // T14: export HTML
    btnExport.addEventListener('click', () => void this.exportHtml())

    // P2-27 / P1-9
    this._dom.btnPrint.addEventListener('click', () => void this.exportHtml({ print: true }))
    this._dom.btnLayout.addEventListener('click', () => this.toggleLayout())

    // T22: show stats
    btnExportStats.addEventListener('click', () => this._showStatsAlert())

    // T15: sort before compare
    cbSort.addEventListener('change', () => {
      this._sortBeforeCompare = cbSort.checked
      this._parseAndRefresh()
    })

    cbHeader.addEventListener('change', () => {
      this._hasHeader = cbHeader.checked
      this._parseAndRefresh()
    })

    // Both checkboxes are entry points into the same four-state filter, so they
    // route through it rather than each poking at _showSame on its own.
    cbSame.addEventListener('change', () => {
      this.setShowFilter(cbSame.checked ? 'all' : 'diff')
    })

    cbDiffOnly.addEventListener('change', () => {
      this.setShowFilter(cbDiffOnly.checked ? 'diff' : 'all')
    })

    cbColOrder.addEventListener('change', () => {
      this._ignoreColumnOrder = cbColOrder.checked
      this._parseAndRefresh()
    })

    keyInput.addEventListener('change', () => {
      this.setKeyColumns(keyInput.value.split(','))
    })

    btnColumns.addEventListener('click', () => this.openColumnSettings())
    btnFit.addEventListener('click', () => this.resizeColumnsToFit())

    // S27
    this._dom.btnColMap.addEventListener('click', () => this.openColumnMapping())
    this._dom.btnSessionSettings.addEventListener('click', () => this.openSessionSettings())
    this._dom.btnRecompare.addEventListener('click', () => this.recompareFiles())
    this._dom.btnShowAll.addEventListener('click', () => this.setShowFilter('all'))
    this._dom.btnShowDiff.addEventListener('click', () => this.setShowFilter('diff'))
    this._dom.btnShowSame.addEventListener('click', () => this.setShowFilter('same'))
    this._dom.btnShowNone.addEventListener('click', () => this.setShowFilter('none'))
    this._syncShowFilterUi()

    // Sync scroll between left and right panes, and repaint the virtual window.
    const { leftScroll, rightScroll } = this._dom
    const repaint = _rafThrottle(() => {
      this._renderTableWindow()
      this._updateThumbViewport()
    })
    let syncingScroll = false
    leftScroll.addEventListener('scroll', () => {
      if (syncingScroll) return
      syncingScroll = true
      rightScroll.scrollTop = leftScroll.scrollTop
      syncingScroll = false
      repaint()
    })
    rightScroll.addEventListener('scroll', () => {
      if (syncingScroll) return
      syncingScroll = true
      leftScroll.scrollTop = rightScroll.scrollTop
      syncingScroll = false
      repaint()
    })

    // Context menu
    leftScroll.addEventListener('contextmenu',  (e) => this._onTableContextMenu(e, 'left'))
    rightScroll.addEventListener('contextmenu', (e) => this._onTableContextMenu(e, 'right'))

    // P2-21: double-click a cell to edit it
    leftScroll.addEventListener('dblclick',  (e) => this._onCellDblClick(e, 'left'))
    rightScroll.addEventListener('dblclick', (e) => this._onCellDblClick(e, 'right'))

    // P2-41: single click selects the cell shown in the Text Details panel.
    leftScroll.addEventListener('click',  (e) => this._onCellClick(e, 'left'))
    rightScroll.addEventListener('click', (e) => this._onCellClick(e, 'right'))

    const { btnDetails, btnFileInfo, btnWhitespace } = this._dom
    btnDetails.addEventListener('click', () => this.toggleDetails())
    btnFileInfo.addEventListener('click', () => this.toggleFileInfo())
    btnWhitespace.addEventListener('click', () => this.toggleWhitespace())

    // S25: row numbers / font size / select all / edit navigation / explorer
    this._dom.btnRowNums.addEventListener('click', () => this.toggleRowNumbers())
    this._dom.btnFontSmaller.addEventListener('click', () => this.decreaseFontSize())
    this._dom.btnFontLarger.addEventListener('click', () => this.increaseFontSize())
    this._dom.btnFontReset.addEventListener('click', () => this.resetFontSize())
    this._dom.btnSelectAll.addEventListener('click', () => this.selectAll())
    this._dom.btnPrevEdit.addEventListener('click', () => this.prevEdit())
    this._dom.btnNextEdit.addEventListener('click', () => this.nextEdit())
    this._dom.btnExplorerLeft.addEventListener('click', () => void this.revealInExplorer('left'))
    this._dom.btnExplorerRight.addEventListener('click', () => void this.revealInExplorer('right'))

    this._dom.btnUndo.addEventListener('click', () => this.undo())
    this._dom.btnRedo.addEventListener('click', () => this.redo())
    this._dom.btnSaveLeft.addEventListener('click', () => void this.saveLeft())
    this._dom.btnSaveRight.addEventListener('click', () => void this.saveRight())

    // P2-43 / P2-44 / P2-45 / P2-46
    this._dom.btnCopyRight.addEventListener('click', () => this.copyRowToRight())
    this._dom.btnCopyLeft.addEventListener('click', () => this.copyRowToLeft())
    this._dom.btnInsertRow.addEventListener('click', () => {
      this.insertRow(this._selectedCell?.side ?? 'left')
    })
    this._dom.btnGoto.addEventListener('click', () => this.openGoto())
    this._dom.btnSeverity.addEventListener('click', () => this.toggleSeverityShading())
    this._dom.btnThumb.addEventListener('click', () => this.toggleThumbnail())

    this._dom.btnGotoGo.addEventListener('click', () => this._submitGoto())
    this._dom.btnGotoClose.addEventListener('click', () => this.closeGoto())
    this._dom.gotoInput.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._submitGoto() }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeGoto() }
    })

    this._dom.thumbStrip.addEventListener('click', (/** @type {MouseEvent} */ e) => {
      const rect = this._dom.thumbStrip.getBoundingClientRect()
      if (!rect.height) return
      this.scrollToThumbFraction((e.clientY - rect.top) / rect.height)
    })

    // P2-33: sheet / table pickers
    this._dom.selLeft.addEventListener('change', () => {
      this.selectSourcePart('left', this._dom.selLeft.value)
    })
    this._dom.selRight.addEventListener('change', () => {
      this.selectSourcePart('right', this._dom.selRight.value)
    })

    // Closing the window with unsaved cell edits must not discard them silently.
    this._beforeUnload = (/** @type {BeforeUnloadEvent} */ e) => {
      if (!this.hasUnsavedChanges()) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', this._beforeUnload)

    this._setupDropTargets()
    this._bindNavEvents()
  }

  // ── Private: Drag & drop ─────────────────────────────────────────────────────

  /**
   * Accept table files dropped onto either pane.
   *
   * The pane that took the drop chooses the side, so one file can be replaced
   * without disturbing the other; dropping two at once fills both.
   */
  _setupDropTargets() {
    /** @type {Array<[HTMLElement, 'left'|'right']>} */
    const targets = [
      [this._dom.leftPane, 'left'],
      [this._dom.rightPane, 'right'],
    ].filter(([node]) => Boolean(node))

    /** @type {Array<() => void>} */
    const cleanups = []

    for (const [node, side] of targets) {
      const onOver = (/** @type {DragEvent} */ e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        node.classList.add('tc-drop-target')
      }
      const onLeave = () => node.classList.remove('tc-drop-target')
      const onDrop = (/** @type {DragEvent} */ e) => {
        e.preventDefault()
        e.stopPropagation()
        node.classList.remove('tc-drop-target')
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
   * Report a failure where the user will actually see it.
   *
   * The host wires a 'status' listener; without one the message would vanish,
   * so a toast is the fallback rather than a console line. Not an alert: a
   * modal dialog raised from a drop handler blocks the renderer.
   *
   * @param {string} message
   */
  _reportError(message) {
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
      this._reportError(`無法接受拖放的檔案：${err instanceof Error ? err.message : String(err)}`)
      return
    }

    if (!entries?.length) {
      // preload resolves a path only for a File the OS really handed over.
      this._reportError('無法取得拖放檔案的路徑')
      return
    }

    const usable = entries.filter((entry) => entry && !entry.isDirectory)
    if (!usable.length) {
      this._reportError('請拖放檔案，而非資料夾')
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
    const lower = path.toLowerCase()
    try {
      if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        await this._openExcel(side, path)
        return
      }
      const result = await window.electronAPI.readFile(path)
      if (!result) return
      if ((result.content?.length ?? 0) > MAX_TABLE_CHARS) {
        this._reportError(`${path} 超過大小上限（${MAX_TABLE_CHARS} 字元），未載入`)
        return
      }
      if (lower.endsWith('.html') || lower.endsWith('.htm')) {
        this._openHtmlContent(side, result.path ?? path, result.content)
        return
      }
      if (side === 'left') this.setLeft(result.path, result.content)
      else this.setRight(result.path, result.content)
    } catch (err) {
      this._reportError(`載入 ${path} 失敗：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** S16: find bar, difference navigation and swap wiring */
  _bindNavEvents() {
    const { btnPrevDiff, btnNextDiff, btnSwap,
            findInput, cbFindCase, btnFindPrev, btnFindNext, btnFindClose } = this._dom

    btnPrevDiff.addEventListener('click', () => this.prevDifference())
    btnNextDiff.addEventListener('click', () => this.nextDifference())
    btnSwap.addEventListener('click', () => this.swap())

    findInput.addEventListener('input', () => {
      this._findQuery = findInput.value
      this._recomputeFind()
    })
    findInput.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this._stepFind(e.shiftKey ? -1 : 1)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.closeFind()
      }
    })
    cbFindCase.addEventListener('change', () => {
      this._findCaseSensitive = cbFindCase.checked
      this._recomputeFind()
    })
    btnFindPrev.addEventListener('click', () => this.findPrev())
    btnFindNext.addEventListener('click', () => this.findNext())
    btnFindClose.addEventListener('click', () => this.closeFind())

    this._keyHandler = (/** @type {KeyboardEvent} */ e) => {
      if (!this._container || !isActive('table')) return

      // P2-21: while a cell editor or the find box has focus, these belong to
      // the input (native undo, text entry) rather than to the table.
      const target = e.target instanceof HTMLElement ? e.target : null
      const inInput = Boolean(this._editing) ||
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if ((e.ctrlKey || e.metaKey) && !inInput) {
        const key = e.key.toLowerCase()
        if (key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); return }
        if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); return }
        if (key === 's') {
          e.preventDefault()
          void (e.shiftKey ? this.saveRight() : this.saveLeft())
          return
        }
        if (key === 'g') { e.preventDefault(); this.openGoto(); return }
        if (key === 'i') {
          e.preventDefault()
          this.insertRow(this._selectedCell?.side ?? 'left')
          return
        }
        // S25: Select All / clipboard / font size
        if (key === 'a') { e.preventDefault(); this.selectAll(); return }
        if (key === 'c') { e.preventDefault(); void this.copySelection(); return }
        if (key === 'x') { e.preventDefault(); void this.cutCell(); return }
        if (key === 'v') { e.preventDefault(); void this.pasteCell(); return }
        if (key === '=' || key === '+') { e.preventDefault(); this.increaseFontSize(); return }
        if (key === '-') { e.preventDefault(); this.decreaseFontSize(); return }
        if (key === '0') { e.preventDefault(); this.resetFontSize(); return }
      }

      // Delete clears the selection; no modifier, so it must not fire while an
      // input has focus, which the inInput guard above already establishes.
      if (e.key === 'Delete' && !inInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (this._selectionRange || this._selectedCell) {
          e.preventDefault()
          this.deleteCell()
          return
        }
      }

      // Alt+←/→ mirrors text compare's Copy Block Left / Right.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !inInput) {
        if (e.key === 'ArrowRight') { e.preventDefault(); this.copyRowToRight(); return }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); this.copyRowToLeft(); return }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        this.openFind()
      } else if (e.key === 'F3') {
        e.preventDefault()
        this._stepFind(e.shiftKey ? -1 : 1)
      } else if (e.key === 'Escape' && this._dom.colPanel?.style.display === 'flex') {
        e.preventDefault()
        this.closeColumnSettings()
      }
    }
    document.addEventListener('keydown', this._keyHandler)
  }

  /**
   * @param {MouseEvent} e
   * @param {'left'|'right'} side
   */
  _onTableContextMenu(e, side) {
    const target = e.target instanceof Element ? e.target : null
    const td = target?.closest('td.tc-cell')
    const tr = target?.closest('tr.tc-row')
    if (!tr) return

    const items = []

    if (td) {
      const cellText = td.textContent ?? ''
      items.push({
        label: '複製儲存格',
        action: () => navigator.clipboard.writeText(cellText)
      })
      if (!tr.classList.contains('phantom')) {
        const tbody = this._dom[`${side}Tbody`]
        const rowOffset = tbody ? [...tbody.children].indexOf(tr) : -1
        if (rowOffset >= 0) {
          const visibleRowIdx = (this._windowFirst ?? 0) + rowOffset
          const col = [...tr.children].indexOf(td) - 1
          items.push({
            label: '編輯儲存格…',
            action: () => this._beginCellEdit(side, visibleRowIdx, col, td),
          })
          // S25-T5: the clipboard commands act on the cell under the cursor, so
          // select it first — otherwise they would silently target whatever was
          // selected before the right-click.
          items.push({
            label: '剪下儲存格',
            action: () => { this.selectCell(side, visibleRowIdx, col); void this.cutCell() },
          })
          items.push({
            label: '貼上到儲存格',
            action: () => { this.selectCell(side, visibleRowIdx, col); void this.pasteCell() },
          })
          items.push({
            label: '清除儲存格',
            action: () => { this.selectCell(side, visibleRowIdx, col); this.deleteCell() },
          })
        }
      }
    }

    // S25-T4: Select All + copy the range
    items.push({ separator: true })
    items.push({
      label: side === 'left' ? '全選（左側）' : '全選（右側）',
      action: () => this.selectAll(side),
    })
    items.push({
      label: '複製選取範圍',
      disabled: !this._selectionRange && !this._selectedCell,
      action: () => { void this.copySelection() },
    })

    items.push({
      label: '複製整列（CSV）',
      action: () => {
        const cells = [...tr.querySelectorAll('td.tc-cell')]
        const csv = cells.map(c => {
          const v = c.textContent ?? ''
          return (v.includes(',') || v.includes('"') || v.includes('\n'))
            ? `"${v.replace(/"/g, '""')}"`
            : v
        }).join(',')
        navigator.clipboard.writeText(csv)
      }
    })

    // P2-43 / P2-44: row-level commands act on the row under the cursor, which
    // is more precise than the toolbar's "current row".
    const tbodyForRow = this._dom[`${side}Tbody`]
    const offset = tbodyForRow ? [...tbodyForRow.children].indexOf(tr) : -1
    if (offset >= 0) {
      const visibleRowIdx = (this._windowFirst ?? 0) + offset
      items.push({ separator: true })
      items.push({
        label: side === 'left' ? '複製整列到右側' : '複製整列到左側',
        action: () => this.copyRowToOtherSide(side, visibleRowIdx),
      })
      items.push({
        label: `在此列上方插入空白列（${side === 'left' ? '左' : '右'}側）`,
        action: () => this.insertRow(side, visibleRowIdx, 'above'),
      })
      items.push({
        label: `在此列下方插入空白列（${side === 'left' ? '左' : '右'}側）`,
        action: () => this.insertRow(side, visibleRowIdx, 'below'),
      })
      items.push({ label: '跳至列 / 欄…', action: () => this.openGoto() })
    }

    // S25-T6 / S25-T1 / S25-T3
    const hasEdits = this._undoStack.length > 0 || this._redoStack.length > 0
    items.push({ separator: true })
    items.push({ label: '上一處編輯', disabled: !hasEdits, action: () => this.prevEdit() })
    items.push({ label: '下一處編輯', disabled: !hasEdits, action: () => this.nextEdit() })
    items.push({
      label: this._showRowNumbers ? '隱藏列號' : '顯示列號',
      action: () => this.toggleRowNumbers(),
    })

    // S27: the mapping / settings / recompare entry points, reachable without
    // hunting along the toolbar.
    items.push({ separator: true })
    items.push({ label: '欄位對應…', action: () => this.openColumnMapping() })
    if (td) {
      const col = [...(tr.children ?? [])].indexOf(td) - 1
      if (col >= 0) {
        items.push({
          label: '重新命名這一欄（顯示用）…',
          action: () => {
            const current = this._columnNames[col]
              ?? (this._displayHeaders?.[side]?.[col] ?? '')
            const next = window.prompt(`第 ${col} 欄的顯示名稱`, current)
            if (next != null) this.setColumnDisplayName(col, next)
          },
        })
      }
    }
    items.push({ label: 'Session 設定…', action: () => this.openSessionSettings() })
    items.push({ label: '重新比對（清除復原歷程）', action: () => { this.recompareFiles() } })

    const sidePath = side === 'left' ? this._leftPath : this._rightPath
    items.push({ separator: true })
    items.push({
      label: '在檔案總管中顯示',
      disabled: !isRealFilePath(sidePath),
      action: () => { void this.revealInExplorer(side) },
    })

    const rowNum = tr.querySelector('.tc-row-num')?.textContent?.trim() ?? ''
    if (rowNum) {
      items.push({
        label: `複製整列（Tab 分隔）`,
        action: () => {
          const cells = [...tr.querySelectorAll('td.tc-cell')]
          const tsv = cells.map(c => c.textContent ?? '').join('\t')
          navigator.clipboard.writeText(tsv)
        }
      })
    }

    showContextMenu(e, items)
  }

  // ── Private: Find & difference navigation ─────────────────────────────────────

  /**
   * 依目前的 query 重算命中清單、計數與標記。
   * 每次資料、篩選或搜尋條件變動後都必須呼叫，因為命中以 _visibleRows 的
   * 索引表示，而該索引在重新比對或篩選後即失效。
   */
  _recomputeFind() {
    const rows = this._visibleRows ?? []
    this._findMatches = findCellMatches(rows, this._findQuery, this._findCaseSensitive)

    this._findMatchMap = new Map()
    for (const m of this._findMatches) {
      const list = this._findMatchMap.get(m.rowIndex)
      if (list) list.push(m)
      else this._findMatchMap.set(m.rowIndex, [m])
    }

    this._findCurrentIdx = this._findMatches.length ? 0 : -1
    this._updateFindCount()
    if (this._findCurrentIdx >= 0) {
      this._scrollToVisibleRow(this._findMatches[0].rowIndex)
    } else {
      this._applyFindHighlights()
    }
  }

  /**
   * @param {number} delta
   */
  _stepFind(delta) {
    const next = stepIndexWrapped(this._findCurrentIdx, this._findMatches.length, delta)
    if (next < 0) return
    this._findCurrentIdx = next
    this._updateFindCount()
    this._scrollToVisibleRow(this._findMatches[next].rowIndex)
  }

  _updateFindCount() {
    const countEl = this._dom.findCount
    if (!countEl) return
    if (!this._findQuery) countEl.textContent = ''
    else if (!this._findMatches.length) countEl.textContent = '無相符'
    else countEl.textContent = `第 ${this._findCurrentIdx + 1} / ${this._findMatches.length} 筆`
  }

  /**
   * 為目前虛擬視窗內的命中儲存格加上標記。
   *
   * 標記無法在搜尋當下一次寫入 DOM——視窗外的列根本不存在——所以每次重繪
   * 視窗後都要依索引重新套用。
   */
  _applyFindHighlights() {
    const first = this._windowFirst
    const last = this._windowLast
    if (first == null || last == null) return

    // The window may be reused verbatim between steps (the current match moved
    // but stayed on screen), so previous marks have to be cleared explicitly.
    for (const side of ['left', 'right']) {
      const tbody = this._dom[`${side}Tbody`]
      if (!tbody) continue
      for (const td of tbody.querySelectorAll('.tc-cell--match')) {
        td.classList.remove('tc-cell--match', 'tc-cell--match-current')
      }
    }

    const current = this._findCurrentIdx >= 0 ? this._findMatches[this._findCurrentIdx] : null

    for (let i = first; i < last; i++) {
      const matches = this._findMatchMap.get(i)
      if (!matches) continue
      for (const m of matches) {
        const tbody = this._dom[`${m.side}Tbody`]
        const tr = tbody?.children[i - first]
        // +1 skips the row-number cell.
        const td = tr?.children[m.col + 1]
        if (!td) continue
        td.classList.add('tc-cell--match')
        if (current && current.rowIndex === i && current.side === m.side && current.col === m.col) {
          td.classList.add('tc-cell--match-current')
        }
      }
    }
  }

  /**
   * 捲動到某個可見列（虛擬捲動下必須先移動 scrollTop 再重繪視窗，
   * 否則目標列不在 DOM 中）。
   * @param {number} rowIndex  index into this._visibleRows
   */
  _scrollToVisibleRow(rowIndex) {
    const { leftScroll, rightScroll } = this._dom
    if (!leftScroll) return
    const viewport = leftScroll.clientHeight || 0
    const target = Math.max(0, rowIndex * this._rowHeight - Math.floor(viewport / 2))
    leftScroll.scrollTop = target
    if (rightScroll) rightScroll.scrollTop = target
    this._renderTableWindow()
    // _renderTableWindow short-circuits when the window is unchanged; the
    // current-match mark still needs moving in that case.
    this._applyFindHighlights()
  }

  /**
   * @param {number} idx  index into this._diffRows
   */
  _gotoDiff(idx) {
    if (idx < 0 || idx >= this._diffRows.length) return
    this._currentDiffIdx = idx
    this._updateDiffCount()
    this._scrollToVisibleRow(this._diffRows[idx])
  }

  _updateDiffCount() {
    const countEl = this._dom.diffCount
    if (!countEl) return
    countEl.textContent = this._diffRows.length
      ? `第 ${this._currentDiffIdx + 1} / ${this._diffRows.length} 個差異`
      : '無差異'
  }

  // ── Private: Parse & Compare ──────────────────────────────────────────────────

  _parseAndRefresh() {
    if (this._leftContent != null) {
      // A manual delimiter overrides detection, which only ever looks at the
      // first line and so guesses wrong on files whose header has no separator.
      this._delimiter.left = this._delimiterOverride.left ?? detectDelimiter(this._leftContent)
      this._leftParsed = parseTable(this._leftContent, this._delimiter.left)
      this._rowIndexMap.left = _buildRowIndexMap(this._leftParsed)
    }
    if (this._rightContent != null) {
      this._delimiter.right = this._delimiterOverride.right ?? detectDelimiter(this._rightContent)
      this._rightParsed = parseTable(this._rightContent, this._delimiter.right)
      this._rowIndexMap.right = _buildRowIndexMap(this._rightParsed)
    }
    this._compare()
    this._renderTable()
    this._consumePendingFirstDiff()
  }

  /**
   * BC's "when loading new files, go to first difference". Flag-gated so that
   * a filter or option change — which also re-renders — leaves the user where
   * they were.
   */
  _consumePendingFirstDiff() {
    if (!this._pendingFirstDiff) return
    this._pendingFirstDiff = false
    if (!this._diffRows.length) return
    if (!getNavOptions().firstDiffOnLoad) return
    this._gotoDiff(0)
  }

  _compare() {
    const leftParsed = this._leftParsed
    const rightParsed = this._rightParsed

    if (!leftParsed && !rightParsed) {
      this._alignedRows = []
      this._leftData = null
      this._rightData = null
      this._leftColMap = null
      this._rightColMap = null
      this._displayHeaders = { left: null, right: null }
      this._refreshRowIndex()
      return
    }

    // T22: record compare timestamp
    this._lastCompareTime = Date.now()

    const leftAll = leftParsed ?? []
    const rightAll = rightParsed ?? []

    let leftHeaders = null
    let rightHeaders = null
    let leftData = leftAll
    let rightData = rightAll

    if (this._hasHeader) {
      leftHeaders = leftAll[0] ?? []
      rightHeaders = rightAll[0] ?? []
      leftData = leftAll.slice(1)
      rightData = rightAll.slice(1)
    }

    this._leftHeaders = leftHeaders
    this._rightHeaders = rightHeaders

    // S27: resolve the column mapping first — every index below (key columns,
    // per-column rules, sort keys) is a *display* column, and the mapping is
    // what says which source column that is.
    //
    // "忽略欄位排序" is itself just the mapping derived from header names, so it
    // is expressed as one and both features share a single comparison path.
    /** @type {ColumnPair[]|null} */
    let mapping = this._columnMapping
    if (!mapping && this._ignoreColumnOrder && leftHeaders && rightHeaders) {
      mapping = leftHeaders.map((h, i) => ({ left: i, right: rightHeaders.indexOf(h) }))
    }
    const sides = mapping ? columnMapSides(mapping) : null
    this._leftColMap = sides ? sides.left : null
    this._rightColMap = sides ? sides.right : null
    // Which columns are one-sided is part of the rule set, so the set memoised
    // under the previous mapping cannot be reused.
    this._invalidateRules()

    // T15: sort before compare — sort each side by the key columns (or col 0
    // when aligning by position), using the same canonical form as alignment so
    // numeric/date columns group consistently.
    const rules = this._effectiveRules()
    if (this._sortBeforeCompare) {
      const sortCols = this._keyColumns.length ? this._keyColumns : [0]
      leftData = sortByDisplayKey(leftData, this._leftColMap, sortCols, rules)
      rightData = sortByDisplayKey(rightData, this._rightColMap, sortCols, rules)
    }

    // AlignedRow.leftIdx/rightIdx index these arrays, and their elements are the
    // very row objects held by _leftParsed/_rightParsed (slice and sort preserve
    // identity), which is what makes an edit reach the model.
    this._leftData = leftData
    this._rightData = rightData

    // The comparison runs on display-space rows, so an N:M mapping is not a
    // display trick: alignment, row status and cell diffs all see the paired
    // columns. Projection preserves position, so leftIdx still indexes leftData.
    const leftView = this._leftColMap
      ? leftData.map((row) => projectRow(row, this._leftColMap))
      : leftData
    const rightView = this._rightColMap
      ? rightData.map((row) => projectRow(row, this._rightColMap))
      : rightData

    this._displayHeaders = {
      left: leftHeaders && this._leftColMap ? projectRow(leftHeaders, this._leftColMap) : leftHeaders,
      right: rightHeaders && this._rightColMap ? projectRow(rightHeaders, this._rightColMap) : rightHeaders,
    }

    this._alignedRows = alignRows(
      leftView,
      rightView,
      this._keyColumns,
      null,
      null,
      false,
      rules,
    )
    this._refreshRowIndex()
  }

  /**
   * 重建「可見列」與「差異列索引」。導航座標系與虛擬捲動座標系必須同源，
   * 否則跳轉會落在錯誤的 scrollTop。
   */
  _refreshRowIndex() {
    // A range is a pair of row indices into the *previous* visible set. Filters,
    // sorting and re-alignment renumber those rows, so keeping the range would
    // aim a later Delete at rows the user never selected.
    this._selectionRange = null
    this._visibleRows = this._alignedRows.filter((r) => this._isRowVisible(r))
    this._diffRows = diffRowIndices(this._visibleRows)
    if (this._currentDiffIdx >= this._diffRows.length) {
      this._currentDiffIdx = Math.max(0, this._diffRows.length - 1)
    }
    this._updateDiffCount()
  }

  // ── Private: Render ───────────────────────────────────────────────────────────

  _renderEmptyState() {
    const emptyMsg = el('div', { className: 'tc-empty-state' },
      el('span', { className: 'tc-empty-icon' }, '📊'),
      el('span', {}, '請選擇左側或右側 CSV / TSV / Excel 檔案'),
    )
    if (this._dom.leftScroll) {
      this._dom.leftScroll.innerHTML = ''
      this._dom.leftScroll.appendChild(emptyMsg.cloneNode(true))
    }
    if (this._dom.rightScroll) {
      this._dom.rightScroll.innerHTML = ''
      this._dom.rightScroll.appendChild(emptyMsg.cloneNode(true))
    }
    if (this._dom.leftHeader) this._dom.leftHeader.innerHTML = ''
    if (this._dom.rightHeader) this._dom.rightHeader.innerHTML = ''
    if (this._dom.stats) this._dom.stats.innerHTML = ''
  }

  _renderTable() {
    if (!this._dom.leftScroll) return

    const hasLeft = this._leftParsed != null
    const hasRight = this._rightParsed != null

    if (!hasLeft && !hasRight) {
      this._renderEmptyState()
      return
    }

    // Determine column headers to display (already projected through the map)
    const leftHeaders = this._hasHeader ? (this._displayHeaders?.left ?? []) : null
    const rightHeaders = this._hasHeader ? (this._displayHeaders?.right ?? []) : null

    // With a mapping both panes render the same display columns, which is what
    // puts a pair side by side; without one each pane keeps its own width.
    const mapLen = this._leftColMap?.length ?? null
    const leftColCount = mapLen ?? (this._leftParsed ? (this._leftParsed[0]?.length ?? 0) : 0)
    const rightColCount = mapLen ?? (this._rightParsed ? (this._rightParsed[0]?.length ?? 0) : 0)

    this._leftColCount = leftColCount
    this._rightColCount = rightColCount
    this._colCount = Math.max(leftColCount, rightColCount)

    // Filter rows by visibility
    this._refreshRowIndex()

    // Build header rows
    this._renderPaneHeader(this._dom.leftHeader, leftHeaders, leftColCount, 'left')
    this._renderPaneHeader(this._dom.rightHeader, rightHeaders, rightColCount, 'right')

    this._dom.leftScroll.innerHTML = ''
    this._dom.rightScroll.innerHTML = ''

    if (this._visibleRows.length === 0) {
      const msg = el('div', { className: 'tc-empty-state' },
        el('span', { className: 'tc-empty-icon' }, '✓'),
        el('span', {}, '沒有符合條件的列'),
      )
      this._dom.leftScroll.appendChild(msg.cloneNode(true))
      this._dom.rightScroll.appendChild(msg.cloneNode(true))
      this._renderStats()
      this._recomputeFind()
      this._updateDetailsPanel()
      this._updateFileInfoPanel()
      this._renderThumbnail()
      return
    }

    // Virtual scrolling: a spacer establishes the true scroll height while
    // only the rows in view are built. Without this a 100k-row CSV produced
    // 100k <tr> per side on every filter or checkbox change.
    const totalHeight = this._visibleRows.length * this._rowHeight
    for (const side of ['left', 'right']) {
      const scroll = this._dom[`${side}Scroll`]
      const spacer = el('div', { className: 'tc-vs-spacer' })
      spacer.style.cssText = `position:relative;height:${totalHeight}px;`
      const table = el('table', { className: 'tc-table' })
      table.style.cssText = 'position:absolute;left:0;right:0;top:0;'
      const tbody = document.createElement('tbody')
      table.appendChild(tbody)
      spacer.appendChild(table)
      scroll.appendChild(spacer)
      this._dom[`${side}Table`] = table
      this._dom[`${side}Tbody`] = tbody
    }

    // The tbodies above are brand new, so the previously rendered window no
    // longer describes what is in the DOM. Without clearing it, an unchanged
    // range would short-circuit and leave both panes empty.
    this._windowFirst = null
    this._windowLast = null
    this._renderTableWindow()
    // The <table> elements above are new, so any fitted widths must be re-applied.
    this._applyColumnWidths()
    this._renderStats()
    // Match positions are expressed as _visibleRows indices, which the filter
    // pass above may have just shifted.
    this._recomputeFind()
    this._updateDetailsPanel()
    this._updateFileInfoPanel()
    this._renderThumbnail()
  }

  /**
   * Render only the rows currently in view, plus a small overscan margin.
   * Both panes share one scroll position, so one window serves both.
   */
  _renderTableWindow() {
    // The row holding the open editor is about to be replaced, and removing an
    // element does not fire blur — commit now or the typed value is lost.
    this._commitCellEdit()

    const { leftScroll, leftTbody, rightTbody, leftTable, rightTable } = this._dom
    if (!leftScroll || !leftTbody || !rightTbody) return

    const rows = this._visibleRows ?? []
    const viewport = leftScroll.clientHeight || 600
    const first = Math.max(0, Math.floor(leftScroll.scrollTop / this._rowHeight) - TABLE_OVERSCAN)
    const count = Math.ceil(viewport / this._rowHeight) + TABLE_OVERSCAN * 2
    const last = Math.min(rows.length, first + count)

    if (this._windowFirst === first && this._windowLast === last) return
    this._windowFirst = first
    this._windowLast = last

    const offset = first * this._rowHeight
    if (leftTable) leftTable.style.top = `${offset}px`
    if (rightTable) rightTable.style.top = `${offset}px`

    const leftFrag = document.createDocumentFragment()
    const rightFrag = document.createDocumentFragment()

    for (let i = first; i < last; i++) {
      const alignedRow = rows[i]
      const { status, leftRow, rightRow } = alignedRow
      const cellDiffs = (status === 'different')
        ? this._cellDiffsFor(alignedRow)
        : null
      const cellLevels = (cellDiffs && this._showSeverity)
        ? this._cellLevelsFor(alignedRow, cellDiffs)
        : null
      leftFrag.appendChild(
        this._buildTableRow(leftRow, status, i + 1, this._leftColCount, cellDiffs, 'left', cellLevels))
      rightFrag.appendChild(
        this._buildTableRow(rightRow, status, i + 1, this._rightColCount, cellDiffs, 'right', cellLevels))
    }

    leftTbody.replaceChildren(leftFrag)
    rightTbody.replaceChildren(rightFrag)
    this._applyFindHighlights()
    this._applySelectionHighlight()
  }

  /**
   * 一列的逐欄差異等級，記在列物件上避免左右兩窗格各算一次。
   *
   * 快取隨 `_compare()` 重建對齊列而失效，和 `_cellDiffs` 同一個生命週期。
   *
   * @param {object} alignedRow
   * @param {boolean[]} cellDiffs
   * @returns {number[]}
   */
  _cellLevelsFor(alignedRow, cellDiffs) {
    if (!alignedRow._cellLevels || alignedRow._cellLevels.length !== cellDiffs.length) {
      alignedRow._cellLevels = computeCellLevels(alignedRow.leftRow, alignedRow.rightRow, cellDiffs)
    }
    return alignedRow._cellLevels
  }

  /**
   * Cell diffs for one aligned row, memoised.
   *
   * The same row's diffs were previously recomputed by the renderer, by
   * getStats() and again by exportHtml().
   *
   * @param {object} alignedRow
   * @param {number} [colCount]
   */
  _cellDiffsFor(alignedRow, colCount) {
    const cols = colCount ?? this._colCount ?? 0
    if (!alignedRow._cellDiffs || alignedRow._cellDiffs.length !== cols) {
      alignedRow._cellDiffs = computeCellDiffs(
        alignedRow.leftRow, alignedRow.rightRow, cols, this._effectiveRules())
    }
    return alignedRow._cellDiffs
  }

  /**
   * 把 resize-to-fit 的結果套到表格與標題列。
   *
   * 標題列是 flex 容器而表格是 <table>，兩者必須各自上寬度才會對齊；表格側
   * 用 <colgroup> 搭配 fixed layout，才不會被 auto layout 依內容重新分配。
   */
  _applyColumnWidths() {
    for (const side of /** @type {const} */ (['left', 'right'])) {
      const widths = this._colWidths[side]
      const table = this._dom[`${side}Table`]
      const headerEl = this._dom[`${side}Header`]

      if (table) {
        table.classList.toggle('tc-table--fitted', !!widths)
        table.querySelector('colgroup')?.remove()
        if (widths) {
          const cg = document.createElement('colgroup')
          // Leading <col> pairs with the row-number cell.
          const numCol = document.createElement('col')
          numCol.style.width = '36px'
          cg.appendChild(numCol)
          for (let i = 0; i < widths.length; i++) {
            const col = document.createElement('col')
            // A fixed-layout table reserves the track even when every cell in
            // it is display:none, so a hidden column has to be zeroed here too.
            col.style.width = this.isColumnHidden(i) ? '0px' : `${widths[i]}px`
            cg.appendChild(col)
          }
          table.insertBefore(cg, table.firstChild)
        }
      }

      if (headerEl) {
        const cells = headerEl.querySelectorAll('.tc-cell')
        for (let i = 0; i < cells.length; i++) {
          const w = widths?.[i]
          const px = w ? `${w}px` : ''
          cells[i].style.width = px
          cells[i].style.minWidth = px
          cells[i].style.maxWidth = px
        }
      }
    }
  }

  /**
   * 渲染表格欄位標題行
   * @param {HTMLElement} headerEl
   * @param {string[]|null} headers
   * @param {number} colCount
   * @param {'left'|'right'} side
   */
  _renderPaneHeader(headerEl, headers, colCount, side) {
    headerEl.innerHTML = ''
    if (!this._hasHeader || !headers) return

    // Row number placeholder
    const numCell = el('div', { className: 'tc-row-num' }, '#')
    headerEl.appendChild(numCell)

    const displayCount = Math.max(headers.length, colCount)
    for (let i = 0; i < displayCount; i++) {
      const mapped = this._hasSourceColumn(side, i)
      const custom = this._columnNames[i]
      const source = headers[i] ?? ''
      // Hidden columns keep their DOM node so that every index-based lookup
      // (dbl-click editing, find highlighting, colgroup) stays 1:1 with the
      // column index; only the painting is suppressed.
      const cell = el('div', {
        className: 'tc-cell'
          + (this.isColumnHidden(i) ? ' tc-col-hidden' : '')
          + (mapped ? '' : ' tc-col-unmatched'),
        textContent: mapped ? (custom ?? source) : '—',
      })
      if (!mapped) cell.title = '這一側沒有對應的欄位'
      else if (custom != null) cell.title = `原始欄名：${source}`
      headerEl.appendChild(cell)
    }
  }

  /**
   * 建立單一 <tr> 元素
   * @param {string[]|null} rowData
   * @param {'same'|'different'|'left-only'|'right-only'} status
   * @param {number} rowNum
   * @param {number} colCount
   * @param {boolean[]|null} cellDiffs  各欄是否有差異（only used when status=different）
   * @param {'left'|'right'} side
   * @param {number[]|null} [cellLevels]  各欄差異等級 1–3；null 代表不分級
   * @returns {HTMLTableRowElement}
   */
  _buildTableRow(rowData, status, rowNum, colCount, cellDiffs, side, cellLevels = null) {
    // Phantom row (孤兒側的填充列)
    if (
      (side === 'left'  && status === 'right-only') ||
      (side === 'right' && status === 'left-only')
    ) {
      const tr = document.createElement('tr')
      tr.className = 'tc-row phantom'
      // row num placeholder
      const numTd = document.createElement('td')
      numTd.className = 'tc-row-num'
      tr.appendChild(numTd)
      // empty cells
      for (let i = 0; i < colCount; i++) {
        const td = document.createElement('td')
        td.className = 'tc-cell'
          + (this.isColumnHidden(i) ? ' tc-col-hidden' : '')
          + (this._hasSourceColumn(side, i) ? '' : ' tc-col-unmatched')
        tr.appendChild(td)
      }
      return tr
    }

    const tr = document.createElement('tr')
    tr.className = `tc-row ${status}`
    if (cellLevels) {
      let worst = 0
      for (const lvl of cellLevels) if (lvl > worst) worst = lvl
      if (worst > 0) tr.classList.add(`tc-row--sev${worst}`)
    }

    // Row number
    const numTd = document.createElement('td')
    numTd.className = 'tc-row-num'
    numTd.textContent = String(rowNum)
    tr.appendChild(numTd)

    const displayCount = Math.max(rowData?.length ?? 0, colCount)
    for (let i = 0; i < displayCount; i++) {
      const td = document.createElement('td')
      const isDiff = cellDiffs ? (cellDiffs[i] ?? false) : false
      const level = (isDiff && cellLevels) ? (cellLevels[i] ?? 0) : 0
      td.className = 'tc-cell'
        + (isDiff ? ' cell-diff' : '')
        + (level > 0 ? ` tc-cell--sev${level}` : '')
        + (this.isColumnHidden(i) ? ' tc-col-hidden' : '')
        + (this._hasSourceColumn(side, i) ? '' : ' tc-col-unmatched')
      const val = rowData?.[i] ?? ''
      // S14-M11: textContent avoids HTML parsing per-cell — ~30% faster on
      // 1Mx1k tables. The cell is plain text; no need for innerHTML.
      td.textContent = this._showWhitespace ? visibleWhitespace(val) : val
      tr.appendChild(td)
    }

    return tr
  }

  /**
   * @param {AlignedRow} row
   * @returns {boolean}
   */
  _isRowVisible(row) {
    // 'left-only' / 'right-only' are differences too — a row that exists on one
    // side only is the clearest difference there is.
    return row.status === 'same' ? this._showSame : this._showDiff
  }

  // ── T22: Stats alert ─────────────────────────────────────────────────────────

  _showStatsAlert() {
    const s = this.getStats()

    const timeStr = s.compareTime != null
      ? new Date(s.compareTime).toLocaleString()
      : '（尚未比對）'

    let colDiffLines = ''
    for (const [colName, count] of Object.entries(s.columnDiffCounts)) {
      colDiffLines += `  ${colName}: ${count} 列差異\n`
    }
    if (!colDiffLines) colDiffLines = '  （無差異欄位）\n'

    const msg = [
      `比對時間：${timeStr}`,
      `總列數：${s.total}`,
      `相同：${s.same}`,
      `差異：${s.different}`,
      `僅左：${s.leftOnly}`,
      `僅右：${s.rightOnly}`,
      ``,
      `差異欄位分析：`,
      colDiffLines.trimEnd(),
    ].join('\n')

    // Use electronAPI.saveFile to persist the report if available;
    // fall back to alert for quick display.
    if (window.electronAPI?.saveFile) {
      window.electronAPI.saveFile('table-stats.txt', msg)
    } else {
      // eslint-disable-next-line no-alert
      window.alert(msg)
    }
  }

  _renderStats() {
    const stats = this._dom.stats
    if (!stats) return
    stats.innerHTML = ''

    // S27: the Specs description is the one place the user's own note about
    // this comparison can be seen without reopening the dialog.
    const { name, description } = this._sessionInfo
    if (name || description) {
      const note = el('span', { className: 'tc-stat-item tc-stat-specs' },
        name ? `${name}${description ? '：' : ''}${description}` : description)
      note.title = description || name
      stats.appendChild(note)
    }

    // S27: a mapping with one-sided columns changes what "different" means, so
    // say how many there are rather than leaving the reader to count blanks.
    if (this._leftColMap && this._rightColMap) {
      let unmatched = 0
      for (let i = 0; i < this._leftColMap.length; i++) {
        if (this._leftColMap[i] < 0 || this._rightColMap[i] < 0) unmatched++
      }
      if (unmatched > 0) {
        stats.appendChild(el('span', { className: 'tc-stat-item tc-stat-unmatched' },
          `單側獨有欄 ${unmatched}${this._unmatchedIsDiff ? '' : '（不計入差異）'}`))
      }
    }

    if (!this._alignedRows.length) return

    const counts = { same: 0, different: 0, 'left-only': 0, 'right-only': 0 }
    for (const row of this._alignedRows) {
      counts[row.status] = (counts[row.status] ?? 0) + 1
    }

    const defs = [
      { key: 'same',       label: '相同' },
      { key: 'different',  label: '差異' },
      { key: 'left-only',  label: '僅左' },
      { key: 'right-only', label: '僅右' },
    ]

    for (const { key, label } of defs) {
      const count = counts[key]
      if (count == null || count === 0) continue
      const item = el('span', { className: 'tc-stat-item' })
      item.appendChild(el('span', { className: `tc-stat-dot ${key}` }))
      item.appendChild(document.createTextNode(`${label} ${count}`))
      stats.appendChild(item)
    }

    const total = this._alignedRows.length
    const totalEl = el('span', { className: 'tc-stat-item' }, `共 ${total} 列`)
    totalEl.style.marginLeft = 'auto'
    stats.appendChild(totalEl)
  }

  // ── Private: Path display ─────────────────────────────────────────────────────

  /**
   * @param {'left'|'right'} side
   * @param {string} path
   */
  _updatePathDisplay(side, path) {
    const dom = side === 'left' ? this._dom.dispLeft : this._dom.dispRight
    // Trailing '*' marks unsaved cell edits, matching text compare.
    if (dom) dom.textContent = `${path}${this._modified[side] ? ' *' : ''}`
  }
}

// ── Exports for unit testing ──────────────────────────────────────────────────
// These pure functions are ES-module-friendly; tree-shaking removes them in
// production renderer builds that only import TableCompare.
export {
  parseTable, alignRows, computeRowStatus, computeCellDiffs,
  findCellMatches, diffRowIndices, stepIndexClamped, stepIndexWrapped,
  parseNumericValue, parseDateValue, cellsEqual, columnRuleAt,
  normaliseKeyColumns, buildRowKey, measureColumnWidths, DEFAULT_COLUMN_RULE,
  serializeTable, parseHtmlTables, csvPathFor,
  visibleWhitespace, mergeIgnoredColumns, toColumnList, describeDelimiter,
  cellDiffRatio, severityLevel, computeCellLevels, thumbnailBuckets, parseGotoInput,
  normaliseColumnMapping, identityColumnMapping, suggestColumnMapping,
  projectRow, columnMapSides, sortByDisplayKey, headerMatchKey,
  DELIMITER_PRESETS, TABLE_ENCODINGS, NO_COLUMN,
}
