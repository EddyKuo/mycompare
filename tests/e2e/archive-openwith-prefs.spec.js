/**
 * The archive and Open With preferences, proved to reach the main process.
 *
 * Both had controls that stored a value and no code anywhere that read it —
 * the dialog accepted the change and nothing happened. They are consumed in
 * main now, which means the only honest test is one that goes through the real
 * IPC and observes a behaviour change.
 *
 * Nothing here launches an external program: a test that spawns whatever the
 * machine has registered is not a test. What is checked is that the setting
 * arrives and is retained.
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
let zipPath

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-arcpref-'))

  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  zip.file('a.txt', 'hello\n')
  zipPath = join(dir, 'bundle.zip')
  await writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))

  ;({ app, win } = await launchApp([dir]))
  await win.waitForFunction(() => !!window.__testAPI)
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

/** @param {string} enabled @param {number} maxMB */
const setLimits = (enabled, maxMB) => win.evaluate(
  ([e, m]) => window.electronAPI.setArchiveLimits(e, m), [enabled, maxMB])

test('a zip opens while zip is among the enabled formats', async () => {
  await setLimits('zip,tar,gz,7z,cab', 0)
  const entries = await win.evaluate((p) => window.electronAPI.readArchive(p), zipPath)
  const names = (entries?.entries ?? entries ?? []).map((e) => e.path ?? e.name ?? '')
  expect(names.join(',')).toContain('a.txt')
})

test('switching zip off refuses it by name instead of showing an empty folder', async () => {
  // The failure that matters: a disabled format that silently lists nothing
  // looks exactly like an archive with no files in it.
  await setLimits('tar,gz,7z,cab', 0)

  const outcome = await win.evaluate(async (p) => {
    try {
      await window.electronAPI.readArchive(p)
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  }, zipPath)

  expect(outcome).not.toBe('allowed')
  expect(outcome).toContain('停用')
})

test('turning it back on restores the read', async () => {
  // Guards against a refusal that latches: the preference has to be live, not
  // a one-way switch decided at startup.
  await setLimits('zip,tar,gz,7z,cab', 0)
  const entries = await win.evaluate((p) => window.electronAPI.readArchive(p), zipPath)
  const names = (entries?.entries ?? entries ?? []).map((e) => e.path ?? e.name ?? '')
  expect(names.join(',')).toContain('a.txt')
})

test('an entry over the configured size limit is refused', async () => {
  // 1MB ceiling against a file that decodes to more than that.
  const big = new (await import('jszip')).default()
  big.file('big.txt', 'x'.repeat(2 * 1024 * 1024))
  const bigPath = join(dir, 'big.zip')
  await writeFile(bigPath, await big.generateAsync({ type: 'nodebuffer' }))

  await setLimits('zip', 1)
  const outcome = await win.evaluate(async (p) => {
    try {
      await window.electronAPI.readArchive(p)
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  }, bigPath)
  expect(outcome).not.toBe('allowed')

  // And the same archive is fine once the ceiling is raised, so the refusal
  // tracked the setting rather than the file.
  await setLimits('zip', 64)
  const entries = await win.evaluate((p) => window.electronAPI.readArchive(p), bigPath)
  expect(entries).toBeTruthy()
})

test('the default list opens a plain .gz, whose decoder is not named "gz"', async () => {
  // detectFormat answers 'gzip' while the preference is spelled 'gz'. Matching
  // those two literally refused every plain .gz under the shipped default —
  // the list looked like it allowed them and nothing did.
  const { gzipSync } = await import('zlib')
  const gzPath = join(dir, 'note.txt.gz')
  await writeFile(gzPath, gzipSync(Buffer.from('hello\n')))

  await setLimits('zip,tar,gz,bz2,xz,7z,cab', 0)
  const outcome = await win.evaluate(async (p) => {
    try {
      await window.electronAPI.readArchive(p)
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  }, gzPath)
  expect(outcome).toBe('allowed')
})

test('dropping gz from the list does refuse it, so the match is not just permissive', async () => {
  const gzPath = join(dir, 'note.txt.gz')
  await setLimits('zip,tar,7z,cab', 0)
  const outcome = await win.evaluate(async (p) => {
    try {
      await window.electronAPI.readArchive(p)
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  }, gzPath)
  expect(outcome).not.toBe('allowed')
  await setLimits('zip,tar,gz,bz2,xz,7z,cab', 0)
})

test('the Open With program is accepted and echoed back', async () => {
  const out = await win.evaluate(() =>
    window.electronAPI.setOpenWithDefaults('C:\\Windows\\System32\\notepad.exe', '"%1"'))
  expect(out.command).toContain('notepad')
  expect(out.args).toBe('"%1"')
})

test('an empty program clears the override rather than storing whitespace', async () => {
  // With no program configured the shell association must be used again; a
  // stored '   ' would be launched as a command and fail every open.
  const out = await win.evaluate(() => window.electronAPI.setOpenWithDefaults('   ', '"%1"'))
  expect(out.command).toBe('')
})
