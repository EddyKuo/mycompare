/**
 * @file named-config-store.js
 * @description Persistence for user-named view settings ("config profiles").
 *   Stores per-view-type setting bundles in localStorage so users can save
 *   the current ignore/algorithm/etc. options under a friendly name and
 *   later restore them.
 *
 *   All operations are try/catch guarded; storage errors return `{ ok:false }`
 *   to the caller rather than throwing.
 */

const KEY_NAMED_CONFIGS = 'mycompare:namedConfigs'
const SCHEMA_VERSION = 1   // S15-U10

/**
 * @typedef {'text' | 'folder' | 'table' | 'image' | 'hex' | 'metadata' | 'merge3'} NamedConfigViewType
 */

/**
 * Version of the *payload* a view writes through `getConfig()`.
 *
 * Distinct from SCHEMA_VERSION above, which versions the storage envelope:
 * the envelope can change without any view changing its settings shape, and
 * vice versa.
 */
export const CONFIG_SCHEMA_VERSION = 1

/**
 * Stamp a view's settings snapshot with its version and owning view type.
 *
 * The view tag is what lets `readConfig` refuse a foreign snapshot outright.
 * Without it a folder config applied to the table view would set whichever
 * keys happened to collide and silently leave the rest — a half-applied
 * state that is worse than doing nothing.
 *
 * @param {NamedConfigViewType} viewType
 * @param {Record<string, unknown>} settings
 * @returns {Record<string, unknown>}
 */
export function tagConfig(viewType, settings) {
  return { __v: CONFIG_SCHEMA_VERSION, __view: viewType, ...settings }
}

/**
 * Validate an incoming snapshot for `viewType` and hand back its settings.
 *
 * @param {NamedConfigViewType} viewType the view asking to apply the snapshot
 * @param {unknown} cfg
 * @returns {Record<string, unknown> | null} null when the caller must not apply it
 */
export function readConfig(viewType, cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null
  /** @type {Record<string, unknown>} */ const rec = cfg

  // Absent version = a snapshot written before versioning existed. Those only
  // ever held the writing view's own keys, so they stay loadable.
  const version = rec.__v
  if (version !== undefined) {
    if (typeof version !== 'number' || !Number.isFinite(version)) return null
    // A newer format may have changed the meaning of a key we still recognise,
    // so guessing is unsafe — refuse rather than apply a subset.
    if (version > CONFIG_SCHEMA_VERSION) return null
  }

  const view = rec.__view
  if (view !== undefined && view !== viewType) return null

  return rec
}

/**
 * @typedef {object} NamedConfigEntry
 * @property {NamedConfigViewType} viewType
 * @property {Record<string, unknown>} settings
 * @property {string} createdAt ISO-8601 timestamp
 */

/**
 * @returns {Record<string, NamedConfigEntry>}
 */
function readMap() {
  try {
    const raw = localStorage.getItem(KEY_NAMED_CONFIGS)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Schema envelope: { __schema, entries: {...} }; tolerate legacy flat shape.
    if (typeof parsed.__schema === 'number' && parsed.entries && typeof parsed.entries === 'object') {
      return parsed.entries
    }
    return parsed
  } catch {
    return {}
  }
}

/**
 * @param {Record<string, NamedConfigEntry>} map
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function writeMap(map) {
  try {
    localStorage.setItem(KEY_NAMED_CONFIGS, JSON.stringify({ __schema: SCHEMA_VERSION, entries: map }))
    return { ok: true }
  } catch (err) {
    const reason = err?.name === 'QuotaExceededError' ? 'quota' : 'unknown'
    // S14-M12: surface a toast so the user notices that their config was NOT
    // persisted. Lazy-import to avoid a hard dependency in test envs that
    // don't render the toast container.
    try {
      import('./toast.js').then(({ toast }) => {
        toast(reason === 'quota'
          ? 'localStorage 空間不足，無法儲存設定'
          : '儲存設定失敗', { type: 'error' })
      }).catch(() => { /* test env without DOM — silent */ })
    } catch { /* ignore */ }
    return { ok: false, reason }
  }
}

export class NamedConfigStore {
  /**
   * Save (or overwrite) a named config.
   *
   * S13-C09: refuse to overwrite an entry of a *different* viewType under
   * the same name — that would silently nuke the user's text config when
   * they save a folder config with the same name.
   *
   * @param {string} name
   * @param {NamedConfigViewType} viewType
   * @param {Record<string, unknown>} settings
   * @returns {NamedConfigEntry | null}
   */
  save(name, viewType, settings) {
    if (typeof name !== 'string' || !name.trim()) return null
    if (!settings || typeof settings !== 'object') return null
    const map = readMap()
    const existing = map[name]
    if (existing && existing.viewType && existing.viewType !== viewType) {
      // Refuse cross-viewType collision (caller should rename).
      return null
    }
    /** @type {NamedConfigEntry} */
    const entry = {
      viewType,
      settings: JSON.parse(JSON.stringify(settings)),
      createdAt: new Date().toISOString(),
    }
    map[name] = entry
    writeMap(map)
    return entry
  }

  /**
   * @param {string} name
   * @returns {NamedConfigEntry | null}
   */
  get(name) {
    const map = readMap()
    return map[name] ?? null
  }

  /**
   * @param {string} name
   * @returns {void}
   */
  remove(name) {
    const map = readMap()
    if (map[name] === undefined) return
    delete map[name]
    writeMap(map)
  }

  /**
   * List configs, optionally filtered by viewType.
   * @param {NamedConfigViewType} [viewType]
   * @returns {Array<{ name: string } & NamedConfigEntry>}
   */
  list(viewType) {
    const map = readMap()
    const out = []
    for (const [name, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== 'object') continue
      if (viewType && entry.viewType !== viewType) continue
      out.push({ name, ...entry })
    }
    out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return out
  }

  /** Remove every stored named config (used in tests). */
  clear() {
    writeMap({})
  }
}
