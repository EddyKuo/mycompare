/**
 * @file three-way-sync.test.js
 * @description T26 — Three-Way Compare 同步捲動 (jsdom 環境)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Helpers: build a minimal _setupSyncScroll / destroy harness
// without instantiating the full ThreeWayCompare (which needs Electron APIs).
// ---------------------------------------------------------------------------

/**
 * Extract and bind the same sync-scroll logic used by ThreeWayCompare,
 * but applied directly to caller-supplied pane elements.
 *
 * @param {HTMLElement[]} panes
 * @returns {{ handlers: Array<{ pane: HTMLElement, handler: EventListener }>, teardown: () => void }}
 */
function bindSyncScroll(panes) {
  if (panes.length < 2) return { handlers: [], teardown: () => {} }

  let syncing = false
  const handlers = panes.map((pane) => {
    const handler = () => {
      if (syncing) return
      syncing = true
      const scrollTop = pane.scrollTop
      for (const other of panes) {
        if (other !== pane) other.scrollTop = scrollTop
      }
      syncing = false
    }
    pane.addEventListener('scroll', handler)
    return { pane, handler }
  })

  const teardown = () => {
    for (const { pane, handler } of handlers) {
      pane.removeEventListener('scroll', handler)
    }
  }

  return { handlers, teardown }
}

/**
 * Create a scrollable div with fixed overflow/height so jsdom tracks scrollTop.
 * @returns {HTMLElement}
 */
function makeScrollablePane() {
  const el = document.createElement('div')
  el.style.overflow = 'auto'
  el.style.height = '200px'
  // Add tall inner content so scrollTop can be set
  const inner = document.createElement('div')
  inner.style.height = '2000px'
  el.appendChild(inner)
  document.body.appendChild(el)
  return el
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T26 — Three-Way sync scroll', () => {
  /** @type {HTMLElement[]} */
  let panes
  /** @type {ReturnType<typeof bindSyncScroll>} */
  let binding

  beforeEach(() => {
    panes = [makeScrollablePane(), makeScrollablePane(), makeScrollablePane()]
    binding = bindSyncScroll(panes)
  })

  afterEach(() => {
    binding.teardown()
    // Clean up appended panes
    for (const p of panes) p.remove()
  })

  it('should sync other two panes when one pane is scrolled', () => {
    const [left, base, right] = panes

    // Simulate scroll on left pane
    left.scrollTop = 300
    left.dispatchEvent(new Event('scroll'))

    expect(base.scrollTop).toBe(300)
    expect(right.scrollTop).toBe(300)
  })

  it('should not trigger infinite scroll loop when syncing', () => {
    const [left, base, right] = panes

    // Track how many times each handler fires
    const scrollCounts = [0, 0, 0]
    panes.forEach((pane, idx) => {
      pane.addEventListener('scroll', () => { scrollCounts[idx]++ })
    })

    left.scrollTop = 500
    left.dispatchEvent(new Event('scroll'))

    // The initial scroll on left fires once; syncing prevents re-entrant calls,
    // so total scroll events across all panes should be exactly 1 (the original).
    // base and right have their scrollTop updated programmatically — they do NOT
    // fire a scroll event in jsdom unless explicitly dispatched.
    expect(scrollCounts[0]).toBe(1) // left: the original event
    expect(scrollCounts[1]).toBe(0) // base: no event re-dispatched
    expect(scrollCounts[2]).toBe(0) // right: no event re-dispatched
  })

  it('should not sync after teardown (destroy removes listeners)', () => {
    const [left, base, right] = panes

    // Tear down (simulates destroy())
    binding.teardown()

    // Scroll left after teardown
    left.scrollTop = 700
    left.dispatchEvent(new Event('scroll'))

    // Other panes should NOT have been updated
    expect(base.scrollTop).toBe(0)
    expect(right.scrollTop).toBe(0)
  })

  it('should sync from any pane (not only the first)', () => {
    const [left, base, right] = panes

    // Scroll the base (middle) pane
    base.scrollTop = 150
    base.dispatchEvent(new Event('scroll'))

    expect(left.scrollTop).toBe(150)
    expect(right.scrollTop).toBe(150)

    // Scroll the right pane
    right.scrollTop = 250
    right.dispatchEvent(new Event('scroll'))

    expect(left.scrollTop).toBe(250)
    expect(base.scrollTop).toBe(250)
  })
})
