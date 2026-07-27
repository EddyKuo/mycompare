/**
 * Menu accelerators are labels, and labels can lie.
 *
 * `registerAccelerator: false` means the menu never binds a key — the renderer
 * owns every keystroke through a user-customisable table, so both binding it
 * would double-fire and shadow rebindings. The cost of that design is that an
 * accelerator string in menu.js is a *claim* about what the renderer binds,
 * checked by nothing.
 *
 * It was already wrong: the hex reload item advertised Ctrl+Shift+R and no
 * binding existed, so the key did nothing at all. This test is what stops the
 * next one.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { DEFAULT_SHORTCUTS } from '../../src/renderer/src/core/settings-store.js'

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
const APP = readFileSync(new URL('../../src/renderer/src/app.js', import.meta.url), 'utf-8')

/** Every renderer source that could bind a key. */
const RENDERER = [
  'app.js', 'views/text-compare.js', 'views/hex-compare.js', 'views/table-compare.js',
  'views/folder-compare.js', 'views/image-compare.js', 'views/three-way-compare.js',
].map((f) => readFileSync(new URL(`../../src/renderer/src/${f}`, import.meta.url), 'utf-8'))
  .join('\n')

const win = { isDestroyed: () => false, webContents: { send: () => {} } }

/**
 * Every (accelerator, label) pair the menu displays.
 * @param {import('electron').MenuItemConstructorOptions[]} items
 * @returns {Array<{accel: string, label: string}>}
 */
function acceleratorsIn(items) {
  const out = []
  for (const it of items) {
    if (typeof it.accelerator === 'string' && it.accelerator) {
      out.push({ accel: it.accelerator, label: String(it.label ?? it.id ?? '') })
    }
    if (Array.isArray(it.submenu)) out.push(...acceleratorsIn(it.submenu))
  }
  return out
}

/**
 * Menu spelling ("CmdOrCtrl+Shift+R") to the renderer's ("Ctrl+Shift+R").
 *
 * The final key is lower-cased because the two sides genuinely disagree on it:
 * the menu displays "Ctrl+D" and editCommands() declares "Ctrl+d". Matching is
 * case-insensitive at runtime, so the difference is cosmetic — but comparing
 * them literally here would report every one of them as a broken binding.
 */
function normalise(accel) {
  const parts = accel
    .replace(/CmdOrCtrl|CommandOrControl/gi, 'Ctrl')
    .replace(/\bLeft\b/g, 'ArrowLeft').replace(/\bRight\b/g, 'ArrowRight')
    .replace(/\bUp\b/g, 'ArrowUp').replace(/\bDown\b/g, 'ArrowDown')
    .split('+')
  parts[parts.length - 1] = parts[parts.length - 1].toLowerCase()
  return parts.join('+')
}

describe('advertised accelerators', () => {
  it('is a non-trivial set, so a broken extractor cannot pass this vacuously', () => {
    buildAppMenu(win)
    expect(acceleratorsIn(lastTemplate).length).toBeGreaterThan(5)
  })

  it('every displayed key is one the renderer actually binds', () => {
    buildAppMenu(win)

    // Two ways a key gets bound in this codebase. The customisable table holds
    // combo strings; the views test the event directly, one condition per
    // line, so the modifiers and the key are matched together rather than
    // "this letter appears somewhere".
    const shortcutCombos = new Set(
      Object.values(DEFAULT_SHORTCUTS).filter(Boolean).map(normalise))
    // The third mechanism: editCommands() declares its own combo per command
    // and dispatches by matching it, so those are bound too.
    for (const m of RENDERER.matchAll(/\bcombo:\s*'([^']+)'/g)) {
      shortcutCombos.add(normalise(m[1]))
    }
    // A key test plus the modifier context it sits in. Some views test the
    // event inline (`e.ctrlKey && e.key === 'h'`); the table view guards a
    // whole block with the modifiers and then switches on a local `key`. Only
    // looking at single lines called the second style unbound, which is how
    // this test first reported Ctrl+C as a lie when it is not one.
    const lines = RENDERER.split('\n')
    const conditions = []
    for (let i = 0; i < lines.length; i++) {
      if (!/\bkey\s*===\s*'/.test(lines[i])) continue
      // Wide enough to reach the enclosing `if` in every case here — the
      // table view's ctrl guard sits nineteen lines above its last key test.
      // Only the positive checks read this; the negative ones read the key
      // line alone, so a wider window cannot make a false claim pass.
      conditions.push({
        line: lines[i],
        block: lines.slice(Math.max(0, i - 30), i + 1).join(' '),
      })
    }

    /** @param {string} accel @returns {boolean} */
    function isBound(accel) {
      const combo = normalise(accel)
      if (shortcutCombos.has(combo)) return true

      const parts = combo.split('+')
      const key = parts[parts.length - 1]
      const need = {
        ctrl: parts.includes('Ctrl'),
        shift: parts.includes('Shift'),
        alt: parts.includes('Alt'),
      }
      // Ctrl+[ and Ctrl+] are real bindings here, so the key goes in as a
      // literal rather than as regex source.
      const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Case-insensitive: `normalise` lower-cases the key while the source
      // spells it 'ArrowUp'.
      const keyRe = new RegExp(`\\bkey\\s*===\\s*'${esc(key)}'`, 'i')

      return conditions.some(({ line, block }) => {
        if (!keyRe.test(line)) return false
        for (const [name, flag] of [['ctrl', need.ctrl], ['shift', need.shift], ['alt', need.alt]]) {
          const assertedRe = new RegExp(`(?<!!)e\\.${name}Key(?!\\s*===\\s*false)`)
          const negated = new RegExp(`!e\\.${name}Key`).test(line)
          // A required modifier may be asserted by the enclosing guard, so the
          // block is what proves it. A modifier the accelerator does *not*
          // name only disqualifies when it is on the key line itself —
          // searching the block would pick up sibling branches that test it,
          // and reject Ctrl+V because the branch above happened to check
          // shift. Otherwise Ctrl+F8 could still be "proved" by plain F8.
          if (flag && !assertedRe.test(block)) return false
          if (!flag && assertedRe.test(line) && !negated) return false
        }
        return true
      })
    }

    const lying = acceleratorsIn(lastTemplate)
      .filter(({ accel }) => !isBound(accel))
      .map(({ accel, label }) => `${label} → ${accel}`)

    expect(lying).toEqual([])
  })

  it('Ctrl+Shift+R reloads from disk rather than being decoration', () => {
    // The specific case that was broken. Both reload items carry this key, and
    // one binding routed by view is what serves them.
    expect(DEFAULT_SHORTCUTS.reloadFromDisk).toBe('Ctrl+Shift+R')
    expect(APP).toContain('reloadFromDisk: () => reloadActiveFromDisk()')
    expect(APP).toContain('function reloadActiveFromDisk()')
  })
})

describe('no view swallows a key the global handler owns', () => {
  it('Ctrl+Shift+R reaches the shared reload rather than a view command', () => {
    // A near miss: text-compare bound Ctrl+Shift+R to its replacements dialog.
    // The moment TextCompare gained reloadAll(), one keypress both opened the
    // dialog and raised the reload confirmation. The view moved to Ctrl+Alt+R;
    // this is what stops the next view from claiming it back.
    const claims = RENDERER
      .split('\n')
      .filter((line) => /e\.key\s*===\s*'r'/i.test(line))
      .filter((line) => /e\.ctrlKey/.test(line) && /e\.shiftKey/.test(line))
      // A line that explicitly requires shift to be *absent* is not a claim.
      .filter((line) => !/!e\.shiftKey/.test(line))

    expect(claims).toEqual([])
  })

  it('is one reload command routed by view, not one per view', () => {
    // Three menu entries showing the same accelerator read as three different
    // commands. The renderer binds the key once and dispatches on the active
    // view, so the menu says so too.
    buildAppMenu(win)
    const ids = []
    const walk = (items) => {
      for (const it of items) {
        if (typeof it.id === 'string') ids.push(it.id)
        if (Array.isArray(it.submenu)) walk(it.submenu)
      }
    }
    walk(lastTemplate)
    expect(ids).toContain('file.reload')
    expect(ids.filter((id) => /\.reload$/.test(id))).toEqual(['file.reload'])
  })
})
