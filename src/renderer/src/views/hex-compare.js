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

import { showContextMenu } from '../core/context-menu.js'
import { el, formatSize } from '../core/utils.js'
import { isActive } from '../core/active-view.js'
import '../styles/hex-compare.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 20            // px，固定列高
const MAX_BYTES  = 10_485_760    // 10 MB

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

// ── HexCompare Class ──────────────────────────────────────────────────────────

export class HexCompare {
  /**
   * @param {object} [options]
   * @param {number} [options.bytesPerRow=16]
   */
  constructor(options = {}) {
    /** @type {number} */
    this._bytesPerRow = options.bytesPerRow ?? 16

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
    if (this._ctrlFHandler) {
      document.removeEventListener('keydown', this._ctrlFHandler)
      this._ctrlFHandler = null
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
    this._updatePathDisplay('right', path)
    this._updateSizeInfo()
    this.refresh()
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
  }

  /** 重新渲染兩側 pane */
  refresh() {
    requestAnimationFrame(() => {
      this._renderPaneContent('left')
      this._renderPaneContent('right')
    })
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

    this._container.appendChild(root)
    this._dom.root = root

    // 初始空狀態
    this._showEmptyState('left')
    this._showEmptyState('right')
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

    // Virtual scroll 容器
    const scroll = el('div', { className: 'hx-scroll' })
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
      // Re-run search with new layout
      this._runFind()
      this._refreshSync()
    })

    btnRefresh.addEventListener('click', () => this._refreshSync())

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
    }

    scroll_left.addEventListener('click',  onHexPaneClick)
    scroll_right.addEventListener('click', onHexPaneClick)

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

    // Ctrl+F opens find bar and focuses input
    this._ctrlFHandler = (/** @type {KeyboardEvent} */ e) => {
      if (!isActive('hex')) return
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        findInput.focus()
        findInput.select()
      }
    }
    document.addEventListener('keydown', this._ctrlFHandler)

    // ── T11: Goto offset ───────────────────────────────────────────────────────
    gotoInput.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Enter') {
        this._gotoOffset(gotoInput.value.trim())
      }
    })
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
    const targetTop = match.rowIndex * ROW_HEIGHT
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
    const targetTop = rowIndex * ROW_HEIGHT

    for (const side of /** @type {('left'|'right')[]} */ (['left', 'right'])) {
      const scroll = this._dom[`scroll_${side}`]
      if (scroll) {
        scroll.scrollTo({ top: targetTop, behavior: 'smooth' })
      }
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

    showContextMenu(e, items)
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

    const totalRows = this._totalRows(side)
    inner.style.height = `${totalRows * ROW_HEIGHT}px`
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

    const totalRows   = this._totalRows(side)
    const viewHeight  = scroll.clientHeight || 300
    const scrollTop   = scroll.scrollTop
    const visibleRows = Math.ceil(viewHeight / ROW_HEIGHT)

    const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 2)
    const endRow   = Math.min(totalRows - 1, startRow + visibleRows + 4)

    // 移除超出範圍的列（保留 [startRow, endRow]）
    const existing = inner.querySelectorAll('.hx-row[data-row]')
    for (const rowEl of existing) {
      const idx = parseInt(rowEl.dataset.row, 10)
      if (idx < startRow || idx > endRow) {
        rowEl.remove()
      }
    }

    // 建立尚未存在的列
    const existingSet = new Set()
    for (const rowEl of inner.querySelectorAll('.hx-row[data-row]')) {
      existingSet.add(parseInt(rowEl.dataset.row, 10))
    }

    const fragment = document.createDocumentFragment()
    for (let i = startRow; i <= endRow; i++) {
      if (existingSet.has(i)) continue
      const rowEl = this._buildHexRow(side, i, bytes)
      rowEl.style.top = `${i * ROW_HEIGHT}px`
      rowEl.dataset.row = String(i)
      fragment.appendChild(rowEl)
    }
    inner.appendChild(fragment)

    // Re-apply find highlights for newly rendered rows
    if (this._findMatches.length > 0) {
      this._applyFindHighlights()
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
      const hexSpan = el('span', { className: diffClass ? `hx-byte ${diffClass}` : 'hx-byte' },
        toHex(byteVal) + (i < bpr - 1 ? ' ' : '')
      )
      hexCol.appendChild(hexSpan)

      // ASCII span
      const asciiSpan = el('span',
        { className: diffClass ? `hx-ascii-char ${diffClass}` : 'hx-ascii-char' },
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
