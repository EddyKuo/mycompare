/**
 * Registry comparison, end to end.
 *
 * Parsing is covered by unit tests; this checks the IPC is wired, that a
 * malicious key path cannot reach reg.exe, and that a .reg file round-trips
 * through the real handler.
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
let regPath
/** @type {string} */
let bigPath
/** @type {string} */
let manyLeft
/** @type {string} */
let manyRight

const SAMPLE = [
  'Windows Registry Editor Version 5.00',
  '',
  '[HKEY_CURRENT_USER\\Software\\MyCompareTest]',
  '@="default"',
  '"Name"="Alice"',
  '"Count"=dword:0000002a',
].join('\r\n')

/**
 * A .reg holding one binary value of the size real ones reach.
 *
 * reg.exe wraps binary data at ~80 columns, so a multi-megabyte value arrives
 * as tens of thousands of continuation lines.
 *
 * @returns {string}
 */
function bigSample() {
  const lines = [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Software\\MyCompareTest\\Big]',
    '"Blob"=hex:\\',
  ]
  for (let i = 0; i < 60_000; i++) {
    lines.push('  00,11,22,33,44,55,66,77,88,99,aa,bb,cc,dd,ee,ff,\\')
  }
  lines.push('  00')
  return lines.join('\r\n')
}

/**
 * A .reg with enough values that drawing them all would be visible.
 *
 * @param {number} n
 * @param {string} suffix  makes the right side differ from the left
 * @returns {string}
 */
function manySample(n, suffix) {
  const lines = ['Windows Registry Editor Version 5.00', '']
  for (let k = 0; k < 20; k++) {
    lines.push('', `[HKEY_CURRENT_USER\\Software\\MyCompareTest\\Many\\K${k}]`)
    for (let i = 0; i < n / 20; i++) {
      // Every tenth value differs between the two sides.
      lines.push(`"v${i}"="data ${i}${i % 10 === 0 ? suffix : ''}"`)
    }
  }
  return lines.join('\r\n')
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-reg-'))
  regPath = join(dir, 'sample.reg')
  bigPath = join(dir, 'big.reg')
  manyLeft = join(dir, 'many-left.reg')
  manyRight = join(dir, 'many-right.reg')
  await writeFile(regPath, `\uFEFF${SAMPLE}`, 'utf16le')
  await writeFile(bigPath, bigSample(), 'utf-8')
  await writeFile(manyLeft, manySample(5000, ''), 'utf-8')
  await writeFile(manyRight, manySample(5000, ' changed'), 'utf-8')
  // Authorised on the command line: the renderer has no way to add a root.
  ;({ app, win } = await launchApp([regPath, bigPath, manyLeft, manyRight]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

test('the registry IPC surface is exposed', async () => {
  const api = await win.evaluate(() => ({
    exp: typeof window.electronAPI?.exportRegistryKey,
    cmp: typeof window.electronAPI?.compareRegFiles,
    out: typeof window.electronAPI?.exportRegFile,
    apply: typeof window.electronAPI?.applyRegFile,
  }))
  expect(api).toEqual({
    exp: 'function', cmp: 'function', out: 'function', apply: 'function',
  })
})

test('a UTF-16 .reg file parses through the real handler', async () => {
  const result = await win.evaluate(
    (p) => window.electronAPI.compareRegFiles(p, ''), regPath)

  expect(result.format).toBe('reg5')
  const byName = Object.fromEntries(result.rows.map((r) => [r.name, r]))
  expect(byName.Name.left.value).toBe('Alice')
  expect(byName.Count.left.type).toBe('REG_DWORD')
  expect(byName.Count.left.value).toContain('42')
  expect(byName[''].left.value).toBe('default')
  // Nothing on the right, so every value is an orphan rather than a match.
  expect(result.rows.every((r) => r.status === 'left-only')).toBe(true)
})

test('a multi-megabyte value comes back instead of freezing the app', async () => {
  // Parsing happens in the main process, so a stall here is not a slow view —
  // every window stops responding and there is no way back. The export of
  // HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion on a stock Windows 11
  // install holds a value this size, so it is an ordinary key to compare, not
  // a contrived one. The unit tests cover the joining function directly; this
  // is the only check that the whole IPC path stays responsive.
  const started = Date.now()
  const result = await win.evaluate(
    (p) => window.electronAPI.compareRegFiles(p, ''), bigPath)
  const elapsed = Date.now() - started

  const blob = result.rows.find((r) => r.name === 'Blob')
  expect(blob?.left?.type).toBe('REG_BINARY')
  // The value survived parsing — a fast wrong answer would pass a timing check
  // on its own. It reaches the renderer shortened, and says so: a grid cell can
  // show none of three megabytes, and writing the short form back would destroy
  // the real value.
  expect(blob.left.value.startsWith('00 11 22 33')).toBe(true)
  expect(blob.left.truncated).toBe(true)
  expect(blob.left.fullLength).toBeGreaterThan(2_000_000)
  expect(elapsed).toBeLessThan(15_000)
})

test('an unauthorised .reg path is refused', async () => {
  const result = await win.evaluate(async () => {
    try {
      await window.electronAPI.compareRegFiles('C:/Windows/System32/config/SAM', '')
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  expect(result).not.toBe('allowed')
})

test('the grid draws a window, not five thousand rows', async () => {
  // The lesson this repo keeps relearning: code that deals in scale has to be
  // measured at something close to real scale. A registry export routinely has
  // thousands of values, and building a row for every one of them is how the
  // table view once put a hundred thousand nodes in the document.
  await win.evaluate(([l, r]) => window.__testAPI.openComparison({
    type: 'registry', leftPath: l, rightPath: r,
  }), [manyLeft, manyRight])

  await win.waitForFunction(() => window.__testAPI.currentView() === 'registry')
  await win.evaluate(() => window.__testAPI.regExpandAll())

  const model = await win.evaluate(() => window.__testAPI.regVisibleCount())
  const drawn = await win.evaluate(() => window.__testAPI.regRowCount())
  expect(model).toBeGreaterThan(5000)
  expect(drawn).toBeGreaterThan(0)
  // A viewport holds tens of rows; the allowance is generous so this reports a
  // missing virtual window rather than a change in window height.
  expect(drawn).toBeLessThan(300)

  // Every value differs on exactly one in ten, so both counts must be real.
  const stats = await win.evaluate(() => window.__testAPI.regStats())
  expect(stats.different).toBeGreaterThan(0)
  expect(stats.same).toBeGreaterThan(0)
})

test('the differences filter drops the matching values', async () => {
  await win.evaluate(([l, r]) => window.__testAPI.openComparison({
    type: 'registry', leftPath: l, rightPath: r,
  }), [manyLeft, manyRight])
  await win.waitForFunction(() => window.__testAPI.currentView() === 'registry')
  await win.evaluate(() => window.__testAPI.regExpandAll())

  const all = await win.evaluate(() => window.__testAPI.regVisibleCount())
  await win.evaluate(() => window.__testAPI.regSetFilter('diff'))
  await win.evaluate(() => window.__testAPI.regExpandAll())
  const onlyDiff = await win.evaluate(() => window.__testAPI.regVisibleCount())

  expect(onlyDiff).toBeLessThan(all)
  expect(onlyDiff).toBeGreaterThan(0)
  await win.evaluate(() => window.__testAPI.regSetFilter('all'))
})

test('a live registry key loads as one side', async () => {
  // BC's registry session is mostly about live keys, not files people happen
  // to have exported. Nothing but a real run proves reg.exe is reachable, that
  // the export lands somewhere the path validator will then allow, and that
  // the parser handles what reg.exe actually writes rather than the fixtures
  // above. HKCU\Environment exists on every Windows install and is small.
  await win.evaluate(([l, r]) => window.__testAPI.openComparison({
    type: 'registry', leftPath: l, rightPath: r,
  }), [regPath, regPath])
  await win.waitForFunction(() => window.__testAPI.currentView() === 'registry')

  await win.evaluate(() =>
    window.__testAPI.regSetLiveKey('left', 'HKEY_CURRENT_USER\\Environment'))
  await win.evaluate(() =>
    window.__testAPI.regSetLiveKey('right', 'HKEY_CURRENT_USER\\Environment'))
  await win.evaluate(() => window.__testAPI.regExpandAll())

  const stats = await win.evaluate(() => window.__testAPI.regStats())
  // The same key on both sides: every value must match. A parse that dropped
  // or mangled values would show orphans here instead.
  expect(stats.same).toBeGreaterThan(0)
  expect(stats.different).toBe(0)
  expect(stats['left-only']).toBe(0)
  expect(stats['right-only']).toBe(0)
})

test('a key on another computer loads through the remote path', async () => {
  // Naming this computer takes exactly the remote code path — reg.exe cannot
  // export remotely, so this side goes through the registry API instead — and
  // is the only way to run it without a second machine. Remote reads serve
  // HKLM and HKU only, which is Windows' restriction, not this program's.
  const me = process.env.COMPUTERNAME
  test.skip(!me, 'no COMPUTERNAME to address')

  await win.evaluate((p) => window.__testAPI.openComparison({
    type: 'registry', leftPath: p, rightPath: '',
  }), regPath)
  await win.waitForFunction(() => window.__testAPI.currentView() === 'registry')

  await win.evaluate((m) => window.__testAPI.regSetLiveKey(
    'right', `\\\\${m}\\HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts`), me)

  const rows = await win.evaluate(() => window.__testAPI.regRowsForSide('right'))
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.every((r) => r.path.startsWith('HKEY_LOCAL_MACHINE'))).toBe(true)
  // Font entries are REG_SZ filenames; a mangled read would not look like this.
  expect(rows.some((r) => /\.ttf$/i.test(r.value))).toBe(true)
})

test('a remote target naming a root Windows will not serve is refused', async () => {
  const me = process.env.COMPUTERNAME
  test.skip(!me, 'no COMPUTERNAME to address')

  await win.evaluate((p) => window.__testAPI.openComparison({
    type: 'registry', leftPath: p, rightPath: '',
  }), regPath)
  await win.waitForFunction(() => window.__testAPI.currentView() === 'registry')

  await win.evaluate((m) =>
    window.__testAPI.regSetLiveKey('right', `\\\\${m}\\HKCU\\Environment`), me)
  const rows = await win.evaluate(() => window.__testAPI.regRowsForSide('right'))
  expect(rows).toHaveLength(0)
})

test('an unsafe key path never reaches reg.exe through the live loader', async () => {
  // Start from a known state: one side loaded, the other deliberately empty.
  await win.evaluate((p) => window.__testAPI.openComparison({
    type: 'registry', leftPath: p, rightPath: '',
  }), regPath)
  await win.waitForFunction(() => window.__testAPI.currentView() === 'registry')

  const before = await win.evaluate(() => window.__testAPI.regRowsForSide('right'))
  expect(before).toHaveLength(0)

  for (const bad of ['/y', '-y', 'HKEY_MADE_UP\\x', 'HKCU\\a"b']) {
    await win.evaluate((k) => window.__testAPI.regSetLiveKey('right', k), bad)
    // The view reports failures through its status channel instead of
    // throwing, so catching an exception proves nothing — an earlier version
    // of this test compared the result against a string that appears nowhere
    // in the codebase and could never fail. What has to hold is that nothing
    // was loaded.
    const after = await win.evaluate(() => window.__testAPI.regRowsForSide('right'))
    expect(after, bad).toHaveLength(0)
  }

  // The guard is not simply refusing everything: a real key still loads.
  await win.evaluate(() =>
    window.__testAPI.regSetLiveKey('right', 'HKEY_CURRENT_USER\\Environment'))
  const good = await win.evaluate(() => window.__testAPI.regRowsForSide('right'))
  expect(good.length).toBeGreaterThan(0)
})

test('a key path carrying argument syntax is rejected before reg.exe sees it', async () => {
  for (const bad of ['HKCU\\a"b', '/y', '-y', 'HKEY_MADE_UP\\x']) {
    const result = await win.evaluate(async (k) => {
      try {
        await window.electronAPI.exportRegistryKey(k)
        return 'allowed'
      } catch (err) {
        return String(err?.message ?? err)
      }
    }, bad)
    // The dialog is cancelled in headless runs, so 'null' is also a pass —
    // what must never happen is the path reaching the child process.
    expect(result, bad).not.toBe('allowed')
  }
})
