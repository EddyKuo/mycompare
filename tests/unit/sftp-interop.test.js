/**
 * SFTP against a real SSH server.
 *
 * The other SFTP tests drive the client with a fake server built from the same
 * understanding of the protocol as the client itself, so they cannot catch a
 * shared misreading of the spec — a hand-written crypto handshake that agrees
 * with its own mock proves only that it is self-consistent. This one talks to
 * paramiko, which does not share our assumptions.
 *
 * paramiko is a development tool, not a project dependency. Without it these
 * tests skip rather than fail, so the suite still runs on a clean checkout:
 *
 *     python -m pip install paramiko
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

import { connectSftp } from '../../src/main/remote-sftp.js'

const SERVER = fileURLToPath(new URL('../helpers/sftp-server.py', import.meta.url))

function hasParamiko() {
  for (const exe of ['python', 'python3']) {
    const r = spawnSync(exe, ['-c', 'import paramiko'], { stdio: 'ignore' })
    if (r.status === 0) return exe
  }
  return null
}

const PYTHON = hasParamiko()
const describeInterop = PYTHON ? describe : describe.skip

describeInterop('SFTP against a real SSH server', () => {
  /** @type {import('child_process').ChildProcess} */
  let proc
  /** @type {{port: number, hostKeyFingerprint: string, user: string, password: string}} */
  let info
  let root = ''
  /** @type {(k: object) => boolean} */
  let trustAll
  let acceptedLine = ''

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mycompare-sftp-'))
    const served = join(root, 'served')
    mkdirSync(join(served, 'dir'), { recursive: true })
    writeFileSync(join(served, 'a.txt'), 'hello sftp')
    // Larger than one READ chunk, so the multi-request download loop runs.
    writeFileSync(join(served, 'dir', 'b.bin'), Buffer.alloc(70_000, 0x5a))

    proc = spawn(PYTHON, [SERVER, served, '0'])
    info = await new Promise((resolve, reject) => {
      let buf = ''
      proc.stdout.on('data', (d) => {
        buf += d
        const nl = buf.indexOf('\n')
        if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)))
      })
      proc.on('exit', (code) => reject(new Error(`server exited with ${code}`)))
      setTimeout(() => reject(new Error('server did not start in time')), 20_000)
    })
    trustAll = () => true
  }, 30_000)

  afterAll(() => {
    proc?.kill()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  /** @param {object} [extra] */
  const open = (extra = {}) => connectSftp({
    host: '127.0.0.1',
    port: info.port,
    user: info.user,
    password: info.password,
    ...extra,
  })

  it('refuses an unknown host key when nothing can approve it', async () => {
    // Failing closed is the whole point: a client that trusts any key on first
    // contact is trivially intercepted.
    await expect(open()).rejects.toThrow(/not known/i)
  })

  it('completes the handshake and reports the real server fingerprint', async () => {
    let seen = ''
    const { client, transport } = await open({
      onUnknownHostKey: (k) => { seen = k.fingerprint; return true },
      onHostKeyAccepted: (line) => { acceptedLine = line },
    })
    // The server prints the fingerprint of the key it loaded, computed
    // independently by Python.
    expect(seen).toBe(info.hostKeyFingerprint)
    await client.close()
    await transport.close()
  }, 20_000)

  it('lists a directory and resolves a path', async () => {
    const { client, transport } = await open({ onUnknownHostKey: trustAll })
    expect(await client.realpath('.')).toBe('/')
    const names = (await client.list('/')).entries.map((e) => e.name).sort()
    expect(names).toEqual(['a.txt', 'dir'])
    await client.close()
    await transport.close()
  }, 20_000)

  it('downloads a file whole, across several READ requests', async () => {
    const { client, transport } = await open({ onUnknownHostKey: trustAll })
    expect((await client.download('/a.txt')).toString()).toBe('hello sftp')

    const big = await client.download('/dir/b.bin')
    expect(big.length).toBe(70_000)
    expect(big.every((b) => b === 0x5a)).toBe(true)

    await client.close()
    await transport.close()
  }, 20_000)

  it('enforces the download ceiling against a real transfer', async () => {
    const { client, transport } = await open({ onUnknownHostKey: trustAll })
    await expect(client.download('/a.txt', { maxBytes: 4 })).rejects.toThrow()
    await client.close()
    await transport.close()
  }, 20_000)

  it('stats a file', async () => {
    const { client, transport } = await open({ onUnknownHostKey: trustAll })
    expect((await client.stat('/a.txt')).size).toBe(10)
    await client.close()
    await transport.close()
  }, 20_000)

  it('connects silently once the key is remembered', async () => {
    let prompted = false
    const { client, transport } = await open({
      knownHosts: acceptedLine,
      onUnknownHostKey: () => { prompted = true; return true },
    })
    expect(prompted).toBe(false)
    await client.close()
    await transport.close()
  }, 20_000)

  it('refuses a host key that has changed, without asking', async () => {
    const forged = acceptedLine.replace(
      / [A-Za-z0-9+/=]+$/, ` ${Buffer.alloc(51, 7).toString('base64')}`)
    let asked = false
    await expect(open({
      knownHosts: forged,
      onUnknownHostKey: () => { asked = true; return true },
    })).rejects.toThrow(/CHANGED/i)
    // A "trust anyway" path here would make known_hosts decorative.
    expect(asked).toBe(false)
  }, 20_000)

  it('rejects a wrong password', async () => {
    await expect(open({ password: 'wrong', knownHosts: acceptedLine }))
      .rejects.toThrow()
  }, 20_000)
})
