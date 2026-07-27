/**
 * The six BC Options pages, driven through the real dialog.
 *
 * The unit test proves every tab has a pane and every control names a
 * preference. It cannot prove the tab actually switches, the control is
 * reachable, or the value survives being written — which is exactly the gap
 * that let this project ship preferences with readers and no controls.
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

const PAGES = [
  ['folderViews', '資料夾檢視'],
  ['picture', '圖片比對'],
  ['textEditing', '文字編輯'],
  ['archives', '封存檔類型'],
  ['openWith', '開啟方式'],
  ['tweaks', '進階調整'],
]

test.beforeAll(async () => {
  ;({ app, win } = await launchApp())
})

test.afterAll(async () => {
  await closeApp(app)
})

async function openOptions() {
  const modal = win.locator('#settings-modal')
  if (!(await modal.isVisible())) {
    await win.evaluate(() => document.getElementById('btn-settings-modal')?.click())
    await expect(modal).toBeVisible({ timeout: 5000 })
  }
}

test.describe('each page opens', () => {
  for (const [pane, label] of PAGES) {
    test(`${label} 分頁可切換且內容可見`, async () => {
      await openOptions()
      await win.locator(`#options-tab-${pane}`).click()
      await expect(win.locator(`#options-pane-${pane}`)).toBeVisible()
      // Only one pane at a time; two visible means the hidden attribute is
      // not being managed and the dialog is showing a stack of pages.
      const visible = await win.locator('.options-pane:visible').count()
      expect(visible).toBe(1)
    })
  }
})

test('每個控制項都留在對話框內且可點', async () => {
  // The recurring defect here: a control that renders outside its container,
  // present in the DOM and unreachable with the mouse.
  await openOptions()
  for (const [pane] of PAGES) {
    await win.locator(`#options-tab-${pane}`).click()
    const bad = await win.evaluate((id) => {
      const box = document.querySelector('.modal-box--options')?.getBoundingClientRect()
      const out = []
      for (const c of document.querySelectorAll(`#${id} input, #${id} select`)) {
        const r = c.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        if (!box || r.right > box.right + 1 || r.left < box.left - 1) {
          out.push(c.id || c.className)
        }
      }
      return out
    }, `options-pane-${pane}`)
    expect(bad).toEqual([])
  }
})

test('勾選會寫入並在重新開啟後保留', async () => {
  await openOptions()
  await win.locator('#options-tab-folderViews').click()

  const box = win.locator('#chk-folder-expand-on-open')
  const before = await box.isChecked()
  await box.click()
  expect(await box.isChecked()).toBe(!before)

  // 關掉再開，值要還在——只改 DOM 而沒寫進儲存的話，這裡會退回原值。
  await win.locator('#btn-settings-modal-close').click()
  await openOptions()
  await win.locator('#options-tab-folderViews').click()
  expect(await win.locator('#chk-folder-expand-on-open').isChecked()).toBe(!before)

  await win.locator('#chk-folder-expand-on-open').click()
})

test('數字欄位寫入後保留，非數字被拒絕', async () => {
  await openOptions()
  await win.locator('#options-tab-tweaks').click()

  const input = win.locator('#inp-tweak-concurrency')
  await input.fill('8')
  await input.dispatchEvent('change')

  await win.locator('#btn-settings-modal-close').click()
  await openOptions()
  await win.locator('#options-tab-tweaks').click()
  await expect(win.locator('#inp-tweak-concurrency')).toHaveValue('8')

  // 清空欄位要被擋下並還原。Number('') 是 0 而 0 是有限值，所以只檢查
  // Number.isFinite 會把「清空」存成並行數 0，讓所有排隊中的讀取停住。
  await win.locator('#inp-tweak-concurrency').fill('')
  await win.locator('#inp-tweak-concurrency').dispatchEvent('change')
  await expect(win.locator('#inp-tweak-concurrency')).toHaveValue('8')

  // 超出 min/max 同樣要擋，而不是存進去等到遠處才鉗制。
  await win.locator('#inp-tweak-concurrency').fill('999')
  await win.locator('#inp-tweak-concurrency').dispatchEvent('change')
  await expect(win.locator('#inp-tweak-concurrency')).toHaveValue('8')
})

test('封存檔說明只列出本版本讀得到的格式', async () => {
  await openOptions()
  await win.locator('#options-tab-archives').click()
  const hint = await win.locator('#archive-support-hint').innerText()
  expect(hint).toContain('cab')
  // RAR 在別處是具名拒絕的；在這裡列出來等於承諾一個做不到的事。
  expect(hint.toLowerCase()).not.toContain('rar')
})
