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
  try {
    const raw = localStorage.getItem(KEY_SETTINGS)
    if (!raw) return { shortcuts: { ...DEFAULT_SHORTCUTS }, prefs: { ...DEFAULT_PREFS } }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { shortcuts: { ...DEFAULT_SHORTCUTS }, prefs: { ...DEFAULT_PREFS } }
    }
    const stored = (parsed.shortcuts && typeof parsed.shortcuts === 'object')
      ? parsed.shortcuts
      : {}
    const storedPrefs = (parsed.prefs && typeof parsed.prefs === 'object')
      ? parsed.prefs
      : {}
    return {
      shortcuts: { ...DEFAULT_SHORTCUTS, ...stored },
      prefs: { ...DEFAULT_PREFS, ...storedPrefs },
    }
  } catch {
    return { shortcuts: { ...DEFAULT_SHORTCUTS }, prefs: { ...DEFAULT_PREFS } }
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
   * Reset all shortcuts to defaults. Preferences are left alone.
   */
  reset() {
    const s = readSettings()
    writeSettings({ shortcuts: { ...DEFAULT_SHORTCUTS }, prefs: s.prefs })
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
