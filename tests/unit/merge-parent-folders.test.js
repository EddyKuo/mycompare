/**
 * Merge Parent Folders opens a three-way folder comparison.
 *
 * BC's Text Merge offers "Merge Parent Folders", which opens the three
 * sources' containing folders. This app collapsed that to a two-sided
 * comparison and threw the base away, on the stated grounds that it had no
 * three-way folder compare. That was true when the line was written and false
 * from the moment the folder view gained merge mode — a stale comment quietly
 * degrading a feature, which is the same shape as the orphaned capabilities
 * this project keeps finding, just inverted.
 *
 * Dropping the base is not cosmetic. The common ancestor is the entire basis
 * for deciding who changed what; without it every differing file reads as a
 * conflict rather than as "one side changed this".
 *
 * These read app.js as text because the routing lives in the module's top
 * level and mounting the whole app in jsdom to observe it would test the
 * harness more than the behaviour.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const APP = readFileSync(new URL('../../src/renderer/src/app.js', import.meta.url), 'utf-8')

/** The body of a top-level function declaration, up to the next one. */
function functionBody(name) {
  const start = APP.indexOf(`function ${name}(`)
  expect(start, `${name} is gone`).toBeGreaterThan(-1)
  const rest = APP.slice(start + 1)
  const end = rest.indexOf('\nfunction ')
  return end === -1 ? rest : rest.slice(0, end)
}

describe('openMergeParentFolders', () => {
  const body = functionBody('openMergeParentFolders')

  it('opens a three-way folder comparison when all three parents exist', () => {
    expect(body).toMatch(/left\s*&&\s*base\s*&&\s*right/)
    expect(body).toMatch(/basePath:\s*base/)
  })

  it('passes the base through rather than picking a pair from the three', () => {
    // The defect: with all three present it matched `left && right` first and
    // opened only those two, so the ancestor never reached the view.
    const threeWayIdx = body.indexOf('left && base && right')
    const pairIdx = body.indexOf('if (left && right)')
    expect(threeWayIdx).toBeGreaterThan(-1)
    expect(pairIdx).toBeGreaterThan(-1)
    expect(threeWayIdx, 'the pair fallback still wins').toBeLessThan(pairIdx)
  })

  it('keeps the two-source fallback, since a merge can have a side unloaded', () => {
    expect(body).toMatch(/基準與左側/)
    expect(body).toMatch(/基準與右側/)
    expect(body).toMatch(/至少要有兩個/)
  })

  it('no longer claims the app has no three-way folder compare', () => {
    // The comment that caused this. It sat next to the subscription and read
    // as a reason, so it would have been copied forward.
    expect(APP).not.toContain('this app has no three-way folder compare')
  })
})

describe('openComparison, folder branch', () => {
  const body = functionBody('openComparison')

  it('turns merge mode on before setting paths', () => {
    // Order matters: merge mode decides how many sides the view has, so a base
    // set on a two-sided view is stored and never rendered.
    const mergeIdx = body.indexOf('setMergeMode(true)')
    const baseIdx = body.indexOf('setBase(basePath)')
    expect(mergeIdx).toBeGreaterThan(-1)
    expect(baseIdx).toBeGreaterThan(-1)
    expect(mergeIdx, 'base is set before merge mode is on').toBeLessThan(baseIdx)
  })

  it('sets all three sides', () => {
    expect(body).toMatch(/setLeft\(leftPath\)/)
    expect(body).toMatch(/setBase\(basePath\)/)
    expect(body).toMatch(/setRight\(rightPath\)/)
  })

  it('guards the setter, so an older view object cannot throw', () => {
    expect(body).toMatch(/typeof folderCompare\?\.setMergeMode === 'function'/)
  })

  it('names the tab for what it is', () => {
    // A three-way merge labelled 資料夾比對 is indistinguishable from an
    // ordinary comparison in the tab strip.
    expect(body).toMatch(/三向資料夾合併/)
  })

  it('still opens an ordinary comparison when no base is given', () => {
    expect(body).toMatch(/basePath \? '三向資料夾合併' : '資料夾比對'/)
  })
})
