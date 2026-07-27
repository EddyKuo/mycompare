// @vitest-environment jsdom
/**
 * Sprint 18 — hex/table gap items from gap-matrix-v2.
 *
 * P0-5  Hex context menu "在檔案總管中顯示"
 * P1-9  Table over/under layout
 * P1-10 Hex copy-to-right / copy-to-left
 * P1-20 Hex HTML report
 * P2-27 Table print
 * P2-36 Hex show filter (all / diff / same)
 *
 * The virtual-scroll assertions deliberately use tens of thousands of rows: an
 * earlier regression in this project shipped a renderer that only ever saw
 * three-row fixtures and produced a hundred thousand DOM nodes in the field.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { HexCompare, bytesToLatin1 } from '../../src/renderer/src/views/hex-compare.js'
import { TableCompare } from '../../src/renderer/src/views/table-compare.js'
import { SettingsStore } from '../../src/renderer/src/core/settings-store.js'

/** @param {number[]|Uint8Array} arr */
const b64 = (arr) => btoa(bytesToLatin1(Uint8Array.from(arr)))

beforeEach(() => {
  new SettingsStore().setPref('navFirstDiffOnLoad', false)
  window.electronAPI = {
    showInExplorer: vi.fn(),
    saveFile: vi.fn().mockResolvedValue({ saved: true, path: '/b', backup: { backedUp: false } }),
    openFileBinary: vi.fn(),
    openFile: vi.fn(),
  }
  // jsdom implements neither; both report paths need them.
  URL.createObjectURL = vi.fn().mockReturnValue('blob:report')
  URL.revokeObjectURL = vi.fn()
})

/**
 * Mount a hex view on a detached host.
 * @param {number[]|Uint8Array} left
 * @param {number[]|Uint8Array} right
 * @param {number} [bytesPerRow]
 */
function mountHex(left, right, bytesPerRow = 16) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new HexCompare({ bytesPerRow })
  view.mount(host)
  view.setLeft('/left.bin', b64(left))
  view.setRight('/right.bin', b64(right))
  // setLeft/setRight schedule painting on rAF; the tests need the rows now.
  view._renderPaneContent('left')
  view._renderPaneContent('right')
  return { host, view }
}

// ── P0-5: Explorer entry in the hex context menu ──────────────────────────────

describe('P0-5 — Hex 右鍵選單「在檔案總管中顯示」', () => {
  /** @type {{host: HTMLElement, view: HexCompare}} */
  let h

  beforeEach(() => { h = mountHex([1, 2, 3, 4], [1, 9, 3, 4]) })
  afterEach(() => { h.view.destroy(); h.host.remove() })

  /** @param {'left'|'right'} side */
  const menuFor = (side) => {
    const row = h.host.querySelector(`.hx-pane[data-side="${side}"] .hx-row`)
    const event = new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 })
    Object.defineProperty(event, 'target', { value: row.querySelector('.hx-byte') })
    h.view._onHexContextMenu(event, side)
    return [...document.querySelectorAll('.ctx-item')].map((n) => n.textContent)
  }

  it('選單包含「在檔案總管中顯示」', () => {
    expect(menuFor('left')).toContain('在檔案總管中顯示')
  })

  it('點擊時以該側路徑呼叫 showInExplorer', () => {
    menuFor('right')
    const item = [...document.querySelectorAll('.ctx-item')]
      .find((n) => n.textContent === '在檔案總管中顯示')
    item.click()
    expect(window.electronAPI.showInExplorer).toHaveBeenCalledWith('/right.bin')
  })

  it('該側尚未載入檔案時停用', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new HexCompare({})
    view.mount(host)
    view.setLeft('/only-left.bin', b64([1, 2]))
    view._renderPaneContent('left')

    const row = host.querySelector('.hx-row')
    const event = new MouseEvent('contextmenu', { bubbles: true })
    Object.defineProperty(event, 'target', { value: row.querySelector('.hx-byte') })
    view._onHexContextMenu(event, 'right')

    const item = [...document.querySelectorAll('.ctx-item')]
      .find((n) => n.textContent === '在檔案總管中顯示')
    expect(item.classList.contains('ctx-item--disabled')).toBe(true)

    view.destroy()
    host.remove()
  })
})

// ── P2-36: show filter ────────────────────────────────────────────────────────

describe('P2-36 — Hex Show 篩選', () => {
  it('預設為 all，切換後回報生效的模式，非法值被忽略', () => {
    const view = new HexCompare({})
    expect(view.getShowFilter()).toBe('all')
    expect(view.setShowFilter('diff')).toBe('diff')
    expect(view.setShowFilter('nonsense')).toBe('diff')
    expect(view.setShowFilter('same')).toBe('same')
  })

  it('diff 模式只保留含差異的列；same 模式只保留完全相同的列', () => {
    // bytesPerRow 4 → 列 0 相同、列 1 有差異、列 2 相同、列 3 有差異
    const left = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]
    const right = [0, 0, 0, 0, 9, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 8]
    const { host, view } = mountHex(left, right, 4)

    view.setShowFilter('diff')
    expect([...view._filteredRows]).toEqual([1, 3])
    expect(view._visibleRowCount('left')).toBe(2)
    let offsets = [...host.querySelectorAll('.hx-pane[data-side="left"] .hx-offset')]
      .map((n) => n.textContent)
    expect(offsets).toEqual(['00000004', '0000000C'])

    view.setShowFilter('same')
    expect([...view._filteredRows]).toEqual([0, 2])
    offsets = [...host.querySelectorAll('.hx-pane[data-side="left"] .hx-offset')]
      .map((n) => n.textContent)
    expect(offsets).toEqual(['00000000', '00000008'])

    view.setShowFilter('all')
    expect(view._filteredRows).toBeNull()
    expect(view._visibleRowCount('left')).toBe(4)

    view.destroy()
    host.remove()
  })

  it('篩選後的列以視覺位置堆疊，捲動高度隨之縮短', () => {
    const left = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]
    const right = [0, 0, 0, 0, 9, 1, 1, 1, 2, 2, 2, 2]
    const { host, view } = mountHex(left, right, 4)
    view.setShowFilter('same')

    const inner = host.querySelector('.hx-pane[data-side="left"] .hx-inner')
    expect(inner.style.height).toBe('40px') // 2 visible rows × 20px
    const tops = [...inner.querySelectorAll('.hx-row')].map((n) => n.style.top)
    expect(tops).toEqual(['0px', '20px'])

    view.destroy()
    host.remove()
  })

  it('沒有符合的列時顯示空狀態而非留下錯誤的捲動高度', () => {
    const { host, view } = mountHex([1, 2, 3, 4], [9, 9, 9, 9], 4)
    view.setShowFilter('same')
    const inner = host.querySelector('.hx-pane[data-side="left"] .hx-inner')
    expect(inner.querySelector('.hx-empty-state')).not.toBeNull()
    expect(inner.querySelectorAll('.hx-row')).toHaveLength(0)
    view.destroy()
    host.remove()
  })

  it('goto offset 對應到篩選後的視覺位置', () => {
    const left = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]
    const right = [0, 0, 0, 0, 9, 1, 1, 1, 2, 2, 2, 2, 8, 3, 3, 3]
    const { host, view } = mountHex(left, right, 4)
    view.setShowFilter('diff')
    // Source rows 1 and 3 survive; offset 0x0C lives in source row 3 → visual 1.
    expect(view._visualIndexOf(3)).toBe(1)
    // A filtered-out row resolves to the next visible row rather than failing.
    expect(view._visualIndexOf(2)).toBe(1)
    view.destroy()
    host.remove()
  })
})

// ── Scale: the virtual scroller must stay virtual under every filter ──────────

describe('Hex 虛擬捲動 — 規模驗證', () => {
  /**
   * 512 KB per side with a difference every 64th row: 32768 rows, 512 of which
   * differ. Both filters therefore keep thousands of rows.
   */
  const SIZE = 512 * 1024
  const build = () => {
    const left = new Uint8Array(SIZE)
    const right = new Uint8Array(SIZE)
    for (let i = 0; i < SIZE; i++) { left[i] = i & 0xff; right[i] = i & 0xff }
    for (let row = 0; row < SIZE / 16; row += 64) right[row * 16] ^= 0xff
    return { left, right }
  }

  it.each(['all', 'diff', 'same'])('%s 模式只渲染可見列', (mode) => {
    const { left, right } = build()
    const { host, view } = mountHex(left, right, 16)
    view.setShowFilter(mode)

    const rows = host.querySelectorAll('.hx-pane[data-side="left"] .hx-row')
    // jsdom reports clientHeight 0, so the renderer falls back to a 300px
    // viewport: 15 visible rows plus 4 rows of overscan.
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(20)
    expect(host.querySelectorAll('.hx-row').length).toBeLessThanOrEqual(40)

    view.destroy()
    host.remove()
  })

  it('捲動後仍只保留視窗內的列，且列數不隨檔案大小增長', () => {
    const { left, right } = build()
    const { host, view } = mountHex(left, right, 16)
    const scroll = host.querySelector('.hx-pane[data-side="left"] .hx-scroll')

    for (const top of [0, 20_000, 400_000, 655_000]) {
      scroll.scrollTop = top
      view._renderVisibleRows('left', scroll)
      expect(host.querySelectorAll('.hx-pane[data-side="left"] .hx-row').length)
        .toBeLessThanOrEqual(20)
    }

    view.destroy()
    host.remove()
  })

  it('篩選計算不會為每列配置物件（Int32Array 大小等於可見列數）', () => {
    const { left, right } = build()
    const { host, view } = mountHex(left, right, 16)
    view.setShowFilter('diff')
    expect(view._filteredRows).toBeInstanceOf(Int32Array)
    expect(view._filteredRows.length).toBe(SIZE / 16 / 64)
    view.destroy()
    host.remove()
  })
})

// ── P1-10: copy bytes to the other side ───────────────────────────────────────

describe('P1-10 — Hex Copy to Right / Copy to Left', () => {
  it('spliceRegion 以來源位元組取代目標區段，長度依來源調整', () => {
    const target = new Uint8Array([1, 2, 3, 4, 5])
    const source = new Uint8Array([1, 9, 9, 4, 5])
    const out = HexCompare.spliceRegion(target, source, { start: 1, end: 3 })
    expect([...out]).toEqual([1, 9, 9, 4, 5])
  })

  it('spliceRegion 處理來源較長的尾端區段（孤兒 byte）', () => {
    const target = new Uint8Array([1, 2])
    const source = new Uint8Array([1, 2, 3, 4])
    const out = HexCompare.spliceRegion(target, source, { start: 2, end: 4 })
    expect([...out]).toEqual([1, 2, 3, 4])
  })

  it('spliceRegion 處理來源較短的尾端區段（截短目標）', () => {
    const target = new Uint8Array([1, 2, 3, 4])
    const source = new Uint8Array([1, 2])
    const out = HexCompare.spliceRegion(target, source, { start: 2, end: 4 })
    expect([...out]).toEqual([1, 2])
  })

  it('未選取差異區塊時拒絕並提示，不寫入磁碟', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const { host, view } = mountHex([1, 2], [1, 9])
    expect(await view.copyToRight()).toBe(false)
    expect(window.electronAPI.saveFile).not.toHaveBeenCalled()
    expect(alertSpy).toHaveBeenCalled()
    alertSpy.mockRestore()
    view.destroy(); host.remove()
  })

  it('使用者取消確認時不寫入', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { host, view } = mountHex([1, 2, 3], [1, 9, 3])
    view.firstDifference()
    expect(await view.copyToRight()).toBe(false)
    expect(window.electronAPI.saveFile).not.toHaveBeenCalled()
    view.destroy(); host.remove()
  })

  it('確認後以 binary 編碼與備份選項寫入目標路徑，並更新記憶體中的位元組', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { host, view } = mountHex([1, 2, 3], [1, 9, 3])
    view.firstDifference()
    expect(await view.copyToRight()).toBe(true)

    const [path, content, , encoding, backup] = window.electronAPI.saveFile.mock.calls[0]
    expect(path).toBe('/right.bin')
    expect(encoding).toBe('binary')
    expect(backup).toBe(true)
    expect([...content].map((c) => c.charCodeAt(0))).toEqual([1, 2, 3])
    expect([...view._rightBytes]).toEqual([1, 2, 3])
    expect(view.getDiffRegions()).toEqual([])

    view.destroy(); host.remove()
  })

  it('copyToLeft 走相反方向', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { host, view } = mountHex([1, 2, 3], [1, 9, 3])
    view.firstDifference()
    expect(await view.copyToLeft()).toBe(true)
    expect([...view._leftBytes]).toEqual([1, 9, 3])
    expect(window.electronAPI.saveFile.mock.calls[0][0]).toBe('/left.bin')
    view.destroy(); host.remove()
  })

  it('儲存對話框被取消（回傳 falsy）時不更新記憶體中的位元組', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.electronAPI.saveFile.mockResolvedValue(false)
    const { host, view } = mountHex([1, 2, 3], [1, 9, 3])
    view.firstDifference()
    expect(await view.copyToRight()).toBe(false)
    expect([...view._rightBytes]).toEqual([1, 9, 3])
    view.destroy(); host.remove()
  })

  it('IPC 拋出例外時回報給使用者而非靜默吞掉', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    window.electronAPI.saveFile.mockRejectedValue(new Error('EACCES'))
    const { host, view } = mountHex([1, 2, 3], [1, 9, 3])
    view.firstDifference()
    expect(await view.copyToRight()).toBe(false)
    expect(alertSpy.mock.calls[0][0]).toContain('EACCES')
    alertSpy.mockRestore()
    view.destroy(); host.remove()
  })

  it('bytesToLatin1 對超過參數上限的長度仍正確（不呼叫堆疊溢位）', () => {
    const big = new Uint8Array(200_000)
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff
    const s = bytesToLatin1(big)
    expect(s.length).toBe(big.length)
    expect(s.charCodeAt(0)).toBe(0)
    expect(s.charCodeAt(199_999)).toBe(199_999 & 0xff)
  })
})

// ── P1-20: hex HTML report ────────────────────────────────────────────────────

describe('P1-20 — Hex HTML 報告', () => {
  it('包含路徑、統計與每個差異區塊的兩側預覽', () => {
    const { host, view } = mountHex([1, 2, 3, 4], [1, 9, 9, 4])
    const html = view.buildHtmlReport({ generatedAt: new Date(0) })
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('/left.bin')
    expect(html).toContain('/right.bin')
    expect(html).toContain('0x00000001')
    expect(html).toContain('02 03')
    expect(html).toContain('09 09')
    expect(html).toContain('@media print')
    view.destroy(); host.remove()
  })

  it('兩側相同時說明無差異而非產生空表格', () => {
    const { host, view } = mountHex([1, 2], [1, 2])
    expect(view.buildHtmlReport()).toContain('兩側內容相同')
    view.destroy(); host.remove()
  })

  it('區塊數超過上限時註明省略數量', () => {
    const left = new Uint8Array(400)
    const right = new Uint8Array(400)
    for (let i = 0; i < 400; i += 2) right[i] = 0xff
    const { host, view } = mountHex(left, right, 16)
    const html = view.buildHtmlReport({ maxRegions: 10 })
    expect(html).toContain('另有 190 個差異區塊未列出')
    view.destroy(); host.remove()
  })

  it('escapes HTML 中的路徑', () => {
    const { host, view } = mountHex([1], [2])
    view._leftPath = '<script>x</script>'
    expect(view.buildHtmlReport()).toContain('&lt;script&gt;')
    view.destroy(); host.remove()
  })

  it('exportHtml() 預設寫入 hex-report.html', async () => {
    const { host, view } = mountHex([1], [2])
    await view.exportHtml()
    expect(window.electronAPI.saveFile.mock.calls[0][0]).toBe('hex-report.html')
    view.destroy(); host.remove()
  })

  it('exportHtml({print}) 開啟 blob 視窗並呼叫 print，不落地存檔', async () => {
    const printSpy = vi.fn()
    /** @type {Array<() => void>} */
    const loadHandlers = []
    vi.spyOn(window, 'open').mockReturnValue(
      { addEventListener: (_e, cb) => loadHandlers.push(cb), print: printSpy })
    const { host, view } = mountHex([1], [2])
    await view.exportHtml({ print: true })
    expect(window.electronAPI.saveFile).not.toHaveBeenCalled()
    loadHandlers.forEach((cb) => cb())
    expect(printSpy).toHaveBeenCalled()
    view.destroy(); host.remove()
  })

  it('彈出視窗被封鎖時退回存檔並告知使用者', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    vi.spyOn(window, 'open').mockReturnValue(null)
    const { host, view } = mountHex([1], [2])
    await view.exportHtml({ print: true })
    expect(window.electronAPI.saveFile).toHaveBeenCalled()
    expect(alertSpy).toHaveBeenCalled()
    alertSpy.mockRestore()
    view.destroy(); host.remove()
  })
})

// ── P1-9 / P2-27: table layout + print ────────────────────────────────────────

const LEFT_CSV = 'id,name\n1,Alice\n2,Bob'
const RIGHT_CSV = 'id,name\n1,Alice\n2,Bobby'

/** @param {string} [left] @param {string} [right] */
function mountTable(left = LEFT_CSV, right = RIGHT_CSV) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new TableCompare({ hasHeader: true, keyColumn: 0 })
  view.mount(host)
  view.setLeft('L.csv', left)
  view.setRight('R.csv', right)
  return { host, view }
}

describe('P1-9 — Table Over/Under 佈局', () => {
  it('預設 side-by-side，切換後在 .tc-body 加上 over-under', () => {
    const { host, view } = mountTable()
    const body = host.querySelector('.tc-body')
    expect(view.getLayoutMode()).toBe('side-by-side')
    expect(body.classList.contains('over-under')).toBe(false)

    expect(view.toggleLayout()).toBe('over-under')
    expect(body.classList.contains('over-under')).toBe(true)
    expect(view.toggleLayout()).toBe('side-by-side')
    expect(body.classList.contains('over-under')).toBe(false)

    view.destroy(); host.remove()
  })

  it('按鈕文字在 ⬛ Side ↔ ⊟ Over 之間切換', () => {
    const { host, view } = mountTable()
    const btn = host.querySelector('#tc-btn-layout')
    expect(btn.textContent).toBe('⬛ Side')
    btn.click()
    expect(btn.textContent).toBe('⊟ Over')
    expect(view.getLayoutMode()).toBe('over-under')
    btn.click()
    expect(btn.textContent).toBe('⬛ Side')
    view.destroy(); host.remove()
  })

  it('setLayoutMode 忽略非法值', () => {
    const { host, view } = mountTable()
    expect(view.setLayoutMode('diagonal')).toBe('side-by-side')
    expect(view.setLayoutMode('over-under')).toBe('over-under')
    view.destroy(); host.remove()
  })

  it('佈局隨 getConfig / applyConfig 往返', () => {
    const a = mountTable()
    a.view.setLayoutMode('over-under')
    const b = mountTable()
    b.view.applyConfig(a.view.getConfig())
    expect(b.view.getLayoutMode()).toBe('over-under')
    expect(b.host.querySelector('.tc-body').classList.contains('over-under')).toBe(true)
    a.view.destroy(); a.host.remove()
    b.view.destroy(); b.host.remove()
  })

  it('切換佈局後仍只渲染可見列（20000 列輸入）', () => {
    const rows = 20_000
    const left = ['id,v']
    const right = ['id,v']
    for (let i = 0; i < rows; i++) {
      left.push(`${i},${i}`)
      right.push(`${i},${i % 7 === 0 ? i + 1 : i}`)
    }
    const { host, view } = mountTable(left.join('\n'), right.join('\n'))
    expect(view._visibleRows.length).toBe(rows)

    const before = host.querySelectorAll('.tc-pane .tc-row').length
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThan(200)

    view.toggleLayout()
    const after = host.querySelectorAll('.tc-pane .tc-row').length
    expect(after).toBeGreaterThan(0)
    expect(after).toBeLessThan(200)

    view.destroy(); host.remove()
  })
})

describe('P2-27 — Table 列印', () => {
  it('buildHtmlReport 產出含 @media print 的自足 HTML', () => {
    const { host, view } = mountTable()
    const html = view.buildHtmlReport()
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('@media print')
    expect(html).toContain('thead { display: table-header-group; }')
    expect(html).toContain('Bobby')
    view.destroy(); host.remove()
  })

  it('exportHtml() 仍寫入 table-report.html', async () => {
    const { host, view } = mountTable()
    await view.exportHtml()
    expect(window.electronAPI.saveFile.mock.calls[0][0]).toBe('table-report.html')
    view.destroy(); host.remove()
  })

  it('🖨 列印按鈕開啟 blob 視窗並呼叫 print，不落地存檔', async () => {
    const printSpy = vi.fn()
    /** @type {Array<() => void>} */
    const loadHandlers = []
    vi.spyOn(window, 'open').mockReturnValue(
      { addEventListener: (_e, cb) => loadHandlers.push(cb), print: printSpy })
    const { host, view } = mountTable()
    await view.exportHtml({ print: true })
    expect(window.electronAPI.saveFile).not.toHaveBeenCalled()
    loadHandlers.forEach((cb) => cb())
    expect(printSpy).toHaveBeenCalled()
    view.destroy(); host.remove()
  })

  it('彈出視窗被封鎖時退回存檔並告知使用者', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    vi.spyOn(window, 'open').mockReturnValue(null)
    const { host, view } = mountTable()
    await view.exportHtml({ print: true })
    expect(window.electronAPI.saveFile).toHaveBeenCalled()
    expect(alertSpy).toHaveBeenCalled()
    alertSpy.mockRestore()
    view.destroy(); host.remove()
  })
})
