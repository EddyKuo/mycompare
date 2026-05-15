/**
 * @vitest-environment jsdom
 *
 * Sprint 8 — Integration-level edge-case tests for T46–T50.
 *
 * Fills gaps not covered by text-compare-view.test.js:
 *   - T46: real-DOM button active-state synchronisation across all 4 filters.
 *   - T47: applyVisibleWhitespace pure-function edge cases + toggleWhitespace return value.
 *   - T48: DOM class application + idempotency after two toggles.
 *   - T49: CSS custom property propagation (--tc-font-size / --tc-row-height) +
 *          upper-bound saturation when repeatedly increasing.
 *   - T50: over-under class + button textContent round-trip.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks required before import ─────────────────────────────────────────────

Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: {
      openFile:      vi.fn(),
      saveFile:      vi.fn(),
      readFile:      vi.fn(),
      watchFile:     vi.fn(),
      unwatchFile:   vi.fn(),
      onFileChanged: vi.fn(),
    },
    getSelection: vi.fn(() => null),
  },
  writable: true,
})

/**
 * Build a TextCompare instance with minimal DOM stubs, bypassing mount().
 * Mirrors helper in text-compare-view.test.js.
 * @returns {Promise<object>}
 */
async function makeTC() {
  const mod = await import('../../src/renderer/src/views/text-compare.js')
  const tc = new mod.TextCompare()
  tc._mounted = true
  tc._contentLeft = {
    scrollTop: 0, clientHeight: 600, scrollHeight: 1000,
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    contains: vi.fn(() => true),
    style: {},
    scrollTo: vi.fn(),
  }
  tc._contentRight = {
    scrollTop: 0, clientHeight: 600, scrollHeight: 1000,
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    contains: vi.fn(() => false),
    style: {},
    scrollTo: vi.fn(),
  }
  tc._findBar = null
  tc._findInput = null
  tc._findCount = null
  tc._statusEol = null
  tc._statusEncoding = null
  tc._statusLines = null
  tc._statusMessage = null
  tc._diffCounter = null
  tc._minimap = null
  tc._minimapViewport = null
  tc._pathLeft = null
  tc._pathRight = null
  tc._compareArea = document.createElement('div')
  tc._compareArea.className = 'compare-area'
  return tc
}

// ─────────────────────────────────────────────────────────────────────────────
// T46 — Show Filter button state synchronisation (real DOM)
// ─────────────────────────────────────────────────────────────────────────────

describe('T46 Show Filter — button active-state sync (integration)', () => {
  /** @type {Record<string, HTMLButtonElement>} */
  let buttons

  beforeEach(() => {
    buttons = /** @type {Record<string, HTMLButtonElement>} */ ({})
    for (const id of ['btn-show-all', 'btn-show-diff', 'btn-show-same', 'btn-show-none']) {
      const btn = document.createElement('button')
      btn.id = id
      document.body.appendChild(btn)
      buttons[id] = btn
    }
  })

  afterEach(() => {
    for (const btn of Object.values(buttons)) document.body.removeChild(btn)
  })

  it('marks exactly one button active per filter switch', async () => {
    const tc = await makeTC()
    // Bind buttons (mount() would normally do this)
    tc._btnShowAll  = buttons['btn-show-all']
    tc._btnShowDiff = buttons['btn-show-diff']
    tc._btnShowSame = buttons['btn-show-same']
    tc._btnShowNone = buttons['btn-show-none']
    tc._diffResult = []
    tc._buildDiffBlocks = vi.fn()
    tc._render = vi.fn()
    tc._buildMinimap = vi.fn()

    tc.setShowFilter('diff')
    expect(buttons['btn-show-diff'].classList.contains('active')).toBe(true)
    expect(buttons['btn-show-all'].classList.contains('active')).toBe(false)
    expect(buttons['btn-show-same'].classList.contains('active')).toBe(false)
    expect(buttons['btn-show-none'].classList.contains('active')).toBe(false)

    tc.setShowFilter('same')
    expect(buttons['btn-show-diff'].classList.contains('active')).toBe(false)
    expect(buttons['btn-show-same'].classList.contains('active')).toBe(true)

    tc.setShowFilter('all')
    expect(buttons['btn-show-all'].classList.contains('active')).toBe(true)
    expect(buttons['btn-show-same'].classList.contains('active')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T47 — applyVisibleWhitespace edge cases + toggleWhitespace return value
// ─────────────────────────────────────────────────────────────────────────────

describe('T47 Visible Whitespace — edge cases', () => {
  it('preserves newlines untouched (no spaces/tabs in pure-newline input)', async () => {
    const mod = await import('../../src/renderer/src/views/text-compare.js')
    const out = mod.applyVisibleWhitespace('\n\n\n')
    expect(out).toBe('\n\n\n')
  })

  it('converts both leading and trailing whitespace on the same line', async () => {
    const mod = await import('../../src/renderer/src/views/text-compare.js')
    const out = mod.applyVisibleWhitespace('  hello \t')
    expect(out).toBe('··hello·→')
  })

  it('toggleWhitespace returns the new boolean state value', async () => {
    const tc = await makeTC()
    tc._render = vi.fn()

    const first = tc.toggleWhitespace()
    expect(first).toBe(true)
    expect(typeof first).toBe('boolean')

    const second = tc.toggleWhitespace()
    expect(second).toBe(false)
    expect(typeof second).toBe('boolean')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T48 — Line numbers: DOM class application + idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('T48 Line Numbers — DOM class round-trip', () => {
  it('toggling twice restores original (no class) state', async () => {
    const tc = await makeTC()
    expect(tc._compareArea.classList.contains('hide-line-numbers')).toBe(false)

    tc.toggleLineNumbers() // → hidden
    expect(tc._compareArea.classList.contains('hide-line-numbers')).toBe(true)

    tc.toggleLineNumbers() // → visible again
    expect(tc._compareArea.classList.contains('hide-line-numbers')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T49 — Font size: CSS custom-property propagation + upper-bound saturation
// ─────────────────────────────────────────────────────────────────────────────

describe('T49 Font Size — CSS custom properties + saturation', () => {
  it('setFontSize(18) propagates to --tc-font-size and --tc-row-height (size+7)', async () => {
    const tc = await makeTC()
    tc._buildRows = vi.fn()
    tc._render = vi.fn()
    tc._buildMinimap = vi.fn()

    tc.setFontSize(18)

    expect(tc._compareArea.style.getPropertyValue('--tc-font-size')).toBe('18px')
    // Per _applyFontSize: rowH = size + 7
    expect(tc._compareArea.style.getPropertyValue('--tc-row-height')).toBe('25px')
  })

  it('repeatedly increasing font size saturates at maximum 24', async () => {
    const tc = await makeTC()
    tc._buildRows = vi.fn()
    tc._render = vi.fn()
    tc._buildMinimap = vi.fn()

    // Default 13; 20 +1 increments should clamp at 24.
    for (let i = 0; i < 20; i++) {
      tc.setFontSize(tc._fontSize + 1)
    }
    expect(tc._fontSize).toBe(24)
    expect(tc._compareArea.style.getPropertyValue('--tc-font-size')).toBe('24px')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T50 — Over-Under layout: class + button textContent round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('T50 Over-Under Layout — class and button text round-trip', () => {
  /** @type {HTMLButtonElement} */
  let btnLayout

  beforeEach(() => {
    btnLayout = document.createElement('button')
    btnLayout.id = 'btn-layout-toggle'
    btnLayout.textContent = '⬛ Side'
    document.body.appendChild(btnLayout)
  })

  afterEach(() => {
    document.body.removeChild(btnLayout)
  })

  it('toggleLayout flips class + button text, second toggle reverts both', async () => {
    const tc = await makeTC()
    tc._drawGutter = vi.fn()
    tc._btnLayout = btnLayout

    // First toggle: side-by-side → over-under
    tc.toggleLayout()
    expect(tc._compareArea.classList.contains('over-under')).toBe(true)
    expect(btnLayout.textContent).toBe('⊟ Over')
    expect(btnLayout.classList.contains('active')).toBe(true)

    // Second toggle: back to side-by-side
    tc.toggleLayout()
    expect(tc._compareArea.classList.contains('over-under')).toBe(false)
    expect(btnLayout.textContent).toBe('⬛ Side')
    expect(btnLayout.classList.contains('active')).toBe(false)
  })
})
