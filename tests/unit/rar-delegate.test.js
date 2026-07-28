/**
 * Delegating RAR decompression to an already-installed archiver.
 *
 * RAR's compression has no public specification; the only description of it is
 * UnRAR's source, whose licence forbids using that source to build
 * RAR-compatible software. Writing a decompressor from it is a legal decision,
 * not an engineering one.
 *
 * 7-Zip is preferred over UnRAR purely on install base. It reads both RAR
 * generations, and someone who has any archiver at all usually has that one —
 * preferring UnRAR would have meant asking most users to install a second tool
 * for something the one they already have can do. Both produce identical bytes.
 *
 * The property that matters is not "compressed RAR works" but that the app is
 * honest in both directions: it uses a tool when one is there, and says plainly
 * what it cannot do when none is. The second half is what would rot silently,
 * because the machine that develops this has both.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import {
  findRarTool, canExtractCompressed, buildArgs, _resetRarToolProbe,
} from '../../src/main/rar-delegate.js'

beforeEach(() => { _resetRarToolProbe() })

describe('choosing the tool', () => {
  it('prefers 7-Zip over UnRAR when both exist', () => {
    // The whole reason this module changed shape: most people have 7-Zip and
    // not WinRAR, and 7-Zip reads RAR perfectly well.
    const picked = findRarTool([
      { path: process.execPath, kind: '7zip' },
      { path: process.execPath, kind: 'unrar' },
    ])
    expect(picked?.kind).toBe('7zip')
  })

  it('falls back to UnRAR when 7-Zip is absent', () => {
    const picked = findRarTool([
      { path: 'C:\\nope\\7z.exe', kind: '7zip' },
      { path: process.execPath, kind: 'unrar' },
    ])
    expect(picked?.kind).toBe('unrar')
    expect(picked?.exe).toBe(process.execPath)
  })

  it('returns null when neither is installed', () => {
    expect(findRarTool([
      { path: 'C:\\nope\\7z.exe', kind: '7zip' },
      { path: 'C:\\nope\\unrar.exe', kind: 'unrar' },
    ])).toBeNull()
  })

  it('does not take a bare name on faith', () => {
    // Assuming it worked meant canExtractCompressed() was always true, and a
    // machine with no archiver got "spawn 7z ENOENT" instead of the plain
    // explanation that the method needs a decoder this build lacks.
    expect(findRarTool([
      { path: 'definitely-not-a-real-command-xyzzy', kind: '7zip' },
    ])).toBeNull()
  })

  it('accepts a bare name that does resolve', () => {
    // `node` is on PATH by definition here, since this runs under it.
    expect(findRarTool([{ path: 'node', kind: '7zip' }])?.exe).toBe('node')
  })

  it('agrees with canExtractCompressed', () => {
    expect(canExtractCompressed()).toBe(findRarTool() !== null)
  })
})

describe('the argv for each tool', () => {
  const archive = 'C:\\tmp\\a.rar'
  const entry = 'sub/file.bin'

  it('asks 7-Zip to write the entry to stdout', () => {
    const args = buildArgs({ exe: '7z', kind: '7zip' }, archive, entry)
    expect(args).toContain('x')
    expect(args).toContain('-so')
    expect(args.at(-2)).toBe(archive)
    expect(args.at(-1)).toBe(entry)
  })

  it('asks UnRAR to print the entry', () => {
    const args = buildArgs({ exe: 'unrar', kind: 'unrar' }, archive, entry)
    expect(args).toContain('p')
    expect(args).toContain('-inul')
    expect(args.at(-2)).toBe(archive)
    expect(args.at(-1)).toBe(entry)
  })

  it('separates switches from operands with -- for both', () => {
    // Without it an entry named "-x" would be read as a switch.
    for (const kind of ['7zip', 'unrar']) {
      const args = buildArgs({ exe: 'x', kind }, archive, entry)
      expect(args[args.length - 3], kind).toBe('--')
    }
  })

  it('never sits at a password prompt', () => {
    // A non-interactive run must fail rather than block forever.
    expect(buildArgs({ exe: 'x', kind: '7zip' }, archive, entry)).toContain('-p')
    expect(buildArgs({ exe: 'x', kind: 'unrar' }, archive, entry)).toContain('-p-')
  })
})

describe('no shell is ever involved', () => {
  const src = readFileSync(new URL('../../src/main/rar-delegate.js', import.meta.url), 'utf-8')

  it('uses execFile with an argument array', () => {
    // Entry names come from the archive, which is attacker-controlled data.
    expect(src).toMatch(/execFile\(/)
    expect(src).not.toMatch(/\bexec\(/)
    expect(src).not.toMatch(/shell:\s*true/)
  })

  it('caps the output rather than measuring it afterwards', () => {
    expect(src).toMatch(/maxBuffer:\s*Math\.max\(1,\s*maxBytes\)/)
  })
})
