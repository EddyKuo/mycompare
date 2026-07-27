/**
 * Unit tests for src/main/remote-ftp.js.
 *
 * No real network connection is made anywhere in this file. The protocol logic
 * is exercised through an injected fake socket, and everything else is a pure
 * parser fed with literal server output — including output captured from
 * servers that format things badly, which is where FTP clients actually break.
 */

import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import {
  FtpResponseParser,
  FtpClient,
  parsePasvResponse,
  parseEpsvResponse,
  parseSizeResponse,
  parseMdtmResponse,
  parseUnixListLine,
  parseDosListLine,
  parseListLine,
  parseListing,
  isSafeRemoteName,
  sanitizeRemoteName,
  hasControlChar,
  stripControlChars,
  normaliseRemotePath,
  joinRemotePath,
} from '../../src/main/remote-ftp.js'

const NOW = new Date(Date.UTC(2025, 5, 15, 12, 0, 0)) // 2025-06-15

// ── Reply parsing ──────────────────────────────────────────────────────────

describe('FtpResponseParser', () => {
  it('parses a single-line reply', () => {
    const p = new FtpResponseParser()
    expect(p.push('220 Service ready\r\n')).toEqual([
      { code: 220, lines: ['Service ready'], text: 'Service ready' },
    ])
  })

  it('parses a multi-line reply as one reply', () => {
    const p = new FtpResponseParser()
    const replies = p.push(
      '220-Welcome to the server\r\n' +
      '220-Unauthorised access prohibited\r\n' +
      '220 Ready.\r\n',
    )
    expect(replies).toHaveLength(1)
    expect(replies[0].code).toBe(220)
    expect(replies[0].lines).toEqual([
      'Welcome to the server',
      'Unauthorised access prohibited',
      'Ready.',
    ])
  })

  it('does not end a multi-line reply on a different code', () => {
    const p = new FtpResponseParser()
    const replies = p.push('211-Features:\r\n 211 not the end\r\n211 End\r\n')
    expect(replies).toHaveLength(1)
    expect(replies[0].lines).toEqual(['Features:', ' 211 not the end', 'End'])
  })

  it('does not end a multi-line reply on a continuation with the same code', () => {
    const p = new FtpResponseParser()
    expect(p.push('230-User logged in\r\n')).toEqual([])
    expect(p.push('230-Directory is /home\r\n')).toEqual([])
    const done = p.push('230 Access granted\r\n')
    expect(done).toHaveLength(1)
    expect(done[0].lines).toHaveLength(3)
  })

  it('reassembles replies split across chunks mid-line', () => {
    const p = new FtpResponseParser()
    expect(p.push('220 Serv')).toEqual([])
    expect(p.push('ice re')).toEqual([])
    const out = p.push('ady\r\n331 Password\r\n')
    expect(out.map((r) => r.code)).toEqual([220, 331])
  })

  it('accepts bare LF as well as CRLF', () => {
    const p = new FtpResponseParser()
    expect(p.push('200 OK\n')[0].code).toBe(200)
  })

  it('ignores a stray non-reply line rather than desynchronising', () => {
    const p = new FtpResponseParser()
    const out = p.push('garbage from a proxy\r\n226 Transfer complete\r\n')
    expect(out).toHaveLength(1)
    expect(out[0].code).toBe(226)
  })

  it('refuses to buffer an unbounded reply', () => {
    const p = new FtpResponseParser({ maxBufferBytes: 32 })
    expect(() => p.push('220-'.padEnd(64, 'x'))).toThrow(/buffer limit/)
  })
})

// ── PASV / EPSV / SIZE / MDTM ──────────────────────────────────────────────

describe('parsePasvResponse', () => {
  it('parses the canonical form', () => {
    expect(parsePasvResponse('Entering Passive Mode (192,168,0,10,195,80)'))
      .toEqual({ host: '192.168.0.10', port: 195 * 256 + 80 })
  })

  it('parses without parentheses and with extra prose', () => {
    expect(parsePasvResponse('Passive mode OK 10,0,0,1,4,1 have fun'))
      .toEqual({ host: '10.0.0.1', port: 1025 })
  })

  it('tolerates spaces around the separators', () => {
    expect(parsePasvResponse('227 (127, 0, 0, 1, 200, 1)').port).toBe(200 * 256 + 1)
  })

  it('rejects an octet above 255', () => {
    expect(() => parsePasvResponse('227 (999,0,0,1,4,1)')).toThrow(/Malformed PASV/)
  })

  it('rejects a reply with no numbers', () => {
    expect(() => parsePasvResponse('227 Entering Passive Mode')).toThrow(/Malformed PASV/)
  })

  it('rejects a non-string', () => {
    expect(() => parsePasvResponse(null)).toThrow(TypeError)
  })
})

describe('parseEpsvResponse', () => {
  it('parses the canonical form', () => {
    expect(parseEpsvResponse('229 Entering Extended Passive Mode (|||49152|)'))
      .toEqual({ port: 49152 })
  })

  it('accepts an alternative delimiter', () => {
    expect(parseEpsvResponse('229 EPSV ok (!!!1024!)')).toEqual({ port: 1024 })
  })

  it('rejects garbage and out-of-range ports', () => {
    expect(() => parseEpsvResponse('229 ok')).toThrow(/Malformed EPSV/)
    expect(() => parseEpsvResponse('229 (|||99999|)')).toThrow(/Malformed EPSV/)
  })
})

describe('parseSizeResponse / parseMdtmResponse', () => {
  it('reads a SIZE reply', () => {
    expect(parseSizeResponse('213 4096')).toBe(4096)
    expect(parseSizeResponse('4096')).toBe(4096)
  })

  it('rejects a SIZE reply with no number', () => {
    expect(() => parseSizeResponse('550 Not a regular file')).toThrow(/Malformed SIZE/)
  })

  it('reads an MDTM reply as UTC', () => {
    expect(parseMdtmResponse('213 20240115123456').toISOString())
      .toBe('2024-01-15T12:34:56.000Z')
  })

  it('reads fractional seconds', () => {
    expect(parseMdtmResponse('213 20240115123456.789').toISOString())
      .toBe('2024-01-15T12:34:56.789Z')
  })

  it('rejects a malformed MDTM reply', () => {
    expect(() => parseMdtmResponse('550 not found')).toThrow(/Malformed MDTM/)
  })
})

// ── LIST: Unix format ──────────────────────────────────────────────────────

describe('parseUnixListLine', () => {
  it('parses a regular file', () => {
    const e = parseUnixListLine('-rw-r--r--   1 owner group        1024 Mar 10 12:34 notes.txt', NOW)
    expect(e).toMatchObject({
      name: 'notes.txt', isDirectory: false, isSymlink: false, size: 1024, format: 'unix',
    })
    expect(e.mtime.toISOString()).toBe('2025-03-10T12:34:00.000Z')
  })

  it('parses a directory and forces its size to 0', () => {
    const e = parseUnixListLine('drwxr-xr-x   2 owner group        4096 Jan  5 09:00 src', NOW)
    expect(e).toMatchObject({ name: 'src', isDirectory: true, size: 0 })
  })

  it('keeps spaces in a filename', () => {
    const e = parseUnixListLine('-rw-r--r-- 1 o g 12 Mar 10 12:34 my report final.txt', NOW)
    expect(e.name).toBe('my report final.txt')
  })

  it('keeps leading spaces that are part of the name', () => {
    const e = parseUnixListLine('-rw-r--r-- 1 o g 12 Mar 10 12:34   indented.txt', NOW)
    expect(e.name).toBe('  indented.txt')
  })

  it('parses a symlink and splits off its target', () => {
    const e = parseUnixListLine('lrwxrwxrwx 1 o g 7 Mar 10 12:34 current -> releases/1.2', NOW)
    expect(e).toMatchObject({ name: 'current', isSymlink: true, linkTarget: 'releases/1.2' })
  })

  it('parses the year form used for older files', () => {
    const e = parseUnixListLine('-rw-r--r-- 1 o g 88 Feb  3  2019 old.log', NOW)
    expect(e.mtime.toISOString()).toBe('2019-02-03T00:00:00.000Z')
  })

  it('assigns the previous year when the bare-time date would be in the future', () => {
    // NOW is June 2025, so a December timestamp must be December 2024.
    const e = parseUnixListLine('-rw-r--r-- 1 o g 5 Dec 24 23:59 xmas.txt', NOW)
    expect(e.mtime.getUTCFullYear()).toBe(2024)
  })

  it('handles a listing with no group column', () => {
    const e = parseUnixListLine('-rw-r--r--  1 ftp           512 Mar 10 12:34 solo.bin', NOW)
    expect(e).toMatchObject({ name: 'solo.bin', size: 512 })
  })

  it('handles an ACL / SELinux marker appended to the mode', () => {
    const e = parseUnixListLine('-rw-r--r--+  1 o g 64 Mar 10 12:34 acl.txt', NOW)
    expect(e.name).toBe('acl.txt')
    const e2 = parseUnixListLine('-rw-r--r--.  1 o g 64 Mar 10 12:34 selinux.txt', NOW)
    expect(e2.name).toBe('selinux.txt')
  })

  it('handles setuid / sticky bits in the mode column', () => {
    expect(parseUnixListLine('drwxrwsrwt 4 o g 4096 Mar 10 12:34 tmp', NOW).name).toBe('tmp')
  })

  it('parses a device / socket / fifo type without claiming it is a directory', () => {
    const e = parseUnixListLine('crw-rw-rw- 1 root root 0 Mar 10 12:34 null', NOW)
    expect(e).toMatchObject({ name: 'null', isDirectory: false })
  })

  it('returns null for a non-listing line', () => {
    expect(parseUnixListLine('total 128', NOW)).toBeNull()
    expect(parseUnixListLine('', NOW)).toBeNull()
    expect(parseUnixListLine('-rw-r--r-- 1 o g not-a-size Mar 10 12:34 x', NOW)).toBeNull()
    expect(parseUnixListLine(null, NOW)).toBeNull()
  })

  it('returns null when the mode column is present but the date is missing', () => {
    expect(parseUnixListLine('-rw-r--r-- 1 o g 1024 nodate here.txt', NOW)).toBeNull()
  })

  it('returns null when there is a mode but no name after the date', () => {
    expect(parseUnixListLine('-rw-r--r-- 1 o g 1024 Mar 10 12:34', NOW)).toBeNull()
  })
})

// ── LIST: DOS / IIS format ─────────────────────────────────────────────────

describe('parseDosListLine', () => {
  it('parses a directory', () => {
    const e = parseDosListLine('03-10-25  12:34PM       <DIR>          Program Files')
    expect(e).toMatchObject({
      name: 'Program Files', isDirectory: true, size: 0, format: 'dos',
    })
    expect(e.mtime.toISOString()).toBe('2025-03-10T12:34:00.000Z')
  })

  it('parses a file with a thousands-separated size', () => {
    const e = parseDosListLine('12-31-99  11:59PM              1,234 report.txt')
    expect(e).toMatchObject({ name: 'report.txt', size: 1234, isDirectory: false })
    expect(e.mtime.getUTCFullYear()).toBe(1999)
  })

  it('reads the date as MM-DD-YY, not DD-MM-YY', () => {
    // 03-10 is 10 March, not 3 October.
    const e = parseDosListLine('03-10-25  01:00AM                 5 x.txt')
    expect(e.mtime.getUTCMonth()).toBe(2)
    expect(e.mtime.getUTCDate()).toBe(10)
  })

  it('converts 12AM to 00:00 and 12PM to 12:00', () => {
    expect(parseDosListLine('01-01-24  12:00AM   5 a').mtime.getUTCHours()).toBe(0)
    expect(parseDosListLine('01-01-24  12:00PM   5 a').mtime.getUTCHours()).toBe(12)
  })

  it('accepts slash separators and a 24-hour clock', () => {
    const e = parseDosListLine('01/02/2024  18:05       <DIR>          data')
    expect(e.mtime.toISOString()).toBe('2024-01-02T18:05:00.000Z')
  })

  it('rolls a two-digit year below 70 into the 2000s', () => {
    expect(parseDosListLine('01-01-05  01:00AM  5 a').mtime.getUTCFullYear()).toBe(2005)
    expect(parseDosListLine('01-01-85  01:00AM  5 a').mtime.getUTCFullYear()).toBe(1985)
  })

  it('rejects an impossible date', () => {
    expect(parseDosListLine('13-40-25  12:34PM       <DIR>          bad')).toBeNull()
  })

  it('rejects a non-listing line', () => {
    expect(parseDosListLine('total 5')).toBeNull()
    expect(parseDosListLine(undefined)).toBeNull()
  })
})

describe('parseListLine', () => {
  it('dispatches to whichever format matches', () => {
    expect(parseListLine('-rw-r--r-- 1 o g 5 Mar 10 12:34 u.txt', NOW).format).toBe('unix')
    expect(parseListLine('03-10-25  12:34PM   5 d.txt').format).toBe('dos')
    expect(parseListLine('   ', NOW)).toBeNull()
  })
})

// ── LIST: whole responses ──────────────────────────────────────────────────

describe('parseListing', () => {
  it('parses a Unix listing and drops the header, . and ..', () => {
    const text = [
      'total 12',
      'drwxr-xr-x  2 o g 4096 Mar 10 12:34 .',
      'drwxr-xr-x  4 o g 4096 Mar 10 12:34 ..',
      'drwxr-xr-x  2 o g 4096 Mar 10 12:34 assets',
      '-rw-r--r--  1 o g  128 Mar 10 12:35 index.html',
    ].join('\r\n')
    const { entries, skipped } = parseListing(text, { now: NOW })
    expect(entries.map((e) => e.name)).toEqual(['assets', 'index.html'])
    expect(skipped).toBe(1) // 'total 12'
  })

  it('parses a DOS listing', () => {
    const text = '03-10-25  12:34PM       <DIR>          bin\r\n03-10-25  12:35PM   42 go.exe\r\n'
    expect(parseListing(text).entries.map((e) => e.name)).toEqual(['bin', 'go.exe'])
  })

  it('accepts a Buffer', () => {
    const buf = Buffer.from('-rw-r--r-- 1 o g 5 Mar 10 12:34 b.txt\r\n')
    expect(parseListing(buf, { now: NOW }).entries).toHaveLength(1)
  })

  it('drops entries whose name would escape the directory', () => {
    const text = [
      '-rw-r--r-- 1 o g 5 Mar 10 12:34 ../../../etc/passwd',
      '-rw-r--r-- 1 o g 5 Mar 10 12:34 /etc/shadow',
      '-rw-r--r-- 1 o g 5 Mar 10 12:34 ..\\..\\windows\\system32\\x',
      '-rw-r--r-- 1 o g 5 Mar 10 12:34 safe.txt',
    ].join('\n')
    const { entries, unsafe } = parseListing(text, { now: NOW })
    expect(entries.map((e) => e.name)).toEqual(['safe.txt'])
    expect(unsafe).toBe(3)
  })

  it('can surface unsafe entries when explicitly asked, still flagged', () => {
    const text = '-rw-r--r-- 1 o g 5 Mar 10 12:34 ../escape\n'
    const { entries } = parseListing(text, { now: NOW, includeUnsafe: true })
    expect(entries).toHaveLength(1)
    expect(entries[0].unsafe).toBe(true)
  })

  it('survives a mixed / partly corrupt listing without throwing', () => {
    const text = [
      'drwxr-xr-x  2 o g 4096 Mar 10 12:34 ok',
      '%%% vendor banner %%%',
      '',
      '-rw-r--r--',
      '03-10-25  12:34PM   7 dos.txt',
    ].join('\n')
    const { entries, skipped } = parseListing(text, { now: NOW })
    expect(entries.map((e) => e.name)).toEqual(['ok', 'dos.txt'])
    expect(skipped).toBe(2)
  })

  it('returns an empty result for empty input', () => {
    expect(parseListing('').entries).toEqual([])
    expect(parseListing(null).entries).toEqual([])
  })
})

// ── Untrusted names and paths ──────────────────────────────────────────────

describe('hasControlChar / stripControlChars', () => {
  it('detects and removes C0 controls and DEL', () => {
    expect(hasControlChar('a b')).toBe(true)
    expect(hasControlChar('ab')).toBe(true)
    expect(hasControlChar('a\nb')).toBe(true)
    expect(hasControlChar('plain')).toBe(false)
    expect(stripControlChars('a bc')).toBe('abc')
  })
})

describe('isSafeRemoteName', () => {
  it('accepts ordinary names', () => {
    for (const n of ['a.txt', 'My File.TXT', '.hidden', 'ünïcødé.md', 'a'.repeat(255)]) {
      expect(isSafeRemoteName(n), n).toBe(true)
    }
  })

  it('rejects traversal and separators', () => {
    for (const n of ['..', '.', '../x', 'a/b', 'a\\b', '/abs']) {
      expect(isSafeRemoteName(n), n).toBe(false)
    }
  })

  it('rejects control characters, including a NUL truncation attempt', () => {
    expect(isSafeRemoteName('safe.txt .exe')).toBe(false)
    expect(isSafeRemoteName('ab')).toBe(false)
  })

  it('rejects Windows drive-relative names and alternate data streams', () => {
    expect(isSafeRemoteName('C:evil')).toBe(false)
    expect(isSafeRemoteName('file.txt:stream')).toBe(false)
  })

  it('rejects names Windows would silently truncate', () => {
    expect(isSafeRemoteName('report.txt.')).toBe(false)
    expect(isSafeRemoteName('report.txt ')).toBe(false)
  })

  it('rejects empty, over-long and non-string input', () => {
    expect(isSafeRemoteName('')).toBe(false)
    expect(isSafeRemoteName('a'.repeat(256))).toBe(false)
    expect(isSafeRemoteName(null)).toBe(false)
    expect(isSafeRemoteName(42)).toBe(false)
  })
})

describe('sanitizeRemoteName', () => {
  it('replaces separators and strips controls', () => {
    expect(sanitizeRemoteName('a/b\\c')).toBe('a_b_c')
    expect(sanitizeRemoteName('a b')).toBe('ab')
    expect(sanitizeRemoteName('x.txt.')).toBe('x.txt')
  })

  it('returns null when nothing usable remains', () => {
    expect(sanitizeRemoteName('..')).toBeNull()
    expect(sanitizeRemoteName('')).toBeNull()
    expect(sanitizeRemoteName(' ')).toBeNull()
    expect(sanitizeRemoteName(null)).toBeNull()
  })

  it('truncates to a usable length', () => {
    expect(sanitizeRemoteName('a'.repeat(400))).toHaveLength(255)
  })
})

describe('normaliseRemotePath / joinRemotePath', () => {
  it('resolves . and .. lexically and cannot escape the root', () => {
    expect(normaliseRemotePath('/a/b/../c')).toBe('/a/c')
    expect(normaliseRemotePath('/../../../etc/passwd')).toBe('/etc/passwd')
    expect(normaliseRemotePath('a//b/./c/')).toBe('/a/b/c')
    expect(normaliseRemotePath('')).toBe('/')
    expect(normaliseRemotePath(null)).toBe('/')
  })

  it('treats backslashes as separators so a Windows-style path cannot smuggle a segment', () => {
    expect(normaliseRemotePath('/a\\..\\..\\b')).toBe('/b')
  })

  it('joins a validated name', () => {
    expect(joinRemotePath('/a/b', 'c.txt')).toBe('/a/b/c.txt')
    expect(joinRemotePath('/', 'c.txt')).toBe('/c.txt')
  })

  it('refuses to join an unsafe name', () => {
    expect(() => joinRemotePath('/a', '../b')).toThrow(/Unsafe remote name/)
    expect(() => joinRemotePath('/a', 'x/y')).toThrow(/Unsafe remote name/)
  })
})

// ── Client, against a scripted fake socket ─────────────────────────────────

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.written = []
    this.destroyed = false
    /** @type {((line: string) => void)|null} */
    this.onWrite = null
  }

  setEncoding() { /* fake */ }

  write(data) {
    this.written.push(data)
    this.onWrite?.(String(data))
    return true
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    setTimeout(() => this.emit('close'), 0)
  }
}

/**
 * Build an injectable `connectFn` that scripts a whole FTP conversation.
 * The first connection is the control channel; later ones are data channels.
 */
function createFtpEnv(opts = {}) {
  const {
    greeting = '220 Service ready\r\n',
    payload = Buffer.alloc(0),
    pasvReply = '227 Entering Passive Mode (10,0,0,99,4,1)\r\n',
    silentGreeting = false,
    overrides = {},
  } = opts

  /** @type {{opts: object, socket: FakeSocket}[]} */
  const connects = []
  /** @type {FakeSocket|null} */
  let control = null
  /** @type {FakeSocket|null} */
  let pendingData = null

  const reply = (text, delay = 0) => setTimeout(() => control?.emit('data', text), delay)

  const handle = (raw) => {
    const line = raw.trim()
    const verb = line.split(' ')[0].toUpperCase()
    if (overrides[verb]) {
      reply(overrides[verb])
      return
    }
    switch (verb) {
      case 'USER': reply('331 Password required for user\r\n'); break
      case 'PASS': reply('230 User logged in\r\n'); break
      case 'TYPE': reply('200 Type set to I\r\n'); break
      case 'PASV': reply(pasvReply); break
      case 'PWD': reply('257 "/home/user" is the current directory\r\n'); break
      case 'CWD': reply('250 Directory changed\r\n'); break
      case 'SIZE': reply('213 4096\r\n'); break
      case 'MDTM': reply('213 20240115123456\r\n'); break
      case 'QUIT': reply('221 Goodbye\r\n'); break
      case 'LIST':
      case 'RETR': {
        const data = pendingData
        reply('150 Opening BINARY mode data connection\r\n')
        setTimeout(() => {
          if (payload.length) data?.emit('data', payload)
          data?.emit('end')
        }, 2)
        reply('226 Transfer complete\r\n', 4)
        break
      }
      default: reply('502 Command not implemented\r\n')
    }
  }

  const connectFn = (o, cb) => {
    const socket = new FakeSocket()
    connects.push({ opts: o, socket })
    if (!control) {
      control = socket
      socket.onWrite = handle
      setTimeout(() => {
        cb?.()
        if (!silentGreeting) socket.emit('data', greeting)
      }, 0)
    } else {
      pendingData = socket
      setTimeout(() => cb?.(), 0)
    }
    return socket
  }

  return { connectFn, connects, get control() { return control } }
}

/** @param {object} [opts] */
function makeClient(env, opts = {}) {
  return new FtpClient({
    host: 'ftp.example.com',
    user: 'alice',
    password: 'hunter2',
    timeoutMs: 500,
    connectFn: env.connectFn,
    ...opts,
  })
}

describe('FtpClient', () => {
  it('rejects construction without a host', () => {
    expect(() => new FtpClient({})).toThrow(/requires a host/)
    expect(() => new FtpClient()).toThrow(/requires a host/)
  })

  it('performs the login handshake in order', async () => {
    const env = createFtpEnv()
    const client = makeClient(env)
    await client.connect()
    expect(env.control.written).toEqual([
      'USER alice\r\n',
      'PASS hunter2\r\n',
      'TYPE I\r\n',
    ])
    await client.close()
  })

  it('skips PASS when the server accepts USER outright', async () => {
    const env = createFtpEnv({ overrides: { USER: '230 Anonymous access granted\r\n' } })
    const client = makeClient(env)
    await client.connect()
    expect(env.control.written.some((l) => l.startsWith('PASS'))).toBe(false)
    await client.close()
  })

  it('tolerates a multi-line greeting banner', async () => {
    const env = createFtpEnv({
      greeting: '220-Welcome\r\n220-Be nice\r\n220 Ready\r\n',
    })
    const client = makeClient(env)
    await expect(client.connect()).resolves.toBeDefined()
    await client.close()
  })

  it('fails clearly on a bad password', async () => {
    const env = createFtpEnv({ overrides: { PASS: '530 Login incorrect\r\n' } })
    const client = makeClient(env)
    await expect(client.connect()).rejects.toThrow(/PASS failed: 530/)
  })

  it('does not leak the password into the error message', async () => {
    const env = createFtpEnv({ overrides: { PASS: '530 Login incorrect\r\n' } })
    const client = makeClient(env)
    await client.connect().catch((err) => {
      expect(err.message).not.toContain('hunter2')
    })
  })

  it('rejects a server that refuses at the greeting', async () => {
    const env = createFtpEnv({ greeting: '421 Too many connections\r\n' })
    const client = makeClient(env)
    await expect(client.connect()).rejects.toThrow(/refused: 421/)
  })

  it('times out when the server never sends a greeting', async () => {
    const env = createFtpEnv({ silentGreeting: true })
    const client = makeClient(env, { timeoutMs: 30 })
    await expect(client.connect()).rejects.toThrow(/timeout after 30ms/)
  })

  it('times out a command the server never answers', async () => {
    const env = createFtpEnv({ overrides: { SIZE: undefined } })
    const client = makeClient(env, { timeoutMs: 40 })
    await client.connect()
    // Replace the handler so SIZE gets no reply at all.
    env.control.onWrite = () => {}
    await expect(client.size('/a.txt')).rejects.toThrow(/timeout after 40ms/)
  })

  it('lists a directory', async () => {
    const env = createFtpEnv({
      payload: Buffer.from(
        'drwxr-xr-x 2 o g 4096 Mar 10 12:34 assets\r\n' +
        '-rw-r--r-- 1 o g  128 Mar 10 12:35 index.html\r\n',
      ),
    })
    const client = makeClient(env)
    await client.connect()
    const { entries } = await client.list('/site')
    expect(entries.map((e) => e.name)).toEqual(['assets', 'index.html'])
    expect(env.control.written).toContain('LIST /site\r\n')
    await client.close()
  })

  it('does not follow the address advertised in the PASV reply', async () => {
    // A hostile server answering with someone else's address would otherwise
    // aim our data connection wherever it liked (FTP bounce / SSRF).
    const env = createFtpEnv({ payload: Buffer.from('') })
    const client = makeClient(env)
    await client.connect()
    await client.list('/')
    const dataConnect = env.connects[1]
    expect(dataConnect.opts.host).toBe('ftp.example.com')
    expect(dataConnect.opts.host).not.toBe('10.0.0.99')
    expect(dataConnect.opts.port).toBe(1025)
    await client.close()
  })

  it('follows the PASV address only when explicitly told to', async () => {
    const env = createFtpEnv({ payload: Buffer.from('') })
    const client = makeClient(env, { trustPasvHost: true })
    await client.connect()
    await client.list('/')
    expect(env.connects[1].opts.host).toBe('10.0.0.99')
    await client.close()
  })

  it('downloads a file', async () => {
    const env = createFtpEnv({ payload: Buffer.from('hello remote world') })
    const client = makeClient(env)
    await client.connect()
    expect((await client.download('/a/b.txt')).toString()).toBe('hello remote world')
    expect(env.control.written).toContain('RETR /a/b.txt\r\n')
    await client.close()
  })

  it('normalises a traversal in a download path before sending it', async () => {
    const env = createFtpEnv({ payload: Buffer.from('x') })
    const client = makeClient(env)
    await client.connect()
    await client.download('/a/../../../etc/passwd')
    expect(env.control.written).toContain('RETR /etc/passwd\r\n')
    await client.close()
  })

  it('aborts a download that exceeds the size limit', async () => {
    const env = createFtpEnv({ payload: Buffer.alloc(4096, 0x41) })
    const client = makeClient(env)
    await client.connect()
    await expect(client.download('/big.bin', { maxBytes: 100 }))
      .rejects.toThrow(/exceeded 100 bytes/)
  })

  it('caps the download at the client-wide limit even if a larger one is asked for', async () => {
    const env = createFtpEnv({ payload: Buffer.alloc(200, 1) })
    const client = makeClient(env, { maxDownloadBytes: 50 })
    await client.connect()
    await expect(client.download('/big.bin', { maxBytes: 1e12 }))
      .rejects.toThrow(/exceeded 50 bytes/)
  })

  it('reports a failed RETR from the preliminary reply', async () => {
    const env = createFtpEnv({ overrides: { RETR: '550 No such file\r\n' } })
    const client = makeClient(env)
    await client.connect()
    await expect(client.download('/missing')).rejects.toThrow(/RETR failed: 550/)
    await client.close()
  })

  it('reads SIZE, MDTM and PWD', async () => {
    const env = createFtpEnv()
    const client = makeClient(env)
    await client.connect()
    expect(await client.size('/a.txt')).toBe(4096)
    expect((await client.modifiedAt('/a.txt')).toISOString()).toBe('2024-01-15T12:34:56.000Z')
    expect(await client.pwd()).toBe('/home/user')
    await client.cwd('/pub')
    expect(env.control.written).toContain('CWD /pub\r\n')
    await client.close()
  })

  it('refuses to send a command before connecting', async () => {
    const client = makeClient(createFtpEnv())
    await expect(client.send('NOOP')).rejects.toThrow(/not connected/)
  })

  it('sends QUIT on close and tolerates a server that hangs up first', async () => {
    const env = createFtpEnv()
    const client = makeClient(env)
    await client.connect()
    await client.close()
    expect(env.control.written).toContain('QUIT\r\n')
    await expect(client.close()).resolves.toBeUndefined()
  })
})
