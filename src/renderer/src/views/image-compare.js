/**
 * ImageCompare — 圖片比對視圖
 * src/renderer/src/views/image-compare.js
 *
 * 公開 API：
 *   constructor(options?)  options: { threshold?: number }
 *   mount(containerEl)
 *   destroy()
 *   openLeft()
 *   openRight()
 *   setLeft(path, base64, ext)
 *   setRight(path, base64, ext)
 *   refresh()
 *   on(event, handler)
 *   off(event, handler)
 *
 * 事件：
 *   'paths-changed' → { left: string, right: string }
 */

import { showContextMenu } from '../core/context-menu.js'
import '../styles/image-compare.css'

// ── DOM helper ────────────────────────────────────────────────────────────────

/**
 * 建立 DOM 元素的輕量工廠
 * @param {string} tag
 * @param {Record<string,string>} [attrs]
 * @param {...(Node|string|null)} children
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v
    else if (k === 'textContent') node.textContent = v
    else node.setAttribute(k, v)
  }
  for (const child of children) {
    if (child == null) continue
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

// ── Pixel diff algorithm ──────────────────────────────────────────────────────

/**
 * 計算兩張圖片的 pixel-level 差異，並將結果寫入 diffCtx。
 *
 * 若兩張圖片尺寸不同，diff canvas 使用較大尺寸；缺少像素的部分全算差異。
 *
 * @param {CanvasRenderingContext2D} leftCtx
 * @param {CanvasRenderingContext2D} rightCtx
 * @param {CanvasRenderingContext2D} diffCtx
 * @param {number} width   - diff canvas 寬度
 * @param {number} height  - diff canvas 高度
 * @param {number} lw      - 左圖實際寬度
 * @param {number} lh      - 左圖實際高度
 * @param {number} rw      - 右圖實際寬度
 * @param {number} rh      - 右圖實際高度
 * @param {number} threshold - 0~1
 * @param {'exact'|'tolerance'|'grayscale'} [algorithm] - 比對演算法，預設 'exact'
 * @returns {number} 差異像素數
 */
function pixelDiff(leftCtx, rightCtx, diffCtx, width, height, lw, lh, rw, rh, threshold, algorithm = 'exact') {
  // 讀取兩張圖的像素資料（來自各自原始尺寸）
  const leftData  = leftCtx.getImageData(0, 0, lw, lh).data
  const rightData = rightCtx.getImageData(0, 0, rw, rh).data

  // 在 diff canvas 上建立輸出 buffer
  const diffImgData = diffCtx.createImageData(width, height)
  const diffData = diffImgData.data

  let diffCount = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const outIdx = (y * width + x) * 4

      // 判斷此座標在兩圖中是否存在
      const inLeft  = x < lw && y < lh
      const inRight = x < rw && y < rh

      if (!inLeft || !inRight) {
        // 超出其中一張圖的範圍 → 全差異，標紅
        diffData[outIdx]     = 255
        diffData[outIdx + 1] = 0
        diffData[outIdx + 2] = 0
        diffData[outIdx + 3] = 200
        diffCount++
        continue
      }

      const lIdx = (y * lw + x) * 4
      const rIdx = (y * rw + x) * 4

      const lR = leftData[lIdx]
      const lG = leftData[lIdx + 1]
      const lB = leftData[lIdx + 2]

      const rR = rightData[rIdx]
      const rG = rightData[rIdx + 1]
      const rB = rightData[rIdx + 2]

      let isDiff
      if (algorithm === 'exact') {
        // Exact: all R/G/B channels must be identical (alpha ignored for comparison)
        isDiff = lR !== rR || lG !== rG || lB !== rB
      } else if (algorithm === 'tolerance') {
        // Tolerance: sum of absolute channel differences ≤ 30
        isDiff = Math.abs(lR - rR) + Math.abs(lG - rG) + Math.abs(lB - rB) > 30
      } else if (algorithm === 'grayscale') {
        // Grayscale: compare luminance values, threshold |lum1 - lum2| > 15
        const lumL = 0.299 * lR + 0.587 * lG + 0.114 * lB
        const lumR = 0.299 * rR + 0.587 * rG + 0.114 * rB
        isDiff = Math.abs(lumL - lumR) > 15
      } else {
        // Fallback: threshold-based (original logic)
        const rDiff = Math.abs(lR - rR) / 255
        const gDiff = Math.abs(lG - rG) / 255
        const bDiff = Math.abs(lB - rB) / 255
        isDiff = (rDiff + gDiff + bDiff) / 3 > threshold
      }

      if (isDiff) {
        // 差異像素：紅色 rgba(255,0,0,200)
        diffData[outIdx]     = 255
        diffData[outIdx + 1] = 0
        diffData[outIdx + 2] = 0
        diffData[outIdx + 3] = 200
        diffCount++
      } else {
        // 相同像素：使用左圖原色，alpha=128 (dim 50%)
        diffData[outIdx]     = lR
        diffData[outIdx + 1] = lG
        diffData[outIdx + 2] = lB
        diffData[outIdx + 3] = 128
      }
    }
  }

  diffCtx.putImageData(diffImgData, 0, 0)
  return diffCount
}

// ── Zoom/Pan sync ─────────────────────────────────────────────────────────────

/**
 * 為多個 wrap 元素建立同步縮放/平移控制器。
 *
 * @param {HTMLElement[]} wraps - .ic-canvas-wrap 元素陣列
 * @returns {{ destroy: () => void }}
 */
function createSyncTransform(wraps) {
  let zoom = 1
  let panX = 0
  let panY = 0

  const MIN_ZOOM = 0.1
  const MAX_ZOOM = 10

  /** 套用 transform 到所有 wrap */
  function applyTransform() {
    for (const w of wraps) {
      w.style.transformOrigin = '0 0'
      w.style.transform = `scale(${zoom}) translate(${panX}px, ${panY}px)`
    }
  }

  // Drag state
  let dragging = false
  let dragStartX = 0
  let dragStartY = 0
  let panStartX = 0
  let panStartY = 0

  /** @param {WheelEvent} e */
  function onWheel(e) {
    e.preventDefault()

    // 取得滑鼠相對於 wrap 容器（.ic-panel 的父節點）的位置
    const rect = e.currentTarget.parentElement.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top

    // 縮放量
    const delta = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * delta))
    if (newZoom === zoom) return

    // 以滑鼠位置為縮放中心：調整 panX/panY 使畫面不跳動
    // 縮放前：mouse = scale * (pan + mouse_in_content)
    // 縮放後保持 mouse 不動：newPan = mouse/newZoom - mouse_in_content
    const mouseInContentX = mouseX / zoom - panX
    const mouseInContentY = mouseY / zoom - panY
    panX = mouseX / newZoom - mouseInContentX
    panY = mouseY / newZoom - mouseInContentY

    zoom = newZoom
    applyTransform()
  }

  /** @param {MouseEvent} e */
  function onMouseDown(e) {
    if (e.button !== 0) return
    dragging = true
    dragStartX = e.clientX
    dragStartY = e.clientY
    panStartX = panX
    panStartY = panY
    e.currentTarget.style.cursor = 'grabbing'
    e.preventDefault()
  }

  function onMouseMove(e) {
    if (!dragging) return
    const dx = (e.clientX - dragStartX) / zoom
    const dy = (e.clientY - dragStartY) / zoom
    panX = panStartX + dx
    panY = panStartY + dy
    applyTransform()
  }

  function onMouseUp(e) {
    if (!dragging) return
    dragging = false
    for (const w of wraps) w.style.cursor = 'grab'
  }

  // 綁定事件到每個 wrap
  for (const w of wraps) {
    w.style.cursor = 'grab'
    w.addEventListener('wheel', onWheel, { passive: false })
    w.addEventListener('mousedown', onMouseDown)
  }
  // mousemove / mouseup 綁在 document 以免拖出範圍
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)

  return {
    destroy() {
      for (const w of wraps) {
        w.removeEventListener('wheel', onWheel)
        w.removeEventListener('mousedown', onMouseDown)
      }
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    },
  }
}

// ── ImageCompare Class ────────────────────────────────────────────────────────

export class ImageCompare {
  /**
   * @param {object} [options]
   * @param {number} [options.threshold] - 0~1，差異判斷閾值，預設 0.1
   */
  constructor(options = {}) {
    /** @type {number} */
    this._threshold = options.threshold ?? 0.1

    /**
     * Pixel comparison algorithm: 'exact' | 'tolerance' | 'grayscale'
     * @type {'exact'|'tolerance'|'grayscale'}
     */
    this._algorithm = 'exact'

    /** @type {boolean} */
    this._showDiffOverlay = true

    // 圖片資料
    /** @type {{ path: string, base64: string, ext: string, img: HTMLImageElement } | null} */
    this._left = null
    /** @type {{ path: string, base64: string, ext: string, img: HTMLImageElement } | null} */
    this._right = null

    // 事件 handlers map：{ eventName: Function[] }
    /** @type {Record<string, Function[]>} */
    this._handlers = {}

    // DOM 根節點
    /** @type {HTMLElement | null} */
    this._container = null

    // 快取的 DOM refs
    /** @type {Record<string, HTMLElement | HTMLCanvasElement | HTMLInputElement>} */
    this._dom = {}

    // Canvas 2D contexts
    /** @type {CanvasRenderingContext2D | null} */
    this._leftCtx = null
    /** @type {CanvasRenderingContext2D | null} */
    this._rightCtx = null
    /** @type {CanvasRenderingContext2D | null} */
    this._diffCtx = null

    // 同步縮放/平移控制器
    /** @type {{ destroy: () => void } | null} */
    this._syncTransform = null

    // style 注入狀態
    /** @type {boolean} */
    this._styleInjected = false
    /** @type {HTMLLinkElement | null} */
    this._injectedStyleEl = null
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * 將 UI 渲染到 containerEl
   * @param {HTMLElement} containerEl
   */
  mount(containerEl) {
    this._container = containerEl
    this._render()
    this._bindEvents()
  }

  /** 銷毀元件，清除 DOM 與事件 */
  destroy() {
    this._magCleanup?.()
    this._magCleanup = null
    if (this._syncTransform) {
      this._syncTransform.destroy()
      this._syncTransform = null
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
    this._dom = {}
    this._leftCtx = null
    this._rightCtx = null
    this._diffCtx = null
  }

  /**
   * 呼叫 electronAPI 開啟左側圖片檔案選擇對話框
   */
  async openLeft() {
    const result = await window.electronAPI.openFileBinary({
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] }],
    })
    if (!result) return
    await this.setLeft(result.path, result.base64, result.ext)
  }

  /**
   * 呼叫 electronAPI 開啟右側圖片檔案選擇對話框
   */
  async openRight() {
    const result = await window.electronAPI.openFileBinary({
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] }],
    })
    if (!result) return
    await this.setRight(result.path, result.base64, result.ext)
  }

  /**
   * 直接設定左側圖片資料
   * @param {string} path
   * @param {string} base64
   * @param {string} ext
   */
  async setLeft(path, base64, ext) {
    const img = await this._loadImage(base64, ext)
    this._left = { path, base64, ext, img }
    this._drawImage('left', img)
    this._updatePathDisplay('left', path, img.naturalWidth, img.naturalHeight)
    this._emit('paths-changed', {
      left: path,
      right: this._right?.path ?? '',
    })
    await this._runDiff()
  }

  /**
   * 直接設定右側圖片資料
   * @param {string} path
   * @param {string} base64
   * @param {string} ext
   */
  async setRight(path, base64, ext) {
    const img = await this._loadImage(base64, ext)
    this._right = { path, base64, ext, img }
    this._drawImage('right', img)
    this._updatePathDisplay('right', path, img.naturalWidth, img.naturalHeight)
    this._emit('paths-changed', {
      left: this._left?.path ?? '',
      right: path,
    })
    await this._runDiff()
  }

  /**
   * 重新計算 pixel diff（threshold 或 overlay 設定改變時呼叫）
   */
  async refresh() {
    await this._runDiff()
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

  // ── Private: emit ───────────────────────────────────────────────────────────

  /**
   * @param {string} event
   * @param {object} payload
   */
  _emit(event, payload) {
    const handlers = this._handlers[event] ?? []
    for (const h of handlers) {
      try {
        h(payload)
      } catch (err) {
        console.error(`ImageCompare event "${event}" handler error:`, err)
      }
    }
  }

  // ── Private: Initial render ─────────────────────────────────────────────────

  _render() {
    if (!this._container) return
    this._container.innerHTML = ''

    const root = el('div', { className: 'image-compare' })

    root.appendChild(this._buildToolbar())
    root.appendChild(this._buildPathRow())
    root.appendChild(this._buildBody())
    root.appendChild(this._buildStats())

    this._container.appendChild(root)
    this._dom.root = root

    // 建立同步縮放/平移控制器
    this._setupSyncTransform()

    // 建立 magnifier overlay（絕對定位在 document.body）
    const magOverlay = el('div', { className: 'ic-magnifier-overlay' })
    magOverlay.style.cssText = 'display:none;position:fixed;pointer-events:none;z-index:1000;' +
      'width:300px;height:100px;background:#1e1e1e;border:1px solid #555;border-radius:4px;' +
      'overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.4)'
    document.body.appendChild(magOverlay)
    this._dom.magOverlay = magOverlay

    // 三個放大 canvas（left / right / diff）
    const magCanvases = ['left', 'right', 'diff'].map(label => {
      const wrap = el('div', { className: 'ic-mag-pane' })
      wrap.style.cssText = 'display:inline-block;width:33.33%;height:100%;vertical-align:top;overflow:hidden'
      const lbl = el('div', { className: 'ic-mag-label' })
      lbl.style.cssText = 'font-size:9px;color:#aaa;text-align:center;padding:1px 0'
      lbl.textContent = label
      const cvs = el('canvas')
      cvs.style.cssText = 'display:block'
      wrap.appendChild(lbl)
      wrap.appendChild(cvs)
      magOverlay.appendChild(wrap)
      return cvs
    })
    this._dom.magCanvasLeft  = magCanvases[0]
    this._dom.magCanvasRight = magCanvases[1]
    this._dom.magCanvasDiff  = magCanvases[2]
  }

  _buildToolbar() {
    const toolbar = el('div', { className: 'ic-toolbar' })

    // Threshold label
    toolbar.appendChild(el('label', { className: 'ic-toolbar-label', textContent: '差異閾值：' }))

    // Threshold slider
    const slider = el('input', {
      type: 'range',
      className: 'ic-threshold-slider',
      min: '0',
      max: '0.5',
      step: '0.01',
      value: String(this._threshold),
    })
    this._dom.thresholdSlider = slider
    toolbar.appendChild(slider)

    // Threshold value display
    const thresholdVal = el('span', {
      className: 'ic-threshold-value',
      textContent: this._threshold.toFixed(2),
    })
    this._dom.thresholdVal = thresholdVal
    toolbar.appendChild(thresholdVal)

    // Separator
    toolbar.appendChild(el('span', { className: 'ic-toolbar-sep' }))

    // Overlay checkbox
    const overlayLabel = el('label', { className: 'ic-toolbar-label' })
    const overlayCheckbox = el('input', {
      type: 'checkbox',
      className: 'ic-overlay-checkbox',
    })
    overlayCheckbox.checked = this._showDiffOverlay
    this._dom.overlayCheckbox = overlayCheckbox
    overlayLabel.appendChild(overlayCheckbox)
    overlayLabel.appendChild(document.createTextNode(' 顯示差異疊加層'))
    toolbar.appendChild(overlayLabel)

    // Separator
    toolbar.appendChild(el('span', { className: 'ic-toolbar-sep' }))

    // Refresh button
    const btnRefresh = el('button', { className: 'ic-btn-refresh', textContent: '↺ 刷新' })
    this._dom.btnRefresh = btnRefresh
    toolbar.appendChild(btnRefresh)

    return toolbar
  }

  _buildPathRow() {
    const row = el('div', { className: 'ic-path-row' })

    // Left side
    const leftCell = el('div', { className: 'ic-path-cell' })
    const btnLeft = el('button', { className: 'ic-open-btn', textContent: '開啟圖片…' })
    this._dom.btnOpenLeft = btnLeft
    const dispLeft = el('span', { className: 'ic-path-display', textContent: '（未選擇）' })
    this._dom.dispLeft = dispLeft
    const sizeLeft = el('span', { className: 'ic-image-size' })
    this._dom.sizeLeft = sizeLeft
    leftCell.appendChild(btnLeft)
    leftCell.appendChild(dispLeft)
    leftCell.appendChild(sizeLeft)

    // Right side
    const rightCell = el('div', { className: 'ic-path-cell' })
    const btnRight = el('button', { className: 'ic-open-btn', textContent: '開啟圖片…' })
    this._dom.btnOpenRight = btnRight
    const dispRight = el('span', { className: 'ic-path-display', textContent: '（未選擇）' })
    this._dom.dispRight = dispRight
    const sizeRight = el('span', { className: 'ic-image-size' })
    this._dom.sizeRight = sizeRight
    rightCell.appendChild(btnRight)
    rightCell.appendChild(dispRight)
    rightCell.appendChild(sizeRight)

    row.appendChild(leftCell)
    row.appendChild(rightCell)
    return row
  }

  _buildBody() {
    const body = el('div', { className: 'ic-body' })

    // Helper: build a single panel
    const buildPanel = (labelText, wrapClass) => {
      const panel = el('div', { className: 'ic-panel' })
      const label = el('div', { className: 'ic-panel-label', textContent: labelText })
      const wrap = el('div', { className: `ic-canvas-wrap ${wrapClass}` })
      const canvas = el('canvas')
      wrap.appendChild(canvas)
      panel.appendChild(label)
      panel.appendChild(wrap)
      return { panel, wrap, canvas }
    }

    const left  = buildPanel('左側', 'ic-canvas-left')
    const right = buildPanel('右側', 'ic-canvas-right')
    const diff  = buildPanel('差異', 'ic-canvas-diff')

    this._dom.wrapLeft   = left.wrap
    this._dom.canvasLeft = left.canvas
    this._dom.wrapRight  = right.wrap
    this._dom.canvasRight = right.canvas
    this._dom.wrapDiff   = diff.wrap
    this._dom.canvasDiff = diff.canvas

    this._leftCtx  = left.canvas.getContext('2d')
    this._rightCtx = right.canvas.getContext('2d')
    this._diffCtx  = diff.canvas.getContext('2d')

    body.appendChild(left.panel)
    body.appendChild(right.panel)
    body.appendChild(diff.panel)

    return body
  }

  _buildStats() {
    const stats = el('div', { className: 'ic-stats', textContent: '請載入兩張圖片以計算差異' })
    this._dom.stats = stats
    return stats
  }

  // ── Private: Event binding ──────────────────────────────────────────────────

  _bindEvents() {
    const {
      btnOpenLeft,
      btnOpenRight,
      btnRefresh,
      thresholdSlider,
      thresholdVal,
      overlayCheckbox,
    } = this._dom

    btnOpenLeft.addEventListener('click', () => this.openLeft())
    btnOpenRight.addEventListener('click', () => this.openRight())
    btnRefresh.addEventListener('click', () => this.refresh())

    thresholdSlider.addEventListener('input', () => {
      this._threshold = parseFloat(thresholdSlider.value)
      thresholdVal.textContent = this._threshold.toFixed(2)
    })

    // 拖放釋放後才觸發 diff 計算（避免拖拉中持續重算）
    thresholdSlider.addEventListener('change', () => {
      this._threshold = parseFloat(thresholdSlider.value)
      thresholdVal.textContent = this._threshold.toFixed(2)
      this.refresh()
    })

    overlayCheckbox.addEventListener('change', () => {
      this._showDiffOverlay = overlayCheckbox.checked
      this._toggleDiffOverlay()
    })

    // Magnifier
    const MAG_ZOOM = 4

    const updateMagnifier = (e) => {
      const { magOverlay, canvasLeft, canvasRight, canvasDiff,
              magCanvasLeft, magCanvasRight, magCanvasDiff } = this._dom
      if (!this._left && !this._right) return

      // 找出滑鼠在哪個 canvas 上的位置；任意一個有圖的 canvas 都可作為參考
      const refCanvas = canvasLeft?.width > 1 ? canvasLeft
                      : canvasRight?.width > 1 ? canvasRight : null
      if (!refCanvas) return

      const rect = refCanvas.getBoundingClientRect()
      const scaleX = refCanvas.width  / rect.width
      const scaleY = refCanvas.height / rect.height
      const cx = (e.clientX - rect.left) * scaleX
      const cy = (e.clientY - rect.top)  * scaleY

      // 更新三個放大 canvas
      const drawMag = (srcCanvas, dstCanvas) => {
        if (!srcCanvas || srcCanvas.width < 1) return
        const dw = dstCanvas.parentElement.offsetWidth || 100
        const dh = (magOverlay.offsetHeight || 100) - 14  // 扣掉 label
        dstCanvas.width  = dw
        dstCanvas.height = dh
        const ctx = dstCanvas.getContext('2d')
        ctx.clearRect(0, 0, dw, dh)
        const srcX = cx - (dw / 2) / MAG_ZOOM
        const srcY = cy - (dh / 2) / MAG_ZOOM
        ctx.drawImage(srcCanvas,
          srcX, srcY, dw / MAG_ZOOM, dh / MAG_ZOOM,
          0, 0, dw, dh)
        // 中心十字準線
        ctx.strokeStyle = 'rgba(255,255,255,0.5)'
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(dw / 2, 0); ctx.lineTo(dw / 2, dh); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(0, dh / 2); ctx.lineTo(dw, dh / 2); ctx.stroke()
      }

      drawMag(canvasLeft,  magCanvasLeft)
      drawMag(canvasRight, magCanvasRight)
      drawMag(canvasDiff,  magCanvasDiff)

      // 定位 overlay（跟隨滑鼠，避免超出視窗）
      const ovW = 300
      const ovH = 100
      let ox = e.clientX + 16
      let oy = e.clientY + 16
      if (ox + ovW > window.innerWidth)  ox = e.clientX - ovW - 8
      if (oy + ovH > window.innerHeight) oy = e.clientY - ovH - 8
      magOverlay.style.left    = `${ox}px`
      magOverlay.style.top     = `${oy}px`
      magOverlay.style.display = 'block'
    }

    const hideMagnifier = () => {
      if (this._dom.magOverlay) this._dom.magOverlay.style.display = 'none'
    }

    const wraps = [this._dom.wrapLeft, this._dom.wrapRight, this._dom.wrapDiff].filter(Boolean)
    for (const w of wraps) {
      w.addEventListener('mousemove', updateMagnifier)
      w.addEventListener('mouseleave', hideMagnifier)
    }
    this._magCleanup = () => {
      for (const w of wraps) {
        w.removeEventListener('mousemove', updateMagnifier)
        w.removeEventListener('mouseleave', hideMagnifier)
      }
      this._dom.magOverlay?.remove()
    }

    // Algorithm context menu on canvas panels
    const container = this._dom.root ?? this._container
    if (container) {
      container.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const menuItems = [
          { label: (this._algorithm === 'exact'     ? '✓ ' : '　') + '精確比對',
            action: () => { this._algorithm = 'exact';     this._runDiff() } },
          { label: (this._algorithm === 'tolerance' ? '✓ ' : '　') + '容差比對（±10）',
            action: () => { this._algorithm = 'tolerance'; this._runDiff() } },
          { label: (this._algorithm === 'grayscale' ? '✓ ' : '　') + '灰階比對',
            action: () => { this._algorithm = 'grayscale'; this._runDiff() } },
        ]
        showContextMenu(e, menuItems)
      })
    }
  }

  // ── Private: Sync Transform setup ──────────────────────────────────────────

  _setupSyncTransform() {
    if (this._syncTransform) {
      this._syncTransform.destroy()
    }
    const wraps = [
      this._dom.wrapLeft,
      this._dom.wrapRight,
      this._dom.wrapDiff,
    ].filter(Boolean)

    if (wraps.length) {
      this._syncTransform = createSyncTransform(wraps)
    }
  }

  // ── Private: Image loading ──────────────────────────────────────────────────

  /**
   * 從 base64 + ext 載入 HTMLImageElement
   * @param {string} base64
   * @param {string} ext
   * @returns {Promise<HTMLImageElement>}
   */
  _loadImage(base64, ext) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`圖片載入失敗（ext: ${ext}）`))
      img.src = `data:image/${ext};base64,${base64}`
    })
  }

  // ── Private: Canvas drawing ─────────────────────────────────────────────────

  /**
   * 將圖片繪製到對應的 canvas
   * @param {'left'|'right'} side
   * @param {HTMLImageElement} img
   */
  _drawImage(side, img) {
    const canvas = side === 'left' ? this._dom.canvasLeft : this._dom.canvasRight
    const ctx    = side === 'left' ? this._leftCtx        : this._rightCtx
    if (!canvas || !ctx) return

    canvas.width  = img.naturalWidth
    canvas.height = img.naturalHeight
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
  }

  // ── Private: Diff ───────────────────────────────────────────────────────────

  /**
   * 執行 pixel diff，更新 diff canvas 與統計列
   */
  async _runDiff() {
    if (!this._left || !this._right) {
      this._updateStats(null, null)
      return
    }

    const { img: lImg } = this._left
    const { img: rImg } = this._right

    const lw = lImg.naturalWidth
    const lh = lImg.naturalHeight
    const rw = rImg.naturalWidth
    const rh = rImg.naturalHeight

    const diffW = Math.max(lw, rw)
    const diffH = Math.max(lh, rh)

    const diffCanvas = this._dom.canvasDiff
    diffCanvas.width  = diffW
    diffCanvas.height = diffH

    const diffCount = pixelDiff(
      this._leftCtx,
      this._rightCtx,
      this._diffCtx,
      diffW, diffH,
      lw, lh,
      rw, rh,
      this._threshold,
      this._algorithm,
    )

    const totalPixels = diffW * diffH
    this._updateStats(diffCount, totalPixels)

    // 若 overlay 已關閉，隱藏 diff canvas
    this._toggleDiffOverlay()
  }

  // ── Private: Stats ──────────────────────────────────────────────────────────

  /**
   * @param {number | null} diffCount
   * @param {number | null} totalPixels
   */
  _updateStats(diffCount, totalPixels) {
    const stats = this._dom.stats
    if (!stats) return

    if (diffCount === null || totalPixels === null) {
      stats.textContent = '請載入兩張圖片以計算差異'
      return
    }

    const pct = totalPixels > 0 ? ((diffCount / totalPixels) * 100).toFixed(2) : '0.00'
    stats.textContent = `差異像素 ${diffCount.toLocaleString()} / 總像素 ${totalPixels.toLocaleString()} (${pct}%)`
  }

  // ── Private: Overlay toggle ─────────────────────────────────────────────────

  _toggleDiffOverlay() {
    const wrapDiff = this._dom.wrapDiff
    if (!wrapDiff) return
    wrapDiff.style.visibility = this._showDiffOverlay ? '' : 'hidden'
  }

  // ── Private: Path display ───────────────────────────────────────────────────

  /**
   * @param {'left'|'right'} side
   * @param {string} path
   * @param {number} w
   * @param {number} h
   */
  _updatePathDisplay(side, path, w, h) {
    const disp = side === 'left' ? this._dom.dispLeft  : this._dom.dispRight
    const size = side === 'left' ? this._dom.sizeLeft  : this._dom.sizeRight
    if (disp) disp.textContent = path
    if (size) size.textContent = `${w}×${h}`
  }
}
