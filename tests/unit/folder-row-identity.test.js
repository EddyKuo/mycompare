/**
 * @vitest-environment jsdom
 *
 * `flattenRows` hands out copies; `eachRow` hands out the real rows.
 *
 * This distinction caused a real bug: a pass that graded rows wrote its verdict
 * through `flattenRows`, so the status landed on a throwaway object and the
 * model never changed. Nothing threw, and the view simply showed the old
 * result. The two helpers look interchangeable at the call site, so the
 * difference is pinned here rather than left to be rediscovered.
 */
import { describe, it, expect } from 'vitest'
import { flattenRows, eachRow } from '../../src/renderer/src/views/folder-compare.js'

/** A two-level tree: one file, one directory holding one file. */
function tree() {
  return [
    {
      name: 'a.txt', status: 'same',
      left: { path: '/l/a.txt', name: 'a.txt', isDirectory: false },
      right: { path: '/r/a.txt', name: 'a.txt', isDirectory: false },
      children: null,
    },
    {
      name: 'sub', status: 'same',
      left: { path: '/l/sub', name: 'sub', isDirectory: true },
      right: { path: '/r/sub', name: 'sub', isDirectory: true },
      children: [{
        name: 'b.txt', status: 'same',
        left: { path: '/l/sub/b.txt', name: 'b.txt', isDirectory: false },
        right: { path: '/r/sub/b.txt', name: 'b.txt', isDirectory: false },
        children: null,
      }],
    },
  ]
}

describe('row identity', () => {
  it('eachRow yields the model rows themselves', () => {
    const rows = tree()
    const seen = [...eachRow(rows)]
    expect(seen[0]).toBe(rows[0])
    expect(seen).toContain(rows[1].children[0])
  })

  it('a status written through eachRow reaches the model', () => {
    const rows = tree()
    for (const row of eachRow(rows)) row.status = 'different'
    expect(rows[0].status).toBe('different')
    expect(rows[1].children[0].status).toBe('different')
  })

  it('flattenRows yields copies, so a write through it is lost', () => {
    // Not a defect — the copy carries display state like `depth`. It is only a
    // trap when a caller assumes otherwise, which is exactly what happened.
    const rows = tree()
    for (const row of flattenRows(rows)) row.status = 'different'
    expect(rows[0].status).toBe('same')
  })

  it('but both share the same entry objects, so entry fields do write through', () => {
    // A shallow copy: `row.left` is the same object. This is why some
    // write-backs through flattenRows appear to work and others silently do
    // not, which is the part that makes the trap hard to spot.
    const rows = tree()
    const flat = flattenRows(rows)
    expect(flat[0].left).toBe(rows[0].left)
    flat[0].left.readOnly = true
    expect(rows[0].left.readOnly).toBe(true)
  })

  it('both visit every row in the tree', () => {
    const rows = tree()
    expect([...eachRow(rows)].length).toBe(3)
    expect(flattenRows(rows).length).toBe(3)
  })
})
