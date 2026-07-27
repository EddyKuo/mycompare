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
import { tagConfig, readConfig } from '../core/named-config-store.js'
import { stepDiffIndex, navResult, getNavOptions } from '../core/diff-nav.js'
import { renderTextTable, reportHeader } from '../core/report.js'
import '../styles/image-compare.css'

/** @typedef {import('../core/diff-nav.js').NavResult} NavResult */

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

/** The swatch a freshly-opened custom colour picker starts on. */
export const DEFAULT_CUSTOM_HIGHLIGHT = '#ff8800'

/**
 * Parse `#rgb` / `#rrggbb` into channel values.
 *
 * @param {unknown} value
 * @returns {[number, number, number] | null} null when the input is not a hex colour
 */
export function parseHexColor(value) {
  if (typeof value !== 'string') return null
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!m) return null
  const hex = m[1]
  if (hex.length === 3) {
    return [
      parseInt(hex[0] + hex[0], 16),
      parseInt(hex[1] + hex[1], 16),
      parseInt(hex[2] + hex[2], 16),
    ]
  }
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

/**
 * `#rrggbb` for a colour input, or null when the value is not a colour.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeHexColor(value) {
  const rgb = parseHexColor(value)
  if (!rgb) return null
  return `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Resolve a highlight selection to RGB.
 *
 * Accepts either a named key or a hex colour, so the custom swatch needs no
 * separate code path anywhere downstream.
 *
 * @param {unknown} key
 * @returns {[number, number, number]} the default colour when unrecognised
 */
export function resolveHighlightRGB(key) {
  const named = HIGHLIGHT_COLORS[/** @type {HighlightColorKey} */ (key)]
  if (named) return named.rgb
  return parseHexColor(key) ?? HIGHLIGHT_COLORS[DEFAULT_HIGHLIGHT_COLOR].rgb
}

/**
 * Human label for a highlight selection, for reports and tooltips.
 * @param {unknown} key
 * @returns {string}
 */
export function highlightColorLabel(key) {
  const named = HIGHLIGHT_COLORS[/** @type {HighlightColorKey} */ (key)]
  if (named) return named.label
  const hex = normalizeHexColor(key)
  return hex ? `自訂 ${hex}` : String(key)
}

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
  const rgb = resolveHighlightRGB(colorKey)
  const lv = Math.min(MISMATCH_LEVELS, Math.max(1, Math.round(level)))
  const t = lv / MISMATCH_LEVELS
  const k = MIN_HIGHLIGHT_INTENSITY + (1 - MIN_HIGHLIGHT_INTENSITY) * t
  return [
    Math.round(rgb[0] * k),
    Math.round(rgb[1] * k),
    Math.round(rgb[2] * k),
    Math.round(MIN_HIGHLIGHT_ALPHA + (MAX_HIGHLIGHT_ALPHA - MIN_HIGHLIGHT_ALPHA) * t),
  ]
}

// ── Replacements (BC "unimportant colour differences") ────────────────────────

/**
 * Upper bound on replacement rules.
 *
 * Every rule is one Map entry consulted only for pixels that already differ,
 * so the cost is bounded regardless; the cap exists so the dialog stays a list
 * a person can read rather than an unbounded table.
 */
export const MAX_REPLACEMENT_RULES = 64

/**
 * Colour used for differences that a replacement rule declared unimportant.
 * Blue, per the project's fixed colour semantics for unimportant differences.
 * @type {[number, number, number, number]}
 */
export const UNIMPORTANT_RGBA = [80, 140, 255, 170]

/**
 * @typedef {object} ReplacementRule
 * @property {string} from  colour seen in a file, `#rrggbb`
 * @property {string} to    colour it should be treated as, `#rrggbb`
 */

/** @param {number} r @param {number} g @param {number} b @returns {number} */
function packRGB(r, g, b) {
  return (r << 16) | (g << 8) | b
}

/**
 * Turn replacement rules into the packed-RGB lookup the diff loop uses.
 *
 * Chains are resolved eagerly (a→b, b→c means a→c) so the inner loop never
 * has to follow more than one link; a cycle stops at its entry point rather
 * than looping forever.
 *
 * @param {ReplacementRule[] | null | undefined} rules
 * @returns {Map<number, number> | null} null when there is nothing to apply
 */
export function buildReplacementMap(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null
  /** @type {Map<number, number>} */
  const direct = new Map()
  for (const rule of rules.slice(0, MAX_REPLACEMENT_RULES)) {
    const from = parseHexColor(rule?.from)
    const to = parseHexColor(rule?.to)
    if (!from || !to) continue
    const key = packRGB(from[0], from[1], from[2])
    const val = packRGB(to[0], to[1], to[2])
    if (key === val) continue
    // First rule wins, so an accidental duplicate cannot silently override an
    // earlier one the user still sees listed above it.
    if (!direct.has(key)) direct.set(key, val)
  }
  if (direct.size === 0) return null

  /** @type {Map<number, number>} */
  const resolved = new Map()
  for (const key of direct.keys()) {
    let cur = /** @type {number} */ (direct.get(key))
    const seen = new Set([key])
    while (direct.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      cur = /** @type {number} */ (direct.get(cur))
    }
    resolved.set(key, cur)
  }
  return resolved
}

/**
 * Validate/normalise rules coming from a stored config or the dialog.
 *
 * @param {unknown} rules
 * @returns {ReplacementRule[]}
 */
export function normalizeReplacements(rules) {
  if (!Array.isArray(rules)) return []
  /** @type {ReplacementRule[]} */
  const out = []
  for (const rule of rules) {
    const from = normalizeHexColor(rule?.from)
    const to = normalizeHexColor(rule?.to)
    if (!from || !to) continue
    out.push({ from, to })
    if (out.length >= MAX_REPLACEMENT_RULES) break
  }
  return out
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
 * @property {Uint32Array} [tileCounts] - 選用；每個 tile 累計的差異像素數
 * @property {number} [tileSize] - tile 邊長（px），搭配 tileCounts 使用
 * @property {number} [tileCols] - tileCounts 的每列 tile 數
 * @property {Map<number, number> | null} [replacements] - packed-RGB 取代表
 * @property {number} [offsetX] - 右圖相對左圖的水平位移（px）
 * @property {number} [offsetY] - 右圖相對左圖的垂直位移（px）
 * @property {{ unimportant: number }} [counters] - 就地寫回「不重要差異」像素數
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
    tileCounts = null,
    tileSize = 0,
    tileCols = 0,
    replacements = null,
    offsetX = 0,
    offsetY = 0,
    counters = null,
  } = opts

  const tally = tileCounts && tileSize > 0 && tileCols > 0 ? tileCounts : null
  const remap = replacements instanceof Map && replacements.size > 0 ? replacements : null
  const ox = Number.isFinite(offsetX) ? Math.trunc(offsetX) : 0
  const oy = Number.isFinite(offsetY) ? Math.trunc(offsetY) : 0
  let unimportantCount = 0

  // The inner loop runs once per pixel, so the per-level colours are resolved
  // up-front rather than recomputed millions of times.
  /** @type {Array<[number, number, number, number]>} */
  const palette = []
  for (let i = 1; i <= MISMATCH_LEVELS; i++) palette.push(highlightRGBA(highlightColor, i))
  const flat = palette[MISMATCH_LEVELS - 1]

  let diffCount = 0

  for (let y = 0; y < height; y++) {
    // Hoisted: the row's tile band is constant across the inner loop.
    const tileRowBase = tally ? Math.floor(y / tileSize) * tileCols : 0
    for (let x = 0; x < width; x++) {
      const outIdx = (y * width + x) * 4

      // The right image can be displaced, so its sample coordinate is the
      // canvas coordinate minus the offset.
      const rx = x - ox
      const ry = y - oy
      const inLeft  = x < lw && y < lh
      const inRight = rx >= 0 && ry >= 0 && rx < rw && ry < rh

      if (!inLeft || !inRight) {
        // 超出其中一張圖的範圍 → 視為最嚴重的差異
        out[outIdx]     = flat[0]
        out[outIdx + 1] = flat[1]
        out[outIdx + 2] = flat[2]
        out[outIdx + 3] = flat[3]
        diffCount++
        if (tally) tally[tileRowBase + Math.floor(x / tileSize)]++
        continue
      }

      const lIdx = (y * lw + x) * 4
      const rIdx = (ry * rw + rx) * 4

      const lR = leftData[lIdx]
      const lG = leftData[lIdx + 1]
      const lB = leftData[lIdx + 2]
      const rR = rightData[rIdx]
      const rG = rightData[rIdx + 1]
      const rB = rightData[rIdx + 2]

      const magnitude = pixelDiffMagnitude(lR, lG, lB, rR, rG, rB, algorithm)

      if (isPixelDiff(magnitude, threshold, algorithm)) {
        // Replacements are consulted only for pixels that already differ, so
        // an identical image pays nothing for having rules configured.
        let unimportant = false
        if (remap) {
          const lKey = packRGB(lR, lG, lB)
          const rKey = packRGB(rR, rG, rB)
          const lCanon = remap.get(lKey) ?? lKey
          const rCanon = remap.get(rKey) ?? rKey
          if (lCanon === rCanon) {
            unimportant = true
          } else {
            const after = pixelDiffMagnitude(
              (lCanon >> 16) & 0xff, (lCanon >> 8) & 0xff, lCanon & 0xff,
              (rCanon >> 16) & 0xff, (rCanon >> 8) & 0xff, rCanon & 0xff,
              algorithm,
            )
            unimportant = !isPixelDiff(after, threshold, algorithm)
          }
        }

        if (unimportant) {
          out[outIdx]     = UNIMPORTANT_RGBA[0]
          out[outIdx + 1] = UNIMPORTANT_RGBA[1]
          out[outIdx + 2] = UNIMPORTANT_RGBA[2]
          out[outIdx + 3] = UNIMPORTANT_RGBA[3]
          unimportantCount++
          continue
        }

        const rgba = mismatchRange
          ? palette[mismatchLevel(magnitude, threshold, algorithm) - 1]
          : flat
        out[outIdx]     = rgba[0]
        out[outIdx + 1] = rgba[1]
        out[outIdx + 2] = rgba[2]
        out[outIdx + 3] = rgba[3]
        diffCount++
        if (tally) tally[tileRowBase + Math.floor(x / tileSize)]++
      } else {
        out[outIdx]     = lR
        out[outIdx + 1] = lG
        out[outIdx + 2] = lB
        out[outIdx + 3] = SAME_PIXEL_ALPHA
      }
    }
  }

  if (counters) counters.unimportant = unimportantCount
  return diffCount
}

// ── Diff regions (difference navigation) ──────────────────────────────────────

/**
 * Upper bound on the tile grid per axis.
 *
 * Regions exist so F7/F8 can walk a picture's differing areas. A per-pixel or
 * connected-component decomposition would produce thousands of stops on a
 * photo, so the image is bucketed into a coarse grid instead — capped here so
 * the region count stays navigable regardless of resolution.
 */
export const DIFF_TILE_GRID = 32

/**
 * @param {number} width
 * @param {number} height
 * @returns {number} tile edge length in px (>= 1)
 */
export function diffTileSize(width, height) {
  const longest = Math.max(width, height, 1)
  return Math.max(1, Math.ceil(longest / DIFF_TILE_GRID))
}

/**
 * @typedef {object} ImageDiffRegion
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} count differing pixels inside the tile
 */

/**
 * Turn a per-tile diff tally into navigable regions, in reading order.
 *
 * @param {Uint32Array} tileCounts
 * @param {number} tileCols
 * @param {number} tileSize
 * @param {number} width
 * @param {number} height
 * @returns {ImageDiffRegion[]}
 */
export function tilesToRegions(tileCounts, tileCols, tileSize, width, height) {
  /** @type {ImageDiffRegion[]} */
  const regions = []
  if (!tileCounts || tileCols <= 0 || tileSize <= 0) return regions
  for (let i = 0; i < tileCounts.length; i++) {
    const count = tileCounts[i]
    if (!count) continue
    const x = (i % tileCols) * tileSize
    const y = Math.floor(i / tileCols) * tileSize
    regions.push({
      x,
      y,
      w: Math.min(tileSize, width - x),
      h: Math.min(tileSize, height - y),
      count,
    })
  }
  return regions
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

// ── Report ────────────────────────────────────────────────────────────────────

/**
 * Everything a report says about an image comparison.
 *
 * @typedef {object} ImageReportInfo
 * @property {string} leftPath
 * @property {string} rightPath
 * @property {{ w: number, h: number } | null} leftSize
 * @property {{ w: number, h: number } | null} rightSize
 * @property {number | null} diffCount   null when a side is missing
 * @property {number | null} totalPixels
 * @property {boolean} approximate
 * @property {number} regionCount
 * @property {number} threshold
 * @property {'exact'|'tolerance'|'grayscale'} algorithm
 * @property {boolean} autoScale
 * @property {boolean} mismatchRange
 * @property {'normal'|'difference'|'blend'} blendMode
 * @property {number} [blendRatio]
 * @property {string} highlightColor
 * @property {ImageMetadata|null} [leftMeta]
 * @property {ImageMetadata|null} [rightMeta]
 * @property {boolean} [compareMetadata]
 * @property {MetadataFieldDiff[]} [metadataDiffs]
 * @property {ReplacementRule[]} [replacements]
 * @property {boolean} [ignoreUnimportant]
 * @property {number} [unimportantCount]
 * @property {{ x: number, y: number }} [diffOffset]
 */

const ALGORITHM_LABELS = {
  exact: '精確比對',
  tolerance: '容差比對（±10）',
  grayscale: '灰階比對',
}

const BLEND_LABELS = { normal: '無', difference: '差異', blend: '混合' }

/**
 * The comparison parameters, as label/value pairs.
 *
 * A pixel count means nothing without the threshold and algorithm that
 * produced it, so the report carries them rather than only the verdict.
 *
 * @param {ImageReportInfo} info
 * @returns {string[][]}
 */
export function imageReportParameters(info) {
  const size = (s) => (s ? `${s.w}×${s.h}` : '（未載入）')
  return [
    ['左圖尺寸', size(info.leftSize)],
    ['右圖尺寸', size(info.rightSize)],
    ['差異閾值', Number(info.threshold ?? 0).toFixed(2)],
    ['比對演算法', ALGORITHM_LABELS[info.algorithm] ?? String(info.algorithm)],
    ['自動縮放對齊', info.autoScale ? '開' : '關'],
    ['差異分級', info.mismatchRange ? '開' : '關'],
    ['疊加模式', BLEND_LABELS[info.blendMode] ?? String(info.blendMode)],
    ['混合比例', `${Math.round((info.blendRatio ?? 1) * 100)}%`],
    ['標示色', highlightColorLabel(info.highlightColor)],
    ['差異區塊數', String(info.regionCount ?? 0)],
    ['差異位移', `X ${info.diffOffset?.x ?? 0}, Y ${info.diffOffset?.y ?? 0}`],
    ['中繼資料比對', info.compareMetadata
      ? `開（差異 ${info.metadataDiffs?.length ?? 0} 項）`
      : '關'],
    ['取代規則', `${info.replacements?.length ?? 0} 條${
      info.ignoreUnimportant ? '（已套用，忽略不重要差異）' : '（未套用）'}`],
    ['不重要差異像素', String(info.unimportantCount ?? 0)],
  ]
}

/**
 * Plain-text image comparison report.
 *
 * @param {ImageReportInfo} info
 * @param {{ generatedAt?: Date }} [opts]
 * @returns {string}
 */
export function buildImageTextReport(info, opts = {}) {
  const header = reportHeader({
    title: '圖片比對報告',
    leftPath: info.leftPath,
    rightPath: info.rightPath,
    generatedAt: opts.generatedAt,
  })
  const summary = (info.diffCount === null || info.totalPixels === null)
    ? '尚未載入兩張圖片，無法計算差異'
    : formatDiffStats(info.diffCount, info.totalPixels, info.approximate)
  const table = renderTextTable(
    [{ title: '項目' }, { title: '值' }],
    imageReportParameters(info))
  /**
   * @param {string} label
   * @param {ImageMetadata|null|undefined} m
   */
  const meta = (label, m) => `${label}檔頭中繼資料\n${
    renderTextTable([{ title: '項目' }, { title: '值' }], imageMetadataRows(m))}`
  const metaDiff = `中繼資料差異\n${renderTextTable(
    [{ title: '項目' }, { title: '值' }],
    metadataDiffRows(info.metadataDiffs ?? [], !!info.compareMetadata))}`
  return `${header}${summary}\n\n${table}\n\n${
    meta('左側', info.leftMeta)}\n${meta('右側', info.rightMeta)}\n${metaDiff}\n`
}

// ── Image info panel ─────────────────────────────────────────────────────────

/**
 * Byte length of a base64 payload, without materialising the bytes.
 *
 * The decoded image is kept but the base64 string is dropped right after load,
 * so the size has to be taken while it is still in hand.
 *
 * @param {string} b64
 * @returns {number}
 */
export function base64ByteLength(b64) {
  const s = String(b64 ?? '').replace(/[\r\n]/g, '')
  if (!s) return 0
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(s.length * 3 / 4) - padding)
}

/**
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n == null) return '（未知）'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

// ── File-header metadata ─────────────────────────────────────────────────────

/**
 * How much of the file is kept for header parsing.
 *
 * Everything read below lives in the first few kilobytes of every format
 * handled here; EXIF thumbnails can push an APP1 segment to 64 KB, and PNG
 * writers occasionally place `pHYs` after a large `iCCP`. 256 KB covers both
 * without keeping a second copy of a large image alive.
 */
export const METADATA_SCAN_BYTES = 256 * 1024

/**
 * @typedef {object} ImageMetadata
 * @property {string} container  container as identified from its signature
 * @property {boolean} supported whether this reader can decode that container
 * @property {string[][]} fields label/value rows read from the file itself
 * @property {string} [note]     why something is absent, when it is
 */

/**
 * Decode a base64 payload's leading bytes.
 *
 * @param {string} b64
 * @param {number} [limit]
 * @returns {Uint8Array} empty when the input is not decodable base64
 */
export function base64HeadBytes(b64, limit = METADATA_SCAN_BYTES) {
  const clean = String(b64 ?? '').replace(/[\r\n]/g, '')
  if (!clean) return new Uint8Array(0)
  // 4 base64 chars per 3 bytes; slicing on a multiple of 4 keeps atob happy.
  const chars = Math.min(clean.length, Math.ceil(limit / 3) * 4)
  const head = clean.slice(0, chars - (chars % 4))
  try {
    const bin = atob(head)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    // Not base64 (a data: URL prefix, or a truncated payload). The caller
    // reports "unreadable" rather than inventing values.
    return new Uint8Array(0)
  }
}

/** @param {Uint8Array} b @param {number} at @returns {number} */
const u16be = (b, at) => (b[at] << 8) | b[at + 1]
/** @param {Uint8Array} b @param {number} at @returns {number} */
const u32be = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]
/** @param {Uint8Array} b @param {number} at @returns {number} */
const u16le = (b, at) => b[at] | (b[at + 1] << 8)
/** @param {Uint8Array} b @param {number} at @returns {number} */
const u32le = (b, at) => (b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + (b[at + 3] * 0x1000000))

/** @param {Uint8Array} b @param {number} at @param {string} sig @returns {boolean} */
function matches(b, at, sig) {
  if (b.length < at + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig.charCodeAt(i)) return false
  return true
}

const PNG_COLOR_TYPES = {
  0: '灰階', 2: 'RGB（真彩色）', 3: '索引色（調色盤）', 4: '灰階＋Alpha', 6: 'RGBA（真彩色＋Alpha）',
}

/** EXIF tags this reader names. Anything else is skipped, not guessed at. */
const EXIF_TAGS = {
  0x010e: '影像描述', 0x010f: '相機製造商', 0x0110: '相機型號',
  0x0112: '方向', 0x011a: '水平解析度', 0x011b: '垂直解析度',
  0x0128: '解析度單位', 0x0131: '軟體', 0x0132: '檔案修改時間',
  0x9003: '拍攝時間', 0x829a: '曝光時間', 0x829d: '光圈值',
  0x8827: 'ISO', 0x920a: '焦距', 0xa002: 'EXIF 影像寬', 0xa003: 'EXIF 影像高',
  0xa001: '色彩空間',
}

const EXIF_ORIENTATION = {
  1: '正常', 2: '水平翻轉', 3: '旋轉 180°', 4: '垂直翻轉',
  5: '轉置（順時針 90° ＋翻轉）', 6: '順時針 90°', 7: '轉置（逆時針 90° ＋翻轉）', 8: '逆時針 90°',
}

/**
 * Read the TIFF structure an EXIF segment carries.
 *
 * Only IFD0 and the Exif sub-IFD are walked, and only the tags in EXIF_TAGS
 * are reported: a dump of every private maker-note tag would be noise, and a
 * tag whose type this does not understand is skipped rather than rendered as
 * whatever its bytes happen to spell.
 *
 * @param {Uint8Array} b
 * @param {number} start  offset of the "II"/"MM" byte-order mark
 * @returns {string[][]}
 */
export function parseExif(b, start) {
  /** @type {string[][]} */
  const out = []
  if (b.length < start + 8) return out
  const le = matches(b, start, 'II')
  if (!le && !matches(b, start, 'MM')) return out
  const u16 = (at) => (le ? u16le(b, at) : u16be(b, at))
  const u32 = (at) => (le ? u32le(b, at) : u32be(b, at))
  if (u16(start + 2) !== 42) return out

  /** @type {number|null} */
  let resolutionUnit = null
  /** @type {Array<[string, string]>} */
  const rows = []

  /** @param {number} ifd @param {number} depth */
  const walk = (ifd, depth) => {
    if (depth > 1) return // IFD0 → Exif IFD; deeper is maker-note territory
    const base = start + ifd
    if (base + 2 > b.length) return
    const count = u16(base)
    for (let i = 0; i < count; i++) {
      const e = base + 2 + i * 12
      if (e + 12 > b.length) return
      const tag = u16(e)
      const type = u16(e + 2)
      const num = u32(e + 4)
      const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }
      const unit = sizes[type]
      if (!unit) continue
      const bytes = unit * num
      const at = bytes <= 4 ? e + 8 : start + u32(e + 8)
      if (at < 0 || at + bytes > b.length) continue

      if (tag === 0x8769) { walk(u32(e + 8), depth + 1); continue }

      const label = EXIF_TAGS[tag]
      if (!label) continue

      /** @type {string|null} */
      let value = null
      if (type === 2) {
        let s = ''
        for (let k = 0; k < bytes && b[at + k] !== 0; k++) s += String.fromCharCode(b[at + k])
        value = s.trim() || null
      } else if (type === 3) {
        value = String(u16(at))
      } else if (type === 4) {
        value = String(u32(at))
      } else if (type === 5 || type === 10) {
        const den = u32(at + 4)
        value = den === 0 ? null : String(Number((u32(at) / den).toFixed(4)))
      }
      if (value === null) continue

      if (tag === 0x0112) value = EXIF_ORIENTATION[Number(value)] ?? value
      if (tag === 0x0128) resolutionUnit = Number(value)
      if (tag === 0xa001) value = value === '1' ? 'sRGB' : `未校正（${value}）`
      rows.push([label, value])
    }
  }

  walk(u32(start + 4), 0)

  // The resolution numbers mean nothing without their unit, so it is folded in
  // rather than listed as a bare enum the user has to look up.
  const unitName = resolutionUnit === 3 ? ' 點/公分' : resolutionUnit === 2 ? ' DPI' : ''
  for (const [k, v] of rows) {
    if (k === '解析度單位') continue
    out.push([k, (k === '水平解析度' || k === '垂直解析度') ? `${v}${unitName}` : v])
  }
  return out
}

/** @param {Uint8Array} b @returns {ImageMetadata} */
function parsePngMetadata(b) {
  /** @type {string[][]} */
  const fields = []
  let at = 8
  let sawIhdr = false
  while (at + 8 <= b.length) {
    const len = u32be(b, at)
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7])
    const data = at + 8
    if (len < 0 || data + len > b.length) break

    if (type === 'IHDR' && len >= 13) {
      sawIhdr = true
      fields.push(['尺寸（檔頭）', `${u32be(b, data)} × ${u32be(b, data + 4)}`])
      fields.push(['位元深度', `${b[data + 8]} 位元/通道`])
      fields.push(['色彩型別', PNG_COLOR_TYPES[b[data + 9]] ?? `未知（${b[data + 9]}）`])
      fields.push(['交錯', b[data + 12] === 1 ? 'Adam7' : '無'])
    } else if (type === 'pHYs' && len >= 9) {
      const x = u32be(b, data)
      const y = u32be(b, data + 4)
      fields.push(b[data + 8] === 1
        ? ['解析度', `${(x * 0.0254).toFixed(1)} × ${(y * 0.0254).toFixed(1)} DPI`]
        : ['像素比例', `${x} : ${y}（未指定單位，無法換算成 DPI）`])
    } else if (type === 'eXIf') {
      for (const row of parseExif(b, data)) fields.push(row)
    } else if (type === 'IDAT' || type === 'IEND') {
      break // metadata after the pixel data is legal but rare; stop scanning
    }
    at = data + len + 4
  }
  return sawIhdr
    ? { container: 'PNG', supported: true, fields }
    : { container: 'PNG', supported: true, fields, note: '檔頭不完整，無法讀取 IHDR' }
}

/** @param {Uint8Array} b @returns {ImageMetadata} */
function parseJpegMetadata(b) {
  /** @type {string[][]} */
  const fields = []
  let at = 2
  let sawSof = false
  let truncated = false
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) { truncated = true; break }
    const marker = b[at + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
    if (marker === 0xda || marker === 0xd9) break // start of scan: pixels from here
    const len = u16be(b, at + 2)
    const data = at + 4
    if (len < 2 || data + len - 2 > b.length) { truncated = true; break }

    if (marker === 0xe0 && matches(b, data, 'JFIF\0') && len >= 14) {
      const units = b[data + 7]
      const x = u16be(b, data + 8)
      const y = u16be(b, data + 10)
      fields.push(units === 1 ? ['解析度', `${x} × ${y} DPI`]
        : units === 2 ? ['解析度', `${x} × ${y} 點/公分`]
          : ['像素比例', `${x} : ${y}（未指定單位，無法換算成 DPI）`])
    } else if (marker === 0xe1 && matches(b, data, 'Exif\0')) {
      for (const row of parseExif(b, data + 6)) fields.push(row)
    } else if (marker >= 0xc0 && marker <= 0xcf
               && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && len >= 8) {
      sawSof = true
      const comps = b[data + 5]
      fields.unshift(
        ['尺寸（檔頭）', `${u16be(b, data + 3)} × ${u16be(b, data + 1)}`],
        ['取樣精度', `${b[data]} 位元/通道`],
        ['分量數', comps === 1 ? '1（灰階）' : comps === 3 ? '3（YCbCr）'
          : comps === 4 ? '4（CMYK / YCCK）' : String(comps)],
        ['編碼方式', (marker === 0xc2 || marker === 0xc6 || marker === 0xca)
          ? '漸進式' : '基線'],
      )
    }
    at = data + len - 2
  }
  const meta = { container: 'JPEG', supported: true, fields }
  if (!sawSof) {
    meta.note = truncated
      ? '檔頭不完整或超出可讀取的範圍，未找到影格標頭'
      : '未找到影格標頭'
  }
  return meta
}

/** @param {Uint8Array} b @returns {ImageMetadata} */
function parseGifMetadata(b) {
  if (b.length < 13) return { container: 'GIF', supported: true, fields: [], note: '檔頭不完整' }
  const packed = b[10]
  const hasGct = (packed & 0x80) !== 0
  return {
    container: 'GIF',
    supported: true,
    fields: [
      ['版本', String.fromCharCode(b[3], b[4], b[5])],
      ['尺寸（檔頭）', `${u16le(b, 6)} × ${u16le(b, 8)}`],
      ['色彩解析度', `${((packed >> 4) & 0x07) + 1} 位元/通道`],
      ['全域調色盤', hasGct ? `${2 ** ((packed & 0x07) + 1)} 色` : '無'],
    ],
  }
}

/** @param {Uint8Array} b @returns {ImageMetadata} */
function parseBmpMetadata(b) {
  if (b.length < 54) return { container: 'BMP', supported: true, fields: [], note: '檔頭不完整' }
  const dib = u32le(b, 14)
  /** @type {string[][]} */
  const fields = [
    ['尺寸（檔頭）', `${u32le(b, 18)} × ${Math.abs(u32le(b, 22) | 0)}`],
    ['位元深度', `${u16le(b, 28)} 位元/像素`],
    ['壓縮', u32le(b, 30) === 0 ? '無（BI_RGB）' : `代碼 ${u32le(b, 30)}`],
  ]
  if (dib >= 40) {
    const xppm = u32le(b, 38)
    const yppm = u32le(b, 42)
    fields.push(xppm > 0 && yppm > 0
      ? ['解析度', `${(xppm * 0.0254).toFixed(1)} × ${(yppm * 0.0254).toFixed(1)} DPI`]
      : ['解析度', '檔頭未記錄'])
  }
  return { container: 'BMP', supported: true, fields }
}

/** @param {Uint8Array} b @returns {ImageMetadata} */
function parseWebpMetadata(b) {
  /** @type {string[][]} */
  const fields = []
  let at = 12
  while (at + 8 <= b.length) {
    const fourcc = String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
    const len = u32le(b, at + 4)
    const data = at + 8
    if (len < 0 || data + len > b.length) break
    if (fourcc === 'VP8X' && len >= 10) {
      const flags = b[data]
      fields.push(['尺寸（檔頭）',
        `${1 + (b[data + 4] | (b[data + 5] << 8) | (b[data + 6] << 16))} × ${
          1 + (b[data + 7] | (b[data + 8] << 8) | (b[data + 9] << 16))}`])
      fields.push(['Alpha 通道', (flags & 0x10) ? '有' : '無'])
      fields.push(['動畫', (flags & 0x02) ? '有' : '無'])
    } else if (fourcc === 'VP8 ' && len >= 10) {
      fields.push(['編碼', '有損（VP8）'])
      fields.push(['尺寸（檔頭）',
        `${u16le(b, data + 6) & 0x3fff} × ${u16le(b, data + 8) & 0x3fff}`])
    } else if (fourcc === 'VP8L') {
      fields.push(['編碼', '無損（VP8L）'])
    } else if (fourcc === 'EXIF') {
      for (const row of parseExif(b, data)) fields.push(row)
    }
    at = data + len + (len % 2)
  }
  return fields.length
    ? { container: 'WebP', supported: true, fields }
    : { container: 'WebP', supported: true, fields, note: '未找到可讀取的區塊' }
}

/**
 * Read what the image file itself records about the image.
 *
 * Signature-driven, never extension-driven: a `.png` holding a JPEG is read as
 * a JPEG, and a container this cannot parse is reported as unsupported rather
 * than filled in from the decoded canvas. That distinction is the whole point
 * of the panel — dimensions are already known from the decode, so the only
 * value here is in stating what the *file* says, or admitting it cannot.
 *
 * @param {Uint8Array} bytes  leading bytes of the file
 * @param {string} [ext]  the extension it was loaded under, for the message only
 * @returns {ImageMetadata}
 */
export function parseImageMetadata(bytes, ext = '') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0)
  const label = ext ? String(ext).replace(/^\./, '').toUpperCase() : '未知'
  if (b.length < 12) {
    return { container: label, supported: false, fields: [], note: '無法讀取檔案內容' }
  }
  if (b[0] === 0x89 && matches(b, 1, 'PNG')) return parsePngMetadata(b)
  if (b[0] === 0xff && b[1] === 0xd8) return parseJpegMetadata(b)
  if (matches(b, 0, 'GIF8')) return parseGifMetadata(b)
  if (matches(b, 0, 'BM')) return parseBmpMetadata(b)
  if (matches(b, 0, 'RIFF') && matches(b, 8, 'WEBP')) return parseWebpMetadata(b)
  return {
    container: label,
    supported: false,
    fields: [],
    note: '此格式的檔頭尚未支援讀取，因此不顯示任何中繼資料',
  }
}

/**
 * Metadata rows for the info panel, including the reason there are none.
 *
 * @param {ImageMetadata|null|undefined} meta
 * @returns {string[][]}
 */
export function imageMetadataRows(meta) {
  if (!meta) return [['中繼資料', '（未載入）']]
  if (!meta.supported) return [['中繼資料', meta.note ?? '此格式不支援讀取檔頭']]
  if (meta.fields.length === 0) return [['中繼資料', meta.note ?? '檔頭中沒有可顯示的欄位']]
  return meta.note ? [...meta.fields, ['備註', meta.note]] : meta.fields
}

/**
 * @typedef {object} MetadataFieldDiff
 * @property {string} label
 * @property {string} left   '（無此欄位）' when the side does not carry it
 * @property {string} right
 */

/** Shown when one side has no such field at all, as opposed to an empty one. */
const META_ABSENT = '（無此欄位）'

/**
 * Header fields that differ between the two files.
 *
 * Only fields either side actually carries are considered — a format whose
 * header this reader cannot decode yields no diffs rather than being reported
 * as "different from" a format it can, which would be an artefact of the
 * reader, not of the files.
 *
 * @param {ImageMetadata|null|undefined} left
 * @param {ImageMetadata|null|undefined} right
 * @returns {MetadataFieldDiff[]}
 */
export function metadataFieldDiffs(left, right) {
  /** @param {ImageMetadata|null|undefined} m @returns {Map<string, string>} */
  const toMap = (m) => {
    /** @type {Map<string, string>} */
    const map = new Map()
    if (!m || !m.supported || !Array.isArray(m.fields)) return map
    for (const row of m.fields) {
      if (!Array.isArray(row) || row.length < 2) continue
      // A repeated label keeps its first value: EXIF can name the same tag in
      // both IFD0 and the Exif sub-IFD, and IFD0 is the authoritative one.
      if (!map.has(String(row[0]))) map.set(String(row[0]), String(row[1]))
    }
    return map
  }
  const l = toMap(left)
  const r = toMap(right)
  if (l.size === 0 && r.size === 0) return []

  /** @type {MetadataFieldDiff[]} */
  const out = []
  const labels = [...l.keys()]
  for (const label of r.keys()) if (!l.has(label)) labels.push(label)
  for (const label of labels) {
    const lv = l.has(label) ? /** @type {string} */ (l.get(label)) : META_ABSENT
    const rv = r.has(label) ? /** @type {string} */ (r.get(label)) : META_ABSENT
    if (lv !== rv) out.push({ label, left: lv, right: rv })
  }
  return out
}

/**
 * Metadata-difference rows for the info panel and reports.
 *
 * @param {MetadataFieldDiff[]} diffs
 * @param {boolean} enabled  whether metadata comparison is switched on
 * @returns {string[][]}
 */
export function metadataDiffRows(diffs, enabled) {
  if (!enabled) return [['中繼資料比對', '關閉（中繼資料僅顯示，不計入比對結果）']]
  if (!diffs || diffs.length === 0) return [['中繼資料比對', '開啟：兩側中繼資料相同']]
  return diffs.map((d) => [d.label, `左：${d.left}　右：${d.right}`])
}

/**
 * @typedef {object} ImageSideInfo
 * @property {string} path
 * @property {string} format     file extension as loaded
 * @property {number|null} bytes file size, null when unknown
 * @property {number} width
 * @property {number} height
 * @property {'rgba'|'rgb'|'unknown'} depth  see {@link imageInfoRows}
 * @property {ImageMetadata|null} [meta]  what the file header says, if readable
 */

/**
 * Label/value rows for one side, as data.
 *
 * `depth` is derived from the *decoded* pixels, never from the file header:
 * canvas hands back 8-bit RGBA whatever the source was, so the only honest
 * statement is whether any pixel is actually translucent.
 *
 * @param {ImageSideInfo|null} side
 * @returns {string[][]}
 */
export function imageInfoRows(side) {
  if (!side) return [['狀態', '（未載入）']]
  const depth = side.depth === 'rgba' ? '32 位元 RGBA（有透明像素）'
    : side.depth === 'rgb' ? '24 位元 RGB（解碼後無透明像素）'
      : '未知（無法讀取像素）'
  return [
    ['路徑', side.path || '（未知）'],
    ['格式', side.format ? side.format.toUpperCase() : '（未知）'],
    ['檔案大小', formatBytes(side.bytes)],
    ['尺寸', `${side.width} × ${side.height}`],
    ['總像素', (side.width * side.height).toLocaleString()],
    ['色彩深度', depth],
  ]
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Self-contained HTML image comparison report.
 *
 * Images are passed in as data URLs rather than read from the canvases here so
 * the markup can be tested without a real canvas implementation; a side whose
 * URL is empty is reported as unavailable rather than rendered as a broken
 * image.
 *
 * @param {ImageReportInfo} info
 * @param {{ left?: string, right?: string, diff?: string }} [images]
 * @param {{ generatedAt?: Date }} [opts]
 * @returns {string}
 */
export function buildImageHtmlReport(info, images = {}, opts = {}) {
  const when = (opts.generatedAt ?? new Date()).toISOString().replace('T', ' ').slice(0, 19)
  const summary = (info.diffCount === null || info.totalPixels === null)
    ? '尚未載入兩張圖片，無法計算差異'
    : formatDiffStats(info.diffCount, info.totalPixels, info.approximate)

  const pane = (label, url) => `<figure class="pane">
  <figcaption>${escapeHtml(label)}</figcaption>
  ${url
    ? `<img alt="${escapeHtml(label)}" src="${escapeHtml(url)}" />`
    : '<p class="missing">（無法擷取影像）</p>'}
</figure>`

  const toRows = (pairs) => pairs
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('\n')
  const rows = toRows(imageReportParameters(info))
  const metaTable = (label, m) => `<h3>${escapeHtml(label)}檔頭中繼資料</h3>
<table><thead><tr><th>項目</th><th>值</th></tr></thead><tbody>
${toRows(imageMetadataRows(m))}
</tbody></table>`

  return `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="utf-8">
<title>圖片比對報告</title>
<style>
body{font-family:system-ui,"Microsoft JhengHei",sans-serif;margin:16px;color:#222;background:#fff}
h2{margin:0 0 8px}
.paths{font-size:12px;color:#555;margin-bottom:8px;word-break:break-all}
.summary{font-size:13px;margin-bottom:12px}
.panes{display:flex;gap:12px;flex-wrap:wrap}
.pane{margin:0;flex:1 1 280px}
.pane figcaption{font-size:12px;color:#555;margin-bottom:4px}
.pane img{max-width:100%;border:1px solid #ccc;background:#fff}
.missing{font-size:12px;color:#a00}
table{border-collapse:collapse;margin-top:14px}
th,td{border:1px solid #ddd;padding:3px 8px;font-size:12px;text-align:left}
@media print{body{margin:8mm}.no-print{display:none !important}}
</style>
</head><body>
<h2>圖片比對報告</h2>
<div class="paths">左：${escapeHtml(info.leftPath || '（未知）')} &nbsp;|&nbsp; 右：${escapeHtml(info.rightPath || '（未知）')}</div>
<div class="summary">${escapeHtml(summary)}　生成時間：${escapeHtml(when)}</div>
<div class="panes">
${pane('左側', images.left ?? '')}
${pane('右側', images.right ?? '')}
${pane('差異', images.diff ?? '')}
</div>
<table><thead><tr><th>項目</th><th>值</th></tr></thead><tbody>
${rows}
</tbody></table>
${metaTable('左側', info.leftMeta)}
${metaTable('右側', info.rightMeta)}
<h3>中繼資料差異</h3>
<table><thead><tr><th>項目</th><th>值</th></tr></thead><tbody>
${toRows(metadataDiffRows(info.metadataDiffs ?? [], !!info.compareMetadata))}
</tbody></table>
</body></html>`
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
 * @property {() => { x: number, y: number }} getPan
 * @property {(x: number, y: number) => void} setPan
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
    getPan() { return { x: panX, y: panY } },
    setPan(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      panX = x
      panY = y
      applyTransform()
    },
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
     * How strongly the difference layer is mixed into the difference pane,
     * 0 = not at all, 1 = fully. Beyond Compare exposes the blend as a
     * percentage rather than only on/off, so a faint difference can be dialled
     * up and a loud one dialled back without switching modes.
     * @type {number}
     */
    this._blendRatio = 1

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
    /** @type {ImageDiffRegion[]} tile-grid regions used by F7/F8 navigation */
    this._diffRegions = []
    /** @type {number} -1 = no region selected yet */
    this._currentDiffIdx = -1
    /** @type {boolean} set by setLeft/setRight, consumed after the next diff */
    this._pendingFirstDiff = false

    /**
     * Last computed statistics, kept so a report states the same numbers the
     * status bar shows rather than re-running the diff to find out.
     * @type {{ diffCount: number|null, totalPixels: number|null, approximate: boolean,
     *          unimportant: number }}
     */
    this._stats = { diffCount: null, totalPixels: null, approximate: false, unimportant: 0 }

    /** @type {(() => void) | null} removes the drag/drop listeners on destroy */
    this._dropCleanup = null

    /**
     * S16: user-selectable highlight colour — a HIGHLIGHT_COLORS key or, when
     * the custom swatch is in use, a `#rrggbb` literal.
     * @type {string}
     */
    this._highlightColor = DEFAULT_HIGHLIGHT_COLOR

    /**
     * Last colour the custom swatch held, kept separately so switching to a
     * named colour and back does not lose the user's pick.
     * @type {string}
     */
    this._customHighlight = DEFAULT_CUSTOM_HIGHLIGHT

    /**
     * BC's View > Compare Metadata: when on, header metadata differences count
     * as part of the comparison result rather than being display-only.
     * @type {boolean}
     */
    this._compareMetadata = false

    /** @type {MetadataFieldDiff[]} result of the last metadata comparison */
    this._metaDiffs = []

    /**
     * BC Session Settings > Replacements: colours declared equivalent, so a
     * palette shift is not reported as a difference on every pixel.
     * @type {ReplacementRule[]}
     */
    this._replacements = []

    /** Whether the replacement rules are applied at all. @type {boolean} */
    this._ignoreUnimportant = true

    /**
     * BC's difference offset: how far the right image is displaced relative to
     * the left before the pixel diff. Two screenshots that differ only by a
     * few pixels of scroll otherwise compare as entirely different.
     * @type {{ x: number, y: number }}
     */
    this._diffOffset = { x: 0, y: 0 }

    /**
     * Panel layout, matching the other views' Side-by-side / Over-under toggle.
     * @type {'side'|'over'}
     */
    this._layout = 'side'

    /** Whether the difference-region list is on screen. */
    this._showRegionList = false

    /** Whether the image info panel is on screen. */
    this._showInfoPanel = false

    /**
     * Mounted flag for keyboard shortcut guard.
     * @type {boolean}
     */
    this._mounted = false

    // 圖片資料
    /** @typedef {{ path: string, ext: string, img: HTMLImageElement, bytes: number, depth: 'rgba'|'rgb'|'unknown'|null, meta: ImageMetadata|null }} LoadedImage */
    /** @type {LoadedImage | null} */
    this._left = null
    /** @type {LoadedImage | null} */
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

  /**
   * Snapshot of the view's comparison settings, for the named-config store.
   * @returns {object}
   */
  getConfig() {
    return tagConfig('image', {
      threshold: this._threshold,
      algorithm: this._algorithm,
      blendMode: this._blendMode,
      blendRatio: this._blendRatio,
      autoScale: this._autoScale,
      mismatchRange: this._mismatchRange,
      highlightColor: this._highlightColor,
      customHighlight: this._customHighlight,
      compareMetadata: this._compareMetadata,
      replacements: this._replacements.map((r) => ({ from: r.from, to: r.to })),
      ignoreUnimportant: this._ignoreUnimportant,
      offsetX: this._diffOffset.x,
      offsetY: this._diffOffset.y,
      layout: this._layout,
    })
  }

  /**
   * @param {unknown} cfg
   */
  applyConfig(cfg) {
    const s = readConfig('image', cfg)
    if (!s) return
    if (typeof s.threshold === 'number' && s.threshold >= 0 && s.threshold <= 1) {
      this._threshold = s.threshold
    }
    if (['exact', 'tolerance', 'grayscale'].includes(s.algorithm)) this._algorithm = s.algorithm
    if (['normal', 'difference', 'blend'].includes(s.blendMode)) this._blendMode = s.blendMode
    if (typeof s.blendRatio === 'number' && s.blendRatio >= 0 && s.blendRatio <= 1) {
      this._blendRatio = s.blendRatio
    }
    if (typeof s.autoScale === 'boolean') this._autoScale = s.autoScale
    if (typeof s.mismatchRange === 'boolean') this._mismatchRange = s.mismatchRange
    if (typeof s.highlightColor === 'string'
        && (Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLORS, s.highlightColor)
            || normalizeHexColor(s.highlightColor))) {
      this._highlightColor = normalizeHexColor(s.highlightColor) ?? s.highlightColor
    }
    const custom = normalizeHexColor(s.customHighlight)
    if (custom) this._customHighlight = custom
    if (typeof s.compareMetadata === 'boolean') this._compareMetadata = s.compareMetadata
    if (Array.isArray(s.replacements)) this._replacements = normalizeReplacements(s.replacements)
    if (typeof s.ignoreUnimportant === 'boolean') this._ignoreUnimportant = s.ignoreUnimportant
    if (Number.isFinite(s.offsetX)) this._diffOffset.x = Math.trunc(s.offsetX)
    if (Number.isFinite(s.offsetY)) this._diffOffset.y = Math.trunc(s.offsetY)
    if (s.layout === 'side' || s.layout === 'over') this._layout = s.layout
    this._syncConfigControls()
    this.refresh()
  }

  /** Reflect the applied settings back onto the toolbar controls. */
  _syncConfigControls() {
    const dom = this._dom
    if (dom.autoScaleCheck) dom.autoScaleCheck.checked = this._autoScale
    if (dom.mismatchRangeCheck) dom.mismatchRangeCheck.checked = this._mismatchRange
    if (dom.overlaySelect) dom.overlaySelect.value = this._blendMode
    if (dom.blendRatioSlider) dom.blendRatioSlider.value = String(this._blendRatio)
    this._updateBlendRatioLabel()
    this._syncHighlightControls()
    if (dom.compareMetaCheck) dom.compareMetaCheck.checked = this._compareMetadata
    if (dom.ignoreUnimportantCheck) dom.ignoreUnimportantCheck.checked = this._ignoreUnimportant
    if (dom.offsetXInput) dom.offsetXInput.value = String(this._diffOffset.x)
    if (dom.offsetYInput) dom.offsetYInput.value = String(this._diffOffset.y)
    if (dom.thresholdSlider) dom.thresholdSlider.value = String(this._threshold)
    if (dom.thresholdVal) dom.thresholdVal.textContent = this._threshold.toFixed(2)
    this._updateReplacementsButton()
    this._updateLegend()
    this._applyLayout()
  }

  /** Keep the named-colour select and the custom swatch consistent. */
  _syncHighlightControls() {
    const sel = /** @type {HTMLSelectElement | undefined} */ (this._dom.highlightSelect)
    const swatch = /** @type {HTMLInputElement | undefined} */ (this._dom.highlightSwatch)
    const isNamed = Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLORS, this._highlightColor)
    if (sel) sel.value = isNamed ? this._highlightColor : 'custom'
    if (swatch) {
      swatch.value = isNamed ? this._customHighlight : this._highlightColor
      // Disabled rather than hidden: a control that vanishes reads as a bug,
      // and the greyed swatch still shows which colour custom mode would use.
      swatch.disabled = isNamed
    }
  }

  // ── Public: layout ──────────────────────────────────────────────────────────

  /**
   * Side-by-side ↔ over-under, matching the toggle every other view has.
   * @param {'side'|'over'} mode
   * @returns {'side'|'over'}
   */
  setLayout(mode) {
    if (mode !== 'side' && mode !== 'over') return this._layout
    this._layout = mode
    this._applyLayout()
    return this._layout
  }

  /** @returns {'side'|'over'} */
  getLayout() {
    return this._layout
  }

  /** @returns {'side'|'over'} the layout now in force */
  toggleLayout() {
    return this.setLayout(this._layout === 'side' ? 'over' : 'side')
  }

  /** Push the layout onto the body element and the button label. */
  _applyLayout() {
    const body = /** @type {HTMLElement | undefined} */ (this._dom.body)
    body?.classList.toggle('ic-body--over', this._layout === 'over')
    const btn = /** @type {HTMLElement | undefined} */ (this._dom.btnLayout)
    if (btn) {
      btn.textContent = this._layout === 'over' ? '⊟ 上下' : '⬛ 並排'
      btn.title = this._layout === 'over' ? '切換為並排' : '切換為上下堆疊'
    }
  }

  // ── Public: difference navigation ───────────────────────────────────────────

  /** @returns {ImageDiffRegion[]} 目前的差異區塊（tile 網格） */
  getDiffRegions() {
    return this._diffRegions
  }

  // ── Public: difference region list ──────────────────────────────────────────

  /**
   * @param {boolean} [on] omit to toggle
   * @returns {boolean} whether the list is now visible
   */
  toggleRegionList(on) {
    this._showRegionList = on == null ? !this._showRegionList : !!on
    this._renderRegionList()
    return this._showRegionList
  }

  /** @returns {boolean} */
  isRegionListVisible() {
    return this._showRegionList
  }

  // ── Public: image info panel ────────────────────────────────────────────────

  /**
   * @param {boolean} [on] omit to toggle
   * @returns {boolean} whether the panel is now visible
   */
  toggleInfoPanel(on) {
    this._showInfoPanel = on == null ? !this._showInfoPanel : !!on
    this._renderInfoPanel()
    return this._showInfoPanel
  }

  /** @returns {boolean} */
  isInfoPanelVisible() {
    return this._showInfoPanel
  }

  /**
   * Everything the info panel says about one side.
   *
   * @param {'left'|'right'} which
   * @returns {ImageSideInfo|null} null when that side has no image
   */
  getSideInfo(which) {
    const side = which === 'left' ? this._left : this._right
    if (!side) return null
    return {
      path: side.path,
      format: side.ext ?? '',
      bytes: Number.isFinite(side.bytes) ? side.bytes : null,
      width: side.img?.naturalWidth ?? 0,
      height: side.img?.naturalHeight ?? 0,
      depth: side.depth ?? this._detectDepth(which),
      meta: side.meta ?? null,
    }
  }

  /**
   * Whether any pixel on one side is translucent.
   *
   * Read from the drawn canvas in horizontal strips: a single getImageData over
   * a large photo allocates the whole RGBA buffer at once. Cached on the side,
   * because it is only ever asked for when the info panel is open.
   *
   * @param {'left'|'right'} which
   * @returns {'rgba'|'rgb'|'unknown'}
   */
  _detectDepth(which) {
    const side = which === 'left' ? this._left : this._right
    const canvas = /** @type {HTMLCanvasElement | undefined} */ (
      which === 'left' ? this._dom.canvasLeft : this._dom.canvasRight)
    const ctx = which === 'left' ? this._leftCtx : this._rightCtx
    if (!side || !canvas || !ctx || !(canvas.width > 0) || !(canvas.height > 0)) return 'unknown'

    const STRIP_ROWS = 256
    try {
      for (let y = 0; y < canvas.height; y += STRIP_ROWS) {
        const h = Math.min(STRIP_ROWS, canvas.height - y)
        const { data } = ctx.getImageData(0, y, canvas.width, h)
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] !== 255) { side.depth = 'rgba'; return 'rgba' }
        }
      }
    } catch (err) {
      // A tainted or unimplemented canvas (jsdom) cannot answer this.
      console.error('[image-compare] depth detection failed:', err)
      side.depth = 'unknown'
      return 'unknown'
    }
    side.depth = 'rgb'
    return 'rgb'
  }

  /** @returns {number} 目前選取的差異索引；-1 表示尚未選取 */
  getCurrentDiffIndex() {
    return this._currentDiffIdx
  }

  /** 下一個差異區塊（是否環繞依 Next Difference 設定）。 @returns {NavResult} */
  nextDifference() { return this._stepDiff(1) }

  /** 上一個差異區塊（是否環繞依 Next Difference 設定）。 @returns {NavResult} */
  prevDifference() { return this._stepDiff(-1) }

  /** @returns {NavResult} */
  firstDifference() { return this._jumpDiff(0) }

  /** @returns {NavResult} */
  lastDifference() { return this._jumpDiff(this._diffRegions.length - 1) }

  /**
   * @param {number} delta
   * @returns {NavResult}
   */
  _stepDiff(delta) {
    const from = this._currentDiffIdx
    const to = stepDiffIndex(from, this._diffRegions.length, delta)
    return this._jumpDiff(to)
  }

  /**
   * @param {number} target
   * @returns {NavResult}
   */
  _jumpDiff(target) {
    const total = this._diffRegions.length
    const from = this._currentDiffIdx
    if (total === 0 || target < 0) return navResult(from, -1, total)
    this._currentDiffIdx = target
    this._centreOnRegion(this._diffRegions[target])
    // Keyboard navigation and the list are two views of one cursor.
    this._markCurrentRegion()
    return navResult(from, target, total)
  }

  /**
   * Pan so a diff region sits in the middle of the viewport.
   *
   * Rotation and flip are deliberately ignored: honouring them would need the
   * full inverse transform for a convenience scroll, and the region stays on
   * screen either way at the zoom levels this is used at.
   *
   * @param {ImageDiffRegion | undefined} region
   */
  _centreOnRegion(region) {
    const st = this._syncTransform
    if (!st || !region || typeof st.setPan !== 'function') return
    const canvas = this._dom.canvasDiff
    const host = canvas?.parentElement?.parentElement
    // Natural pixels → CSS pixels; jsdom reports 0, in which case 1:1 is right.
    const displayScale = canvas?.width ? (canvas.clientWidth || canvas.width) / canvas.width : 1
    const zoom = st.getZoom() || 1
    const viewW = host?.clientWidth ?? 0
    const viewH = host?.clientHeight ?? 0
    const cx = (region.x + region.w / 2) * displayScale
    const cy = (region.y + region.h / 2) * displayScale
    st.setPan(viewW / (2 * zoom) - cx, viewH / (2 * zoom) - cy)
  }

  /** 銷毀元件，清除 DOM 與事件 */
  destroy() {
    this._mounted = false
    this._unbindKeyboardShortcuts()
    this._magCleanup?.()
    this._magCleanup = null
    this._dropCleanup?.()
    this._dropCleanup = null
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
    this._updateBlendRatioLabel()
  }

  /**
   * Set the blend percentage of the difference layer.
   *
   * @param {number} ratio  0–1; values outside are clamped rather than refused,
   *   because the slider is the only producer and clamping is what it means
   * @returns {number} the ratio now in effect
   */
  setBlendRatio(ratio) {
    const n = Number(ratio)
    if (!Number.isFinite(n)) return this._blendRatio
    this._blendRatio = Math.min(1, Math.max(0, n))
    const slider = /** @type {HTMLInputElement | undefined} */ (this._dom.blendRatioSlider)
    if (slider && slider.value !== String(this._blendRatio)) {
      slider.value = String(this._blendRatio)
    }
    this._toggleDiffOverlay()
    this._updateBlendRatioLabel()
    return this._blendRatio
  }

  /** @returns {number} */
  getBlendRatio() {
    return this._blendRatio
  }

  /** Keep the percentage readout and the slider's enabled state in step. */
  _updateBlendRatioLabel() {
    const label = this._dom.blendRatioVal
    if (label) label.textContent = `${Math.round(this._blendRatio * 100)}%`
    const slider = /** @type {HTMLInputElement | undefined} */ (this._dom.blendRatioSlider)
    // With no overlay on screen there is nothing to blend, so the control says
    // so instead of moving and appearing to do nothing.
    if (slider) slider.disabled = this._blendMode === 'normal'
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
   * @param {string} key - HIGHLIGHT_COLORS 的鍵，或 `#rrggbb` 自訂色；
   *   兩者皆不符時視為 no-op
   * @returns {string} 目前生效的標示色
   */
  setHighlightColor(key) {
    const named = Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLORS, key)
    const hex = named ? null : normalizeHexColor(key)
    if (!named && !hex) return this._highlightColor
    const next = named ? String(key) : /** @type {string} */ (hex)
    if (hex) this._customHighlight = hex
    if (next === this._highlightColor) {
      this._syncHighlightControls()
      return this._highlightColor
    }
    this._highlightColor = next
    this._syncHighlightControls()
    this._updateLegend()
    void this._runDiff()
    return this._highlightColor
  }

  /** @returns {string} */
  getHighlightColor() {
    return this._highlightColor
  }

  /** @returns {string} the `#rrggbb` the custom swatch currently holds */
  getCustomHighlight() {
    return this._customHighlight
  }

  // ── Public API: Blend toggle ────────────────────────────────────────────────

  /**
   * BC's Blend Toggle — one key steps through the overlay modes, because
   * flicking between them per image pair is the common case and opening a
   * drop-down each time is not.
   *
   * @returns {'normal'|'difference'|'blend'} the mode now in force
   */
  cycleBlendMode() {
    /** @type {Array<'normal'|'difference'|'blend'>} */
    const order = ['normal', 'difference', 'blend']
    const idx = order.indexOf(this._blendMode)
    this.setBlendMode(order[(idx + 1) % order.length])
    return this._blendMode
  }

  // ── Public API: Compare Metadata ────────────────────────────────────────────

  /**
   * BC's View > Compare Metadata.
   * @param {boolean} on
   * @returns {boolean}
   */
  setCompareMetadata(on) {
    const next = !!on
    if (next !== this._compareMetadata) {
      this._compareMetadata = next
      const box = /** @type {HTMLInputElement | undefined} */ (this._dom.compareMetaCheck)
      if (box && box.checked !== next) box.checked = next
      this._refreshMetadataDiffs()
      this._updateStats(
        this._stats.diffCount, this._stats.totalPixels,
        this._stats.approximate, this._stats.unimportant)
      this._renderInfoPanel()
    }
    return this._compareMetadata
  }

  /** @returns {boolean} */
  getCompareMetadata() {
    return this._compareMetadata
  }

  /** @returns {MetadataFieldDiff[]} differing header fields from the last compare */
  getMetadataDiffs() {
    return this._metaDiffs.slice()
  }

  /** Recompute the metadata comparison from the loaded files. */
  _refreshMetadataDiffs() {
    this._metaDiffs = this._compareMetadata
      ? metadataFieldDiffs(this._left?.meta ?? null, this._right?.meta ?? null)
      : []
  }

  // ── Public API: Replacements ────────────────────────────────────────────────

  /**
   * Replace the whole rule list. Invalid entries are dropped rather than
   * silently treated as a colour, and the caller is told how many survived.
   *
   * @param {ReplacementRule[]} rules
   * @returns {ReplacementRule[]} the rules now in force
   */
  setReplacements(rules) {
    this._replacements = normalizeReplacements(rules)
    this._updateReplacementsButton()
    this._renderReplacementRows()
    void this._runDiff()
    return this.getReplacements()
  }

  /** @returns {ReplacementRule[]} */
  getReplacements() {
    return this._replacements.map((r) => ({ from: r.from, to: r.to }))
  }

  /**
   * @param {string} from
   * @param {string} to
   * @returns {boolean} false when the colours are unusable or the list is full
   */
  addReplacement(from, to) {
    if (this._replacements.length >= MAX_REPLACEMENT_RULES) {
      this._emit('status', {
        message: `取代規則已達上限 ${MAX_REPLACEMENT_RULES} 條`, level: 'warn',
      })
      return false
    }
    const f = normalizeHexColor(from)
    const t = normalizeHexColor(to)
    if (!f || !t) {
      this._emit('status', { message: '取代規則需要兩個有效的色碼', level: 'warn' })
      return false
    }
    this._replacements.push({ from: f, to: t })
    this._updateReplacementsButton()
    this._renderReplacementRows()
    void this._runDiff()
    return true
  }

  /**
   * @param {number} index
   * @returns {boolean} false when there is no such rule
   */
  removeReplacement(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this._replacements.length) return false
    this._replacements.splice(index, 1)
    this._updateReplacementsButton()
    this._renderReplacementRows()
    void this._runDiff()
    return true
  }

  /**
   * BC's View > Ignore Unimportant Differences: gates whether the replacement
   * rules are applied at all.
   * @param {boolean} on
   * @returns {boolean}
   */
  setIgnoreUnimportant(on) {
    const next = !!on
    if (next === this._ignoreUnimportant) return this._ignoreUnimportant
    this._ignoreUnimportant = next
    const box = /** @type {HTMLInputElement | undefined} */ (this._dom.ignoreUnimportantCheck)
    if (box && box.checked !== next) box.checked = next
    void this._runDiff()
    return this._ignoreUnimportant
  }

  /** @returns {boolean} */
  getIgnoreUnimportant() {
    return this._ignoreUnimportant
  }

  /** The rule map the diff actually uses, or null when nothing applies. */
  _activeReplacementMap() {
    if (!this._ignoreUnimportant) return null
    return buildReplacementMap(this._replacements)
  }

  // ── Public API: Difference offset ───────────────────────────────────────────

  /**
   * Displace the right image relative to the left before the pixel diff.
   *
   * @param {number} x
   * @param {number} y
   * @returns {{ x: number, y: number }} the offset now in force
   */
  setDiffOffset(x, y) {
    const nx = Number.isFinite(x) ? Math.trunc(x) : this._diffOffset.x
    const ny = Number.isFinite(y) ? Math.trunc(y) : this._diffOffset.y
    if (nx === this._diffOffset.x && ny === this._diffOffset.y) return this.getDiffOffset()
    this._diffOffset = { x: nx, y: ny }
    const xi = /** @type {HTMLInputElement | undefined} */ (this._dom.offsetXInput)
    const yi = /** @type {HTMLInputElement | undefined} */ (this._dom.offsetYInput)
    if (xi && xi.value !== String(nx)) xi.value = String(nx)
    if (yi && yi.value !== String(ny)) yi.value = String(ny)
    void this._runDiff()
    return this.getDiffOffset()
  }

  /** @returns {{ x: number, y: number }} */
  getDiffOffset() {
    return { x: this._diffOffset.x, y: this._diffOffset.y }
  }

  /** BC's Reset Difference Offset — realign the two images' top-left corners. */
  resetDiffOffset() {
    return this.setDiffOffset(0, 0)
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
    // and it can double image memory for large files. Its length is the only
    // record of the file size, so it is measured before being dropped.
    this._left = {
      path, ext, img,
      bytes: base64ByteLength(base64),
      depth: null,
      meta: parseImageMetadata(base64HeadBytes(base64), ext),
    }
    this._pendingFirstDiff = true
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
    this._right = {
      path, ext, img,
      bytes: base64ByteLength(base64),
      depth: null,
      meta: parseImageMetadata(base64HeadBytes(base64), ext),
    }
    this._pendingFirstDiff = true
    this._drawImage('right', img)
    this._updatePathDisplay('right', path, img.naturalWidth, img.naturalHeight)
    this._emit('paths-changed', {
      left: this._left?.path ?? '',
      right: path,
    })
    await this._runDiff()
  }

  /**
   * Blank one pane's canvas and path label.
   *
   * Only reachable from swap() with an odd number of images loaded; without it
   * the canvas keeps showing the image that has just moved to the other pane.
   *
   * @param {'left'|'right'} which
   */
  _clearSide(which) {
    const canvas = /** @type {HTMLCanvasElement | undefined} */ (
      which === 'left' ? this._dom.canvasLeft : this._dom.canvasRight)
    const ctx = which === 'left' ? this._leftCtx : this._rightCtx
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      canvas.width = 0
      canvas.height = 0
    }
    this._updatePathDisplay(which, '', 0, 0)
  }

  /**
   * Exchange the two images.
   *
   * The decoded images are swapped directly rather than re-read from disk:
   * the base64 is dropped after decode, so re-reading would mean two more IPC
   * round trips and a second decode to reach a state already in memory. It
   * also means swapping works for an image that arrived by drop and has no
   * re-readable path.
   *
   * @returns {Promise<void>}
   */
  async swap() {
    if (!this._left && !this._right) {
      this._emit('status', { message: '沒有可交換的圖片', level: 'warn' })
      return
    }
    const left = this._left
    const right = this._right
    this._left = right
    this._right = left

    // A side that is now empty has to be cleared, or the canvas keeps painting
    // the image that moved to the other pane.
    for (const side of /** @type {const} */ (['left', 'right'])) {
      const loaded = side === 'left' ? this._left : this._right
      if (loaded) {
        this._drawImage(side, loaded.img)
        this._updatePathDisplay(
          side, loaded.path, loaded.img.naturalWidth, loaded.img.naturalHeight)
      } else {
        this._clearSide(side)
      }
    }

    this._pendingFirstDiff = true
    this._emit('paths-changed', {
      left: this._left?.path ?? '',
      right: this._right?.path ?? '',
    })
    await this._runDiff()
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  /**
   * Current state in the shape the report builders take.
   * @returns {ImageReportInfo}
   */
  getReportInfo() {
    const dim = (side) => (side?.img
      ? { w: side.img.naturalWidth, h: side.img.naturalHeight }
      : null)
    return {
      leftPath: this._left?.path ?? '',
      rightPath: this._right?.path ?? '',
      leftSize: dim(this._left),
      rightSize: dim(this._right),
      diffCount: this._stats.diffCount,
      totalPixels: this._stats.totalPixels,
      approximate: this._stats.approximate,
      regionCount: this._diffRegions.length,
      threshold: this._threshold,
      algorithm: this._algorithm,
      autoScale: this._autoScale,
      mismatchRange: this._mismatchRange,
      blendMode: this._blendMode,
      blendRatio: this._blendRatio,
      highlightColor: this._highlightColor,
      leftMeta: this._left?.meta ?? null,
      rightMeta: this._right?.meta ?? null,
      compareMetadata: this._compareMetadata,
      metadataDiffs: this.getMetadataDiffs(),
      replacements: this.getReplacements(),
      ignoreUnimportant: this._ignoreUnimportant,
      unimportantCount: this._stats.unimportant,
      diffOffset: this.getDiffOffset(),
    }
  }

  /**
   * @param {{ generatedAt?: Date }} [opts]
   * @returns {string}
   */
  buildTextReport(opts = {}) {
    return buildImageTextReport(this.getReportInfo(), opts)
  }

  /**
   * @param {{ generatedAt?: Date }} [opts]
   * @returns {string}
   */
  buildHtmlReport(opts = {}) {
    return buildImageHtmlReport(this.getReportInfo(), this._snapshotCanvases(), opts)
  }

  /**
   * Data URLs for the three canvases.
   *
   * The decoded base64 is dropped after load to save memory, so the canvas is
   * the only remaining copy of the pixels. A canvas that cannot be serialised
   * yields '' and the report says the image was unavailable — better than an
   * exception that loses the whole report.
   *
   * @returns {{ left: string, right: string, diff: string }}
   */
  _snapshotCanvases() {
    const grab = (canvas) => {
      if (!canvas || typeof canvas.toDataURL !== 'function' || !(canvas.width > 0)) return ''
      try {
        return canvas.toDataURL('image/png')
      } catch (err) {
        console.error('[image-compare] canvas snapshot failed:', err)
        return ''
      }
    }
    return {
      left: grab(this._dom.canvasLeft),
      right: grab(this._dom.canvasRight),
      diff: grab(this._dom.canvasDiff),
    }
  }

  /**
   * Save the HTML report, or open it for printing.
   * @param {{ print?: boolean }} [opts]
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
          try { win.print() } catch { /* the user dismissed the print dialog */ }
        })
        return
      }
      // Pop-up blocked: saving still gets the user their report.
    }
    await window.electronAPI.saveFile(
      'image-report.html',
      html,
      [{ name: 'HTML', extensions: ['html'] }, { name: '所有檔案', extensions: ['*'] }])
  }

  /**
   * Save the plain-text report.
   * @returns {Promise<void>}
   */
  async exportTextReport() {
    await window.electronAPI.saveFile(
      'image-report.txt',
      this.buildTextReport(),
      [{ name: '純文字', extensions: ['txt'] }, { name: '所有檔案', extensions: ['*'] }])
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
    root.appendChild(this._buildInfoPanel())
    root.appendChild(this._buildReplacementsDialog())
    root.appendChild(this._buildBody())
    root.appendChild(this._buildRegionList())
    root.appendChild(this._buildStats())

    this._container.appendChild(root)
    this._dom.root = root
    this._updateReplacementsButton()

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

    toolbar.appendChild(el('span', { className: 'ic-toolbar-sep' }))
    const btnSwap = el('button', {
      className: 'ic-btn ic-btn-swap',
      textContent: '⇄ 交換',
      title: '交換左右兩側',
    })
    btnSwap.addEventListener('click', () => { void this.swap() })
    this._dom.btnSwap = btnSwap
    toolbar.appendChild(btnSwap)

    // Separator
    toolbar.appendChild(el('span', { className: 'ic-toolbar-sep' }))

    // T59: Blend Mode 3-way selector (replaces overlay checkbox)
    const blendLabel = el('label', { className: 'ic-toolbar-label', textContent: '疊加模式：' })
    toolbar.appendChild(blendLabel)
    const overlaySelect = /** @type {HTMLSelectElement} */ (el('select', {
      className: 'ic-toolbar-select ic-overlay-select',
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

    // BC's Blend Toggle: stepping the mode without opening the drop-down.
    const btnBlendToggle = el('button', {
      className: 'ic-btn-refresh ic-btn-blend-toggle',
      title: '循環切換疊加模式：無 → 差異 → 混合 (Ctrl+B)',
      textContent: '⇋',
    })
    this._dom.btnBlendToggle = btnBlendToggle
    toolbar.appendChild(btnBlendToggle)

    // Blend percentage — BC's blend is a slider, not a switch.
    toolbar.appendChild(el('label', { className: 'ic-toolbar-label', textContent: '混合比例：' }))
    const blendRatioSlider = /** @type {HTMLInputElement} */ (el('input', {
      type: 'range',
      className: 'ic-blend-slider',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(this._blendRatio),
      title: '差異疊加層混合的百分比',
    }))
    blendRatioSlider.disabled = this._blendMode === 'normal'
    this._dom.blendRatioSlider = blendRatioSlider
    toolbar.appendChild(blendRatioSlider)
    const blendRatioVal = el('span', {
      className: 'ic-blend-value',
      textContent: `${Math.round(this._blendRatio * 100)}%`,
    })
    this._dom.blendRatioVal = blendRatioVal
    toolbar.appendChild(blendRatioVal)

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
      // Shares the appearance class, not the identifying one: carrying
      // ic-overlay-select here made every selector for the blend-mode control
      // match two elements.
      className: 'ic-toolbar-select ic-highlight-select',
      title: '差異像素的高亮顏色',
    }))
    for (const [key, entry] of Object.entries(HIGHLIGHT_COLORS)) {
      const opt = document.createElement('option')
      opt.value = key
      opt.textContent = entry.label
      highlightSelect.appendChild(opt)
    }
    const customOpt = document.createElement('option')
    customOpt.value = 'custom'
    customOpt.textContent = '自訂…'
    highlightSelect.appendChild(customOpt)
    this._dom.highlightSelect = highlightSelect
    toolbar.appendChild(highlightSelect)

    const highlightSwatch = /** @type {HTMLInputElement} */ (el('input', {
      type: 'color',
      className: 'ic-highlight-swatch',
      title: '自訂差異標示色（先在左側下拉選「自訂…」）',
    }))
    this._dom.highlightSwatch = highlightSwatch
    toolbar.appendChild(highlightSwatch)
    this._syncHighlightControls()

    // Separator
    toolbar.appendChild(el('span', { className: 'ic-toolbar-sep' }))

    // BC View > Compare Metadata
    const compareMetaCheck = /** @type {HTMLInputElement} */ (el('input', {
      type: 'checkbox',
      className: 'ic-toolbar-check ic-compare-meta-check',
      id: 'ic-compare-meta',
      title: '把檔頭中繼資料（EXIF 等）的差異一併計入比對結果，而非僅顯示',
    }))
    compareMetaCheck.checked = this._compareMetadata
    this._dom.compareMetaCheck = compareMetaCheck
    toolbar.appendChild(compareMetaCheck)
    toolbar.appendChild(el('label', {
      className: 'ic-toolbar-label', for: 'ic-compare-meta', textContent: '比對中繼資料',
    }))

    // BC View > Ignore Unimportant Differences (gates the replacement rules)
    const ignoreUnimportantCheck = /** @type {HTMLInputElement} */ (el('input', {
      type: 'checkbox',
      className: 'ic-toolbar-check ic-ignore-unimportant-check',
      id: 'ic-ignore-unimportant',
      title: '套用取代規則：符合規則的色彩差異標為藍色，且不計入差異像素數',
    }))
    ignoreUnimportantCheck.checked = this._ignoreUnimportant
    this._dom.ignoreUnimportantCheck = ignoreUnimportantCheck
    toolbar.appendChild(ignoreUnimportantCheck)
    toolbar.appendChild(el('label', {
      className: 'ic-toolbar-label', for: 'ic-ignore-unimportant', textContent: '忽略不重要差異',
    }))

    const btnReplacements = el('button', {
      className: 'ic-btn-refresh ic-btn-replacements',
      title: '取代規則：指定某個色彩視為與另一個色彩相同',
      textContent: '🎨 取代規則',
    })
    this._dom.btnReplacements = btnReplacements
    toolbar.appendChild(btnReplacements)

    // Separator
    toolbar.appendChild(el('span', { className: 'ic-toolbar-sep' }))

    // BC difference offset / Reset Difference Offset
    toolbar.appendChild(el('label', { className: 'ic-toolbar-label', textContent: '位移 X/Y：' }))
    const offsetXInput = /** @type {HTMLInputElement} */ (el('input', {
      type: 'number',
      className: 'ic-offset-input',
      step: '1',
      value: String(this._diffOffset.x),
      title: '右圖相對左圖的水平位移（像素）',
    }))
    this._dom.offsetXInput = offsetXInput
    toolbar.appendChild(offsetXInput)
    const offsetYInput = /** @type {HTMLInputElement} */ (el('input', {
      type: 'number',
      className: 'ic-offset-input',
      step: '1',
      value: String(this._diffOffset.y),
      title: '右圖相對左圖的垂直位移（像素）',
    }))
    this._dom.offsetYInput = offsetYInput
    toolbar.appendChild(offsetYInput)
    const btnResetOffset = el('button', {
      className: 'ic-btn-refresh ic-btn-reset-offset',
      title: '重設差異位移：兩張圖左上角重新對齊',
      textContent: '⌖ 重設位移',
    })
    this._dom.btnResetOffset = btnResetOffset
    toolbar.appendChild(btnResetOffset)

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

    // Layout toggle — the same Side / Over control the other views carry.
    const btnLayout = el('button', {
      className: 'ic-btn-refresh ic-btn-layout',
      title: '切換為上下堆疊',
      textContent: '⬛ 並排',
    })
    this._dom.btnLayout = btnLayout
    toolbar.appendChild(btnLayout)

    const btnRegions = el('button', {
      className: 'ic-btn-refresh ic-btn-regions',
      title: '列出所有差異區塊，點選可跳至該區塊',
      textContent: '▤ 區塊',
    })
    this._dom.btnRegions = btnRegions
    toolbar.appendChild(btnRegions)

    const btnInfo = el('button', {
      className: 'ic-btn-refresh ic-btn-info',
      title: '圖片資訊：尺寸、格式、檔案大小、色彩深度與差異統計',
      textContent: 'ℹ 資訊',
    })
    this._dom.btnInfo = btnInfo
    toolbar.appendChild(btnInfo)

    // Refresh button
    const btnRefresh = el('button', { className: 'ic-btn-refresh', textContent: '↺ 刷新' })
    this._dom.btnRefresh = btnRefresh
    toolbar.appendChild(btnRefresh)

    return toolbar
  }

  /**
   * The clickable list of difference regions.
   *
   * The tile grid is capped at DIFF_TILE_GRID² entries, so the whole list fits
   * in the DOM without windowing.
   */
  _buildRegionList() {
    const panel = el('div', { className: 'ic-region-panel' })
    panel.style.display = 'none'
    const head = el('div', { className: 'ic-region-head' })
    const count = el('span', { className: 'ic-region-count', textContent: '無差異區塊' })
    head.appendChild(count)
    const list = el('div', { className: 'ic-region-list', role: 'listbox' })
    panel.appendChild(head)
    panel.appendChild(list)
    this._dom.regionPanel = panel
    this._dom.regionCount = count
    this._dom.regionList = list

    list.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target.closest('.ic-region-item') : null
      if (!target) return
      const idx = Number(target.getAttribute('data-index'))
      if (Number.isInteger(idx)) this._jumpDiff(idx)
    })
    return panel
  }

  /** Repaint the region list from the current diff. */
  _renderRegionList() {
    const panel = /** @type {HTMLElement | undefined} */ (this._dom.regionPanel)
    const list = /** @type {HTMLElement | undefined} */ (this._dom.regionList)
    const count = /** @type {HTMLElement | undefined} */ (this._dom.regionCount)
    if (!panel || !list || !count) return

    panel.style.display = this._showRegionList ? '' : 'none'
    this._dom.btnRegions?.classList.toggle('ic-btn--active', this._showRegionList)
    if (!this._showRegionList) return

    const regions = this._diffRegions
    count.textContent = regions.length
      ? `${regions.length} 個差異區塊（依左上到右下排序）`
      : '無差異區塊'

    const frag = document.createDocumentFragment()
    regions.forEach((r, i) => {
      const item = el('button', {
        className: 'ic-region-item',
        type: 'button',
        'data-index': String(i),
        title: `跳至區塊 ${i + 1}`,
      })
      item.appendChild(el('span', { className: 'ic-region-idx', textContent: `#${i + 1}` }))
      item.appendChild(el('span', {
        className: 'ic-region-pos', textContent: `(${r.x}, ${r.y}) ${r.w}×${r.h}`,
      }))
      item.appendChild(el('span', {
        className: 'ic-region-count-cell', textContent: `${r.count.toLocaleString()} px`,
      }))
      frag.appendChild(item)
    })
    list.replaceChildren(frag)
    this._markCurrentRegion()
  }

  /** Highlight whichever region the navigation cursor is on. */
  _markCurrentRegion() {
    const list = /** @type {HTMLElement | undefined} */ (this._dom.regionList)
    if (!list) return
    for (const item of list.querySelectorAll('.ic-region-item')) {
      item.classList.toggle(
        'ic-region-item--current',
        Number(item.getAttribute('data-index')) === this._currentDiffIdx)
    }
  }

  /** The image info panel shell; contents come from _renderInfoPanel. */
  _buildInfoPanel() {
    const panel = el('div', { className: 'ic-info-panel' })
    panel.style.display = 'none'
    this._dom.infoPanel = panel
    return panel
  }

  // ── Private: Replacements dialog ────────────────────────────────────────────

  _buildReplacementsDialog() {
    const panel = el('div', { className: 'ic-replacements-panel' })
    panel.style.display = 'none'

    const head = el('div', { className: 'ic-replacements-head' })
    head.appendChild(el('span', {
      className: 'ic-replacements-title', textContent: '取代規則（色彩視為相同）',
    }))
    const btnAdd = el('button', {
      className: 'ic-btn-refresh ic-btn-add-replacement',
      textContent: '＋ 新增規則',
      title: `新增一條取代規則（上限 ${MAX_REPLACEMENT_RULES} 條）`,
    })
    this._dom.btnAddReplacement = btnAdd
    head.appendChild(btnAdd)
    const btnClose = el('button', {
      className: 'ic-btn-refresh ic-btn-close-replacements',
      textContent: '✕ 關閉',
      title: '關閉取代規則面板',
    })
    this._dom.btnCloseReplacements = btnClose
    head.appendChild(btnClose)
    panel.appendChild(head)

    panel.appendChild(el('div', {
      className: 'ic-replacements-hint',
      textContent: '左欄色彩會被當成右欄色彩來比對。'
        + '需勾選工具列的「忽略不重要差異」才會套用；符合規則的差異以藍色標示，不計入差異像素數。',
    }))

    const list = el('div', { className: 'ic-replacements-list' })
    this._dom.replacementsList = list
    panel.appendChild(list)

    this._dom.replacementsPanel = panel
    this._renderReplacementRows()
    return panel
  }

  /** Repaint the rule rows from `_replacements`. */
  _renderReplacementRows() {
    const list = /** @type {HTMLElement | undefined} */ (this._dom.replacementsList)
    if (!list) return
    list.replaceChildren()

    if (this._replacements.length === 0) {
      list.appendChild(el('div', {
        className: 'ic-replacements-empty', textContent: '尚無規則。',
      }))
      return
    }

    this._replacements.forEach((rule, idx) => {
      const row = el('div', { className: 'ic-replacement-row' })
      row.appendChild(el('span', {
        className: 'ic-replacement-index', textContent: `${idx + 1}.`,
      }))

      const from = /** @type {HTMLInputElement} */ (el('input', {
        type: 'color', className: 'ic-replacement-color', title: '檔案中出現的色彩',
      }))
      from.value = rule.from
      from.addEventListener('change', () => {
        const hex = normalizeHexColor(from.value)
        if (!hex) {
          this._emit('status', { message: `色碼無法解讀：${from.value}`, level: 'warn' })
          from.value = rule.from
          return
        }
        rule.from = hex
        void this._runDiff()
      })
      row.appendChild(from)

      row.appendChild(el('span', { className: 'ic-replacement-arrow', textContent: '→' }))

      const to = /** @type {HTMLInputElement} */ (el('input', {
        type: 'color', className: 'ic-replacement-color', title: '視為相同的目標色彩',
      }))
      to.value = rule.to
      to.addEventListener('change', () => {
        const hex = normalizeHexColor(to.value)
        if (!hex) {
          this._emit('status', { message: `色碼無法解讀：${to.value}`, level: 'warn' })
          to.value = rule.to
          return
        }
        rule.to = hex
        void this._runDiff()
      })
      row.appendChild(to)

      row.appendChild(el('span', {
        className: 'ic-replacement-hex', textContent: `${rule.from} → ${rule.to}`,
      }))

      const del = el('button', {
        className: 'ic-btn-refresh ic-btn-del-replacement',
        textContent: '✕',
        title: '刪除這條規則',
      })
      del.addEventListener('click', () => { this.removeReplacement(idx) })
      row.appendChild(del)

      list.appendChild(row)
    })
  }

  /** Show the rule count on the toolbar button, so it is visible when closed. */
  _updateReplacementsButton() {
    const btn = /** @type {HTMLElement | undefined} */ (this._dom.btnReplacements)
    if (!btn) return
    const n = this._replacements.length
    btn.textContent = n > 0 ? `🎨 取代規則 (${n})` : '🎨 取代規則'
    btn.classList.toggle('ic-btn--active', n > 0 && this._ignoreUnimportant)
  }

  /**
   * @param {boolean} [show] omit to toggle
   * @returns {boolean} whether the panel is now on screen
   */
  toggleReplacementsPanel(show) {
    const panel = /** @type {HTMLElement | undefined} */ (this._dom.replacementsPanel)
    if (!panel) return false
    const next = show === undefined ? panel.style.display === 'none' : !!show
    panel.style.display = next ? '' : 'none'
    if (next) this._renderReplacementRows()
    return next
  }

  /** Repaint the info panel from the loaded images and the last diff. */
  _renderInfoPanel() {
    const panel = /** @type {HTMLElement | undefined} */ (this._dom.infoPanel)
    if (!panel) return
    panel.style.display = this._showInfoPanel ? '' : 'none'
    this._dom.btnInfo?.classList.toggle('ic-btn--active', this._showInfoPanel)
    if (!this._showInfoPanel) return

    panel.replaceChildren()
    for (const [which, label] of /** @type {Array<['left'|'right', string]>} */ ([
      ['left', '左側'], ['right', '右側'],
    ])) {
      const block = el('div', { className: 'ic-info-side' })
      block.appendChild(el('div', { className: 'ic-info-title', textContent: label }))
      const info = this.getSideInfo(which)
      const table = el('table', { className: 'ic-info-table' })
      const tbody = el('tbody')
      for (const [k, v] of imageInfoRows(info)) {
        const tr = el('tr')
        tr.appendChild(el('th', {}, k))
        tr.appendChild(el('td', {}, v))
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      block.appendChild(table)

      // Kept in its own table under its own heading: everything above is
      // measured from the decoded image, everything here is quoted from the
      // file, and the two must not read as one list of equally-sourced facts.
      block.appendChild(el('div', {
        className: 'ic-info-subtitle', textContent: '檔頭中繼資料',
      }))
      const metaTable = el('table', { className: 'ic-info-table' })
      const metaBody = el('tbody')
      for (const [k, v] of imageMetadataRows(info?.meta ?? null)) {
        const tr = el('tr')
        tr.appendChild(el('th', {}, k))
        tr.appendChild(el('td', {}, v))
        metaBody.appendChild(tr)
      }
      metaTable.appendChild(metaBody)
      block.appendChild(metaTable)
      panel.appendChild(block)
    }

    const { diffCount, totalPixels, approximate } = this._stats
    const summary = el('div', { className: 'ic-info-side' })
    summary.appendChild(el('div', { className: 'ic-info-title', textContent: '差異' }))
    const table = el('table', { className: 'ic-info-table' })
    const tbody = el('tbody')
    const pct = (diffCount != null && totalPixels) ? ((diffCount / totalPixels) * 100).toFixed(2) : null
    const mark = approximate ? '≈' : ''
    for (const [k, v] of [
      ['差異像素', diffCount == null ? '（尚未比對）' : `${mark}${diffCount.toLocaleString()}`],
      ['差異百分比', pct == null ? '（尚未比對）' : `${mark}${pct}%`],
      ['差異區塊數', String(this._diffRegions.length)],
      ['不重要差異像素', `${mark}${(this._stats.unimportant ?? 0).toLocaleString()}`],
      ['差異位移', `X ${this._diffOffset.x}, Y ${this._diffOffset.y}`],
      ['數值來源', approximate ? '大圖縮圖後比對，為估計值' : '全解析度實測'],
      ...metadataDiffRows(this._metaDiffs, this._compareMetadata),
    ]) {
      const tr = el('tr')
      tr.appendChild(el('th', {}, k))
      tr.appendChild(el('td', {}, v))
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    summary.appendChild(table)
    panel.appendChild(summary)
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

    this._dom.body = body
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
    const blendRatioSlider   = dom.blendRatioSlider
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

    dom.btnLayout?.addEventListener('click', () => this.toggleLayout())
    dom.btnRegions?.addEventListener('click', () => this.toggleRegionList())
    dom.btnInfo?.addEventListener('click', () => this.toggleInfoPanel())

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

    blendRatioSlider?.addEventListener('input', () => {
      this.setBlendRatio(parseFloat(blendRatioSlider.value))
    })

    autoScaleCheck?.addEventListener('change', () => {
      this.setAutoScale(autoScaleCheck.checked)
    })

    mismatchRangeCheck?.addEventListener('change', () => {
      this.setMismatchRange(mismatchRangeCheck.checked)
    })

    highlightSelect?.addEventListener('change', () => {
      // 'custom' is not a colour — it hands control to the swatch, which keeps
      // whatever the user last picked.
      this.setHighlightColor(
        highlightSelect.value === 'custom' ? this._customHighlight : highlightSelect.value)
    })

    const highlightSwatch = dom.highlightSwatch
    highlightSwatch?.addEventListener('input', () => {
      this.setHighlightColor(highlightSwatch.value)
    })

    dom.btnBlendToggle?.addEventListener('click', () => { this.cycleBlendMode() })

    const compareMetaCheck = dom.compareMetaCheck
    compareMetaCheck?.addEventListener('change', () => {
      this.setCompareMetadata(compareMetaCheck.checked)
    })

    const ignoreUnimportantCheck = dom.ignoreUnimportantCheck
    ignoreUnimportantCheck?.addEventListener('change', () => {
      this.setIgnoreUnimportant(ignoreUnimportantCheck.checked)
      this._updateReplacementsButton()
    })

    dom.btnReplacements?.addEventListener('click', () => { this.toggleReplacementsPanel() })
    dom.btnCloseReplacements?.addEventListener('click', () => {
      this.toggleReplacementsPanel(false)
    })
    dom.btnAddReplacement?.addEventListener('click', () => {
      // A rule that changes nothing would be invisible; seeding two different
      // colours makes the new row demonstrably a rule.
      this.addReplacement('#ffffff', '#000000')
    })

    const offsetXInput = dom.offsetXInput
    const offsetYInput = dom.offsetYInput
    const readOffset = () => {
      const x = parseInt(offsetXInput?.value ?? '', 10)
      const y = parseInt(offsetYInput?.value ?? '', 10)
      this.setDiffOffset(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0)
    }
    offsetXInput?.addEventListener('change', readOffset)
    offsetYInput?.addEventListener('change', readOffset)
    dom.btnResetOffset?.addEventListener('click', () => { this.resetDiffOffset() })

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

    this._setupDropTargets()

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

  // ── Private: Drag & drop ───────────────────────────────────────────────────

  /**
   * Accept images dropped onto either pane.
   *
   * Which pane took the drop chooses the side, so a user can replace one image
   * without touching the other; dropping two files at once fills both.
   */
  _setupDropTargets() {
    /** @type {Array<[HTMLElement, 'left'|'right'|'both']>} */
    const targets = [
      [this._dom.wrapLeft, 'left'],
      [this._dom.wrapRight, 'right'],
      [this._dom.wrapDiff, 'both'],
    ].filter(([node]) => Boolean(node))

    /** @type {Array<() => void>} */
    const cleanups = []

    for (const [node, side] of targets) {
      const onOver = (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        node.classList.add('ic-drop-target')
      }
      const onLeave = () => node.classList.remove('ic-drop-target')
      const onDrop = (e) => {
        e.preventDefault()
        e.stopPropagation()
        node.classList.remove('ic-drop-target')
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
   * @param {DragEvent} e
   * @param {'left'|'right'|'both'} side  where the drop landed
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
      this._emit('status', {
        message: `無法接受拖放的檔案：${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      })
      return
    }

    if (!entries?.length) {
      // preload resolves a path only for a File the OS really handed over.
      this._emit('status', { message: '無法取得拖放檔案的路徑', level: 'error' })
      return
    }

    const usable = entries.filter((entry) => entry && !entry.isDirectory)
    if (!usable.length) {
      this._emit('status', { message: '請拖放圖片檔案，而非資料夾', level: 'error' })
      return
    }

    const plan = side === 'both'
      ? [['left', usable[0]], ['right', usable[1]]]
      : usable.length > 1
        ? [['left', usable[0]], ['right', usable[1]]]
        : [[side, usable[0]]]

    for (const [target, entry] of plan) {
      if (!entry) continue
      await this._loadDroppedImage(/** @type {'left'|'right'} */ (target), entry.path)
    }
  }

  /**
   * @param {'left'|'right'} side
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _loadDroppedImage(side, path) {
    try {
      const result = await window.electronAPI.readFileBinary(path, MAX_IMAGE_BYTES)
      if (!result) return
      if (result.truncated) {
        this._emit('status', { message: `圖片超過大小上限：${path}`, level: 'error' })
        return
      }
      if (side === 'left') await this.setLeft(result.path, result.base64, result.ext)
      else await this.setRight(result.path, result.base64, result.ext)
    } catch (err) {
      this._emit('status', {
        message: `載入 ${path} 失敗：${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
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
    this._refreshMetadataDiffs()
    if (!this._left || !this._right) {
      this._updateStats(null, null)
      this._diffRegions = []
      this._currentDiffIdx = -1
      this._renderRegionList()
      this._renderInfoPanel()
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
    const tileSize = diffTileSize(geo.width, geo.height)
    const tileCols = Math.max(1, Math.ceil(geo.width / tileSize))
    const tileRows = Math.max(1, Math.ceil(geo.height / tileSize))
    const tileCounts = new Uint32Array(tileCols * tileRows)
    const counters = { unimportant: 0 }
    // The offset is expressed in full-resolution pixels, so it has to travel
    // through the same downscale the geometry did or it would mean something
    // different on a large image than on a small one.
    const offsetX = Math.round(this._diffOffset.x * geo.scale)
    const offsetY = Math.round(this._diffOffset.y * geo.scale)
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
      tileCounts, tileSize, tileCols,
      replacements: this._activeReplacementMap(),
      offsetX, offsetY,
      counters,
    })
    this._diffCtx.putImageData(diffImgData, 0, 0)

    // Recomputing the diff invalidates the old regions, so the cursor resets
    // rather than pointing at an area that may no longer differ.
    this._diffRegions = tilesToRegions(tileCounts, tileCols, tileSize, geo.width, geo.height)
    this._currentDiffIdx = -1
    this._consumePendingFirstDiff()

    // Report stats at the FULL resolution so user-facing numbers match the
    // image dimensions the user sees. Extrapolating diffCount by 1/scale² is an
    // estimate, hence the explicit approximate flag below.
    const approximate = geo.scale < 1
    const totalPixels = fullGeo.width * fullGeo.height
    const reportedDiffCount = approximate
      ? Math.round(diffCount / (geo.scale * geo.scale))
      : diffCount
    const reportedUnimportant = approximate
      ? Math.round(counters.unimportant / (geo.scale * geo.scale))
      : counters.unimportant
    this._updateStats(reportedDiffCount, totalPixels, approximate, reportedUnimportant)
    this._renderRegionList()
    this._renderInfoPanel()

    // 若 overlay 已關閉，隱藏 diff canvas
    this._toggleDiffOverlay()
  }

  /**
   * BC's "when loading new files, go to first difference". Flag-gated so a
   * threshold or blend-mode change, which also re-runs the diff, leaves the
   * user's pan alone.
   */
  _consumePendingFirstDiff() {
    if (!this._pendingFirstDiff) return
    this._pendingFirstDiff = false
    if (!this._diffRegions.length) return
    if (!getNavOptions().firstDiffOnLoad) return
    this._jumpDiff(0)
  }

  // ── Private: Stats ──────────────────────────────────────────────────────────

  /**
   * @param {number | null} diffCount
   * @param {number | null} totalPixels
   * @param {boolean} [approximate] - 數字由縮圖比對外推而來
   * @param {number} [unimportant] - 被取代規則判為不重要的差異像素數
   */
  _updateStats(diffCount, totalPixels, approximate = false, unimportant = 0) {
    this._stats = { diffCount, totalPixels, approximate, unimportant }
    const stats = this._dom.stats
    if (!stats) return

    if (diffCount === null || totalPixels === null) {
      stats.textContent = '請載入兩張圖片以計算差異'
      stats.classList?.remove('ic-stats-text--approx')
      return
    }

    const mark = approximate ? '≈' : ''
    let text = formatDiffStats(diffCount, totalPixels, approximate)
    if (unimportant > 0) {
      text += `　不重要差異 ${mark}${unimportant.toLocaleString()}`
    }
    // With metadata comparison on, "0 differing pixels" is no longer the whole
    // verdict, so the status line must not read as if it were.
    if (this._compareMetadata) {
      text += this._metaDiffs.length > 0
        ? `　中繼資料差異 ${this._metaDiffs.length} 項`
        : '　中繼資料相同'
    }
    stats.textContent = text
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
    // Left at '' rather than '1' when fully mixed, so nothing inherits an
    // opacity that would defeat the panel's own styling.
    wrapDiff.style.opacity = this._blendRatio >= 1 ? '' : String(this._blendRatio)
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
      // Ctrl+B → BC's Blend Toggle
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        const mode = this.cycleBlendMode()
        this._emit('status', {
          message: `疊加模式：${BLEND_LABELS[mode] ?? mode}`, level: 'info',
        })
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
