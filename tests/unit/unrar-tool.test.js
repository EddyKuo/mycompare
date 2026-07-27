/**
 * Delegating RAR decompression to an installed UnRAR.
 *
 * RAR's compression has no public specification; the only description of it is
 * UnRAR's source, whose licence forbids using that source to build
 * RAR-compatible software. Writing a decompressor from it is not a decision to
 * take on someone else's behalf. Running the binary RARLAB publishes for
 * extraction carries no such restriction.
 *
 * So the property that matters is not "compressed RAR works" — it is that the
 * app is honest in both directions: it uses the tool when it is there, and it
 * says plainly what it cannot do when it is not. The second half is the one
 * that would rot silently, because the machine that develops this has the tool.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { findUnrar, canExtractCompressed, _resetUnrarProbe } from '../../src/main/unrar-tool.js'

beforeEach(() => { _resetUnrarProbe() })

describe('finding the tool', () => {
  it('takes the first candidate that exists on disk', () => {
    // process.execPath is guaranteed to be a real file on any machine.
    expect(findUnrar(['C:\\nope\\missing.exe', process.execPath])).toBe(process.execPath)
  })

  it('returns null when no candidate exists', () => {
    expect(findUnrar(['C:\\nope\\a.exe', 'D:\\also\\nope.exe'])).toBeNull()
  })

  it('does not take a bare name on faith', () => {
    // The bug this replaced: a bare name was accepted without checking, so
    // canExtractCompressed() was always true and a machine with no UnRAR got
    // "spawn unrar ENOENT" instead of the plain explanation that the method
    // needs a decoder this build does not have.
    expect(findUnrar(['definitely-not-a-real-command-xyzzy'])).toBeNull()
  })

  it('accepts a bare name that does resolve', () => {
    // `node` is on PATH by definition here, since this runs under it.
    expect(findUnrar(['node'])).toBe('node')
  })

  it('agrees with canExtractCompressed', () => {
    expect(canExtractCompressed()).toBe(findUnrar() !== null)
  })
})

describe('the arguments handed to the tool', () => {
  // Read as source rather than executed: the point is which switches are
  // passed, and running UnRAR to find out would only work where it exists.
  const src = readSource()

  it('never builds a shell string', () => {
    // Entry names come from the archive, which is attacker-controlled data.
    expect(src).toMatch(/execFile\(/)
    expect(src).not.toMatch(/\bexec\(/)
    expect(src).not.toMatch(/shell:\s*true/)
  })

  it('separates switches from operands with --', () => {
    // Without it, an entry named "-x" would be read as a switch.
    expect(src).toMatch(/'--',\s*archivePath,\s*entryPath/)
  })

  it('refuses to sit at a password prompt', () => {
    // A non-interactive run must fail rather than block forever. -p- supplies
    // "no password" instead of leaving UnRAR waiting on stdin.
    expect(src).toContain("'-p-'")
    expect(src).toMatch(/timeout/)
  })

  it('caps the output rather than measuring it afterwards', () => {
    // maxBuffer is a ceiling; checking the length after a full decode is a
    // report, not a limit.
    expect(src).toMatch(/maxBuffer:\s*Math\.max\(1,\s*maxBytes\)/)
  })

  it('silences the banner so stdout is the file and nothing else', () => {
    expect(src).toContain("'-inul'")
  })
})

/** @returns {string} */
function readSource() {
  return readFileSync(new URL('../../src/main/unrar-tool.js', import.meta.url), 'utf-8')
}
