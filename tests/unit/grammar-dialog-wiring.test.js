/**
 * The Grammar dialog is markup in one file and behaviour in another.
 *
 * Nothing at runtime compares them: `el('btn-grammar-item-up')` returning null
 * makes the button silently absent, which is exactly the failure mode this
 * project keeps shipping — a complete implementation with no reachable entry
 * point. So the two sides are compared textually here, and the new View-menu
 * dispatch ids are pinned so a rename cannot quietly orphan a menu item.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

const APP = read('../../src/renderer/src/app.js')
const HTML = read('../../src/renderer/index.html')

/** Ids the renderer looks up that belong to the grammar dialog. */
function grammarIdsUsedByApp() {
  const ids = new Set()
  for (const m of APP.matchAll(/\b(?:el|setDisabled)\(\s*'([^']*grammar[^']*)'/g)) ids.add(m[1])
  return [...ids]
}

/** Ids declared in the markup. */
function htmlIds() {
  return new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
}

describe('grammar dialog wiring', () => {
  it('looks up a non-trivial number of ids, so this test cannot go vacuous', () => {
    expect(grammarIdsUsedByApp().length).toBeGreaterThan(20)
  })

  it('every id the dialog code looks up exists in the markup', () => {
    const declared = htmlIds()
    const missing = grammarIdsUsedByApp().filter((id) => !declared.has(id))
    expect(missing).toEqual([])
  })

  it('declares each dialog id exactly once', () => {
    // A duplicate id makes getElementById return whichever came first, so half
    // the dialog would read and write a different element than it renders.
    const all = [...HTML.matchAll(/\bid="([^"]*grammar[^"]*)"/g)].map((m) => m[1])
    const seen = new Set()
    const dupes = all.filter((id) => (seen.has(id) ? true : (seen.add(id), false)))
    expect(dupes).toEqual([])
  })

  it('marks every per-item option so the editor can hide the inapplicable ones', () => {
    // `columns` items have no case/regex/whole-word semantics; showing those
    // checkboxes would offer settings the compiler ignores.
    for (const opt of ['matchCase', 'regex', 'wholeWord']) {
      expect(HTML).toContain(`data-opt="${opt}"`)
    }
    for (const type of ['basic', 'delimited', 'list', 'columns', 'lines']) {
      expect(HTML).toContain(`data-for="${type}"`)
    }
  })
})

/**
 * View-menu commands added alongside the dialog. menu.js supplies the items;
 * this pins the renderer half so the two can be added in either order without
 * one of them silently going missing.
 */
const NEW_DISPATCH_IDS = [
  'tools.grammar',
  'view.text.details.text',
  'view.text.details.hex',
  'view.text.details.alignment',
  'view.text.details.off',
  'view.text.ruler',
  'view.text.fileInfo',
  'view.text.description',
  'view.text.readOnly.left',
  'view.text.readOnly.right',
  'view.text.font.default',
  'view.text.font.consolas',
  'view.text.font.cascadia',
  'view.text.font.fira',
  'view.text.font.courier',
  'view.text.font.jetbrains',
  'view.hex.details',
  'view.hex.fileInfo',
  'view.hex.ruler',
  'view.table.details',
  'view.table.fileInfo',
  'view.table.whitespace',
]

describe('view-menu dispatch entries', () => {
  it('has a handler for every id', () => {
    const handled = new Set(
      [...APP.matchAll(/'([a-z][\w-]*(?:\.[\w-]+)+)'\s*:/g)].map((m) => m[1]),
    )
    expect(NEW_DISPATCH_IDS.filter((id) => !handled.has(id))).toEqual([])
  })

  it('covers one font command per FONT_CHOICES entry', () => {
    // The handlers index into FONT_CHOICES, so an entry added to that array
    // without a command here would be unreachable from the menu.
    const text = read('../../src/renderer/src/views/text-compare.js')
    const block = /export const FONT_CHOICES = \[([\s\S]*?)\];/.exec(text)?.[1] ?? ''
    const count = [...block.matchAll(/\{\s*label:/g)].length
    expect(count).toBeGreaterThan(0)
    expect(NEW_DISPATCH_IDS.filter((id) => id.startsWith('view.text.font.'))).toHaveLength(count)
  })
})
