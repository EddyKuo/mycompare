/**
 * @file grammar.js
 * @description Beyond Compare style "File Format → Grammar" engine.
 *
 * A grammar names the syntactic elements of a file format (Comment, String,
 * Keyword, …) so the comparison can treat a whole class of text as
 * unimportant — "ignore differences inside comments" is the feature this
 * exists for.
 *
 * Everything here is pure data + pure functions: no DOM, no storage, no
 * Electron. text-compare.js owns the UI and the persistence.
 *
 * Safety: grammars are user-editable, which means user-supplied regular
 * expressions run over user-supplied files. A tokenizer that can be stalled by
 * either one would freeze the whole renderer, so every entry point here is
 * bounded — see the "Complexity bounds" section.
 */

// ---------------------------------------------------------------------------
// Complexity bounds
// ---------------------------------------------------------------------------
//
// Four independent limits, because each blocks a different attack:
//
//  1. MAX_LINE_LEN     — a pathological single line (a 40 MB minified bundle on
//                        one line) is only scanned up to this many characters;
//                        the remainder is reported as untokenized.
//  2. MAX_TOKENS_PER_LINE — bounds memory when a grammar matches every char.
//  3. DEFAULT_STEP_BUDGET — a global work counter across the whole call. Each
//                        item attempt and each character of a delimiter search
//                        costs one step, so total work is linear in the budget
//                        regardless of how many items the grammar has.
//  4. Regex screening  — a step budget cannot interrupt a single catastrophic
//                        `RegExp.exec`, so risky sources are rejected at
//                        compile time (see isRiskyRegexSource) and matching is
//                        sticky-anchored against a length-capped line.

/** Characters of a line that will be tokenized; the rest is left as plain text. */
export const MAX_LINE_LEN = 10000;

/** Upper bound on tokens emitted for one line. */
export const MAX_TOKENS_PER_LINE = 2000;

/**
 * Work units for one tokenizeLines() call.
 *
 * Measured at roughly 30M steps/second, so this is a ~1 s ceiling on the worst
 * case. A 1 MB source file (the size this app targets) costs about 4M steps,
 * leaving plenty of headroom while still refusing to run forever.
 */
export const DEFAULT_STEP_BUDGET = 30_000_000;

/** Longest accepted regex source for a grammar item. */
export const MAX_PATTERN_LEN = 200;

/** Longest accepted literal (delimiter, keyword, basic text). */
export const MAX_LITERAL_LEN = 64;

/** Most items one grammar may hold. */
export const MAX_ITEMS = 200;

/** Most entries a `list` item may hold. */
export const MAX_LIST_ITEMS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {'basic'|'delimited'|'list'|'columns'|'lines'} GrammarItemType
 */

/**
 * One Grammar Item. Position in `GrammarDef.items` is the priority: the first
 * item that matches at a character position wins, exactly like BC's
 * "items higher in the list take precedence".
 *
 * @typedef {Object} GrammarItem
 * @property {GrammarItemType} type
 * @property {string} element        Element name this item contributes to.
 * @property {number} [lineWeight]   Alignment weight contributed by this element.
 * @property {boolean} [matchCase]   Overrides GrammarDef.caseSensitive.
 * @property {boolean} [regex]       basic/lines: treat `text`/`match` as regex.
 * @property {boolean} [wholeWord]   basic/list: require word boundaries.
 * @property {string}  [text]        basic: literal or regex source.
 * @property {string}  [start]       delimited: opening delimiter (literal).
 * @property {string}  [end]         delimited: closing delimiter (literal).
 * @property {string}  [escape]      delimited: escape character.
 * @property {boolean} [stopAtEol]   delimited: unterminated run ends at EOL.
 * @property {boolean} [multiline]   delimited: unterminated run continues on the next line.
 * @property {string[]} [items]      list: the token set.
 * @property {number}  [startColumn] columns: 1-based inclusive start.
 * @property {number}  [endColumn]   columns: 1-based inclusive end.
 * @property {boolean} [toEol]       columns: run to end of line.
 * @property {string}  [match]       lines: literal or regex for the whole line.
 * @property {boolean} [orLine1]     lines: also match on line 1.
 * @property {number}  [headingLines] lines: only within the first N lines.
 */

/**
 * @typedef {Object} GrammarDef
 * @property {string} name
 * @property {string[]} masks         Filename masks, e.g. ['*.c', '*.h'].
 * @property {boolean} [caseSensitive] Default case sensitivity for all items.
 * @property {GrammarItem[]} items
 * @property {boolean} [builtin]
 */

/**
 * @typedef {Object} GrammarToken
 * @property {string} element
 * @property {number} start  Inclusive character offset.
 * @property {number} end    Exclusive character offset.
 * @property {number} item   Index into GrammarDef.items.
 */

/**
 * @typedef {Object} CompiledGrammar
 * @property {string} name
 * @property {string[]} masks
 * @property {boolean} caseSensitive
 * @property {GrammarItem[]} items
 * @property {Array<Object>} compiled
 * @property {string[]} elements    Distinct element names, in item order.
 * @property {string[]} errors      Human-readable reasons items were dropped.
 * @property {number[]} weights     Item index → line weight.
 */

// ---------------------------------------------------------------------------
// Regex screening
// ---------------------------------------------------------------------------

/**
 * Reject regex sources that can backtrack catastrophically.
 *
 * A step budget cannot preempt a running `RegExp.exec`, so the only reliable
 * defence in a single-threaded renderer is to never compile the dangerous
 * shape in the first place. The rule implemented here is the one that actually
 * matters in practice: an *unbounded* quantifier applied to a group that
 * itself contains an unbounded quantifier or an alternation — `(a+)+`,
 * `(a|a)*`, `(\s*\w)*`. A bounded outer quantifier (`?`, `{0,3}`) cannot
 * produce exponential blow-up, so `(?:\.\d+)?` stays legal and useful.
 *
 * @param {string} source
 * @returns {string|null} reason to reject, or null when acceptable
 */
export function isRiskyRegexSource(source) {
  if (typeof source !== 'string') return '不是字串';
  if (source.length > MAX_PATTERN_LEN) return `樣式過長（上限 ${MAX_PATTERN_LEN} 字元）`;

  let quantifiers = 0;
  /** @type {Array<{ start: number, hasRisk: boolean }>} */
  const stack = [];

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (ch === '\\') { i++; continue; }

    if (ch === '[') {
      // Character classes hold no quantifiers of their own; skip wholesale.
      i++;
      while (i < source.length && source[i] !== ']') {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }

    if (ch === '(') { stack.push({ start: i, hasRisk: false }); continue; }

    if (ch === '|') {
      if (stack.length > 0) stack[stack.length - 1].hasRisk = true;
      continue;
    }

    if (ch === ')') {
      const group = stack.pop();
      if (!group) return '括號不成對';
      const outer = _readQuantifier(source, i + 1);
      if (outer.unbounded && group.hasRisk) {
        return '巢狀無上限量詞（可能造成災難性回溯）';
      }
      // A group's riskiness propagates outwards: ((a+)?)+ is still dangerous.
      if (stack.length > 0 && (group.hasRisk || outer.unbounded)) {
        stack[stack.length - 1].hasRisk = true;
      }
      i += outer.length;
      continue;
    }

    const q = _readQuantifier(source, i);
    if (q.length > 0) {
      quantifiers++;
      if (q.unbounded && stack.length > 0) stack[stack.length - 1].hasRisk = true;
      i += q.length - 1;
    }
  }

  if (stack.length > 0) return '括號不成對';
  if (quantifiers > 20) return '量詞過多';
  return null;
}

/**
 * @param {string} src
 * @param {number} at
 * @returns {{ length: number, unbounded: boolean }}
 */
function _readQuantifier(src, at) {
  const ch = src[at];
  if (ch === '*' || ch === '+') {
    const lazy = src[at + 1] === '?' || src[at + 1] === '+';
    return { length: lazy ? 2 : 1, unbounded: true };
  }
  if (ch === '?') {
    const lazy = src[at + 1] === '?';
    return { length: lazy ? 2 : 1, unbounded: false };
  }
  if (ch === '{') {
    const close = src.indexOf('}', at);
    if (close === -1) return { length: 0, unbounded: false };
    const body = src.slice(at + 1, close);
    if (!/^\d*(,\d*)?$/.test(body) || body === '') return { length: 0, unbounded: false };
    const lazy = src[close + 1] === '?';
    return { length: close - at + 1 + (lazy ? 1 : 0), unbounded: /,\s*$/.test(body) };
  }
  return { length: 0, unbounded: false };
}

/**
 * Compile a screened, sticky-anchored regex.
 * @param {string} source
 * @param {boolean} caseSensitive
 * @returns {{ re: RegExp|null, error: string|null }}
 */
function _compileRegex(source, caseSensitive) {
  const risk = isRiskyRegexSource(source);
  if (risk) return { re: null, error: risk };
  try {
    return { re: new RegExp(source, caseSensitive ? 'y' : 'iy'), error: null };
  } catch (err) {
    return { re: null, error: `無效的正規表示式：${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Validate and compile a grammar definition.
 *
 * Rejected items are dropped and reported in `errors` — never silently
 * ignored, so the UI can tell the user which rule is not running.
 *
 * @param {GrammarDef} def
 * @returns {CompiledGrammar}
 */
export function compileGrammar(def) {
  /** @type {string[]} */
  const errors = [];
  const name = typeof def?.name === 'string' && def.name ? def.name : '(未命名)';
  const masks = Array.isArray(def?.masks) ? def.masks.filter(m => typeof m === 'string') : [];
  const caseSensitive = def?.caseSensitive !== false;
  const rawItems = Array.isArray(def?.items) ? def.items : [];

  if (rawItems.length > MAX_ITEMS) {
    errors.push(`項目數超過上限 ${MAX_ITEMS}，多餘的已忽略`);
  }

  /** @type {GrammarItem[]} */
  const items = [];
  /** @type {Array<Object>} */
  const compiled = [];

  for (const raw of rawItems.slice(0, MAX_ITEMS)) {
    const idx = items.length;
    const built = _compileItem(raw, caseSensitive, idx, errors);
    if (!built) continue;
    items.push(raw);
    compiled.push(built);
  }

  const elements = [];
  for (const it of items) {
    if (!elements.includes(it.element)) elements.push(it.element);
  }

  // Item index → weight, so lineWeight() stays O(tokens) rather than
  // O(tokens × items) on files with tens of thousands of lines.
  const weights = compiled.map(c => c.lineWeight);

  return { name, masks, caseSensitive, items, compiled, elements, errors, weights };
}

/**
 * @param {GrammarItem} raw
 * @param {boolean} grammarCase
 * @param {number} index
 * @param {string[]} errors
 * @returns {Object|null}
 */
function _compileItem(raw, grammarCase, index, errors) {
  const where = `項目 #${index + 1}`;
  if (!raw || typeof raw !== 'object') { errors.push(`${where}：格式錯誤`); return null; }
  const element = typeof raw.element === 'string' && raw.element ? raw.element : null;
  if (!element) { errors.push(`${where}：缺少 element 名稱`); return null; }

  const matchCase = typeof raw.matchCase === 'boolean' ? raw.matchCase : grammarCase;
  const lineWeight = Number.isFinite(raw.lineWeight) ? Number(raw.lineWeight) : 1;
  const base = { type: raw.type, element, index, matchCase, lineWeight, wholeWord: !!raw.wholeWord };

  switch (raw.type) {
    case 'basic': {
      if (typeof raw.text !== 'string' || raw.text === '') {
        errors.push(`${where}：Basic 需要 text`); return null;
      }
      if (raw.regex) {
        const { re, error } = _compileRegex(raw.text, matchCase);
        if (!re) { errors.push(`${where}：${error}`); return null; }
        return { ...base, re };
      }
      if (raw.text.length > MAX_LITERAL_LEN) {
        errors.push(`${where}：字串過長（上限 ${MAX_LITERAL_LEN}）`); return null;
      }
      return { ...base, literal: raw.text, needle: matchCase ? raw.text : raw.text.toLowerCase() };
    }

    case 'delimited': {
      if (typeof raw.start !== 'string' || raw.start === '') {
        errors.push(`${where}：Delimited 需要 start 分隔符`); return null;
      }
      if (raw.start.length > MAX_LITERAL_LEN || (raw.end ?? '').length > MAX_LITERAL_LEN) {
        errors.push(`${where}：分隔符過長（上限 ${MAX_LITERAL_LEN}）`); return null;
      }
      const end = typeof raw.end === 'string' && raw.end ? raw.end : null;
      if (!end && !raw.stopAtEol) {
        errors.push(`${where}：Delimited 需要 end 分隔符或勾選「至行尾結束」`); return null;
      }
      return {
        ...base,
        start: raw.start,
        startNeedle: matchCase ? raw.start : raw.start.toLowerCase(),
        end,
        endNeedle: end ? (matchCase ? end : end.toLowerCase()) : null,
        escape: typeof raw.escape === 'string' && raw.escape.length === 1 ? raw.escape : null,
        stopAtEol: !!raw.stopAtEol,
        multiline: !!raw.multiline,
      };
    }

    case 'list': {
      const list = Array.isArray(raw.items) ? raw.items.filter(s => typeof s === 'string' && s) : [];
      if (list.length === 0) { errors.push(`${where}：List 需要至少一個項目`); return null; }
      if (list.length > MAX_LIST_ITEMS) {
        errors.push(`${where}：List 項目超過 ${MAX_LIST_ITEMS}，多餘的已忽略`);
      }
      const kept = list.slice(0, MAX_LIST_ITEMS).filter(s => s.length <= MAX_LITERAL_LEN);
      // Grouped by length, longest first, so the longest token wins ("elseif"
      // must not be matched as "else").
      const byLength = new Map();
      let maxLen = 0;
      for (const s of kept) {
        const key = matchCase ? s : s.toLowerCase();
        if (!byLength.has(key.length)) byLength.set(key.length, new Set());
        byLength.get(key.length).add(key);
        if (key.length > maxLen) maxLen = key.length;
      }
      const lengths = [...byLength.keys()].sort((a, b) => b - a);
      return { ...base, byLength, lengths, maxLen };
    }

    case 'columns': {
      const startColumn = Number.isFinite(raw.startColumn) ? Math.max(1, Math.floor(Number(raw.startColumn))) : 1;
      const toEol = !!raw.toEol;
      const endColumn = Number.isFinite(raw.endColumn) ? Math.floor(Number(raw.endColumn)) : null;
      if (!toEol && (endColumn === null || endColumn < startColumn)) {
        errors.push(`${where}：Columns 需要 endColumn ≥ startColumn，或勾選「至行尾」`); return null;
      }
      return { ...base, startColumn, endColumn, toEol };
    }

    case 'lines': {
      if (typeof raw.match !== 'string' || raw.match === '') {
        errors.push(`${where}：Lines 需要 match`); return null;
      }
      const headingLines = Number.isFinite(raw.headingLines)
        ? Math.max(0, Math.floor(Number(raw.headingLines)))
        : null;
      if (raw.regex) {
        const { re, error } = _compileRegex(raw.match, matchCase);
        if (!re) { errors.push(`${where}：${error}`); return null; }
        // Lines items test a whole line rather than anchoring at a scan
        // position, so they get a non-sticky twin: `^Page` should match
        // "Page 1", not just the single character it consumes.
        const lineRe = new RegExp(raw.match, matchCase ? '' : 'i');
        return { ...base, re, lineRe, headingLines, orLine1: !!raw.orLine1 };
      }
      if (raw.match.length > MAX_PATTERN_LEN) {
        errors.push(`${where}：match 過長`); return null;
      }
      return {
        ...base,
        needle: matchCase ? raw.match : raw.match.toLowerCase(),
        headingLines,
        orLine1: !!raw.orLine1,
      };
    }

    default:
      errors.push(`${where}：不支援的類型「${String(raw.type)}」`);
      return null;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TokenizeState
 * @property {Object|null} open   Delimited item still waiting for its closer.
 * @property {number} steps
 * @property {boolean} exhausted
 * @property {number} [budget]    Work units before tokenizing stops.
 */

/** @returns {TokenizeState} */
export function newTokenizeState() {
  return { open: null, steps: 0, exhausted: false };
}

const WORD_RE = /[A-Za-z0-9_$]/;

/**
 * @param {string} line
 * @param {number} at
 * @returns {boolean}
 */
function _isWordChar(line, at) {
  if (at < 0 || at >= line.length) return false;
  return WORD_RE.test(line[at]);
}

/**
 * Tokenize a single line.
 *
 * @param {CompiledGrammar} grammar
 * @param {string} line
 * @param {number} lineIndex 0-based index within the file
 * @param {TokenizeState} state
 * @returns {{ tokens: GrammarToken[], truncated: boolean }}
 */
export function tokenizeLine(grammar, line, lineIndex, state) {
  /** @type {GrammarToken[]} */
  const tokens = [];
  if (!grammar || grammar.compiled.length === 0) return { tokens, truncated: false };
  if (state.exhausted) return { tokens, truncated: true };

  const capped = line.length > MAX_LINE_LEN;
  const text = capped ? line.slice(0, MAX_LINE_LEN) : line;
  const lower = grammar.caseSensitive ? text : text.toLowerCase();
  let pos = 0;

  // A delimited run opened on an earlier line closes (or continues) first.
  if (state.open) {
    const item = state.open;
    const end = _findDelimiterEnd(item, text, lower, 0, state);
    tokens.push({ element: item.element, start: 0, end: end.at, item: item.index });
    if (end.closed) { state.open = null; pos = end.at; } else {
      return { tokens, truncated: capped };
    }
  }

  // Whole-line rules (BC "Lines" items) short-circuit the character scan.
  for (const item of grammar.compiled) {
    if (item.type !== 'lines') continue;
    state.steps++;
    if (!_linesItemApplies(item, lineIndex)) continue;
    const hit = item.lineRe ? item.lineRe.test(text) : lower.includes(item.needle);
    if (hit) {
      tokens.push({ element: item.element, start: 0, end: text.length, item: item.index });
      return { tokens, truncated: capped };
    }
  }

  while (pos < text.length) {
    if (state.steps > (state.budget ?? DEFAULT_STEP_BUDGET)) {
      state.exhausted = true;
      return { tokens, truncated: true };
    }
    if (tokens.length >= MAX_TOKENS_PER_LINE) return { tokens, truncated: true };

    let matched = -1;
    let matchedItem = null;

    for (const item of grammar.compiled) {
      state.steps++;
      const end = _matchItemAt(item, text, lower, pos, state);
      if (end > pos) { matched = end; matchedItem = item; break; }
    }

    if (matchedItem) {
      tokens.push({ element: matchedItem.element, start: pos, end: matched, item: matchedItem.index });
      pos = matched;
    } else {
      pos++;
    }
  }

  return { tokens, truncated: capped };
}

/**
 * @param {Object} item
 * @param {number} lineIndex
 */
function _linesItemApplies(item, lineIndex) {
  if (item.headingLines === null || item.headingLines === undefined) return true;
  if (lineIndex < item.headingLines) return true;
  return !!item.orLine1 && lineIndex === 0;
}

/**
 * @param {Object} item compiled item
 * @param {string} text
 * @param {string} lower
 * @param {number} pos
 * @param {TokenizeState} state
 * @returns {number} exclusive end offset, or `pos` for no match
 */
function _matchItemAt(item, text, lower, pos, state) {
  switch (item.type) {
    case 'basic': {
      if (item.re) {
        item.re.lastIndex = pos;
        const m = item.re.exec(text);
        if (!m || m.index !== pos || m[0].length === 0) return pos;
        const end = pos + m[0].length;
        if (item.wholeWord && (_isWordChar(text, pos - 1) || _isWordChar(text, end))) return pos;
        return end;
      }
      const hay = item.matchCase ? text : lower;
      if (!hay.startsWith(item.needle, pos)) return pos;
      const end = pos + item.needle.length;
      if (item.wholeWord && (_isWordChar(text, pos - 1) || _isWordChar(text, end))) return pos;
      return end;
    }

    case 'list': {
      if (item.wholeWord && _isWordChar(text, pos - 1)) return pos;
      const hay = item.matchCase ? text : lower;
      for (const len of item.lengths) {
        state.steps++;
        if (pos + len > text.length) continue;
        const slice = hay.substr(pos, len);
        if (!item.byLength.get(len).has(slice)) continue;
        const end = pos + len;
        if (item.wholeWord && _isWordChar(text, end)) continue;
        return end;
      }
      return pos;
    }

    case 'delimited': {
      const hay = item.matchCase ? text : lower;
      if (!hay.startsWith(item.startNeedle, pos)) return pos;
      const found = _findDelimiterEnd(item, text, lower, pos + item.start.length, state);
      if (!found.closed && item.multiline) state.open = item;
      return found.at;
    }

    case 'columns': {
      if (pos + 1 !== item.startColumn) return pos;
      const end = item.toEol ? text.length : Math.min(text.length, item.endColumn);
      return end > pos ? end : pos;
    }

    default:
      return pos;
  }
}

/**
 * Scan for a delimited item's closing delimiter.
 * @param {Object} item
 * @param {string} text
 * @param {string} lower
 * @param {number} from
 * @param {TokenizeState} state
 * @returns {{ at: number, closed: boolean }}
 */
function _findDelimiterEnd(item, text, lower, from, state) {
  if (!item.endNeedle) return { at: text.length, closed: item.stopAtEol };
  const hay = item.matchCase ? text : lower;
  let i = from;
  while (i < text.length) {
    state.steps++;
    if (item.escape && text[i] === item.escape) { i += 2; continue; }
    if (hay.startsWith(item.endNeedle, i)) return { at: i + item.endNeedle.length, closed: true };
    i++;
  }
  // Unterminated: stopAtEol closes it here, multiline carries it to the next
  // line, and a plain item is treated as closing at EOL so one stray quote
  // cannot swallow the rest of the file.
  return { at: text.length, closed: item.stopAtEol || !item.multiline };
}

/**
 * Tokenize a whole file.
 *
 * @param {CompiledGrammar} grammar
 * @param {string[]} lines
 * @param {{ stepBudget?: number }} [opts]
 * @returns {{ tokens: GrammarToken[][], truncated: boolean, steps: number }}
 */
export function tokenizeLines(grammar, lines, opts = {}) {
  const state = newTokenizeState();
  state.budget = Number.isFinite(opts.stepBudget) ? Number(opts.stepBudget) : DEFAULT_STEP_BUDGET;
  /** @type {GrammarToken[][]} */
  const tokens = [];
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    if (state.exhausted) { tokens.push([]); truncated = true; continue; }
    const res = tokenizeLine(grammar, lines[i], i, state);
    tokens.push(res.tokens);
    if (res.truncated) truncated = true;
  }

  return { tokens, truncated: truncated || state.exhausted, steps: state.steps };
}

// ---------------------------------------------------------------------------
// Masking (the point of the whole exercise)
// ---------------------------------------------------------------------------

/**
 * Blank out every token whose element is being ignored.
 *
 * Spans are replaced by spaces rather than removed so column positions — and
 * therefore Columns items and the ruler — stay meaningful.
 *
 * @param {string} line
 * @param {GrammarToken[]} tokens
 * @param {Set<string>|string[]} ignoredElements
 * @returns {string}
 */
export function maskLine(line, tokens, ignoredElements) {
  const ignored = ignoredElements instanceof Set ? ignoredElements : new Set(ignoredElements ?? []);
  if (ignored.size === 0 || !tokens || tokens.length === 0) return line;

  let out = '';
  let pos = 0;
  for (const t of tokens) {
    if (!ignored.has(t.element)) continue;
    if (t.start > pos) out += line.slice(pos, t.start);
    const width = Math.min(t.end, line.length) - Math.max(t.start, pos);
    if (width > 0) out += ' '.repeat(width);
    pos = Math.max(pos, t.end);
  }
  if (pos < line.length) out += line.slice(pos);
  return out;
}

/**
 * Whether two lines differ only inside ignored elements.
 *
 * Trailing whitespace is disregarded because masking a trailing comment leaves
 * exactly that behind.
 *
 * @param {string} leftLine
 * @param {string} rightLine
 * @param {GrammarToken[]} leftTokens
 * @param {GrammarToken[]} rightTokens
 * @param {Set<string>|string[]} ignoredElements
 * @returns {boolean}
 */
export function linesEqualIgnoringElements(leftLine, rightLine, leftTokens, rightTokens, ignoredElements) {
  const l = maskLine(leftLine ?? '', leftTokens, ignoredElements).replace(/\s+$/, '');
  const r = maskLine(rightLine ?? '', rightTokens, ignoredElements).replace(/\s+$/, '');
  return l === r;
}

// ---------------------------------------------------------------------------
// Line weights
// ---------------------------------------------------------------------------

/**
 * Alignment weight for one line.
 *
 * BC uses line weights as a hint to the alignment algorithm: a line carrying
 * structurally significant elements (a preprocessor directive, an opening tag)
 * should prefer to align with another line like it, while a blank line or a
 * pure comment carries little evidence. The weight is the largest weight among
 * the line's elements; a blank line weighs 0 and unclassified text weighs 1.
 *
 * @param {string} line
 * @param {GrammarToken[]} tokens
 * @param {CompiledGrammar} [grammar]
 * @returns {number}
 */
export function lineWeight(line, tokens, grammar) {
  if (!line || line.trim() === '') return 0;
  if (!tokens || tokens.length === 0) return 1;

  let covered = 0;
  let max = 0;
  for (const t of tokens) {
    covered += Math.max(0, t.end - t.start);
    const w = grammar?.weights?.[t.item] ?? 1;
    if (w > max) max = w;
  }
  // A line made up entirely of a low-weight element (a comment-only line) keeps
  // that low weight; a line that merely contains one keeps the default 1 floor.
  const whole = covered >= line.trim().length;
  return whole ? max : Math.max(1, max);
}

/**
 * @param {CompiledGrammar} grammar
 * @param {string[]} lines
 * @param {{ stepBudget?: number }} [opts]
 * @returns {{ weights: number[], truncated: boolean }}
 */
export function computeLineWeights(grammar, lines, opts = {}) {
  const { tokens, truncated } = tokenizeLines(grammar, lines, opts);
  const weights = lines.map((line, i) => lineWeight(line, tokens[i], grammar));
  return { weights, truncated };
}

// ---------------------------------------------------------------------------
// Filename masks
// ---------------------------------------------------------------------------

/**
 * @param {string} mask e.g. '*.c'
 * @returns {RegExp}
 */
function _maskToRegExp(mask) {
  const escaped = mask.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * @param {string} path
 * @param {string[]} masks
 * @returns {boolean}
 */
export function maskMatches(path, masks) {
  if (!path || !Array.isArray(masks)) return false;
  const base = String(path).split(/[\\/]/).pop() ?? '';
  return masks.some(m => {
    try { return _maskToRegExp(m).test(base); } catch { return false; }
  });
}

// ---------------------------------------------------------------------------
// Built-in grammars
// ---------------------------------------------------------------------------

const C_KEYWORDS = [
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'goto', 'struct', 'union', 'enum', 'typedef', 'sizeof', 'static', 'const',
  'extern', 'inline', 'void', 'char', 'short', 'int', 'long', 'float', 'double',
  'signed', 'unsigned', 'class', 'public', 'private', 'protected', 'virtual', 'template',
  'namespace', 'using', 'new', 'delete', 'this', 'try', 'catch', 'throw', 'operator',
  'function', 'var', 'let', 'import', 'export', 'async', 'await', 'yield', 'typeof',
  'instanceof', 'interface', 'type', 'implements', 'extends', 'super', 'null', 'true',
  'false', 'package', 'final', 'abstract', 'func', 'defer', 'go', 'chan', 'map', 'range',
  'fn', 'let', 'mut', 'impl', 'trait', 'match', 'pub', 'use', 'mod',
];

const PY_KEYWORDS = [
  'def', 'class', 'return', 'yield', 'import', 'from', 'as', 'if', 'elif', 'else',
  'for', 'while', 'break', 'continue', 'pass', 'try', 'except', 'finally', 'raise',
  'with', 'lambda', 'global', 'nonlocal', 'assert', 'del', 'and', 'or', 'not', 'in',
  'is', 'None', 'True', 'False', 'async', 'await', 'match', 'case',
];

/** @type {GrammarDef[]} */
export const BUILTIN_GRAMMARS = [
  {
    name: 'C 家族 / C-like',
    builtin: true,
    caseSensitive: true,
    masks: ['*.c', '*.h', '*.cpp', '*.cxx', '*.cc', '*.hpp', '*.hh', '*.cs', '*.java',
      '*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.tsx', '*.go', '*.rs', '*.php',
      '*.swift', '*.kt', '*.scala', '*.m', '*.mm'],
    items: [
      { type: 'delimited', element: 'Comment', start: '/*', end: '*/', multiline: true, lineWeight: 0.5 },
      { type: 'delimited', element: 'Comment', start: '//', stopAtEol: true, lineWeight: 0.5 },
      { type: 'basic', element: 'Preprocessor', text: '^\\s*#\\s*\\w+', regex: true, lineWeight: 3 },
      { type: 'delimited', element: 'String', start: '"', end: '"', escape: '\\', stopAtEol: true, lineWeight: 1 },
      { type: 'delimited', element: 'String', start: '`', end: '`', escape: '\\', multiline: true, lineWeight: 1 },
      { type: 'delimited', element: 'Character', start: "'", end: "'", escape: '\\', stopAtEol: true, lineWeight: 1 },
      { type: 'basic', element: 'Number', text: '0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?', regex: true, lineWeight: 1 },
      { type: 'list', element: 'Keyword', items: C_KEYWORDS, wholeWord: true, lineWeight: 2 },
    ],
  },
  {
    name: 'Python',
    builtin: true,
    caseSensitive: true,
    masks: ['*.py', '*.pyw', '*.pyi'],
    items: [
      { type: 'delimited', element: 'String', start: '"""', end: '"""', multiline: true, lineWeight: 1 },
      { type: 'delimited', element: 'String', start: "'''", end: "'''", multiline: true, lineWeight: 1 },
      { type: 'delimited', element: 'Comment', start: '#', stopAtEol: true, lineWeight: 0.5 },
      { type: 'basic', element: 'Decorator', text: '^\\s*@[\\w.]+', regex: true, lineWeight: 3 },
      { type: 'delimited', element: 'String', start: '"', end: '"', escape: '\\', stopAtEol: true, lineWeight: 1 },
      { type: 'delimited', element: 'String', start: "'", end: "'", escape: '\\', stopAtEol: true, lineWeight: 1 },
      { type: 'basic', element: 'Number', text: '\\d+(?:\\.\\d+)?', regex: true, lineWeight: 1 },
      { type: 'list', element: 'Keyword', items: PY_KEYWORDS, wholeWord: true, lineWeight: 2 },
    ],
  },
  {
    name: 'XML / HTML',
    builtin: true,
    caseSensitive: false,
    masks: ['*.xml', '*.html', '*.htm', '*.xhtml', '*.svg', '*.xsl', '*.xsd', '*.config', '*.plist'],
    items: [
      { type: 'delimited', element: 'Comment', start: '<!--', end: '-->', multiline: true, lineWeight: 0.5 },
      { type: 'delimited', element: 'CDATA', start: '<![CDATA[', end: ']]>', multiline: true, lineWeight: 1 },
      { type: 'delimited', element: 'String', start: '"', end: '"', stopAtEol: true, lineWeight: 1 },
      { type: 'delimited', element: 'String', start: "'", end: "'", stopAtEol: true, lineWeight: 1 },
      { type: 'basic', element: 'Tag', text: '</?[A-Za-z_][\\w:.-]*', regex: true, lineWeight: 2 },
      { type: 'basic', element: 'Entity', text: '&[A-Za-z#][\\w]*;', regex: true, lineWeight: 1 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Registry (built-ins + user additions)
// ---------------------------------------------------------------------------

/** @type {GrammarDef[]} */
let _userGrammars = [];

/**
 * User grammars first: a user definition for `*.py` must beat the built-in one.
 * @returns {GrammarDef[]}
 */
export function listGrammars() {
  return [..._userGrammars, ...BUILTIN_GRAMMARS];
}

/**
 * Add (or replace, by name) a user grammar.
 *
 * @param {GrammarDef} def
 * @returns {{ ok: boolean, errors: string[] }} errors are surfaced, not swallowed
 */
export function registerGrammar(def) {
  const compiled = compileGrammar(def);
  if (compiled.items.length === 0) {
    return { ok: false, errors: compiled.errors.length ? compiled.errors : ['沒有任何有效的 Grammar Item'] };
  }
  // The raw items are stored, not the compiled subset: a rejected item must
  // keep re-reporting its reason every time the grammar is used, otherwise the
  // rule silently disappears and the user never learns why it does nothing.
  const stored = {
    name: compiled.name,
    masks: compiled.masks,
    caseSensitive: compiled.caseSensitive,
    items: (Array.isArray(def?.items) ? def.items : []).filter(i => i && typeof i === 'object'),
  };
  const at = _userGrammars.findIndex(g => g.name === stored.name);
  if (at >= 0) _userGrammars[at] = stored; else _userGrammars.push(stored);
  return { ok: true, errors: compiled.errors };
}

/**
 * @param {string} name
 * @returns {boolean} whether a grammar was removed
 */
export function removeGrammar(name) {
  const before = _userGrammars.length;
  _userGrammars = _userGrammars.filter(g => g.name !== name);
  return _userGrammars.length !== before;
}

/** @returns {GrammarDef[]} */
export function getUserGrammars() {
  return _userGrammars.map(g => ({ ...g, items: g.items.map(i => ({ ...i })) }));
}

/** Replace the whole user set (used when restoring a saved configuration). */
export function setUserGrammars(defs) {
  _userGrammars = [];
  /** @type {string[]} */
  const errors = [];
  for (const def of Array.isArray(defs) ? defs : []) {
    const res = registerGrammar(def);
    if (!res.ok) errors.push(`${def?.name ?? '(未命名)'}：${res.errors.join('；')}`);
  }
  return errors;
}

/** Drop all user grammars (test helper / "reset to defaults"). */
export function resetGrammars() {
  _userGrammars = [];
}

/**
 * Resolve the grammar for a path, or null when no format claims it.
 *
 * @param {string} path
 * @returns {CompiledGrammar|null}
 */
export function getGrammarForPath(path) {
  for (const def of listGrammars()) {
    if (maskMatches(path, def.masks)) {
      const compiled = compileGrammar(def);
      return compiled.compiled.length > 0 ? compiled : null;
    }
  }
  return null;
}

/**
 * Describe the elements found on a line — used by the Alignment Details panel.
 *
 * @param {GrammarToken[]} tokens
 * @returns {string[]} distinct element names, in order of appearance
 */
export function elementsOf(tokens) {
  /** @type {string[]} */
  const out = [];
  for (const t of tokens ?? []) {
    if (!out.includes(t.element)) out.push(t.element);
  }
  return out;
}
