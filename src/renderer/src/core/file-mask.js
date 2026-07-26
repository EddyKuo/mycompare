/**
 * Beyond Compare file mask matching.
 *
 * Implements the mask language documented in BC's "File Masks" help topic,
 * which is richer than a plain glob:
 *
 *   *            zero or more characters
 *   ?            exactly one character
 *   [az] [a-z]   character set / range
 *   [!az]        negated set
 *   [[           a literal '['
 *   a;b;c        several masks in one string
 *   -mask        exclude
 *   name\        matches folders only
 *   .\sub\x      anchored at the base folder
 *   ...\x        x at any depth below the base folder
 *   dir\file     file inside dir, relative to the base folder
 *   name.        matches names with no extension
 *
 * Matching is case-insensitive, as on Windows.
 */

/**
 * @typedef {object} ParsedMask
 * @property {boolean} exclude      leading '-'
 * @property {boolean} folderOnly   trailing '\'
 * @property {boolean} anchored     started with '.\' — relative to the base folder
 * @property {boolean} anyDepth     started with '...\'
 * @property {RegExp}  re           compiled matcher for the path portion
 * @property {string}  source       the mask as written
 */

/** Characters that must be escaped when embedding a literal in a RegExp. */
const RE_SPECIAL = /[.+^${}()|[\]\\]/g

/**
 * Translate one mask segment into a regular-expression source fragment.
 *
 * Handled separately from a naive replace() chain because character sets need
 * their contents passed through mostly intact while everything around them is
 * escaped.
 *
 * @param {string} mask
 * @returns {string}
 */
function maskToRegExpSource(mask) {
  let out = ''
  let i = 0
  while (i < mask.length) {
    const ch = mask[i]

    if (ch === '[') {
      // '[[' is an escaped literal bracket.
      if (mask[i + 1] === '[') {
        out += '\\['
        i += 2
        continue
      }
      const close = mask.indexOf(']', i + 1)
      if (close === -1) {
        // Unterminated set — treat as a literal.
        out += '\\['
        i++
        continue
      }
      let body = mask.slice(i + 1, close)
      let negate = false
      if (body.startsWith('!') || body.startsWith('^')) {
        negate = true
        body = body.slice(1)
      }
      // Inside a set only ']' , '\' and '^' need care; ranges pass through.
      const safeBody = body.replace(/[\\\]^]/g, '\\$&')
      out += `[${negate ? '^' : ''}${safeBody}]`
      i = close + 1
      continue
    }

    if (ch === '*') {
      // '*' does not cross a path separator.
      out += '[^\\\\/]*'
      i++
      continue
    }

    if (ch === '?') {
      out += '[^\\\\/]'
      i++
      continue
    }

    if (ch === '\\' || ch === '/') {
      out += '[\\\\/]'
      i++
      continue
    }

    out += ch.replace(RE_SPECIAL, '\\$&')
    i++
  }
  return out
}

/**
 * Parse a single mask (no semicolons) into a matcher.
 *
 * @param {string} raw
 * @returns {ParsedMask|null} null for an empty mask
 */
export function parseMask(raw) {
  let mask = String(raw ?? '').trim()
  if (!mask) return null

  let exclude = false
  if (mask.startsWith('-')) {
    exclude = true
    mask = mask.slice(1).trim()
    if (!mask) return null
  }

  let folderOnly = false
  if (mask.endsWith('\\') || mask.endsWith('/')) {
    folderOnly = true
    mask = mask.slice(0, -1)
  }

  let anchored = false
  let anyDepth = false
  if (mask.startsWith('...\\') || mask.startsWith('.../')) {
    anyDepth = true
    mask = mask.slice(4)
  } else if (mask.startsWith('.\\') || mask.startsWith('./')) {
    anchored = true
    mask = mask.slice(2)
  } else if (mask.includes('\\') || mask.includes('/')) {
    // A mask with an embedded separator is relative to the base folder.
    anchored = true
  }

  // A trailing '.' means "no extension": 'readme.' matches 'readme', and '*.'
  // matches every extensionless name. Dropping the dot is not enough — '*'
  // would then happily match 'readme.txt' — so the final segment is also
  // asserted to contain no dot.
  let source
  if (mask.endsWith('.')) {
    source = `(?![^\\\\/]*\\.)${maskToRegExpSource(mask.slice(0, -1))}`
  } else {
    source = maskToRegExpSource(mask)
  }

  const prefix = anyDepth ? '(?:.*[\\\\/])?' : ''
  return {
    exclude,
    folderOnly,
    anchored,
    anyDepth,
    re: new RegExp(`^${prefix}${source}$`, 'i'),
    source: String(raw)
  }
}

/**
 * Parse a full mask string, which may hold several masks separated by ';'
 * or whitespace.
 *
 * @param {string} filterStr
 * @returns {ParsedMask[]}
 */
export function parseMasks(filterStr) {
  return String(filterStr ?? '')
    .split(/[;\n]+|\s+/)
    .map(parseMask)
    .filter(Boolean)
}

/**
 * Test a name (and optionally its path relative to the base folder) against a
 * parsed mask list.
 *
 * Include masks are a whitelist: when at least one is present, the entry has
 * to satisfy one of them. Exclude masks always veto.
 *
 * @param {ParsedMask[]} masks
 * @param {string} name          the entry's own name
 * @param {object} [opts]
 * @param {boolean} [opts.isDirectory]
 * @param {string}  [opts.relativePath] path from the base folder, e.g. 'src\\a.js'
 * @returns {boolean}
 */
export function matchesMasks(masks, name, opts = {}) {
  if (!masks.length) return true
  const isDirectory = !!opts.isDirectory
  const relativePath = opts.relativePath ?? name

  let hasInclude = false
  let included = false

  for (const m of masks) {
    if (m.folderOnly && !isDirectory) continue
    const subject = (m.anchored || m.anyDepth) ? relativePath : name
    const hit = m.re.test(subject)
    if (m.exclude) {
      if (hit) return false
    } else {
      hasInclude = true
      if (hit) included = true
    }
  }
  return hasInclude ? included : true
}

/**
 * Convenience wrapper: parse and test in one call.
 *
 * @param {string} name
 * @param {string} filterStr
 * @param {{ isDirectory?: boolean, relativePath?: string }} [opts]
 * @returns {boolean}
 */
export function matchesFilter(name, filterStr, opts = {}) {
  return matchesMasks(parseMasks(filterStr), name, opts)
}
