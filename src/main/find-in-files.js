/**
 * @file find-in-files.js
 * @description Search a folder tree for text — BC's Find in Files.
 *
 *   This is the one capability that exists nowhere else in Beyond Compare, and
 *   nowhere else in this program either: every other search is scoped to the
 *   file already open.
 *
 *   Three things here are deliberate rather than incidental:
 *
 *   - **The file mask uses the renderer's parser, imported, not a second copy.**
 *     BC's mask syntax is not trivial (`;` alternation, `-` exclusion, char
 *     classes, folder-relative forms) and this project has already been bitten
 *     by a hand-copied list drifting from its source of truth.
 *   - **Decoding goes through the same `decodeBuffer` the editor uses.** A hit
 *     the user cannot find when they open the file is worse than no hit.
 *   - **Every limit is reported, never silently applied.** A truncated result
 *     that looks complete is the failure mode this repo keeps writing down.
 */

import { readdir, readFile, stat, lstat } from 'fs/promises'
import { join, relative, sep } from 'path'
import { decodeBuffer } from './encoding.js'
import { matchesFilter } from '../renderer/src/core/file-mask.js'

/** Files larger than this are skipped; a hit inside a 200 MB blob is noise. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024
/** Stop after this many hits, and say so. */
export const MAX_MATCHES = 5000
/** Stop after visiting this many files, and say so. */
export const MAX_FILES = 50_000
/** How much of a matching line to carry back for display. */
const LINE_CHARS = 400

/**
 * Build the matcher for one search.
 *
 * @param {{ query: string, regex?: boolean, caseSensitive?: boolean, wholeWord?: boolean }} opts
 * @returns {RegExp}
 * @throws {Error} when a user-supplied regular expression will not compile
 */
export function buildSearchRegex(opts) {
  const query = String(opts?.query ?? '')
  if (!query) throw new Error('搜尋字串不可為空')

  let source = opts?.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (opts?.wholeWord) source = `\\b(?:${source})\\b`

  try {
    return new RegExp(source, opts?.caseSensitive ? 'g' : 'gi')
  } catch (err) {
    throw new Error(`搜尋樣式無法解讀：${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Is this buffer text?
 *
 * A NUL in the first few KB is the same test the rest of the program uses to
 * decide something is binary. Searching a binary file produces hits nobody can
 * act on, and decoding it wastes the budget.
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function looksBinary(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/**
 * Find every match of `query` under `root`.
 *
 * @param {object} opts
 * @param {string} opts.root                already-validated absolute folder
 * @param {string} opts.query
 * @param {boolean} [opts.regex]
 * @param {boolean} [opts.caseSensitive]
 * @param {boolean} [opts.wholeWord]
 * @param {string} [opts.mask]              BC file-mask syntax; '' means all
 * @param {boolean} [opts.recursive]        default true
 * @param {number} [opts.maxMatches]
 * @param {number} [opts.maxFiles]
 * @param {number} [opts.maxFileBytes]
 * @returns {Promise<{matches: Array<object>, filesScanned: number, filesSkipped: number, truncated: null|'matches'|'files'}>}
 */
export async function findInFiles(opts) {
  const root = String(opts?.root ?? '')
  if (!root) throw new Error('搜尋資料夾不可為空')

  const re = buildSearchRegex(opts)
  const mask = String(opts?.mask ?? '').trim()
  const recursive = opts?.recursive !== false
  const maxMatches = opts?.maxMatches ?? MAX_MATCHES
  const maxFiles = opts?.maxFiles ?? MAX_FILES
  const maxFileBytes = opts?.maxFileBytes ?? MAX_FILE_BYTES

  /** @type {Array<object>} */
  const matches = []
  let filesScanned = 0
  let filesSkipped = 0
  /** @type {null|'matches'|'files'} */
  let truncated = null

  /**
   * @param {string} dir
   * @returns {Promise<void>}
   */
  async function walk(dir) {
    if (truncated) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: skip rather than abort the whole search
    }

    for (const entry of entries) {
      if (truncated) return
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (!recursive) continue
        // A directory symlink can point anywhere, including back into itself.
        // Following one would leave the folder the caller authorised, and can
        // loop forever.
        try {
          if ((await lstat(full)).isSymbolicLink()) continue
        } catch { continue }
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (mask && !matchesFilter(entry.name, mask)) continue

      if (filesScanned >= maxFiles) { truncated = 'files'; return }

      let size = 0
      try {
        size = (await stat(full)).size
      } catch { continue }
      if (size > maxFileBytes) { filesSkipped++; continue }

      let buf
      try {
        buf = await readFile(full)
      } catch { continue }
      if (looksBinary(buf)) { filesSkipped++; continue }

      filesScanned++
      // The same decode the editor performs, so a hit reported here is a hit
      // the user will see when the file opens.
      const { content } = decodeBuffer(buf)
      const relPath = relative(root, full) || entry.name

      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(lines[i])) !== null) {
          matches.push({
            path: full,
            relPath: relPath.split(sep).join('/'),
            line: i + 1,
            column: m.index + 1,
            length: m[0].length,
            text: lines[i].length > LINE_CHARS
              ? `${lines[i].slice(0, LINE_CHARS)}…`
              : lines[i],
          })
          if (matches.length >= maxMatches) { truncated = 'matches'; return }
          // A pattern that can match the empty string would spin here.
          if (m[0].length === 0) re.lastIndex++
        }
      }
    }
  }

  await walk(root)
  return { matches, filesScanned, filesSkipped, truncated }
}
