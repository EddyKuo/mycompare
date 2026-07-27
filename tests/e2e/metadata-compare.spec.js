/**
 * Metadata (MP3 tag / PE version) comparison, end to end.
 *
 * Driven the way a user reaches it — home screen ▸ 中繼資料比對 ▸ open two files
 * — rather than by calling the view's methods. This project's recurring defect
 * is a feature that is complete, unit-tested and reached by nothing, and the
 * parser behind this view sat in the main process for two sprints with no
 * screen able to show it.
 *
 * The fixtures are real ID3v2.3 tags written here and parsed by the real
 * main-process code over the real IPC; nothing about the tag data is stubbed.
 *
 * Run with: npm run test:e2e
 * Prerequisite: npm run build
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let dir
/** @type {string} */
let leftMp3
/** @type {string} */
let rightMp3
/** @type {string} */
let fakeExe

/**
 * One ID3v2.3 text frame: 4-char id, big-endian size, flags, encoding byte.
 * @param {string} id
 * @param {string} value
 * @returns {Buffer}
 */
function textFrame(id, value) {
  const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(value, 'latin1')])
  const head = Buffer.alloc(10)
  head.write(id, 0, 'latin1')
  head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([head, payload])
}

/**
 * A minimal but genuine ID3v2.3 tag. The size field is synchsafe — 7 bits per
 * byte — which is exactly the encoding the parser has to get right.
 * @param {Record<string, string>} frames
 * @returns {Buffer}
 */
function id3v2(frames) {
  const body = Buffer.concat(Object.entries(frames).map(([id, v]) => textFrame(id, v)))
  const header = Buffer.alloc(10)
  header.write('ID3', 0, 'latin1')
  header[3] = 3
  const n = body.length
  header[6] = (n >>> 21) & 0x7f
  header[7] = (n >>> 14) & 0x7f
  header[8] = (n >>> 7) & 0x7f
  header[9] = n & 0x7f
  return Buffer.concat([header, body])
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-meta-'))
  leftMp3 = join(dir, 'left.mp3')
  rightMp3 = join(dir, 'right.mp3')
  fakeExe = join(dir, 'thing.exe')

  await writeFile(leftMp3, id3v2({
    TIT2: 'Shared Title', TPE1: 'Alice', TALB: 'First Album', TYER: '2001',
  }))
  await writeFile(rightMp3, id3v2({
    TIT2: 'Shared Title', TPE1: 'Bob', TCOM: 'Carol',
  }))
  // Not a real PE; it exists so the extension-driven routing can be exercised.
  await writeFile(fakeExe, Buffer.from('not really a pe image'))

  // Authorised on the command line: the renderer has no way to add a root.
  ;({ app, win } = await launchApp([dir]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

/** Reach the view the way the home screen does. */
async function goToMetadataCompare(page) {
  const view = page.locator('#view-metadata')
  if (await view.isVisible()) return
  await page.locator('#btn-new-session').click()
  await expect(page.locator('#session-home')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-type="metadata"].session-type-btn').click()
  await expect(view).toBeVisible({ timeout: 5000 })
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} left
 * @param {string} right
 */
async function load(page, left, right) {
  await page.evaluate(async ([l, r]) => {
    await window.__testAPI.metaSetLeft(l)
    await window.__testAPI.metaSetRight(r)
  }, [left, right])
}

test('首頁有中繼資料比對的入口，點下去會掛載該視圖', async () => {
  await goToMetadataCompare(win)
  await expect(win.locator('#view-metadata .metadata-compare')).toBeAttached()
  await expect(win.locator('#view-metadata .mc-row--header')).toBeVisible()
  expect(await win.evaluate(() => window.__testAPI.currentView())).toBe('metadata')
})

test('載入兩個 MP3 後，欄位逐列顯示且狀態正確', async () => {
  await goToMetadataCompare(win)
  await load(win, leftMp3, rightMp3)

  const rows = win.locator('#view-metadata .mc-row:not(.mc-row--header)')
  await expect(rows.first()).toBeVisible({ timeout: 5000 })

  // 真的解析出 ID3 內容，而不只是畫出格子
  const model = await win.evaluate(() => window.__testAPI.metaRows())
  const byField = Object.fromEntries(model.map((r) => [r.field, r]))
  expect(byField.title).toMatchObject({ left: 'Shared Title', right: 'Shared Title', state: 'same' })
  expect(byField.artist).toMatchObject({ left: 'Alice', right: 'Bob', state: 'different' })
  expect(byField.album).toMatchObject({ left: 'First Album', state: 'left-only' })
  expect(byField.composer).toMatchObject({ right: 'Carol', state: 'right-only' })

  // 每種狀態在畫面上都拿得到自己的 class（顏色語意的載體）
  await expect(win.locator('#view-metadata .mc-row--different')).toHaveCount(1)
  await expect(win.locator('#view-metadata .mc-row--left-only')).toHaveCount(2)  // album, year
  await expect(win.locator('#view-metadata .mc-row--right-only')).toHaveCount(1)
  await expect(win.locator('#view-metadata .mc-row[data-field="artist"]'))
    .toHaveAttribute('data-state', 'different')

  const stats = await win.locator('#view-metadata .mc-stats-text').textContent()
  expect(stats).toContain('不同 1')
})

test('差異導航走訪有差異的欄位，並停在最後一個', async () => {
  await goToMetadataCompare(win)
  await load(win, leftMp3, rightMp3)
  await win.waitForFunction(() => window.__testAPI.metaRows().length > 0, { timeout: 5000 })

  await win.evaluate(() => window.__testAPI.menuCommand('search.firstDiff'))
  expect(await win.evaluate(() => window.__testAPI.navDiffIndex())).toBe(0)

  await win.evaluate(() => window.__testAPI.menuCommand('search.nextDiff'))
  expect(await win.evaluate(() => window.__testAPI.navDiffIndex())).toBe(1)
  await expect(win.locator('#view-metadata .mc-row--current')).toHaveCount(1)

  // 走到底之後不再前進，且狀態列說出原因（非環繞為預設）
  const total = await win.evaluate(
    () => window.__testAPI.metaRows().filter((r) => r.state !== 'same').length)
  for (let i = 0; i < total + 2; i++) {
    await win.evaluate(() => window.__testAPI.menuCommand('search.nextDiff'))
  }
  expect(await win.evaluate(() => window.__testAPI.navDiffIndex())).toBe(total - 1)
  expect(await win.evaluate(() => window.__testAPI.navStatusText())).toContain('已到最後一個差異')
})

test('只顯示差異會隱藏相同的欄位，模型不受影響', async () => {
  await goToMetadataCompare(win)
  await load(win, leftMp3, rightMp3)
  const rows = win.locator('#view-metadata .mc-row:not(.mc-row--header)')
  const before = await rows.count()

  await win.locator('#view-metadata .mc-only-diffs-check').check()
  const after = await rows.count()
  expect(after).toBeLessThan(before)
  await expect(win.locator('#view-metadata .mc-row--same')).toHaveCount(0)
  expect((await win.evaluate(() => window.__testAPI.metaRows())).length).toBe(before)

  await win.locator('#view-metadata .mc-only-diffs-check').uncheck()
  await expect(rows).toHaveCount(before)
})

test('.mp3 配對真的落在中繼資料比對，而不是 hex', async () => {
  // Smart Routing 的重點：不指定 type 時，副檔名要把使用者帶到這個視圖。
  await win.evaluate(() => window.__testAPI.menuCommand('session.home'))
  await win.evaluate(([l, r]) => window.__testAPI.openComparison({ leftPath: l, rightPath: r }),
    [leftMp3, rightMp3])

  await expect(win.locator('#view-metadata')).toBeVisible({ timeout: 5000 })
  expect(await win.evaluate(() => window.__testAPI.currentView())).toBe('metadata')
  await win.waitForFunction(() => window.__testAPI.metaRows().length > 0, { timeout: 5000 })

  const tabs = await win.evaluate(() => window.__testAPI.tabs())
  expect(tabs[tabs.length - 1].type).toBe('metadata')
})

test('.exe 兩種讀法都會被問，選版本比對就開這個視圖', async () => {
  await win.evaluate(() => window.__testAPI.menuCommand('session.home'))
  const opened = win.evaluate(
    (p) => window.__testAPI.openComparison({ leftPath: p, rightPath: p }), fakeExe)

  const picker = win.locator('#view-picker-modal')
  await expect(picker).toBeVisible({ timeout: 5000 })
  await expect(picker.locator('[data-view-type="hex"]')).toBeVisible()
  await picker.locator('[data-view-type="metadata"]').click()
  await opened

  expect(await win.evaluate(() => window.__testAPI.currentView())).toBe('metadata')
  // 沒有版本資源的檔案必須明講，不能留一張空表讓人以為兩邊相同
  const notes = await win.evaluate(() => window.__testAPI.metaNotes())
  expect(notes.join('')).toContain('不是可讀取中繼資料')
})

test('工具列每個控制項都留在視窗內', async () => {
  // 本專案中過兩次的缺陷：工具列換行後渲染到內容下方，按鈕存在但點不到。
  await goToMetadataCompare(win)
  const offscreen = await win.evaluate(() => {
    const bad = []
    for (const ctl of document.querySelectorAll(
      '#view-metadata button, #view-metadata select, #view-metadata input')) {
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
