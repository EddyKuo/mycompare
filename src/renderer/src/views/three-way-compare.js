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

// ---------------------------------------------------------------------------
// ThreeWayCompare
// ---------------------------------------------------------------------------

export class ThreeWayCompare {
  constructor() {
    /** @type {HTMLElement|null} */
    this._container = null

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
     * @type {Array<{ type: 'normal', lines: string[] } | { type: 'conflict', id: number, leftLines: string[], baseLines: string[], rightLines: string[] }>}
     */
    this._segments = []

    /**
     * User choices for each conflict segment.
     * Key: conflict id (number), Value: 'left' | 'right' | 'both' | null
     * @type {Map<number, 'left'|'right'|'both'|null>}
     */
    this._conflictChoices = new Map()
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Mount the view into a container element.
   * @param {HTMLElement} containerEl
   */
  mount(containerEl) {
    this._container = containerEl
    this._render()
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
        <div class="mw-top">
          <!-- Left Pane -->
          <div class="mw-pane" id="mw-pane-left">
            <div class="mw-path-bar">
              <button class="mw-open-btn" data-side="left">開啟左側…</button>
              <span class="mw-path" id="mw-path-left">（未選擇）</span>
            </div>
            <div class="mw-content" id="mw-content-left"></div>
          </div>
          <div class="mw-pane-divider"></div>
          <!-- Base Pane -->
          <div class="mw-pane" id="mw-pane-base">
            <div class="mw-path-bar">
              <button class="mw-open-btn" data-side="base">開啟基底…</button>
              <span class="mw-path" id="mw-path-base">（未選擇）</span>
            </div>
            <div class="mw-content" id="mw-content-base"></div>
          </div>
          <div class="mw-pane-divider"></div>
          <!-- Right Pane -->
          <div class="mw-pane" id="mw-pane-right">
            <div class="mw-path-bar">
              <button class="mw-open-btn" data-side="right">開啟右側…</button>
              <span class="mw-path" id="mw-path-right">（未選擇）</span>
            </div>
            <div class="mw-content" id="mw-content-right"></div>
          </div>
        </div>
        <div class="mw-divider" id="mw-divider"></div>
        <div class="mw-output-pane">
          <div class="mw-output-header">
            <span>合併輸出</span>
            <button id="mw-btn-save">儲存輸出…</button>
          </div>
          <div class="mw-output-content" id="mw-output-pane"></div>
          <textarea class="mw-output-textarea" id="mw-output" spellcheck="false"></textarea>
        </div>
        <style>
.mw-conflict-card { border: 1px solid #e0a000; border-radius:4px; margin:4px 0; background:#fffbe6; }
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
        </style>
      </div>
    `

    // Cache element refs
    this._contentEls = {
      left: this._container.querySelector('#mw-content-left'),
      base: this._container.querySelector('#mw-content-base'),
      right: this._container.querySelector('#mw-content-right'),
    }
    this._outputEl = this._container.querySelector('#mw-output')
    this._outputPaneEl = this._container.querySelector('#mw-output-pane')

    // Setup resizable output pane
    this._setupDividerDrag()
  }

  _setupDividerDrag() {
    const divider = this._container.querySelector('#mw-divider')
    const outputPane = this._container.querySelector('.mw-output-pane')
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
          const pathEl = this._container.querySelector(`#mw-path-${side}`)
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
    this._container.querySelector('#mw-btn-save')?.addEventListener('click', async () => {
      const content = this._buildOutputText()
      try {
        await window.electronAPI.saveFile('merged-output.txt', content)
      } catch (err) {
        console.error('[ThreeWayCompare] saveFile error:', err)
      }
    })

    // T26: Sync scroll across all three content panes
    this._setupSyncScroll()
  }

  /**
   * Set up synchronized scrolling across all three content panes.
   * When any pane is scrolled, the other two are updated to match scrollTop.
   */
  _setupSyncScroll() {
    const panes = Object.values(this._contentEls).filter(Boolean)
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

    this._renderSidePane('left', this._leftContent, leftDiff, 'left')
    this._renderSidePane('base', this._baseContent, null, 'base')
    this._renderSidePane('right', this._rightContent, rightDiff, 'right')

    this._renderOutputPane()

    this._emit('ready', { hasConflicts })
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
    const leftDiff = diffLines(base || '', left || '')
    const rightDiff = diffLines(base || '', right || '')
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
    return this._segments.map(seg => {
      if (seg.type === 'normal') return seg.lines.join('\n')
      const choice = this._conflictChoices.get(seg.id)
      if (choice === 'left')  return seg.leftLines.join('\n')
      if (choice === 'right') return seg.rightLines.join('\n')
      if (choice === 'both')  return [...seg.leftLines, ...seg.rightLines].join('\n')
      // Unresolved: preserve <<< markers
      return ['<<<<<<< LEFT', ...seg.leftLines, '||||||| BASE', ...seg.baseLines, '=======', ...seg.rightLines, '>>>>>>> RIGHT'].join('\n')
    }).join('\n')
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
        pre.textContent = seg.lines.join('\n')
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
        if (existing === 'both')  btnBoth.classList.add('active')
        if (existing === 'right') btnRight.classList.add('active')

        choicesDiv.appendChild(btnLeft)
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
        /** @type {'left'|'right'|'both'} */
        let choice
        if (btn.classList.contains('mw-choice-left'))  choice = 'left'
        else if (btn.classList.contains('mw-choice-right')) choice = 'right'
        else choice = 'both'

        this._conflictChoices.set(id, choice)

        // Update active states within this card
        card?.querySelectorAll('.mw-choice-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')

        // Sync textarea
        this._syncOutputTextarea()
      })
    })

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
   * Render a side pane (left / base / right).
   * For the base pane we show the raw content with equal styling.
   * For left/right panes we show the diff against base.
   *
   * @param {'left'|'base'|'right'} side
   * @param {string} content  raw content of this side
   * @param {import('../core/diff-engine.js').DiffLine[]|null} diff  diff from base; null = show plain base
   * @param {'left'|'base'|'right'} _role  (unused, kept for clarity)
   */
  _renderSidePane(side, content, diff, _role) {
    const contentEl = this._contentEls[side]
    if (!contentEl) return

    contentEl.innerHTML = ''
    const frag = document.createDocumentFragment()

    if (diff === null) {
      // Base pane: render raw lines with equal style
      const lines = (content || '').split('\n')
      lines.forEach((text, idx) => {
        frag.appendChild(this._makeLine('equal', idx + 1, text))
      })
    } else {
      // Left / Right pane: render diff lines
      for (const dl of diff) {
        let lineNum, text, cssType

        if (side === 'left') {
          // diff is base→left; left pane shows left content
          switch (dl.type) {
            case 'equal':
              lineNum = dl.leftLine
              text = dl.leftText
              cssType = 'equal'
              break
            case 'insert':
              // Line exists only in left (i.e., new in left vs base)
              lineNum = dl.rightLine
              text = dl.rightText
              cssType = 'insert'
              break
            case 'delete':
              // Line removed from left (exists only in base)
              lineNum = null
              text = dl.leftText
              cssType = 'delete'
              break
            case 'replace':
              lineNum = dl.rightLine
              text = dl.rightText
              cssType = 'replace'
              break
            default:
              lineNum = dl.leftLine
              text = dl.leftText
              cssType = 'equal'
          }
        } else {
          // Right pane
          switch (dl.type) {
            case 'equal':
              lineNum = dl.leftLine
              text = dl.leftText
              cssType = 'equal'
              break
            case 'insert':
              lineNum = dl.rightLine
              text = dl.rightText
              cssType = 'insert'
              break
            case 'delete':
              lineNum = null
              text = dl.leftText
              cssType = 'delete'
              break
            case 'replace':
              lineNum = dl.rightLine
              text = dl.rightText
              cssType = 'replace'
              break
            default:
              lineNum = dl.leftLine
              text = dl.leftText
              cssType = 'equal'
          }
        }

        frag.appendChild(this._makeLine(cssType, lineNum, (text || '').replace(/\r?\n$/, '')))
      }
    }

    contentEl.appendChild(frag)
  }

  /**
   * Create a single line element.
   * @param {string} type  'equal' | 'insert' | 'delete' | 'replace'
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
