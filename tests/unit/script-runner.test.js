/**
 * Script execution engine — safety guarantees, command semantics, state.
 *
 * Every test runs against an in-memory filesystem so a bug in the engine can
 * never delete anything real, and so "a dry run performed no write" is an
 * assertion rather than an inspection.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { join, dirname, basename } from 'path'
import { parseScript } from '../../src/main/script.js'
import {
  runScript,
  createContext,
  maskMatcher,
  applyRenamePattern,
  DEFAULT_DELETE_LIMIT,
  UNIMPLEMENTED_COMMANDS,
} from '../../src/main/script-runner.js'

const L = join('/ws', 'left')
const R = join('/ws', 'right')

/**
 * Fake {@link import('../../src/main/script-runner.js').ScriptFs} recording
 * every mutating call.
 * @param {Record<string, { content?: string, mtimeMs?: number, dir?: boolean }>} spec
 */
function makeFs(spec) {
  /** @type {Map<string, { content: string, mtimeMs: number, dir: boolean }>} */
  const files = new Map()
  const addDir = (d) => {
    while (d && !files.has(d)) {
      files.set(d, { content: '', mtimeMs: 0, dir: true })
      const parent = dirname(d)
      if (parent === d) break
      d = parent
    }
  }
  for (const [p, v] of Object.entries(spec)) {
    if (v.dir) { addDir(p); continue }
    addDir(dirname(p))
    files.set(p, { content: v.content ?? '', mtimeMs: v.mtimeMs ?? 1000, dir: false })
  }

  /** @type {string[]} */
  const writes = []
  const fs = {
    files,
    writes,
    async readdir(p) {
      const out = []
      for (const key of files.keys()) {
        if (key !== p && dirname(key) === p) out.push(basename(key))
      }
      return out
    },
    async stat(p) {
      const f = files.get(p)
      return f ? { isDirectory: f.dir, size: f.content.length, mtimeMs: f.mtimeMs } : null
    },
    async readFile(p) {
      const f = files.get(p)
      if (!f) throw new Error(`ENOENT ${p}`)
      return f.content
    },
    async writeFile(p, content) {
      writes.push(`writeFile ${p}`)
      addDir(dirname(p))
      files.set(p, { content, mtimeMs: 2000, dir: false })
    },
    async copyFile(src, dest) {
      writes.push(`copyFile ${src} ${dest}`)
      const f = files.get(src)
      if (!f) throw new Error(`ENOENT ${src}`)
      files.set(dest, { ...f })
    },
    async unlink(p) {
      writes.push(`unlink ${p}`)
      files.delete(p)
    },
    async rename(from, to) {
      writes.push(`rename ${from} ${to}`)
      const f = files.get(from)
      files.delete(from)
      files.set(to, f)
    },
    async mkdirp(p) {
      writes.push(`mkdirp ${p}`)
      addDir(p)
    },
    async utimes(p, mtimeMs) {
      writes.push(`utimes ${p}`)
      const f = files.get(p)
      if (f) f.mtimeMs = mtimeMs
    },
  }
  return fs
}

/** Allow-list behaving like path-validator, but seeded only by `load`. */
function makeGuard() {
  /** @type {Set<string>} */
  const roots = new Set()
  return {
    roots,
    registerRoot: (p) => { if (p) roots.add(String(p)) },
    validatePath: (p) => {
      const s = String(p ?? '')
      for (const root of roots) {
        if (s === root || s.startsWith(root + '/') || s.startsWith(root + '\\')) return s
      }
      throw new Error(`Access denied: ${s} is not within any opened root`)
    },
  }
}

/**
 * @param {string} src
 * @param {{ fs?: object, execute?: boolean, deleteLimit?: number, guard?: object }} [opts]
 */
async function run(src, opts = {}) {
  const { commands, errors } = parseScript(src)
  expect(errors).toEqual([])
  const fs = opts.fs ?? defaultFs()
  const guard = opts.guard ?? makeGuard()
  const result = await runScript(commands, {
    execute: opts.execute === true,
    deleteLimit: opts.deleteLimit,
    fs,
    validatePath: guard.validatePath,
    registerRoot: guard.registerRoot,
    now: new Date('2026-01-01T00:00:00Z'),
  })
  return { result, fs, guard }
}

function defaultFs() {
  return makeFs({
    [join(L, 'same.txt')]: { content: 'a', mtimeMs: 1000 },
    [join(L, 'diff.txt')]: { content: 'left', mtimeMs: 3000 },
    [join(L, 'onlyleft.txt')]: { content: 'l', mtimeMs: 1000 },
    [join(L, 'sub', 'nested.txt')]: { content: 'n', mtimeMs: 1000 },
    [join(R, 'same.txt')]: { content: 'a', mtimeMs: 1000 },
    [join(R, 'diff.txt')]: { content: 'rightish', mtimeMs: 2000 },
    [join(R, 'onlyright.txt')]: { content: 'r', mtimeMs: 1000 },
  })
}

const script = (...lines) => lines.join('\n')

let fsFixture
beforeEach(() => { fsFixture = defaultFs() })

describe('dry run is the default', () => {
  it('performs no filesystem write for a destructive script', async () => {
    const { result, fs } = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      'select all',
      'copy left->right',
      'delete left',
    ), { fs: fsFixture })

    expect(result.ok).toBe(true)
    expect(result.execute).toBe(false)
    expect(fs.writes).toEqual([])
    expect(result.planned).toBeGreaterThan(0)
    expect(result.completed).toBe(0)
  })

  it('still reports what it would have done, per operation', async () => {
    const { result } = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      'select left.orphan',
      'copy left->right',
    ), { fs: fsFixture })

    expect(result.operations.map((o) => o.kind)).toEqual(['copy', 'mkdir', 'copy'])
    expect(result.operations.every((o) => o.done === false)).toBe(true)
    expect(result.output.join('\n')).toContain('[預演]')
    expect(result.output.join('\n')).toContain('預計操作：3')
  })
})

describe('/execute actually runs', () => {
  it('copies the selected files and marks the operations done', async () => {
    const { result, fs } = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      'select left.orphan',
      'copy left->right',
    ), { fs: fsFixture, execute: true })

    expect(result.ok).toBe(true)
    expect(fs.writes.some((w) => w.startsWith('copyFile'))).toBe(true)
    expect(fs.files.has(join(R, 'onlyleft.txt'))).toBe(true)
    expect(result.completed).toBe(result.planned)
    expect(result.operations.every((o) => o.done)).toBe(true)
  })

  it('deletes only on the named side', async () => {
    const { fs } = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      'select right.orphan',
      'delete right',
    ), { fs: fsFixture, execute: true })

    expect(fs.files.has(join(R, 'onlyright.txt'))).toBe(false)
    expect(fs.files.has(join(L, 'onlyleft.txt'))).toBe(true)
  })

  it('move copies then removes the source', async () => {
    const { fs } = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      'select left.orphan',
      'move left->right',
    ), { fs: fsFixture, execute: true })

    expect(fs.files.has(join(R, 'onlyleft.txt'))).toBe(true)
    expect(fs.files.has(join(L, 'onlyleft.txt'))).toBe(false)
  })
})

describe('path containment', () => {
  it('refuses a destination that was never loaded', async () => {
    const { result, fs } = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      'select all',
      'copyto left /elsewhere',
    ), { fs: fsFixture, execute: true })

    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain('Access denied')
    expect(fs.writes).toEqual([])
  })

  it('accepts a destination that a later load did register', async () => {
    const fs = makeFs({
      [join(L, 'a.txt')]: { content: 'a' },
      [join(R, 'a.txt')]: { content: 'b' },
      [join('/ws', 'out')]: { dir: true },
    })
    const { result } = await run(script(
      `load "${join('/ws', 'out')}" "${join('/ws', 'out')}"`,
      `load "${L}" "${R}"`,
      'expand all',
      'select all',
      `copyto left "${join('/ws', 'out')}"`,
    ), { fs, execute: true })

    expect(result.ok).toBe(true)
    expect(fs.files.has(join('/ws', 'out', 'a.txt'))).toBe(true)
  })

  it('load itself registers only the paths the script named', async () => {
    const { guard } = await run(`load "${L}" "${R}"`, { fs: fsFixture })
    expect([...guard.roots]).toEqual([L, R])
  })
})

describe('delete cap', () => {
  it('aborts before writing when the script deletes more than the limit', async () => {
    const spec = {}
    for (let i = 0; i < 10; i++) spec[join(L, `f${i}.txt`)] = { content: 'x' }
    spec[R] = { dir: true }
    const fs = makeFs(spec)

    const { result } = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      'select all',
      'delete left',
    ), { fs, execute: true, deleteLimit: 3 })

    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain('超過上限 3')
    expect(fs.writes).toEqual([])
  })

  it('has a conservative default', () => {
    expect(DEFAULT_DELETE_LIMIT).toBe(100)
    expect(createContext().deleteLimit).toBe(100)
  })

  it('can be widened only by an explicit option command', async () => {
    const spec = {}
    for (let i = 0; i < 5; i++) spec[join(L, `f${i}.txt`)] = { content: 'x' }
    spec[R] = { dir: true }
    const fs = makeFs(spec)

    const { result } = await run(script(
      `load "${L}" "${R}"`,
      'option delete-limit 50',
      'expand all',
      'select all',
      'delete left',
    ), { fs, execute: true, deleteLimit: 2 })

    expect(result.ok).toBe(true)
    expect(result.context.deleteLimit).toBe(50)
  })
})

describe('fail fast', () => {
  it('stops at the failing line and names it', async () => {
    const { result, fs } = await run(script(
      `load "${L}" "${R}"`,   // line 1
      'expand all',           // line 2
      'select bogus-thing',   // line 3 — fails
      'delete left',          // line 4 — must not run
    ), { fs: fsFixture, execute: true })

    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].line).toBe(3)
    expect(result.errors[0].message).toContain('select')
    expect(fs.writes).toEqual([])
    expect(result.output.join('\n')).toContain('第 3 行失敗')
  })

  it('refuses commands issued before a load', async () => {
    const { result } = await run('select all', { fs: fsFixture })
    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain('尚未 load')
  })

  it('reports a missing load target instead of comparing nothing', async () => {
    const { result } = await run(`load "${join('/ws', 'nope')}" "${R}"`, { fs: fsFixture })
    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain('不存在')
  })
})

describe('comparison and selection state', () => {
  it('classifies each pair', async () => {
    const { result } = await run(script(`load "${L}" "${R}"`, 'expand all', 'select all'), { fs: fsFixture })
    const byRel = Object.fromEntries(result.context.entries.map((e) => [e.rel, e.state]))
    expect(byRel['same.txt']).toBe('same')
    expect(byRel['diff.txt']).toBe('diff')
    expect(byRel['onlyleft.txt']).toBe('left-orphan')
    expect(byRel['onlyright.txt']).toBe('right-orphan')
    expect(byRel['sub/nested.txt']).toBe('left-orphan')
  })

  it('select diff picks only the non-identical pairs', async () => {
    const { result } = await run(script(`load "${L}" "${R}"`, 'expand all', 'select diff'), { fs: fsFixture })
    expect(result.context.selection.map((e) => e.rel).sort())
      .toEqual(['diff.txt', 'onlyleft.txt', 'onlyright.txt', 'sub/nested.txt'])
  })

  it('select left.newer uses timestamps', async () => {
    const { result } = await run(script(`load "${L}" "${R}"`, 'expand all', 'select left.newer'), { fs: fsFixture })
    expect(result.context.selection.map((e) => e.rel)).toEqual(['diff.txt'])
  })

  it('accepts BC lt/rt spelling and the .files suffix', async () => {
    const { result } = await run(script(`load "${L}" "${R}"`, 'expand all', 'select lt.orphan.files'), { fs: fsFixture })
    expect(result.context.selection.map((e) => e.rel).sort()).toEqual(['onlyleft.txt', 'sub/nested.txt'])
  })

  it('a collapsed tree hides nested entries from selection', async () => {
    const { result } = await run(script(`load "${L}" "${R}"`, 'select all'), { fs: fsFixture })
    expect(result.context.selection.map((e) => e.rel)).not.toContain('sub/nested.txt')
    expect(result.context.expandedAll).toBe(false)
  })

  it('expand of a single folder reveals just that folder', async () => {
    const { result } = await run(script(`load "${L}" "${R}"`, 'expand sub', 'select all'), { fs: fsFixture })
    expect(result.context.selection.map((e) => e.rel)).toContain('sub/nested.txt')
  })

  it('filter narrows the compared set', async () => {
    const { result } = await run(script(`load "${L}" "${R}"`, 'filter *.md', 'expand all', 'select all'), { fs: fsFixture })
    expect(result.context.entries).toHaveLength(0)
    expect(result.context.filter).toBe('*.md')
  })

  it('criteria size only treats a same-size pair as identical', async () => {
    const fs = makeFs({
      [join(L, 'a.txt')]: { content: 'ab', mtimeMs: 1000 },
      [join(R, 'a.txt')]: { content: 'cd', mtimeMs: 9000 },
    })
    const { result } = await run(script(`load "${L}" "${R}"`, 'criteria size', 'expand all', 'select diff'), { fs })
    expect(result.context.selection).toHaveLength(0)
  })

  it('criteria binary reads the bytes when sizes match', async () => {
    const fs = makeFs({
      [join(L, 'a.txt')]: { content: 'ab', mtimeMs: 1000 },
      [join(R, 'a.txt')]: { content: 'cd', mtimeMs: 1000 },
    })
    const { result } = await run(script(`load "${L}" "${R}"`, 'criteria binary', 'expand all', 'select diff'), { fs })
    expect(result.context.selection.map((e) => e.rel)).toEqual(['a.txt'])
  })

  it('rejects a criterion it cannot honour rather than guessing', async () => {
    const { result } = await run(script(`load "${L}" "${R}"`, 'criteria pixels'), { fs: fsFixture })
    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain('pixels')
  })
})

describe('operation lists', () => {
  it('copy plans one operation per selected file, plus any missing parent', async () => {
    const { result } = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      'select lt.orphan',
      'copy left->right',
    ), { fs: fsFixture })

    const kinds = result.operations.map((o) => o.kind)
    expect(kinds).toContain('mkdir')
    expect(result.operations.filter((o) => o.kind === 'copy').map((o) => o.dest).sort())
      .toEqual([join(R, 'onlyleft.txt'), join(R, 'sub', 'nested.txt')].sort())
  })

  it('sync update copies newer and orphan files one way only', async () => {
    const { result } = await run(script(
      `load "${L}" "${R}"`,
      'sync update:lt->rt',
    ), { fs: fsFixture })

    const dests = result.operations.filter((o) => o.kind === 'copy').map((o) => o.dest)
    expect(dests).toContain(join(R, 'diff.txt'))
    expect(dests).toContain(join(R, 'onlyleft.txt'))
    expect(dests.some((d) => d.includes('same.txt'))).toBe(false)
    expect(result.operations.some((o) => o.kind === 'delete')).toBe(false)
  })

  it('sync mirror also removes files the source no longer has', async () => {
    const { result } = await run(script(
      `load "${L}" "${R}"`,
      'sync mirror:lt->rt',
    ), { fs: fsFixture })

    expect(result.operations.filter((o) => o.kind === 'delete').map((o) => o.src))
      .toEqual([join(R, 'onlyright.txt')])
  })

  it('touch plans a timestamp write on the named side only', async () => {
    const { result } = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      'select diff',
      'touch right',
    ), { fs: fsFixture })

    expect(result.operations.map((o) => ({ kind: o.kind, dest: o.dest })))
      .toEqual([{ kind: 'touch', dest: join(R, 'diff.txt') }])
  })

  it('rename applies the mask on both existing sides', async () => {
    const { result } = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      'select all',
      'rename same.txt *.bak',
    ), { fs: fsFixture })

    expect(result.operations.map((o) => o.dest).sort())
      .toEqual([join(L, 'same.bak'), join(R, 'same.bak')].sort())
  })
})

describe('reports', () => {
  it('writes a folder report to the requested file, but only when executing', async () => {
    const dest = join(L, 'report.txt')
    const dry = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      `folder-report output-to:"${dest}"`,
    ), { fs: fsFixture })
    expect(dry.fs.writes).toEqual([])
    expect(dry.result.operations.map((o) => o.kind)).toEqual(['report'])

    const wet = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      `folder-report output-to:"${dest}"`,
    ), { fs: defaultFs(), execute: true })
    expect(wet.fs.files.get(dest).content).toContain('資料夾比對報表')
    expect(wet.fs.files.get(dest).content).toContain('僅左側')
  })

  it('prints the report when no output-to is given', async () => {
    const { result, fs } = await run(script(
      `load "${L}" "${R}"`,
      'expand all',
      'folder-report',
    ), { fs: fsFixture, execute: true })
    expect(fs.writes).toEqual([])
    expect(result.output.join('\n')).toContain('資料夾比對報表')
  })

  it('text-report diffs a file session', async () => {
    const fs = makeFs({
      [join('/ws', 'a.txt')]: { content: 'one\ntwo\n' },
      [join('/ws', 'b.txt')]: { content: 'one\nTWO\n' },
    })
    const { result } = await run(script(
      `load "${join('/ws', 'a.txt')}" "${join('/ws', 'b.txt')}"`,
      'text-report',
    ), { fs })
    expect(result.ok).toBe(true)
    expect(result.output.join('\n')).toContain('文字比對報表')
    expect(result.output.join('\n')).toContain('replace')
  })

  it('says why text-report cannot run on a folder session', async () => {
    const { result } = await run(script(`load "${L}" "${R}"`, 'text-report'), { fs: fsFixture })
    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain('兩個檔案')
  })
})

describe('unimplemented commands', () => {
  it('are reported by name and line, not silently skipped', async () => {
    const { result } = await run(script(
      `load "${L}" "${R}"`,
      'snapshot /ws/left',
      'hex-report',
    ), { fs: fsFixture })

    expect(result.ok).toBe(true)
    expect(result.unimplemented).toEqual([
      { line: 2, name: 'snapshot' },
      { line: 3, name: 'hex-report' },
    ])
    expect(result.output.join('\n')).toContain('未實作')
  })

  it('lists exactly the commands that were left out', () => {
    expect([...UNIMPLEMENTED_COMMANDS].sort()).toEqual([
      'attrib', 'data-report', 'file-report', 'hex-report', 'picture-report', 'snapshot',
    ])
  })
})

describe('bookkeeping commands', () => {
  it('log records its target and writes only on execute', async () => {
    const dest = join(L, 'run.log')
    const dry = await run(script(`load "${L}" "${R}"`, `log verbose "${dest}"`), { fs: fsFixture })
    expect(dry.result.context.logPath).toBe(dest)
    expect(dry.fs.writes).toEqual([])

    const wet = await run(script(`load "${L}" "${R}"`, `log verbose "${dest}"`), { fs: defaultFs(), execute: true })
    expect(wet.fs.files.has(dest)).toBe(true)
  })

  it('option values land in the context', async () => {
    const { result } = await run(script(`load "${L}" "${R}"`, 'option confirm yes-to-all'), { fs: fsFixture })
    expect(result.context.options.confirm).toBe('yes-to-all')
  })

  it('beep is harmless', async () => {
    const { result, fs } = await run('beep', { fs: fsFixture })
    expect(result.ok).toBe(true)
    expect(fs.writes).toEqual([])
  })
})

describe('mask helpers', () => {
  it('matches include masks case-insensitively', () => {
    const m = maskMatcher('*.js;*.ts')
    expect(m('a.JS')).toBe(true)
    expect(m('a.css')).toBe(false)
  })

  it('honours exclusions ahead of inclusions', () => {
    const m = maskMatcher('*.js;-*.min.js')
    expect(m('a.js')).toBe(true)
    expect(m('a.min.js')).toBe(false)
  })

  it('an empty mask matches everything', () => {
    expect(maskMatcher('')('anything')).toBe(true)
    expect(maskMatcher(undefined)('anything')).toBe(true)
  })

  it('rename patterns substitute the stem for *', () => {
    expect(applyRenamePattern('a.txt', '*.bak')).toBe('a.bak')
    expect(applyRenamePattern('a.txt', 'fixed.txt')).toBe('fixed.txt')
  })
})
