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
 *
 * 事件：
 *   'paths-changed' → { left: string, right: string }
 */

import { isActive } from '../core/active-view.js'
import { renderTextTable, reportHeader, reportSummary } from '../core/report.js'
import { showContextMenu, closeContextMenu } from '../core/context-menu.js'
import { el } from '../core/utils.js'
import { tagConfig, readConfig } from '../core/named-config-store.js'
import { stepDiffIndex, navResult, getNavOptions } from '../core/diff-nav.js'
import { toast } from '../core/toast.js'
import '../styles/table-compare.css'

/** @typedef {import('../core/diff-nav.js').NavResult} NavResult */

/** Fixed row height, mirroring `.tc-row { height: 24px }` in the stylesheet. */
const TABLE_ROW_HEIGHT = 24

/** Extra rows rendered above and below the viewport to hide scroll seams. */
const TABLE_OVERSCAN = 10

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

    /** @typedef {{ side: 'left'|'right', rowIdx: number, col: number, before: string, after: string }} CellEdit */
    /** @type {CellEdit[]} */
    this._undoStack = []
    /** @type {CellEdit[]} */
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
    const lower = String(result.path ?? '').toLowerCase()
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      await this._openExcel(side, result.path)
    } else if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      this._openHtmlContent(side, result.path, result.content)
    } else if (side === 'left') {
      this.setLeft(result.path, result.content)
    } else {
      this.setRight(result.path, result.content)
    }
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
    ;[this._rowIndexMap.left, this._rowIndexMap.right] = [this._rowIndexMap.right, this._rowIndexMap.left]
    this._syncSourceSelect('left')
    this._syncSourceSelect('right')
    ;[this._leftPath, this._rightPath] = [this._rightPath, this._leftPath]
    ;[this._leftContent, this._rightContent] = [this._rightContent, this._leftContent]
    ;[this._leftParsed, this._rightParsed] = [this._rightParsed, this._leftParsed]
    ;[this._leftHeaders, this._rightHeaders] = [this._rightHeaders, this._leftHeaders]
    this._colWidths = { left: this._colWidths.right, right: this._colWidths.left }

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
   * @returns {{ parsedRowIdx: number, sourceCol: number }|null} null 代表不可編輯
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

    const sourceCol = (side === 'right' && this._rightColMap) ? this._rightColMap[col] : col
    // Under "ignore column order" a left-hand column may have no counterpart.
    if (sourceCol == null || sourceCol < 0) return null
    return { parsedRowIdx, sourceCol }
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
    this._pushHistory({ side, rowIdx: target.parsedRowIdx, col: target.sourceCol, before, after })
    this._afterEdit(side)
    return true
  }

  /**
   * @param {CellEdit} entry
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
    if (!this._writeParsedCell(entry.side, entry.rowIdx, entry.col, entry.before)) return false
    this._redoStack.push(entry)
    if (this._redoStack.length > MAX_EDIT_HISTORY) this._redoStack.shift()
    // The file on disk still differs from what is on screen after an undo, so
    // the modified flag stays set rather than guessing the file is pristine.
    this._afterEdit(entry.side)
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
    if (!this._writeParsedCell(entry.side, entry.rowIdx, entry.col, entry.after)) return false
    this._undoStack.push(entry)
    if (this._undoStack.length > MAX_EDIT_HISTORY) this._undoStack.shift()
    this._afterEdit(entry.side)
    return true
  }

  /**
   * 編輯落地後：同步文字內容、標示未儲存、重新比對並重繪（保留捲動位置）。
   * @param {'left'|'right'} side
   */
  _afterEdit(side) {
    const parsed = (side === 'left' ? this._leftParsed : this._rightParsed) ?? []
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
    let result
    try {
      result = await window.electronAPI.saveFile(
        defaultPath || 'table.csv',
        content,
        [{ name: 'CSV', extensions: ['csv'] },
         { name: 'TSV', extensions: ['tsv'] },
         { name: '所有檔案', extensions: ['*'] }])
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
   * @param {MouseEvent} e
   * @param {'left'|'right'} side
   */
  _onCellDblClick(e, side) {
    const target = e.target instanceof Element ? e.target : null
    const td = target?.closest('td.tc-cell')
    const tr = td?.closest('tr.tc-row')
    const tbody = this._dom[`${side}Tbody`]
    if (!td || !tr || !tbody || tr.parentElement !== tbody) return
    if (tr.classList.contains('phantom')) return

    const rowOffset = [...tbody.children].indexOf(tr)
    if (rowOffset < 0) return
    const visibleRowIdx = (this._windowFirst ?? 0) + rowOffset
    // -1 skips the leading row-number cell.
    const col = [...tr.children].indexOf(td) - 1
    this._beginCellEdit(side, visibleRowIdx, col, td)
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

    const original = td.textContent ?? ''
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
    if (value === editing.original) {
      editing.td.textContent = editing.original
      return
    }
    if (!this.editCell(editing.side, editing.visibleRowIdx, editing.col, value)) {
      editing.td.textContent = editing.original
      this._reportError('儲存格編輯失敗：找不到對應的來源資料列')
    }
  }

  /** 放棄編輯中的儲存格，還原原本的顯示值。 */
  _cancelCellEdit() {
    const editing = this._editing
    if (!editing) return
    this._editing = null
    editing.td.classList.remove('tc-cell--editing')
    editing.td.textContent = editing.original
  }

  /** 讓 undo / redo / 儲存按鈕反映目前狀態。 */
  _syncEditButtons() {
    const { btnUndo, btnRedo, btnSaveLeft, btnSaveRight } = this._dom
    if (btnUndo) btnUndo.disabled = !this.canUndo()
    if (btnRedo) btnRedo.disabled = !this.canRedo()
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

    this._colWidths = {
      left: measureColumnWidths(
        sample.map((r) => r.leftRow), leftCols, this._hasHeader ? this._leftHeaders : null),
      right: measureColumnWidths(
        sample.map((r) => r.rightRow), rightCols, this._hasHeader ? this._rightHeaders : null),
    }
    this._applyColumnWidths()
    return this
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

    const leftHeaders  = this._hasHeader ? (this._leftHeaders  ?? []) : null
    const rightHeaders = this._hasHeader ? (this._rightHeaders ?? []) : null

    const leftColCount  = this._leftParsed  ? (this._leftParsed[0]?.length  ?? 0) : 0
    const rightColCount = this._rightParsed ? (this._rightParsed[0]?.length ?? 0) : 0
    const colCount = Math.max(leftColCount, rightColCount)

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
    const colCount = Math.max(leftColCount, rightColCount)

    const headers = this._hasHeader ? (this._leftHeaders ?? []) : null

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
          const colName = (headers && headers[i] != null) ? headers[i] : `col${i}`
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
    if (settings.keyColumns !== undefined) this.setKeyColumns(settings.keyColumns)
    if (settings.columnRules && typeof settings.columnRules === 'object') {
      this.setColumnRules(settings.columnRules)
    }
    if (settings.layoutMode === 'side-by-side' || settings.layoutMode === 'over-under') {
      this._layoutMode = settings.layoutMode
    }
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
    root.appendChild(body)

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

    this._container.appendChild(root)
    this._dom.root = root

    this._applyLayout()
    this._renderEmptyState()
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

    const btnFit = el('button', { id: 'tc-btn-fit', className: 'tc-btn' }, '↔ 自動欄寬')
    btnFit.title = '依內容調整欄寬（再按一次還原）'
    this._dom.btnFit = btnFit
    toolbar.appendChild(btnFit)

    // Separator
    toolbar.appendChild(el('span', { className: 'tc-toolbar-sep' }))

    // ignoreColumnOrder toggle
    const cbColOrder = this._buildCheckbox('tc-ignore-col-order', '忽略欄位排序', this._ignoreColumnOrder)
    this._dom.cbColOrder = cbColOrder.querySelector('input')
    toolbar.appendChild(cbColOrder)

    // Separator
    toolbar.appendChild(el('span', { className: 'tc-toolbar-sep' }))

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

  /** @returns {number} 兩側欄數的最大值 */
  _totalColumnCount() {
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
    const headers = this._hasHeader ? (this._leftHeaders ?? this._rightHeaders) : null

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

    return row
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
    leftCell.appendChild(btnLeft)
    leftCell.appendChild(dispLeft)
    leftCell.appendChild(selLeft)

    // Right
    const rightCell = el('div', { className: 'tc-path-cell' })
    const btnRight = el('button', { className: 'tc-open-btn' }, '開啟檔案…')
    const dispRight = el('span', { className: 'tc-path-display' }, this._rightPath ?? '（未選擇）')
    const selRight = el('select', { className: 'tc-source-select', title: '選擇工作表 / 表格' })
    selRight.style.display = 'none'
    this._dom.btnOpenRight = btnRight
    this._dom.dispRight = dispRight
    this._dom.selRight = selRight
    rightCell.appendChild(btnRight)
    rightCell.appendChild(dispRight)
    rightCell.appendChild(selRight)

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

    cbSame.addEventListener('change', () => {
      this._showSame = cbSame.checked
      // cbDiffOnly is the inverse of showSame — keep them in sync
      if (cbDiffOnly.checked === cbSame.checked) {
        cbDiffOnly.checked = !cbSame.checked
      }
      this._renderTable()
    })

    cbDiffOnly.addEventListener('change', () => {
      // "只顯示差異" = 不顯示相同行
      this._showSame = !cbDiffOnly.checked
      if (cbSame.checked === cbDiffOnly.checked) {
        cbSame.checked = !cbDiffOnly.checked
      }
      this._renderTable()
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

    // Sync scroll between left and right panes, and repaint the virtual window.
    const { leftScroll, rightScroll } = this._dom
    const repaint = _rafThrottle(() => this._renderTableWindow())
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
    this._dom.btnUndo.addEventListener('click', () => this.undo())
    this._dom.btnRedo.addEventListener('click', () => this.redo())
    this._dom.btnSaveLeft.addEventListener('click', () => void this.saveLeft())
    this._dom.btnSaveRight.addEventListener('click', () => void this.saveRight())

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
          items.push({
            label: '編輯儲存格…',
            action: () => this._beginCellEdit(
              side,
              (this._windowFirst ?? 0) + rowOffset,
              [...tr.children].indexOf(td) - 1,
              td),
          })
        }
      }
    }

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
    const target = Math.max(0, rowIndex * TABLE_ROW_HEIGHT - Math.floor(viewport / 2))
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
      this._delimiter.left = detectDelimiter(this._leftContent)
      this._leftParsed = parseTable(this._leftContent, this._delimiter.left)
      this._rowIndexMap.left = _buildRowIndexMap(this._leftParsed)
    }
    if (this._rightContent != null) {
      this._delimiter.right = detectDelimiter(this._rightContent)
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
      this._rightColMap = null
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

    // T15: sort before compare — sort each side by the key columns (or col 0
    // when aligning by position), using the same canonical form as alignment so
    // numeric/date columns group consistently.
    if (this._sortBeforeCompare) {
      const sortCols = this._keyColumns.length ? this._keyColumns : [0]
      const sortFn = (a, b) => {
        const av = buildRowKey(a, sortCols, this._columnRules)
        const bv = buildRowKey(b, sortCols, this._columnRules)
        return av < bv ? -1 : av > bv ? 1 : 0
      }
      leftData  = leftData.slice().sort(sortFn)
      rightData = rightData.slice().sort(sortFn)
    }

    // AlignedRow.leftIdx/rightIdx index these arrays, and their elements are the
    // very row objects held by _leftParsed/_rightParsed (slice and sort preserve
    // identity), which is what makes an edit reach the model.
    this._leftData = leftData
    this._rightData = rightData
    // Under "ignore column order" the right pane displays left-hand columns, so
    // a displayed column index has to be mapped back to the right file's own.
    this._rightColMap = (this._ignoreColumnOrder && leftHeaders && rightHeaders)
      ? leftHeaders.map((h) => rightHeaders.indexOf(h))
      : null

    this._alignedRows = alignRows(
      leftData,
      rightData,
      this._keyColumns,
      leftHeaders,
      rightHeaders,
      this._ignoreColumnOrder,
      this._columnRules,
    )
    this._refreshRowIndex()
  }

  /**
   * 重建「可見列」與「差異列索引」。導航座標系與虛擬捲動座標系必須同源，
   * 否則跳轉會落在錯誤的 scrollTop。
   */
  _refreshRowIndex() {
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

    // Determine column headers to display
    const leftHeaders = this._hasHeader ? (this._leftHeaders ?? []) : null
    const rightHeaders = this._hasHeader ? (this._rightHeaders ?? []) : null

    // Column count: maximum of left and right
    const leftColCount = this._leftParsed
      ? (this._leftParsed[0]?.length ?? 0)
      : 0
    const rightColCount = this._rightParsed
      ? (this._rightParsed[0]?.length ?? 0)
      : 0

    this._leftColCount = leftColCount
    this._rightColCount = rightColCount
    this._colCount = Math.max(leftColCount, rightColCount)

    // Filter rows by visibility
    this._refreshRowIndex()

    // Build header rows
    this._renderPaneHeader(this._dom.leftHeader, leftHeaders, leftColCount)
    this._renderPaneHeader(this._dom.rightHeader, rightHeaders, rightColCount)

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
      return
    }

    // Virtual scrolling: a spacer establishes the true scroll height while
    // only the rows in view are built. Without this a 100k-row CSV produced
    // 100k <tr> per side on every filter or checkbox change.
    const totalHeight = this._visibleRows.length * TABLE_ROW_HEIGHT
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
    const first = Math.max(0, Math.floor(leftScroll.scrollTop / TABLE_ROW_HEIGHT) - TABLE_OVERSCAN)
    const count = Math.ceil(viewport / TABLE_ROW_HEIGHT) + TABLE_OVERSCAN * 2
    const last = Math.min(rows.length, first + count)

    if (this._windowFirst === first && this._windowLast === last) return
    this._windowFirst = first
    this._windowLast = last

    const offset = first * TABLE_ROW_HEIGHT
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
      leftFrag.appendChild(
        this._buildTableRow(leftRow, status, i + 1, this._leftColCount, cellDiffs, 'left'))
      rightFrag.appendChild(
        this._buildTableRow(rightRow, status, i + 1, this._rightColCount, cellDiffs, 'right'))
    }

    leftTbody.replaceChildren(leftFrag)
    rightTbody.replaceChildren(rightFrag)
    this._applyFindHighlights()
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
        alignedRow.leftRow, alignedRow.rightRow, cols, this._columnRules)
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
          for (const w of widths) {
            const col = document.createElement('col')
            col.style.width = `${w}px`
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
   */
  _renderPaneHeader(headerEl, headers, colCount) {
    headerEl.innerHTML = ''
    if (!this._hasHeader || !headers) return

    // Row number placeholder
    const numCell = el('div', { className: 'tc-row-num' }, '#')
    headerEl.appendChild(numCell)

    const displayCount = Math.max(headers.length, colCount)
    for (let i = 0; i < displayCount; i++) {
      const text = headers[i] ?? ''
      const cell = el('div', { className: 'tc-cell', textContent: text })
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
   * @returns {HTMLTableRowElement}
   */
  _buildTableRow(rowData, status, rowNum, colCount, cellDiffs, side) {
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
        tr.appendChild(td)
      }
      return tr
    }

    const tr = document.createElement('tr')
    tr.className = `tc-row ${status}`

    // Row number
    const numTd = document.createElement('td')
    numTd.className = 'tc-row-num'
    numTd.textContent = String(rowNum)
    tr.appendChild(numTd)

    const displayCount = Math.max(rowData?.length ?? 0, colCount)
    for (let i = 0; i < displayCount; i++) {
      const td = document.createElement('td')
      const isDiff = cellDiffs ? (cellDiffs[i] ?? false) : false
      td.className = 'tc-cell' + (isDiff ? ' cell-diff' : '')
      const val = rowData?.[i] ?? ''
      // S14-M11: textContent avoids HTML parsing per-cell — ~30% faster on
      // 1Mx1k tables. The cell is plain text; no need for innerHTML.
      td.textContent = val
      tr.appendChild(td)
    }

    return tr
  }

  /**
   * @param {AlignedRow} row
   * @returns {boolean}
   */
  _isRowVisible(row) {
    if (!this._showSame && row.status === 'same') return false
    return true
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
}
