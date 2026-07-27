/**
 * @vitest-environment jsdom
 *
 * Folder Compare — VCS status column, Source Control commands, Owner/Group
 * columns.
 *
 * The load-bearing property here is not "the cell says 已修改"; it is that the
 * whole tree costs *one* `git status`, and that owners are asked for in
 * batches for drawn rows only. Both columns are the same shape as the version
 * and checksum columns, which had to be rescued from per-row IPC once already.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  FolderCompare,
  FOLDER_COLUMN_DEFS,
  normalizeColumns,
  columnSortValue,
  lookupVcsState,
  ownerCellText,
  formatVcsOpSummary,
  VCS_STATE_BADGES,
} from '../../src/renderer/src/views/folder-compare.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @param {string} name
 * @returns {object}
 */
function mkRow(name) {
  const shared = { name, isDirectory: false, size: 10, mtime: '2024-01-01T00:00:00.000Z' }
  return {
    name,
    status: 'same',
    left: { ...shared, path: `/repo/left/${name}` },
    right: { ...shared, path: `/repo/right/${name}` },
    children: null,
  }
}

/**
 * @param {object} [api] extra electronAPI members
 * @returns {object}
 */
function stubAPI(api = {}) {
  window.electronAPI = {
    readDir: vi.fn().mockResolvedValue([]),
    copyFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    openFolder: vi.fn().mockResolvedValue(null),
    showInExplorer: vi.fn(),
    ...api,
  }
  return window.electronAPI
}

/**
 * Mount a view with rows already in the model, bypassing the scan.
 * @param {string[]} columns
 * @param {number} rowCount
 * @returns {FolderCompare}
 */
function mountWithRows(columns, rowCount) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const fc = new FolderCompare({})
  fc.mount(host)
  fc.setColumns(columns)
  fc._leftPath = '/repo/left'
  fc._rightPath = '/repo/right'
  fc._rows = Array.from({ length: rowCount }, (_, i) => mkRow(`f${i}.js`))
  fc._applyFilterAndRender()
  return fc
}

/** Let queued microtasks and the zero-delay drain timers run. */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  delete window.electronAPI
})

// ── 1. Column registration ──────────────────────────────────────────────────

describe('VCS / owner / group column registration', () => {
  it('declares all three columns', () => {
    const ids = FOLDER_COLUMN_DEFS.map((c) => c.id)
    expect(ids).toContain('vcs')
    expect(ids).toContain('owner')
    expect(ids).toContain('group')
  })

  it('accepts them through the column chooser, which is their entry point', () => {
    expect(normalizeColumns(['vcs', 'owner', 'group']))
      .toEqual(['name', 'vcs', 'owner', 'group'])
  })
})

// ── 2. Pure lookup ──────────────────────────────────────────────────────────

describe('lookupVcsState', () => {
  const repo = {
    root: '/repo',
    files: { 'src/a.js': 'modified', 'src/b.js': 'staged' },
    dirs: { 'node_modules/': 'ignored', 'node_modules/.cache/': 'untracked' },
  }

  it('returns the exact file entry when there is one', () => {
    expect(lookupVcsState(repo, '/repo/src/a.js')).toBe('modified')
    expect(lookupVcsState(repo, '/repo/src/b.js')).toBe('staged')
  })

  it('answers for a file inside a collapsed directory entry', () => {
    // git never enumerated these; the whole point of the prefix rule.
    expect(lookupVcsState(repo, '/repo/node_modules/left-pad/index.js')).toBe('ignored')
  })

  it('prefers the longest matching prefix', () => {
    expect(lookupVcsState(repo, '/repo/node_modules/.cache/x')).toBe('untracked')
  })

  it('reports an unlisted in-repo file as clean', () => {
    expect(lookupVcsState(repo, '/repo/src/untouched.js')).toBe('clean')
  })

  it('returns null outside the repository', () => {
    expect(lookupVcsState(repo, '/elsewhere/a.js')).toBeNull()
    expect(lookupVcsState(repo, '/repo-backup/a.js')).toBeNull()
    expect(lookupVcsState(repo, '/repo')).toBeNull()
  })

  it('matches Windows paths against a Windows root', () => {
    const win = { root: 'C:\\repo', files: { 'src/a.js': 'modified' }, dirs: {} }
    expect(lookupVcsState(win, 'C:\\repo\\src\\a.js')).toBe('modified')
    expect(lookupVcsState(win, 'C:\\other\\a.js')).toBeNull()
  })

  it('returns null for a missing repo rather than throwing', () => {
    expect(lookupVcsState(null, '/repo/a.js')).toBeNull()
    expect(lookupVcsState({}, '/repo/a.js')).toBeNull()
  })
})

// ── 3. One git call for the whole tree ──────────────────────────────────────

describe('VCS column IPC budget', () => {
  it('reads the status once per base folder, not once per row', async () => {
    const vcsStatus = vi.fn(async (dir) => ({
      available: true, vcs: 'git', root: dir, reason: 'ok', message: '',
      files: { 'f1.js': 'modified' }, dirs: {}, truncated: false,
    }))
    stubAPI({ vcsStatus })
    const fc = mountWithRows(['name', 'vcs'], 40)
    await settle()
    await settle()

    // Two base folders, 40 rows, 80 entries — and two calls.
    expect(vcsStatus).toHaveBeenCalledTimes(2)
    expect(vcsStatus.mock.calls.map((c) => c[0]).sort())
      .toEqual(['/repo/left', '/repo/right'])
    fc.destroy()
  })

  it('does not re-ask on re-render', async () => {
    const vcsStatus = vi.fn(async (dir) => ({
      available: true, vcs: 'git', root: dir, reason: 'ok', message: '',
      files: {}, dirs: {}, truncated: false,
    }))
    stubAPI({ vcsStatus })
    const fc = mountWithRows(['name', 'vcs'], 5)
    await settle(); await settle()
    fc._applyFilterAndRender()
    await settle(); await settle()
    expect(vcsStatus).toHaveBeenCalledTimes(2)
    fc.destroy()
  })

  it('paints the state and its tooltip once the table lands', async () => {
    stubAPI({
      vcsStatus: vi.fn(async (dir) => ({
        available: true, vcs: 'git', root: dir, reason: 'ok', message: '',
        files: { 'f0.js': 'conflict' }, dirs: {}, truncated: false,
      })),
    })
    const fc = mountWithRows(['name', 'vcs'], 1)
    await settle(); await settle()
    const cell = document.querySelector('.fc-vcs')
    expect(cell.textContent).toBe(VCS_STATE_BADGES.conflict)
    expect(cell.classList.contains('fc-vcs--conflict')).toBe(true)
    expect(cell.title).not.toBe('')
    fc.destroy()
  })

  it('stays quiet outside a repository instead of erroring per row', async () => {
    const fc0 = mountWithRows(['name'], 0)
    const setScanStatus = vi.spyOn(fc0, '_setScanStatus')
    fc0.destroy()

    stubAPI({
      vcsStatus: vi.fn(async () => ({
        available: false, vcs: null, root: null, reason: 'not-a-repo',
        message: '此資料夾不在 git 工作區內', files: {}, dirs: {}, truncated: false,
      })),
    })
    const fc = mountWithRows(['name', 'vcs'], 3)
    const spy = vi.spyOn(fc, '_setScanStatus')
    await settle(); await settle()
    expect(spy).not.toHaveBeenCalled()
    expect(document.querySelector('.fc-vcs').textContent).toBe('—')
    setScanStatus.mockRestore()
    fc.destroy()
  })

  it('says so loudly when git is not on PATH', async () => {
    stubAPI({
      vcsStatus: vi.fn(async () => ({
        available: false, vcs: null, root: null, reason: 'git-missing',
        message: '找不到 git 執行檔（不在 PATH 上）', files: {}, dirs: {}, truncated: false,
      })),
    })
    const fc = mountWithRows(['name', 'vcs'], 2)
    const spy = vi.spyOn(fc, '_setScanStatus')
    await settle(); await settle()
    // A silent fallback here would show every row as clean and tell the user
    // their edits are not there.
    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls[0][0]).toContain('git')
    expect(fc.getLog().join('\n')).toContain('git')
    expect(document.querySelector('.fc-vcs').title).toContain('git')
    fc.destroy()
  })

  it('shows an em dash for virtual sources that have no working copy', async () => {
    stubAPI({ vcsStatus: vi.fn() })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const fc = new FolderCompare({})
    fc.mount(host)
    fc.setColumns(['name', 'vcs'])
    const cell = fc._buildVcsCell({ name: 'a.js', path: 'snapshot://snap/a.js' })
    expect(cell.textContent).toBe('—')
    expect(cell.title).not.toBe('')
    expect(window.electronAPI.vcsStatus).not.toHaveBeenCalled()
    fc.destroy()
  })
})

// ── 4. Source Control commands ──────────────────────────────────────────────

describe('formatVcsOpSummary', () => {
  it('counts the three outcomes in the headline', () => {
    const text = formatVcsOpSummary('還原', [
      { path: '/a', state: 'done', message: '' },
      { path: '/b', state: 'failed', message: 'boom' },
      { path: '/c', state: 'skipped', message: '不在版本庫內' },
    ])
    expect(text).toContain('1 項成功')
    expect(text).toContain('1 項略過')
    expect(text).toContain('1 項失敗')
  })

  it('names every path that did not succeed, not just the count', () => {
    const text = formatVcsOpSummary('加入索引', [
      { path: '/ok', state: 'done', message: '' },
      { path: '/bad', state: 'failed', message: 'permission denied' },
    ])
    expect(text).toContain('/bad')
    expect(text).toContain('permission denied')
    expect(text).not.toContain('/ok\n')
  })

  it('handles an empty batch', () => {
    expect(formatVcsOpSummary('還原', [])).toContain('0 項成功')
    expect(formatVcsOpSummary('還原', null)).toContain('0 項成功')
  })
})

describe('runVcsAction', () => {
  /** @type {string[]} */
  let alerts

  beforeEach(() => {
    alerts = []
    window.alert = (m) => alerts.push(String(m))
    window.confirm = () => true
  })

  it('confirms before writing and groups paths by repository', async () => {
    const vcsRun = vi.fn(async ({ paths }) => ({
      results: paths.map((path) => ({ path, state: 'done', message: '' })),
    }))
    stubAPI({
      vcsStatus: vi.fn(async (dir) => ({
        available: true, vcs: 'git', root: dir, reason: 'ok', message: '',
        files: {}, dirs: {}, truncated: false,
      })),
      vcsRun,
      readDir: vi.fn().mockResolvedValue([]),
    })
    const confirmSpy = vi.fn(() => true)
    window.confirm = confirmSpy

    const fc = mountWithRows(['name', 'vcs'], 1)
    await fc._ensureVcsStatus()
    await fc.runVcsAction('revert', ['/repo/left/f0.js', '/repo/right/f0.js'])

    expect(confirmSpy).toHaveBeenCalled()
    // Left and right are separate repository roots here, so two calls.
    expect(vcsRun).toHaveBeenCalledTimes(2)
    expect(vcsRun.mock.calls.map((c) => c[0].root).sort())
      .toEqual(['/repo/left', '/repo/right'])
    expect(alerts.join('\n')).toContain('2 項成功')
    fc.destroy()
  })

  it('does nothing when the confirmation is declined', async () => {
    const vcsRun = vi.fn()
    stubAPI({
      vcsStatus: vi.fn(async (dir) => ({
        available: true, vcs: 'git', root: dir, reason: 'ok', message: '',
        files: {}, dirs: {}, truncated: false,
      })),
      vcsRun,
    })
    window.confirm = () => false
    const fc = mountWithRows(['name', 'vcs'], 1)
    await fc._ensureVcsStatus()
    await fc.runVcsAction('revert', ['/repo/left/f0.js'])
    expect(vcsRun).not.toHaveBeenCalled()
    fc.destroy()
  })

  it('reports a half-finished batch instead of one blanket failure', async () => {
    stubAPI({
      vcsStatus: vi.fn(async (dir) => ({
        available: true, vcs: 'git', root: dir, reason: 'ok', message: '',
        files: {}, dirs: {}, truncated: false,
      })),
      vcsRun: vi.fn(async ({ paths }) => ({
        results: paths.map((path, i) => i === 0
          ? { path, state: 'done', message: '' }
          : { path, state: 'failed', message: 'index.lock exists' }),
      })),
      readDir: vi.fn().mockResolvedValue([]),
    })
    const fc = mountWithRows(['name', 'vcs'], 2)
    await fc._ensureVcsStatus()
    await fc.runVcsAction('add', ['/repo/left/f0.js', '/repo/left/f1.js'])
    const text = alerts.join('\n')
    expect(text).toContain('1 項成功')
    expect(text).toContain('1 項失敗')
    expect(text).toContain('index.lock exists')
    fc.destroy()
  })

  it('refuses paths outside any loaded repository, naming them', async () => {
    const vcsRun = vi.fn()
    stubAPI({
      vcsStatus: vi.fn(async () => ({
        available: false, vcs: null, root: null, reason: 'not-a-repo',
        message: '', files: {}, dirs: {}, truncated: false,
      })),
      vcsRun,
    })
    const fc = mountWithRows(['name', 'vcs'], 1)
    await fc._ensureVcsStatus()
    await fc.runVcsAction('add', ['/repo/left/f0.js'])
    expect(vcsRun).not.toHaveBeenCalled()
    expect(alerts.join('\n')).toContain('git')
    fc.destroy()
  })
})

describe('showVcsText', () => {
  beforeEach(() => {
    window.alert = () => {}
  })

  it('opens a dialog holding the command output', async () => {
    stubAPI({
      vcsStatus: vi.fn(async (dir) => ({
        available: true, vcs: 'git', root: dir, reason: 'ok', message: '',
        files: {}, dirs: {}, truncated: false,
      })),
      vcsText: vi.fn(async () => ({ text: 'diff --git a/f0.js b/f0.js\n+added', truncated: false })),
    })
    const fc = mountWithRows(['name', 'vcs'], 1)
    await fc._ensureVcsStatus()
    await fc.showVcsText('diff', '/repo/left/f0.js')
    const body = document.querySelector('.fc-text-body')
    expect(body).not.toBeNull()
    expect(body.textContent).toContain('+added')
    fc.destroy()
  })

  it('explains an empty result rather than showing a blank pane', async () => {
    stubAPI({
      vcsStatus: vi.fn(async (dir) => ({
        available: true, vcs: 'git', root: dir, reason: 'ok', message: '',
        files: {}, dirs: {}, truncated: false,
      })),
      vcsText: vi.fn(async () => ({ text: '', truncated: false })),
    })
    const fc = mountWithRows(['name', 'vcs'], 1)
    await fc._ensureVcsStatus()
    await fc.showVcsText('log', '/repo/left/f0.js')
    expect(document.querySelector('.fc-text-body').textContent).not.toBe('')
    fc.destroy()
  })

  it('surfaces a failure instead of swallowing it', async () => {
    const alerts = []
    window.alert = (m) => alerts.push(String(m))
    stubAPI({
      vcsStatus: vi.fn(async (dir) => ({
        available: true, vcs: 'git', root: dir, reason: 'ok', message: '',
        files: {}, dirs: {}, truncated: false,
      })),
      vcsText: vi.fn(async () => { throw new Error('fatal: bad revision') }),
    })
    const fc = mountWithRows(['name', 'vcs'], 1)
    await fc._ensureVcsStatus()
    await fc.showVcsText('diff', '/repo/left/f0.js')
    expect(alerts.join('\n')).toContain('fatal: bad revision')
    expect(document.querySelector('.fc-text-body')).toBeNull()
    fc.destroy()
  })
})

// ── 5. Owner / Group columns ────────────────────────────────────────────────

describe('ownerCellText', () => {
  it('shows an em dash rather than a blank for an unknown value', () => {
    expect(ownerCellText('')).toBe('—')
    expect(ownerCellText(undefined)).toBe('—')
    expect(ownerCellText('HOST\\Eddy')).toBe('HOST\\Eddy')
  })
})

describe('owner column IPC budget', () => {
  it('asks in batches for drawn rows only, not once per file', async () => {
    const fileOwners = vi.fn(async (paths) => paths.map((path) => ({
      path, owner: 'HOST\\Eddy', group: 'HOST\\None', error: '',
    })))
    stubAPI({ fileOwners })
    const fc = mountWithRows(['name', 'owner', 'group'], 12)
    await settle(); await settle()

    // One coalesced drain, not one call per cell and not one per row.
    expect(fileOwners).toHaveBeenCalledTimes(1)
    const asked = fileOwners.mock.calls[0][0]
    expect(asked.length).toBeLessThanOrEqual(24)
    expect(new Set(asked).size).toBe(asked.length)
    fc.destroy()
  })

  it('fills both the owner and the group cell from one lookup', async () => {
    stubAPI({
      fileOwners: vi.fn(async (paths) => paths.map((path) => ({
        path, owner: 'HOST\\Eddy', group: 'HOST\\None', error: '',
      }))),
    })
    const fc = mountWithRows(['name', 'owner', 'group'], 1)
    await settle(); await settle()
    expect(document.querySelector('.fc-owner.fc-owner').textContent).toBe('HOST\\Eddy')
    expect(document.querySelector('.fc-group').textContent).toBe('HOST\\None')
    fc.destroy()
  })

  it('does not re-ask for a path already answered', async () => {
    const fileOwners = vi.fn(async (paths) => paths.map((path) => ({
      path, owner: 'u', group: 'g', error: '',
    })))
    stubAPI({ fileOwners })
    const fc = mountWithRows(['name', 'owner'], 3)
    await settle(); await settle()
    fc._applyFilterAndRender()
    await settle(); await settle()
    expect(fileOwners).toHaveBeenCalledTimes(1)
    fc.destroy()
  })

  it('shows an em dash with the reason in the tooltip when the lookup fails', async () => {
    stubAPI({
      fileOwners: vi.fn(async (paths) => paths.map((path) => ({
        path, owner: '', group: '', error: 'Access is denied.',
      }))),
    })
    const fc = mountWithRows(['name', 'owner'], 1)
    await settle(); await settle()
    const cell = document.querySelector('.fc-owner')
    expect(cell.textContent).toBe('—')
    expect(cell.title).toContain('Access is denied.')
    fc.destroy()
  })

  it('explains rather than hangs when the IPC rejects', async () => {
    stubAPI({ fileOwners: vi.fn(async () => { throw new Error('IPC gone') }) })
    const fc = mountWithRows(['name', 'owner'], 1)
    await settle(); await settle()
    const cell = document.querySelector('.fc-owner')
    expect(cell.textContent).toBe('—')
    expect(cell.title).toContain('IPC gone')
    fc.destroy()
  })

  it('does not query virtual sources that have no owner to report', async () => {
    const fileOwners = vi.fn()
    stubAPI({ fileOwners })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const fc = new FolderCompare({})
    fc.mount(host)
    const cell = fc._buildOwnerCell({ name: 'a', path: 'remote://host/a' }, 'owner')
    await settle()
    expect(cell.textContent).toBe('—')
    expect(cell.title).not.toBe('')
    expect(fileOwners).not.toHaveBeenCalled()
    fc.destroy()
  })
})

// ── 6. Sorting ──────────────────────────────────────────────────────────────

describe('sorting on the new columns', () => {
  it('reads the value the column wrote back onto the entry', () => {
    const row = mkRow('a.js')
    row.left.owner = 'alice'
    row.left.group = 'staff'
    row.left.vcsState = 'modified'
    expect(columnSortValue(row, 'owner')).toBe('alice')
    expect(columnSortValue(row, 'group')).toBe('staff')
    expect(columnSortValue(row, 'vcs')).toBe('modified')
  })

  it('sorts an unread value as empty rather than guessing at it', () => {
    const row = mkRow('a.js')
    expect(columnSortValue(row, 'owner')).toBe('')
    expect(columnSortValue(row, 'group')).toBe('')
    expect(columnSortValue(row, 'vcs')).toBe('')
  })

  it('gives every row a VCS sort key, not only the drawn ones', async () => {
    // The defect this pins: entry.vcsState was written by the cell builder
    // alone, which runs for the virtual window. One `git status` covers the
    // whole tree, so it looked as though no prefetch was needed — but the
    // lookup table is not the sort key. Every row past the viewport sorted as
    // '', which on any real tree reads as the sort doing nothing.
    const files = {}
    const ROWS = 400
    for (let i = 0; i < ROWS; i++) files[`f${i}.js`] = 'modified'
    stubAPI({
      vcsStatus: vi.fn(async (dir) => ({
        available: true, vcs: 'git', root: dir, reason: 'ok', message: '',
        files, dirs: {}, truncated: false,
      })),
    })

    const fc = mountWithRows(['name', 'vcs'], ROWS)
    await settle(); await settle()

    // Guard the premise: if everything were drawn there would be nothing to
    // prove, and this test would pass without the fix.
    const drawn = document.querySelectorAll('.fc-vcs').length
    expect(drawn).toBeLessThan(ROWS)

    await fc.prefetchVcsForSort()

    const unset = fc._rows.filter((r) => !r.left.vcsState).length
    expect(unset, 'rows left without a sort key after the prefetch').toBe(0)
    expect(columnSortValue(fc._rows[ROWS - 1], 'vcs')).toBe('modified')
    fc.destroy()
  })

  it('prefetches owners when the column is sorted on', async () => {
    const fileOwners = vi.fn(async (paths) => paths.map((path) => ({
      path, owner: 'u', group: 'g', error: '',
    })))
    stubAPI({ fileOwners })
    const fc = mountWithRows(['name', 'owner'], 4)
    await settle(); await settle()
    fileOwners.mockClear()
    // Every visible row was already drawn and cached, so the prefetch has
    // nothing left to ask — which is exactly the budget working.
    await fc.prefetchOwnersForSort()
    expect(fileOwners).not.toHaveBeenCalled()
    fc.destroy()
  })
})
