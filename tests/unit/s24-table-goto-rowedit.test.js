// @vitest-environment jsdom
/**
 * P2-43..46 — 表格比對的 Go To、Copy to Left/Right、Insert Row、差異程度色階
 * 與整表縮圖。
 *
 * 這個視圖有兩個歷史上反覆出問題的地方，本檔對每一項新功能都各驗一次：
 *
 * 1. **編輯必須落在資料模型，不能落在 DOM。** 視圖是虛擬捲動的，捲出畫面的列
 *    根本不存在於 DOM。因此每一項會改資料的功能都在「捲到別處再捲回來」之後
 *    再讀一次值。
 * 2. **改渲染路徑不能讓渲染量跟著資料量走。** 色階與縮圖都在數萬列上驗證
 *    「只渲染可見列」與「縮圖節點數有上限」。
 *
 * 另外，插入列會讓插入點以下每一列的索引位移。undo 堆疊若以索引記錄位置，
 * 插入之後的還原就會寫到別的列——這是本檔特別針對的一種安靜的資料損毀。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  TableCompare,
  cellDiffRatio,
  severityLevel,
  computeCellLevels,
  thumbnailBuckets,
  parseGotoInput,
} from '../../src/renderer/src/views/table-compare.js'
import { setActiveView } from '../../src/renderer/src/core/active-view.js'

/** @type {HTMLElement[]} */
let hosts = []
/** @type {TableCompare[]} */
let views = []

/**
 * @param {string} leftCsv
 * @param {string} rightCsv
 * @param {object} [opts]
 * @returns {{ view: TableCompare, errors: string[] }}
 */
function mount(leftCsv, rightCsv, opts = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new TableCompare(opts)
  /** @type {string[]} */
  const errors = []
  // A 'status' listener keeps _reportError from falling back to a toast, and
  // gives the assertions something to read: "the user was told" is part of the
  // behaviour under test, not an implementation detail.
  view.on('status', (p) => errors.push(String(p?.message ?? '')))
  view.mount(host)
  view.setLeft('C:/tmp/left.csv', leftCsv)
  view.setRight('C:/tmp/right.csv', rightCsv)
  hosts.push(host)
  views.push(view)
  return { view, errors }
}

/**
 * @param {number} rows
 * @param {(i: number) => string} rowFn
 * @returns {string}
 */
function csv(rows, rowFn) {
  const out = ['id,name,amount']
  for (let i = 1; i <= rows; i++) out.push(rowFn(i))
  return out.join('\n')
}

beforeEach(() => { setActiveView('table') })

afterEach(() => {
  for (const v of views) v.destroy()
  for (const h of hosts) h.remove()
  views = []
  hosts = []
  setActiveView('home')
})

// ── parseGotoInput ───────────────────────────────────────────────────────────

describe('parseGotoInput', () => {
  it('接受純列號與「列,欄」兩種寫法', () => {
    expect(parseGotoInput('12')).toEqual({ row: 12, col: null })
    expect(parseGotoInput('12,3')).toEqual({ row: 12, col: 3 })
    expect(parseGotoInput('12:3')).toEqual({ row: 12, col: 3 })
    expect(parseGotoInput('  12 , 3 ')).toEqual({ row: 12, col: 3 })
  })

  it('第 0 欄是合法的，第 0 列不是', () => {
    // 欄是 0-based（畫面上的欄索引），列是 1-based（畫面上的列號）。
    expect(parseGotoInput('1,0')).toEqual({ row: 1, col: 0 })
    expect(parseGotoInput('0')).toBeNull()
    expect(parseGotoInput('0,1')).toBeNull()
  })

  it('拒絕會被 parseInt 寬鬆吞下的輸入，而不是猜使用者的意思', () => {
    for (const bad of ['', '   ', 'abc', '12abc', '1.5', '-3', '1,2,3', '1,', ',2', '0x10']) {
      expect(parseGotoInput(bad), bad).toBeNull()
    }
    expect(parseGotoInput(null)).toBeNull()
    expect(parseGotoInput(undefined)).toBeNull()
  })
})

// ── Go To ────────────────────────────────────────────────────────────────────

describe('Go To（跳至列 / 欄）', () => {
  it('工具列按鈕會開啟跳至列，Ctrl+G 也會', () => {
    const { view } = mount(csv(5, (i) => `${i},n${i},1`), csv(5, (i) => `${i},n${i},1`))
    const bar = view._dom.gotoBar
    expect(bar.style.display).toBe('none')

    view._dom.btnGoto.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(bar.style.display).toBe('flex')

    view.closeGoto()
    expect(bar.style.display).toBe('none')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))
    expect(bar.style.display).toBe('flex')
  })

  it('Ctrl+G 只在表格視圖是作用中的視圖時有效', () => {
    const { view } = mount(csv(3, (i) => `${i},a,1`), csv(3, (i) => `${i},a,1`))
    view.closeGoto()
    setActiveView('text')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))
    expect(view._dom.gotoBar.style.display).toBe('none')
  })

  it('跳到指定的列與欄後，該格成為選取的儲存格', () => {
    const { view } = mount(csv(200, (i) => `${i},n${i},1`), csv(200, (i) => `${i},n${i},2`))
    expect(view.gotoRowCol(120, 2)).toBe(true)
    expect(view.getSelectedCell()).toEqual({ side: 'left', visibleRowIdx: 119, col: 2 })
  })

  it('列號超出範圍時拒絕跳轉並說明範圍，而不是靜靜地夾到邊界', () => {
    const { view, errors } = mount(csv(10, (i) => `${i},a,1`), csv(10, (i) => `${i},a,1`))
    expect(view.gotoRowCol(999)).toBe(false)
    expect(errors.join()).toContain('1 與 10')
    // 失敗的跳轉不得改變選取狀態。
    expect(view.getSelectedCell()).toBeNull()
  })

  it('欄號超出範圍時同樣拒絕', () => {
    const { view, errors } = mount(csv(10, (i) => `${i},a,1`), csv(10, (i) => `${i},a,1`))
    expect(view.gotoRowCol(2, 99)).toBe(false)
    expect(errors.join()).toContain('欄號')
  })

  it('列號是「畫面上看得到的列號」，不是檔案列號', () => {
    // 只顯示差異之後，第 1 列必須是第一個差異列——跳到一個畫面上沒有的號碼
    // 只會讓人以為功能壞了。
    const left = 'id,v\n1,a\n2,b\n3,c\n4,d'
    const right = 'id,v\n1,a\n2,B\n3,c\n4,D'
    const { view } = mount(left, right)
    view._showSame = false
    view._renderTable()

    expect(view._visibleRows.length).toBe(2)
    expect(view.gotoRowCol(1, 1)).toBe(true)
    expect(view._visibleRows[0].leftRow[0]).toBe('2')
    expect(view.gotoRowCol(3)).toBe(false)
  })

  it('輸入框送出格式錯誤的內容時，把原因寫在列上而不是清空', () => {
    const { view } = mount(csv(5, (i) => `${i},a,1`), csv(5, (i) => `${i},a,1`))
    view.openGoto()
    view._dom.gotoInput.value = '不是數字'
    view._dom.btnGotoGo.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view._dom.gotoError.textContent).toContain('格式')
    // 列必須留著，讓使用者可以直接改。
    expect(view._dom.gotoBar.style.display).toBe('flex')
  })

  it('Enter 送出合法輸入後跳轉並關閉列', () => {
    const { view } = mount(csv(50, (i) => `${i},a,1`), csv(50, (i) => `${i},a,1`))
    view.openGoto()
    view._dom.gotoInput.value = '30,1'
    view._dom.gotoInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(view.getSelectedCell()?.visibleRowIdx).toBe(29)
    expect(view._dom.gotoBar.style.display).toBe('none')
  })

  it('右鍵選單提供「跳至列 / 欄…」', () => {
    const { view } = mount(csv(5, (i) => `${i},a,1`), csv(5, (i) => `${i},a,2`))
    const labels = contextMenuLabels(view, 'left')
    expect(labels).toContain('跳至列 / 欄…')
  })
})

/**
 * 攔下 showContextMenu 的項目清單。
 * @param {TableCompare} view
 * @param {'left'|'right'} side
 * @returns {string[]}
 */
function contextMenuLabels(view, side) {
  const tbody = view._dom[`${side}Tbody`]
  const tr = tbody?.querySelector('tr.tc-row')
  if (!tr) return []
  const td = tr.querySelector('td.tc-cell')
  /** @type {string[]} */
  const labels = []
  const e = new MouseEvent('contextmenu', { bubbles: true })
  Object.defineProperty(e, 'target', { value: td ?? tr })
  view._onTableContextMenu(e, side)
  for (const node of document.querySelectorAll('.ctx-menu .ctx-item')) {
    labels.push((node.textContent ?? '').trim())
  }
  return labels
}

// ── Copy to Left / Right ─────────────────────────────────────────────────────

describe('Copy to Left / Right（整列複製）', () => {
  it('對側已有這一列時整列改寫，並讓該列變成相同', () => {
    const { view } = mount('id,v,w\n1,a,x\n2,b,y', 'id,v,w\n1,A,X\n2,b,y')
    expect(view._visibleRows[0].status).toBe('different')

    expect(view.copyRowToOtherSide('left', 0)).toBe(true)
    expect(view._visibleRows[0].status).toBe('same')
    expect(view.getCellValue('right', 0, 1)).toBe('a')
    expect(view.getCellValue('right', 0, 2)).toBe('x')
    expect(view.getModified()).toEqual({ left: false, right: true })
  })

  it('複製的是資料模型不是 DOM：捲出畫面再捲回來，值仍在', () => {
    const rows = 30_000
    const { view } = mount(
      csv(rows, (i) => `${i},L${i},1`),
      csv(rows, (i) => `${i},R${i},2`))

    view.copyRowToOtherSide('left', 5)
    // 捲到很遠的地方，第 5 列的 <tr> 一定已經不在 DOM 裡。
    view._scrollToVisibleRow(20_000)
    expect(view._windowFirst).toBeGreaterThan(19_000)
    view._scrollToVisibleRow(5)

    expect(view.getCellValue('right', 5, 1)).toBe('L6')
    expect(view._visibleRows[5].status).toBe('same')
  })

  it('對側是幻影列時插入一列，插在上一筆有資料的列之後', () => {
    // 右側沒有 id=2，所以第 2 列右側是幻影列。
    const { view } = mount('id,v\n1,a\n2,b\n3,c', 'id,v\n1,a\n3,c')
    const orphanIdx = view._visibleRows.findIndex((r) => r.status === 'left-only')
    expect(orphanIdx).toBeGreaterThanOrEqual(0)

    expect(view.copyRowToOtherSide('left', orphanIdx)).toBe(true)
    // 插入後右側檔案順序必須是 1,2,3——附加在檔尾會讓後續的位置對齊全錯。
    expect(view._rightParsed.map((r) => r[0])).toEqual(['id', '1', '2', '3'])
    expect(view._alignedRows.every((r) => r.status === 'same')).toBe(true)
  })

  it('來源側是幻影列時拒絕複製並說明原因', () => {
    const { view, errors } = mount('id,v\n1,a\n3,c', 'id,v\n1,a\n2,b\n3,c')
    const orphanIdx = view._visibleRows.findIndex((r) => r.status === 'right-only')
    expect(view.copyRowToOtherSide('left', orphanIdx)).toBe(false)
    expect(errors.join()).toContain('沒有資料')
  })

  it('undo 還原整列改寫，redo 再套用一次', () => {
    const { view } = mount('id,v,w\n1,a,x', 'id,v,w\n1,A,X')
    view.copyRowToOtherSide('left', 0)
    expect(view.getCellValue('right', 0, 1)).toBe('a')

    expect(view.undo()).toBe(true)
    expect(view.getCellValue('right', 0, 1)).toBe('A')
    expect(view.getCellValue('right', 0, 2)).toBe('X')

    expect(view.redo()).toBe(true)
    expect(view.getCellValue('right', 0, 1)).toBe('a')
  })

  it('undo 還原「因複製而插入的列」，會把那一列整個移除', () => {
    const { view } = mount('id,v\n1,a\n2,b\n3,c', 'id,v\n1,a\n3,c')
    const orphanIdx = view._visibleRows.findIndex((r) => r.status === 'left-only')
    view.copyRowToOtherSide('left', orphanIdx)
    expect(view._rightParsed.length).toBe(4)

    expect(view.undo()).toBe(true)
    expect(view._rightParsed.map((r) => r[0])).toEqual(['id', '1', '3'])

    expect(view.redo()).toBe(true)
    expect(view._rightParsed.map((r) => r[0])).toEqual(['id', '1', '2', '3'])
  })

  it('忽略欄位排序時值寫進目標檔案自己的欄序，不是顯示欄序', () => {
    // 右檔的欄序是 v,id——直接照顯示欄索引寫回去會把 id 寫進 v 欄。
    const { view } = mount('id,v\n1,a\n2,b', 'v,id\nA,1\nB,2', { ignoreColumnOrder: true })
    expect(view.copyRowToOtherSide('left', 0)).toBe(true)
    // 右檔第一列（資料列）仍是 [v, id] 的順序。
    expect(view._rightParsed[1]).toEqual(['a', '1'])
  })

  it('目標檔案沒有同名欄位時，明確告知那些值沒有被複製', () => {
    const { view, errors } = mount('id,extra\n1,keep', 'id,other\n1,zzz', { ignoreColumnOrder: true })
    expect(view.copyRowToOtherSide('left', 0)).toBe(true)
    expect(errors.join()).toContain('沒有同名欄位')
  })

  it('目標側尚未載入檔案時拒絕，而不是憑空生出一個檔案', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new TableCompare()
    /** @type {string[]} */
    const errors = []
    view.on('status', (p) => errors.push(String(p?.message ?? '')))
    view.mount(host)
    view.setLeft('C:/tmp/a.csv', 'id,v\n1,a')
    hosts.push(host)
    views.push(view)

    expect(view.copyRowToOtherSide('left', 0)).toBe(false)
    expect(errors.join()).toContain('尚未載入')
  })

  it('工具列按鈕、Alt+→/← 與右鍵選單都能觸發', () => {
    const { view } = mount('id,v\n1,a\n2,b', 'id,v\n1,A\n2,B')

    view.selectCell('left', 0, 1)
    view._dom.btnCopyRight.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.getCellValue('right', 0, 1)).toBe('a')

    view.selectCell('right', 1, 1)
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }))
    expect(view.getCellValue('left', 1, 1)).toBe('B')

    expect(contextMenuLabels(view, 'left')).toContain('複製整列到右側')
    expect(contextMenuLabels(view, 'right')).toContain('複製整列到左側')
  })

  it('沒有選取任何列時，工具列的複製會說明要先選一列', () => {
    const { view, errors } = mount('id,v\n1,a', 'id,v\n1,a')
    // 兩側完全相同 → 沒有差異列可以當作預設作用列。
    expect(view.copyRowToOtherSide('left')).toBe(false)
    expect(errors.join()).toContain('請先選取')
  })
})

// ── Insert Row ───────────────────────────────────────────────────────────────

describe('Insert Row（插入列）', () => {
  it('在指定列的上方 / 下方插入空白列', () => {
    const { view } = mount('id,v\n1,a\n2,b', 'id,v\n1,a\n2,b')

    expect(view.insertRow('left', 0, 'below')).toBe(true)
    expect(view._leftParsed.map((r) => r[0])).toEqual(['id', '1', '', '2'])

    expect(view.insertRow('left', 0, 'above')).toBe(true)
    expect(view._leftParsed.map((r) => r[0])).toEqual(['id', '', '1', '', '2'])
  })

  it('插入的列欄數與該側一致，不是一個長度 0 的空陣列', () => {
    const { view } = mount('id,v,w\n1,a,x', 'id,v,w\n1,a,x')
    view.insertRow('left', 0, 'below')
    expect(view._leftParsed[2]).toEqual(['', '', ''])
  })

  it('undo 移除插入的列，redo 插回同一個位置', () => {
    const { view } = mount('id,v\n1,a\n2,b\n3,c', 'id,v\n1,a\n2,b\n3,c')
    view.insertRow('left', 1, 'below')
    expect(view._leftParsed.map((r) => r[0])).toEqual(['id', '1', '2', '', '3'])

    expect(view.undo()).toBe(true)
    expect(view._leftParsed.map((r) => r[0])).toEqual(['id', '1', '2', '3'])

    expect(view.redo()).toBe(true)
    expect(view._leftParsed.map((r) => r[0])).toEqual(['id', '1', '2', '', '3'])
  })

  it('插入列之後，先前那筆儲存格編輯的 undo 仍然落在原本那一列', () => {
    // 這是插入列最容易造成的安靜損毀：undo 若以「當初的索引」重放，插入點
    // 以下的每一列都位移了一格，還原就會寫到隔壁列。
    const { view } = mount('id,v\n1,a\n2,b\n3,c', 'id,v\n1,a\n2,b\n3,c')
    view.editCell('left', 2, 1, 'CHANGED')
    expect(view._leftParsed[3]).toEqual(['3', 'CHANGED'])

    view.insertRow('left', 0, 'above')
    expect(view._leftParsed[4]).toEqual(['3', 'CHANGED'])

    // 第一個 undo 撤掉插入，第二個 undo 撤掉儲存格編輯。
    expect(view.undo()).toBe(true)
    expect(view.undo()).toBe(true)
    expect(view._leftParsed.map((r) => r.join('/'))).toEqual(['id/v', '1/a', '2/b', '3/c'])
  })

  it('插入的列存在於資料模型：捲很遠再回來仍看得到', () => {
    const rows = 30_000
    const { view } = mount(csv(rows, (i) => `${i},a,1`), csv(rows, (i) => `${i},a,1`))
    const before = view._leftParsed.length
    view.insertRow('left', 10, 'below')
    view._scrollToVisibleRow(25_000)
    view._scrollToVisibleRow(10)
    expect(view._leftParsed.length).toBe(before + 1)
    expect(view.getModified().left).toBe(true)
  })

  it('尚未載入檔案的一側拒絕插入並說明原因', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new TableCompare()
    /** @type {string[]} */
    const errors = []
    view.on('status', (p) => errors.push(String(p?.message ?? '')))
    view.mount(host)
    view.setLeft('C:/tmp/a.csv', 'id,v\n1,a')
    hosts.push(host)
    views.push(view)

    expect(view.insertRow('right', 0)).toBe(false)
    expect(errors.join()).toContain('尚未載入')
  })

  it('工具列按鈕、Ctrl+I 與右鍵選單都能觸發', () => {
    const { view } = mount('id,v\n1,a\n2,b', 'id,v\n1,a\n2,b')

    view.selectCell('left', 0, 0)
    view._dom.btnInsertRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view._leftParsed.length).toBe(4)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true }))
    expect(view._leftParsed.length).toBe(5)

    const labels = contextMenuLabels(view, 'right')
    expect(labels.some((l) => l.includes('在此列上方插入空白列'))).toBe(true)
    expect(labels.some((l) => l.includes('在此列下方插入空白列'))).toBe(true)
  })
})

// ── 差異程度色階 ─────────────────────────────────────────────────────────────

describe('cellDiffRatio / severityLevel', () => {
  it('相同的儲存格是 0，含空字串與 null/undefined 的組合', () => {
    expect(cellDiffRatio('abc', 'abc')).toBe(0)
    expect(cellDiffRatio('', '')).toBe(0)
    expect(cellDiffRatio(null, undefined)).toBe(0)
    expect(cellDiffRatio(null, '')).toBe(0)
  })

  it('改一個字元遠小於整格換掉', () => {
    const small = cellDiffRatio('hello world', 'hello worlD')
    const large = cellDiffRatio('hello world', 'xxxxxxxxxxx')
    expect(small).toBeLessThan(large)
    expect(large).toBe(1)
    expect(severityLevel(small)).toBe(1)
    expect(severityLevel(large)).toBe(3)
  })

  it('空 → 有值視為完全不同', () => {
    expect(cellDiffRatio('', 'anything')).toBe(1)
    expect(severityLevel(cellDiffRatio('', 'anything'))).toBe(3)
  })

  it('數字欄依量值差距而非字元差距分級', () => {
    // 1000 → 1001 只差 0.1%，但字串量測會說它們差 25%。
    expect(cellDiffRatio('1000', '1001')).toBeCloseTo(0.000999, 5)
    expect(severityLevel(cellDiffRatio('1000', '1001'))).toBe(1)
    // 1 → 1000 是三個數量級。
    expect(severityLevel(cellDiffRatio('1', '1000'))).toBe(3)
    // 0 → 非 0 沒有相對尺度可用。
    expect(cellDiffRatio('0', '5')).toBe(1)
  })

  it('分級是單調的，且只有 0..3 四個值', () => {
    let prev = 0
    for (const r of [0, 0.01, 0.25, 0.26, 0.6, 0.61, 1]) {
      const lvl = severityLevel(r)
      expect(lvl).toBeGreaterThanOrEqual(prev)
      expect([0, 1, 2, 3]).toContain(lvl)
      prev = lvl
    }
    // 非數字或負數一律視為沒有差異，而不是丟例外或給出 NaN 等級。
    expect(severityLevel(NaN)).toBe(0)
    expect(severityLevel(-1)).toBe(0)
  })

  it('computeCellLevels 只為「已判定為不同」的欄給等級', () => {
    // 第 1 欄雖然字面不同，但呼叫端（欄位規則）說它相同 → 等級必須是 0，
    // 否則一個被規則判為相同的欄會突然有顏色。
    const levels = computeCellLevels(['a', 'x'], ['b', 'y'], [true, false])
    expect(levels[0]).toBeGreaterThan(0)
    expect(levels[1]).toBe(0)
  })
})

describe('差異程度色階（渲染）', () => {
  it('預設不著色；開啟後差異儲存格才帶等級 class', () => {
    const { view } = mount('id,v\n1,aaaaaaaaaa', 'id,v\n1,zzzzzzzzzz')
    const cellOf = () => view._dom.leftTbody.querySelector('tr.tc-row td.cell-diff')

    expect(cellOf().className).not.toMatch(/tc-cell--sev/)
    expect(view.toggleSeverityShading()).toBe(true)
    expect(cellOf().className).toMatch(/tc-cell--sev3/)
    // 原本的 cell-diff 語意不能被取代，只能被細分。
    expect(cellOf().classList.contains('cell-diff')).toBe(true)

    expect(view.toggleSeverityShading()).toBe(false)
    expect(cellOf().className).not.toMatch(/tc-cell--sev/)
  })

  it('列的等級是該列最嚴重的儲存格', () => {
    const { view } = mount('id,v,w\n1,hello worl,aaaa', 'id,v,w\n1,hello worlX,zzzz')
    view.setSeverityShading(true)
    const tr = view._dom.leftTbody.querySelector('tr.tc-row.different')
    expect(tr.className).toContain('tc-row--sev3')
  })

  it('被忽略的欄不會因為分級而重新出現顏色', () => {
    const { view } = mount('id,v\n1,aaaa', 'id,v\n1,zzzz')
    view.setColumnIgnored(1, true)
    view.setSeverityShading(true)
    expect(view._dom.leftTbody.querySelector('.tc-cell--sev1, .tc-cell--sev2, .tc-cell--sev3'))
      .toBeNull()
  })

  it('工具列按鈕是入口，狀態會反映在按鈕上', () => {
    const { view } = mount('id,v\n1,a', 'id,v\n1,b')
    const btn = view._dom.btnSeverity
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.isSeverityShaded()).toBe(true)
    expect(btn.classList.contains('active')).toBe(true)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(btn.classList.contains('active')).toBe(false)
  })

  it('開啟色階後，三萬列的表仍只渲染可見列', () => {
    const rows = 30_000
    const { view } = mount(
      csv(rows, (i) => `${i},L${i},1`),
      csv(rows, (i) => `${i},R${i},2`))
    view.setSeverityShading(true)
    expect(view._dom.leftTbody.children.length).toBeLessThan(200)
    view._scrollToVisibleRow(15_000)
    expect(view._dom.leftTbody.children.length).toBeLessThan(200)
  })

  it('設定會進 getConfig / applyConfig', () => {
    const { view } = mount('id,v\n1,a', 'id,v\n1,b')
    view.setSeverityShading(true)
    const cfg = view.getConfig()
    view.setSeverityShading(false)
    view.applyConfig(cfg)
    expect(view.isSeverityShaded()).toBe(true)
  })
})

// ── Thumbnail ────────────────────────────────────────────────────────────────

describe('thumbnailBuckets', () => {
  it('區段數不超過要求，且完整覆蓋每一列', () => {
    const rows = Array.from({ length: 1000 }, () => ({ status: 'same' }))
    const buckets = thumbnailBuckets(rows, 40)
    expect(buckets.length).toBe(40)
    expect(buckets[0].start).toBe(0)
    expect(buckets[buckets.length - 1].end).toBe(1000)
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].start).toBe(buckets[i - 1].end)
    }
  })

  it('列數少於區段數時不產生空區段', () => {
    const rows = Array.from({ length: 3 }, () => ({ status: 'different' }))
    const buckets = thumbnailBuckets(rows, 400)
    expect(buckets.length).toBe(3)
    expect(buckets.every((b) => b.end > b.start)).toBe(true)
  })

  it('十萬列裡的三列差異不會被多數決吃掉', () => {
    // 縮圖的用途就是找出這種稀有差異；取多數會讓它整個消失。
    const rows = Array.from({ length: 100_000 }, () => ({ status: 'same' }))
    rows[10].status = 'different'
    rows[50_000].status = 'left-only'
    rows[99_999].status = 'right-only'
    const buckets = thumbnailBuckets(rows, 400)
    const statuses = buckets.map((b) => b.status)
    expect(statuses).toContain('different')
    expect(statuses).toContain('left-only')
    expect(statuses).toContain('right-only')
  })

  it('空輸入與非法區段數回傳空陣列，而不是丟例外', () => {
    expect(thumbnailBuckets([], 10)).toEqual([])
    expect(thumbnailBuckets([{ status: 'same' }], 0)).toEqual([])
    expect(thumbnailBuckets([{ status: 'same' }], -5)).toEqual([])
  })
})

describe('Thumbnail（渲染）', () => {
  it('預設隱藏；工具列按鈕開關並切換 body 的排版 class', () => {
    const { view } = mount('id,v\n1,a\n2,b', 'id,v\n1,A\n2,b')
    expect(view.isThumbnailVisible()).toBe(false)
    expect(view._dom.thumb.style.display).toBe('none')

    view._dom.btnThumb.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.isThumbnailVisible()).toBe(true)
    expect(view._dom.thumb.style.display).toBe('')
    expect(view._dom.body.classList.contains('with-thumb')).toBe(true)
    expect(view._dom.btnThumb.classList.contains('active')).toBe(true)

    view._dom.btnThumb.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view._dom.body.classList.contains('with-thumb')).toBe(false)
  })

  it('只畫差異區段：全相同的表沒有任何標記', () => {
    const { view } = mount('id,v\n1,a\n2,b', 'id,v\n1,a\n2,b')
    view.setThumbnailVisible(true)
    expect(view._dom.thumbStrip.querySelectorAll('.tc-thumb-mark').length).toBe(0)
    // 視窗指示本身必須留著。
    expect(view._dom.thumbStrip.querySelector('.tc-thumb-viewport')).not.toBeNull()
  })

  it('三種差異狀態各自有對應的標記顏色 class', () => {
    const { view } = mount('id,v\n1,a\n2,b\n3,c', 'id,v\n1,A\n3,c\n4,d')
    view.setThumbnailVisible(true)
    const classes = [...view._dom.thumbStrip.querySelectorAll('.tc-thumb-mark')]
      .map((n) => n.className)
      .join(' ')
    expect(classes).toContain('different')
    expect(classes).toContain('left-only')
    expect(classes).toContain('right-only')
  })

  it('五萬列的縮圖節點數有上限，不隨列數成長', () => {
    const rows = 50_000
    const { view } = mount(
      csv(rows, (i) => `${i},L${i},1`),
      csv(rows, (i) => `${i},R${i},2`))
    view.setThumbnailVisible(true)
    const marks = view._dom.thumbStrip.querySelectorAll('.tc-thumb-mark').length
    expect(marks).toBeGreaterThan(0)
    expect(marks).toBeLessThanOrEqual(400)
    // 表格本身也不能因為縮圖而失去虛擬捲動。
    expect(view._dom.leftTbody.children.length).toBeLessThan(200)
  })

  it('點擊位置換算成列並捲過去', () => {
    const rows = 10_000
    const { view } = mount(csv(rows, (i) => `${i},a,1`), csv(rows, (i) => `${i},a,1`))
    view.setThumbnailVisible(true)
    expect(view.scrollToThumbFraction(0.5)).toBe(5000)
    expect(view.scrollToThumbFraction(0)).toBe(0)
    expect(view.scrollToThumbFraction(1)).toBe(rows - 1)
    // 超出範圍的比例夾到兩端，而不是回傳不存在的列。
    expect(view.scrollToThumbFraction(-3)).toBe(0)
    expect(view.scrollToThumbFraction(9)).toBe(rows - 1)
  })

  it('沒有可見列時點擊縮圖不做任何事', () => {
    const { view } = mount('id,v\n1,a', 'id,v\n1,a')
    view.setThumbnailVisible(true)
    view._showSame = false
    view._renderTable()
    expect(view._visibleRows.length).toBe(0)
    expect(view.scrollToThumbFraction(0.5)).toBe(-1)
  })

  it('篩選改變後縮圖跟著重畫', () => {
    const { view } = mount('id,v\n1,a\n2,b\n3,c', 'id,v\n1,A\n2,b\n3,c')
    view.setThumbnailVisible(true)
    const before = view._thumbBuckets.length
    view._showSame = false
    view._renderTable()
    expect(view._thumbBuckets.length).toBeLessThan(before)
    expect(view._thumbBuckets.every((b) => b.status === 'different')).toBe(true)
  })

  it('設定會進 getConfig / applyConfig', () => {
    const { view } = mount('id,v\n1,a', 'id,v\n1,b')
    view.setThumbnailVisible(true)
    const cfg = view.getConfig()
    view.setThumbnailVisible(false)
    view.applyConfig(cfg)
    expect(view.isThumbnailVisible()).toBe(true)
  })
})

// ── 既有功能未退化 ───────────────────────────────────────────────────────────

describe('既有功能仍然成立', () => {
  it('儲存格編輯 / undo / redo 不受列層級歷史紀錄影響', () => {
    const { view } = mount('id,v\n1,a\n2,b', 'id,v\n1,a\n2,b')
    expect(view.editCell('left', 0, 1, 'z')).toBe(true)
    expect(view.getCellValue('left', 0, 1)).toBe('z')
    expect(view.undo()).toBe(true)
    expect(view.getCellValue('left', 0, 1)).toBe('a')
    expect(view.redo()).toBe(true)
    expect(view.getCellValue('left', 0, 1)).toBe('z')
    expect(view.undo()).toBe(true)
    expect(view.canUndo()).toBe(false)
    expect(view.undo()).toBe(false)
  })

  it('列層級與儲存格層級的編輯可以交錯還原', () => {
    const { view } = mount('id,v\n1,a\n2,b', 'id,v\n1,A\n2,B')
    view.editCell('right', 0, 1, 'q')
    view.copyRowToOtherSide('left', 1)
    view.editCell('right', 0, 1, 'r')

    expect(view.undo()).toBe(true)
    expect(view.getCellValue('right', 0, 1)).toBe('q')
    expect(view.undo()).toBe(true)
    expect(view.getCellValue('right', 1, 1)).toBe('B')
    expect(view.undo()).toBe(true)
    expect(view.getCellValue('right', 0, 1)).toBe('A')
    expect(view.canUndo()).toBe(false)
  })

  it('欄位顯示 / 排除、Details 與 File Info 面板都還在', () => {
    const { view } = mount('id,v\n1,a', 'id,v\n1,b')
    view.setColumnHidden(1, true)
    expect(view.isColumnHidden(1)).toBe(true)
    expect(view.toggleDetails()).toBe(true)
    expect(view.toggleFileInfo()).toBe(true)
    view.selectCell('left', 0, 0)
    expect(view._dom.detailsBody.textContent).toContain('第 1 列')
  })

  it('搜尋與差異導航仍以可見列為座標系', () => {
    const { view } = mount('id,v\n1,a\n2,b\n3,c', 'id,v\n1,a\n2,B\n3,c')
    view._findQuery = 'B'
    view._findCaseSensitive = true
    view._recomputeFind()
    expect(view._findMatches.length).toBe(1)
    expect(view._findMatches[0].rowIndex).toBe(1)
    view.firstDifference()
    expect(view.getCurrentDiffIndex()).toBe(0)
  })
})
