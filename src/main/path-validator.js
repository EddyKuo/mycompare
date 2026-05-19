/**
 * @file path-validator.js
 * @description Whitelist-based path validation for IPC handlers.
 *
 *   A renderer can only operate on a filesystem path if a "root" containing
 *   it has been registered (via a user-driven open-file / open-folder dialog
 *   or a CLI argument). This prevents a compromised renderer (XSS through
 *   file content, etc.) from reading or writing arbitrary files such as
 *   ~/.ssh/id_rsa.
 *
 *   The allow-list is process-wide and lives only in memory.
 */

import { resolve, sep, dirname, isAbsolute } from 'path'
import { existsSync, statSync } from 'fs'

/** @type {Set<string>} */
const allowedRoots = new Set()

/**
 * Register a root (file or directory) opened through a trusted code path
 * (dialog or CLI). Subsequent IPC calls that touch a descendant of this
 * root are permitted.
 *
 * If the given path points to a file, the file's containing directory is
 * registered. If it points to a directory, the directory itself is.
 *
 * @param {string} p Absolute path
 */
export function registerRoot(p) {
  if (typeof p !== 'string' || !p) return
  let resolved
  try {
    resolved = resolve(p)
  } catch {
    return
  }
  let dir = resolved
  try {
    if (existsSync(resolved)) {
      const st = statSync(resolved)
      if (!st.isDirectory()) dir = dirname(resolved)
    }
    // If the path doesn't exist (e.g. user typed a save-dialog target),
    // assume it's the leaf and register it directly. Avoid falling back to
    // dirname() — that would register a much larger ancestor (e.g. tmpdir,
    // user home) and silently widen the allow-list.
  } catch {
    /* fall through and register resolved as-is */
  }
  if (dir) {
    allowedRoots.add(_normalize(dir))
  }
}

/**
 * Validate that the given path is within an allowed root. Returns the
 * resolved absolute path on success; throws on failure.
 *
 * @param {unknown} p
 * @returns {string} resolved absolute path
 */
export function validatePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('Invalid path: must be a non-empty string')
  }
  if (p.length > 4096) {
    throw new Error('Invalid path: too long')
  }
  // Reject NUL byte (charCode 0) — used in some path-traversal attacks
  for (let i = 0; i < p.length; i++) {
    if (p.charCodeAt(i) === 0) {
      throw new Error('Invalid path: contains NUL byte')
    }
  }
  // Reject UNC and file:// schemes
  if (p.startsWith('\\\\') || /^file:\/\//i.test(p)) {
    throw new Error('Invalid path: UNC and file:// paths are not allowed')
  }
  // Reject zip-virtual paths from being passed to fs handlers (they contain "::")
  // Caller code that legitimately uses zip paths handles them separately.
  if (p.includes('::')) {
    throw new Error('Invalid path: zip-virtual paths cannot be passed to fs IPC')
  }
  if (!isAbsolute(p)) {
    throw new Error('Invalid path: must be absolute')
  }

  let resolved
  try {
    resolved = resolve(p)
  } catch {
    throw new Error('Invalid path: cannot resolve')
  }

  const normalized = _normalize(resolved)
  for (const root of allowedRoots) {
    if (_containsPath(root, normalized)) {
      return resolved
    }
  }
  throw new Error(`Access denied: ${resolved} is not within any opened root`)
}

/**
 * Validate a src/dest pair for copy/rename. Both must be within an allowed
 * root; otherwise an attacker controlling the renderer could copy a file
 * out of a sandbox.
 *
 * @param {unknown} src
 * @param {unknown} dest
 * @returns {{ src: string, dest: string }}
 */
export function validatePathPair(src, dest) {
  return { src: validatePath(src), dest: validatePath(dest) }
}

/** Test-only helpers. */
export function _clearAllowedRoots() { allowedRoots.clear() }
export function _getAllowedRoots() { return [...allowedRoots] }

function _normalize(p) {
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(p)) {
    return p.charAt(0).toUpperCase() + p.slice(1)
  }
  return p
}

/**
 * Check whether `child` is `parent` itself or a descendant of `parent`.
 * Case-insensitive on Windows.
 */
function _containsPath(parent, child) {
  const a = process.platform === 'win32' ? parent.toLowerCase() : parent
  const b = process.platform === 'win32' ? child.toLowerCase()  : child
  if (a === b) return true
  return b.startsWith(a + sep)
}
