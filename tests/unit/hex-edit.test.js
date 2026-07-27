// @vitest-environment jsdom
/**
 * P2-22 — Hex 比對的行內編輯
 * tests/unit/hex-edit.test.js
 *
 * 涵蓋：
 *  - 位元組層級編輯的純函式（覆寫 / 插入 / 刪除 / 反轉 / 有上限的堆疊）
 *  - 視圖層：編輯模式、鍵盤輸入、undo/redo、存檔、截斷保護
 *  - 規模：數十萬位元組下虛擬捲動仍只渲染可見列，且修改標記在捲動後仍在
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  HexCompare,
  bytesToLatin1,
  makeHexDoc,
  spliceHexDoc,
  makeOverwriteEdit,
  makeInsertEdit,
  makeDeleteEdit,
  applyHexEdit,
  invertHexEdit,
  pushBounded,
  modifiedDelta,
  hexNibbleValue,
} from '../../src/renderer/src/views/hex-compare.js'
import { SettingsStore } from '../../src/renderer/src/core/settings-store.js'

/** @param {number[]|Uint8Array} arr */
const b64 = (arr) => btoa(bytesToLatin1(Uint8Array.from(arr)))
/** @param {number[]} arr */
const bytes = (arr) => new Uint8Array(arr)

/** @type {HTMLElement[]} */
let hosts = []
/** @type {HexCompare[]} */
let views = []

beforeEach(() => {
  new SettingsStore().setPref('navFirstDiffOnLoad', false)
  window.electronAPI = {
    saveFile: vi.fn().mockResolvedValue({ saved: true, path: '/left.bin', backup: { backedUp: false } }),
    showInExplorer: vi.fn(),
    openFileBinary: vi.fn(),
  }
  // The view alerts on refusals; jsdom has no implementation for either.
  window.alert = vi.fn()
  window.confirm = vi.fn().mockReturnValue(true)
})

afterEach(() => {
  for (const v of views) v.destroy()
  for (const h of hosts) h.remove()
  views = []
  hosts = []
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
  if (opts.edit !== false) view.setEditMode(true)
  hosts.push(host)
  views.push(view)
  return { host, view }
}

/**
 * @param {HexCompare} view
 * @param {'left'|'right'} side
 * @param {string} key
 * @param {{ ctrlKey?: boolean, shiftKey?: boolean }} [mods]
 */
function press(view, side, key, mods = {}) {
  const target = view._dom[`scroll_${side}`]
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  target.dispatchEvent(e)
  return e
}

// ── Pure functions ────────────────────────────────────────────────────────────

describe('P2-22 純函式 — spliceHexDoc', () => {
  it('覆寫等長區段時長度不變，flags 同步搬移', () => {
    const doc = makeHexDoc(bytes([1, 2, 3, 4]))
    const out = spliceHexDoc(doc, 1, 2, bytes([9, 9]))
    expect([...out.bytes]).toEqual([1, 9, 9, 4])
    expect([...out.flags]).toEqual([0, 1, 1, 0])
  })

  it('插入使長度增加，其後的 flags 一併後移', () => {
    const doc = spliceHexDoc(makeHexDoc(bytes([1, 2, 3])), 2, 1, bytes([7]))
    const out = spliceHexDoc(doc, 0, 0, bytes([5, 6]))
    expect([...out.bytes]).toEqual([5, 6, 1, 2, 7])
    // 原本被標記的 index 2 現在在 index 4
    expect([...out.flags]).toEqual([1, 1, 0, 0, 1])
  })

  it('刪除使長度減少', () => {
    const out = spliceHexDoc(makeHexDoc(bytes([1, 2, 3, 4])), 1, 2)
    expect([...out.bytes]).toEqual([1, 4])
    expect([...out.flags]).toEqual([0, 0])
  })

  it('offset / removeCount 超出範圍時被鉗制，不會產生負長度', () => {
    const out = spliceHexDoc(makeHexDoc(bytes([1, 2])), 99, 99, bytes([3]))
    expect([...out.bytes]).toEqual([1, 2, 3])
    const out2 = spliceHexDoc(makeHexDoc(bytes([1, 2])), -5, 1)
    expect([...out2.bytes]).toEqual([2])
  })

  it('不修改輸入（undo 堆疊持有原陣列參照）', () => {
    const src = bytes([1, 2, 3])
    const doc = makeHexDoc(src)
    spliceHexDoc(doc, 0, 1, bytes([9]))
    expect([...src]).toEqual([1, 2, 3])
  })
})

describe('P2-22 純函式 — 編輯記錄與反轉', () => {
  it('makeOverwriteEdit 對超出範圍回傳 null', () => {
    const doc = makeHexDoc(bytes([1, 2]))
    expect(makeOverwriteEdit(doc, 2, [9])).toBeNull()
    expect(makeOverwriteEdit(doc, -1, [9])).toBeNull()
    expect(makeOverwriteEdit(doc, 0, [])).toBeNull()
  })

  it('makeOverwriteEdit 對「值相同且已標記」視為 no-op', () => {
    const doc = makeHexDoc(bytes([1, 2]))
    // 尚未標記 → 仍算變更（要畫上修改標記）
    const first = makeOverwriteEdit(doc, 0, [1])
    expect(first).not.toBeNull()
    const marked = applyHexEdit(doc, first)
    expect(makeOverwriteEdit(marked, 0, [1])).toBeNull()
  })

  it('apply → invert → apply 可完整還原位元組與標記', () => {
    const doc = makeHexDoc(bytes([1, 2, 3]))
    for (const edit of [
      makeOverwriteEdit(doc, 1, [0xff]),
      makeInsertEdit(doc, 1, [0xaa, 0xbb]),
      makeDeleteEdit(doc, 0, 2),
    ]) {
      const after = applyHexEdit(doc, edit)
      const back = applyHexEdit(after, invertHexEdit(edit))
      expect([...back.bytes]).toEqual([1, 2, 3])
      expect([...back.flags]).toEqual([0, 0, 0])
    }
  })

  it('makeInsertEdit 允許在檔案結尾追加，makeDeleteEdit 不允許越界', () => {
    const doc = makeHexDoc(bytes([1, 2]))
    expect([...applyHexEdit(doc, makeInsertEdit(doc, 2, [9])).bytes]).toEqual([1, 2, 9])
    expect(makeDeleteEdit(doc, 2)).toBeNull()
    expect(makeDeleteEdit(doc, 0, 0)).toBeNull()
  })

  it('modifiedDelta 計算標記數的淨變化', () => {
    const doc = makeHexDoc(bytes([1, 2, 3]))
    const ins = makeInsertEdit(doc, 0, [9, 9])
    expect(modifiedDelta(ins)).toBe(2)
    expect(modifiedDelta(invertHexEdit(ins))).toBe(-2)
  })

  it('pushBounded 超過上限時丟棄最舊的項目', () => {
    /** @type {number[]} */
    const stack = []
    for (let i = 0; i < 10; i++) pushBounded(stack, i, 3)
    expect(stack).toEqual([7, 8, 9])
  })

  it('hexNibbleValue 接受 0-9a-fA-F，其餘回傳 -1', () => {
    expect(hexNibbleValue('0')).toBe(0)
    expect(hexNibbleValue('9')).toBe(9)
    expect(hexNibbleValue('a')).toBe(10)
    expect(hexNibbleValue('F')).toBe(15)
    expect(hexNibbleValue('g')).toBe(-1)
    expect(hexNibbleValue('')).toBe(-1)
    expect(hexNibbleValue('ff')).toBe(-1)
  })
})

// ── View: editing ─────────────────────────────────────────────────────────────

describe('P2-22 視圖 — 編輯模式與 API', () => {
  it('未進入編輯模式時所有編輯 API 都被拒絕', () => {
    const { view } = mountHex([1, 2, 3], [1, 2, 3], { edit: false })
    expect(view.isEditMode()).toBe(false)
    expect(view.overwriteBytes('left', 0, [9])).toBe(false)
    expect(view.insertBytesAt('left', 0, [9])).toBe(false)
    expect(view.deleteBytesAt('left', 0)).toBe(false)
    expect([...view._leftBytes]).toEqual([1, 2, 3])
  })

  it('覆寫位元組會改值、標記為已修改並標示未儲存', () => {
    const { view } = mountHex([1, 2, 3], [1, 2, 3])
    expect(view.overwriteBytes('left', 1, [0xff])).toBe(true)
    expect([...view._leftBytes]).toEqual([1, 0xff, 3])
    expect([...view.getModifiedFlags('left')]).toEqual([0, 1, 0])
    expect(view.getModifiedCount('left')).toBe(1)
    expect(view.hasUnsavedEdits()).toBe(true)
    expect(view.hasUnsavedEdits('right')).toBe(false)
  })

  it('插入與刪除會改變檔案長度並更新虛擬捲動高度', () => {
    const { view } = mountHex(new Array(64).fill(0), new Array(64).fill(0), { bytesPerRow: 16 })
    const inner = view._dom.inner_left
    expect(inner.style.height).toBe(`${4 * 20}px`)

    view.insertBytesAt('left', 0, new Array(16).fill(0xaa))
    expect(view._leftBytes.length).toBe(80)
    expect(inner.style.height).toBe(`${5 * 20}px`)

    view.deleteBytesAt('left', 0, 32)
    expect(view._leftBytes.length).toBe(48)
    expect(inner.style.height).toBe(`${3 * 20}px`)
  })

  it('插入後其後位元組的標記跟著位移，不會停在舊 offset', () => {
    const { view } = mountHex([1, 2, 3], [1, 2, 3])
    view.overwriteBytes('left', 2, [0x77])
    expect([...view.getModifiedFlags('left')]).toEqual([0, 0, 1])
    view.insertBytesAt('left', 0, [0x00])
    expect([...view._leftBytes]).toEqual([0, 1, 2, 0x77])
    expect([...view.getModifiedFlags('left')]).toEqual([1, 0, 0, 1])
  })

  it('截斷的檔案禁止編輯與存檔', async () => {
    const { view } = mountHex([1, 2, 3], [1, 2, 3], { edit: false })
    // 直接標記為截斷；產生 10MB 的 base64 在測試裡代價過高
    view._leftTruncated = true
    view.setEditMode(true)
    expect(view.overwriteBytes('left', 0, [9])).toBe(false)
    expect([...view._leftBytes]).toEqual([1, 2, 3])
    // 右側未截斷 → 仍可編輯
    expect(view.overwriteBytes('right', 0, [9])).toBe(true)

    await expect(view.saveSide('left')).resolves.toBe(false)
    expect(window.electronAPI.saveFile).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalled()
  })

  it('兩側都截斷時連編輯模式都無法進入', () => {
    const { view } = mountHex([1], [1], { edit: false })
    view._leftTruncated = true
    view._rightTruncated = true
    expect(view.setEditMode(true)).toBe(false)
    expect(view.isEditMode()).toBe(false)
  })
})

describe('P2-22 視圖 — undo / redo', () => {
  it('undo 還原位元組與標記，redo 再套用', () => {
    const { view } = mountHex([1, 2, 3], [1, 2, 3])
    view.overwriteBytes('left', 0, [0xaa])
    view.insertBytesAt('left', 3, [0xbb])
    expect([...view._leftBytes]).toEqual([0xaa, 2, 3, 0xbb])

    expect(view.undo()).toBe(true)
    expect([...view._leftBytes]).toEqual([0xaa, 2, 3])
    expect(view.undo()).toBe(true)
    expect([...view._leftBytes]).toEqual([1, 2, 3])
    expect(view.hasUnsavedEdits()).toBe(false)
    expect(view.undo()).toBe(false)

    expect(view.redo()).toBe(true)
    expect(view.redo()).toBe(true)
    expect([...view._leftBytes]).toEqual([0xaa, 2, 3, 0xbb])
    expect(view.getModifiedCount('left')).toBe(2)
    expect(view.redo()).toBe(false)
  })

  it('新的編輯會清空 redo 堆疊', () => {
    const { view } = mountHex([1, 2], [1, 2])
    view.overwriteBytes('left', 0, [9])
    view.undo()
    expect(view.canRedo()).toBe(true)
    view.overwriteBytes('left', 1, [8])
    expect(view.canRedo()).toBe(false)
  })

  it('undo 堆疊有上限，超過後最舊的記錄被丟棄', () => {
    const { view } = mountHex(new Array(1200).fill(0), [0])
    for (let i = 0; i < 700; i++) view.overwriteBytes('left', i, [(i % 250) + 1])
    expect(view._undoStack.length).toBe(500)
    // 最舊的 200 筆已無法復原
    let undone = 0
    while (view.undo()) undone++
    expect(undone).toBe(500)
    expect(view._leftBytes[0]).toBe(1)
  })

  it('重新載入某一側會清掉該側的歷史，另一側不受影響', () => {
    const { view } = mountHex([1, 2], [1, 2])
    view.overwriteBytes('left', 0, [9])
    view.overwriteBytes('right', 0, [9])
    view.setLeft('/left2.bin', b64([5, 5]))
    expect(view.hasUnsavedEdits('left')).toBe(false)
    expect(view.hasUnsavedEdits('right')).toBe(true)
    expect(view._undoStack.every((e) => e.side === 'right')).toBe(true)
  })
})

describe('P2-22 視圖 — 鍵盤輸入', () => {
  it('點擊位元組後輸入兩個 hex 字元組成一個 byte，游標自動前進', () => {
    const { view } = mountHex([0x00, 0x00], [0x00, 0x00])
    view._moveCursorTo('left', 0, 'hex')

    press(view, 'left', '4')
    expect(view._leftBytes[0]).toBe(0x40)
    expect(view.getCursor()).toMatchObject({ offset: 0, nibble: 1 })

    press(view, 'left', '1')
    expect(view._leftBytes[0]).toBe(0x41)
    expect(view.getCursor()).toMatchObject({ offset: 1, nibble: 0 })
  })

  it('非 hex 字元在 hex 欄位被忽略', () => {
    const { view } = mountHex([0x00], [0x00])
    view._moveCursorTo('left', 0, 'hex')
    const e = press(view, 'left', 'z')
    expect(view._leftBytes[0]).toBe(0)
    expect(e.defaultPrevented).toBe(false)
  })

  it('ASCII 欄位直接輸入字元', () => {
    const { view } = mountHex([0x00, 0x00], [0x00, 0x00])
    view._moveCursorTo('left', 0, 'ascii')
    press(view, 'left', 'A')
    expect(view._leftBytes[0]).toBe(0x41)
    expect(view.getCursor()).toMatchObject({ offset: 1, field: 'ascii' })
  })

  it('Insert / Delete / Backspace 改變檔案長度', () => {
    const { view } = mountHex([1, 2, 3], [1, 2, 3])
    view._moveCursorTo('left', 1, 'hex')
    press(view, 'left', 'Insert')
    expect([...view._leftBytes]).toEqual([1, 0, 2, 3])
    press(view, 'left', 'Delete')
    expect([...view._leftBytes]).toEqual([1, 2, 3])
    view._moveCursorTo('left', 2, 'hex')
    press(view, 'left', 'Backspace')
    expect([...view._leftBytes]).toEqual([1, 3])
  })

  it('方向鍵移動游標而不改變內容', () => {
    const { view } = mountHex(new Array(64).fill(7), [7], { bytesPerRow: 16 })
    view._moveCursorTo('left', 0, 'hex')
    press(view, 'left', 'ArrowDown')
    expect(view.getCursor().offset).toBe(16)
    press(view, 'left', 'ArrowRight')
    expect(view.getCursor().offset).toBe(17)
    press(view, 'left', 'End')
    expect(view.getCursor().offset).toBe(31)
    press(view, 'left', 'Home')
    expect(view.getCursor().offset).toBe(16)
    expect(view._leftBytes.every((b) => b === 7)).toBe(true)
  })

  it('Tab 在 hex / ASCII 欄位間切換', () => {
    const { view } = mountHex([1], [1])
    view._moveCursorTo('left', 0, 'hex')
    press(view, 'left', 'Tab')
    expect(view.getCursor().field).toBe('ascii')
    press(view, 'left', 'Tab')
    expect(view.getCursor().field).toBe('hex')
  })

  it('帶 Ctrl 的按鍵不在 pane 層處理（避免 Ctrl+Z 被執行兩次）', () => {
    const { view } = mountHex([0x00], [0x00])
    view._moveCursorTo('left', 0, 'hex')
    press(view, 'left', '1', { ctrlKey: true })
    expect(view._leftBytes[0]).toBe(0)
  })

  it('游標不在該側時，該側的按鍵不會誤改資料', () => {
    const { view } = mountHex([0x00], [0x00])
    view._moveCursorTo('left', 0, 'hex')
    press(view, 'right', 'f')
    expect(view._rightBytes[0]).toBe(0)
  })
})

describe('P2-22 視圖 — 存檔', () => {
  it('以 binary 編碼寫入，並帶上備份設定', async () => {
    new SettingsStore().setPref('backupOnSave', true)
    const { view } = mountHex([0x00, 0xff], [0x00, 0xff])
    view.overwriteBytes('left', 0, [0x80])

    await expect(view.saveSide('left')).resolves.toBe(true)
    const call = window.electronAPI.saveFile.mock.calls[0]
    expect(call[0]).toBe('/left.bin')
    expect([...Uint8Array.from(call[1], (c) => c.charCodeAt(0))]).toEqual([0x80, 0xff])
    expect(call[3]).toBe('binary')
    expect(call[4]).toBe(true)
  })

  it('存檔成功後清除未儲存標記，但保留 undo 歷史', async () => {
    const { view } = mountHex([1], [1])
    view.overwriteBytes('left', 0, [9])
    await view.saveSide('left')
    expect(view.hasUnsavedEdits()).toBe(false)
    expect([...view.getModifiedFlags('left')]).toEqual([0])
    expect(view.canUndo()).toBe(true)
    // 復原到存檔前的狀態 → 又是「未儲存」
    view.undo()
    expect(view.hasUnsavedEdits()).toBe(false)
    view.redo()
    expect(view.hasUnsavedEdits()).toBe(true)
  })

  it('取消存檔對話框不會清除未儲存標記', async () => {
    window.electronAPI.saveFile.mockResolvedValueOnce(null)
    const { view } = mountHex([1], [1])
    view.overwriteBytes('left', 0, [9])
    await expect(view.saveSide('left')).resolves.toBe(false)
    expect(view.hasUnsavedEdits()).toBe(true)
  })

  it('寫入失敗會回報給使用者，不會靜默吞掉', async () => {
    window.electronAPI.saveFile.mockRejectedValueOnce(new Error('EACCES'))
    const { view } = mountHex([1], [1])
    view.overwriteBytes('left', 0, [9])
    await expect(view.saveSide('left')).resolves.toBe(false)
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
    expect(view.hasUnsavedEdits()).toBe(true)
  })

  it('沒有路徑時拒絕寫入', async () => {
    const { view } = mountHex([1], [1])
    view.overwriteBytes('left', 0, [9])
    view._leftPath = null
    await expect(view.saveSide('left')).resolves.toBe(false)
    expect(window.electronAPI.saveFile).not.toHaveBeenCalled()
  })

  it('0x00–0xFF 全值域可完整往返', async () => {
    const all = Array.from({ length: 256 }, (_, i) => i)
    const { view } = mountHex(all, all)
    view.overwriteBytes('left', 0, [0xff])
    await view.saveSide('left')
    const written = Uint8Array.from(window.electronAPI.saveFile.mock.calls[0][1], (c) => c.charCodeAt(0))
    expect(written.length).toBe(256)
    expect(written[0]).toBe(0xff)
    for (let i = 1; i < 256; i++) expect(written[i]).toBe(i)
  })
})

describe('P2-22 視圖 — 未儲存警示', () => {
  it('沒有修改時 confirmClose 不詢問使用者', () => {
    const { view } = mountHex([1], [1])
    expect(view.confirmClose()).toBe(true)
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('有修改時 confirmClose 詢問，使用者取消則回傳 false', () => {
    const { view } = mountHex([1], [1])
    view.overwriteBytes('left', 0, [9])
    window.confirm.mockReturnValueOnce(false)
    expect(view.confirmClose()).toBe(false)
    window.confirm.mockReturnValueOnce(true)
    expect(view.confirmClose()).toBe(true)
  })
})

describe('P2-22 視圖 — swap 與編輯狀態', () => {
  it('交換兩側時標記、計數與歷史一起換邊', () => {
    const { view } = mountHex([1, 2], [3, 4])
    view.overwriteBytes('left', 0, [9])
    view.swap()
    expect(view.hasUnsavedEdits('right')).toBe(true)
    expect(view.hasUnsavedEdits('left')).toBe(false)
    expect([...view.getModifiedFlags('right')]).toEqual([1, 0])
    view.undo()
    expect([...view._rightBytes]).toEqual([1, 2])
    expect(view.hasUnsavedEdits()).toBe(false)
  })
})

// ── Scale ─────────────────────────────────────────────────────────────────────

describe('P2-22 規模 — 數十萬位元組', () => {
  /** 320 KB：足以讓「每列都建 DOM」的實作立刻爆掉 */
  const BIG = 320_000

  /** @returns {Uint8Array} */
  function bigBytes() {
    const out = new Uint8Array(BIG)
    for (let i = 0; i < BIG; i++) out[i] = i & 0xff
    return out
  }

  it('只渲染可見列，且編輯狀態在捲動離開再回來後仍在', () => {
    const data = bigBytes()
    const { view } = mountHex(data, data, { bytesPerRow: 16 })
    const inner = view._dom.inner_left
    const scroll = view._dom.scroll_left
    const totalRows = BIG / 16

    expect(inner.style.height).toBe(`${totalRows * 20}px`)
    // jsdom 回報 clientHeight = 0，視圖退回 300px → 約 15 列 + 前後緩衝
    expect(inner.querySelectorAll('.hx-row').length).toBeLessThan(40)

    // 在第 0 個位元組做編輯
    view._moveCursorTo('left', 0, 'hex')
    expect(view.overwriteBytes('left', 0, [0xde])).toBe(true)
    expect(inner.querySelector('.hx-byte.hx-modified')).not.toBeNull()

    // 捲到檔案中段
    scroll.scrollTop = 100_000
    view._renderVisibleRows('left', scroll)
    expect(inner.querySelectorAll('.hx-row').length).toBeLessThan(80)
    expect(inner.querySelector('.hx-byte.hx-modified')).toBeNull()

    // 捲回開頭 → 修改標記必須重新出現（狀態存在資料模型而非 DOM）
    scroll.scrollTop = 0
    view._renderPaneContent('left')
    expect(view._leftBytes[0]).toBe(0xde)
    expect(inner.querySelector('.hx-byte.hx-modified')).not.toBeNull()
    expect(inner.querySelectorAll('.hx-row').length).toBeLessThan(40)
  })

  it('尾端插入位元組後高度與列對應更新，且不會整檔渲染', () => {
    const data = bigBytes()
    const { view } = mountHex(data, data, { bytesPerRow: 16 })
    const inner = view._dom.inner_left

    view.insertBytesAt('left', BIG, new Array(16).fill(0xff))
    expect(view._leftBytes.length).toBe(BIG + 16)
    expect(inner.style.height).toBe(`${(BIG / 16 + 1) * 20}px`)
    expect(inner.querySelectorAll('.hx-row').length).toBeLessThan(40)

    // 最後一列的位元組確實是插入的值
    expect(view._leftBytes[BIG + 15]).toBe(0xff)
    expect(view.getModifiedFlags('left')[BIG]).toBe(1)
    expect(view.getModifiedFlags('left')[0]).toBe(0)
  })

  it('開頭插入 1 個位元組後，後續每個位元組的標記都不會誤標', () => {
    const data = bigBytes()
    const { view } = mountHex(data, data, { bytesPerRow: 16 })
    view.insertBytesAt('left', 0, [0xaa])
    const flags = view.getModifiedFlags('left')
    expect(flags.length).toBe(BIG + 1)
    expect(flags[0]).toBe(1)
    expect(view.getModifiedCount('left')).toBe(1)
    let sum = 0
    for (let i = 0; i < flags.length; i++) sum += flags[i]
    expect(sum).toBe(1)
  })
})
