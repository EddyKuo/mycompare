/**
 * Plain-text report generation.
 *
 * Beyond Compare offers each session's report in several layouts; only HTML
 * was implemented here. Plain text is the format that is useful in a terminal,
 * an email or a commit message, and it is the same shape for every view, so it
 * lives in one place rather than being reimplemented per view.
 */

/**
 * @typedef {object} ReportColumn
 * @property {string} title
 * @property {'left'|'right'} [align]
 */

/**
 * Render rows as a fixed-width text table.
 *
 * Column widths are measured, not guessed, so nothing is truncated; East Asian
 * characters are counted as two columns because otherwise a table containing
 * any CJK text no longer lines up in a monospace terminal.
 *
 * @param {ReportColumn[]} columns
 * @param {string[][]} rows
 * @returns {string}
 */
export function renderTextTable(columns, rows) {
  const widths = columns.map((c, i) => {
    let w = displayWidth(c.title)
    for (const row of rows) w = Math.max(w, displayWidth(row[i] ?? ''))
    return w
  })

  const line = (cells) => cells
    .map((cell, i) => pad(cell ?? '', widths[i], columns[i]?.align === 'right'))
    .join('  ')
    .replace(/\s+$/, '')

  const rule = widths.map((w) => '-'.repeat(w)).join('  ')
  return [line(columns.map((c) => c.title)), rule, ...rows.map(line)].join('\n')
}

/**
 * Display width in monospace cells: wide (East Asian) characters occupy two.
 * @param {string} s
 * @returns {number}
 */
export function displayWidth(s) {
  let w = 0
  for (const ch of String(s ?? '')) {
    w += isWide(ch) ? 2 : 1
  }
  return w
}

/**
 * @param {string} ch a single code point
 * @returns {boolean}
 */
function isWide(ch) {
  const cp = ch.codePointAt(0) ?? 0
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) ||   // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) ||   // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) ||   // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK extension B+
  )
}

/**
 * @param {string} s
 * @param {number} width
 * @param {boolean} right
 * @returns {string}
 */
function pad(s, width, right) {
  const gap = Math.max(0, width - displayWidth(s))
  return right ? ' '.repeat(gap) + s : s + ' '.repeat(gap)
}

/**
 * Standard report header: title, both paths and a timestamp.
 *
 * The timestamp is passed in rather than read from the clock so reports are
 * reproducible in tests.
 *
 * @param {{ title: string, leftPath?: string, rightPath?: string, generatedAt?: Date }} opts
 * @returns {string}
 */
export function reportHeader({ title, leftPath = '', rightPath = '', generatedAt }) {
  const when = (generatedAt ?? new Date()).toISOString().replace('T', ' ').slice(0, 19)
  return [
    title,
    '='.repeat(displayWidth(title)),
    `左：${leftPath || '（未知）'}`,
    `右：${rightPath || '（未知）'}`,
    `產生時間：${when}`,
    '',
  ].join('\n')
}

/**
 * Summary line built from a counts object, skipping zero entries so the line
 * stays readable.
 *
 * @param {Record<string, number>} counts
 * @param {Record<string, string>} labels
 * @returns {string}
 */
export function reportSummary(counts, labels) {
  const parts = []
  for (const [key, label] of Object.entries(labels)) {
    const n = counts?.[key]
    if (typeof n === 'number' && n > 0) parts.push(`${label} ${n}`)
  }
  return parts.length ? parts.join('，') : '無差異'
}
