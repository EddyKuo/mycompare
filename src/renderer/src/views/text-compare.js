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

import { diffLines, diffChars } from '../core/diff-engine.js';
import { showContextMenu } from '../core/context-menu.js';
import { SettingsStore } from '../core/settings-store.js';
import { renderTextTable, reportHeader, reportSummary } from '../core/report.js';
import { detectEol } from '../core/eol-detect.js';
import { isActive } from '../core/active-view.js';
import { stepDiffIndex, navResult, getNavOptions } from '../core/diff-nav.js';
import { tagConfig, readConfig } from '../core/named-config-store.js';
import { toast } from '../core/toast.js';
import {
  getGrammarForPath, tokenizeLines, maskLine, linesEqualIgnoringElements,
  lineWeight, elementsOf, getUserGrammars, setUserGrammars,
} from '../core/grammar.js';

/** @typedef {import('../core/diff-nav.js').NavResult} NavResult */

// ---------------------------------------------------------------------------
// Virtual scroll constants
// ---------------------------------------------------------------------------

/** Fixed row height in px — must match CSS line-height (1.5 × 13px ≈ 20px) */
const VS_ROW_HEIGHT = 20;

/** Rows to render above/below viewport to avoid scroll flicker */
const VS_OVERSCAN = 5;

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
// P2-25: unified diff (patch) parsing
//
// Pure, DOM-free functions so the format handling can be tested directly.
// Every malformed input raises UnifiedDiffParseError instead of producing a
// half-parsed result: a patch viewer that silently drops lines is worse than
// one that refuses the file, because the user cannot tell the difference.
// ---------------------------------------------------------------------------

/** Thrown by parseUnifiedDiff() when the input is not a well-formed patch. */
export class UnifiedDiffParseError extends Error {
  /**
   * @param {string} message
   * @param {number} [lineNumber] 1-based line of the offending input line
   */
  constructor(message, lineNumber) {
    super(lineNumber != null ? `${message}（第 ${lineNumber} 行）` : message);
    this.name = 'UnifiedDiffParseError';
    /** @type {number | null} */
    this.lineNumber = lineNumber ?? null;
  }
}

/**
 * @typedef {{ type: ' ' | '-' | '+', text: string, noNewline: boolean }} PatchLine
 * @typedef {{
 *   oldStart: number, oldCount: number,
 *   newStart: number, newCount: number,
 *   section: string,
 *   lines: PatchLine[],
 * }} PatchHunk
 * @typedef {{ oldPath: string, newPath: string, hunks: PatchHunk[] }} PatchFile
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse a unified diff / patch into a structured form.
 *
 * Supports multi-file patches, hunk headers with omitted counts
 * (`@@ -3 +3 @@` means one line), `\ No newline at end of file` markers, and
 * arbitrary preamble noise between files (`diff --git`, `index …`).
 *
 * @param {string} text raw patch contents
 * @returns {PatchFile[]}
 * @throws {UnifiedDiffParseError} on any malformed hunk header, truncated
 *   hunk, line-count mismatch, or input containing no hunk at all.
 */
export function parseUnifiedDiff(text) {
  if (typeof text !== 'string') {
    throw new UnifiedDiffParseError('patch 內容必須是字串');
  }

  const lines = text.split(/\r\n|\n|\r/);
  // A trailing newline yields one empty tail element that is an artefact of the
  // split, not a patch line; keeping it would let a truncated hunk consume it
  // as an empty context line and pass validation.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  /** @type {PatchFile[]} */
  const files = [];
  /** @type {PatchFile | null} */
  let current = null;
  let i = 0;

  /** @param {string} raw @returns {string} */
  const stripPathMeta = (raw) => raw.split('\t')[0].trim();

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next == null || !next.startsWith('+++ ')) {
        throw new UnifiedDiffParseError('`---` 檔頭之後缺少對應的 `+++` 檔頭', i + 1);
      }
      current = {
        oldPath: stripPathMeta(line.slice(4)),
        newPath: stripPathMeta(next.slice(4)),
        hunks: [],
      };
      files.push(current);
      i += 2;
      continue;
    }

    if (line.startsWith('@@')) {
      const m = HUNK_HEADER_RE.exec(line);
      if (!m) {
        throw new UnifiedDiffParseError(`無法解析的 hunk 標頭：${line}`, i + 1);
      }
      if (!current) {
        // A bare hunk with no file header is legal `diff -u` fragment output.
        current = { oldPath: '(old)', newPath: '(new)', hunks: [] };
        files.push(current);
      }
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      i += 1;

      /** @type {PatchLine[]} */
      const hunkLines = [];
      let oldRemaining = oldCount;
      let newRemaining = newCount;

      while (oldRemaining > 0 || newRemaining > 0) {
        if (i >= lines.length) {
          throw new UnifiedDiffParseError(
            `hunk 在檔案結束前被截斷（還缺 ${oldRemaining} 行原始、${newRemaining} 行新增）`,
            i,
          );
        }
        const raw = lines[i];
        if (raw.startsWith('\\')) {
          if (hunkLines.length === 0) {
            throw new UnifiedDiffParseError('`\\ No newline` 標記前沒有任何 hunk 行', i + 1);
          }
          hunkLines[hunkLines.length - 1].noNewline = true;
          i += 1;
          continue;
        }
        // Many tools strip the trailing space of an empty context line.
        const marker = raw === '' ? ' ' : raw[0];
        const body = raw === '' ? '' : raw.slice(1);

        if (marker === ' ') {
          if (oldRemaining <= 0 || newRemaining <= 0) {
            throw new UnifiedDiffParseError('hunk 內容行數超過標頭宣告的行數', i + 1);
          }
          oldRemaining -= 1;
          newRemaining -= 1;
        } else if (marker === '-') {
          if (oldRemaining <= 0) {
            throw new UnifiedDiffParseError('hunk 的刪除行數超過標頭宣告的原始行數', i + 1);
          }
          oldRemaining -= 1;
        } else if (marker === '+') {
          if (newRemaining <= 0) {
            throw new UnifiedDiffParseError('hunk 的新增行數超過標頭宣告的新增行數', i + 1);
          }
          newRemaining -= 1;
        } else {
          throw new UnifiedDiffParseError(`hunk 內出現無法解析的行：${raw}`, i + 1);
        }

        hunkLines.push({ type: marker, text: body, noNewline: false });
        i += 1;
      }

      // A `\ No newline` marker may also sit immediately after the last line.
      if (i < lines.length && lines[i].startsWith('\\') && hunkLines.length > 0) {
        hunkLines[hunkLines.length - 1].noNewline = true;
        i += 1;
      }

      // A body-looking line immediately after a satisfied hunk means the
      // header under-declared its counts. Silently treating it as preamble
      // would drop real content, so it is an error. `--- `/`+++ ` are file
      // headers, and a bare empty line is a common inter-hunk separator.
      const after = lines[i];
      if (after != null && after !== '' &&
          (after[0] === ' ' || after[0] === '-' || after[0] === '+') &&
          !after.startsWith('--- ') && !after.startsWith('+++ ')) {
        throw new UnifiedDiffParseError(
          'hunk 內容行數超過標頭宣告的行數', i + 1,
        );
      }

      current.hunks.push({
        oldStart, oldCount, newStart, newCount,
        section: m[5] ?? '',
        lines: hunkLines,
      });
      continue;
    }

    // Anything else between hunks (`diff --git`, `index …`, prose) is preamble.
    i += 1;
  }

  const totalHunks = files.reduce((sum, f) => sum + f.hunks.length, 0);
  if (totalHunks === 0) {
    throw new UnifiedDiffParseError('內容中找不到任何 unified diff hunk');
  }

  return files;
}

/**
 * Reconstruct the "before" and "after" text a patch describes.
 *
 * A patch only carries the hunk neighbourhoods, so the result is not the whole
 * file. Skipped regions and file/hunk headers are emitted identically on both
 * sides, which makes the diff engine render them as context and keeps the two
 * panes aligned.
 *
 * @param {PatchFile[]} files output of parseUnifiedDiff()
 * @returns {{ oldText: string, newText: string }}
 */
export function buildPatchSides(files) {
  /** @type {string[]} */
  const oldLines = [];
  /** @type {string[]} */
  const newLines = [];
  /** @param {string} s */
  const both = (s) => { oldLines.push(s); newLines.push(s); };

  for (const file of files) {
    if (oldLines.length > 0) both('');
    both(`═══ ${file.oldPath} → ${file.newPath} ═══`);
    for (const hunk of file.hunks) {
      both(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${hunk.section}`);
      for (const l of hunk.lines) {
        if (l.type === ' ') { oldLines.push(l.text); newLines.push(l.text); }
        else if (l.type === '-') oldLines.push(l.text);
        else newLines.push(l.text);
      }
    }
  }

  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
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
// TextCompare class
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   algorithm?: 'myers' | 'patience',
 *   ignoreWhitespace?: boolean,
 *   ignoreCase?: boolean,
 *   ignoreLineEndings?: boolean,
 *   contextLines?: number,
 * }} TextCompareOptions
 */

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
    };

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
    this._runDiff();
    return true;
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
    };
    document.addEventListener('keydown', this._onKeyDownBookmark);

    // P1-19 / P2-30 / P2-25 shortcuts. These are deliberately not routed
    // through app.js's SettingsStore bindings — they are text-view-only and
    // need the live DOM selection, which only this view can resolve.
    this._onKeyDownTextGaps = (e) => {
      if (!this._mounted || !isActive('text')) return;
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        void this.compareSelectionToClipboard();
      } else if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        void this.openPatchFile();
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        this.toggleIgnoreSelection();
      }
    };
    document.addEventListener('keydown', this._onKeyDownTextGaps);

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

    this._on(ta, 'input', () => {
      // A locked side keeps its textarea readOnly, but a paste through the
      // native menu can still land here; drop the change and say why.
      if (this.isSideReadOnly(side)) {
        ta.value = side === 'left' ? this._leftContent : this._rightContent;
        this._guardWrite(side);
        return;
      }
      const timerKey = side === 'left' ? '_editTimerLeft' : '_editTimerRight';
      clearTimeout(this[timerKey]);
      this[timerKey] = setTimeout(() => {
        if (side === 'left') {
          this._leftContent = ta.value;
          this._modified.left = true;
        } else {
          this._rightContent = ta.value;
          this._modified.right = true;
        }
        this._updateModifiedIndicator();
        this._runDiff();
      }, 300);
    });

    return ta;
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
    const result = await window.electronAPI.saveFile(
      this._leftPath || 'left.txt', this._leftContent, filters,
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
    const result = await window.electronAPI.saveFile(
      this._rightPath || 'right.txt', this._rightContent, filters,
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
  setLeft(path, content, encoding) {
    // T33: unwatch old path before switching
    if (this._leftPath && this._leftPath !== path) {
      _unwatch(this._leftPath);
    }
    this._leftPath = path;
    this._leftContent = content;
    if (encoding) this._encodingLeft = encoding;
    this._eolLeft = detectEol(content); // T01
    this._resolveGrammars();
    if (this._pathLeft) this._pathLeft.textContent = path || '（未選擇）';
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath });
    // T33: start watching the new file path (if it's a real file path)
    _watch(path);
    this._runDiff({ resetScroll: true });
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
  setRight(path, content, encoding) {
    // T33: unwatch old path before switching
    if (this._rightPath && this._rightPath !== path) {
      _unwatch(this._rightPath);
    }
    this._rightPath = path;
    this._rightContent = content;
    if (encoding) this._encodingRight = encoding;
    this._eolRight = detectEol(content); // T01
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
    if (side === 'left') this.setLeft(result.path, result.content, result.encoding);
    else this.setRight(result.path, result.content, result.encoding);
    return true;
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
      this._diffResult = diffLines(this._leftContent, this._rightContent, {
        algorithm: this._opts.algorithm,
        ignoreWhitespace: this._opts.ignoreWhitespace,
        ignoreCase: this._opts.ignoreCase,
        ignoreLineEndings: this._opts.ignoreLineEndings,
        ignoreIndent: this._opts.ignoreIndent,
        ignoreCrlf: this._opts.ignoreCrlf,
      });
    }

    // P2-29: grammar tokens must exist before importance is decided.
    this._computeGrammarTokens();

    // Apply ignore / unimportant patterns
    this._applyIgnorePatterns();

    // Fold state is expressed as _diffResult index ranges, which a fresh diff
    // invalidates.
    this._expandedRuns.clear();

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
    this._emit('diff-count', { total: this._diffBlocks.length, currentIndex: this._currentDiff });
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
      dl.manualIgnored = manual
      dl.grammarIgnored = !manual && this._grammarUnimportant(dl)
      dl.unimportant = manual || dl.grammarIgnored ||
        (unimportantRe.length > 0 && unimportantRe.some(re => re.test(text)))
      // BC's "Ignore Unimportant Differences" downgrades these to equal rather
      // than merely tinting them blue, which is what makes a file with only
      // cosmetic changes read as identical.
      if (dl.unimportant && this._opts.ignoreUnimportant) dl.type = 'equal'
    }
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
      readOnlyLeft:       this._readOnly.left,
      readOnlyRight:      this._readOnly.right,
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
    const known = ['algorithm','ignoreWhitespace','ignoreCase','ignoreLineEndings','contextLines','ignorePatterns','unimportantPatterns','ignoreUnimportant']
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
      return cls;
    };

    const ws = this._showWhitespace;

    switch (dl.type) {
      case 'equal': {
        const html = buildLineHTML(dl.leftText, 'equal', 'left', null, this._hlLeft, ws);
        const leftEl = createLineEl({
          cssClass: '',
          lineNum: dl.leftLine,
          innerHtml: html,
          dataLeft: dl.leftLine,
          dataRight: dl.rightLine,
        });
        const rightEl = createLineEl({
          cssClass: '',
          lineNum: dl.rightLine,
          innerHtml: buildLineHTML(dl.rightText, 'equal', 'right', null, this._hlRight, ws),
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
          innerHtml: buildLineHTML(dl.rightText, 'insert', 'right', null, this._hlRight, ws),
          dataRight: dl.rightLine,
        });
        return { leftEl, rightEl };
      }

      case 'delete': {
        const leftEl = createLineEl({
          cssClass: uiClass('delete'),
          lineNum: dl.leftLine,
          innerHtml: buildLineHTML(dl.leftText, 'delete', 'left', null, this._hlLeft, ws),
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
          innerHtml: buildLineHTML(dl.leftText, 'replace', 'left', charDiffs, this._hlLeft, ws),
          dataLeft: dl.leftLine,
          dataRight: dl.rightLine,
        });
        const rightEl = createLineEl({
          cssClass: uiClass('replace'),
          lineNum: dl.rightLine,
          innerHtml: buildLineHTML(dl.rightText, 'replace', 'right', charDiffs, this._hlRight, ws),
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

  _buildMinimap() {
    if (!this._minimap) return;

    // Remove all marks (keep only the viewport indicator)
    const viewport = this._minimapViewport;
    this._minimap.replaceChildren(viewport);

    const totalRows = this._rows.length;
    if (totalRows === 0) return;

    const mmHeight = this._minimap.clientHeight || 400;

    // Group consecutive diff rows into minimap marks
    let i = 0;
    while (i < this._rows.length) {
      const row = this._rows[i];
      if (row.kind === 'collapsed' || row.diffLine?.type === 'equal') {
        i++;
        continue;
      }

      const blockStart = i;
      let blockType = row.diffLine.type;
      while (
        i < this._rows.length &&
        this._rows[i].kind === 'line' &&
        this._rows[i].diffLine.type !== 'equal'
      ) {
        // Upgrade type priority: replace > delete > insert
        const t = this._rows[i].diffLine.type;
        if (t === 'replace') blockType = 'replace';
        else if (t === 'delete' && blockType !== 'replace') blockType = 'delete';
        i++;
      }
      const blockEnd = i - 1;

      const topFrac  = blockStart / totalRows;
      const heightFrac = Math.max(2 / mmHeight, (blockEnd - blockStart + 1) / totalRows);

      const mark = document.createElement('div');
      mark.className = `minimap-mark ${blockType}`;
      mark.style.top    = `${topFrac * mmHeight}px`;
      mark.style.height = `${heightFrac * mmHeight}px`;
      this._minimap.appendChild(mark);
    }

    this._updateMinimapViewport();
  }

  _updateMinimapViewport() {
    if (!this._minimapViewport || !this._contentLeft) return;

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
      const { hidden } = this.getFilterCounts();
      this._statusLines.textContent = hidden > 0
        ? `${totalLines} 行（已隱藏 ${hidden}）`
        : `${totalLines} 行`;
    }
    if (this._statusEncoding) {
      this._statusEncoding.textContent = this._encodingLeft === this._encodingRight
        ? this._encodingLeft
        : `${this._encodingLeft} / ${this._encodingRight}`;
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
    const mmHeight = this._minimap.clientHeight;
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
      {
        label: '全選',
        action: () => {
          const el = side === 'left' ? this._contentLeft : this._contentRight;
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      },
    ];

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

    // T43: Bookmark items
    items.push({ separator: true });
    items.push({ label: '切換書籤 (Ctrl+F2)', action: () => this._toggleBookmark(this._lastClickedRow ?? 0) });
    items.push({ label: '清除所有書籤', action: () => { this._bookmarks.clear(); this._renderVisibleRows(); } });

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
    }

    // P3: view panels
    items.push({ separator: true });
    items.push({ label: (this._detailsMode === 'text' ? '✓ ' : '　') + '詳細資料：文字（可編輯）',
      action: () => this.setDetailsMode(this._detailsMode === 'text' ? null : 'text') });
    items.push({ label: (this._detailsMode === 'hex' ? '✓ ' : '　') + '詳細資料：Hex（唯讀）',
      action: () => this.setDetailsMode(this._detailsMode === 'hex' ? null : 'hex') });
    items.push({ label: (this._detailsMode === 'alignment' ? '✓ ' : '　') + '詳細資料：對齊決策',
      action: () => this.setDetailsMode(this._detailsMode === 'alignment' ? null : 'alignment') });
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
  _convertFile(side, op) {
    if (!this._guardWrite(side)) return;
    const TAB_WIDTH = 4;

    /**
     * @param {string} text
     * @returns {string}
     */
    const transform = (text) => {
      switch (op) {
        case 'trim':
          return text.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
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
    const left = this._leftPath ? getGrammarForPath(this._leftPath) : null;
    const right = this._rightPath ? getGrammarForPath(this._rightPath) : null;
    this._grammarLeft = left ?? right;
    this._grammarRight = right ?? left;
  }

  /** Whether anything currently needs grammar tokens. */
  _grammarNeeded() {
    return this._grammarIgnored.size > 0 || this._detailsMode === 'alignment';
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
    this._updateDetails();
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
