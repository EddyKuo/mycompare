/**
 * Application menu e2e.
 *
 * Verifies the BC-style menu bar is installed in the main process and that
 * clicking an item reaches the renderer's dispatch table.
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

/** Top-level menu labels, read from the main process. */
async function topLevelLabels() {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    return menu ? menu.items.map((i) => i.label) : null
  })
}

test('an application menu is installed', async () => {
  const labels = await topLevelLabels()
  expect(labels).not.toBeNull()
  expect(labels.length).toBeGreaterThan(0)
})

test('menu bar exposes the Beyond Compare top-level structure', async () => {
  const labels = (await topLevelLabels()).join('|')
  for (const expected of ['工作階段', '檔案', '編輯', '搜尋', '檢視', '工具', '說明']) {
    expect(labels).toContain(expected)
  }
})

test('every command item carries a click handler', async () => {
  const missing = await app.evaluate(({ Menu }) => {
    const bad = []
    /** @param {import('electron').MenuItem[]} items @param {string} path */
    const walk = (items, path) => {
      for (const it of items) {
        const here = `${path} > ${it.label}`
        if (it.submenu) {
          walk(it.submenu.items, here)
        } else if (it.type === 'normal' && !it.role && typeof it.click !== 'function') {
          bad.push(here)
        }
      }
    }
    walk(Menu.getApplicationMenu().items, '')
    return bad
  })
  expect(missing).toEqual([])
})

test('Session > New > 文字比對 opens a text compare tab', async () => {
  await app.evaluate(({ Menu }) => {
    const find = (items, label) => {
      for (const it of items) {
        if (it.label === label) return it
        if (it.submenu) {
          const hit = find(it.submenu.items, label)
          if (hit) return hit
        }
      }
      return null
    }
    find(Menu.getApplicationMenu().items, '文字比對').click()
  })

  await expect(win.locator('#view-text')).toBeVisible()
  await expect(win.locator('#tab-bar')).toBeVisible()
})

test('View > 切換主題 flips the document theme', async () => {
  const before = await win.evaluate(() => document.documentElement.dataset.theme)

  await app.evaluate(({ Menu }) => {
    const find = (items, label) => {
      for (const it of items) {
        if (it.label === label) return it
        if (it.submenu) {
          const hit = find(it.submenu.items, label)
          if (hit) return hit
        }
      }
      return null
    }
    find(Menu.getApplicationMenu().items, '切換主題').click()
  })

  await expect
    .poll(() => win.evaluate(() => document.documentElement.dataset.theme))
    .not.toBe(before)
})

test('the encoding submenu offers both sides and the common encodings', async () => {
  const found = await app.evaluate(({ Menu }) => {
    const walk = (items, path, out) => {
      for (const it of items) {
        const here = path ? `${path} > ${it.label}` : it.label
        if (it.submenu) walk(it.submenu.items, here, out)
        else out.push(here)
      }
      return out
    }
    return walk(Menu.getApplicationMenu().items, '', [])
  })

  const enc = found.filter((l) => l.includes('以指定編碼重新載入'))
  expect(enc.some((l) => l.includes('左側') && l.endsWith('Big5'))).toBe(true)
  expect(enc.some((l) => l.includes('右側') && l.endsWith('Shift_JIS'))).toBe(true)
  expect(enc.some((l) => l.endsWith('UTF-8'))).toBe(true)
})

test('choosing an encoding outside a text compare reports rather than throwing', async () => {
  // Start from the home screen so no text view is active.
  await win.evaluate(() => document.getElementById('btn-new-session')?.click())

  await app.evaluate(({ Menu }) => {
    const find = (items, pred) => {
      for (const it of items) {
        if (it.submenu) {
          const hit = find(it.submenu.items, pred)
          if (hit) return hit
        } else if (pred(it)) return it
      }
      return null
    }
    find(Menu.getApplicationMenu().items, (it) => it.label === 'Big5').click()
  })

  await expect
    .poll(() => win.evaluate(() => document.getElementById('status-message')?.textContent))
    .toContain('請先開啟文字比對')
})
