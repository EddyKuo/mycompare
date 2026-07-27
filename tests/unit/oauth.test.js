/**
 * OAuth 2.0 authorization-code + PKCE.
 *
 * No network access anywhere in this file: the HTTP client and the loopback
 * server are both injected. PKCE is checked against RFC 7636's own published
 * example, because an implementation that only agrees with itself proves
 * nothing — the same lesson Sprint 17's SFTP client learned against paramiko.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createHash } from 'crypto'
import {
  base64UrlEncode,
  createCodeVerifier,
  codeChallengeS256,
  createState,
  statesMatch,
  buildAuthorizeUrl,
  formEncode,
  toTokenSet,
  httpsRequestBounded,
  requestJson,
  startLoopbackReceiver,
  exchangeAuthorizationCode,
  refreshAccessToken,
  authorize,
  TokenManager,
  OAuthError,
  REDIRECT_PATH,
} from '../../src/main/oauth.js'

// ── test doubles ───────────────────────────────────────────────────────────

/**
 * A stand-in for `https.request`.
 *
 * @param {(call: {options: object, body: string}) =>
 *   {status?: number, headers?: object, body?: string, chunks?: (string|Buffer)[]}} handler
 */
export function makeRequestFn(handler) {
  /** @type {{options: object, body: string}[]} */
  const calls = []
  const fn = (options, cb) => {
    const req = new EventEmitter()
    let body = ''
    req.setTimeout = () => {}
    req.write = (b) => { body += Buffer.from(b).toString('utf-8') }
    req.destroy = () => {}
    req.end = () => {
      queueMicrotask(() => {
        const call = { options, body }
        calls.push(call)
        let result
        try {
          result = handler(call)
        } catch (err) {
          req.emit('error', err)
          return
        }
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

/** A stand-in for an `http.Server`, driven by `hit()`. */
class FakeServer extends EventEmitter {
  constructor(handler) {
    super()
    this.handler = handler
    this.closed = false
    /** @type {number|null} */
    this.boundPort = null
    /** @type {string|null} */
    this.boundHost = null
    this.failPorts = new Set()
  }

  listen(port, host) {
    if (this.failPorts.has(port)) {
      queueMicrotask(() => this.emit('error', new Error(`EADDRINUSE ${port}`)))
      return
    }
    this.boundPort = port === 0 ? 40404 : port
    this.boundHost = host
    queueMicrotask(() => this.emit('listening'))
  }

  address() {
    return { port: this.boundPort }
  }

  close() {
    this.closed = true
  }

  /** Deliver one request; returns what the handler answered. */
  hit(url) {
    const res = { status: 0, text: '' }
    this.handler(
      { url },
      { writeHead: (status) => { res.status = status }, end: (text) => { res.text = text } },
    )
    return res
  }
}

/** @returns {{createServer: Function, server: () => FakeServer}} */
function fakeServerFactory(configure) {
  /** @type {FakeServer|null} */
  let made = null
  return {
    createServer: (handler) => {
      made = new FakeServer(handler)
      configure?.(made)
      return made
    },
    server: () => /** @type {FakeServer} */ (made),
  }
}

// ── PKCE ───────────────────────────────────────────────────────────────────

describe('PKCE', () => {
  it('matches the worked example in RFC 7636 Appendix B', () => {
    // The one vector in the spec. If this passes, our base64url and our
    // "hash the ASCII of the verifier" reading of the RFC are both right.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(codeChallengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('base64url-encodes without padding or +/', () => {
    expect(base64UrlEncode(Buffer.from([0xfb, 0xff, 0xfe]))).toBe('-__-')
    expect(base64UrlEncode(Buffer.from('a'))).toBe('YQ')
  })

  it('produces a 43-character verifier from 32 random bytes', () => {
    const verifier = createCodeVerifier(() => Buffer.alloc(32, 7))
    expect(verifier).toHaveLength(43)
    // RFC 7636 §4.1: unreserved characters only.
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
  })

  it('draws the verifier and the state from the injected RNG', () => {
    const randomBytes = vi.fn((n) => Buffer.alloc(n, 1))
    createCodeVerifier(randomBytes)
    createState(randomBytes)
    expect(randomBytes).toHaveBeenCalledTimes(2)
    expect(randomBytes.mock.calls.map(([n]) => n)).toEqual([32, 24])
  })
})

describe('statesMatch', () => {
  it('accepts equal values and rejects everything else', () => {
    expect(statesMatch('abc', 'abc')).toBe(true)
    expect(statesMatch('abc', 'abd')).toBe(false)
    expect(statesMatch('abc', 'abcd')).toBe(false)
    // An empty state would otherwise match a callback that carried none.
    expect(statesMatch('', '')).toBe(false)
    expect(statesMatch(null, 'abc')).toBe(false)
  })
})

describe('buildAuthorizeUrl', () => {
  it('carries PKCE, state and the loopback redirect', () => {
    const url = new URL(buildAuthorizeUrl({
      authorizeUrl: 'https://example.com/auth',
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:53682/callback',
      state: 'st',
      codeChallenge: 'ch',
      scope: 'files.read',
      extraParams: { token_access_type: 'offline' },
    }))
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe('ch')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('token_access_type')).toBe('offline')
    // No client secret is ever put in the URL — this is a public client.
    expect(url.search).not.toMatch(/client_secret/)
  })

  it('refuses to build without a client ID', () => {
    expect(() => buildAuthorizeUrl({ authorizeUrl: 'https://x/a', clientId: '' }))
      .toThrow(OAuthError)
  })
})

// ── bounded HTTP ───────────────────────────────────────────────────────────

describe('httpsRequestBounded', () => {
  it('refuses a non-https URL', () => {
    expect(() => httpsRequestBounded({ url: 'http://example.com/', maxBytes: 10 }))
      .toThrow(/non-https/i)
  })

  it('rejects a response larger than the cap, mid-stream', async () => {
    // The cap has to bite while the bytes are arriving; checking afterwards
    // would mean the memory was already spent.
    const requestFn = makeRequestFn(() => ({
      chunks: [Buffer.alloc(600), Buffer.alloc(600)],
    }))
    await expect(httpsRequestBounded({
      url: 'https://example.com/x', maxBytes: 1000, requestFn,
    })).rejects.toThrow(/exceeded 1000 bytes/)
  })

  it('accepts a response at the cap', async () => {
    const requestFn = makeRequestFn(() => ({ chunks: [Buffer.alloc(1000)] }))
    const res = await httpsRequestBounded({
      url: 'https://example.com/x', maxBytes: 1000, requestFn,
    })
    expect(res.body).toHaveLength(1000)
  })

  it('sends the body with a content-length and returns parsed JSON', async () => {
    const requestFn = makeRequestFn(() => ({
      status: 200, body: JSON.stringify({ ok: true }),
    }))
    const res = await requestJson({
      url: 'https://example.com/token?a=b',
      method: 'POST',
      body: 'x=1',
      maxBytes: 1000,
      requestFn,
    })
    expect(res.json).toEqual({ ok: true })
    expect(requestFn.calls[0].options.headers['content-length']).toBe('3')
    expect(requestFn.calls[0].options.host).toBe('example.com')
    expect(requestFn.calls[0].options.path).toBe('/token?a=b')
  })

  it('returns null json rather than throwing on a non-JSON body', async () => {
    const requestFn = makeRequestFn(() => ({ status: 502, body: '<html>bad gateway' }))
    const res = await requestJson({ url: 'https://example.com/x', maxBytes: 1000, requestFn })
    expect(res.json).toBeNull()
    expect(res.status).toBe(502)
  })
})

describe('formEncode', () => {
  it('drops empty values and escapes the rest', () => {
    expect(formEncode({ a: 'x y', b: '', c: undefined, d: 'p+q' }))
      .toBe('a=x+y&d=p%2Bq')
  })
})

describe('toTokenSet', () => {
  it('keeps the previous refresh token when the response carries none', () => {
    // Dropbox returns no refresh_token on a refresh. Dropping the old one
    // would force a full re-authorization at the next expiry.
    const set = toTokenSet({ access_token: 'a', expires_in: 3600 }, 'old-refresh', 1000)
    expect(set.refreshToken).toBe('old-refresh')
    expect(set.expiresAt).toBe(1000 + 3600_000)
  })

  it('takes a rotated refresh token when there is one', () => {
    const set = toTokenSet({ access_token: 'a', refresh_token: 'new' }, 'old', 0)
    expect(set.refreshToken).toBe('new')
    expect(set.expiresAt).toBe(0)
  })

  it('refuses a response with no access token', () => {
    expect(() => toTokenSet({ token_type: 'Bearer' }, '', 0)).toThrow(OAuthError)
  })
})

// ── loopback receiver ──────────────────────────────────────────────────────

describe('startLoopbackReceiver', () => {
  it('binds 127.0.0.1 only, on the first preferred port', async () => {
    const { createServer, server } = fakeServerFactory()
    const receiver = await startLoopbackReceiver({ state: 'st', createServer })
    // Binding 0.0.0.0 would let anything on the network post codes at us.
    expect(server().boundHost).toBe('127.0.0.1')
    expect(receiver.redirectUri).toBe(`http://127.0.0.1:53682${REDIRECT_PATH}`)
    receiver.close()
    expect(server().closed).toBe(true)
  })

  it('falls back to another port when the first is taken', async () => {
    const { createServer, server } = fakeServerFactory((s) => { s.failPorts.add(53682) })
    const receiver = await startLoopbackReceiver({ state: 'st', createServer })
    expect(server().boundPort).toBe(53683)
    receiver.close()
  })

  it('hands back the code when the state matches', async () => {
    const { createServer, server } = fakeServerFactory()
    const receiver = await startLoopbackReceiver({ state: 'st', createServer })
    const reply = server().hit(`${REDIRECT_PATH}?code=abc&state=st`)
    expect(reply.status).toBe(200)
    await expect(receiver.waitForCode()).resolves.toBe('abc')
  })

  it('rejects a callback whose state does not match, and never yields the code', async () => {
    // Anything on the machine can reach a loopback port, so a mismatched state
    // is a forged callback trying to attach an attacker's account.
    const { createServer, server } = fakeServerFactory()
    const receiver = await startLoopbackReceiver({ state: 'st', createServer })
    const reply = server().hit(`${REDIRECT_PATH}?code=attacker-code&state=other`)
    expect(reply.status).toBe(400)
    await expect(receiver.waitForCode()).rejects.toMatchObject({ code: 'state_mismatch' })
  })

  it('rejects a callback with no state at all', async () => {
    const { createServer, server } = fakeServerFactory()
    const receiver = await startLoopbackReceiver({ state: 'st', createServer })
    server().hit(`${REDIRECT_PATH}?code=abc`)
    await expect(receiver.waitForCode()).rejects.toMatchObject({ code: 'state_mismatch' })
  })

  it('reports a user refusal as a refusal, not a timeout', async () => {
    const { createServer, server } = fakeServerFactory()
    const receiver = await startLoopbackReceiver({ state: 'st', createServer })
    server().hit(`${REDIRECT_PATH}?error=access_denied&state=st`)
    await expect(receiver.waitForCode()).rejects.toMatchObject({ code: 'denied' })
  })

  it('404s any path other than the redirect path', async () => {
    const { createServer, server } = fakeServerFactory()
    const receiver = await startLoopbackReceiver({ state: 'st', createServer })
    expect(server().hit('/?code=abc&state=st').status).toBe(404)
    receiver.close()
  })

  it('gives up, and shuts the listener down, after the timeout', async () => {
    const { createServer, server } = fakeServerFactory()
    const receiver = await startLoopbackReceiver({ state: 'st', createServer, timeoutMs: 5 })
    await expect(receiver.waitForCode()).rejects.toMatchObject({ code: 'timeout' })
    await Promise.resolve()
    expect(server().closed).toBe(true)
  })
})

// ── token endpoint ─────────────────────────────────────────────────────────

describe('exchangeAuthorizationCode', () => {
  it('posts the verifier and no client secret', async () => {
    const requestFn = makeRequestFn(() => ({
      body: JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 100 }),
    }))
    const set = await exchangeAuthorizationCode({
      tokenUrl: 'https://example.com/token',
      clientId: 'cid',
      code: 'the-code',
      redirectUri: 'http://127.0.0.1:53682/callback',
      codeVerifier: 'ver',
      requestFn,
      now: () => 1000,
    })
    const sent = new URLSearchParams(requestFn.calls[0].body)
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('code_verifier')).toBe('ver')
    expect(sent.get('client_secret')).toBeNull()
    expect(set).toMatchObject({ accessToken: 'at', refreshToken: 'rt', expiresAt: 101_000 })
  })

  it('surfaces the provider error text', async () => {
    const requestFn = makeRequestFn(() => ({
      status: 400,
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }),
    }))
    await expect(exchangeAuthorizationCode({
      tokenUrl: 'https://example.com/token', clientId: 'c', code: 'x',
      redirectUri: 'r', codeVerifier: 'v', requestFn,
    })).rejects.toThrow(/invalid_grant: code expired/)
  })
})

describe('refreshAccessToken', () => {
  it('exchanges the refresh token for a new access token', async () => {
    const requestFn = makeRequestFn(() => ({
      body: JSON.stringify({ access_token: 'new-at', expires_in: 60 }),
    }))
    const set = await refreshAccessToken({
      tokenUrl: 'https://example.com/token',
      clientId: 'cid',
      refreshToken: 'rt',
      requestFn,
      now: () => 0,
    })
    expect(new URLSearchParams(requestFn.calls[0].body).get('grant_type')).toBe('refresh_token')
    expect(set.accessToken).toBe('new-at')
  })

  it('asks for re-authorization — not a retry — when the grant is dead', async () => {
    // invalid_grant is permanent. Retrying it forever, or swallowing it and
    // showing an empty folder, are the two ways this goes wrong.
    const requestFn = makeRequestFn(() => ({
      status: 400, body: JSON.stringify({ error: 'invalid_grant' }),
    }))
    const err = await refreshAccessToken({
      tokenUrl: 'https://example.com/token', clientId: 'c', refreshToken: 'rt', requestFn,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect(err.code).toBe('reauthorize')
    expect(err.message).toMatch(/重新授權/)
  })

  it('treats a 500 as transient rather than as a dead grant', async () => {
    const requestFn = makeRequestFn(() => ({ status: 500, body: 'boom' }))
    const err = await refreshAccessToken({
      tokenUrl: 'https://example.com/token', clientId: 'c', refreshToken: 'rt', requestFn,
    }).catch((e) => e)
    expect(err.code).toBe('http')
  })

  it('refuses to try with no refresh token at all', async () => {
    await expect(refreshAccessToken({
      tokenUrl: 'https://example.com/token', clientId: 'c', refreshToken: '',
    })).rejects.toMatchObject({ code: 'reauthorize' })
  })
})

// ── TokenManager ───────────────────────────────────────────────────────────

describe('TokenManager', () => {
  const base = { tokenUrl: 'https://example.com/token', clientId: 'cid' }

  it('reuses a token that is still comfortably valid', async () => {
    const requestFn = makeRequestFn(() => ({ body: '{}' }))
    const m = new TokenManager({
      ...base,
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: 10_000_000 },
      requestFn,
      now: () => 0,
    })
    expect(await m.getAccessToken()).toBe('at')
    expect(requestFn.calls).toHaveLength(0)
  })

  it('refreshes once the token is inside the skew window, and reports the rotation', async () => {
    const requestFn = makeRequestFn(() => ({
      body: JSON.stringify({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }),
    }))
    const changed = []
    const m = new TokenManager({
      ...base,
      // Expires in 30s: still valid, but not for long enough to start a call.
      tokens: { accessToken: 'stale', refreshToken: 'rt', expiresAt: 30_000 },
      requestFn,
      now: () => 0,
      onTokensChanged: (t) => changed.push(t),
    })
    expect(await m.getAccessToken()).toBe('fresh')
    // The rotated refresh token has to reach the caller or the next session
    // starts with a token the provider has already retired.
    expect(changed).toHaveLength(1)
    expect(changed[0].refreshToken).toBe('rotated')
  })

  it('shares one refresh between concurrent callers', async () => {
    // Two simultaneous refreshes against a provider that rotates would
    // invalidate each other.
    const requestFn = makeRequestFn(() => ({
      body: JSON.stringify({ access_token: 'fresh', expires_in: 3600 }),
    }))
    const m = new TokenManager({
      ...base, tokens: { accessToken: '', refreshToken: 'rt' }, requestFn, now: () => 0,
    })
    const [a, b] = await Promise.all([m.getAccessToken(), m.getAccessToken()])
    expect([a, b]).toEqual(['fresh', 'fresh'])
    expect(requestFn.calls).toHaveLength(1)
  })

  it('demands re-authorization when there is no refresh token', async () => {
    const m = new TokenManager({ ...base, tokens: {}, now: () => 0 })
    await expect(m.getAccessToken()).rejects.toMatchObject({ code: 'reauthorize' })
  })

  it('propagates a dead grant as reauthorize, and can retry after one', async () => {
    let dead = true
    const requestFn = makeRequestFn(() => (dead
      ? { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) }
      : { body: JSON.stringify({ access_token: 'ok', expires_in: 3600 }) }))
    const m = new TokenManager({
      ...base, tokens: { refreshToken: 'rt' }, requestFn, now: () => 0,
    })
    await expect(m.getAccessToken()).rejects.toMatchObject({ code: 'reauthorize' })
    // The in-flight guard must be cleared by the failure, not left latched.
    dead = false
    await expect(m.getAccessToken()).resolves.toBe('ok')
  })
})

// ── the whole flow ─────────────────────────────────────────────────────────

describe('authorize', () => {
  /** Drive the flow end to end against fakes. */
  async function runFlow({ stateOverride } = {}) {
    const { createServer, server } = fakeServerFactory()
    const requestFn = makeRequestFn(() => ({
      body: JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    }))
    /** @type {string[]} */
    const opened = []
    const promise = authorize({
      authorizeUrl: 'https://provider.example/auth',
      tokenUrl: 'https://provider.example/token',
      clientId: 'cid',
      scope: 'files.read',
      openExternal: async (url) => { opened.push(url) },
      createServer,
      requestFn,
    })
    // Let the listener bind and the browser "open".
    await new Promise((r) => setTimeout(r, 0))
    const authUrl = new URL(opened[0])
    const state = stateOverride ?? authUrl.searchParams.get('state')
    server().hit(`${REDIRECT_PATH}?code=the-code&state=${encodeURIComponent(state)}`)
    return { promise, authUrl, requestFn, server }
  }

  it('opens the system browser and completes the exchange', async () => {
    const { promise, authUrl, requestFn } = await runFlow()
    const tokens = await promise
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' })

    // The verifier that was sent must be the pre-image of the challenge that
    // was shown to the provider — the property PKCE rests on.
    const sent = new URLSearchParams(requestFn.calls[0].body)
    const verifier = sent.get('code_verifier')
    const expected = base64UrlEncode(createHash('sha256').update(verifier, 'ascii').digest())
    expect(authUrl.searchParams.get('code_challenge')).toBe(expected)
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(sent.get('redirect_uri')).toBe(`http://127.0.0.1:53682${REDIRECT_PATH}`)
  })

  it('never exchanges a code that arrived with the wrong state', async () => {
    const { promise, requestFn } = await runFlow({ stateOverride: 'forged' })
    await expect(promise).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(requestFn.calls).toHaveLength(0)
  })

  it('closes the listener even when the flow fails', async () => {
    const { promise, server } = await runFlow({ stateOverride: 'forged' })
    await promise.catch(() => {})
    expect(server().closed).toBe(true)
  })

  it('says what to do when no client ID has been configured', async () => {
    await expect(authorize({
      authorizeUrl: 'https://x/a', tokenUrl: 'https://x/t', clientId: '',
      openExternal: async () => {},
    })).rejects.toThrow(/client ID/)
  })

  it('refuses to run without a way to open the system browser', async () => {
    // The alternative — a BrowserWindow we control — would be able to read the
    // password the user types into the provider's page.
    await expect(authorize({
      authorizeUrl: 'https://x/a', tokenUrl: 'https://x/t', clientId: 'cid',
    })).rejects.toThrow(/openExternal/)
  })
})
