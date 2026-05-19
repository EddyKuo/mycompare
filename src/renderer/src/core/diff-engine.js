/**
 * @file diff-engine.js
 * @description Core diff algorithms: Myers O(ND) and Patience diff for line-level
 * comparison, plus LCS-based character-level intraline diff.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split text into lines, preserving the newline in each token.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  if (text === '') return [];
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/**
 * Apply pre-processing to a line for comparison purposes.
 * The original text is always kept; only the comparison key is normalised.
 * @param {string} line
 * @param {{ ignoreWhitespace?: boolean, ignoreCase?: boolean, ignoreLineEndings?: boolean, ignoreIndent?: boolean, ignoreCrlf?: boolean }} opts
 * @returns {string}
 */
function normalise(line, opts) {
  let s = line;
  if (opts.ignoreLineEndings || opts.ignoreCrlf) {
    s = s.replace(/\r\n|\r/g, '\n');
  }
  if (opts.ignoreIndent) {
    // strip leading whitespace only (preserves internal whitespace)
    s = s.replace(/^[ \t]+/, '');
  }
  if (opts.ignoreWhitespace) {
    // trim + collapse internal whitespace
    s = s.trim().replace(/\s+/g, ' ');
  }
  if (opts.ignoreCase) {
    s = s.toLowerCase();
  }
  return s;
}

// ---------------------------------------------------------------------------
// Myers O(ND) diff  (line level)
// ---------------------------------------------------------------------------

/**
 * Run the Myers diff algorithm on two arrays of (comparison-key) strings.
 * Returns a sequence of edit operations: each element is
 *   { op: 'equal'|'insert'|'delete', li: number, ri: number }
 * where li / ri are indices into `left` / `right` (0-based).
 *
 * @param {string[]} left   normalised left lines (keys)
 * @param {string[]} right  normalised right lines (keys)
 * @returns {{ op: string, li: number, ri: number }[]}
 */
function _myersDiff(left, right) {
  const N = left.length;
  const M = right.length;
  const MAX = N + M;

  if (MAX === 0) return [];

  // V[k] stores the furthest reaching x-coordinate on diagonal k
  // We use offset MAX so that negative k values map to positive indices.
  const size = 2 * MAX + 1;
  const V = new Int32Array(size);
  // trace[d] = snapshot of V after d-step exploration
  const trace = [];

  outer: for (let d = 0; d <= MAX; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      const ki = k + MAX; // offset index
      let x;
      if (k === -d || (k !== d && V[ki - 1] < V[ki + 1])) {
        x = V[ki + 1]; // move down (insert)
      } else {
        x = V[ki - 1] + 1; // move right (delete)
      }
      let y = x - k;
      // extend snake
      while (x < N && y < M && left[x] === right[y]) {
        x++;
        y++;
      }
      V[ki] = x;
      if (x >= N && y >= M) {
        trace.push(V.slice()); // final snapshot is already pushed above; push again to align index
        break outer;
      }
    }
  }

  // Back-trace to reconstruct the edit path
  const ops = [];
  let x = N;
  let y = M;

  for (let d = trace.length - 2; d >= 0; d--) {
    const Vprev = trace[d];
    const k = x - y;
    const ki = k + MAX;

    // Determine which move was taken to reach current (x, y)
    let prevK;
    if (k === -d || (k !== d && Vprev[ki - 1] < Vprev[ki + 1])) {
      prevK = k + 1; // came from insert (move down)
    } else {
      prevK = k - 1; // came from delete (move right)
    }
    const prevX = Vprev[prevK + MAX];
    const prevY = prevX - prevK;

    // Rewind snake from current position back to the edit point
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ op: 'equal', li: x, ri: y });
    }

    if (d > 0) {
      if (x === prevX) {
        // came via insert (moved down in y)
        y--;
        ops.push({ op: 'insert', li: -1, ri: y });
      } else {
        // came via delete (moved right in x)
        x--;
        ops.push({ op: 'delete', li: x, ri: -1 });
      }
    }
  }

  ops.reverse();
  return ops;
}

// ---------------------------------------------------------------------------
// Patience diff  (line level)
// ---------------------------------------------------------------------------

/**
 * Find unique lines that exist exactly once in both arrays.
 * Returns pairs [li, ri] of indices.
 * @param {string[]} left
 * @param {string[]} right
 * @param {number} lo  start index in left (inclusive)
 * @param {number} hi  end index in left (exclusive)
 * @param {number} ro  start index in right (inclusive)
 * @param {number} ri_end  end index in right (exclusive)
 * @returns {[number, number][]}
 */
function uniqueMatchingLines(left, right, lo, hi, ro, ri_end) {
  // Count occurrences in left slice
  /** @type {Map<string, number>} */
  const leftCount = new Map();
  /** @type {Map<string, number>} */
  const leftIdx = new Map();
  for (let i = lo; i < hi; i++) {
    const v = left[i];
    leftCount.set(v, (leftCount.get(v) ?? 0) + 1);
    leftIdx.set(v, i);
  }

  // Count occurrences in right slice
  /** @type {Map<string, number>} */
  const rightCount = new Map();
  /** @type {Map<string, number>} */
  const rightIdx = new Map();
  for (let i = ro; i < ri_end; i++) {
    const v = right[i];
    rightCount.set(v, (rightCount.get(v) ?? 0) + 1);
    rightIdx.set(v, i);
  }

  // Pairs that are unique in both
  const pairs = [];
  for (const [v, lc] of leftCount) {
    if (lc === 1 && rightCount.get(v) === 1) {
      pairs.push([leftIdx.get(v), rightIdx.get(v)]);
    }
  }

  // Sort by left index
  pairs.sort((a, b) => a[0] - b[0]);

  // LIS on right indices (patience sort)
  return lisOnRight(pairs);
}

/**
 * Longest increasing subsequence (by right index) among pairs, using
 * patience-sort binary search — O(n log n).
 * @param {[number, number][]} pairs
 * @returns {[number, number][]}
 */
function lisOnRight(pairs) {
  // S14-M09: parallel arrays instead of mutating caller-owned tuples.
  const n = pairs.length;
  if (n === 0) return [];

  // pileTops[k] = the index (into `pairs`) of the most recent pair placed on pile k.
  const pileTops = [];
  const prev = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const ri = pairs[i][1];
    let lo = 0;
    let hi = pileTops.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pairs[pileTops[mid]][1] < ri) lo = mid + 1;
      else hi = mid;
    }
    pileTops[lo] = i;
    prev[i] = lo > 0 ? pileTops[lo - 1] : -1;
  }

  const lis = [];
  let cur = pileTops[pileTops.length - 1];
  while (cur !== -1) {
    lis.push(pairs[cur]);
    cur = prev[cur];
  }
  lis.reverse();
  return lis;
}

/**
 * Find the rarest common lines shared by both arrays (histogram diff helper).
 * Returns pairs [li, ri] sorted by a LIS on the right indices.
 * @param {string[]} left
 * @param {string[]} right
 * @param {number} lo  start index in left (inclusive)
 * @param {number} hi  end index in left (exclusive)
 * @param {number} ro  start index in right (inclusive)
 * @param {number} ri_end  end index in right (exclusive)
 * @returns {[number, number][]}
 */
function rarestMatchingLines(left, right, lo, hi, ro, ri_end) {
  const leftCount = new Map();
  /** @type {Map<string, number[]>} */
  const leftPositions = new Map();
  for (let i = lo; i < hi; i++) {
    const v = left[i];
    leftCount.set(v, (leftCount.get(v) ?? 0) + 1);
    if (!leftPositions.has(v)) leftPositions.set(v, []);
    leftPositions.get(v).push(i);
  }

  const rightCount = new Map();
  /** @type {Map<string, number[]>} */
  const rightPositions = new Map();
  for (let i = ro; i < ri_end; i++) {
    const v = right[i];
    rightCount.set(v, (rightCount.get(v) ?? 0) + 1);
    if (!rightPositions.has(v)) rightPositions.set(v, []);
    rightPositions.get(v).push(i);
  }

  // Find the rarest common line (lowest combined occurrence count)
  let bestLine = null;
  let bestScore = Infinity;
  for (const [v, lc] of leftCount) {
    if (!rightCount.has(v)) continue;
    const score = lc + rightCount.get(v);
    if (score < bestScore) { bestScore = score; bestLine = v; }
  }
  if (bestLine === null) return [];

  // Build all cross-product pairs from all occurrences of bestLine
  const lPos = leftPositions.get(bestLine);
  const rPos = rightPositions.get(bestLine);
  const pairs = [];
  for (const li of lPos) {
    for (const ri of rPos) {
      pairs.push([li, ri]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  return lisOnRight(pairs);
}

/**
 * Patience diff algorithm.
 * @param {string[]} left   normalised left lines
 * @param {string[]} right  normalised right lines
 * @returns {{ op: string, li: number, ri: number }[]}
 */
function _patienceDiff(left, right) {
  const ops = [];

  /**
   * @param {number} lo  left start (inclusive)
   * @param {number} hi  left end (exclusive)
   * @param {number} ro  right start (inclusive)
   * @param {number} re  right end (exclusive)
   */
  function recurse(lo, hi, ro, re) {
    if (lo === hi && ro === re) return;
    if (lo === hi) {
      // All right lines are inserts
      for (let i = ro; i < re; i++) ops.push({ op: 'insert', li: -1, ri: i });
      return;
    }
    if (ro === re) {
      // All left lines are deletes
      for (let i = lo; i < hi; i++) ops.push({ op: 'delete', li: i, ri: -1 });
      return;
    }

    const anchors = uniqueMatchingLines(left, right, lo, hi, ro, re);

    if (anchors.length === 0) {
      // Fallback to Myers on this region
      const lSlice = left.slice(lo, hi);
      const rSlice = right.slice(ro, re);
      const subOps = _myersDiff(lSlice, rSlice);
      for (const op of subOps) {
        ops.push({
          op: op.op,
          li: op.li === -1 ? -1 : op.li + lo,
          ri: op.ri === -1 ? -1 : op.ri + ro,
        });
      }
      return;
    }

    // Process gaps between anchors
    let prevLi = lo;
    let prevRi = ro;

    for (const [ali, ari] of anchors) {
      // Recurse on the region before this anchor
      recurse(prevLi, ali, prevRi, ari);
      ops.push({ op: 'equal', li: ali, ri: ari });
      prevLi = ali + 1;
      prevRi = ari + 1;
    }

    // Recurse on the region after the last anchor
    recurse(prevLi, hi, prevRi, re);
  }

  recurse(0, left.length, 0, right.length);
  return ops;
}

// ---------------------------------------------------------------------------
// Histogram diff  (line level)
// ---------------------------------------------------------------------------

/**
 * Histogram diff algorithm.
 * Like Patience diff but uses the rarest common lines (not unique-only) as anchors.
 * Falls back to Myers when no common lines exist in a region.
 * @param {string[]} left   normalised left lines
 * @param {string[]} right  normalised right lines
 * @returns {{ op: string, li: number, ri: number }[]}
 */
function _histogramDiff(left, right) {
  const ops = [];

  /**
   * @param {number} lo  left start (inclusive)
   * @param {number} hi  left end (exclusive)
   * @param {number} ro  right start (inclusive)
   * @param {number} re  right end (exclusive)
   */
  function recurse(lo, hi, ro, re) {
    if (lo === hi && ro === re) return;
    if (lo === hi) {
      for (let i = ro; i < re; i++) ops.push({ op: 'insert', li: -1, ri: i });
      return;
    }
    if (ro === re) {
      for (let i = lo; i < hi; i++) ops.push({ op: 'delete', li: i, ri: -1 });
      return;
    }

    const anchors = rarestMatchingLines(left, right, lo, hi, ro, re);

    if (anchors.length === 0) {
      // Fallback to Myers on this region
      const lSlice = left.slice(lo, hi);
      const rSlice = right.slice(ro, re);
      const subOps = _myersDiff(lSlice, rSlice);
      for (const op of subOps) {
        ops.push({
          op: op.op,
          li: op.li === -1 ? -1 : op.li + lo,
          ri: op.ri === -1 ? -1 : op.ri + ro,
        });
      }
      return;
    }

    let prevLi = lo;
    let prevRi = ro;

    for (const [ali, ari] of anchors) {
      recurse(prevLi, ali, prevRi, ari);
      ops.push({ op: 'equal', li: ali, ri: ari });
      prevLi = ali + 1;
      prevRi = ari + 1;
    }

    recurse(prevLi, hi, prevRi, re);
  }

  recurse(0, left.length, 0, right.length);
  return ops;
}

// ---------------------------------------------------------------------------
// Character-level LCS diff
// ---------------------------------------------------------------------------

/**
 * Compute LCS lengths table for two character arrays.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number[][]}
 */
function lcsTable(a, b) {
  const m = a.length;
  const n = b.length;
  // S13-C04: use Uint32Array (Uint16 silently wraps at 65535 — possible for
  // pathological inputs like minified JS lines).
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
      }
    }
  }
  return dp;
}

// S13-C04: hard cap on char-level LCS. Above this we fall back to a single
// delete+insert pair (no intra-line highlight). The LCS table grows O(m·n);
// 5000×5000 already allocates ~100MB of Uint32Array.
const MAX_CHAR_DIFF_LEN = 5000;

/**
 * Backtrack through LCS table to produce character-level diffs.
 * @param {string[]} a
 * @param {string[]} b
 * @param {number[][]} dp
 * @returns {CharDiff[]}
 */
function backtrackLCS(a, b, dp) {
  /** @type {CharDiff[]} */
  const result = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: 'equal', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'insert', text: b[j - 1] });
      j--;
    } else {
      result.push({ type: 'delete', text: a[i - 1] });
      i--;
    }
  }

  result.reverse();
  return result;
}

// ---------------------------------------------------------------------------
// Public API: diffChars
// ---------------------------------------------------------------------------

/**
 * Compute character-level differences between two strings.
 * Consecutive equal characters are merged into a single token.
 *
 * @param {string} leftStr
 * @param {string} rightStr
 * @returns {CharDiff[]}
 *
 * @typedef {{ type: 'equal'|'insert'|'delete', text: string }} CharDiff
 */
/**
 * Merge CharDiff tokens of the same type that are adjacent.
 * @param {CharDiff[]} diffs
 * @returns {CharDiff[]}
 */
function mergeAdjacentSameType(diffs) {
  /** @type {CharDiff[]} */
  const out = [];
  for (const d of diffs) {
    if (out.length > 0 && out[out.length - 1].type === d.type) {
      out[out.length - 1].text += d.text;
    } else {
      out.push({ type: d.type, text: d.text });
    }
  }
  return out;
}

/**
 * Post-process: absorb single-character equal segments that are flanked by
 * delete/insert tokens on both sides. This prevents spurious sub-character
 * anchors from splitting semantically whole words (e.g. the 'r' in 'world' vs
 * 'Earth' being identified as a common character, fragmenting the diff).
 * @param {CharDiff[]} diffs
 * @returns {CharDiff[]}
 */
function absorbShortEquals(diffs) {
  let result = [...diffs];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i + 1 < result.length; i++) {
      const eq = result[i];
      if (eq.type !== 'equal' || eq.text.length > 1) continue;
      const before = result[i - 1];
      const after  = result[i + 1];
      if ((before.type === 'delete' || before.type === 'insert') &&
          (after.type  === 'delete' || after.type  === 'insert')) {
        // Collect all del/ins tokens before the short equal (going left)
        let lo = i - 1;
        while (lo > 0 && (result[lo - 1].type === 'delete' || result[lo - 1].type === 'insert')) lo--;
        // Collect all del/ins tokens after (going right)
        let hi = i + 1;
        while (hi + 1 < result.length && (result[hi + 1].type === 'delete' || result[hi + 1].type === 'insert')) hi++;
        // Build merged delete and insert from the block lo..hi plus the equal
        let delText = '';
        let insText = '';
        for (let k = lo; k <= hi; k++) {
          if (result[k].type === 'delete' || result[k].type === 'equal') delText += result[k].text;
          if (result[k].type === 'insert' || result[k].type === 'equal') insText += result[k].text;
        }
        const replacement = [];
        if (delText) replacement.push({ type: 'delete', text: delText });
        if (insText) replacement.push({ type: 'insert', text: insText });
        result = [...result.slice(0, lo), ...replacement, ...result.slice(hi + 1)];
        changed = true;
        break;
      }
    }
  }
  return result;
}

export function diffChars(leftStr, rightStr) {
  if (leftStr === rightStr) return [{ type: 'equal', text: leftStr }];
  if (leftStr === '') return [{ type: 'insert', text: rightStr }];
  if (rightStr === '') return [{ type: 'delete', text: leftStr }];

  // S13-C04: cap inputs to avoid O(m·n) memory + time blowups.
  if (leftStr.length > MAX_CHAR_DIFF_LEN || rightStr.length > MAX_CHAR_DIFF_LEN) {
    return [
      { type: 'delete', text: leftStr },
      { type: 'insert', text: rightStr },
    ];
  }

  const a = Array.from(leftStr);  // surrogate-pair safe
  const b = Array.from(rightStr);
  const dp = lcsTable(a, b);
  const rawDiffs = backtrackLCS(a, b, dp);
  const merged = mergeAdjacentSameType(rawDiffs);
  return absorbShortEquals(merged);
}

// ---------------------------------------------------------------------------
// Public API: diffLines
// ---------------------------------------------------------------------------

/**
 * Compute line-level differences between two text strings.
 *
 * Consecutive delete/insert pairs on equal positions are collapsed into
 * `replace` entries.
 *
 * @param {string} leftText
 * @param {string} rightText
 * @param {{
 *   algorithm?: 'myers'|'patience'|'histogram',
 *   ignoreWhitespace?: boolean,
 *   ignoreCase?: boolean,
 *   ignoreLineEndings?: boolean,
 *   ignoreIndent?: boolean,
 *   ignoreCrlf?: boolean
 * }} options
 * @returns {DiffLine[]}
 *
 * @typedef {{
 *   type: 'equal'|'insert'|'delete'|'replace',
 *   leftLine: number|null,
 *   rightLine: number|null,
 *   leftText: string,
 *   rightText: string
 * }} DiffLine
 */
export function diffLines(leftText, rightText, options = {}) {
  const opts = {
    algorithm: 'myers',
    ignoreWhitespace: false,
    ignoreCase: false,
    ignoreLineEndings: false,
    ignoreIndent: false,
    ignoreCrlf: false,
    ...options,
  };

  // Split originals
  const leftLines = splitLines(leftText);
  const rightLines = splitLines(rightText);

  // Build normalised comparison keys
  const leftKeys = leftLines.map((l) => normalise(l, opts));
  const rightKeys = rightLines.map((l) => normalise(l, opts));

  // Run chosen algorithm
  let ops;
  if (opts.algorithm === 'patience') {
    ops = _patienceDiff(leftKeys, rightKeys);
  } else if (opts.algorithm === 'histogram') {
    ops = _histogramDiff(leftKeys, rightKeys);
  } else {
    ops = _myersDiff(leftKeys, rightKeys);
  }

  // Convert ops to DiffLine objects (1-based line numbers)
  /** @type {DiffLine[]} */
  const raw = ops.map((op) => ({
    type: op.op,
    leftLine: op.li === -1 ? null : op.li + 1,
    rightLine: op.ri === -1 ? null : op.ri + 1,
    leftText: op.li === -1 ? '' : leftLines[op.li],
    rightText: op.ri === -1 ? '' : rightLines[op.ri],
  }));

  // Merge consecutive delete+insert into replace
  /** @type {DiffLine[]} */
  const result = [];
  let i = 0;
  while (i < raw.length) {
    const cur = raw[i];
    if (cur.type === 'delete' && i + 1 < raw.length && raw[i + 1].type === 'insert') {
      const next = raw[i + 1];
      result.push({
        type: 'replace',
        leftLine: cur.leftLine,
        rightLine: next.rightLine,
        leftText: cur.leftText,
        rightText: next.rightText,
      });
      i += 2;
    } else {
      result.push(cur);
      i++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public low-level exports (accept string arrays, return DiffLine[])
// ---------------------------------------------------------------------------

/**
 * @param {{ op: string, li: number, ri: number }[]} ops
 * @param {string[]} leftLines
 * @param {string[]} rightLines
 * @returns {DiffLine[]}
 */
function opsToLines(ops, leftLines, rightLines) {
  const raw = ops.map((op) => ({
    type: op.op,
    leftLine: op.li === -1 ? null : op.li + 1,
    rightLine: op.ri === -1 ? null : op.ri + 1,
    leftText: op.li === -1 ? '' : leftLines[op.li],
    rightText: op.ri === -1 ? '' : rightLines[op.ri],
  }));
  const result = [];
  let i = 0;
  while (i < raw.length) {
    const cur = raw[i];
    if (cur.type === 'delete' && i + 1 < raw.length && raw[i + 1].type === 'insert') {
      const next = raw[i + 1];
      result.push({ type: 'replace', leftLine: cur.leftLine, rightLine: next.rightLine, leftText: cur.leftText, rightText: next.rightText });
      i += 2;
    } else {
      result.push(cur);
      i++;
    }
  }
  return result;
}

/**
 * Myers diff on string arrays — returns DiffLine[].
 * @param {string[]} leftLines
 * @param {string[]} rightLines
 * @returns {DiffLine[]}
 */
export function myersDiff(leftLines, rightLines) {
  return opsToLines(_myersDiff(leftLines, rightLines), leftLines, rightLines);
}

/**
 * Patience diff on string arrays — returns DiffLine[].
 * @param {string[]} leftLines
 * @param {string[]} rightLines
 * @returns {DiffLine[]}
 */
export function patienceDiff(leftLines, rightLines) {
  return opsToLines(_patienceDiff(leftLines, rightLines), leftLines, rightLines);
}

/** Alias for diffChars — intraline character-level diff. */
export const intralineDiff = diffChars;

/**
 * Histogram diff on string arrays — returns DiffLine[].
 * @param {string[]} leftLines
 * @param {string[]} rightLines
 * @returns {DiffLine[]}
 */
export function histogramDiff(leftLines, rightLines) {
  return opsToLines(_histogramDiff(leftLines, rightLines), leftLines, rightLines);
}
