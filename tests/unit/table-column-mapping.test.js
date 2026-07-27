/**
 * @vitest-environment jsdom
 *
 * S27 — 欄位對應（N:M column mapping）的修正與缺口補測。
 *
 * 三個修正：
 *   A. normaliseColumnMapping()  null / '' / false 不再被 Number() 折成第 0 欄
 *   B. setColumnMapping(null)    還原為 1:1 時，仍會把超出寬度的每欄設定截掉
 *   C. setEncodingOverride()     Excel / HTML 來源不論有沒有指定編碼都直接擋下
 *
 * 以及原本完全沒有覆蓋的四件事：建議對應的多對一 / 一對多、超出資料欄數的對應、
 * 對應對話框刪除列後的顯示名稱索引、以及 Recompare Files 之後編輯是否還在。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  TableCompare,
  normaliseColumnMapping,
  suggestColumnMapping,
  projectRow,
  NO_COLUMN,
} from '../../src/renderer/src/views/table-compare.js'

/** @type {TableCompare|null} */
let view = null
/** @type {HTMLElement|null} */
let host = null

/**
 * 這個視圖是 `new TableCompare(options)` + `mount(el)` 兩段式，
 * 建構子拿的是選項物件而不是容器元素。
 *
 * @param {object} [opts]
 * @returns {TableCompare}
 */
function mountView(opts = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  view = new TableCompare(opts)
  view.mount(host)
  return view
}

/**
 * @param {TableCompare} tc
 * @param {string} [left]
 * @param {string} [right]
 */
function loadBoth(tc, left = 'a,b,c\n1,2,3', right = 'a,b,c\n1,2,3') {
  tc.setLeft('C:/left.csv', left)
  tc.setRight('C:/right.csv', right)
}

beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.stubGlobal('alert', vi.fn())
  window.electronAPI = /** @type {never} */ ({
    readFile: vi.fn(async () => ({ content: 'a,b\n1,2', encoding: 'utf-8', path: 'C:/x.csv' })),
    readExcel: vi.fn(),
    saveFile: vi.fn(async () => ({ saved: true, path: 'C:/out.csv' })),
    openFile: vi.fn(),
  })
})

afterEach(() => {
  view?.destroy()
  view = null
  host?.remove()
  host = null
  vi.unstubAllGlobals()
  delete window.electronAPI
})

// ── A. normaliseColumnMapping() ───────────────────────────────────────────────

describe('normaliseColumnMapping() — 空值不等於第 0 欄', () => {
  it('把 null / undefined / 空字串當成「沒有對應欄」而不是第 0 欄', () => {
    // Number(null) === Number('') === 0，而 0 是合法欄索引；這正是缺陷所在。
    expect(normaliseColumnMapping([{ left: null, right: 3 }]))
      .toEqual([{ left: NO_COLUMN, right: 3 }])
    expect(normaliseColumnMapping([{ left: '', right: 3 }]))
      .toEqual([{ left: NO_COLUMN, right: 3 }])
    expect(normaliseColumnMapping([{ left: '   ', right: 3 }]))
      .toEqual([{ left: NO_COLUMN, right: 3 }])
    expect(normaliseColumnMapping([{ right: 3 }]))
      .toEqual([{ left: NO_COLUMN, right: 3 }])
    expect(normaliseColumnMapping([{ left: 2, right: null }]))
      .toEqual([{ left: 2, right: NO_COLUMN }])
  })

  it('布林值不是欄索引', () => {
    // Number(false) === 0、Number(true) === 1，兩者都會安靜地指到真的欄位。
    expect(normaliseColumnMapping([{ left: false, right: 1 }]))
      .toEqual([{ left: NO_COLUMN, right: 1 }])
    expect(normaliseColumnMapping([{ left: true, right: 1 }]))
      .toEqual([{ left: NO_COLUMN, right: 1 }])
  })

  it('兩側都沒有對應的配對整個丟掉；全丟光時回傳 null', () => {
    expect(normaliseColumnMapping([{ left: null, right: '' }])).toBeNull()
    expect(normaliseColumnMapping([{ left: null, right: null }, { left: 0, right: 1 }]))
      .toEqual([{ left: 0, right: 1 }])
  })

  it('仍接受數字字串與 0，並擋掉小數與負數', () => {
    expect(normaliseColumnMapping([{ left: '2', right: '0' }]))
      .toEqual([{ left: 2, right: 0 }])
    expect(normaliseColumnMapping([{ left: 0, right: 0 }]))
      .toEqual([{ left: 0, right: 0 }])
    expect(normaliseColumnMapping([{ left: 1.5, right: 0 }]))
      .toEqual([{ left: NO_COLUMN, right: 0 }])
    expect(normaliseColumnMapping([{ left: -3, right: 0 }]))
      .toEqual([{ left: NO_COLUMN, right: 0 }])
    expect(normaliseColumnMapping([{ left: 'x', right: 0 }]))
      .toEqual([{ left: NO_COLUMN, right: 0 }])
  })

  it('經由 setColumnMapping() 進來的 null 也不會變成第 0 欄', () => {
    const tc = mountView()
    loadBoth(tc)
    tc.setColumnMapping([{ left: null, right: 1 }, { left: 2, right: 2 }])
    expect(tc.getColumnMapping()).toEqual([
      { left: NO_COLUMN, right: 1 },
      { left: 2, right: 2 },
    ])
    // 左側第 0 欄沒有被偷偷配上去：這一顯示欄在左側是「沒有這一欄」。
    expect(tc._hasSourceColumn('left', 0)).toBe(false)
    expect(tc.getCellValue('left', 0, 0)).toBeNull()
  })
})

// ── B. setColumnMapping(null) 的截斷寬度 ──────────────────────────────────────

describe('setColumnMapping(null) — 還原為 1:1 時仍要截掉超寬的設定', () => {
  it('把 key 欄、隱藏欄、排除欄、欄位規則與顯示名稱截到 identity 寬度', () => {
    const tc = mountView({ keyColumn: 0 })
    loadBoth(tc)                       // 兩側各 3 欄 → identity 寬度 3

    tc.setColumnMapping([
      { left: 0, right: 0 }, { left: 1, right: 1 }, { left: 2, right: 2 },
      { left: 0, right: 1 }, { left: 1, right: 2 },
    ])
    tc.setKeyColumns([1, 4])
    tc.setColumnHidden(4, true)
    tc.setColumnIgnored(3, true)
    tc.setColumnRule(4, { mode: 'numeric', tolerance: 1 })
    tc.setColumnRule(1, { mode: 'numeric', tolerance: 1 })
    tc.setColumnDisplayName(4, '第五欄')
    tc.setColumnDisplayName(1, '第二欄')

    tc.resetColumnMapping()

    // 寬度是 3，所以 3 與 4 都不再指到任何東西。
    expect(tc.getColumnMapping()).toBeNull()
    expect(tc.getKeyColumns()).toEqual([1])
    expect(tc.getHiddenColumns()).toEqual([])
    expect(tc.getIgnoredColumns()).toEqual([])
    expect(Object.keys(tc.getColumnRules())).toEqual(['1'])
    expect(tc.getColumnDisplayNames()).toEqual({ 1: '第二欄' })
    // 可見的 key 欄輸入框不能還留著已經不存在的欄。
    expect(tc._dom.keyInput.value).toBe('1')
  })

  it('再度加寬對應時，被截掉的規則不會復活', () => {
    const tc = mountView({ keyColumn: 0 })
    loadBoth(tc)
    tc.setColumnMapping([
      { left: 0, right: 0 }, { left: 1, right: 1 },
      { left: 2, right: 2 }, { left: 0, right: 2 },
    ])
    tc.setColumnRule(3, { mode: 'ignore' })
    tc.resetColumnMapping()
    tc.setColumnMapping([
      { left: 0, right: 0 }, { left: 1, right: 1 },
      { left: 2, right: 2 }, { left: 0, right: 2 },
    ])
    expect(tc.getColumnRules()).toEqual({})
  })

  it('尚未載入資料時不截斷——那時候沒有寬度可以量', () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setKeyColumns([2])
    tc.resetColumnMapping()
    expect(tc.getKeyColumns()).toEqual([2])
  })
})

// ── C. setEncodingOverride() 的非文字來源守門 ────────────────────────────────

describe('setEncodingOverride() — Excel / HTML 來源', () => {
  const workbook = { sheetNames: ['S1'], sheets: { S1: 'a,b\n1,2' } }

  it('還原為「自動偵測」不會拿 .xlsx 的原始位元組再讀一次', async () => {
    const tc = mountView({ keyColumn: 0 })
    vi.mocked(window.electronAPI.readExcel).mockResolvedValue(workbook)
    await tc._openExcel('left', 'C:/book.xlsx')

    const ok = await tc.setEncodingOverride('left', null)

    expect(ok).toBe(false)
    expect(window.electronAPI.readFile).not.toHaveBeenCalled()
    // 沒有把 chardet 對 zip 位元組的猜測記成這一側的編碼。
    expect(tc.getEncoding('left')).toBeNull()
    expect(tc.getEncodingOverride('left')).toBeNull()
    // 資料仍然是那張工作表，沒有被原始位元組覆蓋。
    expect(tc.getCellValue('left', 0, 1)).toBe('2')
  })

  it('指定編碼一樣被擋下', async () => {
    const tc = mountView({ keyColumn: 0 })
    vi.mocked(window.electronAPI.readExcel).mockResolvedValue(workbook)
    await tc._openExcel('left', 'C:/book.xlsx')
    expect(await tc.setEncodingOverride('left', 'big5')).toBe(false)
    expect(window.electronAPI.readFile).not.toHaveBeenCalled()
  })

  it('文字來源仍然照常重讀並記下解碼器的判定', async () => {
    const tc = mountView({ keyColumn: 0 })
    loadBoth(tc)
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({
      content: 'a,b\n1,2', encoding: 'big5', path: 'C:/left.csv',
    })
    expect(await tc.setEncodingOverride('left', 'big5')).toBe(true)
    expect(window.electronAPI.readFile).toHaveBeenCalledWith('C:/left.csv', 'big5')
    expect(tc.getEncodingOverride('left')).toBe('big5')
    expect(tc.getEncoding('left')).toBe('big5')
  })
})

// ── suggestColumnMapping()：重複標題 ─────────────────────────────────────────

describe('suggestColumnMapping() — 標題重複時的多對一 / 一對多', () => {
  it('多對一：左側兩個同名欄，沒有任何一欄被安靜地丟掉', () => {
    const out = suggestColumnMapping(['a', 'a'], ['a'])
    expect(out).toHaveLength(2)
    expect(out.map((p) => p.left).sort((x, y) => x - y)).toEqual([0, 1])
    // 右側第 0 欄只能配給其中一個；另一個成為左側獨有欄，而不是消失。
    expect(out.filter((p) => p.right === 0)).toHaveLength(1)
    expect(out.filter((p) => p.right === NO_COLUMN)).toHaveLength(1)
  })

  it('一對多：右側兩個同名欄，多出來的變成右側獨有欄', () => {
    const out = suggestColumnMapping(['a'], ['a', 'a'])
    expect(out).toHaveLength(2)
    expect(out.map((p) => p.right).sort((x, y) => x - y)).toEqual([0, 1])
    expect(out.filter((p) => p.left === NO_COLUMN)).toHaveLength(1)
  })

  it('每個來源欄最多出現一次，不會被兩個顯示欄同時佔用', () => {
    const out = suggestColumnMapping(['a', 'a', 'b'], ['a', 'b', 'b'])
    const lefts = out.map((p) => p.left).filter((i) => i >= 0)
    const rights = out.map((p) => p.right).filter((i) => i >= 0)
    expect(new Set(lefts).size).toBe(lefts.length)
    expect(new Set(rights).size).toBe(rights.length)
    expect(lefts.sort((x, y) => x - y)).toEqual([0, 1, 2])
    expect(rights.sort((x, y) => x - y)).toEqual([0, 1, 2])
  })

  it('視圖上的重複標題也不會拋例外', () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('C:/l.csv', 'a,a\n1,2')
    tc.setRight('C:/r.csv', 'a\n1')
    /** @type {ReturnType<TableCompare['suggestColumnMapping']>} */
    let out = []
    expect(() => { out = tc.suggestColumnMapping() }).not.toThrow()
    expect(out).toHaveLength(2)
    expect(() => tc.setColumnMapping(out)).not.toThrow()
  })
})

// ── 超出資料欄數的對應 ───────────────────────────────────────────────────────

describe('setColumnMapping() — 索引超出實際欄數', () => {
  it('projectRow() 給出空字串，而不是拋例外', () => {
    expect(projectRow(['1', '2'], [0, 9])).toEqual(['1', ''])
    expect(projectRow(undefined, [0, 9])).toEqual(['', ''])
  })

  it('超寬的配對只是空欄，視圖照常渲染', () => {
    const tc = mountView({ keyColumn: 0 })
    loadBoth(tc, 'h1,h2\n1,2', 'h1,h2\n1,2')
    expect(() => tc.setColumnMapping([{ left: 0, right: 0 }, { left: 9, right: 9 }]))
      .not.toThrow()
    expect(tc.getCellValue('left', 0, 1)).toBe('')
    expect(tc.getCellValue('right', 0, 1)).toBe('')
    // 兩側都是空的 → 這一欄沒有差異，整列仍算相同。
    expect(tc.getStats().different).toBe(0)
    expect(tc._dom.leftTbody.children.length).toBe(1)
  })
})

// ── 對應對話框：刪除較前面的列之後，顯示名稱索引要跟著位移 ──────────────────

describe('applyColumnMappingDraft() — 刪除列後的顯示名稱索引', () => {
  it('名稱跟著配對走，不會留在原本的顯示欄索引上', () => {
    const tc = mountView({ keyColumn: 0 })
    loadBoth(tc)                 // 3 欄 → 草稿 3 列
    tc.openColumnMapping()

    const rows = () => [...tc._dom.mapPanel.querySelectorAll('.tc-map-row')]
    expect(rows()).toHaveLength(3)

    // 在第 #2 列（來源欄 2 ↔ 2）填上顯示名稱。
    const nameInput = /** @type {HTMLInputElement} */ (
      rows()[2].querySelector('.tc-map-name'))
    nameInput.value = '金額'
    nameInput.dispatchEvent(new Event('input'))

    // 移除更前面的第 #0 列——名稱應該跟著配對移到顯示欄 1。
    const del = /** @type {HTMLButtonElement} */ (rows()[0].querySelector('.tc-map-del'))
    del.click()
    expect(rows()).toHaveLength(2)

    const apply = /** @type {HTMLButtonElement} */ (
      tc._dom.mapPanel.querySelector('#tc-map-apply'))
    apply.click()

    expect(tc.getColumnMapping()).toEqual([{ left: 1, right: 1 }, { left: 2, right: 2 }])
    expect(tc.getColumnDisplayNames()).toEqual({ 1: '金額' })
    expect(tc.getColumnDisplayName(1)).toBe('金額')
    expect(tc.getColumnDisplayName(2)).toBeNull()
  })
})

// ── Recompare Files 之後，記憶體中的編輯要還在 ──────────────────────────────

describe('recompareFiles() — 從記憶體重新解析，不是重讀檔案', () => {
  it('儲存格編輯在重新比對之後仍然存在', () => {
    const tc = mountView({ keyColumn: 0 })
    loadBoth(tc, 'id,amount\n1,100', 'id,amount\n1,100')

    expect(tc.editCell('left', 0, 1, '999')).toBe(true)
    expect(tc.getCellValue('left', 0, 1)).toBe('999')
    expect(tc.getStats().different).toBe(1)

    expect(tc.recompareFiles()).toBe(true)

    expect(tc.getCellValue('left', 0, 1)).toBe('999')
    expect(tc.getStats().different).toBe(1)
    expect(tc._dom.leftTbody.children[0].textContent).toContain('999')
    // 重新比對只清復原歷程，不從磁碟重讀。
    expect(window.electronAPI.readFile).not.toHaveBeenCalled()
    expect(tc.canUndo()).toBe(false)
    expect(tc.hasUnsavedChanges()).toBe(true)
  })
})
