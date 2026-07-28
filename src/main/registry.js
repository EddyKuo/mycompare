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
    // Padded to eight digits so this matches what `reg query` reports for the
    // same value. A .reg file writes 0x00001388 and reg query prints 0x1388;
    // comparing a remote key against an exported one would otherwise call
    // every DWORD different — 62 of them on two ordinary keys when measured.
    return { type: 'REG_DWORD', value: `0x${dword[1].toLowerCase().padStart(8, '0')} (${n})` }
  }
  const qword = raw.match(/^hex\(b\):(.*)$/)
  if (qword) {
    return { type: 'REG_QWORD', value: normaliseHex(qword[1]) }
  }
  const hexTyped = raw.match(/^hex\(([0-9a-fA-F]+)\):(.*)$/)
  if (hexTyped) {
    const kind = parseInt(hexTyped[1], 16)
    const type = {
      // 0 is REG_NONE. Leaving it unnamed made it read as REG_TYPE_0 here and
      // REG_NONE from `reg query`, so the same value compared across the two
      // sources looked like a type change — thousands of them on this machine.
      0: 'REG_NONE',
      1: 'REG_SZ', 2: 'REG_EXPAND_SZ', 3: 'REG_BINARY',
      4: 'REG_DWORD', 7: 'REG_MULTI_SZ', 11: 'REG_QWORD',
    }[kind] ?? `REG_TYPE_${kind}`
    const bytes = normaliseHex(hexTyped[2])
    // Text types are stored as UTF-16LE bytes; showing the hex would make a
    // diff unreadable for exactly the values people care about.
    if (type === 'REG_SZ' || type === 'REG_EXPAND_SZ' || type === 'REG_MULTI_SZ') {
      // The decode is not reversible — a REG_MULTI_SZ component containing the
      // separator, or a value without the usual terminator, would not come
      // back as the same bytes. Keep the original token so writing a file the
      // user never edited reproduces it exactly rather than approximately.
      return { type, value: hexToUtf16(bytes, type === 'REG_MULTI_SZ'), raw }
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
    const parsed = parseRegValue(line.slice(eq + 1))
    const entry = { name, type: parsed.type, value: parsed.value }
    if (parsed.raw !== undefined) entry.raw = parsed.raw
    current.values.push(entry)
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
      const row = { path: key.path, name: v.name, type: v.type, value: v.value }
      if (v.raw !== undefined) row.raw = v.raw
      out.push(row)
    }
  }
  out.sort((a, b) =>
    a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
  return out
}

/**
 * Turn a row back into the token that follows '=' in a .reg file.
 *
 * The inverse of `parseRegValue`, and only exact for the types whose display
 * form carries every byte. Where it is not — the hex-encoded text types — the
 * original token is kept on the row and reused verbatim, so a value the user
 * never touched is written back unchanged instead of re-derived. An edited
 * value has no original left to reuse and is encoded from what was typed.
 *
 * @param {{ type: string, value: string, raw?: string }} row
 * @returns {string}
 */
/**
 * Characters a quoted .reg string cannot carry.
 *
 * Newlines and carriage returns end the statement; a NUL terminates the string
 * for anything reading it as C. Values containing them are written as hex
 * instead, the way regedit does.
 */
const NEEDS_HEX = /[\u0000-\u001F\u007F]/

export function formatRegValue(row) {
  const type = row?.type ?? 'UNKNOWN'
  const value = String(row?.value ?? '')
  if (row?.raw !== undefined) return row.raw

  switch (type) {
    case 'REG_SZ':
      // A quoted string can only escape a quote and a backslash. A value
      // holding a newline written that way does not merely read back wrong —
      // it ends the line, so everything after it is parsed as a new statement,
      // and a value containing `"` followed by `[...]` becomes a second key in
      // the file. That file goes to `reg.exe import`, so it would be written
      // to the registry. regedit's own answer is to encode such a value as
      // hex(1), which has no delimiters to escape at all.
      if (NEEDS_HEX.test(value)) return `hex(1):${toCommaHex(utf16Bytes(value, false))}`
      return `"${value.replace(/(["\\])/g, '\\$1')}"`
    case 'DELETED':
      return '-'
    case 'REG_DWORD': {
      // Displayed as "0x2a (42)"; the hex digits are the authoritative part.
      const m = value.match(/^0x([0-9a-fA-F]+)/)
      const n = m ? parseInt(m[1], 16) : Number(value)
      if (!Number.isFinite(n)) throw new Error(`REG_DWORD 的值無法解讀：${value}`)
      return `dword:${(n >>> 0).toString(16).padStart(8, '0')}`
    }
    case 'REG_QWORD':
      return `hex(b):${toCommaHex(value)}`
    case 'REG_BINARY':
      return `hex:${toCommaHex(value)}`
    case 'REG_NONE':
      // Type 0. Needed because a remote read is written to a .reg file before
      // anything compares it, and without this the bytes would be written as
      // a bare token that reads back as something else.
      return `hex(0):${toCommaHex(value)}`
    case 'REG_EXPAND_SZ':
      return `hex(2):${toCommaHex(utf16Bytes(value, false))}`
    case 'REG_MULTI_SZ':
      return `hex(7):${toCommaHex(utf16Bytes(value, true))}`
    default:
      return value
  }
}

/**
 * @param {string} spaced  space-separated bytes, as the display form uses
 * @returns {string} comma-separated lowercase bytes, as .reg uses
 */
function toCommaHex(spaced) {
  return String(spaced ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((b) => b.toLowerCase().padStart(2, '0'))
    .join(',')
}

/**
 * Encode display text as the UTF-16LE bytes a .reg file stores.
 *
 * @param {string} text
 * @param {boolean} multi  REG_MULTI_SZ: ' | ' separates the components
 * @returns {string} space-separated bytes
 */
function utf16Bytes(text, multi) {
  const body = multi
    ? `${String(text).split(' | ').filter(Boolean).join('\0')}\0`
    : String(text)
  const buf = Buffer.from(`${body}\0`, 'utf16le')
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ')
}

/**
 * Build a .reg file from flattened rows.
 *
 * Long tokens are wrapped the way reg.exe wraps them, so the result reads back
 * through this module's own parser — which is what the round-trip test checks.
 *
 * @param {Array<{ path: string, name: string, type: string, value: string, raw?: string }>} rows
 * @param {{ format?: string }} [opts]
 * @returns {string}
 */
export function buildRegFile(rows, opts = {}) {
  const header = opts.format === 'regedit4'
    ? 'REGEDIT4'
    : 'Windows Registry Editor Version 5.00'
  const out = [header, '']

  /** @type {Map<string, typeof rows>} */
  const byKey = new Map()
  for (const row of rows ?? []) {
    if (!byKey.has(row.path)) byKey.set(row.path, [])
    byKey.get(row.path).push(row)
  }

  for (const [path, values] of byKey) {
    out.push(`[${path}]`)
    for (const row of values) {
      if (row.type === 'KEY') continue
      // Unlike a value, a name has no hex form in the .reg grammar — a name
      // holding a newline would end the statement and the rest would parse as
      // its own. There is nothing safe to write, so say so rather than produce
      // a file that means something else.
      if (NEEDS_HEX.test(row.name)) {
        throw new Error(`值名稱含有無法寫入 .reg 的控制字元：${JSON.stringify(row.name)}`)
      }
      const name = row.name === '' ? '@' : `"${row.name.replace(/(["\\])/g, '\\$1')}"`
      out.push(wrapRegLine(`${name}=${formatRegValue(row)}`))
    }
    out.push('')
  }
  return out.join('\r\n')
}

/** Column at which reg.exe wraps a long value. */
const REG_WRAP_COLUMN = 76

/**
 * @param {string} line
 * @returns {string}
 */
function wrapRegLine(line) {
  if (line.length <= REG_WRAP_COLUMN) return line
  const parts = []
  // Walk an index rather than reassigning a shrinking remainder: rebuilding
  // the tail on every wrap is quadratic, which is exactly the defect this
  // module was just fixed for, and a multi-megabyte value wraps ~54,000 times.
  let start = 0
  for (;;) {
    const budget = parts.length === 0 ? REG_WRAP_COLUMN : REG_WRAP_COLUMN - 2
    if (line.length - start <= budget) break
    // Break after a comma so a byte is never split across two lines.
    const cut = line.lastIndexOf(',', start + budget)
    if (cut < start) break
    parts.push(line.slice(start, cut + 1))
    start = cut + 1
  }
  parts.push(line.slice(start))
  return parts.map((p, i) => (i === 0 ? p : `  ${p}`)).join('\\\r\n')
}

/**
 * The path every base-keyed row is rooted at.
 *
 * Both sides have to agree on it or nothing would line up: the point of a base
 * key is to compare `HKLM\A` against `HKLM\B`, and those only match once the
 * differing prefixes are gone. The real key each side came from is reported
 * separately, for display.
 */
export const BASE_ROOT = '(基準機碼)'

/**
 * Restrict rows to one subtree and re-root them at {@link BASE_ROOT}.
 *
 * @param {ReturnType<typeof flattenRegistry>} rows
 * @param {string} base  absolute key path; '' leaves the rows untouched
 * @returns {ReturnType<typeof flattenRegistry>}
 */
export function applyBaseKey(rows, base) {
  const prefix = String(base ?? '').trim()
  if (!prefix) return rows ?? []

  const lower = prefix.toLowerCase()
  const out = []
  for (const row of rows ?? []) {
    const path = String(row.path ?? '')
    const lp = path.toLowerCase()
    // The key itself, or something beneath it. The separator check matters:
    // without it `HKLM\Foo` would also capture `HKLM\FooBar`.
    if (lp !== lower && !lp.startsWith(`${lower}\\`)) continue
    const rest = path.slice(prefix.length)
    out.push({ ...row, path: `${BASE_ROOT}${rest}` })
  }
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
 * How much of one value's display text is sent to the renderer.
 *
 * Registry values get genuinely large — a stock Windows 11 install has one of
 * over four million characters under HKLM\SOFTWARE\Microsoft\Windows NT —
 * and a grid cell can show none of that. Comparison happens on the full text
 * before this is applied, so two values differing only past the cut are still
 * reported as different.
 */
export const MAX_TRANSFER_VALUE_CHARS = 8192

/**
 * Compare two flattened exports and shorten the result for display.
 *
 * @param {ReturnType<typeof flattenRegistry>} left
 * @param {ReturnType<typeof flattenRegistry>} right
 * @param {number} [maxChars]
 * @returns {Array<object>}
 */
export function diffRegistryForDisplay(left, right, maxChars = MAX_TRANSFER_VALUE_CHARS) {
  return diffRegistry(left, right).map((row) => ({
    ...row,
    left: shortenSide(row.left, maxChars),
    right: shortenSide(row.right, maxChars),
  }))
}

/**
 * @param {{ type: string, value: string, raw?: string }|null} side
 * @param {number} maxChars
 * @returns {object|null}
 */
function shortenSide(side, maxChars) {
  if (!side) return null
  const value = String(side.value ?? '')
  if (value.length <= maxChars) return side
  // `raw` is dropped along with the rest: keeping a token that no longer
  // matches the shortened value would let an unedited row be written back from
  // data the renderer never held in full.
  return {
    type: side.type,
    value: value.slice(0, maxChars),
    truncated: true,
    fullLength: value.length,
  }
}

/**
 * Refuse to write back a value the caller only ever held part of.
 *
 * Large values are shortened on their way to the renderer, so writing an
 * untouched one out again would silently replace the real data with its first
 * few kilobytes — the file would be written, nothing would report a problem,
 * and the value would be gone. An edited row is fine: the user replaced the
 * whole value, so there is nothing left to truncate.
 *
 * This is the last line of defence and lives here rather than beside the IPC
 * handlers so it can be tested without starting Electron.
 *
 * @param {Array<{ path?: string, name?: string, truncated?: boolean, edited?: boolean }>} rows
 * @throws {Error} naming the values it refused
 */
export function refuseTruncatedRows(rows) {
  const bad = (rows ?? []).filter((r) => r?.truncated && !r?.edited)
  if (!bad.length) return
  const names = bad.slice(0, 3)
    .map((r) => `${r.path}\\${r.name || '（預設）'}`)
    .join('、')
  throw new Error(
    `有 ${bad.length} 個值因為過大而只載入了開頭，未經編輯不能寫回，`
    + `否則會截短原始資料：${names}${bad.length > 3 ? ' …' : ''}`,
  )
}

/**
 * Apply a .reg file to the live registry.
 *
 * There is no way to write the registry from Node without a native binding, so
 * this goes through reg.exe the same way exporting does. It is destructive and
 * not undoable, so the caller must have confirmed with the user first — this
 * function does not ask.
 *
 * Writing under HKLM needs elevation. Rather than trying to elevate, the
 * failure is reported as reg.exe words it: a silent partial apply would be far
 * worse than a refusal the user can act on.
 *
 * @param {string} filePath  an already-validated path to a .reg file
 * @returns {Promise<{ path: string }>}
 */
export async function importRegFile(filePath) {
  if (process.platform !== 'win32') {
    throw new Error('登錄檔匯入僅適用於 Windows')
  }
  try {
    await execFileAsync('reg.exe', ['import', filePath], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).trim()
    throw new Error(`匯入登錄檔失敗：${detail || '未知錯誤'}`)
  }
  return { path: filePath }
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
