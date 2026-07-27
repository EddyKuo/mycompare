/**
 * Every CSS custom property a stylesheet asks for is actually defined.
 *
 * `var(--x, fallback)` never fails visibly. If `--x` does not exist the
 * fallback renders, the screen looks plausible, and the theme quietly does not
 * apply. Thirty-two such calls across seven stylesheets referenced names
 * nothing defined — including `--accent-color`, which the per-view CSS used
 * everywhere while the palette that was added to replace those hardcoded blues
 * defined `--accent`. The result was two different blues in one application,
 * and hover and status colours that could not follow the light/dark switch.
 *
 * Nothing catches this at runtime, and no screenshot catches it either, since
 * the fallback is usually a reasonable colour. Only comparing the set of names
 * used against the set defined does.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { join } from 'path'

const STYLES = fileURLToPath(new URL('../../src/renderer/src/styles/', import.meta.url))
const SRC = fileURLToPath(new URL('../../src/renderer/src/', import.meta.url))

const cssFiles = readdirSync(STYLES).filter((f) => f.endsWith('.css'))
const css = cssFiles.map((f) => readFileSync(join(STYLES, f), 'utf-8'))

/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) out.push(...jsFiles(full))
    else if (name.name.endsWith('.js')) out.push(full)
  }
  return out
}

const js = jsFiles(SRC).map((f) => readFileSync(f, 'utf-8')).join('\n')

/** Properties declared in a stylesheet. */
const declared = new Set(
  css.flatMap((t) => [...t.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1])))

/**
 * Properties the views set at runtime, which is a legitimate way to define one
 * — the font and row-height settings are written from the Options dialog.
 */
const runtimeSet = new Set(
  [...js.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)].map((m) => m[1]))

/** Properties referenced through var(). */
const used = new Set(
  css.flatMap((t) => [...t.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1])))

describe('CSS custom properties', () => {
  it('reads the stylesheets at all', () => {
    expect(cssFiles.length).toBeGreaterThan(5)
    expect(declared.size).toBeGreaterThan(30)
    expect(used.size).toBeGreaterThan(30)
  })

  it('every property a stylesheet uses is declared or set at runtime', () => {
    const missing = [...used].filter((v) => !declared.has(v) && !runtimeSet.has(v)).sort()
    expect(missing, 'used in CSS but defined nowhere').toEqual([])
  })

  it('every property set from JS is one the CSS actually consumes', () => {
    // The mirror case: writing a property no rule reads is a setting that
    // changes nothing, which is the same defect wearing different clothes.
    const unread = [...runtimeSet].filter((v) => !used.has(v)).sort()
    expect(unread, 'set from JS but no CSS rule reads it').toEqual([])
  })

  it('the accent alias resolves to the palette rather than a literal', () => {
    // The specific defect. --accent-color must not be reintroduced as its own
    // hardcoded blue: it exists to point at the one the palette defines.
    const vars = css.join('\n')
    expect(vars).toMatch(/--accent-color:\s*var\(--accent\)/)
  })

  it('declares light and dark values for the ones that cannot simply inherit', () => {
    // A translucent black wash is invisible on a dark background, and a
    // light-theme grey is wrong there outright, so these two need a real value
    // per theme rather than resolving through a token that already flips.
    const darkBlocks = css.join('\n').split('[data-theme="dark"]').slice(1).join('\n')
    for (const name of ['--bg-hover', '--bg-tertiary']) {
      expect(darkBlocks, `${name} has no dark value`).toContain(`${name}:`)
    }
  })
})
