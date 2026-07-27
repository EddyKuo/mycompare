/**
 * FolderCompare — 資料夾比對視圖
 * src/renderer/src/views/folder-compare.js
 */

import { showContextMenu } from '../core/context-menu.js'
import { el, debounce, formatSize } from '../core/utils.js'
import { isActive } from '../core/active-view.js'
import { parseMasks, matchesMasks } from '../core/file-mask.js'
import { diffLines } from '../core/diff-engine.js'
import { getViewTypeForPath } from '../core/file-type.js'
import { tagConfig, readConfig, NamedConfigStore } from '../core/named-config-store.js'
import { stepDiffIndex, navResult, getNavOptions } from '../core/diff-nav.js'
import '../styles/folder-compare.css'

/** @typedef {import('../core/diff-nav.js').NavResult} NavResult */

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * S14-M05: run an async function over an array with bounded concurrency.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} worker
 */
async function _runWithConcurrency(items, limit, worker) {
  let i = 0
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++
      try { await worker(items[idx]) } catch { /* swallow per-item */ }
    }
  })
  await Promise.all(runners)
}


/** 將 ISO8601 mtime 格式化為 YYYY-MM-DD HH:mm */
function formatMtime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/**
 * 判斷單一列是否通過名稱篩選。
 *
 * 遮罩語法見 core/file-mask.js，比照 BeyondCompare 的 File Masks：
 * `;` 分隔多重遮罩、`-` 排除、`[a-z]` 字元集、`name\` 只比對資料夾、
 * `.\` 與 `...\` 路徑相對語法、尾端 `.` 比對無副檔名的名稱。
 *
 * @param {string} name
 * @param {string} filterStr
 * @param {{ isDirectory?: boolean, relativePath?: string }} [opts]
 */
function matchesFilter(name, filterStr, opts = {}) {
  return matchesMasks(parseMasks(filterStr), name, opts)
}

/**
 * Beyond Compare's four filter fields.
 *
 * @typedef {object} FilterFields
 * @property {string} includeFiles
 * @property {string} excludeFiles
 * @property {string} includeFolders
 * @property {string} excludeFolders
 */

/** @type {FilterFields} */
export const EMPTY_FILTER_FIELDS = {
  includeFiles: '',
  excludeFiles: '',
  includeFolders: '',
  excludeFolders: '',
}

/**
 * Coerce anything into a full FilterFields, dropping unknown keys.
 * @param {unknown} raw
 * @returns {FilterFields}
 */
export function normalizeFilterFields(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {}
  /** @type {FilterFields} */
  const out = { ...EMPTY_FILTER_FIELDS }
  for (const key of Object.keys(EMPTY_FILTER_FIELDS)) {
    if (typeof src[key] === 'string') out[key] = src[key]
  }
  return out
}

/**
 * Apply the four BC filter fields to one entry.
 *
 * Each field only sees the kind it names: a file mask must not decide whether
 * a folder is shown, or typing `*.js` would collapse the whole tree by hiding
 * every directory that could contain a match. Exclusion wins over inclusion,
 * as it does in BC.
 *
 * The exclude fields are written as ordinary masks ("exclude these"), so they
 * are matched with include semantics and the *hit* is what excludes.
 *
 * @param {string} name
 * @param {FilterFields} fields
 * @param {{ isDirectory?: boolean, relativePath?: string }} [opts]
 * @returns {boolean}
 */
export function matchesFolderFilters(name, fields, opts = {}) {
  const f = normalizeFilterFields(fields)
  const isDir = !!opts.isDirectory
  const include = isDir ? f.includeFolders : f.includeFiles
  const exclude = isDir ? f.excludeFolders : f.excludeFiles

  if (exclude.trim() && matchesMasks(parseMasks(exclude), name, opts)) return false
  if (include.trim() && !matchesMasks(parseMasks(include), name, opts)) return false
  return true
}

/**
 * Parent directory of a filesystem path, or null when there is none.
 *
 * Stops at a drive root (`C:\`), a POSIX root (`/`) and a UNC share
 * (`\\server\share`) — climbing past any of those lands somewhere the user
 * never opened, which the path validator would reject anyway.
 *
 * @param {string|null|undefined} p
 * @returns {string|null}
 */
export function parentPath(p) {
  const raw = String(p ?? '')
  if (!raw) return null

  const unc = /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?$/.test(raw)
  if (unc) return null

  const trimmed = raw.replace(/[\\/]+$/, '')
  if (!trimmed) return null                       // '/' or '\' — already root
  if (/^[a-zA-Z]:$/.test(trimmed)) return null    // 'C:\' — already root

  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (cut < 0) return null
  const head = trimmed.slice(0, cut)
  if (!head) return '/'                           // '/usr' → '/'
  if (/^[a-zA-Z]:$/.test(head)) return `${head}\\` // 'C:\\tmp' → 'C:\\'
  if (/^\\\\[^\\/]+$/.test(head)) return null      // would climb above the share
  return head
}

/**
 * Labels of the jobs whose *target* is read-only.
 * @param {Array<{ label?: string, targetReadOnly?: boolean }>} jobs
 * @returns {string[]}
 */
export function readOnlyLabels(jobs) {
  return (jobs ?? []).filter((j) => j?.targetReadOnly).map((j) => j?.label ?? '')
}

/** How many read-only names to name before saying "…and N more". */
const READ_ONLY_SAMPLE = 8

/**
 * Text of the read-only confirmation.
 *
 * Both buttons do something: this is a choice between overwriting and
 * skipping, not between running and aborting, because "N 項失敗" with no
 * explanation is exactly the outcome this dialog exists to replace.
 *
 * @param {string[]} labels
 * @param {string} action  what is about to happen, e.g. '覆寫'
 * @returns {string}
 */
export function formatReadOnlyPrompt(labels, action) {
  const list = labels.slice(0, READ_ONLY_SAMPLE).map((l) => `　• ${l}`).join('\n')
  const more = labels.length > READ_ONLY_SAMPLE
    ? `\n　…另有 ${labels.length - READ_ONLY_SAMPLE} 項`
    : ''
  return `有 ${labels.length} 個目標檔案是唯讀的：\n${list}${more}\n\n` +
    `按「確定」仍嘗試${action}（若系統拒絕，會逐項列出失敗原因）\n` +
    `按「取消」略過這些唯讀檔案，其餘照常執行`
}

/**
 * @typedef {object} DeleteOutcome
 * @property {number} trashed          moved to the recycle bin
 * @property {number} permanent        deleted outright
 * @property {Array<{ path: string, message: string }>} failures
 */

/**
 * Summary line for a delete run.
 *
 * Where the files went is the part users need and the part the old code never
 * said: "N 項成功" is the same sentence whether the data is recoverable or not.
 *
 * @param {DeleteOutcome} outcome
 * @returns {string}
 */
export function formatDeleteSummary(outcome) {
  const parts = []
  if (outcome.trashed) parts.push(`已移至資源回收桶：${outcome.trashed} 項`)
  if (outcome.permanent) parts.push(`已永久刪除：${outcome.permanent} 項`)
  if (outcome.failures.length) parts.push(`失敗：${outcome.failures.length} 項`)
  if (!parts.length) parts.push('沒有刪除任何項目')
  const detail = outcome.failures.length
    ? '\n\n' + outcome.failures.map((f) => `• ${f.path}\n　${f.message}`).join('\n')
    : ''
  return parts.join('；') + detail
}

/**
 * Whether a delete failed because the platform has no usable recycle bin.
 *
 * The main process refuses rather than unlinking behind the user's back, so
 * this is the signal to offer permanent deletion as an explicit choice.
 *
 * @param {Array<{ message: string }>} failures
 * @returns {boolean}
 */
export function isRecycleBinUnavailable(failures) {
  return failures.length > 0 && failures.every((f) => /資源回收桶/.test(f?.message ?? ''))
}

/** Message text of an unknown thrown value. */
function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Upper bound on directories loaded by a single Expand All, so a deep tree
 * cannot fire an unbounded number of readDir IPC calls.
 */
const MAX_EXPAND_ALL_DIRS = 2000

/**
 * @typedef {object} ViewFlags
 * @property {boolean} showSame
 * @property {boolean} showDiff        content differences
 * @property {boolean} showLeftOnly
 * @property {boolean} showRightOnly
 * @property {boolean} showLeftNewer
 * @property {boolean} showRightNewer
 */

/**
 * Beyond Compare's View menu display filters.
 *
 * BC presents these as a preset list rather than independent toggles, and the
 * groupings are not always what the names suggest — "Show Differences", for
 * one, includes orphans.
 *
 * @type {Record<string, ViewFlags>}
 */
export const VIEW_PRESETS = {
  all:              { showSame: true,  showDiff: true,  showLeftOnly: true,  showRightOnly: true,  showLeftNewer: true,  showRightNewer: true },
  differences:      { showSame: false, showDiff: true,  showLeftOnly: true,  showRightOnly: true,  showLeftNewer: true,  showRightNewer: true },
  same:             { showSame: true,  showDiff: false, showLeftOnly: false, showRightOnly: false, showLeftNewer: false, showRightNewer: false },
  orphans:          { showSame: false, showDiff: false, showLeftOnly: true,  showRightOnly: true,  showLeftNewer: false, showRightNewer: false },
  'no-orphans':     { showSame: true,  showDiff: true,  showLeftOnly: false, showRightOnly: false, showLeftNewer: true,  showRightNewer: true },
  'diff-no-orphans':{ showSame: false, showDiff: true,  showLeftOnly: false, showRightOnly: false, showLeftNewer: true,  showRightNewer: true },
  'left-newer':     { showSame: false, showDiff: false, showLeftOnly: false, showRightOnly: false, showLeftNewer: true,  showRightNewer: false },
  'right-newer':    { showSame: false, showDiff: false, showLeftOnly: false, showRightOnly: false, showLeftNewer: false, showRightNewer: true },
  'left-orphans':   { showSame: false, showDiff: false, showLeftOnly: true,  showRightOnly: false, showLeftNewer: false, showRightNewer: false },
  'right-orphans':  { showSame: false, showDiff: false, showLeftOnly: false, showRightOnly: true,  showLeftNewer: false, showRightNewer: false },
  none:             { showSame: false, showDiff: false, showLeftOnly: false, showRightOnly: false, showLeftNewer: false, showRightNewer: false },
}

/** Display order and labels for the preset dropdown. */
export const VIEW_PRESET_LABELS = [
  ['all', '顯示全部'],
  ['differences', '顯示差異'],
  ['same', '顯示相同'],
  ['orphans', '顯示孤兒'],
  ['no-orphans', '不顯示孤兒'],
  ['diff-no-orphans', '差異但不含孤兒'],
  ['left-newer', '左側較新'],
  ['right-newer', '右側較新'],
  ['left-orphans', '僅左側孤兒'],
  ['right-orphans', '僅右側孤兒'],
  ['none', '全部隱藏'],
]

/**
 * Decide whether a row passes a set of view flags.
 *
 * Pure so the preset table can be verified without a DOM.
 *
 * @param {string} status
 * @param {ViewFlags} flags
 * @returns {boolean}
 */
export function statusVisibleUnder(status, flags) {
  switch (status) {
    case 'same':        return flags.showSame
    case 'different':   return flags.showDiff
    case 'left-only':   return flags.showLeftOnly
    case 'right-only':  return flags.showRightOnly
    case 'left-newer':  return flags.showLeftNewer
    case 'right-newer': return flags.showRightNewer
    default:            return true
  }
}

// ── Rules-based content comparison ──────────────────────────────────────────

/**
 * @typedef {object} RulesOptions
 * @property {boolean} ignoreWhitespace
 * @property {boolean} ignoreCase
 * @property {boolean} ignoreLineEndings
 * @property {boolean} ignoreIndent
 * @property {string[]} ignorePatterns    lines matching these take no part in the diff
 * @property {string[]} unimportantPatterns  changed lines matching these are not real differences
 * @property {number} maxBytes            per-file ceiling for reading into the renderer
 * @property {'myers'|'patience'|'histogram'} algorithm
 */

/**
 * Whitespace and line endings are unimportant by default because that is what
 * Beyond Compare's stock text rules do — the whole point of the rules mode is
 * that a re-indented or CRLF-converted file is not "different".
 * @type {RulesOptions}
 */
export const DEFAULT_RULES_OPTIONS = {
  ignoreWhitespace: true,
  ignoreCase: false,
  ignoreLineEndings: true,
  ignoreIndent: false,
  ignorePatterns: [],
  unimportantPatterns: [],
  maxBytes: 1_048_576,
  algorithm: 'myers',
}

/**
 * Hard ceiling on the per-file limit. Rules mode pulls whole files across IPC
 * into the renderer, so no configured value may exceed what a folder of them
 * can survive.
 */
export const MAX_RULES_FILE_BYTES = 4_194_304

/** Statuses worth a content check; anything else is already decided. */
const RULES_CANDIDATE_STATUSES = new Set(['different', 'left-newer', 'right-newer'])

/** Concurrent file-pair reads, matching the hash path's IPC budget. */
const RULES_CONCURRENCY = 8

/**
 * @param {unknown} raw
 * @returns {RulesOptions}
 */
export function normalizeRulesOptions(raw) {
  const src = (raw && typeof raw === 'object') ? /** @type {Record<string, unknown>} */ (raw) : {}
  const bool = (key) => typeof src[key] === 'boolean' ? src[key] : DEFAULT_RULES_OPTIONS[key]
  const list = (key) => Array.isArray(src[key])
    ? src[key].filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
    : [...DEFAULT_RULES_OPTIONS[key]]
  const size = Number(src.maxBytes)
  return {
    ignoreWhitespace: bool('ignoreWhitespace'),
    ignoreCase: bool('ignoreCase'),
    ignoreLineEndings: bool('ignoreLineEndings'),
    ignoreIndent: bool('ignoreIndent'),
    ignorePatterns: list('ignorePatterns'),
    unimportantPatterns: list('unimportantPatterns'),
    maxBytes: Number.isFinite(size) && size > 0
      ? Math.min(size, MAX_RULES_FILE_BYTES)
      : DEFAULT_RULES_OPTIONS.maxBytes,
    algorithm: ['myers', 'patience', 'histogram'].includes(/** @type {string} */ (src.algorithm))
      ? /** @type {'myers'|'patience'|'histogram'} */ (src.algorithm)
      : DEFAULT_RULES_OPTIONS.algorithm,
  }
}

/**
 * Compile user-supplied patterns, dropping the ones that do not parse.
 *
 * A typo in the rules panel must not abort a whole folder comparison, so an
 * invalid pattern is simply inert.
 *
 * @param {string[]} patterns
 * @returns {RegExp[]}
 */
export function compileRulePatterns(patterns) {
  const out = []
  for (const p of patterns ?? []) {
    try { out.push(new RegExp(p)) } catch { /* inert until the user fixes it */ }
  }
  return out
}

/**
 * Grade a pair of text files the way Beyond Compare's rules-based comparison
 * does: byte-equal, equal-once-the-rules-are-applied, or genuinely different.
 *
 * @param {string} leftText
 * @param {string} rightText
 * @param {Partial<RulesOptions>} [options]
 * @returns {'identical'|'minor'|'major'}
 */
export function classifyTextPair(leftText, rightText, options = {}) {
  const opts = normalizeRulesOptions(options)
  const left = String(leftText ?? '')
  const right = String(rightText ?? '')
  if (left === right) return 'identical'

  const ignoreRe = compileRulePatterns(opts.ignorePatterns)
  const unimportantRe = compileRulePatterns(opts.unimportantPatterns)

  // Lines the rules delete never reach the diff, so a change confined to them
  // cannot promote the pair to a real difference.
  const strip = (text) => ignoreRe.length
    ? text.split(/\r\n|\r|\n/).filter((line) => !ignoreRe.some((re) => re.test(line))).join('\n')
    : text

  const diff = diffLines(strip(left), strip(right), {
    algorithm: opts.algorithm,
    ignoreWhitespace: opts.ignoreWhitespace,
    ignoreCase: opts.ignoreCase,
    ignoreLineEndings: opts.ignoreLineEndings,
    ignoreIndent: opts.ignoreIndent,
  })
  const changed = diff.filter((d) => d.type !== 'equal')
  if (!changed.length) return 'minor'

  if (unimportantRe.length) {
    const covered = changed.every((d) =>
      [d.leftText, d.rightText].every((t) => !t || unimportantRe.some((re) => re.test(t))))
    if (covered) return 'minor'
  }
  return 'major'
}

/**
 * Map a grade onto the row fields the view renders.
 *
 * `minor` keeps the row on the "same" side of every count and filter — it is a
 * difference the rules declared uninteresting — and carries the `unimportant`
 * flag that paints it blue, per the project's colour semantics.
 *
 * @param {'identical'|'minor'|'major'} cls
 * @returns {{ status: 'same'|'different', unimportant: boolean }}
 */
export function statusForRulesClass(cls) {
  if (cls === 'major') return { status: 'different', unimportant: false }
  return { status: 'same', unimportant: cls === 'minor' }
}

/**
 * Whether a name is worth reading as text at all. Anything the app would route
 * to the image / hex / table views is binary as far as a line diff is
 * concerned and belongs on the hash path.
 *
 * @param {string} nameOrPath
 * @returns {boolean}
 */
export function isRulesTextCandidate(nameOrPath) {
  return getViewTypeForPath(String(nameOrPath ?? '')) === 'text'
}

/**
 * Split rows into the ones a line diff can grade and the ones that fall back to
 * hashing — binaries, and anything too large to pull into the renderer.
 *
 * @param {CompareRow[]} rows
 * @param {Partial<RulesOptions>} [options]
 * @returns {{ text: CompareRow[], hash: CompareRow[] }}
 */
export function planRulesComparison(rows, options = {}) {
  const { maxBytes } = normalizeRulesOptions(options)
  /** @type {{ text: CompareRow[], hash: CompareRow[] }} */
  const plan = { text: [], hash: [] }
  for (const row of rows ?? []) {
    if (!row?.left?.path || !row?.right?.path) continue
    if (row.left.isDirectory || row.right.isDirectory) continue
    if (!RULES_CANDIDATE_STATUSES.has(row.status)) continue
    const biggest = Math.max(Number(row.left.size) || 0, Number(row.right.size) || 0)
    const readable = isRulesTextCandidate(row.name ?? row.left.path) && biggest <= maxBytes
    ;(readable ? plan.text : plan.hash).push(row)
  }
  return plan
}

/**
 * Whether a directory contains nothing worse than unimportant differences.
 *
 * Kept separate from `rollupStatus` so the status rollup keeps its existing
 * contract; the flag is orthogonal to the status.
 *
 * @param {CompareRow} row
 * @returns {boolean}
 */
export function rollupUnimportant(row) {
  if (row?.unimportant) return true
  if (!row?.children) return false
  return row.children.some((child) => rollupUnimportant(child))
}

// ── Columns ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} FolderColumnDef
 * @property {string} id
 * @property {string} label
 * @property {string} width CSS grid track
 * @property {boolean} [locked] cannot be hidden
 */

/**
 * Columns the folder view is able to show, in canonical display order.
 *
 * `attrs` shows D/L/R/H plus `?` when the hidden flag is unreadable; see
 * {@link entryAttrText}. Virtual sources (archives, snapshots, remote hosts)
 * carry no attribute bits at all, so their rows show only what they do know.
 *
 * @type {FolderColumnDef[]}
 */
export const FOLDER_COLUMN_DEFS = [
  { id: 'name',    label: '名稱',     width: 'minmax(0, 1fr)', locked: true },
  { id: 'size',    label: '大小',     width: '80px' },
  { id: 'mtime',   label: '修改時間', width: '140px' },
  { id: 'ext',     label: '副檔名',   width: '72px' },
  { id: 'relpath', label: '相對路徑', width: '160px' },
  { id: 'attrs',   label: '屬性',     width: '56px' },
  { id: 'version', label: '版本',     width: '120px' },
]

/** @type {string[]} */
export const DEFAULT_FOLDER_COLUMNS = ['name', 'size', 'mtime']

const FOLDER_COLUMNS_KEY = 'mycompare:folderColumns'
const FOLDER_COLUMNS_SCHEMA = 1

/**
 * Coerce an arbitrary stored value into a usable column set.
 *
 * A set with no recognisable column falls back to the default rather than to
 * "name only" — a corrupt entry should not leave the user staring at a view
 * with no size or timestamp and no obvious way back.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeColumns(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_FOLDER_COLUMNS]
  const known = new Set(FOLDER_COLUMN_DEFS.map((c) => c.id))
  const picked = new Set(raw.filter((id) => typeof id === 'string' && known.has(id)))
  if (!picked.size) return [...DEFAULT_FOLDER_COLUMNS]
  // The name column carries the expand toggle and the icon, so it is not
  // something the user is allowed to switch off.
  picked.add('name')
  return FOLDER_COLUMN_DEFS.filter((c) => picked.has(c.id)).map((c) => c.id)
}

/**
 * @returns {string[]}
 */
export function loadFolderColumns() {
  try {
    const raw = localStorage.getItem(FOLDER_COLUMNS_KEY)
    if (!raw) return [...DEFAULT_FOLDER_COLUMNS]
    const parsed = JSON.parse(raw)
    // Tolerate a bare array from any earlier/hand-edited value.
    return normalizeColumns(Array.isArray(parsed) ? parsed : parsed?.columns)
  } catch {
    return [...DEFAULT_FOLDER_COLUMNS]
  }
}

/**
 * @param {unknown} ids
 * @returns {string[]} the normalised set that was actually stored
 */
export function saveFolderColumns(ids) {
  const columns = normalizeColumns(ids)
  try {
    localStorage.setItem(
      FOLDER_COLUMNS_KEY,
      JSON.stringify({ __schema: FOLDER_COLUMNS_SCHEMA, columns }),
    )
  } catch {
    // Quota or private-mode failure; the choice still applies to this session.
  }
  return columns
}

// ── Sorting ─────────────────────────────────────────────────────────────────

/**
 * @param {CompareRow} row
 * @returns {boolean}
 */
function isDirRow(row) {
  return !!(row?.left?.isDirectory || row?.right?.isDirectory)
}

/**
 * Lower-cased extension without the dot. A leading dot (`.gitignore`) is a
 * name, not an extension.
 * @param {string} name
 * @returns {string}
 */
export function extensionOf(name) {
  const base = String(name ?? '')
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * One directory entry, as produced by `read-dir`, `read-archive`,
 * `read-snapshot-dir` or `remote-list-dir`.
 *
 * @typedef {object} FileEntry
 * @property {string} name
 * @property {string} path              absolute fs path, or a virtual path
 * @property {boolean} isDirectory
 * @property {boolean} [isSymbolicLink]
 * @property {number} [size]
 * @property {string} [mtime]
 * @property {string} [ctime]
 * @property {boolean} [readOnly]
 * @property {boolean|null} [hidden]    null ⇒ the platform cannot tell
 * @property {string} [version]         filled in lazily by the version column
 * @property {number} [depth]           archive entries only
 * @property {string} [parentPath]      archive entries only
 * @property {boolean} [isArchiveEntry]
 */

/**
 * Attribute flags for one side, from what `read-dir` reports.
 *
 * `hidden` is tri-state: the main process reports `null` where the platform
 * gives it no way to tell (Windows keeps the flag in an attribute word Node's
 * `Stats` does not carry). A trailing `?` marks that case, because rendering
 * "not hidden" for something we simply cannot read would be a lie.
 *
 * @param {FileEntry|null|undefined} entry
 * @returns {string}
 */
export function entryAttrText(entry) {
  if (!entry) return ''
  return (entry.isDirectory ? 'D' : '') +
    (entry.isSymbolicLink ? 'L' : '') +
    (entry.readOnly ? 'R' : '') +
    (entry.hidden === true ? 'H' : '') +
    (entry.hidden === null || entry.hidden === undefined ? '?' : '')
}

/** Human-readable expansion of {@link entryAttrText}, used as the cell tooltip. */
export function entryAttrTitle(entry) {
  if (!entry) return ''
  const parts = []
  if (entry.isDirectory) parts.push('D＝目錄')
  if (entry.isSymbolicLink) parts.push('L＝符號連結')
  parts.push(entry.readOnly ? 'R＝唯讀' : '可寫入')
  if (entry.hidden === true) parts.push('H＝隱藏')
  else if (entry.hidden === false) parts.push('非隱藏')
  else parts.push('?＝隱藏屬性未知（此平台無法判讀）')
  return parts.join('、')
}

/**
 * Whether the two sides' attributes disagree, for BC's Compare Attributes.
 *
 * `hidden` is only evidence when both sides actually read it: the main process
 * reports `null` where the platform cannot tell, and treating "unknown" as a
 * difference would paint every Windows file red.
 *
 * @param {FileEntry|null|undefined} left
 * @param {FileEntry|null|undefined} right
 * @returns {boolean}
 */
export function attributesDiffer(left, right) {
  if (!left || !right) return false
  if (!!left.readOnly !== !!right.readOnly) return true
  if (typeof left.hidden === 'boolean' && typeof right.hidden === 'boolean'
      && left.hidden !== right.hidden) return true
  return false
}

// ── Move / Exchange ─────────────────────────────────────────────────────────
//
// Both operations touch two files at once, so a failure has a *middle*: the
// destination can exist while the source is already gone, or the source can be
// parked under a temporary name with nothing yet written back. Every function
// below reports which of those states it ended in, and the view prints that
// state verbatim. Silence here means the user loses a file without being told.

/**
 * The subset of `window.electronAPI` these operations need, named so tests can
 * substitute a stub that fails at a chosen step.
 *
 * @typedef {object} FileOpsApi
 * @property {(src: string, dest: string) => Promise<unknown>} copyFile
 * @property {(path: string, options?: { permanent?: boolean }) => Promise<unknown>} deleteFile
 * @property {(oldPath: string, newPath: string) => Promise<unknown>} renameFile
 */

/**
 * @typedef {'moved'|'source-remains'|'failed'} MoveState
 *   moved          — destination written, source gone
 *   source-remains — destination written, source could NOT be removed
 *   failed         — source untouched
 *
 * @typedef {object} MoveResult
 * @property {string} src
 * @property {string} dest
 * @property {MoveState} state
 * @property {string} [message]
 */

/**
 * Move one file to the other side.
 *
 * `rename` is tried first because it is atomic: it either moves the file or
 * leaves everything alone, with no window in which both copies exist. It fails
 * across volumes (EXDEV) and, on Windows, when the destination already exists,
 * which is ordinary rather than exceptional — hence the copy+delete fallback,
 * whose failure modes are the ones that need reporting.
 *
 * @param {{ src: string, dest: string }} job
 * @param {FileOpsApi} api
 * @returns {Promise<MoveResult>}
 */
export async function runMoveOne(job, api) {
  const { src, dest } = job
  try {
    await api.renameFile(src, dest)
    return { src, dest, state: 'moved' }
  } catch (renameErr) {
    try {
      await api.copyFile(src, dest)
    } catch (copyErr) {
      return {
        src, dest, state: 'failed',
        message: `複製到目的地失敗：${errText(copyErr)}（改名先前也失敗：${errText(renameErr)}）。`
          + `來源仍在原處；目的地可能留下不完整的檔案，請自行確認「${dest}」。`,
      }
    }
    try {
      await api.deleteFile(src)
    } catch (delErr) {
      return {
        src, dest, state: 'source-remains',
        message: `已寫入目的地，但刪除來源失敗：${errText(delErr)}。`
          + `檔案目前兩側都存在，來源「${src}」需要手動處理。`,
      }
    }
    return { src, dest, state: 'moved' }
  }
}

/**
 * @param {Array<{ src: string, dest: string }>} jobs
 * @param {FileOpsApi} api
 * @returns {Promise<MoveResult[]>}
 */
export async function runMove(jobs, api) {
  /** @type {MoveResult[]} */
  const results = []
  // Sequential rather than concurrent: a half-finished batch is far easier to
  // explain when the failures are in the order the user listed them.
  for (const job of jobs ?? []) results.push(await runMoveOne(job, api))
  return results
}

/**
 * @param {MoveResult[]} results
 * @returns {string}
 */
export function formatMoveSummary(results) {
  const list = results ?? []
  const moved = list.filter((r) => r.state === 'moved').length
  const partial = list.filter((r) => r.state === 'source-remains')
  const failed = list.filter((r) => r.state === 'failed')

  const lines = [`移動完成：${moved} 項成功`]
  if (partial.length) lines[0] += `，${partial.length} 項只完成一半`
  if (failed.length) lines[0] += `，${failed.length} 項失敗`

  if (partial.length) {
    lines.push('', '⚠ 已複製但來源未刪除（檔案兩側都在）：')
    for (const r of partial) lines.push(`• ${r.src}\n　${r.message}`)
  }
  if (failed.length) {
    lines.push('', '失敗（來源未動）：')
    for (const r of failed) lines.push(`• ${r.src}\n　${r.message}`)
  }
  return lines.join('\n')
}

/**
 * Where the left file is parked while the two sides trade places. Same
 * directory as the original so the parking step is a rename and not a copy.
 *
 * @param {string} path
 * @param {number|string} stamp
 * @returns {string}
 */
export function exchangeTempPath(path, stamp) {
  return `${path}.mycompare-exchange-${stamp}.tmp`
}

/**
 * @typedef {'exchanged'|'exchanged-with-leftover'|'rolled-back'|'unsafe'|'failed'} ExchangeState
 *   exchanged                — both sides swapped, nothing left behind
 *   exchanged-with-leftover  — both sides swapped, the temp file could not be removed
 *   rolled-back              — a step failed and both sides are back as they were
 *   unsafe                   — a step failed AND the rollback failed; a side is
 *                              wrong and the original content only exists in `tmp`
 *   failed                   — nothing was ever changed
 *
 * @typedef {object} ExchangeResult
 * @property {string} left
 * @property {string} right
 * @property {string} tmp
 * @property {ExchangeState} state
 * @property {string} message
 * @property {string[]} leftovers paths the user has to deal with by hand
 */

/**
 * Swap the contents of a matched pair of files.
 *
 * Ordering is chosen so that the original left content is recoverable at every
 * point: it is renamed aside first (atomic, undoable by name), and only then is
 * anything overwritten. The two overwrites each have an explicit rollback, and
 * a rollback that itself fails is reported as `unsafe` with the temp path
 * named — that file is the only remaining copy and must never be swallowed.
 *
 * @param {{ left: string, right: string }} pair
 * @param {FileOpsApi} api
 * @param {number|string} [stamp] fixed by tests; defaults to a wall-clock stamp
 * @returns {Promise<ExchangeResult>}
 */
export async function runExchange(pair, api, stamp = Date.now()) {
  const { left, right } = pair
  const tmp = exchangeTempPath(left, stamp)
  /** @type {(state: ExchangeState, message: string, leftovers?: string[]) => ExchangeResult} */
  const done = (state, message, leftovers = []) => ({ left, right, tmp, state, message, leftovers })

  // 1 — park the left file.
  try {
    await api.renameFile(left, tmp)
  } catch (err) {
    return done('failed', `無法暫存左側檔案「${left}」：${errText(err)}。兩側都未變更。`)
  }

  // 2 — right content lands on the left path.
  try {
    await api.copyFile(right, left)
  } catch (copyErr) {
    try {
      await api.renameFile(tmp, left)
      return done('rolled-back',
        `寫入左側失敗：${errText(copyErr)}。已還原，兩側維持原狀。`)
    } catch (restoreErr) {
      return done('unsafe',
        `寫入左側失敗：${errText(copyErr)}，且還原也失敗：${errText(restoreErr)}。\n`
        + `左側「${left}」目前不存在，原始內容留在「${tmp}」，請手動改回。`,
        [tmp])
    }
  }

  // 3 — the parked left content lands on the right path.
  try {
    await api.copyFile(tmp, right)
  } catch (copyErr) {
    try {
      // `left` exists again by now, so restoring is a copy, not a rename.
      await api.copyFile(tmp, left)
      const leftovers = await _removeExchangeTemp(api, tmp)
      return done(leftovers.length ? 'exchanged-with-leftover' : 'rolled-back',
        `寫入右側失敗：${errText(copyErr)}。左側已還原，兩側維持原狀。`
        + (leftovers.length ? `\n暫存檔「${tmp}」未能刪除，請手動移除。` : ''),
        leftovers)
    } catch (restoreErr) {
      return done('unsafe',
        `寫入右側失敗：${errText(copyErr)}，且還原左側也失敗：${errText(restoreErr)}。\n`
        + `左側「${left}」現在是右側的內容，左側原始內容只存在於「${tmp}」，請手動改回。`,
        [tmp])
    }
  }

  // 4 — clean up. Both sides are already correct, so a failure here is a
  // stray file rather than data loss — but it still gets named.
  const leftovers = await _removeExchangeTemp(api, tmp)
  return leftovers.length
    ? done('exchanged-with-leftover',
      `互換完成，但暫存檔「${tmp}」未能刪除，請手動移除。`, leftovers)
    : done('exchanged', '互換完成。')
}

/**
 * @param {ExchangeResult[]} results
 * @returns {string}
 */
export function formatExchangeSummary(results) {
  const list = results ?? []
  const ok = list.filter((r) => r.state === 'exchanged').length
  const leftover = list.filter((r) => r.state === 'exchanged-with-leftover')
  const rolledBack = list.filter((r) => r.state === 'rolled-back')
  const failed = list.filter((r) => r.state === 'failed')
  const unsafe = list.filter((r) => r.state === 'unsafe')

  const lines = [`互換完成：${ok + leftover.length} 組成功`]
  if (rolledBack.length) lines[0] += `，${rolledBack.length} 組已還原`
  if (failed.length) lines[0] += `，${failed.length} 組未執行`
  if (unsafe.length) lines[0] += `，${unsafe.length} 組需要手動處理`

  // The unsafe group goes first: it is the only one where a file is not where
  // the user left it, and burying it under the successes would hide it.
  if (unsafe.length) {
    lines.push('', '🛑 未完成且無法還原，請立刻處理：')
    for (const r of unsafe) lines.push(`• ${r.message}`)
  }
  if (leftover.length) {
    lines.push('', '⚠ 已互換，但暫存檔未刪除：')
    for (const r of leftover) lines.push(`• ${r.tmp}`)
  }
  if (rolledBack.length) {
    lines.push('', '已還原（兩側維持原狀）：')
    for (const r of rolledBack) lines.push(`• ${r.left}\n　${r.message}`)
  }
  if (failed.length) {
    lines.push('', '未執行：')
    for (const r of failed) lines.push(`• ${r.left}\n　${r.message}`)
  }
  return lines.join('\n')
}

/**
 * @param {FileOpsApi} api
 * @param {string} tmp
 * @returns {Promise<string[]>} the temp path when it survived, else empty
 */
async function _removeExchangeTemp(api, tmp) {
  try {
    // Permanent: this file is ours and was created seconds ago; sending our own
    // scratch file to the recycle bin would be noise the user has to clean up.
    await api.deleteFile(tmp, { permanent: true })
    return []
  } catch (err) {
    console.error('FolderCompare exchange: temp cleanup failed:', tmp, err)
    return [tmp]
  }
}

// ── Version column ──────────────────────────────────────────────────────────

/**
 * Extensions worth a `read-metadata` round trip.
 *
 * The main process sniffs the file's magic bytes, so it would answer for any
 * path — but a version column over a source tree would then fire one IPC per
 * file to learn "no version" tens of thousands of times. Only these formats
 * carry a version resource at all.
 */
/** Concurrent `read-metadata` calls, matching the hash path's IPC budget. */
const VERSION_CONCURRENCY = 4

/**
 * Ceiling on how many files one "sort by version" is allowed to read.
 *
 * Sorting is the only operation that legitimately needs versions for rows the
 * user cannot see, and it is exactly the operation that would otherwise walk a
 * 50k-file tree one IPC at a time.
 */
const MAX_VERSION_PREFETCH = 2000

const VERSION_CANDIDATE_EXTS = new Set([
  'exe', 'dll', 'sys', 'ocx', 'scr', 'cpl', 'drv', 'efi', 'mun', 'mui', 'mp3',
])

/**
 * @param {string} name
 * @returns {boolean}
 */
export function hasVersionCandidateExt(name) {
  return VERSION_CANDIDATE_EXTS.has(extensionOf(name))
}

/**
 * Version text for the column, from a `read-metadata` result.
 *
 * PE files get the version resource string, preferring the human-authored
 * `FileVersion` over the fixed 32-bit pair, which is often coarser. MP3s have
 * no version resource; their MPEG audio version is the closest true analogue
 * and is labelled as such rather than dressed up as a file version.
 *
 * @param {unknown} meta
 * @returns {string}
 */
export function versionTextFromMetadata(meta) {
  if (!meta || typeof meta !== 'object') return ''
  const rec = /** @type {{ kind?: string, fields?: Record<string, string>, audio?: Record<string, unknown> }} */ (meta)
  const fields = rec.fields ?? {}
  if (rec.kind === 'pe') {
    for (const key of ['FileVersion', 'FixedFileVersion', 'ProductVersion', 'FixedProductVersion']) {
      const value = fields[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }
  if (rec.kind === 'mp3') {
    const audio = rec.audio ?? {}
    const ver = audio.mpegVersion
    const layer = audio.layer
    if (ver && layer) return `MPEG ${ver} Layer ${layer}`
    if (ver) return `MPEG ${ver}`
    return ''
  }
  return ''
}

/**
 * Tooltip for the version cell: the remaining metadata, which is the reason
 * the read happened and is otherwise invisible.
 *
 * @param {unknown} meta
 * @returns {string}
 */
export function versionTitleFromMetadata(meta) {
  if (!meta || typeof meta !== 'object') return ''
  const rec = /** @type {{ kind?: string, fields?: Record<string, string> }} */ (meta)
  const entries = Object.entries(rec.fields ?? {}).filter(([, v]) => typeof v === 'string' && v.trim())
  if (!entries.length) return ''
  return entries.slice(0, 12).map(([k, v]) => `${k}: ${v}`).join('\n')
}

// ── Folder-view defaults (BC's "update defaults" scope) ─────────────────────

/**
 * Reserved name under which the folder view's default settings live in the
 * named-config store. Prefixed so a user-chosen name can never collide.
 */
export const FOLDER_DEFAULTS_NAME = '__mycompare:folder-defaults__'

const _folderConfigStore = new NamedConfigStore()

/**
 * @param {Record<string, unknown>} settings a `getConfig()` snapshot
 * @returns {boolean} whether it was stored
 */
export function saveFolderDefaults(settings) {
  return !!_folderConfigStore.save(FOLDER_DEFAULTS_NAME, 'folder', settings)
}

/**
 * @returns {Record<string, unknown>|null}
 */
export function loadFolderDefaults() {
  const entry = _folderConfigStore.get(FOLDER_DEFAULTS_NAME)
  if (!entry || entry.viewType !== 'folder') return null
  return readConfig('folder', entry.settings)
}

export function clearFolderDefaults() {
  _folderConfigStore.remove(FOLDER_DEFAULTS_NAME)
}

/**
 * Saved folder configs the user can pick from, with the reserved defaults
 * entry removed — it is reachable through the scope radio, not the list.
 *
 * @returns {Array<{ name: string }>}
 */
export function listFolderConfigs() {
  return _folderConfigStore.list('folder').filter((e) => e.name !== FOLDER_DEFAULTS_NAME)
}

// ── Virtual sources ─────────────────────────────────────────────────────────
//
// A folder side is not always a directory on disk: it can be an archive, a
// saved snapshot, or a remote host. Each names its entries with a path only
// its own reader understands, so every listing and every content read has to
// be routed by that path's scheme rather than assumed to be a filesystem path.
// Handing an archive's `zip::entry` to `readFile()` is exactly the bug this
// abstraction exists to prevent — the path validator rejects it and the
// comparison silently came up empty.

/**
 * @typedef {'fs'|'archive'|'snapshot'|'remote'} SourceKind
 *
 * @typedef {object} FolderSource
 * @property {SourceKind} kind
 * @property {string} root      fs directory, archive file, or snapshot file
 * @property {string} [profileId] remote only
 * @property {string} [secret]    remote only; never persisted
 * @property {string} [startDir]  remote only; directory the root row lists
 * @property {string} [label]     what to show in the path bar
 */

/**
 * Extensions the archive reader can open, matched against the part of a
 * virtual path before `::`.
 */
const ARCHIVE_EXT =
  /\.(zip|jar|war|ear|7z|tar|tgz|tbz2?|txz|gz|bz2|xz)$/i

/**
 * Open-dialog filters for every format `main/archive.js` can decode.
 *
 * A multi-part extension such as `.tar.gz` is matched by its last component,
 * which is how Electron's dialog filters work, so `gz` covers both a lone
 * gzip member and a gzipped tar — `detectFormat()` tells them apart by content.
 */
export const ARCHIVE_DIALOG_FILTERS = [
  {
    name: '封存檔',
    extensions: ['zip', 'jar', 'war', 'ear', '7z', 'tar', 'tgz', 'tbz', 'tbz2', 'txz', 'gz', 'bz2', 'xz'],
  },
  { name: 'Zip 家族 (zip/jar/war/ear)', extensions: ['zip', 'jar', 'war', 'ear'] },
  { name: 'Tar 家族 (tar/tgz/tbz2/txz)', extensions: ['tar', 'tgz', 'tbz', 'tbz2', 'txz'] },
  { name: '單檔壓縮 (gz/bz2/xz)', extensions: ['gz', 'bz2', 'xz'] },
  { name: '7-Zip (7z)', extensions: ['7z'] },
  { name: '所有檔案', extensions: ['*'] },
]

/**
 * Classify a path by the store that can actually read it.
 * @param {string|null|undefined} path
 * @returns {SourceKind}
 */
export function sourceKindOf(path) {
  const p = String(path ?? '')
  if (p.startsWith('snapshot://')) return 'snapshot'
  if (p.startsWith('remote://')) return 'remote'
  // `::` alone is not enough. A colon is a legal filename character
  // everywhere except Windows, so `/data/build::2024/report.txt` is an
  // ordinary file — and treating it as an archive entry would send it to the
  // archive reader and fail. The container has to look like an archive too.
  const i = p.indexOf('::')
  if (i > 0 && ARCHIVE_EXT.test(p.slice(0, i))) return 'archive'
  return 'fs'
}

/**
 * Split a path into the container that can read it and the path within.
 * @param {string|null|undefined} path
 * @returns {{ kind: SourceKind, container: string, entry: string }}
 */
export function parseVirtualPath(path) {
  const p = String(path ?? '')
  const kind = sourceKindOf(p)
  if (kind === 'archive') {
    const i = p.indexOf('::')
    return { kind, container: p.slice(0, i), entry: p.slice(i + 2) }
  }
  if (kind === 'snapshot') {
    return { kind, container: '', entry: p.slice('snapshot://'.length) }
  }
  if (kind === 'remote') {
    const rest = p.slice('remote://'.length)
    const i = rest.indexOf('/')
    return i < 0
      ? { kind, container: rest, entry: '' }
      : { kind, container: rest.slice(0, i), entry: rest.slice(i + 1) }
  }
  return { kind, container: p, entry: '' }
}

/**
 * Convert `read-archive`'s flat entry list into the FileEntry shape the tree
 * works with, synthesising the parent directories that tar and 7z omit —
 * without them a nested entry would have no row to hang under.
 *
 * @param {string} archivePath
 * @param {Array<{ path: string, size?: number, mtime?: string, isDirectory?: boolean }>} entries
 * @returns {FileEntry[]}
 */
export function archiveEntriesToFileEntries(archivePath, entries) {
  /** @type {Map<string, FileEntry>} */
  const out = new Map()

  /** @param {string} rel @param {boolean} isDir @param {object} extra */
  const put = (rel, isDir, extra) => {
    const parts = rel.split('/').filter(Boolean)
    if (!parts.length) return
    const key = parts.join('/')
    if (out.has(key) && !extra) return
    out.set(key, {
      name: parts[parts.length - 1],
      // Directories keep the trailing slash the zip reader already used, so a
      // parent path computed here matches one computed there.
      path: `${archivePath}::${key}${isDir ? '/' : ''}`,
      isDirectory: isDir,
      size: extra?.size ?? 0,
      mtime: extra?.mtime ?? new Date(0).toISOString(),
      depth: parts.length - 1,
      parentPath: parts.length > 1
        ? `${archivePath}::${parts.slice(0, -1).join('/')}/`
        : archivePath,
      isArchiveEntry: true,
    })
  }

  const prefix = `${archivePath}::`
  for (const e of entries ?? []) {
    // `read-archive` already returns fully-qualified `archive::entry` paths
    // while the raw parsers return bare relative ones; accept either.
    const raw = String(e.path ?? '')
    const rel = (raw.startsWith(prefix) ? raw.slice(prefix.length) : raw).replace(/\/+$/, '')
    if (!rel) continue
    const parts = rel.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) put(parts.slice(0, i).join('/'), true, null)
    put(rel, !!e.isDirectory, { size: e.size ?? 0, mtime: e.mtime })
  }
  return [...out.values()]
}

/**
 * Sort key for a row under a given column.
 *
 * `relpath` sorts on the absolute path: within one comparison every row on a
 * side shares the same base prefix, so it orders identically to the relative
 * path while keeping this function free of view state.
 *
 * @param {CompareRow} row
 * @param {string} key
 * @returns {string|number}
 */
export function columnSortValue(row, key) {
  const entry = row?.left ?? row?.right ?? null
  switch (key) {
    case 'size':
      return isDirRow(row) ? -1 : (entry?.size ?? -1)
    case 'mtime': {
      const t = Date.parse(entry?.mtime ?? '')
      return Number.isNaN(t) ? -1 : t
    }
    case 'ext':     return extensionOf(row?.name)
    case 'relpath': return entry?.path ?? row?.name ?? ''
    case 'attrs':   return entryAttrText(entry)
    // Rows whose version has not been read yet sort as empty rather than being
    // guessed at; the view fills the visible set in before sorting on it.
    case 'version': return String(entry?.version ?? '')
    case 'status':  return String(row?.status ?? '')
    default:        return String(row?.name ?? '')
  }
}

/**
 * @param {CompareRow} a
 * @param {CompareRow} b
 * @param {string} key
 * @param {number} [dir] 1 ascending, -1 descending
 * @returns {number}
 */
export function compareRowsBy(a, b, key, dir = 1) {
  // Directories stay above files whichever way the column sorts, as in BC.
  const aDir = isDirRow(a)
  const bDir = isDirRow(b)
  if (aDir !== bDir) return aDir ? -1 : 1

  const av = columnSortValue(a, key)
  const bv = columnSortValue(b, key)
  let cmp = (typeof av === 'number' && typeof bv === 'number')
    ? av - bv
    : String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' })
  // Name breaks ties so equal sizes/timestamps do not shuffle between renders.
  if (cmp === 0 && key !== 'name') {
    cmp = String(a?.name ?? '').localeCompare(String(b?.name ?? ''), undefined, { sensitivity: 'base' })
  }
  return cmp * (dir < 0 ? -1 : 1)
}

/**
 * Sort one level of the tree. Returns a new array of the *same* row objects so
 * callers keep the identity the expand/collapse bookkeeping relies on.
 *
 * @param {CompareRow[]} rows
 * @param {string} [key]
 * @param {number} [dir]
 * @returns {CompareRow[]}
 */
export function sortRows(rows, key = 'name', dir = 1) {
  return [...(rows ?? [])].sort((a, b) => compareRowsBy(a, b, key, dir))
}

// ── Visible-tree flattening ─────────────────────────────────────────────────

/**
 * @typedef {object} FlatRow
 * @property {CompareRow} row
 * @property {number} depth
 * @property {boolean} isDir
 * @property {boolean} expanded
 * @property {boolean} loading expanded but children have not arrived yet
 */

/**
 * Flatten the part of the tree the user can currently see into the
 * one-dimensional array the virtual scroller indexes into.
 *
 * Only expanded directories contribute children, so the array length equals the
 * number of rows on screen — which is what makes a fixed row height enough to
 * map scrollTop to a row index.
 *
 * @param {CompareRow[]} rows
 * @param {object} [opts]
 * @param {(row: CompareRow, depth: number) => boolean} [opts.isExpanded]
 * @param {(row: CompareRow, depth: number) => boolean} [opts.isVisible]
 * @param {(rows: CompareRow[]) => CompareRow[]} [opts.sort]
 * @param {number} [depth]
 * @returns {FlatRow[]}
 */
export function flattenVisibleRows(rows, opts = {}, depth = 0) {
  const isExpanded = opts.isExpanded ?? (() => false)
  const isVisible = opts.isVisible ?? (() => true)
  const sort = opts.sort ?? ((r) => r)

  const level = sort((rows ?? []).filter((row) => isVisible(row, depth)))
  const out = []
  for (const row of level) {
    const isDir = isDirRow(row)
    const expanded = isDir && !!isExpanded(row, depth)
    out.push({ row, depth, isDir, expanded, loading: expanded && !row.children })
    if (expanded && row.children) {
      out.push(...flattenVisibleRows(row.children, opts, depth + 1))
    }
  }
  return out
}

// ── Virtual scroll geometry ─────────────────────────────────────────────────

/** Fixed row height; must match `--fc-row-height` in folder-compare.css. */
const ROW_HEIGHT = 22
/** Rows rendered beyond each edge of the viewport, to hide scroll latency. */
const OVERSCAN = 4
/** Used when clientHeight is 0 (detached container / jsdom). */
const FALLBACK_VIEWPORT_HEIGHT = 600

const _raf = globalThis.requestAnimationFrame ?? ((cb) => setTimeout(cb, 16))
const _caf = globalThis.cancelAnimationFrame ?? clearTimeout

// ── compareEntries ────────────────────────────────────────────────────────────

/**
 * @param {FileEntry[]} leftEntries
 * @param {FileEntry[]} rightEntries
 * @param {'name'|'size'|'mtime'|'both'} mode
 * @returns {CompareRow[]}
 *
 * CompareRow: {
 *   name, status, left: FileEntry|null, right: FileEntry|null
 * }
 */
function compareEntries(leftEntries, rightEntries, mode, mtimeTolerance = 0, opts = {}) {
  const leftMap = new Map(leftEntries.map((e) => [e.name, e]))
  const rightMap = new Map(rightEntries.map((e) => [e.name, e]))
  const allNames = new Set([...leftMap.keys(), ...rightMap.keys()])

  const rows = []
  // Sort: directories first, then files; each group alphabetically.
  // A row counts as a directory if either side is a directory.
  const sorted = [...allNames].sort((a, b) => {
    const aLeft = leftMap.get(a), aRight = rightMap.get(a)
    const bLeft = leftMap.get(b), bRight = rightMap.get(b)
    const aIsDir = !!(aLeft?.isDirectory || aRight?.isDirectory)
    const bIsDir = !!(bLeft?.isDirectory || bRight?.isDirectory)
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
    return a.localeCompare(b, undefined, { sensitivity: 'base' })
  })
  for (const name of sorted) {
    const left = leftMap.get(name) ?? null
    const right = rightMap.get(name) ?? null
    const status = computeStatus(left, right, mode, mtimeTolerance, opts)
    // `children` is null until the directory is expanded or a full scan pulls
    // it in; an empty array means "loaded, and it has no entries".
    rows.push({ name, status, left, right, children: null })
  }
  return rows
}

/**
 * 依 mode 計算單一檔案/目錄的狀態
 * @param {FileEntry|null} left
 * @param {FileEntry|null} right
 * @param {'name'|'size'|'mtime'|'both'} mode
 * @param {number} [mtimeTolerance] 秒；時間差在容差內視為相同（跨檔案系統複製常見）
 * @param {{ compareAttributes?: boolean }} [opts]
 * @returns {'same'|'left-only'|'right-only'|'different'|'left-newer'|'right-newer'}
 */
function computeStatus(left, right, mode, mtimeTolerance = 0, opts = {}) {
  if (!right) return 'left-only'
  if (!left) return 'right-only'

  // 目錄本身沒有大小/內容可比；狀態改由子項 rollup 決定（見 _rollupStatus）。
  //
  // Compare Attributes 因此不套用於目錄：rollupStatus 會在子項載入後覆寫目錄
  // 狀態，屬性差異在那裡沒有容身之處，標了也會被吃掉。
  if (left.isDirectory && right.isDirectory) return 'same'

  // BC 的 Compare Attributes：屬性不同即為差異，優先於其餘判定，因為大小與
  // 時間相同的一對檔案正是唯一看得出屬性差異的情況。
  if (opts.compareAttributes && attributesDiffer(left, right)) return 'different'

  if (mode === 'name') return 'same'

  const sizeDiff = left.size !== right.size
  const lTime = new Date(left.mtime).getTime()
  const rTime = new Date(right.mtime).getTime()
  const timeDiff = Math.abs(lTime - rTime) > mtimeTolerance * 1000

  if (mode === 'size') {
    return sizeDiff ? 'different' : 'same'
  }

  if (mode === 'mtime') {
    if (!timeDiff) return 'same'
    return lTime > rTime ? 'left-newer' : 'right-newer'
  }

  // mode === 'both'
  if (!sizeDiff && !timeDiff) return 'same'
  if (sizeDiff) return 'different'
  // size 相同但時間不同
  return lTime > rTime ? 'left-newer' : 'right-newer'
}

/**
 * 深度優先攤平樹狀 CompareRow，並標注每列 depth。
 *
 * 報表與統計都以此為單一來源，避免「只有頂層進得了報表」的問題。
 *
 * @param {CompareRow[]} rows
 * @param {number} [depth]
 * @returns {CompareRow[]} 每個元素帶有 depth 欄位
 */
export function flattenRows(rows, depth = 0) {
  const out = []
  for (const row of rows ?? []) {
    out.push({ ...row, depth })
    if (row.children?.length) {
      out.push(...flattenRows(row.children, depth + 1))
    }
  }
  return out
}

/**
 * 依已載入的子項回推目錄狀態。
 *
 * BeyondCompare 的目錄列會反映「底下有沒有差異」；原本的實作把兩側都存在的
 * 目錄一律當成 'same'，使用者從摺疊的樹上看不出哪裡有差異。
 *
 * 子項尚未載入（children === null）時維持原狀態，不臆測。
 *
 * @param {CompareRow} row
 * @returns {CompareRow['status']}
 */
export function rollupStatus(row) {
  if (row.status === 'left-only' || row.status === 'right-only') return row.status
  if (!row.children) return row.status

  let sawLeftNewer = false
  let sawRightNewer = false
  let sawOther = false
  for (const child of row.children) {
    const s = child.children ? rollupStatus(child) : child.status
    if (s === 'same') continue
    if (s === 'left-newer') sawLeftNewer = true
    else if (s === 'right-newer') sawRightNewer = true
    else sawOther = true
  }
  if (sawOther) return 'different'
  if (sawLeftNewer && sawRightNewer) return 'different'
  if (sawLeftNewer) return 'left-newer'
  if (sawRightNewer) return 'right-newer'
  return 'same'
}

// ── FolderCompare Class ───────────────────────────────────────────────────────

export class FolderCompare {
  /**
   * @param {object} [options]
   * @param {string} [options.leftPath]
   * @param {string} [options.rightPath]
   * @param {'name'|'size'|'mtime'|'both'} [options.mode]
   */
  constructor(options = {}) {
    this._leftPath = options.leftPath ?? null
    this._rightPath = options.rightPath ?? null
    this._mode = options.mode ?? 'mtime'

    this._leftEntries = []   // FileEntry[] for current left dir
    this._rightEntries = []  // FileEntry[] for current right dir

    // Visibility filters. Orphans are tracked per side so BC's
    // "Show Left Orphans" / "Show Right Orphans" presets are expressible;
    // the _showOrphan accessor below keeps the combined toggle working.
    this._showSame = true
    this._showDiff = true
    this._showLeftOnly = true
    this._showRightOnly = true
    this._showLeftNewer = true   // T55
    this._showRightNewer = true  // T55
    this._viewPreset = 'all'
    // Quick filter. Kept alongside the four BC fields below rather than folded
    // into them: it is the only field that applies to files *and* folders, so
    // an existing `-node_modules` in a saved session keeps hiding the folder.
    this._filterStr = ''
    /** @type {FilterFields} BC's Include/Exclude Files/Folders */
    this._filterFields = normalizeFilterFields(options.filterFields)

    // Navigation history of {left,right} source pairs, for Back/Forward.
    /** @type {Array<{ left: FolderSource|null, right: FolderSource|null }>} */
    this._navHistory = []
    this._navIndex = -1
    /** Set while replaying history, so the replay is not recorded as a step. */
    this._navRestoring = false

    // Column set and sort order are a global preference rather than per-tab
    // state, so a newly opened comparison looks like the last one.
    this._columns = loadFolderColumns()
    this._sortKey = 'name'
    this._sortDir = 1
    /** @type {number} index into _visibleRows of the current difference, -1 = none */
    this._currentDiffIdx = -1
    /** @type {boolean} set when new folders are scanned, consumed after render */
    this._pendingFirstDiff = false

    // Expanded directories: Set of "side:path"
    this._expanded = new Set()

    /** @type {FlatRow[]} the flattened visible tree the virtual list indexes */
    this._visibleRows = []
    /** rAF handle coalescing scroll-driven window re-renders */
    this._scrollFrame = 0
    /** @type {string|null} path key of the row the keyboard acts on */
    this._focusedKey = null

    // Root of the compare tree. Each row may carry `children` once loaded.
    this._rows = []

    // expandKey → CompareRow, rebuilt on every full render so click handlers
    // can reach the real model object instead of rebuilding a stub from
    // dataset attributes.
    /** @type {Map<string, CompareRow>} */
    this._rowByKey = new Map()

    // 時間戳容差（秒）。跨檔案系統複製（NTFS ↔ FAT32）會有 1–2 秒誤差，
    // 預設 2 秒與 BeyondCompare 的 FAT 容差一致。
    this._mtimeTolerance = options.mtimeTolerance ?? 2

    /** @type {RulesOptions} settings for the `rules` compare mode */
    this._rulesOptions = normalizeRulesOptions(options.rulesOptions)

    // A scan owns an AbortController so a cancelled run can be told apart from
    // the one that replaced it; results from an aborted controller are dropped
    // rather than written back into the model.
    /** @type {AbortController|null} */
    this._scanController = null
    /** Items finished since the current scan started, for the progress read-out. */
    this._scanProcessed = 0

    // Event handlers map
    this._handlers = {}

    // Container element (set by mount)
    this._container = null

    // Cached DOM refs
    this._dom = {}

    // Style tag injected into document
    this._styleInjected = false

    // Debounced filter handler
    this._debouncedApplyFilter = debounce(() => this._applyFilterAndRender(), 300)

    // Sync mode state
    this._syncMode = false
    this._syncDirection = 'left-to-right' // 'left-to-right' | 'right-to-left' | 'bidirectional'
    this._syncOps = []

    // Flattened archive entries, kept per side because an archive is listed
    // once and then sliced by parent path rather than re-read per level.
    /** @type {FileEntry[]|null} */
    this._leftZipEntries = null
    /** @type {FileEntry[]|null} */
    this._rightZipEntries = null

    // What backs each side. Absent ⇒ an ordinary filesystem directory.
    /** @type {FolderSource|null} */
    this._leftSource = null
    /** @type {FolderSource|null} */
    this._rightSource = null

    /** Explains a compare mode the view changed on the user's behalf. */
    this._modeNote = ''

    // Batch selection: Set of path keys (leftPath || rightPath)
    this._selectedNames = new Set()

    // T54: Find bar state
    this._findQuery = ''
    this._findMatches = []   // Array of row elements matching find query
    this._findCursor = 0
    this._findBarVisible = false

    // P2-26: whether read-only/hidden take part in the status decision.
    this._compareAttributes = !!options.compareAttributes

    // P2-23: version text keyed by absolute path. Survives re-renders and
    // rescans, so scrolling back over a row never repeats its IPC.
    /** @type {Map<string, string>} */
    this._versionCache = new Map()
    /** @type {Set<string>} paths whose lookup is in flight */
    this._versionInFlight = new Set()
    /** @type {Map<string, string>} tooltip text keyed by absolute path */
    this._versionTitles = new Map()
    /** @type {Array<{ entry: FileEntry, path: string }>} queued by the renderer */
    this._versionQueue = []
    /** Timer coalescing the queue drain into one pass per render. */
    this._versionTimer = 0

    // P2-37: BC's settings scope. Defaults are stored under a reserved name in
    // the named-config store and read here, before any DOM exists, so a new
    // comparison opens with them already in force.
    if (options.useDefaults !== false) {
      const defaults = loadFolderDefaults()
      if (defaults) this._applyConfigSettings(defaults)
    }
  }

  /** Comparison options that are not the mode itself. @returns {{ compareAttributes: boolean }} */
  _compareOpts() {
    return { compareAttributes: this._compareAttributes }
  }

  /**
   * Combined orphan toggle, kept as an accessor over the per-side flags so the
   * single "顯示孤兒" checkbox still behaves as one control.
   */
  get _showOrphan() { return this._showLeftOnly || this._showRightOnly }
  set _showOrphan(v) { this._showLeftOnly = !!v; this._showRightOnly = !!v }

  /** Current view flags as a plain object. */
  get _viewFlags() {
    return {
      showSame: this._showSame,
      showDiff: this._showDiff,
      showLeftOnly: this._showLeftOnly,
      showRightOnly: this._showRightOnly,
      showLeftNewer: this._showLeftNewer,
      showRightNewer: this._showRightNewer,
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Apply one of Beyond Compare's View-menu display filters.
   * @param {keyof typeof VIEW_PRESETS} name
   */
  setViewPreset(name) {
    const preset = VIEW_PRESETS[name]
    if (!preset) return
    this._viewPreset = name
    this._showSame = preset.showSame
    this._showDiff = preset.showDiff
    this._showLeftOnly = preset.showLeftOnly
    this._showRightOnly = preset.showRightOnly
    this._showLeftNewer = preset.showLeftNewer
    this._showRightNewer = preset.showRightNewer
    this._syncFilterControls()
    this._applyFilterAndRender()
  }

  // ── Rules-based comparison ──────────────────────────────────────────────────

  /** @returns {RulesOptions} */
  getRulesOptions() {
    return { ...this._rulesOptions, ignorePatterns: [...this._rulesOptions.ignorePatterns], unimportantPatterns: [...this._rulesOptions.unimportantPatterns] }
  }

  /**
   * Merge in new rule settings and, in rules mode, re-grade the tree.
   * @param {Partial<RulesOptions>} partial
   * @returns {RulesOptions}
   */
  setRulesOptions(partial) {
    this._rulesOptions = normalizeRulesOptions({ ...this._rulesOptions, ...(partial ?? {}) })
    this._syncRulesControls()
    if (this._mode === 'rules' && (this._leftPath || this._rightPath)) {
      void this._compareAndRender()
    }
    return this.getRulesOptions()
  }

  // ── Scan progress & cancellation ────────────────────────────────────────────

  /** @returns {boolean} */
  isScanning() {
    return !!this._scanController
  }

  /**
   * Abort the running scan. Whatever the in-flight work returns afterwards is
   * discarded, so the tree keeps the last state the user actually saw.
   */
  cancelScan() {
    if (!this._scanController) return
    this._scanController.abort()
    this._setScanStatus('已取消')
  }

  /**
   * Start a scan generation, superseding any previous one.
   * @returns {AbortController}
   */
  _beginScan() {
    this._scanController?.abort()
    const ctrl = new AbortController()
    this._scanController = ctrl
    this._scanProcessed = 0
    if (this._dom.btnCancel) this._dom.btnCancel.style.display = ''
    this._setScanStatus('掃描中… 0 項')
    return ctrl
  }

  /**
   * @param {AbortController} ctrl
   */
  _endScan(ctrl) {
    // A newer scan may already own the UI; only its owner may clear it.
    if (this._scanController !== ctrl) return
    this._scanController = null
    if (this._dom.btnCancel) this._dom.btnCancel.style.display = 'none'
    if (!ctrl.signal.aborted) this._setScanStatus('')
  }

  /** @param {number} [n] */
  _tickProgress(n = 1) {
    this._scanProcessed += n
    if (this._scanController) this._setScanStatus(`掃描中… ${this._scanProcessed} 項`)
  }

  /** @param {string} text */
  _setScanStatus(text) {
    if (this._dom.scanStatus) this._dom.scanStatus.textContent = text
  }

  // ── Columns & sorting ───────────────────────────────────────────────────────

  /** @returns {string[]} currently visible column ids, in display order */
  getColumns() {
    return [...this._columns]
  }

  /**
   * Replace the visible column set and persist it.
   * @param {unknown} ids
   */
  setColumns(ids) {
    this._columns = saveFolderColumns(ids)
    this._rebuildHeader()
    this._applyFilterAndRender()
  }

  /** @param {string} id */
  toggleColumn(id) {
    this.setColumns(this._columns.includes(id)
      ? this._columns.filter((c) => c !== id)
      : [...this._columns, id])
  }

  /**
   * Sort by a column; asking again for the active column reverses it.
   * @param {string} key
   */
  sortBy(key) {
    if (!key) return
    if (this._sortKey === key) this._sortDir = -this._sortDir
    else { this._sortKey = key; this._sortDir = 1 }
    this._rebuildHeader()
    this._applyFilterAndRender()
    // Versions are read lazily for the visible window only, which is not
    // enough to order rows the user has not scrolled past yet.
    if (key === 'version') {
      void this.prefetchVersionsForSort().then(() => this._applyFilterAndRender())
    }
  }

  /** @returns {{ key: string, dir: number }} */
  getSort() {
    return { key: this._sortKey, dir: this._sortDir }
  }

  /**
   * Re-point the preset dropdown at whichever preset the current flags match,
   * so hand-tweaking the checkboxes does not leave a stale label showing.
   */
  _markPresetCustom() {
    const flags = this._viewFlags
    const hit = Object.entries(VIEW_PRESETS).find(([, p]) =>
      Object.keys(p).every((k) => p[k] === flags[k]))
    this._viewPreset = hit ? hit[0] : 'all'
    if (this._dom.viewPreset && hit) this._dom.viewPreset.value = hit[0]
  }

  /** Push the current flags back onto the toolbar controls. */
  _syncFilterControls() {
    const { cbSame, cbDiff, cbOrphan, btnLeftNewer, btnRightNewer, viewPreset } = this._dom
    if (cbSame) cbSame.checked = this._showSame
    if (cbDiff) cbDiff.checked = this._showDiff
    if (cbOrphan) cbOrphan.checked = this._showOrphan
    btnLeftNewer?.classList.toggle('fc-btn-filter-toggle--active', this._showLeftNewer)
    btnRightNewer?.classList.toggle('fc-btn-filter-toggle--active', this._showRightNewer)
    if (viewPreset) viewPreset.value = this._viewPreset
    if (this._dom.filter) this._dom.filter.value = this._filterStr
  }

  // ── Include / Exclude filters ───────────────────────────────────────────────

  /** @returns {FilterFields} */
  getFilterFields() {
    return { ...this._filterFields }
  }

  /**
   * Merge in new mask fields and re-filter.
   * @param {Partial<FilterFields>} partial
   * @returns {FilterFields}
   */
  setFilterFields(partial) {
    this._filterFields = normalizeFilterFields({ ...this._filterFields, ...(partial ?? {}) })
    this._syncFilterFieldControls()
    this._applyFilterAndRender()
    return this.getFilterFields()
  }

  /** BC's Clear button: empty every mask field, including the quick filter. */
  clearFilters() {
    this._filterStr = ''
    this._filterFields = { ...EMPTY_FILTER_FIELDS }
    if (this._dom.filter) this._dom.filter.value = ''
    this._syncFilterFieldControls()
    this._applyFilterAndRender()
  }

  /** Push the mask fields back onto the panel inputs. */
  _syncFilterFieldControls() {
    for (const [key, input] of Object.entries(this._dom.filterInputs ?? {})) {
      if (input) input.value = this._filterFields[key] ?? ''
    }
  }

  /** Read the panel inputs into the mask fields. */
  _readFilterPanel() {
    /** @type {Partial<FilterFields>} */
    const next = {}
    for (const [key, input] of Object.entries(this._dom.filterInputs ?? {})) {
      next[key] = input?.value ?? ''
    }
    this._filterFields = normalizeFilterFields({ ...this._filterFields, ...next })
    this._applyFilterAndRender()
  }

  /** 顯示 / 隱藏 Include/Exclude 篩選面板 */
  toggleFilterPanel() {
    const panel = this._dom.filterPanel
    if (!panel) return
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'
  }

  /** 把 UI 渲染到 containerEl */
  mount(containerEl) {
    this._container = containerEl
    this._render()
    this._bindEvents()
    // Auto-scan if paths were provided via constructor options
    if (this._leftPath || this._rightPath) {
      this._recordNav()
      this._scan()
    }
    this._syncNavButtons()
  }

  /** 呼叫 electronAPI.openFolder 取得左側路徑並掃描 */
  async openLeft() {
    const result = await window.electronAPI.openFolder()
    if (!result) return
    await this.setLeft(result.path)
  }

  /** 呼叫 electronAPI.openFolder 取得右側路徑並掃描 */
  async openRight() {
    const result = await window.electronAPI.openFolder()
    if (!result) return
    await this.setRight(result.path)
  }

  /**
   * Snapshot of the view's comparison settings, for the named-config store.
   * Paths are excluded so a config can be applied to any pair of folders.
   * @returns {object}
   */
  getConfig() {
    return tagConfig('folder', {
      mode: this._mode,
      viewPreset: this._viewPreset,
      mtimeTolerance: this._mtimeTolerance,
      compareAttributes: this._compareAttributes,
      filterStr: this._filterStr,
      filterFields: { ...this._filterFields },
      columns: [...this._columns],
      rulesOptions: this.getRulesOptions(),
      // The six flags are stored alongside the preset because a hand-tuned
      // combination that matches no preset is reported as 'all', which on its
      // own would restore the wrong set of rows.
      filters: {
        showSame: this._showSame,
        showDiff: this._showDiff,
        showLeftOnly: this._showLeftOnly,
        showRightOnly: this._showRightOnly,
        showLeftNewer: this._showLeftNewer,
        showRightNewer: this._showRightNewer,
      },
      sort: { key: this._sortKey, dir: this._sortDir },
    })
  }

  /**
   * Write a validated settings bundle into the view's state.
   *
   * State only — no DOM and no re-render, because the constructor applies the
   * stored defaults through here before anything is mounted.
   *
   * @param {Record<string, unknown>} settings
   */
  _applyConfigSettings(settings) {
    if (['name', 'size', 'mtime', 'both', 'content', 'rules'].includes(settings.mode)) {
      this._mode = settings.mode
    }
    if (settings.rulesOptions) {
      this._rulesOptions = normalizeRulesOptions({ ...this._rulesOptions, ...settings.rulesOptions })
    }
    if (typeof settings.mtimeTolerance === 'number' && settings.mtimeTolerance >= 0) {
      this._mtimeTolerance = settings.mtimeTolerance
    }
    if (typeof settings.compareAttributes === 'boolean') {
      this._compareAttributes = settings.compareAttributes
    }
    if (typeof settings.filterStr === 'string') this._filterStr = settings.filterStr
    if (settings.filterFields) this._filterFields = normalizeFilterFields(settings.filterFields)
    if (Array.isArray(settings.columns)) this._columns = saveFolderColumns(settings.columns)
    if (settings.viewPreset && VIEW_PRESETS[settings.viewPreset]) {
      const preset = VIEW_PRESETS[settings.viewPreset]
      this._viewPreset = settings.viewPreset
      for (const key of Object.keys(preset)) this[`_${key}`] = preset[key]
    }
    // After the preset, so an explicit flag set wins over the preset's.
    const filters = settings.filters
    if (filters && typeof filters === 'object') {
      for (const key of ['showSame', 'showDiff', 'showLeftOnly',
        'showRightOnly', 'showLeftNewer', 'showRightNewer']) {
        if (typeof filters[key] === 'boolean') this[`_${key}`] = filters[key]
      }
      this._markPresetCustom()
    }
    const sort = settings.sort
    if (sort && typeof sort === 'object'
        && typeof sort.key === 'string' && (sort.dir === 1 || sort.dir === -1)) {
      this._sortKey = sort.key
      this._sortDir = sort.dir
    }
  }

  /**
   * Apply a settings snapshot, optionally promoting it to the default for
   * every future folder comparison — Beyond Compare's "this view only" versus
   * "also update defaults" scope.
   *
   * @param {unknown} cfg
   * @param {{ scope?: 'view'|'default' }} [opts]
   * @returns {boolean} whether the snapshot was accepted
   */
  applyConfig(cfg, opts = {}) {
    const settings = readConfig('folder', cfg)
    if (!settings) return false
    this._applyConfigSettings(settings)

    this._syncRulesControls()
    this._syncFilterFieldControls()
    this._syncFilterControls()
    this._syncAttributeControl()
    this._rebuildHeader()

    if (opts.scope === 'default' && !saveFolderDefaults(this.getConfig())) {
      alert('無法將設定存為預設值（localStorage 無法寫入）；本次仍已套用至目前檢視。')
    }

    // A mode change alters comparison results, so re-scan rather than just
    // re-render; without paths there is nothing to compare yet.
    if (this._leftPath || this._rightPath) void this._compareAndRender()
    else this._applyFilterAndRender()
    return true
  }

  /**
   * Store the view's current settings as the default for new comparisons.
   * @returns {boolean}
   */
  saveAsDefaultConfig() {
    const ok = saveFolderDefaults(this.getConfig())
    if (!ok) alert('無法儲存預設值：localStorage 無法寫入。')
    return ok
  }

  /** Forget the stored defaults; new comparisons go back to the built-ins. */
  clearDefaultConfig() {
    clearFolderDefaults()
  }

  // ── P2-26: attributes as a comparison criterion ─────────────────────────────

  /** @returns {boolean} */
  getCompareAttributes() {
    return this._compareAttributes
  }

  /**
   * @param {boolean} on
   * @returns {boolean}
   */
  setCompareAttributes(on) {
    const next = !!on
    if (next === this._compareAttributes) return next
    this._compareAttributes = next
    this._syncAttributeControl()
    // The criterion feeds computeStatus, so every row has to be graded again.
    if (this._leftPath || this._rightPath) void this._compareAndRender()
    return next
  }

  /** Push the compare-attributes flag back onto its checkbox. */
  _syncAttributeControl() {
    if (this._dom.cbCompareAttrs) this._dom.cbCompareAttrs.checked = this._compareAttributes
  }


  // ── Public: difference navigation ───────────────────────────────────────────

  /**
   * Flattened-row indices whose entry is not identical on both sides.
   *
   * Derived from _visibleRows rather than the tree so navigation shares the
   * virtual scroller's coordinate system; anything else lands on the wrong
   * scrollTop.
   *
   * @returns {number[]}
   */
  getDiffIndices() {
    const out = []
    const flat = this._visibleRows ?? []
    for (let i = 0; i < flat.length; i++) {
      const status = flat[i]?.row?.status
      if (status && status !== 'same') out.push(i)
    }
    return out
  }

  /** @returns {number} 目前選取的差異索引；-1 表示尚未選取 */
  getCurrentDiffIndex() {
    return this._currentDiffIdx
  }

  /** 下一個差異項目（是否環繞依 Next Difference 設定）。 @returns {NavResult} */
  nextDifference() { return this._stepDiff(1) }

  /** 上一個差異項目（是否環繞依 Next Difference 設定）。 @returns {NavResult} */
  prevDifference() { return this._stepDiff(-1) }

  /** @returns {NavResult} */
  firstDifference() { return this._jumpDiff(0) }

  /** @returns {NavResult} */
  lastDifference() { return this._jumpDiff(this.getDiffIndices().length - 1) }

  /**
   * @param {number} delta
   * @returns {NavResult}
   */
  _stepDiff(delta) {
    const total = this.getDiffIndices().length
    const to = stepDiffIndex(this._currentDiffIdx, total, delta)
    return this._jumpDiff(to)
  }

  /**
   * @param {number} target index into getDiffIndices()
   * @returns {NavResult}
   */
  _jumpDiff(target) {
    const indices = this.getDiffIndices()
    const total = indices.length
    const from = this._currentDiffIdx
    if (total === 0 || target < 0 || target >= total) return navResult(from, -1, total)
    this._currentDiffIdx = target
    this._scrollFlatIndexIntoView(indices[target])
    this._applyCurrentDiffMark(indices[target])
    return navResult(from, target, total)
  }

  /**
   * Mark the current difference row.
   *
   * Styled inline rather than through a class because the row cursor has no
   * entry in folder-compare.css, and an outline cannot shift the virtualised
   * row geometry the way a border would.
   *
   * @param {number} flatIndex
   */
  _applyCurrentDiffMark(flatIndex) {
    const vlist = this._dom.vlist
    if (!vlist) return
    for (const rowEl of vlist.querySelectorAll('.fc-row')) {
      const isCurrent = Number(rowEl.dataset.flatIndex) === flatIndex
      rowEl.dataset.currentDiff = isCurrent ? 'true' : 'false'
      rowEl.style.outline = isCurrent ? '2px solid var(--accent-color, #4a90d9)' : ''
      rowEl.style.outlineOffset = isCurrent ? '-2px' : ''
    }
  }

  /**
   * BC's "when loading new files, go to first difference". Flag-gated so that
   * a filter change, which also re-renders, leaves the user where they were.
   */
  _consumePendingFirstDiff() {
    if (!this._pendingFirstDiff) return
    this._pendingFirstDiff = false
    if (!getNavOptions().firstDiffOnLoad) return
    this.firstDifference()
  }

  /** 開啟檔名搜尋列（Search ▸ Find Filename）。 */
  openFindBar() {
    this._openFindBar()
  }

  /** 對調左右兩側資料夾並重新掃描（Session ▸ Swap Sides）。 */
  async swap() {
    ;[this._leftPath, this._rightPath] = [this._rightPath, this._leftPath]
    ;[this._leftZipEntries, this._rightZipEntries] = [this._rightZipEntries, this._leftZipEntries]
    ;[this._leftSource, this._rightSource] = [this._rightSource, this._leftSource]
    this._updatePathDisplay('left', this._sourceLabel('left'))
    this._updatePathDisplay('right', this._sourceLabel('right'))
    this._expanded.clear()
    this._recordNav()
    await this._scan()
  }

  /**
   * Pick an archive and put it on one side.
   *
   * Goes through `read-archive`, which decodes every format `main/archive.js`
   * supports; the old `open-zip` path was JSZip-only, so tar/gzip/bzip2/xz/7z
   * had a decoder, an IPC channel and tests but no way in from the UI.
   *
   * The file dialog is `openFileBinary` with a one-byte ceiling because what
   * is needed here is the *path* plus the root registration a dialog performs
   * — the archive itself is re-read in the main process by `read-archive`, and
   * shipping its bytes through IPC only to discard them would be pure cost.
   *
   * @param {'left'|'right'} side
   */
  async openArchive(side) {
    const picked = await window.electronAPI.openFileBinary({
      filters: ARCHIVE_DIALOG_FILTERS,
      maxBytes: 1,
    })
    if (!picked?.path) return
    try {
      await this.openArchiveSide(side, picked.path)
    } catch (err) {
      console.error('FolderCompare.openArchive failed:', picked.path, err)
      alert(`無法開啟封存檔「${picked.path}」：\n${errText(err)}`)
    }
  }

  /** 開啟左側封存檔 */
  async openArchiveLeft() { await this.openArchive('left') }

  /** 開啟右側封存檔 */
  async openArchiveRight() { await this.openArchive('right') }

  /**
   * Put an archive on one side of the comparison.
   *
   * Separate from the dialog so a session restore, a drop, or a test can
   * supply the path directly; when no listing is handed in it is fetched
   * through `read-archive`, which also covers tar/7z rather than zip alone.
   *
   * @param {'left'|'right'} side
   * @param {string} archivePath
   * @param {Array<object>} [entries] pre-listed entries from `open-zip`
   */
  async openArchiveSide(side, archivePath, entries) {
    const listing = entries ?? await window.electronAPI.readArchive(archivePath)
    const rows = Array.isArray(listing) ? listing : (listing?.entries ?? [])
    // `open-zip` already returns tree-shaped entries; `read-archive` returns a
    // flat list that still needs its parent directories synthesised.
    const flat = rows.length && rows[0]?.parentPath !== undefined
      ? rows.map((e) => ({ ...e, isArchiveEntry: true }))
      : archiveEntriesToFileEntries(archivePath, rows)

    if (side === 'left') this._leftZipEntries = flat
    else this._rightZipEntries = flat
    await this.setSource(side, { kind: 'archive', root: archivePath, label: `${archivePath} [壓縮檔]` })
  }

  /**
   * Point one side at any backing store and re-scan.
   *
   * @param {'left'|'right'} side
   * @param {FolderSource} source
   */
  async setSource(side, source) {
    // A remote side being replaced owns a live connection; dropping the
    // reference without closing it leaks the session until the idle timer.
    await this._disconnectRemote(side)

    if (side === 'left') {
      this._leftSource = source
      this._leftPath = source.root
      if (source.kind !== 'archive') this._leftZipEntries = null
    } else {
      this._rightSource = source
      this._rightPath = source.root
      if (source.kind !== 'archive') this._rightZipEntries = null
    }
    this._updatePathDisplay(side, this._sourceLabel(side))
    this._syncModeAvailability()
    this._expanded.clear()
    this._pendingFirstDiff = true
    this._recordNav()
    await this._scan()
  }

  // ── Navigation history & Up One Level ───────────────────────────────────────

  /**
   * Push the current pair of sources onto the history.
   *
   * Recorded per side change rather than per pair, matching what the user did:
   * opening the left folder and then the right one are two steps they can walk
   * back through one at a time.
   */
  _recordNav() {
    if (this._navRestoring) return
    const entry = { left: this._currentSource('left'), right: this._currentSource('right') }
    const top = this._navHistory[this._navIndex]
    if (top && top.left?.root === entry.left?.root && top.right?.root === entry.right?.root) return
    // A new step invalidates whatever was ahead of the cursor.
    this._navHistory.splice(this._navIndex + 1)
    this._navHistory.push(entry)
    this._navIndex = this._navHistory.length - 1
    this._syncNavButtons()
  }

  /** @returns {boolean} */
  canGoBack() { return this._navIndex > 0 }

  /** @returns {boolean} */
  canGoForward() { return this._navIndex >= 0 && this._navIndex < this._navHistory.length - 1 }

  /** Session ▸ Back（Alt+←）。 @returns {Promise<boolean>} whether it moved */
  async goBack() {
    if (!this.canGoBack()) return false
    this._navIndex--
    await this._restoreNav(this._navHistory[this._navIndex])
    return true
  }

  /** Session ▸ Forward（Alt+→）。 @returns {Promise<boolean>} whether it moved */
  async goForward() {
    if (!this.canGoForward()) return false
    this._navIndex++
    await this._restoreNav(this._navHistory[this._navIndex])
    return true
  }

  /**
   * @param {{ left: FolderSource|null, right: FolderSource|null }} entry
   * @returns {Promise<void>}
   */
  async _restoreNav(entry) {
    this._navRestoring = true
    try {
      await this._setBothSources(entry.left, entry.right)
    } finally {
      this._navRestoring = false
      this._syncNavButtons()
    }
  }

  /**
   * Point both sides at once and scan once.
   *
   * Two `setSource()` calls would scan twice and record two history steps for
   * what the user experienced as one move.
   *
   * @param {FolderSource|null} left
   * @param {FolderSource|null} right
   */
  async _setBothSources(left, right) {
    await this._disconnectRemote('left')
    await this._disconnectRemote('right')

    this._leftSource = left
    this._rightSource = right
    this._leftPath = left?.root ?? null
    this._rightPath = right?.root ?? null
    if (left?.kind !== 'archive') this._leftZipEntries = null
    if (right?.kind !== 'archive') this._rightZipEntries = null

    this._updatePathDisplay('left', this._sourceLabel('left'))
    this._updatePathDisplay('right', this._sourceLabel('right'))
    this._syncModeAvailability()
    this._expanded.clear()
    this._pendingFirstDiff = true
    this._recordNav()
    await this._scan()
  }

  /**
   * Parent folder of one side, or null when there is none to climb to.
   * Only filesystem sides move: an archive, a snapshot and a remote listing
   * each have a root that is the top of what was opened.
   *
   * @param {'left'|'right'} side
   * @returns {FolderSource|null}
   */
  _parentSourceOf(side) {
    const src = this._currentSource(side)
    if (src?.kind !== 'fs') return null
    const parent = parentPath(src.root)
    return parent ? { kind: 'fs', root: parent } : null
  }

  /**
   * The side's source, synthesised from its path when the side was set up
   * before `setSource()` existed (constructor options, session restore).
   * @param {'left'|'right'} side
   * @returns {FolderSource|null}
   */
  _currentSource(side) {
    const src = this._sourceOf(side)
    if (src) return src
    const path = side === 'left' ? this._leftPath : this._rightPath
    return path ? { kind: 'fs', root: path } : null
  }

  /** @returns {boolean} whether either side can move up */
  canGoUp() {
    return !!(this._parentSourceOf('left') || this._parentSourceOf('right'))
  }

  /**
   * Session ▸ Up One Level（Alt+↑）：兩側各往上一層，已在最上層的一側原地不動。
   * @returns {Promise<boolean>} whether it moved
   */
  async upOneLevel() {
    const left = this._parentSourceOf('left')
    const right = this._parentSourceOf('right')
    if (!left && !right) {
      alert('已經在最上層了（封存檔、快照與遠端來源沒有上一層）')
      return false
    }
    // A side already at its top stays where it is rather than being cleared.
    await this._setBothSources(left ?? this._currentSource('left'),
      right ?? this._currentSource('right'))
    return true
  }

  /** Enable/disable the three navigation buttons to match the history. */
  _syncNavButtons() {
    const { btnBack, btnForward, btnUp } = this._dom
    if (btnBack) btnBack.disabled = !this.canGoBack()
    if (btnForward) btnForward.disabled = !this.canGoForward()
    if (btnUp) btnUp.disabled = !this.canGoUp()
  }

  /**
   * Whether a content-reading compare mode can run at all.
   *
   * A snapshot records structure and timestamps, never bytes, so there is
   * nothing for MD5 or the rules diff to read. Leaving those modes selectable
   * means every row fails individually with the same message; taking them off
   * the menu says once, up front, what the snapshot can and cannot answer.
   */
  _contentModesAvailable() {
    return this._leftSource?.kind !== 'snapshot' && this._rightSource?.kind !== 'snapshot'
  }

  /** Reflect `_contentModesAvailable()` in the toolbar, switching mode if needed. */
  _syncModeAvailability() {
    const available = this._contentModesAvailable()
    const select = this._dom.modeSelect
    if (select) {
      for (const opt of select.querySelectorAll('option')) {
        if (opt.value === 'content' || opt.value === 'rules') {
          opt.disabled = !available
          opt.title = available ? '' : '快照未保存檔案內容，無法做內容比對'
        }
      }
    }
    if (!available && (this._mode === 'content' || this._mode === 'rules')) {
      this._mode = 'both'
      if (select) select.value = 'both'
      // Changing the mode out from under the user is only acceptable if they
      // are told; the stats bar is where this view already speaks.
      this._modeNote = '快照未保存檔案內容，已改用「名稱+大小+時間」比對'
    } else if (available) {
      this._modeNote = ''
    }
  }

  /** @param {'left'|'right'} side */
  _sourceOf(side) {
    return side === 'left' ? this._leftSource : this._rightSource
  }

  /** @param {'left'|'right'} side */
  _sourceLabel(side) {
    const src = this._sourceOf(side)
    return src?.label ?? (side === 'left' ? this._leftPath : this._rightPath) ?? ''
  }

  /**
   * Whether a side can be written to. Archives, snapshots and remote hosts are
   * browse-only here, so copy/delete/rename must not be offered for them.
   * @param {'left'|'right'} side
   */
  _isWritableSide(side) {
    return (this._sourceOf(side)?.kind ?? 'fs') === 'fs'
  }

  /**
   * Refuse a file operation that cannot work, and say why.
   *
   * The per-file failure it replaces is the worse outcome: every job fails in
   * the path validator and the user is told "0 succeeded, N failed" with no
   * hint that the pairing was never capable of it.
   *
   * @param {Array<'left'|'right'>} sides sides the operation reads or writes
   * @returns {boolean} whether the operation may proceed
   */
  _requireWritable(sides) {
    for (const side of sides) {
      if (this._isWritableSide(side)) continue
      const kind = this._sourceOf(side)?.kind ?? 'fs'
      const what = { archive: '壓縮檔', snapshot: '快照', remote: '遠端' }[kind] ?? '此來源'
      alert(`${side === 'left' ? '左' : '右'}側是${what}，僅供瀏覽，無法進行檔案操作`)
      return false
    }
    return true
  }

  // ── Deleting ────────────────────────────────────────────────────────────────

  /**
   * Ask before deleting, and let the user pick the recycle bin or permanent.
   *
   * A native `confirm()` cannot carry the choice, and the choice matters:
   * everything here deletes in bulk from a list the user skimmed, so the
   * default has to be the recoverable one and the irreversible one has to be
   * a deliberate act.
   *
   * @param {string[]} labels paths about to be deleted
   * @param {{ permanent?: boolean }} [opts] initial state of the checkbox
   * @returns {Promise<{ ok: boolean, permanent: boolean }>}
   */
  _confirmDelete(labels, opts = {}) {
    const host = this._dom.root ?? document.body
    return new Promise((resolve) => {
      const backdrop = el('div', { className: 'fc-modal-backdrop' })
      const modal = el('div', { className: 'fc-modal', role: 'dialog', 'aria-modal': 'true' })

      modal.appendChild(el('div', { className: 'fc-modal-title' },
        `刪除 ${labels.length} 個項目`))

      const list = el('div', { className: 'fc-modal-list' })
      for (const label of labels.slice(0, 100)) {
        list.appendChild(el('div', { className: 'fc-modal-list-item' }, label))
      }
      if (labels.length > 100) {
        list.appendChild(el('div', { className: 'fc-modal-list-item' },
          `…另有 ${labels.length - 100} 項`))
      }
      modal.appendChild(list)

      const cbPermanent = el('input', { type: 'checkbox', className: 'fc-del-permanent' })
      cbPermanent.checked = !!opts.permanent
      const cbLabel = el('label', { className: 'fc-modal-check' })
      cbLabel.appendChild(cbPermanent)
      cbLabel.appendChild(document.createTextNode(' 永久刪除（不經資源回收桶，無法復原）'))
      modal.appendChild(cbLabel)

      const hint = el('div', { className: 'fc-modal-hint' },
        '預設會移至系統的資源回收桶，之後仍可還原。')
      modal.appendChild(hint)

      const actions = el('div', { className: 'fc-modal-actions' })
      const btnCancel = el('button', { className: 'fc-modal-cancel' }, '取消')
      const btnOk = el('button', { className: 'fc-modal-ok' }, '刪除')
      actions.append(btnCancel, btnOk)
      modal.appendChild(actions)

      backdrop.appendChild(modal)
      host.appendChild(backdrop)

      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        const permanent = cbPermanent.checked
        backdrop.remove()
        document.removeEventListener('keydown', onKey, true)
        resolve({ ok, permanent })
      }
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false) }
        else if (e.key === 'Enter') { e.preventDefault(); finish(true) }
      }

      btnCancel.addEventListener('click', () => finish(false))
      btnOk.addEventListener('click', () => finish(true))
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(false) })
      document.addEventListener('keydown', onKey, true)
      btnOk.focus()
    })
  }

  // ── P2-37: settings scope ───────────────────────────────────────────────────

  /**
   * Beyond Compare's session settings dialog, reduced to the part that was
   * missing: which settings to apply, and how far the choice reaches.
   *
   * "此檢視" leaves the stored defaults alone; "更新為預設值" also writes them,
   * so every comparison opened afterwards starts from the same place.
   *
   * @returns {Promise<'view'|'default'|null>} the scope that was applied
   */
  openSettingsDialog() {
    const host = this._dom.root ?? document.body
    return new Promise((resolve) => {
      const backdrop = el('div', { className: 'fc-modal-backdrop fc-settings-backdrop' })
      const modal = el('div', { className: 'fc-modal', role: 'dialog', 'aria-modal': 'true' })
      modal.appendChild(el('div', { className: 'fc-modal-title' }, '資料夾比對設定'))

      const sourceSelect = el('select', { className: 'fc-settings-source' })
      sourceSelect.appendChild(el('option', { value: '' }, '（目前檢視的設定）'))
      for (const cfg of listFolderConfigs()) {
        sourceSelect.appendChild(el('option', { value: cfg.name }, cfg.name))
      }
      const sourceLabel = el('label', { className: 'fc-modal-field' })
      sourceLabel.appendChild(el('span', {}, '要套用的設定'))
      sourceLabel.appendChild(sourceSelect)
      modal.appendChild(sourceLabel)

      const scopes = el('div', { className: 'fc-settings-scopes' })
      /** @type {HTMLInputElement[]} */
      const radios = []
      for (const [value, text] of [
        ['view', '僅套用至目前這個檢視'],
        ['default', '同時更新為預設值（之後開啟的比對都採用）'],
      ]) {
        const wrap = el('label', { className: 'fc-modal-check' })
        const radio = el('input', { type: 'radio', name: 'fc-settings-scope', value })
        if (value === 'view') radio.checked = true
        radios.push(radio)
        wrap.appendChild(radio)
        wrap.appendChild(document.createTextNode(' ' + text))
        scopes.appendChild(wrap)
      }
      modal.appendChild(scopes)

      modal.appendChild(el('div', { className: 'fc-modal-hint' },
        loadFolderDefaults()
          ? '目前已有儲存的預設值；「清除預設值」會讓新比對回到內建設定。'
          : '目前沒有儲存的預設值，新比對使用內建設定。'))

      const actions = el('div', { className: 'fc-modal-actions' })
      const btnClear = el('button', { className: 'fc-settings-clear' }, '清除預設值')
      const btnCancel = el('button', { className: 'fc-modal-cancel' }, '取消')
      const btnOk = el('button', { className: 'fc-modal-ok' }, '套用')
      actions.append(btnClear, btnCancel, btnOk)
      modal.appendChild(actions)

      backdrop.appendChild(modal)
      host.appendChild(backdrop)
      this._dom.settingsModal = backdrop

      let settled = false
      /** @param {'view'|'default'|null} scope */
      const finish = (scope) => {
        if (settled) return
        settled = true
        backdrop.remove()
        this._dom.settingsModal = null
        document.removeEventListener('keydown', onKey, true)
        resolve(scope)
      }
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(null) }
      }

      btnClear.addEventListener('click', () => {
        this.clearDefaultConfig()
        finish(null)
      })
      btnCancel.addEventListener('click', () => finish(null))
      btnOk.addEventListener('click', () => {
        const scope = radios.find((r) => r.checked)?.value === 'default' ? 'default' : 'view'
        const name = sourceSelect.value
        const cfg = name
          ? _folderConfigStore.get(name)?.settings ?? null
          : this.getConfig()
        if (name && !cfg) {
          alert(`找不到名為「${name}」的設定。`)
          return
        }
        if (!this.applyConfig(cfg, { scope })) {
          alert(`「${name}」不是資料夾比對的設定，未套用。`)
          return
        }
        finish(scope)
      })
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null) })
      document.addEventListener('keydown', onKey, true)
      btnOk.focus()
    })
  }

  // ── P2-26: attribute editing ────────────────────────────────────────────────

  /**
   * Show, and where possible edit, one row's attributes on both sides.
   *
   * Only `readOnly` has an IPC behind it. `hidden` is shown as read-only text —
   * including the "unknown" case the main process reports on Windows — rather
   * than offered as a control that would silently do nothing.
   *
   * @param {CompareRow} row
   * @returns {Promise<void>}
   */
  openAttributesDialog(row) {
    const host = this._dom.root ?? document.body
    return new Promise((resolve) => {
      const backdrop = el('div', { className: 'fc-modal-backdrop fc-attrs-backdrop' })
      const modal = el('div', { className: 'fc-modal', role: 'dialog', 'aria-modal': 'true' })
      modal.appendChild(el('div', { className: 'fc-modal-title' }, `屬性：${row.name}`))

      /** @type {Array<{ side: 'left'|'right', entry: FileEntry, cb: HTMLInputElement }>} */
      const editable = []
      for (const side of ['left', 'right']) {
        const entry = side === 'left' ? row.left : row.right
        if (!entry?.path) continue
        const block = el('div', { className: 'fc-attrs-side' })
        block.appendChild(el('div', { className: 'fc-attrs-path' },
          `${side === 'left' ? '左' : '右'}側：${entry.path}`))

        const writable = this._isWritableSide(side)
        const cb = el('input', { type: 'checkbox', className: `fc-attr-readonly fc-attr-readonly-${side}` })
        cb.checked = !!entry.readOnly
        cb.disabled = !writable
        const cbWrap = el('label', { className: 'fc-modal-check' })
        cbWrap.appendChild(cb)
        cbWrap.appendChild(document.createTextNode(
          writable ? ' 唯讀（R）' : ' 唯讀（R）— 此來源唯讀，無法修改'))
        block.appendChild(cbWrap)
        if (writable) editable.push({ side, entry, cb })

        const hiddenText = entry.hidden === true ? '是'
          : entry.hidden === false ? '否'
            : '未知（此平台無法判讀）'
        block.appendChild(el('div', { className: 'fc-attrs-hidden' },
          `隱藏（H）：${hiddenText} — 不支援修改（沒有對應的 IPC）`))
        modal.appendChild(block)
      }

      const actions = el('div', { className: 'fc-modal-actions' })
      const btnCancel = el('button', { className: 'fc-modal-cancel' }, '取消')
      const btnOk = el('button', { className: 'fc-modal-ok' }, '套用')
      actions.append(btnCancel, btnOk)
      modal.appendChild(actions)

      backdrop.appendChild(modal)
      host.appendChild(backdrop)
      this._dom.attrsModal = backdrop

      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        backdrop.remove()
        this._dom.attrsModal = null
        document.removeEventListener('keydown', onKey, true)
        resolve()
      }
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish() } }

      btnCancel.addEventListener('click', finish)
      btnOk.addEventListener('click', () => {
        const changes = editable
          .filter((f) => f.cb.checked !== !!f.entry.readOnly)
          .map((f) => ({ side: f.side, entry: f.entry, readOnly: f.cb.checked }))
        finish()
        if (changes.length) void this._applyAttributeChanges(changes)
      })
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish() })
      document.addEventListener('keydown', onKey, true)
      btnOk.focus()
    })
  }

  /**
   * @param {Array<{ side: 'left'|'right', entry: FileEntry, readOnly: boolean }>} changes
   * @returns {Promise<void>}
   */
  async _applyAttributeChanges(changes) {
    /** @type {string[]} */
    const failures = []
    for (const change of changes) {
      try {
        const res = await window.electronAPI.setReadOnly(change.entry.path, change.readOnly)
        // Trust what came back rather than what was asked for: the main process
        // reports the flag it actually observes after the write.
        change.entry.readOnly = typeof res?.readOnly === 'boolean' ? res.readOnly : change.readOnly
      } catch (err) {
        console.error('FolderCompare setReadOnly failed:', change.entry.path, err)
        failures.push(`• ${change.entry.path}\n　${errText(err)}`)
      }
    }
    if (failures.length) {
      alert(`${failures.length} 個項目的屬性未能修改：\n\n${failures.join('\n')}`)
    }
    // The criterion reads readOnly, so a change can flip a row's status.
    if (this._compareAttributes && (this._leftPath || this._rightPath)) {
      await this._compareAndRender()
    } else {
      this._applyFilterAndRender()
    }
  }

  /**
   * Delete a list of paths, reporting where each one went.
   *
   * @param {string[]} paths
   * @param {{ permanent: boolean }} opts
   * @returns {Promise<DeleteOutcome>}
   */
  async _deletePaths(paths, opts) {
    /** @type {DeleteOutcome} */
    const outcome = { trashed: 0, permanent: 0, failures: [] }
    for (const path of paths) {
      try {
        // Omitting the options object entirely is the recycle-bin request; the
        // main process refuses rather than silently unlinking when there is no
        // bin, and that refusal is surfaced below instead of being retried.
        const res = await window.electronAPI.deleteFile(
          path, opts.permanent ? { permanent: true } : undefined)
        if (res?.permanent) outcome.permanent++
        else outcome.trashed++
      } catch (err) {
        console.error('FolderCompare delete failed:', path, err)
        outcome.failures.push({ path, message: errText(err) })
      }
    }
    return outcome
  }

  /**
   * Confirm, delete, report — the single path every delete in this view takes.
   *
   * @param {Array<{ path: string, readOnly?: boolean }>} targets
   * @param {{ permanent?: boolean }} [opts]
   * @returns {Promise<boolean>} whether anything was deleted
   */
  async _runDelete(targets, opts = {}) {
    if (!targets.length) { alert('沒有可刪除的項目'); return false }

    const choice = await this._confirmDelete(targets.map((t) => t.path), opts)
    if (!choice.ok) return false

    // Read-only only blocks the permanent route: trashItem moves the file
    // rather than writing to it, so a read-only file lands in the bin fine.
    let list = targets
    if (choice.permanent) {
      const jobs = targets.map((t) => ({ label: t.path, targetReadOnly: !!t.readOnly, target: t }))
      const kept = this._resolveReadOnly(jobs, '永久刪除')
      list = kept.map((j) => j.target)
      if (!list.length) { alert('所有選取的項目都是唯讀，已全部略過'); return false }
    }

    let outcome = await this._deletePaths(list.map((t) => t.path), { permanent: choice.permanent })

    // The main process refuses to fall back on its own. Offering the fallback
    // here — named, counted, and only after the user says so — is the whole
    // point of that refusal.
    if (!choice.permanent && isRecycleBinUnavailable(outcome.failures)) {
      const retry = confirm(
        `${outcome.failures.length} 個項目無法移至資源回收桶：\n` +
        `${outcome.failures[0].message}\n\n改為「永久刪除」這些項目嗎？此操作無法復原。`)
      if (retry) {
        const again = await this._deletePaths(
          outcome.failures.map((f) => f.path), { permanent: true })
        outcome = {
          trashed: outcome.trashed,
          permanent: outcome.permanent + again.permanent,
          failures: again.failures,
        }
      }
    }

    alert(formatDeleteSummary(outcome))
    this._selectedNames.clear()
    await this.refresh()
    return outcome.trashed + outcome.permanent > 0
  }

  /**
   * Delete whatever is checked — or the focused row when nothing is.
   * @param {{ permanent?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  async deleteSelected(opts = {}) {
    const keys = this._selectedNames.size
      ? this._selectedNames
      : new Set(this._focusedKey ? [this._focusedKey] : [])
    if (!keys.size) { alert('請先勾選要刪除的項目'); return false }

    /** @type {Array<{ path: string, readOnly?: boolean }>} */
    const targets = []
    for (const row of flattenRows(this._rows ?? [])) {
      for (const entry of [row.left, row.right]) {
        if (!entry?.path || !keys.has(entry.path)) continue
        const side = entry === row.left ? 'left' : 'right'
        if (!this._isWritableSide(side)) continue
        targets.push({ path: entry.path, readOnly: !!entry.readOnly })
      }
    }
    if (!targets.length) {
      alert('選取的項目都不在可寫入的檔案系統來源上，無法刪除')
      return false
    }
    return this._runDelete(targets, opts)
  }

  // ── Read-only targets ───────────────────────────────────────────────────────

  /**
   * Drop or keep the jobs whose target is read-only, after asking.
   *
   * The old code just ran them: the write failed inside the main process and
   * the user was told "N 項失敗" with nothing naming the cause.
   *
   * @template {{ label: string, targetReadOnly?: boolean }} T
   * @param {T[]} jobs
   * @param {string} action  verb for the prompt, e.g. '覆寫'
   * @returns {T[]} the jobs to actually run
   */
  _resolveReadOnly(jobs, action) {
    const labels = readOnlyLabels(jobs)
    if (!labels.length) return jobs
    const overwrite = confirm(formatReadOnlyPrompt(labels, action))
    return overwrite ? jobs : jobs.filter((j) => !j.targetReadOnly)
  }

  /**
   * List one directory level from whichever store backs the side.
   *
   * @param {'left'|'right'} side
   * @param {string} path
   * @returns {Promise<FileEntry[]>}
   */
  async _listDir(side, path) {
    const src = this._sourceOf(side)
    switch (src?.kind) {
      case 'archive': {
        const all = side === 'left' ? this._leftZipEntries : this._rightZipEntries
        return (all ?? []).filter((e) => e.parentPath === path)
      }
      case 'snapshot': {
        const rel = path === src.root ? '' : parseVirtualPath(path).entry
        return window.electronAPI.readSnapshotDir(src.root, rel)
      }
      case 'remote': {
        const dir = path === src.root ? (src.startDir ?? '') : parseVirtualPath(path).entry
        return window.electronAPI.remoteListDir(src.profileId, dir, src.secret)
      }
      default:
        return window.electronAPI.readDir(path)
    }
  }

  /**
   * Close a side's remote session if it holds one.
   * @param {'left'|'right'} side
   */
  async _disconnectRemote(side) {
    const src = this._sourceOf(side)
    if (src?.kind !== 'remote' || !src.profileId) return
    const other = this._sourceOf(side === 'left' ? 'right' : 'left')
    if (other?.kind === 'remote' && other.profileId === src.profileId) return
    try {
      await window.electronAPI?.remoteDisconnect?.(src.profileId)
    } catch (err) {
      console.error('FolderCompare: remote disconnect failed:', err)
    }
    this._onRemoteClosed?.([src.profileId])
  }

  /**
   * Close every remote session this view opened.
   *
   * Deliberately not two `_disconnectRemote` calls: that helper skips a
   * profile the *other* side is still using, and when both sides share one
   * profile neither call has cleared the other yet, so both skip and the
   * session is never closed. Collecting the profiles first sidesteps the
   * ordering entirely.
   */
  async disconnectAll() {
    const profiles = new Set(
      ['left', 'right']
        .map((side) => this._sourceOf(/** @type {'left'|'right'} */ (side)))
        .filter((src) => src?.kind === 'remote' && src.profileId)
        .map((src) => src.profileId))

    this._leftSource = this._leftSource?.kind === 'remote' ? null : this._leftSource
    this._rightSource = this._rightSource?.kind === 'remote' ? null : this._rightSource

    for (const id of profiles) {
      try {
        await window.electronAPI?.remoteDisconnect?.(id)
      } catch (err) {
        console.error('FolderCompare: remote disconnect failed:', err)
      }
    }
    this._onRemoteClosed?.([...profiles])
  }

  /** 直接設定左側路徑後自動掃描 */
  async setLeft(path) {
    await this.setSource('left', { kind: 'fs', root: path })
  }

  /** 直接設定右側路徑後自動掃描 */
  async setRight(path) {
    await this.setSource('right', { kind: 'fs', root: path })
  }

  /** 重新掃描兩側目錄 */
  async refresh() {
    await this._scan()
  }

  /**
   * 切換同步模式，回傳新狀態，並 emit 'sync-mode-changed'
   * @returns {boolean}
   */
  toggleSyncMode() {
    // Sync copies and deletes on both sides, so it needs both to be real
    // directories. Refusing at the toggle beats building a plan that can only
    // fail file by file once the user presses execute.
    if (!this._syncMode && !this._requireWritable(['left', 'right'])) return false
    this._syncMode = !this._syncMode
    this._emit('sync-mode-changed', { syncMode: this._syncMode })
    // Update toolbar button appearance
    if (this._dom.btnSync) {
      this._dom.btnSync.classList.toggle('fc-btn-sync--active', this._syncMode)
      this._dom.btnSync.title = this._syncMode ? '退出同步模式' : '資料夾同步'
    }
    this._renderSyncPanel()
    return this._syncMode
  }

  /**
   * Compute folder-compare row statistics by status.
   * @returns {{ same: number, different: number, left_only: number, right_only: number, left_newer: number, right_newer: number, total: number }}
   */
  getRowStats() {
    const stats = { same: 0, different: 0, left_only: 0, right_only: 0, left_newer: 0, right_newer: 0, total: 0 }
    // row.status uses hyphens ('left-only'); the stat keys use underscores, so
    // the counters have to be looked up through a normalising step — indexing
    // with the raw status silently counted nothing but same/different.
    for (const row of flattenRows(this._rows ?? [])) {
      const key = String(row?.status ?? '').replace(/-/g, '_')
      if (Object.prototype.hasOwnProperty.call(stats, key) && key !== 'total') {
        stats[key]++
      }
    }
    stats.total = stats.same + stats.different + stats.left_only + stats.right_only + stats.left_newer + stats.right_newer
    return stats
  }

  /**
   * Build the folder-compare HTML report string.
   * @returns {string}
   */
  buildHtmlReport() {
    const esc = (s) => (s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    const statusLabel = {
      same: '相同', different: '不同', left_only: '僅左側',
      right_only: '僅右側', left_newer: '左側較新', right_newer: '右側較新'
    }
    const statusColor = {
      same: '#fff', different: '#fffad7', left_only: '#d7ffd7',
      right_only: '#ffd7d7', left_newer: '#e8f0fe', right_newer: '#ffe8d7'
    }
    const stats = this.getRowStats()
    const timestamp = new Date().toLocaleString('zh-TW')

    const fmtSize = (n) => n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(1)} MB`
    const fmtDate = (s) => s ? new Date(s).toLocaleString('zh-TW') : ''

    const rows = flattenRows(this._rows ?? []).map(row => {
      const key = String(row.status ?? '').replace(/-/g, '_')
      // Rules-graded rows keep the blue "unimportant difference" semantics of
      // the live view instead of reading as plain "相同".
      const bg = row.unimportant ? '#e8f0fe' : (statusColor[key] ?? '#fff')
      const indent = '  '.repeat((row.depth ?? 0))
      const name = indent + esc(row.name ?? '')
      const lSize = fmtSize(row.left?.size)
      const rSize = fmtSize(row.right?.size)
      const lDate = fmtDate(row.left?.mtime)
      const rDate = fmtDate(row.right?.mtime)
      const label = row.unimportant ? '不重要差異' : (statusLabel[key] ?? row.status)
      return `<tr style="background:${bg}">
  <td>${name}</td><td>${label}</td>
  <td>${lSize}</td><td>${lDate}</td>
  <td>${rSize}</td><td>${rDate}</td>
</tr>`
    }).join('\n')

    return `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8">
<title>MyCompare — 資料夾比對報告</title>
<style>
body{font-family:sans-serif;font-size:13px;background:#fff;color:#222;margin:16px}
h2{margin-bottom:4px}
.paths{font-size:12px;color:#666;margin-bottom:12px}
.report-stats{font-size:12px;display:flex;flex-wrap:wrap;gap:10px;padding:8px 12px;
  background:#f5f5f5;border:1px solid #ddd;border-radius:4px;margin-bottom:12px}
.report-stats .stat-diff{color:#996c00;font-weight:600}
.report-stats .stat-leftonly{color:#067d39;font-weight:600}
.report-stats .stat-rightonly{color:#b3261e;font-weight:600}
.report-stats .stat-newer{color:#0052a3;font-weight:600}
.report-stats .ts{margin-left:auto;color:#888}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{padding:3px 8px;border:1px solid #ddd;text-align:left}
th{background:#f5f5f5;font-weight:600}
td:first-child{font-family:monospace;white-space:pre}
@media print{
  body{margin:8mm;font-size:10px}
  .no-print{display:none !important}
  table{page-break-inside:auto;font-size:10px}
  tr{page-break-inside:avoid;page-break-after:auto}
  thead{display:table-header-group}
}
</style>
</head><body>
<h2>資料夾比對報告</h2>
<div class="paths">左：${esc(this._leftPath || '（未知）')} &nbsp;|&nbsp; 右：${esc(this._rightPath || '（未知）')}</div>
<div class="report-stats">
  <div>相同: <span>${stats.same}</span></div>
  <div>不同: <span class="stat-diff">${stats.different}</span></div>
  <div>僅左側: <span class="stat-leftonly">${stats.left_only}</span></div>
  <div>僅右側: <span class="stat-rightonly">${stats.right_only}</span></div>
  <div>左側較新: <span class="stat-newer">${stats.left_newer}</span></div>
  <div>右側較新: <span class="stat-newer">${stats.right_newer}</span></div>
  <div class="ts">生成時間: ${esc(timestamp)}</div>
</div>
<table>
<thead><tr><th>名稱</th><th>狀態</th><th>左 大小</th><th>左 修改時間</th><th>右 大小</th><th>右 修改時間</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body></html>`
  }

  /**
   * Export folder diff as self-contained HTML report.
   * @param {{ print?: boolean }} [opts]
   */
  async exportHtml(opts = {}) {
    if (!this._rows.length) return
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
        await window.electronAPI.saveFile('folder-report.html', html)
      }
      return
    }
    await window.electronAPI.saveFile('folder-report.html', html)
  }

  // ── Private: Sync panel ─────────────────────────────────────────────────────

  /** 在比對視圖上方顯示或移除同步面板 */
  _renderSyncPanel() {
    const root = this._dom.root
    if (!root) return

    const existingPanel = root.querySelector('.sync-panel')
    if (existingPanel) existingPanel.remove()

    if (!this._syncMode) return

    const panel = document.createElement('div')
    panel.className = 'sync-panel'
    panel.innerHTML = `
      <div class="sync-options">
        <label><input type="radio" name="sync-dir" value="left-to-right" checked> 左側 → 右側（鏡像到右側）</label>
        <label><input type="radio" name="sync-dir" value="right-to-left"> 右側 → 左側（鏡像到左側）</label>
        <label><input type="radio" name="sync-dir" value="bidirectional"> 雙向（各取較新版本）</label>
      </div>
      <div class="sync-actions">
        <button class="sync-btn" id="btn-sync-preview">預覽操作</button>
        <button class="sync-btn sync-btn--primary" id="btn-sync-execute" disabled>執行同步</button>
      </div>
    `

    // Insert panel after toolbar (before path-row)
    const toolbar = root.querySelector('.fc-toolbar')
    if (toolbar && toolbar.nextSibling) {
      root.insertBefore(panel, toolbar.nextSibling)
    } else {
      root.insertBefore(panel, root.firstChild)
    }

    // Radio change
    panel.querySelectorAll('input[name="sync-dir"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this._syncDirection = e.target.value
        panel.querySelector('#btn-sync-execute').disabled = true
        this._syncOps = []
        const existing = panel.querySelector('.sync-preview')
        if (existing) existing.remove()
      })
    })

    // Preview button
    panel.querySelector('#btn-sync-preview').addEventListener('click', async () => {
      await this._buildSyncOps()
      panel.querySelector('#btn-sync-execute').disabled = !this._syncOps?.length
      this._renderSyncPreview()
    })

    // Execute button
    panel.querySelector('#btn-sync-execute').addEventListener('click', async () => {
      await this._executeSyncOps()
    })
  }

  /** 根據 _rows 和 syncDirection 建立操作清單 */
  async _buildSyncOps() {
    this._syncOps = []
    // The destination entry is what a copy has to write over, so its read-only
    // flag travels with the op rather than being looked up again at execute
    // time, when the row is no longer at hand.
    const copyOp = (from, to) => ({
      op: 'copy',
      src: from.path,
      dest: this._buildDestPath(from.path, to === 'left' ? 'left' : 'right'),
      label: from.path,
      targetReadOnly: false,
    })

    for (const row of this._rows) {
      if (row.left?.isDirectory || row.right?.isDirectory) continue
      const dir = this._syncDirection
      const status = row.status

      if (dir === 'left-to-right') {
        if (status === 'left-only' || status === 'different' || status === 'left-newer') {
          this._syncOps.push({ ...copyOp(row.left, 'right'), targetReadOnly: !!row.right?.readOnly })
        } else if (status === 'right-only') {
          this._syncOps.push({ op: 'delete', path: row.right.path, label: row.right.path, targetReadOnly: !!row.right.readOnly })
        }
      } else if (dir === 'right-to-left') {
        if (status === 'right-only' || status === 'different' || status === 'right-newer') {
          this._syncOps.push({ ...copyOp(row.right, 'left'), targetReadOnly: !!row.left?.readOnly })
        } else if (status === 'left-only') {
          this._syncOps.push({ op: 'delete', path: row.left.path, label: row.left.path, targetReadOnly: !!row.left.readOnly })
        }
      } else { // bidirectional: 各取較新，孤兒雙向複製
        if (status === 'left-only') {
          this._syncOps.push({ ...copyOp(row.left, 'right'), targetReadOnly: !!row.right?.readOnly })
        } else if (status === 'right-only') {
          this._syncOps.push({ ...copyOp(row.right, 'left'), targetReadOnly: !!row.left?.readOnly })
        } else if (status === 'left-newer') {
          this._syncOps.push({ ...copyOp(row.left, 'right'), targetReadOnly: !!row.right?.readOnly })
        } else if (status === 'right-newer') {
          this._syncOps.push({ ...copyOp(row.right, 'left'), targetReadOnly: !!row.left?.readOnly })
        }
      }
    }
  }

  /**
   * 根據來源路徑和目標側計算目標路徑
   * @param {string} srcPath
   * @param {'left'|'right'} targetSide
   * @returns {string}
   */
  _buildDestPath(srcPath, targetSide) {
    if (targetSide === 'right') {
      const rel = srcPath.slice(this._leftPath.length)
      return this._rightPath + rel
    } else {
      const rel = srcPath.slice(this._rightPath.length)
      return this._leftPath + rel
    }
  }

  /** 在 sync-panel 下方顯示操作清單預覽 */
  _renderSyncPreview() {
    const root = this._dom.root
    const panel = root?.querySelector('.sync-panel')
    if (!panel) return

    const existing = panel.querySelector('.sync-preview')
    if (existing) existing.remove()

    if (!this._syncOps?.length) {
      const msg = document.createElement('div')
      msg.className = 'sync-preview sync-empty'
      msg.textContent = '✓ 無需同步（兩側已一致）'
      panel.appendChild(msg)
      return
    }

    // S13-C07: build with textContent rather than innerHTML so file names
    // that happen to contain HTML metacharacters cannot inject markup.
    const preview = document.createElement('div')
    preview.className = 'sync-preview'
    const opLabels = { copy: '複製', delete: '刪除' }
    const title = document.createElement('div')
    title.className = 'sync-preview-title'
    title.textContent = `待執行操作（共 ${this._syncOps.length} 項）：`
    const list = document.createElement('div')
    list.className = 'sync-preview-list'
    for (const op of this._syncOps) {
      const row = document.createElement('div')
      row.className = `sync-op sync-op--${op.op}`
      const typeEl = document.createElement('span')
      typeEl.className = 'sync-op-type'
      typeEl.textContent = opLabels[op.op] ?? op.op
      const pathEl = document.createElement('span')
      pathEl.className = 'sync-op-path'
      pathEl.textContent = op.label ?? op.src ?? op.path ?? ''
      row.append(typeEl, pathEl)
      list.appendChild(row)
    }
    preview.append(title, list)
    panel.appendChild(preview)
  }

  /** 執行同步操作並顯示摘要 */
  async _executeSyncOps() {
    if (!this._syncOps?.length) return
    // A side can be swapped for a virtual one after sync mode was entered.
    if (!this._requireWritable(['left', 'right'])) return
    const root = this._dom.root
    const panel = root?.querySelector('.sync-panel')
    const execBtn = panel?.querySelector('#btn-sync-execute')
    if (execBtn) execBtn.disabled = true

    // S15-U11: single batch confirm rather than per-file prompt (the old code
    // popped one native confirm() per delete — a 500-file sync was 500 dialogs).
    const deletes = this._syncOps.filter(op => op.op === 'delete')
    /** @type {{ ok: boolean, permanent: boolean }} */
    let deleteChoice = { ok: false, permanent: false }
    if (deletes.length > 0) {
      deleteChoice = await this._confirmDelete(deletes.map((op) => op.path))
    }

    const copies = this._resolveReadOnly(
      this._syncOps.filter((op) => op.op === 'copy'), '覆寫')
    const copyKeep = new Set(copies)

    let done = 0, failed = 0, skipped = 0
    /** @type {DeleteOutcome} */
    const deleteOutcome = { trashed: 0, permanent: 0, failures: [] }
    /** @type {Array<{ path: string, message: string }>} */
    const copyFailures = []

    for (const op of this._syncOps) {
      if (op.op === 'copy') {
        if (!copyKeep.has(op)) { skipped++; continue }
        try {
          await window.electronAPI.copyFile(op.src, op.dest)
          done++
        } catch (e) {
          failed++
          copyFailures.push({ path: op.dest, message: errText(e) })
          console.error('Sync copy failed:', op, e)
        }
        continue
      }
      if (op.op === 'delete') {
        if (!deleteChoice.ok) { skipped++; continue }
        if (deleteChoice.permanent && op.targetReadOnly) { skipped++; continue }
        const one = await this._deletePaths([op.path],
          { permanent: deleteChoice.permanent })
        deleteOutcome.trashed += one.trashed
        deleteOutcome.permanent += one.permanent
        deleteOutcome.failures.push(...one.failures)
        if (one.failures.length) failed++
        else done++
      }
    }

    this._syncOps = []
    const lines = [`同步完成：${done} 項成功`]
    if (failed) lines.push(`${failed} 項失敗`)
    if (skipped) lines.push(`${skipped} 項已略過`)
    const detail = (deleteOutcome.trashed || deleteOutcome.permanent || deleteOutcome.failures.length)
      ? `\n\n刪除：${formatDeleteSummary(deleteOutcome)}`
      : ''
    const copyDetail = copyFailures.length
      ? '\n\n複製失敗：\n' + copyFailures.map((f) => `• ${f.path}\n　${f.message}`).join('\n')
      : ''
    alert(lines.join('，') + detail + copyDetail)
    await this.refresh()
  }

  // ── Private: Batch operations ───────────────────────────────────────────────

  /**
   * 更新批次操作按鈕狀態
   */
  _updateBatchButton() {
    const btnBatch = this._dom.btnBatch
    if (btnBatch) btnBatch.disabled = this._selectedNames.size === 0
  }

  /**
   * 批次複製選取的左側孤兒檔案到右側
   */
  async _batchCopyToRight() {
    if (!this._rightPath) { alert('請先選擇右側資料夾'); return }
    if (!this._requireWritable(['left', 'right'])) return
    const rows = this._rows.filter(
      (r) => r.status === 'left-only' && r.left?.path && this._selectedNames.has(r.left.path)
    )
    if (!rows.length) { alert('沒有可複製的左側孤兒檔案'); return }
    let done = 0, failed = 0
    for (const row of rows) {
      try {
        const relative = row.left.path.slice(this._leftPath.length)
        const dest = this._rightPath + relative
        await window.electronAPI.copyFile(row.left.path, dest)
        done++
      } catch (e) {
        failed++
        console.error('batchCopyToRight failed:', row.left.path, e)
      }
    }
    alert(`批次複製完成：${done} 項成功${failed ? `，${failed} 項失敗` : ''}`)
    this._selectedNames.clear()
    await this.refresh()
  }

  /**
   * 批次複製選取的右側孤兒檔案到左側
   */
  async _batchCopyToLeft() {
    if (!this._leftPath) { alert('請先選擇左側資料夾'); return }
    if (!this._requireWritable(['left', 'right'])) return
    const rows = this._rows.filter(
      (r) => r.status === 'right-only' && r.right?.path && this._selectedNames.has(r.right.path)
    )
    if (!rows.length) { alert('沒有可複製的右側孤兒檔案'); return }
    let done = 0, failed = 0
    for (const row of rows) {
      try {
        const relative = row.right.path.slice(this._rightPath.length)
        const dest = this._leftPath + relative
        await window.electronAPI.copyFile(row.right.path, dest)
        done++
      } catch (e) {
        failed++
        console.error('batchCopyToLeft failed:', row.right.path, e)
      }
    }
    alert(`批次複製完成：${done} 項成功${failed ? `，${failed} 項失敗` : ''}`)
    this._selectedNames.clear()
    await this.refresh()
  }

  /**
   * 批次刪除選取的檔案
   * @param {'left'|'right'} side
   */
  async _batchDelete(side) {
    if (!this._requireWritable([side])) return
    /** @type {Array<{ path: string, readOnly?: boolean }>} */
    const targets = []
    for (const row of this._rows) {
      const entry = side === 'left' ? row.left : row.right
      if (entry?.path && this._selectedNames.has(entry.path)) {
        targets.push({ path: entry.path, readOnly: !!entry.readOnly })
      }
    }
    await this._runDelete(targets)
  }

  // ── Copy across (Ctrl+R / Ctrl+L) ───────────────────────────────────────────

  /**
   * Copy the checked rows — or, with nothing checked, the focused row — to the
   * other side. Unlike the batch menu this is not limited to orphans, matching
   * BC's Ctrl+R / Ctrl+L which overwrite differing files too.
   *
   * @param {'left'|'right'} target
   * @returns {Promise<void>}
   */
  async copySelectedTo(target) {
    const targetBase = target === 'right' ? this._rightPath : this._leftPath
    if (!targetBase) {
      alert(target === 'right' ? '請先選擇右側資料夾' : '請先選擇左側資料夾')
      return
    }
    // Both ends matter: copy-file understands filesystem paths only, so an
    // archive entry as the *source* fails exactly as an unwritable target
    // does. Checking the target alone let every job fail one by one instead.
    if (!this._requireWritable([target, target === 'right' ? 'left' : 'right'])) return

    const keys = this._selectedNames.size
      ? this._selectedNames
      : new Set(this._focusedKey ? [this._focusedKey] : [])
    if (!keys.size) return

    let jobs = []
    for (const row of flattenRows(this._rows ?? [])) {
      const key = row.left?.path || row.right?.path
      if (!key || !keys.has(key)) continue
      const src = target === 'right' ? row.left : row.right
      if (!src?.path || src.isDirectory) continue
      const dst = target === 'right' ? row.right : row.left
      jobs.push({
        src: src.path,
        dest: this._destPathFor(row, target),
        label: dst?.path ?? this._destPathFor(row, target),
        targetReadOnly: !!dst?.readOnly,
      })
    }
    if (!jobs.length) { alert('沒有可複製的項目'); return }
    if (!confirm(`確定要複製 ${jobs.length} 個檔案到${target === 'right' ? '右' : '左'}側？`)) return

    jobs = this._resolveReadOnly(jobs, '覆寫')
    if (!jobs.length) { alert('目標全部是唯讀檔案，已略過'); return }

    let done = 0
    /** @type {Array<{ path: string, message: string }>} */
    const failures = []
    for (const job of jobs) {
      try {
        await window.electronAPI.copyFile(job.src, job.dest)
        done++
      } catch (e) {
        failures.push({ path: job.dest, message: errText(e) })
        console.error('copySelectedTo failed:', job, e)
      }
    }
    const detail = failures.length
      ? '\n\n失敗：\n' + failures.map((f) => `• ${f.path}\n　${f.message}`).join('\n')
      : ''
    alert(`複製完成：${done} 項成功${failures.length ? `，${failures.length} 項失敗` : ''}${detail}`)
    await this.refresh()
  }

  // ── P2-32: Move / Exchange ──────────────────────────────────────────────────

  /**
   * Rows the checkbox selection — or, with nothing checked, the focused row —
   * resolves to.
   *
   * @returns {CompareRow[]}
   */
  _selectedRows() {
    const keys = this._selectedNames.size
      ? this._selectedNames
      : new Set(this._focusedKey ? [this._focusedKey] : [])
    if (!keys.size) return []
    return flattenRows(this._rows ?? []).filter((row) => {
      const key = row.left?.path || row.right?.path
      return !!key && keys.has(key)
    })
  }

  /**
   * Move the selected files to the other side: BC's Move, as opposed to Copy.
   *
   * Every job reports whether the source survived, because a move that copied
   * but could not delete leaves the file in two places and the user is the
   * only one who can decide what to do about it.
   *
   * @param {'left'|'right'} target
   * @returns {Promise<void>}
   */
  async moveSelectedTo(target) {
    return this._moveRows(this._selectedRows(), target)
  }

  /**
   * @param {CompareRow[]} rows
   * @param {'left'|'right'} target
   * @returns {Promise<void>}
   */
  async _moveRows(rows, target) {
    const targetBase = target === 'right' ? this._rightPath : this._leftPath
    if (!targetBase) {
      alert(target === 'right' ? '請先選擇右側資料夾' : '請先選擇左側資料夾')
      return
    }
    const source = target === 'right' ? 'left' : 'right'
    // A move writes to the target *and* deletes from the source, so both ends
    // have to be a real filesystem.
    if (!this._requireWritable([target, source])) return

    let jobs = []
    for (const row of rows ?? []) {
      const src = target === 'right' ? row.left : row.right
      if (!src?.path || src.isDirectory) continue
      const dst = target === 'right' ? row.right : row.left
      const dest = this._destPathFor(row, target)
      jobs.push({
        src: src.path,
        dest,
        label: dst?.path ?? dest,
        targetReadOnly: !!dst?.readOnly,
        sourceReadOnly: !!src.readOnly,
      })
    }
    if (!jobs.length) { alert('沒有可移動的項目（目錄與孤兒的對側不參與移動）'); return }

    const side = target === 'right' ? '右' : '左'
    if (!confirm(`確定要將 ${jobs.length} 個檔案移動到${side}側嗎？\n成功後來源檔案會被刪除（送到資源回收桶）。`)) return

    jobs = this._resolveReadOnly(jobs, '覆寫')
    if (!jobs.length) { alert('目標全部是唯讀檔案，已略過'); return }

    const results = await runMove(
      jobs.map((j) => ({ src: j.src, dest: j.dest })), window.electronAPI)
    alert(formatMoveSummary(results))
    this._selectedNames.clear()
    await this.refresh()
  }

  /**
   * Swap the contents of the selected matched pairs.
   *
   * Confirmed twice on purpose: it is the only operation in this view that
   * overwrites *both* sides, so there is no untouched copy to fall back on if
   * the user misread the selection.
   *
   * @returns {Promise<void>}
   */
  async exchangeSelected() {
    return this._exchangeRows(this._selectedRows())
  }

  /**
   * @param {CompareRow[]} rows
   * @returns {Promise<void>}
   */
  async _exchangeRows(rows) {
    if (!this._requireWritable(['left', 'right'])) return

    let pairs = []
    for (const row of rows ?? []) {
      const { left, right } = row
      if (!left?.path || !right?.path) continue
      if (left.isDirectory || right.isDirectory) continue
      pairs.push({
        left: left.path,
        right: right.path,
        label: `${left.path} ⇄ ${right.path}`,
        targetReadOnly: !!left.readOnly || !!right.readOnly,
      })
    }
    if (!pairs.length) {
      alert('互換需要兩側都存在的檔案；選取的項目中沒有符合的配對')
      return
    }

    const preview = pairs.slice(0, 20).map((p) => `• ${p.left}\n　⇄ ${p.right}`).join('\n')
    const more = pairs.length > 20 ? `\n…另有 ${pairs.length - 20} 組` : ''
    if (!confirm(`互換會同時覆寫兩側的檔案，共 ${pairs.length} 組：\n\n${preview}${more}\n\n要繼續嗎？`)) return
    if (!confirm('再次確認：兩側的內容會互相取代，沒有復原按鈕。確定執行互換？')) return

    pairs = this._resolveReadOnly(pairs, '覆寫')
    if (!pairs.length) { alert('選取的配對都含唯讀檔案，已全部略過'); return }

    /** @type {ExchangeResult[]} */
    const results = []
    // Sequential: each pair leaves a temp file behind while it runs, and a
    // failure has to be attributable to one pair rather than to a batch.
    for (const pair of pairs) {
      results.push(await runExchange(
        { left: pair.left, right: pair.right }, window.electronAPI))
    }
    alert(formatExchangeSummary(results))
    this._selectedNames.clear()
    await this.refresh()
  }

  /**
   * @param {CompareRow} row
   * @param {'left'|'right'} target
   * @returns {string}
   */
  _destPathFor(row, target) {
    const base = target === 'right' ? this._rightPath : this._leftPath
    const rel = this._relativePathOf(row, target === 'right' ? 'left' : 'right')
    const sep = base.includes('\\') ? '\\' : '/'
    return base.replace(/[\\/]+$/, '') + sep + rel.replace(/^[\\/]+/, '')
  }

  /**
   * Remember which row the keyboard shortcuts act on when nothing is checked.
   * @param {string|null} key
   */
  _setFocusedKey(key) {
    this._focusedKey = key ?? null
    const vlist = this._dom.vlist
    if (!vlist) return
    for (const rowEl of vlist.querySelectorAll('.fc-row')) {
      const rowKey = rowEl.dataset.leftPath || rowEl.dataset.rightPath
      rowEl.classList.toggle('fc-row--focused', !!key && rowKey === key)
    }
  }

  // ── T51: Advanced selection ─────────────────────────────────────────────────

  /** 勾選所有 left-newer rows */
  selectNewerLeft() {
    this._selectByStatus(['left-newer'], 'left')
  }

  /** 勾選所有 right-newer rows */
  selectNewerRight() {
    this._selectByStatus(['right-newer'], 'right')
  }

  /** 勾選所有 left-newer 和 right-newer rows */
  selectNewerBoth() {
    this._selectByStatus(['left-newer', 'right-newer'], 'both')
  }

  /** 勾選所有 left-only rows */
  selectOrphansLeft() {
    this._selectByStatus(['left-only'], 'left')
  }

  /** 勾選所有 right-only rows */
  selectOrphansRight() {
    this._selectByStatus(['right-only'], 'right')
  }

  /** 反選目前所有勾選狀態 */
  invertSelection() {
    const newSelected = new Set()
    for (const row of this._rows) {
      const key = row.left?.path || row.right?.path
      if (!key) continue
      if (!this._selectedNames.has(key)) {
        newSelected.add(key)
      }
    }
    this._selectedNames = newSelected
    this._updateBatchButton()
    this._syncCheckboxesFromSelected()
  }

  /**
   * 依 status 批次選取
   * @param {string[]} statuses
   * @param {'left'|'right'|'both'} keySide - 用哪一側路徑作為 key
   */
  _selectByStatus(statuses, keySide) {
    for (const row of this._rows) {
      if (!statuses.includes(row.status)) continue
      let key = null
      if (keySide === 'left') key = row.left?.path || row.right?.path
      else if (keySide === 'right') key = row.right?.path || row.left?.path
      else key = row.left?.path || row.right?.path
      if (key) this._selectedNames.add(key)
    }
    this._updateBatchButton()
    this._syncCheckboxesFromSelected()
  }

  /** 依 _selectedNames 同步所有 row checkbox 的 checked 狀態 */
  _syncCheckboxesFromSelected() {
    if (!this._dom.list) return
    this._dom.list.querySelectorAll('.fc-row').forEach((rowEl) => {
      const key = rowEl.dataset.leftPath || rowEl.dataset.rightPath
      const cb = rowEl.querySelector('.fc-row-cb')
      if (cb && key) cb.checked = this._selectedNames.has(key)
    })
  }

  // ── T56: Expand/Collapse All ─────────────────────────────────────────────────

  /**
   * 遞迴展開整棵樹，實際載入每一層的子項。
   *
   * 舊版只在頂層設旗標而不載入資料，展開後畫面是空的佔位容器。
   * 以 MAX_EXPAND_ALL_DIRS 為上限，避免在超大目錄樹上打爆 IPC。
   */
  async expandAll() {
    const budget = { loaded: 0 }
    const ctrl = this._beginScan()
    // Cancelling has to leave the tree exactly as the user last saw it, so the
    // expansion set is restored wholesale rather than unwound row by row.
    const before = new Set(this._expanded)
    try {
      await this._expandSubtree(this._rows, 0, budget, ctrl.signal)
    } finally {
      if (ctrl.signal.aborted) this._expanded = before
      this._endScan(ctrl)
    }
    if (budget.loaded >= MAX_EXPAND_ALL_DIRS) {
      console.warn(`FolderCompare.expandAll: stopped after ${MAX_EXPAND_ALL_DIRS} directories`)
    }
    this._applyFilterAndRender()
  }

  /** 清空 _expanded，收合所有目錄 */
  collapseAll() {
    this._expanded.clear()
    this._applyFilterAndRender()
  }

  // ── T54: Find bar ────────────────────────────────────────────────────────────

  /**
   * 計算符合 query 的 row 索引清單（純函數，可單元測試）
   * @param {CompareRow[]} rows
   * @param {string} query
   * @returns {number[]} 符合 row 的索引
   */
  _computeFindMatches(rows, query) {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    const matches = []
    rows.forEach((row, i) => {
      const name = (row.name ?? '').toLowerCase()
      if (name.includes(q)) matches.push(i)
    })
    return matches
  }

  /** 開啟 find bar */
  _openFindBar() {
    this._findBarVisible = true
    if (this._dom.findBar) {
      this._dom.findBar.style.display = 'flex'
      this._dom.findInput?.focus()
    }
  }

  /** 關閉 find bar */
  _closeFindBar() {
    this._findBarVisible = false
    this._findQuery = ''
    this._findMatches = []
    this._findCursor = 0
    if (this._dom.findBar) {
      this._dom.findBar.style.display = 'none'
    }
    if (this._dom.findInput) this._dom.findInput.value = ''
    // 移除 highlight
    this._dom.list?.querySelectorAll('.fc-row--match').forEach(r => r.classList.remove('fc-row--match'))
    this._dom.list?.querySelectorAll('.fc-row--match-current').forEach(r => r.classList.remove('fc-row--match-current'))
  }

  /**
   * Matches are indices into the flattened model, not into the rendered rows:
   * virtualisation means a match can be thousands of rows away from anything
   * currently in the DOM.
   */
  _updateFindHighlight() {
    if (!this._dom.list) return
    const q = this._findQuery.trim().toLowerCase()

    if (!this._visibleRows.length) {
      // No model to index — a harness put rows straight into the list element.
      this._findMatches = []
      this._highlightRenderedByName(q)
      return
    }

    this._findMatches = q
      ? computeFindMatches(this._visibleRows.map((f) => f.row), q)
      : []

    if (this._findMatches.length) {
      this._findCursor = Math.min(this._findCursor, this._findMatches.length - 1)
      this._scrollFlatIndexIntoView(this._findMatches[this._findCursor])
    }
    this._applyFindClasses()
    this._setFindStatus(this._findMatches.length)
  }

  /** Paint match classes onto whichever rows are currently rendered. */
  _applyFindClasses() {
    const vlist = this._dom.vlist
    if (!vlist) return
    const matched = new Set(this._findMatches)
    const current = this._findMatches[this._findCursor]
    for (const rowEl of vlist.querySelectorAll('.fc-row')) {
      const idx = Number(rowEl.dataset.flatIndex)
      rowEl.classList.toggle('fc-row--match', matched.has(idx))
      rowEl.classList.toggle('fc-row--match-current', idx === current)
    }
  }

  /**
   * @param {string} q lower-cased query
   */
  _highlightRenderedByName(q) {
    const list = this._dom.list
    if (!list) return
    list.querySelectorAll('.fc-row--match').forEach((r) => r.classList.remove('fc-row--match'))
    list.querySelectorAll('.fc-row--match-current').forEach((r) => r.classList.remove('fc-row--match-current'))
    if (!q) return

    const matchEls = []
    for (const rowEl of list.querySelectorAll('.fc-row')) {
      if ((rowEl.dataset.name ?? '').toLowerCase().includes(q)) {
        rowEl.classList.add('fc-row--match')
        matchEls.push(rowEl)
      }
    }
    if (matchEls.length) {
      this._findCursor = Math.min(this._findCursor, matchEls.length - 1)
      matchEls[this._findCursor]?.classList.add('fc-row--match-current')
      matchEls[this._findCursor]?.scrollIntoView?.({ block: 'nearest' })
    }
    this._setFindStatus(matchEls.length)
  }

  /** @param {number} total */
  _setFindStatus(total) {
    if (!this._dom.findStatus) return
    this._dom.findStatus.textContent = total ? `${this._findCursor + 1} / ${total}` : '無結果'
  }

  /**
   * Bring a flattened-tree index into the viewport, then repaint the window.
   * @param {number} index
   */
  _scrollFlatIndexIntoView(index) {
    const list = this._dom.list
    if (!list) return
    const top = index * ROW_HEIGHT
    const viewHeight = list.clientHeight || FALLBACK_VIEWPORT_HEIGHT
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW_HEIGHT > list.scrollTop + viewHeight) {
      list.scrollTop = top - viewHeight + ROW_HEIGHT
    }
    this._renderWindow()
  }

  /** @returns {number} */
  _findMatchCount() {
    if (this._visibleRows.length) return this._findMatches.length
    return this._dom.list?.querySelectorAll('.fc-row--match').length ?? 0
  }

  /** 跳到下一個 match */
  findNext() {
    if (!this._findQuery.trim()) return
    const count = this._findMatchCount()
    if (!count) return
    this._findCursor = (this._findCursor + 1) % count
    this._updateFindHighlight()
  }

  /** 跳到上一個 match */
  findPrev() {
    if (!this._findQuery.trim()) return
    const count = this._findMatchCount()
    if (!count) return
    this._findCursor = (this._findCursor - 1 + count) % count
    this._updateFindHighlight()
  }

  /** 卸載並清除 DOM、事件 */
  destroy() {
    // Late IPC results must not land on a torn-down view.
    this._scanController?.abort()
    this._scanController = null
    // Closing the tab must close the connection too — otherwise the session
    // survives every comparison the user opens and closes.
    void this.disconnectAll()
    if (this._onDocumentClick) {
      document.removeEventListener('click', this._onDocumentClick)
      this._onDocumentClick = null
    }
    if (this._onDocumentKeydown) {
      document.removeEventListener('keydown', this._onDocumentKeydown)
      this._onDocumentKeydown = null
    }
    if (this._scrollFrame) {
      _caf(this._scrollFrame)
      this._scrollFrame = 0
    }
    if (this._versionTimer) {
      clearTimeout(this._versionTimer)
      this._versionTimer = 0
    }
    this._versionQueue = []
    if (this._container) {
      this._container.innerHTML = ''
      this._container = null
    }
    this._dom.vlist = null
    this._visibleRows = []
    this._handlers = {}
    if (this._injectedStyleEl) {
      this._injectedStyleEl.remove()
      this._injectedStyleEl = null
    }
  }

  /**
   * 訂閱事件
   * @param {'paths-changed'|'open-file-compare'} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = []
    this._handlers[event].push(handler)
    return this
  }

  // ── Private: emit ───────────────────────────────────────────────────────────

  _emit(event, ...args) {
    const handlers = this._handlers[event] ?? []
    for (const h of handlers) {
      try { h(...args) } catch (e) { console.error(`FolderCompare event ${event} handler error:`, e) }
    }
  }

  // ── Private: Initial render ─────────────────────────────────────────────────

  _render() {
    if (!this._container) return
    this._container.innerHTML = ''

    const root = el('div', { className: 'folder-compare' })

    // S15-UX: path row first so the "open folder…" buttons sit at the same
    // visual row across every compare view.
    root.appendChild(this._buildPathRow())

    // Toolbar
    root.appendChild(this._buildToolbar())

    // Include/Exclude mask panel (hidden by default)
    root.appendChild(this._buildFilterPanel())

    // Rules panel (hidden by default)
    root.appendChild(this._buildRulesPanel())

    // T54: Find bar (hidden by default)
    root.appendChild(this._buildFindBar())

    // Column header
    root.appendChild(this._buildHeader())

    // List
    const list = el('div', { className: 'fc-list' })
    this._dom.list = list
    this._dom.vlist = null
    // Coalesce to one window re-render per frame; scroll fires far more often.
    list.addEventListener('scroll', () => {
      if (this._scrollFrame) return
      this._scrollFrame = _raf(() => {
        this._scrollFrame = 0
        this._renderWindow()
      })
    })
    root.appendChild(list)

    // Stats bar
    const stats = el('div', { className: 'fc-stats' })
    this._dom.stats = stats
    root.appendChild(stats)

    this._container.appendChild(root)
    this._dom.root = root

    // Render initial empty state
    this._renderList()
  }

  _buildToolbar() {
    const toolbar = el('div', { className: 'fc-toolbar' })

    // Navigation: Back / Forward / Up One Level. Disabled until there is
    // somewhere to go, so the buttons say what is possible.
    const btnBack = el('button', { className: 'fc-btn-nav', title: '上一頁（Alt+←）' }, '◀')
    const btnForward = el('button', { className: 'fc-btn-nav', title: '下一頁（Alt+→）' }, '▶')
    const btnUp = el('button', { className: 'fc-btn-nav', title: '上一層（Alt+↑）' }, '⬆')
    btnBack.disabled = true
    btnForward.disabled = true
    btnUp.disabled = true
    this._dom.btnBack = btnBack
    this._dom.btnForward = btnForward
    this._dom.btnUp = btnUp
    toolbar.append(btnBack, btnForward, btnUp)

    // Compare mode select
    const modeSelect = el('select', { className: 'fc-compare-mode' })
    ;[
      { value: 'name',    label: '僅名稱' },
      { value: 'size',    label: '名稱+大小' },
      { value: 'mtime',   label: '名稱+修改時間' },
      { value: 'both',    label: '名稱+大小+時間' },
      { value: 'content', label: '內容 (MD5)' },
      { value: 'rules',   label: '內容 (規則)' },
    ].forEach(({ value, label }) => {
      const opt = el('option', { value }, label)
      if (value === this._mode) opt.setAttribute('selected', '')
      modeSelect.appendChild(opt)
    })
    this._dom.modeSelect = modeSelect
    toolbar.appendChild(modeSelect)

    // View preset select — Beyond Compare's View-menu display filters.
    const viewPreset = el('select', { className: 'fc-view-preset', title: '顯示模式' })
    for (const [value, label] of VIEW_PRESET_LABELS) {
      const opt = el('option', { value }, label)
      if (value === this._viewPreset) opt.setAttribute('selected', '')
      viewPreset.appendChild(opt)
    }
    this._dom.viewPreset = viewPreset
    toolbar.appendChild(viewPreset)

    // Checkboxes
    const cbSame = this._buildCheckbox('fc-show-same', '顯示相同', this._showSame)
    this._dom.cbSame = cbSame.querySelector('input')
    toolbar.appendChild(cbSame)

    const cbDiff = this._buildCheckbox('fc-show-diff', '顯示差異', this._showDiff)
    this._dom.cbDiff = cbDiff.querySelector('input')
    toolbar.appendChild(cbDiff)

    const cbOrphan = this._buildCheckbox('fc-show-orphan', '顯示孤兒', this._showOrphan)
    this._dom.cbOrphan = cbOrphan.querySelector('input')
    toolbar.appendChild(cbOrphan)

    // T55: Left Newer / Right Newer toggle buttons
    const btnLeftNewer = el('button', {
      className: 'fc-btn-filter-toggle fc-btn-filter-toggle--active',
      title: '顯示左側較新',
      'data-filter': 'left-newer',
    }, '左較新')
    this._dom.btnLeftNewer = btnLeftNewer
    toolbar.appendChild(btnLeftNewer)

    const btnRightNewer = el('button', {
      className: 'fc-btn-filter-toggle fc-btn-filter-toggle--active',
      title: '顯示右側較新',
      'data-filter': 'right-newer',
    }, '右較新')
    this._dom.btnRightNewer = btnRightNewer
    toolbar.appendChild(btnRightNewer)

    // Quick filter input: one mask string over files and folders alike.
    const filter = el('input', {
      type: 'text',
      className: 'fc-filter',
      placeholder: '快速篩選（如 *.js）',
      title: '同時套用於檔案與資料夾；BC 的四欄遮罩見「⚗ 篩選」',
    })
    filter.value = this._filterStr
    this._dom.filter = filter
    toolbar.appendChild(filter)

    const btnFilter = el('button', {
      className: 'fc-btn-filter',
      title: 'Include / Exclude 檔案與資料夾遮罩',
    }, '⚗ 篩選')
    this._dom.btnFilter = btnFilter
    toolbar.appendChild(btnFilter)

    // Refresh button
    const btnRefresh = el('button', { className: 'fc-btn-refresh' }, '↺ 重新整理')
    this._dom.btnRefresh = btnRefresh
    toolbar.appendChild(btnRefresh)

    // Sync button
    const btnSync = el('button', { className: 'fc-btn-sync', title: '資料夾同步' }, '⇔ 同步')
    this._dom.btnSync = btnSync
    toolbar.appendChild(btnSync)

    // T56: Expand All / Collapse All buttons
    const btnExpandAll = el('button', { className: 'fc-btn-expand-all', title: '展開全部目錄' }, '⊞')
    this._dom.btnExpandAll = btnExpandAll
    toolbar.appendChild(btnExpandAll)

    const btnCollapseAll = el('button', { className: 'fc-btn-collapse-all', title: '收合全部目錄' }, '⊟')
    this._dom.btnCollapseAll = btnCollapseAll
    toolbar.appendChild(btnCollapseAll)

    const btnColumns = el('button', { className: 'fc-btn-columns', title: '選擇顯示欄位' }, '▦ 欄位')
    this._dom.btnColumns = btnColumns
    toolbar.appendChild(btnColumns)

    const btnRules = el('button', { className: 'fc-btn-rules', title: '比對規則（忽略選項）' }, '⚖ 規則')
    this._dom.btnRules = btnRules
    toolbar.appendChild(btnRules)

    const btnSettings = el('button', {
      className: 'fc-btn-settings',
      title: 'Session 設定：套用範圍（僅此檢視／更新為預設值）',
    }, '⚙ 設定')
    this._dom.btnSettings = btnSettings
    toolbar.appendChild(btnSettings)

    // Scan progress + cancel, hidden until a scan is actually running.
    const scanStatus = el('span', { className: 'fc-scan-status' }, '')
    this._dom.scanStatus = scanStatus
    toolbar.appendChild(scanStatus)

    const btnCancel = el('button', {
      className: 'fc-btn-cancel',
      title: '取消掃描',
      style: 'display:none',
    }, '✕ 取消')
    this._dom.btnCancel = btnCancel
    toolbar.appendChild(btnCancel)

    // T51: Advanced selection dropdown
    const selectWrap = el('div', { className: 'fc-select-wrap' })
    const btnSelect = el('button', {
      className: 'fc-btn-select',
      title: '進階選取',
    }, '選取 ▾')
    this._dom.btnSelect = btnSelect

    const selectMenu = el('div', { className: 'fc-select-menu', style: 'display:none' })
    const selectItems = [
      { label: '選取左側較新', action: 'select-newer-left' },
      { label: '選取右側較新', action: 'select-newer-right' },
      { label: '選取兩側較新', action: 'select-newer-both' },
      { label: '選取左側孤兒', action: 'select-orphans-left' },
      { label: '選取右側孤兒', action: 'select-orphans-right' },
      { label: '反選', action: 'invert-selection' },
    ]
    for (const item of selectItems) {
      const btn = el('button', { className: 'fc-select-item', 'data-action': item.action }, item.label)
      selectMenu.appendChild(btn)
    }
    this._dom.selectMenu = selectMenu
    selectWrap.appendChild(btnSelect)
    selectWrap.appendChild(selectMenu)
    toolbar.appendChild(selectWrap)

    // ── Batch selection ───────────────────────────────────────────────────────

    // Select-all checkbox
    const cbSelectAllWrap = el('label', { className: 'fc-cb-select-all-wrap', title: '全選 / 取消全選' })
    const cbSelectAll = el('input', { type: 'checkbox', id: 'fc-cb-select-all' })
    cbSelectAllWrap.appendChild(cbSelectAll)
    cbSelectAllWrap.appendChild(document.createTextNode(' 全選'))
    this._dom.cbSelectAll = cbSelectAll
    toolbar.appendChild(cbSelectAllWrap)

    // Batch button + inline dropdown
    const batchWrap = el('div', { className: 'fc-batch-wrap' })
    const btnBatch = el('button', {
      className: 'fc-btn-batch',
      id: 'fc-btn-batch',
      disabled: 'true',
      title: '批次操作',
    }, '批次操作 ▾')
    btnBatch.disabled = true
    this._dom.btnBatch = btnBatch

    const batchMenu = el('div', { className: 'fc-batch-menu', style: 'display:none' })
    const batchItems = [
      { label: '複製選取到右側（左側孤兒）', action: 'copy-to-right' },
      { label: '複製選取到左側（右側孤兒）', action: 'copy-to-left' },
      { label: '刪除選取（左側）',           action: 'delete-left' },
      { label: '刪除選取（右側）',           action: 'delete-right' },
      { label: '移動選取到右側',             action: 'move-to-right' },
      { label: '移動選取到左側',             action: 'move-to-left' },
      { label: '互換選取（左右對調）',       action: 'exchange' },
    ]
    for (const item of batchItems) {
      const btn = el('button', { className: 'fc-batch-item', 'data-action': item.action }, item.label)
      batchMenu.appendChild(btn)
    }
    this._dom.batchMenu = batchMenu

    batchWrap.appendChild(btnBatch)
    batchWrap.appendChild(batchMenu)
    toolbar.appendChild(batchWrap)

    return toolbar
  }

  /**
   * Beyond Compare's four file-mask fields.
   *
   * Separate fields rather than one string because the two axes are
   * independent: a mask that names files must not decide whether a folder is
   * shown, and "everything except" is not expressible by prefixing `-` when
   * the same box also has to carry the include list.
   *
   * @returns {HTMLElement}
   */
  _buildFilterPanel() {
    const panel = el('div', { className: 'fc-filter-panel', style: 'display:none' })

    /** @type {Array<[keyof FilterFields, string, string]>} */
    const fields = [
      ['includeFiles', '包含檔案', '*.js;*.ts'],
      ['excludeFiles', '排除檔案', '*.tmp;*.log'],
      ['includeFolders', '包含資料夾', 'src;test'],
      ['excludeFolders', '排除資料夾', 'node_modules;.git'],
    ]
    this._dom.filterInputs = {}
    for (const [key, label, placeholder] of fields) {
      const wrap = el('label', { className: 'fc-filter-field' })
      wrap.appendChild(el('span', { className: 'fc-filter-label' }, label))
      const input = el('input', {
        type: 'text',
        className: 'fc-filter-input',
        'data-field': key,
        placeholder,
        title: '遮罩語法：; 分隔、? 與 * 萬用字元、[a-z] 字元集、-mask 排除',
      })
      input.value = this._filterFields[key]
      this._dom.filterInputs[key] = input
      wrap.appendChild(input)
      panel.appendChild(wrap)
    }

    const btnApply = el('button', { className: 'fc-filter-apply' }, '套用')
    const btnClear = el('button', { className: 'fc-filter-clear' }, '清除')
    this._dom.filterApply = btnApply
    this._dom.filterClear = btnClear
    panel.append(btnApply, btnClear)

    this._dom.filterPanel = panel
    return panel
  }

  /**
   * Ignore-rule settings for the `rules` compare mode. Built once and toggled,
   * so the fields keep whatever the user typed between openings.
   * @returns {HTMLElement}
   */
  _buildRulesPanel() {
    const panel = el('div', { className: 'fc-rules-panel', style: 'display:none' })

    /** @type {Array<[string, string]>} */
    const toggles = [
      ['ignoreWhitespace', '忽略空白'],
      ['ignoreCase', '忽略大小寫'],
      ['ignoreLineEndings', '忽略行尾符號'],
      ['ignoreIndent', '忽略縮排'],
    ]
    this._dom.rulesToggles = {}
    for (const [key, label] of toggles) {
      const cb = el('input', { type: 'checkbox', className: 'fc-rules-cb', 'data-rule': key })
      cb.checked = !!this._rulesOptions[key]
      const wrap = el('label', { className: 'fc-rules-toggle' })
      wrap.appendChild(cb)
      wrap.appendChild(document.createTextNode(' ' + label))
      this._dom.rulesToggles[key] = cb
      panel.appendChild(wrap)
    }

    const ignoreInput = el('input', {
      type: 'text',
      className: 'fc-rules-ignore',
      placeholder: '忽略正規表達式（; 分隔）',
      title: '符合的行完全不參與比對',
    })
    ignoreInput.value = this._rulesOptions.ignorePatterns.join(';')
    this._dom.rulesIgnore = ignoreInput
    panel.appendChild(ignoreInput)

    const unimportantInput = el('input', {
      type: 'text',
      className: 'fc-rules-unimportant',
      placeholder: '不重要正規表達式（; 分隔）',
      title: '差異若全落在符合的行上，視為不重要差異',
    })
    unimportantInput.value = this._rulesOptions.unimportantPatterns.join(';')
    this._dom.rulesUnimportant = unimportantInput
    panel.appendChild(unimportantInput)

    const sizeInput = el('input', {
      type: 'number',
      className: 'fc-rules-size',
      min: '1',
      title: `單檔大小上限（KB），上限 ${Math.floor(MAX_RULES_FILE_BYTES / 1024)}`,
    })
    sizeInput.value = String(Math.floor(this._rulesOptions.maxBytes / 1024))
    this._dom.rulesSize = sizeInput
    panel.appendChild(el('label', { className: 'fc-rules-size-label' }, '上限 KB'))
    panel.appendChild(sizeInput)

    // P2-26: an independent criterion rather than a text rule — it applies in
    // every compare mode, not just the content ones, so it is not folded into
    // _rulesOptions.
    const cbAttrs = el('input', { type: 'checkbox', className: 'fc-rules-cb fc-compare-attrs' })
    cbAttrs.checked = this._compareAttributes
    const attrsWrap = el('label', {
      className: 'fc-rules-toggle',
      title: '唯讀/隱藏屬性不同即視為差異；隱藏屬性無法判讀的平台不列入比較',
    })
    attrsWrap.appendChild(cbAttrs)
    attrsWrap.appendChild(document.createTextNode(' 比對屬性'))
    this._dom.cbCompareAttrs = cbAttrs
    panel.appendChild(attrsWrap)

    const btnApply = el('button', { className: 'fc-rules-apply' }, '套用')
    this._dom.rulesApply = btnApply
    panel.appendChild(btnApply)

    this._dom.rulesPanel = panel
    return panel
  }

  /** Push the rule settings back onto the panel controls. */
  _syncRulesControls() {
    const { rulesToggles, rulesIgnore, rulesUnimportant, rulesSize } = this._dom
    for (const [key, cb] of Object.entries(rulesToggles ?? {})) {
      cb.checked = !!this._rulesOptions[key]
    }
    if (rulesIgnore) rulesIgnore.value = this._rulesOptions.ignorePatterns.join(';')
    if (rulesUnimportant) rulesUnimportant.value = this._rulesOptions.unimportantPatterns.join(';')
    if (rulesSize) rulesSize.value = String(Math.floor(this._rulesOptions.maxBytes / 1024))
    this._syncAttributeControl()
  }

  /** Read the panel controls into the rule settings. */
  _readRulesPanel() {
    const { rulesToggles, rulesIgnore, rulesUnimportant, rulesSize } = this._dom
    const split = (value) => String(value ?? '').split(';').map((s) => s.trim()).filter(Boolean)
    /** @type {Partial<RulesOptions>} */
    const next = {
      ignorePatterns: split(rulesIgnore?.value),
      unimportantPatterns: split(rulesUnimportant?.value),
    }
    for (const [key, cb] of Object.entries(rulesToggles ?? {})) next[key] = !!cb.checked
    const kb = Number(rulesSize?.value)
    if (Number.isFinite(kb) && kb > 0) next.maxBytes = Math.round(kb * 1024)

    // One "套用" click has to land both settings, and each of them can trigger
    // its own rescan — so the flag is written first and the rescan is only
    // forced when setRulesOptions did not already do it.
    const attrsBefore = this._compareAttributes
    this._compareAttributes = !!this._dom.cbCompareAttrs?.checked
    this.setRulesOptions(next)
    if (attrsBefore !== this._compareAttributes && this._mode !== 'rules'
        && (this._leftPath || this._rightPath)) {
      void this._compareAndRender()
    }
  }

  /** 顯示 / 隱藏比對規則面板 */
  toggleRulesPanel() {
    const panel = this._dom.rulesPanel
    if (!panel) return
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'
  }

  /** 建立 find bar（T54），由 _render() 呼叫，預設隱藏 */
  _buildFindBar() {
    const bar = el('div', { className: 'fc-find-bar', style: 'display:none' })

    const findInput = el('input', {
      type: 'text',
      className: 'fc-find-input',
      placeholder: '搜尋檔名…',
    })
    this._dom.findInput = findInput
    bar.appendChild(findInput)

    const findStatus = el('span', { className: 'fc-find-status' }, '')
    this._dom.findStatus = findStatus
    bar.appendChild(findStatus)

    const btnFindPrev = el('button', { className: 'fc-find-nav', title: '上一個（Shift+F3）' }, '↑')
    bar.appendChild(btnFindPrev)

    const btnFindNext = el('button', { className: 'fc-find-nav', title: '下一個（F3）' }, '↓')
    bar.appendChild(btnFindNext)

    const btnFindClose = el('button', { className: 'fc-find-close', title: '關閉搜尋（Esc）' }, '✕')
    bar.appendChild(btnFindClose)

    this._dom.findBar = bar

    // Events
    findInput.addEventListener('input', () => {
      this._findQuery = findInput.value
      this._findCursor = 0
      this._updateFindHighlight()
    })

    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'F3' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        this.findNext()
      } else if ((e.key === 'F3' && e.shiftKey) || (e.key === 'Enter' && e.shiftKey)) {
        e.preventDefault()
        this.findPrev()
      } else if (e.key === 'Escape') {
        this._closeFindBar()
      }
    })

    btnFindNext.addEventListener('click', () => this.findNext())
    btnFindPrev.addEventListener('click', () => this.findPrev())
    btnFindClose.addEventListener('click', () => this._closeFindBar())

    return bar
  }

  _buildCheckbox(id, label, checked) {
    const cb = el('input', { type: 'checkbox', id })
    if (checked) cb.setAttribute('checked', '')
    cb.checked = checked
    const lbl = el('label')
    lbl.appendChild(cb)
    lbl.appendChild(document.createTextNode(' ' + label))
    return lbl
  }

  _buildPathRow() {
    const row = el('div', { className: 'fc-path-row' })

    // Left
    const leftCell = el('div', { className: 'fc-path-cell' })
    const btnLeft = el('button', { className: 'fc-open-btn', 'data-side': 'left' }, '開啟資料夾…')
    const btnZipLeft = el('button', { className: 'fc-open-btn', 'data-side': 'left', title: '開啟封存檔作為虛擬資料夾（zip/jar/war/ear/tar/tgz/tbz2/txz/gz/bz2/xz/7z）' },
      '開啟封存檔…')
    const dispLeft = el('span', { className: 'fc-path-display', 'data-side': 'left' },
      this._leftPath ?? '（未選擇）')
    this._dom.btnOpenLeft = btnLeft
    this._dom.btnZipLeft = btnZipLeft
    this._dom.dispLeft = dispLeft
    this._dom.leftCell = leftCell
    leftCell.appendChild(btnLeft)
    leftCell.appendChild(btnZipLeft)
    leftCell.appendChild(dispLeft)

    // Right
    const rightCell = el('div', { className: 'fc-path-cell' })
    const btnRight = el('button', { className: 'fc-open-btn', 'data-side': 'right' }, '開啟資料夾…')
    const btnZipRight = el('button', { className: 'fc-open-btn', 'data-side': 'right', title: '開啟封存檔作為虛擬資料夾（zip/jar/war/ear/tar/tgz/tbz2/txz/gz/bz2/xz/7z）' },
      '開啟封存檔…')
    const dispRight = el('span', { className: 'fc-path-display', 'data-side': 'right' },
      this._rightPath ?? '（未選擇）')
    this._dom.btnOpenRight = btnRight
    this._dom.btnZipRight = btnZipRight
    this._dom.dispRight = dispRight
    this._dom.rightCell = rightCell
    rightCell.appendChild(btnRight)
    rightCell.appendChild(btnZipRight)
    rightCell.appendChild(dispRight)

    row.appendChild(leftCell)
    row.appendChild(rightCell)
    return row
  }

  /** @returns {FolderColumnDef[]} */
  _columnDefs() {
    return FOLDER_COLUMN_DEFS.filter((c) => this._columns.includes(c.id))
  }

  /**
   * Grid tracks for one side. Header cells and row cells share this string so
   * the two stay aligned whatever the column set is.
   * @returns {string}
   */
  _sideTemplate() {
    return this._columnDefs().map((c) => c.width).join(' ')
  }

  _buildHeader() {
    const header = el('div', { className: 'fc-header' })
    const template = this._sideTemplate()

    header.appendChild(el('div', { className: 'fc-col-cb-spacer' }))
    for (const side of ['left', 'right']) {
      if (side === 'right') header.appendChild(el('div', { className: 'fc-col-sep' }))
      const sideEl = el('div', { className: `fc-header-side fc-header-side--${side}` })
      sideEl.style.gridTemplateColumns = template
      for (const def of this._columnDefs()) {
        const sorted = this._sortKey === def.id
        const arrow = sorted ? (this._sortDir > 0 ? ' ▲' : ' ▼') : ''
        sideEl.appendChild(el('div', {
          className: `fc-col fc-col-${def.id}${sorted ? ' fc-col--sorted' : ''}`,
          'data-column': def.id,
          title: `依「${def.label}」排序`,
        }, def.label + arrow))
      }
      header.appendChild(sideEl)
    }

    header.addEventListener('click', (e) => {
      const col = (e.target instanceof Element ? e.target : null)?.closest('[data-column]')
      if (col) this.sortBy(col.dataset.column)
    })
    header.addEventListener('contextmenu', (e) => this._openColumnMenu(e))

    this._dom.header = header
    return header
  }

  /** Swap in a freshly built header after a column or sort change. */
  _rebuildHeader() {
    const old = this._dom.header
    if (!old?.parentElement) return
    old.replaceWith(this._buildHeader())
  }

  /**
   * Column show/hide menu, opened from the header context menu or the toolbar.
   * @param {MouseEvent} e
   */
  _openColumnMenu(e) {
    showContextMenu(e, FOLDER_COLUMN_DEFS.map((def) => ({
      label: `${this._columns.includes(def.id) ? '✓ ' : '　 '}${def.label}`,
      disabled: !!def.locked,
      action: () => this.toggleColumn(def.id),
    })))
  }

  /** Whether focus is in a control that consumes ordinary key presses. */
  _isTypingTarget() {
    const tag = document.activeElement?.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  }

  // ── Private: Event binding ──────────────────────────────────────────────────

  _bindEvents() {
    const { modeSelect, cbSame, cbDiff, cbOrphan, filter, viewPreset,
            btnRefresh, btnSync, btnOpenLeft, btnOpenRight, btnZipLeft, btnZipRight, list,
            cbSelectAll, btnBatch, batchMenu,
            btnLeftNewer, btnRightNewer,
            btnExpandAll, btnCollapseAll,
            btnSelect, selectMenu } = this._dom

    btnOpenLeft.addEventListener('click', () => this.openLeft())
    btnOpenRight.addEventListener('click', () => this.openRight())
    btnZipLeft?.addEventListener('click', () => void this.openArchiveLeft())
    btnZipRight?.addEventListener('click', () => void this.openArchiveRight())

    this._dom.btnBack?.addEventListener('click', () => void this.goBack())
    this._dom.btnForward?.addEventListener('click', () => void this.goForward())
    this._dom.btnUp?.addEventListener('click', () => void this.upOneLevel())

    this._dom.btnFilter?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleFilterPanel()
    })
    this._dom.filterApply?.addEventListener('click', () => this._readFilterPanel())
    this._dom.filterClear?.addEventListener('click', () => this.clearFilters())
    for (const input of Object.values(this._dom.filterInputs ?? {})) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._readFilterPanel() }
      })
    }

    btnSync.addEventListener('click', () => this.toggleSyncMode())

    // T55: Left Newer / Right Newer toggles
    btnLeftNewer?.addEventListener('click', () => {
      this._showLeftNewer = !this._showLeftNewer
      btnLeftNewer.classList.toggle('fc-btn-filter-toggle--active', this._showLeftNewer)
      this._applyFilterAndRender()
    })

    btnRightNewer?.addEventListener('click', () => {
      this._showRightNewer = !this._showRightNewer
      btnRightNewer.classList.toggle('fc-btn-filter-toggle--active', this._showRightNewer)
      this._applyFilterAndRender()
    })

    // Column chooser — stopPropagation so the document click handler that
    // closes the other toolbar menus does not immediately close this one.
    this._dom.btnColumns?.addEventListener('click', (e) => {
      e.stopPropagation()
      this._openColumnMenu(e)
    })

    this._dom.btnRules?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleRulesPanel()
    })
    this._dom.rulesApply?.addEventListener('click', () => this._readRulesPanel())
    this._dom.btnSettings?.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.openSettingsDialog()
    })
    this._dom.btnCancel?.addEventListener('click', () => this.cancelScan())

    // T56: Expand All / Collapse All
    btnExpandAll?.addEventListener('click', () => void this.expandAll())
    btnCollapseAll?.addEventListener('click', () => this.collapseAll())

    // T51: Advanced selection dropdown
    btnSelect?.addEventListener('click', (e) => {
      e.stopPropagation()
      if (selectMenu) {
        const isVisible = selectMenu.style.display !== 'none'
        selectMenu.style.display = isVisible ? 'none' : 'block'
      }
    })

    selectMenu?.addEventListener('click', (e) => {
      const btn = e.target.closest('.fc-select-item')
      if (!btn) return
      if (selectMenu) selectMenu.style.display = 'none'
      const action = btn.dataset.action
      if (action === 'select-newer-left')   this.selectNewerLeft()
      else if (action === 'select-newer-right')  this.selectNewerRight()
      else if (action === 'select-newer-both')   this.selectNewerBoth()
      else if (action === 'select-orphans-left') this.selectOrphansLeft()
      else if (action === 'select-orphans-right')this.selectOrphansRight()
      else if (action === 'invert-selection')    this.invertSelection()
    })

    // ── Batch selection ───────────────────────────────────────────────────────

    // Row checkbox delegation
    list.addEventListener('change', (e) => {
      const cb = e.target.closest('.fc-row-cb')
      if (!cb) return
      const rowEl = cb.closest('.fc-row')
      if (!rowEl) return
      const key = rowEl.dataset.leftPath || rowEl.dataset.rightPath
      if (!key) return
      if (cb.checked) this._selectedNames.add(key)
      else this._selectedNames.delete(key)
      this._updateBatchButton()
    })

    // Select-all checkbox
    cbSelectAll?.addEventListener('change', () => {
      const checked = cbSelectAll.checked
      this._selectedNames.clear()
      if (checked) {
        list.querySelectorAll('.fc-row').forEach((r) => {
          const key = r.dataset.leftPath || r.dataset.rightPath
          if (key) this._selectedNames.add(key)
        })
      }
      list.querySelectorAll('.fc-row-cb').forEach((cb) => { cb.checked = checked })
      this._updateBatchButton()
    })

    // Toggle batch dropdown
    btnBatch?.addEventListener('click', (e) => {
      e.stopPropagation()
      if (batchMenu) {
        const isVisible = batchMenu.style.display !== 'none'
        batchMenu.style.display = isVisible ? 'none' : 'block'
      }
    })

    // Batch menu item clicks
    batchMenu?.addEventListener('click', async (e) => {
      const btn = e.target.closest('.fc-batch-item')
      if (!btn) return
      if (batchMenu) batchMenu.style.display = 'none'
      const action = btn.dataset.action
      if (action === 'copy-to-right') await this._batchCopyToRight()
      else if (action === 'copy-to-left') await this._batchCopyToLeft()
      else if (action === 'delete-left') await this._batchDelete('left')
      else if (action === 'delete-right') await this._batchDelete('right')
      else if (action === 'move-to-right') await this.moveSelectedTo('right')
      else if (action === 'move-to-left') await this.moveSelectedTo('left')
      else if (action === 'exchange') await this.exchangeSelected()
    })

    // S14-M02: store handler refs so destroy() can remove them.
    this._onDocumentClick = () => {
      if (batchMenu) batchMenu.style.display = 'none'
      if (selectMenu) selectMenu.style.display = 'none'
    }
    document.addEventListener('click', this._onDocumentClick)

    modeSelect.addEventListener('change', () => {
      this._mode = modeSelect.value
      this._compareAndRender()
    })

    viewPreset?.addEventListener('change', () => {
      this.setViewPreset(viewPreset.value)
    })

    // The individual toggles below stay usable; flipping one means the shown
    // set no longer matches a named preset.
    cbSame.addEventListener('change', () => {
      this._showSame = cbSame.checked
      this._markPresetCustom()
      this._applyFilterAndRender()
    })
    cbDiff.addEventListener('change', () => {
      this._showDiff = cbDiff.checked
      this._markPresetCustom()
      this._applyFilterAndRender()
    })
    cbOrphan.addEventListener('change', () => {
      this._showOrphan = cbOrphan.checked
      this._markPresetCustom()
      this._applyFilterAndRender()
    })

    filter.addEventListener('input', () => {
      this._filterStr = filter.value
      this._debouncedApplyFilter()
    })

    btnRefresh.addEventListener('click', () => this.refresh())

    // Drag-drop: drop a folder onto left or right path cell
    const addDropZone = (cell, side) => {
      if (!cell) return
      cell.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' })
      cell.addEventListener('drop', async (e) => {
        e.preventDefault()
        const file = e.dataTransfer.files[0]
        if (!file) return
        const filePath = file.path
        if (!filePath) return
        try {
          await window.electronAPI.readDir(filePath)
          if (side === 'left') await this.setLeft(filePath)
          else await this.setRight(filePath)
        } catch { /* not a directory, ignore */ }
      })
    }
    addDropZone(this._dom.leftCell, 'left')
    addDropZone(this._dom.rightCell, 'right')

    // T54: Ctrl+F → open find bar; F3 / Shift+F3 → navigate; Esc → close
    // S14-M02: store handler ref so destroy() can remove it.
    this._onDocumentKeydown = (e) => {
      if (!this._container || !isActive('folder')) return
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault()
        this._openFindBar()
      } else if (e.key === 'F3') {
        e.preventDefault()
        if (!this._findBarVisible) this._openFindBar()
        else if (e.shiftKey) this.findPrev()
        else this.findNext()
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'r' || e.key === 'R')) {
        // Ctrl+R would otherwise reload the renderer.
        e.preventDefault()
        void this.copySelectedTo('right')
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault()
        void this.copySelectedTo('left')
      } else if (e.altKey && !e.ctrlKey && e.key === 'ArrowUp') {
        e.preventDefault()
        void this.upOneLevel()
      } else if (e.altKey && !e.ctrlKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        void this.goBack()
      } else if (e.altKey && !e.ctrlKey && e.key === 'ArrowRight') {
        e.preventDefault()
        void this.goForward()
      } else if (e.key === 'Delete' && !e.ctrlKey && !e.altKey) {
        // Typing in a box, or answering the delete dialog itself, must not be
        // read as a command to delete files.
        if (this._isTypingTarget() || this._dom.root?.querySelector('.fc-modal-backdrop')) return
        e.preventDefault()
        void this.deleteSelected({ permanent: e.shiftKey })
      }
    }
    document.addEventListener('keydown', this._onDocumentKeydown)

    // Row interaction (delegated)
    list.addEventListener('dblclick', (e) => this._onRowDblClick(e))
    list.addEventListener('click', (e) => this._onRowClick(e))
    list.addEventListener('contextmenu', (e) => this._onRowContextMenu(e))
  }

  // ── Private: Scan ───────────────────────────────────────────────────────────

  async _scan() {
    if (!this._leftPath && !this._rightPath) {
      this._rows = []
      this._renderList()
      return
    }

    this._renderLoading()
    const ctrl = this._beginScan()

    try {
      const [leftEntries, rightEntries] = await Promise.all([
        this._leftPath  ? this._listDir('left', this._leftPath)   : Promise.resolve([]),
        this._rightPath ? this._listDir('right', this._rightPath) : Promise.resolve([]),
      ])
      // Entries that arrive after a cancel belong to a comparison the user no
      // longer wants; keeping the previous tree is the consistent outcome.
      if (ctrl.signal.aborted) { this._renderList(); return }
      this._leftEntries = leftEntries
      this._rightEntries = rightEntries
      this._tickProgress(leftEntries.length + rightEntries.length)
      this._expanded.clear()
      await this._compareAndRender(ctrl.signal)
      this._emit('paths-changed', { left: this._leftPath, right: this._rightPath })
    } catch (err) {
      console.error('FolderCompare._scan error:', err)
      this._renderError(err.message)
    } finally {
      this._endScan(ctrl)
    }
  }

  /**
   * 執行比對並更新 this._rows，然後重新渲染
   * @param {AbortSignal} [signal]
   */
  async _compareAndRender(signal) {
    // 清空批次選取狀態
    this._selectedNames.clear()
    this._updateBatchButton()
    if (this._dom.cbSelectAll) this._dom.cbSelectAll.checked = false

    // Re-comparing after a mode or rule change is just as slow as a scan, so it
    // gets its own cancellable generation when the caller has not opened one.
    const owned = signal ? null : this._beginScan()
    const sig = signal ?? owned.signal

    // 先以 'both'（名稱+大小+時間）做初步比對；content / rules 模式再進一步確認
    this._rows = compareEntries(
      this._leftEntries, this._rightEntries, this._baseMode(), this._mtimeTolerance, this._compareOpts())

    try {
      await this._applyDeepCompare(this._rows, sig)
    } finally {
      if (owned) this._endScan(owned)
    }

    this._applyFilterAndRender()
  }

  /** @returns {'name'|'size'|'mtime'|'both'} 內容類模式先以 metadata 粗篩 */
  _baseMode() {
    return (this._mode === 'content' || this._mode === 'rules') ? 'both' : this._mode
  }

  /**
   * 依 mode 執行需要讀檔的第二階段比對。
   * @param {CompareRow[]} rows
   * @param {AbortSignal} [signal]
   */
  async _applyDeepCompare(rows, signal) {
    if (this._mode === 'content' && window.electronAPI?.hashFile) {
      await this._applyContentHash(rows, signal)
    } else if (this._mode === 'rules') {
      await this._applyRulesCompare(rows, signal)
    }
  }

  /**
   * Rules-based grading: text files go through the line diff, everything else
   * (binaries, and anything over the size ceiling) falls back to hashing so a
   * huge file is never pulled into the renderer.
   *
   * @param {CompareRow[]} rows
   * @param {AbortSignal} [signal]
   */
  async _applyRulesCompare(rows = this._rows, signal) {
    const plan = planRulesComparison(rows, this._rulesOptions)
    if (plan.hash.length) await this._applyContentHash(plan.hash, signal)
    if (!plan.text.length || !window.electronAPI?.readFile) return

    await _runWithConcurrency(plan.text, RULES_CONCURRENCY, async (row) => {
      if (signal?.aborted) return
      const [left, right] = await Promise.all([
        window.electronAPI.readFile(row.left.path),
        window.electronAPI.readFile(row.right.path),
      ])
      // The reads outlive a cancel; writing their verdict would resurrect a
      // comparison the user already abandoned.
      if (signal?.aborted) return
      const { status, unimportant } = statusForRulesClass(
        classifyTextPair(left?.content ?? left ?? '', right?.content ?? right ?? '', this._rulesOptions),
      )
      row.status = status
      row.unimportant = unimportant
      this._tickProgress()
    })
  }

  /**
   * 對需要進一步確認的列（size 相同但 mtime 不同，或 'different'）
   * 計算雙側 MD5；若 hash 相同則改為 'same'。
   * @param {CompareRow[]} rows
   * @param {AbortSignal} [signal]
   */
  async _applyContentHash(rows = this._rows, signal) {
    const candidates = rows.filter(row =>
      !row.left?.isDirectory &&
      !row.right?.isDirectory &&
      row.left?.path &&
      row.right?.path &&
      (row.status === 'left-newer' || row.status === 'right-newer' || row.status === 'different')
    )

    // S14-M05: cap concurrent IPC to avoid flooding main when thousands of
    // candidates exist (10k files × 2 hashFile calls = 20k parallel IPCs).
    if (!window.electronAPI?.hashFile) return
    await _runWithConcurrency(candidates, RULES_CONCURRENCY, async (row) => {
      if (signal?.aborted) return
      try {
        const [lHash, rHash] = await Promise.all([
          window.electronAPI.hashFile(row.left.path),
          window.electronAPI.hashFile(row.right.path),
        ])
        if (signal?.aborted) return
        if (lHash && rHash && lHash === rHash) {
          row.status = 'same'
          row.unimportant = false
        }
        this._tickProgress()
      } catch {
        // 無法 hash 則維持原狀態
      }
    })
  }

  // ── Private: Filter ─────────────────────────────────────────────────────────

  _applyFilterAndRender() {
    this._visibleRows = flattenVisibleRows(this._rows, {
      isExpanded: (row, depth) => this._expanded.has(this._expandKey(depth, row)),
      isVisible: (row) => this._isRowVisible(row),
      sort: (rows) => sortRows(rows, this._sortKey, this._sortDir),
    })
    // Click handlers reach the real model object through this index rather than
    // rebuilding a stub from dataset attributes.
    this._rowByKey = new Map()
    for (const flat of this._visibleRows) {
      this._rowByKey.set(this._expandKey(flat.depth, flat.row), flat.row)
    }
    this._renderVirtualList()
    this._renderStats(this._rows)
    // The flattened row set just changed, so any stored index is stale.
    if (this._currentDiffIdx >= this.getDiffIndices().length) this._currentDiffIdx = -1
    this._consumePendingFirstDiff()
  }

  _isRowVisible(row) {
    // A rules-graded row with only unimportant differences sits between the two
    // buckets: it is "same" for counting, but hiding it while the user is
    // hunting for differences would lose the one hint that it changed at all.
    if (row.unimportant) {
      if (!this._showSame && !this._showDiff) return false
    } else if (!statusVisibleUnder(row.status, this._viewFlags)) {
      return false
    }

    // The "顯示差異" master toggle also suppresses the newer-on-one-side
    // statuses, which are differences too.
    if (!this._showDiff && (row.status === 'left-newer' || row.status === 'right-newer')) {
      return false
    }

    const opts = {
      isDirectory: !!(row.left?.isDirectory || row.right?.isDirectory),
      relativePath: this._relativePathOf(row),
    }

    // Quick filter: one mask string over both files and folders.
    if (this._filterStr.trim() && !matchesFilter(row.name, this._filterStr, opts)) {
      return false
    }
    return matchesFolderFilters(row.name, this._filterFields, opts)
  }

  /**
   * Path of a row relative to its base folder, for path-aware masks
   * (`.\src\a.js`, `...\a.js`, `p\f`). Falls back to the bare name when no
   * base path is known.
   *
   * @param {CompareRow} row
   * @param {'left'|'right'} [prefer] which side to measure from, when present
   * @returns {string}
   */
  _relativePathOf(row, prefer = 'left') {
    const first = prefer === 'right' ? row.right : row.left
    const second = prefer === 'right' ? row.left : row.right
    const entry = first ?? second
    const full = entry?.path ?? row.name
    const base = entry === row.left ? this._leftPath : this._rightPath
    if (!base || !full.startsWith(base)) return row.name
    return full.slice(base.length).replace(/^[\\/]+/, '')
  }

  // ── Private: Render ─────────────────────────────────────────────────────────

  _renderLoading() {
    if (!this._dom.list) return
    this._dom.list.innerHTML = ''
    this._dom.list.appendChild(
      el('div', { className: 'fc-loading' }, '⌛ 掃描中…')
    )
  }

  _renderError(msg) {
    if (!this._dom.list) return
    this._dom.list.innerHTML = ''
    this._dom.list.appendChild(
      el('div', { className: 'fc-empty-state' },
        el('span', { className: 'fc-empty-icon' }, '⚠️'),
        el('span', {}, `錯誤：${msg}`)
      )
    )
  }

  _renderList() {
    if (!this._dom.list) return
    if (!this._leftPath && !this._rightPath) {
      this._dom.list.innerHTML = ''
      this._dom.list.appendChild(
        el('div', { className: 'fc-empty-state' },
          el('span', { className: 'fc-empty-icon' }, '📁'),
          el('span', {}, '請選擇左側或右側資料夾')
        )
      )
      return
    }
    this._applyFilterAndRender()
  }

  /**
   * Size the scroll surface to the whole flattened tree, then draw only the
   * rows the viewport can reach.
   */
  _renderVirtualList() {
    const list = this._dom.list
    if (!list) return

    if (!this._visibleRows.length) {
      list.innerHTML = ''
      this._dom.vlist = null
      list.appendChild(
        el('div', { className: 'fc-empty-state' },
          el('span', { className: 'fc-empty-icon' }, '✓'),
          el('span', {}, '沒有符合條件的項目')
        )
      )
      return
    }

    let vlist = this._dom.vlist
    if (!vlist || vlist.parentElement !== list) {
      list.innerHTML = ''
      vlist = el('div', { className: 'fc-vlist' })
      this._dom.vlist = vlist
      list.appendChild(vlist)
    }
    vlist.style.height = `${this._visibleRows.length * ROW_HEIGHT}px`
    this._renderWindow()
  }

  /** Draw the rows inside the current scroll window (plus overscan). */
  _renderWindow() {
    const list = this._dom.list
    const vlist = this._dom.vlist
    if (!list || !vlist) return

    const flat = this._visibleRows
    const viewHeight = list.clientHeight || FALLBACK_VIEWPORT_HEIGHT
    const start = Math.max(0, Math.floor((list.scrollTop || 0) / ROW_HEIGHT) - OVERSCAN)
    const end = Math.min(flat.length - 1, start + Math.ceil(viewHeight / ROW_HEIGHT) + OVERSCAN * 2)

    vlist.innerHTML = ''
    const fragment = document.createDocumentFragment()
    for (let i = start; i <= end; i++) {
      const entry = flat[i]
      if (!entry) continue
      const rowEl = entry.loading
        ? el('div', { className: 'fc-row fc-row--loading' }, '⌛ 載入中…')
        : this._buildRow(entry.row, entry.depth, entry.expanded)
      rowEl.style.top = `${i * ROW_HEIGHT}px`
      rowEl.dataset.flatIndex = String(i)
      fragment.appendChild(rowEl)
    }
    vlist.appendChild(fragment)
    this._applyFindClasses()
    const indices = this.getDiffIndices()
    if (this._currentDiffIdx >= 0 && this._currentDiffIdx < indices.length) {
      this._applyCurrentDiffMark(indices[this._currentDiffIdx])
    }
  }

  /**
   * @param {HTMLElement} rowEl
   * @returns {FlatRow|null}
   */
  _flatEntryOf(rowEl) {
    const idx = Number(rowEl?.dataset?.flatIndex)
    return Number.isInteger(idx) ? (this._visibleRows[idx] ?? null) : null
  }

  /**
   * 讀取某個目錄列的子項並寫進資料模型（含 content-hash 與狀態 rollup）。
   *
   * 之前子項只存在於 DOM，所以報表、統計、目錄狀態全都看不到展開後的內容。
   *
   * @param {CompareRow} row
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async _loadChildren(row, signal) {
    if (row.children) return
    const leftPath = row.left?.isDirectory ? row.left.path : null
    const rightPath = row.right?.isDirectory ? row.right.path : null
    if (!leftPath && !rightPath) {
      row.children = []
      return
    }
    const [leftChildren, rightChildren] = await Promise.all([
      leftPath  ? this._listDir('left', leftPath)   : Promise.resolve([]),
      rightPath ? this._listDir('right', rightPath) : Promise.resolve([]),
    ])
    // Leaving `children` null on cancel keeps the row collapsible and reloadable
    // rather than half-populated.
    if (signal?.aborted) return
    row.children = compareEntries(
      leftChildren, rightChildren, this._baseMode(), this._mtimeTolerance, this._compareOpts())
    this._tickProgress(row.children.length)
    await this._applyDeepCompare(row.children, signal)
    if (signal?.aborted) { row.children = null; return }
    this._refreshRollups()
  }

  /** 由葉往根重算所有已載入目錄的狀態與「不重要差異」標記。 */
  _refreshRollups() {
    for (const row of this._rows ?? []) {
      row.status = rollupStatus(row)
      if (row.children) row.unimportant = row.status === 'same' && rollupUnimportant(row)
    }
  }

  /**
   * 遞迴載入某個子樹的所有層級，並把它們標記為展開。
   * @param {CompareRow[]} rows
   * @param {number} depth
   * @param {{ loaded: number }} budget
   * @param {AbortSignal} [signal]
   */
  async _expandSubtree(rows, depth, budget, signal) {
    for (const row of rows) {
      if (budget.loaded >= MAX_EXPAND_ALL_DIRS) return
      if (signal?.aborted) return
      const isDir = !!(row.left?.isDirectory || row.right?.isDirectory)
      if (!isDir) continue
      this._expanded.add(this._expandKey(depth, row))
      if (!row.children) {
        budget.loaded++
        try {
          await this._loadChildren(row, signal)
        } catch (err) {
          console.error('FolderCompare._expandSubtree error:', err)
          row.children = []
          continue
        }
      }
      // A cancelled load leaves children null; there is nothing to walk into.
      if (!row.children) return
      await this._expandSubtree(row.children, depth + 1, budget, signal)
    }
  }

  _expandKey(depth, row) {
    const lp = row.left?.path ?? ''
    const rp = row.right?.path ?? ''
    return `${depth}:${lp}|${rp}`
  }

  /**
   * @param {CompareRow} row
   * @param {number} [depth]
   * @param {boolean} [expanded]
   */
  _buildRow(row, depth = 0, expanded = undefined) {
    const isDir = !!(row.left?.isDirectory || row.right?.isDirectory)

    const rowEl = el('div', {
      className: `fc-row ${row.status}${isDir ? ' is-dir' : ''}${row.unimportant ? ' fc-row--unimportant' : ''}`,
      'data-name': row.name,
      'data-left-path': row.left?.path ?? '',
      'data-right-path': row.right?.path ?? '',
      'data-status': row.status,
      'data-unimportant': row.unimportant ? 'true' : 'false',
      'data-is-dir': isDir ? 'true' : 'false',
      'data-depth': String(depth),
    })

    // Row checkbox (for batch selection)
    const cb = el('input', {
      type: 'checkbox',
      className: 'fc-row-cb',
      'data-name': row.name,
      'data-left-path': row.left?.path ?? '',
      'data-right-path': row.right?.path ?? '',
    })
    const key = row.left?.path || row.right?.path
    if (key && this._selectedNames.has(key)) cb.checked = true
    if (key && key === this._focusedKey) rowEl.classList.add('fc-row--focused')
    rowEl.appendChild(cb)

    // Left cell
    const isExpanded = expanded ?? (isDir && this._expanded.has(this._expandKey(depth, row)))
    const leftCell = this._buildCell(row.left, row, isDir, depth,
      row.status === 'right-only', 'left', isExpanded)
    // Separator
    const sep = el('div', { className: 'fc-row-sep' })
    // Right cell
    const rightCell = this._buildCell(row.right, row, isDir, depth,
      row.status === 'left-only', 'right', isExpanded)

    rowEl.appendChild(leftCell)
    rowEl.appendChild(sep)
    rowEl.appendChild(rightCell)

    return rowEl
  }

  /**
   * @param {FileEntry|null} entry
   * @param {CompareRow} row
   * @param {boolean} isDir
   * @param {number} depth
   * @param {boolean} isEmpty - 孤兒側（對側沒有此檔案）
   * @param {'left'|'right'} side
   * @param {boolean} [expanded] - 目錄是否已展開（決定 ▶ / ▼）
   */
  _buildCell(entry, row, isDir, depth, isEmpty, side, expanded = false) {
    if (isEmpty || !entry) {
      return el('div', { className: 'fc-cell fc-cell-empty fc-cell-' + side })
    }

    const cell = el('div', { className: `fc-cell fc-cell-${side}` })
    cell.style.gridTemplateColumns = this._sideTemplate()
    for (const def of this._columnDefs()) {
      cell.appendChild(this._buildColumnCell(def, entry, row, isDir, depth, expanded))
    }
    return cell
  }

  /**
   * Tree affordances live inside the name column rather than in a track of
   * their own, so the header keeps a single grid template that lines up
   * whatever the indentation depth is.
   *
   * @param {FolderColumnDef} def
   * @param {FileEntry} entry
   * @param {CompareRow} row
   * @param {boolean} isDir
   * @param {number} depth
   * @param {boolean} expanded
   * @returns {HTMLElement}
   */
  _buildColumnCell(def, entry, row, isDir, depth, expanded) {
    switch (def.id) {
      case 'size':
        return el('span', { className: 'fc-size' }, isDir ? '' : formatSize(entry.size))
      case 'mtime':
        return el('span', { className: 'fc-mtime' }, formatMtime(entry.mtime))
      case 'ext':
        return el('span', { className: 'fc-ext' }, isDir ? '' : extensionOf(entry.name))
      case 'relpath': {
        const rel = this._relativePathOf(row)
        return el('span', { className: 'fc-relpath', title: entry.path ?? rel }, rel)
      }
      case 'attrs':
        return el('span', {
          className: 'fc-attrs',
          title: entryAttrTitle(entry),
        }, entryAttrText(entry))
      case 'version':
        return this._buildVersionCell(entry, isDir)
      default: {
        const nameCell = el('div', { className: 'fc-name-cell' })
        if (depth > 0) {
          const indent = el('span', { className: 'fc-indent' })
          indent.style.width = `${depth * 16}px`
          nameCell.appendChild(indent)
        }
        nameCell.appendChild(el('span', { className: 'fc-toggle' }, isDir ? (expanded ? '▼' : '▶') : ''))
        nameCell.appendChild(el('span', { className: 'fc-icon' }, isDir ? '📁' : '📄'))
        nameCell.appendChild(el('span', { className: 'fc-name' }, entry.name))
        return nameCell
      }
    }
  }

  // ── P2-23: version column ───────────────────────────────────────────────────

  /**
   * A version cell, filled from cache when possible and queued otherwise.
   *
   * Nothing here awaits: the row has to be in the DOM before the scroller's
   * next frame, so the IPC is deferred to {@link _drainVersionQueue} and only
   * the rows that were actually drawn are ever asked about.
   *
   * @param {FileEntry} entry
   * @param {boolean} isDir
   * @returns {HTMLElement}
   */
  _buildVersionCell(entry, isDir) {
    const cell = el('span', { className: 'fc-version' })
    if (isDir || !entry?.path) return cell

    if (entry.version === undefined) {
      const cached = this._versionCache.get(entry.path)
      if (cached !== undefined) entry.version = cached
    }
    if (entry.version !== undefined) {
      cell.textContent = entry.version
      const title = this._versionTitles.get(entry.path)
      if (title) cell.title = title
      return cell
    }

    // Archive, snapshot and remote entries have no path `read-metadata` can
    // open, and formats without a version resource are not worth an IPC each.
    if (sourceKindOf(entry.path) !== 'fs' || !hasVersionCandidateExt(entry.name)) {
      entry.version = ''
      this._versionCache.set(entry.path, '')
      return cell
    }

    cell.classList.add('fc-version--pending')
    cell.textContent = '…'
    cell.dataset.versionPath = entry.path
    this._queueVersion(entry)
    return cell
  }

  /**
   * @param {FileEntry} entry
   */
  _queueVersion(entry) {
    if (this._versionInFlight.has(entry.path)) return
    if (this._versionQueue.some((job) => job.path === entry.path)) return
    this._versionQueue.push({ entry, path: entry.path })
    if (this._versionTimer) return
    // One drain per render pass; scrolling queues a fresh window each frame and
    // firing per row would put a burst of IPC behind every wheel tick.
    this._versionTimer = setTimeout(() => {
      this._versionTimer = 0
      void this._drainVersionQueue()
    }, 0)
  }

  /**
   * Read the queued paths' metadata and patch the cells in place.
   *
   * Patching rather than re-rendering is deliberate: a re-render during a
   * scroll would fight the scroller for the same frame, and the only thing
   * that changed is one span's text.
   *
   * @returns {Promise<void>}
   */
  async _drainVersionQueue() {
    const jobs = this._versionQueue
    this._versionQueue = []
    if (!jobs.length || !window.electronAPI?.readMetadata) {
      // Without the IPC there is no version to show; say so once per row
      // rather than leaving an ellipsis that never resolves.
      for (const job of jobs) this._resolveVersion(job.entry, '', '')
      return
    }
    for (const job of jobs) this._versionInFlight.add(job.path)
    await _runWithConcurrency(jobs, VERSION_CONCURRENCY, async (job) => {
      let text = ''
      let title = ''
      try {
        const meta = await window.electronAPI.readMetadata(job.path)
        text = versionTextFromMetadata(meta)
        title = versionTitleFromMetadata(meta)
      } catch (err) {
        // An unreadable file is not an error worth a dialog — the column is
        // informational — but it must not be retried forever either.
        console.warn('FolderCompare: version lookup failed:', job.path, err)
        text = '—'
        title = `無法讀取版本資訊：${errText(err)}`
      }
      this._versionInFlight.delete(job.path)
      this._resolveVersion(job.entry, text, title)
    })
  }

  /**
   * @param {FileEntry} entry
   * @param {string} text
   * @param {string} title
   */
  _resolveVersion(entry, text, title) {
    entry.version = text
    this._versionCache.set(entry.path, text)
    if (title) this._versionTitles.set(entry.path, title)
    const vlist = this._dom.vlist
    if (!vlist) return
    for (const cell of vlist.querySelectorAll('.fc-version--pending')) {
      if (cell.dataset.versionPath !== entry.path) continue
      cell.classList.remove('fc-version--pending')
      cell.textContent = text
      if (title) cell.title = title
    }
  }

  /**
   * Read versions for the rows currently in the filtered tree, so sorting on
   * the column has something to sort.
   *
   * Bounded by {@link MAX_VERSION_PREFETCH}: the point of the lazy column is
   * that a folder of 50k files never gets 50k IPC calls, and a sort must not
   * be the back door that does it anyway. When the cap bites, the status line
   * says so instead of quietly sorting on a partial answer.
   *
   * @returns {Promise<void>}
   */
  async prefetchVersionsForSort() {
    if (!window.electronAPI?.readMetadata) return
    /** @type {FileEntry[]} */
    const pending = []
    let skipped = 0
    for (const flat of this._visibleRows ?? []) {
      for (const entry of [flat.row.left, flat.row.right]) {
        if (!entry?.path || entry.isDirectory) continue
        if (entry.version !== undefined) continue
        const cached = this._versionCache.get(entry.path)
        if (cached !== undefined) { entry.version = cached; continue }
        if (sourceKindOf(entry.path) !== 'fs' || !hasVersionCandidateExt(entry.name)) {
          entry.version = ''
          this._versionCache.set(entry.path, '')
          continue
        }
        if (pending.length >= MAX_VERSION_PREFETCH) { skipped++; continue }
        pending.push(entry)
      }
    }
    if (!pending.length) {
      if (skipped) this._setScanStatus(`版本排序：超過 ${MAX_VERSION_PREFETCH} 個檔案，其餘未讀取`)
      return
    }

    this._setScanStatus(`讀取版本資訊… 0/${pending.length}`)
    let done = 0
    await _runWithConcurrency(pending, VERSION_CONCURRENCY, async (entry) => {
      let text = ''
      let title = ''
      try {
        const meta = await window.electronAPI.readMetadata(entry.path)
        text = versionTextFromMetadata(meta)
        title = versionTitleFromMetadata(meta)
      } catch (err) {
        console.warn('FolderCompare: version lookup failed:', entry.path, err)
        text = '—'
      }
      this._resolveVersion(entry, text, title)
      done++
      if (done % 25 === 0) this._setScanStatus(`讀取版本資訊… ${done}/${pending.length}`)
    })
    this._setScanStatus(skipped
      ? `版本排序：僅讀取前 ${pending.length} 個檔案，另有 ${skipped} 個未讀取`
      : '')
  }

  _renderStats(rows) {
    if (!this._dom.stats) return
    const stats = this._dom.stats
    stats.innerHTML = ''

    if (this._modeNote) {
      stats.appendChild(el('span', { className: 'fc-stat-item fc-stat-note' }, this._modeNote))
    }
    if (!rows.length) return

    const counts = {}
    let unimportant = 0
    for (const row of rows) {
      counts[row.status] = (counts[row.status] ?? 0) + 1
      if (row.unimportant) unimportant++
    }

    const defs = [
      { key: 'same',        label: '相同' },
      { key: 'left-only',   label: '僅左側' },
      { key: 'right-only',  label: '僅右側' },
      { key: 'different',   label: '不同' },
      { key: 'left-newer',  label: '左較新' },
      { key: 'right-newer', label: '右較新' },
    ]

    for (const { key, label } of defs) {
      const count = counts[key]
      if (!count) continue
      const item = el('span', { className: 'fc-stat-item' })
      item.appendChild(el('span', { className: `fc-stat-dot ${key}` }))
      item.appendChild(document.createTextNode(`${label}: ${count}`))
      stats.appendChild(item)
    }

    if (unimportant) {
      const item = el('span', { className: 'fc-stat-item' })
      item.appendChild(el('span', { className: 'fc-stat-dot unimportant' }))
      item.appendChild(document.createTextNode(`不重要差異: ${unimportant}`))
      stats.appendChild(item)
    }

    const total = rows.length
    const totalEl = el('span', { className: 'fc-stat-item' }, `共 ${total} 項`)
    totalEl.style.marginLeft = 'auto'
    stats.appendChild(totalEl)
  }

  // ── Private: Interaction ────────────────────────────────────────────────────

  _onRowClick(e) {
    const rowEl = e.target.closest('.fc-row')
    if (!rowEl) return
    this._setFocusedKey(rowEl.dataset.leftPath || rowEl.dataset.rightPath || null)

    const isDir = rowEl.dataset.isDir === 'true'
    if (!isDir) return

    const depth = parseInt(rowEl.dataset.depth ?? '0', 10)
    const leftPath = rowEl.dataset.leftPath
    const rightPath = rowEl.dataset.rightPath
    const name = rowEl.dataset.name
    const expandKey = this._expandKey(depth, {
      name,
      left:  leftPath  ? { path: leftPath }  : null,
      right: rightPath ? { path: rightPath } : null,
    })

    if (this._expanded.has(expandKey)) {
      this._collapseDir(expandKey)
    } else {
      void this._expandDir(expandKey)
    }
  }

  _onRowDblClick(e) {
    const rowEl = e.target.closest('.fc-row')
    if (!rowEl) return

    const isDir = rowEl.dataset.isDir === 'true'
    if (isDir) return // 目錄單擊展開，不觸發 open-file-compare

    const leftPath = rowEl.dataset.leftPath || ''
    const rightPath = rowEl.dataset.rightPath || ''
    if (!leftPath && !rightPath) return

    this._emit('open-file-compare', { leftPath, rightPath })
  }

  // ── Private: Context menu ───────────────────────────────────────────────────

  _onRowContextMenu(e) {
    const rowEl = (e.target instanceof Element ? e.target : null)?.closest('.fc-row')
    if (!rowEl) return

    const status   = rowEl.dataset.status
    const isDir    = rowEl.dataset.isDir === 'true'
    const leftPath = rowEl.dataset.leftPath  || ''
    const rightPath= rowEl.dataset.rightPath || ''
    const name     = rowEl.dataset.name      || ''
    // The model row carries the attributes the dataset does not, so the
    // read-only warnings below can be raised before the write is attempted.
    const modelRow = this._flatEntryOf(rowEl)?.row ?? null
    const leftReadOnly = !!modelRow?.left?.readOnly
    const rightReadOnly = !!modelRow?.right?.readOnly

    /**
     * Warn once before overwriting a read-only destination.
     * @param {boolean} readOnly
     * @param {string} label
     */
    const okToOverwrite = (readOnly, label) =>
      !readOnly || confirm(formatReadOnlyPrompt([label], '覆寫'))

    const items = []
    // Only filesystem paths can be handed to Explorer or to the write
    // handlers; a virtual side offers browsing and comparison only.
    const leftIsFs = this._isWritableSide('left')
    const rightIsFs = this._isWritableSide('right')

    // ── 開啟比對（檔案）──
    if (!isDir && leftPath && rightPath &&
        ['same', 'different', 'left-newer', 'right-newer'].includes(status)) {
      items.push({
        label: '開啟比對',
        action: () => this._emit('open-file-compare', { leftPath, rightPath })
      })
      items.push({ separator: true })
    }

    // ── 在檔案總管中顯示 ──
    if (leftPath && leftIsFs) {
      items.push({
        label: isDir ? '在檔案總管中顯示（左側資料夾）' : '在檔案總管中顯示（左側）',
        action: () => window.electronAPI.showInExplorer(leftPath)
      })
    }
    if (rightPath && rightIsFs) {
      items.push({
        label: isDir ? '在檔案總管中顯示（右側資料夾）' : '在檔案總管中顯示（右側）',
        action: () => window.electronAPI.showInExplorer(rightPath)
      })
    }

    // Everything past this point mutates the filesystem.
    if (!leftIsFs || !rightIsFs) {
      if (items.length) showContextMenu(e, items)
      return
    }

    // ── 複製 / 刪除（僅檔案）──
    if (!isDir) {
      if (status === 'different' || status === 'left-newer' || status === 'right-newer') {
        if (leftPath && rightPath) {
          items.push({ separator: true })
          items.push({
            label: '複製左側 → 覆蓋右側',
            action: async () => {
              if (!confirm(`確定要用左側檔案覆蓋右側的「${name}」嗎？`)) return
              if (!okToOverwrite(rightReadOnly, rightPath)) return
              try {
                await window.electronAPI.copyFile(leftPath, rightPath)
                await this.refresh()
              } catch (err) { alert(`複製失敗：${err.message}`) }
            }
          })
          items.push({
            label: '複製右側 → 覆蓋左側',
            action: async () => {
              if (!confirm(`確定要用右側檔案覆蓋左側的「${name}」嗎？`)) return
              if (!okToOverwrite(leftReadOnly, leftPath)) return
              try {
                await window.electronAPI.copyFile(rightPath, leftPath)
                await this.refresh()
              } catch (err) { alert(`複製失敗：${err.message}`) }
            }
          })
        }
      }

      if (status === 'left-only' && this._rightPath) {
        // Compute destination by replacing left base with right base
        const relative = leftPath.slice(this._leftPath.length)
        const dest = this._rightPath + relative
        items.push({ separator: true })
        items.push({
          label: '複製到右側',
          action: async () => {
            try {
              await window.electronAPI.copyFile(leftPath, dest)
              await this.refresh()
            } catch (err) { alert(`複製失敗：${err.message}`) }
          }
        })
        items.push({ separator: true })
        items.push({
          label: `刪除（左側「${name}」）`,
          action: () => this._runDelete([{ path: leftPath, readOnly: leftReadOnly }])
        })
      }

      if (status === 'right-only' && this._leftPath) {
        const relative = rightPath.slice(this._rightPath.length)
        const dest = this._leftPath + relative
        items.push({ separator: true })
        items.push({
          label: '複製到左側',
          action: async () => {
            try {
              await window.electronAPI.copyFile(rightPath, dest)
              await this.refresh()
            } catch (err) { alert(`複製失敗：${err.message}`) }
          }
        })
        items.push({ separator: true })
        items.push({
          label: `刪除（右側「${name}」）`,
          action: () => this._runDelete([{ path: rightPath, readOnly: rightReadOnly }])
        })
      }
    }

    // ── P2-32: 移動 / 互換（僅檔案）──
    if (!isDir && modelRow) {
      const hasLeft = !!modelRow.left?.path && !modelRow.left.isDirectory
      const hasRight = !!modelRow.right?.path && !modelRow.right.isDirectory
      if (hasLeft && this._rightPath) {
        items.push({ separator: true })
        items.push({
          label: '移動到右側（來源會被刪除）',
          action: () => void this._moveRows([modelRow], 'right'),
        })
      }
      if (hasRight && this._leftPath) {
        if (!hasLeft) items.push({ separator: true })
        items.push({
          label: '移動到左側（來源會被刪除）',
          action: () => void this._moveRows([modelRow], 'left'),
        })
      }
      if (hasLeft && hasRight) {
        items.push({
          label: '互換左右（兩側內容對調）',
          action: () => void this._exchangeRows([modelRow]),
        })
      }
    }

    // ── P2-26: 屬性檢視 / 編輯 ──
    if (modelRow && (leftPath || rightPath)) {
      items.push({ separator: true })
      items.push({
        label: '屬性…',
        action: () => void this.openAttributesDialog(modelRow),
      })
    }

    // Algorithm shortcuts for differing files
    if (!isDir && leftPath && rightPath) {
      items.push({ separator: true })
      for (const [algo, label] of [
        ['myers',     'Myers 比對'],
        ['patience',  'Patience 比對'],
        ['histogram', 'Histogram 比對'],
      ]) {
        items.push({
          label,
          action: () => this._emit('open-file-compare', {
            leftPath,
            rightPath,
            algorithm: algo,
          }),
        })
      }
    }

    // T52: Rename
    if (leftPath || rightPath) {
      items.push({ separator: true })
      const renamePath = leftPath || rightPath
      items.push({
        label: '重新命名…',
        action: async () => {
          const newName = prompt(`重新命名「${name}」：`, name)
          if (!newName || newName === name) return
          const dir = renamePath.slice(0, renamePath.length - name.length)
          const newPath = dir + newName
          try {
            await window.electronAPI.renameFile(renamePath, newPath)
            await this.refresh()
          } catch (err) {
            alert(`重新命名失敗：${err.message}`)
          }
        }
      })
    }

    // T53: New Folder
    {
      items.push({
        label: '新建資料夾（左側）…',
        action: async () => {
          if (!this._leftPath) { alert('請先選擇左側資料夾'); return }
          const folderName = prompt('新資料夾名稱：')
          if (!folderName) return
          try {
            await window.electronAPI.mkdirFolder(this._leftPath + '/' + folderName)
            await this.refresh()
          } catch (err) {
            alert(`建立失敗：${err.message}`)
          }
        }
      })
      items.push({
        label: '新建資料夾（右側）…',
        action: async () => {
          if (!this._rightPath) { alert('請先選擇右側資料夾'); return }
          const folderName = prompt('新資料夾名稱：')
          if (!folderName) return
          try {
            await window.electronAPI.mkdirFolder(this._rightPath + '/' + folderName)
            await this.refresh()
          } catch (err) {
            alert(`建立失敗：${err.message}`)
          }
        }
      })
    }

    if (items.length) showContextMenu(e, items)
  }

  // ── Private: Directory expand/collapse ──────────────────────────────────────

  /**
   * 展開某個目錄列：載入子項到模型後重繪。
   * @param {string} expandKey
   */
  async _expandDir(expandKey) {
    const row = this._rowByKey.get(expandKey)
    if (!row) return
    this._expanded.add(expandKey)

    if (row.children) {
      this._rerenderPreservingScroll()
      return
    }

    // 先畫出佔位（_renderRows 會處理 children === null 的情況）
    this._rerenderPreservingScroll()
    const ctrl = this._beginScan()
    try {
      await this._loadChildren(row, ctrl.signal)
    } catch (err) {
      console.error('FolderCompare._expandDir error:', err)
      row.children = []
    } finally {
      // Cancelling mid-load must not leave a directory marked open with a
      // permanent "載入中…" placeholder under it.
      if (ctrl.signal.aborted && !row.children) this._expanded.delete(expandKey)
      this._endScan(ctrl)
    }
    this._rerenderPreservingScroll()
  }

  /**
   * 收合某個目錄列。子項保留在模型中，之後再展開不需重新讀取，
   * 報表與統計也仍看得到。
   * @param {string} expandKey
   */
  _collapseDir(expandKey) {
    this._expanded.delete(expandKey)
    this._rerenderPreservingScroll()
  }

  /** 重繪列表並還原捲動位置，避免展開/收合時畫面跳回頂端。 */
  _rerenderPreservingScroll() {
    const list = this._dom.list
    const top = list?.scrollTop ?? 0
    this._applyFilterAndRender()
    if (list) list.scrollTop = top
  }

  // ── Private: Path display update ────────────────────────────────────────────

  _updatePathDisplay(side, path) {
    const dom = side === 'left' ? this._dom.dispLeft : this._dom.dispRight
    if (dom) dom.textContent = path
  }
}

// ── Exports for unit testing ────────────────────────────────────────────────
export { compareEntries, matchesFilter, computeStatus }

/**
 * 純函數：計算符合 query 的 row 索引清單（供單元測試使用）
 * @param {Array<{name: string}>} rows
 * @param {string} query
 * @returns {number[]}
 */
export function computeFindMatches(rows, query) {
  if (!query.trim()) return []
  const q = query.toLowerCase()
  const matches = []
  rows.forEach((row, i) => {
    const name = (row.name ?? '').toLowerCase()
    if (name.includes(q)) matches.push(i)
  })
  return matches
}
