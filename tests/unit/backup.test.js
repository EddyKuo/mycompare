/**
 * Backup naming and behaviour.
 *
 * The scheme that matters most is the numbered one: the point of keeping a
 * backup is defeated if saving twice overwrites the copy of the version the
 * user actually wanted back.
 */
import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'
import {
  BACKUP_NAMING,
  backupPathFor,
  backupFile,
  normaliseBackupOptions,
} from '../../src/main/backup.js'

/** An in-memory stand-in for the fs calls backupFile makes. */
function fakeFs(existing = []) {
  const files = new Set(existing)
  return {
    files,
    stat: vi.fn(async (p) => {
      if (!files.has(p)) throw new Error('ENOENT')
      return { size: 1 }
    }),
    copyFile: vi.fn(async (src, dest) => { files.add(dest) }),
    mkdir: vi.fn(async () => {}),
  }
}

describe('backupPathFor', () => {
  const f = join('C:', 'work', 'report.txt')

  it('names each scheme the way the original does', () => {
    expect(backupPathFor(f, BACKUP_NAMING.suffix)).toBe(join('C:', 'work', 'report.txt.bak'))
    expect(backupPathFor(f, BACKUP_NAMING.replace)).toBe(join('C:', 'work', 'report.bak'))
    expect(backupPathFor(f, BACKUP_NAMING.tilde)).toBe(join('C:', 'work', 'report.txt~'))
    expect(backupPathFor(f, BACKUP_NAMING.numbered, '', 3))
      .toBe(join('C:', 'work', 'report.txt.3'))
  })

  it('does not make an extensionless file its own backup', () => {
    // "replace the extension" has nothing to replace here; returning the
    // original path would have the copy overwrite the file it is preserving.
    const noExt = join('C:', 'work', 'Makefile')
    expect(backupPathFor(noExt, BACKUP_NAMING.replace)).toBe(join('C:', 'work', 'Makefile.bak'))
    expect(backupPathFor(noExt, BACKUP_NAMING.replace)).not.toBe(noExt)
  })

  it('keeps the original filename when a backup folder is given', () => {
    expect(backupPathFor(f, BACKUP_NAMING.suffix, join('D:', 'backups')))
      .toBe(join('D:', 'backups', 'report.txt.bak'))
  })

  it('treats a dotfile as a name, not an extension', () => {
    const dotfile = join('C:', 'work', '.gitignore')
    expect(backupPathFor(dotfile, BACKUP_NAMING.suffix))
      .toBe(join('C:', 'work', '.gitignore.bak'))
  })

  it('falls back to the default scheme for an unknown one', () => {
    expect(backupPathFor(f, /** @type {any} */ ('nonsense')))
      .toBe(join('C:', 'work', 'report.txt.bak'))
  })
})

describe('backupFile', () => {
  const f = join('C:', 'work', 'report.txt')

  it('copies the file aside before it is overwritten', async () => {
    const fs = fakeFs([f])
    const r = await backupFile(f, {}, fs)
    expect(r).toMatchObject({ backedUp: true, path: join('C:', 'work', 'report.txt.bak') })
    expect(fs.copyFile).toHaveBeenCalledOnce()
  })

  it('does nothing for a file that does not exist yet', async () => {
    const fs = fakeFs([])
    const r = await backupFile(f, {}, fs)
    expect(r).toMatchObject({ backedUp: false, reason: 'absent' })
    expect(fs.copyFile).not.toHaveBeenCalled()
  })

  it('keeps every generation under the numbered scheme', async () => {
    // Saving three times must leave three backups. Overwriting .1 each time
    // would keep only the most recent, which is the one the user is least
    // likely to want.
    const fs = fakeFs([f])
    const paths = []
    for (let i = 0; i < 3; i++) {
      const r = await backupFile(f, { naming: BACKUP_NAMING.numbered }, fs)
      paths.push(r.path)
    }
    expect(paths).toEqual([
      join('C:', 'work', 'report.txt.1'),
      join('C:', 'work', 'report.txt.2'),
      join('C:', 'work', 'report.txt.3'),
    ])
  })

  it('overwrites the single backup under the other schemes, as the original does', async () => {
    const fs = fakeFs([f])
    const a = await backupFile(f, { naming: BACKUP_NAMING.suffix }, fs)
    const b = await backupFile(f, { naming: BACKUP_NAMING.suffix }, fs)
    expect(a.path).toBe(b.path)
  })

  it('creates the backup folder when one is configured', async () => {
    const fs = fakeFs([f])
    const folder = join('D:', 'backups')
    const r = await backupFile(f, { folder }, fs)
    expect(fs.mkdir).toHaveBeenCalledWith(folder, { recursive: true })
    expect(r.path).toBe(join(folder, 'report.txt.bak'))
  })

  it('reports a failure instead of swallowing it', async () => {
    // A backup that silently fails is worse than none: the user proceeds
    // believing the previous version was kept.
    const fs = fakeFs([f])
    fs.copyFile = vi.fn(async () => { throw new Error('EACCES: permission denied') })
    const r = await backupFile(f, {}, fs)
    expect(r.backedUp).toBe(false)
    expect(r.reason).toMatch(/EACCES/)
  })

  it('does nothing when backups are turned off', async () => {
    const fs = fakeFs([f])
    const r = await backupFile(f, { enabled: false }, fs)
    expect(r).toMatchObject({ backedUp: false, reason: 'disabled' })
    expect(fs.stat).not.toHaveBeenCalled()
  })
})

describe('normaliseBackupOptions', () => {
  it('accepts the boolean the IPC used to carry', () => {
    expect(normaliseBackupOptions(false)).toEqual({ enabled: false })
    expect(normaliseBackupOptions(true).enabled).toBe(true)
    expect(normaliseBackupOptions(undefined).enabled).toBe(true)
  })

  it('rejects a naming scheme it does not know', () => {
    expect(normaliseBackupOptions({ naming: 'rm -rf' }).naming).toBe(BACKUP_NAMING.suffix)
  })

  it('carries a folder through only when it is a non-empty string', () => {
    expect(normaliseBackupOptions({ folder: 'D:/b' }).folder).toBe('D:/b')
    expect(normaliseBackupOptions({ folder: 123 }).folder).toBe('')
    expect(normaliseBackupOptions({}).folder).toBe('')
  })
})
