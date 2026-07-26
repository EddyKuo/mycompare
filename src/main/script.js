/**
 * @file script.js
 * @description Parser and interpreter for Beyond Compare-style comparison
 *   scripts.
 *
 *   BC's scripting language is how it gets driven from build systems and
 *   version-control hooks — the part of the product that runs without a user.
 *   Parsing is kept separate from execution so the grammar can be tested
 *   without touching the filesystem, and so a script can be validated before
 *   anything is copied or deleted.
 */

/**
 * Commands recognised by the interpreter, with their arity expectations.
 * `min` counts required operands after the command word.
 */
const COMMANDS = {
  'load': { min: 1, max: 3 },
  'compare': { min: 0, max: 8 },
  'criteria': { min: 1, max: 8 },
  'filter': { min: 1, max: 1 },
  'expand': { min: 0, max: 1 },
  'collapse': { min: 0, max: 1 },
  'select': { min: 0, max: 8 },
  'copy': { min: 0, max: 2 },
  'copyto': { min: 2, max: 3 },
  'move': { min: 1, max: 2 },
  'moveto': { min: 2, max: 3 },
  'delete': { min: 0, max: 8 },
  'rename': { min: 2, max: 2 },
  'touch': { min: 0, max: 1 },
  'sync': { min: 0, max: 3 },
  'folder-report': { min: 0, max: 8 },
  'file-report': { min: 0, max: 8 },
  'text-report': { min: 0, max: 8 },
  'data-report': { min: 0, max: 8 },
  'hex-report': { min: 0, max: 8 },
  'picture-report': { min: 0, max: 8 },
  'log': { min: 1, max: 2 },
  'option': { min: 1, max: 2 },
  'beep': { min: 0, max: 0 },
  'snapshot': { min: 1, max: 2 },
  'attrib': { min: 1, max: 2 },
}

/**
 * @typedef {object} ScriptCommand
 * @property {string} name        lower-cased command word
 * @property {string[]} operands  positional operands, quotes removed
 * @property {Record<string, string|boolean>} options  `key:value` modifiers
 * @property {number} line        1-based source line
 */

/**
 * @typedef {object} ParseResult
 * @property {ScriptCommand[]} commands
 * @property {{ line: number, message: string }[]} errors
 */

/**
 * Split one line into tokens, honouring double quotes.
 *
 * Paths with spaces are the norm here, so quoting has to work; a naive
 * whitespace split would silently truncate them into separate operands.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function tokenize(line) {
  const tokens = []
  let cur = ''
  let inQuote = false
  let has = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; continue }
      inQuote = !inQuote
      has = true
      continue
    }
    if (!inQuote && /\s/.test(ch)) {
      if (has || cur.length) { tokens.push(cur); cur = ''; has = false }
      continue
    }
    cur += ch
  }
  if (has || cur.length) tokens.push(cur)
  return tokens
}

/**
 * Parse a script into commands.
 *
 * Errors are collected rather than thrown, so a whole script can be reported
 * on in one pass instead of one failure at a time.
 *
 * @param {string} source
 * @returns {ParseResult}
 */
export function parseScript(source) {
  /** @type {ScriptCommand[]} */
  const commands = []
  /** @type {{ line: number, message: string }[]} */
  const errors = []

  const lines = String(source ?? '').split(/\r?\n/)
  lines.forEach((raw, idx) => {
    const line = idx + 1
    const stripped = raw.replace(/^\s+/, '')
    if (!stripped || stripped.startsWith('#') || stripped.startsWith('//')) return

    const tokens = tokenize(stripped)
    if (!tokens.length) return

    const name = tokens[0].toLowerCase()
    const spec = COMMANDS[name]
    if (!spec) {
      errors.push({ line, message: `未知的指令：${tokens[0]}` })
      return
    }

    /** @type {string[]} */
    const operands = []
    /** @type {Record<string, string|boolean>} */
    const options = {}

    for (const token of tokens.slice(1)) {
      // `key:value` is BC's modifier form; a bare Windows path like C:\x must
      // not be mistaken for one, so a single-letter key is treated as a path.
      const colon = token.indexOf(':')
      const isModifier = colon > 1 && !token.slice(0, colon).includes('\\')
      if (isModifier) {
        options[token.slice(0, colon).toLowerCase()] = token.slice(colon + 1) || true
      } else {
        operands.push(token)
      }
    }

    if (operands.length < spec.min) {
      errors.push({ line, message: `${name} 需要至少 ${spec.min} 個參數，實際 ${operands.length} 個` })
      return
    }
    if (operands.length > spec.max) {
      errors.push({ line, message: `${name} 最多接受 ${spec.max} 個參數，實際 ${operands.length} 個` })
      return
    }

    commands.push({ name, operands, options, line })
  })

  return { commands, errors }
}

/**
 * Commands that modify the filesystem.
 *
 * Used to decide whether a run needs confirmation, and to support a dry run —
 * a script that copies or deletes should be inspectable before it is trusted.
 */
export const MUTATING_COMMANDS = new Set([
  'copy', 'copyto', 'move', 'moveto', 'delete', 'rename', 'touch', 'sync', 'attrib',
])

/**
 * Whether a parsed script would change anything on disk.
 * @param {ScriptCommand[]} commands
 * @returns {boolean}
 */
export function isMutating(commands) {
  return (commands ?? []).some((c) => MUTATING_COMMANDS.has(c.name))
}

/**
 * Summarise a parsed script for review before running it.
 * @param {ScriptCommand[]} commands
 * @returns {string}
 */
export function describeScript(commands) {
  const list = commands ?? []
  if (!list.length) return '（空腳本）'
  const lines = list.map((c) => {
    const opts = Object.entries(c.options).map(([k, v]) => v === true ? k : `${k}:${v}`)
    return `  ${String(c.line).padStart(4)}  ${c.name} ${[...c.operands, ...opts].join(' ')}`.trimEnd()
  })
  const mutating = list.filter((c) => MUTATING_COMMANDS.has(c.name))
  const note = mutating.length
    ? `\n\n會修改檔案系統的指令：${mutating.length} 個（${[...new Set(mutating.map((c) => c.name))].join(', ')}）`
    : '\n\n此腳本不會修改檔案系統。'
  return lines.join('\n') + note
}
