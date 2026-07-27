/**
 * @vitest-environment jsdom
 *
 * Wiring test: the diff engine's weighted alignment is worth nothing unless a
 * view actually hands it the grammar's weights. This walks the path a user
 * walks — open two files, look at the result — rather than calling the engine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

Object.defineProperty(globalThis, 'window', { value: globalThis, writable: true })
globalThis.window.electronAPI = {
  openFile: vi.fn(), saveFile: vi.fn(), readFile: vi.fn(),
  watchFile: vi.fn(), unwatchFile: vi.fn(), onFileChanged: vi.fn(),
}

const { TextCompare } = await import('../../src/renderer/src/views/text-compare.js')
const { ThreeWayCompare } = await import('../../src/renderer/src/views/three-way-compare.js')
const { resetGrammars } = await import('../../src/renderer/src/core/grammar.js')

function buildDom() {
  document.body.innerHTML = `
    <div id="view-text">
      <div class="compare-area" id="compare-area">
        <div class="pane" id="pane-left"><div class="pane-content" id="content-left"></div></div>
        <div class="splitter" id="splitter"></div>
        <div class="pane" id="pane-right"><div class="pane-content" id="content-right"></div></div>
        <div class="minimap" id="minimap"><div id="minimap-viewport"></div></div>
      </div>
    </div>`
}

function makeTC() {
  buildDom()
  const tc = new TextCompare()
  tc._mounted = true
  tc._compareArea = document.getElementById('compare-area')
  tc._contentLeft = document.getElementById('content-left')
  tc._contentRight = document.getElementById('content-right')
  tc._minimap = document.getElementById('minimap')
  tc._minimapViewport = document.getElementById('minimap-viewport')
  for (const el of [tc._contentLeft, tc._contentRight]) {
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
  }
  return tc
}

// The same moved-function-past-a-comment-banner case the engine test uses.
const BANNER = ['//', '//', '//', '//', '//']
const FUNC = ['int compute(int n) {', '  int total = 0;', '  return total;', '}']
const LEFT = [...BANNER, ...FUNC].join('\n')
const RIGHT = [...FUNC, ...BANNER].join('\n')

const equalLeftTexts = (diff) =>
  diff.filter(d => d.type === 'equal').map(d => (d.leftText ?? '').replace(/\n$/, ''))

beforeEach(() => resetGrammars())
afterEach(() => { document.body.innerHTML = '' })

describe('TextCompare feeds grammar weights to the aligner', () => {
  it('a recognised format aligns the moved function', () => {
    const tc = makeTC()
    tc.setLeft('a.c', LEFT)
    tc.setRight('b.c', RIGHT)
    expect(equalLeftTexts(tc._diffResult)).toContain('int compute(int n) {')
  })

  it('turning the option off falls back to the plain alignment', () => {
    const tc = makeTC()
    tc.setLeft('a.c', LEFT)
    tc.setRight('b.c', RIGHT)
    tc.setAlignByGrammar(false)
    expect(equalLeftTexts(tc._diffResult)).toEqual(['//', '//', '//', '//'])
    tc.setAlignByGrammar(true)
    expect(equalLeftTexts(tc._diffResult)).toContain('int compute(int n) {')
  })

  it('a format with no grammar is compared unweighted', () => {
    const tc = makeTC()
    tc.setLeft('a.unknownext', LEFT)
    tc.setRight('b.unknownext', RIGHT)
    expect(tc._weightAlignEligible()).toBe(false)
    expect(equalLeftTexts(tc._diffResult)).toEqual(['//', '//', '//', '//'])
  })

  it('the size ceiling disables weighting rather than slowing the diff down', () => {
    const tc = makeTC()
    tc.setLeft('a.c', LEFT)
    tc.setRight('b.c', RIGHT)
    expect(tc._weightAlignEligible()).toBe(true)
    tc._leftContent = 'x\n'.repeat(600_000)
    expect(tc._weightAlignEligible()).toBe(false)
  })

  it('the preference survives a config round-trip', () => {
    const tc = makeTC()
    tc.setLeft('a.c', LEFT)
    tc.setRight('b.c', RIGHT)
    tc.setAlignByGrammar(false)
    const cfg = tc.getConfig()
    expect(cfg.alignByGrammar).toBe(false)

    const other = makeTC()
    other.setLeft('a.c', LEFT)
    other.setRight('b.c', RIGHT)
    other.applyConfig(cfg)
    expect(other._opts.alignByGrammar).toBe(false)
    expect(equalLeftTexts(other._diffResult)).toEqual(['//', '//', '//', '//'])
  })
})

describe('ThreeWayCompare feeds grammar weights to the aligner', () => {
  it('base→side diffs align the moved function', () => {
    const m = new ThreeWayCompare()
    m._basePath = 'base.c'
    m._leftPath = 'left.c'
    m._rightPath = 'right.c'
    const res = m._threeWayMerge(RIGHT, LEFT, LEFT)
    expect(equalLeftTexts(res.leftDiff)).toContain('int compute(int n) {')

    m._alignByGrammar = false
    const plain = m._threeWayMerge(RIGHT, LEFT, LEFT)
    expect(equalLeftTexts(plain.leftDiff)).toEqual(['//', '//', '//', '//'])
  })

  it('no path means no weights, not a crash', () => {
    const m = new ThreeWayCompare()
    expect(m._alignmentWeights('', LEFT)).toBeUndefined()
    expect(m._alignmentWeights('a.c', '')).toBeUndefined()
    expect(m._alignmentWeights('a.nosuchformat', LEFT)).toBeUndefined()
    expect(m._threeWayMerge(RIGHT, LEFT, LEFT).leftDiff.length).toBeGreaterThan(0)
  })
})
