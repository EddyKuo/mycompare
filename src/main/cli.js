/**
 * @file cli.js
 * @description Command-line parsing, modelled on Beyond Compare's switches.
 *
 *   BC is routinely driven from version-control hooks and build scripts, which
 *   is why the switch set matters as much as the GUI. Parsing lives here,
 *   separate from the Electron entry point, so it can be tested without
 *   launching a window.
 */

/**
 * Switches that carry a value, written either `/name=value` or `-name=value`.
 * Anything not listed here is treated as a boolean flag.
 */
const VALUE_SWITCHES = new Set([
  'center', 'filters', 'fv', 'fileviewer', 'lefttitle', 'mergeoutput',
  'qc', 'quickcompare', 'savetarget', 'righttitle', 'centertitle',
  'title1', 'title2', 'title3', 'title4', 'vcs1', 'vcs2', 'vcs3', 'vcs4',
  'script', 'lo', 'ro',
])

/** Aliases BC accepts for the same switch. */
const ALIASES = {
  h: 'help',
  '?': 'help',
  fileviewer: 'fv',
  quickcompare: 'qc',
  ignoreunimportant: 'iu',
}

/**
 * @typedef {object} CliOptions
 * @property {string[]} paths           positional file/folder arguments (max 4)
 * @property {Record<string, string|boolean>} switches
 * @property {string[]} unknown         switches that were not recognised
 */

/**
 * Decide whether a token is a switch rather than a path.
 *
 * `/` is ambiguous: on Windows it introduces a switch, on Unix it starts an
 * absolute path, and the same script may run on both. The name part (before
 * any `=`) settles it — a switch name is a bare word, so anything containing a
 * separator or a dot is a path. `/left.txt` and `/tmp/b.txt` are files;
 * `/silent` and `/filters=*.js` are switches.
 *
 * A leading `-` is unambiguous: no absolute path starts with one.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isSwitchToken(token) {
  if (token.startsWith('-')) return true
  if (!token.startsWith('/')) return false
  if (token.length === 1) return false

  const body = token.slice(1)
  const name = body.split('=')[0]
  return !(name.includes('/') || name.includes('\\') || name.includes('.'))
}

/**
 * Parse an argv array into positional paths and switches.
 *
 * Accepts both `/switch` (Windows convention, what BC documents) and
 * `-switch` / `--switch`, since the same script is often run on more than one
 * platform.
 *
 * @param {string[]} argv  full process.argv
 * @returns {CliOptions}
 */
export function parseCli(argv) {
  /** @type {string[]} */
  const paths = []
  /** @type {Record<string, string|boolean>} */
  const switches = {}
  /** @type {string[]} */
  const unknown = []

  for (const raw of (argv ?? []).slice(2)) {
    if (typeof raw !== 'string' || raw.length === 0) continue

    if (!isSwitchToken(raw)) {
      if (paths.length < 4) paths.push(raw)
      continue
    }

    const body = raw.replace(/^(--|-|\/)/, '')
    if (!body) continue

    const eq = body.indexOf('=')
    const rawName = (eq === -1 ? body : body.slice(0, eq)).toLowerCase()
    const name = ALIASES[rawName] ?? rawName
    const value = eq === -1 ? true : body.slice(eq + 1)

    if (eq !== -1 && !VALUE_SWITCHES.has(name) && !VALUE_SWITCHES.has(rawName)) {
      // A value was given for a flag: keep it rather than discarding, but say
      // it was not expected so callers can warn instead of silently ignoring.
      unknown.push(rawName)
    }
    switches[name] = value
  }

  return { paths, switches, unknown }
}

/**
 * Positional paths only, for callers that just want the files to open.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function parseCliArgs(argv) {
  return parseCli(argv).paths.slice(0, 2)
}

/**
 * Human-readable usage text.
 * @returns {string}
 */
export function usageText() {
  return [
    'MyCompare — 檔案與資料夾比對',
    '',
    '用法：mycompare [左側] [右側] [中間] [輸出] [選項]',
    '',
    '選項：',
    '  /?  /help              顯示此說明',
    '  /fv=<type>             指定比對視圖 (text|folder|hex|image|table|merge3)',
    '  /filters=<masks>       檔名遮罩，例如 /filters=*.js;-*.min.js',
    '  /qc=<criteria>         快速比對準則 (size|timestamp|crc|binary|rules)',
    '  /iu                    忽略不重要差異',
    '  /expandall             展開所有資料夾',
    '  /ro                    以唯讀開啟',
    '  /title1=<t> … /title4  自訂各窗格標題',
    '  /script=<file>         執行腳本檔後結束',
    '  /silent                腳本模式不顯示視窗',
    '',
    '腳本指令請見 docs 或 `/script` 檔案內的 help。',
  ].join('\n')
}
