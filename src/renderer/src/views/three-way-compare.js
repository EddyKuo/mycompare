/**
 * @file three-way-compare.js
 * @description 3-Way Text Merge view: Left | Base | Right → Output
 */

import { diffLines } from '../core/diff-engine.js'
import { tagConfig, readConfig } from '../core/named-config-store.js'
import { stepDiffIndex, getNavOptions } from '../core/diff-nav.js'
import { renderTextTable, reportHeader } from '../core/report.js'
import { toast } from '../core/toast.js'
import { getGrammarForPath, computeLineWeights, isRiskyRegexSource } from '../core/grammar.js'
// Imported here rather than from the renderer entry so the view stays
// self-contained; the bundler emits it once no matter how many tabs mount.
import '../styles/merge-compare.css'

/**
 * Size above which one pane is compared without grammar line weights.
 * Tokenizing is linear but not free, and three panes pay it.
 */
const MAX_WEIGHT_ALIGN_CHARS = 1_000_000

// ---------------------------------------------------------------------------
// S13-C01: 3-way merge helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Convert a `diffLines(base, side)` result into hunks describing the edits
 * that `side` made to `base`. Each hunk has a half-open base range
 * `[baseStart, baseEnd)` and the lines that replace it.
 *
 * @param {ReturnType<typeof diffLines>} diff
 * @returns {Array<{ baseStart: number, baseEnd: number, newLines: string[] }>}
 */
export function _buildHunks(diff) {
  const hunks = []
  let cur = null
  let baseIdx = 0
  const strip = (s) => (s ?? '').replace(/\r?\n$/, '')

  const flush = () => { if (cur) { hunks.push(cur); cur = null } }

  for (const dl of diff) {
    if (dl.type === 'equal') { flush(); baseIdx++; continue }
    if (!cur) cur = { baseStart: baseIdx, baseEnd: baseIdx, newLines: [] }
    if (dl.type === 'delete')      { cur.baseEnd = ++baseIdx }
    else if (dl.type === 'insert') { cur.newLines.push(strip(dl.rightText)) }
    else if (dl.type === 'replace'){ cur.baseEnd = ++baseIdx; cur.newLines.push(strip(dl.rightText)) }
  }
  flush()
  return hunks
}

function _arraysEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Ceiling for the conflict proximity threshold. Past this the whole file
 * collapses into one conflict, which is the same as having no merge at all.
 */
export const MAX_CONFLICT_PROXIMITY = 100

/**
 * Coerce an arbitrary value into a usable proximity threshold.
 *
 * Zero is the default and reproduces the "only genuinely overlapping edits
 * conflict" behaviour exactly, so raising it is always an opt-in.
 *
 * @param {unknown} n
 * @returns {number}
 */
export function normalizeConflictProximity(n) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v < 0) return 0
  return Math.min(MAX_CONFLICT_PROXIMITY, v)
}

/**
 * Clean a list of manually forced conflict ranges.
 *
 * Ranges are half-open over 0-based base line indices. Out-of-range, empty and
 * overlapping entries are folded away here rather than in the merge loop,
 * which would otherwise have to defend against each of them on every line.
 *
 * @param {unknown} ranges
 * @param {number} baseLineCount
 * @returns {Array<{ start: number, end: number }>} sorted, disjoint
 */
export function normalizeForcedRanges(ranges, baseLineCount) {
  const max = Math.max(0, Math.floor(Number(baseLineCount) || 0))
  const cleaned = []
  for (const r of Array.isArray(ranges) ? ranges : []) {
    const start = Math.max(0, Math.min(max, Math.floor(Number(r?.start))))
    const end = Math.max(0, Math.min(max, Math.floor(Number(r?.end))))
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    cleaned.push({ start, end })
  }
  cleaned.sort((a, b) => a.start - b.start || a.end - b.end)

  /** @type {Array<{ start: number, end: number }>} */
  const merged = []
  for (const r of cleaned) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

/**
 * Rebuild one side's version of a base range from the hunks it applied there.
 *
 * The obvious shortcut — "the side's lines are just the hunk's newLines" —
 * only holds when the cluster is exactly one hunk covering the whole range.
 * As soon as two edits are grouped (which a proximity threshold above zero
 * makes routine) the base lines *between* them belong to both sides and would
 * otherwise be dropped from the conflict card and from the output.
 *
 * @param {string[]} baseLines
 * @param {Array<{ baseStart: number, baseEnd: number, newLines: string[] }>} hunks
 *   sorted, non-overlapping, all inside [start, end)
 * @param {number} start
 * @param {number} end
 * @returns {string[]}
 */
export function applyHunkRange(baseLines, hunks, start, end) {
  const out = []
  let cursor = start
  for (const h of hunks) {
    if (h.baseStart > cursor) out.push(...baseLines.slice(cursor, Math.min(h.baseStart, end)))
    out.push(...h.newLines)
    cursor = Math.max(cursor, h.baseEnd)
  }
  if (cursor < end) out.push(...baseLines.slice(cursor, end))
  return out
}

/**
 * Turn base lines plus each side's hunks into merge segments.
 *
 * Extracted from the view so the two rules that decide what a conflict *is* —
 * the proximity threshold and the manual marks — can be tested without a DOM,
 * and so the equality used to decide "both sides made the same edit" can be
 * swapped for one that ignores unimportant differences.
 *
 * @param {string[]} baseLines
 * @param {Array<{ baseStart: number, baseEnd: number, newLines: string[] }>} leftHunks
 * @param {Array<{ baseStart: number, baseEnd: number, newLines: string[] }>} rightHunks
 * @param {{
 *   proximity?: number,
 *   forced?: Array<{ start: number, end: number }>,
 *   equals?: (a: string[], b: string[]) => boolean,
 * }} [opts]
 * @returns {{ segments: MergeSegment[], hasConflicts: boolean }}
 */
export function mergeHunkSegments(baseLines, leftHunks, rightHunks, opts = {}) {
  const lines = baseLines || []
  const lh = leftHunks || []
  const rh = rightHunks || []
  const proximity = normalizeConflictProximity(opts.proximity ?? 0)
  const forced = normalizeForcedRanges(opts.forced ?? [], lines.length)
  const equals = opts.equals ?? _arraysEqual

  /** @type {MergeSegment[]} */
  const segments = []
  let hasConflicts = false
  let conflictId = 0

  /** @type {string[]} */
  let pendingNormal = []
  const flushNormal = () => {
    if (pendingNormal.length > 0) {
      segments.push({ type: 'normal', lines: pendingNormal, kind: 'same' })
      pendingNormal = []
    }
  }

  let i = 0, li = 0, ri = 0
  while (i < lines.length || li < lh.length || ri < rh.length) {
    const forcedHere = forced.find((f) => f.start === i)
    const triggered = forcedHere != null ||
      (lh[li] && lh[li].baseStart === i) ||
      (rh[ri] && rh[ri].baseStart === i)

    if (!triggered) {
      if (i < lines.length) { pendingNormal.push(lines[i]); i++; continue }
      // A hunk left behind by a range that already swallowed it. Skipping it
      // rather than breaking keeps a malformed diff from truncating the merge.
      if (lh[li] && lh[li].baseStart < i) { li++; continue }
      if (rh[ri] && rh[ri].baseStart < i) { ri++; continue }
      break
    }

    const liBefore = li
    const riBefore = ri
    /** @type {Array<{ baseStart: number, baseEnd: number, newLines: string[] }>} */
    const lTaken = []
    /** @type {Array<{ baseStart: number, baseEnd: number, newLines: string[] }>} */
    const rTaken = []
    let end = i
    let isForced = false
    if (forcedHere) { isForced = true; end = Math.max(end, forcedHere.end) }

    // Grow the cluster until nothing else reaches into it. Iterated rather
    // than done in one pass because absorbing a hunk moves `end` forward,
    // which can bring a further hunk within the threshold.
    let grew = true
    while (grew) {
      grew = false
      while (lh[li] && (lh[li].baseStart === i || lh[li].baseStart < end + proximity)) {
        const h = lh[li++]
        lTaken.push(h)
        if (h.baseEnd > end) { end = h.baseEnd; grew = true }
      }
      while (rh[ri] && (rh[ri].baseStart === i || rh[ri].baseStart < end + proximity)) {
        const h = rh[ri++]
        rTaken.push(h)
        if (h.baseEnd > end) { end = h.baseEnd; grew = true }
      }
      for (const f of forced) {
        if (f.start >= i && f.start < end + proximity && f.end > end) {
          end = f.end
          isForced = true
          grew = true
        }
      }
    }

    const baseSlice = lines.slice(i, end)
    const leftLines = lTaken.length ? applyHunkRange(lines, lTaken, i, end) : baseSlice
    const rightLines = rTaken.length ? applyHunkRange(lines, rTaken, i, end) : baseSlice

    flushNormal()
    if (isForced || (lTaken.length > 0 && rTaken.length > 0 && !equals(leftLines, rightLines))) {
      hasConflicts = true
      segments.push({
        type: 'conflict',
        id: conflictId++,
        leftLines,
        baseLines: baseSlice,
        rightLines,
        // Kept so navigation can compute a scroll offset without walking the
        // segment list to reconstruct base positions.
        baseStart: i,
      })
    } else if (lTaken.length > 0 && rTaken.length > 0) {
      segments.push({
        type: 'normal',
        lines: leftLines,
        kind: equals(leftLines, baseSlice) ? 'same' : 'both',
      })
    } else if (lTaken.length > 0) {
      segments.push({
        type: 'normal',
        lines: leftLines,
        kind: equals(leftLines, baseSlice) ? 'same' : 'left',
      })
    } else if (rTaken.length > 0) {
      segments.push({
        type: 'normal',
        lines: rightLines,
        kind: equals(rightLines, baseSlice) ? 'same' : 'right',
      })
    } else {
      // Forced range with no edits under it: still a conflict, handled above.
      segments.push({ type: 'normal', lines: baseSlice, kind: 'same' })
    }

    // A pure insertion has zero width in base coordinates, so `i` must stay
    // put — advancing it would skip the base line the insertion sits before.
    // Progress is still guaranteed because the hunk itself was consumed; the
    // fallback only covers a malformed hunk list that consumed nothing.
    if (end > i) i = end
    else if (li === liBefore && ri === riBefore && !isForced) i++
  }
  flushNormal()

  return { segments, hasConflicts }
}

/**
 * @typedef {'same'|'left'|'right'|'both'} NormalSegmentKind
 * @typedef {{ type: 'normal', lines: string[], kind?: NormalSegmentKind }} NormalSegment
 * @typedef {{ type: 'conflict', id: number, leftLines: string[], baseLines: string[], rightLines: string[], baseStart?: number }} ConflictSegment
 * @typedef {NormalSegment | ConflictSegment} MergeSegment
 *
 * `both` is BC's "Take Left Then Right"; `both-rl` the reverse order. Two
 * distinct values rather than one plus an order flag, because the order is a
 * property of the resolution and has to survive in the same place the choice
 * does (reports, config snapshots, the card's active button).
 *
 * @typedef {'left'|'right'|'base'|'both'|'both-rl'} ConflictChoice
 */

/** Every value `setConflictChoice` / `resolveAll` accept. @type {ConflictChoice[]} */
export const CONFLICT_CHOICES = ['left', 'right', 'base', 'both', 'both-rl']

/**
 * @param {unknown} c
 * @returns {c is ConflictChoice}
 */
export function isConflictChoice(c) {
  return typeof c === 'string' && CONFLICT_CHOICES.includes(/** @type {ConflictChoice} */ (c))
}

/**
 * Which half of the view is given the whole window.
 *
 * `sources` and `output` are one field rather than two booleans because they
 * are mutually exclusive by construction — collapsing both would leave nothing
 * on screen — and a single enum makes that unrepresentable instead of merely
 * discouraged.
 *
 * @typedef {'none'|'output'|'sources'} MaximizeMode
 */

/** @type {MaximizeMode[]} */
export const MAXIMIZE_MODES = ['none', 'output', 'sources']

/**
 * @param {unknown} m
 * @returns {m is MaximizeMode}
 */
export function isMaximizeMode(m) {
  return typeof m === 'string' && MAXIMIZE_MODES.includes(/** @type {MaximizeMode} */ (m))
}

/**
 * How a segment relates to the base, which is the only thing the display
 * filters below need to know about it.
 *
 * @typedef {NormalSegmentKind|'conflict'} SegmentKind
 */

/**
 * The BC display filter set.
 *
 * @typedef {'all'|'changes'|'left-changes'|'right-changes'|'conflicts'
 *   |'mergeable'|'unchanged'|'same'|'none'} ShowFilterMode
 */

/**
 * Modes in menu order. Exported so a caller can build its own picker without
 * duplicating the list — and so a test can assert none was forgotten.
 *
 * @type {ShowFilterMode[]}
 */
export const SHOW_FILTER_MODES = [
  'all', 'changes', 'left-changes', 'right-changes',
  'conflicts', 'mergeable', 'unchanged', 'same', 'none',
]

/** @type {Record<ShowFilterMode, string>} */
const SHOW_FILTER_LABELS = {
  all: '全部',
  changes: '差異',
  'left-changes': '左側變更',
  'right-changes': '右側變更',
  conflicts: '僅衝突',
  mergeable: '可自動合併',
  unchanged: '未變更',
  same: '左右相同',
  none: '無',
}

/**
 * @param {unknown} mode
 * @returns {mode is ShowFilterMode}
 */
export function isShowFilterMode(mode) {
  return typeof mode === 'string' && SHOW_FILTER_MODES.includes(/** @type {ShowFilterMode} */ (mode))
}

/**
 * Classify one segment.
 *
 * A normal segment written before kinds existed (or by a test fixture) carries
 * no `kind`; treating it as unchanged keeps the old two-mode behaviour intact.
 *
 * @param {MergeSegment} seg
 * @returns {SegmentKind}
 */
export function segmentKind(seg) {
  if (!seg) return 'same'
  if (seg.type === 'conflict') return 'conflict'
  return seg.kind ?? 'same'
}

/**
 * Whether a segment survives one display filter.
 *
 * `unchanged` and `same` differ on segments where both sides made the *same*
 * edit: they changed relative to base (so they are not unchanged) but left and
 * right agree (so they are the same as each other).
 *
 * @param {MergeSegment} seg
 * @param {ShowFilterMode} mode
 * @returns {boolean}
 */
export function segmentMatchesFilter(seg, mode) {
  const kind = segmentKind(seg)
  switch (mode) {
    case 'none':          return false
    case 'changes':       return kind !== 'same'
    case 'left-changes':  return kind === 'left' || kind === 'both' || kind === 'conflict'
    case 'right-changes': return kind === 'right' || kind === 'both' || kind === 'conflict'
    case 'conflicts':     return kind === 'conflict'
    case 'mergeable':     return kind === 'left' || kind === 'right' || kind === 'both'
    case 'unchanged':     return kind === 'same'
    case 'same':          return kind === 'same' || kind === 'both'
    default:              return true
  }
}

// ---------------------------------------------------------------------------
// S16-M01: conflict navigation / filtering / output assembly (pure, testable)
// ---------------------------------------------------------------------------

/** Lines of surrounding context kept per conflict in 'conflicts' filter mode. */
const CONFLICT_CONTEXT_LINES = 2

/**
 * Ceiling for the Show Context control. Beyond this the filtered view is
 * indistinguishable from showing everything, so the number stops being useful.
 */
export const MAX_CONTEXT_LINES = 100

/**
 * Coerce an arbitrary value into a usable context-line count.
 * @param {unknown} n
 * @returns {number}
 */
export function normalizeContextLines(n) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v < 0) return CONFLICT_CONTEXT_LINES
  return Math.min(MAX_CONTEXT_LINES, v)
}

/**
 * @param {MergeSegment[]} segments
 * @returns {number[]} conflict ids in document order
 */
export function collectConflictIds(segments) {
  const ids = []
  for (const seg of segments || []) {
    if (seg && seg.type === 'conflict') ids.push(seg.id)
  }
  return ids
}

/**
 * Wrap-around cursor arithmetic for conflict navigation.
 *
 * A separate function because the "no conflicts" and "nothing selected yet"
 * cases are the two that actually break in practice: stepping from -1 must
 * land on an end of the list rather than on index -2 / 0-by-accident.
 *
 * @param {number} current  current index, -1 when nothing is selected
 * @param {number} delta    +1 next, -1 previous
 * @param {number} count    total conflicts
 * @returns {number} next index, or -1 when there is nothing to select
 */
export function wrapConflictIndex(current, delta, count) {
  if (!Number.isFinite(count) || count <= 0) return -1
  if (current < 0 || current >= count) return delta >= 0 ? 0 : count - 1
  return ((current + delta) % count + count) % count
}

/**
 * Reduce segments to conflicts plus a little surrounding context.
 *
 * @param {MergeSegment[]} segments
 * @param {number} [contextLines]
 * @returns {MergeSegment[]}
 */
export function filterSegmentsForConflicts(segments, contextLines = CONFLICT_CONTEXT_LINES) {
  const src = segments || []
  const out = []
  for (let i = 0; i < src.length; i++) {
    const seg = src[i]
    if (seg.type === 'conflict') { out.push(seg); continue }

    const afterConflict = i > 0 && src[i - 1].type === 'conflict'
    const beforeConflict = i + 1 < src.length && src[i + 1].type === 'conflict'
    if (!afterConflict && !beforeConflict) continue

    const n = Math.max(0, contextLines)
    const head = afterConflict ? seg.lines.slice(0, n) : []
    const tail = beforeConflict ? seg.lines.slice(Math.max(head.length, seg.lines.length - n)) : []
    const lines = [...head, ...tail]
    if (lines.length > 0) out.push({ type: 'normal', lines })
  }
  return out
}

/**
 * The segments one display filter leaves visible.
 *
 * Filtering happens here, on the data, and never in CSS: the panes are
 * virtualised, so a hidden row would still occupy its slot in the spacer
 * height and push every following row out of place.
 *
 * @param {MergeSegment[]} segments
 * @param {ShowFilterMode} mode
 * @param {number} [contextLines] only used by the 'conflicts' mode
 * @returns {MergeSegment[]}
 */
export function filterSegments(segments, mode, contextLines = CONFLICT_CONTEXT_LINES) {
  const src = segments || []
  if (mode === 'all') return src
  if (mode === 'none') return []
  // Conflicts keep surrounding context; a conflict with no lead-in is unreadable.
  if (mode === 'conflicts') return filterSegmentsForConflicts(src, contextLines)
  return src.filter((seg) => segmentMatchesFilter(seg, mode))
}

/**
 * Assemble the merged text from segments and the current choices.
 * Unresolved conflicts keep their `<<<` markers so nothing is silently lost.
 *
 * @param {MergeSegment[]} segments
 * @param {Map<number, ConflictChoice|null>} choices
 * @returns {string}
 */
export function buildMergedText(segments, choices) {
  return (segments || []).map(seg => {
    if (seg.type === 'normal') return seg.lines.join('\n')
    const choice = choices?.get(seg.id)
    if (choice === 'left')  return seg.leftLines.join('\n')
    if (choice === 'right') return seg.rightLines.join('\n')
    if (choice === 'base')  return seg.baseLines.join('\n')
    if (choice === 'both')  return [...seg.leftLines, ...seg.rightLines].join('\n')
    if (choice === 'both-rl') return [...seg.rightLines, ...seg.leftLines].join('\n')
    return ['<<<<<<< LEFT', ...seg.leftLines, '||||||| BASE', ...seg.baseLines, '=======', ...seg.rightLines, '>>>>>>> RIGHT'].join('\n')
  }).join('\n')
}

/**
 * Row a conflict starts on, in the coordinate space the panes scroll in.
 *
 * Once the panes are virtualised, "reveal the conflict" can no longer be left
 * to the browser — the target row usually is not in the DOM at all, so the
 * scroll offset has to be computed.
 *
 * The three panes share one scrollTop, so no single row index can be exact for
 * all of them; base-line coordinates are used, which are exact for the base
 * pane and off by the length difference of preceding edits for left/right.
 *
 * @param {MergeSegment[]} segments
 * @param {number} conflictId
 * @param {ShowFilterMode} [showFilter]
 * @param {number} [contextLines]
 * @returns {number} row index, or -1 when the conflict is not present
 */
export function conflictPaneRow(segments, conflictId, showFilter = 'all', contextLines = CONFLICT_CONTEXT_LINES) {
  const src = segments || []

  if (showFilter !== 'all') {
    // In every filtered mode the row index has to be counted, because the rows
    // before the conflict are no longer the base lines before it. A conflict
    // the filter drops reports -1, so navigation leaves the scroll alone.
    let row = 0
    for (const seg of filterSegments(src, showFilter, contextLines)) {
      if (seg.type === 'conflict') {
        if (seg.id === conflictId) return row
        row += seg.baseLines.length
      } else {
        row += seg.lines.length
      }
    }
    return -1
  }

  for (const seg of src) {
    if (seg.type === 'conflict' && seg.id === conflictId) {
      return Number.isFinite(seg.baseStart) ? /** @type {number} */ (seg.baseStart) : -1
    }
  }
  return -1
}

/**
 * Flatten segments into the lines one pane should show.
 *
 * @param {MergeSegment[]} segments
 * @param {'left'|'base'|'right'} side
 * @returns {Array<{ text: string, conflict: boolean }>}
 */
export function segmentsToPaneLines(segments, side) {
  const key = /** @type {'leftLines'|'baseLines'|'rightLines'} */ (`${side}Lines`)
  const out = []
  for (const seg of segments || []) {
    if (seg.type === 'normal') {
      for (const text of seg.lines) out.push({ text, conflict: false })
    } else {
      for (const text of seg[key]) out.push({ text, conflict: true })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// S16-M02: virtual scrolling (pure, testable)
// ---------------------------------------------------------------------------

/** Fixed row height, in px. Virtualisation cannot work with wrapping rows. */
const ROW_HEIGHT = 18

/** Rows rendered beyond each edge of the viewport, to hide scroll latency. */
const OVERSCAN_ROWS = 8

/**
 * Viewport height assumed when the pane reports 0 — it is hidden, detached or
 * not laid out yet. Rendering *something* beats rendering a blank pane that
 * only fills in after the user happens to scroll.
 */
const VIEWPORT_HEIGHT_FALLBACK = 600

/** A normal segment longer than this is elided in the output *preview* only. */
const OUTPUT_PREVIEW_MAX_LINES = 200

/**
 * @typedef {{
 *   type: 'equal'|'insert'|'delete'|'replace'|'conflict'|'left'|'right'|'both',
 *   lineNum: number|null,
 *   text: string
 * }} PaneRow
 */

/**
 * Row type used for each normal-segment kind in the filtered modes.
 * @type {Record<NormalSegmentKind, PaneRow['type']>}
 */
const KIND_ROW_TYPE = { same: 'equal', left: 'left', right: 'right', both: 'both' }

/**
 * Half-open row range `[start, end)` that has to exist in the DOM.
 *
 * @param {number} scrollTop
 * @param {number} viewportHeight  pane clientHeight; 0 falls back (see above)
 * @param {number} totalRows
 * @param {number} [rowHeight]
 * @param {number} [overscan]
 * @returns {{ start: number, end: number }}
 */
export function computeVisibleRange(scrollTop, viewportHeight, totalRows, rowHeight = ROW_HEIGHT, overscan = OVERSCAN_ROWS) {
  const total = Number.isFinite(totalRows) && totalRows > 0 ? Math.floor(totalRows) : 0
  if (total === 0) return { start: 0, end: 0 }

  const rh = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : ROW_HEIGHT
  const over = Number.isFinite(overscan) && overscan > 0 ? Math.floor(overscan) : 0
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : VIEWPORT_HEIGHT_FALLBACK
  const top = Number.isFinite(scrollTop) && scrollTop > 0 ? Math.min(scrollTop, total * rh) : 0

  const start = Math.max(0, Math.floor(top / rh) - over)
  const end = Math.min(total, Math.ceil((top + height) / rh) + over)
  return { start, end: Math.max(start, end) }
}

/** @param {string|null|undefined} s */
const _stripEol = (s) => (s ?? '').replace(/\r?\n$/, '')

/**
 * Flatten a base→side diff into displayable rows.
 *
 * Left and right panes map identically: both show the "right" side of their
 * own diff, with base line numbers on unchanged rows.
 *
 * @param {import('../core/diff-engine.js').DiffLine[]|null} diff
 * @returns {PaneRow[]}
 */
export function diffToPaneRows(diff) {
  /** @type {PaneRow[]} */
  const rows = []
  for (const dl of diff || []) {
    switch (dl.type) {
      case 'insert':
        rows.push({ type: 'insert', lineNum: dl.rightLine ?? null, text: _stripEol(dl.rightText) })
        break
      case 'replace':
        rows.push({ type: 'replace', lineNum: dl.rightLine ?? null, text: _stripEol(dl.rightText) })
        break
      case 'delete':
        rows.push({ type: 'delete', lineNum: null, text: _stripEol(dl.leftText) })
        break
      default:
        rows.push({ type: 'equal', lineNum: dl.leftLine ?? null, text: _stripEol(dl.leftText) })
    }
  }
  return rows
}

/**
 * The full row list one pane would show — the unit of virtualisation.
 *
 * Both display modes end up as a flat array here, which is what lets one
 * windowing implementation serve them: 'conflicts' only changes *which* rows
 * exist, never how they are positioned.
 *
 * @param {'left'|'base'|'right'} side
 * @param {{
 *   showFilter?: ShowFilterMode,
 *   segments?: MergeSegment[],
 *   content?: string,
 *   diff?: import('../core/diff-engine.js').DiffLine[]|null,
 *   contextLines?: number,
 * }} [opts]
 * @returns {PaneRow[]}
 */
export function buildPaneRows(side, opts = {}) {
  const {
    showFilter = 'all', segments = [], content = '', diff = null,
    contextLines = CONFLICT_CONTEXT_LINES,
  } = opts

  if (showFilter !== 'all') {
    const key = /** @type {'leftLines'|'baseLines'|'rightLines'} */ (`${side}Lines`)
    /** @type {PaneRow[]} */
    const rows = []
    for (const seg of filterSegments(segments || [], showFilter, contextLines)) {
      // Line numbers are omitted: filtered output is not contiguous.
      if (seg.type === 'conflict') {
        for (const text of seg[key]) rows.push({ type: 'conflict', lineNum: null, text })
      } else {
        const type = KIND_ROW_TYPE[seg.kind ?? 'same'] ?? 'equal'
        for (const text of seg.lines) rows.push({ type, lineNum: null, text })
      }
    }
    return rows
  }

  if (!diff) {
    return (content || '').split('\n').map((text, i) => ({
      type: /** @type {PaneRow['type']} */ ('equal'),
      lineNum: i + 1,
      text,
    }))
  }
  return diffToPaneRows(diff)
}

/**
 * Ceiling for a dropped text file, in characters. Beyond this the merge would
 * hold three copies plus every diff structure derived from them.
 */
export const MAX_MERGE_CHARS = 20_000_000

/** Report labels for a conflict's resolution state. */
const CHOICE_LABELS = {
  left: '採用左側',
  right: '採用右側',
  base: '採用基準',
  both: '採用兩者（左→右）',
  'both-rl': '採用兩者（右→左）',
  none: '未解決',
}

/** How much of a conflict's first line a report shows. */
const PREVIEW_CHARS = 60

/** Human labels for the three input panes. */
const SIDE_LABELS = { left: '左側', base: '基底', right: '右側' }

/** Rows the in-view "compare to output" preview renders before eliding. */
export const OUTPUT_DIFF_MAX_ROWS = 2000

/**
 * The directory part of a path, for Merge Parent Folders.
 *
 * Both separators are handled because a session can carry Windows paths while
 * the renderer runs on a POSIX build in tests.
 *
 * @param {string} p
 * @returns {string} '' when the path has no directory part
 */
export function parentDirOf(p) {
  const s = String(p ?? '')
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  if (cut < 0) return ''
  // Keep the root's own separator: 'C:\a' → 'C:\', '/a' → '/'.
  return cut === 0 ? s.slice(0, 1) : s.slice(0, cut)
}

/**
 * One line, trimmed and clipped, safe to place in a table cell.
 * @param {string} text
 * @returns {string}
 */
function _previewLine(text) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!one) return '（空行）'
  return one.length > PREVIEW_CHARS ? `${one.slice(0, PREVIEW_CHARS)}…` : one
}

// ---------------------------------------------------------------------------
// ThreeWayCompare
// ---------------------------------------------------------------------------

export class ThreeWayCompare {
  constructor() {
    /** @type {HTMLElement|null} */
    this._container = null

    this._leftPath = ''
    this._basePath = ''
    this._rightPath = ''
    this._leftContent = ''
    this._baseContent = ''
    this._rightContent = ''

    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map()

    /** @type {{ left: HTMLElement|null, base: HTMLElement|null, right: HTMLElement|null }} */
    this._contentEls = { left: null, base: null, right: null }
    /** @type {HTMLTextAreaElement|null} */
    this._outputEl = null

    /** @type {HTMLElement|null} */
    this._outputPaneEl = null

    /** @type {Array<{ pane: HTMLElement, handler: Function }>|null} */
    this._syncScrollHandlers = null

    /** @type {(() => void)|null} Removes the drag & drop listeners on destroy */
    this._dropCleanup = null

    /**
     * Parsed segments from the last _threeWayMerge call.
     * @type {MergeSegment[]}
     */
    this._segments = []

    /**
     * User choices for each conflict segment.
     * Key: conflict id (number), Value: choice or null when unresolved.
     * @type {Map<number, ConflictChoice|null>}
     */
    this._conflictChoices = new Map()

    /** @type {import('../core/diff-engine.js').DiffLine[]|null} */
    this._leftDiff = null
    /** @type {import('../core/diff-engine.js').DiffLine[]|null} */
    this._rightDiff = null

    /** Index (not id) of the conflict the navigation cursor is on; -1 = none. */
    this._currentConflict = -1
    /** @type {boolean} set by setSide, consumed after the next merge */
    this._pendingFirstDiff = false

    /** @type {ShowFilterMode} */
    this._showFilter = 'all'

    /** Full row lists per pane; only a window of these reaches the DOM. */
    /** @type {{ left: PaneRow[], base: PaneRow[], right: PaneRow[] }} */
    this._paneRows = { left: [], base: [], right: [] }

    /** Last rendered window, kept so redundant scroll events cost nothing. */
    this._renderedRange = { start: -1, end: -1 }

    /**
     * The offset the three panes share, tracked rather than read back.
     *
     * A pane hidden by a layout change reports 0 and ignores writes, so once
     * one is collapsed the DOM can no longer say where the user was. Every
     * scroll goes through here, and every layout change pushes it back out.
     */
    this._scrollTop = 0

    /** BC's hide-centre: the ancestor is only needed while judging a conflict. */
    this._showBase = true

    /**
     * The project denies `setWindowOpenHandler` on purpose, so BC's detached
     * output window is expressed as "the output takes the whole view" instead.
     * @type {MaximizeMode}
     */
    this._maximize = 'none'

    /** Line-number gutter, matching the toggle the text view already has. */
    this._showLineNumbers = true

    /**
     * The inline height the drag handle left on the output pane, parked while
     * a maximise mode overrides it. Null means "not currently overridden";
     * an empty string is a real saved value (the pane was never dragged).
     * @type {string|null}
     */
    this._savedOutputHeight = null

    /** @type {'myers'|'patience'|'histogram'} */
    this._algorithm = 'myers'
    /** Whether grammar line weights feed the alignment (BC line weights). */
    this._alignByGrammar = true
    this._ignoreWhitespace = false
    this._ignoreCase = false

    /** Lines of lead-in/lead-out kept around each conflict in 'conflicts' mode. */
    this._contextLines = CONFLICT_CONTEXT_LINES

    /**
     * BC's Favor Left/Right Changes: a standing preference that resolves every
     * conflict towards one side, including conflicts produced by later merges.
     * @type {'none'|'left'|'right'}
     */
    this._favor = 'none'

    /**
     * BC's conflict proximity: edits this many base lines apart are treated as
     * one conflict. Zero — only genuinely overlapping edits conflict — is the
     * default so raising it is always the user's decision.
     */
    this._conflictProximity = 0

    /**
     * Base ranges the user forced into a conflict, half-open and 0-based.
     * @type {Array<{ start: number, end: number }>}
     */
    this._manualConflicts = []

    /** BC's Ignore Unimportant Differences. */
    this._ignoreUnimportant = false
    /** Regex sources whose matches are stripped before lines are compared. @type {string[]} */
    this._unimportantPatterns = []
    /** Compiled `_unimportantPatterns`, keyed by source. @type {Map<string, RegExp|null>} */
    this._unimportantCache = new Map()

    /**
     * The output pane's free-text edit. Null means "the output is whatever the
     * conflict choices produce"; a string means the user has taken it over,
     * which is the only state in which this view holds unsaved work.
     * @type {string|null}
     */
    this._outputOverride = null
    /** Whether the output pane is showing its editor rather than the cards. */
    this._outputEditing = false
    /** True once an override has been made and not yet saved or discarded. */
    this._outputDirty = false

    // Bound once: it is handed to a pure function on every merge, and a fresh
    // closure per merge would defeat nothing but cost an allocation.
    this._segmentEquals = (a, b) => this._linesEqual(a, b)
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Load one pane's content programmatically.
   *
   * Callers previously reached for a `_setContents` method that never existed;
   * the optional-call syntax meant the failure was silent, so restoring a
   * merge session and the e2e test hook both quietly did nothing.
   *
   * @param {'left'|'base'|'right'} side
   * @param {string} content
   * @param {string} [path]
   */
  setSide(side, content, path) {
    if (side !== 'left' && side !== 'base' && side !== 'right') return
    this[`_${side}Content`] = content ?? ''
    if (path != null) this[`_${side}Path`] = path
    const pathEl = this._pathEl(side)
    if (pathEl && path != null) pathEl.textContent = path
    // New content invalidates both: an override written against the previous
    // merge would silently become the output for a document it never saw, and
    // marks are base line ranges that a new ancestor renumbers.
    this._outputOverride = null
    this._outputDirty = false
    if (side === 'base') {
      this._manualConflicts = normalizeForcedRanges(
        this._manualConflicts, (this._baseContent || '').split('\n').length)
    }
    this._pendingFirstDiff = true
    this._runMerge()
    this._emit('paths-changed', {
      left: this._leftPath,
      base: this._basePath,
      right: this._rightPath,
    })
  }

  /** @returns {number} number of conflicts in the current merge */
  getConflictCount() {
    return collectConflictIds(this._segments).length
  }

  /** @returns {number} index of the focused conflict, -1 when none */
  getCurrentConflictIndex() {
    return this._currentConflict
  }

  /**
   * Whether navigation wraps is the shared Next Difference option, not a
   * merge-specific rule; this view used to wrap unconditionally.
   *
   * @returns {number} the index landed on, -1 when there are no conflicts
   */
  nextConflict() {
    return this._gotoConflict(stepDiffIndex(this._currentConflict, this.getConflictCount(), 1))
  }

  /** @returns {number} */
  prevConflict() {
    return this._gotoConflict(stepDiffIndex(this._currentConflict, this.getConflictCount(), -1))
  }

  /** @returns {number} */
  firstConflict() {
    return this._gotoConflict(this.getConflictCount() > 0 ? 0 : -1)
  }

  /** @returns {number} */
  lastConflict() {
    const count = this.getConflictCount()
    return this._gotoConflict(count > 0 ? count - 1 : -1)
  }

  /**
   * Restrict the side panes to one class of segment, or show everything.
   * An unknown mode is ignored rather than blanking the panes.
   *
   * @param {ShowFilterMode} mode
   */
  setShowFilter(mode) {
    if (!isShowFilterMode(mode)) return
    this._showFilter = mode
    this._renderSides()
    this._updateFilterButton()
  }

  /** @returns {ShowFilterMode} */
  getShowFilter() {
    return this._showFilter
  }

  // ---------------------------------------------------------------------------
  // Pane layout
  // ---------------------------------------------------------------------------

  /**
   * Show or hide the base (centre) pane.
   *
   * @param {boolean} on
   * @returns {boolean} the state after the call
   */
  setBaseVisible(on) {
    const next = Boolean(on)
    if (next === this._showBase) return this._showBase
    this._showBase = next
    this._applyLayout()
    this._emit('status', { message: next ? '已顯示基準窗格' : '已隱藏基準窗格' })
    return this._showBase
  }

  /** @returns {boolean} */
  isBaseVisible() {
    return this._showBase
  }

  /** @returns {boolean} the state after the call */
  toggleBaseVisible() {
    return this.setBaseVisible(!this._showBase)
  }

  /**
   * Give the whole view to the output, to the three sources, or to neither.
   *
   * @param {MaximizeMode} mode
   * @returns {MaximizeMode} the mode actually in force
   */
  setMaximize(mode) {
    if (!isMaximizeMode(mode) || mode === this._maximize) return this._maximize
    this._maximize = mode
    this._applyLayout()
    this._emit('status', {
      message: mode === 'output' ? '合併輸出已放大'
        : mode === 'sources' ? '來源窗格已放大'
          : '版面已回到四窗格',
    })
    return this._maximize
  }

  /** @returns {MaximizeMode} */
  getMaximize() {
    return this._maximize
  }

  /**
   * BC's "open the output in its own window", expressed as a maximise because
   * this app denies `setWindowOpenHandler`. Pressing it again restores.
   *
   * @returns {MaximizeMode}
   */
  toggleMaximizeOutput() {
    return this.setMaximize(this._maximize === 'output' ? 'none' : 'output')
  }

  /** @returns {MaximizeMode} */
  toggleMaximizeSources() {
    return this.setMaximize(this._maximize === 'sources' ? 'none' : 'sources')
  }

  /**
   * @param {boolean} on
   * @returns {boolean} the state after the call
   */
  setLineNumbers(on) {
    const next = Boolean(on)
    if (next === this._showLineNumbers) return this._showLineNumbers
    this._showLineNumbers = next
    this._applyLayout()
    return this._showLineNumbers
  }

  /** @returns {boolean} */
  getLineNumbers() {
    return this._showLineNumbers
  }

  /** @returns {boolean} the state after the call */
  toggleLineNumbers() {
    return this.setLineNumbers(!this._showLineNumbers)
  }

  /** Put every layout control back to the shipped default. */
  resetLayout() {
    this._showBase = true
    this._maximize = 'none'
    this._showLineNumbers = true
    this._applyLayout()
    this._emit('status', { message: '版面已重設' })
  }

  /**
   * BC's Show Context: how many surrounding lines survive the 'conflicts'
   * filter. Only that mode reads it, so changing it in any other mode stores
   * the value without disturbing what is on screen.
   *
   * @param {unknown} n
   * @returns {number} the value actually stored
   */
  setContextLines(n) {
    const next = normalizeContextLines(n)
    if (next === this._contextLines) return next
    this._contextLines = next
    this._syncContextInput()
    if (this._showFilter === 'conflicts') this._renderSides()
    return next
  }

  /** @returns {number} */
  getContextLines() {
    return this._contextLines
  }

  /**
   * BC's Favor Left / Favor Right Changes.
   *
   * A standing preference rather than a one-shot batch: conflicts created by a
   * later re-merge (a different algorithm, a reloaded file) are resolved the
   * same way, which is the whole point of "favor". Setting it applies to the
   * conflicts already on screen too; 'none' leaves existing choices alone
   * because silently discarding resolved work would lose the user's edits.
   *
   * @param {'none'|'left'|'right'} side
   * @returns {number} how many conflicts this call resolved
   */
  setFavor(side) {
    if (side !== 'none' && side !== 'left' && side !== 'right') return 0
    this._favor = side
    this._syncFavorSelect()
    if (side === 'none') return 0
    return this._applyFavor()
  }

  /** @returns {'none'|'left'|'right'} */
  getFavor() {
    return this._favor
  }

  /**
   * Resolve still-unresolved conflicts towards the favoured side.
   * @returns {number}
   */
  _applyFavor() {
    const n = this._applyFavorSilently()
    if (n > 0) this._renderOutputPane()
    return n
  }

  /**
   * The same resolution without repainting, for callers that are about to
   * render anyway.
   * @returns {number}
   */
  _applyFavorSilently() {
    if (this._favor === 'none') return 0
    let n = 0
    for (const [id, cur] of this._conflictChoices) {
      if (cur == null) { this._conflictChoices.set(id, this._favor); n++ }
    }
    return n
  }

  /**
   * Choose the line-alignment algorithm the base→left and base→right diffs
   * use. Changing it changes which hunks overlap, so the merge is redone.
   *
   * @param {'myers'|'patience'|'histogram'} algorithm
   */
  setAlgorithm(algorithm) {
    if (algorithm !== 'myers' && algorithm !== 'patience' && algorithm !== 'histogram') return
    if (algorithm === this._algorithm) return
    this._algorithm = algorithm
    this._runMerge()
  }

  /** @returns {'myers'|'patience'|'histogram'} */
  getAlgorithm() {
    return this._algorithm
  }

  /**
   * Record a choice for one conflict.
   * @param {number} id
   * @param {ConflictChoice} choice
   */
  setConflictChoice(id, choice) {
    if (!this._conflictChoices.has(id)) return
    if (!isConflictChoice(choice)) return
    // A hand-edited output is the user's text, not a projection of the
    // choices; silently regenerating it here would delete their work.
    if (this._outputOverride != null) {
      this._reportError('輸出已手動編輯，請先「捨棄手動編輯」再選擇衝突來源。')
      return
    }
    this._conflictChoices.set(id, choice)
    this._renderOutputPane()
    // BC's "go to next difference after copying to other side": resolving a
    // conflict is this view's equivalent of a copy.
    if (getNavOptions().nextAfterCopy) this.nextConflict()
  }

  /**
   * Apply one choice to every *unresolved* conflict; already-resolved
   * conflicts are left alone so a batch action cannot undo manual work.
   *
   * @param {ConflictChoice} choice
   * @returns {number} how many conflicts were changed
   */
  resolveAll(choice) {
    if (!isConflictChoice(choice)) return 0
    if (this._outputOverride != null) {
      this._reportError('輸出已手動編輯，請先「捨棄手動編輯」再批次解決衝突。')
      return 0
    }
    let n = 0
    for (const [id, cur] of this._conflictChoices) {
      if (cur == null) { this._conflictChoices.set(id, choice); n++ }
    }
    if (n > 0) this._renderOutputPane()
    return n
  }

  // ---------------------------------------------------------------------------
  // Unimportant differences
  // ---------------------------------------------------------------------------

  /**
   * @param {string} src
   * @returns {RegExp|null}
   */
  _compileUnimportant(src) {
    if (this._unimportantCache.has(src)) return this._unimportantCache.get(src) ?? null
    // The patterns come from the user, so a source that can backtrack
    // exponentially is refused rather than run — the same screen the grammar
    // system applies to its own user-supplied regexes.
    const risk = isRiskyRegexSource(src)
    let re = null
    if (risk) {
      this._reportError(`忽略樣式「${src}」未套用：${risk}`)
    } else {
      try {
        re = new RegExp(src, 'g')
      } catch (err) {
        this._reportError(`忽略樣式「${src}」無效：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this._unimportantCache.set(src, re)
    return re
  }

  /**
   * One line with every unimportant match removed.
   * @param {string} line
   * @returns {string}
   */
  _stripUnimportant(line) {
    let out = String(line ?? '')
    for (const src of this._unimportantPatterns) {
      const re = this._compileUnimportant(src)
      if (!re) continue
      re.lastIndex = 0
      out = out.replace(re, '')
    }
    return out
  }

  /**
   * Whether two runs of lines count as the same content.
   *
   * With Ignore Unimportant Differences on, "the same" means the same once the
   * unimportant patterns are removed — which is what turns a pair of edits
   * that differ only cosmetically into an auto-merge instead of a conflict.
   *
   * @param {string[]} a
   * @param {string[]} b
   * @returns {boolean}
   */
  _linesEqual(a, b) {
    if (_arraysEqual(a, b)) return true
    if (!this._ignoreUnimportant || this._unimportantPatterns.length === 0) return false
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (this._stripUnimportant(a[i]) !== this._stripUnimportant(b[i])) return false
    }
    return true
  }

  /**
   * BC's Ignore Unimportant Differences.
   * @param {boolean} [on] omit to toggle
   * @returns {boolean} the resulting state
   */
  setIgnoreUnimportant(on) {
    const next = on ?? !this._ignoreUnimportant
    if (next === this._ignoreUnimportant) return next
    this._ignoreUnimportant = next
    this._runMerge()
    this._syncUnimportantControls()
    return next
  }

  /** @returns {boolean} */
  getIgnoreUnimportant() {
    return this._ignoreUnimportant
  }

  /**
   * Replace the unimportant-pattern list. Sources are kept verbatim so the
   * editor can show what the user typed; screening happens at compile time.
   *
   * @param {string[]} patterns
   * @returns {string[]} the list actually stored
   */
  setUnimportantPatterns(patterns) {
    this._unimportantPatterns = (Array.isArray(patterns) ? patterns : [])
      .map((p) => String(p ?? '').trim())
      .filter(Boolean)
    this._unimportantCache.clear()
    this._runMerge()
    this._syncUnimportantControls()
    return [...this._unimportantPatterns]
  }

  /** @returns {string[]} */
  getUnimportantPatterns() {
    return [...this._unimportantPatterns]
  }

  // ---------------------------------------------------------------------------
  // Conflict proximity / manual conflicts
  // ---------------------------------------------------------------------------

  /**
   * BC's conflict proximity: how close two opposing edits have to be, in base
   * lines, before they are reported as one conflict instead of two independent
   * changes that merge cleanly.
   *
   * @param {unknown} n
   * @returns {number} the value actually stored
   */
  setConflictProximity(n) {
    const next = normalizeConflictProximity(n)
    if (next === this._conflictProximity) return next
    this._conflictProximity = next
    this._runMerge()
    return next
  }

  /** @returns {number} */
  getConflictProximity() {
    return this._conflictProximity
  }

  /**
   * Force a run of base lines to be reported as a conflict, whatever the
   * diffs say. BC's manual Conflict mark: the merge is right but the change
   * needs a human, and only the human knows that.
   *
   * @param {number} startLine 1-based, inclusive
   * @param {number} endLine   1-based, inclusive
   * @returns {boolean} whether a mark was added
   */
  markConflictRange(startLine, endLine) {
    const total = (this._baseContent || '').split('\n').length
    const a = Math.floor(Number(startLine))
    const b = Math.floor(Number(endLine))
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
    const start = Math.max(0, Math.min(a, b) - 1)
    const end = Math.min(total, Math.max(a, b))
    if (end <= start) return false

    this._manualConflicts = normalizeForcedRanges(
      [...this._manualConflicts, { start, end }], total)
    this._runMerge()
    return true
  }

  /** @returns {number} how many marks were removed */
  clearManualConflicts() {
    const n = this._manualConflicts.length
    if (n === 0) return 0
    this._manualConflicts = []
    this._runMerge()
    return n
  }

  /** @returns {Array<{ start: number, end: number }>} 0-based, half-open */
  getManualConflicts() {
    return this._manualConflicts.map((r) => ({ ...r }))
  }

  // ---------------------------------------------------------------------------
  // Editable output
  // ---------------------------------------------------------------------------

  /**
   * Take over the merged output as free text.
   *
   * @param {string} text
   * @returns {boolean} whether the override changed
   */
  setOutputText(text) {
    const next = String(text ?? '')
    if (this._outputOverride === next) return false
    this._outputOverride = next
    this._outputDirty = true
    this._renderOutputPane()
    this._emit('output-changed', { edited: true })
    return true
  }

  /** @returns {string} the text a save would write */
  getOutputText() {
    return this._buildOutputText()
  }

  /** @returns {boolean} whether the output is hand-edited rather than generated */
  isOutputEdited() {
    return this._outputOverride != null
  }

  /**
   * Throw the hand edit away and go back to the generated merge.
   * @returns {boolean} whether there was anything to discard
   */
  discardOutputEdits() {
    if (this._outputOverride == null) return false
    this._outputOverride = null
    this._outputDirty = false
    this._renderOutputPane()
    this._emit('output-changed', { edited: false })
    return true
  }

  /**
   * Show the output as an editor, or back as conflict cards.
   * @param {boolean} [on] omit to toggle
   * @returns {boolean} the resulting state
   */
  setOutputEditing(on) {
    this._outputEditing = on ?? !this._outputEditing
    this._renderOutputPane()
    return this._outputEditing
  }

  /** @returns {boolean} */
  isOutputEditing() {
    return this._outputEditing
  }

  /**
   * Matches the contract the table and hex views expose, so the host's
   * close guard needs no special case for this view.
   * @returns {boolean}
   */
  hasUnsavedEdits() {
    return this._outputDirty && this._outputOverride != null
  }

  /** @returns {boolean} whether the tab may be closed */
  confirmClose() {
    if (!this.hasUnsavedEdits()) return true
    return window.confirm('合併輸出有未儲存的手動編輯，確定要關閉並捨棄嗎？')
  }

  // ---------------------------------------------------------------------------
  // Info
  // ---------------------------------------------------------------------------

  /**
   * Everything the Info dialog reports, without the layout — so the numbers
   * can be asserted without a DOM.
   *
   * @returns {{
   *   sources: Array<{ side: 'left'|'base'|'right', label: string, path: string,
   *     lines: number, chars: number }>,
   *   conflicts: { total: number, resolved: number, unresolved: number },
   *   segments: Record<SegmentKind, number>,
   *   settings: { algorithm: string, proximity: number, favor: string,
   *     ignoreUnimportant: boolean, manualConflicts: number },
   * }}
   */
  getInfo() {
    const sources = /** @type {Array<'left'|'base'|'right'>} */ (['left', 'base', 'right'])
      .map((side) => {
        const content = this[`_${side}Content`] ?? ''
        return {
          side,
          label: SIDE_LABELS[side],
          path: this[`_${side}Path`] ?? '',
          // An empty document is zero lines, not the one split() reports.
          lines: content === '' ? 0 : content.split('\n').length,
          chars: content.length,
        }
      })

    /** @type {Record<SegmentKind, number>} */
    const segments = { same: 0, left: 0, right: 0, both: 0, conflict: 0 }
    for (const seg of this._segments) {
      const kind = segmentKind(seg)
      const rows = seg.type === 'conflict' ? seg.baseLines.length : seg.lines.length
      segments[kind] += rows
    }

    const summary = this.getConflictSummary()
    return {
      sources,
      conflicts: { total: summary.total, resolved: summary.resolved, unresolved: summary.unresolved },
      segments,
      settings: {
        algorithm: this._algorithm,
        proximity: this._conflictProximity,
        favor: this._favor,
        ignoreUnimportant: this._ignoreUnimportant,
        manualConflicts: this._manualConflicts.length,
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Parent folders / compare to output
  // ---------------------------------------------------------------------------

  /**
   * The directory each loaded file sits in.
   * @returns {{ left: string, base: string, right: string }}
   */
  getParentFolders() {
    return {
      left: parentDirOf(this._leftPath),
      base: parentDirOf(this._basePath),
      right: parentDirOf(this._rightPath),
    }
  }

  /**
   * Whether the host has wired the folder-compare hand-off. The button is
   * disabled without it rather than pretending to work: this view has no
   * folder-compare surface of its own to fall back to.
   *
   * @returns {boolean}
   */
  canMergeParentFolders() {
    if (!this._listeners.get('open-parent-folders')?.size) return false
    const { left, right } = this.getParentFolders()
    return !!left && !!right
  }

  /**
   * BC's Merge Parent Folders. Emits the three parents and lets the host decide
   * what to open — this app has a two-sided folder compare, so the host is the
   * only place that can choose which pair to show.
   *
   * @returns {boolean} whether the request was handed off
   */
  mergeParentFolders() {
    if (!this.canMergeParentFolders()) return false
    this._emit('open-parent-folders', this.getParentFolders())
    return true
  }

  /**
   * BC's Compare to Output: diff the merged result against one of the sources.
   *
   * Prefers handing the pair to the host (which can open a real text-compare
   * tab); with no host listener it opens a self-contained read-only diff
   * inside this view, so the command always produces something.
   *
   * @param {'left'|'base'|'right'} [side]
   * @returns {boolean} false when there is nothing to compare
   */
  compareToOutput(side = 'left') {
    if (side !== 'left' && side !== 'base' && side !== 'right') return false
    const sourceText = this[`_${side}Content`] ?? ''
    const sourcePath = this[`_${side}Path`] ?? ''
    const outputText = this._buildOutputText()
    if (!sourceText && !outputText) {
      this._reportError('沒有可比對的內容：請先載入來源檔案。')
      return false
    }

    if (this._listeners.get('compare-to-output')?.size) {
      this._emit('compare-to-output', { side, sourcePath, sourceText, outputText })
      return true
    }
    this._openOutputDiffDialog(side, sourcePath, sourceText, outputText)
    return true
  }

  /**
   * Read-only two-column diff of a source against the merged output.
   *
   * Rendered whole rather than virtualised, so the row count is capped: this is
   * a preview, and the merge panes are where a large file is meant to be read.
   *
   * @param {'left'|'base'|'right'} side
   * @param {string} sourcePath
   * @param {string} sourceText
   * @param {string} outputText
   */
  _openOutputDiffDialog(side, sourcePath, sourceText, outputText) {
    const host = this._container ?? document.body
    const backdrop = document.createElement('div')
    backdrop.className = 'mw-modal-backdrop'
    const modal = document.createElement('div')
    modal.className = 'mw-modal'

    const title = document.createElement('div')
    title.className = 'mw-modal-title'
    title.textContent = `${SIDE_LABELS[side]}（${sourcePath || '未命名'}）↔ 合併輸出`
    modal.appendChild(title)

    const diff = diffLines(sourceText, outputText, {
      algorithm: this._algorithm,
      ignoreWhitespace: this._ignoreWhitespace,
      ignoreCase: this._ignoreCase,
    })
    const changed = diff.filter((d) => d.type !== 'equal').length

    const summary = document.createElement('div')
    summary.className = 'mw-modal-hint'
    summary.textContent = changed === 0
      ? '合併輸出與此來源完全相同。'
      : `共 ${changed} 行不同（總計 ${diff.length} 行）。`
    modal.appendChild(summary)

    const body = document.createElement('div')
    body.className = 'mw-modal-diff'
    const shown = diff.slice(0, OUTPUT_DIFF_MAX_ROWS)
    for (const dl of shown) {
      const row = document.createElement('div')
      row.className = `mw-modal-diff-row mw-modal-diff-row--${dl.type}`
      const l = document.createElement('span')
      l.className = 'mw-modal-diff-cell'
      l.textContent = _stripEol(dl.leftText ?? '')
      const r = document.createElement('span')
      r.className = 'mw-modal-diff-cell'
      r.textContent = _stripEol(dl.rightText ?? '')
      row.append(l, r)
      body.appendChild(row)
    }
    if (diff.length > shown.length) {
      const more = document.createElement('div')
      more.className = 'mw-modal-hint'
      more.textContent = `… 只顯示前 ${OUTPUT_DIFF_MAX_ROWS} 行，另有 ${diff.length - shown.length} 行未顯示。`
      body.appendChild(more)
    }
    modal.appendChild(body)

    const actions = document.createElement('div')
    actions.className = 'mw-modal-actions'
    const btnClose = document.createElement('button')
    btnClose.type = 'button'
    btnClose.className = 'mw-modal-close'
    btnClose.textContent = '關閉'
    actions.appendChild(btnClose)
    modal.appendChild(actions)

    backdrop.appendChild(modal)
    host.appendChild(backdrop)

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      backdrop.remove()
      document.removeEventListener('keydown', onKey, true)
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish() } }
    btnClose.addEventListener('click', finish)
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish() })
    document.addEventListener('keydown', onKey, true)
    btnClose.focus()
  }

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------

  /**
   * Conflict-by-conflict view of the merge, shared by both report formats and
   * usable on its own by a caller that wants the numbers without the layout.
   *
   * @returns {{
   *   total: number, resolved: number, unresolved: number,
   *   items: Array<{
   *     index: number, id: number, baseLine: number|null,
   *     leftLines: number, baseLines: number, rightLines: number,
   *     choice: ConflictChoice|null, preview: string
   *   }>
   * }}
   */
  getConflictSummary() {
    const items = []
    let index = 0
    for (const seg of this._segments) {
      if (seg.type !== 'conflict') continue
      const choice = this._conflictChoices.get(seg.id) ?? null
      items.push({
        index,
        id: seg.id,
        // baseStart counts lines from zero; a report is read against an editor.
        baseLine: typeof seg.baseStart === 'number' ? seg.baseStart + 1 : null,
        leftLines: seg.leftLines.length,
        baseLines: seg.baseLines.length,
        rightLines: seg.rightLines.length,
        choice,
        preview: _previewLine(seg.leftLines[0] ?? seg.rightLines[0] ?? seg.baseLines[0] ?? ''),
      })
      index++
    }
    const resolved = items.filter((it) => it.choice != null).length
    return { total: items.length, resolved, unresolved: items.length - resolved, items }
  }

  /**
   * Plain-text report of the merge.
   *
   * Capped like the hex and text reports: a merge of two heavily diverged
   * branches can hold thousands of conflicts, and a report nobody can read is
   * no more useful than no report.
   *
   * @param {{ generatedAt?: Date, maxConflicts?: number }} [opts]
   * @returns {string}
   */
  buildTextReport(opts = {}) {
    const maxConflicts = opts.maxConflicts ?? 500
    const summary = this.getConflictSummary()
    const header = reportHeader({
      title: '三向合併報告',
      leftPath: this._leftPath,
      rightPath: this._rightPath,
      generatedAt: opts.generatedAt,
    })
    const basePath = `基準：${this._basePath || '（未知）'}\n`

    const counts = summary.total === 0
      ? '無衝突'
      : `衝突 ${summary.total}，已解決 ${summary.resolved}，未解決 ${summary.unresolved}`

    const shown = summary.items.slice(0, maxConflicts)
    const rows = shown.map((it) => [
      String(it.index + 1),
      it.baseLine == null ? '-' : String(it.baseLine),
      String(it.leftLines),
      String(it.baseLines),
      String(it.rightLines),
      CHOICE_LABELS[it.choice ?? 'none'],
      it.preview,
    ])

    const table = rows.length
      ? renderTextTable(
          [{ title: '#', align: 'right' }, { title: '基準行', align: 'right' },
           { title: '左行數', align: 'right' }, { title: '基準行數', align: 'right' },
           { title: '右行數', align: 'right' }, { title: '狀態' }, { title: '內容' }],
          rows)
      : '（三個來源可自動合併，沒有衝突）'

    const omitted = summary.total - shown.length
    const note = omitted > 0 ? `\n\n（另有 ${omitted} 個衝突未列出）` : ''
    return `${header}${basePath}\n${counts}\n\n${table}${note}\n`
  }

  /**
   * Self-contained HTML report of the merge. Capped for the same reason as the
   * plain-text one.
   *
   * @param {{ generatedAt?: Date, maxConflicts?: number }} [opts]
   * @returns {string}
   */
  buildHtmlReport(opts = {}) {
    const maxConflicts = opts.maxConflicts ?? 500
    const summary = this.getConflictSummary()
    const esc = (s) => String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const timestamp = (opts.generatedAt ?? new Date()).toLocaleString('zh-TW')

    const shown = summary.items.slice(0, maxConflicts)
    const rows = shown.map((it) => `<tr>
  <td class="num">${it.index + 1}</td>
  <td class="num">${it.baseLine == null ? '-' : it.baseLine}</td>
  <td class="num">${it.leftLines}</td>
  <td class="num">${it.baseLines}</td>
  <td class="num">${it.rightLines}</td>
  <td class="${it.choice == null ? 'unresolved' : 'resolved'}">${esc(CHOICE_LABELS[it.choice ?? 'none'])}</td>
  <td class="preview">${esc(it.preview)}</td>
</tr>`).join('\n')

    const omitted = summary.total - shown.length
    const note = omitted > 0 ? `<p class="note">另有 ${omitted} 個衝突未列出。</p>` : ''
    const body = rows
      ? `<table>
<thead><tr><th>#</th><th>基準行</th><th>左行數</th><th>基準行數</th><th>右行數</th><th>狀態</th><th>內容</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>${note}`
      : '<p class="note">三個來源可自動合併，沒有衝突。</p>'

    return `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8">
<title>MyCompare — 三向合併報告</title>
<style>
body{font-family:sans-serif;font-size:13px;background:#fff;color:#222;margin:16px}
h2{margin-bottom:4px}
.paths{font-size:12px;color:#666;margin-bottom:12px;line-height:1.6}
.report-stats{font-size:12px;display:flex;flex-wrap:wrap;gap:10px;padding:8px 12px;
  background:#f5f5f5;border:1px solid #ddd;border-radius:4px;margin-bottom:12px}
.report-stats .stat-mod{color:#996c00;font-weight:600}
.report-stats .stat-eq{color:#666;font-weight:600}
.report-stats .ts{margin-left:auto;color:#888}
.note{font-size:12px;color:#666}
table{border-collapse:collapse;width:100%}
th{background:#f0f0f0;border-bottom:2px solid #aaa;padding:2px 6px;text-align:left}
td{padding:1px 6px;border-bottom:1px solid #eee;word-break:break-all}
.num{text-align:right}
.preview{font-family:monospace;white-space:pre-wrap}
.unresolved{background:#ffd7d7;font-weight:600}
.resolved{background:#d7ffd7}
@media print{
  body{margin:8mm;font-size:11px}
  .no-print{display:none !important}
  h2{font-size:14px}
  .paths,.report-stats{font-size:10px}
  table{page-break-inside:auto}
  tr{page-break-inside:avoid;page-break-after:auto}
}
</style>
</head><body>
<h2>三向合併報告</h2>
<div class="paths">
左：${esc(this._leftPath || '（未知）')}<br>
基準：${esc(this._basePath || '（未知）')}<br>
右：${esc(this._rightPath || '（未知）')}
</div>
<div class="report-stats">
  <div>衝突: <span class="stat-mod">${summary.total}</span></div>
  <div>已解決: <span class="stat-eq">${summary.resolved}</span></div>
  <div>未解決: <span class="stat-mod">${summary.unresolved}</span></div>
  <div class="ts">生成時間: ${esc(timestamp)}</div>
</div>
${body}
</body></html>`
  }

  /**
   * @param {{ print?: boolean }} [opts] print=true opens the report in a blob
   *   window and calls print() instead of writing it to disk.
   * @returns {Promise<void>}
   */
  async exportHtml(opts = {}) {
    const html = this.buildHtmlReport()
    if (opts.print) {
      const blob = new Blob([html], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      const win = window.open(url, '_blank')
      if (win) {
        win.addEventListener('load', () => {
          try { win.print() } catch { /* 使用者取消列印 */ }
        })
        return
      }
      // Pop-up blocked — fall back to saving rather than doing nothing.
      this._reportError('無法開啟列印視窗，改為另存報告')
    }
    await window.electronAPI.saveFile(
      'merge-report.html', html,
      [{ name: 'HTML', extensions: ['html'] }, { name: '所有檔案', extensions: ['*'] }])
  }

  /** Save the plain-text report. */
  async exportTextReport() {
    await window.electronAPI.saveFile(
      'merge-report.txt',
      this.buildTextReport(),
      [{ name: '純文字', extensions: ['txt'] }, { name: '所有檔案', extensions: ['*'] }])
  }

  /**
   * Comparison settings only — never paths or file contents, because a named
   * config is meant to be reusable across sessions.
   *
   * @returns {Record<string, unknown>}
   */
  getConfig() {
    return tagConfig('merge3', {
      showFilter: this._showFilter,
      algorithm: this._algorithm,
      ignoreWhitespace: this._ignoreWhitespace,
      ignoreCase: this._ignoreCase,
      contextLines: this._contextLines,
      favor: this._favor,
      alignByGrammar: this._alignByGrammar,
      conflictProximity: this._conflictProximity,
      ignoreUnimportant: this._ignoreUnimportant,
      unimportantPatterns: [...this._unimportantPatterns],
      // Base line ranges, so a snapshot taken on the same ancestor restores
      // the same marks; they are re-clamped on the way back in.
      manualConflicts: this.getManualConflicts(),
      // Pane layout: which panes are on screen is a view preference, so it
      // belongs in the same snapshot as the filters rather than being reset
      // every time a session is reopened.
      showBase: this._showBase,
      maximize: this._maximize,
      showLineNumbers: this._showLineNumbers,
    })
  }

  /**
   * @param {unknown} cfg  untrusted: comes from localStorage / an imported file
   */
  applyConfig(cfg) {
    const c = readConfig('merge3', cfg)
    if (!c) return

    // Snapshots written before the filter set grew only ever held 'all' or
    // 'conflicts', both of which are still valid members of the wider set.
    if (isShowFilterMode(c.showFilter)) this._showFilter = c.showFilter
    if (c.algorithm === 'myers' || c.algorithm === 'patience' || c.algorithm === 'histogram') {
      this._algorithm = c.algorithm
    }
    if (typeof c.ignoreWhitespace === 'boolean') this._ignoreWhitespace = c.ignoreWhitespace
    if (typeof c.ignoreCase === 'boolean') this._ignoreCase = c.ignoreCase
    if (c.contextLines != null) this._contextLines = normalizeContextLines(c.contextLines)
    if (c.favor === 'none' || c.favor === 'left' || c.favor === 'right') this._favor = c.favor
    if (typeof c.alignByGrammar === 'boolean') this._alignByGrammar = c.alignByGrammar
    if (c.conflictProximity != null) this._conflictProximity = normalizeConflictProximity(c.conflictProximity)
    if (typeof c.ignoreUnimportant === 'boolean') this._ignoreUnimportant = c.ignoreUnimportant
    if (Array.isArray(c.unimportantPatterns)) {
      this._unimportantPatterns = c.unimportantPatterns
        .map((p) => String(p ?? '').trim()).filter(Boolean)
      this._unimportantCache.clear()
    }
    if (Array.isArray(c.manualConflicts)) {
      this._manualConflicts = normalizeForcedRanges(
        c.manualConflicts, (this._baseContent || '').split('\n').length)
    }
    if (typeof c.showBase === 'boolean') this._showBase = c.showBase
    if (isMaximizeMode(c.maximize)) this._maximize = c.maximize
    if (typeof c.showLineNumbers === 'boolean') this._showLineNumbers = c.showLineNumbers

    this._applyLayout()
    this._runMerge()
  }

  /**
   * Scroll the side panes so `rowIndex` is the first visible row.
   *
   * Takes the target position as the source of truth rather than reading
   * `scrollTop` back: a pane with no layout would report 0 and silently
   * cancel the jump.
   *
   * @param {number} rowIndex
   */
  scrollToRow(rowIndex) {
    const top = Math.max(0, Math.floor(Number(rowIndex) || 0)) * ROW_HEIGHT
    this._scrollTop = top
    for (const pane of this._panes()) pane.scrollTop = top
    this._renderPaneWindows(top)
  }

  /**
   * Mount the view into a container element.
   * @param {HTMLElement} containerEl
   */
  mount(containerEl) {
    this._container = containerEl
    this._render()
    this._bindEvents()
  }

  destroy() {
    // Remove sync scroll handlers
    if (this._syncScrollHandlers) {
      for (const { pane, handler } of this._syncScrollHandlers) {
        pane.removeEventListener('scroll', handler)
      }
      this._syncScrollHandlers = null
    }
    if (this._dropCleanup) {
      this._dropCleanup()
      this._dropCleanup = null
    }
    if (this._container) this._container.innerHTML = ''
    this._listeners.clear()
    this._paneRows = { left: [], base: [], right: [] }
    this._renderedRange = { start: -1, end: -1 }
    this._contentEls = { left: null, base: null, right: null }
    this._outputEl = null
    this._outputPaneEl = null
    this._outputEditing = false
    // The pane it referred to is gone; keeping it would make the next mount
    // restore a height measured against a discarded DOM.
    this._savedOutputHeight = null
  }

  /**
   * @param {string} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set())
    this._listeners.get(event).add(handler)
    // Whether the host can take the hand-off is what decides if the parent
    // folders button is usable, and that is only knowable once it subscribes.
    if (event === 'open-parent-folders') this._syncParentFoldersButton()
  }

  /**
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    this._listeners.get(event)?.delete(handler)
  }

  // ---------------------------------------------------------------------------
  // Internal – rendering
  // ---------------------------------------------------------------------------

  _render() {
    // No element carries an `id`: two merge tabs mounted at once would
    // otherwise share every id in this markup, and a document-wide lookup
    // would resolve to whichever tab happened to mount first. Every handle
    // below is reached through `_q()`, which is scoped to this container.
    this._container.innerHTML = `
      <div class="mw-layout">
        <div class="mw-toolbar">
          <button class="mw-btn-prev" title="上一個衝突">▲</button>
          <button class="mw-btn-next" title="下一個衝突">▼</button>
          <span class="mw-conflict-counter">無衝突</span>
          <span class="mw-toolbar-sep"></span>
          <button class="mw-btn-filter" title="只顯示衝突段落">顯示：全部</button>
          <select class="mw-filter-select" title="顯示篩選">
            ${SHOW_FILTER_MODES.map((m) => `<option value="${m}">${SHOW_FILTER_LABELS[m]}</option>`).join('')}
          </select>
          <label class="mw-context-label" title="只顯示衝突時，每個衝突前後保留的行數">脈絡
            <input class="mw-context-input" type="number" min="0" max="${MAX_CONTEXT_LINES}" step="1" />
          </label>
          <span class="mw-toolbar-sep"></span>
          <label class="mw-algo-label">對齊
            <select class="mw-algo-select" title="對齊演算法">
              <option value="myers">Myers</option>
              <option value="patience">Patience</option>
              <option value="histogram">Histogram</option>
            </select>
          </label>
          <label class="mw-proximity-label" title="相鄰這麼多基準行以內的兩側變更，視為同一個衝突">鄰近
            <input class="mw-proximity-input" type="number" min="0" max="${MAX_CONFLICT_PROXIMITY}" step="1" />
          </label>
          <label class="mw-unimportant-label" title="忽略不重要的差異：符合樣式的部分不列入比較">
            <input class="mw-unimportant-check" type="checkbox" />忽略不重要差異
          </label>
          <button class="mw-btn-unimportant-edit" title="編輯不重要差異的樣式（每行一條正規表示式）">樣式…</button>
          <span class="mw-toolbar-sep"></span>
          <button class="mw-btn-all-left">全部採用左側</button>
          <button class="mw-btn-all-right">全部採用右側</button>
          <label class="mw-resolve-all-label" title="把未解決的衝突一次全部套用同一種來源">全部
            <select class="mw-resolve-all-select">
              <option value="base">採用基準</option>
              <option value="both">兩者（左→右）</option>
              <option value="both-rl">兩者（右→左）</option>
              <option value="left">採用左側</option>
              <option value="right">採用右側</option>
            </select>
          </label>
          <button class="mw-btn-resolve-all">套用</button>
          <span class="mw-toolbar-sep"></span>
          <button class="mw-btn-mark-conflict" title="把基準窗格中選取的行強制標記為衝突">標記衝突</button>
          <button class="mw-btn-clear-conflicts" title="清除所有手動標記的衝突">清除標記</button>
          <button class="mw-btn-info" title="合併統計資訊">ℹ 資訊</button>
          <label class="mw-favor-label" title="自動以某一側解決衝突，之後重新合併也照辦">偏好
            <select class="mw-favor-select">
              <option value="none">不偏好</option>
              <option value="left">左側變更</option>
              <option value="right">右側變更</option>
            </select>
          </label>
          <span class="mw-toolbar-sep"></span>
          <button class="mw-btn-toggle-base" title="隱藏或顯示中間的基準窗格，把空間讓給左右兩側">隱藏基準</button>
          <button class="mw-btn-max-output" title="把合併輸出放大到整個視圖（來源窗格收起）">放大輸出</button>
          <button class="mw-btn-max-sources" title="把三個來源窗格放大到整個視圖（輸出只留標題列）">放大來源</button>
          <button class="mw-btn-toggle-linenum" title="顯示或隱藏行號欄">行號</button>
          <button class="mw-btn-reset-layout" title="回到預設的四窗格版面">重設版面</button>
          <span class="mw-toolbar-sep"></span>
          <button class="mw-btn-parent-folders" title="以三個來源的上層資料夾開啟資料夾比對">上層資料夾</button>
          <label class="mw-output-cmp-label" title="把合併輸出與其中一個來源做文字比對">比對輸出
            <select class="mw-output-cmp-select">
              <option value="left">左側</option>
              <option value="base">基底</option>
              <option value="right">右側</option>
            </select>
          </label>
          <button class="mw-btn-compare-output">比對</button>
        </div>
        <div class="mw-top">
          <div class="mw-pane mw-pane--left" data-side="left">
            <div class="mw-path-bar">
              <button class="mw-open-btn" data-side="left">開啟左側…</button>
              <span class="mw-path" data-side="left">（未選擇）</span>
            </div>
            <div class="mw-content mw-content-left" data-side="left"></div>
          </div>
          <div class="mw-pane-divider mw-pane-divider--lb"></div>
          <div class="mw-pane mw-pane--base" data-side="base">
            <div class="mw-path-bar">
              <button class="mw-open-btn" data-side="base">開啟基底…</button>
              <span class="mw-path" data-side="base">（未選擇）</span>
            </div>
            <div class="mw-content mw-content-base" data-side="base"></div>
          </div>
          <div class="mw-pane-divider"></div>
          <div class="mw-pane mw-pane--right" data-side="right">
            <div class="mw-path-bar">
              <button class="mw-open-btn" data-side="right">開啟右側…</button>
              <span class="mw-path" data-side="right">（未選擇）</span>
            </div>
            <div class="mw-content mw-content-right" data-side="right"></div>
          </div>
        </div>
        <div class="mw-divider"></div>
        <div class="mw-output-pane">
          <div class="mw-output-header">
            <span>合併輸出</span>
            <span class="mw-output-edited-badge" hidden>已手動編輯</span>
            <button class="mw-btn-edit-output" title="直接編輯合併結果">編輯輸出</button>
            <button class="mw-btn-discard-output" title="捨棄手動編輯，回到由衝突選擇產生的結果" hidden>捨棄手動編輯</button>
            <button class="mw-btn-save">儲存輸出…</button>
          </div>
          <div class="mw-output-content"></div>
          <textarea class="mw-output-textarea" spellcheck="false"></textarea>
        </div>
      </div>
    `

    // Cache element refs
    this._contentEls = {
      left: this._q('.mw-content-left'),
      base: this._q('.mw-content-base'),
      right: this._q('.mw-content-right'),
    }
    this._outputEl = /** @type {HTMLTextAreaElement|null} */ (this._q('.mw-output-textarea'))
    this._outputPaneEl = this._q('.mw-output-content')

    // Setup resizable output pane
    this._setupDividerDrag()
    // The markup above is always the default four-pane layout, so a view that
    // was configured before it mounted has to have that state re-applied.
    this._applyLayout()
  }

  /**
   * Container-scoped lookup. Every internal query goes through here so that a
   * second mounted instance can never reach into the first one's DOM.
   *
   * @param {string} selector
   * @returns {HTMLElement|null}
   */
  _q(selector) {
    return /** @type {HTMLElement|null} */ (this._container?.querySelector(selector) ?? null)
  }

  /**
   * @param {'left'|'base'|'right'} side
   * @returns {HTMLElement|null}
   */
  _pathEl(side) {
    return this._q(`.mw-path[data-side="${side}"]`)
  }

  /** @returns {HTMLElement[]} the three scrollable side panes that exist */
  _panes() {
    return [this._contentEls.left, this._contentEls.base, this._contentEls.right].filter(Boolean)
  }

  /**
   * Push `_showBase` / `_maximize` / `_showLineNumbers` onto the DOM.
   *
   * Everything is expressed as a class on `.mw-layout` so the panes keep their
   * boxes and their content: a collapsed pane is hidden, never rebuilt, which
   * is what lets the scroll offset and the painted window survive the round
   * trip. The one thing that cannot be done in CSS is the inline height the
   * drag handle writes on the output pane, so it is parked and restored here.
   */
  _applyLayout() {
    const layout = this._q('.mw-layout')
    if (!layout) return

    layout.classList.toggle('mw-layout--no-base', !this._showBase)
    layout.classList.toggle('mw-layout--max-output', this._maximize === 'output')
    layout.classList.toggle('mw-layout--max-sources', this._maximize === 'sources')
    layout.classList.toggle('mw-layout--no-linenum', !this._showLineNumbers)

    const outputPane = this._q('.mw-output-pane')
    if (outputPane) {
      if (this._maximize !== 'none') {
        if (this._savedOutputHeight == null) this._savedOutputHeight = outputPane.style.height
        outputPane.style.height = ''
      } else if (this._savedOutputHeight != null) {
        outputPane.style.height = this._savedOutputHeight
        this._savedOutputHeight = null
      }
    }

    this._syncLayoutButtons()
    this._restoreScroll()
  }

  /**
   * Put every pane back on the tracked offset and repaint the window.
   *
   * Called after any layout change because both inputs to the window have
   * moved: a pane that was hidden reports scrollTop 0 (and silently drops
   * writes while hidden), and the viewport height differs once a neighbour
   * collapses, so the previously painted range says nothing about what should
   * be on screen now.
   */
  _restoreScroll() {
    const top = this._scrollTop
    for (const pane of this._panes()) pane.scrollTop = top
    this._renderedRange = { start: -1, end: -1 }
    this._renderPaneWindows(top)
  }

  /** Mirror the layout state onto the toolbar toggles. */
  _syncLayoutButtons() {
    /** @type {Array<[string, boolean]>} */
    const states = [
      ['.mw-btn-toggle-base', !this._showBase],
      ['.mw-btn-max-output', this._maximize === 'output'],
      ['.mw-btn-max-sources', this._maximize === 'sources'],
      ['.mw-btn-toggle-linenum', !this._showLineNumbers],
    ]
    for (const [selector, active] of states) {
      this._q(selector)?.classList.toggle('active', active)
    }

    const baseBtn = this._q('.mw-btn-toggle-base')
    if (baseBtn) baseBtn.textContent = this._showBase ? '隱藏基準' : '顯示基準'
    const outBtn = this._q('.mw-btn-max-output')
    if (outBtn) outBtn.textContent = this._maximize === 'output' ? '還原輸出' : '放大輸出'
    const srcBtn = this._q('.mw-btn-max-sources')
    if (srcBtn) srcBtn.textContent = this._maximize === 'sources' ? '還原來源' : '放大來源'
  }

  _setupDividerDrag() {
    const divider = this._q('.mw-divider')
    const outputPane = this._q('.mw-output-pane')
    if (!divider || !outputPane) return

    let startY = 0
    let startHeight = 0

    const onMouseMove = (e) => {
      const delta = startY - e.clientY
      const newHeight = Math.max(80, Math.min(startHeight + delta, window.innerHeight - 200))
      outputPane.style.height = `${newHeight}px`
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      divider.classList.remove('dragging')
    }

    divider.addEventListener('mousedown', (e) => {
      startY = e.clientY
      startHeight = outputPane.offsetHeight
      divider.classList.add('dragging')
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      e.preventDefault()
    })
  }

  _bindEvents() {
    // Open file buttons
    this._container.querySelectorAll('.mw-open-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const side = btn.dataset.side
        try {
          const result = await window.electronAPI.openFile()
          if (!result) return
          this[`_${side}Path`] = result.path
          this[`_${side}Content`] = result.content
          const pathEl = this._pathEl(side)
          if (pathEl) pathEl.textContent = result.path
          this._runMerge()
          this._emit('paths-changed', {
            left: this._leftPath,
            base: this._basePath,
            right: this._rightPath,
          })
        } catch (err) {
          this._reportError(`開啟檔案失敗：${err instanceof Error ? err.message : String(err)}`)
        }
      })
    })

    // Save output button
    this._q('.mw-btn-save')?.addEventListener('click', async () => {
      const content = this._buildOutputText()
      try {
        await window.electronAPI.saveFile('merged-output.txt', content)
        // Saved work is no longer unsaved; leaving the flag set would make the
        // close guard ask about edits the user has already written out.
        this._outputDirty = false
        this._syncOutputControls()
      } catch (err) {
        this._reportError(`儲存輸出失敗：${err instanceof Error ? err.message : String(err)}`)
      }
    })

    // Editable output
    this._q('.mw-btn-edit-output')?.addEventListener('click', () => {
      this.setOutputEditing(!this._outputEditing)
      if (this._outputEditing) this._outputEl?.focus()
    })
    this._q('.mw-btn-discard-output')?.addEventListener('click', () => {
      if (!this.discardOutputEdits()) this._reportError('目前沒有手動編輯可以捨棄。')
    })
    this._outputEl?.addEventListener('input', () => {
      if (!this._outputEl) return
      this.setOutputText(this._outputEl.value)
    })

    // S16-M01: conflict navigation / filter / batch resolve toolbar
    this._q('.mw-btn-prev')?.addEventListener('click', () => this.prevConflict())
    this._q('.mw-btn-next')?.addEventListener('click', () => this.nextConflict())
    // The button stays a one-click "just the conflicts" toggle; the select
    // beside it reaches the rest of the modes.
    this._q('.mw-btn-filter')?.addEventListener('click', () => {
      this.setShowFilter(this._showFilter === 'all' ? 'conflicts' : 'all')
    })
    const filterSelect = /** @type {HTMLSelectElement|null} */ (this._q('.mw-filter-select'))
    filterSelect?.addEventListener('change', () => {
      this.setShowFilter(/** @type {ShowFilterMode} */ (filterSelect.value))
    })
    const algoSelect = /** @type {HTMLSelectElement|null} */ (this._q('.mw-algo-select'))
    algoSelect?.addEventListener('change', () => {
      this.setAlgorithm(/** @type {'myers'|'patience'|'histogram'} */ (algoSelect.value))
    })
    this._q('.mw-btn-all-left')?.addEventListener('click', () => this.resolveAll('left'))
    this._q('.mw-btn-all-right')?.addEventListener('click', () => this.resolveAll('right'))

    const contextInput = /** @type {HTMLInputElement|null} */ (this._q('.mw-context-input'))
    if (contextInput) {
      contextInput.value = String(this._contextLines)
      // 'change' rather than 'input': re-flattening every pane on each keystroke
      // is wasted work on a large merge.
      contextInput.addEventListener('change', () => {
        contextInput.value = String(this.setContextLines(contextInput.value))
      })
    }

    const favorSelect = /** @type {HTMLSelectElement|null} */ (this._q('.mw-favor-select'))
    favorSelect?.addEventListener('change', () => {
      this.setFavor(/** @type {'none'|'left'|'right'} */ (favorSelect.value))
    })

    const proximityInput = /** @type {HTMLInputElement|null} */ (this._q('.mw-proximity-input'))
    if (proximityInput) {
      proximityInput.value = String(this._conflictProximity)
      // 'change', not 'input': every keystroke would re-run the whole merge.
      proximityInput.addEventListener('change', () => {
        proximityInput.value = String(this.setConflictProximity(proximityInput.value))
      })
    }

    const unimportantCheck = /** @type {HTMLInputElement|null} */ (this._q('.mw-unimportant-check'))
    unimportantCheck?.addEventListener('change', () => {
      this.setIgnoreUnimportant(unimportantCheck.checked)
    })
    this._q('.mw-btn-unimportant-edit')?.addEventListener('click', () => this._openUnimportantEditor())

    const resolveAllSelect = /** @type {HTMLSelectElement|null} */ (this._q('.mw-resolve-all-select'))
    this._q('.mw-btn-resolve-all')?.addEventListener('click', () => {
      const choice = /** @type {ConflictChoice} */ (resolveAllSelect?.value ?? 'both')
      const n = this.resolveAll(choice)
      if (n === 0 && this._outputOverride == null) {
        this._emit('status', { message: '沒有未解決的衝突可套用。' })
      }
    })

    this._q('.mw-btn-mark-conflict')?.addEventListener('click', () => this._markConflictFromSelection())
    this._q('.mw-btn-clear-conflicts')?.addEventListener('click', () => {
      const n = this.clearManualConflicts()
      this._emit('status', { message: n > 0 ? `已清除 ${n} 個手動衝突標記` : '沒有手動衝突標記' })
      if (n === 0) toast('沒有手動衝突標記')
    })
    this._q('.mw-btn-info')?.addEventListener('click', () => this.showInfo())

    this._q('.mw-btn-toggle-base')?.addEventListener('click', () => this.toggleBaseVisible())
    this._q('.mw-btn-max-output')?.addEventListener('click', () => this.toggleMaximizeOutput())
    this._q('.mw-btn-max-sources')?.addEventListener('click', () => this.toggleMaximizeSources())
    this._q('.mw-btn-toggle-linenum')?.addEventListener('click', () => this.toggleLineNumbers())
    this._q('.mw-btn-reset-layout')?.addEventListener('click', () => this.resetLayout())

    this._q('.mw-btn-parent-folders')?.addEventListener('click', () => this.mergeParentFolders())

    const outputCmpSelect = /** @type {HTMLSelectElement|null} */ (this._q('.mw-output-cmp-select'))
    this._q('.mw-btn-compare-output')?.addEventListener('click', () => {
      this.compareToOutput(/** @type {'left'|'base'|'right'} */ (outputCmpSelect?.value ?? 'left'))
    })

    this._syncParentFoldersButton()

    // T26: Sync scroll across all three content panes
    this._setupSyncScroll()
    this._setupDropTargets()
  }

  // ---------------------------------------------------------------------------
  // Internal – drag & drop
  // ---------------------------------------------------------------------------

  /**
   * Accept files dropped onto any of the three input panes.
   *
   * Three inputs means the drop has to say which one it meant, and the only
   * thing that can say it is the pane the file was released over.
   */
  _setupDropTargets() {
    /** @type {Array<[HTMLElement, 'left'|'base'|'right']>} */
    const targets = /** @type {Array<'left'|'base'|'right'>} */ (['left', 'base', 'right'])
      .map((side) => [this._q(`.mw-pane--${side}`), side])
      .filter(([node]) => Boolean(node))

    /** @type {Array<() => void>} */
    const cleanups = []

    for (const [node, side] of targets) {
      const onOver = (/** @type {DragEvent} */ e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        node.classList.add('mw-drop-target')
      }
      const onLeave = () => node.classList.remove('mw-drop-target')
      const onDrop = (/** @type {DragEvent} */ e) => {
        e.preventDefault()
        e.stopPropagation()
        node.classList.remove('mw-drop-target')
        void this._acceptDrop(e, side)
      }
      node.addEventListener('dragenter', onOver)
      node.addEventListener('dragover', onOver)
      node.addEventListener('dragleave', onLeave)
      node.addEventListener('drop', onDrop)
      cleanups.push(() => {
        node.removeEventListener('dragenter', onOver)
        node.removeEventListener('dragover', onOver)
        node.removeEventListener('dragleave', onLeave)
        node.removeEventListener('drop', onDrop)
      })
    }

    this._dropCleanup = () => { for (const fn of cleanups) fn() }
  }

  /**
   * Report a failure where the user will actually see it.
   *
   * The host wires a 'status' listener; without one the message would vanish,
   * so a toast is the fallback rather than a console line. Not an alert: a
   * modal dialog raised from a drop handler blocks the renderer.
   *
   * @param {string} message
   */
  _reportError(message) {
    this._emit('status', { message, level: 'error' })
    if (!this._listeners.get('status')?.size) toast(message, { type: 'error' })
  }

  /**
   * @param {DragEvent} e
   * @param {'left'|'base'|'right'} side  the pane the drop landed on
   * @returns {Promise<void>}
   */
  async _acceptDrop(e, side) {
    const files = [...(e.dataTransfer?.files ?? [])]
    if (!files.length) return

    let entries
    try {
      // The File objects go across as they are: Electron 32 removed File.path,
      // and letting the renderer name a path would be self-authorisation.
      entries = await window.electronAPI?.acceptDroppedFiles?.(files)
    } catch (err) {
      this._reportError(`無法接受拖放的檔案：${err instanceof Error ? err.message : String(err)}`)
      return
    }

    if (!entries?.length) {
      // preload resolves a path only for a File the OS really handed over.
      this._reportError('無法取得拖放檔案的路徑')
      return
    }

    const usable = entries.filter((entry) => entry && !entry.isDirectory)
    if (!usable.length) {
      this._reportError('請拖放檔案，而非資料夾')
      return
    }

    // Three files at once fill all three inputs in pane order; anything else
    // only touches the pane that took the drop, because guessing which of the
    // three a second file belongs to would be a coin flip.
    const plan = usable.length >= 3
      ? /** @type {Array<['left'|'base'|'right', { path: string }]>} */ (
          [['left', usable[0]], ['base', usable[1]], ['right', usable[2]]])
      : /** @type {Array<['left'|'base'|'right', { path: string }]>} */ ([[side, usable[0]]])

    for (const [target, entry] of plan) {
      await this._loadDroppedFile(target, entry.path)
    }
  }

  /**
   * @param {'left'|'base'|'right'} side
   * @param {string} path
   * @returns {Promise<void>}
   */
  async _loadDroppedFile(side, path) {
    try {
      const result = await window.electronAPI.readFile(path)
      if (!result) return
      if ((result.content?.length ?? 0) > MAX_MERGE_CHARS) {
        this._reportError(`${path} 超過大小上限（${MAX_MERGE_CHARS} 字元），未載入`)
        return
      }
      this.setSide(side, result.content, result.path)
    } catch (err) {
      this._reportError(`載入 ${path} 失敗：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Move the navigation cursor and reveal the matching conflict card.
   * @param {number} index
   * @returns {number} the index actually selected
   */
  _gotoConflict(index) {
    this._currentConflict = index
    const ids = collectConflictIds(this._segments)
    const targetId = index >= 0 ? ids[index] : null

    if (targetId != null) {
      const row = conflictPaneRow(this._segments, targetId, this._showFilter, this._contextLines)
      // A couple of lines of lead-in, so the conflict is not flush against
      // the top edge of the pane.
      if (row >= 0) this.scrollToRow(Math.max(0, row - this._contextLines))
    }

    const pane = this._outputPaneEl
    if (pane) {
      pane.querySelectorAll('.mw-conflict-card').forEach(card => {
        const isCurrent = targetId != null && card.dataset.conflictId === String(targetId)
        card.classList.toggle('mw-conflict-card--current', isCurrent)
        // jsdom has no scrollIntoView; navigation must still work under test.
        if (isCurrent) card.scrollIntoView?.({ block: 'center' })
      })
    }
    this._updateConflictCounter()
    this._emit('conflict-changed', { index, total: this.getConflictCount() })
    return index
  }

  _updateConflictCounter() {
    const el = this._q('.mw-conflict-counter')
    if (!el) return
    const total = this.getConflictCount()
    el.textContent = total === 0
      ? '無衝突'
      : `第 ${this._currentConflict >= 0 ? this._currentConflict + 1 : '-'} / ${total} 個衝突`
  }

  _updateFilterButton() {
    const btn = this._q('.mw-btn-filter')
    if (btn) {
      btn.textContent = `顯示：${SHOW_FILTER_LABELS[this._showFilter]}`
      btn.classList.toggle('active', this._showFilter !== 'all')
    }
    const select = /** @type {HTMLSelectElement|null} */ (this._q('.mw-filter-select'))
    if (select && select.value !== this._showFilter) select.value = this._showFilter
  }

  /** Keep the algorithm picker in step with a change made through the API. */
  _updateAlgoSelect() {
    const select = /** @type {HTMLSelectElement|null} */ (this._q('.mw-algo-select'))
    if (select && select.value !== this._algorithm) select.value = this._algorithm
  }

  /** Keep the Show Context box in step with a change made through the API. */
  _syncContextInput() {
    const input = /** @type {HTMLInputElement|null} */ (this._q('.mw-context-input'))
    if (input && input.value !== String(this._contextLines)) input.value = String(this._contextLines)
  }

  /** Keep the favour picker in step with a change made through the API. */
  _syncFavorSelect() {
    const select = /** @type {HTMLSelectElement|null} */ (this._q('.mw-favor-select'))
    if (select && select.value !== this._favor) select.value = this._favor
  }

  /** Keep the proximity box and the unimportant controls in step. */
  _syncUnimportantControls() {
    const prox = /** @type {HTMLInputElement|null} */ (this._q('.mw-proximity-input'))
    if (prox && prox.value !== String(this._conflictProximity)) {
      prox.value = String(this._conflictProximity)
    }
    const check = /** @type {HTMLInputElement|null} */ (this._q('.mw-unimportant-check'))
    if (check && check.checked !== this._ignoreUnimportant) check.checked = this._ignoreUnimportant
    const btn = this._q('.mw-btn-unimportant-edit')
    if (btn) btn.textContent = `樣式…（${this._unimportantPatterns.length}）`
    const clear = /** @type {HTMLButtonElement|null} */ (this._q('.mw-btn-clear-conflicts'))
    if (clear) clear.disabled = this._manualConflicts.length === 0
  }

  /** Reflect the output pane's edit state in its header. */
  _syncOutputControls() {
    const edited = this._outputOverride != null
    const badge = this._q('.mw-output-edited-badge')
    if (badge) badge.hidden = !edited
    const discard = this._q('.mw-btn-discard-output')
    if (discard) discard.hidden = !edited
    const edit = this._q('.mw-btn-edit-output')
    if (edit) {
      edit.textContent = this._outputEditing ? '結束編輯' : '編輯輸出'
      edit.classList.toggle('active', this._outputEditing)
    }
    const pane = this._q('.mw-output-pane')
    if (pane) {
      pane.classList.toggle('mw-output-pane--edited', edited)
      // The card list and the editor are siblings, so the one that is not in
      // use has to be taken out of the layout or it keeps its share of the pane.
      pane.classList.toggle('mw-output-pane--editing', this._outputEditing)
    }
  }

  /**
   * Base pane line numbers covered by the current selection.
   *
   * Only meaningful with the filter on 'all': every other mode drops the line
   * numbers precisely because its rows are not contiguous, so there is nothing
   * to map a selection back onto.
   *
   * @returns {number[]} 1-based, ascending
   */
  _selectedBaseLines() {
    const pane = this._contentEls.base
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
    if (!pane || !sel || sel.rangeCount === 0 || sel.isCollapsed) return []

    /** @type {Set<number>} */
    const lines = new Set()
    const add = (node) => {
      const n = Number(node?.dataset?.line)
      if (Number.isFinite(n) && n > 0) lines.add(n)
    }

    // Rows the range spans.
    for (const node of pane.querySelectorAll('.mw-line[data-line]')) {
      if (sel.containsNode(node, true)) add(node)
    }

    // A selection that sits *inside* one row contains no row, so the loop above
    // finds nothing — double-clicking a word and marking it would silently do
    // nothing. The endpoints are walked up to their row to cover that case.
    for (const end of [sel.anchorNode, sel.focusNode]) {
      const el = end?.nodeType === 1 ? end : end?.parentElement
      const row = el?.closest?.('.mw-line[data-line]')
      if (row && pane.contains(row)) add(row)
    }

    return [...lines].sort((a, b) => a - b)
  }

  /** Toolbar entry point for the manual conflict mark. */
  _markConflictFromSelection() {
    // A hidden pane holds no selection, so without this the user would get the
    // "select some lines first" message while looking at a layout that makes
    // selecting them impossible.
    if (!this._showBase || this._maximize === 'output') {
      this._reportError('基準窗格目前是隱藏的，請先顯示它再標記衝突。')
      return
    }
    if (this._showFilter !== 'all') {
      this._reportError('請先把「顯示」切回全部：篩選後的列沒有基準行號可對應。')
      return
    }
    const lines = this._selectedBaseLines()
    if (lines.length === 0) {
      this._reportError('請先在基準窗格中選取要標記為衝突的行。')
      return
    }
    if (!this.markConflictRange(lines[0], lines[lines.length - 1])) {
      this._reportError('選取的範圍不在基準檔案內，未標記。')
      return
    }
    this._emit('status', { message: `已把基準第 ${lines[0]}–${lines[lines.length - 1]} 行標記為衝突` })
  }

  /**
   * A modal built on the same shell the compare-to-output preview uses.
   *
   * @param {string} title
   * @param {(body: HTMLElement) => void} fill
   * @param {Array<{ label: string, primary?: boolean, run: () => boolean|void }>} [actions]
   *   returning false keeps the dialog open, so a validation error can be shown
   */
  _openModal(title, fill, actions = []) {
    const host = this._container ?? document.body
    const backdrop = document.createElement('div')
    backdrop.className = 'mw-modal-backdrop'
    const modal = document.createElement('div')
    modal.className = 'mw-modal'

    const titleEl = document.createElement('div')
    titleEl.className = 'mw-modal-title'
    titleEl.textContent = title
    modal.appendChild(titleEl)

    const body = document.createElement('div')
    body.className = 'mw-modal-body'
    fill(body)
    modal.appendChild(body)

    const actionsEl = document.createElement('div')
    actionsEl.className = 'mw-modal-actions'

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      backdrop.remove()
      document.removeEventListener('keydown', onKey, true)
    }
    const onKey = (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish() }
    }

    for (const action of actions) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'mw-modal-close' + (action.primary ? ' mw-modal-primary' : '')
      btn.textContent = action.label
      btn.addEventListener('click', () => {
        if (action.run() !== false) finish()
      })
      actionsEl.appendChild(btn)
    }

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'mw-modal-close'
    close.textContent = actions.length ? '取消' : '關閉'
    close.addEventListener('click', finish)
    actionsEl.appendChild(close)

    modal.appendChild(actionsEl)
    backdrop.appendChild(modal)
    host.appendChild(backdrop)

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish() })
    document.addEventListener('keydown', onKey, true)
    close.focus()
    return { backdrop, modal, body, close }
  }

  /** BC's Text Merge Info. */
  showInfo() {
    const info = this.getInfo()
    this._openModal('三向合併資訊', (body) => {
      const rows = info.sources.map((s) => [
        s.label, s.path || '（未載入）', String(s.lines), String(s.chars),
      ])
      body.appendChild(this._infoTable(
        ['來源', '路徑', '行數', '字元數'], rows))

      body.appendChild(this._infoTable(
        ['分類', '基準行數'],
        [
          ['未變更', String(info.segments.same)],
          ['僅左側變更', String(info.segments.left)],
          ['僅右側變更', String(info.segments.right)],
          ['兩側相同變更', String(info.segments.both)],
          ['衝突', String(info.segments.conflict)],
        ]))

      body.appendChild(this._infoTable(
        ['項目', '值'],
        [
          ['衝突總數', String(info.conflicts.total)],
          ['已解決', String(info.conflicts.resolved)],
          ['未解決', String(info.conflicts.unresolved)],
          ['對齊演算法', info.settings.algorithm],
          ['衝突鄰近門檻', String(info.settings.proximity)],
          ['偏好', info.settings.favor],
          ['忽略不重要差異', info.settings.ignoreUnimportant ? '是' : '否'],
          ['手動衝突標記', String(info.settings.manualConflicts)],
          ['輸出狀態', this._outputOverride != null ? '已手動編輯' : '由衝突選擇產生'],
        ]))
    })
  }

  /**
   * @param {string[]} headers
   * @param {string[][]} rows
   * @returns {HTMLElement}
   */
  _infoTable(headers, rows) {
    const table = document.createElement('table')
    table.className = 'mw-info-table'
    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    for (const h of headers) {
      const th = document.createElement('th')
      th.textContent = h
      htr.appendChild(th)
    }
    thead.appendChild(htr)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (const row of rows) {
      const tr = document.createElement('tr')
      for (const cell of row) {
        const td = document.createElement('td')
        // File paths are attacker-controlled; textContent keeps them inert.
        td.textContent = cell
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    return table
  }

  /** Edit the unimportant-difference patterns, one regex per line. */
  _openUnimportantEditor() {
    let textarea = null
    this._openModal('不重要差異樣式（每行一條正規表示式）', (body) => {
      const hint = document.createElement('div')
      hint.className = 'mw-modal-hint'
      hint.textContent = '符合的部分在比較時會被移除。可能造成災難性回溯的樣式會被拒絕並回報。'
      body.appendChild(hint)
      textarea = document.createElement('textarea')
      textarea.className = 'mw-modal-textarea'
      textarea.spellcheck = false
      textarea.value = this._unimportantPatterns.join('\n')
      body.appendChild(textarea)
    }, [{
      label: '套用',
      primary: true,
      run: () => {
        const list = String(textarea?.value ?? '').split('\n')
        this.setUnimportantPatterns(list)
        // Compiling reports its own rejections through _reportError, so a
        // pattern that was dropped never passes for one that is running.
        for (const src of this._unimportantPatterns) this._compileUnimportant(src)
        if (this._unimportantPatterns.length > 0 && !this._ignoreUnimportant) {
          this.setIgnoreUnimportant(true)
        }
      },
    }])
  }

  /**
   * Enable Merge Parent Folders only when it can actually do something.
   *
   * The host registers its listener after mount, so this runs again from `on()`
   * and after every path change rather than only at render time.
   */
  _syncParentFoldersButton() {
    const btn = /** @type {HTMLButtonElement|null} */ (this._q('.mw-btn-parent-folders'))
    if (!btn) return
    const ok = this.canMergeParentFolders()
    btn.disabled = !ok
    btn.title = ok
      ? '以三個來源的上層資料夾開啟資料夾比對'
      : '需要已載入的左右來源，且主視窗要接上 open-parent-folders 事件'
  }

  /**
   * Set up synchronized scrolling across all three content panes.
   * When any pane is scrolled, the other two are updated to match scrollTop.
   */
  _setupSyncScroll() {
    const panes = this._panes()
    if (panes.length < 2) return

    let syncing = false
    const handlers = panes.map((pane) => {
      const handler = () => {
        if (syncing) return
        syncing = true
        const scrollTop = pane.scrollTop
        // The one place the user's position is recorded. A pane hidden by a
        // layout toggle ignores the write below and reports 0 afterwards, so
        // the DOM alone cannot be trusted to remember it.
        this._scrollTop = scrollTop
        for (const other of panes) {
          if (other !== pane) other.scrollTop = scrollTop
        }
        syncing = false
        // Panes scroll as one, so one window range serves all three.
        this._renderPaneWindows(scrollTop)
      }
      pane.addEventListener('scroll', handler)
      return { pane, handler }
    })

    // 儲存以便 destroy 時移除
    this._syncScrollHandlers = handlers
  }

  // ---------------------------------------------------------------------------
  // Internal – 3-way merge logic
  // ---------------------------------------------------------------------------

  _runMerge() {
    const { leftDiff, rightDiff, segments, hasConflicts } = this._threeWayMerge(
      this._leftContent,
      this._baseContent,
      this._rightContent,
    )

    // Store segments and reset choices
    this._segments = segments
    this._conflictChoices = new Map()
    segments.forEach(seg => {
      if (seg.type === 'conflict') this._conflictChoices.set(seg.id, null)
    })
    this._leftDiff = leftDiff
    this._rightDiff = rightDiff
    this._currentConflict = -1

    // A standing favour applies before the output is drawn, so the new
    // conflicts appear already resolved rather than flashing unresolved first.
    this._applyFavorSilently()

    this._renderSides()
    this._renderOutputPane()
    this._updateConflictCounter()
    this._updateFilterButton()
    this._updateAlgoSelect()
    this._syncContextInput()
    this._syncFavorSelect()
    this._syncUnimportantControls()
    this._syncOutputControls()
    this._syncParentFoldersButton()
    this._consumePendingFirstDiff()

    this._emit('ready', { hasConflicts })
  }

  /**
   * BC's "when loading new files, go to first difference". Flag-gated so an
   * option change, which also re-merges, leaves the user where they were.
   */
  _consumePendingFirstDiff() {
    if (!this._pendingFirstDiff) return
    this._pendingFirstDiff = false
    if (!this.getConflictCount()) return
    if (!getNavOptions().firstDiffOnLoad) return
    this.firstConflict()
  }

  /** Recompute the row lists for all three panes and repaint the window. */
  _renderSides() {
    const common = {
      showFilter: this._showFilter,
      segments: this._segments,
      contextLines: this._contextLines,
    }
    this._paneRows = {
      left: buildPaneRows('left', { ...common, content: this._leftContent, diff: this._leftDiff }),
      base: buildPaneRows('base', { ...common, content: this._baseContent, diff: null }),
      right: buildPaneRows('right', { ...common, content: this._rightContent, diff: this._rightDiff }),
    }
    // Row lists changed, so the previously painted window says nothing about
    // what is on screen now.
    this._renderedRange = { start: -1, end: -1 }
    // The tracked offset, not the DOM's: with the sources collapsed every pane
    // reports 0, which would silently jump the user to the top of the file
    // every time a merge option changed.
    this._renderPaneWindows(this._scrollTop)
  }

  /**
   * Paint the rows visible at `scrollTop` into all three panes.
   *
   * @param {number} [scrollTop]
   */
  _renderPaneWindows(scrollTop = 0) {
    const total = Math.max(
      this._paneRows.left.length,
      this._paneRows.base.length,
      this._paneRows.right.length,
    )
    const viewport = this._panes()[0]?.clientHeight ?? 0
    const range = computeVisibleRange(scrollTop, viewport, total, ROW_HEIGHT, OVERSCAN_ROWS)
    if (range.start === this._renderedRange.start && range.end === this._renderedRange.end) return
    this._renderedRange = range

    for (const side of /** @type {const} */ (['left', 'base', 'right'])) {
      this._renderPaneWindow(side, range)
    }
  }

  /**
   * @param {'left'|'base'|'right'} side
   * @param {{ start: number, end: number }} range
   */
  _renderPaneWindow(side, range) {
    const contentEl = this._contentEls[side]
    if (!contentEl) return

    let spacer = contentEl.querySelector('.mw-vspacer')
    let win = spacer?.querySelector('.mw-vwindow')
    if (!spacer || !win) {
      contentEl.innerHTML = ''
      spacer = document.createElement('div')
      spacer.className = 'mw-vspacer'
      win = document.createElement('div')
      win.className = 'mw-vwindow'
      spacer.appendChild(win)
      contentEl.appendChild(spacer)
    }

    const rows = this._paneRows[side]
    spacer.style.height = `${rows.length * ROW_HEIGHT}px`
    win.style.transform = `translateY(${range.start * ROW_HEIGHT}px)`

    const frag = document.createDocumentFragment()
    for (let i = range.start; i < Math.min(range.end, rows.length); i++) {
      const row = rows[i]
      frag.appendChild(this._makeLine(row.type, row.lineNum, row.text))
    }
    win.replaceChildren(frag)
  }

  /**
   * The rows one pane would show in full — exposed for tests and for callers
   * that need line counts without touching the DOM.
   *
   * @param {'left'|'base'|'right'} side
   * @returns {PaneRow[]}
   */
  getPaneRows(side) {
    return this._paneRows[side] ?? []
  }

  /**
   * Grammar line weights for one pane, or undefined when they do not apply.
   *
   * Returning undefined for any one pane switches the whole merge back to
   * unweighted alignment, because comparing a weighted side against an
   * unweighted one would mean two different objectives in one DP.
   *
   * @param {string} path
   * @param {string} content
   * @returns {number[]|undefined}
   */
  _alignmentWeights(path, content) {
    if (!this._alignByGrammar || !path || !content) return undefined
    if (content.length > MAX_WEIGHT_ALIGN_CHARS) return undefined
    const grammar = getGrammarForPath(path)
    if (!grammar) return undefined
    return computeLineWeights(grammar, content.split('\n')).weights
  }

  /**
   * Simple line-by-line 3-way merge.
   * Returns segment array and diffs base→left, base→right.
   *
   * @param {string} left
   * @param {string} base
   * @param {string} right
   * @returns {{
   *   leftDiff: import('../core/diff-engine.js').DiffLine[],
   *   rightDiff: import('../core/diff-engine.js').DiffLine[],
   *   segments: MergeSegment[],
   *   hasConflicts: boolean
   * }}
   */
  _threeWayMerge(left, base, right) {
    const diffOpts = {
      algorithm: this._algorithm,
      ignoreWhitespace: this._ignoreWhitespace,
      ignoreCase: this._ignoreCase,
    }
    // Grammar line weights steer which of several equally short edit scripts
    // wins. Both diffs share the base, so its weights are computed once.
    const baseW = this._alignmentWeights(this._basePath || this._leftPath || this._rightPath, base)
    const leftW = this._alignmentWeights(this._leftPath || this._basePath, left)
    const rightW = this._alignmentWeights(this._rightPath || this._basePath, right)

    const leftDiff = diffLines(base || '', left || '', {
      ...diffOpts, leftWeights: baseW, rightWeights: leftW,
    })
    const rightDiff = diffLines(base || '', right || '', {
      ...diffOpts, leftWeights: baseW, rightWeights: rightW,
    })
    const baseLines = (base || '').split('\n')

    // S13-C01: build hunks from each diff, then walk base lines in order,
    // resolving overlapping hunks as conflicts. Positional alignment of
    // leftLines[i] vs baseLines[i] would mark every shifted line as a
    // conflict after a single insertion.
    const leftHunks  = _buildHunks(leftDiff)
    const rightHunks = _buildHunks(rightDiff)

    const { segments, hasConflicts } = mergeHunkSegments(baseLines, leftHunks, rightHunks, {
      proximity: this._conflictProximity,
      forced: this._manualConflicts,
      equals: this._segmentEquals,
    })

    return { leftDiff, rightDiff, segments, hasConflicts }
  }

  /**
   * Build the final output text from segments and current conflict choices.
   * Unresolved conflicts are rendered with <<< markers.
   *
   * @returns {string}
   */
  _buildOutputText() {
    if (this._outputOverride != null) return this._outputOverride
    return buildMergedText(this._segments, this._conflictChoices)
  }

  /**
   * Render the output pane with interactive conflict cards and normal segments.
   * Also syncs the hidden textarea value.
   */
  _renderOutputPane() {
    const pane = this._outputPaneEl
    if (!pane) return

    this._syncOutputControls()

    // In edit mode the textarea *is* the output; rebuilding the cards behind
    // it would only cost work nobody can see.
    if (this._outputEditing) {
      pane.innerHTML = ''
      this._syncOutputTextarea()
      return
    }

    pane.innerHTML = ''
    const frag = document.createDocumentFragment()

    if (this._outputOverride != null) {
      // The cards cannot describe hand-written text, and showing them anyway
      // would imply the choices still drive the output.
      const note = document.createElement('div')
      note.className = 'mw-output-edited-note'
      note.textContent = '輸出已手動編輯：衝突選擇暫停套用，可「捨棄手動編輯」還原。'
      pane.appendChild(note)
      const pre = document.createElement('pre')
      pre.className = 'mw-normal-seg mw-normal-seg--edited'
      pre.textContent = this._elideLines(this._outputOverride.split('\n'))
      pane.appendChild(pre)
      this._syncOutputTextarea()
      return
    }

    for (const seg of this._segments) {
      if (seg.type === 'normal') {
        const pre = document.createElement('pre')
        pre.className = 'mw-normal-seg'
        // The textarea below still carries every line; only this preview is
        // elided, so a 100k-line unchanged run cannot stall layout.
        pre.textContent = this._elideLines(seg.lines)
        frag.appendChild(pre)
      } else {
        // Conflict card
        const card = document.createElement('div')
        card.className = 'mw-conflict-card'
        card.dataset.conflictId = String(seg.id)

        const choicesDiv = document.createElement('div')
        choicesDiv.className = 'mw-conflict-choices'

        const btnLeft = document.createElement('button')
        btnLeft.className = 'mw-choice-btn mw-choice-left'
        btnLeft.dataset.id = String(seg.id)
        btnLeft.textContent = '接受左側'

        const btnBase = document.createElement('button')
        btnBase.className = 'mw-choice-btn mw-choice-base'
        btnBase.dataset.id = String(seg.id)
        btnBase.textContent = '採用中間'

        const btnBoth = document.createElement('button')
        btnBoth.className = 'mw-choice-btn mw-choice-both'
        btnBoth.dataset.id = String(seg.id)
        btnBoth.textContent = '兩者（左→右）'

        const btnBothRl = document.createElement('button')
        btnBothRl.className = 'mw-choice-btn mw-choice-both-rl'
        btnBothRl.dataset.id = String(seg.id)
        btnBothRl.textContent = '兩者（右→左）'

        const btnRight = document.createElement('button')
        btnRight.className = 'mw-choice-btn mw-choice-right'
        btnRight.dataset.id = String(seg.id)
        btnRight.textContent = '接受右側'

        // Restore active state if already chosen
        const existing = this._conflictChoices.get(seg.id)
        if (existing === 'left')  btnLeft.classList.add('active')
        if (existing === 'base')  btnBase.classList.add('active')
        if (existing === 'both')  btnBoth.classList.add('active')
        if (existing === 'both-rl') btnBothRl.classList.add('active')
        if (existing === 'right') btnRight.classList.add('active')

        choicesDiv.appendChild(btnLeft)
        choicesDiv.appendChild(btnBase)
        choicesDiv.appendChild(btnBoth)
        choicesDiv.appendChild(btnBothRl)
        choicesDiv.appendChild(btnRight)

        const previewDiv = document.createElement('div')
        previewDiv.className = 'mw-conflict-preview'
        previewDiv.appendChild(this._makeConflictSide('mw-conflict-left', 'LEFT', seg.leftLines))
        previewDiv.appendChild(this._makeConflictSide('mw-conflict-base', 'BASE', seg.baseLines))
        previewDiv.appendChild(this._makeConflictSide('mw-conflict-right', 'RIGHT', seg.rightLines))

        card.appendChild(choicesDiv)
        card.appendChild(previewDiv)
        frag.appendChild(card)
      }
    }

    pane.appendChild(frag)

    // Bind conflict choice button events
    pane.querySelectorAll('.mw-choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id)
        const card = pane.querySelector(`.mw-conflict-card[data-conflict-id="${id}"]`)

        // Determine which choice
        /** @type {ConflictChoice} */
        let choice
        if (btn.classList.contains('mw-choice-left'))  choice = 'left'
        else if (btn.classList.contains('mw-choice-right')) choice = 'right'
        else if (btn.classList.contains('mw-choice-base')) choice = 'base'
        else if (btn.classList.contains('mw-choice-both-rl')) choice = 'both-rl'
        else choice = 'both'

        this._conflictChoices.set(id, choice)

        // Update active states within this card
        card?.querySelectorAll('.mw-choice-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')

        // Sync textarea
        this._syncOutputTextarea()
      })
    })

    // Re-rendering rebuilds the cards, so the navigation cursor's highlight
    // has to be restored or it silently disappears on every choice click.
    const ids = collectConflictIds(this._segments)
    const currentId = this._currentConflict >= 0 ? ids[this._currentConflict] : null
    if (currentId != null) {
      pane.querySelector(`.mw-conflict-card[data-conflict-id="${currentId}"]`)
        ?.classList.add('mw-conflict-card--current')
    }

    // Initial textarea sync
    this._syncOutputTextarea()
  }

  /**
   * Sync the hidden textarea with the current buildOutputText result.
   */
  _syncOutputTextarea() {
    const el = this._outputEl
    if (!el) return
    const text = this._buildOutputText()
    // Guarded: this runs from the textarea's own input handler, and assigning
    // an identical value would still reset the caret to the end.
    if (el.value !== text) el.value = text
    el.classList.toggle('mw-output-textarea--visible', this._outputEditing)
    el.readOnly = !this._outputEditing
  }

  /**
   * One side of a conflict card.
   *
   * Built as nodes with textContent rather than escaped innerHTML: file
   * contents are the one thing here that is fully attacker-controlled, and a
   * single conflict can span thousands of lines, which the preview elides.
   *
   * @param {string} className
   * @param {string} label
   * @param {string[]} lines
   * @returns {HTMLElement}
   */
  _makeConflictSide(className, label, lines) {
    const div = document.createElement('div')
    div.className = className

    const labelEl = document.createElement('span')
    labelEl.className = 'mw-conflict-label'
    labelEl.textContent = label

    const pre = document.createElement('pre')
    pre.textContent = this._elideLines(lines)

    div.appendChild(labelEl)
    div.appendChild(pre)
    return div
  }

  /**
   * @param {string[]} lines
   * @returns {string} at most OUTPUT_PREVIEW_MAX_LINES lines plus a marker
   */
  _elideLines(lines) {
    const src = lines || []
    const extra = src.length - OUTPUT_PREVIEW_MAX_LINES
    if (extra <= 0) return src.join('\n')
    return [
      ...src.slice(0, OUTPUT_PREVIEW_MAX_LINES),
      `… 省略 ${extra} 行（輸出內容不受影響）`,
    ].join('\n')
  }

  // ---------------------------------------------------------------------------
  // Internal – pane rendering
  // ---------------------------------------------------------------------------

  /**
   * Create a single line element.
   * @param {string} type  'equal' | 'insert' | 'delete' | 'replace' | 'conflict'
   * @param {number|null} lineNum
   * @param {string} text
   * @returns {HTMLElement}
   */
  _makeLine(type, lineNum, text) {
    const div = document.createElement('div')
    div.className = `mw-line mw-line--${type}`

    // Carried on the row so a selection can be mapped back to base line
    // numbers; filtered modes pass null precisely because they cannot.
    if (lineNum != null) div.dataset.line = String(lineNum)

    const numEl = document.createElement('span')
    numEl.className = 'mw-linenum'
    numEl.textContent = lineNum != null ? String(lineNum) : ''

    const textEl = document.createElement('span')
    textEl.className = 'mw-linetext'
    textEl.textContent = text ?? ''

    div.appendChild(numEl)
    div.appendChild(textEl)
    return div
  }

  // ---------------------------------------------------------------------------
  // Internal – event emitter
  // ---------------------------------------------------------------------------

  /**
   * @param {string} event
   * @param {...*} args
   */
  _emit(event, ...args) {
    this._listeners.get(event)?.forEach(fn => fn(...args))
  }
}
