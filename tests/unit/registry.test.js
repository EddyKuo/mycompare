/**
 * Windows registry export parsing and comparison.
 *
 * Fixtures are .reg text assembled here, so the tests run on any platform —
 * there is no registry to read on the machines this suite runs on.
 */
import { describe, it, expect } from 'vitest'
import {
  decodeRegBuffer,
  joinContinuations,
  parseRegValue,
  parseRegFile,
  flattenRegistry,
  diffRegistry,
  validateRegistryPath,
  REGISTRY_ROOTS,
} from '../../src/main/registry.js'

const HEADER = 'Windows Registry Editor Version 5.00'

describe('decodeRegBuffer', () => {
  it('reads UTF-16LE with a BOM, which is what reg export writes', () => {
    const text = `${HEADER}\r\n`
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(text, 'utf16le'),
    ])
    expect(decodeRegBuffer(buf)).toContain('Windows Registry Editor')
  })

  it('reads UTF-8 with a BOM', () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('REGEDIT4\r\n', 'utf-8'),
    ])
    expect(decodeRegBuffer(buf).trim()).toBe('REGEDIT4')
  })

  it('falls back to UTF-8 with no BOM', () => {
    expect(decodeRegBuffer(Buffer.from('REGEDIT4', 'utf-8'))).toBe('REGEDIT4')
  })

  it('handles an empty buffer', () => {
    expect(decodeRegBuffer(Buffer.alloc(0))).toBe('')
  })
})

describe('joinContinuations', () => {
  it('joins a wrapped binary value', () => {
    // Long values wrap with a trailing backslash; treating the continuation as
    // its own line would corrupt every such value.
    const text = [
      '"Data"=hex:01,02,03,\\',
      '  04,05,06',
    ].join('\r\n')
    expect(joinContinuations(text)).toEqual(['"Data"=hex:01,02,03,04,05,06'])
  })

  it('joins across several continuations', () => {
    const text = ['"a"=hex:01,\\', '  02,\\', '  03'].join('\n')
    expect(joinContinuations(text)).toEqual(['"a"=hex:01,02,03'])
  })

  it('leaves ordinary lines alone', () => {
    expect(joinContinuations('a\nb')).toEqual(['a', 'b'])
  })

  it('emits a dangling continuation rather than dropping it', () => {
    expect(joinContinuations('"a"=hex:01,\\')).toEqual(['"a"=hex:01,'])
  })
})

describe('parseRegValue', () => {
  it('reads a quoted string and its escapes', () => {
    expect(parseRegValue('"C:\\\\Program Files\\\\App"'))
      .toEqual({ type: 'REG_SZ', value: 'C:\\Program Files\\App' })
    expect(parseRegValue('"say \\"hi\\""'))
      .toEqual({ type: 'REG_SZ', value: 'say "hi"' })
  })

  it('reads a dword in both hex and decimal form', () => {
    const v = parseRegValue('dword:0000002a')
    expect(v.type).toBe('REG_DWORD')
    expect(v.value).toContain('42')
  })

  it('reads plain binary', () => {
    expect(parseRegValue('hex:01,ff,0a'))
      .toEqual({ type: 'REG_BINARY', value: '01 FF 0A' })
  })

  it('decodes hex(2) expand strings back to text', () => {
    // Text types are stored as UTF-16LE bytes; a hex dump would make the diff
    // unreadable for exactly the values people look at.
    const bytes = [...Buffer.from('%PATH%\0', 'utf16le')]
      .map((b) => b.toString(16).padStart(2, '0')).join(',')
    const v = parseRegValue(`hex(2):${bytes}`)
    expect(v.type).toBe('REG_EXPAND_SZ')
    expect(v.value).toBe('%PATH%')
  })

  it('decodes hex(7) multi-strings into a readable list', () => {
    const bytes = [...Buffer.from('one\0two\0\0', 'utf16le')]
      .map((b) => b.toString(16).padStart(2, '0')).join(',')
    const v = parseRegValue(`hex(7):${bytes}`)
    expect(v.type).toBe('REG_MULTI_SZ')
    expect(v.value).toBe('one | two')
  })

  it('reads a qword', () => {
    expect(parseRegValue('hex(b):01,00,00,00,00,00,00,00').type).toBe('REG_QWORD')
  })

  it('marks a deletion marker', () => {
    expect(parseRegValue('-').type).toBe('DELETED')
  })

  it('labels anything it does not recognise rather than guessing', () => {
    expect(parseRegValue('mystery').type).toBe('UNKNOWN')
  })
})

describe('parseRegFile', () => {
  const sample = [
    HEADER,
    '',
    '[HKEY_CURRENT_USER\\Software\\Demo]',
    '@="default value"',
    '"Name"="Alice"',
    '"Count"=dword:00000005',
    '"Blob"=hex:de,ad,\\',
    '  be,ef',
    '',
    '[HKEY_CURRENT_USER\\Software\\Demo\\Sub]',
    '"Only"="here"',
  ].join('\r\n')

  it('records the format', () => {
    expect(parseRegFile(sample).format).toBe('reg5')
    expect(parseRegFile('REGEDIT4\r\n').format).toBe('regedit4')
  })

  it('parses keys and their values', () => {
    const { keys } = parseRegFile(sample)
    expect(keys.map((k) => k.path)).toEqual([
      'HKEY_CURRENT_USER\\Software\\Demo',
      'HKEY_CURRENT_USER\\Software\\Demo\\Sub',
    ])
    const demo = keys[0]
    expect(demo.values.find((v) => v.name === '').value).toBe('default value')
    expect(demo.values.find((v) => v.name === 'Name').value).toBe('Alice')
    expect(demo.values.find((v) => v.name === 'Blob').value).toBe('DE AD BE EF')
  })

  it('marks a key scheduled for deletion', () => {
    const { keys } = parseRegFile(`${HEADER}\r\n[-HKEY_CURRENT_USER\\Gone]`)
    expect(keys[0].deleted).toBe(true)
    expect(keys[0].path).toBe('HKEY_CURRENT_USER\\Gone')
  })

  it('handles a value name containing an equals sign', () => {
    // The first '=' is not always the separator.
    const { keys } = parseRegFile(`${HEADER}\r\n[HKCU\\X]\r\n"a=b"="v"`)
    expect(keys[0].values[0]).toMatchObject({ name: 'a=b', value: 'v' })
  })

  it('ignores comments and blank lines', () => {
    const { keys } = parseRegFile(`${HEADER}\r\n; a comment\r\n\r\n[HKCU\\X]\r\n"a"="b"`)
    expect(keys).toHaveLength(1)
    expect(keys[0].values).toHaveLength(1)
  })

  it('ignores values that appear before any key', () => {
    expect(parseRegFile(`${HEADER}\r\n"orphan"="x"`).keys).toEqual([])
  })

  it('tolerates empty and malformed input', () => {
    expect(parseRegFile('')).toEqual({ format: 'unknown', keys: [] })
    expect(parseRegFile(undefined)).toEqual({ format: 'unknown', keys: [] })
    expect(() => parseRegFile('[unclosed')).not.toThrow()
  })
})

describe('flattenRegistry', () => {
  it('produces one row per value, sorted', () => {
    const parsed = parseRegFile([
      HEADER,
      '[HKCU\\B]', '"z"="1"', '"a"="2"',
      '[HKCU\\A]', '"x"="3"',
    ].join('\r\n'))
    const rows = flattenRegistry(parsed)
    expect(rows.map((r) => `${r.path}\\${r.name}`)).toEqual([
      'HKCU\\A\\x', 'HKCU\\B\\a', 'HKCU\\B\\z',
    ])
  })

  it('keeps a key with no values as a row of its own', () => {
    const rows = flattenRegistry(parseRegFile(`${HEADER}\r\n[HKCU\\Empty]`))
    expect(rows).toEqual([{ path: 'HKCU\\Empty', name: '', type: 'KEY', value: '' }])
  })

  it('tolerates missing input', () => {
    expect(flattenRegistry(undefined)).toEqual([])
  })
})

describe('diffRegistry', () => {
  const left = flattenRegistry(parseRegFile([
    HEADER,
    '[HKCU\\X]', '"same"="1"', '"changed"="old"', '"leftOnly"="l"',
  ].join('\r\n')))
  const right = flattenRegistry(parseRegFile([
    HEADER,
    '[HKCU\\X]', '"same"="1"', '"changed"="new"', '"rightOnly"="r"',
  ].join('\r\n')))

  it('classifies every value', () => {
    const byName = Object.fromEntries(
      diffRegistry(left, right).map((r) => [r.name, r.status]))
    expect(byName).toEqual({
      same: 'same',
      changed: 'different',
      leftOnly: 'left-only',
      rightOnly: 'right-only',
    })
  })

  it('treats a type change as a difference even when the text matches', () => {
    const l = [{ path: 'K', name: 'v', type: 'REG_SZ', value: '1' }]
    const r = [{ path: 'K', name: 'v', type: 'REG_DWORD', value: '1' }]
    expect(diffRegistry(l, r)[0].status).toBe('different')
  })

  it('matches keys case-insensitively, as Windows does', () => {
    const l = [{ path: 'HKCU\\X', name: 'Name', type: 'REG_SZ', value: '1' }]
    const r = [{ path: 'hkcu\\x', name: 'name', type: 'REG_SZ', value: '1' }]
    expect(diffRegistry(l, r)).toHaveLength(1)
    expect(diffRegistry(l, r)[0].status).toBe('same')
  })

  it('carries both sides so a viewer can show them', () => {
    const row = diffRegistry(left, right).find((r) => r.name === 'changed')
    expect(row.left.value).toBe('old')
    expect(row.right.value).toBe('new')
  })

  it('tolerates missing input', () => {
    expect(diffRegistry(undefined, undefined)).toEqual([])
    expect(diffRegistry(left, undefined).every((r) => r.status === 'left-only')).toBe(true)
  })
})

describe('validateRegistryPath', () => {
  it('accepts long and short root names', () => {
    expect(validateRegistryPath('HKEY_CURRENT_USER\\Software')).toBeTruthy()
    expect(validateRegistryPath('HKLM\\SOFTWARE')).toBeTruthy()
    for (const short of Object.values(REGISTRY_ROOTS)) {
      expect(() => validateRegistryPath(`${short}\\X`)).not.toThrow()
    }
  })

  it('rejects an unknown root', () => {
    expect(() => validateRegistryPath('HKEY_MADE_UP\\X')).toThrow(/未知的登錄機碼根/)
  })

  it('rejects characters that could carry shell or argument syntax', () => {
    // The path reaches a child process; execFile avoids a shell, but a
    // switch-looking argument would still be read as one.
    for (const bad of ['HKCU\\a"b', 'HKCU\\a|b', 'HKCU\\a&b', 'HKCU\\a\nb', 'HKCU\\a>b']) {
      expect(() => validateRegistryPath(bad), bad).toThrow()
    }
    expect(() => validateRegistryPath('/export')).toThrow()
    expect(() => validateRegistryPath('-y')).toThrow()
  })

  it('rejects empty and oversized paths', () => {
    expect(() => validateRegistryPath('')).toThrow()
    expect(() => validateRegistryPath('   ')).toThrow()
    expect(() => validateRegistryPath(`HKCU\\${'a'.repeat(600)}`)).toThrow(/過長/)
  })
})
