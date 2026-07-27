/**
 * @vitest-environment jsdom
 *
 * A detected encoding that is only a guess has to say so.
 *
 * `decodeBuffer` has always returned a confidence, and the main process even
 * documents it as travelling "so the view can mark a guess as a guess". Nothing
 * in the renderer read it. That is this project's recurring defect wearing yet
 * another hat, and it mattered here more than usual: chardet answers for a
 * sample far too short to be sure, and a wrong answer is not an error at decode
 * time — the file opens as 亂碼 with nothing reported as wrong.
 *
 * The status bar now marks a weak detection with '?' and explains it in the
 * tooltip, which is what points the user at the manual override.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TextCompare } from '../../src/renderer/src/views/text-compare.js'
import { isValidUtf8 } from '../../src/main/encoding.js'

vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: () => {},
}))

/** @type {TextCompare[]} */
let views = []

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  views = []
  document.body.innerHTML = ''
})

/**
 * A TextCompare wired to a real DOM, without mount()'s global listeners —
 * the same shape the other text view tests use.
 * @returns {TextCompare}
 */
function mounted() {
  document.body.innerHTML = `
    <div id="status-encoding"></div>
    <div id="view-text">
      <div class="compare-area" id="compare-area">
        <div class="pane" id="pane-left"><div class="pane-content" id="content-left"></div></div>
        <div class="splitter" id="splitter"></div>
        <div class="pane" id="pane-right"><div class="pane-content" id="content-right"></div></div>
        <div class="minimap" id="minimap"><div id="minimap-viewport"></div></div>
      </div>
    </div>`
  const tc = new TextCompare()
  tc._mounted = true
  tc._compareArea = document.getElementById('compare-area')
  tc._contentLeft = document.getElementById('content-left')
  tc._contentRight = document.getElementById('content-right')
  tc._minimap = document.getElementById('minimap')
  tc._minimapViewport = document.getElementById('minimap-viewport')
  tc._statusEncoding = document.getElementById('status-encoding')
  for (const el of [tc._contentLeft, tc._contentRight]) {
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
  }
  views.push(tc)
  return tc
}

const label = () => document.getElementById('status-encoding')?.textContent ?? ''
const tip = () => document.getElementById('status-encoding')?.title ?? ''

describe('a weak detection is shown as a guess', () => {
  it('marks a low-confidence encoding and explains it', () => {
    const tc = mounted()
    tc.setLeft('/a.txt', 'hello\n', 'Big5', 20)
    tc.setRight('/b.txt', 'hello\n', 'Big5', 20)
    expect(label()).toContain('?')
    expect(tip()).not.toBe('')
  })

  it('does not mark a confident detection', () => {
    // Otherwise the marker is decoration: present on everything, meaning
    // nothing, and the one file that deserves attention does not stand out.
    const tc = mounted()
    tc.setLeft('/a.txt', 'hello\n', 'UTF-8', 95)
    tc.setRight('/b.txt', 'hello\n', 'UTF-8', 95)
    expect(label()).toBe('UTF-8')
    expect(tip()).toBe('')
  })

  it('does not mark an encoding the user chose by hand', () => {
    // reloadWithEncoding passes no confidence: the value is not a guess, it is
    // an instruction, and questioning it back at the user would be wrong.
    const tc = mounted()
    tc.setLeft('/a.txt', 'hello\n', 'Shift_JIS')
    tc.setRight('/b.txt', 'hello\n', 'Shift_JIS')
    expect(label()).toBe('Shift_JIS')
    expect(tip()).toBe('')
  })

  it('marks only the side that is uncertain', () => {
    const tc = mounted()
    tc.setLeft('/a.txt', 'hello\n', 'UTF-8', 95)
    tc.setRight('/b.txt', 'hello\n', 'Big5', 10)
    expect(label()).toBe('UTF-8 / Big5?')
  })

  it('treats a zero confidence as "not detected" rather than "least certain"', () => {
    // decodeBuffer returns 0 for the fallback it picks when detection carried
    // no information; rendering that as the shakiest possible guess would be
    // backwards.
    const tc = mounted()
    tc.setLeft('/a.txt', 'hello\n', 'UTF-8', 0)
    tc.setRight('/b.txt', 'hello\n', 'UTF-8', 0)
    expect(label()).toBe('UTF-8')
  })
})

describe('the validator behind the guess', () => {
  it('rejects bytes that are not well-formed UTF-8', () => {
    // The check that makes a wrong chardet answer safe to refuse. Big5 bytes
    // are not valid UTF-8, and decoding them as UTF-8 substitutes U+FFFD
    // rather than failing.
    expect(isValidUtf8(Buffer.from([0xb4, 0xfa, 0xb8, 0xd5]))).toBe(false)
    expect(isValidUtf8(Buffer.from('測試', 'utf-8'))).toBe(true)
  })

  it('rejects overlong forms and lone surrogates', () => {
    expect(isValidUtf8(Buffer.from([0xc0, 0xaf]))).toBe(false)
    expect(isValidUtf8(Buffer.from([0xed, 0xa0, 0x80]))).toBe(false)
  })

  it('rejects a sequence truncated at the end of the buffer', () => {
    expect(isValidUtf8(Buffer.from([0xe6, 0xb8]))).toBe(false)
  })
})
