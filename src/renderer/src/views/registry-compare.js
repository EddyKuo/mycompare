/**
 * Registry comparison as a key/value grid.
 *
 * The read-only text view this replaces flattened everything into lines and
 * handed them to the text differ, which loses the two things a registry diff
 * is actually about: the value's type, and whether a given value is missing on
 * one side rather than merely different.
 *
 * Comparison is not done here. `compare-reg-files` returns the per-value
 * result already decided in the main process, so there is one definition of
 * what makes two values equal.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * - **Large values arrive shortened.** A stock Windows 11 install has a single
 *   value of over four million characters. The comparison ran on the whole
 *   thing, but the view only receives the first few kilobytes, and a row in
 *   that state must never be written back unedited — main refuses it, and this
 *   view says so rather than letting the attempt look accepted.
 * - **Writing is destructive.** Applying to the live registry cannot be undone,
 *   so it asks first, every time, and names what it is about to change.
 */
import { isActive } from '../core/active-view.js'
import { showContextMenu, closeContextMenu } from '../core/context-menu.js'
import { confirm as confirmDialog, prompt as promptDialog } from '../core/modal.js'
import { el } from '../core/utils.js'
import { tagConfig, readConfig } from '../core/named-config-store.js'
import { stepDiffIndex, navResult, getNavOptions } from '../core/diff-nav.js'
import { renderTextTable, reportHeader, reportSummary } from '../core/report.js'
import { toast } from '../core/toast.js'
import {
  buildRegistryTree, flattenRegistryTree, countRegistryStatuses, allKeyPaths,
} from '../core/registry-tree.js'
import '../styles/registry-compare.css'

/** Row height in px; must match --rc-row-height in the stylesheet. */
const ROW_HEIGHT = 22
/** Rows drawn above and below the viewport. */
const OVERSCAN = 8
/** Longest value text drawn in a grid cell before it is cut for display. */
const CELL_CHARS = 300

/** The value types a new or modified value may take. */
export const REG_TYPES = Object.freeze([
  'REG_SZ', 'REG_EXPAND_SZ', 'REG_DWORD', 'REG_QWORD', 'REG_BINARY', 'REG_MULTI_SZ',
])

/** Status → the label used in reports and the status bar. */
const STATUS_LABEL = Object.freeze({
  same: '相同',
  different: '不同',
  'left-only': '僅左側',
  'right-only': '僅右側',
})

/**
 * One line of a cell, with the newlines and control characters that would
 * otherwise break the row height turned into something visible.
 *
 * @param {string} text
 * @returns {string}
 */
export function cellText(text) {
  const s = String(text ?? '')
  const cut = s.length > CELL_CHARS ? `${s.slice(0, CELL_CHARS)}…` : s
  // A REG_MULTI_SZ carries NULs and a REG_SZ can carry a newline; either
  // would break the fixed row height the virtual scroller depends on.
  return cut.replace(/[\u0000-\u001F\u007F]/g, '\u00B7')
}

/**
 * Describe a side of a row for display.
 *
 * @param {{ type: string, value: string, truncated?: boolean, fullLength?: number }|null} side
 * @returns {string}
 */
export function sideText(side) {
  if (!side) return ''
  if (side.truncated) {
    return `${cellText(side.value)}  （僅載入開頭 ${side.value.length} / ${side.fullLength} 字元）`
  }
  return cellText(side.value)
}

export class RegistryCompare {
  constructor() {
    /** @type {string} */
    this._leftPath = ''
    /** @type {string} */
    this._rightPath = ''
    /** @type {string} */
    this._format = ''
    /** @type {string} the live key a side was exported from, if it was */
    this._leftLiveKey = ''
    /** @type {string} */
    this._rightLiveKey = ''
    /** @type {string} the temporary export a live side is currently reading */
    this._leftSnapshot = ''
    /** @type {string} */
    this._rightSnapshot = ''

    /** @type {import('../core/registry-tree.js').RegNode[]} */
    this._roots = []
    /** @type {import('../core/registry-tree.js').RegNode[]} the flattened, filtered rows */
    this._visible = []
    /** @type {Set<string>} lower-cased key paths that are open */
    this._expanded = new Set()

    this._showSame = true
    this._showDiff = true
    /** @type {string} */
    this._find = ''

    /** @type {number} index into the visible rows, not into the diffs */
    this._selected = -1
    /** @type {number} -1 until a difference is navigated to */
    this._currentDiffIdx = -1

    /** @type {boolean} any edit made since the last write */
    this._dirty = false
    /**
     * Values removed or renamed away, per side.
     *
     * `reg import` only adds and overwrites — leaving a value out of the file
     * does not remove it from the registry. So a deletion has to be written
     * explicitly as `"name"=-`, or deleting and applying would appear to work
     * and change nothing. A rename is a deletion of the old name plus a value
     * under the new one, for the same reason.
     *
     * @type {{ left: Array<{path: string, name: string}>, right: Array<{path: string, name: string}> }}
     */
    this._removed = { left: [], right: [] }

    /** Virtual window bounds; null forces a repaint. */
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
    this._roots = []
    this._visible = []
    this._expanded = new Set()
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async setLeft(path) {
    this._leftPath = path ?? ''
    await this._reload()
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async setRight(path) {
    this._rightPath = path ?? ''
    await this._reload()
  }

  /**
   * @param {string} leftPath
   * @param {string} rightPath
   * @returns {Promise<void>}
   */
  async setBoth(leftPath, rightPath) {
    this._leftPath = leftPath ?? ''
    this._rightPath = rightPath ?? ''
    await this._reload()
  }

  /**
   * Point one side at a live registry key.
   *
   * The key is exported to a temporary file first, so a live key and a .reg
   * the user already has travel the same path from here on. That also makes
   * the comparison a snapshot rather than a live view — reloading re-exports.
   *
   * @param {'left'|'right'} side
   * @param {string} keyPath  e.g. HKEY_CURRENT_USER\Software\Example
   * @returns {Promise<void>}
   */
  async setSideToLiveKey(side, keyPath) {
    try {
      const api = window.electronAPI
      if (typeof api?.snapshotRegistryKey !== 'function') {
        throw new Error('此環境沒有提供 snapshotRegistryKey')
      }
      // Name the snapshot this replaces so main releases that one and not a
      // file the other side is still using.
      const previous = side === 'left' ? this._leftSnapshot : this._rightSnapshot
      const result = await api.snapshotRegistryKey(keyPath, previous)
      if (!result?.path) return
      if (side === 'left') {
        this._leftPath = result.path
        this._leftLiveKey = result.keyPath
        this._leftSnapshot = result.path
      } else {
        this._rightPath = result.path
        this._rightLiveKey = result.keyPath
        this._rightSnapshot = result.path
      }
      await this._reload()
    } catch (err) {
      this._emit('status', {
        message: `無法讀取登錄機碼：${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      })
    }
  }

  /**
   * Ask for a key path, then load it into one side.
   *
   * @param {'left'|'right'} side
   * @returns {Promise<void>}
   */
  async promptLiveKey(side) {
    const keyPath = await promptDialog({
      title: side === 'left' ? '左側：即時登錄機碼' : '右側：即時登錄機碼',
      message: '機碼路徑',
      defaultValue: (side === 'left' ? this._leftLiveKey : this._rightLiveKey)
        || 'HKEY_CURRENT_USER\\Software',
    })
    if (!keyPath) return
    await this.setSideToLiveKey(side, keyPath)
  }

  /**
   * Re-export any side that came from a live key, so a reload sees the
   * registry as it is now rather than the snapshot taken earlier.
   *
   * @returns {Promise<void>}
   */
  async refresh() {
    if (this._leftLiveKey) await this.setSideToLiveKey('left', this._leftLiveKey)
    if (this._rightLiveKey) await this.setSideToLiveKey('right', this._rightLiveKey)
    if (!this._leftLiveKey && !this._rightLiveKey) await this._reload()
  }

  /** @returns {Promise<void>} */
  async reloadAll() { await this._reload() }

  /** @returns {Promise<void>} */
  async swap() {
    const left = this._leftPath
    this._leftPath = this._rightPath
    this._rightPath = left
    // The live-key origin travels with the path; leaving it behind would make
    // the next refresh re-export into the side it no longer belongs to.
    const leftKey = this._leftLiveKey
    this._leftLiveKey = this._rightLiveKey
    this._rightLiveKey = leftKey
    const leftSnap = this._leftSnapshot
    this._leftSnapshot = this._rightSnapshot
    this._rightSnapshot = leftSnap
    await this._reload()
  }

  /** @returns {Promise<void>} */
  async _reload() {
    if (!this._leftPath && !this._rightPath) return
    if (!(await this._confirmDiscardEdits())) return

    try {
      const api = window.electronAPI
      if (typeof api?.compareRegFiles !== 'function') {
        throw new Error('此環境沒有提供 compareRegFiles')
      }
      const result = await api.compareRegFiles(this._leftPath, this._rightPath)
      this._format = result?.format ?? ''
      this._roots = buildRegistryTree(result?.rows ?? [])
      this._dirty = false
      this._removed = { left: [], right: [] }
      // Open the roots so a freshly loaded comparison is not a single closed
      // line; anything deeper stays shut because real exports are large.
      this._expanded = new Set(this._roots.map((n) => n.path.toLowerCase()))
      this._currentDiffIdx = -1
      this._selected = -1
      this._refresh()
      this._emitPaths()
      if (getNavOptions().firstDiffOnLoad) this.firstDifference()
    } catch (err) {
      this._emit('status', {
        message: `無法比對登錄檔：${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      })
    }
  }

  /**
   * @returns {Promise<boolean>} whether it is safe to throw away the model
   */
  async _confirmDiscardEdits() {
    if (!this._dirty) return true
    return confirmDialog({
      title: '尚未寫回的變更',
      message: '有已修改但尚未寫回的項目，重新載入會將它們丟棄。要繼續嗎？',
      okText: '丟棄並重新載入',
    })
  }

  // ── Public state ───────────────────────────────────────────────────────────

  /** @returns {string} */
  getLeftPath() { return this._leftPath }
  /** @returns {string} */
  getRightPath() { return this._rightPath }
  /** @returns {boolean} whether there are unwritten edits */
  isDirty() { return this._dirty }
  /** @returns {import('../core/registry-tree.js').RegNode[]} */
  getVisibleRows() { return this._visible }
  /** @returns {object} */
  getStats() { return countRegistryStatuses(this._roots) }

  /** @returns {'all'|'diff'|'same'|'none'} */
  getShowFilter() {
    if (this._showSame && this._showDiff) return 'all'
    if (this._showDiff) return 'diff'
    if (this._showSame) return 'same'
    return 'none'
  }

  /**
   * @param {'all'|'diff'|'same'|'none'} mode
   * @returns {string}
   */
  setShowFilter(mode) {
    this._showSame = mode === 'all' || mode === 'same'
    this._showDiff = mode === 'all' || mode === 'diff'
    this._refresh()
    return this.getShowFilter()
  }

  /**
   * @param {string} text
   */
  setFind(text) {
    this._find = String(text ?? '')
    this._refresh()
  }

  expandAll() {
    this._expanded = new Set(allKeyPaths(this._roots))
    this._refresh()
  }

  collapseAll() {
    this._expanded = new Set()
    this._refresh()
  }

  /** @returns {object} */
  getConfig() {
    return tagConfig('registry', {
      showFilter: this.getShowFilter(),
    })
  }

  /** @param {unknown} cfg */
  applyConfig(cfg) {
    const s = readConfig('registry', cfg)
    if (!s) return
    if (typeof s.showFilter === 'string') this.setShowFilter(s.showFilter)
  }

  // ── Difference navigation ──────────────────────────────────────────────────

  /** @returns {number[]} indices into _visible that are differences */
  _diffIndices() {
    const out = []
    for (let i = 0; i < this._visible.length; i++) {
      const node = this._visible[i]
      if (node.kind === 'value' && node.status !== 'same') out.push(i)
    }
    return out
  }

  /** @returns {number} */
  getCurrentDiffIndex() { return this._currentDiffIdx }
  /** @returns {number} */
  getDiffCount() { return this._diffIndices().length }

  nextDifference() { return this._step(1) }
  prevDifference() { return this._step(-1) }
  firstDifference() { return this._jump(0) }
  lastDifference() { return this._jump(this.getDiffCount() - 1) }

  /**
   * @param {number} delta
   */
  _step(delta) {
    return this._jump(stepDiffIndex(this._currentDiffIdx, this.getDiffCount(), delta))
  }

  /**
   * @param {number} target
   */
  _jump(target) {
    const indices = this._diffIndices()
    const from = this._currentDiffIdx
    if (!indices.length || target < 0) return navResult(from, -1, indices.length)
    const clamped = Math.min(indices.length - 1, target)
    this._currentDiffIdx = clamped
    this._selectRow(indices[clamped])
    return navResult(from, clamped, indices.length)
  }

  /**
   * @param {number} visibleIndex
   */
  _selectRow(visibleIndex) {
    this._selected = visibleIndex
    this._scrollToRow(visibleIndex)
    this._paintWindow(true)
    this._renderStatus()
  }

  /**
   * @param {number} index
   */
  _scrollToRow(index) {
    const scroll = this._dom.scroll
    if (!scroll) return
    const top = index * ROW_HEIGHT
    const viewport = scroll.clientHeight || 400
    if (top < scroll.scrollTop || top + ROW_HEIGHT > scroll.scrollTop + viewport) {
      scroll.scrollTop = Math.max(0, top - Math.floor(viewport / 2))
    }
  }

  // ── Editing ────────────────────────────────────────────────────────────────

  /**
   * Change one side of a value.
   *
   * @param {import('../core/registry-tree.js').RegNode} node
   * @param {'left'|'right'} side
   * @param {{ type: string, value: string }} next
   */
  applyEdit(node, side, next) {
    if (!node?.row) return
    const target = { type: next.type, value: next.value, edited: true }
    node.row[side] = target
    // `raw` is gone by construction: an edited value has no original token, so
    // it will be re-encoded from what was typed.
    node.row.status = computeStatus(node.row.left, node.row.right)
    node.status = node.row.status
    this._dirty = true
    this._rebuildTreeStatuses()
    this._refresh()
  }

  /**
   * Copy one side's value onto the other.
   *
   * @param {import('../core/registry-tree.js').RegNode} node
   * @param {'left'|'right'} from
   */
  copyValue(node, from) {
    if (!node?.row) return
    const source = node.row[from]
    if (!source) return
    if (source.truncated) {
      // The view only ever received the first few kilobytes of this value.
      // Copying it would produce a row that looks edited and complete, which
      // is exactly the shape `refuseTruncatedRows` lets through — so the
      // shortened data would reach the registry as if it were the whole value.
      this._emit('status', {
        message: `「${node.label}」太大，只載入了開頭 ${source.value.length} / `
          + `${source.fullLength} 字元，複製會寫入截短的資料，因此拒絕`,
        level: 'error',
      })
      return
    }
    this.applyEdit(node, from === 'left' ? 'right' : 'left', {
      type: source.type,
      value: source.value,
    })
  }

  /**
   * Remove a value from one side.
   *
   * @param {import('../core/registry-tree.js').RegNode} node
   * @param {'left'|'right'} side
   */
  deleteValue(node, side) {
    if (!node?.row) return
    if (node.row[side]) this._removed[side].push({ path: node.path, name: node.name })
    node.row[side] = null
    if (!node.row.left && !node.row.right) {
      // Gone from both sides: drop the node rather than leaving a blank row.
      const parent = this._findParent(node)
      if (parent) parent.children = parent.children.filter((c) => c !== node)
    } else {
      node.row.status = computeStatus(node.row.left, node.row.right)
      node.status = node.row.status
    }
    this._dirty = true
    this._rebuildTreeStatuses()
    this._refresh()
  }

  /**
   * @param {import('../core/registry-tree.js').RegNode} node
   * @returns {import('../core/registry-tree.js').RegNode|null}
   */
  _findParent(node) {
    /** @param {import('../core/registry-tree.js').RegNode} n */
    const walk = (n) => {
      if (n.children.includes(node)) return n
      for (const c of n.children) {
        const found = walk(c)
        if (found) return found
      }
      return null
    }
    for (const root of this._roots) {
      const found = walk(root)
      if (found) return found
    }
    return null
  }

  /** Re-fold every key status after an edit. */
  _rebuildTreeStatuses() {
    // Rebuilding from the rows keeps one implementation of the fold rule.
    const rows = []
    /** @param {import('../core/registry-tree.js').RegNode} n */
    const walk = (n) => {
      if (n.kind === 'value' && n.row) rows.push(n.row)
      else if (n.kind === 'key' && !n.children.length) {
        // Carry the key's own status through the rebuild. Hard-coding 'same'
        // here would quietly undo a one-sided empty key on the next edit.
        rows.push({
          path: n.path,
          name: '',
          status: n.status,
          left: n.status === 'right-only' ? null : { type: 'KEY', value: '' },
          right: n.status === 'left-only' ? null : { type: 'KEY', value: '' },
        })
      }
      for (const c of n.children) walk(c)
    }
    for (const root of this._roots) walk(root)
    this._roots = buildRegistryTree(rows)
  }

  // ── Writing ────────────────────────────────────────────────────────────────

  /**
   * Flatten one side back into rows for writing.
   *
   * @param {'left'|'right'} side
   * @returns {Array<object>}
   */
  rowsForSide(side) {
    /** @type {Array<object>} */
    const out = []
    const otherOnly = side === 'left' ? 'right-only' : 'left-only'

    /** @param {import('../core/registry-tree.js').RegNode} n */
    const walk = (n) => {
      // A key holding no values still has to be written, or an empty key that
      // exists on one side only would vanish from the exported file — the row
      // carries no value, but it makes `buildRegFile` emit the [key] header.
      if (n.kind === 'key' && !n.children.length && n.status !== otherOnly) {
        out.push({ path: n.path, name: '', type: 'KEY', value: '' })
      }
      if (n.kind === 'value' && n.row?.[side]) {
        const v = n.row[side]
        out.push({
          path: n.path,
          name: n.name,
          type: v.type,
          value: v.value,
          ...(v.raw !== undefined ? { raw: v.raw } : {}),
          ...(v.truncated ? { truncated: true } : {}),
          ...(v.edited ? { edited: true } : {}),
        })
      }
      for (const c of n.children) walk(c)
    }
    for (const root of this._roots) walk(root)

    // A name that came back under a different value is not a deletion; only
    // emit `-` for names nothing writes any more.
    // Only real values count as still present. A key-only row shares the empty
    // name, so counting it would swallow the deletion of a default value — the
    // key becomes empty exactly when that value goes away.
    const live = new Set(out
      .filter((r) => r.type !== 'KEY')
      .map((r) => `${r.path.toLowerCase()}\u0000${r.name.toLowerCase()}`))
    for (const gone of this._removed[side]) {
      const key = `${gone.path.toLowerCase()}\u0000${gone.name.toLowerCase()}`
      if (live.has(key)) continue
      out.push({ path: gone.path, name: gone.name, type: 'DELETED', value: '', edited: true })
    }
    return out
  }

  /**
   * @param {'left'|'right'} side
   * @returns {Promise<void>}
   */
  async exportSide(side) {
    const rows = this.rowsForSide(side)
    if (!rows.length) {
      this._emit('status', { message: '這一側沒有可匯出的項目', level: 'warn' })
      return
    }
    try {
      const result = await window.electronAPI?.exportRegFile?.(rows, this._format, 'registry-export.reg')
      if (!result) return
      toast(`已匯出 ${result.count} 個項目`)
      this._dirty = false
      this._removed[side] = []
    } catch (err) {
      this._emit('status', {
        message: `匯出失敗：${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      })
    }
  }

  /**
   * Write one side into the live registry.
   *
   * @param {'left'|'right'} side
   * @returns {Promise<void>}
   */
  async applySide(side) {
    const rows = this.rowsForSide(side)
    if (!rows.length) {
      this._emit('status', { message: '這一側沒有可套用的項目', level: 'warn' })
      return
    }
    const keys = new Set(rows.map((r) => r.path))
    const ok = await confirmDialog({
      title: '套用到即時登錄檔',
      message: `即將把 ${rows.length} 個值寫入 ${keys.size} 個機碼。`
        + '這個動作無法復原，也不會先備份。要繼續嗎？',
      okText: '寫入登錄檔',
    })
    if (!ok) return

    try {
      const result = await window.electronAPI?.applyRegFile?.(rows, this._format)
      toast(`已寫入 ${result?.count ?? rows.length} 個值`)
      this._dirty = false
      this._removed[side] = []
    } catch (err) {
      this._emit('status', {
        message: `套用失敗：${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      })
    }
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  /**
   * @param {object} [opts]
   * @returns {string}
   */
  buildTextReport(opts = {}) {
    const rows = []
    /** @param {import('../core/registry-tree.js').RegNode} n */
    const walk = (n) => {
      if (n.kind === 'value') {
        rows.push([
          n.path,
          n.label,
          n.row?.left?.type ?? n.row?.right?.type ?? '',
          STATUS_LABEL[n.status] ?? n.status,
          cellText(n.row?.left?.value ?? ''),
          cellText(n.row?.right?.value ?? ''),
        ])
      }
      for (const c of n.children) walk(c)
    }
    for (const root of this._roots) walk(root)

    return [
      reportHeader({
        title: '登錄檔比對報表',
        leftPath: this._leftPath,
        rightPath: this._rightPath,
        generatedAt: opts.generatedAt,
      }),
      reportSummary(this.getStats(), STATUS_LABEL),
      '',
      renderTextTable(
        [
          { title: '機碼' }, { title: '名稱' }, { title: '類型' },
          { title: '狀態' }, { title: '左側' }, { title: '右側' },
        ],
        rows,
      ),
    ].join('\n')
  }

  /**
   * @param {object} [opts]
   * @returns {string}
   */
  buildHtmlReport(opts = {}) {
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

    const rows = []
    /** @param {import('../core/registry-tree.js').RegNode} n */
    const walk = (n) => {
      if (n.kind === 'value') {
        rows.push(`<tr class="${n.status}"><td>${esc(n.path)}</td><td>${esc(n.label)}</td>`
          + `<td>${esc(n.row?.left?.type ?? n.row?.right?.type ?? '')}</td>`
          + `<td>${esc(STATUS_LABEL[n.status] ?? n.status)}</td>`
          + `<td>${esc(cellText(n.row?.left?.value ?? ''))}</td>`
          + `<td>${esc(cellText(n.row?.right?.value ?? ''))}</td></tr>`)
      }
      for (const c of n.children) walk(c)
    }
    for (const root of this._roots) walk(root)

    const when = (opts.generatedAt ?? new Date()).toISOString().replace('T', ' ').slice(0, 19)
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>登錄檔比對報表</title><style>
body{font-family:system-ui,sans-serif;font-size:13px;margin:16px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:3px 6px;
text-align:left;vertical-align:top;font-family:ui-monospace,monospace;word-break:break-all}
th{background:#f0f0f0}
tr.different{background:#fff8c5}tr.left-only{background:#e6ffec}tr.right-only{background:#ffebe9}
</style></head><body>
<h1>登錄檔比對報表</h1>
<p>左：${esc(this._leftPath || '（未知）')}<br>右：${esc(this._rightPath || '（未知）')}<br>
產生時間：${esc(when)}</p>
<p>${esc(reportSummary(this.getStats(), STATUS_LABEL))}</p>
<table><thead><tr><th>機碼</th><th>名稱</th><th>類型</th><th>狀態</th><th>左側</th><th>右側</th></tr></thead>
<tbody>${rows.join('\n')}</tbody></table>
</body></html>`
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
        console.error(`RegistryCompare event "${event}" handler error:`, err)
      }
    }
  }

  _emitPaths() {
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  /** @param {KeyboardEvent} e */
  _onKeyDown(e) {
    if (!this._mounted || !isActive('registry')) return
    const target = /** @type {HTMLElement|null} */ (e.target)
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

    if (e.key === 'ArrowDown') { e.preventDefault(); this._moveSelection(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this._moveSelection(-1) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this._setExpandedOnSelection(true) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this._setExpandedOnSelection(false) }
    else if (e.key === 'Enter') {
      const node = this._visible[this._selected]
      if (node?.kind === 'value') { e.preventDefault(); void this._promptModify(node, 'left') }
    }
  }

  /** @param {number} delta */
  _moveSelection(delta) {
    if (!this._visible.length) return
    const next = this._selected < 0
      ? 0
      : Math.min(this._visible.length - 1, Math.max(0, this._selected + delta))
    this._selectRow(next)
  }

  /** @param {boolean} open */
  _setExpandedOnSelection(open) {
    const node = this._visible[this._selected]
    if (!node || node.kind !== 'key') return
    const key = node.path.toLowerCase()
    if (open) this._expanded.add(key)
    else this._expanded.delete(key)
    this._refresh()
  }

  // ── Model → DOM ────────────────────────────────────────────────────────────

  /** Recompute the visible rows and repaint. */
  _refresh() {
    this._visible = flattenRegistryTree(this._roots, {
      expanded: this._expanded,
      showSame: this._showSame,
      showDiff: this._showDiff,
      find: this._find,
    })
    // The window bounds are indices into a list that just changed, so they
    // cannot be trusted to short-circuit the repaint.
    this._windowFirst = null
    this._windowLast = null
    this._renderGrid()
    this._renderStatus()
  }

  _render() {
    if (!this._container) return
    this._container.innerHTML = ''
    const root = el('div', { className: 'registry-compare' })
    root.appendChild(this._buildToolbar())
    root.appendChild(this._buildHeader())
    root.appendChild(this._buildGrid())
    root.appendChild(this._buildStatus())
    this._container.appendChild(root)
    this._dom.root = root
  }

  /** @returns {HTMLElement} */
  _buildToolbar() {
    const bar = el('div', { className: 'rc-toolbar' })

    /**
     * @param {string} label
     * @param {string} title
     * @param {() => void} action
     * @returns {HTMLElement}
     */
    const button = (label, title, action) => {
      const b = el('button', { className: 'rc-btn', textContent: label, title })
      b.addEventListener('click', action)
      bar.appendChild(b)
      return b
    }

    button('⊞ 全部展開', '展開所有機碼', () => this.expandAll())
    button('⊟ 全部收合', '收合所有機碼', () => this.collapseAll())
    bar.appendChild(el('span', { className: 'rc-sep' }))

    for (const [mode, label] of [['all', '全部'], ['diff', '差異'], ['same', '相同']]) {
      const b = button(label, `只顯示${label}`, () => {
        this.setShowFilter(/** @type {'all'|'diff'|'same'} */ (mode))
        this._syncFilterButtons()
      })
      b.dataset.mode = mode
      this._dom[`btn${mode}`] = b
    }
    bar.appendChild(el('span', { className: 'rc-sep' }))

    const find = /** @type {HTMLInputElement} */ (el('input', {
      className: 'rc-find', type: 'search', placeholder: '搜尋名稱…',
    }))
    find.addEventListener('input', () => this.setFind(find.value))
    bar.appendChild(find)
    this._dom.find = find

    bar.appendChild(el('span', { className: 'rc-sep' }))
    button('↑', '上一個差異', () => { this.prevDifference() })
    button('↓', '下一個差異', () => { this.nextDifference() })

    bar.appendChild(el('span', { className: 'rc-sep' }))
    button('🗝 左側機碼…', '把一把即時登錄機碼載入左側',
      () => { void this.promptLiveKey('left') })
    button('🗝 右側機碼…', '把一把即時登錄機碼載入右側',
      () => { void this.promptLiveKey('right') })

    bar.appendChild(el('span', { className: 'rc-sep' }))
    button('⇄ 交換', '交換左右兩側', () => { void this.swap() })
    button('⟳ 重新讀取', '從磁碟重新讀取', () => { void this.refresh() })

    this._syncFilterButtons()
    return bar
  }

  _syncFilterButtons() {
    const active = this.getShowFilter()
    for (const mode of ['all', 'diff', 'same']) {
      this._dom[`btn${mode}`]?.classList.toggle('active', mode === active)
    }
  }

  /** @returns {HTMLElement} */
  _buildHeader() {
    const head = el('div', { className: 'rc-head' })
    head.appendChild(el('div', { className: 'rc-cell rc-cell-name', textContent: '名稱' }))
    head.appendChild(el('div', { className: 'rc-cell rc-cell-type', textContent: '類型' }))
    head.appendChild(el('div', { className: 'rc-cell rc-cell-data', textContent: '左側資料' }))
    head.appendChild(el('div', { className: 'rc-cell rc-cell-data', textContent: '右側資料' }))
    return head
  }

  /** @returns {HTMLElement} */
  _buildGrid() {
    const scroll = el('div', { className: 'rc-scroll' })
    const spacer = el('div', { className: 'rc-spacer' })
    const body = el('div', { className: 'rc-body' })
    spacer.appendChild(body)
    scroll.appendChild(spacer)

    scroll.addEventListener('scroll', () => this._paintWindow())
    scroll.addEventListener('contextmenu', (e) => this._onContextMenu(e))
    scroll.addEventListener('click', (e) => this._onClick(e))
    scroll.addEventListener('dblclick', (e) => this._onDoubleClick(e))

    this._dom.scroll = scroll
    this._dom.spacer = spacer
    this._dom.body = body
    return scroll
  }

  /** @returns {HTMLElement} */
  _buildStatus() {
    const bar = el('div', { className: 'rc-status' })
    this._dom.status = bar
    return bar
  }

  _renderGrid() {
    const spacer = this._dom.spacer
    if (!spacer) return
    spacer.style.height = `${this._visible.length * ROW_HEIGHT}px`
    this._paintWindow(true)
  }

  /**
   * Draw only the rows inside the viewport.
   *
   * @param {boolean} [force] repaint even if the window did not move
   */
  _paintWindow(force = false) {
    const scroll = this._dom.scroll
    const body = this._dom.body
    if (!scroll || !body) return

    const viewport = scroll.clientHeight || 400
    const first = Math.max(0, Math.floor(scroll.scrollTop / ROW_HEIGHT) - OVERSCAN)
    const count = Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2
    const last = Math.min(this._visible.length, first + count)
    if (!force && this._windowFirst === first && this._windowLast === last) return
    this._windowFirst = first
    this._windowLast = last

    body.style.transform = `translateY(${first * ROW_HEIGHT}px)`
    const frag = document.createDocumentFragment()
    for (let i = first; i < last; i++) frag.appendChild(this._buildRow(this._visible[i], i))
    body.replaceChildren(frag)
  }

  /**
   * @param {import('../core/registry-tree.js').RegNode} node
   * @param {number} index
   * @returns {HTMLElement}
   */
  _buildRow(node, index) {
    const row = el('div', {
      className: `rc-row ${node.status} ${node.kind === 'key' ? 'rc-row--key' : ''}`
        + (index === this._selected ? ' rc-row--current' : ''),
    })
    row.dataset.index = String(index)

    const name = el('div', { className: 'rc-cell rc-cell-name' })
    name.style.paddingLeft = `${4 + node.depth * 14}px`
    if (node.kind === 'key') {
      const open = this._expanded.has(node.path.toLowerCase())
      const twisty = el('span', {
        className: 'rc-twisty',
        textContent: node.children.length ? (open ? '▾' : '▸') : '　',
      })
      name.appendChild(twisty)
    }
    name.appendChild(el('span', { className: 'rc-label', textContent: node.label }))
    row.appendChild(name)

    const type = node.kind === 'key'
      ? ''
      : (node.row?.left?.type ?? node.row?.right?.type ?? '')
    row.appendChild(el('div', { className: 'rc-cell rc-cell-type', textContent: type }))

    const left = el('div', { className: 'rc-cell rc-cell-data' })
    const right = el('div', { className: 'rc-cell rc-cell-data' })
    if (node.kind === 'value') {
      left.textContent = sideText(node.row?.left)
      right.textContent = sideText(node.row?.right)
      if (node.row?.left?.edited) left.classList.add('rc-edited')
      if (node.row?.right?.edited) right.classList.add('rc-edited')
    }
    row.appendChild(left)
    row.appendChild(right)
    return row
  }

  _renderStatus() {
    const bar = this._dom.status
    if (!bar) return
    const counts = this.getStats()
    const total = this.getDiffCount()
    const at = this._currentDiffIdx >= 0 ? `　差異 ${this._currentDiffIdx + 1} / ${total}` : ''
    bar.textContent = `${reportSummary(counts, STATUS_LABEL)}${at}`
      + (this._dirty ? '　●　有未寫回的變更' : '')
  }

  // ── Pointer ────────────────────────────────────────────────────────────────

  /**
   * @param {Event} e
   * @returns {{ node: import('../core/registry-tree.js').RegNode, index: number }|null}
   */
  _rowFromEvent(e) {
    const target = /** @type {HTMLElement|null} */ (e.target)
    const rowEl = target?.closest?.('.rc-row')
    if (!rowEl) return null
    const index = Number(rowEl.dataset.index)
    const node = this._visible[index]
    return node ? { node, index } : null
  }

  /** @param {MouseEvent} e */
  _onClick(e) {
    const hit = this._rowFromEvent(e)
    if (!hit) return
    this._selectRow(hit.index)
    const target = /** @type {HTMLElement} */ (e.target)
    if (hit.node.kind === 'key' && target.classList.contains('rc-twisty')) {
      const key = hit.node.path.toLowerCase()
      if (this._expanded.has(key)) this._expanded.delete(key)
      else this._expanded.add(key)
      this._refresh()
    }
  }

  /** @param {MouseEvent} e */
  _onDoubleClick(e) {
    const hit = this._rowFromEvent(e)
    if (!hit) return
    if (hit.node.kind === 'key') {
      const key = hit.node.path.toLowerCase()
      if (this._expanded.has(key)) this._expanded.delete(key)
      else this._expanded.add(key)
      this._refresh()
      return
    }
    // Which side was double-clicked decides which side is edited.
    const cell = /** @type {HTMLElement|null} */ (e.target)?.closest?.('.rc-cell-data')
    const cells = [...(cell?.parentElement?.querySelectorAll('.rc-cell-data') ?? [])]
    const side = cells.indexOf(cell) === 1 ? 'right' : 'left'
    void this._promptModify(hit.node, side)
  }

  /** @param {MouseEvent} e */
  _onContextMenu(e) {
    const hit = this._rowFromEvent(e)
    if (!hit) return
    this._selectRow(hit.index)
    const { node } = hit
    const items = []

    if (node.kind === 'value') {
      items.push({ label: '修改左側…', action: () => void this._promptModify(node, 'left') })
      items.push({ label: '修改右側…', action: () => void this._promptModify(node, 'right') })
      items.push({ separator: true })
      items.push({
        label: '複製到右側',
        disabled: !node.row?.left,
        action: () => this.copyValue(node, 'left'),
      })
      items.push({
        label: '複製到左側',
        disabled: !node.row?.right,
        action: () => this.copyValue(node, 'right'),
      })
      items.push({ separator: true })
      items.push({
        label: '刪除左側的值',
        disabled: !node.row?.left,
        action: () => this.deleteValue(node, 'left'),
      })
      items.push({
        label: '刪除右側的值',
        disabled: !node.row?.right,
        action: () => this.deleteValue(node, 'right'),
      })
      items.push({ separator: true })
      items.push({ label: '重新命名…', action: () => void this._promptRename(node) })
    } else {
      items.push({ label: '新增值…', action: () => void this._promptNewValue(node) })
      items.push({ label: '新增子機碼…', action: () => void this._promptNewKey(node) })
      items.push({ separator: true })
    }

    items.push({ separator: true })
    items.push({ label: '複製機碼路徑', action: () => void navigator.clipboard?.writeText?.(node.path) })
    items.push({ separator: true })
    items.push({ label: '匯出左側為 .reg…', action: () => void this.exportSide('left') })
    items.push({ label: '匯出右側為 .reg…', action: () => void this.exportSide('right') })
    items.push({ label: '將左側套用到登錄檔…', action: () => void this.applySide('left') })
    items.push({ label: '將右側套用到登錄檔…', action: () => void this.applySide('right') })

    showContextMenu(e, items)
  }

  // ── Prompts ────────────────────────────────────────────────────────────────

  /**
   * @param {import('../core/registry-tree.js').RegNode} node
   * @param {'left'|'right'} side
   * @returns {Promise<void>}
   */
  async _promptModify(node, side) {
    const current = node.row?.[side]
    if (current?.truncated) {
      this._emit('status', {
        message: '這個值太大，只載入了開頭；直接編輯會截短原始資料，請改用登錄檔編輯器',
        level: 'warn',
      })
      return
    }
    const type = await promptDialog({
      title: '修改值',
      message: `類型（${REG_TYPES.join(' / ')}）`,
      defaultValue: current?.type ?? 'REG_SZ',
    })
    if (type === null) return
    if (!REG_TYPES.includes(type)) {
      this._emit('status', { message: `不支援的類型：${type}`, level: 'error' })
      return
    }
    const value = await promptDialog({
      title: '修改值',
      message: `資料${type === 'REG_MULTI_SZ' ? '（以 " | " 分隔多個字串）' : ''}`,
      defaultValue: current?.value ?? '',
    })
    if (value === null) return
    this.applyEdit(node, side, { type, value })
  }

  /**
   * @param {import('../core/registry-tree.js').RegNode} node
   * @returns {Promise<void>}
   */
  async _promptRename(node) {
    const name = await promptDialog({
      title: '重新命名值',
      message: '新的值名稱',
      defaultValue: node.name,
    })
    if (name === null || name === node.name) return
    // The old name has to be deleted explicitly; writing the value under its
    // new name alone would leave both in the registry.
    for (const side of /** @type {const} */ (['left', 'right'])) {
      if (node.row?.[side]) this._removed[side].push({ path: node.path, name: node.name })
    }
    node.name = name
    node.label = name === '' ? '（預設）' : name
    if (node.row) node.row.name = name
    this._dirty = true
    this._refresh()
  }

  /**
   * @param {import('../core/registry-tree.js').RegNode} keyNode
   * @returns {Promise<void>}
   */
  async _promptNewValue(keyNode) {
    const name = await promptDialog({ title: '新增值', message: '值名稱（留空為預設值）' })
    if (name === null) return
    const type = await promptDialog({
      title: '新增值', message: `類型（${REG_TYPES.join(' / ')}）`, defaultValue: 'REG_SZ',
    })
    if (type === null) return
    if (!REG_TYPES.includes(type)) {
      this._emit('status', { message: `不支援的類型：${type}`, level: 'error' })
      return
    }
    const value = await promptDialog({ title: '新增值', message: '資料', defaultValue: '' })
    if (value === null) return

    const row = {
      path: keyNode.path,
      name,
      status: 'left-only',
      left: { type, value, edited: true },
      right: null,
    }
    keyNode.children.push({
      kind: 'value',
      path: keyNode.path,
      name,
      label: name === '' ? '（預設）' : name,
      depth: keyNode.depth + 1,
      status: 'left-only',
      children: [],
      row,
    })
    this._dirty = true
    this._expanded.add(keyNode.path.toLowerCase())
    this._rebuildTreeStatuses()
    this._refresh()
  }

  /**
   * @param {import('../core/registry-tree.js').RegNode} keyNode
   * @returns {Promise<void>}
   */
  async _promptNewKey(keyNode) {
    const name = await promptDialog({ title: '新增子機碼', message: '機碼名稱' })
    if (!name) return
    if (name.includes('\\')) {
      this._emit('status', { message: '機碼名稱不可包含反斜線', level: 'error' })
      return
    }
    const path = `${keyNode.path}\\${name}`
    keyNode.children.push({
      kind: 'key',
      path,
      name: '',
      label: name,
      depth: keyNode.depth + 1,
      status: 'left-only',
      children: [],
      row: null,
    })
    this._dirty = true
    this._expanded.add(keyNode.path.toLowerCase())
    this._refresh()
  }
}

/**
 * The comparison rule, applied again after an edit.
 *
 * It has to match `diffRegistry` in the main process; there is a test that
 * pins the two together so an edit never reports a status a fresh load would
 * disagree with.
 *
 * @param {{ type: string, value: string }|null} left
 * @param {{ type: string, value: string }|null} right
 * @returns {'same'|'different'|'left-only'|'right-only'}
 */
export function computeStatus(left, right) {
  if (!right) return 'left-only'
  if (!left) return 'right-only'
  return left.value === right.value && left.type === right.type ? 'same' : 'different'
}
