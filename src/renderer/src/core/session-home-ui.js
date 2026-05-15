/**
 * @file session-home-ui.js
 * @description Session Home page interaction logic.
 * Renders the "Recent Sessions" list and wires up open / remove callbacks.
 * Import into app.js and call renderRecentSessions() after DOM is ready.
 */

import { SessionStore } from './session-store.js'

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
function buildRecentItem(session, onOpen, onRemove) {
  const item = document.createElement('div')
  item.className = 'recent-item'
  item.dataset.id = session.id

  const path = displayPath(session)

  item.innerHTML = `
    <span class="ri-icon">${typeIcon(session.type)}</span>
    <span class="ri-name">${escapeHtml(session.name)}</span>
    ${path ? `<span class="ri-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>` : ''}
    <span class="ri-time">${relativeTime(session.updatedAt)}</span>
    <span class="ri-remove" title="移除">✕</span>
  `

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

  // Fetch sessions
  const sessions = store.getRecent(10)

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

  if (sessions.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'recent-empty'
    empty.textContent = '尚無最近記錄'
    container.appendChild(empty)
    return
  }

  // Build list
  const list = document.createElement('div')
  list.className = 'recent-list'

  for (const session of sessions) {
    list.appendChild(
      buildRecentItem(session, onOpen, (id) => {
        // Re-render the list, then notify the caller
        renderRecentSessions(onOpen, onRemove)
        onRemove(id)
      })
    )
  }

  container.appendChild(list)
}
