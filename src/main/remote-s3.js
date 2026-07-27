/**
 * @file remote-s3.js
 * @description Read-only Amazon S3 client: AWS Signature Version 4 signing over
 *   `https` + `crypto`, and just enough XML parsing for `ListObjectsV2` and
 *   `GetObject`. No SDK, because the project forbids new npm dependencies — and
 *   unlike SSH, SigV4 needs only HMAC-SHA256 and SHA-256, both of which Node
 *   provides, so there is no hand-rolled cryptography here: only a documented
 *   canonicalisation format around standard primitives.
 *
 * ⚠️ PRIVACY / NETWORK EGRESS WARNING
 *   Using this module sends the user's AWS credentials to, and downloads object
 *   content from, **Amazon (or a third-party S3-compatible endpoint the user
 *   nominated)**. Object bytes and key names leave the machine. Callers must
 *   make that explicit in the UI before connecting.
 *
 * Scope
 *   Implemented: ListObjectsV2, GetObject, HeadObject. Read-only on purpose —
 *   PutObject/DeleteObject are not implemented, so no bug in this file can
 *   destroy a user's bucket.
 *
 * Other remote kinds:
 *   - **SFTP** is implemented in `ssh-transport.js` / `remote-sftp.js`. A note
 *     here used to say Node had no SSH primitives; it does.
 *   - **Dropbox / OneDrive** require OAuth 2.0 interactive authorization plus
 *     each vendor's REST API and a registered application client ID. That is an
 *     integration project with a per-vendor registration prerequisite, not
 *     something a protocol module can provide. Unsupported.
 *
 * Everything above `S3Client` is pure, so the signing and the XML parsing — the
 * two places this can silently be wrong — are verified against AWS's own
 * published test vectors without any network access.
 */

import { createHash, createHmac } from 'crypto'
import { request as httpsRequest } from 'https'

/** Every network wait is bounded. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Hard ceiling on a single GetObject, so a huge object cannot exhaust RAM. */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

/** Hard ceiling on one ListObjectsV2 XML response. */
export const MAX_XML_BYTES = 16 * 1024 * 1024

const ALGORITHM = 'AWS4-HMAC-SHA256'

/** SHA-256 of the empty string — the payload hash for every request we make. */
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

// ── Signature Version 4 ────────────────────────────────────────────────────

/**
 * @param {string|Buffer} data
 * @returns {string} lowercase hex
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * @param {string|Buffer} key
 * @param {string} data
 * @returns {Buffer}
 */
export function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * Percent-encode per RFC 3986 as SigV4 requires.
 *
 * `encodeURIComponent` is not a substitute: it leaves `!`, `'`, `(`, `)` and `*`
 * alone, and any difference between what is signed and what is sent produces
 * `SignatureDoesNotMatch` — an error that gives no hint which character was
 * wrong.
 *
 * @param {string} str
 * @param {boolean} [encodeSlash] false when encoding a whole path
 * @returns {string}
 */
export function uriEncode(str, encodeSlash = true) {
  let out = ''
  for (const byte of Buffer.from(String(str), 'utf-8')) {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch
    else if (ch === '/') out += encodeSlash ? '%2F' : '/'
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

/**
 * Format a Date as SigV4's two forms.
 *
 * @param {Date} date
 * @returns {{amzDate: string, dateStamp: string}} `YYYYMMDDTHHMMSSZ`, `YYYYMMDD`
 */
export function formatAmzDate(date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

/**
 * Canonicalise headers: lowercase names, trimmed values with runs of internal
 * whitespace collapsed, sorted by name.
 *
 * @param {Record<string, string|number>} headers
 * @returns {{canonicalHeaders: string, signedHeaders: string}}
 */
export function canonicaliseHeaders(headers) {
  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort()
  const lower = {}
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ')
  }
  return {
    canonicalHeaders: names.map((n) => `${n}:${lower[n]}\n`).join(''),
    signedHeaders: names.join(';'),
  }
}

/**
 * Canonicalise a query string: both name and value percent-encoded, sorted by
 * encoded name then encoded value, empty values kept as `name=`.
 *
 * @param {Record<string, string|number|undefined|null>} query
 * @returns {string}
 */
export function canonicaliseQuery(query) {
  return Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [uriEncode(k), uriEncode(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

/**
 * Build the SigV4 canonical request.
 *
 * Note the S3-specific rule: for `service: 's3'` the URI path is encoded once
 * and *not* normalised, because an S3 key may legitimately contain `.` and `..`
 * segments. Every other service double-encodes and normalises. Getting this
 * backwards makes signing fail only for the subset of keys that contain those
 * segments — a bug that passes a naive test suite.
 *
 * @param {object} req
 * @param {string} req.method
 * @param {string} req.path            already `/`-prefixed, un-encoded
 * @param {Record<string, string|number>} [req.query]
 * @param {Record<string, string|number>} req.headers
 * @param {string} req.payloadHash     hex
 * @returns {{canonicalRequest: string, signedHeaders: string, canonicalQuery: string}}
 */
export function buildCanonicalRequest(req) {
  const canonicalUri = '/' + String(req.path ?? '/')
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => uriEncode(seg))
    .join('/')
  const canonicalQuery = canonicaliseQuery(req.query)
  const { canonicalHeaders, signedHeaders } = canonicaliseHeaders(req.headers)
  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    req.payloadHash,
  ].join('\n')
  return { canonicalRequest, signedHeaders, canonicalQuery }
}

/**
 * @param {object} args
 * @param {string} args.amzDate
 * @param {string} args.scope           `date/region/service/aws4_request`
 * @param {string} args.canonicalRequest
 * @returns {string}
 */
export function buildStringToSign({ amzDate, scope, canonicalRequest }) {
  return [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
}

/**
 * Derive the date/region/service-scoped signing key.
 *
 * The chained HMACs are what keep a leaked signature from being replayable
 * against another day, region or service.
 *
 * @param {string} secretAccessKey
 * @param {string} dateStamp `YYYYMMDD`
 * @param {string} region
 * @param {string} service
 * @returns {Buffer}
 */
export function deriveSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmacSha256('AWS4' + secretAccessKey, dateStamp)
  const kRegion = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, service)
  return hmacSha256(kService, 'aws4_request')
}

/**
 * Sign a request, returning the headers to send.
 *
 * @param {object} args
 * @param {string} args.method
 * @param {string} args.host
 * @param {string} args.path
 * @param {Record<string, string|number>} [args.query]
 * @param {Record<string, string|number>} [args.headers] extra headers to sign
 * @param {string} [args.payloadHash]
 * @param {string} args.accessKeyId
 * @param {string} args.secretAccessKey
 * @param {string} [args.sessionToken]
 * @param {string} args.region
 * @param {string} [args.service]
 * @param {Date} [args.date]
 * @returns {{headers: Record<string,string>, authorization: string, signature: string,
 *            canonicalRequest: string, stringToSign: string, credentialScope: string,
 *            amzDate: string, signedHeaders: string}}
 */
export function signRequestV4(args) {
  const service = args.service ?? 's3'
  const { amzDate, dateStamp } = formatAmzDate(args.date ?? new Date())
  const payloadHash = args.payloadHash ?? EMPTY_PAYLOAD_SHA256

  /** @type {Record<string, string>} */
  const headers = {
    host: args.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(args.headers ?? {}),
  }
  // Temporary credentials: the token must be signed, or STS rejects the call.
  if (args.sessionToken) headers['x-amz-security-token'] = args.sessionToken

  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method: args.method,
    path: args.path,
    query: args.query,
    headers,
    payloadHash,
  })
  const credentialScope = `${dateStamp}/${args.region}/${service}/aws4_request`
  const stringToSign = buildStringToSign({ amzDate, scope: credentialScope, canonicalRequest })
  const signingKey = deriveSigningKey(args.secretAccessKey, dateStamp, args.region, service)
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')

  const authorization =
    `${ALGORITHM} Credential=${args.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    headers: { ...headers, authorization },
    authorization,
    signature,
    canonicalRequest,
    stringToSign,
    credentialScope,
    amzDate,
    signedHeaders,
  }
}

// ── XML ────────────────────────────────────────────────────────────────────

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
})

/**
 * Expand XML character and named entities.
 *
 * Order matters: replacing `&amp;` first would turn `&amp;lt;` (a literal
 * "&lt;") into `<`. A single left-to-right pass avoids that entirely.
 *
 * @param {string} s
 * @returns {string}
 */
export function decodeXmlEntities(s) {
  return String(s).replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (whole, dec, hex, name) => {
    if (dec !== undefined) {
      const cp = Number(dec)
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole
    }
    if (hex !== undefined) {
      const cp = parseInt(hex, 16)
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole
    }
    return NAMED_ENTITIES[name] ?? whole
  })
}

/**
 * Decode element text, passing CDATA sections through verbatim.
 *
 * S3 does not normally emit CDATA, but S3-compatible servers do, and a CDATA
 * body must *not* be entity-decoded — `<![CDATA[a&amp;b]]>` is the six
 * characters `a&amp;b`, not `a&b`.
 *
 * @param {string} s
 * @returns {string}
 */
export function decodeXmlText(s) {
  if (typeof s !== 'string') return ''
  let out = ''
  let i = 0
  while (i < s.length) {
    const start = s.indexOf('<![CDATA[', i)
    if (start === -1) {
      out += decodeXmlEntities(s.slice(i))
      break
    }
    out += decodeXmlEntities(s.slice(i, start))
    const end = s.indexOf(']]>', start + 9)
    if (end === -1) {
      out += s.slice(start + 9) // unterminated — keep what is there
      break
    }
    out += s.slice(start + 9, end)
    i = end + 3
  }
  return out
}

/**
 * Strip an optional namespace prefix from a tag name.
 *
 * @param {string} name
 * @returns {string}
 */
function localName(name) {
  const i = name.indexOf(':')
  return i === -1 ? name : name.slice(i + 1)
}

/**
 * Collect the inner XML of every top-level `<tagName>` element.
 *
 * A hand-written scanner rather than a regex, because it has to step over CDATA
 * sections and comments (which can legally contain `<` and `>` and a matching
 * close tag) and has to handle the same tag nested inside itself. A regex that
 * looks correct on well-formed sample output silently mis-parses both.
 *
 * @param {string} xml
 * @param {string} tagName
 * @returns {string[]}
 */
export function findElements(xml, tagName) {
  if (typeof xml !== 'string') return []
  /** @type {string[]} */
  const results = []
  const want = localName(tagName)
  let i = 0
  let depth = 0
  let innerStart = -1

  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) break
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt)
      i = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt)
      i = end === -1 ? xml.length : end + 3
      continue
    }
    const gt = xml.indexOf('>', lt)
    if (gt === -1) break

    const body = xml.slice(lt + 1, gt)
    const isClose = body.startsWith('/')
    const isSelfClosing = body.endsWith('/')
    const isDecl = body.startsWith('?') || body.startsWith('!')
    if (!isDecl) {
      const name = localName(
        (isClose ? body.slice(1) : body).replace(/\/$/, '').trim().split(/\s/)[0],
      )
      if (name === want) {
        if (isClose) {
          depth--
          if (depth === 0 && innerStart !== -1) {
            results.push(xml.slice(innerStart, lt))
            innerStart = -1
          }
          if (depth < 0) depth = 0
        } else if (isSelfClosing) {
          if (depth === 0) results.push('')
        } else {
          if (depth === 0) innerStart = gt + 1
          depth++
        }
      }
    }
    i = gt + 1
  }
  return results
}

/**
 * Decoded text of the first `<tagName>` child, or a fallback.
 *
 * @param {string} xml
 * @param {string} tagName
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
export function xmlText(xml, tagName, fallback = null) {
  const found = findElements(xml, tagName)
  return found.length ? decodeXmlText(found[0]) : fallback
}

// ── Untrusted key handling ─────────────────────────────────────────────────

/**
 * Turn an S3 key into a safe relative path, or null when it cannot be one.
 *
 * S3 keys are arbitrary UTF-8 — the service happily stores `../../../.ssh/id_rsa`
 * or a key containing a NUL. The key is chosen by whoever can write to the
 * bucket, which is not necessarily the person reading it, so it is untrusted
 * input the moment it is used to build a local path.
 *
 * @param {string} key
 * @returns {string|null} '/'-separated relative path
 */
export function sanitizeObjectKey(key) {
  if (typeof key !== 'string' || key === '') return null
  const segments = []
  for (const raw of key.split('/')) {
    if (raw === '' || raw === '.') continue
    if (raw === '..') return null
    if (raw.length > 255) return null
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i)
      if (c < 0x20 || c === 0x7f) return null
    }
    if (raw.includes('\\') || raw.includes(':')) return null
    if (/[ .]$/.test(raw)) return null
    segments.push(raw)
  }
  return segments.length ? segments.join('/') : null
}

/**
 * @typedef {object} S3Object
 * @property {string} key
 * @property {string} name        last path segment
 * @property {number} size
 * @property {Date|null} lastModified
 * @property {string} etag        quotes stripped
 * @property {string} storageClass
 * @property {boolean} unsafe     key cannot be mapped to a local path
 */

/**
 * Parse a `ListObjectsV2` response.
 *
 * @param {string} xml
 * @param {{urlEncoded?: boolean}} [opts] set when the request asked for
 *   `encoding-type=url` — keys then come back percent-encoded
 * @returns {{bucket: string|null, prefix: string, delimiter: string|null,
 *            isTruncated: boolean, keyCount: number|null,
 *            nextContinuationToken: string|null,
 *            objects: S3Object[], commonPrefixes: {prefix: string, name: string}[]}}
 */
export function parseListObjectsV2(xml, opts = {}) {
  const body = findElements(xml, 'ListBucketResult')[0] ?? String(xml ?? '')
  /** @param {string|null} s */
  const maybeDecode = (s) => {
    if (s === null) return null
    if (!opts.urlEncoded) return s
    try {
      return decodeURIComponent(s)
    } catch {
      return s // a malformed %-sequence is the server's problem, not a crash
    }
  }

  /** @type {S3Object[]} */
  const objects = []
  for (const item of findElements(body, 'Contents')) {
    const key = maybeDecode(xmlText(item, 'Key', '')) ?? ''
    if (key === '') continue
    const lastModifiedRaw = xmlText(item, 'LastModified')
    const lastModified = lastModifiedRaw ? new Date(lastModifiedRaw) : null
    const safe = sanitizeObjectKey(key)
    objects.push({
      key,
      name: key.replace(/\/+$/, '').split('/').pop() ?? key,
      size: Number(xmlText(item, 'Size', '0')) || 0,
      lastModified: lastModified && !Number.isNaN(lastModified.getTime()) ? lastModified : null,
      etag: (xmlText(item, 'ETag', '') ?? '').replace(/^"|"$/g, ''),
      storageClass: xmlText(item, 'StorageClass', '') ?? '',
      unsafe: safe === null,
    })
  }

  const commonPrefixes = []
  for (const item of findElements(body, 'CommonPrefixes')) {
    const p = maybeDecode(xmlText(item, 'Prefix', '')) ?? ''
    if (p === '') continue
    commonPrefixes.push({ prefix: p, name: p.replace(/\/+$/, '').split('/').pop() ?? p })
  }

  const keyCountRaw = xmlText(body, 'KeyCount')
  return {
    bucket: xmlText(body, 'Name'),
    prefix: maybeDecode(xmlText(body, 'Prefix', '')) ?? '',
    delimiter: maybeDecode(xmlText(body, 'Delimiter')),
    isTruncated: (xmlText(body, 'IsTruncated', 'false') ?? '').trim().toLowerCase() === 'true',
    keyCount: keyCountRaw === null ? null : Number(keyCountRaw),
    nextContinuationToken: maybeDecode(xmlText(body, 'NextContinuationToken')),
    objects,
    commonPrefixes,
  }
}

/**
 * Parse an S3 `<Error>` document.
 *
 * @param {string} xml
 * @returns {{code: string, message: string, requestId: string|null}}
 */
export function parseS3Error(xml) {
  const body = findElements(xml, 'Error')[0] ?? String(xml ?? '')
  return {
    code: xmlText(body, 'Code', 'Unknown') ?? 'Unknown',
    message: xmlText(body, 'Message', '') ?? '',
    requestId: xmlText(body, 'RequestId'),
  }
}

// ── Client ─────────────────────────────────────────────────────────────────

/**
 * Build the virtual-hosted-style endpoint host for a bucket.
 *
 * @param {string} bucket
 * @param {string} region
 * @returns {string}
 */
export function defaultS3Host(bucket, region) {
  return region === 'us-east-1'
    ? `${bucket}.s3.amazonaws.com`
    : `${bucket}.s3.${region}.amazonaws.com`
}

/**
 * Read-only S3 client.
 *
 * `requestFn` is injected so the request construction and response handling can
 * be tested against a fake; the test suite never opens a socket.
 */
export class S3Client {
  /**
   * @param {object} opts
   * @param {string} opts.bucket
   * @param {string} opts.region
   * @param {string} opts.accessKeyId
   * @param {string} opts.secretAccessKey
   * @param {string} [opts.sessionToken]
   * @param {string} [opts.endpoint]  host of an S3-compatible service; https only
   * @param {boolean} [opts.pathStyle] put the bucket in the path, for
   *   S3-compatible servers that do not do virtual-hosted addressing
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxDownloadBytes]
   * @param {Function} [opts.requestFn] https.request replacement
   */
  constructor(opts) {
    if (!opts?.bucket) throw new Error('S3Client requires a bucket')
    if (!opts?.region) throw new Error('S3Client requires a region')
    if (!opts?.accessKeyId || !opts?.secretAccessKey) {
      throw new Error('S3Client requires accessKeyId and secretAccessKey')
    }
    if (opts.endpoint && /^https?:\/\//i.test(opts.endpoint) && !/^https:/i.test(opts.endpoint)) {
      // Plain HTTP would put the Authorization header and the object bytes on
      // the wire in clear text. Refuse rather than quietly downgrade.
      throw new Error('S3 endpoint must use https')
    }
    this.bucket = opts.bucket
    this.region = opts.region
    this.accessKeyId = opts.accessKeyId
    this.secretAccessKey = opts.secretAccessKey
    this.sessionToken = opts.sessionToken
    this.pathStyle = Boolean(opts.pathStyle)
    this.host = opts.endpoint
      ? String(opts.endpoint).replace(/^https:\/\//i, '').replace(/\/.*$/, '')
      : defaultS3Host(opts.bucket, opts.region)
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxDownloadBytes = opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES
    this._request = opts.requestFn ?? httpsRequest
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  _pathFor(key) {
    const suffix = key ? String(key).replace(/^\/+/, '') : ''
    return this.pathStyle ? `/${this.bucket}/${suffix}` : `/${suffix}`
  }

  /**
   * Sign and perform one request, collecting a bounded body.
   *
   * @param {object} args
   * @param {string} args.method
   * @param {string} args.path
   * @param {Record<string, string|number>} [args.query]
   * @param {Record<string, string|number>} [args.headers]
   * @param {number} args.maxBytes
   * @returns {Promise<{status: number, headers: Record<string,string>, body: Buffer}>}
   */
  _send(args) {
    const signed = signRequestV4({
      method: args.method,
      host: this.host,
      path: args.path,
      query: args.query,
      headers: args.headers,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      region: this.region,
      service: 's3',
    })

    const qs = canonicaliseQuery(args.query)
    const pathWithQuery = args.path.split('/').map((s) => uriEncode(s)).join('/') + (qs ? `?${qs}` : '')

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        fn(value)
      }

      const req = this._request(
        { method: args.method, host: this.host, path: pathWithQuery, headers: signed.headers },
        (res) => {
          /** @type {Buffer[]} */
          const chunks = []
          let total = 0
          res.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            total += buf.length
            if (total > args.maxBytes) {
              res.destroy?.()
              req.destroy?.()
              finish(reject, new Error(`S3 response exceeded ${args.maxBytes} bytes`))
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
      // Bounded: an endpoint that accepts the connection and then stalls must
      // not hang a comparison indefinitely.
      req.setTimeout?.(this.timeoutMs, () => {
        req.destroy?.(new Error(`S3 request timed out after ${this.timeoutMs}ms`))
        finish(reject, new Error(`S3 request timed out after ${this.timeoutMs}ms`))
      })
      req.end()
    })
  }

  /**
   * @param {{status: number, body: Buffer}} res
   * @param {string} what
   */
  _throwIfError(res, what) {
    if (res.status >= 200 && res.status < 300) return
    const parsed = parseS3Error(res.body.toString('utf-8'))
    throw new Error(`S3 ${what} failed (${res.status} ${parsed.code}): ${parsed.message}`)
  }

  /**
   * One page of `ListObjectsV2`.
   *
   * `encoding-type=url` is always requested: without it, a key containing a
   * character that is illegal in XML comes back as an invalid document.
   *
   * @param {{prefix?: string, delimiter?: string, continuationToken?: string,
   *          maxKeys?: number}} [opts]
   * @returns {Promise<ReturnType<typeof parseListObjectsV2>>}
   */
  async listObjects(opts = {}) {
    const res = await this._send({
      method: 'GET',
      path: this._pathFor(''),
      query: {
        'list-type': 2,
        'encoding-type': 'url',
        prefix: opts.prefix ?? '',
        delimiter: opts.delimiter,
        'continuation-token': opts.continuationToken,
        'max-keys': opts.maxKeys,
      },
      maxBytes: MAX_XML_BYTES,
    })
    this._throwIfError(res, 'ListObjectsV2')
    return parseListObjectsV2(res.body.toString('utf-8'), { urlEncoded: true })
  }

  /**
   * Every page of `ListObjectsV2`, bounded by `maxPages` so a bucket with tens
   * of millions of keys cannot spin forever.
   *
   * @param {{prefix?: string, delimiter?: string, maxPages?: number}} [opts]
   * @returns {Promise<{objects: S3Object[], commonPrefixes: {prefix: string, name: string}[],
   *                    truncated: boolean}>}
   */
  async listAllObjects(opts = {}) {
    const maxPages = opts.maxPages ?? 50
    /** @type {S3Object[]} */
    const objects = []
    const prefixes = new Map()
    let token
    let truncated = false

    for (let page = 0; page < maxPages; page++) {
      const result = await this.listObjects({
        prefix: opts.prefix,
        delimiter: opts.delimiter,
        continuationToken: token,
      })
      objects.push(...result.objects)
      for (const cp of result.commonPrefixes) prefixes.set(cp.prefix, cp)
      if (!result.isTruncated || !result.nextContinuationToken) {
        return { objects, commonPrefixes: [...prefixes.values()], truncated: false }
      }
      token = result.nextContinuationToken
      truncated = true
    }
    return { objects, commonPrefixes: [...prefixes.values()], truncated }
  }

  /**
   * Download one object.
   *
   * @param {string} key
   * @param {{maxBytes?: number}} [opts]
   * @returns {Promise<Buffer>}
   */
  async getObject(key, opts = {}) {
    if (typeof key !== 'string' || key === '') throw new Error('getObject requires a key')
    const limit = Math.min(opts.maxBytes ?? this.maxDownloadBytes, MAX_DOWNLOAD_BYTES)
    const res = await this._send({ method: 'GET', path: this._pathFor(key), maxBytes: limit })
    this._throwIfError(res, 'GetObject')
    return res.body
  }

  /**
   * Object metadata without transferring the body.
   *
   * @param {string} key
   * @returns {Promise<{size: number, lastModified: Date|null, etag: string}>}
   */
  async headObject(key) {
    if (typeof key !== 'string' || key === '') throw new Error('headObject requires a key')
    const res = await this._send({ method: 'HEAD', path: this._pathFor(key), maxBytes: 1024 })
    this._throwIfError(res, 'HeadObject')
    const lm = res.headers['last-modified'] ? new Date(res.headers['last-modified']) : null
    return {
      size: Number(res.headers['content-length'] ?? 0) || 0,
      lastModified: lm && !Number.isNaN(lm.getTime()) ? lm : null,
      etag: String(res.headers.etag ?? '').replace(/^"|"$/g, ''),
    }
  }
}
