/**
 * A menu command drives the window the user is looking at.
 *
 * The menu is application-global, but the template is built bound to one
 * BrowserWindow and its click handlers captured that window. With a single
 * window that is indistinguishable from correct. With two, every menu command
 * would drive whichever window was created first: the focused one would appear
 * to ignore its own menu while another silently acted on it.
 *
 * The existing menu tests only build the template and read it — they never
 * invoke a click handler, so nothing here was covered. That is also why the
 * electron mock they use omits BrowserWindow entirely.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** @type {Array<{ id: number, sent: Array<{command: string}> , destroyed: boolean }>} */
let windows = []
/** @type {number|null} */
let focusedId = null

function makeWindow(id) {
  const w = {
    id,
    sent: [],
    destroyed: false,
    isDestroyed: () => w.destroyed,
    webContents: { send: (_channel, msg) => w.sent.push(msg) },
  }
  windows.push(w)
  return w
}

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (t) => ({ items: t }),
    setApplicationMenu: () => {},
  },
  BrowserWindow: {
    getFocusedWindow: () => windows.find((w) => w.id === focusedId) ?? null,
  },
  shell: { openExternal: () => Promise.resolve() },
  app: { name: 'MyCompare' },
}))

const { buildAppMenu } = await import('../../src/main/menu.js')

/** Every click-bearing item in a template, flattened. */
function clickable(items, out = []) {
  for (const it of items ?? []) {
    if (typeof it.click === 'function') out.push(it)
    if (Array.isArray(it.submenu)) clickable(it.submenu, out)
  }
  return out
}

beforeEach(() => {
  windows = []
  focusedId = null
})

describe('menu command routing', () => {
  it('sends to the focused window, not the one the menu was built with', () => {
    const first = makeWindow(1)
    const second = makeWindow(2)

    let template = []
    const orig = buildAppMenu(first)
    template = orig?.items ?? []
    const items = clickable(template)
    expect(items.length, 'no clickable menu items found').toBeGreaterThan(5)

    focusedId = 2
    items[0].click()

    expect(second.sent.length, 'the focused window got nothing').toBe(1)
    expect(first.sent.length, 'the bound window was driven instead').toBe(0)
  })

  it('falls back to the bound window when nothing is focused', () => {
    // Clicking a menu item with no focused window is reachable on macOS, where
    // the menu bar stays live with every window closed or minimised.
    const only = makeWindow(1)
    const items = clickable(buildAppMenu(only)?.items ?? [])
    focusedId = null
    items[0].click()
    expect(only.sent.length).toBe(1)
  })

  it('does not send to a destroyed focused window', () => {
    const first = makeWindow(1)
    const second = makeWindow(2)
    const items = clickable(buildAppMenu(first)?.items ?? [])

    focusedId = 2
    second.destroyed = true
    items[0].click()

    // Falls back rather than throwing on a window mid-teardown.
    expect(second.sent.length).toBe(0)
    expect(first.sent.length).toBe(1)
  })

  it('sends the command the item names', () => {
    const win = makeWindow(1)
    const items = clickable(buildAppMenu(win)?.items ?? [])
    focusedId = 1
    const withId = items.find((it) => typeof it.id === 'string' && it.id)
    expect(withId, 'no item carries an id').toBeTruthy()
    withId.click()
    expect(win.sent[0].command).toBe(withId.id)
  })
})
