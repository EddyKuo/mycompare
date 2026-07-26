/**
 * @file three-way-compare.js
 * @description 3-Way Text Merge view: Left | Base | Right → Output
 */

import { diffLines } from '../core/diff-engine.js'

// ---------------------------------------------------------------------------
// S13-C01: 3-way merge helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Convert a `diffLines(base, side)` result into hunks describing the edits
 * that `side` made to `base`. Each hunk has a half-open base range
 * `[baseStart, baseEnd)` and the lines that replace it.
 *
 * @param {ReturnType<typeof diffLines>} diff
 * @returns {Array<{ baseStart: number, baseEnd: number, newLines: string[] }>}
 */
export function _buildHunks(diff) {
  const hunks = []
  let cur = null
  let baseIdx = 0
  const strip = (s) => (s ?? '').replace(/\r?\n$/, '')

  const flush = () => { if (cur) { hunks.push(cur); cur = null } }

  for (const dl of diff) {
    if (dl.type === 'equal') { flush(); baseIdx++; continue }
    if (!cur) cur = { baseStart: baseIdx, baseEnd: baseIdx, newLines: [] }
    if (dl.type === 'delete')      { cur.baseEnd = ++baseIdx }
    else if (dl.type === 'insert') { cur.newLines.push(strip(dl.rightText)) }
    else if (dl.type === 'replace'){ cur.baseEnd = ++baseIdx; cur.newLines.push(strip(dl.rightText)) }
  }
  flush()
  return hunks
}

function _arraysEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * @typedef {{ type: 'normal', lines: string[] }} NormalSegment
 * @typedef {{ type: 'conflict', id: number, leftLines: string[], baseLines: string[], rightLines: string[] }} ConflictSegment
 * @typedef {NormalSegment | ConflictSegment} MergeSegment
 * @typedef {'left'|'right'|'base'|'both'} ConflictChoice
 */

// ---------------------------------------------------------------------------
// S16-M01: conflict navigation / filtering / output assembly (pure, testable)
// ---------------------------------------------------------------------------

/** Lines of surrounding context kept per conflict in 'conflicts' filter mode. */
const CONFLICT_CONTEXT_LINES = 2

/**
 * @param {MergeSegment[]} segments
 * @returns {number[]} conflict ids in document order
 */
export function collectConflictIds(segments) {
  const ids = []
  for (const seg of segments || []) {
    if (seg && seg.type === 'conflict') ids.push(seg.id)
  }
  return ids
}

/**
 * Wrap-around cursor arithmetic for conflict navigation.
 *
 * A separate function because the "no conflicts" and "nothing selected yet"
 * cases are the two that actually break in practice: stepping from -1 must
 * land on an end of the list rather than on index -2 / 0-by-accident.
 *
 * @param {number} current  current index, -1 when nothing is selected
 * @param {number} delta    +1 next, -1 previous
 * @param {number} count    total conflicts
 * @returns {number} next index, or -1 when there is nothing to select
 */
export function wrapConflictIndex(current, delta, count) {
  if (!Number.isFinite(count) || count <= 0) return -1
  if (current < 0 || current >= count) return delta >= 0 ? 0 : count - 1
  return ((current + delta) % count + count) % count
}

/**
 * Reduce segments to conflicts plus a little surrounding context.
 *
 * @param {MergeSegment[]} segments
 * @param {number} [contextLines]
 * @returns {MergeSegment[]}
 */
export function filterSegmentsForConflicts(segments, contextLines = CONFLICT_CONTEXT_LINES) {
  const src = segments || []
  const out = []
  for (let i = 0; i < src.length; i++) {
    const seg = src[i]
    if (seg.type === 'conflict') { out.push(seg); continue }

    const afterConflict = i > 0 && src[i - 1].type === 'conflict'
    const beforeConflict = i + 1 < src.length && src[i + 1].type === 'conflict'
    if (!afterConflict && !beforeConflict) continue

    const n = Math.max(0, contextLines)
    const head = afterConflict ? seg.lines.slice(0, n) : []
    const tail = beforeConflict ? seg.lines.slice(Math.max(head.length, seg.lines.length - n)) : []
    const lines = [...head, ...tail]
    if (lines.length > 0) out.push({ type: 'normal', lines })
  }
  return out
}

/**
 * Assemble the merged text from segments and the current choices.
 * Unresolved conflicts keep their `<<<` markers so nothing is silently lost.
 *
 * @param {MergeSegment[]} segments
 * @param {Map<number, ConflictChoice|null>} choices
 * @returns {string}
 */
export function buildMergedText(segments, choices) {
  return (segments || []).map(seg => {
    if (seg.type === 'normal') return seg.lines.join('\n')
    const choice = choices?.get(seg.id)
    if (choice === 'left')  return seg.leftLines.join('\n')
    if (choice === 'right') return seg.rightLines.join('\n')
    if (choice === 'base')  return seg.baseLines.join('\n')
    if (choice === 'both')  return [...seg.leftLines, ...seg.rightLines].join('\n')
    return ['<<<<<<< LEFT', ...seg.leftLines, '||||||| BASE', ...seg.baseLines, '=======', ...seg.rightLines, '>>>>>>> RIGHT'].join('\n')
  }).join('\n')
}

/**
 * Flatten segments into the lines one pane should show.
 *
 * @param {MergeSegment[]} segments
 * @param {'left'|'base'|'right'} side
 * @returns {Array<{ text: string, conflict: boolean }>}
 */
export function segmentsToPaneLines(segments, side) {
  const key = /** @type {'leftLines'|'baseLines'|'rightLines'} */ (`${side}Lines`)
  const out = []
  for (const seg of segments || []) {
    if (seg.type === 'normal') {
      for (const text of seg.lines) out.push({ text, conflict: false })
    } else {
      for (const text of seg[key]) out.push({ text, conflict: true })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// S16-M02: virtual scrolling (pure, testable)
// ---------------------------------------------------------------------------

/** Fixed row height, in px. Virtualisation cannot work with wrapping rows. */
const ROW_HEIGHT = 18

/** Rows rendered beyond each edge of the viewport, to hide scroll latency. */
const OVERSCAN_ROWS = 8

/**
 * Viewport height assumed when the pane reports 0 — it is hidden, detached or
 * not laid out yet. Rendering *something* beats rendering a blank pane that
 * only fills in after the user happens to scroll.
 */
const VIEWPORT_HEIGHT_FALLBACK = 600

/** A normal segment longer than this is elided in the output *preview* only. */
const OUTPUT_PREVIEW_MAX_LINES = 200

/**
 * @typedef {{ type: 'equal'|'insert'|'delete'|'replace'|'conflict', lineNum: number|null, text: string }} PaneRow
 */

/**
 * Half-open row range `[start, end)` that has to exist in the DOM.
 *
 * @param {number} scrollTop
 * @param {number} viewportHeight  pane clientHeight; 0 falls back (see above)
 * @param {number} totalRows
 * @param {number} [rowHeight]
 * @param {number} [overscan]
 * @returns {{ start: number, end: number }}
 */
export function computeVisibleRange(scrollTop, viewportHeight, totalRows, rowHeight = ROW_HEIGHT, overscan = OVERSCAN_ROWS) {
  const total = Number.isFinite(totalRows) && totalRows > 0 ? Math.floor(totalRows) : 0
  if (total === 0) return { start: 0, end: 0 }

  const rh = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : ROW_HEIGHT
  const over = Number.isFinite(overscan) && overscan > 0 ? Math.floor(overscan) : 0
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : VIEWPORT_HEIGHT_FALLBACK
  const top = Number.isFinite(scrollTop) && scrollTop > 0 ? Math.min(scrollTop, total * rh) : 0

  const start = Math.max(0, Math.floor(top / rh) - over)
  const end = Math.min(total, Math.ceil((top + height) / rh) + over)
  return { start, end: Math.max(start, end) }
}

/** @param {string|null|undefined} s */
const _stripEol = (s) => (s ?? '').replace(/\r?\n$/, '')

/**
 * Flatten a base→side diff into displayable rows.
 *
 * Left and right panes map identically: both show the "right" side of their
 * own diff, with base line numbers on unchanged rows.
 *
 * @param {import('../core/diff-engine.js').DiffLine[]|null} diff
 * @returns {PaneRow[]}
 */
export function diffToPaneRows(diff) {
  /** @type {PaneRow[]} */
  const rows = []
  for (const dl of diff || []) {
    switch (dl.type) {
      case 'insert':
        rows.push({ type: 'insert', lineNum: dl.rightLine ?? null, text: _stripEol(dl.rightText) })
        break
      case 'replace':
        rows.push({ type: 'replace', lineNum: dl.rightLine ?? null, text: _stripEol(dl.rightText) })
        break
      case 'delete':
        rows.push({ type: 'delete', lineNum: null, text: _stripEol(dl.leftText) })
        break
      default:
        rows.push({ type: 'equal', lineNum: dl.leftLine ?? null, text: _stripEol(dl.leftText) })
    }
  }
  return rows
}

/**
 * The full row list one pane would show — the unit of virtualisation.
 *
 * Both display modes end up as a flat array here, which is what lets one
 * windowing implementation serve them: 'conflicts' only changes *which* rows
 * exist, never how they are positioned.
 *
 * @param {'left'|'base'|'right'} side
 * @param {{
 *   showFilter?: 'all'|'conflicts',
 *   segments?: MergeSegment[],
 *   content?: string,
 *   diff?: import('../core/diff-engine.js').DiffLine[]|null,
 * }} [opts]
 * @returns {PaneRow[]}
 */
export function buildPaneRows(side, opts = {}) {
  const { showFilter = 'all', segments = [], content = '', diff = null } = opts

  if (showFilter === 'conflicts') {
    // Line numbers are omitted: filtered output is not contiguous.
    return segmentsToPaneLines(segments ? filterSegmentsForConflicts(segments) : [], side)
      .map(({ text, conflict }) => ({
        type: /** @type {PaneRow['type']} */ (conflict ? 'conflict' : 'equal'),
        lineNum: null,
        text,
      }))
  }

  if (!diff) {
    return (content || '').split('\n').map((text, i) => ({
      type: /** @type {PaneRow['type']} */ ('equal'),
      lineNum: i + 1,
      text,
    }))
  }
  return diffToPaneRows(diff)
}

// ---------------------------------------------------------------------------
// ThreeWayCompare
// ---------------------------------------------------------------------------

/** Distinguishes instances so two mounted merge tabs cannot share element ids. */
let _instanceSeq = 0

export class ThreeWayCompare {
  constructor() {
    /** @type {HTMLElement|null} */
    this._container = null

    this._uid = ++_instanceSeq

    this._leftPath = ''
    this._basePath = ''
    this._rightPath = ''
    this._leftContent = ''
    this._baseContent = ''
    this._rightContent = ''

    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map()

    /** @type {{ left: HTMLElement|null, base: HTMLElement|null, right: HTMLElement|null }} */
    this._contentEls = { left: null, base: null, right: null }
    /** @type {HTMLTextAreaElement|null} */
    this._outputEl = null

    /** @type {HTMLElement|null} */
    this._outputPaneEl = null

    /** @type {Array<{ pane: HTMLElement, handler: Function }>|null} */
    this._syncScrollHandlers = null

    /**
     * Parsed segments from the last _threeWayMerge call.
     * @type {MergeSegment[]}
     */
    this._segments = []

    /**
     * User choices for each conflict segment.
     * Key: conflict id (number), Value: choice or null when unresolved.
     * @type {Map<number, ConflictChoice|null>}
     */
    this._conflictChoices = new Map()

    /** @type {import('../core/diff-engine.js').DiffLine[]|null} */
    this._leftDiff = null
    /** @type {import('../core/diff-engine.js').DiffLine[]|null} */
    this._rightDiff = null

    /** Index (not id) of the conflict the navigation cursor is on; -1 = none. */
    this._currentConflict = -1

    /** @type {'all'|'conflicts'} */
    this._showFilter = 'all'

    /** Full row lists per pane; only a window of these reaches the DOM. */
    /** @type {{ left: PaneRow[], base: PaneRow[], right: PaneRow[] }} */
    this._paneRows = { left: [], base: [], right: [] }

    /** Last rendered window, kept so redundant scroll events cost nothing. */
    this._renderedRange = { start: -1, end: -1 }

    /** @type {'myers'|'patience'|'histogram'} */
    this._algorithm = 'myers'
    this._ignoreWhitespace = false
    this._ignoreCase = false
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Load one pane's content programmatically.
   *
   * Callers previously reached for a `_setContents` method that never existed;
   * the optional-call syntax meant the failure was silent, so restoring a
   * merge session and the e2e test hook both quietly did nothing.
   *
   * @param {'left'|'base'|'right'} side
   * @param {string} content
   * @param {string} [path]
   */
  setSide(side, content, path) {
    if (side !== 'left' && side !== 'base' && side !== 'right') return
    this[`_${side}Content`] = content ?? ''
    if (path != null) this[`_${side}Path`] = path
    const pathEl = this._pathEl(side)
    if (pathEl && path != null) pathEl.textContent = path
    this._runMerge()
    this._emit('paths-changed', {
      left: this._leftPath,
      base: this._basePath,
      right: this._rightPath,
    })
  }

  /** @returns {number} number of conflicts in the current merge */
  getConflictCount() {
    return collectConflictIds(this._segments).length
  }

  /** @returns {number} index of the focused conflict, -1 when none */
  getCurrentConflictIndex() {
    return this._currentConflict
  }

  /** @returns {number} the index landed on, -1 when there are no conflicts */
  nextConflict() {
    return this._gotoConflict(wrapConflictIndex(this._currentConflict, 1, this.getConflictCount()))
  }

  /** @returns {number} */
  prevConflict() {
    return this._gotoConflict(wrapConflictIndex(this._currentConflict, -1, this.getConflictCount()))
  }

  /** @returns {number} */
  firstConflict() {
    return this._gotoConflict(this.getConflictCount() > 0 ? 0 : -1)
  }

  /** @returns {number} */
  lastConflict() {
    const count = this.getConflictCount()
    return this._gotoConflict(count > 0 ? count - 1 : -1)
  }

  /**
   * Restrict the side panes to conflicts (plus context) or show everything.
   * @param {'all'|'conflicts'} mode
   */
  setShowFilter(mode) {
    if (mode !== 'all' && mode !== 'conflicts') return
    this._showFilter = mode
    this._renderSides()
    this._updateFilterButton()
  }

  /** @returns {'all'|'conflicts'} */
  getShowFilter() {
    return this._showFilter
  }

  /**
   * Record a choice for one conflict.
   * @param {number} id
   * @param {ConflictChoice} choice
   */
  setConflictChoice(id, choice) {
    if (!this._conflictChoices.has(id)) return
    this._conflictChoices.set(id, choice)
    this._renderOutputPane()
  }

  /**
   * Apply one choice to every *unresolved* conflict; already-resolved
   * conflicts are left alone so a batch action cannot undo manual work.
   *
   * @param {ConflictChoice} choice
   * @returns {number} how many conflicts were changed
   */
  resolveAll(choice) {
    if (choice !== 'left' && choice !== 'right' && choice !== 'base' && choice !== 'both') return 0
    let n = 0
    for (const [id, cur] of this._conflictChoices) {
      if (cur == null) { this._conflictChoices.set(id, choice); n++ }
    }
    if (n > 0) this._renderOutputPane()
    return n
  }

  /**
   * Comparison settings only — never paths or file contents, because a named
   * config is meant to be reusable across sessions.
   *
   * @returns {{ showFilter: 'all'|'conflicts', algorithm: 'myers'|'patience'|'histogram', ignoreWhitespace: boolean, ignoreCase: boolean }}
   */
  getConfig() {
    return {
      showFilter: this._showFilter,
      algorithm: this._algorithm,
      ignoreWhitespace: this._ignoreWhitespace,
      ignoreCase: this._ignoreCase,
    }
  }

  /**
   * @param {object} cfg  untrusted: comes from localStorage / an imported file
   */
  applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return
    const c = /** @type {Record<string, unknown>} */ (cfg)

    if (c.showFilter === 'all' || c.showFilter === 'conflicts') this._showFilter = c.showFilter
    if (c.algorithm === 'myers' || c.algorithm === 'patience' || c.algorithm === 'histogram') {
      this._algorithm = c.algorithm
    }
    if (typeof c.ignoreWhitespace === 'boolean') this._ignoreWhitespace = c.ignoreWhitespace
    if (typeof c.ignoreCase === 'boolean') this._ignoreCase = c.ignoreCase

    this._runMerge()
  }

  /**
   * Scroll the side panes so `rowIndex` is the first visible row.
   *
   * Takes the target position as the source of truth rather than reading
   * `scrollTop` back: a pane with no layout would report 0 and silently
   * cancel the jump.
   *
   * @param {number} rowIndex
   */
  scrollToRow(rowIndex) {
    const top = Math.max(0, Math.floor(Number(rowIndex) || 0)) * ROW_HEIGHT
    for (const pane of this._panes()) pane.scrollTop = top
    this._renderPaneWindows(top)
  }

  /**
   * Mount the view into a container element.
   * @param {HTMLElement} containerEl
   */
  mount(containerEl) {
    this._container = containerEl
    this._render()
    this._disambiguateIds()
    this._bindEvents()
  }

  destroy() {
    // Remove sync scroll handlers
    if (this._syncScrollHandlers) {
      for (const { pane, handler } of this._syncScrollHandlers) {
        pane.removeEventListener('scroll', handler)
      }
      this._syncScrollHandlers = null
    }
    if (this._container) this._container.innerHTML = ''
    this._listeners.clear()
    this._paneRows = { left: [], base: [], right: [] }
    this._renderedRange = { start: -1, end: -1 }
    this._contentEls = { left: null, base: null, right: null }
    this._outputEl = null
    this._outputPaneEl = null
  }

  /**
   * @param {string} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set())
    this._listeners.get(event).add(handler)
  }

  /**
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    this._listeners.get(event)?.delete(handler)
  }

  // ---------------------------------------------------------------------------
  // Internal – rendering
  // ---------------------------------------------------------------------------

  _render() {
    this._container.innerHTML = `
      <div class="mw-layout">
        <div class="mw-toolbar">
          <button class="mw-btn-prev" id="mw-btn-prev" title="上一個衝突">▲</button>
          <button class="mw-btn-next" id="mw-btn-next" title="下一個衝突">▼</button>
          <span class="mw-conflict-counter" id="mw-conflict-counter">無衝突</span>
          <span class="mw-toolbar-sep"></span>
          <button class="mw-btn-filter" id="mw-btn-filter" title="只顯示衝突段落">顯示：全部</button>
          <span class="mw-toolbar-sep"></span>
          <button class="mw-btn-all-left" id="mw-btn-all-left">全部採用左側</button>
          <button class="mw-btn-all-right" id="mw-btn-all-right">全部採用右側</button>
        </div>
        <div class="mw-top">
          <!-- Left Pane -->
          <div class="mw-pane" id="mw-pane-left">
            <div class="mw-path-bar">
              <button class="mw-open-btn" data-side="left">開啟左側…</button>
              <span class="mw-path" data-side="left" id="mw-path-left">（未選擇）</span>
            </div>
            <div class="mw-content mw-content-left" data-side="left" id="mw-content-left"></div>
          </div>
          <div class="mw-pane-divider"></div>
          <!-- Base Pane -->
          <div class="mw-pane" id="mw-pane-base">
            <div class="mw-path-bar">
              <button class="mw-open-btn" data-side="base">開啟基底…</button>
              <span class="mw-path" data-side="base" id="mw-path-base">（未選擇）</span>
            </div>
            <div class="mw-content mw-content-base" data-side="base" id="mw-content-base"></div>
          </div>
          <div class="mw-pane-divider"></div>
          <!-- Right Pane -->
          <div class="mw-pane" id="mw-pane-right">
            <div class="mw-path-bar">
              <button class="mw-open-btn" data-side="right">開啟右側…</button>
              <span class="mw-path" data-side="right" id="mw-path-right">（未選擇）</span>
            </div>
            <div class="mw-content mw-content-right" data-side="right" id="mw-content-right"></div>
          </div>
        </div>
        <div class="mw-divider" id="mw-divider"></div>
        <div class="mw-output-pane">
          <div class="mw-output-header">
            <span>合併輸出</span>
            <button class="mw-btn-save" id="mw-btn-save">儲存輸出…</button>
          </div>
          <div class="mw-output-content" id="mw-output-pane"></div>
          <textarea class="mw-output-textarea" id="mw-output" spellcheck="false"></textarea>
        </div>
        <style>
.mw-toolbar { display:flex; align-items:center; gap:4px; padding:4px 8px; font-size:12px; border-bottom:1px solid #d9d9d9; }
.mw-toolbar button { padding:2px 8px; border:1px solid #ccc; border-radius:3px; cursor:pointer; font-size:12px; background:transparent; color:inherit; }
.mw-toolbar button.active { border-color:#2563eb; background:#dbeafe; }
.mw-toolbar-sep { width:1px; height:14px; background:#d9d9d9; margin:0 4px; }
.mw-conflict-counter { min-width:96px; }
.mw-conflict-card { border: 1px solid #e0a000; border-radius:4px; margin:4px 0; background:#fffbe6; }
.mw-conflict-card--current { outline:2px solid #2563eb; outline-offset:1px; }
.mw-choice-base.active { background:#e0e7ff; border-color:#4f46e5; }
.mw-line--conflict { background:#fff3cd; }
.mw-conflict-choices { display:flex; gap:4px; padding:4px 8px; }
.mw-choice-btn { padding:2px 8px; border:1px solid #ccc; border-radius:3px; cursor:pointer; font-size:12px; }
.mw-choice-btn.active { border-color: #2563eb; background:#dbeafe; }
.mw-choice-left.active { background:#d1fae5; border-color:#059669; }
.mw-choice-right.active { background:#fee2e2; border-color:#dc2626; }
.mw-conflict-preview { display:flex; gap:0; }
.mw-conflict-left,.mw-conflict-base,.mw-conflict-right { flex:1; padding:4px 8px; font-size:12px; }
.mw-conflict-left { background:#f0fdf4; }
.mw-conflict-base { background:#f8fafc; border-left:1px solid #e2e8f0; border-right:1px solid #e2e8f0; }
.mw-conflict-right { background:#fef2f2; }
.mw-conflict-label { font-size:10px; color:#888; display:block; margin-bottom:2px; }
.mw-normal-seg { margin:0; padding:2px 8px; font-size:12px; white-space:pre-wrap; }
.mw-output-pane-inner { padding:4px 0; overflow:auto; }
.mw-output-textarea { display:none; }
/* Virtual scrolling only holds together while every row is exactly
   ROW_HEIGHT tall, so wrapping is disabled here on purpose. */
.mw-content .mw-vspacer { position:relative; width:100%; }
.mw-content .mw-vwindow { position:absolute; top:0; left:0; right:0; }
.mw-content .mw-line { height:18px; min-height:18px; box-sizing:border-box; overflow:hidden; }
.mw-content .mw-linetext { white-space:pre; word-break:normal; overflow:hidden; text-overflow:ellipsis; }
        </style>
      </div>
    `

    // Cache element refs
    this._contentEls = {
      left: this._q('.mw-content-left'),
      base: this._q('.mw-content-base'),
      right: this._q('.mw-content-right'),
    }
    this._outputEl = /** @type {HTMLTextAreaElement|null} */ (this._q('.mw-output-textarea'))
    this._outputPaneEl = this._q('.mw-output-content')

    // Setup resizable output pane
    this._setupDividerDrag()
  }

  /**
   * Container-scoped lookup. Every internal query goes through here so that a
   * second mounted instance can never reach into the first one's DOM.
   *
   * @param {string} selector
   * @returns {HTMLElement|null}
   */
  _q(selector) {
    return /** @type {HTMLElement|null} */ (this._container?.querySelector(selector) ?? null)
  }

  /**
   * @param {'left'|'base'|'right'} side
   * @returns {HTMLElement|null}
   */
  _pathEl(side) {
    return this._q(`.mw-path[data-side="${side}"]`)
  }

  /** @returns {HTMLElement[]} the three scrollable side panes that exist */
  _panes() {
    return [this._contentEls.left, this._contentEls.base, this._contentEls.right].filter(Boolean)
  }

  /**
   * Suffix any element id that another instance already owns.
   *
   * The markup keeps its historical ids for readability and for outside
   * callers, but duplicated ids across two merge tabs would make a
   * document-wide `#mw-output` lookup resolve to the wrong tab.
   */
  _disambiguateIds() {
    if (!this._container) return
    for (const el of this._container.querySelectorAll('[id]')) {
      const owner = document.getElementById(el.id)
      if (owner && owner !== el) el.id = `${el.id}--${this._uid}`
    }
  }

  _setupDividerDrag() {
    const divider = this._q('.mw-divider')
    const outputPane = this._q('.mw-output-pane')
    if (!divider || !outputPane) return

    let startY = 0
    let startHeight = 0

    const onMouseMove = (e) => {
      const delta = startY - e.clientY
      const newHeight = Math.max(80, Math.min(startHeight + delta, window.innerHeight - 200))
      outputPane.style.height = `${newHeight}px`
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      divider.classList.remove('dragging')
    }

    divider.addEventListener('mousedown', (e) => {
      startY = e.clientY
      startHeight = outputPane.offsetHeight
      divider.classList.add('dragging')
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      e.preventDefault()
    })
  }

  _bindEvents() {
    // Open file buttons
    this._container.querySelectorAll('.mw-open-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const side = btn.dataset.side
        try {
          const result = await window.electronAPI.openFile()
          if (!result) return
          this[`_${side}Path`] = result.path
          this[`_${side}Content`] = result.content
          const pathEl = this._pathEl(side)
          if (pathEl) pathEl.textContent = result.path
          this._runMerge()
          this._emit('paths-changed', {
            left: this._leftPath,
            base: this._basePath,
            right: this._rightPath,
          })
        } catch (err) {
          console.error('[ThreeWayCompare] openFile error:', err)
        }
      })
    })

    // Save output button
    this._q('.mw-btn-save')?.addEventListener('click', async () => {
      const content = this._buildOutputText()
      try {
        await window.electronAPI.saveFile('merged-output.txt', content)
      } catch (err) {
        console.error('[ThreeWayCompare] saveFile error:', err)
      }
    })

    // S16-M01: conflict navigation / filter / batch resolve toolbar
    this._q('.mw-btn-prev')?.addEventListener('click', () => this.prevConflict())
    this._q('.mw-btn-next')?.addEventListener('click', () => this.nextConflict())
    this._q('.mw-btn-filter')?.addEventListener('click', () => {
      this.setShowFilter(this._showFilter === 'all' ? 'conflicts' : 'all')
    })
    this._q('.mw-btn-all-left')?.addEventListener('click', () => this.resolveAll('left'))
    this._q('.mw-btn-all-right')?.addEventListener('click', () => this.resolveAll('right'))

    // T26: Sync scroll across all three content panes
    this._setupSyncScroll()
  }

  /**
   * Move the navigation cursor and reveal the matching conflict card.
   * @param {number} index
   * @returns {number} the index actually selected
   */
  _gotoConflict(index) {
    this._currentConflict = index
    const pane = this._outputPaneEl
    if (pane) {
      const ids = collectConflictIds(this._segments)
      const targetId = index >= 0 ? ids[index] : null
      pane.querySelectorAll('.mw-conflict-card').forEach(card => {
        const isCurrent = targetId != null && card.dataset.conflictId === String(targetId)
        card.classList.toggle('mw-conflict-card--current', isCurrent)
        // jsdom has no scrollIntoView; navigation must still work under test.
        if (isCurrent) card.scrollIntoView?.({ block: 'center' })
      })
    }
    this._updateConflictCounter()
    this._emit('conflict-changed', { index, total: this.getConflictCount() })
    return index
  }

  _updateConflictCounter() {
    const el = this._q('.mw-conflict-counter')
    if (!el) return
    const total = this.getConflictCount()
    el.textContent = total === 0
      ? '無衝突'
      : `第 ${this._currentConflict >= 0 ? this._currentConflict + 1 : '-'} / ${total} 個衝突`
  }

  _updateFilterButton() {
    const btn = this._q('.mw-btn-filter')
    if (!btn) return
    btn.textContent = this._showFilter === 'conflicts' ? '顯示：僅衝突' : '顯示：全部'
    btn.classList.toggle('active', this._showFilter === 'conflicts')
  }

  /**
   * Set up synchronized scrolling across all three content panes.
   * When any pane is scrolled, the other two are updated to match scrollTop.
   */
  _setupSyncScroll() {
    const panes = this._panes()
    if (panes.length < 2) return

    let syncing = false
    const handlers = panes.map((pane) => {
      const handler = () => {
        if (syncing) return
        syncing = true
        const scrollTop = pane.scrollTop
        for (const other of panes) {
          if (other !== pane) other.scrollTop = scrollTop
        }
        syncing = false
        // Panes scroll as one, so one window range serves all three.
        this._renderPaneWindows(scrollTop)
      }
      pane.addEventListener('scroll', handler)
      return { pane, handler }
    })

    // 儲存以便 destroy 時移除
    this._syncScrollHandlers = handlers
  }

  // ---------------------------------------------------------------------------
  // Internal – 3-way merge logic
  // ---------------------------------------------------------------------------

  _runMerge() {
    const { leftDiff, rightDiff, segments, hasConflicts } = this._threeWayMerge(
      this._leftContent,
      this._baseContent,
      this._rightContent,
    )

    // Store segments and reset choices
    this._segments = segments
    this._conflictChoices = new Map()
    segments.forEach(seg => {
      if (seg.type === 'conflict') this._conflictChoices.set(seg.id, null)
    })
    this._leftDiff = leftDiff
    this._rightDiff = rightDiff
    this._currentConflict = -1

    this._renderSides()
    this._renderOutputPane()
    this._updateConflictCounter()
    this._updateFilterButton()

    this._emit('ready', { hasConflicts })
  }

  /** Recompute the row lists for all three panes and repaint the window. */
  _renderSides() {
    const common = { showFilter: this._showFilter, segments: this._segments }
    this._paneRows = {
      left: buildPaneRows('left', { ...common, content: this._leftContent, diff: this._leftDiff }),
      base: buildPaneRows('base', { ...common, content: this._baseContent, diff: null }),
      right: buildPaneRows('right', { ...common, content: this._rightContent, diff: this._rightDiff }),
    }
    // Row lists changed, so the previously painted window says nothing about
    // what is on screen now.
    this._renderedRange = { start: -1, end: -1 }
    this._renderPaneWindows(this._panes()[0]?.scrollTop ?? 0)
  }

  /**
   * Paint the rows visible at `scrollTop` into all three panes.
   *
   * @param {number} [scrollTop]
   */
  _renderPaneWindows(scrollTop = 0) {
    const total = Math.max(
      this._paneRows.left.length,
      this._paneRows.base.length,
      this._paneRows.right.length,
    )
    const viewport = this._panes()[0]?.clientHeight ?? 0
    const range = computeVisibleRange(scrollTop, viewport, total, ROW_HEIGHT, OVERSCAN_ROWS)
    if (range.start === this._renderedRange.start && range.end === this._renderedRange.end) return
    this._renderedRange = range

    for (const side of /** @type {const} */ (['left', 'base', 'right'])) {
      this._renderPaneWindow(side, range)
    }
  }

  /**
   * @param {'left'|'base'|'right'} side
   * @param {{ start: number, end: number }} range
   */
  _renderPaneWindow(side, range) {
    const contentEl = this._contentEls[side]
    if (!contentEl) return

    let spacer = contentEl.querySelector('.mw-vspacer')
    let win = spacer?.querySelector('.mw-vwindow')
    if (!spacer || !win) {
      contentEl.innerHTML = ''
      spacer = document.createElement('div')
      spacer.className = 'mw-vspacer'
      win = document.createElement('div')
      win.className = 'mw-vwindow'
      spacer.appendChild(win)
      contentEl.appendChild(spacer)
    }

    const rows = this._paneRows[side]
    spacer.style.height = `${rows.length * ROW_HEIGHT}px`
    win.style.transform = `translateY(${range.start * ROW_HEIGHT}px)`

    const frag = document.createDocumentFragment()
    for (let i = range.start; i < Math.min(range.end, rows.length); i++) {
      const row = rows[i]
      frag.appendChild(this._makeLine(row.type, row.lineNum, row.text))
    }
    win.replaceChildren(frag)
  }

  /**
   * The rows one pane would show in full — exposed for tests and for callers
   * that need line counts without touching the DOM.
   *
   * @param {'left'|'base'|'right'} side
   * @returns {PaneRow[]}
   */
  getPaneRows(side) {
    return this._paneRows[side] ?? []
  }

  /**
   * Simple line-by-line 3-way merge.
   * Returns segment array and diffs base→left, base→right.
   *
   * @param {string} left
   * @param {string} base
   * @param {string} right
   * @returns {{
   *   leftDiff: import('../core/diff-engine.js').DiffLine[],
   *   rightDiff: import('../core/diff-engine.js').DiffLine[],
   *   segments: Array<
   *     { type: 'normal', lines: string[] } |
   *     { type: 'conflict', id: number, leftLines: string[], baseLines: string[], rightLines: string[] }
   *   >,
   *   hasConflicts: boolean
   * }}
   */
  _threeWayMerge(left, base, right) {
    const diffOpts = {
      algorithm: this._algorithm,
      ignoreWhitespace: this._ignoreWhitespace,
      ignoreCase: this._ignoreCase,
    }
    const leftDiff = diffLines(base || '', left || '', diffOpts)
    const rightDiff = diffLines(base || '', right || '', diffOpts)
    const baseLines = (base || '').split('\n')

    // S13-C01: build hunks from each diff, then walk base lines in order,
    // resolving overlapping hunks as conflicts. Positional alignment of
    // leftLines[i] vs baseLines[i] would mark every shifted line as a
    // conflict after a single insertion.
    const leftHunks  = _buildHunks(leftDiff)
    const rightHunks = _buildHunks(rightDiff)

    /** @type {Array<{ type: 'normal', lines: string[] } | { type: 'conflict', id: number, leftLines: string[], baseLines: string[], rightLines: string[] }>} */
    const segments = []
    let hasConflicts = false
    let conflictId = 0

    /** @type {string[]} */
    let pendingNormal = []
    const flushNormal = () => {
      if (pendingNormal.length > 0) {
        segments.push({ type: 'normal', lines: pendingNormal })
        pendingNormal = []
      }
    }

    let i = 0, li = 0, ri = 0
    while (i < baseLines.length || li < leftHunks.length || ri < rightHunks.length) {
      const lh = leftHunks[li]
      const rh = rightHunks[ri]
      const lhAt = lh && lh.baseStart === i
      const rhAt = rh && rh.baseStart === i
      // A hunk that starts AT or strictly before `i + 1` and contains another
      // hunk on the other side that also starts within its base range is an
      // overlap → conflict.
      const overlap =
        (lhAt && rh && rh.baseStart < lh.baseEnd) ||
        (rhAt && lh && lh.baseStart < rh.baseEnd)

      if (overlap || (lhAt && rhAt)) {
        flushNormal()
        const endBase = Math.max(lh ? lh.baseEnd : i, rh ? rh.baseEnd : i)
        const baseSlice = baseLines.slice(i, endBase)
        const leftLines  = lh ? lh.newLines : baseSlice
        const rightLines = rh ? rh.newLines : baseSlice
        if (_arraysEqual(leftLines, rightLines)) {
          // Both sides made the identical edit — not a real conflict.
          segments.push({ type: 'normal', lines: leftLines })
        } else {
          hasConflicts = true
          segments.push({
            type: 'conflict',
            id: conflictId++,
            leftLines, baseLines: baseSlice, rightLines,
          })
        }
        i = endBase
        if (lh && lh.baseStart < endBase) li++
        if (rh && rh.baseStart < endBase) ri++
      } else if (lhAt) {
        flushNormal()
        segments.push({ type: 'normal', lines: lh.newLines })
        i = lh.baseEnd
        li++
      } else if (rhAt) {
        flushNormal()
        segments.push({ type: 'normal', lines: rh.newLines })
        i = rh.baseEnd
        ri++
      } else if (i < baseLines.length) {
        pendingNormal.push(baseLines[i])
        i++
      } else {
        // Out-of-range hunks (defensive): skip
        if (lh && lh.baseStart < i) li++
        else if (rh && rh.baseStart < i) ri++
        else break
      }
    }
    flushNormal()

    return { leftDiff, rightDiff, segments, hasConflicts }
  }

  /**
   * Build the final output text from segments and current conflict choices.
   * Unresolved conflicts are rendered with <<< markers.
   *
   * @returns {string}
   */
  _buildOutputText() {
    return buildMergedText(this._segments, this._conflictChoices)
  }

  /**
   * Render the output pane with interactive conflict cards and normal segments.
   * Also syncs the hidden textarea value.
   */
  _renderOutputPane() {
    const pane = this._outputPaneEl
    if (!pane) return

    pane.innerHTML = ''
    const frag = document.createDocumentFragment()

    for (const seg of this._segments) {
      if (seg.type === 'normal') {
        const pre = document.createElement('pre')
        pre.className = 'mw-normal-seg'
        // The textarea below still carries every line; only this preview is
        // elided, so a 100k-line unchanged run cannot stall layout.
        const extra = seg.lines.length - OUTPUT_PREVIEW_MAX_LINES
        pre.textContent = extra > 0
          ? [...seg.lines.slice(0, OUTPUT_PREVIEW_MAX_LINES), `… 省略 ${extra} 行（輸出內容不受影響）`].join('\n')
          : seg.lines.join('\n')
        frag.appendChild(pre)
      } else {
        // Conflict card
        const card = document.createElement('div')
        card.className = 'mw-conflict-card'
        card.dataset.conflictId = String(seg.id)

        const choicesDiv = document.createElement('div')
        choicesDiv.className = 'mw-conflict-choices'

        const btnLeft = document.createElement('button')
        btnLeft.className = 'mw-choice-btn mw-choice-left'
        btnLeft.dataset.id = String(seg.id)
        btnLeft.textContent = '接受左側'

        const btnBase = document.createElement('button')
        btnBase.className = 'mw-choice-btn mw-choice-base'
        btnBase.dataset.id = String(seg.id)
        btnBase.textContent = '採用中間'

        const btnBoth = document.createElement('button')
        btnBoth.className = 'mw-choice-btn mw-choice-both'
        btnBoth.dataset.id = String(seg.id)
        btnBoth.textContent = '接受兩者'

        const btnRight = document.createElement('button')
        btnRight.className = 'mw-choice-btn mw-choice-right'
        btnRight.dataset.id = String(seg.id)
        btnRight.textContent = '接受右側'

        // Restore active state if already chosen
        const existing = this._conflictChoices.get(seg.id)
        if (existing === 'left')  btnLeft.classList.add('active')
        if (existing === 'base')  btnBase.classList.add('active')
        if (existing === 'both')  btnBoth.classList.add('active')
        if (existing === 'right') btnRight.classList.add('active')

        choicesDiv.appendChild(btnLeft)
        choicesDiv.appendChild(btnBase)
        choicesDiv.appendChild(btnBoth)
        choicesDiv.appendChild(btnRight)

        const previewDiv = document.createElement('div')
        previewDiv.className = 'mw-conflict-preview'

        const leftDiv = document.createElement('div')
        leftDiv.className = 'mw-conflict-left'
        leftDiv.innerHTML = `<span class="mw-conflict-label">LEFT</span><pre>${this._escapeHtml(seg.leftLines.join('\n'))}</pre>`

        const baseDiv = document.createElement('div')
        baseDiv.className = 'mw-conflict-base'
        baseDiv.innerHTML = `<span class="mw-conflict-label">BASE</span><pre>${this._escapeHtml(seg.baseLines.join('\n'))}</pre>`

        const rightDiv = document.createElement('div')
        rightDiv.className = 'mw-conflict-right'
        rightDiv.innerHTML = `<span class="mw-conflict-label">RIGHT</span><pre>${this._escapeHtml(seg.rightLines.join('\n'))}</pre>`

        previewDiv.appendChild(leftDiv)
        previewDiv.appendChild(baseDiv)
        previewDiv.appendChild(rightDiv)

        card.appendChild(choicesDiv)
        card.appendChild(previewDiv)
        frag.appendChild(card)
      }
    }

    pane.appendChild(frag)

    // Bind conflict choice button events
    pane.querySelectorAll('.mw-choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id)
        const card = pane.querySelector(`.mw-conflict-card[data-conflict-id="${id}"]`)

        // Determine which choice
        /** @type {ConflictChoice} */
        let choice
        if (btn.classList.contains('mw-choice-left'))  choice = 'left'
        else if (btn.classList.contains('mw-choice-right')) choice = 'right'
        else if (btn.classList.contains('mw-choice-base')) choice = 'base'
        else choice = 'both'

        this._conflictChoices.set(id, choice)

        // Update active states within this card
        card?.querySelectorAll('.mw-choice-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')

        // Sync textarea
        this._syncOutputTextarea()
      })
    })

    // Re-rendering rebuilds the cards, so the navigation cursor's highlight
    // has to be restored or it silently disappears on every choice click.
    const ids = collectConflictIds(this._segments)
    const currentId = this._currentConflict >= 0 ? ids[this._currentConflict] : null
    if (currentId != null) {
      pane.querySelector(`.mw-conflict-card[data-conflict-id="${currentId}"]`)
        ?.classList.add('mw-conflict-card--current')
    }

    // Initial textarea sync
    this._syncOutputTextarea()
  }

  /**
   * Sync the hidden textarea with the current buildOutputText result.
   */
  _syncOutputTextarea() {
    if (this._outputEl) {
      this._outputEl.value = this._buildOutputText()
    }
  }

  /**
   * Escape HTML special characters for safe innerHTML insertion.
   * @param {string} str
   * @returns {string}
   */
  _escapeHtml(str) {
    // S13-C07: also escape the apostrophe — without it, content rendered into
    // attribute-like contexts could break out.
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  // ---------------------------------------------------------------------------
  // Internal – pane rendering
  // ---------------------------------------------------------------------------

  /**
   * Create a single line element.
   * @param {string} type  'equal' | 'insert' | 'delete' | 'replace' | 'conflict'
   * @param {number|null} lineNum
   * @param {string} text
   * @returns {HTMLElement}
   */
  _makeLine(type, lineNum, text) {
    const div = document.createElement('div')
    div.className = `mw-line mw-line--${type}`

    const numEl = document.createElement('span')
    numEl.className = 'mw-linenum'
    numEl.textContent = lineNum != null ? String(lineNum) : ''

    const textEl = document.createElement('span')
    textEl.className = 'mw-linetext'
    textEl.textContent = text ?? ''

    div.appendChild(numEl)
    div.appendChild(textEl)
    return div
  }

  // ---------------------------------------------------------------------------
  // Internal – event emitter
  // ---------------------------------------------------------------------------

  /**
   * @param {string} event
   * @param {...*} args
   */
  _emit(event, ...args) {
    this._listeners.get(event)?.forEach(fn => fn(...args))
  }
}
