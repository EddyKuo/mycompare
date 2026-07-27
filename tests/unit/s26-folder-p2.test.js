/**
 * @vitest-environment jsdom
 *
 * S26 — 資料夾比對的 P2 缺口：欄位、組合式顯示、時間位移容差、
 * 檔名大小寫、檔名對齊、Quick Compare、Compare To。
 *
 * 每一組都同時斷言行為與**入口**。這個專案反覆出現「模組完整、單元測試齊全、
 * 但沒有任何呼叫端」的功能，所以每個 describe 都真的去工具列／右鍵選單／
 * 批次選單裡找到那個項目並按下去。
 *
 * 另外釘住兩件容易在改渲染路徑時退化的事：
 *   1. 虛擬捲動只會為「畫出來的列」排隊做 IPC——用數萬列驗證；
 *   2. 寫回 row 的判定必須經過 eachRow（flattenRows 給的是複本）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { setActiveView } from '../../src/renderer/src/core/active-view.js'
import {
  FolderCompare,
  FOLDER_COLUMN_DEFS,
  VIEW_PRESETS,
  VIEW_PRESET_LABELS,
  CUSTOM_VIEW_PRESET,
  entryAttrText,
  entryAttrTitle,
  attributesDiffer,
  columnSortValue,
  normalizeColumns,
  normalizeTimeShift,
  timestampsMatch,
  normalizeFilenameCase,
  filenamesAreCaseInsensitive,
  parseAlignRules,
  alignmentNameOf,
  pairKeyOf,
  namesDifferOnlyByCase,
  pairFlatEntries,
  compareEntries,
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

beforeEach(() => {
  alerts = []
  menuItems = []
  vi.stubGlobal('alert', (msg) => { alerts.push(String(msg)) })
  vi.stubGlobal('confirm', () => true)
  localStorage.clear()
  setActiveView('folder')
})

/** @type {FolderCompare[]} */
let mountedViews = []

afterEach(() => {
  for (const fc of mountedViews) fc.destroy()
  mountedViews = []
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** @param {object} over */
function stubApi(over = {}) {
  const api = {
    readDir: vi.fn().mockResolvedValue([]),
    openFolder: vi.fn().mockResolvedValue({ path: '/picked' }),
    readMetadata: vi.fn().mockResolvedValue(null),
    hashFile: vi.fn().mockResolvedValue('deadbeef'),
    copyFile: vi.fn().mockResolvedValue({ copied: true }),
    deleteFile: vi.fn().mockResolvedValue({ deleted: true }),
    setMtime: vi.fn().mockResolvedValue(undefined),
    showInExplorer: vi.fn(),
    ...over,
  }
  window.electronAPI = api
  return api
}

function mounted(options = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const fc = new FolderCompare({ useDefaults: false, ...options })
  fc.mount(host)
  mountedViews.push(fc)
  return { fc, host }
}

/** @param {object} o */
function entry(o = {}) {
  return {
    name: o.name ?? 'a.txt',
    path: o.path ?? `/left/${o.name ?? 'a.txt'}`,
    isDirectory: !!o.isDirectory,
    size: o.size ?? 10,
    mtime: o.mtime ?? '2024-01-01T00:00:00.000Z',
    ...o,
  }
}

/** Right-click the first rendered row and return the menu labels. */
function rowMenuLabels(host, index = 0) {
  const rowEl = host.querySelectorAll('.fc-row')[index]
  rowEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
  return menuItems.filter((i) => !i.separator).map((i) => i.label)
}

// ── 1. 欄位 ──────────────────────────────────────────────────────────────────

describe('P2-1 新欄位：建立時間 / 絕對路徑 / 檢查碼 / System·Archive 屬性', () => {
  it('四個欄位都在欄位定義中，且都可被 normalizeColumns 接受', () => {
    const ids = FOLDER_COLUMN_DEFS.map((c) => c.id)
    expect(ids).toContain('created')
    expect(ids).toContain('abspath')
    expect(ids).toContain('crc')
    expect(normalizeColumns(['created', 'abspath', 'crc']))
      .toEqual(['name', 'created', 'abspath', 'crc'])
  })

  it('欄位選單（▦ 欄位）列出每一個新欄位，點下去就會啟用', () => {
    const { fc, host } = mounted()
    host.querySelector('.fc-btn-columns').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const labels = menuItems.map((i) => i.label)
    expect(labels.some((l) => l.includes('建立時間'))).toBe(true)
    expect(labels.some((l) => l.includes('完整路徑'))).toBe(true)
    expect(labels.some((l) => l.includes('檢查碼'))).toBe(true)

    menuItems.find((i) => i.label.includes('檢查碼')).action()
    expect(fc.getColumns()).toContain('crc')
  })

  it('建立時間欄位渲染 ctime，缺 ctime 的來源留白而不是編造', () => {
    const withCtime = entry({ ctime: '2023-05-06T07:08:00.000Z' })
    expect(columnSortValue({ left: withCtime }, 'created'))
      .toBe(Date.parse('2023-05-06T07:08:00.000Z'))
    // 封存/快照/遠端項目沒有建立時間
    expect(columnSortValue({ left: entry() }, 'created')).toBe(-1)
  })

  it('絕對路徑欄位排序用的是完整路徑，相對路徑欄位不受影響', () => {
    const row = { left: entry({ path: '/base/sub/a.txt' }), name: 'a.txt' }
    expect(columnSortValue(row, 'abspath')).toBe('/base/sub/a.txt')
  })

  it('屬性欄位顯示 S 與 A，且只在來源真的回報時才顯示', () => {
    expect(entryAttrText({ readOnly: false, hidden: false, system: true })).toBe('S')
    expect(entryAttrText({ readOnly: false, hidden: false, archive: true })).toBe('A')
    expect(entryAttrText({ readOnly: true, hidden: true, system: true, archive: true }))
      .toBe('RHSA')
    // 讀不到屬性字組時仍是既有的單一 `?`，不會變成三個問號
    expect(entryAttrText({ readOnly: false })).toBe('?')
    expect(entryAttrTitle({ readOnly: false, hidden: false, system: true }))
      .toContain('S＝系統')
  })

  it('比對屬性把 System / Archive 一併納入，未知的一側不算差異', () => {
    const base = { readOnly: false, hidden: false }
    expect(attributesDiffer({ ...base, system: true }, { ...base, system: false })).toBe(true)
    expect(attributesDiffer({ ...base, archive: true }, { ...base, archive: false })).toBe(true)
    // 一側未知 ⇒ 不構成差異
    expect(attributesDiffer({ ...base, system: true }, base)).toBe(false)
  })
})

describe('P2-1 檢查碼欄位的效能約束', () => {
  it('只為畫得出來的列排隊；三萬列不會產生三萬個 hashFile', async () => {
    const api = stubApi()
    const { fc } = mounted({ columns: ['name', 'crc'] })
    fc.setColumns(['name', 'crc'])

    const rows = []
    for (let i = 0; i < 30_000; i++) {
      const name = `f${i}.bin`
      rows.push({
        name,
        status: 'same',
        left: entry({ name, path: `/l/${name}` }),
        right: entry({ name, path: `/r/${name}` }),
        children: null,
      })
    }
    fc._rows = rows
    fc._applyFilterAndRender()
    await new Promise((r) => setTimeout(r, 0))

    expect(fc._visibleRows.length).toBe(30_000)
    // 視窗大小是幾十列的量級，兩側各一次；用一個寬鬆但遠低於資料量的上限釘住
    expect(api.hashFile.mock.calls.length).toBeGreaterThan(0)
    expect(api.hashFile.mock.calls.length).toBeLessThan(400)
  })

  it('同一個路徑只算一次：重繪不會重複發 IPC', async () => {
    const api = stubApi()
    const { fc } = mounted()
    fc.setColumns(['name', 'crc'])
    fc._rows = [{
      name: 'a.bin', status: 'same',
      left: entry({ name: 'a.bin', path: '/l/a.bin' }),
      right: null, children: null,
    }]
    fc._applyFilterAndRender()
    await new Promise((r) => setTimeout(r, 0))
    const first = api.hashFile.mock.calls.length
    expect(first).toBe(1)

    fc._applyFilterAndRender()
    await new Promise((r) => setTimeout(r, 0))
    expect(api.hashFile.mock.calls.length).toBe(first)
  })

  it('超過大小上限的檔案不送 IPC，並在儲存格說明原因', async () => {
    const api = stubApi()
    const { fc, host } = mounted()
    fc.setColumns(['name', 'crc'])
    fc._rows = [{
      name: 'huge.bin', status: 'same',
      left: entry({ name: 'huge.bin', path: '/l/huge.bin', size: 512 * 1024 * 1024 }),
      right: null, children: null,
    }]
    fc._applyFilterAndRender()
    await new Promise((r) => setTimeout(r, 0))

    expect(api.hashFile).not.toHaveBeenCalled()
    const cell = host.querySelector('.fc-crc')
    expect(cell.textContent).toBe('—')
    expect(cell.title).toContain('MB')
  })

  it('IPC 失敗時把原因寫進 tooltip，不靜默留白', async () => {
    stubApi({ hashFile: vi.fn().mockRejectedValue(new Error('EACCES')) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fc, host } = mounted()
    fc.setColumns(['name', 'crc'])
    fc._rows = [{
      name: 'a.bin', status: 'same',
      left: entry({ name: 'a.bin', path: '/l/a.bin' }), right: null, children: null,
    }]
    fc._applyFilterAndRender()
    await new Promise((r) => setTimeout(r, 0))

    const cell = host.querySelector('.fc-crc')
    expect(cell.textContent).toBe('—')
    expect(cell.title).toContain('EACCES')
  })
})

// ── 2. 組合式顯示模式 ────────────────────────────────────────────────────────

describe('P2-2 組合式顯示模式', () => {
  it('自訂組合在下拉選單中有名字，且不是一個 preset', () => {
    const names = VIEW_PRESET_LABELS.map(([n]) => n)
    expect(names).toContain(CUSTOM_VIEW_PRESET)
    expect(VIEW_PRESETS[CUSTOM_VIEW_PRESET]).toBeUndefined()
  })

  it('四個顯示開關可獨立切換，組合不落在任何 preset 上時標為自訂', () => {
    stubApi()
    const { fc, host } = mounted()
    // BC 的「左側較新 + 左側孤兒」——舊的 11 個 preset 沒有這個組合
    fc.setViewPreset('left-newer')
    host.querySelector('[data-filter="left-orphan"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(fc._showLeftNewer).toBe(true)
    expect(fc._showLeftOnly).toBe(true)
    expect(fc._showRightOnly).toBe(false)
    expect(fc._viewPreset).toBe(CUSTOM_VIEW_PRESET)
    expect(host.querySelector('.fc-view-preset').value).toBe(CUSTOM_VIEW_PRESET)
  })

  it('回到某個 preset 命中的組合時，下拉選單改回那個 preset 的名字', () => {
    stubApi()
    const { fc, host } = mounted()
    const leftOrphan = host.querySelector('[data-filter="left-orphan"]')
    fc.setViewPreset('all')
    // 關掉同、異、右孤兒、兩側較新後，剩下的正是 'left-orphans'
    host.querySelector('#fc-show-same').checked = false
    host.querySelector('#fc-show-same').dispatchEvent(new Event('change', { bubbles: true }))
    host.querySelector('#fc-show-diff').checked = false
    host.querySelector('#fc-show-diff').dispatchEvent(new Event('change', { bubbles: true }))
    host.querySelector('[data-filter="right-orphan"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    host.querySelector('[data-filter="left-newer"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    host.querySelector('[data-filter="right-newer"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(leftOrphan.classList.contains('fc-btn-filter-toggle--active')).toBe(true)
    expect(fc._viewPreset).toBe('left-orphans')
  })

  it('自訂組合可以存進設定並原樣還原（以前會被當成 all）', () => {
    stubApi()
    const { fc } = mounted()
    fc.setViewPreset('left-newer')
    fc._showLeftOnly = true
    fc._markPresetCustom()
    const cfg = fc.getConfig()
    expect(cfg.viewPreset).toBe(CUSTOM_VIEW_PRESET)

    const { fc: other } = mounted()
    other.applyConfig(cfg)
    expect(other._showLeftNewer).toBe(true)
    expect(other._showLeftOnly).toBe(true)
    expect(other._showSame).toBe(false)
    expect(other._showRightOnly).toBe(false)
  })

  it('選單裡選「自訂組合」不會改動任何開關', () => {
    stubApi()
    const { fc, host } = mounted()
    fc.setViewPreset('same')
    const select = host.querySelector('.fc-view-preset')
    select.value = CUSTOM_VIEW_PRESET
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(fc._showSame).toBe(true)
    expect(fc._showDiff).toBe(false)
    expect(select.value).toBe('same')
  })
})

// ── 3. 時區 / 日光節約時間容差 ───────────────────────────────────────────────

describe('P2-3 時間位移容差', () => {
  const t = (iso) => Date.parse(iso)

  it('normalizeTimeShift 只接受三種值', () => {
    expect(normalizeTimeShift('dst')).toBe('dst')
    expect(normalizeTimeShift('timezone')).toBe('timezone')
    expect(normalizeTimeShift('nonsense')).toBe('none')
    expect(normalizeTimeShift(undefined)).toBe('none')
  })

  it('none：只有秒容差，一小時的差就是差', () => {
    expect(timestampsMatch(t('2024-01-01T00:00:00Z'), t('2024-01-01T00:00:01Z'), 2)).toBe(true)
    expect(timestampsMatch(t('2024-01-01T00:00:00Z'), t('2024-01-01T01:00:00Z'), 2)).toBe(false)
  })

  it('dst：正好一小時（含秒容差）視為相同，兩小時不是', () => {
    expect(timestampsMatch(t('2024-01-01T00:00:00Z'), t('2024-01-01T01:00:00Z'), 2, 'dst'))
      .toBe(true)
    expect(timestampsMatch(t('2024-01-01T01:00:00Z'), t('2024-01-01T00:00:01Z'), 2, 'dst'))
      .toBe(true)
    expect(timestampsMatch(t('2024-01-01T00:00:00Z'), t('2024-01-01T02:00:00Z'), 2, 'dst'))
      .toBe(false)
  })

  it('dst 不會順便原諒 50 分鐘前的真實編輯', () => {
    expect(timestampsMatch(t('2024-01-01T00:00:00Z'), t('2024-01-01T00:50:00Z'), 2, 'dst'))
      .toBe(false)
  })

  it('timezone：任何整點位移都原諒，非整點不原諒', () => {
    expect(timestampsMatch(t('2024-01-01T00:00:00Z'), t('2024-01-01T08:00:00Z'), 2, 'timezone'))
      .toBe(true)
    expect(timestampsMatch(t('2024-01-01T00:00:00Z'), t('2024-01-01T08:30:00Z'), 2, 'timezone'))
      .toBe(false)
    // 超過真實時區範圍就不是時區問題
    expect(timestampsMatch(t('2024-01-01T00:00:00Z'), t('2024-01-03T00:00:00Z'), 2, 'timezone'))
      .toBe(false)
  })

  it('時間戳無法解析時不算差異（沿用既有行為，避免整棵樹被標紅）', () => {
    expect(timestampsMatch(NaN, t('2024-01-01T00:00:00Z'), 0)).toBe(true)
  })

  it('接到狀態計算上：dst 模式讓差一小時的一對變成相同', () => {
    const left = [entry({ name: 'a.txt', mtime: '2024-01-01T00:00:00Z' })]
    const right = [entry({ name: 'a.txt', path: '/r/a.txt', mtime: '2024-01-01T01:00:00Z' })]
    expect(compareEntries(left, right, 'mtime', 2)[0].status).toBe('right-newer')
    expect(compareEntries(left, right, 'mtime', 2, { timeShift: 'dst' })[0].status).toBe('same')
  })

  it('入口：⚖ 規則面板有下拉選單，套用後會改變比對結果', async () => {
    stubApi()
    const { fc, host } = mounted()
    host.querySelector('.fc-btn-rules').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const select = host.querySelector('.fc-rules-time-shift')
    expect(select).toBeTruthy()

    select.value = 'timezone'
    host.querySelector('.fc-rules-apply').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(fc.getTimeShift()).toBe('timezone')
    expect(fc.getConfig().timeShift).toBe('timezone')
  })
})

// ── 4. 檔名大小寫 ────────────────────────────────────────────────────────────

describe('P2-4 檔名大小寫比對選項', () => {
  it('normalizeFilenameCase 只接受三種值', () => {
    expect(normalizeFilenameCase('sensitive')).toBe('sensitive')
    expect(normalizeFilenameCase('insensitive')).toBe('insensitive')
    expect(normalizeFilenameCase('???')).toBe('system')
  })

  it('system 依平台決定：Windows/macOS 不分，Linux 區分', () => {
    expect(filenamesAreCaseInsensitive('system', 'Win32')).toBe(true)
    expect(filenamesAreCaseInsensitive('system', 'MacIntel')).toBe(true)
    expect(filenamesAreCaseInsensitive('system', 'Linux x86_64')).toBe(false)
    // 明確指定時平台不再有話語權
    expect(filenamesAreCaseInsensitive('sensitive', 'Win32')).toBe(false)
    expect(filenamesAreCaseInsensitive('insensitive', 'Linux x86_64')).toBe(true)
  })

  it('不分大小寫時 README 與 readme 配成一列，區分時是兩個孤兒', () => {
    const left = [entry({ name: 'README' })]
    const right = [entry({ name: 'readme', path: '/r/readme' })]

    const paired = compareEntries(left, right, 'name', 0, { caseInsensitive: true })
    expect(paired).toHaveLength(1)
    expect(paired[0].left).toBeTruthy()
    expect(paired[0].right).toBeTruthy()
    // 列名用真實存在的檔名，不是折疊後的鍵
    expect(paired[0].name).toBe('README')

    expect(compareEntries(left, right, 'name', 0, { caseInsensitive: false })).toHaveLength(2)
  })

  it('「大小寫算差異」把只差大小寫的一對標為不同，其他一對不受影響', () => {
    const opts = { caseInsensitive: true, compareFilenameCase: true }
    const cased = compareEntries(
      [entry({ name: 'README' })],
      [entry({ name: 'readme', path: '/r/readme' })], 'both', 0, opts)
    expect(cased[0].status).toBe('different')

    const identical = compareEntries(
      [entry({ name: 'a.txt' })],
      [entry({ name: 'a.txt', path: '/r/a.txt' })], 'both', 0, opts)
    expect(identical[0].status).toBe('same')
  })

  it('namesDifferOnlyByCase 不把不同的名字誤判成大小寫差異', () => {
    expect(namesDifferOnlyByCase({ name: 'A' }, { name: 'a' })).toBe(true)
    expect(namesDifferOnlyByCase({ name: 'a' }, { name: 'b' })).toBe(false)
    expect(namesDifferOnlyByCase({ name: 'a' }, null)).toBe(false)
  })

  it('入口：⚖ 規則面板的下拉與勾選框，套用後寫入設定', () => {
    stubApi()
    const { fc, host } = mounted()
    host.querySelector('.fc-btn-rules').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    host.querySelector('.fc-rules-name-case').value = 'insensitive'
    host.querySelector('.fc-compare-name-case').checked = true
    host.querySelector('.fc-rules-apply').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(fc.getFilenameCase()).toBe('insensitive')
    expect(fc.getCompareFilenameCase()).toBe(true)
    expect(fc.getConfig().filenameCase).toBe('insensitive')
  })
})

// ── 5. 檔名對齊規則 ──────────────────────────────────────────────────────────

describe('P2-5 檔名對齊規則', () => {
  it('解析 from=to，兩側都要剛好一個 *', () => {
    const ok = parseAlignRules('*.bak.txt=*.txt; *.cxx=*.cpp')
    expect(ok.errors).toEqual([])
    expect(ok.rules).toEqual([
      { from: '*.bak.txt', to: '*.txt' },
      { from: '*.cxx', to: '*.cpp' },
    ])
  })

  it('格式錯誤的規則被回報而不是靜默丟掉', () => {
    const bad = parseAlignRules('沒有等號; *.a=*.b; *=*.c=*.d; a.txt=b.txt; **.x=*.y')
    expect(bad.rules).toEqual([{ from: '*.a', to: '*.b' }])
    expect(bad.errors).toHaveLength(4)
    expect(bad.errors.join('\n')).toContain('沒有等號')
  })

  it('alignmentNameOf 套第一條命中的規則，且不串接（避免規則互換造成循環）', () => {
    const rules = [{ from: '*.bak.txt', to: '*.txt' }, { from: '*.txt', to: '*.md' }]
    expect(alignmentNameOf('report.bak.txt', rules)).toBe('report.txt')
    // 第一條命中後不再拿結果去跑第二條
    expect(alignmentNameOf('plain.txt', rules)).toBe('plain.md')
    expect(alignmentNameOf('other.log', rules)).toBe('other.log')
  })

  it('foo.bak.txt 與 foo.txt 落在同一個配對鍵上', () => {
    const rules = [{ from: '*.bak.txt', to: '*.txt' }]
    expect(pairKeyOf('foo.bak.txt', { alignRules: rules }))
      .toBe(pairKeyOf('foo.txt', { alignRules: rules }))
  })

  it('對齊規則與大小寫選項疊加', () => {
    const rules = [{ from: '*.bak.txt', to: '*.txt' }]
    expect(pairKeyOf('FOO.BAK.TXT', { alignRules: rules, caseInsensitive: true }))
      .toBe(pairKeyOf('foo.txt', { alignRules: rules, caseInsensitive: true }))
  })

  it('compareEntries 把兩個不同檔名放到一列，列名沿用左側真實檔名', () => {
    const rules = [{ from: '*.bak.txt', to: '*.txt' }]
    const rows = compareEntries(
      [entry({ name: 'foo.bak.txt', path: '/l/foo.bak.txt' })],
      [entry({ name: 'foo.txt', path: '/r/foo.txt' })],
      'name', 0, { alignRules: rules })
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('foo.bak.txt')
    expect(rows[0].left.path).toBe('/l/foo.bak.txt')
    expect(rows[0].right.path).toBe('/r/foo.txt')
  })

  it('對齊規則不會合併資料夾——否則一側的子項會被藏起來', () => {
    const rules = [{ from: '*.bak', to: '*' }]
    const rows = compareEntries(
      [entry({ name: 'src.bak', path: '/l/src.bak', isDirectory: true })],
      [entry({ name: 'src', path: '/r/src', isDirectory: true })],
      'name', 0, { alignRules: rules })
    expect(rows).toHaveLength(2)
  })

  it('攤平模式（pairFlatEntries）也吃同一套規則', () => {
    const rules = [{ from: '*.bak.txt', to: '*.txt' }]
    const rows = pairFlatEntries(
      [entry({ name: 'a.bak.txt', path: '/l/x/a.bak.txt' })],
      [entry({ name: 'a.txt', path: '/r/y/a.txt' })],
      'name', 0, { alignRules: rules })
    expect(rows).toHaveLength(1)
  })

  it('入口：⚖ 規則面板的輸入框；格式錯誤會跳 alert 而不是靜默', () => {
    stubApi()
    const { fc, host } = mounted()
    host.querySelector('.fc-btn-rules').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const input = host.querySelector('.fc-rules-align')
    expect(input).toBeTruthy()

    input.value = '*.bak.txt=*.txt; 壞掉的'
    host.querySelector('.fc-rules-apply').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(fc.getAlignRules()).toEqual([{ from: '*.bak.txt', to: '*.txt' }])
    expect(alerts.join('\n')).toContain('檔名對齊規則')
    expect(fc.getConfig().alignRules).toContain('*.bak.txt=*.txt')
  })
})

// ── 6. Quick Compare ─────────────────────────────────────────────────────────

describe('P2-6 Quick Compare', () => {
  /** 一棵有子層的樹，用來確認判定寫回的是模型本身而不是複本。 */
  function tree() {
    return [{
      name: 'dir', status: 'different',
      left: entry({ name: 'dir', path: '/l/dir', isDirectory: true }),
      right: entry({ name: 'dir', path: '/r/dir', isDirectory: true }),
      children: [{
        name: 'deep.txt', status: 'different', unimportant: true,
        left: entry({ name: 'deep.txt', path: '/l/dir/deep.txt', size: 5 }),
        right: entry({ name: 'deep.txt', path: '/r/dir/deep.txt', size: 5 }),
        children: null,
      }],
    }]
  }

  it('用大小與時間重新判定，覆蓋內容模式先前的判定', () => {
    stubApi()
    const { fc } = mounted({ mode: 'content' })
    fc._rows = tree()
    expect(fc.quickCompareAll()).toBe(1)
    const deep = [...eachRow(fc._rows)].find((r) => r.name === 'deep.txt')
    expect(deep.status).toBe('same')
    expect(deep.unimportant).toBe(false)
  })

  it('判定寫回的是模型本身：flattenRows 的複本看不到，eachRow 看得到', () => {
    stubApi()
    const { fc } = mounted({ mode: 'content' })
    fc._rows = tree()
    const copiesBefore = flattenRows(fc._rows)
    fc.quickCompareAll()

    // 先前取得的複本仍是舊值——正是 flattenRows 的陷阱
    expect(copiesBefore.find((r) => r.name === 'deep.txt').status).toBe('different')
    // 模型本身已更新
    expect([...eachRow(fc._rows)].find((r) => r.name === 'deep.txt').status).toBe('same')
  })

  it('只重判選取的列', () => {
    stubApi()
    const { fc } = mounted()
    fc._rows = [
      { name: 'a', status: 'different', left: entry({ name: 'a', path: '/l/a' }), right: entry({ name: 'a', path: '/r/a' }), children: null },
      { name: 'b', status: 'different', left: entry({ name: 'b', path: '/l/b' }), right: entry({ name: 'b', path: '/r/b' }), children: null },
    ]
    fc._selectedNames = new Set(['/l/a'])
    expect(fc.quickCompareSelected()).toBe(1)
    expect(fc._rows[0].status).toBe('same')
    expect(fc._rows[1].status).toBe('different')
  })

  it('沒有選取任何東西時明確告知，不靜默什麼都不做', () => {
    stubApi()
    const { fc } = mounted()
    fc._rows = []
    expect(fc.quickCompareSelected()).toBe(0)
    expect(alerts.join('\n')).toContain('快速比對')
  })

  it('入口：工具列「比對 ▾」與批次選單各有一項，右鍵選單也有', async () => {
    stubApi()
    const { fc, host } = mounted()
    const compareLabels = [...host.querySelectorAll('.fc-compare-item')].map((b) => b.textContent)
    expect(compareLabels.some((l) => l.includes('快速比對選取'))).toBe(true)
    expect(compareLabels.some((l) => l.includes('快速比對全部'))).toBe(true)

    const batchLabels = [...host.querySelectorAll('.fc-batch-item')].map((b) => b.textContent)
    expect(batchLabels.some((l) => l.includes('快速比對選取'))).toBe(true)

    fc._rows = [{
      name: 'a.txt', status: 'different',
      left: entry({ name: 'a.txt', path: '/l/a.txt' }),
      right: entry({ name: 'a.txt', path: '/r/a.txt' }),
      children: null,
    }]
    fc._applyFilterAndRender()
    expect(rowMenuLabels(host).some((l) => l.includes('快速比對此列'))).toBe(true)
  })

  it('入口真的接上了：按下工具列項目會改變判定', () => {
    stubApi()
    const { fc, host } = mounted()
    fc._rows = [{
      name: 'a.txt', status: 'different',
      left: entry({ name: 'a.txt', path: '/l/a.txt' }),
      right: entry({ name: 'a.txt', path: '/r/a.txt' }),
      children: null,
    }]
    const item = [...host.querySelectorAll('.fc-compare-item')]
      .find((b) => b.dataset.action === 'quick-compare-all')
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(fc._rows[0].status).toBe('same')
  })
})

// ── 7. Compare To ────────────────────────────────────────────────────────────

describe('P2-7 Compare To', () => {
  it('保留指定的一側，另一側換成使用者挑的資料夾', async () => {
    const api = stubApi({ openFolder: vi.fn().mockResolvedValue({ path: '/picked' }) })
    const { fc } = mounted()
    await fc.setLeft('/base')

    expect(await fc.compareTo('left')).toBe(true)
    expect(api.openFolder).toHaveBeenCalled()
    expect(fc._leftPath).toBe('/base')
    expect(fc._rightPath).toBe('/picked')
  })

  it('使用者取消對話框時什麼都不動', async () => {
    stubApi({ openFolder: vi.fn().mockResolvedValue(null) })
    const { fc } = mounted()
    await fc.setLeft('/base')
    expect(await fc.compareTo('left')).toBe(false)
    expect(fc._rightPath).toBeNull()
  })

  it('那一側還沒開資料夾時明確擋下，不悄悄開一個半邊的比對', async () => {
    const api = stubApi()
    const { fc } = mounted()
    expect(await fc.compareTo('left')).toBe(false)
    expect(api.openFolder).not.toHaveBeenCalled()
    expect(alerts.join('\n')).toContain('左側')
  })

  it('資料夾列的 compareFolderTo 一次換掉兩側，只掃描一次', async () => {
    const api = stubApi({ openFolder: vi.fn().mockResolvedValue({ path: '/other' }) })
    const { fc } = mounted()
    await fc.setLeft('/base')
    api.readDir.mockClear()

    expect(await fc.compareFolderTo('/base/sub', 'left')).toBe(true)
    expect(fc._leftPath).toBe('/base/sub')
    expect(fc._rightPath).toBe('/other')
    // 一次掃描 ⇒ 兩側各一次 readDir，不會先跟舊的右側比一輪
    expect(api.readDir).toHaveBeenCalledTimes(2)
  })

  it('入口：工具列「比對 ▾」兩項，資料夾列右鍵選單兩項', () => {
    stubApi()
    const { fc, host } = mounted()
    const labels = [...host.querySelectorAll('.fc-compare-item')].map((b) => b.textContent)
    expect(labels.some((l) => l.includes('保留左側'))).toBe(true)
    expect(labels.some((l) => l.includes('保留右側'))).toBe(true)

    fc._rows = [{
      name: 'dir', status: 'same',
      left: entry({ name: 'dir', path: '/l/dir', isDirectory: true }),
      right: entry({ name: 'dir', path: '/r/dir', isDirectory: true }),
      children: null,
    }]
    fc._applyFilterAndRender()
    const menu = rowMenuLabels(host)
    expect(menu.filter((l) => l.includes('以此資料夾與其他資料夾比對'))).toHaveLength(2)
  })
})
