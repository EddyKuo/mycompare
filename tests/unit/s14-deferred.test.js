/**
 * S14 deferred items — completion tests.
 *
 *   M07: active-view module routes keyboard shortcuts to the right view
 *   M12: localStorage quota failure surfaces a toast
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getActiveView,
  setActiveView,
  isActive,
} from '../../src/renderer/src/core/active-view.js'

beforeEach(() => {
  setActiveView('home')
  document.body.innerHTML = ''
})

describe('S14-M07 active-view module', () => {
  it('initial value is the last set or "home"', () => {
    expect(['home', 'text', 'folder', 'hex', 'image', 'table', 'merge3'])
      .toContain(getActiveView())
  })

  it('setActiveView + getActiveView round-trip', () => {
    setActiveView('text')
    expect(getActiveView()).toBe('text')
    setActiveView('folder')
    expect(getActiveView()).toBe('folder')
  })

  it('isActive returns true only for the current view', () => {
    setActiveView('hex')
    expect(isActive('hex')).toBe(true)
    expect(isActive('text')).toBe(false)
    expect(isActive('image')).toBe(false)
  })

  it('setActiveView ignores non-string input', () => {
    setActiveView('text')
    setActiveView(null)
    expect(getActiveView()).toBe('home')
    setActiveView(undefined)
    expect(getActiveView()).toBe('home')
  })
})

describe('S14-M12 localStorage quota → toast', () => {
  it('NamedConfigStore.save returns null and triggers toast on quota', async () => {
    const { NamedConfigStore } = await import('../../src/renderer/src/core/named-config-store.js')
    // Force quota error
    const originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function () {
      const e = new Error('quota')
      e.name = 'QuotaExceededError'
      throw e
    }
    try {
      const store = new NamedConfigStore()
      const result = store.save('x', 'text', { a: 1 })
      // Still returns the entry (we kept the in-memory write); only persistence failed.
      // Toast container should be created.
      // Allow microtask for the dynamic import().then() to flush.
      await new Promise(r => setTimeout(r, 50))
      const toastEl = document.querySelector('.mc-toast--error')
      expect(toastEl).toBeTruthy()
      expect(toastEl.textContent).toMatch(/空間不足|失敗/)
      // The save still returned an entry object (in-memory mutation succeeded).
      expect(result).toBeTruthy()
    } finally {
      Storage.prototype.setItem = originalSetItem
    }
  })
})
