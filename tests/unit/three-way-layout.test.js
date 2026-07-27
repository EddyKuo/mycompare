/**
 * @vitest-environment jsdom
 *
 * Three-way merge pane layout: hide the base pane, maximise the output or the
 * sources, hide the line-number gutter.
 *
 * The risk these tests exist for is not "does the class get added" but "does
 * the synchronised scroll survive a pane being collapsed and brought back".
 * jsdom performs no layout, so a hidden element there still stores whatever
 * scrollTop is written to it — the browser does not. Where that difference
 * matters the test zeroes the hidden pane by hand to model the browser, and
 * says so; the e2e suite covers the real thing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  ThreeWayCompare,
  MAXIMIZE_MODES,
  isMaximizeMode,
} from '../../src/renderer/src/views/three-way-compare.js'

const ROW_HEIGHT = 18

/** @param {number} n */
function bigText(n, changedAt = -1, tag = 'X') {
  return Array.from({ length: n }, (_, i) =>
    (i === changedAt ? `${tag}${i}` : `line${i}`)).join('\n')
}

/** @type {ThreeWayCompare} */
let view
/** @type {HTMLElement} */
let host

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  view = new ThreeWayCompare()
  view.mount(host)
})

afterEach(() => {
  view.destroy()
  host.remove()
})

/** @returns {HTMLElement} */
const layout = () => host.querySelector('.mw-layout')
/** @param {string} sel @returns {HTMLElement} */
const q = (sel) => host.querySelector(sel)

describe('MaximizeMode guard', () => {
  it('accepts exactly the three documented modes', () => {
    expect(MAXIMIZE_MODES).toEqual(['none', 'output', 'sources'])
    for (const m of MAXIMIZE_MODES) expect(isMaximizeMode(m)).toBe(true)
  })

  it('rejects anything else', () => {
    for (const bad of ['detached', '', null, undefined, 0, {}, ['output']]) {
      expect(isMaximizeMode(bad)).toBe(false)
    }
  })
})

describe('base (centre) pane visibility', () => {
  it('is shown by default', () => {
    expect(view.isBaseVisible()).toBe(true)
    expect(layout().classList.contains('mw-layout--no-base')).toBe(false)
  })

  it('hides the pane and the divider that would be left orphaned', () => {
    view.toggleBaseVisible()
    expect(view.isBaseVisible()).toBe(false)
    expect(layout().classList.contains('mw-layout--no-base')).toBe(true)
    // One divider stays: with the base gone the layout is left | divider | right.
    expect(q('.mw-pane-divider--lb')).not.toBeNull()
  })

  it('toggles back', () => {
    view.toggleBaseVisible()
    view.toggleBaseVisible()
    expect(view.isBaseVisible()).toBe(true)
    expect(layout().classList.contains('mw-layout--no-base')).toBe(false)
  })

  it('keeps the base pane element in the DOM so its rows are not rebuilt', () => {
    view.setSide('base', bigText(200))
    const before = q('.mw-content-base')
    view.setBaseVisible(false)
    expect(q('.mw-content-base')).toBe(before)
    expect(view.getPaneRows('base').length).toBe(200)
  })

  it('reports the change so the host status bar can say what happened', () => {
    /** @type {string[]} */
    const seen = []
    view.on('status', (e) => seen.push(e.message))
    view.setBaseVisible(false)
    view.setBaseVisible(true)
    expect(seen).toEqual(['已隱藏基準窗格', '已顯示基準窗格'])
  })

  it('does not emit when the state is already what was asked for', () => {
    let n = 0
    view.on('status', () => { n++ })
    view.setBaseVisible(true)
    expect(n).toBe(0)
  })
})

describe('maximise output / sources', () => {
  it('starts at none', () => {
    expect(view.getMaximize()).toBe('none')
    expect(layout().classList.contains('mw-layout--max-output')).toBe(false)
    expect(layout().classList.contains('mw-layout--max-sources')).toBe(false)
  })

  it('maximising the output collapses the sources', () => {
    view.toggleMaximizeOutput()
    expect(view.getMaximize()).toBe('output')
    expect(layout().classList.contains('mw-layout--max-output')).toBe(true)
  })

  it('the two modes are mutually exclusive', () => {
    view.setMaximize('output')
    view.setMaximize('sources')
    expect(view.getMaximize()).toBe('sources')
    expect(layout().classList.contains('mw-layout--max-output')).toBe(false)
    expect(layout().classList.contains('mw-layout--max-sources')).toBe(true)
  })

  it('pressing the same control again restores the four-pane layout', () => {
    view.toggleMaximizeSources()
    view.toggleMaximizeSources()
    expect(view.getMaximize()).toBe('none')
    expect(layout().className).not.toMatch(/mw-layout--max-/)
  })

  it('ignores an unknown mode rather than blanking the view', () => {
    view.setMaximize('output')
    view.setMaximize(/** @type {never} */ ('detached'))
    expect(view.getMaximize()).toBe('output')
  })

  it('parks the dragged output height and gives it back on restore', () => {
    const pane = q('.mw-output-pane')
    pane.style.height = '340px'

    view.setMaximize('output')
    // An inline height would pin the maximised pane to 340px, which is the
    // opposite of what the mode is for.
    expect(pane.style.height).toBe('')

    view.setMaximize('none')
    expect(pane.style.height).toBe('340px')
  })

  it('survives switching between the two modes without losing the height', () => {
    const pane = q('.mw-output-pane')
    pane.style.height = '250px'
    view.setMaximize('output')
    view.setMaximize('sources')
    expect(pane.style.height).toBe('')
    view.setMaximize('none')
    expect(pane.style.height).toBe('250px')
  })

  it('leaves the output header reachable when the sources are maximised', () => {
    view.setMaximize('sources')
    // The Save and restore controls live in the header; the CSS only collapses
    // the content below it, so the elements must still be present.
    expect(q('.mw-output-header')).not.toBeNull()
    expect(q('.mw-btn-save')).not.toBeNull()
    expect(q('.mw-btn-max-sources')).not.toBeNull()
  })
})

describe('line-number gutter', () => {
  it('is on by default and toggles', () => {
    expect(view.getLineNumbers()).toBe(true)
    view.toggleLineNumbers()
    expect(view.getLineNumbers()).toBe(false)
    expect(layout().classList.contains('mw-layout--no-linenum')).toBe(true)
    view.toggleLineNumbers()
    expect(layout().classList.contains('mw-layout--no-linenum')).toBe(false)
  })

  it('keeps the gutter elements so line numbers are not lost, only hidden', () => {
    view.setSide('base', bigText(20))
    view.setLineNumbers(false)
    // Hiding is CSS; the data has to stay because marking a conflict maps a
    // selection back onto these very rows.
    expect(host.querySelectorAll('.mw-linenum').length).toBeGreaterThan(0)
    expect(host.querySelector('.mw-line[data-line]')).not.toBeNull()
  })
})

describe('sync scroll survives layout changes', () => {
  beforeEach(() => {
    view.setSide('left', bigText(4000, 2000, 'L'))
    view.setSide('base', bigText(4000))
    view.setSide('right', bigText(4000, 2000, 'R'))
  })

  const panes = () => ['left', 'base', 'right'].map((s) => q(`.mw-content-${s}`))

  it('a scroll on one pane is recorded and mirrored onto the others', () => {
    const [left] = panes()
    left.scrollTop = 900 * ROW_HEIGHT
    left.dispatchEvent(new Event('scroll'))

    for (const p of panes()) expect(p.scrollTop).toBe(900 * ROW_HEIGHT)
  })

  it('hiding then showing the base puts it back on the shared offset', () => {
    const [left, base, right] = panes()
    left.scrollTop = 1200 * ROW_HEIGHT
    left.dispatchEvent(new Event('scroll'))

    view.setBaseVisible(false)
    // A real browser drops the offset of a display:none pane and ignores
    // writes to it. jsdom does neither, so the loss is applied by hand here —
    // otherwise this test would pass even if _restoreScroll were deleted.
    base.scrollTop = 0

    view.setBaseVisible(true)
    expect(base.scrollTop).toBe(1200 * ROW_HEIGHT)
    expect(left.scrollTop).toBe(1200 * ROW_HEIGHT)
    expect(right.scrollTop).toBe(1200 * ROW_HEIGHT)
  })

  it('maximising the output and coming back keeps all three panes aligned', () => {
    const [left, base, right] = panes()
    left.scrollTop = 800 * ROW_HEIGHT
    left.dispatchEvent(new Event('scroll'))

    view.setMaximize('output')
    for (const p of panes()) p.scrollTop = 0   // model the collapsed panes

    view.setMaximize('none')
    expect(left.scrollTop).toBe(800 * ROW_HEIGHT)
    expect(base.scrollTop).toBe(800 * ROW_HEIGHT)
    expect(right.scrollTop).toBe(800 * ROW_HEIGHT)
  })

  it('repaints the window on the way back rather than leaving a stale one', () => {
    const [left] = panes()
    left.scrollTop = 1500 * ROW_HEIGHT
    left.dispatchEvent(new Event('scroll'))

    const shown = () => [...host.querySelectorAll('.mw-content-left .mw-linetext')]
      .map((el) => el.textContent)
    expect(shown()).toContain('line1500')

    view.setMaximize('output')
    view.setMaximize('none')
    expect(shown()).toContain('line1500')
  })

  it('a merge option change does not scroll the user back to the top', () => {
    const [left] = panes()
    left.scrollTop = 1000 * ROW_HEIGHT
    left.dispatchEvent(new Event('scroll'))

    // Re-rendering the panes used to read the offset out of the DOM; with the
    // sources collapsed every pane reports 0, so the position was lost.
    view.setMaximize('output')
    view.setContextLines(5)
    view.setMaximize('none')

    expect(left.scrollTop).toBe(1000 * ROW_HEIGHT)
  })

  it('conflict navigation still lands on the conflict after a layout change', () => {
    view.setBaseVisible(false)
    view.setMaximize('sources')
    expect(view.getConflictCount()).toBe(1)
    view.firstConflict()

    const [left, , right] = panes()
    expect(left.scrollTop).toBe(right.scrollTop)
    expect(left.scrollTop).toBeGreaterThan(0)
  })
})

describe('toolbar entry points', () => {
  it('every layout control has a button', () => {
    for (const sel of [
      '.mw-btn-toggle-base', '.mw-btn-max-output', '.mw-btn-max-sources',
      '.mw-btn-toggle-linenum', '.mw-btn-reset-layout',
    ]) {
      expect(q(sel), sel).not.toBeNull()
    }
  })

  it('clicking the buttons drives the state', () => {
    q('.mw-btn-toggle-base').click()
    expect(view.isBaseVisible()).toBe(false)

    q('.mw-btn-max-output').click()
    expect(view.getMaximize()).toBe('output')

    q('.mw-btn-max-sources').click()
    expect(view.getMaximize()).toBe('sources')

    q('.mw-btn-toggle-linenum').click()
    expect(view.getLineNumbers()).toBe(false)

    q('.mw-btn-reset-layout').click()
    expect(view.isBaseVisible()).toBe(true)
    expect(view.getMaximize()).toBe('none')
    expect(view.getLineNumbers()).toBe(true)
  })

  it('the buttons show which state they are in', () => {
    const baseBtn = q('.mw-btn-toggle-base')
    const outBtn = q('.mw-btn-max-output')
    expect(baseBtn.textContent).toBe('隱藏基準')
    expect(baseBtn.classList.contains('active')).toBe(false)

    baseBtn.click()
    expect(baseBtn.textContent).toBe('顯示基準')
    expect(baseBtn.classList.contains('active')).toBe(true)

    outBtn.click()
    expect(outBtn.textContent).toBe('還原輸出')
    expect(outBtn.classList.contains('active')).toBe(true)
  })

  it('marking a conflict says the base pane is hidden instead of blaming the selection', () => {
    /** @type {Array<{ message: string, level?: string }>} */
    const seen = []
    view.on('status', (e) => seen.push(e))
    view.setBaseVisible(false)
    q('.mw-btn-mark-conflict').click()

    expect(seen.at(-1).level).toBe('error')
    expect(seen.at(-1).message).toContain('基準窗格')
  })
})

describe('layout state round-trips through getConfig / applyConfig', () => {
  it('carries all three fields', () => {
    view.setBaseVisible(false)
    view.setMaximize('output')
    view.setLineNumbers(false)

    const other = new ThreeWayCompare()
    const otherHost = document.createElement('div')
    document.body.appendChild(otherHost)
    other.mount(otherHost)
    other.applyConfig(view.getConfig())

    expect(other.isBaseVisible()).toBe(false)
    expect(other.getMaximize()).toBe('output')
    expect(other.getLineNumbers()).toBe(false)
    expect(otherHost.querySelector('.mw-layout').classList.contains('mw-layout--no-base')).toBe(true)

    other.destroy()
    otherHost.remove()
  })

  it('rejects a corrupt snapshot without disturbing the current layout', () => {
    view.setMaximize('sources')
    view.applyConfig({
      __v: 1, __view: 'merge3',
      showBase: 'no', maximize: 'detached', showLineNumbers: 42,
    })
    expect(view.isBaseVisible()).toBe(true)
    expect(view.getMaximize()).toBe('sources')
    expect(view.getLineNumbers()).toBe(true)
  })

  it('applies to a view configured before it was mounted', () => {
    const pending = new ThreeWayCompare()
    pending.applyConfig({
      __v: 1, __view: 'merge3',
      showBase: false, maximize: 'sources', showLineNumbers: false,
    })

    const h = document.createElement('div')
    document.body.appendChild(h)
    pending.mount(h)

    const cl = h.querySelector('.mw-layout').classList
    expect(cl.contains('mw-layout--no-base')).toBe(true)
    expect(cl.contains('mw-layout--max-sources')).toBe(true)
    expect(cl.contains('mw-layout--no-linenum')).toBe(true)

    pending.destroy()
    h.remove()
  })
})
