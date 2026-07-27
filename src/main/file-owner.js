/**
 * @file file-owner.js
 * @description Owner / group lookup backing BeyondCompare's `column-owner` and
 *   `column-group`.
 *
 *   Node's `Stats` carries `uid`/`gid` on Unix and nothing usable on Windows,
 *   so a name needs work that `fs.stat` will not do. Both platforms are
 *   answered in *batches*:
 *
 *   - Unix: one `stat` per file (cheap, no process spawn) plus `/etc/passwd`
 *     and `/etc/group` parsed once per process and cached. No external command
 *     is run at all.
 *   - Windows: one PowerShell process per batch, reading the paths from stdin
 *     and writing back `path \x01 owner \x01 group` records. One process for
 *     200 files rather than 200 processes is the whole point; the security
 *     descriptor is not reachable from Node without it.
 *
 *   **Path contract**: every path is assumed to have already passed
 *   `validatePath()` in the IPC layer. Paths are never interpolated into a
 *   command string — on Windows they travel over stdin, so no quoting rule of
 *   PowerShell's can turn a filename into script.
 */

import { spawn } from 'child_process'
import { stat, readFile } from 'fs/promises'

/**
 * Paths answered by a single call.
 *
 * On Windows this bounds how long one PowerShell process runs; on Unix it
 * bounds how many `stat` calls one IPC round-trip can queue. The renderer asks
 * only for rows it has actually drawn, so the batch is normally far smaller.
 */
export const MAX_OWNER_BATCH = 200

/** Ceiling on the helper process's stdout, so a hostile path cannot flood it. */
const MAX_HELPER_OUTPUT_BYTES = 4 * 1024 * 1024

/** Wall-clock ceiling for the helper process. */
const HELPER_TIMEOUT_MS = 20_000

/**
 * @typedef {object} OwnerInfo
 * @property {string} path
 * @property {string} owner  '' when unknown
 * @property {string} group  '' when unknown
 * @property {string} error  '' when the lookup succeeded; otherwise why not
 */

// ── Unix name resolution ────────────────────────────────────────────────────

/** @type {Map<number, string>|null} */
let _uidNames = null
/** @type {Map<number, string>|null} */
let _gidNames = null

/**
 * Drop the cached passwd/group tables. Exists so tests are not order-dependent.
 */
export function _resetNameCache() { _uidNames = null; _gidNames = null }

/**
 * Parse a colon-separated `/etc/passwd` or `/etc/group` table.
 *
 * @param {string} text
 * @param {number} idField index of the numeric id column
 * @returns {Map<number, string>}
 */
export function parseIdTable(text, idField) {
  /** @type {Map<number, string>} */
  const out = new Map()
  for (const line of String(text ?? '').split('\n')) {
    if (!line || line.startsWith('#')) continue
    const cols = line.split(':')
    if (cols.length <= idField) continue
    const id = Number.parseInt(cols[idField], 10)
    if (!Number.isFinite(id) || !cols[0]) continue
    // First entry wins: a duplicated id in these files is a misconfiguration,
    // and the earlier line is the one `getpwuid` would return.
    if (!out.has(id)) out.set(id, cols[0])
  }
  return out
}

/**
 * @returns {Promise<{ uids: Map<number, string>, gids: Map<number, string> }>}
 */
async function unixNameTables() {
  if (!_uidNames) {
    // A directory-service-backed system has no useful /etc/passwd; that is not
    // an error, it just means the numeric id is the best answer available.
    _uidNames = await readFile('/etc/passwd', 'utf8')
      .then((t) => parseIdTable(t, 2)).catch(() => new Map())
  }
  if (!_gidNames) {
    _gidNames = await readFile('/etc/group', 'utf8')
      .then((t) => parseIdTable(t, 2)).catch(() => new Map())
  }
  return { uids: _uidNames, gids: _gidNames }
}

/**
 * @param {string[]} paths
 * @returns {Promise<OwnerInfo[]>}
 */
async function readOwnersUnix(paths) {
  const { uids, gids } = await unixNameTables()
  /** @type {OwnerInfo[]} */
  const out = []
  for (const path of paths) {
    try {
      const st = await stat(path)
      out.push({
        path,
        owner: uids.get(st.uid) ?? String(st.uid),
        group: gids.get(st.gid) ?? String(st.gid),
        error: '',
      })
    } catch (err) {
      out.push({
        path, owner: '', group: '',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

// ── Windows name resolution ─────────────────────────────────────────────────

/**
 * The whole PowerShell program, as a constant.
 *
 * Paths arrive on stdin, never in this text, so nothing a filename contains can
 * change what runs. Records are separated by a NUL and fields by SOH; both are
 * written as `[char]0` / `[char]1` rather than as literal control bytes, on
 * both sides of the pipe.
 *
 * `Get-Acl` is wrapped per path: an ACL that cannot be read (a locked system
 * file, a path on a filesystem with no security descriptor) has to leave that
 * one row blank rather than abort the batch.
 */
const WIN_OWNER_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$enc = [Text.UTF8Encoding]::new($false)',
  '$stdin = [IO.StreamReader]::new([Console]::OpenStandardInput(), $enc)',
  '$stdout = [Console]::OpenStandardOutput()',
  '$raw = $stdin.ReadToEnd()',
  'foreach ($p in $raw.Split([char]0)) {',
  '  if ($p.Length -eq 0) { continue }',
  '  $o = ""; $g = ""; $e = ""',
  '  try { $a = Get-Acl -LiteralPath $p; $o = [string]$a.Owner; $g = [string]$a.Group }',
  '  catch { $e = $_.Exception.Message }',
  '  $line = $p + [char]1 + $o + [char]1 + $g + [char]1 + $e + [char]0',
  '  $b = $enc.GetBytes($line)',
  '  $stdout.Write($b, 0, $b.Length)',
  '}',
  '$stdout.Flush()',
].join('\n')

/**
 * Run a child process with stdin input, capturing bounded stdout.
 *
 * @param {string} exe
 * @param {string[]} args
 * @param {string} input
 * @returns {Promise<{ stdout: string, truncated: boolean }>}
 */
function runCapture(exe, args, input) {
  return new Promise((resolveOut, rejectOut) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true })
    } catch (err) {
      rejectOut(err)
      return
    }

    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let truncated = false
    let settled = false

    const timer = setTimeout(() => {
      truncated = true
      child.kill()
    }, HELPER_TIMEOUT_MS)

    const finish = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) rejectOut(err)
      else resolveOut({ stdout: Buffer.concat(chunks).toString('utf8'), truncated })
    }

    child.stdout.on('data', (buf) => {
      if (size >= MAX_HELPER_OUTPUT_BYTES) return
      size += buf.length
      if (size > MAX_HELPER_OUTPUT_BYTES) {
        truncated = true
        child.kill()
        return
      }
      chunks.push(buf)
    })
    // stderr is drained rather than captured: PowerShell writes progress and
    // warning records there, and a full pipe buffer would deadlock the child.
    child.stderr.on('data', () => {})
    child.on('error', finish)
    child.on('close', () => finish(null))

    child.stdin.on('error', () => {
      // EPIPE when the child died early; the close handler reports the real
      // outcome, so this must not become an unhandled error event.
    })
    child.stdin.end(input, 'utf8')
  })
}

/**
 * Parse the helper's `path SOH owner SOH group SOH error NUL` stream.
 *
 * @param {string} text
 * @returns {Map<string, OwnerInfo>}
 */
export function parseWindowsOwnerOutput(text) {
  /** @type {Map<string, OwnerInfo>} */
  const out = new Map()
  for (const rec of String(text ?? '').split('\0')) {
    if (!rec) continue
    const parts = rec.split(String.fromCharCode(1))
    if (parts.length < 2) continue
    const [path, owner = '', group = '', error = ''] = parts
    out.set(path, { path, owner, group, error })
  }
  return out
}

/**
 * @param {string[]} paths
 * @returns {Promise<OwnerInfo[]>}
 */
async function readOwnersWindows(paths) {
  const args = [
    '-NoProfile', '-NonInteractive', '-NoLogo',
    '-ExecutionPolicy', 'Bypass',
    '-Command', WIN_OWNER_SCRIPT,
  ]
  let parsed
  try {
    const { stdout, truncated } = await runCapture(
      'powershell.exe', args, paths.join('\0'))
    parsed = parseWindowsOwnerOutput(stdout)
    if (truncated) {
      // Everything that did come back is still correct; only the tail is
      // missing, and the loop below turns each missing path into a stated
      // reason rather than a blank.
      for (const p of paths) {
        if (!parsed.has(p)) {
          parsed.set(p, { path: p, owner: '', group: '', error: '查詢逾時或輸出過長，已中止。' })
        }
      }
    }
  } catch (err) {
    const code = /** @type {{ code?: string }} */ (err ?? {}).code
    const message = code === 'ENOENT'
      ? '找不到 powershell.exe，無法讀取檔案擁有者。'
      : (err instanceof Error ? err.message : String(err))
    return paths.map((path) => ({ path, owner: '', group: '', error: message }))
  }

  return paths.map((path) => parsed.get(path)
    ?? { path, owner: '', group: '', error: '未取得擁有者資訊。' })
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Read owner and group for a batch of files.
 *
 * @param {string[]} paths already-validated absolute paths; at most
 *   {@link MAX_OWNER_BATCH} are answered and the rest are refused explicitly
 * @returns {Promise<OwnerInfo[]>} one entry per input path, in input order
 */
export async function readOwners(paths) {
  const list = (Array.isArray(paths) ? paths : [])
    .filter((p) => typeof p === 'string' && p.length > 0)
  if (!list.length) return []

  const head = list.slice(0, MAX_OWNER_BATCH)
  const tail = list.slice(MAX_OWNER_BATCH)

  const answered = process.platform === 'win32'
    ? await readOwnersWindows(head)
    : await readOwnersUnix(head)

  // An over-long batch is a caller bug, and silently dropping the excess would
  // show those rows as "unknown owner" with no way to tell why.
  return answered.concat(tail.map((path) => ({
    path, owner: '', group: '',
    error: `單次查詢上限為 ${MAX_OWNER_BATCH} 個檔案，此項未查詢。`,
  })))
}
