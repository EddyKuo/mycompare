/**
 * @vitest-environment jsdom
 *
 * The toolbar's overflow order, checked against the toolbar it describes.
 *
 * TOOLBAR_OVERFLOW_ORDER is a list of selectors kept next to, but separate
 * from, the code that builds the controls. That is exactly the shape of thing
 * this project has watched drift before: rename a button's class and the
 * selector quietly matches nothing, the item is pinned forever, and nothing
 * fails — the toolbar just runs out of room a little sooner than it should.
 *
 * So each selector is resolved against a real toolbar here. A dead entry fails
 * with the selector named.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FolderCompare, TOOLBAR_OVERFLOW_ORDER } from '../../src/renderer/src/views/folder-compare.js'

/** @returns {{ view: any, toolbar: HTMLElement }} */
function mount() {
  window.electronAPI = {
    readDir: vi.fn().mockResolvedValue([]),
    openFolder: vi.fn().mockResolvedValue(null),
    showInExplorer: vi.fn(),
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new FolderCompare()
  view.mount(host)
  return { view, toolbar: host.querySelector('.fc-toolbar') }
}

beforeEach(() => { document.body.innerHTML = '' })

describe('the overflow order describes the toolbar that exists', () => {
  it('every selector resolves to a toolbar item', () => {
    const { toolbar } = mount()
    const dead = TOOLBAR_OVERFLOW_ORDER.filter((sel) => !toolbar.querySelector(sel))
    expect(dead).toEqual([])
  })

  it('names each item once', () => {
    expect(new Set(TOOLBAR_OVERFLOW_ORDER).size).toBe(TOOLBAR_OVERFLOW_ORDER.length)
  })

  it('resolves every selector to a distinct direct child of the toolbar', () => {
    // Two selectors landing on the same flex item would make the second a
    // no-op: moving an item already in the menu frees nothing, and the loop
    // would stop short of fitting.
    const { view, toolbar } = mount()
    expect(view._overflowItems).toHaveLength(TOOLBAR_OVERFLOW_ORDER.length)
    expect(new Set(view._overflowItems).size).toBe(view._overflowItems.length)
    for (const item of view._overflowItems) expect(item.parentElement).toBe(toolbar)
  })

  it('leaves the controls that own a dropdown pinned', () => {
    // A menu opening inside the `⋯` menu has nowhere to go: the panel scrolls
    // its own overflow, so the inner menu would be clipped by it.
    const { toolbar } = mount()
    for (const sel of ['.fc-batch-wrap', '.fc-compare-wrap', '.fc-select-wrap']) {
      const node = toolbar.querySelector(sel)
      expect(node, sel).toBeTruthy()
      expect(TOOLBAR_OVERFLOW_ORDER.some((s) => node.matches(s) || node.querySelector(s))).toBe(false)
    }
  })
})

describe('laying out without layout', () => {
  it('moves nothing when the toolbar has no measured width', () => {
    // jsdom reports every width as 0. Treating that as "nothing fits" would
    // bury the whole toolbar in the menu; a hidden tab reports the same thing,
    // so this is the real running case too, not only the test one.
    const { view, toolbar } = mount()
    view._layoutToolbar()
    expect(toolbar.querySelector('.fc-overflow-menu').children).toHaveLength(0)
    expect(view._dom.overflowWrap.style.display).toBe('none')
  })
})
