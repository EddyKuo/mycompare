// @vitest-environment jsdom
/**
 * BC View ▸ Current Byte Address / Little Endian Values / Big Endian Values.
 *
 * The readout's whole value is that the number it prints is the number in the
 * file. Three ways it could stop being that, each pinned here:
 *
 *  1. Byte order silently swapped — every width is checked against a
 *     hand-computed value in *both* orders, from the same bytes.
 *  2. A 64-bit value routed through a double — 2^53+1 and 2^63-1 are asserted
 *     exactly; a Number-based implementation prints ...992 and ...808 and fails.
 *  3. A type read past the end of the file out of a zero-padded scratch buffer —
 *     the short-buffer cases assert the row is marked unavailable and carries no
 *     digits at all.
 *
 * The DOM half checks the three switches actually reach the rendered panel and
 * survive getConfig / applyConfig, because a toggle nothing reads is this
 * project's signature defect.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  HexCompare,
  hexDetailRows,
  hexAddressRows,
  hexReadoutRows,
  bytesToLatin1,
} from '../../src/renderer/src/views/hex-compare.js'
import { SettingsStore } from '../../src/renderer/src/core/settings-store.js'

/** @param {number[]|Uint8Array} arr */
const b64 = (arr) => btoa(bytesToLatin1(Uint8Array.from(arr)))

/**
 * @param {number[]} arr
 * @param {number} [offset]
 * @returns {Record<string, string>}
 */
function values(arr, offset = 0) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const row of hexDetailRows(Uint8Array.from(arr), offset)) out[row.key] = row.value
  return out
}

/**
 * @param {number[]} arr
 * @param {number} [offset]
 * @returns {Record<string, boolean>}
 */
function available(arr, offset = 0) {
  /** @type {Record<string, boolean>} */
  const out = {}
  for (const row of hexDetailRows(Uint8Array.from(arr), offset)) out[row.key] = row.available
  return out
}

// ── Pure conversion ──────────────────────────────────────────────────────────

describe('hexDetailRows — 同一組位元組的兩種位元組序', () => {
  const RAMP = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]

  it('16 位元：LE 取 0x0201、BE 取 0x0102', () => {
    const v = values(RAMP)
    expect(v.uint16le).toBe('513')      // 0x0201
    expect(v.uint16be).toBe('258')      // 0x0102
    expect(v.int16le).toBe('513')
    expect(v.int16be).toBe('258')
  })

  it('32 位元：LE 取 0x04030201、BE 取 0x01020304', () => {
    const v = values(RAMP)
    expect(v.uint32le).toBe('67305985')
    expect(v.uint32be).toBe('16909060')
    expect(v.int32le).toBe('67305985')
    expect(v.int32be).toBe('16909060')
  })

  it('64 位元：LE 取 0x0807060504030201、BE 取 0x0102030405060708', () => {
    const v = values(RAMP)
    expect(v.uint64le).toBe('578437695752307201')
    expect(v.uint64be).toBe('72623859790382856')
    expect(v.int64le).toBe('578437695752307201')
    expect(v.int64be).toBe('72623859790382856')
  })

  it('位元組序不是隨型別各自為政：反轉輸入即互換 LE / BE', () => {
    // 每種寬度各自反轉自己那幾個位元組：BE 讀反轉後的結果，必須等於 LE 讀原序
    expect(values([...RAMP.slice(0, 2)].reverse()).uint16be).toBe(values(RAMP).uint16le)
    expect(values([...RAMP.slice(0, 4)].reverse()).uint32be).toBe(values(RAMP).uint32le)
    expect(values([...RAMP].reverse()).uint64be).toBe(values(RAMP).uint64le)
  })
})

describe('hexDetailRows — 二補數負值', () => {
  it('int8 0xFF 為 -1，uint8 為 255', () => {
    expect(values([0xff]).int8).toBe('-1')
    expect(values([0xff]).uint8).toBe('255')
  })

  it('int16 的最小值：LE 0x00 0x80、BE 0x80 0x00 都是 -32768', () => {
    expect(values([0x00, 0x80]).int16le).toBe('-32768')
    expect(values([0x80, 0x00]).int16be).toBe('-32768')
    // 同一組位元組換另一個序，就不是最小值了
    expect(values([0x00, 0x80]).int16be).toBe('128')
    expect(values([0x80, 0x00]).uint16le).toBe('128')
  })

  it('int32 全 1 為 -1，uint32 為 4294967295', () => {
    const v = values([0xff, 0xff, 0xff, 0xff])
    expect(v.int32le).toBe('-1')
    expect(v.int32be).toBe('-1')
    expect(v.uint32le).toBe('4294967295')
    expect(v.uint32be).toBe('4294967295')
  })

  it('int32 最小值 0x80000000：LE 與 BE 各自對應不同的位元組排列', () => {
    expect(values([0x00, 0x00, 0x00, 0x80]).int32le).toBe('-2147483648')
    expect(values([0x80, 0x00, 0x00, 0x00]).int32be).toBe('-2147483648')
  })

  it('int64 全 1 為 -1，uint64 為 2^64-1', () => {
    const v = values([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    expect(v.int64le).toBe('-1')
    expect(v.int64be).toBe('-1')
    expect(v.uint64le).toBe('18446744073709551615')
    expect(v.uint64be).toBe('18446744073709551615')
  })
})

describe('hexDetailRows — 64 位元必須走 BigInt', () => {
  it('2^53+1 精確印出（用 double 實作會印成 ...992）', () => {
    // 0x0020000000000001 = 9007199254740993 = 2^53 + 1
    const bytes = [0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]
    expect(values(bytes).uint64be).toBe('9007199254740993')
    expect(values(bytes).int64be).toBe('9007199254740993')
    // 明確排除 double 會給出的相鄰值
    expect(values(bytes).uint64be).not.toBe('9007199254740992')
    // Number 這條路正是失準的來源：轉回去就掉了那個 1
    expect(String(Number(values(bytes).uint64be))).toBe('9007199254740992')
  })

  it('int64 上界 2^63-1 精確印出（用 double 會印成 ...808）', () => {
    const bytes = [0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    expect(values(bytes).int64be).toBe('9223372036854775807')
    expect(values(bytes).int64be).not.toBe('9223372036854775808')
  })

  it('int64 下界 -2^63 精確印出', () => {
    const bytes = [0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
    expect(values(bytes).int64be).toBe('-9223372036854775808')
    expect(values(bytes).uint64be).toBe('9223372036854775808')
  })

  it('十進位字串每一位都對得上 BigInt 的還原值', () => {
    const bytes = [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]
    expect(BigInt(values(bytes).uint64be)).toBe(0x123456789abcdef0n)
    expect(BigInt(values(bytes).uint64le)).toBe(0xf0debc9a78563412n)
  })
})

describe('hexDetailRows — 浮點位元樣式', () => {
  it('float32 1.0 = 0x3F800000', () => {
    expect(values([0x00, 0x00, 0x80, 0x3f]).float32le).toBe('1')
    expect(values([0x3f, 0x80, 0x00, 0x00]).float32be).toBe('1')
  })

  it('float32 -2.5 = 0xC0200000', () => {
    expect(values([0xc0, 0x20, 0x00, 0x00]).float32be).toBe('-2.5')
    expect(values([0x00, 0x00, 0x20, 0xc0]).float32le).toBe('-2.5')
  })

  it('float64 1.0 = 0x3FF0000000000000', () => {
    const be = [0x3f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
    expect(values(be).float64be).toBe('1')
    expect(values([...be].reverse()).float64le).toBe('1')
  })

  it('float64 π 的標準位元樣式', () => {
    const be = [0x40, 0x09, 0x21, 0xfb, 0x54, 0x44, 0x2d, 0x18]
    expect(values(be).float64be).toBe(String(Math.PI))
  })

  it('NaN、Infinity、-0 各自明講，不會混成 0', () => {
    expect(values([0x7f, 0xc0, 0x00, 0x00]).float32be).toBe('NaN')
    expect(values([0x7f, 0x80, 0x00, 0x00]).float32be).toBe('+Infinity')
    expect(values([0xff, 0x80, 0x00, 0x00]).float32be).toBe('-Infinity')
    expect(values([0x80, 0x00, 0x00, 0x00]).float32be).toBe('-0')
    expect(values([0x00, 0x00, 0x00, 0x00]).float32be).toBe('0')
  })
})

describe('hexDetailRows — 檔尾不足時不得補零硬讀', () => {
  it('只剩 7 個位元組時，64 位元型別標為不可用且不含數字', () => {
    const seven = [1, 2, 3, 4, 5, 6, 7]
    const avail = available(seven)
    const v = values(seven)
    for (const key of ['int64le', 'int64be', 'uint64le', 'uint64be', 'float64le', 'float64be']) {
      expect(avail[key]).toBe(false)
      expect(v[key]).toContain('需要 8 位元組')
      expect(v[key]).not.toMatch(/^-?\d+$/)
    }
    // 塞得下的仍然要讀出來
    expect(avail.uint32le).toBe(true)
    expect(v.uint32le).toBe('67305985')
  })

  it('游標落在倒數第二個位元組時，只有 8 與 16 位元可用', () => {
    const avail = available([1, 2, 3, 4], 2)
    expect(avail.uint8).toBe(true)
    expect(avail.uint16le).toBe(true)
    expect(avail.uint32le).toBe(false)
    expect(avail.float32be).toBe(false)
  })

  it('最後一個位元組：只有單位元組型別可用', () => {
    const avail = available([0x41, 0x42], 1)
    expect(avail.int8).toBe(true)
    expect(avail.uint16le).toBe(false)
    expect(values([0x41, 0x42], 1).uint8).toBe('66')
  })

  it('補零的緩衝區若被誤用，這裡會露餡：0x01 後接檔尾不得讀成 1', () => {
    const v = values([0x01])
    expect(v.uint16le).not.toBe('1')
    expect(v.uint32le).not.toBe('1')
    expect(v.uint64le).not.toBe('1')
  })

  it('超出範圍的 offset 完全沒有輸出', () => {
    expect(hexDetailRows(Uint8Array.from([1, 2, 3]), 3)).toEqual([])
    expect(hexDetailRows(Uint8Array.from([1, 2, 3]), -1)).toEqual([])
    expect(hexDetailRows(new Uint8Array(0), 0)).toEqual([])
    expect(hexDetailRows(null, 0)).toEqual([])
    expect(hexDetailRows(Uint8Array.from([1]), NaN)).toEqual([])
  })
})

// ── Address line ─────────────────────────────────────────────────────────────

describe('hexAddressRows', () => {
  it('同時給 16 進位與 10 進位', () => {
    const rows = hexAddressRows(26, 100)
    /** @type {Record<string, string>} */
    const map = {}
    for (const r of rows) map[r.key] = r.value
    expect(map.addrHex).toBe('0x0000001A')
    expect(map.addrDec).toBe('26')
    expect(map.addrRemaining).toBe('74')
  })

  it('位址補滿 8 位，大檔也不會換寬度', () => {
    expect(hexAddressRows(0)[0].value).toBe('0x00000000')
    expect(hexAddressRows(0xdeadbeef)[0].value).toBe('0xDEADBEEF')
  })

  it('未給總長度時不編造剩餘位元組', () => {
    expect(hexAddressRows(5).map((r) => r.key)).toEqual(['addrHex', 'addrDec'])
  })

  it('負值或非數值沒有位址可言', () => {
    expect(hexAddressRows(-1)).toEqual([])
    expect(hexAddressRows(NaN)).toEqual([])
  })
})

// ── The three switches, on the pure model ────────────────────────────────────

describe('hexReadoutRows — 三個開關', () => {
  const RAMP = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
  /**
   * @param {{ showAddress?: boolean, littleEndian?: boolean, bigEndian?: boolean }} opts
   * @returns {string[]}
   */
  const keys = (opts) => hexReadoutRows(RAMP, 0, opts).map((r) => r.key)

  it('預設三者全開', () => {
    const k = keys({})
    expect(k).toContain('addrHex')
    expect(k).toContain('addrDec')
    expect(k).toContain('uint32le')
    expect(k).toContain('uint32be')
  })

  it('關掉位址只影響位址', () => {
    const k = keys({ showAddress: false })
    expect(k).not.toContain('addrHex')
    expect(k).not.toContain('addrDec')
    expect(k).toContain('uint32le')
    expect(k).toContain('uint32be')
  })

  it('關掉 LE 移除所有 LE 列，BE 一列不少', () => {
    const rows = hexReadoutRows(RAMP, 0, { littleEndian: false })
    expect(rows.some((r) => r.endian === 'le')).toBe(false)
    expect(rows.filter((r) => r.endian === 'be')).toHaveLength(8)
  })

  it('關掉 BE 移除所有 BE 列', () => {
    const rows = hexReadoutRows(RAMP, 0, { bigEndian: false })
    expect(rows.some((r) => r.endian === 'be')).toBe(false)
    expect(rows.filter((r) => r.endian === 'le')).toHaveLength(8)
  })

  it('兩組都關仍保留與位元組序無關的解讀', () => {
    const k = keys({ littleEndian: false, bigEndian: false })
    expect(k).toEqual(expect.arrayContaining(['addrHex', 'hex', 'binary', 'octal', 'char', 'int8', 'uint8']))
    expect(k).not.toContain('uint16le')
    expect(k).not.toContain('uint16be')
  })

  it('標籤上的 (LE) / (BE) 與 endian 欄位一致', () => {
    for (const row of hexReadoutRows(RAMP, 0, {})) {
      if (row.label.includes('(LE)')) expect(row.endian).toBe('le')
      else if (row.label.includes('(BE)')) expect(row.endian).toBe('be')
      else expect(row.endian ?? null).toBe(null)
    }
  })

  it('offset 超出範圍時連位址都不給', () => {
    expect(hexReadoutRows(RAMP, 8, {})).toEqual([])
    expect(hexReadoutRows(null, 0, {})).toEqual([])
  })
})

// ── Wiring: the panel and the switches inside the real view ──────────────────

/** @type {HTMLElement[]} */
let hosts = []
/** @type {HexCompare[]} */
let views = []

beforeEach(() => {
  new SettingsStore().setPref('navFirstDiffOnLoad', false)
  window.electronAPI = /** @type {never} */ ({
    saveFile: vi.fn(),
    readDir: vi.fn().mockResolvedValue([]),
    statFile: vi.fn().mockResolvedValue({ mtime: 0 }),
    openFileBinary: vi.fn(),
  })
})

afterEach(() => {
  for (const v of views) v.destroy()
  for (const h of hosts) h.remove()
  views = []
  hosts = []
  delete window.electronAPI
})

/**
 * @param {number[]} left
 * @param {number[]} right
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
 * @param {HexCompare} view
 * @returns {Record<string, string>}
 */
function panelMap(view) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const node of view._dom.detailsBody.querySelectorAll('.hx-detail-value[data-key]')) {
    out[node.getAttribute('data-key') ?? ''] = node.textContent ?? ''
  }
  return out
}

describe('Hex 面板與游標', () => {
  const RAMP = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]

  it('點選位元組後，面板顯示該位址的位址與兩種位元組序', () => {
    const view = mountHex(RAMP, RAMP)
    view.setDetailsVisible(true)
    view._moveCursorTo('left', 4)
    const map = panelMap(view)
    expect(map.addrHex).toBe('0x00000004')
    expect(map.addrDec).toBe('4')
    expect(map.uint32le).toBe('134678021')  // 0x08070605
    expect(map.uint32be).toBe('84281096')   // 0x05060708
  })

  it('游標移動時面板跟著更新，且不重建虛擬列', () => {
    const view = mountHex(RAMP, RAMP)
    view.setDetailsVisible(true)
    view._moveCursorTo('left', 0)
    expect(panelMap(view).addrDec).toBe('0')
    const rowsBefore = view._dom.inner_left.querySelectorAll('.hx-row').length
    const firstRow = view._dom.inner_left.querySelector('.hx-row')

    view._moveCursorTo('left', 9)
    expect(panelMap(view).addrDec).toBe('9')
    expect(panelMap(view).uint8).toBe('10')
    expect(view._dom.inner_left.querySelectorAll('.hx-row').length).toBe(rowsBefore)
    // 同一個節點還在原位 —— 面板更新沒有連帶重建整個清單
    expect(view._dom.inner_left.querySelector('.hx-row')).toBe(firstRow)
  })

  it('非編輯模式下方向鍵仍能移動游標並更新面板', () => {
    const view = mountHex(RAMP, RAMP)
    view.setDetailsVisible(true)
    view._moveCursorTo('left', 3)
    const scroll = view._dom.scroll_left
    scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(view.getCursor().offset).toBe(4)
    expect(panelMap(view).addrDec).toBe('4')
    scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(panelMap(view).addrDec).toBe('3')
  })

  it('讀資料來自模型而非畫面：捲到看不見的位址也讀得出來', () => {
    const size = 16 * 5000
    const data = new Array(size)
    for (let i = 0; i < size; i++) data[i] = i & 0xff
    const view = mountHex(data, data)
    view.setDetailsVisible(true)
    // 這一列遠在虛擬視窗之外
    view._moveCursorTo('left', 40_000)
    const map = panelMap(view)
    expect(map.addrDec).toBe('40000')
    expect(map.uint8).toBe(String(40_000 & 0xff))
    expect(view._dom.inner_left.querySelectorAll('.hx-row').length).toBeLessThan(60)
  })

  it('三個開關即時反映在面板上', () => {
    const view = mountHex(RAMP, RAMP)
    view.setDetailsVisible(true)
    view._moveCursorTo('left', 0)

    view.setLittleEndianVisible(false)
    expect(panelMap(view).uint32le).toBeUndefined()
    expect(panelMap(view).uint32be).toBeDefined()

    view.setBigEndianVisible(false)
    expect(panelMap(view).uint32be).toBeUndefined()
    expect(panelMap(view).uint8).toBeDefined()

    view.setByteAddressVisible(false)
    expect(panelMap(view).addrHex).toBeUndefined()

    view.setLittleEndianVisible(true)
    expect(panelMap(view).uint32le).toBeDefined()
  })

  it('工具列按鈕與狀態同步', () => {
    const view = mountHex(RAMP, RAMP)
    view.setDetailsVisible(true)
    expect(view._dom.btnLittleEndian.classList.contains('active')).toBe(true)
    view._dom.btnLittleEndian.click()
    expect(view.isLittleEndianVisible()).toBe(false)
    expect(view._dom.btnLittleEndian.classList.contains('active')).toBe(false)
    view._dom.btnBigEndian.click()
    expect(view.isBigEndianVisible()).toBe(false)
    view._dom.btnByteAddress.click()
    expect(view.isByteAddressVisible()).toBe(false)
  })

  it('三個開關進出 getConfig / applyConfig', () => {
    const a = mountHex(RAMP, RAMP)
    a.setDetailsVisible(true)
    a.setLittleEndianVisible(false)
    a.setByteAddressVisible(false)
    const b = mountHex(RAMP, RAMP)
    b.applyConfig(a.getConfig())
    expect(b.isDetailsVisible()).toBe(true)
    expect(b.isLittleEndianVisible()).toBe(false)
    expect(b.isBigEndianVisible()).toBe(true)
    expect(b.isByteAddressVisible()).toBe(false)
    expect(b._dom.btnLittleEndian.classList.contains('active')).toBe(false)
    expect(b._dom.btnByteAddress.classList.contains('active')).toBe(false)
  })

  it('檔尾附近的游標在面板上顯示不可用而非數字', () => {
    const view = mountHex([0x41, 0x42, 0x43], [0x41, 0x42, 0x43])
    view.setDetailsVisible(true)
    view._moveCursorTo('left', 2)
    const map = panelMap(view)
    expect(map.uint8).toBe('67')
    expect(map.uint16le).toContain('需要 2 位元組')
    expect(map.uint64be).toContain('需要 8 位元組')
  })
})
