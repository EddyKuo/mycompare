/**
 * Remote connection profiles.
 *
 * The part that matters most here is that a password is never written in the
 * clear: when encryption is unavailable the profile must lose the secret, not
 * fall back to plain text.
 */
import { describe, it, expect } from 'vitest'
import {
  PROFILE_KINDS,
  UNSUPPORTED_KINDS,
  NULL_CRYPTO,
  defaultPort,
  normaliseProfilePath,
  validateProfile,
  normaliseProfile,
  redactProfile,
  serialiseProfiles,
  parseProfiles,
} from '../../src/main/remote-profiles.js'

/** A crypto adapter that "encrypts" reversibly, standing in for safeStorage. */
const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf-8'),
  decryptString: (cipher) => Buffer.from(cipher).toString('utf-8').replace(/^enc:/, ''),
}

// saveSecret must be opted into: a password is only persisted when the user
// asked for it, which is why it is not on by default.
const ftpProfile = (over = {}) => ({
  id: 'p1', name: 'Prod FTP', kind: 'ftp',
  host: 'ftp.example.com', user: 'alice', secret: 'hunter2', saveSecret: true,
  ...over,
})

describe('kinds', () => {
  it('supports ftp, ftps, sftp and s3', () => {
    expect([...PROFILE_KINDS].sort()).toEqual(['ftp', 'ftps', 's3', 'sftp'])
  })

  it('names the kinds it cannot do, with a reason', () => {
    // The cloud drives need an OAuth flow and a registered client ID. Saying so
    // beats letting a user create a profile that can never connect.
    for (const [kind, reason] of Object.entries(UNSUPPORTED_KINDS)) {
      expect(PROFILE_KINDS).not.toContain(kind)
      expect(String(reason).length).toBeGreaterThan(0)
    }
    expect(Object.keys(UNSUPPORTED_KINDS)).toContain('dropbox')
  })

  it('defaults the port by kind', () => {
    expect(defaultPort('ftp')).toBe(21)
    expect(defaultPort('ftps')).toBe(21)
    expect(defaultPort('sftp')).toBe(22)
    expect(defaultPort('s3')).toBe(443)
  })
})

describe('normaliseProfilePath', () => {
  it('makes an FTP path absolute with no trailing slash', () => {
    expect(normaliseProfilePath('pub/data/', 'ftp')).toBe('/pub/data')
    expect(normaliseProfilePath('', 'ftp')).toBe('/')
  })

  it('keeps an S3 prefix relative, and keeps its trailing slash', () => {
    // The trailing slash is the folder marker in S3, so dropping it would
    // change which objects the prefix selects.
    expect(normaliseProfilePath('/dir/sub/', 's3')).toBe('dir/sub/')
    expect(normaliseProfilePath('dir/sub', 's3')).toBe('dir/sub')
  })

  it('collapses .. so a profile cannot point somewhere other than it shows', () => {
    expect(normaliseProfilePath('/a/b/../c', 'ftp')).toBe('/a/c')
  })

  it('tolerates junk', () => {
    expect(typeof normaliseProfilePath(undefined, 'ftp')).toBe('string')
    expect(typeof normaliseProfilePath(42, 's3')).toBe('string')
  })
})

describe('validateProfile', () => {
  it('accepts a complete profile', () => {
    expect(validateProfile(ftpProfile()).errors).toEqual([])
  })

  it('requires a host', () => {
    expect(validateProfile(ftpProfile({ host: '' })).errors.join(' ')).toMatch(/host/i)
  })

  it('rejects an unknown kind', () => {
    expect(validateProfile(ftpProfile({ kind: 'gopher' })).errors.length).toBeGreaterThan(0)
  })

  it('rejects a kind that is known but unsupported, by name', () => {
    const { errors } = validateProfile(ftpProfile({ kind: 'dropbox' }))
    expect(errors.join(' ')).toMatch(/dropbox/i)
  })

  it('accepts an sftp profile', () => {
    expect(validateProfile(ftpProfile({ kind: 'sftp', port: 22 })).errors).toEqual([])
  })

  it('requires bucket and region for s3', () => {
    const { errors } = validateProfile({
      id: 'x', name: 'S3', kind: 's3', host: '', bucket: '', region: '',
    })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('rejects a port outside the valid range', () => {
    expect(validateProfile(ftpProfile({ port: 0 })).errors.length).toBeGreaterThan(0)
    expect(validateProfile(ftpProfile({ port: 70000 })).errors.length).toBeGreaterThan(0)
  })

  it('tolerates junk input', () => {
    expect(validateProfile(null).errors.length).toBeGreaterThan(0)
    expect(validateProfile(undefined).errors.length).toBeGreaterThan(0)
  })
})

describe('normaliseProfile', () => {
  it('fills in the default port and normalises the path', () => {
    const p = normaliseProfile(ftpProfile({ path: 'pub/' }))
    expect(p.port).toBe(21)
    expect(p.path).toBe('/pub')
  })

  it('keeps an explicit port', () => {
    expect(normaliseProfile(ftpProfile({ port: 2121 })).port).toBe(2121)
  })

  it('gives a profile an id when it has none', () => {
    const p = normaliseProfile({ name: 'x', kind: 'ftp', host: 'h' })
    expect(typeof p.id).toBe('string')
    expect(p.id.length).toBeGreaterThan(0)
  })
})

describe('redactProfile', () => {
  it('removes the secret and reports only whether one exists', () => {
    const r = redactProfile(ftpProfile())
    expect(r.secret).toBeUndefined()
    expect(r.hasSecret).toBe(true)
    expect(JSON.stringify(r)).not.toContain('hunter2')
  })

  it('reports no secret when there is none', () => {
    expect(redactProfile(ftpProfile({ secret: undefined })).hasSecret).toBe(false)
  })
})

describe('serialise / parse', () => {
  it('round-trips a profile and its secret when encryption is available', () => {
    const { json, warnings } = serialiseProfiles([ftpProfile()], fakeCrypto)
    expect(warnings).toEqual([])
    const { profiles } = parseProfiles(json, fakeCrypto)
    expect(profiles[0].host).toBe('ftp.example.com')
    expect(profiles[0].secret).toBe('hunter2')
  })

  it('never writes the password in the clear', () => {
    const { json } = serialiseProfiles([ftpProfile()], fakeCrypto)
    expect(json).not.toContain('hunter2')
  })

  it('drops the secret rather than storing it unencrypted', () => {
    // Failing closed is the whole point: a profile that has to ask for the
    // password again is a nuisance, one that leaks it is a breach.
    const { json, warnings } = serialiseProfiles([ftpProfile()], NULL_CRYPTO)
    expect(json).not.toContain('hunter2')
    expect(warnings.join(' ')).toMatch(/./)
    const { profiles } = parseProfiles(json, NULL_CRYPTO)
    expect(profiles[0].secret).toBeUndefined()
  })

  it('keeps the rest of the profile when the secret cannot be stored', () => {
    const { json } = serialiseProfiles([ftpProfile()], NULL_CRYPTO)
    const { profiles } = parseProfiles(json, NULL_CRYPTO)
    expect(profiles[0].host).toBe('ftp.example.com')
    expect(profiles[0].user).toBe('alice')
  })

  it('survives a stored secret it can no longer decrypt', () => {
    // Happens when the OS keyring changes or the file moves between machines.
    const { json } = serialiseProfiles([ftpProfile()], fakeCrypto)
    const broken = {
      isEncryptionAvailable: () => true,
      encryptString: fakeCrypto.encryptString,
      decryptString: () => { throw new Error('keyring changed') },
    }
    const { profiles } = parseProfiles(json, broken)
    expect(profiles[0].host).toBe('ftp.example.com')
    expect(profiles[0].secret).toBeUndefined()
  })

  it('returns nothing for corrupt storage rather than throwing', () => {
    expect(parseProfiles('{not json', fakeCrypto).profiles).toEqual([])
    expect(parseProfiles('', fakeCrypto).profiles).toEqual([])
    expect(parseProfiles(null, fakeCrypto).profiles).toEqual([])
  })

  it('discards entries that are not usable profiles', () => {
    const { json } = serialiseProfiles([ftpProfile()], fakeCrypto)
    const doc = JSON.parse(json)
    doc.profiles.push({ nonsense: true }, null, 'string')
    const { profiles } = parseProfiles(JSON.stringify(doc), fakeCrypto)
    expect(profiles).toHaveLength(1)
  })

  it('warns about a document from a newer version but still reads it', () => {
    // Refusing outright would strand a profile list that a newer build wrote;
    // the warning covers the real risk, which is unknown fields being dropped
    // the next time it is saved.
    const { json } = serialiseProfiles([ftpProfile()], fakeCrypto)
    const doc = JSON.parse(json)
    doc.version = 999
    const { profiles, warnings } = parseProfiles(JSON.stringify(doc), fakeCrypto)
    expect(profiles).toHaveLength(1)
    expect(warnings.join(' ')).toMatch(/newer version/i)
  })

  it('does not persist a secret the user did not ask to save', () => {
    const { json } = serialiseProfiles([ftpProfile({ saveSecret: false })], fakeCrypto)
    expect(json).not.toContain('hunter2')
    expect(parseProfiles(json, fakeCrypto).profiles[0].secret).toBeUndefined()
  })
})
