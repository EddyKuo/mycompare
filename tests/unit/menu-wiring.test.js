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

/**
 * Ids handled by a generated block rather than a literal key.
 *
 * The text edit commands are spread in from one table, so the view's keyboard
 * handler, its context menu and the native menu cannot drift apart. That also
 * means no `'text.deleteLine':` key exists for the scan above to find, so they
 * are read from the id list instead.
 */
function generatedIds() {
  const block = /TEXT_EDIT_COMMAND_IDS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(APP)
  if (!block) return []
  return [...block[1].matchAll(/'([\w.]+)'/g)].map((m) => m[1])
}

describe('menu wiring', () => {
  it('finds the menu items at all, so a rename cannot make this test vacuous', () => {
    // Without this, a change to the item() signature would leave the test
    // passing over an empty list and reporting that everything is wired.
    expect(menuIds().length).toBeGreaterThan(50)
  })

  it('has a dispatch entry for every menu id', () => {
    const handled = new Set([...dispatchIds(), ...generatedIds()])
    const missing = menuIds().filter((id) => !handled.has(id))
    expect(missing).toEqual([])
  })

  it('finds the generated command ids at all', () => {
    // If the id list is renamed, generatedIds() returns nothing and every one
    // of those commands looks unhandled. Asserting it found them keeps the
    // check above from passing for the wrong reason in either direction.
    expect(generatedIds().length).toBeGreaterThan(15)
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
