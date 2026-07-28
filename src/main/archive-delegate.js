/**
 * @file archive-delegate.js
 * @description Optional delegation to an already-installed archiver, for the
 *   compression methods this project does not implement itself.
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
  { path: 'C:\\Program Files\\7-Zip\\7z.exe', kind: '7zip', formats: ['rar', 'cab'] },
  { path: 'C:\\Program Files (x86)\\7-Zip\\7z.exe', kind: '7zip', formats: ['rar', 'cab'] },
  { path: '7z', kind: '7zip', formats: ['rar', 'cab'] },
  { path: 'C:\\Program Files\\WinRAR\\UnRAR.exe', kind: 'unrar', formats: ['rar'] },
  { path: 'C:\\Program Files\\WinRAR\\Rar.exe', kind: 'unrar', formats: ['rar'] },
  { path: 'C:\\Program Files (x86)\\WinRAR\\UnRAR.exe', kind: 'unrar', formats: ['rar'] },
  { path: 'unrar', kind: 'unrar', formats: ['rar'] },
]

/**
 * Resolved once per format. A miss is cached too — probing every absent path
 * on each entry of a large archive is a cost for no information.
 * @type {Record<string, RarTool|null>}
 */
let cached = {}

/** Forget the cached probes. Tests only. */
export function _resetToolProbe() { cached = {} }

/**
 * The archiver to use for a format, or null when there is none.
 *
 * @param {'rar'|'cab'} [format]
 * @param {Array<{path: string, kind: '7zip'|'unrar', formats?: string[]}>} [candidates] for tests
 * @returns {RarTool|null}
 */
export function findTool(format = 'rar', candidates = CANDIDATES) {
  const usable = candidates.filter((c) => !c.formats || c.formats.includes(format))
  // Only the default lookup is cached, and only per format: UnRAR answers for
  // RAR and not for CAB, so one cached answer for both would hand a CAB to a
  // tool that cannot read it.
  if (candidates === CANDIDATES && cached && cached[format] !== undefined) return cached[format]
  let found = null
  for (const c of usable) {
    if (c.path.includes('\\') || c.path.includes('/')) {
      if (existsSync(c.path)) { found = { exe: c.path, kind: c.kind }; break }
      continue
    }
    // A bare name is resolved by the OS path search, so existsSync says
    // nothing about it — but taking it on faith is worse. Assuming it worked
    // meant a machine with no archiver got "spawn 7z ENOENT" where it should
    // have got the plain explanation that the method needs a decoder this
    // build does not have.
    // Generous, because this is a one-off probe whose only failure mode that
    // matters is a false negative: timing out on a loaded machine would report
    // "no archiver installed" and refuse an archive the user can actually
    // open. It only runs when no absolute path matched, and the answer is
    // cached, so the cost is paid at most once per format.
    const probe = spawnSync(c.path, ['--help'], { windowsHide: true, timeout: 30000 })
    if (!probe.error) { found = { exe: c.path, kind: c.kind }; break }
  }
  if (candidates === CANDIDATES) cached[format] = found
  return found
}

/**
 * Whether a method this build cannot decode can be read at all on this machine.
 * @param {'rar'|'cab'} [format]
 */
export function canExtractCompressed(format = 'rar') {
  return findTool(format) !== null
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
export function extractWithTool({
  archivePath, entryPath, maxBytes, format = 'rar', expectedSize, timeoutMs = 120000,
}) {
  const tool = findTool(format)
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
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '')
        // 7-Zip exits 0 with empty output when the named entry is not in the
        // archive, so success alone does not mean the right bytes came back.
        // The caller knows the declared size; checking it here keeps the
        // guarantee with the call rather than leaving each caller to
        // re-implement it, and an entry that really is empty still passes.
        if (typeof expectedSize === 'number' && out.length !== expectedSize) {
          reject(new Error(
            `解壓「${entryPath}」得到 ${out.length} 位元組，但封存檔宣告 ${expectedSize}`))
          return
        }
        resolve(out)
      },
    )
  })
}
