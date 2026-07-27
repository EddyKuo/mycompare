/**
 * Tests for core/grammar.js — the BC "File Format → Grammar" engine.
 *
 * Covers the five item types, item priority, line weights, element masking,
 * and (most importantly) the complexity bounds that keep a user-supplied
 * grammar from freezing the renderer.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  BUILTIN_GRAMMARS,
  DEFAULT_STEP_BUDGET,
  MAX_LINE_LEN,
  MAX_TOKENS_PER_LINE,
  compileGrammar,
  computeLineWeights,
  elementsOf,
  getGrammarForPath,
  getUserGrammars,
  isRiskyRegexSource,
  lineWeight,
  linesEqualIgnoringElements,
  listGrammars,
  maskLine,
  maskMatches,
  registerGrammar,
  removeGrammar,
  resetGrammars,
  setUserGrammars,
  tokenizeLine,
  tokenizeLines,
  newTokenizeState,
} from '../../src/renderer/src/core/grammar.js'

/** @param {string} text */
const lines = (text) => text.split('\n')

/** Tokenize `text` with the grammar matching `path`. */
function tok(path, text, opts) {
  const g = getGrammarForPath(path)
  expect(g).not.toBeNull()
  return { g, ...tokenizeLines(g, lines(text), opts) }
}

beforeEach(() => resetGrammars())

// ── Item types ───────────────────────────────────────────────────────────────

describe('grammar item types', () => {
  it('basic: literal match', () => {
    const g = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'basic', element: 'Marker', text: 'TODO' }],
    })
    expect(g.errors).toEqual([])
    const { tokens } = tokenizeLines(g, ['a TODO b'])
    expect(tokens[0]).toEqual([{ element: 'Marker', start: 2, end: 6, item: 0 }])
  })

  it('basic: regex match, anchored at the scan position', () => {
    const g = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'basic', element: 'Number', text: '\\d+', regex: true }],
    })
    const { tokens } = tokenizeLines(g, ['abc 123 def 45'])
    expect(tokens[0].map(t => [t.start, t.end])).toEqual([[4, 7], [12, 14]])
  })

  it('basic: wholeWord rejects a match inside an identifier', () => {
    const g = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'basic', element: 'K', text: 'if', wholeWord: true }],
    })
    const { tokens } = tokenizeLines(g, ['gift if x'])
    expect(tokens[0]).toHaveLength(1)
    expect(tokens[0][0].start).toBe(5)
  })

  it('delimited: paired delimiters with an escape character', () => {
    const g = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'delimited', element: 'String', start: '"', end: '"', escape: '\\', stopAtEol: true }],
    })
    const { tokens } = tokenizeLines(g, ['x = "a\\"b" ;'])
    expect(tokens[0]).toHaveLength(1)
    expect(tokens[0][0]).toMatchObject({ start: 4, end: 10 })
  })

  it('delimited: multiline run carries across lines and closes', () => {
    const g = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'delimited', element: 'Comment', start: '/*', end: '*/', multiline: true }],
    })
    const { tokens } = tokenizeLines(g, ['a /* one', 'two', 'three */ b'])
    expect(elementsOf(tokens[0])).toEqual(['Comment'])
    expect(elementsOf(tokens[1])).toEqual(['Comment'])
    expect(tokens[2][0]).toMatchObject({ start: 0, end: 8 })
  })

  it('delimited: an unterminated non-multiline run stops at EOL', () => {
    const g = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'delimited', element: 'String', start: '"', end: '"', stopAtEol: true }],
    })
    const { tokens } = tokenizeLines(g, ['a "unclosed', 'next line'])
    expect(tokens[0][0].end).toBe(11)
    expect(tokens[1]).toEqual([])
  })

  it('list: longest token wins and word boundaries are honoured', () => {
    const g = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'list', element: 'Keyword', items: ['else', 'elseif'], wholeWord: true }],
    })
    const { tokens } = tokenizeLines(g, ['elseif x'])
    expect(tokens[0][0]).toMatchObject({ start: 0, end: 6 })
  })

  it('columns: fixed range and to-end-of-line', () => {
    const g = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'columns', element: 'Seq', startColumn: 73, endColumn: 80 }],
    })
    const line = 'x'.repeat(80)
    const { tokens } = tokenizeLines(g, [line])
    expect(tokens[0][0]).toMatchObject({ start: 72, end: 80 })

    const g2 = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'columns', element: 'Tail', startColumn: 5, toEol: true }],
    })
    const r2 = tokenizeLines(g2, ['abcdefgh'])
    expect(r2.tokens[0][0]).toMatchObject({ start: 4, end: 8 })
  })

  it('lines: whole-line rule limited to the heading lines', () => {
    const g = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'lines', element: 'Heading', match: 'Page ', headingLines: 2 }],
    })
    const { tokens } = tokenizeLines(g, ['Page 1', 'Page 2', 'Page 3'])
    expect(elementsOf(tokens[0])).toEqual(['Heading'])
    expect(elementsOf(tokens[1])).toEqual(['Heading'])
    expect(tokens[2]).toEqual([])
  })

  it('lines: orLine1 keeps line 1 matching beyond the heading window', () => {
    const g = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'lines', element: 'Heading', match: '^H', regex: true, headingLines: 0, orLine1: true }],
    })
    const { tokens } = tokenizeLines(g, ['Hxx', 'Hyy'])
    expect(elementsOf(tokens[0])).toEqual(['Heading'])
    expect(tokens[1]).toEqual([])
  })
})

// ── Priority ─────────────────────────────────────────────────────────────────

describe('item priority', () => {
  it('the earlier item wins at the same position', () => {
    const def = {
      name: 't', masks: ['*.x'],
      items: [
        { type: 'basic', element: 'First', text: '##' },
        { type: 'delimited', element: 'Second', start: '#', stopAtEol: true },
      ],
    }
    const a = tokenizeLines(compileGrammar(def), ['## rest'])
    expect(a.tokens[0][0].element).toBe('First')

    // Same two rules, reversed order → the other one wins.
    const b = tokenizeLines(compileGrammar({ ...def, items: [...def.items].reverse() }), ['## rest'])
    expect(b.tokens[0][0].element).toBe('Second')
  })

  it('user grammars take precedence over the built-in for the same mask', () => {
    expect(getGrammarForPath('a.py').name).toBe('Python')
    registerGrammar({ name: 'My Python', masks: ['*.py'], items: [{ type: 'basic', element: 'X', text: 'x' }] })
    expect(getGrammarForPath('a.py').name).toBe('My Python')
    expect(removeGrammar('My Python')).toBe(true)
    expect(getGrammarForPath('a.py').name).toBe('Python')
  })
})

// ── Built-ins ────────────────────────────────────────────────────────────────

describe('built-in grammars', () => {
  it('every built-in compiles without errors', () => {
    for (const def of BUILTIN_GRAMMARS) {
      const g = compileGrammar(def)
      expect({ name: def.name, errors: g.errors }).toEqual({ name: def.name, errors: [] })
      expect(g.compiled.length).toBe(def.items.length)
    }
  })

  it('C family: comments, strings, preprocessor, keywords, numbers', () => {
    const { tokens } = tok('main.c', [
      '#include <stdio.h>',
      'int x = 42; // trailing',
      'const char *s = "hello /* not a comment */";',
      '/* block',
      '   still */ return 0;',
    ].join('\n'))
    expect(elementsOf(tokens[0])).toContain('Preprocessor')
    expect(elementsOf(tokens[1])).toEqual(expect.arrayContaining(['Keyword', 'Number', 'Comment']))
    // The string opens before the comment delimiter, so the comment inside it
    // is part of the string, not a comment.
    expect(elementsOf(tokens[2])).not.toContain('Comment')
    expect(elementsOf(tokens[3])).toEqual(['Comment'])
    expect(elementsOf(tokens[4])).toEqual(expect.arrayContaining(['Comment', 'Keyword']))
  })

  it('Python: triple-quoted docstrings span lines; # comments do not', () => {
    const { tokens } = tok('a.py', '"""doc\nmore"""\nx = 1  # note')
    expect(elementsOf(tokens[0])).toEqual(['String'])
    expect(elementsOf(tokens[1])).toEqual(['String'])
    expect(elementsOf(tokens[2])).toContain('Comment')
  })

  it('XML: comments, tags and attribute strings', () => {
    const { tokens } = tok('a.xml', '<!-- c -->\n<node attr="v">text</node>')
    expect(elementsOf(tokens[0])).toEqual(['Comment'])
    expect(elementsOf(tokens[1])).toEqual(expect.arrayContaining(['Tag', 'String']))
  })

  it('masks resolve by basename, case-insensitively', () => {
    expect(maskMatches('C:\\a\\b\\Main.C', ['*.c'])).toBe(true)
    expect(maskMatches('/tmp/x.txt', ['*.c'])).toBe(false)
    expect(getGrammarForPath('notes.txt')).toBeNull()
  })
})

// ── Masking / importance ─────────────────────────────────────────────────────

describe('element masking', () => {
  it('blanks ignored spans while preserving columns', () => {
    const g = getGrammarForPath('a.c')
    const line = 'int x = 1; // why'
    const { tokens } = tokenizeLines(g, [line])
    const masked = maskLine(line, tokens[0], ['Comment'])
    expect(masked.length).toBe(line.length)
    expect(masked.startsWith('int x = 1; ')).toBe(true)
    expect(masked.trim()).toBe('int x = 1;')
  })

  it('two lines differing only in a comment compare equal', () => {
    const g = getGrammarForPath('a.c')
    const l = 'int x = 1; // old note'
    const r = 'int x = 1; // brand new note'
    const lt = tokenizeLines(g, [l]).tokens[0]
    const rt = tokenizeLines(g, [r]).tokens[0]
    expect(linesEqualIgnoringElements(l, r, lt, rt, ['Comment'])).toBe(true)
    expect(linesEqualIgnoringElements(l, r, lt, rt, [])).toBe(false)
  })

  it('a real code change is still a difference with comments ignored', () => {
    const g = getGrammarForPath('a.c')
    const l = 'int x = 1; // note'
    const r = 'int x = 2; // note'
    const lt = tokenizeLines(g, [l]).tokens[0]
    const rt = tokenizeLines(g, [r]).tokens[0]
    expect(linesEqualIgnoringElements(l, r, lt, rt, ['Comment'])).toBe(false)
  })

  it('maskLine is a no-op with no ignored elements', () => {
    expect(maskLine('abc', [{ element: 'X', start: 0, end: 3, item: 0 }], [])).toBe('abc')
  })
})

// ── Line weights ─────────────────────────────────────────────────────────────

describe('line weights', () => {
  it('blank lines weigh 0, plain text 1, keyword lines more', () => {
    const g = getGrammarForPath('a.c')
    const src = ['', 'plain text here', 'if (x) { return; }', '#define A 1']
    const { weights } = computeLineWeights(g, src)
    expect(weights[0]).toBe(0)
    expect(weights[1]).toBe(1)
    expect(weights[2]).toBeGreaterThan(weights[1])
    expect(weights[3]).toBeGreaterThan(weights[2])
  })

  it('a comment-only line weighs less than a code line', () => {
    const g = getGrammarForPath('a.c')
    const { weights } = computeLineWeights(g, ['// just a note', 'int x = 1;'])
    expect(weights[0]).toBeLessThan(weights[1])
  })

  it('lineWeight tolerates a missing grammar', () => {
    expect(lineWeight('x', [], null)).toBe(1)
    expect(lineWeight('   ', [], null)).toBe(0)
  })
})

// ── Complexity bounds ────────────────────────────────────────────────────────

describe('pathological input is bounded', () => {
  it('rejects nested unbounded quantifiers', () => {
    expect(isRiskyRegexSource('(a+)+$')).toMatch(/巢狀/)
    expect(isRiskyRegexSource('(a|a)*$')).toMatch(/巢狀/)
    expect(isRiskyRegexSource('(\\s*\\w)*x')).toMatch(/巢狀/)
    expect(isRiskyRegexSource('x'.repeat(500))).toMatch(/過長/)
    expect(isRiskyRegexSource('(a'.repeat(3))).toMatch(/括號/)
  })

  it('accepts ordinary patterns, including a bounded quantifier over a group', () => {
    expect(isRiskyRegexSource('\\d+(?:\\.\\d+)?')).toBeNull()
    expect(isRiskyRegexSource('^\\s*#\\s*\\w+')).toBeNull()
    expect(isRiskyRegexSource('[a-z]{2,4}')).toBeNull()
  })

  it('a risky user regex is dropped with a visible reason, not silently', () => {
    const g = compileGrammar({
      name: 'evil', masks: ['*.x'],
      items: [{ type: 'basic', element: 'Boom', text: '(a+)+b', regex: true }],
    })
    expect(g.compiled).toHaveLength(0)
    expect(g.errors.join()).toMatch(/巢狀/)
    // registerGrammar refuses a grammar with nothing left to run.
    const res = registerGrammar({ name: 'evil', masks: ['*.x'], items: [{ type: 'basic', element: 'B', text: '(a+)+b', regex: true }] })
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
  })

  it('a very long line is tokenized only up to MAX_LINE_LEN', () => {
    const g = getGrammarForPath('a.c')
    const long = 'x'.repeat(MAX_LINE_LEN + 5000) + ' // tail comment'
    const t0 = Date.now()
    const res = tokenizeLines(g, [long])
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(res.truncated).toBe(true)
    // The comment sits past the cap, so it is not classified — and the caller
    // is told the line was truncated rather than being handed a wrong answer.
    expect(elementsOf(res.tokens[0])).not.toContain('Comment')
  })

  it('caps the token count for a line that matches at every character', () => {
    const g = compileGrammar({
      name: 't', masks: ['*.x'],
      items: [{ type: 'basic', element: 'Ch', text: 'a' }],
    })
    const res = tokenizeLines(g, ['a'.repeat(MAX_TOKENS_PER_LINE + 500)])
    expect(res.tokens[0].length).toBeLessThanOrEqual(MAX_TOKENS_PER_LINE)
    expect(res.truncated).toBe(true)
  })

  it('deeply repeated delimiters do not blow up (no nesting, flat scan)', () => {
    const g = getGrammarForPath('a.c')
    const src = Array.from({ length: 2000 }, () => '/*'.repeat(20) + '*/'.repeat(20))
    const t0 = Date.now()
    const res = tokenizeLines(g, src)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(res.tokens).toHaveLength(2000)
  })

  it('the global step budget stops runaway work and reports truncation', () => {
    const g = getGrammarForPath('a.c')
    const src = Array.from({ length: 5000 }, (_, i) => `int v${i} = ${i}; // c${i}`)
    const res = tokenizeLines(g, src, { stepBudget: 1000 })
    expect(res.truncated).toBe(true)
    expect(res.steps).toBeLessThan(20000)
    expect(res.tokens).toHaveLength(5000)   // still one entry per line
  })

  it('tokenizes a 50k-line file within the DEFAULT budget, without truncating', () => {
    const g = getGrammarForPath('a.c')
    const src = Array.from({ length: 50000 }, (_, i) => `  int value${i} = ${i}; // note ${i}`)
    const t0 = Date.now()
    // No explicit budget: this guards the DEFAULT_STEP_BUDGET value itself,
    // which has to be generous enough for a realistic file and still finite.
    const res = tokenizeLines(g, src)
    const ms = Date.now() - t0
    expect(res.tokens).toHaveLength(50000)
    expect(res.truncated).toBe(false)
    expect(res.steps).toBeLessThan(DEFAULT_STEP_BUDGET)
    expect(ms).toBeLessThan(10000)
  })

  it('a file far past the budget still returns, marked truncated', () => {
    const g = getGrammarForPath('a.c')
    const src = Array.from({ length: 400000 }, (_, i) => `  int value${i} = ${i}; // note ${i}`)
    const t0 = Date.now()
    const res = tokenizeLines(g, src)
    expect(Date.now() - t0).toBeLessThan(15000)
    expect(res.truncated).toBe(true)
    expect(res.tokens).toHaveLength(400000)
  })

  it('an exhausted state短路後續行 without throwing', () => {
    const g = getGrammarForPath('a.c')
    const state = newTokenizeState()
    state.budget = 0
    state.exhausted = true
    const res = tokenizeLine(g, 'int x = 1;', 0, state)
    expect(res.tokens).toEqual([])
    expect(res.truncated).toBe(true)
  })
})

// ── Registry ─────────────────────────────────────────────────────────────────

describe('user grammar registry', () => {
  it('round-trips through setUserGrammars/getUserGrammars', () => {
    const def = { name: 'INI', masks: ['*.ini'], items: [{ type: 'delimited', element: 'Comment', start: ';', stopAtEol: true }] }
    expect(registerGrammar(def).ok).toBe(true)
    const saved = getUserGrammars()
    resetGrammars()
    expect(getGrammarForPath('a.ini')).toBeNull()
    expect(setUserGrammars(saved)).toEqual([])
    expect(getGrammarForPath('a.ini').name).toBe('INI')
    expect(listGrammars()[0].name).toBe('INI')
  })

  it('registering the same name twice replaces rather than duplicates', () => {
    registerGrammar({ name: 'A', masks: ['*.a'], items: [{ type: 'basic', element: 'X', text: 'x' }] })
    registerGrammar({ name: 'A', masks: ['*.a2'], items: [{ type: 'basic', element: 'Y', text: 'y' }] })
    expect(getUserGrammars()).toHaveLength(1)
    expect(getGrammarForPath('f.a2').elements).toEqual(['Y'])
  })

  it('setUserGrammars reports the definitions it could not accept', () => {
    const errs = setUserGrammars([{ name: 'bad', masks: ['*.b'], items: [{ type: 'nope', element: 'E' }] }])
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatch(/bad/)
  })
})
