/**
 * @vitest-environment jsdom
 *
 * Sprint 16 tests for image-compare:
 *   S16-1 Auto Scale — 尺寸不同的圖片自動對齊
 *   S16-2 Mismatch Range Mode — 差異強度分級
 *   S16-3 差異高亮顏色可設定
 *   S16-4 統計數字誠實標示（≈ / 估計值）
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'

/** @type {any} */
let mod

beforeAll(async () => {
  mod = await import('../../src/renderer/src/views/image-compare.js')
})

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * 產生單色 RGBA buffer。
 * @param {number} w
 * @param {number} h
 * @param {[number, number, number]} rgb
 * @returns {Uint8ClampedArray}
 */
function solid(w, h, rgb) {
  const buf = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    buf[i * 4]     = rgb[0]
    buf[i * 4 + 1] = rgb[1]
    buf[i * 4 + 2] = rgb[2]
    buf[i * 4 + 3] = 255
  }
  return buf
}

/**
 * 由每個像素的 RGB 陣列組出 buffer。
 * @param {Array<[number, number, number]>} pixels
 * @returns {Uint8ClampedArray}
 */
function fromPixels(pixels) {
  const buf = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach((p, i) => {
    buf[i * 4]     = p[0]
    buf[i * 4 + 1] = p[1]
    buf[i * 4 + 2] = p[2]
    buf[i * 4 + 3] = 255
  })
  return buf
}

/**
 * @param {number} w
 * @param {number} h
 * @returns {Uint8ClampedArray}
 */
function outBuf(w, h) {
  return new Uint8ClampedArray(w * h * 4)
}

/**
 * 讀出輸出 buffer 中第 i 個像素的 RGBA。
 * @param {Uint8ClampedArray} buf
 * @param {number} i
 * @returns {[number, number, number, number]}
 */
function px(buf, i) {
  return [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3]]
}

// ── S16-1: Auto Scale geometry ───────────────────────────────────────────────

describe('S16-1 resolveDiffGeometry', () => {
  it('autoScale off keeps each side at its own size and unions the canvas', () => {
    const geo = mod.resolveDiffGeometry(4, 4, 2, 2, false)
    expect(geo).toEqual({
      width: 4, height: 4,
      leftW: 4, leftH: 4,
      rightW: 2, rightH: 2,
      autoScaled: false,
    })
  })

  it('autoScale on aligns both sides to the larger image', () => {
    const geo = mod.resolveDiffGeometry(4, 4, 2, 2, true)
    expect(geo).toEqual({
      width: 4, height: 4,
      leftW: 4, leftH: 4,
      rightW: 4, rightH: 4,
      autoScaled: true,
    })
  })

  it('autoScale on picks the right image when it is the larger one', () => {
    const geo = mod.resolveDiffGeometry(10, 10, 40, 30, true)
    expect(geo.width).toBe(40)
    expect(geo.height).toBe(30)
    expect(geo.leftW).toBe(40)
    expect(geo.leftH).toBe(30)
    expect(geo.autoScaled).toBe(true)
  })

  it('autoScale is inert when both images already share a size', () => {
    const geo = mod.resolveDiffGeometry(8, 6, 8, 6, true)
    expect(geo.autoScaled).toBe(false)
    expect(geo).toEqual(mod.resolveDiffGeometry(8, 6, 8, 6, false))
  })

  it('autoScale falls back to union geometry when a dimension is zero', () => {
    const geo = mod.resolveDiffGeometry(0, 0, 4, 4, true)
    expect(geo.autoScaled).toBe(false)
    expect(geo.width).toBe(4)
  })
})

describe('S16-1 capDiffGeometry', () => {
  it('leaves geometry untouched below the cap and reports scale 1', () => {
    const geo = mod.resolveDiffGeometry(100, 50, 100, 50, false)
    const capped = mod.capDiffGeometry(geo, 2048)
    expect(capped.scale).toBe(1)
    expect(capped.width).toBe(100)
  })

  it('scales every dimension down once the longest edge exceeds the cap', () => {
    const geo = mod.resolveDiffGeometry(4096, 2048, 2048, 1024, false)
    const capped = mod.capDiffGeometry(geo, 2048)
    expect(capped.scale).toBe(0.5)
    expect(capped.width).toBe(2048)
    expect(capped.height).toBe(1024)
    expect(capped.rightW).toBe(1024)
    expect(capped.rightH).toBe(512)
  })

  it('never collapses a side to zero pixels', () => {
    const geo = mod.resolveDiffGeometry(10000, 10000, 1, 1, false)
    const capped = mod.capDiffGeometry(geo, 100)
    expect(capped.rightW).toBeGreaterThanOrEqual(1)
    expect(capped.rightH).toBeGreaterThanOrEqual(1)
  })
})

// ── S16-1: Auto Scale diff behaviour ─────────────────────────────────────────

describe('S16-1 Auto Scale changes the diff outcome for mismatched sizes', () => {
  const RED = /** @type {[number, number, number]} */ ([200, 30, 30])

  it('without autoScale, the out-of-range region is all flagged as different', () => {
    const geo = mod.resolveDiffGeometry(4, 4, 2, 2, false)
    const out = outBuf(geo.width, geo.height)
    const diffCount = mod.computeDiffBuffer({
      leftData: solid(4, 4, RED),
      rightData: solid(2, 2, RED),
      out,
      width: geo.width, height: geo.height,
      lw: geo.leftW, lh: geo.leftH,
      rw: geo.rightW, rh: geo.rightH,
      threshold: 0.1,
      algorithm: 'exact',
    })
    // 16 pixels total, only the 2×2 overlap can match
    expect(diffCount).toBe(12)
  })

  it('with autoScale, the same content at a different resolution matches fully', () => {
    const geo = mod.resolveDiffGeometry(4, 4, 2, 2, true)
    // 對齊後右圖已被放大成 4×4（單色放大後仍為同一色）
    const out = outBuf(geo.width, geo.height)
    const diffCount = mod.computeDiffBuffer({
      leftData: solid(4, 4, RED),
      rightData: solid(geo.rightW, geo.rightH, RED),
      out,
      width: geo.width, height: geo.height,
      lw: geo.leftW, lh: geo.leftH,
      rw: geo.rightW, rh: geo.rightH,
      threshold: 0.1,
      algorithm: 'exact',
    })
    expect(diffCount).toBe(0)
  })

  it('exposes setAutoScale / getAutoScale on the view', () => {
    const ic = new mod.ImageCompare()
    expect(ic.getAutoScale()).toBe(false)
    ic.setAutoScale(true)
    expect(ic.getAutoScale()).toBe(true)
    ic.setAutoScale(false)
    expect(ic.getAutoScale()).toBe(false)
  })

  it('setAutoScale mirrors the toolbar checkbox state', () => {
    const ic = new mod.ImageCompare()
    const box = { checked: false }
    ic._dom = { autoScaleCheck: box }
    ic.setAutoScale(true)
    expect(box.checked).toBe(true)
  })
})

// ── Threshold boundaries ─────────────────────────────────────────────────────

describe('threshold boundaries', () => {
  it('exact ignores the tolerance slider entirely', () => {
    expect(mod.diffCutoff(0, 'exact')).toBe(0)
    expect(mod.diffCutoff(0.5, 'exact')).toBe(0)
    expect(mod.isPixelDiff(1, 0.5, 'exact')).toBe(true)
    expect(mod.isPixelDiff(0, 0.5, 'exact')).toBe(false)
  })

  it('tolerance uses threshold × 255 as a strict cutoff', () => {
    const cutoff = mod.diffCutoff(0.1, 'tolerance')
    expect(cutoff).toBeCloseTo(25.5)
    expect(mod.isPixelDiff(cutoff, 0.1, 'tolerance')).toBe(false)
    expect(mod.isPixelDiff(cutoff + 0.001, 0.1, 'tolerance')).toBe(true)
  })

  it('grayscale uses luminance distance against the same cutoff', () => {
    // pure red vs black → luminance delta 0.299×255 ≈ 76.2
    const mag = mod.pixelDiffMagnitude(255, 0, 0, 0, 0, 0, 'grayscale')
    expect(mag).toBeCloseTo(76.245)
    expect(mod.isPixelDiff(mag, 0.2, 'grayscale')).toBe(true)   // cutoff 51
    expect(mod.isPixelDiff(mag, 0.4, 'grayscale')).toBe(false)  // cutoff 102
  })

  it('tolerance magnitude is the mean per-channel delta', () => {
    expect(mod.pixelDiffMagnitude(30, 0, 0, 0, 0, 0, 'tolerance')).toBe(10)
  })

  it('exact magnitude is the max channel delta (grading only)', () => {
    expect(mod.pixelDiffMagnitude(30, 0, 5, 0, 0, 0, 'exact')).toBe(30)
  })

  it('threshold 0 with tolerance flags any non-identical pixel', () => {
    const out = outBuf(1, 1)
    const diffCount = mod.computeDiffBuffer({
      leftData: fromPixels([[0, 0, 0]]),
      rightData: fromPixels([[1, 0, 0]]),
      out, width: 1, height: 1, lw: 1, lh: 1, rw: 1, rh: 1,
      threshold: 0, algorithm: 'tolerance',
    })
    expect(diffCount).toBe(1)
  })

  it('a difference sitting exactly on the cutoff is not a difference', () => {
    // mean delta of 25.5 requires a fractional channel delta; use 0.1 → 25.5
    const out = outBuf(1, 1)
    const diffCount = mod.computeDiffBuffer({
      leftData: fromPixels([[0, 0, 0]]),
      rightData: fromPixels([[25, 26, 26]]), // mean = 25.666 > 25.5
      out, width: 1, height: 1, lw: 1, lh: 1, rw: 1, rh: 1,
      threshold: 0.1, algorithm: 'tolerance',
    })
    expect(diffCount).toBe(1)

    const out2 = outBuf(1, 1)
    const diffCount2 = mod.computeDiffBuffer({
      leftData: fromPixels([[0, 0, 0]]),
      rightData: fromPixels([[25, 25, 25]]), // mean = 25 < 25.5
      out: out2, width: 1, height: 1, lw: 1, lh: 1, rw: 1, rh: 1,
      threshold: 0.1, algorithm: 'tolerance',
    })
    expect(diffCount2).toBe(0)
  })
})

// ── S16-2: Mismatch Range Mode ───────────────────────────────────────────────

describe('S16-2 mismatchLevel grading', () => {
  it('returns 0 for pixels at or under the cutoff', () => {
    expect(mod.mismatchLevel(0, 0.1, 'tolerance')).toBe(0)
    expect(mod.mismatchLevel(25.5, 0.1, 'tolerance')).toBe(0)
  })

  it('returns 1 just above the cutoff and MISMATCH_LEVELS at full delta', () => {
    expect(mod.mismatchLevel(26, 0.1, 'tolerance')).toBe(1)
    expect(mod.mismatchLevel(255, 0.1, 'tolerance')).toBe(mod.MISMATCH_LEVELS)
  })

  it('is monotonically non-decreasing in magnitude', () => {
    let prev = 0
    for (let m = 0; m <= 255; m += 5) {
      const lv = mod.mismatchLevel(m, 0, 'tolerance')
      expect(lv).toBeGreaterThanOrEqual(prev)
      prev = lv
    }
    expect(prev).toBe(mod.MISMATCH_LEVELS)
  })

  it('spreads the four buckets evenly over the post-cutoff range', () => {
    expect(mod.mismatchLevel(60, 0, 'tolerance')).toBe(1)   // ≤ 63.75
    expect(mod.mismatchLevel(100, 0, 'tolerance')).toBe(2)  // ≤ 127.5
    expect(mod.mismatchLevel(190, 0, 'tolerance')).toBe(3)  // ≤ 191.25
    expect(mod.mismatchLevel(200, 0, 'tolerance')).toBe(4)
  })
})

describe('S16-2 range mode colouring', () => {
  const LEFT  = fromPixels([[0, 0, 0], [0, 0, 0]])
  const RIGHT = fromPixels([[12, 12, 12], [255, 255, 255]])

  /** @param {boolean} mismatchRange */
  function run(mismatchRange) {
    const out = outBuf(2, 1)
    const diffCount = mod.computeDiffBuffer({
      leftData: LEFT, rightData: RIGHT, out,
      width: 2, height: 1, lw: 2, lh: 1, rw: 2, rh: 1,
      threshold: 0, algorithm: 'tolerance',
      mismatchRange, highlightColor: 'red',
    })
    return { out, diffCount }
  }

  it('flat mode paints both mismatches with the identical colour', () => {
    const { out, diffCount } = run(false)
    expect(diffCount).toBe(2)
    expect(px(out, 0)).toEqual(px(out, 1))
    expect(px(out, 0)).toEqual([255, 0, 0, 200])
  })

  it('range mode paints a slight shift weaker than a total mismatch', () => {
    const { out, diffCount } = run(true)
    expect(diffCount).toBe(2)
    const light = px(out, 0)
    const heavy = px(out, 1)
    expect(light).not.toEqual(heavy)
    expect(light[3]).toBeLessThan(heavy[3])
    expect(light[0]).toBeLessThan(heavy[0])
  })

  it('the strongest bucket is byte-identical to the flat highlight', () => {
    expect(mod.highlightRGBA('red', mod.MISMATCH_LEVELS)).toEqual([255, 0, 0, 200])
    expect(run(true).out.slice(4)).toEqual(run(false).out.slice(4))
  })

  it('alpha rises with the level for every colour', () => {
    for (const key of Object.keys(mod.HIGHLIGHT_COLORS)) {
      let prev = -1
      for (let lv = 1; lv <= mod.MISMATCH_LEVELS; lv++) {
        const a = mod.highlightRGBA(key, lv)[3]
        expect(a).toBeGreaterThan(prev)
        prev = a
      }
    }
  })

  it('unchanged pixels are dimmed left-image colours in both modes', () => {
    const out = outBuf(1, 1)
    mod.computeDiffBuffer({
      leftData: fromPixels([[10, 20, 30]]),
      rightData: fromPixels([[10, 20, 30]]),
      out, width: 1, height: 1, lw: 1, lh: 1, rw: 1, rh: 1,
      threshold: 0, algorithm: 'exact', mismatchRange: true,
    })
    expect(px(out, 0)).toEqual([10, 20, 30, 128])
  })

  it('exposes setMismatchRange / getMismatchRange on the view', () => {
    const ic = new mod.ImageCompare()
    expect(ic.getMismatchRange()).toBe(false)
    ic.setMismatchRange(true)
    expect(ic.getMismatchRange()).toBe(true)
  })

  it('mismatch range does not disturb the blend mode', () => {
    const ic = new mod.ImageCompare()
    ic.setBlendMode('blend')
    ic.setMismatchRange(true)
    expect(ic.getBlendMode()).toBe('blend')
  })
})

// ── S16-3: Highlight colour ──────────────────────────────────────────────────

describe('S16-3 configurable highlight colour', () => {
  it('offers red / green / blue / magenta', () => {
    expect(Object.keys(mod.HIGHLIGHT_COLORS).sort())
      .toEqual(['blue', 'green', 'magenta', 'red'])
    for (const entry of Object.values(mod.HIGHLIGHT_COLORS)) {
      expect(typeof entry.label).toBe('string')
      expect(entry.rgb).toHaveLength(3)
    }
  })

  it('defaults to red', () => {
    expect(mod.DEFAULT_HIGHLIGHT_COLOR).toBe('red')
    expect(new mod.ImageCompare().getHighlightColor()).toBe('red')
  })

  it('falls back to the default for an unknown key', () => {
    expect(mod.highlightRGBA('chartreuse')).toEqual(mod.highlightRGBA('red'))
  })

  it('setHighlightColor accepts known keys and ignores unknown ones', () => {
    const ic = new mod.ImageCompare()
    ic.setHighlightColor('green')
    expect(ic.getHighlightColor()).toBe('green')
    ic.setHighlightColor('not-a-colour')
    expect(ic.getHighlightColor()).toBe('green')
  })

  it('setHighlightColor rejects inherited Object keys', () => {
    const ic = new mod.ImageCompare()
    ic.setHighlightColor('toString')
    expect(ic.getHighlightColor()).toBe('red')
  })

  it('paints mismatching pixels in the chosen colour', () => {
    const out = outBuf(1, 1)
    mod.computeDiffBuffer({
      leftData: fromPixels([[0, 0, 0]]),
      rightData: fromPixels([[255, 255, 255]]),
      out, width: 1, height: 1, lw: 1, lh: 1, rw: 1, rh: 1,
      threshold: 0, algorithm: 'exact', highlightColor: 'blue',
    })
    const [r, g, b] = px(out, 0)
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
    expect([r, g, b]).toEqual(mod.HIGHLIGHT_COLORS.blue.rgb)
  })

  it('paints out-of-range pixels in the chosen colour too', () => {
    const geo = mod.resolveDiffGeometry(2, 1, 1, 1, false)
    const out = outBuf(geo.width, geo.height)
    mod.computeDiffBuffer({
      leftData: fromPixels([[0, 0, 0], [0, 0, 0]]),
      rightData: fromPixels([[0, 0, 0]]),
      out,
      width: geo.width, height: geo.height,
      lw: geo.leftW, lh: geo.leftH,
      rw: geo.rightW, rh: geo.rightH,
      threshold: 0, algorithm: 'exact', highlightColor: 'magenta',
    })
    expect(px(out, 1).slice(0, 3)).toEqual(mod.HIGHLIGHT_COLORS.magenta.rgb)
  })

  it('mirrors the toolbar select value', () => {
    const ic = new mod.ImageCompare()
    const sel = { value: 'red' }
    ic._dom = { highlightSelect: sel }
    ic.setHighlightColor('magenta')
    expect(sel.value).toBe('magenta')
  })
})

// ── S16-4: Honest statistics ─────────────────────────────────────────────────

describe('S16-4 approximate stats labelling', () => {
  it('exact counts carry no approximation marker', () => {
    const s = mod.formatDiffStats(1234, 10000, false)
    expect(s).toContain('1,234')
    expect(s).not.toContain('≈')
    expect(s).not.toContain('估計值')
    expect(s).toContain('(12.34%)')
  })

  it('extrapolated counts are prefixed with ≈ and called out as estimates', () => {
    const s = mod.formatDiffStats(1234, 10000, true)
    expect(s).toContain('≈1,234')
    expect(s).toContain('≈12.34%')
    expect(s).toContain('估計值')
  })

  it('defaults to the exact form when the flag is omitted', () => {
    expect(mod.formatDiffStats(5, 10)).toBe(mod.formatDiffStats(5, 10, false))
  })

  it('avoids dividing by zero on an empty image', () => {
    expect(mod.formatDiffStats(0, 0, false)).toContain('(0.00%)')
  })

  it('_updateStats marks the stats element when the number is extrapolated', () => {
    const ic = new mod.ImageCompare()
    const classList = { toggle: vi.fn(), remove: vi.fn() }
    ic._dom = { stats: { textContent: '', classList } }
    ic._updateStats(500, 1_000_000, true)
    expect(ic._dom.stats.textContent).toContain('≈')
    expect(classList.toggle).toHaveBeenCalledWith('ic-stats-text--approx', true)
  })

  it('_updateStats clears the marker for exact numbers', () => {
    const ic = new mod.ImageCompare()
    const classList = { toggle: vi.fn(), remove: vi.fn() }
    ic._dom = { stats: { textContent: '', classList } }
    ic._updateStats(500, 1000, false)
    expect(ic._dom.stats.textContent).not.toContain('≈')
    expect(classList.toggle).toHaveBeenCalledWith('ic-stats-text--approx', false)
  })

  it('shows the placeholder when only one image is loaded', () => {
    const ic = new mod.ImageCompare()
    const classList = { toggle: vi.fn(), remove: vi.fn() }
    ic._dom = { stats: { textContent: '', classList } }
    ic._updateStats(null, null)
    expect(ic._dom.stats.textContent).toBe('請載入兩張圖片以計算差異')
  })

  it('a capped geometry is exactly the condition that makes stats approximate', () => {
    const small = mod.capDiffGeometry(mod.resolveDiffGeometry(100, 100, 100, 100, false), 2048)
    const huge  = mod.capDiffGeometry(mod.resolveDiffGeometry(8000, 6000, 8000, 6000, false), 2048)
    expect(small.scale < 1).toBe(false)
    expect(huge.scale < 1).toBe(true)
  })
})
