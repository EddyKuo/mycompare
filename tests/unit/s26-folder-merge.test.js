/**
 * @vitest-environment jsdom
 *
 * S26 — 三向資料夾合併（Folder Merge）。
 *
 * 兩段式：先釘住純函式（狀態判定、輸出計畫、破壞性執行的中途失敗），
 * 再從真的掛載起來的視圖去確認每一項都有使用者到得了的入口。
 * 這個專案已經多次出現「模組完整、單元測試齊全、但沒有任何呼叫端」，
 * 所以下半段每個功能都從工具列／面板／右鍵選單點下去。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { setActiveView } from '../../src/renderer/src/core/active-view.js'
import {
  FolderCompare,
  computeMergeStatus,
  autoMergePick,
  mergeAutoResolvable,
  effectiveMergePick,
  isMergeConflict,
  buildMergeRows,
  gradeMergeRows,
  rollupMergeStatus,
  summarizeMergeTree,
  buildMergeOps,
  runMergeOps,
  formatMergeSummary,
  joinOutputPath,
  MERGE_STATUS_LABELS,
  eachRow,
  flattenRows,
} from '../../src/renderer/src/views/folder-compare.js'

/** Items handed to the shared context menu by the last right-click. */
let menuItems = []
vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: (_e, items) => { menuItems = items },
  closeContextMenu: () => {},
}))

/** @type {string[]} */
let alerts = []
/** @type {string[]} */
let confirms = []
/** @type {boolean|((msg: string) => boolean)} */
let confirmAnswer = true
/** @type {FolderCompare[]} */
let mountedViews = []

beforeEach(() => {
  alerts = []
  confirms = []
  menuItems = []
  confirmAnswer = true
  vi.stubGlobal('alert', (msg) => { alerts.push(String(msg)) })
  vi.stubGlobal('confirm', (msg) => {
    confirms.push(String(msg))
    return typeof confirmAnswer === 'function' ? confirmAnswer(String(msg)) : confirmAnswer
  })
  localStorage.clear()
  setActiveView('folder')
})

afterEach(() => {
  for (const fc of mountedViews) fc.destroy()
  mountedViews = []
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

// ── helpers ─────────────────────────────────────────────────────────────────

/** @param {object} o */
function entry(o = {}) {
  return {
    name: o.name ?? 'a.txt',
    path: o.path ?? '/left/a.txt',
    isDirectory: !!o.isDirectory,
    size: o.size ?? 10,
    mtime: o.mtime ?? '2024-01-01T00:00:00.000Z',
  }
}

/**
 * A merge row with whichever of the three sides were named.
 * @param {object} o
 */
function mrow(o = {}) {
  const name = o.name ?? 'a.txt'
  /** @param {'left'|'base'|'right'} side */
  const side = (s) => (o[s] === undefined || o[s] === null
    ? null
    : entry({ name, path: `/${s}/${name}`, ...(o[s] === true ? {} : o[s]) }))
  return {
    name,
    base: side('base'),
    left: side('left'),
    right: side('right'),
    status: o.status ?? 'same',
    mergeStatus: o.mergeStatus ?? 'same',
    mergeResolution: o.mergeResolution ?? null,
    children: o.children ?? null,
  }
}

// ── 1. 狀態判定表 ────────────────────────────────────────────────────────────

describe('三向狀態判定', () => {
  /**
   * The full table, exactly as the design describes it. Each row is
   * [hasBase, hasLeft, hasRight, eqLB, eqRB, eqLR] → expected status.
   */
  const table = [
    ['三方相同', { hasBase: 1, hasLeft: 1, hasRight: 1, eqLB: 1, eqRB: 1, eqLR: 1 }, 'same'],
    ['只有左改', { hasBase: 1, hasLeft: 1, hasRight: 1, eqLB: 0, eqRB: 1, eqLR: 0 }, 'left-changed'],
    ['只有右改', { hasBase: 1, hasLeft: 1, hasRight: 1, eqLB: 1, eqRB: 0, eqLR: 0 }, 'right-changed'],
    ['兩側同樣的改', { hasBase: 1, hasLeft: 1, hasRight: 1, eqLB: 0, eqRB: 0, eqLR: 1 }, 'both-changed-same'],
    ['兩側不同的改', { hasBase: 1, hasLeft: 1, hasRight: 1, eqLB: 0, eqRB: 0, eqLR: 0 }, 'conflict-changed'],
    ['右刪除、左未動', { hasBase: 1, hasLeft: 1, hasRight: 0, eqLB: 1 }, 'right-deleted'],
    ['右刪除、左有改', { hasBase: 1, hasLeft: 1, hasRight: 0, eqLB: 0 }, 'conflict-modify-delete'],
    ['左刪除、右未動', { hasBase: 1, hasLeft: 0, hasRight: 1, eqRB: 1 }, 'left-deleted'],
    ['左刪除、右有改', { hasBase: 1, hasLeft: 0, hasRight: 1, eqRB: 0 }, 'conflict-modify-delete'],
    ['兩側都刪除', { hasBase: 1, hasLeft: 0, hasRight: 0 }, 'both-deleted'],
    ['兩側新增相同', { hasBase: 0, hasLeft: 1, hasRight: 1, eqLR: 1 }, 'both-added-same'],
    ['兩側新增不同', { hasBase: 0, hasLeft: 1, hasRight: 1, eqLR: 0 }, 'conflict-added'],
    ['只有左新增', { hasBase: 0, hasLeft: 1, hasRight: 0 }, 'left-added'],
    ['只有右新增', { hasBase: 0, hasLeft: 0, hasRight: 1 }, 'right-added'],
    ['三方都沒有', { hasBase: 0, hasLeft: 0, hasRight: 0 }, 'absent'],
  ]

  for (const [label, facts, expected] of table) {
    it(`${label} → ${expected}`, () => {
      const bools = Object.fromEntries(
        Object.entries(facts).map(([k, v]) => [k, !!v]))
      expect(computeMergeStatus(bools)).toBe(expected)
    })
  }

  it('每個狀態都有顯示標籤', () => {
    for (const [, , status] of table) {
      expect(MERGE_STATUS_LABELS[status]).toBeTruthy()
    }
    expect(MERGE_STATUS_LABELS.mixed).toBeTruthy()
  })

  it('三種衝突都被認得，其餘都不是衝突', () => {
    const conflicts = table.filter(([, , s]) => s.startsWith('conflict')).map(([, , s]) => s)
    expect(new Set(conflicts).size).toBe(3)
    for (const [, , s] of table) {
      expect(isMergeConflict(s)).toBe(s.startsWith('conflict'))
    }
  })
})

describe('自動合併的判定', () => {
  it('可自動合併的狀態各自有明確的取用來源', () => {
    expect(autoMergePick('same')).toBe('left')
    expect(autoMergePick('left-changed')).toBe('left')
    expect(autoMergePick('right-changed')).toBe('right')
    expect(autoMergePick('both-changed-same')).toBe('left')
    expect(autoMergePick('left-added')).toBe('left')
    expect(autoMergePick('right-added')).toBe('right')
    expect(autoMergePick('both-added-same')).toBe('left')
    expect(autoMergePick('left-deleted')).toBe('delete')
    expect(autoMergePick('right-deleted')).toBe('delete')
    expect(autoMergePick('both-deleted')).toBe('delete')
  })

  it('衝突不會自動合併', () => {
    for (const s of ['conflict-changed', 'conflict-added', 'conflict-modify-delete']) {
      expect(autoMergePick(s)).toBeNull()
      expect(mergeAutoResolvable(s)).toBe(false)
    }
  })

  it('手動決議蓋過自動判定，清掉之後回到自動', () => {
    const row = mrow({ base: true, left: true, right: true, mergeStatus: 'left-changed' })
    expect(effectiveMergePick(row)).toBe('left')
    row.mergeResolution = 'right'
    expect(effectiveMergePick(row)).toBe('right')
    row.mergeResolution = null
    expect(effectiveMergePick(row)).toBe('left')
  })
})

// ── 2. 配對與 rollup ─────────────────────────────────────────────────────────

describe('三向配對', () => {
  it('三個清單配成一列，資料夾排在檔案前面', () => {
    const rows = buildMergeRows(
      [entry({ name: 'b.txt', path: '/base/b.txt' })],
      [entry({ name: 'b.txt', path: '/left/b.txt' }), entry({ name: 'sub', path: '/left/sub', isDirectory: true })],
      [entry({ name: 'c.txt', path: '/right/c.txt' })],
    )
    expect(rows.map((r) => r.name)).toEqual(['sub', 'b.txt', 'c.txt'])
    const b = rows.find((r) => r.name === 'b.txt')
    expect(b.base.path).toBe('/base/b.txt')
    expect(b.left.path).toBe('/left/b.txt')
    expect(b.right).toBeNull()
  })

  it('沿用比對用的檔名大小寫規則，三側一起套用', () => {
    const rows = buildMergeRows(
      [entry({ name: 'README', path: '/base/README' })],
      [entry({ name: 'readme', path: '/left/readme' })],
      [entry({ name: 'ReadMe', path: '/right/ReadMe' })],
      { caseInsensitive: true },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].base && rows[0].left && rows[0].right).toBeTruthy()
  })

  it('gradeMergeRows 依 equals 回呼判定，目錄只看存在與否', () => {
    const rows = [
      mrow({ name: 'a.txt', base: true, left: true, right: true, mergeStatus: 'absent' }),
      mrow({ name: 'sub', base: { isDirectory: true }, left: { isDirectory: true }, right: { isDirectory: true }, mergeStatus: 'absent' }),
    ]
    // left ≠ base, right = base ⇒ 只有左側改
    gradeMergeRows(rows, (a, b) => !(a.path.includes('/left/') || b.path.includes('/left/')))
    expect(rows[0].mergeStatus).toBe('left-changed')
    expect(rows[1].mergeStatus).toBe('same')
  })
})

describe('目錄的 rollup', () => {
  it('三側都有的目錄，子項有衝突就是衝突', () => {
    const dir = mrow({
      name: 'sub',
      base: { isDirectory: true }, left: { isDirectory: true }, right: { isDirectory: true },
      mergeStatus: 'same',
      children: [mrow({ name: 'x', mergeStatus: 'conflict-changed' })],
    })
    expect(rollupMergeStatus(dir)).toBe('conflict-changed')
  })

  it('子項只是有變更，目錄是 mixed 而不是三方相同', () => {
    const dir = mrow({
      name: 'sub',
      base: { isDirectory: true }, left: { isDirectory: true }, right: { isDirectory: true },
      mergeStatus: 'same',
      children: [mrow({ name: 'x', mergeStatus: 'left-changed' })],
    })
    expect(rollupMergeStatus(dir)).toBe('mixed')
  })

  it('一側刪掉的目錄，若存活側有變更則升為修改/刪除衝突', () => {
    const dir = mrow({
      name: 'sub',
      base: { isDirectory: true }, left: { isDirectory: true }, right: null,
      mergeStatus: 'right-deleted',
      children: [mrow({ name: 'x', mergeStatus: 'left-changed' })],
    })
    expect(rollupMergeStatus(dir)).toBe('conflict-modify-delete')
  })

  it('子項尚未載入的目錄不臆測', () => {
    const dir = mrow({
      name: 'sub',
      base: { isDirectory: true }, left: { isDirectory: true }, right: { isDirectory: true },
      mergeStatus: 'same', children: null,
    })
    expect(rollupMergeStatus(dir)).toBe('same')
  })
})

describe('summarizeMergeTree', () => {
  it('數出衝突、已決、未決與未展開', () => {
    const rows = [
      mrow({ name: 'a', mergeStatus: 'conflict-changed' }),
      mrow({ name: 'b', mergeStatus: 'conflict-added', mergeResolution: 'left' }),
      mrow({ name: 'c', mergeStatus: 'left-changed' }),
      mrow({ name: 'd', mergeStatus: 'right-changed', mergeResolution: 'left' }),
      mrow({
        name: 'sub', left: { isDirectory: true }, base: { isDirectory: true },
        right: { isDirectory: true }, mergeStatus: 'mixed', children: null,
      }),
    ]
    const s = summarizeMergeTree(rows)
    expect(s.conflicts).toBe(2)
    expect(s.resolved).toBe(1)
    expect(s.unresolved).toBe(1)
    expect(s.overrides).toBe(1)   // d 的自動判定是 right，被改成 left
    expect(s.files).toBe(4)
    expect(s.partial).toBe(true)
  })
})

// ── 3. 輸出計畫 ──────────────────────────────────────────────────────────────

describe('joinOutputPath', () => {
  it('沿用輸出根目錄自己的分隔符號', () => {
    expect(joinOutputPath('C:\\out', 'sub/a.txt')).toBe('C:\\out\\sub\\a.txt')
    expect(joinOutputPath('/out/', 'sub/a.txt')).toBe('/out/sub/a.txt')
    expect(joinOutputPath('/out', '')).toBe('/out')
  })
})

describe('buildMergeOps', () => {
  const opts = (over = {}) => ({ outPath: '/out', existing: new Set(), ...over })

  it('可自動合併的列各自複製正確的一份', () => {
    const rows = [
      mrow({ name: 'l.txt', base: true, left: true, right: true, mergeStatus: 'left-changed' }),
      mrow({ name: 'r.txt', base: true, left: true, right: true, mergeStatus: 'right-changed' }),
      mrow({ name: 'n.txt', left: true, mergeStatus: 'left-added' }),
    ]
    const ops = buildMergeOps(rows, opts())
    expect(ops.map((o) => [o.op, o.src, o.dest])).toEqual([
      ['copy', '/left/l.txt', '/out/l.txt'],
      ['copy', '/right/r.txt', '/out/r.txt'],
      ['copy', '/left/n.txt', '/out/n.txt'],
    ])
  })

  it('未決的衝突不產生任何操作', () => {
    const rows = [mrow({ name: 'a.txt', base: true, left: true, right: true, mergeStatus: 'conflict-changed' })]
    expect(buildMergeOps(rows, opts())).toEqual([])
  })

  it('衝突有了決議才產生操作', () => {
    const rows = [mrow({
      name: 'a.txt', base: true, left: true, right: true,
      mergeStatus: 'conflict-changed', mergeResolution: 'right',
    })]
    const ops = buildMergeOps(rows, opts())
    expect(ops).toHaveLength(1)
    expect(ops[0].src).toBe('/right/a.txt')
  })

  it('刪除只在輸出資料夾真的有那個路徑時才排入', () => {
    const rows = [
      mrow({ name: 'gone.txt', base: true, mergeStatus: 'both-deleted' }),
      mrow({ name: 'here.txt', base: true, mergeStatus: 'both-deleted' }),
    ]
    const ops = buildMergeOps(rows, opts({ existing: new Set(['here.txt']) }))
    expect(ops.map((o) => [o.op, o.dest])).toEqual([['delete', '/out/here.txt']])
  })

  it('輸出就是來源時，同一個檔案不會複製到自己身上', () => {
    const rows = [mrow({ name: 'a.txt', base: true, left: { path: '/out/a.txt' }, right: true, mergeStatus: 'left-changed' })]
    expect(buildMergeOps(rows, opts())).toEqual([])
  })

  it('資料夾只有在裡面什麼都不會產生時才建立', () => {
    const rows = [
      mrow({
        name: 'full', left: { isDirectory: true }, base: { isDirectory: true },
        right: { isDirectory: true }, mergeStatus: 'mixed',
        children: [mrow({ name: 'a.txt', base: true, left: true, right: true, mergeStatus: 'left-changed' })],
      }),
      mrow({
        name: 'empty', left: { isDirectory: true }, base: { isDirectory: true },
        right: { isDirectory: true }, mergeStatus: 'same', children: [],
      }),
    ]
    const ops = buildMergeOps(rows, opts())
    expect(ops.map((o) => [o.op, o.dest])).toEqual([
      ['copy', '/out/full/a.txt'],
      ['mkdir', '/out/empty'],
    ])
  })

  it('要刪掉的資料夾以一個操作涵蓋整個子樹，不再走進去', () => {
    const rows = [mrow({
      name: 'sub', base: { isDirectory: true }, mergeStatus: 'both-deleted',
      children: [mrow({ name: 'a.txt', base: true, mergeStatus: 'both-deleted' })],
    })]
    const ops = buildMergeOps(rows, opts({ existing: new Set(['sub', 'sub/a.txt']) }))
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ op: 'delete', dest: '/out/sub', isDir: true })
  })

  it('巢狀路徑帶著相對路徑往下走', () => {
    const rows = [mrow({
      name: 'sub', left: { isDirectory: true }, base: { isDirectory: true },
      right: { isDirectory: true }, mergeStatus: 'mixed',
      children: [mrow({ name: 'deep.txt', base: true, left: true, right: true, mergeStatus: 'left-changed' })],
    })]
    const ops = buildMergeOps(rows, opts())
    expect(ops[0].rel).toBe('sub/deep.txt')
    expect(ops[0].dest).toBe('/out/sub/deep.txt')
  })

  it('略過的列什麼都不做', () => {
    const rows = [mrow({
      name: 'a.txt', base: true, left: true, right: true,
      mergeStatus: 'conflict-changed', mergeResolution: 'skip',
    })]
    expect(buildMergeOps(rows, opts())).toEqual([])
  })
})

// ── 4. 破壞性執行：中途失敗 ──────────────────────────────────────────────────

describe('runMergeOps', () => {
  /** @param {object} over */
  const api = (over = {}) => ({
    copyFile: vi.fn().mockResolvedValue({ copied: true }),
    deleteFile: vi.fn().mockResolvedValue({ deleted: true }),
    renameFile: vi.fn().mockResolvedValue(undefined),
    mkdirFolder: vi.fn().mockResolvedValue(undefined),
    ...over,
  })

  const plan = () => buildMergeOps([
    mrow({ name: 'a.txt', base: true, left: true, right: true, mergeStatus: 'left-changed' }),
    mrow({ name: 'b.txt', base: true, left: true, right: true, mergeStatus: 'right-changed' }),
    mrow({ name: 'c.txt', base: true, left: true, right: true, mergeStatus: 'left-changed' }),
  ], { outPath: '/out', existing: new Set() })

  it('一項失敗不會讓後面的項目停下來', async () => {
    const a = api({
      copyFile: vi.fn(async (src) => {
        if (src === '/right/b.txt') throw new Error('EACCES: permission denied')
        return { copied: true }
      }),
    })
    const results = await runMergeOps(plan(), a)
    expect(results.map((r) => r.state)).toEqual(['copied', 'failed', 'copied'])
    expect(a.copyFile).toHaveBeenCalledTimes(3)
  })

  it('失敗的訊息會指名可能留下半個檔案的目的地', async () => {
    const results = await runMergeOps(plan(), api({
      copyFile: vi.fn().mockRejectedValue(new Error('EIO')),
    }))
    expect(results[0].message).toContain('/out/a.txt')
    expect(results[0].message).toContain('不完整')
  })

  it('刪除找不到目標算「本來就不存在」，不算失敗', async () => {
    const ops = buildMergeOps(
      [mrow({ name: 'x.txt', base: true, mergeStatus: 'both-deleted' })],
      { outPath: '/out', existing: null })
    const results = await runMergeOps(ops, api({
      deleteFile: vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory')),
    }))
    expect(results[0].state).toBe('absent')
  })

  it('刪除的其他錯誤仍然是失敗', async () => {
    const ops = buildMergeOps(
      [mrow({ name: 'x.txt', base: true, mergeStatus: 'both-deleted' })],
      { outPath: '/out', existing: null })
    const results = await runMergeOps(ops, api({
      deleteFile: vi.fn().mockRejectedValue(new Error('EBUSY: resource busy')),
    }))
    expect(results[0].state).toBe('failed')
  })

  it('缺少建立資料夾的能力會明講，而不是靜默跳過', async () => {
    const ops = buildMergeOps([mrow({
      name: 'empty', left: { isDirectory: true }, base: { isDirectory: true },
      right: { isDirectory: true }, mergeStatus: 'same', children: [],
    })], { outPath: '/out', existing: new Set() })
    const results = await runMergeOps(ops, api({ mkdirFolder: undefined }))
    expect(results[0].state).toBe('failed')
    expect(results[0].message).toContain('建立資料夾失敗')
  })
})

describe('formatMergeSummary', () => {
  it('全成功時只報數量', async () => {
    const ops = buildMergeOps(
      [mrow({ name: 'a.txt', base: true, left: true, right: true, mergeStatus: 'left-changed' })],
      { outPath: '/out', existing: new Set() })
    const text = formatMergeSummary(await runMergeOps(ops, {
      copyFile: vi.fn().mockResolvedValue({}),
      deleteFile: vi.fn(), renameFile: vi.fn(), mkdirFolder: vi.fn(),
    }))
    expect(text).toContain('複製 1 項')
    expect(text).not.toContain('部分合併')
  })

  it('部分失敗時說出輸出資料夾處於半套用狀態，並逐項列出未套用的', async () => {
    const ops = buildMergeOps([
      mrow({ name: 'a.txt', base: true, left: true, right: true, mergeStatus: 'left-changed' }),
      mrow({ name: 'b.txt', base: true, left: true, right: true, mergeStatus: 'left-changed' }),
    ], { outPath: '/out', existing: new Set() })
    const results = await runMergeOps(ops, {
      copyFile: vi.fn(async (src) => {
        if (src === '/left/b.txt') throw new Error('EACCES')
        return {}
      }),
      deleteFile: vi.fn(), renameFile: vi.fn(), mkdirFolder: vi.fn(),
    })
    const text = formatMergeSummary(results)
    expect(text).toContain('部分合併')
    expect(text).toContain('1 項已套用')
    expect(text).toContain('/out/b.txt')
    expect(text).not.toContain('/out/a.txt')
  })
})

// ── 5. 視圖整合與入口 ────────────────────────────────────────────────────────

/**
 * A three-root filesystem: `/left`, `/base`, `/right`.
 * `same.txt` is untouched, `l.txt` only left edited, `both.txt` conflicts,
 * `new-l.txt` only left added, `sub/` exists on all three.
 * @param {object} over
 */
function stubApi(over = {}) {
  /** @param {string} root */
  const listing = (root) => {
    const at = (name, size, isDirectory = false) =>
      ({ name, path: `${root}/${name}`, isDirectory, size, mtime: '2024-01-01T00:00:00.000Z' })
    const rows = [
      at('sub', 0, true),
      at('same.txt', 10),
      at('both.txt', root === '/base' ? 10 : root === '/left' ? 20 : 30),
      at('l.txt', root === '/left' ? 99 : 10),
    ]
    if (root === '/left') rows.push(at('new-l.txt', 5))
    return rows
  }
  const api = {
    readDir: vi.fn(async (path) => {
      if (path === '/left' || path === '/base' || path === '/right') return listing(path)
      if (path.endsWith('/sub')) return []
      if (path === '/out') return []
      return []
    }),
    openFolder: vi.fn().mockResolvedValue({ path: '/base' }),
    openFileBinary: vi.fn().mockResolvedValue(null),
    readArchive: vi.fn().mockResolvedValue({ format: 'zip', entries: [] }),
    readMetadata: vi.fn().mockResolvedValue(null),
    copyFile: vi.fn().mockResolvedValue({ copied: true }),
    deleteFile: vi.fn().mockResolvedValue({ deleted: true }),
    renameFile: vi.fn().mockResolvedValue(undefined),
    mkdirFolder: vi.fn().mockResolvedValue(undefined),
    setMtime: vi.fn().mockResolvedValue(undefined),
    hashFile: vi.fn().mockResolvedValue('h'),
    showInExplorer: vi.fn(),
    ...over,
  }
  window.electronAPI = api
  return api
}

/** @param {object} options */
function mounted(options = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const fc = new FolderCompare(options)
  fc.mount(host)
  mountedViews.push(fc)
  return { fc, host }
}

/** Enter merge mode through the toolbar button the user would click. */
async function enterMergeViaToolbar(fc, host) {
  const btn = host.querySelector('.fc-btn-merge')
  expect(btn, '工具列必須有三向合併按鈕').toBeTruthy()
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await vi.waitFor(() => expect(fc.isMergeMode()).toBe(true))
  return btn
}

describe('三向合併：入口', () => {
  it('工具列按鈕切換模式，路徑列多出基準資料夾入口', async () => {
    stubApi()
    const { fc, host } = mounted({ leftPath: '/left', rightPath: '/right' })
    expect(host.querySelector('.fc-open-base')).toBeNull()
    await enterMergeViaToolbar(fc, host)
    expect(host.querySelector('.folder-compare--merge')).toBeTruthy()
    expect(host.querySelector('.fc-open-base')).toBeTruthy()
    expect(host.querySelector('.merge-panel')).toBeTruthy()
  })

  it('基準資料夾按鈕走 openFolder，並觸發三向掃描', async () => {
    const api = stubApi()
    const { fc, host } = mounted({ leftPath: '/left', rightPath: '/right' })
    await enterMergeViaToolbar(fc, host)
    host.querySelector('.fc-open-base').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(fc.getBasePath()).toBe('/base'))
    expect(api.openFolder).toHaveBeenCalled()
    await vi.waitFor(() => expect(host.querySelectorAll('.fc-row').length).toBeGreaterThan(0))
  })

  it('三個窗格都畫出來：表頭、路徑列、資料列', async () => {
    stubApi()
    const { fc, host } = mounted({ leftPath: '/left', rightPath: '/right' })
    await enterMergeViaToolbar(fc, host)
    await fc.setBase('/base')
    await vi.waitFor(() => expect(host.querySelectorAll('.fc-row').length).toBeGreaterThan(0))
    expect(host.querySelectorAll('.fc-header-side')).toHaveLength(3)
    expect(host.querySelectorAll('.fc-path-cell')).toHaveLength(3)
    const rowEl = host.querySelector('.fc-row')
    expect(rowEl.querySelectorAll('.fc-cell')).toHaveLength(3)
  })

  it('離開合併模式會回到兩窗格，且不留下多餘的 document 監聽器', async () => {
    stubApi()
    const { fc, host } = mounted({ leftPath: '/left', rightPath: '/right' })
    await vi.waitFor(() => expect(host.querySelectorAll('.fc-row').length).toBeGreaterThan(0))
    const added = vi.spyOn(document, 'addEventListener')
    const removed = vi.spyOn(document, 'removeEventListener')
    await enterMergeViaToolbar(fc, host)
    await fc.setMergeMode(false)
    expect(host.querySelector('.folder-compare--merge')).toBeNull()
    expect(host.querySelectorAll('.fc-header-side')).toHaveLength(2)
    // Each rebuild re-installs the click + keydown pair, so it must drop the
    // previous pair first or every toggle leaks one.
    const addedKeys = added.mock.calls.filter(([t]) => t === 'keydown').length
    const removedKeys = removed.mock.calls.filter(([t]) => t === 'keydown').length
    expect(removedKeys).toBe(addedKeys)
    added.mockRestore()
    removed.mockRestore()
  })
})

describe('三向合併：狀態與導航', () => {
  /** @returns {Promise<{fc: FolderCompare, host: HTMLElement}>} */
  async function merged() {
    stubApi()
    const { fc, host } = mounted({ leftPath: '/left', rightPath: '/right', mode: 'size' })
    await enterMergeViaToolbar(fc, host)
    await fc.setBase('/base')
    await vi.waitFor(() => expect(host.querySelectorAll('.fc-row').length).toBeGreaterThan(0))
    return { fc, host }
  }

  it('每一列都拿到三向狀態', async () => {
    const { fc } = await merged()
    const byName = new Map([...eachRow(fc._rows)].map((r) => [r.name, r.mergeStatus]))
    expect(byName.get('same.txt')).toBe('same')
    expect(byName.get('l.txt')).toBe('left-changed')
    expect(byName.get('both.txt')).toBe('conflict-changed')
    expect(byName.get('new-l.txt')).toBe('left-added')
  })

  it('衝突導航跳到衝突列', async () => {
    const { fc } = await merged()
    expect(fc.getConflictIndices().length).toBe(1)
    const res = fc.nextConflict()
    expect(res).toMatchObject({ index: 0, total: 1, moved: true })
    expect(fc.getCurrentConflictIndex()).toBe(0)
  })

  it('「只顯示衝突」的核取方塊真的接上篩選', async () => {
    const { fc, host } = await merged()
    const before = host.querySelectorAll('.fc-row').length
    const cb = host.querySelector('.merge-only-conflicts')
    expect(cb).toBeTruthy()
    cb.checked = true
    cb.dispatchEvent(new Event('change', { bubbles: true }))
    expect(fc.getShowOnlyConflicts()).toBe(true)
    const after = host.querySelectorAll('.fc-row').length
    expect(after).toBeLessThan(before)
    expect(after).toBeGreaterThan(0)
  })

  it('右鍵選單提供逐項的採用左／基準／右', async () => {
    const { fc, host } = await merged()
    const rowEl = [...host.querySelectorAll('.fc-row')]
      .find((r) => r.dataset.name === 'both.txt')
    expect(rowEl).toBeTruthy()
    expect(rowEl.dataset.mergeStatus).toBe('conflict-changed')
    rowEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    const labels = menuItems.map((i) => i.label ?? '')
    expect(labels.some((l) => l.includes('採用左側'))).toBe(true)
    expect(labels.some((l) => l.includes('採用基準'))).toBe(true)
    expect(labels.some((l) => l.includes('採用右側'))).toBe(true)

    menuItems.find((i) => (i.label ?? '').includes('採用右側')).action()
    const conflict = [...eachRow(fc._rows)].find((r) => r.name === 'both.txt')
    expect(conflict.mergeResolution).toBe('right')
  })

  it('批次採用寫回模型本身（eachRow，不是 flattenRows 的複本）', async () => {
    const { fc, host } = await merged()
    const btn = [...host.querySelectorAll('.merge-panel .merge-btn')]
      .find((b) => b.dataset.pick === 'left')
    expect(btn, '合併面板必須有批次採用左側').toBeTruthy()
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const model = [...eachRow(fc._rows)].find((r) => r.name === 'both.txt')
    expect(model.mergeResolution).toBe('left')
    // The copies flattenRows hands out carry the same value, but writing
    // through them would not have reached the model — that is the trap this
    // assertion pairs with.
    expect(flattenRows(fc._rows).find((r) => r.name === 'both.txt').mergeResolution).toBe('left')
    expect(fc.getMergeSummary().unresolved).toBe(0)
  })

  it('清除手動決議回到自動判定', async () => {
    const { fc } = await merged()
    expect(fc.resolveAllConflicts('left')).toBe(1)
    expect(fc.clearMergeResolutions()).toBe(1)
    expect(fc.getMergeSummary().unresolved).toBe(1)
  })
})

describe('三向合併：輸出', () => {
  async function readyToMerge(over = {}) {
    const api = stubApi(over)
    const { fc, host } = mounted({ leftPath: '/left', rightPath: '/right', mode: 'size' })
    await enterMergeViaToolbar(fc, host)
    await fc.setBase('/base')
    await vi.waitFor(() => expect(host.querySelectorAll('.fc-row').length).toBeGreaterThan(0))
    await fc.setOutput('/out')
    return { fc, host, api }
  }

  it('沒有預覽就不准執行', async () => {
    const { fc, api } = await readyToMerge()
    await fc.applyMerge()
    expect(api.copyFile).not.toHaveBeenCalled()
    expect(alerts.join('\n')).toContain('預覽')
  })

  it('預覽按鈕列出操作，執行按鈕在預覽前是關著的', async () => {
    const { fc, host } = await readyToMerge()
    const [btnPreview, btnApply] = [...host.querySelectorAll('.merge-row--actions .merge-btn')]
    expect(btnApply.disabled).toBe(true)
    btnPreview.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(host.querySelector('.merge-preview')).toBeTruthy())
    expect(host.querySelectorAll('.merge-op').length).toBeGreaterThan(0)
    expect(btnApply.disabled).toBe(false)
    expect(fc._mergeOps.every((op) => op.dest.startsWith('/out'))).toBe(true)
  })

  it('未決衝突與破壞性寫入各問一次，取消就什麼都不做', async () => {
    const { fc, api } = await readyToMerge()
    await fc.previewMerge()
    confirmAnswer = false
    await fc.applyMerge()
    expect(api.copyFile).not.toHaveBeenCalled()
    expect(confirms.some((c) => c.includes('衝突'))).toBe(true)
  })

  it('確認後真的寫入，並在摘要裡回報', async () => {
    const { fc, api } = await readyToMerge()
    fc.resolveAllConflicts('left')
    await fc.previewMerge()
    await fc.applyMerge()
    expect(api.copyFile).toHaveBeenCalled()
    expect(alerts.join('\n')).toContain('合併輸出完成')
  })

  it('中途失敗時逐項回報，並在執行後作廢舊計畫', async () => {
    const { fc, api } = await readyToMerge({
      copyFile: vi.fn(async (src) => {
        if (src.endsWith('l.txt')) throw new Error('EACCES: permission denied')
        return { copied: true }
      }),
    })
    fc.resolveAllConflicts('left')
    await fc.previewMerge()
    const results = await fc.applyMerge()
    expect(results.some((r) => r.state === 'failed')).toBe(true)
    const text = alerts.join('\n')
    expect(text).toContain('部分合併')
    expect(text).toContain('permission denied')
    expect(fc._mergeOps).toEqual([])
    expect(api.copyFile.mock.calls.length).toBeGreaterThan(1)
  })

  it('沒有輸出資料夾就不預覽', async () => {
    stubApi()
    const { fc, host } = mounted({ leftPath: '/left', rightPath: '/right' })
    await enterMergeViaToolbar(fc, host)
    await fc.setBase('/base')
    expect(await fc.previewMerge()).toEqual([])
    expect(alerts.join('\n')).toContain('輸出資料夾')
  })
})

describe('三向合併：規模', () => {
  it('數萬列仍只渲染視窗內的列', async () => {
    const COUNT = 30_000
    /** @param {string} root */
    const big = (root) => Array.from({ length: COUNT }, (_, i) => ({
      name: `f${String(i).padStart(6, '0')}.txt`,
      path: `${root}/f${String(i).padStart(6, '0')}.txt`,
      isDirectory: false,
      size: root === '/left' && i % 3 === 0 ? 20 : 10,
      mtime: '2024-01-01T00:00:00.000Z',
    }))
    stubApi({
      readDir: vi.fn(async (path) => (
        path === '/left' || path === '/base' || path === '/right' ? big(path) : [])),
    })
    const { fc, host } = mounted({ leftPath: '/left', rightPath: '/right', mode: 'size' })
    await enterMergeViaToolbar(fc, host)
    await fc.setBase('/base')
    await vi.waitFor(() => expect(fc._visibleRows.length).toBe(COUNT), { timeout: 30_000 })

    // The whole tree is flattened, but only the scroll window is in the DOM.
    expect(host.querySelectorAll('.fc-row').length).toBeLessThan(200)
    expect(fc.getMergeSummary().files).toBe(COUNT)
    expect(fc.getMergeSummary().counts['left-changed']).toBe(Math.ceil(COUNT / 3))
  }, 60_000)
})
