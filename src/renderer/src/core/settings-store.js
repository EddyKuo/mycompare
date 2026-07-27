/**
 * @file settings-store.js
 * @description Persistence for user-level application settings — currently
 *   houses customizable keyboard shortcuts (T75).
 *
 *   Storage is via localStorage under the key `mycompare:settings`.
 *   All operations are try/catch guarded; any failure silently falls back
 *   to defaults — never throws to callers.
 */

const KEY_SETTINGS = 'mycompare:settings'

/**
 * @typedef {object} ShortcutBinding
 * @property {boolean} ctrl
 * @property {boolean} shift
 * @property {boolean} alt
 * @property {string} key  Normalised key string, e.g. 'z', 'F7', 'Home', 'ArrowLeft'
 */

/**
 * @typedef {object} AppSettings
 * @property {Record<string, string>} shortcuts  action → combo string, e.g. 'Ctrl+Z'
 * @property {AppPreferences} prefs
 * @property {AppearanceSettings} appearance
 */

/**
 * @typedef {object} AppPreferences
 * @property {boolean} backupOnSave  keep a .bak copy before overwriting a file
 * @property {BackupNaming} backupNaming  how that copy is named
 * @property {string} backupFolder  absolute directory for backups; '' = alongside
 * @property {boolean} navWrapAround  next/prev wraps past the last difference
 * @property {boolean} navFirstDiffOnLoad  jump to the first difference on load
 * @property {boolean} navNextAfterCopy  advance after copying to the other side
 * @property {boolean} navShowNoDiffMessage  report "no more differences"
 * @property {boolean} confirmOnCloseTab  ask before closing a comparison tab
 * @property {boolean} showToolbar  show the main toolbar
 * @property {boolean} showStatusBar  show the status bar
 */

/**
 * @typedef {'suffix'|'replace'|'tilde'|'numbered'} BackupNaming
 */

/**
 * The naming schemes the main process implements, with an example each so the
 * settings dialog does not have to describe them in prose.
 *
 * Kept in step with `src/main/backup.js` BACKUP_NAMING by value; the two
 * cannot import from one another across the process boundary.
 *
 * @type {ReadonlyArray<{ value: BackupNaming, label: string }>}
 */
export const BACKUP_NAMING_OPTIONS = Object.freeze([
  { value: 'suffix',   label: '加上 .bak（report.txt → report.txt.bak）' },
  { value: 'replace',  label: '取代副檔名（report.txt → report.bak）' },
  { value: 'tilde',    label: '加上 ~（report.txt → report.txt~）' },
  { value: 'numbered', label: '編號保留多份（report.txt → report.txt.1、.2 …）' },
])

/** @type {ReadonlyArray<BackupNaming>} */
const BACKUP_NAMING_VALUES = Object.freeze(BACKUP_NAMING_OPTIONS.map((o) => o.value))

/**
 * @typedef {object} BackupOptions
 * @property {boolean} enabled
 * @property {BackupNaming} naming
 * @property {string} folder
 */

/**
 * Non-shortcut preferences.
 *
 * backupOnSave defaults on, as it does in Beyond Compare: saving overwrites
 * the user's file in place and there is otherwise no way back.
 *
 * The nav* defaults mirror BC's Options ▸ Next Difference page: wrap-around
 * off, go-to-first-difference-on-load on, advance-after-copy on.
 *
 * @type {AppPreferences}
 */
export const DEFAULT_PREFS = {
  backupOnSave: true,
  backupNaming: 'suffix',
  backupFolder: '',
  navWrapAround: false,
  navFirstDiffOnLoad: true,
  navNextAfterCopy: true,
  navShowNoDiffMessage: true,
  confirmOnCloseTab: false,
  showToolbar: true,
  showStatusBar: true,
}

/**
 * Which preferences belong to which page of the Options dialog.
 *
 * The dialog's "restore this page" button needs to know the scope of the page
 * it is on; deriving that from the markup would make a renamed control silently
 * widen or narrow what gets reset.
 *
 * @type {Readonly<Record<string, ReadonlyArray<keyof AppPreferences>>>}
 */
export const PREF_PAGES = Object.freeze({
  general: Object.freeze(['confirmOnCloseTab']),
  display: Object.freeze(['showToolbar', 'showStatusBar']),
  nav: Object.freeze([
    'navWrapAround', 'navFirstDiffOnLoad', 'navNextAfterCopy', 'navShowNoDiffMessage',
  ]),
  backup: Object.freeze(['backupOnSave', 'backupNaming', 'backupFolder']),
})

// ---------------------------------------------------------------------------
// Appearance — colours and fonts (BC's Tools ▸ Options ▸ Colors, Fonts)
// ---------------------------------------------------------------------------

/**
 * The diff colours a user may override.
 *
 * The *meaning* of each slot is fixed by the project's colour semantics
 * (same / important / unimportant / left-only / right-only / conflict); what is
 * customisable is the concrete value behind it, which is why this table maps a
 * stable key to an existing CSS custom property rather than letting the user
 * invent new roles.
 *
 * @type {ReadonlyArray<{ key: string, cssVar: string, label: string }>}
 */
export const COLOR_TOKENS = Object.freeze([
  { key: 'importantBg',       cssVar: '--diff-replace-bg',         label: '重要差異（變更）背景' },
  { key: 'importantBorder',   cssVar: '--diff-replace-border',     label: '重要差異（變更）邊框' },
  { key: 'unimportantBg',     cssVar: '--diff-unimportant-bg',     label: '不重要差異 背景' },
  { key: 'unimportantBorder', cssVar: '--diff-unimportant-border', label: '不重要差異 邊框' },
  { key: 'leftOnlyBg',        cssVar: '--diff-insert-bg',          label: '僅左側 / 新增 背景' },
  { key: 'leftOnlyBorder',    cssVar: '--diff-insert-border',      label: '僅左側 / 新增 邊框' },
  { key: 'rightOnlyBg',       cssVar: '--diff-delete-bg',          label: '僅右側 / 刪除 背景' },
  { key: 'rightOnlyBorder',   cssVar: '--diff-delete-border',      label: '僅右側 / 刪除 邊框' },
  { key: 'charInsert',        cssVar: '--diff-char-insert',        label: '字元級 新增' },
  { key: 'charDelete',        cssVar: '--diff-char-delete',        label: '字元級 刪除' },
])

/** @type {ReadonlyArray<string>} */
const COLOR_KEYS = Object.freeze(COLOR_TOKENS.map((t) => t.key))

/** The themes colours are stored under; matches `data-theme` on <html>. */
export const COLOR_THEMES = Object.freeze(['light', 'dark'])

/**
 * @typedef {object} AppearanceFonts
 * @property {string} ui    font-family list for the interface; '' = stylesheet default
 * @property {string} mono  font-family list for the compare panes; '' = default
 * @property {number} uiSize  interface font size in px
 */

/**
 * @typedef {object} AppearanceSettings
 * @property {{ light: Record<string,string>, dark: Record<string,string> }} colors
 * @property {AppearanceFonts} fonts
 */

/** @type {AppearanceFonts} */
export const DEFAULT_FONTS = Object.freeze({ ui: '', mono: '', uiSize: 13 })

export const MIN_UI_FONT_SIZE = 10
export const MAX_UI_FONT_SIZE = 22

/** `#abc` or `#aabbcc`. */
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * Whether a stored value is safe to write into a CSS custom property.
 *
 * Custom properties are substituted into declarations verbatim, so a
 * hand-edited store containing `red; background-image: url(http://…)` would
 * otherwise become a way to make the app fetch a remote resource. Restricting
 * colours to plain hex removes the question entirely.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidColor(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value.trim())
}

/**
 * Whether a font-family list is safe to write into a CSS custom property.
 *
 * Same reasoning as {@link isValidColor}: no statement terminators, no blocks,
 * no `url()`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidFontFamily(value) {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (v === '') return true // '' means "use the stylesheet default"
  if (v.length > 200) return false
  return !/[;{}<>\\]|url\s*\(|@|\/\*/i.test(v)
}

/**
 * Coerce whatever is in storage into a complete, safe appearance object.
 *
 * @param {unknown} raw
 * @returns {AppearanceSettings}
 */
export function normaliseAppearance(raw) {
  const src = (raw && typeof raw === 'object') ? /** @type {Record<string, any>} */ (raw) : {}
  /** @type {{ light: Record<string,string>, dark: Record<string,string> }} */
  const colors = { light: {}, dark: {} }
  const srcColors = (src.colors && typeof src.colors === 'object') ? src.colors : {}
  for (const theme of COLOR_THEMES) {
    const bucket = (srcColors[theme] && typeof srcColors[theme] === 'object') ? srcColors[theme] : {}
    for (const key of COLOR_KEYS) {
      if (isValidColor(bucket[key])) colors[theme][key] = String(bucket[key]).trim().toLowerCase()
    }
  }

  const srcFonts = (src.fonts && typeof src.fonts === 'object') ? src.fonts : {}
  const size = Number(srcFonts.uiSize)
  /** @type {AppearanceFonts} */
  const fonts = {
    ui:   isValidFontFamily(srcFonts.ui)   ? String(srcFonts.ui).trim()   : DEFAULT_FONTS.ui,
    mono: isValidFontFamily(srcFonts.mono) ? String(srcFonts.mono).trim() : DEFAULT_FONTS.mono,
    uiSize: Number.isFinite(size)
      ? Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, Math.round(size)))
      : DEFAULT_FONTS.uiSize,
  }

  return { colors, fonts }
}

/**
 * Default shortcut bindings. Action names are stable identifiers that the
 * keyboard handler in app.js looks up at runtime.
 *
 * @type {Record<string, string>}
 */
export const DEFAULT_SHORTCUTS = {
  nextDiff:      'F8',
  prevDiff:      'F7',
  firstDiff:     'Alt+Home',
  lastDiff:      'Alt+End',
  copyLeft:      'Alt+ArrowLeft',
  copyRight:     'Alt+ArrowRight',
  copyAllLeft:   '',
  copyAllRight:  '',
  undo:          'Ctrl+Z',
  redo:          'Ctrl+Y',
  editToggle:    'Ctrl+E',
  saveLeft:      'Ctrl+S',
  saveRight:     'Ctrl+Shift+S',
  find:          'Ctrl+F',
  gotoLine:      'Ctrl+G',
  refresh:       'F5',
  newSession:    'Ctrl+N',
  closeTab:      'Ctrl+W',
  fullscreen:    'F11',
  print:         'Ctrl+P',
}

/**
 * Parse a combo string like "Ctrl+Shift+Z" into a binding object.
 * Returns null for empty / unparseable strings.
 *
 * @param {string} combo
 * @returns {ShortcutBinding | null}
 */
export function parseCombo(combo) {
  if (typeof combo !== 'string' || combo.trim() === '') return null
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  /** @type {ShortcutBinding} */
  const out = { ctrl: false, shift: false, alt: false, key: '' }
  for (const p of parts) {
    const lower = p.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') out.ctrl = true
    else if (lower === 'shift') out.shift = true
    else if (lower === 'alt') out.alt = true
    else out.key = p.length === 1 ? p.toLowerCase() : p
  }
  if (out.key === '') return null
  return out
}

/**
 * Build a canonical combo string from a KeyboardEvent.
 * Returns '' if only modifier keys were pressed.
 *
 * @param {KeyboardEvent} event
 * @returns {string}
 */
export function eventToCombo(event) {
  const mods = ['Control', 'Shift', 'Alt', 'Meta']
  if (mods.includes(event.key)) return ''
  const parts = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.shiftKey) parts.push('Shift')
  if (event.altKey) parts.push('Alt')
  parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key)
  return parts.join('+')
}

/**
 * Test whether a KeyboardEvent matches a combo string.
 *
 * Matching rules:
 *  - Modifier flags (ctrl / shift / alt) must match exactly.
 *  - Key comparison is case-insensitive for single-letter keys, and
 *    case-sensitive (but tolerant of canonical names like 'Home', 'F7',
 *    'ArrowLeft') for named keys.
 *
 * @param {KeyboardEvent} event
 * @param {string} combo
 * @returns {boolean}
 */
export function keyComboMatches(event, combo) {
  const binding = parseCombo(combo)
  if (!binding) return false
  if (Boolean(event.ctrlKey)  !== binding.ctrl)  return false
  if (Boolean(event.shiftKey) !== binding.shift) return false
  if (Boolean(event.altKey)   !== binding.alt)   return false
  const evtKey = event.key.length === 1 ? event.key.toLowerCase() : event.key
  return evtKey === binding.key
}

/**
 * Actions already bound to `combo`, excluding `action` itself.
 *
 * Two actions on one key is not an error the store can refuse — the user may
 * be mid-way through swapping a pair — but silently letting the later binding
 * shadow the earlier one is how a shortcut "stops working" with no explanation,
 * so the caller is given the names to show.
 *
 * @param {Record<string, string>} shortcuts  action → combo
 * @param {string} action  the action being (re)bound
 * @param {string} combo
 * @returns {string[]} conflicting action names, in table order
 */
export function findShortcutConflicts(shortcuts, action, combo) {
  if (typeof combo !== 'string' || combo.trim() === '') return []
  return Object.keys(shortcuts ?? {})
    .filter((a) => a !== action && shortcuts[a] === combo)
}

/**
 * @returns {AppSettings}
 */
function readSettings() {
  const fallback = () => ({
    shortcuts: { ...DEFAULT_SHORTCUTS },
    prefs: { ...DEFAULT_PREFS },
    appearance: normaliseAppearance(null),
  })
  try {
    const raw = localStorage.getItem(KEY_SETTINGS)
    if (!raw) return fallback()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback()
    const stored = (parsed.shortcuts && typeof parsed.shortcuts === 'object')
      ? parsed.shortcuts
      : {}
    const storedPrefs = (parsed.prefs && typeof parsed.prefs === 'object')
      ? parsed.prefs
      : {}
    return {
      shortcuts: { ...DEFAULT_SHORTCUTS, ...stored },
      prefs: { ...DEFAULT_PREFS, ...storedPrefs },
      appearance: normaliseAppearance(parsed.appearance),
    }
  } catch {
    return fallback()
  }
}

/**
 * @param {AppSettings} settings
 */
function writeSettings(settings) {
  try {
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings))
  } catch {
    // quota exceeded — silent
  }
}

export class SettingsStore {
  /**
   * Get the full settings object. Always returns a complete shape, merging
   * stored overrides over DEFAULT_SHORTCUTS.
   * @returns {AppSettings}
   */
  load() {
    return readSettings()
  }

  /**
   * Get a single shortcut binding string (may be '' if user cleared it).
   * @param {string} action
   * @returns {string}
   */
  getShortcut(action) {
    const s = readSettings()
    return s.shortcuts[action] ?? DEFAULT_SHORTCUTS[action] ?? ''
  }

  /**
   * Save (or overwrite) a single shortcut binding.
   * @param {string} action
   * @param {string} combo
   */
  setShortcut(action, combo) {
    if (typeof action !== 'string' || !action) return
    if (typeof combo !== 'string') return
    const s = readSettings()
    s.shortcuts[action] = combo
    writeSettings(s)
  }

  /**
   * Read one preference.
   * @template {keyof AppPreferences} K
   * @param {K} name
   * @returns {AppPreferences[K]}
   */
  getPref(name) {
    const s = readSettings()
    return s.prefs[name] ?? DEFAULT_PREFS[name]
  }

  /**
   * Write one preference.
   * @template {keyof AppPreferences} K
   * @param {K} name
   * @param {AppPreferences[K]} value
   */
  setPref(name, value) {
    if (!(name in DEFAULT_PREFS)) return
    const s = readSettings()
    s.prefs[name] = value
    writeSettings(s)
  }

  /**
   * The backup settings in the shape the `save-file` / `copy-file` IPC expects.
   *
   * Stored values are re-validated here rather than trusted: a hand-edited
   * localStorage entry naming an unknown scheme would otherwise be passed to
   * the main process, which would fall back silently and leave the dialog
   * showing something that never happens.
   *
   * @returns {BackupOptions}
   */
  getBackupOptions() {
    const prefs = readSettings().prefs
    const naming = BACKUP_NAMING_VALUES.includes(prefs.backupNaming)
      ? prefs.backupNaming
      : DEFAULT_PREFS.backupNaming
    return {
      enabled: prefs.backupOnSave !== false,
      naming,
      folder: typeof prefs.backupFolder === 'string' ? prefs.backupFolder : '',
    }
  }

  /**
   * Reset all shortcuts to defaults. Preferences and appearance are left alone.
   */
  reset() {
    const s = readSettings()
    writeSettings({ ...s, shortcuts: { ...DEFAULT_SHORTCUTS } })
  }

  /**
   * Restore a named group of preferences to their defaults.
   *
   * @param {ReadonlyArray<string>} names
   */
  resetPrefs(names) {
    const s = readSettings()
    for (const name of names ?? []) {
      if (name in DEFAULT_PREFS) s.prefs[name] = DEFAULT_PREFS[name]
    }
    writeSettings(s)
  }

  // -------------------------------------------------------------------------
  // Appearance
  // -------------------------------------------------------------------------

  /** @returns {AppearanceSettings} */
  getAppearance() {
    return readSettings().appearance
  }

  /**
   * Override one diff colour for one theme.
   *
   * Invalid values are refused rather than stored, because a rejected colour
   * that is silently kept would show in the dialog but never on screen.
   *
   * @param {string} theme  'light' | 'dark'
   * @param {string} key  one of {@link COLOR_TOKENS}
   * @param {string} value  `#rgb` or `#rrggbb`
   * @returns {boolean} whether it was accepted
   */
  setColor(theme, key, value) {
    if (!COLOR_THEMES.includes(theme)) return false
    if (!COLOR_KEYS.includes(key)) return false
    if (!isValidColor(value)) return false
    const s = readSettings()
    s.appearance.colors[theme][key] = value.trim().toLowerCase()
    writeSettings(s)
    return true
  }

  /**
   * Drop colour overrides so the stylesheet's own values apply again.
   *
   * @param {string} [theme] 'light' | 'dark'; omitted resets both
   */
  resetColors(theme) {
    const s = readSettings()
    for (const t of COLOR_THEMES) {
      if (theme === undefined || theme === t) s.appearance.colors[t] = {}
    }
    writeSettings(s)
  }

  /**
   * @param {'ui'|'mono'} name
   * @param {string} value  font-family list; '' restores the stylesheet default
   * @returns {boolean} whether it was accepted
   */
  setFontFamily(name, value) {
    if (name !== 'ui' && name !== 'mono') return false
    if (!isValidFontFamily(value)) return false
    const s = readSettings()
    s.appearance.fonts[name] = String(value).trim()
    writeSettings(s)
    return true
  }

  /**
   * @param {number} px  clamped to [MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE]
   * @returns {number} the size actually stored
   */
  setUiFontSize(px) {
    const s = readSettings()
    const n = Number(px)
    const clamped = Number.isFinite(n)
      ? Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, Math.round(n)))
      : DEFAULT_FONTS.uiSize
    s.appearance.fonts.uiSize = clamped
    writeSettings(s)
    return clamped
  }

  /** Restore every colour and font to the shipped defaults. */
  resetAppearance() {
    const s = readSettings()
    s.appearance = normaliseAppearance(null)
    writeSettings(s)
  }

  /** Remove all stored settings (used by tests). */
  clear() {
    try {
      localStorage.removeItem(KEY_SETTINGS)
    } catch {
      // silent
    }
  }
}

// ---------------------------------------------------------------------------
// Settings bundle — export / import of everything the app remembers
// ---------------------------------------------------------------------------

/** Marker so an arbitrary .json dropped on the import button is rejected. */
export const SETTINGS_BUNDLE_KIND = 'mycompare.settings'

/** Bumped whenever the bundle shape changes incompatibly. */
export const SETTINGS_BUNDLE_VERSION = 1

/**
 * Section name → localStorage key.
 *
 * Read through the raw keys rather than through each owning store: the bundle
 * has to move whatever is actually persisted, and a store that gains a field
 * would otherwise be exported with the field missing.
 *
 * Remote connection profiles are deliberately absent — they live in the main
 * process (`remote-profiles.json`) with passwords sealed by the OS keychain,
 * and a bundle is a file the user mails around.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const BUNDLE_SECTIONS = Object.freeze({
  settings:      'mycompare:settings',      // shortcuts + prefs + appearance
  theme:         'mycompare:theme',
  namedConfigs:  'mycompare:namedConfigs',
  workspaces:    'mycompare:workspaces',
  sessionGroups: 'mycompare:sessionGroups',
  sessions:      'mycompare:sessions',
  recent:        'mycompare:recent',
  folderColumns: 'mycompare:folderColumns',
})

/**
 * Property names that must never appear in an exported file.
 *
 * No current section stores one; the filter exists so that a section which
 * later starts carrying a credential cannot leak it by simply being added to
 * BUNDLE_SECTIONS. Ciphertext counts: a sealed blob is still the secret.
 */
const SECRET_KEY_RE = /pass(word|phrase)?|secret|token|credential|privatekey|apikey|(^|[^a-z])auth([^a-z]|$)/i

/**
 * Deep copy with anything credential-shaped removed.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function scrubSecrets(value, _seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (_seen.has(value)) return /** @type {any} */ ([])
    _seen.add(value)
    return /** @type {any} */ (value.map((v) => scrubSecrets(v, _seen)))
  }
  if (value && typeof value === 'object') {
    // Parsed JSON cannot contain a cycle, but this is exported, so a caller
    // may hand over a live object. Recursing forever on one would take out the
    // export rather than merely mishandling it.
    if (_seen.has(value)) return /** @type {any} */ ({})
    _seen.add(value)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) continue
      out[k] = scrubSecrets(v, _seen)
    }
    return /** @type {any} */ (out)
  }
  return value
}

/**
 * @typedef {object} SettingsBundle
 * @property {string} kind
 * @property {number} version
 * @property {string} exportedAt
 * @property {Record<string, unknown>} sections
 */

/**
 * Read one localStorage key back as structured data.
 *
 * `mycompare:theme` holds a bare word rather than JSON, so a parse failure is
 * a value, not an error.
 *
 * @param {string} key
 * @returns {unknown}
 */
function readRawKey(key) {
  const raw = localStorage.getItem(key)
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Collect every persisted setting into one serialisable object.
 *
 * @param {Date} [now]
 * @returns {SettingsBundle}
 */
export function buildSettingsBundle(now = new Date()) {
  /** @type {Record<string, unknown>} */
  const sections = {}
  for (const [name, key] of Object.entries(BUNDLE_SECTIONS)) {
    const value = readRawKey(key)
    if (value !== undefined) sections[name] = value
  }
  return {
    kind: SETTINGS_BUNDLE_KIND,
    version: SETTINGS_BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    sections: scrubSecrets(sections),
  }
}

/**
 * @param {Date} [now]
 * @returns {string} pretty-printed JSON, ready to write to disk
 */
export function exportSettingsJSON(now = new Date()) {
  return JSON.stringify(buildSettingsBundle(now), null, 2)
}

/**
 * @typedef {object} ParsedBundle
 * @property {number} version
 * @property {Record<string, unknown>} sections
 * @property {unknown[] | null} legacySessions  a pre-bundle Sessions-only export
 */

/**
 * Parse and validate an exported file without touching storage.
 *
 * Throws on anything it cannot fully understand. Reporting the reason and
 * changing nothing is the whole point: a partially applied import leaves the
 * app in a state neither the file nor the user asked for.
 *
 * @param {string} json
 * @returns {ParsedBundle}
 */
export function readSettingsBundle(json) {
  let parsed
  try {
    parsed = JSON.parse(String(json))
  } catch (err) {
    throw new Error(`設定檔不是有效的 JSON：${err instanceof Error ? err.message : String(err)}`)
  }

  // The Sessions-only export shipped long before bundles existed and is still
  // the format of every file users exported until now.
  if (Array.isArray(parsed)) {
    return { version: 0, sections: {}, legacySessions: parsed }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('設定檔內容不是物件')
  }
  if (parsed.kind !== SETTINGS_BUNDLE_KIND) {
    throw new Error(`這不是 MyCompare 設定檔（kind = ${JSON.stringify(parsed.kind ?? null)}）`)
  }
  const version = parsed.version
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('設定檔缺少有效的 version 欄位')
  }
  if (version > SETTINGS_BUNDLE_VERSION) {
    throw new Error(
      `設定檔版本 ${version} 比本程式支援的 ${SETTINGS_BUNDLE_VERSION} 新，請先更新 MyCompare`)
  }
  const sections = parsed.sections
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
    throw new Error('設定檔缺少 sections 區段')
  }
  const unknown = Object.keys(sections).filter((k) => !(k in BUNDLE_SECTIONS))
  if (unknown.length) {
    throw new Error(`設定檔含有無法識別的區段：${unknown.join('、')}`)
  }

  return { version, sections, legacySessions: null }
}

/**
 * @typedef {object} ImportResult
 * @property {number} version  version of the file that was read
 * @property {string[]} applied  section names written
 * @property {unknown[] | null} legacySessions  caller must hand these to SessionStore
 */

/**
 * Validate a bundle in full, then write it.
 *
 * @param {string} json
 * @returns {ImportResult}
 */
export function applySettingsBundle(json) {
  const bundle = readSettingsBundle(json)
  if (bundle.legacySessions) {
    return { version: 0, applied: [], legacySessions: bundle.legacySessions }
  }

  // Serialise everything first: a JSON.stringify failure halfway through the
  // write loop would leave half the old settings and half the new ones.
  /** @type {Array<[string, string]>} */
  const staged = []
  for (const [name, value] of Object.entries(bundle.sections)) {
    const key = BUNDLE_SECTIONS[name]
    staged.push([key, typeof value === 'string' ? value : JSON.stringify(value)])
  }
  for (const [key, raw] of staged) localStorage.setItem(key, raw)

  return { version: bundle.version, applied: Object.keys(bundle.sections), legacySessions: null }
}
