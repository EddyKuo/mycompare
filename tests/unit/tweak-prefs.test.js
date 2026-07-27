/**
 * @vitest-environment jsdom
 *
 * The three tuning preferences on the 進階調整 page.
 *
 * Like the four folder preferences, these had controls that stored a value and
 * nothing that read it. What each test asserts is that the stored number
 * reaches the behaviour — the size of the rendered window, how many files a
 * sort prefetch is willing to ask about, how many reads run at once — rather
 * than that a getter returns what was set.
 *
 * The other half matters just as much here: the shipped defaults must equal
 * the constants they override, or turning the page into a preference would
 * have silently retuned the app for everyone who never opens it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { SettingsStore, DEFAULT_PREFS } from '../../src/renderer/src/core/settings-store.js'
import { setActiveView } from '../../src/renderer/src/core/active-view.js'
import { FolderCompare } from '../../src/renderer/src/views/folder-compare.js'

vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: () => {},
}))

const settings = new SettingsStore()

/** @type {FolderCompare[]} */
let mountedViews = []

beforeEach(() => {
  localStorage.clear()
  setActiveView('folder')
})

afterEach(() => {
  for (const fc of mountedViews) fc.destroy()
  mountedViews = []
  document.body.innerHTML = ''
  delete window.electronAPI
})

/** @param {object} [over] */
function stubApi(over = {}) {
  const api = {
    readDir: vi.fn().mockResolvedValue([]),
    openFolder: vi.fn().mockResolvedValue(null),
    hashFile: vi.fn().mockResolvedValue('h'),
    ...over,
  }
  window.electronAPI = api
  return api
}

/** @param {number} rowCount */
function mountWithRows(rowCount, columns = ['name', 'size']) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const fc = new FolderCompare({})
  fc.mount(host)
  mountedViews.push(fc)
  fc.setColumns(columns)
  fc._leftPath = '/left'
  fc._rightPath = '/right'
  fc._rows = Array.from({ length: rowCount }, (_, i) => {
    const shared = { name: `f${i}.js`, isDirectory: false, size: 10, mtime: '2024-01-01T00:00:00.000Z' }
    return {
      name: `f${i}.js`,
      status: 'same',
      left: { ...shared, path: `/left/f${i}.js` },
      right: { ...shared, path: `/right/f${i}.js` },
      children: null,
    }
  })
  fc._applyFilterAndRender()
  return fc
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('the defaults match the constants they override', () => {
  it('does not retune the app for someone who never opens the page', () => {
    // Picking round numbers here — 4 against a real concurrency of 8, 10
    // against an overscan of 4 — would change how the app behaves for every
    // user, which is what the picture defaults on this same dialog did.
    expect(DEFAULT_PREFS.tweakConcurrency).toBe(8)
    expect(DEFAULT_PREFS.tweakVirtualOverscan).toBe(4)
    expect(DEFAULT_PREFS.tweakPrefetchLimit).toBe(2000)
  })
})

describe('tweakVirtualOverscan', () => {
  it('a larger overscan renders more rows than a smaller one', async () => {
    stubApi()
    settings.setPref('tweakVirtualOverscan', 0)
    const few = mountWithRows(400)
    await settle()
    const small = document.querySelectorAll('.fc-row').length

    document.body.innerHTML = ''
    for (const fc of mountedViews) fc.destroy()
    mountedViews = []

    settings.setPref('tweakVirtualOverscan', 60)
    mountWithRows(400)
    await settle()
    const large = document.querySelectorAll('.fc-row').length

    expect(small).toBeGreaterThan(0)
    // The whole point of the setting: it changes the size of the drawn window.
    expect(large).toBeGreaterThan(small)
    void few
  })

  it('a non-numeric value falls back rather than rendering nothing', async () => {
    stubApi()
    settings.setPref('tweakVirtualOverscan', 'lots')
    mountWithRows(400)
    await settle()
    expect(document.querySelectorAll('.fc-row').length).toBeGreaterThan(0)
  })
})

describe('tweakPrefetchLimit', () => {
  it('caps how many files a sort prefetch asks about', async () => {
    // 30 rows, two sides each, against a ceiling of 12.
    const fileOwners = vi.fn(async (paths) =>
      paths.map((path) => ({ path, owner: 'u', group: 'g', error: '' })))
    stubApi({ fileOwners })
    settings.setPref('tweakPrefetchLimit', 12)

    const fc = mountWithRows(30, ['name', 'owner'])
    await settle(); await settle()
    fileOwners.mockClear()
    fc._ownerCache.clear()

    await fc.prefetchOwnersForSort()

    const asked = fileOwners.mock.calls.flatMap((c) => c[0])
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.length).toBeLessThanOrEqual(12)
  })

  it('never raises a column past its own budget', async () => {
    // The checksum column stops lower on purpose — each of its reads hashes a
    // whole file. One preference lifting every column to the same number would
    // undo that on the most expensive one, so this is a ceiling, not a
    // replacement.
    const hashFile = vi.fn().mockResolvedValue('h')
    stubApi({ hashFile })
    settings.setPref('tweakPrefetchLimit', 100000)

    const fc = mountWithRows(1200, ['name', 'crc'])
    await settle(); await settle()
    hashFile.mockClear()

    await fc.prefetchCrcForSort()

    // MAX_CRC_PREFETCH is 500; the preference must not have lifted it.
    expect(hashFile.mock.calls.length).toBeLessThanOrEqual(500)
  })

  it('a zero or negative value keeps the column budget instead of asking nothing', async () => {
    // Storing 0 must not mean "prefetch nothing", which would look exactly
    // like a sort that silently stopped working.
    const fileOwners = vi.fn(async (paths) =>
      paths.map((path) => ({ path, owner: 'u', group: 'g', error: '' })))
    stubApi({ fileOwners })
    settings.setPref('tweakPrefetchLimit', 0)

    const fc = mountWithRows(20, ['name', 'owner'])
    await settle(); await settle()
    fileOwners.mockClear()
    fc._ownerCache.clear()

    await fc.prefetchOwnersForSort()
    expect(fileOwners.mock.calls.flatMap((c) => c[0]).length).toBeGreaterThan(0)
  })
})

describe('tweakConcurrency', () => {
  /**
   * Run the content pass and report the highest number of hashFile calls that
   * were ever in flight together.
   * @param {number} limit
   * @returns {Promise<{peak: number, calls: number}>}
   */
  async function peakInFlight(limit) {
    let inFlight = 0
    let peak = 0
    const hashFile = vi.fn(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return 'h'
    })
    stubApi({ hashFile })
    settings.setPref('tweakConcurrency', limit)

    const fc = mountWithRows(40)
    for (const row of fc._rows) row.status = 'different'
    await fc._applyContentHash(fc._rows)

    document.body.innerHTML = ''
    for (const v of mountedViews) v.destroy()
    mountedViews = []
    return { peak, calls: hashFile.mock.calls.length }
  }

  it('bounds how many reads run at once, and the number is the setting', async () => {
    const low = await peakInFlight(2)
    const high = await peakInFlight(8)

    // Guard the premise. An earlier version of this test had a fallback branch
    // that let a zero-call run pass, which would have reported a working limit
    // for code that never ran.
    expect(low.calls, 'the content pass did no work').toBeGreaterThan(4)

    // The limit counts row pairs, and each pair hashes both sides at once, so
    // the ceiling on concurrent reads is twice the setting. Asserting the
    // setting itself here would fail for a correct implementation.
    expect(low.peak).toBeGreaterThan(0)
    expect(low.peak).toBeLessThanOrEqual(4)

    // And it actually tracks the value rather than being a fixed cap that
    // happens to sit below it.
    expect(high.peak).toBeGreaterThan(low.peak)
    expect(high.peak).toBeLessThanOrEqual(16)
  })
})
