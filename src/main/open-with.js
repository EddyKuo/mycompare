/**
 * @file open-with.js
 * @description Argument-template handling for the user-configured "Open With"
 *   program.
 *
 *   Separate from index.js so it can be tested without starting Electron, and
 *   because the parsing is the part with edge cases: quoted paths, a template
 *   that forgets to mention the file, and the fact that the result must be an
 *   argv array. Nothing here ever builds a shell string — the caller passes the
 *   array to execFile, so a path containing `&`, `|` or `"` is data.
 */

/**
 * Split an argument template into argv entries, substituting the file path.
 *
 * Quoted runs stay together so a path with spaces survives as one argument,
 * and `%1` is replaced inside a token rather than only as a whole token,
 * because the default template is `"%1"`.
 *
 * @param {string} template  e.g. `"%1"` or `--file "%1" --readonly`
 * @param {string} filePath  an already-validated absolute path
 * @returns {string[]} argv for execFile, never containing an unsubstituted %1
 */
export function buildOpenWithArgs(template, filePath) {
  const path = String(filePath ?? '')
  /** @type {string[]} */
  const out = []
  let cur = ''
  let quote = ''
  let has = false

  for (const ch of String(template ?? '')) {
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
      has = true
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue }
    if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false }
      continue
    }
    cur += ch
    has = true
  }
  if (has) out.push(cur)

  const subbed = out.map((a) => a.replace(/%1/g, path))
  // A template that never mentions the file would launch the program against
  // nothing, which the user reads as "Open With did nothing".
  return subbed.some((a) => a.includes(path)) && path ? subbed : [...subbed, path]
}
