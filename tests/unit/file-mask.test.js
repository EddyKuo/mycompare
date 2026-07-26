/**
 * Beyond Compare file-mask syntax.
 *
 * Cases follow the behaviour described in BC's "File Masks" help topic.
 */
import { describe, it, expect } from 'vitest'
import { parseMask, parseMasks, matchesFilter } from '../../src/renderer/src/core/file-mask.js'

describe('wildcards', () => {
  it('matches * against any run of characters', () => {
    expect(matchesFilter('main.js', '*.js')).toBe(true)
    expect(matchesFilter('main.ts', '*.js')).toBe(false)
    expect(matchesFilter('.js', '*.js')).toBe(true)
  })

  it('matches ? against exactly one character', () => {
    expect(matchesFilter('a.js', '?.js')).toBe(true)
    expect(matchesFilter('ab.js', '?.js')).toBe(false)
    expect(matchesFilter('.js', '?.js')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(matchesFilter('MAIN.JS', '*.js')).toBe(true)
    expect(matchesFilter('ReadMe.md', 'readme.MD')).toBe(true)
  })

  it('does not let * cross a path separator', () => {
    expect(matchesFilter('a.js', 'src\\*.js', { relativePath: 'src\\a.js' })).toBe(true)
    expect(matchesFilter('a.js', 'src\\*.js', { relativePath: 'src\\deep\\a.js' })).toBe(false)
  })
})

describe('character sets', () => {
  it('matches a plain set', () => {
    expect(matchesFilter('a.txt', '[abc].txt')).toBe(true)
    expect(matchesFilter('d.txt', '[abc].txt')).toBe(false)
  })

  it('matches a range', () => {
    expect(matchesFilter('m.txt', '[a-z].txt')).toBe(true)
    expect(matchesFilter('5.txt', '[a-z].txt')).toBe(false)
    expect(matchesFilter('5.txt', '[0-9].txt')).toBe(true)
  })

  it('honours a negated set', () => {
    expect(matchesFilter('d.txt', '[!abc].txt')).toBe(true)
    expect(matchesFilter('a.txt', '[!abc].txt')).toBe(false)
  })

  it('treats [[ as a literal bracket', () => {
    expect(matchesFilter('[x].txt', '[[x].txt')).toBe(true)
    expect(matchesFilter('x.txt', '[[x].txt')).toBe(false)
  })

  it('treats an unterminated set as a literal', () => {
    expect(matchesFilter('[abc.txt', '[abc.txt')).toBe(true)
  })
})

describe('multiple masks', () => {
  it('accepts a semicolon-separated list', () => {
    const f = '*.pas;*.dfm;*.dpr'
    expect(matchesFilter('unit.pas', f)).toBe(true)
    expect(matchesFilter('form.dfm', f)).toBe(true)
    expect(matchesFilter('main.js', f)).toBe(false)
  })

  it('still accepts whitespace separation', () => {
    expect(matchesFilter('a.js', '*.js *.ts')).toBe(true)
    expect(matchesFilter('a.ts', '*.js *.ts')).toBe(true)
  })
})

describe('exclusions', () => {
  it('vetoes a match with a leading dash', () => {
    expect(matchesFilter('main.bak', '-*.bak')).toBe(false)
    expect(matchesFilter('main.js', '-*.bak')).toBe(true)
  })

  it('lets an exclusion override an inclusion', () => {
    const f = '*.js;-*.min.js'
    expect(matchesFilter('app.js', f)).toBe(true)
    expect(matchesFilter('app.min.js', f)).toBe(false)
  })

  it('admits everything when only exclusions are given', () => {
    expect(matchesFilter('anything.txt', '-*.bak')).toBe(true)
  })
})

describe('folder-only masks', () => {
  it('matches directories but not files', () => {
    expect(matchesFilter('build', 'build\\', { isDirectory: true })).toBe(true)
    expect(matchesFilter('build', 'build\\', { isDirectory: false })).toBe(true) // no include mask applies
  })

  it('excludes a directory without excluding a like-named file', () => {
    const f = '-node_modules\\'
    expect(matchesFilter('node_modules', f, { isDirectory: true })).toBe(false)
    expect(matchesFilter('node_modules', f, { isDirectory: false })).toBe(true)
  })
})

describe('path-relative masks', () => {
  it('anchors .\\ at the base folder', () => {
    expect(matchesFilter('a.js', '.\\src\\a.js', { relativePath: 'src\\a.js' })).toBe(true)
    expect(matchesFilter('a.js', '.\\src\\a.js', { relativePath: 'lib\\a.js' })).toBe(false)
  })

  it('matches ...\\ at any depth', () => {
    expect(matchesFilter('a.js', '...\\a.js', { relativePath: 'a.js' })).toBe(true)
    expect(matchesFilter('a.js', '...\\a.js', { relativePath: 'src\\deep\\a.js' })).toBe(true)
    expect(matchesFilter('b.js', '...\\a.js', { relativePath: 'src\\b.js' })).toBe(false)
  })

  it('treats an embedded separator as base-relative', () => {
    expect(matchesFilter('f.txt', 'p\\f.txt', { relativePath: 'p\\f.txt' })).toBe(true)
    expect(matchesFilter('f.txt', 'p\\f.txt', { relativePath: 'q\\f.txt' })).toBe(false)
  })

  it('accepts forward slashes too', () => {
    expect(matchesFilter('a.js', 'src/a.js', { relativePath: 'src/a.js' })).toBe(true)
    expect(matchesFilter('a.js', 'src/a.js', { relativePath: 'src\\a.js' })).toBe(true)
  })
})

describe('trailing period', () => {
  it('matches names with no extension', () => {
    expect(matchesFilter('Makefile', 'Makefile.')).toBe(true)
    expect(matchesFilter('Makefile.txt', 'Makefile.')).toBe(false)
  })

  it('combines with a wildcard', () => {
    expect(matchesFilter('LICENSE', '*.')).toBe(true)
    expect(matchesFilter('LICENSE.md', '*.')).toBe(false)
  })
})

describe('parsing', () => {
  it('ignores empty input', () => {
    expect(parseMask('')).toBeNull()
    expect(parseMask('   ')).toBeNull()
    expect(parseMask('-')).toBeNull()
    expect(parseMasks('')).toEqual([])
  })

  it('records the flags it parsed', () => {
    const m = parseMask('-build\\')
    expect(m.exclude).toBe(true)
    expect(m.folderOnly).toBe(true)

    expect(parseMask('...\\x').anyDepth).toBe(true)
    expect(parseMask('.\\x').anchored).toBe(true)
    expect(parseMask('*.js').anchored).toBe(false)
  })

  it('admits everything for an empty mask list', () => {
    expect(matchesFilter('anything', '')).toBe(true)
  })
})

describe('regex metacharacters are literal', () => {
  it('does not treat . + ( ) as regex syntax', () => {
    expect(matchesFilter('a+b.txt', 'a+b.txt')).toBe(true)
    expect(matchesFilter('axb.txt', 'a+b.txt')).toBe(false)
    expect(matchesFilter('f(1).txt', 'f(1).txt')).toBe(true)
  })
})
