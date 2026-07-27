/**
 * S15-U01: Image Compare e2e smoke tests.
 *
 * Verifies the image view mounts, renders the three canvas panels, and that
 * injecting a tiny PNG produces a non-zero diff canvas.
 *
 * Run with: npm run test:e2e
 * Prerequisite: npm run build
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

test.beforeAll(async () => { ({ app, win } = await launchApp()) })
test.afterAll(async () => { await closeApp(app) })

async function goToImageCompare(page) {
  const viewImage = page.locator('#view-image')
  if (await viewImage.isVisible()) return
  await page.locator('#btn-new-session').click()
  await expect(page.locator('#session-home')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-type="image"].session-type-btn').click()
  await expect(viewImage).toBeVisible({ timeout: 5000 })
}

// A 2x2 red PNG (base64) — minimum valid encoded image.
const TINY_RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const TINY_BLUE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNkYPj/HwAEAQH/AGZE0wAAAABJRU5ErkJggg=='

test('Image 比對視圖：三個 canvas panel 都掛載', async () => {
  await goToImageCompare(win)
  await expect(win.locator('.ic-canvas-left')).toBeAttached()
  await expect(win.locator('.ic-canvas-right')).toBeAttached()
  await expect(win.locator('.ic-canvas-diff')).toBeAttached()
})

test('Image 注入兩張不同圖片後 diff canvas 尺寸 > 0', async () => {
  await goToImageCompare(win)
  await win.evaluate(async ([l, r]) => {
    await window.__testAPI?.imageSetLeft('left.png',  l, 'png')
    await window.__testAPI?.imageSetRight('right.png', r, 'png')
  }, [TINY_RED_PNG_B64, TINY_BLUE_PNG_B64])

  await win.waitForFunction(() => {
    const s = window.__testAPI?.imageGetDiffCanvasSize()
    return s && s.w > 0 && s.h > 0
  }, { timeout: 5000 })

  const size = await win.evaluate(() => window.__testAPI?.imageGetDiffCanvasSize())
  expect(size.w).toBeGreaterThan(0)
  expect(size.h).toBeGreaterThan(0)
})

test('Image 工具列含 zoom 按鈕', async () => {
  await goToImageCompare(win)
  // T57 zoom controls
  await expect(win.locator('[title*="放大"], [title*="Zoom In"], [aria-label*="Zoom In"]').first()).toBeAttached()
})

// ── S16: outcome assertions ──────────────────────────────────────────────────
//
// The tests above confirm the canvases exist. These confirm the comparison
// actually produced the right answer, which a non-zero canvas size does not.

/**
 * Build a solid-colour PNG in the renderer.
 * Generated rather than pasted as base64 so the size and colour the assertions
 * depend on are visible here.
 */
async function makePng(page, w, h, css) {
  return page.evaluate(([width, height, colour]) => {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    ctx.fillStyle = colour
    ctx.fillRect(0, 0, width, height)
    return c.toDataURL('image/png').split(',')[1]
  }, [w, h, css])
}

async function inject(page, left, right) {
  await page.evaluate(async ([l, r]) => {
    await window.__testAPI?.imageSetLeft('left.png', l, 'png')
    await window.__testAPI?.imageSetRight('right.png', r, 'png')
  }, [left, right])
}

test('相同圖片：差異像素為 0', async () => {
  await goToImageCompare(win)
  const png = await makePng(win, 16, 16, '#3366cc')
  await inject(win, png, png)

  await win.waitForFunction(() => {
    const s = window.__testAPI?.imageGetDiffCanvasSize()
    return s && s.w === 16 && s.h === 16
  }, { timeout: 5000 })

  const stats = await win.evaluate(() => window.__testAPI?.imageGetStats())
  expect(stats).toMatch(/差異像素\s*0\b/)
})

test('全黑 vs 全白：每個像素都是差異', async () => {
  await goToImageCompare(win)
  const black = await makePng(win, 16, 16, '#000000')
  const white = await makePng(win, 16, 16, '#ffffff')
  await inject(win, black, white)

  await win.waitForFunction(() => {
    const s = window.__testAPI?.imageGetStats()
    return typeof s === 'string' && s.length > 0
  }, { timeout: 5000 })

  const stats = await win.evaluate(() => window.__testAPI?.imageGetStats())
  // 訊息長「差異像素 N / 總像素 256」——256 是總數，每一則訊息都有。
  // 原本只斷言 toContain('256')，即使一個像素都沒差也會通過。
  expect(stats).toMatch(/差異像素\s*256\b/)
})

test('尺寸不同時 diff canvas 取兩者聯集，內容不被裁掉', async () => {
  await goToImageCompare(win)
  const left = await makePng(win, 8, 8, '#ff0000')
  const right = await makePng(win, 16, 4, '#ff0000')
  await inject(win, left, right)

  await win.waitForFunction(() => {
    const s = window.__testAPI?.imageGetDiffCanvasSize()
    return s && s.w === 16 && s.h === 8
  }, { timeout: 5000 })

  const size = await win.evaluate(() => window.__testAPI?.imageGetDiffCanvasSize())
  expect(size).toEqual({ w: 16, h: 8 })
})

test('單一像素的差異不會被無視', async () => {
  // 只比對尺寸、或把差異四捨五入掉的實作，會通過上面每一條測試而漏掉這條。
  await goToImageCompare(win)
  const plain = await makePng(win, 16, 16, '#000000')
  const oneOff = await win.evaluate(([base]) => {
    const img = new Image()
    return new Promise((resolve) => {
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = 16; c.height = 16
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, 1, 1)
        resolve(c.toDataURL('image/png').split(',')[1])
      }
      img.src = `data:image/png;base64,${base}`
    })
  }, [plain])

  await inject(win, plain, oneOff)
  await win.waitForFunction(() => {
    const s = window.__testAPI?.imageGetDiffCanvasSize()
    return s && s.w === 16
  }, { timeout: 5000 })

  const stats = await win.evaluate(() => window.__testAPI?.imageGetStats())
  expect(stats).toMatch(/差異像素\s*1\b/)
})

test('統計文字會隨結果改變，不是固定字串', async () => {
  await goToImageCompare(win)
  const black = await makePng(win, 16, 16, '#000000')
  const white = await makePng(win, 16, 16, '#ffffff')

  await inject(win, black, black)
  await win.waitForFunction(() => (window.__testAPI?.imageGetStats() ?? '').length > 0,
    { timeout: 5000 })
  const same = await win.evaluate(() => window.__testAPI?.imageGetStats())

  await inject(win, black, white)
  await win.waitForFunction((prev) => {
    const s = window.__testAPI?.imageGetStats() ?? ''
    return s.length > 0 && s !== prev
  }, same, { timeout: 5000 })
  const differ = await win.evaluate(() => window.__testAPI?.imageGetStats())

  expect(differ).not.toBe(same)
})

test('工具列每個控制項都留在視窗內', async () => {
  // 本專案中過兩次的缺陷：工具列換行後渲染到畫布下方，按鈕存在但點不到。
  // 這種問題單元測試抓不到。
  await goToImageCompare(win)
  const offscreen = await win.evaluate(() => {
    const bad = []
    for (const ctl of document.querySelectorAll('#view-image button, #view-image select')) {
      const r = ctl.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.bottom > window.innerHeight || r.right > window.innerWidth || r.top < 0) {
        bad.push(ctl.textContent?.trim() || ctl.className)
      }
    }
    return bad
  })
  expect(offscreen).toEqual([])
})
