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
import { SettingsStore } from '../core/settings-store.js'
import '../styles/folder-compare.css'

/** @typedef {import('../core/diff-nav.js').NavResult} NavResult */

/**
 * The Options dialog writes straight to localStorage, so the store is read at
 * every point of use rather than snapshotted into the view: a snapshot would
 * leave an already-open comparison obeying the rules the user just changed.
 *
 * app.js's `applyBcDefaults` only pushes settings that have a real setter on
 * the view; none of the four folder preferences below is view state the user
 * can also change from the toolbar, so there is nothing to push and nothing
 * that could go stale. Reading the store here matches hex-compare.js and
 * core/diff-nav.js.
 *
 * Each preference is read through a literal `getPref('name')` rather than a
 * `folderPref(name)` wrapper: the wrapper reads better but hides the name from
 * a plain text search, and options-bc-pages.test.js searches the sources for
 * exactly that literal to prove no preference is write-only. Indirection here
 * would defeat the check that this whole change exists to satisfy.
 */
const _settings = new SettingsStore()

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

/** Bound on the log panel, which otherwise grows for the life of the tab. */
const MAX_LOG_LINES = 500

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
  // Not a preset: the entry the dropdown shows once the six switches have been
  // combined into something no preset names. BC's View menu is four
  // independent toggles with the presets as shortcuts, not the other way
  // round, so a combination it cannot name must still be displayable.
  ['custom', '自訂組合'],
]

/** The dropdown value standing for "the switches, whatever they say". */
export const CUSTOM_VIEW_PRESET = 'custom'

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

// ── Other Filters (size / date / attributes) ────────────────────────────────
//
// Beyond Compare's second filter tab. Kept separate from the four mask fields
// because these axes are numeric and dated rather than textual, and because
// they must never apply to a folder: excluding a directory by its own size or
// timestamp hides every file underneath it, which is the opposite of what a
// "files smaller than 1 MB" filter is asked to do.

/**
 * @typedef {object} OtherFilters
 * @property {string} minSize      size expression, '' = no bound
 * @property {string} maxSize
 * @property {string} modifiedAfter   YYYY-MM-DD, '' = no bound
 * @property {string} modifiedBefore
 * @property {'any'|'yes'|'no'} readOnly
 * @property {'any'|'yes'|'no'} hidden
 */

/** @type {OtherFilters} */
export const EMPTY_OTHER_FILTERS = {
  minSize: '',
  maxSize: '',
  modifiedAfter: '',
  modifiedBefore: '',
  readOnly: 'any',
  hidden: 'any',
}

/**
 * Bytes named by a size expression such as `10`, `512K`, `4.5M`, `2 GB`.
 *
 * @param {string} raw
 * @returns {number|null} null when the text names no size at all
 */
export function parseSizeInput(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(text)
  if (!m) return null
  const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()]
  const value = Number(m[1]) * scale
  return Number.isFinite(value) ? Math.round(value) : null
}

/**
 * Epoch ms of a `YYYY-MM-DD` box, or null.
 * @param {string} raw
 * @param {boolean} endOfDay treat the date as its last millisecond
 * @returns {number|null}
 */
export function parseDateInput(raw, endOfDay = false) {
  const text = String(raw ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const t = new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * @param {unknown} raw
 * @returns {OtherFilters}
 */
export function normalizeOtherFilters(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {}
  /** @type {OtherFilters} */
  const out = { ...EMPTY_OTHER_FILTERS }
  for (const key of ['minSize', 'maxSize', 'modifiedAfter', 'modifiedBefore']) {
    if (typeof src[key] === 'string') out[key] = src[key]
  }
  for (const key of ['readOnly', 'hidden']) {
    if (src[key] === 'yes' || src[key] === 'no' || src[key] === 'any') out[key] = src[key]
  }
  return out
}

/** @param {OtherFilters} filters @returns {boolean} whether anything is set */
export function otherFiltersActive(filters) {
  const f = normalizeOtherFilters(filters)
  return Object.keys(EMPTY_OTHER_FILTERS).some((key) => f[key] !== EMPTY_OTHER_FILTERS[key])
}

/**
 * Decide whether a row survives the size / date / attribute filters.
 *
 * A row passes when *either* side passes, so a filter never hides half of a
 * matched pair — the pair is the unit the view shows.
 *
 * @param {CompareRow} row
 * @param {OtherFilters} filters
 * @returns {boolean}
 */
export function matchesOtherFilters(row, filters) {
  const f = normalizeOtherFilters(filters)
  if (!otherFiltersActive(f)) return true
  // Directories carry no size or content of their own; filtering on those
  // would hide the files the filter was written to find.
  if (isDirRow(row)) return true

  const min = parseSizeInput(f.minSize)
  const max = parseSizeInput(f.maxSize)
  const after = parseDateInput(f.modifiedAfter, false)
  const before = parseDateInput(f.modifiedBefore, true)

  /** @param {FileEntry|null|undefined} entry */
  const passes = (entry) => {
    if (!entry) return false
    const size = Number(entry.size)
    if (min !== null && !(Number.isFinite(size) && size >= min)) return false
    if (max !== null && !(Number.isFinite(size) && size <= max)) return false
    if (after !== null || before !== null) {
      const t = new Date(entry.mtime).getTime()
      if (!Number.isFinite(t)) return false
      if (after !== null && t < after) return false
      if (before !== null && t > before) return false
    }
    if (f.readOnly !== 'any' && !!entry.readOnly !== (f.readOnly === 'yes')) return false
    // `hidden` is undefined when the listing did not ask for attributes; an
    // unknown value cannot satisfy a yes/no test, so it fails rather than
    // being counted as "not hidden".
    if (f.hidden !== 'any') {
      if (typeof entry.hidden !== 'boolean') return false
      if (entry.hidden !== (f.hidden === 'yes')) return false
    }
    return true
  }

  return passes(row.left) || passes(row.right)
}

// ── Archives as folders ─────────────────────────────────────────────────────

/**
 * @typedef {object} ArchiveOptions
 * @property {boolean} expand          list an archive's entries as child rows
 * @property {string} extensions       mask deciding what counts as an archive
 * @property {boolean} compareContents grade an archive pair by its entry list
 *                                     rather than by the container's own bytes
 */

/** @type {ArchiveOptions} */
export const DEFAULT_ARCHIVE_OPTIONS = {
  expand: false,
  extensions: '*.zip;*.jar;*.war;*.ear;*.7z;*.tar;*.tgz;*.gz;*.bz2;*.xz',
  compareContents: false,
}

/**
 * @param {unknown} raw
 * @returns {ArchiveOptions}
 */
export function normalizeArchiveOptions(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {}
  return {
    expand: typeof src.expand === 'boolean' ? src.expand : DEFAULT_ARCHIVE_OPTIONS.expand,
    extensions: typeof src.extensions === 'string' && src.extensions.trim()
      ? src.extensions
      : DEFAULT_ARCHIVE_OPTIONS.extensions,
    compareContents: typeof src.compareContents === 'boolean'
      ? src.compareContents
      : DEFAULT_ARCHIVE_OPTIONS.compareContents,
  }
}

/**
 * @param {string} name
 * @param {string} extensions mask list, `;` separated
 * @returns {boolean}
 */
export function isArchiveName(name, extensions) {
  if (!name) return false
  return matchesMasks(parseMasks(extensions ?? ''), name, {})
}

/**
 * Grade a pair of archives by what they contain.
 *
 * Two archives built from the same tree at different times differ byte for
 * byte — timestamps and compression order are recorded in the container — so
 * the container's own size and mtime say nothing useful. The entry list does.
 *
 * @param {Array<{ name: string, size?: number, isDirectory?: boolean }>} left
 * @param {Array<{ name: string, size?: number, isDirectory?: boolean }>} right
 * @returns {'same'|'different'}
 */
export function classifyArchivePair(left, right) {
  /** @param {Array<{ name: string, size?: number, isDirectory?: boolean }>} list */
  const key = (list) => (list ?? [])
    .filter((e) => !e.isDirectory)
    .map((e) => `${e.name}\0${Number(e.size) || 0}`)
    .sort()
  const a = key(left)
  const b = key(right)
  if (a.length !== b.length) return 'different'
  return a.every((v, i) => v === b[i]) ? 'same' : 'different'
}

/**
 * Everything that decides a pair's status other than the mode itself.
 *
 * @typedef {object} CompareOpts
 * @property {boolean} [compareAttributes]  read-only/hidden/system/archive differ ⇒ different
 * @property {boolean} [compareFilenameCase] a case-only name difference ⇒ different
 * @property {boolean} [caseInsensitive]    pair `README` with `readme`
 * @property {AlignRule[]} [alignRules]     pair `x.bak.txt` with `x.txt`
 * @property {TimeShift} [timeShift]        forgive whole-hour timestamp shifts
 */

// ── Flat mode (Ignore Folder Structure) ─────────────────────────────────────

/**
 * Pair two flat lists of files by base name, ignoring where they sit.
 *
 * Names repeated within one side are paired in path order and the surplus
 * becomes orphans, so `a/x.js` + `b/x.js` on the left against one `x.js` on
 * the right yields one pair and one left orphan rather than dropping a file.
 *
 * @param {FileEntry[]} leftFiles
 * @param {FileEntry[]} rightFiles
 * @param {'name'|'size'|'mtime'|'both'} mode
 * @param {number} [mtimeTolerance]
 * @param {CompareOpts} [opts]
 * @returns {CompareRow[]}
 */
export function pairFlatEntries(leftFiles, rightFiles, mode, mtimeTolerance = 0, opts = {}) {
  /** @param {FileEntry[]} files */
  const group = (files) => {
    /** @type {Map<string, FileEntry[]>} */
    const map = new Map()
    for (const entry of files ?? []) {
      if (!entry || entry.isDirectory) continue
      const key = pairKeyOf(entry.name, opts)
      const list = map.get(key)
      if (list) list.push(entry)
      else map.set(key, [entry])
    }
    for (const list of map.values()) {
      list.sort((a, b) => String(a.path).localeCompare(String(b.path)))
    }
    return map
  }

  const leftMap = group(leftFiles)
  const rightMap = group(rightFiles)
  const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

  /** @type {CompareRow[]} */
  const rows = []
  for (const key of keys) {
    const lefts = leftMap.get(key) ?? []
    const rights = rightMap.get(key) ?? []
    const count = Math.max(lefts.length, rights.length)
    for (let i = 0; i < count; i++) {
      const left = lefts[i] ?? null
      const right = rights[i] ?? null
      rows.push({
        name: left?.name ?? right?.name ?? key,
        status: computeStatus(left, right, mode, mtimeTolerance, opts),
        left,
        right,
        children: [],
      })
    }
  }
  return rows
}

// ── Folder Sync: Update vs Mirror ───────────────────────────────────────────

/**
 * @typedef {'update'|'mirror'} SyncAction
 *   update — bring the destination up to date; nothing is ever deleted, and a
 *            file that is newer on the destination is left alone
 *   mirror — make the destination identical to the source, which means
 *            overwriting newer destination files and deleting the ones the
 *            source does not have
 */

/**
 * @typedef {object} SyncOp
 * @property {'copy'|'delete'} op
 * @property {string} [src]
 * @property {string} [dest]
 * @property {string} [path]
 * @property {string} label
 * @property {boolean} targetReadOnly
 */

/**
 * Turn compare rows into the copy/delete list a sync would perform.
 *
 * Pure, because the difference between Update and Mirror is exactly a set of
 * delete operations and that difference has to be assertable without touching
 * a filesystem.
 *
 * @param {CompareRow[]} rows
 * @param {object} opts
 * @param {'left-to-right'|'right-to-left'|'bidirectional'} opts.direction
 * @param {SyncAction} opts.action
 * @param {(srcPath: string, targetSide: 'left'|'right') => string} opts.destFor
 * @returns {SyncOp[]}
 */
export function buildSyncOps(rows, opts) {
  const { direction, action, destFor } = opts
  /** @type {SyncOp[]} */
  const ops = []

  /**
   * @param {FileEntry} from
   * @param {'left'|'right'} to
   * @param {FileEntry|null|undefined} target
   */
  const copy = (from, to, target) => ops.push({
    op: 'copy',
    src: from.path,
    dest: destFor(from.path, to),
    label: from.path,
    targetReadOnly: !!target?.readOnly,
  })

  /** @param {FileEntry} entry */
  const del = (entry) => ops.push({
    op: 'delete',
    path: entry.path,
    label: entry.path,
    targetReadOnly: !!entry.readOnly,
  })

  for (const row of rows ?? []) {
    if (row.left?.isDirectory || row.right?.isDirectory) continue
    const status = row.status

    if (direction === 'bidirectional') {
      // Mirroring in both directions is not a thing: each side would have to
      // become the other. Bidirectional is Update only, which is why the UI
      // disables Mirror when this direction is picked.
      if (status === 'left-only' || status === 'left-newer') copy(row.left, 'right', row.right)
      else if (status === 'right-only' || status === 'right-newer') copy(row.right, 'left', row.left)
      continue
    }

    const fromKey = direction === 'left-to-right' ? 'left' : 'right'
    const toKey = direction === 'left-to-right' ? 'right' : 'left'
    const sourceOrphan = `${fromKey}-only`
    const targetOrphan = `${toKey}-only`
    const sourceNewer = `${fromKey}-newer`
    const targetNewer = `${toKey}-newer`

    if (status === sourceOrphan) {
      copy(row[fromKey], toKey, row[toKey])
    } else if (status === sourceNewer || status === 'different') {
      copy(row[fromKey], toKey, row[toKey])
    } else if (status === targetNewer) {
      // Update leaves a newer destination alone; that is the whole difference
      // between "bring up to date" and "make identical".
      if (action === 'mirror') copy(row[fromKey], toKey, row[toKey])
    } else if (status === targetOrphan) {
      if (action === 'mirror') del(row[toKey])
    }
  }
  return ops
}

/**
 * Human label for a direction/action pair, used by the confirmation text so a
 * destructive run never announces itself in the same words as a safe one.
 *
 * @param {'left-to-right'|'right-to-left'|'bidirectional'} direction
 * @param {SyncAction} action
 * @returns {string}
 */
export function syncModeLabel(direction, action) {
  const dir = direction === 'left-to-right' ? '左 → 右'
    : direction === 'right-to-left' ? '右 → 左'
      : '雙向'
  if (direction === 'bidirectional') return `${dir}（更新：各取較新，不刪除）`
  return action === 'mirror'
    ? `${dir}（鏡像：目的地會變得與來源完全一致，多餘的檔案會被刪除）`
    : `${dir}（更新：只覆寫較舊的檔案，不刪除任何東西）`
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
  { id: 'created', label: '建立時間', width: '140px' },
  { id: 'ext',     label: '副檔名',   width: '72px' },
  { id: 'relpath', label: '相對路徑', width: '160px' },
  { id: 'abspath', label: '完整路徑', width: '220px' },
  { id: 'attrs',   label: '屬性',     width: '72px' },
  { id: 'version', label: '版本',     width: '120px' },
  { id: 'crc',     label: '檢查碼',   width: '120px' },
  { id: 'vcs',     label: '版本控制', width: '96px' },
  { id: 'owner',   label: '擁有者',   width: '150px' },
  { id: 'group',   label: '群組',     width: '130px' },
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
  // `container` is set only on archive rows that the archive options asked to
  // expand; without it the flag is absent and the check is the original one.
  return !!(row?.left?.isDirectory || row?.right?.isDirectory || row?.container)
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
 * @property {boolean|null} [system]    Windows system bit, same caveat as hidden
 * @property {boolean|null} [archive]   Windows archive bit, same caveat as hidden
 * @property {string} [version]         filled in lazily by the version column
 * @property {string} [crc]             filled in lazily by the checksum column
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
    // S and A come out of the same Windows attribute word as H, so they are
    // shown only where the source actually reported them; the single trailing
    // `?` below already says the word could not be read at all.
    (entry.system === true ? 'S' : '') +
    (entry.archive === true ? 'A' : '') +
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
  if (entry.system === true) parts.push('S＝系統')
  else if (entry.system === false) parts.push('非系統')
  if (entry.archive === true) parts.push('A＝封存')
  else if (entry.archive === false) parts.push('非封存')
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
  for (const key of ['hidden', 'system', 'archive']) {
    if (typeof left[key] === 'boolean' && typeof right[key] === 'boolean'
        && left[key] !== right[key]) return true
  }
  return false
}

// ── Timestamp shift tolerance (timezone / DST) ──────────────────────────────
//
// Copying between filesystems does not only round timestamps, it shifts them.
// FAT stores local time with no zone, so the same file read on either side of a
// DST boundary is an hour out; an archive or a remote host can be a whole
// timezone out. Both look like "right is newer by exactly 3600s", which is why
// the plain ±n-second tolerance cannot express them — widening it to an hour
// would also swallow a real edit made 50 minutes ago.

/** @typedef {'none'|'dst'|'timezone'} TimeShift */

/** Seconds in one hour, the unit both shifts come in. */
const HOUR_SECONDS = 3600
/**
 * Widest shift `timezone` mode forgives, in hours. UTC-12 … UTC+14 is the real
 * range of civil offsets, so a pair more than 26 hours apart is not a zone
 * problem whatever else it is.
 */
const MAX_TIMEZONE_HOURS = 26

/**
 * @param {unknown} raw
 * @returns {TimeShift}
 */
export function normalizeTimeShift(raw) {
  return raw === 'dst' || raw === 'timezone' ? raw : 'none'
}

/**
 * Whether two timestamps count as the same instant.
 *
 * @param {number} lTime ms since epoch
 * @param {number} rTime ms since epoch
 * @param {number} [toleranceSec] the ordinary ±n-second window
 * @param {TimeShift} [shift]
 * @returns {boolean}
 */
export function timestampsMatch(lTime, rTime, toleranceSec = 0, shift = 'none') {
  // A source that reports no usable timestamp (some archive and remote
  // listings) must not therefore have every file marked newer on one side —
  // "unknown" is not evidence of a difference. This is the behaviour the plain
  // `Math.abs(NaN - x) > tol` comparison had before the shift modes existed.
  if (!Number.isFinite(lTime) || !Number.isFinite(rTime)) return true
  const diff = Math.abs(lTime - rTime) / 1000
  const tol = Math.max(0, toleranceSec)
  if (diff <= tol) return true
  if (shift === 'none') return false

  // Only whole-hour shifts are forgiven. Half-hour zones exist (UTC+05:30) but
  // forgiving 30-minute offsets would also forgive a half-hour-old edit, and a
  // half-hour zone difference still lands on a whole hour when both sides sit
  // in one — which is the case this option is for.
  const maxHours = shift === 'dst' ? 1 : MAX_TIMEZONE_HOURS
  for (let h = 1; h <= maxHours; h++) {
    if (Math.abs(diff - h * HOUR_SECONDS) <= tol) return true
  }
  return false
}

// ── Filename case and filename alignment ────────────────────────────────────

/** @typedef {'system'|'sensitive'|'insensitive'} FilenameCase */

/**
 * @param {unknown} raw
 * @returns {FilenameCase}
 */
export function normalizeFilenameCase(raw) {
  return raw === 'sensitive' || raw === 'insensitive' ? raw : 'system'
}

/**
 * Resolve `system` against a platform string.
 *
 * Taking the platform as an argument rather than reading `navigator` keeps the
 * decision testable on either kind of host, and the whole point of the setting
 * is that the user can disagree with the platform default.
 *
 * @param {FilenameCase} mode
 * @param {string} [platform] as in `navigator.platform`
 * @returns {boolean} whether names pair case-insensitively
 */
export function filenamesAreCaseInsensitive(mode, platform = '') {
  if (mode === 'sensitive') return false
  if (mode === 'insensitive') return true
  return /^(win|mac)/i.test(String(platform ?? ''))
}

/**
 * @typedef {object} AlignRule
 * @property {string} from  mask with exactly one `*`
 * @property {string} to    mask with exactly one `*`
 */

/**
 * Parse Beyond Compare-style filename alignment rules.
 *
 * One rule per `;`-separated entry, written `from=to`, each side a mask with
 * exactly one `*` — `*.bak.txt=*.txt` aligns `report.bak.txt` with
 * `report.txt`. Malformed entries are returned separately rather than dropped,
 * because a typo that silently stops aligning anything is indistinguishable
 * from the feature not working.
 *
 * @param {unknown} raw
 * @returns {{ rules: AlignRule[], errors: string[] }}
 */
export function parseAlignRules(raw) {
  /** @type {AlignRule[]} */
  const rules = []
  /** @type {string[]} */
  const errors = []
  for (const piece of String(raw ?? '').split(';')) {
    const text = piece.trim()
    if (!text) continue
    const eq = text.indexOf('=')
    if (eq <= 0 || eq === text.length - 1) {
      errors.push(`「${text}」不是 from=to 格式`)
      continue
    }
    const from = text.slice(0, eq).trim()
    const to = text.slice(eq + 1).trim()
    const stars = (s) => (s.match(/\*/g) ?? []).length
    if (stars(from) !== 1 || stars(to) !== 1) {
      errors.push(`「${text}」兩側都必須剛好有一個 *`)
      continue
    }
    rules.push({ from, to })
  }
  return { rules, errors }
}

/**
 * Rewrite a name through the first matching alignment rule.
 *
 * First match only, and the result is never fed back in: chaining rules can
 * cycle (`*.a=*.b` with `*.b=*.a`), and a pairing key that depends on rule
 * order in a non-obvious way is worse than one that ignores the later rules.
 *
 * @param {string} name
 * @param {AlignRule[]} [rules]
 * @param {boolean} [caseInsensitive] match the masks the way the filesystem
 *   matches names — a rule written `*.bak.txt` has to catch `FOO.BAK.TXT` on a
 *   case-insensitive volume, or alignment silently stops working there
 * @returns {string}
 */
export function alignmentNameOf(name, rules = [], caseInsensitive = false) {
  const base = String(name ?? '')
  const probe = caseInsensitive ? base.toLowerCase() : base
  for (const rule of rules ?? []) {
    const from = caseInsensitive ? rule.from.toLowerCase() : rule.from
    const star = from.indexOf('*')
    const head = from.slice(0, star)
    const tail = from.slice(star + 1)
    if (probe.length < head.length + tail.length) continue
    if (!probe.startsWith(head) || !probe.endsWith(tail)) continue
    // Captured from the original so a case-sensitive rewrite keeps the name's
    // own casing; the key is folded by the caller when that is wanted.
    const captured = base.slice(head.length, base.length - tail.length)
    return (caseInsensitive ? rule.to.toLowerCase() : rule.to).replace('*', captured)
  }
  return base
}

/**
 * The key two entries must share to be shown on one row.
 *
 * @param {string} name
 * @param {{ caseInsensitive?: boolean, alignRules?: AlignRule[] }} [opts]
 * @returns {string}
 */
export function pairKeyOf(name, opts = {}) {
  const aligned = alignmentNameOf(name, opts.alignRules, !!opts.caseInsensitive)
  return opts.caseInsensitive ? aligned.toLowerCase() : aligned
}

/**
 * Whether a pair was matched only because case was ignored.
 *
 * BC keeps "align case-insensitively" and "a case difference is a difference"
 * as two settings, so this answers the second without disturbing the first.
 *
 * @param {FileEntry|null|undefined} left
 * @param {FileEntry|null|undefined} right
 * @returns {boolean}
 */
export function namesDifferOnlyByCase(left, right) {
  if (!left || !right) return false
  const l = String(left.name ?? '')
  const r = String(right.name ?? '')
  return l !== r && l.toLowerCase() === r.toLowerCase()
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

// ── Checksum column ─────────────────────────────────────────────────────────
//
// Backed by the existing `hash-file` IPC, which computes MD5. The column is
// therefore labelled and tooltipped as MD5 rather than as CRC-32: the two are
// not interchangeable, and a user who checks the value against another tool's
// CRC has to be able to see why it does not match. A true CRC-32 column needs
// a `crc32-file` handler in the main process — see the hand-off notes.

/** Concurrent `hash-file` calls; matches the version column's IPC budget. */
const CRC_CONCURRENCY = 4

/**
 * Ceiling on how many files one "sort by checksum" is allowed to read, for the
 * same reason as {@link MAX_VERSION_PREFETCH}. Lower, because each of these
 * reads a whole file rather than a header.
 */
const MAX_CRC_PREFETCH = 500

/**
 * Largest file the column will hash. `hash-file` buffers the whole file in the
 * main process, so a multi-gigabyte row would take the app down; the cell says
 * so instead.
 */
const MAX_CRC_FILE_BYTES = 64 * 1024 * 1024

const VERSION_CANDIDATE_EXTS = new Set([
  'exe', 'dll', 'sys', 'ocx', 'scr', 'cpl', 'drv', 'efi', 'mun', 'mui', 'mp3',
])

// ── VCS column ──────────────────────────────────────────────────────────────
//
// Unlike the version and checksum columns, this one is *not* lazy per row. The
// whole repository's status arrives in one `git status` call per base folder
// and every row is answered from that table. Asking git per row is the mistake
// those two columns already had to be rescued from, and here it would also be
// wrong: git's answer for a file depends on the index, which one call reads
// once and 50,000 calls would read 50,000 times.

/**
 * @typedef {'untracked'|'modified'|'staged'|'deleted'|'conflict'|'ignored'|'clean'} VcsState
 *
 * @typedef {object} VcsRepo
 * @property {string} root absolute repository top level
 * @property {Record<string, VcsState>} files repo-relative path -> state
 * @property {Record<string, VcsState>} dirs repo-relative prefix (trailing '/')
 */

/** Short cell text per state; the tooltip carries the full wording. */
export const VCS_STATE_BADGES = Object.freeze({
  conflict: '衝突',
  staged: '已暫存',
  modified: '已修改',
  deleted: '已刪除',
  untracked: '未追蹤',
  ignored: '已忽略',
  clean: '乾淨',
})

/** @type {Readonly<Record<string, string>>} */
export const VCS_STATE_TITLES = Object.freeze({
  conflict: '合併衝突尚未解決（git unmerged）',
  staged: '變更已加入索引，尚未提交（git staged）',
  modified: '工作區內容與索引不同（git modified）',
  deleted: '檔案已被刪除',
  untracked: '未納入版本控制（git untracked）',
  ignored: '被 .gitignore 排除',
  clean: '與 HEAD 相同，沒有本機變更',
})

/**
 * The state git reports for one absolute path, or null when the path is not
 * inside the repository at all.
 *
 * Untracked and ignored *directories* are reported by git as a single entry
 * with a trailing slash rather than as one entry per file inside them. Matching
 * those by prefix is what lets a `node_modules` of 40,000 files be answered
 * without git ever having enumerated it.
 *
 * @param {VcsRepo|null|undefined} repo
 * @param {string} absPath
 * @returns {VcsState|null}
 */
export function lookupVcsState(repo, absPath) {
  if (!repo?.root) return null
  const root = String(repo.root).replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const p = String(absPath ?? '').replace(/\\/g, '/')
  if (p.length <= root.length || !p.startsWith(root + '/')) return null
  const rel = p.slice(root.length + 1)

  const exact = repo.files?.[rel]
  if (exact) return exact

  // Longest prefix wins, so an ignored file inside an untracked directory
  // still reads as ignored rather than inheriting the shallower answer.
  let best = null
  let bestLen = -1
  for (const prefix of Object.keys(repo.dirs ?? {})) {
    if (rel.startsWith(prefix) && prefix.length > bestLen) {
      best = repo.dirs[prefix]
      bestLen = prefix.length
    }
  }
  if (best) return best
  // Not listed by `git status` and inside the repo means tracked and unchanged.
  return 'clean'
}

/**
 * @typedef {object} VcsOpResult
 * @property {string} path
 * @property {'done'|'skipped'|'failed'} state
 * @property {string} message
 */

/**
 * Summary text for a batch of source-control writes.
 *
 * Modelled on {@link formatMoveSummary}: a batch that half-succeeded has to
 * name which paths did not, because the user's next action depends on it.
 *
 * @param {string} label operation name shown in the first line
 * @param {VcsOpResult[]} results
 * @returns {string}
 */
export function formatVcsOpSummary(label, results) {
  const list = results ?? []
  const done = list.filter((r) => r.state === 'done')
  const skipped = list.filter((r) => r.state === 'skipped')
  const failed = list.filter((r) => r.state === 'failed')

  const lines = [`${label}：${done.length} 項成功`]
  if (skipped.length) lines[0] += `，${skipped.length} 項略過`
  if (failed.length) lines[0] += `，${failed.length} 項失敗`

  if (skipped.length) {
    lines.push('', '略過（未執行任何操作）：')
    for (const r of skipped) lines.push(`• ${r.path}\n　${r.message}`)
  }
  if (failed.length) {
    lines.push('', '失敗：')
    for (const r of failed) lines.push(`• ${r.path}\n　${r.message}`)
  }
  return lines.join('\n')
}

// ── Owner / Group columns ───────────────────────────────────────────────────

/**
 * Paths per `file-owners` IPC call. Must not exceed the main process's own
 * `MAX_OWNER_BATCH`, which refuses the excess rather than silently dropping it.
 */
const OWNER_BATCH_SIZE = 200

/**
 * Ceiling on how many files one "sort by owner" is allowed to look up, for the
 * same reason as {@link MAX_VERSION_PREFETCH}. Higher than the checksum cap
 * because a lookup reads a security descriptor, not a whole file.
 */
const MAX_OWNER_PREFETCH = 2000

/**
 * Cell text for an owner/group value.
 *
 * An unknown value shows an em dash rather than an empty cell: a blank column
 * reads as "this file has no owner", which is never true.
 *
 * @param {string} value
 * @returns {string}
 */
export function ownerCellText(value) {
  return value ? value : '—'
}

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
    case 'created': {
      const t = Date.parse(entry?.ctime ?? '')
      return Number.isNaN(t) ? -1 : t
    }
    case 'ext':     return extensionOf(row?.name)
    case 'relpath': return entry?.path ?? row?.name ?? ''
    case 'abspath': return entry?.path ?? ''
    case 'attrs':   return entryAttrText(entry)
    // Same rule as `version`: an unread checksum sorts as empty rather than
    // being guessed at, and the view fills the set in before sorting on it.
    case 'crc':     return String(entry?.crc ?? '')
    // Rows whose version has not been read yet sort as empty rather than being
    // guessed at; the view fills the visible set in before sorting on it.
    case 'version': return String(entry?.version ?? '')
    // Owner, group and VCS sort as empty until they have been read, on the
    // same principle: an unknown value is never guessed at, and the view fills
    // the set in before sorting on it.
    case 'owner':   return String(entry?.owner ?? '')
    case 'group':   return String(entry?.group ?? '')
    case 'vcs':     return String(entry?.vcsState ?? '')
    case 'status':  return String(row?.status ?? '')
    default:        return String(row?.name ?? '')
  }
}

/**
 * @param {CompareRow} a
 * @param {CompareRow} b
 * @param {string} key
 * @param {number} [dir] 1 ascending, -1 descending
 * @param {boolean} [foldersFirst] group directories above files (BC's
 *   "Show folders first"); when false a directory sorts by the column value
 *   like any other row. Defaults to on, which is the stored default.
 * @returns {number}
 */
export function compareRowsBy(a, b, key, dir = 1, foldersFirst = true) {
  // Directories stay above files whichever way the column sorts, as in BC.
  // The grouping is applied before `dir` is, so descending reverses the order
  // *within* each group rather than putting files above folders.
  if (foldersFirst) {
    const aDir = isDirRow(a)
    const bDir = isDirRow(b)
    if (aDir !== bDir) return aDir ? -1 : 1
  }

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
 * @param {boolean} [foldersFirst] see {@link compareRowsBy}
 * @returns {CompareRow[]}
 */
export function sortRows(rows, key = 'name', dir = 1, foldersFirst = true) {
  return [...(rows ?? [])].sort((a, b) => compareRowsBy(a, b, key, dir, foldersFirst))
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

/**
 * Rows drawn beyond the viewport, honouring the Options override.
 *
 * Read at each render rather than captured once, so changing it in the dialog
 * shows up on the next scroll instead of at the next launch. The default
 * equals {@link OVERSCAN}, so an untouched dialog draws exactly what it did
 * before this became configurable.
 *
 * @returns {number}
 */
function overscanRows() {
  const n = Number(_settings.getPref('tweakVirtualOverscan'))
  // `Number('')` is 0 and 0 is a legitimate overscan, so a cleared value
  // cannot be told apart from a deliberate zero by its value alone — the
  // control refuses empty input, and anything non-numeric falls back here.
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : OVERSCAN
}

/**
 * The prefetch ceiling for one column, given that column's own budget.
 *
 * A ceiling, not a replacement: the checksum column deliberately stops lower
 * than the version column because each of its reads hashes an entire file, and
 * a single preference raising every column to the same number would undo that
 * on the most expensive one. So lowering this tightens every column and
 * raising it never pushes a column past what it can afford.
 *
 * @param {number} columnBudget
 * @returns {number}
 */
function prefetchCap(columnBudget) {
  const n = Number(_settings.getPref('tweakPrefetchLimit'))
  return Number.isFinite(n) && n > 0 ? Math.min(columnBudget, Math.floor(n)) : columnBudget
}

/**
 * Concurrent file-pair reads for the content-comparison pass.
 *
 * @returns {number}
 */
function rulesConcurrency() {
  const n = Number(_settings.getPref('tweakConcurrency'))
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : RULES_CONCURRENCY
}

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
  // Directories are keyed by their literal name whatever the alignment rules
  // say: a rule written for `*.bak.txt` must not silently merge two folders
  // and hide one side's children behind the other's.
  const keyOf = (e) => (e.isDirectory
    ? pairKeyOf(e.name, { caseInsensitive: opts.caseInsensitive })
    : pairKeyOf(e.name, opts))
  const leftMap = new Map(leftEntries.map((e) => [keyOf(e), e]))
  const rightMap = new Map(rightEntries.map((e) => [keyOf(e), e]))
  const allKeys = new Set([...leftMap.keys(), ...rightMap.keys()])

  const rows = []
  // Sort: directories first, then files; each group alphabetically.
  // A row counts as a directory if either side is a directory.
  const sorted = [...allKeys].sort((a, b) => {
    const aLeft = leftMap.get(a), aRight = rightMap.get(a)
    const bLeft = leftMap.get(b), bRight = rightMap.get(b)
    const aIsDir = !!(aLeft?.isDirectory || aRight?.isDirectory)
    const bIsDir = !!(bLeft?.isDirectory || bRight?.isDirectory)
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
    return a.localeCompare(b, undefined, { sensitivity: 'base' })
  })
  for (const key of sorted) {
    const left = leftMap.get(key) ?? null
    const right = rightMap.get(key) ?? null
    const status = computeStatus(left, right, mode, mtimeTolerance, opts)
    // The row is labelled with a name that exists on disk — the pairing key can
    // be case-folded or rewritten by an alignment rule and is not either side's
    // real name.
    const name = left?.name ?? right?.name ?? key
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
 * @param {CompareOpts} [opts]
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

  // A pair that only reached the same row because case was ignored. Checked
  // before `mode === 'name'` returns, since under "name only" this is the sole
  // difference there is left to report.
  if (opts.compareFilenameCase && namesDifferOnlyByCase(left, right)) return 'different'

  if (mode === 'name') return 'same'

  const sizeDiff = left.size !== right.size
  const lTime = new Date(left.mtime).getTime()
  const rTime = new Date(right.mtime).getTime()
  const timeDiff = !timestampsMatch(lTime, rTime, mtimeTolerance, opts.timeShift ?? 'none')

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
/**
 * Depth-first walk yielding the *model* rows.
 *
 * {@link flattenRows} copies each row so callers can attach a depth without
 * touching the tree; anything that writes a verdict back has to see the real
 * object, or the grading lands on a throwaway copy and nothing changes.
 *
 * @param {CompareRow[]} rows
 * @returns {Generator<CompareRow>}
 */
export function* eachRow(rows) {
  for (const row of rows ?? []) {
    yield row
    if (row.children?.length) yield* eachRow(row.children)
  }
}

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
 * @param {{ ignoreUnimportant?: boolean }} [opts]
 * @returns {CompareRow['status']}
 */
export function rollupStatus(row, opts = {}) {
  if (row.status === 'left-only' || row.status === 'right-only') return row.status
  if (!row.children) return row.status

  let sawLeftNewer = false
  let sawRightNewer = false
  let sawOther = false
  for (const child of row.children) {
    // With the master switch on, a child the mode graded unimportant is not a
    // difference, so it must not colour its parent either — otherwise the
    // folder still reads "左較新" with nothing differing inside it.
    if (opts.ignoreUnimportant && child.unimportant && !child.children) continue
    const s = child.children ? rollupStatus(child, opts) : child.status
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

// ── File Info (statistics panel) ─────────────────────────────────────────────

/**
 * @typedef {object} FolderSideTotals
 * @property {number} files
 * @property {number} dirs
 * @property {number} bytes  sum of file sizes; directories contribute nothing
 */

/**
 * @typedef {object} FolderTreeSummary
 * @property {FolderSideTotals} left
 * @property {FolderSideTotals} right
 * @property {Record<string, number>} status  counts keyed by the hyphenated status
 * @property {number} unimportant
 * @property {number} rows      compared rows (a matched pair counts once)
 * @property {boolean} partial  true when some directory has not been expanded yet
 */

/**
 * Per-side totals and status counts over the *loaded* part of the tree.
 *
 * `partial` is not cosmetic: the view loads a directory's children only when it
 * is expanded, so any number here is a lower bound until every folder has been
 * walked. Reporting a total without saying that would be a lie.
 *
 * @param {CompareRow[]} rows
 * @returns {FolderTreeSummary}
 */
export function summarizeFolderTree(rows) {
  /** @returns {FolderSideTotals} */
  const blank = () => ({ files: 0, dirs: 0, bytes: 0 })
  const summary = {
    left: blank(),
    right: blank(),
    /** @type {Record<string, number>} */
    status: {},
    unimportant: 0,
    rows: 0,
    partial: false,
  }

  /** @param {CompareRow[]} list */
  const walk = (list) => {
    for (const row of list ?? []) {
      summary.rows++
      const key = String(row?.status ?? '')
      if (key) summary.status[key] = (summary.status[key] ?? 0) + 1
      if (row?.unimportant) summary.unimportant++

      for (const side of /** @type {const} */ (['left', 'right'])) {
        const entry = row?.[side]
        if (!entry) continue
        if (entry.isDirectory) summary[side].dirs++
        else {
          summary[side].files++
          if (Number.isFinite(entry.size)) summary[side].bytes += entry.size
        }
      }

      const isDir = !!(row?.left?.isDirectory || row?.right?.isDirectory)
      if (isDir && !row.children) summary.partial = true
      if (row?.children?.length) walk(row.children)
    }
  }
  walk(rows)
  return summary
}

/**
 * Compare-mode labels, shared by the toolbar picker and the info panel so the
 * two can never drift apart.
 * @type {Record<string, string>}
 */
export const FOLDER_MODE_LABELS = {
  name: '僅名稱',
  size: '名稱+大小',
  mtime: '名稱+修改時間',
  both: '名稱+大小+時間',
  content: '內容 (MD5)',
  rules: '內容 (規則)',
}

/**
 * What "不重要差異" means under each comparison mode.
 *
 * The switch used to be graded only by the rules mode, so in the other five it
 * was a checkbox that did nothing — the user could not tell the difference
 * between "no unimportant differences here" and "this control is inert".
 * Every mode now either produces the grading or says, on the control itself,
 * why it cannot.
 *
 * @typedef {object} UnimportantSupport
 * @property {boolean} supported whether this mode can grade a row as unimportant
 * @property {string} note user-facing explanation, shown as the checkbox title
 */
/** @type {Record<string, UnimportantSupport>} */
export const FOLDER_UNIMPORTANT_SEMANTICS = {
  name: {
    supported: false,
    note: '「僅名稱」不讀取大小、時間或內容，沒有可以分級為「不重要」的差異',
  },
  size: {
    supported: false,
    note: '「名稱+大小」的唯一判準是大小，大小不同一律是重要差異',
  },
  mtime: {
    supported: false,
    note: '「名稱+修改時間」的唯一判準就是時間；忽略後所有項目都會變成相同，等於關閉比對',
  },
  both: {
    supported: true,
    note: '大小相同、只有修改時間不同 → 視為不重要差異',
  },
  content: {
    supported: true,
    note: '內容雜湊相同、只有時間或屬性不同 → 視為不重要差異',
  },
  rules: {
    supported: true,
    note: '比對規則判定只有次要差異（空白、行尾、自訂樣式）→ 視為不重要差異',
  },
}

/**
 * @param {string} mode
 * @returns {UnimportantSupport}
 */
export function unimportantSupportFor(mode) {
  return FOLDER_UNIMPORTANT_SEMANTICS[mode]
    ?? { supported: false, note: '此比對模式不會產生「不重要差異」' }
}

/**
 * Grade timestamp-only differences as unimportant.
 *
 * Only meaningful under 'both': there `left-newer` / `right-newer` can only
 * arise when the sizes match, so the pair differs by its timestamp alone.
 * Writes through {@link eachRow} — a copy from `flattenRows` would drop the
 * grading on the floor.
 *
 * @param {CompareRow[]} rows
 * @returns {number} rows graded
 */
export function markTimestampOnlyUnimportant(rows) {
  let graded = 0
  for (const row of eachRow(rows ?? [])) {
    if (row.left?.isDirectory || row.right?.isDirectory) continue
    if (!row.left || !row.right) continue
    if (row.status !== 'left-newer' && row.status !== 'right-newer') continue
    row.unimportant = true
    graded++
  }
  return graded
}

/**
 * Progress chatter that must not fill the log panel.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isProgressMessage(text) {
  return /^(掃描中…|計算檢查碼…|讀取版本資訊…)/.test(text ?? '')
}

/**
 * Compile the quick-filter box for regex mode.
 *
 * @param {string} pattern
 * @returns {{ re: RegExp|null, error: string }}
 */
export function compileQuickFilterRegex(pattern) {
  try {
    return { re: new RegExp(pattern, 'i'), error: '' }
  } catch (err) {
    return { re: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Display order and labels for the status counters in the info panel. */
const FOLDER_STATUS_LABELS = [
  ['same', '相同'],
  ['different', '不同'],
  ['left-only', '僅左側'],
  ['right-only', '僅右側'],
  ['left-newer', '左側較新'],
  ['right-newer', '右側較新'],
]

/**
 * The info panel's label/value rows, as plain data so a test can assert the
 * numbers without a DOM.
 *
 * @param {{
 *   leftPath: string, rightPath: string, mode: string,
 *   summary: FolderTreeSummary, scanMs: number|null,
 * }} info
 * @returns {string[][]}
 */
export function folderInfoRows(info) {
  const s = info.summary
  const side = (t) => `${t.files} 檔 / ${t.dirs} 目錄　${formatSize(t.bytes)}`
  /** @type {string[][]} */
  const rows = [
    ['左側路徑', info.leftPath || '（未選擇）'],
    ['右側路徑', info.rightPath || '（未選擇）'],
    ['比對模式', info.mode],
    ['左側合計', side(s.left)],
    ['右側合計', side(s.right)],
    ['比對列數', String(s.rows)],
  ]
  for (const [key, label] of FOLDER_STATUS_LABELS) {
    rows.push([label, String(s.status[key] ?? 0)])
  }
  if (s.unimportant) rows.push(['不重要差異', String(s.unimportant)])
  rows.push(['掃描耗時', info.scanMs == null ? '（尚未掃描）' : `${info.scanMs} ms`])
  if (s.partial) {
    rows.push(['注意', '尚有未展開的目錄，以上數字只涵蓋已載入的部分（可用 ⊞ 展開全部後再看）'])
  }
  return rows
}

// ── Touch (timestamp sync) ───────────────────────────────────────────────────

/**
 * @typedef {object} TouchJob
 * @property {string} src   the file whose mtime is copied
 * @property {string} dest  the file that receives it
 * @property {string} mtime ISO timestamp read from `src`
 */

/**
 * Apply each job's timestamp, collecting failures instead of stopping.
 *
 * @param {TouchJob[]} jobs
 * @param {{ setMtime: (path: string, mtime: string) => Promise<unknown> }} api
 * @returns {Promise<{ done: number, failures: Array<{ path: string, message: string }> }>}
 */
export async function runTouch(jobs, api) {
  let done = 0
  /** @type {Array<{ path: string, message: string }>} */
  const failures = []
  for (const job of jobs ?? []) {
    try {
      await api.setMtime(job.dest, job.mtime)
      done++
    } catch (err) {
      failures.push({ path: job.dest, message: errText(err) })
    }
  }
  return { done, failures }
}

/**
 * @param {{ done: number, failures: Array<{ path: string, message: string }> }} outcome
 * @returns {string}
 */
export function formatTouchSummary(outcome) {
  const { done, failures } = outcome
  if (!failures.length) return `已同步 ${done} 個檔案的修改時間。`
  const detail = failures.map((f) => `• ${f.path}\n　${f.message}`).join('\n')
  return `已同步 ${done} 個，${failures.length} 個失敗：\n\n${detail}`
}

// ── Three-way folder merge ──────────────────────────────────────────────────
//
// The two-way tree answers "do these differ". A merge has to answer "who
// changed it", which needs the common ancestor: left ≠ right says nothing about
// whether left edited it, right edited it, or both did. Everything below is
// written as pure functions over three `FileEntry|null` slots plus three
// pairwise equality verdicts, because the equality verdicts are the only part
// that needs the filesystem — and they come from the same size/time/hash/rules
// machinery the two-way comparison already uses, not from a second one.

/**
 * @typedef {'same'
 *   |'left-changed'|'right-changed'|'both-changed-same'
 *   |'left-added'|'right-added'|'both-added-same'
 *   |'left-deleted'|'right-deleted'|'both-deleted'
 *   |'mixed'
 *   |'conflict-changed'|'conflict-added'|'conflict-modify-delete'
 *   |'absent'} MergeStatus
 */

/**
 * @typedef {'left'|'base'|'right'|'delete'|'skip'} MergePick
 *   left/base/right — that side's file is what the output gets
 *   delete          — the output must not contain this path
 *   skip            — leave the output alone, whatever is already there
 */

/**
 * A row of the three-way tree.
 *
 * Deliberately a superset of `CompareRow`: `status` still carries the ordinary
 * left-vs-right verdict so every existing filter, sorter, renderer, report and
 * statistic keeps working unchanged, and the merge verdict rides alongside.
 *
 * @typedef {object} MergeRow
 * @property {string} name
 * @property {FileEntry|null} base
 * @property {FileEntry|null} left
 * @property {FileEntry|null} right
 * @property {string} status              left-vs-right, for the two-way machinery
 * @property {MergeStatus} mergeStatus
 * @property {MergePick|null} mergeResolution  user override; null ⇒ use the automatic pick
 * @property {MergeRow[]|null} children
 */

/** Display labels, shared by the row badge, the stats bar and the preview. */
export const MERGE_STATUS_LABELS = {
  'same': '三方相同',
  'left-changed': '僅左側修改',
  'right-changed': '僅右側修改',
  'both-changed-same': '兩側相同修改',
  'left-added': '僅左側新增',
  'right-added': '僅右側新增',
  'both-added-same': '兩側新增相同內容',
  'left-deleted': '左側刪除',
  'right-deleted': '右側刪除',
  'both-deleted': '兩側都刪除',
  'mixed': '子項有變更',
  'conflict-changed': '衝突：兩側修改不同',
  'conflict-added': '衝突：兩側新增不同內容',
  'conflict-modify-delete': '衝突：一側修改、一側刪除',
  'absent': '（不存在）',
}

/** @type {MergeStatus[]} */
export const MERGE_CONFLICT_STATUSES = [
  'conflict-changed', 'conflict-added', 'conflict-modify-delete',
]

/**
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isMergeConflict(status) {
  return MERGE_CONFLICT_STATUSES.includes(/** @type {MergeStatus} */ (status))
}

/**
 * The three-way verdict for one path.
 *
 * `eqLB` / `eqRB` / `eqLR` are only consulted where both of their sides exist;
 * a caller that cannot compute one may pass anything for it.
 *
 * @param {object} facts
 * @param {boolean} facts.hasBase
 * @param {boolean} facts.hasLeft
 * @param {boolean} facts.hasRight
 * @param {boolean} [facts.eqLB] left content equals base content
 * @param {boolean} [facts.eqRB] right content equals base content
 * @param {boolean} [facts.eqLR] left content equals right content
 * @returns {MergeStatus}
 */
export function computeMergeStatus(facts) {
  const { hasBase, hasLeft, hasRight } = facts
  const eqLB = !!facts.eqLB, eqRB = !!facts.eqRB, eqLR = !!facts.eqLR

  if (hasBase) {
    if (hasLeft && hasRight) {
      if (eqLB && eqRB) return 'same'
      if (eqLB) return 'right-changed'
      if (eqRB) return 'left-changed'
      // Both moved away from the ancestor. Landing on the same content is the
      // classic "we both applied the same patch" and merges without asking.
      return eqLR ? 'both-changed-same' : 'conflict-changed'
    }
    // One side deleted what the ancestor had. That only merges cleanly when
    // the surviving side never touched it — otherwise the deletion would throw
    // away an edit nobody reviewed.
    if (hasLeft) return eqLB ? 'right-deleted' : 'conflict-modify-delete'
    if (hasRight) return eqRB ? 'left-deleted' : 'conflict-modify-delete'
    return 'both-deleted'
  }

  if (hasLeft && hasRight) return eqLR ? 'both-added-same' : 'conflict-added'
  if (hasLeft) return 'left-added'
  if (hasRight) return 'right-added'
  return 'absent'
}

/**
 * What the output gets without anyone being asked, or null when the row needs
 * a human.
 *
 * `same`, `both-changed-same` and `both-added-same` resolve to the *left* copy
 * rather than the base copy even though all candidates are equal: the output
 * folder is very often the left folder, and picking left turns those rows into
 * a no-op instead of a few thousand pointless overwrites.
 *
 * @param {MergeStatus|string|null|undefined} status
 * @returns {MergePick|null}
 */
export function autoMergePick(status) {
  switch (status) {
    case 'same':
    case 'both-changed-same':
    case 'both-added-same':
    case 'left-changed':
    case 'left-added':
    case 'mixed':
      return 'left'
    case 'right-changed':
    case 'right-added':
      return 'right'
    case 'left-deleted':
    case 'right-deleted':
    case 'both-deleted':
      return 'delete'
    default:
      return null
  }
}

/**
 * `mixed` is a directory rollup, so its automatic pick is about the directory
 * itself existing, not about content. Files under it are decided on their own.
 * @param {MergeStatus|string|null|undefined} status
 * @returns {boolean}
 */
export function mergeAutoResolvable(status) {
  return autoMergePick(status) !== null
}

/**
 * The pick actually in force for a row: the user's override when there is one,
 * the automatic pick otherwise.
 *
 * @param {{ mergeStatus?: string, mergeResolution?: MergePick|null }} row
 * @returns {MergePick|null}
 */
export function effectiveMergePick(row) {
  if (row?.mergeResolution) return row.mergeResolution
  return autoMergePick(row?.mergeStatus)
}

/** @param {MergeRow} row */
function isMergeDirRow(row) {
  return !!(row?.base?.isDirectory || row?.left?.isDirectory || row?.right?.isDirectory)
}

/**
 * Pair three directory listings into one tree level.
 *
 * Keyed exactly the way {@link compareEntries} keys two: the filename-case and
 * alignment rules a user set for the comparison have to hold for all three
 * sides, or the base would pair with one side and not the other and every row
 * would read as a conflict.
 *
 * @param {FileEntry[]} baseEntries
 * @param {FileEntry[]} leftEntries
 * @param {FileEntry[]} rightEntries
 * @param {CompareOpts} [opts]
 * @returns {MergeRow[]}
 */
export function buildMergeRows(baseEntries, leftEntries, rightEntries, opts = {}) {
  /** @param {FileEntry} e */
  const keyOf = (e) => (e.isDirectory
    ? pairKeyOf(e.name, { caseInsensitive: opts.caseInsensitive })
    : pairKeyOf(e.name, opts))
  /** @param {FileEntry[]} list */
  const index = (list) => new Map((list ?? [])
    .filter(Boolean)
    .map((e) => [keyOf(e), e]))

  const baseMap = index(baseEntries)
  const leftMap = index(leftEntries)
  const rightMap = index(rightEntries)
  const keys = [...new Set([...leftMap.keys(), ...baseMap.keys(), ...rightMap.keys()])]

  keys.sort((a, b) => {
    const aDir = [leftMap, baseMap, rightMap].some((m) => m.get(a)?.isDirectory)
    const bDir = [leftMap, baseMap, rightMap].some((m) => m.get(b)?.isDirectory)
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.localeCompare(b, undefined, { sensitivity: 'base' })
  })

  /** @type {MergeRow[]} */
  const rows = []
  for (const key of keys) {
    const base = baseMap.get(key) ?? null
    const left = leftMap.get(key) ?? null
    const right = rightMap.get(key) ?? null
    rows.push({
      // A name that exists on some side; the pairing key can be case-folded or
      // rewritten by an alignment rule and is nobody's real filename.
      name: left?.name ?? right?.name ?? base?.name ?? key,
      base, left, right,
      status: 'same',
      mergeStatus: 'absent',
      mergeResolution: null,
      children: null,
    })
  }
  return rows
}

/**
 * Grade every row of a three-way tree.
 *
 * `equals` answers "is this pair's content the same", and is the *only* way
 * content is ever consulted here — the caller hands in one backed by whatever
 * compare mode is in force (size, timestamp, MD5, rules).
 *
 * Directories carry no content, so they are graded on presence alone and then
 * corrected by {@link rollupMergeStatus} once their children are known.
 *
 * @param {MergeRow[]} rows
 * @param {(a: FileEntry, b: FileEntry) => boolean} equals
 * @returns {void}
 */
export function gradeMergeRows(rows, equals) {
  for (const row of eachRow(/** @type {any[]} */ (rows ?? []))) {
    const dir = isMergeDirRow(row)
    const hasBase = !!row.base, hasLeft = !!row.left, hasRight = !!row.right
    row.mergeStatus = computeMergeStatus({
      hasBase, hasLeft, hasRight,
      eqLB: dir || (hasLeft && hasBase && equals(row.left, row.base)),
      eqRB: dir || (hasRight && hasBase && equals(row.right, row.base)),
      eqLR: dir || (hasLeft && hasRight && equals(row.left, row.right)),
    })
  }
}

/**
 * Fold a directory's merge verdict up from its children.
 *
 * Two things a presence-only verdict gets wrong and this fixes:
 * a folder present on all three sides is not "三方相同" merely because it
 * exists everywhere, and a folder one side deleted is not a clean deletion if
 * the surviving side changed something inside it.
 *
 * Children that have not been loaded leave the row alone rather than being
 * guessed at.
 *
 * @param {MergeRow} row
 * @returns {MergeStatus}
 */
export function rollupMergeStatus(row) {
  if (!isMergeDirRow(row) || !row.children) return row.mergeStatus

  let conflict = false
  let changed = false
  for (const child of row.children) {
    const s = isMergeDirRow(child) ? rollupMergeStatus(child) : child.mergeStatus
    child.mergeStatus = s
    if (isMergeConflict(s)) conflict = true
    else if (s !== 'same') changed = true
  }

  if (row.mergeStatus === 'left-deleted' || row.mergeStatus === 'right-deleted') {
    // The deleted side has no children to disagree with, so any surviving
    // change under here is an edit the deletion would silently discard.
    return (conflict || changed) ? 'conflict-modify-delete' : row.mergeStatus
  }
  if (row.mergeStatus !== 'same') return row.mergeStatus
  if (conflict) return 'conflict-changed'
  return changed ? 'mixed' : 'same'
}

/**
 * Counts over a graded three-way tree.
 *
 * @typedef {object} MergeSummary
 * @property {Record<string, number>} counts   keyed by MergeStatus
 * @property {number} files      rows that are not directories
 * @property {number} conflicts
 * @property {number} resolved   conflicts the user has decided
 * @property {number} unresolved conflicts still without a decision
 * @property {number} overrides  rows whose automatic pick was overridden
 * @property {boolean} partial   some directory has not been expanded yet
 */

/**
 * @param {MergeRow[]} rows
 * @returns {MergeSummary}
 */
export function summarizeMergeTree(rows) {
  /** @type {MergeSummary} */
  const out = {
    counts: {}, files: 0, conflicts: 0, resolved: 0, unresolved: 0,
    overrides: 0, partial: false,
  }
  for (const row of eachRow(/** @type {any[]} */ (rows ?? []))) {
    const key = String(row.mergeStatus ?? 'absent')
    out.counts[key] = (out.counts[key] ?? 0) + 1
    const dir = isMergeDirRow(row)
    if (!dir) out.files++
    if (dir && !row.children) out.partial = true
    if (isMergeConflict(key)) {
      out.conflicts++
      if (row.mergeResolution) out.resolved++
      else out.unresolved++
    } else if (row.mergeResolution
      && row.mergeResolution !== autoMergePick(key)) {
      out.overrides++
    }
  }
  return out
}

/**
 * Join an output root and a `/`-separated relative path using the root's own
 * separator, so a Windows output folder does not sprout forward slashes.
 *
 * @param {string} root
 * @param {string} rel
 * @returns {string}
 */
export function joinOutputPath(root, rel) {
  const sep = String(root).includes('\\') && !String(root).includes('/') ? '\\' : '/'
  const trimmed = String(root).replace(/[\\/]+$/, '')
  return rel ? `${trimmed}${sep}${String(rel).split('/').join(sep)}` : trimmed
}

/** Compare two paths the way the filesystem would, for "src is already dest". */
function samePath(a, b) {
  const norm = (p) => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return !!a && !!b && norm(a) === norm(b)
}

/**
 * @typedef {object} MergeOp
 * @property {'copy'|'delete'|'mkdir'} op
 * @property {string} rel        `/`-separated path below the output root
 * @property {string} dest
 * @property {string} [src]      copy only
 * @property {MergeStatus} status
 * @property {MergePick|null} pick
 * @property {boolean} isDir
 * @property {string} label      what the preview shows
 */

/**
 * Turn a graded tree into the exact list of filesystem operations the merge
 * would perform — and nothing else. This is what the preview shows and what
 * the runner executes, so the two can never describe different things.
 *
 * `existing` is the set of relative paths the output folder already holds. It
 * is what makes a delete honest: without it every "this path must not survive"
 * row would emit a delete that fails with ENOENT for paths the output never
 * had, and a preview full of operations that cannot happen is not a preview.
 * Passing `null` means "not scanned", and then deletes are emitted blind.
 *
 * @param {MergeRow[]} rows
 * @param {object} opts
 * @param {string} opts.outPath
 * @param {Set<string>|null} [opts.existing]
 * @param {(root: string, rel: string) => string} [opts.join]
 * @returns {MergeOp[]}
 */
export function buildMergeOps(rows, opts) {
  const { outPath, existing = null } = opts
  const join = opts.join ?? joinOutputPath
  /** @type {MergeOp[]} */
  const ops = []
  const has = (rel) => !existing || existing.has(rel)

  /**
   * @param {MergeRow[]} list
   * @param {string} prefix
   */
  const walk = (list, prefix) => {
    for (const row of list ?? []) {
      const rel = prefix ? `${prefix}/${row.name}` : row.name
      const dest = join(outPath, rel)
      const isDir = isMergeDirRow(row)
      const pick = effectiveMergePick(row)
      const status = /** @type {MergeStatus} */ (row.mergeStatus ?? 'absent')

      if (isDir) {
        if (pick === 'delete') {
          // Nothing under a folder that must not survive is copied, so its
          // children are not walked; one delete covers the subtree.
          if (has(rel)) {
            ops.push({ op: 'delete', rel, dest, status, pick, isDir: true, label: dest })
          }
          continue
        }
        if (pick === 'skip') continue
        const before = ops.length
        walk(row.children ?? [], rel)
        // `copy` creates its destination's parents, so a folder only needs an
        // op of its own when nothing lands inside it — an empty folder that
        // would otherwise silently disappear from the output.
        const filled = ops.slice(before).some((o) => o.op === 'copy' || o.op === 'mkdir')
        if (!filled && !has(rel)) {
          ops.push({ op: 'mkdir', rel, dest, status, pick, isDir: true, label: dest })
        }
        continue
      }

      if (pick === 'delete') {
        if (has(rel)) {
          ops.push({ op: 'delete', rel, dest, status, pick, isDir: false, label: dest })
        }
        continue
      }
      if (!pick || pick === 'skip') continue

      const src = row[pick]
      // A conflict left undecided, or a pick naming a side that has no file
      // here, produces nothing: writing a guess is exactly what the preview
      // exists to prevent.
      if (!src?.path) continue
      if (samePath(src.path, dest)) continue
      ops.push({
        op: 'copy', rel, dest, src: src.path, status, pick, isDir: false,
        label: `${src.path} → ${dest}`,
      })
    }
  }

  walk(rows ?? [], '')
  return ops
}

/**
 * @typedef {'copied'|'deleted'|'created'|'absent'|'failed'} MergeOpState
 *   copied/deleted/created — the operation did what it said
 *   absent                 — a delete found nothing there; the output already
 *                            matches what was asked for
 *   failed                 — the output still holds whatever it held before,
 *                            except for a copy, which may have written part of
 *                            a file before giving up
 *
 * @typedef {object} MergeOpResult
 * @property {MergeOp} op
 * @property {MergeOpState} state
 * @property {string} [message]
 */

/** Whether an error means "there was nothing there to begin with". */
function isMissingPathError(err) {
  const text = errText(err)
  return /ENOENT|no such file|找不到|不存在/i.test(text)
}

/**
 * Execute a merge plan, one operation at a time, never stopping on failure.
 *
 * Sequential for the same reason {@link runMove} is: a batch that stops half
 * way is only explainable if the half that ran is the half at the top of the
 * list the user just read.
 *
 * @param {MergeOp[]} ops
 * @param {FileOpsApi & { mkdirFolder?: (path: string) => Promise<unknown> }} api
 * @returns {Promise<MergeOpResult[]>}
 */
export async function runMergeOps(ops, api) {
  /** @type {MergeOpResult[]} */
  const results = []
  for (const op of ops ?? []) {
    try {
      if (op.op === 'copy') {
        await api.copyFile(op.src, op.dest)
        results.push({ op, state: 'copied' })
      } else if (op.op === 'delete') {
        await api.deleteFile(op.dest)
        results.push({ op, state: 'deleted' })
      } else {
        if (typeof api.mkdirFolder !== 'function') {
          throw new Error('此環境沒有建立資料夾的能力')
        }
        await api.mkdirFolder(op.dest)
        results.push({ op, state: 'created' })
      }
    } catch (err) {
      if (op.op === 'delete' && isMissingPathError(err)) {
        results.push({ op, state: 'absent' })
        continue
      }
      results.push({
        op, state: 'failed',
        message: op.op === 'copy'
          ? `複製失敗：${errText(err)}。目的地「${op.dest}」可能留下不完整的檔案，請自行確認。`
          : `${op.op === 'delete' ? '刪除' : '建立資料夾'}失敗：${errText(err)}。`,
      })
    }
  }
  return results
}

/**
 * @param {MergeOpResult[]} results
 * @returns {string}
 */
export function formatMergeSummary(results) {
  const list = results ?? []
  const copied = list.filter((r) => r.state === 'copied').length
  const deleted = list.filter((r) => r.state === 'deleted').length
  const created = list.filter((r) => r.state === 'created').length
  const absent = list.filter((r) => r.state === 'absent').length
  const failed = list.filter((r) => r.state === 'failed')

  const head = [`合併輸出完成：複製 ${copied} 項、刪除 ${deleted} 項、建立資料夾 ${created} 項`]
  if (absent) head.push(`${absent} 項本來就不存在（無需刪除）`)
  if (failed.length) head.push(`${failed.length} 項失敗`)
  const lines = [head.join('，')]

  if (failed.length) {
    // The output folder is now neither the old state nor the merged state, and
    // saying which operations did not happen is the only way to finish by hand.
    lines.push('',
      `⚠ 輸出資料夾目前是部分合併的狀態：${list.length - failed.length} 項已套用，`
      + `下列 ${failed.length} 項未套用，其餘內容維持執行前的樣子。`,
      '')
    for (const r of failed) lines.push(`• ${r.op.dest}\n　${r.message}`)
  }
  return lines.join('\n')
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
    /** @type {OtherFilters} BC's "Other Filters" tab: size / date / attributes */
    this._otherFilters = normalizeOtherFilters(options.otherFilters)

    // BC's "Compare Files Only": folder structure stops being a difference of
    // its own. Directories stay on screen — they are the only way to reach the
    // files — but they no longer count, hide or navigate as differences.
    this._filesOnly = false
    // BC's "Ignore Folder Structure": every file in the tree at one level,
    // paired by base name rather than by relative path.
    this._flatMode = false
    // Folder-level master switch for unimportant differences. What counts as
    // unimportant is mode-dependent; see FOLDER_UNIMPORTANT_SEMANTICS.
    this._ignoreUnimportant = false

    // BC's "Always Show Folders": folders stay on screen whatever the name
    // masks say, so a filtered file set is still reachable through its tree.
    this._alwaysShowFolders = false
    // BC's "Suppress Filters": show everything the scan found, without
    // discarding the mask text the user typed.
    this._suppressFilters = false
    // Quick-filter box reads as a regular expression instead of a BC mask.
    this._filterRegex = false
    /** @type {string|null} pattern the cached regex below was compiled from */
    this._quickRegexSource = null
    /** @type {RegExp|null} */
    this._quickRegex = null
    this._quickRegexError = ''
    /** @type {string[]} status-line messages worth keeping, newest last */
    this._log = []
    this._legendVisible = false
    this._logVisible = false

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
    /** Wall-clock ms the last completed scan took; null before the first one. */
    /** @type {number|null} */
    this._lastScanMs = null
    this._scanStartedAt = 0

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

    // Three-way merge state. Off by default and every branch that reads it is
    // guarded, so a two-way comparison behaves exactly as it did.
    this._mergeMode = false
    /** @type {string|null} common-ancestor folder */
    this._basePath = null
    /** @type {FolderSource|null} */
    this._baseSource = null
    /** @type {FileEntry[]} */
    this._baseEntries = []
    /** @type {string|null} where the merged result is written */
    this._outputPath = null
    /** @type {MergeOp[]} the previewed plan; cleared whenever it could be stale */
    this._mergeOps = []
    /** @type {Set<string>|null} relative paths the output folder already holds */
    this._outputExisting = null
    /** BC's "show only conflicts" merge filter. */
    this._showOnlyConflicts = false
    /** @type {number} index into getConflictIndices() */
    this._currentConflictIdx = -1

    // Sync mode state
    this._syncMode = false
    this._syncDirection = 'left-to-right' // 'left-to-right' | 'right-to-left' | 'bidirectional'
    /** @type {SyncAction} update never deletes; mirror does */
    this._syncAction = 'update'
    /** @type {SyncOp[]} */
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
    // Whether a differing version resource makes a pair different.
    this._compareVersion = !!options.compareVersion

    /** @type {ArchiveOptions} BC's "Compare within Archives" criteria */
    this._archiveOptions = normalizeArchiveOptions(options.archiveOptions)
    /** @type {Map<string, FileEntry[]>} archive path → its flattened entries */
    this._archiveEntryCache = new Map()

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

    // Checksum column, same lazy shape as the version column above.
    /** @type {Map<string, string>} */
    /** @type {'crc32'|'md5'} BC's column is a CRC-32, so that is the default. */
    this._checksumAlgo = 'crc32'
    this._crcCache = new Map()
    /** @type {Set<string>} */
    this._crcInFlight = new Set()
    /** @type {Map<string, string>} */
    this._crcTitles = new Map()
    /** @type {Array<{ entry: FileEntry, path: string }>} */
    this._crcQueue = []
    this._crcTimer = 0

    // VCS column. One entry per repository root, filled by a single
    // `git status` per base folder rather than by anything per row.
    /** @type {Map<string, VcsRepo>} */
    this._vcsRepos = new Map()
    /** @type {Set<string>} base folders already asked about */
    this._vcsAsked = new Set()
    /** @type {string} why the column is blank, when it is */
    this._vcsUnavailable = ''
    /** @type {boolean} the status read has settled (successfully or not) */
    this._vcsLoaded = false
    /** @type {Promise<void>|null} in-flight status read, so it runs once */
    this._vcsPending = null

    // Owner / group columns, lazy per drawn row and batched per IPC.
    /** @type {Map<string, { owner: string, group: string, error: string }>} */
    this._ownerCache = new Map()
    /** @type {Set<string>} */
    this._ownerInFlight = new Set()
    /** @type {Array<{ entry: FileEntry, path: string }>} */
    this._ownerQueue = []
    this._ownerTimer = 0

    // BC's timezone / daylight-saving tolerance. Orthogonal to the ±n-second
    // tolerance above: that one forgives rounding, this one forgives whole
    // hours, and widening the first to cover the second would hide real edits.
    /** @type {TimeShift} */
    this._timeShift = normalizeTimeShift(options.timeShift)
    // How filenames pair. `system` follows the host filesystem's own rule,
    // which is what makes a Windows-to-Linux comparison behave.
    /** @type {FilenameCase} */
    this._filenameCase = normalizeFilenameCase(options.filenameCase)
    // Whether a pair that only matched because case was ignored counts as a
    // difference. Has no effect while pairing is case-sensitive.
    this._compareFilenameCase = !!options.compareFilenameCase
    // BC's Filename Alignment: `*.bak.txt=*.txt` puts the two on one row.
    this._alignRulesText = typeof options.alignRules === 'string' ? options.alignRules : ''
    /** @type {AlignRule[]} */
    this._alignRules = parseAlignRules(this._alignRulesText).rules

    // P2-37: BC's settings scope. Defaults are stored under a reserved name in
    // the named-config store and read here, before any DOM exists, so a new
    // comparison opens with them already in force.
    if (options.useDefaults !== false) {
      const defaults = loadFolderDefaults()
      if (defaults) this._applyConfigSettings(defaults)
    }
  }

  /** Comparison options that are not the mode itself. @returns {CompareOpts} */
  _compareOpts() {
    return {
      compareAttributes: this._compareAttributes,
      compareFilenameCase: this._compareFilenameCase,
      caseInsensitive: filenamesAreCaseInsensitive(
        this._filenameCase, globalThis.navigator?.platform ?? ''),
      alignRules: this._alignRules,
      timeShift: this._timeShift,
    }
  }

  // ── Comparison criteria: time shift / filename case / filename alignment ────

  /** @returns {TimeShift} */
  getTimeShift() { return this._timeShift }

  /**
   * @param {unknown} mode
   * @returns {boolean} whether it changed
   */
  setTimeShift(mode) {
    const next = normalizeTimeShift(mode)
    if (next === this._timeShift) return false
    this._timeShift = next
    return true
  }

  /** @returns {FilenameCase} */
  getFilenameCase() { return this._filenameCase }

  /**
   * @param {unknown} mode
   * @returns {boolean} whether it changed
   */
  setFilenameCase(mode) {
    const next = normalizeFilenameCase(mode)
    if (next === this._filenameCase) return false
    this._filenameCase = next
    return true
  }

  /** @returns {boolean} */
  getCompareFilenameCase() { return this._compareFilenameCase }

  /**
   * @param {boolean} on
   * @returns {boolean} whether it changed
   */
  setCompareFilenameCase(on) {
    const next = !!on
    if (next === this._compareFilenameCase) return false
    this._compareFilenameCase = next
    return true
  }

  /** @returns {string} the rule text as the user typed it */
  getAlignRulesText() { return this._alignRulesText }

  /** @returns {AlignRule[]} */
  getAlignRules() { return this._alignRules.map((r) => ({ ...r })) }

  /**
   * @param {unknown} text `;`-separated `from=to` rules
   * @returns {{ changed: boolean, errors: string[] }} malformed entries are
   *   reported rather than dropped, so the caller can put them on screen
   */
  setAlignRules(text) {
    const raw = String(text ?? '')
    const { rules, errors } = parseAlignRules(raw)
    const before = JSON.stringify(this._alignRules)
    this._alignRulesText = raw
    this._alignRules = rules
    return { changed: before !== JSON.stringify(rules), errors }
  }

  // ── Quick Compare ───────────────────────────────────────────────────────────

  /**
   * Re-grade rows using only the quick tests — size and timestamp — whatever
   * the session's compare mode is.
   *
   * Beyond Compare's Quick Compare exists because the content modes are slow:
   * having hashed or rule-parsed a tree, you sometimes want a subset re-judged
   * without paying for it again, or judged at all when a content scan was
   * cancelled. It is deliberately a one-shot command and not a mode — the mode
   * dropdown already holds 「名稱+大小+時間」 for when that is what you want
   * permanently.
   *
   * Writes through {@link eachRow}, not `flattenRows`: the latter hands out
   * copies and the verdict would land on a throwaway object.
   *
   * @param {(row: CompareRow) => boolean} predicate
   * @returns {number} rows re-graded
   */
  _quickCompare(predicate) {
    let graded = 0
    for (const row of eachRow(this._rows ?? [])) {
      if (isDirRow(row)) continue
      if (!predicate(row)) continue
      row.status = computeStatus(
        row.left, row.right, 'both', this._mtimeTolerance, this._compareOpts())
      // A quick verdict replaces whatever the content or rules pass decided,
      // including its unimportant grading — that grading came from a text
      // comparison this row no longer claims to have had.
      row.unimportant = false
      graded++
    }
    if (graded) {
      this._refreshRollups()
      this._applyFilterAndRender()
    }
    return graded
  }

  /**
   * Quick-compare the checked rows, or the focused one when nothing is checked.
   * @returns {number} rows re-graded
   */
  quickCompareSelected() {
    const keys = this._selectedNames.size
      ? new Set(this._selectedNames)
      : new Set(this._focusedKey ? [this._focusedKey] : [])
    if (!keys.size) {
      alert('請先勾選或選取要快速比對的項目。')
      return 0
    }
    const graded = this._quickCompare((row) => {
      const key = row.left?.path || row.right?.path
      return !!key && keys.has(key)
    })
    this._setScanStatus(graded
      ? `快速比對：已用大小與時間重新判定 ${graded} 列`
      : '快速比對：選取的項目沒有可比對的檔案列')
    return graded
  }

  /**
   * Quick-compare every loaded row.
   * @returns {number} rows re-graded
   */
  quickCompareAll() {
    const graded = this._quickCompare(() => true)
    this._setScanStatus(`快速比對：已用大小與時間重新判定 ${graded} 列`)
    return graded
  }

  // ── Compare Contents ────────────────────────────────────────────────────────

  /**
   * Beyond Compare's Compare Contents: read both files and grade the pair by
   * their bytes, without switching the session's comparison mode.
   *
   * The counterpart to Quick Compare — that one downgrades a row to metadata,
   * this one upgrades it to content — and the reason it is a command rather
   * than a mode: hashing a whole tree to settle three files is the slow way to
   * answer the question the user actually asked.
   *
   * @param {(row: CompareRow) => boolean} predicate
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ graded: number, failed: number }>}
   */
  async _compareContents(predicate, signal) {
    if (typeof window.electronAPI?.hashFile !== 'function') {
      alert('此環境沒有提供檔案雜湊功能，無法比對內容。')
      return { graded: 0, failed: 0 }
    }
    const targets = [...eachRow(this._rows ?? [])].filter((row) =>
      !isDirRow(row) && row.left?.path && row.right?.path
      && sourceKindOf(row.left.path) === 'fs' && sourceKindOf(row.right.path) === 'fs'
      && predicate(row))
    if (!targets.length) return { graded: 0, failed: 0 }

    let graded = 0
    let failed = 0
    await _runWithConcurrency(targets, rulesConcurrency(), async (row) => {
      if (signal?.aborted) return
      try {
        const [lHash, rHash] = await Promise.all([
          window.electronAPI.hashFile(row.left.path),
          window.electronAPI.hashFile(row.right.path),
        ])
        if (signal?.aborted) return
        if (!lHash || !rHash) { failed++; return }
        const wasDifferent = row.status !== 'same'
        row.status = lHash === rHash ? 'same' : 'different'
        // Equal bytes on a pair the metadata pass called different means the
        // remaining difference is the timestamp — unimportant by definition.
        row.unimportant = lHash === rHash && wasDifferent
        graded++
      } catch (err) {
        // One unreadable file must not silently pass as "same".
        failed++
        console.error('FolderCompare.compareContents:', row.left.path, err)
      }
    })
    if (graded || failed) {
      this._refreshRollups()
      this._applyFilterAndRender()
    }
    return { graded, failed }
  }

  /**
   * Report a finished Compare Contents run.
   *
   * Written by the callers rather than by `_compareContents`, because the ones
   * that open a scan generation have their status line cleared when the
   * generation ends — a message written before that is wiped before it is read.
   *
   * @param {{ graded: number, failed: number }} result
   * @returns {number} rows re-graded
   */
  _reportCompareContents({ graded, failed }) {
    if (failed) {
      this._setScanStatus(`比對內容：已判定 ${graded} 列，${failed} 列無法讀取`)
    } else if (graded) {
      this._setScanStatus(`比對內容：已依實際內容判定 ${graded} 列`)
    } else {
      this._setScanStatus('比對內容：沒有兩側都存在、且可讀取的檔案列')
    }
    return graded
  }

  /**
   * Compare the checked rows' contents, or the focused row's when nothing is
   * checked.
   * @returns {Promise<number>} rows re-graded
   */
  async compareContentsSelected() {
    const keys = this._selectedNames.size
      ? new Set(this._selectedNames)
      : new Set(this._focusedKey ? [this._focusedKey] : [])
    if (!keys.size) {
      alert('請先勾選或選取要比對內容的項目。')
      return 0
    }
    return this._reportCompareContents(await this._compareContents((row) => {
      const key = row.left?.path || row.right?.path
      return !!key && keys.has(key)
    }))
  }

  /**
   * Compare every loaded pair by content.
   * @returns {Promise<number>} rows re-graded
   */
  async compareContentsAll() {
    const ctrl = this._beginScan()
    /** @type {{ graded: number, failed: number }} */
    let result = { graded: 0, failed: 0 }
    try {
      result = await this._compareContents(() => true, ctrl.signal)
    } finally {
      this._endScan(ctrl)
    }
    return this._reportCompareContents(result)
  }

  /**
   * Compare one row's contents — the right-click entry point.
   * @param {CompareRow} row
   * @returns {Promise<number>}
   */
  async compareContentsOfRow(row) {
    if (!row) return 0
    return this._reportCompareContents(
      await this._compareContents((candidate) => candidate === row))
  }

  // ── Compare To ──────────────────────────────────────────────────────────────

  /**
   * Beyond Compare's Compare To: keep one side where it is, and point the other
   * at a folder chosen from a dialog.
   *
   * @param {'left'|'right'} side the side that stays
   * @returns {Promise<boolean>} whether a new comparison was started
   */
  async compareTo(side) {
    if (!this._sourceOf(side) && !(side === 'left' ? this._leftPath : this._rightPath)) {
      alert(`請先開啟${side === 'left' ? '左' : '右'}側資料夾，才能與其他資料夾比對。`)
      return false
    }
    const picked = await window.electronAPI?.openFolder?.()
    if (!picked?.path) return false
    await this.setSource(side === 'left' ? 'right' : 'left', { kind: 'fs', root: picked.path })
    return true
  }

  /**
   * Compare one folder row's directory against a folder chosen from a dialog.
   *
   * The chosen folder always lands on the opposite side, so the row the user
   * right-clicked stays where they are looking at it.
   *
   * @param {string} basePath the directory to compare *from*
   * @param {'left'|'right'} side which side that directory belongs to
   * @returns {Promise<boolean>}
   */
  async compareFolderTo(basePath, side) {
    if (!basePath) return false
    const picked = await window.electronAPI?.openFolder?.()
    if (!picked?.path) return false
    // Both sides are replaced, so the first scan would compare the new base
    // against the *old* other side. Setting the state directly and scanning
    // once avoids showing that intermediate comparison at all.
    const other = side === 'left' ? 'right' : 'left'
    await this._disconnectRemote('left')
    await this._disconnectRemote('right')
    this._leftZipEntries = null
    this._rightZipEntries = null
    const roots = { [side]: basePath, [other]: picked.path }
    this._leftSource = { kind: 'fs', root: roots.left }
    this._rightSource = { kind: 'fs', root: roots.right }
    this._leftPath = roots.left
    this._rightPath = roots.right
    this._updatePathDisplay('left', this._sourceLabel('left'))
    this._updatePathDisplay('right', this._sourceLabel('right'))
    this._syncModeAvailability()
    this._expanded.clear()
    this._pendingFirstDiff = true
    this._recordNav()
    await this._scan()
    return true
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
    this._scanStartedAt = Date.now()
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
    // A cancelled run's elapsed time says nothing about how long the comparison
    // takes, so it is not recorded.
    if (!ctrl.signal.aborted) {
      this._lastScanMs = Math.max(0, Date.now() - this._scanStartedAt)
      this._setScanStatus('')
    }
  }

  /** @param {number} [n] */
  _tickProgress(n = 1) {
    this._scanProcessed += n
    if (this._scanController) this._setScanStatus(`掃描中… ${this._scanProcessed} 項`)
  }

  /** @param {string} text */
  _setScanStatus(text) {
    if (this._dom.scanStatus) this._dom.scanStatus.textContent = text
    // The status line is where every scan error is reported, and it is
    // overwritten by the next message before most users have read it.
    if (!text || isProgressMessage(text)) return
    if (this._log.at(-1) === text) return
    this._log.push(text)
    if (this._log.length > MAX_LOG_LINES) this._log.shift()
    if (this._logVisible) this._renderLogPanel()
  }

  /** @returns {string[]} the log panel's lines, oldest first */
  getLog() {
    return [...this._log]
  }

  clearLog() {
    this._log = []
    if (this._logVisible) this._renderLogPanel()
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
    const wanted = this._needsAttributes()
    this._columns = saveFolderColumns(ids)
    this._rebuildHeader()
    this._applyFilterAndRender()
    // Attributes are only read while scanning, so switching the column on has
    // to re-list the directories or the cells would stay blank forever.
    if (!wanted && this._needsAttributes() && (this._leftPath || this._rightPath)) {
      void this.refresh()
    }
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
    if (key === 'crc') {
      void this.prefetchCrcForSort().then(() => this._applyFilterAndRender())
    }
    if (key === 'owner' || key === 'group') {
      void this.prefetchOwnersForSort().then(() => this._applyFilterAndRender())
    }
    if (key === 'vcs') {
      void this.prefetchVcsForSort().then(() => this._applyFilterAndRender())
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
    // Previously this fell back to 'all', which both mislabelled the dropdown
    // and — because getConfig stores the preset — restored a saved session
    // showing every row instead of the combination the user chose.
    this._viewPreset = hit ? hit[0] : CUSTOM_VIEW_PRESET
    if (this._dom.viewPreset) this._dom.viewPreset.value = this._viewPreset
  }

  /** Push the current flags back onto the toolbar controls. */
  _syncFilterControls() {
    const { cbSame, cbDiff, cbOrphan, btnLeftNewer, btnRightNewer,
      btnLeftOrphan, btnRightOrphan, viewPreset } = this._dom
    if (cbSame) cbSame.checked = this._showSame
    if (cbDiff) cbDiff.checked = this._showDiff
    if (cbOrphan) cbOrphan.checked = this._showOrphan
    btnLeftNewer?.classList.toggle('fc-btn-filter-toggle--active', this._showLeftNewer)
    btnRightNewer?.classList.toggle('fc-btn-filter-toggle--active', this._showRightNewer)
    btnLeftOrphan?.classList.toggle('fc-btn-filter-toggle--active', this._showLeftOnly)
    btnRightOrphan?.classList.toggle('fc-btn-filter-toggle--active', this._showRightOnly)
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
    this._otherFilters = { ...EMPTY_OTHER_FILTERS }
    if (this._dom.filter) this._dom.filter.value = ''
    this._syncFilterFieldControls()
    this._applyFilterAndRender()
  }

  /** Push the mask fields back onto the panel inputs. */
  _syncFilterFieldControls() {
    for (const [key, input] of Object.entries(this._dom.filterInputs ?? {})) {
      if (input) input.value = this._filterFields[key] ?? ''
    }
    this._syncOtherFilterControls()
  }

  /** Read the panel inputs into the mask fields and the other filters. */
  _readFilterPanel() {
    /** @type {Partial<FilterFields>} */
    const next = {}
    for (const [key, input] of Object.entries(this._dom.filterInputs ?? {})) {
      next[key] = input?.value ?? ''
    }
    this._filterFields = normalizeFilterFields({ ...this._filterFields, ...next })

    /** @type {Partial<OtherFilters>} */
    const other = {}
    for (const [key, input] of Object.entries(this._dom.otherFilterInputs ?? {})) {
      other[key] = input?.value ?? ''
    }
    // A size box that parses to nothing would silently filter nothing at all;
    // saying so beats leaving the user to wonder why "1 meg" did not apply.
    for (const key of ['minSize', 'maxSize']) {
      const raw = String(other[key] ?? '').trim()
      if (raw && parseSizeInput(raw) === null) {
        alert(`「${raw}」不是可辨識的大小；請用 100、64K、2.5M 這樣的寫法。`)
        return
      }
    }
    this._otherFilters = normalizeOtherFilters({ ...this._otherFilters, ...other })

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
    // The ignore-unimportant checkbox has to arrive in the state the starting
    // mode allows, not in the state the markup happened to be built with.
    this._syncViewModeControls()
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
      timeShift: this._timeShift,
      filenameCase: this._filenameCase,
      compareFilenameCase: this._compareFilenameCase,
      alignRules: this._alignRulesText,
      compareAttributes: this._compareAttributes,
      compareVersion: this._compareVersion,
      filesOnly: this._filesOnly,
      flatMode: this._flatMode,
      ignoreUnimportant: this._ignoreUnimportant,
      alwaysShowFolders: this._alwaysShowFolders,
      suppressFilters: this._suppressFilters,
      filterRegex: this._filterRegex,
      archiveOptions: this.getArchiveOptions(),
      filterStr: this._filterStr,
      filterFields: { ...this._filterFields },
      otherFilters: { ...this._otherFilters },
      columns: [...this._columns],
      rulesOptions: this.getRulesOptions(),
      // The six flags are stored alongside the preset because a hand-tuned
      // combination is reported as 'custom', which names no flag set of its
      // own and so cannot restore the rows by itself.
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
    if (settings.timeShift !== undefined) this._timeShift = normalizeTimeShift(settings.timeShift)
    if (settings.filenameCase !== undefined) {
      this._filenameCase = normalizeFilenameCase(settings.filenameCase)
    }
    if (typeof settings.compareFilenameCase === 'boolean') {
      this._compareFilenameCase = settings.compareFilenameCase
    }
    if (typeof settings.alignRules === 'string') this.setAlignRules(settings.alignRules)
    if (typeof settings.compareAttributes === 'boolean') {
      this._compareAttributes = settings.compareAttributes
    }
    if (typeof settings.compareVersion === 'boolean') {
      this._compareVersion = settings.compareVersion
    }
    if (typeof settings.filesOnly === 'boolean') this._filesOnly = settings.filesOnly
    if (typeof settings.flatMode === 'boolean') this._flatMode = settings.flatMode
    if (typeof settings.ignoreUnimportant === 'boolean') {
      this._ignoreUnimportant = settings.ignoreUnimportant
    }
    if (typeof settings.alwaysShowFolders === 'boolean') {
      this._alwaysShowFolders = settings.alwaysShowFolders
    }
    if (typeof settings.suppressFilters === 'boolean') {
      this._suppressFilters = settings.suppressFilters
    }
    if (typeof settings.filterRegex === 'boolean') this._filterRegex = settings.filterRegex
    if (settings.archiveOptions) {
      this._archiveOptions = normalizeArchiveOptions({
        ...this._archiveOptions, ...settings.archiveOptions })
    }
    if (typeof settings.filterStr === 'string') this._filterStr = settings.filterStr
    if (settings.filterFields) this._filterFields = normalizeFilterFields(settings.filterFields)
    if (settings.otherFilters) this._otherFilters = normalizeOtherFilters(settings.otherFilters)
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
    this._syncViewModeControls()
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
    if (this._leftPath || this._rightPath) {
      // Turning it on needs the hidden bit, which only a fresh listing carries;
      // turning it off only changes how the existing entries are graded.
      if (next) void this.refresh()
      else void this._compareAndRender()
    }
    return next
  }

  /** Push the compare-attributes flag back onto its checkbox. */
  _syncAttributeControl() {
    if (this._dom.cbCompareAttrs) this._dom.cbCompareAttrs.checked = this._compareAttributes
    if (this._dom.cbCompareVersion) this._dom.cbCompareVersion.checked = this._compareVersion
  }

  // ── Version as a comparison criterion ───────────────────────────────────────

  /** @returns {boolean} */
  getCompareVersion() {
    return this._compareVersion
  }

  /**
   * BC's "Version information" comparison criterion.
   *
   * @param {boolean} on
   * @returns {boolean}
   */
  setCompareVersion(on) {
    const next = !!on
    if (next === this._compareVersion) return next
    this._compareVersion = next
    this._syncAttributeControl()
    if (this._leftPath || this._rightPath) void this._compareAndRender()
    return next
  }

  /**
   * Read both sides' version resources and mark the pairs that disagree.
   *
   * Only differing versions change a verdict. Equal versions are *not* taken
   * as proof of equality: two builds can carry the same version string and
   * different bytes, and reporting them as identical would hide a real change.
   *
   * Bounded by {@link MAX_VERSION_PREFETCH} for the same reason the column is
   * lazy — a source tree must not turn into 50k metadata round trips — and the
   * status line says so when the cap bites, rather than quietly grading part
   * of the tree.
   *
   * @param {CompareRow[]} rows
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async _applyVersionCompare(rows = this._rows, signal) {
    if (!window.electronAPI?.readMetadata) return

    /** @type {CompareRow[]} */
    const candidates = []
    let skipped = 0
    // Hoisted: reading the preference inside the loop would hit storage once
    // per row, which is the cost this cap exists to avoid.
    const cap = prefetchCap(MAX_VERSION_PREFETCH)
    for (const row of eachRow(rows ?? [])) {
      const { left, right } = row
      if (!left?.path || !right?.path) continue
      if (left.isDirectory || right.isDirectory) continue
      if (sourceKindOf(left.path) !== 'fs' || sourceKindOf(right.path) !== 'fs') continue
      if (!hasVersionCandidateExt(left.name) && !hasVersionCandidateExt(right.name)) continue
      if (candidates.length >= cap) { skipped++; continue }
      candidates.push(row)
    }
    if (skipped) {
      this._setScanStatus(`版本比對：超過 ${cap} 對檔案，其餘 ${skipped} 對未比對`)
    }
    if (!candidates.length) return

    /**
     * @param {FileEntry} entry
     * @returns {Promise<string>}
     */
    const versionOf = async (entry) => {
      const cached = this._versionCache.get(entry.path)
      if (cached !== undefined) return cached
      try {
        const meta = await window.electronAPI.readMetadata(entry.path)
        const text = versionTextFromMetadata(meta)
        this._resolveVersion(entry, text, versionTitleFromMetadata(meta))
        return text
      } catch (err) {
        // An unreadable resource is not a difference; saying so beats
        // inventing one, and the warning keeps the failure visible.
        console.warn('FolderCompare: version comparison lookup failed:', entry.path, err)
        this._resolveVersion(entry, '—', `無法讀取版本資訊：${errText(err)}`)
        return ''
      }
    }

    await _runWithConcurrency(candidates, VERSION_CONCURRENCY, async (row) => {
      if (signal?.aborted) return
      const [lv, rv] = await Promise.all([versionOf(row.left), versionOf(row.right)])
      if (signal?.aborted) return
      if (!lv || !rv || lv === rv || lv === '—' || rv === '—') return
      row.status = 'different'
      row.unimportant = false
      this._tickProgress()
    })
  }

  // ── Compare Files Only / Ignore Folder Structure / Ignore Unimportant ───────

  /** @returns {boolean} */
  getFilesOnly() {
    return this._filesOnly
  }

  /**
   * BC's "Compare Files Only": folder structure differences stop counting.
   *
   * @param {boolean} on
   * @returns {boolean}
   */
  setFilesOnly(on) {
    this._filesOnly = !!on
    this._syncViewModeControls()
    this._applyFilterAndRender()
    return this._filesOnly
  }

  /** @returns {boolean} the new state */
  toggleFilesOnly() {
    return this.setFilesOnly(!this._filesOnly)
  }

  /** @returns {boolean} */
  getFlatMode() {
    return this._flatMode
  }

  /**
   * BC's "Ignore Folder Structure": compare every file in both trees at one
   * level, paired by base name.
   *
   * Turning it on has to walk both trees in full — the lazy tree only knows
   * what the user expanded — so it goes through the cancellable scan path.
   *
   * @param {boolean} on
   * @returns {Promise<boolean>} the new state
   */
  async setFlatMode(on) {
    const next = !!on
    if (next === this._flatMode) return next
    this._flatMode = next
    this._syncViewModeControls()
    if (this._leftPath || this._rightPath) await this._compareAndRender()
    return this._flatMode
  }

  /** @returns {Promise<boolean>} */
  async toggleFlatMode() {
    return this.setFlatMode(!this._flatMode)
  }

  /** @returns {boolean} */
  getIgnoreUnimportant() {
    return this._ignoreUnimportant
  }

  /**
   * Folder-level master switch for unimportant differences.
   *
   * The switch is global, but what each mode grades as unimportant differs;
   * {@link unimportantSupportFor} is the single source for both the semantics
   * and the sentence the disabled checkbox shows.
   *
   * @param {boolean} on
   * @returns {boolean}
   */
  setIgnoreUnimportant(on) {
    this._ignoreUnimportant = !!on
    this._syncViewModeControls()
    // Directory verdicts depend on the switch, so they have to be recomputed
    // before the filter runs over them.
    this._refreshRollups()
    this._applyFilterAndRender()
    return this._ignoreUnimportant
  }

  /** @returns {boolean} the new state */
  toggleIgnoreUnimportant() {
    return this.setIgnoreUnimportant(!this._ignoreUnimportant)
  }

  /** @returns {UnimportantSupport} what the switch means under the current mode */
  ignoreUnimportantSupport() {
    return unimportantSupportFor(this._mode)
  }

  /** @returns {boolean} */
  getAlwaysShowFolders() {
    return this._alwaysShowFolders
  }

  /**
   * BC's "Always Show Folders": name masks stop hiding directories.
   * @param {boolean} on
   * @returns {boolean}
   */
  setAlwaysShowFolders(on) {
    this._alwaysShowFolders = !!on
    this._syncViewModeControls()
    this._applyFilterAndRender()
    return this._alwaysShowFolders
  }

  /** @returns {boolean} the new state */
  toggleAlwaysShowFolders() {
    return this.setAlwaysShowFolders(!this._alwaysShowFolders)
  }

  /** @returns {boolean} */
  getSuppressFilters() {
    return this._suppressFilters
  }

  /**
   * BC's "Suppress Filters": ignore every name mask without clearing it, so
   * the user can look at everything and then go straight back to the filtered
   * view.
   *
   * @param {boolean} on
   * @returns {boolean}
   */
  setSuppressFilters(on) {
    this._suppressFilters = !!on
    this._syncViewModeControls()
    this._applyFilterAndRender()
    return this._suppressFilters
  }

  /** @returns {boolean} the new state */
  toggleSuppressFilters() {
    return this.setSuppressFilters(!this._suppressFilters)
  }

  /** @returns {boolean} */
  getFilterRegex() {
    return this._filterRegex
  }

  /**
   * Read the quick-filter box as a regular expression rather than a BC mask.
   * @param {boolean} on
   * @returns {boolean}
   */
  setFilterRegex(on) {
    this._filterRegex = !!on
    this._syncViewModeControls()
    this._applyFilterAndRender()
    return this._filterRegex
  }

  /** @returns {boolean} the new state */
  toggleFilterRegex() {
    return this.setFilterRegex(!this._filterRegex)
  }

  /** Push the view-mode flags back onto their toolbar controls. */
  _syncViewModeControls() {
    const { cbFilesOnly, cbFlatMode, cbIgnoreUnimportant, cbAlwaysFolders,
      cbSuppressFilters, cbFilterRegex } = this._dom
    if (cbFilesOnly) cbFilesOnly.checked = this._filesOnly
    if (cbFlatMode) cbFlatMode.checked = this._flatMode
    if (cbAlwaysFolders) cbAlwaysFolders.checked = this._alwaysShowFolders
    if (cbSuppressFilters) cbSuppressFilters.checked = this._suppressFilters
    if (cbFilterRegex) cbFilterRegex.checked = this._filterRegex
    if (cbIgnoreUnimportant) {
      const support = this.ignoreUnimportantSupport()
      cbIgnoreUnimportant.checked = this._ignoreUnimportant
      // A control the current mode cannot honour is disabled and says why,
      // rather than silently doing nothing when clicked.
      cbIgnoreUnimportant.disabled = !support.supported
      const label = cbIgnoreUnimportant.closest('label')
      if (label) {
        label.title = support.supported
          ? `忽略不重要差異：${support.note}`
          : `此模式無法使用：${support.note}`
        label.classList.toggle('fc-cb--unavailable', !support.supported)
      }
    }
  }

  /**
   * Whether a row is a difference for counting and navigation.
   *
   * @param {CompareRow} row
   * @returns {boolean}
   */
  _countsAsDifference(row) {
    if (!row || row.status === 'same') return false
    if (this._ignoreUnimportant && row.unimportant) return false
    if (this._filesOnly && isDirRow(row)) return false
    return true
  }

  // ── Compare within Archives ─────────────────────────────────────────────────

  /** @returns {ArchiveOptions} */
  getArchiveOptions() {
    return { ...this._archiveOptions }
  }

  /**
   * @param {Partial<ArchiveOptions>} partial
   * @returns {ArchiveOptions}
   */
  setArchiveOptions(partial) {
    const before = this._archiveOptions
    this._archiveOptions = normalizeArchiveOptions({ ...before, ...(partial ?? {}) })
    // A changed extension list or expansion flag invalidates which rows are
    // containers, and the cached entry lists were keyed by a decision that no
    // longer holds.
    if (before.extensions !== this._archiveOptions.extensions) this._archiveEntryCache.clear()
    if (this._leftPath || this._rightPath) void this._compareAndRender()
    return this.getArchiveOptions()
  }

  /**
   * BC's "Compare within Archives" criteria, as a dialog.
   *
   * @returns {Promise<ArchiveOptions|null>} the applied options, or null on cancel
   */
  openArchiveOptionsDialog() {
    const host = this._dom.root ?? document.body
    return new Promise((resolve) => {
      const backdrop = el('div', { className: 'fc-modal-backdrop fc-archive-backdrop' })
      const modal = el('div', { className: 'fc-modal', role: 'dialog', 'aria-modal': 'true' })
      modal.appendChild(el('div', { className: 'fc-modal-title' }, '封存檔比對條件'))

      const cbExpand = el('input', { type: 'checkbox', className: 'fc-archive-expand' })
      cbExpand.checked = this._archiveOptions.expand
      const expandWrap = el('label', { className: 'fc-modal-check' })
      expandWrap.appendChild(cbExpand)
      expandWrap.appendChild(document.createTextNode(' 把封存檔當成資料夾展開（列出裡面的檔案）'))
      modal.appendChild(expandWrap)

      const cbContents = el('input', { type: 'checkbox', className: 'fc-archive-contents' })
      cbContents.checked = this._archiveOptions.compareContents
      const contentsWrap = el('label', { className: 'fc-modal-check' })
      contentsWrap.appendChild(cbContents)
      contentsWrap.appendChild(document.createTextNode(' 以內容清單判定兩個封存檔是否相同'))
      modal.appendChild(contentsWrap)

      modal.appendChild(el('div', { className: 'fc-modal-hint' },
        '同一份內容重新壓縮後，容器本身的位元組必定不同（時間戳與壓縮順序都寫在裡面），'
        + '所以只比大小與時間會永遠報成差異。勾選後改以「檔名 + 大小」的清單判定。'))

      const maskLabel = el('label', { className: 'fc-modal-field' })
      maskLabel.appendChild(el('span', {}, '算作封存檔的副檔名'))
      const maskInput = el('input', {
        type: 'text',
        className: 'fc-archive-extensions',
        title: '遮罩語法同篩選欄位；; 分隔',
      })
      maskInput.value = this._archiveOptions.extensions
      maskLabel.appendChild(maskInput)
      modal.appendChild(maskLabel)

      const actions = el('div', { className: 'fc-modal-actions' })
      const btnCancel = el('button', { className: 'fc-modal-cancel' }, '取消')
      const btnOk = el('button', { className: 'fc-modal-ok' }, '套用')
      actions.append(btnCancel, btnOk)
      modal.appendChild(actions)

      backdrop.appendChild(modal)
      host.appendChild(backdrop)
      this._dom.archiveModal = backdrop

      let settled = false
      /** @param {ArchiveOptions|null} result */
      const finish = (result) => {
        if (settled) return
        settled = true
        backdrop.remove()
        this._dom.archiveModal = null
        document.removeEventListener('keydown', onKey, true)
        resolve(result)
      }
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(null) }
      }

      btnCancel.addEventListener('click', () => finish(null))
      btnOk.addEventListener('click', () => {
        if (!maskInput.value.trim()) {
          alert('副檔名遮罩不可空白；留空會讓「封存檔」失去定義。')
          return
        }
        finish(this.setArchiveOptions({
          expand: cbExpand.checked,
          compareContents: cbContents.checked,
          extensions: maskInput.value,
        }))
      })
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null) })
      document.addEventListener('keydown', onKey, true)
      btnOk.focus()
    })
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
      if (this._countsAsDifference(flat[i]?.row)) out.push(i)
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
    // The forced mode change also changes what 忽略不重要 can mean.
    this._syncViewModeControls()
  }

  /** @param {'left'|'base'|'right'} side */
  _sourceOf(side) {
    if (side === 'base') return this._baseSource
    return side === 'left' ? this._leftSource : this._rightSource
  }

  /** @param {'left'|'base'|'right'} side */
  _pathOf(side) {
    if (side === 'base') return this._basePath
    return side === 'left' ? this._leftPath : this._rightPath
  }

  /** @param {'left'|'base'|'right'} side */
  _sourceLabel(side) {
    const src = this._sourceOf(side)
    return src?.label ?? this._pathOf(side) ?? ''
  }

  /**
   * Which panes the header, the rows and the path bar draw.
   * @returns {Array<'left'|'base'|'right'>}
   */
  _sides() {
    return this._mergeMode ? ['left', 'base', 'right'] : ['left', 'right']
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
      const which = { left: '左', base: '基準', right: '右' }[side] ?? side
      alert(`${which}側是${what}，僅供瀏覽，無法進行檔案操作`)
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
      /** @type {Array<{ side: 'left'|'right', entry: FileEntry, cb: HTMLInputElement }>} */
      const editableHidden = []
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

        // hidden is editable only where the platform has the attribute and the
        // scan actually read it. Offering a checkbox for a value we could not
        // read would make the dialog claim knowledge it does not have.
        const hiddenKnown = typeof entry.hidden === 'boolean'
        const canEditHidden = writable && hiddenKnown
          && typeof window.electronAPI?.setHidden === 'function'
        if (canEditHidden) {
          const hb = el('input', { type: 'checkbox', className: `fc-attr-hidden fc-attr-hidden-${side}` })
          hb.checked = entry.hidden === true
          const hWrap = el('label', { className: 'fc-modal-check' })
          hWrap.appendChild(hb)
          hWrap.appendChild(document.createTextNode(' 隱藏（H）'))
          block.appendChild(hWrap)
          editableHidden.push({ side, entry, cb: hb })
        } else {
          const hiddenText = entry.hidden === true ? '是'
            : entry.hidden === false ? '否'
              : '未知（此來源未讀取屬性）'
          block.appendChild(el('div', { className: 'fc-attrs-hidden' },
            `隱藏（H）：${hiddenText}${hiddenKnown ? ' — 此來源唯讀' : ''}`))
        }
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
        const hiddenChanges = editableHidden
          .filter((f) => f.cb.checked !== (f.entry.hidden === true))
          .map((f) => ({ side: f.side, entry: f.entry, hidden: f.cb.checked }))
        finish()
        if (changes.length || hiddenChanges.length) {
          void this._applyAttributeChanges(changes, hiddenChanges)
        }
      })
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish() })
      document.addEventListener('keydown', onKey, true)
      btnOk.focus()
    })
  }

  /**
   * Hand a file to the OS.
   *
   * @param {string} path
   * @param {boolean} withPicker show the "open with" chooser instead of the
   *   default association
   */
  async _openWith(path, withPicker) {
    try {
      await window.electronAPI.openWith(path, { withPicker })
    } catch (err) {
      // The OS refusing to open something is exactly the case the user needs
      // told about — nothing visible happens otherwise.
      alert(`無法開啟：
${path}

${errText(err)}`)
    }
  }

  /**
   * @param {Array<{ side: 'left'|'right', entry: FileEntry, readOnly: boolean }>} changes
   * @param {Array<{ side: 'left'|'right', entry: FileEntry, hidden: boolean }>} [hiddenChanges]
   * @returns {Promise<void>}
   */
  async _applyAttributeChanges(changes, hiddenChanges = []) {
    /** @type {string[]} */
    const failures = []
    for (const change of hiddenChanges) {
      try {
        const res = await window.electronAPI.setHidden(change.entry.path, change.hidden)
        change.entry.hidden = typeof res?.hidden === 'boolean' ? res.hidden : change.hidden
      } catch (err) {
        console.error('FolderCompare setHidden failed:', change.entry.path, err)
        failures.push(`• ${change.entry.path}
　${errText(err)}`)
      }
    }
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

    const defaults = this._deleteDefaults(opts)
    const choice = defaults.confirm
      ? await this._confirmDelete(targets.map((t) => t.path),
        { ...opts, permanent: defaults.permanent })
      // Confirmations off: the preference already answered both questions the
      // dialog would have asked, so it is not shown at all.
      : { ok: true, permanent: defaults.permanent }
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
    // Escalating to an unrecoverable delete is never done on the strength of
    // "do not ask before deleting" — that preference turns off the routine
    // confirmation, not the one guarding permanent loss. With it off the
    // failures are simply reported and the files are left alone.
    if (defaults.confirm && !choice.permanent && isRecycleBinUnavailable(outcome.failures)) {
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

    // A silent delete still has to leave a trace. The status line (and with it
    // the log panel) is written either way; only the modal summary is tied to
    // the confirmation preference, since the point of turning it off is to
    // stop being interrupted.
    const summary = formatDeleteSummary(outcome)
    this._setScanStatus(summary)
    if (defaults.confirm) alert(summary)
    this._selectedNames.clear()
    await this.refresh()
    return outcome.trashed + outcome.permanent > 0
  }

  /**
   * The delete choice the preferences imply, before any dialog is shown.
   *
   * `folderUseRecycleBin` is the *recoverable* option, so it maps to
   * `permanent: false`; getting this backwards would destroy files the user
   * asked to keep recoverable, which is why the polarity is stated once here
   * instead of at each call site.
   *
   * `opts.permanent` is only honoured when it is explicitly `true`
   * (Shift+Delete). The keyboard path always passes a boolean, so `??` would
   * let a plain Delete override a stored "never use the recycle bin".
   *
   * @param {{ permanent?: boolean }} [opts]
   * @returns {{ confirm: boolean, permanent: boolean }}
   */
  _deleteDefaults(opts = {}) {
    return {
      confirm: _settings.getPref('folderConfirmDelete') !== false,
      permanent: opts.permanent === true || _settings.getPref('folderUseRecycleBin') === false,
    }
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
        // Reading the Windows hidden bit spawns a process per directory, so it
        // is asked for only when something on screen actually consumes it.
        return this._needsAttributes()
          ? window.electronAPI.readDir(path, { attributes: true })
          : window.electronAPI.readDir(path)
    }
  }

  /**
   * Whether the extra attribute read is worth paying for: either the attribute
   * column is on screen, or attributes take part in the status decision.
   *
   * @returns {boolean}
   */
  _needsAttributes() {
    // The hidden filter is the third consumer: without the extra read every
    // entry's `hidden` is undefined and the filter would hide the whole tree.
    return this._compareAttributes
      || this._columns.includes('attrs')
      || this._otherFilters.hidden !== 'any'
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

  // ── Three-way folder merge ──────────────────────────────────────────────────

  /** @returns {boolean} */
  isMergeMode() { return this._mergeMode }

  /** @returns {string|null} */
  getBasePath() { return this._basePath }

  /** @returns {string|null} */
  getOutputPath() { return this._outputPath }

  /**
   * Enter or leave three-way merge mode.
   *
   * The pane count changes, so the whole view is rebuilt rather than patched;
   * the listener teardown is what keeps that from stacking a second document
   * key handler on every toggle.
   *
   * @param {boolean} on
   * @returns {Promise<boolean>} the mode actually in force afterwards
   */
  async setMergeMode(on) {
    const next = !!on
    if (next === this._mergeMode) return this._mergeMode
    if (next && this._syncMode) this.toggleSyncMode()
    this._mergeMode = next
    this._mergeOps = []
    this._outputExisting = null
    this._currentConflictIdx = -1
    if (!next) this._showOnlyConflicts = false
    this._expanded.clear()
    this._rebuildUi()
    this._emit('merge-mode-changed', { mergeMode: this._mergeMode })
    if (this._leftPath || this._rightPath || this._basePath) await this._scan()
    return this._mergeMode
  }

  /** @returns {Promise<boolean>} */
  async toggleMergeMode() { return this.setMergeMode(!this._mergeMode) }

  /**
   * Rebuild the DOM after a change the incremental renderers cannot express.
   *
   * `_bindEvents` installs two document-level listeners, so re-rendering
   * without dropping the previous pair would leave a keydown handler behind
   * for every toggle — the leak this project has already had to fix twice.
   */
  _rebuildUi() {
    if (this._onDocumentClick) {
      document.removeEventListener('click', this._onDocumentClick)
      this._onDocumentClick = null
    }
    if (this._onDocumentKeydown) {
      document.removeEventListener('keydown', this._onDocumentKeydown)
      this._onDocumentKeydown = null
    }
    this._dom.vlist = null
    this._render()
    this._bindEvents()
    this._renderMergePanel()
  }

  /** 選擇基準（共同祖先）資料夾。 */
  async openBase() {
    const result = await window.electronAPI.openFolder()
    if (!result) return
    await this.setBase(result.path)
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async setBase(path) {
    this._basePath = path || null
    this._baseSource = path ? { kind: 'fs', root: path } : null
    if (this._dom.dispBase) this._dom.dispBase.textContent = this._basePath ?? '（未選擇）'
    this._mergeOps = []
    if (this._mergeMode) await this._scan()
  }

  /** 選擇合併輸出資料夾。 */
  async openOutput() {
    const result = await window.electronAPI.openFolder()
    if (!result) return
    await this.setOutput(result.path)
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async setOutput(path) {
    this._outputPath = path || null
    // A plan built against the old output folder would name the wrong
    // destinations, so it stops being a plan.
    this._mergeOps = []
    this._outputExisting = null
    this._renderMergePanel()
  }

  /** @returns {MergeSummary} */
  getMergeSummary() { return summarizeMergeTree(this._rows ?? []) }

  /**
   * Flattened-row indices of the conflicts currently on screen.
   * Shares the virtual scroller's coordinate system, like getDiffIndices.
   * @returns {number[]}
   */
  getConflictIndices() {
    const out = []
    const flat = this._visibleRows ?? []
    for (let i = 0; i < flat.length; i++) {
      if (isMergeConflict(flat[i]?.row?.mergeStatus)) out.push(i)
    }
    return out
  }

  /** @returns {number} */
  getCurrentConflictIndex() { return this._currentConflictIdx }

  /** @returns {NavResult} */
  nextConflict() { return this._stepConflict(1) }

  /** @returns {NavResult} */
  prevConflict() { return this._stepConflict(-1) }

  /**
   * @param {number} delta
   * @returns {NavResult}
   */
  _stepConflict(delta) {
    const indices = this.getConflictIndices()
    const total = indices.length
    const from = this._currentConflictIdx
    const to = stepDiffIndex(from, total, delta)
    if (total === 0 || to < 0 || to >= total) return navResult(from, -1, total)
    this._currentConflictIdx = to
    this._scrollFlatIndexIntoView(indices[to])
    this._applyCurrentDiffMark(indices[to])
    this._syncMergePanelStatus()
    return navResult(from, to, total)
  }

  /** @returns {boolean} */
  getShowOnlyConflicts() { return this._showOnlyConflicts }

  /** @param {boolean} on */
  setShowOnlyConflicts(on) {
    this._showOnlyConflicts = !!on
    this._currentConflictIdx = -1
    if (this._dom.cbOnlyConflicts) this._dom.cbOnlyConflicts.checked = this._showOnlyConflicts
    this._applyFilterAndRender()
  }

  /** @returns {boolean} */
  toggleShowOnlyConflicts() {
    this.setShowOnlyConflicts(!this._showOnlyConflicts)
    return this._showOnlyConflicts
  }

  /**
   * Record a decision for one row.
   *
   * @param {MergeRow} row
   * @param {MergePick|null} pick null clears the override and restores the
   *   automatic verdict
   */
  resolveRow(row, pick) {
    if (!row) return
    row.mergeResolution = pick
    this._mergeOps = []
    this._applyFilterAndRender()
    this._renderMergePanel()
  }

  /**
   * Apply a decision to every unresolved conflict at once.
   *
   * @param {MergePick} pick
   * @returns {number} how many rows were decided
   */
  resolveAllConflicts(pick) {
    let n = 0
    for (const row of eachRow(this._rows ?? [])) {
      if (!isMergeConflict(row.mergeStatus)) continue
      if (row.mergeResolution) continue
      row.mergeResolution = pick
      n++
    }
    if (n) {
      this._mergeOps = []
      this._applyFilterAndRender()
      this._renderMergePanel()
    }
    return n
  }

  /**
   * Drop every manual decision, returning the whole tree to its automatic
   * verdict.
   * @returns {number}
   */
  clearMergeResolutions() {
    let n = 0
    for (const row of eachRow(this._rows ?? [])) {
      if (!row.mergeResolution) continue
      row.mergeResolution = null
      n++
    }
    if (n) {
      this._mergeOps = []
      this._applyFilterAndRender()
      this._renderMergePanel()
    }
    return n
  }

  /**
   * Every relative path the output folder already holds.
   *
   * Needed before a plan can be built: it is the difference between "delete
   * this" and "this was never there", and between creating an empty folder and
   * pointlessly re-creating one.
   *
   * @param {string} root
   * @returns {Promise<Set<string>>}
   */
  async _scanOutputTree(root) {
    /** @type {Set<string>} */
    const seen = new Set()
    if (typeof window.electronAPI?.readDir !== 'function') return seen
    /** @type {Array<{ path: string, rel: string }>} */
    const queue = [{ path: root, rel: '' }]
    let dirs = 0
    while (queue.length) {
      if (dirs++ >= MAX_EXPAND_ALL_DIRS) {
        this._setScanStatus(`輸出資料夾超過 ${MAX_EXPAND_ALL_DIRS} 個目錄，更深的層級未納入預覽`)
        break
      }
      const cur = queue.shift()
      let entries = []
      try {
        entries = await window.electronAPI.readDir(cur.path)
      } catch (err) {
        // An unreadable output subtree is not fatal, but pretending it is empty
        // would turn "delete" rows into no-ops without telling anyone.
        console.error('FolderCompare: could not read output folder', cur.path, err)
        this._setScanStatus(`無法讀取輸出資料夾「${cur.path}」：${errText(err)}`)
        continue
      }
      for (const entry of entries ?? []) {
        const rel = cur.rel ? `${cur.rel}/${entry.name}` : entry.name
        seen.add(rel)
        if (entry.isDirectory) queue.push({ path: entry.path, rel })
      }
    }
    return seen
  }

  /**
   * Build the plan and show it. Nothing is written.
   * @returns {Promise<MergeOp[]>}
   */
  async previewMerge() {
    if (!this._mergeMode) { alert('請先切換到三向合併模式'); return [] }
    if (!this._outputPath) { alert('請先選擇合併輸出資料夾'); return [] }
    const summary = this.getMergeSummary()
    if (summary.partial) {
      this._setScanStatus('尚有未展開的目錄；請按 ⊞ 展開全部，預覽才會涵蓋整棵樹')
    }
    this._outputExisting = await this._scanOutputTree(this._outputPath)
    this._mergeOps = buildMergeOps(this._rows ?? [], {
      outPath: this._outputPath,
      existing: this._outputExisting,
    })
    this._renderMergePreview()
    this._syncMergePanelStatus()
    return this._mergeOps
  }

  /**
   * Execute the previewed plan.
   *
   * Refuses to run without a preview: the plan is the only description of what
   * is about to happen, and a destructive run whose description was never on
   * screen is the thing the preview exists to prevent.
   *
   * @returns {Promise<MergeOpResult[]>}
   */
  async applyMerge() {
    if (!this._mergeOps.length) {
      alert('請先按「預覽輸出」，確認要執行的操作後再合併')
      return []
    }
    if (!this._outputPath) { alert('請先選擇合併輸出資料夾'); return [] }

    const summary = this.getMergeSummary()
    if (summary.unresolved) {
      // An undecided conflict produces no operation at all, so the output would
      // simply lack that path. Silently shipping a partial merge is worse than
      // asking.
      if (!confirm(
        `還有 ${summary.unresolved} 個衝突沒有決定，這些項目不會寫入輸出資料夾。\n\n`
        + '要略過它們繼續合併嗎？')) return []
    }

    const deletes = this._mergeOps.filter((op) => op.op === 'delete')
    const copies = this._mergeOps.filter((op) => op.op === 'copy')
    if (!confirm(
      `即將把合併結果寫入：\n${this._outputPath}\n\n`
      + `複製 ${copies.length} 項、刪除 ${deletes.length} 項、`
      + `建立資料夾 ${this._mergeOps.filter((op) => op.op === 'mkdir').length} 項。\n\n`
      + '這會直接修改輸出資料夾的內容，要繼續嗎？')) return []

    const results = await runMergeOps(this._mergeOps, {
      copyFile: (src, dest) => window.electronAPI.copyFile(src, dest),
      deleteFile: (path) => window.electronAPI.deleteFile(path),
      renameFile: (a, b) => window.electronAPI.renameFile(a, b),
      mkdirFolder: (path) => window.electronAPI.mkdirFolder(path),
    })
    // The plan describes a state the output no longer has; keeping it would let
    // a second click re-run operations against a folder that already moved.
    this._mergeOps = []
    this._outputExisting = null
    alert(formatMergeSummary(results))
    this._renderMergePanel()
    await this.refresh()
    return results
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
      // Compare Files Only and the ignore-unimportant switch both say certain
      // rows are not differences; the counters have to agree with the tree and
      // with difference navigation, or the status bar contradicts F7.
      const counted = this._countsAsDifference(row) ? row.status : 'same'
      const key = String(counted).replace(/-/g, '_')
      if (Object.prototype.hasOwnProperty.call(stats, key) && key !== 'total') {
        stats[key]++
      }
    }
    stats.total = stats.same + stats.different + stats.left_only + stats.right_only + stats.left_newer + stats.right_newer
    return stats
  }

  // ── File Info ───────────────────────────────────────────────────────────────

  /**
   * Everything the info panel shows, as data.
   *
   * @returns {{
   *   leftPath: string, rightPath: string, mode: string,
   *   summary: FolderTreeSummary, scanMs: number|null, scanning: boolean
   * }}
   */
  getFolderInfo() {
    return {
      leftPath: this._leftPath ?? '',
      rightPath: this._rightPath ?? '',
      mode: FOLDER_MODE_LABELS[this._mode] ?? String(this._mode),
      summary: summarizeFolderTree(this._rows ?? []),
      scanMs: this._lastScanMs,
      scanning: this.isScanning(),
    }
  }

  /**
   * Show the per-side totals, status counts and scan time.
   *
   * @returns {Promise<void>}
   */
  openInfoDialog() {
    const host = this._dom.root ?? document.body
    return new Promise((resolve) => {
      const info = this.getFolderInfo()
      const backdrop = el('div', { className: 'fc-modal-backdrop fc-info-backdrop' })
      const modal = el('div', { className: 'fc-modal', role: 'dialog', 'aria-modal': 'true' })
      modal.appendChild(el('div', { className: 'fc-modal-title' }, '資料夾比對資訊'))

      const table = el('table', { className: 'fc-info-table' })
      const tbody = el('tbody')
      for (const [label, value] of folderInfoRows(info)) {
        const tr = el('tr')
        tr.appendChild(el('th', {}, label))
        tr.appendChild(el('td', {}, value))
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      modal.appendChild(table)

      if (info.scanning) {
        modal.appendChild(el('div', { className: 'fc-modal-hint' },
          '掃描仍在進行中，數字會隨掃描完成而改變。'))
      }

      const actions = el('div', { className: 'fc-modal-actions' })
      const btnOk = el('button', { className: 'fc-modal-ok' }, '關閉')
      actions.append(btnOk)
      modal.appendChild(actions)

      backdrop.appendChild(modal)
      host.appendChild(backdrop)
      this._dom.infoModal = backdrop

      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        backdrop.remove()
        this._dom.infoModal = null
        document.removeEventListener('keydown', onKey, true)
        resolve()
      }
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish() } }

      btnOk.addEventListener('click', finish)
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish() })
      document.addEventListener('keydown', onKey, true)
      btnOk.focus()
    })
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
  /**
   * The merge control strip: output folder, conflict navigation, batch
   * resolution, preview and apply.
   *
   * Rebuilt wholesale on every state change rather than patched — it is one
   * strip of a dozen controls, and a stale button here is a destructive run
   * against the wrong plan.
   */
  _renderMergePanel() {
    const root = this._dom.root
    if (!root) return
    root.querySelector('.merge-panel')?.remove()
    this._dom.mergePanel = null
    if (!this._mergeMode) return

    const panel = el('div', { className: 'merge-panel' })

    // ── output folder ──
    const outRow = el('div', { className: 'merge-row' })
    const btnOut = el('button', { className: 'merge-btn' }, '選擇輸出資料夾…')
    const outPath = el('span', { className: 'merge-out-path' },
      this._outputPath ?? '（未選擇）')
    btnOut.addEventListener('click', () => void this.openOutput())
    outRow.append(el('span', { className: 'merge-label' }, '合併輸出：'), btnOut, outPath)

    // ── conflict navigation and filter ──
    const navRow = el('div', { className: 'merge-row' })
    const cbWrap = el('label', { className: 'merge-check' })
    const cbOnly = el('input', { type: 'checkbox', className: 'merge-only-conflicts' })
    cbOnly.checked = this._showOnlyConflicts
    cbOnly.addEventListener('change', () => this.setShowOnlyConflicts(!!cbOnly.checked))
    this._dom.cbOnlyConflicts = cbOnly
    cbWrap.append(cbOnly, document.createTextNode(' 只顯示衝突'))

    const btnPrev = el('button', { className: 'merge-btn merge-btn--nav' }, '◀ 上一個衝突')
    const btnNext = el('button', { className: 'merge-btn merge-btn--nav' }, '下一個衝突 ▶')
    btnPrev.addEventListener('click', () => this.prevConflict())
    btnNext.addEventListener('click', () => this.nextConflict())
    const status = el('span', { className: 'merge-status' })
    this._dom.mergeStatusEl = status
    navRow.append(cbWrap, btnPrev, btnNext, status)

    // ── batch resolution ──
    const batchRow = el('div', { className: 'merge-row' })
    batchRow.appendChild(el('span', { className: 'merge-label' }, '未決衝突全部採用：'))
    for (const [pick, label] of /** @type {Array<[MergePick, string]>} */ ([
      ['left', '左側'], ['base', '基準'], ['right', '右側'], ['delete', '刪除'],
    ])) {
      const btn = el('button', { className: 'merge-btn' }, label)
      btn.dataset.pick = pick
      btn.addEventListener('click', () => {
        const n = this.resolveAllConflicts(pick)
        this._setScanStatus(n ? `已將 ${n} 個未決衝突設為「${label}」` : '沒有未決的衝突')
      })
      batchRow.appendChild(btn)
    }
    const btnClear = el('button', { className: 'merge-btn' }, '清除所有手動決議')
    btnClear.addEventListener('click', () => {
      const n = this.clearMergeResolutions()
      this._setScanStatus(n ? `已清除 ${n} 項手動決議` : '沒有手動決議可清除')
    })
    batchRow.appendChild(btnClear)

    // ── preview / apply ──
    const actRow = el('div', { className: 'merge-row merge-row--actions' })
    const btnPreview = el('button', { className: 'merge-btn' }, '預覽輸出')
    const btnApply = el('button', { className: 'merge-btn merge-btn--primary' }, '執行合併')
    // Apply stays shut until a plan exists, because the plan *is* the warning.
    btnApply.disabled = !this._mergeOps.length
    btnPreview.addEventListener('click', () => void this.previewMerge().then(() => {
      btnApply.disabled = !this._mergeOps.length
    }))
    btnApply.addEventListener('click', () => void this.applyMerge())
    this._dom.btnMergePreview = btnPreview
    this._dom.btnMergeApply = btnApply
    actRow.append(btnPreview, btnApply)

    panel.append(outRow, navRow, batchRow, actRow)

    const toolbar = root.querySelector('.fc-toolbar')
    if (toolbar?.nextSibling) root.insertBefore(panel, toolbar.nextSibling)
    else root.insertBefore(panel, root.firstChild)
    this._dom.mergePanel = panel

    this._syncMergePanelStatus()
    if (this._mergeOps.length) this._renderMergePreview()
  }

  /** Refresh the counters without rebuilding the panel. */
  _syncMergePanelStatus() {
    const elStatus = this._dom.mergeStatusEl
    if (!elStatus) return
    const s = this.getMergeSummary()
    const total = this.getConflictIndices().length
    const at = this._currentConflictIdx >= 0 ? `${this._currentConflictIdx + 1}/${total}` : `–/${total}`
    const parts = [
      `衝突 ${at}`,
      `未決 ${s.unresolved}`,
      `已決 ${s.resolved}`,
      `可自動合併 ${s.files - s.conflicts}`,
    ]
    if (s.overrides) parts.push(`手動覆寫 ${s.overrides}`)
    if (s.partial) parts.push('（尚有未展開的目錄）')
    elStatus.textContent = parts.join('　')
  }

  /** List the previewed operations under the panel. */
  _renderMergePreview() {
    const panel = this._dom.mergePanel
    if (!panel) return
    panel.querySelector('.merge-preview')?.remove()

    const preview = el('div', { className: 'merge-preview' })
    if (!this._mergeOps.length) {
      preview.classList.add('merge-empty')
      preview.textContent = '✓ 沒有需要執行的操作（輸出資料夾已經是合併後的樣子）'
      panel.appendChild(preview)
      return
    }

    const labels = { copy: '複製', delete: '刪除', mkdir: '建立資料夾' }
    preview.appendChild(el('div', { className: 'merge-preview-title' },
      `待執行操作（共 ${this._mergeOps.length} 項）：`))
    const list = el('div', { className: 'merge-preview-list' })
    for (const op of this._mergeOps) {
      const row = el('div', { className: `merge-op merge-op--${op.op}` })
      // textContent throughout: a filename holding HTML metacharacters must
      // not become markup in the one dialog the user reads before a delete.
      row.appendChild(el('span', { className: 'merge-op-type' }, labels[op.op] ?? op.op))
      row.appendChild(el('span', { className: 'merge-op-status' },
        MERGE_STATUS_LABELS[op.status] ?? String(op.status)))
      row.appendChild(el('span', { className: 'merge-op-path' }, op.label))
      list.appendChild(row)
    }
    preview.appendChild(list)
    panel.appendChild(preview)
  }

  _renderSyncPanel() {
    const root = this._dom.root
    if (!root) return

    const existingPanel = root.querySelector('.sync-panel')
    if (existingPanel) existingPanel.remove()

    if (!this._syncMode) return

    const panel = document.createElement('div')
    panel.className = 'sync-panel'
    // Update and Mirror are separate controls rather than six directions
    // because the destructive half of the choice is the *action*, and burying
    // it in a direction label is how "sync left to right" came to silently
    // delete files.
    panel.innerHTML = `
      <div class="sync-options">
        <label><input type="radio" name="sync-dir" value="left-to-right" checked> 左側 → 右側</label>
        <label><input type="radio" name="sync-dir" value="right-to-left"> 右側 → 左側</label>
        <label><input type="radio" name="sync-dir" value="bidirectional"> 雙向（各取較新版本）</label>
      </div>
      <div class="sync-options sync-options--action">
        <label><input type="radio" name="sync-action" value="update" checked> 更新（只覆寫較舊的檔案，不刪除）</label>
        <label><input type="radio" name="sync-action" value="mirror"> 鏡像（讓目的地完全一致，會刪除多餘檔案）</label>
      </div>
      <div class="sync-mode-note"></div>
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

    /** @type {HTMLInputElement[]} */
    const actionRadios = [...panel.querySelectorAll('input[name="sync-action"]')]
    const note = panel.querySelector('.sync-mode-note')
    const invalidatePreview = () => {
      panel.querySelector('#btn-sync-execute').disabled = true
      this._syncOps = []
      const existing = panel.querySelector('.sync-preview')
      if (existing) existing.remove()
      panel.classList.toggle('sync-panel--mirror', this._syncAction === 'mirror'
        && this._syncDirection !== 'bidirectional')
      if (note) note.textContent = syncModeLabel(this._syncDirection, this._syncAction)
    }

    // Radio change
    panel.querySelectorAll('input[name="sync-dir"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this._syncDirection = e.target.value
        // Mirroring in both directions has no meaning: each side would have to
        // become the other. The control says so instead of quietly ignoring it.
        const bidi = this._syncDirection === 'bidirectional'
        for (const r of actionRadios) {
          if (r.value !== 'mirror') continue
          r.disabled = bidi
          if (bidi && r.checked) {
            this._syncAction = 'update'
            const update = actionRadios.find((x) => x.value === 'update')
            if (update) update.checked = true
          }
        }
        invalidatePreview()
      })
    })

    for (const radio of actionRadios) {
      radio.addEventListener('change', () => {
        if (!radio.checked) return
        this._syncAction = radio.value === 'mirror' ? 'mirror' : 'update'
        invalidatePreview()
      })
    }
    invalidatePreview()

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

  /**
   * Build the copy/delete list for the current direction and action.
   *
   * Walks the whole loaded tree rather than the top level: an expanded folder's
   * files were invisible to the sync before, so a "mirror" that the preview
   * called complete left every subdirectory untouched.
   */
  async _buildSyncOps() {
    this._syncOps = buildSyncOps(flattenRows(this._rows ?? []), {
      direction: this._syncDirection,
      action: this._syncAction,
      destFor: (srcPath, targetSide) => this._buildDestPath(srcPath, targetSide),
    })
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
      // Mirror is the only path that deletes, and it deletes files the user
      // never selected — they are simply absent from the source. Naming the
      // count and the mode before the delete dialog makes that explicit; the
      // dialog itself only asks recycle-bin versus permanent.
      const target = this._syncDirection === 'right-to-left' ? '左' : '右'
      if (!confirm(
        `鏡像同步會刪除${target}側 ${deletes.length} 個來源沒有的檔案。\n\n`
        + `${syncModeLabel(this._syncDirection, this._syncAction)}\n\n`
        + '要繼續嗎？（下一步可選擇資源回收桶或永久刪除）')) {
        if (execBtn) execBtn.disabled = false
        return
      }
      // Same preferences as every other delete in this view: the recycle-bin
      // setting supplies the default, and with confirmations off the mirror
      // warning above is the only prompt.
      const defaults = this._deleteDefaults()
      deleteChoice = defaults.confirm
        ? await this._confirmDelete(deletes.map((op) => op.path),
          { permanent: defaults.permanent })
        : { ok: true, permanent: defaults.permanent }
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

  /**
   * BC's "Copy To…": copy the selected files into any folder, not just the
   * other side. The tree layout below the compared root is preserved, so
   * copying `src/a/b.js` lands at `<dest>/src/a/b.js`.
   *
   * @param {'left'|'right'} [source] which side's file to take; defaults to
   *   whichever side the row actually has, preferring the left.
   * @param {string} [destRoot] target folder; prompts when omitted
   * @returns {Promise<void>}
   */
  async copySelectedToFolder(source, destRoot) {
    return this._copyRowsToFolder(this._selectedRows(), source, destRoot)
  }

  /**
   * @param {CompareRow[]} rows
   * @param {'left'|'right'} [source]
   * @param {string} [destRoot]
   * @returns {Promise<void>}
   */
  async _copyRowsToFolder(rows, source, destRoot) {
    if (!this._requireWritable(source ? [source] : ['left', 'right'])) return
    if (!rows?.length) { alert('請先勾選要複製的項目'); return }

    let dest = destRoot
    if (!dest) {
      const picked = await window.electronAPI.openFolder()
      if (!picked) return
      dest = picked.path ?? picked
    }
    if (!dest) return

    const sep = dest.includes('\\') ? '\\' : '/'
    const base = dest.replace(/[\\/]+$/, '')

    /** @type {Array<{ src: string, dest: string, dir: string }>} */
    const jobs = []
    for (const row of rows) {
      const preferred = source ?? (row.left?.path ? 'left' : 'right')
      const entry = row[preferred] ?? row.left ?? row.right
      if (!entry?.path || entry.isDirectory) continue
      const rel = this._relativePathOf(row, preferred).replace(/^[\\/]+/, '')
      const target = base + sep + rel
      jobs.push({ src: entry.path, dest: target, dir: target.slice(0, target.length - row.name.length) })
    }
    if (!jobs.length) { alert('選取的項目中沒有可複製的檔案（目錄不參與）'); return }
    if (!confirm(`確定要複製 ${jobs.length} 個檔案到：\n${base}\n？`)) return

    let done = 0
    /** @type {Array<{ path: string, message: string }>} */
    const failures = []
    for (const job of jobs) {
      try {
        // The relative layout can name folders that do not exist under the
        // target yet; copyFile would fail with a bare ENOENT.
        const dir = job.dir.replace(/[\\/]+$/, '')
        if (dir && dir !== base) await window.electronAPI.mkdirFolder(dir)
        await window.electronAPI.copyFile(job.src, job.dest)
        done++
      } catch (err) {
        failures.push({ path: job.dest, message: errText(err) })
      }
    }
    const detail = failures.length
      ? '\n\n失敗：\n' + failures.map((f) => `• ${f.path}\n　${f.message}`).join('\n')
      : ''
    alert(`複製完成：${done} 項成功${failures.length ? `，${failures.length} 項失敗` : ''}${detail}`)
  }

  /**
   * BC's "Move To…": move the selected files into any folder.
   *
   * Distinct from {@link moveSelectedTo}, which swaps a file between the two
   * compared sides. This one takes a destination the comparison knows nothing
   * about, and like every move it reports the half-finished state — copied but
   * not deleted — rather than counting it as success.
   *
   * @param {'left'|'right'} [source]
   * @param {string} [destRoot]
   * @returns {Promise<void>}
   */
  async moveSelectedToFolder(source, destRoot) {
    return this._moveRowsToFolder(this._selectedRows(), source, destRoot)
  }

  /**
   * @param {CompareRow[]} rows
   * @param {'left'|'right'} [source]
   * @param {string} [destRoot]
   * @returns {Promise<void>}
   */
  async _moveRowsToFolder(rows, source, destRoot) {
    // The source side is written to as well as read: the file is deleted from
    // it once the copy lands.
    if (!this._requireWritable(source ? [source] : ['left', 'right'])) return
    if (!rows?.length) { alert('請先勾選要移動的項目'); return }

    let dest = destRoot
    if (!dest) {
      const picked = await window.electronAPI.openFolder()
      if (!picked) return
      dest = picked.path ?? picked
    }
    if (!dest) return

    const sep = dest.includes('\\') ? '\\' : '/'
    const base = dest.replace(/[\\/]+$/, '')

    /** @type {Array<{ src: string, dest: string, dir: string }>} */
    const jobs = []
    for (const row of rows) {
      const preferred = source ?? (row.left?.path ? 'left' : 'right')
      const entry = row[preferred] ?? row.left ?? row.right
      if (!entry?.path || entry.isDirectory) continue
      if (sourceKindOf(entry.path) !== 'fs') continue
      const rel = this._relativePathOf(row, preferred).replace(/^[\\/]+/, '')
      const target = base + sep + rel
      jobs.push({ src: entry.path, dest: target, dir: target.slice(0, target.length - row.name.length) })
    }
    if (!jobs.length) { alert('選取的項目中沒有可移動的檔案（目錄與虛擬來源不參與）'); return }
    if (!confirm(`確定要將 ${jobs.length} 個檔案移動到：\n${base}\n？\n成功後來源檔案會被刪除。`)) return

    /** @type {MoveResult[]} */
    const results = []
    /** @type {Array<{ path: string, message: string }>} */
    const mkdirFailures = []
    for (const job of jobs) {
      try {
        const dir = job.dir.replace(/[\\/]+$/, '')
        if (dir && dir !== base) await window.electronAPI.mkdirFolder(dir)
      } catch (err) {
        // Without the folder the move cannot even start, so it is reported as
        // a failure of that job rather than attempted and mis-blamed on rename.
        mkdirFailures.push({ path: job.dest, message: errText(err) })
        continue
      }
      results.push(await runMoveOne({ src: job.src, dest: job.dest }, window.electronAPI))
    }

    const detail = mkdirFailures.length
      ? '\n\n無法建立目的地資料夾（來源未動）：\n'
        + mkdirFailures.map((f) => `• ${f.path}\n　${f.message}`).join('\n')
      : ''
    alert(formatMoveSummary(results) + detail)
    this._selectedNames.clear()
    await this.refresh()
  }

  // ── Touch (timestamp sync) ──────────────────────────────────────────────────

  /**
   * BC's Touch: give one side's files the other side's modification time.
   *
   * Only matched pairs qualify — an orphan has nothing to copy a timestamp
   * from — and directories are skipped because the IPC works on files.
   *
   * @param {'left-to-right'|'right-to-left'} direction
   * @returns {Promise<void>}
   */
  async touchSelected(direction) {
    return this._touchRows(this._selectedRows(), direction)
  }

  /**
   * @param {CompareRow[]} rows
   * @param {'left-to-right'|'right-to-left'} direction
   * @returns {Promise<void>}
   */
  async _touchRows(rows, direction) {
    if (!window.electronAPI?.setMtime) {
      alert('此版本的主程序沒有提供設定修改時間的功能。')
      return
    }
    const from = direction === 'right-to-left' ? 'right' : 'left'
    const to = direction === 'right-to-left' ? 'left' : 'right'
    if (!this._requireWritable([to])) return

    /** @type {TouchJob[]} */
    const jobs = []
    for (const row of rows ?? []) {
      const src = row?.[from]
      const dst = row?.[to]
      if (!src?.path || !dst?.path) continue
      if (src.isDirectory || dst.isDirectory) continue
      // An unreadable timestamp cannot be applied; skipping beats sending a
      // value the main process would reject one call at a time.
      if (!src.mtime) continue
      jobs.push({ src: src.path, dest: dst.path, mtime: String(src.mtime) })
    }
    if (!jobs.length) {
      alert('沒有可同步時間的項目：需要兩側都存在的檔案，且來源要有可讀的修改時間。')
      return
    }

    const label = direction === 'right-to-left' ? '右 → 左' : '左 → 右'
    if (!confirm(`要把 ${jobs.length} 個檔案的修改時間套用到另一側嗎？（${label}）`)) return

    const outcome = await runTouch(jobs, window.electronAPI)
    alert(formatTouchSummary(outcome))
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
    // In flat mode a pair need not share a relative path — `a/x.js` can be
    // matched with `b/x.js` — so the file the user saw on the target side is
    // the destination. Deriving it from the source's relative path would write
    // a new file next to the one they meant to overwrite.
    const counterpart = row?.[target]
    if (counterpart?.path && !counterpart.isDirectory && sourceKindOf(counterpart.path) === 'fs') {
      return counterpart.path
    }
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

  /** 勾選所有孤兒（左右兩側） */
  selectOrphansBoth() {
    this._selectByStatus(['left-only', 'right-only'], 'both')
  }

  /**
   * BC's Edit ▸ Select All Files: every file in the loaded tree, and no folder.
   *
   * The toolbar's 全選 checkbox selects whatever rows are rendered, folders
   * included — which then have to be skipped one by one by every batch
   * operation, because copy, move and touch all work on files. This is the
   * selection those operations can actually act on.
   *
   * @returns {number} how many rows were selected
   */
  selectAllFiles() {
    this._selectedNames.clear()
    for (const row of flattenRows(this._rows ?? [])) {
      if (isDirRow(row)) continue
      const key = row.left?.path || row.right?.path
      if (key) this._selectedNames.add(key)
    }
    this._updateBatchButton()
    this._syncCheckboxesFromSelected()
    if (this._dom.cbSelectAll) this._dom.cbSelectAll.checked = false
    return this._selectedNames.size
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

  /**
   * Expand one directory and everything under it.
   *
   * Expand All is the wrong tool for reviewing a large project file by file:
   * it loads the whole tree to answer a question about one folder.
   *
   * @param {CompareRow} row
   * @param {number} depth the row's depth in the visible tree
   * @returns {Promise<number>} directories loaded
   */
  async expandNode(row, depth = 0) {
    if (!row || !isDirRow(row)) return 0
    const budget = { loaded: 0 }
    const ctrl = this._beginScan()
    const before = new Set(this._expanded)
    try {
      await this._expandSubtree([row], depth, budget, ctrl.signal)
    } finally {
      if (ctrl.signal.aborted) this._expanded = before
      this._endScan(ctrl)
    }
    if (budget.loaded >= MAX_EXPAND_ALL_DIRS) {
      this._setScanStatus(`展開節點：已達 ${MAX_EXPAND_ALL_DIRS} 個目錄上限，更深的層級未展開`)
    }
    this._rerenderPreservingScroll()
    return budget.loaded
  }

  /**
   * Collapse one directory and every directory under it.
   *
   * Children stay in the model, so the report, the statistics and a later
   * re-expansion all still see them.
   *
   * @param {CompareRow} row
   * @param {number} depth
   * @returns {number} keys removed
   */
  collapseNode(row, depth = 0) {
    if (!row || !isDirRow(row)) return 0
    let removed = 0
    /**
     * @param {CompareRow} node
     * @param {number} d
     */
    const walk = (node, d) => {
      if (this._expanded.delete(this._expandKey(d, node))) removed++
      for (const child of node.children ?? []) {
        if (isDirRow(child)) walk(child, d + 1)
      }
    }
    walk(row, depth)
    this._rerenderPreservingScroll()
    return removed
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
    if (this._crcTimer) {
      clearTimeout(this._crcTimer)
      this._crcTimer = 0
    }
    this._crcQueue = []
    if (this._ownerTimer) {
      clearTimeout(this._ownerTimer)
      this._ownerTimer = 0
    }
    this._ownerQueue = []
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

    // The merge class widens the header/row/path grids to three panes; every
    // track count lives in CSS so the three stay aligned by construction.
    const root = el('div', {
      className: `folder-compare${this._mergeMode ? ' folder-compare--merge' : ''}`,
    })

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

    // Colour legend and message log (both hidden by default)
    root.appendChild(this._buildLegendPanel())
    root.appendChild(this._buildLogPanel())

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
    ;Object.entries(FOLDER_MODE_LABELS).map(([value, label]) => ({ value, label }))
      .forEach(({ value, label }) => {
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

    // Per-side orphan switches. The 顯示孤兒 checkbox above drives both at
    // once, which cannot express BC's "left newer plus left orphans" — a
    // combination the preset list has no name for either.
    const btnLeftOrphan = el('button', {
      className: 'fc-btn-filter-toggle fc-btn-filter-toggle--active',
      title: '顯示僅左側存在的項目',
      'data-filter': 'left-orphan',
    }, '左孤兒')
    this._dom.btnLeftOrphan = btnLeftOrphan
    toolbar.appendChild(btnLeftOrphan)

    const btnRightOrphan = el('button', {
      className: 'fc-btn-filter-toggle fc-btn-filter-toggle--active',
      title: '顯示僅右側存在的項目',
      'data-filter': 'right-orphan',
    }, '右孤兒')
    this._dom.btnRightOrphan = btnRightOrphan
    toolbar.appendChild(btnRightOrphan)

    // BC's three folder-level display/comparison switches. Checkboxes rather
    // than another preset entry: each is orthogonal to the preset list and to
    // the other two.
    const cbFilesOnly = this._buildCheckbox('fc-files-only', '只比檔案', this._filesOnly)
    cbFilesOnly.title = '忽略資料夾結構差異：資料夾仍顯示（否則看不到底下的檔案），但不列入差異計數與差異導航'
    this._dom.cbFilesOnly = cbFilesOnly.querySelector('input')
    toolbar.appendChild(cbFilesOnly)

    const cbFlatMode = this._buildCheckbox('fc-flat-mode', '攤平', this._flatMode)
    cbFlatMode.title = '忽略資料夾結構：兩側所有檔案攤平成一層，只依檔名配對（會完整掃描兩側目錄樹）'
    this._dom.cbFlatMode = cbFlatMode.querySelector('input')
    toolbar.appendChild(cbFlatMode)

    const cbIgnoreUnimportant = this._buildCheckbox(
      'fc-ignore-unimportant', '忽略不重要', this._ignoreUnimportant)
    this._dom.cbIgnoreUnimportant = cbIgnoreUnimportant.querySelector('input')
    toolbar.appendChild(cbIgnoreUnimportant)

    const cbAlwaysFolders = this._buildCheckbox(
      'fc-always-folders', '一律顯示資料夾', this._alwaysShowFolders)
    cbAlwaysFolders.title = '篩選遮罩不套用於資料夾：被遮罩排除的資料夾仍然顯示，底下的檔案才進得去'
    this._dom.cbAlwaysFolders = cbAlwaysFolders.querySelector('input')
    toolbar.appendChild(cbAlwaysFolders)

    const cbSuppressFilters = this._buildCheckbox(
      'fc-suppress-filters', '暫停篩選', this._suppressFilters)
    cbSuppressFilters.title = '暫時停用所有名稱遮罩（保留輸入內容），再次取消勾選即恢復'
    this._dom.cbSuppressFilters = cbSuppressFilters.querySelector('input')
    toolbar.appendChild(cbSuppressFilters)

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

    const cbFilterRegex = this._buildCheckbox('fc-filter-regex', 'Regex', this._filterRegex)
    cbFilterRegex.title = '快速篩選改以正規表示式解讀（比對檔名與相對路徑，不分大小寫）'
    this._dom.cbFilterRegex = cbFilterRegex.querySelector('input')
    toolbar.appendChild(cbFilterRegex)

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

    // Three-way merge toggle.
    const btnMerge = el('button', {
      className: `fc-btn-merge${this._mergeMode ? ' fc-btn-merge--active' : ''}`,
      title: this._mergeMode ? '退出三向合併模式' : '三向資料夾合併（左／基準／右）',
    }, '⑃ 三向合併')
    this._dom.btnMerge = btnMerge
    toolbar.appendChild(btnMerge)

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

    // Compare To / Quick Compare. Grouped in their own dropdown rather than
    // added as two more bare buttons: the toolbar already carries fifteen.
    const compareWrap = el('div', { className: 'fc-select-wrap fc-compare-wrap' })
    const btnCompareMenu = el('button', {
      className: 'fc-btn-compare-menu',
      title: 'Compare To（換掉一側）與 Quick Compare（只用大小與時間重判）',
    }, '比對 ▾')
    this._dom.btnCompareMenu = btnCompareMenu
    // Its own classes, not the selection dropdown's: sharing `fc-select-menu`
    // would make every existing `.fc-select-menu` / `.fc-select-item` selector
    // — in tests and in the document click handler alike — ambiguous.
    const compareMenu = el('div', { className: 'fc-compare-menu', style: 'display:none' })
    for (const item of [
      { label: '保留左側，與其他資料夾比對…', action: 'compare-to-left' },
      { label: '保留右側，與其他資料夾比對…', action: 'compare-to-right' },
      { label: '快速比對選取（僅大小與時間）', action: 'quick-compare-selected' },
      { label: '快速比對全部（僅大小與時間）', action: 'quick-compare-all' },
      { label: '比對內容：選取（實際讀檔）', action: 'compare-contents-selected' },
      { label: '比對內容：全部（實際讀檔）', action: 'compare-contents-all' },
    ]) {
      compareMenu.appendChild(
        el('button', { className: 'fc-compare-item', 'data-action': item.action }, item.label))
    }
    this._dom.compareMenu = compareMenu
    compareWrap.append(btnCompareMenu, compareMenu)
    toolbar.appendChild(compareWrap)

    const btnRules = el('button', { className: 'fc-btn-rules', title: '比對規則（忽略選項）' }, '⚖ 規則')
    this._dom.btnRules = btnRules
    toolbar.appendChild(btnRules)

    const btnInfo = el('button', {
      className: 'fc-btn-info',
      title: '檔案資訊：兩側檔案數、總大小、各狀態計數與掃描耗時',
    }, 'ℹ 資訊')
    this._dom.btnInfo = btnInfo
    toolbar.appendChild(btnInfo)

    const btnLegend = el('button', {
      className: 'fc-btn-legend',
      title: '色彩圖例：每個顏色代表什麼狀態',
    }, '🎨 圖例')
    this._dom.btnLegend = btnLegend
    toolbar.appendChild(btnLegend)

    const btnLog = el('button', {
      className: 'fc-btn-log',
      title: '記錄：掃描與檔案操作的訊息（狀態列一閃即逝的那些）',
    }, '📜 記錄')
    this._dom.btnLog = btnLog
    toolbar.appendChild(btnLog)

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
      { label: '選取兩側孤兒', action: 'select-orphans-both' },
      { label: '選取全部檔案（不含資料夾）', action: 'select-all-files' },
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
      { label: '複製選取到其他資料夾…',      action: 'copy-to-folder' },
      { label: '移動選取到其他資料夾…',      action: 'move-to-folder' },
      { label: '同步時間戳（左 → 右）',      action: 'touch-to-right' },
      { label: '同步時間戳（右 → 左）',      action: 'touch-to-left' },
      { label: '快速比對選取（僅大小與時間）', action: 'quick-compare' },
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

    // Two tabs, as in BC: masks answer "which names", the other filters answer
    // "which sizes, dates and attributes". Mixing them into one row makes the
    // panel unreadable and hides the fact that they combine with AND.
    const tabs = el('div', { className: 'fc-filter-tabs' })
    for (const [id, label] of [['masks', '名稱遮罩'], ['other', '其他篩選']]) {
      tabs.appendChild(el('button', {
        className: 'fc-filter-tab',
        'data-tab': id,
      }, label))
    }
    this._dom.filterTabs = tabs
    panel.appendChild(tabs)

    const masks = el('div', { className: 'fc-filter-page fc-filter-page--masks' })
    this._dom.filterPageMasks = masks
    panel.appendChild(masks)

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
      masks.appendChild(wrap)
    }

    panel.appendChild(this._buildOtherFilterPage())

    const btnApply = el('button', { className: 'fc-filter-apply' }, '套用')
    const btnClear = el('button', { className: 'fc-filter-clear' }, '清除')
    this._dom.filterApply = btnApply
    this._dom.filterClear = btnClear
    panel.append(btnApply, btnClear)

    this._dom.filterPanel = panel
    this._selectFilterTab('masks')
    return panel
  }

  /**
   * BC's "Other Filters" tab: size range, modification date range and
   * attribute state.
   *
   * @returns {HTMLElement}
   */
  _buildOtherFilterPage() {
    const page = el('div', { className: 'fc-filter-page fc-filter-page--other' })
    this._dom.filterPageOther = page
    this._dom.otherFilterInputs = {}

    /** @type {Array<[keyof OtherFilters, string, string, string]>} */
    const textFields = [
      ['minSize', '最小大小', '例：100、64K、2.5M', '空白 = 不限。可用 K / M / G / T 後綴'],
      ['maxSize', '最大大小', '例：1M', '空白 = 不限。可用 K / M / G / T 後綴'],
    ]
    for (const [key, label, placeholder, title] of textFields) {
      const wrap = el('label', { className: 'fc-filter-field' })
      wrap.appendChild(el('span', { className: 'fc-filter-label' }, label))
      const input = el('input', {
        type: 'text', className: 'fc-other-input', 'data-other': key, placeholder, title,
      })
      input.value = this._otherFilters[key]
      this._dom.otherFilterInputs[key] = input
      wrap.appendChild(input)
      page.appendChild(wrap)
    }

    for (const [key, label] of [['modifiedAfter', '修改時間起'], ['modifiedBefore', '修改時間迄']]) {
      const wrap = el('label', { className: 'fc-filter-field' })
      wrap.appendChild(el('span', { className: 'fc-filter-label' }, label))
      const input = el('input', {
        type: 'date', className: 'fc-other-input', 'data-other': key, title: '空白 = 不限',
      })
      input.value = this._otherFilters[key]
      this._dom.otherFilterInputs[key] = input
      wrap.appendChild(input)
      page.appendChild(wrap)
    }

    /** @type {Array<[keyof OtherFilters, string, string]>} */
    const selects = [
      ['readOnly', '唯讀', '依唯讀屬性篩選'],
      ['hidden', '隱藏', '依隱藏屬性篩選；屬性未讀取時（未開啟屬性欄或屬性比對）不會有任何列符合'],
    ]
    for (const [key, label, title] of selects) {
      const wrap = el('label', { className: 'fc-filter-field', title })
      wrap.appendChild(el('span', { className: 'fc-filter-label' }, label))
      const select = el('select', { className: 'fc-filter-select', 'data-other': key })
      for (const [value, text] of [['any', '不限'], ['yes', '是'], ['no', '否']]) {
        const opt = el('option', { value }, text)
        if (value === this._otherFilters[key]) opt.setAttribute('selected', '')
        select.appendChild(opt)
      }
      select.value = this._otherFilters[key]
      this._dom.otherFilterInputs[key] = select
      wrap.appendChild(select)
      page.appendChild(wrap)
    }
    return page
  }

  /**
   * @param {'masks'|'other'} tab
   */
  _selectFilterTab(tab) {
    const { filterTabs, filterPageMasks, filterPageOther } = this._dom
    if (filterPageMasks) filterPageMasks.style.display = tab === 'masks' ? 'flex' : 'none'
    if (filterPageOther) filterPageOther.style.display = tab === 'other' ? 'flex' : 'none'
    for (const btn of filterTabs?.querySelectorAll('.fc-filter-tab') ?? []) {
      btn.classList.toggle('fc-filter-tab--active', btn.dataset.tab === tab)
    }
  }

  /** @returns {OtherFilters} */
  getOtherFilters() {
    return { ...this._otherFilters }
  }

  /**
   * @param {Partial<OtherFilters>} partial
   * @returns {OtherFilters}
   */
  setOtherFilters(partial) {
    this._otherFilters = normalizeOtherFilters({ ...this._otherFilters, ...(partial ?? {}) })
    this._syncOtherFilterControls()
    this._applyFilterAndRender()
    return this.getOtherFilters()
  }

  /** Push the other-filter values back onto the panel controls. */
  _syncOtherFilterControls() {
    for (const [key, input] of Object.entries(this._dom.otherFilterInputs ?? {})) {
      if (input) input.value = this._otherFilters[key]
    }
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

    // Same shape as the attributes criterion: an extra test applied on top of
    // whichever mode is selected, not a mode of its own.
    const cbVersion = el('input', { type: 'checkbox', className: 'fc-rules-cb fc-compare-version' })
    cbVersion.checked = this._compareVersion
    const versionWrap = el('label', {
      className: 'fc-rules-toggle',
      title: '版本資源不同即視為差異（僅 exe/dll/sys 等有版本資源的格式；相同版本不代表內容相同，因此不會反過來判定為相同）',
    })
    versionWrap.appendChild(cbVersion)
    versionWrap.appendChild(document.createTextNode(' 比對版本'))
    this._dom.cbCompareVersion = cbVersion
    panel.appendChild(versionWrap)

    // BC's timezone / DST tolerance. A select rather than a checkbox because
    // the two shifts differ in width: DST is always exactly one hour, a
    // timezone can be any whole hour up to a day apart.
    const timeShift = el('select', {
      className: 'fc-rules-time-shift',
      title: '跨檔案系統的時間戳位移：FAT 沒有時區資訊，日光節約時間切換前後會整整差一小時；'
        + '封存檔與遠端主機則可能差整個時區。與上方的「秒」容差獨立，'
        + '因為把秒容差放寬到一小時會連真正的編輯一起吃掉',
    })
    for (const [value, label] of [
      ['none', '時間位移：不容忍'],
      ['dst', '時間位移：忽略 1 小時（日光節約）'],
      ['timezone', '忽略整點時區位移'],
    ]) {
      const opt = el('option', { value }, label)
      if (value === this._timeShift) opt.setAttribute('selected', '')
      timeShift.appendChild(opt)
    }
    this._dom.rulesTimeShift = timeShift
    panel.appendChild(timeShift)

    // BC's filename case handling. `system` is the default because the answer
    // that matches the host filesystem is right far more often than either
    // absolute, but a cross-platform comparison needs to override it.
    const nameCase = el('select', {
      className: 'fc-rules-name-case',
      title: '檔名配對是否區分大小寫。「依平台」在 Windows/macOS 不分、在 Linux 區分',
    })
    for (const [value, label] of [
      ['system', '檔名大小寫：依平台'],
      ['insensitive', '檔名大小寫：不分（配對 README 與 readme）'],
      ['sensitive', '檔名大小寫：區分'],
    ]) {
      const opt = el('option', { value }, label)
      if (value === this._filenameCase) opt.setAttribute('selected', '')
      nameCase.appendChild(opt)
    }
    this._dom.rulesNameCase = nameCase
    panel.appendChild(nameCase)

    const cbNameCase = el('input', { type: 'checkbox', className: 'fc-rules-cb fc-compare-name-case' })
    cbNameCase.checked = this._compareFilenameCase
    const nameCaseWrap = el('label', {
      className: 'fc-rules-toggle',
      title: '大小寫不同的一對檔名視為差異；配對本身區分大小寫時此項無作用（那種情況下兩者本來就是孤兒）',
    })
    nameCaseWrap.appendChild(cbNameCase)
    nameCaseWrap.appendChild(document.createTextNode(' 大小寫算差異'))
    this._dom.cbCompareNameCase = cbNameCase
    panel.appendChild(nameCaseWrap)

    // BC's Filename Alignment.
    const alignInput = el('input', {
      type: 'text',
      className: 'fc-rules-align',
      placeholder: '檔名對齊規則（如 *.bak.txt=*.txt；分號分隔）',
      title: '把不同檔名的兩個檔案放到同一列。每條寫成 from=to，兩側各剛好一個 *；'
        + '只套用於檔案，不會合併資料夾',
    })
    alignInput.value = this._alignRulesText
    this._dom.rulesAlign = alignInput
    panel.appendChild(alignInput)

    const btnArchives = el('button', {
      className: 'fc-rules-archives',
      title: '封存檔比對條件：是否展開為資料夾、哪些副檔名算封存檔、是否以內容清單判定差異',
    }, '封存檔…')
    this._dom.btnArchiveOptions = btnArchives
    panel.appendChild(btnArchives)

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
    if (this._dom.rulesTimeShift) this._dom.rulesTimeShift.value = this._timeShift
    if (this._dom.rulesNameCase) this._dom.rulesNameCase.value = this._filenameCase
    if (this._dom.cbCompareNameCase) {
      this._dom.cbCompareNameCase.checked = this._compareFilenameCase
    }
    if (this._dom.rulesAlign) this._dom.rulesAlign.value = this._alignRulesText
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
    const versionBefore = this._compareVersion
    this._compareAttributes = !!this._dom.cbCompareAttrs?.checked
    this._compareVersion = !!this._dom.cbCompareVersion?.checked

    // Pairing and timestamp criteria. A malformed alignment rule is surfaced
    // rather than dropped: a typo that silently stops aligning anything looks
    // exactly like the feature not working.
    let pairingChanged = this.setTimeShift(this._dom.rulesTimeShift?.value)
    pairingChanged = this.setFilenameCase(this._dom.rulesNameCase?.value) || pairingChanged
    pairingChanged = this.setCompareFilenameCase(this._dom.cbCompareNameCase?.checked)
      || pairingChanged
    const align = this.setAlignRules(this._dom.rulesAlign?.value ?? '')
    pairingChanged = align.changed || pairingChanged
    if (align.errors.length) {
      alert(`檔名對齊規則有 ${align.errors.length} 條無法解析，已略過：\n\n`
        + align.errors.map((e) => `• ${e}`).join('\n'))
    }

    this.setRulesOptions(next)
    const criteriaChanged = attrsBefore !== this._compareAttributes
      || versionBefore !== this._compareVersion
      || pairingChanged
    if (criteriaChanged && this._mode !== 'rules' && (this._leftPath || this._rightPath)) {
      void this._compareAndRender()
    }
  }

  /** 顯示 / 隱藏比對規則面板 */
  toggleRulesPanel() {
    const panel = this._dom.rulesPanel
    if (!panel) return
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'
  }

  /**
   * Colour legend. The row colours carry meaning that appears nowhere else on
   * screen, and "what does blue mean" has no other answer in the UI.
   *
   * @returns {HTMLElement}
   */
  _buildLegendPanel() {
    const panel = el('div', { className: 'fc-legend', style: 'display:none' })
    for (const [cls, label] of /** @type {Array<[string, string]>} */ ([
      ['same', '相同'],
      ['different', '不同（重要差異）'],
      ['unimportant', '不重要差異（規則或僅時間不同）'],
      ['left-only', '僅左側存在'],
      ['right-only', '僅右側存在'],
      ['left-newer', '左側較新'],
      ['right-newer', '右側較新'],
      ['conflict', '三向合併衝突'],
    ])) {
      const item = el('span', { className: 'fc-legend-item' })
      item.appendChild(el('span', { className: `fc-legend-dot fc-legend-dot--${cls}` }))
      item.appendChild(document.createTextNode(` ${label}`))
      panel.appendChild(item)
    }
    this._dom.legendPanel = panel
    return panel
  }

  /** @returns {boolean} the new state */
  toggleLegend() {
    this._legendVisible = !this._legendVisible
    const panel = this._dom.legendPanel
    if (panel) panel.style.display = this._legendVisible ? 'flex' : 'none'
    return this._legendVisible
  }

  /**
   * Message log. Scan errors are reported on the status line and then
   * overwritten by the next message, so the only record of "this folder could
   * not be read" used to last a few hundred milliseconds.
   *
   * @returns {HTMLElement}
   */
  _buildLogPanel() {
    const panel = el('div', { className: 'fc-log', style: 'display:none' })
    const lines = el('div', { className: 'fc-log-lines' })
    const btnClear = el('button', { className: 'fc-log-clear', title: '清空記錄' }, '清空')
    btnClear.addEventListener('click', () => this.clearLog())
    panel.append(lines, btnClear)
    this._dom.logPanel = panel
    this._dom.logLines = lines
    return panel
  }

  /** @returns {boolean} the new state */
  toggleLogPanel() {
    this._logVisible = !this._logVisible
    const panel = this._dom.logPanel
    if (panel) panel.style.display = this._logVisible ? 'flex' : 'none'
    if (this._logVisible) this._renderLogPanel()
    return this._logVisible
  }

  _renderLogPanel() {
    const lines = this._dom.logLines
    if (!lines) return
    lines.textContent = ''
    for (const text of this._log) {
      lines.appendChild(el('div', { className: 'fc-log-line' }, text))
    }
    lines.scrollTop = lines.scrollHeight
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

    // Base (three-way merge only)
    let baseCell = null
    if (this._mergeMode) {
      baseCell = el('div', { className: 'fc-path-cell fc-path-cell--base' })
      const btnBase = el('button', {
        className: 'fc-open-btn fc-open-base', 'data-side': 'base',
        title: '共同祖先版本；三向判定「是誰改的」全靠它',
      }, '開啟基準資料夾…')
      const dispBase = el('span', { className: 'fc-path-display', 'data-side': 'base' },
        this._basePath ?? '（未選擇）')
      this._dom.btnOpenBase = btnBase
      this._dom.dispBase = dispBase
      baseCell.append(btnBase, dispBase)
    }

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
    if (baseCell) row.appendChild(baseCell)
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
    for (const side of this._sides()) {
      if (side !== 'left') header.appendChild(el('div', { className: 'fc-col-sep' }))
      const sideEl = el('div', { className: `fc-header-side fc-header-side--${side}` })
      sideEl.style.gridTemplateColumns = template
      for (const def of this._columnDefs()) {
        const sorted = this._sortKey === def.id
        const arrow = sorted ? (this._sortDir > 0 ? ' ▲' : ' ▼') : ''
        // The checksum column names its algorithm in the heading. A value the
        // user means to check against unzip's CRC has to say whether that is
        // what it is.
        const label = def.id === 'crc'
          ? (this._checksumAlgo === 'crc32' ? 'CRC-32' : 'MD5')
          : def.label
        sideEl.appendChild(el('div', {
          className: `fc-col fc-col-${def.id}${sorted ? ' fc-col--sorted' : ''}`,
          'data-column': def.id,
          title: `依「${label}」排序`,
        }, label + arrow))
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
    /** @type {Array<object>} */
    const items = FOLDER_COLUMN_DEFS.map((def) => ({
      label: `${this._columns.includes(def.id) ? '✓ ' : '　 '}${def.label}`,
      disabled: !!def.locked,
      action: () => this.toggleColumn(def.id),
    }))
    // Offered here rather than in a settings page: this is where the column is
    // turned on, so it is where someone is deciding what they want from it.
    items.push({ separator: true })
    for (const algo of FolderCompare.checksumAlgorithms) {
      items.push({
        label: `${this._checksumAlgo === algo.id ? '✓ ' : '　 '}檢查碼：${algo.label}`,
        action: () => this.setChecksumAlgorithm(algo.id),
      })
    }
    showContextMenu(e, items)
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
    this._dom.btnMerge?.addEventListener('click', () => void this.toggleMergeMode())
    this._dom.btnOpenBase?.addEventListener('click', () => void this.openBase())

    // T55: Left Newer / Right Newer toggles. Each of the four below is one of
    // BC's independent View switches, so flipping one re-labels the preset
    // dropdown rather than leaving it claiming a preset that no longer holds.
    /** @param {'_showLeftNewer'|'_showRightNewer'|'_showLeftOnly'|'_showRightOnly'} flag */
    const bindFilterToggle = (btn, flag) => {
      btn?.addEventListener('click', () => {
        this[flag] = !this[flag]
        btn.classList.toggle('fc-btn-filter-toggle--active', this[flag])
        this._markPresetCustom()
        this._syncFilterControls()
        this._applyFilterAndRender()
      })
    }
    bindFilterToggle(btnLeftNewer, '_showLeftNewer')
    bindFilterToggle(btnRightNewer, '_showRightNewer')
    bindFilterToggle(this._dom.btnLeftOrphan, '_showLeftOnly')
    bindFilterToggle(this._dom.btnRightOrphan, '_showRightOnly')

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
    this._dom.btnArchiveOptions?.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.openArchiveOptionsDialog()
    })

    this._dom.cbFilesOnly?.addEventListener('change', () => {
      this.setFilesOnly(!!this._dom.cbFilesOnly.checked)
    })
    this._dom.cbFlatMode?.addEventListener('change', () => {
      void this.setFlatMode(!!this._dom.cbFlatMode.checked)
    })
    this._dom.cbIgnoreUnimportant?.addEventListener('change', () => {
      this.setIgnoreUnimportant(!!this._dom.cbIgnoreUnimportant.checked)
    })
    this._dom.cbAlwaysFolders?.addEventListener('change', () => {
      this.setAlwaysShowFolders(!!this._dom.cbAlwaysFolders.checked)
    })
    this._dom.cbSuppressFilters?.addEventListener('change', () => {
      this.setSuppressFilters(!!this._dom.cbSuppressFilters.checked)
    })
    this._dom.cbFilterRegex?.addEventListener('change', () => {
      this.setFilterRegex(!!this._dom.cbFilterRegex.checked)
    })
    this._dom.btnLegend?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleLegend()
    })
    this._dom.btnLog?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleLogPanel()
    })
    this._dom.filterTabs?.addEventListener('click', (e) => {
      const btn = e.target.closest('.fc-filter-tab')
      if (btn) this._selectFilterTab(btn.dataset.tab === 'other' ? 'other' : 'masks')
    })
    this._dom.btnSettings?.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.openSettingsDialog()
    })
    this._dom.btnCancel?.addEventListener('click', () => this.cancelScan())
    this._dom.btnInfo?.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.openInfoDialog()
    })

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
      else if (action === 'select-orphans-both') this.selectOrphansBoth()
      else if (action === 'select-all-files')    this.selectAllFiles()
      else if (action === 'invert-selection')    this.invertSelection()
    })

    this._dom.btnCompareMenu?.addEventListener('click', (e) => {
      e.stopPropagation()
      const menu = this._dom.compareMenu
      if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none'
    })

    this._dom.compareMenu?.addEventListener('click', (e) => {
      const btn = e.target.closest('.fc-compare-item')
      if (!btn) return
      this._dom.compareMenu.style.display = 'none'
      const action = btn.dataset.action
      if (action === 'compare-to-left') void this.compareTo('left')
      else if (action === 'compare-to-right') void this.compareTo('right')
      else if (action === 'quick-compare-selected') this.quickCompareSelected()
      else if (action === 'quick-compare-all') this.quickCompareAll()
      else if (action === 'compare-contents-selected') void this.compareContentsSelected()
      else if (action === 'compare-contents-all') void this.compareContentsAll()
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
      else if (action === 'copy-to-folder') await this.copySelectedToFolder()
      else if (action === 'move-to-folder') await this.moveSelectedToFolder()
      else if (action === 'touch-to-right') await this.touchSelected('left-to-right')
      else if (action === 'touch-to-left') await this.touchSelected('right-to-left')
      else if (action === 'quick-compare') this.quickCompareSelected()
    })

    // S14-M02: store handler refs so destroy() can remove them.
    this._onDocumentClick = () => {
      if (batchMenu) batchMenu.style.display = 'none'
      if (selectMenu) selectMenu.style.display = 'none'
      if (this._dom.compareMenu) this._dom.compareMenu.style.display = 'none'
    }
    document.addEventListener('click', this._onDocumentClick)

    modeSelect.addEventListener('change', () => {
      this._mode = modeSelect.value
      // What "不重要" means changed with the mode, and so may whether the
      // switch can be honoured at all.
      this._syncViewModeControls()
      this._compareAndRender()
    })

    viewPreset?.addEventListener('change', () => {
      // "自訂組合" is a read-out, not a command: picking it means "leave the
      // switches alone", so the dropdown is put back where the flags say.
      if (viewPreset.value === CUSTOM_VIEW_PRESET) { this._syncFilterControls(); return }
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
      // Drives both per-side switches, which have to follow it on screen.
      this._syncFilterControls()
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
    if (!this._leftPath && !this._rightPath && !(this._mergeMode && this._basePath)) {
      this._rows = []
      this._renderList()
      return
    }

    // A rescan is exactly when the working copy may have moved on, so the
    // status table is dropped rather than reused. Owner and version caches are
    // keyed by path and stay valid, so they survive.
    this._vcsAsked.clear()
    this._vcsRepos.clear()
    this._vcsUnavailable = ''
    this._vcsLoaded = false
    this._vcsPending = null

    this._renderLoading()
    const ctrl = this._beginScan()

    if (this._mergeMode) {
      try {
        await this._scanMerge(ctrl.signal)
      } catch (err) {
        console.error('FolderCompare._scanMerge error:', err)
        this._renderError(err.message)
      } finally {
        this._endScan(ctrl)
      }
      return
    }

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

    // BC's "Expand all folders when opening a session". Reuses expandAll, so
    // the children are really loaded into the model and `_expanded` is filled
    // in — a flag set on the DOM would be discarded by the next virtual-list
    // repaint, and the rows are virtualised.
    //
    // Deliberately after `_endScan`: expandAll opens its own scan generation,
    // which would abort the one that just produced these rows.
    if (!ctrl.signal.aborted && _settings.getPref('folderExpandOnOpen') === true) {
      await this.expandAll()
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

    try {
      // 先以 'both'（名稱+大小+時間）做初步比對；content / rules 模式再進一步確認
      this._rows = this._flatMode
        ? await this._buildFlatRows(sig)
        : compareEntries(this._leftEntries, this._rightEntries,
          this._baseMode(), this._mtimeTolerance, this._compareOpts())
      this._markArchiveContainers(this._rows)
      await this._applyDeepCompare(this._rows, sig)
    } finally {
      if (owned) this._endScan(owned)
    }

    this._applyFilterAndRender()
  }

  /**
   * Scan all three roots and grade the tree.
   * @param {AbortSignal} [signal]
   */
  async _scanMerge(signal) {
    this._selectedNames.clear()
    this._updateBatchButton()
    if (this._dom.cbSelectAll) this._dom.cbSelectAll.checked = false

    const [leftEntries, baseEntries, rightEntries] = await Promise.all([
      this._leftPath  ? this._listDir('left',  this._leftPath)  : Promise.resolve([]),
      this._basePath  ? this._listDir('base',  this._basePath)  : Promise.resolve([]),
      this._rightPath ? this._listDir('right', this._rightPath) : Promise.resolve([]),
    ])
    if (signal?.aborted) { this._renderList(); return }

    this._leftEntries = leftEntries
    this._baseEntries = baseEntries
    this._rightEntries = rightEntries
    this._tickProgress(leftEntries.length + baseEntries.length + rightEntries.length)
    this._expanded.clear()
    // A plan built against the previous tree names files that may no longer be
    // in that state.
    this._mergeOps = []
    this._currentConflictIdx = -1

    this._rows = buildMergeRows(baseEntries, leftEntries, rightEntries, this._compareOpts())
    await this._gradeMerge(this._rows, signal)
    if (signal?.aborted) { this._renderList(); return }

    this._applyFilterAndRender()
    this._renderMergePanel()
    this._emit('paths-changed', {
      left: this._leftPath, base: this._basePath, right: this._rightPath,
    })
  }

  /**
   * Decide every row of a three-way level.
   *
   * The three pairwise verdicts come from the *same* pipeline a two-way
   * comparison uses — `computeStatus` for metadata, then `_applyDeepCompare`
   * for MD5 or the rules engine — by handing it three synthetic pair lists
   * that share the very same FileEntry objects. Writing a second content
   * comparator for merge would be a second thing to keep in step with the
   * mode picker, the tolerances and the alignment rules.
   *
   * @param {MergeRow[]} rows
   * @param {AbortSignal} [signal]
   */
  async _gradeMerge(rows, signal) {
    const files = [...eachRow(rows ?? [])].filter(
      (row) => !(row.base?.isDirectory || row.left?.isDirectory || row.right?.isDirectory))
    const mode = this._baseMode()
    const opts = this._compareOpts()

    /**
     * @param {'left'|'base'|'right'} a
     * @param {'left'|'base'|'right'} b
     */
    const pairsOf = (a, b) => files
      .filter((row) => row[a] && row[b])
      .map((row) => ({
        name: row.name,
        left: row[a],
        right: row[b],
        status: computeStatus(row[a], row[b], mode, this._mtimeTolerance, opts),
        children: null,
      }))

    const lb = pairsOf('left', 'base')
    const rb = pairsOf('right', 'base')
    const lr = pairsOf('left', 'right')
    for (const list of [lb, rb, lr]) {
      if (!list.length) continue
      await this._applyDeepCompare(list, signal)
      if (signal?.aborted) return
    }

    // `\u0000` cannot occur in a path on any platform this runs on, so it is
    // the one separator that cannot make two different pairs collide.
    /** @type {Map<string, {status: string, unimportant: boolean}>} */
    const verdicts = new Map()
    const keyOf = (a, b) => `${a?.path ?? ''}\u0000${b?.path ?? ''}`
    for (const pair of [...lb, ...rb, ...lr]) {
      verdicts.set(keyOf(pair.left, pair.right),
        { status: pair.status, unimportant: !!pair.unimportant })
    }
    const verdictOf = (a, b) => verdicts.get(keyOf(a, b)) ?? verdicts.get(keyOf(b, a)) ?? null

    gradeMergeRows(rows ?? [], (a, b) => verdictOf(a, b)?.status === 'same')

    // The two-way status keeps every existing filter, sorter, report and
    // statistic working; the merge verdict rides alongside rather than
    // replacing it.
    for (const row of eachRow(rows ?? [])) {
      const both = !!(row.left && row.right)
      const pair = both ? verdictOf(row.left, row.right) : null
      row.status = both
        ? (pair?.status ?? 'different')
        : row.left ? 'left-only'
          : row.right ? 'right-only'
            // Present only in the base: both sides agreed to delete it. There
            // is no left/right disagreement to report, so it counts as "same".
            : 'same'
      row.unimportant = !!pair?.unimportant
    }
    this._refreshRollups()
  }

  /**
   * Load one directory row's children on all three sides.
   * @param {MergeRow} row
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async _loadMergeChildren(row, signal) {
    if (row.children) return
    /** @param {'left'|'base'|'right'} side */
    const listing = (side) => (row[side]?.isDirectory
      ? this._listDir(side, row[side].path)
      : Promise.resolve([]))
    const [left, base, right] = await Promise.all([
      listing('left'), listing('base'), listing('right'),
    ])
    if (signal?.aborted) return
    row.children = buildMergeRows(base, left, right, this._compareOpts())
    this._tickProgress(row.children.length)
    await this._gradeMerge(row.children, signal)
    if (signal?.aborted) { row.children = null; return }
    this._refreshRollups()
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
    // Under 'both' the only thing that can make a pair "newer" is its
    // timestamp — the sizes matched — which is exactly what the master switch
    // offers to ignore. Graded first so archive and version verdicts, which
    // are real content differences, can still overwrite it.
    if (this._mode === 'both') markTimestampOnlyUnimportant(rows)
    if (this._mode === 'content' && window.electronAPI?.hashFile) {
      await this._applyContentHash(rows, signal)
    } else if (this._mode === 'rules') {
      await this._applyRulesCompare(rows, signal)
    }
    // Both of these are extra criteria rather than modes, so they run after
    // whichever mode was chosen and may only tighten its verdict.
    if (this._archiveOptions.compareContents) await this._applyArchiveCompare(rows, signal)
    if (this._compareVersion) await this._applyVersionCompare(rows, signal)
  }

  /**
   * Walk both trees in full and pair every file by base name.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<CompareRow[]>}
   */
  async _buildFlatRows(signal) {
    const budget = { loaded: 0 }
    const [left, right] = await Promise.all([
      this._leftPath ? this._collectFiles('left', this._leftPath, budget, signal) : Promise.resolve([]),
      this._rightPath ? this._collectFiles('right', this._rightPath, budget, signal) : Promise.resolve([]),
    ])
    if (budget.loaded >= MAX_EXPAND_ALL_DIRS) {
      this._setScanStatus(`攤平比對：已達 ${MAX_EXPAND_ALL_DIRS} 個目錄上限，更深的層級未列入`)
    }
    return pairFlatEntries(
      left, right, this._baseMode(), this._mtimeTolerance, this._compareOpts())
  }

  /**
   * Every file under one side, recursively.
   *
   * Shares {@link MAX_EXPAND_ALL_DIRS} with Expand All: flat mode is the other
   * operation that reads directories the user never asked for by name, and an
   * unbounded walk is the same failure in both.
   *
   * @param {'left'|'right'} side
   * @param {string} root
   * @param {{ loaded: number }} budget
   * @param {AbortSignal} [signal]
   * @returns {Promise<FileEntry[]>}
   */
  async _collectFiles(side, root, budget, signal) {
    /** @type {FileEntry[]} */
    const out = []
    /** @type {string[]} */
    const queue = [root]
    while (queue.length) {
      if (signal?.aborted) break
      if (budget.loaded >= MAX_EXPAND_ALL_DIRS) break
      const dir = queue.shift()
      budget.loaded++
      let entries = []
      try {
        entries = await this._listDir(side, dir)
      } catch (err) {
        // One unreadable directory must not sink the whole flat comparison,
        // but it must not vanish either.
        console.error('FolderCompare: flat scan could not read', dir, err)
        this._setScanStatus(`攤平比對：無法讀取「${dir}」（${errText(err)}）`)
        continue
      }
      for (const entry of entries ?? []) {
        if (entry.isDirectory) queue.push(entry.path)
        else out.push(entry)
      }
      this._tickProgress(entries?.length ?? 0)
    }
    return out
  }

  /**
   * Flag archive files as expandable containers, so the tree offers their
   * entries the way it offers a directory's.
   *
   * @param {CompareRow[]} rows
   */
  _markArchiveContainers(rows) {
    const { expand, extensions } = this._archiveOptions
    for (const row of rows ?? []) {
      if (row.left?.isDirectory || row.right?.isDirectory) continue
      const isArchive = expand
        && (isArchiveName(row.left?.name ?? '', extensions)
          || isArchiveName(row.right?.name ?? '', extensions))
      // Written unconditionally so turning the option back off clears the flag
      // instead of leaving stale containers behind.
      row.container = !!isArchive
      if (!isArchive) continue
      if (!row.children) row.children = null
    }
  }

  /**
   * Grade archive pairs by their entry lists rather than by the container's
   * own bytes.
   *
   * @param {CompareRow[]} rows
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async _applyArchiveCompare(rows, signal) {
    const { extensions } = this._archiveOptions
    const candidates = [...eachRow(rows ?? [])].filter((row) =>
      row.left?.path && row.right?.path
      && !row.left.isDirectory && !row.right.isDirectory
      && sourceKindOf(row.left.path) === 'fs' && sourceKindOf(row.right.path) === 'fs'
      && isArchiveName(row.left.name, extensions) && isArchiveName(row.right.name, extensions))
    if (!candidates.length) return

    for (const row of candidates) {
      if (signal?.aborted) return
      const [left, right] = await Promise.all([
        this._archiveEntriesOf(row.left.path),
        this._archiveEntriesOf(row.right.path),
      ])
      if (signal?.aborted) return
      // A read failure leaves the metadata verdict alone; _archiveEntriesOf has
      // already reported it on the status line.
      if (!left || !right) continue
      row.status = classifyArchivePair(left, right)
      row.unimportant = false
      this._tickProgress()
    }
  }

  /**
   * Entries of one archive, cached by path.
   *
   * @param {string} path
   * @returns {Promise<FileEntry[]|null>} null when the archive could not be read
   */
  async _archiveEntriesOf(path) {
    const cached = this._archiveEntryCache.get(path)
    if (cached) return cached
    if (typeof window.electronAPI?.readArchive !== 'function') return null
    try {
      const listing = await window.electronAPI.readArchive(path)
      const raw = Array.isArray(listing) ? listing : (listing?.entries ?? [])
      // `open-zip` hands back tree-shaped entries; `read-archive` hands back a
      // flat list whose parent directories still have to be synthesised.
      const entries = raw.length && raw[0]?.parentPath !== undefined
        ? raw.map((e) => ({ ...e, isArchiveEntry: true }))
        : archiveEntriesToFileEntries(path, raw)
      this._archiveEntryCache.set(path, entries)
      return entries
    } catch (err) {
      console.error('FolderCompare: could not read archive', path, err)
      this._setScanStatus(`無法讀取封存檔「${path}」：${errText(err)}`)
      return null
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

    await _runWithConcurrency(plan.text, rulesConcurrency(), async (row) => {
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
    await _runWithConcurrency(candidates, rulesConcurrency(), async (row) => {
      if (signal?.aborted) return
      try {
        const [lHash, rHash] = await Promise.all([
          window.electronAPI.hashFile(row.left.path),
          window.electronAPI.hashFile(row.right.path),
        ])
        if (signal?.aborted) return
        if (lHash && rHash && lHash === rHash) {
          // Identical bytes, yet the metadata pass called this pair a
          // difference: what differs is the timestamp (or an attribute), which
          // is precisely the "unimportant difference" the master switch hides.
          // Keeping the flag lets the row stay visible, in blue, while the
          // switch is off.
          row.status = 'same'
          row.unimportant = true
        }
        this._tickProgress()
      } catch {
        // 無法 hash 則維持原狀態
      }
    })
  }

  // ── Private: Filter ─────────────────────────────────────────────────────────

  /**
   * Whether directories group above files, from the stored preference.
   * Unset reads as on, matching DEFAULT_PREFS.
   * @returns {boolean}
   */
  _foldersFirst() {
    return _settings.getPref('folderShowFoldersFirst') !== false
  }

  _applyFilterAndRender() {
    this._visibleRows = flattenVisibleRows(this._rows, {
      isExpanded: (row, depth) => this._expanded.has(this._expandKey(depth, row)),
      isVisible: (row) => this._isRowVisible(row),
      // BC's "Show folders first" applies to every column and both
      // directions, so it is read here rather than baked into the comparator.
      sort: (rows) => sortRows(rows, this._sortKey, this._sortDir, this._foldersFirst()),
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
    if (this._mergeMode && this._showOnlyConflicts) {
      const isDir = isDirRow(row) || !!row.base?.isDirectory
      // A folder whose children have not been read yet cannot have rolled a
      // conflict up, so hiding it would hide the conflicts inside it.
      const unknown = isDir && !row.children
      if (!unknown && !isMergeConflict(row.mergeStatus)) return false
    }

    // Compare Files Only: a directory is scaffolding, not a result. Hiding one
    // because its own status is filtered out would take every file under it
    // off screen with it.
    // Always Show Folders makes every directory scaffolding, not just under
    // Compare Files Only.
    const structural = (this._filesOnly || this._alwaysShowFolders) && isDirRow(row)

    // With the switch on, an unimportant row is a "same" row for every purpose
    // below, whatever status the mode's criteria gave it.
    const asSame = this._ignoreUnimportant && !!row.unimportant

    if (asSame) {
      // The master switch says these are not differences, so they follow the
      // same rule "same" rows do.
      if (!structural && !this._showSame) return false
    } else if (row.unimportant && row.status === 'same') {
      // A rules-graded row with only unimportant differences sits between the
      // two buckets: it is "same" for counting, but hiding it while the user is
      // hunting for differences would lose the one hint that it changed at all.
      if (!structural && !this._showSame && !this._showDiff) return false
    } else if (!structural && !statusVisibleUnder(row.status, this._viewFlags)) {
      return false
    }

    // The "顯示差異" master toggle also suppresses the newer-on-one-side
    // statuses, which are differences too.
    if (!structural && !asSame && !this._showDiff
        && (row.status === 'left-newer' || row.status === 'right-newer')) {
      return false
    }

    // Suppress Filters keeps the typed masks intact but stops applying them.
    if (this._suppressFilters) return true

    const opts = {
      isDirectory: !!(row.left?.isDirectory || row.right?.isDirectory),
      relativePath: this._relativePathOf(row),
    }

    // Always Show Folders: the name masks are about files, and hiding a folder
    // by them hides everything under it too.
    if (this._alwaysShowFolders && opts.isDirectory) return true

    // Quick filter: one mask string over both files and folders.
    if (this._filterStr.trim() && !this._matchesQuickFilter(row.name, opts)) {
      return false
    }
    if (!matchesFolderFilters(row.name, this._filterFields, opts)) return false
    return matchesOtherFilters(row, this._otherFilters)
  }

  /**
   * The quick-filter box, as a BC mask or as a regular expression.
   *
   * An unusable regex reports itself on the status line and matches nothing
   * further — silently showing every row would look like the filter was
   * accepted and matched everything.
   *
   * @param {string} name
   * @param {{ isDirectory: boolean, relativePath: string }} opts
   * @returns {boolean}
   */
  _matchesQuickFilter(name, opts) {
    if (!this._filterRegex) return matchesFilter(name, this._filterStr, opts)
    if (this._quickRegexSource !== this._filterStr) {
      const { re, error } = compileQuickFilterRegex(this._filterStr)
      this._quickRegexSource = this._filterStr
      this._quickRegex = re
      this._quickRegexError = error
      if (error) this._setScanStatus(`Regex 篩選無效：${error}`)
    }
    if (!this._quickRegex) return false
    return this._quickRegex.test(name) || this._quickRegex.test(opts.relativePath ?? '')
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
    const over = overscanRows()
    const start = Math.max(0, Math.floor((list.scrollTop || 0) / ROW_HEIGHT) - over)
    const end = Math.min(flat.length - 1, start + Math.ceil(viewHeight / ROW_HEIGHT) + over * 2)

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
    if (this._mergeMode) { await this._loadMergeChildren(row, signal); return }
    const leftPath = row.left?.isDirectory ? row.left.path : null
    const rightPath = row.right?.isDirectory ? row.right.path : null
    if (!leftPath && !rightPath) {
      // An archive expands into its own entry list rather than into a
      // directory listing; every other file has nothing underneath it.
      if (row.container) { await this._loadArchiveChildren(row, signal); return }
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
    // Archives nested inside a subfolder have to become containers too, or the
    // option would only apply to the top level.
    this._markArchiveContainers(row.children)
    this._tickProgress(row.children.length)
    await this._applyDeepCompare(row.children, signal)
    if (signal?.aborted) { row.children = null; return }
    this._refreshRollups()
  }

  /**
   * Expand an archive row into the files it holds.
   *
   * Every entry is listed at one level under the archive, keyed by its path
   * inside the container, because an archive's own directory records are
   * optional and reconstructing a tree from them would show a shape that the
   * two archives need not share.
   *
   * @param {CompareRow} row
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async _loadArchiveChildren(row, signal) {
    const [left, right] = await Promise.all([
      row.left?.path ? this._archiveEntriesOf(row.left.path) : Promise.resolve([]),
      row.right?.path ? this._archiveEntriesOf(row.right.path) : Promise.resolve([]),
    ])
    if (signal?.aborted) return
    if (left === null || right === null) {
      // The read failed and said so; an empty child list would read as "this
      // archive is empty", which is a different and wrong claim.
      row.children = null
      return
    }
    /** @param {FileEntry[]} entries */
    const files = (entries) => entries
      .filter((e) => !e.isDirectory)
      .map((e) => ({ ...e, name: parseVirtualPath(e.path).entry || e.name }))
    row.children = pairFlatEntries(
      files(left), files(right), this._baseMode(), this._mtimeTolerance, this._compareOpts())
    this._tickProgress(row.children.length)
  }

  /** 由葉往根重算所有已載入目錄的狀態與「不重要差異」標記。 */
  _refreshRollups() {
    for (const row of this._rows ?? []) {
      // Merge verdicts roll up on their own rules: a folder is not "三方相同"
      // just because it exists on all three sides, and a folder one side
      // deleted stops being a clean deletion once a surviving child changed.
      if (this._mergeMode) row.mergeStatus = rollupMergeStatus(row)
      row.status = rollupStatus(row, { ignoreUnimportant: this._ignoreUnimportant })
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
    // Without the base path, two merge rows that exist only in the base would
    // share the key `depth:|` and collapse into one another.
    if (this._mergeMode) return `${depth}:${lp}|${row.base?.path ?? ''}|${rp}`
    return `${depth}:${lp}|${rp}`
  }

  /**
   * @param {CompareRow} row
   * @param {number} [depth]
   * @param {boolean} [expanded]
   */
  _buildRow(row, depth = 0, expanded = undefined) {
    const merge = this._mergeMode
    const isDir = !!(row.left?.isDirectory || row.right?.isDirectory
      || (merge && row.base?.isDirectory))

    const mergeStatus = merge ? String(row.mergeStatus ?? 'absent') : ''
    const rowEl = el('div', {
      className: `fc-row ${row.status}${isDir ? ' is-dir' : ''}`
        + `${row.unimportant ? ' fc-row--unimportant' : ''}`
        + (merge ? ` fc-merge-row fc-merge--${mergeStatus}` : '')
        + (merge && isMergeConflict(mergeStatus) ? ' fc-merge-row--conflict' : '')
        + (merge && row.mergeResolution ? ' fc-merge-row--resolved' : ''),
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
    const key = row.left?.path || row.right?.path || (merge ? row.base?.path : '')
    if (key && this._selectedNames.has(key)) cb.checked = true
    if (key && key === this._focusedKey) rowEl.classList.add('fc-row--focused')
    rowEl.appendChild(cb)

    const isExpanded = expanded ?? (isDir && this._expanded.has(this._expandKey(depth, row)))
    for (const side of this._sides()) {
      if (side !== 'left') rowEl.appendChild(el('div', { className: 'fc-row-sep' }))
      // In merge mode a pane is empty exactly when that side has no entry;
      // the two-way `status` cannot express "missing from the base".
      const isEmpty = merge ? !row[side] : row.status === (side === 'left' ? 'right-only' : 'left-only')
      rowEl.appendChild(this._buildCell(row[side], row, isDir, depth, isEmpty, side, isExpanded))
    }

    if (merge) {
      rowEl.dataset.mergeStatus = mergeStatus
      rowEl.dataset.mergeResolution = row.mergeResolution ?? ''
      rowEl.dataset.basePath = row.base?.path ?? ''
      rowEl.dataset.mergePick = effectiveMergePick(row) ?? ''
      rowEl.title = MERGE_STATUS_LABELS[mergeStatus] ?? mergeStatus
    }

    return rowEl
  }

  /**
   * @param {FileEntry|null} entry
   * @param {CompareRow} row
   * @param {boolean} isDir
   * @param {number} depth
   * @param {boolean} isEmpty - 孤兒側（對側沒有此檔案）
   * @param {'left'|'base'|'right'} side
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
      case 'created':
        // Virtual sources (archives, snapshots, remote listings) carry no
        // creation time; an empty cell says that, a fabricated one would not.
        return el('span', { className: 'fc-created' }, formatMtime(entry.ctime))
      case 'ext':
        return el('span', { className: 'fc-ext' }, isDir ? '' : extensionOf(entry.name))
      case 'relpath': {
        const rel = this._relativePathOf(row)
        return el('span', { className: 'fc-relpath', title: entry.path ?? rel }, rel)
      }
      case 'abspath':
        return el('span', {
          className: 'fc-abspath',
          title: entry.path ?? '',
        }, entry.path ?? '')
      case 'crc':
        return this._buildCrcCell(entry, isDir)
      case 'attrs':
        return el('span', {
          className: 'fc-attrs',
          title: entryAttrTitle(entry),
        }, entryAttrText(entry))
      case 'version':
        return this._buildVersionCell(entry, isDir)
      case 'vcs':
        return this._buildVcsCell(entry)
      case 'owner':
      case 'group':
        return this._buildOwnerCell(entry, def.id)
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
    // Hoisted out of the loop: one storage read, not one per row.
    const cap = prefetchCap(MAX_VERSION_PREFETCH)
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
        if (pending.length >= cap) { skipped++; continue }
        pending.push(entry)
      }
    }
    if (!pending.length) {
      if (skipped) this._setScanStatus(`版本排序：超過 ${cap} 個檔案，其餘未讀取`)
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

  // ── Checksum column ─────────────────────────────────────────────────────────

  /**
   * A checksum cell, filled from cache when possible and queued otherwise.
   *
   * Same discipline as {@link _buildVersionCell}, and for a stronger reason:
   * `hash-file` reads the whole file into the main process, so hashing every
   * row of a large tree would be far worse than an extra IPC. Only rows the
   * virtual scroller actually drew are ever queued, each path is asked once,
   * and files past {@link MAX_CRC_FILE_BYTES} are declined outright.
   *
   * @param {FileEntry} entry
   * @param {boolean} isDir
   * @returns {HTMLElement}
   */
  _buildCrcCell(entry, isDir) {
    const cell = el('span', { className: 'fc-crc' })
    if (isDir || !entry?.path) return cell

    if (entry.crc === undefined) {
      const cached = this._crcCache.get(entry.path)
      if (cached !== undefined) entry.crc = cached
    }
    if (entry.crc !== undefined) {
      cell.textContent = entry.crc
      const title = this._crcTitles.get(entry.path)
      if (title) cell.title = title
      return cell
    }

    // Archive, snapshot and remote entries have no path `hash-file` can open.
    if (sourceKindOf(entry.path) !== 'fs') {
      this._resolveCrc(entry, '', '此來源不支援檢查碼')
      cell.textContent = ''
      return cell
    }
    if ((entry.size ?? 0) > MAX_CRC_FILE_BYTES) {
      this._resolveCrc(entry, '—',
        `超過 ${Math.floor(MAX_CRC_FILE_BYTES / 1024 / 1024)} MB，未計算檢查碼`)
      cell.textContent = '—'
      cell.title = this._crcTitles.get(entry.path) ?? ''
      return cell
    }

    cell.classList.add('fc-crc--pending')
    cell.textContent = '…'
    cell.dataset.crcPath = entry.path
    this._queueCrc(entry)
    return cell
  }

  /** @param {FileEntry} entry */
  _queueCrc(entry) {
    if (this._crcInFlight.has(entry.path)) return
    if (this._crcQueue.some((job) => job.path === entry.path)) return
    this._crcQueue.push({ entry, path: entry.path })
    if (this._crcTimer) return
    this._crcTimer = setTimeout(() => {
      this._crcTimer = 0
      void this._drainCrcQueue()
    }, 0)
  }

  /**
   * The checksum algorithms the column can show.
   *
   * BC's column is a CRC-32; this one was backed by `hash-file`, which is MD5.
   * Both are useful — MD5 for "are these the same file", CRC-32 for checking a
   * value against what unzip or `7z l` prints — but only one of them is what
   * the word CRC means, and showing MD5 under that name gives a user a value
   * that will never match and no way to see why.
   *
   * @returns {ReadonlyArray<{id: 'crc32'|'md5', label: string}>}
   */
  static get checksumAlgorithms() {
    return Object.freeze([
      Object.freeze({ id: 'crc32', label: 'CRC-32' }),
      Object.freeze({ id: 'md5', label: 'MD5' }),
    ])
  }

  /** @returns {'crc32'|'md5'} */
  getChecksumAlgorithm() { return this._checksumAlgo }

  /**
   * @param {'crc32'|'md5'} algo
   * @returns {'crc32'|'md5'} the algorithm now in effect
   */
  setChecksumAlgorithm(algo) {
    if (algo !== 'crc32' && algo !== 'md5') return this._checksumAlgo
    if (algo === this._checksumAlgo) return this._checksumAlgo
    this._checksumAlgo = algo
    // Every cached value was produced by the other algorithm. Keeping them
    // would leave the column showing a mix of the two under one heading.
    this._crcCache.clear()
    this._crcTitles.clear()
    // eachRow, not flattenRows: the latter hands out shallow copies, so the
    // deletes would land on throwaway objects and the stale values would stay.
    for (const row of eachRow(this._rows ?? [])) {
      for (const entry of [row.left, row.right]) {
        if (entry) delete entry.crc
      }
    }
    // The heading carries the algorithm name, so it has to be rebuilt too.
    // Re-rendering rows alone left the column showing MD5 values under a
    // CRC-32 heading — the exact confusion this feature exists to remove.
    this._rebuildHeader()
    this._applyFilterAndRender()
    return this._checksumAlgo
  }

  /** @returns {boolean} whether the selected algorithm has an IPC behind it */
  _checksumAvailable() {
    return typeof (this._checksumAlgo === 'crc32'
      ? window.electronAPI?.crc32File
      : window.electronAPI?.hashFile) === 'function'
  }

  /**
   * Compute one file's checksum with the selected algorithm.
   * @param {string} path
   * @returns {Promise<{text: string, title: string}>}
   */
  async _checksumFor(path) {
    const useCrc = this._checksumAlgo === 'crc32'
    const call = useCrc ? window.electronAPI?.crc32File : window.electronAPI?.hashFile
    const name = useCrc ? 'CRC-32' : 'MD5'
    if (typeof call !== 'function') {
      return { text: '', title: `此環境沒有 ${name} IPC` }
    }
    try {
      const text = String(await call(path))
      return { text, title: `${name}：${text}` }
    } catch (err) {
      console.warn('FolderCompare: checksum failed:', path, err)
      return { text: '—', title: `無法計算${name}：${errText(err)}` }
    }
  }

  /** @returns {Promise<void>} */
  async _drainCrcQueue() {
    const jobs = this._crcQueue
    this._crcQueue = []
    if (!jobs.length || !this._checksumAvailable()) {
      for (const job of jobs) this._resolveCrc(job.entry, '', '此環境沒有檢查碼 IPC')
      return
    }
    for (const job of jobs) this._crcInFlight.add(job.path)
    await _runWithConcurrency(jobs, CRC_CONCURRENCY, async (job) => {
      // Informational column: a dialog per unreadable file would be worse than
      // the dash, but the reason still has to reach the user somewhere.
      const { text, title } = await this._checksumFor(job.path)
      this._crcInFlight.delete(job.path)
      this._resolveCrc(job.entry, text, title)
    })
  }

  /**
   * @param {FileEntry} entry
   * @param {string} text
   * @param {string} title
   */
  _resolveCrc(entry, text, title) {
    entry.crc = text
    this._crcCache.set(entry.path, text)
    if (title) this._crcTitles.set(entry.path, title)
    const vlist = this._dom.vlist
    if (!vlist) return
    for (const cell of vlist.querySelectorAll('.fc-crc--pending')) {
      if (cell.dataset.crcPath !== entry.path) continue
      cell.classList.remove('fc-crc--pending')
      cell.textContent = text
      if (title) cell.title = title
    }
  }

  /**
   * Read checksums for the rows in the filtered tree, so sorting on the column
   * has something to sort. Bounded exactly as the version prefetch is.
   *
   * @returns {Promise<void>}
   */
  async prefetchCrcForSort() {
    if (!this._checksumAvailable()) return
    /** @type {FileEntry[]} */
    const pending = []
    let skipped = 0
    // Hoisted out of the loop: one storage read, not one per row.
    const cap = prefetchCap(MAX_CRC_PREFETCH)
    for (const flat of this._visibleRows ?? []) {
      for (const entry of [flat.row.left, flat.row.right]) {
        if (!entry?.path || entry.isDirectory) continue
        if (entry.crc !== undefined) continue
        const cached = this._crcCache.get(entry.path)
        if (cached !== undefined) { entry.crc = cached; continue }
        if (sourceKindOf(entry.path) !== 'fs') { this._resolveCrc(entry, '', ''); continue }
        if ((entry.size ?? 0) > MAX_CRC_FILE_BYTES) { this._resolveCrc(entry, '—', ''); continue }
        if (pending.length >= cap) { skipped++; continue }
        pending.push(entry)
      }
    }
    if (!pending.length) {
      if (skipped) this._setScanStatus(`檢查碼排序：超過 ${cap} 個檔案，其餘未計算`)
      return
    }

    this._setScanStatus(`計算檢查碼… 0/${pending.length}`)
    let done = 0
    await _runWithConcurrency(pending, CRC_CONCURRENCY, async (entry) => {
      const { text, title } = await this._checksumFor(entry.path)
      this._resolveCrc(entry, text, title)
      done++
      if (done % 25 === 0) this._setScanStatus(`計算檢查碼… ${done}/${pending.length}`)
    })
    this._setScanStatus(skipped
      ? `檢查碼排序：僅計算前 ${pending.length} 個檔案，另有 ${skipped} 個未計算`
      : '')
  }

  // ── VCS column ──────────────────────────────────────────────────────────────

  /**
   * The base folders whose repository status is worth asking about.
   *
   * Archive, snapshot and remote paths have no working copy behind them, so
   * they are excluded here rather than being sent to git and refused there.
   *
   * @returns {string[]}
   */
  _vcsBaseFolders() {
    return [this._leftPath, this._rightPath, this._mergeMode ? this._basePath : null]
      .filter((p) => typeof p === 'string' && p && sourceKindOf(p) === 'fs')
  }

  /**
   * Read every base folder's repository status, once.
   *
   * Deliberately a single call per *base folder*, not per row and not per
   * directory: `git status` answers for the whole working copy, and the row
   * lookup is then a table read with no IPC in it at all.
   *
   * @param {boolean} [force] re-read even if the folders were already asked
   * @returns {Promise<void>}
   */
  async _ensureVcsStatus(force = false) {
    if (force) {
      this._vcsAsked.clear()
      this._vcsRepos.clear()
      this._vcsUnavailable = ''
      this._vcsLoaded = false
      this._vcsPending = null
    }
    if (this._vcsLoaded) return
    // Concurrent callers (several cells in one render pass, plus the context
    // menu) share the one in-flight read rather than each starting a git.
    if (this._vcsPending) return this._vcsPending

    const folders = this._vcsBaseFolders().filter((p) => !this._vcsAsked.has(p))
    if (!folders.length) {
      // No local base folder to ask about — settle the cells rather than
      // leaving them pending on a call that will never be made.
      this._vcsLoaded = true
      this._resolveVcsCells()
      return
    }
    if (typeof window.electronAPI?.vcsStatus !== 'function') {
      this._vcsUnavailable = '此版本未提供版本控制查詢。'
      for (const p of folders) this._vcsAsked.add(p)
      this._vcsLoaded = true
      this._resolveVcsCells()
      return
    }

    for (const p of folders) this._vcsAsked.add(p)
    const run = (async () => {
      for (const folder of folders) {
        let res = null
        try {
          res = await window.electronAPI.vcsStatus(folder)
        } catch (err) {
          // A failed status read is shown, not swallowed: the alternative is a
          // column of "乾淨" for a tree full of edits.
          this._vcsUnavailable = `版本控制狀態讀取失敗：${errText(err)}`
          this._setScanStatus(this._vcsUnavailable)
          continue
        }
        if (res?.available && res.root) {
          this._vcsRepos.set(res.root, {
            root: res.root, files: res.files ?? {}, dirs: res.dirs ?? {},
          })
          continue
        }
        // 'not-a-repo' is the ordinary case for any folder outside a working
        // copy and must stay silent; everything else is something the user has
        // to be told, or the empty column looks like "no changes".
        if (res?.reason && res.reason !== 'not-a-repo') {
          this._vcsUnavailable = res.message || '無法取得版本控制狀態。'
          this._setScanStatus(this._vcsUnavailable)
        }
      }
      this._vcsLoaded = true
      this._resolveVcsCells()
    })()
    this._vcsPending = run
    try {
      await run
    } finally {
      this._vcsPending = null
    }
  }

  /**
   * The state for one path across all loaded repositories.
   * @param {string} absPath
   * @returns {VcsState|null}
   */
  _vcsStateFor(absPath) {
    for (const repo of this._vcsRepos.values()) {
      const state = lookupVcsState(repo, absPath)
      if (state) return state
    }
    return null
  }

  /**
   * A VCS cell. Answered from the in-memory table when it is loaded, and left
   * pending otherwise — the one status read is kicked off here rather than at
   * scan time so a user who never shows the column never pays for it.
   *
   * @param {FileEntry} entry
   * @returns {HTMLElement}
   */
  _buildVcsCell(entry) {
    const cell = el('span', { className: 'fc-vcs' })
    if (!entry?.path) return cell

    if (sourceKindOf(entry.path) !== 'fs') {
      cell.textContent = '—'
      cell.title = '此來源（壓縮檔／快照／遠端）沒有本機工作區，無法判讀版本控制狀態。'
      return cell
    }

    if (!this._vcsLoaded) {
      void this._ensureVcsStatus()
      cell.classList.add('fc-vcs--pending')
      cell.dataset.vcsPath = entry.path
      cell.textContent = '…'
      return cell
    }

    const state = this._vcsStateFor(entry.path)
    if (!state) {
      cell.textContent = '—'
      cell.title = this._vcsUnavailable
        || '不在 git 工作區內（其他版本控制系統尚未支援）。'
      return cell
    }
    entry.vcsState = state
    cell.classList.add(`fc-vcs--${state}`)
    cell.textContent = VCS_STATE_BADGES[state] ?? state
    cell.title = VCS_STATE_TITLES[state] ?? ''
    return cell
  }

  /**
   * Patch the pending VCS cells in place once the status table arrives.
   *
   * Patching rather than re-rendering, for the same reason the version column
   * does it: a re-render would fight the virtual scroller for the frame, and
   * the only thing that changed is one span.
   */
  _resolveVcsCells() {
    const vlist = this._dom.vlist
    if (!vlist) return
    for (const cell of vlist.querySelectorAll('.fc-vcs--pending')) {
      const path = cell.dataset.vcsPath ?? ''
      cell.classList.remove('fc-vcs--pending')
      const state = path ? this._vcsStateFor(path) : null
      if (!state) {
        cell.textContent = '—'
        cell.title = this._vcsUnavailable
          || '不在 git 工作區內（其他版本控制系統尚未支援）。'
        continue
      }
      cell.classList.add(`fc-vcs--${state}`)
      cell.textContent = VCS_STATE_BADGES[state] ?? state
      cell.title = VCS_STATE_TITLES[state] ?? ''
    }
  }

  /**
   * The repository root that owns a path, or null.
   * @param {string} absPath
   * @returns {string|null}
   */
  _vcsRootFor(absPath) {
    for (const repo of this._vcsRepos.values()) {
      if (lookupVcsState(repo, absPath)) return repo.root
    }
    return null
  }

  /**
   * Run a source-control write over a set of absolute paths.
   *
   * Confirmed first, because `revert` destroys the working copy and `add`
   * changes what a later commit will contain. Reported per path afterwards,
   * because a batch can stop halfway.
   *
   * @param {'add'|'revert'|'unstage'} action
   * @param {string[]} paths already inside a known repository
   * @returns {Promise<void>}
   */
  async runVcsAction(action, paths) {
    const labels = { add: '加入索引（git add）', revert: '還原（git checkout --）', unstage: '取消暫存（git reset）' }
    const label = labels[action] ?? action
    const list = (paths ?? []).filter((p) => typeof p === 'string' && p)
    if (!list.length) { alert('沒有可執行版本控制操作的檔案'); return }
    if (typeof window.electronAPI?.vcsRun !== 'function') {
      alert('此版本未提供版本控制操作。')
      return
    }

    // The menu is offered before the probe lands, on purpose. That makes the
    // wait land here instead: _vcsRootFor reads an in-memory table, so acting
    // while `git status` is still running put every path in `outside` and told
    // the user their tracked files were not in a working copy.
    await this._ensureVcsStatus()

    // Grouped by repository: a selection can span the left and right base
    // folders, and each git call has to run inside the tree it belongs to.
    /** @type {Map<string, string[]>} */
    const byRoot = new Map()
    /** @type {string[]} */
    const outside = []
    for (const p of list) {
      const root = this._vcsRootFor(p)
      if (!root) { outside.push(p); continue }
      if (!byRoot.has(root)) byRoot.set(root, [])
      byRoot.get(root).push(p)
    }
    if (!byRoot.size) {
      alert(`選取的檔案都不在 git 工作區內，無法執行「${label}」。`)
      return
    }

    const inRepo = [...byRoot.values()].reduce((n, arr) => n + arr.length, 0)
    const warn = action === 'revert'
      ? '\n\n還原會丟棄工作區的變更，沒有復原按鈕。'
      : ''
    const skippedNote = outside.length ? `\n（另有 ${outside.length} 個檔案不在版本庫內，將略過）` : ''
    if (!confirm(`確定要對 ${inRepo} 個檔案執行「${label}」嗎？${skippedNote}${warn}`)) return

    /** @type {VcsOpResult[]} */
    const results = outside.map((path) => ({
      path, state: 'skipped', message: '不在任何已載入的 git 工作區內。',
    }))
    for (const [root, group] of byRoot) {
      try {
        const res = await window.electronAPI.vcsRun({ action, root, paths: group })
        results.push(...(res?.results ?? []))
      } catch (err) {
        const message = errText(err)
        for (const path of group) results.push({ path, state: 'failed', message })
      }
    }
    alert(formatVcsOpSummary(label, results))
    await this._ensureVcsStatus(true)
    await this.refresh()
  }

  /**
   * Show `git diff` or `git log` for one file.
   * @param {'diff'|'log'} action
   * @param {string} absPath
   * @returns {Promise<void>}
   */
  async showVcsText(action, absPath) {
    if (typeof window.electronAPI?.vcsText !== 'function') {
      alert('此版本未提供版本控制查詢。')
      return
    }
    // As in runVcsAction: the table may still be loading when the menu item is
    // clicked, and reading it early reports a tracked file as untracked.
    await this._ensureVcsStatus()
    const root = this._vcsRootFor(absPath)
    if (!root) { alert(`「${absPath}」不在 git 工作區內。`); return }
    const title = action === 'diff' ? `git diff — ${absPath}` : `git log — ${absPath}`
    try {
      const res = await window.electronAPI.vcsText({ action, root, path: absPath })
      const text = res?.truncated
        ? '（輸出過長，已中止顯示。請改用命令列查看。）'
        : (res?.text || '（沒有輸出：此檔案沒有相對於 HEAD 的變更，或尚未納入版本控制。）')
      this._showTextDialog(title, text)
    } catch (err) {
      alert(`${title} 失敗：${errText(err)}`)
    }
  }

  /**
   * A read-only scrolling text dialog, used by the Source Control queries.
   *
   * Reuses the attribute dialog's modal shell so Escape, the backdrop and the
   * styling behave the same way everywhere in this view.
   *
   * @param {string} title
   * @param {string} text
   * @returns {HTMLElement} the backdrop, so tests can read and dismiss it
   */
  _showTextDialog(title, text) {
    const host = this._dom.root ?? document.body
    const backdrop = el('div', { className: 'fc-modal-backdrop fc-text-backdrop' })
    const modal = el('div', { className: 'fc-modal fc-text-modal', role: 'dialog', 'aria-modal': 'true' })
    modal.appendChild(el('div', { className: 'fc-modal-title' }, title))
    modal.appendChild(el('pre', { className: 'fc-text-body' }, text))

    const actions = el('div', { className: 'fc-modal-actions' })
    const btnClose = el('button', { className: 'fc-modal-ok fc-text-close' }, '關閉')
    actions.appendChild(btnClose)
    modal.appendChild(actions)
    backdrop.appendChild(modal)
    host.appendChild(backdrop)

    const close = () => {
      backdrop.remove()
      document.removeEventListener('keydown', onKey, true)
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    btnClose.addEventListener('click', close)
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
    document.addEventListener('keydown', onKey, true)
    return backdrop
  }

  // ── Owner / Group columns ───────────────────────────────────────────────────

  /**
   * An owner or group cell, filled from cache when possible and queued
   * otherwise. Nothing here awaits: the row has to reach the DOM before the
   * scroller's next frame.
   *
   * @param {FileEntry} entry
   * @param {'owner'|'group'} field
   * @returns {HTMLElement}
   */
  _buildOwnerCell(entry, field) {
    const cell = el('span', { className: `fc-owner fc-${field}` })
    if (!entry?.path) return cell

    const cached = this._ownerCache.get(entry.path)
    if (cached) {
      entry.owner = cached.owner
      entry.group = cached.group
      cell.textContent = ownerCellText(cached[field])
      // The tooltip is where "why is this an em dash" is answered; without it
      // the blank looks like a bug rather than a permission or platform limit.
      cell.title = cached[field]
        ? cached[field]
        : (cached.error || '此來源未提供擁有者資訊。')
      return cell
    }

    if (sourceKindOf(entry.path) !== 'fs') {
      this._ownerCache.set(entry.path, {
        owner: '', group: '',
        error: '此來源（壓縮檔／快照／遠端）沒有本機擁有者資訊。',
      })
      cell.textContent = '—'
      cell.title = '此來源（壓縮檔／快照／遠端）沒有本機擁有者資訊。'
      return cell
    }

    cell.classList.add('fc-owner--pending')
    cell.dataset.ownerPath = entry.path
    cell.dataset.ownerField = field
    cell.textContent = '…'
    this._queueOwner(entry)
    return cell
  }

  /**
   * @param {FileEntry} entry
   */
  _queueOwner(entry) {
    if (this._ownerInFlight.has(entry.path)) return
    if (this._ownerQueue.some((job) => job.path === entry.path)) return
    this._ownerQueue.push({ entry, path: entry.path })
    if (this._ownerTimer) return
    // One drain per render pass, for the same reason the version column
    // coalesces: a wheel tick must not put a burst of IPC behind it.
    this._ownerTimer = setTimeout(() => {
      this._ownerTimer = 0
      void this._drainOwnerQueue()
    }, 0)
  }

  /**
   * @returns {Promise<void>}
   */
  async _drainOwnerQueue() {
    const jobs = this._ownerQueue
    this._ownerQueue = []
    if (!jobs.length) return
    if (typeof window.electronAPI?.fileOwners !== 'function') {
      for (const job of jobs) {
        this._resolveOwner(job.entry, { owner: '', group: '', error: '此版本未提供擁有者查詢。' })
      }
      return
    }

    for (const job of jobs) this._ownerInFlight.add(job.path)
    // Batched, not one call per row: the main process answers a whole batch
    // with one OS call on Windows and none at all on Unix.
    for (let i = 0; i < jobs.length; i += OWNER_BATCH_SIZE) {
      const slice = jobs.slice(i, i + OWNER_BATCH_SIZE)
      /** @type {Array<{ path: string, owner: string, group: string, error: string }>} */
      let infos = []
      try {
        infos = await window.electronAPI.fileOwners(slice.map((j) => j.path)) ?? []
      } catch (err) {
        const message = errText(err)
        console.warn('FolderCompare: owner lookup failed:', message)
        infos = slice.map((j) => ({ path: j.path, owner: '', group: '', error: message }))
      }
      const byPath = new Map(infos.map((info) => [info.path, info]))
      for (const job of slice) {
        this._ownerInFlight.delete(job.path)
        this._resolveOwner(job.entry, byPath.get(job.path)
          ?? { owner: '', group: '', error: '未取得擁有者資訊。' })
      }
    }
  }

  /**
   * @param {FileEntry} entry
   * @param {{ owner?: string, group?: string, error?: string }} info
   */
  _resolveOwner(entry, info) {
    const value = { owner: info.owner ?? '', group: info.group ?? '', error: info.error ?? '' }
    this._ownerCache.set(entry.path, value)
    entry.owner = value.owner
    entry.group = value.group
    const vlist = this._dom.vlist
    if (!vlist) return
    for (const cell of vlist.querySelectorAll('.fc-owner--pending')) {
      if (cell.dataset.ownerPath !== entry.path) continue
      const field = cell.dataset.ownerField === 'group' ? 'group' : 'owner'
      cell.classList.remove('fc-owner--pending')
      cell.textContent = ownerCellText(value[field])
      cell.title = value[field] || value.error || '此來源未提供擁有者資訊。'
    }
  }

  /**
   * Look owners up for the rows in the filtered tree, so sorting on the column
   * has something to sort.
   *
   * Bounded by {@link MAX_OWNER_PREFETCH} for the same reason the version and
   * checksum sorts are: a sort must not be the back door that turns a lazy
   * column into a full-tree walk.
   *
   * @returns {Promise<void>}
   */
  /**
   * Give every row a VCS sort key, not just the drawn ones.
   *
   * One `git status` covers the whole tree, so there is no per-row IPC to
   * bound here — but the lookup table is not the sort key. `columnSortValue`
   * reads `entry.vcsState`, and the only thing that ever wrote that field was
   * the cell builder, which runs for the virtual window alone. Sorting on the
   * column therefore ordered the handful of rows the user had scrolled past
   * and left every other row tied on '', which reads as "the sort did
   * nothing" on any tree bigger than the viewport.
   *
   * @returns {Promise<void>}
   */
  async prefetchVcsForSort() {
    await this._ensureVcsStatus()
    for (const flat of this._visibleRows ?? []) {
      for (const entry of [flat.row.left, flat.row.right]) {
        if (!entry?.path || sourceKindOf(entry.path) !== 'fs') continue
        const state = this._vcsStateFor(entry.path)
        if (state) entry.vcsState = state
      }
    }
  }

  async prefetchOwnersForSort() {
    if (typeof window.electronAPI?.fileOwners !== 'function') return
    /** @type {FileEntry[]} */
    const pending = []
    let skipped = 0
    // Hoisted out of the loop: one storage read, not one per row.
    const cap = prefetchCap(MAX_OWNER_PREFETCH)
    for (const flat of this._visibleRows ?? []) {
      for (const entry of [flat.row.left, flat.row.right]) {
        if (!entry?.path) continue
        const cached = this._ownerCache.get(entry.path)
        if (cached) { entry.owner = cached.owner; entry.group = cached.group; continue }
        if (sourceKindOf(entry.path) !== 'fs') continue
        if (pending.length >= cap) { skipped++; continue }
        pending.push(entry)
      }
    }
    if (!pending.length) {
      if (skipped) this._setScanStatus(`擁有者排序：超過 ${cap} 個檔案，其餘未查詢`)
      return
    }

    this._setScanStatus(`讀取擁有者… 0/${pending.length}`)
    for (let i = 0; i < pending.length; i += OWNER_BATCH_SIZE) {
      const slice = pending.slice(i, i + OWNER_BATCH_SIZE)
      let infos = []
      try {
        infos = await window.electronAPI.fileOwners(slice.map((e) => e.path)) ?? []
      } catch (err) {
        this._setScanStatus(`讀取擁有者失敗：${errText(err)}`)
        return
      }
      const byPath = new Map(infos.map((info) => [info.path, info]))
      for (const entry of slice) {
        this._resolveOwner(entry, byPath.get(entry.path)
          ?? { owner: '', group: '', error: '未取得擁有者資訊。' })
      }
      this._setScanStatus(`讀取擁有者… ${Math.min(i + OWNER_BATCH_SIZE, pending.length)}/${pending.length}`)
    }
    this._setScanStatus(skipped
      ? `擁有者排序：僅查詢前 ${pending.length} 個檔案，另有 ${skipped} 個未查詢`
      : '')
  }

  /**
   * The merge status bar. Different numbers from the two-way one: what matters
   * here is how much of the tree merges by itself and how much still needs a
   * decision.
   */
  _renderMergeStats() {
    const stats = this._dom.stats
    if (!stats) return
    const s = this.getMergeSummary()
    /** @type {Array<[string, string]>} */
    const order = [
      ['same', 'same'],
      ['left-changed', 'left-newer'],
      ['right-changed', 'right-newer'],
      ['both-changed-same', 'same'],
      ['left-added', 'left-only'],
      ['right-added', 'right-only'],
      ['both-added-same', 'same'],
      ['left-deleted', 'right-only'],
      ['right-deleted', 'left-only'],
      ['both-deleted', 'different'],
      ['conflict-changed', 'different'],
      ['conflict-added', 'different'],
      ['conflict-modify-delete', 'different'],
    ]
    for (const [key, dot] of order) {
      const count = s.counts[key]
      if (!count) continue
      const item = el('span', { className: 'fc-stat-item' })
      item.appendChild(el('span', { className: `fc-stat-dot ${dot}` }))
      item.appendChild(document.createTextNode(`${MERGE_STATUS_LABELS[key]}: ${count}`))
      stats.appendChild(item)
    }
    const tail = el('span', { className: 'fc-stat-item' },
      `衝突 ${s.conflicts}（未決 ${s.unresolved}）　共 ${s.files} 個檔案`
      + (s.partial ? '　※ 尚有未展開的目錄' : ''))
    tail.style.marginLeft = 'auto'
    stats.appendChild(tail)
    this._syncMergePanelStatus()
  }

  _renderStats(rows) {
    if (!this._dom.stats) return
    const stats = this._dom.stats
    stats.innerHTML = ''

    if (this._modeNote) {
      stats.appendChild(el('span', { className: 'fc-stat-item fc-stat-note' }, this._modeNote))
    }
    if (!rows.length) return

    if (this._mergeMode) { this._renderMergeStats(); return }

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
    this._setFocusedKey(rowEl.dataset.leftPath || rowEl.dataset.rightPath
      || rowEl.dataset.basePath || null)

    const isDir = rowEl.dataset.isDir === 'true'
    if (!isDir) return

    const depth = parseInt(rowEl.dataset.depth ?? '0', 10)
    const leftPath = rowEl.dataset.leftPath
    const rightPath = rowEl.dataset.rightPath
    const name = rowEl.dataset.name
    // The model row is the only thing that knows the base path, and a stub
    // rebuilt from the dataset would key a base-only folder as if it had none.
    const flat = this._flatEntryOf(rowEl)
    const expandKey = flat
      ? this._expandKey(flat.depth, flat.row)
      : this._expandKey(depth, {
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

    // ── 三向合併：這一列要用哪一份 ──
    if (this._mergeMode && modelRow) {
      const current = effectiveMergePick(modelRow)
      const auto = autoMergePick(modelRow.mergeStatus)
      items.push({
        label: `狀態：${MERGE_STATUS_LABELS[modelRow.mergeStatus] ?? modelRow.mergeStatus}`,
        disabled: true,
        action: () => {},
      })
      for (const [pick, label] of /** @type {Array<[MergePick, string]>} */ ([
        ['left', '採用左側'], ['base', '採用基準'], ['right', '採用右側'],
        ['delete', '不放入輸出（刪除）'], ['skip', '略過此列'],
      ])) {
        // Naming a side that has no file here would produce no operation and
        // look like the decision was ignored.
        if ((pick === 'left' || pick === 'base' || pick === 'right') && !modelRow[pick]) continue
        items.push({
          label: `${current === pick ? '✓ ' : '　'}${label}`,
          action: () => this.resolveRow(modelRow, pick),
        })
      }
      if (modelRow.mergeResolution) {
        items.push({
          label: `恢復自動判定${auto ? `（${auto}）` : '（無法自動合併）'}`,
          action: () => this.resolveRow(modelRow, null),
        })
      }
      items.push({ separator: true })
    }

    // ── 開啟比對（檔案）──
    if (!isDir && leftPath && rightPath &&
        ['same', 'different', 'left-newer', 'right-newer'].includes(status)) {
      items.push({
        label: '開啟比對',
        action: () => this._emit('open-file-compare', { leftPath, rightPath })
      })
      items.push({ separator: true })
    }

    // ── 快速比對 / 與其他資料夾比對 ──
    // Quick Compare works on any paired row, including one a cancelled content
    // scan left ungraded, so it is offered before the mode-specific items.
    if (!isDir && leftPath && rightPath) {
      items.push({
        label: '快速比對此列（僅大小與時間）',
        action: () => {
          this._setFocusedKey(leftPath || rightPath)
          this.quickCompareSelected()
        },
      })
      items.push({
        label: '比對此列的內容（實際讀檔）',
        action: () => void this.compareContentsOfRow(modelRow),
        disabled: !modelRow,
      })
    }
    // Single-node expand / collapse: reviewing one folder of a large project
    // should not mean loading the whole tree.
    if (isDir && modelRow) {
      const depth = this._flatEntryOf(rowEl)?.depth ?? 0
      items.push({
        label: '展開此節點（含所有子層）',
        action: () => void this.expandNode(modelRow, depth),
      })
      items.push({
        label: '收合此節點（含所有子層）',
        action: () => this.collapseNode(modelRow, depth),
      })
    }
    if (isDir) {
      for (const [path, isFs, label, side] of [
        [leftPath, leftIsFs, '左側', 'left'], [rightPath, rightIsFs, '右側', 'right'],
      ]) {
        if (!path || !isFs) continue
        items.push({
          label: `以此資料夾與其他資料夾比對…（${label}）`,
          action: () => void this.compareFolderTo(path, side),
        })
      }
    }
    if (items.length && !items.at(-1)?.separator) items.push({ separator: true })

    // ── 以其他程式開啟 ──
    // Directories are excluded: showInExplorer already covers "look at this
    // folder", and handing a directory to the file association would open a
    // second explorer window at best.
    for (const [path, isFs, label] of [
      [leftPath, leftIsFs, '左側'], [rightPath, rightIsFs, '右側'],
    ]) {
      if (!path || !isFs || isDir || typeof window.electronAPI?.openWith !== 'function') continue
      items.push({
        label: `以預設程式開啟（${label}）`,
        action: () => void this._openWith(path, false)
      })
      if (navigator.platform.startsWith('Win')) {
        items.push({
          label: `開啟方式…（${label}）`,
          action: () => void this._openWith(path, true)
        })
      }
    }
    // Only when this group actually contributed something; two separators in a
    // row read as an empty section.
    if (items.length && !items.at(-1)?.separator) items.push({ separator: true })

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
        items.push({ separator: true })
        items.push({
          label: '同步時間戳：左 → 右',
          disabled: !modelRow.left?.mtime,
          action: () => void this._touchRows([modelRow], 'left-to-right'),
        })
        items.push({
          label: '同步時間戳：右 → 左',
          disabled: !modelRow.right?.mtime,
          action: () => void this._touchRows([modelRow], 'right-to-left'),
        })
      }
    }

    // ── Copy To… (any folder) ──
    if (!isDir && (leftPath || rightPath)) {
      items.push({ separator: true })
      if (leftPath) {
        items.push({
          label: '複製左側到其他資料夾…',
          action: () => void this._copyRowsToFolder(modelRow ? [modelRow] : [], 'left'),
        })
      }
      if (rightPath) {
        items.push({
          label: '複製右側到其他資料夾…',
          action: () => void this._copyRowsToFolder(modelRow ? [modelRow] : [], 'right'),
        })
      }
      if (leftPath) {
        items.push({
          label: '移動左側到其他資料夾…（來源會被刪除）',
          action: () => void this._moveRowsToFolder(modelRow ? [modelRow] : [], 'left'),
        })
      }
      if (rightPath) {
        items.push({
          label: '移動右側到其他資料夾…（來源會被刪除）',
          action: () => void this._moveRowsToFolder(modelRow ? [modelRow] : [], 'right'),
        })
      }
    }

    // ── 選取 ──
    items.push({ separator: true })
    items.push({
      label: '選取全部檔案（不含資料夾）',
      action: () => { this.selectAllFiles() },
    })

    // ── P2-26: 屬性檢視 / 編輯 ──
    if (modelRow && (leftPath || rightPath)) {
      items.push({ separator: true })
      items.push({
        label: '屬性…',
        action: () => void this.openAttributesDialog(modelRow),
      })
    }

    // ── Source Control ──
    // Rendered as a labelled group rather than a real submenu: the shared
    // context-menu component is one level deep, and a flat group with a header
    // is closer to BC's wording than silently dropping the commands would be.
    if (!isDir && (leftPath || rightPath)) {
      // Kicked off here so a user who never shows the VCS column still gets a
      // populated menu the second time they open it.
      void this._ensureVcsStatus()
      const scPaths = [leftPath, rightPath]
        .filter((p) => p && sourceKindOf(p) === 'fs')
      // Quiet outside a working copy: once the status read has happened and
      // found no repository, these commands are noise on every row.
      const known = this._vcsLoaded
      const inRepo = scPaths.filter((p) => this._vcsRootFor(p))
      if (scPaths.length && (!known || inRepo.length)) {
        const targets = known ? inRepo : scPaths
        items.push({ separator: true })
        items.push({ label: '版本控制（Source Control）— git', disabled: true })
        // Diff and log answer about one file, so when both sides qualify the
        // side is named instead of picking one and hoping it was the one meant.
        for (const [action, text] of [['diff', '比較差異（git diff）'], ['log', '歷史記錄（git log）']]) {
          for (const p of targets) {
            const side = targets.length > 1 ? (p === leftPath ? '左側 ' : '右側 ') : ''
            items.push({
              label: `　${side}${text}…`,
              action: () => void this.showVcsText(
                /** @type {'diff'|'log'} */ (action), p),
            })
          }
        }
        items.push({
          label: '　加入索引（git add）',
          action: () => void this.runVcsAction('add', targets),
        })
        items.push({
          label: '　取消暫存（git reset）',
          action: () => void this.runVcsAction('unstage', targets),
        })
        items.push({
          label: '　還原（git checkout --，會丟棄變更）',
          action: () => void this.runVcsAction('revert', targets),
        })
        items.push({
          label: '　重新讀取版本控制狀態',
          action: () => void this._ensureVcsStatus(true).then(() => this._applyFilterAndRender()),
        })
      }
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
