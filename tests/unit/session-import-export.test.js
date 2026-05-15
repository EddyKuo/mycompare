/**
 * Unit tests for SessionStore.exportJSON() and SessionStore.importJSON()
 * Covers T19: Session export/import (JSON backup).
 *
 * Runs in node environment; localStorage is polyfilled via a Map-backed mock.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// localStorage polyfill (node environment has no localStorage)
// ---------------------------------------------------------------------------

/** @type {Map<string, string>} */
let _store

const localStorageMock = {
  getItem:    (key)        => _store.has(key) ? _store.get(key) : null,
  setItem:    (key, value) => { _store.set(key, String(value)) },
  removeItem: (key)        => { _store.delete(key) },
  clear:      ()           => { _store.clear() },
}

// Inject into global before module import
global.localStorage = localStorageMock

// ---------------------------------------------------------------------------
// Module import (graceful)
// ---------------------------------------------------------------------------

let SessionStore
let importError = null

try {
  const mod = await import('../../src/renderer/src/core/session-store.js')
  SessionStore = mod.SessionStore
} catch (err) {
  importError = err
}

function requireModule() {
  if (importError) {
    throw new Error(
      `session-store.js failed to load.\n` +
      `Original error: ${importError.message}`
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid session object that session-store can persist.
 * Uses the same fields accepted by serializeSession / deserializeSession.
 *
 * @param {string} [id]
 * @returns {object}
 */
function makeSession(id = `sess-${Math.random().toString(36).slice(2)}`) {
  const now = new Date().toISOString()
  return {
    id,
    type:      'text-compare',
    name:      `Session ${id}`,
    createdAt: now,
    updatedAt: now,
    options:   {},
  }
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('SessionStore.exportJSON', () => {
  beforeEach(() => {
    _store = new Map()
  })

  // IE-1: empty store returns '[]'
  it('returns "[]" when no sessions are stored', () => {
    requireModule()
    const ss = new SessionStore()
    const json = ss.exportJSON()
    expect(json).toBeTypeOf('string')
    const parsed = JSON.parse(json)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(0)
  })

  // IE-2: returns valid JSON
  it('returns valid JSON after saving sessions', () => {
    requireModule()
    const ss = new SessionStore()
    ss.save(makeSession('a1'))
    ss.save(makeSession('a2'))
    const json = ss.exportJSON()
    expect(() => JSON.parse(json)).not.toThrow()
  })

  // IE-3: exported array length matches saved sessions
  it('exported array contains all saved sessions', () => {
    requireModule()
    const ss = new SessionStore()
    ss.save(makeSession('b1'))
    ss.save(makeSession('b2'))
    ss.save(makeSession('b3'))
    const parsed = JSON.parse(ss.exportJSON())
    expect(parsed).toHaveLength(3)
  })

  // IE-4: each exported item has the required fields
  it('each exported session has id, type, name, createdAt', () => {
    requireModule()
    const ss = new SessionStore()
    const session = makeSession('c1')
    ss.save(session)
    const [exported] = JSON.parse(ss.exportJSON())
    expect(exported).toHaveProperty('id')
    expect(exported).toHaveProperty('type')
    expect(exported).toHaveProperty('name')
    expect(exported).toHaveProperty('createdAt')
  })

  // IE-5: exportJSON returns a string (type check)
  it('exportJSON always returns a string', () => {
    requireModule()
    const ss = new SessionStore()
    expect(ss.exportJSON()).toBeTypeOf('string')
    ss.save(makeSession('d1'))
    expect(ss.exportJSON()).toBeTypeOf('string')
  })
})

describe('SessionStore.importJSON', () => {
  beforeEach(() => {
    _store = new Map()
  })

  // II-1: imports sessions from a valid JSON string
  it('imports sessions and returns correct imported count', () => {
    requireModule()
    const source = new SessionStore()
    source.save(makeSession('e1'))
    source.save(makeSession('e2'))
    const json = source.exportJSON()

    _store = new Map() // fresh store
    const target = new SessionStore()
    const { imported, skipped } = target.importJSON(json)

    expect(imported).toBe(2)
    expect(skipped).toBe(0)
  })

  // II-2: duplicate ids are skipped
  it('skips sessions whose ids already exist in the store', () => {
    requireModule()
    const ss = new SessionStore()
    const session = makeSession('f1')
    ss.save(session)

    // export contains f1, which already exists → should be skipped
    const json = JSON.stringify([session])
    const { imported, skipped } = ss.importJSON(json)

    expect(imported).toBe(0)
    expect(skipped).toBeGreaterThanOrEqual(1)
  })

  // II-3: imported sessions are retrievable by getAll()
  it('imported sessions are persisted and retrievable', () => {
    requireModule()
    const session = makeSession('g1')
    const json = JSON.stringify([session])

    const ss = new SessionStore()
    ss.importJSON(json)

    const all = ss.getAll()
    const found = all.find((s) => s.id === 'g1')
    expect(found).toBeDefined()
    expect(found?.name).toBe(session.name)
  })

  // II-4: importJSON on empty array returns 0 imported, 0 skipped
  it('returns { imported: 0, skipped: 0 } when importing an empty array', () => {
    requireModule()
    const ss = new SessionStore()
    const { imported, skipped } = ss.importJSON('[]')
    expect(imported).toBe(0)
    expect(skipped).toBe(0)
  })

  // II-5: malformed JSON does not throw and returns counts
  it('handles malformed JSON without throwing', () => {
    requireModule()
    const ss = new SessionStore()
    expect(() => {
      const result = ss.importJSON('this is not json')
      // Should return an object with imported/skipped even on error
      expect(result).toHaveProperty('imported')
      expect(result).toHaveProperty('skipped')
    }).not.toThrow()
  })

  // II-6: partial import — valid and invalid items mixed
  it('skips invalid items while importing valid ones', () => {
    requireModule()
    const validSession = makeSession('h1')
    const invalidItem  = { notASession: true }
    const json = JSON.stringify([validSession, invalidItem])

    const ss = new SessionStore()
    const { imported, skipped } = ss.importJSON(json)

    // validSession should import; invalidItem should be skipped
    expect(imported).toBe(1)
    expect(skipped).toBe(1)
  })

  // II-7: round-trip: export then import on a fresh store recovers all sessions
  it('round-trip export→import restores all sessions in a fresh store', () => {
    requireModule()
    const source = new SessionStore()
    source.save(makeSession('i1'))
    source.save(makeSession('i2'))
    source.save(makeSession('i3'))
    const json = source.exportJSON()

    _store = new Map() // completely fresh storage
    const target = new SessionStore()
    const { imported } = target.importJSON(json)

    expect(imported).toBe(3)
    expect(target.getAll()).toHaveLength(3)
  })
})
