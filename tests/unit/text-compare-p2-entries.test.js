/**
 * @vitest-environment jsdom
 *
 * Every P2 text-compare feature must be reachable. "Implemented but with no
 * caller" is this project's most repeated defect, so each new capability gets
 * an assertion that a user can actually get to it — the context menu entry
 * exists, and invoking it does the thing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TextCompare } from '../../src/renderer/src/views/text-compare.js'

/** Captures what the view passes to showContextMenu. */
const menuCalls = []
vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: (_e, items) => { menuCalls.push(items) },
  closeContextMenu: () => {},
}))

beforeEach(() => {
  menuCalls.length = 0
  document.body.innerHTML = ''
  window.electronAPI = {
    showInExplorer: vi.fn().mockResolvedValue(undefined),
    openWith: vi.fn().mockResolvedValue({ opened: true }),
    readFile: vi.fn(),
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
    onFileChanged: vi.fn(),
  }
})

/** @returns {TextCompare} */
function makeText() {
  const tc = new TextCompare()
  tc._mounted = true
  const l = document.createElement('div')
  const r = document.createElement('div')
  document.body.append(l, r)
  tc._contentLeft = l
  tc._contentRight = r
  tc._compareArea = document.createElement('div')
  tc.setLeft('C:/tmp/a.txt', 'one\ntwo\n')
  tc.setRight('C:/tmp/b.txt', 'one\nthree\n')
  return tc
}

/**
 * @param {TextCompare} tc
 * @returns {Array<{ label?: string, action?: Function, disabled?: boolean }>}
 */
function menu(tc) {
  tc._handleContextMenu(new MouseEvent('contextmenu'), 'left')
  return menuCalls.at(-1) ?? []
}

/**
 * @param {Array<{ label?: string }>} items
 * @param {string} needle
 */
function find(items, needle) {
  return items.find((i) => typeof i.label === 'string' && i.label.includes(needle))
}

describe('P2 features are reachable from the context menu', () => {
  it('offers every new entry', () => {
    const items = menu(makeText())
    for (const label of [
      '文字比對資訊',
      '檔案格式',
      '不重要文字規則',
      '對齊選項',
      '語法高亮',
      '單側獨有的行一律視為重要',
      '空白：忽略行尾',
      '跳至編號書籤',
    ]) {
      expect(find(items, label), `missing entry: ${label}`).toBeTruthy()
    }
  })

  it('the syntax highlighting entry toggles and shows its state', () => {
    const tc = makeText()
    expect(find(menu(tc), '語法高亮').label.startsWith('✓')).toBe(true)
    find(menu(tc), '語法高亮').action()
    expect(tc.syntaxHighlighting).toBe(false)
    expect(find(menu(tc), '語法高亮').label.startsWith('✓')).toBe(false)
  })

  it('the orphan entry toggles the option', () => {
    const tc = makeText()
    find(menu(tc), '單側獨有的行一律視為重要').action()
    expect(tc._opts.orphansAlwaysImportant).toBe(true)
  })

  it('the whitespace entries are a radio group with exactly one tick', () => {
    const tc = makeText()
    const ticked = () => menu(tc).filter(
      (i) => typeof i.label === 'string' && i.label.includes('空白：') && i.label.startsWith('✓'))
    expect(ticked()).toHaveLength(1)
    expect(ticked()[0].label).toContain('完全比對')
    find(menu(tc), '空白：忽略行尾').action()
    expect(ticked()).toHaveLength(1)
    expect(ticked()[0].label).toContain('忽略行尾')
  })

  it('the dialog entries actually open a dialog', () => {
    for (const label of ['文字比對資訊', '檔案格式', '不重要文字規則', '對齊選項']) {
      document.body.innerHTML = ''
      const tc = makeText()
      find(menu(tc), label).action()
      expect(document.querySelector('dialog'), `no dialog for ${label}`).toBeTruthy()
    }
  })

  it('the numbered-bookmark entry is disabled with no bookmarks and enabled with them', () => {
    const tc = makeText()
    expect(find(menu(tc), '跳至編號書籤').disabled).toBe(true)
    tc._bookmarks.add(2)
    const entry = find(menu(tc), '跳至編號書籤')
    expect(entry.disabled).toBe(false)
    expect(entry.label).toContain('共 1 個')
  })
})

/**
 * mount() wires these two maps to document keydown after an isActive() guard;
 * the maps themselves are separate methods so the bindings can be driven here
 * without index.html.
 */
describe('P2 keyboard entries', () => {
  /**
   * @param {Partial<KeyboardEventInit>} init
   * @returns {KeyboardEvent}
   */
  const key = (init) => new KeyboardEvent('keydown', { cancelable: true, ...init })

  it('Ctrl+1..9 reaches the Nth bookmark', () => {
    const tc = makeText()
    const spy = vi.spyOn(tc, 'gotoBookmark').mockReturnValue(true)
    tc._handleBookmarkKey(key({ key: '3', ctrlKey: true }))
    expect(spy).toHaveBeenCalledWith(3)
  })

  it('Ctrl+Shift+1 is not a bookmark jump', () => {
    const tc = makeText()
    const spy = vi.spyOn(tc, 'gotoBookmark').mockReturnValue(true)
    tc._handleBookmarkKey(key({ key: '1', ctrlKey: true, shiftKey: true }))
    tc._handleBookmarkKey(key({ key: '1', ctrlKey: true, altKey: true }))
    tc._handleBookmarkKey(key({ key: '1' }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+I / F / L open the three new dialogs', () => {
    const tc = makeText()
    const info = vi.spyOn(tc, 'openInfoDialog').mockImplementation(() => {})
    const fmt = vi.spyOn(tc, 'openFileFormatDialog').mockImplementation(() => {})
    const align = vi.spyOn(tc, 'openAlignmentDialog').mockImplementation(() => {})
    tc._handleTextGapKey(key({ key: 'I', ctrlKey: true, shiftKey: true }))
    tc._handleTextGapKey(key({ key: 'F', ctrlKey: true, shiftKey: true }))
    tc._handleTextGapKey(key({ key: 'L', ctrlKey: true, shiftKey: true }))
    expect(info).toHaveBeenCalledOnce()
    expect(fmt).toHaveBeenCalledOnce()
    expect(align).toHaveBeenCalledOnce()
  })

  it('plain Ctrl+I still toggles the manual ignore mark, not the info dialog', () => {
    const tc = makeText()
    const info = vi.spyOn(tc, 'openInfoDialog').mockImplementation(() => {})
    const ignore = vi.spyOn(tc, 'toggleIgnoreSelection').mockImplementation(() => {})
    tc._handleTextGapKey(key({ key: 'i', ctrlKey: true }))
    expect(ignore).toHaveBeenCalledOnce()
    expect(info).not.toHaveBeenCalled()
  })
})
