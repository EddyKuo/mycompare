/**
 * The six BC Options pages, and the invariants that keep them honest.
 *
 * The failure mode a tabbed settings dialog invites is a page that looks
 * complete and writes nothing: a tab with no pane, a control bound to no
 * preference, or a preference in the model that no control reaches. All three
 * leave the dialog looking finished while the setting never moves off its
 * default — which this project has already shipped once, when the Next
 * Difference and backup preferences had readers and no controls.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { DEFAULT_PREFS, PREF_PAGES } from '../../src/renderer/src/core/settings-store.js'

const HTML = readFileSync(new URL('../../src/renderer/index.html', import.meta.url), 'utf-8')
const APP = readFileSync(new URL('../../src/renderer/src/app.js', import.meta.url), 'utf-8')

/** @param {string} dir @returns {string[]} every .js beneath it */
function jsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...jsFiles(full))
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

/** Every renderer and main source, for finding who consumes a preference. */
const SRC = [
  ...jsFiles(fileURLToPath(new URL('../../src/renderer/src', import.meta.url))),
  ...jsFiles(fileURLToPath(new URL('../../src/main', import.meta.url))),
].map((f) => readFileSync(f, 'utf-8'))

/** The six pages this change added, on top of the seven already there. */
const NEW_PAGES = ['folderViews', 'picture', 'textEditing', 'archives', 'openWith', 'tweaks']

describe('every page exists as both a tab and a pane', () => {
  it.each(NEW_PAGES)('%s has a tab', (page) => {
    expect(HTML).toContain(`id="options-tab-${page}"`)
    expect(HTML).toContain(`data-pane="${page}"`)
  })

  it.each(NEW_PAGES)('%s has a pane the tab points at', (page) => {
    expect(HTML).toContain(`id="options-pane-${page}"`)
    expect(HTML).toContain(`aria-controls="options-pane-${page}"`)
  })

  it('every tab in the markup has a matching pane', () => {
    // A tab with no pane opens onto nothing — the sort of thing that survives
    // review because the tab strip looks right.
    const tabs = [...HTML.matchAll(/data-pane="([a-zA-Z]+)"/g)].map((m) => m[1])
    expect(tabs.length).toBeGreaterThanOrEqual(13)
    for (const tab of tabs) {
      expect(HTML).toContain(`id="options-pane-${tab}"`)
    }
  })

  it('every pane is registered in PREF_PAGES so "restore this page" has a scope', () => {
    for (const page of NEW_PAGES) {
      expect(PREF_PAGES[page]).toBeDefined()
      expect(PREF_PAGES[page].length).toBeGreaterThan(0)
    }
  })
})

describe('every preference is reachable and every control is bound', () => {
  it('each new page preference exists in the defaults', () => {
    for (const page of NEW_PAGES) {
      for (const pref of PREF_PAGES[page]) {
        expect(Object.hasOwn(DEFAULT_PREFS, pref)).toBe(true)
      }
    }
  })

  it('each new page preference is named by a control binding in app.js', () => {
    // The half that catches a preference added to the model and never wired:
    // it would read as supported and never change.
    const unbound = []
    for (const page of NEW_PAGES) {
      for (const pref of PREF_PAGES[page]) {
        if (!new RegExp(`'${pref}'`).test(APP)) unbound.push(`${page}.${pref}`)
      }
    }
    expect(unbound).toEqual([])
  })

  it('every input id in the new panes is bound in app.js', () => {
    // And the other half: a control in the markup that writes nowhere. The
    // user changes it, the dialog accepts it, nothing happens.
    const paneSection = HTML.slice(HTML.indexOf('id="options-pane-folderViews"'))
    const ids = [...paneSection.matchAll(/<(?:input|select)[^>]*\bid="([^"]+)"/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThanOrEqual(15)

    const unbound = ids.filter((id) => !APP.includes(`'${id}'`))
    expect(unbound).toEqual([])
  })

  it('every preference is read by something, not only written', () => {
    // The half this file originally missed. Proving a control writes the
    // preference says nothing about whether anything consumes it, and a
    // dialog whose settings are all write-only looks complete while changing
    // nothing at all. Fourteen of these eighteen were in exactly that state.
    //
    // A reader is a literal `getPref('name')` anywhere in the sources. The
    // binding table cannot fake one: it lists preferences as bare strings and
    // reads them back through a loop variable (`settings.setPref(pref, ...)`),
    // so the literal form only ever appears at a real point of use. The test
    // below pins that, because the whole check rests on it.
    //
    // An earlier version tried to cut the binding function out of app.js by
    // slicing to the first `\n}\n`. That span ran to 41KB, swallowed the
    // readers themselves, and reported working preferences as write-only.
    const consumers = SRC.join('\n')

    const writeOnly = []
    for (const page of NEW_PAGES) {
      for (const pref of PREF_PAGES[page]) {
        if (!consumers.includes(`getPref('${pref}')`)) writeOnly.push(`${page}.${pref}`)
      }
    }
    expect(writeOnly, 'stored by a control and consumed by nothing').toEqual([])
  })

  it('the binding table cannot masquerade as a reader', () => {
    // What makes the check above meaningful. If the control-binding code ever
    // starts writing `getPref('someName')` literally, then merely having a
    // control would satisfy "has a reader" and the check goes hollow — which
    // is exactly how its predecessor failed.
    const start = APP.indexOf('function setupPreferenceControls')
    expect(start).toBeGreaterThan(-1)
    // Up to the next top-level function declaration, which is a boundary that
    // does not depend on brace or newline conventions.
    const rest = APP.slice(start + 1)
    const end = rest.indexOf('\nfunction ')
    const body = end === -1 ? rest : rest.slice(0, end)

    const faked = NEW_PAGES.flatMap((page) => PREF_PAGES[page])
      .filter((pref) => body.includes(`getPref('${pref}')`))
    expect(faked, 'read literally inside the control binding').toEqual([])
  })

  it('no preference is claimed by two pages', () => {
    // Two pages resetting the same preference makes "restore this page" mean
    // different things depending on where you clicked.
    const seen = new Map()
    for (const [page, prefs] of Object.entries(PREF_PAGES)) {
      for (const pref of prefs) {
        expect(seen.has(pref)).toBe(false)
        seen.set(pref, page)
      }
    }
  })
})

describe('the defaults are the safe answer', () => {
  it('does not delete permanently by default', () => {
    expect(DEFAULT_PREFS.folderUseRecycleBin).toBe(true)
    expect(DEFAULT_PREFS.folderConfirmDelete).toBe(true)
  })

  it('does not alter file contents on save by default', () => {
    // Both of these rewrite the file. A user who never opens this page must
    // not have their whitespace silently changed.
    expect(DEFAULT_PREFS.editTrimOnSave).toBe(false)
    expect(DEFAULT_PREFS.editEnsureFinalNewline).toBe(false)
  })

  it('starts image comparison at exact match', () => {
    expect(DEFAULT_PREFS.pictureTolerance).toBe(0)
  })

  it('every tuning default matches the constant it overrides', () => {
    // A default that disagrees with the code's own value retunes the app for
    // every user who never opens the page. Three preferences on these pages
    // shipped that way: auto scale on, blend mode 'normal', and these.
    const FC = readFileSync(
      new URL('../../src/renderer/src/views/folder-compare.js', import.meta.url), 'utf-8')
    const constant = (name) => {
      const m = FC.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)`))
      expect(m, `${name} is no longer a numeric constant`).toBeTruthy()
      return Number(m[1])
    }
    expect(DEFAULT_PREFS.tweakConcurrency).toBe(constant('RULES_CONCURRENCY'))
    expect(DEFAULT_PREFS.tweakVirtualOverscan).toBe(constant('OVERSCAN'))
    expect(DEFAULT_PREFS.tweakPrefetchLimit).toBe(constant('MAX_VERSION_PREFETCH'))
  })

  it('does not resample one image to the other by default', () => {
    // Auto scale is not a view setting: it resizes a side before comparing, so
    // a 16x4 against an 8x8 becomes an 8x8 rescale instead of a 16x8 union.
    // Defaulting it on silently changed what "different" meant, and broke the
    // union behaviour the picture view had always had.
    expect(DEFAULT_PREFS.pictureAutoScale).toBe(false)
  })

  it('lists only archive formats this build can actually read', () => {
    const listed = String(DEFAULT_PREFS.archiveEnabled).split(',')
    expect(listed).toContain('cab')
    expect(listed).toContain('7z')
    // 'rar' used to be excluded here on the grounds that RAR was refused
    // outright. Stored RAR5 entries now open, and compressed ones are refused
    // by name at extraction, so leaving it out would hide an archive the app
    // can partly read. This gate is what caught the omission: the format
    // worked and the preference still said otherwise.
    expect(listed).toContain('rar')
  })

  it('passes external program arguments as a template, not a shell string', () => {
    expect(DEFAULT_PREFS.openWithArgs).toContain('%1')
  })
})

describe('the settings reach the views rather than only the store', () => {
  it('pushes the text editing defaults into a new text view', () => {
    // Preferences that nothing reads are the failure this project keeps
    // finding: a dialog that accepts every change and alters nothing.
    expect(APP).toContain("applyBcDefaults('text', textCompare)")
    expect(APP).toMatch(/setTabWidth\(\s*\n?\s*Number\(settings\.getPref\('editTabWidth'\)\)/)
  })

  it('pushes the picture defaults into a new image view', () => {
    expect(APP).toContain("applyBcDefaults('image', imageCompare)")
    expect(APP).toContain("settings.getPref('pictureDefaultBlend')")
    expect(APP).toContain("settings.getPref('pictureAutoScale')")
  })

  it('inverts insert-spaces when handing it to setTabWidth', () => {
    // setTabWidth's second argument is useTabs, so passing the preference
    // straight through would do exactly the opposite of what it says.
    expect(APP).toContain("!settings.getPref('editInsertSpaces')")
  })

  it('reports a failed apply instead of swallowing it', () => {
    const fn = APP.slice(APP.indexOf('function applyBcDefaults'))
      .slice(0, APP.slice(APP.indexOf('function applyBcDefaults')).indexOf('\n}\n'))
    expect(fn).toContain('showError')
    expect(fn).not.toMatch(/catch\s*\{\s*\}/)
  })
})
