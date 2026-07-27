/**
 * @file archive.js
 * @description Read-only archive support (tar / gzip / tar.gz / zip family).
 *
 *   Beyond Compare can browse archives as if they were folders. This module
 *   provides the same for every container format reachable with Node's own
 *   `zlib`, the JSZip dependency already in the project, and the in-tree
 *   bzip2 decoder — no external binary, no new npm package.
 *
 *   Everything an archive contains is attacker-controlled data: entry names,
 *   declared sizes and compression ratios all come from the file. The parsers
 *   below therefore treat the archive as hostile input and enforce hard caps
 *   before allocating, rather than after.
 */

import { readFile } from 'fs/promises'
import { basename } from 'path'
import { gunzipSync } from 'zlib'

import { bunzip2, isBzip2, Bzip2Error } from './bzip2.js'
import { decodeXz, isXz, LzmaError } from './lzma.js'
import { is7z, parse7z, extract7zEntry, SevenZipError } from './sevenzip.js'

/**
 * @typedef {Object} ArchiveEntry
 * @property {string} path      entry path — relative from the parsers,
 *                              `archivePath::relative` from {@link readArchive}
 * @property {number} size      uncompressed size in bytes
 * @property {string} mtime     ISO 8601 timestamp
 * @property {boolean} isDirectory
 */

/**
 * @typedef {Object} ArchiveListing
 * @property {string} archivePath
 * @property {ArchiveFormat} format
 * @property {ArchiveEntry[]} entries
 */

/**
 * @typedef {'tar'|'gzip'|'tar.gz'|'zip'|'bzip2'|'tar.bz2'|'xz'|'tar.xz'|'7z'} ArchiveFormat
 */

/**
 * @typedef {Object} ArchiveLimits
 * @property {number} maxEntries
 * @property {number} maxTotalBytes  total uncompressed size across all entries
 * @property {number} maxEntryBytes  uncompressed size of any single entry
 */

/**
 * Caps chosen to stay well inside the memory an Electron renderer can hold
 * while still covering realistic source trees. A 42.zip-style bomb declares
 * far more than this in its very first nesting level, so it is rejected before
 * a single byte is inflated.
 *
 * @type {ArchiveLimits}
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 20000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
})

/** Error thrown for every archive problem, so callers can branch on one type. */
export class ArchiveError extends Error {
  /**
   * @param {string} message
   * @param {'unsupported'|'corrupt'|'limit'|'traversal'|'notfound'} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
  }
}

const TAR_BLOCK = 512

/** Regular file ('0' / legacy NUL), directory ('5'), contiguous file ('7'). */
const CONTENT_TYPEFLAGS = new Set(['0', '\0', '5', '7'])

/**
 * Reject entry names that could escape the extraction root.
 *
 * The classic archive vulnerability (Zip Slip) is an entry called
 * `../../etc/passwd` or `C:\Windows\x`: a naive extractor joins it onto the
 * target directory and writes outside. Rejecting at parse time means no code
 * downstream — including future extract-to-disk features — can be tricked,
 * and it also keeps the `archivePath::relative` virtual paths unambiguous.
 *
 * Backslashes are refused rather than translated: tar treats `\` as an
 * ordinary filename character, so an entry named `a\..\..\b` is a genuine
 * single file on Unix but three levels of traversal once Windows sees it.
 *
 * @param {string} name raw name as stored in the archive
 * @returns {string} the name normalised to forward slashes, without a leading
 *                   `./` and without a trailing `/`
 * @throws {ArchiveError} when the name is unsafe
 */
export function sanitizeEntryPath(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ArchiveError('Archive entry has an empty name', 'traversal')
  }
  if (name.includes('\0')) {
    throw new ArchiveError(`Archive entry name contains a NUL byte: ${name}`, 'traversal')
  }
  if (name.includes('\\')) {
    throw new ArchiveError(`Archive entry name contains a backslash: ${name}`, 'traversal')
  }
  // `::` is this app's archive/entry separator; an entry containing it could
  // forge a path pointing into a different archive.
  if (name.includes('::')) {
    throw new ArchiveError(`Archive entry name contains "::": ${name}`, 'traversal')
  }
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new ArchiveError(`Archive entry name is absolute: ${name}`, 'traversal')
  }

  const parts = []
  for (const part of name.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      throw new ArchiveError(`Archive entry name escapes the archive root: ${name}`, 'traversal')
    }
    parts.push(part)
  }
  if (parts.length === 0) {
    throw new ArchiveError(`Archive entry name resolves to nothing: ${name}`, 'traversal')
  }
  return parts.join('/')
}

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} length
 * @returns {string}
 */
function readString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.toString('utf8', 0, end === -1 ? slice.length : end).trim()
}

/**
 * Read a tar numeric field.
 *
 * Fields are NUL/space-padded octal, except for GNU's base-256 extension
 * (high bit of the first byte set) used when a size does not fit in 11 octal
 * digits.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} length
 * @returns {number}
 */
function readNumeric(buf, offset, length) {
  if (buf[offset] & 0x80) {
    let value = buf[offset] & 0x7f
    for (let i = offset + 1; i < offset + length; i++) value = value * 256 + buf[i]
    return value
  }
  const text = readString(buf, offset, length).replace(/[^0-7]/g, '')
  if (text === '') return 0
  return parseInt(text, 8)
}

/**
 * @param {Buffer} block
 * @returns {boolean} true when the 512-byte header's checksum matches
 */
function tarChecksumValid(block) {
  const stored = readNumeric(block, 148, 8)
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < TAR_BLOCK; i++) {
    // The checksum field itself is counted as spaces by definition.
    const byte = i >= 148 && i < 156 ? 0x20 : block[i]
    unsigned += byte
    signed += byte > 127 ? byte - 256 : byte
  }
  return stored === unsigned || stored === signed
}

/**
 * @param {Buffer} block
 * @returns {boolean}
 */
function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false
  return true
}

/**
 * Parse an uncompressed tar stream.
 *
 * @param {Buffer} buf
 * @param {Partial<ArchiveLimits>} [limits]
 * @returns {Array<ArchiveEntry & { offset: number }>} `offset` is the byte
 *          position of the entry's data inside `buf`
 * @throws {ArchiveError}
 */
export function parseTar(buf, limits = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  if (!Buffer.isBuffer(buf) || buf.length < TAR_BLOCK) {
    throw new ArchiveError('Not a valid tar archive: file is too short', 'corrupt')
  }

  /** @type {Array<ArchiveEntry & { offset: number }>} */
  const entries = []
  let total = 0
  let pos = 0
  /** Pending name override from a GNU 'L' or PAX 'x' header. */
  let pendingName = ''

  while (pos + TAR_BLOCK <= buf.length) {
    const header = buf.subarray(pos, pos + TAR_BLOCK)
    if (isZeroBlock(header)) break // end-of-archive marker
    if (!tarChecksumValid(header)) {
      throw new ArchiveError(`Corrupt tar header at offset ${pos}: bad checksum`, 'corrupt')
    }

    const size = readNumeric(header, 124, 12)
    if (!Number.isFinite(size) || size < 0) {
      throw new ArchiveError(`Corrupt tar header at offset ${pos}: bad size`, 'corrupt')
    }
    // Checked before the EOF test below: a bomb's whole point is a header
    // declaring far more than it carries, and "over the limit" is the more
    // useful diagnosis than "truncated".
    if (size > lim.maxEntryBytes) {
      throw new ArchiveError(
        `Archive entry at ${pos} is ${size} bytes, over the ${lim.maxEntryBytes} byte limit`,
        'limit',
      )
    }
    const dataStart = pos + TAR_BLOCK
    const next = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    if (dataStart + size > buf.length) {
      throw new ArchiveError(`Truncated tar archive: entry at ${pos} runs past EOF`, 'corrupt')
    }

    const type = String.fromCharCode(header[156]) || '0'

    if (type === 'L' || type === 'K') {
      // GNU long name / long link: the payload is the real name.
      if (size > 8192) {
        throw new ArchiveError('Corrupt tar archive: implausible long-name record', 'corrupt')
      }
      const text = buf.toString('utf8', dataStart, dataStart + size).replace(/\0+$/, '')
      if (type === 'L') pendingName = text
      pos = next
      continue
    }
    if (type === 'x' || type === 'g') {
      if (size > 65536) {
        throw new ArchiveError('Corrupt tar archive: implausible PAX record', 'corrupt')
      }
      const paxPath = parsePaxPath(buf.toString('utf8', dataStart, dataStart + size))
      if (paxPath) pendingName = paxPath
      pos = next
      continue
    }

    let rawName = pendingName
    pendingName = ''
    if (!rawName) {
      const prefix = readString(header, 345, 155)
      const name = readString(header, 0, 100)
      rawName = prefix ? `${prefix}/${name}` : name
    }

    // Skip metadata-only entry types (hard/sym links, devices, FIFOs, GNU
    // sparse maps): they have no content a diff view could show.
    if (!CONTENT_TYPEFLAGS.has(type)) {
      pos = next
      continue
    }

    const isDirectory = type === '5' || rawName.endsWith('/')
    const path = sanitizeEntryPath(rawName)

    if (!isDirectory) {
      total += size
      if (total > lim.maxTotalBytes) {
        throw new ArchiveError(
          `Archive expands to more than the ${lim.maxTotalBytes} byte limit`,
          'limit',
        )
      }
    }
    entries.push({
      path,
      size: isDirectory ? 0 : size,
      mtime: new Date(readNumeric(header, 136, 12) * 1000).toISOString(),
      isDirectory,
      offset: dataStart,
    })
    if (entries.length > lim.maxEntries) {
      throw new ArchiveError(`Archive holds more than ${lim.maxEntries} entries`, 'limit')
    }
    pos = next
  }

  if (entries.length === 0) {
    throw new ArchiveError('Not a valid tar archive: no entries found', 'corrupt')
  }
  return entries
}

/**
 * @param {string} text PAX extended-header payload ("len key=value\n" records)
 * @returns {string} the `path` override, or '' when absent
 */
function parsePaxPath(text) {
  const match = /(?:^|\n)\d+ path=([^\n]*)/.exec(text)
  return match ? match[1] : ''
}

/**
 * Decompress a gzip member.
 *
 * `maxOutputLength` makes zlib abort mid-inflate, which is the only safe way
 * to handle a bomb: the declared ISIZE trailer is attacker-controlled and a
 * few kilobytes of deflate can expand to gigabytes.
 *
 * @param {Buffer} buf
 * @param {number} [maxBytes]
 * @returns {Buffer}
 * @throws {ArchiveError}
 */
export function gunzip(buf, maxBytes = DEFAULT_LIMITS.maxTotalBytes) {
  if (!isGzip(buf)) {
    throw new ArchiveError('Not a gzip file: bad magic number', 'corrupt')
  }
  try {
    return gunzipSync(buf, { maxOutputLength: maxBytes })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/buffer|length|ERR_BUFFER_TOO_LARGE/i.test(message)) {
      throw new ArchiveError(`Gzip stream expands past the ${maxBytes} byte limit`, 'limit')
    }
    throw new ArchiveError(`Corrupt gzip stream: ${message}`, 'corrupt')
  }
}

/** @param {Buffer} buf @returns {boolean} */
export function isGzip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 3 && buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08
}

export { isBzip2 }

/** @param {Buffer} buf @returns {boolean} */
export function isZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
}

/**
 * Decompress a bzip2 stream.
 *
 * The in-tree decoder already caps its own output, so the cap is simply passed
 * through; its errors are re-thrown as {@link ArchiveError} so callers keep
 * seeing exactly one error type from this module.
 *
 * @param {Buffer} buf
 * @param {number} [maxBytes]
 * @returns {Buffer}
 * @throws {ArchiveError}
 */
export function bunzip(buf, maxBytes = DEFAULT_LIMITS.maxTotalBytes) {
  try {
    return bunzip2(buf, maxBytes)
  } catch (err) {
    if (err instanceof Bzip2Error) {
      const code = err.code === 'limit' ? 'limit' : err.code === 'unsupported' ? 'unsupported' : 'corrupt'
      throw new ArchiveError(err.message, code)
    }
    throw new ArchiveError(`Corrupt bzip2 stream: ${err instanceof Error ? err.message : err}`, 'corrupt')
  }
}

/**
 * Decompress an xz stream, translating decoder failures into archive errors so
 * callers see one error shape regardless of format.
 *
 * @param {Buffer} buf
 * @param {number} [maxBytes]
 * @returns {Buffer}
 */
export function unxz(buf, maxBytes = DEFAULT_LIMITS.maxTotalBytes) {
  try {
    return Buffer.from(decodeXz(buf, { maxBytes }))
  } catch (err) {
    if (err instanceof LzmaError) {
      const code = /大小上限/.test(err.message)
        ? 'limit'
        : /不支援|filter/.test(err.message) ? 'unsupported' : 'corrupt'
      throw new ArchiveError(err.message, code)
    }
    throw new ArchiveError(`Corrupt xz stream: ${err instanceof Error ? err.message : err}`, 'corrupt')
  }
}

/**
 * Run a 7z operation, translating its failures into archive errors so callers
 * see one error shape whatever the format.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function with7zErrors(fn) {
  try {
    return fn()
  } catch (err) {
    if (err instanceof SevenZipError) throw new ArchiveError(err.message, err.code === 'encrypted' ? 'unsupported' : err.code)
    // A 7z folder that blows the ceiling surfaces from the LZMA decoder, so
    // the reason has to be carried across or it reads as corruption.
    if (err instanceof LzmaError) {
      throw new ArchiveError(err.message, /大小上限/.test(err.message) ? 'limit' : 'corrupt')
    }
    throw new ArchiveError(`Corrupt 7z archive: ${err instanceof Error ? err.message : err}`, 'corrupt')
  }
}

/**
 * Identify the container.
 *
 * Content sniffing wins over the extension because an archive's name is the
 * least trustworthy thing about it; the extension only breaks the tie for the
 * solid compressors (a lone `.gz`/`.bz2` versus a `.tar.gz`/`.tar.bz2`), which
 * would otherwise need the decompressed bytes to tell apart.
 *
 * @param {string} filePath
 * @param {Buffer} buf
 * @returns {ArchiveFormat}
 * @throws {ArchiveError} for formats needing an external binary
 */
export function detectFormat(filePath, buf) {
  if (isZip(buf)) return 'zip'
  if (isGzip(buf)) return /\.(tgz|tar\.gz)$/i.test(filePath) ? 'tar.gz' : 'gzip'
  if (isBzip2(buf)) return /\.(tbz|tbz2|tar\.bz2)$/i.test(filePath) ? 'tar.bz2' : 'bzip2'
  if (isXz(buf)) return /\.(txz|tar\.xz)$/i.test(filePath) ? 'tar.xz' : 'xz'
  if (is7z(buf)) return '7z'
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'Rar!') {
    throw new ArchiveError('RAR archives are not supported (no built-in decoder)', 'unsupported')
  }
  // ustar magic sits at 257; older v7 tars have none, so fall back to the
  // header checksum, which is what actually proves it is a tar.
  if (buf.length >= TAR_BLOCK && (readString(buf, 257, 5) === 'ustar' || tarChecksumValid(buf.subarray(0, TAR_BLOCK)))) {
    return 'tar'
  }
  throw new ArchiveError(`Unrecognised archive format: ${basename(filePath)}`, 'unsupported')
}

/**
 * List a zip via JSZip.
 *
 * Sizes come from the central directory, so the whole listing can be checked
 * against the caps without inflating anything — a zip bomb never gets to run.
 *
 * @param {Buffer} buf
 * @param {ArchiveLimits} lim
 * @returns {Promise<ArchiveEntry[]>}
 */
async function listZip(buf, lim) {
  const JSZip = (await import('jszip')).default
  let zip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch (err) {
    throw new ArchiveError(`Corrupt zip archive: ${err instanceof Error ? err.message : err}`, 'corrupt')
  }

  /** @type {ArchiveEntry[]} */
  const entries = []
  let total = 0
  for (const [rawName, file] of Object.entries(zip.files)) {
    const size = file._data?.uncompressedSize ?? 0
    const isDirectory = Boolean(file.dir)
    const path = sanitizeEntryPath(rawName)
    if (!isDirectory) {
      if (size > lim.maxEntryBytes) {
        throw new ArchiveError(
          `Archive entry "${path}" is ${size} bytes, over the ${lim.maxEntryBytes} byte limit`,
          'limit',
        )
      }
      total += size
      if (total > lim.maxTotalBytes) {
        throw new ArchiveError(`Archive expands to more than the ${lim.maxTotalBytes} byte limit`, 'limit')
      }
    }
    entries.push({
      path,
      size: isDirectory ? 0 : size,
      mtime: (file.date instanceof Date ? file.date : new Date(0)).toISOString(),
      isDirectory,
    })
    if (entries.length > lim.maxEntries) {
      throw new ArchiveError(`Archive holds more than ${lim.maxEntries} entries`, 'limit')
    }
  }
  return entries
}

/**
 * A `.gz` that is not a tarball holds exactly one anonymous member; the
 * convention (and what gzip -d does) is to name it after the container minus
 * the extension.
 *
 * @param {string} filePath
 * @returns {string}
 */
function gzipMemberName(filePath) {
  return basename(filePath).replace(/\.(gz|z)$/i, '') || 'content'
}

/**
 * Same convention as {@link gzipMemberName}, for the bzip2 extensions.
 *
 * @param {string} filePath
 * @returns {string}
 */
function bzip2MemberName(filePath) {
  return basename(filePath).replace(/\.(bz2|bz)$/i, '') || 'content'
}

/**
 * The single-member name a solid-compressed container exposes.
 *
 * @param {ArchiveFormat} format
 * @param {string} filePath
 * @returns {string}
 */
function soloMemberName(format, filePath) {
  if (format === 'bzip2') return bzip2MemberName(filePath)
  if (format === 'xz') return basename(filePath).replace(/\.xz$/i, '') || 'content'
  return gzipMemberName(filePath)
}

/**
 * Read an archive and return a uniform listing.
 *
 * @param {string} archivePath absolute, already validated by the caller
 * @param {Partial<ArchiveLimits>} [limits]
 * @returns {Promise<ArchiveListing>}
 * @throws {ArchiveError}
 */
export async function readArchive(archivePath, limits = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  const buf = await readFile(archivePath)
  const format = detectFormat(archivePath, buf)

  /** @type {ArchiveEntry[]} */
  let entries
  if (format === 'zip') {
    entries = await listZip(buf, lim)
  } else if (format === 'tar') {
    entries = parseTar(buf, lim).map(stripOffset)
  } else if (format === 'tar.gz') {
    entries = parseTar(gunzip(buf, lim.maxTotalBytes), lim).map(stripOffset)
  } else if (format === 'tar.bz2') {
    entries = parseTar(bunzip(buf, lim.maxTotalBytes), lim).map(stripOffset)
  } else if (format === 'tar.xz') {
    entries = parseTar(unxz(buf, lim.maxTotalBytes), lim).map(stripOffset)
  } else if (format === '7z') {
    const parsed = with7zErrors(() => parse7z(buf, { maxBytes: lim.maxTotalBytes }))
    let total = 0
    entries = parsed.entries.map((e) => {
      total += e.size
      if (e.size > lim.maxEntryBytes) {
        throw new ArchiveError(`Entry "${e.path}" is over the ${lim.maxEntryBytes} byte limit`, 'limit')
      }
      if (total > lim.maxTotalBytes) {
        throw new ArchiveError(`Archive expands past the ${lim.maxTotalBytes} byte limit`, 'limit')
      }
      return {
        path: sanitizeEntryPath(e.path),
        size: e.size,
        mtime: e.mtime,
        isDirectory: e.isDirectory,
      }
    })
    if (entries.length > lim.maxEntries) {
      throw new ArchiveError(`Archive has more than ${lim.maxEntries} entries`, 'limit')
    }
  } else {
    const cap = Math.min(lim.maxEntryBytes, lim.maxTotalBytes)
    const inflated = format === 'bzip2' ? bunzip(buf, cap)
      : format === 'xz' ? unxz(buf, cap)
        : gunzip(buf, cap)
    entries = [
      {
        path: sanitizeEntryPath(soloMemberName(format, archivePath)),
        size: inflated.length,
        mtime: new Date(0).toISOString(),
        isDirectory: false,
      },
    ]
  }

  return {
    archivePath,
    format,
    entries: entries.map((e) => ({ ...e, path: `${archivePath}::${e.path}` })),
  }
}

/**
 * @param {ArchiveEntry & { offset: number }} e
 * @returns {ArchiveEntry}
 */
function stripOffset({ path, size, mtime, isDirectory }) {
  return { path, size, mtime, isDirectory }
}

/**
 * Read one entry's bytes.
 *
 * @param {string} archivePath absolute, already validated by the caller
 * @param {string} entryPath relative path inside the archive; the
 *        `archivePath::` prefix is accepted and stripped
 * @param {Partial<ArchiveLimits>} [limits]
 * @returns {Promise<Buffer>}
 * @throws {ArchiveError}
 */
export async function readArchiveEntry(archivePath, entryPath, limits = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  const wanted = sanitizeEntryPath(
    entryPath.startsWith(`${archivePath}::`) ? entryPath.slice(archivePath.length + 2) : entryPath,
  )

  const buf = await readFile(archivePath)
  const format = detectFormat(archivePath, buf)

  if (format === 'zip') {
    const JSZip = (await import('jszip')).default
    let zip
    try {
      zip = await JSZip.loadAsync(buf)
    } catch (err) {
      throw new ArchiveError(`Corrupt zip archive: ${err instanceof Error ? err.message : err}`, 'corrupt')
    }
    const file = Object.entries(zip.files).find(
      ([name, f]) => !f.dir && safeName(name) === wanted,
    )?.[1]
    if (!file) throw new ArchiveError(`No such entry: ${wanted}`, 'notfound')
    if ((file._data?.uncompressedSize ?? 0) > lim.maxEntryBytes) {
      throw new ArchiveError(`Entry "${wanted}" is over the ${lim.maxEntryBytes} byte limit`, 'limit')
    }
    return Buffer.from(await file.async('nodebuffer'))
  }

  if (format === '7z') {
    const parsed = with7zErrors(() => parse7z(buf, { maxBytes: lim.maxTotalBytes }))
    const hit = parsed.entries.find((e) =>
      !e.isDirectory && safeName(e.path) === wanted)
    if (!hit) throw new ArchiveError(`No such entry: ${wanted}`, 'notfound')
    if (hit.size > lim.maxEntryBytes) {
      throw new ArchiveError(`Entry "${wanted}" is over the ${lim.maxEntryBytes} byte limit`, 'limit')
    }
    return Buffer.from(with7zErrors(() =>
      extract7zEntry(buf, parsed, hit.path, { maxBytes: lim.maxTotalBytes })))
  }

  if (format === 'gzip' || format === 'bzip2' || format === 'xz') {
    if (wanted !== sanitizeEntryPath(soloMemberName(format, archivePath))) {
      throw new ArchiveError(`No such entry: ${wanted}`, 'notfound')
    }
    if (format === 'bzip2') return bunzip(buf, lim.maxEntryBytes)
    if (format === 'xz') return unxz(buf, lim.maxEntryBytes)
    return gunzip(buf, lim.maxEntryBytes)
  }

  const tar =
    format === 'tar.gz'
      ? gunzip(buf, lim.maxTotalBytes)
      : format === 'tar.bz2'
        ? bunzip(buf, lim.maxTotalBytes)
        : format === 'tar.xz'
          ? unxz(buf, lim.maxTotalBytes)
          : buf
  const entry = parseTar(tar, lim).find((e) => !e.isDirectory && e.path === wanted)
  if (!entry) throw new ArchiveError(`No such entry: ${wanted}`, 'notfound')
  if (entry.size > lim.maxEntryBytes) {
    throw new ArchiveError(`Entry "${wanted}" is over the ${lim.maxEntryBytes} byte limit`, 'limit')
  }
  return tar.subarray(entry.offset, entry.offset + entry.size)
}

/**
 * @param {string} name
 * @returns {string} sanitised name, or '' when the name is unsafe (used where
 *          a bad neighbour entry must not abort a lookup)
 */
function safeName(name) {
  try {
    return sanitizeEntryPath(name)
  } catch {
    return ''
  }
}
