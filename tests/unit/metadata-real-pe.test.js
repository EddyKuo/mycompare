/**
 * PE version resources read from real Windows binaries.
 *
 * The metadata view and its parser were otherwise exercised against fixtures
 * this project synthesised. That proves the parser agrees with our idea of the
 * format, which is the weakest kind of agreement — the same gap that made the
 * SFTP client's 231 passing tests against its own mock server meaningless
 * until it was run against paramiko.
 *
 * The reference here is Windows itself: `FileVersionInfo.GetVersionInfo` goes
 * through the OS version API, so matching it means matching the thing every
 * other program on the machine sees.
 *
 * Two properties of that reference had to be established before it could be
 * trusted, and both were originally mistaken for parser defects:
 *
 * 1. **The version API is redirected for paths under %SystemRoot%.** The OS
 *    reports 10.0.26100.8875 for `C:\Windows\System32\notepad.exe` while the
 *    file's own resource says 10.0.26100.8737 — and the WinSxS component the
 *    file is hardlinked into is literally named
 *    `..._notepad_..._10.0.26100.8737_none_...`. A byte-identical copy of that
 *    file elsewhere reports 8737 through the same API, and for other binaries
 *    the redirected answer is *lower* than the resource (AppxApplicabilityEngine
 *    reads 26100.8115 on disk and 26100.1 from the API), so it is not an offset
 *    or a "newest wins" rule. The API's answer for a System32 path is simply not
 *    a function of that file's bytes, which makes it useless as a reference for
 *    a parser. Every comparison below is therefore made against a copy in the
 *    temp directory, where the API does read the file it was handed.
 *
 * 2. **PowerShell encodes stdout in the console codepage.** Reading that as
 *    UTF-8 turned "Microsoft® Windows® Operating System" into
 *    "MicrosoftR WindowsR Operating System" — U+00AE has no representation in
 *    the OEM codepage and the best-fit table maps it to "R". The parser was
 *    right all along; the harness corrupted the reference it was comparing
 *    against. The script below pins `[Console]::OutputEncoding` to UTF-8 and
 *    the output is decoded explicitly, and `pins the registered-trademark sign`
 *    asserts the reference still carries U+00AE so this cannot silently return.
 *
 * FileDescription is deliberately not compared. It is the one field that is
 * genuinely localised, and the two sides answer different questions: Windows
 * returns the translation matching the caller's UI language, while
 * `pickResourceLanguage` fixes on en-US so that two machines diffing the same
 * pair of files reach the same verdict. On a zh-TW install MRT.exe's
 * FileDescription is "Microsoft Windows 惡意軟體移除工具" from the OS and
 * "Microsoft Windows Malicious Software Removal Tool" from us; both are correct
 * answers to different questions. Every other field here is language-invariant
 * in practice and is compared in full.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, copyFileSync, rmSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import { execFileSync } from 'child_process'
import { readMetadata } from '../../src/main/metadata.js'

/**
 * Binaries a Windows install has, chosen to cover the layouts that broke this
 * parser rather than just "two files that have a version resource":
 *   oleaut32.dll  two StringFileInfo tables (040904B0 and 0c0904E4)
 *   MRT.exe       24 language blocks, and a 226 MB .rsrc whose version leaf
 *                 sits far past the window the tree is walked in
 * The rest are ordinary single-table, single-language binaries.
 */
const TARGETS = [
  'C:\\Windows\\System32\\kernel32.dll',
  'C:\\Windows\\System32\\notepad.exe',
  'C:\\Windows\\System32\\shell32.dll',
  'C:\\Windows\\System32\\user32.dll',
  'C:\\Windows\\System32\\ntdll.dll',
  'C:\\Windows\\System32\\cmd.exe',
  'C:\\Windows\\System32\\ole32.dll',
  'C:\\Windows\\System32\\oleaut32.dll',
  'C:\\Windows\\System32\\taskmgr.exe',
  'C:\\Windows\\explorer.exe',
  'C:\\Windows\\System32\\MRT.exe'
]

/** Fields the OS and the parser must agree on exactly. See the header for why
 *  FileDescription is not among them. */
const COMPARED = [
  'FileVersion', 'ProductVersion', 'CompanyName',
  'InternalName', 'OriginalFilename', 'ProductName', 'LegalCopyright'
]

const present = process.platform === 'win32' ? TARGETS.filter((f) => existsSync(f)) : []
// Two would let a machine missing almost everything look like a pass.
const available = present.length >= 6

/** @type {string} */
let workDir = ''
/** @type {Record<string, Record<string, string>>} copied file name -> OS fields */
let osInfo = {}
/** @type {Record<string, string>} original path -> copied path */
const copies = {}

/**
 * Copy the targets somewhere the version API is not redirected, then ask
 * Windows about the copies in one shot.
 */
beforeAll(() => {
  if (!available) return
  workDir = mkdtempSync(join(tmpdir(), 'mycompare-pe-'))

  for (const src of present) {
    // MRT.exe is ~230 MB. Copying it is worth it — it is the regression case
    // for both the resource-window bug and the language choice — but a machine
    // where it has grown beyond this is not worth the disk churn.
    if (statSync(src).size > 512 * 1024 * 1024) continue
    const dest = join(workDir, basename(src))
    copyFileSync(src, dest)
    copies[src] = dest
  }

  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    `$out = foreach ($f in Get-ChildItem -LiteralPath '${workDir}') {`,
    '  $v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($f.FullName)',
    '  New-Object psobject -Property @{',
    '    File=$f.Name; FileVersion=$v.FileVersion; ProductVersion=$v.ProductVersion;',
    '    CompanyName=$v.CompanyName; InternalName=$v.InternalName;',
    '    OriginalFilename=$v.OriginalFilename; ProductName=$v.ProductName;',
    '    LegalCopyright=$v.LegalCopyright; FileDescription=$v.FileDescription }',
    '}',
    'ConvertTo-Json -InputObject @($out) -Compress'
  ].join('\n')

  const scriptPath = join(workDir, 'osinfo.ps1')
  writeFileSync(scriptPath, script, 'utf-8')

  // Captured as bytes and decoded here: letting the child's stdout be decoded
  // by anything else is what mangled U+00AE.
  const out = execFileSync(
    'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }
  )
  const parsed = JSON.parse(out.toString('utf-8').replace(/^\uFEFF/, ''))
  osInfo = Object.fromEntries(parsed.map((e) => [e.File, e]))
}, 120000)

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/**
 * @param {string} src original path
 * @returns {{ copy: string, os: Record<string, string> }|null}
 */
function reference(src) {
  const copy = copies[src]
  if (!copy) return null
  const os = osInfo[basename(copy)]
  return os ? { copy, os } : null
}

describe('PE version resources, against the Windows API', () => {
  it('has the binaries to test, or says it does not', () => {
    if (!available) {
      console.warn('not Windows, or too few of the system binaries are present; tests skipped')
    }
    expect(true).toBe(true)
  })

  for (const file of TARGETS) {
    const name = basename(file)

    it(`reads ${name} the same way Windows does`, async () => {
      if (!available) return
      const ref = reference(file)
      if (!ref) return   // absent on this install, or too large to copy

      const ours = await readMetadata(ref.copy)
      const fields = ours?.fields
      expect(fields, 'nothing was parsed').toBeTruthy()

      // Guard the premise: an OS lookup that returned nothing would make every
      // comparison below vacuously true.
      expect(String(ref.os.FileVersion ?? '').length, 'the OS returned no version')
        .toBeGreaterThan(0)

      for (const field of COMPARED) {
        expect(fields[field] ?? '', `${name} ${field}`).toBe(ref.os[field] ?? '')
      }
    }, 60000)
  }

  it('pins the registered-trademark sign in a string-table value', async () => {
    if (!available) return
    const ref = reference('C:\\Windows\\System32\\kernel32.dll')
    if (!ref) return

    // If the reference itself has lost U+00AE the harness is decoding the OS's
    // answer wrongly, and comparing against it proves nothing — so fail here
    // rather than let the comparison below pass on two identically broken
    // strings.
    expect(ref.os.ProductName, 'the OS reference lost its non-ASCII characters')
      .toContain('\u00AE')

    const ours = await readMetadata(ref.copy)
    expect(ours.fields.ProductName).toBe(ref.os.ProductName)
    expect(ours.fields.ProductName).toContain('\u00AE')
    expect(ours.fields.LegalCopyright).toContain('\u00A9')
    // The characters must survive as single code points, not as a replacement
    // character or a best-fit ASCII substitution.
    expect([...ours.fields.ProductName].filter((c) => c === '\u00AE').length).toBe(2)
    expect(ours.fields.ProductName).not.toMatch(/\uFFFD/)
  }, 60000)

  it('reads a binary whose version resource is far past the start of .rsrc', async () => {
    if (!available) return
    const ref = reference('C:\\Windows\\System32\\MRT.exe')
    if (!ref) return

    // MRT.exe carries ~226 MB of .rsrc. Its VS_VERSIONINFO leaf lives near the
    // end of that section, so reading a bounded prefix of .rsrc and slicing the
    // leaf out of it produced an empty result — "this file has no version
    // information" — for every binary with a large resource section.
    const ours = await readMetadata(ref.copy)
    expect(Object.keys(ours.fields).length, 'the version resource was not found')
      .toBeGreaterThan(4)
    expect(ours.fields.FileVersion).toBe(ref.os.FileVersion)
  }, 60000)

  it('picks one deliberate translation when a binary carries many', async () => {
    if (!available) return
    const ref = reference('C:\\Windows\\System32\\MRT.exe')
    if (!ref) return

    // MRT.exe files its version resource under 24 languages, Arabic (0x0401)
    // first. Taking the tree's first entry meant taking whichever language the
    // build happened to emit first; the fields below would have come back in
    // Arabic. The choice is fixed at en-US so the answer does not depend on the
    // machine's UI language.
    const ours = await readMetadata(ref.copy)
    expect(ours.fields.ProductName).toBe('Microsoft Windows Malicious Software Removal Tool')
    expect(ours.fields.FileDescription, 'not the en-US translation')
      .toBe('Microsoft Windows Malicious Software Removal Tool')
  }, 60000)

  it('merges nothing from a second string table over the first', async () => {
    if (!available) return
    const ref = reference('C:\\Windows\\System32\\oleaut32.dll')
    if (!ref) return

    // oleaut32.dll ships two StringTables, 040904B0 and 0c0904E4. The en-US one
    // is authoritative; the other may only fill a key the first does not have.
    const ours = await readMetadata(ref.copy)
    for (const field of COMPARED) {
      expect(ours.fields[field] ?? '', `oleaut32 ${field}`).toBe(ref.os[field] ?? '')
    }
    // The 04E4 half of the second key names codepage 1252, but its values are
    // stored as UTF-16 like every other VS_VERSIONINFO string. Decoding them as
    // 1252 would show two characters where there is one.
    expect(ours.fields.LegalCopyright).toContain('\u00A9')
  }, 60000)

  it('reports the fixed version block, which the string table can contradict', async () => {
    if (!available) return
    const ref = reference('C:\\Windows\\System32\\kernel32.dll')
    if (!ref) return
    // VS_FIXEDFILEINFO is the binary field the loader uses; the string table is
    // free text a build can set to anything. Reading only the strings would
    // miss a file whose two disagree.
    const ours = await readMetadata(ref.copy)
    expect(String(ours.fields.FixedFileVersion ?? '')).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    expect(ours.fields.FileVersion).toContain(ours.fields.FixedFileVersion)
  }, 60000)

  it('does not invent fields for a binary with no version resource', async () => {
    if (!available) return
    // A PE without a resource section must come back empty rather than with
    // blank-but-present fields, which the view would render as "both sides
    // have this field and it is the same".
    const ours = await readMetadata('C:\\Windows\\System32\\drivers\\etc\\hosts')
    const fields = ours?.fields ?? null
    const values = fields ? Object.values(fields).filter((v) => String(v ?? '') !== '') : []
    expect(values).toEqual([])
  }, 30000)
})
