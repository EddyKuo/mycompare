/**
 * @file session-home-ui.js
 * @description Session Home page interaction logic.
 * Renders the "Recent Sessions" list and wires up open / remove callbacks.
 * Import into app.js and call renderRecentSessions() after DOM is ready.
 */

import {
  ROOT_GROUP,
  loadGroups,
  saveGroups,
  addGroup,
  removeGroup,
  assignSession,
  buildGroupTree,
  flattenGroups,
} from './session-groups.js'
import { SessionStore } from './session-store.js'
// Electron has no window.prompt — calling it THROWS. Aliased on import so the
// call sites never look like the (broken) global.
import { prompt as promptDialog } from './modal.js'

/** Shared store instance — also exported for use in app.js */
export const store = new SessionStore()

// ---------------------------------------------------------------------------
// Type → emoji icon
// ---------------------------------------------------------------------------

/**
 * Return an emoji icon for a given session type.
 *
 * @param {string} type
 * @returns {string}
 */
export function typeIcon(type) {
  const icons = {
    text:           '📄',
    'text-compare': '📄',
    folder:         '📁',
    'folder-compare': '📁',
    hex:            '🔢',
    'hex-compare':  '🔢',
    image:          '🖼️',
    table:          '📊',
    metadata:       '🏷️',
    registry:       '🗝️',
    textedit:       '✏️',
    textpatch:      '✇',
    merge3:         '🔀',
    merge:          '🔀',
  }
  return icons[type] || '📄'
}

// ---------------------------------------------------------------------------
// Relative-time formatter
// ---------------------------------------------------------------------------

/**
 * Format an ISO 8601 timestamp as a human-friendly relative string.
 *
 * @param {string} isoString
 * @returns {string}  e.g. "剛剛" | "3 分鐘前" | "2 小時前" | "5 天前"
 */
export function relativeTime(isoString) {
  const diff    = Date.now() - new Date(isoString).getTime()
  const minutes = Math.floor(diff / 60_000)

  if (minutes < 1)  return '剛剛'
  if (minutes < 60) return `${minutes} 分鐘前`

  const hours = Math.floor(minutes / 60)
  if (hours < 24)   return `${hours} 小時前`

  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Return a display path for a session — prefer leftPath, fall back to
 * leftDir, then an empty string.
 *
 * @param {import('./session.js').Session} session
 * @returns {string}
 */
function displayPath(session) {
  return session.options?.leftPath || session.options?.leftDir || ''
}

/**
 * Build a single `.recent-item` element.
 *
 * @param {import('./session.js').Session} session
 * @param {(session: import('./session.js').Session) => void} onOpen
 * @param {(id: string) => void} onRemove
 * @returns {HTMLElement}
 */
function buildRecentItem(session, onOpen, onRemove, onRegroup) {
  const item = document.createElement('div')
  item.className = 'recent-item'
  item.dataset.id = session.id

  const path = displayPath(session)

  item.innerHTML = `
    <span class="ri-icon">${typeIcon(session.type)}</span>
    <span class="ri-name">${escapeHtml(session.name)}</span>
    ${path ? `<span class="ri-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>` : ''}
    <span class="ri-time">${relativeTime(session.updatedAt)}</span>
    <select class="ri-group" title="移到資料夾"></select>
    <span class="ri-remove" title="移除">✕</span>
  `

  // Filing control. Built as real options rather than markup so a folder name
  // can never be interpreted as HTML.
  const picker = item.querySelector('.ri-group')
  const state = loadGroups()
  const rootOpt = document.createElement('option')
  rootOpt.value = ROOT_GROUP
  rootOpt.textContent = '（未分類）'
  picker.appendChild(rootOpt)
  for (const g of flattenGroups(state)) {
    const opt = document.createElement('option')
    opt.value = g.id
    opt.textContent = `${'　'.repeat(g.depth)}${g.name}`
    picker.appendChild(opt)
  }
  picker.value = state.membership[session.id] ?? ROOT_GROUP
  picker.addEventListener('click', (e) => e.stopPropagation())
  picker.addEventListener('change', () => {
    saveGroups(assignSession(loadGroups(), session.id, picker.value))
    onRegroup?.()
  })

  // Open on row click (but not on the remove button)
  item.addEventListener('click', (e) => {
    if (e.target.closest('.ri-remove')) return
    store.touch(session.id)
    onOpen(session)
  })

  // Remove button
  item.querySelector('.ri-remove').addEventListener('click', (e) => {
    e.stopPropagation()
    store.remove(session.id)
    onRemove(session.id)
  })

  return item
}

/**
 * Minimal HTML escaping to prevent XSS from session names / paths.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Public render function
// ---------------------------------------------------------------------------

/**
 * Render (or re-render) the Recent Sessions list inside `.session-home`.
 *
 * If `.recent-sessions` does not yet exist it is created and appended to
 * `.session-home`.  Calling this function again replaces the list in place,
 * so it can be used both for initial render and for updates after remove.
 *
 * @param {(session: import('./session.js').Session) => void} onOpen
 *   Called when the user clicks a session row.
 * @param {(id: string) => void} onRemove
 *   Called after a session has been removed from the store.
 *   The list is automatically re-rendered before this callback fires.
 * @returns {void}
 */
/**
 * Filter sessions by a free-text query.
 *
 * Matches the name and both paths, because people look for a comparison by
 * whichever of the three they remember — usually a folder name buried in the
 * middle of a path, which is why this is a substring match and not a prefix.
 *
 * @param {object[]} sessions
 * @param {string} query
 * @returns {object[]}
 */
export function filterSessions(sessions, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return sessions
  return sessions.filter((s) => {
    const o = s?.options ?? {}
    const haystack = [
      s?.name, s?.type,
      o.leftPath, o.rightPath, o.basePath, o.outputPath,
      s?.leftPath, s?.rightPath,
    ].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(q)
  })
}

/** Survives a re-render so typing does not reset the box. */
let _searchQuery = ''

/** Test seam: reset the search box between cases. */
export function _resetSessionSearch() { _searchQuery = '' }

export function renderRecentSessions(onOpen, onRemove) {
  // Locate or create the container
  let container = document.querySelector('.recent-sessions')

  if (!container) {
    container = document.createElement('section')
    container.className = 'recent-sessions'

    const home = document.querySelector('.session-home')
    if (home) {
      home.appendChild(container)
    } else {
      // Fallback: append to body so the caller can relocate it if needed
      document.body.appendChild(container)
    }
  }

  // Searching has to look past the ten most recent, or the box can only find
  // what is already on screen.
  const all = store.getRecent(_searchQuery ? 500 : 10)
  const sessions = filterSessions(all, _searchQuery)

  // Build header
  container.innerHTML = '<h2>最近的 Session</h2>'

  // T19: Export/Import buttons
  const actionBar = document.createElement('div')
  actionBar.className = 'session-action-bar'

  const btnExport = document.createElement('button')
  btnExport.className = 'session-action-btn'
  btnExport.textContent = '⬇ 匯出 Sessions'
  btnExport.addEventListener('click', async () => {
    const json = store.exportJSON()
    if (window.electronAPI?.saveFile) {
      await window.electronAPI.saveFile('sessions-backup.json', json)
    } else {
      // fallback: download as file via anchor
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'sessions-backup.json'; a.click()
      URL.revokeObjectURL(url)
    }
  })

  const btnImport = document.createElement('button')
  btnImport.className = 'session-action-btn'
  btnImport.textContent = '⬆ 匯入 Sessions'
  btnImport.addEventListener('click', async () => {
    // Use electronAPI.openFile() to select JSON file
    const result = window.electronAPI?.openFile
      ? await window.electronAPI.openFile()
      : null
    if (!result) return
    const { imported, skipped } = store.importJSON(result.content)
    alert(`匯入完成：${imported} 個 Session（跳過重複：${skipped} 個）`)
    // Re-render the session list
    renderRecentSessions(onOpen, onRemove)
  })

  actionBar.appendChild(btnExport)
  actionBar.appendChild(btnImport)
  container.appendChild(actionBar)

  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'session-search'
  search.placeholder = '搜尋 Session（名稱或路徑）'
  search.value = _searchQuery
  search.addEventListener('input', () => {
    _searchQuery = search.value
    renderRecentSessions(onOpen, onRemove)
    // Re-rendering replaces the input, so focus and caret have to be restored
    // or every keystroke after the first lands nowhere.
    const next = container.querySelector('.session-search')
    if (next instanceof HTMLInputElement) {
      next.focus()
      next.setSelectionRange(next.value.length, next.value.length)
    }
  })
  container.appendChild(search)

  if (sessions.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'recent-empty'
    empty.textContent = _searchQuery ? `找不到符合「${_searchQuery}」的 Session` : '尚無最近記錄'
    container.appendChild(empty)
    return
  }

  const rerender = () => renderRecentSessions(onOpen, onRemove)

  const btnNewGroup = document.createElement('button')
  btnNewGroup.className = 'session-action-btn'
  btnNewGroup.textContent = '＋ 新增資料夾'
  btnNewGroup.addEventListener('click', async () => {
    const name = await promptDialog({ title: '新增資料夾', message: '資料夾名稱：' })
    // null = cancelled, '' = empty name; neither creates a group.
    if (!name) return
    saveGroups(addGroup(loadGroups(), name).state)
    rerender()
  })
  actionBar.appendChild(btnNewGroup)

  const list = document.createElement('div')
  list.className = 'recent-list'

  const removeAndRerender = (id) => {
    rerender()
    onRemove(id)
  }

  /**
   * @param {import('./session-groups.js').GroupNode} node
   * @param {HTMLElement} parentEl
   * @param {number} depth
   */
  const renderNode = (node, parentEl, depth) => {
    for (const child of node.children) {
      const header = document.createElement('div')
      header.className = 'recent-group'
      header.style.paddingLeft = `${depth * 16}px`

      const label = document.createElement('span')
      label.className = 'rg-name'
      label.textContent = `📁 ${child.group.name}`
      header.appendChild(label)

      const count = document.createElement('span')
      count.className = 'rg-count'
      count.textContent = String(child.sessions.length)
      header.appendChild(count)

      const del = document.createElement('span')
      del.className = 'rg-remove'
      del.title = '刪除資料夾（其中的 Session 會移回未分類）'
      del.textContent = '✕'
      del.addEventListener('click', () => {
        saveGroups(removeGroup(loadGroups(), child.group.id))
        rerender()
      })
      header.appendChild(del)

      parentEl.appendChild(header)

      for (const session of child.sessions) {
        const row = buildRecentItem(session, onOpen, removeAndRerender, rerender)
        row.style.paddingLeft = `${(depth + 1) * 16}px`
        parentEl.appendChild(row)
      }
      renderNode(child, parentEl, depth + 1)
    }
  }

  const tree = buildGroupTree(loadGroups(), sessions)
  renderNode(tree, list, 0)
  for (const session of tree.sessions) {
    list.appendChild(buildRecentItem(session, onOpen, removeAndRerender, rerender))
  }

  container.appendChild(list)
}
