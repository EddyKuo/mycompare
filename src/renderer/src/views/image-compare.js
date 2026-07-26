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
 *   setAutoScale(on) / getAutoScale()
 *   setMismatchRange(on) / getMismatchRange()
 *   setHighlightColor(key) / getHighlightColor()
 *   on(event, handler)
 *   off(event, handler)
 *
 * 事件：
 *   'paths-changed' → { left: string, right: string }
 */

import { showContextMenu, closeContextMenu } from '../core/context-menu.js'
import { isActive } from '../core/active-view.js'
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
 * S14-M01: build a tiny off-screen canvas for downscaled diff input.
 * @param {number} w
 * @param {number} h
 * @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D }}
 */
function _makeScratch(w, h) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'))
  return { canvas, ctx }
}

/**
 * 把一張圖以指定尺寸重繪到 off-screen canvas，回傳其 2D context。
 *
 * @param {HTMLImageElement} img
 * @param {number} w
 * @param {number} h
 * @returns {CanvasRenderingContext2D}
 */
function _makeScratchFor(img, w, h) {
  const { ctx } = _makeScratch(w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return ctx
}

/**
 * @typedef {'red'|'green'|'blue'|'magenta'} HighlightColorKey
 */

/**
 * Selectable highlight colours for mismatching pixels.
 * @type {Record<HighlightColorKey, { label: string, rgb: [number, number, number] }>}
 */
export const HIGHLIGHT_COLORS = {
  red:     { label: '紅',   rgb: [255, 0, 0] },
  green:   { label: '綠',   rgb: [0, 220, 0] },
  blue:    { label: '藍',   rgb: [0, 110, 255] },
  magenta: { label: '洋紅', rgb: [255, 0, 255] },
}

/** @type {HighlightColorKey} */
export const DEFAULT_HIGHLIGHT_COLOR = 'red'

/** Number of severity buckets used by mismatch-range mode. */
export const MISMATCH_LEVELS = 4

// Level MISMATCH_LEVELS must reproduce the historical rgba(255,0,0,200) so that
// turning range mode off changes nothing about the rendered overlay.
const MAX_HIGHLIGHT_ALPHA = 200
const MIN_HIGHLIGHT_ALPHA = 80
const MIN_HIGHLIGHT_INTENSITY = 0.4

/** Alpha applied to unchanged pixels so the diff panel still shows context. */
const SAME_PIXEL_ALPHA = 128

/**
 * 兩個像素的「差異強度」（0~255），與是否超過門檻無關。
 *
 * @param {number} lR
 * @param {number} lG
 * @param {number} lB
 * @param {number} rR
 * @param {number} rG
 * @param {number} rB
 * @param {'exact'|'tolerance'|'grayscale'} [algorithm]
 * @returns {number} 0~255
 */
export function pixelDiffMagnitude(lR, lG, lB, rR, rG, rB, algorithm = 'exact') {
  if (algorithm === 'grayscale') {
    const lumL = 0.299 * lR + 0.587 * lG + 0.114 * lB
    const lumR = 0.299 * rR + 0.587 * rG + 0.114 * rB
    return Math.abs(lumL - lumR)
  }
  if (algorithm === 'tolerance') {
    return (Math.abs(lR - rR) + Math.abs(lG - rG) + Math.abs(lB - rB)) / 3
  }
  // 'exact' has no notion of "how different"; the max channel delta exists only
  // so range mode has something to grade — it never affects the diff decision,
  // because any non-zero delta already means "different" under exact.
  return Math.max(Math.abs(lR - rR), Math.abs(lG - rG), Math.abs(lB - rB))
}

/**
 * 差異判定門檻（0~255）。'exact' 刻意忽略滑桿。
 *
 * @param {number} threshold - 0~1
 * @param {'exact'|'tolerance'|'grayscale'} [algorithm]
 * @returns {number}
 */
export function diffCutoff(threshold, algorithm = 'exact') {
  return algorithm === 'exact' ? 0 : threshold * 255
}

/**
 * @param {number} magnitude
 * @param {number} threshold - 0~1
 * @param {'exact'|'tolerance'|'grayscale'} [algorithm]
 * @returns {boolean}
 */
export function isPixelDiff(magnitude, threshold, algorithm = 'exact') {
  return magnitude > diffCutoff(threshold, algorithm)
}

/**
 * 將差異強度分級：0 = 相同，1..MISMATCH_LEVELS = 由輕微到完全不同。
 *
 * @param {number} magnitude - 0~255
 * @param {number} threshold - 0~1
 * @param {'exact'|'tolerance'|'grayscale'} [algorithm]
 * @returns {number}
 */
export function mismatchLevel(magnitude, threshold, algorithm = 'exact') {
  const cutoff = diffCutoff(threshold, algorithm)
  if (!(magnitude > cutoff)) return 0
  const span = 255 - cutoff
  if (span <= 0) return MISMATCH_LEVELS
  const ratio = (magnitude - cutoff) / span
  return Math.min(MISMATCH_LEVELS, Math.max(1, Math.ceil(ratio * MISMATCH_LEVELS)))
}

/**
 * 取得某一分級對應的高亮 RGBA。
 *
 * @param {string} colorKey
 * @param {number} [level] - 1..MISMATCH_LEVELS
 * @returns {[number, number, number, number]}
 */
export function highlightRGBA(colorKey, level = MISMATCH_LEVELS) {
  const entry = HIGHLIGHT_COLORS[/** @type {HighlightColorKey} */ (colorKey)]
    ?? HIGHLIGHT_COLORS[DEFAULT_HIGHLIGHT_COLOR]
  const lv = Math.min(MISMATCH_LEVELS, Math.max(1, Math.round(level)))
  const t = lv / MISMATCH_LEVELS
  const k = MIN_HIGHLIGHT_INTENSITY + (1 - MIN_HIGHLIGHT_INTENSITY) * t
  return [
    Math.round(entry.rgb[0] * k),
    Math.round(entry.rgb[1] * k),
    Math.round(entry.rgb[2] * k),
    Math.round(MIN_HIGHLIGHT_ALPHA + (MAX_HIGHLIGHT_ALPHA - MIN_HIGHLIGHT_ALPHA) * t),
  ]
}

/**
 * @typedef {object} ComputeDiffOptions
 * @property {Uint8ClampedArray} leftData   - 左圖 RGBA buffer（lw × lh）
 * @property {Uint8ClampedArray} rightData  - 右圖 RGBA buffer（rw × rh）
 * @property {Uint8ClampedArray} out        - 輸出 RGBA buffer（width × height）
 * @property {number} width
 * @property {number} height
 * @property {number} lw
 * @property {number} lh
 * @property {number} rw
 * @property {number} rh
 * @property {number} threshold - 0~1
 * @property {'exact'|'tolerance'|'grayscale'} [algorithm]
 * @property {boolean} [mismatchRange] - true 時依差異強度分級上色
 * @property {string} [highlightColor]
 */

/**
 * 純函式版 pixel diff：吃 RGBA buffer、寫 RGBA buffer，不碰 canvas。
 *
 * @param {ComputeDiffOptions} opts
 * @returns {number} 差異像素數
 */
export function computeDiffBuffer(opts) {
  const {
    leftData, rightData, out, width, height, lw, lh, rw, rh, threshold,
    algorithm = 'exact',
    mismatchRange = false,
    highlightColor = DEFAULT_HIGHLIGHT_COLOR,
  } = opts

  // The inner loop runs once per pixel, so the per-level colours are resolved
  // up-front rather than recomputed millions of times.
  /** @type {Array<[number, number, number, number]>} */
  const palette = []
  for (let i = 1; i <= MISMATCH_LEVELS; i++) palette.push(highlightRGBA(highlightColor, i))
  const flat = palette[MISMATCH_LEVELS - 1]

  let diffCount = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const outIdx = (y * width + x) * 4

      const inLeft  = x < lw && y < lh
      const inRight = x < rw && y < rh

      if (!inLeft || !inRight) {
        // 超出其中一張圖的範圍 → 視為最嚴重的差異
        out[outIdx]     = flat[0]
        out[outIdx + 1] = flat[1]
        out[outIdx + 2] = flat[2]
        out[outIdx + 3] = flat[3]
        diffCount++
        continue
      }

      const lIdx = (y * lw + x) * 4
      const rIdx = (y * rw + x) * 4

      const lR = leftData[lIdx]
      const lG = leftData[lIdx + 1]
      const lB = leftData[lIdx + 2]

      const magnitude = pixelDiffMagnitude(
        lR, lG, lB,
        rightData[rIdx], rightData[rIdx + 1], rightData[rIdx + 2],
        algorithm,
      )

      if (isPixelDiff(magnitude, threshold, algorithm)) {
        const rgba = mismatchRange
          ? palette[mismatchLevel(magnitude, threshold, algorithm) - 1]
          : flat
        out[outIdx]     = rgba[0]
        out[outIdx + 1] = rgba[1]
        out[outIdx + 2] = rgba[2]
        out[outIdx + 3] = rgba[3]
        diffCount++
      } else {
        out[outIdx]     = lR
        out[outIdx + 1] = lG
        out[outIdx + 2] = lB
        out[outIdx + 3] = SAME_PIXEL_ALPHA
      }
    }
  }

  return diffCount
}

// ── Diff geometry (auto scale) ────────────────────────────────────────────────

/**
 * @typedef {object} DiffGeometry
 * @property {number} width   - diff canvas 寬
 * @property {number} height  - diff canvas 高
 * @property {number} leftW   - 左圖進入比對時的寬
 * @property {number} leftH
 * @property {number} rightW
 * @property {number} rightH
 * @property {boolean} autoScaled - 是否為了對齊尺寸而縮放過
 */

/**
 * 決定兩張圖進入 pixel diff 時的尺寸。
 *
 * @param {number} lw
 * @param {number} lh
 * @param {number} rw
 * @param {number} rh
 * @param {boolean} [autoScale]
 * @returns {DiffGeometry}
 */
export function resolveDiffGeometry(lw, lh, rw, rh, autoScale = false) {
  const mismatched = lw !== rw || lh !== rh
  const usable = lw > 0 && lh > 0 && rw > 0 && rh > 0

  if (autoScale && usable && mismatched) {
    // 對齊到「較大」的那張，而不是較小的：縮小會先丟掉細節，
    // 使得同一張圖的高低解析度版本被判成大量差異。
    const useLeft = lw * lh >= rw * rh
    const width  = useLeft ? lw : rw
    const height = useLeft ? lh : rh
    return {
      width, height,
      leftW: width, leftH: height,
      rightW: width, rightH: height,
      autoScaled: true,
    }
  }

  return {
    width: Math.max(lw, rw),
    height: Math.max(lh, rh),
    leftW: lw, leftH: lh,
    rightW: rw, rightH: rh,
    autoScaled: false,
  }
}

/**
 * 將 geometry 壓在 maxDim 以內（記憶體上限）。scale < 1 代表統計數字是外推的。
 *
 * @param {DiffGeometry} geo
 * @param {number} maxDim
 * @returns {DiffGeometry & { scale: number }}
 */
export function capDiffGeometry(geo, maxDim) {
  const longest = Math.max(geo.width, geo.height)
  const scale = longest > maxDim && maxDim > 0 ? maxDim / longest : 1
  if (scale === 1) return { ...geo, scale }
  const s = (/** @type {number} */ n) => Math.max(1, Math.round(n * scale))
  return {
    width: s(geo.width),
    height: s(geo.height),
    leftW: s(geo.leftW),
    leftH: s(geo.leftH),
    rightW: s(geo.rightW),
    rightH: s(geo.rightH),
    autoScaled: geo.autoScaled,
    scale,
  }
}

/**
 * 統計列文字。approximate 為 true 時（大圖縮圖後比對再外推）明確標示估計值。
 *
 * @param {number} diffCount
 * @param {number} totalPixels
 * @param {boolean} [approximate]
 * @returns {string}
 */
export function formatDiffStats(diffCount, totalPixels, approximate = false) {
  const pct = totalPixels > 0 ? ((diffCount / totalPixels) * 100).toFixed(2) : '0.00'
  const mark = approximate ? '≈' : ''
  const suffix = approximate ? '　（估計值：大圖已縮圖後比對）' : ''
  return `差異像素 ${mark}${diffCount.toLocaleString()} / 總像素 ${totalPixels.toLocaleString()} (${mark}${pct}%)${suffix}`
}

// ── Zoom/Pan sync ─────────────────────────────────────────────────────────────

const MIN_ZOOM = 0.1
const MAX_ZOOM = 10

/**
 * Upper bound for an image payload over IPC. Unlike hex, a truncated image is
 * useless (the decoder would choke), so anything larger is rejected outright
 * rather than silently clipped.
 */
export const MAX_IMAGE_BYTES = 134_217_728 // 128 MB

/**
 * @typedef {object} SyncTransformController
 * @property {() => void} destroy
 * @property {() => number} getZoom
 * @property {() => number} getRotation
 * @property {() => { h: boolean, v: boolean }} getFlip
 * @property {(z: number) => void} setZoom
 * @property {(deg: number) => void} setRotation
 * @property {(h: boolean, v: boolean) => void} setFlip
 * @property {() => void} reset
 */

/**
 * 為多個 wrap 元素建立同步縮放/平移/旋轉/翻轉控制器。
 *
 * @param {HTMLElement[]} wraps - .ic-canvas-wrap 元素陣列
 * @returns {SyncTransformController}
 */
function createSyncTransform(wraps) {
  let zoom = 1
  let panX = 0
  let panY = 0
  let rotation = 0
  let flipH = false
  let flipV = false

  /** 套用 transform 到所有 wrap */
  function applyTransform() {
    const sx = flipH ? -1 : 1
    const sy = flipV ? -1 : 1
    for (const w of wraps) {
      w.style.transformOrigin = '0 0'
      // Order: translate (pan) → scale (zoom) → rotate → flip (scale±1)
      w.style.transform =
        `scale(${zoom}) translate(${panX}px, ${panY}px) rotate(${rotation}deg) scale(${sx}, ${sy})`
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

  function onMouseUp() {
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
    getZoom() { return zoom },
    getRotation() { return rotation },
    getFlip() { return { h: flipH, v: flipV } },
    setZoom(z) {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
      if (clamped === zoom) return
      zoom = clamped
      applyTransform()
    },
    setRotation(deg) {
      // Normalize into [0, 360)
      let d = deg % 360
      if (d < 0) d += 360
      rotation = d
      applyTransform()
    },
    setFlip(h, v) {
      flipH = !!h
      flipV = !!v
      applyTransform()
    },
    reset() {
      zoom = 1
      panX = 0
      panY = 0
      rotation = 0
      flipH = false
      flipV = false
      applyTransform()
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

    /**
     * Blend mode for the diff overlay panel.
     *   'normal'     — diff canvas hidden
     *   'difference' — diff canvas visible (pixel diff highlighting, original behaviour)
     *   'blend'      — diff canvas visible with CSS mix-blend-mode: difference
     * @type {'normal'|'difference'|'blend'}
     */
    this._blendMode = 'difference'

    /**
     * S16: align differently-sized images before the pixel diff.
     * @type {boolean}
     */
    this._autoScale = false

    /**
     * S16: colour mismatching pixels by severity instead of a flat highlight.
     * @type {boolean}
     */
    this._mismatchRange = false

    /**
     * S16: user-selectable highlight colour key (see HIGHLIGHT_COLORS).
     * @type {string}
     */
    this._highlightColor = DEFAULT_HIGHLIGHT_COLOR

    /**
     * Mounted flag for keyboard shortcut guard.
     * @type {boolean}
     */
    this._mounted = false

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

    /** @type {((e: KeyboardEvent) => void) | null} */
    this._onKeyDownImage = null
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
    this._bindKeyboardShortcuts()
    this._mounted = true
  }

  /** 銷毀元件，清除 DOM 與事件 */
  destroy() {
    this._mounted = false
    this._unbindKeyboardShortcuts()
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
    // Decoded bitmaps are the largest thing this view holds; drop them so a
    // retained instance can't pin megabytes of image data.
    this._left = null
    this._right = null
    closeContextMenu()
  }

  // ── Public API: T57 Zoom ────────────────────────────────────────────────────

  /** Zoom in by 1.25× (clamped to MAX_ZOOM). */
  zoomIn() {
    if (!this._syncTransform) return
    const next = Math.min(MAX_ZOOM, this._syncTransform.getZoom() * 1.25)
    this._syncTransform.setZoom(next)
  }

  /** Zoom out by 1/1.25× (clamped to MIN_ZOOM). */
  zoomOut() {
    if (!this._syncTransform) return
    const next = Math.max(MIN_ZOOM, this._syncTransform.getZoom() / 1.25)
    this._syncTransform.setZoom(next)
  }

  /** Reset zoom to 1× (actual size). */
  resetZoom() {
    if (!this._syncTransform) return
    this._syncTransform.setZoom(1)
  }

  /**
   * Fit the loaded image inside the wrap container.
   * Uses the first wrap that has a loaded image as reference.
   */
  fitToWindow() {
    if (!this._syncTransform) return
    /** @type {HTMLImageElement | null} */
    const img = this._left?.img ?? this._right?.img ?? null
    if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) return
    const wrap = this._dom.wrapLeft ?? this._dom.wrapRight ?? this._dom.wrapDiff
    if (!wrap) return
    const ww = /** @type {HTMLElement} */ (wrap).clientWidth || 0
    const wh = /** @type {HTMLElement} */ (wrap).clientHeight || 0
    if (ww <= 0 || wh <= 0) return
    const scale = Math.min(ww / img.naturalWidth, wh / img.naturalHeight)
    if (!Number.isFinite(scale) || scale <= 0) return
    this._syncTransform.setZoom(scale)
  }

  // ── Public API: T58 Rotate & Flip ───────────────────────────────────────────

  /** Rotate clockwise by 90°. */
  rotateCW() {
    if (!this._syncTransform) return
    this._syncTransform.setRotation(this._syncTransform.getRotation() + 90)
  }

  /** Rotate counter-clockwise by 90°. */
  rotateCCW() {
    if (!this._syncTransform) return
    this._syncTransform.setRotation(this._syncTransform.getRotation() - 90)
  }

  /** Toggle horizontal flip. */
  flipHorizontal() {
    if (!this._syncTransform) return
    const cur = this._syncTransform.getFlip()
    this._syncTransform.setFlip(!cur.h, cur.v)
  }

  /** Toggle vertical flip. */
  flipVertical() {
    if (!this._syncTransform) return
    const cur = this._syncTransform.getFlip()
    this._syncTransform.setFlip(cur.h, !cur.v)
  }

  /** Reset zoom, pan, rotation and flips back to defaults. */
  resetTransform() {
    if (!this._syncTransform) return
    this._syncTransform.reset()
  }

  // ── Public API: T59 Blend Mode ──────────────────────────────────────────────

  /**
   * @param {'normal'|'difference'|'blend'} mode
   */
  setBlendMode(mode) {
    if (mode !== 'normal' && mode !== 'difference' && mode !== 'blend') return
    this._blendMode = mode
    const sel = /** @type {HTMLSelectElement | undefined} */ (this._dom.overlaySelect)
    if (sel && sel.value !== mode) sel.value = mode
    this._toggleDiffOverlay()
  }

  /** @returns {'normal'|'difference'|'blend'} */
  getBlendMode() {
    return this._blendMode
  }

  // ── Public API: S16 Auto Scale / Mismatch Range / Highlight colour ──────────

  /**
   * 開啟後，尺寸不同的兩張圖會先對齊到較大的尺寸再做 pixel diff。
   * @param {boolean} on
   */
  setAutoScale(on) {
    const next = !!on
    if (next === this._autoScale) return
    this._autoScale = next
    const box = /** @type {HTMLInputElement | undefined} */ (this._dom.autoScaleCheck)
    if (box && box.checked !== next) box.checked = next
    void this._runDiff()
  }

  /** @returns {boolean} */
  getAutoScale() {
    return this._autoScale
  }

  /**
   * 開啟後，差異像素依強度分成 MISMATCH_LEVELS 級顯示深淺。
   * @param {boolean} on
   */
  setMismatchRange(on) {
    const next = !!on
    if (next === this._mismatchRange) return
    this._mismatchRange = next
    const box = /** @type {HTMLInputElement | undefined} */ (this._dom.mismatchRangeCheck)
    if (box && box.checked !== next) box.checked = next
    this._updateLegend()
    void this._runDiff()
  }

  /** @returns {boolean} */
  getMismatchRange() {
    return this._mismatchRange
  }

  /**
   * @param {string} key - HIGHLIGHT_COLORS 的鍵；未知值視為 no-op
   */
  setHighlightColor(key) {
    if (!Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLORS, key)) return
    if (key === this._highlightColor) return
    this._highlightColor = key
    const sel = /** @type {HTMLSelectElement | undefined} */ (this._dom.highlightSelect)
    if (sel && sel.value !== key) sel.value = key
    this._updateLegend()
    void this._runDiff()
  }

  /** @returns {string} */
  getHighlightColor() {
    return this._highlightColor
  }

  /**
   * 呼叫 electronAPI 開啟左側圖片檔案選擇對話框
   */
  async openLeft() {
    try {
      const result = await window.electronAPI.openFileBinary({
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] }],
        maxBytes: MAX_IMAGE_BYTES,
      })
      if (!result) return
      if (result.truncated) {
        console.error('[image-compare] file exceeds the image size limit:', result.path)
        return
      }
      await this.setLeft(result.path, result.base64, result.ext)
    } catch (err) {
      console.error('[image-compare] openLeft failed:', err)
    }
  }

  /**
   * 呼叫 electronAPI 開啟右側圖片檔案選擇對話框
   */
  async openRight() {
    try {
      const result = await window.electronAPI.openFileBinary({
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] }],
        maxBytes: MAX_IMAGE_BYTES,
      })
      if (!result) return
      if (result.truncated) {
        console.error('[image-compare] file exceeds the image size limit:', result.path)
        return
      }
      await this.setRight(result.path, result.base64, result.ext)
    } catch (err) {
      console.error('[image-compare] openRight failed:', err)
    }
  }

  /**
   * 直接設定左側圖片資料
   * @param {string} path
   * @param {string} base64
   * @param {string} ext
   */
  async setLeft(path, base64, ext) {
    const img = await this._loadImage(base64, ext)
    // S14-M06: drop the base64 string after decode — nothing reads it later
    // and it can double image memory for large files.
    this._left = { path, ext, img }
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
    // S14-M06: drop base64 after decode.
    this._right = { path, ext, img }
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

    // S15-UX: path row first so "開啟圖片…" sits at the same row as other views.
    root.appendChild(this._buildPathRow())
    root.appendChild(this._buildToolbar())
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

    // T59: Blend Mode 3-way selector (replaces overlay checkbox)
    const blendLabel = el('label', { className: 'ic-toolbar-label', textContent: '疊加模式：' })
    toolbar.appendChild(blendLabel)
    const overlaySelect = /** @type {HTMLSelectElement} */ (el('select', {
      className: 'ic-overlay-select',
      title: '差異疊加顯示模式',
    }))
    for (const [val, text] of /** @type {Array<['normal'|'difference'|'blend', string]>} */ ([
      ['normal',     '無'],
      ['difference', '差異'],
      ['blend',      '混合'],
    ])) {
      const opt = document.createElement('option')
      opt.value = val
      opt.textContent = text
      overlaySelect.appendChild(opt)
    }
    overlaySelect.value = this._blendMode
    this._dom.overlaySelect = overlaySelect
    toolbar.appendChild(overlaySelect)

    // Separator
    toolbar.appendChild(el('span', { className: 'ic-toolbar-sep' }))

    // S16-1: Auto Scale
    const autoScaleCheck = /** @type {HTMLInputElement} */ (el('input', {
      type: 'checkbox',
      className: 'ic-toolbar-check',
      id: 'ic-auto-scale',
      title: '尺寸不同時，先把較小的一張放大到與較大的相同再比對',
    }))
    autoScaleCheck.checked = this._autoScale
    this._dom.autoScaleCheck = autoScaleCheck
    toolbar.appendChild(autoScaleCheck)
    toolbar.appendChild(el('label', {
      className: 'ic-toolbar-label', for: 'ic-auto-scale', textContent: '自動縮放對齊',
    }))

    // S16-2: Mismatch Range mode
    const mismatchRangeCheck = /** @type {HTMLInputElement} */ (el('input', {
      type: 'checkbox',
      className: 'ic-toolbar-check',
      id: 'ic-mismatch-range',
      title: '依差異程度分級上色：越深表示差異越大',
    }))
    mismatchRangeCheck.checked = this._mismatchRange
    this._dom.mismatchRangeCheck = mismatchRangeCheck
    toolbar.appendChild(mismatchRangeCheck)
    toolbar.appendChild(el('label', {
      className: 'ic-toolbar-label', for: 'ic-mismatch-range', textContent: '差異分級',
    }))

    // S16-3: Highlight colour
    toolbar.appendChild(el('label', { className: 'ic-toolbar-label', textContent: '標示色：' }))
    const highlightSelect = /** @type {HTMLSelectElement} */ (el('select', {
      className: 'ic-overlay-select ic-highlight-select',
      title: '差異像素的高亮顏色',
    }))
    for (const [key, entry] of Object.entries(HIGHLIGHT_COLORS)) {
      const opt = document.createElement('option')
      opt.value = key
      opt.textContent = entry.label
      highlightSelect.appendChild(opt)
    }
    highlightSelect.value = this._highlightColor
    this._dom.highlightSelect = highlightSelect
    toolbar.appendChild(highlightSelect)

    // Separator
    toolbar.appendChild(el('span', { className: 'ic-toolbar-sep' }))

    // T57: Zoom controls
    const btnZoomIn = el('button', {
      className: 'ic-btn-refresh', title: '放大 (Ctrl++)', textContent: '🔍+',
    })
    this._dom.btnZoomIn = btnZoomIn
    toolbar.appendChild(btnZoomIn)

    const btnZoomOut = el('button', {
      className: 'ic-btn-refresh', title: '縮小 (Ctrl+-)', textContent: '🔍-',
    })
    this._dom.btnZoomOut = btnZoomOut
    toolbar.appendChild(btnZoomOut)

    const btnActualSize = el('button', {
      className: 'ic-btn-refresh', title: '實際大小 (Ctrl+0)', textContent: '1:1',
    })
    this._dom.btnActualSize = btnActualSize
    toolbar.appendChild(btnActualSize)

    const btnFit = el('button', {
      className: 'ic-btn-refresh', title: '符合視窗 (Ctrl+Shift+F)', textContent: '⬜',
    })
    this._dom.btnFit = btnFit
    toolbar.appendChild(btnFit)

    // Separator
    toolbar.appendChild(el('span', { className: 'ic-toolbar-sep' }))

    // T58: Rotate & Flip controls
    const btnRotateCW = el('button', {
      className: 'ic-btn-refresh', title: '順時針旋轉 90°', textContent: '↻',
    })
    this._dom.btnRotateCW = btnRotateCW
    toolbar.appendChild(btnRotateCW)

    const btnRotateCCW = el('button', {
      className: 'ic-btn-refresh', title: '逆時針旋轉 90°', textContent: '↺',
    })
    this._dom.btnRotateCCW = btnRotateCCW
    toolbar.appendChild(btnRotateCCW)

    const btnFlipH = el('button', {
      className: 'ic-btn-refresh', title: '水平翻轉', textContent: '↔',
    })
    this._dom.btnFlipH = btnFlipH
    toolbar.appendChild(btnFlipH)

    const btnFlipV = el('button', {
      className: 'ic-btn-refresh', title: '垂直翻轉', textContent: '↕',
    })
    this._dom.btnFlipV = btnFlipV
    toolbar.appendChild(btnFlipV)

    const btnResetTransform = el('button', {
      className: 'ic-btn-refresh', title: '重設旋轉與縮放', textContent: '⟲',
    })
    this._dom.btnResetTransform = btnResetTransform
    toolbar.appendChild(btnResetTransform)

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
    const bar = el('div', { className: 'ic-stats' })
    const text = el('span', {
      className: 'ic-stats-text', textContent: '請載入兩張圖片以計算差異',
    })
    const legend = el('span', { className: 'ic-mismatch-legend' })
    bar.appendChild(text)
    bar.appendChild(legend)
    this._dom.statsBar = bar
    this._dom.stats = text
    this._dom.legend = legend
    this._updateLegend()
    return bar
  }

  /** 依目前的分級模式與標示色重建圖例。 */
  _updateLegend() {
    const legend = /** @type {HTMLElement | undefined} */ (this._dom.legend)
    if (!legend) return
    legend.textContent = ''
    if (!this._mismatchRange) {
      legend.style.display = 'none'
      return
    }
    legend.style.display = ''
    legend.appendChild(el('span', { className: 'ic-legend-caption', textContent: '差異程度：輕' }))
    for (let lv = 1; lv <= MISMATCH_LEVELS; lv++) {
      const [r, g, b, a] = highlightRGBA(this._highlightColor, lv)
      const swatch = el('span', { className: 'ic-legend-swatch' })
      swatch.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
      legend.appendChild(swatch)
    }
    legend.appendChild(el('span', { className: 'ic-legend-caption', textContent: '重' }))
  }

  // ── Private: Event binding ──────────────────────────────────────────────────

  _bindEvents() {
    // CLAUDE.md note: the `/** @type {HTMLElement} */ (varName).method()` pattern
    // here triggers an esbuild TDZ bug on production builds — the leading
    // comment makes esbuild parse `(varName)` on the NEXT line as a function
    // call on the destructured binding *before* its initialiser completes,
    // producing `Cannot access 'btnOpenLeft' before initialization` at run
    // time. Use destructuring on its own line and reference the bindings
    // directly without inline casts.
    const dom = this._dom
    const btnOpenLeft        = dom.btnOpenLeft
    const btnOpenRight       = dom.btnOpenRight
    const btnRefresh         = dom.btnRefresh
    const thresholdSlider    = dom.thresholdSlider
    const thresholdVal       = dom.thresholdVal
    const overlaySelect      = dom.overlaySelect
    const autoScaleCheck     = dom.autoScaleCheck
    const mismatchRangeCheck = dom.mismatchRangeCheck
    const highlightSelect    = dom.highlightSelect
    const btnZoomIn          = dom.btnZoomIn
    const btnZoomOut         = dom.btnZoomOut
    const btnActualSize      = dom.btnActualSize
    const btnFit             = dom.btnFit
    const btnRotateCW        = dom.btnRotateCW
    const btnRotateCCW       = dom.btnRotateCCW
    const btnFlipH           = dom.btnFlipH
    const btnFlipV           = dom.btnFlipV
    const btnResetTransform  = dom.btnResetTransform

    btnOpenLeft?.addEventListener('click', () => this.openLeft())
    btnOpenRight?.addEventListener('click', () => this.openRight())
    btnRefresh?.addEventListener('click', () => this.refresh())

    thresholdSlider?.addEventListener('input', () => {
      this._threshold = parseFloat(thresholdSlider.value)
      if (thresholdVal) thresholdVal.textContent = this._threshold.toFixed(2)
    })

    thresholdSlider?.addEventListener('change', () => {
      this._threshold = parseFloat(thresholdSlider.value)
      if (thresholdVal) thresholdVal.textContent = this._threshold.toFixed(2)
      this.refresh()
    })

    overlaySelect?.addEventListener('change', () => {
      const v = overlaySelect.value
      if (v === 'normal' || v === 'difference' || v === 'blend') {
        this.setBlendMode(v)
      }
    })

    autoScaleCheck?.addEventListener('change', () => {
      this.setAutoScale(autoScaleCheck.checked)
    })

    mismatchRangeCheck?.addEventListener('change', () => {
      this.setMismatchRange(mismatchRangeCheck.checked)
    })

    highlightSelect?.addEventListener('change', () => {
      this.setHighlightColor(highlightSelect.value)
    })

    btnZoomIn?.addEventListener('click', () => this.zoomIn())
    btnZoomOut?.addEventListener('click', () => this.zoomOut())
    btnActualSize?.addEventListener('click', () => this.resetZoom())
    btnFit?.addEventListener('click', () => this.fitToWindow())

    btnRotateCW?.addEventListener('click', () => this.rotateCW())
    btnRotateCCW?.addEventListener('click', () => this.rotateCCW())
    btnFlipH?.addEventListener('click', () => this.flipHorizontal())
    btnFlipV?.addEventListener('click', () => this.flipVertical())
    btnResetTransform?.addEventListener('click', () => this.resetTransform())

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
    const diffCanvas = /** @type {HTMLCanvasElement | undefined} */ (this._dom.canvasDiff)
    if (!diffCanvas || !this._diffCtx) return

    const { img: lImg } = this._left
    const { img: rImg } = this._right

    const lw = lImg.naturalWidth
    const lh = lImg.naturalHeight
    const rw = rImg.naturalWidth
    const rh = rImg.naturalHeight

    const fullGeo = resolveDiffGeometry(lw, lh, rw, rh, this._autoScale)

    // S14-M01: cap diff resolution. A pair of 8000x6000 RGBA buffers plus the
    // diff buffer is ~570MB and crashes the renderer. The full-resolution
    // display canvases (left/right) are untouched.
    const MAX_DIFF_DIM = 2048
    const geo = capDiffGeometry(fullGeo, MAX_DIFF_DIM)

    diffCanvas.width  = geo.width
    diffCanvas.height = geo.height

    // Any side whose diff-time size differs from its natural size has to go
    // through an off-screen canvas — that single path covers both the memory
    // cap and auto-scale alignment.
    const leftCtx = (geo.leftW === lw && geo.leftH === lh)
      ? this._leftCtx
      : _makeScratchFor(lImg, geo.leftW, geo.leftH)
    const rightCtx = (geo.rightW === rw && geo.rightH === rh)
      ? this._rightCtx
      : _makeScratchFor(rImg, geo.rightW, geo.rightH)
    if (!leftCtx || !rightCtx) return

    const diffImgData = this._diffCtx.createImageData(geo.width, geo.height)
    const diffCount = computeDiffBuffer({
      leftData: leftCtx.getImageData(0, 0, geo.leftW, geo.leftH).data,
      rightData: rightCtx.getImageData(0, 0, geo.rightW, geo.rightH).data,
      out: diffImgData.data,
      width: geo.width,
      height: geo.height,
      lw: geo.leftW, lh: geo.leftH,
      rw: geo.rightW, rh: geo.rightH,
      threshold: this._threshold,
      algorithm: this._algorithm,
      mismatchRange: this._mismatchRange,
      highlightColor: this._highlightColor,
    })
    this._diffCtx.putImageData(diffImgData, 0, 0)

    // Report stats at the FULL resolution so user-facing numbers match the
    // image dimensions the user sees. Extrapolating diffCount by 1/scale² is an
    // estimate, hence the explicit approximate flag below.
    const approximate = geo.scale < 1
    const totalPixels = fullGeo.width * fullGeo.height
    const reportedDiffCount = approximate
      ? Math.round(diffCount / (geo.scale * geo.scale))
      : diffCount
    this._updateStats(reportedDiffCount, totalPixels, approximate)

    // 若 overlay 已關閉，隱藏 diff canvas
    this._toggleDiffOverlay()
  }

  // ── Private: Stats ──────────────────────────────────────────────────────────

  /**
   * @param {number | null} diffCount
   * @param {number | null} totalPixels
   * @param {boolean} [approximate] - 數字由縮圖比對外推而來
   */
  _updateStats(diffCount, totalPixels, approximate = false) {
    const stats = this._dom.stats
    if (!stats) return

    if (diffCount === null || totalPixels === null) {
      stats.textContent = '請載入兩張圖片以計算差異'
      stats.classList?.remove('ic-stats-text--approx')
      return
    }

    stats.textContent = formatDiffStats(diffCount, totalPixels, approximate)
    stats.classList?.toggle('ic-stats-text--approx', approximate)
  }

  // ── Private: Overlay toggle ─────────────────────────────────────────────────

  _toggleDiffOverlay() {
    const wrapDiff = /** @type {HTMLElement | undefined} */ (this._dom.wrapDiff)
    if (!wrapDiff) return
    if (this._blendMode === 'normal') {
      wrapDiff.style.visibility = 'hidden'
      wrapDiff.style.mixBlendMode = ''
    } else if (this._blendMode === 'blend') {
      wrapDiff.style.visibility = ''
      wrapDiff.style.mixBlendMode = 'difference'
    } else {
      // 'difference' (default): show diff canvas without blend
      wrapDiff.style.visibility = ''
      wrapDiff.style.mixBlendMode = ''
    }
  }

  // ── Private: T57 Keyboard shortcuts ─────────────────────────────────────────

  _bindKeyboardShortcuts() {
    /** @param {KeyboardEvent} e */
    this._onKeyDownImage = (e) => {
      if (!this._mounted || !isActive('image')) return
      // Ignore when typing into editable input/textarea
      const target = /** @type {HTMLElement | null} */ (e.target)
      if (target && target.matches && target.matches('input, textarea, select')) return

      // Ctrl++ / Ctrl+= → Zoom in
      if (e.ctrlKey && !e.shiftKey && (e.key === '+' || e.key === '=')) {
        e.preventDefault()
        this.zoomIn()
        return
      }
      // Ctrl+- → Zoom out
      if (e.ctrlKey && !e.shiftKey && (e.key === '-' || e.key === '_')) {
        e.preventDefault()
        this.zoomOut()
        return
      }
      // Ctrl+0 → Reset zoom
      if (e.ctrlKey && !e.shiftKey && e.key === '0') {
        e.preventDefault()
        this.resetZoom()
        return
      }
      // Ctrl+Shift+F → Fit to window
      if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault()
        this.fitToWindow()
        return
      }
    }
    document.addEventListener('keydown', this._onKeyDownImage)
  }

  _unbindKeyboardShortcuts() {
    if (this._onKeyDownImage) {
      document.removeEventListener('keydown', this._onKeyDownImage)
      this._onKeyDownImage = null
    }
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
