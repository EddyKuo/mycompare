/**
 * @file remote-ftp.js
 * @description Read-only FTP / FTPS (explicit `AUTH TLS`) client, built on the
 *   Node built-ins `net` and `tls` only — the project forbids new npm
 *   dependencies, and FTP is a plain-text line protocol, so it is one of the
 *   few remote protocols that can honestly be implemented that way.
 *
 * ⚠️ PRIVACY / NETWORK EGRESS WARNING
 *   Every function in this file that touches a socket sends the user's
 *   credentials to, and receives file content from, a **third-party server the
 *   user nominated**. Opening a remote comparison therefore transmits data off
 *   the machine. Callers must surface that to the user before connecting; this
 *   module must never be wired to an automatic/background code path.
 *
 * ⚠️ PLAIN FTP IS UNENCRYPTED
 *   `kind: 'ftp'` sends USER/PASS and all file bytes in clear text. Prefer
 *   `kind: 'ftps'` (explicit AUTH TLS). The caller is expected to warn.
 *
 * Scope
 *   Implemented: USER, PASS, PWD, CWD, TYPE I, PASV/EPSV, LIST, RETR, SIZE,
 *   MDTM, QUIT. Passive mode only — active mode (PORT/EPRT) would require
 *   listening on a local port, which is worse for firewalls and adds an inbound
 *   attack surface for no benefit here.
 *
 *   Not implemented, deliberately: any mutating command (STOR, DELE, MKD, RNFR…).
 *   Comparison only needs reads, and a read-only client cannot destroy a remote
 *   tree through a bug.
 *
 * Not possible with built-ins (see also remote-s3.js):
 *   - **SFTP** is *not* FTP-over-TLS. It is a subsystem of SSH and requires a
 *     complete SSH transport layer: algorithm negotiation, Diffie-Hellman /
 *     ECDH key exchange, host-key verification, per-direction cipher and MAC
 *     state, key re-exchange, then the SSH connection protocol and finally the
 *     SFTP packet layer. Node ships no SSH primitives, so this would mean
 *     hand-rolling cryptographic transport code — exactly the kind of thing
 *     that must not be hand-rolled. Unsupported; the profile layer rejects it.
 *   - **Dropbox / OneDrive** need an OAuth 2.0 authorization-code + PKCE flow
 *     (browser window, redirect listener, registered client ID, refresh-token
 *     storage) plus each vendor's own REST API. That is an integration project,
 *     not a protocol module. Unsupported.
 *
 * Everything above `FtpClient` is a pure string -> object function so the
 * protocol parsing — where the real bugs live — is testable without a network.
 */

import { connect as netConnect } from 'net'
import { connect as tlsConnect } from 'tls'

/** Default per-command / per-connect deadline. Every socket op is bounded. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Hard ceiling on a single download, so a hostile server cannot exhaust RAM. */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

/** Hard ceiling on one LIST response. */
export const MAX_LISTING_BYTES = 8 * 1024 * 1024

/** Control channel is line-oriented; a reply this long is an attack, not a reply. */
export const MAX_CONTROL_BUFFER_BYTES = 1024 * 1024

const MONTHS = Object.freeze({
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
})

// ── Response parsing ───────────────────────────────────────────────────────

/**
 * @typedef {object} FtpResponse
 * @property {number} code   three-digit reply code
 * @property {string[]} lines  every text line, continuation lines included
 * @property {string} text   lines joined with '\n'
 */

/**
 * Incremental RFC 959 reply parser.
 *
 * Replies are either a single `ddd text` line or a multi-line group opened by
 * `ddd-text` and closed by the *same* code followed by a space. Getting this
 * wrong is the classic FTP client bug: banners and FEAT/system replies are
 * routinely multi-line, and a parser that treats every line as a reply
 * desynchronises from the command stream permanently.
 */
export class FtpResponseParser {
  /** @param {{maxBufferBytes?: number}} [opts] */
  constructor(opts = {}) {
    this._buf = ''
    this._max = opts.maxBufferBytes ?? MAX_CONTROL_BUFFER_BYTES
    /** @type {number|null} */
    this._openCode = null
    /** @type {string[]} */
    this._lines = []
  }

  /**
   * Feed bytes from the control connection.
   *
   * @param {string|Buffer} chunk
   * @returns {FtpResponse[]} complete replies, in order
   */
  push(chunk) {
    this._buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    if (this._buf.length > this._max) {
      throw new Error('FTP control reply exceeded buffer limit')
    }

    /** @type {FtpResponse[]} */
    const out = []
    let nl
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).replace(/\r$/, '')
      this._buf = this._buf.slice(nl + 1)

      if (this._openCode === null) {
        const m = /^(\d{3})([ -])?(.*)$/.exec(line)
        if (!m) continue // stray line before any reply — ignore rather than desync
        const code = Number(m[1])
        if (m[2] === '-') {
          this._openCode = code
          this._lines = [m[3]]
        } else {
          out.push({ code, lines: [m[3]], text: m[3] })
        }
      } else {
        const end = new RegExp(`^${this._openCode} ?(.*)$`).exec(line)
        if (end && /^\d{3}[ ]/.test(line)) {
          this._lines.push(end[1])
          out.push({
            code: this._openCode,
            lines: this._lines.slice(),
            text: this._lines.join('\n'),
          })
          this._openCode = null
          this._lines = []
        } else {
          // RFC 959 lets an intermediate line repeat the code with a dash.
          // Keeping the prefix would surface "220-Unauthorised…" as the text,
          // so strip it when it is this reply's own code.
          const cont = new RegExp(`^${this._openCode}-(.*)$`).exec(line)
          this._lines.push(cont ? cont[1] : line)
        }
      }
    }
    return out
  }
}

/**
 * Parse a 227 passive-mode reply: `227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)`.
 *
 * Wildly inconsistent in the wild — some servers omit the parentheses, some add
 * extra prose — so the numbers are located rather than the whole line matched.
 *
 * @param {string} text
 * @returns {{host: string, port: number}}
 */
export function parsePasvResponse(text) {
  if (typeof text !== 'string') throw new TypeError('PASV reply must be a string')
  const m = /(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(text)
  if (!m) throw new Error(`Malformed PASV reply: ${text}`)
  const n = m.slice(1).map(Number)
  if (n.some((v) => v > 255)) throw new Error(`Malformed PASV reply: ${text}`)
  const port = (n[4] << 8) | n[5]
  if (port <= 0 || port > 65535) throw new Error(`Malformed PASV reply: ${text}`)
  return { host: `${n[0]}.${n[1]}.${n[2]}.${n[3]}`, port }
}

/**
 * Parse a 229 extended-passive reply: `229 ... (|||port|)`.
 *
 * @param {string} text
 * @returns {{port: number}}
 */
export function parseEpsvResponse(text) {
  if (typeof text !== 'string') throw new TypeError('EPSV reply must be a string')
  const m = /\((.)\1\1(\d{1,5})\1\)/.exec(text)
  if (!m) throw new Error(`Malformed EPSV reply: ${text}`)
  const port = Number(m[2])
  if (port <= 0 || port > 65535) throw new Error(`Malformed EPSV reply: ${text}`)
  return { port }
}

/**
 * Parse a 213 SIZE reply.
 *
 * @param {string} text
 * @returns {number}
 */
export function parseSizeResponse(text) {
  const m = /(\d+)\s*$/.exec(String(text ?? '').trim())
  if (!m) throw new Error(`Malformed SIZE reply: ${text}`)
  return Number(m[1])
}

/**
 * Parse a 213 MDTM reply (`YYYYMMDDhhmmss`, optionally `.sss`). Always UTC per
 * RFC 3659 — servers that answer in local time are simply wrong and there is no
 * way to detect it, so UTC is assumed.
 *
 * @param {string} text
 * @returns {Date}
 */
export function parseMdtmResponse(text) {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?/.exec(String(text ?? ''))
  if (!m) throw new Error(`Malformed MDTM reply: ${text}`)
  const d = new Date(Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), Number((m[7] ?? '0').padEnd(3, '0')),
  ))
  if (Number.isNaN(d.getTime())) throw new Error(`Malformed MDTM reply: ${text}`)
  return d
}

// ── Untrusted-name handling ────────────────────────────────────────────────

/**
 * True when the string contains a C0 control character or DEL.
 *
 * Written as an explicit scan rather than a regex character class so the file
 * carries no literal control bytes — those are invisible in a diff and are a
 * standard way to smuggle a change past review.
 *
 * @param {string} s
 * @returns {boolean}
 */
export function hasControlChar(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

/**
 * Drop every C0 control character and DEL.
 *
 * @param {string} s
 * @returns {string}
 */
export function stripControlChars(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0x20 && c !== 0x7f) out += s[i]
  }
  return out
}

/**
 * Decide whether a name taken from a server's LIST output may be used as a
 * single path component.
 *
 * This is a security boundary, not a tidiness check. A LIST line is attacker
 * controlled: a malicious or compromised server can answer with
 * `../../../../home/user/.ssh/authorized_keys`, an absolute path, a Windows
 * drive-relative path, or a NUL-truncated name. If any of those reach a local
 * `join()` when the user syncs or downloads, the server picks where the bytes
 * land. Rejecting here means a bad name can never become a path.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeRemoteName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (name.length > 255) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  // NUL and other C0 controls, plus DEL.
  if (hasControlChar(name)) return false
  // Windows drive-relative / ADS forms, and reserved characters.
  if (/^[a-zA-Z]:/.test(name)) return false
  if (name.includes(':')) return false
  // Trailing dot/space is silently stripped by Windows, so `evil.txt.` and
  // `evil.txt` can collide; refuse rather than guess.
  if (/[ .]$/.test(name) && name !== '.') return false
  return true
}

/**
 * Clean a server-supplied name into something safe to use as one path
 * component, or return null when nothing safe remains.
 *
 * Preferred usage is `isSafeRemoteName` + skip. `sanitizeRemoteName` exists for
 * display paths where dropping the entry entirely would confuse the user.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function sanitizeRemoteName(name) {
  if (typeof name !== 'string') return null
  let s = stripControlChars(name)
  s = s.replace(/[/\\:]/g, '_')
  s = s.replace(/[ .]+$/, '')
  if (s === '' || s === '.' || s === '..') return null
  return s.slice(0, 255)
}

/**
 * Normalise a remote POSIX path, resolving `.` and `..` *within* the string so
 * the result can never escape the root. Unlike the local filesystem there is no
 * symlink resolution available to us, so this is lexical only — which is why
 * names are also filtered by `isSafeRemoteName` before being joined.
 *
 * @param {string} p
 * @returns {string} always absolute, no trailing slash except for '/'
 */
export function normaliseRemotePath(p) {
  const raw = typeof p === 'string' ? p : ''
  const parts = raw.replace(/\\/g, '/').split('/')
  /** @type {string[]} */
  const out = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  return '/' + out.join('/')
}

/**
 * Join a validated child name onto a remote directory path.
 *
 * @param {string} base
 * @param {string} name  must already have passed `isSafeRemoteName`
 * @returns {string}
 */
export function joinRemotePath(base, name) {
  if (!isSafeRemoteName(name)) throw new Error(`Unsafe remote name: ${JSON.stringify(name)}`)
  const b = normaliseRemotePath(base)
  return b === '/' ? `/${name}` : `${b}/${name}`
}

// ── LIST output parsing ────────────────────────────────────────────────────

/**
 * @typedef {object} FtpEntry
 * @property {string} name
 * @property {boolean} isDirectory
 * @property {boolean} isSymlink
 * @property {string|null} linkTarget
 * @property {number} size            0 for directories
 * @property {Date|null} mtime        null when the format carried no usable date
 * @property {'unix'|'dos'} format
 * @property {boolean} unsafe         name failed `isSafeRemoteName`
 * @property {string} raw
 */

/**
 * Split a line into tokens, keeping each token's offset so a filename
 * containing spaces can be recovered from the original line.
 *
 * @param {string} line
 * @returns {{value: string, start: number, end: number}[]}
 */
function tokenise(line) {
  const out = []
  const re = /\S+/g
  let m
  while ((m = re.exec(line)) !== null) {
    out.push({ value: m[0], start: m.index, end: m.index + m[0].length })
  }
  return out
}

/**
 * Rebuild the year for a Unix listing that printed `Mmm dd hh:mm`.
 *
 * `ls` drops the year for recent files and prints it instead of the time for
 * old ones, so a bare time means "within roughly the last six months". A date
 * that lands in the future therefore belongs to the previous year.
 *
 * @param {number} month 0-based
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {Date} now injected so the test suite is not calendar-dependent
 * @returns {Date}
 */
function inferUnixYear(month, day, hour, minute, now) {
  const year = now.getUTCFullYear()
  let d = new Date(Date.UTC(year, month, day, hour, minute))
  // Allow a day of slack for timezone skew between server and client.
  if (d.getTime() - now.getTime() > 24 * 3600 * 1000) {
    d = new Date(Date.UTC(year - 1, month, day, hour, minute))
  }
  return d
}

/**
 * Parse one Unix (`ls -l`) style LIST line.
 *
 * The permission/owner/group columns vary between servers — some omit the
 * group, some append an ACL marker (`+`, `.`, `@`) to the mode — so the line is
 * anchored on the *date* triple instead of counting columns. Size is the token
 * immediately before it, and everything after it is the name (which may contain
 * spaces, and for a symlink ends with ` -> target`).
 *
 * @param {string} line
 * @param {Date} [now]
 * @returns {FtpEntry|null}
 */
export function parseUnixListLine(line, now = new Date()) {
  if (typeof line !== 'string') return null
  const modeMatch = /^([-dbclpsD])([rwxstST-]{9})[.+@]?(?=\s)/.exec(line)
  if (!modeMatch) return null

  const tokens = tokenise(line)
  if (tokens.length < 5) return null

  // Locate `Mmm dd (hh:mm|yyyy)` starting after the mode column.
  let di = -1
  for (let i = 1; i + 2 < tokens.length; i++) {
    const mon = MONTHS[tokens[i].value.slice(0, 3).toLowerCase()]
    if (mon === undefined || tokens[i].value.length > 9) continue
    if (!/^\d{1,2}$/.test(tokens[i + 1].value)) continue
    if (!/^(\d{1,2}:\d{2}|\d{4})$/.test(tokens[i + 2].value)) continue
    di = i
    break
  }
  if (di < 1) return null

  const sizeTok = tokens[di - 1]
  if (!/^\d[\d,]*$/.test(sizeTok.value)) return null
  const size = Number(sizeTok.value.replace(/,/g, ''))

  const month = MONTHS[tokens[di].value.slice(0, 3).toLowerCase()]
  const day = Number(tokens[di + 1].value)
  const third = tokens[di + 2].value
  /** @type {Date|null} */
  let mtime
  if (third.includes(':')) {
    const [h, mi] = third.split(':').map(Number)
    mtime = inferUnixYear(month, day, h, mi, now)
  } else {
    mtime = new Date(Date.UTC(Number(third), month, day))
  }
  if (Number.isNaN(mtime.getTime())) mtime = null

  let name = line.slice(tokens[di + 2].end).replace(/^\s/, '')
  if (name === '') return null

  const typeChar = modeMatch[1]
  const isSymlink = typeChar === 'l'
  /** @type {string|null} */
  let linkTarget = null
  if (isSymlink) {
    const arrow = name.indexOf(' -> ')
    if (arrow !== -1) {
      linkTarget = name.slice(arrow + 4)
      name = name.slice(0, arrow)
    }
  }

  return {
    name,
    isDirectory: typeChar === 'd' || typeChar === 'D',
    isSymlink,
    linkTarget,
    size: typeChar === 'd' ? 0 : size,
    mtime,
    format: 'unix',
    unsafe: !isSafeRemoteName(name),
    raw: line,
  }
}

/**
 * Parse one DOS / IIS style LIST line:
 * `03-10-25  12:34PM       <DIR>          folder name`
 *
 * The date is `MM-DD-YY` (or `MM/DD/YY`), i.e. US order — reading it as
 * day-first silently produces wrong dates for the first twelve days of a month,
 * which is the sort of bug that survives for years.
 *
 * @param {string} line
 * @returns {FtpEntry|null}
 */
export function parseDosListLine(line) {
  if (typeof line !== 'string') return null
  const m = /^\s*(\d{2})[-/](\d{2})[-/](\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\s+(<DIR>|[\d,]+)\s+(.+)$/i.exec(line)
  if (!m) return null

  const month = Number(m[1])
  const day = Number(m[2])
  let year = Number(m[3])
  if (m[3].length === 2) year += year < 70 ? 2000 : 1900
  let hour = Number(m[4])
  const minute = Number(m[5])
  const ampm = m[6]?.toUpperCase()
  if (ampm === 'PM' && hour < 12) hour += 12
  if (ampm === 'AM' && hour === 12) hour = 0

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null

  const isDirectory = m[7].toUpperCase() === '<DIR>'
  const size = isDirectory ? 0 : Number(m[7].replace(/,/g, ''))
  const name = m[8].replace(/\s+$/, '')
  if (name === '') return null

  let mtime = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (Number.isNaN(mtime.getTime())) mtime = null

  return {
    name,
    isDirectory,
    isSymlink: false,
    linkTarget: null,
    size,
    mtime,
    format: 'dos',
    unsafe: !isSafeRemoteName(name),
    raw: line,
  }
}

/**
 * Parse a single LIST line in either supported format.
 *
 * @param {string} line
 * @param {Date} [now]
 * @returns {FtpEntry|null} null when the line is not a recognisable entry
 */
export function parseListLine(line, now = new Date()) {
  if (typeof line !== 'string' || line.trim() === '') return null
  return parseUnixListLine(line, now) ?? parseDosListLine(line)
}

/**
 * Parse a whole LIST response.
 *
 * Unparseable lines (`total 42` headers, vendor banners, garbage) are counted
 * rather than thrown on: one odd line must not make a whole directory
 * unreadable. Entries whose name fails the safety check are dropped — see
 * `isSafeRemoteName` — and reported separately so the UI can say so.
 *
 * @param {string|Buffer} text
 * @param {{now?: Date, includeUnsafe?: boolean}} [opts]
 * @returns {{entries: FtpEntry[], skipped: number, unsafe: number}}
 */
export function parseListing(text, opts = {}) {
  const now = opts.now ?? new Date()
  const raw = typeof text === 'string' ? text : Buffer.from(text ?? '').toString('utf-8')
  /** @type {FtpEntry[]} */
  const entries = []
  let skipped = 0
  let unsafe = 0

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const entry = parseListLine(line, now)
    if (!entry) { skipped++; continue }
    if (entry.name === '.' || entry.name === '..') continue
    if (entry.unsafe) {
      unsafe++
      if (!opts.includeUnsafe) continue
    }
    entries.push(entry)
  }
  return { entries, skipped, unsafe }
}

// ── Client ─────────────────────────────────────────────────────────────────

/**
 * Wrap a promise in a deadline. Every network wait in this module goes through
 * here: an FTP server that accepts a connection and then says nothing would
 * otherwise hang a comparison forever with no way to cancel.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`FTP timeout after ${ms}ms: ${label}`)), ms)
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ])
}

/**
 * Minimal read-only FTP / FTPS client.
 *
 * Socket construction is injected (`connectFn` / `tlsConnectFn`) so the command
 * sequencing can be exercised against a scripted fake socket. Nothing in the
 * test suite opens a real connection.
 */
export class FtpClient {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port]
   * @param {string} [opts.user]
   * @param {string} [opts.password]
   * @param {boolean} [opts.secure]        explicit FTPS (AUTH TLS)
   * @param {boolean} [opts.rejectUnauthorized] TLS cert validation; default true
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxDownloadBytes]
   * @param {boolean} [opts.trustPasvHost] see below; default false
   * @param {Function} [opts.connectFn]    net.connect replacement
   * @param {Function} [opts.tlsConnectFn] tls.connect replacement
   */
  constructor(opts) {
    if (!opts?.host) throw new Error('FtpClient requires a host')
    this.host = opts.host
    this.port = opts.port ?? 21
    this.user = opts.user ?? 'anonymous'
    this.password = opts.password ?? 'anonymous@'
    this.secure = Boolean(opts.secure)
    this.rejectUnauthorized = opts.rejectUnauthorized !== false
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxDownloadBytes = opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES
    /**
     * A 227 reply names the address the data connection should go to. Honouring
     * it lets a hostile server aim our data connection at an arbitrary host —
     * the classic FTP bounce / SSRF. The control connection's host is used
     * instead unless the caller explicitly opts in.
     */
    this.trustPasvHost = Boolean(opts.trustPasvHost)

    this._connect = opts.connectFn ?? netConnect
    this._tlsConnect = opts.tlsConnectFn ?? tlsConnect

    this._parser = new FtpResponseParser()
    /** @type {FtpResponse[]} */
    this._replies = []
    /** @type {((r: FtpResponse) => void)[]} */
    this._waiters = []
    /** @type {Error|null} */
    this._fatal = null
    this._socket = null
    this._closed = false
  }

  /** @returns {Promise<FtpResponse>} the next unconsumed reply */
  _nextReply() {
    if (this._fatal) return Promise.reject(this._fatal)
    const queued = this._replies.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject })
    })
  }

  /** @param {Error} err */
  _fail(err) {
    this._fatal = err
    for (const w of this._waiters.splice(0)) w.reject(err)
  }

  /** @param {FtpResponse} reply */
  _deliver(reply) {
    const w = this._waiters.shift()
    if (w) w.resolve(reply)
    else this._replies.push(reply)
  }

  /** @param {import('net').Socket} socket */
  _attach(socket) {
    this._socket = socket
    socket.setEncoding?.('utf-8')
    socket.on('data', (chunk) => {
      try {
        for (const reply of this._parser.push(chunk)) this._deliver(reply)
      } catch (err) {
        this._fail(/** @type {Error} */(err))
        socket.destroy()
      }
    })
    socket.on('error', (err) => this._fail(err))
    socket.on('close', () => {
      this._closed = true
      if (!this._fatal) this._fail(new Error('FTP control connection closed'))
    })
  }

  /**
   * Send a raw command and await its reply.
   *
   * @param {string} command
   * @param {{redact?: boolean}} [opts] omit the argument from thrown errors
   * @returns {Promise<FtpResponse>}
   */
  async send(command, opts = {}) {
    if (!this._socket || this._closed) throw new Error('FTP not connected')
    const label = opts.redact ? command.split(' ')[0] + ' ***' : command
    this._socket.write(command + '\r\n')
    return withTimeout(this._nextReply(), this.timeoutMs, label)
  }

  /**
   * Send a command and throw unless the reply code is in `expected`.
   *
   * IL-4: a failed command must surface immediately, not leave the caller
   * inspecting codes it will forget to check.
   *
   * @param {string} command
   * @param {number[]} expected
   * @param {{redact?: boolean}} [opts]
   * @returns {Promise<FtpResponse>}
   */
  async command(command, expected, opts = {}) {
    const reply = await this.send(command, opts)
    if (!expected.includes(reply.code)) {
      const verb = command.split(' ')[0]
      throw new Error(`FTP ${verb} failed: ${reply.code} ${reply.text}`)
    }
    return reply
  }

  /** Open the control connection, upgrade to TLS if requested, and log in. */
  async connect() {
    // Listeners go on before the connect callback is awaited. A server may
    // send its 220 greeting the instant the connection completes, and awaiting
    // first would put the attach a microtask too late — a real socket happens
    // to buffer until something reads, so the race is invisible until it
    // isn't.
    const socket = this._connect({ host: this.host, port: this.port }, () => {})
    this._attach(socket)

    await withTimeout(new Promise((resolve, reject) => {
      // `connect` fires on a real socket; the injected one signals through its
      // callback, which has already run by the time the promise is built, so
      // treat an already-usable socket as connected.
      const done = () => resolve(undefined)
      socket.once('connect', done)
      socket.once('error', reject)
      setImmediate(done)
    }), this.timeoutMs, 'connect')

    const greeting = await withTimeout(this._nextReply(), this.timeoutMs, 'greeting')
    if (greeting.code !== 220) throw new Error(`FTP server refused: ${greeting.code} ${greeting.text}`)

    if (this.secure) {
      await this.command('AUTH TLS', [234])
      const tlsSocket = await withTimeout(new Promise((resolve, reject) => {
        const t = this._tlsConnect({
          socket,
          servername: this.host,
          rejectUnauthorized: this.rejectUnauthorized,
        }, () => resolve(t))
        t.once('error', reject)
      }), this.timeoutMs, 'AUTH TLS handshake')
      // Re-attach: replies now arrive decrypted on the TLS socket.
      socket.removeAllListeners('data')
      this._parser = new FtpResponseParser()
      this._attach(tlsSocket)
      // Protect the data channel too; an unprotected data channel would send
      // file bytes in clear text even though the control channel is encrypted.
      await this.command('PBSZ 0', [200])
      await this.command('PROT P', [200])
    }

    const userReply = await this.send(`USER ${this.user}`)
    if (userReply.code === 331) {
      await this.command(`PASS ${this.password}`, [230, 202], { redact: true })
    } else if (userReply.code !== 230) {
      throw new Error(`FTP login failed: ${userReply.code} ${userReply.text}`)
    }
    await this.command('TYPE I', [200])
    return this
  }

  /**
   * Open a passive-mode data connection.
   *
   * @returns {Promise<import('net').Socket>}
   */
  async _openDataConnection() {
    const reply = await this.command('PASV', [227])
    const { host: advertised, port } = parsePasvResponse(reply.text)
    const host = this.trustPasvHost ? advertised : this.host

    const dataSocket = await withTimeout(new Promise((resolve, reject) => {
      const s = this._connect({ host, port }, () => resolve(s))
      s.once('error', reject)
    }), this.timeoutMs, 'data connect')

    if (this.secure) {
      return await withTimeout(new Promise((resolve, reject) => {
        const t = this._tlsConnect({
          socket: dataSocket,
          servername: this.host,
          rejectUnauthorized: this.rejectUnauthorized,
        }, () => resolve(t))
        t.once('error', reject)
      }), this.timeoutMs, 'data TLS handshake')
    }
    return dataSocket
  }

  /**
   * Drain a data socket into a Buffer, refusing to grow past `maxBytes`.
   *
   * @param {import('net').Socket} socket
   * @param {number} maxBytes
   * @param {string} label
   * @returns {Promise<Buffer>}
   */
  _readData(socket, maxBytes, label) {
    return withTimeout(new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
      const chunks = []
      let total = 0
      socket.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buf.length
        if (total > maxBytes) {
          socket.destroy()
          reject(new Error(`${label} exceeded ${maxBytes} bytes`))
          return
        }
        chunks.push(buf)
      })
      socket.on('error', reject)
      socket.on('end', () => resolve(Buffer.concat(chunks)))
      socket.on('close', () => resolve(Buffer.concat(chunks)))
    }), this.timeoutMs, label)
  }

  /**
   * List a remote directory.
   *
   * @param {string} [path]
   * @returns {Promise<{entries: FtpEntry[], skipped: number, unsafe: number}>}
   */
  async list(path = '.') {
    const target = path === '.' ? '.' : normaliseRemotePath(path)
    const dataSocket = await this._openDataConnection()
    const preliminary = await this.send(`LIST ${target}`)
    if (![125, 150].includes(preliminary.code)) {
      dataSocket.destroy()
      throw new Error(`FTP LIST failed: ${preliminary.code} ${preliminary.text}`)
    }
    const buf = await this._readData(dataSocket, MAX_LISTING_BYTES, 'LIST')
    const done = await withTimeout(this._nextReply(), this.timeoutMs, 'LIST completion')
    if (![226, 250].includes(done.code)) {
      throw new Error(`FTP LIST failed: ${done.code} ${done.text}`)
    }
    return parseListing(buf)
  }

  /**
   * Download a remote file.
   *
   * @param {string} path
   * @param {{maxBytes?: number}} [opts]
   * @returns {Promise<Buffer>}
   */
  async download(path, opts = {}) {
    const target = normaliseRemotePath(path)
    // A per-call limit may lower the ceiling but never raise it: the
    // client-wide setting is the operator's decision, and the hard constant
    // backstops both.
    const limit = Math.min(
      opts.maxBytes ?? this.maxDownloadBytes,
      this.maxDownloadBytes,
      MAX_DOWNLOAD_BYTES)
    const dataSocket = await this._openDataConnection()
    const preliminary = await this.send(`RETR ${target}`)
    if (![125, 150].includes(preliminary.code)) {
      dataSocket.destroy()
      throw new Error(`FTP RETR failed: ${preliminary.code} ${preliminary.text}`)
    }
    const buf = await this._readData(dataSocket, limit, 'RETR')
    const done = await withTimeout(this._nextReply(), this.timeoutMs, 'RETR completion')
    if (![226, 250].includes(done.code)) {
      throw new Error(`FTP RETR failed: ${done.code} ${done.text}`)
    }
    return buf
  }

  /**
   * @param {string} path
   * @returns {Promise<number>}
   */
  async size(path) {
    const reply = await this.command(`SIZE ${normaliseRemotePath(path)}`, [213])
    return parseSizeResponse(reply.text)
  }

  /**
   * @param {string} path
   * @returns {Promise<Date>}
   */
  async modifiedAt(path) {
    const reply = await this.command(`MDTM ${normaliseRemotePath(path)}`, [213])
    return parseMdtmResponse(reply.text)
  }

  /** @returns {Promise<string>} the server's current working directory */
  async pwd() {
    const reply = await this.command('PWD', [257])
    const m = /"((?:[^"]|"")*)"/.exec(reply.text)
    return m ? m[1].replace(/""/g, '"') : reply.text.trim()
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async cwd(path) {
    await this.command(`CWD ${normaliseRemotePath(path)}`, [200, 250])
  }

  /** Say QUIT if we can, then tear the socket down regardless. */
  async close() {
    if (this._socket && !this._closed) {
      try {
        await this.send('QUIT')
      } catch {
        // The server hanging up mid-QUIT is normal; nothing to recover.
      }
    }
    this._socket?.destroy()
    this._closed = true
    this._socket = null
  }
}
