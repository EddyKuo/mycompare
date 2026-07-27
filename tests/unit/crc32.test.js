/**
 * @vitest-environment jsdom
 *
 * CRC-32, and the folder column that shows it.
 *
 * The folder view's checksum column was backed by `hash-file`, which is MD5.
 * That is a fine integrity check and it is not what CRC means anywhere else —
 * a user comparing the value against what `unzip -v` or `7z l` prints would
 * find it never matches and have no way to see why.
 *
 * The vectors below are the published CRC-32 values for these inputs, not
 * output recorded from this implementation. A checksum that only agrees with
 * itself proves nothing, which is the same standard the archive decoders in
 * this project are held to.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computeCrc32, computeMd5 } from '../../src/main/file-hash.js'
import { FolderCompare } from '../../src/renderer/src/views/folder-compare.js'

describe('computeCrc32', () => {
  it.each([
    ['', '00000000'],
    ['a', 'E8B7BE43'],
    ['abc', '352441C2'],
    ['message digest', '20159D7F'],
    ['abcdefghijklmnopqrstuvwxyz', '4C2750BD'],
    ['123456789', 'CBF43926'],
  ])('matches the published value for %j', (input, expected) => {
    expect(computeCrc32(Buffer.from(input, 'utf-8'))).toBe(expected)
  })

  it('is always eight hex digits, zero-padded', () => {
    // The accumulator is signed; without the unsigned shift a CRC with the top
    // bit set renders as a negative number, and a small one loses its padding.
    for (let i = 0; i < 200; i++) {
      const out = computeCrc32(Buffer.from([i, i * 7 & 0xff, i * 13 & 0xff]))
      expect(out).toMatch(/^[0-9A-F]{8}$/)
    }
  })

  it('sets the high bit for an input that produces one', () => {
    // 'a' is 0xE8B7BE43 — proof the unsigned conversion is exercised at all.
    expect(computeCrc32(Buffer.from('a'))).toBe('E8B7BE43')
  })

  it('handles bytes above 0x7F', () => {
    expect(computeCrc32(Buffer.from([0xff, 0xfe, 0x80]))).toMatch(/^[0-9A-F]{8}$/)
  })

  it('is not MD5 under another name', () => {
    const buf = Buffer.from('abc')
    expect(computeCrc32(buf)).not.toBe(computeMd5(buf))
    expect(computeCrc32(buf)).toHaveLength(8)
    expect(computeMd5(buf)).toHaveLength(32)
  })
})

describe('the folder view chooses which checksum it shows', () => {
  /** @type {HTMLElement} */
  let host
  /** @type {FolderCompare} */
  let view

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    globalThis.window.electronAPI = {
      hashFile: vi.fn(async () => 'd41d8cd98f00b204e9800998ecf8427e'),
      crc32File: vi.fn(async () => 'CBF43926'),
    }
    view = new FolderCompare()
    view.mount(host)
  })

  afterEach(() => {
    view?.destroy?.()
    host.remove()
    vi.restoreAllMocks()
    delete globalThis.window.electronAPI
  })

  it('defaults to CRC-32, which is what BC’s column is', () => {
    expect(view.getChecksumAlgorithm()).toBe('crc32')
  })

  it('offers both algorithms, each under its own name', () => {
    expect(FolderCompare.checksumAlgorithms.map((a) => a.id)).toEqual(['crc32', 'md5'])
    expect(FolderCompare.checksumAlgorithms.map((a) => a.label)).toEqual(['CRC-32', 'MD5'])
  })

  it('calls the CRC IPC, not the MD5 one, when set to CRC-32', async () => {
    const { text, title } = await view._checksumFor('/tmp/x')
    expect(window.electronAPI.crc32File).toHaveBeenCalledWith('/tmp/x')
    expect(window.electronAPI.hashFile).not.toHaveBeenCalled()
    expect(text).toBe('CBF43926')
    expect(title).toContain('CRC-32')
  })

  it('calls the MD5 IPC when switched to MD5', async () => {
    view.setChecksumAlgorithm('md5')
    const { text, title } = await view._checksumFor('/tmp/x')
    expect(window.electronAPI.hashFile).toHaveBeenCalledWith('/tmp/x')
    expect(window.electronAPI.crc32File).not.toHaveBeenCalled()
    expect(text).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(title).toContain('MD5')
  })

  it('names the algorithm in the title, so a mismatch is explainable', async () => {
    expect((await view._checksumFor('/tmp/x')).title).toBe('CRC-32：CBF43926')
    view.setChecksumAlgorithm('md5')
    expect((await view._checksumFor('/tmp/x')).title)
      .toBe('MD5：d41d8cd98f00b204e9800998ecf8427e')
  })

  it('reports a failure by algorithm name rather than swallowing it', async () => {
    window.electronAPI.crc32File = vi.fn(async () => { throw new Error('EACCES') })
    const { text, title } = await view._checksumFor('/tmp/x')
    expect(text).toBe('—')
    expect(title).toContain('CRC-32')
    expect(title).toContain('EACCES')
  })

  it('says so when the selected algorithm has no IPC behind it', async () => {
    delete window.electronAPI.crc32File
    const { text, title } = await view._checksumFor('/tmp/x')
    expect(text).toBe('')
    expect(title).toContain('CRC-32')
  })

  it('discards cached values on switch rather than mixing the two', () => {
    view._crcCache.set('/tmp/x', 'CBF43926')
    view._crcTitles.set('/tmp/x', 'CRC-32：CBF43926')
    view.setChecksumAlgorithm('md5')
    // A cache kept across the switch would leave the column showing CRC values
    // and MD5 values under one heading.
    expect(view._crcCache.size).toBe(0)
    expect(view._crcTitles.size).toBe(0)
  })

  it('ignores an unknown algorithm instead of blanking the column', () => {
    expect(view.setChecksumAlgorithm('sha256')).toBe('crc32')
    expect(view.getChecksumAlgorithm()).toBe('crc32')
  })

  it('switching to the algorithm already in force is a no-op', () => {
    view._crcCache.set('/tmp/x', 'CBF43926')
    view.setChecksumAlgorithm('crc32')
    expect(view._crcCache.size).toBe(1)
  })
})
