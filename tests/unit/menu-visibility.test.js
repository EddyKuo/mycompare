/**
 * Hiding a command must also hide it in the menu bar.
 *
 * Per-command visibility used to stop at the toolbar: the button disappeared
 * and the menu item stayed, so the preference looked broken rather than
 * scoped. Removing the item is only half of it — an emptied submenu and the
 * separators left stranded around a removed item are visible damage.
 *
 * `buildAppMenu` installs a real menu, so the pruning is tested through the
 * template Electron is asked to build rather than through the built menu.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** @type {import('electron').MenuItemConstructorOptions[]} */
let lastTemplate = []

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (t) => { lastTemplate = t; return { items: t } },
    setApplicationMenu: () => {},
  },
  shell: { openExternal: () => Promise.resolve() },
  app: { name: 'MyCompare' },
}))

const { buildAppMenu } = await import('../../src/main/menu.js')

/** A window stub that records nothing; the menu only needs it to exist. */
const win = { isDestroyed: () => false, webContents: { send: () => {} } }

/**
 * Every command id in a template, at any depth.
 * @param {import('electron').MenuItemConstructorOptions[]} items
 * @returns {string[]}
 */
function idsIn(items) {
  const out = []
  for (const it of items) {
    if (typeof it.id === 'string') out.push(it.id)
    if (Array.isArray(it.submenu)) out.push(...idsIn(it.submenu))
  }
  return out
}

/**
 * Every submenu in a template, as flat arrays.
 * @param {import('electron').MenuItemConstructorOptions[]} items
 * @returns {import('electron').MenuItemConstructorOptions[][]}
 */
function submenusIn(items) {
  const out = [items]
  for (const it of items) {
    if (Array.isArray(it.submenu)) out.push(...submenusIn(it.submenu))
  }
  return out
}

beforeEach(() => { lastTemplate = [] })

describe('buildAppMenu without hidden commands', () => {
  it('carries a command id on every command item', () => {
    // The ids are what visibility matches on; without them nothing can be
    // hidden and the feature would silently do nothing.
    buildAppMenu(win)
    expect(idsIn(lastTemplate).length).toBeGreaterThan(30)
  })

  it('includes the ids the settings UI offers to hide', () => {
    buildAppMenu(win)
    const ids = new Set(idsIn(lastTemplate))
    for (const id of ['search.nextDiff', 'search.prevDiff', 'session.new']) {
      expect(ids.has(id)).toBe(true)
    }
  })
})

describe('buildAppMenu with hidden commands', () => {
  it('removes exactly the hidden ids and leaves the rest', () => {
    buildAppMenu(win, ['search.nextDiff'])
    const ids = idsIn(lastTemplate)
    expect(ids).not.toContain('search.nextDiff')
    expect(ids).toContain('search.prevDiff')
  })

  it('leaves the menu untouched when nothing is hidden', () => {
    buildAppMenu(win)
    const before = idsIn(lastTemplate)
    buildAppMenu(win, [])
    expect(idsIn(lastTemplate)).toEqual(before)
  })

  it('ignores an id that is not in the menu', () => {
    buildAppMenu(win)
    const before = idsIn(lastTemplate)
    buildAppMenu(win, ['no.such.command'])
    expect(idsIn(lastTemplate)).toEqual(before)
  })

  it('never leaves a separator leading, trailing, or doubled', () => {
    // Hide a broad slice so removals land next to separators somewhere.
    buildAppMenu(win)
    const all = idsIn(lastTemplate)
    buildAppMenu(win, all.filter((_, i) => i % 2 === 0))

    for (const menu of submenusIn(lastTemplate)) {
      if (menu.length === 0) continue
      expect(menu[0].type).not.toBe('separator')
      expect(menu[menu.length - 1].type).not.toBe('separator')
      for (let i = 1; i < menu.length; i++) {
        const doubled = menu[i].type === 'separator' && menu[i - 1].type === 'separator'
        expect(doubled).toBe(false)
      }
    }
  })

  it('drops a submenu that hiding emptied rather than leaving a dead heading', () => {
    // The algorithm submenu holds three commands and nothing else, so hiding
    // all three must take the heading with it.
    buildAppMenu(win)
    const algos = ['tools.algorithm.myers', 'tools.algorithm.patience', 'tools.algorithm.histogram']
    expect(idsIn(lastTemplate)).toEqual(expect.arrayContaining(algos))

    buildAppMenu(win, algos)
    const stillThere = submenusIn(lastTemplate)
      .some((m) => m.some((it) => it.label === '比對演算法'))
    expect(stillThere).toBe(false)
  })

  it('keeps a submenu that still has commands', () => {
    buildAppMenu(win, ['tools.algorithm.myers'])
    const algoMenu = lastTemplate
      .flatMap((it) => (Array.isArray(it.submenu) ? it.submenu : []))
      .find((it) => it.label === '比對演算法')
    expect(algoMenu).toBeTruthy()
    expect(idsIn(algoMenu.submenu)).toEqual(
      ['tools.algorithm.patience', 'tools.algorithm.histogram'])
  })
})

describe('every menuId the settings UI stores actually exists in the menu', () => {
  it('has no menuId pointing at a command the menu does not have', async () => {
    // A menuId that matches nothing hides nothing, and the failure is silent:
    // the toolbar button disappears, the menu item stays, and the preference
    // looks half-implemented. `session.new` was exactly that — the menu has
    // the six per-type entries, never a single `session.new`.
    const { TOOLBAR_COMMANDS } = await import('../../src/renderer/src/core/settings-store.js')
    buildAppMenu(win)
    const present = new Set(idsIn(lastTemplate))
    const missing = TOOLBAR_COMMANDS
      .filter((c) => c.menuId && !present.has(c.menuId))
      .map((c) => `${c.id} → ${c.menuId}`)
    expect(missing).toEqual([])
  })

  it('hiding the new-session command removes the whole chooser group', () => {
    buildAppMenu(win, ['session.new'])
    const ids = idsIn(lastTemplate)
    expect(ids).not.toContain('session.new.text')
    expect(ids).not.toContain('session.new.merge3')
  })
})
