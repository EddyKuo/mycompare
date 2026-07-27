// @vitest-environment jsdom
/**
 * P2-40 / P2-41 — Hex Details / File Info / Ruler，以及表格的 Text Details、
 * File Info、逐欄顯示切換、Visible Whitespace 與 Ignored Columns。
 *
 * 數值解讀是本檔的重點：hex 面板宣稱能把游標下的位元組讀成 18 種型別，一個
 * 錯掉的位元組序或補數就會讓使用者相信一個檔案裡根本不存在的數字。因此每一
 * 種型別都以邊界值驗證（最大 / 最小 / 補數負數 / 非正規化浮點 / NaN / -0），
 * 並且明確驗證「位元組不足以構成該型別時要說明，而不是從補零的緩衝區亂讀」。
 *
 * 兩個視圖都是虛擬捲動的，所以每一組面板都在數萬列的資料上再驗一次「只渲染
 * 可見列」。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  HexCompare,
  hexDetailRows,
  rulerCells,
  bytesToLatin1,
} from '../../src/renderer/src/views/hex-compare.js'
import {
  TableCompare,
  visibleWhitespace,
  mergeIgnoredColumns,
  toColumnList,
  describeDelimiter,
} from '../../src/renderer/src/views/table-compare.js'
import { SettingsStore } from '../../src/renderer/src/core/settings-store.js'

/** @param {number[]|Uint8Array} arr */
const b64 = (arr) => btoa(bytesToLatin1(Uint8Array.from(arr)))

/**
 * @param {number[]} arr
 * @param {number} offset
 * @returns {Record<string, string>} key → value，方便逐型別斷言
 */
function detailMap(arr, offset = 0) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const row of hexDetailRows(Uint8Array.from(arr), offset)) out[row.key] = row.value
  return out
}

/**
 * @param {number[]} arr
 * @param {number} offset
 * @returns {Record<string, boolean>}
 */
function availabilityMap(arr, offset = 0) {
  /** @type {Record<string, boolean>} */
  const out = {}
  for (const row of hexDetailRows(Uint8Array.from(arr), offset)) out[row.key] = row.available
  return out
}

/** @type {HTMLElement[]} */
let hosts = []
/** @type {Array<HexCompare|TableCompare>} */
let views = []

beforeEach(() => {
  new SettingsStore().setPref('navFirstDiffOnLoad', false)
  window.electronAPI = /** @type {never} */ ({
    saveFile: vi.fn().mockResolvedValue({ saved: true, path: '/out', backup: { backedUp: false } }),
    readDir: vi.fn().mockResolvedValue([]),
    openFile: vi.fn(),
    openFileBinary: vi.fn(),
    readExcel: vi.fn(),
    showInExplorer: vi.fn(),
  })
  window.alert = vi.fn()
  window.confirm = vi.fn().mockReturnValue(true)
})

afterEach(() => {
  for (const v of views) v.destroy()
  for (const h of hosts) h.remove()
  views = []
  hosts = []
  vi.unstubAllGlobals()
  delete window.electronAPI
})

/**
 * @param {Uint8Array|number[]} left
 * @param {Uint8Array|number[]} right
 * @param {object} [opts]
 * @returns {HexCompare}
 */
function mountHex(left, right, opts = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new HexCompare(opts)
  view.mount(host)
  view.setLeft('C:/tmp/left.bin', b64(left))
  view.setRight('C:/tmp/right.bin', b64(right))
  view._renderPaneContent('left')
  view._renderPaneContent('right')
  hosts.push(host)
  views.push(view)
  return view
}

/**
 * @param {string} leftCsv
 * @param {string} rightCsv
 * @param {object} [opts]
 * @returns {TableCompare}
 */
function mountTable(leftCsv, rightCsv, opts = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new TableCompare(opts)
  view.mount(host)
  view.setLeft('C:/tmp/left.csv', leftCsv)
  view.setRight('C:/tmp/right.csv', rightCsv)
  hosts.push(host)
  views.push(view)
  return view
}

// ── hexDetailRows — 整數邊界值與補數 ─────────────────────────────────────────

describe('hexDetailRows — 整數邊界值', () => {
  it('int8 / uint8 的兩端：0x7F、0x80、0xFF', () => {
    expect(detailMap([0x7f]).int8).toBe('127')
    expect(detailMap([0x7f]).uint8).toBe('127')
    // 0x80 是 int8 的最小值，同時是 uint8 的 128 —— 補數的分水嶺
    expect(detailMap([0x80]).int8).toBe('-128')
    expect(detailMap([0x80]).uint8).toBe('128')
    expect(detailMap([0xff]).int8).toBe('-1')
    expect(detailMap([0xff]).uint8).toBe('255')
  })

  it('int16：0xFFFF 是 -1，0x8000 是最小值，且大小端互為鏡像', () => {
    const all = detailMap([0xff, 0xff])
    expect(all.int16le).toBe('-1')
    expect(all.int16be).toBe('-1')
    expect(all.uint16le).toBe('65535')

    // 位元組序 00 80：LE 讀成 0x8000（最小值），BE 讀成 0x0080（128）
    const m = detailMap([0x00, 0x80])
    expect(m.int16le).toBe('-32768')
    expect(m.int16be).toBe('128')
    expect(m.uint16le).toBe('32768')
    expect(m.uint16be).toBe('128')
  })

  it('int32：最小值、最大值與 uint32 上限', () => {
    const min = detailMap([0x00, 0x00, 0x00, 0x80])
    expect(min.int32le).toBe('-2147483648')
    expect(min.uint32le).toBe('2147483648')
    expect(min.int32be).toBe('128')

    const max = detailMap([0xff, 0xff, 0xff, 0x7f])
    expect(max.int32le).toBe('2147483647')

    const ones = detailMap([0xff, 0xff, 0xff, 0xff])
    expect(ones.int32le).toBe('-1')
    expect(ones.uint32le).toBe('4294967295')
  })

  it('int64 / uint64 以 BigInt 精確表示，不因 double 精度而失真', () => {
    const min = detailMap([0, 0, 0, 0, 0, 0, 0, 0x80])
    expect(min.int64le).toBe('-9223372036854775808')
    expect(min.uint64le).toBe('9223372036854775808')

    const max = detailMap([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])
    expect(max.int64le).toBe('9223372036854775807')

    const ones = detailMap([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    expect(ones.int64le).toBe('-1')
    // Number 只有 53 位尾數；這個值只有 BigInt 才寫得出來
    expect(ones.uint64le).toBe('18446744073709551615')
  })
})

// ── hexDetailRows — 浮點邊界值 ────────────────────────────────────────────────

describe('hexDetailRows — 浮點邊界值', () => {
  it('float32 非正規化最小值（denormal）', () => {
    // BE 00 00 00 01 = 2^-149，IEEE-754 的最小非零 float32
    expect(detailMap([0x00, 0x00, 0x00, 0x01]).float32be).toBe('1.401298464324817e-45')
  })

  it('float32 最小正規化值與最大值', () => {
    expect(detailMap([0x00, 0x80, 0x00, 0x00]).float32be).toBe('1.1754943508222875e-38')
    expect(detailMap([0x7f, 0x7f, 0xff, 0xff]).float32be).toBe('3.4028234663852886e+38')
  })

  it('float32 的 NaN、±Infinity 與 -0 不會被印成普通數字', () => {
    expect(detailMap([0x7f, 0xc0, 0x00, 0x00]).float32be).toBe('NaN')
    expect(detailMap([0x7f, 0x80, 0x00, 0x00]).float32be).toBe('+Infinity')
    expect(detailMap([0xff, 0x80, 0x00, 0x00]).float32be).toBe('-Infinity')
    // -0 與 0 的差別只在符號位，正是十六進位檢視器要看的那一位
    expect(detailMap([0x80, 0x00, 0x00, 0x00]).float32be).toBe('-0')
    expect(detailMap([0x00, 0x00, 0x00, 0x00]).float32be).toBe('0')
  })

  it('float64 非正規化最小值、最大值與 Infinity', () => {
    expect(detailMap([0, 0, 0, 0, 0, 0, 0, 1]).float64be).toBe('5e-324')
    expect(detailMap([0x7f, 0xef, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).float64be)
      .toBe('1.7976931348623157e+308')
    expect(detailMap([0x7f, 0xf0, 0, 0, 0, 0, 0, 0]).float64be).toBe('+Infinity')
  })

  it('float64 大小端不同讀法給出不同結果', () => {
    const m = detailMap([0x3f, 0xf0, 0, 0, 0, 0, 0, 0])
    expect(m.float64be).toBe('1')
    expect(m.float64le).not.toBe('1')
  })
})

// ── hexDetailRows — 位元組不足 ───────────────────────────────────────────────

describe('hexDetailRows — 位元組不足時說明而非亂讀', () => {
  it('單一位元組的檔案：只有 1-byte 型別可讀，其餘皆標記為不可用', () => {
    const avail = availabilityMap([0xab])
    expect(avail.int8).toBe(true)
    expect(avail.uint8).toBe(true)
    for (const key of ['int16le', 'int32be', 'float32le', 'float64be', 'uint64le']) {
      expect(avail[key]).toBe(false)
    }
    // 補零緩衝區會讀成 0xAB00 / 0x00AB 之類的假值——必須是說明文字
    const m = detailMap([0xab])
    expect(m.int16le).toContain('需要 2 位元組')
    expect(m.int16le).toContain('只剩 1')
    expect(m.float64be).toContain('需要 8 位元組')
  })

  it('剩 4 個位元組時 float32 可讀、float64 不可讀', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7]
    // 從 offset 3 起算只剩 4 個位元組
    const avail = availabilityMap(arr, 3)
    expect(avail.float32le).toBe(true)
    expect(avail.int32be).toBe(true)
    expect(avail.float64le).toBe(false)
    expect(avail.int64be).toBe(false)
    expect(detailMap(arr, 3).int64le).toContain('只剩 4')
  })

  it('offset 落在資料之外時回傳空清單，而不是讀第 0 個位元組', () => {
    expect(hexDetailRows(Uint8Array.from([1, 2, 3]), 3)).toEqual([])
    expect(hexDetailRows(Uint8Array.from([1, 2, 3]), -1)).toEqual([])
    expect(hexDetailRows(new Uint8Array(0), 0)).toEqual([])
    expect(hexDetailRows(null, 0)).toEqual([])
  })

  it('只讀取 offset 之後的位元組，不會回頭讀前面的資料', () => {
    // 前面全是 0xFF，從 offset 4 起是 01 00 00 00
    const m = detailMap([0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0x00, 0x00], 4)
    expect(m.int32le).toBe('1')
    expect(m.uint8).toBe('1')
  })
})

// ── hexDetailRows — 位元、八進位、字元 ───────────────────────────────────────

describe('hexDetailRows — 位元 / 八進位 / 字元', () => {
  it('二進位補滿 8 位並以半位元組分組', () => {
    expect(detailMap([0x00]).binary).toBe('0000 0000')
    expect(detailMap([0xff]).binary).toBe('1111 1111')
    expect(detailMap([0x5a]).binary).toBe('0101 1010')
  })

  it('八進位補滿 3 位', () => {
    expect(detailMap([0]).octal).toBe('0o000')
    expect(detailMap([0xff]).octal).toBe('0o377')
  })

  it('可列印字元顯示字元本身，控制字元與非 ASCII 明講是什麼', () => {
    expect(detailMap([0x41]).char).toBe("'A'")
    expect(detailMap([0x20]).char).toBe("' '")
    expect(detailMap([0x00]).char).toContain('控制字元')
    expect(detailMap([0x7f]).char).toContain('DEL')
    expect(detailMap([0xe4]).char).toContain('非 ASCII')
  })

  it('hex 欄位一律兩位大寫', () => {
    expect(detailMap([0x0a]).hex).toBe('0x0A')
  })
})

// ── rulerCells ───────────────────────────────────────────────────────────────

describe('rulerCells', () => {
  it('16 位元組一列：hex 標籤 00–0F，ASCII 標籤同為單一 nibble', () => {
    const { hex, ascii } = rulerCells(16)
    expect(hex).toHaveLength(16)
    expect(hex[0]).toBe('00')
    expect(hex[15]).toBe('0F')
    expect(ascii[15]).toBe('F')
  })

  it('32 位元組一列：hex 標籤延伸到 1F，ASCII 標籤在 16 處繞回', () => {
    const { hex, ascii } = rulerCells(32)
    expect(hex[31]).toBe('1F')
    expect(ascii[16]).toBe('0')
    expect(ascii[31]).toBe('F')
  })

  it('0 或無效輸入不會爆炸', () => {
    expect(rulerCells(0).hex).toEqual([])
    expect(rulerCells(NaN).hex).toEqual([])
  })
})

// ── Hex 視圖：面板與標尺 ─────────────────────────────────────────────────────

describe('P2-40 Hex 視圖 — Details / File Info / Ruler', () => {
  it('三個面板預設關閉，且切換鈕會改變狀態', () => {
    const view = mountHex([1, 2, 3, 4], [1, 2, 3, 5])
    expect(view.isDetailsVisible()).toBe(false)
    expect(view.isFileInfoVisible()).toBe(false)
    expect(view.isRulerVisible()).toBe(false)

    view._dom.btnDetails.click()
    view._dom.btnFileInfo.click()
    view._dom.btnRuler.click()
    expect(view.isDetailsVisible()).toBe(true)
    expect(view.isFileInfoVisible()).toBe(true)
    expect(view.isRulerVisible()).toBe(true)
    expect(view._dom.ruler_left.style.display).not.toBe('none')
  })

  it('Details 面板跟著游標走，並顯示該位元組的解讀值', () => {
    const view = mountHex([0x00, 0x80], [0x00, 0x00])
    view.setDetailsVisible(true)
    view._moveCursorTo('left', 0, 'hex')

    const text = view._dom.detailsBody.textContent
    expect(text).toContain('int16 (LE)')
    expect(text).toContain('-32768')
    expect(text).toContain('offset 0x00000000')

    view._moveCursorTo('left', 1, 'hex')
    expect(view._dom.detailsBody.textContent).toContain('offset 0x00000001')
    // offset 1 起只剩 1 個位元組，int16 必須說明而不是亂讀
    expect(view._dom.detailsBody.textContent).toContain('需要 2 位元組')
  })

  it('沒有游標時顯示提示，而不是空白面板', () => {
    const view = mountHex([1, 2], [1, 2])
    view.setDetailsVisible(true)
    expect(view._dom.detailsBody.textContent).toContain('點選任一位元組')
  })

  it('File Info 顯示大小、差異位元組數與截斷狀態', () => {
    const view = mountHex([1, 2, 3, 4], [1, 9, 3, 4])
    view.setFileInfoVisible(true)
    const text = view._dom.fileInfoBody.textContent
    expect(text).toContain('C:/tmp/left.bin')
    expect(text).toContain('C:/tmp/right.bin')
    expect(text).toContain('差異位元組')
    expect(text).toContain('截斷')
    expect(view.getStats().diffBytes).toBeGreaterThan(0)
  })

  it('標尺欄數跟隨 bytes-per-row', () => {
    const view = mountHex([1, 2, 3, 4], [1, 2, 3, 4], { bytesPerRow: 16 })
    view.setRulerVisible(true)
    expect(view._dom.ruler_left.querySelectorAll('.hx-ruler-cell')).toHaveLength(32) // hex + ascii

    view._dom.bprSelect.value = '32'
    view._dom.bprSelect.dispatchEvent(new Event('change'))
    expect(view._dom.ruler_left.querySelectorAll('.hx-ruler-cell')).toHaveLength(64)
  })

  it('面板狀態進出 getConfig / applyConfig', () => {
    const a = mountHex([1], [1])
    a.setDetailsVisible(true)
    a.setRulerVisible(true)
    const b = mountHex([1], [1])
    b.applyConfig(a.getConfig())
    expect(b.isDetailsVisible()).toBe(true)
    expect(b.isRulerVisible()).toBe(true)
    expect(b.isFileInfoVisible()).toBe(false)
  })

  it('數萬列的資料開著全部面板時，仍然只渲染可見列', () => {
    // 30 000 列 × 16 bytes；若每列都建 DOM，這裡會有三萬個節點
    const size = 16 * 30_000
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = i & 0xff
    const view = mountHex(data, data, { bytesPerRow: 16 })
    view.setDetailsVisible(true)
    view.setFileInfoVisible(true)
    view.setRulerVisible(true)

    const inner = view._dom.inner_left
    expect(view._totalRows('left')).toBe(30_000)
    expect(inner.querySelectorAll('.hx-row').length).toBeLessThan(60)

    // 捲到中段後仍然只有一窗的列
    const scroll = view._dom.scroll_left
    scroll.scrollTop = 15_000 * 20
    view._renderPaneContent('left')
    expect(inner.querySelectorAll('.hx-row').length).toBeLessThan(60)

    // 標尺是每個 pane 一份，不是每列一份
    expect(view._dom.root.querySelectorAll('.hx-ruler')).toHaveLength(2)
  })

  it('行內編輯後 Details 面板反映新的位元組值', () => {
    const view = mountHex([0x01, 0x00], [0x00, 0x00])
    view.setDetailsVisible(true)
    view.setEditMode(true)
    view._moveCursorTo('left', 0, 'hex')
    expect(view.overwriteBytes('left', 0, [0xff])).toBe(true)
    const text = view._dom.detailsBody.textContent
    expect(text).toContain('0xFF')
    expect(text).toContain('-1')
  })
})

// ── 表格：純函式 ─────────────────────────────────────────────────────────────

describe('P2-41 表格純函式', () => {
  it('visibleWhitespace 只替換空格與 Tab', () => {
    expect(visibleWhitespace('a b\tc')).toBe('a·b→c')
    expect(visibleWhitespace('  ')).toBe('··')
    expect(visibleWhitespace('')).toBe('')
    expect(visibleWhitespace(null)).toBe('')
    // 非空白字元原封不動
    expect(visibleWhitespace('中文·→')).toBe('中文·→')
  })

  it('mergeIgnoredColumns 把排除欄位投影成 ignore 規則', () => {
    const merged = mergeIgnoredColumns({ 1: { mode: 'numeric', tolerance: 0.5 } }, [1, 3])
    expect(merged[1]).toEqual({ mode: 'ignore', tolerance: 0 })
    expect(merged[3]).toEqual({ mode: 'ignore', tolerance: 0 })
    expect(merged[0]).toBeUndefined()
  })

  it('mergeIgnoredColumns 保留未被排除的規則', () => {
    const merged = mergeIgnoredColumns({ 0: { mode: 'date', tolerance: 60 } }, [])
    expect(merged[0]).toEqual({ mode: 'date', tolerance: 60 })
  })

  it('toColumnList 去重、排序並丟掉無效值', () => {
    expect(toColumnList([3, 1, 1, -2, 'x', 2.5, '2'])).toEqual([1, 2, 3])
    expect(toColumnList(null)).toEqual([])
    expect(toColumnList(5)).toEqual([5])
  })

  it('describeDelimiter 讀得懂 Tab', () => {
    expect(describeDelimiter('\t')).toBe('Tab')
    expect(describeDelimiter(',')).toContain(',')
  })
})

// ── 表格：欄位顯示 / 排除 ────────────────────────────────────────────────────

describe('P2-41 表格 — Columns 顯示 / 隱藏 / 排除', () => {
  const LEFT = 'id,name,note\n1,alice,aaa\n2,bob,bbb\n'
  const RIGHT = 'id,name,note\n1,alice,XXX\n2,bob,bbb\n'

  it('隱藏欄位只影響顯示，比對結果不變', () => {
    const view = mountTable(LEFT, RIGHT)
    expect(view.getStats().different).toBe(1)

    view.setColumnHidden(2, true)
    expect(view.getHiddenColumns()).toEqual([2])
    // 仍然是一列不同 —— 隱藏不是忽略
    expect(view.getStats().different).toBe(1)

    const hidden = view._dom.leftTbody.querySelectorAll('td.tc-col-hidden')
    expect(hidden.length).toBeGreaterThan(0)
    // DOM 節點保留，索引對應才不會錯位
    expect(view._dom.leftTbody.children[0].children).toHaveLength(4)
  })

  it('排除欄位同時退出比對與顯示', () => {
    const view = mountTable(LEFT, RIGHT)
    view.setColumnIgnored(2, true)
    expect(view.getIgnoredColumns()).toEqual([2])
    // 唯一的差異在第 2 欄，排除後兩表相同
    expect(view.getStats().different).toBe(0)
    expect(view.isColumnHidden(2)).toBe(true)
    expect(view._dom.leftTbody.querySelectorAll('td.tc-col-hidden').length).toBeGreaterThan(0)
  })

  it('取消排除後差異回來', () => {
    const view = mountTable(LEFT, RIGHT)
    view.setColumnIgnored(2, true)
    expect(view.getStats().different).toBe(0)
    view.setColumnIgnored(2, false)
    expect(view.getStats().different).toBe(1)
    expect(view.isColumnHidden(2)).toBe(false)
  })

  it('欄位設定面板的「顯示」與「排除」核取方塊可用，且排除會鎖住顯示', () => {
    const view = mountTable(LEFT, RIGHT)
    view.openColumnSettings()
    const rows = view._dom.colPanel.querySelectorAll('.tc-col-row')
    expect(rows.length).toBeGreaterThanOrEqual(3)

    const showBox = rows[2].querySelector('.tc-col-show')
    const skipBox = rows[2].querySelector('.tc-col-skip')
    showBox.checked = false
    showBox.dispatchEvent(new Event('change'))
    expect(view.getHiddenColumns()).toEqual([2])

    skipBox.checked = true
    skipBox.dispatchEvent(new Event('change'))
    expect(view.getIgnoredColumns()).toEqual([2])
    expect(showBox.disabled).toBe(true)
  })

  it('隱藏 / 排除欄位進出 getConfig / applyConfig', () => {
    const a = mountTable(LEFT, RIGHT)
    a.setColumnHidden(1, true)
    a.setColumnIgnored(2, true)
    const b = mountTable(LEFT, RIGHT)
    b.applyConfig(a.getConfig())
    expect(b.getHiddenColumns()).toEqual([1])
    expect(b.getIgnoredColumns()).toEqual([2])
    expect(b.getStats().different).toBe(0)
  })
})

// ── 表格：Visible Whitespace ─────────────────────────────────────────────────

describe('P2-41 表格 — Visible Whitespace', () => {
  const LEFT = 'a,b\n" x ",1\n'
  const RIGHT = 'a,b\n" x ",1\n'

  it('切換後儲存格顯示 · 與 →，關掉後還原', () => {
    const view = mountTable(LEFT, RIGHT)
    const cell = () => view._dom.leftTbody.children[0].children[1].textContent

    expect(cell()).toBe(' x ')
    view.toggleWhitespace()
    expect(view.isWhitespaceVisible()).toBe(true)
    expect(cell()).toBe('·x·')
    view.toggleWhitespace()
    expect(cell()).toBe(' x ')
  })

  it('開著空白字元時編輯儲存格，寫回的是原始值而不是 · 符號', () => {
    const view = mountTable(LEFT, RIGHT)
    view.setWhitespaceVisible(true)
    const td = view._dom.leftTbody.children[0].children[1]
    view._beginCellEdit('left', 0, 0, td)
    // 編輯器內是真值，不是顯示用的符號
    expect(view._editing.input.value).toBe(' x ')

    // 原值提交（不變更）後，模型仍是原始空白，不含 ·
    view._commitCellEdit()
    expect(view.getCellValue('left', 0, 0)).toBe(' x ')
    expect(view.hasUnsavedChanges()).toBe(false)
  })

  it('取消編輯會還原成顯示用的符號版本', () => {
    const view = mountTable(LEFT, RIGHT)
    view.setWhitespaceVisible(true)
    const td = view._dom.leftTbody.children[0].children[1]
    view._beginCellEdit('left', 0, 0, td)
    view._editing.input.value = 'zzz'
    view._cancelCellEdit()
    expect(td.textContent).toBe('·x·')
    expect(view.getCellValue('left', 0, 0)).toBe(' x ')
  })
})

// ── 表格：Text Details / File Info ───────────────────────────────────────────

describe('P2-41 表格 — Text Details / File Info 面板', () => {
  const LONG = 'x'.repeat(400)
  const LEFT = `id,note\n1,${LONG}\n`
  const RIGHT = 'id,note\n1,short\n'

  it('點選儲存格後 Details 顯示兩側完整內容', () => {
    const view = mountTable(LEFT, RIGHT)
    view.setDetailsVisible(true)
    view.selectCell('left', 0, 1)

    const text = view._dom.detailsBody.textContent
    expect(text).toContain(LONG)
    expect(text).toContain('short')
    expect(text).toContain('note')
    expect(text).toContain('400')
  })

  it('未選取時顯示提示', () => {
    const view = mountTable(LEFT, RIGHT)
    view.setDetailsVisible(true)
    expect(view._dom.detailsBody.textContent).toContain('點選任一儲存格')
  })

  it('點擊儲存格會設定選取並加上標記，重繪後標記仍在', () => {
    const view = mountTable(LEFT, RIGHT)
    view.setDetailsVisible(true)
    const td = view._dom.leftTbody.children[0].children[2]
    td.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.getSelectedCell()).toEqual({ side: 'left', visibleRowIdx: 0, col: 1 })
    expect(td.classList.contains('tc-cell--selected')).toBe(true)

    view._windowFirst = null
    view._windowLast = null
    view._renderTableWindow()
    expect(view._dom.leftTbody.children[0].children[2].classList.contains('tc-cell--selected'))
      .toBe(true)
  })

  it('孤兒列的另一側標記為「此側無此列」而不是空字串', () => {
    const view = mountTable('id,note\n1,a\n2,b\n', 'id,note\n1,a\n')
    view.setDetailsVisible(true)
    // 第 2 列只存在於左側
    view.selectCell('left', 1, 1)
    expect(view._dom.detailsBody.textContent).toContain('此側無此列')
  })

  it('File Info 顯示列數、欄數、分隔符與編碼', () => {
    const view = mountTable(LEFT, RIGHT)
    view.setEncoding('left', 'utf-8')
    view.setFileInfoVisible(true)
    const text = view._dom.fileInfoBody.textContent
    expect(text).toContain('C:/tmp/left.csv')
    expect(text).toContain('列數')
    expect(text).toContain('欄數')
    expect(text).toContain('utf-8')
    // 右側沒被告知編碼，必須說「未提供」而不是假裝知道
    expect(text).toContain('未提供')
  })

  it('read-dir 拿到 mtime 後補進面板', async () => {
    window.electronAPI.readDir = vi.fn().mockResolvedValue([
      { path: 'C:/tmp/left.csv', name: 'left.csv', size: 1234, mtime: '2024-01-02T03:04:05.000Z' },
    ])
    const view = mountTable(LEFT, RIGHT)
    view.setFileInfoVisible(true)
    await vi.waitFor(() => {
      expect(view._statCache.get('C:/tmp/left.csv')).toBeTruthy()
    })
    expect(view._dom.fileInfoBody.textContent).toContain('1.2 KB')
  })

  it('read-dir 失敗時把錯誤講出來，不靜默吞掉', async () => {
    const errors = []
    window.electronAPI.readDir = vi.fn().mockRejectedValue(new Error('EACCES'))
    const view = mountTable(LEFT, RIGHT)
    view.on('status', (payload) => errors.push(payload))
    view.setFileInfoVisible(true)
    await vi.waitFor(() => {
      expect(errors.some((e) => String(e.message).includes('EACCES'))).toBe(true)
    })
  })
})

// ── 表格：規模 ───────────────────────────────────────────────────────────────

describe('P2-41 表格 — 數萬列時面板不破壞虛擬捲動', () => {
  /** @returns {string} */
  function bigCsv(rows, marker) {
    const lines = ['id,name,note']
    for (let i = 0; i < rows; i++) lines.push(`${i},name${i},${marker}${i}`)
    return lines.join('\n')
  }

  it('50 000 列開著兩個面板與空白字元，仍然只渲染一窗的列', () => {
    const view = mountTable(bigCsv(50_000, 'a'), bigCsv(50_000, 'a'))
    view.setDetailsVisible(true)
    view.setFileInfoVisible(true)
    view.setWhitespaceVisible(true)

    expect(view._visibleRows.length).toBe(50_000)
    expect(view._dom.leftTbody.children.length).toBeLessThan(80)

    view._dom.leftScroll.scrollTop = 25_000 * 24
    view._windowFirst = null
    view._windowLast = null
    view._renderTableWindow()
    expect(view._dom.leftTbody.children.length).toBeLessThan(80)
  })

  it('隱藏欄位在數萬列下不會退化成整表重建', () => {
    const view = mountTable(bigCsv(50_000, 'a'), bigCsv(50_000, 'b'))
    view.setColumnHidden(2, true)
    expect(view._dom.leftTbody.children.length).toBeLessThan(80)
    // 每一列的欄位節點數不變（隱藏用 CSS，不刪節點）
    expect(view._dom.leftTbody.children[0].children).toHaveLength(4)
  })
})
