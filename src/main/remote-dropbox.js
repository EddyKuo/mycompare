/**
 * @file remote-dropbox.js
 * @description Read-only Dropbox client over the public HTTP API v2:
 *   `files/list_folder`, `files/list_folder/continue`, `files/download`. Node's
 *   `https` only, no SDK — the project forbids new npm dependencies and this is
 *   three JSON endpoints.
 *
 * ⚠️ PRIVACY / NETWORK EGRESS WARNING
 *   Every call here sends an OAuth access token to **Dropbox** and brings the
 *   user's file names and **file contents** back over the network. Browsing a
 *   folder tells Dropbox what the user is looking at; comparing a file
 *   downloads it in full. Nothing connects until the user creates a profile,
 *   authorizes it in their browser, and asks for a listing.
 *
 * Scope
 *   Read-only on purpose. `files/upload`, `files/delete_v2` and `files/move_v2`
 *   are not implemented, so no bug in this file can damage a user's Dropbox.
 *
 * Trust
 *   Names in a listing come from a remote server and are treated as hostile
 *   input: every one goes through `isSafeRemoteName`, and anything that could
 *   act as a path (a separator, `..`, a control character, a Windows drive
 *   prefix) is dropped from the listing rather than sanitised into something
 *   that looks fine and points elsewhere.
 */

import {
  httpsRequestBounded,
  requestJson,
  OAuthError,
  DEFAULT_TIMEOUT_MS,
} from './oauth.js'
import { isSafeRemoteName, normaliseRemotePath } from './remote-ftp.js'

/** Endpoints and scopes for the authorization flow. */
export const DROPBOX_OAUTH = Object.freeze({
  authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  // Read-only scopes. Asking for write access we never use would be asking the
  // user to accept a risk the application does not take.
  scope: 'account_info.read files.metadata.read files.content.read',
  // Without `offline` Dropbox issues a short-lived access token and no refresh
  // token, so the user would re-authorize every four hours.
  extraAuthParams: Object.freeze({ token_access_type: 'offline' }),
})

/** Shown when a profile has no client ID. */
export const DROPBOX_CLIENT_ID_HELP =
  'Dropbox 需要你自己註冊的應用程式 client ID（Beyond Compare 用的是它自己的，任何複製品都必須用自己的）。\n' +
  '取得方式：登入 https://www.dropbox.com/developers/apps → Create app → ' +
  '選 Scoped access → Full Dropbox 或 App folder → 命名後建立。\n' +
  '接著在 Permissions 分頁勾選 account_info.read、files.metadata.read、files.content.read 並儲存，\n' +
  '在 Settings 分頁的 Redirect URIs 加入 http://127.0.0.1:53682/callback（Dropbox 需要完全相同的網址，含連接埠），\n' +
  '最後把 Settings 分頁上的 App key 填進這個連線設定的 client ID 欄位。App secret 不需要，也不要填。'

/** Hard ceiling on one download, so a huge file cannot exhaust RAM. */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

/** Hard ceiling on one metadata response. */
export const MAX_JSON_BYTES = 16 * 1024 * 1024

/** A folder with more entries than this is not something the UI can show. */
export const MAX_LIST_PAGES = 50

/** Entries per page; Dropbox's own maximum is 2000. */
export const LIST_PAGE_SIZE = 1000

/**
 * Convert an app-side path into the form the Dropbox API wants.
 *
 * The root is the empty string, not `/` — Dropbox rejects `/` with
 * `malformed_path`. `..` is resolved lexically first so a path assembled from
 * user input cannot address a parent of the account root.
 *
 * @param {string} p
 * @returns {string}
 */
export function toDropboxPath(p) {
  const norm = normaliseRemotePath(typeof p === 'string' && p !== '.' ? p : '')
  return norm === '/' ? '' : norm
}

/**
 * JSON restricted to ASCII.
 *
 * `Dropbox-API-Arg` is an HTTP header, and a header value must be ISO-8859-1;
 * a path with a Chinese or accented character in it would otherwise be either
 * mangled or rejected by the HTTP stack. Dropbox documents `\uXXXX` escaping as
 * the fix.
 *
 * @param {object} value
 * @returns {string}
 */
export function asciiHeaderJson(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * @typedef {object} RemoteEntry
 * @property {string} name
 * @property {boolean} isDirectory
 * @property {number} size
 * @property {Date|null} mtime
 */

/**
 * Map one `list_folder` entry, or null when its name is not safe to use.
 *
 * @param {Record<string, unknown>} raw
 * @returns {RemoteEntry|null}
 */
export function mapDropboxEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (!isSafeRemoteName(name)) return null
  const tag = raw['.tag']
  if (tag === 'deleted') return null
  const isDirectory = tag === 'folder'
  const modified = typeof raw.server_modified === 'string' ? new Date(raw.server_modified) : null
  return {
    name,
    isDirectory,
    size: isDirectory ? 0 : (Number(raw.size) || 0),
    mtime: modified && !Number.isNaN(modified.getTime()) ? modified : null,
  }
}

/**
 * Turn an API error body into something a user can act on.
 *
 * @param {{status: number, json: object|null, body: Buffer}} res
 * @returns {Error}
 */
export function dropboxError(res) {
  const j = /** @type {Record<string, unknown>} */ (res.json ?? {})
  const summary = typeof j.error_summary === 'string'
    ? j.error_summary
    : res.body.toString('utf-8').slice(0, 200)
  if (res.status === 401) {
    // The token was revoked or expired past refreshing. Say so plainly instead
    // of showing "401" and letting the user guess.
    return new OAuthError(`Dropbox 拒絕了這個授權，請重新授權（${summary}）`, 'reauthorize')
  }
  if (res.status === 429) {
    const retry = res.headers?.['retry-after']
    return new Error(`Dropbox 要求稍後再試${retry ? `（${retry} 秒後）` : ''}`)
  }
  if (res.status === 409 && /not_found/.test(summary)) {
    return new Error(`Dropbox 找不到該路徑：${summary}`)
  }
  return new Error(`Dropbox API 失敗（${res.status}）：${summary}`)
}

/**
 * Read-only Dropbox client.
 *
 * The access token is obtained through `getAccessToken` — normally an
 * `oauth.js` `TokenManager` — so a token that expires mid-listing is refreshed
 * transparently and this class never touches storage.
 */
export class DropboxClient {
  /**
   * @param {object} opts
   * @param {() => Promise<string>} opts.getAccessToken
   * @param {Function} [opts.requestFn]        `https.request` replacement
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxDownloadBytes]
   * @param {number} [opts.maxPages]
   */
  constructor(opts) {
    if (typeof opts?.getAccessToken !== 'function') {
      throw new Error('DropboxClient requires getAccessToken')
    }
    this.getAccessToken = opts.getAccessToken
    this.requestFn = opts.requestFn
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxDownloadBytes = Math.min(opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_BYTES)
    this.maxPages = opts.maxPages ?? MAX_LIST_PAGES
  }

  /**
   * @param {string} url
   * @param {object} body
   * @returns {Promise<Record<string, unknown>>}
   */
  async _rpc(url, body) {
    const token = await this.getAccessToken()
    const res = await requestJson({
      url,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      maxBytes: MAX_JSON_BYTES,
      timeoutMs: this.timeoutMs,
      requestFn: this.requestFn,
    })
    if (res.status < 200 || res.status >= 300) throw dropboxError(res)
    return /** @type {Record<string, unknown>} */ (res.json ?? {})
  }

  /**
   * List one folder, following `has_more` to the end.
   *
   * @param {string} dir
   * @returns {Promise<{entries: RemoteEntry[], skipped: string[], truncated: boolean}>}
   */
  async list(dir) {
    /** @type {RemoteEntry[]} */
    const entries = []
    /** @type {string[]} */
    const skipped = []
    /** @type {string} */
    let cursor = ''
    for (let i = 0; i < this.maxPages; i++) {
      // `maxPages` counts requests, including the first: a folder that never
      // stops paginating must cost a bounded number of round trips, not one
      // more than the bound.
      const page = cursor
        ? await this._rpc('https://api.dropboxapi.com/2/files/list_folder/continue', { cursor })
        : await this._rpc('https://api.dropboxapi.com/2/files/list_folder', {
          path: toDropboxPath(dir),
          recursive: false,
          limit: LIST_PAGE_SIZE,
          include_deleted: false,
          include_media_info: false,
        })

      for (const raw of Array.isArray(page.entries) ? page.entries : []) {
        const mapped = mapDropboxEntry(raw)
        if (mapped) entries.push(mapped)
        // A name that cannot be used is reported rather than silently missing:
        // a user comparing folders needs to know something was left out.
        else if (raw?.['.tag'] !== 'deleted') skipped.push(String(raw?.name ?? '?'))
      }
      if (!page.has_more || typeof page.cursor !== 'string' || page.cursor === '') {
        return { entries, skipped, truncated: false }
      }
      cursor = page.cursor
    }
    return { entries, skipped, truncated: true }
  }

  /**
   * Download one file.
   *
   * @param {string} path
   * @param {{maxBytes?: number}} [opts]
   * @returns {Promise<Buffer>}
   */
  async download(path, opts = {}) {
    const target = toDropboxPath(path)
    if (!target) throw new Error('download requires a file path')
    // A per-call limit may lower the ceiling but never raise it.
    const limit = Math.min(opts.maxBytes ?? this.maxDownloadBytes, this.maxDownloadBytes)
    const token = await this.getAccessToken()
    const res = await httpsRequestBounded({
      url: 'https://content.dropboxapi.com/2/files/download',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': asciiHeaderJson({ path: target }),
      },
      maxBytes: limit,
      timeoutMs: this.timeoutMs,
      requestFn: this.requestFn,
    })
    if (res.status < 200 || res.status >= 300) {
      let json = null
      try {
        json = JSON.parse(res.body.toString('utf-8'))
      } catch {
        json = null
      }
      throw dropboxError({ ...res, json })
    }
    return res.body
  }

  /**
   * Present for symmetry with the socket-based clients, which `remote-ipc`
   * closes on session teardown. HTTP keeps nothing open between calls.
   */
  async close() {}
}
