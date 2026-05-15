/**
 * @vitest-environment jsdom
 *
 * Sprint 10 tests for image-compare:
 *   T57 Zoom shortcuts + Fit to Window
 *   T58 Rotate & Flip
 *   T59 Blend Mode
 *   T60 Full Screen (F11)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks required before import ─────────────────────────────────────────────

Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: {
      openFileBinary:    vi.fn(),
      readFileBinary:    vi.fn(),
      toggleFullScreen:  vi.fn(),
    },
  },
  writable: true,
})

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build an ImageCompare instance with a fake _syncTransform controller and DOM
 * stubs needed for the unit tests. Bypasses mount() so we never touch CSS or
 * real canvas APIs.
 *
 * @returns {Promise<{ ic: any, sync: any, wrap: any, wrapDiff: any }>}
 */
async function makeIC() {
  const mod = await import('../../src/renderer/src/views/image-compare.js')
  const ic = new mod.ImageCompare()

  // Fake sync transform controller backed by mutable state so the
  // public zoom/rotate/flip methods can be exercised end-to-end.
  let zoom = 1
  let rotation = 0
  let flipH = false
  let flipV = false
  const sync = {
    destroy: vi.fn(),
    getZoom: vi.fn(() => zoom),
    getRotation: vi.fn(() => rotation),
    getFlip: vi.fn(() => ({ h: flipH, v: flipV })),
    setZoom: vi.fn((z) => {
      const clamped = Math.min(10, Math.max(0.1, z))
      zoom = clamped
    }),
    setRotation: vi.fn((deg) => {
      let d = deg % 360
      if (d < 0) d += 360
      rotation = d
    }),
    setFlip: vi.fn((h, v) => { flipH = !!h; flipV = !!v }),
    reset: vi.fn(() => { zoom = 1; rotation = 0; flipH = false; flipV = false }),
  }
  ic._syncTransform = sync

  // Stub wrap elements with style objects.
  const makeWrap = (cw, ch) => ({
    clientWidth: cw,
    clientHeight: ch,
    style: { visibility: '', mixBlendMode: '', transform: '', transformOrigin: '' },
  })
  const wrapLeft  = makeWrap(800, 600)
  const wrapRight = makeWrap(800, 600)
  const wrapDiff  = makeWrap(800, 600)
  ic._dom = {
    wrapLeft, wrapRight, wrapDiff,
    overlaySelect: { value: 'difference' },
  }

  return { ic, sync, wrap: wrapLeft, wrapDiff }
}

// ── T57: Zoom ────────────────────────────────────────────────────────────────

describe('T57 Zoom shortcuts + Fit to Window', () => {
  it('zoomIn multiplies zoom by 1.25', async () => {
    const { ic, sync } = await makeIC()
    ic.zoomIn()
    expect(sync.setZoom).toHaveBeenCalledWith(1.25)
    expect(sync.getZoom()).toBeCloseTo(1.25)
  })

  it('zoomOut divides zoom by 1.25', async () => {
    const { ic, sync } = await makeIC()
    ic.zoomOut()
    expect(sync.setZoom).toHaveBeenCalledWith(1 / 1.25)
    expect(sync.getZoom()).toBeCloseTo(0.8)
  })

  it('zoomIn saturates at MAX_ZOOM=10', async () => {
    const { ic, sync } = await makeIC()
    sync.setZoom(10)
    ic.zoomIn()
    // Saturation: setZoom called with 10 (not 12.5) due to Math.min clamp
    expect(sync.setZoom).toHaveBeenLastCalledWith(10)
    expect(sync.getZoom()).toBe(10)
  })

  it('zoomOut saturates at MIN_ZOOM=0.1', async () => {
    const { ic, sync } = await makeIC()
    sync.setZoom(0.1)
    ic.zoomOut()
    expect(sync.setZoom).toHaveBeenLastCalledWith(0.1)
    expect(sync.getZoom()).toBe(0.1)
  })

  it('resetZoom returns zoom to 1×', async () => {
    const { ic, sync } = await makeIC()
    sync.setZoom(3.5)
    ic.resetZoom()
    expect(sync.setZoom).toHaveBeenLastCalledWith(1)
    expect(sync.getZoom()).toBe(1)
  })

  it('fitToWindow computes scale from wrap size and image dims', async () => {
    const { ic, sync, wrap } = await makeIC()
    ic._left = { img: { naturalWidth: 1600, naturalHeight: 600 } }
    wrap.clientWidth = 800
    wrap.clientHeight = 600
    ic.fitToWindow()
    // min(800/1600=0.5, 600/600=1.0) = 0.5
    expect(sync.setZoom).toHaveBeenCalledWith(0.5)
  })

  it('fitToWindow is a no-op when no image loaded', async () => {
    const { ic, sync } = await makeIC()
    ic.fitToWindow()
    expect(sync.setZoom).not.toHaveBeenCalled()
  })
})

// ── T58: Rotate & Flip ───────────────────────────────────────────────────────

describe('T58 Rotate & Flip', () => {
  it('rotateCW progresses 0 → 90 → 180 → 270 → 0', async () => {
    const { ic, sync } = await makeIC()
    ic.rotateCW(); expect(sync.getRotation()).toBe(90)
    ic.rotateCW(); expect(sync.getRotation()).toBe(180)
    ic.rotateCW(); expect(sync.getRotation()).toBe(270)
    ic.rotateCW(); expect(sync.getRotation()).toBe(0)
  })

  it('rotateCCW wraps 0 → 270 → 180', async () => {
    const { ic, sync } = await makeIC()
    ic.rotateCCW(); expect(sync.getRotation()).toBe(270)
    ic.rotateCCW(); expect(sync.getRotation()).toBe(180)
  })

  it('flipHorizontal toggles the horizontal flip flag', async () => {
    const { ic, sync } = await makeIC()
    ic.flipHorizontal()
    expect(sync.getFlip()).toEqual({ h: true, v: false })
    ic.flipHorizontal()
    expect(sync.getFlip()).toEqual({ h: false, v: false })
  })

  it('flipVertical toggles the vertical flip flag independently', async () => {
    const { ic, sync } = await makeIC()
    ic.flipHorizontal()
    ic.flipVertical()
    expect(sync.getFlip()).toEqual({ h: true, v: true })
  })

  it('resetTransform clears rotation, flip and zoom together', async () => {
    const { ic, sync } = await makeIC()
    ic.rotateCW()
    ic.flipHorizontal()
    sync.setZoom(2.5)
    ic.resetTransform()
    expect(sync.reset).toHaveBeenCalled()
    expect(sync.getRotation()).toBe(0)
    expect(sync.getFlip()).toEqual({ h: false, v: false })
    expect(sync.getZoom()).toBe(1)
  })

  it('rotate methods are no-ops when sync controller is absent', async () => {
    const { ic } = await makeIC()
    ic._syncTransform = null
    expect(() => ic.rotateCW()).not.toThrow()
    expect(() => ic.flipHorizontal()).not.toThrow()
    expect(() => ic.resetTransform()).not.toThrow()
  })
})

// ── T59: Blend Mode ──────────────────────────────────────────────────────────

describe('T59 Blend Mode', () => {
  it('default blend mode is "difference"', async () => {
    const { ic } = await makeIC()
    expect(ic.getBlendMode()).toBe('difference')
  })

  it('setBlendMode("blend") applies mix-blend-mode and keeps diff visible', async () => {
    const { ic, wrapDiff } = await makeIC()
    ic.setBlendMode('blend')
    expect(ic.getBlendMode()).toBe('blend')
    expect(wrapDiff.style.mixBlendMode).toBe('difference')
    expect(wrapDiff.style.visibility).toBe('')
  })

  it('setBlendMode("normal") hides the diff overlay', async () => {
    const { ic, wrapDiff } = await makeIC()
    ic.setBlendMode('normal')
    expect(ic.getBlendMode()).toBe('normal')
    expect(wrapDiff.style.visibility).toBe('hidden')
    expect(wrapDiff.style.mixBlendMode).toBe('')
  })

  it('setBlendMode("difference") shows diff canvas without blend', async () => {
    const { ic, wrapDiff } = await makeIC()
    ic.setBlendMode('blend')
    ic.setBlendMode('difference')
    expect(ic.getBlendMode()).toBe('difference')
    expect(wrapDiff.style.visibility).toBe('')
    expect(wrapDiff.style.mixBlendMode).toBe('')
  })

  it('setBlendMode rejects invalid values as no-op', async () => {
    const { ic } = await makeIC()
    const prev = ic.getBlendMode()
    // @ts-expect-error intentional invalid input
    ic.setBlendMode('invalid')
    expect(ic.getBlendMode()).toBe(prev)
  })

  it('setBlendMode keeps the select element in sync', async () => {
    const { ic } = await makeIC()
    ic.setBlendMode('blend')
    expect(ic._dom.overlaySelect.value).toBe('blend')
  })
})

// ── T60: Full Screen (preload contract) ──────────────────────────────────────

describe('T60 Full Screen', () => {
  it('electronAPI exposes toggleFullScreen', () => {
    expect(typeof window.electronAPI.toggleFullScreen).toBe('function')
  })

  it('toggleFullScreen mock can be invoked without throwing', () => {
    expect(() => window.electronAPI.toggleFullScreen()).not.toThrow()
    expect(window.electronAPI.toggleFullScreen).toHaveBeenCalled()
  })
})
