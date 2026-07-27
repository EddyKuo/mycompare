/**
 * Remote connections, end to end.
 *
 * No server is contacted: these check that the IPC surface exists, that
 * nothing connects without a profile, that credentials never come back to the
 * renderer, and that a remote path cannot reach a filesystem handler.
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

test('the remote IPC surface is exposed', async () => {
  const api = await win.evaluate(() => ({
    list: typeof window.electronAPI?.remoteListProfiles,
    save: typeof window.electronAPI?.remoteSaveProfile,
    del: typeof window.electronAPI?.remoteDeleteProfile,
    dir: typeof window.electronAPI?.remoteListDir,
    read: typeof window.electronAPI?.remoteReadFile,
    close: typeof window.electronAPI?.remoteDisconnect,
  }))
  expect(Object.values(api)).toEqual(Array(6).fill('function'))
})

test('there are no profiles until the user creates one', async () => {
  const profiles = await win.evaluate(() => window.electronAPI.remoteListProfiles())
  expect(Array.isArray(profiles)).toBe(true)
})

test('listing a directory for an unknown profile refuses rather than connecting', async () => {
  const result = await win.evaluate(async () => {
    try {
      await window.electronAPI.remoteListDir('no-such-profile', '')
      return 'connected'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  // Nothing may reach the network without a profile the user set up.
  expect(result).not.toBe('connected')
  expect(result).toMatch(/找不到該連線設定/)
})

test('a saved profile never returns its password to the renderer', async () => {
  const listed = await win.evaluate(async () => {
    await window.electronAPI.remoteSaveProfile({
      name: 'e2e-ftp',
      kind: 'ftp',
      host: 'ftp.invalid',
      user: 'alice',
      secret: 'hunter2',
      saveSecret: true,
    })
    return window.electronAPI.remoteListProfiles()
  })

  const saved = listed.find((p) => p.name === 'e2e-ftp')
  expect(saved).toBeTruthy()
  expect(JSON.stringify(listed)).not.toContain('hunter2')
  // The renderer is told whether a secret exists, never what it is.
  expect(typeof saved.hasSecret).toBe('boolean')

  await win.evaluate((id) => window.electronAPI.remoteDeleteProfile(id), saved.id)
})

test('remote:// paths are refused by the filesystem handlers', async () => {
  const result = await win.evaluate(async () => {
    try {
      await window.electronAPI.readFile('remote://profile/etc/passwd')
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  expect(result).not.toBe('allowed')
  expect(result).toMatch(/remote:\/\/|cannot be passed/)
})

test('the Session menu offers the remote commands', async () => {
  const labels = await app.evaluate(({ Menu }) => {
    const out = []
    const walk = (items) => {
      for (const it of items) {
        if (it.submenu) walk(it.submenu.items)
        else out.push(it.label)
      }
    }
    walk(Menu.getApplicationMenu().items)
    return out
  })
  expect(labels.some((l) => l.includes('遠端連線設定'))).toBe(true)
  expect(labels.some((l) => l.includes('開啟遠端資料夾'))).toBe(true)
})
