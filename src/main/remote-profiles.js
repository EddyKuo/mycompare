/**
 * @file remote-profiles.js
 * @description Storage and validation for remote-connection profiles (FTP,
 *   FTPS, S3), modelled on Beyond Compare's saved FTP/cloud profiles.
 *
 * ⚠️ PRIVACY / NETWORK EGRESS WARNING
 *   A profile exists purely to point the app at a **third-party server**. Using
 *   one uploads credentials and downloads file content across the network; the
 *   user's data leaves the machine. This module only stores the settings, but
 *   the UI that consumes it must say so plainly before the first connection.
 *
 * ## Secrets
 *
 * Passwords and S3 secret access keys are **never written in plain text**, not
 * even obfuscated (base64 or a fixed XOR key is plain text with extra steps —
 * it stops nobody and it lies to the user about the protection they have).
 *
 * The only supported at-rest form is a ciphertext produced by Electron's
 * `safeStorage`, which is backed by the OS keychain: DPAPI on Windows, Keychain
 * on macOS, libsecret/kwallet on Linux. When
 * `safeStorage.isEncryptionAvailable()` is false — a headless Linux session
 * with no keyring is the common case — the secret is **dropped and the user is
 * asked for it every time**. Falling back to plaintext would silently turn a
 * "remember my password" checkbox into a credential-disclosure bug, so it is
 * not offered.
 *
 * Because a stored ciphertext is bound to the OS user account, a profile file
 * copied to another machine loads with its secrets missing rather than failing —
 * `load()` reports that as a warning and marks the profile `needsSecret`.
 *
 * ## Unsupported kinds
 *
 * Beyond Compare also offers SFTP, Dropbox and OneDrive. Those are rejected
 * here rather than half-implemented:
 *
 *   - **SFTP** runs over SSH and would need a full SSH transport layer (key
 *     exchange, host-key verification, per-direction ciphers and MACs, rekeying)
 *     before the SFTP packet layer even starts. Node exposes no SSH primitives,
 *     and the project forbids new npm dependencies, so the only route would be
 *     hand-written cryptographic transport code — which would be less secure
 *     than no feature at all.
 *   - **Dropbox / OneDrive** need an interactive OAuth 2.0 authorization-code +
 *     PKCE flow, a registered per-vendor application client ID, a redirect
 *     listener, refresh-token rotation, and each vendor's own REST API. There is
 *     no protocol to implement; it is a per-vendor integration with an external
 *     registration prerequisite.
 *
 * `UNSUPPORTED_KINDS` carries the user-facing reason so the UI can explain the
 * gap instead of showing an empty dropdown.
 *
 * ## Testability
 *
 * Everything except `createElectronProfileStore()` is pure or takes its
 * dependencies (`crypto adapter`, `fs`) as arguments, so validation,
 * normalisation and the encrypt/decrypt round trip are all testable without
 * Electron and without touching the real filesystem.
 */

import { join } from 'path'
import { randomUUID } from 'crypto'

/** Kinds this application can actually talk to. */
export const PROFILE_KINDS = Object.freeze(['ftp', 'ftps', 's3'])

/** Kinds Beyond Compare has that we deliberately do not, with the reason. */
export const UNSUPPORTED_KINDS = Object.freeze({
  sftp: 'SFTP requires a full SSH transport layer (key exchange, host-key ' +
    'verification, ciphers, MACs). Node ships no SSH primitives and the project ' +
    'forbids new dependencies, so it cannot be implemented safely.',
  dropbox: 'Dropbox requires an interactive OAuth 2.0 flow and a registered ' +
    'application client ID, which this application does not have.',
  onedrive: 'OneDrive requires an interactive OAuth 2.0 flow and a registered ' +
    'Microsoft application client ID, which this application does not have.',
})

/** Filename under `app.getPath('userData')`. */
export const PROFILE_FILENAME = 'remote-profiles.json'

/** Bumped when the on-disk shape changes incompatibly. */
export const PROFILE_SCHEMA_VERSION = 1

/** A profile store this large is corrupt or hostile, not a config file. */
export const MAX_PROFILE_FILE_BYTES = 4 * 1024 * 1024

/**
 * @typedef {object} RemoteProfile
 * @property {string} id
 * @property {string} name
 * @property {'ftp'|'ftps'|'s3'} kind
 * @property {string} host        FTP/FTPS host, or the S3 endpoint override ('' for AWS)
 * @property {number} port        FTP/FTPS only
 * @property {string} user        FTP username, or the S3 access key id
 * @property {string} path        remote starting directory / key prefix
 * @property {boolean} passive    FTP only; active mode is not implemented
 * @property {string} bucket      S3 only
 * @property {string} region      S3 only
 * @property {boolean} pathStyle  S3 only
 * @property {boolean} saveSecret whether the secret may be persisted
 * @property {boolean} needsSecret true when a secret is required but not loaded
 * @property {string} [secret]    IN MEMORY ONLY — never serialised in the clear
 */

/**
 * @typedef {object} CryptoAdapter
 * @property {() => boolean} isEncryptionAvailable
 * @property {(plain: string) => Buffer} encryptString
 * @property {(cipher: Buffer) => string} decryptString
 *
 * Shaped exactly like Electron's `safeStorage` so the real thing can be passed
 * straight in, and a fake can be passed in tests.
 */

/**
 * A crypto adapter that refuses to store anything. Used as the default so that
 * forgetting to wire up `safeStorage` fails closed (secrets are dropped) rather
 * than open (secrets are written in the clear).
 *
 * @type {CryptoAdapter}
 */
export const NULL_CRYPTO = Object.freeze({
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('encryption unavailable') },
  decryptString: () => { throw new Error('encryption unavailable') },
})

/**
 * @param {'ftp'|'ftps'|'s3'} kind
 * @returns {number}
 */
export function defaultPort(kind) {
  return kind === 's3' ? 443 : 21
}

/**
 * Normalise a user-entered remote path / key prefix.
 *
 * Unlike a path from a *server*, this comes from the user, so it is a usability
 * concern rather than a security boundary — but `..` is still collapsed so a
 * saved profile cannot quietly point somewhere other than it displays.
 *
 * @param {unknown} p
 * @param {'ftp'|'ftps'|'s3'} kind
 * @returns {string} FTP: absolute, no trailing slash. S3: prefix with no
 *   leading slash, trailing slash kept (it is meaningful as a folder marker).
 */
export function normaliseProfilePath(p, kind) {
  const raw = typeof p === 'string' ? p : ''
  const trailing = raw.endsWith('/')
  const parts = raw.replace(/\\/g, '/').split('/')
  /** @type {string[]} */
  const out = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  if (kind === 's3') {
    if (out.length === 0) return ''
    return out.join('/') + (trailing ? '/' : '')
  }
  return '/' + out.join('/')
}

/**
 * Check a profile without throwing, so a form can show every problem at once.
 *
 * @param {Partial<RemoteProfile>} input
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateProfile(input) {
  /** @type {string[]} */
  const errors = []
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['profile must be an object'] }
  }

  const kind = String(input.kind ?? '')
  if (Object.prototype.hasOwnProperty.call(UNSUPPORTED_KINDS, kind)) {
    errors.push(`${kind} is not supported: ${UNSUPPORTED_KINDS[kind]}`)
    return { ok: false, errors }
  }
  if (!PROFILE_KINDS.includes(kind)) {
    errors.push(`kind must be one of ${PROFILE_KINDS.join(', ')}`)
  }

  if (typeof input.name !== 'string' || input.name.trim() === '') {
    errors.push('name is required')
  } else if (input.name.length > 128) {
    errors.push('name must be at most 128 characters')
  }

  if (kind === 'ftp' || kind === 'ftps') {
    if (typeof input.host !== 'string' || input.host.trim() === '') {
      errors.push('host is required')
    } else if (!/^[A-Za-z0-9._-]+$/.test(input.host.trim()) && !/^\[[0-9a-fA-F:]+\]$/.test(input.host.trim())) {
      // A host string is later interpolated into socket options; anything
      // outside the hostname/IPv6-literal grammar is rejected rather than
      // guessed at.
      errors.push('host contains invalid characters')
    }
    const port = input.port ?? defaultPort(/** @type {'ftp'} */(kind))
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push('port must be an integer in 1..65535')
    }
    if (input.passive === false) {
      errors.push('active mode (PORT) is not implemented; passive mode is required')
    }
  }

  if (kind === 's3') {
    const bucket = String(input.bucket ?? '')
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      errors.push('bucket must be a valid S3 bucket name (3-63 chars, lowercase)')
    }
    if (!/^[a-z0-9-]{2,}$/.test(String(input.region ?? ''))) {
      errors.push('region is required')
    }
    if (typeof input.user !== 'string' || input.user.trim() === '') {
      errors.push('access key id is required')
    }
    if (input.host && !/^[A-Za-z0-9._-]+$/.test(String(input.host).replace(/^https:\/\//i, ''))) {
      errors.push('endpoint contains invalid characters')
    }
    if (input.host && /^http:\/\//i.test(String(input.host))) {
      errors.push('endpoint must use https')
    }
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Validate and fill in a profile.
 *
 * @param {Partial<RemoteProfile>} input
 * @param {{idFactory?: () => string}} [opts]
 * @returns {RemoteProfile}
 * @throws {Error} listing every validation failure
 */
export function normaliseProfile(input, opts = {}) {
  const { ok, errors } = validateProfile(input)
  if (!ok) throw new Error(`Invalid remote profile: ${errors.join('; ')}`)

  const kind = /** @type {'ftp'|'ftps'|'s3'} */ (input.kind)
  const idFactory = opts.idFactory ?? randomUUID
  const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : idFactory()
  const saveSecret = input.saveSecret !== false

  /** @type {RemoteProfile} */
  const profile = {
    id,
    name: String(input.name).trim(),
    kind,
    host: String(input.host ?? '').trim().replace(/^https:\/\//i, ''),
    port: kind === 's3' ? 443 : (input.port ?? defaultPort(kind)),
    user: String(input.user ?? '').trim(),
    path: normaliseProfilePath(input.path, kind),
    passive: true,
    bucket: kind === 's3' ? String(input.bucket ?? '').trim() : '',
    region: kind === 's3' ? String(input.region ?? '').trim() : '',
    pathStyle: kind === 's3' ? Boolean(input.pathStyle) : false,
    saveSecret,
    needsSecret: false,
  }
  if (typeof input.secret === 'string' && input.secret !== '') {
    profile.secret = input.secret
  }
  profile.needsSecret = !profile.secret
  return profile
}

/**
 * Strip the secret for logging or for handing to the renderer.
 *
 * The renderer never needs the secret — only the main process connects — so
 * everything crossing IPC should go through here. `contextIsolation` protects
 * the bridge, not the values sent over it.
 *
 * @param {RemoteProfile} profile
 * @returns {Omit<RemoteProfile, 'secret'> & {hasSecret: boolean}}
 */
export function redactProfile(profile) {
  const { secret, ...rest } = profile
  return { ...rest, hasSecret: Boolean(secret) }
}

/**
 * Serialise profiles to the on-disk JSON form.
 *
 * @param {RemoteProfile[]} profiles
 * @param {CryptoAdapter} [crypto]
 * @returns {{json: string, warnings: string[]}}
 */
export function serialiseProfiles(profiles, crypto = NULL_CRYPTO) {
  /** @type {string[]} */
  const warnings = []
  let available = false
  try {
    available = Boolean(crypto.isEncryptionAvailable())
  } catch {
    available = false
  }

  const records = (profiles ?? []).map((p) => {
    // Explicit allow-list rather than `delete p.secret`: a field added to the
    // profile type later must be opted in to persistence, not opted out.
    const record = {
      id: p.id,
      name: p.name,
      kind: p.kind,
      host: p.host,
      port: p.port,
      user: p.user,
      path: p.path,
      passive: true,
      bucket: p.bucket,
      region: p.region,
      pathStyle: p.pathStyle,
      saveSecret: Boolean(p.saveSecret),
      /** @type {string|undefined} */
      encryptedSecret: undefined,
    }

    if (p.secret && p.saveSecret) {
      if (!available) {
        record.saveSecret = false
        warnings.push(
          `Profile "${p.name}": OS encryption is unavailable, so the password was ` +
          'not saved. It will be requested on each connection.',
        )
      } else {
        try {
          record.encryptedSecret = Buffer.from(crypto.encryptString(p.secret)).toString('base64')
        } catch (err) {
          record.saveSecret = false
          warnings.push(`Profile "${p.name}": password could not be encrypted (${err.message}); not saved.`)
        }
      }
    }
    return record
  })

  return {
    json: JSON.stringify({ version: PROFILE_SCHEMA_VERSION, profiles: records }, null, 2),
    warnings,
  }
}

/**
 * Parse the on-disk JSON form.
 *
 * A corrupt or partially unreadable file yields the profiles that could be read
 * plus warnings, rather than throwing everything away — losing every saved
 * connection because one record is malformed would be worse than the bug that
 * caused it.
 *
 * @param {string} text
 * @param {CryptoAdapter} [crypto]
 * @returns {{profiles: RemoteProfile[], warnings: string[]}}
 */
export function parseProfiles(text, crypto = NULL_CRYPTO) {
  /** @type {string[]} */
  const warnings = []
  if (typeof text !== 'string' || text.trim() === '') return { profiles: [], warnings }
  if (text.length > MAX_PROFILE_FILE_BYTES) {
    return { profiles: [], warnings: ['Profile file is implausibly large; ignored.'] }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { profiles: [], warnings: [`Profile file is not valid JSON (${err.message}); ignored.`] }
  }
  if (!parsed || !Array.isArray(parsed.profiles)) {
    return { profiles: [], warnings: ['Profile file has no profiles array; ignored.'] }
  }
  if (parsed.version > PROFILE_SCHEMA_VERSION) {
    warnings.push(
      `Profile file was written by a newer version (${parsed.version}); ` +
      'unknown fields will be dropped on save.',
    )
  }

  let available = false
  try {
    available = Boolean(crypto.isEncryptionAvailable())
  } catch {
    available = false
  }

  /** @type {RemoteProfile[]} */
  const profiles = []
  for (const record of parsed.profiles) {
    let profile
    try {
      profile = normaliseProfile({ ...record, secret: undefined })
    } catch (err) {
      warnings.push(`Skipped a profile: ${err.message}`)
      continue
    }
    profile.saveSecret = record?.saveSecret !== false

    if (typeof record?.encryptedSecret === 'string' && record.encryptedSecret !== '') {
      if (!available) {
        warnings.push(
          `Profile "${profile.name}": OS encryption is unavailable, so the saved ` +
          'password cannot be read. It will be requested on connect.',
        )
      } else {
        try {
          const secret = crypto.decryptString(Buffer.from(record.encryptedSecret, 'base64'))
          if (typeof secret === 'string' && secret !== '') profile.secret = secret
        } catch {
          // Expected when the file came from another machine or OS account:
          // safeStorage ciphertext is bound to the local user.
          warnings.push(
            `Profile "${profile.name}": the saved password could not be decrypted ` +
            '(profiles do not transfer between machines or user accounts). ' +
            'It will be requested on connect.',
          )
        }
      }
    }
    profile.needsSecret = !profile.secret
    profiles.push(profile)
  }
  return { profiles, warnings }
}

/**
 * Create a profile store over injected filesystem and crypto adapters.
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {CryptoAdapter} [opts.crypto]
 * @param {{readFile: Function, writeFile: Function, mkdir?: Function}} opts.fs
 *   promise-based, i.e. `node:fs/promises`
 */
export function createProfileStore(opts) {
  if (!opts?.filePath) throw new Error('createProfileStore requires a filePath')
  if (!opts?.fs) throw new Error('createProfileStore requires an fs implementation')
  const crypto = opts.crypto ?? NULL_CRYPTO
  const fs = opts.fs

  /** @type {RemoteProfile[]} */
  let profiles = []
  /** @type {string[]} */
  let warnings = []
  let loaded = false

  return {
    /** @returns {Promise<{profiles: RemoteProfile[], warnings: string[]}>} */
    async load() {
      let text = ''
      try {
        text = await fs.readFile(opts.filePath, 'utf-8')
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          warnings = [`Could not read profiles: ${err.message}`]
          profiles = []
          loaded = true
          return { profiles: [], warnings }
        }
        text = '' // first run
      }
      const result = parseProfiles(text, crypto)
      profiles = result.profiles
      warnings = result.warnings
      loaded = true
      return { profiles: profiles.slice(), warnings: warnings.slice() }
    },

    /** @returns {Promise<{warnings: string[]}>} */
    async save() {
      const { json, warnings: w } = serialiseProfiles(profiles, crypto)
      // Restrictive mode even though the payload holds no plaintext secret:
      // hostnames and usernames are worth keeping to the owning user.
      await fs.writeFile(opts.filePath, json, { encoding: 'utf-8', mode: 0o600 })
      warnings = w
      return { warnings: w.slice() }
    },

    /** @returns {RemoteProfile[]} */
    list() {
      return profiles.slice()
    },

    /** @returns {(Omit<RemoteProfile,'secret'> & {hasSecret: boolean})[]} */
    listRedacted() {
      return profiles.map(redactProfile)
    },

    /**
     * @param {string} id
     * @returns {RemoteProfile|undefined}
     */
    get(id) {
      return profiles.find((p) => p.id === id)
    },

    /**
     * Insert or replace a profile, persisting immediately.
     *
     * @param {Partial<RemoteProfile>} input
     * @returns {Promise<{profile: RemoteProfile, warnings: string[]}>}
     */
    async upsert(input) {
      const profile = normaliseProfile(input)
      const i = profiles.findIndex((p) => p.id === profile.id)
      if (i === -1) profiles.push(profile)
      else profiles[i] = profile
      const { warnings: w } = await this.save()
      return { profile, warnings: w }
    },

    /**
     * @param {string} id
     * @returns {Promise<boolean>} whether anything was removed
     */
    async remove(id) {
      const before = profiles.length
      profiles = profiles.filter((p) => p.id !== id)
      if (profiles.length === before) return false
      await this.save()
      return true
    },

    /** @returns {string[]} warnings from the most recent load/save */
    getWarnings() {
      return warnings.slice()
    },

    /** @returns {boolean} */
    isLoaded() {
      return loaded
    },
  }
}

/**
 * Build a store backed by the real Electron `safeStorage` and the user-data
 * directory.
 *
 * `electron` and `fs/promises` are imported dynamically so this module stays
 * importable — and testable — outside an Electron main process.
 *
 * @returns {Promise<ReturnType<typeof createProfileStore>>}
 */
export async function createElectronProfileStore() {
  const { app, safeStorage } = await import('electron')
  const fs = await import('fs/promises')
  return createProfileStore({
    filePath: join(app.getPath('userData'), PROFILE_FILENAME),
    crypto: safeStorage,
    fs,
  })
}
