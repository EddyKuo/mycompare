/**
 * @vitest-environment jsdom
 *
 * P2 round: image blend ratio, image file-header metadata, print pagination,
 * per-command visibility, portable-install reporting and the settings bundle's
 * completeness.
 *
 * The metadata tests build their fixtures byte by byte rather than reading a
 * sample file: the point of the reader is that it believes the signature and
 * nothing else, and a fixture whose bytes are written here is the only kind
 * that can state what those bytes are.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

import {
  base64HeadBytes,
  imageMetadataRows,
  parseExif,
  parseImageMetadata,
  buildImageTextReport,
  ImageCompare,
} from '../../src/renderer/src/views/image-compare.js'

import {
  BUNDLE_SECTIONS,
  SettingsStore,
  TOOLBAR_COMMANDS,
  buildSettingsBundle,
  loadUserGrammarDefs,
  normaliseCommandVisibility,
  saveUserGrammarDefs,
} from '../../src/renderer/src/core/settings-store.js'

import { PRINT_PAGINATION_STYLE_ID, withPrintPagination } from '../../src/renderer/src/app.js'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const APP = read('../../src/renderer/src/app.js')
const HTML = read('../../src/renderer/index.html')

// ── fixtures ────────────────────────────────────────────────────────────────

/** @param {number[]} nums @returns {Uint8Array} */
const bytes = (nums) => Uint8Array.from(nums)

/** @param {number} n @returns {number[]} big-endian 32-bit */
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

/** @param {string} s @returns {number[]} */
const ascii = (s) => [...s].map((c) => c.charCodeAt(0))

/**
 * A PNG far enough into the file to carry IHDR and pHYs, and nothing after.
 *
 * @param {{ bitDepth?: number, colorType?: number, interlace?: number, ppu?: number,
 *           physUnit?: number }} [o]
 */
function pngFixture(o = {}) {
  const ihdr = [
    ...be32(640), ...be32(480),
    o.bitDepth ?? 8, o.colorType ?? 6, 0, 0, o.interlace ?? 0,
  ]
  const phys = [...be32(o.ppu ?? 2835), ...be32(o.ppu ?? 2835), o.physUnit ?? 1]
  return bytes([
    0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(ihdr.length), ...ascii('IHDR'), ...ihdr, 0, 0, 0, 0,
    ...be32(phys.length), ...ascii('pHYs'), ...phys, 0, 0, 0, 0,
    ...be32(0), ...ascii('IEND'), 0, 0, 0, 0,
  ])
}

/** A JFIF-flavoured JPEG with a baseline SOF0. */
function jpegFixture({ dpi = 72, progressive = false, exif = null } = {}) {
  const jfif = [...ascii('JFIF'), 0, 1, 1, 1, (dpi >> 8) & 255, dpi & 255, (dpi >> 8) & 255, dpi & 255, 0, 0]
  const sof = [8, 0x01, 0x90, 0x02, 0x80, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]
  const out = [0xff, 0xd8,
    0xff, 0xe0, ((jfif.length + 2) >> 8) & 255, (jfif.length + 2) & 255, ...jfif]
  if (exif) {
    const seg = [...ascii('Exif'), 0, 0, ...exif]
    out.push(0xff, 0xe1, ((seg.length + 2) >> 8) & 255, (seg.length + 2) & 255, ...seg)
  }
  out.push(0xff, progressive ? 0xc2 : 0xc0,
    ((sof.length + 2) >> 8) & 255, (sof.length + 2) & 255, ...sof)
  out.push(0xff, 0xda, 0, 2)
  return bytes(out)
}

/**
 * A little-endian TIFF block with one IFD0 entry: Model = "TestCam".
 * @returns {number[]}
 */
function exifFixture() {
  const str = [...ascii('TestCam'), 0]
  // header(8) + count(2) + one entry(12) + next-ifd(4) = 26 before the string
  const strOffset = 26
  return [
    ...ascii('II'), 42, 0, 8, 0, 0, 0,
    1, 0,                       // one entry
    0x10, 0x01, 2, 0,           // tag 0x0110 (Model), type 2 (ASCII)
    str.length, 0, 0, 0,
    strOffset, 0, 0, 0,
    0, 0, 0, 0,                 // no next IFD
    ...str,
  ]
}

// ── image metadata ──────────────────────────────────────────────────────────

describe('parseImageMetadata', () => {
  it('reads a PNG IHDR and pHYs from the file, not from the decoder', () => {
    const meta = parseImageMetadata(pngFixture(), 'png')
    expect(meta.container).toBe('PNG')
    expect(meta.supported).toBe(true)
    const map = Object.fromEntries(meta.fields)
    expect(map['尺寸（檔頭）']).toBe('640 × 480')
    expect(map['位元深度']).toBe('8 位元/通道')
    expect(map['色彩型別']).toContain('RGBA')
    expect(map['交錯']).toBe('無')
    expect(map['解析度']).toBe('72.0 × 72.0 DPI')
  })

  it('reports an Adam7 PNG as interlaced', () => {
    const map = Object.fromEntries(parseImageMetadata(pngFixture({ interlace: 1 })).fields)
    expect(map['交錯']).toBe('Adam7')
  })

  it('refuses to convert pHYs to DPI when the unit is unspecified', () => {
    // unit byte 0 means "aspect ratio only". Printing a DPI here would be a
    // fabricated number, which is the one thing this panel must not do.
    const map = Object.fromEntries(parseImageMetadata(pngFixture({ physUnit: 0 })).fields)
    expect(map['解析度']).toBeUndefined()
    expect(map['像素比例']).toContain('無法換算')
  })

  it('reads JPEG frame geometry, precision and component count', () => {
    const map = Object.fromEntries(parseImageMetadata(jpegFixture(), 'jpg').fields)
    expect(map['尺寸（檔頭）']).toBe('640 × 400')
    expect(map['取樣精度']).toBe('8 位元/通道')
    expect(map['分量數']).toContain('YCbCr')
    expect(map['編碼方式']).toBe('基線')
    expect(map['解析度']).toBe('72 × 72 DPI')
  })

  it('distinguishes progressive JPEG from baseline', () => {
    const map = Object.fromEntries(parseImageMetadata(jpegFixture({ progressive: true })).fields)
    expect(map['編碼方式']).toBe('漸進式')
  })

  it('reads EXIF carried in a JPEG APP1 segment', () => {
    const map = Object.fromEntries(
      parseImageMetadata(jpegFixture({ exif: exifFixture() })).fields)
    expect(map['相機型號']).toBe('TestCam')
  })

  it('reads a GIF logical screen descriptor', () => {
    const gif = bytes([...ascii('GIF89a'), 0x40, 0x01, 0x20, 0x01, 0xf7, 0, 0, 0, 0])
    const meta = parseImageMetadata(gif, 'gif')
    const map = Object.fromEntries(meta.fields)
    expect(map['版本']).toBe('89a')
    expect(map['尺寸（檔頭）']).toBe('320 × 288')
    expect(map['全域調色盤']).toBe('256 色')
  })

  it('reads a BMP DIB header', () => {
    const b = new Uint8Array(60)
    b[0] = 0x42; b[1] = 0x4d
    b[14] = 40
    b[18] = 0x20; b[22] = 0x10; b[28] = 24
    const map = Object.fromEntries(parseImageMetadata(b, 'bmp').fields)
    expect(map['尺寸（檔頭）']).toBe('32 × 16')
    expect(map['位元深度']).toBe('24 位元/像素')
    expect(map['解析度']).toBe('檔頭未記錄')
  })

  it('goes by the signature, not the extension', () => {
    expect(parseImageMetadata(pngFixture(), 'jpg').container).toBe('PNG')
  })

  it('says a container is unsupported instead of guessing at it', () => {
    const tiff = bytes([...ascii('II'), 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0])
    const meta = parseImageMetadata(tiff, 'tif')
    expect(meta.supported).toBe(false)
    expect(meta.fields).toEqual([])
    expect(meta.note).toContain('尚未支援')
  })

  it('reports unreadable input rather than returning empty success', () => {
    const meta = parseImageMetadata(new Uint8Array(3), 'png')
    expect(meta.supported).toBe(false)
    expect(meta.note).toContain('無法讀取')
  })
})

describe('parseExif', () => {
  it('returns nothing for a block with the wrong magic', () => {
    expect(parseExif(bytes([...ascii('II'), 41, 0, 8, 0, 0, 0]), 0)).toEqual([])
  })

  it('does not read past the end of a truncated block', () => {
    const full = bytes(exifFixture())
    expect(() => parseExif(full.slice(0, 20), 0)).not.toThrow()
  })
})

describe('base64HeadBytes', () => {
  it('decodes the leading bytes of a payload', () => {
    expect([...base64HeadBytes(btoa('hello'))]).toEqual([...ascii('hello')])
  })

  it('stops at the requested limit', () => {
    const big = btoa('x'.repeat(4096))
    expect(base64HeadBytes(big, 64).length).toBeLessThanOrEqual(128)
  })

  it('returns empty rather than throwing on input that is not base64', () => {
    expect(base64HeadBytes('!!!! not base64 !!!!').length).toBe(0)
  })
})

describe('imageMetadataRows', () => {
  it('explains an unsupported container instead of showing an empty table', () => {
    const rows = imageMetadataRows({ container: 'TIFF', supported: false, fields: [], note: 'nope' })
    expect(rows).toEqual([['中繼資料', 'nope']])
  })

  it('appends the note when there are fields and a caveat', () => {
    const rows = imageMetadataRows({
      container: 'JPEG', supported: true, fields: [['a', 'b']], note: '截斷',
    })
    expect(rows).toEqual([['a', 'b'], ['備註', '截斷']])
  })

  it('reports a missing side as not loaded', () => {
    expect(imageMetadataRows(null)).toEqual([['中繼資料', '（未載入）']])
  })
})

describe('image reports carry the header metadata', () => {
  it('names both sides in the text report', () => {
    const text = buildImageTextReport({
      leftPath: 'a.png', rightPath: 'b.png',
      leftSize: { w: 1, h: 1 }, rightSize: { w: 1, h: 1 },
      diffCount: 0, totalPixels: 1, approximate: false, regionCount: 0,
      threshold: 0.1, algorithm: 'exact', autoScale: false, mismatchRange: false,
      blendMode: 'difference', blendRatio: 0.5, highlightColor: 'red',
      leftMeta: parseImageMetadata(pngFixture(), 'png'),
      rightMeta: null,
    })
    expect(text).toContain('左側檔頭中繼資料')
    expect(text).toContain('右側檔頭中繼資料')
    expect(text).toContain('混合比例')
    expect(text).toContain('50%')
  })
})

// ── blend ratio ─────────────────────────────────────────────────────────────

/** @returns {{ ic: any, wrapDiff: any, slider: any, label: any }} */
function makeIC() {
  const ic = new ImageCompare()
  const wrapDiff = { style: { visibility: '', mixBlendMode: '', opacity: '' } }
  const slider = { value: '1', disabled: false }
  const label = { textContent: '' }
  ic._dom = {
    wrapDiff,
    overlaySelect: { value: 'difference' },
    blendRatioSlider: slider,
    blendRatioVal: label,
  }
  return { ic, wrapDiff, slider, label }
}

describe('image blend ratio', () => {
  it('defaults to fully mixed and leaves opacity unset', () => {
    const { ic, wrapDiff } = makeIC()
    expect(ic.getBlendRatio()).toBe(1)
    ic.setBlendMode('difference')
    expect(wrapDiff.style.opacity).toBe('')
  })

  it('applies the ratio to the difference layer', () => {
    const { ic, wrapDiff, label } = makeIC()
    expect(ic.setBlendRatio(0.4)).toBe(0.4)
    expect(wrapDiff.style.opacity).toBe('0.4')
    expect(label.textContent).toBe('40%')
  })

  it('clamps rather than storing a value the slider cannot produce', () => {
    const { ic } = makeIC()
    expect(ic.setBlendRatio(5)).toBe(1)
    expect(ic.setBlendRatio(-2)).toBe(0)
  })

  it('ignores a non-numeric value instead of blanking the overlay', () => {
    const { ic } = makeIC()
    ic.setBlendRatio(0.3)
    expect(ic.setBlendRatio('abc')).toBe(0.3)
  })

  it('disables the slider when there is no overlay to blend', () => {
    const { ic, slider } = makeIC()
    ic.setBlendMode('normal')
    expect(slider.disabled).toBe(true)
    ic.setBlendMode('blend')
    expect(slider.disabled).toBe(false)
  })

  it('survives a config round trip', () => {
    const { ic } = makeIC()
    ic.setBlendRatio(0.25)
    const cfg = ic.getConfig()
    const other = new ImageCompare()
    other._dom = {}
    other.applyConfig(cfg)
    expect(other.getBlendRatio()).toBe(0.25)
  })

  it('does not regress the three blend modes', () => {
    const { ic, wrapDiff } = makeIC()
    ic.setBlendMode('normal')
    expect(wrapDiff.style.visibility).toBe('hidden')
    ic.setBlendMode('blend')
    expect(wrapDiff.style.mixBlendMode).toBe('difference')
    ic.setBlendMode('difference')
    expect(wrapDiff.style.mixBlendMode).toBe('')
    expect(wrapDiff.style.visibility).toBe('')
  })
})

// ── print pagination ────────────────────────────────────────────────────────

describe('withPrintPagination', () => {
  const doc = (body) => `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`

  it('adds the page-break rules once', () => {
    const once = withPrintPagination(doc('<p>x</p>'))
    expect(once).toContain(PRINT_PAGINATION_STYLE_ID)
    expect(once).toContain('table-header-group')
    const twice = withPrintPagination(once)
    expect(twice.match(/table-header-group/g)).toHaveLength(1)
  })

  it('keeps rows from being split across a page break', () => {
    expect(withPrintPagination(doc('<p>x</p>'))).toMatch(/tr[^}]*break-inside: avoid/)
  })

  it('promotes an all-th first row into a thead so it repeats per page', () => {
    const out = withPrintPagination(
      doc('<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>'))
    expect(out).toContain('<thead><tr><th>a</th><th>b</th></tr></thead>')
    expect(out).toContain('<td>1</td>')
  })

  it('leaves a data first row alone', () => {
    const out = withPrintPagination(doc('<table><tr><td>1</td></tr></table>'))
    expect(out).not.toContain('<thead>')
  })

  it('leaves an existing thead alone', () => {
    const out = withPrintPagination(
      doc('<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'))
    expect(out.match(/<thead>/g)).toHaveLength(1)
  })

  it('returns empty input untouched rather than emitting a shell document', () => {
    expect(withPrintPagination('')).toBe('')
  })
})

// ── per-command visibility ──────────────────────────────────────────────────

describe('command visibility', () => {
  beforeEach(() => localStorage.clear())

  it('shows every command until one is switched off', () => {
    const s = new SettingsStore()
    for (const cmd of TOOLBAR_COMMANDS) expect(s.isCommandVisible(cmd.id)).toBe(true)
  })

  it('stores only the hidden ones, so a new button appears without a migration', () => {
    const s = new SettingsStore()
    s.setCommandVisible('swap', false)
    expect(s.getCommandVisibility()).toEqual({ swap: false })
    s.setCommandVisible('swap', true)
    expect(s.getCommandVisibility()).toEqual({})
  })

  it('refuses an unknown id rather than storing a preference for nothing', () => {
    const s = new SettingsStore()
    expect(s.setCommandVisible('notACommand', false)).toBe(false)
    expect(s.getCommandVisibility()).toEqual({})
  })

  it('drops unknown and non-false entries when reading storage', () => {
    expect(normaliseCommandVisibility({ swap: false, bogus: false, print: true }))
      .toEqual({ swap: false })
  })

  it('resets everything back to visible', () => {
    const s = new SettingsStore()
    s.setCommandVisible('swap', false)
    s.setCommandVisible('print', false)
    s.resetCommandVisibility()
    expect(s.getCommandVisibility()).toEqual({})
  })

  it('names an element that exists in the markup for every command', () => {
    for (const cmd of TOOLBAR_COMMANDS) {
      expect(HTML).toContain(`id="${cmd.element}"`)
    }
  })
})

// ── user grammars survive a restart, and travel in the bundle ────────────────

describe('user grammar persistence', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips definitions', () => {
    const defs = [{ name: 'INI', masks: ['*.ini'], caseSensitive: false, items: [] }]
    expect(saveUserGrammarDefs(defs)).toBe('')
    expect(loadUserGrammarDefs()).toEqual(defs)
  })

  it('returns an empty list rather than throwing on corrupt storage', () => {
    localStorage.setItem('mycompare:grammars', '{not json')
    expect(loadUserGrammarDefs()).toEqual([])
  })

  it('is part of the exported bundle', () => {
    expect(BUNDLE_SECTIONS.grammars).toBe('mycompare:grammars')
    saveUserGrammarDefs([{ name: 'INI', masks: [], caseSensitive: true, items: [] }])
    expect(buildSettingsBundle().sections.grammars).toBeTruthy()
  })
})

// ── wiring: every item above has a way in ────────────────────────────────────

describe('entry points', () => {
  it('applies command visibility at startup and after an import', () => {
    expect(APP.match(/applyCommandVisibility\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('has a dispatch id for customising commands', () => {
    expect(APP).toContain("'tools.customizeCommands'")
  })

  it('restores stored grammars at startup', () => {
    expect(APP).toContain('restoreUserGrammars()')
    expect(APP).toContain('saveUserGrammarDefs(getUserGrammars())')
  })

  it('routes every printed report through the pagination pass', () => {
    // The invariant is that no call escapes the pagination wrapper — not that
    // there are exactly N of them. Pinning the count made adding a correctly
    // wrapped call site (the PDF export) fail a test about something else.
    const all = APP.match(/\bsrc\.view\.buildHtmlReport\(\)/g) ?? []
    const wrapped = APP.match(/withPrintPagination\(src\.view\.buildHtmlReport\(\)\)/g) ?? []
    expect(all.length).toBeGreaterThan(0)
    expect(wrapped).toHaveLength(all.length)
  })

  it('carries the Options page and the portable readout in the markup', () => {
    expect(HTML).toContain('id="options-pane-commands"')
    expect(HTML).toContain('id="settings-commands-list"')
    expect(HTML).toContain('id="inp-command-filter"')
    expect(HTML).toContain('id="txt-portable-state"')
  })

  it('states how page numbers are produced instead of implying it prints them', () => {
    expect(HTML).toContain('print-preview-pagination-hint')
    expect(HTML).toContain('頁首及頁尾')
  })
})
