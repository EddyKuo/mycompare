/**
 * Reading a registry key on another computer.
 *
 * The parsing half runs anywhere; the half that actually talks to Windows is
 * marked and skips elsewhere. What it checks is the property the whole feature
 * rests on: **a key read from a machine must compare equal to the same key
 * read from a .reg export.** If the two renderings disagree by so much as a
 * zero-padded hex digit, every value shows as different and the comparison is
 * worse than not having it.
 *
 * That is not hypothetical. Measuring the first implementation (`reg query`)
 * against `reg export` over 466,767 real values found 18,512 disagreements —
 * zero-padded DWORDs, an unnamed REG_NONE, and console code page substitution
 * that turned `©` into `c` before any decoder could see it.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseRegistryTarget, validateMachineName, parseRemoteResult, queryRemoteKey,
} from '../../src/main/registry-query.js'
import {
  decodeRegBuffer, parseRegFile, flattenRegistry,
} from '../../src/main/registry.js'

const onWindows = process.platform === 'win32'

describe('reading a target', () => {
  it('takes a plain local key', () => {
    expect(parseRegistryTarget('HKCU\\Software\\X'))
      .toEqual({ machine: '', keyPath: 'HKCU\\Software\\X' })
  })

  it('accepts the reg: prefix BC writes', () => {
    expect(parseRegistryTarget('reg:\\\\PC1\\HKLM\\SOFTWARE'))
      .toEqual({ machine: 'PC1', keyPath: 'HKLM\\SOFTWARE' })
  })

  it('splits a remote target', () => {
    expect(parseRegistryTarget('\\\\BUILD-01\\HKEY_USERS\\S-1-5-18'))
      .toEqual({ machine: 'BUILD-01', keyPath: 'HKEY_USERS\\S-1-5-18' })
  })

  it('refuses roots Windows will not serve remotely', () => {
    // Not this program's rule — HKCU and HKCR are simply unavailable over the
    // network, and saying so is more useful than an opaque failure later.
    expect(() => parseRegistryTarget('\\\\PC1\\HKCU\\Software')).toThrow(/HKLM/)
  })

  it('refuses a machine name that could carry an argument', () => {
    for (const bad of ['\\\\-y\\HKLM\\X', '\\\\a b\\HKLM\\X', '\\\\a"b\\HKLM\\X', '\\\\a/b\\HKLM\\X']) {
      expect(() => parseRegistryTarget(bad), bad).toThrow()
    }
  })

  it('refuses an empty or malformed target', () => {
    expect(() => parseRegistryTarget('')).toThrow()
    expect(() => parseRegistryTarget('\\\\PC1')).toThrow()
    expect(() => parseRegistryTarget('\\\\PC1\\')).toThrow()
  })

  it('refuses control characters in the key path', () => {
    expect(() => parseRegistryTarget('\\\\PC1\\HKLM\\a\nb')).toThrow()
  })
})

describe('validateMachineName', () => {
  it('accepts hostnames and NetBIOS names', () => {
    for (const ok of ['PC1', 'build-01', 'host.example.com', 'A_B'.replace('_', '-')]) {
      expect(validateMachineName(ok)).toBe(ok)
    }
  })

  it('refuses anything that is not one', () => {
    for (const bad of ['', '   ', '-x', 'a b', 'a\\b', 'a$b', 'x'.repeat(65)]) {
      expect(() => validateMachineName(bad), JSON.stringify(bad)).toThrow()
    }
  })
})

describe('decoding the reply', () => {
  /** @param {object} obj */
  const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64')

  it('reads keys and values', () => {
    const out = parseRemoteResult(encode([
      { p: 'HKEY_LOCAL_MACHINE\\A', v: [{ n: 'x', t: 'REG_SZ', v: 'hello' }] },
    ]))
    expect(out.keys).toHaveLength(1)
    expect(out.keys[0].values[0]).toEqual({ name: 'x', type: 'REG_SZ', value: 'hello' })
  })

  it('survives PowerShell collapsing a single-element array to an object', () => {
    // ConvertTo-Json does this, and it would otherwise turn one key into none.
    const out = parseRemoteResult(encode(
      { p: 'HKEY_USERS\\A', v: { n: 'only', t: 'REG_DWORD', v: '0x00000001 (1)' } },
    ))
    expect(out.keys).toHaveLength(1)
    expect(out.keys[0].values).toHaveLength(1)
    expect(out.keys[0].values[0].name).toBe('only')
  })

  it('handles a key with no values', () => {
    const out = parseRemoteResult(encode([{ p: 'HKEY_USERS\\Empty', v: null }]))
    expect(out.keys[0].values).toEqual([])
  })

  it('returns nothing for an empty reply rather than throwing', () => {
    expect(parseRemoteResult('').keys).toEqual([])
  })

  it('reports unusable output instead of silently returning nothing', () => {
    expect(() => parseRemoteResult(Buffer.from('not json', 'utf-8').toString('base64')))
      .toThrow(/無法解析/)
  })
})

describe.runIf(onWindows)('against this machine, through the remote path', () => {
  // Naming this computer exercises the same code a real remote read takes;
  // only the name differs. Testing the parser against a mock would only prove
  // the mock and the parser share one reading of the format.
  const me = process.env.COMPUTERNAME ?? ''

  /**
   * @param {string} key
   * @returns {ReturnType<typeof flattenRegistry>}
   */
  function viaExport(key) {
    const tmp = join(tmpdir(), `mc-remote-test-${Date.now()}.reg`)
    try {
      execFileSync('reg.exe', ['export', key, tmp, '/y'], { windowsHide: true, stdio: 'ignore' })
      return flattenRegistry(parseRegFile(decodeRegBuffer(readFileSync(tmp))))
    } finally {
      try { unlinkSync(tmp) } catch { /* ignore */ }
    }
  }

  it('renders every value exactly as the .reg export does', async () => {
    // Chosen for type variety: this key holds REG_SZ, REG_DWORD and REG_BINARY,
    // including DWORDs with the top bit set — a plain uint32 cast throws on
    // those, which took the whole read down before it was fixed.
    const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies'
    const fromFile = viaExport(key)
    const fromRemote = flattenRegistry(await queryRemoteKey(me, key))

    const index = (rows) => new Map(rows
      .filter((r) => r.type !== 'KEY')
      .map((r) => [`${r.path.toLowerCase()}|${r.name.toLowerCase()}`, r]))
    const a = index(fromFile)
    const b = index(fromRemote)

    expect(a.size).toBeGreaterThan(0)
    for (const [k, expected] of a) {
      const actual = b.get(k)
      expect(actual, `missing from the remote read: ${k}`).toBeTruthy()
      expect({ k, ...actual }).toEqual({ k, ...expected })
    }
  }, 120_000)

  it('refuses a root Windows does not serve remotely, before running anything', async () => {
    await expect(queryRemoteKey(me, 'HKCU\\Environment')).rejects.toThrow(/HKLM/)
  })
})
