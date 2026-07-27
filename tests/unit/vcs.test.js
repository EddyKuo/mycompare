/**
 * Unit tests for src/main/vcs.js — git status parsing and repo-relative
 * containment.
 *
 * The parser is the part that decides what colour a row is, so it is tested
 * against the byte shape `git status --porcelain=v1 -z` actually emits,
 * including the rename records that carry a second path field.
 */

import { describe, it, expect } from 'vitest'
import { sep, resolve, join } from 'path'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'

import {
  VCS_STATES,
  classifyStatus,
  parsePorcelainZ,
  toRepoRelative,
} from '../../src/main/vcs.js'

/** NUL, never written as a literal byte in source. */
const NUL = '\0'

/**
 * Join porcelain records into the `-z` stream shape (every record, including
 * the last, is NUL-terminated).
 * @param {string[]} records
 * @returns {string}
 */
const z = (records) => records.map((r) => r + NUL).join('')

describe('classifyStatus', () => {
  it('reports every unmerged combination as a conflict', () => {
    for (const [x, y] of [['U', 'U'], ['A', 'A'], ['D', 'D'],
      ['A', 'U'], ['U', 'A'], ['D', 'U'], ['U', 'D']]) {
      expect(classifyStatus(x, y)).toBe('conflict')
    }
  })

  it('distinguishes untracked from ignored', () => {
    expect(classifyStatus('?', '?')).toBe('untracked')
    expect(classifyStatus('!', '!')).toBe('ignored')
  })

  it('reports deletions on either side as deleted', () => {
    expect(classifyStatus('D', ' ')).toBe('deleted')
    expect(classifyStatus(' ', 'D')).toBe('deleted')
  })

  it('prefers the worktree verdict over the index one', () => {
    // Staged and then edited again: calling this "staged" would tell the user
    // the edit in front of them is already recorded.
    expect(classifyStatus('M', 'M')).toBe('modified')
    expect(classifyStatus('A', 'M')).toBe('modified')
  })

  it('reports index-only changes as staged', () => {
    expect(classifyStatus('M', ' ')).toBe('staged')
    expect(classifyStatus('A', ' ')).toBe('staged')
    expect(classifyStatus('R', ' ')).toBe('staged')
  })

  it('reports an empty pair as clean, including for missing arguments', () => {
    expect(classifyStatus(' ', ' ')).toBe('clean')
    expect(classifyStatus('', '')).toBe('clean')
    expect(classifyStatus(undefined, undefined)).toBe('clean')
  })

  it('only ever returns a declared state', () => {
    const letters = [' ', 'M', 'A', 'D', 'R', 'C', 'U', '?', '!', 'T']
    for (const x of letters) {
      for (const y of letters) {
        expect(VCS_STATES).toContain(classifyStatus(x, y))
      }
    }
  })
})

describe('parsePorcelainZ', () => {
  it('returns empty tables for empty or whitespace input', () => {
    for (const bad of ['', null, undefined, NUL]) {
      expect(parsePorcelainZ(bad)).toEqual({ files: {}, dirs: {} })
    }
  })

  it('parses ordinary records', () => {
    const { files, dirs } = parsePorcelainZ(z([
      ' M src/a.js',
      'M  src/b.js',
      '?? src/new.js',
      'UU src/conflict.js',
    ]))
    expect(files).toEqual({
      'src/a.js': 'modified',
      'src/b.js': 'staged',
      'src/new.js': 'untracked',
      'src/conflict.js': 'conflict',
    })
    expect(dirs).toEqual({})
  })

  it('consumes the extra path field a rename record carries', () => {
    // Without the extra-field rule, `old/name.js` would be re-parsed as a
    // status record whose XY pair is the first two characters of a filename.
    const { files } = parsePorcelainZ(z([
      'R  new/name.js', 'old/name.js',
      ' M after.js',
    ]))
    expect(files).toEqual({ 'new/name.js': 'staged', 'after.js': 'modified' })
    expect(files['old/name.js']).toBeUndefined()
  })

  it('handles a copy record the same way', () => {
    const { files } = parsePorcelainZ(z([
      'C  copy.js', 'source.js',
      '?? untracked.js',
    ]))
    expect(files).toEqual({ 'copy.js': 'staged', 'untracked.js': 'untracked' })
  })

  it('separates collapsed directory entries from file entries', () => {
    const { files, dirs } = parsePorcelainZ(z([
      '!! node_modules/',
      '?? scratch/',
      ' M kept.js',
    ]))
    expect(files).toEqual({ 'kept.js': 'modified' })
    expect(dirs).toEqual({ 'node_modules/': 'ignored', 'scratch/': 'untracked' })
  })

  it('keeps non-ASCII paths verbatim, which is why -z is used', () => {
    const { files } = parsePorcelainZ(z([' M 資料夾/檔案.txt']))
    expect(files).toEqual({ '資料夾/檔案.txt': 'modified' })
  })

  it('keeps paths containing spaces intact', () => {
    const { files } = parsePorcelainZ(z(['?? a folder/my file.txt']))
    expect(files).toEqual({ 'a folder/my file.txt': 'untracked' })
  })

  it('skips records too short to carry a path', () => {
    const { files } = parsePorcelainZ(z(['??', ' M', ' M real.js']))
    expect(files).toEqual({ 'real.js': 'modified' })
  })
})

describe('toRepoRelative', () => {
  const root = resolve('/repo')

  it('returns a forward-slashed relative path', () => {
    expect(toRepoRelative(root, resolve('/repo/src/a.js'))).toBe('src/a.js')
  })

  it('tolerates a trailing separator on the root', () => {
    expect(toRepoRelative(root + sep, resolve('/repo/a.js'))).toBe('a.js')
  })

  it('refuses a path outside the repository', () => {
    expect(toRepoRelative(root, resolve('/elsewhere/a.js'))).toBeNull()
    expect(toRepoRelative(root, resolve('/repo/../secret.txt'))).toBeNull()
  })

  it('refuses the root itself, which is not a file git can be pointed at', () => {
    expect(toRepoRelative(root, root)).toBeNull()
  })

  it('refuses a sibling whose name merely starts with the root name', () => {
    expect(toRepoRelative(root, resolve('/repo-backup/a.js'))).toBeNull()
  })

  it('refuses missing input rather than guessing', () => {
    expect(toRepoRelative(root, null)).toBeNull()
    expect(toRepoRelative(root, undefined)).toBeNull()
  })

  it('refuses a path that leaves the repository through a symlink', () => {
    // Built on disk rather than mocked: the whole point is what the filesystem
    // resolves to, and a stubbed fs would only be asked the question this code
    // already believes the answer to. `git status` lists a symlink as an
    // ordinary path, so the name alone looks perfectly contained.
    const base = mkdtempSync(join(tmpdir(), 'vcs-symlink-'))
    try {
      const repo = join(base, 'repo')
      const outside = join(base, 'outside')
      mkdirSync(repo)
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret.txt'), 'x')

      try {
        symlinkSync(outside, join(repo, 'link'), 'junction')
      } catch {
        // Unprivileged Windows cannot always create links; nothing to assert.
        return
      }

      // Lexically this is 'link/secret.txt' — no '..', no absolute path.
      expect(toRepoRelative(repo, join(repo, 'link', 'secret.txt'))).toBeNull()
      // The ordinary case still works, so the check is not simply refusing all.
      writeFileSync(join(repo, 'real.txt'), 'y')
      expect(toRepoRelative(repo, join(repo, 'real.txt'))).toBe('real.txt')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('still answers for a file that does not exist', () => {
    // Reverting a deleted file is ordinary; containment comes from the nearest
    // existing ancestor rather than from the file itself.
    const base = mkdtempSync(join(tmpdir(), 'vcs-missing-'))
    try {
      expect(toRepoRelative(base, join(base, 'gone.txt'))).toBe('gone.txt')
      expect(toRepoRelative(base, join(base, 'sub', 'gone.txt'))).toBe('sub/gone.txt')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
