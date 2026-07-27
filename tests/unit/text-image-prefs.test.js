/**
 * @vitest-environment jsdom
 *
 * @file text-image-prefs.test.js
 * Three Options-dialog preferences that stored a value nobody read back:
 * `editTrimOnSave`, `editEnsureFinalNewline` (Options ▸ Editor) and
 * `pictureTolerance` (Options ▸ Picture).
 *
 * The pure-helper blocks pin the transforms; the blocks that drive `saveLeft`
 * / `saveRight` and `setTolerance` are the ones that pin the *wiring*, and
 * they are what fails if the reads are taken back out.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

Object.defineProperty(globalThis, 'window', {
  value: globalThis,
  writable: true,
})
globalThis.window.electronAPI = {
  openFile: vi.fn(), saveFile: vi.fn(), readFile: vi.fn(),
  watchFile: vi.fn(), unwatchFile: vi.fn(), onFileChanged: vi.fn(),
}

const { TextCompare, trimTrailingWhitespace, ensureFinalNewline } =
  await import('../../src/renderer/src/views/text-compare.js')
const { ImageCompare } = await import('../../src/renderer/src/views/image-compare.js')
const { SettingsStore } = await import('../../src/renderer/src/core/settings-store.js')
const { resetGrammars } = await import('../../src/renderer/src/core/grammar.js')

const settings = new SettingsStore()

/** Build the parts of index.html the text view actually reaches for. */
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
 * @returns {TextCompare}
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
  for (const el of [tc._contentLeft, tc._contentRight]) {
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
  }
  return tc
}

/** The text handed to the `save-file` IPC by the most recent save. */
function writtenText() {
  const calls = window.electronAPI.saveFile.mock.calls
  expect(calls.length).toBe(1)
  return calls[0][1]
}

beforeEach(() => {
  localStorage.clear()
  resetGrammars()
  window.electronAPI.saveFile = vi.fn(async () => ({ ok: true }))
})

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// Defaults must not move
// ---------------------------------------------------------------------------

describe('a user who never opened the Options dialog', () => {
  it('saves the bytes that are in the pane, untouched', async () => {
    const tc = makeTC()
    const messy = 'a  \t\r\nb\t \r\n   \r\nc'
    tc.setLeft('/tmp/a.txt', messy)
    await tc.saveLeft()
    expect(writtenText()).toBe(messy)
    expect(tc.getContent('left')).toBe(messy)
  })

  it('starts an image comparison on the untouched defaults', () => {
    const ic = new ImageCompare({})
    const before = { threshold: ic._threshold, algorithm: ic._algorithm }
    ic.setTolerance(settings.getPref('pictureTolerance'))
    expect(ic._threshold).toBe(before.threshold)
    expect(ic._algorithm).toBe(before.algorithm)
    expect(ic.getTolerance()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 1 — editTrimOnSave
// ---------------------------------------------------------------------------

describe('trimTrailingWhitespace', () => {
  it('strips spaces and tabs mixed in any order', () => {
    expect(trimTrailingWhitespace('a \t \nb\t\t\nc  ')).toBe('a\nb\nc')
  })

  it('leaves leading and interior whitespace alone', () => {
    expect(trimTrailingWhitespace('\tif (x) {  \n\t\ty = 1;\t\n')).toBe('\tif (x) {\n\t\ty = 1;\n')
  })

  it('does not eat the line terminators, CRLF included', () => {
    expect(trimTrailingWhitespace('a  \r\nb\t\r\n')).toBe('a\r\nb\r\n')
    expect(trimTrailingWhitespace('a  \rb\t\r')).toBe('a\rb\r')
  })

  it('blanks a whitespace-only line without deleting it', () => {
    expect(trimTrailingWhitespace('a\n \t \nb\n')).toBe('a\n\nb\n')
  })

  it('handles an empty string and a NUL byte without throwing', () => {
    expect(trimTrailingWhitespace('')).toBe('')
    expect(trimTrailingWhitespace('a\0  \nb')).toBe('a\0\nb')
  })
})

describe('editTrimOnSave wiring', () => {
  it('writes trimmed text and leaves the model agreeing with it', async () => {
    settings.setPref('editTrimOnSave', true)
    const tc = makeTC()
    tc.setLeft('/tmp/a.txt', 'alpha  \nbeta\t\t\ngamma \t \n')
    await tc.saveLeft()
    expect(writtenText()).toBe('alpha\nbeta\ngamma\n')
    // The pane must not still be showing the untrimmed text: the next diff
    // would be computed against a file that no longer exists on disk.
    expect(tc.getContent('left')).toBe('alpha\nbeta\ngamma\n')
  })

  it('applies to the right pane too', async () => {
    settings.setPref('editTrimOnSave', true)
    const tc = makeTC()
    tc.setRight('/tmp/b.txt', 'x \t\ny  \n')
    await tc.saveRight()
    expect(writtenText()).toBe('x\ny\n')
    expect(tc.getContent('right')).toBe('x\ny\n')
  })

  it('preserves CRLF while trimming', async () => {
    settings.setPref('editTrimOnSave', true)
    const tc = makeTC()
    tc.setLeft('/tmp/a.txt', 'one  \r\ntwo\t\r\n')
    await tc.saveLeft()
    expect(writtenText()).toBe('one\r\ntwo\r\n')
  })

  it('stays off when the preference is false', async () => {
    settings.setPref('editTrimOnSave', false)
    const tc = makeTC()
    tc.setLeft('/tmp/a.txt', 'alpha  \n')
    await tc.saveLeft()
    expect(writtenText()).toBe('alpha  \n')
  })
})

// ---------------------------------------------------------------------------
// 2 — editEnsureFinalNewline
// ---------------------------------------------------------------------------

describe('ensureFinalNewline', () => {
  it('appends in the file’s own line ending', () => {
    expect(ensureFinalNewline('a', 'LF')).toBe('a\n')
    expect(ensureFinalNewline('a', 'CRLF')).toBe('a\r\n')
    expect(ensureFinalNewline('a', 'CR')).toBe('a\r')
    expect(ensureFinalNewline('a')).toBe('a\n')
  })

  it('does not add a second one when the file already ends in a newline', () => {
    expect(ensureFinalNewline('a\n', 'LF')).toBe('a\n')
    expect(ensureFinalNewline('a\r\n', 'CRLF')).toBe('a\r\n')
    expect(ensureFinalNewline('a\r', 'CR')).toBe('a\r')
    // A mismatched-but-present terminator is still a terminator; rewriting it
    // would convert the file's line endings, which is a different command.
    expect(ensureFinalNewline('a\n', 'CRLF')).toBe('a\n')
  })

  it('leaves an empty file empty', () => {
    expect(ensureFinalNewline('', 'LF')).toBe('')
    expect(ensureFinalNewline('', 'CRLF')).toBe('')
  })

  it('keeps trailing blank lines, which are content rather than formatting', () => {
    expect(ensureFinalNewline('a\n\n\n', 'LF')).toBe('a\n\n\n')
  })
})

describe('editEnsureFinalNewline wiring', () => {
  it('adds the missing newline and the model agrees', async () => {
    settings.setPref('editEnsureFinalNewline', true)
    const tc = makeTC()
    tc.setLeft('/tmp/a.txt', 'alpha\nbeta')
    await tc.saveLeft()
    expect(writtenText()).toBe('alpha\nbeta\n')
    expect(tc.getContent('left')).toBe('alpha\nbeta\n')
  })

  it('does not add a second newline to a file that already ends in one', async () => {
    settings.setPref('editEnsureFinalNewline', true)
    const tc = makeTC()
    tc.setLeft('/tmp/a.txt', 'alpha\nbeta\n')
    await tc.saveLeft()
    expect(writtenText()).toBe('alpha\nbeta\n')
  })

  it('uses CRLF for a CRLF file rather than a hardcoded \\n', async () => {
    settings.setPref('editEnsureFinalNewline', true)
    const tc = makeTC()
    tc.setLeft('/tmp/a.txt', 'alpha\r\nbeta')
    expect(tc._eolLeft).toBe('CRLF')
    await tc.saveLeft()
    expect(writtenText()).toBe('alpha\r\nbeta\r\n')
  })

  it('uses CR for a CR file', async () => {
    settings.setPref('editEnsureFinalNewline', true)
    const tc = makeTC()
    tc.setRight('/tmp/b.txt', 'alpha\rbeta\rgamma')
    expect(tc._eolRight).toBe('CR')
    await tc.saveRight()
    expect(writtenText()).toBe('alpha\rbeta\rgamma\r')
  })

  it('leaves a completely empty file empty', async () => {
    settings.setPref('editEnsureFinalNewline', true)
    const tc = makeTC()
    // saveLeft refuses an empty document outright, so the transform is
    // checked where it is reachable: an empty right pane behind a real save.
    tc.setRight('/tmp/b.txt', 'seed\n')
    tc._rightContent = ''
    await tc.saveRight()
    // Nothing was written because there is nothing to write, and above all no
    // newline was manufactured for a zero-byte file.
    expect(tc.getContent('right')).toBe('')
    expect(ensureFinalNewline(tc.getContent('right'), tc._eolRight)).toBe('')
  })

  it('stays off when the preference is false', async () => {
    settings.setPref('editEnsureFinalNewline', false)
    const tc = makeTC()
    tc.setLeft('/tmp/a.txt', 'alpha\nbeta')
    await tc.saveLeft()
    expect(writtenText()).toBe('alpha\nbeta')
  })
})

describe('both editor preferences together', () => {
  it('trims first, then terminates, in the file’s line ending', async () => {
    settings.setPref('editTrimOnSave', true)
    settings.setPref('editEnsureFinalNewline', true)
    const tc = makeTC()
    tc.setLeft('/tmp/a.txt', 'alpha  \r\nbeta\t  ')
    await tc.saveLeft()
    expect(writtenText()).toBe('alpha\r\nbeta\r\n')
    expect(tc.getContent('left')).toBe('alpha\r\nbeta\r\n')
  })

  it('commits a keystroke still sitting in the edit textarea', async () => {
    settings.setPref('editTrimOnSave', true)
    const tc = makeTC()
    tc.setLeft('/tmp/a.txt', 'old\n')
    // Simulate the 300ms debounce being in flight when Ctrl+S lands.
    tc._editMode = true
    tc._textareaLeft = /** @type {HTMLTextAreaElement} */ (
      document.createElement('textarea'))
    tc._textareaLeft.value = 'typed   \n'
    tc._editTimerLeft = setTimeout(() => { tc._leftContent = 'typed   \n' }, 300)
    await tc.saveLeft()
    expect(writtenText()).toBe('typed\n')
    expect(tc.getContent('left')).toBe('typed\n')
    expect(tc._textareaLeft.value).toBe('typed\n')
  })
})

// ---------------------------------------------------------------------------
// 3 — pictureTolerance
// ---------------------------------------------------------------------------

describe('pictureTolerance wiring', () => {
  it('supplies the starting tolerance a new comparison uses', () => {
    settings.setPref('pictureTolerance', 51)
    const ic = new ImageCompare({})
    ic.setTolerance(settings.getPref('pictureTolerance'))
    // The dialog states 0-255; the view carries 0-1 and diffCutoff scales it
    // back up, so the effective cutoff is the number the user typed.
    expect(ic._threshold).toBeCloseTo(51 / 255, 10)
    expect(ic._algorithm).toBe('tolerance')
    expect(ic.getTolerance()).toBeCloseTo(51, 10)
  })

  it('does not break the toolbar slider, which still owns the threshold', () => {
    const ic = new ImageCompare({})
    ic.setTolerance(51)
    ic.mount(document.createElement('div'))
    const slider = /** @type {HTMLInputElement} */ (ic._dom.thresholdSlider)
    // The slider is built showing the supplied value...
    expect(parseFloat(slider.value)).toBeCloseTo(51 / 255, 6)
    // ...and dragging it still wins.
    slider.value = '0.4'
    slider.dispatchEvent(new Event('input'))
    expect(ic._threshold).toBeCloseTo(0.4, 10)
    ic.destroy?.()
  })

  it('reflects a later call onto an already-mounted slider', () => {
    const ic = new ImageCompare({})
    ic.mount(document.createElement('div'))
    ic.setTolerance(102)
    const slider = /** @type {HTMLInputElement} */ (ic._dom.thresholdSlider)
    expect(parseFloat(slider.value)).toBeCloseTo(102 / 255, 6)
    ic.destroy?.()
  })

  it('rejects an empty field rather than reading it as a deliberate zero', () => {
    const ic = new ImageCompare({})
    ic.setTolerance(64)
    const kept = ic._threshold
    // Number('') is 0 and 0 is finite, so emptiness has to be checked first.
    for (const bad of ['', null, undefined, NaN, 'abc', -1, 256, Infinity]) {
      ic.setTolerance(bad)
      expect(ic._threshold).toBe(kept)
      expect(ic._algorithm).toBe('tolerance')
    }
  })

  it('treats 0 as "exact", the behaviour that has always been the default', () => {
    const ic = new ImageCompare({})
    ic.setTolerance(0)
    expect(ic._algorithm).toBe('exact')
    expect(ic._threshold).toBe(0.1)
  })
})
