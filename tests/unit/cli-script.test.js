/**
 * Command line parsing and script grammar.
 */
import { describe, it, expect } from 'vitest'
import { parseCli, parseCliArgs, usageText } from '../../src/main/cli.js'
import {
  tokenize,
  parseScript,
  isMutating,
  describeScript,
  MUTATING_COMMANDS,
} from '../../src/main/script.js'

const argv = (...args) => ['node', 'app', ...args]

describe('parseCli', () => {
  it('collects positional paths', () => {
    const { paths } = parseCli(argv('C:\\a.txt', 'C:\\b.txt'))
    expect(paths).toEqual(['C:\\a.txt', 'C:\\b.txt'])
  })

  it('accepts up to four paths, for merge sessions', () => {
    const { paths } = parseCli(argv('a', 'b', 'c', 'd', 'e'))
    expect(paths).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reads /switch, -switch and --switch alike', () => {
    const { switches } = parseCli(argv('/iu', '-expandall', '--silent'))
    expect(switches.iu).toBe(true)
    expect(switches.expandall).toBe(true)
    expect(switches.silent).toBe(true)
  })

  it('reads values from value switches', () => {
    const { switches } = parseCli(argv('/filters=*.js;-*.min.js', '/fv=hex'))
    expect(switches.filters).toBe('*.js;-*.min.js')
    expect(switches.fv).toBe('hex')
  })

  it('resolves documented aliases', () => {
    expect(parseCli(argv('/?')).switches.help).toBe(true)
    expect(parseCli(argv('/h')).switches.help).toBe(true)
    expect(parseCli(argv('/quickcompare=crc')).switches.qc).toBe('crc')
    expect(parseCli(argv('/fileviewer=table')).switches.fv).toBe('table')
  })

  it('does not mistake a Unix path for a switch', () => {
    const { paths, switches } = parseCli(argv('/home/eddy/a.txt', '/tmp/b.txt'))
    expect(paths).toEqual(['/home/eddy/a.txt', '/tmp/b.txt'])
    expect(Object.keys(switches)).toHaveLength(0)
  })

  it('reports a value given to a flag rather than dropping it silently', () => {
    const { switches, unknown } = parseCli(argv('/silent=yes'))
    expect(switches.silent).toBe('yes')
    expect(unknown).toContain('silent')
  })

  it('is case-insensitive for switch names', () => {
    expect(parseCli(argv('/ExpandAll')).switches.expandall).toBe(true)
  })

  it('tolerates empty and malformed input', () => {
    expect(parseCli(undefined).paths).toEqual([])
    expect(parseCli(argv('', '/', '-')).switches).toEqual({})
  })

  it('parseCliArgs still returns just the first two paths', () => {
    expect(parseCliArgs(argv('a', 'b', 'c', '/iu'))).toEqual(['a', 'b'])
  })

  it('usage text names the switches it supports', () => {
    const t = usageText()
    expect(t).toContain('/filters=')
    expect(t).toContain('/fv=')
    expect(t).toContain('/script=')
  })
})

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('load a b')).toEqual(['load', 'a', 'b'])
  })

  it('keeps quoted paths with spaces together', () => {
    expect(tokenize('load "C:\\Program Files\\x" b'))
      .toEqual(['load', 'C:\\Program Files\\x', 'b'])
  })

  it('treats a doubled quote as a literal quote', () => {
    expect(tokenize('log "say ""hi"""')).toEqual(['log', 'say "hi"'])
  })

  it('preserves an empty quoted operand', () => {
    expect(tokenize('filter ""')).toEqual(['filter', ''])
  })

  it('collapses runs of whitespace', () => {
    expect(tokenize('  load    a  ')).toEqual(['load', 'a'])
  })
})

describe('parseScript', () => {
  it('parses a simple script', () => {
    const { commands, errors } = parseScript([
      'load "C:\\left" "C:\\right"',
      'expand all',
      'select diff',
      'folder-report layout:side-by-side output-to:report.html',
    ].join('\n'))

    expect(errors).toEqual([])
    expect(commands.map((c) => c.name))
      .toEqual(['load', 'expand', 'select', 'folder-report'])
    expect(commands[0].operands).toEqual(['C:\\left', 'C:\\right'])
    expect(commands[3].options).toEqual({
      layout: 'side-by-side',
      'output-to': 'report.html',
    })
  })

  it('skips blank lines and comments', () => {
    const { commands } = parseScript('# a comment\n\n// another\nbeep\n')
    expect(commands.map((c) => c.name)).toEqual(['beep'])
  })

  it('does not read a Windows drive letter as a modifier', () => {
    const { commands, errors } = parseScript('load C:\\left C:\\right')
    expect(errors).toEqual([])
    expect(commands[0].operands).toEqual(['C:\\left', 'C:\\right'])
    expect(commands[0].options).toEqual({})
  })

  it('reports unknown commands with their line number', () => {
    const { errors } = parseScript('load a b\nfrobnicate x\n')
    expect(errors).toHaveLength(1)
    expect(errors[0].line).toBe(2)
    expect(errors[0].message).toContain('frobnicate')
  })

  it('reports too few operands', () => {
    const { errors, commands } = parseScript('load')
    expect(commands).toEqual([])
    expect(errors[0].message).toContain('至少 1')
  })

  it('reports too many operands', () => {
    const { errors } = parseScript('rename a b c')
    expect(errors[0].message).toContain('最多接受 2')
  })

  it('collects every error rather than stopping at the first', () => {
    const { errors } = parseScript('bogus1\nbogus2\nload\n')
    expect(errors).toHaveLength(3)
  })

  it('records the source line for each command', () => {
    const { commands } = parseScript('\n\nbeep\n\nload a\n')
    expect(commands.map((c) => c.line)).toEqual([3, 5])
  })

  it('tolerates empty input', () => {
    expect(parseScript('')).toEqual({ commands: [], errors: [] })
    expect(parseScript(undefined)).toEqual({ commands: [], errors: [] })
  })
})

describe('mutation detection', () => {
  it('flags a script that writes', () => {
    const { commands } = parseScript('load a b\ncopy left->right\n')
    expect(isMutating(commands)).toBe(true)
  })

  it('does not flag a read-only script', () => {
    const { commands } = parseScript('load a b\nfolder-report output-to:r.html\n')
    expect(isMutating(commands)).toBe(false)
  })

  it('treats delete and sync as mutating', () => {
    for (const cmd of ['delete', 'sync', 'move', 'touch', 'attrib']) {
      expect(MUTATING_COMMANDS.has(cmd), cmd).toBe(true)
    }
  })
})

describe('describeScript', () => {
  it('lists commands and warns when the script writes', () => {
    const { commands } = parseScript('load a b\ndelete orphans\n')
    const out = describeScript(commands)
    expect(out).toContain('load')
    expect(out).toContain('delete')
    expect(out).toContain('會修改檔案系統')
  })

  it('says so when nothing will be written', () => {
    const { commands } = parseScript('load a b\n')
    expect(describeScript(commands)).toContain('不會修改檔案系統')
  })

  it('handles an empty script', () => {
    expect(describeScript([])).toContain('空腳本')
  })
})

describe('switch versus path disambiguation', () => {
  // '/' introduces a switch on Windows and a path on Unix, and the same script
  // may run on both, so the name part has to settle it.
  it('treats a slash-prefixed name containing a dot as a path', () => {
    expect(parseCli(argv('/left.txt')).paths).toEqual(['/left.txt'])
    expect(parseCli(argv('/left.txt')).switches).toEqual({})
  })

  it('treats a slash-prefixed bare word as a switch', () => {
    expect(parseCli(argv('/silent')).switches.silent).toBe(true)
    expect(parseCli(argv('/silent')).paths).toEqual([])
  })

  it('keeps a value containing dots from turning a switch into a path', () => {
    expect(parseCli(argv('/filters=*.js;*.ts')).switches.filters).toBe('*.js;*.ts')
    expect(parseCli(argv('/filters=*.js;*.ts')).paths).toEqual([])
  })

  it('treats nested Unix paths as paths', () => {
    expect(parseCli(argv('/tmp/b.txt', '/var/log')).paths).toEqual(['/tmp/b.txt', '/var/log'])
  })

  it('still reads /? as a switch', () => {
    expect(parseCli(argv('/?')).switches.help).toBe(true)
  })

  it('treats a dash-prefixed token as a switch even when it has a dot', () => {
    expect(parseCli(argv('-fv=text')).switches.fv).toBe('text')
  })
})
