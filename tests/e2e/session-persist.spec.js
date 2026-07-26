/**
 * Session persistence e2e.
 *
 * The store, its schema and the Recent Sessions UI all existed, but nothing
 * ever called store.save(), so the list was permanently empty. These tests
 * drive the renderer the way the app does and assert something is recorded.
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

test.beforeAll(async () => {
  ;({ app, win } = await launchApp())
})

test.afterAll(async () => {
  await closeApp(app)
})

test.beforeEach(async () => {
  await win.evaluate(() => {
    localStorage.removeItem('mycompare:sessions')
    localStorage.removeItem('mycompare:recent')
    localStorage.removeItem('mycompare:sessionGroups')
  })
})

test('opening a hex comparison records a session', async () => {
  await win.evaluate(() => {
    document.querySelector('.session-type-btn[data-type="hex"]')?.click()
  })
  await win.evaluate(() => {
    window.__testAPI?.hexSetLeft('C:\\tmp\\a.bin', btoa('hello'))
    window.__testAPI?.hexSetRight('C:\\tmp\\b.bin', btoa('world'))
  })

  const entries = await win.evaluate(() => {
    const raw = localStorage.getItem('mycompare:sessions')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // Entries are stored as serialised JSON strings, one per session.
    return Object.values(parsed.entries ?? parsed).map((v) =>
      typeof v === 'string' ? JSON.parse(v) : v)
  })

  expect(entries).not.toBeNull()
  expect(entries.length).toBeGreaterThan(0)

  const hex = entries.find((e) => e.type === 'hex')
  expect(hex, 'a hex session should have been recorded').toBeTruthy()
  expect(hex.options.leftPath).toContain('a.bin')
  expect(hex.options.rightPath).toContain('b.bin')
})

test('the Recent Sessions list is no longer empty', async () => {
  await win.evaluate(() => {
    document.querySelector('.session-type-btn[data-type="hex"]')?.click()
  })
  await win.evaluate(() => {
    window.__testAPI?.hexSetLeft('C:\\tmp\\x.bin', btoa('abc'))
    window.__testAPI?.hexSetRight('C:\\tmp\\y.bin', btoa('abd'))
  })

  // Return home and re-render the list.
  await win.evaluate(() => document.getElementById('btn-new-session')?.click())

  await expect
    .poll(() => win.evaluate(() => document.querySelectorAll('.recent-sessions .recent-item').length))
    .toBeGreaterThan(0)
})

test('updating paths reuses the same session rather than piling up duplicates', async () => {
  await win.evaluate(() => {
    document.querySelector('.session-type-btn[data-type="hex"]')?.click()
  })
  for (const [l, r] of [['1', '2'], ['3', '4'], ['5', '6']]) {
    await win.evaluate(([a, b]) => {
      window.__testAPI?.hexSetLeft(`C:\\tmp\\${a}.bin`, btoa(a))
      window.__testAPI?.hexSetRight(`C:\\tmp\\${b}.bin`, btoa(b))
    }, [l, r])
  }

  const count = await win.evaluate(() => {
    const raw = localStorage.getItem('mycompare:sessions')
    if (!raw) return 0
    const parsed = JSON.parse(raw)
    return Object.keys(parsed.entries ?? parsed).length
  })
  // One tab, one session record — not one per path change.
  expect(count).toBe(1)
})

test('sessions can be filed into folders on the home screen', async () => {
  // Record a session so there is something to file.
  await win.evaluate(() => {
    document.querySelector('.session-type-btn[data-type="hex"]')?.click()
  })
  await win.evaluate(() => {
    window.__testAPI?.hexSetLeft('C:\tmp\g1.bin', btoa('aaa'))
    window.__testAPI?.hexSetRight('C:\tmp\g2.bin', btoa('bbb'))
  })
  await win.evaluate(() => document.getElementById('btn-new-session')?.click())
  await expect(win.locator('.recent-sessions .recent-item')).toHaveCount(1)

  // Create a folder without going through prompt(), which cannot be driven.
  await win.evaluate(() => {
    window.prompt = () => '專案 A'
    ;[...document.querySelectorAll('.session-action-btn')]
      .find((b) => b.textContent.includes('新增資料夾'))?.click()
  })
  await expect(win.locator('.recent-sessions .recent-group')).toHaveCount(1)

  // File the session into it.
  const groupId = await win.evaluate(() => {
    const sel = document.querySelector('.recent-item .ri-group')
    const opt = [...sel.options].find((o) => o.textContent.includes('專案 A'))
    sel.value = opt.value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return opt.value
  })
  expect(groupId).toBeTruthy()

  const stored = await win.evaluate(() => {
    const raw = localStorage.getItem('mycompare:sessionGroups')
    return raw ? JSON.parse(raw) : null
  })
  expect(Object.values(stored.membership)).toContain(groupId)

  // The session now renders under the folder header rather than at the root.
  const order = await win.evaluate(() =>
    [...document.querySelectorAll('.recent-sessions .recent-list > *')]
      .map((el) => el.className))
  expect(order[0]).toContain('recent-group')
  expect(order[1]).toContain('recent-item')
})

test('deleting a folder keeps the sessions filed under it', async () => {
  // Self-contained: beforeEach clears storage, so this builds its own state.
  await win.evaluate(() => {
    document.querySelector('.session-type-btn[data-type="hex"]')?.click()
  })
  await win.evaluate(() => {
    window.__testAPI?.hexSetLeft('C:\tmp\d1.bin', btoa('aaa'))
    window.__testAPI?.hexSetRight('C:\tmp\d2.bin', btoa('bbb'))
  })
  await win.evaluate(() => document.getElementById('btn-new-session')?.click())

  await win.evaluate(() => {
    window.prompt = () => '待刪除'
    ;[...document.querySelectorAll('.session-action-btn')]
      .find((b) => b.textContent.includes('新增資料夾'))?.click()
    const sel = document.querySelector('.recent-item .ri-group')
    const opt = [...sel.options].find((o) => o.textContent.includes('待刪除'))
    sel.value = opt.value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(win.locator('.recent-sessions .recent-group')).toHaveCount(1)

  await win.evaluate(() => document.querySelector('.recent-sessions .rg-remove')?.click())

  // Losing a folder must not lose the work filed under it.
  await expect(win.locator('.recent-sessions .recent-group')).toHaveCount(0)
  await expect(win.locator('.recent-sessions .recent-item')).toHaveCount(1)
})
