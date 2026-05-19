/**
 * TableCompare — CSV/TSV 表格比對視圖
 * src/renderer/src/views/table-compare.js
 *
 * 公開 API：
 *   constructor(options)  mount(el)  destroy()
 *   openLeft()  openRight()
 *   setLeft(path, content)  setRight(path, content)
 *   refresh()  on(event, handler)  off(event, handler)
 *
 * 事件：
 *   'paths-changed' → { left: string, right: string }
 */

import { showContextMenu } from '../core/context-menu.js'
import { el } from '../core/utils.js'
import '../styles/table-compare.css'

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
 * @param {number} keyCol         key 欄位索引，-1 代表按位置對齊
 * @param {string[]|null} leftHeaders   左側標題行（ignoreColumnOrder 用）
 * @param {string[]|null} rightHeaders  右側標題行
 * @param {boolean} ignoreColumnOrder
 * @returns {AlignedRow[]}
 */
function alignRows(leftData, rightData, keyCol, leftHeaders, rightHeaders, ignoreColumnOrder) {
  // 若需要忽略欄位排序，先將右側資料欄位重排成左側順序
  let normalizedRight = rightData
  let normalizedRightHeaders = rightHeaders
  if (ignoreColumnOrder && leftHeaders && rightHeaders) {
    normalizedRight = rightData.map((row) => reorderRow(row, rightHeaders, leftHeaders))
    normalizedRightHeaders = leftHeaders
  }

  if (keyCol === -1) {
    // 按位置對齊
    const len = Math.max(leftData.length, normalizedRight.length)
    const result = []
    for (let i = 0; i < len; i++) {
      const lRow = leftData[i] ?? null
      const rRow = normalizedRight[i] ?? null
      result.push({
        status: computeRowStatus(lRow, rRow),
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
    const key = leftData[i][keyCol] ?? ''
    if (!leftMap.has(key)) leftMap.set(key, [])
    leftMap.get(key).push({ row: leftData[i], idx: i })
  }

  const rightMap = new Map()
  for (let i = 0; i < normalizedRight.length; i++) {
    const key = normalizedRight[i][keyCol] ?? ''
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
        status: computeRowStatus(lEntry?.row ?? null, rEntry?.row ?? null),
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
 * @returns {'same'|'different'|'left-only'|'right-only'}
 */
function computeRowStatus(left, right) {
  if (!right) return 'left-only'
  if (!left) return 'right-only'
  const maxLen = Math.max(left.length, right.length)
  for (let i = 0; i < maxLen; i++) {
    if ((left[i] ?? '') !== (right[i] ?? '')) return 'different'
  }
  return 'same'
}

/**
 * 計算每一欄是否有差異（用於 cell-diff 標記）
 * @param {string[]|null} leftRow
 * @param {string[]|null} rightRow
 * @param {number} colCount
 * @returns {boolean[]}
 */
function computeCellDiffs(leftRow, rightRow, colCount) {
  const diffs = []
  for (let i = 0; i < colCount; i++) {
    diffs.push((leftRow?.[i] ?? '') !== (rightRow?.[i] ?? ''))
  }
  return diffs
}

// ── TableCompare Class ────────────────────────────────────────────────────────

export class TableCompare {
  /**
   * @param {object} [options]
   * @param {boolean} [options.hasHeader]          第一行是否為標題行（預設 true）
   * @param {number}  [options.keyColumn]           對齊用的 key 欄索引（-1 表示按位置，預設 0）
   * @param {boolean} [options.ignoreColumnOrder]  忽略欄位排序差異（預設 false）
   */
  constructor(options = {}) {
    this._hasHeader = options.hasHeader ?? true
    this._keyColumn = options.keyColumn ?? 0
    this._ignoreColumnOrder = options.ignoreColumnOrder ?? false

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

    // Visibility filters
    this._showSame = true
    this._showDiff = true

    // T15: sort before compare
    this._sortBeforeCompare = false

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

  /** 呼叫 electronAPI.openFile()，讀取左側 CSV/TSV/XLSX */
  async openLeft() {
    const result = await window.electronAPI.openFile({
      filters: [
        { name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] },
        { name: 'Excel', extensions: ['xlsx', 'xls'] },
        { name: '所有檔案', extensions: ['*'] },
      ]
    })
    if (!result) return
    const ext = result.path.toLowerCase()
    if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
      await this._openExcel('left', result.path)
    } else {
      this.setLeft(result.path, result.content)
    }
  }

  /** 呼叫 electronAPI.openFile()，讀取右側 CSV/TSV/XLSX */
  async openRight() {
    const result = await window.electronAPI.openFile({
      filters: [
        { name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] },
        { name: 'Excel', extensions: ['xlsx', 'xls'] },
        { name: '所有檔案', extensions: ['*'] },
      ]
    })
    if (!result) return
    const ext = result.path.toLowerCase()
    if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
      await this._openExcel('right', result.path)
    } else {
      this.setRight(result.path, result.content)
    }
  }

  /**
   * 以 electronAPI.readExcel() 讀取 Excel 檔案，取第一個工作表轉為 CSV 後載入。
   * @param {'left'|'right'} side
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _openExcel(side, path) {
    const result = await window.electronAPI.readExcel(path)
    if (result?.error) {
      console.error('Excel read error:', result.error)
      return
    }
    const sheetName = result.sheetNames[0]
    const csv = result.sheets[sheetName]
    const displayPath = result.sheetNames.length > 1
      ? `${path} [${sheetName}]`
      : path
    if (side === 'left') this.setLeft(displayPath, csv)
    else this.setRight(displayPath, csv)
  }

  /**
   * 直接設定左側內容（如 session 還原）
   * @param {string} path
   * @param {string} content
   */
  setLeft(path, content) {
    this._leftPath = path
    this._leftContent = content
    this._updatePathDisplay('left', path)
    this._parseAndRefresh()
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
  }

  /**
   * 直接設定右側內容（如 session 還原）
   * @param {string} path
   * @param {string} content
   */
  setRight(path, content) {
    this._rightPath = path
    this._rightContent = content
    this._updatePathDisplay('right', path)
    this._parseAndRefresh()
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
  }

  /** 重新解析並重新渲染 */
  refresh() {
    this._parseAndRefresh()
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

  /**
   * 匯出比對結果為 self-contained HTML 檔案。
   * 呼叫 window.electronAPI.saveFile('table-report.html', html)。
   * @returns {Promise<void>}
   */
  async exportHtml() {
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
        ? computeCellDiffs(leftRow, rightRow, colCount)
        : null

      leftTbody  += buildTr(leftRow,  status, rowNum, leftColCount,  diffs, 'left')
      rightTbody += buildTr(rightRow, status, rowNum, rightColCount, diffs, 'right')
      rowNum++
    }

    const tableStyle = 'border-collapse:collapse;font-family:monospace;font-size:13px;width:100%'
    const thStyle = 'background:#f0f0f0;border-bottom:2px solid #aaa;padding:2px 6px;text-align:left'

    const html = `<!DOCTYPE html>
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

    await window.electronAPI.saveFile('table-report.html', html)
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
        const diffs = computeCellDiffs(row.leftRow, row.rightRow, colCount)
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

    this._container.appendChild(root)
    this._dom.root = root

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

    // Key column input
    const keyLabel = el('label')
    keyLabel.appendChild(document.createTextNode('Key 欄（-1=無）：'))
    const keyInput = el('input', { type: 'number', min: '-1', value: String(this._keyColumn) })
    this._dom.keyInput = keyInput
    keyLabel.appendChild(keyInput)
    toolbar.appendChild(keyLabel)

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

    // Refresh button
    const btnRefresh = el('button', { className: 'tc-btn tc-btn-refresh' }, '↺ 重新整理')
    this._dom.btnRefresh = btnRefresh
    toolbar.appendChild(btnRefresh)

    // T14: Export HTML button
    const btnExport = el('button', { id: 'tc-btn-export', className: 'tc-btn' }, '⬇ 匯出 HTML')
    this._dom.btnExport = btnExport
    toolbar.appendChild(btnExport)

    // T22: Export stats button
    const btnExportStats = el('button', { id: 'tc-btn-export-stats', className: 'tc-btn' }, '📋 統計')
    this._dom.btnExportStats = btnExportStats
    toolbar.appendChild(btnExportStats)

    return toolbar
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

  _buildPathRow() {
    const row = el('div', { className: 'tc-path-row' })

    // Left
    const leftCell = el('div', { className: 'tc-path-cell' })
    const btnLeft = el('button', { className: 'tc-open-btn' }, '開啟檔案…')
    const dispLeft = el('span', { className: 'tc-path-display' }, this._leftPath ?? '（未選擇）')
    this._dom.btnOpenLeft = btnLeft
    this._dom.dispLeft = dispLeft
    leftCell.appendChild(btnLeft)
    leftCell.appendChild(dispLeft)

    // Right
    const rightCell = el('div', { className: 'tc-path-cell' })
    const btnRight = el('button', { className: 'tc-open-btn' }, '開啟檔案…')
    const dispRight = el('span', { className: 'tc-path-display' }, this._rightPath ?? '（未選擇）')
    this._dom.btnOpenRight = btnRight
    this._dom.dispRight = dispRight
    rightCell.appendChild(btnRight)
    rightCell.appendChild(dispRight)

    row.appendChild(leftCell)
    row.appendChild(rightCell)
    return row
  }

  // ── Private: Event binding ────────────────────────────────────────────────────

  _bindEvents() {
    const { btnOpenLeft, btnOpenRight, btnRefresh,
            cbHeader, cbSame, cbDiffOnly, cbColOrder, keyInput,
            btnExport, btnExportStats, cbSort } = this._dom

    btnOpenLeft.addEventListener('click', () => this.openLeft())
    btnOpenRight.addEventListener('click', () => this.openRight())
    btnRefresh.addEventListener('click', () => this.refresh())

    // T14: export HTML
    btnExport.addEventListener('click', () => this.exportHtml())

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
      const val = parseInt(keyInput.value, 10)
      this._keyColumn = isNaN(val) ? 0 : val
      this._parseAndRefresh()
    })

    // Sync scroll between left and right panes
    const { leftScroll, rightScroll } = this._dom
    let syncingScroll = false
    leftScroll.addEventListener('scroll', () => {
      if (syncingScroll) return
      syncingScroll = true
      rightScroll.scrollTop = leftScroll.scrollTop
      syncingScroll = false
    })
    rightScroll.addEventListener('scroll', () => {
      if (syncingScroll) return
      syncingScroll = true
      leftScroll.scrollTop = rightScroll.scrollTop
      syncingScroll = false
    })

    // Context menu
    leftScroll.addEventListener('contextmenu',  (e) => this._onTableContextMenu(e, 'left'))
    rightScroll.addEventListener('contextmenu', (e) => this._onTableContextMenu(e, 'right'))
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

  // ── Private: Parse & Compare ──────────────────────────────────────────────────

  _parseAndRefresh() {
    if (this._leftContent != null) {
      this._leftParsed = parseTable(this._leftContent)
    }
    if (this._rightContent != null) {
      this._rightParsed = parseTable(this._rightContent)
    }
    this._compare()
    this._renderTable()
  }

  _compare() {
    const leftParsed = this._leftParsed
    const rightParsed = this._rightParsed

    if (!leftParsed && !rightParsed) {
      this._alignedRows = []
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

    // T15: sort before compare — sort each side by key column (or col 0 when keyColumn=-1)
    if (this._sortBeforeCompare) {
      const sortCol = this._keyColumn >= 0 ? this._keyColumn : 0
      const sortFn = (a, b) => {
        const av = a[sortCol] ?? ''
        const bv = b[sortCol] ?? ''
        return av < bv ? -1 : av > bv ? 1 : 0
      }
      leftData  = leftData.slice().sort(sortFn)
      rightData = rightData.slice().sort(sortFn)
    }

    this._alignedRows = alignRows(
      leftData,
      rightData,
      this._keyColumn,
      leftHeaders,
      rightHeaders,
      this._ignoreColumnOrder,
    )
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
    const colCount = Math.max(leftColCount, rightColCount)

    // Filter rows by visibility
    const visibleRows = this._alignedRows.filter((r) => this._isRowVisible(r))

    // Build header rows
    this._renderPaneHeader(this._dom.leftHeader, leftHeaders, leftColCount)
    this._renderPaneHeader(this._dom.rightHeader, rightHeaders, rightColCount)

    // Build left table
    this._dom.leftScroll.innerHTML = ''
    this._dom.rightScroll.innerHTML = ''

    if (visibleRows.length === 0) {
      const msg = el('div', { className: 'tc-empty-state' },
        el('span', { className: 'tc-empty-icon' }, '✓'),
        el('span', {}, '沒有符合條件的列'),
      )
      this._dom.leftScroll.appendChild(msg.cloneNode(true))
      this._dom.rightScroll.appendChild(msg.cloneNode(true))
      this._renderStats()
      return
    }

    const leftTable = el('table', { className: 'tc-table' })
    const rightTable = el('table', { className: 'tc-table' })
    const leftTbody = document.createElement('tbody')
    const rightTbody = document.createElement('tbody')

    let rowNum = 1
    for (const alignedRow of visibleRows) {
      const { status, leftRow, rightRow } = alignedRow
      const cellDiffs = (status === 'different')
        ? computeCellDiffs(leftRow, rightRow, colCount)
        : null

      const leftTr = this._buildTableRow(leftRow, status, rowNum, leftColCount, cellDiffs, 'left')
      const rightTr = this._buildTableRow(rightRow, status, rowNum, rightColCount, cellDiffs, 'right')

      leftTbody.appendChild(leftTr)
      rightTbody.appendChild(rightTr)
      rowNum++
    }

    leftTable.appendChild(leftTbody)
    rightTable.appendChild(rightTbody)
    this._dom.leftScroll.appendChild(leftTable)
    this._dom.rightScroll.appendChild(rightTable)

    this._renderStats()
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
    if (dom) dom.textContent = path
  }
}

// ── Exports for unit testing ──────────────────────────────────────────────────
// These pure functions are ES-module-friendly; tree-shaking removes them in
// production renderer builds that only import TableCompare.
export { parseTable, alignRows, computeRowStatus, computeCellDiffs }
