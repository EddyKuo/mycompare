/**
 * Unit tests for src/renderer/src/core/session.js
 *
 * The module is expected to export:
 *   - createSession(type, name, options?) → Session
 *   - serializeSession(session)           → string  (JSON)
 *   - deserializeSession(raw)             → Session
 *
 * Session shape (minimum required fields):
 *   {
 *     id:        string   – unique, non-empty
 *     type:      string   – one of the supported session types
 *     name:      string   – user-visible label
 *     createdAt: string   – ISO 8601 date string
 *     options:   object   – (optional) type-specific configuration
 *   }
 *
 * Supported session types (at minimum):
 *   'text-compare' | 'folder-compare' | 'hex-compare' | 'merge'
 */

import { describe, it, expect, beforeEach } from 'vitest'

// ── Graceful import ───────────────────────────────────────────────────────────
let createSession, serializeSession, deserializeSession
let importError = null

try {
  const mod = await import('../../src/renderer/src/core/session.js')
  createSession      = mod.createSession
  serializeSession   = mod.serializeSession
  deserializeSession = mod.deserializeSession
} catch (err) {
  importError = err
}

// ── Helper ────────────────────────────────────────────────────────────────────

function requireModule() {
  if (importError) {
    throw new Error(
      `session.js module not found or failed to load.\n` +
      `Create src/renderer/src/core/session.js and export createSession, ` +
      `serializeSession, deserializeSession.\n` +
      `Original error: ${importError.message}`
    )
  }
}

/** Assert that a value looks like an ISO 8601 date string. */
function assertISO8601(value) {
  expect(value).toBeTypeOf('string')
  const date = new Date(value)
  expect(date.toString()).not.toBe('Invalid Date')
  // Must round-trip through JSON without loss
  expect(new Date(value).toISOString()).toBe(value)
}

/** Assert minimal Session shape. */
function assertSessionShape(session) {
  expect(session).toBeTypeOf('object')
  expect(session).not.toBeNull()

  // id – non-empty string
  expect(session).toHaveProperty('id')
  expect(session.id).toBeTypeOf('string')
  expect(session.id.trim().length).toBeGreaterThan(0)

  // type – string
  expect(session).toHaveProperty('type')
  expect(session.type).toBeTypeOf('string')

  // name – string
  expect(session).toHaveProperty('name')
  expect(session.name).toBeTypeOf('string')

  // createdAt – ISO 8601
  expect(session).toHaveProperty('createdAt')
  assertISO8601(session.createdAt)
}

const SUPPORTED_TYPES = ['text-compare', 'folder-compare', 'hex-compare', 'merge']

// ═══════════════════════════════════════════════════════════════════════════════
// 1. createSession
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSession', () => {
  // ── 1-A: correct return shape ───────────────────────────────────────────────
  it('returns an object with all required fields', () => {
    requireModule()
    const session = createSession('text-compare', 'My Diff')
    assertSessionShape(session)
  })

  // ── 1-B: type is preserved ─────────────────────────────────────────────────
  it('stores the provided type on the session', () => {
    requireModule()
    for (const type of SUPPORTED_TYPES) {
      const session = createSession(type, `${type} session`)
      expect(session.type).toBe(type)
    }
  })

  // ── 1-C: name is preserved ─────────────────────────────────────────────────
  it('stores the provided name on the session', () => {
    requireModule()
    const session = createSession('text-compare', 'Custom Name')
    expect(session.name).toBe('Custom Name')
  })

  // ── 1-D: each call produces a unique id ────────────────────────────────────
  it('generates a unique id for every session', () => {
    requireModule()
    const ids = new Set(
      Array.from({ length: 20 }, () => createSession('text-compare', 'x').id)
    )
    expect(ids.size).toBe(20)
  })

  // ── 1-E: createdAt is close to now ─────────────────────────────────────────
  it('sets createdAt to the current time (within 2 seconds)', () => {
    requireModule()
    const before  = Date.now()
    const session = createSession('text-compare', 'timing-test')
    const after   = Date.now()

    const ts = new Date(session.createdAt).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after + 2000)
  })

  // ── 1-F: options object is forwarded ───────────────────────────────────────
  it('attaches the options object when provided', () => {
    requireModule()
    const opts    = { ignoreWhitespace: true, encoding: 'utf-8' }
    const session = createSession('text-compare', 'with-options', opts)

    expect(session).toHaveProperty('options')
    expect(session.options).toMatchObject(opts)
  })

  // ── 1-G: options defaults to empty object or defined default ───────────────
  it('provides a default options value when options is omitted', () => {
    requireModule()
    const session = createSession('text-compare', 'no-options')
    // Must exist and be an object (not undefined/null)
    expect(session.options).toBeDefined()
    expect(session.options).toBeTypeOf('object')
    expect(session.options).not.toBeNull()
  })

  // ── 1-H: invalid type throws a descriptive error ───────────────────────────
  it('throws when given an unsupported session type', () => {
    requireModule()
    expect(() => createSession('unknown-type', 'bad')).toThrow()
  })

  // ── 1-I: empty name throws ──────────────────────────────────────────────────
  it('throws when name is empty or whitespace-only', () => {
    requireModule()
    expect(() => createSession('text-compare', '')).toThrow()
    expect(() => createSession('text-compare', '   ')).toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. serializeSession / deserializeSession
// ═══════════════════════════════════════════════════════════════════════════════

describe('serializeSession / deserializeSession', () => {
  // ── 2-A: serialize returns a string ────────────────────────────────────────
  it('serializeSession returns a string', () => {
    requireModule()
    const session    = createSession('text-compare', 'ser-test')
    const serialized = serializeSession(session)
    expect(serialized).toBeTypeOf('string')
  })

  // ── 2-B: deserialize returns a Session-shaped object ───────────────────────
  it('deserializeSession returns a Session-shaped object', () => {
    requireModule()
    const session    = createSession('text-compare', 'deser-test')
    const serialized = serializeSession(session)
    const restored   = deserializeSession(serialized)
    assertSessionShape(restored)
  })

  // ── 2-C: round-trip preserves all required fields ──────────────────────────
  it('round-trip preserves id, type, name, and createdAt exactly', () => {
    requireModule()
    const original = createSession('folder-compare', 'Round-trip Test', { recursive: true })
    const restored = deserializeSession(serializeSession(original))

    expect(restored.id).toBe(original.id)
    expect(restored.type).toBe(original.type)
    expect(restored.name).toBe(original.name)
    expect(restored.createdAt).toBe(original.createdAt)
  })

  // ── 2-D: round-trip preserves options ──────────────────────────────────────
  it('round-trip preserves the options object', () => {
    requireModule()
    const opts     = { recursive: true, ignoreHidden: false, maxDepth: 5 }
    const original = createSession('folder-compare', 'options-test', opts)
    const restored = deserializeSession(serializeSession(original))

    expect(restored.options).toMatchObject(opts)
  })

  // ── 2-E: serialize → deserialize → serialize produces the same string ──────
  it('double serialize produces an identical result (idempotent)', () => {
    requireModule()
    const session = createSession('merge', 'idempotent-test')
    const first   = serializeSession(session)
    const second  = serializeSession(deserializeSession(first))
    expect(second).toBe(first)
  })

  // ── 2-F: deserialize throws on malformed input ─────────────────────────────
  it('deserializeSession throws on non-JSON input', () => {
    requireModule()
    expect(() => deserializeSession('this is not json')).toThrow()
  })

  // ── 2-G: deserialize throws when required fields are missing ───────────────
  it('deserializeSession throws when required fields are absent', () => {
    requireModule()
    const noId   = JSON.stringify({ type: 'text-compare', name: 'x', createdAt: new Date().toISOString() })
    const noType = JSON.stringify({ id: '1', name: 'x', createdAt: new Date().toISOString() })
    const noName = JSON.stringify({ id: '1', type: 'text-compare', createdAt: new Date().toISOString() })

    expect(() => deserializeSession(noId)).toThrow()
    expect(() => deserializeSession(noType)).toThrow()
    expect(() => deserializeSession(noName)).toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Type-specific schema validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('type-specific schema', () => {
  // ── 3-A: text-compare ──────────────────────────────────────────────────────
  it('text-compare session has correct defaults or shape', () => {
    requireModule()
    const session = createSession('text-compare', 'text session')
    assertSessionShape(session)
    expect(session.type).toBe('text-compare')
    // text-compare may expose ignoreWhitespace / encoding options
    // We only assert it doesn't throw and has correct shape.
  })

  // ── 3-B: folder-compare ────────────────────────────────────────────────────
  it('folder-compare session has correct defaults or shape', () => {
    requireModule()
    const session = createSession('folder-compare', 'folder session')
    assertSessionShape(session)
    expect(session.type).toBe('folder-compare')
  })

  // ── 3-C: hex-compare ───────────────────────────────────────────────────────
  it('hex-compare session has correct defaults or shape', () => {
    requireModule()
    const session = createSession('hex-compare', 'hex session')
    assertSessionShape(session)
    expect(session.type).toBe('hex-compare')
  })

  // ── 3-D: merge ─────────────────────────────────────────────────────────────
  it('merge session has correct defaults or shape', () => {
    requireModule()
    const session = createSession('merge', 'merge session')
    assertSessionShape(session)
    expect(session.type).toBe('merge')
  })

  // ── 3-E: different types produce distinguishable sessions ──────────────────
  it('sessions of different types are not equal to each other', () => {
    requireModule()
    const sessions = SUPPORTED_TYPES.map(t => createSession(t, `session-${t}`))

    // Every type value is unique in the result set
    const types = sessions.map(s => s.type)
    const unique = new Set(types)
    expect(unique.size).toBe(SUPPORTED_TYPES.length)
  })

  // ── 3-F: text-compare accepts ignoreWhitespace option ──────────────────────
  it('text-compare accepts ignoreWhitespace option without throwing', () => {
    requireModule()
    expect(() =>
      createSession('text-compare', 'ws-test', { ignoreWhitespace: true })
    ).not.toThrow()
  })

  // ── 3-G: folder-compare accepts recursive option ───────────────────────────
  it('folder-compare accepts recursive option without throwing', () => {
    requireModule()
    expect(() =>
      createSession('folder-compare', 'rec-test', { recursive: true })
    ).not.toThrow()
  })

  // ── 3-H: merge session optionally carries a base reference ─────────────────
  it('merge session accepts a base option without throwing', () => {
    requireModule()
    expect(() =>
      createSession('merge', 'merge-base-test', { base: '/path/to/base' })
    ).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 4. id uniqueness and format
// ═══════════════════════════════════════════════════════════════════════════════

describe('session id contract', () => {
  it('id is a non-empty string with no leading/trailing whitespace', () => {
    requireModule()
    const session = createSession('text-compare', 'id-test')
    expect(session.id).toBeTypeOf('string')
    expect(session.id).toBe(session.id.trim())
    expect(session.id.length).toBeGreaterThan(0)
  })

  it('generates 100 unique ids without collision', () => {
    requireModule()
    const ids = new Set(
      Array.from({ length: 100 }, () => createSession('text-compare', 'bulk').id)
    )
    expect(ids.size).toBe(100)
  })
})
