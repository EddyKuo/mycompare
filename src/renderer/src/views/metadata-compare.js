/**
 * MetadataCompare — 中繼資料比對視圖（MP3 標籤 / Windows 版本資源）
 * src/renderer/src/views/metadata-compare.js
 *
 * 公開 API：
 *   constructor(options?)
 *   mount(containerEl) / destroy()
 *   openLeft() / openRight()
 *   setLeft(path) / setRight(path)
 *   refresh() / reloadAll() / swap()
 *   setShowOnlyDiffs(on) / getShowOnlyDiffs()
 *   getRows() / getCurrentDiffIndex()
 *   nextDifference() / prevDifference() / firstDifference() / lastDifference()
 *   getConfig() / applyConfig(cfg)
 *   buildTextReport() / buildHtmlReport() / exportTextReport() / exportHtml()
 *   on(event, handler) / off(event, handler)
 *
 * 事件：
 *   'paths-changed' → { left: string, right: string }
 *   'status'        → { message: string, level?: 'error' }
 *
 * Beyond Compare ships two separate session types here — MP3 Compare and
 * Version Compare — but they are the same screen over a different field list:
 * read a flat set of named strings from each side and line them up. One view
 * handles both, choosing the field order from what the parser says the files
 * are, which is also what lets a stray .exe/.mp3 pairing still show something
 * instead of refusing.
 *
 * The parsing all lives in main/metadata.js and is reached over
 * `electronAPI.readMetadata`; nothing here decodes bytes.
 */

import { showContextMenu, closeContextMenu } from '../core/context-menu.js'
import { tagConfig, readConfig } from '../core/named-config-store.js'
import { stepDiffIndex, navResult, getNavOptions } from '../core/diff-nav.js'
import { renderTextTable, reportHeader } from '../core/report.js'
import '../styles/metadata-compare.css'

/** @typedef {import('../core/diff-nav.js').NavResult} NavResult */

/**
 * @typedef {object} AudioInfo
 * @property {number|null} bitrate
 * @property {number|null} sampleRate
 * @property {string|null} channelMode
 * @property {number|null} durationSec
 * @property {string|null} mpegVersion
 * @property {number|null} layer
 * @property {boolean} vbr
 *
 * @typedef {object} MetadataResult
 * @property {'mp3'|'pe'|'unknown'} kind
 * @property {Record<string,string>} fields
 * @property {AudioInfo} [audio]
 *
 * @typedef {object} LoadedSide
 * @property {string} path
 * @property {MetadataResult|null} meta
 *
 * @typedef {'same'|'different'|'left-only'|'right-only'} FieldState
 *
 * @typedef {object} FieldRow
 * @property {string} field       stable key, `audio:*` for derived audio rows
 * @property {string} label       what the grid shows
 * @property {'tag'|'audio'} group
 * @property {string|null} left   null when the field is absent on that side
 * @property {string|null} right
 * @property {boolean} leftPresent
 * @property {boolean} rightPresent
 * @property {FieldState} state
 */

// ── DOM helper ────────────────────────────────────────────────────────────────

/**
 * 建立 DOM 元素的輕量工廠
 * @param {string} tag
 * @param {Record<string,string>} [attrs]
 * @param {...(Node|string|null)} children
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v
    else if (k === 'textContent') node.textContent = v
    else node.setAttribute(k, v)
  }
  for (const child of children) {
    if (child == null) continue
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

// ── Field vocabulary ──────────────────────────────────────────────────────────

/**
 * Display order for MP3 tag fields.
 *
 * Deliberately a copy of `MP3_FIELDS` in main/metadata.js rather than an import:
 * that module opens file handles at load time and cannot be pulled into the
 * renderer bundle. `metadata-compare-logic.test.js` asserts the two lists stay
 * identical, so the duplication cannot drift unnoticed.
 * @type {readonly string[]}
 */
export const MP3_FIELD_ORDER = Object.freeze([
  'title', 'artist', 'album', 'albumArtist', 'composer',
  'year', 'track', 'genre', 'comment',
])

/**
 * Display order for PE version-resource fields. Mirrors `PE_FIELDS`.
 * @type {readonly string[]}
 */
export const PE_FIELD_ORDER = Object.freeze([
  'FileVersion', 'ProductVersion', 'FixedFileVersion', 'FixedProductVersion',
  'CompanyName', 'FileDescription', 'InternalName', 'OriginalFilename',
  'ProductName', 'LegalCopyright',
])

/** Derived MPEG-frame rows, in the order they are shown. */
export const AUDIO_FIELD_ORDER = Object.freeze([
  'audio:duration', 'audio:bitrate', 'audio:sampleRate',
  'audio:channelMode', 'audio:mpegVersion', 'audio:layer',
])

/**
 * Human labels. A field with no entry here shows its raw key, which is right
 * for the arbitrary string-table names a PE may carry.
 * @type {Record<string, string>}
 */
export const FIELD_LABELS = Object.freeze({
  title: '標題',
  artist: '演出者',
  album: '專輯',
  albumArtist: '專輯演出者',
  composer: '作曲',
  year: '年份',
  track: '音軌',
  genre: '曲風',
  comment: '註解',

  FileVersion: '檔案版本',
  ProductVersion: '產品版本',
  FixedFileVersion: '檔案版本（固定區塊）',
  FixedProductVersion: '產品版本（固定區塊）',
  CompanyName: '公司名稱',
  FileDescription: '檔案描述',
  InternalName: '內部名稱',
  OriginalFilename: '原始檔名',
  ProductName: '產品名稱',
  LegalCopyright: '著作權',

  'audio:duration': '長度',
  'audio:bitrate': '位元率',
  'audio:sampleRate': '取樣率',
  'audio:channelMode': '聲道',
  'audio:mpegVersion': 'MPEG 版本',
  'audio:layer': '層級',
})

/** 檔案類型的顯示名稱。 @type {Record<string, string>} */
export const KIND_LABELS = Object.freeze({
  mp3: 'MP3 標籤（ID3）',
  pe: 'Windows 版本資源',
  mixed: '兩側類型不同',
  unknown: '未知',
})

/**
 * @param {string} field
 * @returns {string}
 */
export function fieldLabel(field) {
  return FIELD_LABELS[field] ?? field
}

// ── Pure model ────────────────────────────────────────────────────────────────

/**
 * Which field vocabulary applies to a pair of files.
 *
 * A side that parsed as nothing does not get a vote: comparing an MP3 against
 * an unreadable file should still lay the MP3's fields out, otherwise the user
 * is told nothing at all about the file that did parse.
 *
 * @param {MetadataResult|null|undefined} left
 * @param {MetadataResult|null|undefined} right
 * @returns {'mp3'|'pe'|'mixed'|'unknown'}
 */
export function resolveKind(left, right) {
  const kinds = [left?.kind, right?.kind]
    .filter((k) => k === 'mp3' || k === 'pe')
  if (kinds.length === 0) return 'unknown'
  if (kinds.every((k) => k === kinds[0])) return /** @type {'mp3'|'pe'} */ (kinds[0])
  return 'mixed'
}

/**
 * 秒數 → `m:ss`（超過一小時則 `h:mm:ss`）。
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const two = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}

/**
 * MPEG frame properties as displayable strings.
 *
 * A property the parser could not read is left out entirely rather than shown
 * as an empty cell: absent and "present but empty" are different answers, and
 * the row states below depend on telling them apart.
 *
 * @param {AudioInfo|null|undefined} audio
 * @returns {Record<string, string>}
 */
export function audioFields(audio) {
  /** @type {Record<string, string>} */
  const out = {}
  if (!audio) return out

  // Guarded on emptiness first: `Number(null)` and `Number('')` are both 0, and
  // 0 is finite, so a bare isFinite() check would invent a 0 kbps bitrate for a
  // file whose header could not be read.
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))

  const duration = num(audio.durationSec)
  if (duration !== null && Number.isFinite(duration) && duration > 0) {
    out['audio:duration'] = formatDuration(duration)
  }
  const bitrate = num(audio.bitrate)
  if (bitrate !== null && Number.isFinite(bitrate) && bitrate > 0) {
    out['audio:bitrate'] = `${bitrate} kbps${audio.vbr ? '（VBR 平均）' : ''}`
  }
  const rate = num(audio.sampleRate)
  if (rate !== null && Number.isFinite(rate) && rate > 0) {
    out['audio:sampleRate'] = `${rate} Hz`
  }
  if (audio.channelMode) out['audio:channelMode'] = String(audio.channelMode)
  if (audio.mpegVersion) out['audio:mpegVersion'] = `MPEG ${audio.mpegVersion}`
  const layer = num(audio.layer)
  if (layer !== null && Number.isFinite(layer) && layer > 0) {
    out['audio:layer'] = `Layer ${layer}`
  }
  return out
}

/**
 * @param {Record<string, string>|null|undefined} obj
 * @param {string} key
 * @returns {boolean}
 */
function hasField(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key)
    && obj[key] !== undefined
}

/**
 * Field-by-field comparison of two flat string maps.
 *
 * Same shape as `diffMetadata()` in main/metadata.js — the parity is asserted
 * by a unit test — with the display label and row state the grid needs added.
 *
 * @param {Record<string,string>|null|undefined} left
 * @param {Record<string,string>|null|undefined} right
 * @param {readonly string[]} order canonical order; anything else follows, sorted
 * @param {'tag'|'audio'} group
 * @returns {FieldRow[]}
 */
export function diffFields(left, right, order, group = 'tag') {
  const l = left ?? {}
  const r = right ?? {}
  const extras = [...new Set([...Object.keys(l), ...Object.keys(r)])]
    .filter((k) => !order.includes(k))
    .sort()
  const names = [...order.filter((k) => hasField(l, k) || hasField(r, k)), ...extras]

  return names.map((field) => {
    const leftPresent = hasField(l, field)
    const rightPresent = hasField(r, field)
    const lv = leftPresent ? String(l[field]) : null
    const rv = rightPresent ? String(r[field]) : null
    /** @type {FieldState} */
    let state
    if (leftPresent && !rightPresent) state = 'left-only'
    else if (!leftPresent && rightPresent) state = 'right-only'
    else state = lv === rv ? 'same' : 'different'
    return { field, label: fieldLabel(field), group, left: lv, right: rv, leftPresent, rightPresent, state }
  })
}

/**
 * The whole grid model for a pair of parsed files.
 *
 * @param {MetadataResult|null|undefined} left
 * @param {MetadataResult|null|undefined} right
 * @returns {{ kind: 'mp3'|'pe'|'mixed'|'unknown', rows: FieldRow[] }}
 */
export function buildMetadataRows(left, right) {
  const kind = resolveKind(left, right)
  const order = kind === 'mp3' ? MP3_FIELD_ORDER
    : kind === 'pe' ? PE_FIELD_ORDER
      : [...MP3_FIELD_ORDER, ...PE_FIELD_ORDER]

  const rows = diffFields(left?.fields, right?.fields, order, 'tag')

  // Audio properties are not tags, but they are the other half of what BC's
  // MP3 session shows, and they are already parsed.
  if (kind === 'mp3' || kind === 'mixed') {
    rows.push(...diffFields(
      audioFields(left?.audio), audioFields(right?.audio), AUDIO_FIELD_ORDER, 'audio'))
  }

  return { kind, rows }
}

/**
 * Indices of the rows difference navigation visits.
 * @param {FieldRow[]} rows
 * @returns {number[]}
 */
export function diffRowIndices(rows) {
  const out = []
  for (let i = 0; i < (rows ?? []).length; i++) {
    if (rows[i].state !== 'same') out.push(i)
  }
  return out
}

/**
 * Counts for the status bar and reports.
 * @param {FieldRow[]} rows
 * @returns {{ total: number, same: number, different: number, leftOnly: number, rightOnly: number }}
 */
export function countRows(rows) {
  const counts = { total: 0, same: 0, different: 0, leftOnly: 0, rightOnly: 0 }
  for (const row of rows ?? []) {
    counts.total++
    if (row.state === 'same') counts.same++
    else if (row.state === 'different') counts.different++
    else if (row.state === 'left-only') counts.leftOnly++
    else counts.rightOnly++
  }
  return counts
}

/**
 * @param {string} path
 * @returns {string}
 */
function baseName(path) {
  return String(path ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
}

/**
 * Things the user has to be told about a loaded side.
 *
 * An unreadable file and a file whose tags are genuinely empty both produce no
 * rows; an empty grid on its own reads as "the two files match", which is the
 * one conclusion that must never be drawn by accident.
 *
 * @param {LoadedSide|null} left
 * @param {LoadedSide|null} right
 * @param {FieldRow[]} rows
 * @returns {string[]}
 */
export function metadataNotes(left, right, rows) {
  /** @type {string[]} */
  const notes = []
  if (!left && !right) return ['尚未載入檔案。請以上方的「開啟…」選擇兩個 MP3 或 Windows 執行檔。']
  if (!left) notes.push('尚未載入左側檔案。')
  if (!right) notes.push('尚未載入右側檔案。')

  for (const [side, label] of /** @type {Array<[LoadedSide|null, string]>} */ ([
    [left, '左側'], [right, '右側'],
  ])) {
    if (!side) continue
    const kind = side.meta?.kind ?? 'unknown'
    if (kind === 'unknown') {
      notes.push(`${label}「${baseName(side.path)}」不是可讀取中繼資料的檔案`
        + '（僅支援 MP3 與 Windows PE 執行檔）。')
      continue
    }
    if (Object.keys(side.meta?.fields ?? {}).length === 0) {
      notes.push(`${label}「${baseName(side.path)}」`
        + `${kind === 'mp3' ? '沒有任何 ID3 標籤' : '沒有版本資源'}。`)
    }
  }

  if (left && right && rows.length === 0) {
    notes.push('兩側都沒有可比對的欄位——這不代表兩個檔案相同。')
  }
  return notes
}

/**
 * @param {FieldState} state
 * @returns {string}
 */
export function stateLabel(state) {
  switch (state) {
    case 'same': return '相同'
    case 'different': return '不同'
    case 'left-only': return '僅左側'
    default: return '僅右側'
  }
}

// ── Reports ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} MetadataReportInfo
 * @property {string} leftPath
 * @property {string} rightPath
 * @property {'mp3'|'pe'|'mixed'|'unknown'} kind
 * @property {FieldRow[]} rows
 * @property {string[]} notes
 */

/**
 * @param {MetadataReportInfo} info
 * @param {{ generatedAt?: Date }} [opts]
 * @returns {string}
 */
export function buildMetadataTextReport(info, opts = {}) {
  const counts = countRows(info.rows)
  const head = reportHeader({
    title: '中繼資料比對報表',
    leftPath: info.leftPath,
    rightPath: info.rightPath,
    generatedAt: opts.generatedAt,
  })
  const summary = `類型：${KIND_LABELS[info.kind] ?? info.kind}\n`
    + `欄位 ${counts.total}：相同 ${counts.same}、不同 ${counts.different}、`
    + `僅左側 ${counts.leftOnly}、僅右側 ${counts.rightOnly}\n`
  const table = info.rows.length
    ? renderTextTable(
      [{ title: '欄位' }, { title: '左側' }, { title: '右側' }, { title: '狀態' }],
      info.rows.map((r) => [r.label, r.left ?? '—', r.right ?? '—', stateLabel(r.state)]))
    : '（沒有可比對的欄位）'
  const notes = info.notes.length ? `\n\n附註：\n${info.notes.map((n) => `- ${n}`).join('\n')}` : ''
  return `${head}\n${summary}\n${table}${notes}\n`
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * @param {MetadataReportInfo} info
 * @param {{ generatedAt?: Date }} [opts]
 * @returns {string}
 */
export function buildMetadataHtmlReport(info, opts = {}) {
  const counts = countRows(info.rows)
  const when = (opts.generatedAt ?? new Date()).toISOString().replace('T', ' ').slice(0, 19)
  const rows = info.rows.map((r) => `<tr class="${r.state}">`
    + `<td>${escapeHtml(r.label)}</td>`
    + `<td>${escapeHtml(r.left ?? '—')}</td>`
    + `<td>${escapeHtml(r.right ?? '—')}</td>`
    + `<td>${escapeHtml(stateLabel(r.state))}</td></tr>`).join('\n')
  const notes = info.notes.length
    ? `<ul class="notes">${info.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : ''
  return `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<title>中繼資料比對報表</title>
<style>
 body { font-family: "Segoe UI", system-ui, sans-serif; margin: 24px; color: #1e1e1e; }
 table { border-collapse: collapse; width: 100%; }
 th, td { border: 1px solid #d0d0d0; padding: 4px 8px; text-align: left; font-size: 13px; }
 th { background: #f0f0f0; }
 tr.different  { background: #ffebe9; }
 tr.left-only  { background: #e6ffec; }
 tr.right-only { background: #fff8e1; }
 .notes { color: #8a5300; }
 @media print { body { margin: 0; } }
</style></head><body>
<h1>中繼資料比對報表</h1>
<p>左：${escapeHtml(info.leftPath || '（未知）')}<br>右：${escapeHtml(info.rightPath || '（未知）')}<br>
類型：${escapeHtml(KIND_LABELS[info.kind] ?? info.kind)}<br>產生時間：${escapeHtml(when)}</p>
<p>欄位 ${counts.total}：相同 ${counts.same}、不同 ${counts.different}、僅左側 ${counts.leftOnly}、僅右側 ${counts.rightOnly}</p>
${notes}
<table><thead><tr><th>欄位</th><th>左側</th><th>右側</th><th>狀態</th></tr></thead>
<tbody>
${rows}
</tbody></table>
</body></html>
`
}

// ── MetadataCompare class ─────────────────────────────────────────────────────

/** Only the path is wanted from the open dialog, so the read is kept minimal. */
const PATH_ONLY_BYTES = 1

export class MetadataCompare {
  /**
   * @param {object} [options]
   * @param {boolean} [options.showOnlyDiffs] 只列出有差異的欄位，預設 false
   */
  constructor(options = {}) {
    /** @type {LoadedSide|null} */
    this._left = null
    /** @type {LoadedSide|null} */
    this._right = null

    /** @type {FieldRow[]} 唯一的真實狀態；DOM 只是它的投影 */
    this._rows = []
    /** @type {'mp3'|'pe'|'mixed'|'unknown'} */
    this._kind = 'unknown'
    /** @type {string[]} */
    this._notes = []

    /** @type {boolean} */
    this._showOnlyDiffs = Boolean(options.showOnlyDiffs)

    /** @type {number} -1 表示尚未選取任何差異 */
    this._currentDiffIdx = -1

    /**
     * Set by setLeft/setRight and consumed after the next rebuild, so the
     * navigation cursor honours the "jump to first difference on load" option
     * exactly like the other views.
     * @type {boolean}
     */
    this._pendingFirstDiff = false

    /** @type {Record<string, Function[]>} */
    this._handlers = {}
    /** @type {HTMLElement|null} */
    this._container = null
    /** @type {Record<string, HTMLElement>} */
    this._dom = {}
    /** @type {boolean} */
    this._mounted = false
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * @param {HTMLElement} containerEl
   */
  mount(containerEl) {
    this._container = containerEl
    this._render()
    this._mounted = true
    this._rebuild()
  }

  /** 銷毀元件，清除 DOM 與事件 */
  destroy() {
    this._mounted = false
    if (this._container) {
      this._container.innerHTML = ''
      this._container = null
    }
    this._handlers = {}
    this._dom = {}
    this._left = null
    this._right = null
    this._rows = []
    closeContextMenu()
  }

  /**
   * Snapshot of the view's comparison settings, for the named-config store.
   * @returns {object}
   */
  getConfig() {
    return tagConfig('metadata', {
      showOnlyDiffs: this._showOnlyDiffs,
    })
  }

  /**
   * @param {unknown} cfg
   */
  applyConfig(cfg) {
    const s = readConfig('metadata', cfg)
    if (!s) return
    if (typeof s.showOnlyDiffs === 'boolean') this._showOnlyDiffs = s.showOnlyDiffs
    this._syncConfigControls()
    this._renderRows()
  }

  /** Reflect the applied settings back onto the toolbar controls. */
  _syncConfigControls() {
    const check = /** @type {HTMLInputElement|undefined} */ (this._dom.onlyDiffsCheck)
    if (check) check.checked = this._showOnlyDiffs
  }

  /**
   * @param {boolean} [on] omit to toggle
   * @returns {boolean} whether only differences are listed now
   */
  setShowOnlyDiffs(on) {
    this._showOnlyDiffs = on == null ? !this._showOnlyDiffs : Boolean(on)
    this._syncConfigControls()
    this._renderRows()
    return this._showOnlyDiffs
  }

  /** @returns {boolean} */
  getShowOnlyDiffs() {
    return this._showOnlyDiffs
  }

  /** @returns {FieldRow[]} 目前的欄位比對結果 */
  getRows() {
    return this._rows
  }

  /** @returns {'mp3'|'pe'|'mixed'|'unknown'} */
  getKind() {
    return this._kind
  }

  /** @returns {string[]} 目前要提醒使用者的訊息 */
  getNotes() {
    return this._notes
  }

  /**
   * 開啟左側檔案（原生對話框）
   * @returns {Promise<void>}
   */
  async openLeft() {
    await this._openSide('left')
  }

  /**
   * 開啟右側檔案（原生對話框）
   * @returns {Promise<void>}
   */
  async openRight() {
    await this._openSide('right')
  }

  /**
   * @param {'left'|'right'} which
   * @returns {Promise<void>}
   */
  async _openSide(which) {
    try {
      // openFileBinary is the only dialog that hands back a path without also
      // reading the file as text; the byte budget is 1 because the bytes are
      // thrown away — main/metadata.js re-reads only the windows it needs.
      const result = await window.electronAPI?.openFileBinary?.({
        filters: [
          { name: '中繼資料檔案', extensions: ['mp3', 'exe', 'dll', 'ocx', 'sys'] },
          { name: '所有檔案', extensions: ['*'] },
        ],
        maxBytes: PATH_ONLY_BYTES,
      })
      if (!result?.path) return
      await this.setSide(which, result.path)
    } catch (err) {
      this._fail(which, '', err)
    }
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async setLeft(path) {
    await this.setSide('left', path)
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async setRight(path) {
    await this.setSide('right', path)
  }

  /**
   * Read one side's metadata and rebuild the grid.
   *
   * A failed read is recorded as a loaded side with no metadata rather than
   * being dropped: the path still has to appear, and `metadataNotes()` then
   * says why there is nothing under it.
   *
   * @param {'left'|'right'} which
   * @param {string} path
   * @returns {Promise<void>}
   */
  async setSide(which, path) {
    if (!path) return
    /** @type {MetadataResult|null} */
    let meta = null
    try {
      if (typeof window.electronAPI?.readMetadata !== 'function') {
        throw new Error('此環境沒有提供 readMetadata')
      }
      meta = await window.electronAPI.readMetadata(path)
    } catch (err) {
      this._fail(which, path, err)
    }

    const side = { path, meta }
    if (which === 'left') this._left = side
    else this._right = side

    this._pendingFirstDiff = true
    this._rebuild()
    this._emitPaths()
  }

  /** 重新從磁碟讀取兩側 @returns {Promise<void>} */
  async refresh() {
    const left = this._left?.path
    const right = this._right?.path
    if (left) await this.setSide('left', left)
    if (right) await this.setSide('right', right)
  }

  /** 與其他視圖一致的「從磁碟重新載入」入口 @returns {Promise<void>} */
  async reloadAll() {
    await this.refresh()
  }

  /**
   * 交換左右兩側。
   *
   * 直接交換已解析的結果，不重讀磁碟：中繼資料本來就已經在記憶體裡，重讀只會
   * 讓一個純顯示操作變成兩次 IPC。
   * @returns {Promise<void>}
   */
  async swap() {
    if (!this._left && !this._right) {
      this._emit('status', { message: '沒有可交換的檔案', level: 'warn' })
      return
    }
    const left = this._left
    this._left = this._right
    this._right = left
    this._pendingFirstDiff = true
    this._rebuild()
    this._emitPaths()
  }

  // ── Difference navigation ───────────────────────────────────────────────────

  /** @returns {number} 目前選取的差異索引；-1 表示尚未選取 */
  getCurrentDiffIndex() {
    return this._currentDiffIdx
  }

  /** @returns {number} 差異欄位總數 */
  getDiffCount() {
    return diffRowIndices(this._rows).length
  }

  /** @returns {NavResult} */
  nextDifference() { return this._stepDiff(1) }

  /** @returns {NavResult} */
  prevDifference() { return this._stepDiff(-1) }

  /** @returns {NavResult} */
  firstDifference() { return this._jumpDiff(0) }

  /** @returns {NavResult} */
  lastDifference() { return this._jumpDiff(this.getDiffCount() - 1) }

  /**
   * @param {number} delta
   * @returns {NavResult}
   */
  _stepDiff(delta) {
    // Routed through the shared helper so wrap-around obeys the same option
    // every other view reads, instead of this view inventing its own rule.
    const to = stepDiffIndex(this._currentDiffIdx, this.getDiffCount(), delta)
    return this._jumpDiff(to)
  }

  /**
   * @param {number} target
   * @returns {NavResult}
   */
  _jumpDiff(target) {
    const indices = diffRowIndices(this._rows)
    const from = this._currentDiffIdx
    if (indices.length === 0 || target < 0) return navResult(from, -1, indices.length)
    const clamped = Math.min(indices.length - 1, target)
    this._currentDiffIdx = clamped
    this._markCurrentRow()
    return navResult(from, clamped, indices.length)
  }

  /** Highlight and scroll to the row the navigation cursor is on. */
  _markCurrentRow() {
    const body = this._dom.rows
    if (!body) return
    const indices = diffRowIndices(this._rows)
    const rowIdx = indices[this._currentDiffIdx]
    for (const node of body.querySelectorAll('.mc-row')) {
      node.classList.toggle('mc-row--current', Number(node.dataset.index) === rowIdx)
    }
    if (rowIdx === undefined) return
    const current = body.querySelector(`.mc-row[data-index="${rowIdx}"]`)
    current?.scrollIntoView?.({ block: 'nearest' })
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  /** @returns {MetadataReportInfo} */
  getReportInfo() {
    return {
      leftPath: this._left?.path ?? '',
      rightPath: this._right?.path ?? '',
      kind: this._kind,
      rows: this._rows,
      notes: this._notes,
    }
  }

  /**
   * @param {{ generatedAt?: Date }} [opts]
   * @returns {string}
   */
  buildTextReport(opts = {}) {
    return buildMetadataTextReport(this.getReportInfo(), opts)
  }

  /**
   * @param {{ generatedAt?: Date }} [opts]
   * @returns {string}
   */
  buildHtmlReport(opts = {}) {
    return buildMetadataHtmlReport(this.getReportInfo(), opts)
  }

  /** @returns {Promise<void>} */
  async exportTextReport() {
    await window.electronAPI?.saveFile?.(
      'metadata-report.txt',
      this.buildTextReport(),
      [{ name: '純文字', extensions: ['txt'] }, { name: '所有檔案', extensions: ['*'] }])
  }

  /**
   * @param {{ print?: boolean }} [opts]
   * @returns {Promise<void>}
   */
  async exportHtml(opts = {}) {
    const html = this.buildHtmlReport()
    if (opts.print) {
      const blob = new Blob([html], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      const win = window.open(url, '_blank')
      if (win) {
        win.addEventListener('load', () => {
          try { win.print() } catch { /* the user dismissed the print dialog */ }
        })
        return
      }
      // Pop-up blocked: saving still gets the user their report.
    }
    await window.electronAPI?.saveFile?.(
      'metadata-report.html',
      html,
      [{ name: 'HTML', extensions: ['html'] }, { name: '所有檔案', extensions: ['*'] }])
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  /**
   * @param {string} event
   * @param {Function} handler
   * @returns {this}
   */
  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = []
    this._handlers[event].push(handler)
    return this
  }

  /**
   * @param {string} event
   * @param {Function} handler
   * @returns {this}
   */
  off(event, handler) {
    if (!this._handlers[event]) return this
    this._handlers[event] = this._handlers[event].filter((h) => h !== handler)
    return this
  }

  /**
   * @param {string} event
   * @param {object} payload
   */
  _emit(event, payload) {
    for (const h of this._handlers[event] ?? []) {
      try {
        h(payload)
      } catch (err) {
        console.error(`MetadataCompare event "${event}" handler error:`, err)
      }
    }
  }

  _emitPaths() {
    this._emit('paths-changed', {
      left: this._left?.path ?? '',
      right: this._right?.path ?? '',
    })
  }

  /**
   * @param {'left'|'right'} which
   * @param {string} path
   * @param {unknown} err
   */
  _fail(which, path, err) {
    const message = err instanceof Error ? err.message : String(err)
    this._emit('status', {
      message: `無法讀取${which === 'right' ? '右' : '左'}側中繼資料`
        + `${path ? `「${baseName(path)}」` : ''}：${message}`,
      level: 'error',
    })
  }

  // ── Model → DOM ────────────────────────────────────────────────────────────

  /** Recompute the model from the two loaded sides, then repaint. */
  _rebuild() {
    const { kind, rows } = buildMetadataRows(this._left?.meta, this._right?.meta)
    this._kind = kind
    this._rows = rows
    this._notes = metadataNotes(this._left, this._right, rows)
    this._currentDiffIdx = -1
    this._renderPaths()
    this._renderRows()
    this._renderNotes()
    this._renderStats()
    this._consumePendingFirstDiff()
  }

  /** Honour the "jump to the first difference on load" option. */
  _consumePendingFirstDiff() {
    if (!this._pendingFirstDiff) return
    this._pendingFirstDiff = false
    if (!getNavOptions().firstDiffOnLoad) return
    this.firstDifference()
  }

  _render() {
    if (!this._container) return
    this._container.innerHTML = ''

    const root = el('div', { className: 'metadata-compare' })
    root.appendChild(this._buildPathRow())
    root.appendChild(this._buildToolbar())
    root.appendChild(this._buildNotes())
    root.appendChild(this._buildGrid())
    root.appendChild(this._buildStats())
    this._container.appendChild(root)
    this._dom.root = root
    this._syncConfigControls()
  }

  /** @returns {HTMLElement} */
  _buildPathRow() {
    const row = el('div', { className: 'mc-path-row' })

    for (const which of /** @type {const} */ (['left', 'right'])) {
      const cell = el('div', { className: 'mc-path-cell' })
      const btn = el('button', {
        className: `mc-open-btn mc-open-${which}`,
        textContent: '開啟…',
        title: which === 'left' ? '選擇左側檔案' : '選擇右側檔案',
      })
      btn.addEventListener('click', () => { void this._openSide(which) })
      const disp = el('span', {
        className: `mc-path-display mc-path-${which}`,
        textContent: '（未選擇）',
      })
      cell.appendChild(btn)
      cell.appendChild(disp)
      row.appendChild(cell)
      this._dom[which === 'left' ? 'dispLeft' : 'dispRight'] = disp
    }
    return row
  }

  /** @returns {HTMLElement} */
  _buildToolbar() {
    const toolbar = el('div', { className: 'mc-toolbar' })

    const kindBadge = el('span', { className: 'mc-kind', textContent: '—' })
    this._dom.kind = kindBadge
    toolbar.appendChild(el('span', { className: 'mc-toolbar-label', textContent: '類型：' }))
    toolbar.appendChild(kindBadge)

    toolbar.appendChild(el('span', { className: 'mc-toolbar-sep' }))

    const onlyLabel = el('label', { className: 'mc-check-label', title: '隱藏相同的欄位' })
    const onlyCheck = /** @type {HTMLInputElement} */ (el('input', {
      type: 'checkbox', className: 'mc-only-diffs-check',
    }))
    onlyCheck.checked = this._showOnlyDiffs
    onlyCheck.addEventListener('change', () => this.setShowOnlyDiffs(onlyCheck.checked))
    this._dom.onlyDiffsCheck = onlyCheck
    onlyLabel.appendChild(onlyCheck)
    onlyLabel.appendChild(document.createTextNode(' 只顯示差異'))
    toolbar.appendChild(onlyLabel)

    toolbar.appendChild(el('span', { className: 'mc-toolbar-sep' }))

    const btnPrev = el('button', {
      className: 'mc-btn mc-btn-prev', textContent: '↑ 上一個差異', title: '上一個差異欄位',
    })
    btnPrev.addEventListener('click', () => { this.prevDifference() })
    toolbar.appendChild(btnPrev)

    const btnNext = el('button', {
      className: 'mc-btn mc-btn-next', textContent: '↓ 下一個差異', title: '下一個差異欄位',
    })
    btnNext.addEventListener('click', () => { this.nextDifference() })
    toolbar.appendChild(btnNext)

    toolbar.appendChild(el('span', { className: 'mc-toolbar-sep' }))

    const btnSwap = el('button', {
      className: 'mc-btn mc-btn-swap', textContent: '⇄ 交換', title: '交換左右兩側',
    })
    btnSwap.addEventListener('click', () => { void this.swap() })
    toolbar.appendChild(btnSwap)

    const btnRefresh = el('button', {
      className: 'mc-btn mc-btn-refresh', textContent: '⟳ 重新讀取', title: '從磁碟重新讀取兩側',
    })
    btnRefresh.addEventListener('click', () => { void this.refresh() })
    toolbar.appendChild(btnRefresh)

    this._dom.toolbar = toolbar
    return toolbar
  }

  /** @returns {HTMLElement} */
  _buildNotes() {
    const notes = el('div', { className: 'mc-notes' })
    this._dom.notes = notes
    return notes
  }

  /** @returns {HTMLElement} */
  _buildGrid() {
    const grid = el('div', { className: 'mc-grid' })

    const header = el('div', { className: 'mc-row mc-row--header' })
    header.appendChild(el('div', { className: 'mc-cell mc-cell-field', textContent: '欄位' }))
    header.appendChild(el('div', { className: 'mc-cell mc-cell-value', textContent: '左側' }))
    header.appendChild(el('div', { className: 'mc-cell mc-cell-value', textContent: '右側' }))
    grid.appendChild(header)

    const rows = el('div', { className: 'mc-rows' })
    this._dom.rows = rows
    grid.appendChild(rows)

    this._dom.grid = grid
    return grid
  }

  /** @returns {HTMLElement} */
  _buildStats() {
    const bar = el('div', { className: 'mc-stats' })
    const text = el('span', { className: 'mc-stats-text', textContent: '尚未載入檔案' })
    bar.appendChild(text)
    this._dom.stats = text
    return bar
  }

  _renderPaths() {
    const set = (node, path) => {
      if (!node) return
      node.textContent = path || '（未選擇）'
      node.title = path || ''
    }
    set(this._dom.dispLeft, this._left?.path ?? '')
    set(this._dom.dispRight, this._right?.path ?? '')
    const badge = this._dom.kind
    if (badge) badge.textContent = KIND_LABELS[this._kind] ?? this._kind
  }

  _renderRows() {
    const body = this._dom.rows
    if (!body) return
    body.replaceChildren()

    // The index carried on each node is the model index, not the position in
    // the list: with "只顯示差異" on they differ, and navigation addresses the
    // model.
    this._rows.forEach((row, index) => {
      if (this._showOnlyDiffs && row.state === 'same') return
      body.appendChild(this._buildRow(row, index))
    })

    if (!body.children.length) {
      body.appendChild(el('div', {
        className: 'mc-empty',
        textContent: this._rows.length
          ? '所有欄位都相同（已勾選「只顯示差異」）'
          : '沒有可比對的欄位',
      }))
    }
    this._markCurrentRow()
  }

  /**
   * @param {FieldRow} row
   * @param {number} index
   * @returns {HTMLElement}
   */
  _buildRow(row, index) {
    const node = el('div', { className: `mc-row mc-row--${row.state}` })
    node.dataset.index = String(index)
    node.dataset.field = row.field
    node.dataset.state = row.state
    if (row.group === 'audio') node.classList.add('mc-row--audio')

    const name = el('div', { className: 'mc-cell mc-cell-field', textContent: row.label })
    name.title = row.field
    node.appendChild(name)
    node.appendChild(this._buildValueCell(row.left, row.leftPresent))
    node.appendChild(this._buildValueCell(row.right, row.rightPresent))

    node.addEventListener('contextmenu', (e) => this._onRowContextMenu(e, row))
    return node
  }

  /**
   * @param {string|null} value
   * @param {boolean} present
   * @returns {HTMLElement}
   */
  _buildValueCell(value, present) {
    const cell = el('div', { className: 'mc-cell mc-cell-value' })
    if (!present) {
      cell.classList.add('mc-cell--absent')
      cell.textContent = '（無此欄位）'
      return cell
    }
    if (value === '') {
      // Present but empty is a real, different answer from absent, and the two
      // used to look identical in this kind of grid.
      cell.classList.add('mc-cell--empty')
      cell.textContent = '（空白）'
      return cell
    }
    cell.textContent = value
    cell.title = value
    return cell
  }

  /**
   * @param {MouseEvent} e
   * @param {FieldRow} row
   */
  _onRowContextMenu(e, row) {
    e.preventDefault()
    showContextMenu(e, [
      {
        label: '複製左側值',
        disabled: !row.leftPresent,
        action: () => void this._copy(row.left ?? ''),
      },
      {
        label: '複製右側值',
        disabled: !row.rightPresent,
        action: () => void this._copy(row.right ?? ''),
      },
      { separator: true },
      {
        label: '複製整列',
        action: () => void this._copy(
          `${row.label}\t${row.left ?? ''}\t${row.right ?? ''}`),
      },
    ])
  }

  /**
   * @param {string} text
   * @returns {Promise<void>}
   */
  async _copy(text) {
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        throw new Error('此環境不提供剪貼簿寫入')
      }
      await navigator.clipboard.writeText(text)
      this._emit('status', { message: '已複製到剪貼簿' })
    } catch (err) {
      this._emit('status', {
        message: `複製失敗：${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      })
    }
  }

  _renderNotes() {
    const box = this._dom.notes
    if (!box) return
    box.replaceChildren()
    box.style.display = this._notes.length ? '' : 'none'
    for (const note of this._notes) {
      box.appendChild(el('div', { className: 'mc-note', textContent: note }))
    }
  }

  _renderStats() {
    const stats = this._dom.stats
    if (!stats) return
    if (!this._left && !this._right) {
      stats.textContent = '尚未載入檔案'
      return
    }
    const c = countRows(this._rows)
    stats.textContent = `欄位 ${c.total}：相同 ${c.same}、不同 ${c.different}、`
      + `僅左側 ${c.leftOnly}、僅右側 ${c.rightOnly}`
  }
}
