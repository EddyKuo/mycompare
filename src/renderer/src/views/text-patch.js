/**
 * Text Patch — BC's standalone view for a unified diff file.
 *
 * A patch is not a comparison of two files you have; it is a description of a
 * change. This view reconstructs the two sides from that description and lets
 * you walk it the way BC does — by difference, by section (hunk), and by file —
 * then optionally write the change to disk.
 *
 * Apply Patch is the only part that touches anything. It is deliberately
 * all-or-nothing per file: `patch(1)` applies what it can and drops the rest in
 * a .rej file, but a GUI doing that would leave a file that is neither the old
 * one nor the new one, with nothing on disk saying which. The rules live in
 * `core/patch-apply.js`, away from the DOM, because that is the part that must
 * be right.
 */
import { isActive } from '../core/active-view.js'
import { showContextMenu, closeContextMenu } from '../core/context-menu.js'
import { confirm as confirmDialog, prompt as promptDialog } from '../core/modal.js'
import { el } from '../core/utils.js'
import { toast } from '../core/toast.js'
import { stepDiffIndex, navResult, getNavOptions } from '../core/diff-nav.js'
import { parseUnifiedDiff, UnifiedDiffParseError } from '../core/patch.js'
import { applyHunks, targetPath } from '../core/patch-apply.js'
import '../styles/text-patch.css'

/** Row height in px; must match --tp-row-height in the stylesheet. */
const ROW_HEIGHT = 18
/** Rows drawn above and below the viewport. */
const OVERSCAN = 12

/**
 * Flatten a parsed patch into the rows the two panes draw.
 *
 * File and hunk headers are emitted on both sides so the panes stay aligned;
 * a `-` line leaves the right pane empty and a `+` line the left, which is what
 * makes a change read as a change rather than as two unrelated lines.
 *
 * @param {import('../core/patch.js').PatchFile[]} files
 * @returns {Array<object>}
 */
export function buildPatchRows(files) {
  /** @type {Array<object>} */
  const rows = []
  ;(files ?? []).forEach((file, fileIdx) => {
    rows.push({
      kind: 'file', fileIdx, hunkIdx: -1,
      left: `── ${file.oldPath}`, right: `── ${file.newPath}`,
    })
    file.hunks.forEach((hunk, hunkIdx) => {
      const header = `@@ -${hunk.oldStart},${hunk.oldCount} `
        + `+${hunk.newStart},${hunk.newCount} @@${hunk.section}`
      rows.push({ kind: 'hunk', fileIdx, hunkIdx, left: header, right: header })
      let oldNo = hunk.oldStart
      let newNo = hunk.newStart
      for (const line of hunk.lines) {
        if (line.type === ' ') {
          rows.push({
            kind: 'same', fileIdx, hunkIdx,
            leftNo: oldNo++, rightNo: newNo++, left: line.text, right: line.text,
          })
        } else if (line.type === '-') {
          rows.push({
            kind: 'delete', fileIdx, hunkIdx,
            leftNo: oldNo++, rightNo: null, left: line.text, right: null,
          })
        } else {
          rows.push({
            kind: 'insert', fileIdx, hunkIdx,
            leftNo: null, rightNo: newNo++, left: null, right: line.text,
          })
        }
      }
    })
  })
  return rows
}

export class TextPatch {
  constructor() {
    /** @type {string} */
    this._path = ''
    /** @type {import('../core/patch.js').PatchFile[]} */
    this._files = []
    /** @type {Array<object>} */
    this._rows = []
    /** @type {number} */
    this._currentDiffIdx = -1
    /** @type {number} */
    this._selected = -1
    /** @type {'side'|'over'} */
    this._layout = 'side'
    this._showLineNumbers = true
    this._showWhitespace = false

    this._windowFirst = null
    this._windowLast = null

    /** @type {Record<string, Function[]>} */
    this._handlers = {}
    /** @type {HTMLElement|null} */
    this._container = null
    /** @type {Record<string, HTMLElement>} */
    this._dom = {}
    this._mounted = false
    this._onKeyDown = this._onKeyDown.bind(this)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** @param {HTMLElement} containerEl */
  mount(containerEl) {
    this._container = containerEl
    this._render()
    this._mounted = true
    document.addEventListener('keydown', this._onKeyDown)
  }

  destroy() {
    closeContextMenu()
    document.removeEventListener('keydown', this._onKeyDown)
    this._mounted = false
    if (this._container) {
      this._container.innerHTML = ''
      this._container = null
    }
    this._handlers = {}
    this._dom = {}
    this._files = []
    this._rows = []
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  /**
   * @param {string} path
   * @param {string} text raw patch contents
   * @returns {boolean} whether it parsed
   */
  setPatch(path, text) {
    this._path = path ?? ''
    try {
      this._files = parseUnifiedDiff(String(text ?? ''))
    } catch (err) {
      // A patch viewer that silently drops lines is worse than one that
      // refuses the file: the user cannot tell the difference.
      this._files = []
      this._rows = []
      this._refresh()
      this._emit('status', {
        message: err instanceof UnifiedDiffParseError
          ? `這不是有效的 patch：${err.message}`
          : `無法讀取 patch：${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      })
      return false
    }
    this._rows = buildPatchRows(this._files)
    this._currentDiffIdx = -1
    this._selected = -1
    this._refresh()
    this._emit('paths-changed', { left: this._path, right: '' })
    if (getNavOptions().firstDiffOnLoad) this.firstDifference()
    return true
  }

  /** @returns {Promise<void>} */
  async openPatch() {
    try {
      const result = await window.electronAPI?.openFile?.({
        filters: [
          { name: 'Patch', extensions: ['patch', 'diff'] },
          { name: '所有檔案', extensions: ['*'] },
        ],
      })
      if (!result?.path) return
      this.setPatch(result.path, result.content ?? '')
    } catch (err) {
      this._emit('status', {
        message: `無法開啟 patch：${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      })
    }
  }

  /** @returns {import('../core/patch.js').PatchFile[]} */
  getFiles() { return this._files }
  /** @returns {Array<object>} */
  getRows() { return this._rows }
  /** @returns {string} */
  getPath() { return this._path }

  /** @returns {{files: number, hunks: number, added: number, removed: number}} */
  getStats() {
    let hunks = 0
    let added = 0
    let removed = 0
    for (const file of this._files) {
      hunks += file.hunks.length
      for (const hunk of file.hunks) {
        for (const l of hunk.lines) {
          if (l.type === '+') added++
          else if (l.type === '-') removed++
        }
      }
    }
    return { files: this._files.length, hunks, added, removed }
  }

  // ── Applying ───────────────────────────────────────────────────────────────

  /**
   * Work out what applying would do, without writing anything.
   *
   * @param {string} root folder the patch paths are relative to
   * @returns {Promise<Array<object>>}
   */
  async previewApply(root) {
    /** @type {Array<object>} */
    const plan = []
    for (const file of this._files) {
      const rel = targetPath(file)
      const full = `${root.replace(/[\\/]+$/, '')}/${rel}`
      let source = null
      try {
        const read = await window.electronAPI?.readFile?.(full)
        source = typeof read === 'string' ? read : read?.content ?? null
      } catch {
        source = null
      }
      if (source === null) {
        plan.push({ file, path: full, ok: false, reason: '讀不到這個檔案' })
        continue
      }
      const result = applyHunks(source, file.hunks)
      plan.push({
        file, path: full, ok: result.ok, text: result.text,
        applied: result.applied, failures: result.failures,
        reason: result.ok ? '' : result.failures.map((f) => f.reason).join('；'),
      })
    }
    return plan
  }

  /**
   * Apply the patch to files under a folder the user picks.
   *
   * @returns {Promise<void>}
   */
  async applyPatch() {
    if (!this._files.length) {
      this._emit('status', { message: '沒有載入任何 patch', level: 'warn' })
      return
    }
    const folder = await window.electronAPI?.openFolder?.()
    const root = typeof folder === 'string' ? folder : folder?.path
    if (!root) return

    const plan = await this.previewApply(root)
    const good = plan.filter((p) => p.ok)
    const bad = plan.filter((p) => !p.ok)

    if (!good.length) {
      this._emit('status', {
        message: `沒有一個檔案可以套用：${bad.map((b) => `${b.path}（${b.reason}）`).join('；')}`,
        level: 'error',
      })
      return
    }

    // Writing is not undoable, so the count and the failures are stated before
    // anything happens rather than reported afterwards.
    const ok = await confirmDialog({
      title: '套用 patch',
      message: `即將修改 ${good.length} 個檔案。`
        + (bad.length ? `有 ${bad.length} 個無法套用，會保持原狀：${bad.map((b) => b.path).join('、')}。` : '')
        + '這個動作無法復原。要繼續嗎？',
      okText: '套用',
    })
    if (!ok) return

    let written = 0
    for (const item of good) {
      try {
        await window.electronAPI?.writeFileAt?.(item.path, item.text)
        written++
      } catch (err) {
        this._emit('status', {
          message: `寫入 ${item.path} 失敗：${err instanceof Error ? err.message : String(err)}`,
          level: 'error',
        })
      }
    }
    toast(`已套用到 ${written} 個檔案`)
    this._renderStatus()
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  /** @returns {number[]} row indices that are changes */
  _diffRows() {
    const out = []
    for (let i = 0; i < this._rows.length; i++) {
      const k = this._rows[i].kind
      if (k === 'insert' || k === 'delete') out.push(i)
    }
    return out
  }

  /** @returns {number[]} row indices that start a hunk */
  _hunkRows() {
    const out = []
    for (let i = 0; i < this._rows.length; i++) if (this._rows[i].kind === 'hunk') out.push(i)
    return out
  }

  /** @returns {number[]} row indices that start a file */
  _fileRows() {
    const out = []
    for (let i = 0; i < this._rows.length; i++) if (this._rows[i].kind === 'file') out.push(i)
    return out
  }

  /** @returns {number} */
  getCurrentDiffIndex() { return this._currentDiffIdx }
  /** @returns {number} */
  getDiffCount() { return this._diffRows().length }

  nextDifference() { return this._step(1) }
  prevDifference() { return this._step(-1) }
  firstDifference() { return this._jump(0) }
  lastDifference() { return this._jump(this.getDiffCount() - 1) }

  /** @param {number} delta */
  _step(delta) {
    return this._jump(stepDiffIndex(this._currentDiffIdx, this.getDiffCount(), delta))
  }

  /** @param {number} target */
  _jump(target) {
    const rows = this._diffRows()
    const from = this._currentDiffIdx
    if (!rows.length || target < 0) return navResult(from, -1, rows.length)
    const clamped = Math.min(rows.length - 1, target)
    this._currentDiffIdx = clamped
    this._selectRow(rows[clamped])
    return navResult(from, clamped, rows.length)
  }

  /**
   * BC's Next/Previous Difference Section — move by hunk, not by line.
   *
   * @param {1|-1} direction
   * @returns {boolean}
   */
  goToSection(direction) {
    return this._goToMarker(this._hunkRows(), direction)
  }

  /**
   * BC's Next/Previous Difference Files.
   *
   * @param {1|-1} direction
   * @returns {boolean}
   */
  goToFile(direction) {
    return this._goToMarker(this._fileRows(), direction)
  }

  /**
   * @param {number[]} markers
   * @param {1|-1} direction
   * @returns {boolean}
   */
  _goToMarker(markers, direction) {
    if (!markers.length) return false
    const at = this._selected
    const next = direction === 1
      ? markers.find((i) => i > at) ?? markers[0]
      : [...markers].reverse().find((i) => i < at) ?? markers[markers.length - 1]
    this._selectRow(next)
    // Keep the difference cursor consistent with where the view now is, or
    // Next Difference would jump back to wherever it had been left.
    const diffs = this._diffRows()
    const idx = diffs.findIndex((i) => i >= next)
    this._currentDiffIdx = idx === -1 ? this._currentDiffIdx : idx
    return true
  }

  /** @param {number} rowIndex */
  _selectRow(rowIndex) {
    this._selected = rowIndex
    const scroll = this._dom.scroll
    if (scroll) {
      const top = rowIndex * ROW_HEIGHT
      const viewport = scroll.clientHeight || 400
      if (top < scroll.scrollTop || top + ROW_HEIGHT > scroll.scrollTop + viewport) {
        scroll.scrollTop = Math.max(0, top - Math.floor(viewport / 2))
      }
    }
    this._paintWindow(true)
    this._renderStatus()
  }

  // ── Display ────────────────────────────────────────────────────────────────

  /** @param {'side'|'over'} [mode] */
  setLayout(mode) {
    this._layout = mode ?? (this._layout === 'side' ? 'over' : 'side')
    this._dom.root?.classList.toggle('tp-over', this._layout === 'over')
    this._paintWindow(true)
    return this._layout
  }

  /** @returns {'side'|'over'} */
  getLayout() { return this._layout }

  /** @param {boolean} [on] */
  setLineNumbers(on) {
    this._showLineNumbers = on == null ? !this._showLineNumbers : Boolean(on)
    this._dom.root?.classList.toggle('tp-no-nums', !this._showLineNumbers)
    return this._showLineNumbers
  }

  /** @param {boolean} [on] */
  setVisibleWhitespace(on) {
    this._showWhitespace = on == null ? !this._showWhitespace : Boolean(on)
    this._paintWindow(true)
    return this._showWhitespace
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  /**
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
   * @param {string} event
   * @param {Function} handler
   * @returns {this}
   */
  off(event, handler) {
    if (!this._handlers[event]) return this
    this._handlers[event] = this._handlers[event].filter((h) => h !== handler)
    return this
  }

  /**
   * @param {string} event
   * @param {object} payload
   */
  _emit(event, payload) {
    for (const h of this._handlers[event] ?? []) {
      try {
        h(payload)
      } catch (err) {
        console.error(`TextPatch event "${event}" handler error:`, err)
      }
    }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  /** @param {KeyboardEvent} e */
  _onKeyDown(e) {
    if (!this._mounted || !isActive('textpatch')) return
    const target = /** @type {HTMLElement|null} */ (e.target)
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

    if (e.key === 'F8' && e.ctrlKey) { e.preventDefault(); this.goToSection(1) }
    else if (e.key === 'F7' && e.ctrlKey) { e.preventDefault(); this.goToSection(-1) }
    else if (e.key === 'F8') { e.preventDefault(); this.nextDifference() }
    else if (e.key === 'F7') { e.preventDefault(); this.prevDifference() }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _render() {
    if (!this._container) return
    this._container.innerHTML = ''
    const root = el('div', { className: 'text-patch' })
    root.appendChild(this._buildToolbar())
    root.appendChild(this._buildHeader())
    root.appendChild(this._buildGrid())
    root.appendChild(this._buildStatus())
    this._container.appendChild(root)
    this._dom.root = root
    this._refresh()
  }

  /** @returns {HTMLElement} */
  _buildToolbar() {
    const bar = el('div', { className: 'tp-toolbar' })
    /**
     * @param {string} label
     * @param {string} title
     * @param {() => void} action
     */
    const btn = (label, title, action) => {
      const b = el('button', { className: 'tp-btn', textContent: label, title })
      b.addEventListener('click', action)
      bar.appendChild(b)
      return b
    }

    btn('開啟 patch…', '開啟 .patch / .diff 檔', () => { void this.openPatch() })
    btn('套用…', '把這個 patch 套用到資料夾（無法復原）', () => { void this.applyPatch() })
    bar.appendChild(el('span', { className: 'tp-sep' }))
    btn('↑', '上一個差異（F7）', () => { this.prevDifference() })
    btn('↓', '下一個差異（F8）', () => { this.nextDifference() })
    btn('⇞ 區塊', '上一個區塊（Ctrl+F7）', () => { this.goToSection(-1) })
    btn('⇟ 區塊', '下一個區塊（Ctrl+F8）', () => { this.goToSection(1) })
    btn('⇤ 檔案', '上一個檔案', () => { this.goToFile(-1) })
    btn('⇥ 檔案', '下一個檔案', () => { this.goToFile(1) })
    bar.appendChild(el('span', { className: 'tp-sep' }))
    btn('⬛ 版面', '切換並排 / 上下', () => { this.setLayout() })
    btn('#', '行號', () => { this.setLineNumbers() })
    btn('␣', '可見空白', () => { this.setVisibleWhitespace() })
    return bar
  }

  /** @returns {HTMLElement} */
  _buildHeader() {
    const head = el('div', { className: 'tp-head' })
    head.appendChild(el('div', { className: 'tp-side', textContent: '修改前' }))
    head.appendChild(el('div', { className: 'tp-side', textContent: '修改後' }))
    return head
  }

  /** @returns {HTMLElement} */
  _buildGrid() {
    const scroll = el('div', { className: 'tp-scroll' })
    const spacer = el('div', { className: 'tp-spacer' })
    const body = el('div', { className: 'tp-body' })
    spacer.appendChild(body)
    scroll.appendChild(spacer)
    scroll.addEventListener('scroll', () => this._paintWindow())
    scroll.addEventListener('click', (e) => {
      const row = /** @type {HTMLElement|null} */ (e.target)?.closest?.('.tp-row')
      if (row) this._selectRow(Number(row.dataset.index))
    })
    scroll.addEventListener('contextmenu', (e) => this._onContextMenu(e))
    this._dom.scroll = scroll
    this._dom.spacer = spacer
    this._dom.body = body
    return scroll
  }

  /** @returns {HTMLElement} */
  _buildStatus() {
    const bar = el('div', { className: 'tp-status' })
    this._dom.status = bar
    return bar
  }

  _refresh() {
    this._windowFirst = null
    this._windowLast = null
    if (this._dom.spacer) {
      this._dom.spacer.style.height = `${this._rows.length * ROW_HEIGHT}px`
    }
    this._paintWindow(true)
    this._renderStatus()
  }

  /** @param {boolean} [force] */
  _paintWindow(force = false) {
    const scroll = this._dom.scroll
    const body = this._dom.body
    if (!scroll || !body) return

    const viewport = scroll.clientHeight || 400
    const first = Math.max(0, Math.floor(scroll.scrollTop / ROW_HEIGHT) - OVERSCAN)
    const count = Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2
    const last = Math.min(this._rows.length, first + count)
    if (!force && this._windowFirst === first && this._windowLast === last) return
    this._windowFirst = first
    this._windowLast = last

    body.style.transform = `translateY(${first * ROW_HEIGHT}px)`
    const frag = document.createDocumentFragment()
    for (let i = first; i < last; i++) frag.appendChild(this._buildRow(this._rows[i], i))
    body.replaceChildren(frag)
  }

  /**
   * @param {object} row
   * @param {number} index
   * @returns {HTMLElement}
   */
  _buildRow(row, index) {
    const node = el('div', {
      className: `tp-row tp-${row.kind}${index === this._selected ? ' tp-current' : ''}`,
    })
    node.dataset.index = String(index)

    /**
     * @param {'left'|'right'} side
     * @returns {HTMLElement}
     */
    const cell = (side) => {
      const wrap = el('div', { className: `tp-cell tp-${side}` })
      const no = side === 'left' ? row.leftNo : row.rightNo
      wrap.appendChild(el('span', {
        className: 'tp-no', textContent: no == null ? '' : String(no),
      }))
      const text = side === 'left' ? row.left : row.right
      wrap.appendChild(el('span', {
        className: 'tp-text',
        textContent: text == null ? '' : this._display(text),
      }))
      if (text == null) wrap.classList.add('tp-empty')
      return wrap
    }

    node.appendChild(cell('left'))
    node.appendChild(cell('right'))
    return node
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  _display(text) {
    if (!this._showWhitespace) return text
    return String(text).replace(/ /g, '·').replace(/\t/g, '→\t')
  }

  _renderStatus() {
    const bar = this._dom.status
    if (!bar) return
    const s = this.getStats()
    const total = this.getDiffCount()
    const at = this._currentDiffIdx >= 0 ? `　差異 ${this._currentDiffIdx + 1} / ${total}` : ''
    bar.textContent = this._files.length
      ? `${this._path || '（未命名）'}　${s.files} 個檔案，${s.hunks} 個區塊，`
        + `新增 ${s.added} 行，刪除 ${s.removed} 行${at}`
      : `${this._path || '（未載入 patch）'}`
  }

  /** @param {MouseEvent} e */
  _onContextMenu(e) {
    showContextMenu(e, [
      { label: '下一個差異', action: () => this.nextDifference() },
      { label: '上一個差異', action: () => this.prevDifference() },
      { separator: true },
      { label: '下一個區塊', action: () => this.goToSection(1) },
      { label: '上一個區塊', action: () => this.goToSection(-1) },
      { label: '下一個檔案', action: () => this.goToFile(1) },
      { label: '上一個檔案', action: () => this.goToFile(-1) },
      { separator: true },
      { label: '複製這一行', action: () => void this._copyRow() },
      { separator: true },
      { label: '套用 patch…', action: () => void this.applyPatch() },
    ])
  }

  /** @returns {Promise<void>} */
  async _copyRow() {
    const row = this._rows[this._selected]
    if (!row) return
    const text = row.right ?? row.left ?? ''
    try {
      await navigator.clipboard?.writeText?.(text)
    } catch { /* clipboard unavailable */ }
  }

  /**
   * Ask for a folder by typing, for callers with no dialog (tests, scripts).
   *
   * @returns {Promise<string|null>}
   */
  async promptRoot() {
    return promptDialog({ title: '套用 patch', message: '要套用到哪個資料夾？' })
  }
}
