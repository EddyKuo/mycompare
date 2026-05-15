/**
 * @vitest-environment jsdom
 *
 * Sprint 8 tests: T46 Show Filter, T47 Visible Whitespace,
 * T48 Line Numbers, T49 Font Size, T50 Over/Under Layout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks required before import ─────────────────────────────────────────────

Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: {
      openFile:    vi.fn(),
      saveFile:    vi.fn(),
      readFile:    vi.fn(),
      watchFile:   vi.fn(),
      unwatchFile: vi.fn(),
      onFileChanged: vi.fn(),
    },
    getSelection: vi.fn(() => null),
  },
  writable: true,
})

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a TextCompare instance with minimal DOM stubs, bypassing mount().
 */
async function makeTC() {
  const mod = await import('../../src/renderer/src/views/text-compare.js')
  const tc = new mod.TextCompare()
  tc._mounted = true
  tc._contentLeft  = {
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
  tc._findBar    = null
  tc._findInput  = null
  tc._findCount  = null
  tc._statusEol      = null
  tc._statusEncoding = null
  tc._statusLines    = null
  tc._statusMessage  = null
  tc._diffCounter    = null
  tc._minimap        = null
  tc._minimapViewport = null
  tc._pathLeft   = null
  tc._pathRight  = null
  tc._compareArea = document.createElement('div')
  tc._compareArea.className = 'compare-area'
  return tc
}

/**
 * Build a minimal diff result with some equal and some diff lines.
 * @returns {Array}
 */
function makeDiffResult() {
  return [
    { type: 'equal',   leftLine: 1,  rightLine: 1,  leftText: 'same\n',   rightText: 'same\n' },
    { type: 'delete',  leftLine: 2,  rightLine: null, leftText: 'old\n',  rightText: '' },
    { type: 'insert',  leftLine: null, rightLine: 2, leftText: '',        rightText: 'new\n' },
    { type: 'equal',   leftLine: 3,  rightLine: 3,  leftText: 'ctx1\n',  rightText: 'ctx1\n' },
    { type: 'equal',   leftLine: 4,  rightLine: 4,  leftText: 'ctx2\n',  rightText: 'ctx2\n' },
    { type: 'replace', leftLine: 5,  rightLine: 5,  leftText: 'foo\n',   rightText: 'bar\n' },
    { type: 'equal',   leftLine: 6,  rightLine: 6,  leftText: 'end\n',   rightText: 'end\n' },
  ]
}

// ── T46: Show Filter ─────────────────────────────────────────────────────────

describe('TextCompare._buildRows — T46 showFilter=\'diff\'', () => {
  it('returns only diff lines and their context rows when filter=diff', async () => {
    const tc = await makeTC()
    tc._opts.contextLines = 1
    tc._diffResult = makeDiffResult()

    tc._showFilter = 'diff'
    tc._buildRows()

    // Only diff lines + 1-line context around them should appear
    const kinds = tc._rows.map(r => r.kind)
    expect(kinds.every(k => k === 'line')).toBe(true)

    const types = tc._rows.map(r => r.diffLine?.type)
    // Must include at least one diff type
    expect(types.some(t => t !== 'equal')).toBe(true)
  })

  it('includes NO rows when all diff lines have no context and filter=diff, but equal-only diff has no diff rows', async () => {
    const tc = await makeTC()
    tc._opts.contextLines = 0
    tc._diffResult = [
      { type: 'equal', leftLine: 1, rightLine: 1, leftText: 'a\n', rightText: 'a\n' },
      { type: 'equal', leftLine: 2, rightLine: 2, leftText: 'b\n', rightText: 'b\n' },
    ]

    tc._showFilter = 'diff'
    tc._buildRows()

    // No diff lines → 0 context rows
    expect(tc._rows).toHaveLength(0)
  })

  it('returns empty rows when filter=none', async () => {
    const tc = await makeTC()
    tc._diffResult = makeDiffResult()

    tc._showFilter = 'none'
    tc._buildRows()

    expect(tc._rows).toHaveLength(0)
  })

  it('returns only equal-type rows when filter=same', async () => {
    const tc = await makeTC()
    tc._diffResult = makeDiffResult()

    tc._showFilter = 'same'
    tc._buildRows()

    expect(tc._rows.length).toBeGreaterThan(0)
    for (const row of tc._rows) {
      expect(row.kind).toBe('line')
      expect(row.diffLine.type).toBe('equal')
    }
  })

  it('returns no diff lines when filter=same', async () => {
    const tc = await makeTC()
    tc._diffResult = makeDiffResult()

    tc._showFilter = 'same'
    tc._buildRows()

    const hasDiff = tc._rows.some(r => r.diffLine?.type !== 'equal')
    expect(hasDiff).toBe(false)
  })

  it('normal context-collapse behavior preserved when filter=all', async () => {
    const tc = await makeTC()
    tc._opts.contextLines = 1

    // All-equal long run should produce a collapsed row
    const manyEqual = Array.from({ length: 20 }, (_, i) => ({
      type: 'equal', leftLine: i + 1, rightLine: i + 1,
      leftText: `line${i+1}\n`, rightText: `line${i+1}\n`,
    }))
    manyEqual[10] = { type: 'replace', leftLine: 11, rightLine: 11, leftText: 'x\n', rightText: 'y\n' }

    tc._showFilter = 'all'
    tc._diffResult = manyEqual
    tc._buildRows()

    const hasCollapsed = tc._rows.some(r => r.kind === 'collapsed')
    expect(hasCollapsed).toBe(true)
  })

  it('setShowFilter triggers _buildRows and _render', async () => {
    const tc = await makeTC()
    tc._diffResult = makeDiffResult()
    tc._buildRows()
    tc._buildDiffBlocks = vi.fn()
    tc._render = vi.fn()
    tc._buildMinimap = vi.fn()

    tc.setShowFilter('diff')

    expect(tc._buildDiffBlocks).toHaveBeenCalledOnce()
    expect(tc._render).toHaveBeenCalledOnce()
    expect(tc._buildMinimap).toHaveBeenCalledOnce()
    expect(tc._showFilter).toBe('diff')
  })

  it('setShowFilter ignores invalid filter values', async () => {
    const tc = await makeTC()
    tc._showFilter = 'all'
    tc._buildDiffBlocks = vi.fn()
    tc._render = vi.fn()
    tc._buildMinimap = vi.fn()

    tc.setShowFilter('invalid')

    expect(tc._showFilter).toBe('all')
    expect(tc._render).not.toHaveBeenCalled()
  })
})

// ── T47: Visible Whitespace ──────────────────────────────────────────────────

describe('applyVisibleWhitespace — T47', () => {
  it('replaces spaces with middle dot ·', async () => {
    const mod = await import('../../src/renderer/src/views/text-compare.js')
    const result = mod.applyVisibleWhitespace('hello world')
    expect(result).toBe('hello·world')
  })

  it('replaces tabs with arrow →', async () => {
    const mod = await import('../../src/renderer/src/views/text-compare.js')
    const result = mod.applyVisibleWhitespace('\tfoo\tbar')
    expect(result).toBe('→foo→bar')
  })

  it('handles mixed spaces and tabs', async () => {
    const mod = await import('../../src/renderer/src/views/text-compare.js')
    const result = mod.applyVisibleWhitespace('  \t  ')
    expect(result).toBe('··→··')
  })

  it('leaves non-whitespace characters unchanged', async () => {
    const mod = await import('../../src/renderer/src/views/text-compare.js')
    const result = mod.applyVisibleWhitespace('abc123!@#')
    expect(result).toBe('abc123!@#')
  })

  it('empty string returns empty string', async () => {
    const mod = await import('../../src/renderer/src/views/text-compare.js')
    const result = mod.applyVisibleWhitespace('')
    expect(result).toBe('')
  })
})

describe('TextCompare.toggleWhitespace — T47', () => {
  it('toggleWhitespace returns true on first call (default off → on)', async () => {
    const tc = await makeTC()
    tc._render = vi.fn()

    const result = tc.toggleWhitespace()

    expect(result).toBe(true)
    expect(tc._showWhitespace).toBe(true)
    expect(tc._render).toHaveBeenCalledOnce()
  })

  it('toggleWhitespace returns false on second call (on → off)', async () => {
    const tc = await makeTC()
    tc._render = vi.fn()

    tc.toggleWhitespace()
    const result = tc.toggleWhitespace()

    expect(result).toBe(false)
    expect(tc._showWhitespace).toBe(false)
  })

  it('toggleWhitespace sets active class on button when enabled', async () => {
    const tc = await makeTC()
    tc._render = vi.fn()
    const btn = document.createElement('button')
    tc._btnWhitespace = btn

    tc.toggleWhitespace()

    expect(btn.classList.contains('active')).toBe(true)
  })

  it('toggleWhitespace removes active class on button when disabled', async () => {
    const tc = await makeTC()
    tc._render = vi.fn()
    const btn = document.createElement('button')
    btn.classList.add('active')
    tc._btnWhitespace = btn

    tc._showWhitespace = true
    tc.toggleWhitespace()

    expect(btn.classList.contains('active')).toBe(false)
  })
})

// ── T48: Line Numbers ─────────────────────────────────────────────────────────

describe('TextCompare.toggleLineNumbers — T48', () => {
  it('toggleLineNumbers adds hide-line-numbers class to compareArea when toggled off', async () => {
    const tc = await makeTC()
    // Default is on (showLineNumbers=true), first toggle → off
    tc.toggleLineNumbers()

    expect(tc._compareArea.classList.contains('hide-line-numbers')).toBe(true)
    expect(tc._showLineNumbers).toBe(false)
  })

  it('toggleLineNumbers removes hide-line-numbers class when toggled back on', async () => {
    const tc = await makeTC()
    tc.toggleLineNumbers() // off
    tc.toggleLineNumbers() // on

    expect(tc._compareArea.classList.contains('hide-line-numbers')).toBe(false)
    expect(tc._showLineNumbers).toBe(true)
  })

  it('toggleLineNumbers returns false when line numbers are hidden', async () => {
    const tc = await makeTC()
    const result = tc.toggleLineNumbers()
    expect(result).toBe(false)
  })

  it('toggleLineNumbers returns true when line numbers are shown', async () => {
    const tc = await makeTC()
    tc.toggleLineNumbers()   // false
    const result = tc.toggleLineNumbers() // true again
    expect(result).toBe(true)
  })

  it('_applyLineNumbers sets class correctly based on _showLineNumbers', async () => {
    const tc = await makeTC()
    tc._showLineNumbers = false
    tc._applyLineNumbers()
    expect(tc._compareArea.classList.contains('hide-line-numbers')).toBe(true)

    tc._showLineNumbers = true
    tc._applyLineNumbers()
    expect(tc._compareArea.classList.contains('hide-line-numbers')).toBe(false)
  })
})

// ── T49: Font Size ────────────────────────────────────────────────────────────

describe('TextCompare.setFontSize — T49', () => {
  it('setFontSize clamps value to minimum 10', async () => {
    const tc = await makeTC()
    tc._buildRows = vi.fn()
    tc._render    = vi.fn()
    tc._buildMinimap = vi.fn()

    tc.setFontSize(5)

    expect(tc._fontSize).toBe(10)
  })

  it('setFontSize clamps value to maximum 24', async () => {
    const tc = await makeTC()
    tc._buildRows = vi.fn()
    tc._render    = vi.fn()
    tc._buildMinimap = vi.fn()

    tc.setFontSize(30)

    expect(tc._fontSize).toBe(24)
  })

  it('setFontSize within range sets exact value', async () => {
    const tc = await makeTC()
    tc._buildRows = vi.fn()
    tc._render    = vi.fn()
    tc._buildMinimap = vi.fn()

    tc.setFontSize(16)

    expect(tc._fontSize).toBe(16)
  })

  it('setFontSize triggers _buildRows and _render when value changes', async () => {
    const tc = await makeTC()
    tc._buildRows = vi.fn()
    tc._render    = vi.fn()
    tc._buildMinimap = vi.fn()

    tc.setFontSize(15)

    expect(tc._buildRows).toHaveBeenCalledOnce()
    expect(tc._render).toHaveBeenCalledOnce()
    expect(tc._buildMinimap).toHaveBeenCalledOnce()
  })

  it('setFontSize does NOT trigger re-render when size is unchanged', async () => {
    const tc = await makeTC()
    tc._buildRows = vi.fn()
    tc._render    = vi.fn()
    tc._buildMinimap = vi.fn()

    tc.setFontSize(tc._fontSize) // same value (default 13)

    expect(tc._buildRows).not.toHaveBeenCalled()
    expect(tc._render).not.toHaveBeenCalled()
  })

  it('fontSize getter returns current font size', async () => {
    const tc = await makeTC()
    tc._buildRows = vi.fn()
    tc._render    = vi.fn()
    tc._buildMinimap = vi.fn()

    tc.setFontSize(18)

    expect(tc.fontSize).toBe(18)
  })

  it('_applyFontSize sets font-size on contentLeft and contentRight', async () => {
    const tc = await makeTC()
    tc._fontSize = 16
    tc._applyFontSize()

    expect(tc._contentLeft.style.fontSize).toBe('16px')
    expect(tc._contentRight.style.fontSize).toBe('16px')
  })

  it('_onKeyDownFontSize handler: Ctrl+= increases size', async () => {
    const tc = await makeTC()
    tc.setFontSize = vi.fn()
    tc._fontSize = 13

    tc._onKeyDownFontSize = (e) => {
      if (!tc._mounted) return
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        tc.setFontSize(tc._fontSize + 1)
      } else if (e.ctrlKey && e.key === '-') {
        e.preventDefault()
        tc.setFontSize(tc._fontSize - 1)
      } else if (e.ctrlKey && e.key === '0') {
        e.preventDefault()
        tc.setFontSize(13)
      }
    }

    tc._onKeyDownFontSize({ ctrlKey: true, key: '=', preventDefault: vi.fn() })
    expect(tc.setFontSize).toHaveBeenCalledWith(14)
  })

  it('_onKeyDownFontSize handler: Ctrl+- decreases size', async () => {
    const tc = await makeTC()
    tc.setFontSize = vi.fn()
    tc._fontSize = 13

    tc._onKeyDownFontSize = (e) => {
      if (!tc._mounted) return
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        tc.setFontSize(tc._fontSize + 1)
      } else if (e.ctrlKey && e.key === '-') {
        e.preventDefault()
        tc.setFontSize(tc._fontSize - 1)
      } else if (e.ctrlKey && e.key === '0') {
        e.preventDefault()
        tc.setFontSize(13)
      }
    }

    tc._onKeyDownFontSize({ ctrlKey: true, key: '-', preventDefault: vi.fn() })
    expect(tc.setFontSize).toHaveBeenCalledWith(12)
  })

  it('_onKeyDownFontSize handler: Ctrl+0 resets to 13', async () => {
    const tc = await makeTC()
    tc.setFontSize = vi.fn()
    tc._fontSize = 20

    tc._onKeyDownFontSize = (e) => {
      if (!tc._mounted) return
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        tc.setFontSize(tc._fontSize + 1)
      } else if (e.ctrlKey && e.key === '-') {
        e.preventDefault()
        tc.setFontSize(tc._fontSize - 1)
      } else if (e.ctrlKey && e.key === '0') {
        e.preventDefault()
        tc.setFontSize(13)
      }
    }

    tc._onKeyDownFontSize({ ctrlKey: true, key: '0', preventDefault: vi.fn() })
    expect(tc.setFontSize).toHaveBeenCalledWith(13)
  })
})

// ── T50: Over/Under Layout ────────────────────────────────────────────────────

describe('TextCompare.toggleLayout — T50', () => {
  it('toggleLayout switches from side-by-side to over-under', async () => {
    const tc = await makeTC()
    tc._drawGutter = vi.fn()
    expect(tc._layoutMode).toBe('side-by-side')

    const result = tc.toggleLayout()

    expect(result).toBe('over-under')
    expect(tc._layoutMode).toBe('over-under')
  })

  it('toggleLayout switches back from over-under to side-by-side', async () => {
    const tc = await makeTC()
    tc._drawGutter = vi.fn()

    tc.toggleLayout() // side-by-side → over-under
    const result = tc.toggleLayout() // over-under → side-by-side

    expect(result).toBe('side-by-side')
    expect(tc._layoutMode).toBe('side-by-side')
  })

  it('_applyLayout adds over-under class to compareArea', async () => {
    const tc = await makeTC()
    tc._drawGutter = vi.fn()
    tc._layoutMode = 'over-under'

    tc._applyLayout()

    expect(tc._compareArea.classList.contains('over-under')).toBe(true)
  })

  it('_applyLayout removes over-under class when side-by-side', async () => {
    const tc = await makeTC()
    tc._drawGutter = vi.fn()
    tc._compareArea.classList.add('over-under')
    tc._layoutMode = 'side-by-side'

    tc._applyLayout()

    expect(tc._compareArea.classList.contains('over-under')).toBe(false)
  })

  it('toggleLayout calls _drawGutter for gutter resize', async () => {
    const tc = await makeTC()
    tc._drawGutter = vi.fn()

    tc.toggleLayout()

    expect(tc._drawGutter).toHaveBeenCalledOnce()
  })

  it('toggleLayout updates button text when available', async () => {
    const tc = await makeTC()
    tc._drawGutter = vi.fn()
    const btn = document.createElement('button')
    btn.textContent = '⬛ Side'
    tc._btnLayout = btn

    tc.toggleLayout() // → over-under

    expect(btn.textContent).toBe('⊟ Over')

    tc.toggleLayout() // → side-by-side

    expect(btn.textContent).toBe('⬛ Side')
  })
})
