// @vitest-environment jsdom
/**
 * Electron does not implement `window.prompt` — it THROWS:
 *
 *     window.prompt('probe', 'x')  ->  TypeError: prompt() is not supported.
 *
 * So every native `prompt()` call site was dead code in a real run, not merely
 * degraded. jsdom, on the other hand, *does* define `window.prompt` (returning
 * null), which is exactly why the old unit tests never noticed: the thing that
 * throws in production quietly returns null in the test environment.
 *
 * These tests therefore do NOT try to reproduce the throw. They assert the
 * structural property that makes the throw impossible: the call sites go
 * through `core/modal.js`, and a cancelled dialog performs no action.
 *
 * The last block is a source guard so this cannot silently regress.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'


// The modal module is mocked for the call-site tests; the source guard below
// reads files from disk and is unaffected.
const promptMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/renderer/src/core/modal.js', async (importOriginal) => {
  /** @type {Record<string, unknown>} */
  const actual = await importOriginal()
  return { ...actual, prompt: promptMock }
})

const { FolderCompare } = await import('../../src/renderer/src/views/folder-compare.js')
const { TableCompare } = await import('../../src/renderer/src/views/table-compare.js')

/** @type {HTMLElement[]} */
let hosts = []

beforeEach(() => {
  promptMock.mockReset()
  document.body.innerHTML = ''
  hosts = []
  window.electronAPI = {
    renameFile: vi.fn().mockResolvedValue(undefined),
    mkdirFolder: vi.fn().mockResolvedValue(undefined),
    readDir: vi.fn().mockResolvedValue([]),
    showInExplorer: vi.fn(),
  }
})

afterEach(() => {
  for (const h of hosts) h.remove()
  document.body.innerHTML = ''
})

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Open the folder view's row context menu and return the rendered items.
 * The real context-menu module is used, so the returned buttons are the same
 * ones a user clicks.
 * @param {any} fc
 * @param {{ name: string, status?: string, isDir?: boolean, leftPath?: string, rightPath?: string }} row
 * @returns {HTMLButtonElement[]}
 */
function openRowMenu(fc, row) {
  const rowEl = document.createElement('div')
  rowEl.className = 'fc-row'
  rowEl.dataset.status = row.status ?? 'same'
  rowEl.dataset.isDir = String(row.isDir ?? false)
  rowEl.dataset.leftPath = row.leftPath ?? ''
  rowEl.dataset.rightPath = row.rightPath ?? ''
  rowEl.dataset.name = row.name
  document.body.appendChild(rowEl)

  const e = new MouseEvent('contextmenu', { bubbles: true })
  Object.defineProperty(e, 'target', { value: rowEl })
  fc._onRowContextMenu(e)
  return [...document.querySelectorAll('.ctx-menu .ctx-item')]
}

/**
 * @param {HTMLButtonElement[]} items
 * @param {string} label
 * @returns {HTMLButtonElement}
 */
function byLabel(items, label) {
  const hit = items.find(b => (b.textContent ?? '').trim() === label)
  if (!hit) throw new Error(`no menu item ${label}; got: ${items.map(b => b.textContent).join(' | ')}`)
  return hit
}

/** Let the awaited modal promise and the IPC promise after it settle. */
const settle = () => new Promise(r => setTimeout(r, 0))

// ── folder-compare: rename ───────────────────────────────────────────────────

describe('folder-compare 重新命名 uses the modal, not the global prompt', () => {
  it('renames with the name typed into the modal', async () => {
    const fc = new FolderCompare({ leftPath: '/left', rightPath: '/right' })
    promptMock.mockResolvedValue('new.txt')

    byLabel(openRowMenu(fc, { name: 'old.txt', leftPath: '/left/old.txt' }), '重新命名…').click()
    await settle()

    expect(promptMock).toHaveBeenCalledTimes(1)
    expect(promptMock.mock.calls[0][0]).toMatchObject({ defaultValue: 'old.txt' })
    expect(window.electronAPI.renameFile).toHaveBeenCalledWith('/left/old.txt', '/left/new.txt')
  })

  it('cancel (null) renames nothing', async () => {
    const fc = new FolderCompare({ leftPath: '/left', rightPath: '/right' })
    promptMock.mockResolvedValue(null)

    byLabel(openRowMenu(fc, { name: 'old.txt', leftPath: '/left/old.txt' }), '重新命名…').click()
    await settle()

    expect(promptMock).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.renameFile).not.toHaveBeenCalled()
  })

  it('an empty name renames nothing — null must not become the empty string', async () => {
    const fc = new FolderCompare({ leftPath: '/left', rightPath: '/right' })
    promptMock.mockResolvedValue('')

    byLabel(openRowMenu(fc, { name: 'old.txt', leftPath: '/left/old.txt' }), '重新命名…').click()
    await settle()

    expect(window.electronAPI.renameFile).not.toHaveBeenCalled()
  })

  it('the unchanged name renames nothing', async () => {
    const fc = new FolderCompare({ leftPath: '/left', rightPath: '/right' })
    promptMock.mockResolvedValue('old.txt')

    byLabel(openRowMenu(fc, { name: 'old.txt', leftPath: '/left/old.txt' }), '重新命名…').click()
    await settle()

    expect(window.electronAPI.renameFile).not.toHaveBeenCalled()
  })
})

// ── folder-compare: new folder (both sides) ──────────────────────────────────

describe('folder-compare 新建資料夾 uses the modal on both sides', () => {
  for (const [label, base] of [
    ['新建資料夾（左側）…', '/left'],
    ['新建資料夾（右側）…', '/right'],
  ]) {
    it(`${label} creates under ${base}`, async () => {
      const fc = new FolderCompare({ leftPath: '/left', rightPath: '/right' })
      promptMock.mockResolvedValue('sub')

      byLabel(openRowMenu(fc, { name: 'a.txt', leftPath: '/left/a.txt' }), label).click()
      await settle()

      expect(promptMock).toHaveBeenCalledTimes(1)
      expect(window.electronAPI.mkdirFolder).toHaveBeenCalledWith(`${base}/sub`)
    })

    it(`${label} creates nothing when cancelled`, async () => {
      const fc = new FolderCompare({ leftPath: '/left', rightPath: '/right' })
      promptMock.mockResolvedValue(null)

      byLabel(openRowMenu(fc, { name: 'a.txt', leftPath: '/left/a.txt' }), label).click()
      await settle()

      expect(promptMock).toHaveBeenCalledTimes(1)
      expect(window.electronAPI.mkdirFolder).not.toHaveBeenCalled()
    })
  }
})

// ── table-compare: column display name ───────────────────────────────────────

describe('table-compare 重新命名這一欄 uses the modal', () => {
  /** @returns {any} */
  function mountTable() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    hosts.push(host)
    const view = new TableCompare()
    view.mount(host)
    view.setLeft('C:/tmp/left.csv', 'id,v\n1,a\n2,b')
    view.setRight('C:/tmp/right.csv', 'id,v\n1,A\n2,b')
    return view
  }

  /** @returns {HTMLButtonElement[]} */
  function openCellMenu(view) {
    const tbody = view._dom.leftTbody
    const tr = tbody?.querySelector('tr.tc-row')
    const td = tr?.querySelector('td.tc-cell')
    const e = new MouseEvent('contextmenu', { bubbles: true })
    Object.defineProperty(e, 'target', { value: td ?? tr })
    view._onTableContextMenu(e, 'left')
    return [...document.querySelectorAll('.ctx-menu .ctx-item')]
  }

  it('applies the typed display name', async () => {
    const view = mountTable()
    promptMock.mockResolvedValue('編號')

    byLabel(openCellMenu(view), '重新命名這一欄（顯示用）…').click()
    await settle()

    expect(promptMock).toHaveBeenCalledTimes(1)
    // State has to live in the model — the view is virtualised.
    expect(view._columnNames[0]).toBe('編號')
  })

  it('cancel (null) leaves the column name untouched', async () => {
    const view = mountTable()
    const before = view._columnNames[0]
    promptMock.mockResolvedValue(null)

    byLabel(openCellMenu(view), '重新命名這一欄（顯示用）…').click()
    await settle()

    expect(promptMock).toHaveBeenCalledTimes(1)
    expect(view._columnNames[0]).toBe(before)
  })
})

// ── session-home-ui: new group ───────────────────────────────────────────────

describe('session-home-ui ＋新增資料夾 uses the modal', () => {
  /** @returns {Promise<any>} */
  async function renderHome() {
    localStorage.clear()
    const host = document.createElement('div')
    host.id = 'recent-list'
    document.body.appendChild(host)
    hosts.push(host)
    const mod = await import('../../src/renderer/src/core/session-home-ui.js')
    const { createSession } = await import('../../src/renderer/src/core/session.js')
    // The "＋ 新增資料夾" button is only rendered once there is at least one
    // session; the empty state returns early.
    mod.store.save(createSession('text', 's1', { leftPath: '/a', rightPath: '/b' }))
    mod.renderRecentSessions(() => {}, () => {})
    return mod
  }

  it('creates a group with the typed name', async () => {
    await renderHome()
    promptMock.mockResolvedValue('我的群組')

    const btn = [...document.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('新增資料夾'))
    expect(btn).toBeTruthy()
    btn.click()
    await settle()

    expect(promptMock).toHaveBeenCalledTimes(1)
    const { loadGroups } = await import('../../src/renderer/src/core/session-groups.js')
    expect(JSON.stringify(loadGroups())).toContain('我的群組')
  })

  it('cancel (null) creates no group', async () => {
    await renderHome()
    const { loadGroups } = await import('../../src/renderer/src/core/session-groups.js')
    const before = JSON.stringify(loadGroups())
    promptMock.mockResolvedValue(null)

    const btn = [...document.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('新增資料夾'))
    btn.click()
    await settle()

    expect(promptMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(loadGroups())).toBe(before)
  })
})

// ── Source guard ─────────────────────────────────────────────────────────────

describe('no renderer source calls the global prompt()', () => {
  // Empty, and it stays empty. It briefly held app.js while its eighteen call
  // sites were converted in a parallel change; an entry here is a file whose
  // rename, new-folder or naming dialog throws the moment a user reaches it,
  // so anything added would be a shipped-broken feature with a note attached.
  /** @type {string[]} */
  const PENDING = []

  it('finds zero call sites outside modal.js', () => {
    // import.meta.url is not a file: URL under the vitest transform, so the
    // repo root comes from the process working directory instead.
    const root = join(process.cwd(), 'src', 'renderer', 'src')

    /** @param {string} dir @returns {string[]} */
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(d =>
      d.isDirectory() ? walk(join(dir, d.name))
        : d.name.endsWith('.js') ? [join(dir, d.name)] : [])

    // `window.prompt(...)`, or a bare `prompt(` that is not a property access,
    // not a declaration/import, and not part of a longer identifier.
    const NATIVE = /(?:\bwindow\s*\.\s*prompt\s*\(|(?<![.\w$])prompt\s*\()/

    /** @type {string[]} */
    const offenders = []
    for (const file of walk(root)) {
      const rel = relative(root, file).replace(/\\/g, '/')
      // modal.js defines the replacement; PENDING is the migration backlog.
      if (rel === 'core/modal.js' || PENDING.includes(rel)) continue
      // Split on \r?\n: these files are CRLF, and `.` in a JS regex does not
      // match \r, so a trailing CR would defeat the comment stripping below
      // and turn every commented mention of prompt( into a false positive.
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
        if (!NATIVE.test(code)) return
        // `export function prompt(` / `import { prompt as x }` are not calls.
        if (/\b(?:function|import|export)\b/.test(code)) return
        offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`)
      })
    }

    expect(offenders).toEqual([])
  })
})
