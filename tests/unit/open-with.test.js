/**
 * The "Open With" argument template.
 *
 * This preference had a control that stored a value and nothing that read it,
 * so the configured program was never launched. Now that it is wired, the
 * template is the part with edge cases: a path with spaces has to arrive as
 * ONE argument, and a template that forgets to mention the file must not
 * launch the program against nothing.
 *
 * The result is an argv array handed to execFile, never a shell string, so a
 * path containing shell punctuation is data rather than syntax. That is the
 * property the last group here pins.
 */
import { describe, it, expect } from 'vitest'
import { buildOpenWithArgs } from '../../src/main/open-with.js'

const WIN = 'C:\\Users\\a b\\file.txt'

describe('buildOpenWithArgs', () => {
  it('substitutes the default quoted template into a single argument', () => {
    // The default is `"%1"`. Splitting it into two arguments at the space in
    // the path is the classic form of this bug, and the program then opens a
    // file called "C:\Users\a".
    expect(buildOpenWithArgs('"%1"', WIN)).toEqual([WIN])
  })

  it('keeps flags and the path as separate arguments', () => {
    expect(buildOpenWithArgs('--readonly "%1"', WIN)).toEqual(['--readonly', WIN])
    expect(buildOpenWithArgs('-a -b "%1"', WIN)).toEqual(['-a', '-b', WIN])
  })

  it('substitutes an unquoted %1 too', () => {
    expect(buildOpenWithArgs('%1', WIN)).toEqual([WIN])
  })

  it('substitutes %1 embedded in a larger token', () => {
    expect(buildOpenWithArgs('--file=%1', WIN)).toEqual([`--file=${WIN}`])
  })

  it('replaces every occurrence, not just the first', () => {
    expect(buildOpenWithArgs('%1 %1', WIN)).toEqual([WIN, WIN])
  })

  it('appends the path when the template never mentions it', () => {
    // Otherwise the program launches with no file and the user reads that as
    // "Open With did nothing".
    expect(buildOpenWithArgs('--readonly', WIN)).toEqual(['--readonly', WIN])
    expect(buildOpenWithArgs('', WIN)).toEqual([WIN])
  })

  it('handles single quotes and collapses runs of whitespace', () => {
    expect(buildOpenWithArgs("  --x   '%1'  ", WIN)).toEqual(['--x', WIN])
  })

  it('never leaves an unsubstituted %1 in the result', () => {
    for (const t of ['"%1"', '%1', '--file=%1', '--readonly', '']) {
      for (const a of buildOpenWithArgs(t, WIN)) expect(a).not.toContain('%1')
    }
  })

  it('treats shell punctuation in the path as data', () => {
    // execFile with an argv array never involves a shell, so these are just
    // characters. Pinning it here means a future change to a shell string
    // fails a test rather than becoming a command injection.
    const nasty = 'C:\\tmp\\a & b | c ; d`e$f.txt'
    expect(buildOpenWithArgs('"%1"', nasty)).toEqual([nasty])
    expect(buildOpenWithArgs('--file=%1', nasty)).toEqual([`--file=${nasty}`])
  })

  it('does not invent an argument for an empty path', () => {
    expect(buildOpenWithArgs('--readonly', '')).toEqual(['--readonly', ''])
  })
})
