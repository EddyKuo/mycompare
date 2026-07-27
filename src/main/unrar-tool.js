/**
 * @file unrar-tool.js
 * @description Optional delegation to an installed UnRAR binary, for the RAR
 *   compression methods this project does not implement.
 *
 *   **Why delegate rather than decode.** RAR's compression has no public
 *   specification. The only description of it is UnRAR's source, whose licence
 *   forbids using that source to build RAR-compatible software — so writing a
 *   decompressor from it is not a thing to do on a user's behalf. Running the
 *   binary RARLAB publishes for exactly this purpose carries no such restriction: it is
 *   free to use and redistribute for extraction, which is precisely the use
 *   RARLAB publishes it for.
 *
 *   Nothing is bundled and nothing is installed. If the user has WinRAR — or
 *   has put UnRAR on PATH — compressed entries open. If not, the caller keeps
 *   its named refusal, which is honest either way: the app never pretends to
 *   decode a method it cannot.
 *
 *   This is the same shape as the rest of the main process, which already
 *   shells out to `git`, `reg.exe` and PowerShell. Every invocation uses
 *   execFile with an argument array, so no path reaches a shell.
 */

import { execFile, spawnSync } from 'child_process'
import { existsSync } from 'fs'

/** Where WinRAR puts its tools, plus a bare name for a PATH install. */
const CANDIDATES = [
  'C:\\Program Files\\WinRAR\\UnRAR.exe',
  'C:\\Program Files\\WinRAR\\Rar.exe',
  'C:\\Program Files (x86)\\WinRAR\\UnRAR.exe',
  'C:\\Program Files (x86)\\WinRAR\\Rar.exe',
  'unrar',
]

/**
 * Resolved once. A miss is cached too — probing four absent paths on every
 * entry of a large archive is a cost for no information.
 * @type {string|null|undefined}
 */
let cached

/** Forget the cached probe. Tests only. */
export function _resetUnrarProbe() { cached = undefined }

/**
 * The UnRAR executable to use, or null when there is none.
 *
 * @param {string[]} [candidates] override, for tests
 * @returns {string|null}
 */
export function findUnrar(candidates = CANDIDATES) {
  if (cached !== undefined && candidates === CANDIDATES) return cached
  let found = null
  for (const c of candidates) {
    if (c.includes('\\') || c.includes('/')) {
      if (existsSync(c)) { found = c; break }
      continue
    }
    // A bare name is resolved by the OS path search, so existsSync says
    // nothing about it — but assuming it works is worse. Taking it on faith
    // meant canExtractCompressed() was always true, and a machine without
    // UnRAR got "spawn unrar ENOENT" where it should have got the plain
    // explanation that the method needs a decoder this build does not have.
    const probe = spawnSync(c, ['-?'], { windowsHide: true, timeout: 5000 })
    if (!probe.error) { found = c; break }
  }
  if (candidates === CANDIDATES) cached = found
  return found
}

/** Whether compressed entries can be read at all on this machine. */
export function canExtractCompressed() {
  return findUnrar() !== null
}

/**
 * Extract one entry to a buffer by asking UnRAR to print it.
 *
 * `p` writes the file to stdout, `-inul` silences the banner so the stream is
 * the file and nothing else, and `-y` answers the prompts a non-interactive
 * run must never wait on. No password is ever supplied: an encrypted archive
 * is refused by the caller before reaching here, and passing `-p-` keeps UnRAR
 * from stopping to ask for one rather than failing.
 *
 * The `--` separator matters. Without it an entry whose name begins with a
 * dash would be read as a switch.
 *
 * @param {object} args
 * @param {string} args.archivePath already-validated absolute path
 * @param {string} args.entryPath path inside the archive
 * @param {number} args.maxBytes ceiling on the produced bytes
 * @param {number} [args.timeoutMs]
 * @returns {Promise<Buffer>}
 */
export function extractWithUnrar({ archivePath, entryPath, maxBytes, timeoutMs = 120000 }) {
  const exe = findUnrar()
  if (!exe) return Promise.reject(new Error('這台機器上找不到 UnRAR 執行檔'))

  return new Promise((resolve, reject) => {
    execFile(
      exe,
      ['p', '-inul', '-y', '-p-', '--', archivePath, entryPath],
      {
        encoding: 'buffer',
        // The ceiling is enforced here rather than after the fact: letting the
        // whole thing decode first and checking the size afterwards is not a
        // limit, it is a report.
        maxBuffer: Math.max(1, maxBytes),
        windowsHide: true,
        timeout: timeoutMs,
      },
      (err, stdout, stderr) => {
        if (err) {
          const why = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? `輸出超過 ${maxBytes} 位元組的上限`
            : (Buffer.isBuffer(stderr) ? stderr.toString('utf-8').trim() : String(err.message))
          reject(new Error(`UnRAR 解壓「${entryPath}」失敗：${why || err.message}`))
          return
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''))
      },
    )
  })
}
