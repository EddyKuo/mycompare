/**
 * @file session-store.js
 * @description Session persistence module backed by localStorage.
 * No external npm dependencies. All operations are try/catch guarded;
 * a full storage quota silently fails rather than throwing to callers.
 */

import { serializeSession, deserializeSession } from './session.js'

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const KEY_SESSIONS = 'mycompare:sessions' // { [id]: serialisedSession }
const KEY_RECENT   = 'mycompare:recent'   // string[] of ids, LRU order
const SCHEMA_VERSION = 1                  // S15-U10

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * Read the sessions map from localStorage.
 * @returns {Record<string, string>}
 */
function readSessionsMap() {
  try {
    const raw = localStorage.getItem(KEY_SESSIONS)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.__schema === 'number' && parsed.entries) return parsed.entries
    return parsed
  } catch {
    return {}
  }
}

/**
 * Write the sessions map back to localStorage.
 * Silently swallows QuotaExceededError.
 * @param {Record<string, string>} map
 */
function writeSessionsMap(map) {
  try {
    localStorage.setItem(KEY_SESSIONS, JSON.stringify({ __schema: SCHEMA_VERSION, entries: map }))
    return { ok: true }
  } catch (err) {
    const reason = err?.name === 'QuotaExceededError' ? 'quota' : 'unknown'
    // S14-M12
    try {
      import('./toast.js').then(({ toast }) => {
        toast(reason === 'quota'
          ? 'localStorage 空間不足，無法儲存 session'
          : '儲存 session 失敗', { type: 'error' })
      }).catch(() => {})
    } catch { /* ignore */ }
    return { ok: false, reason }
  }
}

/**
 * Read the LRU recent-ids array from localStorage.
 * @returns {string[]}
 */
function readRecentIds() {
  try {
    const raw = localStorage.getItem(KEY_RECENT)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Write the LRU recent-ids array back to localStorage.
 * @param {string[]} ids
 */
function writeRecentIds(ids) {
  try {
    localStorage.setItem(KEY_RECENT, JSON.stringify(ids))
  } catch {
    // localStorage full — silent failure
  }
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  constructor() {
    // Nothing to initialise — all state lives in localStorage.
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /**
   * Persist a session (insert or update).
   * Stamps `updatedAt` with the current time before saving.
   *
   * @param {import('./session.js').Session} session
   * @returns {import('./session.js').Session}  The saved session (with fresh updatedAt)
   */
  save(session) {
    try {
      const updated = { ...session, updatedAt: new Date().toISOString() }
      const map = readSessionsMap()
      map[updated.id] = serializeSession(updated)
      writeSessionsMap(map)
      return updated
    } catch {
      // Validation / serialisation error — return original unchanged
      return session
    }
  }

  /**
   * Remove a session by id.
   * Also removes the id from the LRU recent list.
   *
   * @param {string} id
   * @returns {void}
   */
  remove(id) {
    try {
      const map = readSessionsMap()
      delete map[id]
      writeSessionsMap(map)
    } catch {
      // silent
    }

    try {
      const ids = readRecentIds().filter((rid) => rid !== id)
      writeRecentIds(ids)
    } catch {
      // silent
    }
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Return all stored sessions sorted by `updatedAt` descending.
   *
   * @returns {import('./session.js').Session[]}
   */
  getAll() {
    try {
      const map = readSessionsMap()
      const sessions = []
      for (const raw of Object.values(map)) {
        try {
          sessions.push(deserializeSession(raw))
        } catch {
          // skip corrupted entry
        }
      }
      sessions.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
      return sessions
    } catch {
      return []
    }
  }

  /**
   * Return the n most recently updated sessions.
   *
   * @param {number} [n=10]
   * @returns {import('./session.js').Session[]}
   */
  getRecent(n = 10) {
    return this.getAll().slice(0, n)
  }

  /**
   * Look up a single session by id.
   *
   * @param {string} id
   * @returns {import('./session.js').Session | null}
   */
  getById(id) {
    try {
      const map = readSessionsMap()
      const raw = map[id]
      if (!raw) return null
      return deserializeSession(raw)
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // LRU recently-opened
  // -------------------------------------------------------------------------

  /**
   * Record that a session was opened right now.
   * Does NOT modify the session's own `updatedAt`.
   *
   * @param {string} id
   * @returns {void}
   */
  touch(id) {
    try {
      let ids = readRecentIds().filter((rid) => rid !== id)
      ids.unshift(id)
      // cap at a reasonable size to avoid bloated storage
      if (ids.length > 100) ids = ids.slice(0, 100)
      writeRecentIds(ids)
    } catch {
      // silent
    }
  }

  /**
   * Return the n most recently opened sessions (LRU order, newest first).
   * Sessions that no longer exist in the store are silently omitted.
   *
   * @param {number} [n=10]
   * @returns {import('./session.js').Session[]}
   */
  getRecentlyOpened(n = 10) {
    try {
      const ids = readRecentIds()
      const results = []
      for (const id of ids) {
        if (results.length >= n) break
        const session = this.getById(id)
        if (session) results.push(session)
      }
      return results
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // Import / Export
  // -------------------------------------------------------------------------

  /**
   * Export all sessions as a JSON string.
   *
   * @returns {string}
   */
  exportJSON() {
    try {
      const sessions = this.getAll()
      return JSON.stringify(sessions, null, 2)
    } catch {
      return '[]'
    }
  }

  /**
   * Import sessions from a JSON string produced by {@link exportJSON}.
   * Duplicate ids (already present in the store) are skipped.
   *
   * @param {string} json
   * @returns {{ imported: number, skipped: number }}
   */
  importJSON(json) {
    let imported = 0
    let skipped = 0

    try {
      const data = JSON.parse(json)
      if (!Array.isArray(data)) return { imported, skipped }

      const map = readSessionsMap()

      for (const item of data) {
        try {
          // Re-serialise via the session module to validate shape
          const raw = serializeSession(item)
          const session = deserializeSession(raw)

          if (map[session.id] !== undefined) {
            skipped++
            continue
          }

          map[session.id] = raw
          imported++
        } catch {
          skipped++
        }
      }

      writeSessionsMap(map)
    } catch {
      // Malformed JSON or write error — return whatever counts we have
    }

    return { imported, skipped }
  }
}
