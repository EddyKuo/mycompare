/**
 * @vitest-environment jsdom
 *
 * The menu's list of text edit commands matches the view's own table.
 *
 * The view generates its keyboard handler and its context menu from one table,
 * so those two cannot drift apart. The native menu is built in the main process
 * before any view exists, so it cannot read that table and keeps a list
 * instead — exactly the kind of second copy that goes stale unnoticed. This is
 * what makes keeping the copy safe.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { TextCompare } from '../../src/renderer/src/views/text-compare.js'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const APP = read('../../src/renderer/src/app.js')
const MENU = read('../../src/main/menu.js')

/** The ids app.js generates menu handlers for. */
function listedIds() {
  const block = /TEXT_EDIT_COMMAND_IDS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(APP)
  if (!block) return []
  return [...block[1].matchAll(/'([\w.]+)'/g)].map((m) => m[1])
}

/**
 * The commands the view actually implements.
 *
 * `editCommands()` is a description of the table, not a live UI binding, so it
 * needs no mounted DOM — which keeps this test about the lists rather than
 * about reproducing index.html.
 */
function viewCommands() {
  return new TextCompare().editCommands()
}

describe('text edit commands', () => {
  it('finds both lists at all', () => {
    // Either list coming back empty would make every comparison below vacuous.
    expect(listedIds().length).toBeGreaterThan(15)
    expect(viewCommands().length).toBeGreaterThan(15)
  })

  it('lists exactly the commands the view implements', () => {
    // A command added to the view with no menu entry is unreachable from the
    // menu bar; one listed with no implementation dispatches to nothing.
    const view = viewCommands().map((c) => c.id).sort()
    expect([...listedIds()].sort()).toEqual(view)
  })

  it('gives every listed command a menu item', () => {
    const inMenu = new Set(
      [...MENU.matchAll(/item\(\s*'[^']*'\s*,\s*'([^']+)'/g)].map((m) => m[1]))
    expect(listedIds().filter((id) => !inMenu.has(id))).toEqual([])
  })

  it('binds each command to a distinct shortcut', () => {
    // Two commands sharing a combo means the later binding silently wins, and
    // one menu item never does what its accelerator advertises.
    const combos = viewCommands().map((c) => c.combo).filter(Boolean)
    expect(combos.length).toBeGreaterThan(15)
    expect(new Set(combos).size).toBe(combos.length)
  })

  it('gives every command a label, so the menu can never show a blank row', () => {
    for (const c of viewCommands()) {
      expect(typeof c.label === 'string' && c.label.length > 0, c.id).toBe(true)
    }
  })
})
