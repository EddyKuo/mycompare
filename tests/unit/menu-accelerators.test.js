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
    const conditions = RENDERER
      .split('\n')
      .filter((line) => /e\.key\s*===/.test(line))

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
      const keyRe = new RegExp(`e\\.key\\s*===\\s*'${esc(key)}'`, 'i')

      return conditions.some((line) => {
        if (!keyRe.test(line)) return false
        // A required modifier must be asserted, and one the accelerator does
        // not name must not be — otherwise Ctrl+F8 would be "proved" by a
        // line binding plain F8.
        for (const [name, flag] of [['ctrl', need.ctrl], ['shift', need.shift], ['alt', need.alt]]) {
          const asserted = new RegExp(`(?<!!)e\\.${name}Key(?!\\s*===\\s*false)`).test(line)
          const negated = new RegExp(`!e\\.${name}Key`).test(line)
          if (flag && !asserted) return false
          if (!flag && asserted && !negated) return false
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
