/**
 * @file session.js
 * @description Session management module — pure data, no DOM or Electron API
 * dependencies. Handles creation, serialisation, and deserialisation of
 * compare sessions.
 */

// ---------------------------------------------------------------------------
// ID generation (no external packages)
// ---------------------------------------------------------------------------

/**
 * Generate a UUID v4-like identifier.
 * Uses `crypto.randomUUID()` when available (Node ≥ 14.17, modern browsers),
 * otherwise falls back to a Math.random-based implementation.
 *
 * @returns {string}  e.g. "f47ac10b-58cc-4372-a567-0e02b2c3d479"
 */
function generateId() {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  // RFC 4122 §4.4 compatible fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// Options defaults per session type
// ---------------------------------------------------------------------------

/**
 * Return a default options object for the given session type.
 *
 * @param {'text'|'folder'|'hex'|'image'|'table'|'merge3'} type
 * @returns {object}
 */
function defaultOptions(type) {
  switch (type) {
    case 'text':
      return {
        leftPath: '',
        rightPath: '',
        algorithm: 'myers',
        ignoreWhitespace: false,
        ignoreCase: false,
        ignoreLineEndings: false,
      };

    case 'folder':
      return {
        leftPath: '',
        rightPath: '',
        compareBy: 'name-and-content', // 'name-only' | 'name-and-content' | 'checksum'
        showFilters: {
          identical: true,
          different: true,
          leftOnly: true,
          rightOnly: true,
        },
      };

    case 'hex':
      return {
        leftPath: '',
        rightPath: '',
        alignment: 16, // bytes per row
      };

    case 'image':
      return {
        leftPath: '',
        rightPath: '',
        threshold: 0.1, // pixel difference threshold [0, 1]
      };

    case 'table':
      return {
        leftPath: '',
        rightPath: '',
        hasHeader: true,
        keyColumn: 0,
        ignoreColumnOrder: false,
      };

    case 'merge3':
      return {
        leftPath: '',
        basePath: '',
        rightPath: '',
        outputPath: '',
      };

    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** @type {Set<string>} */
const VALID_TYPES = new Set(['text', 'folder', 'hex', 'image', 'table', 'merge3', 'text-compare', 'folder-compare', 'hex-compare', 'merge']);

/**
 * Assert that `value` is a non-empty string, throwing a descriptive error
 * if not.
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Session field "${fieldName}" must be a non-empty string; got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * Validate that the `type` field is one of the recognised session types.
 * @param {unknown} type
 * @returns {'text'|'folder'|'hex'|'image'|'table'|'merge3'}
 */
function requireValidType(type) {
  if (!VALID_TYPES.has(/** @type {string} */ (type))) {
    throw new TypeError(
      `Session type must be one of [${[...VALID_TYPES].join(', ')}]; got ${JSON.stringify(type)}.`
    );
  }
  return /** @type {'text'|'folder'|'hex'|'image'|'table'|'merge3'} */ (type);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   id: string,
 *   type: 'text'|'folder'|'hex'|'image'|'table'|'merge3',
 *   name: string,
 *   createdAt: string,
 *   updatedAt: string,
 *   options: object
 * }} Session
 */

/**
 * Create a new Session object.
 *
 * The provided `options` are shallow-merged on top of the type-specific
 * defaults, so callers only need to supply overrides.
 *
 * @param {'text'|'folder'|'hex'|'image'|'table'|'merge3'} type
 * @param {string} name  Human-readable label for this comparison session
 * @param {object} [options]  Type-specific overrides (see JSDoc typedefs below)
 * @returns {Session}
 *
 * @example
 * const s = createSession('text', 'Compare configs', {
 *   leftPath: '/etc/nginx/nginx.conf',
 *   rightPath: '/tmp/nginx.conf.bak',
 *   ignoreWhitespace: true,
 * });
 *
 * // text options
 * @typedef {{ leftPath?: string, rightPath?: string, algorithm?: 'myers'|'patience', ignoreWhitespace?: boolean, ignoreCase?: boolean, ignoreLineEndings?: boolean }} TextOptions
 *
 * // folder options
 * @typedef {{ leftPath?: string, rightPath?: string, compareBy?: 'name-only'|'name-and-content'|'checksum', showFilters?: object }} FolderOptions
 *
 * // hex options
 * @typedef {{ leftPath?: string, rightPath?: string, alignment?: number }} HexOptions
 *
 * // image options
 * @typedef {{ leftPath?: string, rightPath?: string, threshold?: number }} ImageOptions
 *
 * // table options
 * @typedef {{ leftPath?: string, rightPath?: string, hasHeader?: boolean, keyColumn?: number, ignoreColumnOrder?: boolean }} TableOptions
 *
 * // merge3 options
 * @typedef {{ leftPath?: string, basePath?: string, rightPath?: string, outputPath?: string }} Merge3Options
 */
export function createSession(type, name, options = {}) {
  const validatedType = requireValidType(type);
  const validatedName = requireString(name, 'name');
  const now = new Date().toISOString();

  return {
    id: generateId(),
    type: validatedType,
    name: validatedName,
    createdAt: now,
    updatedAt: now,
    options: { ...defaultOptions(validatedType), ...options },
  };
}

/**
 * Update mutable fields of an existing Session, returning a new Session
 * object (immutable update pattern).
 *
 * Only `name` and `options` may be updated; `id`, `type`, and `createdAt`
 * are never changed.
 *
 * @param {Session} session  The session to update
 * @param {{ name?: string, options?: object }} patch  Fields to change
 * @returns {Session}
 */
export function updateSession(session, patch) {
  if (session === null || typeof session !== 'object' || !session.id) {
    throw new TypeError('updateSession: first argument must be a valid Session object.');
  }
  return {
    ...session,
    name: patch.name !== undefined ? requireString(patch.name, 'name') : session.name,
    options:
      patch.options !== undefined
        ? { ...session.options, ...patch.options }
        : session.options,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Serialise a Session to a JSON string suitable for storage in
 * `localStorage`, `IndexedDB`, or a plain file.
 *
 * @param {Session} session
 * @returns {string}
 * @throws {TypeError} if `session` is not a valid Session object
 */
export function serializeSession(session) {
  if (session === null || typeof session !== 'object' || !session.id) {
    throw new TypeError('serializeSession: argument must be a valid Session object.');
  }
  return JSON.stringify(session);
}

/**
 * Deserialise a Session from a JSON string produced by {@link serializeSession}.
 *
 * Performs structural validation: required fields must be present and have
 * the correct types.  Unknown extra fields are preserved (forward
 * compatibility).
 *
 * @param {string} json
 * @returns {Session}
 * @throws {SyntaxError}  if `json` is not valid JSON
 * @throws {TypeError}    if the parsed object is missing required fields
 */
export function deserializeSession(json) {
  if (typeof json !== 'string') {
    throw new TypeError('deserializeSession: argument must be a string.');
  }

  /** @type {unknown} */
  const parsed = JSON.parse(json); // throws SyntaxError on malformed input

  if (parsed === null || typeof parsed !== 'object') {
    throw new TypeError('deserializeSession: JSON must represent an object.');
  }

  const obj = /** @type {Record<string, unknown>} */ (parsed);

  // Validate required fields
  requireString(obj.id, 'id');
  requireValidType(obj.type);
  requireString(obj.name, 'name');
  requireString(obj.createdAt, 'createdAt');
  requireString(obj.updatedAt, 'updatedAt');

  if (obj.options === null || typeof obj.options !== 'object' || Array.isArray(obj.options)) {
    throw new TypeError('deserializeSession: "options" field must be a plain object.');
  }

  return /** @type {Session} */ (obj);
}

/**
 * Deep-clone a Session (useful before mutating options for preview purposes
 * without dirtying the stored session).
 *
 * @param {Session} session
 * @returns {Session}
 */
export function cloneSession(session) {
  if (session === null || typeof session !== 'object' || !session.id) {
    throw new TypeError('cloneSession: argument must be a valid Session object.');
  }
  return deserializeSession(serializeSession(session));
}
