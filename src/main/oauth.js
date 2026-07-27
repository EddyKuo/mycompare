/**
 * @file oauth.js
 * @description OAuth 2.0 authorization-code flow with PKCE (RFC 7636), for the
 *   cloud-drive remotes (Dropbox, OneDrive). Built on Node's `https`/`http`
 *   only — no new dependencies.
 *
 * ⚠️ PRIVACY / NETWORK EGRESS WARNING
 *   This module exists to obtain a token that lets the application read a
 *   user's cloud drive. Every module built on it sends request metadata to, and
 *   downloads **the user's file contents** from, a third-party server (Dropbox
 *   or Microsoft). Nothing here runs on its own: a profile must exist and the
 *   renderer must ask. The UI has to say so before the first authorization.
 *
 * ## Why the system browser, not a BrowserWindow
 *
 * The sign-in page is loaded with `shell.openExternal`, never in an
 * application-controlled `BrowserWindow`. A window we own can read the DOM of
 * the page inside it, which means it can read the user's password and their
 * second factor as they are typed. Handing the page to the OS browser makes
 * that impossible by construction, and lets the user see the real address bar
 * and their existing session. `openExternal` is injected rather than imported
 * so this file stays testable outside Electron.
 *
 * ## Why PKCE and `state`
 *
 * A desktop application cannot keep a client secret — it ships on the user's
 * disk — so it is a *public* client and the code alone must not be enough to
 * get a token. PKCE binds the code to a `code_verifier` only this process ever
 * held. `state` is a separate defence: the loopback listener accepts a plain
 * HTTP GET from anything on the machine, so without checking `state` any local
 * page could feed us an attacker's authorization code and silently attach the
 * attacker's drive to the user's session. Both are generated from
 * `crypto.randomBytes` and `state` is compared with a length-safe equality.
 *
 * ## Refresh tokens at rest
 *
 * A refresh token is a long-lived credential; it is treated exactly like the
 * passwords in `remote-profiles.js` — encrypted through Electron `safeStorage`
 * or **not stored at all**. This module never writes anything; it hands the
 * token set to its caller, which persists it as a profile secret. When it
 * cannot be encrypted the user re-authorizes each session, which is the honest
 * outcome. Plaintext is never an option.
 */

import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'crypto'
import { request as httpsRequest } from 'https'
import { createServer as nodeCreateServer } from 'http'

/** Every network wait is bounded. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** A token endpoint answers with a small JSON document or it is lying. */
export const MAX_TOKEN_RESPONSE_BYTES = 256 * 1024

/** How long the loopback listener waits for the user to finish signing in. */
export const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60 * 1000

/** Refresh this far before the stated expiry, to cover clock skew and latency. */
export const REFRESH_SKEW_MS = 60_000

/**
 * Ports tried before falling back to a random one.
 *
 * Dropbox matches redirect URIs exactly, port included, so a purely random port
 * could never be registered. These are tried first so a user can register one
 * URI and have it work; the random fallback keeps things working when the port
 * is busy (for providers such as Microsoft that allow any loopback port).
 */
export const PREFERRED_LOOPBACK_PORTS = Object.freeze([53682, 53683, 53684])

/** Path the loopback listener answers on; anything else gets a 404. */
export const REDIRECT_PATH = '/callback'

/**
 * @typedef {object} TokenSet
 * @property {string} accessToken
 * @property {string} refreshToken   '' when the provider issued none
 * @property {number} expiresAt      epoch ms; 0 when the provider said nothing
 * @property {string} scope
 * @property {string} tokenType
 */

/**
 * An OAuth failure with a machine-readable cause, so callers can tell "ask the
 * user to sign in again" apart from "the network is down" instead of showing
 * one generic message for both.
 */
export class OAuthError extends Error {
  /**
   * @param {string} message
   * @param {'denied'|'state_mismatch'|'timeout'|'reauthorize'|'http'|'config'} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'OAuthError'
    this.code = code
  }
}

// ── PKCE primitives ────────────────────────────────────────────────────────

/**
 * base64url per RFC 4648 §5: no padding, `-` and `_` for `+` and `/`.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
export function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * A `code_verifier`: 43–128 characters from the unreserved set. 32 random bytes
 * base64url-encode to 43 characters, the minimum length the RFC allows, and
 * carry the full 256 bits of entropy.
 *
 * @param {(n: number) => Buffer} [randomBytesFn]
 * @returns {string}
 */
export function createCodeVerifier(randomBytesFn = nodeRandomBytes) {
  return base64UrlEncode(randomBytesFn(32))
}

/**
 * The S256 challenge: `base64url(sha256(ascii(verifier)))`.
 *
 * `plain` is not offered. It would let anyone who intercepts the authorization
 * request replay it, which is the entire attack PKCE exists to stop.
 *
 * @param {string} verifier
 * @returns {string}
 */
export function codeChallengeS256(verifier) {
  return base64UrlEncode(createHash('sha256').update(verifier, 'ascii').digest())
}

/**
 * @param {(n: number) => Buffer} [randomBytesFn]
 * @returns {string}
 */
export function createState(randomBytesFn = nodeRandomBytes) {
  return base64UrlEncode(randomBytesFn(24))
}

/**
 * Compare two `state` values without leaking their contents through timing.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function statesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  // timingSafeEqual throws on a length mismatch, and a differing length is
  // already public information (it is the byte count, not the value).
  if (ba.length !== bb.length || ba.length === 0) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Build the URL the user's browser is sent to.
 *
 * @param {object} opts
 * @param {string} opts.authorizeUrl
 * @param {string} opts.clientId
 * @param {string} opts.redirectUri
 * @param {string} opts.state
 * @param {string} opts.codeChallenge
 * @param {string} [opts.scope]
 * @param {Record<string,string>} [opts.extraParams] provider-specific, e.g.
 *   Dropbox's `token_access_type=offline`
 * @returns {string}
 */
export function buildAuthorizeUrl(opts) {
  if (!opts?.authorizeUrl || !opts?.clientId) {
    throw new OAuthError('authorizeUrl and clientId are required', 'config')
  }
  const url = new URL(opts.authorizeUrl)
  const params = url.searchParams
  params.set('response_type', 'code')
  params.set('client_id', opts.clientId)
  params.set('redirect_uri', opts.redirectUri)
  params.set('state', opts.state)
  params.set('code_challenge', opts.codeChallenge)
  params.set('code_challenge_method', 'S256')
  if (opts.scope) params.set('scope', opts.scope)
  for (const [k, v] of Object.entries(opts.extraParams ?? {})) params.set(k, String(v))
  return url.toString()
}

// ── Bounded HTTP ───────────────────────────────────────────────────────────

/**
 * Perform one HTTPS request, collecting at most `maxBytes` and giving up after
 * `timeoutMs`.
 *
 * Shared with the cloud-drive clients: a token endpoint and a file endpoint
 * need exactly the same bounds, and one implementation means one place where
 * the limits can be wrong.
 *
 * @param {object} opts
 * @param {string} opts.url               must be https
 * @param {string} [opts.method]
 * @param {Record<string,string>} [opts.headers]
 * @param {string|Buffer} [opts.body]
 * @param {number} opts.maxBytes
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.requestFn]     `https.request` replacement, for tests
 * @returns {Promise<{status: number, headers: Record<string,string>, body: Buffer}>}
 */
export function httpsRequestBounded(opts) {
  const url = new URL(opts.url)
  if (url.protocol !== 'https:') {
    // Access tokens and file bytes would otherwise cross the network in clear
    // text. Refuse rather than quietly downgrade.
    throw new OAuthError(`Refusing a non-https request to ${url.protocol}//${url.host}`, 'config')
  }
  const requestFn = opts.requestFn ?? httpsRequest
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes
  const bodyBuf = opts.body == null
    ? null
    : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf-8'))

  /** @type {Record<string,string>} */
  const headers = { ...(opts.headers ?? {}) }
  if (bodyBuf) headers['content-length'] = String(bodyBuf.length)

  return new Promise((resolve, reject) => {
    let settled = false
    /**
     * @param {Function} fn
     * @param {unknown} value
     */
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    const req = requestFn(
      {
        method: opts.method ?? 'GET',
        host: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = []
        let total = 0
        res.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          total += buf.length
          if (total > maxBytes) {
            res.destroy?.()
            req.destroy?.()
            finish(reject, new OAuthError(
              `Response from ${url.host} exceeded ${maxBytes} bytes`, 'http'))
            return
          }
          chunks.push(buf)
        })
        res.on('error', (err) => finish(reject, err))
        res.on('end', () => finish(resolve, {
          status: res.statusCode ?? 0,
          headers: res.headers ?? {},
          body: Buffer.concat(chunks),
        }))
      },
    )

    req.on('error', (err) => finish(reject, err))
    req.setTimeout?.(timeoutMs, () => {
      const err = new OAuthError(`Request to ${url.host} timed out after ${timeoutMs}ms`, 'http')
      req.destroy?.(err)
      finish(reject, err)
    })
    if (bodyBuf) req.write?.(bodyBuf)
    req.end()
  })
}

/**
 * `httpsRequestBounded` plus JSON parsing.
 *
 * A non-JSON body is returned as text rather than thrown on, because provider
 * errors are frequently HTML from a load balancer and the status code is the
 * useful part.
 *
 * @param {Parameters<typeof httpsRequestBounded>[0]} opts
 * @returns {Promise<{status: number, headers: Record<string,string>, body: Buffer, json: object|null}>}
 */
export async function requestJson(opts) {
  const res = await httpsRequestBounded(opts)
  let json = null
  try {
    json = JSON.parse(res.body.toString('utf-8'))
  } catch {
    json = null
  }
  return { ...res, json }
}

/**
 * @param {Record<string,string>} fields
 * @returns {string} application/x-www-form-urlencoded
 */
export function formEncode(fields) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  }
  return p.toString()
}

/**
 * Turn a token endpoint's JSON into a `TokenSet`.
 *
 * @param {object|null} json
 * @param {string} previousRefreshToken kept when the provider rotated nothing
 * @param {number} nowMs
 * @returns {TokenSet}
 */
export function toTokenSet(json, previousRefreshToken, nowMs) {
  const j = /** @type {Record<string, unknown>} */ (json ?? {})
  const accessToken = typeof j.access_token === 'string' ? j.access_token : ''
  if (!accessToken) throw new OAuthError('Token response contained no access_token', 'http')
  const expiresIn = Number(j.expires_in)
  return {
    accessToken,
    // Providers differ: Microsoft rotates the refresh token on every use,
    // Dropbox usually returns none on refresh. Dropping the old one in the
    // second case would force a re-authorization an hour later.
    refreshToken: typeof j.refresh_token === 'string' && j.refresh_token !== ''
      ? j.refresh_token
      : (previousRefreshToken ?? ''),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? nowMs + expiresIn * 1000 : 0,
    scope: typeof j.scope === 'string' ? j.scope : '',
    tokenType: typeof j.token_type === 'string' ? j.token_type : 'Bearer',
  }
}

/**
 * Describe a failed token response for a human.
 *
 * @param {{status: number, json: object|null, body: Buffer}} res
 * @returns {string}
 */
export function describeTokenError(res) {
  const j = /** @type {Record<string, unknown>} */ (res.json ?? {})
  const code = typeof j.error === 'string' ? j.error : `HTTP ${res.status}`
  const detail = typeof j.error_description === 'string'
    ? j.error_description
    : res.body.toString('utf-8').slice(0, 200)
  return detail ? `${code}: ${detail}` : code
}

// ── Loopback redirect listener ─────────────────────────────────────────────

/**
 * Start a throwaway HTTP server on 127.0.0.1 to catch the redirect.
 *
 * Loopback is the redirect method the OAuth-for-native-apps BCP prescribes: it
 * needs no server of ours on the internet and no custom URI scheme (which any
 * other application on the machine can register and steal). The listener binds
 * the loopback interface only — never 0.0.0.0, which would let the rest of the
 * network post codes at it — takes a random or short-list port, and shuts down
 * the moment it has an answer or the timeout fires.
 *
 * @param {object} opts
 * @param {string} opts.state             the value the redirect must carry back
 * @param {number} [opts.timeoutMs]
 * @param {number[]} [opts.ports]         tried in order before a random port
 * @param {Function} [opts.createServer]  `http.createServer` replacement
 * @returns {Promise<{redirectUri: string, port: number,
 *                    waitForCode: () => Promise<string>, close: () => void}>}
 */
export async function startLoopbackReceiver(opts) {
  const createServer = opts.createServer ?? nodeCreateServer
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
  const ports = [...(opts.ports ?? PREFERRED_LOOPBACK_PORTS), 0]

  /** @type {(code: string) => void} */
  let resolveCode = () => {}
  /** @type {(err: Error) => void} */
  let rejectCode = () => {}
  let settled = false
  /** @type {Promise<string>} */
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = (code) => { if (!settled) { settled = true; resolve(code) } }
    rejectCode = (err) => { if (!settled) { settled = true; reject(err) } }
  })

  const server = createServer((req, res) => {
    /**
     * @param {number} status
     * @param {string} text
     */
    const reply = (status, text) => {
      res.writeHead?.(status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end?.(text)
    }
    // `req.url` is a path-relative URL; the base is only there to parse it.
    const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
    if (url.pathname !== REDIRECT_PATH) {
      reply(404, 'Not found')
      return
    }
    const error = url.searchParams.get('error')
    if (error) {
      reply(400, '授權已取消，可以關閉這個分頁。')
      rejectCode(new OAuthError(
        `Authorization was refused: ${error}${url.searchParams.get('error_description')
          ? ` (${url.searchParams.get('error_description')})` : ''}`,
        'denied'))
      return
    }
    if (!statesMatch(url.searchParams.get('state') ?? '', opts.state)) {
      // Anything on this machine can hit a loopback port, so a mismatched
      // state is a forged callback, not a glitch. Never exchange its code.
      reply(400, '狀態不符，已拒絕這次回呼。')
      rejectCode(new OAuthError('Redirect carried a mismatched state parameter', 'state_mismatch'))
      return
    }
    const code = url.searchParams.get('code') ?? ''
    if (!code) {
      reply(400, '回呼缺少授權碼。')
      rejectCode(new OAuthError('Redirect carried no authorization code', 'denied'))
      return
    }
    reply(200, '授權完成，可以關閉這個分頁並回到 MyCompare。')
    resolveCode(code)
  })

  const timer = setTimeout(() => {
    rejectCode(new OAuthError(`Timed out after ${timeoutMs}ms waiting for authorization`, 'timeout'))
  }, timeoutMs)
  timer.unref?.()

  const close = () => {
    clearTimeout(timer)
    try {
      server.close?.()
    } catch {
      // Already closed; nothing to report.
    }
  }
  // The listener must not outlive the flow even if the caller forgets.
  codePromise.catch(() => {}).then(close)

  const port = await listenOnFirstFreePort(server, ports)
  return {
    port,
    redirectUri: `http://127.0.0.1:${port}${REDIRECT_PATH}`,
    waitForCode: () => codePromise,
    close,
  }
}

/**
 * @param {{listen: Function, once?: Function, on?: Function, address?: Function,
 *          removeListener?: Function}} server
 * @param {number[]} ports
 * @returns {Promise<number>}
 */
async function listenOnFirstFreePort(server, ports) {
  let lastErr = null
  for (const port of ports) {
    try {
      return await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener?.('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          server.removeListener?.('error', onError)
          const addr = server.address?.()
          resolve(typeof addr === 'object' && addr ? addr.port : port)
        }
        server.once?.('error', onError)
        server.once?.('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
    } catch (err) {
      lastErr = err
    }
  }
  throw new OAuthError(
    `Could not open a loopback port for the OAuth redirect: ${lastErr?.message ?? 'unknown error'}`,
    'config')
}

// ── Token endpoint ─────────────────────────────────────────────────────────

/**
 * Exchange an authorization code for tokens.
 *
 * No client secret is sent: a desktop application is a public client, and a
 * "secret" compiled into a shipped binary is a secret only in name.
 *
 * @param {object} opts
 * @param {string} opts.tokenUrl
 * @param {string} opts.clientId
 * @param {string} opts.code
 * @param {string} opts.redirectUri
 * @param {string} opts.codeVerifier
 * @param {Function} [opts.requestFn]
 * @param {number} [opts.timeoutMs]
 * @param {() => number} [opts.now]
 * @returns {Promise<TokenSet>}
 */
export async function exchangeAuthorizationCode(opts) {
  const now = opts.now ?? Date.now
  const res = await requestJson({
    url: opts.tokenUrl,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: formEncode({
      grant_type: 'authorization_code',
      code: opts.code,
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.codeVerifier,
    }),
    maxBytes: MAX_TOKEN_RESPONSE_BYTES,
    timeoutMs: opts.timeoutMs,
    requestFn: opts.requestFn,
  })
  if (res.status < 200 || res.status >= 300) {
    throw new OAuthError(`Token exchange failed — ${describeTokenError(res)}`, 'http')
  }
  return toTokenSet(res.json, '', now())
}

/**
 * Trade a refresh token for a fresh access token.
 *
 * `invalid_grant` means the token was revoked, expired or already rotated away.
 * That is not a transient error, so it is reported as `reauthorize` — the
 * caller must send the user through the browser again rather than retry, and
 * must never swallow it and present an empty folder as if the drive were empty.
 *
 * @param {object} opts
 * @param {string} opts.tokenUrl
 * @param {string} opts.clientId
 * @param {string} opts.refreshToken
 * @param {string} [opts.scope]
 * @param {Function} [opts.requestFn]
 * @param {number} [opts.timeoutMs]
 * @param {() => number} [opts.now]
 * @returns {Promise<TokenSet>}
 */
export async function refreshAccessToken(opts) {
  const now = opts.now ?? Date.now
  if (!opts.refreshToken) {
    throw new OAuthError('No refresh token is stored; authorization is required.', 'reauthorize')
  }
  const res = await requestJson({
    url: opts.tokenUrl,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: formEncode({
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      scope: opts.scope,
    }),
    maxBytes: MAX_TOKEN_RESPONSE_BYTES,
    timeoutMs: opts.timeoutMs,
    requestFn: opts.requestFn,
  })
  if (res.status < 200 || res.status >= 300) {
    const detail = describeTokenError(res)
    const j = /** @type {Record<string, unknown>} */ (res.json ?? {})
    const permanent = j.error === 'invalid_grant' || j.error === 'invalid_client'
      || res.status === 400 || res.status === 401
    throw new OAuthError(
      permanent
        ? `儲存的授權已失效，需要重新授權（${detail}）`
        : `Token refresh failed — ${detail}`,
      permanent ? 'reauthorize' : 'http')
  }
  return toTokenSet(res.json, opts.refreshToken, now())
}

/**
 * Run the whole interactive flow and return the resulting tokens.
 *
 * @param {object} opts
 * @param {string} opts.authorizeUrl
 * @param {string} opts.tokenUrl
 * @param {string} opts.clientId
 * @param {string} [opts.scope]
 * @param {Record<string,string>} [opts.extraAuthParams]
 * @param {(url: string) => Promise<unknown>} opts.openExternal  injected: this
 *   module must not import Electron
 * @param {Function} [opts.createServer]
 * @param {Function} [opts.requestFn]
 * @param {(n: number) => Buffer} [opts.randomBytesFn]
 * @param {number[]} [opts.ports]
 * @param {number} [opts.authTimeoutMs]
 * @param {number} [opts.timeoutMs]
 * @param {() => number} [opts.now]
 * @returns {Promise<TokenSet>}
 */
export async function authorize(opts) {
  if (!opts?.clientId) {
    throw new OAuthError(
      '此連線尚未填入 client ID。請先在服務商的開發者主控台註冊一個應用程式，' +
      '並把它的 client ID 填進連線設定。', 'config')
  }
  if (typeof opts.openExternal !== 'function') {
    throw new OAuthError('authorize requires an openExternal function', 'config')
  }
  const randomBytesFn = opts.randomBytesFn ?? nodeRandomBytes
  const verifier = createCodeVerifier(randomBytesFn)
  const challenge = codeChallengeS256(verifier)
  const state = createState(randomBytesFn)

  const receiver = await startLoopbackReceiver({
    state,
    timeoutMs: opts.authTimeoutMs,
    ports: opts.ports,
    createServer: opts.createServer,
  })
  try {
    const url = buildAuthorizeUrl({
      authorizeUrl: opts.authorizeUrl,
      clientId: opts.clientId,
      redirectUri: receiver.redirectUri,
      state,
      codeChallenge: challenge,
      scope: opts.scope,
      extraParams: opts.extraAuthParams,
    })
    await opts.openExternal(url)
    const code = await receiver.waitForCode()
    return await exchangeAuthorizationCode({
      tokenUrl: opts.tokenUrl,
      clientId: opts.clientId,
      code,
      redirectUri: receiver.redirectUri,
      codeVerifier: verifier,
      requestFn: opts.requestFn,
      timeoutMs: opts.timeoutMs,
      now: opts.now,
    })
  } finally {
    receiver.close()
  }
}

/**
 * Holds a token set and keeps the access token fresh.
 *
 * Concurrent callers share one in-flight refresh: the folder view asks for
 * several listings at once, and two simultaneous refreshes against a provider
 * that rotates refresh tokens invalidate each other.
 */
export class TokenManager {
  /**
   * @param {object} opts
   * @param {string} opts.tokenUrl
   * @param {string} opts.clientId
   * @param {Partial<TokenSet>} [opts.tokens]
   * @param {string} [opts.scope]
   * @param {Function} [opts.requestFn]
   * @param {number} [opts.timeoutMs]
   * @param {() => number} [opts.now]
   * @param {(tokens: TokenSet) => void|Promise<void>} [opts.onTokensChanged]
   *   called after every refresh so the rotated refresh token can be persisted
   */
  constructor(opts) {
    if (!opts?.tokenUrl || !opts?.clientId) {
      throw new OAuthError('TokenManager requires tokenUrl and clientId', 'config')
    }
    this.tokenUrl = opts.tokenUrl
    this.clientId = opts.clientId
    this.scope = opts.scope
    this.requestFn = opts.requestFn
    this.timeoutMs = opts.timeoutMs
    this.now = opts.now ?? Date.now
    this.onTokensChanged = opts.onTokensChanged
    /** @type {TokenSet} */
    this.tokens = {
      accessToken: opts.tokens?.accessToken ?? '',
      refreshToken: opts.tokens?.refreshToken ?? '',
      expiresAt: opts.tokens?.expiresAt ?? 0,
      scope: opts.tokens?.scope ?? '',
      tokenType: opts.tokens?.tokenType ?? 'Bearer',
    }
    /** @type {Promise<string>|null} */
    this._inFlight = null
  }

  /** @returns {boolean} */
  isExpired() {
    if (!this.tokens.accessToken) return true
    if (!this.tokens.expiresAt) return false
    return this.now() >= this.tokens.expiresAt - REFRESH_SKEW_MS
  }

  /**
   * @returns {Promise<string>} a usable access token
   * @throws {OAuthError} with code `reauthorize` when the user must sign in again
   */
  async getAccessToken() {
    if (!this.isExpired()) return this.tokens.accessToken
    if (!this.tokens.refreshToken) {
      throw new OAuthError(
        '存取權杖已過期且沒有可用的 refresh token，請重新授權。', 'reauthorize')
    }
    if (this._inFlight) return this._inFlight
    this._inFlight = (async () => {
      try {
        const next = await refreshAccessToken({
          tokenUrl: this.tokenUrl,
          clientId: this.clientId,
          refreshToken: this.tokens.refreshToken,
          scope: this.scope,
          requestFn: this.requestFn,
          timeoutMs: this.timeoutMs,
          now: this.now,
        })
        this.tokens = next
        await this.onTokensChanged?.(next)
        return next.accessToken
      } finally {
        this._inFlight = null
      }
    })()
    return this._inFlight
  }
}
