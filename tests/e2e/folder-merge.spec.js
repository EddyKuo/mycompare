/**
 * Three-way Folder Merge e2e.
 *
 * Unit tests cannot answer "is there a way in from the running app" — this
 * project has repeatedly shipped complete modules with no caller — so this
 * spec drives the merge mode from the toolbar the user actually sees, in the
 * production build.
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

async function goToFolderCompare(page) {
  const viewFolder = page.locator('#view-folder')
  if (await viewFolder.isVisible()) return
  const home = page.locator('#session-home')
  if (!(await home.isVisible())) {
    await page.locator('#btn-new-session').click()
    await expect(home).toBeVisible({ timeout: 5000 })
  }
  await page.locator('[data-type="folder"].session-type-btn').click()
  await expect(viewFolder).toBeVisible({ timeout: 5000 })
}

test('工具列的三向合併按鈕存在且可切換出三個窗格', async () => {
  await goToFolderCompare(win)

  const btn = win.locator('.fc-btn-merge').first()
  await expect(btn).toBeVisible()
  await expect(win.locator('.fc-header-side')).toHaveCount(2)

  await btn.click()
  await expect(win.locator('.folder-compare--merge')).toBeVisible()
  await expect(win.locator('.fc-header-side')).toHaveCount(3)
  await expect(win.locator('.fc-path-cell')).toHaveCount(3)
  await expect(win.locator('.fc-open-base')).toBeVisible()
})

test('合併面板提供輸出資料夾、衝突導航、批次決議與預覽／執行', async () => {
  await goToFolderCompare(win)
  if (!(await win.locator('.folder-compare--merge').isVisible())) {
    await win.locator('.fc-btn-merge').first().click()
  }
  const panel = win.locator('.merge-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.merge-only-conflicts')).toBeVisible()
  await expect(panel.getByText('上一個衝突')).toBeVisible()
  await expect(panel.getByText('下一個衝突')).toBeVisible()
  await expect(panel.getByText('清除所有手動決議')).toBeVisible()
  await expect(panel.getByText('預覽輸出')).toBeVisible()
  // The destructive button is shut until a plan has been previewed.
  await expect(panel.getByText('執行合併')).toBeDisabled()
})

test('再按一次回到兩窗格的資料夾比對', async () => {
  await goToFolderCompare(win)
  if (!(await win.locator('.folder-compare--merge').isVisible())) {
    await win.locator('.fc-btn-merge').first().click()
    await expect(win.locator('.folder-compare--merge')).toBeVisible()
  }
  await win.locator('.fc-btn-merge').first().click()
  await expect(win.locator('.folder-compare--merge')).toHaveCount(0)
  await expect(win.locator('.merge-panel')).toHaveCount(0)
  await expect(win.locator('.fc-header-side')).toHaveCount(2)
})
