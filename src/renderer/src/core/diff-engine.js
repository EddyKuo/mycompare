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
  const N0 = left.length;
  const M0 = right.length;
  if (N0 === 0 && M0 === 0) return [];

  // Trim the common prefix and suffix before running Myers. Two large files
  // that share most of their content collapse to a small differing middle,
  // which is what keeps the edit distance — and therefore the cost — low.
  const minLen = Math.min(N0, M0);
  let pre = 0;
  while (pre < minLen && left[pre] === right[pre]) pre++;
  let suf = 0;
  while (suf < minLen - pre && left[N0 - 1 - suf] === right[M0 - 1 - suf]) suf++;

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ op: 'equal', li: i, ri: i });

  const a = left.slice(pre, N0 - suf);
  const b = right.slice(pre, M0 - suf);
  for (const op of _myersCore(a, b, pre)) ops.push(op);

  for (let i = 0; i < suf; i++) {
    ops.push({ op: 'equal', li: N0 - suf + i, ri: M0 - suf + i });
  }
  return ops;
}

/**
 * Ceiling on the Myers edit-distance search.
 *
 * The back-trace keeps one V snapshot per round, so trace memory grows as
 * ~4·(D+1)² bytes; without a ceiling, two large mostly-different files drive D
 * towards N+M and exhaust memory before the algorithm ever finishes.
 */
const MAX_LINE_DIFF_D = 3000;

/** Work ceiling for the O((N+M)·D) search, used to scale the budget by size. */
const LINE_DIFF_OP_BUDGET = 1e8;

/**
 * Myers O(ND) over an already prefix/suffix-trimmed pair.
 *
 * When the edit distance exceeds the budget the search stops and the path is
 * reconstructed from the furthest-reaching diagonal, with whatever remains
 * emitted as a delete/insert block. That yields a usable — if not minimal —
 * diff instead of hanging.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @param {number} off  index offset to add back to li/ri
 * @returns {{ op: string, li: number, ri: number }[]}
 */
function _myersCore(a, b, off) {
  const N = a.length;
  const M = b.length;
  if (N === 0 && M === 0) return [];
  if (N === 0) return b.map((_, j) => ({ op: 'insert', li: -1, ri: off + j }));
  if (M === 0) return a.map((_, i) => ({ op: 'delete', li: off + i, ri: -1 }));

  const budget = Math.max(64, Math.floor(LINE_DIFF_OP_BUDGET / (N + M)));
  const limit = Math.min(MAX_LINE_DIFF_D, budget, N + M);
  const vOff = limit + 1;
  const V = new Int32Array(2 * limit + 3);
  /** @type {Int32Array[]} trace[d] holds V after d-1 rounds, trimmed to k ∈ [-d, d] */
  const trace = [];
  let found = -1;

  outer: for (let d = 0; d <= limit; d++) {
    trace.push(V.slice(vOff - d, vOff + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const ki = k + vOff;
      let x;
      if (k === -d || (k !== d && V[ki - 1] < V[ki + 1])) {
        x = V[ki + 1]; // move down (insert)
      } else {
        x = V[ki - 1] + 1; // move right (delete)
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      V[ki] = x;
      if (x >= N && y >= M) {
        found = d;
        break outer;
      }
    }
  }

  let startX = N;
  let startY = M;
  let startD = found;
  /** @type {{ op: string, li: number, ri: number }[]} */
  const tail = [];

  if (found < 0) {
    // Budget exhausted. Resume from the diagonal that got furthest along and
    // treat the unexplored remainder as a wholesale replacement.
    startD = limit;
    let best = -1;
    for (let k = -limit; k <= limit; k += 2) {
      const x = V[k + vOff];
      const y = x - k;
      if (x >= 0 && y >= 0 && x <= N && y <= M && x + y > best) {
        best = x + y;
        startX = x;
        startY = y;
      }
    }
    for (let i = startX; i < N; i++) tail.push({ op: 'delete', li: off + i, ri: -1 });
    for (let j = startY; j < M; j++) tail.push({ op: 'insert', li: -1, ri: off + j });
  }

  const ops = [];
  let x = startX;
  let y = startY;
  for (let d = startD; d > 0; d--) {
    const Vprev = trace[d]; // diagonal k sits at index k + d
    const k = x - y;
    const prevK = (k === -d || (k !== d && Vprev[k - 1 + d] < Vprev[k + 1 + d]))
      ? k + 1
      : k - 1;
    const prevX = Vprev[prevK + d];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ op: 'equal', li: off + x, ri: off + y });
    }
    if (x === prevX) {
      y--;
      ops.push({ op: 'insert', li: -1, ri: off + y });
    } else {
      x--;
      ops.push({ op: 'delete', li: off + x, ri: -1 });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ op: 'equal', li: off + x, ri: off + y });
  }
  while (x > 0) {
    x--;
    ops.push({ op: 'delete', li: off + x, ri: -1 });
  }
  while (y > 0) {
    y--;
    ops.push({ op: 'insert', li: -1, ri: off + y });
  }

  ops.reverse();
  for (const op of tail) ops.push(op);
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
  // Ties on the left index are ordered by *descending* right index on purpose.
  // lisOnRight only enforces a strictly increasing right index, so with an
  // ascending tie-break two pairs sharing a left line — say [3,4] and [3,7] —
  // both satisfy it and the same left line ends up matched twice. The emitted
  // script then steps backwards, which no consumer expects. Reversing the tie
  // makes the right index decrease within a tie group, so at most one member
  // can appear in an increasing subsequence.
  pairs.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  return lisOnRight(pairs);
}

/**
 * Recursion cap for the anchor-based algorithms.
 *
 * Chosen well below the engine's stack limit: the drivers recurse once per
 * anchor, so a file with many single-anchor regions goes deep in a way the
 * usual "it is a divide and conquer, depth is logarithmic" intuition does not
 * predict.
 */
const MAX_ANCHOR_DEPTH = 2000;

/**
 * Total lines the anchor phase may scan across a whole diff.
 *
 * Each level rebuilds occurrence counts over its whole region, and a level
 * that yields one anchor shrinks the region by one line — so a file of
 * distinct lines costs O(N²) scanning. At 50,000 lines that measured 58
 * seconds against Myers' 45 milliseconds for the same input. Depth alone does
 * not bound it: capping depth stops the crash and leaves the wait.
 *
 * Myers is already budget-limited and degrades gracefully, so it takes over
 * once this is spent.
 */
const ANCHOR_SCAN_BUDGET = 4e6;

/**
 * Diff one region with Myers and append it, offset back into the whole file.
 *
 * @param {{op: string, li: number, ri: number}[]} ops
 * @param {string[]} left
 * @param {string[]} right
 * @param {number} lo @param {number} hi @param {number} ro @param {number} re
 */
function _pushMyersRegion(ops, left, right, lo, hi, ro, re) {
  const subOps = _myersDiff(left.slice(lo, hi), right.slice(ro, re));
  for (const op of subOps) {
    ops.push({
      op: op.op,
      li: op.li === -1 ? -1 : op.li + lo,
      ri: op.ri === -1 ? -1 : op.ri + ro,
    });
  }
}

/**
 * Patience diff algorithm.
 * @param {string[]} left   normalised left lines
 * @param {string[]} right  normalised right lines
 * @returns {{ op: string, li: number, ri: number }[]}
 */
function _patienceDiff(left, right) {
  const ops = [];
  let scanned = 0;

  /**
   * @param {number} lo  left start (inclusive)
   * @param {number} hi  left end (exclusive)
   * @param {number} ro  right start (inclusive)
   * @param {number} re  right end (exclusive)
   */
  function recurse(lo, hi, ro, re, depth = 0) {
    if (lo === hi && ro === re) return;
    // Each level peels one anchor and recurses on the remainder, so depth
    // grows with the number of anchors, not with the log of the input. At tens
    // of thousands of lines that exhausts the JS stack and the diff dies
    // outright; Myers over the rest is a worse alignment but a real answer.
    if (depth > MAX_ANCHOR_DEPTH || scanned > ANCHOR_SCAN_BUDGET) {
      _pushMyersRegion(ops, left, right, lo, hi, ro, re);
      return;
    }
    scanned += (hi - lo) + (re - ro);
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
      recurse(prevLi, ali, prevRi, ari, depth + 1);
      ops.push({ op: 'equal', li: ali, ri: ari });
      prevLi = ali + 1;
      prevRi = ari + 1;
    }

    // Recurse on the region after the last anchor
    recurse(prevLi, hi, prevRi, re, depth + 1);
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
  let scanned = 0;

  /**
   * @param {number} lo  left start (inclusive)
   * @param {number} hi  left end (exclusive)
   * @param {number} ro  right start (inclusive)
   * @param {number} re  right end (exclusive)
   */
  function recurse(lo, hi, ro, re, depth = 0) {
    if (lo === hi && ro === re) return;
    // Each level peels one anchor and recurses on the remainder, so depth
    // grows with the number of anchors, not with the log of the input. At tens
    // of thousands of lines that exhausts the JS stack and the diff dies
    // outright; Myers over the rest is a worse alignment but a real answer.
    if (depth > MAX_ANCHOR_DEPTH || scanned > ANCHOR_SCAN_BUDGET) {
      _pushMyersRegion(ops, left, right, lo, hi, ro, re);
      return;
    }
    scanned += (hi - lo) + (re - ro);
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
      recurse(prevLi, ali, prevRi, ari, depth + 1);
      ops.push({ op: 'equal', li: ali, ri: ari });
      prevLi = ali + 1;
      prevRi = ari + 1;
    }

    recurse(prevLi, hi, prevRi, re, depth + 1);
  }

  recurse(0, left.length, 0, right.length);
  return ops;
}

// ---------------------------------------------------------------------------
// Weighted re-alignment (BC "line weights")
// ---------------------------------------------------------------------------
//
// A grammar assigns every line a weight: a preprocessor directive weighs 3, a
// keyword line 2, unclassified text 1, a comment-only line 0.5, a blank line 0.
// Beyond Compare feeds those into alignment, and the reason is that the
// minimal edit script is rarely unique. When several pairings cost the same
// number of edits, the plain algorithms pick one arbitrarily, and the arbitrary
// pick is often the worst one: matching up the interchangeable filler that
// litters every source file — blank lines, lone braces, repeated comment
// banners — while tearing a moved block of real code in half.
//
// So the objective changes from "match the most lines" to "match the most
// weight", which makes a structural line worth more than the two blank lines
// that could be matched instead.
//
// Doing that globally would mean an O(N·M) DP and would throw away the O(ND)
// behaviour the whole engine is built on. Instead the unweighted script is
// computed first and only its *weakly anchored* stretches are re-solved: a run
// of consecutive equal lines whose weights add up to WEIGHTED_ANCHOR_WEIGHT is
// trusted evidence and is left untouched, so the DP only ever sees the
// confused regions between such runs, each of them separately capped by area
// and by a global cell budget. Total extra work is therefore bounded by a
// constant, independent of file size.
//
// The anchor test is by weight and not by length on purpose: a run of three
// equal lines reading `}` / blank / `// ----` is precisely the accidental
// anchor that causes the misalignment, so trusting it would make the pass a
// no-op in the case it exists for.

/** Summed weight an equal run needs before it is trusted as an anchor. */
const WEIGHTED_ANCHOR_WEIGHT = 4;

/** Largest (left × right) region re-solved by the weighted DP. */
const WEIGHTED_WINDOW_AREA = 40_000;

/** Ceiling on DP cells across one diff, so pathological files stay bounded. */
const WEIGHTED_CELL_BUDGET = 5_000_000;

/**
 * Value of a match before its weight is added.
 *
 * Without it a weight-0 line (a blank) would gain nothing by being matched and
 * the DP would pair blanks at random. Its size also sets how far weight is
 * allowed to override line count: at 2, the heaviest line is worth 2.5 blanks,
 * so weight decides among comparable candidates but a clearly longer match
 * still wins. Lowering it towards 0 turns weight into the only criterion and
 * starts discarding alignments the unweighted engine already got right.
 */
const WEIGHTED_MATCH_BASE = 2;

/** Weights are user-editable, so a missing or non-finite entry falls back. */
function _weightAt(arr, i) {
  const w = arr[i];
  return Number.isFinite(w) ? w : 1;
}

/**
 * Weighted LCS over one window, returning ops with global indices.
 *
 * @param {string[]} left
 * @param {string[]} right
 * @param {number[]} lw
 * @param {number[]} rw
 * @param {number} l0
 * @param {number} l1
 * @param {number} r0
 * @param {number} r1
 * @returns {{ op: string, li: number, ri: number }[]}
 */
function _weightedLcsOps(left, right, lw, rw, l0, l1, r0, r1) {
  const N = l1 - l0;
  const M = r1 - r0;
  const W = M + 1;
  const dp = new Float64Array((N + 1) * W);

  for (let i = 1; i <= N; i++) {
    const a = left[l0 + i - 1];
    const wl = _weightAt(lw, l0 + i - 1);
    const row = i * W;
    const prow = row - W;
    for (let j = 1; j <= M; j++) {
      const up = dp[prow + j];
      const lf = dp[row + j - 1];
      let best = up > lf ? up : lf;
      if (a === right[r0 + j - 1]) {
        const wr = _weightAt(rw, r0 + j - 1);
        const diag = dp[prow + j - 1] + WEIGHTED_MATCH_BASE + (wl > wr ? wl : wr);
        // Not always the best move: a heavier match one row up can beat it,
        // which is exactly the preference this whole pass exists to express.
        if (diag > best) best = diag;
      }
      dp[row + j] = best;
    }
  }

  /** @type {{ op: string, li: number, ri: number }[]} */
  const ops = [];
  let i = N;
  let j = M;
  while (i > 0 && j > 0) {
    let takeDiag = false;
    if (left[l0 + i - 1] === right[r0 + j - 1]) {
      const wl = _weightAt(lw, l0 + i - 1);
      const wr = _weightAt(rw, r0 + j - 1);
      const diag = dp[(i - 1) * W + j - 1] + WEIGHTED_MATCH_BASE + (wl > wr ? wl : wr);
      takeDiag = dp[i * W + j] - diag <= 1e-9;
    }
    if (takeDiag) {
      ops.push({ op: 'equal', li: l0 + i - 1, ri: r0 + j - 1 });
      i--;
      j--;
    } else if (dp[i * W + j - 1] >= dp[(i - 1) * W + j]) {
      // Emitting the insert first here puts it *after* the delete once the
      // list is reversed, which is the order diffLines folds into `replace`.
      ops.push({ op: 'insert', li: -1, ri: r0 + j - 1 });
      j--;
    } else {
      ops.push({ op: 'delete', li: l0 + i - 1, ri: -1 });
      i--;
    }
  }
  while (i > 0) {
    i--;
    ops.push({ op: 'delete', li: l0 + i, ri: -1 });
  }
  while (j > 0) {
    j--;
    ops.push({ op: 'insert', li: -1, ri: r0 + j });
  }
  ops.reverse();
  return ops;
}

/**
 * Re-solve the weakly anchored stretches of an edit script by matched weight.
 *
 * @param {{ op: string, li: number, ri: number }[]} ops
 * @param {string[]} left   comparison keys
 * @param {string[]} right  comparison keys
 * @param {number[]} lw
 * @param {number[]} rw
 * @returns {{ op: string, li: number, ri: number }[]}
 */
function _weightAlign(ops, left, right, lw, rw) {
  const n = ops.length;
  if (n === 0) return ops;

  /** @type {{ op: string, li: number, ri: number }[]} */
  const out = [];
  let budget = WEIGHTED_CELL_BUDGET;

  // Window bounds are read off the surrounding anchors' own li/ri rather than
  // counted along the script: the histogram variant can emit an anchor whose
  // indices step backwards, and a counter would then address the wrong lines.
  // Taking the bounds from the anchors makes the malformed case merely fail
  // the ordering check below and fall through to the original ops.
  let segStart = 0;
  let segX = 0;
  let segY = 0;

  /**
   * @param {number} to   exclusive op index ending the segment
   * @param {number} toX  exclusive left bound of the window
   * @param {number} toY  exclusive right bound of the window
   */
  const flush = (to, toX, toY) => {
    if (to <= segStart) return;
    const rows = toX - segX;
    const cols = toY - segY;
    const area = rows * cols;
    if (rows > 0 && cols > 0 && area <= WEIGHTED_WINDOW_AREA && area <= budget) {
      budget -= area;
      for (const op of _weightedLcsOps(left, right, lw, rw, segX, toX, segY, toY)) out.push(op);
    } else {
      for (let k = segStart; k < to; k++) out.push(ops[k]);
    }
  };

  let i = 0;
  while (i < n) {
    if (ops[i].op !== 'equal') { i++; continue; }

    let j = i;
    let runWeight = 0;
    while (j < n && ops[j].op === 'equal') {
      const a = _weightAt(lw, ops[j].li);
      const b = _weightAt(rw, ops[j].ri);
      runWeight += a > b ? a : b;
      j++;
    }

    if (runWeight >= WEIGHTED_ANCHOR_WEIGHT) {
      flush(i, ops[i].li, ops[i].ri);
      for (let k = i; k < j; k++) out.push(ops[k]);
      segStart = j;
      segX = ops[j - 1].li + 1;
      segY = ops[j - 1].ri + 1;
    }
    i = j;
  }
  flush(n, left.length, right.length);
  return out;
}

/**
 * @param {{ leftWeights?: number[], rightWeights?: number[] }} opts
 * @returns {boolean}
 */
function _hasWeights(opts) {
  return Array.isArray(opts?.leftWeights) && Array.isArray(opts?.rightWeights)
    && (opts.leftWeights.length > 0 || opts.rightWeights.length > 0);
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
 *   ignoreCrlf?: boolean,
 *   leftWeights?: number[],
 *   rightWeights?: number[]
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

  if (_hasWeights(opts)) {
    ops = _weightAlign(ops, leftKeys, rightKeys, opts.leftWeights, opts.rightWeights);
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
 * @typedef {{ leftWeights?: number[], rightWeights?: number[] }} WeightOptions
 */

/**
 * @param {{ op: string, li: number, ri: number }[]} ops
 * @param {string[]} leftLines
 * @param {string[]} rightLines
 * @param {WeightOptions} [opts]
 * @returns {{ op: string, li: number, ri: number }[]}
 */
function maybeWeight(ops, leftLines, rightLines, opts) {
  if (!_hasWeights(opts)) return ops;
  return _weightAlign(ops, leftLines, rightLines, opts.leftWeights, opts.rightWeights);
}

/**
 * Myers diff on string arrays — returns DiffLine[].
 * @param {string[]} leftLines
 * @param {string[]} rightLines
 * @param {WeightOptions} [opts]
 * @returns {DiffLine[]}
 */
export function myersDiff(leftLines, rightLines, opts) {
  const ops = maybeWeight(_myersDiff(leftLines, rightLines), leftLines, rightLines, opts);
  return opsToLines(ops, leftLines, rightLines);
}

/**
 * Patience diff on string arrays — returns DiffLine[].
 * @param {string[]} leftLines
 * @param {string[]} rightLines
 * @param {WeightOptions} [opts]
 * @returns {DiffLine[]}
 */
export function patienceDiff(leftLines, rightLines, opts) {
  const ops = maybeWeight(_patienceDiff(leftLines, rightLines), leftLines, rightLines, opts);
  return opsToLines(ops, leftLines, rightLines);
}

/** Alias for diffChars — intraline character-level diff. */
export const intralineDiff = diffChars;

/**
 * Histogram diff on string arrays — returns DiffLine[].
 * @param {string[]} leftLines
 * @param {string[]} rightLines
 * @param {WeightOptions} [opts]
 * @returns {DiffLine[]}
 */
export function histogramDiff(leftLines, rightLines, opts) {
  const ops = maybeWeight(_histogramDiff(leftLines, rightLines), leftLines, rightLines, opts);
  return opsToLines(ops, leftLines, rightLines);
}
