/**
 * Every exposed IPC method is called by something.
 *
 * This project's most persistent bug is a capability that is fully built,
 * correctly exposed through preload, unit-tested, and reached by no code at
 * all. Two audits found nine of them, and three were mine, added in this
 * session while policing exactly that pattern.
 *
 * Unit tests cannot catch it, because the module works. Only the absence of a
 * caller gives it away, and nothing at runtime ever looks for that.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PRELOAD = readFileSync(join(ROOT, 'src/preload/index.js'), 'utf-8')

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

const RENDERER = jsFiles(join(ROOT, 'src/renderer'))
  .map((f) => readFileSync(f, 'utf-8'))
  .join('\n')

/**
 * Methods on the object handed to contextBridge.
 *
 * Anchored to two-space indentation so object literals nested inside a method
 * body are not mistaken for further methods.
 */
function exposedMethods() {
  return [...PRELOAD.matchAll(/^ {2}([a-zA-Z]\w*)\s*:/gm)].map((m) => m[1])
}

/**
 * Whether anything in the renderer references the method.
 *
 * Deliberately any `.name`, not `electronAPI.name`: several call sites take a
 * local alias first (`const api = window.electronAPI`, then `api.readRegFile`).
 * Insisting on the qualified form reported three working features as orphans,
 * which would have had me "fix" code that was already correct. The looser match
 * can only cause a false negative — a same-named method on some other object —
 * and a missed orphan is a far cheaper mistake than a fabricated one.
 *
 * @param {string} name
 */
function isCalled(name) {
  return new RegExp(`\\.${name}\\b`).test(RENDERER)
}

/**
 * Exposed but deliberately uncalled, with the reason.
 *
 * An entry here is a standing claim that the gap is intentional. It is not a
 * place to quiet a failure — that is how the original nine survived.
 */
const ALLOWED = new Map()

describe('preload surface', () => {
  it('finds the exposed methods at all', () => {
    // Without this, a change to preload's shape would empty the list and the
    // check below would pass by examining nothing.
    expect(exposedMethods().length).toBeGreaterThan(30)
  })

  it('reads the renderer sources at all', () => {
    expect(RENDERER.length).toBeGreaterThan(100000)
  })

  it('has a renderer caller for every exposed method', () => {
    const orphans = exposedMethods().filter((n) => !ALLOWED.has(n) && !isCalled(n))
    expect(orphans, 'exposed through preload but never called').toEqual([])
  })

  it('carries no stale exemption', () => {
    // An exemption that has since gained a caller hides the next real orphan.
    const stale = [...ALLOWED.keys()].filter(isCalled)
    expect(stale, 'listed as uncalled but now called').toEqual([])
  })
})

/**
 * The mirror defect: a renderer call to a method preload never exposed.
 *
 * The orphan check above runs preload → renderer and catches a capability with
 * no caller. It says nothing about the other direction, and that is the one
 * that actually breaks at runtime: `window.electronAPI.vcsStatus(...)` on an
 * object with no such key is a TypeError, raised only when the feature is
 * first exercised. The version control and owner columns shipped that way —
 * two complete main-process modules, thirty-five passing unit tests, and no
 * handler or preload entry anywhere behind them.
 *
 * Only the qualified `electronAPI.name` form is collected. Call sites that
 * alias the object first are missed, which is a false negative — the same
 * trade the orphan check makes above, and the cheap direction to be wrong in.
 */
function calledMethods() {
  return new Set(
    [...RENDERER.matchAll(/\belectronAPI\??\.([a-zA-Z]\w*)\b/g)].map((m) => m[1]))
}

/**
 * A module nothing imports.
 *
 * The check above is satisfied by any file in the renderer mentioning the
 * method — including a module that is itself dead. That is not hypothetical:
 * window-manager.js was written, referenced both new preload methods, and made
 * this suite green while nothing imported it, so the feature was as unreachable
 * as before. One orphan check hiding another is worth closing.
 */
describe('every renderer module is imported by something', () => {
  const ROOT_DIR = join(ROOT, 'src/renderer/src')
  const files = jsFiles(ROOT_DIR)

  /** Entry points, which are referenced from HTML rather than from JS. */
  const ENTRIES = new Set(['main.js'])

  it('finds the modules at all', () => {
    expect(files.length).toBeGreaterThan(15)
  })

  it('has an importer for each one', () => {
    const sources = files.map((f) => readFileSync(f, 'utf-8'))
    const orphans = []
    for (const full of files) {
      const name = full.split(/[\\/]/).pop()
      if (ENTRIES.has(name)) continue
      const stem = name.replace(/\.js$/, '')
      // Matches both `from './x.js'` and a dynamic `import('../core/x.js')`,
      // without caring about the relative prefix.
      const re = new RegExp(`['"\`][^'"\`]*\\b${stem}\\.js['"\`]`)
      const imported = files.some((other, i) => other !== full && re.test(sources[i]))
      if (!imported) orphans.push(name)
    }
    expect(orphans, 'renderer modules nothing imports').toEqual([])
  })
})

describe('renderer calls land somewhere', () => {
  it('finds the qualified call sites at all', () => {
    expect(calledMethods().size).toBeGreaterThan(20)
  })

  it('every electronAPI method the renderer calls is exposed by preload', () => {
    const exposed = new Set(exposedMethods())
    const missing = [...calledMethods()].filter((n) => !exposed.has(n))
    expect(missing, 'called in the renderer but not exposed by preload').toEqual([])
  })
})
