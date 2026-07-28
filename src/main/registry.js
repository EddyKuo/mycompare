/**
 * @file registry.js
 * @description Windows registry comparison, via .reg export files.
 *
 *   BC compares live registry keys as a session type. Reading the registry
 *   directly needs a native binding; `reg.exe export` produces the same data in
 *   a documented text format and ships with Windows, so the parser works
 *   against both an exported file the user already has and a live key exported
 *   on demand.
 *
 *   Parsing is separate from exporting so the format can be tested without a
 *   registry — and so it runs on any platform, which is what the test suite
 *   needs.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'

const execFileAsync = promisify(execFile)

/** Roots `reg.exe` accepts, with their short forms. */
export const REGISTRY_ROOTS = Object.freeze({
  HKEY_CLASSES_ROOT: 'HKCR',
  HKEY_CURRENT_USER: 'HKCU',
  HKEY_LOCAL_MACHINE: 'HKLM',
  HKEY_USERS: 'HKU',
  HKEY_CURRENT_CONFIG: 'HKCC',
})

/** Guards against an export of an enormous subtree exhausting memory. */
export const MAX_REG_BYTES = 67_108_864 // 64 MB

/**
 * @typedef {object} RegValue
 * @property {string} name  '' for the key's default value
 * @property {string} type  REG_SZ, REG_DWORD, REG_BINARY, …
 * @property {string} value normalised text form
 */

/**
 * @typedef {object} RegKey
 * @property {string} path
 * @property {RegValue[]} values
 */

/**
 * Decode a .reg file's bytes.
 *
 * `reg export` writes UTF-16LE with a BOM on modern Windows but UTF-8 for
 * the older `REGEDIT4` format, and a file the user supplies could be either.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
export function decodeRegBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le')
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf-8')
  }
  return buf.toString('utf-8')
}

/**
 * Join the physical lines of a .reg file into logical ones.
 *
 * Long binary values are wrapped with a trailing backslash; treating the
 * continuation lines as separate entries would corrupt every such value.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function joinContinuations(text) {
  const out = []
  /** @type {string[]|null} */
  let parts = null

  // Collect the pieces instead of growing one string. The marker only ever
  // sits at the tail, so testing the whole accumulation for it was quadratic:
  // reg.exe wraps binary data at ~80 columns, so the 4 MB value that
  // HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion really does hold arrives
  // as ~54,000 physical lines, and each one rescanned every byte joined so
  // far. This runs in the main process, so the cost was not a slow view — it
  // was the whole application frozen with no way back.
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = parts === null ? raw : raw.trimStart()
    if (parts === null) parts = []
    parts.push(line)

    if (stripTrailingMarker(parts)) continue
    out.push(parts.join(''))
    parts = null
  }

  if (parts !== null) out.push(parts.join(''))
  return out
}

/**
 * Remove a trailing continuation marker — one backslash followed by nothing
 * but whitespace — from the collected pieces, reporting whether there was one.
 *
 * It has to look across pieces, not just the last one. Stripping the marker
 * from a line ending in two backslashes leaves the tail still ending in a
 * backslash, so the next marker can begin several pieces back with only blank
 * lines in between. Pieces the marker consumes are dropped, so the backward
 * walk never covers the same ground twice.
 *
 * That accounts for the walk but not for the repeated `slice` when one piece
 * holds a long run of backslashes unwound a line at a time. Measured, that
 * shape stays linear because V8 slices long strings by reference rather than
 * copying — a property of the runtime, not something argued from the code. It
 * is left alone because no .reg file produces that shape; reg.exe ends a
 * wrapped line with exactly one backslash.
 *
 * @param {string[]} parts  mutated in place
 * @returns {boolean}
 */
function stripTrailingMarker(parts) {
  for (let p = parts.length - 1; p >= 0; p--) {
    const piece = parts[p]
    let i = piece.length - 1
    while (i >= 0 && /\s/.test(piece[i])) i--
    if (i < 0) continue // blank piece: the tail carries on into the one before
    if (piece[i] !== '\\') return false
    parts.length = p + 1
    parts[p] = piece.slice(0, i)
    return true
  }
  return false // nothing but whitespace, which is not a marker
}

/**
 * Turn a raw value token into a type and a readable form.
 *
 * @param {string} token  the text after '='
 * @returns {{ type: string, value: string }}
 */
export function parseRegValue(token) {
  const raw = String(token ?? '').trim()

  if (raw.startsWith('"')) {
    // Quoted string: \\ and \" are the only escapes reg export emits.
    const body = raw.replace(/^"/, '').replace(/"$/, '')
    return { type: 'REG_SZ', value: body.replace(/\\(["\\])/g, '$1') }
  }
  if (raw === '-') return { type: 'DELETED', value: '' }

  const dword = raw.match(/^dword:([0-9a-fA-F]+)$/)
  if (dword) {
    const n = parseInt(dword[1], 16)
    return { type: 'REG_DWORD', value: `0x${dword[1].toLowerCase()} (${n})` }
  }
  const qword = raw.match(/^hex\(b\):(.*)$/)
  if (qword) {
    return { type: 'REG_QWORD', value: normaliseHex(qword[1]) }
  }
  const hexTyped = raw.match(/^hex\(([0-9a-fA-F]+)\):(.*)$/)
  if (hexTyped) {
    const kind = parseInt(hexTyped[1], 16)
    const type = {
      1: 'REG_SZ', 2: 'REG_EXPAND_SZ', 3: 'REG_BINARY',
      4: 'REG_DWORD', 7: 'REG_MULTI_SZ', 11: 'REG_QWORD',
    }[kind] ?? `REG_TYPE_${kind}`
    const bytes = normaliseHex(hexTyped[2])
    // Text types are stored as UTF-16LE bytes; showing the hex would make a
    // diff unreadable for exactly the values people care about.
    if (type === 'REG_SZ' || type === 'REG_EXPAND_SZ' || type === 'REG_MULTI_SZ') {
      return { type, value: hexToUtf16(bytes, type === 'REG_MULTI_SZ') }
    }
    return { type, value: bytes }
  }
  const hex = raw.match(/^hex:(.*)$/)
  if (hex) return { type: 'REG_BINARY', value: normaliseHex(hex[1]) }

  return { type: 'UNKNOWN', value: raw }
}

/**
 * @param {string} s comma-separated hex bytes, possibly with whitespace
 * @returns {string} space-separated uppercase bytes
 */
function normaliseHex(s) {
  return String(s ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => b.toUpperCase().padStart(2, '0'))
    .join(' ')
}

/**
 * @param {string} hexBytes space-separated bytes
 * @param {boolean} multi   REG_MULTI_SZ: NUL-separated list
 * @returns {string}
 */
function hexToUtf16(hexBytes, multi) {
  const bytes = hexBytes.split(' ').filter(Boolean).map((b) => parseInt(b, 16))
  const text = Buffer.from(bytes).toString('utf16le').replace(/\0+$/, '')
  return multi ? text.split('\0').filter(Boolean).join(' | ') : text
}

/**
 * Parse a .reg file into keys and values.
 *
 * @param {string} text
 * @returns {{ format: string, keys: RegKey[] }}
 */
export function parseRegFile(text) {
  const lines = joinContinuations(text)
  /** @type {RegKey[]} */
  const keys = []
  /** @type {RegKey|null} */
  let current = null
  let format = 'unknown'

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith(';')) continue

    if (/^Windows Registry Editor Version/i.test(line)) { format = 'reg5'; continue }
    if (/^REGEDIT4$/i.test(line)) { format = 'regedit4'; continue }

    const keyMatch = line.match(/^\[(-?)(.+)\]$/)
    if (keyMatch) {
      current = { path: keyMatch[2], values: [], deleted: keyMatch[1] === '-' }
      keys.push(current)
      continue
    }

    if (!current) continue
    const eq = findValueSeparator(line)
    if (eq === -1) continue

    const namePart = line.slice(0, eq).trim()
    const name = namePart === '@'
      ? ''
      : namePart.replace(/^"/, '').replace(/"$/, '').replace(/\\(["\\])/g, '$1')
    const { type, value } = parseRegValue(line.slice(eq + 1))
    current.values.push({ name, type, value })
  }

  return { format, keys }
}

/**
 * Find the '=' that separates a value name from its data.
 *
 * A quoted name can itself contain '=', so the first one is not always right.
 *
 * @param {string} line
 * @returns {number}
 */
function findValueSeparator(line) {
  if (line.startsWith('@')) return line.indexOf('=')
  if (!line.startsWith('"')) return line.indexOf('=')
  let i = 1
  while (i < line.length) {
    if (line[i] === '\\') { i += 2; continue }
    if (line[i] === '"') return line.indexOf('=', i)
    i++
  }
  return -1
}

/**
 * Flatten parsed keys into comparable rows.
 *
 * One row per value, keyed by `key\name`, which is what makes a registry diff
 * legible — comparing whole keys would only ever say "this key changed".
 *
 * @param {{ keys: RegKey[] }} parsed
 * @returns {Array<{ path: string, name: string, type: string, value: string }>}
 */
export function flattenRegistry(parsed) {
  const out = []
  for (const key of parsed?.keys ?? []) {
    if (!key.values.length) {
      out.push({ path: key.path, name: '', type: 'KEY', value: '' })
      continue
    }
    for (const v of key.values) {
      out.push({ path: key.path, name: v.name, type: v.type, value: v.value })
    }
  }
  out.sort((a, b) =>
    a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
  return out
}

/**
 * Compare two flattened registry exports.
 *
 * @param {ReturnType<typeof flattenRegistry>} left
 * @param {ReturnType<typeof flattenRegistry>} right
 * @returns {Array<{ path: string, name: string, status: string, left: object|null, right: object|null }>}
 */
export function diffRegistry(left, right) {
  const key = (r) => `${r.path.toLowerCase()}\u0000${r.name.toLowerCase()}`
  const lMap = new Map((left ?? []).map((r) => [key(r), r]))
  const rMap = new Map((right ?? []).map((r) => [key(r), r]))

  const all = [...new Set([...lMap.keys(), ...rMap.keys()])].sort()
  return all.map((k) => {
    const l = lMap.get(k) ?? null
    const r = rMap.get(k) ?? null
    let status
    if (!r) status = 'left-only'
    else if (!l) status = 'right-only'
    else if (l.value === r.value && l.type === r.type) status = 'same'
    else status = 'different'
    return { path: (l ?? r).path, name: (l ?? r).name, status, left: l, right: r }
  })
}

/**
 * Validate a registry key path before handing it to reg.exe.
 *
 * The path reaches a child process, so it must not be able to carry arguments
 * or shell syntax. execFile already avoids a shell, but a leading switch would
 * still be read as one.
 *
 * @param {string} keyPath
 * @returns {string} the normalised path
 * @throws {Error} when the root is unknown or the path looks unsafe
 */
export function validateRegistryPath(keyPath) {
  const p = String(keyPath ?? '').trim()
  if (!p) throw new Error('登錄機碼路徑不可為空')
  if (p.length > 512) throw new Error('登錄機碼路徑過長')
  if (/[\r\n\0"|&<>^]/.test(p)) throw new Error('登錄機碼路徑含有不允許的字元')
  if (p.startsWith('/') || p.startsWith('-')) throw new Error('登錄機碼路徑不可以開關字元開頭')

  const root = p.split('\\')[0].toUpperCase()
  const known = new Set([
    ...Object.keys(REGISTRY_ROOTS),
    ...Object.values(REGISTRY_ROOTS),
  ])
  if (!known.has(root)) throw new Error(`未知的登錄機碼根：${root}`)
  return p
}

/**
 * Export a live registry key to a .reg file.
 *
 * @param {string} keyPath
 * @param {string} outPath
 * @returns {Promise<{ path: string }>}
 */
export async function exportRegistryKey(keyPath, outPath) {
  if (process.platform !== 'win32') {
    throw new Error('登錄檔比對僅適用於 Windows')
  }
  const safeKey = validateRegistryPath(keyPath)
  // execFile, not exec: no shell means the path cannot inject a command.
  await execFileAsync('reg.exe', ['export', safeKey, outPath, '/y'], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  return { path: outPath }
}

/**
 * Read and parse a .reg file.
 *
 * @param {string} filePath
 * @returns {Promise<{ format: string, rows: ReturnType<typeof flattenRegistry> }>}
 */
export async function readRegFile(filePath) {
  const buf = await readFile(filePath)
  if (buf.length > MAX_REG_BYTES) {
    throw new Error(`登錄檔過大（超過 ${Math.round(MAX_REG_BYTES / 1048576)} MB）`)
  }
  const parsed = parseRegFile(decodeRegBuffer(buf))
  return { format: parsed.format, rows: flattenRegistry(parsed) }
}
