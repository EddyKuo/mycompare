/**
 * @file workspace-store.js
 * @description Persistence for user-named "workspaces" — a saved set of
 *   open tabs (paths + type + title) that can later be restored.
 *
 *   Workspaces explicitly DO NOT persist the heavy `state` field of tab
 *   records (which can contain large file contents). On restore, paths are
 *   re-read via electronAPI.
 *
 *   All operations are try/catch guarded; storage errors silently fall
 *   back to no-ops or empty results — never throw to callers.
 */

const KEY_WORKSPACES = 'mycompare:workspaces'
const SCHEMA_VERSION = 1   // S15-U10

/**
 * @typedef {object} WorkspaceTabRecord
 * @property {string} type
 * @property {string} leftPath
 * @property {string} rightPath
 * @property {string} basePath
 * @property {string} title
 */

/**
 * @typedef {object} WorkspaceEntry
 * @property {WorkspaceTabRecord[]} tabs
 * @property {string} createdAt ISO-8601 timestamp
 */

/** @returns {Record<string, WorkspaceEntry>} */
function readMap() {
  try {
    const raw = localStorage.getItem(KEY_WORKSPACES)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    if (typeof parsed.__schema === 'number' && parsed.entries && typeof parsed.entries === 'object') {
      return parsed.entries
    }
    return parsed
  } catch {
    return {}
  }
}

/**
 * @param {Record<string, WorkspaceEntry>} map
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function writeMap(map) {
  try {
    localStorage.setItem(KEY_WORKSPACES, JSON.stringify({ __schema: SCHEMA_VERSION, entries: map }))
    return { ok: true }
  } catch (err) {
    const reason = err?.name === 'QuotaExceededError' ? 'quota' : 'unknown'
    // S14-M12: surface a toast on persistence failures.
    try {
      import('./toast.js').then(({ toast }) => {
        toast(reason === 'quota'
          ? 'localStorage 空間不足，無法儲存工作區'
          : '儲存工作區失敗', { type: 'error' })
      }).catch(() => {})
    } catch { /* ignore */ }
    return { ok: false, reason }
  }
}

/**
 * Strip the heavy `state` field and any other unknown keys, leaving only
 * the lightweight per-tab fields needed to restore.
 *
 * @param {Array<{ type?: string, leftPath?: string, rightPath?: string, basePath?: string, title?: string }>} tabs
 * @returns {WorkspaceTabRecord[]}
 */
export function serialiseTabs(tabs) {
  if (!Array.isArray(tabs)) return []
  return tabs.map(t => ({
    type:      typeof t?.type      === 'string' ? t.type      : '',
    leftPath:  typeof t?.leftPath  === 'string' ? t.leftPath  : '',
    rightPath: typeof t?.rightPath === 'string' ? t.rightPath : '',
    basePath:  typeof t?.basePath  === 'string' ? t.basePath  : '',
    title:     typeof t?.title     === 'string' ? t.title     : '',
  }))
}

export class WorkspaceStore {
  /**
   * Save (or overwrite) a workspace.
   * The heavy `state` field on tabs is stripped before persistence.
   * @param {string} name
   * @param {Array<object>} tabs
   * @returns {WorkspaceEntry | null}
   */
  save(name, tabs) {
    if (typeof name !== 'string' || !name.trim()) return null
    if (!Array.isArray(tabs)) return null
    /** @type {WorkspaceEntry} */
    const entry = {
      tabs: serialiseTabs(tabs),
      createdAt: new Date().toISOString(),
    }
    const map = readMap()
    map[name] = entry
    writeMap(map)
    return entry
  }

  /**
   * @param {string} name
   * @returns {WorkspaceEntry | null}
   */
  get(name) {
    const map = readMap()
    return map[name] ?? null
  }

  /** @param {string} name */
  remove(name) {
    const map = readMap()
    if (map[name] === undefined) return
    delete map[name]
    writeMap(map)
  }

  /**
   * List all workspaces, sorted by createdAt descending (newest first).
   * @returns {Array<{ name: string } & WorkspaceEntry>}
   */
  list() {
    const map = readMap()
    const out = []
    for (const [name, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== 'object') continue
      out.push({ name, ...entry })
    }
    out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return out
  }

  /** Remove every stored workspace (used in tests). */
  clear() {
    writeMap({})
  }
}
