/**
 * @file rar-delegate.js
 * @description Optional delegation to an already-installed archiver, for the
 *   RAR compression methods this project does not implement.
 *
 *   **Why delegate rather than decode.** RAR's compression has no public
 *   specification. The only description of it is UnRAR's source, whose licence
 *   forbids using that source to build RAR-compatible software — so writing a
 *   decompressor from it is a legal decision, not an engineering one, and it
 *   stays undone.
 *
 *   **Why 7-Zip first.** 7-Zip reads both RAR generations and is on far more
 *   machines than WinRAR: someone who has any archiver at all usually has that
 *   one. Preferring UnRAR would have meant asking most users to install a
 *   second tool for something the one they already have can do. UnRAR is kept
 *   as a fallback for the machines that do have it.
 *
 *   Nothing is bundled and nothing is installed. With neither tool present the
 *   caller keeps its named refusal, which stays honest: the app never pretends
 *   to decode a method it cannot.
 *
 *   This is the same shape as the rest of the main process, which already
 *   shells out to `git`, `reg.exe` and PowerShell. Every invocation uses
 *   execFile with an argument array, so no path reaches a shell.
 */

import { execFile, spawnSync } from 'child_process'
import { existsSync } from 'fs'

/**
 * @typedef {Object} RarTool
 * @property {string} exe      command or absolute path
 * @property {'7zip'|'unrar'} kind
 */

/**
 * Candidates in preference order. 7-Zip leads on install base, not on merit —
 * both produce identical bytes.
 * @type {Array<{path: string, kind: '7zip'|'unrar'}>}
 */
const CANDIDATES = [
  { path: 'C:\\Program Files\\7-Zip\\7z.exe', kind: '7zip' },
  { path: 'C:\\Program Files (x86)\\7-Zip\\7z.exe', kind: '7zip' },
  { path: '7z', kind: '7zip' },
  { path: 'C:\\Program Files\\WinRAR\\UnRAR.exe', kind: 'unrar' },
  { path: 'C:\\Program Files\\WinRAR\\Rar.exe', kind: 'unrar' },
  { path: 'C:\\Program Files (x86)\\WinRAR\\UnRAR.exe', kind: 'unrar' },
  { path: 'unrar', kind: 'unrar' },
]

/**
 * Resolved once. A miss is cached too — probing every absent path on each
 * entry of a large archive is a cost for no information.
 * @type {RarTool|null|undefined}
 */
let cached

/** Forget the cached probe. Tests only. */
export function _resetRarToolProbe() { cached = undefined }

/**
 * The archiver to use, or null when there is none.
 *
 * @param {Array<{path: string, kind: '7zip'|'unrar'}>} [candidates] for tests
 * @returns {RarTool|null}
 */
export function findRarTool(candidates = CANDIDATES) {
  if (cached !== undefined && candidates === CANDIDATES) return cached
  let found = null
  for (const c of candidates) {
    if (c.path.includes('\\') || c.path.includes('/')) {
      if (existsSync(c.path)) { found = { exe: c.path, kind: c.kind }; break }
      continue
    }
    // A bare name is resolved by the OS path search, so existsSync says
    // nothing about it — but taking it on faith is worse. Assuming it worked
    // meant a machine with no archiver got "spawn 7z ENOENT" where it should
    // have got the plain explanation that the method needs a decoder this
    // build does not have.
    const probe = spawnSync(c.path, ['--help'], { windowsHide: true, timeout: 5000 })
    if (!probe.error) { found = { exe: c.path, kind: c.kind }; break }
  }
  if (candidates === CANDIDATES) cached = found
  return found
}

/** Whether compressed entries can be read at all on this machine. */
export function canExtractCompressed() {
  return findRarTool() !== null
}

/**
 * The argv for printing one entry to stdout.
 *
 * Both tools send their banner and progress to stderr under these switches, so
 * stdout is the file and nothing else.
 *
 * `--` separates switches from operands: without it an entry whose name starts
 * with a dash is read as a switch. Neither tool is given a password — an
 * encrypted archive is refused before reaching here, and the empty-password
 * switches stop the tool sitting at a prompt a non-interactive run can never
 * answer.
 *
 * @param {RarTool} tool
 * @param {string} archivePath
 * @param {string} entryPath
 * @returns {string[]}
 */
export function buildArgs(tool, archivePath, entryPath) {
  if (tool.kind === '7zip') {
    return ['x', '-so', '-y', '-p', '--', archivePath, entryPath]
  }
  return ['p', '-inul', '-y', '-p-', '--', archivePath, entryPath]
}

/**
 * Extract one entry to a buffer using whichever archiver is installed.
 *
 * @param {object} args
 * @param {string} args.archivePath already-validated absolute path
 * @param {string} args.entryPath path inside the archive
 * @param {number} args.maxBytes ceiling on the produced bytes
 * @param {number} [args.timeoutMs]
 * @returns {Promise<Buffer>}
 */
export function extractWithTool({ archivePath, entryPath, maxBytes, timeoutMs = 120000 }) {
  const tool = findRarTool()
  if (!tool) return Promise.reject(new Error('這台機器上找不到 7-Zip 或 UnRAR'))

  return new Promise((resolve, reject) => {
    execFile(
      tool.exe,
      buildArgs(tool, archivePath, entryPath),
      {
        encoding: 'buffer',
        // A ceiling, enforced as the bytes arrive. Decoding everything first
        // and checking the length afterwards is a report, not a limit.
        maxBuffer: Math.max(1, maxBytes),
        windowsHide: true,
        timeout: timeoutMs,
      },
      (err, stdout, stderr) => {
        if (err) {
          const why = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? `輸出超過 ${maxBytes} 位元組的上限`
            : (Buffer.isBuffer(stderr) ? stderr.toString('utf-8').trim() : String(err.message))
          reject(new Error(`${tool.kind === '7zip' ? '7-Zip' : 'UnRAR'} 解壓「${entryPath}」失敗：`
            + `${why || err.message}`))
          return
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''))
      },
    )
  })
}
