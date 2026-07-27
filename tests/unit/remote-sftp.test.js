import { describe, it, expect, vi } from 'vitest'
import { SSHReader, encodeString, encodeUint32, encodeUint64 } from '../../src/main/ssh-transport.js'
import {
  ATTR_FLAGS,
  FX,
  FXP,
  MAX_DIRECTORY_ENTRIES,
  SFTP_VERSION,
  SSH_FXF_READ,
  SftpClient,
  connectSftp,
  decodeSftpPackets,
  encodeSftpPacket,
  parseAttrsResponse,
  parseDataResponse,
  parseHandleResponse,
  parseNameResponse,
  parseStatusResponse,
  parseVersionResponse,
  readAttrs,
  sftpStatusText,
} from '../../src/main/remote-sftp.js'

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a v3 ATTRS blob.
 *
 * @param {{size?: number, permissions?: number, mtime?: number, uid?: number, gid?: number}} attrs
 * @returns {Buffer}
 */
function buildAttrs(attrs = {}) {
  let flags = 0
  const parts = []
  if (attrs.size !== undefined) {
    flags |= ATTR_FLAGS.SIZE
    parts.push(encodeUint64(attrs.size))
  }
  if (attrs.uid !== undefined) {
    flags |= ATTR_FLAGS.UIDGID
    parts.push(encodeUint32(attrs.uid), encodeUint32(attrs.gid ?? 0))
  }
  if (attrs.permissions !== undefined) {
    flags |= ATTR_FLAGS.PERMISSIONS
    parts.push(encodeUint32(attrs.permissions))
  }
  if (attrs.mtime !== undefined) {
    flags |= ATTR_FLAGS.ACMODTIME
    parts.push(encodeUint32(attrs.mtime), encodeUint32(attrs.mtime))
  }
  return Buffer.concat([encodeUint32(flags), ...parts])
}

/**
 * @param {number} id
 * @param {{name: string, longname?: string, attrs?: object}[]} names
 * @returns {Buffer}
 */
function buildNamePayload(id, names) {
  return Buffer.concat([
    encodeUint32(id),
    encodeUint32(names.length),
    ...names.flatMap((n) => [
      encodeString(n.name),
      encodeString(n.longname ?? `-rw-r--r-- 1 u g 0 Jan 1 00:00 ${n.name}`),
      buildAttrs(n.attrs ?? {}),
    ]),
  ])
}

/**
 * @param {number} id
 * @param {number} code
 * @param {string} [message]
 * @returns {Buffer}
 */
function buildStatusPayload(id, code, message = '') {
  return Buffer.concat([
    encodeUint32(id),
    encodeUint32(code),
    encodeString(message),
    encodeString(''),
  ])
}

/**
 * An in-memory stand-in for an SSH `subsystem` channel.
 *
 * `handler` receives each decoded request and returns the packets to send back,
 * so a whole conversation is scripted without a socket, an SSH server, or any
 * cryptography.
 *
 * @param {(req: {type: number, payload: Buffer, id: number}) => {type: number, payload: Buffer}[]|null} handler
 */
function fakeChannel(handler) {
  const channel = {
    /** @type {((d: Buffer) => void)|null} */
    onData: null,
    /** @type {{type: number, payload: Buffer, id: number}[]} */
    requests: [],
    closed: false,
    /** Bytes to prepend to the next response, used to test fragmentation. */
    _carry: Buffer.alloc(0),
    async write(data) {
      const { packets } = decodeSftpPackets(data)
      for (const packet of packets) {
        const id = packet.type === FXP.INIT ? -1 : packet.payload.readUInt32BE(0)
        const request = { ...packet, id }
        channel.requests.push(request)
        const responses = handler(request)
        if (!responses) continue
        for (const response of responses) {
          channel.onData?.(encodeSftpPacket(response.type, response.payload))
        }
      }
    },
    async close() {
      channel.closed = true
    },
  }
  return channel
}

/** Handler fragment: answer INIT with VERSION 3. */
function versionResponse(request) {
  if (request.type !== FXP.INIT) return null
  return [{ type: FXP.VERSION, payload: encodeUint32(SFTP_VERSION) }]
}

/**
 * @param {(req: {type: number, payload: Buffer, id: number}) => {type: number, payload: Buffer}[]|null} handler
 * @returns {Promise<{client: SftpClient, channel: ReturnType<typeof fakeChannel>}>}
 */
async function connectedClient(handler) {
  const channel = fakeChannel((req) => versionResponse(req) ?? handler(req))
  const client = new SftpClient({ channel, timeoutMs: 500 })
  await client.connect()
  return { client, channel }
}

// ── Packet framing ─────────────────────────────────────────────────────────

describe('encodeSftpPacket', () => {
  it('prefixes a length that counts the type byte', () => {
    const packet = encodeSftpPacket(FXP.INIT, encodeUint32(3))
    expect(packet.readUInt32BE(0)).toBe(5)
    expect(packet[4]).toBe(FXP.INIT)
    expect(packet.length).toBe(9)
  })

  it('handles an empty payload', () => {
    const packet = encodeSftpPacket(FXP.CLOSE, Buffer.alloc(0))
    expect(packet.readUInt32BE(0)).toBe(1)
    expect(packet.length).toBe(5)
  })
})

describe('decodeSftpPackets', () => {
  it('round-trips a single packet', () => {
    const wire = encodeSftpPacket(FXP.STAT, Buffer.from('abc'))
    const { packets, rest } = decodeSftpPackets(wire)
    expect(packets).toHaveLength(1)
    expect(packets[0].type).toBe(FXP.STAT)
    expect(packets[0].payload.toString()).toBe('abc')
    expect(rest.length).toBe(0)
  })

  it('splits several packets delivered in one channel read', () => {
    const wire = Buffer.concat([
      encodeSftpPacket(FXP.DATA, Buffer.from('one')),
      encodeSftpPacket(FXP.DATA, Buffer.from('two')),
      encodeSftpPacket(FXP.DATA, Buffer.from('three')),
    ])
    const { packets, rest } = decodeSftpPackets(wire)
    expect(packets.map((p) => p.payload.toString())).toEqual(['one', 'two', 'three'])
    expect(rest.length).toBe(0)
  })

  it('keeps a trailing partial packet as the remainder', () => {
    // Channel data boundaries have nothing to do with SFTP packet boundaries.
    const wire = Buffer.concat([
      encodeSftpPacket(FXP.DATA, Buffer.from('complete')),
      encodeSftpPacket(FXP.DATA, Buffer.from('partial')).subarray(0, 6),
    ])
    const { packets, rest } = decodeSftpPackets(wire)
    expect(packets).toHaveLength(1)
    expect(rest.length).toBe(6)
  })

  it('returns nothing when fewer than four bytes have arrived', () => {
    const { packets, rest } = decodeSftpPackets(Buffer.from([0, 0]))
    expect(packets).toEqual([])
    expect(rest.length).toBe(2)
  })

  it('reassembles across arbitrary fragmentation', () => {
    const wire = Buffer.concat([
      encodeSftpPacket(FXP.DATA, Buffer.alloc(300, 1)),
      encodeSftpPacket(FXP.DATA, Buffer.alloc(50, 2)),
    ])
    let buffer = Buffer.alloc(0)
    const seen = []
    for (let i = 0; i < wire.length; i += 7) {
      buffer = Buffer.concat([buffer, wire.subarray(i, i + 7)])
      const { packets, rest } = decodeSftpPackets(buffer)
      seen.push(...packets)
      buffer = rest
    }
    expect(seen).toHaveLength(2)
    expect(seen[0].payload.length).toBe(300)
    expect(seen[1].payload.length).toBe(50)
  })

  it('refuses an implausible length instead of waiting for gigabytes', () => {
    const wire = Buffer.concat([encodeUint32(0x7fffffff), Buffer.alloc(10)])
    expect(() => decodeSftpPackets(wire)).toThrow(/Implausible SFTP packet length/)
  })

  it('refuses a zero length, which carries no type byte', () => {
    expect(() => decodeSftpPackets(Buffer.concat([encodeUint32(0), Buffer.alloc(4)])))
      .toThrow(/Implausible SFTP packet length/)
  })

  it('honours a caller-supplied packet ceiling', () => {
    const wire = encodeSftpPacket(FXP.DATA, Buffer.alloc(100))
    expect(() => decodeSftpPackets(wire, { maxPacketBytes: 50 }))
      .toThrow(/Implausible SFTP packet length/)
  })
})

// ── Attributes ─────────────────────────────────────────────────────────────

describe('readAttrs', () => {
  it('reads nothing when the flags word is empty', () => {
    const attrs = readAttrs(new SSHReader(encodeUint32(0)))
    expect(attrs).toMatchObject({ size: null, permissions: null, mtime: null })
    expect(attrs.isDirectory).toBe(false)
  })

  it('reads a size', () => {
    expect(readAttrs(new SSHReader(buildAttrs({ size: 123456 }))).size).toBe(123456)
  })

  it('clamps a size beyond the exact-integer range instead of losing precision silently', () => {
    const huge = Buffer.concat([encodeUint32(ATTR_FLAGS.SIZE), encodeUint64((1n << 62n))])
    expect(readAttrs(new SSHReader(huge)).size).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('derives the entry type from the permission bits', () => {
    expect(readAttrs(new SSHReader(buildAttrs({ permissions: 0o040755 }))).isDirectory).toBe(true)
    expect(readAttrs(new SSHReader(buildAttrs({ permissions: 0o120777 }))).isSymlink).toBe(true)
    const file = readAttrs(new SSHReader(buildAttrs({ permissions: 0o100644 })))
    expect(file.isFile).toBe(true)
    expect(file.isDirectory).toBe(false)
  })

  it('reads v3 timestamps as seconds since the epoch', () => {
    const attrs = readAttrs(new SSHReader(buildAttrs({ mtime: 1_700_000_000 })))
    expect(attrs.mtime.toISOString()).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('consumes fields in flag order so the cursor stays aligned', () => {
    // A reader that assumed a fixed layout would leave the cursor wrong and
    // corrupt every following field.
    const blob = Buffer.concat([
      buildAttrs({ size: 7, uid: 1000, gid: 1000, permissions: 0o100644, mtime: 5 }),
      encodeString('sentinel'),
    ])
    const reader = new SSHReader(blob)
    const attrs = readAttrs(reader)
    expect(attrs).toMatchObject({ size: 7, uid: 1000, gid: 1000, permissions: 0o100644 })
    expect(reader.readString()).toBe('sentinel')
  })

  it('skips extended attribute pairs', () => {
    const blob = Buffer.concat([
      encodeUint32(ATTR_FLAGS.SIZE | ATTR_FLAGS.EXTENDED),
      encodeUint64(9),
      encodeUint32(2),
      encodeString('a@example'), encodeString('1'),
      encodeString('b@example'), encodeString('2'),
      encodeString('sentinel'),
    ])
    const reader = new SSHReader(blob)
    expect(readAttrs(reader).size).toBe(9)
    expect(reader.readString()).toBe('sentinel')
  })

  it('refuses an implausible extension count', () => {
    const blob = Buffer.concat([encodeUint32(ATTR_FLAGS.EXTENDED), encodeUint32(1_000_000)])
    expect(() => readAttrs(new SSHReader(blob))).toThrow(/implausible extension count/)
  })

  it('throws on a truncated attribute block', () => {
    const blob = Buffer.concat([encodeUint32(ATTR_FLAGS.SIZE), Buffer.alloc(3)])
    expect(() => readAttrs(new SSHReader(blob))).toThrow(/truncated/)
  })
})

// ── Response parsing ───────────────────────────────────────────────────────

describe('parseNameResponse', () => {
  it('parses names, longnames and attributes', () => {
    const payload = buildNamePayload(7, [
      { name: 'a.txt', attrs: { size: 10, permissions: 0o100644 } },
      { name: 'sub', attrs: { permissions: 0o040755 } },
    ])
    const { id, entries } = parseNameResponse(payload)
    expect(id).toBe(7)
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'sub'])
    expect(entries[0].attrs.size).toBe(10)
    expect(entries[1].attrs.isDirectory).toBe(true)
    expect(entries[0].longname).toContain('a.txt')
  })

  it('flags a name that cannot be used as a local path component', () => {
    const payload = buildNamePayload(1, [
      { name: 'safe.txt' },
      { name: '..' },
      { name: '../../etc/passwd' },
      { name: 'C:evil' },
    ])
    const { entries } = parseNameResponse(payload)
    expect(entries.map((e) => e.unsafe)).toEqual([false, true, true, true])
  })

  it('parses an empty batch', () => {
    expect(parseNameResponse(buildNamePayload(3, [])).entries).toEqual([])
  })

  it('refuses a count the payload could not possibly contain', () => {
    // Guards against a server making us pre-allocate for millions of entries.
    const payload = Buffer.concat([encodeUint32(1), encodeUint32(MAX_DIRECTORY_ENTRIES + 1)])
    expect(() => parseNameResponse(payload)).toThrow(/refusing/)
  })

  it('throws when the declared count exceeds the data present', () => {
    const payload = Buffer.concat([encodeUint32(1), encodeUint32(5), encodeString('only-one')])
    expect(() => parseNameResponse(payload)).toThrow(/truncated/)
  })

  it('preserves a UTF-8 filename', () => {
    const { entries } = parseNameResponse(buildNamePayload(1, [{ name: '報告.txt' }]))
    expect(entries[0].name).toBe('報告.txt')
    expect(entries[0].unsafe).toBe(false)
  })
})

describe('parseStatusResponse', () => {
  it('parses code and message', () => {
    const r = parseStatusResponse(buildStatusPayload(4, FX.NO_SUCH_FILE, 'nope'))
    expect(r).toEqual({ id: 4, code: FX.NO_SUCH_FILE, message: 'nope' })
  })

  it('falls back to the standard text when the server omits the message', () => {
    // Some v3 servers send only id and code.
    const payload = Buffer.concat([encodeUint32(1), encodeUint32(FX.PERMISSION_DENIED)])
    expect(parseStatusResponse(payload).message).toBe('permission denied')
  })

  it('falls back when the message is present but empty', () => {
    expect(parseStatusResponse(buildStatusPayload(1, FX.EOF, '')).message).toBe('end of file')
  })
})

describe('sftpStatusText', () => {
  it('names every documented status', () => {
    expect(sftpStatusText(FX.OK)).toBe('OK')
    expect(sftpStatusText(FX.EOF)).toBe('end of file')
    expect(sftpStatusText(FX.OP_UNSUPPORTED)).toBe('operation unsupported')
  })

  it('does not pretend to know an unknown code', () => {
    expect(sftpStatusText(99)).toBe('unknown status 99')
  })
})

describe('parseHandleResponse', () => {
  it('parses a handle', () => {
    const payload = Buffer.concat([encodeUint32(2), encodeString(Buffer.from([1, 2, 3]))])
    const r = parseHandleResponse(payload)
    expect(r.id).toBe(2)
    expect([...r.handle]).toEqual([1, 2, 3])
  })

  it('refuses an oversized handle', () => {
    const payload = Buffer.concat([encodeUint32(2), encodeString(Buffer.alloc(1024))])
    expect(() => parseHandleResponse(payload)).toThrow(/exceeds limit/)
  })
})

describe('parseDataResponse', () => {
  it('parses a data chunk with its length prefix', () => {
    const payload = Buffer.concat([encodeUint32(5), encodeString(Buffer.from('hello'))])
    const r = parseDataResponse(payload)
    expect(r.id).toBe(5)
    expect(r.data.toString()).toBe('hello')
  })

  it('handles binary data containing NUL bytes', () => {
    const data = Buffer.from([0, 1, 0, 2, 0])
    const payload = Buffer.concat([encodeUint32(5), encodeString(data)])
    expect(parseDataResponse(payload).data.toString('hex')).toBe(data.toString('hex'))
  })
})

describe('parseAttrsResponse', () => {
  it('parses an ATTRS reply', () => {
    const payload = Buffer.concat([encodeUint32(8), buildAttrs({ size: 42, permissions: 0o100600 })])
    const r = parseAttrsResponse(payload)
    expect(r.id).toBe(8)
    expect(r.attrs.size).toBe(42)
    expect(r.attrs.isFile).toBe(true)
  })
})

describe('parseVersionResponse', () => {
  it('parses the version alone', () => {
    expect(parseVersionResponse(encodeUint32(3))).toEqual({ version: 3, extensions: {} })
  })

  it('parses trailing extension pairs', () => {
    const payload = Buffer.concat([
      encodeUint32(3),
      encodeString('posix-rename@openssh.com'), encodeString('1'),
      encodeString('statvfs@openssh.com'), encodeString('2'),
    ])
    const parsed = parseVersionResponse(payload)
    expect(parsed.version).toBe(3)
    expect(parsed.extensions['posix-rename@openssh.com']).toBe('1')
    expect(parsed.extensions['statvfs@openssh.com']).toBe('2')
  })
})

// ── Client ─────────────────────────────────────────────────────────────────

describe('SftpClient construction', () => {
  it('requires a channel', () => {
    expect(() => new SftpClient({})).toThrow(/requires a channel/)
  })

  it('subscribes to channel data on construction', () => {
    const channel = fakeChannel(() => null)
    const client = new SftpClient({ channel })
    expect(typeof channel.onData).toBe('function')
    expect(client.version).toBe(0)
  })
})

describe('SftpClient.connect', () => {
  it('sends INIT with version 3 and records the negotiated version', async () => {
    const { client, channel } = await connectedClient(() => null)
    expect(channel.requests[0].type).toBe(FXP.INIT)
    expect(channel.requests[0].payload.readUInt32BE(0)).toBe(3)
    expect(client.version).toBe(3)
  })

  it('records the server extensions', async () => {
    const channel = fakeChannel((req) => {
      if (req.type !== FXP.INIT) return null
      return [{
        type: FXP.VERSION,
        payload: Buffer.concat([
          encodeUint32(3),
          encodeString('hardlink@openssh.com'), encodeString('1'),
        ]),
      }]
    })
    const client = new SftpClient({ channel, timeoutMs: 500 })
    await client.connect()
    expect(client.extensions['hardlink@openssh.com']).toBe('1')
  })

  it('accepts a server announcing a newer version and still speaks v3', async () => {
    const channel = fakeChannel((req) => (req.type === FXP.INIT
      ? [{ type: FXP.VERSION, payload: encodeUint32(6) }]
      : null))
    const client = new SftpClient({ channel, timeoutMs: 500 })
    await client.connect()
    expect(client.version).toBe(3)
  })

  it('refuses a server that can only speak version 2', async () => {
    const channel = fakeChannel((req) => (req.type === FXP.INIT
      ? [{ type: FXP.VERSION, payload: encodeUint32(2) }]
      : null))
    const client = new SftpClient({ channel, timeoutMs: 500 })
    await expect(client.connect()).rejects.toThrow(/version 3 is the minimum/)
  })

  it('times out rather than hanging when the server never answers INIT', async () => {
    const channel = fakeChannel(() => null)
    const client = new SftpClient({ channel, timeoutMs: 30 })
    await expect(client.connect()).rejects.toThrow(/timeout/)
  })
})

describe('SftpClient.realpath', () => {
  it('returns the server-canonicalised path, normalised locally', async () => {
    const { client } = await connectedClient((req) => (req.type === FXP.REALPATH
      ? [{ type: FXP.NAME, payload: buildNamePayload(req.id, [{ name: '/home/user' }]) }]
      : null))
    expect(await client.realpath('.')).toBe('/home/user')
  })

  it('normalises a server answer containing .. rather than trusting it verbatim', async () => {
    const { client } = await connectedClient((req) => (req.type === FXP.REALPATH
      ? [{ type: FXP.NAME, payload: buildNamePayload(req.id, [{ name: '/home/user/../root' }]) }]
      : null))
    expect(await client.realpath('.')).toBe('/home/root')
  })

  it('surfaces a STATUS error instead of returning an empty path', async () => {
    const { client } = await connectedClient((req) => (req.type === FXP.REALPATH
      ? [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.NO_SUCH_FILE, 'gone') }]
      : null))
    await expect(client.realpath('/x')).rejects.toThrow(/REALPATH failed \(no such file\): gone/)
  })
})

describe('SftpClient.list', () => {
  /**
   * @param {{name: string, attrs?: object}[][]} batches
   */
  function directoryServer(batches) {
    let batchIndex = 0
    return (req) => {
      if (req.type === FXP.OPENDIR) {
        return [{
          type: FXP.HANDLE,
          payload: Buffer.concat([encodeUint32(req.id), encodeString(Buffer.from('H'))]),
        }]
      }
      if (req.type === FXP.READDIR) {
        if (batchIndex >= batches.length) {
          return [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.EOF) }]
        }
        return [{ type: FXP.NAME, payload: buildNamePayload(req.id, batches[batchIndex++]) }]
      }
      if (req.type === FXP.CLOSE) {
        return [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.OK) }]
      }
      return null
    }
  }

  it('collects every batch until the server reports EOF', async () => {
    const { client, channel } = await connectedClient(directoryServer([
      [{ name: 'a' }, { name: 'b' }],
      [{ name: 'c' }],
    ]))
    const result = await client.list('/data')
    expect(result.entries.map((e) => e.name)).toEqual(['a', 'b', 'c'])
    expect(result.path).toBe('/data')
    expect(channel.requests.filter((r) => r.type === FXP.READDIR)).toHaveLength(3)
  })

  it('joins each name onto the directory path', async () => {
    const { client } = await connectedClient(directoryServer([[{ name: 'a.txt' }]]))
    const result = await client.list('/data/sub')
    expect(result.entries[0].path).toBe('/data/sub/a.txt')
  })

  it('skips . and .. without counting them as unsafe', async () => {
    const { client } = await connectedClient(directoryServer([
      [{ name: '.' }, { name: '..' }, { name: 'real' }],
    ]))
    const result = await client.list('/data')
    expect(result.entries.map((e) => e.name)).toEqual(['real'])
    expect(result.unsafe).toBe(0)
  })

  it('drops and counts a traversal name supplied by the server', async () => {
    // The security case: a compromised server answers with a path that would
    // escape the download directory.
    const { client } = await connectedClient(directoryServer([
      [{ name: 'ok.txt' }, { name: '../../.ssh/authorized_keys' }, { name: 'also-ok' }],
    ]))
    const result = await client.list('/data')
    expect(result.entries.map((e) => e.name)).toEqual(['ok.txt', 'also-ok'])
    expect(result.unsafe).toBe(1)
  })

  it('drops a name carrying control characters', async () => {
    const { client } = await connectedClient(directoryServer([
      [{ name: 'a b' }, { name: 'clean' }],
    ]))
    const result = await client.list('/data')
    expect(result.entries.map((e) => e.name)).toEqual(['clean'])
    expect(result.unsafe).toBe(1)
  })

  it('can return unsafe entries for display without ever joining them', async () => {
    const { client } = await connectedClient(directoryServer([
      [{ name: '../escape' }],
    ]))
    const result = await client.list('/data', { includeUnsafe: true })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].unsafe).toBe(true)
    // joinRemotePath would have thrown; the display path is built separately.
    expect(result.entries[0].path).toBe('/data/../escape')
  })

  it('always closes the directory handle, including after an error', async () => {
    const failing = (req) => {
      if (req.type === FXP.OPENDIR) {
        return [{
          type: FXP.HANDLE,
          payload: Buffer.concat([encodeUint32(req.id), encodeString(Buffer.from('H'))]),
        }]
      }
      if (req.type === FXP.READDIR) {
        return [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.FAILURE, 'boom') }]
      }
      return [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.OK) }]
    }
    const { client, channel } = await connectedClient(failing)
    await expect(client.list('/data')).rejects.toThrow(/READDIR failed .*boom/)
    expect(channel.requests.some((r) => r.type === FXP.CLOSE)).toBe(true)
  })

  it('reports an OPENDIR failure', async () => {
    const { client } = await connectedClient((req) => (req.type === FXP.OPENDIR
      ? [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.PERMISSION_DENIED, 'denied') }]
      : null))
    await expect(client.list('/root')).rejects.toThrow(/OPENDIR failed \(permission denied\)/)
  })

  it('stops at the caller\'s entry cap', async () => {
    const { client } = await connectedClient(directoryServer([
      [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    ]))
    const result = await client.list('/data', { maxEntries: 2 })
    expect(result.entries).toHaveLength(2)
  })

  it('stops rather than looping when a server answers NAME with an empty batch forever', async () => {
    const { client } = await connectedClient((req) => {
      if (req.type === FXP.OPENDIR) {
        return [{
          type: FXP.HANDLE,
          payload: Buffer.concat([encodeUint32(req.id), encodeString(Buffer.from('H'))]),
        }]
      }
      if (req.type === FXP.READDIR) {
        return [{ type: FXP.NAME, payload: buildNamePayload(req.id, []) }]
      }
      return [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.OK) }]
    })
    await expect(client.list('/data')).resolves.toMatchObject({ entries: [] })
  })

  it('normalises the requested directory path', async () => {
    const { client, channel } = await connectedClient(directoryServer([[]]))
    await client.list('/data/./sub/../other')
    const opendir = channel.requests.find((r) => r.type === FXP.OPENDIR)
    const reader = new SSHReader(opendir.payload)
    reader.readUint32()
    expect(reader.readString()).toBe('/data/other')
  })
})

describe('SftpClient.download', () => {
  /**
   * @param {Buffer} content
   * @param {{chunk?: number}} [opts]
   */
  function fileServer(content, opts = {}) {
    const chunk = opts.chunk ?? 8
    return (req) => {
      if (req.type === FXP.OPEN) {
        return [{
          type: FXP.HANDLE,
          payload: Buffer.concat([encodeUint32(req.id), encodeString(Buffer.from('F'))]),
        }]
      }
      if (req.type === FXP.READ) {
        const r = new SSHReader(req.payload)
        r.readUint32()
        r.readBytes()
        const offset = Number(r.readUint64())
        if (offset >= content.length) {
          return [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.EOF) }]
        }
        const slice = content.subarray(offset, offset + chunk)
        return [{
          type: FXP.DATA,
          payload: Buffer.concat([encodeUint32(req.id), encodeString(slice)]),
        }]
      }
      return [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.OK) }]
    }
  }

  it('reassembles a file from short reads', async () => {
    const content = Buffer.from('the quick brown fox jumps over the lazy dog')
    const { client } = await connectedClient(fileServer(content, { chunk: 7 }))
    const result = await client.download('/f.txt')
    expect(result.toString()).toBe(content.toString())
  })

  it('opens for reading only', async () => {
    const { client, channel } = await connectedClient(fileServer(Buffer.from('x')))
    await client.download('/f.txt')
    const open = channel.requests.find((r) => r.type === FXP.OPEN)
    const reader = new SSHReader(open.payload)
    reader.readUint32()
    expect(reader.readString()).toBe('/f.txt')
    expect(reader.readUint32()).toBe(SSH_FXF_READ)
  })

  it('advances the offset on every read', async () => {
    const { client, channel } = await connectedClient(fileServer(Buffer.alloc(20, 9), { chunk: 5 }))
    await client.download('/f.bin')
    const offsets = channel.requests
      .filter((r) => r.type === FXP.READ)
      .map((r) => {
        const reader = new SSHReader(r.payload)
        reader.readUint32()
        reader.readBytes()
        return Number(reader.readUint64())
      })
    expect(offsets).toEqual([0, 5, 10, 15, 20])
  })

  it('returns an empty buffer for an empty file', async () => {
    const { client } = await connectedClient(fileServer(Buffer.alloc(0)))
    expect((await client.download('/empty')).length).toBe(0)
  })

  it('preserves binary content exactly', async () => {
    const content = Buffer.from([0, 255, 128, 0, 1, 254])
    const { client } = await connectedClient(fileServer(content, { chunk: 4 }))
    expect((await client.download('/b.bin')).toString('hex')).toBe(content.toString('hex'))
  })

  it('aborts when the download exceeds the caller\'s limit', async () => {
    const { client } = await connectedClient(fileServer(Buffer.alloc(1000), { chunk: 100 }))
    await expect(client.download('/big', { maxBytes: 250 })).rejects.toThrow(/exceeded 250 bytes/)
  })

  it('never lets a per-call limit raise the client-wide ceiling', async () => {
    const channel = fakeChannel((req) => versionResponse(req)
      ?? fileServer(Buffer.alloc(5000), { chunk: 500 })(req))
    const client = new SftpClient({ channel, timeoutMs: 500, maxDownloadBytes: 1000 })
    await client.connect()
    await expect(client.download('/big', { maxBytes: 1024 * 1024 }))
      .rejects.toThrow(/exceeded 1000 bytes/)
  })

  it('closes the handle even when the size limit trips', async () => {
    const { client, channel } = await connectedClient(fileServer(Buffer.alloc(1000), { chunk: 100 }))
    await expect(client.download('/big', { maxBytes: 150 })).rejects.toThrow()
    expect(channel.requests.some((r) => r.type === FXP.CLOSE)).toBe(true)
  })

  it('reports an OPEN failure', async () => {
    const { client } = await connectedClient((req) => (req.type === FXP.OPEN
      ? [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.NO_SUCH_FILE, 'missing') }]
      : null))
    await expect(client.download('/nope')).rejects.toThrow(/OPEN failed \(no such file\): missing/)
  })

  it('reports a mid-transfer READ failure rather than returning a partial file', async () => {
    let first = true
    const { client } = await connectedClient((req) => {
      if (req.type === FXP.OPEN) {
        return [{
          type: FXP.HANDLE,
          payload: Buffer.concat([encodeUint32(req.id), encodeString(Buffer.from('F'))]),
        }]
      }
      if (req.type === FXP.READ) {
        if (first) {
          first = false
          return [{
            type: FXP.DATA,
            payload: Buffer.concat([encodeUint32(req.id), encodeString(Buffer.from('partial'))]),
          }]
        }
        return [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.FAILURE, 'disk error') }]
      }
      return [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.OK) }]
    })
    await expect(client.download('/f')).rejects.toThrow(/READ failed .*disk error/)
  })

  it('normalises the requested path', async () => {
    const { client, channel } = await connectedClient(fileServer(Buffer.from('x')))
    await client.download('/a/b/../c.txt')
    const open = channel.requests.find((r) => r.type === FXP.OPEN)
    const reader = new SSHReader(open.payload)
    reader.readUint32()
    expect(reader.readString()).toBe('/a/c.txt')
  })
})

describe('SftpClient.stat', () => {
  it('sends STAT and returns parsed attributes', async () => {
    const { client, channel } = await connectedClient((req) => (req.type === FXP.STAT
      ? [{
        type: FXP.ATTRS,
        payload: Buffer.concat([
          encodeUint32(req.id),
          buildAttrs({ size: 99, permissions: 0o100644, mtime: 1_600_000_000 }),
        ]),
      }]
      : null))
    const attrs = await client.stat('/f.txt')
    expect(attrs.size).toBe(99)
    expect(attrs.isFile).toBe(true)
    expect(attrs.mtime.getTime()).toBe(1_600_000_000_000)
    expect(channel.requests.some((r) => r.type === FXP.STAT)).toBe(true)
  })

  it('sends LSTAT when symlinks must not be followed', async () => {
    const { client, channel } = await connectedClient((req) => (req.type === FXP.LSTAT
      ? [{
        type: FXP.ATTRS,
        payload: Buffer.concat([encodeUint32(req.id), buildAttrs({ permissions: 0o120777 })]),
      }]
      : null))
    const attrs = await client.stat('/link', { followSymlinks: false })
    expect(attrs.isSymlink).toBe(true)
    expect(channel.requests.some((r) => r.type === FXP.LSTAT)).toBe(true)
  })

  it('reports a failure status', async () => {
    const { client } = await connectedClient((req) => (req.type === FXP.STAT
      ? [{ type: FXP.STATUS, payload: buildStatusPayload(req.id, FX.NO_SUCH_FILE, 'gone') }]
      : null))
    await expect(client.stat('/x')).rejects.toThrow(/STAT failed \(no such file\)/)
  })

  it('supports FSTAT on an open handle', async () => {
    const { client } = await connectedClient((req) => (req.type === FXP.FSTAT
      ? [{
        type: FXP.ATTRS,
        payload: Buffer.concat([encodeUint32(req.id), buildAttrs({ size: 5 })]),
      }]
      : null))
    expect((await client.fstat(Buffer.from('H'))).size).toBe(5)
  })
})

describe('SftpClient.readlink', () => {
  it('returns the link target', async () => {
    const { client } = await connectedClient((req) => (req.type === FXP.READLINK
      ? [{ type: FXP.NAME, payload: buildNamePayload(req.id, [{ name: '../target' }]) }]
      : null))
    expect(await client.readlink('/link')).toBe('../target')
  })
})

describe('SftpClient request correlation', () => {
  it('matches each response to its own request id', async () => {
    // Responses deliberately arrive out of order; a client that assumed FIFO
    // would hand back the wrong file's bytes.
    /** @type {Map<number, Function>} */
    const deferred = new Map()
    const channel = fakeChannel((req) => {
      if (req.type === FXP.INIT) return [{ type: FXP.VERSION, payload: encodeUint32(3) }]
      if (req.type === FXP.STAT) {
        const reader = new SSHReader(req.payload)
        reader.readUint32()
        const path = reader.readString()
        deferred.set(req.id, () => channel.onData(encodeSftpPacket(FXP.ATTRS, Buffer.concat([
          encodeUint32(req.id),
          buildAttrs({ size: path === '/a' ? 1 : 2 }),
        ]))))
        return null
      }
      return null
    })
    const client = new SftpClient({ channel, timeoutMs: 500 })
    await client.connect()

    const a = client.stat('/a')
    const b = client.stat('/b')
    // Answer in reverse order.
    const answers = [...deferred.values()].reverse()
    for (const answer of answers) answer()

    expect((await a).size).toBe(1)
    expect((await b).size).toBe(2)
  })

  it('ignores a response whose id matches nothing outstanding', async () => {
    const { client, channel } = await connectedClient(() => null)
    expect(() => channel.onData(encodeSftpPacket(FXP.ATTRS, Buffer.concat([
      encodeUint32(9999), buildAttrs({ size: 1 }),
    ])))).not.toThrow()
    expect(client._fatal).toBeNull()
  })

  it('fails every outstanding request when the stream is corrupt', async () => {
    const { client, channel } = await connectedClient(() => null)
    const pending = client.stat('/x')
    channel.onData(Buffer.concat([encodeUint32(0x7fffffff), Buffer.alloc(8)]))
    await expect(pending).rejects.toThrow(/Implausible SFTP packet length/)
  })

  it('refuses further requests after a fatal stream error', async () => {
    const { client, channel } = await connectedClient(() => null)
    channel.onData(Buffer.concat([encodeUint32(0x7fffffff), Buffer.alloc(8)]))
    await expect(client.stat('/x')).rejects.toThrow(/Implausible SFTP packet length/)
  })

  it('times out a request the server never answers, without leaking the pending entry', async () => {
    const channel = fakeChannel((req) => versionResponse(req))
    const client = new SftpClient({ channel, timeoutMs: 30 })
    await client.connect()
    await expect(client.stat('/x')).rejects.toThrow(/timeout/)
    expect(client._pending.size).toBe(0)
  })
})

describe('SftpClient.close', () => {
  it('detaches from the channel and closes it', async () => {
    const { client, channel } = await connectedClient(() => null)
    await client.close()
    expect(channel.onData).toBeNull()
    expect(channel.closed).toBe(true)
  })

  it('tolerates a channel with no close method', async () => {
    const channel = fakeChannel((req) => versionResponse(req))
    delete channel.close
    const client = new SftpClient({ channel, timeoutMs: 500 })
    await client.connect()
    await expect(client.close()).resolves.toBeUndefined()
  })
})

describe('connectSftp', () => {
  it('requires a host and a user', async () => {
    await expect(connectSftp({ user: 'u' })).rejects.toThrow(/requires a host/)
    await expect(connectSftp({ host: 'h' })).rejects.toThrow(/requires a user/)
  })

  it('fails closed when the host key is unknown and no trust decision was given', async () => {
    // The socket is a stub that emits an identification string and nothing
    // else; the connection must not proceed regardless.
    const socket = {
      handlers: {},
      on(event, fn) {
        (this.handlers[event] ??= []).push(fn)
        return this
      },
      once(event, fn) {
        return this.on(event, fn)
      },
      write: vi.fn(),
      destroy: vi.fn(),
    }
    await expect(connectSftp({
      host: 'example.com',
      user: 'alice',
      password: 'x',
      timeoutMs: 40,
      connectFn: () => socket,
    })).rejects.toThrow()
    expect(socket.destroy).toHaveBeenCalled()
  })
})
