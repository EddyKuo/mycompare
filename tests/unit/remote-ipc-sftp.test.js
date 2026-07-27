/**
 * The SFTP branch of the remote IPC surface.
 *
 * SFTP differs from FTP and S3 in three ways the dispatch has to get right: a
 * host key needs an approval decision before any credential is sent, an
 * accepted key has to be written back to the profile or the user is asked
 * again every connection, and the client sits on a channel inside an SSH
 * connection, so closing it alone leaves the socket up.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { registerRemoteIpc } from '../../src/main/remote-ipc.js'

/** Minimal in-memory fs/promises stand-in. */
function memfs() {
  /** @type {Map<string, string>} */
  const files = new Map()
  return {
    files,
    async readFile(p) {
      if (!files.has(p)) {
        const err = new Error('ENOENT')
        // @ts-expect-error test double
        err.code = 'ENOENT'
        throw err
      }
      return files.get(p)
    },
    async writeFile(p, data) { files.set(p, String(data)) },
    async mkdir() {},
    async rename(a, b) { files.set(b, files.get(a)); files.delete(a) },
    async unlink(p) { files.delete(p) },
  }
}

function harness(extra = {}) {
  /** @type {Map<string, Function>} */
  const handlers = new Map()
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
  }
  const api = registerRemoteIpc({
    ipcMain,
    userDataPath: () => '/data',
    fs: memfs(),
    crypto: { isEncryptionAvailable: () => false },
    ...extra,
  })
  return {
    api,
    /** @param {string} ch @param {object} [arg] */
    call: (ch, arg) => handlers.get(ch)(null, arg),
  }
}

describe('remote IPC — SFTP', () => {
  /** @type {object[]} */
  let calls
  /** @type {object} */
  let fakeClient
  let transportClosed
  let channelClosed

  /** @type {Function} */
  let connectSftp

  beforeEach(() => {
    calls = []
    transportClosed = false
    channelClosed = false
    fakeClient = {
      list: async (dir) => ({
        path: dir,
        entries: [{ name: 'a.txt', size: 3, isDirectory: false, mtime: null }],
        unsafe: [],
      }),
      download: async () => Buffer.from('abc'),
      close: async () => { channelClosed = true },
    }
    connectSftp = async (opts) => {
      calls.push(opts)
      await opts.onHostKeyAccepted?.('[host]:22 ssh-ed25519 AAAA')
      return {
        client: fakeClient,
        transport: { close: async () => { transportClosed = true } },
      }
    }
  })

  /** @param {ReturnType<typeof harness>} h */
  async function saveProfile(h) {
    const saved = await h.call('remote-save-profile', {
      name: 'box', kind: 'sftp', host: 'example.test', port: 22, user: 'me',
    })
    return saved.profile.id
  }

  it('routes an sftp profile to the SSH client, not the FTP one', async () => {
    let ftpUsed = false
    const h = harness({
      connectSftp,
      FtpClientCtor: function () { ftpUsed = true },
    })
    const id = await saveProfile(h)
    const rows = await h.call('remote-list-dir', { profileId: id, secret: 'pw' })

    expect(ftpUsed).toBe(false)
    expect(calls[0]).toMatchObject({ host: 'example.test', port: 22, user: 'me', password: 'pw' })
    expect(rows.map((r) => r.name)).toEqual(['a.txt'])
  })

  it('unwraps the listing shape, which differs from FTP', async () => {
    // FTP returns a bare array and SFTP returns { path, entries, unsafe };
    // mapping the wrapper directly yields a listing of undefined names.
    const h = harness({ connectSftp })
    const id = await saveProfile(h)
    const rows = await h.call('remote-list-dir', { profileId: id, secret: 'pw' })
    expect(rows.every((r) => typeof r.name === 'string' && r.name)).toBe(true)
  })

  it('passes the host-key decision through and never invents one', async () => {
    const decide = () => true
    const h = harness({ connectSftp, onUnknownHostKey: decide })
    const id = await saveProfile(h)
    await h.call('remote-list-dir', { profileId: id, secret: 'pw' })
    expect(calls[0].onUnknownHostKey).toBe(decide)
  })

  it('leaves the decision undefined when the host provides none, so it fails closed', async () => {
    const h = harness({ connectSftp })
    const id = await saveProfile(h)
    await h.call('remote-list-dir', { profileId: id, secret: 'pw' })
    expect(calls[0].onUnknownHostKey).toBeUndefined()
  })

  it('remembers an accepted host key on the profile', async () => {
    const h = harness({ connectSftp, onUnknownHostKey: () => true })
    const id = await saveProfile(h)
    await h.call('remote-list-dir', { profileId: id, secret: 'pw' })
    await h.call('remote-disconnect', id)

    const stored = (await h.call('remote-list-profiles')).find((p) => p.id === id)
    expect(stored.knownHosts).toBe('[host]:22 ssh-ed25519 AAAA')

    // The second connection must supply it, or the user is asked every time.
    await h.call('remote-list-dir', { profileId: id, secret: 'pw' })
    expect(calls[1].knownHosts).toBe('[host]:22 ssh-ed25519 AAAA')
  })

  it('closes the SSH connection, not just the sftp channel', async () => {
    const h = harness({ connectSftp })
    const id = await saveProfile(h)
    await h.call('remote-list-dir', { profileId: id, secret: 'pw' })
    await h.call('remote-disconnect', id)

    expect(channelClosed).toBe(true)
    expect(transportClosed).toBe(true)
  })
})
