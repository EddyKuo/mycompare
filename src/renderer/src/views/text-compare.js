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
import { detectEol } from '../core/eol-detect.js';
import { isActive } from '../core/active-view.js';

// ---------------------------------------------------------------------------
// Virtual scroll constants
// ---------------------------------------------------------------------------

/** Fixed row height in px — must match CSS line-height (1.5 × 13px ≈ 20px) */
const VS_ROW_HEIGHT = 20;

/** Rows to render above/below viewport to avoid scroll flicker */
const VS_OVERSCAN = 5;

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
function createCollapsedEl(start, end, count) {
  const div = document.createElement('div');
  div.className = 'diff-line collapsed';
  div.dataset.expandStart = String(start);
  div.dataset.expandEnd = String(end);
  div.textContent = `── ${count} 行相同（點擊展開）──`;
  return div;
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
    /** @type {Required<TextCompareOptions>} */
    this._opts = {
      algorithm: options.algorithm ?? 'myers',
      ignoreWhitespace: options.ignoreWhitespace ?? false,
      ignoreCase: options.ignoreCase ?? false,
      ignoreLineEndings: options.ignoreLineEndings ?? false,
      contextLines: options.contextLines ?? 6,
      ignorePatterns: options.ignorePatterns ?? [],
      unimportantPatterns: options.unimportantPatterns ?? [],
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

    // T50: Layout mode toggle
    /** @type {'side-by-side' | 'over-under'} */
    this._layoutMode = 'side-by-side';

    this._mounted = false;
  }

  // -------------------------------------------------------------------------
  // Mount / destroy
  // -------------------------------------------------------------------------

  /** Attach to existing DOM elements and wire up event listeners. */
  mount() {
    if (this._mounted) return;

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
    this._contentLeft.addEventListener('scroll', this._onScrollLeft);
    this._contentRight.addEventListener('scroll', this._onScrollRight);

    // Minimap click-to-jump
    this._minimap.addEventListener('click', this._onMinimapClick);

    // Collapsed-section expand (event delegation)
    this._contentLeft.addEventListener('click', this._onContentClick);
    this._contentRight.addEventListener('click', this._onContentClick);

    // Context menu
    this._onContextMenuLeft  = (e) => this._handleContextMenu(e, 'left');
    this._onContextMenuRight = (e) => this._handleContextMenu(e, 'right');
    this._contentLeft.addEventListener('contextmenu',  this._onContextMenuLeft);
    this._contentRight.addEventListener('contextmenu', this._onContextMenuRight);

    // Build edit textarea overlays
    this._textareaLeft  = this._createEditTextarea('left');
    this._textareaRight = this._createEditTextarea('right');

    // ── T08: ignoreLineEndings / ignoreWhitespace / ignoreCase checkboxes ──
    const chkIgnoreLineEndings = document.getElementById('chk-ignore-line-endings');
    const chkIgnoreWhitespace  = document.getElementById('chk-ignore-whitespace');
    const chkIgnoreCase        = document.getElementById('chk-ignore-case');
    if (chkIgnoreLineEndings) {
      chkIgnoreLineEndings.checked = this._opts.ignoreLineEndings;
      chkIgnoreLineEndings.addEventListener('change', () => {
        this._opts.ignoreLineEndings = chkIgnoreLineEndings.checked;
        this._runDiff();
      });
    }
    if (chkIgnoreWhitespace) {
      chkIgnoreWhitespace.checked = this._opts.ignoreWhitespace;
      chkIgnoreWhitespace.addEventListener('change', () => {
        this._opts.ignoreWhitespace = chkIgnoreWhitespace.checked;
        this._runDiff();
      });
    }
    if (chkIgnoreCase) {
      chkIgnoreCase.checked = this._opts.ignoreCase;
      chkIgnoreCase.addEventListener('change', () => {
        this._opts.ignoreCase = chkIgnoreCase.checked;
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
    this._findInput?.addEventListener('input', () => {
      this._findQuery = this._findInput.value;
      this._runFind();
    });
    this._findInput?.addEventListener('keydown', (e) => {
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

    btnToggleReplace?.addEventListener('click', () => this._toggleReplaceMode());
    btnReplaceOne?.addEventListener('click', () => this._replaceOne());
    btnReplaceAll?.addEventListener('click', () => this._replaceAll());

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

    // ── T16: Go-to-line bar setup ──
    this._gotoBar   = document.getElementById('goto-bar');
    this._gotoInput = document.getElementById('goto-input');

    document.getElementById('goto-close')?.addEventListener('click', () => this._closeGoto());
    document.getElementById('goto-go')?.addEventListener('click', () => this._gotoLine());
    this._gotoInput?.addEventListener('keydown', (e) => {
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
      chkWordWrap.addEventListener('change', () => {
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

    // ── T36: F5/F7/F8 navigation shortcuts ──
    this._onKeyDownNav = (e) => {
      // S14-M07: don't fire when another view is active.
      if (!isActive('text')) return;
      if (e.key === 'F5') { e.preventDefault(); this.refresh(); }
      if (e.key === 'F7') { e.preventDefault(); this.navigatePrev(); }
      if (e.key === 'F8') { e.preventDefault(); this.navigateNext(); }
    };
    document.addEventListener('keydown', this._onKeyDownNav);

    // ── T04: Drag-and-drop for text panes ──
    const paneLeft  = document.getElementById('pane-left');
    const paneRight = document.getElementById('pane-right');
    if (paneLeft) {
      paneLeft.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
      paneLeft.addEventListener('drop', async (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (!file) return;
        const filePath = file.path; // Electron provides .path
        if (!filePath) return;
        try {
          const result = await window.electronAPI.readFile(filePath);
          if (result) {
            this._hlLeft = await loadHighlighter(this._extFrom(result.path));
            this.setLeft(result.path, result.content);
          }
        } catch { /* ignore */ }
      });
    }
    if (paneRight) {
      paneRight.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
      paneRight.addEventListener('drop', async (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (!file) return;
        const filePath = file.path;
        if (!filePath) return;
        try {
          const result = await window.electronAPI.readFile(filePath);
          if (result) {
            this._hlRight = await loadHighlighter(this._extFrom(result.path));
            this.setRight(result.path, result.content);
          }
        } catch { /* ignore */ }
      });
    }

    // ── T46: Show Filter toolbar buttons ──
    const btnShowAll  = document.getElementById('btn-show-all');
    const btnShowDiff = document.getElementById('btn-show-diff');
    const btnShowSame = document.getElementById('btn-show-same');
    const btnShowNone = document.getElementById('btn-show-none');
    if (btnShowAll)  btnShowAll.addEventListener('click',  () => this.setShowFilter('all'));
    if (btnShowDiff) btnShowDiff.addEventListener('click', () => this.setShowFilter('diff'));
    if (btnShowSame) btnShowSame.addEventListener('click', () => this.setShowFilter('same'));
    if (btnShowNone) btnShowNone.addEventListener('click', () => this.setShowFilter('none'));
    this._btnShowAll  = btnShowAll ?? null;
    this._btnShowDiff = btnShowDiff ?? null;
    this._btnShowSame = btnShowSame ?? null;
    this._btnShowNone = btnShowNone ?? null;
    this._syncShowFilterButtons();

    // ── T47: Visible Whitespace toggle ──
    const btnWhitespace = document.getElementById('btn-whitespace');
    if (btnWhitespace) {
      btnWhitespace.addEventListener('click', () => this.toggleWhitespace());
    }
    this._btnWhitespace = btnWhitespace ?? null;

    // ── T48: Line Numbers toggle ──
    const btnLineNums = document.getElementById('btn-line-numbers');
    if (btnLineNums) {
      btnLineNums.addEventListener('click', () => this.toggleLineNumbers());
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
      btnLayout.addEventListener('click', () => this.toggleLayout());
    }
    this._btnLayout = btnLayout ?? null;

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

    // T36: cleanup nav shortcuts
    if (this._onKeyDownNav) {
      document.removeEventListener('keydown', this._onKeyDownNav);
    }

    // T42: cleanup replace shortcuts
    if (this._onKeyDownReplace) {
      document.removeEventListener('keydown', this._onKeyDownReplace);
    }

    // T43: cleanup bookmark shortcuts
    if (this._onKeyDownBookmark) {
      document.removeEventListener('keydown', this._onKeyDownBookmark);
    }

    // T49: cleanup font size shortcuts
    if (this._onKeyDownFontSize) {
      document.removeEventListener('keydown', this._onKeyDownFontSize);
    }

    // T33: unwatch both files on destroy
    if (this._leftPath) window.electronAPI?.unwatchFile(this._leftPath);
    if (this._rightPath) window.electronAPI?.unwatchFile(this._rightPath);

    // S13-C08: remove the file-changed listener registered in mount().
    if (this._unsubFileChanged) {
      try { this._unsubFileChanged(); } catch { /* ignore */ }
      this._unsubFileChanged = null;
    }
    // Invalidate any in-flight reads.
    this._loadTokenLeft = null;
    this._loadTokenRight = null;

    // T39: cleanup center gutter
    if (this._gutterCanvas)  { this._gutterCanvas.width = 0; this._gutterCanvas = null; }
    if (this._gutterOverlay) { this._gutterOverlay.innerHTML = ''; this._gutterOverlay = null; }

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
    this.setLeft(result.path, result.content);
  }

  async openRight() {
    const result = await window.electronAPI.openFile();
    if (!result) return;
    this._hlRight = await loadHighlighter(this._extFrom(result.path));
    this.setRight(result.path, result.content);
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

    ta.addEventListener('input', () => {
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
    await window.electronAPI.saveFile(this._leftPath || 'left.txt', this._leftContent, filters);
    this._modified.left = false;
    this._updateModifiedIndicator();
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
    await window.electronAPI.saveFile(this._rightPath || 'right.txt', this._rightContent, filters);
    this._modified.right = false;
    this._updateModifiedIndicator();
  }

  // -------------------------------------------------------------------------
  // Public: set content directly (folder-compare double-click, etc.)
  // -------------------------------------------------------------------------

  /**
   * @param {string} path
   * @param {string} content
   */
  setLeft(path, content) {
    // T33: unwatch old path before switching
    if (this._leftPath && this._leftPath !== path) {
      window.electronAPI?.unwatchFile(this._leftPath);
    }
    this._leftPath = path;
    this._leftContent = content;
    this._eolLeft = detectEol(content); // T01
    if (this._pathLeft) this._pathLeft.textContent = path || '（未選擇）';
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath });
    // T33: start watching the new file path (if it's a real file path)
    if (path) window.electronAPI?.watchFile(path);
    this._runDiff();
  }

  /**
   * @param {string} path
   * @param {string} content
   */
  setRight(path, content) {
    // T33: unwatch old path before switching
    if (this._rightPath && this._rightPath !== path) {
      window.electronAPI?.unwatchFile(this._rightPath);
    }
    this._rightPath = path;
    this._rightContent = content;
    this._eolRight = detectEol(content); // T01
    if (this._pathRight) this._pathRight.textContent = path || '（未選擇）';
    this._emit('paths-changed', { left: this._leftPath, right: this._rightPath });
    // T33: start watching the new file path (if it's a real file path)
    if (path) window.electronAPI?.watchFile(path);
    this._runDiff();
  }

  // -------------------------------------------------------------------------
  // Public: navigation
  // -------------------------------------------------------------------------

  navigateNext() {
    if (this._diffBlocks.length === 0) return;
    this._currentDiff = Math.min(this._currentDiff + 1, this._diffBlocks.length - 1);
    this._scrollToDiff(this._currentDiff);
    this._updateStatusBar();
  }

  navigatePrev() {
    if (this._diffBlocks.length === 0) return;
    this._currentDiff = Math.max(this._currentDiff - 1, 0);
    this._scrollToDiff(this._currentDiff);
    this._updateStatusBar();
  }

  navigateFirst() {
    if (this._diffBlocks.length === 0) return;
    this._currentDiff = 0;
    this._scrollToDiff(0);
    this._updateStatusBar();
  }

  navigateLast() {
    if (this._diffBlocks.length === 0) return;
    this._currentDiff = this._diffBlocks.length - 1;
    this._scrollToDiff(this._currentDiff);
    this._updateStatusBar();
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
    this._rightContent = this._leftContent;
    this._runDiff();
  }

  /** Copy ALL diffs to left side: left becomes identical to right (T09) */
  copyAllToLeft() {
    if (!this._rightContent) return;
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
  _runDiff() {
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
      });
    }

    // Apply ignore / unimportant patterns
    this._applyIgnorePatterns();

    this._buildRows();
    this._buildDiffBlocks();
    this._render();
    this._buildMinimap();
    this._updateStatusBar();

    // Reset navigation
    this._currentDiff = this._diffBlocks.length > 0 ? 0 : -1;
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

    for (const dl of this._diffResult) {
      if (dl.type === 'equal') continue
      const text = (dl.leftText || dl.rightText || '').slice(0, MAX_TEXT_LEN)
      if (ignoreRe.some(re => re.test(text))) {
        dl.type = 'equal'
        continue
      }
      dl.unimportant = unimportantRe.length > 0 && unimportantRe.some(re => re.test(text))
    }
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

  /**
   * Return the current view settings as a plain JSON-serialisable object.
   * Used by T61 Session Settings Dialog to persist a snapshot under a name.
   * @returns {Record<string, unknown>}
   */
  getConfig() {
    return {
      algorithm:          this._opts.algorithm,
      ignoreWhitespace:   this._opts.ignoreWhitespace,
      ignoreCase:         this._opts.ignoreCase,
      ignoreLineEndings:  this._opts.ignoreLineEndings,
      contextLines:       this._opts.contextLines,
      ignorePatterns:     Array.isArray(this._opts.ignorePatterns) ? [...this._opts.ignorePatterns] : [],
      unimportantPatterns:Array.isArray(this._opts.unimportantPatterns) ? [...this._opts.unimportantPatterns] : [],
    }
  }

  /**
   * Apply a previously captured settings snapshot.
   * Unknown keys are ignored. Triggers a diff re-run if content is loaded.
   * @param {Record<string, unknown>} settings
   */
  applyConfig(settings) {
    if (!settings || typeof settings !== 'object') return
    const known = ['algorithm','ignoreWhitespace','ignoreCase','ignoreLineEndings','contextLines','ignorePatterns','unimportantPatterns']
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
        this._rows.push({
          kind: 'collapsed',
          expandStart: collapseStart,
          expandEnd: collapseEnd,
          collapsedCount: count,
        });
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

  /** Re-render both panes using virtual scrolling. */
  _render() {
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

    // Reset scroll to top
    this._contentLeft.scrollTop = 0;
    this._contentRight.scrollTop = 0;

    // T13: Reapply word wrap after each render
    this._applyWordWrap();

    // Render visible rows into the spacers
    this._renderVisibleRows();

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
          leftEl  = createCollapsedEl(row.expandStart, row.expandEnd, row.collapsedCount);
          rightEl = createCollapsedEl(row.expandStart, row.expandEnd, row.collapsedCount);
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

    const uiClass = (base) => dl.unimportant ? `${base} unimportant` : base;

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
      btnLeft.addEventListener('click', () => {
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
      btnRight.addEventListener('click', () => {
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
      this._statusLines.textContent = `${totalLines} 行`;
    }
    if (this._statusEncoding) {
      this._statusEncoding.textContent = 'UTF-8';
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

    this._runDiff();
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
    // Find the collapsed row in _rows and replace it with expanded line rows
    const rowIdx = this._rows.findIndex(
      r => r.kind === 'collapsed' &&
           r.expandStart === expandStart &&
           r.expandEnd   === expandEnd
    );
    if (rowIdx === -1) return;

    const newRows = [];
    for (let j = expandStart; j <= expandEnd; j++) {
      newRows.push({ kind: 'line', diffLine: this._diffResult[j] });
    }

    this._rows.splice(rowIdx, 1, ...newRows);

    // Re-render and rebuild metadata
    this._render();
    this._buildDiffBlocks();
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
    this._scheduleVsRender();
  }

  _handleScrollRight() {
    if (this._syncLock) return;
    this._syncLock = true;
    this._contentLeft.scrollTop = this._contentRight.scrollTop;
    this._syncLock = false;
    this._updateMinimapViewport();
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
    if (rowEl) this._lastClickedRow = parseInt(rowEl.dataset.rowIdx, 10);

    const collapsed = target.closest('.diff-line.collapsed');
    if (!collapsed) return;

    const expandStart = parseInt(collapsed.dataset.expandStart, 10);
    const expandEnd   = parseInt(collapsed.dataset.expandEnd, 10);
    if (!isNaN(expandStart) && !isNaN(expandEnd)) {
      this._expandCollapsed(expandStart, expandEnd);
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

    // T43: Bookmark items
    items.push({ separator: true });
    items.push({ label: '切換書籤 (Ctrl+F2)', action: () => this._toggleBookmark(this._lastClickedRow ?? 0) });
    items.push({ label: '清除所有書籤', action: () => { this._bookmarks.clear(); this._renderVisibleRows(); } });

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
