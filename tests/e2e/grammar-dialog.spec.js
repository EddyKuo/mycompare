/**
 * e2e for the Grammar (File Format) editor and the text injection hooks.
 *
 * core/grammar.js shipped complete — five item types, priorities, line weights,
 * a compiler that rejects catastrophic regexes — with no way to author a
 * definition. This spec drives the dialog the way a user does: add a rule,
 * reorder it (priority *is* array order, so reordering is not cosmetic), tick
 * an element to ignore, and see a rejected pattern reported instead of
 * silently dropped.
 *
 * Run with: npm run test:e2e   (prerequisite: npm run build)
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

/** @param {import('@playwright/test').Page} page */
async function goToTextCompare(page) {
  const home = page.locator('#session-home')
  const viewText = page.locator('#view-text')
  if (await home.isVisible()) {
    await page.locator('[data-type="text"].session-type-btn').click()
  } else if (!(await viewText.isVisible())) {
    await page.locator('#btn-new-session').click()
    await expect(home).toBeVisible({ timeout: 5000 })
    await page.locator('[data-type="text"].session-type-btn').click()
  }
  await expect(viewText).toBeVisible({ timeout: 5000 })
}

/**
 * Open the dialog through the menu dispatch table, which is the entry point the
 * native View/Tools menu uses — Playwright cannot click a native menu.
 * @param {import('@playwright/test').Page} page
 */
async function openGrammarDialog(page) {
  await page.evaluate(() => window.__testAPI.menuCommand('tools.grammar'))
  await expect(page.locator('#grammar-modal')).toBeVisible({ timeout: 3000 })
}

/** @param {import('@playwright/test').Page} page */
async function closeGrammarDialog(page) {
  await page.locator('#btn-grammar-modal-cancel').click()
  await expect(page.locator('#grammar-modal')).toBeHidden({ timeout: 3000 })
}

test('內建文法可瀏覽但唯讀，必須先複製為自訂才能編輯', async () => {
  await goToTextCompare(win)
  await openGrammarDialog(win)

  // The three built-ins are listed, and selecting one locks the fields.
  const defs = win.locator('#grammar-def-list .config-list-item')
  await expect(defs).toHaveCount(3)
  await expect(win.locator('#input-grammar-name')).toBeDisabled()
  await expect(win.locator('#btn-grammar-def-remove')).toBeDisabled()
  await expect(win.locator('#btn-grammar-item-add')).toBeDisabled()

  // Its items are still shown, in priority order: the C family grammar must try
  // /* before //, or every block comment would be read as a line comment.
  await expect(win.locator('#grammar-item-list .grammar-item-row').first()).toContainText('Comment')

  await win.locator('#btn-grammar-def-copy').click()
  await expect(win.locator('#input-grammar-name')).toBeEnabled()
  await expect(win.locator('#input-grammar-name')).toHaveValue(/複本/)
  await expect(defs).toHaveCount(4)

  await closeGrammarDialog(win)
})

test('新增規則、調整順序、勾選忽略、看到編譯錯誤', async () => {
  await goToTextCompare(win)
  await openGrammarDialog(win)

  // --- new definition -----------------------------------------------------
  await win.locator('#btn-grammar-def-add').click()
  await win.locator('#input-grammar-name').fill('E2E 文法')
  await win.locator('#input-grammar-masks').fill('*.e2e')
  await expect(win.locator('#grammar-def-list .grammar-def-item--active .name'))
    .toHaveText('E2E 文法')

  // --- first rule ---------------------------------------------------------
  const rows = win.locator('#grammar-item-list .grammar-item-row')
  await win.locator('#btn-grammar-item-add').click()
  await win.locator('#input-grammar-item-element').fill('Comment')
  await win.locator('#sel-grammar-item-type').selectOption('delimited')
  await win.locator('#input-grammar-item-start').fill('/*')
  await win.locator('#input-grammar-item-end').fill('*/')
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0)).toContainText('Comment')

  // --- second rule --------------------------------------------------------
  await win.locator('#btn-grammar-item-add').click()
  await win.locator('#input-grammar-item-element').fill('Marker')
  await win.locator('#input-grammar-item-text').fill('TODO')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Comment')
  await expect(rows.nth(1)).toContainText('Marker')

  // --- reordering ---------------------------------------------------------
  // Priority is array order, so this is the only way to say "Marker wins".
  await win.locator('#btn-grammar-item-up').click()
  await expect(rows.nth(0)).toContainText('Marker')
  await expect(rows.nth(1)).toContainText('Comment')
  await expect(win.locator('#grammar-modal-status')).toContainText('第 1 順位')

  await win.locator('#btn-grammar-item-down').click()
  await expect(rows.nth(0)).toContainText('Comment')
  await expect(rows.nth(1)).toContainText('Marker')

  // --- ignore checkboxes --------------------------------------------------
  const ignoreComment = win.locator('#grammar-ignore-list label[data-element="Comment"] input')
  await expect(ignoreComment).toHaveCount(1)
  await expect(ignoreComment).not.toBeChecked()
  await ignoreComment.check()
  await expect(win.locator('#grammar-modal-status')).toContainText('忽略「Comment」')

  // --- compile errors are surfaced, not swallowed -------------------------
  const errors = win.locator('#grammar-errors')
  await expect(errors).toBeHidden()

  // The Marker rule is still selected; turn it into a regex that the compiler
  // refuses (nested unbounded quantifier → catastrophic backtracking).
  await win.locator('#chk-grammar-item-regex').check()
  await win.locator('#input-grammar-item-text').fill('(a+)+b')
  await expect(errors).toBeVisible()
  await expect(errors).toContainText('E2E 文法')
  await expect(errors).toContainText('巢狀無上限量詞')

  // Fixing the pattern clears the report — the box is not a one-way latch.
  await win.locator('#input-grammar-item-text').fill('TODO|FIXME')
  await expect(errors).toBeHidden()

  // --- apply --------------------------------------------------------------
  await win.locator('#btn-grammar-apply').click()
  await expect(win.locator('#grammar-modal-status')).toContainText('已套用')
  await expect(errors).toBeHidden()

  // The definition survives a reopen, which is what proves it reached the
  // registry rather than only the dialog's working copy.
  await closeGrammarDialog(win)
  await openGrammarDialog(win)
  await expect(win.locator('#grammar-def-list .config-list-item').first().locator('.name'))
    .toHaveText('E2E 文法')
  await expect(win.locator('#grammar-def-list .config-list-item').first().locator('.meta'))
    .toHaveText('自訂')

  // Clean up so the shared app instance does not leak this grammar into other
  // specs' file-format resolution.
  await win.locator('#btn-grammar-def-remove').click()
  await win.locator('#btn-grammar-apply').click()
  await closeGrammarDialog(win)
})

test('整個文法都無效時，套用會說明有幾個被拒絕', async () => {
  await goToTextCompare(win)
  await openGrammarDialog(win)

  await win.locator('#btn-grammar-def-add').click()
  await win.locator('#input-grammar-name').fill('全壞的文法')
  await win.locator('#btn-grammar-item-add').click()
  // An element name is mandatory; blanking it leaves the grammar with no usable
  // item at all, which the registry refuses outright.
  await win.locator('#input-grammar-item-element').fill('')

  await expect(win.locator('#grammar-errors')).toContainText('缺少 element 名稱')

  await win.locator('#btn-grammar-apply').click()
  await expect(win.locator('#grammar-modal-status')).toContainText('無法套用')

  await win.locator('#btn-grammar-def-remove').click()
  await win.locator('#btn-grammar-apply').click()
  await closeGrammarDialog(win)
})

test('__testAPI 可注入文字內容，比對結果反映注入的資料', async () => {
  await goToTextCompare(win)

  // `::` marks a path the view knows is not a local file, so injecting content
  // does not ask the main process to watch something that does not exist.
  const stats = await win.evaluate(() => {
    window.__testAPI.textSetLeft('e2e::left.txt', 'alpha\nbeta\ngamma')
    window.__testAPI.textSetRight('e2e::right.txt', 'alpha\ndelta\ngamma')
    return window.__testAPI.textGetStats()
  })
  expect(stats.replace).toBe(1)
  expect(stats.equal).toBe(2)
  expect(stats.total).toBe(3)

  const contents = await win.evaluate(() => window.__testAPI.textGetContents())
  expect(contents.left).toContain('beta')
  expect(contents.right).toContain('delta')
})

test('__testAPI.textOpenPatch 開啟 patch 檢視器', async () => {
  await goToTextCompare(win)

  const patch = [
    '--- a/hello.txt',
    '+++ b/hello.txt',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '',
  ].join('\n')

  const fileCount = await win.evaluate((text) => window.__testAPI.textOpenPatch(text, 'e2e'), patch)
  expect(fileCount).toBe(1)

  const contents = await win.evaluate(() => window.__testAPI.textGetContents())
  expect(contents.left).toContain('two')
  expect(contents.right).toContain('TWO')

  // A malformed patch must fail loudly rather than opening two empty panes.
  const err = await win.evaluate(() => {
    try {
      window.__testAPI.textOpenPatch('this is not a patch at all')
      return null
    } catch (e) {
      return String(e)
    }
  })
  expect(err).not.toBeNull()
})
