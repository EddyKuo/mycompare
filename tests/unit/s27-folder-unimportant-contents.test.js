/**
 * @vitest-environment jsdom
 *
 * S27 — 資料夾比對的三項缺口：
 *   1. 「忽略不重要差異」在每個比對模式下都有明確語意；無法生效的模式要說出來
 *   2. Compare Contents 成為獨立主命令；單一節點展開／收合
 *   3. 一批小型篩選／顯示選項（一律顯示資料夾、暫停篩選、Regex、圖例、記錄）
 *
 * 每組都同時斷言行為與**入口**：真的去工具列／比對選單／右鍵選單裡按下去。
 * 篩選相關的斷言用數萬列驗證，確保沒有繞過虛擬捲動。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { setActiveView } from '../../src/renderer/src/core/active-view.js'
import {
  FolderCompare,
  FOLDER_UNIMPORTANT_SEMANTICS,
  unimportantSupportFor,
  markTimestampOnlyUnimportant,
  isProgressMessage,
  compileQuickFilterRegex,
  rollupStatus,
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
    openFolder: vi.fn().mockResolvedValue({ path: '/dest' }),
    readMetadata: vi.fn().mockResolvedValue(null),
    hashFile: vi.fn().mockResolvedValue('h'),
    copyFile: vi.fn().mockResolvedValue({ copied: true }),
    showInExplorer: vi.fn(),
    ...over,
  }
  window.electronAPI = api
  return api
}

function mounted(options = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const fc = new FolderCompare(options)
  fc.mount(host)
  mountedViews.push(fc)
  return { fc, host }
}

/** @param {object} o */
function entry(o = {}) {
  return {
    name: o.name ?? 'a.txt',
    path: o.path ?? '/left/a.txt',
    isDirectory: !!o.isDirectory,
    size: o.size ?? 10,
    mtime: o.mtime ?? '2024-01-01T00:00:00.000Z',
    ...o,
  }
}

/** @param {object} o */
function row(o = {}) {
  const name = o.name ?? 'a.txt'
  return {
    name,
    status: o.status ?? 'different',
    left: o.left === null ? null : entry({ name, path: `/left/${name}`, ...o.left }),
    right: o.right === null ? null : entry({ name, path: `/right/${name}`, ...o.right }),
    children: o.children ?? null,
  }
}

/** @param {HTMLElement} host */
function compareMenuLabels(host) {
  return [...host.querySelectorAll('.fc-compare-item')].map((b) => b.textContent)
}

/**
 * Right-click the first rendered row and return the menu labels.
 * @param {HTMLElement} host
 * @param {number} [index]
 */
function contextMenuLabels(host, index = 0) {
  const rowEl = host.querySelectorAll('.fc-row')[index]
  rowEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
  return menuItems.map((i) => i.label ?? '(分隔線)')
}

// ── 1. Ignore Unimportant Differences：各模式語意 ─────────────────────────────

describe('忽略不重要差異：每個模式都有明確語意', () => {
  it('六個模式全部有定義，且三個判準模式無法產生不重要差異', () => {
    expect(Object.keys(FOLDER_UNIMPORTANT_SEMANTICS).sort())
      .toEqual(['both', 'content', 'mtime', 'name', 'rules', 'size'])
    for (const mode of ['name', 'size', 'mtime']) {
      expect(unimportantSupportFor(mode).supported).toBe(false)
      expect(unimportantSupportFor(mode).note.length).toBeGreaterThan(0)
    }
    for (const mode of ['both', 'content', 'rules']) {
      expect(unimportantSupportFor(mode).supported).toBe(true)
    }
    // 未知模式不丟例外，仍給得出一句說明
    expect(unimportantSupportFor('nope').supported).toBe(false)
    expect(unimportantSupportFor('nope').note).toBeTruthy()
  })

  it('入口：無法生效的模式把勾選框停用並在 label 上說明原因', () => {
    stubApi()
    // 預設模式是「名稱+修改時間」——正是這個開關無法生效的模式
    const { fc, host } = mounted()
    const cb = host.querySelector('#fc-ignore-unimportant')
    expect(cb.disabled).toBe(true)
    expect(cb.closest('label').title).toContain('此模式無法使用')
    expect(cb.closest('label').classList.contains('fc-cb--unavailable')).toBe(true)

    // 切到支援的模式後才可按，且說明改成語意本身
    fc._mode = 'rules'
    fc._syncViewModeControls()
    expect(cb.disabled).toBe(false)
    expect(cb.closest('label').title).toContain('次要差異')
  })

  it('入口：從工具列的模式下拉切換即會重新判定勾選框可用性', () => {
    stubApi()
    const { fc, host } = mounted()
    const select = host.querySelector('.fc-compare-mode')
    select.value = 'both'
    select.dispatchEvent(new Event('change'))
    expect(fc._mode).toBe('both')
    expect(host.querySelector('#fc-ignore-unimportant').disabled).toBe(false)
  })

  it('「名稱+大小+時間」：大小相同、只有時間不同 → 不重要差異', async () => {
    stubApi()
    const { fc } = mounted({ mode: 'both' })
    const rows = [
      row({ name: 'time.txt', status: 'left-newer' }),
      row({ name: 'size.txt', status: 'different' }),
      row({ name: 'orphan.txt', status: 'left-only', right: null }),
    ]
    await fc._applyDeepCompare(rows)
    expect(rows[0].unimportant).toBe(true)
    expect(rows[1].unimportant).toBeFalsy()
    expect(rows[2].unimportant).toBeFalsy()
  })

  it('markTimestampOnlyUnimportant 也寫得進子層（走 eachRow，不是複本）', () => {
    const child = row({ name: 'deep.txt', status: 'right-newer' })
    const dir = row({
      name: 'd',
      status: 'different',
      left: { isDirectory: true },
      right: { isDirectory: true },
      children: [child],
    })
    expect(markTimestampOnlyUnimportant([dir])).toBe(1)
    expect(child.unimportant).toBe(true)
    // 目錄本身沒有時間戳語意，不會被標
    expect(dir.unimportant).toBeFalsy()
  })

  it('「內容 (MD5)」：雜湊相同但中繼資料不同 → 標為不重要而非默默抹平', async () => {
    stubApi({ hashFile: vi.fn().mockResolvedValue('same-hash') })
    const { fc } = mounted({ mode: 'content' })
    const rows = [row({ name: 'a.txt', status: 'left-newer' })]
    await fc._applyDeepCompare(rows)
    expect(rows[0].status).toBe('same')
    expect(rows[0].unimportant).toBe(true)
  })

  it('開關開啟時，只有時間不同的列不再算差異，也不再讓上層目錄變色', () => {
    stubApi()
    const { fc } = mounted({ mode: 'both' })
    const child = row({ name: 'x.txt', status: 'left-newer' })
    child.unimportant = true
    const dir = row({
      name: 'd',
      status: 'different',
      left: { isDirectory: true },
      right: { isDirectory: true },
      children: [child],
    })
    fc._rows = [dir]

    fc.setIgnoreUnimportant(false)
    expect(dir.status).toBe('left-newer')
    expect(fc._countsAsDifference(child)).toBe(true)

    fc.setIgnoreUnimportant(true)
    expect(dir.status).toBe('same')
    expect(fc._countsAsDifference(child)).toBe(false)
  })

  it('開關關閉時，只有時間不同的列仍受「左較新／右較新」篩選管轄', () => {
    stubApi()
    const { fc } = mounted({ mode: 'both' })
    const r = row({ name: 'x.txt', status: 'left-newer' })
    r.unimportant = true
    fc._rows = [r]
    fc._showLeftNewer = false
    fc._applyFilterAndRender()
    expect(fc._visibleRows).toHaveLength(0)
  })

  it('rollupStatus 只有在被要求時才忽略不重要的子項', () => {
    const dir = {
      name: 'd', status: 'same',
      children: [{ name: 'x', status: 'left-newer', unimportant: true, children: null }],
    }
    expect(rollupStatus(dir)).toBe('left-newer')
    expect(rollupStatus(dir, { ignoreUnimportant: true })).toBe('same')
  })
})

// ── 2. Compare Contents 主命令 + 單節點展開／收合 ────────────────────────────

describe('Compare Contents（獨立主命令）', () => {
  it('入口：比對選單同時有「選取」與「全部」兩個項目', () => {
    stubApi()
    const { host } = mounted()
    const labels = compareMenuLabels(host)
    expect(labels.some((l) => l.includes('比對內容') && l.includes('選取'))).toBe(true)
    expect(labels.some((l) => l.includes('比對內容') && l.includes('全部'))).toBe(true)
  })

  it('依實際內容改判，不動到 session 的比對模式', async () => {
    const api = stubApi({
      hashFile: vi.fn((p) => Promise.resolve(p.startsWith('/left') ? 'A' : 'A')),
    })
    const { fc } = mounted({ mode: 'mtime' })
    fc._rows = [row({ name: 'a.txt', status: 'left-newer' })]
    const graded = await fc.compareContentsAll()
    expect(graded).toBe(1)
    expect(fc._rows[0].status).toBe('same')
    // 內容相同、只剩時間不同 → 不重要差異
    expect(fc._rows[0].unimportant).toBe(true)
    expect(fc._mode).toBe('mtime')
    expect(api.hashFile).toHaveBeenCalledTimes(2)
  })

  it('內容不同時判為 different，且不標成不重要', async () => {
    stubApi({ hashFile: vi.fn((p) => Promise.resolve(p.startsWith('/left') ? 'A' : 'B')) })
    const { fc } = mounted()
    fc._rows = [row({ name: 'a.txt', status: 'same' })]
    await fc.compareContentsAll()
    expect(fc._rows[0].status).toBe('different')
    expect(fc._rows[0].unimportant).toBe(false)
  })

  it('讀不到檔案時把失敗列數說出來，不當成相同', async () => {
    stubApi({ hashFile: vi.fn().mockRejectedValue(new Error('EACCES')) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fc, host } = mounted()
    fc._rows = [row({ name: 'a.txt', status: 'different' })]
    await fc.compareContentsAll()
    expect(fc._rows[0].status).toBe('different')
    expect(host.querySelector('.fc-scan-status').textContent).toContain('無法讀取')
  })

  it('沒有雜湊 IPC 時明說，不靜默無事發生', async () => {
    stubApi({ hashFile: undefined })
    const { fc } = mounted()
    fc._rows = [row({ name: 'a.txt', status: 'different' })]
    expect(await fc.compareContentsAll()).toBe(0)
    expect(alerts.join()).toContain('無法比對內容')
  })

  it('未勾選也未選取時要求先選，而不是默默比對全部', async () => {
    stubApi()
    const { fc } = mounted()
    fc._rows = [row({ name: 'a.txt', status: 'different' })]
    expect(await fc.compareContentsSelected()).toBe(0)
    expect(alerts.join()).toContain('請先勾選')
  })

  it('只比對勾選的列', async () => {
    const api = stubApi({ hashFile: vi.fn().mockResolvedValue('A') })
    const { fc } = mounted()
    fc._rows = [row({ name: 'a.txt', status: 'different' }), row({ name: 'b.txt', status: 'different' })]
    fc._selectedNames = new Set(['/left/a.txt'])
    await fc.compareContentsSelected()
    expect(api.hashFile).toHaveBeenCalledTimes(2)
    expect(fc._rows[0].status).toBe('same')
    expect(fc._rows[1].status).toBe('different')
  })

  it('入口：右鍵選單有「比對此列的內容」', () => {
    stubApi()
    const { fc, host } = mounted()
    fc._rows = [row({ name: 'a.txt', status: 'different' })]
    fc._applyFilterAndRender()
    expect(contextMenuLabels(host).join()).toContain('比對此列的內容')
  })
})

describe('單一節點展開／收合', () => {
  /** 一個兩層的目錄樹，readDir 依路徑回不同子項 */
  function tree() {
    const api = stubApi({
      readDir: vi.fn((p) => Promise.resolve(
        p.endsWith('/d') ? [
          { name: 'sub', path: `${p}/sub`, isDirectory: true, size: 0, mtime: '2024-01-01T00:00:00.000Z' },
        ] : p.endsWith('/sub') ? [
          { name: 'leaf.txt', path: `${p}/leaf.txt`, isDirectory: false, size: 1, mtime: '2024-01-01T00:00:00.000Z' },
        ] : [])),
    })
    const { fc, host } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    fc._rows = [row({
      name: 'd', status: 'same',
      left: { isDirectory: true, path: '/left/d' },
      right: { isDirectory: true, path: '/right/d' },
    })]
    fc._applyFilterAndRender()
    return { fc, host, api }
  }

  it('expandNode 只載入這個節點底下的層級', async () => {
    const { fc, api } = tree()
    await fc.expandNode(fc._rows[0], 0)
    // /left/d + /right/d + /left/d/sub + /right/d/sub —— 沒有其他分支
    expect(api.readDir.mock.calls.map((c) => c[0]).sort())
      .toEqual(['/left/d', '/left/d/sub', '/right/d', '/right/d/sub'])
    expect(fc._visibleRows.map((f) => f.row.name)).toEqual(['d', 'sub', 'leaf.txt'])
  })

  it('collapseNode 收掉整個子樹，但子項留在模型裡', async () => {
    const { fc } = tree()
    await fc.expandNode(fc._rows[0], 0)
    expect(fc.collapseNode(fc._rows[0], 0)).toBe(2)
    expect(fc._visibleRows.map((f) => f.row.name)).toEqual(['d'])
    expect(fc._rows[0].children[0].children).toHaveLength(1)
  })

  it('非目錄的列沒有節點可展開', async () => {
    stubApi()
    const { fc } = mounted()
    const file = row({ name: 'a.txt', status: 'same' })
    expect(await fc.expandNode(file, 0)).toBe(0)
    expect(fc.collapseNode(file, 0)).toBe(0)
  })

  it('入口：目錄列的右鍵選單有展開／收合此節點', () => {
    const { host } = tree()
    const labels = contextMenuLabels(host).join()
    expect(labels).toContain('展開此節點')
    expect(labels).toContain('收合此節點')
  })
})

// ── 3. 小型篩選／顯示選項 ────────────────────────────────────────────────────

describe('一律顯示資料夾 / 暫停篩選 / Regex 篩選', () => {
  /** 一個資料夾 + 兩個檔案的平面樹 */
  function withFilterable() {
    stubApi()
    const { fc, host } = mounted()
    fc._rows = [
      row({ name: 'src', status: 'same', left: { isDirectory: true }, right: { isDirectory: true } }),
      row({ name: 'a.js', status: 'different' }),
      row({ name: 'b.txt', status: 'different' }),
    ]
    fc._filterStr = '*.js'
    fc._applyFilterAndRender()
    return { fc, host }
  }

  it('一律顯示資料夾：遮罩不再把資料夾濾掉', () => {
    const { fc, host } = withFilterable()
    expect(fc._visibleRows.map((f) => f.row.name)).toEqual(['a.js'])

    const cb = host.querySelector('#fc-always-folders')
    cb.checked = true
    cb.dispatchEvent(new Event('change'))
    expect(fc.getAlwaysShowFolders()).toBe(true)
    expect(fc._visibleRows.map((f) => f.row.name)).toEqual(['src', 'a.js'])
  })

  it('暫停篩選：全部顯示，但輸入的遮罩留著', () => {
    const { fc, host } = withFilterable()
    const cb = host.querySelector('#fc-suppress-filters')
    cb.checked = true
    cb.dispatchEvent(new Event('change'))
    expect(fc._visibleRows.map((f) => f.row.name)).toEqual(['src', 'a.js', 'b.txt'])
    expect(fc._filterStr).toBe('*.js')

    cb.checked = false
    cb.dispatchEvent(new Event('change'))
    expect(fc._visibleRows.map((f) => f.row.name)).toEqual(['a.js'])
  })

  it('Regex 模式：快速篩選改以正規表示式解讀', () => {
    const { fc, host } = withFilterable()
    const cb = host.querySelector('#fc-filter-regex')
    cb.checked = true
    cb.dispatchEvent(new Event('change'))
    fc._filterStr = '\\.(js|txt)$'
    fc._applyFilterAndRender()
    // 遮罩語法的 `*.js` 只留 a.js；同一個框改以 regex 解讀後兩個檔案都符合，
    // 而沒有副檔名的資料夾 src 仍然被濾掉。
    expect(fc._visibleRows.map((f) => f.row.name)).toEqual(['a.js', 'b.txt'])
  })

  it('Regex 無效時說出原因，且不假裝全部符合', () => {
    const { fc, host } = withFilterable()
    fc.setFilterRegex(true)
    fc._filterStr = '('
    fc._applyFilterAndRender()
    expect(fc._visibleRows.map((f) => f.row.name)).toEqual([])
    expect(host.querySelector('.fc-scan-status').textContent).toContain('Regex 篩選無效')
    expect(compileQuickFilterRegex('(').re).toBeNull()
  })

  it('數萬列下仍走虛擬捲動：只渲染可見窗格', () => {
    stubApi()
    const { fc, host } = mounted()
    const rows = []
    for (let i = 0; i < 30_000; i++) {
      rows.push(row({ name: i % 2 ? `f${i}.js` : `f${i}.txt`, status: 'different' }))
    }
    fc._rows = rows
    fc.setFilterRegex(true)
    fc._filterStr = '\\.js$'
    fc._applyFilterAndRender()
    expect(fc._visibleRows).toHaveLength(15_000)
    expect(host.querySelectorAll('.fc-row').length).toBeLessThan(200)
  })
})

describe('圖例與記錄面板', () => {
  it('入口：工具列的圖例按鈕開合面板，且列出每個狀態', () => {
    stubApi()
    const { fc, host } = mounted()
    const panel = host.querySelector('.fc-legend')
    expect(panel.style.display).toBe('none')
    host.querySelector('.fc-btn-legend').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(panel.style.display).toBe('flex')
    expect(panel.textContent).toContain('不重要差異')
    expect(panel.querySelectorAll('.fc-legend-item').length).toBeGreaterThanOrEqual(7)
    expect(fc.toggleLegend()).toBe(false)
  })

  it('記錄面板留下狀態列一閃即逝的訊息，但不收進度回報', () => {
    stubApi()
    const { fc, host } = mounted()
    fc._setScanStatus('掃描中… 120 項')
    fc._setScanStatus('無法讀取「/left/x」（EACCES）')
    fc._setScanStatus('無法讀取「/left/x」（EACCES）')
    expect(fc.getLog()).toEqual(['無法讀取「/left/x」（EACCES）'])
    expect(isProgressMessage('掃描中… 1 項')).toBe(true)
    expect(isProgressMessage('無法讀取')).toBe(false)

    host.querySelector('.fc-btn-log').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(host.querySelector('.fc-log').style.display).toBe('flex')
    expect(host.querySelector('.fc-log-lines').textContent).toContain('EACCES')

    host.querySelector('.fc-log-clear').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(fc.getLog()).toEqual([])
  })
})

describe('新旗標進得了 config 並回得來', () => {
  it('getConfig / applyConfig 往返', () => {
    stubApi()
    const { fc } = mounted()
    fc.setAlwaysShowFolders(true)
    fc.setSuppressFilters(true)
    fc.setFilterRegex(true)
    const cfg = fc.getConfig()
    expect(cfg.alwaysShowFolders).toBe(true)
    expect(cfg.suppressFilters).toBe(true)
    expect(cfg.filterRegex).toBe(true)

    const { fc: other } = mounted()
    expect(other.applyConfig(cfg)).toBe(true)
    expect(other.getAlwaysShowFolders()).toBe(true)
    expect(other.getSuppressFilters()).toBe(true)
    expect(other.getFilterRegex()).toBe(true)
  })
})
