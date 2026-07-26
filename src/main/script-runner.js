/**
 * @file script-runner.js
 * @description Execution engine for the scripts parsed by `script.js`.
 *
 *   Parsing was already separated from execution so a grammar error can be
 *   reported without touching a disk. This module is the other half, and it is
 *   written around one assumption: a script that runs unattended will one day
 *   run against the wrong directory. Every design choice below follows from
 *   that — dry run is the default, the only paths reachable are the ones the
 *   script itself declared with `load`, deletions are capped, and the first
 *   failure stops the run rather than letting the remaining commands act on a
 *   half-built state.
 *
 *   Folder comparison is re-implemented here (`_scanTree` / `_compareTrees`)
 *   instead of being shared with the renderer's `folder-compare.js`: that
 *   module reaches for `window.electronAPI` and builds DOM rows, so it cannot
 *   be loaded in the main process at all. Only the name/size/timestamp subset
 *   the script commands actually need is duplicated; the pure report helpers
 *   and the diff algorithm *are* shared, since those have no host dependency.
 */

import { join, dirname, basename, extname, relative, sep } from 'path'
import {
  readdir, stat, readFile, writeFile, copyFile, unlink, rename, mkdir, utimes,
} from 'fs/promises'
import { renderTextTable, reportHeader, reportSummary } from '../renderer/src/core/report.js'
import { diffLines } from '../renderer/src/core/diff-engine.js'

/** Deleting more than this in one script is treated as a runaway, not an intent. */
export const DEFAULT_DELETE_LIMIT = 100

/** Commands whose semantics are deliberately absent; reported, never ignored. */
export const UNIMPLEMENTED_COMMANDS = new Set([
  'snapshot', 'attrib', 'file-report', 'data-report', 'hex-report', 'picture-report',
])

/**
 * @typedef {object} ScriptFsStat
 * @property {boolean} isDirectory
 * @property {number} size
 * @property {number} mtimeMs
 */

/**
 * Filesystem surface the engine is allowed to touch.
 *
 * Injected rather than imported so tests can assert that a dry run performs no
 * write at all — an assertion that is only meaningful if every write goes
 * through this one object.
 *
 * @typedef {object} ScriptFs
 * @property {(p: string) => Promise<string[]>} readdir
 * @property {(p: string) => Promise<ScriptFsStat|null>} stat  null when missing
 * @property {(p: string) => Promise<string>} readFile
 * @property {(p: string, content: string) => Promise<void>} writeFile
 * @property {(src: string, dest: string) => Promise<void>} copyFile
 * @property {(p: string) => Promise<void>} unlink
 * @property {(from: string, to: string) => Promise<void>} rename
 * @property {(p: string) => Promise<void>} mkdirp
 * @property {(p: string, mtimeMs: number) => Promise<void>} utimes
 */

/**
 * @typedef {object} SideInfo
 * @property {string} path
 * @property {number} size
 * @property {number} mtimeMs
 */

/**
 * @typedef {object} Entry
 * @property {string} rel          path relative to the session root
 * @property {string} dir          parent directory, '' at the top level
 * @property {string} name
 * @property {SideInfo|null} left
 * @property {SideInfo|null} right
 * @property {'same'|'diff'|'left-orphan'|'right-orphan'} state
 * @property {'left'|'right'|'same'} newer
 */

/**
 * @typedef {object} ScriptOperation
 * @property {number} line
 * @property {'copy'|'delete'|'move'|'rename'|'touch'|'mkdir'|'report'|'log'} kind
 * @property {string} [src]
 * @property {string} [dest]
 * @property {boolean} done  false in a dry run, true once actually applied
 */

/**
 * Explicit interpreter state. BC scripts carry an implicit "current session"
 * (what `load` opened, what `select` picked); making it an object means the
 * tests can inspect it between commands instead of inferring it from side
 * effects.
 *
 * @typedef {object} ScriptContext
 * @property {{ kind: 'folder'|'file', left: string, right: string }|null} session
 * @property {{ size: boolean, timestamp: boolean, content: boolean }} criteria
 * @property {string} filter                raw mask string, '' when unset
 * @property {Entry[]} entries              every compared pair
 * @property {Entry[]} selection            what the mutating commands act on
 * @property {boolean} expandedAll
 * @property {Set<string>} expanded         explicitly expanded directories
 * @property {Record<string, string|boolean>} options
 * @property {string} logLevel
 * @property {string} logPath
 * @property {string[]} logLines
 * @property {ScriptOperation[]} operations
 * @property {number} deletePlanned
 * @property {number} deleteLimit
 * @property {boolean} execute
 */

/**
 * @typedef {object} RunResult
 * @property {boolean} ok
 * @property {number} exitCode
 * @property {boolean} execute
 * @property {number} planned
 * @property {number} completed
 * @property {ScriptOperation[]} operations
 * @property {{ line: number, message: string }[]} errors
 * @property {{ line: number, name: string }[]} unimplemented
 * @property {string[]} output
 * @property {ScriptContext} context
 */

/**
 * Adapter over `fs/promises` matching {@link ScriptFs}.
 * @returns {ScriptFs}
 */
export function createNodeFs() {
  return {
    readdir: (p) => readdir(p),
    stat: async (p) => {
      try {
        const st = await stat(p)
        return { isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs }
      } catch {
        return null
      }
    },
    readFile: (p) => readFile(p, 'utf-8'),
    writeFile: (p, content) => writeFile(p, content, 'utf-8'),
    copyFile: (src, dest) => copyFile(src, dest),
    unlink: (p) => unlink(p),
    rename: (from, to) => rename(from, to),
    mkdirp: async (p) => { await mkdir(p, { recursive: true }) },
    utimes: async (p, mtimeMs) => {
      const d = new Date(mtimeMs)
      await utimes(p, d, d)
    },
  }
}

/**
 * Fresh interpreter state.
 * @param {{ deleteLimit?: number, execute?: boolean }} [opts]
 * @returns {ScriptContext}
 */
export function createContext(opts = {}) {
  return {
    session: null,
    criteria: { size: true, timestamp: true, content: false },
    filter: '',
    entries: [],
    selection: [],
    expandedAll: false,
    expanded: new Set(),
    options: {},
    logLevel: 'normal',
    logPath: '',
    logLines: [],
    operations: [],
    deletePlanned: 0,
    deleteLimit: Number.isFinite(opts.deleteLimit) ? Number(opts.deleteLimit) : DEFAULT_DELETE_LIMIT,
    execute: opts.execute === true,
  }
}

/**
 * Run a parsed script.
 *
 * @param {import('./script.js').ScriptCommand[]} commands
 * @param {object} [opts]
 * @param {boolean} [opts.execute]        false (the default) performs no write
 * @param {ScriptFs} [opts.fs]
 * @param {(p: unknown) => string} [opts.validatePath]  throws when out of bounds
 * @param {(p: string) => void} [opts.registerRoot]
 * @param {number} [opts.deleteLimit]
 * @param {(line: string) => void} [opts.out]
 * @param {Date} [opts.now]
 * @returns {Promise<RunResult>}
 */
export async function runScript(commands, opts = {}) {
  const fs = opts.fs ?? createNodeFs()
  const validate = opts.validatePath ?? ((p) => String(p))
  const register = opts.registerRoot ?? (() => {})
  const now = opts.now ?? new Date()

  /** @type {string[]} */
  const output = []
  const out = (line) => {
    output.push(line)
    if (opts.out) opts.out(line)
  }

  const ctx = createContext(opts)
  /** @type {{ line: number, message: string }[]} */
  const errors = []
  /** @type {{ line: number, name: string }[]} */
  const unimplemented = []
  let completed = 0

  const env = {
    fs,
    validate,
    register,
    now,
    out,
    ctx,
    /** @type {Set<string>} */
    plannedDirs: new Set(),
    /**
     * The single gate every filesystem write passes through. Planning and
     * performing are the same call so a dry run cannot drift away from what a
     * real run would do.
     * @param {ScriptOperation} op
     * @param {() => Promise<void>} apply
     */
    async perform(op, apply) {
      ctx.operations.push(op)
      if (!ctx.execute) {
        out(`  [預演] ${describeOperation(op)}`)
        return
      }
      await apply()
      op.done = true
      completed++
      out(`  [執行] ${describeOperation(op)}`)
    },
  }

  const list = commands ?? []
  out(ctx.execute
    ? '模式：執行（/execute）— 檔案將被實際修改'
    : '模式：預演（dry-run）— 不會修改任何檔案，加上 /execute 才會實際執行')
  out(`指令數：${list.length}`)

  for (const cmd of list) {
    if (UNIMPLEMENTED_COMMANDS.has(cmd.name)) {
      unimplemented.push({ line: cmd.line, name: cmd.name })
      out(`${String(cmd.line).padStart(4)}: ${cmd.name} — 未實作，已略過`)
      continue
    }
    out(`${String(cmd.line).padStart(4)}: ${cmd.name}`)
    try {
      await execCommand(cmd, env)
    } catch (err) {
      // Fail fast: the remaining commands assume this one succeeded, and a
      // copy loop that keeps going after a denied path is how a partial,
      // unexplainable tree gets left behind.
      errors.push({ line: cmd.line, message: err instanceof Error ? err.message : String(err) })
      out(`  ✗ 第 ${cmd.line} 行失敗：${errors[errors.length - 1].message}`)
      break
    }
  }

  if (ctx.logPath && ctx.logLines.length) {
    try {
      await env.perform(
        { line: 0, kind: 'log', dest: ctx.logPath, done: false },
        () => fs.writeFile(ctx.logPath, ctx.logLines.join('\n') + '\n'),
      )
    } catch (err) {
      errors.push({ line: 0, message: `寫入 log 失敗：${err instanceof Error ? err.message : String(err)}` })
    }
  }

  const planned = ctx.operations.length
  out('—— 摘要 ——')
  out(`預計操作：${planned}`)
  out(`實際完成：${completed}`)
  if (unimplemented.length) {
    out(`未實作指令：${unimplemented.map((u) => `${u.name}(第 ${u.line} 行)`).join('、')}`)
  }
  if (!ctx.execute && planned > 0) {
    out('這是預演；重新加上 /execute 才會真正執行上述操作。')
  }

  return {
    ok: errors.length === 0,
    exitCode: errors.length ? 1 : 0,
    execute: ctx.execute,
    planned,
    completed,
    operations: ctx.operations,
    errors,
    unimplemented,
    output,
    context: ctx,
  }
}

/**
 * One-line rendering of a planned or performed operation.
 * @param {ScriptOperation} op
 * @returns {string}
 */
export function describeOperation(op) {
  switch (op.kind) {
    case 'copy': return `複製 ${op.src} → ${op.dest}`
    case 'move': return `移動 ${op.src} → ${op.dest}`
    case 'delete': return `刪除 ${op.src}`
    case 'rename': return `更名 ${op.src} → ${op.dest}`
    case 'touch': return `同步時間戳 ${op.dest}`
    case 'mkdir': return `建立目錄 ${op.dest}`
    case 'report': return `輸出報表 ${op.dest}`
    case 'log': return `寫入 log ${op.dest}`
    default: return op.kind
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/**
 * @param {import('./script.js').ScriptCommand} cmd
 * @param {object} env
 * @returns {Promise<void>}
 */
async function execCommand(cmd, env) {
  switch (cmd.name) {
    case 'load': return cmdLoad(cmd, env)
    case 'compare': return cmdCompare(cmd, env)
    case 'criteria': return cmdCriteria(cmd, env)
    case 'filter': return cmdFilter(cmd, env)
    case 'expand': return cmdExpandCollapse(cmd, env, true)
    case 'collapse': return cmdExpandCollapse(cmd, env, false)
    case 'select': return cmdSelect(cmd, env)
    case 'copy': return cmdCopy(cmd, env, false)
    case 'move': return cmdCopy(cmd, env, true)
    case 'copyto': return cmdCopyTo(cmd, env, false)
    case 'moveto': return cmdCopyTo(cmd, env, true)
    case 'delete': return cmdDelete(cmd, env)
    case 'rename': return cmdRename(cmd, env)
    case 'touch': return cmdTouch(cmd, env)
    case 'sync': return cmdSync(cmd, env)
    case 'folder-report': return cmdFolderReport(cmd, env)
    case 'text-report': return cmdTextReport(cmd, env)
    case 'log': return cmdLog(cmd, env)
    case 'option': return cmdOption(cmd, env)
    case 'beep': { env.out('  '); return }
    default:
      throw new Error(`指令 ${cmd.name} 沒有對應的執行實作`)
  }
}

/** Sessions must exist before anything can act on one. */
function requireSession(env) {
  if (!env.ctx.session) throw new Error('尚未 load 任何比對，無法執行此指令')
  return env.ctx.session
}

async function cmdLoad(cmd, env) {
  const [leftRaw, rightRaw] = cmd.operands
  if (!rightRaw) throw new Error('load 需要左右兩個路徑')

  // `load` is the only place a path enters the allow-list. Everything the rest
  // of the script can reach is therefore something the script itself declared.
  env.register(leftRaw)
  env.register(rightRaw)
  const left = env.validate(leftRaw)
  const right = env.validate(rightRaw)

  const [ls, rs] = [await env.fs.stat(left), await env.fs.stat(right)]
  if (!ls) throw new Error(`左側路徑不存在：${left}`)
  if (!rs) throw new Error(`右側路徑不存在：${right}`)
  if (ls.isDirectory !== rs.isDirectory) {
    throw new Error('load 的兩個路徑必須同為檔案或同為資料夾')
  }

  env.ctx.session = { kind: ls.isDirectory ? 'folder' : 'file', left, right }
  env.ctx.expandedAll = false
  env.ctx.expanded = new Set()
  await rescan(env)
  env.out(`  已載入 ${env.ctx.entries.length} 筆項目（${env.ctx.session.kind}）`)
}

async function cmdCompare(_cmd, env) {
  requireSession(env)
  await rescan(env)
  env.out(`  重新比對：${env.ctx.entries.length} 筆`)
}

async function cmdCriteria(cmd, env) {
  const flags = { size: false, timestamp: false, content: false }
  const tokens = [...cmd.operands, ...Object.keys(cmd.options)].map((t) => String(t).toLowerCase())
  for (const t of tokens) {
    if (t === 'size') flags.size = true
    else if (t === 'timestamp' || t === 'time' || t === 'date') flags.timestamp = true
    // CRC and a byte-for-byte compare differ only in how the answer is reached;
    // both are answered here by comparing the bytes.
    else if (t === 'binary' || t === 'content' || t === 'crc') flags.content = true
    else if (t === 'rules-based' || t === 'rules') flags.content = true
    else throw new Error(`不支援的比對準則：${t}`)
  }
  if (!flags.size && !flags.timestamp && !flags.content) {
    throw new Error('criteria 至少需要一個有效準則')
  }
  env.ctx.criteria = flags
  if (env.ctx.session) await rescan(env)
}

async function cmdFilter(cmd, env) {
  env.ctx.filter = cmd.operands[0] ?? ''
  if (env.ctx.session) await rescan(env)
  env.out(`  篩選：${env.ctx.filter || '（無）'}`)
}

async function cmdExpandCollapse(cmd, env, expanding) {
  requireSession(env)
  const target = (cmd.operands[0] ?? 'all').toLowerCase()
  if (target === 'all') {
    env.ctx.expandedAll = expanding
    if (!expanding) env.ctx.expanded.clear()
  } else if (expanding) {
    env.ctx.expanded.add(normaliseRel(cmd.operands[0]))
  } else {
    env.ctx.expanded.delete(normaliseRel(cmd.operands[0]))
  }
  // Anything hidden by a collapse can no longer be a target.
  env.ctx.selection = env.ctx.selection.filter((e) => isVisible(env.ctx, e))
}

async function cmdSelect(cmd, env) {
  requireSession(env)
  const tokens = cmd.operands.length ? cmd.operands : ['all']
  /** @type {Set<Entry>} */
  const picked = new Set()
  for (const raw of tokens) {
    const spec = normaliseSelector(raw)
    if (spec === 'none') { picked.clear(); continue }
    const match = selectorPredicate(spec)
    for (const e of env.ctx.entries) {
      if (isVisible(env.ctx, e) && match(e)) picked.add(e)
    }
  }
  env.ctx.selection = env.ctx.entries.filter((e) => picked.has(e))
  env.out(`  已選取 ${env.ctx.selection.length} 筆`)
}

async function cmdCopy(cmd, env, isMove) {
  const session = requireSession(env)
  const dir = parseDirection(cmd, 'left->right')
  const from = dir === 'left->right' ? 'left' : 'right'
  const destRoot = dir === 'left->right' ? session.right : session.left

  for (const entry of env.ctx.selection) {
    const src = entry[from]
    if (!src) continue
    const dest = env.validate(join(destRoot, entry.rel))
    await ensureParent(dest, env, cmd.line)
    await env.perform(
      { line: cmd.line, kind: isMove ? 'move' : 'copy', src: src.path, dest, done: false },
      async () => {
        await env.fs.copyFile(src.path, dest)
        if (isMove) await env.fs.unlink(src.path)
      },
    )
    if (isMove) countDelete(env, 1)
  }
  if (env.ctx.execute) await rescan(env)
}

async function cmdCopyTo(cmd, env, isMove) {
  requireSession(env)
  const side = normaliseSide(cmd.operands[0])
  const destRootRaw = cmd.operands[1]
  if (!destRootRaw) throw new Error(`${cmd.name} 需要目的資料夾`)
  // Deliberately *not* auto-registered: a destination that was never loaded is
  // exactly the mistake this guard exists for. The script must declare it.
  const destRoot = env.validate(destRootRaw)
  const flatten = cmd.options.flatten === true || cmd.options.flatten === 'yes'

  for (const entry of env.ctx.selection) {
    const src = entry[side]
    if (!src) continue
    const dest = env.validate(join(destRoot, flatten ? entry.name : entry.rel))
    await ensureParent(dest, env, cmd.line)
    await env.perform(
      { line: cmd.line, kind: isMove ? 'move' : 'copy', src: src.path, dest, done: false },
      async () => {
        await env.fs.copyFile(src.path, dest)
        if (isMove) await env.fs.unlink(src.path)
      },
    )
    if (isMove) countDelete(env, 1)
  }
  if (env.ctx.execute) await rescan(env)
}

async function cmdDelete(cmd, env) {
  requireSession(env)
  if (!cmd.operands.length) {
    throw new Error('delete 必須明確指定 left、right 或 both')
  }
  const sides = cmd.operands.map((o) => normaliseSide(o, true))
  const targets = []
  for (const entry of env.ctx.selection) {
    for (const side of sides.includes('both') ? ['left', 'right'] : sides) {
      if (entry[side]) targets.push(entry[side].path)
    }
  }
  countDelete(env, targets.length)
  for (const path of targets) {
    const p = env.validate(path)
    await env.perform(
      { line: cmd.line, kind: 'delete', src: p, done: false },
      () => env.fs.unlink(p),
    )
  }
  if (env.ctx.execute) await rescan(env)
}

async function cmdRename(cmd, env) {
  requireSession(env)
  const [mask, pattern] = cmd.operands
  if (!mask || !pattern) throw new Error('rename 需要遮罩與新名稱')
  const match = maskMatcher(mask)

  for (const entry of env.ctx.selection) {
    if (!match(entry.name)) continue
    const newName = applyRenamePattern(entry.name, pattern)
    if (newName === entry.name) continue
    for (const side of ['left', 'right']) {
      const info = entry[side]
      if (!info) continue
      const dest = env.validate(join(dirname(info.path), newName))
      await env.perform(
        { line: cmd.line, kind: 'rename', src: info.path, dest, done: false },
        () => env.fs.rename(info.path, dest),
      )
    }
  }
  if (env.ctx.execute) await rescan(env)
}

async function cmdTouch(cmd, env) {
  requireSession(env)
  // BC's TOUCH names the side being written; its timestamp comes from the other.
  const side = normaliseSide(cmd.operands[0] ?? 'right')
  const source = side === 'left' ? 'right' : 'left'
  for (const entry of env.ctx.selection) {
    if (!entry[side] || !entry[source]) continue
    if (entry[side].mtimeMs === entry[source].mtimeMs) continue
    const dest = env.validate(entry[side].path)
    const mtime = entry[source].mtimeMs
    await env.perform(
      { line: cmd.line, kind: 'touch', dest, done: false },
      () => env.fs.utimes(dest, mtime),
    )
  }
  if (env.ctx.execute) await rescan(env)
}

async function cmdSync(cmd, env) {
  const session = requireSession(env)
  let mode = 'update'
  let dir = 'left->right'
  if (typeof cmd.options.mirror === 'string') { mode = 'mirror'; dir = normaliseDirection(cmd.options.mirror) }
  else if (cmd.options.mirror === true) mode = 'mirror'
  else if (typeof cmd.options.update === 'string') { mode = 'update'; dir = normaliseDirection(cmd.options.update) }
  for (const op of cmd.operands) {
    const low = op.toLowerCase()
    if (low === 'mirror' || low === 'update') mode = low
    else dir = normaliseDirection(op)
  }

  const [from, to] = dir === 'left->right' ? ['left', 'right'] : ['right', 'left']
  const destRoot = dir === 'left->right' ? session.right : session.left

  // Sync works on the whole filtered tree, not the selection: that is what
  // makes it a sync rather than a batch copy.
  for (const entry of env.ctx.entries) {
    const src = entry[from]
    if (!src) continue
    if (entry.state === 'same') continue
    if (entry[to] && entry.newer === to) continue
    const dest = env.validate(join(destRoot, entry.rel))
    await ensureParent(dest, env, cmd.line)
    await env.perform(
      { line: cmd.line, kind: 'copy', src: src.path, dest, done: false },
      () => env.fs.copyFile(src.path, dest),
    )
  }

  if (mode === 'mirror') {
    const orphans = env.ctx.entries.filter((e) => e[to] && !e[from])
    countDelete(env, orphans.length)
    for (const entry of orphans) {
      const p = env.validate(entry[to].path)
      await env.perform(
        { line: cmd.line, kind: 'delete', src: p, done: false },
        () => env.fs.unlink(p),
      )
    }
  }
  if (env.ctx.execute) await rescan(env)
}

async function cmdFolderReport(cmd, env) {
  const session = requireSession(env)
  const rows = env.ctx.entries.map((e) => [
    e.rel,
    STATE_LABEL[e.state],
    e.left ? String(e.left.size) : '-',
    e.right ? String(e.right.size) : '-',
  ])
  const counts = {
    same: env.ctx.entries.filter((e) => e.state === 'same').length,
    diff: env.ctx.entries.filter((e) => e.state === 'diff').length,
    leftOrphan: env.ctx.entries.filter((e) => e.state === 'left-orphan').length,
    rightOrphan: env.ctx.entries.filter((e) => e.state === 'right-orphan').length,
  }
  const text = [
    reportHeader({
      title: String(cmd.options.title ?? '資料夾比對報表'),
      leftPath: session.left,
      rightPath: session.right,
      generatedAt: env.now,
    }),
    reportSummary(counts, {
      same: '相同', diff: '不同', leftOrphan: '僅左側', rightOrphan: '僅右側',
    }),
    '',
    renderTextTable(
      [{ title: '路徑' }, { title: '狀態' }, { title: '左側大小', align: 'right' }, { title: '右側大小', align: 'right' }],
      rows,
    ),
  ].join('\n')
  await emitReport(text, cmd, env)
}

async function cmdTextReport(cmd, env) {
  const session = requireSession(env)
  if (session.kind !== 'file') {
    throw new Error('text-report 需要以兩個檔案 load 的比對階段')
  }
  const [leftText, rightText] = [
    await env.fs.readFile(session.left),
    await env.fs.readFile(session.right),
  ]
  const lines = diffLines(leftText, rightText, {
    ignoreWhitespace: cmd.options.ignore === 'whitespace',
  })
  const changed = lines.filter((l) => l.type !== 'equal')
  const counts = {
    insert: changed.filter((l) => l.type === 'insert').length,
    delete: changed.filter((l) => l.type === 'delete').length,
    replace: changed.filter((l) => l.type === 'replace').length,
  }
  const text = [
    reportHeader({
      title: String(cmd.options.title ?? '文字比對報表'),
      leftPath: session.left,
      rightPath: session.right,
      generatedAt: env.now,
    }),
    reportSummary(counts, { insert: '新增', delete: '刪除', replace: '變更' }),
    '',
    renderTextTable(
      [{ title: '左行', align: 'right' }, { title: '右行', align: 'right' }, { title: '類型' }, { title: '內容' }],
      changed.map((l) => [
        l.leftLine === null ? '' : String(l.leftLine),
        l.rightLine === null ? '' : String(l.rightLine),
        l.type,
        l.type === 'insert' ? l.rightText : l.leftText,
      ]),
    ),
  ].join('\n')
  await emitReport(text, cmd, env)
}

async function cmdLog(cmd, env) {
  const level = String(cmd.operands[0] ?? 'normal').toLowerCase()
  env.ctx.logLevel = level
  const target = cmd.operands[1] ?? cmd.options['output-to']
  if (typeof target === 'string' && target) {
    env.ctx.logPath = env.validate(target)
  }
  env.ctx.logLines.push(`[${level}] log 由第 ${cmd.line} 行啟用`)
}

async function cmdOption(cmd, env) {
  const name = String(cmd.operands[0] ?? Object.keys(cmd.options)[0] ?? '').toLowerCase()
  const value = cmd.operands[1] ?? cmd.options[name] ?? true
  if (!name) throw new Error('option 需要名稱')
  env.ctx.options[name] = value
  if (name === 'delete-limit') {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) throw new Error('delete-limit 必須是非負整數')
    env.ctx.deleteLimit = n
    env.out(`  刪除上限改為 ${n}`)
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const STATE_LABEL = {
  same: '相同', diff: '不同', 'left-orphan': '僅左側', 'right-orphan': '僅右側',
}

/**
 * A report is still a write, so it goes through the same gate; without
 * `output-to` it is printed, which is safe in either mode.
 */
async function emitReport(text, cmd, env) {
  const target = cmd.options['output-to']
  if (typeof target !== 'string' || !target) {
    for (const line of text.split('\n')) env.out(`  ${line}`)
    return
  }
  const dest = env.validate(target)
  await ensureParent(dest, env, cmd.line)
  await env.perform(
    { line: cmd.line, kind: 'report', dest, done: false },
    () => env.fs.writeFile(dest, text),
  )
}

/** Create a missing destination directory, as its own auditable operation. */
async function ensureParent(destPath, env, line) {
  const parent = dirname(destPath)
  const st = await env.fs.stat(parent)
  if (st && st.isDirectory) return
  // A dry run never actually creates it, so without this the plan would list
  // the same mkdir once per file landing in that directory.
  if (env.plannedDirs.has(parent)) return
  env.plannedDirs.add(parent)
  await env.perform(
    { line, kind: 'mkdir', dest: parent, done: false },
    () => env.fs.mkdirp(parent),
  )
}

/**
 * Deletions are counted for the whole script, not per command: a runaway
 * usually shows up as many small deletes rather than one big one.
 */
function countDelete(env, n) {
  env.ctx.deletePlanned += n
  if (env.ctx.deletePlanned > env.ctx.deleteLimit) {
    throw new Error(
      `刪除數量 ${env.ctx.deletePlanned} 超過上限 ${env.ctx.deleteLimit}，已中止；` +
      '請確認腳本或以 `option delete-limit <n>` 明確放寬',
    )
  }
}

/** Re-read both sides and rebuild the comparison and selection. */
async function rescan(env) {
  const session = env.ctx.session
  if (!session) return
  const before = new Set(env.ctx.selection.map((e) => e.rel))

  if (session.kind === 'file') {
    const [l, r] = [await env.fs.stat(session.left), await env.fs.stat(session.right)]
    env.ctx.entries = [buildEntry(
      basename(session.left),
      l ? { path: session.left, size: l.size, mtimeMs: l.mtimeMs } : null,
      r ? { path: session.right, size: r.size, mtimeMs: r.mtimeMs } : null,
      env.ctx.criteria,
    )]
  } else {
    const [leftMap, rightMap] = [
      await scanTree(env, session.left),
      await scanTree(env, session.right),
    ]
    const rels = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort()
    const match = maskMatcher(env.ctx.filter)
    env.ctx.entries = rels
      .filter((rel) => match(basename(rel)))
      .map((rel) => buildEntry(rel, leftMap.get(rel) ?? null, rightMap.get(rel) ?? null, env.ctx.criteria))
  }

  if (env.ctx.criteria.content) await applyContentCriteria(env)
  env.ctx.selection = env.ctx.entries.filter((e) => before.has(e.rel))
}

/**
 * Recursive file listing keyed by path relative to the root.
 * @returns {Promise<Map<string, SideInfo>>}
 */
async function scanTree(env, root) {
  /** @type {Map<string, SideInfo>} */
  const map = new Map()
  /** @param {string} dir */
  const walk = async (dir) => {
    let names
    try {
      names = await env.fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      const st = await env.fs.stat(full)
      if (!st) continue
      if (st.isDirectory) await walk(full)
      else map.set(normaliseRel(relative(root, full)), { path: full, size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  await walk(root)
  return map
}

/**
 * @param {string} rel
 * @param {SideInfo|null} left
 * @param {SideInfo|null} right
 * @param {{ size: boolean, timestamp: boolean, content: boolean }} criteria
 * @returns {Entry}
 */
function buildEntry(rel, left, right, criteria) {
  const norm = normaliseRel(rel)
  const idx = norm.lastIndexOf('/')
  /** @type {Entry} */
  const entry = {
    rel: norm,
    dir: idx === -1 ? '' : norm.slice(0, idx),
    name: idx === -1 ? norm : norm.slice(idx + 1),
    left,
    right,
    state: !right ? 'left-orphan' : !left ? 'right-orphan' : 'same',
    newer: 'same',
  }
  if (left && right) {
    entry.newer = left.mtimeMs > right.mtimeMs ? 'left' : right.mtimeMs > left.mtimeMs ? 'right' : 'same'
    let differs = false
    if (criteria.size && left.size !== right.size) differs = true
    if (criteria.timestamp && left.mtimeMs !== right.mtimeMs) differs = true
    entry.state = differs ? 'diff' : 'same'
  }
  return entry
}

/**
 * Second pass for content-based criteria.
 *
 * Kept out of {@link buildEntry} because it is the only part of the comparison
 * that reads file bodies, and it must not run when the criteria never asked
 * for it — on a large tree that is the difference between a stat walk and
 * reading every byte.
 *
 * @param {object} env
 */
async function applyContentCriteria(env) {
  for (const entry of env.ctx.entries) {
    if (!entry.left || !entry.right) continue
    if (entry.left.size !== entry.right.size) { entry.state = 'diff'; continue }
    const [a, b] = [await env.fs.readFile(entry.left.path), await env.fs.readFile(entry.right.path)]
    entry.state = a === b ? 'same' : 'diff'
  }
}

/** Directory separators are normalised so masks and rel paths compare alike. */
function normaliseRel(p) {
  return String(p ?? '').split(sep).join('/').replace(/^\/+/, '')
}

/**
 * Visibility mirrors BC's tree: a collapsed folder's contents are not targets.
 * @param {ScriptContext} ctx
 * @param {Entry} entry
 */
function isVisible(ctx, entry) {
  if (ctx.expandedAll) return true
  if (!entry.dir) return true
  const parts = entry.dir.split('/')
  for (let i = 1; i <= parts.length; i++) {
    if (!ctx.expanded.has(parts.slice(0, i).join('/'))) return false
  }
  return true
}

/** `lt.newer.files` and `left.newer` mean the same thing. */
function normaliseSelector(raw) {
  const parts = String(raw).toLowerCase().split('.')
    .filter((p) => p && p !== 'files' && p !== 'file' && p !== 'folders' && p !== 'folder')
    .map((p) => (p === 'lt' ? 'left' : p === 'rt' ? 'right' : p))
  if (parts.includes('none')) return 'none'
  const side = parts.find((p) => p === 'left' || p === 'right')
  const kind = parts.find((p) => p !== 'left' && p !== 'right')
  if (!side) return kind ?? 'all'
  return `${side}.${kind ?? 'all'}`
}

/**
 * @param {string} spec
 * @returns {(e: Entry) => boolean}
 */
function selectorPredicate(spec) {
  switch (spec) {
    case 'all': return () => true
    case 'diff': return (e) => e.state !== 'same'
    case 'same': return (e) => e.state === 'same'
    case 'orphan': return (e) => e.state === 'left-orphan' || e.state === 'right-orphan'
    case 'newer': return (e) => e.state === 'diff' && e.newer !== 'same'
    case 'left.orphan': return (e) => e.state === 'left-orphan'
    case 'right.orphan': return (e) => e.state === 'right-orphan'
    case 'left.newer': return (e) => Boolean(e.left) && e.newer === 'left'
    case 'right.newer': return (e) => Boolean(e.right) && e.newer === 'right'
    case 'left.all': return (e) => Boolean(e.left)
    case 'right.all': return (e) => Boolean(e.right)
    case 'left.diff': return (e) => Boolean(e.left) && e.state !== 'same'
    case 'right.diff': return (e) => Boolean(e.right) && e.state !== 'same'
    default:
      throw new Error(`不支援的 select 條件：${spec}`)
  }
}

function normaliseSide(raw, allowBoth = false) {
  const v = String(raw ?? '').toLowerCase()
  if (v === 'left' || v === 'lt' || v === 'l') return 'left'
  if (v === 'right' || v === 'rt' || v === 'r') return 'right'
  if (allowBoth && (v === 'both' || v === 'all')) return 'both'
  throw new Error(`無法辨識的側別：${raw}`)
}

function normaliseDirection(raw) {
  const v = String(raw ?? '').toLowerCase().replace(/\s+/g, '')
  if (/^(left|lt|l)(->|2)(right|rt|r)$/.test(v)) return 'left->right'
  if (/^(right|rt|r)(->|2)(left|lt|l)$/.test(v)) return 'right->left'
  throw new Error(`無法辨識的方向：${raw}`)
}

function parseDirection(cmd, fallback) {
  const token = cmd.operands.find((o) => o.includes('->') || /^(l2r|r2l)$/i.test(o))
  if (token) return normaliseDirection(token)
  if (cmd.operands.length) {
    return normaliseSide(cmd.operands[0]) === 'left' ? 'left->right' : 'right->left'
  }
  return fallback
}

/**
 * Build a matcher for a BC filter string: `*.js;*.ts;-*.min.js`, where a
 * leading `-` excludes. With no include mask, everything not excluded passes.
 *
 * @param {string} mask
 * @returns {(name: string) => boolean}
 */
export function maskMatcher(mask) {
  const parts = String(mask ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return () => true
  const includes = []
  const excludes = []
  for (const p of parts) {
    if (p.startsWith('-')) excludes.push(globToRegExp(p.slice(1)))
    else includes.push(globToRegExp(p))
  }
  return (name) => {
    const n = String(name ?? '')
    if (excludes.some((re) => re.test(n))) return false
    return includes.length === 0 || includes.some((re) => re.test(n))
  }
}

function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * `*` in the replacement stands for the original stem, so `rename *.txt *.bak`
 * behaves the way the shell-trained user expects.
 */
export function applyRenamePattern(name, pattern) {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  if (!pattern.includes('*')) return pattern
  return pattern.replace(/\*/g, stem)
}
