/**
 * @file remote-sftp.js
 * @description Read-only SFTP version 3 client, layered on the SSH transport in
 *   `ssh-transport.js`. SFTP is not "FTP over TLS" and shares nothing with
 *   `remote-ftp.js` on the wire: it is a request/response packet protocol
 *   carried inside an SSH `subsystem` channel.
 *
 * ⚠️ PRIVACY / NETWORK EGRESS WARNING
 *   Using this module sends the user's credentials to, and downloads file
 *   content from, a **third-party server the user nominated**. File bytes and
 *   directory names leave the machine. Callers must make that explicit in the
 *   UI before connecting, and must never wire this into a background path.
 *
 * ## Scope
 *
 * Implemented: INIT/VERSION, REALPATH, OPENDIR/READDIR/CLOSE, OPEN/READ/CLOSE,
 * STAT/LSTAT/FSTAT, READLINK.
 *
 * Deliberately absent: WRITE, REMOVE, RENAME, MKDIR, RMDIR, SETSTAT and every
 * other mutating request. Comparison only reads, and a client with no write
 * verb cannot damage a remote tree however badly it is driven. Protocol
 * versions above 3 are also not implemented — v3 is what every server speaks,
 * and v4+ changes the attribute encoding incompatibly.
 *
 * ## Untrusted input
 *
 * Every filename in a READDIR response is chosen by the server. A hostile or
 * compromised server can answer with `..`, an absolute path, or a name carrying
 * control characters, and if that reaches a local `join()` the server decides
 * where downloaded bytes land. Names are therefore filtered through the same
 * `isSafeRemoteName` / `normaliseRemotePath` used by the FTP client rather than
 * a second implementation — one rule, one place to fix.
 *
 * Everything above `SftpClient` is a pure buffer -> object function, so the
 * packet and attribute parsing is tested without a network or an SSH server.
 */

import {
  SSHReader,
  SSHTransport,
  encodeString,
  encodeUint32,
  encodeUint64,
  withTimeout,
} from './ssh-transport.js'
import { isSafeRemoteName, joinRemotePath, normaliseRemotePath } from './remote-ftp.js'

/** The only protocol version this client implements. */
export const SFTP_VERSION = 3

/** Every request is bounded; a server that stalls must not hang a comparison. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Hard ceiling on one download, so a hostile server cannot exhaust RAM. */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

/** Hard ceiling on entries returned for one directory. */
export const MAX_DIRECTORY_ENTRIES = 200_000

/**
 * A single SFTP packet this large is an attack, not a response. Chosen well
 * above the largest READ reply we ever ask for.
 */
export const MAX_PACKET_BYTES = 4 * 1024 * 1024

/**
 * Bytes per READ request. Servers commonly cap a single read at 32 KiB, so
 * asking for more just produces short reads.
 */
export const READ_CHUNK_BYTES = 32 * 1024

// ── Packet types (draft-ietf-secsh-filexfer-02) ────────────────────────────

export const FXP = Object.freeze({
  INIT: 1,
  VERSION: 2,
  OPEN: 3,
  CLOSE: 4,
  READ: 5,
  LSTAT: 7,
  FSTAT: 8,
  OPENDIR: 11,
  READDIR: 12,
  REALPATH: 16,
  STAT: 17,
  READLINK: 19,
  STATUS: 101,
  HANDLE: 102,
  DATA: 103,
  NAME: 104,
  ATTRS: 105,
})

export const FX = Object.freeze({
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
})

const STATUS_TEXT = Object.freeze({
  0: 'OK',
  1: 'end of file',
  2: 'no such file',
  3: 'permission denied',
  4: 'failure',
  5: 'bad message',
  6: 'no connection',
  7: 'connection lost',
  8: 'operation unsupported',
})

/** Open flags. Only READ is ever used — this client has no write path. */
export const SSH_FXF_READ = 0x00000001

export const ATTR_FLAGS = Object.freeze({
  SIZE: 0x00000001,
  UIDGID: 0x00000002,
  PERMISSIONS: 0x00000004,
  ACMODTIME: 0x00000008,
  EXTENDED: 0x80000000,
})

/** POSIX file type mask and the two types that change how an entry is shown. */
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

/**
 * @param {number} code
 * @returns {string}
 */
export function sftpStatusText(code) {
  return STATUS_TEXT[code] ?? `unknown status ${code}`
}

// ── Packet framing ─────────────────────────────────────────────────────────

/**
 * Frame one SFTP packet: `uint32 length, byte type, byte[] payload`, where the
 * length counts the type byte.
 *
 * @param {number} type
 * @param {Buffer} payload
 * @returns {Buffer}
 */
export function encodeSftpPacket(type, payload) {
  const body = payload ?? Buffer.alloc(0)
  return Buffer.concat([encodeUint32(body.length + 1), Buffer.from([type]), body])
}

/**
 * Pull every complete packet off the front of a receive buffer.
 *
 * SFTP rides on an SSH channel, so packet boundaries and channel data
 * boundaries are unrelated: one CHANNEL_DATA message may carry half a packet or
 * three of them. Treating a channel read as a packet is the classic bug here.
 *
 * @param {Buffer} buffer
 * @param {{maxPacketBytes?: number}} [opts]
 * @returns {{packets: {type: number, payload: Buffer}[], rest: Buffer}}
 */
export function decodeSftpPackets(buffer, opts = {}) {
  const max = opts.maxPacketBytes ?? MAX_PACKET_BYTES
  /** @type {{type: number, payload: Buffer}[]} */
  const packets = []
  let offset = 0
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32BE(offset)
    if (length < 1 || length > max) {
      throw new Error(`Implausible SFTP packet length: ${length}`)
    }
    if (buffer.length - offset < 4 + length) break
    packets.push({
      type: buffer[offset + 4],
      payload: Buffer.from(buffer.subarray(offset + 5, offset + 4 + length)),
    })
    offset += 4 + length
  }
  return { packets, rest: Buffer.from(buffer.subarray(offset)) }
}

// ── Attributes ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} SftpAttrs
 * @property {number|null} size
 * @property {number|null} uid
 * @property {number|null} gid
 * @property {number|null} permissions  POSIX mode, type bits included
 * @property {Date|null} atime
 * @property {Date|null} mtime
 * @property {boolean} isDirectory
 * @property {boolean} isSymlink
 * @property {boolean} isFile
 */

/**
 * Read a v3 ATTRS structure from a cursor.
 *
 * Every field is optional and announced by the flags word, so the fields must
 * be consumed in order and only when flagged — reading a fixed layout
 * desynchronises the rest of the packet, which for a NAME response means every
 * subsequent filename is garbage.
 *
 * @param {SSHReader} reader
 * @returns {SftpAttrs}
 */
export function readAttrs(reader) {
  const flags = reader.readUint32()
  /** @type {SftpAttrs} */
  const attrs = {
    size: null,
    uid: null,
    gid: null,
    permissions: null,
    atime: null,
    mtime: null,
    isDirectory: false,
    isSymlink: false,
    isFile: false,
  }

  if (flags & ATTR_FLAGS.SIZE) {
    const size = reader.readUint64()
    // Beyond 2^53 a JS number stops being exact; a file that large cannot be
    // compared in memory anyway, so clamping is honest rather than lossy.
    attrs.size = size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(size)
  }
  if (flags & ATTR_FLAGS.UIDGID) {
    attrs.uid = reader.readUint32()
    attrs.gid = reader.readUint32()
  }
  if (flags & ATTR_FLAGS.PERMISSIONS) {
    attrs.permissions = reader.readUint32()
    const type = attrs.permissions & S_IFMT
    attrs.isDirectory = type === S_IFDIR
    attrs.isSymlink = type === S_IFLNK
    attrs.isFile = type !== 0 && !attrs.isDirectory && !attrs.isSymlink
  }
  if (flags & ATTR_FLAGS.ACMODTIME) {
    // v3 timestamps are seconds since the epoch, unsigned.
    attrs.atime = new Date(reader.readUint32() * 1000)
    attrs.mtime = new Date(reader.readUint32() * 1000)
  }
  if (flags & ATTR_FLAGS.EXTENDED) {
    const count = reader.readUint32()
    if (count > 1024) throw new Error('SFTP attributes carry an implausible extension count')
    for (let i = 0; i < count; i++) {
      reader.readBytes(65536)
      reader.readBytes(65536)
    }
  }
  return attrs
}

/**
 * @typedef {object} SftpEntry
 * @property {string} name       single path component as sent by the server
 * @property {string} longname   `ls -l` style line, v3 only; display use only
 * @property {SftpAttrs} attrs
 * @property {boolean} unsafe    name failed `isSafeRemoteName`
 */

/**
 * Parse a NAME response.
 *
 * @param {Buffer} payload  everything after the type byte
 * @param {{maxEntries?: number}} [opts]
 * @returns {{id: number, entries: SftpEntry[]}}
 */
export function parseNameResponse(payload, opts = {}) {
  const r = new SSHReader(payload)
  const id = r.readUint32()
  const count = r.readUint32()
  const max = opts.maxEntries ?? MAX_DIRECTORY_ENTRIES
  if (count > max) throw new Error(`SFTP NAME response claims ${count} entries; refusing`)

  /** @type {SftpEntry[]} */
  const entries = []
  for (let i = 0; i < count; i++) {
    const name = r.readString(4096)
    const longname = r.readString(8192)
    const attrs = readAttrs(r)
    entries.push({ name, longname, attrs, unsafe: !isSafeRemoteName(name) })
  }
  return { id, entries }
}

/**
 * @param {Buffer} payload
 * @returns {{id: number, code: number, message: string}}
 */
export function parseStatusResponse(payload) {
  const r = new SSHReader(payload)
  const id = r.readUint32()
  const code = r.readUint32()
  let message = ''
  // v3 servers are supposed to send a message and language tag, but some omit
  // them entirely. A missing message must not turn a plain "no such file" into
  // a parse error.
  try {
    message = r.readString(8192)
  } catch {
    message = ''
  }
  return { id, code, message: message || sftpStatusText(code) }
}

/**
 * @param {Buffer} payload
 * @returns {{id: number, handle: Buffer}}
 */
export function parseHandleResponse(payload) {
  const r = new SSHReader(payload)
  const id = r.readUint32()
  // RFC caps a handle at 256 bytes; anything longer is a server trying to make
  // us echo an oversized blob back.
  return { id, handle: Buffer.from(r.readBytes(256)) }
}

/**
 * @param {Buffer} payload
 * @returns {{id: number, data: Buffer}}
 */
export function parseDataResponse(payload) {
  const r = new SSHReader(payload)
  const id = r.readUint32()
  return { id, data: Buffer.from(r.readBytes(MAX_PACKET_BYTES)) }
}

/**
 * @param {Buffer} payload
 * @returns {{id: number, attrs: SftpAttrs}}
 */
export function parseAttrsResponse(payload) {
  const r = new SSHReader(payload)
  const id = r.readUint32()
  return { id, attrs: readAttrs(r) }
}

/**
 * Parse the server's VERSION reply, including its extension pairs.
 *
 * @param {Buffer} payload
 * @returns {{version: number, extensions: Record<string, string>}}
 */
export function parseVersionResponse(payload) {
  const r = new SSHReader(payload)
  const version = r.readUint32()
  /** @type {Record<string, string>} */
  const extensions = {}
  while (r.remaining > 0) {
    const name = r.readString(1024)
    const data = r.readString(65536)
    extensions[name] = data
  }
  return { version, extensions }
}

// ── Client ─────────────────────────────────────────────────────────────────

/**
 * Read-only SFTP v3 client.
 *
 * The channel is injected rather than constructed, which is the seam the tests
 * use: a fake channel with `write` / `onData` exercises the whole request and
 * response path without an SSH server, and `connectSftp` supplies the real one.
 */
export class SftpClient {
  /**
   * @param {object} opts
   * @param {{write: (data: Buffer) => Promise<void>|void, onData: ((d: Buffer) => void)|null,
   *          close?: () => Promise<void>|void}} opts.channel
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxDownloadBytes]
   */
  constructor(opts) {
    if (!opts?.channel) throw new Error('SftpClient requires a channel')
    this.channel = opts.channel
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxDownloadBytes = opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES
    this.version = 0
    /** @type {Record<string, string>} */
    this.extensions = {}

    this._buffer = Buffer.alloc(0)
    this._nextId = 1
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this._pending = new Map()
    /** @type {((p: {type: number, payload: Buffer}) => void)|null} */
    this._versionWaiter = null
    /** @type {Error|null} */
    this._fatal = null

    this.channel.onData = (data) => this._onData(data)
  }

  /** @param {Buffer} data */
  _onData(data) {
    if (this._fatal) return
    try {
      this._buffer = Buffer.concat([this._buffer, data])
      const { packets, rest } = decodeSftpPackets(this._buffer)
      this._buffer = rest
      for (const packet of packets) this._route(packet)
    } catch (err) {
      this._fail(/** @type {Error} */(err))
    }
  }

  /** @param {{type: number, payload: Buffer}} packet */
  _route(packet) {
    if (packet.type === FXP.VERSION) {
      this._versionWaiter?.(packet)
      this._versionWaiter = null
      return
    }
    if (packet.payload.length < 4) throw new Error('SFTP response is missing its request id')
    const id = packet.payload.readUInt32BE(0)
    const waiter = this._pending.get(id)
    // An unmatched id is a server bug or a stale response after a timeout;
    // dropping it is correct, but never silently — see `_fail` for real errors.
    if (!waiter) return
    this._pending.delete(id)
    waiter.resolve(packet)
  }

  /** @param {Error} err */
  _fail(err) {
    this._fatal = err
    for (const waiter of this._pending.values()) waiter.reject(err)
    this._pending.clear()
  }

  /**
   * Send one request and await the matching response.
   *
   * @param {number} type
   * @param {(id: number) => Buffer} build payload builder, given the request id
   * @param {string} label
   * @returns {Promise<{type: number, payload: Buffer}>}
   */
  async _request(type, build, label) {
    if (this._fatal) throw this._fatal
    const id = this._nextId
    // uint32 wraparound: ids must stay unique among *outstanding* requests, and
    // 1 rather than 0 keeps id 0 free as an obvious "unset" value.
    this._nextId = this._nextId >= 0xfffffffe ? 1 : this._nextId + 1

    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
    })
    await this.channel.write(encodeSftpPacket(type, build(id)))
    try {
      return await withTimeout(promise, this.timeoutMs, label)
    } catch (err) {
      this._pending.delete(id)
      throw err
    }
  }

  /**
   * @param {{type: number, payload: Buffer}} packet
   * @param {string} what
   * @returns {never}
   */
  _throwStatus(packet, what) {
    if (packet.type !== FXP.STATUS) {
      throw new Error(`SFTP ${what}: unexpected response type ${packet.type}`)
    }
    const status = parseStatusResponse(packet.payload)
    throw new Error(`SFTP ${what} failed (${sftpStatusText(status.code)}): ${status.message}`)
  }

  /** Negotiate the protocol version. Must be called before anything else. */
  async connect() {
    const versionPacket = new Promise((resolve) => {
      this._versionWaiter = resolve
    })
    await this.channel.write(encodeSftpPacket(FXP.INIT, encodeUint32(SFTP_VERSION)))
    const packet = await withTimeout(versionPacket, this.timeoutMs, 'SFTP INIT')
    const parsed = parseVersionResponse(packet.payload)
    if (parsed.version < SFTP_VERSION) {
      throw new Error(`Server offers SFTP version ${parsed.version}; version 3 is the minimum supported`)
    }
    // A server answering with 4+ still has to speak 3 when that is what we
    // asked for; we simply never send a v4 construct.
    this.version = SFTP_VERSION
    this.extensions = parsed.extensions
    return this
  }

  /**
   * Resolve a path to its canonical absolute form.
   *
   * The server's answer is still normalised locally: the point of asking is to
   * expand `.` and `~`, not to obtain a path we then trust verbatim.
   *
   * @param {string} path
   * @returns {Promise<string>}
   */
  async realpath(path) {
    const packet = await this._request(
      FXP.REALPATH,
      (id) => Buffer.concat([encodeUint32(id), encodeString(path ?? '.')]),
      'REALPATH')
    if (packet.type !== FXP.NAME) this._throwStatus(packet, 'REALPATH')
    const { entries } = parseNameResponse(packet.payload, { maxEntries: 16 })
    if (entries.length === 0) throw new Error('SFTP REALPATH returned no name')
    return normaliseRemotePath(entries[0].name)
  }

  /**
   * @param {string} path
   * @param {{followSymlinks?: boolean}} [opts]
   * @returns {Promise<SftpAttrs>}
   */
  async stat(path, opts = {}) {
    const follow = opts.followSymlinks !== false
    const packet = await this._request(
      follow ? FXP.STAT : FXP.LSTAT,
      (id) => Buffer.concat([encodeUint32(id), encodeString(normaliseRemotePath(path))]),
      follow ? 'STAT' : 'LSTAT')
    if (packet.type !== FXP.ATTRS) this._throwStatus(packet, follow ? 'STAT' : 'LSTAT')
    return parseAttrsResponse(packet.payload).attrs
  }

  /**
   * @param {Buffer} handle
   * @returns {Promise<SftpAttrs>}
   */
  async fstat(handle) {
    const packet = await this._request(
      FXP.FSTAT,
      (id) => Buffer.concat([encodeUint32(id), encodeString(handle)]),
      'FSTAT')
    if (packet.type !== FXP.ATTRS) this._throwStatus(packet, 'FSTAT')
    return parseAttrsResponse(packet.payload).attrs
  }

  /**
   * @param {string} path
   * @returns {Promise<string>}
   */
  async readlink(path) {
    const packet = await this._request(
      FXP.READLINK,
      (id) => Buffer.concat([encodeUint32(id), encodeString(normaliseRemotePath(path))]),
      'READLINK')
    if (packet.type !== FXP.NAME) this._throwStatus(packet, 'READLINK')
    const { entries } = parseNameResponse(packet.payload, { maxEntries: 16 })
    return entries[0]?.name ?? ''
  }

  /**
   * @param {Buffer} handle
   * @returns {Promise<void>}
   */
  async closeHandle(handle) {
    try {
      await this._request(
        FXP.CLOSE,
        (id) => Buffer.concat([encodeUint32(id), encodeString(handle)]),
        'CLOSE')
    } catch {
      // The handle is server-side state we are abandoning either way; a failed
      // close must not mask the error that led here.
    }
  }

  /**
   * List a directory.
   *
   * READDIR returns entries in batches until the server answers EOF, so this
   * loops. Entries whose name is unsafe as a local path component are dropped
   * and counted rather than returned — see the module header.
   *
   * @param {string} path
   * @param {{includeUnsafe?: boolean, maxEntries?: number}} [opts]
   * @returns {Promise<{path: string, entries: (SftpEntry & {path: string})[], unsafe: number}>}
   */
  async list(path, opts = {}) {
    const dir = normaliseRemotePath(path)
    const maxEntries = Math.min(opts.maxEntries ?? MAX_DIRECTORY_ENTRIES, MAX_DIRECTORY_ENTRIES)

    const opened = await this._request(
      FXP.OPENDIR,
      (id) => Buffer.concat([encodeUint32(id), encodeString(dir)]),
      'OPENDIR')
    if (opened.type !== FXP.HANDLE) this._throwStatus(opened, 'OPENDIR')
    const handle = parseHandleResponse(opened.payload).handle

    /** @type {(SftpEntry & {path: string})[]} */
    const entries = []
    let unsafe = 0
    try {
      for (;;) {
        const packet = await this._request(
          FXP.READDIR,
          (id) => Buffer.concat([encodeUint32(id), encodeString(handle)]),
          'READDIR')
        if (packet.type === FXP.STATUS) {
          const status = parseStatusResponse(packet.payload)
          if (status.code === FX.EOF) break
          this._throwStatus(packet, 'READDIR')
        }
        if (packet.type !== FXP.NAME) this._throwStatus(packet, 'READDIR')

        // The parse limit is the absolute one, not the caller's total cap: a
        // server may legitimately answer with a batch larger than the number of
        // entries this call intends to keep.
        const batch = parseNameResponse(packet.payload, { maxEntries: MAX_DIRECTORY_ENTRIES })
        // A server that keeps answering NAME forever would otherwise loop us
        // indefinitely; an empty batch is not EOF but it is not progress either.
        if (batch.entries.length === 0) break
        for (const entry of batch.entries) {
          if (entry.name === '.' || entry.name === '..') continue
          if (entry.unsafe) {
            unsafe++
            if (!opts.includeUnsafe) continue
          }
          entries.push({
            ...entry,
            path: entry.unsafe ? `${dir}/${entry.name}` : joinRemotePath(dir, entry.name),
          })
          if (entries.length >= maxEntries) {
            return { path: dir, entries, unsafe }
          }
        }
      }
    } finally {
      await this.closeHandle(handle)
    }
    return { path: dir, entries, unsafe }
  }

  /**
   * Download a file.
   *
   * Reads are issued sequentially at an explicit offset. A short read is not
   * EOF in SFTP — only a STATUS of EOF is — so the loop keeps going until the
   * server says so or the size limit is hit.
   *
   * @param {string} path
   * @param {{maxBytes?: number}} [opts]
   * @returns {Promise<Buffer>}
   */
  async download(path, opts = {}) {
    const target = normaliseRemotePath(path)
    // A per-call limit may lower the ceiling but never raise it: the
    // client-wide setting is the operator's decision and the hard constant
    // backstops both.
    const limit = Math.min(
      opts.maxBytes ?? this.maxDownloadBytes,
      this.maxDownloadBytes,
      MAX_DOWNLOAD_BYTES)

    const opened = await this._request(
      FXP.OPEN,
      (id) => Buffer.concat([
        encodeUint32(id),
        encodeString(target),
        encodeUint32(SSH_FXF_READ),
        encodeUint32(0), // no attribute flags: opening for read sets nothing
      ]),
      'OPEN')
    if (opened.type !== FXP.HANDLE) this._throwStatus(opened, 'OPEN')
    const handle = parseHandleResponse(opened.payload).handle

    /** @type {Buffer[]} */
    const chunks = []
    let offset = 0
    try {
      for (;;) {
        const packet = await this._request(
          FXP.READ,
          (id) => Buffer.concat([
            encodeUint32(id),
            encodeString(handle),
            encodeUint64(offset),
            encodeUint32(READ_CHUNK_BYTES),
          ]),
          'READ')
        if (packet.type === FXP.STATUS) {
          const status = parseStatusResponse(packet.payload)
          if (status.code === FX.EOF) break
          this._throwStatus(packet, 'READ')
        }
        if (packet.type !== FXP.DATA) this._throwStatus(packet, 'READ')

        const { data } = parseDataResponse(packet.payload)
        if (data.length === 0) break
        offset += data.length
        if (offset > limit) {
          throw new Error(`SFTP download of ${target} exceeded ${limit} bytes`)
        }
        chunks.push(data)
      }
    } finally {
      await this.closeHandle(handle)
    }
    return Buffer.concat(chunks)
  }

  /** @returns {Promise<void>} */
  async close() {
    this.channel.onData = null
    await this.channel.close?.()
  }
}

/**
 * Open an authenticated SFTP session.
 *
 * Every dependency the tests or an interop harness need to control is a
 * parameter: the socket factory, the known-hosts material, and the
 * trust-on-first-use decision. There is no default that accepts an unknown host
 * key — omitting `onUnknownHostKey` makes the connection fail closed.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port]
 * @param {string} opts.user
 * @param {string} [opts.password]
 * @param {{privateKey: import('crypto').KeyObject|string, publicKeyRaw: Buffer}} [opts.identity]
 * @param {string|import('./ssh-transport.js').KnownHostEntry[]} [opts.knownHosts]
 * @param {Function} [opts.onUnknownHostKey]
 * @param {Function} [opts.onHostKeyAccepted]
 * @param {Function} [opts.connectFn] `net.connect` replacement
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxDownloadBytes]
 * @returns {Promise<{client: SftpClient, transport: SSHTransport}>}
 */
export async function connectSftp(opts) {
  if (!opts?.host) throw new Error('connectSftp requires a host')
  if (!opts?.user) throw new Error('connectSftp requires a user')

  const transport = new SSHTransport({
    host: opts.host,
    port: opts.port ?? 22,
    timeoutMs: opts.timeoutMs,
    connectFn: opts.connectFn,
    knownHosts: opts.knownHosts,
    onUnknownHostKey: opts.onUnknownHostKey,
    onHostKeyAccepted: opts.onHostKeyAccepted,
  })

  try {
    await transport.connect()
    await transport.authenticate({
      user: opts.user,
      password: opts.password,
      identity: opts.identity,
    })
    const channel = await transport.openSubsystem('sftp')
    const client = new SftpClient({
      channel,
      timeoutMs: opts.timeoutMs,
      maxDownloadBytes: opts.maxDownloadBytes,
    })
    await client.connect()
    return { client, transport }
  } catch (err) {
    await transport.close().catch(() => {})
    throw err
  }
}
