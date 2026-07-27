/**
 * @file backup.js
 * @description Keeping a copy of a file before overwriting or deleting it.
 *
 *   The previous behaviour was one hardcoded scheme, `name.ext.bak`, which
 *   loses the previous backup every time a file is saved twice — the case
 *   where a backup is most likely to be wanted. The naming schemes here match
 *   the ones the original offers, and the numbered scheme is the one that
 *   actually accumulates history.
 *
 *   A backup that silently fails is worse than none, because the user believes
 *   they have one. Failures are reported to the caller, which decides whether
 *   to go ahead with the write.
 */
import { dirname, join, basename, extname } from 'path'

/**
 * @typedef {object} BackupOptions
 * @property {boolean} [enabled]  defaults to true
 * @property {'suffix'|'replace'|'tilde'|'numbered'} [naming]
 * @property {string} [folder]  absolute directory; the original filename is
 *           kept inside it. Must already be an allowed root — the caller
 *           validates, since this module does not know about the allow-list.
 */

/** How a backup file is named, matching the original's options. */
export const BACKUP_NAMING = Object.freeze({
  /** `report.txt` → `report.txt.bak` */
  suffix: 'suffix',
  /** `report.txt` → `report.bak` */
  replace: 'replace',
  /** `report.txt` → `report.txt~` */
  tilde: 'tilde',
  /** `report.txt` → `report.txt.1`, then `.2`, … keeping earlier backups */
  numbered: 'numbered',
})

export const DEFAULT_NAMING = BACKUP_NAMING.suffix

/**
 * Build the backup path for a file under a given scheme.
 *
 * Pure, so the naming rules can be tested without touching a disk.
 *
 * @param {string} filePath
 * @param {'suffix'|'replace'|'tilde'|'numbered'} [naming]
 * @param {string} [folder] directory to place the backup in
 * @param {number} [sequence] which numbered backup this is; 1-based
 * @returns {string}
 */
export function backupPathFor(filePath, naming = DEFAULT_NAMING, folder = '', sequence = 1) {
  const dir = folder || dirname(filePath)
  const name = basename(filePath)
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name

  switch (naming) {
    case BACKUP_NAMING.replace:
      // A file with no extension would otherwise become its own backup path.
      return join(dir, ext ? `${stem}.bak` : `${name}.bak`)
    case BACKUP_NAMING.tilde:
      return join(dir, `${name}~`)
    case BACKUP_NAMING.numbered:
      return join(dir, `${name}.${Math.max(1, Math.floor(sequence))}`)
    case BACKUP_NAMING.suffix:
    default:
      return join(dir, `${name}.bak`)
  }
}

/**
 * Copy a file aside before it is overwritten or removed.
 *
 * @param {string} filePath the file about to change
 * @param {BackupOptions} [options]
 * @param {{ stat: Function, copyFile: Function, mkdir: Function }} fs
 * @returns {Promise<{ backedUp: boolean, path: string|null, reason?: string }>}
 */
export async function backupFile(filePath, options = {}, fs) {
  if (options.enabled === false) return { backedUp: false, path: null, reason: 'disabled' }

  try {
    await fs.stat(filePath)
  } catch {
    // Nothing there yet: a new file has no previous version to preserve, which
    // is a normal outcome rather than a failure.
    return { backedUp: false, path: null, reason: 'absent' }
  }

  const naming = options.naming ?? DEFAULT_NAMING
  let target = backupPathFor(filePath, naming, options.folder)

  if (naming === BACKUP_NAMING.numbered) {
    // Find the first free slot. Overwriting .1 every time would defeat the
    // only scheme whose point is to keep more than one generation.
    for (let n = 1; n <= 999; n++) {
      const candidate = backupPathFor(filePath, naming, options.folder, n)
      try {
        await fs.stat(candidate)
      } catch {
        target = candidate
        break
      }
      if (n === 999) return { backedUp: false, path: null, reason: 'no-free-slot' }
    }
  }

  try {
    if (options.folder) await fs.mkdir(options.folder, { recursive: true })
    await fs.copyFile(filePath, target)
    return { backedUp: true, path: target }
  } catch (err) {
    return {
      backedUp: false,
      path: null,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Normalise whatever the renderer sent into options.
 *
 * The IPC used to carry a plain boolean, and old callers still send one.
 *
 * @param {boolean|BackupOptions|undefined} raw
 * @returns {BackupOptions}
 */
export function normaliseBackupOptions(raw) {
  if (raw === false) return { enabled: false }
  if (raw === true || raw == null) return { enabled: true, naming: DEFAULT_NAMING }
  const naming = Object.values(BACKUP_NAMING).includes(raw.naming)
    ? raw.naming
    : DEFAULT_NAMING
  return {
    enabled: raw.enabled !== false,
    naming,
    folder: typeof raw.folder === 'string' && raw.folder ? raw.folder : '',
  }
}
