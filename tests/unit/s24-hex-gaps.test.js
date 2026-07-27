// @vitest-environment jsdom
/**
 * S24 — Hex 比對的四個缺口：Over/Under 佈局、從磁碟重新載入、搜尋並取代、
 * 整檔差異縮圖，外加既有 Save File 防護的回歸驗證。
 * tests/unit/s24-hex-gaps.test.js
 *
 * 三件事在這裡被特別盯著：
 *
 *  1. **每一項都要有呼叫端。** 這個專案已經九次以上交付「模組完整、單元測試
 *     齊全、但沒有任何呼叫端」的功能，所以每一項都從工具列按鈕與右鍵選單
 *     打進去驗一次，而不是只呼叫方法。
 *
 *  2. **取代會改使用者的資料。** Replace All 必須是「一次動作、一次復原」，
 *     而且復原後的位元組必須與原檔逐一相同——長度不同的取代最容易在這裡出錯。
 *
 *  3. **虛擬捲動不可退化。** 縮圖與佈局都動到渲染路徑，所以在數十萬位元組
 *     的檔案上再驗一次「只渲染可見列」，並且縮圖節點數跟高度走而不是跟檔案
 *     大小走。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  HexCompare,
  bytesToLatin1,
  makeHexDoc,
  makeReplaceEdit,
  nonOverlappingMatches,
  hexThumbnailBuckets,
  applyHexEdit,
  invertHexEdit,
} from '../../src/renderer/src/views/hex-compare.js'
import { SettingsStore } from '../../src/renderer/src/core/settings-store.js'
import { setActiveView } from '../../src/renderer/src/core/active-view.js'

/** @param {number[]|Uint8Array} arr */
const b64 = (arr) => btoa(bytesToLatin1(Uint8Array.from(arr)))

/** @type {HTMLElement[]} */
let hosts = []
/** @type {HexCompare[]} */
let views = []

beforeEach(() => {
  new SettingsStore().setPref('navFirstDiffOnLoad', false)
  window.electronAPI = {
    saveFile: vi.fn().mockResolvedValue({ saved: true, path: '/left.bin', backup: { backedUp: false } }),
    readFileBinary: vi.fn(),
    showInExplorer: vi.fn(),
    openFileBinary: vi.fn(),
    readDir: vi.fn().mockResolvedValue([]),
  }
  // The view alerts on every refusal; jsdom implements neither dialog.
  window.alert = vi.fn()
  window.confirm = vi.fn().mockReturnValue(true)
  // The document-level accelerators are gated on the active view tag.
  setActiveView('hex')
  // jsdom has no scrollTo; the find bar uses it to reveal a hit.
  Element.prototype.scrollTo = function (opts) {
    if (opts && typeof opts.top === 'number') this.scrollTop = opts.top
  }
})

afterEach(() => {
  for (const v of views) v.destroy()
  for (const h of hosts) h.remove()
  views = []
  hosts = []
  setActiveView('home')
  vi.restoreAllMocks()
})

/**
 * @param {number[]|Uint8Array} left
 * @param {number[]|Uint8Array} right
 * @param {{ bytesPerRow?: number, edit?: boolean }} [opts]
 */
function mountHex(left, right, opts = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new HexCompare({ bytesPerRow: opts.bytesPerRow ?? 16 })
  view.mount(host)
  view.setLeft('/left.bin', b64(left))
  view.setRight('/right.bin', b64(right))
  view._renderPaneContent('left')
  view._renderPaneContent('right')
  if (opts.edit) view.setEditMode(true)
  hosts.push(host)
  views.push(view)
  return { host, view }
}

/**
 * 從右鍵選單取出項目，驗證「右鍵也是一個入口」而不是只有工具列。
 * @param {HexCompare} view
 * @param {HTMLElement} host
 */
function contextItems(view, host) {
  const row = host.querySelector('.hx-row')
  if (!row) throw new Error('no row rendered; the fixture is wrong, not the menu')
  const target = row.querySelector('.hx-byte') ?? row
  const e = new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 })
  Object.defineProperty(e, 'target', { value: target })
  view._onHexContextMenu(e, 'left')
  return [...document.querySelectorAll('.ctx-item')].map((n) => n.textContent ?? '')
}

// ── Over/Under 佈局 ──────────────────────────────────────────────────────────

describe('S24 — Over/Under 佈局', () => {
  it('預設是左右並排', () => {
    const { view, host } = mountHex([1, 2, 3], [1, 2, 4])
    expect(view.getLayout()).toBe('side-by-side')
    expect(host.querySelector('.hx-body').classList.contains('over-under')).toBe(false)
  })

  it('工具列按鈕就是入口，按下去會切軸並改按鈕文字', () => {
    const { view, host } = mountHex([1, 2, 3], [1, 2, 4])
    const btn = host.querySelector('#hx-btn-layout')
    expect(btn).toBeTruthy()
    expect(btn.textContent).toBe('⬛ Side')

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.getLayout()).toBe('over-under')
    expect(host.querySelector('.hx-body').classList.contains('over-under')).toBe(true)
    expect(btn.textContent).toBe('⊟ Over')
    expect(btn.classList.contains('active')).toBe(true)

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.getLayout()).toBe('side-by-side')
    expect(btn.textContent).toBe('⬛ Side')
  })

  it('拒絕未知的佈局值，維持原狀', () => {
    const { view } = mountHex([1], [2])
    expect(view.setLayout(/** @type {never} */ ('diagonal'))).toBe('side-by-side')
  })

  it('兩側 pane 帶著 data-side，佈局 CSS 才有辦法各自定位', () => {
    const { host } = mountHex([1], [2])
    expect(host.querySelector('.hx-pane[data-side="left"]')).toBeTruthy()
    expect(host.querySelector('.hx-pane[data-side="right"]')).toBeTruthy()
  })
})

// ── 從磁碟重新載入 ────────────────────────────────────────────────────────────

describe('S24 — 從磁碟重新載入', () => {
  it('工具列按鈕會呼叫 IPC 並換掉記憶體中的位元組', async () => {
    const { view, host } = mountHex([1, 2, 3], [1, 2, 3])
    window.electronAPI.readFileBinary.mockResolvedValue({
      path: '/left.bin', base64: b64([9, 9, 9]), size: 3, truncated: false,
    })

    host.querySelector('#hx-btn-reload').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => {
      expect(window.electronAPI.readFileBinary).toHaveBeenCalledWith('/left.bin')
    })
    await vi.waitFor(() => expect([...view._leftBytes]).toEqual([9, 9, 9]))
  })

  it('有未儲存的修改時先問，回答「否」就不讀檔', async () => {
    const { view } = mountHex([1, 2, 3], [1, 2, 3], { edit: true })
    view.overwriteBytes('left', 0, [0xaa])
    expect(view.hasUnsavedEdits('left')).toBe(true)

    window.confirm.mockReturnValue(false)
    expect(await view.reloadSide('left')).toBe(false)
    expect(window.confirm).toHaveBeenCalled()
    expect(window.electronAPI.readFileBinary).not.toHaveBeenCalled()
    expect([...view._leftBytes]).toEqual([0xaa, 2, 3])
  })

  it('答「是」就丟掉修改，並且連 undo 歷史一起清掉', async () => {
    const { view } = mountHex([1, 2, 3], [1, 2, 3], { edit: true })
    view.overwriteBytes('left', 0, [0xaa])
    window.electronAPI.readFileBinary.mockResolvedValue({
      path: '/left.bin', base64: b64([1, 2, 3]),
    })

    expect(await view.reloadSide('left')).toBe(true)
    expect([...view._leftBytes]).toEqual([1, 2, 3])
    expect(view.hasUnsavedEdits('left')).toBe(false)
    // 復原到「磁碟上不存在的狀態」比不能復原更糟。
    expect(view._undoStack.some((e) => e.side === 'left')).toBe(false)
  })

  it('IPC 失敗時使用者看得見，而不是靜默無事發生', async () => {
    const { view } = mountHex([1, 2, 3], [1, 2, 3])
    window.electronAPI.readFileBinary.mockRejectedValue(new Error('EACCES'))

    expect(await view.reloadSide('left')).toBe(false)
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
    expect([...view._leftBytes]).toEqual([1, 2, 3])
  })

  it('回傳的物件沒有 base64 也算失敗，不會把 undefined 灌進解碼器', async () => {
    const { view } = mountHex([1], [1])
    window.electronAPI.readFileBinary.mockResolvedValue({ path: '/left.bin' })
    expect(await view.reloadSide('left')).toBe(false)
    expect(window.alert).toHaveBeenCalled()
  })

  it('沒有路徑就說清楚，不會假裝成功', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new HexCompare({})
    view.mount(host)
    hosts.push(host)
    views.push(view)

    expect(await view.reloadSide('left')).toBe(false)
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('路徑'))
  })

  it('reloadAll 只問一次，兩側都重讀', async () => {
    const { view } = mountHex([1], [2], { edit: true })
    view.overwriteBytes('left', 0, [0xaa])
    view.overwriteBytes('right', 0, [0xbb])
    window.electronAPI.readFileBinary.mockImplementation((p) =>
      Promise.resolve({ path: p, base64: b64(p === '/left.bin' ? [1] : [2]) }))

    expect(await view.reloadAll()).toBe(true)
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.readFileBinary).toHaveBeenCalledTimes(2)
    expect(view.hasUnsavedEdits()).toBe(false)
  })
})

// ── Save File（既有防護的回歸） ───────────────────────────────────────────────

describe('S24 — Save File 既有防護未被動到', () => {
  it('被截斷的檔案仍然拒絕存檔', async () => {
    const { view } = mountHex([1, 2, 3], [1, 2, 3], { edit: true })
    view.overwriteBytes('left', 0, [0xaa])
    // 直接標記截斷：真的餵 10 MB 只是把同一個分支測得更慢。
    view._leftTruncated = true

    expect(await view.saveSide('left')).toBe(false)
    expect(window.electronAPI.saveFile).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('截'))
  })

  it('正常存檔會走完整條路徑並清掉未儲存標記', async () => {
    const { view } = mountHex([1, 2, 3], [1, 2, 3], { edit: true })
    view.overwriteBytes('left', 0, [0xaa])

    expect(await view.saveSide('left')).toBe(true)
    const [path, content, , mode] = window.electronAPI.saveFile.mock.calls[0]
    expect(path).toBe('/left.bin')
    expect(mode).toBe('binary')
    expect([...content].map((c) => c.charCodeAt(0))).toEqual([0xaa, 2, 3])
    expect(view.hasUnsavedEdits('left')).toBe(false)
  })

  it('取代後仍受截斷防護保護', async () => {
    const { view } = mountHex([0xaa, 0xbb], [0, 0], { edit: true })
    view._rightTruncated = true
    expect(view.replaceAll('right')).toBe(0)
    expect(window.alert).toHaveBeenCalled()
  })
})

// ── Replace（純函式） ────────────────────────────────────────────────────────

describe('S24 — 取代的純函式', () => {
  it('makeReplaceEdit 支援長度不同的取代', () => {
    const doc = makeHexDoc(Uint8Array.from([1, 2, 3, 4]))
    const edit = makeReplaceEdit(doc, 1, 2, [9])
    expect(edit).not.toBeNull()
    expect([...applyHexEdit(doc, edit).bytes]).toEqual([1, 9, 4])
  })

  it('makeReplaceEdit 可逆，長度不同也一樣', () => {
    const doc = makeHexDoc(Uint8Array.from([1, 2, 3, 4]))
    const edit = makeReplaceEdit(doc, 1, 1, [7, 7, 7])
    const after = applyHexEdit(doc, edit)
    expect([...after.bytes]).toEqual([1, 7, 7, 7, 3, 4])
    expect([...applyHexEdit(after, invertHexEdit(edit)).bytes]).toEqual([1, 2, 3, 4])
  })

  it('makeReplaceEdit 拒絕超出範圍與無變化的操作', () => {
    const doc = makeHexDoc(Uint8Array.from([1, 2, 3]))
    expect(makeReplaceEdit(doc, 2, 5, [9])).toBeNull()
    expect(makeReplaceEdit(doc, -1, 1, [9])).toBeNull()
    expect(makeReplaceEdit(doc, 1, 0, [])).toBeNull()
  })

  it('刪除（取代為空）是合法的', () => {
    const doc = makeHexDoc(Uint8Array.from([1, 2, 3]))
    const edit = makeReplaceEdit(doc, 1, 1, [])
    expect([...applyHexEdit(doc, edit).bytes]).toEqual([1, 3])
  })

  it('nonOverlappingMatches 由左往右貪婪取，重疊的丟掉', () => {
    // AA AA AA AA 裡 "AA AA" 的命中是 0,1,2；取代三次會踩到彼此的位元組。
    expect(nonOverlappingMatches([0, 1, 2], 2)).toEqual([0, 2])
    expect(nonOverlappingMatches([0, 1, 2, 3, 4], 1)).toEqual([0, 1, 2, 3, 4])
    expect(nonOverlappingMatches([], 3)).toEqual([])
  })
})

// ── Replace（視圖層） ────────────────────────────────────────────────────────

/**
 * @param {HexCompare} view
 * @param {HTMLElement} host
 * @param {string} find
 * @param {string} replace
 */
function fillReplace(view, host, find, replace) {
  view.setReplaceOpen(true)
  const findInput = host.querySelector('#hx-find-input')
  findInput.value = find
  findInput.dispatchEvent(new Event('input', { bubbles: true }))
  host.querySelector('#hx-replace-input').value = replace
}

describe('S24 — 取代（視圖層）', () => {
  it('Ctrl+H 與工具列按鈕都能打開取代列', () => {
    const { view, host } = mountHex([1], [1])
    expect(view.isReplaceOpen()).toBe(false)

    host.querySelector('#hx-btn-replace-toggle').dispatchEvent(
      new MouseEvent('click', { bubbles: true }))
    expect(view.isReplaceOpen()).toBe(true)

    view.setReplaceOpen(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true }))
    expect(view.isReplaceOpen()).toBe(true)
  })

  it('「全部取代」按鈕是入口，一次改掉同側全部命中', () => {
    const { view, host } = mountHex([0xaa, 1, 0xaa, 2, 0xaa], [0, 0, 0, 0, 0], { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', 'BB')

    host.querySelector('#hx-btn-replace-all').dispatchEvent(
      new MouseEvent('click', { bubbles: true }))
    expect([...view._leftBytes]).toEqual([0xbb, 1, 0xbb, 2, 0xbb])
  })

  it('全部取代後一次 undo 就完整還原（等長）', () => {
    const original = [0xaa, 1, 0xaa, 2, 0xaa]
    const { view, host } = mountHex(original, [0, 0, 0, 0, 0], { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', 'BB')

    expect(view.replaceAll('left')).toBe(3)
    expect(view.undo()).toBe(true)
    expect([...view._leftBytes]).toEqual(original)
  })

  it('全部取代後一次 undo 就完整還原（取代成較長的內容）', () => {
    const original = [0xaa, 1, 0xaa, 2, 0xaa]
    const { view, host } = mountHex(original, [0], { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', 'BBCC')

    expect(view.replaceAll('left')).toBe(3)
    expect([...view._leftBytes]).toEqual([0xbb, 0xcc, 1, 0xbb, 0xcc, 2, 0xbb, 0xcc])
    expect(view.undo()).toBe(true)
    expect([...view._leftBytes]).toEqual(original)
    // 一次動作 = 一次復原；不能留下半套。
    expect(view.canUndo()).toBe(false)
  })

  it('全部取代後一次 undo 就完整還原（取代成較短的內容）', () => {
    const original = [0xaa, 0xbb, 1, 0xaa, 0xbb, 2, 0xaa, 0xbb]
    const { view, host } = mountHex(original, [0], { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AABB', 'FF')

    expect(view.replaceAll('left')).toBe(3)
    expect([...view._leftBytes]).toEqual([0xff, 1, 0xff, 2, 0xff])
    expect(view.undo()).toBe(true)
    expect([...view._leftBytes]).toEqual(original)
  })

  it('undo 之後 redo 又回到取代後的內容', () => {
    const { view, host } = mountHex([0xaa, 0xaa], [0], { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', 'BBBB')

    view.replaceAll('left')
    const replaced = [...view._leftBytes]
    view.undo()
    expect(view.redo()).toBe(true)
    expect([...view._leftBytes]).toEqual(replaced)
  })

  it('重疊的命中只取代不重疊的那些', () => {
    // AA AA AA AA：needle 為 AA AA 時命中 0,1,2；只有 0 與 2 可以取代。
    const { view, host } = mountHex([0xaa, 0xaa, 0xaa, 0xaa], [0], { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AAAA', 'FF')

    expect(view.replaceAll('left')).toBe(2)
    expect([...view._leftBytes]).toEqual([0xff, 0xff])
  })

  it('取代單一命中只動那一處', () => {
    const { view, host } = mountHex([0xaa, 1, 0xaa], [0], { edit: true })
    fillReplace(view, host, 'AA', 'BB')
    // _runFind 已把游標所在側的第一個命中選起來。
    expect(view.replaceCurrent()).toBe(true)
    expect([...view._leftBytes]).toEqual([0xbb, 1, 0xaa])
    view.undo()
    expect([...view._leftBytes]).toEqual([0xaa, 1, 0xaa])
  })

  it('取代成空字串等於刪除', () => {
    const { view, host } = mountHex([0xaa, 1, 0xaa], [0], { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', '')
    expect(view.replaceAll('left')).toBe(2)
    expect([...view._leftBytes]).toEqual([1])
  })

  it('沒進編輯模式就取代會被擋下並說明原因', () => {
    const { view, host } = mountHex([0xaa], [0])
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', 'BB')
    expect(view.replaceAll('left')).toBe(0)
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('編輯模式'))
    expect([...view._leftBytes]).toEqual([0xaa])
  })

  it('取代內容不是合法 hex 時報錯，不會寫進奇怪的位元組', () => {
    const { view, host } = mountHex([0xaa], [0], { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', 'ZZZ')
    expect(view.replaceAll('left')).toBe(0)
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('取代內容'))
    expect([...view._leftBytes]).toEqual([0xaa])
  })

  it('找不到命中時說出來，而不是安靜地回 0', () => {
    const { view, host } = mountHex([1, 2, 3], [0], { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', 'BB')
    expect(view.replaceAll('left')).toBe(0)
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('找不到'))
  })

  it('取代後搜尋結果重新計算，不會停留在已經失效的位移上', () => {
    const { view, host } = mountHex([0xaa, 0xaa], [0], { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', 'BBBB')
    view.replaceAll('left')
    // 原本的 AA 全部沒了，命中清單必須是空的。
    expect(view._findMatches.length).toBe(0)
  })

  it('修改的標記數量與實際取代進去的位元組一致', () => {
    const { view, host } = mountHex([0xaa, 1, 0xaa], [0], { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', 'BBCC')
    view.replaceAll('left')
    expect(view.getModifiedCount('left')).toBe(4)
    view.undo()
    expect(view.getModifiedCount('left')).toBe(0)
  })
})

// ── 縮圖 ─────────────────────────────────────────────────────────────────────

describe('S24 — 整檔差異縮圖（純函式）', () => {
  it('沒有資料就沒有色帶', () => {
    expect(hexThumbnailBuckets(0, [], 0, 0, 100)).toEqual([])
    expect(hexThumbnailBuckets(100, [], 100, 100, 0)).toEqual([])
  })

  it('色帶數不超過要求的數量，也不超過位元組數', () => {
    expect(hexThumbnailBuckets(1000, [], 1000, 1000, 400)).toHaveLength(400)
    expect(hexThumbnailBuckets(7, [], 7, 7, 400)).toHaveLength(7)
  })

  it('成本跟色帶數走，不跟檔案大小走', () => {
    const regions = [{ start: 5_000_000, end: 5_000_001 }]
    const buckets = hexThumbnailBuckets(10_000_000, regions, 10_000_000, 10_000_000, 400)
    expect(buckets).toHaveLength(400)
    expect(buckets.filter((b) => b.status !== 'same')).toHaveLength(1)
  })

  it('一個像素高的區段裡只要有差異就上色，不會被多數決吃掉', () => {
    // 一千個位元組壓成十條，中間只有一個位元組不同。
    const buckets = hexThumbnailBuckets(1000, [{ start: 505, end: 506 }], 1000, 1000, 10)
    expect(buckets[5].status).toBe('different')
    expect(buckets.filter((b) => b.status === 'same')).toHaveLength(9)
  })

  it('超過某一側長度的區段標成該側獨有，而不是「內容不同」', () => {
    const buckets = hexThumbnailBuckets(100, [{ start: 50, end: 100 }], 100, 50, 4)
    expect(buckets[2].status).toBe('left-only')
    expect(buckets[3].status).toBe('left-only')
    const mirrored = hexThumbnailBuckets(100, [{ start: 50, end: 100 }], 50, 100, 4)
    expect(mirrored[3].status).toBe('right-only')
  })

  it('同一段同時有內容不同與單側獨有時，以「內容不同」為準', () => {
    const buckets = hexThumbnailBuckets(
      100, [{ start: 0, end: 10 }, { start: 60, end: 100 }], 100, 60, 1)
    expect(buckets[0].status).toBe('different')
  })

  it('區段落在範圍外時不會誤標', () => {
    const buckets = hexThumbnailBuckets(50, [{ start: 200, end: 300 }], 50, 50, 5)
    expect(buckets.every((b) => b.status === 'same')).toBe(true)
  })
})

describe('S24 — 整檔差異縮圖（視圖層）', () => {
  it('工具列按鈕是入口，切換會顯示 / 隱藏色帶', () => {
    const { view, host } = mountHex([1, 2, 3], [1, 2, 9])
    const btn = host.querySelector('#hx-btn-thumb')
    expect(btn).toBeTruthy()
    expect(host.querySelector('.hx-thumb').style.display).toBe('none')

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.isThumbnailVisible()).toBe(true)
    expect(host.querySelector('.hx-thumb').style.display).toBe('')
    expect(host.querySelector('.hx-body').classList.contains('with-thumb')).toBe(true)
    expect(host.querySelectorAll('.hx-thumb-mark').length).toBeGreaterThan(0)

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.isThumbnailVisible()).toBe(false)
  })

  it('關閉時不算色帶，也不留下節點', () => {
    const { view, host } = mountHex([1], [9])
    view.setThumbnailVisible(true)
    view.setThumbnailVisible(false)
    expect(view.getThumbnailBuckets()).toEqual([])
    expect(host.querySelector('.hx-thumb').style.display).toBe('none')
  })

  it('兩檔相同時沒有任何色帶節點', () => {
    const { view, host } = mountHex([1, 2, 3], [1, 2, 3])
    view.setThumbnailVisible(true)
    expect(host.querySelectorAll('.hx-thumb-mark').length).toBe(0)
  })

  it('三十萬位元組的檔案，縮圖節點數仍受上限約束', () => {
    const left = new Uint8Array(300_000)
    const right = new Uint8Array(300_000)
    // 每 3 個位元組差一個：不壓縮的話就是十萬個節點。
    for (let i = 0; i < right.length; i += 3) right[i] = 0xff
    const { view, host } = mountHex(left, right)
    view.setThumbnailVisible(true)

    expect(view.getThumbnailBuckets().length).toBeLessThanOrEqual(400)
    expect(host.querySelectorAll('.hx-thumb-mark').length).toBeLessThanOrEqual(400)
  })

  it('點擊色帶會捲到對應位置', () => {
    const left = new Uint8Array(160_000)
    const { view } = mountHex(left, left)
    view.setThumbnailVisible(true)

    const offset = view.scrollToThumbFraction(0.5)
    expect(offset).toBeGreaterThan(70_000)
    expect(offset).toBeLessThan(90_000)
    expect(view._dom.scroll_left.scrollTop).toBe(view._dom.scroll_right.scrollTop)
  })

  it('沒有資料時點擊不會拋例外', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new HexCompare({})
    view.mount(host)
    hosts.push(host)
    views.push(view)
    view.setThumbnailVisible(true)
    expect(view.scrollToThumbFraction(0.5)).toBe(-1)
  })

  it('取代之後縮圖跟著更新', () => {
    const { view, host } = mountHex([0xaa, 0xaa, 0xaa, 0xaa], [0xaa, 0xaa, 0xaa, 0xaa],
      { edit: true })
    view.setThumbnailVisible(true)
    expect(host.querySelectorAll('.hx-thumb-mark').length).toBe(0)

    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', 'FF')
    view.replaceAll('left')
    view._editReflowNow()
    expect(host.querySelectorAll('.hx-thumb-mark').length).toBeGreaterThan(0)
  })
})

// ── 虛擬捲動未退化 ────────────────────────────────────────────────────────────

describe('S24 — 虛擬捲動在新功能開啟後仍然只渲染可見列', () => {
  /**
   * @param {HTMLElement} host
   * @param {'left'|'right'} side
   */
  const rowCount = (host, side) =>
    host.querySelectorAll(`.hx-pane[data-side="${side}"] .hx-row`).length

  it('三十萬位元組：縮圖與 Over/Under 都開著，仍只渲染可見列', () => {
    const left = new Uint8Array(300_000)
    const right = new Uint8Array(300_000)
    right[299_999] = 0xff
    const { view, host } = mountHex(left, right)

    view.setThumbnailVisible(true)
    view.setLayout('over-under')
    view._refreshSync()

    // 18750 列的檔案；jsdom 沒有 layout，viewport 以 300px 計約 15 列 + overscan。
    expect(rowCount(host, 'left')).toBeLessThan(200)
    expect(rowCount(host, 'left')).toBeGreaterThan(0)
    expect(rowCount(host, 'right')).toBeLessThan(200)
  })

  it('內層高度仍然是整份檔案的高度（捲軸沒有變短）', () => {
    const left = new Uint8Array(320_000)
    const { view, host } = mountHex(left, left)
    view.setLayout('over-under')
    view._refreshSync()

    const inner = host.querySelector('.hx-pane[data-side="left"] .hx-inner')
    expect(inner.style.height).toBe(`${Math.ceil(320_000 / 16) * 20}px`)
  })

  it('在二十萬位元組上取代數千處後，仍然只渲染可見列，且一次 undo 全回來', () => {
    const left = new Uint8Array(200_000)
    // 每 40 個位元組一處命中：五千處，足以讓「一處一次整份複製」的實作爆掉。
    for (let i = 0; i < left.length; i += 40) left[i] = 0xaa
    const original = Uint8Array.from(left)
    const { view, host } = mountHex(left, new Uint8Array(0), { edit: true })
    view._moveCursorTo('left', 0)
    fillReplace(view, host, 'AA', 'BBCC')

    expect(view.replaceAll('left')).toBe(5000)
    expect(view._leftBytes.length).toBe(205_000)
    view._editReflowNow()
    expect(rowCount(host, 'left')).toBeLessThan(200)
    // 一次動作 = 一次復原，即使它涵蓋五千個分散的位置。
    expect(view._undoStack.length).toBe(1)
    expect(view.undo()).toBe(true)
    expect(view._leftBytes.length).toBe(original.length)
    expect(view._leftBytes.every((b, i) => b === original[i])).toBe(true)
  })

  it('編輯狀態存在資料模型，捲過去再捲回來標記還在', () => {
    const left = new Uint8Array(300_000)
    const { view, host } = mountHex(left, left, { edit: true })
    view.overwriteBytes('left', 0, [0xaa])

    const scroll = view._dom.scroll_left
    scroll.scrollTop = 200_000
    view._renderVisibleRows('left', scroll)
    scroll.scrollTop = 0
    view._renderVisibleRows('left', scroll)

    expect(view.getModifiedFlags('left')[0]).toBe(1)
    expect(host.querySelector('.hx-pane[data-side="left"] .hx-modified')).toBeTruthy()
  })
})

// ── 右鍵選單入口 ──────────────────────────────────────────────────────────────

describe('S24 — 右鍵選單也是入口', () => {
  it('選單含重新載入 / 取代 / 縮圖 / 佈局四項', () => {
    const { view, host } = mountHex([1, 2, 3], [1, 2, 9])
    const labels = contextItems(view, host)
    expect(labels.some((l) => l.includes('重新載入'))).toBe(true)
    expect(labels.some((l) => l.includes('取代'))).toBe(true)
    expect(labels.some((l) => l.includes('縮圖'))).toBe(true)
    expect(labels.some((l) => l.includes('上下堆疊'))).toBe(true)
  })
})
