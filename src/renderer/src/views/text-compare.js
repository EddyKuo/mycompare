/**
 * @file text-compare.js
 * @description Dual-pane text comparison view for MyCompare.
 *
 * Responsibilities:
 *  - Render left/right panes with diff-highlighted lines
 *  - Character-level intraline highlighting for replace lines
 *  - Collapsing of long equal regions (context lines)
 *  - Synchronised scrolling between panes
 *  - Draggable splitter (grid-template-columns)
 *  - CSS-based minimap with viewport indicator
 *  - Optional syntax highlighting via highlight.js
 *  - Keyboard-navigable diff block navigation
 *  - Copy-to-left / copy-to-right per diff block
 *  - Event system: 'diff-count', 'ready', 'paths-changed'
 */

import {
  diffLines, diffChars, normaliseAlignmentMode, splitAlignedPairs,
} from '../core/diff-engine.js';
import { showContextMenu } from '../core/context-menu.js';
import { SettingsStore, keyComboMatches } from '../core/settings-store.js';
import { renderTextTable, reportHeader, reportSummary } from '../core/report.js';
import { detectEol } from '../core/eol-detect.js';
import { isActive } from '../core/active-view.js';
import { stepDiffIndex, navResult, getNavOptions } from '../core/diff-nav.js';
import { tagConfig, readConfig } from '../core/named-config-store.js';
import { toast } from '../core/toast.js';
import {
  getGrammarForPath, tokenizeLines, maskLine, linesEqualIgnoringElements,
  lineWeight, elementsOf, getUserGrammars, setUserGrammars, isRiskyRegexSource,
  listGrammars, compileGrammar,
} from '../core/grammar.js';

/** @typedef {import('../core/diff-nav.js').NavResult} NavResult */

// ---------------------------------------------------------------------------
// Virtual scroll constants
// ---------------------------------------------------------------------------

/** Fixed row height in px — must match CSS line-height (1.5 × 13px ≈ 20px) */
/**
 * Below this, a detected encoding is shown as a guess rather than a fact.
 *
 * chardet reports a confidence out of 100 and will answer for a sample far too
 * short to be sure — a few lines of Big5 or Shift-JIS is genuinely ambiguous.
 * The wrong answer is not an error at decode time: the file opens as 亂碼 with
 * nothing reported as wrong. Marking the label is what sends the user to the
 * manual override instead of to a bug report.
 */
const LOW_CONFIDENCE = 60;

const VS_ROW_HEIGHT = 20;

/**
 * The identifier surrounding an offset in a string.
 *
 * Word characters are letters, digits, underscore and the CJK ranges — a
 * search seeded from source code should pick up `foo_bar` and `使用者名稱`
 * whole rather than stopping at the first underscore or at an ASCII boundary.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {string}
 */
export function wordAt(text, offset) {
  if (typeof text !== 'string' || !text) return '';
  // The same class `wordBoundsAt` uses: Unicode letters and numbers plus
  // _ and $, so an identifier is taken whole in any script rather than
  // stopping at the first non-ASCII character.
  const isWord = (ch) => /[\p{L}\p{N}_$]/u.test(ch);
  let i = Math.max(0, Math.min(offset, text.length));
  // An offset just past the end of a word still belongs to it: the caret sits
  // after the last character when you finish typing a name.
  if (i > 0 && (i >= text.length || !isWord(text[i])) && isWord(text[i - 1])) i -= 1;
  if (i >= text.length || !isWord(text[i])) return '';
  let start = i;
  while (start > 0 && isWord(text[start - 1])) start -= 1;
  let end = i;
  while (end < text.length && isWord(text[end])) end += 1;
  return text.slice(start, end);
}

/**
 * What Find should be pre-filled with.
 *
 * A non-empty selection wins; otherwise the word under the caret. A selection
 * spanning lines is ignored — it is a range, not a search term.
 *
 * @returns {string}
 */
export function selectedTextOrWordAtCaret() {
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (!sel || sel.rangeCount === 0) return '';
  const text = String(sel.toString() ?? '');
  if (text && !text.includes('\n')) return text.trim();
  if (text) return '';
  const node = sel.anchorNode;
  if (!node || node.nodeType !== 3) return '';
  return wordAt(String(node.textContent ?? ''), sel.anchorOffset);
}

/** Rows to render above/below viewport to avoid scroll flicker */
const VS_OVERSCAN = 5;

/**
 * Virtual path schemes the filesystem actions cannot act on.
 *
 * `snapshot://`, `remote://` and `patch://` name things with no file behind
 * them, and the path validator refuses all of them — so offering Explorer or
 * Open With for one would be a menu entry that can only produce an error.
 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Hard ceiling on thumbnail bands.
 *
 * Sampling per line is what makes a single changed line in a 50k-line file
 * visible at all, but one node per line is the "hundred thousand DOM nodes"
 * mistake this project has already made once. Bands are therefore capped at
 * the strip's own pixel height and again at this constant, so the node count
 * is bounded by the display and not by the file.
 */
const MINIMAP_MAX_BANDS = 1000;

/**
 * @typedef {object} MinimapBand
 * @property {number} start first band index covered
 * @property {number} end   last band index covered (inclusive)
 * @property {'insert'|'delete'|'replace'} type
 */

/**
 * Display Font choices (BC View | Display Font). Monospace only — the diff
 * panes, the ruler and the gutter all assume a fixed advance width.
 * @type {Array<{ label: string, value: string }>}
 */
export const FONT_CHOICES = [
  { label: '預設', value: '' },
  { label: 'Consolas', value: "Consolas, 'Courier New', monospace" },
  { label: 'Cascadia Code', value: "'Cascadia Code', Consolas, monospace" },
  { label: 'Fira Code', value: "'Fira Code', Consolas, monospace" },
  { label: 'Courier New', value: "'Courier New', monospace" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono', Consolas, monospace" },
];

// ---------------------------------------------------------------------------
// File watching
// ---------------------------------------------------------------------------

/**
 * Whether a path names something `fs.watch` could actually open.
 *
 * A pane can now hold an archive entry, a snapshot entry or a remote file.
 * Those paths are rejected by the main process's path validator, so watching
 * them would raise an unhandled rejection on every open for no benefit —
 * there is no local file whose changes could be observed.
 *
 * @param {string|null|undefined} path
 * @returns {boolean}
 */
function _isWatchablePath(path) {
  if (!path) return false;
  return !path.startsWith('snapshot://') &&
    !path.startsWith('remote://') &&
    !path.startsWith('patch://') &&
    !path.includes('::');
}

/** @param {string|null|undefined} path */
function _watch(path) {
  if (_isWatchablePath(path)) window.electronAPI?.watchFile(path);
}

/** @param {string|null|undefined} path */
function _unwatch(path) {
  if (_isWatchablePath(path)) window.electronAPI?.unwatchFile(path);
}

// ---------------------------------------------------------------------------
// highlight.js language registry (lazy, keyed by extension)
// ---------------------------------------------------------------------------

/** @type {import('highlight.js').HLJSApi | null} */
let _hljs = null;

/** Map from file extension → hljs language id */
const EXT_LANG_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  c: 'c', h: 'c',
  go: 'go',
  rs: 'rust',
  html: 'html', htm: 'html',
  css: 'css',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml',
  sql: 'sql',
  md: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
};

/**
 * Lazy-load highlight.js core + the required language module.
 * @param {string} ext  Lowercase file extension (no dot)
 * @returns {Promise<{ hljs: import('highlight.js').HLJSApi, langId: string } | null>}
 */
async function loadHighlighter(ext) {
  const langId = EXT_LANG_MAP[ext];
  if (!langId) return null;

  try {
    if (!_hljs) {
      const mod = await import('highlight.js/lib/core');
      _hljs = mod.default;
    }

    // Each language module needs to be registered once.
    if (!_hljs.getLanguage(langId)) {
      const langMod = await import(/* @vite-ignore */ `highlight.js/lib/languages/${langId}`);
      _hljs.registerLanguage(langId, langMod.default);
    }

    return { hljs: _hljs, langId };
  } catch {
    return null;
  }
}

/**
 * Highlight a plain-text string. Returns an HTML string, or the original
 * text (escaped) if highlighting is unavailable.
 * @param {string} text
 * @param {{ hljs: import('highlight.js').HLJSApi, langId: string } | null} hl
 * @returns {string}  HTML-safe string
 */
function highlightText(text, hl) {
  if (!hl) return escapeHtml(text);
  try {
    return hl.hljs.highlight(text, { language: hl.langId, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

// ---------------------------------------------------------------------------
// DOM / string helpers
// ---------------------------------------------------------------------------

/**
 * T47: Replace invisible whitespace characters with visible symbols.
 * Space → · (U+00B7), Tab → → (U+2192), trailing newline → ↵ (U+21B5)
 * @param {string} str  Plain (un-escaped) display text (trailing newline already stripped)
 * @returns {string}  Text with whitespace symbols injected
 */
export function applyVisibleWhitespace(str) {
  // Replace tabs first (before spaces, since tabs are longer)
  return str
    .replace(/\t/g, '→')     // Tab → →
    .replace(/ /g, '·');      // Space → ·
}

/**
 * Escape HTML special characters in a plain string.
 * @param {string} str
 * @returns {string}
 */
/**
 * S13-C02: replace a single line (identified by 0-based index) inside the
 * source text. Lines are delimited by `\n` and the newline is kept on the
 * preceding token (matching diff-engine.splitLines semantics).
 *
 * @param {string} text
 * @param {number} lineIdx 0-based line index
 * @param {string} newLine replacement line, *including* its trailing newline
 *   if the original had one
 * @returns {string}
 */
function _spliceLine(text, lineIdx, newLine) {
  if (typeof lineIdx !== 'number' || lineIdx < 0) return text;
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  if (lineIdx >= lines.length) return text;
  lines[lineIdx] = newLine;
  return lines.join('');
}

/**
 * Human-readable byte count for the File Info panel.
 * @param {number} n
 * @returns {string}
 */
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the inner HTML for a diff-line's `.line-text` span, applying
 * character-level highlighting for replace lines.
 *
 * For equal/insert/delete we use syntax-highlighted HTML (if available).
 * For replace we insert char-diff spans wrapping the syntax-highlighted
 * output; since the intraline diff operates on raw text while syntax
 * highlighting produces HTML, we apply char-diff spans to the *raw* text
 * and skip syntax highlighting on replace lines to avoid broken HTML.
 *
 * @param {string} rawText  The raw (un-escaped) line text
 * @param {'equal'|'insert'|'delete'|'replace'} type
 * @param {'left'|'right'} side  Only relevant for replace
 * @param {import('../core/diff-engine.js').CharDiff[] | null} charDiffs
 * @param {{ hljs: import('highlight.js').HLJSApi, langId: string } | null} hl
 * @param {boolean} [showWhitespace]  T47: replace spaces/tabs with visible symbols
 * @returns {string}  innerHTML for .line-text
 */
function buildLineHTML(rawText, type, side, charDiffs, hl, showWhitespace = false) {
  // Strip trailing newline for display
  let displayText = rawText.replace(/\r?\n$/, '');
  if (showWhitespace) displayText = applyVisibleWhitespace(displayText);

  if (type === 'replace' && charDiffs) {
    // Build char-diff HTML from raw text (foreground layer)
    let charHtml = '';
    for (const cd of charDiffs) {
      const escaped = escapeHtml(cd.text);
      if (cd.type === 'equal') {
        charHtml += escaped;
      } else if (cd.type === 'delete' && side === 'left') {
        charHtml += `<span class="char-delete">${escaped}</span>`;
      } else if (cd.type === 'insert' && side === 'right') {
        charHtml += `<span class="char-insert">${escaped}</span>`;
      } else if (cd.type === 'delete' && side === 'right') {
        // skip deletions on the right pane
      } else if (cd.type === 'insert' && side === 'left') {
        // skip insertions on the left pane
      }
    }

    // T29: Two-layer rendering — syntax highlight as background, char-diff as foreground
    if (hl) {
      const syntaxHtml = highlightText(displayText, hl);
      return `<span class="char-layer">${charHtml}</span><span class="syntax-layer" aria-hidden="true">${syntaxHtml}</span>`;
    }
    return charHtml;
  }

  return highlightText(displayText, hl);
}

// ---------------------------------------------------------------------------
// Unified diff parsing moved to core/patch.js once the standalone Text Patch
// view began reading patches too. Re-exported here so every existing import
// site — including the tests that pin the format handling — keeps working.
// ---------------------------------------------------------------------------
export { UnifiedDiffParseError, parseUnifiedDiff, buildPatchSides } from '../core/patch.js';
import { parseUnifiedDiff, buildPatchSides, UnifiedDiffParseError } from '../core/patch.js';

// ---------------------------------------------------------------------------
// 1.4 / 1.5 — primitives behind the Edit and Search command sets
//
// Every one of these is DOM-free and takes "old text in, new text out". The
// panes are virtualised, so a command that patched the DOM would lose its
// effect the moment the row scrolled out of view; expressing an edit as a
// transformation of the model is what makes it survive.
// ---------------------------------------------------------------------------

/**
 * Split text into lines that each carry their own terminator.
 *
 * Deliberately mirrors diff-engine's private splitLines so that index N here
 * is the same line as `leftLine === N + 1` in a DiffLine.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitLinesKeepEol(text) {
  if (typeof text !== 'string' || text === '') return [];
  /** @type {string[]} */
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * Split one line into its body and its terminator.
 * @param {string} line
 * @returns {{ body: string, eol: string }}
 */
export function splitEol(line) {
  const m = /\r\n$|[\r\n]$/.exec(line ?? '');
  const eol = m ? m[0] : '';
  return { body: eol ? line.slice(0, line.length - eol.length) : (line ?? ''), eol };
}

/**
 * Insert a blank line before or after `lineIdx`.
 *
 * @param {string} text
 * @param {number} lineIdx 0-based
 * @param {'before'|'after'} position
 * @param {string} [eol]
 * @returns {string}
 */
export function insertBlankLine(text, lineIdx, position, eol = '\n') {
  const lines = splitLinesKeepEol(text);
  if (lines.length === 0) return eol;
  const i = Math.min(Math.max(lineIdx, 0), lines.length - 1);
  const at = position === 'before' ? i : i + 1;
  if (at >= lines.length) {
    // A file whose last line has no terminator cannot hold a line after it;
    // give the old last line one so the new blank line is representable.
    const last = lines.length - 1;
    if (!/\n$/.test(lines[last])) lines[last] += eol;
    lines.push(eol);
  } else {
    lines.splice(at, 0, eol);
  }
  return lines.join('');
}

/**
 * Remove one whole line.
 * @param {string} text
 * @param {number} lineIdx 0-based
 * @returns {string}
 */
export function removeLine(text, lineIdx) {
  const lines = splitLinesKeepEol(text);
  if (lineIdx < 0 || lineIdx >= lines.length) return text;
  lines.splice(lineIdx, 1);
  return lines.join('');
}

/**
 * Replace one line's body, keeping whatever terminator it had.
 * @param {string} text
 * @param {number} lineIdx 0-based
 * @param {string} newBody body without a terminator
 * @returns {string}
 */
export function replaceLineBody(text, lineIdx, newBody) {
  const lines = splitLinesKeepEol(text);
  if (lineIdx < 0 || lineIdx >= lines.length) return text;
  lines[lineIdx] = newBody + splitEol(lines[lineIdx]).eol;
  return lines.join('');
}

/**
 * Bounds of the word Ctrl+Delete would swallow, starting at `col`:
 * any run of whitespace, then the run of word- or of punctuation-characters
 * that follows it.
 *
 * @param {string} body line body, no terminator
 * @param {number} col 0-based caret column
 * @returns {{ start: number, end: number }} `start === end` when there is
 *   nothing to delete
 */
export function wordBoundsAt(body, col) {
  const n = body.length;
  const start = Math.min(Math.max(col | 0, 0), n);
  let i = start;
  const isSpace = (ch) => /\s/.test(ch);
  const isWord = (ch) => /[\p{L}\p{N}_$]/u.test(ch);
  while (i < n && isSpace(body[i])) i++;
  if (i < n) {
    const wordish = isWord(body[i]);
    while (i < n && !isSpace(body[i]) && isWord(body[i]) === wordish) i++;
  }
  return { start, end: i };
}

/**
 * Add or remove one indent step on a range of lines.
 *
 * Blank lines are left alone when indenting, which is what every editor and
 * BC itself do — indenting nothing produces trailing whitespace.
 *
 * @param {string} text
 * @param {number} startLine 0-based, inclusive
 * @param {number} endLine   0-based, inclusive
 * @param {1|-1} delta
 * @param {number} [tabWidth]
 * @param {boolean} [useTabs] insert a tab rather than `tabWidth` spaces
 * @returns {string}
 */
export function indentLines(text, startLine, endLine, delta, tabWidth = 4, useTabs = false) {
  if (delta !== 1 && delta !== -1) return text;
  const lines = splitLinesKeepEol(text);
  if (lines.length === 0) return text;
  const width = Number.isInteger(tabWidth) && tabWidth > 0 ? tabWidth : 4;
  const unit = useTabs ? '\t' : ' '.repeat(width);
  const lo = Math.max(0, startLine);
  const hi = Math.min(lines.length - 1, endLine);
  for (let i = lo; i <= hi; i++) {
    const { body, eol } = splitEol(lines[i]);
    let next = body;
    if (delta > 0) {
      if (body.length === 0) continue;
      next = unit + body;
    } else if (body.startsWith('\t')) {
      next = body.slice(1);
    } else {
      let k = 0;
      while (k < width && body[k] === ' ') k++;
      next = body.slice(k);
    }
    lines[i] = next + eol;
  }
  return lines.join('');
}

/**
 * @typedef {{ left: number, right: number }} AlignAnchor
 *   1-based line numbers the user pinned to each other.
 */

/**
 * True when two anchors cannot both hold: they name the same line on one side,
 * or they cross (left order and right order disagree).
 *
 * @param {AlignAnchor} a
 * @param {AlignAnchor} b
 * @returns {boolean}
 */
export function anchorsConflict(a, b) {
  const dl = a.left - b.left;
  const dr = a.right - b.right;
  if (dl === 0 || dr === 0) return true;
  return (dl > 0) !== (dr > 0);
}

/**
 * Drop anchors that are out of range or that cross an earlier one, and sort
 * what remains. Callers that need to know an anchor was rejected should
 * compare lengths — this function never throws, so a stale saved session
 * cannot break the view.
 *
 * @param {unknown} anchors
 * @param {number} leftCount total lines on the left
 * @param {number} rightCount total lines on the right
 * @returns {AlignAnchor[]}
 */
export function normaliseAnchors(anchors, leftCount, rightCount) {
  /** @type {AlignAnchor[]} */
  const clean = [];
  for (const a of Array.isArray(anchors) ? anchors : []) {
    const left = Number(a?.left);
    const right = Number(a?.right);
    if (!Number.isInteger(left) || !Number.isInteger(right)) continue;
    if (left < 1 || right < 1 || left > leftCount || right > rightCount) continue;
    clean.push({ left, right });
  }
  clean.sort((x, y) => x.left - y.left || x.right - y.right);
  /** @type {AlignAnchor[]} */
  const out = [];
  for (const a of clean) {
    const prev = out[out.length - 1];
    if (prev && anchorsConflict(a, prev)) continue;
    out.push(a);
  }
  return out;
}

/**
 * Cut both files into the independent regions the anchors define.
 * Ranges are 0-based, `*End` exclusive; `kind: 'anchor'` segments are the
 * pinned line pairs themselves.
 *
 * @param {number} leftCount
 * @param {number} rightCount
 * @param {AlignAnchor[]} anchors already normalised
 * @returns {Array<{ kind: 'diff'|'anchor', leftStart: number, leftEnd: number,
 *   rightStart: number, rightEnd: number }>}
 */
export function splitByAnchors(leftCount, rightCount, anchors) {
  const segs = [];
  let l = 0;
  let r = 0;
  for (const a of anchors) {
    segs.push({ kind: 'diff', leftStart: l, leftEnd: a.left - 1, rightStart: r, rightEnd: a.right - 1 });
    segs.push({ kind: 'anchor', leftStart: a.left - 1, leftEnd: a.left, rightStart: a.right - 1, rightEnd: a.right });
    l = a.left;
    r = a.right;
  }
  segs.push({ kind: 'diff', leftStart: l, leftEnd: leftCount, rightStart: r, rightEnd: rightCount });
  return segs.filter(s => s.kind === 'anchor' || s.leftEnd > s.leftStart || s.rightEnd > s.rightStart);
}

/**
 * Shift the line numbers of a sub-diff back into whole-file coordinates.
 * @param {import('../core/diff-engine.js').DiffLine[]} dls
 * @param {number} leftOffset
 * @param {number} rightOffset
 * @returns {import('../core/diff-engine.js').DiffLine[]}
 */
export function offsetDiffLines(dls, leftOffset, rightOffset) {
  return dls.map(d => ({
    ...d,
    leftLine: d.leftLine == null ? null : d.leftLine + leftOffset,
    rightLine: d.rightLine == null ? null : d.rightLine + rightOffset,
  }));
}

/**
 * BC's "Align With": diff each anchor-delimited region on its own so the
 * pinned lines are guaranteed to end up on the same row, then stitch the
 * results back together.
 *
 * @param {string} leftText
 * @param {string} rightText
 * @param {AlignAnchor[]} anchors
 * @param {Record<string, unknown>} [opts] passed through to `diffFn`;
 *   `leftWeights`/`rightWeights` are sliced per region
 * @param {(l: string, r: string, o: Record<string, unknown>) =>
 *   import('../core/diff-engine.js').DiffLine[]} [diffFn]
 * @returns {import('../core/diff-engine.js').DiffLine[]}
 */
export function diffWithAnchors(leftText, rightText, anchors, opts = {}, diffFn = diffLines) {
  const L = splitLinesKeepEol(leftText);
  const R = splitLinesKeepEol(rightText);
  const list = normaliseAnchors(anchors, L.length, R.length);
  if (list.length === 0) return diffFn(leftText, rightText, opts);

  /** @type {import('../core/diff-engine.js').DiffLine[]} */
  const out = [];
  for (const seg of splitByAnchors(L.length, R.length, list)) {
    if (seg.kind === 'anchor') {
      const leftLineText = L[seg.leftStart] ?? '';
      const rightLineText = R[seg.rightStart] ?? '';
      out.push({
        type: leftLineText === rightLineText ? 'equal' : 'replace',
        leftLine: seg.leftStart + 1,
        rightLine: seg.rightStart + 1,
        leftText: leftLineText,
        rightText: rightLineText,
        alignAnchor: true,
      });
      continue;
    }
    const subOpts = { ...opts };
    if (Array.isArray(opts.leftWeights)) subOpts.leftWeights = opts.leftWeights.slice(seg.leftStart, seg.leftEnd);
    if (Array.isArray(opts.rightWeights)) subOpts.rightWeights = opts.rightWeights.slice(seg.rightStart, seg.rightEnd);
    const sub = diffFn(
      L.slice(seg.leftStart, seg.leftEnd).join(''),
      R.slice(seg.rightStart, seg.rightEnd).join(''),
      subOpts,
    );
    out.push(...offsetDiffLines(sub, seg.leftStart, seg.rightStart));
  }
  return out;
}

/**
 * BC's "Isolate": pull one line range out of each side so only those lines
 * are compared.
 *
 * @param {string} leftText
 * @param {string} rightText
 * @param {{ start: number, end: number }|null} leftRange 1-based, inclusive
 * @param {{ start: number, end: number }|null} rightRange 1-based, inclusive
 * @returns {{ left: string, right: string }}
 */
export function isolateRanges(leftText, rightText, leftRange, rightRange) {
  /**
   * @param {string} text
   * @param {{ start: number, end: number }|null} range
   * @returns {string}
   */
  const take = (text, range) => {
    if (!range) return '';
    const lines = splitLinesKeepEol(text);
    const a = Math.max(1, Math.trunc(range.start));
    const b = Math.min(lines.length, Math.trunc(range.end));
    if (b < a) return '';
    return lines.slice(a - 1, b).join('');
  };
  return { left: take(leftText, leftRange), right: take(rightText, rightRange) };
}

/**
 * Collapse a character-level diff into the individual changed runs a user
 * would call "one difference inside this line". A delete immediately followed
 * by an insert is a single replacement, not two.
 *
 * @param {import('../core/diff-engine.js').CharDiff[]} charDiffs
 * @returns {Array<{ leftStart: number, leftEnd: number, rightStart: number, rightEnd: number }>}
 */
export function inlineSegments(charDiffs) {
  const segs = [];
  let l = 0;
  let r = 0;
  for (const cd of Array.isArray(charDiffs) ? charDiffs : []) {
    const n = (cd?.text ?? '').length;
    if (!cd || cd.type === 'equal') { l += n; r += n; continue; }
    const prev = segs[segs.length - 1];
    const adjacent = prev && prev.leftEnd === l && prev.rightEnd === r;
    if (cd.type === 'delete') {
      if (adjacent) prev.leftEnd = l + n;
      else segs.push({ leftStart: l, leftEnd: l + n, rightStart: r, rightEnd: r });
      l += n;
    } else {
      if (adjacent) prev.rightEnd = r + n;
      else segs.push({ leftStart: l, leftEnd: l, rightStart: r, rightEnd: r + n });
      r += n;
    }
  }
  return segs;
}

/**
 * Move recorded edit positions after lines were inserted or removed, so
 * "Next Edit" still points at the text the user actually touched.
 *
 * @param {number[]} marks 1-based line numbers
 * @param {number} atLine 1-based line the change started at
 * @param {number} delta lines added (positive) or removed (negative)
 * @returns {number[]} sorted, de-duplicated
 */
export function rebaseEditMarks(marks, atLine, delta) {
  /** @type {number[]} */
  const out = [];
  for (const m of Array.isArray(marks) ? marks : []) {
    if (!Number.isInteger(m) || m < 1) continue;
    if (delta < 0 && m >= atLine && m < atLine - delta) continue; // sat on a removed line
    out.push(m >= atLine ? m + delta : m);
  }
  return [...new Set(out)].filter(n => n >= 1).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/**
 * Create a single `.diff-line` element.
 *
 * @param {{
 *   cssClass: string,
 *   lineNum: number | null,
 *   innerHtml: string,
 *   dataLeft?: number | null,
 *   dataRight?: number | null,
 * }} opts
 * @returns {HTMLDivElement}
 */
function createLineEl({ cssClass, lineNum, innerHtml, dataLeft, dataRight }) {
  const div = document.createElement('div');
  div.className = `diff-line${cssClass ? ' ' + cssClass : ''}`;
  if (dataLeft != null) div.dataset.leftLine = String(dataLeft);
  if (dataRight != null) div.dataset.rightLine = String(dataRight);

  const numSpan = document.createElement('span');
  numSpan.className = 'line-num';
  numSpan.textContent = lineNum != null ? String(lineNum) : '';

  const gutterSpan = document.createElement('span');
  gutterSpan.className = 'line-gutter';

  const textSpan = document.createElement('span');
  textSpan.className = 'line-text';
  textSpan.innerHTML = innerHtml;

  div.appendChild(numSpan);
  div.appendChild(gutterSpan);
  div.appendChild(textSpan);

  return div;
}

/**
 * Create a collapsed-section placeholder element.
 * @param {number} start  First line index in the equal block (0-based row index)
 * @param {number} end    Last line index in the equal block (inclusive, 0-based)
 * @param {number} count  Number of lines collapsed
 * @returns {HTMLDivElement}
 */
function createCollapsedEl(start, end, count, expanded = false) {
  const div = document.createElement('div');
  div.className = expanded ? 'diff-line collapsed collapsed--expanded' : 'diff-line collapsed';
  div.dataset.expandStart = String(start);
  div.dataset.expandEnd = String(end);
  div.dataset.expanded = expanded ? 'true' : 'false';
  div.textContent = expanded
    ? `── ${count} 行相同（點擊收合）──`
    : `── ${count} 行相同（點擊展開）──`;
  return div;
}

/** Shared settings reader — saves consult it for the backup preference. */
const _settings = new SettingsStore();

// ---------------------------------------------------------------------------
// 1.9 Options ▸ Editor — save-time text clean-ups
//
// Both rewrite the user's file, so both default to false: someone who never
// opens the Options dialog must get byte-identical saves.
// ---------------------------------------------------------------------------

/**
 * Strip trailing spaces and tabs from every line, leaving the line
 * terminators untouched.
 *
 * Matching before the terminator rather than splitting on '\n' is what keeps
 * CRLF files correct: after a split on '\n' every line still ends with '\r',
 * so a `/[ \t]+$/` anchor never fires and a CRLF file comes back untrimmed.
 *
 * @param {string} text
 * @returns {string}
 */
export function trimTrailingWhitespace(text) {
  if (!text) return text;
  return text.replace(/[ \t]+(?=\r\n|\r|\n|$)/g, '');
}

/**
 * Guarantee the text ends with a line terminator, in the file's own style.
 *
 * Appends only when one is missing. Trailing blank lines are content the user
 * typed, not formatting — collapsing "a\n\n\n" down to "a\n" would delete
 * lines on save, which is not what "ensure a final newline" asks for. An
 * empty file stays empty: a zero-byte file has no last line to terminate,
 * and writing one byte into it would be a change the user never made.
 *
 * @param {string} text
 * @param {'CRLF'|'LF'|'CR'} [eol] detected line ending of the file
 * @returns {string}
 */
export function ensureFinalNewline(text, eol = 'LF') {
  if (!text) return text;
  if (/(?:\r\n|\r|\n)$/.test(text)) return text;
  return text + (eol === 'CRLF' ? '\r\n' : eol === 'CR' ? '\r' : '\n');
}

// ---------------------------------------------------------------------------
// 1.4 / 1.7 — Text Replacements
//
// BC's match→replacement pairs: both sides are rewritten before they are
// compared, so text that is equivalent but written differently lines up as
// equal. The rewrite is for comparison only — every pane still shows, edits
// and saves the original bytes.
// ---------------------------------------------------------------------------

/**
 * Open-dialog filters for the formats `main/archive.js` decodes.
 *
 * Duplicated from folder-compare rather than imported: pulling that module in
 * would drag the entire folder view and its stylesheet into every text-only
 * bundle path for the sake of one array of strings.
 */
const ARCHIVE_DIALOG_FILTERS = [
  {
    name: '封存檔',
    extensions: ['zip', 'jar', 'war', 'ear', '7z', 'tar', 'tgz', 'tbz', 'tbz2', 'txz', 'gz', 'bz2', 'xz'],
  },
  { name: '所有檔案', extensions: ['*'] },
];

/** Most rules one session may hold. */
export const MAX_REPLACEMENT_RULES = 50;

/** Longest line a replacement is attempted on, and the cap on the result. */
export const MAX_REPLACEMENT_LINE = 10000;

/**
 * @typedef {{
 *   match: string,
 *   replacement: string,
 *   regex: boolean,
 *   caseSensitive: boolean,
 * }} ReplacementRule
 */

/** @param {string} s */
function _escapeLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse the rules a user typed, one per line.
 *
 * Format: `match => replacement`, optionally prefixed with `re:` (regex),
 * `i:` (case-insensitive) or `rei:` (both). Lines starting with `#` and blank
 * lines are comments.
 *
 * Rejected lines are reported rather than skipped: a rule that silently does
 * nothing is worse than no rule, because the user believes it is running.
 *
 * @param {string} text
 * @returns {{ rules: ReplacementRule[], errors: string[] }}
 */
export function parseReplacementRules(text) {
  /** @type {ReplacementRule[]} */
  const rules = [];
  /** @type {string[]} */
  const errors = [];
  const lines = String(text ?? '').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;

    if (rules.length >= MAX_REPLACEMENT_RULES) {
      errors.push(`第 ${i + 1} 行：規則數超過上限 ${MAX_REPLACEMENT_RULES}，其後略過`);
      break;
    }

    const prefixed = /^(rei|ir|re|i)\s*:\s*(.*)$/i.exec(line);
    const flags = prefixed ? prefixed[1].toLowerCase() : '';
    const rest = prefixed ? prefixed[2] : line;

    // The first ` => ` wins, so a bare `=>` inside the pattern needs no
    // escaping as long as it is not surrounded by spaces.
    let cut = rest.indexOf(' => ');
    let sepLen = 4;
    if (cut < 0) { cut = rest.indexOf('=>'); sepLen = 2; }
    if (cut < 0) {
      errors.push(`第 ${i + 1} 行：缺少 " => " 分隔符`);
      continue;
    }

    const match = rest.slice(0, cut).trim();
    const replacement = rest.slice(cut + sepLen).trim();
    if (match === '') {
      errors.push(`第 ${i + 1} 行：比對字串不可為空`);
      continue;
    }

    rules.push({
      match,
      replacement,
      regex: flags.includes('re'),
      caseSensitive: !flags.includes('i'),
    });
  }

  return { rules, errors };
}

/**
 * Render rules back into the editable text form.
 * @param {ReplacementRule[]} rules
 * @returns {string}
 */
export function formatReplacementRules(rules) {
  return (Array.isArray(rules) ? rules : []).map((r) => {
    const flags = `${r.regex ? 're' : ''}${r.caseSensitive ? '' : 'i'}`;
    return `${flags ? `${flags}: ` : ''}${r.match} => ${r.replacement}`;
  }).join('\n');
}

/**
 * Compile rules into runnable regexes.
 *
 * A user-supplied pattern is screened for catastrophic backtracking before it
 * is ever executed — the same screen `core/grammar.js` applies to its own
 * user-supplied regexes. A rejected rule is reported and dropped; it never
 * runs in a degraded form.
 *
 * @param {ReplacementRule[]} rules
 * @returns {{ compiled: Array<{ re: RegExp, replacement: string }>, errors: string[] }}
 */
export function compileReplacementRules(rules) {
  /** @type {Array<{ re: RegExp, replacement: string }>} */
  const compiled = [];
  /** @type {string[]} */
  const errors = [];

  for (const rule of Array.isArray(rules) ? rules : []) {
    const match = String(rule?.match ?? '');
    const replacement = String(rule?.replacement ?? '');
    if (match === '') continue;
    // A rule that changes the line count would break every line number the
    // diff, the caret and the manual-ignore marks are expressed in.
    if (/[\r\n]/.test(match) || /[\r\n]/.test(replacement)) {
      errors.push(`規則「${match}」含有換行字元，不支援`);
      continue;
    }

    const source = rule?.regex ? match : _escapeLiteral(match);
    if (rule?.regex) {
      const risk = isRiskyRegexSource(source);
      if (risk) {
        errors.push(`規則「${match}」被拒絕：${risk}`);
        continue;
      }
    }
    try {
      compiled.push({
        re: new RegExp(source, rule?.caseSensitive === false ? 'gi' : 'g'),
        replacement,
      });
    } catch (err) {
      errors.push(`規則「${match}」無效：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { compiled, errors };
}

/**
 * Rewrite text for comparison.
 *
 * Applied per line, keeping each line's own terminator, so the result has
 * exactly the same number of lines as the input — which is what lets the
 * original text be put back afterwards by line number.
 *
 * @param {string} text
 * @param {Array<{ re: RegExp, replacement: string }>} compiled
 * @returns {string}
 */
export function applyReplacements(text, compiled) {
  const src = String(text ?? '');
  if (!Array.isArray(compiled) || compiled.length === 0) return src;

  return splitLinesKeepEol(src).map((line) => {
    const { body, eol } = splitEol(line);
    if (body.length > MAX_REPLACEMENT_LINE) return line;
    let out = body;
    for (const { re, replacement } of compiled) {
      re.lastIndex = 0;
      out = out.replace(re, replacement);
      // A rule can grow a line; capping stops a chain of them from turning one
      // line into something the renderer has to lay out.
      if (out.length > MAX_REPLACEMENT_LINE) { out = out.slice(0, MAX_REPLACEMENT_LINE); break; }
    }
    return out + eol;
  }).join('');
}

/**
 * Put the on-disk text back onto a diff computed over rewritten content.
 *
 * The types stay as computed — that is the whole point, equivalent lines came
 * back `equal` — while every pane, every export and every edit goes on seeing
 * what the file actually contains.
 *
 * @param {import('../core/diff-engine.js').DiffLine[]} diff mutated in place
 * @param {string[]} leftLines  original lines, EOL kept
 * @param {string[]} rightLines original lines, EOL kept
 * @returns {import('../core/diff-engine.js').DiffLine[]} the same array
 */
export function restoreOriginalDiffText(diff, leftLines, rightLines) {
  for (const dl of diff ?? []) {
    if (dl.leftLine != null && leftLines[dl.leftLine - 1] != null) {
      dl.leftText = leftLines[dl.leftLine - 1];
    }
    if (dl.rightLine != null && rightLines[dl.rightLine - 1] != null) {
      dl.rightText = rightLines[dl.rightLine - 1];
    }
  }
  return diff;
}

// ---------------------------------------------------------------------------
// P2-53 — whitespace comparison modes
// ---------------------------------------------------------------------------

/**
 * BC splits whitespace handling into four mutually exclusive choices rather
 * than one checkbox. Two of them (`all`, `trailing`) have no equivalent in the
 * diff engine's `normalise`, so they are expressed here as a comparison-only
 * rewrite and undone afterwards by `restoreOriginalDiffText` — the same route
 * the replacement rules already take.
 *
 * @typedef {'none'|'all'|'leading'|'trailing'|'amount'} WhitespaceMode
 */

/** Modes the diff engine cannot express, so they need a rewrite pass. */
const REWRITE_WS_MODES = new Set(['all', 'trailing']);

/**
 * Rewrite text for comparison under a whitespace mode.
 *
 * Line count is preserved (each line keeps its own terminator) so the original
 * text can be restored by line number afterwards.
 *
 * @param {string} text
 * @param {WhitespaceMode} mode
 * @returns {string}
 */
export function applyWhitespaceMode(text, mode) {
  const src = String(text ?? '');
  if (!REWRITE_WS_MODES.has(mode)) return src;
  return splitLinesKeepEol(src).map((line) => {
    const { body, eol } = splitEol(line);
    const out = mode === 'all'
      ? body.replace(/[ \t]+/g, '')
      : body.replace(/[ \t]+$/, '');
    return out + eol;
  }).join('');
}

// ---------------------------------------------------------------------------
// P2-59 / P2-60 — alignment options
// ---------------------------------------------------------------------------

/**
 * Runs longer than this are left alone: the pairing below is O(n·m) in the run
 * length, and a thousand-line block of pure insertions has no useful pairing
 * to find anyway.
 */
const MAX_REALIGN_RUN = 300;

/**
 * Dice coefficient over character bigrams — 1 for identical, 0 for nothing in
 * common. Cheap enough to run on every candidate pair inside a run.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function lineSimilarity(a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (x === y) return 1;
  if (x.length === 0 || y.length === 0) return 0;
  if (x.length === 1 || y.length === 1) return x === y ? 1 : 0;
  /** @type {Map<string, number>} */
  const bag = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    bag.set(g, (bag.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = bag.get(g) ?? 0;
    if (n > 0) { bag.set(g, n - 1); hits++; }
  }
  return (2 * hits) / (x.length - 1 + y.length - 1);
}

/**
 * @typedef {{
 *   neverAlign?: RegExp[],
 *   skewTolerance?: number,
 *   useCloseness?: boolean,
 *   closenessThreshold?: number,
 * }} AlignmentOptions
 */

/**
 * Whether any alignment option is actually in effect.
 *
 * Used to skip the pass entirely when it is off, so the default diff output —
 * and every test written against it — is bit-identical to before.
 *
 * @param {AlignmentOptions} opts
 * @returns {boolean}
 */
export function alignmentOptionsActive(opts) {
  return (opts?.neverAlign?.length ?? 0) > 0
    || (Number(opts?.skewTolerance) || 0) > 0
    || opts?.useCloseness === true;
}

/**
 * Re-pair the lines inside each run of differences.
 *
 * The diff engine pairs a deletion with an insertion purely by position within
 * the run. BC lets the user override that with three controls, all applied
 * here because the engine takes no such options:
 *
 *  - never-align patterns: a matching line is emitted as an orphan, never as
 *    half of a `replace` row;
 *  - skew tolerance: refuses a pairing whose two lines sit more than N apart
 *    within the run, which is what stops a stray match dragging the alignment;
 *  - closeness matching: pairs by similarity rather than by position, so a
 *    moved-and-edited line lands opposite its counterpart.
 *
 * @param {import('../core/diff-engine.js').DiffLine[]} diff
 * @param {AlignmentOptions} opts
 * @returns {import('../core/diff-engine.js').DiffLine[]} a new array
 */
export function applyAlignmentOptions(diff, opts = {}) {
  const list = Array.isArray(diff) ? diff : [];
  if (!alignmentOptionsActive(opts)) return list;

  const neverAlign = opts.neverAlign ?? [];
  const skew = Number(opts.skewTolerance) || 0;
  const useCloseness = opts.useCloseness === true;
  const threshold = Number.isFinite(opts.closenessThreshold)
    ? Math.max(0, Math.min(1, Number(opts.closenessThreshold))) : 0.5;

  /** @param {string} text */
  const excluded = (text) => neverAlign.some((re) => { re.lastIndex = 0; return re.test(text ?? ''); });

  /** @type {import('../core/diff-engine.js').DiffLine[]} */
  const out = [];
  let i = 0;
  while (i < list.length) {
    if (list[i].type === 'equal') { out.push(list[i]); i++; continue; }
    let j = i;
    while (j < list.length && list[j].type !== 'equal') j++;
    out.push(...realignRun(list.slice(i, j), { excluded, skew, useCloseness, threshold }));
    i = j;
  }
  return out;
}

/**
 * Re-pair one maximal run of non-equal DiffLines.
 *
 * @param {import('../core/diff-engine.js').DiffLine[]} run
 * @param {{ excluded: (text: string) => boolean, skew: number,
 *           useCloseness: boolean, threshold: number }} cfg
 * @returns {import('../core/diff-engine.js').DiffLine[]}
 */
function realignRun(run, cfg) {
  /** @type {Array<{ line: number, text: string, src: import('../core/diff-engine.js').DiffLine }>} */
  const lefts = [];
  /** @type {Array<{ line: number, text: string, src: import('../core/diff-engine.js').DiffLine }>} */
  const rights = [];
  for (const dl of run) {
    if (dl.leftLine != null) lefts.push({ line: dl.leftLine, text: dl.leftText ?? '', src: dl });
    if (dl.rightLine != null) rights.push({ line: dl.rightLine, text: dl.rightText ?? '', src: dl });
  }
  if (lefts.length === 0 || rights.length === 0) return run;
  if (lefts.length > MAX_REALIGN_RUN || rights.length > MAX_REALIGN_RUN) return run;

  /**
   * Whether l[a] may be paired with r[b] at all.
   * @param {number} a @param {number} b
   */
  const allowed = (a, b) => {
    if (cfg.excluded(lefts[a].text) || cfg.excluded(rights[b].text)) return false;
    if (cfg.skew > 0 && Math.abs(a - b) > cfg.skew) return false;
    return true;
  };

  /**
   * Pair score. Without closeness matching every allowed pair scores the same,
   * which reproduces the engine's positional pairing minus the exclusions.
   * @param {number} a @param {number} b
   */
  const score = (a, b) => {
    if (!allowed(a, b)) return -1;
    if (!cfg.useCloseness) return 1;
    const s = lineSimilarity(lefts[a].text, rights[b].text);
    return s >= cfg.threshold ? s : -1;
  };

  // Order-preserving maximum-weight matching: the same recurrence as LCS, with
  // similarity in place of equality. Order must hold or the panes would show
  // lines out of file order.
  const n = lefts.length, m = rights.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let a = n - 1; a >= 0; a--) {
    for (let b = m - 1; b >= 0; b--) {
      const s = score(a, b);
      const pair = s < 0 ? -Infinity : s + dp[a + 1][b + 1];
      dp[a][b] = Math.max(pair, dp[a + 1][b], dp[a][b + 1]);
    }
  }

  /** @type {import('../core/diff-engine.js').DiffLine[]} */
  const out = [];
  let a = 0, b = 0;
  while (a < n && b < m) {
    const s = score(a, b);
    const pair = s < 0 ? -Infinity : s + dp[a + 1][b + 1];
    if (pair === dp[a][b]) {
      out.push({ type: 'replace', leftLine: lefts[a].line, rightLine: rights[b].line,
        leftText: lefts[a].text, rightText: rights[b].text });
      a++; b++;
    } else if (dp[a + 1][b] >= dp[a][b + 1]) {
      out.push({ type: 'delete', leftLine: lefts[a].line, rightLine: null,
        leftText: lefts[a].text, rightText: '' });
      a++;
    } else {
      out.push({ type: 'insert', leftLine: null, rightLine: rights[b].line,
        leftText: '', rightText: rights[b].text });
      b++;
    }
  }
  for (; a < n; a++) {
    out.push({ type: 'delete', leftLine: lefts[a].line, rightLine: null,
      leftText: lefts[a].text, rightText: '' });
  }
  for (; b < m; b++) {
    out.push({ type: 'insert', leftLine: null, rightLine: rights[b].line,
      leftText: '', rightText: rights[b].text });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1.9 Global Text options — editor behaviour (pure)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ text: string, caret: number }} EditResult
 */

/**
 * Offsets of the line containing `caret`, both ends exclusive of the newline.
 * @param {string} text
 * @param {number} caret
 * @returns {{ start: number, end: number }}
 */
export function lineBoundsAt(text, caret) {
  const pos = Math.max(0, Math.min(text.length, Math.trunc(caret) || 0));
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const nl = text.indexOf('\n', pos);
  return { start, end: nl === -1 ? text.length : nl };
}

/**
 * Visual column of `prefix`, expanding tabs to the next multiple of `tabWidth`.
 * @param {string} prefix
 * @param {number} tabWidth
 * @returns {number}
 */
export function visualColumn(prefix, tabWidth) {
  const w = Number.isInteger(tabWidth) && tabWidth > 0 ? tabWidth : 4;
  let col = 0;
  for (const ch of prefix) col = ch === '\t' ? (Math.floor(col / w) + 1) * w : col + 1;
  return col;
}

/**
 * Auto indent: Enter carries the current line's leading whitespace to the new
 * line. Only the whitespace *before* the caret is copied, so splitting a line
 * in the middle of its indentation does not invent indentation that was not
 * yet typed.
 *
 * @param {string} text
 * @param {number} caret
 * @returns {EditResult}
 */
export function computeAutoIndent(text, caret) {
  const pos = Math.max(0, Math.min(text.length, Math.trunc(caret) || 0));
  const { start } = lineBoundsAt(text, pos);
  const indent = (/^[ \t]*/.exec(text.slice(start, pos)) ?? [''])[0];
  const insert = '\n' + indent;
  return { text: text.slice(0, pos) + insert + text.slice(pos), caret: pos + insert.length };
}

/**
 * Backspace unindents: inside a line's leading whitespace, Backspace falls back
 * to the previous tab stop instead of eating one character.
 *
 * Returns null when the rule does not apply, which is the signal to let the
 * browser handle the key normally rather than guessing at a replacement.
 *
 * @param {string} text
 * @param {number} caret
 * @param {number} tabWidth
 * @returns {EditResult|null}
 */
export function computeBackspaceUnindent(text, caret, tabWidth) {
  const pos = Math.max(0, Math.min(text.length, Math.trunc(caret) || 0));
  const { start } = lineBoundsAt(text, pos);
  if (pos <= start) return null;
  const prefix = text.slice(start, pos);
  if (!/^[ \t]+$/.test(prefix)) return null;

  const w = Number.isInteger(tabWidth) && tabWidth > 0 ? tabWidth : 4;
  const col = visualColumn(prefix, w);
  const target = col % w === 0 ? col - w : Math.floor(col / w) * w;

  let cut = pos;
  while (cut > start && visualColumn(text.slice(start, cut), w) > target) cut--;
  if (cut === pos) return null;
  return { text: text.slice(0, cut) + text.slice(pos), caret: cut };
}

/**
 * Allow positioning beyond end of line.
 *
 * A <textarea> has no virtual space, so the caret cannot simply sit past the
 * last character. What it can do is what BC's setting amounts to the instant
 * the user types there: extend the line. Right-arrow at end of line therefore
 * appends one space and stays put instead of wrapping to the next line.
 *
 * @param {string} text
 * @param {number} caret
 * @returns {EditResult|null} null when the caret is not at end of line
 */
export function computeBeyondEolPad(text, caret) {
  const pos = Math.max(0, Math.min(text.length, Math.trunc(caret) || 0));
  const { end } = lineBoundsAt(text, pos);
  if (pos !== end) return null;
  return { text: text.slice(0, pos) + ' ' + text.slice(pos), caret: pos + 1 };
}

// ---------------------------------------------------------------------------
// 1.9 / navigation — which arrows have anywhere to go (pure)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ first: boolean, prev: boolean, next: boolean, last: boolean }} NavAvailability
 */

/**
 * Which of the four difference-navigation commands can still move.
 *
 * With wrap-around on every command can always move as long as there is more
 * than one difference to move between — dimming them there would be wrong.
 *
 * @param {number} index 0-based current difference, -1 when none is selected
 * @param {number} total
 * @param {boolean} wrap
 * @returns {NavAvailability}
 */
export function navAvailability(index, total, wrap) {
  const n = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  if (n === 0) return { first: false, prev: false, next: false, last: false };
  const i = Number.isFinite(index) ? Math.trunc(index) : -1;
  if (wrap) {
    const movable = n > 1;
    return { first: i !== 0, prev: movable, next: movable, last: i !== n - 1 };
  }
  return {
    first: i !== 0,
    prev: i > 0,
    next: i < n - 1,
    last: i !== n - 1,
  };
}

// ---------------------------------------------------------------------------
// TextCompare class
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   algorithm?: 'myers' | 'patience',
 *   ignoreWhitespace?: boolean,
 *   ignoreCase?: boolean,
 *   ignoreLineEndings?: boolean,
 *   contextLines?: number,
 *   alignByGrammar?: boolean,
 *   alignMode?: import('../core/diff-engine.js').AlignmentMode,
 *   autoIndent?: boolean,
 *   backspaceUnindents?: boolean,
 *   allowBeyondEol?: boolean,
 *   showFilteredLineCounts?: boolean,
 * }} TextCompareOptions
 */

/**
 * Combined size of both sides above which grammar line weights are skipped.
 * See `_weightAlignEligible`.
 */
const MAX_WEIGHT_ALIGN_CHARS = 1_000_000;

/**
 * @typedef {{
 *   type: 'equal' | 'insert' | 'delete' | 'replace',
 *   startRow: number,
 *   endRow: number,
 * }} DiffBlock
 */

export class TextCompare {
  /**
   * @param {TextCompareOptions} options
   */
  constructor(options = {}) {
    /** Aborted on destroy() to drop every listener registered via _on(). */
    this._ac = new AbortController();

    /**
     * Folded runs the user has expanded, keyed "start:end" over _diffResult
     * indices. Cleared whenever the diff is recomputed, since the indices
     * would no longer refer to the same lines.
     * @type {Set<string>}
     */
    this._expandedRuns = new Set();

    /** @type {Required<TextCompareOptions>} */
    this._opts = {
      algorithm: options.algorithm ?? 'myers',
      ignoreWhitespace: options.ignoreWhitespace ?? false,
      ignoreCase: options.ignoreCase ?? false,
      ignoreLineEndings: options.ignoreLineEndings ?? false,
      ignoreIndent: options.ignoreIndent ?? false,
      ignoreCrlf: options.ignoreCrlf ?? false,
      contextLines: options.contextLines ?? 6,
      ignorePatterns: options.ignorePatterns ?? [],
      unimportantPatterns: options.unimportantPatterns ?? [],
      ignoreUnimportant: options.ignoreUnimportant ?? false,
      alignByGrammar: options.alignByGrammar ?? true,
      // P2-54: BC treats a line that exists on one side only as a difference
      // no ignore rule may downgrade, because "the file gained a line" is not
      // a cosmetic change however the line reads.
      orphansAlwaysImportant: options.orphansAlwaysImportant ?? false,
      // P2-59 / P2-60
      neverAlignPatterns: options.neverAlignPatterns ?? [],
      skewTolerance: options.skewTolerance ?? 0,
      useClosenessMatching: options.useClosenessMatching ?? false,
      closenessThreshold: options.closenessThreshold ?? 0.5,
      // 1.7 Alignment: 'standard' is what every existing session and test
      // assumes, so it stays the default.
      alignMode: normaliseAlignmentMode(options.alignMode),
    };

    /**
     * 1.9 Global Text options. All three default off, which is the behaviour
     * the edit-mode textarea had before they existed.
     * @type {{ autoIndent: boolean, backspaceUnindents: boolean, allowBeyondEol: boolean }}
     */
    this._editorOpts = {
      autoIndent: options.autoIndent === true,
      backspaceUnindents: options.backspaceUnindents === true,
      allowBeyondEol: options.allowBeyondEol === true,
    };

    /**
     * 1.9 Show filtered line counts. Defaults on because the status bar has
     * always reported the hidden count; the switch is what is new.
     * @type {boolean}
     */
    this._showFilteredLineCounts = options.showFilteredLineCounts !== false;

    /** P2-53: whitespace mode, derived from / synced with the legacy flags. */
    this._whitespaceMode = /** @type {WhitespaceMode} */ (
      REWRITE_WS_MODES.has(options.whitespaceMode) ? options.whitespaceMode : 'none');

    /** P2-52: BC has syntax highlighting as an explicit toggle, not only a
     *  consequence of the extension. @type {boolean} */
    this._syntaxHighlight = options.syntaxHighlight ?? true;

    /** P2-58: manual file-format override per side; right may be 'same-as-left'.
     *  @type {{ left: string|null, right: string|null }} */
    this._formatOverride = { left: null, right: null };

    /** Compiled never-align patterns, rebuilt whenever the list changes.
     *  @type {RegExp[]} */
    this._neverAlignCompiled = [];

    // Content state
    this._leftPath = '';
    this._rightPath = '';
    this._leftContent = '';
    this._rightContent = '';

    // EOL detection state (T01)
    this._eolLeft = 'LF';
    this._eolRight = 'LF';

    /** @type {import('../core/diff-engine.js').DiffLine[]} */
    this._diffResult = [];

    /**
     * Rendered row descriptors (one per DOM row in each pane).
     * Each entry describes one visual row shared by left & right panes.
     * @type {Array<{
     *   kind: 'line' | 'collapsed',
     *   diffLine?: import('../core/diff-engine.js').DiffLine,
     *   expandStart?: number,
     *   expandEnd?: number,
     *   collapsedCount?: number,
     * }>}
     */
    this._rows = [];

    /** @type {DiffBlock[]} */
    this._diffBlocks = [];

    /** Currently focused diff block index (-1 = none) */
    this._currentDiff = -1;

    // DOM references (set in mount())
    this._compareArea = null;
    this._contentLeft = null;
    this._contentRight = null;
    this._splitter = null;
    this._minimap = null;
    this._minimapViewport = null;
    this._pathLeft = null;
    this._pathRight = null;
    this._diffCounter = null;
    this._statusMessage = null;
    this._statusLines = null;
    this._statusEncoding = null;

    /**
     * Detected encoding per side, carried from the read so a save can write
     * the file back the way it was found.
     */
    this._encodingLeft = 'UTF-8';
    this._encodingRight = 'UTF-8';

    /**
     * Encoding the user picked by hand, per side. A reload honours it instead
     * of re-running detection, which would silently revert the override on a
     * file chardet guesses wrong.
     * @type {{ left: string|null, right: string|null }}
     */
    this._manualEncoding = { left: null, right: null };

    /**
     * Whether the difference thumbnail column is shown. Named to match
     * hex/table so the same menu command reaches all three.
     */
    this._showMinimap = options.showThumbnail ?? true;

    /** Bands last painted into the thumbnail, exposed for tests. @type {MinimapBand[]} */
    this._minimapBands = [];

    // Virtual scroll state
    this._totalRows = 0;
    this._maxLineChars = 0;
    this._vsDebounceTimer = null;

    // Synchronised scroll flag
    this._syncLock = false;

    // Event listeners map
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();

    // Bound handlers (for cleanup)
    this._onScrollLeft = this._handleScrollLeft.bind(this);
    this._onScrollRight = this._handleScrollRight.bind(this);
    this._onMinimapClick = this._handleMinimapClick.bind(this);
    this._onContentClick = this._handleContentClick.bind(this);

    // highlight.js context (loaded once first file is opened)
    this._hlLeft = null;
    this._hlRight = null;

    // Edit mode state
    this._editMode = false;
    this._editTimerLeft = null;
    this._editTimerRight = null;
    this._textareaLeft = null;
    this._textareaRight = null;
    this._modified = { left: false, right: false };

    // Find bar state (T03)
    this._findQuery = '';
    this._findCaseSensitive = false;
    this._findRegex = false;  // T38: regex mode
    /** @type {HTMLElement[]} */
    this._findMatches = [];
    this._findCurrentIdx = -1;
    this._findBar = null;
    this._findInput = null;
    this._findCount = null;

    // Go-to-line state (T16)
    this._gotoBar = null;
    this._gotoInput = null;

    // Word wrap state (T13)
    this._wordWrap = false;

    // Find & Replace state (T42)
    this._replaceQuery = '';
    this._replaceMode = false;
    this._replaceInput = null;

    // Bookmarks state (T43)
    /** @type {Set<number>} — row indices */
    this._bookmarks = new Set();
    this._lastClickedRow = null;

    // T46: Show filter — controls which rows are visible
    /** @type {'all' | 'diff' | 'same' | 'none'} */
    this._showFilter = 'all';

    // T47: Visible whitespace toggle
    this._showWhitespace = false;

    // T48: Line numbers toggle (default on)
    this._showLineNumbers = true;

    // T49: Font size (px), clamped to [10, 24]
    this._fontSize = 13;

    // S13-C03: row height kept in sync with font-size so virtual scroll math
    // doesn't desync when the user zooms in.
    this._rowHeight = VS_ROW_HEIGHT;

    // S13-C08: handle returned by electronAPI.onFileChanged(); must be called
    // to remove the listener in destroy(). Symbol load tokens guard against
    // stale-promise races when the user switches files mid-read.
    /** @type {(() => void) | null} */
    this._unsubFileChanged = null;
    this._loadTokenLeft = null;
    this._loadTokenRight = null;

    // S13-C05: compiled-regex cache for ignore patterns. Cleared whenever
    // setIgnorePatterns() runs. Keys = pattern source string.
    /** @type {Map<string, RegExp | null>} */
    this._ignoreRegexCache = new Map();
    /** @type {Map<string, RegExp | null>} */
    this._unimportantRegexCache = new Map();

    // P2-30: manually ignored lines, keyed by 1-based file line number per
    // side. Line numbers (rather than row indices) are used so the marks
    // survive a re-diff, a Show-filter change and a fold/unfold.
    /** @type {{ left: Set<number>, right: Set<number> }} */
    this._manualIgnore = { left: new Set(), right: new Set() };

    // T50: Layout mode toggle
    /** @type {'side-by-side' | 'over-under'} */
    this._layoutMode = 'side-by-side';
    /** BC's View > Webpages: render the two sides instead of showing source. */
    this._webpageMode = false;
    /** @type {{left: string|null, right: string|null}} blob URLs in use */
    this._webpageUrls = { left: null, right: null };

    // T64: Undo/Redo stack for copy operations
    /** @type {Array<{ left: string, right: string }>} */
    this._undoStack = [];
    /** @type {Array<{ left: string, right: string }>} */
    this._redoStack = [];
    this._undoCap = 50;

    // ── P2-29: Grammar ──
    // Tokens are indexed by 0-based file line, so a row can look up its own
    // line without re-tokenizing. They are only computed when something needs
    // them (an ignored element, or the Alignment Details panel).
    /** @type {import('../core/grammar.js').CompiledGrammar|null} */
    this._grammarLeft = null;
    /** @type {import('../core/grammar.js').CompiledGrammar|null} */
    this._grammarRight = null;
    /** @type {import('../core/grammar.js').GrammarToken[][]} */
    this._tokensLeft = [];
    /** @type {import('../core/grammar.js').GrammarToken[][]} */
    this._tokensRight = [];
    /** Element names whose differences are demoted to "unimportant". @type {Set<string>} */
    this._grammarIgnored = new Set();
    /** True when a step/length bound stopped the tokenizer short. */
    this._grammarTruncated = false;
    /** Guards the truncation toast so a re-diff per keystroke cannot spam it. */
    this._grammarTruncationReported = false;

    // ── P3: Details panel / Ruler / File Info / Description ──
    /** @type {'text'|'hex'|'alignment'|null} */
    this._detailsMode = null;
    this._detailsEl = null;
    this._detailsBody = null;
    this._showRuler = false;
    this._rulerEl = null;
    this._showFileInfo = false;
    this._infoEl = null;
    this._showDescription = false;
    this._descriptionEl = null;
    this._description = '';
    this._topStrip = null;
    /** Row the Details panels describe; -1 until the user clicks or navigates. */
    this._currentRowIdx = -1;
    /** @type {'left'|'right'} */
    this._currentSide = 'left';

    // T-P3: Display font family ('' = inherit the stylesheet default)
    this._fontFamily = '';

    // 1.7 "Prevent editing" — per side, not one global switch.
    this._readOnly = { left: false, right: false };

    // ── 1.4 / 1.5: Edit & navigation command set ──
    // The caret is stored as a file line number per side, never as a row index
    // or a DOM node: rows are virtualised and _rows is rebuilt on every
    // re-diff, so anything else would evaporate as soon as the user scrolled.
    /** @type {{ left: number|null, right: number|null }} */
    this._caret = { left: null, right: null };
    /** 0-based column within the caret line, from the last click. */
    this._caretCol = 0;

    /** Indent step used by Increase/Decrease Indent and by Convert File. */
    this._tabWidth = 4;
    this._indentWithTabs = false;

    /** @type {AlignAnchor[]} manual Align With pins, 1-based line numbers */
    this._alignAnchors = [];
    /** First half of an Align With pair, waiting for the other side. @type {{side:'left'|'right', line:number}|null} */
    this._pendingAlign = null;

    /** Lines this session's edit commands touched, for Next/Previous Edit. */
    /** @type {{ left: number[], right: number[] }} */
    this._editMarks = { left: [], right: [] };

    /** Position of the in-line difference cursor. @type {{ diffIndex: number, segIndex: number }|null} */
    this._inlineCursor = null;

    /** Saved panes from before Isolate, so it can be undone. @type {Array<object>} */
    this._isolateStack = [];

    /** 1.7 Replacements: match→replacement pairs applied before comparing. */
    /** @type {ReplacementRule[]} */
    this._replacements = [];
    /** Compiled form of `_replacements`; empty means the feature is inert. */
    /** @type {Array<{ re: RegExp, replacement: string }>} */
    this._replacementsCompiled = [];

    this._mounted = false;
  }

  /**
   * T64: Push current content state to the undo stack before a mutation.
   * Clears the redo stack (a new mutation invalidates redo history).
   * Cap stack at this._undoCap (default 50) by dropping oldest entries.
   */
  _pushUndoSnapshot() {
    this._undoStack.push({ left: this._leftContent, right: this._rightContent });
    if (this._undoStack.length > this._undoCap) {
      this._undoStack.splice(0, this._undoStack.length - this._undoCap);
    }
    this._redoStack.length = 0;
  }

  /**
   * T64: Undo the most recent copy/mutation. Returns true if an undo was applied.
   * @returns {boolean}
   */
  undo() {
    if (this._undoStack.length === 0) return false;
    const snap = this._undoStack.pop();
    this._redoStack.push({ left: this._leftContent, right: this._rightContent });
    this._leftContent = snap.left;
    this._rightContent = snap.right;
    this._syncEditTextareas();
    this._runDiff();
    return true;
  }

  /**
   * P2-49: an undo taken while the edit overlays are visible has to be
   * reflected in them, or the next keystroke would re-commit the old text.
   */
  _syncEditTextareas() {
    if (!this._editMode) return;
    if (this._textareaLeft) this._textareaLeft.value = this._leftContent;
    if (this._textareaRight) this._textareaRight.value = this._rightContent;
  }

  /**
   * T64: Redo the most recently undone mutation. Returns true if applied.
   * @returns {boolean}
   */
  redo() {
    if (this._redoStack.length === 0) return false;
    const snap = this._redoStack.pop();
    this._undoStack.push({ left: this._leftContent, right: this._rightContent });
    this._leftContent = snap.left;
    this._rightContent = snap.right;
    this._syncEditTextareas();
    this._runDiff();
    return true;
  }

  // -------------------------------------------------------------------------
  // Mount / destroy
  // -------------------------------------------------------------------------

  /** Attach to existing DOM elements and wire up event listeners. */
  /**
   * Register a listener bound to this view's lifetime.
   *
   * The panes, splitter and toolbar controls live in index.html, so they
   * outlive the view instance. Closing and reopening a text tab used to stack
   * a fresh set of anonymous listeners on the same nodes with no way to remove
   * them; destroy() now aborts them all in one go.
   *
   * Not for listeners with a shorter lifetime than the view (the splitter's
   * document-level mousemove/mouseup, for instance, must come off on mouseup).
   *
   * @param {EventTarget|null|undefined} target
   * @param {string} type
   * @param {EventListener} handler
   * @param {AddEventListenerOptions} [opts]
   */
  _on(target, type, handler, opts) {
    if (!target) return handler;
    target.addEventListener(type, handler, { ...(opts ?? {}), signal: this._ac.signal });
    return handler;
  }

  mount() {
    if (this._mounted) return;
    // A previous mount()/destroy() cycle leaves an aborted controller behind.
    if (!this._ac || this._ac.signal.aborted) this._ac = new AbortController();

    this._compareArea    = document.getElementById('compare-area');
    this._contentLeft    = document.getElementById('content-left');
    this._contentRight   = document.getElementById('content-right');
    this._splitter       = document.getElementById('splitter');
    this._gutterCanvas   = document.getElementById('tc-gutter-canvas');
    this._gutterOverlay  = document.getElementById('tc-gutter-overlay');
    this._minimap        = document.getElementById('minimap');
    this._minimapViewport = document.getElementById('minimap-viewport');
    this._pathLeft       = document.getElementById('path-left');
    this._pathRight      = document.getElementById('path-right');
    this._diffCounter    = document.getElementById('diff-counter');
    this._statusMessage  = document.getElementById('status-message');
    this._statusLines    = document.getElementById('status-lines');
    this._statusEncoding = document.getElementById('status-encoding');
    this._statusEol      = document.getElementById('status-eol');

    // Scroll sync
    this._on(this._contentLeft, 'scroll', this._onScrollLeft);
    this._on(this._contentRight, 'scroll', this._onScrollRight);

    // Minimap click-to-jump
    this._on(this._minimap, 'click', this._onMinimapClick);
    // A config applied before mount() only set the flag; the DOM has to catch up.
    this._compareArea?.classList.toggle('hide-minimap', !this._showMinimap);

    // Collapsed-section expand (event delegation)
    this._on(this._contentLeft, 'click', this._onContentClick);
    this._on(this._contentRight, 'click', this._onContentClick);

    // Context menu
    this._onContextMenuLeft  = (e) => this._handleContextMenu(e, 'left');
    this._onContextMenuRight = (e) => this._handleContextMenu(e, 'right');
    this._on(this._contentLeft, 'contextmenu',  this._onContextMenuLeft);
    this._on(this._contentRight, 'contextmenu', this._onContextMenuRight);

    // Build edit textarea overlays
    this._textareaLeft  = this._createEditTextarea('left');
    this._textareaRight = this._createEditTextarea('right');

    // ── T08: ignoreLineEndings / ignoreWhitespace / ignoreCase checkboxes ──
    const chkIgnoreLineEndings = document.getElementById('chk-ignore-line-endings');
    const chkIgnoreWhitespace  = document.getElementById('chk-ignore-whitespace');
    const chkIgnoreCase        = document.getElementById('chk-ignore-case');
    if (chkIgnoreLineEndings) {
      chkIgnoreLineEndings.checked = this._opts.ignoreLineEndings;
      this._on(chkIgnoreLineEndings, 'change', () => {
        this._opts.ignoreLineEndings = chkIgnoreLineEndings.checked;
        this._runDiff();
      });
    }
    if (chkIgnoreWhitespace) {
      chkIgnoreWhitespace.checked = this._opts.ignoreWhitespace;
      this._on(chkIgnoreWhitespace, 'change', () => {
        this._opts.ignoreWhitespace = chkIgnoreWhitespace.checked;
        this._runDiff();
      });
    }
    if (chkIgnoreCase) {
      chkIgnoreCase.checked = this._opts.ignoreCase;
      this._on(chkIgnoreCase, 'change', () => {
        this._opts.ignoreCase = chkIgnoreCase.checked;
        this._runDiff();
      });
    }

    // ── T68: ignoreIndent / ignoreCrlf checkboxes ──
    const chkIgnoreIndent = document.getElementById('chk-ignore-indent');
    const chkIgnoreCrlf   = document.getElementById('chk-ignore-crlf');
    if (chkIgnoreIndent) {
      chkIgnoreIndent.checked = this._opts.ignoreIndent;
      this._on(chkIgnoreIndent, 'change', () => {
        this._opts.ignoreIndent = chkIgnoreIndent.checked;
        this._runDiff();
      });
    }
    if (chkIgnoreCrlf) {
      chkIgnoreCrlf.checked = this._opts.ignoreCrlf;
      this._on(chkIgnoreCrlf, 'change', () => {
        this._opts.ignoreCrlf = chkIgnoreCrlf.checked;
        this._runDiff();
      });
    }

    // ── T03: Find bar setup ──
    this._findBar   = document.getElementById('find-bar');
    this._findInput = document.getElementById('find-input');
    this._findCount = document.getElementById('find-count');

    document.getElementById('find-close')?.addEventListener('click', () => this._closeFind());
    document.getElementById('find-next')?.addEventListener('click',  () => this._navigateFind(1));
    document.getElementById('find-prev')?.addEventListener('click',  () => this._navigateFind(-1));
    document.getElementById('find-case')?.addEventListener('change', (e) => {
      this._findCaseSensitive = /** @type {HTMLInputElement} */ (e.target).checked;
      this._runFind();
    });
    // T38: regex mode toggle
    document.getElementById('find-regex')?.addEventListener('change', (e) => {
      this._findRegex = /** @type {HTMLInputElement} */ (e.target).checked;
      this._runFind();
    });
    this._on(this._findInput, 'input', () => {
      this._findQuery = this._findInput.value;
      this._runFind();
    });
    this._on(this._findInput, 'keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); this._navigateFind(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); this._closeFind(); }
    });

    // Ctrl+F to open find bar (bound to document; guarded by this._mounted)
    this._onKeyDownFind = (e) => {
      if (e.key === 'f' && e.ctrlKey && !e.shiftKey && this._mounted && isActive('text')) {
        e.preventDefault();
        this._openFind();
      }
    };
    document.addEventListener('keydown', this._onKeyDownFind);

    // T42: Find & Replace bindings
    this._replaceInput = document.getElementById('replace-input');
    const btnReplaceOne = document.getElementById('replace-one');
    const btnReplaceAll = document.getElementById('replace-all');
    const btnToggleReplace = document.getElementById('toggle-replace');

    this._on(btnToggleReplace, 'click', () => this._toggleReplaceMode());
    this._on(btnReplaceOne, 'click', () => this._replaceOne());
    this._on(btnReplaceAll, 'click', () => this._replaceAll());

    this._onKeyDownReplace = (e) => {
      if (e.ctrlKey && e.key === 'h' && this._mounted && isActive('text')) {
        e.preventDefault();
        this._openFind(true);
      }
    };
    document.addEventListener('keydown', this._onKeyDownReplace);

    // T43: Bookmark shortcuts
    this._onKeyDownBookmark = (e) => {
      if (!this._mounted || !isActive('text')) return;
      this._handleBookmarkKey(e);
    };
    document.addEventListener('keydown', this._onKeyDownBookmark);

    // P1-19 / P2-30 / P2-25 shortcuts. These are deliberately not routed
    // through app.js's SettingsStore bindings — they are text-view-only and
    // need the live DOM selection, which only this view can resolve.
    this._onKeyDownTextGaps = (e) => {
      if (!this._mounted || !isActive('text')) return;
      this._handleTextGapKey(e);
    };
    document.addEventListener('keydown', this._onKeyDownTextGaps);

    // 1.4 / 1.5: the BC Edit and Search command set. Kept in this view rather
    // than in app.js's SettingsStore bindings because every one of them needs
    // the caret and the live DOM selection, which only this view resolves.
    this._onKeyDownEditCmds = (e) => {
      if (!this._mounted || !isActive('text')) return;
      // Never steal a key from the find/goto inputs or the edit-mode textarea.
      const tag = e.target instanceof Element ? e.target.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const cmd = this._matchEditCommand(e);
      if (!cmd) return;
      e.preventDefault();
      cmd();
    };
    document.addEventListener('keydown', this._onKeyDownEditCmds);

    // ── T16: Go-to-line bar setup ──
    this._gotoBar   = document.getElementById('goto-bar');
    this._gotoInput = document.getElementById('goto-input');

    document.getElementById('goto-close')?.addEventListener('click', () => this._closeGoto());
    document.getElementById('goto-go')?.addEventListener('click', () => this._gotoLine());
    this._on(this._gotoInput, 'keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); this._gotoLine(); }
      if (e.key === 'Escape') { e.preventDefault(); this._closeGoto(); }
    });

    // Ctrl+G to open goto-line bar (guarded by this._mounted)
    this._onKeyDownGoto = (e) => {
      if (e.key === 'g' && e.ctrlKey && !e.shiftKey && this._mounted && isActive('text')) {
        e.preventDefault();
        this._openGoto();
      }
    };
    document.addEventListener('keydown', this._onKeyDownGoto);

    // ── T13: Word Wrap checkbox ──
    const chkWordWrap = document.getElementById('chk-word-wrap');
    if (chkWordWrap) {
      chkWordWrap.checked = this._wordWrap;
      this._on(chkWordWrap, 'change', () => {
        this._wordWrap = chkWordWrap.checked;
        this._applyWordWrap();
      });
    }

    // ── T23: Paste buttons ──
    document.getElementById('btn-paste-left')?.addEventListener('click', async () => {
      const text = await navigator.clipboard.readText().catch(() => null);
      if (text != null) this.setLeft('（貼上）', text);
    });
    document.getElementById('btn-paste-right')?.addEventListener('click', async () => {
      const text = await navigator.clipboard.readText().catch(() => null);
      if (text != null) this.setRight('（貼上）', text);
    });

    // F5/F7/F8 are owned solely by app.js's SettingsStore binding, which routes
    // to whichever view is active. Binding them here as well made every F8
    // press advance two differences and every F5 re-diff twice.

    // ── T04: Drag-and-drop for text panes ──
    const paneLeft  = document.getElementById('pane-left');
    const paneRight = document.getElementById('pane-right');
    if (paneLeft) {
      this._on(paneLeft, 'dragenter', () => paneLeft.classList.add('tc-pane--drag-over'));
      this._on(paneLeft, 'dragleave', (e) => {
        // Only clear when leaving the pane (not bubbling from a child)
        if (!paneLeft.contains(/** @type {Node|null} */ (e.relatedTarget))) {
          paneLeft.classList.remove('tc-pane--drag-over');
        }
      });
      this._on(paneLeft, 'dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
      this._on(paneLeft, 'drop', async (e) => {
        e.preventDefault();
        paneLeft.classList.remove('tc-pane--drag-over');
        const file = e.dataTransfer.files[0];
        if (!file) return;
        try {
          // The path is resolved in preload from the dropped File itself, and
          // the drop is what authorises reading it — a dropped path is not an
          // allowed root until the main process is told about it.
          const [entry] = await window.electronAPI.acceptDroppedFiles?.([file]) ?? [];
          if (!entry) return;
          const filePath = entry.path;
          const result = await window.electronAPI.readFile(filePath);
          if (result) {
            this._hlLeft = await loadHighlighter(this._extFrom(result.path));
            this.setLeft(result.path, result.content, result.encoding);
          }
        } catch (err) { console.error('[text-compare] drop failed:', err); }
      });
    }
    if (paneRight) {
      this._on(paneRight, 'dragenter', () => paneRight.classList.add('tc-pane--drag-over'));
      this._on(paneRight, 'dragleave', (e) => {
        if (!paneRight.contains(/** @type {Node|null} */ (e.relatedTarget))) {
          paneRight.classList.remove('tc-pane--drag-over');
        }
      });
      this._on(paneRight, 'dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
      this._on(paneRight, 'drop', async (e) => {
        e.preventDefault();
        paneRight.classList.remove('tc-pane--drag-over');
        const file = e.dataTransfer.files[0];
        if (!file) return;
        try {
          const [entry] = await window.electronAPI.acceptDroppedFiles?.([file]) ?? [];
          if (!entry) return;
          const filePath = entry.path;
          const result = await window.electronAPI.readFile(filePath);
          if (result) {
            this._hlRight = await loadHighlighter(this._extFrom(result.path));
            this.setRight(result.path, result.content, result.encoding);
          }
        } catch (err) { console.error('[text-compare] drop failed:', err); }
      });
    }

    // ── T46: Show Filter toolbar buttons ──
    const btnShowAll  = document.getElementById('btn-show-all');
    const btnShowDiff = document.getElementById('btn-show-diff');
    const btnShowSame = document.getElementById('btn-show-same');
    const btnShowNone = document.getElementById('btn-show-none');
    if (btnShowAll)  this._on(btnShowAll, 'click',  () => this.setShowFilter('all'));
    if (btnShowDiff) this._on(btnShowDiff, 'click', () => this.setShowFilter('diff'));
    if (btnShowSame) this._on(btnShowSame, 'click', () => this.setShowFilter('same'));
    if (btnShowNone) this._on(btnShowNone, 'click', () => this.setShowFilter('none'));
    this._btnShowAll  = btnShowAll ?? null;
    this._btnShowDiff = btnShowDiff ?? null;
    this._btnShowSame = btnShowSame ?? null;
    this._btnShowNone = btnShowNone ?? null;
    this._syncShowFilterButtons();

    // ── T47: Visible Whitespace toggle ──
    const btnWhitespace = document.getElementById('btn-whitespace');
    if (btnWhitespace) {
      this._on(btnWhitespace, 'click', () => this.toggleWhitespace());
    }
    this._btnWhitespace = btnWhitespace ?? null;

    // ── T48: Line Numbers toggle ──
    const btnLineNums = document.getElementById('btn-line-numbers');
    if (btnLineNums) {
      this._on(btnLineNums, 'click', () => this.toggleLineNumbers());
    }
    this._btnLineNums = btnLineNums ?? null;
    this._applyLineNumbers();

    // ── T49: Font size keyboard shortcuts ──
    this._onKeyDownFontSize = (e) => {
      if (!this._mounted || !isActive('text')) return;
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        this.setFontSize(this._fontSize + 1);
      } else if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        this.setFontSize(this._fontSize - 1);
      } else if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        this.setFontSize(13);
      }
    };
    document.addEventListener('keydown', this._onKeyDownFontSize);
    this._applyFontSize();

    // ── T50: Layout toggle button ──
    const btnLayout = document.getElementById('btn-layout-toggle');
    this._btnWebpage = document.getElementById('btn-webpage-toggle');
    if (this._btnWebpage) {
      this._onWebpageToggle = () => this.toggleWebpageMode();
      this._btnWebpage.addEventListener('click', this._onWebpageToggle);
    }
    if (btnLayout) {
      this._on(btnLayout, 'click', () => this.toggleLayout());
    }
    this._btnLayout = btnLayout ?? null;

    // ── T69: Draggable splitter ──
    // Drag the centre splitter to resize left/right panes between 15%–85%.
    if (this._splitter && this._compareArea) {
      let dragging = false;
      let startX = 0;
      let startWidth = 0;
      const SPLITTER_PX = 24;
      const MIN_RATIO = 0.15;
      const MAX_RATIO = 0.85;

      const onMouseMove = (e) => {
        if (!dragging) return;
        const rect = this._compareArea.getBoundingClientRect();
        const minimapW = parseInt(
          getComputedStyle(this._compareArea).getPropertyValue('--minimap-width') || '60',
          10,
        ) || 60;
        const totalContent = rect.width - SPLITTER_PX - minimapW;
        if (totalContent <= 0) return;
        const newLeftPx = Math.max(
          totalContent * MIN_RATIO,
          Math.min(totalContent * MAX_RATIO, e.clientX - rect.left),
        );
        const rightPx = totalContent - newLeftPx;
        this._compareArea.style.gridTemplateColumns =
          `${newLeftPx}px ${SPLITTER_PX}px ${rightPx}px var(--minimap-width)`;
        // Avoid text selection while dragging
        e.preventDefault();
      };
      const onMouseUp = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      this._onSplitterMouseDown = (e) => {
        // Only respond to left-button drags on the splitter spine itself, not
        // its gutter overlay buttons.
        if (e.button !== 0) return;
        if (this._layoutMode === 'over-under') return;
        if (/** @type {HTMLElement} */ (e.target).closest('.tc-gutter-copy')) return;
        dragging = true;
        startX = e.clientX;
        startWidth = this._splitter.getBoundingClientRect().left;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
        // suppress unused-var lint
        void startX; void startWidth;
      };
      this._on(this._splitter, 'mousedown', this._onSplitterMouseDown);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      this._onSplitterMouseMove = onMouseMove;
      this._onSplitterMouseUp = onMouseUp;
    }

    // ── T33: File Watcher — auto-reload on external change ──
    // S13-C08: capture unsub handle; protect against stale reads with tokens.
    const unsub = window.electronAPI?.onFileChanged?.(({ path }) => {
      if (!this._mounted) return;
      if (path === this._leftPath) {
        const token = (this._loadTokenLeft = Symbol('reload-left'));
        window.electronAPI.readFile(path).then(result => {
          if (!result || this._loadTokenLeft !== token) return;
          this._leftContent = result.content;
          this._eolLeft = detectEol(result.content);
          this._runDiff();
          this._showFileChangedToast('left');
        }).catch(() => { /* ignore read errors */ });
      } else if (path === this._rightPath) {
        const token = (this._loadTokenRight = Symbol('reload-right'));
        window.electronAPI.readFile(path).then(result => {
          if (!result || this._loadTokenRight !== token) return;
          this._rightContent = result.content;
          this._eolRight = detectEol(result.content);
          this._runDiff();
          this._showFileChangedToast('right');
        }).catch(() => { /* ignore read errors */ });
      }
    });
    this._unsubFileChanged = typeof unsub === 'function' ? unsub : null;

    // P3: destroy() removes the ruler/info/description/details DOM but keeps
    // the user's choices, so a remount has to rebuild whatever was open.
    const wanted = {
      ruler: this._showRuler,
      info: this._showFileInfo,
      description: this._showDescription,
      details: this._detailsMode,
    };
    this._showRuler = false;
    this._showFileInfo = false;
    this._showDescription = false;
    this._detailsMode = null;
    if (wanted.ruler) this.toggleRuler(true);
    if (wanted.info) this.toggleFileInfo(true);
    if (wanted.description) this.toggleDescription(true);
    if (wanted.details) this.setDetailsMode(wanted.details);
    this.setFontFamily(this._fontFamily);

    this._mounted = true;
  }

  /** Remove all event listeners. */
  destroy() {
    if (!this._mounted) return;

    // Blob URLs outlive the element that used them, so a view opened and
    // closed repeatedly would pin every document it ever rendered.
    this._revokeWebpageUrls();
    if (this._btnWebpage && this._onWebpageToggle) {
      this._btnWebpage.removeEventListener('click', this._onWebpageToggle);
    }

    this._contentLeft?.removeEventListener('scroll', this._onScrollLeft);
    this._contentRight?.removeEventListener('scroll', this._onScrollRight);
    this._minimap?.removeEventListener('click', this._onMinimapClick);
    this._contentLeft?.removeEventListener('click', this._onContentClick);
    this._contentRight?.removeEventListener('click', this._onContentClick);
    this._contentLeft?.removeEventListener('contextmenu',  this._onContextMenuLeft);
    this._contentRight?.removeEventListener('contextmenu', this._onContextMenuRight);

    this._textareaLeft?.remove();
    this._textareaRight?.remove();
    clearTimeout(this._editTimerLeft);
    clearTimeout(this._editTimerRight);
    clearTimeout(this._vsDebounceTimer);

    // T03: cleanup find bar
    this._closeFind();
    if (this._onKeyDownFind) {
      document.removeEventListener('keydown', this._onKeyDownFind);
    }

    // T16: cleanup goto bar
    this._closeGoto();
    if (this._onKeyDownGoto) {
      document.removeEventListener('keydown', this._onKeyDownGoto);
    }

    // T42: cleanup replace shortcuts
    if (this._onKeyDownReplace) {
      document.removeEventListener('keydown', this._onKeyDownReplace);
    }

    // T43: cleanup bookmark shortcuts
    if (this._onKeyDownBookmark) {
      document.removeEventListener('keydown', this._onKeyDownBookmark);
    }

    // P1-19 / P2-25 / P2-30: cleanup selection & patch shortcuts
    if (this._onKeyDownTextGaps) {
      document.removeEventListener('keydown', this._onKeyDownTextGaps);
    }

    // 1.4 / 1.5: cleanup the edit & navigation command shortcuts
    if (this._onKeyDownEditCmds) {
      document.removeEventListener('keydown', this._onKeyDownEditCmds);
    }

    // T49: cleanup font size shortcuts
    if (this._onKeyDownFontSize) {
      document.removeEventListener('keydown', this._onKeyDownFontSize);
    }

    // T69: cleanup splitter drag
    if (this._onSplitterMouseMove) {
      document.removeEventListener('mousemove', this._onSplitterMouseMove);
      document.removeEventListener('mouseup', this._onSplitterMouseUp);
    }

    // T33: unwatch both files on destroy
    _unwatch(this._leftPath);
    _unwatch(this._rightPath);

    // S13-C08: remove the file-changed listener registered in mount().
    if (this._unsubFileChanged) {
      try { this._unsubFileChanged(); } catch { /* ignore */ }
      this._unsubFileChanged = null;
    }
    // Invalidate any in-flight reads.
    this._loadTokenLeft = null;
    this._loadTokenRight = null;

    // P3: the details/ruler/info strips are created in #view-text, which
    // outlives this instance — they must come out with it.
    this._detailsEl?.remove();
    this._detailsEl = null;
    this._detailsBody = null;
    this._rulerEl?.remove();
    this._rulerEl = null;
    this._infoEl?.remove();
    this._infoEl = null;
    this._descriptionEl?.remove();
    this._descriptionEl = null;
    this._topStrip?.remove();
    this._topStrip = null;

    // T39: cleanup center gutter
    if (this._gutterCanvas)  { this._gutterCanvas.width = 0; this._gutterCanvas = null; }
    if (this._gutterOverlay) { this._gutterOverlay.innerHTML = ''; this._gutterOverlay = null; }

    // Drop every listener registered through _on(). The panes, splitter and
    // toolbar buttons are static index.html nodes, so without this each
    // close/reopen cycle would leave another copy attached.
    this._ac.abort();

    this._mounted = false;
  }

  // -------------------------------------------------------------------------
  // Private: find bar (T03)
  // -------------------------------------------------------------------------

  /** @param {boolean} [replaceMode] — open in replace mode (T42) */
  _openFind(replaceMode = false) {
    if (!this._findBar) return;
    this._findBar.style.display = 'flex';
    if (replaceMode && !this._replaceMode) {
      this._toggleReplaceMode();
    }

    // Seed from the selection, or the word under the caret. Opening Find on a
    // symbol you are looking at and having to retype it is the common case,
    // and the previous query is still there when neither applies.
    const seed = selectedTextOrWordAtCaret();
    if (seed && this._findInput) {
      this._findInput.value = seed;
      this._findQuery = seed;
    }

    this._findInput?.focus();
    this._findInput?.select();
    this._runFind();
  }

  _closeFind() {
    if (!this._findBar) return;
    this._findBar.style.display = 'none';
    this._clearFindHighlights();
    /** @type {Array<{rowIndex: number}>} */
    this._findMatches = [];
    this._findCurrentIdx = -1;
    if (this._findCount) this._findCount.textContent = '';
  }

  _clearFindHighlights() {
    // Clear highlights from currently rendered rows in both panes
    const clearInPane = (pane) => {
      if (!pane) return;
      pane.querySelectorAll('.diff-line.find-match, .diff-line.find-match-active')
        .forEach(el => el.classList.remove('find-match', 'find-match-active'));
    };
    clearInPane(this._contentLeft);
    clearInPane(this._contentRight);
  }

  /**
   * Build find match list from _rows data (works regardless of which rows are
   * currently rendered into the DOM).
   *
   * @typedef {{ rowIndex: number }} FindMatch
   */
  _runFind() {
    this._clearFindHighlights();
    /** @type {FindMatch[]} */
    this._findMatches = [];
    this._findCurrentIdx = -1;

    const query = this._findQuery;
    if (!query) {
      if (this._findCount) this._findCount.textContent = '';
      if (this._findInput) this._findInput.classList.remove('find-no-match');
      return;
    }

    /** @type {(text: string) => boolean} */
    let compare;
    if (this._findRegex) {
      // T38: regex mode — compile once; fall back to string search on invalid pattern
      let re = null;
      try {
        const flags = this._findCaseSensitive ? '' : 'i';
        re = new RegExp(query, flags);
      } catch { /* invalid pattern — re stays null, fall through to string mode */ }
      if (re) {
        compare = (a) => re.test(a);
      } else {
        // Fallback: plain string search (regex was invalid)
        compare = this._findCaseSensitive
          ? (a) => a.includes(query)
          : (a) => a.toLowerCase().includes(query.toLowerCase());
      }
    } else {
      compare = this._findCaseSensitive
        ? (a) => a.includes(query)
        : (a) => a.toLowerCase().includes(query.toLowerCase());
    }

    // Search through _rows data (covers all rows, including non-rendered ones)
    for (let rowIdx = 0; rowIdx < this._rows.length; rowIdx++) {
      const row = this._rows[rowIdx];
      if (row.kind !== 'line') continue;
      const dl = row.diffLine;
      const leftText  = (dl.leftText  ?? '').replace(/\r?\n$/, '');
      const rightText = (dl.rightText ?? '').replace(/\r?\n$/, '');
      if (compare(leftText) || compare(rightText)) {
        this._findMatches.push({ rowIndex: rowIdx });
      }
    }

    if (this._findMatches.length > 0) {
      if (this._findInput) this._findInput.classList.remove('find-no-match');
      this._findCurrentIdx = 0;
      this._activateFindMatch(0);
    } else {
      if (this._findInput) this._findInput.classList.add('find-no-match');
    }

    if (this._findCount) {
      this._findCount.textContent = this._findMatches.length > 0
        ? `${this._findCurrentIdx + 1} / ${this._findMatches.length}`
        : '無結果';
    }
  }

  /**
   * @param {number} direction  +1 for next, -1 for prev
   */
  _navigateFind(direction) {
    if (this._findMatches.length === 0) return;
    this._findCurrentIdx = (this._findCurrentIdx + direction + this._findMatches.length) % this._findMatches.length;
    this._activateFindMatch(this._findCurrentIdx);
    if (this._findCount) {
      this._findCount.textContent = `${this._findCurrentIdx + 1} / ${this._findMatches.length}`;
    }
  }

  /**
   * Scroll to a find match by rowIndex and highlight it in the DOM.
   * @param {number} idx  Index into this._findMatches
   */
  _activateFindMatch(idx) {
    const match = this._findMatches[idx];
    if (!match) return;
    const rowIdx = match.rowIndex;

    if (this._contentLeft) {
      const viewportH = this._contentLeft.clientHeight || 600;
      const targetTop = rowIdx * this._rowHeight;
      const scrollTop = Math.max(0, targetTop - viewportH / 2);
      this._contentLeft.scrollTop  = scrollTop;
      this._contentRight.scrollTop = scrollTop;
      this._renderVisibleRows();
    }

    // Remove active class from all rendered match rows, then add to target
    this._clearFindHighlights();
    const applyHighlights = (pane) => {
      if (!pane) return;
      for (const m of this._findMatches) {
        const el = pane.querySelector(`[data-row-idx="${m.rowIndex}"]`);
        if (el) {
          el.classList.add('find-match');
          if (m === match) el.classList.add('find-match-active');
        }
      }
    };
    applyHighlights(this._contentLeft);
    applyHighlights(this._contentRight);
  }

  // -------------------------------------------------------------------------
  // Private: go-to-line bar (T16)
  // -------------------------------------------------------------------------

  _openGoto() {
    if (!this._gotoBar) return;
    this._gotoBar.style.display = 'flex';
    this._gotoInput?.focus();
    this._gotoInput?.select();
  }

  _closeGoto() {
    if (!this._gotoBar) return;
    this._gotoBar.style.display = 'none';
  }

  _gotoLine() {
    if (!this._gotoInput || !this._contentLeft) return;
    const lineNum = parseInt(this._gotoInput.value, 10);
    if (isNaN(lineNum) || lineNum < 1) return;

    // Find the first row whose left or right line number matches lineNum
    let rowIndex = -1;
    for (let i = 0; i < this._rows.length; i++) {
      const row = this._rows[i];
      if (row.kind !== 'line') continue;
      const dl = row.diffLine;
      if (dl.leftLine === lineNum || dl.rightLine === lineNum) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex < 0) return;

    const scrollTop = rowIndex * this._rowHeight;
    this._contentLeft.scrollTop  = scrollTop;
    this._contentRight.scrollTop = scrollTop;
    this._renderVisibleRows();
  }

  // -------------------------------------------------------------------------
  // Private: word wrap (T13)
  // -------------------------------------------------------------------------

  /**
   * Apply or remove word-wrap on both pane content elements.
   */
  _applyWordWrap() {
    const ws = this._wordWrap ? 'pre-wrap' : 'pre';
    if (this._contentLeft)  this._contentLeft.style.whiteSpace  = ws;
    if (this._contentRight) this._contentRight.style.whiteSpace = ws;
  }

  // -------------------------------------------------------------------------
  // Public: open file via Electron IPC
  // -------------------------------------------------------------------------

  async openLeft() {
    const result = await window.electronAPI.openFile();
    if (!result) return;
    this._hlLeft = await loadHighlighter(this._extFrom(result.path));
    this.setLeft(result.path, result.content, result.encoding);
  }

  async openRight() {
    const result = await window.electronAPI.openFile();
    if (!result) return;
    this._hlRight = await loadHighlighter(this._extFrom(result.path));
    this.setRight(result.path, result.content, result.encoding);
  }

  // -------------------------------------------------------------------------
  // Public: edit mode
  // -------------------------------------------------------------------------

  /**
   * Create a full-overlay textarea for a given side and append it to the pane.
   * @param {'left' | 'right'} side
   * @returns {HTMLTextAreaElement}
   */
  _createEditTextarea(side) {
    const ta = document.createElement('textarea');
    ta.className = 'edit-textarea';
    ta.style.display = 'none';
    ta.spellcheck = false;
    ta.autocomplete = 'off';
    ta.dataset.side = side;

    const pane = document.getElementById(side === 'left' ? 'pane-left' : 'pane-right');
    pane.style.position = 'relative';
    pane.appendChild(ta);

    this._on(ta, 'keydown', (e) => this._handleEditorKey(/** @type {KeyboardEvent} */ (e), ta, side));

    this._on(ta, 'input', () => {
      // A locked side keeps its textarea readOnly, but a paste through the
      // native menu can still land here; drop the change and say why.
      if (this.isSideReadOnly(side)) {
        ta.value = side === 'left' ? this._leftContent : this._rightContent;
        this._guardWrite(side);
        return;
      }
      const timerKey = side === 'left' ? '_editTimerLeft' : '_editTimerRight';
      // P2-49: typing has to enter the undo stack too, otherwise Ctrl+Z after
      // an edit jumps back past it to the last copy. One snapshot per burst —
      // per keystroke would fill the 50-entry cap with single characters.
      if (this[timerKey] == null) this._pushUndoSnapshot();
      clearTimeout(this[timerKey]);
      this[timerKey] = setTimeout(() => {
        if (side === 'left') {
          this._leftContent = ta.value;
          this._modified.left = true;
        } else {
          this._rightContent = ta.value;
          this._modified.right = true;
        }
        this[timerKey] = null;
        this._updateModifiedIndicator();
        this._runDiff();
      }, 300);
    });

    return ta;
  }

  /**
   * 1.9 Global Text options, applied to the edit-mode textarea.
   *
   * Each rule replaces the browser's default only when it actually applies;
   * otherwise the key falls through untouched, so nothing here can make normal
   * typing behave unexpectedly when the options are off.
   *
   * @param {KeyboardEvent} e
   * @param {HTMLTextAreaElement} ta
   * @param {'left'|'right'} side
   */
  _handleEditorKey(e, ta, side) {
    if (ta.readOnly || this.isSideReadOnly(side)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Every rule below rewrites a single caret position; with a selection the
    // native behaviour (replace the selection) is the right one.
    if (ta.selectionStart !== ta.selectionEnd) return;

    const caret = ta.selectionStart;
    /** @type {EditResult|null} */
    let out = null;
    if (e.key === 'Enter' && this._editorOpts.autoIndent && !e.shiftKey) {
      out = computeAutoIndent(ta.value, caret);
    } else if (e.key === 'Backspace' && this._editorOpts.backspaceUnindents) {
      out = computeBackspaceUnindent(ta.value, caret, this._tabWidth);
    } else if (e.key === 'ArrowRight' && this._editorOpts.allowBeyondEol && !e.shiftKey) {
      out = computeBeyondEolPad(ta.value, caret);
    }
    if (!out) return;

    e.preventDefault();
    ta.value = out.text;
    ta.selectionStart = ta.selectionEnd = out.caret;
    // Assigning `value` does not fire `input`, and that listener owns the
    // debounce, the undo snapshot and the re-diff.
    ta.dispatchEvent(new Event('input'));
  }

  /**
   * 1.9 Global Text options.
   * @returns {{ autoIndent: boolean, backspaceUnindents: boolean, allowBeyondEol: boolean }}
   */
  getEditorOptions() { return { ...this._editorOpts }; }

  /**
   * @param {'autoIndent'|'backspaceUnindents'|'allowBeyondEol'} name
   * @param {boolean} [on] omit to toggle
   * @returns {boolean} the value now in force
   */
  setEditorOption(name, on) {
    if (!Object.prototype.hasOwnProperty.call(this._editorOpts, name)) {
      toast(`未知的編輯器選項「${String(name)}」`, { type: 'error' });
      return false;
    }
    this._editorOpts[name] = on ?? !this._editorOpts[name];
    return this._editorOpts[name];
  }

  /**
   * 1.9 Show filtered line counts.
   * @param {boolean} [on] omit to toggle
   * @returns {boolean}
   */
  setShowFilteredLineCounts(on) {
    this._showFilteredLineCounts = on ?? !this._showFilteredLineCounts;
    this._updateStatusBar();
    return this._showFilteredLineCounts;
  }

  /** @returns {boolean} */
  getShowFilteredLineCounts() { return this._showFilteredLineCounts; }

  /**
   * Which difference-navigation arrows still have somewhere to go, so the host
   * toolbar can dim the rest.
   * @returns {NavAvailability}
   */
  getNavAvailability() {
    return navAvailability(
      this._currentDiff, this._diffBlocks.length, getNavOptions().wrapAround);
  }

  /**
   * BC's Text page options and the filtered-count switch, in one dialog.
   */
  openEditorOptionsDialog() {
    /** @type {HTMLInputElement|null} */ let autoEl = null;
    /** @type {HTMLInputElement|null} */ let backEl = null;
    /** @type {HTMLInputElement|null} */ let eolEl = null;
    /** @type {HTMLInputElement|null} */ let countsEl = null;

    /**
     * @param {HTMLElement} body
     * @param {boolean} checked
     * @param {string} label
     * @returns {HTMLInputElement}
     */
    const check = (body, checked, label) => {
      const row = document.createElement('label');
      row.style.display = 'block';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked;
      row.append(box, document.createTextNode(' ' + label));
      body.appendChild(row);
      return box;
    };

    this._openDialog({
      title: '編輯器選項',
      hint: '這些選項只影響編輯模式（Ctrl+E）下的輸入行為，不影響比對結果。',
      build: (body) => {
        autoEl = check(body, this._editorOpts.autoIndent,
          '自動縮排：換行時沿用目前行的前置空白');
        backEl = check(body, this._editorOpts.backspaceUnindents,
          `Backspace 反縮排：在前置空白中退回上一個定位點（每 ${this._tabWidth} 欄）`);
        eolEl = check(body, this._editorOpts.allowBeyondEol,
          '允許游標超過行尾：在行尾按 → 時補一個空格留在本行，而非跳到下一行');
        countsEl = check(body, this._showFilteredLineCounts,
          '在狀態列顯示被篩選隱藏的行數');
      },
      onConfirm: () => {
        this.setEditorOption('autoIndent', autoEl?.checked === true);
        this.setEditorOption('backspaceUnindents', backEl?.checked === true);
        this.setEditorOption('allowBeyondEol', eolEl?.checked === true);
        this.setShowFilteredLineCounts(countsEl?.checked === true);
        toast('已套用編輯器選項', { type: 'success' });
        return true;
      },
    });
  }

  /**
   * Toggle between edit mode and diff-view mode.
   * @returns {boolean} New edit mode state
   */
  toggleEditMode() {
    this._editMode = !this._editMode;
    if (this._editMode) {
      this._textareaLeft.value  = this._leftContent;
      this._textareaRight.value = this._rightContent;
      // 1.7 Prevent editing is per side, so entering edit mode must not
      // unlock a side the user locked.
      this._textareaLeft.readOnly  = this.isSideReadOnly('left');
      this._textareaRight.readOnly = this.isSideReadOnly('right');
      if (this._readOnly.left || this._readOnly.right) {
        toast(`已鎖定：${[this._readOnly.left ? '左側' : '', this._readOnly.right ? '右側' : ''].filter(Boolean).join('、')}`);
      }
      this._contentLeft.style.display  = 'none';
      this._contentRight.style.display = 'none';
      this._textareaLeft.style.display  = 'block';
      this._textareaRight.style.display = 'block';
      this._textareaLeft.focus();
    } else {
      this._contentLeft.style.display  = '';
      this._contentRight.style.display = '';
      this._textareaLeft.style.display  = 'none';
      this._textareaRight.style.display = 'none';
      this._runDiff();
    }
    this._emit('edit-mode-changed', { editMode: this._editMode });
    return this._editMode;
  }

  /** @returns {boolean} */
  get isEditMode() { return this._editMode; }

  /** Update path-bar labels to show unsaved modification markers. */
  _updateModifiedIndicator() {
    const leftMark  = this._modified.left  ? ' *' : '';
    const rightMark = this._modified.right ? ' *' : '';
    if (this._pathLeft) {
      this._pathLeft.textContent = (this._leftPath || '（未選擇）') + leftMark;
    }
    if (this._pathRight) {
      this._pathRight.textContent = (this._rightPath || '（未選擇）') + rightMark;
    }
  }

  /**
   * Save left-side content via Electron Save dialog.
   * @returns {Promise<void>}
   */
  async saveLeft() {
    if (!this._leftContent) return;
    const filters = [
      { name: '文字檔', extensions: ['txt','js','ts','py','java','c','cpp','cs','go','rs','html','css','json','yaml','yml','xml','sql','md','sh'] },
      { name: '所有檔案', extensions: ['*'] }
    ];
    const content = this._applySavePrefs('left');
    const result = await window.electronAPI.saveFile(
      this._leftPath || 'left.txt', content, filters,
      this._encodingLeft, _settings.getBackupOptions());
    // Cancelling the save dialog returns falsy. Clearing the flag regardless
    // told the user their edits were saved and let the tab close without a
    // prompt, silently losing them.
    if (!result) return;
    this._modified.left = false;
    this._updateModifiedIndicator();
    this._reportBackup(result);
  }

  /**
   * Save right-side content via Electron Save dialog.
   * @returns {Promise<void>}
   */
  async saveRight() {
    if (!this._rightContent) return;
    const filters = [
      { name: '文字檔', extensions: ['txt','js','ts','py','java','c','cpp','cs','go','rs','html','css','json','yaml','yml','xml','sql','md','sh'] },
      { name: '所有檔案', extensions: ['*'] }
    ];
    const content = this._applySavePrefs('right');
    const result = await window.electronAPI.saveFile(
      this._rightPath || 'right.txt', content, filters,
      this._encodingRight, _settings.getBackupOptions());
    // Cancelling the save dialog returns falsy. Clearing the flag regardless
    // told the user their edits were saved and let the tab close without a
    // prompt, silently losing them.
    if (!result) return;
    this._modified.right = false;
    this._updateModifiedIndicator();
    this._reportBackup(result);
  }

  /**
   * 1.9 Options ▸ Editor: apply the save-time clean-ups to one pane and
   * return the text that should actually be written.
   *
   * The transformed text is written back into the model and re-rendered, not
   * just handed to the writer. Writing trimmed text while the pane still
   * shows the untrimmed original would leave the view describing a file that
   * no longer exists on disk, and the next diff would be computed against it.
   *
   * Both preferences default to false, so with an untouched Options dialog
   * this returns the current content unchanged and nothing re-renders.
   *
   * @param {'left'|'right'} side
   * @returns {string} the text to write
   */
  _applySavePrefs(side) {
    const trim = Boolean(_settings.getPref('editTrimOnSave'));
    const finalNl = Boolean(_settings.getPref('editEnsureFinalNewline'));
    if (!trim && !finalNl) {
      return (side === 'left' ? this._leftContent : this._rightContent) ?? '';
    }

    // A keystroke within the last 300ms is still sitting in the textarea and
    // has not reached the model yet. Committing it here stops the pending
    // timer from firing after the save and putting the untransformed text
    // back, which would silently un-do the clean-up the user asked for.
    this._commitPendingEdit(side);

    const original = (side === 'left' ? this._leftContent : this._rightContent) ?? '';
    let next = original;
    if (trim) next = trimTrailingWhitespace(next);
    if (finalNl) {
      next = ensureFinalNewline(next, side === 'left' ? this._eolLeft : this._eolRight);
    }
    if (next === original) return original;

    if (side === 'left') this._leftContent = next;
    else this._rightContent = next;
    this._syncEditTextareas();
    this._runDiff();
    this._updateStatusBar();
    return next;
  }

  /**
   * Flush a debounced edit-mode keystroke into the model immediately.
   * @param {'left'|'right'} side
   */
  _commitPendingEdit(side) {
    const timerKey = side === 'left' ? '_editTimerLeft' : '_editTimerRight';
    if (this[timerKey] == null) return;
    clearTimeout(this[timerKey]);
    this[timerKey] = null;
    const ta = side === 'left' ? this._textareaLeft : this._textareaRight;
    if (!ta) return;
    if (side === 'left') this._leftContent = ta.value;
    else this._rightContent = ta.value;
  }

  /**
   * Surface the backup outcome the main process now reports alongside a save.
   *
   * A failed backup still leaves the file saved, so this is a status line
   * rather than an error: the user needs to know the safety net was missing,
   * not that their save failed.
   *
   * @param {unknown} result value returned by the `save-file` IPC
   */
  _reportBackup(result) {
    if (!result || typeof result !== 'object') return;
    const backup = result.backup;
    if (!backup || typeof backup !== 'object') return;
    if (backup.backedUp && backup.path) {
      this._emit('status', { message: `已備份至 ${backup.path}` });
    } else if (backup.reason) {
      this._emit('status', { message: `備份失敗：${backup.reason}`, level: 'warn' });
    }
  }

  // -------------------------------------------------------------------------
  // Public: set content directly (folder-compare double-click, etc.)
  // -------------------------------------------------------------------------

  /**
   * @param {string} path
   * @param {string} content
   */
  setLeft(path, content, encoding, confidence) {
    // T33: unwatch old path before switching
    if (this._leftPath && this._leftPath !== path) {
      _unwatch(this._leftPath);
    }
    this._leftPath = path;
    this._leftContent = content;
    this._resetPerDocumentState('left');
    if (encoding) this._encodingLeft = encoding;
    // A detection this weak is a guess, and the status bar says so rather
    // than presenting it as a fact. main computes this precisely so the
    // view can mark it; until now nothing read it.
    this._encodingGuessLeft = typeof confidence === 'number'
      && confidence > 0 && confidence < LOW_CONFIDENCE;
    this._eolLeft = detectEol(content); // T01
    this._syncWebpageButton();
    this._resolveGrammars();
    if (this._pathLeft) this._pathLeft.textContent = path || '（未選擇）';
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath });
    // T33: start watching the new file path (if it's a real file path)
    _watch(path);
    this._runDiff({ resetScroll: true });
  }

  /**
   * Forget the state that describes positions in a document that has just
   * been replaced. Edit marks, the caret and manual alignment all name line
   * numbers; carried over to different content they would point at unrelated
   * text and quietly mislead Next Edit and Align With.
   * @param {'left'|'right'} side
   */
  _resetPerDocumentState(side) {
    this._editMarks[side] = [];
    this._caret[side] = null;
    this._caretCol = 0;
    this._inlineCursor = null;
    this._pendingAlign = null;
    this._alignAnchors = [];
  }

  /**
   * Current text of one pane.
   * @param {'left'|'right'} side
   * @returns {string}
   */
  getContent(side) {
    return (side === 'right' ? this._rightContent : this._leftContent) ?? '';
  }

  /**
   * @param {string} path
   * @param {string} content
   */
  setRight(path, content, encoding, confidence) {
    // T33: unwatch old path before switching
    if (this._rightPath && this._rightPath !== path) {
      _unwatch(this._rightPath);
    }
    this._rightPath = path;
    this._rightContent = content;
    this._resetPerDocumentState('right');
    if (encoding) this._encodingRight = encoding;
    // A detection this weak is a guess, and the status bar says so rather
    // than presenting it as a fact. main computes this precisely so the
    // view can mark it; until now nothing read it.
    this._encodingGuessRight = typeof confidence === 'number'
      && confidence > 0 && confidence < LOW_CONFIDENCE;
    this._eolRight = detectEol(content); // T01
    this._syncWebpageButton();
    this._resolveGrammars();
    if (this._pathRight) this._pathRight.textContent = path || '（未選擇）';
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath });
    // T33: start watching the new file path (if it's a real file path)
    _watch(path);
    this._runDiff({ resetScroll: true });
  }

  // -------------------------------------------------------------------------
  // Public: navigation
  // -------------------------------------------------------------------------

  /** 下一個差異（是否環繞依 Next Difference 設定）。 @returns {NavResult} */
  navigateNext() { return this._navStep(1); }

  /** 上一個差異（是否環繞依 Next Difference 設定）。 @returns {NavResult} */
  navigatePrev() { return this._navStep(-1); }

  /** @returns {NavResult} */
  navigateFirst() { return this._navJump(0); }

  /** @returns {NavResult} */
  navigateLast() { return this._navJump(this._diffBlocks.length - 1); }

  /**
   * @param {number} delta
   * @returns {NavResult}
   */
  _navStep(delta) {
    const total = this._diffBlocks.length;
    const from = this._currentDiff;
    const to = stepDiffIndex(from, total, delta);
    return this._navJump(to);
  }

  /**
   * @param {number} target
   * @returns {NavResult}
   */
  _navJump(target) {
    const total = this._diffBlocks.length;
    const from = this._currentDiff;
    if (total === 0 || target < 0) return navResult(from, -1, total);
    this._currentDiff = target;
    this._scrollToDiff(target);
    this._updateStatusBar();
    // The host dims the arrows from this event, so it has to fire on every
    // move and not only when a fresh diff changes the count.
    this._emit('diff-count', {
      total, currentIndex: target, availability: this.getNavAvailability(),
    });
    return navResult(from, target, total);
  }

  // -------------------------------------------------------------------------
  // Public: copy operations
  // -------------------------------------------------------------------------

  /** Copy current diff block's left content → right side */
  copyToRight() {
    this._copyBlock('right');
  }

  /** Copy current diff block's right content → left side */
  copyToLeft() {
    this._copyBlock('left');
  }

  /** Copy ALL diffs to right side: right becomes identical to left (T09) */
  copyAllToRight() {
    if (!this._leftContent) return;
    if (!this._guardWrite('right')) return;
    this._pushUndoSnapshot();
    this._rightContent = this._leftContent;
    this._runDiff();
  }

  /** Copy ALL diffs to left side: left becomes identical to right (T09) */
  copyAllToLeft() {
    if (!this._rightContent) return;
    if (!this._guardWrite('left')) return;
    this._pushUndoSnapshot();
    this._leftContent = this._rightContent;
    this._runDiff();
  }

  // -------------------------------------------------------------------------
  // Public: misc
  // -------------------------------------------------------------------------

  refresh() {
    if (this._leftContent && this._rightContent) {
      this._runDiff();
    }
  }

  // -------------------------------------------------------------------------
  // Public: command surface for the application menu
  // -------------------------------------------------------------------------

  /**
   * Re-read one side using an explicitly chosen encoding.
   *
   * Detection guesses, and guesses badly on short non-UTF-8 files. Without a
   * manual override a mis-detected file was unreadable and — worse — would be
   * written back through the wrong codec on save.
   *
   * @param {'left'|'right'} side
   * @param {string} encoding
   * @returns {Promise<boolean>} false when there is no file on that side
   */
  async reloadWithEncoding(side, encoding) {
    const path = side === 'left' ? this._leftPath : this._rightPath;
    if (!path) return false;
    const result = await window.electronAPI.readFile(path, encoding);
    if (!result) return false;
    // Remembered so a later reload does not re-run detection and quietly undo
    // the choice the user made here.
    this._manualEncoding[side] = encoding;
    if (side === 'left') this.setLeft(result.path, result.content, result.encoding);
    else this.setRight(result.path, result.content, result.encoding);
    return true;
  }

  /**
   * Re-read one side from disk, discarding the in-memory copy.
   *
   * `refresh()` only re-runs the comparison over what is already loaded, so an
   * edit another program made was invisible unless the file watcher happened to
   * see it. Watching misses network drives and the write-temp-then-rename dance
   * several editors use, which left no manual fallback at all.
   *
   * @param {'left'|'right'} side
   * @param {{ confirmed?: boolean }} [opts] `confirmed` skips the prompt when
   *   the caller has already asked (reloading both sides asks once)
   * @returns {Promise<boolean>} true when the side was re-read
   */
  async reloadSide(side, opts = {}) {
    const sideName = side === 'left' ? '左側' : '右側';
    const path = side === 'left' ? this._leftPath : this._rightPath;
    if (!path) {
      toast(`${sideName}沒有檔案路徑，無法重新載入`, { type: 'error' });
      return false;
    }
    if (!opts.confirmed && this._modified[side]) {
      const ok = window.confirm(
        `${sideName}有未儲存的編輯。\n` +
        '重新載入會從磁碟讀回檔案，這些編輯會遺失。要繼續嗎？');
      if (!ok) return false;
    }

    const encoding = this._manualEncoding[side];
    let result;
    try {
      result = encoding
        ? await window.electronAPI.readFile(path, encoding)
        : await window.electronAPI.readFile(path);
    } catch (err) {
      toast(`重新載入${sideName}失敗：${err instanceof Error ? err.message : String(err)}`,
        { type: 'error', durationMs: 6000 });
      return false;
    }
    // A transient read failure must leave the panes alone; blanking them would
    // look exactly like the file having been emptied on disk.
    if (!result || typeof result.content !== 'string') {
      toast(`重新載入${sideName}失敗：讀不到檔案內容`, { type: 'error', durationMs: 6000 });
      return false;
    }

    if (side === 'left') this.setLeft(result.path ?? path, result.content, result.encoding, result.confidence);
    else this.setRight(result.path ?? path, result.content, result.encoding, result.confidence);
    // setLeft/setRight replace the content but know nothing about edits; the
    // dirty flag has to be cleared here or the tab still claims unsaved work.
    this._modified[side] = false;
    this._updateModifiedIndicator();
    this._syncEditTextareas();
    toast(`已重新載入${sideName}`, { type: 'success' });
    return true;
  }

  /**
   * Re-read whichever sides have a path.
   * @returns {Promise<boolean>} true when at least one side was re-read
   */
  async reloadAll() {
    /** @type {Array<'left'|'right'>} */
    const sides = [];
    if (this._leftPath) sides.push('left');
    if (this._rightPath) sides.push('right');
    if (sides.length === 0) {
      toast('尚未載入任何檔案，無法重新載入', { type: 'error' });
      return false;
    }
    if (sides.some((s) => this._modified[s])) {
      const ok = window.confirm(
        '有尚未儲存的編輯。重新載入會從磁碟讀回檔案，這些編輯會遺失。要繼續嗎？');
      if (!ok) return false;
    }
    let any = false;
    for (const side of sides) {
      if (await this.reloadSide(side, { confirmed: true })) any = true;
    }
    return any;
  }

  /**
   * Encoding currently in effect for one side.
   * @param {'left'|'right'} side
   * @returns {string}
   */
  getEncoding(side) {
    return side === 'left' ? this._encodingLeft : this._encodingRight;
  }

  /** Open the find bar. */
  openFind() { this._openFind(false); }

  /** Open the find bar in replace mode. */
  openReplace() { this._openFind(true); }

  /** Open the go-to-line bar. */
  openGoto() { this._openGoto(); }

  /** Toggle a bookmark on the row the user last clicked. */
  toggleBookmark() { this._toggleBookmarkAtCursor(); }

  /** Scroll to the next bookmark, wrapping around. */
  nextBookmark() { this._navigateBookmark(1); }

  /** Scroll to the previous bookmark, wrapping around. */
  prevBookmark() { this._navigateBookmark(-1); }

  /**
   * P2-51: jump to the Nth bookmark in line order (BC's numbered Go To
   * Bookmark). Out of range says so rather than silently doing nothing —
   * "nothing happened" is indistinguishable from a broken shortcut.
   *
   * @param {number} n 1-based
   * @returns {boolean} whether a bookmark was reached
   */
  gotoBookmark(n) {
    const sorted = [...this._bookmarks].sort((a, b) => a - b);
    const idx = Math.trunc(Number(n)) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= sorted.length) {
      toast(sorted.length === 0 ? '尚未設定任何書籤' : `只有 ${sorted.length} 個書籤`,
        { type: 'error' });
      return false;
    }
    const target = sorted[idx];
    if (this._contentLeft) this._contentLeft.scrollTop = target * this._rowHeight;
    if (this._contentRight) this._contentRight.scrollTop = target * this._rowHeight;
    this._renderVisibleRows();
    return true;
  }

  /** Toggle soft wrapping of long lines. */
  toggleWordWrap() {
    this._wordWrap = !this._wordWrap;
    this._applyWordWrap();
    const chk = document.getElementById('chk-word-wrap');
    if (chk instanceof HTMLInputElement) chk.checked = this._wordWrap;
    return this._wordWrap;
  }

  /**
   * Set the diff algorithm and re-run the diff.
   * @param {'myers'|'patience'|'histogram'} algo
   */
  setAlgorithm(algo) {
    this._opts.algorithm = algo;
    this._runDiff();
  }

  swap() {
    [this._leftContent, this._rightContent] = [this._rightContent, this._leftContent];
    [this._leftPath, this._rightPath] = [this._rightPath, this._leftPath];
    [this._hlLeft, this._hlRight] = [this._hlRight, this._hlLeft];
    if (this._pathLeft) this._pathLeft.textContent = this._leftPath || '（未選擇）';
    if (this._pathRight) this._pathRight.textContent = this._rightPath || '（未選擇）';
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath });
    if (this._leftContent && this._rightContent) this._runDiff();
  }

  /**
   * Compute aggregate diff statistics from the current _diffResult.
   * @returns {{ equal: number, insert: number, delete: number, replace: number, total: number }}
   */
  getDiffStats() {
    const stats = { equal: 0, insert: 0, delete: 0, replace: 0, total: 0 }
    for (const dl of (this._diffResult ?? [])) {
      if (dl && Object.prototype.hasOwnProperty.call(stats, dl.type)) {
        stats[dl.type]++
      }
    }
    stats.total = stats.equal + stats.insert + stats.delete + stats.replace
    return stats
  }

  /**
   * Build the self-contained HTML report string.
   * Pure-function helper extracted from exportHtml so callers (e.g. print
   * preview) can obtain the same payload without writing to disk.
   * @returns {string}
   */
  buildHtmlReport() {
    const esc = (s) => (s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    const typeClass = { equal: 'eq', insert: 'ins', delete: 'del', replace: 'rep' }
    const stats = this.getDiffStats()
    const timestamp = new Date().toLocaleString('zh-TW')

    const rows = (this._diffResult ?? []).map(dl => {
      const cls = typeClass[dl.type] ?? 'eq'
      const ln = (n) => `<td class="ln">${n ?? ''}</td>`
      return `<tr class="${cls}">
  ${ln(dl.leftLine)}<td class="txt">${esc(dl.leftText?.replace(/\r?\n$/,''))}</td>
  ${ln(dl.rightLine)}<td class="txt">${esc(dl.rightText?.replace(/\r?\n$/,''))}</td>
</tr>`
    }).join('\n')

    return `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8">
<title>MyCompare — 比對報告</title>
<style>
body{font-family:monospace;font-size:13px;background:#fff;color:#222;margin:16px}
h2{font-family:sans-serif;margin-bottom:4px}
.paths{font-family:sans-serif;font-size:12px;color:#666;margin-bottom:12px}
.report-stats{font-family:sans-serif;font-size:12px;display:flex;flex-wrap:wrap;
  gap:10px;padding:8px 12px;background:#f5f5f5;border:1px solid #ddd;
  border-radius:4px;margin-bottom:12px}
.report-stats > div{padding:2px 0}
.report-stats .stat-add{color:#067d39;font-weight:600}
.report-stats .stat-del{color:#b3261e;font-weight:600}
.report-stats .stat-mod{color:#996c00;font-weight:600}
.report-stats .stat-eq{color:#666;font-weight:600}
.report-stats .ts{margin-left:auto;color:#888}
table{border-collapse:collapse;width:100%}
td{padding:1px 6px;white-space:pre-wrap;word-break:break-all}
.ln{color:#888;text-align:right;min-width:3em;user-select:none;border-right:1px solid #ddd;padding-right:6px}
.eq td{background:#fff}
.del td{background:#ffd7d7}
.ins td{background:#d7ffd7}
.rep td{background:#fffad7}
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
<h2>比對報告</h2>
<div class="paths">左：${esc(this._leftPath || '（未知）')} &nbsp;|&nbsp; 右：${esc(this._rightPath || '（未知）')}</div>
<div class="report-stats">
  <div>新增: <span class="stat-add">${stats.insert}</span> 行</div>
  <div>刪除: <span class="stat-del">${stats.delete}</span> 行</div>
  <div>變更: <span class="stat-mod">${stats.replace}</span> 行</div>
  <div>相同: <span class="stat-eq">${stats.equal}</span> 行</div>
  <div class="ts">生成時間: ${esc(timestamp)}</div>
</div>
<table>
<thead><tr><th colspan="2">左側</th><th colspan="2">右側</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body></html>`
  }

  /**
   * Export the diff as a self-contained HTML report.
   * @param {{ print?: boolean }} [opts] When print=true, opens the HTML in a
   *   blob URL window and triggers window.print() instead of saving to disk.
   */
  async exportHtml(opts = {}) {
    const html = this.buildHtmlReport()
    if (opts.print) {
      try {
        const blob = new Blob([html], { type: 'text/html' })
        const url = URL.createObjectURL(blob)
        const win = window.open(url, '_blank')
        if (win) {
          win.addEventListener('load', () => {
            try { win.print() } catch { /* user cancelled */ }
          })
        }
      } catch {
        // Fallback to save if blob/window.open unavailable
        await window.electronAPI.saveFile('compare-report.html', html)
      }
      return
    }
    await window.electronAPI.saveFile('compare-report.html', html)
  }

  /**
   * Build the comparison as a plain-text report.
   *
   * @param {{ generatedAt?: Date }} [opts]
   * @returns {string}
   */
  buildTextReport(opts = {}) {
    const stats = this.getDiffStats();
    const header = reportHeader({
      title: '文字比對報告',
      leftPath: this._leftPath,
      rightPath: this._rightPath,
      generatedAt: opts.generatedAt,
    });
    const summary = reportSummary(stats, {
      insert: '新增', delete: '刪除', replace: '變更', equal: '相同',
    });

    const rows = [];
    for (const dl of this._diffResult ?? []) {
      if (dl.type === 'equal') continue;
      const mark = { insert: '+', delete: '-', replace: '~' }[dl.type] ?? '?';
      rows.push([
        mark,
        dl.leftLine == null ? '' : String(dl.leftLine),
        (dl.leftText ?? '').replace(/[\r\n]+$/, ''),
        dl.rightLine == null ? '' : String(dl.rightLine),
        (dl.rightText ?? '').replace(/[\r\n]+$/, ''),
      ]);
    }

    const table = rows.length
      ? renderTextTable(
          [
            { title: '' },
            { title: '左行', align: 'right' },
            { title: '左內容' },
            { title: '右行', align: 'right' },
            { title: '右內容' },
          ],
          rows)
      : '（兩側內容相同）';

    return `${header}${summary}\n\n${table}\n`;
  }

  /**
   * Save the plain-text report.
   * @returns {Promise<void>}
   */
  async exportTextReport() {
    await window.electronAPI.saveFile(
      'compare-report.txt',
      this.buildTextReport(),
      [{ name: '純文字', extensions: ['txt'] }, { name: '所有檔案', extensions: ['*'] }]);
  }

  /**
   * Export diff as unified diff (.patch) format (T34b).
   * Generates standard unified diff with 3-line context hunks.
   */
  async exportUnifiedDiff() {
    if (!this._diffResult || this._diffResult.length === 0) {
      alert('無差異可匯出');
      return;
    }

    // Check if there are any actual differences
    const hasDiff = this._diffResult.some(dl => dl.type !== 'equal');
    if (!hasDiff) {
      alert('無差異可匯出');
      return;
    }

    const CONTEXT = 3;
    const leftPath  = this._leftPath  || 'left';
    const rightPath = this._rightPath || 'right';
    const now = new Date().toISOString();

    // Build a flat array of { side: 'left'|'right'|'both', text, leftLine, rightLine, type }
    // to generate hunks with context
    /** @type {Array<{type: string, leftLine: number|null, rightLine: number|null, leftText: string, rightText: string}>} */
    const lines = this._diffResult;

    /**
     * Generate unified diff output.
     * We iterate over lines and collect contiguous changed regions (with CONTEXT lines around them).
     */
    const hunks = [];
    const n = lines.length;
    let i = 0;

    while (i < n) {
      // Find next changed line
      if (lines[i].type === 'equal') { i++; continue; }

      // Determine hunk bounds
      const hunkStart = i;
      // Extend to find all consecutive changed regions within CONTEXT distance
      let end = i;
      while (end < n) {
        if (lines[end].type !== 'equal') { end++; continue; }
        // Check if next non-equal is within CONTEXT*2 lines
        let gap = 0;
        let j = end;
        while (j < n && lines[j].type === 'equal') { gap++; j++; }
        if (j < n && gap <= CONTEXT * 2) { end = j; } else { break; }
      }
      // end is now the exclusive end of the last changed region

      // Actual hunk line range (with context)
      const ctxStart = Math.max(0, hunkStart - CONTEXT);
      const ctxEnd   = Math.min(n, end + CONTEXT);

      // Build hunk lines
      const hunkLines = [];
      let leftStart = null;
      let rightStart = null;
      let leftCount = 0;
      let rightCount = 0;

      for (let k = ctxStart; k < ctxEnd; k++) {
        const dl = lines[k];
        if (dl.type === 'equal') {
          const txt = (dl.leftText ?? '').replace(/\r?\n$/, '\n');
          hunkLines.push(' ' + txt.replace(/\n$/, ''));
          if (leftStart === null) leftStart = dl.leftLine ?? 1;
          if (rightStart === null) rightStart = dl.rightLine ?? 1;
          leftCount++;
          rightCount++;
        } else if (dl.type === 'delete') {
          const txt = (dl.leftText ?? '').replace(/\r?\n$/, '\n');
          hunkLines.push('-' + txt.replace(/\n$/, ''));
          if (leftStart === null) leftStart = dl.leftLine ?? 1;
          if (rightStart === null) rightStart = dl.rightLine ?? (dl.leftLine ?? 1);
          leftCount++;
        } else if (dl.type === 'insert') {
          const txt = (dl.rightText ?? '').replace(/\r?\n$/, '\n');
          hunkLines.push('+' + txt.replace(/\n$/, ''));
          if (leftStart === null) leftStart = dl.leftLine ?? 1;
          if (rightStart === null) rightStart = dl.rightLine ?? 1;
          rightCount++;
        } else if (dl.type === 'replace') {
          const leftTxt  = (dl.leftText  ?? '').replace(/\r?\n$/, '\n');
          const rightTxt = (dl.rightText ?? '').replace(/\r?\n$/, '\n');
          hunkLines.push('-' + leftTxt.replace(/\n$/, ''));
          hunkLines.push('+' + rightTxt.replace(/\n$/, ''));
          if (leftStart === null) leftStart = dl.leftLine ?? 1;
          if (rightStart === null) rightStart = dl.rightLine ?? (dl.leftLine ?? 1);
          leftCount++;
          rightCount++;
        }
      }

      const ls = leftStart  ?? 1;
      const rs = rightStart ?? 1;
      hunks.push(`@@ -${ls},${leftCount} +${rs},${rightCount} @@`);
      hunks.push(...hunkLines);

      i = end;
    }

    const content = [
      `--- ${leftPath}\t(${now})`,
      `+++ ${rightPath}\t(${now})`,
      ...hunks,
      '',
    ].join('\n');

    await window.electronAPI.saveFile(
      'compare.patch',
      content,
      [{ name: 'Patch', extensions: ['patch', 'diff'] }],
    );
  }

  /** @returns {{ total: number, currentIndex: number }} */
  getDiffInfo() {
    return {
      total: this._diffBlocks.length,
      currentIndex: this._currentDiff,
    };
  }

  // -------------------------------------------------------------------------
  // Public: event system
  // -------------------------------------------------------------------------

  /**
   * @param {string} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
  }

  /**
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  // -------------------------------------------------------------------------
  // Private: core diff pipeline
  // -------------------------------------------------------------------------

  /** Run diffLines, build rows, render, update minimap + status. */
  /**
   * @param {{ resetScroll?: boolean }} [opts] forwarded to _render
   */
  _runDiff({ resetScroll = false } = {}) {
    if (!this._leftContent && !this._rightContent) return;

    // P2-29: grammar tokens feed both the alignment weights below and the
    // importance decision further down, so they have to exist first.
    this._computeGrammarTokens();

    if (!this._leftContent || !this._rightContent) {
      // Single-side view: show content without diff coloring
      const content = this._leftContent || this._rightContent;
      const isLeft  = !!this._leftContent;
      this._diffResult = content.split('\n').map((text, i) => ({
        type: 'equal',
        leftLine:  isLeft ? i + 1 : null,
        rightLine: isLeft ? null  : i + 1,
        leftText:  isLeft ? text  : '',
        rightText: isLeft ? ''    : text,
      }));
    } else {
      const weights = this._alignmentWeights();
      const diffOpts = {
        algorithm: this._opts.algorithm,
        ignoreWhitespace: this._opts.ignoreWhitespace,
        ignoreCase: this._opts.ignoreCase,
        ignoreLineEndings: this._opts.ignoreLineEndings,
        ignoreIndent: this._opts.ignoreIndent,
        ignoreCrlf: this._opts.ignoreCrlf,
        alignMode: this._opts.alignMode,
        leftWeights: weights?.left,
        rightWeights: weights?.right,
      };
      // 1.7 Replacements rewrite both sides *for the comparison only*; the
      // original text is put back below so nothing downstream ever sees the
      // rewritten form.
      // P2-53: the two whitespace modes the engine cannot express ride the
      // same rewrite-then-restore path.
      const wsMode = this._whitespaceMode;
      const active = this._replacementsCompiled.length > 0 || REWRITE_WS_MODES.has(wsMode);
      /** @param {string} text */
      const forDiff = (text) => applyWhitespaceMode(
        this._replacementsCompiled.length > 0
          ? applyReplacements(text, this._replacementsCompiled)
          : text,
        wsMode);
      const leftForDiff = forDiff(this._leftContent);
      const rightForDiff = forDiff(this._rightContent);

      // 1.4 Align With: anchors cut the files into regions that are diffed
      // independently, which is what forces the pinned lines onto one row.
      this._diffResult = this._alignAnchors.length > 0
        ? diffWithAnchors(leftForDiff, rightForDiff, this._alignAnchors, diffOpts)
        : diffLines(leftForDiff, rightForDiff, diffOpts);

      if (active) {
        restoreOriginalDiffText(
          this._diffResult,
          splitLinesKeepEol(this._leftContent),
          splitLinesKeepEol(this._rightContent));
      }

      // P2-59 / P2-60: never-align, skew tolerance and closeness matching all
      // re-pair lines the engine already decided on, so they run after it.
      // Skipped outside 'standard': re-pairing is exactly what the other two
      // modes were chosen to avoid, so honouring both at once is incoherent.
      if (this._opts.alignMode === 'standard') {
        this._diffResult = applyAlignmentOptions(this._diffResult, this._alignmentOptions());
      } else if (this._opts.alignMode === 'never') {
        // diffLines already split its own output, but the anchor path builds
        // paired rows of its own afterwards.
        this._diffResult = splitAlignedPairs(this._diffResult);
      }
    }

    // Apply ignore / unimportant patterns
    this._applyIgnorePatterns();

    // Fold state is expressed as _diffResult index ranges, which a fresh diff
    // invalidates. The in-line difference cursor is indexed the same way.
    this._expandedRuns.clear();
    this._inlineCursor = null;

    this._buildRows();
    this._buildDiffBlocks();
    this._render({ resetScroll });
    this._buildMinimap();
    this._updateStatusBar();
    this._updateFileInfo();
    this._updateDetails();

    // Reset navigation
    this._currentDiff = this._diffBlocks.length > 0 ? 0 : -1;
    // resetScroll marks the "new files were loaded" path, which is exactly
    // when BC's "go to first difference" option applies.
    if (resetScroll && this._currentDiff >= 0 && getNavOptions().firstDiffOnLoad) {
      this._scrollToDiff(0);
    }
    this._emit('diff-count', {
      total: this._diffBlocks.length,
      currentIndex: this._currentDiff,
      availability: this.getNavAvailability(),
    });
    this._emit('ready');
  }

  /** Apply ignorePatterns / unimportantPatterns to _diffResult in-place.
   *  S13-C05: pattern length cap + compile cache. */
  _applyIgnorePatterns() {
    const MAX_PATTERN_LEN = 200;
    const MAX_TEXT_LEN = 100000; // do not test regex against absurdly long lines
    const compile = (src, cache) => {
      if (typeof src !== 'string' || src.length === 0) return null;
      if (cache.has(src)) return cache.get(src);
      if (src.length > MAX_PATTERN_LEN) { cache.set(src, null); return null; }
      let re = null;
      try { re = new RegExp(src) } catch { /* invalid pattern */ }
      cache.set(src, re);
      return re;
    };
    const ignoreRe = this._opts.ignorePatterns
      .map(p => compile(p, this._ignoreRegexCache)).filter(Boolean);
    const unimportantRe = this._opts.unimportantPatterns
      .map(p => compile(p, this._unimportantRegexCache)).filter(Boolean);

    const manualLeft = this._manualIgnore.left
    const manualRight = this._manualIgnore.right
    const hasManual = manualLeft.size > 0 || manualRight.size > 0

    for (const dl of this._diffResult) {
      if (dl.type === 'equal') continue
      const text = (dl.leftText || dl.rightText || '').slice(0, MAX_TEXT_LEN)
      if (ignoreRe.some(re => re.test(text))) {
        dl.type = 'equal'
        continue
      }
      // P2-30: a manual mark on either side is enough — a replace line is one
      // logical difference even though it occupies a line number on both sides.
      const manual = hasManual && (
        (dl.leftLine != null && manualLeft.has(dl.leftLine)) ||
        (dl.rightLine != null && manualRight.has(dl.rightLine))
      )
      // P2-54: an orphan is a line one side simply does not have. A manual
      // mark still wins — that is the user saying it about this exact line —
      // but no pattern rule may quietly demote it.
      const orphan = dl.leftLine == null || dl.rightLine == null
      const protectedOrphan = this._opts.orphansAlwaysImportant && orphan && !manual
      dl.manualIgnored = manual
      dl.grammarIgnored = !manual && !protectedOrphan && this._grammarUnimportant(dl)
      dl.unimportant = manual || (!protectedOrphan && (dl.grammarIgnored ||
        (unimportantRe.length > 0 && unimportantRe.some(re => re.test(text)))))
      // BC's "Ignore Unimportant Differences" downgrades these to equal rather
      // than merely tinting them blue, which is what makes a file with only
      // cosmetic changes read as identical.
      if (dl.unimportant && this._opts.ignoreUnimportant) dl.type = 'equal'
    }
  }

  // -------------------------------------------------------------------------
  // Public: P2-53 — whitespace comparison mode
  // -------------------------------------------------------------------------

  /**
   * The whitespace rule currently in effect.
   *
   * Derived rather than stored so the two legacy checkboxes in the toolbar
   * stay the single source of truth for the modes they already express.
   *
   * @returns {WhitespaceMode}
   */
  getWhitespaceMode() {
    if (REWRITE_WS_MODES.has(this._whitespaceMode)) return this._whitespaceMode;
    if (this._opts.ignoreWhitespace) return 'amount';
    if (this._opts.ignoreIndent) return 'leading';
    return 'none';
  }

  /**
   * BC's four whitespace choices are mutually exclusive, so setting one clears
   * the others rather than adding to them.
   *
   * @param {WhitespaceMode} mode
   * @returns {WhitespaceMode} the mode actually in effect
   */
  setWhitespaceMode(mode) {
    const valid = ['none', 'all', 'leading', 'trailing', 'amount'];
    const next = /** @type {WhitespaceMode} */ (valid.includes(mode) ? mode : 'none');
    this._opts.ignoreWhitespace = next === 'amount';
    this._opts.ignoreIndent = next === 'leading';
    this._whitespaceMode = REWRITE_WS_MODES.has(next) ? next : 'none';
    const chkWs = document.getElementById('chk-ignore-whitespace');
    if (chkWs instanceof HTMLInputElement) chkWs.checked = this._opts.ignoreWhitespace;
    const chkIndent = document.getElementById('chk-ignore-indent');
    if (chkIndent instanceof HTMLInputElement) chkIndent.checked = this._opts.ignoreIndent;
    if (this._leftContent || this._rightContent) this._runDiff();
    return next;
  }

  // -------------------------------------------------------------------------
  // Public: P2-59 / P2-60 — alignment options
  // -------------------------------------------------------------------------

  /**
   * Compiled options for `applyAlignmentOptions`.
   * @returns {AlignmentOptions}
   */
  _alignmentOptions() {
    return {
      neverAlign: this._neverAlignCompiled,
      skewTolerance: this._opts.skewTolerance,
      useCloseness: this._opts.useClosenessMatching,
      closenessThreshold: this._opts.closenessThreshold,
    };
  }

  /**
   * 1.7 Alignment tab: whether the two sides are aligned by content at all.
   *
   * @param {unknown} mode 'standard' | 'unaligned' | 'never'
   * @returns {import('../core/diff-engine.js').AlignmentMode} the mode in force
   */
  setAlignmentMode(mode) {
    const next = normaliseAlignmentMode(mode);
    if (next !== mode) {
      toast(`未知的對齊模式「${String(mode)}」，已改用「標準對齊」`, { type: 'error' });
    }
    if (next === this._opts.alignMode) return next;
    this._opts.alignMode = next;
    if (this._leftContent || this._rightContent) this._runDiff();
    return next;
  }

  /** @returns {import('../core/diff-engine.js').AlignmentMode} */
  getAlignmentMode() { return this._opts.alignMode; }

  /**
   * Lines matching any of these patterns never become half of a paired
   * `replace` row — BC's "Never align these lines".
   *
   * @param {string[]} patterns
   * @returns {string[]} patterns that failed to compile; the rest still apply
   */
  setNeverAlignPatterns(patterns) {
    const list = (Array.isArray(patterns) ? patterns : [])
      .filter((p) => typeof p === 'string' && p.length > 0 && p.length <= 200);
    /** @type {RegExp[]} */
    const compiled = [];
    /** @type {string[]} */
    const bad = [];
    for (const p of list) {
      try { compiled.push(new RegExp(p)); } catch { bad.push(p); }
    }
    this._opts.neverAlignPatterns = list;
    this._neverAlignCompiled = compiled;
    if (this._leftContent || this._rightContent) this._runDiff();
    return bad;
  }

  /** @returns {string[]} */
  getNeverAlignPatterns() {
    return [...this._opts.neverAlignPatterns];
  }

  /**
   * How far apart two lines may sit inside a run and still be paired.
   * Zero means no limit, which is the engine's own behaviour.
   * @param {number} n
   * @returns {number}
   */
  setSkewTolerance(n) {
    const v = Number(n);
    this._opts.skewTolerance = Number.isFinite(v) ? Math.max(0, Math.min(1000, Math.round(v))) : 0;
    if (this._leftContent || this._rightContent) this._runDiff();
    return this._opts.skewTolerance;
  }

  /** @returns {number} */
  getSkewTolerance() { return this._opts.skewTolerance; }

  /**
   * Pair lines by similarity instead of by position within the run.
   * @param {boolean} [on] omit to toggle
   * @param {number} [threshold] 0..1, minimum similarity for a pair
   * @returns {boolean}
   */
  setClosenessMatching(on, threshold) {
    this._opts.useClosenessMatching = on ?? !this._opts.useClosenessMatching;
    if (Number.isFinite(threshold)) {
      this._opts.closenessThreshold = Math.max(0, Math.min(1, Number(threshold)));
    }
    if (this._leftContent || this._rightContent) this._runDiff();
    return this._opts.useClosenessMatching;
  }

  /**
   * How many lines the never-align patterns are keeping out of the pairing.
   * Reported in the Alignment dialog so a pattern that matches nothing is
   * visible as such rather than looking like it worked.
   * @returns {{ left: number, right: number }}
   */
  getUnalignedLineCounts() {
    /** @param {string} text */
    const hit = (text) => this._neverAlignCompiled.some((re) => { re.lastIndex = 0; return re.test(text); });
    let left = 0, right = 0;
    if (this._neverAlignCompiled.length > 0) {
      for (const line of splitLinesKeepEol(this._leftContent)) if (hit(line)) left++;
      for (const line of splitLinesKeepEol(this._rightContent)) if (hit(line)) right++;
    }
    return { left, right };
  }

  // -------------------------------------------------------------------------
  // Public: P2-54 — orphan importance
  // -------------------------------------------------------------------------

  /**
   * Whether a line present on one side only is always an important difference.
   * @param {boolean} [on] omit to toggle
   * @returns {boolean}
   */
  setOrphansAlwaysImportant(on) {
    this._opts.orphansAlwaysImportant = on ?? !this._opts.orphansAlwaysImportant;
    if (this._leftContent || this._rightContent) this._runDiff();
    return this._opts.orphansAlwaysImportant;
  }

  // -------------------------------------------------------------------------
  // Public: P2-52 — syntax highlighting toggle
  // -------------------------------------------------------------------------

  /**
   * @param {boolean} [on] omit to toggle
   * @returns {boolean}
   */
  setSyntaxHighlighting(on) {
    this._syntaxHighlight = on ?? !this._syntaxHighlight;
    this._render();
    return this._syntaxHighlight;
  }

  /** @returns {boolean} */
  get syntaxHighlighting() { return this._syntaxHighlight; }

  /**
   * The highlighter a side should render with, or null when highlighting is
   * off. Every render path goes through here so the toggle cannot be missed
   * by one of them.
   * @param {'left'|'right'} side
   */
  _hl(side) {
    if (!this._syntaxHighlight) return null;
    return side === 'left' ? this._hlLeft : this._hlRight;
  }

  /**
   * Toggle whether unimportant differences count as differences at all.
   * @param {boolean} [on] omit to toggle
   * @returns {boolean} the resulting state
   */
  setIgnoreUnimportant(on) {
    this._opts.ignoreUnimportant = on ?? !this._opts.ignoreUnimportant
    this._runDiff()
    return this._opts.ignoreUnimportant
  }

  /**
   * Number of context lines kept around each difference when folding, and
   * when the Show filter is set to 'diff'.
   * @param {number} n
   */
  setContextLines(n) {
    const v = Number(n)
    if (!Number.isFinite(v)) return
    this._opts.contextLines = Math.max(0, Math.min(100, Math.round(v)))
    this._runDiff()
  }

  /** @returns {number} */
  getContextLines() {
    return this._opts.contextLines
  }

  /**
   * How many rows the active Show filter is hiding.
   *
   * Surfaced in the status bar so a filtered view does not read as a file that
   * simply has fewer lines than it does.
   *
   * @returns {{ shown: number, hidden: number, total: number }}
   */
  getFilterCounts() {
    const total = this._diffResult?.length ?? 0
    let shown = 0
    for (const row of this._rows) {
      if (row.kind === 'line') shown++
      else if (row.kind === 'collapsed' && !row.expanded) shown += row.collapsedCount
    }
    return { shown, hidden: Math.max(0, total - shown), total }
  }

  /**
   * Update ignore/unimportant patterns and re-run diff.
   * @param {string[]} ignorePatterns
   * @param {string[]} unimportantPatterns
   */
  setIgnorePatterns(ignorePatterns, unimportantPatterns) {
    this._opts.ignorePatterns = ignorePatterns ?? []
    this._opts.unimportantPatterns = unimportantPatterns ?? []
    // S13-C05: drop stale compiled regexes — patterns may have been removed.
    this._ignoreRegexCache.clear()
    this._unimportantRegexCache.clear()
    this._runDiff()
  }

  // -------------------------------------------------------------------------
  // Public: P2-30 — manual ignore
  // -------------------------------------------------------------------------

  /**
   * Normalise an arbitrary caller-supplied list into positive integer line
   * numbers, so a stray NaN can never poison the persisted config.
   * @param {Iterable<unknown>} lines
   * @returns {number[]}
   */
  static _normaliseLines(lines) {
    /** @type {number[]} */
    const out = []
    for (const raw of lines ?? []) {
      const n = Math.trunc(Number(raw))
      if (Number.isFinite(n) && n > 0) out.push(n)
    }
    return out
  }

  /**
   * Mark file lines as manually ignored. They render as unimportant (blue),
   * and are downgraded to "equal" when Ignore Unimportant is on.
   * @param {'left' | 'right'} side
   * @param {Iterable<number>} lines 1-based file line numbers
   * @returns {number} how many marks the call actually added
   */
  markIgnoredLines(side, lines) {
    const set = side === 'right' ? this._manualIgnore.right : this._manualIgnore.left
    const before = set.size
    for (const n of TextCompare._normaliseLines(lines)) set.add(n)
    const added = set.size - before
    if (added > 0) this._runDiff()
    return added
  }

  /**
   * Remove manual ignore marks.
   * @param {'left' | 'right'} side
   * @param {Iterable<number>} lines
   * @returns {number} how many marks were removed
   */
  unmarkIgnoredLines(side, lines) {
    const set = side === 'right' ? this._manualIgnore.right : this._manualIgnore.left
    let removed = 0
    for (const n of TextCompare._normaliseLines(lines)) {
      if (set.delete(n)) removed++
    }
    if (removed > 0) this._runDiff()
    return removed
  }

  /**
   * Toggle a run of lines: mark them all unless every one is already marked,
   * in which case clear them. Matches how a single menu entry behaves in BC.
   * @param {'left' | 'right'} side
   * @param {Iterable<number>} lines
   * @returns {'marked' | 'unmarked' | 'noop'}
   */
  toggleIgnoredLines(side, lines) {
    const nums = TextCompare._normaliseLines(lines)
    if (nums.length === 0) return 'noop'
    const set = side === 'right' ? this._manualIgnore.right : this._manualIgnore.left
    const allMarked = nums.every(n => set.has(n))
    if (allMarked) {
      this.unmarkIgnoredLines(side, nums)
      return 'unmarked'
    }
    this.markIgnoredLines(side, nums)
    return 'marked'
  }

  /** Drop every manual ignore mark on both sides. @returns {number} removed */
  clearManualIgnores() {
    const removed = this._manualIgnore.left.size + this._manualIgnore.right.size
    if (removed === 0) return 0
    this._manualIgnore.left.clear()
    this._manualIgnore.right.clear()
    this._runDiff()
    return removed
  }

  /**
   * Currently marked line numbers, ascending, as plain arrays.
   * @returns {{ left: number[], right: number[] }}
   */
  getManualIgnores() {
    const asc = (a, b) => a - b
    return {
      left: [...this._manualIgnore.left].sort(asc),
      right: [...this._manualIgnore.right].sort(asc),
    }
  }

  /**
   * Human-readable summary of the manual ignores, with runs collapsed to
   * ranges ("3, 7–12"). Used by the context-menu listing.
   * @returns {string}
   */
  describeManualIgnores() {
    const { left, right } = this.getManualIgnores()
    /** @param {number[]} nums */
    const ranges = (nums) => {
      /** @type {string[]} */
      const parts = []
      for (let i = 0; i < nums.length;) {
        let j = i
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++
        parts.push(i === j ? String(nums[i]) : `${nums[i]}–${nums[j]}`)
        i = j + 1
      }
      return parts.join(', ')
    }
    if (left.length === 0 && right.length === 0) return '目前沒有手動忽略的行'
    const out = []
    if (left.length) out.push(`左側：${ranges(left)}`)
    if (right.length) out.push(`右側：${ranges(right)}`)
    return out.join('\n')
  }

  /**
   * File line numbers covered by the current DOM text selection in one pane.
   * Only rendered rows can be selected, so virtual scrolling bounds this
   * naturally.
   * @param {'left' | 'right'} side
   * @returns {number[]}
   */
  _selectedLineNumbers(side) {
    const pane = side === 'right' ? this._contentRight : this._contentLeft
    const sel = window.getSelection?.()
    if (!pane || !sel || sel.rangeCount === 0 || sel.isCollapsed) return []
    const attr = side === 'right' ? 'rightLine' : 'leftLine'
    /** @type {number[]} */
    const out = []
    for (const el of pane.querySelectorAll('.diff-line')) {
      const n = parseInt(el.dataset?.[attr] ?? '', 10)
      if (isNaN(n)) continue
      if (typeof sel.containsNode === 'function' && !sel.containsNode(el, true)) continue
      out.push(n)
    }
    return [...new Set(out)].sort((a, b) => a - b)
  }

  /**
   * Which pane holds the current selection, or null when there is none.
   * @returns {'left' | 'right' | null}
   */
  _selectionSide() {
    const sel = window.getSelection?.()
    const node = sel?.anchorNode
    if (!sel || !node || sel.isCollapsed) return null
    if (this._contentLeft?.contains?.(node)) return 'left'
    if (this._contentRight?.contains?.(node)) return 'right'
    return null
  }

  /**
   * Toggle manual ignore over the selected lines of one pane.
   * @param {'left' | 'right'} [side] defaults to wherever the selection is
   * @returns {boolean} whether anything changed
   */
  toggleIgnoreSelection(side) {
    const target = side ?? this._selectionSide()
    if (!target) {
      toast('請先在某一側選取要忽略的行', { type: 'warn' })
      return false
    }
    const lines = this._selectedLineNumbers(target)
    if (lines.length === 0) {
      toast('選取範圍內沒有可標記的行', { type: 'warn' })
      return false
    }
    const result = this.toggleIgnoredLines(target, lines)
    toast(result === 'marked'
      ? `已忽略 ${lines.length} 行`
      : `已取消忽略 ${lines.length} 行`, { type: 'success' })
    return true
  }

  // -------------------------------------------------------------------------
  // Public: P1-19 — compare selection to clipboard
  // -------------------------------------------------------------------------

  /**
   * Replace the panes with (selected text) vs (clipboard text).
   *
   * The selection keeps the side it came from so the user's mental left/right
   * mapping survives; the clipboard lands on the opposite pane.
   *
   * @param {'left' | 'right'} [side] defaults to wherever the selection is
   * @returns {Promise<boolean>} whether the comparison was opened
   */
  async compareSelectionToClipboard(side) {
    const target = side ?? this._selectionSide()
    const selection = window.getSelection?.()?.toString() ?? ''
    if (!target || selection.length === 0) {
      toast('請先選取要與剪貼簿比較的文字', { type: 'warn' })
      return false
    }

    let clip = ''
    try {
      clip = await navigator.clipboard.readText()
    } catch (err) {
      toast(`無法讀取剪貼簿：${err instanceof Error ? err.message : String(err)}`, { type: 'error' })
      return false
    }
    if (clip.length === 0) {
      toast('剪貼簿是空的', { type: 'warn' })
      return false
    }

    // Plain text on both sides — a syntax highlighter carried over from the
    // previous file would mis-colour an arbitrary fragment.
    this._hlLeft = null
    this._hlRight = null
    this._manualIgnore.left.clear()
    this._manualIgnore.right.clear()

    if (target === 'right') {
      this.setLeft('（剪貼簿）', clip)
      this.setRight('（選取內容）', selection)
    } else {
      this.setLeft('（選取內容）', selection)
      this.setRight('（剪貼簿）', clip)
    }
    return true
  }

  // -------------------------------------------------------------------------
  // Public: P2-25 — text patch viewer
  // -------------------------------------------------------------------------

  /**
   * Show a unified diff's before/after content in the two panes.
   * @param {string} patchText
   * @param {string} [label] shown in the path bars
   * @returns {PatchFile[]} the parsed patch
   * @throws {UnifiedDiffParseError} propagated so callers can report it
   */
  openPatch(patchText, label = 'patch') {
    const files = parseUnifiedDiff(patchText)
    const { oldText, newText } = buildPatchSides(files)
    this._hlLeft = null
    this._hlRight = null
    this._manualIgnore.left.clear()
    this._manualIgnore.right.clear()
    // patch:// keeps the file watcher from trying to open a synthetic path.
    this.setLeft(`patch://${label}（原始）`, oldText)
    this.setRight(`patch://${label}（套用後）`, newText)
    return files
  }

  /**
   * Prompt for a .patch/.diff file and open it in the patch viewer.
   * @returns {Promise<boolean>} whether a patch was opened
   */
  async openPatchFile() {
    const result = await window.electronAPI.openFile({
      filters: [
        { name: 'Patch', extensions: ['patch', 'diff'] },
        { name: '所有檔案', extensions: ['*'] },
      ],
    })
    if (!result) return false
    try {
      const files = this.openPatch(result.content, result.path)
      const hunks = files.reduce((n, f) => n + f.hunks.length, 0)
      toast(`已載入 patch：${files.length} 個檔案、${hunks} 個 hunk`, { type: 'success' })
      return true
    } catch (err) {
      toast(err instanceof UnifiedDiffParseError
        ? `Patch 格式錯誤：${err.message}`
        : `無法開啟 patch：${err instanceof Error ? err.message : String(err)}`,
      { type: 'error', durationMs: 8000 })
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Public: modal helper
  //
  // A native <dialog> rather than markup in index.html: these three commands
  // are owned by this view, and a dialog it builds itself cannot be left
  // half-wired in a template the view does not control.
  // -------------------------------------------------------------------------

  /**
   * @param {{
   *   title: string,
   *   hint?: string,
   *   build: (body: HTMLElement) => void,
   *   confirmLabel?: string,
   *   onConfirm: () => boolean|void,
   * }} spec
   * @returns {HTMLDialogElement}
   */
  _openDialog(spec) {
    const dlg = /** @type {HTMLDialogElement} */ (document.createElement('dialog'));
    dlg.className = 'tc-dialog';
    // Set here rather than in a stylesheet: this view's styles live in
    // main.css, which is shared, and a <dialog> with no rules at all inherits
    // the UA's white canvas — unreadable under the dark theme.
    Object.assign(dlg.style, {
      maxWidth: 'min(680px, 90vw)',
      maxHeight: '80vh',
      overflow: 'auto',
      padding: '14px',
      border: '1px solid var(--border-color, #ccc)',
      borderRadius: '6px',
      background: 'var(--bg-primary, #fff)',
      color: 'var(--text-primary, #222)',
      fontSize: '13px',
    });

    const h = document.createElement('h3');
    h.textContent = spec.title;
    dlg.appendChild(h);

    if (spec.hint) {
      const p = document.createElement('p');
      p.textContent = spec.hint;
      dlg.appendChild(p);
    }

    const body = document.createElement('div');
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '6px';
    spec.build(body);
    dlg.appendChild(body);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    actions.style.justifyContent = 'flex-end';
    actions.style.marginTop = '10px';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = spec.confirmLabel ?? '套用';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    actions.append(ok, cancel);
    dlg.appendChild(actions);

    const close = () => {
      // close() throws on a dialog that was opened by attribute rather than
      // showModal(), which is the path taken where showModal is unavailable.
      if (typeof dlg.close === 'function' && dlg.open) dlg.close();
      dlg.remove();
    };
    ok.addEventListener('click', () => { if (spec.onConfirm() !== false) close(); });
    cancel.addEventListener('click', close);
    dlg.addEventListener('cancel', close);

    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    return dlg;
  }

  // -------------------------------------------------------------------------
  // Public: 1.7 — Text Replacements
  // -------------------------------------------------------------------------

  /**
   * Replace the whole rule set.
   *
   * @param {ReplacementRule[]} rules
   * @returns {string[]} compile errors; the accepted rules still take effect
   */
  setReplacements(rules) {
    const list = Array.isArray(rules) ? rules.slice(0, MAX_REPLACEMENT_RULES) : [];
    const { compiled, errors } = compileReplacementRules(list);
    this._replacements = list;
    this._replacementsCompiled = compiled;
    if (this._leftContent || this._rightContent) this._runDiff();
    return errors;
  }

  /** @returns {ReplacementRule[]} */
  getReplacements() {
    return this._replacements.map((r) => ({ ...r }));
  }

  /** Edit the replacement rules. */
  openReplacementsDialog() {
    let textarea = null;
    let errorBox = null;
    this._openDialog({
      title: '文字取代規則（比對前套用）',
      hint: '每行一條：「比對 => 取代」。前綴 re: 視為正規表示式、i: 不分大小寫、rei: 兩者皆是；# 開頭為註解。'
        + '兩側只在比對時改寫，畫面與存檔仍是原始內容。',
      build: (body) => {
        textarea = document.createElement('textarea');
        textarea.className = 'tc-dialog-textarea';
        textarea.spellcheck = false;
        textarea.rows = 10;
        textarea.style.fontFamily = 'var(--font-mono, monospace)';
        textarea.style.whiteSpace = 'pre';
        textarea.value = formatReplacementRules(this._replacements);
        body.appendChild(textarea);
        errorBox = document.createElement('div');
        errorBox.className = 'tc-dialog-errors';
        errorBox.style.whiteSpace = 'pre-wrap';
        errorBox.style.color = 'var(--diff-delete-fg, #b91c1c)';
        body.appendChild(errorBox);
      },
      onConfirm: () => {
        const { rules, errors } = parseReplacementRules(textarea?.value ?? '');
        const compileErrors = this.setReplacements(rules);
        const all = [...errors, ...compileErrors];
        if (all.length > 0) {
          // Kept open with the reasons visible: closing on a rejected rule
          // would leave the user believing it is running.
          if (errorBox) errorBox.textContent = all.join('\n');
          toast(`有 ${all.length} 條規則未套用`, { type: 'error', durationMs: 6000 });
          return false;
        }
        toast(rules.length > 0 ? `已套用 ${rules.length} 條取代規則` : '已清除所有取代規則',
          { type: 'success' });
        return true;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Public: P2-48 — Text Compare Info
  // -------------------------------------------------------------------------

  /**
   * Everything BC's "Text Compare Info" dialog reports, as data.
   *
   * Split from the dialog so the numbers can be asserted without a DOM, and
   * so the report writer can reuse them later.
   *
   * @returns {{
   *   left: { path: string, bytes: number, chars: number, lines: number,
   *           encoding: string, eol: string, format: string, readOnly: boolean },
   *   right: { path: string, bytes: number, chars: number, lines: number,
   *            encoding: string, eol: string, format: string, readOnly: boolean },
   *   diff: { equal: number, insert: number, delete: number, replace: number,
   *           unimportant: number, blocks: number },
   * }}
   */
  getCompareInfo() {
    const enc = new TextEncoder();
    /** @param {'left'|'right'} side */
    const describe = (side) => {
      const content = (side === 'left' ? this._leftContent : this._rightContent) ?? '';
      return {
        path: (side === 'left' ? this._leftPath : this._rightPath) || '',
        bytes: enc.encode(content).length,
        chars: content.length,
        lines: content ? splitLinesKeepEol(content).length : 0,
        encoding: side === 'left' ? this._encodingLeft : this._encodingRight,
        eol: side === 'left' ? this._eolLeft : this._eolRight,
        format: (side === 'left' ? this._grammarLeft : this._grammarRight)?.name ?? '—',
        readOnly: this.isSideReadOnly(side),
      };
    };
    const diff = { equal: 0, insert: 0, delete: 0, replace: 0, unimportant: 0,
      blocks: this._diffBlocks.length };
    for (const dl of this._diffResult) {
      if (dl.type in diff) diff[dl.type]++;
      if (dl.unimportant) diff.unimportant++;
    }
    return { left: describe('left'), right: describe('right'), diff };
  }

  /** Show the statistics dialog. */
  openInfoDialog() {
    const info = this.getCompareInfo();
    this._openDialog({
      title: '文字比對資訊',
      confirmLabel: '關閉',
      build: (body) => {
        const table = document.createElement('table');
        table.style.borderCollapse = 'collapse';
        table.style.width = '100%';
        /**
         * @param {string} label
         * @param {string} a
         * @param {string} b
         * @param {boolean} [head]
         */
        const row = (label, a, b, head = false) => {
          const tr = document.createElement('tr');
          for (const [text, align] of /** @type {Array<[string, string]>} */ (
            [[label, 'left'], [a, 'right'], [b, 'right']])) {
            const cell = document.createElement(head ? 'th' : 'td');
            cell.textContent = text;
            cell.style.textAlign = head ? 'center' : align;
            cell.style.padding = '2px 8px';
            cell.style.borderBottom = '1px solid var(--border-color, #ddd)';
            tr.appendChild(cell);
          }
          table.appendChild(tr);
        };
        row('', '左', '右', true);
        row('路徑', info.left.path || '（貼上）', info.right.path || '（貼上）');
        row('行數', String(info.left.lines), String(info.right.lines));
        row('字元數', String(info.left.chars), String(info.right.chars));
        row('位元組', formatBytes(info.left.bytes), formatBytes(info.right.bytes));
        row('編碼', info.left.encoding, info.right.encoding);
        row('行尾符號', info.left.eol, info.right.eol);
        row('檔案格式', info.left.format, info.right.format);
        row('唯讀', info.left.readOnly ? '是' : '否', info.right.readOnly ? '是' : '否');
        body.appendChild(table);

        const stats = document.createElement('div');
        stats.style.marginTop = '8px';
        stats.textContent = `差異區塊 ${info.diff.blocks}　`
          + `相同 ${info.diff.equal} 行　變更 ${info.diff.replace} 行　`
          + `僅左側 ${info.diff.delete} 行　僅右側 ${info.diff.insert} 行　`
          + `不重要 ${info.diff.unimportant} 行`;
        body.appendChild(stats);
      },
      onConfirm: () => true,
    });
  }

  // -------------------------------------------------------------------------
  // Public: P2-58 — file format selection
  // -------------------------------------------------------------------------

  /** Pick the file format for each side by hand. */
  openFileFormatDialog() {
    const names = this.listFileFormats();
    /** @type {HTMLSelectElement|null} */ let selLeft = null;
    /** @type {HTMLSelectElement|null} */ let selRight = null;
    /**
     * @param {'left'|'right'} side
     * @param {HTMLElement} body
     */
    const buildSelect = (side, body) => {
      const label = document.createElement('label');
      label.textContent = side === 'left' ? '左側格式：' : '右側格式：';
      const sel = document.createElement('select');
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = '（依副檔名自動判斷）';
      sel.appendChild(auto);
      if (side === 'right') {
        const same = document.createElement('option');
        same.value = 'same-as-left';
        same.textContent = '同左側';
        sel.appendChild(same);
      }
      for (const name of names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
      sel.value = this._formatOverride[side] ?? '';
      label.appendChild(sel);
      body.appendChild(label);
      return sel;
    };
    this._openDialog({
      title: '檔案格式',
      hint: '格式決定文法著色、可忽略的元素與對齊權重。留在「自動判斷」時以副檔名決定。',
      build: (body) => {
        selLeft = buildSelect('left', body);
        selRight = buildSelect('right', body);
      },
      onConfirm: () => {
        this.setFileFormat('left', selLeft?.value || null);
        this.setFileFormat('right', selRight?.value || null);
        const info = this.getGrammarInfo();
        toast(`格式：${info.left ?? '（無）'} / ${info.right ?? '（無）'}`, { type: 'success' });
        return true;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Public: P2-55 — unimportant text list
  // -------------------------------------------------------------------------

  /**
   * BC manages unimportant text as a list of rules that can be added and
   * removed one at a time, not as a free-text blob — a single malformed line
   * in a blob silently takes the whole set with it.
   */
  openUnimportantTextDialog() {
    /** @type {HTMLElement|null} */ let listEl = null;
    /** @type {string[]} */ const draft = [...this._opts.unimportantPatterns];
    /** @type {HTMLElement|null} */ let errorBox = null;

    const redraw = () => {
      if (!listEl) return;
      listEl.replaceChildren();
      if (draft.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = '（尚無規則：所有差異都算重要）';
        empty.style.opacity = '0.7';
        listEl.appendChild(empty);
        return;
      }
      draft.forEach((pattern, idx) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '6px';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = pattern;
        input.style.flex = '1';
        input.spellcheck = false;
        input.addEventListener('input', () => { draft[idx] = input.value; });
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '刪除';
        del.addEventListener('click', () => { draft.splice(idx, 1); redraw(); });
        row.append(input, del);
        listEl.appendChild(row);
      });
    };

    this._openDialog({
      title: '不重要文字規則',
      hint: '每條為一個正規表示式。符合的差異行以藍色標示；搭配「忽略不重要差異」可完全視為相同。',
      build: (body) => {
        listEl = document.createElement('div');
        listEl.style.display = 'flex';
        listEl.style.flexDirection = 'column';
        listEl.style.gap = '4px';
        body.appendChild(listEl);
        const add = document.createElement('button');
        add.type = 'button';
        add.textContent = '新增規則';
        add.style.alignSelf = 'flex-start';
        add.addEventListener('click', () => { draft.push(''); redraw(); });
        body.appendChild(add);
        errorBox = document.createElement('div');
        errorBox.style.whiteSpace = 'pre-wrap';
        errorBox.style.color = 'var(--diff-delete-fg, #b91c1c)';
        body.appendChild(errorBox);
        redraw();
      },
      onConfirm: () => {
        const kept = draft.map((p) => p.trim()).filter((p) => p.length > 0);
        /** @type {string[]} */
        const bad = [];
        for (const p of kept) {
          try { new RegExp(p); } catch (err) {
            bad.push(`${p} — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (bad.length > 0) {
          // Left open with the reasons on screen: a rule the user believes is
          // running but which never compiled is the worst outcome here.
          if (errorBox) errorBox.textContent = bad.join('\n');
          toast(`有 ${bad.length} 條規則無法編譯`, { type: 'error', durationMs: 6000 });
          return false;
        }
        this.setIgnorePatterns(this._opts.ignorePatterns, kept);
        toast(kept.length > 0 ? `已套用 ${kept.length} 條不重要文字規則` : '已清除不重要文字規則',
          { type: 'success' });
        return true;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Public: P2-59 / P2-60 — alignment dialog
  // -------------------------------------------------------------------------

  /** BC's Alignment tab: never-align patterns, skew tolerance, closeness. */
  openAlignmentDialog() {
    /** @type {HTMLTextAreaElement|null} */ let patternsEl = null;
    /** @type {HTMLInputElement|null} */ let skewEl = null;
    /** @type {HTMLInputElement|null} */ let closeEl = null;
    /** @type {HTMLInputElement|null} */ let thresholdEl = null;
    /** @type {HTMLElement|null} */ let errorBox = null;
    /** @type {HTMLInputElement[]} */ const modeEls = [];

    this._openDialog({
      title: '對齊選項',
      hint: '「永不對齊」的行只會以單側形式出現，不會與另一側配成一列。'
        + '偏移上限為 0 時不限制。相似度配對以相似度而非位置決定配對對象。',
      build: (body) => {
        const modeSet = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = '對齊模式';
        modeSet.appendChild(legend);
        /** @type {Array<[import('../core/diff-engine.js').AlignmentMode, string]>} */
        const modes = [
          ['standard', '標準對齊（依演算法配對兩側的行）'],
          ['unaligned', '不對齊（左右各第 N 行直接並排，不做內容比對配對）'],
          ['never', '永不對齊差異（差異一律顯示為刪除區塊 + 新增區塊）'],
        ];
        for (const [value, label] of modes) {
          const row = document.createElement('label');
          row.style.display = 'block';
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'tc-align-mode';
          radio.value = value;
          radio.checked = this._opts.alignMode === value;
          modeEls.push(radio);
          row.append(radio, document.createTextNode(' ' + label));
          modeSet.appendChild(row);
        }
        body.appendChild(modeSet);

        const note = document.createElement('div');
        note.textContent = '下列選項只在「標準對齊」下生效。';
        body.appendChild(note);

        const counts = this.getUnalignedLineCounts();
        const summary = document.createElement('div');
        summary.textContent = `目前有 ${counts.left} 行（左）／${counts.right} 行（右）被排除在對齊之外。`;
        body.appendChild(summary);

        const lbl = document.createElement('label');
        lbl.textContent = '永不對齊這些行（每行一個正規表示式）：';
        body.appendChild(lbl);
        patternsEl = document.createElement('textarea');
        patternsEl.rows = 5;
        patternsEl.spellcheck = false;
        patternsEl.style.fontFamily = 'var(--font-mono, monospace)';
        patternsEl.value = this._opts.neverAlignPatterns.join('\n');
        body.appendChild(patternsEl);

        const skewLabel = document.createElement('label');
        skewLabel.textContent = '偏移上限（0 = 不限制）：';
        skewEl = document.createElement('input');
        skewEl.type = 'number';
        skewEl.min = '0';
        skewEl.max = '1000';
        skewEl.value = String(this._opts.skewTolerance);
        skewLabel.appendChild(skewEl);
        body.appendChild(skewLabel);

        const closeLabel = document.createElement('label');
        closeEl = document.createElement('input');
        closeEl.type = 'checkbox';
        closeEl.checked = this._opts.useClosenessMatching;
        closeLabel.append(closeEl, document.createTextNode(' 以相似度配對（closeness matching）'));
        body.appendChild(closeLabel);

        const thLabel = document.createElement('label');
        thLabel.textContent = '相似度門檻（0–1）：';
        thresholdEl = document.createElement('input');
        thresholdEl.type = 'number';
        thresholdEl.min = '0';
        thresholdEl.max = '1';
        thresholdEl.step = '0.05';
        thresholdEl.value = String(this._opts.closenessThreshold);
        thLabel.appendChild(thresholdEl);
        body.appendChild(thLabel);

        errorBox = document.createElement('div');
        errorBox.style.whiteSpace = 'pre-wrap';
        errorBox.style.color = 'var(--diff-delete-fg, #b91c1c)';
        body.appendChild(errorBox);
      },
      onConfirm: () => {
        const patterns = (patternsEl?.value ?? '').split('\n')
          .map((s) => s.trim()).filter((s) => s.length > 0);
        this.setAlignmentMode(modeEls.find((r) => r.checked)?.value ?? 'standard');
        this.setSkewTolerance(Number(skewEl?.value ?? 0));
        this.setClosenessMatching(closeEl?.checked === true, Number(thresholdEl?.value));
        const bad = this.setNeverAlignPatterns(patterns);
        if (bad.length > 0) {
          if (errorBox) errorBox.textContent = `無法編譯：\n${bad.join('\n')}`;
          toast(`有 ${bad.length} 條樣式無法編譯，其餘已套用`, { type: 'error', durationMs: 6000 });
          return false;
        }
        toast('已套用對齊選項', { type: 'success' });
        return true;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Public: 1.2 — Merge Files (hand off to a 3-way merge session)
  // -------------------------------------------------------------------------

  /**
   * BC's Merge Files: continue this two-file comparison as a three-way merge.
   *
   * The host owns tabs and views, so this can only ask. With no listener the
   * command reports that rather than appearing to work.
   *
   * @param {{ basePath?: string, baseContent?: string }} [base]
   * @returns {boolean} whether the request was handed off
   */
  mergeFiles(base = {}) {
    if (!this._leftContent && !this._rightContent) {
      toast('請先載入要合併的檔案', { type: 'error' });
      return false;
    }
    if (!this._listeners.get('merge-files')?.size) {
      toast('主視窗未接上「轉為三向合併」，無法開啟合併工作階段', { type: 'error', durationMs: 6000 });
      return false;
    }
    this._emit('merge-files', {
      left:  { path: this._leftPath,  content: this._leftContent },
      base:  { path: base.basePath ?? '', content: base.baseContent ?? '' },
      right: { path: this._rightPath, content: this._rightContent },
    });
    return true;
  }

  /**
   * Pick a common ancestor, then hand off.
   * @returns {Promise<boolean>}
   */
  async mergeFilesWithBase() {
    let result;
    try {
      result = await window.electronAPI.openFile();
    } catch (err) {
      toast(`選擇基準檔失敗：${err instanceof Error ? err.message : String(err)}`, { type: 'error' });
      return false;
    }
    if (!result) return false;
    return this.mergeFiles({ basePath: result.path, baseContent: result.content });
  }

  // -------------------------------------------------------------------------
  // Public: 1.1 — open one file out of an archive
  // -------------------------------------------------------------------------

  /**
   * Load a single member of an archive into one pane.
   *
   * The pane keeps the `archive::entry` virtual path, which is the form every
   * other reader in the app already understands, so a later reload or reveal
   * routes itself.
   *
   * @param {'left'|'right'} side
   * @returns {Promise<boolean>} whether a file was loaded
   */
  async openFromArchive(side) {
    let chosen;
    try {
      // openFileBinary rather than openFile: the archive's *bytes* are of no
      // use here, only its path, and this is the dialog that also registers
      // the file as a readable root for the readArchive call below. maxBytes
      // keeps it from slurping a gigabyte to throw it away.
      chosen = await window.electronAPI.openFileBinary({
        filters: ARCHIVE_DIALOG_FILTERS,
        maxBytes: 1,
      });
    } catch (err) {
      toast(`選擇封存檔失敗：${err instanceof Error ? err.message : String(err)}`, { type: 'error' });
      return false;
    }
    if (!chosen?.path) return false;
    return this.openArchiveEntry(side, chosen.path);
  }

  /**
   * List an archive and load the member the user picks.
   *
   * @param {'left'|'right'} side
   * @param {string} archivePath
   * @returns {Promise<boolean>}
   */
  async openArchiveEntry(side, archivePath) {
    let listing;
    try {
      listing = await window.electronAPI.readArchive(archivePath);
    } catch (err) {
      toast(`無法讀取封存檔：${err instanceof Error ? err.message : String(err)}`,
        { type: 'error', durationMs: 8000 });
      return false;
    }

    const files = (listing?.entries ?? []).filter((e) => e && !e.isDirectory);
    if (files.length === 0) {
      toast('這個封存檔裡沒有檔案', { type: 'error' });
      return false;
    }

    // Entry paths come back as `archive::relative`; the relative half is what
    // the picker shows and what readArchiveEntry wants.
    const relOf = (p) => {
      const s = String(p ?? '');
      const i = s.indexOf('::');
      return i >= 0 ? s.slice(i + 2) : s;
    };

    return new Promise((resolve) => {
      let select = null;
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };

      const dlg = this._openDialog({
        title: `從封存檔載入到${side === 'left' ? '左' : '右'}側`,
        hint: `${archivePath}（${files.length} 個檔案）`,
        confirmLabel: '載入',
        build: (body) => {
          select = document.createElement('select');
          select.className = 'tc-dialog-list';
          select.size = Math.min(14, Math.max(4, files.length));
          for (const entry of files) {
            const opt = document.createElement('option');
            opt.value = relOf(entry.path);
            opt.textContent = `${relOf(entry.path)}　(${entry.size} bytes)`;
            select.appendChild(opt);
          }
          select.selectedIndex = 0;
          body.appendChild(select);
        },
        onConfirm: () => {
          const entry = select?.value ?? '';
          if (!entry) { toast('請先選一個檔案', { type: 'error' }); return false; }
          void this._loadArchiveEntry(side, archivePath, entry).then(done);
          return true;
        },
      });
      dlg.addEventListener('cancel', () => done(false));
    });
  }

  /**
   * @param {'left'|'right'} side
   * @param {string} archivePath
   * @param {string} entryPath
   * @returns {Promise<boolean>}
   */
  async _loadArchiveEntry(side, archivePath, entryPath) {
    try {
      const base64 = await window.electronAPI.readArchiveEntry(archivePath, entryPath);
      const binary = atob(String(base64 ?? ''));
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      // Archive members carry no encoding declaration; UTF-8 is the only
      // defensible default, and the per-side "reload with encoding" command
      // is the escape hatch when it is wrong.
      const content = new TextDecoder('utf-8').decode(bytes);
      const virtualPath = `${archivePath}::${entryPath}`;
      if (side === 'left') this.setLeft(virtualPath, content, 'UTF-8');
      else this.setRight(virtualPath, content, 'UTF-8');
      toast(`已載入 ${entryPath}`, { type: 'success' });
      return true;
    } catch (err) {
      toast(`無法取出 ${entryPath}：${err instanceof Error ? err.message : String(err)}`,
        { type: 'error', durationMs: 8000 });
      return false;
    }
  }

  /**
   * Return the current view settings as a plain JSON-serialisable object.
   * Used by T61 Session Settings Dialog to persist a snapshot under a name.
   * @returns {Record<string, unknown>}
   */
  getConfig() {
    return tagConfig('text', {
      algorithm:          this._opts.algorithm,
      ignoreWhitespace:   this._opts.ignoreWhitespace,
      ignoreCase:         this._opts.ignoreCase,
      ignoreLineEndings:  this._opts.ignoreLineEndings,
      contextLines:       this._opts.contextLines,
      ignoreUnimportant:  this._opts.ignoreUnimportant,
      alignByGrammar:     this._opts.alignByGrammar,
      // P2-52…P2-60
      whitespaceMode:      this.getWhitespaceMode(),
      syntaxHighlight:     this._syntaxHighlight,
      webpageMode:         this.isWebpageMode(),
      orphansAlwaysImportant: this._opts.orphansAlwaysImportant,
      neverAlignPatterns:  [...this._opts.neverAlignPatterns],
      // 1.7 Alignment tab + 1.9 Text options page.
      alignMode:           this._opts.alignMode,
      autoIndent:          this._editorOpts.autoIndent,
      backspaceUnindents:  this._editorOpts.backspaceUnindents,
      allowBeyondEol:      this._editorOpts.allowBeyondEol,
      showFilteredLineCounts: this._showFilteredLineCounts,
      skewTolerance:       this._opts.skewTolerance,
      useClosenessMatching:this._opts.useClosenessMatching,
      closenessThreshold:  this._opts.closenessThreshold,
      fileFormatLeft:      this._formatOverride.left,
      fileFormatRight:     this._formatOverride.right,
      ignorePatterns:     Array.isArray(this._opts.ignorePatterns) ? [...this._opts.ignorePatterns] : [],
      unimportantPatterns:Array.isArray(this._opts.unimportantPatterns) ? [...this._opts.unimportantPatterns] : [],
      manualIgnoreLeft:   [...this._manualIgnore.left].sort((a, b) => a - b),
      manualIgnoreRight:  [...this._manualIgnore.right].sort((a, b) => a - b),
      // P2-29 / P3: grammar + panel state travel with the session settings.
      grammarIgnore:      [...this._grammarIgnored],
      userGrammars:       getUserGrammars(),
      description:        this._description,
      fontFamily:         this._fontFamily,
      showRuler:          this._showRuler,
      showFileInfo:       this._showFileInfo,
      showDescription:    this._showDescription,
      detailsMode:        this._detailsMode,
      showThumbnail:      this._showMinimap,
      readOnlyLeft:       this._readOnly.left,
      readOnlyRight:      this._readOnly.right,
      // 1.4: manual alignment and the indent step are per-session choices.
      alignAnchors:       this.getAlignAnchors(),
      tabWidth:           this._tabWidth,
      indentWithTabs:     this._indentWithTabs,
      // 1.7: the replacement pairs are a comparison setting, so they belong in
      // a named config exactly like the ignore patterns do.
      replacements:       this.getReplacements(),
    })
  }

  /**
   * Apply a previously captured settings snapshot.
   * Unknown keys are ignored. Triggers a diff re-run if content is loaded.
   * @param {unknown} cfg
   */
  applyConfig(cfg) {
    const settings = readConfig('text', cfg)
    if (!settings) return
    const known = ['algorithm','ignoreWhitespace','ignoreCase','ignoreLineEndings','contextLines','ignorePatterns','unimportantPatterns','ignoreUnimportant','alignByGrammar']
    for (const key of known) {
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        const value = settings[key]
        if ((key === 'ignorePatterns' || key === 'unimportantPatterns')) {
          this._opts[key] = Array.isArray(value) ? [...value] : []
        } else {
          this._opts[key] = value
        }
      }
    }
    // P2-30: manual marks live outside _opts (they are per-file state, not
    // diff options), so they are restored separately.
    for (const [key, set] of /** @type {Array<[string, Set<number>]>} */ ([
      ['manualIgnoreLeft', this._manualIgnore.left],
      ['manualIgnoreRight', this._manualIgnore.right],
    ])) {
      if (!Object.prototype.hasOwnProperty.call(settings, key)) continue
      set.clear()
      const value = settings[key]
      for (const n of TextCompare._normaliseLines(Array.isArray(value) ? value : [])) set.add(n)
    }

    // 1.4: alignment anchors are validated against the current files, so a
    // snapshot taken on different content cannot produce a crossing pair.
    if (Object.prototype.hasOwnProperty.call(settings, 'alignAnchors')) {
      this._alignAnchors = normaliseAnchors(
        settings.alignAnchors,
        splitLinesKeepEol(this._leftContent).length,
        splitLinesKeepEol(this._rightContent).length,
      )
    }
    if (Array.isArray(settings.replacements)) {
      // Compiled here rather than at diff time so a snapshot carrying a
      // rejected pattern says so once, instead of failing silently per re-diff.
      const errs = compileReplacementRules(settings.replacements).errors
      this._replacements = settings.replacements.slice(0, MAX_REPLACEMENT_RULES)
      this._replacementsCompiled = compileReplacementRules(this._replacements).compiled
      if (errs.length > 0) toast(`部分取代規則無法載入：${errs.join('；')}`, { type: 'error', durationMs: 6000 })
    }
    // P2-52…P2-60. Assigned rather than routed through the setters so a
    // snapshot costs one re-diff at the end, not one per option.
    if (typeof settings.syntaxHighlight === 'boolean') this._syntaxHighlight = settings.syntaxHighlight
    // Routed through the setter, which refuses when neither side is markup —
    // a stored `true` must not leave two blank frames over a plain text file.
    if (typeof settings.webpageMode === 'boolean') this.setWebpageMode(settings.webpageMode)
    if (typeof settings.orphansAlwaysImportant === 'boolean') {
      this._opts.orphansAlwaysImportant = settings.orphansAlwaysImportant
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'alignMode')) {
      this._opts.alignMode = normaliseAlignmentMode(settings.alignMode)
    }
    for (const key of /** @type {Array<'autoIndent'|'backspaceUnindents'|'allowBeyondEol'>} */ (
      ['autoIndent', 'backspaceUnindents', 'allowBeyondEol'])) {
      if (typeof settings[key] === 'boolean') this._editorOpts[key] = settings[key]
    }
    if (typeof settings.showFilteredLineCounts === 'boolean') {
      this._showFilteredLineCounts = settings.showFilteredLineCounts
    }
    if (Number.isFinite(settings.skewTolerance)) {
      this._opts.skewTolerance = Math.max(0, Math.min(1000, Math.round(Number(settings.skewTolerance))))
    }
    if (typeof settings.useClosenessMatching === 'boolean') {
      this._opts.useClosenessMatching = settings.useClosenessMatching
    }
    if (Number.isFinite(settings.closenessThreshold)) {
      this._opts.closenessThreshold = Math.max(0, Math.min(1, Number(settings.closenessThreshold)))
    }
    if (Array.isArray(settings.neverAlignPatterns)) {
      const bad = this.setNeverAlignPatterns(settings.neverAlignPatterns)
      if (bad.length > 0) toast(`部分「永不對齊」樣式無法載入：${bad.join('；')}`, { type: 'error', durationMs: 6000 })
    }
    if (typeof settings.whitespaceMode === 'string') this.setWhitespaceMode(settings.whitespaceMode)
    for (const side of /** @type {Array<'left'|'right'>} */ (['left', 'right'])) {
      const key = side === 'left' ? 'fileFormatLeft' : 'fileFormatRight'
      if (!Object.prototype.hasOwnProperty.call(settings, key)) continue
      const name = settings[key]
      this._formatOverride[side] = typeof name === 'string' && name ? name : null
    }
    this._resolveGrammars()

    if (Number.isInteger(settings.tabWidth)) this.setTabWidth(settings.tabWidth)
    if (typeof settings.indentWithTabs === 'boolean') this._indentWithTabs = settings.indentWithTabs

    // P2-29: restore user grammars before the ignore set, so an element that
    // only a user grammar defines is still meaningful.
    if (Object.prototype.hasOwnProperty.call(settings, 'userGrammars')) {
      const errs = setUserGrammars(settings.userGrammars)
      if (errs.length > 0) toast(`部分自訂文法無法載入：${errs.join('；')}`, { type: 'error', durationMs: 6000 })
      this._resolveGrammars()
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'grammarIgnore')) {
      const list = Array.isArray(settings.grammarIgnore) ? settings.grammarIgnore : []
      this._grammarIgnored = new Set(list.filter(e => typeof e === 'string' && e))
    }

    // P3 panels. Each toggle builds or removes its own DOM, so they are only
    // touched when the snapshot actually carries the key.
    if (typeof settings.description === 'string') this.setDescription(settings.description)
    if (typeof settings.fontFamily === 'string') this.setFontFamily(settings.fontFamily)
    if (typeof settings.readOnlyLeft === 'boolean') this.setSideReadOnly('left', settings.readOnlyLeft)
    if (typeof settings.readOnlyRight === 'boolean') this.setSideReadOnly('right', settings.readOnlyRight)
    if (typeof settings.showRuler === 'boolean' && settings.showRuler !== this._showRuler) this.toggleRuler(settings.showRuler)
    if (typeof settings.showFileInfo === 'boolean' && settings.showFileInfo !== this._showFileInfo) this.toggleFileInfo(settings.showFileInfo)
    if (typeof settings.showDescription === 'boolean' && settings.showDescription !== this._showDescription) {
      this.toggleDescription(settings.showDescription)
      this.setDescription(this._description)
    }
    if (typeof settings.showThumbnail === 'boolean') this.setThumbnailVisible(settings.showThumbnail)
    if (settings.detailsMode === null || typeof settings.detailsMode === 'string') {
      this.setDetailsMode(/** @type {'text'|'hex'|'alignment'|null} */ (settings.detailsMode ?? null))
    }

    if (this._leftContent || this._rightContent) {
      this._runDiff()
    }
  }

  /**
   * Transform flat DiffLine[] into _rows[], collapsing long equal runs.
   * Applies the current _showFilter ('all' | 'diff' | 'same' | 'none').
   */
  _buildRows() {
    const filter = this._showFilter;

    // T46: 'none' — no rows
    if (filter === 'none') {
      this._rows = [];
      this._maxLineChars = 0;
      return;
    }

    // T46: 'same' — only equal lines (flat, no context collapse)
    if (filter === 'same') {
      this._rows = [];
      this._maxLineChars = 0;
      for (const line of this._diffResult) {
        if (line.type === 'equal') {
          this._rows.push({ kind: 'line', diffLine: line });
          const c = (line.leftText ?? '').replace(/[\r\n]+$/, '').length;
          if (c > this._maxLineChars) this._maxLineChars = c;
        }
      }
      return;
    }

    // T46: 'diff' — diff lines plus contextLines context around them
    if (filter === 'diff') {
      const ctx = this._opts.contextLines;
      const dl = this._diffResult;
      this._rows = [];
      this._maxLineChars = 0;

      // Mark which indices are within `ctx` lines of a diff line
      const isDiff = dl.map(l => l.type !== 'equal');
      const include = new Array(dl.length).fill(false);
      for (let i = 0; i < dl.length; i++) {
        if (isDiff[i]) {
          for (let j = Math.max(0, i - ctx); j <= Math.min(dl.length - 1, i + ctx); j++) {
            include[j] = true;
          }
        }
      }

      for (let i = 0; i < dl.length; i++) {
        if (!include[i]) continue;
        this._rows.push({ kind: 'line', diffLine: dl[i] });
        const chars = Math.max(
          (dl[i].leftText ?? '').replace(/[\r\n]+$/, '').length,
          (dl[i].rightText ?? '').replace(/[\r\n]+$/, '').length,
        );
        if (chars > this._maxLineChars) this._maxLineChars = chars;
      }
      return;
    }

    // Default: 'all' — standard context-collapse rendering
    const ctx = this._opts.contextLines;
    const dl = this._diffResult;
    this._rows = [];
    this._maxLineChars = 0;

    let i = 0;
    while (i < dl.length) {
      const line = dl[i];

      if (line.type !== 'equal') {
        this._rows.push({ kind: 'line', diffLine: line });
        const chars = Math.max(
          (line.leftText ?? '').replace(/[\r\n]+$/, '').length,
          (line.rightText ?? '').replace(/[\r\n]+$/, '').length,
        );
        if (chars > this._maxLineChars) this._maxLineChars = chars;
        i++;
        continue;
      }

      // Collect the full run of equal lines
      const runStart = i;
      while (i < dl.length && dl[i].type === 'equal') i++;
      const runEnd = i; // exclusive

      const runLen = runEnd - runStart;

      // Determine whether we're at the very start or end of the diff output
      const isFirst = runStart === 0;
      const isLast  = runEnd === dl.length;

      if (runLen <= ctx * 2) {
        // Short run — emit all as normal lines
        for (let j = runStart; j < runEnd; j++) {
          this._rows.push({ kind: 'line', diffLine: dl[j] });
          const c = (dl[j].leftText ?? '').replace(/[\r\n]+$/, '').length;
          if (c > this._maxLineChars) this._maxLineChars = c;
        }
        continue;
      }

      // Emit leading context
      const leadCtx = isFirst ? Math.min(ctx, runLen) : ctx;
      for (let j = runStart; j < runStart + leadCtx; j++) {
        this._rows.push({ kind: 'line', diffLine: dl[j] });
      }

      // Emit collapsed placeholder
      const collapseStart = runStart + leadCtx;
      const trailCtx = isLast ? 0 : ctx;
      const collapseEnd = runEnd - trailCtx - 1; // inclusive

      if (collapseEnd >= collapseStart) {
        const count = collapseEnd - collapseStart + 1;
        const key = `${collapseStart}:${collapseEnd}`;
        // A run the user expanded stays expanded, but keeps a header row so it
        // can be collapsed again. Expansion used to overwrite the placeholder
        // outright, making the fold one-way.
        this._rows.push({
          kind: 'collapsed',
          expandStart: collapseStart,
          expandEnd: collapseEnd,
          collapsedCount: count,
          expanded: this._expandedRuns.has(key),
        });
        if (this._expandedRuns.has(key)) {
          for (let j = collapseStart; j <= collapseEnd; j++) {
            this._rows.push({ kind: 'line', diffLine: dl[j] });
            const c = (dl[j].leftText ?? '').replace(/[\r\n]+$/, '').length;
            if (c > this._maxLineChars) this._maxLineChars = c;
          }
        }
      }

      // Emit trailing context
      for (let j = runEnd - trailCtx; j < runEnd; j++) {
        this._rows.push({ kind: 'line', diffLine: dl[j] });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: render
  // -------------------------------------------------------------------------

  /**
   * Re-render both panes using virtual scrolling.
   *
   * Scroll position is preserved by default. Expanding a collapsed block or
   * changing font size / whitespace / show-filter used to snap the user back
   * to line 0, which made it impossible to read what had just been expanded.
   * Only a genuinely new document should reset the viewport.
   *
   * @param {{ resetScroll?: boolean }} [opts]
   */
  _render({ resetScroll = false } = {}) {
    const prevScrollTop = this._contentLeft?.scrollTop ?? 0;
    const prevScrollLeft = this._contentLeft?.scrollLeft ?? 0;
    this._totalRows = this._rows.length;

    // Build spacers so scroll range reflects real content height
    const totalH = this._totalRows * this._rowHeight;

    const spacerL = document.createElement('div');
    spacerL.className = 'tc-vs-spacer';
    // 8px per char (monospace 13px) + line-num area (~70px) + padding
    const minW = Math.max(0, this._maxLineChars * 8 + 70);
    const spacerCss = `position:relative;height:${totalH}px;min-height:${totalH}px;min-width:${minW}px;`;
    spacerL.style.cssText = spacerCss;

    const spacerR = document.createElement('div');
    spacerR.className = 'tc-vs-spacer';
    spacerR.style.cssText = spacerCss;

    // Clear panes and insert spacers
    this._contentLeft.replaceChildren(spacerL);
    this._contentRight.replaceChildren(spacerR);

    const targetTop = resetScroll
      ? 0
      : Math.min(prevScrollTop, Math.max(0, totalH - this._contentLeft.clientHeight));
    const targetLeft = resetScroll ? 0 : prevScrollLeft;
    this._contentLeft.scrollTop = targetTop;
    this._contentRight.scrollTop = targetTop;
    this._contentLeft.scrollLeft = targetLeft;
    this._contentRight.scrollLeft = targetLeft;

    // T13: Reapply word wrap after each render
    this._applyWordWrap();

    // Render visible rows into the spacers
    this._renderVisibleRows();

    // The ruler's width follows the widest line, which a re-render can change.
    this._updateRuler();

    // T03: Re-run find if find bar is open
    if (this._findBar?.style.display !== 'none') {
      setTimeout(() => this._runFind(), 0);
    }
  }

  /**
   * Render only the rows currently visible in the viewport (plus overscan).
   * Row elements are absolutely positioned inside the spacer div.
   */
  _renderVisibleRows() {
    if (!this._contentLeft || !this._contentRight) return;

    const scrollTop  = this._contentLeft.scrollTop;
    const viewportH  = this._contentLeft.clientHeight || 600;
    const totalRows  = this._totalRows;

    const firstRow = Math.max(0, Math.floor(scrollTop / this._rowHeight) - VS_OVERSCAN);
    const lastRow  = Math.min(totalRows - 1,
      Math.ceil((scrollTop + viewportH) / this._rowHeight) + VS_OVERSCAN);

    const spacerL = this._contentLeft.querySelector('.tc-vs-spacer');
    const spacerR = this._contentRight.querySelector('.tc-vs-spacer');
    if (!spacerL || !spacerR) return;

    // Collect existing rendered rows by index
    const existingL = new Map();
    const existingR = new Map();
    for (const el of spacerL.children) {
      const idx = parseInt(el.dataset.rowIdx, 10);
      if (!isNaN(idx)) existingL.set(idx, el);
    }
    for (const el of spacerR.children) {
      const idx = parseInt(el.dataset.rowIdx, 10);
      if (!isNaN(idx)) existingR.set(idx, el);
    }

    // Remove rows outside the visible range
    for (const [idx, el] of existingL) {
      if (idx < firstRow || idx > lastRow) el.remove();
    }
    for (const [idx, el] of existingR) {
      if (idx < firstRow || idx > lastRow) el.remove();
    }

    // Add rows inside the visible range that aren't yet rendered
    for (let rowIdx = firstRow; rowIdx <= lastRow; rowIdx++) {
      const row = this._rows[rowIdx];
      if (!row) continue;

      const topPx = rowIdx * this._rowHeight;
      const posStyle = `position:absolute;top:${topPx}px;left:0;min-width:100%;height:${this._rowHeight}px;`;

      if (!existingL.has(rowIdx)) {
        let leftEl, rightEl;

        if (row.kind === 'collapsed') {
          leftEl  = createCollapsedEl(row.expandStart, row.expandEnd, row.collapsedCount, row.expanded);
          rightEl = createCollapsedEl(row.expandStart, row.expandEnd, row.collapsedCount, row.expanded);
        } else {
          const rendered = this._renderDiffLine(row.diffLine);
          leftEl  = rendered.leftEl;
          rightEl = rendered.rightEl;
        }

        leftEl.dataset.rowIdx  = String(rowIdx);
        rightEl.dataset.rowIdx = String(rowIdx);
        leftEl.style.cssText  += posStyle;
        rightEl.style.cssText += posStyle;

        // T43: apply bookmark indicator
        if (this._bookmarks.has(rowIdx)) {
          leftEl.querySelector('.line-num')?.classList.add('bookmarked');
          rightEl.querySelector('.line-num')?.classList.add('bookmarked');
        }

        spacerL.appendChild(leftEl);
        spacerR.appendChild(rightEl);
      }
    }

    this._paintInlineCursor();
    this._drawGutter();
  }

  /**
   * Render one DiffLine into a left DOM element and a right DOM element.
   * @param {import('../core/diff-engine.js').DiffLine} dl
   * @returns {{ leftEl: HTMLElement, rightEl: HTMLElement }}
   */
  _renderDiffLine(dl) {
    let charDiffs = null;
    if (dl.type === 'replace') {
      // S13-C06: char-diff is O(m·n); memoize per DiffLine. _runDiff rebuilds
      // _diffResult so a fresh dl object gets a fresh cache slot.
      if (dl._charDiffs === undefined) {
        dl._charDiffs = diffChars(
          dl.leftText.replace(/\r?\n$/, ''),
          dl.rightText.replace(/\r?\n$/, ''),
        );
      }
      charDiffs = dl._charDiffs;
    }

    const uiClass = (base) => {
      let cls = base;
      if (dl.unimportant) cls += ' unimportant';
      // Distinct hook so a user-placed mark is visually separable from a
      // pattern-driven one while keeping the same blue "unimportant" semantics.
      if (dl.manualIgnored) cls += ' manual-ignored';
      // 1.4 Align With: the user needs to see which rows they pinned, or
      // there is no way to tell a forced alignment from a computed one.
      if (dl.alignAnchor) cls += ' align-anchor';
      return cls;
    };

    const ws = this._showWhitespace;

    switch (dl.type) {
      case 'equal': {
        const html = buildLineHTML(dl.leftText, 'equal', 'left', null, this._hl('left'), ws);
        const equalCls = dl.alignAnchor ? 'align-anchor' : '';
        const leftEl = createLineEl({
          cssClass: equalCls,
          lineNum: dl.leftLine,
          innerHtml: html,
          dataLeft: dl.leftLine,
          dataRight: dl.rightLine,
        });
        const rightEl = createLineEl({
          cssClass: equalCls,
          lineNum: dl.rightLine,
          innerHtml: buildLineHTML(dl.rightText, 'equal', 'right', null, this._hl('right'), ws),
          dataLeft: dl.leftLine,
          dataRight: dl.rightLine,
        });
        return { leftEl, rightEl };
      }

      case 'insert': {
        // Left: empty placeholder row (no line number)
        const leftEl = createLineEl({
          cssClass: uiClass('insert'),
          lineNum: null,
          innerHtml: '',
          dataRight: dl.rightLine,
        });
        const rightEl = createLineEl({
          cssClass: uiClass('insert'),
          lineNum: dl.rightLine,
          innerHtml: buildLineHTML(dl.rightText, 'insert', 'right', null, this._hl('right'), ws),
          dataRight: dl.rightLine,
        });
        return { leftEl, rightEl };
      }

      case 'delete': {
        const leftEl = createLineEl({
          cssClass: uiClass('delete'),
          lineNum: dl.leftLine,
          innerHtml: buildLineHTML(dl.leftText, 'delete', 'left', null, this._hl('left'), ws),
          dataLeft: dl.leftLine,
        });
        // Right: empty placeholder
        const rightEl = createLineEl({
          cssClass: uiClass('delete'),
          lineNum: null,
          innerHtml: '',
          dataLeft: dl.leftLine,
        });
        return { leftEl, rightEl };
      }

      case 'replace': {
        const leftEl = createLineEl({
          cssClass: uiClass('replace'),
          lineNum: dl.leftLine,
          innerHtml: buildLineHTML(dl.leftText, 'replace', 'left', charDiffs, this._hl('left'), ws),
          dataLeft: dl.leftLine,
          dataRight: dl.rightLine,
        });
        const rightEl = createLineEl({
          cssClass: uiClass('replace'),
          lineNum: dl.rightLine,
          innerHtml: buildLineHTML(dl.rightText, 'replace', 'right', charDiffs, this._hl('right'), ws),
          dataLeft: dl.leftLine,
          dataRight: dl.rightLine,
        });
        return { leftEl, rightEl };
      }

      default: {
        const leftEl = createLineEl({ cssClass: '', lineNum: null, innerHtml: '' });
        const rightEl = createLineEl({ cssClass: '', lineNum: null, innerHtml: '' });
        return { leftEl, rightEl };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: diff block index (for navigation)
  // -------------------------------------------------------------------------

  _buildDiffBlocks() {
    this._diffBlocks = [];

    let rowIdx = 0;
    while (rowIdx < this._rows.length) {
      const row = this._rows[rowIdx];
      if (row.kind === 'collapsed' || row.diffLine?.type === 'equal') {
        rowIdx++;
        continue;
      }

      // Start of a diff block — collect consecutive non-equal rows
      const startRow = rowIdx;
      while (
        rowIdx < this._rows.length &&
        this._rows[rowIdx].kind === 'line' &&
        this._rows[rowIdx].diffLine.type !== 'equal'
      ) {
        rowIdx++;
      }

      this._diffBlocks.push({
        type: this._rows[startRow].diffLine.type,
        startRow,
        endRow: rowIdx - 1,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private: minimap
  // -------------------------------------------------------------------------

  /**
   * Repaint the difference thumbnail.
   *
   * Rows are sampled individually into fixed-count bands rather than grouped
   * into contiguous diff blocks. Block grouping lost every isolated change:
   * one altered line in a long file drew a sliver clamped to 2px, and two
   * changes a thousand lines apart drew at the same size as one. Sampling per
   * row keeps that detail; the band count keeps the cost bounded.
   */
  _buildMinimap() {
    if (!this._minimap) return;

    // Remove all marks (keep only the viewport indicator)
    const viewport = this._minimapViewport;
    this._minimap.replaceChildren(viewport);
    this._minimapBands = [];

    if (!this._showMinimap) return;

    const totalRows = this._rows.length;
    if (totalRows === 0) return;

    const mmHeight = this._minimap.clientHeight || 400;
    const bandCount = Math.max(1, Math.min(
      Math.round(mmHeight), MINIMAP_MAX_BANDS, totalRows));

    // 0 = equal, 1 = insert, 2 = delete, 3 = replace. Highest wins within a
    // band so a lone replace is never hidden by the inserts around it.
    const severity = new Uint8Array(bandCount);
    for (let i = 0; i < totalRows; i++) {
      const row = this._rows[i];
      if (row.kind !== 'line') continue;
      const t = row.diffLine?.type;
      const rank = t === 'replace' ? 3 : t === 'delete' ? 2 : t === 'insert' ? 1 : 0;
      if (rank === 0) continue;
      const band = Math.min(bandCount - 1, Math.floor((i * bandCount) / totalRows));
      if (rank > severity[band]) severity[band] = rank;
    }

    const NAMES = ['', 'insert', 'delete', 'replace'];
    const bandPx = mmHeight / bandCount;
    let b = 0;
    while (b < bandCount) {
      const rank = severity[b];
      if (rank === 0) { b++; continue; }
      const start = b;
      while (b < bandCount && severity[b] === rank) b++;
      const type = /** @type {'insert'|'delete'|'replace'} */ (NAMES[rank]);
      this._minimapBands.push({ start, end: b - 1, type });

      const mark = document.createElement('div');
      mark.className = `minimap-mark ${type}`;
      mark.style.top    = `${start * bandPx}px`;
      mark.style.height = `${Math.max(2, (b - start) * bandPx)}px`;
      this._minimap.appendChild(mark);
    }

    this._updateMinimapViewport();
  }

  // -------------------------------------------------------------------------
  // Public: thumbnail (minimap) visibility
  // -------------------------------------------------------------------------

  /** @returns {boolean} */
  isThumbnailVisible() { return this._showMinimap; }

  /**
   * @param {boolean} on
   * @returns {boolean} the state now in effect
   */
  setThumbnailVisible(on) {
    this._showMinimap = Boolean(on);
    // Zeroing the custom property rather than the track keeps the splitter
    // drag handler correct: it composes its inline grid from var(--minimap-width).
    this._compareArea?.classList.toggle('hide-minimap', !this._showMinimap);
    this._buildMinimap();
    return this._showMinimap;
  }

  /** @returns {boolean} */
  toggleThumbnail() { return this.setThumbnailVisible(!this._showMinimap); }

  /** @returns {MinimapBand[]} the bands last painted (read only) */
  getMinimapBands() { return this._minimapBands; }

  _updateMinimapViewport() {
    if (!this._minimapViewport || !this._contentLeft || !this._showMinimap) return;

    const scrollEl   = this._contentLeft;
    const scrollTop  = scrollEl.scrollTop;
    const scrollH    = scrollEl.scrollHeight;
    const clientH    = scrollEl.clientHeight;
    const mmHeight   = this._minimap.clientHeight || 400;

    if (scrollH <= clientH) {
      this._minimapViewport.style.top    = '0px';
      this._minimapViewport.style.height = `${mmHeight}px`;
      return;
    }

    const topFrac    = scrollTop / scrollH;
    const heightFrac = clientH / scrollH;

    this._minimapViewport.style.top    = `${topFrac * mmHeight}px`;
    this._minimapViewport.style.height = `${Math.max(8, heightFrac * mmHeight)}px`;
  }

  // -------------------------------------------------------------------------
  // Private: center gutter (T39)
  // -------------------------------------------------------------------------

  _drawGutter() {
    const canvas  = this._gutterCanvas;
    const overlay = this._gutterOverlay;
    if (!canvas || !overlay || !this._contentLeft) return;

    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    if (W === 0 || H === 0) return;

    // Set canvas actual resolution
    canvas.width  = W;
    canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // Clear overlay buttons
    overlay.innerHTML = '';

    const scrollTop = this._contentLeft.scrollTop;

    /** @type {Record<string, [number,number,number]>} RGB base colours */
    const RGB = {
      insert:  [60,  200, 80],
      delete:  [230, 80,  80],
      replace: [240, 190, 40],
    };

    // S14-M08: capture index alongside block so click handlers do not need
    // O(n) indexOf on every press.
    for (let blockIdx = 0; blockIdx < this._diffBlocks.length; blockIdx++) {
      const block = this._diffBlocks[blockIdx];
      const topPx    = block.startRow * this._rowHeight - scrollTop;
      const bottomPx = (block.endRow + 1) * this._rowHeight - scrollTop;

      // Clip to visible range
      const visTop    = Math.max(0, topPx);
      const visBottom = Math.min(H, bottomPx);
      if (visBottom <= 0 || visTop >= H) continue;

      const [r, g, b] = RGB[block.type] ?? RGB.replace;

      // Horizontal gradient: transparent on edges → solid in centre
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0,    `rgba(${r},${g},${b},0.15)`);
      grad.addColorStop(0.25, `rgba(${r},${g},${b},0.5)`);
      grad.addColorStop(0.5,  `rgba(${r},${g},${b},0.65)`);
      grad.addColorStop(0.75, `rgba(${r},${g},${b},0.5)`);
      grad.addColorStop(1,    `rgba(${r},${g},${b},0.15)`);

      ctx.beginPath();
      ctx.moveTo(0, topPx);
      ctx.lineTo(W, topPx);
      ctx.lineTo(W, bottomPx);
      ctx.lineTo(0, bottomPx);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // 1px border lines top/bottom
      ctx.strokeStyle = `rgba(${r},${g},${b},0.7)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, topPx + 0.5);
      ctx.lineTo(W, topPx + 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, bottomPx - 0.5);
      ctx.lineTo(W, bottomPx - 0.5);
      ctx.stroke();

      // Mid-point y for button group
      const midY = (topPx + bottomPx) / 2;
      if (midY < -10 || midY > H + 10) continue;

      // Build overlay button group
      const blockEl = document.createElement('div');
      blockEl.className = 'tc-gutter-block';
      blockEl.style.top = `${midY}px`;

      // ◀ copy right→left
      const btnLeft = document.createElement('button');
      btnLeft.className = 'tc-gutter-copy';
      btnLeft.title = '複製到左側';
      btnLeft.textContent = '◀';
      const capturedIdx = blockIdx;
      this._on(btnLeft, 'click', () => {
        if (capturedIdx < 0 || capturedIdx >= this._diffBlocks.length) return;
        this._currentDiff = capturedIdx;
        this._copyBlock('left');
      });

      // ≠ / directional sign
      const sign = document.createElement('span');
      sign.className = 'tc-gutter-sign';
      sign.textContent = block.type === 'insert' ? '▶' :
                         block.type === 'delete' ? '◀' : '≠';

      // ▶ copy left→right
      const btnRight = document.createElement('button');
      btnRight.className = 'tc-gutter-copy';
      btnRight.title = '複製到右側';
      btnRight.textContent = '▶';
      this._on(btnRight, 'click', () => {
        if (capturedIdx < 0 || capturedIdx >= this._diffBlocks.length) return;
        this._currentDiff = capturedIdx;
        this._copyBlock('right');
      });

      blockEl.appendChild(btnLeft);
      blockEl.appendChild(sign);
      blockEl.appendChild(btnRight);
      overlay.appendChild(blockEl);
    }
  }

  // -------------------------------------------------------------------------
  // Private: status bar
  // -------------------------------------------------------------------------

  _updateStatusBar() {
    const total = this._diffBlocks.length;
    const cur   = this._currentDiff;

    if (this._diffCounter) {
      if (total === 0) {
        this._diffCounter.textContent = '無差異';
      } else {
        this._diffCounter.textContent = `差異 ${cur >= 0 ? cur + 1 : 1} / ${total}`;
      }
      this._diffCounter.style.display = '';
    }

    const leftLines  = this._leftContent.split('\n').length;
    const rightLines = this._rightContent.split('\n').length;
    const totalLines = Math.max(leftLines, rightLines);

    if (this._statusMessage) {
      this._statusMessage.textContent = this._leftContent
        ? `已比對：左 ${leftLines} 行，右 ${rightLines} 行`
        : '就緒';
    }
    if (this._statusLines) {
      // Say so when the Show filter is hiding rows; otherwise a filtered view
      // reads as a file that simply has fewer lines than it does.
      const { hidden } = this._showFilteredLineCounts
        ? this.getFilterCounts()
        : { hidden: 0 };
      this._statusLines.textContent = hidden > 0
        ? `${totalLines} 行（已隱藏 ${hidden}）`
        : `${totalLines} 行`;
    }
    if (this._statusEncoding) {
      // '?' marks a low-confidence detection. A short non-UTF-8 sample is
      // genuinely ambiguous, and chardet answers anyway; saying so is what
      // points the user at 手動指定編碼 instead of at a page of 亂碼.
      const mark = (enc, guess) => (guess ? `${enc}?` : enc);
      const l = mark(this._encodingLeft, this._encodingGuessLeft);
      const r = mark(this._encodingRight, this._encodingGuessRight);
      this._statusEncoding.textContent = l === r ? l : `${l} / ${r}`;
      this._statusEncoding.title = (this._encodingGuessLeft || this._encodingGuessRight)
        ? '編碼是偵測出來的，且樣本不足以確定。可用右鍵選單手動指定編碼。'
        : '';
    }
    if (this._statusEol) {
      this._statusEol.textContent = this._eolLeft || 'LF';
    }
  }

  // -------------------------------------------------------------------------
  // Private: scroll navigation to diff block
  // -------------------------------------------------------------------------

  /**
   * Smooth-scroll both panes to make diff block `idx` visible.
   * @param {number} idx
   */
  _scrollToDiff(idx) {
    if (idx < 0 || idx >= this._diffBlocks.length) return;
    // Details follow navigation as well as clicks; do this before the DOM
    // capability checks below so a headless view still tracks the position.
    this._setCurrentRow(this._diffBlocks[idx].startRow);
    // Navigation is now also driven automatically (go-to-first-difference on
    // load), so it can run before the panes exist or in a DOM that has no
    // scrollTo. Scrolling is a convenience; never let it break the diff.
    if (typeof this._contentLeft?.scrollTo !== 'function') return;
    if (typeof this._contentRight?.scrollTo !== 'function') return;

    const block = this._diffBlocks[idx];
    const targetRow = block.startRow;

    // Each row is LINE_HEIGHT px (from CSS: line-height 1.5 × 13px ≈ 20px)
    const LINE_HEIGHT = 20;
    const targetTop = targetRow * LINE_HEIGHT;
    const clientH = this._contentLeft.clientHeight;
    const scrollTarget = Math.max(0, targetTop - clientH / 3);

    this._contentLeft.scrollTo({ top: scrollTarget, behavior: 'smooth' });
    this._contentRight.scrollTo({ top: scrollTarget, behavior: 'smooth' });
  }

  // -------------------------------------------------------------------------
  // Private: copy block
  // -------------------------------------------------------------------------

  /**
   * @param {'left' | 'right'} targetSide  The side to overwrite
   */
  _copyBlock(targetSide) {
    if (this._currentDiff < 0 || this._currentDiff >= this._diffBlocks.length) return;
    if (!this._guardWrite(targetSide)) return;

    this._pushUndoSnapshot();

    const block = this._diffBlocks[this._currentDiff];
    const sourceSide = targetSide === 'right' ? 'left' : 'right';

    // Mark which diffResult entries belong to this block
    const blockSet = new Set();
    for (let r = block.startRow; r <= block.endRow; r++) {
      const row = this._rows[r];
      if (row.kind === 'line') blockSet.add(row.diffLine);
    }

    // Rebuild target content from the full diff result:
    // - rows in the block  → use source-side text (may be '' for insert/delete)
    // - rows outside block → preserve target-side text
    let newContent = '';
    for (const dl of this._diffResult) {
      const text = blockSet.has(dl)
        ? (sourceSide === 'left' ? dl.leftText : dl.rightText)
        : (targetSide === 'left' ? dl.leftText : dl.rightText);
      if (text) newContent += text;
    }

    if (targetSide === 'right') {
      this._rightContent = newContent;
    } else {
      this._leftContent = newContent;
    }

    // The copied block is gone from the new diff, so the index that was
    // current now points at what used to be the following difference; BC's
    // "go to next difference after copying" is off by one from that.
    const wasAt = this._currentDiff;
    this._runDiff();
    if (!getNavOptions().nextAfterCopy) return;
    if (!this._diffBlocks.length) return;
    this._navJump(Math.min(Math.max(wasAt, 0), this._diffBlocks.length - 1));
  }

  // -------------------------------------------------------------------------
  // Private: expand collapsed section
  // -------------------------------------------------------------------------

  /**
   * Expand a collapsed row in both panes.
   * @param {number} expandStart  _diffResult index (0-based)
   * @param {number} expandEnd    _diffResult index (0-based, inclusive)
   */
  _expandCollapsed(expandStart, expandEnd) {
    this._toggleCollapsedRun(expandStart, expandEnd, true);
  }

  /**
   * Expand or re-collapse one folded run of equal lines.
   *
   * The expanded set is keyed by _diffResult index range and rebuilt through
   * _buildRows(), so folding is reversible and survives re-renders triggered
   * by font size, whitespace or show-filter changes.
   *
   * @param {number} expandStart inclusive _diffResult index
   * @param {number} expandEnd   inclusive _diffResult index
   * @param {boolean} [expand]   omit to toggle
   */
  _toggleCollapsedRun(expandStart, expandEnd, expand) {
    const key = `${expandStart}:${expandEnd}`;
    const want = expand ?? !this._expandedRuns.has(key);
    if (want) this._expandedRuns.add(key);
    else this._expandedRuns.delete(key);

    this._buildRows();
    this._buildDiffBlocks();
    this._render();
    this._buildMinimap();
  }

  // -------------------------------------------------------------------------
  // Private: event handlers
  // -------------------------------------------------------------------------

  _handleScrollLeft() {
    if (this._syncLock) return;
    this._syncLock = true;
    this._contentRight.scrollTop = this._contentLeft.scrollTop;
    this._syncLock = false;
    this._updateMinimapViewport();
    this._syncRulerScroll();
    this._scheduleVsRender();
  }

  _handleScrollRight() {
    if (this._syncLock) return;
    this._syncLock = true;
    this._contentLeft.scrollTop = this._contentRight.scrollTop;
    this._syncLock = false;
    this._updateMinimapViewport();
    this._syncRulerScroll();
    this._scheduleVsRender();
  }

  /** Debounced call to _renderVisibleRows (16 ms ≈ one animation frame). */
  _scheduleVsRender() {
    clearTimeout(this._vsDebounceTimer);
    this._vsDebounceTimer = setTimeout(() => this._renderVisibleRows(), 16);
  }

  // ---- Minimap click ----

  /** @param {MouseEvent} e */
  _handleMinimapClick(e) {
    const mmHeight = this._minimap?.clientHeight ?? 0;
    // A hidden strip has no height; dividing by it would scroll both panes to NaN.
    if (!this._showMinimap || mmHeight <= 0 || !this._contentLeft || !this._contentRight) return;
    const clickFrac = e.offsetY / mmHeight;
    const scrollH = this._contentLeft.scrollHeight;
    const newScrollTop = clickFrac * scrollH;

    this._contentLeft.scrollTo({ top: newScrollTop, behavior: 'smooth' });
    this._contentRight.scrollTo({ top: newScrollTop, behavior: 'smooth' });
  }

  // ---- Content click (collapsed expand) ----

  /** @param {MouseEvent} e */
  _handleContentClick(e) {
    const target = /** @type {HTMLElement} */ (e.target);

    // T43: track last clicked row for bookmark toggle
    const rowEl = target.closest('[data-row-idx]');
    if (rowEl) {
      this._lastClickedRow = parseInt(rowEl.dataset.rowIdx, 10);
      // P3: the Details panels follow the caret, so the click also decides
      // which side they describe.
      const side = this._contentRight?.contains(rowEl) ? 'right' : 'left';
      this._caretCol = this._caretColumnIn(rowEl);
      this._setCurrentRow(this._lastClickedRow, side);
    }

    const collapsed = target.closest('.diff-line.collapsed');
    if (!collapsed) return;

    const expandStart = parseInt(collapsed.dataset.expandStart, 10);
    const expandEnd   = parseInt(collapsed.dataset.expandEnd, 10);
    if (!isNaN(expandStart) && !isNaN(expandEnd)) {
      this._toggleCollapsedRun(expandStart, expandEnd);
    }
  }

  // ---- Context menu ----

  /**
   * @param {MouseEvent} e
   * @param {'left' | 'right'} side
   */
  _handleContextMenu(e, side) {
    const selection = window.getSelection()?.toString() ?? '';
    const hasSelection = selection.length > 0;

    // The pane the user right-clicked is the active one from here on: every
    // command in editCommands() is relative to it.
    this._currentSide = side;
    const clickedRow = e.target instanceof Element ? e.target.closest('[data-row-idx]') : null;
    if (clickedRow) {
      const idx = parseInt(clickedRow.dataset.rowIdx ?? '', 10);
      if (!isNaN(idx)) {
        this._lastClickedRow = idx;
        this._caretCol = this._caretColumnIn(clickedRow);
        this._setCurrentRow(idx, side);
      }
    }

    // Determine which diff block (if any) was clicked
    const target = e.target instanceof Element ? e.target : null;
    const lineEl = target?.closest('.diff-line[data-left-line], .diff-line[data-right-line]');
    let diffBlockIdx = -1;
    if (lineEl) {
      const attrKey = side === 'left' ? 'leftLine' : 'rightLine';
      const lineNum = parseInt(lineEl.dataset[attrKey] ?? '', 10);
      if (!isNaN(lineNum)) {
        for (let i = 0; i < this._diffBlocks.length; i++) {
          const block = this._diffBlocks[i];
          if (block.type === 'equal') continue;
          const inBlock = this._rows
            .slice(block.startRow, block.endRow + 1)
            .filter(r => r.kind === 'line')
            .some(r => {
              const n = side === 'left' ? r.diffLine.leftLine : r.diffLine.rightLine;
              return n === lineNum;
            });
          if (inBlock) { diffBlockIdx = i; break; }
        }
      }
    }

    const items = [
      { label: (this._opts.algorithm === 'myers' ? '✓ ' : '　') + 'Myers（預設）',
        action: () => { this._opts.algorithm = 'myers'; this._runDiff(); } },
      { label: (this._opts.algorithm === 'patience' ? '✓ ' : '　') + 'Patience',
        action: () => { this._opts.algorithm = 'patience'; this._runDiff(); } },
      { label: (this._opts.algorithm === 'histogram' ? '✓ ' : '　') + 'Histogram',
        action: () => { this._opts.algorithm = 'histogram'; this._runDiff(); } },
      { separator: true },
      {
        label: '複製',
        disabled: !hasSelection,
        action: () => navigator.clipboard.writeText(selection)
      },
    ];

    // 1.4 / 1.5: the whole Edit/Search command set, generated from the same
    // table the shortcuts use so neither can gain an entry the other lacks.
    items.push({ separator: true });
    for (const cmd of this.editCommands()) {
      items.push({
        label: `${cmd.label} (${cmd.combo})`,
        disabled: cmd.disabled === true,
        action: cmd.run,
      });
    }

    if (diffBlockIdx >= 0) {
      items.push({ separator: true });
      if (side === 'left') {
        items.push({
          label: '複製此差異 → 右側',
          action: () => { this._currentDiff = diffBlockIdx; this._copyBlock('right'); }
        });
      } else {
        items.push({
          label: '複製此差異 → 左側',
          action: () => { this._currentDiff = diffBlockIdx; this._copyBlock('left'); }
        });
      }
    }

    // P1-19 / P2-30: selection-scoped commands
    items.push({ separator: true });
    items.push({
      label: '與剪貼簿比較選取內容 (Ctrl+Shift+C)',
      disabled: !hasSelection,
      action: () => { void this.compareSelectionToClipboard(side); },
    });
    items.push({
      label: '切換選取行的忽略標記 (Ctrl+I)',
      disabled: !hasSelection,
      action: () => { this.toggleIgnoreSelection(side); },
    });
    items.push({
      label: '列出手動忽略的行…',
      action: () => { toast(this.describeManualIgnores(), { durationMs: 6000 }); },
    });
    items.push({
      label: '清除所有手動忽略',
      disabled: this._manualIgnore.left.size + this._manualIgnore.right.size === 0,
      action: () => {
        const n = this.clearManualIgnores();
        toast(`已清除 ${n} 個手動忽略標記`, { type: 'success' });
      },
    });

    // P2-25: patch viewer
    items.push({ separator: true });
    items.push({
      label: '開啟 Patch 檔… (Ctrl+Shift+P)',
      action: () => { void this.openPatchFile(); },
    });
    items.push({
      label: `從封存檔載入到${side === 'left' ? '左' : '右'}側… (Ctrl+Shift+A)`,
      action: () => { void this.openFromArchive(side); },
    });

    // 1.7 Replacements / 1.2 Merge Files
    items.push({ separator: true });
    items.push({
      label: `文字取代規則…（${this._replacements.length}） (Ctrl+Alt+R)`,
      action: () => this.openReplacementsDialog(),
    });
    items.push({
      label: '轉為三向合併（選擇基準檔）… (Ctrl+Shift+M)',
      disabled: !this._leftContent && !this._rightContent,
      action: () => { void this.mergeFilesWithBase(); },
    });
    items.push({
      label: '轉為三向合併（無基準檔）',
      disabled: !this._leftContent && !this._rightContent,
      action: () => { this.mergeFiles(); },
    });

    // T43 / P2-51: Bookmark items
    items.push({ separator: true });
    items.push({ label: '切換書籤 (Ctrl+F2)', action: () => this._toggleBookmark(this._lastClickedRow ?? 0) });
    items.push({
      label: `跳至編號書籤（Ctrl+1…9，共 ${this._bookmarks.size} 個）`,
      disabled: this._bookmarks.size === 0,
      action: () => this.gotoBookmark(1),
    });
    items.push({ label: '清除所有書籤', action: () => { this._bookmarks.clear(); this._renderVisibleRows(); } });

    // P2-48 / P2-52 / P2-53 / P2-54 / P2-55 / P2-58 / P2-59 / P2-60
    items.push({ separator: true });
    items.push({ label: '文字比對資訊… (Ctrl+Shift+I)', action: () => this.openInfoDialog() });
    items.push({ label: '檔案格式… (Ctrl+Shift+F)', action: () => this.openFileFormatDialog() });
    items.push({ label: '不重要文字規則…', action: () => this.openUnimportantTextDialog() });
    items.push({ label: '對齊選項… (Ctrl+Shift+L)', action: () => this.openAlignmentDialog() });
    items.push({ label: '編輯器選項…', action: () => this.openEditorOptionsDialog() });
    items.push({
      label: (this._syntaxHighlight ? '✓ ' : '　') + '語法高亮',
      action: () => {
        const on = this.setSyntaxHighlighting();
        toast(on ? '語法高亮已開啟' : '語法高亮已關閉');
      },
    });
    items.push({
      label: (this._opts.orphansAlwaysImportant ? '✓ ' : '　') + '單側獨有的行一律視為重要',
      action: () => {
        const on = this.setOrphansAlwaysImportant();
        toast(on ? '單側獨有的行不再被忽略規則降級' : '單側獨有的行可被忽略規則降級');
      },
    });
    const wsMode = this.getWhitespaceMode();
    for (const [mode, label] of /** @type {Array<[WhitespaceMode, string]>} */ ([
      ['none', '空白：完全比對'],
      ['all', '空白：忽略全部'],
      ['leading', '空白：忽略行首'],
      ['trailing', '空白：忽略行尾'],
      ['amount', '空白：忽略數量變化'],
    ])) {
      items.push({
        label: (wsMode === mode ? '✓ ' : '　') + label,
        action: () => this.setWhitespaceMode(mode),
      });
    }

    // P2-29: Grammar — the elements the active file format defines, each of
    // which can be excused from the comparison.
    const elements = this.getGrammarElements();
    items.push({ separator: true });
    const info = this.getGrammarInfo();
    items.push({
      label: `文法：${info.left ?? '（無）'}${info.right && info.right !== info.left ? ` / ${info.right}` : ''}`,
      disabled: true,
      action: () => {},
    });
    if (info.errors.length > 0) {
      items.push({
        label: `⚠ 文法有 ${info.errors.length} 項錯誤（點擊查看）`,
        action: () => toast(info.errors.join('\n'), { type: 'error', durationMs: 8000 }),
      });
    }
    for (const el of elements) {
      items.push({
        label: (this._grammarIgnored.has(el) ? '✓ ' : '　') + `忽略「${el}」中的差異`,
        action: () => {
          const on = this.toggleGrammarElement(el);
          toast(on ? `已忽略 ${el} 的差異` : `不再忽略 ${el} 的差異`, { type: 'success' });
        },
      });
    }
    if (elements.length === 0) {
      items.push({ label: '（此檔案格式沒有可用的文法）', disabled: true, action: () => {} });
    } else {
      items.push({
        label: (this._opts.alignByGrammar ? '✓ ' : '　') + '以文法權重輔助對齊',
        action: () => {
          const on = this.setAlignByGrammar(!this._opts.alignByGrammar);
          toast(on ? '對齊已納入文法行權重' : '對齊已改為純文字比對', { type: 'success' });
        },
      });
    }

    // P3: view panels
    items.push({ separator: true });
    items.push({ label: (this._detailsMode === 'text' ? '✓ ' : '　') + '詳細資料：文字（可編輯）',
      action: () => this.setDetailsMode(this._detailsMode === 'text' ? null : 'text') });
    items.push({ label: (this._detailsMode === 'hex' ? '✓ ' : '　') + '詳細資料：Hex（唯讀）',
      action: () => this.setDetailsMode(this._detailsMode === 'hex' ? null : 'hex') });
    items.push({ label: (this._detailsMode === 'alignment' ? '✓ ' : '　') + '詳細資料：對齊決策',
      action: () => this.setDetailsMode(this._detailsMode === 'alignment' ? null : 'alignment') });
    items.push({
      label: (this._showMinimap ? '✓ ' : '　') + '整檔差異縮圖',
      action: () => {
        const on = this.toggleThumbnail();
        toast(on ? '已顯示差異縮圖' : '已隱藏差異縮圖');
      },
    });
    items.push({ label: (this._showRuler ? '✓ ' : '　') + '欄位標尺', action: () => this.toggleRuler() });
    items.push({ label: (this._showFileInfo ? '✓ ' : '　') + '檔案資訊', action: () => this.toggleFileInfo() });
    items.push({ label: (this._showDescription ? '✓ ' : '　') + '說明欄', action: () => this.toggleDescription() });
    items.push({
      label: (this.isSideReadOnly(side) ? '✓ ' : '　') + `鎖定${side === 'left' ? '左' : '右'}側（禁止編輯）`,
      action: () => {
        const on = this.setSideReadOnly(side);
        toast(on ? `${side === 'left' ? '左' : '右'}側已鎖定` : `${side === 'left' ? '左' : '右'}側已解鎖`);
      },
    });
    for (const family of FONT_CHOICES) {
      items.push({
        label: (this._fontFamily === family.value ? '✓ ' : '　') + `字型：${family.label}`,
        action: () => this.setFontFamily(family.value),
      });
    }

    // T45: Convert File items
    items.push({ separator: true });
    items.push({ label: '移除行尾空白',      action: () => this._convertFile(side, 'trim') });
    items.push({ label: 'Tab → 空格（4）',  action: () => this._convertFile(side, 'tabs-to-spaces') });
    items.push({ label: '空格 → Tab',       action: () => this._convertFile(side, 'spaces-to-tabs') });
    items.push({ label: '換行：→ CRLF',     action: () => this._convertFile(side, 'to-crlf') });
    items.push({ label: '換行：→ LF',       action: () => this._convertFile(side, 'to-lf') });
    items.push({ label: '換行：→ CR',       action: () => this._convertFile(side, 'to-cr') });

    // The other five views have offered this since Sprint 16; text was the one
    // left out, which is why the audit kept flagging it as the last capability
    // in the app with no entry point.
    const filePath = side === 'left' ? this._leftPath : this._rightPath;

    // The file watcher misses network drives and editors that save by writing a
    // temp file and renaming it, so a manual re-read is the only fallback.
    items.push({ separator: true });
    items.push({
      label: `從磁碟重新載入${side === 'left' ? '左' : '右'}側`,
      disabled: !filePath,
      action: () => { void this.reloadSide(side); },
    });
    items.push({
      label: '從磁碟重新載入雙側 (Ctrl+Shift+R)',
      disabled: !this._leftPath && !this._rightPath,
      action: () => { void this.reloadAll(); },
    });

    const isReal = filePath && !filePath.includes('::') && !SCHEME_RE.test(filePath);
    if (isReal) {
      items.push({ separator: true });
      items.push({
        label: '在檔案總管中顯示',
        action: () => { void this._revealInExplorer(filePath); },
      });
      if (typeof window.electronAPI?.openWith === 'function') {
        items.push({
          label: '以預設程式開啟',
          action: () => { void this._openWithDefault(filePath); },
        });
      }
    }

    showContextMenu(e, items);
  }

  // -------------------------------------------------------------------------
  // Private: T33 — file-changed toast
  // -------------------------------------------------------------------------

  /**
   * Show a brief toast notification when a watched file is updated externally.
   * @param {'left' | 'right'} side
   */
  _showFileChangedToast(side) {
    const msg = side === 'left'
      ? '左側檔案已更新，已自動重新比對'
      : '右側檔案已更新，已自動重新比對';
    const toast = document.createElement('div');
    toast.className = 'tc-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  // -------------------------------------------------------------------------
  // Private: T42 — Find & Replace
  // -------------------------------------------------------------------------

  /** Toggle replace input row visibility. */
  _toggleReplaceMode() {
    this._replaceMode = !this._replaceMode;
    const ids = ['replace-input', 'replace-one', 'replace-all'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = this._replaceMode ? '' : 'none';
    }
  }

  /**
   * Replace the current find match (first occurrence of current _findQuery
   * in the row's content) with the replace input value, then advance.
   */
  _replaceOne() {
    if (!this._replaceInput || !this._findQuery || this._findMatches.length === 0) return;
    const idx = this._findCurrentIdx >= 0 ? this._findCurrentIdx : 0;
    const match = this._findMatches[idx];
    if (!match) return;

    const q = this._findQuery;
    const r = this._replaceInput.value;

    /**
     * Replace first occurrence of query in text.
     * @param {string} text
     * @returns {string}
     */
    const replaceFirst = (text) => {
      if (this._findRegex) {
        try {
          const flags = this._findCaseSensitive ? '' : 'i';
          return text.replace(new RegExp(q, flags), r);
        } catch { return text; }
      }
      if (!this._findCaseSensitive) {
        const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        return text.replace(re, r);
      }
      return text.replace(q, r);
    };

    // Determine row's content side and replace
    const row = this._rows[match.rowIndex];
    if (!row || row.kind !== 'line') return;
    const dl = row.diffLine;
    const leftText  = dl.leftText  ?? '';
    const rightText = dl.rightText ?? '';

    const leftReplaced  = replaceFirst(leftText);
    const rightReplaced = replaceFirst(rightText);

    // S13-C02: replace the matched LINE specifically — not the first occurrence
    // of `leftText` in the whole document (which would mutate the wrong line
    // when duplicate lines exist). Falls back to indexOf replacement only when
    // the diff line carries no line number (e.g. synthetic test data).
    if (leftReplaced !== leftText) {
      this._leftContent = dl.leftLine != null
        ? _spliceLine(this._leftContent, dl.leftLine - 1, leftReplaced)
        : this._leftContent.replace(leftText, leftReplaced);
    } else if (rightReplaced !== rightText) {
      this._rightContent = dl.rightLine != null
        ? _spliceLine(this._rightContent, dl.rightLine - 1, rightReplaced)
        : this._rightContent.replace(rightText, rightReplaced);
    }

    this._runDiff();
    this._runFind();
    this._navigateFind(1);
  }

  /** Replace all occurrences of the current find query in both sides. */
  _replaceAll() {
    if (!this._replaceInput || !this._findQuery) return;
    const q = this._findQuery;
    const r = this._replaceInput.value;

    /**
     * @param {string} text
     * @returns {string}
     */
    const doReplace = (text) => {
      if (this._findRegex) {
        try {
          const flags = this._findCaseSensitive ? 'g' : 'gi';
          return text.replaceAll(new RegExp(q, flags), r);
        } catch { return text; }
      }
      if (!this._findCaseSensitive) {
        const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        return text.replaceAll(re, r);
      }
      return text.replaceAll(q, r);
    };

    this._leftContent  = doReplace(this._leftContent);
    this._rightContent = doReplace(this._rightContent);
    this._runDiff();
    this._runFind();
  }

  // -------------------------------------------------------------------------
  // Private: T43 — Bookmarks
  // -------------------------------------------------------------------------

  /**
   * The view-local shortcut map, split out of the mount-time listener so the
   * bindings can be exercised without index.html.
   * @param {KeyboardEvent} e
   */
  _handleTextGapKey(e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault();
      void this.compareSelectionToClipboard();
    } else if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      e.preventDefault();
      void this.openPatchFile();
    } else if (e.ctrlKey && e.altKey && (e.key === 'R' || e.key === 'r')) {
      // Moved off Ctrl+Shift+R: app.js dispatches that combo to reloadAll() for
      // every view that has one, so leaving it here would fire both — opening a
      // dialog and prompting to discard edits from a single keystroke.
      e.preventDefault();
      this.openReplacementsDialog();
    } else if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
      e.preventDefault();
      void this.mergeFilesWithBase();
    } else if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
      e.preventDefault();
      void this.openFromArchive(this.activeSide());
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      this.toggleIgnoreSelection();
    } else if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i')) {
      e.preventDefault();
      this.openInfoDialog();
    } else if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      e.preventDefault();
      this.openFileFormatDialog();
    } else if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      this.openAlignmentDialog();
    }
  }

  /**
   * The bookmark key map, split out of the mount-time listener so the bindings
   * can be exercised without index.html.
   * @param {KeyboardEvent} e
   */
  _handleBookmarkKey(e) {
    if (e.ctrlKey && e.key === 'F2') {
      e.preventDefault();
      this._toggleBookmarkAtCursor();
    }
    if (e.key === 'F2' && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      this._navigateBookmark(1);
    }
    if (e.key === 'F2' && e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      this._navigateBookmark(-1);
    }
    // P2-51: Ctrl+1..9 → Nth bookmark. Guarded on Alt/Shift so it cannot
    // shadow a modifier combination the host might bind later.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      this.gotoBookmark(Number(e.key));
    }
  }

  /**
   * Toggle bookmark at the last clicked row (or current scroll midpoint).
   */
  _toggleBookmarkAtCursor() {
    const rowIdx = this._lastClickedRow;
    if (rowIdx != null && !isNaN(rowIdx)) {
      this._toggleBookmark(rowIdx);
    }
  }

  /**
   * Toggle bookmark for a specific row index.
   * @param {number} rowIdx
   */
  _toggleBookmark(rowIdx) {
    if (this._bookmarks.has(rowIdx)) {
      this._bookmarks.delete(rowIdx);
    } else {
      this._bookmarks.add(rowIdx);
    }
    this._renderVisibleRows();
  }

  /**
   * Navigate to the next (+1) or previous (-1) bookmark.
   * @param {number} dir  +1 for next, -1 for previous
   */
  _navigateBookmark(dir) {
    if (this._bookmarks.size === 0) return;
    const sorted = [...this._bookmarks].sort((a, b) => a - b);
    const cur = (this._contentLeft?.scrollTop ?? 0) / this._rowHeight;
    let target;
    if (dir > 0) {
      target = sorted.find(r => r > cur) ?? sorted[0];
    } else {
      target = [...sorted].reverse().find(r => r < cur) ?? sorted[sorted.length - 1];
    }
    if (this._contentLeft)  this._contentLeft.scrollTop  = target * this._rowHeight;
    if (this._contentRight) this._contentRight.scrollTop = target * this._rowHeight;
    this._renderVisibleRows();
  }

  // -------------------------------------------------------------------------
  // Private: T45 — Convert File
  // -------------------------------------------------------------------------

  /**
   * Apply a text transformation to one side's content, then re-diff.
   * @param {'left' | 'right'} side
   * @param {'trim' | 'tabs-to-spaces' | 'spaces-to-tabs' | 'to-crlf' | 'to-lf' | 'to-cr'} op
   */
  /**
   * Show the file in the OS file manager.
   *
   * Virtual paths — archive entries, snapshots, remote objects — are filtered
   * out by the caller: there is no folder to reveal for them, and the path
   * validator would refuse the call regardless.
   *
   * @param {string} path
   */
  async _revealInExplorer(path) {
    try {
      await window.electronAPI.showInExplorer(path);
    } catch (err) {
      toast(`無法顯示檔案位置：${err?.message ?? err}`, { type: 'error' });
    }
  }

  /**
   * Hand the file to its associated application.
   * @param {string} path
   */
  async _openWithDefault(path) {
    try {
      await window.electronAPI.openWith(path, { withPicker: false });
    } catch (err) {
      // A refusal from the OS is exactly what the user needs told: nothing
      // visible happens otherwise.
      toast(`無法開啟：${err?.message ?? err}`, { type: 'error' });
    }
  }

  _convertFile(side, op) {
    if (!this._guardWrite(side)) return;
    const TAB_WIDTH = this._tabWidth;

    /**
     * @param {string} text
     * @returns {string}
     */
    const transform = (text) => {
      switch (op) {
        case 'trim':
          // Not split('\n') + /[ \t]+$/: on a CRLF file every line still ends
          // with the \r, so the anchor sits after it and the trim silently did
          // nothing — on the platform this app mostly runs on.
          return trimTrailingWhitespace(text);
        case 'tabs-to-spaces':
          return text.split('\n').map(l => l.replaceAll('\t', ' '.repeat(TAB_WIDTH))).join('\n');
        case 'spaces-to-tabs':
          return text.split('\n').map(l => {
            let i = 0;
            let tabs = '';
            while (i + TAB_WIDTH <= l.length) {
              if (l.slice(i, i + TAB_WIDTH) === ' '.repeat(TAB_WIDTH)) {
                tabs += '\t'; i += TAB_WIDTH;
              } else break;
            }
            return tabs + l.slice(i);
          }).join('\n');
        case 'to-crlf':
          return text.replace(/\r\n|\r|\n/g, '\r\n');
        case 'to-lf':
          return text.replace(/\r\n|\r/g, '\n');
        case 'to-cr':
          return text.replace(/\r\n|\n/g, '\r');
        default:
          return text;
      }
    };

    if (side === 'left') {
      this._leftContent = transform(this._leftContent);
      this._eolLeft = detectEol(this._leftContent);
    } else {
      this._rightContent = transform(this._rightContent);
      this._eolRight = detectEol(this._rightContent);
    }
    this._runDiff();
    this._updateStatusBar();
  }

  // -------------------------------------------------------------------------
  // Public: T46 — Show Filter
  // -------------------------------------------------------------------------

  /**
   * Set the row visibility filter and re-render.
   * @param {'all' | 'diff' | 'same' | 'none'} filter
   */
  setShowFilter(filter) {
    if (filter !== 'all' && filter !== 'diff' && filter !== 'same' && filter !== 'none') return;
    this._showFilter = filter;
    this._syncShowFilterButtons();
    this._buildRows();
    this._buildDiffBlocks();
    this._render();
    this._buildMinimap();
  }

  /** Sync active state of show-filter buttons to current _showFilter. */
  _syncShowFilterButtons() {
    const map = {
      all:  this._btnShowAll,
      diff: this._btnShowDiff,
      same: this._btnShowSame,
      none: this._btnShowNone,
    };
    for (const [key, btn] of Object.entries(map)) {
      if (!btn) continue;
      btn.classList.toggle('active', key === this._showFilter);
    }
  }

  // -------------------------------------------------------------------------
  // Public: T47 — Visible Whitespace
  // -------------------------------------------------------------------------

  /**
   * Toggle visible whitespace display and re-render.
   * @returns {boolean} New state
   */
  toggleWhitespace() {
    this._showWhitespace = !this._showWhitespace;
    if (this._btnWhitespace) {
      this._btnWhitespace.classList.toggle('active', this._showWhitespace);
    }
    // Force re-render by clearing existing rows from DOM
    this._render();
    return this._showWhitespace;
  }

  // -------------------------------------------------------------------------
  // Public: T48 — Line Numbers
  // -------------------------------------------------------------------------

  /**
   * Toggle line number visibility.
   * @returns {boolean} New state (true = line numbers visible)
   */
  toggleLineNumbers() {
    this._showLineNumbers = !this._showLineNumbers;
    this._applyLineNumbers();
    if (this._btnLineNums) {
      this._btnLineNums.classList.toggle('active', this._showLineNumbers);
    }
    return this._showLineNumbers;
  }

  /** Apply line-number visibility via CSS class on .compare-area. */
  _applyLineNumbers() {
    if (!this._compareArea) return;
    this._compareArea.classList.toggle('hide-line-numbers', !this._showLineNumbers);
  }

  // -------------------------------------------------------------------------
  // Public: T49 — Font Size
  // -------------------------------------------------------------------------

  /**
   * Set font size for pane content (clamped to [10, 24] px).
   * Updates this._rowHeight dynamically so virtual scroll stays accurate.
   * @param {number} size
   */
  setFontSize(size) {
    const clamped = Math.max(10, Math.min(24, Math.round(size)));
    if (clamped === this._fontSize) return;
    this._fontSize = clamped;
    this._applyFontSize();
    // Rebuild rows and re-render with new row height
    this._buildRows();
    this._render();
    this._buildMinimap();
  }

  /** Apply current font size to pane CSS variable. */
  _applyFontSize() {
    const size = this._fontSize;
    const rowH  = size + 7; // e.g. 13+7=20, 16+7=23

    // S13-C03: keep virtual-scroll row height in sync with CSS row height.
    this._rowHeight = rowH;

    if (this._compareArea) {
      this._compareArea.style.setProperty('--tc-font-size', `${size}px`);
      this._compareArea.style.setProperty('--tc-row-height', `${rowH}px`);
    }

    if (this._contentLeft)  this._contentLeft.style.fontSize  = `${size}px`;
    if (this._contentRight) this._contentRight.style.fontSize = `${size}px`;
  }

  /** @returns {number} Current font size in px */
  get fontSize() { return this._fontSize; }

  // -------------------------------------------------------------------------
  // Public: T50 — Layout Mode
  // -------------------------------------------------------------------------

  /**
   * Toggle between side-by-side and over-under layout.
   * @returns {'side-by-side' | 'over-under'} New layout mode
   */
  toggleLayout() {
    this._layoutMode = this._layoutMode === 'side-by-side' ? 'over-under' : 'side-by-side';
    this._applyLayout();
    return this._layoutMode;
  }

  /** Apply current layout mode via CSS class on .compare-area. */
  _applyLayout() {
    if (!this._compareArea) return;
    const isOverUnder = this._layoutMode === 'over-under';
    this._compareArea.classList.toggle('over-under', isOverUnder);
    if (this._btnLayout) {
      this._btnLayout.textContent = isOverUnder ? '⊟ Over' : '⬛ Side';
      this._btnLayout.classList.toggle('active', isOverUnder);
    }
    // Gutter canvas must be redrawn after layout changes
    this._drawGutter();
  }

  // -------------------------------------------------------------------------
  // Webpages view (BC's View ▸ Webpages)
  // -------------------------------------------------------------------------

  /**
   * Whether either side looks like markup worth rendering.
   *
   * Sniffed from the content rather than the extension: a `.txt` holding a
   * page is still a page, and an `.html` holding a template fragment is still
   * worth rendering. The button stays disabled otherwise, because rendering
   * plain prose as a document shows the same text with the diff colouring
   * removed — strictly worse than the source view.
   *
   * @returns {boolean}
   */
  canRenderWebpage() {
    const looksLikeMarkup = (s) => typeof s === 'string'
      && /<\s*(!doctype\s+html|html|body|div|p|table|h[1-6]|span|a\s)/i.test(s);
    return looksLikeMarkup(this._leftContent) || looksLikeMarkup(this._rightContent);
  }

  /** @returns {boolean} */
  isWebpageMode() { return this._webpageMode === true; }

  /**
   * Show the two sides as rendered pages instead of as source.
   *
   * @param {boolean} on
   * @returns {boolean} the mode actually in effect
   */
  setWebpageMode(on) {
    const next = !!on && this.canRenderWebpage();
    if (next === this.isWebpageMode()) return this._webpageMode === true;
    this._webpageMode = next;
    this._applyWebpageMode();
    return this._webpageMode;
  }

  /** @returns {boolean} */
  toggleWebpageMode() { return this.setWebpageMode(!this.isWebpageMode()); }

  /**
   * Wrap a document so it cannot reach the network.
   *
   * This is the part that matters. A compared file is somebody else's HTML,
   * and an ordinary page references remote images, fonts, stylesheets and
   * trackers — so merely rendering one would announce to a third party that
   * this file was opened, which a local diff tool has no business doing.
   * The injected policy allows inline styles and data: images and nothing
   * else, so a page renders roughly as intended while every off-machine
   * request is refused.
   *
   * Scripts are blocked twice over: by this policy and by the frame's sandbox
   * attribute, which omits allow-scripts. Two independent locks, because a
   * document that runs script inside the app's own window is the one failure
   * that would matter.
   *
   * @param {string} html
   * @returns {string}
   */
  static wrapWebpageHtml(html) {
    const policy = "<meta http-equiv=\"Content-Security-Policy\" content=\""
      + "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">";
    const source = typeof html === 'string' ? html : '';
    // Placed at the very start of <head> when there is one, so it governs
    // everything that follows; a fragment with no head gets a document built
    // around it.
    if (/<head[^>]*>/i.test(source)) {
      return source.replace(/<head[^>]*>/i, (m) => `${m}${policy}`);
    }
    return `<!doctype html><html><head>${policy}</head><body>${source}</body></html>`;
  }

  /** Drop any blob URLs the rendered frames were using. */
  _revokeWebpageUrls() {
    for (const key of ['left', 'right']) {
      const url = this._webpageUrls?.[key];
      if (url) URL.revokeObjectURL(url);
    }
    this._webpageUrls = { left: null, right: null };
  }

  /** Build or tear down the rendered frames. */
  _applyWebpageMode() {
    const on = this.isWebpageMode();
    if (this._btnWebpage) {
      this._btnWebpage.textContent = on ? '🌐 網頁' : '🌐 原始碼';
      this._btnWebpage.classList.toggle('active', on);
    }

    this._revokeWebpageUrls();
    this._webpageUrls = { left: null, right: null };

    for (const side of ['left', 'right']) {
      const pane = document.getElementById(side === 'left' ? 'pane-left' : 'pane-right');
      if (!pane) continue;
      const existing = pane.querySelector('.tc-webpage-frame');
      if (existing) existing.remove();
      const content = side === 'left' ? this._contentLeft : this._contentRight;
      if (content) content.style.display = on ? 'none' : '';
      if (!on) continue;

      const frame = document.createElement('iframe');
      frame.className = 'tc-webpage-frame';
      // No allow-scripts and no allow-same-origin: the document cannot run
      // code, reach this window, or read anything of the app's.
      frame.setAttribute('sandbox', '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = side === 'left' ? '左側網頁預覽' : '右側網頁預覽';
      const html = TextCompare.wrapWebpageHtml(
        side === 'left' ? this._leftContent : this._rightContent);
      // A blob URL rather than srcdoc: the app's own CSP allows frame-src
      // blob: and nothing else, which the print preview already relies on.
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      this._webpageUrls[side] = url;
      frame.src = url;
      pane.appendChild(frame);
    }
  }

  /** Enable or disable the toggle to match what is loaded. */
  _syncWebpageButton() {
    if (!this._btnWebpage) return;
    const usable = this.canRenderWebpage();
    this._btnWebpage.disabled = !usable;
    this._btnWebpage.title = usable
      ? '以網頁方式檢視 HTML（不執行指令碼、不連外）'
      : '兩側都不是 HTML，無法以網頁方式檢視';
    // Falling back to source when the content stops being markup, rather than
    // leaving two blank frames behind.
    if (!usable && this.isWebpageMode()) {
      this.setWebpageMode(false);
      return;
    }
    // Still markup, still in this mode, but the content just changed — so the
    // frames are showing the previous file. Rebuilding is not optional: a
    // rendered page that silently belongs to the file you had open before is
    // worse than no preview at all, because nothing on screen says so.
    if (usable && this.isWebpageMode()) this._applyWebpageMode();
  }

  // -------------------------------------------------------------------------
  // P2-29: Grammar
  // -------------------------------------------------------------------------

  /**
   * Pick the grammar for each side from its filename.
   *
   * A side with no matching format borrows the other's, which is BC's
   * "Same as left" behaviour and matters when comparing a file against
   * clipboard text or a patch pane, neither of which has a real extension.
   */
  _resolveGrammars() {
    const auto = (path) => (path ? getGrammarForPath(path) : null);
    // P2-58: an explicit choice wins over the filename. 'same-as-left' is
    // BC's default for the right pane and is stored, not resolved, so that
    // changing the left side later carries over.
    const pick = (/** @type {'left'|'right'} */ side) => {
      const name = this._formatOverride[side];
      if (name === 'same-as-left') return null;
      if (name) return TextCompare._grammarByName(name);
      return auto(side === 'left' ? this._leftPath : this._rightPath);
    };
    const left = pick('left');
    const right = this._formatOverride.right === 'same-as-left' ? left : pick('right');
    this._grammarLeft = left ?? right;
    this._grammarRight = right ?? left;
  }

  /**
   * @param {string} name
   * @returns {import('../core/grammar.js').CompiledGrammar|null}
   */
  static _grammarByName(name) {
    const def = listGrammars().find((g) => g.name === name);
    if (!def) return null;
    const compiled = compileGrammar(def);
    return compiled.compiled.length > 0 ? compiled : null;
  }

  /**
   * P2-58: the formats a side may be forced to.
   * @returns {string[]}
   */
  listFileFormats() {
    return listGrammars().map((g) => g.name);
  }

  /**
   * Force a side's file format, or pass null to go back to detecting it from
   * the filename. The right side additionally accepts 'same-as-left'.
   *
   * @param {'left'|'right'} side
   * @param {string|null} name
   * @returns {boolean} whether the name was recognised
   */
  setFileFormat(side, name) {
    if (side !== 'left' && side !== 'right') return false;
    if (name != null && name !== 'same-as-left' && !this.listFileFormats().includes(name)) {
      toast(`沒有名為「${name}」的檔案格式`, { type: 'error' });
      return false;
    }
    if (side === 'left' && name === 'same-as-left') return false;
    this._formatOverride[side] = name;
    this._resolveGrammars();
    // BC's file format also drives the colouring, so a forced format that left
    // the pane highlighted as the old language would read as a no-op.
    void this._syncHighlighterToFormat(side);
    if (this._leftContent || this._rightContent) this._runDiff();
    return true;
  }

  /**
   * Re-pick the highlight.js language from the side's effective format.
   * @param {'left'|'right'} side
   */
  async _syncHighlighterToFormat(side) {
    const name = this._formatOverride[side];
    if (!name) {
      // Back to automatic: the filename decides again.
      const path = side === 'left' ? this._leftPath : this._rightPath;
      const hl = path ? await loadHighlighter(this._extFrom(path)) : null;
      if (side === 'left') this._hlLeft = hl; else this._hlRight = hl;
      this._render();
      return;
    }
    const effective = name === 'same-as-left' ? this._formatOverride.left : name;
    const def = effective ? listGrammars().find((g) => g.name === effective) : null;
    // Masks look like "*.py"; the first one that maps to a known language wins.
    let hl = null;
    for (const mask of def?.masks ?? []) {
      const ext = String(mask).split('.').pop()?.toLowerCase() ?? '';
      hl = await loadHighlighter(ext);
      if (hl) break;
    }
    if (side === 'left') this._hlLeft = hl; else this._hlRight = hl;
    this._render();
  }

  /** @returns {{ left: string|null, right: string|null }} */
  getFileFormats() {
    return { ...this._formatOverride };
  }

  /** Whether anything currently needs grammar tokens. */
  _grammarNeeded() {
    return this._grammarIgnored.size > 0 || this._detailsMode === 'alignment'
      || this._weightAlignEligible();
  }

  /**
   * Whether line weights should be handed to the diff for this pair.
   *
   * Tokenizing costs roughly 2.6 µs per line, which is affordable once but not
   * on every keystroke of the 300 ms edit debounce for an arbitrarily large
   * file — hence the size ceiling. Above it the diff simply runs unweighted;
   * alignment stays correct, it just loses the grammar's opinion about which
   * of several equally short edit scripts to prefer.
   */
  _weightAlignEligible() {
    if (!this._opts.alignByGrammar) return false;
    if (!this._grammarLeft && !this._grammarRight) return false;
    if (!this._leftContent || !this._rightContent) return false;
    return this._leftContent.length + this._rightContent.length <= MAX_WEIGHT_ALIGN_CHARS;
  }

  /**
   * Per-line alignment weights for both sides, or null when not applicable.
   *
   * Derived from the tokens `_computeGrammarTokens` has already produced, so
   * enabling this costs one tokenize pass rather than two.
   *
   * @returns {{ left: number[], right: number[] }|null}
   */
  _alignmentWeights() {
    if (!this._weightAlignEligible()) return null;
    /**
     * @param {'left'|'right'} side
     * @param {string} content
     * @param {import('../core/grammar.js').CompiledGrammar|null} grammar
     * @returns {number[]}
     */
    const build = (side, content, grammar) => {
      if (!grammar) return content.split('\n').map(() => 1);
      return content.split('\n').map((line, i) => lineWeight(line, this._tokensForLine(side, i + 1), grammar));
    };
    return {
      left: build('left', this._leftContent, this._grammarLeft),
      right: build('right', this._rightContent, this._grammarRight),
    };
  }

  /**
   * Tokenize both sides. Cheap no-op when nothing needs the result, because
   * this runs on every re-diff — including the 300 ms debounce while typing.
   */
  _computeGrammarTokens() {
    this._grammarTruncated = false;
    if (!this._grammarNeeded()) {
      this._tokensLeft = [];
      this._tokensRight = [];
      return;
    }
    const run = (grammar, content) => {
      if (!grammar || !content) return { tokens: [], truncated: false };
      return tokenizeLines(grammar, content.split('\n'));
    };
    const l = run(this._grammarLeft, this._leftContent);
    const r = run(this._grammarRight, this._rightContent);
    this._tokensLeft = l.tokens;
    this._tokensRight = r.tokens;
    this._grammarTruncated = l.truncated || r.truncated;

    // Hitting the bound means part of the file was never classified, so some
    // differences that should have been demoted will still read as important.
    // Say so once per transition rather than swallowing it.
    if (this._grammarTruncated && !this._grammarTruncationReported) {
      this._grammarTruncationReported = true;
      toast('檔案過大或行過長，文法解析已提前停止；部分「忽略元素」可能未生效', {
        type: 'warn', durationMs: 6000,
      });
    } else if (!this._grammarTruncated) {
      this._grammarTruncationReported = false;
    }
  }

  /**
   * Tokens for one file line (1-based, as DiffLine stores them).
   * @param {'left'|'right'} side
   * @param {number|null|undefined} lineNum
   * @returns {import('../core/grammar.js').GrammarToken[]}
   */
  _tokensForLine(side, lineNum) {
    if (lineNum == null) return [];
    const arr = side === 'left' ? this._tokensLeft : this._tokensRight;
    return arr[lineNum - 1] ?? [];
  }

  /**
   * Demote differences that live entirely inside ignored grammar elements.
   *
   * This is the payoff of the whole grammar system: "ignore differences in
   * comments" becomes "the two lines are equal once comments are blanked out".
   * It reuses the existing unimportant/ignoreUnimportant machinery rather than
   * altering the diff itself, so the user still sees the real text.
   *
   * @param {import('../core/diff-engine.js').DiffLine} dl
   * @returns {boolean} whether the line is unimportant by grammar
   */
  _grammarUnimportant(dl) {
    if (this._grammarIgnored.size === 0) return false;
    const lt = this._tokensForLine('left', dl.leftLine);
    const rt = this._tokensForLine('right', dl.rightLine);
    const lText = (dl.leftText ?? '').replace(/\r?\n$/, '');
    const rText = (dl.rightText ?? '').replace(/\r?\n$/, '');

    if (dl.type === 'replace') {
      return linesEqualIgnoringElements(lText, rText, lt, rt, this._grammarIgnored);
    }
    // An inserted or deleted line that is nothing but ignored elements (a
    // comment-only line, say) is likewise not a difference worth flagging.
    const text = dl.type === 'insert' ? rText : lText;
    const tokens = dl.type === 'insert' ? rt : lt;
    if (!text.trim()) return false;
    return maskLine(text, tokens, this._grammarIgnored).trim() === '';
  }

  /**
   * Element names offered by the active grammars.
   * @returns {string[]}
   */
  getGrammarElements() {
    /** @type {string[]} */
    const out = [];
    for (const g of [this._grammarLeft, this._grammarRight]) {
      for (const el of g?.elements ?? []) if (!out.includes(el)) out.push(el);
    }
    return out;
  }

  /**
   * @returns {{ left: string|null, right: string|null, ignored: string[], errors: string[], truncated: boolean }}
   */
  getGrammarInfo() {
    const errors = [...(this._grammarLeft?.errors ?? []), ...(this._grammarRight?.errors ?? [])];
    return {
      left: this._grammarLeft?.name ?? null,
      right: this._grammarRight?.name ?? null,
      ignored: [...this._grammarIgnored],
      errors: [...new Set(errors)],
      truncated: this._grammarTruncated,
    };
  }

  /**
   * Replace the set of ignored grammar elements.
   * @param {string[]|Set<string>} elements
   */
  setGrammarIgnore(elements) {
    this._grammarIgnored = new Set(
      [...(elements ?? [])].filter(e => typeof e === 'string' && e),
    );
    this._runDiff();
  }

  /**
   * @param {string} element
   * @returns {boolean} the resulting state
   */
  toggleGrammarElement(element) {
    if (this._grammarIgnored.has(element)) this._grammarIgnored.delete(element);
    else this._grammarIgnored.add(element);
    this._runDiff();
    return this._grammarIgnored.has(element);
  }

  /**
   * Turn grammar line weights on or off as an alignment input.
   * @param {boolean} [on] omit to toggle
   * @returns {boolean} the resulting state
   */
  setAlignByGrammar(on) {
    this._opts.alignByGrammar = on === undefined ? !this._opts.alignByGrammar : !!on;
    if (this._leftContent || this._rightContent) this._runDiff();
    return this._opts.alignByGrammar;
  }

  /**
   * Alignment weight for one file line, per the active grammar.
   * @param {'left'|'right'} side
   * @param {number|null} lineNum
   * @returns {number}
   */
  getLineWeight(side, lineNum) {
    if (lineNum == null) return 0;
    const content = side === 'left' ? this._leftContent : this._rightContent;
    const text = content.split('\n')[lineNum - 1] ?? '';
    const grammar = side === 'left' ? this._grammarLeft : this._grammarRight;
    return lineWeight(text, this._tokensForLine(side, lineNum), grammar);
  }

  // -------------------------------------------------------------------------
  // 1.7: Prevent editing (per side)
  // -------------------------------------------------------------------------

  /**
   * @param {'left'|'right'} side
   * @param {boolean} [on] omit to toggle
   * @returns {boolean} the resulting lock state
   */
  setSideReadOnly(side, on) {
    const key = side === 'right' ? 'right' : 'left';
    this._readOnly[key] = on ?? !this._readOnly[key];
    const ta = key === 'left' ? this._textareaLeft : this._textareaRight;
    if (ta) ta.readOnly = this._readOnly[key];
    this._updateFileInfo();
    return this._readOnly[key];
  }

  /**
   * @param {'left'|'right'} side
   * @returns {boolean}
   */
  isSideReadOnly(side) {
    return !!this._readOnly[side === 'right' ? 'right' : 'left'];
  }

  /**
   * Refuse a write to a locked side, loudly.
   * @param {'left'|'right'} side
   * @returns {boolean} true when the write may proceed
   */
  _guardWrite(side) {
    if (!this.isSideReadOnly(side)) return true;
    toast(`${side === 'left' ? '左' : '右'}側已鎖定，無法修改`, { type: 'error' });
    return false;
  }

  // -------------------------------------------------------------------------
  // P3: Ruler / File Info / Description / Details panels
  // -------------------------------------------------------------------------

  /** Container that holds the ruler, file-info and description strips. */
  _ensureTopStrip() {
    if (this._topStrip?.isConnected) return this._topStrip;
    const view = document.getElementById('view-text');
    const area = document.getElementById('compare-area');
    if (!view || !area) return null;
    const strip = document.createElement('div');
    strip.className = 'tc-top-strip';
    view.insertBefore(strip, area);
    this._topStrip = strip;
    return strip;
  }

  /**
   * Column ruler.
   *
   * Deliberately a single pre-formatted text node per pane rather than one
   * element per column: the panes hold tens of thousands of virtual rows and
   * the ruler must not add DOM that scales with content.
   *
   * @param {boolean} [on] omit to toggle
   * @returns {boolean}
   */
  toggleRuler(on) {
    this._showRuler = on ?? !this._showRuler;
    if (!this._showRuler) {
      this._rulerEl?.remove();
      this._rulerEl = null;
      return false;
    }
    const strip = this._ensureTopStrip();
    if (!strip) return false;
    const ruler = document.createElement('div');
    ruler.className = 'tc-ruler';
    for (const side of ['left', 'right']) {
      const cell = document.createElement('div');
      cell.className = 'tc-ruler__cell';
      const scale = document.createElement('div');
      scale.className = 'tc-ruler__scale';
      scale.dataset.side = side;
      cell.appendChild(scale);
      ruler.appendChild(cell);
    }
    strip.prepend(ruler);
    this._rulerEl = ruler;
    this._updateRuler();
    return true;
  }

  /** Rebuild the ruler text and re-sync it with horizontal scroll. */
  _updateRuler() {
    if (!this._rulerEl) return;
    const cols = Math.min(2000, Math.max(80, this._maxLineChars + 20));
    let text = '';
    for (let c = 1; c <= cols; c++) {
      if (c % 10 === 0) {
        const label = String(c);
        // The label is written ending at this column, so overwrite what the
        // loop already emitted for the digits it occupies.
        text = text.slice(0, text.length - (label.length - 1)) + label;
      } else if (c % 5 === 0) text += '+';
      else text += '·';
    }
    for (const scale of this._rulerEl.querySelectorAll('.tc-ruler__scale')) {
      scale.textContent = text;
      const pane = scale.dataset.side === 'left' ? this._contentLeft : this._contentRight;
      scale.style.transform = `translateX(${-(pane?.scrollLeft ?? 0)}px)`;
    }
  }

  /** Keep the ruler aligned during horizontal scrolling. */
  _syncRulerScroll() {
    if (!this._rulerEl) return;
    for (const scale of this._rulerEl.querySelectorAll('.tc-ruler__scale')) {
      const pane = scale.dataset.side === 'left' ? this._contentLeft : this._contentRight;
      scale.style.transform = `translateX(${-(pane?.scrollLeft ?? 0)}px)`;
    }
  }

  /**
   * File Info panel (path / size / lines / encoding / EOL / lock state).
   * @param {boolean} [on] omit to toggle
   * @returns {boolean}
   */
  toggleFileInfo(on) {
    this._showFileInfo = on ?? !this._showFileInfo;
    if (!this._showFileInfo) {
      this._infoEl?.remove();
      this._infoEl = null;
      return false;
    }
    const strip = this._ensureTopStrip();
    if (!strip) return false;
    const el = document.createElement('div');
    el.className = 'tc-fileinfo';
    strip.appendChild(el);
    this._infoEl = el;
    this._updateFileInfo();
    return true;
  }

  _updateFileInfo() {
    if (!this._infoEl) return;
    const enc = new TextEncoder();
    /** @param {'left'|'right'} side */
    const describe = (side) => {
      const path = side === 'left' ? this._leftPath : this._rightPath;
      const content = side === 'left' ? this._leftContent : this._rightContent;
      const label = side === 'left' ? '左' : '右';
      // The lock is shown even with nothing loaded — a lock the user set and
      // then cannot see is a lock they will be confused by later.
      if (!path && !content) {
        return `${label}：（未載入）${this.isSideReadOnly(side) ? '　🔒 已鎖定' : ''}`;
      }
      const bytes = enc.encode(content ?? '').length;
      const lines = content ? content.split('\n').length : 0;
      const encoding = side === 'left' ? this._encodingLeft : this._encodingRight;
      const eol = side === 'left' ? this._eolLeft : this._eolRight;
      const lock = this.isSideReadOnly(side) ? '　🔒 已鎖定' : '';
      const grammar = (side === 'left' ? this._grammarLeft : this._grammarRight)?.name ?? '—';
      return `${side === 'left' ? '左' : '右'}：${path || '（貼上）'}　${formatBytes(bytes)}　${lines} 行　${encoding}　${eol}　文法：${grammar}${lock}`;
    };
    this._infoEl.replaceChildren();
    for (const side of /** @type {Array<'left'|'right'>} */ (['left', 'right'])) {
      const row = document.createElement('div');
      row.className = 'tc-fileinfo__row';
      row.textContent = describe(side);
      this._infoEl.appendChild(row);
    }
  }

  /**
   * Session description box.
   * @param {boolean} [on] omit to toggle
   * @returns {boolean}
   */
  toggleDescription(on) {
    this._showDescription = on ?? !this._showDescription;
    if (!this._showDescription) {
      this._descriptionEl?.remove();
      this._descriptionEl = null;
      return false;
    }
    const strip = this._ensureTopStrip();
    if (!strip) return false;
    const wrap = document.createElement('div');
    wrap.className = 'tc-description';
    const label = document.createElement('label');
    label.className = 'tc-description__label';
    label.textContent = '說明：';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tc-description__input';
    input.placeholder = '這次比對的說明（會存入設定與報表）';
    input.value = this._description;
    label.appendChild(input);
    wrap.appendChild(label);
    strip.appendChild(wrap);
    this._on(input, 'input', () => { this._description = input.value; });
    this._descriptionEl = wrap;
    return true;
  }

  /** @param {string} text */
  setDescription(text) {
    this._description = typeof text === 'string' ? text : '';
    const input = this._descriptionEl?.querySelector('.tc-description__input');
    if (input) input.value = this._description;
  }

  /** @returns {string} */
  getDescription() { return this._description; }

  /**
   * Display font family for both panes.
   *
   * @param {string} family '' restores the stylesheet default
   */
  setFontFamily(family) {
    this._fontFamily = typeof family === 'string' ? family : '';
    const target = this._compareArea;
    if (!target) return;
    if (this._fontFamily) target.style.setProperty('--mono-font-family', this._fontFamily);
    else target.style.removeProperty('--mono-font-family');
  }

  /** @returns {string} */
  getFontFamily() { return this._fontFamily; }

  /**
   * Show one of the three Details panels, or hide them.
   *
   * The panel renders exactly one row's worth of content, so it costs the same
   * whether the file has ten lines or a hundred thousand — the virtual scroll
   * above it is untouched.
   *
   * @param {'text'|'hex'|'alignment'|null} mode
   * @returns {'text'|'hex'|'alignment'|null}
   */
  setDetailsMode(mode) {
    const valid = mode === 'text' || mode === 'hex' || mode === 'alignment' ? mode : null;
    const needTokensBefore = this._grammarNeeded();
    this._detailsMode = valid;

    if (!valid) {
      this._detailsEl?.remove();
      this._detailsEl = null;
      this._detailsBody = null;
      return null;
    }

    if (!this._detailsEl?.isConnected) {
      const view = document.getElementById('view-text');
      if (!view) { this._detailsMode = null; return null; }
      const panel = document.createElement('div');
      panel.className = 'tc-details';

      const tabs = document.createElement('div');
      tabs.className = 'tc-details__tabs';
      for (const [key, label] of [['text', '文字'], ['hex', 'Hex'], ['alignment', '對齊']]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tc-details__tab';
        btn.dataset.mode = key;
        btn.textContent = label;
        this._on(btn, 'click', () => this.setDetailsMode(/** @type {'text'|'hex'|'alignment'} */ (key)));
        tabs.appendChild(btn);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tc-details__close';
      close.textContent = '✕';
      this._on(close, 'click', () => this.setDetailsMode(null));
      tabs.appendChild(close);

      const body = document.createElement('div');
      body.className = 'tc-details__body';

      panel.append(tabs, body);
      view.appendChild(panel);
      this._detailsEl = panel;
      this._detailsBody = body;
    }

    for (const btn of this._detailsEl.querySelectorAll('.tc-details__tab')) {
      btn.classList.toggle('active', btn.dataset.mode === valid);
    }

    // Alignment details need tokens that were not being produced before.
    if (!needTokensBefore && this._grammarNeeded()) {
      this._computeGrammarTokens();
    }
    this._updateDetails();
    return valid;
  }

  /** @returns {'text'|'hex'|'alignment'|null} */
  getDetailsMode() { return this._detailsMode; }

  /**
   * The DiffLine the Details panels currently describe.
   * @returns {import('../core/diff-engine.js').DiffLine|null}
   */
  _currentDiffLine() {
    const row = this._rows[this._currentRowIdx];
    return row && row.kind === 'line' ? row.diffLine : null;
  }

  /** Repaint whichever Details panel is open. */
  _updateDetails() {
    if (!this._detailsMode || !this._detailsBody) return;
    const dl = this._currentDiffLine();
    this._detailsBody.replaceChildren();

    if (!dl) {
      const hint = document.createElement('div');
      hint.className = 'tc-details__hint';
      hint.textContent = '點選任一行以顯示詳細資料。';
      this._detailsBody.appendChild(hint);
      return;
    }

    if (this._detailsMode === 'text') this._renderTextDetails(dl);
    else if (this._detailsMode === 'hex') this._renderHexDetails(dl);
    else this._renderAlignmentDetails(dl);
  }

  /**
   * Text Details — editable, writes the edited line straight back.
   * @param {import('../core/diff-engine.js').DiffLine} dl
   */
  _renderTextDetails(dl) {
    const side = this._currentSide;
    const lineNum = side === 'left' ? dl.leftLine : dl.rightLine;
    const raw = (side === 'left' ? dl.leftText : dl.rightText) ?? '';

    const head = document.createElement('div');
    head.className = 'tc-details__head';
    head.textContent = lineNum == null
      ? `${side === 'left' ? '左' : '右'}側：此行不存在（對側新增）`
      : `${side === 'left' ? '左' : '右'}側 第 ${lineNum} 行`;

    const ta = document.createElement('textarea');
    ta.className = 'tc-details__text';
    ta.spellcheck = false;
    ta.value = raw.replace(/\r?\n$/, '');
    const locked = lineNum == null || this.isSideReadOnly(side);
    ta.readOnly = locked;
    if (locked) ta.title = lineNum == null ? '此側沒有對應的行' : '此側已鎖定';

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'tc-details__apply';
    apply.textContent = '套用';
    apply.disabled = locked;
    this._on(apply, 'click', () => {
      if (lineNum == null) return;
      if (!this._guardWrite(side)) return;
      this._pushUndoSnapshot();
      const key = side === 'left' ? '_leftContent' : '_rightContent';
      // _spliceLine replaces the line *including* its terminator, so the
      // original one has to be carried over or the next line gets glued on.
      const eol = /\r?\n$/.exec(raw)?.[0] ?? '';
      this[key] = _spliceLine(this[key], lineNum - 1, ta.value + eol);
      this._modified[side] = true;
      this._updateModifiedIndicator();
      this._runDiff();
    });

    this._detailsBody.append(head, ta, apply);
  }

  /**
   * Hex Details — read-only byte view of the current line.
   * @param {import('../core/diff-engine.js').DiffLine} dl
   */
  _renderHexDetails(dl) {
    const side = this._currentSide;
    const raw = ((side === 'left' ? dl.leftText : dl.rightText) ?? '').replace(/\r?\n$/, '');
    const bytes = new TextEncoder().encode(raw);

    const head = document.createElement('div');
    head.className = 'tc-details__head';
    const lineNum = side === 'left' ? dl.leftLine : dl.rightLine;
    head.textContent = `${side === 'left' ? '左' : '右'}側 第 ${lineNum ?? '—'} 行　${bytes.length} 位元組（UTF-8）`;

    const pre = document.createElement('pre');
    pre.className = 'tc-details__hex';
    // One line's bytes only — capped so a pathological single line cannot
    // build a giant DOM node here either.
    const LIMIT = 4096;
    const shown = bytes.subarray(0, LIMIT);
    const rows = [];
    for (let off = 0; off < shown.length; off += 16) {
      const chunk = shown.subarray(off, off + 16);
      const hex = [...chunk].map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
      const ascii = [...chunk].map(b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
      rows.push(`${off.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
    }
    if (bytes.length > LIMIT) rows.push(`… 其餘 ${bytes.length - LIMIT} 位元組未顯示`);
    pre.textContent = rows.join('\n') || '(空行)';

    this._detailsBody.append(head, pre);
  }

  /**
   * Alignment Details — why these two lines were paired.
   * @param {import('../core/diff-engine.js').DiffLine} dl
   */
  _renderAlignmentDetails(dl) {
    const lText = (dl.leftText ?? '').replace(/\r?\n$/, '');
    const rText = (dl.rightText ?? '').replace(/\r?\n$/, '');
    const lTok = this._tokensForLine('left', dl.leftLine);
    const rTok = this._tokensForLine('right', dl.rightLine);

    const TYPE_LABEL = {
      equal: '相同 — 兩行內容一致，直接配對',
      replace: '變更 — 演算法認為這兩行互相對應',
      insert: '僅右側 — 左側沒有可配對的行',
      delete: '僅左側 — 右側沒有可配對的行',
    };

    /** Rough similarity, the same signal the algorithm optimises for. */
    const similarity = () => {
      if (!lText && !rText) return 1;
      const a = lText, b = rText;
      const shorter = a.length < b.length ? a : b;
      const longer = a.length < b.length ? b : a;
      if (longer.length === 0) return 1;
      let same = 0;
      for (let i = 0; i < shorter.length; i++) if (a[i] === b[i]) same++;
      return same / longer.length;
    };

    const rows = [
      ['對齊結果', TYPE_LABEL[dl.type] ?? dl.type],
      ['演算法', this._opts.algorithm],
      ['左行號 / 右行號', `${dl.leftLine ?? '—'} / ${dl.rightLine ?? '—'}`],
      ['行權重（左 / 右）', `${this.getLineWeight('left', dl.leftLine).toFixed(1)} / ${this.getLineWeight('right', dl.rightLine).toFixed(1)}`],
      ['字元相似度', `${Math.round(similarity() * 100)} %`],
      ['文法元素（左）', elementsOf(lTok).join('、') || '—'],
      ['文法元素（右）', elementsOf(rTok).join('、') || '—'],
      ['忽略中的元素', [...this._grammarIgnored].join('、') || '（無）'],
      ['忽略元素後是否相同', this._grammarIgnored.size === 0
        ? '（未啟用）'
        : (linesEqualIgnoringElements(lText, rText, lTok, rTok, this._grammarIgnored) ? '是' : '否')],
      ['判定', dl.manualIgnored ? '手動標記為忽略' : (dl.unimportant ? '不重要差異（藍色）' : (dl.type === 'equal' ? '相同' : '重要差異（紅色）'))],
    ];

    if (this._grammarTruncated) {
      rows.push(['注意', '檔案過大或行過長，文法解析已提前停止，元素資訊可能不完整']);
    }

    const table = document.createElement('dl');
    table.className = 'tc-details__align';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = String(v);
      table.append(dt, dd);
    }
    this._detailsBody.appendChild(table);
  }

  /**
   * Remember which row/side the user is on and refresh the Details panels.
   * @param {number} rowIdx
   * @param {'left'|'right'} [side]
   */
  _setCurrentRow(rowIdx, side) {
    if (Number.isInteger(rowIdx) && rowIdx >= 0) this._currentRowIdx = rowIdx;
    if (side === 'left' || side === 'right') this._currentSide = side;
    this._syncCaretFromRow();
    this._updateDetails();
  }

  // -------------------------------------------------------------------------
  // 1.4 / 1.5 — caret model
  //
  // "Where the user is" has to be a file line number, not a row index: _rows
  // is rebuilt by every re-diff and only a window of it exists in the DOM.
  // -------------------------------------------------------------------------

  /**
   * Refresh `_caret` from `_currentRowIdx`.
   *
   * A row that exists on one side only (insert/delete) has no line number
   * there, so that side falls back to the nearest preceding real line — that
   * is the line an "insert after" or an indent has to act on.
   */
  _syncCaretFromRow() {
    for (const side of /** @type {Array<'left'|'right'>} */ (['left', 'right'])) {
      const key = side === 'left' ? 'leftLine' : 'rightLine';
      let found = null;
      for (let i = this._currentRowIdx; i >= 0; i--) {
        const row = this._rows[i];
        if (!row || row.kind !== 'line') continue;
        const n = row.diffLine[key];
        if (n != null) { found = n; break; }
      }
      if (found != null) this._caret[side] = found;
    }
  }

  /** The pane the user last interacted with. @returns {'left'|'right'} */
  activeSide() {
    return this._currentSide === 'right' ? 'right' : 'left';
  }

  /** The pane the user is *not* on — BC's "other side". @returns {'left'|'right'} */
  otherSide() {
    return this.activeSide() === 'left' ? 'right' : 'left';
  }

  /**
   * Caret line on one side, 1-based, or null when nothing has been focused.
   * @param {'left'|'right'} [side] defaults to the active side
   * @returns {number|null}
   */
  caretLine(side) {
    return this._caret[side ?? this.activeSide()] ?? null;
  }

  /**
   * Move the caret to a file line and bring it into view.
   * @param {'left'|'right'} side
   * @param {number} line 1-based
   * @returns {boolean} whether a matching row was found
   */
  setCaret(side, line) {
    if (!Number.isInteger(line) || line < 1) return false;
    this._currentSide = side === 'right' ? 'right' : 'left';
    this._caret[this._currentSide] = line;
    const rowIdx = this._rowIndexForLine(this._currentSide, line);
    if (rowIdx < 0) {
      this._updateDetails();
      return false;
    }
    this._currentRowIdx = rowIdx;
    this._lastClickedRow = rowIdx;
    this._scrollRowIntoView(rowIdx);
    this._updateDetails();
    return true;
  }

  /**
   * Row index showing a given file line, or -1.
   * @param {'left'|'right'} side
   * @param {number} line 1-based
   * @returns {number}
   */
  _rowIndexForLine(side, line) {
    const key = side === 'left' ? 'leftLine' : 'rightLine';
    for (let i = 0; i < this._rows.length; i++) {
      const row = this._rows[i];
      if (row.kind === 'line' && row.diffLine[key] === line) return i;
    }
    return -1;
  }

  /**
   * Put `_currentRowIdx` back on the caret line after a re-diff renumbered
   * the rows. Falls back to the nearest earlier line so a caret that sat on a
   * line the edit deleted still lands somewhere sensible.
   */
  _restoreCaretRow() {
    const side = this.activeSide();
    const line = this._caret[side];
    if (line == null) return;
    for (let n = line; n >= 1; n--) {
      const idx = this._rowIndexForLine(side, n);
      if (idx >= 0) {
        this._currentRowIdx = idx;
        this._caret[side] = n;
        this._syncCaretFromRow();
        return;
      }
    }
  }

  /**
   * Scroll a row into view without disturbing the horizontal position.
   * @param {number} rowIdx
   */
  _scrollRowIntoView(rowIdx) {
    const pane = this._contentLeft;
    if (!pane || typeof pane.scrollTop !== 'number') return;
    const top = rowIdx * this._rowHeight;
    const viewH = pane.clientHeight || 0;
    const cur = pane.scrollTop;
    if (top >= cur && top + this._rowHeight <= cur + viewH) return;
    const target = Math.max(0, top - Math.floor(viewH / 3));
    pane.scrollTop = target;
    if (this._contentRight) this._contentRight.scrollTop = target;
    this._renderVisibleRows();
  }

  /**
   * Column of the DOM selection inside a rendered row's text span, so
   * Delete Word / Delete to Start-or-End of Line have something to act on.
   * Falls back to 0 when the click did not land in text.
   * @param {HTMLElement} rowEl
   * @returns {number}
   */
  _caretColumnIn(rowEl) {
    const textSpan = rowEl.querySelector('.line-text');
    const sel = window.getSelection?.();
    const node = sel?.anchorNode;
    if (!textSpan || !node || !textSpan.contains(node)) return 0;
    // Sum the text before the anchor node, which is what "column" means once
    // syntax highlighting has split the line into many spans.
    const walker = document.createTreeWalker(textSpan, NodeFilter.SHOW_TEXT);
    let col = 0;
    let cur = walker.nextNode();
    while (cur) {
      if (cur === node) return col + (sel.anchorOffset ?? 0);
      col += cur.nodeValue?.length ?? 0;
      cur = walker.nextNode();
    }
    return col;
  }

  // -------------------------------------------------------------------------
  // 1.4 / 1.5 — one table, two entry points
  //
  // The keyboard handler and the context menu are both generated from
  // editCommands(). A command added here therefore cannot end up reachable
  // from neither: there is no second list to forget to update.
  // -------------------------------------------------------------------------

  /**
   * Every BC Edit/Search command this view implements.
   * @returns {Array<{ id: string, label: string, combo: string,
   *   run: () => void, disabled?: boolean }>}
   */
  editCommands() {
    const other = this.otherSide() === 'left' ? '左' : '右';
    const active = this.activeSide() === 'left' ? '左' : '右';
    const locked = this.isSideReadOnly(this.activeSide());
    return [
      { id: 'text.copyLineRight', label: '複製此行 → 右側', combo: 'Alt+Shift+ArrowRight',
        disabled: this.isSideReadOnly('right'), run: () => this.copyLineToRight() },
      { id: 'text.copyLineLeft', label: '複製此行 → 左側', combo: 'Alt+Shift+ArrowLeft',
        disabled: this.isSideReadOnly('left'), run: () => this.copyLineToLeft() },
      { id: 'text.copyLineOther', label: `複製此行 → 另一側（${other}）`, combo: 'Alt+Shift+o',
        disabled: this.isSideReadOnly(this.otherSide()), run: () => this.copyLineToOtherSide() },
      { id: 'text.copyOtherSide', label: `複製此差異 → 另一側（${other}）`, combo: 'Alt+o',
        disabled: this.isSideReadOnly(this.otherSide()), run: () => this.copyToOtherSide() },

      { id: 'text.insertLineBefore', label: `在此行前插入空行（${active}側）`, combo: 'Ctrl+Shift+Enter',
        disabled: locked, run: () => this.insertLineBefore() },
      { id: 'text.insertLineAfter', label: `在此行後插入空行（${active}側）`, combo: 'Ctrl+Enter',
        disabled: locked, run: () => this.insertLineAfter() },
      { id: 'text.deleteLine', label: `刪除此行（${active}側）`, combo: 'Ctrl+d',
        disabled: locked, run: () => this.deleteLine() },
      { id: 'text.deleteToStartOfLine', label: '刪除到行首', combo: 'Ctrl+Shift+Backspace',
        disabled: locked, run: () => this.deleteToStartOfLine() },
      { id: 'text.deleteToEndOfLine', label: '刪除到行尾', combo: 'Ctrl+Shift+Delete',
        disabled: locked, run: () => this.deleteToEndOfLine() },
      { id: 'text.deleteWord', label: '刪除單字', combo: 'Ctrl+Delete',
        disabled: locked, run: () => this.deleteWord() },

      { id: 'text.increaseIndent', label: '增加縮排', combo: 'Ctrl+]',
        disabled: locked, run: () => this.increaseIndent() },
      { id: 'text.decreaseIndent', label: '減少縮排', combo: 'Ctrl+[',
        disabled: locked, run: () => this.decreaseIndent() },

      { id: 'text.selectSection', label: '選取此差異區塊', combo: 'Alt+s',
        run: () => this.selectSection() },
      { id: 'text.selectAll', label: '全選', combo: 'Ctrl+a',
        run: () => this.selectAll() },

      { id: 'text.nextInlineDiff', label: '下一個行內差異', combo: 'Ctrl+F8',
        run: () => this.nextInlineDiff() },
      { id: 'text.prevInlineDiff', label: '上一個行內差異', combo: 'Ctrl+F7',
        run: () => this.prevInlineDiff() },
      { id: 'text.nextEdit', label: '下一個編輯位置', combo: 'Alt+F8',
        run: () => this.nextEdit() },
      { id: 'text.prevEdit', label: '上一個編輯位置', combo: 'Alt+F7',
        run: () => this.prevEdit() },

      { id: 'text.alignWith', label: this._pendingAlign
          ? `完成對齊（已標記${this._pendingAlign.side === 'left' ? '左' : '右'}側第 ${this._pendingAlign.line} 行）`
          : '設為對齊錨點（Align With）',
        combo: 'Ctrl+Alt+a', run: () => this.markAlignAnchor() },
      { id: 'text.clearAlignAnchors', label: `清除所有對齊錨點（${this._alignAnchors.length}）`,
        combo: 'Ctrl+Alt+Shift+a', disabled: this._alignAnchors.length === 0,
        run: () => {
          const n = this.clearAlignAnchors();
          toast(`已清除 ${n} 個對齊錨點`, { type: 'success' });
        } },
      { id: 'text.isolate', label: this.isIsolated() ? '離開 Isolate' : 'Isolate（只比對選取的行）',
        combo: 'Ctrl+Alt+i', run: () => this.toggleIsolate() },
    ];
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {(() => void)|null}
   */
  _matchEditCommand(e) {
    for (const cmd of this.editCommands()) {
      if (keyComboMatches(e, cmd.combo)) return cmd.run;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 1.4 — Edit commands
  //
  // All of them funnel through _editSide() so that a locked side, the undo
  // stack, the modified marker, the edit-mode textarea and the caret can
  // never be handled inconsistently between one command and the next.
  // -------------------------------------------------------------------------

  /**
   * Apply a text transformation to one side.
   *
   * @param {'left'|'right'} side
   * @param {(text: string) => string} mutate
   * @param {{ markLine?: number|null, shiftAt?: number, shiftBy?: number }} [meta]
   *   `markLine` is remembered for Next/Previous Edit; `shiftAt`/`shiftBy`
   *   rebase the marks already recorded when lines were added or removed.
   * @returns {boolean} whether anything changed
   */
  _editSide(side, mutate, meta = {}) {
    if (!this._guardWrite(side)) return false;
    const key = side === 'left' ? '_leftContent' : '_rightContent';
    const before = this[key];
    let after;
    try {
      after = mutate(before);
    } catch (err) {
      toast(`編輯失敗：${err instanceof Error ? err.message : String(err)}`, { type: 'error' });
      return false;
    }
    if (typeof after !== 'string' || after === before) return false;

    this._pushUndoSnapshot();
    this[key] = after;
    this._modified[side] = true;

    // Edit mode shows a textarea, not the panes; leaving it stale would make
    // the next keystroke there resurrect the pre-command text.
    const ta = side === 'left' ? this._textareaLeft : this._textareaRight;
    if (ta) ta.value = after;

    if (meta.shiftBy) {
      this._editMarks[side] = rebaseEditMarks(this._editMarks[side], meta.shiftAt ?? 1, meta.shiftBy);
    }
    if (meta.markLine != null) {
      this._editMarks[side] = rebaseEditMarks([...this._editMarks[side], meta.markLine], 1, 0);
    }

    this._updateModifiedIndicator();
    this._runDiff();
    this._restoreCaretRow();
    return true;
  }

  /**
   * Rebuild one side from the diff result, taking the listed DiffLines from
   * the opposite side. Same rebuild _copyBlock does, at single-line
   * granularity: an insert row copied this way removes the target line, a
   * delete row inserts one, which is what makes "Copy Line" work on rows that
   * exist on one side only.
   *
   * @param {'left'|'right'} targetSide side to overwrite
   * @param {Set<object>} sourceLines DiffLine objects to take from the source
   * @returns {boolean}
   */
  _copyDiffLines(targetSide, sourceLines) {
    if (sourceLines.size === 0) return false;
    const sourceSide = targetSide === 'right' ? 'left' : 'right';
    return this._editSide(targetSide, () => {
      let out = '';
      for (const dl of this._diffResult) {
        const text = sourceLines.has(dl)
          ? (sourceSide === 'left' ? dl.leftText : dl.rightText)
          : (targetSide === 'left' ? dl.leftText : dl.rightText);
        if (text) out += text;
      }
      return out;
    }, { markLine: this._caret[targetSide] });
  }

  /** The DiffLine under the caret, or null. @returns {object|null} */
  _caretDiffLine() {
    const row = this._rows[this._currentRowIdx];
    return row && row.kind === 'line' ? row.diffLine : null;
  }

  /** Index of the caret's DiffLine within _diffResult, or -1. @returns {number} */
  _caretDiffIndex() {
    const dl = this._caretDiffLine();
    return dl ? this._diffResult.indexOf(dl) : -1;
  }

  /**
   * Copy just the caret's line to the other pane (BC "Copy Line to …").
   * @param {'left'|'right'} targetSide
   * @returns {boolean}
   */
  copyLineTo(targetSide) {
    const dl = this._caretDiffLine();
    if (!dl) {
      toast('請先點選一行', { type: 'warn' });
      return false;
    }
    if (!this._copyDiffLines(targetSide, new Set([dl]))) return false;
    toast(`已複製一行到${targetSide === 'left' ? '左' : '右'}側`, { type: 'success' });
    return true;
  }

  /** @returns {boolean} */
  copyLineToRight() { return this.copyLineTo('right'); }

  /** @returns {boolean} */
  copyLineToLeft() { return this.copyLineTo('left'); }

  /** Copy the caret's line to whichever pane the user is *not* on. @returns {boolean} */
  copyLineToOtherSide() { return this.copyLineTo(this.otherSide()); }

  /** Copy the current difference section to the non-active pane. */
  copyToOtherSide() { this._copyBlock(this.otherSide()); }

  /**
   * Insert a blank line relative to the caret.
   * @param {'before'|'after'} position
   * @returns {boolean}
   */
  insertLine(position) {
    const side = this.activeSide();
    const line = this.caretLine(side);
    if (line == null) {
      toast('請先點選一行', { type: 'warn' });
      return false;
    }
    const eol = (side === 'left' ? this._eolLeft : this._eolRight) === 'CRLF' ? '\r\n' : '\n';
    const at = position === 'before' ? line : line + 1;
    const ok = this._editSide(side, (text) => insertBlankLine(text, line - 1, position, eol),
      { shiftAt: at, shiftBy: 1, markLine: at });
    if (ok) this.setCaret(side, at);
    return ok;
  }

  /** @returns {boolean} */
  insertLineBefore() { return this.insertLine('before'); }

  /** @returns {boolean} */
  insertLineAfter() { return this.insertLine('after'); }

  /** Delete the caret's whole line. @returns {boolean} */
  deleteLine() {
    const side = this.activeSide();
    const line = this.caretLine(side);
    if (line == null) {
      toast('請先點選一行', { type: 'warn' });
      return false;
    }
    return this._editSide(side, (text) => removeLine(text, line - 1),
      { shiftAt: line, shiftBy: -1 });
  }

  /**
   * Delete part of the caret's line.
   * @param {'to-start'|'to-end'|'word'} what
   * @returns {boolean}
   */
  deleteInLine(what) {
    const side = this.activeSide();
    const line = this.caretLine(side);
    if (line == null) {
      toast('請先點選一行', { type: 'warn' });
      return false;
    }
    const col = this._caretCol;
    return this._editSide(side, (text) => {
      const lines = splitLinesKeepEol(text);
      const raw = lines[line - 1];
      if (raw === undefined) return text;
      const { body } = splitEol(raw);
      const c = Math.min(Math.max(col, 0), body.length);
      let next = body;
      if (what === 'to-start') next = body.slice(c);
      else if (what === 'to-end') next = body.slice(0, c);
      else {
        const { start, end } = wordBoundsAt(body, c);
        next = body.slice(0, start) + body.slice(end);
      }
      return replaceLineBody(text, line - 1, next);
    }, { markLine: line });
  }

  /** @returns {boolean} */
  deleteToStartOfLine() { return this.deleteInLine('to-start'); }

  /** @returns {boolean} */
  deleteToEndOfLine() { return this.deleteInLine('to-end'); }

  /** @returns {boolean} */
  deleteWord() { return this.deleteInLine('word'); }

  /**
   * Line range the command set should act on: the DOM selection when there is
   * one, otherwise the caret's single line.
   * @param {'left'|'right'} side
   * @returns {{ start: number, end: number }|null}
   */
  _commandRange(side) {
    const selected = this._selectedLineNumbers(side);
    if (selected.length > 0) return { start: selected[0], end: selected[selected.length - 1] };
    const line = this.caretLine(side);
    return line == null ? null : { start: line, end: line };
  }

  /**
   * Increase or decrease the indent of the selected lines (or the caret line).
   * @param {1|-1} delta
   * @returns {boolean}
   */
  changeIndent(delta) {
    const side = this._selectionSide() ?? this.activeSide();
    const range = this._commandRange(side);
    if (!range) {
      toast('請先選取或點選要縮排的行', { type: 'warn' });
      return false;
    }
    const ok = this._editSide(side,
      (text) => indentLines(text, range.start - 1, range.end - 1, delta, this._tabWidth, this._indentWithTabs),
      { markLine: range.start });
    if (!ok && !this.isSideReadOnly(side)) {
      toast(delta > 0 ? '沒有可縮排的內容' : '這些行已經沒有縮排', { type: 'warn' });
    }
    return ok;
  }

  /** @returns {boolean} */
  increaseIndent() { return this.changeIndent(1); }

  /** @returns {boolean} */
  decreaseIndent() { return this.changeIndent(-1); }

  /**
   * Indent step used by Increase/Decrease Indent and Convert File.
   * @param {number} width
   * @param {boolean} [useTabs]
   * @returns {number} the resulting width
   */
  setTabWidth(width, useTabs) {
    if (Number.isInteger(width) && width > 0 && width <= 16) this._tabWidth = width;
    if (typeof useTabs === 'boolean') this._indentWithTabs = useTabs;
    return this._tabWidth;
  }

  /** @returns {{ width: number, useTabs: boolean }} */
  getTabSettings() {
    return { width: this._tabWidth, useTabs: this._indentWithTabs };
  }

  // -------------------------------------------------------------------------
  // 1.4 — Selection commands
  // -------------------------------------------------------------------------

  /**
   * Select every rendered row of one pane.
   * @param {'left'|'right'} [side] defaults to the active side
   * @returns {boolean}
   */
  selectAll(side) {
    const pane = (side ?? this.activeSide()) === 'right' ? this._contentRight : this._contentLeft;
    const sel = window.getSelection?.();
    if (!pane || !sel || typeof document.createRange !== 'function') return false;
    const range = document.createRange();
    range.selectNodeContents(pane);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  /** Index of the difference block containing the caret, or -1. @returns {number} */
  _caretBlockIndex() {
    for (let i = 0; i < this._diffBlocks.length; i++) {
      const b = this._diffBlocks[i];
      if (this._currentRowIdx >= b.startRow && this._currentRowIdx <= b.endRow) return i;
    }
    return -1;
  }

  /**
   * BC "Select Section" — select the difference block the caret sits in.
   *
   * Virtual scrolling means only part of a long block is in the DOM, so the
   * block is scrolled into view first and the user is told when the selection
   * had to stop at the rendered edge rather than silently selecting less.
   *
   * @returns {boolean}
   */
  selectSection() {
    const idx = this._caretBlockIndex() >= 0 ? this._caretBlockIndex() : this._currentDiff;
    const block = this._diffBlocks[idx];
    if (!block) {
      toast('游標不在任何差異區塊內', { type: 'warn' });
      return false;
    }
    this._currentDiff = idx;
    this._scrollRowIntoView(block.startRow);
    this._renderVisibleRows();

    const pane = this.activeSide() === 'right' ? this._contentRight : this._contentLeft;
    const sel = window.getSelection?.();
    if (!pane || !sel || typeof document.createRange !== 'function') return false;
    const first = pane.querySelector(`[data-row-idx="${block.startRow}"]`);
    let lastRow = block.endRow;
    let last = pane.querySelector(`[data-row-idx="${lastRow}"]`);
    while (!last && lastRow > block.startRow) {
      lastRow -= 1;
      last = pane.querySelector(`[data-row-idx="${lastRow}"]`);
    }
    if (!first || !last) {
      toast('此差異區塊尚未渲染，請稍候再試', { type: 'warn' });
      return false;
    }
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    sel.removeAllRanges();
    sel.addRange(range);
    if (lastRow < block.endRow) {
      toast(`區塊過長，只選取到第 ${lastRow - block.startRow + 1} 行（畫面外的行尚未渲染）`, { type: 'warn' });
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 1.5 — In-line and edit navigation
  // -------------------------------------------------------------------------

  /**
   * Changed character runs inside one DiffLine, computed on demand and cached
   * on the DiffLine (a fresh diff hands out fresh objects, so the cache dies
   * with the data it describes).
   * @param {number} diffIndex
   * @returns {Array<{ leftStart: number, leftEnd: number, rightStart: number, rightEnd: number }>}
   */
  _segmentsAt(diffIndex) {
    const dl = this._diffResult[diffIndex];
    if (!dl || dl.type !== 'replace') return [];
    if (dl._charDiffs === undefined) {
      dl._charDiffs = diffChars(
        (dl.leftText ?? '').replace(/\r?\n$/, ''),
        (dl.rightText ?? '').replace(/\r?\n$/, ''),
      );
    }
    if (dl._inlineSegs === undefined) dl._inlineSegs = inlineSegments(dl._charDiffs);
    return dl._inlineSegs;
  }

  /**
   * BC's Next/Previous Difference: one changed run *inside* a line at a time,
   * not a whole section.
   * @param {number} dir +1 forward, -1 backward
   * @returns {boolean} whether the cursor moved
   */
  navigateInlineDiff(dir) {
    const step = dir >= 0 ? 1 : -1;
    const total = this._diffResult.length;
    if (total === 0) {
      toast('沒有可導覽的行內差異', { type: 'warn' });
      return false;
    }

    let di;
    let si;
    if (this._inlineCursor) {
      di = this._inlineCursor.diffIndex;
      si = this._inlineCursor.segIndex + step;
    } else {
      di = Math.max(0, this._caretDiffIndex());
      si = step > 0 ? 0 : this._segmentsAt(di).length - 1;
    }

    for (let guard = 0; guard <= total; guard++) {
      const segs = this._segmentsAt(di);
      if (si >= 0 && si < segs.length) {
        this._focusInlineSegment(di, si);
        return true;
      }
      di += step;
      if (di < 0 || di >= total) {
        toast(step > 0 ? '已到最後一個行內差異' : '已到第一個行內差異', { type: 'warn' });
        return false;
      }
      si = step > 0 ? 0 : this._segmentsAt(di).length - 1;
    }
    return false;
  }

  /**
   * @param {number} diffIndex
   * @param {number} segIndex
   */
  _focusInlineSegment(diffIndex, segIndex) {
    this._inlineCursor = { diffIndex, segIndex };
    const dl = this._diffResult[diffIndex];
    const side = this.activeSide();
    const line = side === 'left' ? dl.leftLine : dl.rightLine;
    const seg = this._segmentsAt(diffIndex)[segIndex];
    if (line != null) {
      // setCaret rebuilds the highlight through _renderVisibleRows.
      this._caretCol = side === 'left' ? seg.leftStart : seg.rightStart;
      this.setCaret(side, line);
    }
    this._renderVisibleRows();
    this._emit('status', {
      message: `行內差異 ${segIndex + 1}/${this._segmentsAt(diffIndex).length}　第 ${line ?? '—'} 行`,
    });
  }

  /** @returns {boolean} */
  nextInlineDiff() { return this.navigateInlineDiff(1); }

  /** @returns {boolean} */
  prevInlineDiff() { return this.navigateInlineDiff(-1); }

  /**
   * Paint the in-line difference cursor onto whichever rows are rendered.
   * Called from _renderVisibleRows so the mark survives scrolling away and
   * back — it lives in _inlineCursor, not in the DOM.
   */
  _paintInlineCursor() {
    const cls = 'char-diff--current';
    for (const pane of [this._contentLeft, this._contentRight]) {
      pane?.querySelectorAll?.('.' + cls)?.forEach(el => el.classList.remove(cls));
    }
    const cur = this._inlineCursor;
    if (!cur) return;
    const dl = this._diffResult[cur.diffIndex];
    if (!dl) return;
    const rowIdx = this._rows.findIndex(r => r.kind === 'line' && r.diffLine === dl);
    if (rowIdx < 0) return;

    const segs = this._segmentsAt(cur.diffIndex);
    const seg = segs[cur.segIndex];
    if (!seg) return;
    let leftNth = 0;
    let rightNth = 0;
    for (let i = 0; i < cur.segIndex; i++) {
      if (segs[i].leftEnd > segs[i].leftStart) leftNth++;
      if (segs[i].rightEnd > segs[i].rightStart) rightNth++;
    }
    /**
     * @param {Element|null} pane
     * @param {string} selector
     * @param {number} nth
     * @param {boolean} present
     */
    const mark = (pane, selector, nth, present) => {
      if (!present || !pane?.querySelector) return;
      const row = pane.querySelector(`[data-row-idx="${rowIdx}"]`);
      row?.querySelectorAll(selector)?.[nth]?.classList.add(cls);
    };
    mark(this._contentLeft, '.char-delete', leftNth, seg.leftEnd > seg.leftStart);
    mark(this._contentRight, '.char-insert', rightNth, seg.rightEnd > seg.rightStart);
  }

  /**
   * BC "Next Edit" / "Previous Edit" — jump between the lines this session's
   * edit commands touched on the active side.
   * @param {number} dir
   * @returns {boolean}
   */
  navigateEdit(dir) {
    const side = this.activeSide();
    const marks = this._editMarks[side];
    if (marks.length === 0) {
      toast(`${side === 'left' ? '左' : '右'}側還沒有編輯過的位置`, { type: 'warn' });
      return false;
    }
    const cur = this._caret[side] ?? 0;
    const target = dir >= 0
      ? marks.find(n => n > cur)
      : [...marks].reverse().find(n => n < cur);
    if (target == null) {
      toast(dir >= 0 ? '已到最後一個編輯位置' : '已到第一個編輯位置', { type: 'warn' });
      return false;
    }
    this.setCaret(side, target);
    return true;
  }

  /** @returns {boolean} */
  nextEdit() { return this.navigateEdit(1); }

  /** @returns {boolean} */
  prevEdit() { return this.navigateEdit(-1); }

  /** Lines the edit commands touched, for tests and for session settings. */
  getEditMarks() {
    return { left: [...this._editMarks.left], right: [...this._editMarks.right] };
  }

  // -------------------------------------------------------------------------
  // 1.4 — Align With
  // -------------------------------------------------------------------------

  /** @returns {AlignAnchor[]} */
  getAlignAnchors() {
    return this._alignAnchors.map(a => ({ ...a }));
  }

  /**
   * Pin a left line and a right line to the same row.
   *
   * Anchors that would cross an existing one have no valid alignment, so the
   * conflicting anchors are dropped and the user is told how many — silently
   * ignoring the new anchor would look like the command did nothing.
   *
   * @param {number} leftLine 1-based
   * @param {number} rightLine 1-based
   * @returns {boolean}
   */
  alignWith(leftLine, rightLine) {
    const leftCount = splitLinesKeepEol(this._leftContent).length;
    const rightCount = splitLinesKeepEol(this._rightContent).length;
    if (!Number.isInteger(leftLine) || !Number.isInteger(rightLine) ||
        leftLine < 1 || rightLine < 1 || leftLine > leftCount || rightLine > rightCount) {
      toast('對齊錨點的行號超出檔案範圍', { type: 'error' });
      return false;
    }
    const anchor = { left: leftLine, right: rightLine };
    const kept = this._alignAnchors.filter(a => !anchorsConflict(anchor, a));
    const dropped = this._alignAnchors.length - kept.length;
    this._alignAnchors = normaliseAnchors([...kept, anchor], leftCount, rightCount);
    this._pendingAlign = null;
    this._runDiff();
    this._restoreCaretRow();
    toast(dropped > 0
      ? `已對齊 左 ${leftLine} ↔ 右 ${rightLine}（取代了 ${dropped} 個衝突的錨點）`
      : `已對齊 左 ${leftLine} ↔ 右 ${rightLine}`, { type: 'success' });
    return true;
  }

  /**
   * Two-step entry point: the first call remembers one side's line, the second
   * call on the other side completes the pair.
   * @param {'left'|'right'} [side] defaults to the active side
   * @param {number} [line] defaults to the caret
   * @returns {boolean} true once a pair was formed
   */
  markAlignAnchor(side, line) {
    const s = side ?? this.activeSide();
    const l = line ?? this.caretLine(s);
    if (l == null) {
      toast('請先點選要對齊的行', { type: 'warn' });
      return false;
    }
    if (this._pendingAlign && this._pendingAlign.side !== s) {
      const left = s === 'left' ? l : this._pendingAlign.line;
      const right = s === 'right' ? l : this._pendingAlign.line;
      return this.alignWith(left, right);
    }
    this._pendingAlign = { side: s, line: l };
    toast(`已標記${s === 'left' ? '左' : '右'}側第 ${l} 行，請再於${s === 'left' ? '右' : '左'}側選一行完成對齊`);
    return false;
  }

  /** Drop every manual alignment. @returns {number} how many were removed */
  clearAlignAnchors() {
    const n = this._alignAnchors.length;
    this._alignAnchors = [];
    this._pendingAlign = null;
    if (n > 0) {
      this._runDiff();
      this._restoreCaretRow();
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // 1.4 — Isolate
  // -------------------------------------------------------------------------

  /** @returns {boolean} */
  isIsolated() { return this._isolateStack.length > 0; }

  /**
   * BC "Isolate" — compare only the selected lines.
   *
   * The selection on each side is used independently; a side with no
   * selection falls back to the caret's difference block so the command still
   * does something predictable when only one pane is selected in.
   *
   * @returns {boolean}
   */
  isolate() {
    if (this._modified.left || this._modified.right) {
      toast('請先儲存或還原未儲存的變更，再使用 Isolate', { type: 'warn' });
      return false;
    }
    let left = this._selectedLineNumbers('left').length > 0 ? this._commandRange('left') : null;
    let right = this._selectedLineNumbers('right').length > 0 ? this._commandRange('right') : null;
    if (!left && !right) {
      const block = this._diffBlocks[this._caretBlockIndex() >= 0 ? this._caretBlockIndex() : this._currentDiff];
      if (block) {
        const rows = this._rows.slice(block.startRow, block.endRow + 1)
          .filter(r => r.kind === 'line').map(r => r.diffLine);
        const ls = rows.map(d => d.leftLine).filter(n => n != null);
        const rs = rows.map(d => d.rightLine).filter(n => n != null);
        if (ls.length > 0) left = { start: ls[0], end: ls[ls.length - 1] };
        if (rs.length > 0) right = { start: rs[0], end: rs[rs.length - 1] };
      }
    }
    if (!left && !right) {
      toast('請先選取要單獨比對的行', { type: 'warn' });
      return false;
    }

    const { left: lt, right: rt } = isolateRanges(this._leftContent, this._rightContent, left, right);
    this._isolateStack.push({
      leftPath: this._leftPath,
      rightPath: this._rightPath,
      leftContent: this._leftContent,
      rightContent: this._rightContent,
      anchors: this._alignAnchors,
      editMarks: { left: [...this._editMarks.left], right: [...this._editMarks.right] },
      undoStack: this._undoStack,
      redoStack: this._redoStack,
      label: `${left ? `左 ${left.start}–${left.end}` : '左（無）'}　${right ? `右 ${right.start}–${right.end}` : '右（無）'}`,
    });
    this._alignAnchors = [];
    this._editMarks = { left: [], right: [] };
    this._undoStack = [];
    this._redoStack = [];
    this.setLeft(`isolate://${this._leftPath || '左'}`, lt);
    this.setRight(`isolate://${this._rightPath || '右'}`, rt);
    toast('已進入 Isolate；再按一次可返回完整檔案', { type: 'success' });
    return true;
  }

  /**
   * Leave Isolate and put the whole files back.
   * @returns {boolean}
   */
  endIsolate() {
    const snap = this._isolateStack.pop();
    if (!snap) {
      toast('目前不在 Isolate 模式', { type: 'warn' });
      return false;
    }
    // Isolated panes hold only a fragment, so edits made inside cannot be
    // merged back automatically. Say so rather than dropping them quietly.
    if ((this._modified.left || this._modified.right) &&
        typeof window.confirm === 'function' && !window.confirm('Isolate 期間的修改將被捨棄，確定返回？')) {
      this._isolateStack.push(snap);
      return false;
    }
    this._modified = { left: false, right: false };
    // setLeft/setRight clear the per-document state, so the snapshot has to be
    // put back afterwards, not before.
    this.setLeft(snap.leftPath, snap.leftContent);
    this.setRight(snap.rightPath, snap.rightContent);
    this._alignAnchors = snap.anchors;
    this._editMarks = snap.editMarks;
    this._undoStack = snap.undoStack;
    this._redoStack = snap.redoStack;
    if (this._alignAnchors.length > 0) this._runDiff();
    this._updateModifiedIndicator();
    toast('已離開 Isolate', { type: 'success' });
    return true;
  }

  /** Toggle Isolate — the shortcut and the menu item both use this. @returns {boolean} */
  toggleIsolate() {
    return this.isIsolated() ? this.endIsolate() : this.isolate();
  }

  // -------------------------------------------------------------------------
  // Private: emit
  // -------------------------------------------------------------------------

  /**
   * @param {string} event
   * @param {...unknown} args
   */
  _emit(event, ...args) {
    this._listeners.get(event)?.forEach(fn => fn(...args));
  }

  // -------------------------------------------------------------------------
  // Private: utilities
  // -------------------------------------------------------------------------

  /**
   * Extract lowercase extension from a file path.
   * @param {string} path
   * @returns {string}
   */
  _extFrom(path) {
    const parts = path.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  }
}
