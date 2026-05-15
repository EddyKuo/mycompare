/**
 * @file named-config-store.js
 * @description Persistence for user-named view settings ("config profiles").
 *   Stores per-view-type setting bundles in localStorage so users can save
 *   the current ignore/algorithm/etc. options under a friendly name and
 *   later restore them.
 *
 *   All operations are try/catch guarded; storage errors silently fall back
 *   to no-ops or empty results — never throw to callers.
 */

const KEY_NAMED_CONFIGS = 'mycompare:namedConfigs'

/**
 * @typedef {'text' | 'folder' | 'table' | 'image' | 'hex'} NamedConfigViewType
 */

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
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * @param {Record<string, NamedConfigEntry>} map
 */
function writeMap(map) {
  try {
    localStorage.setItem(KEY_NAMED_CONFIGS, JSON.stringify(map))
  } catch {
    // quota exceeded — silent
  }
}

export class NamedConfigStore {
  /**
   * Save (or overwrite) a named config.
   * @param {string} name
   * @param {NamedConfigViewType} viewType
   * @param {Record<string, unknown>} settings
   * @returns {NamedConfigEntry | null}
   */
  save(name, viewType, settings) {
    if (typeof name !== 'string' || !name.trim()) return null
    if (!settings || typeof settings !== 'object') return null
    const map = readMap()
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
   * Returns an array of { name, viewType, createdAt, settings } sorted by
   * createdAt descending (newest first).
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
