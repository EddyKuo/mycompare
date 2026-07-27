/**
 * @vitest-environment jsdom
 *
 * P2-29 Grammar + P3 Details / Ruler / File Info / Description / per-side lock
 * as wired into the text compare view.
 *
 * The virtual-scroll assertions use tens of thousands of lines on purpose:
 * every panel added here sits outside the scrolling panes, and the point is to
 * prove none of them reintroduced per-row DOM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

Object.defineProperty(globalThis, 'window', {
  value: globalThis,
  writable: true,
})
globalThis.window.electronAPI = {
  openFile: vi.fn(), saveFile: vi.fn(), readFile: vi.fn(),
  watchFile: vi.fn(), unwatchFile: vi.fn(), onFileChanged: vi.fn(),
}

const { TextCompare, FONT_CHOICES } = await import('../../src/renderer/src/views/text-compare.js')
const { resetGrammars } = await import('../../src/renderer/src/core/grammar.js')

/** Build the parts of index.html the view actually reaches for. */
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

/**
 * A TextCompare wired to the real DOM above, without mount()'s global
 * keyboard/IPC listeners.
 */
function makeTC() {
  buildDom()
  const tc = new TextCompare()
  tc._mounted = true
  tc._compareArea = document.getElementById('compare-area')
  tc._contentLeft = document.getElementById('content-left')
  tc._contentRight = document.getElementById('content-right')
  tc._minimap = document.getElementById('minimap')
  tc._minimapViewport = document.getElementById('minimap-viewport')
  // jsdom reports 0 for every layout box; give the panes a viewport so the
  // virtual scroller renders a realistic window of rows.
  for (const el of [tc._contentLeft, tc._contentRight]) {
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
  }
  return tc
}

beforeEach(() => resetGrammars())
afterEach(() => { document.body.innerHTML = '' })

// ── Grammar-driven importance ────────────────────────────────────────────────

describe('grammar importance', () => {
  it('picks a grammar per side from the filename', () => {
    const tc = makeTC()
    tc.setLeft('a.c', 'int x;\n')
    tc.setRight('b.c', 'int x;\n')
    expect(tc.getGrammarInfo().left).toMatch(/C 家族/)
    expect(tc.getGrammarElements()).toContain('Comment')
  })

  it('a side with no format borrows the other side\'s ("Same as left")', () => {
    const tc = makeTC()
    tc.setLeft('a.py', 'x = 1\n')
    tc.setRight('（貼上）', 'x = 1\n')
    const info = tc.getGrammarInfo()
    expect(info.left).toBe('Python')
    expect(info.right).toBe('Python')
  })

  it('a comment-only change becomes an unimportant difference', () => {
    const tc = makeTC()
    tc.setLeft('a.c', 'int x = 1; // old\n')
    tc.setRight('b.c', 'int x = 1; // new\n')
    expect(tc._diffResult[0].type).toBe('replace')
    expect(tc._diffResult[0].unimportant).toBeFalsy()

    tc.setGrammarIgnore(['Comment'])
    expect(tc._diffResult[0].unimportant).toBe(true)
    expect(tc._diffResult[0].grammarIgnored).toBe(true)
    // Still a difference — only its importance changed.
    expect(tc._diffResult[0].type).toBe('replace')
  })

  it('Ignore Unimportant Differences then hides it entirely', () => {
    const tc = makeTC()
    tc.setLeft('a.c', 'int x = 1; // old\n')
    tc.setRight('b.c', 'int x = 1; // new\n')
    tc.setGrammarIgnore(['Comment'])
    tc.setIgnoreUnimportant(true)
    expect(tc._diffResult[0].type).toBe('equal')
    expect(tc._diffBlocks).toHaveLength(0)
  })

  it('a real code change stays important with comments ignored', () => {
    const tc = makeTC()
    tc.setLeft('a.c', 'int x = 1; // same\n')
    tc.setRight('b.c', 'int x = 2; // same\n')
    tc.setGrammarIgnore(['Comment'])
    expect(tc._diffResult[0].unimportant).toBeFalsy()
  })

  it('an inserted comment-only line is unimportant, an inserted code line is not', () => {
    const tc = makeTC()
    tc.setLeft('a.c', 'int x;\n')
    tc.setRight('b.c', '// note\nint x;\nint y;\n')
    tc.setGrammarIgnore(['Comment'])
    const inserted = tc._diffResult.filter(d => d.type === 'insert')
    const comment = inserted.find(d => d.rightText.includes('// note'))
    const code = inserted.find(d => d.rightText.includes('int y'))
    expect(comment.unimportant).toBe(true)
    expect(code.unimportant).toBeFalsy()
  })

  it('toggleGrammarElement flips one element and re-runs the diff', () => {
    const tc = makeTC()
    tc.setLeft('a.c', 'int x = 1; // a\n')
    tc.setRight('b.c', 'int x = 1; // b\n')
    expect(tc.toggleGrammarElement('Comment')).toBe(true)
    expect(tc._diffResult[0].unimportant).toBe(true)
    expect(tc.toggleGrammarElement('Comment')).toBe(false)
    expect(tc._diffResult[0].unimportant).toBeFalsy()
  })

  it('does not tokenize when nothing needs the tokens', () => {
    // Line-weight alignment consumes the same tokens, so "nothing needs them"
    // now means: no ignored element, no alignment panel, and either no grammar
    // or a pair too large for weighting to be worth its cost.
    const tc = makeTC()
    tc.setAlignByGrammar(false)
    tc.setLeft('a.c', 'int x = 1; // a\n')
    tc.setRight('b.c', 'int x = 1; // b\n')
    expect(tc._tokensLeft).toEqual([])
    tc.setGrammarIgnore(['Comment'])
    expect(tc._tokensLeft.length).toBeGreaterThan(0)
  })

  it('a recognised format tokenizes on its own, for the alignment weights', () => {
    const tc = makeTC()
    tc.setLeft('a.c', 'int x = 1; // a\n')
    tc.setRight('b.c', 'int x = 1; // b\n')
    expect(tc._tokensLeft.length).toBeGreaterThan(0)
    tc.setAlignByGrammar(false)
    expect(tc._tokensLeft).toEqual([])
  })

  it('reports grammar compile errors instead of hiding them', () => {
    const tc = makeTC()
    tc.applyConfig({
      __v: 1, __view: 'text',
      userGrammars: [{
        name: 'Risky', masks: ['*.zz'],
        items: [
          { type: 'basic', element: 'Ok', text: 'x' },
          { type: 'basic', element: 'Boom', text: '(a+)+b', regex: true },
        ],
      }],
    })
    tc.setLeft('f.zz', 'x\n')
    tc.setRight('g.zz', 'x\n')
    const info = tc.getGrammarInfo()
    expect(info.left).toBe('Risky')
    expect(info.errors.join()).toMatch(/巢狀/)
  })
})

// ── Details panels ───────────────────────────────────────────────────────────

describe('details panels', () => {
  it('opens and closes without leaving DOM behind', () => {
    const tc = makeTC()
    expect(tc.setDetailsMode('text')).toBe('text')
    expect(document.querySelectorAll('.tc-details')).toHaveLength(1)
    tc.setDetailsMode('hex')
    expect(document.querySelectorAll('.tc-details')).toHaveLength(1)
    expect(document.querySelector('.tc-details__tab.active').dataset.mode).toBe('hex')
    tc.setDetailsMode(null)
    expect(document.querySelectorAll('.tc-details')).toHaveLength(0)
  })

  it('text details edits the current line and writes it back', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', 'one\ntwo\nthree\n')
    tc.setRight('b.txt', 'one\nTWO\nthree\n')
    tc.setDetailsMode('text')
    tc._setCurrentRow(1, 'left')

    const ta = document.querySelector('.tc-details__text')
    expect(ta.value).toBe('two')
    ta.value = 'edited'
    document.querySelector('.tc-details__apply').click()

    expect(tc.getContent('left')).toBe('one\nedited\nthree\n')
    expect(tc._modified.left).toBe(true)
  })

  it('text details is read-only for a line that side does not have', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', 'one\n')
    tc.setRight('b.txt', 'one\nextra\n')
    tc.setDetailsMode('text')
    // Row 1 is the inserted line — it exists only on the right.
    tc._setCurrentRow(1, 'left')
    expect(document.querySelector('.tc-details__text').readOnly).toBe(true)
    expect(document.querySelector('.tc-details__apply').disabled).toBe(true)
  })

  it('hex details is read-only and shows the line bytes', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', 'AB\n')
    tc.setRight('b.txt', 'AC\n')
    tc.setDetailsMode('hex')
    tc._setCurrentRow(0, 'left')
    const pre = document.querySelector('.tc-details__hex')
    expect(pre.tagName).toBe('PRE')
    expect(pre.textContent).toContain('41 42')
    expect(pre.textContent).toContain('|AB|')
    expect(document.querySelector('.tc-details__text')).toBeNull()
  })

  it('hex details handles multi-byte characters as UTF-8', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', '中\n')
    tc.setRight('b.txt', '文\n')
    tc.setDetailsMode('hex')
    tc._setCurrentRow(0, 'left')
    expect(document.querySelector('.tc-details__hex').textContent).toContain('e4 b8 ad')
  })

  it('alignment details explains the pairing, weights and grammar elements', () => {
    const tc = makeTC()
    tc.setLeft('a.c', 'int x = 1; // a\n')
    tc.setRight('b.c', 'int x = 1; // b\n')
    tc.setGrammarIgnore(['Comment'])
    tc.setDetailsMode('alignment')
    tc._setCurrentRow(0, 'left')

    const text = document.querySelector('.tc-details__align').textContent
    expect(text).toContain('演算法')
    expect(text).toContain('行權重')
    expect(text).toContain('Comment')
    expect(text).toContain('不重要差異')
  })

  it('alignment details turns tokenizing on by itself', () => {
    const tc = makeTC()
    tc.setAlignByGrammar(false)
    tc.setLeft('a.c', 'int x;\n')
    tc.setRight('b.c', 'int y;\n')
    expect(tc._tokensLeft).toEqual([])
    tc.setDetailsMode('alignment')
    expect(tc._tokensLeft.length).toBeGreaterThan(0)
  })

  it('shows a hint rather than throwing when no row is selected', () => {
    const tc = makeTC()
    tc.setDetailsMode('text')
    expect(document.querySelector('.tc-details__hint')).not.toBeNull()
  })

  it('navigation moves the details cursor', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', 'a\nb\nc\n')
    tc.setRight('b.txt', 'a\nB\nc\n')
    tc.setDetailsMode('text')
    tc.navigateFirst()
    expect(tc._currentRowIdx).toBe(tc._diffBlocks[0].startRow)
  })
})

// ── Ruler / File Info / Description ──────────────────────────────────────────

describe('ruler, file info and description', () => {
  it('the ruler is two text nodes, not one element per column', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', 'x'.repeat(300) + '\n')
    tc.setRight('b.txt', 'y'.repeat(300) + '\n')
    expect(tc.toggleRuler()).toBe(true)
    const scales = document.querySelectorAll('.tc-ruler__scale')
    expect(scales).toHaveLength(2)
    expect(scales[0].children).toHaveLength(0)
    expect(scales[0].textContent).toContain('10')
    expect(scales[0].textContent.length).toBeGreaterThan(300)
    expect(tc.toggleRuler()).toBe(false)
    expect(document.querySelector('.tc-ruler')).toBeNull()
  })

  it('the ruler follows horizontal scrolling', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', 'x'.repeat(300) + '\n')
    tc.setRight('b.txt', 'y'.repeat(300) + '\n')
    tc.toggleRuler(true)
    tc._contentLeft.scrollLeft = 120
    tc._handleScrollLeft()
    expect(document.querySelector('.tc-ruler__scale').style.transform).toBe('translateX(-120px)')
  })

  it('file info reports size, lines, encoding and lock state', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', 'one\ntwo\n')
    tc.setRight('b.txt', 'one\n')
    tc.toggleFileInfo(true)
    tc.setSideReadOnly('right', true)
    const rows = document.querySelectorAll('.tc-fileinfo__row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('a.txt')
    expect(rows[0].textContent).toContain('8 B')
    expect(rows[1].textContent).toContain('🔒')
  })

  it('the description box round-trips through the config', () => {
    const tc = makeTC()
    tc.toggleDescription(true)
    const input = document.querySelector('.tc-description__input')
    input.value = '發行前檢查'
    input.dispatchEvent(new Event('input'))
    expect(tc.getDescription()).toBe('發行前檢查')

    const cfg = tc.getConfig()
    const tc2 = makeTC()
    tc2.applyConfig(cfg)
    expect(tc2.getDescription()).toBe('發行前檢查')
    expect(document.querySelector('.tc-description__input').value).toBe('發行前檢查')
  })

  it('the display font family is applied to the panes', () => {
    const tc = makeTC()
    const consolas = FONT_CHOICES.find(f => f.label === 'Consolas')
    tc.setFontFamily(consolas.value)
    expect(tc._compareArea.style.getPropertyValue('--mono-font-family')).toBe(consolas.value)
    tc.setFontFamily('')
    expect(tc._compareArea.style.getPropertyValue('--mono-font-family')).toBe('')
  })
})

// ── Per-side lock ────────────────────────────────────────────────────────────

describe('prevent editing (per side)', () => {
  it('locks one side without affecting the other', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', 'a\n')
    tc.setRight('b.txt', 'b\n')
    expect(tc.setSideReadOnly('left', true)).toBe(true)
    expect(tc.isSideReadOnly('left')).toBe(true)
    expect(tc.isSideReadOnly('right')).toBe(false)

    tc.copyAllToLeft()
    expect(tc.getContent('left')).toBe('a\n')   // refused
    tc.copyAllToRight()
    expect(tc.getContent('right')).toBe('a\n')  // allowed
  })

  it('blocks a copy of the current block into a locked side', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', 'one\ntwo\n')
    tc.setRight('b.txt', 'one\nTWO\n')
    tc.setSideReadOnly('right', true)
    tc._currentDiff = 0
    tc.copyToRight()
    expect(tc.getContent('right')).toBe('one\nTWO\n')
  })

  it('blocks Convert File on a locked side', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', 'a   \n')
    tc.setRight('b.txt', 'b\n')
    tc.setSideReadOnly('left', true)
    tc._convertFile('left', 'trim')
    expect(tc.getContent('left')).toBe('a   \n')
    tc.setSideReadOnly('left', false)
    tc._convertFile('left', 'trim')
    expect(tc.getContent('left')).toBe('a\n')
  })

  it('a locked side cannot be edited through the details panel', () => {
    const tc = makeTC()
    tc.setLeft('a.txt', 'one\n')
    tc.setRight('b.txt', 'two\n')
    tc.setSideReadOnly('left', true)
    tc.setDetailsMode('text')
    tc._setCurrentRow(0, 'left')
    const ta = document.querySelector('.tc-details__text')
    expect(ta.readOnly).toBe(true)
    ta.value = 'hacked'
    document.querySelector('.tc-details__apply').click()
    expect(tc.getContent('left')).toBe('one\n')
  })

  it('the lock survives entering edit mode', () => {
    const tc = makeTC()
    tc._textareaLeft = document.createElement('textarea')
    tc._textareaRight = document.createElement('textarea')
    tc.setLeft('a.txt', 'a\n')
    tc.setRight('b.txt', 'b\n')
    tc.setSideReadOnly('left', true)
    tc.toggleEditMode()
    expect(tc._textareaLeft.readOnly).toBe(true)
    expect(tc._textareaRight.readOnly).toBe(false)
  })
})

// ── Virtual scrolling is untouched ───────────────────────────────────────────

describe('virtual scrolling with the new panels open', () => {
  /** @param {number} n */
  const bigFile = (n, mutate) => Array.from({ length: n },
    (_, i) => `  int value${i} = ${mutate ? i + 1 : i}; // note ${i}`).join('\n') + '\n'

  it('renders only a viewport-sized window of rows for a 50k-line file', () => {
    const tc = makeTC()
    tc.setDetailsMode('alignment')
    tc.toggleRuler(true)
    tc.toggleFileInfo(true)
    tc.toggleDescription(true)

    const t0 = Date.now()
    tc.setLeft('a.c', bigFile(50000))
    tc.setRight('b.c', bigFile(50000, true))
    const ms = Date.now() - t0

    expect(tc._diffResult.length).toBeGreaterThan(49000)
    const rendered = tc._contentLeft.querySelector('.tc-vs-spacer').children.length
    expect(rendered).toBeLessThan(120)
    expect(ms).toBeLessThan(30000)
  })

  it('scrolling a 50k-line file keeps the rendered row count bounded', () => {
    const tc = makeTC()
    tc.toggleRuler(true)
    tc.setLeft('a.c', bigFile(50000))
    tc.setRight('b.c', bigFile(50000, true))

    tc._contentLeft.scrollTop = 400000
    tc._renderVisibleRows()
    const rendered = tc._contentLeft.querySelector('.tc-vs-spacer').children.length
    expect(rendered).toBeLessThan(120)
    expect(tc._totalRows).toBeGreaterThan(1000)
  })

  it('grammar ignore over a 50k-line file stays responsive', () => {
    const tc = makeTC()
    tc.setLeft('a.c', bigFile(50000))
    tc.setRight('b.c', bigFile(50000, true))
    const t0 = Date.now()
    tc.setGrammarIgnore(['Comment'])
    expect(Date.now() - t0).toBeLessThan(30000)
    expect(tc.getGrammarInfo().ignored).toEqual(['Comment'])
  })

  it('a pathologically long single line does not hang the view', () => {
    const tc = makeTC()
    const long = 'a'.repeat(400000)
    tc.setLeft('a.c', `${long}X\n`)
    tc.setRight('b.c', `${long}Y\n`)
    const t0 = Date.now()
    tc.setGrammarIgnore(['Comment', 'String'])
    expect(Date.now() - t0).toBeLessThan(10000)
    // The bound was hit, and the view says so rather than pretending.
    expect(tc.getGrammarInfo().truncated).toBe(true)
  })
})

// ── Config round trip ────────────────────────────────────────────────────────

describe('config round trip', () => {
  it('carries grammar, panels, font and locks', () => {
    const tc = makeTC()
    tc.setLeft('a.c', 'int x; // a\n')
    tc.setRight('b.c', 'int x; // b\n')
    tc.setGrammarIgnore(['Comment'])
    tc.toggleRuler(true)
    tc.toggleFileInfo(true)
    tc.setDetailsMode('alignment')
    tc.setFontFamily("'Courier New', monospace")
    tc.setSideReadOnly('right', true)
    tc.setDescription('說明')

    const cfg = tc.getConfig()
    const tc2 = makeTC()
    tc2.setLeft('a.c', 'int x; // a\n')
    tc2.setRight('b.c', 'int x; // b\n')
    tc2.applyConfig(cfg)

    expect([...tc2._grammarIgnored]).toEqual(['Comment'])
    expect(tc2._showRuler).toBe(true)
    expect(tc2._showFileInfo).toBe(true)
    expect(tc2.getDetailsMode()).toBe('alignment')
    expect(tc2.getFontFamily()).toBe("'Courier New', monospace")
    expect(tc2.isSideReadOnly('right')).toBe(true)
    expect(tc2.getDescription()).toBe('說明')
    expect(tc2._diffResult[0].unimportant).toBe(true)
  })

  it('a user grammar registered through the config drives the comparison', () => {
    const tc = makeTC()
    tc.applyConfig({
      __v: 1, __view: 'text',
      userGrammars: [{
        name: 'INI', masks: ['*.ini'],
        items: [{ type: 'delimited', element: 'Comment', start: ';', stopAtEol: true }],
      }],
      grammarIgnore: ['Comment'],
    })
    tc.setLeft('a.ini', 'key=1 ; old\n')
    tc.setRight('b.ini', 'key=1 ; new\n')
    expect(tc.getGrammarInfo().left).toBe('INI')
    expect(tc._diffResult[0].unimportant).toBe(true)
  })
})
