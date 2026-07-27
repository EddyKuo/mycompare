/**
 * @file remote-onedrive.js
 * @description Read-only OneDrive client over Microsoft Graph v1.0:
 *   `/me/drive/root/children`, `/me/drive/items/{id}/children`, path-addressed
 *   children, and downloads through the `@microsoft.graph.downloadUrl` a item
 *   carries. Node's `https` only — no SDK, no new dependencies.
 *
 * ⚠️ PRIVACY / NETWORK EGRESS WARNING
 *   Every call sends an OAuth access token to **Microsoft** and brings the
 *   user's file names and **file contents** back over the network. Listing a
 *   folder discloses what the user is browsing; comparing a file downloads it
 *   in full. Nothing here connects until the user creates a profile, authorizes
 *   it in their browser, and asks for a listing.
 *
 * Scope
 *   Read-only. No upload, no delete, no move — a bug in this file cannot damage
 *   a user's drive.
 *
 * Download URLs
 *   `@microsoft.graph.downloadUrl` is a short-lived pre-authenticated URL on a
 *   different host. The bearer token is deliberately **not** sent to it: the
 *   URL already carries its own authorization, and forwarding a Graph token to
 *   whatever host Microsoft names would hand full drive access to that host if
 *   the value were ever wrong. Only https URLs are followed, and only a couple
 *   of redirects.
 *
 * Trust
 *   Item names come from a remote server. Each is checked with
 *   `isSafeRemoteName` and dropped if it could act as a path.
 */

import {
  httpsRequestBounded,
  requestJson,
  OAuthError,
  DEFAULT_TIMEOUT_MS,
} from './oauth.js'
import { isSafeRemoteName, normaliseRemotePath } from './remote-ftp.js'

/** Endpoints and scopes for the authorization flow. */
export const ONEDRIVE_OAUTH = Object.freeze({
  // `common` covers both personal Microsoft accounts and work/school ones; a
  // tenant-specific authority would lock out half of the users.
  authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  // Read-only delegated scopes. `offline_access` is what makes Microsoft issue
  // a refresh token; without it the user re-authorizes every hour.
  scope: 'offline_access User.Read Files.Read Files.Read.All',
})

/** Shown when a profile has no client ID. */
export const ONEDRIVE_CLIENT_ID_HELP =
  'OneDrive 需要你自己註冊的 Microsoft 應用程式 client ID（Beyond Compare 用的是它自己的，任何複製品都必須用自己的）。\n' +
  '取得方式：登入 https://portal.azure.com → Microsoft Entra ID → App registrations → New registration，\n' +
  'Supported account types 選「Accounts in any organizational directory and personal Microsoft accounts」，\n' +
  'Redirect URI 選 Public client/native，填 http://127.0.0.1:53682/callback（登錄後任何 127.0.0.1 連接埠都可用）。\n' +
  '建立後在 API permissions 加入 Microsoft Graph 委派權限 User.Read、Files.Read、Files.Read.All、offline_access，\n' +
  '最後把 Overview 頁的 Application (client) ID 填進這個連線設定的 client ID 欄位。用戶端密碼不需要，也不要填。'

/** Graph service root. */
export const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0'

/** Hard ceiling on one download. */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

/** Hard ceiling on one Graph JSON response. */
export const MAX_JSON_BYTES = 16 * 1024 * 1024

/** Bound on `@odata.nextLink` following. */
export const MAX_LIST_PAGES = 50

/** Items per page. */
export const LIST_PAGE_SIZE = 200

/** A pre-authenticated download URL may redirect, but not indefinitely. */
export const MAX_REDIRECTS = 3

/**
 * Build the children URL for a folder path.
 *
 * Graph addresses a path with the `root:/{path}:` form, and the root itself
 * only as `root` — `root:/:` is a 400. `..` is resolved lexically first so a
 * constructed path cannot climb above the drive root.
 *
 * @param {string} dir
 * @returns {string}
 */
export function childrenUrlForPath(dir) {
  const norm = normaliseRemotePath(typeof dir === 'string' && dir !== '.' ? dir : '')
  if (norm === '/') return `${GRAPH_ROOT}/me/drive/root/children?$top=${LIST_PAGE_SIZE}`
  return `${GRAPH_ROOT}/me/drive/root:${encodeGraphPath(norm)}:/children?$top=${LIST_PAGE_SIZE}`
}

/**
 * Build the children URL for an item id.
 *
 * @param {string} id
 * @returns {string}
 */
export function childrenUrlForId(id) {
  if (!isSafeItemId(id)) throw new Error(`Unsafe OneDrive item id: ${JSON.stringify(id)}`)
  return `${GRAPH_ROOT}/me/drive/items/${encodeURIComponent(id)}/children?$top=${LIST_PAGE_SIZE}`
}

/**
 * Item metadata by path.
 *
 * @param {string} path
 * @returns {string}
 */
export function itemUrlForPath(path) {
  const norm = normaliseRemotePath(path)
  if (norm === '/') return `${GRAPH_ROOT}/me/drive/root`
  return `${GRAPH_ROOT}/me/drive/root:${encodeGraphPath(norm)}`
}

/**
 * Percent-encode a path for Graph while keeping the separators.
 *
 * @param {string} p an already-normalised absolute path
 * @returns {string}
 */
export function encodeGraphPath(p) {
  return p.split('/').map((seg) => encodeURIComponent(seg)).join('/')
}

/**
 * An item id is interpolated into a URL, so it is constrained rather than
 * trusted: Graph ids are an opaque alphanumeric-ish token, and anything with a
 * slash or a control character in it is not one.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isSafeItemId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    && /^[A-Za-z0-9!._~%+=$-]+$/.test(id)
}

/**
 * @typedef {object} RemoteEntry
 * @property {string} name
 * @property {boolean} isDirectory
 * @property {number} size
 * @property {Date|null} mtime
 * @property {string} id
 */

/**
 * Map one driveItem, or null when the name cannot safely be used.
 *
 * @param {Record<string, unknown>} raw
 * @returns {RemoteEntry|null}
 */
export function mapDriveItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (!isSafeRemoteName(name)) return null
  const isDirectory = Boolean(raw.folder)
  const modified = typeof raw.lastModifiedDateTime === 'string'
    ? new Date(raw.lastModifiedDateTime)
    : null
  return {
    name,
    isDirectory,
    size: isDirectory ? 0 : (Number(raw.size) || 0),
    mtime: modified && !Number.isNaN(modified.getTime()) ? modified : null,
    id: typeof raw.id === 'string' ? raw.id : '',
  }
}

/**
 * Turn a Graph error body into something a user can act on.
 *
 * @param {{status: number, json: object|null, body: Buffer}} res
 * @returns {Error}
 */
export function graphError(res) {
  const j = /** @type {{error?: {code?: string, message?: string}}} */ (res.json ?? {})
  const code = j.error?.code ?? `HTTP ${res.status}`
  const message = j.error?.message ?? res.body.toString('utf-8').slice(0, 200)
  if (res.status === 401) {
    return new OAuthError(`OneDrive 拒絕了這個授權，請重新授權（${code}）`, 'reauthorize')
  }
  if (res.status === 403) {
    return new Error(`OneDrive 拒絕存取（${code}）：${message}。` +
      '請確認註冊的應用程式已取得 Files.Read 權限並經過同意。')
  }
  if (res.status === 404) return new Error(`OneDrive 找不到該項目（${code}）`)
  if (res.status === 429) {
    const retry = res.headers?.['retry-after']
    return new Error(`OneDrive 要求稍後再試${retry ? `（${retry} 秒後）` : ''}`)
  }
  return new Error(`Microsoft Graph 失敗（${res.status} ${code}）：${message}`)
}

/**
 * Read-only OneDrive client.
 */
export class OneDriveClient {
  /**
   * @param {object} opts
   * @param {() => Promise<string>} opts.getAccessToken
   * @param {Function} [opts.requestFn]      `https.request` replacement
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxDownloadBytes]
   * @param {number} [opts.maxPages]
   */
  constructor(opts) {
    if (typeof opts?.getAccessToken !== 'function') {
      throw new Error('OneDriveClient requires getAccessToken')
    }
    this.getAccessToken = opts.getAccessToken
    this.requestFn = opts.requestFn
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxDownloadBytes = Math.min(opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_BYTES)
    this.maxPages = opts.maxPages ?? MAX_LIST_PAGES
  }

  /**
   * @param {string} url
   * @returns {Promise<Record<string, unknown>>}
   */
  async _get(url) {
    const token = await this.getAccessToken()
    const res = await requestJson({
      url,
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      maxBytes: MAX_JSON_BYTES,
      timeoutMs: this.timeoutMs,
      requestFn: this.requestFn,
    })
    if (res.status < 200 || res.status >= 300) throw graphError(res)
    return /** @type {Record<string, unknown>} */ (res.json ?? {})
  }

  /**
   * Walk `@odata.nextLink` to the end of a collection.
   *
   * @param {string} url
   * @returns {Promise<{entries: RemoteEntry[], skipped: string[], truncated: boolean}>}
   */
  async _listPages(url) {
    /** @type {RemoteEntry[]} */
    const entries = []
    /** @type {string[]} */
    const skipped = []
    let next = url
    for (let page = 0; page < this.maxPages; page++) {
      const body = await this._get(next)
      for (const raw of Array.isArray(body.value) ? body.value : []) {
        const mapped = mapDriveItem(raw)
        if (mapped) entries.push(mapped)
        // Reported rather than silently missing, so a comparison cannot look
        // complete when it is not.
        else skipped.push(String(raw?.name ?? '?'))
      }
      const link = body['@odata.nextLink']
      if (typeof link !== 'string' || link === '') {
        return { entries, skipped, truncated: false }
      }
      next = link
    }
    return { entries, skipped, truncated: true }
  }

  /**
   * List a folder by path.
   *
   * @param {string} dir
   * @returns {Promise<{entries: RemoteEntry[], skipped: string[], truncated: boolean}>}
   */
  async list(dir) {
    return this._listPages(childrenUrlForPath(dir))
  }

  /**
   * List a folder by item id.
   *
   * @param {string} id
   * @returns {Promise<{entries: RemoteEntry[], skipped: string[], truncated: boolean}>}
   */
  async listById(id) {
    return this._listPages(childrenUrlForId(id))
  }

  /**
   * Download one file.
   *
   * @param {string} path
   * @param {{maxBytes?: number}} [opts]
   * @returns {Promise<Buffer>}
   */
  async download(path, opts = {}) {
    // A per-call limit may lower the ceiling but never raise it.
    const limit = Math.min(opts.maxBytes ?? this.maxDownloadBytes, this.maxDownloadBytes)
    const item = await this._get(itemUrlForPath(path))
    if (item.folder) throw new Error('無法下載資料夾')
    const url = item['@microsoft.graph.downloadUrl']
    if (typeof url !== 'string' || url === '') {
      throw new Error('OneDrive 沒有為這個項目提供下載網址')
    }
    const declared = Number(item.size)
    if (Number.isFinite(declared) && declared > limit) {
      // Refuse before transferring anything rather than after burning the
      // bandwidth on a file that will be rejected at the limit anyway.
      throw new Error(`檔案大小 ${declared} bytes 超過 ${limit} bytes 上限`)
    }
    return this._fetchContent(url, limit, MAX_REDIRECTS)
  }

  /**
   * Fetch a pre-authenticated URL, following a bounded number of redirects.
   *
   * No Authorization header: see the note at the top of this file.
   *
   * @param {string} url
   * @param {number} limit
   * @param {number} redirectsLeft
   * @returns {Promise<Buffer>}
   */
  async _fetchContent(url, limit, redirectsLeft) {
    const res = await httpsRequestBounded({
      url,
      method: 'GET',
      maxBytes: limit,
      timeoutMs: this.timeoutMs,
      requestFn: this.requestFn,
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.location
      if (!location || redirectsLeft <= 0) {
        throw new Error(`OneDrive 下載被重新導向但無法追隨（${res.status}）`)
      }
      // `httpsRequestBounded` rejects anything that is not https, so a
      // downgrade to http cannot happen here either.
      return this._fetchContent(new URL(location, url).toString(), limit, redirectsLeft - 1)
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`OneDrive 下載失敗（HTTP ${res.status}）`)
    }
    return res.body
  }

  /** HTTP keeps nothing open between calls; present for interface symmetry. */
  async close() {}
}
