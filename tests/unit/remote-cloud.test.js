/**
 * Dropbox and OneDrive: the read-only cloud-drive clients and their wiring
 * into the remote IPC surface.
 *
 * No network access: every HTTP call goes through an injected `requestFn`.
 * The properties under test are the ones a live account would not reveal
 * anyway — that pagination is followed to the end, that a hostile file name
 * from the server never becomes a path, that the size cap can only be lowered,
 * and that a dead authorization is reported as "sign in again" rather than as
 * an empty folder.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  DropboxClient,
  DROPBOX_OAUTH,
  toDropboxPath,
  asciiHeaderJson,
  mapDropboxEntry,
} from '../../src/main/remote-dropbox.js'
import {
  OneDriveClient,
  ONEDRIVE_OAUTH,
  childrenUrlForPath,
  childrenUrlForId,
  itemUrlForPath,
  isSafeItemId,
  mapDriveItem,
} from '../../src/main/remote-onedrive.js'
import { join } from 'path'
import { registerRemoteIpc } from '../../src/main/remote-ipc.js'

/**
 * A stand-in for `https.request`. `handler` sees every call and decides the
 * response, so a whole paginated conversation can be scripted.
 *
 * @param {(call: {options: object, body: string, url: string}) => object} handler
 */
function makeRequestFn(handler) {
  /** @type {{options: object, body: string, url: string}[]} */
  const calls = []
  const fn = (options, cb) => {
    const req = new EventEmitter()
    let body = ''
    req.setTimeout = () => {}
    req.write = (b) => { body += Buffer.from(b).toString('utf-8') }
    req.destroy = () => {}
    req.end = () => {
      queueMicrotask(() => {
        const call = { options, body, url: `https://${options.host}${options.path}` }
        calls.push(call)
        const result = handler(call) ?? {}
        const res = new EventEmitter()
        res.statusCode = result.status ?? 200
        res.headers = result.headers ?? {}
        res.destroy = () => {}
        cb(res)
        queueMicrotask(() => {
          for (const chunk of result.chunks ?? [Buffer.from(result.body ?? '', 'utf-8')]) {
            res.emit('data', Buffer.from(chunk))
          }
          res.emit('end')
        })
      })
    }
    return req
  }
  fn.calls = calls
  return fn
}

const token = async () => 'access-token'

// ── Dropbox ────────────────────────────────────────────────────────────────

describe('Dropbox paths and headers', () => {
  it('maps the root to the empty string, which is what the API wants', () => {
    // `/` is rejected by Dropbox with malformed_path.
    expect(toDropboxPath('/')).toBe('')
    expect(toDropboxPath('')).toBe('')
    expect(toDropboxPath('.')).toBe('')
    expect(toDropboxPath('/docs')).toBe('/docs')
    expect(toDropboxPath('docs/sub')).toBe('/docs/sub')
  })

  it('resolves .. so a constructed path cannot address a parent of the root', () => {
    expect(toDropboxPath('/a/../../b')).toBe('/b')
    expect(toDropboxPath('/../..')).toBe('')
  })

  it('escapes non-ASCII for the header, which cannot carry it raw', () => {
    expect(asciiHeaderJson({ path: '/報告.txt' }))
      .toBe('{"path":"/\\u5831\\u544a.txt"}')
    // ASCII is left alone so the common case stays readable in a trace.
    expect(asciiHeaderJson({ path: '/a b.txt' })).toBe('{"path":"/a b.txt"}')
  })

  it('asks only for read scopes, and for an offline refresh token', () => {
    expect(DROPBOX_OAUTH.scope).not.toMatch(/write|delete/)
    expect(DROPBOX_OAUTH.extraAuthParams.token_access_type).toBe('offline')
  })
})

describe('mapDropboxEntry', () => {
  it('maps a file and a folder', () => {
    expect(mapDropboxEntry({
      '.tag': 'file', name: 'a.txt', size: 12, server_modified: '2024-01-02T03:04:05Z',
    })).toEqual({
      name: 'a.txt', isDirectory: false, size: 12, mtime: new Date('2024-01-02T03:04:05Z'),
    })
    expect(mapDropboxEntry({ '.tag': 'folder', name: 'docs' }))
      .toMatchObject({ isDirectory: true, size: 0 })
  })

  it.each([
    ['a traversal name', '../../../.ssh/authorized_keys'],
    ['a bare parent', '..'],
    ['an absolute-looking name', '/etc/passwd'],
    ['a backslash name', 'a\\b'],
    ['a NUL-bearing name', 'a\u0000b'],
    ['a drive-relative name', 'C:evil'],
    ['an empty name', ''],
  ])('drops %s', (_label, name) => {
    // The server chooses this string. If it ever reached a local join(), the
    // server would be choosing where downloaded bytes land.
    expect(mapDropboxEntry({ '.tag': 'file', name })).toBeNull()
  })

  it('drops tombstones', () => {
    expect(mapDropboxEntry({ '.tag': 'deleted', name: 'gone.txt' })).toBeNull()
  })
})

describe('DropboxClient.list', () => {
  it('follows has_more to the end and reports what it dropped', async () => {
    const pages = [
      {
        entries: [
          { '.tag': 'file', name: 'one.txt', size: 1 },
          { '.tag': 'file', name: '../escape', size: 1 },
        ],
        has_more: true,
        cursor: 'cursor-1',
      },
      {
        entries: [{ '.tag': 'folder', name: 'sub' }],
        has_more: false,
      },
    ]
    let n = 0
    const requestFn = makeRequestFn((call) => {
      if (n === 1) expect(JSON.parse(call.body).cursor).toBe('cursor-1')
      return { body: JSON.stringify(pages[n++]) }
    })
    const client = new DropboxClient({ getAccessToken: token, requestFn })
    const result = await client.list('/docs')

    expect(requestFn.calls.map((c) => c.options.path)).toEqual([
      '/2/files/list_folder', '/2/files/list_folder/continue',
    ])
    expect(result.entries.map((e) => e.name)).toEqual(['one.txt', 'sub'])
    // Not silently missing: a comparison that quietly omits entries looks
    // complete when it is not.
    expect(result.skipped).toEqual(['../escape'])
    expect(result.truncated).toBe(false)
    expect(JSON.parse(requestFn.calls[0].body).path).toBe('/docs')
    expect(requestFn.calls[0].options.headers.authorization).toBe('Bearer access-token')
  })

  it('stops at the page cap rather than following a cursor forever', async () => {
    const requestFn = makeRequestFn(() => ({
      body: JSON.stringify({ entries: [], has_more: true, cursor: 'c' }),
    }))
    const client = new DropboxClient({ getAccessToken: token, requestFn, maxPages: 3 })
    const result = await client.list('/')
    expect(requestFn.calls).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('asks for a fresh token on every call, so an expiry mid-listing is invisible', async () => {
    const tokens = ['t1', 't2']
    let issued = 0
    let page = 0
    const requestFn = makeRequestFn(() => ({
      body: JSON.stringify(page++ === 0
        ? { entries: [], has_more: true, cursor: 'c' }
        : { entries: [], has_more: false }),
    }))
    const client = new DropboxClient({
      getAccessToken: async () => tokens[issued++],
      requestFn,
    })
    await client.list('/')
    expect(requestFn.calls.map((c) => c.options.headers.authorization))
      .toEqual(['Bearer t1', 'Bearer t2'])
  })

  it('reports a revoked token as needing re-authorization', async () => {
    const requestFn = makeRequestFn(() => ({
      status: 401, body: JSON.stringify({ error_summary: 'expired_access_token/' }),
    }))
    const client = new DropboxClient({ getAccessToken: token, requestFn })
    await expect(client.list('/')).rejects.toMatchObject({ code: 'reauthorize' })
  })

  it('explains a 409 not_found rather than showing a bare status', async () => {
    const requestFn = makeRequestFn(() => ({
      status: 409, body: JSON.stringify({ error_summary: 'path/not_found/' }),
    }))
    const client = new DropboxClient({ getAccessToken: token, requestFn })
    await expect(client.list('/nope')).rejects.toThrow(/not_found/)
  })
})

describe('DropboxClient.download', () => {
  it('sends the path in the ASCII-escaped header and returns the bytes', async () => {
    const requestFn = makeRequestFn(() => ({ body: 'file-content' }))
    const client = new DropboxClient({ getAccessToken: token, requestFn })
    const data = await client.download('/報告.txt')
    expect(data.toString()).toBe('file-content')
    const call = requestFn.calls[0]
    expect(call.options.host).toBe('content.dropboxapi.com')
    expect(call.options.headers['Dropbox-API-Arg']).toBe('{"path":"/\\u5831\\u544a.txt"}')
  })

  it('enforces the size cap while the bytes arrive', async () => {
    const requestFn = makeRequestFn(() => ({
      chunks: [Buffer.alloc(700), Buffer.alloc(700)],
    }))
    const client = new DropboxClient({ getAccessToken: token, requestFn })
    await expect(client.download('/big.bin', { maxBytes: 1000 }))
      .rejects.toThrow(/exceeded 1000 bytes/)
  })

  it('lets a per-call limit lower the ceiling but never raise it', async () => {
    const requestFn = makeRequestFn(() => ({ chunks: [Buffer.alloc(200)] }))
    const client = new DropboxClient({
      getAccessToken: token, requestFn, maxDownloadBytes: 100,
    })
    await expect(client.download('/big.bin', { maxBytes: 10 * 1024 * 1024 }))
      .rejects.toThrow(/exceeded 100 bytes/)
  })

  it('refuses to download the root', async () => {
    const client = new DropboxClient({ getAccessToken: token, requestFn: makeRequestFn(() => ({})) })
    await expect(client.download('/')).rejects.toThrow(/file path/)
  })
})

// ── OneDrive ───────────────────────────────────────────────────────────────

describe('OneDrive URL building', () => {
  it('addresses the root as root and a path as root:/path:', () => {
    expect(childrenUrlForPath('/')).toMatch(/\/me\/drive\/root\/children\?/)
    expect(childrenUrlForPath('/docs/sub'))
      .toMatch(/\/me\/drive\/root:\/docs\/sub:\/children\?/)
    expect(itemUrlForPath('/')).toMatch(/\/me\/drive\/root$/)
  })

  it('percent-encodes each segment but keeps the separators', () => {
    expect(childrenUrlForPath('/a b/ç')).toContain('/root:/a%20b/%C3%A7:/children')
  })

  it('resolves .. before building the URL', () => {
    expect(childrenUrlForPath('/a/../../b')).toContain('/root:/b:/children')
  })

  it('constrains an item id, because it is interpolated into a URL', () => {
    expect(isSafeItemId('01ABCDEF23456789')).toBe(true)
    expect(isSafeItemId('../../me/drive/root')).toBe(false)
    expect(isSafeItemId('a/b')).toBe(false)
    expect(isSafeItemId('')).toBe(false)
    expect(() => childrenUrlForId('a/b')).toThrow(/Unsafe/)
  })

  it('asks only for read scopes, plus offline access', () => {
    expect(ONEDRIVE_OAUTH.scope).toMatch(/offline_access/)
    expect(ONEDRIVE_OAUTH.scope).not.toMatch(/ReadWrite/)
  })
})

describe('mapDriveItem', () => {
  it('maps a file and a folder', () => {
    expect(mapDriveItem({
      name: 'a.txt', size: 5, id: 'ID1', lastModifiedDateTime: '2024-05-06T07:08:09Z',
      file: { mimeType: 'text/plain' },
    })).toEqual({
      name: 'a.txt', isDirectory: false, size: 5, id: 'ID1',
      mtime: new Date('2024-05-06T07:08:09Z'),
    })
    expect(mapDriveItem({ name: 'docs', folder: { childCount: 2 }, size: 99 }))
      .toMatchObject({ isDirectory: true, size: 0 })
  })

  it('drops a name that could act as a path', () => {
    expect(mapDriveItem({ name: '../../etc/passwd' })).toBeNull()
    expect(mapDriveItem({ name: 'a\u0000b' })).toBeNull()
  })
})

describe('OneDriveClient.list', () => {
  it('follows @odata.nextLink to the end and reports what it dropped', async () => {
    const pages = [
      {
        value: [{ name: 'one.txt', size: 1 }, { name: '../escape' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=x',
      },
      { value: [{ name: 'sub', folder: {} }] },
    ]
    let n = 0
    const requestFn = makeRequestFn(() => ({ body: JSON.stringify(pages[n++]) }))
    const client = new OneDriveClient({ getAccessToken: token, requestFn })
    const result = await client.list('/')

    expect(requestFn.calls).toHaveLength(2)
    expect(requestFn.calls[1].options.path).toContain('$skiptoken=x')
    expect(result.entries.map((e) => e.name)).toEqual(['one.txt', 'sub'])
    expect(result.skipped).toEqual(['../escape'])
  })

  it('stops at the page cap', async () => {
    const requestFn = makeRequestFn(() => ({
      body: JSON.stringify({
        value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next',
      }),
    }))
    const client = new OneDriveClient({ getAccessToken: token, requestFn, maxPages: 2 })
    expect((await client.list('/')).truncated).toBe(true)
    expect(requestFn.calls).toHaveLength(2)
  })

  it('lists by item id when asked', async () => {
    const requestFn = makeRequestFn(() => ({ body: JSON.stringify({ value: [] }) }))
    const client = new OneDriveClient({ getAccessToken: token, requestFn })
    await client.listById('01ABC')
    expect(requestFn.calls[0].options.path).toContain('/me/drive/items/01ABC/children')
  })

  it('reports a revoked token as needing re-authorization', async () => {
    const requestFn = makeRequestFn(() => ({
      status: 401, body: JSON.stringify({ error: { code: 'InvalidAuthenticationToken' } }),
    }))
    const client = new OneDriveClient({ getAccessToken: token, requestFn })
    await expect(client.list('/')).rejects.toMatchObject({ code: 'reauthorize' })
  })

  it('turns a 403 into advice about the permissions that were not granted', async () => {
    const requestFn = makeRequestFn(() => ({
      status: 403, body: JSON.stringify({ error: { code: 'accessDenied', message: 'no' } }),
    }))
    const client = new OneDriveClient({ getAccessToken: token, requestFn })
    await expect(client.list('/')).rejects.toThrow(/Files\.Read/)
  })
})

describe('OneDriveClient.download', () => {
  const item = {
    name: 'a.txt',
    size: 11,
    '@microsoft.graph.downloadUrl': 'https://files.example.com/pre-authed?tmp=1',
  }

  it('fetches the pre-authenticated URL without forwarding the bearer token', async () => {
    const requestFn = makeRequestFn((call) => (call.options.host === 'graph.microsoft.com'
      ? { body: JSON.stringify(item) }
      : { body: 'file-content' }))
    const client = new OneDriveClient({ getAccessToken: token, requestFn })
    expect((await client.download('/a.txt')).toString()).toBe('file-content')

    const [metaCall, contentCall] = requestFn.calls
    expect(metaCall.options.headers.authorization).toBe('Bearer access-token')
    // The download URL carries its own authorization; sending the Graph token
    // to whatever host Microsoft names would hand that host the whole drive.
    expect(contentCall.options.host).toBe('files.example.com')
    expect(contentCall.options.headers?.authorization).toBeUndefined()
  })

  it('refuses before transferring when the declared size is over the cap', async () => {
    const requestFn = makeRequestFn(() => ({ body: JSON.stringify({ ...item, size: 5000 }) }))
    const client = new OneDriveClient({ getAccessToken: token, requestFn })
    await expect(client.download('/a.txt', { maxBytes: 1000 })).rejects.toThrow(/超過/)
    // Only the metadata call happened; no bandwidth was spent on the body.
    expect(requestFn.calls).toHaveLength(1)
  })

  it('still caps a body that turns out larger than the metadata claimed', async () => {
    const requestFn = makeRequestFn((call) => (call.options.host === 'graph.microsoft.com'
      ? { body: JSON.stringify({ ...item, size: 1 }) }
      : { chunks: [Buffer.alloc(900), Buffer.alloc(900)] }))
    const client = new OneDriveClient({ getAccessToken: token, requestFn })
    await expect(client.download('/a.txt', { maxBytes: 1000 }))
      .rejects.toThrow(/exceeded 1000 bytes/)
  })

  it('follows a bounded number of https redirects', async () => {
    let hops = 0
    const requestFn = makeRequestFn((call) => {
      if (call.options.host === 'graph.microsoft.com') return { body: JSON.stringify(item) }
      if (hops++ < 2) {
        return { status: 302, headers: { location: 'https://cdn.example.com/blob' } }
      }
      return { body: 'redirected-content' }
    })
    const client = new OneDriveClient({ getAccessToken: token, requestFn })
    expect((await client.download('/a.txt')).toString()).toBe('redirected-content')
  })

  it('refuses a redirect that downgrades to http', async () => {
    const requestFn = makeRequestFn((call) => (call.options.host === 'graph.microsoft.com'
      ? { body: JSON.stringify(item) }
      : { status: 302, headers: { location: 'http://cdn.example.com/blob' } }))
    const client = new OneDriveClient({ getAccessToken: token, requestFn })
    await expect(client.download('/a.txt')).rejects.toThrow(/non-https/i)
  })

  it('refuses to download a folder', async () => {
    const requestFn = makeRequestFn(() => ({ body: JSON.stringify({ name: 'd', folder: {} }) }))
    const client = new OneDriveClient({ getAccessToken: token, requestFn })
    await expect(client.download('/d')).rejects.toThrow(/資料夾/)
  })
})

// ── IPC wiring ─────────────────────────────────────────────────────────────

/** Minimal in-memory fs/promises stand-in. */
function memfs(seed = {}) {
  const files = new Map(Object.entries(seed))
  return {
    files,
    async readFile(p) {
      if (!files.has(p)) {
        const err = new Error('ENOENT')
        // @ts-expect-error test double
        err.code = 'ENOENT'
        throw err
      }
      return files.get(p)
    },
    async writeFile(p, data) { files.set(p, String(data)) },
    async mkdir() {},
  }
}

/** A crypto adapter that "encrypts" reversibly, standing in for safeStorage. */
const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf-8'),
  decryptString: (cipher) => Buffer.from(cipher).toString('utf-8').replace(/^enc:/, ''),
}

/**
 * @param {object} profileRecord
 * @param {object} extra deps overrides
 */
function harness(profileRecord, extra = {}) {
  /** @type {Map<string, Function>} */
  const handlers = new Map()
  const profilePath = join('/data', 'remote-profiles.json')
  const fs = memfs({
    [profilePath]: JSON.stringify({
      version: 1,
      profiles: [profileRecord],
    }),
  })
  const api = registerRemoteIpc({
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
    },
    userDataPath: () => '/data',
    fs,
    crypto: fakeCrypto,
    ...extra,
  })
  return {
    api,
    fs,
    /** @param {string} ch @param {object} [arg] */
    call: (ch, arg) => handlers.get(ch)(null, arg),
    savedProfile: () => JSON.parse(fs.files.get(profilePath)).profiles[0],
  }
}

const dropboxRecord = {
  id: 'db1', name: 'My Dropbox', kind: 'dropbox', clientId: 'app-key-123',
  saveSecret: true, encryptedSecret: Buffer.from('enc:stored-refresh').toString('base64'),
}

describe('remote IPC — cloud drives', () => {
  /** @type {object[]} */
  let listed
  /** @type {object} */
  let fakeClient
  /** @type {Function} */
  let Ctor

  beforeEach(() => {
    listed = []
    fakeClient = {
      list: async (dir) => {
        listed.push(dir)
        return {
          entries: [
            { name: 'a.txt', isDirectory: false, size: 3, mtime: new Date('2024-01-01T00:00:00Z') },
            { name: 'sub', isDirectory: true, size: 0, mtime: null },
          ],
          skipped: [],
        }
      },
      download: async () => Buffer.from('abc'),
      close: async () => {},
    }
    Ctor = function (opts) {
      fakeClient.opts = opts
      return fakeClient
    }
  })

  it('routes a dropbox profile to the Dropbox client, not to FTP', async () => {
    // The failure this guards against is a profile the UI happily creates and
    // that then falls through to a branch that cannot possibly serve it.
    const h = harness(dropboxRecord, { DropboxClientCtor: Ctor })
    const rows = await h.call('remote-list-dir', { profileId: 'db1', dir: '/docs' })
    expect(listed).toEqual(['/docs'])
    expect(rows[0]).toMatchObject({
      name: 'a.txt', path: 'remote://db1/docs/a.txt', isDirectory: false,
    })
    await h.api.dispose()
  })

  it('routes a onedrive profile to the OneDrive client', async () => {
    const h = harness({ ...dropboxRecord, id: 'od1', kind: 'onedrive' },
      { OneDriveClientCtor: Ctor })
    await h.call('remote-list-dir', { profileId: 'od1' })
    expect(listed).toEqual(['.'])
    await h.api.dispose()
  })

  it('reads a file through the same session', async () => {
    const h = harness(dropboxRecord, { DropboxClientCtor: Ctor })
    const out = await h.call('remote-read-file', { profileId: 'db1', path: '/docs/a.txt' })
    expect(Buffer.from(out.base64, 'base64').toString()).toBe('abc')
    await h.api.dispose()
  })

  it('uses the stored refresh token without opening a browser', async () => {
    let opened = 0
    const h = harness(dropboxRecord, {
      DropboxClientCtor: Ctor,
      openExternal: async () => { opened++ },
      oauthModule: {
        authorize: async () => { throw new Error('should not authorize') },
        TokenManager: class {
          constructor(opts) { this.opts = opts }
          async getAccessToken() { return 'at' }
        },
      },
    })
    await h.call('remote-list-dir', { profileId: 'db1' })
    expect(opened).toBe(0)
    await h.api.dispose()
  })

  it('authorizes once when no token is stored, and saves what comes back', async () => {
    let authorized = 0
    const h = harness({ ...dropboxRecord, encryptedSecret: undefined }, {
      DropboxClientCtor: Ctor,
      openExternal: async () => {},
      oauthModule: {
        authorize: async (opts) => {
          authorized++
          expect(opts.clientId).toBe('app-key-123')
          expect(typeof opts.openExternal).toBe('function')
          return { accessToken: 'at', refreshToken: 'brand-new', expiresAt: 0 }
        },
        TokenManager: class {
          constructor(opts) { this.opts = opts }
          async getAccessToken() { return 'at' }
        },
      },
    })
    await h.call('remote-list-dir', { profileId: 'db1' })
    expect(authorized).toBe(1)
    // Persisted encrypted, never in the clear.
    const saved = h.savedProfile()
    expect(saved.encryptedSecret).toBe(Buffer.from('enc:brand-new').toString('base64'))
    expect(JSON.stringify(saved)).not.toContain('brand-new')

    // A second call reuses the live session rather than authorizing again.
    await h.call('remote-list-dir', { profileId: 'db1' })
    expect(authorized).toBe(1)
    await h.api.dispose()
  })

  it('persists a rotated refresh token', async () => {
    /** @type {Function|undefined} */
    let onTokensChanged
    const h = harness(dropboxRecord, {
      DropboxClientCtor: Ctor,
      oauthModule: {
        authorize: async () => ({}),
        TokenManager: class {
          constructor(opts) { onTokensChanged = opts.onTokensChanged }
          async getAccessToken() { return 'at' }
        },
      },
    })
    await h.call('remote-list-dir', { profileId: 'db1' })
    await onTokensChanged({ refreshToken: 'rotated' })
    expect(h.savedProfile().encryptedSecret)
      .toBe(Buffer.from('enc:rotated').toString('base64'))
    await h.api.dispose()
  })

  it('refuses to save a cloud profile with no client ID, quoting where to get one', async () => {
    // The user has a registration step to do, not a typo to fix, so the error
    // is the instructions.
    const h = harness(dropboxRecord, { DropboxClientCtor: Ctor })
    await expect(h.call('remote-save-profile', {
      name: 'No key', kind: 'dropbox',
    })).rejects.toThrow(/client ID[\s\S]*dropbox\.com\/developers/)
    await h.api.dispose()
  })

  it('skips a hand-edited profile that lost its client ID, rather than half-connecting', async () => {
    const h = harness({ ...dropboxRecord, clientId: '' }, { DropboxClientCtor: Ctor })
    expect(await h.call('remote-list-profiles')).toEqual([])
    await h.api.dispose()
  })

  it('clears a dead token and asks for re-authorization instead of failing silently', async () => {
    const dead = Object.assign(new Error('儲存的授權已失效'), { code: 'reauthorize' })
    const h = harness(dropboxRecord, {
      DropboxClientCtor: function () {
        return { list: async () => { throw dead }, close: async () => {} }
      },
      oauthModule: {
        authorize: async () => ({ refreshToken: 'x' }),
        TokenManager: class {
          async getAccessToken() { return 'at' }
        },
      },
    })
    await expect(h.call('remote-list-dir', { profileId: 'db1' }))
      .rejects.toThrow(/重新授權/)
    // The dead token must be gone, or every later call repeats the same
    // failure with the same useless token.
    expect(h.savedProfile().encryptedSecret).toBeUndefined()
    await h.api.dispose()
  })
})
