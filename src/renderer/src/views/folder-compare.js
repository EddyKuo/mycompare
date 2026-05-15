/**
 * FolderCompare — 資料夾比對視圖
 * src/renderer/src/views/folder-compare.js
 */

import { showContextMenu } from '../core/context-menu.js'
import { el, debounce, formatSize } from '../core/utils.js'
import '../styles/folder-compare.css'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** 將 ISO8601 mtime 格式化為 YYYY-MM-DD HH:mm */
function formatMtime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/**
 * 判斷檔名是否符合 glob-like 篩選規則。
 * 支援：
 *   *.js          → 副檔名過濾（包含）
 *   -node_modules → 名稱過濾（排除）
 */
function matchesFilter(name, filterStr) {
  const parts = filterStr.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return true

  let include = true
  for (const part of parts) {
    if (part.startsWith('-')) {
      // 排除規則
      const pattern = part.slice(1)
      if (globMatch(name, pattern)) return false
    } else {
      // 包含規則：只要有任一包含規則存在，name 必須符合其中一條
      include = false
      if (globMatch(name, part)) include = true
    }
  }
  return include
}

/** 極簡 glob 比對，支援 * 與 ? */
function globMatch(str, pattern) {
  // 轉換 glob 為 RegExp
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${re}$`, 'i').test(str)
}

// ── compareEntries ────────────────────────────────────────────────────────────

/**
 * @param {FileEntry[]} leftEntries
 * @param {FileEntry[]} rightEntries
 * @param {'name'|'size'|'mtime'|'both'} mode
 * @returns {CompareRow[]}
 *
 * CompareRow: {
 *   name, status, left: FileEntry|null, right: FileEntry|null
 * }
 */
function compareEntries(leftEntries, rightEntries, mode) {
  const leftMap = new Map(leftEntries.map((e) => [e.name, e]))
  const rightMap = new Map(rightEntries.map((e) => [e.name, e]))
  const allNames = new Set([...leftMap.keys(), ...rightMap.keys()])

  const rows = []
  for (const name of [...allNames].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  )) {
    const left = leftMap.get(name) ?? null
    const right = rightMap.get(name) ?? null
    const status = computeStatus(left, right, mode)
    rows.push({ name, status, left, right })
  }
  return rows
}

/**
 * 依 mode 計算單一檔案/目錄的狀態
 * @returns {'same'|'left-only'|'right-only'|'different'|'left-newer'|'right-newer'}
 */
function computeStatus(left, right, mode) {
  if (!right) return 'left-only'
  if (!left) return 'right-only'

  // 目錄：僅依名稱
  if (left.isDirectory && right.isDirectory) return 'same'

  if (mode === 'name') return 'same'

  const sizeDiff = left.size !== right.size
  const lTime = new Date(left.mtime).getTime()
  const rTime = new Date(right.mtime).getTime()
  const timeDiff = lTime !== rTime

  if (mode === 'size') {
    return sizeDiff ? 'different' : 'same'
  }

  if (mode === 'mtime') {
    if (!timeDiff) return 'same'
    return lTime > rTime ? 'left-newer' : 'right-newer'
  }

  // mode === 'both'
  if (!sizeDiff && !timeDiff) return 'same'
  if (sizeDiff) return 'different'
  // size 相同但時間不同
  return lTime > rTime ? 'left-newer' : 'right-newer'
}

// ── FolderCompare Class ───────────────────────────────────────────────────────

export class FolderCompare {
  /**
   * @param {object} [options]
   * @param {string} [options.leftPath]
   * @param {string} [options.rightPath]
   * @param {'name'|'size'|'mtime'|'both'} [options.mode]
   */
  constructor(options = {}) {
    this._leftPath = options.leftPath ?? null
    this._rightPath = options.rightPath ?? null
    this._mode = options.mode ?? 'mtime'

    this._leftEntries = []   // FileEntry[] for current left dir
    this._rightEntries = []  // FileEntry[] for current right dir

    // Visibility filters
    this._showSame = true
    this._showDiff = true
    this._showOrphan = true
    this._showLeftNewer = true   // T55
    this._showRightNewer = true  // T55
    this._filterStr = ''

    // Expanded directories: Set of "side:path"
    this._expanded = new Set()

    // Cached rows after compare+filter
    this._rows = []

    // Event handlers map
    this._handlers = {}

    // Container element (set by mount)
    this._container = null

    // Cached DOM refs
    this._dom = {}

    // Style tag injected into document
    this._styleInjected = false

    // Debounced filter handler
    this._debouncedApplyFilter = debounce(() => this._applyFilterAndRender(), 300)

    // Sync mode state
    this._syncMode = false
    this._syncDirection = 'left-to-right' // 'left-to-right' | 'right-to-left' | 'bidirectional'
    this._syncOps = []

    // Zip virtual entries (null if not a zip)
    this._leftZipEntries = null
    this._rightZipEntries = null

    // Batch selection: Set of path keys (leftPath || rightPath)
    this._selectedNames = new Set()

    // T54: Find bar state
    this._findQuery = ''
    this._findMatches = []   // Array of row elements matching find query
    this._findCursor = 0
    this._findBarVisible = false
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** 把 UI 渲染到 containerEl */
  mount(containerEl) {
    this._container = containerEl
    this._render()
    this._bindEvents()
    // Auto-scan if paths were provided via constructor options
    if (this._leftPath || this._rightPath) {
      this._scan()
    }
  }

  /** 呼叫 electronAPI.openFolder 取得左側路徑並掃描 */
  async openLeft() {
    const result = await window.electronAPI.openFolder()
    if (!result) return
    await this.setLeft(result.path)
  }

  /** 呼叫 electronAPI.openFolder 取得右側路徑並掃描 */
  async openRight() {
    const result = await window.electronAPI.openFolder()
    if (!result) return
    await this.setRight(result.path)
  }

  /** 開啟左側 Zip 檔案 */
  async openZipLeft() {
    const result = await window.electronAPI.openZip()
    if (!result) return
    this._leftPath = result.zipPath
    this._leftZipEntries = this._flattenZipEntries(result.entries)
    this._updatePathDisplay('left', `${result.zipPath} [ZIP]`)
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
    this._leftEntries = this._leftZipEntries.filter(e => e.depth === 0)
    this._rightEntries = this._rightZipEntries ?? this._rightEntries
    this._expanded.clear()
    this._compareAndRender()
  }

  /** 開啟右側 Zip 檔案 */
  async openZipRight() {
    const result = await window.electronAPI.openZip()
    if (!result) return
    this._rightPath = result.zipPath
    this._rightZipEntries = this._flattenZipEntries(result.entries)
    this._updatePathDisplay('right', `${result.zipPath} [ZIP]`)
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
    this._rightEntries = this._rightZipEntries.filter(e => e.depth === 0)
    this._leftEntries = this._leftZipEntries ?? this._leftEntries
    this._expanded.clear()
    this._compareAndRender()
  }

  /** 將 zip 扁平清單轉換為 FileEntry[] */
  _flattenZipEntries(entries) {
    return entries.map(e => ({
      name: e.name,
      path: e.path,
      isDirectory: e.isDirectory,
      size: e.size,
      mtime: e.mtime,
      depth: e.depth ?? 0,
      parentPath: e.parentPath,
      isZipEntry: true,
    }))
  }

  /** 直接設定左側路徑後自動掃描 */
  async setLeft(path) {
    this._leftPath = path
    this._updatePathDisplay('left', path)
    await this._scan()
  }

  /** 直接設定右側路徑後自動掃描 */
  async setRight(path) {
    this._rightPath = path
    this._updatePathDisplay('right', path)
    await this._scan()
  }

  /** 重新掃描兩側目錄 */
  async refresh() {
    await this._scan()
  }

  /**
   * 切換同步模式，回傳新狀態，並 emit 'sync-mode-changed'
   * @returns {boolean}
   */
  toggleSyncMode() {
    this._syncMode = !this._syncMode
    this._emit('sync-mode-changed', { syncMode: this._syncMode })
    // Update toolbar button appearance
    if (this._dom.btnSync) {
      this._dom.btnSync.classList.toggle('fc-btn-sync--active', this._syncMode)
      this._dom.btnSync.title = this._syncMode ? '退出同步模式' : '資料夾同步'
    }
    this._renderSyncPanel()
    return this._syncMode
  }

  /**
   * Compute folder-compare row statistics by status.
   * @returns {{ same: number, different: number, left_only: number, right_only: number, left_newer: number, right_newer: number, total: number }}
   */
  getRowStats() {
    const stats = { same: 0, different: 0, left_only: 0, right_only: 0, left_newer: 0, right_newer: 0, total: 0 }
    for (const row of (this._rows ?? [])) {
      if (row && Object.prototype.hasOwnProperty.call(stats, row.status)) {
        stats[row.status]++
      }
    }
    stats.total = stats.same + stats.different + stats.left_only + stats.right_only + stats.left_newer + stats.right_newer
    return stats
  }

  /**
   * Build the folder-compare HTML report string.
   * @returns {string}
   */
  buildHtmlReport() {
    const esc = (s) => (s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    const statusLabel = {
      same: '相同', different: '不同', left_only: '僅左側',
      right_only: '僅右側', left_newer: '左側較新', right_newer: '右側較新'
    }
    const statusColor = {
      same: '#fff', different: '#fffad7', left_only: '#d7ffd7',
      right_only: '#ffd7d7', left_newer: '#e8f0fe', right_newer: '#ffe8d7'
    }
    const stats = this.getRowStats()
    const timestamp = new Date().toLocaleString('zh-TW')

    const fmtSize = (n) => n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(1)} MB`
    const fmtDate = (s) => s ? new Date(s).toLocaleString('zh-TW') : ''

    const rows = (this._rows ?? []).map(row => {
      const bg = statusColor[row.status] ?? '#fff'
      const indent = '  '.repeat((row.depth ?? 0))
      const name = indent + esc(row.name ?? '')
      const lSize = fmtSize(row.left?.size)
      const rSize = fmtSize(row.right?.size)
      const lDate = fmtDate(row.left?.mtime)
      const rDate = fmtDate(row.right?.mtime)
      return `<tr style="background:${bg}">
  <td>${name}</td><td>${statusLabel[row.status] ?? row.status}</td>
  <td>${lSize}</td><td>${lDate}</td>
  <td>${rSize}</td><td>${rDate}</td>
</tr>`
    }).join('\n')

    return `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8">
<title>MyCompare — 資料夾比對報告</title>
<style>
body{font-family:sans-serif;font-size:13px;background:#fff;color:#222;margin:16px}
h2{margin-bottom:4px}
.paths{font-size:12px;color:#666;margin-bottom:12px}
.report-stats{font-size:12px;display:flex;flex-wrap:wrap;gap:10px;padding:8px 12px;
  background:#f5f5f5;border:1px solid #ddd;border-radius:4px;margin-bottom:12px}
.report-stats .stat-diff{color:#996c00;font-weight:600}
.report-stats .stat-leftonly{color:#067d39;font-weight:600}
.report-stats .stat-rightonly{color:#b3261e;font-weight:600}
.report-stats .stat-newer{color:#0052a3;font-weight:600}
.report-stats .ts{margin-left:auto;color:#888}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{padding:3px 8px;border:1px solid #ddd;text-align:left}
th{background:#f5f5f5;font-weight:600}
td:first-child{font-family:monospace;white-space:pre}
@media print{
  body{margin:8mm;font-size:10px}
  .no-print{display:none !important}
  table{page-break-inside:auto;font-size:10px}
  tr{page-break-inside:avoid;page-break-after:auto}
  thead{display:table-header-group}
}
</style>
</head><body>
<h2>資料夾比對報告</h2>
<div class="paths">左：${esc(this._leftPath || '（未知）')} &nbsp;|&nbsp; 右：${esc(this._rightPath || '（未知）')}</div>
<div class="report-stats">
  <div>相同: <span>${stats.same}</span></div>
  <div>不同: <span class="stat-diff">${stats.different}</span></div>
  <div>僅左側: <span class="stat-leftonly">${stats.left_only}</span></div>
  <div>僅右側: <span class="stat-rightonly">${stats.right_only}</span></div>
  <div>左側較新: <span class="stat-newer">${stats.left_newer}</span></div>
  <div>右側較新: <span class="stat-newer">${stats.right_newer}</span></div>
  <div class="ts">生成時間: ${esc(timestamp)}</div>
</div>
<table>
<thead><tr><th>名稱</th><th>狀態</th><th>左 大小</th><th>左 修改時間</th><th>右 大小</th><th>右 修改時間</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body></html>`
  }

  /**
   * Export folder diff as self-contained HTML report.
   * @param {{ print?: boolean }} [opts]
   */
  async exportHtml(opts = {}) {
    if (!this._rows.length) return
    const html = this.buildHtmlReport()
    if (opts.print) {
      try {
        const blob = new Blob([html], { type: 'text/html' })
        const url = URL.createObjectURL(blob)
        const win = window.open(url, '_blank')
        if (win) {
          win.addEventListener('load', () => {
            try { win.print() } catch { /* user cancelled */ }
          })
        }
      } catch {
        await window.electronAPI.saveFile('folder-report.html', html)
      }
      return
    }
    await window.electronAPI.saveFile('folder-report.html', html)
  }

  // ── Private: Sync panel ─────────────────────────────────────────────────────

  /** 在比對視圖上方顯示或移除同步面板 */
  _renderSyncPanel() {
    const root = this._dom.root
    if (!root) return

    const existingPanel = root.querySelector('.sync-panel')
    if (existingPanel) existingPanel.remove()

    if (!this._syncMode) return

    const panel = document.createElement('div')
    panel.className = 'sync-panel'
    panel.innerHTML = `
      <div class="sync-options">
        <label><input type="radio" name="sync-dir" value="left-to-right" checked> 左側 → 右側（鏡像到右側）</label>
        <label><input type="radio" name="sync-dir" value="right-to-left"> 右側 → 左側（鏡像到左側）</label>
        <label><input type="radio" name="sync-dir" value="bidirectional"> 雙向（各取較新版本）</label>
      </div>
      <div class="sync-actions">
        <button class="sync-btn" id="btn-sync-preview">預覽操作</button>
        <button class="sync-btn sync-btn--primary" id="btn-sync-execute" disabled>執行同步</button>
      </div>
    `

    // Insert panel after toolbar (before path-row)
    const toolbar = root.querySelector('.fc-toolbar')
    if (toolbar && toolbar.nextSibling) {
      root.insertBefore(panel, toolbar.nextSibling)
    } else {
      root.insertBefore(panel, root.firstChild)
    }

    // Radio change
    panel.querySelectorAll('input[name="sync-dir"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this._syncDirection = e.target.value
        panel.querySelector('#btn-sync-execute').disabled = true
        this._syncOps = []
        const existing = panel.querySelector('.sync-preview')
        if (existing) existing.remove()
      })
    })

    // Preview button
    panel.querySelector('#btn-sync-preview').addEventListener('click', async () => {
      await this._buildSyncOps()
      panel.querySelector('#btn-sync-execute').disabled = !this._syncOps?.length
      this._renderSyncPreview()
    })

    // Execute button
    panel.querySelector('#btn-sync-execute').addEventListener('click', async () => {
      await this._executeSyncOps()
    })
  }

  /** 根據 _rows 和 syncDirection 建立操作清單 */
  async _buildSyncOps() {
    this._syncOps = []
    for (const row of this._rows) {
      if (row.left?.isDirectory || row.right?.isDirectory) continue
      const dir = this._syncDirection
      const status = row.status

      if (dir === 'left-to-right') {
        if (status === 'left-only' || status === 'different' || status === 'left-newer') {
          this._syncOps.push({ op: 'copy', src: row.left.path, dest: this._buildDestPath(row.left.path, 'right'), label: row.left.path })
        } else if (status === 'right-only') {
          this._syncOps.push({ op: 'delete', path: row.right.path, label: row.right.path })
        }
      } else if (dir === 'right-to-left') {
        if (status === 'right-only' || status === 'different' || status === 'right-newer') {
          this._syncOps.push({ op: 'copy', src: row.right.path, dest: this._buildDestPath(row.right.path, 'left'), label: row.right.path })
        } else if (status === 'left-only') {
          this._syncOps.push({ op: 'delete', path: row.left.path, label: row.left.path })
        }
      } else { // bidirectional: 各取較新，孤兒雙向複製
        if (status === 'left-only') {
          this._syncOps.push({ op: 'copy', src: row.left.path, dest: this._buildDestPath(row.left.path, 'right'), label: row.left.path })
        } else if (status === 'right-only') {
          this._syncOps.push({ op: 'copy', src: row.right.path, dest: this._buildDestPath(row.right.path, 'left'), label: row.right.path })
        } else if (status === 'left-newer') {
          this._syncOps.push({ op: 'copy', src: row.left.path, dest: this._buildDestPath(row.left.path, 'right'), label: row.left.path })
        } else if (status === 'right-newer') {
          this._syncOps.push({ op: 'copy', src: row.right.path, dest: this._buildDestPath(row.right.path, 'left'), label: row.right.path })
        }
      }
    }
  }

  /**
   * 根據來源路徑和目標側計算目標路徑
   * @param {string} srcPath
   * @param {'left'|'right'} targetSide
   * @returns {string}
   */
  _buildDestPath(srcPath, targetSide) {
    if (targetSide === 'right') {
      const rel = srcPath.slice(this._leftPath.length)
      return this._rightPath + rel
    } else {
      const rel = srcPath.slice(this._rightPath.length)
      return this._leftPath + rel
    }
  }

  /** 在 sync-panel 下方顯示操作清單預覽 */
  _renderSyncPreview() {
    const root = this._dom.root
    const panel = root?.querySelector('.sync-panel')
    if (!panel) return

    const existing = panel.querySelector('.sync-preview')
    if (existing) existing.remove()

    if (!this._syncOps?.length) {
      const msg = document.createElement('div')
      msg.className = 'sync-preview sync-empty'
      msg.textContent = '✓ 無需同步（兩側已一致）'
      panel.appendChild(msg)
      return
    }

    const preview = document.createElement('div')
    preview.className = 'sync-preview'
    const opLabels = { copy: '複製', delete: '刪除' }
    preview.innerHTML = `
      <div class="sync-preview-title">待執行操作（共 ${this._syncOps.length} 項）：</div>
      <div class="sync-preview-list">
        ${this._syncOps.map(op => `
          <div class="sync-op sync-op--${op.op}">
            <span class="sync-op-type">${opLabels[op.op] ?? op.op}</span>
            <span class="sync-op-path">${op.label ?? op.src ?? op.path}</span>
          </div>
        `).join('')}
      </div>
    `
    panel.appendChild(preview)
  }

  /** 執行同步操作並顯示摘要 */
  async _executeSyncOps() {
    if (!this._syncOps?.length) return
    const root = this._dom.root
    const panel = root?.querySelector('.sync-panel')
    const execBtn = panel?.querySelector('#btn-sync-execute')
    if (execBtn) execBtn.disabled = true

    let done = 0, failed = 0
    for (const op of this._syncOps) {
      try {
        if (op.op === 'copy') {
          await window.electronAPI.copyFile(op.src, op.dest)
        } else if (op.op === 'delete') {
          if (confirm(`確定要刪除：${op.path}？`)) {
            await window.electronAPI.deleteFile(op.path)
          }
        }
        done++
      } catch (e) {
        failed++
        console.error('Sync op failed:', op, e)
      }
    }

    this._syncOps = []
    alert(`同步完成：${done} 項成功${failed ? `，${failed} 項失敗` : ''}`)
    await this.refresh()
  }

  // ── Private: Batch operations ───────────────────────────────────────────────

  /**
   * 更新批次操作按鈕狀態
   */
  _updateBatchButton() {
    const btnBatch = this._dom.btnBatch
    if (btnBatch) btnBatch.disabled = this._selectedNames.size === 0
  }

  /**
   * 批次複製選取的左側孤兒檔案到右側
   */
  async _batchCopyToRight() {
    if (!this._rightPath) { alert('請先選擇右側資料夾'); return }
    const rows = this._rows.filter(
      (r) => r.status === 'left-only' && r.left?.path && this._selectedNames.has(r.left.path)
    )
    if (!rows.length) { alert('沒有可複製的左側孤兒檔案'); return }
    let done = 0, failed = 0
    for (const row of rows) {
      try {
        const relative = row.left.path.slice(this._leftPath.length)
        const dest = this._rightPath + relative
        await window.electronAPI.copyFile(row.left.path, dest)
        done++
      } catch (e) {
        failed++
        console.error('batchCopyToRight failed:', row.left.path, e)
      }
    }
    alert(`批次複製完成：${done} 項成功${failed ? `，${failed} 項失敗` : ''}`)
    this._selectedNames.clear()
    await this.refresh()
  }

  /**
   * 批次複製選取的右側孤兒檔案到左側
   */
  async _batchCopyToLeft() {
    if (!this._leftPath) { alert('請先選擇左側資料夾'); return }
    const rows = this._rows.filter(
      (r) => r.status === 'right-only' && r.right?.path && this._selectedNames.has(r.right.path)
    )
    if (!rows.length) { alert('沒有可複製的右側孤兒檔案'); return }
    let done = 0, failed = 0
    for (const row of rows) {
      try {
        const relative = row.right.path.slice(this._rightPath.length)
        const dest = this._leftPath + relative
        await window.electronAPI.copyFile(row.right.path, dest)
        done++
      } catch (e) {
        failed++
        console.error('batchCopyToLeft failed:', row.right.path, e)
      }
    }
    alert(`批次複製完成：${done} 項成功${failed ? `，${failed} 項失敗` : ''}`)
    this._selectedNames.clear()
    await this.refresh()
  }

  /**
   * 批次刪除選取的檔案
   * @param {'left'|'right'} side
   */
  async _batchDelete(side) {
    if (!confirm(`確定要刪除 ${this._selectedNames.size} 個選取的檔案嗎？`)) return
    const paths = []
    for (const row of this._rows) {
      const path = side === 'left' ? row.left?.path : row.right?.path
      if (path && this._selectedNames.has(path)) {
        paths.push(path)
      }
    }
    if (!paths.length) { alert('沒有可刪除的項目'); return }
    let done = 0, failed = 0
    for (const path of paths) {
      try {
        await window.electronAPI.deleteFile(path)
        done++
      } catch (e) {
        failed++
        console.error('batchDelete failed:', path, e)
      }
    }
    alert(`批次刪除完成：${done} 項成功${failed ? `，${failed} 項失敗` : ''}`)
    this._selectedNames.clear()
    await this.refresh()
  }

  // ── T51: Advanced selection ─────────────────────────────────────────────────

  /** 勾選所有 left-newer rows */
  selectNewerLeft() {
    this._selectByStatus(['left-newer'], 'left')
  }

  /** 勾選所有 right-newer rows */
  selectNewerRight() {
    this._selectByStatus(['right-newer'], 'right')
  }

  /** 勾選所有 left-newer 和 right-newer rows */
  selectNewerBoth() {
    this._selectByStatus(['left-newer', 'right-newer'], 'both')
  }

  /** 勾選所有 left-only rows */
  selectOrphansLeft() {
    this._selectByStatus(['left-only'], 'left')
  }

  /** 勾選所有 right-only rows */
  selectOrphansRight() {
    this._selectByStatus(['right-only'], 'right')
  }

  /** 反選目前所有勾選狀態 */
  invertSelection() {
    const newSelected = new Set()
    for (const row of this._rows) {
      const key = row.left?.path || row.right?.path
      if (!key) continue
      if (!this._selectedNames.has(key)) {
        newSelected.add(key)
      }
    }
    this._selectedNames = newSelected
    this._updateBatchButton()
    this._syncCheckboxesFromSelected()
  }

  /**
   * 依 status 批次選取
   * @param {string[]} statuses
   * @param {'left'|'right'|'both'} keySide - 用哪一側路徑作為 key
   */
  _selectByStatus(statuses, keySide) {
    for (const row of this._rows) {
      if (!statuses.includes(row.status)) continue
      let key = null
      if (keySide === 'left') key = row.left?.path || row.right?.path
      else if (keySide === 'right') key = row.right?.path || row.left?.path
      else key = row.left?.path || row.right?.path
      if (key) this._selectedNames.add(key)
    }
    this._updateBatchButton()
    this._syncCheckboxesFromSelected()
  }

  /** 依 _selectedNames 同步所有 row checkbox 的 checked 狀態 */
  _syncCheckboxesFromSelected() {
    if (!this._dom.list) return
    this._dom.list.querySelectorAll('.fc-row').forEach((rowEl) => {
      const key = rowEl.dataset.leftPath || rowEl.dataset.rightPath
      const cb = rowEl.querySelector('.fc-row-cb')
      if (cb && key) cb.checked = this._selectedNames.has(key)
    })
  }

  // ── T56: Expand/Collapse All ─────────────────────────────────────────────────

  /** 遞迴收集所有頂層 isDir=true 的 entry key 並加入 _expanded */
  expandAll() {
    for (const row of this._rows) {
      if (row.left?.isDirectory || row.right?.isDirectory) {
        const expandKey = this._expandKey(0, row)
        this._expanded.add(expandKey)
      }
    }
    this._applyFilterAndRender()
  }

  /** 清空 _expanded，收合所有目錄 */
  collapseAll() {
    this._expanded.clear()
    this._applyFilterAndRender()
  }

  // ── T54: Find bar ────────────────────────────────────────────────────────────

  /**
   * 計算符合 query 的 row 索引清單（純函數，可單元測試）
   * @param {CompareRow[]} rows
   * @param {string} query
   * @returns {number[]} 符合 row 的索引
   */
  _computeFindMatches(rows, query) {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    const matches = []
    rows.forEach((row, i) => {
      const name = (row.name ?? '').toLowerCase()
      if (name.includes(q)) matches.push(i)
    })
    return matches
  }

  /** 開啟 find bar */
  _openFindBar() {
    this._findBarVisible = true
    if (this._dom.findBar) {
      this._dom.findBar.style.display = 'flex'
      this._dom.findInput?.focus()
    }
  }

  /** 關閉 find bar */
  _closeFindBar() {
    this._findBarVisible = false
    this._findQuery = ''
    this._findMatches = []
    this._findCursor = 0
    if (this._dom.findBar) {
      this._dom.findBar.style.display = 'none'
    }
    if (this._dom.findInput) this._dom.findInput.value = ''
    // 移除 highlight
    this._dom.list?.querySelectorAll('.fc-row--match').forEach(el => el.classList.remove('fc-row--match'))
    this._dom.list?.querySelectorAll('.fc-row--match-current').forEach(el => el.classList.remove('fc-row--match-current'))
  }

  /** 更新 find highlight */
  _updateFindHighlight() {
    if (!this._dom.list) return
    // 清除舊 highlight
    this._dom.list.querySelectorAll('.fc-row--match').forEach(el => el.classList.remove('fc-row--match'))
    this._dom.list.querySelectorAll('.fc-row--match-current').forEach(el => el.classList.remove('fc-row--match-current'))

    if (!this._findQuery.trim()) return

    const q = this._findQuery.toLowerCase()
    const allRowEls = Array.from(this._dom.list.querySelectorAll('.fc-row'))
    const matchEls = []
    for (const rowEl of allRowEls) {
      const name = (rowEl.dataset.name ?? '').toLowerCase()
      if (name.includes(q)) {
        rowEl.classList.add('fc-row--match')
        matchEls.push(rowEl)
      }
    }

    if (matchEls.length) {
      const idx = Math.min(this._findCursor, matchEls.length - 1)
      this._findCursor = idx
      matchEls[idx]?.classList.add('fc-row--match-current')
      matchEls[idx]?.scrollIntoView?.({ block: 'nearest' })
    }

    // 更新 status label
    if (this._dom.findStatus) {
      this._dom.findStatus.textContent = matchEls.length
        ? `${this._findCursor + 1} / ${matchEls.length}`
        : '無結果'
    }
  }

  /** 跳到下一個 match */
  findNext() {
    const q = this._findQuery.toLowerCase()
    if (!q) return
    const matchEls = Array.from(this._dom.list?.querySelectorAll('.fc-row--match') ?? [])
    if (!matchEls.length) return
    this._findCursor = (this._findCursor + 1) % matchEls.length
    this._updateFindHighlight()
  }

  /** 跳到上一個 match */
  findPrev() {
    const q = this._findQuery.toLowerCase()
    if (!q) return
    const matchEls = Array.from(this._dom.list?.querySelectorAll('.fc-row--match') ?? [])
    if (!matchEls.length) return
    this._findCursor = (this._findCursor - 1 + matchEls.length) % matchEls.length
    this._updateFindHighlight()
  }

  /** 卸載並清除 DOM、事件 */
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
  }

  /**
   * 訂閱事件
   * @param {'paths-changed'|'open-file-compare'} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = []
    this._handlers[event].push(handler)
    return this
  }

  // ── Private: emit ───────────────────────────────────────────────────────────

  _emit(event, ...args) {
    const handlers = this._handlers[event] ?? []
    for (const h of handlers) {
      try { h(...args) } catch (e) { console.error(`FolderCompare event ${event} handler error:`, e) }
    }
  }

  // ── Private: Initial render ─────────────────────────────────────────────────

  _render() {
    if (!this._container) return
    this._container.innerHTML = ''

    const root = el('div', { className: 'folder-compare' })

    // Toolbar
    root.appendChild(this._buildToolbar())

    // T54: Find bar (hidden by default)
    root.appendChild(this._buildFindBar())

    // Path row
    root.appendChild(this._buildPathRow())

    // Column header
    root.appendChild(this._buildHeader())

    // List
    const list = el('div', { className: 'fc-list' })
    this._dom.list = list
    root.appendChild(list)

    // Stats bar
    const stats = el('div', { className: 'fc-stats' })
    this._dom.stats = stats
    root.appendChild(stats)

    this._container.appendChild(root)
    this._dom.root = root

    // Render initial empty state
    this._renderList()
  }

  _buildToolbar() {
    const toolbar = el('div', { className: 'fc-toolbar' })

    // Compare mode select
    const modeSelect = el('select', { className: 'fc-compare-mode' })
    ;[
      { value: 'name',    label: '僅名稱' },
      { value: 'size',    label: '名稱+大小' },
      { value: 'mtime',   label: '名稱+修改時間' },
      { value: 'both',    label: '名稱+大小+時間' },
      { value: 'content', label: '內容 (MD5)' },
    ].forEach(({ value, label }) => {
      const opt = el('option', { value }, label)
      if (value === this._mode) opt.setAttribute('selected', '')
      modeSelect.appendChild(opt)
    })
    this._dom.modeSelect = modeSelect
    toolbar.appendChild(modeSelect)

    // Checkboxes
    const cbSame = this._buildCheckbox('fc-show-same', '顯示相同', this._showSame)
    this._dom.cbSame = cbSame.querySelector('input')
    toolbar.appendChild(cbSame)

    const cbDiff = this._buildCheckbox('fc-show-diff', '顯示差異', this._showDiff)
    this._dom.cbDiff = cbDiff.querySelector('input')
    toolbar.appendChild(cbDiff)

    const cbOrphan = this._buildCheckbox('fc-show-orphan', '顯示孤兒', this._showOrphan)
    this._dom.cbOrphan = cbOrphan.querySelector('input')
    toolbar.appendChild(cbOrphan)

    // T55: Left Newer / Right Newer toggle buttons
    const btnLeftNewer = el('button', {
      className: 'fc-btn-filter-toggle fc-btn-filter-toggle--active',
      title: '顯示左側較新',
      'data-filter': 'left-newer',
    }, '左較新')
    this._dom.btnLeftNewer = btnLeftNewer
    toolbar.appendChild(btnLeftNewer)

    const btnRightNewer = el('button', {
      className: 'fc-btn-filter-toggle fc-btn-filter-toggle--active',
      title: '顯示右側較新',
      'data-filter': 'right-newer',
    }, '右較新')
    this._dom.btnRightNewer = btnRightNewer
    toolbar.appendChild(btnRightNewer)

    // Filter input
    const filter = el('input', {
      type: 'text',
      className: 'fc-filter',
      placeholder: '篩選（如 *.js）',
    })
    this._dom.filter = filter
    toolbar.appendChild(filter)

    // Refresh button
    const btnRefresh = el('button', { className: 'fc-btn-refresh' }, '↺ 重新整理')
    this._dom.btnRefresh = btnRefresh
    toolbar.appendChild(btnRefresh)

    // Sync button
    const btnSync = el('button', { className: 'fc-btn-sync', title: '資料夾同步' }, '⇔ 同步')
    this._dom.btnSync = btnSync
    toolbar.appendChild(btnSync)

    // T56: Expand All / Collapse All buttons
    const btnExpandAll = el('button', { className: 'fc-btn-expand-all', title: '展開全部目錄' }, '⊞')
    this._dom.btnExpandAll = btnExpandAll
    toolbar.appendChild(btnExpandAll)

    const btnCollapseAll = el('button', { className: 'fc-btn-collapse-all', title: '收合全部目錄' }, '⊟')
    this._dom.btnCollapseAll = btnCollapseAll
    toolbar.appendChild(btnCollapseAll)

    // T51: Advanced selection dropdown
    const selectWrap = el('div', { className: 'fc-select-wrap' })
    const btnSelect = el('button', {
      className: 'fc-btn-select',
      title: '進階選取',
    }, '選取 ▾')
    this._dom.btnSelect = btnSelect

    const selectMenu = el('div', { className: 'fc-select-menu', style: 'display:none' })
    const selectItems = [
      { label: '選取左側較新', action: 'select-newer-left' },
      { label: '選取右側較新', action: 'select-newer-right' },
      { label: '選取兩側較新', action: 'select-newer-both' },
      { label: '選取左側孤兒', action: 'select-orphans-left' },
      { label: '選取右側孤兒', action: 'select-orphans-right' },
      { label: '反選', action: 'invert-selection' },
    ]
    for (const item of selectItems) {
      const btn = el('button', { className: 'fc-select-item', 'data-action': item.action }, item.label)
      selectMenu.appendChild(btn)
    }
    this._dom.selectMenu = selectMenu
    selectWrap.appendChild(btnSelect)
    selectWrap.appendChild(selectMenu)
    toolbar.appendChild(selectWrap)

    // ── Batch selection ───────────────────────────────────────────────────────

    // Select-all checkbox
    const cbSelectAllWrap = el('label', { className: 'fc-cb-select-all-wrap', title: '全選 / 取消全選' })
    const cbSelectAll = el('input', { type: 'checkbox', id: 'fc-cb-select-all' })
    cbSelectAllWrap.appendChild(cbSelectAll)
    cbSelectAllWrap.appendChild(document.createTextNode(' 全選'))
    this._dom.cbSelectAll = cbSelectAll
    toolbar.appendChild(cbSelectAllWrap)

    // Batch button + inline dropdown
    const batchWrap = el('div', { className: 'fc-batch-wrap' })
    const btnBatch = el('button', {
      className: 'fc-btn-batch',
      id: 'fc-btn-batch',
      disabled: 'true',
      title: '批次操作',
    }, '批次操作 ▾')
    btnBatch.disabled = true
    this._dom.btnBatch = btnBatch

    const batchMenu = el('div', { className: 'fc-batch-menu', style: 'display:none' })
    const batchItems = [
      { label: '複製選取到右側（左側孤兒）', action: 'copy-to-right' },
      { label: '複製選取到左側（右側孤兒）', action: 'copy-to-left' },
      { label: '刪除選取（左側）',           action: 'delete-left' },
      { label: '刪除選取（右側）',           action: 'delete-right' },
    ]
    for (const item of batchItems) {
      const btn = el('button', { className: 'fc-batch-item', 'data-action': item.action }, item.label)
      batchMenu.appendChild(btn)
    }
    this._dom.batchMenu = batchMenu

    batchWrap.appendChild(btnBatch)
    batchWrap.appendChild(batchMenu)
    toolbar.appendChild(batchWrap)

    return toolbar
  }

  /** 建立 find bar（T54），由 _render() 呼叫，預設隱藏 */
  _buildFindBar() {
    const bar = el('div', { className: 'fc-find-bar', style: 'display:none' })

    const findInput = el('input', {
      type: 'text',
      className: 'fc-find-input',
      placeholder: '搜尋檔名…',
    })
    this._dom.findInput = findInput
    bar.appendChild(findInput)

    const findStatus = el('span', { className: 'fc-find-status' }, '')
    this._dom.findStatus = findStatus
    bar.appendChild(findStatus)

    const btnFindPrev = el('button', { className: 'fc-find-nav', title: '上一個（Shift+F3）' }, '↑')
    bar.appendChild(btnFindPrev)

    const btnFindNext = el('button', { className: 'fc-find-nav', title: '下一個（F3）' }, '↓')
    bar.appendChild(btnFindNext)

    const btnFindClose = el('button', { className: 'fc-find-close', title: '關閉搜尋（Esc）' }, '✕')
    bar.appendChild(btnFindClose)

    this._dom.findBar = bar

    // Events
    findInput.addEventListener('input', () => {
      this._findQuery = findInput.value
      this._findCursor = 0
      this._updateFindHighlight()
    })

    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'F3' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        this.findNext()
      } else if ((e.key === 'F3' && e.shiftKey) || (e.key === 'Enter' && e.shiftKey)) {
        e.preventDefault()
        this.findPrev()
      } else if (e.key === 'Escape') {
        this._closeFindBar()
      }
    })

    btnFindNext.addEventListener('click', () => this.findNext())
    btnFindPrev.addEventListener('click', () => this.findPrev())
    btnFindClose.addEventListener('click', () => this._closeFindBar())

    return bar
  }

  _buildCheckbox(id, label, checked) {
    const cb = el('input', { type: 'checkbox', id })
    if (checked) cb.setAttribute('checked', '')
    cb.checked = checked
    const lbl = el('label')
    lbl.appendChild(cb)
    lbl.appendChild(document.createTextNode(' ' + label))
    return lbl
  }

  _buildPathRow() {
    const row = el('div', { className: 'fc-path-row' })

    // Left
    const leftCell = el('div', { className: 'fc-path-cell' })
    const btnLeft = el('button', { className: 'fc-open-btn', 'data-side': 'left' }, '開啟資料夾…')
    const btnZipLeft = el('button', { className: 'fc-open-btn', 'data-side': 'left', title: '開啟 Zip 檔案作為虛擬資料夾' }, '開啟 Zip…')
    const dispLeft = el('span', { className: 'fc-path-display', 'data-side': 'left' },
      this._leftPath ?? '（未選擇）')
    this._dom.btnOpenLeft = btnLeft
    this._dom.btnZipLeft = btnZipLeft
    this._dom.dispLeft = dispLeft
    this._dom.leftCell = leftCell
    leftCell.appendChild(btnLeft)
    leftCell.appendChild(btnZipLeft)
    leftCell.appendChild(dispLeft)

    // Right
    const rightCell = el('div', { className: 'fc-path-cell' })
    const btnRight = el('button', { className: 'fc-open-btn', 'data-side': 'right' }, '開啟資料夾…')
    const btnZipRight = el('button', { className: 'fc-open-btn', 'data-side': 'right', title: '開啟 Zip 檔案作為虛擬資料夾' }, '開啟 Zip…')
    const dispRight = el('span', { className: 'fc-path-display', 'data-side': 'right' },
      this._rightPath ?? '（未選擇）')
    this._dom.btnOpenRight = btnRight
    this._dom.btnZipRight = btnZipRight
    this._dom.dispRight = dispRight
    this._dom.rightCell = rightCell
    rightCell.appendChild(btnRight)
    rightCell.appendChild(btnZipRight)
    rightCell.appendChild(dispRight)

    row.appendChild(leftCell)
    row.appendChild(rightCell)
    return row
  }

  _buildHeader() {
    const header = el('div', { className: 'fc-header' })
    const cols = [
      { className: 'fc-col fc-col-name', text: '名稱' },
      { className: 'fc-col fc-col-size', text: '大小' },
      { className: 'fc-col fc-col-mtime', text: '修改時間' },
      { className: 'fc-col-sep', text: '' },
      { className: 'fc-col fc-col-name', text: '名稱' },
      { className: 'fc-col fc-col-size', text: '大小' },
      { className: 'fc-col fc-col-mtime', text: '修改時間' },
    ]
    for (const col of cols) {
      header.appendChild(el('div', { className: col.className }, col.text))
    }
    return header
  }

  // ── Private: Event binding ──────────────────────────────────────────────────

  _bindEvents() {
    const { modeSelect, cbSame, cbDiff, cbOrphan, filter,
            btnRefresh, btnSync, btnOpenLeft, btnOpenRight, btnZipLeft, btnZipRight, list,
            cbSelectAll, btnBatch, batchMenu,
            btnLeftNewer, btnRightNewer,
            btnExpandAll, btnCollapseAll,
            btnSelect, selectMenu } = this._dom

    btnOpenLeft.addEventListener('click', () => this.openLeft())
    btnOpenRight.addEventListener('click', () => this.openRight())
    btnZipLeft?.addEventListener('click', () => this.openZipLeft())
    btnZipRight?.addEventListener('click', () => this.openZipRight())

    btnSync.addEventListener('click', () => this.toggleSyncMode())

    // T55: Left Newer / Right Newer toggles
    btnLeftNewer?.addEventListener('click', () => {
      this._showLeftNewer = !this._showLeftNewer
      btnLeftNewer.classList.toggle('fc-btn-filter-toggle--active', this._showLeftNewer)
      this._applyFilterAndRender()
    })

    btnRightNewer?.addEventListener('click', () => {
      this._showRightNewer = !this._showRightNewer
      btnRightNewer.classList.toggle('fc-btn-filter-toggle--active', this._showRightNewer)
      this._applyFilterAndRender()
    })

    // T56: Expand All / Collapse All
    btnExpandAll?.addEventListener('click', () => this.expandAll())
    btnCollapseAll?.addEventListener('click', () => this.collapseAll())

    // T51: Advanced selection dropdown
    btnSelect?.addEventListener('click', (e) => {
      e.stopPropagation()
      if (selectMenu) {
        const isVisible = selectMenu.style.display !== 'none'
        selectMenu.style.display = isVisible ? 'none' : 'block'
      }
    })

    selectMenu?.addEventListener('click', (e) => {
      const btn = e.target.closest('.fc-select-item')
      if (!btn) return
      if (selectMenu) selectMenu.style.display = 'none'
      const action = btn.dataset.action
      if (action === 'select-newer-left')   this.selectNewerLeft()
      else if (action === 'select-newer-right')  this.selectNewerRight()
      else if (action === 'select-newer-both')   this.selectNewerBoth()
      else if (action === 'select-orphans-left') this.selectOrphansLeft()
      else if (action === 'select-orphans-right')this.selectOrphansRight()
      else if (action === 'invert-selection')    this.invertSelection()
    })

    // ── Batch selection ───────────────────────────────────────────────────────

    // Row checkbox delegation
    list.addEventListener('change', (e) => {
      const cb = e.target.closest('.fc-row-cb')
      if (!cb) return
      const rowEl = cb.closest('.fc-row')
      if (!rowEl) return
      const key = rowEl.dataset.leftPath || rowEl.dataset.rightPath
      if (!key) return
      if (cb.checked) this._selectedNames.add(key)
      else this._selectedNames.delete(key)
      this._updateBatchButton()
    })

    // Select-all checkbox
    cbSelectAll?.addEventListener('change', () => {
      const checked = cbSelectAll.checked
      this._selectedNames.clear()
      if (checked) {
        list.querySelectorAll('.fc-row').forEach((r) => {
          const key = r.dataset.leftPath || r.dataset.rightPath
          if (key) this._selectedNames.add(key)
        })
      }
      list.querySelectorAll('.fc-row-cb').forEach((cb) => { cb.checked = checked })
      this._updateBatchButton()
    })

    // Toggle batch dropdown
    btnBatch?.addEventListener('click', (e) => {
      e.stopPropagation()
      if (batchMenu) {
        const isVisible = batchMenu.style.display !== 'none'
        batchMenu.style.display = isVisible ? 'none' : 'block'
      }
    })

    // Batch menu item clicks
    batchMenu?.addEventListener('click', async (e) => {
      const btn = e.target.closest('.fc-batch-item')
      if (!btn) return
      if (batchMenu) batchMenu.style.display = 'none'
      const action = btn.dataset.action
      if (action === 'copy-to-right') await this._batchCopyToRight()
      else if (action === 'copy-to-left') await this._batchCopyToLeft()
      else if (action === 'delete-left') await this._batchDelete('left')
      else if (action === 'delete-right') await this._batchDelete('right')
    })

    // Close batch menu and select menu on outside click
    document.addEventListener('click', () => {
      if (batchMenu) batchMenu.style.display = 'none'
      if (selectMenu) selectMenu.style.display = 'none'
    })

    modeSelect.addEventListener('change', () => {
      this._mode = modeSelect.value
      this._compareAndRender()
    })

    cbSame.addEventListener('change', () => {
      this._showSame = cbSame.checked
      this._applyFilterAndRender()
    })
    cbDiff.addEventListener('change', () => {
      this._showDiff = cbDiff.checked
      this._applyFilterAndRender()
    })
    cbOrphan.addEventListener('change', () => {
      this._showOrphan = cbOrphan.checked
      this._applyFilterAndRender()
    })

    filter.addEventListener('input', () => {
      this._filterStr = filter.value
      this._debouncedApplyFilter()
    })

    btnRefresh.addEventListener('click', () => this.refresh())

    // Drag-drop: drop a folder onto left or right path cell
    const addDropZone = (cell, side) => {
      if (!cell) return
      cell.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' })
      cell.addEventListener('drop', async (e) => {
        e.preventDefault()
        const file = e.dataTransfer.files[0]
        if (!file) return
        const filePath = file.path
        if (!filePath) return
        try {
          await window.electronAPI.readDir(filePath)
          if (side === 'left') await this.setLeft(filePath)
          else await this.setRight(filePath)
        } catch { /* not a directory, ignore */ }
      })
    }
    addDropZone(this._dom.leftCell, 'left')
    addDropZone(this._dom.rightCell, 'right')

    // T54: Ctrl+F → open find bar; F3 / Shift+F3 → navigate; Esc → close
    document.addEventListener('keydown', (e) => {
      if (!this._container) return
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault()
        this._openFindBar()
      } else if (e.key === 'F3') {
        e.preventDefault()
        if (!this._findBarVisible) this._openFindBar()
        else if (e.shiftKey) this.findPrev()
        else this.findNext()
      }
    })

    // Row interaction (delegated)
    list.addEventListener('dblclick', (e) => this._onRowDblClick(e))
    list.addEventListener('click', (e) => this._onRowClick(e))
    list.addEventListener('contextmenu', (e) => this._onRowContextMenu(e))
  }

  // ── Private: Scan ───────────────────────────────────────────────────────────

  async _scan() {
    if (!this._leftPath && !this._rightPath) {
      this._rows = []
      this._renderList()
      return
    }

    this._renderLoading()

    try {
      const [leftEntries, rightEntries] = await Promise.all([
        this._leftPath  ? window.electronAPI.readDir(this._leftPath)  : Promise.resolve([]),
        this._rightPath ? window.electronAPI.readDir(this._rightPath) : Promise.resolve([]),
      ])
      this._leftEntries = leftEntries
      this._rightEntries = rightEntries
      this._expanded.clear()
      this._compareAndRender()
      this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
    } catch (err) {
      console.error('FolderCompare._scan error:', err)
      this._renderError(err.message)
    }
  }

  /** 執行比對並更新 this._rows，然後重新渲染 */
  async _compareAndRender() {
    // 清空批次選取狀態
    this._selectedNames.clear()
    this._updateBatchButton()
    if (this._dom.cbSelectAll) this._dom.cbSelectAll.checked = false

    // 先以 'both'（名稱+大小+時間）做初步比對；content 模式再進一步以 MD5 確認
    const baseMode = this._mode === 'content' ? 'both' : this._mode
    this._rows = compareEntries(this._leftEntries, this._rightEntries, baseMode)

    if (this._mode === 'content' && window.electronAPI?.hashFile) {
      await this._applyContentHash()
    }

    this._applyFilterAndRender()
  }

  /**
   * 對需要進一步確認的列（size 相同但 mtime 不同，或 'different'）
   * 計算雙側 MD5；若 hash 相同則改為 'same'。
   */
  async _applyContentHash() {
    const candidates = this._rows.filter(row =>
      !row.left?.isDirectory &&
      !row.right?.isDirectory &&
      row.left?.path &&
      row.right?.path &&
      (row.status === 'left-newer' || row.status === 'right-newer' || row.status === 'different')
    )

    await Promise.all(candidates.map(async (row) => {
      try {
        const [lHash, rHash] = await Promise.all([
          window.electronAPI.hashFile(row.left.path),
          window.electronAPI.hashFile(row.right.path),
        ])
        if (lHash && rHash && lHash === rHash) {
          row.status = 'same'
        }
      } catch {
        // 無法 hash 則維持原狀態
      }
    }))
  }

  // ── Private: Filter ─────────────────────────────────────────────────────────

  _applyFilterAndRender() {
    const visible = this._rows.filter((row) => this._isRowVisible(row))
    this._renderRows(visible)
    this._renderStats(this._rows)
  }

  _isRowVisible(row) {
    // Visibility checkboxes
    if (row.status === 'same' && !this._showSame) return false
    if (['different', 'left-newer', 'right-newer'].includes(row.status) && !this._showDiff) return false
    if (['left-only', 'right-only'].includes(row.status) && !this._showOrphan) return false

    // T55: Left Newer / Right Newer individual toggles
    if (row.status === 'left-newer' && !this._showLeftNewer) return false
    if (row.status === 'right-newer' && !this._showRightNewer) return false

    // Filter string
    if (this._filterStr.trim()) {
      return matchesFilter(row.name, this._filterStr)
    }
    return true
  }

  // ── Private: Render ─────────────────────────────────────────────────────────

  _renderLoading() {
    if (!this._dom.list) return
    this._dom.list.innerHTML = ''
    this._dom.list.appendChild(
      el('div', { className: 'fc-loading' }, '⌛ 掃描中…')
    )
  }

  _renderError(msg) {
    if (!this._dom.list) return
    this._dom.list.innerHTML = ''
    this._dom.list.appendChild(
      el('div', { className: 'fc-empty-state' },
        el('span', { className: 'fc-empty-icon' }, '⚠️'),
        el('span', {}, `錯誤：${msg}`)
      )
    )
  }

  _renderList() {
    if (!this._dom.list) return
    if (!this._leftPath && !this._rightPath) {
      this._dom.list.innerHTML = ''
      this._dom.list.appendChild(
        el('div', { className: 'fc-empty-state' },
          el('span', { className: 'fc-empty-icon' }, '📁'),
          el('span', {}, '請選擇左側或右側資料夾')
        )
      )
      return
    }
    this._applyFilterAndRender()
  }

  /**
   * 渲染一組 CompareRow 到 list
   * @param {CompareRow[]} rows
   * @param {HTMLElement} [parentEl] - 預設為 this._dom.list（頂層）
   * @param {number} [depth]
   */
  _renderRows(rows, parentEl = null, depth = 0) {
    const target = parentEl ?? this._dom.list
    if (!target) return

    if (!parentEl) {
      // 頂層：清空後重繪
      target.innerHTML = ''
    }

    if (!rows.length) {
      if (!parentEl) {
        target.appendChild(
          el('div', { className: 'fc-empty-state' },
            el('span', { className: 'fc-empty-icon' }, '✓'),
            el('span', {}, '沒有符合條件的項目')
          )
        )
      }
      return
    }

    const fragment = document.createDocumentFragment()
    for (const row of rows) {
      const rowEl = this._buildRow(row, depth)
      fragment.appendChild(rowEl)

      // 如果是已展開的目錄，插入子列表容器
      const expandKey = this._expandKey(depth, row)
      if (row.status === 'same' && row.left?.isDirectory && this._expanded.has(expandKey)) {
        const subContainer = el('div', {
          className: 'fc-sublist',
          'data-expand-key': expandKey,
        })
        fragment.appendChild(subContainer)
        // 子目錄內容由 _onRowClick 異步填入
      }
    }
    target.appendChild(fragment)
  }

  _expandKey(depth, row) {
    const lp = row.left?.path ?? ''
    const rp = row.right?.path ?? ''
    return `${depth}:${lp}|${rp}`
  }

  _buildRow(row, depth = 0) {
    const isDir = !!(row.left?.isDirectory || row.right?.isDirectory)

    const rowEl = el('div', {
      className: `fc-row ${row.status}${isDir ? ' is-dir' : ''}`,
      'data-name': row.name,
      'data-left-path': row.left?.path ?? '',
      'data-right-path': row.right?.path ?? '',
      'data-status': row.status,
      'data-is-dir': isDir ? 'true' : 'false',
      'data-depth': String(depth),
    })

    // Row checkbox (for batch selection)
    const cb = el('input', {
      type: 'checkbox',
      className: 'fc-row-cb',
      'data-name': row.name,
      'data-left-path': row.left?.path ?? '',
      'data-right-path': row.right?.path ?? '',
    })
    const key = row.left?.path || row.right?.path
    if (key && this._selectedNames.has(key)) cb.checked = true
    rowEl.appendChild(cb)

    // Left cell
    const leftCell = this._buildCell(row.left, isDir, depth,
      row.status === 'right-only', row.status, 'left')
    // Separator
    const sep = el('div', { className: 'fc-row-sep' })
    // Right cell
    const rightCell = this._buildCell(row.right, isDir, depth,
      row.status === 'left-only', row.status, 'right')

    rowEl.appendChild(leftCell)
    rowEl.appendChild(sep)
    rowEl.appendChild(rightCell)

    return rowEl
  }

  /**
   * @param {FileEntry|null} entry
   * @param {boolean} isDir
   * @param {number} depth
   * @param {boolean} isEmpty - 孤兒側（對側沒有此檔案）
   * @param {string} status
   * @param {'left'|'right'} side
   */
  _buildCell(entry, isDir, depth, isEmpty, status, side) {
    if (isEmpty || !entry) {
      return el('div', { className: 'fc-cell fc-cell-empty fc-cell-' + side })
    }

    const cell = el('div', { className: `fc-cell fc-cell-${side}` })

    // Prefix: indent + toggle + icon (all in one flex container = single grid column)
    const prefix = el('div', { className: 'fc-prefix' })
    if (depth > 0) {
      const indent = el('span', { className: 'fc-indent' })
      indent.style.width = `${depth * 16}px`
      prefix.appendChild(indent)
    }
    if (isDir) {
      prefix.appendChild(el('span', { className: 'fc-toggle' }, '▶'))
    } else {
      prefix.appendChild(el('span', { className: 'fc-toggle' }, ''))
    }
    prefix.appendChild(el('span', { className: 'fc-icon' }, isDir ? '📁' : '📄'))
    cell.appendChild(prefix)

    // Name
    const name = el('span', { className: 'fc-name' }, entry.name)
    cell.appendChild(name)

    // Size (files only)
    const sizeEl = el('span', { className: 'fc-size' },
      isDir ? '' : formatSize(entry.size))
    cell.appendChild(sizeEl)

    // Mtime
    const mtimeEl = el('span', { className: 'fc-mtime' }, formatMtime(entry.mtime))
    cell.appendChild(mtimeEl)

    return cell
  }

  _renderStats(rows) {
    if (!this._dom.stats) return
    const stats = this._dom.stats
    stats.innerHTML = ''

    if (!rows.length) return

    const counts = {}
    for (const row of rows) {
      counts[row.status] = (counts[row.status] ?? 0) + 1
    }

    const defs = [
      { key: 'same',        label: '相同' },
      { key: 'left-only',   label: '僅左側' },
      { key: 'right-only',  label: '僅右側' },
      { key: 'different',   label: '不同' },
      { key: 'left-newer',  label: '左較新' },
      { key: 'right-newer', label: '右較新' },
    ]

    for (const { key, label } of defs) {
      const count = counts[key]
      if (!count) continue
      const item = el('span', { className: 'fc-stat-item' })
      item.appendChild(el('span', { className: `fc-stat-dot ${key}` }))
      item.appendChild(document.createTextNode(`${label}: ${count}`))
      stats.appendChild(item)
    }

    const total = rows.length
    const totalEl = el('span', { className: 'fc-stat-item' }, `共 ${total} 項`)
    totalEl.style.marginLeft = 'auto'
    stats.appendChild(totalEl)
  }

  // ── Private: Interaction ────────────────────────────────────────────────────

  _onRowClick(e) {
    const rowEl = e.target.closest('.fc-row')
    if (!rowEl) return
    const isDir = rowEl.dataset.isDir === 'true'
    if (!isDir) return

    const depth = parseInt(rowEl.dataset.depth ?? '0', 10)
    const leftPath = rowEl.dataset.leftPath
    const rightPath = rowEl.dataset.rightPath
    const name = rowEl.dataset.name

    // Reconstruct a minimal row object to compute expand key
    const row = {
      name,
      status: rowEl.dataset.status,
      left:  leftPath  ? { path: leftPath,  isDirectory: true } : null,
      right: rightPath ? { path: rightPath, isDirectory: true } : null,
    }
    const expandKey = this._expandKey(depth, row)

    if (this._expanded.has(expandKey)) {
      this._collapseDir(rowEl, expandKey)
    } else {
      this._expandDir(rowEl, expandKey, leftPath, rightPath, depth + 1)
    }
  }

  _onRowDblClick(e) {
    const rowEl = e.target.closest('.fc-row')
    if (!rowEl) return

    const isDir = rowEl.dataset.isDir === 'true'
    if (isDir) return // 目錄單擊展開，不觸發 open-file-compare

    const leftPath = rowEl.dataset.leftPath || ''
    const rightPath = rowEl.dataset.rightPath || ''
    if (!leftPath && !rightPath) return

    this._emit('open-file-compare', { leftPath, rightPath })
  }

  // ── Private: Context menu ───────────────────────────────────────────────────

  _onRowContextMenu(e) {
    const rowEl = (e.target instanceof Element ? e.target : null)?.closest('.fc-row')
    if (!rowEl) return

    const status   = rowEl.dataset.status
    const isDir    = rowEl.dataset.isDir === 'true'
    const leftPath = rowEl.dataset.leftPath  || ''
    const rightPath= rowEl.dataset.rightPath || ''
    const name     = rowEl.dataset.name      || ''

    const items = []

    // ── 開啟比對（檔案）──
    if (!isDir && leftPath && rightPath &&
        ['same', 'different', 'left-newer', 'right-newer'].includes(status)) {
      items.push({
        label: '開啟比對',
        action: () => this._emit('open-file-compare', { leftPath, rightPath })
      })
      items.push({ separator: true })
    }

    // ── 在檔案總管中顯示 ──
    if (leftPath) {
      items.push({
        label: isDir ? '在檔案總管中顯示（左側資料夾）' : '在檔案總管中顯示（左側）',
        action: () => window.electronAPI.showInExplorer(leftPath)
      })
    }
    if (rightPath) {
      items.push({
        label: isDir ? '在檔案總管中顯示（右側資料夾）' : '在檔案總管中顯示（右側）',
        action: () => window.electronAPI.showInExplorer(rightPath)
      })
    }

    // ── 複製 / 刪除（僅檔案）──
    if (!isDir) {
      if (status === 'different' || status === 'left-newer' || status === 'right-newer') {
        if (leftPath && rightPath) {
          items.push({ separator: true })
          items.push({
            label: '複製左側 → 覆蓋右側',
            action: async () => {
              if (!confirm(`確定要用左側檔案覆蓋右側的「${name}」嗎？`)) return
              try {
                await window.electronAPI.copyFile(leftPath, rightPath)
                await this.refresh()
              } catch (err) { alert(`複製失敗：${err.message}`) }
            }
          })
          items.push({
            label: '複製右側 → 覆蓋左側',
            action: async () => {
              if (!confirm(`確定要用右側檔案覆蓋左側的「${name}」嗎？`)) return
              try {
                await window.electronAPI.copyFile(rightPath, leftPath)
                await this.refresh()
              } catch (err) { alert(`複製失敗：${err.message}`) }
            }
          })
        }
      }

      if (status === 'left-only' && this._rightPath) {
        // Compute destination by replacing left base with right base
        const relative = leftPath.slice(this._leftPath.length)
        const dest = this._rightPath + relative
        items.push({ separator: true })
        items.push({
          label: '複製到右側',
          action: async () => {
            try {
              await window.electronAPI.copyFile(leftPath, dest)
              await this.refresh()
            } catch (err) { alert(`複製失敗：${err.message}`) }
          }
        })
        items.push({ separator: true })
        items.push({
          label: `刪除（左側「${name}」）`,
          action: async () => {
            if (!confirm(`確定要刪除左側的「${name}」嗎？此操作無法復原。`)) return
            try {
              await window.electronAPI.deleteFile(leftPath)
              await this.refresh()
            } catch (err) { alert(`刪除失敗：${err.message}`) }
          }
        })
      }

      if (status === 'right-only' && this._leftPath) {
        const relative = rightPath.slice(this._rightPath.length)
        const dest = this._leftPath + relative
        items.push({ separator: true })
        items.push({
          label: '複製到左側',
          action: async () => {
            try {
              await window.electronAPI.copyFile(rightPath, dest)
              await this.refresh()
            } catch (err) { alert(`複製失敗：${err.message}`) }
          }
        })
        items.push({ separator: true })
        items.push({
          label: `刪除（右側「${name}」）`,
          action: async () => {
            if (!confirm(`確定要刪除右側的「${name}」嗎？此操作無法復原。`)) return
            try {
              await window.electronAPI.deleteFile(rightPath)
              await this.refresh()
            } catch (err) { alert(`刪除失敗：${err.message}`) }
          }
        })
      }
    }

    // Algorithm shortcuts for differing files
    if (!isDir && leftPath && rightPath) {
      items.push({ separator: true })
      for (const [algo, label] of [
        ['myers',     'Myers 比對'],
        ['patience',  'Patience 比對'],
        ['histogram', 'Histogram 比對'],
      ]) {
        items.push({
          label,
          action: () => this._emit('open-file-compare', {
            leftPath,
            rightPath,
            algorithm: algo,
          }),
        })
      }
    }

    // T52: Rename
    if (leftPath || rightPath) {
      items.push({ separator: true })
      const renamePath = leftPath || rightPath
      items.push({
        label: '重新命名…',
        action: async () => {
          const newName = prompt(`重新命名「${name}」：`, name)
          if (!newName || newName === name) return
          const dir = renamePath.slice(0, renamePath.length - name.length)
          const newPath = dir + newName
          try {
            await window.electronAPI.renameFile(renamePath, newPath)
            await this.refresh()
          } catch (err) {
            alert(`重新命名失敗：${err.message}`)
          }
        }
      })
    }

    // T53: New Folder
    {
      items.push({
        label: '新建資料夾（左側）…',
        action: async () => {
          if (!this._leftPath) { alert('請先選擇左側資料夾'); return }
          const folderName = prompt('新資料夾名稱：')
          if (!folderName) return
          try {
            await window.electronAPI.mkdirFolder(this._leftPath + '/' + folderName)
            await this.refresh()
          } catch (err) {
            alert(`建立失敗：${err.message}`)
          }
        }
      })
      items.push({
        label: '新建資料夾（右側）…',
        action: async () => {
          if (!this._rightPath) { alert('請先選擇右側資料夾'); return }
          const folderName = prompt('新資料夾名稱：')
          if (!folderName) return
          try {
            await window.electronAPI.mkdirFolder(this._rightPath + '/' + folderName)
            await this.refresh()
          } catch (err) {
            alert(`建立失敗：${err.message}`)
          }
        }
      })
    }

    if (items.length) showContextMenu(e, items)
  }

  // ── Private: Directory expand/collapse ──────────────────────────────────────

  async _expandDir(rowEl, expandKey, leftPath, rightPath, childDepth) {
    this._expanded.add(expandKey)

    // Update toggle arrow
    const toggle = rowEl.querySelector('.fc-toggle')
    if (toggle) toggle.textContent = '▼'

    // Check for existing sub-container
    let subContainer = rowEl.nextElementSibling
    if (subContainer?.dataset?.expandKey === expandKey) {
      subContainer.style.display = ''
      return
    }

    // Create sub-container and insert after rowEl
    subContainer = el('div', {
      className: 'fc-sublist',
      'data-expand-key': expandKey,
    })
    rowEl.insertAdjacentElement('afterend', subContainer)

    // Loading indicator
    subContainer.appendChild(el('div', { className: 'fc-loading' }, '⌛ 載入中…'))

    try {
      const [leftChildren, rightChildren] = await Promise.all([
        leftPath  ? window.electronAPI.readDir(leftPath)  : Promise.resolve([]),
        rightPath ? window.electronAPI.readDir(rightPath) : Promise.resolve([]),
      ])

      const childRows = compareEntries(leftChildren, rightChildren, this._mode)
      const visible = childRows.filter((r) => this._isRowVisible(r))

      subContainer.innerHTML = ''
      this._renderRows(visible, subContainer, childDepth)
    } catch (err) {
      console.error('FolderCompare._expandDir error:', err)
      subContainer.innerHTML = ''
      subContainer.appendChild(
        el('div', { className: 'fc-loading' }, `⚠️ ${err.message}`)
      )
    }
  }

  _collapseDir(rowEl, expandKey) {
    this._expanded.delete(expandKey)

    // Update toggle arrow
    const toggle = rowEl.querySelector('.fc-toggle')
    if (toggle) toggle.textContent = '▶'

    // Hide sub-container
    const subContainer = rowEl.nextElementSibling
    if (subContainer?.dataset?.expandKey === expandKey) {
      subContainer.style.display = 'none'
    }
  }

  // ── Private: Path display update ────────────────────────────────────────────

  _updatePathDisplay(side, path) {
    const dom = side === 'left' ? this._dom.dispLeft : this._dom.dispRight
    if (dom) dom.textContent = path
  }
}

// ── Exports for unit testing ────────────────────────────────────────────────
export { compareEntries, matchesFilter, computeStatus }

/**
 * 純函數：計算符合 query 的 row 索引清單（供單元測試使用）
 * @param {Array<{name: string}>} rows
 * @param {string} query
 * @returns {number[]}
 */
export function computeFindMatches(rows, query) {
  if (!query.trim()) return []
  const q = query.toLowerCase()
  const matches = []
  rows.forEach((row, i) => {
    const name = (row.name ?? '').toLowerCase()
    if (name.includes(q)) matches.push(i)
  })
  return matches
}
