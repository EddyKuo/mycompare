/**
 * @vitest-environment jsdom
 *
 * The unified Options dialog's data layer: appearance overrides (P2-34) and
 * the full settings bundle (P2-38).
 *
 * The bundle tests care about two things the previous Sessions-only export got
 * away with not caring about: that a round trip really restores every store,
 * and that a malformed file changes nothing at all rather than half of it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  SettingsStore,
  DEFAULT_PREFS,
  DEFAULT_SHORTCUTS,
  DEFAULT_FONTS,
  COLOR_TOKENS,
  BUNDLE_SECTIONS,
  PREF_PAGES,
  SETTINGS_BUNDLE_KIND,
  SETTINGS_BUNDLE_VERSION,
  applySettingsBundle,
  buildSettingsBundle,
  exportSettingsJSON,
  isValidColor,
  isValidFontFamily,
  normaliseAppearance,
  readSettingsBundle,
  scrubSecrets,
} from '../../src/renderer/src/core/settings-store.js'

beforeEach(() => localStorage.clear())

// ── Appearance ──────────────────────────────────────────────────────────────

describe('colour validation', () => {
  it('accepts #rgb and #rrggbb only', () => {
    expect(isValidColor('#fff')).toBe(true)
    expect(isValidColor('#A1B2C3')).toBe(true)
    expect(isValidColor('red')).toBe(false)
    expect(isValidColor('rgb(1,2,3)')).toBe(false)
    expect(isValidColor('')).toBe(false)
    expect(isValidColor(null)).toBe(false)
  })

  it('rejects a value that would smuggle another declaration into the property', () => {
    // Custom properties are substituted verbatim, so this has to be refused at
    // the store, not merely rendered oddly.
    expect(isValidColor('#fff; background-image: url(http://x/)')).toBe(false)
  })
})

describe('font validation', () => {
  it('allows an ordinary family list and the empty default', () => {
    expect(isValidFontFamily('')).toBe(true)
    expect(isValidFontFamily("Consolas, 'Fira Code', monospace")).toBe(true)
  })

  it('rejects anything that could escape the declaration', () => {
    expect(isValidFontFamily('a; color: red')).toBe(false)
    expect(isValidFontFamily('url(http://x/f.woff)')).toBe(false)
    expect(isValidFontFamily('a{}b')).toBe(false)
    expect(isValidFontFamily('x'.repeat(201))).toBe(false)
  })
})

describe('normaliseAppearance', () => {
  it('fills in a complete shape from nothing', () => {
    const a = normaliseAppearance(undefined)
    expect(a.colors).toEqual({ light: {}, dark: {} })
    expect(a.fonts).toEqual({ ...DEFAULT_FONTS })
  })

  it('drops unknown keys and invalid values instead of storing them', () => {
    const a = normaliseAppearance({
      colors: { light: { importantBg: '#abc', nonsense: '#fff', charInsert: 'red' } },
      fonts: { ui: 'a; b', mono: 'Consolas', uiSize: 999 },
    })
    expect(a.colors.light).toEqual({ importantBg: '#abc' })
    expect(a.fonts.ui).toBe('')
    expect(a.fonts.mono).toBe('Consolas')
    expect(a.fonts.uiSize).toBe(22) // clamped, not stored as 999
  })
})

describe('SettingsStore appearance', () => {
  it('stores an override per theme and reads it back', () => {
    const s = new SettingsStore()
    expect(s.setColor('dark', 'importantBg', '#123456')).toBe(true)
    expect(s.getAppearance().colors.dark.importantBg).toBe('#123456')
    expect(s.getAppearance().colors.light.importantBg).toBeUndefined()
  })

  it('refuses an unknown token, an unknown theme and an invalid colour', () => {
    const s = new SettingsStore()
    expect(s.setColor('dark', 'notAToken', '#123456')).toBe(false)
    expect(s.setColor('sepia', 'importantBg', '#123456')).toBe(false)
    expect(s.setColor('dark', 'importantBg', 'chartreuse')).toBe(false)
    expect(s.getAppearance().colors.dark).toEqual({})
  })

  it('resets one theme without disturbing the other', () => {
    const s = new SettingsStore()
    s.setColor('light', 'importantBg', '#111111')
    s.setColor('dark', 'importantBg', '#222222')
    s.resetColors('light')
    expect(s.getAppearance().colors.light).toEqual({})
    expect(s.getAppearance().colors.dark.importantBg).toBe('#222222')
  })

  it('resets both themes and the fonts together', () => {
    const s = new SettingsStore()
    s.setColor('light', 'charDelete', '#111111')
    s.setFontFamily('mono', 'Consolas')
    s.setUiFontSize(20)
    s.resetAppearance()
    expect(s.getAppearance()).toEqual({ colors: { light: {}, dark: {} }, fonts: { ...DEFAULT_FONTS } })
  })

  it('clamps the interface font size and reports what it stored', () => {
    const s = new SettingsStore()
    expect(s.setUiFontSize(4)).toBe(10)
    expect(s.setUiFontSize(400)).toBe(22)
    expect(s.setUiFontSize('16')).toBe(16)
  })

  it('leaves shortcuts and prefs alone when appearance changes', () => {
    const s = new SettingsStore()
    s.setShortcut('nextDiff', 'F9')
    s.setPref('navWrapAround', true)
    s.setColor('light', 'importantBg', '#010203')
    expect(s.getShortcut('nextDiff')).toBe('F9')
    expect(s.getPref('navWrapAround')).toBe(true)
  })

  it('reset() keeps preferences and appearance', () => {
    const s = new SettingsStore()
    s.setPref('navWrapAround', true)
    s.setColor('light', 'importantBg', '#010203')
    s.setShortcut('nextDiff', 'F9')
    s.reset()
    expect(s.getShortcut('nextDiff')).toBe(DEFAULT_SHORTCUTS.nextDiff)
    expect(s.getPref('navWrapAround')).toBe(true)
    expect(s.getAppearance().colors.light.importantBg).toBe('#010203')
  })

  it('resetPrefs only touches the page it was given', () => {
    const s = new SettingsStore()
    s.setPref('navWrapAround', true)
    s.setPref('showToolbar', false)
    s.resetPrefs(PREF_PAGES.display)
    expect(s.getPref('showToolbar')).toBe(DEFAULT_PREFS.showToolbar)
    expect(s.getPref('navWrapAround')).toBe(true)
  })

  it('every colour token names a distinct key and CSS variable', () => {
    // Two tokens sharing a variable would make one of the dialog's swatches
    // silently overwrite the other.
    expect(new Set(COLOR_TOKENS.map((t) => t.key)).size).toBe(COLOR_TOKENS.length)
    expect(new Set(COLOR_TOKENS.map((t) => t.cssVar)).size).toBe(COLOR_TOKENS.length)
  })
})

// ── Settings bundle ─────────────────────────────────────────────────────────

/** Put something recognisable in every store the bundle claims to cover. */
function seedEverything() {
  const s = new SettingsStore()
  s.setShortcut('nextDiff', 'F9')
  s.setPref('navWrapAround', true)
  s.setPref('showStatusBar', false)
  s.setColor('dark', 'unimportantBg', '#0a0b0c')
  s.setFontFamily('mono', 'Consolas')
  localStorage.setItem('mycompare:theme', 'dark')
  localStorage.setItem('mycompare:namedConfigs', JSON.stringify({ text: { a: { ignoreCase: true } } }))
  localStorage.setItem('mycompare:workspaces', JSON.stringify([{ name: 'w', tabs: [] }]))
  localStorage.setItem('mycompare:sessionGroups', JSON.stringify({ groups: [{ id: 'g', name: '專案' }], membership: {} }))
  localStorage.setItem('mycompare:sessions', JSON.stringify({ s1: { id: 's1', type: 'text' } }))
  localStorage.setItem('mycompare:recent', JSON.stringify(['s1']))
  localStorage.setItem('mycompare:folderColumns', JSON.stringify(['name', 'size']))
}

/** @returns {Record<string,string|null>} every bundled key's raw value */
function snapshot() {
  return Object.fromEntries(
    Object.values(BUNDLE_SECTIONS).map((k) => [k, localStorage.getItem(k)]))
}

describe('buildSettingsBundle', () => {
  it('carries a kind and a version so a foreign file can be refused', () => {
    const bundle = buildSettingsBundle(new Date('2026-01-02T03:04:05Z'))
    expect(bundle.kind).toBe(SETTINGS_BUNDLE_KIND)
    expect(bundle.version).toBe(SETTINGS_BUNDLE_VERSION)
    expect(bundle.exportedAt).toBe('2026-01-02T03:04:05.000Z')
  })

  it('covers every declared section once they exist', () => {
    seedEverything()
    const bundle = buildSettingsBundle()
    expect(Object.keys(bundle.sections).sort()).toEqual(Object.keys(BUNDLE_SECTIONS).sort())
  })

  it('omits sections that were never written rather than exporting nulls', () => {
    const bundle = buildSettingsBundle()
    expect(bundle.sections.theme).toBeUndefined()
    expect('sessions' in bundle.sections).toBe(false)
  })

  it('keeps the theme, which is a bare word and not JSON', () => {
    localStorage.setItem('mycompare:theme', 'dark')
    expect(buildSettingsBundle().sections.theme).toBe('dark')
  })
})

describe('the exported file never contains a credential', () => {
  it('drops password-shaped properties at any depth', () => {
    const scrubbed = scrubSecrets({
      profiles: [{ host: 'h', password: 'p', nested: { secretToken: 'x', port: 21 } }],
      keep: 'yes',
    })
    expect(scrubbed).toEqual({ profiles: [{ host: 'h', nested: { port: 21 } }], keep: 'yes' })
  })

  it('drops ciphertext too — a sealed blob is still the secret', () => {
    expect(scrubSecrets({ encryptedPassword: 'AQAAAN…', passphrase: 'x', user: 'u' }))
      .toEqual({ user: 'u' })
  })

  it('a bundle built over a store polluted with secrets exports none of them', () => {
    seedEverything()
    // Remote profiles live in the main process, but nothing stops a future
    // section from carrying one; the export must survive that.
    localStorage.setItem('mycompare:workspaces', JSON.stringify(
      [{ name: 'w', remote: { host: 'h', password: 'hunter2', encryptedSecret: 'AQAA' } }]))

    const json = exportSettingsJSON()
    expect(json).not.toMatch(/hunter2/)
    expect(json).not.toMatch(/AQAA/)
    expect(json).not.toMatch(/password|secret|token|credential|passphrase/i)
    // and the harmless neighbours survived
    expect(json).toMatch(/"host": "h"/)
  })
})

describe('readSettingsBundle rejects what it cannot fully apply', () => {
  const cases = [
    ['not JSON at all', 'this is not json', /有效的 JSON/],
    ['a JSON scalar', '42', /不是物件/],
    ['a foreign file', JSON.stringify({ kind: 'other', version: 1, sections: {} }), /不是 MyCompare 設定檔/],
    ['a missing version', JSON.stringify({ kind: SETTINGS_BUNDLE_KIND, sections: {} }), /version/],
    ['a non-integer version', JSON.stringify({ kind: SETTINGS_BUNDLE_KIND, version: 1.5, sections: {} }), /version/],
    ['a future version', JSON.stringify({ kind: SETTINGS_BUNDLE_KIND, version: 99, sections: {} }), /比本程式支援的/],
    ['no sections', JSON.stringify({ kind: SETTINGS_BUNDLE_KIND, version: 1 }), /sections/],
    ['an unknown section', JSON.stringify({ kind: SETTINGS_BUNDLE_KIND, version: 1, sections: { nope: 1 } }), /無法識別的區段/],
  ]

  for (const [name, json, pattern] of cases) {
    it(`refuses ${name}, naming the reason`, () => {
      expect(() => readSettingsBundle(json)).toThrow(pattern)
    })
  }

  it('accepts the current version', () => {
    const parsed = readSettingsBundle(exportSettingsJSON())
    expect(parsed.version).toBe(SETTINGS_BUNDLE_VERSION)
    expect(parsed.legacySessions).toBeNull()
  })
})

describe('backward compatibility', () => {
  it('recognises the pre-bundle Sessions-only export instead of erroring', () => {
    const legacy = JSON.stringify([{ id: 's1', type: 'text' }])
    const parsed = readSettingsBundle(legacy)
    expect(parsed.version).toBe(0)
    expect(parsed.legacySessions).toHaveLength(1)
  })

  it('applySettingsBundle hands legacy sessions back rather than writing them', () => {
    const before = snapshot()
    const result = applySettingsBundle(JSON.stringify([{ id: 's1', type: 'text' }]))
    expect(result.version).toBe(0)
    expect(result.legacySessions).toHaveLength(1)
    // SessionStore validates each record; the bundle must not shortcut that.
    expect(snapshot()).toEqual(before)
  })
})

describe('round trip', () => {
  it('restores every store exactly', () => {
    seedEverything()
    const json = exportSettingsJSON()
    const expected = snapshot()

    localStorage.clear()
    const result = applySettingsBundle(json)

    expect(result.applied.sort()).toEqual(Object.keys(BUNDLE_SECTIONS).sort())
    for (const key of Object.keys(expected)) {
      // Compared structurally, since JSON.stringify may reorder nothing but
      // does normalise whitespace; `mycompare:theme` is a bare word, not JSON.
      const parse = (raw) => { try { return JSON.parse(raw ?? '""') } catch { return raw } }
      expect(parse(localStorage.getItem(key))).toEqual(parse(expected[key]))
    }
  })

  it('brings back the settings a user would notice', () => {
    seedEverything()
    const json = exportSettingsJSON()

    localStorage.clear()
    applySettingsBundle(json)

    const s = new SettingsStore()
    expect(s.getShortcut('nextDiff')).toBe('F9')
    expect(s.getPref('navWrapAround')).toBe(true)
    expect(s.getPref('showStatusBar')).toBe(false)
    expect(s.getAppearance().colors.dark.unimportantBg).toBe('#0a0b0c')
    expect(s.getAppearance().fonts.mono).toBe('Consolas')
    expect(localStorage.getItem('mycompare:theme')).toBe('dark')
  })

  it('survives two round trips unchanged', () => {
    seedEverything()
    const first = exportSettingsJSON(new Date('2026-01-01T00:00:00Z'))
    localStorage.clear()
    applySettingsBundle(first)
    const second = exportSettingsJSON(new Date('2026-01-01T00:00:00Z'))
    expect(second).toBe(first)
  })
})

describe('a rejected import changes nothing', () => {
  it('leaves every key as it was', () => {
    seedEverything()
    const before = snapshot()
    expect(() => applySettingsBundle('{"kind":"other","version":1,"sections":{}}')).toThrow()
    expect(() => applySettingsBundle('not json')).toThrow()
    expect(() => applySettingsBundle(
      JSON.stringify({ kind: SETTINGS_BUNDLE_KIND, version: 1, sections: { settings: {}, bogus: 1 } })))
      .toThrow(/無法識別的區段/)
    expect(snapshot()).toEqual(before)
  })
})
