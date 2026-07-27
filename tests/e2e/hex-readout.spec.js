/**
 * Hex readout panel e2e — BC View ▸ Current Byte Address / Little Endian
 * Values / Big Endian Values.
 *
 * Unit tests can only show that the conversion is right; they cannot show that
 * anything calls it. This spec drives the real view: it clicks a byte in the
 * virtualised grid, walks the cursor with the arrow keys, and reads the numbers
 * back out of the rendered panel, so a readout wired to nothing fails here.
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

test.beforeAll(async () => {
  ;({ app, win } = await launchApp())
})

test.afterAll(async () => {
  await closeApp(app)
})

/** 256 bytes whose value equals their offset — every reading is predictable. */
function rampBase64() {
  let binary = ''
  for (let i = 0; i < 256; i++) binary += String.fromCharCode(i)
  return btoa(binary)
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function goToHexCompare(page) {
  const home = page.locator('#session-home')
  const viewHex = page.locator('#view-hex')
  if (!(await viewHex.isVisible())) {
    if (!(await home.isVisible())) {
      await page.locator('#btn-new-session').click()
      await expect(home).toBeVisible({ timeout: 5000 })
    }
    await page.locator('[data-type="hex"].session-type-btn').click()
    await expect(viewHex).toBeVisible({ timeout: 5000 })
  }

  const b64 = rampBase64()
  await page.evaluate((data) => {
    window.__testAPI?.hexSetLeft('test-left.bin', data)
    window.__testAPI?.hexSetRight('test-right.bin', data)
  }, b64)
  await page.waitForFunction(() => (window.__testAPI?.hexGetRowCount() ?? 0) > 0, null,
    { timeout: 5000 })
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 */
function readout(page, key) {
  return page.locator(`.hx-details-body .hx-detail-value[data-key="${key}"]`)
}

test('Hex 面板：點選位元組後顯示位址與兩種位元組序的數值', async () => {
  await goToHexCompare(win)

  const btnDetails = win.locator('#hx-btn-details')
  if (!(await win.locator('.hx-details').isVisible())) await btnDetails.click()
  await expect(win.locator('.hx-details')).toBeVisible()

  // 第 1 列（offset 0x10 起）的第 3 個位元組 → offset 18
  const byte = win.locator('.hx-pane[data-side="left"] .hx-row[data-row="1"] .hx-hex .hx-byte')
    .nth(2)
  await byte.click()

  await expect(readout(win, 'addrHex')).toHaveText('0x00000012')
  await expect(readout(win, 'addrDec')).toHaveText('18')
  await expect(readout(win, 'uint8')).toHaveText('18')
  await expect(readout(win, 'uint16le')).toHaveText('4882')   // 0x1312
  await expect(readout(win, 'uint16be')).toHaveText('4627')   // 0x1213
  await expect(readout(win, 'uint32le')).toHaveText('353637138')
  await expect(readout(win, 'uint32be')).toHaveText('303240213')
  await expect(readout(win, 'uint64le')).toHaveText('1808220633999610642')
})

test('Hex 面板：方向鍵移動游標時數值跟著改變', async () => {
  await goToHexCompare(win)
  if (!(await win.locator('.hx-details').isVisible())) await win.locator('#hx-btn-details').click()

  const byte = win.locator('.hx-pane[data-side="left"] .hx-row[data-row="1"] .hx-hex .hx-byte')
    .nth(2)
  await byte.click()
  await expect(readout(win, 'addrDec')).toHaveText('18')

  await win.locator('.hx-pane[data-side="left"] .hx-scroll').press('ArrowRight')
  await expect(readout(win, 'addrDec')).toHaveText('19')
  await expect(readout(win, 'uint8')).toHaveText('19')
  await expect(readout(win, 'uint16le')).toHaveText('5139')   // 0x1413

  await win.locator('.hx-pane[data-side="left"] .hx-scroll').press('ArrowLeft')
  await expect(readout(win, 'addrDec')).toHaveText('18')

  // 往下一整列
  await win.locator('.hx-pane[data-side="left"] .hx-scroll').press('ArrowDown')
  await expect(readout(win, 'addrDec')).toHaveText('34')
  await expect(readout(win, 'addrHex')).toHaveText('0x00000022')
})

test('Hex 面板：三個 View 開關各自隱藏對應的列', async () => {
  await goToHexCompare(win)
  if (!(await win.locator('.hx-details').isVisible())) await win.locator('#hx-btn-details').click()

  await win.locator('.hx-pane[data-side="left"] .hx-row[data-row="1"] .hx-hex .hx-byte')
    .nth(2).click()
  await expect(readout(win, 'uint32le')).toBeVisible()

  await win.locator('#hx-btn-le').click()
  await expect(readout(win, 'uint32le')).toHaveCount(0)
  await expect(readout(win, 'uint32be')).toHaveCount(1)

  await win.locator('#hx-btn-be').click()
  await expect(readout(win, 'uint32be')).toHaveCount(0)
  // 與位元組序無關的解讀留著，面板不會整個變空
  await expect(readout(win, 'uint8')).toHaveText('18')

  await win.locator('#hx-btn-addr').click()
  await expect(readout(win, 'addrHex')).toHaveCount(0)
  await expect(readout(win, 'addrDec')).toHaveCount(0)

  // 復原，避免影響後續測試
  await win.locator('#hx-btn-le').click()
  await win.locator('#hx-btn-be').click()
  await win.locator('#hx-btn-addr').click()
  await expect(readout(win, 'uint32le')).toHaveCount(1)
  await expect(readout(win, 'addrHex')).toHaveCount(1)
})

test('Hex 面板：檔尾附近的寬型別標示為不可用而非補零的數字', async () => {
  await goToHexCompare(win)
  if (!(await win.locator('.hx-details').isVisible())) await win.locator('#hx-btn-details').click()

  // 最後一列（offset 0xF0 起）的最後一個位元組 → offset 255
  const lastRow = win.locator('.hx-pane[data-side="left"] .hx-row[data-row="15"]')
  await lastRow.locator('.hx-hex .hx-byte').nth(15).click()

  await expect(readout(win, 'addrDec')).toHaveText('255')
  await expect(readout(win, 'uint8')).toHaveText('255')
  await expect(readout(win, 'uint16le')).toContainText('需要 2 位元組')
  await expect(readout(win, 'uint64be')).toContainText('需要 8 位元組')
  await expect(readout(win, 'uint16le')).toHaveClass(/hx-detail-value--na/)
})
