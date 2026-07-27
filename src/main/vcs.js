/**
 * @file vcs.js
 * @description Version-control status and operations backing BeyondCompare's
 *   "VCS" column and its Source Control submenu.
 *
 *   Only git is supported. Every other VCS reports `unsupported` rather than
 *   `clean`: a column that silently claims "no local changes" for a Mercurial
 *   or SVN working copy is worse than no column, because the user reads it as
 *   an answer.
 *
 *   The status of a whole tree is read with a *single* `git status` call and
 *   answered from the resulting table. Asking git once per row is what makes a
 *   50k-file repository unusable, and it is a mistake this view has already
 *   paid for once with the version and checksum columns.
 *
 *   **Path contract**: every `absPath` / `absDir` argument is assumed to have
 *   already passed `validatePath()` in the IPC layer. Nothing here re-validates
 *   against the allow-list; it only checks containment within the repo root so
 *   a caller cannot make git act on a path outside the repository it named.
 *
 *   All child processes are spawned with `execFile` and an argument array. No
 *   string is ever handed to a shell.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { realpathSync } from 'fs'
import { resolve, relative, isAbsolute, sep, dirname } from 'path'

const execFileAsync = promisify(execFile)

/**
 * Ceiling on a single git invocation's stdout.
 *
 * `git status` on a repository with a million untracked files would otherwise
 * be an unbounded allocation in the main process. Exceeding it is reported as
 * a truncation rather than swallowed, because a partial status table would show
 * files as clean that are not.
 */
const MAX_STATUS_BYTES = 16 * 1024 * 1024

/** Diff and log are shown in a dialog, so they get a much smaller budget. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024

/** Wall-clock ceiling for any one git call. */
const GIT_TIMEOUT_MS = 30_000

/**
 * Environment for every git call.
 *
 * `GIT_OPTIONAL_LOCKS=0` keeps a read-only status from taking the index lock —
 * this runs while the user may well have a build or an editor working in the
 * same tree. `GIT_TERMINAL_PROMPT=0` makes a credential prompt fail instead of
 * hanging a process with no terminal attached to it.
 */
const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
}

/**
 * @typedef {'untracked'|'modified'|'staged'|'deleted'|'conflict'|'ignored'|'clean'} VcsState
 *
 * @typedef {object} VcsStatusResult
 * @property {boolean} available   true only when git ran and the dir is a repo
 * @property {'git'|null} vcs
 * @property {string|null} root    repository top level, absolute
 * @property {'ok'|'git-missing'|'not-a-repo'|'not-local'|'failed'} reason
 * @property {string} message      user-facing explanation; '' when reason is 'ok'
 * @property {Record<string, VcsState>} files   repo-relative path -> state
 * @property {Record<string, VcsState>} dirs    repo-relative dir prefix (with
 *   trailing '/') -> state, from git's collapsed untracked/ignored directories
 * @property {boolean} truncated   output hit {@link MAX_STATUS_BYTES}
 */

/** Canonical state ids, in the order the UI lists them. */
export const VCS_STATES = Object.freeze(
  ['conflict', 'staged', 'modified', 'deleted', 'untracked', 'ignored', 'clean'])

/** Cached `git --version` probe: null = not probed yet. */
/** @type {{ ok: boolean, message: string } | null} */
let _gitProbe = null

/**
 * Reset the cached git probe. Exists so tests are not order-dependent.
 */
export function _resetGitProbe() { _gitProbe = null }

/**
 * @param {unknown} err
 * @returns {string}
 */
function errText(err) {
  if (err && typeof err === 'object') {
    const e = /** @type {{ stderr?: string, message?: string }} */ (err)
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : ''
    if (stderr) return stderr.split('\n').slice(0, 4).join('\n')
    if (e.message) return String(e.message)
  }
  return String(err)
}

/**
 * Is this an "the executable does not exist" failure?
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissingExe(err) {
  const code = /** @type {{ code?: string }} */ (err ?? {}).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Run git and return stdout.
 *
 * @param {string[]} args
 * @param {{ cwd: string, maxBuffer?: number, encoding?: 'utf8'|'buffer' }} opts
 * @returns {Promise<string>}
 */
async function git(args, opts) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: opts.cwd,
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? MAX_TEXT_BYTES,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  })
  return typeof stdout === 'string' ? stdout : String(stdout)
}

/**
 * Probe once for a usable git, and remember the answer.
 *
 * The result is deliberately cached for the life of the process: the answer to
 * "is git on PATH" does not change while the app is open, and re-probing would
 * put a process spawn in front of every folder scan.
 *
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function probeGit() {
  if (_gitProbe) return _gitProbe
  try {
    await execFileAsync('git', ['--version'], {
      windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024,
      env: { ...process.env, ...GIT_ENV },
    })
    _gitProbe = { ok: true, message: '' }
  } catch (err) {
    _gitProbe = {
      ok: false,
      message: isMissingExe(err)
        ? '找不到 git 執行檔（不在 PATH 上），因此無法判讀版本控制狀態。'
        : `git 無法執行：${errText(err)}`,
    }
  }
  return _gitProbe
}

/**
 * Classify one porcelain XY pair.
 *
 * Ordering matters and is not arbitrary: an unmerged pair looks like an
 * ordinary add/delete pair if it is tested second, and a staged-and-then-
 * modified file has to read as "modified" so the user does not think the
 * worktree edit is already recorded.
 *
 * @param {string} x index status letter
 * @param {string} y worktree status letter
 * @returns {VcsState}
 */
export function classifyStatus(x, y) {
  const X = x || ' '
  const Y = y || ' '
  const unmerged = X === 'U' || Y === 'U'
    || (X === 'A' && Y === 'A') || (X === 'D' && Y === 'D')
  if (unmerged) return 'conflict'
  if (X === '?') return 'untracked'
  if (X === '!') return 'ignored'
  if (Y === 'D' || X === 'D') return 'deleted'
  if (Y !== ' ') return 'modified'
  if (X !== ' ') return 'staged'
  return 'clean'
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 *
 * The `-z` form is used precisely because the default form quotes and escapes
 * any path that is not plain ASCII, which would have to be un-escaped here —
 * one more parser to get wrong. Records are NUL-separated (written as `\0`;
 * a literal NUL byte is never spelled out in this file), and a rename or copy
 * record is followed by a second field holding the original path.
 *
 * @param {string} text
 * @returns {{ files: Record<string, VcsState>, dirs: Record<string, VcsState> }}
 */
export function parsePorcelainZ(text) {
  /** @type {Record<string, VcsState>} */
  const files = {}
  /** @type {Record<string, VcsState>} */
  const dirs = {}
  const fields = String(text ?? '').split('\0')

  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]
    // The final field after a trailing separator is empty, and a malformed
    // short record cannot carry a path, so neither is worth guessing about.
    if (!rec || rec.length < 4) continue
    const x = rec[0]
    const y = rec[1]
    const path = rec.slice(3)
    // Renames and copies spend an extra field on the original path. It is
    // consumed here rather than treated as its own record, which would
    // otherwise be parsed as a status pair made of the first two characters
    // of a filename.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++
    if (!path) continue
    const state = classifyStatus(x, y)
    // git collapses whole untracked/ignored directories into one entry with a
    // trailing slash. Keeping those separate lets the view answer for every
    // file underneath without git having enumerated them.
    if (path.endsWith('/')) dirs[path] = state
    else files[path] = state
  }
  return { files, dirs }
}

/**
 * Locate the git repository containing a directory.
 *
 * @param {string} absDir already-validated absolute directory
 * @returns {Promise<string|null>} repository top level, or null when not a repo
 */
export async function detectRepo(absDir) {
  try {
    const out = await git(['rev-parse', '--show-toplevel'], { cwd: absDir, maxBuffer: 64 * 1024 })
    const root = out.trim()
    return root ? resolve(root) : null
  } catch {
    // "not a git repository" is the overwhelmingly common case and is not an
    // error the user needs to see; the caller turns it into a quiet no-column.
    return null
  }
}

/**
 * Read the whole repository's status in one call.
 *
 * @param {string} absDir already-validated absolute directory to inspect
 * @param {{ includeIgnored?: boolean }} [opts]
 * @returns {Promise<VcsStatusResult>}
 */
export async function readVcsStatus(absDir, opts = {}) {
  /** @type {VcsStatusResult} */
  const empty = {
    available: false, vcs: null, root: null, reason: 'failed',
    message: '', files: {}, dirs: {}, truncated: false,
  }

  const dir = String(absDir ?? '')
  if (!dir || !isAbsolute(dir)) {
    return { ...empty, reason: 'not-local', message: '版本控制狀態只適用於本機資料夾。' }
  }

  const probe = await probeGit()
  if (!probe.ok) return { ...empty, reason: 'git-missing', message: probe.message }

  const root = await detectRepo(dir)
  if (!root) {
    return {
      ...empty, reason: 'not-a-repo',
      message: '此資料夾不在 git 工作區內（其他版本控制系統尚未支援）。',
    }
  }

  // `normal` rather than `all` for both collapsible sets: git answers with one
  // entry per untracked/ignored *directory*, which the view expands by prefix.
  // `all` would enumerate every file inside node_modules, which is exactly the
  // unbounded output this budget exists to avoid.
  const args = [
    'status', '--porcelain=v1', '-z',
    '--untracked-files=normal',
    opts.includeIgnored === false ? '--ignored=no' : '--ignored=traditional',
  ]

  try {
    const out = await git(args, { cwd: root, maxBuffer: MAX_STATUS_BYTES })
    const { files, dirs } = parsePorcelainZ(out)
    return {
      available: true, vcs: 'git', root, reason: 'ok', message: '',
      files, dirs, truncated: false,
    }
  } catch (err) {
    const code = /** @type {{ code?: string }} */ (err ?? {}).code
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return {
        ...empty, vcs: 'git', root, reason: 'failed', truncated: true,
        message: `git status 的輸出超過 ${MAX_STATUS_BYTES / (1024 * 1024)} MB，`
          + '狀態欄無法顯示。請縮小比對範圍，或清理未追蹤的檔案。',
      }
    }
    return {
      ...empty, vcs: 'git', root, reason: 'failed',
      message: `git status 失敗：${errText(err)}`,
    }
  }
}

/**
 * Convert an absolute path to a repo-relative, forward-slashed path.
 *
 * Returns null when the path is not inside the root. This is the containment
 * check that keeps a caller from naming `../../elsewhere` and having git act
 * on it; the allow-list check upstream is about *which* roots exist, this one
 * is about staying inside the repository the caller claimed.
 *
 * @param {string} root
 * @param {string} absPath
 * @returns {string|null}
 */
export function toRepoRelative(root, absPath) {
  const r = resolve(String(root ?? ''))
  const p = resolve(String(absPath ?? ''))

  /** @param {string} a @param {string} b @returns {string|null} */
  const contain = (a, b) => {
    const rel = relative(a, b)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
    return rel
  }

  const rel = contain(r, p)
  if (rel === null) return null

  // The lexical check above rejects `..` and absolute paths, and nothing else.
  // A symlink sitting inside the tree — which `git status` lists as an
  // ordinary path — resolves elsewhere at the filesystem layer, so a name that
  // looks contained can still make git write outside the repository it names.
  // The IPC layer's validatePath already resolves symlinks against the opened
  // roots, so this is the second lock rather than the only one.
  const realRoot = _realOrNearest(r)
  const realPath = _realOrNearest(p)
  if (realRoot && realPath && contain(realRoot, realPath) === null) return null

  return rel.split(sep).join('/')
}

/**
 * The path with symlinks resolved, falling back to the nearest ancestor that
 * exists.
 *
 * A path that is not on disk is not automatically wrong here: reverting a
 * deleted file is an ordinary operation, and its parent directory is enough to
 * decide containment. Returns null only when nothing along the chain resolves,
 * in which case the caller keeps the lexical verdict.
 *
 * @param {string} p an already-resolved absolute path
 * @returns {string|null}
 */
function _realOrNearest(p) {
  let cur = p
  for (let i = 0; i < 64; i++) {
    try {
      return resolve(realpathSync.native(cur), relative(cur, p))
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return null
      cur = parent
    }
  }
  return null
}

/**
 * @typedef {'add'|'revert'|'unstage'} VcsWriteAction
 *
 * @typedef {object} VcsOpResult
 * @property {string} path      the absolute path the caller asked about
 * @property {'done'|'skipped'|'failed'} state
 * @property {string} message   '' when done
 */

/** Argument lists for the write operations, keyed by action. */
const WRITE_ARGS = Object.freeze({
  // `checkout --` discards the worktree copy. Chosen over `restore` because it
  // works on every git old enough to be on a developer machine at all.
  revert: ['checkout', '--'],
  add: ['add', '--'],
  unstage: ['reset', '-q', 'HEAD', '--'],
})

/**
 * Run a write operation, one path at a time.
 *
 * Sequential and per-path for the same reason `runMove` in the folder view is:
 * a batch that stops halfway has to be reportable as "these succeeded,
 * these did not", and a single git invocation over N paths gives one exit code
 * for the whole set.
 *
 * @param {{ action: VcsWriteAction, root: string, paths: string[] }} req
 *   `root` and every entry of `paths` are already-validated absolute paths
 * @returns {Promise<{ results: VcsOpResult[] }>}
 */
export async function runVcsCommand(req) {
  const action = /** @type {VcsWriteAction} */ (req?.action)
  const base = WRITE_ARGS[action]
  if (!base) throw new Error(`不支援的版本控制操作：${String(action)}`)

  const probe = await probeGit()
  if (!probe.ok) throw new Error(probe.message)

  const root = resolve(String(req?.root ?? ''))
  /** @type {VcsOpResult[]} */
  const results = []

  for (const abs of req?.paths ?? []) {
    const rel = toRepoRelative(root, abs)
    if (!rel) {
      results.push({
        path: abs, state: 'skipped',
        message: `不在版本庫「${root}」之內，已略過。`,
      })
      continue
    }
    try {
      await git([...base, rel], { cwd: root, maxBuffer: MAX_TEXT_BYTES })
      results.push({ path: abs, state: 'done', message: '' })
    } catch (err) {
      results.push({ path: abs, state: 'failed', message: errText(err) })
    }
  }
  return { results }
}

/** Commits shown by the log command; a full history is not a dialog's job. */
const LOG_LIMIT = 50

/**
 * Read a read-only text answer (diff or log) for one path.
 *
 * @param {{ action: 'diff'|'log', root: string, path: string }} req
 *   already-validated absolute paths
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
export async function readVcsText(req) {
  const action = req?.action
  if (action !== 'diff' && action !== 'log') {
    throw new Error(`不支援的版本控制查詢：${String(action)}`)
  }

  const probe = await probeGit()
  if (!probe.ok) throw new Error(probe.message)

  const root = resolve(String(req?.root ?? ''))
  const rel = toRepoRelative(root, req?.path)
  if (!rel) throw new Error(`「${req?.path}」不在版本庫「${root}」之內。`)

  const args = action === 'diff'
    // Against HEAD, not against the index: the user asking "what changed"
    // means both the staged and the unstaged edits, and `git diff` alone would
    // show an empty result for a file that is fully staged.
    ? ['--no-pager', 'diff', 'HEAD', '--', rel]
    : ['--no-pager', 'log', `--max-count=${LOG_LIMIT}`, '--date=short',
      '--pretty=format:%h  %ad  %an  %s', '--', rel]

  try {
    const text = await git(args, { cwd: root, maxBuffer: MAX_TEXT_BYTES })
    return { text, truncated: false }
  } catch (err) {
    const code = /** @type {{ code?: string }} */ (err ?? {}).code
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return {
        text: '',
        truncated: true,
      }
    }
    throw new Error(errText(err))
  }
}
