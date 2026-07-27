/**
 * @file ssh-transport.js
 * @description SSH-2 transport and connection layer (RFC 4251/4252/4253/4254)
 *   built entirely on Node's `crypto` and `net`. It exists so that SFTP —
 *   which is an SSH subsystem, not a variant of FTP — can be spoken without a
 *   new npm dependency.
 *
 * ⚠️ PRIVACY / NETWORK EGRESS WARNING
 *   Every function here that touches a socket sends the user's credentials to,
 *   and receives file content from, a **third-party server the user nominated**.
 *   Opening a remote comparison therefore transmits the user's data off the
 *   machine. Callers must surface that before connecting, and this module must
 *   never be wired to an automatic or background code path.
 *
 * ## On "hand-rolled cryptography"
 *
 * Earlier revisions of `remote-ftp.js` / `remote-profiles.js` claimed SFTP was
 * impossible here because it would mean hand-rolling cryptography. That was
 * wrong, and worth stating precisely: no primitive is implemented in this file.
 * Node supplies every one of them —
 *
 *   - `generateKeyPairSync('x25519')` + `diffieHellman()` → curve25519-sha256
 *   - `createCipheriv('aes-256-ctr' | 'aes-256-gcm')`      → record encryption
 *   - `createHmac('sha256' | 'sha512')`                    → hmac-sha2-*
 *   - `verify()` over ed25519 / RSA keys                   → host-key signatures
 *
 * What this file contributes is *framing and sequencing*: the binary packet
 * format, algorithm negotiation, the exchange hash, the RFC 4253 §7.2 key
 * schedule, and the trust decision around the server's host key. Those are
 * serialisation formats, not cryptographic constructions — and they are exactly
 * what the unit tests cover.
 *
 * ## Scope
 *
 * Implemented: version exchange, binary packet protocol, KEXINIT negotiation,
 * curve25519-sha256 key exchange, ssh-ed25519 / rsa-sha2-* host-key
 * verification, aes256-ctr + hmac-sha2-{256,512}(-etm) and
 * aes256-gcm@openssh.com record protection, `none`/`password`/`publickey`
 * (ed25519) user authentication, session channels and `subsystem` requests.
 *
 * Deliberately absent: compression (`none` only — a compressor in front of an
 * encryptor is how CRIME happened), key re-exchange (a rekey request from the
 * server ends the connection with a clear error rather than being ignored),
 * X11/agent/port forwarding, and any interactive shell or `exec`. A comparison
 * tool needs one subsystem channel and nothing else.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes as cryptoRandomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'crypto'
import { connect as netConnect } from 'net'

/** Identifies us in the version string; also the `SSH-2.0-` compatibility marker. */
export const CLIENT_VERSION = 'SSH-2.0-MyCompare_0.1'

/** Every network wait in this module is bounded. */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * RFC 4253 requires support for 35000-byte packets. Anything larger is a
 * length field chosen to make us allocate, not a real packet.
 */
export const MAX_PACKET_LENGTH = 256 * 1024

/** A server that sends this many bytes of pre-version banner is not a server. */
export const MAX_BANNER_BYTES = 64 * 1024

// ── Message numbers ────────────────────────────────────────────────────────

export const MSG = Object.freeze({
  DISCONNECT: 1,
  IGNORE: 2,
  UNIMPLEMENTED: 3,
  DEBUG: 4,
  SERVICE_REQUEST: 5,
  SERVICE_ACCEPT: 6,
  EXT_INFO: 7,
  KEXINIT: 20,
  NEWKEYS: 21,
  KEX_ECDH_INIT: 30,
  KEX_ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50,
  USERAUTH_FAILURE: 51,
  USERAUTH_SUCCESS: 52,
  USERAUTH_BANNER: 53,
  USERAUTH_PK_OK: 60,
  GLOBAL_REQUEST: 80,
  REQUEST_SUCCESS: 81,
  REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90,
  CHANNEL_OPEN_CONFIRMATION: 91,
  CHANNEL_OPEN_FAILURE: 92,
  CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94,
  CHANNEL_EXTENDED_DATA: 95,
  CHANNEL_EOF: 96,
  CHANNEL_CLOSE: 97,
  CHANNEL_REQUEST: 98,
  CHANNEL_SUCCESS: 99,
  CHANNEL_FAILURE: 100,
})

// ── Primitive encoding (RFC 4251 §5) ───────────────────────────────────────

/**
 * @param {number} n
 * @returns {Buffer}
 */
export function encodeUint32(n) {
  const b = Buffer.allocUnsafe(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}

/**
 * @param {bigint|number} n
 * @returns {Buffer}
 */
export function encodeUint64(n) {
  const b = Buffer.allocUnsafe(8)
  b.writeBigUInt64BE(BigInt(n), 0)
  return b
}

/**
 * Encode an SSH `string`: a uint32 byte count followed by the bytes. SSH
 * strings are binary, not NUL-terminated and not text — filenames and key blobs
 * both travel this way.
 *
 * @param {string|Buffer|Uint8Array} value
 * @returns {Buffer}
 */
export function encodeString(value) {
  const buf = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value instanceof Uint8Array ? value : String(value), 'utf-8')
  return Buffer.concat([encodeUint32(buf.length), buf])
}

/**
 * Encode an SSH `mpint`: a two's-complement big-endian integer with no
 * redundant leading bytes.
 *
 * The 0x00 prefix when the high bit is set is not cosmetic — without it the
 * value is negative, and since the shared secret K goes into the exchange hash
 * as an mpint, a wrong encoding produces a hash mismatch roughly one time in
 * two. That intermittency is precisely why this is a tested pure function.
 *
 * @param {Buffer|Uint8Array} value big-endian magnitude of a non-negative integer
 * @returns {Buffer}
 */
export function encodeMpint(value) {
  let buf = Buffer.from(value)
  let i = 0
  while (i < buf.length && buf[i] === 0) i++
  buf = buf.subarray(i)
  if (buf.length === 0) return encodeUint32(0)
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf])
  return Buffer.concat([encodeUint32(buf.length), buf])
}

/**
 * Encode a name-list: comma-separated US-ASCII names inside a `string`.
 *
 * @param {string[]} names
 * @returns {Buffer}
 */
export function encodeNameList(names) {
  for (const n of names ?? []) {
    if (typeof n !== 'string' || n.includes(',') || !/^[\x21-\x7e]*$/.test(n)) {
      throw new Error(`Invalid algorithm name: ${JSON.stringify(n)}`)
    }
  }
  return encodeString((names ?? []).join(','))
}

/**
 * @param {boolean} v
 * @returns {Buffer}
 */
export function encodeBoolean(v) {
  return Buffer.from([v ? 1 : 0])
}

/**
 * Cursor over a received packet payload.
 *
 * Every read is bounds-checked and throws, because the buffer is attacker
 * controlled: a truncated NAME response must fail the request, never silently
 * yield a short read that the caller mistakes for real data.
 */
export class SSHReader {
  /** @param {Buffer} buf */
  constructor(buf) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? [])
    this.offset = 0
  }

  /** @returns {number} bytes not yet consumed */
  get remaining() {
    return this.buf.length - this.offset
  }

  /**
   * @param {number} n
   * @returns {void}
   */
  _need(n) {
    if (n < 0 || this.offset + n > this.buf.length) {
      throw new Error('SSH packet truncated')
    }
  }

  /** @returns {number} */
  readByte() {
    this._need(1)
    return this.buf[this.offset++]
  }

  /** @returns {boolean} */
  readBoolean() {
    return this.readByte() !== 0
  }

  /** @returns {number} */
  readUint32() {
    this._need(4)
    const v = this.buf.readUInt32BE(this.offset)
    this.offset += 4
    return v
  }

  /** @returns {bigint} */
  readUint64() {
    this._need(8)
    const v = this.buf.readBigUInt64BE(this.offset)
    this.offset += 8
    return v
  }

  /**
   * @param {number} [max] reject anything longer; defaults to the packet limit
   * @returns {Buffer}
   */
  readBytes(max = MAX_PACKET_LENGTH) {
    const len = this.readUint32()
    if (len > max) throw new Error(`SSH string of ${len} bytes exceeds limit ${max}`)
    this._need(len)
    const out = this.buf.subarray(this.offset, this.offset + len)
    this.offset += len
    return out
  }

  /**
   * @param {number} [max]
   * @returns {string}
   */
  readString(max = MAX_PACKET_LENGTH) {
    return this.readBytes(max).toString('utf-8')
  }

  /** @returns {string[]} */
  readNameList() {
    const s = this.readString()
    return s === '' ? [] : s.split(',')
  }

  /** @returns {Buffer} magnitude of the mpint, leading sign byte removed */
  readMpint() {
    const raw = this.readBytes()
    let i = 0
    while (i < raw.length && raw[i] === 0) i++
    return Buffer.from(raw.subarray(i))
  }

  /** @returns {Buffer} everything left */
  rest() {
    const out = this.buf.subarray(this.offset)
    this.offset = this.buf.length
    return Buffer.from(out)
  }
}

// ── Version exchange (RFC 4253 §4.2) ───────────────────────────────────────

/**
 * Pull the server's identification line out of the bytes received so far.
 *
 * A server may legally emit any number of arbitrary lines before its
 * identification string — many print a legal banner — so lines are skipped
 * until one starts with `SSH-`. The returned `version` deliberately excludes
 * CR/LF: it is hashed as V_S during key exchange, and including the line
 * terminator would break every exchange hash.
 *
 * @param {string} text
 * @returns {{version: string, banner: string[], consumed: number}|null}
 *   null when no complete identification line has arrived yet
 */
export function parseIdentificationString(text) {
  /** @type {string[]} */
  const banner = []
  let offset = 0
  for (;;) {
    const nl = text.indexOf('\n', offset)
    if (nl === -1) return null
    const line = text.slice(offset, nl).replace(/\r$/, '')
    offset = nl + 1
    if (line.startsWith('SSH-')) {
      if (!line.startsWith('SSH-2.0-') && !line.startsWith('SSH-1.99-')) {
        throw new Error(`Unsupported SSH protocol version: ${line}`)
      }
      if (line.length > 255) throw new Error('SSH identification string too long')
      return { version: line, banner, consumed: offset }
    }
    banner.push(line)
  }
}

// ── Binary packet protocol (RFC 4253 §6) ───────────────────────────────────

/**
 * Padding length for a packet.
 *
 * Padding is at least 4 bytes and brings the encrypted region to a multiple of
 * the cipher block size (minimum 8). Which bytes count as "the encrypted
 * region" depends on the mode: with AES-GCM and with encrypt-then-MAC the
 * 4-byte length field travels in the clear, so it must be excluded here.
 * Conflating the two produces packets a real server rejects as corrupt while
 * every local round-trip test still passes.
 *
 * @param {number} payloadLength
 * @param {number} blockSize
 * @param {boolean} lengthEncrypted
 * @returns {number}
 */
export function computePaddingLength(payloadLength, blockSize, lengthEncrypted) {
  const bs = Math.max(8, blockSize)
  const unpadded = (lengthEncrypted ? 5 : 1) + payloadLength
  let pad = bs - (unpadded % bs)
  if (pad < 4) pad += bs
  // RFC 4253 §6: the whole packet, length field included, is at least 16 bytes.
  while (5 + payloadLength + pad < 16) pad += bs
  return pad
}

/** @type {Record<string, {algorithm: string, keyLength: number, ivLength: number, blockSize: number, aead: boolean, tagLength: number}>} */
export const CIPHER_SPECS = Object.freeze({
  'aes256-gcm@openssh.com': {
    algorithm: 'aes-256-gcm', keyLength: 32, ivLength: 12, blockSize: 16, aead: true, tagLength: 16,
  },
  'aes256-ctr': {
    algorithm: 'aes-256-ctr', keyLength: 32, ivLength: 16, blockSize: 16, aead: false, tagLength: 0,
  },
  'aes128-ctr': {
    algorithm: 'aes-128-ctr', keyLength: 16, ivLength: 16, blockSize: 16, aead: false, tagLength: 0,
  },
})

/** @type {Record<string, {algorithm: string, keyLength: number, length: number, etm: boolean}>} */
export const MAC_SPECS = Object.freeze({
  'hmac-sha2-256-etm@openssh.com': { algorithm: 'sha256', keyLength: 32, length: 32, etm: true },
  'hmac-sha2-512-etm@openssh.com': { algorithm: 'sha512', keyLength: 64, length: 64, etm: true },
  'hmac-sha2-256': { algorithm: 'sha256', keyLength: 32, length: 32, etm: false },
  'hmac-sha2-512': { algorithm: 'sha512', keyLength: 64, length: 64, etm: false },
})

/**
 * Framing for one direction of the connection.
 *
 * Sequence numbers are the reason this holds state rather than being a pure
 * function: the MAC covers `seq || packet`, with `seq` never transmitted. That
 * is what stops an attacker replaying, reordering or dropping a packet — the
 * ciphertext of a replayed packet is intact, but it authenticates under a
 * sequence number the receiver has moved past. AES-GCM gets the same property
 * from its per-packet invocation counter.
 */
export class PacketCodec {
  /**
   * @param {object} opts
   * @param {string} [opts.cipher]  key of CIPHER_SPECS, or 'none' before NEWKEYS
   * @param {string} [opts.mac]     key of MAC_SPECS; ignored for AEAD ciphers
   * @param {Buffer} [opts.key]
   * @param {Buffer} [opts.iv]
   * @param {Buffer} [opts.macKey]
   * @param {(n: number) => Buffer} [opts.randomFn] padding source; injectable for tests
   */
  constructor(opts = {}) {
    const cipherName = opts.cipher ?? 'none'
    this.cipherName = cipherName
    this.spec = cipherName === 'none' ? null : CIPHER_SPECS[cipherName]
    if (cipherName !== 'none' && !this.spec) throw new Error(`Unsupported cipher: ${cipherName}`)

    this.macName = this.spec?.aead ? 'aead' : (opts.mac ?? 'none')
    this.macSpec = this.macName === 'none' || this.macName === 'aead' ? null : MAC_SPECS[this.macName]
    if (this.macName !== 'none' && this.macName !== 'aead' && !this.macSpec) {
      throw new Error(`Unsupported MAC: ${this.macName}`)
    }

    this.blockSize = this.spec?.blockSize ?? 8
    this.macLength = this.spec?.aead ? this.spec.tagLength : (this.macSpec?.length ?? 0)
    // The length field stays in the clear for AEAD (it is the AAD) and for
    // encrypt-then-MAC (the MAC must be checkable before decrypting).
    this.lengthEncrypted = !(this.spec?.aead || this.macSpec?.etm)

    this.key = opts.key ?? Buffer.alloc(0)
    this.iv = opts.iv ?? Buffer.alloc(0)
    this.macKey = opts.macKey ?? Buffer.alloc(0)
    this._random = opts.randomFn ?? ((n) => cryptoRandomBytes(n))

    this.sequenceNumber = 0

    /**
     * A CTR keystream is continuous across packets, so one cipher object lives
     * for the whole connection direction rather than being rebuilt per packet.
     * @type {import('crypto').Cipher|import('crypto').Decipher|null}
     */
    this._stream = null
    // Only meaningful for AEAD: the low 8 bytes of the 12-byte IV.
    this._invocationCounter = this.spec?.aead && this.iv.length === 12
      ? this.iv.readBigUInt64BE(4)
      : 0n
    this._fixedIv = this.spec?.aead && this.iv.length === 12 ? this.iv.subarray(0, 4) : Buffer.alloc(4)

    /** Partially decrypted first block, kept between calls to `decode`. */
    this._pendingHead = null
  }

  /**
   * @param {'encrypt'|'decrypt'} direction
   * @returns {import('crypto').Cipher|import('crypto').Decipher}
   */
  _ctrStream(direction) {
    if (!this._stream) {
      this._stream = direction === 'encrypt'
        ? createCipheriv(this.spec.algorithm, this.key, this.iv)
        : createDecipheriv(this.spec.algorithm, this.key, this.iv)
    }
    return this._stream
  }

  /** @returns {Buffer} the next AEAD nonce, advancing the invocation counter */
  _nextAeadIv() {
    const iv = Buffer.concat([this._fixedIv, encodeUint64(this._invocationCounter)])
    this._invocationCounter = (this._invocationCounter + 1n) & 0xffffffffffffffffn
    return iv
  }

  /**
   * @param {Buffer} data
   * @returns {Buffer}
   */
  _mac(data) {
    return createHmac(this.macSpec.algorithm, this.macKey).update(data).digest()
  }

  /**
   * Frame, pad, encrypt and authenticate one payload.
   *
   * @param {Buffer} payload
   * @returns {Buffer} bytes to put on the wire
   */
  encode(payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    const padLength = computePaddingLength(body.length, this.blockSize, this.lengthEncrypted)
    const padding = this._random(padLength)
    const plain = Buffer.concat([Buffer.from([padLength]), body, padding])
    const lengthField = encodeUint32(plain.length)
    const seq = encodeUint32(this.sequenceNumber)
    this.sequenceNumber = (this.sequenceNumber + 1) >>> 0

    if (!this.spec) {
      return Buffer.concat([lengthField, plain])
    }

    if (this.spec.aead) {
      const cipher = createCipheriv(this.spec.algorithm, this.key, this._nextAeadIv())
      cipher.setAAD(lengthField)
      const ct = Buffer.concat([cipher.update(plain), cipher.final()])
      return Buffer.concat([lengthField, ct, cipher.getAuthTag()])
    }

    const stream = this._ctrStream('encrypt')
    if (this.macSpec?.etm) {
      const ct = stream.update(plain)
      const mac = this._mac(Buffer.concat([seq, lengthField, ct]))
      return Buffer.concat([lengthField, ct, mac])
    }

    const mac = this.macSpec ? this._mac(Buffer.concat([seq, lengthField, plain])) : Buffer.alloc(0)
    const ct = stream.update(Buffer.concat([lengthField, plain]))
    return Buffer.concat([ct, mac])
  }

  /**
   * Try to take one packet off the front of a receive buffer.
   *
   * @param {Buffer} buffer everything received and not yet consumed
   * @returns {{payload: Buffer, consumed: number}|null} null when more bytes are needed
   */
  decode(buffer) {
    if (!this.spec) {
      if (buffer.length < 5) return null
      const packetLength = buffer.readUInt32BE(0)
      this._validateLength(packetLength)
      const total = 4 + packetLength
      if (buffer.length < total) return null
      const padLength = buffer[4]
      if (padLength + 1 > packetLength) throw new Error('SSH packet padding is longer than the packet')
      this.sequenceNumber = (this.sequenceNumber + 1) >>> 0
      return { payload: Buffer.from(buffer.subarray(5, 4 + packetLength - padLength)), consumed: total }
    }

    if (this.spec.aead) return this._decodeAead(buffer)
    if (this.macSpec?.etm) return this._decodeEtm(buffer)
    return this._decodeMte(buffer)
  }

  /** @param {number} packetLength */
  _validateLength(packetLength) {
    if (packetLength < 8 || packetLength > MAX_PACKET_LENGTH) {
      throw new Error(`Implausible SSH packet length: ${packetLength}`)
    }
    const bs = Math.max(8, this.blockSize)
    const encryptedRegion = this.lengthEncrypted ? 4 + packetLength : packetLength
    if (encryptedRegion % bs !== 0) {
      throw new Error('SSH packet length is not a multiple of the cipher block size')
    }
  }

  /**
   * @param {Buffer} buffer
   * @returns {{payload: Buffer, consumed: number}|null}
   */
  _decodeAead(buffer) {
    if (buffer.length < 4) return null
    const lengthField = buffer.subarray(0, 4)
    const packetLength = lengthField.readUInt32BE(0)
    this._validateLength(packetLength)
    const total = 4 + packetLength + this.spec.tagLength
    if (buffer.length < total) return null

    const ct = buffer.subarray(4, 4 + packetLength)
    const tag = buffer.subarray(4 + packetLength, total)
    const decipher = createDecipheriv(this.spec.algorithm, this.key, this._nextAeadIv())
    decipher.setAAD(lengthField)
    decipher.setAuthTag(tag)
    let plain
    try {
      plain = Buffer.concat([decipher.update(ct), decipher.final()])
    } catch {
      throw new Error('SSH packet failed authentication (AES-GCM tag mismatch)')
    }
    this.sequenceNumber = (this.sequenceNumber + 1) >>> 0
    return { payload: this._strip(plain, packetLength), consumed: total }
  }

  /**
   * @param {Buffer} buffer
   * @returns {{payload: Buffer, consumed: number}|null}
   */
  _decodeEtm(buffer) {
    if (buffer.length < 4) return null
    const lengthField = buffer.subarray(0, 4)
    const packetLength = lengthField.readUInt32BE(0)
    this._validateLength(packetLength)
    const total = 4 + packetLength + this.macLength
    if (buffer.length < total) return null

    const ct = buffer.subarray(4, 4 + packetLength)
    const seq = encodeUint32(this.sequenceNumber)
    // Encrypt-then-MAC exists so this check happens before any decryption:
    // a forged packet never reaches the cipher at all.
    this._checkMac(this._mac(Buffer.concat([seq, lengthField, ct])), buffer.subarray(4 + packetLength, total))
    const plain = this._ctrStream('decrypt').update(ct)
    this.sequenceNumber = (this.sequenceNumber + 1) >>> 0
    return { payload: this._strip(plain, packetLength), consumed: total }
  }

  /**
   * MAC-then-encrypt (the classic RFC 4253 layout).
   *
   * @param {Buffer} buffer
   * @returns {{payload: Buffer, consumed: number}|null}
   */
  _decodeMte(buffer) {
    const bs = Math.max(8, this.blockSize)
    if (this._pendingHead === null) {
      if (buffer.length < bs) return null
      // The length lives inside the ciphertext, so the first block must be
      // decrypted to learn how much more to wait for — and a CTR keystream
      // cannot be rewound, hence the saved head.
      this._pendingHead = this._ctrStream('decrypt').update(buffer.subarray(0, bs))
    }
    const head = this._pendingHead
    const packetLength = head.readUInt32BE(0)
    this._validateLength(packetLength)
    const total = 4 + packetLength + this.macLength
    if (buffer.length < total) return null

    const tailCipher = buffer.subarray(bs, 4 + packetLength)
    const tail = tailCipher.length ? this._ctrStream('decrypt').update(tailCipher) : Buffer.alloc(0)
    const full = Buffer.concat([head, tail])
    const seq = encodeUint32(this.sequenceNumber)
    this._checkMac(this._mac(Buffer.concat([seq, full])), buffer.subarray(4 + packetLength, total))
    this._pendingHead = null
    this.sequenceNumber = (this.sequenceNumber + 1) >>> 0
    return { payload: this._strip(full.subarray(4), packetLength), consumed: total }
  }

  /**
   * @param {Buffer} expected
   * @param {Buffer} actual
   */
  _checkMac(expected, actual) {
    if (expected.length !== actual.length || !timingSafeEqual(expected, Buffer.from(actual))) {
      throw new Error('SSH packet failed authentication (MAC mismatch)')
    }
  }

  /**
   * @param {Buffer} plain  padding_length byte, payload, padding
   * @param {number} packetLength
   * @returns {Buffer}
   */
  _strip(plain, packetLength) {
    const padLength = plain[0]
    if (padLength < 4 || padLength + 1 > packetLength) {
      throw new Error('SSH packet has an invalid padding length')
    }
    return Buffer.from(plain.subarray(1, packetLength - padLength))
  }
}

// ── Algorithm negotiation (RFC 4253 §7.1) ──────────────────────────────────

/** Client preference order. Only algorithms this file actually implements. */
export const CLIENT_ALGORITHMS = Object.freeze({
  kex: Object.freeze(['curve25519-sha256', 'curve25519-sha256@libssh.org']),
  hostKey: Object.freeze(['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256']),
  cipher: Object.freeze(['aes256-gcm@openssh.com', 'aes256-ctr', 'aes128-ctr']),
  mac: Object.freeze([
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
  ]),
  compression: Object.freeze(['none']),
})

/**
 * Build a KEXINIT payload.
 *
 * The exact bytes matter beyond the negotiation itself: this payload is hashed
 * as I_C during key exchange, so it has to be retained verbatim rather than
 * regenerated.
 *
 * @param {object} [opts]
 * @param {Buffer} [opts.cookie] 16 random bytes; injectable so tests are stable
 * @param {typeof CLIENT_ALGORITHMS} [opts.algorithms]
 * @returns {Buffer}
 */
export function buildKexInit(opts = {}) {
  const algorithms = opts.algorithms ?? CLIENT_ALGORITHMS
  const cookie = opts.cookie ?? cryptoRandomBytes(16)
  if (cookie.length !== 16) throw new Error('KEXINIT cookie must be 16 bytes')
  return Buffer.concat([
    Buffer.from([MSG.KEXINIT]),
    cookie,
    encodeNameList([...algorithms.kex]),
    encodeNameList([...algorithms.hostKey]),
    encodeNameList([...algorithms.cipher]),
    encodeNameList([...algorithms.cipher]),
    encodeNameList([...algorithms.mac]),
    encodeNameList([...algorithms.mac]),
    encodeNameList([...algorithms.compression]),
    encodeNameList([...algorithms.compression]),
    encodeNameList([]),
    encodeNameList([]),
    encodeBoolean(false),
    encodeUint32(0),
  ])
}

/**
 * @typedef {object} KexInit
 * @property {Buffer} cookie
 * @property {string[]} kex
 * @property {string[]} hostKey
 * @property {string[]} cipherClientToServer
 * @property {string[]} cipherServerToClient
 * @property {string[]} macClientToServer
 * @property {string[]} macServerToClient
 * @property {string[]} compressionClientToServer
 * @property {string[]} compressionServerToClient
 * @property {boolean} firstKexPacketFollows
 */

/**
 * @param {Buffer} payload
 * @returns {KexInit}
 */
export function parseKexInit(payload) {
  const r = new SSHReader(payload)
  const type = r.readByte()
  if (type !== MSG.KEXINIT) throw new Error(`Expected KEXINIT, got message type ${type}`)
  const cookie = Buffer.from(r.buf.subarray(r.offset, r.offset + 16))
  if (cookie.length !== 16) throw new Error('SSH packet truncated')
  r.offset += 16
  const kex = r.readNameList()
  const hostKey = r.readNameList()
  const cipherClientToServer = r.readNameList()
  const cipherServerToClient = r.readNameList()
  const macClientToServer = r.readNameList()
  const macServerToClient = r.readNameList()
  const compressionClientToServer = r.readNameList()
  const compressionServerToClient = r.readNameList()
  r.readNameList() // languages c2s, unused
  r.readNameList() // languages s2c, unused
  const firstKexPacketFollows = r.readBoolean()
  return {
    cookie,
    kex,
    hostKey,
    cipherClientToServer,
    cipherServerToClient,
    macClientToServer,
    macServerToClient,
    compressionClientToServer,
    compressionServerToClient,
    firstKexPacketFollows,
  }
}

/**
 * Pick an algorithm.
 *
 * RFC 4253 §7.1 is explicit that the *client's* preference order decides. It
 * matters for security, not politeness: letting the server choose would let a
 * hostile server steer us to the weakest entry on our list.
 *
 * @param {string[]} clientList in descending preference
 * @param {string[]} serverList
 * @param {string} what for the error message
 * @returns {string}
 */
export function negotiateAlgorithm(clientList, serverList, what) {
  const offered = new Set(serverList ?? [])
  for (const candidate of clientList ?? []) {
    if (offered.has(candidate)) return candidate
  }
  throw new Error(
    `No mutually supported ${what}. Offered: ${(clientList ?? []).join(', ')}; ` +
    `server: ${(serverList ?? []).join(', ')}`,
  )
}

/**
 * Resolve every algorithm from a server KEXINIT.
 *
 * @param {KexInit} server
 * @param {typeof CLIENT_ALGORITHMS} [client]
 * @returns {{kex: string, hostKey: string, cipherC2S: string, cipherS2C: string,
 *            macC2S: string, macS2C: string}}
 */
export function negotiateAlgorithms(server, client = CLIENT_ALGORITHMS) {
  const cipherC2S = negotiateAlgorithm([...client.cipher], server.cipherClientToServer, 'cipher (client to server)')
  const cipherS2C = negotiateAlgorithm([...client.cipher], server.cipherServerToClient, 'cipher (server to client)')
  // An AEAD cipher supplies its own integrity, so no MAC is negotiated for
  // that direction — asking for one anyway would fail against servers that
  // legitimately offer an empty MAC list alongside GCM.
  const macC2S = CIPHER_SPECS[cipherC2S]?.aead
    ? 'aead'
    : negotiateAlgorithm([...client.mac], server.macClientToServer, 'MAC (client to server)')
  const macS2C = CIPHER_SPECS[cipherS2C]?.aead
    ? 'aead'
    : negotiateAlgorithm([...client.mac], server.macServerToClient, 'MAC (server to client)')
  const compression = negotiateAlgorithm(
    [...client.compression], server.compressionClientToServer, 'compression')
  if (compression !== 'none') throw new Error('Only compression "none" is supported')
  return {
    kex: negotiateAlgorithm([...client.kex], server.kex, 'key exchange'),
    hostKey: negotiateAlgorithm([...client.hostKey], server.hostKey, 'host key algorithm'),
    cipherC2S,
    cipherS2C,
    macC2S,
    macS2C,
  }
}

// ── Key exchange ───────────────────────────────────────────────────────────

/** SPKI DER prefix for a raw 32-byte X25519 public key. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
/** SPKI DER prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * @param {Buffer} raw 32 bytes
 * @returns {import('crypto').KeyObject}
 */
export function x25519PublicKeyFromRaw(raw) {
  if (raw.length !== 32) throw new Error('X25519 public key must be 32 bytes')
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

/**
 * @param {Buffer} raw 32 bytes
 * @returns {import('crypto').KeyObject}
 */
export function ed25519PublicKeyFromRaw(raw) {
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes')
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

/**
 * @param {import('crypto').KeyObject} key
 * @returns {Buffer} the raw 32-byte public value
 */
export function rawFromPublicKey(key) {
  return Buffer.from(key.export({ type: 'spki', format: 'der' }).subarray(12))
}

/**
 * Generate an ephemeral X25519 key pair for one key exchange.
 *
 * Ephemeral is the point: the private half is discarded when the connection
 * ends, so a later compromise of the host key cannot decrypt a recorded session.
 *
 * @returns {{privateKey: import('crypto').KeyObject, publicKey: import('crypto').KeyObject, raw: Buffer}}
 */
export function generateEphemeralX25519() {
  const pair = generateKeyPairSync('x25519')
  return { ...pair, raw: rawFromPublicKey(pair.publicKey) }
}

/**
 * The exchange hash H (RFC 5656 §4 as profiled for curve25519).
 *
 * Everything either side could influence is bound into a single digest, which
 * the server then signs with its host key. That signature is the *only* thing
 * tying the freshly negotiated session keys to a verified identity — which is
 * why `verifyHostKeySignature` is not optional and why H must be built from the
 * exact bytes exchanged, not from re-serialised equivalents.
 *
 * @param {object} args
 * @param {string} args.clientVersion  V_C, no CRLF
 * @param {string} args.serverVersion  V_S, no CRLF
 * @param {Buffer} args.clientKexInit  I_C, the full payload including the message byte
 * @param {Buffer} args.serverKexInit  I_S
 * @param {Buffer} args.hostKeyBlob    K_S
 * @param {Buffer} args.clientPublic   Q_C, 32 raw bytes
 * @param {Buffer} args.serverPublic   Q_S, 32 raw bytes
 * @param {Buffer} args.sharedSecret   K, raw big-endian magnitude
 * @param {string} [args.hash]
 * @returns {Buffer}
 */
export function computeExchangeHash(args) {
  return createHash(args.hash ?? 'sha256').update(Buffer.concat([
    encodeString(args.clientVersion),
    encodeString(args.serverVersion),
    encodeString(args.clientKexInit),
    encodeString(args.serverKexInit),
    encodeString(args.hostKeyBlob),
    encodeString(args.clientPublic),
    encodeString(args.serverPublic),
    encodeMpint(args.sharedSecret),
  ])).digest()
}

/**
 * RFC 4253 §7.2 key derivation.
 *
 * `HASH(K || H || X || session_id)`, extended by `HASH(K || H || K1 || …)` when
 * more bytes are needed than one digest provides. The session id is the *first*
 * exchange hash of the connection and never changes, which is what lets it be
 * used later as a channel binding when signing a publickey authentication
 * request.
 *
 * @param {object} args
 * @param {Buffer} args.sharedSecret raw magnitude of K
 * @param {Buffer} args.exchangeHash H
 * @param {string} args.letter       one of A-F
 * @param {Buffer} args.sessionId
 * @param {number} args.length       bytes needed
 * @param {string} [args.hash]
 * @returns {Buffer}
 */
export function deriveKey(args) {
  if (!/^[A-F]$/.test(args.letter)) throw new Error(`Key derivation letter must be A-F, got ${args.letter}`)
  const hash = args.hash ?? 'sha256'
  const k = encodeMpint(args.sharedSecret)
  let out = createHash(hash)
    .update(Buffer.concat([k, args.exchangeHash, Buffer.from(args.letter, 'ascii'), args.sessionId]))
    .digest()
  while (out.length < args.length) {
    out = Buffer.concat([
      out,
      createHash(hash).update(Buffer.concat([k, args.exchangeHash, out])).digest(),
    ])
  }
  return out.subarray(0, args.length)
}

// ── Host keys ──────────────────────────────────────────────────────────────

/**
 * @param {number} tag
 * @param {Buffer} content
 * @returns {Buffer}
 */
function derTlv(tag, content) {
  if (content.length < 0x80) return Buffer.concat([Buffer.from([tag, content.length]), content])
  const lenBytes = []
  let n = content.length
  while (n > 0) {
    lenBytes.unshift(n & 0xff)
    n >>>= 8
  }
  return Buffer.concat([Buffer.from([tag, 0x80 | lenBytes.length, ...lenBytes]), content])
}

/**
 * @param {Buffer} magnitude big-endian, non-negative
 * @returns {Buffer} DER INTEGER
 */
function derInteger(magnitude) {
  let b = Buffer.from(magnitude)
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  b = b.subarray(i)
  if (b.length && (b[0] & 0x80)) b = Buffer.concat([Buffer.from([0]), b])
  return derTlv(0x02, b)
}

const RSA_ALGORITHM_ID = Buffer.from('300d06092a864886f70d0101010500', 'hex')

/**
 * Build an RSA public KeyObject from the SSH wire representation.
 *
 * Node cannot import `ssh-rsa` blobs, so the modulus and exponent are wrapped in
 * the SubjectPublicKeyInfo DER that `createPublicKey` does understand. This is
 * pure structural re-encoding — no arithmetic, no key material is created here.
 *
 * @param {Buffer} e
 * @param {Buffer} n
 * @returns {import('crypto').KeyObject}
 */
export function rsaPublicKeyFromParts(e, n) {
  const rsaPublicKey = derTlv(0x30, Buffer.concat([derInteger(n), derInteger(e)]))
  const bitString = derTlv(0x03, Buffer.concat([Buffer.from([0]), rsaPublicKey]))
  const spki = derTlv(0x30, Buffer.concat([RSA_ALGORITHM_ID, bitString]))
  return createPublicKey({ key: spki, format: 'der', type: 'spki' })
}

/**
 * @typedef {object} HostKey
 * @property {string} type       'ssh-ed25519' | 'ssh-rsa'
 * @property {Buffer} blob       the wire form, as hashed into H
 * @property {import('crypto').KeyObject} key
 * @property {string} fingerprint `SHA256:<base64 without padding>`
 */

/**
 * OpenSSH's fingerprint format: base64 of the SHA-256 of the *blob*, padding
 * stripped. Matching OpenSSH exactly matters — a user checking a fingerprint
 * against `ssh-keyscan` output must see identical text, or they will click
 * through the prompt rather than compare it.
 *
 * @param {Buffer} blob
 * @returns {string}
 */
export function hostKeyFingerprint(blob) {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

/**
 * @param {Buffer} blob the `string` K_S from KEX_ECDH_REPLY
 * @returns {HostKey}
 */
export function parseHostKey(blob) {
  const r = new SSHReader(blob)
  const type = r.readString(64)
  if (type === 'ssh-ed25519') {
    const raw = r.readBytes(64)
    return {
      type,
      blob: Buffer.from(blob),
      key: ed25519PublicKeyFromRaw(Buffer.from(raw)),
      fingerprint: hostKeyFingerprint(blob),
    }
  }
  if (type === 'ssh-rsa') {
    const e = r.readMpint()
    const n = r.readMpint()
    if (n.length * 8 < 2040) throw new Error(`RSA host key is only ${n.length * 8} bits; refusing`)
    return {
      type,
      blob: Buffer.from(blob),
      key: rsaPublicKeyFromParts(e, n),
      fingerprint: hostKeyFingerprint(blob),
    }
  }
  throw new Error(`Unsupported host key type: ${type}`)
}

/**
 * Verify the server's signature over the exchange hash.
 *
 * This is the step that makes the whole handshake mean anything. Without it the
 * key exchange still succeeds — against an attacker sitting in the middle, who
 * simply runs one exchange with us and another with the real server. There is
 * no fallback path and no "ignore" option in this function by design.
 *
 * @param {HostKey} hostKey
 * @param {Buffer} signatureBlob  `string alg, string signature`
 * @param {Buffer} data           the exchange hash H
 * @param {string} negotiatedAlgorithm what KEXINIT settled on
 * @returns {boolean}
 */
export function verifyHostKeySignature(hostKey, signatureBlob, data, negotiatedAlgorithm) {
  const r = new SSHReader(signatureBlob)
  const algorithm = r.readString(64)
  const signature = Buffer.from(r.readBytes(4096))

  // A server that signs with an algorithm other than the one negotiated is
  // either broken or probing for a downgrade; either way we stop.
  if (negotiatedAlgorithm && algorithm !== negotiatedAlgorithm) {
    throw new Error(
      `Host key signature algorithm "${algorithm}" does not match the negotiated "${negotiatedAlgorithm}"`)
  }

  if (algorithm === 'ssh-ed25519') {
    if (hostKey.type !== 'ssh-ed25519') throw new Error('Host key type does not match signature type')
    if (signature.length !== 64) throw new Error('Ed25519 signature must be 64 bytes')
    return cryptoVerify(null, data, hostKey.key, signature)
  }
  if (algorithm === 'rsa-sha2-256' || algorithm === 'rsa-sha2-512') {
    if (hostKey.type !== 'ssh-rsa') throw new Error('Host key type does not match signature type')
    // `ssh-rsa` (SHA-1) is intentionally not accepted: SHA-1 collisions are
    // practical and the SHA-2 variants have been available since OpenSSH 7.2.
    const digest = algorithm === 'rsa-sha2-256' ? 'sha256' : 'sha512'
    return cryptoVerify(digest, data, hostKey.key, signature)
  }
  throw new Error(`Unsupported host key signature algorithm: ${algorithm}`)
}

// ── known_hosts trust model ────────────────────────────────────────────────

/**
 * @typedef {object} KnownHostEntry
 * @property {string[]} patterns  host patterns, or ['|1|salt|hash'] when hashed
 * @property {string} keyType
 * @property {string} keyBase64
 * @property {boolean} revoked    `@revoked` marker
 * @property {number} line        1-based line number, for error messages
 */

/**
 * Parse a `known_hosts` file.
 *
 * Unparseable lines are skipped rather than fatal: one bad line in a file the
 * user maintains by hand must not lock them out of every host.
 *
 * @param {string} text
 * @returns {KnownHostEntry[]}
 */
export function parseKnownHosts(text) {
  /** @type {KnownHostEntry[]} */
  const entries = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('#')) continue
    let fields = line.split(/\s+/)
    let revoked = false
    if (fields[0]?.startsWith('@')) {
      revoked = fields[0] === '@revoked'
      // `@cert-authority` lines delegate trust to a CA key, which this client
      // does not implement; skipping them is safer than misreading them as
      // ordinary host keys.
      if (!revoked) continue
      fields = fields.slice(1)
    }
    if (fields.length < 3) continue
    entries.push({
      patterns: fields[0].split(','),
      keyType: fields[1],
      keyBase64: fields[2],
      revoked,
      line: i + 1,
    })
  }
  return entries
}

/**
 * The name a host is recorded under: bare hostname on port 22, `[host]:port`
 * otherwise. OpenSSH's convention, followed so the same file works for both
 * tools.
 *
 * @param {string} host
 * @param {number} port
 * @returns {string}
 */
export function knownHostsName(host, port) {
  return port === 22 ? host : `[${host}]:${port}`
}

/**
 * Match one known_hosts pattern, supporting OpenSSH's `*` and `?` wildcards.
 *
 * @param {string} pattern
 * @param {string} name
 * @returns {boolean}
 */
export function knownHostsPatternMatches(pattern, name) {
  if (pattern === name) return true
  if (!pattern.includes('*') && !pattern.includes('?')) return false
  const rx = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$')
  return rx.test(name)
}

/**
 * Whether an entry covers a host, including OpenSSH's hashed (`|1|salt|hash`)
 * form, which is HMAC-SHA1 of the name keyed by the salt.
 *
 * @param {KnownHostEntry} entry
 * @param {string} host
 * @param {number} port
 * @returns {boolean}
 */
export function knownHostEntryMatches(entry, host, port) {
  const name = knownHostsName(host, port)
  let negated = false
  let matched = false
  for (const pattern of entry.patterns) {
    if (pattern.startsWith('|1|')) {
      const [, , salt, digest] = pattern.split('|')
      if (!salt || !digest) continue
      try {
        const mac = createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64')
        if (mac === digest) matched = true
      } catch {
        // A malformed salt is a corrupt line, not a match.
      }
      continue
    }
    const bare = pattern.startsWith('!') ? pattern.slice(1) : pattern
    if (knownHostsPatternMatches(bare, name)) {
      if (pattern.startsWith('!')) negated = true
      else matched = true
    }
  }
  return matched && !negated
}

/**
 * Classify a presented host key against what is already known.
 *
 * The three outcomes drive the whole trust model:
 *
 *   - `match`   — the exact key we saw last time. Connect.
 *   - `changed` — a *different* key of the same type for this host. This is
 *                 what a man-in-the-middle looks like, and it is also what a
 *                 legitimately reinstalled server looks like; the two are
 *                 indistinguishable from here. The connection is refused and
 *                 the user must remove the old entry by hand. Offering a
 *                 "trust anyway" button would make known_hosts decorative.
 *   - `revoked` — explicitly marked `@revoked`. Never connect.
 *   - `unknown` — never seen. Trust-on-first-use: the caller is handed the
 *                 fingerprint and decides.
 *
 * @param {KnownHostEntry[]} entries
 * @param {{host: string, port: number, keyType: string, keyBase64: string}} presented
 * @returns {{status: 'match'|'changed'|'revoked'|'unknown', entry: KnownHostEntry|null,
 *            conflicting: KnownHostEntry[]}}
 */
export function classifyHostKey(entries, presented) {
  const relevant = (entries ?? []).filter((e) => knownHostEntryMatches(e, presented.host, presented.port))
  /** @type {KnownHostEntry[]} */
  const conflicting = []
  for (const entry of relevant) {
    const sameKey = entry.keyType === presented.keyType && entry.keyBase64 === presented.keyBase64
    if (entry.revoked) {
      if (sameKey) return { status: 'revoked', entry, conflicting: [] }
      continue
    }
    if (sameKey) return { status: 'match', entry, conflicting: [] }
    if (entry.keyType === presented.keyType) conflicting.push(entry)
  }
  if (conflicting.length) return { status: 'changed', entry: null, conflicting }
  return { status: 'unknown', entry: null, conflicting: [] }
}

/**
 * @param {string} host
 * @param {number} port
 * @param {string} keyType
 * @param {string} keyBase64
 * @returns {string} a line suitable for appending to known_hosts
 */
export function formatKnownHostsLine(host, port, keyType, keyBase64) {
  return `${knownHostsName(host, port)} ${keyType} ${keyBase64}`
}

// ── Transport ──────────────────────────────────────────────────────────────

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label) {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`SSH timeout after ${ms}ms: ${label}`)), ms)
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ])
}

/** RFC 4254 disconnect reasons we produce. */
export const DISCONNECT_BY_APPLICATION = 11

/**
 * One SSH session channel.
 *
 * Flow control is not decoration: the peer's window is the number of bytes it
 * has agreed to buffer, and exceeding it is a protocol violation that well
 * behaved servers respond to by dropping the connection.
 */
export class SSHChannel {
  /**
   * @param {SSHTransport} transport
   * @param {number} localId
   * @param {{windowSize?: number, maxPacketSize?: number}} [opts]
   */
  constructor(transport, localId, opts = {}) {
    this.transport = transport
    this.localId = localId
    /** @type {number|null} */
    this.remoteId = null
    this.localWindow = opts.windowSize ?? 2 * 1024 * 1024
    this.localWindowInitial = this.localWindow
    this.maxPacketSize = opts.maxPacketSize ?? 32768
    this.remoteWindow = 0
    this.remoteMaxPacket = 32768
    this.closed = false
    this.eof = false

    /** @type {((data: Buffer) => void)|null} */
    this.onData = null
    /** @type {((data: Buffer, type: number) => void)|null} */
    this.onExtendedData = null
    /** @type {(() => void)|null} */
    this.onClose = null

    /** @type {{resolve: Function, reject: Function}|null} */
    this._openWaiter = null
    /** @type {{resolve: Function, reject: Function}|null} */
    this._requestWaiter = null
    /** @type {(() => void)[]} */
    this._windowWaiters = []
    /** @type {Error|null} */
    this._error = null
  }

  /**
   * @param {number} type
   * @param {Buffer} payload full packet payload including the message byte
   */
  _handle(type, payload) {
    const r = new SSHReader(payload)
    r.readByte()
    r.readUint32() // recipient channel — ours, already used for routing

    switch (type) {
      case MSG.CHANNEL_OPEN_CONFIRMATION: {
        this.remoteId = r.readUint32()
        this.remoteWindow = r.readUint32()
        this.remoteMaxPacket = r.readUint32()
        this._openWaiter?.resolve(this)
        this._openWaiter = null
        break
      }
      case MSG.CHANNEL_OPEN_FAILURE: {
        const reason = r.readUint32()
        const description = r.readString(1024)
        this._fail(new Error(`SSH channel open failed (${reason}): ${description}`))
        break
      }
      case MSG.CHANNEL_WINDOW_ADJUST: {
        this.remoteWindow += r.readUint32()
        for (const w of this._windowWaiters.splice(0)) w()
        break
      }
      case MSG.CHANNEL_DATA: {
        const data = r.readBytes(this.maxPacketSize)
        this._consumeWindow(data.length)
        this.onData?.(Buffer.from(data))
        break
      }
      case MSG.CHANNEL_EXTENDED_DATA: {
        const dataType = r.readUint32()
        const data = r.readBytes(this.maxPacketSize)
        this._consumeWindow(data.length)
        this.onExtendedData?.(Buffer.from(data), dataType)
        break
      }
      case MSG.CHANNEL_EOF:
        this.eof = true
        break
      case MSG.CHANNEL_CLOSE:
        this._fail(new Error('SSH channel closed by peer'), true)
        break
      case MSG.CHANNEL_SUCCESS:
        this._requestWaiter?.resolve(true)
        this._requestWaiter = null
        break
      case MSG.CHANNEL_FAILURE:
        this._requestWaiter?.reject(new Error('SSH channel request was refused'))
        this._requestWaiter = null
        break
      default:
        break
    }
  }

  /**
   * @param {number} bytes
   */
  _consumeWindow(bytes) {
    this.localWindow -= bytes
    // Top up early rather than at exhaustion: waiting until the window is
    // empty stalls the transfer for a full round trip on every window's worth
    // of data.
    if (this.localWindow <= this.localWindowInitial / 2) {
      const increment = this.localWindowInitial - this.localWindow
      this.localWindow = this.localWindowInitial
      this.transport._send(Buffer.concat([
        Buffer.from([MSG.CHANNEL_WINDOW_ADJUST]),
        encodeUint32(this.remoteId ?? 0),
        encodeUint32(increment),
      ])).catch(() => { /* the connection is already failing; nothing to add */ })
    }
  }

  /**
   * @param {Error} err
   * @param {boolean} [graceful]
   */
  _fail(err, graceful = false) {
    this.closed = true
    this._error = err
    this._openWaiter?.reject(err)
    this._openWaiter = null
    this._requestWaiter?.reject(err)
    this._requestWaiter = null
    for (const w of this._windowWaiters.splice(0)) w()
    if (graceful) this.onClose?.()
  }

  /**
   * Ask for a subsystem (`sftp`) on this channel.
   *
   * @param {string} name
   * @returns {Promise<void>}
   */
  async requestSubsystem(name) {
    if (this.remoteId === null) throw new Error('SSH channel is not open')
    const promise = new Promise((resolve, reject) => {
      this._requestWaiter = { resolve, reject }
    })
    await this.transport._send(Buffer.concat([
      Buffer.from([MSG.CHANNEL_REQUEST]),
      encodeUint32(this.remoteId),
      encodeString('subsystem'),
      encodeBoolean(true),
      encodeString(name),
    ]))
    await withTimeout(promise, this.transport.timeoutMs, `subsystem ${name}`)
  }

  /**
   * @param {Buffer} data
   * @returns {Promise<void>}
   */
  async write(data) {
    if (this.closed) throw this._error ?? new Error('SSH channel is closed')
    if (this.remoteId === null) throw new Error('SSH channel is not open')
    let offset = 0
    while (offset < data.length) {
      const chunk = Math.min(data.length - offset, this.remoteMaxPacket, Math.max(this.remoteWindow, 0))
      if (chunk <= 0) {
        await withTimeout(new Promise((resolve) => this._windowWaiters.push(resolve)),
          this.transport.timeoutMs, 'channel window')
        if (this.closed) throw this._error ?? new Error('SSH channel is closed')
        continue
      }
      const slice = data.subarray(offset, offset + chunk)
      this.remoteWindow -= chunk
      offset += chunk
      await this.transport._send(Buffer.concat([
        Buffer.from([MSG.CHANNEL_DATA]),
        encodeUint32(this.remoteId),
        encodeString(slice),
      ]))
    }
  }

  /** @returns {Promise<void>} */
  async close() {
    if (this.remoteId === null || this.closed) {
      this.closed = true
      return
    }
    this.closed = true
    try {
      await this.transport._send(Buffer.concat([
        Buffer.from([MSG.CHANNEL_CLOSE]),
        encodeUint32(this.remoteId),
      ]))
    } catch {
      // The peer hanging up first is normal during teardown.
    }
  }
}

/**
 * SSH-2 client transport.
 *
 * `connectFn` is injected exactly as in `remote-ftp.js`, so the handshake can be
 * driven against a scripted fake socket or an in-process peer. No unit test in
 * this project opens a real connection.
 */
export class SSHTransport {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port]
   * @param {number} [opts.timeoutMs]
   * @param {Function} [opts.connectFn] `net.connect` replacement
   * @param {string|KnownHostEntry[]} [opts.knownHosts] file text or parsed entries
   * @param {(info: {host: string, port: number, keyType: string, fingerprint: string,
   *   keyBase64: string, line: string}) => boolean|Promise<boolean>} [opts.onUnknownHostKey]
   *   Trust-on-first-use decision. **Omitting it means unknown hosts are
   *   rejected**, because the alternative — a default that accepts — silently
   *   removes every guarantee the handshake provides.
   * @param {(line: string) => void|Promise<void>} [opts.onHostKeyAccepted]
   *   Called with the known_hosts line to persist after a first-use acceptance.
   * @param {typeof CLIENT_ALGORITHMS} [opts.algorithms]
   * @param {() => Buffer} [opts.randomFn]
   */
  constructor(opts) {
    if (!opts?.host) throw new Error('SSHTransport requires a host')
    this.host = opts.host
    this.port = opts.port ?? 22
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.algorithms = opts.algorithms ?? CLIENT_ALGORITHMS
    this._connect = opts.connectFn ?? netConnect
    this._random = opts.randomFn ?? ((n) => cryptoRandomBytes(n))
    this.knownHosts = typeof opts.knownHosts === 'string'
      ? parseKnownHosts(opts.knownHosts)
      : (opts.knownHosts ?? [])
    this._onUnknownHostKey = opts.onUnknownHostKey ?? null
    this._onHostKeyAccepted = opts.onHostKeyAccepted ?? null

    this._socket = null
    this._inbox = Buffer.alloc(0)
    this._state = 'version'
    this._inbound = new PacketCodec()
    this._outbound = new PacketCodec({ randomFn: this._random })
    /** @type {Buffer[]} */
    this._queue = []
    /** @type {{filter: (p: Buffer) => boolean, resolve: Function, reject: Function}[]} */
    this._waiters = []
    /** @type {Map<number, SSHChannel>} */
    this._channels = new Map()
    this._nextChannelId = 0
    /** @type {Error|null} */
    this._fatal = null
    /** @type {(() => void)|null} resolves once the server's version line lands */
    this._versionWaiter = null
    /** @type {{kex: string, hostKey: string, cipherC2S: string, cipherS2C: string,
     *           macC2S: string, macS2C: string}|null} */
    this.negotiated = null

    /** @type {Buffer|null} the first exchange hash; also the session id */
    this.sessionId = null
    /** @type {HostKey|null} */
    this.hostKey = null
    /** @type {string[]} banner lines the server sent before authentication */
    this.banners = []
    this.serverVersion = ''
    this.authenticated = false
    this._handshakeDone = false
  }

  /**
   * @param {Error} err
   */
  _fail(err) {
    if (!this._fatal) this._fatal = err
    for (const w of this._waiters.splice(0)) w.reject(err)
    for (const ch of this._channels.values()) ch._fail(err)
  }

  /**
   * @param {Buffer} payload
   * @returns {Promise<void>}
   */
  async _send(payload) {
    if (this._fatal) throw this._fatal
    if (!this._socket) throw new Error('SSH transport is not connected')
    this._socket.write(this._outbound.encode(payload))
  }

  /**
   * Wait for the next payload matching a predicate.
   *
   * @param {(payload: Buffer) => boolean} filter
   * @param {string} label
   * @returns {Promise<Buffer>}
   */
  _expect(filter, label) {
    if (this._fatal) return Promise.reject(this._fatal)
    const i = this._queue.findIndex(filter)
    if (i !== -1) return Promise.resolve(this._queue.splice(i, 1)[0])
    return withTimeout(new Promise((resolve, reject) => {
      this._waiters.push({ filter, resolve, reject })
    }), this.timeoutMs, label)
  }

  /**
   * @param {number} type
   * @param {string} label
   * @returns {Promise<Buffer>}
   */
  _expectType(type, label) {
    return this._expect((p) => p[0] === type, label)
  }

  /** @param {Buffer} chunk */
  _onBytes(chunk) {
    this._inbox = Buffer.concat([this._inbox, Buffer.from(chunk)])
    try {
      if (this._state === 'version') {
        if (this._inbox.length > MAX_BANNER_BYTES) {
          throw new Error('SSH server sent an implausibly long identification banner')
        }
        // latin1 rather than utf-8: `consumed` is then a byte offset, and a
        // multi-byte character split across two TCP chunks cannot corrupt it.
        // The identification line itself is US-ASCII by RFC 4253 §4.2.
        const parsed = parseIdentificationString(this._inbox.toString('latin1'))
        if (!parsed) return
        this.serverVersion = parsed.version
        this._inbox = this._inbox.subarray(parsed.consumed)
        this._state = 'packets'
        this._versionWaiter?.()
        this._versionWaiter = null
      }
      for (;;) {
        const result = this._inbound.decode(this._inbox)
        if (!result) break
        this._inbox = this._inbox.subarray(result.consumed)
        this._dispatch(result.payload)
      }
    } catch (err) {
      this._fail(/** @type {Error} */(err))
      this._socket?.destroy()
    }
  }

  /** @param {Buffer} payload */
  _dispatch(payload) {
    if (payload.length === 0) return
    const type = payload[0]

    switch (type) {
      case MSG.IGNORE:
      case MSG.DEBUG:
      case MSG.UNIMPLEMENTED:
      case MSG.EXT_INFO:
        return
      case MSG.DISCONNECT: {
        const r = new SSHReader(payload)
        r.readByte()
        const reason = r.readUint32()
        let description = ''
        try {
          description = r.readString(1024)
        } catch {
          // Some servers truncate the description; the reason code is enough.
        }
        this._fail(new Error(`SSH server disconnected (reason ${reason}): ${description}`))
        return
      }
      case MSG.USERAUTH_BANNER: {
        const r = new SSHReader(payload)
        r.readByte()
        this.banners.push(r.readString(8192))
        return
      }
      case MSG.KEXINIT:
        if (this._handshakeDone) {
          // Key re-exchange is not implemented. Continuing while pretending to
          // rekey would leave both sides using different keys, so this is a
          // hard stop with a message that names the cause.
          this._fail(new Error('SSH key re-exchange is not supported; connection ended'))
          return
        }
        break
      case MSG.GLOBAL_REQUEST: {
        const r = new SSHReader(payload)
        r.readByte()
        r.readString(256)
        if (r.readBoolean()) {
          this._send(Buffer.from([MSG.REQUEST_FAILURE])).catch(() => {})
        }
        return
      }
      case MSG.CHANNEL_OPEN:
        // Server-initiated channels only exist for forwarding, which this
        // client does not do. Refuse rather than leave the request dangling.
        this._refuseChannelOpen(payload)
        return
      default:
        break
    }

    if (type >= MSG.CHANNEL_OPEN_CONFIRMATION && type <= MSG.CHANNEL_FAILURE) {
      const localId = payload.readUInt32BE(1)
      const channel = this._channels.get(localId)
      if (channel) {
        channel._handle(type, payload)
        return
      }
    }

    const i = this._waiters.findIndex((w) => w.filter(payload))
    if (i !== -1) {
      this._waiters.splice(i, 1)[0].resolve(payload)
    } else {
      this._queue.push(payload)
    }
  }

  /** @param {Buffer} payload */
  _refuseChannelOpen(payload) {
    try {
      const r = new SSHReader(payload)
      r.readByte()
      r.readString(64)
      const senderChannel = r.readUint32()
      this._send(Buffer.concat([
        Buffer.from([MSG.CHANNEL_OPEN_FAILURE]),
        encodeUint32(senderChannel),
        encodeUint32(1), // SSH_OPEN_ADMINISTRATIVELY_PROHIBITED
        encodeString('this client does not accept inbound channels'),
        encodeString(''),
      ])).catch(() => {})
    } catch {
      // Malformed CHANNEL_OPEN; ignoring it is safe since we accept none.
    }
  }

  /** Open the TCP connection, exchange versions, run KEX and verify the host key. */
  async connect() {
    const socket = this._connect({ host: this.host, port: this.port }, () => {})
    this._socket = socket
    socket.on('data', (chunk) => this._onBytes(chunk))
    socket.on('error', (err) => this._fail(err))
    socket.on('close', () => {
      if (!this._fatal) this._fail(new Error('SSH connection closed'))
    })

    await withTimeout(new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
      // An injected socket is usable immediately and never emits 'connect';
      // see the same note in FtpClient.connect.
      setImmediate(resolve)
    }), this.timeoutMs, 'connect')

    const versionSeen = new Promise((resolve) => {
      if (this._state === 'packets') resolve(undefined)
      else this._versionWaiter = () => resolve(undefined)
    })
    socket.write(CLIENT_VERSION + '\r\n')
    await withTimeout(versionSeen, this.timeoutMs, 'version exchange')
    if (this._fatal) throw this._fatal

    await this._keyExchange()
    this._handshakeDone = true
    return this
  }

  /** @returns {Promise<void>} */
  async _keyExchange() {
    const clientKexInit = buildKexInit({
      cookie: this._random(16),
      algorithms: this.algorithms,
    })
    await this._send(clientKexInit)
    const serverKexInitPayload = await this._expectType(MSG.KEXINIT, 'KEXINIT')
    const serverKexInit = parseKexInit(serverKexInitPayload)
    const chosen = negotiateAlgorithms(serverKexInit, this.algorithms)
    this.negotiated = chosen

    const ephemeral = generateEphemeralX25519()
    await this._send(Buffer.concat([
      Buffer.from([MSG.KEX_ECDH_INIT]),
      encodeString(ephemeral.raw),
    ]))

    const replyPayload = await this._expectType(MSG.KEX_ECDH_REPLY, 'KEX_ECDH_REPLY')
    const r = new SSHReader(replyPayload)
    r.readByte()
    const hostKeyBlob = Buffer.from(r.readBytes(8192))
    const serverPublic = Buffer.from(r.readBytes(64))
    const signatureBlob = Buffer.from(r.readBytes(8192))

    if (serverPublic.length !== 32) throw new Error('Server X25519 public key must be 32 bytes')
    const sharedSecret = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: x25519PublicKeyFromRaw(serverPublic),
    })
    // An all-zero shared secret means the peer sent a low-order point, forcing
    // a known key. RFC 8731 §3 requires aborting.
    if (sharedSecret.every((b) => b === 0)) {
      throw new Error('SSH key exchange produced a degenerate shared secret; aborting')
    }

    const exchangeHash = computeExchangeHash({
      clientVersion: CLIENT_VERSION,
      serverVersion: this.serverVersion,
      clientKexInit,
      serverKexInit: serverKexInitPayload,
      hostKeyBlob,
      clientPublic: ephemeral.raw,
      serverPublic,
      sharedSecret,
    })

    const hostKey = parseHostKey(hostKeyBlob)
    if (!verifyHostKeySignature(hostKey, signatureBlob, exchangeHash, chosen.hostKey)) {
      throw new Error('SSH host key signature is invalid; refusing to connect')
    }
    await this._checkHostKeyTrust(hostKey)
    this.hostKey = hostKey

    await this._expectType(MSG.NEWKEYS, 'NEWKEYS')
    await this._send(Buffer.from([MSG.NEWKEYS]))

    // The session id is fixed at the *first* exchange hash for the lifetime of
    // the connection; it is the binding used when signing publickey requests.
    if (!this.sessionId) this.sessionId = exchangeHash
    this._installKeys({ sharedSecret, exchangeHash, chosen })
  }

  /**
   * @param {object} args
   * @param {Buffer} args.sharedSecret
   * @param {Buffer} args.exchangeHash
   * @param {{cipherC2S: string, cipherS2C: string, macC2S: string, macS2C: string}} args.chosen
   */
  _installKeys({ sharedSecret, exchangeHash, chosen }) {
    const specC2S = CIPHER_SPECS[chosen.cipherC2S]
    const specS2C = CIPHER_SPECS[chosen.cipherS2C]
    const macSpecC2S = MAC_SPECS[chosen.macC2S]
    const macSpecS2C = MAC_SPECS[chosen.macS2C]
    /**
     * @param {string} letter
     * @param {number} length
     */
    const key = (letter, length) => deriveKey({
      sharedSecret,
      exchangeHash,
      letter,
      sessionId: this.sessionId,
      length,
    })
    // Captured before the codecs are replaced: sequence numbers do not reset at
    // NEWKEYS, they count every packet since the connection opened. Restarting
    // them would make every MAC after the handshake fail.
    const outboundSequence = this._outbound.sequenceNumber
    const inboundSequence = this._inbound.sequenceNumber

    this._outbound = new PacketCodec({
      cipher: chosen.cipherC2S,
      mac: chosen.macC2S === 'aead' ? undefined : chosen.macC2S,
      iv: key('A', specC2S.ivLength),
      key: key('C', specC2S.keyLength),
      macKey: macSpecC2S ? key('E', macSpecC2S.keyLength) : undefined,
      randomFn: this._random,
    })
    this._outbound.sequenceNumber = outboundSequence

    this._inbound = new PacketCodec({
      cipher: chosen.cipherS2C,
      mac: chosen.macS2C === 'aead' ? undefined : chosen.macS2C,
      iv: key('B', specS2C.ivLength),
      key: key('D', specS2C.keyLength),
      macKey: macSpecS2C ? key('F', macSpecS2C.keyLength) : undefined,
    })
    this._inbound.sequenceNumber = inboundSequence
  }

  /**
   * Apply the known_hosts trust model to a verified host key.
   *
   * A valid signature only proves the server holds the private half of *some*
   * key. Deciding whether that key is the one belonging to the host the user
   * asked for is a separate question, and this is where it is answered.
   *
   * @param {HostKey} hostKey
   * @returns {Promise<void>}
   */
  async _checkHostKeyTrust(hostKey) {
    const keyBase64 = hostKey.blob.toString('base64')
    const presented = { host: this.host, port: this.port, keyType: hostKey.type, keyBase64 }
    const { status, conflicting } = classifyHostKey(this.knownHosts, presented)

    if (status === 'match') return
    if (status === 'revoked') {
      throw new Error(
        `The host key for ${knownHostsName(this.host, this.port)} is marked revoked ` +
        `(${hostKey.fingerprint}). Refusing to connect.`)
    }
    if (status === 'changed') {
      throw new Error(
        `REMOTE HOST IDENTIFICATION HAS CHANGED for ${knownHostsName(this.host, this.port)}. ` +
        `The server offered ${hostKey.type} ${hostKey.fingerprint}, but a different key is on ` +
        `record (known_hosts line ${conflicting.map((c) => c.line).join(', ')}). This is what a ` +
        'man-in-the-middle attack looks like. If the server was genuinely rebuilt, remove the ' +
        'old entry by hand before reconnecting.')
    }

    if (!this._onUnknownHostKey) {
      throw new Error(
        `The host key for ${knownHostsName(this.host, this.port)} is not known ` +
        `(${hostKey.type} ${hostKey.fingerprint}) and no trust decision was provided. ` +
        'Refusing to connect.')
    }
    const line = formatKnownHostsLine(this.host, this.port, hostKey.type, keyBase64)
    const accepted = await this._onUnknownHostKey({
      host: this.host,
      port: this.port,
      keyType: hostKey.type,
      fingerprint: hostKey.fingerprint,
      keyBase64,
      line,
    })
    if (!accepted) {
      throw new Error(
        `Host key ${hostKey.fingerprint} for ${knownHostsName(this.host, this.port)} was not trusted.`)
    }
    this.knownHosts = [...this.knownHosts, ...parseKnownHosts(line)]
    await this._onHostKeyAccepted?.(line)
  }

  // ── User authentication (RFC 4252) ───────────────────────────────────────

  /** @returns {Promise<void>} */
  async requestAuthService() {
    await this._send(Buffer.concat([
      Buffer.from([MSG.SERVICE_REQUEST]),
      encodeString('ssh-userauth'),
    ]))
    await this._expectType(MSG.SERVICE_ACCEPT, 'SERVICE_ACCEPT')
  }

  /**
   * @param {Buffer} request
   * @param {string} label
   * @returns {Promise<{ok: boolean, methods: string[], payload: Buffer}>}
   */
  async _submitAuth(request, label) {
    await this._send(request)
    const payload = await this._expect(
      (p) => p[0] === MSG.USERAUTH_SUCCESS || p[0] === MSG.USERAUTH_FAILURE || p[0] === MSG.USERAUTH_PK_OK,
      label)
    if (payload[0] === MSG.USERAUTH_SUCCESS) {
      this.authenticated = true
      return { ok: true, methods: [], payload }
    }
    if (payload[0] === MSG.USERAUTH_PK_OK) {
      return { ok: false, methods: [], payload }
    }
    const r = new SSHReader(payload)
    r.readByte()
    return { ok: false, methods: r.readNameList(), payload }
  }

  /**
   * Probe with the `none` method to learn which methods the server allows.
   *
   * Some servers do grant access to `none`; that is their decision, not a
   * bypass on our side.
   *
   * @param {string} user
   * @returns {Promise<{ok: boolean, methods: string[]}>}
   */
  async authenticateNone(user) {
    const { ok, methods } = await this._submitAuth(Buffer.concat([
      Buffer.from([MSG.USERAUTH_REQUEST]),
      encodeString(user),
      encodeString('ssh-connection'),
      encodeString('none'),
    ]), 'userauth none')
    return { ok, methods }
  }

  /**
   * @param {string} user
   * @param {string} password
   * @returns {Promise<boolean>}
   */
  async authenticatePassword(user, password) {
    const { ok } = await this._submitAuth(Buffer.concat([
      Buffer.from([MSG.USERAUTH_REQUEST]),
      encodeString(user),
      encodeString('ssh-connection'),
      encodeString('password'),
      encodeBoolean(false),
      encodeString(password),
    ]), 'userauth password')
    return ok
  }

  /**
   * Build the bytes an ed25519 publickey request is signed over.
   *
   * The session id at the front is what stops a signature captured from one
   * connection being replayed onto another: it is unique per handshake and the
   * client never chooses it alone.
   *
   * @param {object} args
   * @param {Buffer} args.sessionId
   * @param {string} args.user
   * @param {string} args.algorithm
   * @param {Buffer} args.publicKeyBlob
   * @returns {Buffer}
   */
  static buildPublicKeySignatureData(args) {
    return Buffer.concat([
      encodeString(args.sessionId),
      Buffer.from([MSG.USERAUTH_REQUEST]),
      encodeString(args.user),
      encodeString('ssh-connection'),
      encodeString('publickey'),
      encodeBoolean(true),
      encodeString(args.algorithm),
      encodeString(args.publicKeyBlob),
    ])
  }

  /**
   * Public-key authentication with an ed25519 key.
   *
   * `privateKey` must be a `KeyObject` (or anything `crypto.sign` accepts, i.e.
   * a PKCS#8 PEM). OpenSSH's own `-----BEGIN OPENSSH PRIVATE KEY-----` container
   * is *not* supported by Node and is deliberately not parsed here — decrypting
   * and unpacking that format by hand is exactly the kind of code this module
   * avoids. Convert with `ssh-keygen -p -m PKCS8 -f <key>`.
   *
   * @param {string} user
   * @param {{privateKey: import('crypto').KeyObject|string, publicKeyRaw: Buffer}} identity
   * @returns {Promise<boolean>}
   */
  async authenticatePublicKeyEd25519(user, identity) {
    if (!this.sessionId) throw new Error('Cannot authenticate before key exchange')
    const publicKeyBlob = Buffer.concat([
      encodeString('ssh-ed25519'),
      encodeString(identity.publicKeyRaw),
    ])
    const signatureData = SSHTransport.buildPublicKeySignatureData({
      sessionId: this.sessionId,
      user,
      algorithm: 'ssh-ed25519',
      publicKeyBlob,
    })
    const signature = cryptoSign(null, signatureData, identity.privateKey)
    const { ok } = await this._submitAuth(Buffer.concat([
      Buffer.from([MSG.USERAUTH_REQUEST]),
      encodeString(user),
      encodeString('ssh-connection'),
      encodeString('publickey'),
      encodeBoolean(true),
      encodeString('ssh-ed25519'),
      encodeString(publicKeyBlob),
      encodeString(Buffer.concat([encodeString('ssh-ed25519'), encodeString(signature)])),
    ]), 'userauth publickey')
    return ok
  }

  /**
   * Authenticate with whatever the caller supplied, preferring a key.
   *
   * @param {object} args
   * @param {string} args.user
   * @param {string} [args.password]
   * @param {{privateKey: import('crypto').KeyObject|string, publicKeyRaw: Buffer}} [args.identity]
   * @returns {Promise<void>}
   */
  async authenticate(args) {
    await this.requestAuthService()
    const probe = await this.authenticateNone(args.user)
    if (probe.ok) return

    if (args.identity && (probe.methods.length === 0 || probe.methods.includes('publickey'))) {
      if (await this.authenticatePublicKeyEd25519(args.user, args.identity)) return
    }
    if (args.password !== undefined && (probe.methods.length === 0 || probe.methods.includes('password'))) {
      if (await this.authenticatePassword(args.user, args.password)) return
    }
    throw new Error(
      `SSH authentication failed for ${args.user}. Server accepts: ` +
      `${probe.methods.join(', ') || 'unknown'}.`)
  }

  // ── Channels (RFC 4254) ──────────────────────────────────────────────────

  /**
   * @param {{windowSize?: number, maxPacketSize?: number}} [opts]
   * @returns {Promise<SSHChannel>}
   */
  async openSession(opts = {}) {
    if (!this.authenticated) throw new Error('Cannot open a channel before authenticating')
    const localId = this._nextChannelId++
    const channel = new SSHChannel(this, localId, opts)
    // Registered before the request goes out: the confirmation is routed by
    // our channel id and can arrive before the write resolves.
    this._channels.set(localId, channel)

    const opened = new Promise((resolve, reject) => {
      channel._openWaiter = { resolve, reject }
    })
    await this._send(Buffer.concat([
      Buffer.from([MSG.CHANNEL_OPEN]),
      encodeString('session'),
      encodeUint32(localId),
      encodeUint32(channel.localWindow),
      encodeUint32(channel.maxPacketSize),
    ]))
    await withTimeout(opened, this.timeoutMs, 'channel open')
    return channel
  }

  /**
   * Open a session channel and start a subsystem on it.
   *
   * @param {string} name
   * @param {{windowSize?: number, maxPacketSize?: number}} [opts]
   * @returns {Promise<SSHChannel>}
   */
  async openSubsystem(name, opts = {}) {
    const channel = await this.openSession(opts)
    await channel.requestSubsystem(name)
    return channel
  }

  /** Say goodbye if possible, then tear the socket down regardless. */
  async close() {
    for (const channel of this._channels.values()) {
      await channel.close().catch(() => {})
    }
    if (this._socket && !this._fatal) {
      try {
        await this._send(Buffer.concat([
          Buffer.from([MSG.DISCONNECT]),
          encodeUint32(DISCONNECT_BY_APPLICATION),
          encodeString('closed by user'),
          encodeString(''),
        ]))
      } catch {
        // Already gone; nothing to recover.
      }
    }
    this._socket?.destroy()
    this._socket = null
    if (!this._fatal) this._fatal = new Error('SSH connection closed')
  }
}
