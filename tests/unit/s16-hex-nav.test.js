// @vitest-environment jsdom
/**
 * S16 — Hex 比對差異導航與 Swap Sides
 * tests/unit/s16-hex-nav.test.js
 *
 * 涵蓋：
 *  - computeHexDiffRegions 純函式（聚合正確性 + 邊界）
 *  - nextDifference / prevDifference / firstDifference / lastDifference
 *  - swap() 成對狀態交換
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HexCompare, computeHexDiffRegions } from '../../src/renderer/src/views/hex-compare.js'
import { SettingsStore } from '../../src/renderer/src/core/settings-store.js'

// Beyond Compare's "go to first difference on load" default would move the
// cursor before these tests navigate; they are about the stepping rules, so
// the option is turned off and exercised separately.
beforeEach(() => {
  new SettingsStore().setPref('navFirstDiffOnLoad', false)
})

/** @param {number[]} arr */
const bytes = (arr) => new Uint8Array(arr)
/** @param {number[]} arr */
const b64 = (arr) => btoa(String.fromCharCode(...arr))

describe('computeHexDiffRegions — 區塊聚合', () => {
  it('兩側完全相同 → 無差異區塊', () => {
    expect(computeHexDiffRegions(bytes([1, 2, 3]), bytes([1, 2, 3]))).toEqual([])
  })

  it('兩側完全不同 → 聚合為單一區塊（而非逐 byte）', () => {
    expect(computeHexDiffRegions(bytes([1, 2, 3, 4]), bytes([9, 9, 9, 9]))).toEqual([
      { start: 0, end: 4, length: 4 },
    ])
  })

  it('連續差異 byte 聚合成一塊，被相同 byte 隔開則分塊', () => {
    const left  = bytes([0, 1, 1, 0, 0, 2, 0])
    const right = bytes([0, 9, 9, 0, 0, 8, 0])
    expect(computeHexDiffRegions(left, right)).toEqual([
      { start: 1, end: 3, length: 2 },
      { start: 5, end: 6, length: 1 },
    ])
  })

  it('差異位於首尾兩端時仍正確關閉區塊', () => {
    const left  = bytes([1, 5, 5, 1])
    const right = bytes([2, 5, 5, 2])
    expect(computeHexDiffRegions(left, right)).toEqual([
      { start: 0, end: 1, length: 1 },
      { start: 3, end: 4, length: 1 },
    ])
  })
})

describe('computeHexDiffRegions — 邊界情況', () => {
  it('兩側皆為 null / 空 → 空陣列', () => {
    expect(computeHexDiffRegions(null, null)).toEqual([])
    expect(computeHexDiffRegions(bytes([]), bytes([]))).toEqual([])
    expect(computeHexDiffRegions(null, bytes([]))).toEqual([])
  })

  it('只有左側有資料 → 整段視為一個孤兒差異區塊', () => {
    expect(computeHexDiffRegions(bytes([1, 2, 3]), null)).toEqual([
      { start: 0, end: 3, length: 3 },
    ])
  })

  it('只有右側有資料 → 整段視為一個孤兒差異區塊', () => {
    expect(computeHexDiffRegions(null, bytes([1, 2]))).toEqual([
      { start: 0, end: 2, length: 2 },
    ])
  })

  it('右側較長 → 尾端多出的 byte 併為一個區塊', () => {
    expect(computeHexDiffRegions(bytes([1, 2]), bytes([1, 2, 3, 4]))).toEqual([
      { start: 2, end: 4, length: 2 },
    ])
  })

  it('左側較長且中段亦有差異 → 兩個區塊', () => {
    const left  = bytes([1, 7, 3, 4, 5])
    const right = bytes([1, 2, 3])
    expect(computeHexDiffRegions(left, right)).toEqual([
      { start: 1, end: 2, length: 1 },
      { start: 3, end: 5, length: 2 },
    ])
  })
})

describe('computeHexDiffRegions — complete 模式分類', () => {
  it('依 leftClass / rightClass 聚合，忽略位置對齊結果', () => {
    const left  = bytes([1, 2, 3, 4])
    const right = bytes([9, 9, 3, 4])
    // 位置比對會判定 0..1 不同；此處刻意讓分類只標記 offset 1
    const leftClass  = new Uint8Array([0, 1, 0, 0])
    const rightClass = new Uint8Array([0, 1, 0, 0])
    expect(computeHexDiffRegions(left, right, { leftClass, rightClass })).toEqual([
      { start: 1, end: 2, length: 1 },
    ])
  })

  it('任一側分類為 diff 即算差異（長度不同時取聯集）', () => {
    const leftClass  = new Uint8Array([0, 0])
    const rightClass = new Uint8Array([0, 1, 1])
    const regions = computeHexDiffRegions(bytes([1, 2]), bytes([1, 5, 6]), { leftClass, rightClass })
    expect(regions).toEqual([{ start: 1, end: 3, length: 2 }])
  })

  it('分類全為 same → 無差異', () => {
    const leftClass  = new Uint8Array([0, 0, 0])
    const rightClass = new Uint8Array([0, 0, 0])
    expect(
      computeHexDiffRegions(bytes([1, 2, 3]), bytes([4, 5, 6]), { leftClass, rightClass }),
    ).toEqual([])
  })
})

describe('HexCompare — 差異導航', () => {
  /** @type {HexCompare} */
  let view

  beforeEach(() => {
    view = new HexCompare({ bytesPerRow: 16 })
    // 差異落在 offset 1、5、9 → 三個區塊
    view.setLeft('/tmp/a.bin',  b64([0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0]))
    view.setRight('/tmp/b.bin', b64([0, 9, 0, 0, 0, 8, 0, 0, 0, 7, 0]))
  })

  afterEach(() => {
    view.destroy()
  })

  it('初始未選取任何差異', () => {
    expect(view.getDiffRegions()).toHaveLength(3)
    expect(view.getCurrentDiffIndex()).toBe(-1)
  })

  it('nextDifference 由未選取狀態進入第一個差異並逐一前進', () => {
    view.nextDifference()
    expect(view.getCurrentDiffIndex()).toBe(0)
    view.nextDifference()
    expect(view.getCurrentDiffIndex()).toBe(1)
  })

  it('到達最後一個差異後 nextDifference 停留在尾端（與 TextCompare 一致，不環繞）', () => {
    view.lastDifference()
    expect(view.getCurrentDiffIndex()).toBe(2)
    view.nextDifference()
    expect(view.getCurrentDiffIndex()).toBe(2)
  })

  it('到達第一個差異後 prevDifference 停留在頭端', () => {
    view.firstDifference()
    expect(view.getCurrentDiffIndex()).toBe(0)
    view.prevDifference()
    expect(view.getCurrentDiffIndex()).toBe(0)
  })

  it('firstDifference / lastDifference 直接跳至兩端', () => {
    view.lastDifference()
    expect(view.getDiffRegions()[view.getCurrentDiffIndex()]).toEqual({
      start: 9, end: 10, length: 1,
    })
    view.firstDifference()
    expect(view.getDiffRegions()[view.getCurrentDiffIndex()]).toEqual({
      start: 1, end: 2, length: 1,
    })
  })

  it('兩側完全相同時所有導航皆為 no-op', () => {
    const same = new HexCompare({})
    same.setLeft('/a', b64([1, 2, 3]))
    same.setRight('/b', b64([1, 2, 3]))
    expect(same.getDiffRegions()).toEqual([])
    same.nextDifference()
    same.firstDifference()
    same.lastDifference()
    expect(same.getCurrentDiffIndex()).toBe(-1)
    same.destroy()
  })

  it('只有單側有資料時整段為一個可導航的差異區塊', () => {
    const oneSide = new HexCompare({})
    oneSide.setLeft('/a', b64([1, 2, 3, 4]))
    expect(oneSide.getDiffRegions()).toEqual([{ start: 0, end: 4, length: 4 }])
    oneSide.nextDifference()
    expect(oneSide.getCurrentDiffIndex()).toBe(0)
    oneSide.destroy()
  })

  it('資料變更後若選取索引超出範圍，會夾回最後一個差異', () => {
    view.lastDifference()
    expect(view.getCurrentDiffIndex()).toBe(2)
    view.setRight('/tmp/c.bin', b64([0, 9, 0, 0, 0, 2, 0, 0, 0, 3, 0]))
    expect(view.getDiffRegions()).toHaveLength(1)
    expect(view.getCurrentDiffIndex()).toBe(0)
  })

  it('complete 模式改用分類結果計算區塊', () => {
    const cv = new HexCompare({ diffAlgorithm: 'complete' })
    // 右側在開頭插入一個 byte：位置比對會判定幾乎整段不同，
    // complete 模式只應標記插入的那一個 byte。
    cv.setLeft('/a',  b64([1, 2, 3, 4, 5]))
    cv.setRight('/b', b64([0, 1, 2, 3, 4, 5]))
    const regions = cv.getDiffRegions()
    expect(regions).toHaveLength(1)
    expect(regions[0].length).toBe(1)
    cv.destroy()
  })
})

describe('HexCompare — swap()', () => {
  /** @type {HexCompare} */
  let view

  beforeEach(() => {
    view = new HexCompare({})
    view.setLeft('/tmp/a.bin',  b64([1, 2, 3]))
    view.setRight('/tmp/b.bin', b64([1, 9, 3, 4]))
  })

  afterEach(() => {
    view.destroy()
  })

  it('交換 bytes 與路徑', () => {
    view.swap()
    expect(view._leftPath).toBe('/tmp/b.bin')
    expect(view._rightPath).toBe('/tmp/a.bin')
    expect(Array.from(view._leftBytes)).toEqual([1, 9, 3, 4])
    expect(Array.from(view._rightBytes)).toEqual([1, 2, 3])
  })

  it('交換截斷旗標與原始大小', () => {
    view._leftTruncated = true
    view._leftOriginalSize = 12345
    view._rightTruncated = false
    view._rightOriginalSize = 4
    view.swap()
    expect(view._leftTruncated).toBe(false)
    expect(view._leftOriginalSize).toBe(4)
    expect(view._rightTruncated).toBe(true)
    expect(view._rightOriginalSize).toBe(12345)
  })

  it('emit paths-changed 且內容為交換後的路徑', () => {
    const spy = vi.fn()
    view.on('paths-changed', spy)
    view.swap()
    expect(spy).toHaveBeenCalledWith({ left: '/tmp/b.bin', right: '/tmp/a.bin' })
  })

  it('交換後差異區塊維持對稱（byte 差 + 尾端孤兒）', () => {
    const before = view.getDiffRegions()
    view.swap()
    expect(view.getDiffRegions()).toEqual(before)
    expect(before).toEqual([
      { start: 1, end: 2, length: 1 },
      { start: 3, end: 4, length: 1 },
    ])
  })

  it('連續兩次 swap 還原原狀', () => {
    view.swap()
    view.swap()
    expect(view._leftPath).toBe('/tmp/a.bin')
    expect(Array.from(view._leftBytes)).toEqual([1, 2, 3])
  })

  it('單側為空時 swap 仍可運作', () => {
    const v = new HexCompare({})
    v.setLeft('/only.bin', b64([7, 7]))
    v.swap()
    expect(v._leftBytes).toBeNull()
    expect(Array.from(v._rightBytes)).toEqual([7, 7])
    expect(v.getDiffRegions()).toEqual([{ start: 0, end: 2, length: 2 }])
    v.destroy()
  })
})

describe('HexCompare — 掛載後的工具列導航', () => {
  /** @type {HTMLElement} */
  let host
  /** @type {HexCompare} */
  let view

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    view = new HexCompare({ bytesPerRow: 8 })
    view.mount(host)
    view.setLeft('/a',  b64([0, 0, 1, 1, 0, 0, 0, 0]))
    view.setRight('/b', b64([0, 0, 2, 2, 0, 0, 0, 0]))
  })

  afterEach(() => {
    view.destroy()
    host.remove()
  })

  it('未選取時顯示差異總數，選取後顯示「第 X / N 個差異」', () => {
    const label = host.querySelector('.hx-diff-count')
    expect(label.textContent).toBe('共 1 個差異')
    view.nextDifference()
    expect(label.textContent).toBe('第 1 / 1 個差異')
  })

  it('無資料時導航按鈕停用且顯示「無差異」', () => {
    const empty = new HexCompare({})
    const el2 = document.createElement('div')
    document.body.appendChild(el2)
    empty.mount(el2)
    empty.refresh()
    expect(el2.querySelector('.hx-diff-count').textContent).toBe('無差異')
    expect(el2.querySelector('.hx-nav-btn').disabled).toBe(true)
    empty.destroy()
    el2.remove()
  })

  it('▼ 按鈕觸發導航並為當前區塊加上 hx-current-diff', () => {
    const buttons = host.querySelectorAll('.hx-nav-btn')
    buttons[2].click() // ▼ next
    expect(view.getCurrentDiffIndex()).toBe(0)
    expect(host.querySelectorAll('.hx-current-diff').length).toBeGreaterThan(0)
  })

  it('⇄ 按鈕觸發 swap', () => {
    const btnSwap = host.querySelector('.hx-btn-swap')
    btnSwap.click()
    expect(view._leftPath).toBe('/b')
  })
})
