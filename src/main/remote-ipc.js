/**
 * @file remote-ipc.js
 * @description IPC surface for remote connections.
 *
 *   NETWORK BOUNDARY. Everything reachable from here talks to a server the
 *   user nominated, and `readRemoteFile` brings remote bytes into the app.
 *   Nothing here connects on its own: a profile has to exist, with credentials
 *   the user supplied, and a renderer call has to name it. That is the consent
 *   step — the app never reaches the network as a side effect of anything else.
 *
 *   Sessions are held open between calls because the folder view asks for one
 *   directory at a time and re-authenticating per level would be both slow and
 *   rude to the server.
 */

import { join } from 'path'

/** Idle sessions are dropped so a forgotten connection does not sit open. */
const SESSION_IDLE_MS = 5 * 60 * 1000

/** Ceiling on concurrently open remote sessions. */
const MAX_SESSIONS = 8

/**
 * @typedef {object} RemoteDeps
 * @property {import('electron').IpcMain} ipcMain
 * @property {() => string} userDataPath
 * @property {object} fs                 fs/promises-like
 * @property {object} [crypto]           Electron safeStorage, or a stand-in
 * @property {Function} [FtpClientCtor]
 * @property {Function} [S3ClientCtor]
 */

/**
 * Register the remote IPC handlers.
 *
 * Dependencies are injected so the whole surface can be driven in tests
 * without Electron and without a network.
 *
 * @param {RemoteDeps} deps
 * @returns {{ dispose: () => Promise<void> }}
 */
export function registerRemoteIpc(deps) {
  const { ipcMain, userDataPath, fs } = deps

  /** @type {Map<string, { client: object, kind: string, timer: NodeJS.Timeout }>} */
  const sessions = new Map()
  /** @type {ReturnType<typeof import('./remote-profiles.js').createProfileStore>|null} */
  let store = null

  async function getStore() {
    if (store) return store
    const { createProfileStore } = await import('./remote-profiles.js')
    store = createProfileStore({
      filePath: join(userDataPath(), 'remote-profiles.json'),
      fs,
      crypto: deps.crypto,
    })
    await store.load()
    return store
  }

  /** @param {string} id */
  function touchSession(id) {
    const s = sessions.get(id)
    if (!s) return
    clearTimeout(s.timer)
    s.timer = setTimeout(() => void closeSession(id), SESSION_IDLE_MS)
  }

  /** @param {string} id */
  async function closeSession(id) {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    clearTimeout(s.timer)
    try {
      await s.client.close?.()
    } catch {
      // A server that has already gone away is not an error worth surfacing.
    }
  }

  /**
   * Open, or reuse, a session for a profile.
   *
   * @param {string} profileId
   * @param {string} [secret] supplied per-call when the password was not saved
   */
  async function openSession(profileId, secret) {
    const existing = sessions.get(profileId)
    if (existing) {
      touchSession(profileId)
      return existing
    }
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error('已開啟的遠端連線過多，請先關閉部分連線')
    }

    const s = await getStore()
    const profile = s.get(profileId)
    if (!profile) throw new Error('找不到該連線設定')

    const password = secret ?? profile.secret
    let client
    if (profile.kind === 's3') {
      const { S3Client } = deps.S3ClientCtor
        ? { S3Client: deps.S3ClientCtor }
        : await import('./remote-s3.js')
      client = new S3Client({
        bucket: profile.bucket,
        region: profile.region,
        accessKeyId: profile.user,
        secretAccessKey: password,
        pathStyle: profile.pathStyle,
      })
    } else {
      const { FtpClient } = deps.FtpClientCtor
        ? { FtpClient: deps.FtpClientCtor }
        : await import('./remote-ftp.js')
      client = new FtpClient({
        host: profile.host,
        port: profile.port,
        user: profile.user,
        password,
        secure: profile.kind === 'ftps',
      })
      await client.connect()
    }

    const entry = {
      client,
      kind: profile.kind,
      timer: setTimeout(() => void closeSession(profileId), SESSION_IDLE_MS),
    }
    sessions.set(profileId, entry)
    return entry
  }

  /**
   * Present a remote listing in the shape the folder view already consumes.
   *
   * Paths carry a `remote://` scheme so they can never be mistaken for local
   * ones: the path validator rejects them outright, which is what stops a
   * remote name from reaching a filesystem handler.
   *
   * @param {string} profileId
   * @param {object} entry
   * @param {string} dir
   */
  function toRow(profileId, entry, dir) {
    const rel = dir ? `${dir.replace(/\/+$/, '')}/${entry.name}` : entry.name
    return {
      name: entry.name,
      path: `remote://${profileId}/${rel.replace(/^\/+/, '')}`,
      isDirectory: Boolean(entry.isDirectory),
      size: entry.size ?? 0,
      mtime: entry.mtime instanceof Date
        ? entry.mtime.toISOString()
        : (entry.mtime ?? new Date(0).toISOString()),
    }
  }

  const handlers = {
    /** Profiles the renderer may display — never carries a password. */
    'remote-list-profiles': async () => {
      const s = await getStore()
      return s.listRedacted()
    },

    /** @param {object} profile */
    'remote-save-profile': async (_e, profile) => {
      const s = await getStore()
      const saved = await s.upsert(profile)
      return saved
    },

    /** @param {string} id */
    'remote-delete-profile': async (_e, id) => {
      const s = await getStore()
      await closeSession(id)
      return s.remove?.(id) ?? null
    },

    /**
     * Connect and list one directory. This is the point at which the app
     * first touches the network for a given profile.
     */
    'remote-list-dir': async (_e, { profileId, dir = '', secret } = {}) => {
      const { client, kind } = await openSession(profileId, secret)
      touchSession(profileId)

      if (kind === 's3') {
        const prefix = dir ? `${dir.replace(/^\/+/, '').replace(/\/*$/, '/')}` : ''
        const page = await client.listObjects({ prefix, delimiter: '/' })
        const rows = [
          ...page.commonPrefixes.map((p) =>
            toRow(profileId, { name: p.name, isDirectory: true }, dir)),
          ...page.objects
            .filter((o) => !o.unsafe && o.key !== prefix)
            .map((o) => toRow(profileId, {
              name: o.key.slice(prefix.length),
              size: o.size,
              mtime: o.lastModified,
            }, dir)),
        ]
        return rows.filter((r) => r.name && !r.name.includes('/'))
      }

      const entries = await client.list(dir || '.')
      return entries.map((e) => toRow(profileId, e, dir))
    },

    /**
     * Fetch a remote file's bytes.
     *
     * Returned as base64 to match the existing binary IPC convention, and
     * bounded so a large remote file cannot be pulled into the renderer whole.
     */
    'remote-read-file': async (_e, { profileId, path, maxBytes, secret } = {}) => {
      const { client, kind } = await openSession(profileId, secret)
      touchSession(profileId)
      const limit = Math.min(maxBytes ?? 10_485_760, 67_108_864)
      const data = kind === 's3'
        ? await client.getObject(path, { maxBytes: limit })
        : await client.download(path, { maxBytes: limit })
      return { path, base64: Buffer.from(data).toString('base64'), size: data.length }
    },

    /** Drop a session without waiting for the idle timer. */
    'remote-disconnect': async (_e, profileId) => {
      await closeSession(profileId)
      return true
    },
  }

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, fn)
  }

  return {
    async dispose() {
      for (const id of [...sessions.keys()]) await closeSession(id)
      for (const channel of Object.keys(handlers)) {
        ipcMain.removeHandler?.(channel)
      }
    },
  }
}
