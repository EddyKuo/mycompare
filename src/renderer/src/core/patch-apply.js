/**
 * @file patch-apply.js
 * @description Applying a parsed unified diff to the text it was made against.
 *
 *   This is the only part of the patch feature that writes anything, so the
 *   rules are deliberately strict:
 *
 *   - **A file is all-or-nothing.** `patch(1)` applies what it can and leaves
 *     the rest in a .rej file. A GUI that half-applied a patch would leave the
 *     user with a file that is neither the old one nor the new one and no note
 *     saying so, which is the failure mode this project treats as worst. If any
 *     hunk fails, nothing is written and every failure is named.
 *   - **Context is verified, not assumed.** A hunk carries the lines it expects
 *     to find. Writing without checking them is how a patch silently lands in
 *     the wrong place when the file has moved on.
 *   - **Offsets are a hint.** Real files drift, so a hunk is searched for near
 *     its stated line before being declared failed — the same tolerance
 *     `patch(1)` has, and the reason a slightly stale patch still applies.
 */

/** How far from the stated position a hunk may be found. */
export const SEARCH_RADIUS = 200

/**
 * @typedef {import('./patch.js').PatchHunk} PatchHunk
 * @typedef {{ ok: boolean, text: string, applied: number,
 *             failures: Array<{ hunk: PatchHunk, reason: string }> }} ApplyResult
 */

/**
 * The lines a hunk expects to already be present.
 *
 * @param {PatchHunk} hunk
 * @returns {string[]}
 */
export function expectedLines(hunk) {
  return hunk.lines.filter((l) => l.type === ' ' || l.type === '-').map((l) => l.text)
}

/**
 * The lines a hunk leaves behind.
 *
 * @param {PatchHunk} hunk
 * @returns {string[]}
 */
export function resultLines(hunk) {
  return hunk.lines.filter((l) => l.type === ' ' || l.type === '+').map((l) => l.text)
}

/**
 * Does `expected` sit at `at` in `lines`?
 *
 * @param {string[]} lines
 * @param {number} at 0-based
 * @param {string[]} expected
 * @returns {boolean}
 */
function matchesAt(lines, at, expected) {
  if (at < 0 || at + expected.length > lines.length) return false
  for (let i = 0; i < expected.length; i++) {
    if (lines[at + i] !== expected[i]) return false
  }
  return true
}

/**
 * Where a hunk actually applies, or -1.
 *
 * Searches outward from the stated position so a patch made against a slightly
 * older copy still lands, which is what `patch(1)` does and what makes the
 * difference between "applies" and "rejected" on real files.
 *
 * @param {string[]} lines
 * @param {PatchHunk} hunk
 * @param {number} [radius]
 * @returns {number} 0-based line index, or -1
 */
export function locateHunk(lines, hunk, radius = SEARCH_RADIUS) {
  const expected = expectedLines(hunk)
  // An empty expectation (a pure insertion into an empty file) can only go
  // where the header says.
  const stated = Math.max(0, hunk.oldStart - 1)
  if (expected.length === 0) return stated <= lines.length ? stated : -1

  if (matchesAt(lines, stated, expected)) return stated
  for (let d = 1; d <= radius; d++) {
    if (matchesAt(lines, stated - d, expected)) return stated - d
    if (matchesAt(lines, stated + d, expected)) return stated + d
  }
  return -1
}

/**
 * Apply every hunk of one file, or none of them.
 *
 * @param {string} source the file as it is now
 * @param {PatchHunk[]} hunks
 * @param {{ radius?: number }} [opts]
 * @returns {ApplyResult}
 */
export function applyHunks(source, hunks, opts = {}) {
  const lines = String(source ?? '').split('\n')
  const list = hunks ?? []
  /** @type {Array<{ hunk: PatchHunk, reason: string }>} */
  const failures = []

  // Locate everything first. Applying as we go would mean a failure halfway
  // through leaves the earlier hunks already applied — the half-written state
  // this refuses to produce.
  /** @type {Array<{ hunk: PatchHunk, at: number }>} */
  const placed = []
  for (const hunk of list) {
    const at = locateHunk(lines, hunk, opts.radius)
    if (at === -1) {
      failures.push({ hunk, reason: `找不到第 ${hunk.oldStart} 行附近相符的內容` })
      continue
    }
    placed.push({ hunk, at })
  }

  // Two hunks that resolve onto the same lines would corrupt each other.
  const sorted = [...placed].sort((a, b) => a.at - b.at)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const prevEnd = prev.at + expectedLines(prev.hunk).length
    if (sorted[i].at < prevEnd) {
      failures.push({ hunk: sorted[i].hunk, reason: '與前一個區塊重疊' })
    }
  }

  if (failures.length) {
    return { ok: false, text: String(source ?? ''), applied: 0, failures }
  }

  // Rebuild back to front so earlier offsets stay valid.
  let out = lines
  for (const { hunk, at } of [...sorted].reverse()) {
    out = out
      .slice(0, at)
      .concat(resultLines(hunk), out.slice(at + expectedLines(hunk).length))
  }
  return { ok: true, text: out.join('\n'), applied: sorted.length, failures: [] }
}

/**
 * The path a patched file should be written to.
 *
 * Patches carry `a/` and `b/` prefixes from git; a viewer that wrote to a
 * literal `b/src/x.js` would create a directory nobody asked for.
 *
 * @param {{ oldPath: string, newPath: string }} file
 * @returns {string}
 */
export function targetPath(file) {
  const pick = file?.newPath && file.newPath !== '/dev/null' ? file.newPath : file?.oldPath
  return String(pick ?? '').replace(/^[ab]\//, '')
}
