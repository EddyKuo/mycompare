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
 */

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
 * @returns {AppSettings}
 */
function readSettings() {
  try {
    const raw = localStorage.getItem(KEY_SETTINGS)
    if (!raw) return { shortcuts: { ...DEFAULT_SHORTCUTS } }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { shortcuts: { ...DEFAULT_SHORTCUTS } }
    }
    const stored = (parsed.shortcuts && typeof parsed.shortcuts === 'object')
      ? parsed.shortcuts
      : {}
    return { shortcuts: { ...DEFAULT_SHORTCUTS, ...stored } }
  } catch {
    return { shortcuts: { ...DEFAULT_SHORTCUTS } }
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
   * Reset all shortcuts to defaults.
   */
  reset() {
    writeSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } })
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
