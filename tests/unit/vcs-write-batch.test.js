/**
 * The Source Control write path: batched, but still per-path about blame.
 *
 * These two properties pull against each other, which is why both are pinned
 * here. One git call per selected file is what makes "select all modified,
 * then 加入索引" freeze the window on a large repository. One git call for the
 * whole set is fast and reports a single exit code, which cannot say which
 * file failed — and this operation's whole output is a per-file summary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolve } from 'path'

/** Every git invocation the module made, in order. */
let calls = []
/** Decides each call's fate. @type {(args: string[]) => void} */
let behaviour = () => {}

vi.mock('child_process', () => ({
  execFile: (file, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb
    calls.push({ file, args })
    try {
      behaviour(args)
      done(null, { stdout: '', stderr: '' })
    } catch (err) {
      done(err, { stdout: '', stderr: String(err?.message ?? err) })
    }
    return {}
  },
}))

const { runVcsCommand, _resetGitProbe } = await import('../../src/main/vcs.js')

const root = resolve('/repo')
const paths = (...names) => names.map((n) => resolve('/repo', n))

beforeEach(() => {
  calls = []
  behaviour = () => {}
  _resetGitProbe()
})

/** git invocations that are not the `--version` probe. */
const writeCalls = () => calls.filter((c) => c.args[0] !== '--version')

describe('runVcsCommand batching', () => {
  it('stages many files with one git call, not one per file', async () => {
    const list = paths('a.js', 'b.js', 'c.js', 'd.js')
    const { results } = await runVcsCommand({ action: 'add', root, paths: list })

    expect(writeCalls()).toHaveLength(1)
    expect(writeCalls()[0].args).toEqual(['add', '--', 'a.js', 'b.js', 'c.js', 'd.js'])
    expect(results.map((r) => r.state)).toEqual(['done', 'done', 'done', 'done'])
    expect(results.map((r) => r.path)).toEqual(list)
  })

  it('still names the file that failed rather than blaming the batch', async () => {
    // The reason the per-path loop existed. A batch that reports one exit code
    // would have to call the whole selection failed, including the files git
    // staged perfectly well.
    behaviour = (args) => {
      if (args.includes('b.js') && args.length > 3) throw new Error('batch failed')
      if (args.includes('b.js')) throw new Error('pathspec b.js did not match')
    }

    const { results } = await runVcsCommand({
      action: 'add', root, paths: paths('a.js', 'b.js', 'c.js'),
    })

    const byName = Object.fromEntries(
      results.map((r) => [r.path.split(/[\\/]/).pop(), r]))
    expect(byName['a.js'].state).toBe('done')
    expect(byName['c.js'].state).toBe('done')
    expect(byName['b.js'].state).toBe('failed')
    expect(byName['b.js'].message).toContain('pathspec')
    // The batch, then one retry per path in it.
    expect(writeCalls()).toHaveLength(4)
  })

  it('does not retry per path when the batch succeeded', async () => {
    // A fallback that always ran would be the original defect wearing a batch.
    await runVcsCommand({ action: 'unstage', root, paths: paths('a.js', 'b.js') })
    expect(writeCalls()).toHaveLength(1)
  })

  it('skips a path outside the repository without spending a git call on it', async () => {
    const { results } = await runVcsCommand({
      action: 'add', root, paths: [...paths('a.js'), resolve('/elsewhere/x.js')],
    })

    const skipped = results.find((r) => r.state === 'skipped')
    expect(skipped, 'the outside path was not refused').toBeTruthy()
    expect(skipped.path).toBe(resolve('/elsewhere/x.js'))
    // The refusal happens before git is asked, and the contained path still
    // goes through.
    expect(writeCalls()).toHaveLength(1)
    expect(writeCalls()[0].args).toEqual(['add', '--', 'a.js'])
  })

  it('refuses an unknown action instead of passing it to git', async () => {
    await expect(runVcsCommand({ action: 'push', root, paths: paths('a.js') }))
      .rejects.toThrow()
    expect(writeCalls()).toHaveLength(0)
  })

  it('splits a very large selection into bounded batches', async () => {
    // Windows caps a command line near 32k characters; an unbounded argument
    // list would fail on the size of the selection rather than on its content.
    const many = paths(...Array.from({ length: 250 }, (_, i) => `f${i}.js`))
    const { results } = await runVcsCommand({ action: 'add', root, paths: many })

    expect(results).toHaveLength(250)
    expect(results.every((r) => r.state === 'done')).toBe(true)
    const batches = writeCalls()
    expect(batches.length).toBeGreaterThan(1)
    for (const c of batches) expect(c.args.length - 2).toBeLessThanOrEqual(100)
  })
})
