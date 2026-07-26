/**
 * @file snapshot.js
 * @description Folder snapshots, modelled on Beyond Compare's `.bcss`.
 *
 *   A snapshot records a folder's structure and per-entry metadata so it can
 *   be compared later against the same folder — detecting drift, or checking a
 *   deployment against a known-good state, without keeping a second copy of
 *   the files.
 *
 *   Content is deliberately not stored. That is the whole point of a snapshot
 *   (a copy would be the alternative), and it is also the limitation callers
 *   have to respect: binary and rules-based comparison are impossible against
 *   one, so an optional CRC is recorded to make content drift detectable.
 */

import { readdir, stat, readFile, writeFile } from 'fs/promises'
import { join, basename } from 'path'
import { gzipSync, gunzipSync } from 'zlib'
import { createHash } from 'crypto'

/** Bumped when the on-disk shape changes incompatibly. */
export const SNAPSHOT_VERSION = 1

/** Magic prefix so a wrong file type is rejected with a clear message. */
const MAGIC = 'MCSNAP1'

/**
 * @typedef {object} SnapshotEntry
 * @property {string} path        path relative to the snapshot root, '/'-separated
 * @property {boolean} isDirectory
 * @property {number} size
 * @property {string} mtime       ISO 8601
 * @property {string} [crc]       md5 of the contents, when requested
 */

/**
 * @typedef {object} Snapshot
 * @property {number} version
 * @property {string} root        absolute path the snapshot was taken from
 * @property {string} name
 * @property {string} createdAt   ISO 8601
 * @property {boolean} hasCrc
 * @property {SnapshotEntry[]} entries
 */

/**
 * Walk a folder tree and collect entry metadata.
 *
 * Bounded by `maxEntries` because a snapshot of an unexpectedly huge tree is
 * both slow and useless; the caller is told it was truncated rather than
 * being handed a partial snapshot that looks complete.
 *
 * @param {string} rootPath
 * @param {object} [opts]
 * @param {boolean} [opts.crc]         hash file contents (much slower)
 * @param {number}  [opts.maxEntries]
 * @param {number}  [opts.maxCrcBytes] skip hashing files larger than this
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ entries: SnapshotEntry[], truncated: boolean }>}
 */
export async function collectEntries(rootPath, opts = {}) {
  const {
    crc = false,
    maxEntries = 200_000,
    maxCrcBytes = 33_554_432, // 32 MB
    signal,
  } = opts

  /** @type {SnapshotEntry[]} */
  const entries = []
  let truncated = false

  /** @param {string} dir @param {string} rel */
  async function walk(dir, rel) {
    if (truncated || signal?.aborted) return
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: recorded by its parent, not descended into
    }
    for (const d of dirents) {
      if (signal?.aborted) return
      if (entries.length >= maxEntries) { truncated = true; return }

      const full = join(dir, d.name)
      const relPath = rel ? `${rel}/${d.name}` : d.name
      let s
      try {
        s = await stat(full)
      } catch {
        continue // vanished or permission denied
      }

      /** @type {SnapshotEntry} */
      const entry = {
        path: relPath,
        isDirectory: s.isDirectory(),
        size: s.isDirectory() ? 0 : s.size,
        mtime: s.mtime.toISOString(),
      }

      if (crc && !s.isDirectory() && s.size <= maxCrcBytes) {
        try {
          entry.crc = createHash('md5').update(await readFile(full)).digest('hex')
        } catch {
          // Leave crc absent; a missing hash is honest, a wrong one is not.
        }
      }

      entries.push(entry)
      if (entry.isDirectory) await walk(full, relPath)
    }
  }

  await walk(rootPath, '')
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { entries, truncated }
}

/**
 * Serialise a snapshot to the on-disk representation.
 *
 * Gzipped because the entry list is highly repetitive and a snapshot of a
 * large tree is otherwise many megabytes of JSON.
 *
 * @param {Snapshot} snapshot
 * @returns {Buffer}
 */
export function serializeSnapshot(snapshot) {
  return gzipSync(Buffer.from(MAGIC + JSON.stringify(snapshot), 'utf-8'))
}

/**
 * Parse a snapshot file's contents.
 *
 * @param {Buffer} buffer
 * @returns {Snapshot}
 * @throws {Error} when the file is not a snapshot or is a future version
 */
export function deserializeSnapshot(buffer) {
  let text
  try {
    text = gunzipSync(buffer).toString('utf-8')
  } catch {
    throw new Error('不是有效的快照檔（無法解壓縮）')
  }
  if (!text.startsWith(MAGIC)) {
    throw new Error('不是有效的快照檔（格式標記不符）')
  }
  let parsed
  try {
    parsed = JSON.parse(text.slice(MAGIC.length))
  } catch {
    throw new Error('快照檔內容毀損')
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    throw new Error('快照檔內容毀損')
  }
  if (parsed.version > SNAPSHOT_VERSION) {
    throw new Error(`快照檔版本 ${parsed.version} 較新，此版本無法讀取`)
  }
  return parsed
}

/**
 * Take a snapshot of a folder and write it out.
 *
 * @param {string} rootPath
 * @param {string} outPath
 * @param {object} [opts] forwarded to collectEntries
 * @returns {Promise<{ path: string, count: number, truncated: boolean }>}
 */
export async function writeSnapshot(rootPath, outPath, opts = {}) {
  const { entries, truncated } = await collectEntries(rootPath, opts)
  /** @type {Snapshot} */
  const snapshot = {
    version: SNAPSHOT_VERSION,
    root: rootPath,
    name: basename(rootPath) || rootPath,
    createdAt: (opts.now ?? new Date()).toISOString(),
    hasCrc: !!opts.crc,
    entries,
  }
  await writeFile(outPath, serializeSnapshot(snapshot))
  return { path: outPath, count: entries.length, truncated }
}

/**
 * Read a snapshot from disk.
 * @param {string} snapshotPath
 * @returns {Promise<Snapshot>}
 */
export async function readSnapshot(snapshotPath) {
  return deserializeSnapshot(await readFile(snapshotPath))
}

/**
 * Flatten a snapshot into the entry shape the folder view expects from
 * `read-dir`, for one directory level.
 *
 * The view is built around one level at a time, so a snapshot has to be
 * projected the same way rather than handed over whole.
 *
 * @param {Snapshot} snapshot
 * @param {string} [relDir] '' for the root
 * @returns {Array<{ name: string, path: string, isDirectory: boolean, size: number, mtime: string, crc?: string }>}
 */
export function snapshotLevel(snapshot, relDir = '') {
  const prefix = relDir ? `${relDir}/` : ''
  const out = []
  for (const e of snapshot.entries ?? []) {
    if (!e.path.startsWith(prefix)) continue
    const rest = e.path.slice(prefix.length)
    if (!rest || rest.includes('/')) continue // not an immediate child
    out.push({
      name: rest,
      // Snapshot paths are virtual: they must never reach an fs handler, so
      // they carry a scheme the path validator rejects outright.
      path: `snapshot://${e.path}`,
      isDirectory: e.isDirectory,
      size: e.size,
      mtime: e.mtime,
      ...(e.crc ? { crc: e.crc } : {}),
    })
  }
  return out
}
