/**
 * A RAR archive opened through the running application.
 *
 * The unit tests prove rar.js parses bytes that 7-Zip has already certified as
 * a real Rar5. They cannot prove the app reaches that code — and a decoder
 * nothing calls is the defect this project has found more often than any
 * other. This goes through the real IPC.
 *
 * The compressed-method case matters as much as the stored one: refusing at
 * extraction rather than at listing is what gives the user the archive's
 * contents plus an explanation, instead of a folder that looks empty.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'
import { buildRar5 } from '../helpers/rar-fixture.js'

const SEVENZIP = ['C:', 'Program Files', '7-Zip', '7z.exe'].join('\\')

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let dir
/** @type {string} */
let stored
/** @type {string} */
let compressed

const HELLO = Buffer.from('stored RAR5 through the app\n', 'utf-8')

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-rar-'))
  stored = join(dir, 'stored.rar')
  compressed = join(dir, 'compressed.rar')

  await writeFile(stored, buildRar5([
    { name: 'note.txt', data: HELLO },
    { name: 'sub/inner.txt', data: Buffer.from('nested\n', 'utf-8') },
  ]))
  // Method 3 is "Normal" — a real compression method this build cannot decode.
  await writeFile(compressed, buildRar5([
    { name: 'packed.txt', data: Buffer.from('whatever\n', 'utf-8'), method: 3 },
  ]))

  // The fixture is only trustworthy if something other than our own parser
  // agrees it is a RAR. Fail loudly here rather than testing our reader
  // against bytes only it believes in.
  if (existsSync(SEVENZIP)) {
    const out = execFileSync(SEVENZIP, ['l', stored], { encoding: 'utf-8' })
    expect(out).toContain('Rar5')
  }

  ;({ app, win } = await launchApp([dir]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

test('lists the entries of a stored RAR', async () => {
  const listing = await win.evaluate((p) => window.electronAPI.readArchive(p), stored)
  const names = (listing?.entries ?? listing ?? []).map((e) => e.path ?? e.name ?? '')
  expect(names.join(',')).toContain('note.txt')
  expect(names.join(',')).toContain('inner.txt')
})

test('extracts a stored entry byte for byte', async () => {
  const b64 = await win.evaluate(
    ([p, entry]) => window.electronAPI.readArchiveEntry(p, entry), [stored, 'note.txt'])
  expect(Buffer.from(String(b64), 'base64').equals(HELLO)).toBe(true)
})

test('a compressed entry still lists, then refuses by name on extraction', async () => {
  // Both halves matter. Refusing at listing time would show an empty folder
  // and read as "this archive has nothing in it".
  const listing = await win.evaluate((p) => window.electronAPI.readArchive(p), compressed)
  const names = (listing?.entries ?? listing ?? []).map((e) => e.path ?? e.name ?? '')
  expect(names.join(',')).toContain('packed.txt')

  const outcome = await win.evaluate(async ([p, entry]) => {
    try {
      const out = await window.electronAPI.readArchiveEntry(p, entry)
      return `returned ${String(out).length} chars`
    } catch (err) {
      return `threw: ${String(err?.message ?? err)}`
    }
  }, [compressed, 'packed.txt'])

  expect(outcome).toContain('threw')
  // Named, not a generic failure — the user has to learn which method it is.
  expect(outcome).toMatch(/RAR|壓縮方法|method/i)
})

test('a corrupted stored entry is refused rather than handed back', async () => {
  const forged = join(dir, 'forged.rar')
  await writeFile(forged, buildRar5([
    { name: 'bad.txt', data: HELLO, crc: 0x12345678 },
  ]))

  const outcome = await win.evaluate(async ([p, entry]) => {
    try {
      await window.electronAPI.readArchiveEntry(p, entry)
      return 'returned'
    } catch (err) {
      return `threw: ${String(err?.message ?? err)}`
    }
  }, [forged, 'bad.txt'])

  expect(outcome).toContain('threw')
})
