/**
 * @vitest-environment jsdom
 *
 * S26 — Table Compare 的跨視圖一致性缺口。
 *
 * 這些指令在其他視圖都有，只有表格沒有：Select All、列號開關、Explorer、
 * 儲存格剪貼、顯示字級、以及「上/下一處編輯」。單獨看每項都小，合起來是
 * 表格視圖比其他視圖陽春的原因。
 *
 * 這個檔案刻意用「數萬列」而不是三筆資料驗證選取與字級：表格渲染上一次出
 * 問題（十萬個 DOM 節點）正是因為只被三四筆的測試覆蓋過。全選若逐格標記
 * DOM，指令本身就會凍住畫面，而三筆資料永遠測不出來。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TableCompare } from '../../src/renderer/src/views/table-compare.js'

/** @type {HTMLElement} */
let host
/** @type {TableCompare} */
let view
/** @type {{ writeText: import('vitest').Mock, readText: import('vitest').Mock }} */
let clipboard

/**
 * @param {number} rows
 * @param {(i: number) => string} [tweak]
 * @returns {string}
 */
function csv(rows, tweak) {
  const lines = ['id,name,value']
  for (let i = 0; i < rows; i++) lines.push(`${i},name${i},${tweak ? tweak(i) : i}`)
  return lines.join('\n')
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)

  clipboard = { writeText: vi.fn(async () => {}), readText: vi.fn(async () => 'pasted') }
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: clipboard, configurable: true, writable: true,
  })
  globalThis.window.electronAPI = { showInExplorer: vi.fn(async () => true) }

  view = new TableCompare()
  view.mount(host)
})

afterEach(() => {
  view?.destroy?.()
  host.remove()
  vi.restoreAllMocks()
  delete globalThis.window.electronAPI
})

describe('Select All', () => {
  it('全選三萬列時不會逐格標記 DOM——只有虛擬視窗內的儲存格被上色', () => {
    const ROWS = 30000
    view.setLeft('a.csv', csv(ROWS))
    view.setRight('b.csv', csv(ROWS))

    const result = view.selectAll('left')
    expect(result).toEqual({ rows: ROWS, cols: 3 })

    // 若實作是「選取時走訪每一列」，這裡會是 90000。
    const painted = host.querySelectorAll('.tc-cell--in-range').length
    expect(painted).toBeGreaterThan(0)
    expect(painted).toBeLessThan(500)
  })

  it('複製的是模型而不是 DOM，所以捲軸外的列一樣在剪貼簿裡', async () => {
    const ROWS = 5000
    view.setLeft('a.csv', csv(ROWS))
    view.setRight('b.csv', csv(ROWS))
    view.selectAll('left')

    expect(await view.copySelection()).toBe(true)
    const text = clipboard.writeText.mock.calls[0][0]
    const lines = text.split('\n')
    expect(lines).toHaveLength(ROWS)
    // 最後一列在畫面上從未被渲染過。
    expect(lines[ROWS - 1]).toBe(`${ROWS - 1}\tname${ROWS - 1}\t${ROWS - 1}`)
  })

  it('沒有資料時明講，不假裝選了東西', () => {
    const errors = []
    view.on('status', (p) => { if (p.level === 'error') errors.push(p.message) })
    expect(view.selectAll('left')).toBeNull()
    expect(errors.join()).toContain('沒有可選取')
  })

  it('點選單一儲存格會取消範圍，避免之後的清除打到看不見的列', () => {
    view.setLeft('a.csv', csv(50))
    view.setRight('b.csv', csv(50))
    view.selectAll('left')
    expect(view.getSelectionRange()).not.toBeNull()

    view.selectCell('left', 2, 1)
    expect(view.getSelectionRange()).toBeNull()
  })

  it('篩選改變可見列之後，舊的範圍會被丟掉而不是指向別的列', () => {
    view.setLeft('a.csv', csv(20))
    view.setRight('b.csv', csv(20, (i) => (i === 3 ? 'X' : String(i))))
    view.selectAll('left')
    expect(view.getSelectionRange()).not.toBeNull()

    view._showSame = false
    view._renderTable()
    expect(view.getSelectionRange()).toBeNull()
  })

  it('工具列上有入口', () => {
    expect(host.querySelector('#tc-btn-select-all')).not.toBeNull()
  })
})

describe('Row Numbers', () => {
  it('切換的是 class，列號儲存格仍在，欄索引不位移', () => {
    view.setLeft('a.csv', csv(10))
    view.setRight('b.csv', csv(10))

    const root = host.querySelector('.table-compare')
    expect(view.toggleRowNumbers()).toBe(false)
    expect(root.classList.contains('tc-hide-row-numbers')).toBe(true)

    // 節點若被移除，td[0] 就變成第一欄資料，所有以索引為準的查找都會錯一格。
    const tr = host.querySelector('.tc-row')
    expect(tr.querySelector('.tc-row-num')).not.toBeNull()
    expect(view.getCellValue('left', 0, 0)).toBe('0')

    expect(view.toggleRowNumbers()).toBe(true)
    expect(root.classList.contains('tc-hide-row-numbers')).toBe(false)
  })

  it('列號隱藏時，儲存格編輯仍寫到正確的欄', () => {
    view.setLeft('a.csv', csv(5))
    view.setRight('b.csv', csv(5))
    view.setRowNumbersVisible(false)

    expect(view.editCell('left', 1, 1, 'renamed')).toBe(true)
    expect(view.getCellValue('left', 1, 1)).toBe('renamed')
    expect(view.getCellValue('left', 1, 0)).toBe('1')
  })

  it('工具列上有入口，狀態反映在按鈕上', () => {
    const btn = host.querySelector('#tc-btn-row-numbers')
    expect(btn).not.toBeNull()
    expect(btn.classList.contains('active')).toBe(true)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(btn.classList.contains('active')).toBe(false)
  })

  it('設定會被 getConfig / applyConfig 帶走', () => {
    view.setRowNumbersVisible(false)
    const cfg = view.getConfig()
    expect(cfg.showRowNumbers).toBe(false)

    view.setRowNumbersVisible(true)
    view.applyConfig(cfg)
    expect(view.isRowNumbersVisible()).toBe(false)
  })
})

describe('Explorer', () => {
  it('用既有的 showInExplorer IPC 顯示該側檔案', async () => {
    view.setLeft('/tmp/a.csv', csv(3))
    expect(await view.revealInExplorer('left')).toBe(true)
    expect(window.electronAPI.showInExplorer).toHaveBeenCalledWith('/tmp/a.csv')
  })

  it('壓縮檔內容與遠端路徑會被擋下並說明原因，不是靜默失敗', async () => {
    const errors = []
    view.on('status', (p) => { if (p.level === 'error') errors.push(p.message) })

    view.setLeft('/tmp/pack.zip::inner.csv', csv(3))
    expect(await view.revealInExplorer('left')).toBe(false)
    view.setLeft('remote://host/a.csv', csv(3))
    expect(await view.revealInExplorer('left')).toBe(false)

    expect(window.electronAPI.showInExplorer).not.toHaveBeenCalled()
    expect(errors).toHaveLength(2)
  })

  it('IPC 失敗時把原因告訴使用者', async () => {
    const errors = []
    view.on('status', (p) => { if (p.level === 'error') errors.push(p.message) })
    window.electronAPI.showInExplorer = vi.fn(async () => { throw new Error('EACCES') })

    view.setLeft('/tmp/a.csv', csv(3))
    expect(await view.revealInExplorer('left')).toBe(false)
    expect(errors.join()).toContain('EACCES')
  })

  it('路徑列上兩側各有一個入口', () => {
    expect(host.querySelector('#tc-btn-explorer-left')).not.toBeNull()
    expect(host.querySelector('#tc-btn-explorer-right')).not.toBeNull()
  })
})

describe('儲存格 Cut / Paste / Delete', () => {
  it('剪下先複製成功才清空', async () => {
    view.setLeft('a.csv', csv(5))
    view.setRight('b.csv', csv(5))
    view.selectCell('left', 0, 1)

    expect(await view.cutCell()).toBe(true)
    expect(clipboard.writeText).toHaveBeenCalledWith('name0')
    expect(view.getCellValue('left', 0, 1)).toBe('')
  })

  it('複製失敗時不清空——否則剪下就等於資料消失', async () => {
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'))
    view.setLeft('a.csv', csv(5))
    view.setRight('b.csv', csv(5))
    view.selectCell('left', 0, 1)

    expect(await view.cutCell()).toBe(false)
    expect(view.getCellValue('left', 0, 1)).toBe('name0')
  })

  it('貼上寫入模型並可還原', async () => {
    view.setLeft('a.csv', csv(5))
    view.setRight('b.csv', csv(5))
    view.selectCell('left', 2, 1)

    expect(await view.pasteCell()).toBe(true)
    expect(view.getCellValue('left', 2, 1)).toBe('pasted')
    view.undo()
    expect(view.getCellValue('left', 2, 1)).toBe('name2')
  })

  it('清除整個選取範圍只算一步 undo', () => {
    view.setLeft('a.csv', csv(200))
    view.setRight('b.csv', csv(200))
    view.selectAll('left')

    expect(view.deleteCell()).toBe(true)
    expect(view.getCellValue('left', 0, 1)).toBe('')
    expect(view.getCellValue('left', 150, 2)).toBe('')

    expect(view.undo()).toBe(true)
    expect(view.getCellValue('left', 0, 1)).toBe('name0')
    expect(view.getCellValue('left', 150, 2)).toBe('150')
    expect(view.canUndo()).toBe(false)
  })

  it('批次清除的還原以列物件為準，插入列之後不會改到沒被碰過的列', () => {
    view.setLeft('a.csv', csv(10))
    view.setRight('b.csv', csv(10))

    view.selectCell('left', 5, 1)
    view.extendSelectionTo('left', 6, 1)
    expect(view.deleteCell()).toBe(true)

    // 在被清除的列上方插入，會讓當初記下的列索引全部往下位移一格。
    view.insertRow('left', 0, 'above')
    view.undo() // 復原插入
    view.undo() // 復原批次清除

    expect(view.getCellValue('left', 5, 1)).toBe('name5')
    expect(view.getCellValue('left', 6, 1)).toBe('name6')
    expect(view.getCellValue('left', 7, 1)).toBe('name7')
  })

  it('沒有選取時說明原因，而不是無聲無息', () => {
    const errors = []
    view.on('status', (p) => { if (p.level === 'error') errors.push(p.message) })
    view.setLeft('a.csv', csv(5))
    expect(view.deleteCell()).toBe(false)
    expect(errors.join()).toContain('沒有選取')
  })
})

describe('Next / Previous Edit', () => {
  it('依可見順序在編輯過的列之間移動', () => {
    view.setLeft('a.csv', csv(60))
    view.setRight('b.csv', csv(60))

    view.editCell('left', 10, 1, 'ten')
    view.editCell('left', 40, 1, 'forty')

    expect(view.getEditedRows()).toEqual([10, 40])

    view.selectCell('left', 0, 1)
    expect(view.nextEdit()).toBe(true)
    expect(view.getSelectedCell().visibleRowIdx).toBe(10)
    expect(view.nextEdit()).toBe(true)
    expect(view.getSelectedCell().visibleRowIdx).toBe(40)
    // 走到底之後環繞，和其他視圖的差異導航一致。
    expect(view.nextEdit()).toBe(true)
    expect(view.getSelectedCell().visibleRowIdx).toBe(10)

    expect(view.prevEdit()).toBe(true)
    expect(view.getSelectedCell().visibleRowIdx).toBe(40)
  })

  it('插入列讓索引位移之後，仍然指向原本那一列', () => {
    view.setLeft('a.csv', csv(20))
    view.setRight('b.csv', csv(20))

    view.editCell('left', 15, 1, 'edited')
    view.insertRow('left', 0, 'above')

    // 位移後那一列的可見索引變了（15 → 16），但指到的內容必須還是同一列；
    // 插入的空白列本身也算一處編輯。
    const rows = view.getEditedRows()
    expect(rows).toHaveLength(2)
    expect(view.getCellValue('left', rows[1], 1)).toBe('edited')
  })

  it('沒有任何編輯時按鈕是停用的，也不會假裝跳到什麼地方', () => {
    view.setLeft('a.csv', csv(5))
    view.setRight('b.csv', csv(5))
    expect(host.querySelector('#tc-btn-next-edit').disabled).toBe(true)
    expect(view.nextEdit()).toBe(false)

    view.editCell('left', 1, 1, 'x')
    expect(host.querySelector('#tc-btn-next-edit').disabled).toBe(false)
  })
})

describe('顯示字級', () => {
  it('字級改變時列高與捲動高度同步——否則虛擬捲動會逐列偏移', () => {
    const ROWS = 20000
    view.setLeft('a.csv', csv(ROWS))
    view.setRight('b.csv', csv(ROWS))

    const spacer = () => host.querySelector('.tc-vs-spacer')
    expect(spacer().style.height).toBe(`${ROWS * 24}px`)

    view.setFontSize(18)
    expect(view.getFontSize()).toBe(18)
    expect(view._rowHeight).toBe(30)
    expect(spacer().style.height).toBe(`${ROWS * 30}px`)

    const root = host.querySelector('.table-compare')
    expect(root.style.getPropertyValue('--tc-row-height')).toBe('30px')
    expect(root.style.getPropertyValue('--tc-font-size')).toBe('18px')
  })

  it('放大之後仍只渲染視窗內的列', () => {
    const ROWS = 20000
    view.setLeft('a.csv', csv(ROWS))
    view.setRight('b.csv', csv(ROWS))
    view.setFontSize(24)
    expect(host.querySelectorAll('.tc-row').length).toBeLessThan(200)
  })

  it('鉗制在 [10, 24]', () => {
    expect(view.setFontSize(2)).toBe(10)
    expect(view.setFontSize(99)).toBe(24)
    expect(view.resetFontSize()).toBe(12)
  })

  it('工具列上有入口，且設定會被 getConfig / applyConfig 帶走', () => {
    expect(host.querySelector('#tc-btn-font-larger')).not.toBeNull()
    host.querySelector('#tc-btn-font-larger').dispatchEvent(
      new MouseEvent('click', { bubbles: true }))
    expect(view.getFontSize()).toBe(13)

    const cfg = view.getConfig()
    view.resetFontSize()
    view.applyConfig(cfg)
    expect(view.getFontSize()).toBe(13)
  })
})

describe('右鍵選單入口', () => {
  it('選單裡有全選、剪貼、編輯導航與檔案總管', () => {
    view.setLeft('/tmp/a.csv', csv(10))
    view.setRight('/tmp/b.csv', csv(10))

    const td = host.querySelector('.tc-row .tc-cell')
    const ev = new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 })
    td.dispatchEvent(ev)

    const labels = [...document.querySelectorAll('.ctx-item')]
      .map((n) => n.textContent)
      .join(' | ')
    expect(labels).toContain('全選')
    expect(labels).toContain('剪下儲存格')
    expect(labels).toContain('貼上到儲存格')
    expect(labels).toContain('清除儲存格')
    expect(labels).toContain('下一處編輯')
    expect(labels).toContain('在檔案總管中顯示')
  })
})
