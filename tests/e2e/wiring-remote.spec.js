/**
 * Remote browsing wiring, end to end.
 *
 * The transport is stubbed in the main process — no server is contacted — but
 * everything above it is the real thing: the folder view lists through
 * `remote-list-dir`, opening a row reads through `remote-read-file`, and
 * closing the tab issues `remote-disconnect`. Before this, the renderer called
 * none of the last two: remote file contents were unreachable and every
 * connection leaked.
 *
 * The stubs replace registered ipcMain handlers, so this runs in its own app
 * instance rather than polluting the other specs.
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

const REMOTE_TEXT = 'remote line one\nremote line two\n'

test.beforeAll(async () => {
  ;({ app, win } = await launchApp())
  await win.waitForFunction(() => !!window.__testAPI)

  await app.evaluate(({ ipcMain }, body) => {
    globalThis.__remoteCalls = []
    for (const ch of ['remote-list-dir', 'remote-read-file', 'remote-disconnect']) {
      ipcMain.removeHandler(ch)
    }
    ipcMain.handle('remote-list-dir', (_e, { profileId, dir = '', secret } = {}) => {
      globalThis.__remoteCalls.push({ call: 'list', profileId, dir, secret })
      const base = dir ? `${dir}/` : ''
      return [
        {
          name: 'r.txt',
          path: `remote://${profileId}/${base}r.txt`,
          isDirectory: false,
          size: body.length,
          mtime: new Date(0).toISOString(),
        },
        {
          name: 'sub',
          path: `remote://${profileId}/${base}sub`,
          isDirectory: true,
          size: 0,
          mtime: new Date(0).toISOString(),
        },
      ]
    })
    ipcMain.handle('remote-read-file', (_e, { profileId, path } = {}) => {
      globalThis.__remoteCalls.push({ call: 'read', profileId, path })
      return { path, base64: Buffer.from(body, 'utf-8').toString('base64'), size: body.length }
    })
    ipcMain.handle('remote-disconnect', (_e, profileId) => {
      globalThis.__remoteCalls.push({ call: 'disconnect', profileId })
      return true
    })
  }, REMOTE_TEXT)
})

test.afterAll(async () => {
  await closeApp(app)
})

/** @returns {Promise<Array<{ call: string, profileId: string, dir?: string, path?: string, secret?: string }>>} */
function remoteCalls() {
  return app.evaluate(() => globalThis.__remoteCalls ?? [])
}

test('a remote folder browses, opens a file, and disconnects when the tab closes', async () => {
  await win.evaluate(() => window.__testAPI.openRemoteCompare(
    { id: 'p-e2e', name: '測試主機' }, 'pw', '', 'left'))

  expect(await win.evaluate(() => window.__testAPI.currentView())).toBe('folder')
  const rows = await win.evaluate(() => window.__testAPI.folderRows())
  expect(rows.map((r) => r.name).sort()).toEqual(['r.txt', 'sub'])
  expect(rows.find((r) => r.name === 'r.txt').leftPath).toBe('remote://p-e2e/r.txt')

  // A subdirectory must list through the same profile rather than the filesystem.
  await win.evaluate(() => window.__testAPI.folderClick('sub'))
  await win.waitForFunction(async () => true)
  expect((await remoteCalls()).filter((c) => c.call === 'list').length).toBeGreaterThan(1)

  // Opening the file is the step that never existed: remoteReadFile had no
  // caller at all, so a remote file's contents could not be seen.
  await win.evaluate(() => window.__testAPI.folderDblClick('r.txt'))
  await win.waitForFunction(() => window.__testAPI.currentView() === 'text')
  const contents = await win.evaluate(() => window.__testAPI.textGetContents())
  expect(contents.left).toContain('remote line one')

  const calls = await remoteCalls()
  const reads = calls.filter((c) => c.call === 'read')
  expect(reads).toHaveLength(1)
  expect(reads[0].profileId).toBe('p-e2e')
  expect(reads[0].path).toMatch(/r\.txt$/)

  // The password the user typed is reused for every later call rather than
  // re-prompted or dropped after the first listing.
  const lists = calls.filter((c) => c.call === 'list')
  expect(lists.length).toBeGreaterThan(1)
  expect(lists.every((c) => c.secret === 'pw')).toBe(true)

  // Closing every tab tears the folder view down, which must close the session.
  for (;;) {
    const btn = win.locator('.tab-close').first()
    if (!(await btn.count())) break
    await btn.click()
  }
  await expect.poll(async () =>
    (await remoteCalls()).some((c) => c.call === 'disconnect' && c.profileId === 'p-e2e'),
  ).toBe(true)
})

test('a remote path reaches the remote reader, not the filesystem handler', async () => {
  await win.evaluate(() => window.__testAPI.openComparison({
    type: 'text', leftPath: 'remote://p-e2e/deep/x.txt',
  }))
  await win.waitForFunction(() => window.__testAPI.currentView() === 'text')

  const contents = await win.evaluate(() => window.__testAPI.textGetContents())
  expect(contents.left).toContain('remote line one')
  // The old code handed this to readFile(), where the path validator rejected
  // the scheme outright and the error was swallowed.
  expect(await win.evaluate(() => window.__testAPI.statusLevel())).not.toBe('error')
  expect((await remoteCalls()).some((c) => c.call === 'read' && c.path === 'deep/x.txt')).toBe(true)
})
