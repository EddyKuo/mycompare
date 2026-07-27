/**
 * Unit tests for src/main/file-owner.js — the pure parsing halves and the
 * batch ceiling.
 *
 * The Windows path spawns PowerShell and the Unix path calls `stat`, so what
 * is exercised here is everything that decides what those answers become: the
 * `/etc/passwd` table parser, the helper's record format, and the promise that
 * an over-long batch is refused explicitly rather than silently dropped.
 */

import { describe, it, expect } from 'vitest'

import {
  MAX_OWNER_BATCH,
  parseIdTable,
  parseWindowsOwnerOutput,
  readOwners,
} from '../../src/main/file-owner.js'

const NUL = '\0'
const SOH = String.fromCharCode(1)

/** @param {string[]} fields */
const rec = (fields) => fields.join(SOH) + NUL

describe('parseIdTable', () => {
  it('maps numeric ids to names', () => {
    const table = parseIdTable([
      'root:x:0:0:root:/root:/bin/bash',
      'eddy:x:1000:1000:Eddy:/home/eddy:/bin/bash',
    ].join('\n'), 2)
    expect(table.get(0)).toBe('root')
    expect(table.get(1000)).toBe('eddy')
  })

  it('reads the gid column when asked for it', () => {
    const table = parseIdTable('wheel:x:10:eddy\nstaff:x:20:', 2)
    expect(table.get(10)).toBe('wheel')
    expect(table.get(20)).toBe('staff')
  })

  it('ignores comments, blanks and short lines', () => {
    const table = parseIdTable('# comment\n\nbroken\nok:x:5:5::/:/bin/sh', 2)
    expect(table.size).toBe(1)
    expect(table.get(5)).toBe('ok')
  })

  it('ignores rows whose id is not a number', () => {
    expect(parseIdTable('bad:x:notanumber:1', 2).size).toBe(0)
  })

  it('keeps the first entry for a duplicated id, as getpwuid would', () => {
    const table = parseIdTable('first:x:7:7\nsecond:x:7:7', 2)
    expect(table.get(7)).toBe('first')
  })

  it('returns an empty table for absent input rather than throwing', () => {
    expect(parseIdTable(null, 2).size).toBe(0)
    expect(parseIdTable(undefined, 2).size).toBe(0)
    expect(parseIdTable('', 2).size).toBe(0)
  })
})

describe('parseWindowsOwnerOutput', () => {
  it('parses owner and group records', () => {
    const out = parseWindowsOwnerOutput(
      rec(['C:\\a.txt', 'HOST\\Eddy', 'HOST\\None', ''])
      + rec(['C:\\b.txt', 'BUILTIN\\Administrators', 'HOST\\None', '']))
    expect(out.get('C:\\a.txt')).toEqual({
      path: 'C:\\a.txt', owner: 'HOST\\Eddy', group: 'HOST\\None', error: '',
    })
    expect(out.get('C:\\b.txt').owner).toBe('BUILTIN\\Administrators')
  })

  it('keeps the per-path error a failed Get-Acl produced', () => {
    const out = parseWindowsOwnerOutput(rec(['C:\\locked', '', '', 'Access is denied.']))
    expect(out.get('C:\\locked')).toEqual({
      path: 'C:\\locked', owner: '', group: '', error: 'Access is denied.',
    })
  })

  it('survives a record truncated mid-stream instead of inventing fields', () => {
    const out = parseWindowsOwnerOutput(
      rec(['C:\\good.txt', 'HOST\\Eddy', 'HOST\\None', ''])
      + 'C:\\truncated')
    expect(out.get('C:\\good.txt').owner).toBe('HOST\\Eddy')
    // No SOH means no fields; a one-field record is not a usable answer.
    expect(out.has('C:\\truncated')).toBe(false)
  })

  it('keeps paths containing spaces and non-ASCII characters intact', () => {
    const out = parseWindowsOwnerOutput(rec(['D:\\我的 資料\\檔案.txt', 'HOST\\使用者', '', '']))
    expect(out.get('D:\\我的 資料\\檔案.txt').owner).toBe('HOST\\使用者')
  })

  it('returns an empty map for absent input', () => {
    expect(parseWindowsOwnerOutput(null).size).toBe(0)
    expect(parseWindowsOwnerOutput('').size).toBe(0)
  })
})

describe('readOwners batching contract', () => {
  it('answers nothing for an empty or non-array request', async () => {
    expect(await readOwners([])).toEqual([])
    expect(await readOwners(null)).toEqual([])
    expect(await readOwners(['', null, undefined])).toEqual([])
  })

  it('refuses the excess of an over-long batch with a stated reason', async () => {
    // Non-existent paths so no OS lookup can succeed; what is under test is
    // that the tail is *reported*, not that the head resolves.
    const paths = Array.from({ length: MAX_OWNER_BATCH + 3 },
      (_, i) => `/definitely/missing/f${i}`)
    const out = await readOwners(paths)
    expect(out).toHaveLength(paths.length)
    expect(out.map((o) => o.path)).toEqual(paths)
    for (const o of out.slice(MAX_OWNER_BATCH)) {
      expect(o.owner).toBe('')
      expect(o.error).toContain(String(MAX_OWNER_BATCH))
    }
  }, 30_000)

  it('reports a per-path reason rather than a blank when a lookup fails', async () => {
    const out = await readOwners(['/definitely/missing/nope.txt'])
    expect(out).toHaveLength(1)
    expect(out[0].owner).toBe('')
    expect(out[0].error).not.toBe('')
  }, 30_000)
})
