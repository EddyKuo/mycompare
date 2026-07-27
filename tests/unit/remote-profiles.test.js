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
  OAUTH_KINDS,
  CLIENT_ID_HELP,
  isOAuthKind,
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
  it('supports ftp, ftps, sftp, s3 and the two cloud drives', () => {
    expect([...PROFILE_KINDS].sort())
      .toEqual(['dropbox', 'ftp', 'ftps', 'onedrive', 's3', 'sftp'])
  })

  it('no longer claims the cloud drives are impossible', () => {
    // The OAuth flow is implemented; the client ID was never ours to ship, so
    // it is a profile field. Listing these as unsupported would now be a lie.
    expect(Object.keys(UNSUPPORTED_KINDS)).not.toContain('dropbox')
    expect(Object.keys(UNSUPPORTED_KINDS)).not.toContain('onedrive')
    expect(PROFILE_KINDS).toContain('dropbox')
    expect(PROFILE_KINDS).toContain('onedrive')
  })

  it('keeps the unsupported-kind mechanism honest for whatever comes next', () => {
    // The map is currently empty; the invariant it has to keep is that a kind
    // is never in both lists, and never listed without a reason a user can
    // read. Asserted as an invariant rather than by looping over nothing.
    const entries = Object.entries(UNSUPPORTED_KINDS)
    for (const [kind, reason] of entries) {
      expect(PROFILE_KINDS).not.toContain(kind)
      expect(String(reason).length).toBeGreaterThan(0)
    }
    // Every kind must be classified exactly once, which is the property the
    // loop above cannot check while the map is empty.
    for (const kind of PROFILE_KINDS) {
      expect(Object.prototype.hasOwnProperty.call(UNSUPPORTED_KINDS, kind)).toBe(false)
      expect(validateProfile({ name: 'x', kind }).errors.join(' '))
        .not.toMatch(/not supported/i)
    }
  })

  it('tells the user where to get a client ID for each OAuth kind', () => {
    for (const kind of OAUTH_KINDS) {
      expect(isOAuthKind(kind)).toBe(true)
      // A registration URL is the one thing the message cannot omit.
      expect(CLIENT_ID_HELP[kind]).toMatch(/https:\/\//)
      expect(CLIENT_ID_HELP[kind]).toMatch(/127\.0\.0\.1:53682\/callback/)
    }
    expect(isOAuthKind('ftp')).toBe(false)
  })

  it('defaults the port by kind', () => {
    expect(defaultPort('ftp')).toBe(21)
    expect(defaultPort('ftps')).toBe(21)
    expect(defaultPort('sftp')).toBe(22)
    expect(defaultPort('s3')).toBe(443)
    expect(defaultPort('dropbox')).toBe(443)
    expect(defaultPort('onedrive')).toBe(443)
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

  it('accepts a cloud-drive profile once it has a client ID', () => {
    expect(validateProfile({
      id: 'd1', name: 'My Dropbox', kind: 'dropbox', clientId: 'abc123xyz',
    }).errors).toEqual([])
  })

  it('refuses a cloud-drive profile with no client ID, and says where to get one', () => {
    // Rejecting with the registration instructions is the whole point: the
    // user has a step to do, not a typo to fix.
    const { errors } = validateProfile({ id: 'd1', name: 'My Dropbox', kind: 'dropbox' })
    expect(errors.join(' ')).toMatch(/client ID/i)
    expect(errors.join(' ')).toMatch(/dropbox\.com\/developers/)
  })

  it('refuses a client ID that is not shaped like one', () => {
    // It ends up interpolated into an authorization URL.
    const { errors } = validateProfile({
      id: 'd1', name: 'My Dropbox', kind: 'dropbox', clientId: 'abc&redirect_uri=evil',
    })
    expect(errors.join(' ')).toMatch(/client ID/i)
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
  it('keeps an accepted SSH host key across a save and load', () => {
    // This was dropped by the serialiser, so an accepted key never reached
    // disk and every connection re-asked. That prompt only protects anyone
    // while it is rare — asking every time is how it becomes a reflex.
    //
    // An in-memory store cannot catch this: the value is there until it is
    // written out. The bug survived a test that asserted "the profile
    // remembers the key" for exactly that reason, so this one goes through
    // serialise and parse.
    const line = '[example.test]:22 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5'
    const { json } = serialiseProfiles([{
      id: 'p1', name: 'box', kind: 'sftp', host: 'example.test', port: 22,
      user: 'me', knownHosts: line, saveSecret: false,
    }], fakeCrypto)
    expect(parseProfiles(json, fakeCrypto).profiles[0].knownHosts).toBe(line)
  })

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
