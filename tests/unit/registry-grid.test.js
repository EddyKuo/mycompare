/**
 * The registry key/value grid: tree shape, filtering, and writing back.
 *
 * The comparison itself is not tested here — it lives in the main process and
 * `registry.test.js` covers it. What these tests are for is everything the old
 * read-only text view could not express: a value's type, a value that exists
 * on one side only, and the round trip back out to a .reg file.
 */
import { describe, it, expect } from 'vitest'
import {
  buildRegistryTree, flattenRegistryTree, countRegistryStatuses, allKeyPaths,
} from '../../src/renderer/src/core/registry-tree.js'
import {
  parseRegFile, flattenRegistry, diffRegistry, diffRegistryForDisplay,
  buildRegFile, formatRegValue, refuseTruncatedRows, MAX_TRANSFER_VALUE_CHARS,
  applyBaseKey, BASE_ROOT,
} from '../../src/main/registry.js'
import {
  RegistryCompare, computeStatus, cellText, sideText, parentOf,
} from '../../src/renderer/src/views/registry-compare.js'

const ROOT = 'HKEY_CURRENT_USER\\Software\\T'

/**
 * @param {string} path
 * @param {string} name
 * @param {string} status
 * @param {object|null} left
 * @param {object|null} right
 */
const row = (path, name, status, left, right) => ({ path, name, status, left, right })
const val = (value, type = 'REG_SZ') => ({ type, value })

/**
 * Find a key node by its full path. The tree starts at HKEY_CURRENT_USER, so
 * the node under test is several levels below the root.
 *
 * @param {Array<object>} roots
 * @param {string} path
 * @returns {object|undefined}
 */
function keyAt(roots, path) {
  const want = path.toLowerCase()
  const walk = (n) => {
    if (n.kind === 'key' && n.path.toLowerCase() === want) return n
    for (const c of n.children) {
      const hit = walk(c)
      if (hit) return hit
    }
    return undefined
  }
  for (const r of roots) {
    const hit = walk(r)
    if (hit) return hit
  }
  return undefined
}

describe('the tree the grid draws', () => {
  it('nests keys by their path segments', () => {
    const roots = buildRegistryTree([
      row(`${ROOT}\\A`, 'x', 'same', val('1'), val('1')),
      row(`${ROOT}\\A\\B`, 'y', 'same', val('2'), val('2')),
    ])
    const paths = allKeyPaths(roots)
    expect(paths).toContain(ROOT.toLowerCase())
    expect(paths).toContain(`${ROOT}\\A`.toLowerCase())
    expect(paths).toContain(`${ROOT}\\A\\B`.toLowerCase())
    // One root, however deep the paths go.
    expect(roots).toHaveLength(1)
  })

  it('gives a key the strongest status found beneath it', () => {
    // A key holding one changed value is a changed key, even though every
    // other value under it matches — that colouring is the whole point of
    // showing keys at all.
    const roots = buildRegistryTree([
      row(`${ROOT}\\A`, 'same1', 'same', val('1'), val('1')),
      row(`${ROOT}\\A`, 'changed', 'different', val('1'), val('2')),
    ])
    expect(keyAt(roots, `${ROOT}\\A`).status).toBe('different')
  })

  it('calls a key different when it holds orphans from both sides', () => {
    // Two orphans pointing opposite ways mean the key exists on both sides and
    // its contents disagree. Reporting it as an orphan would say the key is
    // missing somewhere, which is not true.
    const roots = buildRegistryTree([
      row(`${ROOT}\\A`, 'onlyL', 'left-only', val('1'), null),
      row(`${ROOT}\\A`, 'onlyR', 'right-only', null, val('2')),
    ])
    expect(keyAt(roots, `${ROOT}\\A`).status).toBe('different')
  })

  it('keeps a key that has no values at all', () => {
    const roots = buildRegistryTree([
      row(`${ROOT}\\Empty`, '', 'left-only', { type: 'KEY', value: '' }, null),
    ])
    const empty = keyAt(roots, `${ROOT}\\Empty`)
    expect(empty).toBeTruthy()
    // The placeholder made the key; it must not also appear as a value row.
    expect(empty.children).toHaveLength(0)
    // And it keeps the status it arrived with. Without this it reports 'same',
    // draws uncoloured, and the differences filter removes it — a key present
    // on one side only is the plainest thing a registry diff has to show, and
    // `foldStatus` cannot repair it because there are no children to fold.
    expect(empty.status).toBe('left-only')
  })

  it('keeps a one-sided empty key visible under the differences filter', () => {
    const roots = buildRegistryTree([
      row(`${ROOT}\\Empty`, '', 'left-only', { type: 'KEY', value: '' }, null),
    ])
    const flat = flattenRegistryTree(roots, {
      expanded: new Set(allKeyPaths(roots)), showSame: false,
    })
    expect(flat.some((n) => n.label === 'Empty')).toBe(true)
  })

  it('counts values only, so a difference is not counted twice', () => {
    const roots = buildRegistryTree([
      row(`${ROOT}\\A`, 'x', 'different', val('1'), val('2')),
    ])
    expect(countRegistryStatuses(roots)).toEqual({
      same: 0, different: 1, 'left-only': 0, 'right-only': 0,
    })
  })
})

describe('what the grid shows', () => {
  const rows = [
    row(`${ROOT}\\A`, 'keep', 'same', val('1'), val('1')),
    row(`${ROOT}\\A`, 'changed', 'different', val('1'), val('2')),
    row(`${ROOT}\\B`, 'only', 'left-only', val('9'), null),
  ]
  const roots = buildRegistryTree(rows)
  const allOpen = new Set(allKeyPaths(roots))

  it('lists keys and their values when expanded', () => {
    const flat = flattenRegistryTree(roots, { expanded: allOpen })
    expect(flat.filter((n) => n.kind === 'value').map((n) => n.label).sort())
      .toEqual(['changed', 'keep', 'only'])
  })

  it('hides the values of a collapsed key but keeps the key', () => {
    const flat = flattenRegistryTree(roots, { expanded: new Set() })
    expect(flat.every((n) => n.kind === 'key')).toBe(true)
    expect(flat.length).toBeGreaterThan(0)
  })

  it('drops matching values under the differences filter', () => {
    const flat = flattenRegistryTree(roots, { expanded: allOpen, showSame: false })
    const labels = flat.filter((n) => n.kind === 'value').map((n) => n.label)
    expect(labels).toContain('changed')
    expect(labels).toContain('only')
    expect(labels).not.toContain('keep')
  })

  it('never leaves a value without the key it belongs to', () => {
    // The failure this guards: filtering row by row, so a surviving value is
    // drawn under whatever key happened to precede it.
    const flat = flattenRegistryTree(roots, { expanded: allOpen, showSame: false })
    for (let i = 0; i < flat.length; i++) {
      if (flat[i].kind !== 'value') continue
      const above = flat.slice(0, i).reverse().find((n) => n.kind === 'key')
      expect(above?.path, `${flat[i].label} has the wrong key above it`)
        .toBe(flat[i].path)
    }
  })

  it('removes a key entirely when nothing under it survives the filter', () => {
    const onlySame = flattenRegistryTree(roots, { expanded: allOpen, showDiff: false })
    // B holds a single orphan, so with differences hidden it should be gone.
    expect(onlySame.some((n) => n.label === 'B')).toBe(false)
  })

  it('searches on the name', () => {
    const flat = flattenRegistryTree(roots, { expanded: allOpen, find: 'chang' })
    const labels = flat.filter((n) => n.kind === 'value').map((n) => n.label)
    expect(labels).toEqual(['changed'])
  })
})

describe('writing rows back out', () => {
  /**
   * @param {string} body
   * @returns {ReturnType<typeof flattenRegistry>}
   */
  const parse = (body) => flattenRegistry(parseRegFile(
    ['Windows Registry Editor Version 5.00', '', `[${ROOT}]`, body].join('\r\n')))

  it('round-trips every type through its own parser', () => {
    const source = [
      'Windows Registry Editor Version 5.00',
      '',
      `[${ROOT}]`,
      '@="the default"',
      '"Text"="a \\"quoted\\" \\\\ path"',
      '"Num"=dword:0000002a',
      '"Big"=hex(b):01,02,03,04,05,06,07,08',
      '"Bin"=hex:de,ad,be,ef',
      '"Expand"=hex(2):25,00,50,00,41,00,54,00,48,00,25,00,00,00',
      '"Multi"=hex(7):61,00,00,00,62,00,00,00,00,00',
    ].join('\r\n')

    const before = flattenRegistry(parseRegFile(source))
    const after = flattenRegistry(parseRegFile(buildRegFile(before)))
    expect(after).toEqual(before)
  })

  it('encodes an edited value rather than reusing a token that no longer fits', () => {
    // An untouched hex-encoded string keeps its original token because the
    // decode is lossy. Once edited there is no original, so it has to be
    // re-encoded — and must come back as what was typed.
    const [existing] = parse('"Expand"=hex(2):25,00,50,00,00,00')
    expect(existing.raw).toBeDefined()

    const edited = { ...existing, value: 'C:\\Windows', raw: undefined }
    const out = flattenRegistry(parseRegFile(buildRegFile([edited])))
    expect(out[0].value).toBe('C:\\Windows')
    expect(out[0].type).toBe('REG_EXPAND_SZ')
  })

  it('keeps a REG_MULTI_SZ component containing the separator intact', () => {
    // The display form joins components with ' | ', so a component holding
    // that string cannot be recovered from it. The original token is what
    // makes an untouched value survive.
    const rows = parse('"M"=hex(7):61,00,20,00,7c,00,20,00,62,00,00,00,63,00,00,00,00,00')
    const after = flattenRegistry(parseRegFile(buildRegFile(rows)))
    expect(after[0].value).toBe(rows[0].value)
  })

  it('wraps long values so they read back as one value', () => {
    const bytes = Array.from({ length: 400 }, (_, i) => (i % 256).toString(16).padStart(2, '0'))
    const rows = parse(`"Bin"=hex:${bytes.join(',')}`)
    const text = buildRegFile(rows)
    expect(text.split('\r\n').some((l) => l.endsWith('\\'))).toBe(true)
    const after = flattenRegistry(parseRegFile(text))
    expect(after[0].value).toBe(rows[0].value)
  })

  it('survives a REG_SZ holding a newline', () => {
    // Written as a quoted string this ends the line, and everything after it
    // parses as a new statement — the value comes back cut in half with no
    // error anywhere.
    const rows = [{ path: ROOT, name: 'N', type: 'REG_SZ', value: 'line1\nline2' }]
    const after = flattenRegistry(parseRegFile(buildRegFile(rows)))
    expect(after).toHaveLength(1)
    expect(after[0].value).toBe('line1\nline2')
  })

  it('cannot be made to write a second key out of a value', () => {
    // The file goes to `reg.exe import`, so a value that closes its own quote
    // and opens a [key] section would be written to the live registry under a
    // key nobody asked for.
    const value = 'x"\r\n\r\n[HKEY_LOCAL_MACHINE\\SOFTWARE\\Injected]\r\n"Pwned"="yes'
    const text = buildRegFile([{ path: ROOT, name: 'N', type: 'REG_SZ', value }])

    expect(text).not.toContain('[HKEY_LOCAL_MACHINE')
    const keys = new Set(flattenRegistry(parseRegFile(text)).map((r) => r.path))
    expect([...keys]).toEqual([ROOT])
    // And the value itself still round-trips intact.
    expect(flattenRegistry(parseRegFile(text))[0].value).toBe(value)
  })

  it('refuses a value name carrying a control character', () => {
    // A name has no hex form to fall back on, so there is nothing safe to
    // write — better a named error than a file that means something else.
    expect(() => buildRegFile([
      { path: ROOT, name: 'a\nb', type: 'REG_SZ', value: 'x' },
    ])).toThrow(/控制字元/)
  })

  it('refuses a DWORD it cannot read rather than writing a wrong number', () => {
    expect(() => formatRegValue({ type: 'REG_DWORD', value: 'not a number' }))
      .toThrow(/REG_DWORD/)
  })
})

describe('the status an edit produces', () => {
  it('agrees with the main process on every combination', () => {
    // The view recomputes a row's status after an edit rather than asking main
    // again, so the two rules have to say the same thing. If they drift, an
    // edited row shows one colour until the next reload and a different one
    // after it, with nothing to explain the change.
    const cases = [
      [null, null], [{ type: 'REG_SZ', value: 'a' }, null],
      [null, { type: 'REG_SZ', value: 'a' }],
      [{ type: 'REG_SZ', value: 'a' }, { type: 'REG_SZ', value: 'a' }],
      [{ type: 'REG_SZ', value: 'a' }, { type: 'REG_SZ', value: 'b' }],
      [{ type: 'REG_SZ', value: 'a' }, { type: 'REG_EXPAND_SZ', value: 'a' }],
    ]
    for (const [left, right] of cases) {
      if (!left && !right) continue // no row exists in this state
      const l = left ? [{ path: ROOT, name: 'v', ...left }] : []
      const r = right ? [{ path: ROOT, name: 'v', ...right }] : []
      const fromMain = diffRegistry(l, r)[0].status
      expect(computeStatus(left, right), JSON.stringify({ left, right }))
        .toBe(fromMain)
    }
  })
})

describe('what a cell prints', () => {
  it('turns control characters into something with a width', () => {
    // A REG_MULTI_SZ carries NULs and a REG_SZ can carry a newline. Either one
    // drawn literally makes that row taller than the rest, and the virtual
    // scroller turns a scroll offset into a row index by multiplying — so one
    // tall row puts every row below it under the wrong pointer.
    expect(cellText('a\nb')).toBe('a·b')
    expect(cellText('a\u0000b')).toBe('a·b')
    expect(cellText('a\tb')).toBe('a·b')
  })

  it('cuts a long value and says it did', () => {
    const out = cellText('x'.repeat(5000))
    expect(out.length).toBeLessThan(500)
    expect(out.endsWith('…')).toBe(true)
  })

  it('says so when only part of the value was ever loaded', () => {
    const text = sideText({ type: 'REG_BINARY', value: 'AB', truncated: true, fullLength: 9000 })
    expect(text).toContain('9000')
  })

  it('prints nothing for a side that has no value', () => {
    expect(sideText(null)).toBe('')
  })
})

describe('base keys', () => {
  const rows = [
    { path: `${ROOT}\\A`, name: 'x', type: 'REG_SZ', value: '1' },
    { path: `${ROOT}\\A\\Deep`, name: 'y', type: 'REG_SZ', value: '2' },
    { path: `${ROOT}\\AB`, name: 'z', type: 'REG_SZ', value: '3' },
    { path: `${ROOT}\\B`, name: 'w', type: 'REG_SZ', value: '4' },
  ]

  it('keeps the subtree and drops everything else', () => {
    const out = applyBaseKey(rows, `${ROOT}\\A`)
    expect(out.map((r) => r.name).sort()).toEqual(['x', 'y'])
  })

  it('does not treat a name that merely starts the same as a child', () => {
    // Without the separator check, a base of HKLM\Foo also swallows HKLM\FooBar.
    const out = applyBaseKey(rows, `${ROOT}\\A`)
    expect(out.some((r) => r.name === 'z')).toBe(false)
  })

  it('re-roots both sides at the same token so different keys line up', () => {
    // This is the point of the feature: comparing A against B only works once
    // the differing prefixes are gone.
    const left = applyBaseKey(rows, `${ROOT}\\A`)
    const right = applyBaseKey(
      [{ path: `${ROOT}\\B`, name: 'x', type: 'REG_SZ', value: '1' }], `${ROOT}\\B`)
    expect(left[0].path).toBe(BASE_ROOT)
    expect(right[0].path).toBe(BASE_ROOT)
    expect(diffRegistry(left, right)[0].status).toBe('same')
  })

  it('keeps relative depth below the base', () => {
    const out = applyBaseKey(rows, `${ROOT}\\A`)
    expect(out.find((r) => r.name === 'y').path).toBe(`${BASE_ROOT}\\Deep`)
  })

  it('leaves the rows alone when no base is set', () => {
    expect(applyBaseKey(rows, '')).toBe(rows)
  })
})

describe('walking up a key path', () => {
  it('drops the last segment', () => {
    expect(parentOf('HKEY_LOCAL_MACHINE\\SOFTWARE\\A')).toBe('HKEY_LOCAL_MACHINE\\SOFTWARE')
  })

  it('stops at a root rather than returning half of one', () => {
    expect(parentOf('HKEY_LOCAL_MACHINE')).toBe('')
    expect(parentOf('')).toBe('')
  })
})

describe('the last line of defence before a write', () => {
  it('refuses a shortened value that was never edited', () => {
    expect(() => refuseTruncatedRows([
      { path: ROOT, name: 'big', truncated: true },
    ])).toThrow(/截短/)
  })

  it('names what it refused, so the message is actionable', () => {
    let message = ''
    try {
      refuseTruncatedRows([{ path: ROOT, name: 'big', truncated: true }])
    } catch (err) {
      message = err.message
    }
    expect(message).toContain('big')
    expect(message).toContain(ROOT)
  })

  it('allows a shortened value the user replaced outright', () => {
    // Editing supplies a whole new value, so there is nothing left to lose.
    expect(() => refuseTruncatedRows([
      { path: ROOT, name: 'big', truncated: true, edited: true },
    ])).not.toThrow()
  })

  it('allows ordinary rows and an empty list', () => {
    expect(() => refuseTruncatedRows([{ path: ROOT, name: 'v' }])).not.toThrow()
    expect(() => refuseTruncatedRows([])).not.toThrow()
    expect(() => refuseTruncatedRows(undefined)).not.toThrow()
  })
})

describe('a value the view only holds part of', () => {
  /** Build a view with one truncated left value, without mounting any DOM. */
  function viewWithTruncatedLeft() {
    const view = new RegistryCompare()
    view._roots = buildRegistryTree([
      row(`${ROOT}\\A`, 'huge', 'left-only',
        { type: 'REG_BINARY', value: 'AA BB', truncated: true, fullLength: 9_000_000 }, null),
    ])
    // Nothing is mounted, so the repaint must be a no-op rather than a throw.
    view._refresh = () => {}
    const node = keyAt(view._roots, `${ROOT}\\A`).children[0]
    return { view, node }
  }

  it('refuses to copy it onto the other side', () => {
    // Copying drops the flag, so the result looks edited and complete — the one
    // shape main lets through. The shortened data would then be written to the
    // registry as if it were the whole value.
    const { view, node } = viewWithTruncatedLeft()
    const messages = []
    view.on('status', (m) => messages.push(m))

    view.copyValue(node, 'left')

    expect(node.row.right).toBeNull()
    expect(view.isDirty()).toBe(false)
    expect(messages.map((m) => m.level)).toContain('error')
  })

  it('copies an ordinary value normally', () => {
    // The guard must not block the case it is not about.
    const view = new RegistryCompare()
    view._roots = buildRegistryTree([
      row(`${ROOT}\\A`, 'small', 'left-only', { type: 'REG_SZ', value: 'hello' }, null),
    ])
    view._refresh = () => {}
    const node = keyAt(view._roots, `${ROOT}\\A`).children[0]

    view.copyValue(node, 'left')

    expect(node.row.right.value).toBe('hello')
    expect(node.row.right.edited).toBe(true)
    expect(view.isDirty()).toBe(true)
  })

  it('writes an empty key out so it is not lost on export', () => {
    // The key carries no value, so a walk that only visits value nodes emits
    // nothing for it and the exported file loses the key entirely.
    const view = new RegistryCompare()
    view._roots = buildRegistryTree([
      row(`${ROOT}\\Empty`, '', 'left-only', { type: 'KEY', value: '' }, null),
    ])
    view._refresh = () => {}

    const rows = view.rowsForSide('left')
    expect(rows.some((r) => r.path === `${ROOT}\\Empty`)).toBe(true)
    expect(buildRegFile(rows)).toContain(`[${ROOT}\\Empty]`)

    // It belongs to the left only, so the right side must not claim it.
    expect(view.rowsForSide('right').some((r) => r.path === `${ROOT}\\Empty`)).toBe(false)
  })

  it('writes an explicit deletion, because importing cannot remove a value', () => {
    // `reg import` only adds and overwrites. Leaving a value out of the file
    // changes nothing, so deleting and applying would look like it worked.
    const view = new RegistryCompare()
    view._roots = buildRegistryTree([
      row(`${ROOT}\\A`, 'gone', 'same', { type: 'REG_SZ', value: 'x' }, { type: 'REG_SZ', value: 'x' }),
    ])
    view._refresh = () => {}
    const node = keyAt(view._roots, `${ROOT}\\A`).children[0]

    view.deleteValue(node, 'left')

    const rows = view.rowsForSide('left')
    const deletion = rows.find((r) => r.name === 'gone')
    expect(deletion?.type).toBe('DELETED')
    expect(buildRegFile(rows)).toContain('"gone"=-')
  })

  it('never offers a truncated row for writing without the flag', () => {
    // Whatever route produced the row, what main sees has to still say so.
    const { view, node } = viewWithTruncatedLeft()
    view.copyValue(node, 'left')
    const rows = view.rowsForSide('left')
    expect(rows).toHaveLength(1)
    expect(rows[0].truncated).toBe(true)
    expect(rows[0].edited).toBeUndefined()
  })
})

describe('values too large to send whole', () => {
  const huge = 'A'.repeat(MAX_TRANSFER_VALUE_CHARS + 500)

  it('compares on the full value, then shortens for display', () => {
    // The failure this guards: shortening first, so two values that differ
    // only past the cut are reported as identical.
    const left = [{ path: ROOT, name: 'v', type: 'REG_SZ', value: `${huge}left` }]
    const right = [{ path: ROOT, name: 'v', type: 'REG_SZ', value: `${huge}right` }]

    expect(diffRegistry(left, right)[0].status).toBe('different')
    const shown = diffRegistryForDisplay(left, right)
    expect(shown[0].status).toBe('different')
    expect(shown[0].left.value.length).toBe(MAX_TRANSFER_VALUE_CHARS)
    expect(shown[0].left.truncated).toBe(true)
    expect(shown[0].left.fullLength).toBe(huge.length + 4)
  })

  it('leaves an ordinary value alone', () => {
    const rows = [{ path: ROOT, name: 'v', type: 'REG_SZ', value: 'short' }]
    const shown = diffRegistryForDisplay(rows, rows)
    expect(shown[0].left.truncated).toBeUndefined()
    expect(shown[0].left.value).toBe('short')
  })

  it('drops the original token along with the rest of the value', () => {
    // Keeping `raw` would let a shortened row be written back in full from a
    // token the renderer never checked against what it was showing.
    const rows = [{ path: ROOT, name: 'v', type: 'REG_MULTI_SZ', value: huge, raw: 'hex(7):00,00' }]
    const shown = diffRegistryForDisplay(rows, [])
    expect(shown[0].left.raw).toBeUndefined()
  })
})
