/**
 * @vitest-environment jsdom
 *
 * Image Compare — the BC picture-compare features gap-matrix-v4 item 12 left out:
 *   Blend Toggle（單鍵循環）
 *   自訂色票（任意 hex）
 *   Compare Metadata（中繼資料差異計入比對結果）
 *   Replacements + Ignore Unimportant Differences
 *   Difference Offset / Reset Difference Offset
 *
 * The DOM-level assertions matter as much as the pure-function ones: this view
 * has previously shipped a control wired to an unreachable branch, so every
 * feature here is also driven through the control the user actually sees.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'

/** @type {any} */
let mod

beforeAll(async () => {
  mod = await import('../../src/renderer/src/views/image-compare.js')
})

/**
 * @param {number} w
 * @param {number} h
 * @param {[number, number, number]} rgb
 * @returns {Uint8ClampedArray}
 */
function solid(w, h, rgb) {
  const buf = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = rgb[0]
    buf[i * 4 + 1] = rgb[1]
    buf[i * 4 + 2] = rgb[2]
    buf[i * 4 + 3] = 255
  }
  return buf
}

/** @param {Array<[number, number, number]>} pixels @returns {Uint8ClampedArray} */
function fromPixels(pixels) {
  const buf = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach((p, i) => {
    buf[i * 4] = p[0]
    buf[i * 4 + 1] = p[1]
    buf[i * 4 + 2] = p[2]
    buf[i * 4 + 3] = 255
  })
  return buf
}

// ── Custom highlight colour ──────────────────────────────────────────────────

describe('自訂色票', () => {
  it('parseHexColor 接受 #rgb 與 #rrggbb，並拒絕其他輸入', () => {
    expect(mod.parseHexColor('#f80')).toEqual([255, 136, 0])
    expect(mod.parseHexColor('#FF8800')).toEqual([255, 136, 0])
    expect(mod.parseHexColor('ff8800')).toEqual([255, 136, 0])
    expect(mod.parseHexColor('#gg0000')).toBeNull()
    expect(mod.parseHexColor('red')).toBeNull()
    expect(mod.parseHexColor(null)).toBeNull()
    expect(mod.parseHexColor(0xff8800)).toBeNull()
  })

  it('normalizeHexColor 一律回傳 6 位小寫形式', () => {
    expect(mod.normalizeHexColor('#F80')).toBe('#ff8800')
    expect(mod.normalizeHexColor('#00FF00')).toBe('#00ff00')
    expect(mod.normalizeHexColor('nope')).toBeNull()
  })

  it('highlightRGBA 對 hex 與具名色都有效，且未知輸入退回預設', () => {
    expect(mod.highlightRGBA('#00ff00', mod.MISMATCH_LEVELS)).toEqual([0, 255, 0, 200])
    expect(mod.highlightRGBA('green', mod.MISMATCH_LEVELS)).toEqual([0, 220, 0, 200])
    // 舊行為：無法解讀的鍵不得丟例外，而是退回預設紅。
    // 不能只寫「等於 highlightRGBA('red')」——那是拿同一個函式跟自己比，
    // 預設色若整個換掉（例如變黑）兩邊仍會相等而通過。
    expect(mod.highlightRGBA('red')).toEqual([255, 0, 0, 200])
    expect(mod.highlightRGBA('chartreuse')).toEqual([255, 0, 0, 200])
  })

  it('highlightColorLabel 讓報表不會印出裸 hex 而沒有說明', () => {
    expect(mod.highlightColorLabel('red')).toBe('紅')
    expect(mod.highlightColorLabel('#ff8800')).toBe('自訂 #ff8800')
  })

  it('自訂色實際套用到差異像素上', () => {
    const w = 1, h = 1
    const out = new Uint8ClampedArray(4)
    mod.computeDiffBuffer({
      leftData: solid(w, h, [0, 0, 0]),
      rightData: solid(w, h, [255, 255, 255]),
      out, width: w, height: h, lw: w, lh: h, rw: w, rh: h,
      threshold: 0, algorithm: 'exact',
      highlightColor: '#00ff00',
    })
    expect([out[0], out[1], out[2]]).toEqual([0, 255, 0])
  })
})

// ── Replacements ─────────────────────────────────────────────────────────────

describe('取代規則（Replacements）', () => {
  it('buildReplacementMap 忽略無效與恆等規則', () => {
    expect(mod.buildReplacementMap([])).toBeNull()
    expect(mod.buildReplacementMap(null)).toBeNull()
    expect(mod.buildReplacementMap([{ from: '#ffffff', to: '#ffffff' }])).toBeNull()
    expect(mod.buildReplacementMap([{ from: 'nope', to: '#000000' }])).toBeNull()
    const map = mod.buildReplacementMap([{ from: '#ff0000', to: '#00ff00' }])
    expect(map.get((255 << 16))).toBe(255 << 8)
  })

  it('鏈式規則被展開，循環不會無限迴圈', () => {
    const map = mod.buildReplacementMap([
      { from: '#010000', to: '#020000' },
      { from: '#020000', to: '#030000' },
    ])
    // a→b→c 應直接解析為 a→c，內層迴圈才不必追鏈
    expect(map.get(1 << 16)).toBe(3 << 16)

    // a→b→a：解析 a 時沿鏈走回 a 就停手，於是兩條規則都收斂成恆等對映。
    // 只斷言 size 是沒有意義的——任何「還剩兩個 key」的壞行為都會通過。
    // 這裡把值釘死：循環被打斷的方式必須是「兩條規則都變成 no-op」，
    // 而不是任選一個當代表色（那會讓 a 與 b 被判為同色）。
    const A = 1 << 16
    const B = 2 << 16
    const cyclic = mod.buildReplacementMap([
      { from: '#010000', to: '#020000' },
      { from: '#020000', to: '#010000' },
    ])
    expect([...cyclic.entries()].sort((x, y) => x[0] - y[0]))
      .toEqual([[A, A], [B, B]])
  })

  it('循環規則不會讓兩個不相干的顏色被判為相同像素', () => {
    // 打斷循環的方式若挑了任一個當代表色，A 與 B 會一起映到同一個值，
    // computeDiffBuffer 就會把它們算成「不重要差異」而從差異數中消失。
    // 這條測的是那個下游後果，不是 map 的形狀。
    const w = 1, h = 1
    const counters = { unimportant: 0 }
    const out = new Uint8ClampedArray(4)
    const diffCount = mod.computeDiffBuffer({
      leftData: fromPixels([[1, 0, 0]]),
      rightData: fromPixels([[2, 0, 0]]),
      out, width: w, height: h, lw: w, lh: h, rw: w, rh: h,
      threshold: 0, algorithm: 'exact',
      replacements: mod.buildReplacementMap([
        { from: '#010000', to: '#020000' },
        { from: '#020000', to: '#010000' },
      ]),
      counters,
    })
    expect(diffCount).toBe(1)
    expect(counters.unimportant).toBe(0)
    // 且要以一般差異色標示，不是「不重要差異」的藍
    expect([out[0], out[1], out[2], out[3]]).toEqual(mod.highlightRGBA('red'))
  })

  it('normalizeReplacements 丟掉壞資料並套用上限', () => {
    expect(mod.normalizeReplacements('nope')).toEqual([])
    expect(mod.normalizeReplacements([{ from: '#f00', to: 'x' }])).toEqual([])
    expect(mod.normalizeReplacements([{ from: '#F00', to: '#0f0' }]))
      .toEqual([{ from: '#ff0000', to: '#00ff00' }])
    // 上限測試給每條規則不同的顏色，否則「回傳一堆空物件」也會通過長度檢查，
    // 而且看不出被截掉的是尾端還是頭端。
    const many = Array.from({ length: mod.MAX_REPLACEMENT_RULES + 10 },
      (_, i) => ({ from: `#${i.toString(16).padStart(2, '0')}0000`, to: '#00ff00' }))
    const capped = mod.normalizeReplacements(many)
    expect(capped.length).toBe(mod.MAX_REPLACEMENT_RULES)
    expect(capped[0]).toEqual({ from: '#000000', to: '#00ff00' })
    expect(capped[capped.length - 1]).toEqual({
      from: `#${(mod.MAX_REPLACEMENT_RULES - 1).toString(16).padStart(2, '0')}0000`,
      to: '#00ff00',
    })
  })

  it('被規則涵蓋的差異不計入差異像素數，並以藍色標示', () => {
    const w = 2, h = 1
    const out = new Uint8ClampedArray(w * h * 4)
    const counters = { unimportant: 0 }
    const diffCount = mod.computeDiffBuffer({
      // 像素 0：紅 vs 綠（有規則）；像素 1：黑 vs 白（無規則）
      leftData: fromPixels([[255, 0, 0], [0, 0, 0]]),
      rightData: fromPixels([[0, 255, 0], [255, 255, 255]]),
      out, width: w, height: h, lw: w, lh: h, rw: w, rh: h,
      threshold: 0, algorithm: 'exact',
      replacements: mod.buildReplacementMap([{ from: '#ff0000', to: '#00ff00' }]),
      counters,
    })
    expect(diffCount).toBe(1)
    expect(counters.unimportant).toBe(1)
    expect([out[0], out[1], out[2], out[3]]).toEqual(mod.UNIMPORTANT_RGBA)
  })

  it('沒有規則時行為與未加入本功能前完全相同', () => {
    const w = 4, h = 4
    const mk = () => new Uint8ClampedArray(w * h * 4)
    const a = mk()
    const b = mk()
    const counters = { unimportant: 0 }
    const withOpt = mod.computeDiffBuffer({
      leftData: solid(w, h, [10, 20, 30]),
      rightData: solid(w, h, [40, 50, 60]),
      out: a, width: w, height: h, lw: w, lh: h, rw: w, rh: h,
      threshold: 0, algorithm: 'exact', replacements: null, counters,
    })
    const without = mod.computeDiffBuffer({
      leftData: solid(w, h, [10, 20, 30]),
      rightData: solid(w, h, [40, 50, 60]),
      out: b, width: w, height: h, lw: w, lh: h, rw: w, rh: h,
      threshold: 0, algorithm: 'exact',
    })
    // 只寫 withOpt === without 是拿同一個函式跟自己比：兩邊一起壞成 0 也會通過。
    // 先把「本來就該是什麼」釘死，等價性才有內容。
    expect(without).toBe(w * h)
    expect(withOpt).toBe(without)
    expect(counters.unimportant).toBe(0)
    // 同理，兩個 buffer 全是 0 也會 toEqual 成功，所以先驗證確實畫了差異色。
    expect([b[0], b[1], b[2], b[3]]).toEqual(mod.highlightRGBA('red'))
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})

// ── Difference offset ────────────────────────────────────────────────────────

describe('差異位移（Difference Offset）', () => {
  it('位移把錯開的兩張圖對回相同', () => {
    // 左圖：第 0 欄白、其餘黑；右圖：第 1 欄白、其餘黑。位移 +1 後應完全相同。
    const w = 3, h = 1
    const left = fromPixels([[255, 255, 255], [0, 0, 0], [0, 0, 0]])
    const right = fromPixels([[0, 0, 0], [255, 255, 255], [0, 0, 0]])

    const plain = mod.computeDiffBuffer({
      leftData: left, rightData: right,
      out: new Uint8ClampedArray(w * h * 4),
      width: w, height: h, lw: w, lh: h, rw: w, rh: h,
      threshold: 0, algorithm: 'exact',
    })
    expect(plain).toBe(2)

    // 右圖往左移一格（offsetX = -1）後，第 0/1 欄對齊；第 2 欄的右側取樣落在
    // 圖外，仍算差異——這是誠實的，該處確實沒有可比對的資料。
    const shifted = mod.computeDiffBuffer({
      leftData: left, rightData: right,
      out: new Uint8ClampedArray(w * h * 4),
      width: w, height: h, lw: w, lh: h, rw: w, rh: h,
      threshold: 0, algorithm: 'exact', offsetX: -1,
    })
    expect(shifted).toBe(1)
  })

  it('位移超出圖片範圍時整張都算差異，不會讀到錯誤的像素', () => {
    const w = 2, h = 2
    const count = mod.computeDiffBuffer({
      leftData: solid(w, h, [1, 2, 3]),
      rightData: solid(w, h, [1, 2, 3]),
      out: new Uint8ClampedArray(w * h * 4),
      width: w, height: h, lw: w, lh: h, rw: w, rh: h,
      threshold: 0, algorithm: 'exact', offsetX: 99, offsetY: 99,
    })
    expect(count).toBe(w * h)
  })
})

// ── Compare Metadata ─────────────────────────────────────────────────────────

describe('Compare Metadata', () => {
  const meta = (fields) => ({ container: 'JPEG', supported: true, fields })

  it('只列出真正不同的欄位', () => {
    const diffs = mod.metadataFieldDiffs(
      meta([['相機型號', 'A'], ['ISO', '100']]),
      meta([['相機型號', 'B'], ['ISO', '100']]))
    expect(diffs).toEqual([{ label: '相機型號', left: 'A', right: 'B' }])
  })

  it('單側才有的欄位標為「無此欄位」', () => {
    const diffs = mod.metadataFieldDiffs(meta([['ISO', '100']]), meta([]))
    expect(diffs).toEqual([{ label: 'ISO', left: '100', right: '（無此欄位）' }])
  })

  it('讀不出檔頭的格式不會被報成「與對側不同」', () => {
    // 否則差異來源會是本讀取器的能力，而不是檔案本身。
    const unsupported = { container: 'TIFF', supported: false, fields: [] }
    expect(mod.metadataFieldDiffs(unsupported, meta([['ISO', '100']])))
      .toEqual([{ label: 'ISO', left: '（無此欄位）', right: '100' }])
    expect(mod.metadataFieldDiffs(unsupported, unsupported)).toEqual([])
    expect(mod.metadataFieldDiffs(null, null)).toEqual([])
  })

  it('重複標籤取第一個值', () => {
    const diffs = mod.metadataFieldDiffs(
      meta([['方向', '正常'], ['方向', '旋轉 90°']]),
      meta([['方向', '正常']]))
    expect(diffs).toEqual([])
  })

  it('metadataDiffRows 關閉時明說「不計入比對結果」', () => {
    expect(mod.metadataDiffRows([], false)[0][1]).toMatch(/不計入比對結果/)
    expect(mod.metadataDiffRows([], true)[0][1]).toMatch(/相同/)
    expect(mod.metadataDiffRows([{ label: 'ISO', left: '100', right: '200' }], true))
      .toEqual([['ISO', '左：100　右：200']])
  })
})

// ── Report ───────────────────────────────────────────────────────────────────

describe('報表帶上新設定', () => {
  const info = (over = {}) => ({
    leftPath: 'a.png', rightPath: 'b.png',
    leftSize: { w: 2, h: 2 }, rightSize: { w: 2, h: 2 },
    diffCount: 1, totalPixels: 4, approximate: false, regionCount: 1,
    threshold: 0.1, algorithm: 'exact', autoScale: false, mismatchRange: false,
    blendMode: 'difference', blendRatio: 1, highlightColor: 'red',
    ...over,
  })

  it('參數表列出位移、中繼資料比對、取代規則與不重要差異', () => {
    const rows = Object.fromEntries(mod.imageReportParameters(info({
      diffOffset: { x: 3, y: -2 },
      compareMetadata: true,
      metadataDiffs: [{ label: 'ISO', left: '100', right: '200' }],
      replacements: [{ from: '#ff0000', to: '#00ff00' }],
      ignoreUnimportant: true,
      unimportantCount: 7,
    })))
    expect(rows['差異位移']).toBe('X 3, Y -2')
    expect(rows['中繼資料比對']).toContain('差異 1 項')
    expect(rows['取代規則']).toContain('1 條')
    expect(rows['取代規則']).toContain('已套用')
    expect(rows['不重要差異像素']).toBe('7')
  })

  it('自訂色在報表中可辨識', () => {
    const rows = Object.fromEntries(
      mod.imageReportParameters(info({ highlightColor: '#123456' })))
    expect(rows['標示色']).toBe('自訂 #123456')
  })

  it('純文字報表含中繼資料差異區塊', () => {
    const text = mod.buildImageTextReport(info({
      compareMetadata: true,
      metadataDiffs: [{ label: 'ISO', left: '100', right: '200' }],
    }))
    expect(text).toContain('中繼資料差異')
    expect(text).toContain('左：100　右：200')
  })
})

// ── View wiring ──────────────────────────────────────────────────────────────

describe('ImageCompare 控制項接線', () => {
  /** @type {any} */
  let view
  /** @type {HTMLElement} */
  let host

  beforeEach(() => {
    document.body.replaceChildren()
    host = document.createElement('div')
    document.body.appendChild(host)
    view = new mod.ImageCompare()
    view.mount(host)
  })

  it('每個新控制項都在工具列上存在', () => {
    for (const sel of [
      '.ic-btn-blend-toggle', '.ic-highlight-swatch', '.ic-compare-meta-check',
      '.ic-ignore-unimportant-check', '.ic-btn-replacements', '.ic-offset-input',
      '.ic-btn-reset-offset',
    ]) {
      expect(host.querySelector(sel), sel).toBeTruthy()
    }
  })

  it('Blend Toggle 按鈕循環三種模式並同步下拉選單', () => {
    const btn = host.querySelector('.ic-btn-blend-toggle')
    const sel = host.querySelector('.ic-overlay-select')
    expect(view.getBlendMode()).toBe('difference')
    btn.click()
    expect(view.getBlendMode()).toBe('blend')
    expect(sel.value).toBe('blend')
    btn.click()
    expect(view.getBlendMode()).toBe('normal')
    btn.click()
    expect(view.getBlendMode()).toBe('difference')
  })

  it('選「自訂…」後色票啟用，改色票即改標示色', () => {
    const sel = host.querySelector('.ic-highlight-select')
    const swatch = host.querySelector('.ic-highlight-swatch')
    expect(swatch.disabled).toBe(true)

    sel.value = 'custom'
    sel.dispatchEvent(new Event('change'))
    expect(swatch.disabled).toBe(false)
    expect(view.getHighlightColor()).toBe(mod.DEFAULT_CUSTOM_HIGHLIGHT)

    swatch.value = '#00ff00'
    swatch.dispatchEvent(new Event('input'))
    expect(view.getHighlightColor()).toBe('#00ff00')

    // 切回具名色後色票停用，但仍記得使用者選過的顏色
    sel.value = 'blue'
    sel.dispatchEvent(new Event('change'))
    expect(view.getHighlightColor()).toBe('blue')
    expect(swatch.disabled).toBe(true)
    expect(view.getCustomHighlight()).toBe('#00ff00')
  })

  it('比對中繼資料 checkbox 真的改變狀態，不是裝飾', () => {
    const box = host.querySelector('.ic-compare-meta-check')
    expect(view.getCompareMetadata()).toBe(false)
    box.checked = true
    box.dispatchEvent(new Event('change'))
    expect(view.getCompareMetadata()).toBe(true)
  })

  it('取代規則面板可開關，新增/刪除規則會反映在按鈕與清單上', () => {
    const panel = host.querySelector('.ic-replacements-panel')
    expect(panel.style.display).toBe('none')
    host.querySelector('.ic-btn-replacements').click()
    expect(panel.style.display).toBe('')

    host.querySelector('.ic-btn-add-replacement').click()
    // 新增鈕種下的是一條「真的會改變顏色」的規則；只驗長度的話，
    // 種下一條 from === to 的無效規則也會通過。
    expect(view.getReplacements()).toEqual([{ from: '#ffffff', to: '#000000' }])
    expect(host.querySelectorAll('.ic-replacement-row').length).toBe(1)
    expect(host.querySelector('.ic-btn-replacements').textContent).toContain('(1)')

    host.querySelector('.ic-btn-del-replacement').click()
    expect(view.getReplacements()).toEqual([])
    expect(host.querySelector('.ic-replacements-empty')).toBeTruthy()

    host.querySelector('.ic-btn-close-replacements').click()
    expect(panel.style.display).toBe('none')
  })

  it('無效色碼不會被當成規則加入，且呼叫端收到警告', () => {
    /** @type {any[]} */
    const statuses = []
    view.on('status', (p) => statuses.push(p))
    expect(view.addReplacement('nope', '#000000')).toBe(false)
    expect(view.getReplacements()).toEqual([])
    // 釘住訊息本身：只檢查「有某個 warn」的話，達到規則上限的那條警告
    // （訊息完全不同）也會讓這條測試通過。
    expect(statuses.at(-1)).toEqual({
      message: '取代規則需要兩個有效的色碼', level: 'warn',
    })
  })

  it('位移輸入框與重設位移按鈕都作用於同一份狀態', () => {
    const [xi, yi] = host.querySelectorAll('.ic-offset-input')
    xi.value = '5'
    xi.dispatchEvent(new Event('change'))
    yi.value = '-3'
    yi.dispatchEvent(new Event('change'))
    expect(view.getDiffOffset()).toEqual({ x: 5, y: -3 })

    host.querySelector('.ic-btn-reset-offset').click()
    expect(view.getDiffOffset()).toEqual({ x: 0, y: 0 })
    expect(xi.value).toBe('0')
    expect(yi.value).toBe('0')
  })

  it('getConfig/applyConfig 帶得走全部新狀態', () => {
    view.setCompareMetadata(true)
    view.setHighlightColor('#123456')
    view.setReplacements([{ from: '#ff0000', to: '#00ff00' }])
    view.setIgnoreUnimportant(false)
    view.setDiffOffset(4, 6)
    const cfg = view.getConfig()

    const fresh = new mod.ImageCompare()
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    fresh.mount(host2)
    fresh.applyConfig(cfg)

    expect(fresh.getCompareMetadata()).toBe(true)
    expect(fresh.getHighlightColor()).toBe('#123456')
    expect(fresh.getReplacements()).toEqual([{ from: '#ff0000', to: '#00ff00' }])
    expect(fresh.getIgnoreUnimportant()).toBe(false)
    expect(fresh.getDiffOffset()).toEqual({ x: 4, y: 6 })
    // 套用後的 UI 必須跟著走，否則下次讀取控制項會拿到舊值
    expect(host2.querySelector('.ic-highlight-select').value).toBe('custom')
    expect(host2.querySelector('.ic-highlight-swatch').value).toBe('#123456')
    expect(host2.querySelector('.ic-compare-meta-check').checked).toBe(true)
    expect(host2.querySelector('.ic-ignore-unimportant-check').checked).toBe(false)
    expect(host2.querySelector('.ic-btn-replacements').textContent).toContain('(1)')
    fresh.destroy()
    host2.remove()
  })

  it('未載入圖片時狀態列不會謊稱中繼資料相同以外的事', () => {
    view.setCompareMetadata(true)
    expect(view.getMetadataDiffs()).toEqual([])

    // 上面那條單獨看是空的：getMetadataDiffs() 若永遠回傳 []（例如根本沒接線）
    // 也會通過。補一個「有中繼資料時真的讀得到差異」的對照，空陣列才代表
    // 「沒有圖可讀」而不是「這個 getter 從來沒被接上」。
    const meta = (fields) => ({ container: 'JPEG', supported: true, fields })
    view._left = { meta: meta([['ISO', '100']]) }
    view._right = { meta: meta([['ISO', '200']]) }
    view.setCompareMetadata(false)
    view.setCompareMetadata(true)
    expect(view.getMetadataDiffs())
      .toEqual([{ label: 'ISO', left: '100', right: '200' }])
  })
})
