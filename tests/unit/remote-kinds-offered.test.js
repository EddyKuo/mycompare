/**
 * The profile editor offers every transport the app can actually connect to.
 *
 * It had been left at ftp/ftps/s3 while sftp, dropbox and onedrive were added
 * behind it, so three working transports — one of them interop-tested against
 * a real SSH server — had no way to be created. The code was complete and the
 * feature was unreachable, which is this project's most repeated failure.
 *
 * Comparing the two lists is textual because they live in different processes:
 * PROFILE_KINDS is main, the editor is renderer, and nothing at runtime ever
 * puts them side by side.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { PROFILE_KINDS, UNSUPPORTED_KINDS } from '../../src/main/remote-profiles.js'

const APP = readFileSync(
  fileURLToPath(new URL('../../src/renderer/src/app.js', import.meta.url)), 'utf-8')

/** The kinds the renderer's profile editor lists. */
function offeredKinds() {
  const block = /REMOTE_KINDS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(APP)
  if (!block) return []
  return [...block[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1])
}

/** The kinds the editor treats as OAuth. */
function offeredOAuthKinds() {
  const block = /REMOTE_OAUTH_KINDS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(APP)
  if (!block) return []
  return [...block[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1])
}

describe('remote profile editor', () => {
  it('finds the offered list at all', () => {
    // A rename would empty the list and make every check below vacuous.
    expect(offeredKinds().length).toBeGreaterThan(3)
  })

  it('offers exactly the kinds the main process supports', () => {
    expect([...offeredKinds()].sort()).toEqual([...PROFILE_KINDS].sort())
  })

  it('offers nothing the main process would reject', () => {
    const unsupported = Object.keys(UNSUPPORTED_KINDS)
    expect(offeredKinds().filter((k) => unsupported.includes(k))).toEqual([])
  })

  it('asks for a client ID for exactly the OAuth kinds', () => {
    // Asking a password kind for a client ID, or an OAuth kind for a password,
    // both produce a profile that cannot connect.
    const oauth = offeredOAuthKinds()
    expect(oauth.length).toBeGreaterThan(0)
    for (const k of oauth) expect(offeredKinds()).toContain(k)
    expect(APP).toContain('profile.clientId')
  })
})
