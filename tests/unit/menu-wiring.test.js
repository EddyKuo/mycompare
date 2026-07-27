/**
 * Every menu item reaches something.
 *
 * This project has repeatedly shipped features whose implementation was
 * complete and whose entry point was missing, and a menu item that dispatches
 * an id nobody handles is the purest form of it: the item is visible, clicking
 * it does nothing, and no error is raised anywhere.
 *
 * The check is textual rather than behavioural because the two sides live in
 * different processes — menu.js runs in main, the dispatch table in the
 * renderer — so nothing at runtime ever compares them. That is exactly why
 * they drift.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

const MENU = read('../../src/main/menu.js')
const APP = read('../../src/renderer/src/app.js')

/** Ids passed to the menu's `item(label, id, accelerator?)` helper. */
function menuIds() {
  return [...MENU.matchAll(/item\(\s*'[^']*'\s*,\s*'([^']+)'/g)].map((m) => m[1])
}

/**
 * Quoted keys of the renderer's dispatch table.
 *
 * Segments admit `-` and `_` because the encoding commands carry the encoding
 * name verbatim (`file.encoding.left.Shift_JIS`, `…windows-1252`).
 */
function dispatchIds() {
  return [...APP.matchAll(/'([a-z][\w-]*(?:\.[\w-]+)+)'\s*:/g)].map((m) => m[1])
}

describe('menu wiring', () => {
  it('finds the menu items at all, so a rename cannot make this test vacuous', () => {
    // Without this, a change to the item() signature would leave the test
    // passing over an empty list and reporting that everything is wired.
    expect(menuIds().length).toBeGreaterThan(50)
  })

  it('has a dispatch entry for every menu id', () => {
    const handled = new Set(dispatchIds())
    const missing = menuIds().filter((id) => !handled.has(id))
    expect(missing).toEqual([])
  })

  it('has no duplicate menu ids', () => {
    // Two items sharing an id means one of them does not do what its label says.
    const ids = menuIds()
    const seen = new Set()
    const dupes = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)))
    expect(dupes).toEqual([])
  })

  it('registers no accelerators in the menu itself', () => {
    // Accelerators are shown as hints only; the renderer owns keystrokes via
    // SettingsStore so they stay user-customisable. A menu that registered
    // them too would fire both handlers for one press.
    expect(MENU).toMatch(/registerAccelerator:\s*false/)
  })
})
