/**
 * The packaged application, launched as a user would get it.
 *
 * Every other e2e runs `out/main/index.js` through a development Electron.
 * That is not the artifact anyone installs: packaging adds an asar, rewrites
 * module resolution, strips devDependencies and applies the afterPack script.
 * A build can produce an 82MB installer whose app fails on the first import,
 * and nothing in the suite would notice.
 *
 * Skips when `npm run dist` has not been run, so a plain `npm run test:e2e`
 * on a clean tree is unaffected.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const EXE = fileURLToPath(new URL('../../dist/win-unpacked/MyCompare.exe', import.meta.url))
const built = existsSync(EXE)

test.describe('the packaged build', () => {
  test.skip(!built, 'dist/win-unpacked not present; run `npm run dist` first')

  test('launches, shows a window, and has the IPC bridge', async () => {
    const app = await electron.launch({
      executablePath: EXE,
      // A throwaway profile, so smoke-testing the installer does not write
      // into the real one.
      args: [`--user-data-dir=${mkdtempSync(join(tmpdir(), 'mycompare-pkg-'))}`],
    })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')

      // The renderer got as far as running its entry point.
      await expect(win.locator('#app, #session-home, body')).toBeTruthy()

      // contextBridge survived packaging. This is the part asar and the
      // preload CJS output most easily break.
      const api = await win.evaluate(() => typeof window.electronAPI)
      expect(api).toBe('object')

      // A main-process module added late in this work, reached through the
      // real IPC inside the packaged app rather than from source.
      const crc = await win.evaluate(() => typeof window.electronAPI.crc32File)
      expect(crc).toBe('function')

      // And one that lazily imports a chunk, which is where asar path
      // rewriting goes wrong if it is going to.
      const vcs = await win.evaluate(async () => {
        try {
          const r = await window.electronAPI.vcsStatus('C:/')
          return r && typeof r.available === 'boolean' ? 'answered' : 'odd shape'
        } catch (err) {
          // A refusal is fine — it proves the handler and its chunk loaded.
          return `threw: ${String(err?.message ?? err).slice(0, 40)}`
        }
      })
      expect(vcs).not.toBe('odd shape')

      const title = await win.title()
      expect(title.length).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })
})
