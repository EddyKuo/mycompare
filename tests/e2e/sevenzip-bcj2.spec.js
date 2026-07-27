/**
 * A BCJ2 archive opened through the running application.
 *
 * The unit tests decode BCJ2 against archives made by real 7-Zip. What they
 * cannot show is that the app reaches that code: this project's most repeated
 * defect is a decoder that works and that nothing calls. So this goes through
 * the real IPC, on an archive built by 7z.exe at test time, and compares the
 * extracted bytes against the file that went in.
 *
 * Skips when 7-Zip is not installed rather than pretending to pass.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, copyFile, readFile, rm, stat } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'

const run = promisify(execFile)
const SEVENZIP = 'C:\\Program Files\\7-Zip\\7z.exe'
const SOURCE_EXE = 'C:\\Windows\\System32\\where.exe'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let dir
/** @type {string} */
let archive
/** @type {Buffer|null} */
let original = null
let available = true

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-bcj2-'))
  archive = join(dir, 'packed.7z')

  try {
    await stat(SEVENZIP)
    await copyFile(SOURCE_EXE, join(dir, 'where.exe'))
    original = await readFile(join(dir, 'where.exe'))
    // The coder chain 7-Zip actually emits for BCJ2: the filter over three
    // LZMA sub-streams, bound explicitly.
    await run(SEVENZIP, [
      'a', '-t7z', '-m0=BCJ2', '-m1=LZMA', '-m2=LZMA', '-m3=LZMA',
      '-mb0:1', '-mb0s1:2', '-mb0s2:3', archive, 'where.exe',
    ], { cwd: dir })
  } catch {
    available = false
  }

  ;({ app, win } = await launchApp([dir]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

test('lists the entry inside a BCJ2 archive', async () => {
  test.skip(!available, '7-Zip is not installed on this machine')

  const listing = await win.evaluate((p) => window.electronAPI.readArchive(p), archive)
  const names = (listing?.entries ?? listing ?? []).map((e) => e.path ?? e.name ?? '')
  expect(names.join(',')).toContain('where.exe')
})

test('extracts it byte for byte', async () => {
  test.skip(!available, '7-Zip is not installed on this machine')

  const b64 = await win.evaluate(
    ([p, entry]) => window.electronAPI.readArchiveEntry(p, entry),
    [archive, 'where.exe'])

  const got = Buffer.from(String(b64), 'base64')
  expect(got.length).toBe(original.length)
  // Hashes rather than a byte-by-byte diff in the failure message: a mismatch
  // in the middle of 60KB of machine code is not something to print.
  const sum = (b) => createHash('sha256').update(b).digest('hex')
  expect(sum(got)).toBe(sum(original))
})

test('a corrupt BCJ2 archive errors rather than yielding short output', async () => {
  test.skip(!available, '7-Zip is not installed on this machine')

  // Truncating is the case that matters: returning the bytes decoded so far
  // would pass every integrity check that only covers what was produced,
  // which is exactly how three decoders in this project were wrong before.
  const truncated = join(dir, 'cut.7z')
  const whole = await readFile(archive)
  const { writeFile } = await import('fs/promises')
  await writeFile(truncated, whole.subarray(0, Math.floor(whole.length * 0.6)))

  const outcome = await win.evaluate(async ([p, entry]) => {
    try {
      const out = await window.electronAPI.readArchiveEntry(p, entry)
      return `returned ${String(out).length} chars`
    } catch (err) {
      return `threw: ${String(err?.message ?? err)}`
    }
  }, [truncated, 'where.exe'])

  expect(outcome).toContain('threw')
})
