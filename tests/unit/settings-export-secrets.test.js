/**
 * @vitest-environment jsdom
 *
 * An exported settings bundle must not carry credentials.
 *
 * Written independently of the export implementation's own tests, because the
 * failure here is silent and permanent: a bundle is a file people attach to
 * tickets and copy between machines. A password that leaks into one is
 * disclosed to everyone who ever sees the file, and nothing in the app will
 * ever tell them.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { exportSettingsJSON, scrubSecrets } from '../../src/renderer/src/core/settings-store.js'

/** Values that must never survive into an export, whatever key holds them. */
const SECRETS = [
  'hunter2',
  's3cr3t-access-key',
  'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA',  // a DPAPI-looking blob
]

describe('scrubSecrets', () => {
  it('removes credential-shaped keys at any depth', () => {
    const input = {
      password: SECRETS[0],
      nested: { deeper: { secretAccessKey: SECRETS[1], keep: 'visible' } },
      list: [{ token: 'abc' }, { passphrase: 'def' }],
    }
    const out = JSON.stringify(scrubSecrets(input))
    for (const s of [...SECRETS, 'abc', 'def']) expect(out).not.toContain(s)
    expect(out).toContain('visible')
  })

  it('does not mutate what it was given', () => {
    const input = { password: SECRETS[0] }
    scrubSecrets(input)
    expect(input.password).toBe(SECRETS[0])
  })

  it('survives cycles rather than hanging', () => {
    // A settings blob is user-editable JSON; a cycle cannot arise from parsing
    // one, but it can from an in-memory object handed in by mistake.
    const a = { name: 'a' }
    a.self = a
    expect(() => scrubSecrets(a)).not.toThrow()
  })
})

describe('exported bundle', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('carries no credential from anything it does export', () => {
    // Seed every exported section with something credential-shaped, then
    // assert none of it appears — including a sealed-looking blob, since
    // exporting ciphertext is still exporting the secret.
    localStorage.setItem('mycompare:settings', JSON.stringify({
      prefs: { backupFolder: 'D:/b' },
      shortcuts: {},
      remotePassword: SECRETS[0],
    }))
    localStorage.setItem('mycompare:namedConfigs', JSON.stringify([
      { name: 'x', view: 'text', settings: { token: SECRETS[1] } },
    ]))
    localStorage.setItem('mycompare:sessions', JSON.stringify([
      { id: '1', name: 's', options: { encryptedSecret: SECRETS[2] } },
    ]))

    const json = exportSettingsJSON()
    for (const s of SECRETS) expect(json).not.toContain(s)
    // The non-secret content it was supposed to export is still there.
    expect(json).toContain('D:/b')
  })

  it('does not include the remote profile store at all', () => {
    // Profiles live in main with OS-sealed passwords; pulling them into a
    // renderer-side export would move them somewhere with no such protection.
    expect(exportSettingsJSON()).not.toContain('remote-profiles')
  })

  it('is valid JSON with a version, so an importer can refuse a future one', () => {
    const parsed = JSON.parse(exportSettingsJSON())
    expect(Number.isInteger(parsed.version)).toBe(true)
    expect(parsed.kind).toBe('mycompare.settings')
  })
})
