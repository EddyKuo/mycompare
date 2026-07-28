/**
 * Text Edit — BC's standalone editor view.
 *
 * Everything else in this program compares two things. This one opens a single
 * file, and it is the only place Find in Files lives — the one search that
 * crosses file boundaries.
 *
 * The editor is a transparent `<textarea>` over a highlighted `<pre>` underlay.
 * That is the usual way to get syntax highlighting and a real caret at once,
 * and it has one hard requirement: **the two layers must agree on every metric
 * that affects where a glyph lands.** Font, size, line height, padding,
 * tab-size and wrapping are set from the same variables for both; a difference
 * in any of them shows up as text drifting out from under the caret, which is
 * why they are not tweaked independently.
 */
import { isActive } from '../core/active-view.js'
import { showContextMenu, closeContextMenu } from '../core/context-menu.js'
import { prompt as promptDialog, confirm as confirmDialog } from '../core/modal.js'
import { el } from '../core/utils.js'
import { toast } from '../core/toast.js'
import { SettingsStore } from '../core/settings-store.js'
import { detectEol } from '../core/eol-detect.js'
import '../styles/text-edit.css'

/** The same store the compare views use, so backup rules are one setting. */
const _settings = new SettingsStore()

/** How many undo snapshots to keep. */
const UNDO_CAP = 200

/** Extension to highlight.js language, mirroring the text compare view. */
const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', java: 'java', cs: 'csharp',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', h: 'c',
  go: 'go', rs: 'rust', html: 'html', htm: 'html', css: 'css',
  json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', sql: 'sql',
  md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
}

/** Save dialog filters, shared with the compare views. */
const SAVE_FILTERS = [
  { name: '文字檔', extensions: Object.keys(EXT_LANG).concat('txt') },
  { name: '所有檔案', extensions: ['*'] },
]

/**
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

/**
 * Replace the characters that have no width of their own.
 *
 * Only ever applied to the underlay. Doing it to the textarea would change the
 * text the user is editing.
 *
 * @param {string} s
 * @returns {string}
 */
export function showWhitespace(s) {
  return String(s ?? '').replace(/ /g, '·').replace(/\t/g, '→\t')
}

/**
 * The line and column a character offset falls on.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{ line: number, column: number }}
 */
export function offsetToLineCol(text, offset) {
  const upto = String(text ?? '').slice(0, Math.max(0, offset))
  const lines = upto.split('\n')
  return { line: lines.length, column: lines[lines.length - 1].length + 1 }
}

/**
 * The character offset of a 1-based line and column.
 *
 * @param {string} text
 * @param {number} line
 * @param {number} [column]
 * @returns {number}
 */
export function lineColToOffset(text, line, column = 1) {
  const lines = String(text ?? '').split('\n')
  const n = Math.min(Math.max(1, line), lines.length)
  let offset = 0
  for (let i = 0; i < n - 1; i++) offset += lines[i].length + 1
  return offset + Math.min(Math.max(1, column) - 1, lines[n - 1].length)
}

/**
 * The bounds of the line containing an offset.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{ start: number, end: number }} end excludes the newline
 */
export function lineBoundsAt(text, offset) {
  const s = String(text ?? '')
  const at = Math.min(Math.max(0, offset), s.length)
  const start = s.lastIndexOf('\n', at - 1) + 1
  const nl = s.indexOf('\n', at)
  return { start, end: nl === -1 ? s.length : nl }
}

/**
 * The bounds of the word around an offset.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{ start: number, end: number }}
 */
export function wordBoundsAt(text, offset) {
  const s = String(text ?? '')
  const at = Math.min(Math.max(0, offset), s.length)
  const isWord = (ch) => /[\w$]/.test(ch)
  let start = at
  let end = at
  while (start > 0 && isWord(s[start - 1])) start--
  while (end < s.length && isWord(s[end])) end++
  // Not inside a word: take the run of whatever is there, so the command still
  // does something predictable rather than nothing.
  if (start === end) {
    while (end < s.length && !isWord(s[end]) && s[end] !== '\n') end++
  }
  return { start, end }
}

export class TextEdit {
  constructor() {
    /** @type {string} */
    this._path = ''
    /** @type {string} */
    this._content = ''
    /** @type {string} */
    this._encoding = 'UTF-8'
    /**
     * Line ending, kept beside the text rather than inside it.
     *
     * A textarea cannot hold one: the HTML spec normalises its value's line
     * breaks to LF, so a CRLF written into the buffer is already gone by the
     * time it is read back. Keeping the style separately and applying it on
     * save is the only way the setting can mean anything.
     *
     * @type {'CRLF'|'LF'|'CR'}
     */
    this._eol = 'LF'
    /** @type {boolean} */
    this._modified = false

    /** @type {string[]} */
    this._undo = []
    /** @type {string[]} */
    this._redo = []

    this._showWhitespace = false
    this._showLineNumbers = true
    this._highlight = true
    /** @type {Set<number>} 1-based line numbers */
    this._bookmarks = new Set()
    /** @type {{hljs: object, langId: string}|null} */
    this._hl = null
    /** @type {number} the offset of the last programmatic edit, for Next Edit */
    this._editMarks = []
    this._editMarkIdx = -1

    /** @type {Record<string, Function[]>} */
    this._handlers = {}
    /** @type {HTMLElement|null} */
    this._container = null
    /** @type {Record<string, HTMLElement>} */
    this._dom = {}
    this._mounted = false
    this._onKeyDown = this._onKeyDown.bind(this)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** @param {HTMLElement} containerEl */
  mount(containerEl) {
    this._container = containerEl
    this._render()
    this._mounted = true
    document.addEventListener('keydown', this._onKeyDown)
  }

  destroy() {
    closeContextMenu()
    document.removeEventListener('keydown', this._onKeyDown)
    this._mounted = false
    if (this._container) {
      this._container.innerHTML = ''
      this._container = null
    }
    this._handlers = {}
    this._dom = {}
  }

  // ── Loading and saving ─────────────────────────────────────────────────────

  /** @returns {string} */
  getPath() { return this._path }
  /** @returns {string} */
  getContent() { return this._textarea()?.value ?? this._content }
  /** @returns {boolean} */
  isModified() { return this._modified }
  /** @returns {number[]} */
  getBookmarks() { return [...this._bookmarks].sort((a, b) => a - b) }

  /**
   * @param {string} path
   * @param {string} content
   * @param {string} [encoding]
   */
  setContent(path, content, encoding = 'UTF-8') {
    this._path = path ?? ''
    this._content = String(content ?? '')
    this._encoding = encoding || 'UTF-8'
    this._eol = detectEol(this._content)
    this._modified = false
    this._undo = []
    this._redo = []
    this._bookmarks = new Set()
    this._editMarks = []
    this._editMarkIdx = -1
    void this._loadHighlighter()
    const ta = this._textarea()
    if (ta) ta.value = this._content
    this._repaint()
    this._emit('paths-changed', { left: this._path, right: '' })
  }

  /** @returns {Promise<void>} */
  async openFile() {
    if (!(await this._confirmDiscard())) return
    try {
      const result = await window.electronAPI?.openFile?.({ filters: SAVE_FILTERS })
      if (!result?.path) return
      this.setContent(result.path, result.content ?? '', result.encoding)
    } catch (err) {
      this._fail('無法開啟檔案', err)
    }
  }

  /**
   * @param {string} path
   * @returns {Promise<void>}
   */
  async openPath(path) {
    if (!path) return
    try {
      const result = await window.electronAPI?.readFile?.(path)
      const content = typeof result === 'string' ? result : result?.content ?? ''
      this.setContent(path, content, result?.encoding)
    } catch (err) {
      this._fail(`無法開啟 ${path}`, err)
    }
  }

  /**
   * Write the buffer back, keeping the encoding it was read in.
   *
   * @returns {Promise<void>}
   */
  async save() {
    const content = this.contentForSave()
    try {
      const result = await window.electronAPI?.saveFile?.(
        this._path || 'untitled.txt', content, SAVE_FILTERS,
        this._encoding, _settings.getBackupOptions())
      // A cancelled dialog returns falsy. Clearing the flag anyway would tell
      // the user their edits were written and let the tab close without a
      // prompt, losing them.
      if (!result) return
      if (result.path) this._path = result.path
      this._content = this.getContent()
      this._modified = false
      this._repaint()
      toast('已儲存')
    } catch (err) {
      this._fail('儲存失敗', err)
    }
  }

  /** @returns {Promise<void>} */
  async saveAs() {
    const keep = this._path
    this._path = ''
    await this.save()
    if (!this._path) this._path = keep
  }

  /** @returns {Promise<boolean>} */
  async _confirmDiscard() {
    if (!this._modified) return true
    return confirmDialog({
      title: '尚未儲存的變更',
      message: '目前的檔案有未儲存的變更，繼續會將它們丟棄。要繼續嗎？',
      okText: '丟棄',
    })
  }

  // ── Editing primitives ─────────────────────────────────────────────────────

  /** @returns {HTMLTextAreaElement|null} */
  _textarea() {
    return /** @type {HTMLTextAreaElement|null} */ (this._dom.textarea ?? null)
  }

  /** Record the buffer so the next change can be undone. */
  _snapshot() {
    this._undo.push(this.getContent())
    if (this._undo.length > UNDO_CAP) this._undo.splice(0, this._undo.length - UNDO_CAP)
    this._redo = []
  }

  /**
   * Replace a range and put the caret where the caller asks.
   *
   * @param {number} start
   * @param {number} end
   * @param {string} insert
   * @param {number} [caret] absolute offset; defaults to the end of the insert
   */
  replaceRange(start, end, insert, caret) {
    const ta = this._textarea()
    const text = this.getContent()
    this._snapshot()
    const next = text.slice(0, start) + insert + text.slice(end)
    this._content = next
    if (ta) {
      ta.value = next
      const at = caret ?? start + insert.length
      ta.selectionStart = at
      ta.selectionEnd = at
    }
    this._markEdit(start)
    this._setModified(true)
    this._repaint()
  }

  /** @param {number} offset */
  _markEdit(offset) {
    this._editMarks.push(offset)
    if (this._editMarks.length > UNDO_CAP) this._editMarks.shift()
    this._editMarkIdx = this._editMarks.length - 1
  }

  /** @param {boolean} on */
  _setModified(on) {
    this._modified = on
    this._emit('modified-changed', { modified: on })
  }

  /** @returns {{start: number, end: number}} */
  _selection() {
    const ta = this._textarea()
    if (!ta) return { start: 0, end: 0 }
    return { start: ta.selectionStart ?? 0, end: ta.selectionEnd ?? 0 }
  }

  undo() {
    if (!this._undo.length) return false
    this._redo.push(this.getContent())
    const prev = this._undo.pop()
    this._content = prev
    const ta = this._textarea()
    if (ta) ta.value = prev
    this._setModified(true)
    this._repaint()
    return true
  }

  redo() {
    if (!this._redo.length) return false
    this._undo.push(this.getContent())
    const next = this._redo.pop()
    this._content = next
    const ta = this._textarea()
    if (ta) ta.value = next
    this._setModified(true)
    this._repaint()
    return true
  }

  selectAll() {
    const ta = this._textarea()
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(0, ta.value.length)
  }

  /** Delete the line the caret is on, newline included. */
  deleteLine() {
    const text = this.getContent()
    const { start } = this._selection()
    const b = lineBoundsAt(text, start)
    const end = b.end < text.length ? b.end + 1 : b.end
    this.replaceRange(b.start, end, '', b.start)
  }

  /** @param {'start'|'end'} where */
  deleteToLineEdge(where) {
    const text = this.getContent()
    const { start } = this._selection()
    const b = lineBoundsAt(text, start)
    if (where === 'start') this.replaceRange(b.start, start, '', b.start)
    else this.replaceRange(start, b.end, '', start)
  }

  deleteWord() {
    const text = this.getContent()
    const { start } = this._selection()
    const w = wordBoundsAt(text, start)
    this.replaceRange(w.start, w.end, '', w.start)
  }

  /** @param {'start'|'end'} where */
  deleteToWordEdge(where) {
    const text = this.getContent()
    const { start } = this._selection()
    const w = wordBoundsAt(text, start)
    if (where === 'start') this.replaceRange(w.start, start, '', w.start)
    else this.replaceRange(start, w.end, '', start)
  }

  /** @param {'before'|'after'} where */
  insertLine(where) {
    const text = this.getContent()
    const { start } = this._selection()
    const b = lineBoundsAt(text, start)
    if (where === 'before') this.replaceRange(b.start, b.start, '\n', b.start)
    else this.replaceRange(b.end, b.end, '\n', b.end + 1)
  }

  /**
   * Indent or unindent every line the selection touches.
   *
   * @param {1|-1} direction
   */
  indent(direction) {
    const text = this.getContent()
    const sel = this._selection()
    const first = lineBoundsAt(text, sel.start).start
    const last = lineBoundsAt(text, sel.end).end
    const block = text.slice(first, last)
    const next = block.split('\n').map((line) => (
      direction === 1 ? `  ${line}` : line.replace(/^(\t| {1,2})/, '')
    )).join('\n')
    this.replaceRange(first, last, next, first)
    const ta = this._textarea()
    if (ta) ta.setSelectionRange(first, first + next.length)
  }

  // ── Convert File ───────────────────────────────────────────────────────────

  trimTrailingWhitespace() {
    const next = this.getContent().split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    this._replaceAll(next)
  }

  /** @param {number} [width] */
  tabsToSpaces(width = 4) {
    this._replaceAll(this.getContent().replace(/\t/g, ' '.repeat(width)))
  }

  /** @param {number} [width] */
  spacesToTabs(width = 4) {
    // Leading runs only. Converting every run would corrupt aligned columns and
    // anything inside a string literal — the spaces there are content.
    this._replaceAll(this.getContent().split('\n').map((line) => {
      const lead = line.match(/^ +/)
      if (!lead) return line
      const full = Math.floor(lead[0].length / width)
      if (!full) return line
      return '\t'.repeat(full) + line.slice(full * width)
    }).join('\n'))
  }

  /** @param {'crlf'|'lf'|'cr'} eol */
  setLineEndings(eol) {
    const want = String(eol ?? '').toUpperCase()
    if (want !== 'CRLF' && want !== 'LF' && want !== 'CR') return this._eol
    if (want !== this._eol) {
      this._eol = /** @type {'CRLF'|'LF'|'CR'} */ (want)
      this._setModified(true)
      this._repaint()
    }
    return this._eol
  }

  /** @returns {'CRLF'|'LF'|'CR'} */
  getLineEndings() { return this._eol }

  /**
   * The text to write out: the buffer with its line endings restored.
   *
   * @returns {string}
   */
  contentForSave() {
    const body = this.getContent().replace(/\r\n|\r|\n/g, '\n')
    if (this._eol === 'LF') return body
    return body.split('\n').join(this._eol === 'CRLF' ? '\r\n' : '\r')
  }

  /** @param {string} next */
  _replaceAll(next) {
    if (next === this.getContent()) return
    this.replaceRange(0, this.getContent().length, next, 0)
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  /**
   * @param {string} query
   * @param {{regex?: boolean, caseSensitive?: boolean, backwards?: boolean}} [opts]
   * @returns {boolean} whether a match was found
   */
  findNext(query, opts = {}) {
    const text = this.getContent()
    if (!query) return false
    const flags = opts.caseSensitive ? 'g' : 'gi'
    const source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let re
    try {
      re = new RegExp(source, flags)
    } catch {
      this._fail('搜尋樣式無法解讀', new Error(query))
      return false
    }

    const from = this._selection().end
    /** @type {RegExpExecArray|null} */
    let hit = null
    let m
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) re.lastIndex++
      if (opts.backwards) {
        if (m.index < this._selection().start) hit = m
        else break
      } else if (m.index >= from) { hit = m; break }
    }
    // Wrap around, so a search never silently reports nothing when the only
    // match is behind the caret.
    if (!hit) {
      re.lastIndex = 0
      hit = re.exec(text)
    }
    if (!hit) return false

    const ta = this._textarea()
    if (ta) {
      ta.focus()
      ta.setSelectionRange(hit.index, hit.index + hit[0].length)
      this._scrollToOffset(hit.index)
    }
    return true
  }

  /**
   * @param {string} query
   * @param {string} replacement
   * @param {object} [opts]
   * @returns {number} how many were replaced
   */
  replaceAll(query, replacement, opts = {}) {
    if (!query) return 0
    const source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let re
    try {
      re = new RegExp(source, opts.caseSensitive ? 'g' : 'gi')
    } catch {
      this._fail('搜尋樣式無法解讀', new Error(query))
      return 0
    }
    const text = this.getContent()
    let count = 0
    const next = text.replace(re, () => { count++; return replacement })
    if (count) this._replaceAll(next)
    return count
  }

  /**
   * BC's Find in Files — the only search here that leaves the open file.
   *
   * @param {{ root: string, query: string, mask?: string, regex?: boolean, caseSensitive?: boolean }} opts
   * @returns {Promise<object|null>}
   */
  async findInFiles(opts) {
    try {
      const result = await window.electronAPI?.findInFiles?.(opts)
      if (!result) return null
      this._renderFindResults(result, opts)
      return result
    } catch (err) {
      this._fail('搜尋失敗', err)
      return null
    }
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  /**
   * @param {number} line 1-based
   * @param {number} [column]
   */
  goToLine(line, column = 1) {
    const ta = this._textarea()
    const offset = lineColToOffset(this.getContent(), line, column)
    if (ta) {
      ta.focus()
      ta.setSelectionRange(offset, offset)
      this._scrollToOffset(offset)
    }
    this._repaint()
  }

  toggleBookmark() {
    const { line } = offsetToLineCol(this.getContent(), this._selection().start)
    if (this._bookmarks.has(line)) this._bookmarks.delete(line)
    else this._bookmarks.add(line)
    this._repaint()
    return this._bookmarks.has(line)
  }

  clearBookmarks() {
    this._bookmarks.clear()
    this._repaint()
  }

  /** @param {1|-1} direction */
  goToBookmark(direction) {
    const marks = this.getBookmarks()
    if (!marks.length) return false
    const { line } = offsetToLineCol(this.getContent(), this._selection().start)
    const next = direction === 1
      ? marks.find((l) => l > line) ?? marks[0]
      : [...marks].reverse().find((l) => l < line) ?? marks[marks.length - 1]
    this.goToLine(next)
    return true
  }

  /** @param {1|-1} direction */
  goToEdit(direction) {
    if (!this._editMarks.length) return false
    this._editMarkIdx = Math.min(
      this._editMarks.length - 1,
      Math.max(0, this._editMarkIdx + direction))
    const offset = this._editMarks[this._editMarkIdx]
    const { line } = offsetToLineCol(this.getContent(), offset)
    this.goToLine(line)
    return true
  }

  // ── Display toggles ────────────────────────────────────────────────────────

  /** @param {boolean} [on] */
  setVisibleWhitespace(on) {
    this._showWhitespace = on == null ? !this._showWhitespace : Boolean(on)
    this._repaint()
    return this._showWhitespace
  }

  /** @param {boolean} [on] */
  setLineNumbers(on) {
    this._showLineNumbers = on == null ? !this._showLineNumbers : Boolean(on)
    this._dom.root?.classList.toggle('te-no-gutter', !this._showLineNumbers)
    this._repaint()
    return this._showLineNumbers
  }

  /** @param {boolean} [on] */
  setHighlight(on) {
    this._highlight = on == null ? !this._highlight : Boolean(on)
    this._repaint()
    return this._highlight
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
        console.error(`TextEdit event "${event}" handler error:`, err)
      }
    }
  }

  /**
   * @param {string} what
   * @param {unknown} err
   */
  _fail(what, err) {
    this._emit('status', {
      message: `${what}：${err instanceof Error ? err.message : String(err)}`,
      level: 'error',
    })
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  /** @param {KeyboardEvent} e */
  _onKeyDown(e) {
    if (!this._mounted || !isActive('textedit')) return
    const ctrl = e.ctrlKey || e.metaKey

    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); void this.save() }
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); void this.saveAs() }
    else if (ctrl && e.key.toLowerCase() === 'g') { e.preventDefault(); void this._promptGoTo() }
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); void this._promptFindInFiles() }
    else if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); void this._promptFind() }
    else if (ctrl && e.key.toLowerCase() === 'h') { e.preventDefault(); void this._promptReplace() }
    else if (ctrl && e.key === 'F2') { e.preventDefault(); this.toggleBookmark() }
    else if (e.key === 'F2') { e.preventDefault(); this.goToBookmark(e.shiftKey ? -1 : 1) }
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); this.deleteLine() }
  }

  // ── Prompts ────────────────────────────────────────────────────────────────

  /** @returns {Promise<void>} */
  async _promptGoTo() {
    const answer = await promptDialog({ title: '移至', message: '行號' })
    const line = Number(answer)
    if (!answer || !Number.isFinite(line)) return
    this.goToLine(line)
  }

  /** @returns {Promise<void>} */
  async _promptFind() {
    const q = await promptDialog({ title: '尋找', message: '搜尋內容', defaultValue: this._lastQuery ?? '' })
    if (!q) return
    this._lastQuery = q
    if (!this.findNext(q)) this._emit('status', { message: '找不到相符的內容', level: 'warn' })
  }

  /** @returns {Promise<void>} */
  async _promptReplace() {
    const q = await promptDialog({ title: '取代', message: '搜尋內容', defaultValue: this._lastQuery ?? '' })
    if (!q) return
    const r = await promptDialog({ title: '取代', message: '取代為', defaultValue: '' })
    if (r === null) return
    const n = this.replaceAll(q, r)
    toast(n ? `已取代 ${n} 處` : '找不到相符的內容')
  }

  /** @returns {Promise<void>} */
  async _promptFindInFiles() {
    const folder = await window.electronAPI?.openFolder?.()
    const root = typeof folder === 'string' ? folder : folder?.path
    if (!root) return
    const query = await promptDialog({ title: '在檔案中尋找', message: '搜尋內容' })
    if (!query) return
    const mask = await promptDialog({
      title: '在檔案中尋找',
      message: '檔案遮罩（留空代表全部，支援 *.js;-*.min.js 這類語法）',
      defaultValue: '',
    })
    if (mask === null) return
    await this.findInFiles({ root, query, mask })
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _render() {
    if (!this._container) return
    this._container.innerHTML = ''
    const root = el('div', { className: 'text-edit' })
    root.appendChild(this._buildToolbar())
    root.appendChild(this._buildEditor())
    root.appendChild(this._buildResults())
    root.appendChild(this._buildStatus())
    this._container.appendChild(root)
    this._dom.root = root
    this._repaint()
  }

  /** @returns {HTMLElement} */
  _buildToolbar() {
    const bar = el('div', { className: 'te-toolbar' })
    /**
     * @param {string} label
     * @param {string} title
     * @param {() => void} action
     */
    const btn = (label, title, action) => {
      const b = el('button', { className: 'te-btn', textContent: label, title })
      b.addEventListener('click', action)
      bar.appendChild(b)
      return b
    }

    btn('開啟…', '開啟檔案', () => { void this.openFile() })
    btn('儲存', '儲存（Ctrl+S）', () => { void this.save() })
    btn('另存…', '另存新檔（Ctrl+Shift+S）', () => { void this.saveAs() })
    bar.appendChild(el('span', { className: 'te-sep' }))
    btn('↶', '復原', () => this.undo())
    btn('↷', '重做', () => this.redo())
    bar.appendChild(el('span', { className: 'te-sep' }))
    btn('尋找', '尋找（Ctrl+F）', () => { void this._promptFind() })
    btn('取代', '取代（Ctrl+H）', () => { void this._promptReplace() })
    btn('在檔案中尋找', 'Find in Files（Ctrl+Shift+F）', () => { void this._promptFindInFiles() })
    bar.appendChild(el('span', { className: 'te-sep' }))
    this._dom.btnWs = btn('␣', '可見空白', () => { this.setVisibleWhitespace(); this._syncToggles() })
    this._dom.btnNums = btn('#', '行號', () => { this.setLineNumbers(); this._syncToggles() })
    this._dom.btnHl = btn('語法', '語法高亮', () => { this.setHighlight(); this._syncToggles() })
    return bar
  }

  _syncToggles() {
    this._dom.btnWs?.classList.toggle('active', this._showWhitespace)
    this._dom.btnNums?.classList.toggle('active', this._showLineNumbers)
    this._dom.btnHl?.classList.toggle('active', this._highlight)
  }

  /** @returns {HTMLElement} */
  _buildEditor() {
    const wrap = el('div', { className: 'te-editor' })
    const gutter = el('div', { className: 'te-gutter' })
    const stack = el('div', { className: 'te-stack' })
    const under = el('pre', { className: 'te-under' })
    const code = el('code', { className: 'te-code' })
    under.appendChild(code)

    const ta = /** @type {HTMLTextAreaElement} */ (el('textarea', {
      className: 'te-input', spellcheck: false,
    }))
    ta.setAttribute('wrap', 'off')
    ta.addEventListener('input', () => {
      this._snapshot()
      this._content = ta.value
      this._markEdit(ta.selectionStart ?? 0)
      this._setModified(true)
      this._repaint()
    })
    // The underlay has to follow the textarea exactly, or the highlighted text
    // drifts away from the caret as soon as the file is wider or taller than
    // the viewport.
    ta.addEventListener('scroll', () => {
      under.scrollTop = ta.scrollTop
      under.scrollLeft = ta.scrollLeft
      gutter.scrollTop = ta.scrollTop
    })
    ta.addEventListener('click', () => this._renderStatus())
    ta.addEventListener('keyup', () => this._renderStatus())
    ta.addEventListener('contextmenu', (e) => this._onContextMenu(e))

    stack.appendChild(under)
    stack.appendChild(ta)
    wrap.appendChild(gutter)
    wrap.appendChild(stack)

    this._dom.gutter = gutter
    this._dom.under = under
    this._dom.code = code
    this._dom.textarea = ta
    return wrap
  }

  /** @returns {HTMLElement} */
  _buildResults() {
    const panel = el('div', { className: 'te-results', style: 'display:none' })
    this._dom.results = panel
    return panel
  }

  /** @returns {HTMLElement} */
  _buildStatus() {
    const bar = el('div', { className: 'te-status' })
    this._dom.status = bar
    return bar
  }

  /** Redraw the gutter, the underlay and the status line. */
  _repaint() {
    const ta = this._textarea()
    if (!ta || !this._dom.code) return
    const text = ta.value ?? ''
    const lines = text.split('\n')

    if (this._dom.gutter) {
      const marks = this._bookmarks
      this._dom.gutter.replaceChildren(...lines.map((_, i) => el('div', {
        className: `te-lineno${marks.has(i + 1) ? ' te-bookmarked' : ''}`,
        textContent: String(i + 1),
      })))
    }

    const shown = this._showWhitespace ? showWhitespace(text) : text
    if (this._highlight && this._hl) {
      try {
        this._dom.code.innerHTML = this._hl.hljs
          .highlight(shown, { language: this._hl.langId, ignoreIllegals: true }).value
      } catch {
        this._dom.code.textContent = shown
      }
    } else {
      this._dom.code.textContent = shown
    }
    this._renderStatus()
  }

  _renderStatus() {
    const bar = this._dom.status
    if (!bar) return
    const ta = this._textarea()
    const text = ta?.value ?? ''
    const { line, column } = offsetToLineCol(text, ta?.selectionStart ?? 0)
    const marks = this._bookmarks.size
    bar.textContent = `${this._path || '（未命名）'}`
      + `　行 ${line}，欄 ${column}　共 ${text.split('\n').length} 行`
      + `　${this._encoding}　${this._eol}`
      + (marks ? `　書籤 ${marks}` : '')
      + (this._modified ? '　●　已修改' : '')
  }

  /**
   * @param {object} result
   * @param {object} opts
   */
  _renderFindResults(result, opts) {
    const panel = this._dom.results
    if (!panel) return
    panel.replaceChildren()
    panel.style.display = 'block'

    const head = el('div', { className: 'te-results-head' })
    const summary = result.matches.length
      ? `找到 ${result.matches.length} 處，掃描 ${result.filesScanned} 個檔案`
      : `找不到「${opts.query}」，掃描 ${result.filesScanned} 個檔案`
    // Every limit is reported. A truncated list that looks complete is the
    // failure this project keeps writing down.
    const notes = []
    if (result.truncated === 'matches') notes.push('已達結果上限，僅顯示前面的部分')
    if (result.truncated === 'files') notes.push('已達檔案數上限，未掃描完整個資料夾')
    if (result.filesSkipped) notes.push(`略過 ${result.filesSkipped} 個二進位或過大的檔案`)
    head.textContent = summary + (notes.length ? `　（${notes.join('；')}）` : '')

    const close = el('button', { className: 'te-btn te-results-close', textContent: '✕', title: '關閉' })
    close.addEventListener('click', () => { panel.style.display = 'none' })
    head.appendChild(close)
    panel.appendChild(head)

    const list = el('div', { className: 'te-results-list' })
    for (const m of result.matches) {
      const row = el('div', { className: 'te-result' })
      row.appendChild(el('span', { className: 'te-result-path', textContent: `${m.relPath}:${m.line}` }))
      row.appendChild(el('span', { className: 'te-result-text', textContent: m.text }))
      row.addEventListener('dblclick', () => { void this._openResult(m) })
      list.appendChild(row)
    }
    panel.appendChild(list)
  }

  /**
   * @param {{path: string, line: number, column: number}} m
   * @returns {Promise<void>}
   */
  async _openResult(m) {
    if (m.path !== this._path) {
      if (!(await this._confirmDiscard())) return
      await this.openPath(m.path)
    }
    this.goToLine(m.line, m.column)
  }

  /** @param {number} offset */
  _scrollToOffset(offset) {
    const ta = this._textarea()
    if (!ta) return
    const { line } = offsetToLineCol(ta.value, offset)
    const lineHeight = ta.scrollHeight / Math.max(1, ta.value.split('\n').length)
    const target = (line - 1) * lineHeight
    const viewport = ta.clientHeight || 400
    if (target < ta.scrollTop || target > ta.scrollTop + viewport) {
      ta.scrollTop = Math.max(0, target - viewport / 2)
      this._dom.under.scrollTop = ta.scrollTop
      this._dom.gutter.scrollTop = ta.scrollTop
    }
  }

  /** @param {MouseEvent} e */
  _onContextMenu(e) {
    showContextMenu(e, [
      { label: '復原', action: () => this.undo() },
      { label: '重做', action: () => this.redo() },
      { separator: true },
      { label: '全選', action: () => this.selectAll() },
      { separator: true },
      { label: '刪除整行', action: () => this.deleteLine() },
      { label: '刪除到行首', action: () => this.deleteToLineEdge('start') },
      { label: '刪除到行尾', action: () => this.deleteToLineEdge('end') },
      { label: '刪除單字', action: () => this.deleteWord() },
      { separator: true },
      { label: '在上方插入一行', action: () => this.insertLine('before') },
      { label: '在下方插入一行', action: () => this.insertLine('after') },
      { label: '增加縮排', action: () => this.indent(1) },
      { label: '減少縮排', action: () => this.indent(-1) },
      { separator: true },
      { label: '去除行尾空白', action: () => this.trimTrailingWhitespace() },
      { label: 'Tab 轉空白', action: () => this.tabsToSpaces() },
      { label: '行尾符號：CRLF', action: () => this.setLineEndings('crlf') },
      { label: '行尾符號：LF', action: () => this.setLineEndings('lf') },
      { separator: true },
      { label: '切換書籤', action: () => this.toggleBookmark() },
      { label: '清除所有書籤', action: () => this.clearBookmarks() },
    ])
  }

  /** @returns {Promise<void>} */
  async _loadHighlighter() {
    const ext = (this._path.split('.').pop() ?? '').toLowerCase()
    const langId = EXT_LANG[ext]
    if (!langId) { this._hl = null; return }
    try {
      const mod = await import('highlight.js/lib/core')
      const hljs = mod.default ?? mod
      if (!hljs.getLanguage(langId)) {
        const lang = await import(/* @vite-ignore */ `highlight.js/lib/languages/${langId}`)
        hljs.registerLanguage(langId, lang.default)
      }
      this._hl = { hljs, langId }
      this._repaint()
    } catch {
      this._hl = null
    }
  }
}
