import { TextCompare } from './views/text-compare.js'
import { FolderCompare, parseVirtualPath, sourceKindOf } from './views/folder-compare.js'
import { TableCompare } from './views/table-compare.js'
import { ImageCompare, MAX_IMAGE_BYTES } from './views/image-compare.js'
import { HexCompare } from './views/hex-compare.js'
import { ThreeWayCompare } from './views/three-way-compare.js'
import { renderRecentSessions, store } from './core/session-home-ui.js'
import { createSession, updateSession } from './core/session.js'
import { getViewTypeForPath } from './core/file-type.js'
import { NamedConfigStore } from './core/named-config-store.js'
import { WorkspaceStore } from './core/workspace-store.js'
import { setActiveView } from './core/active-view.js'
import {
  SettingsStore,
  DEFAULT_SHORTCUTS,
  eventToCombo,
  keyComboMatches,
} from './core/settings-store.js'

// ---------------------------------------------------------------------------
// TabManager — session-record-based tab bar
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, type: string, title: string, leftPath: string, rightPath: string, basePath: string, state: object|null }} TabRecord
 */

class TabManager {
  constructor() {
    /** @type {TabRecord[]} */
    this._tabs = []
    /** @type {string|null} */
    this._activeId = null
    this._nextId = 1
  }

  get activeTab() {
    return this._tabs.find(t => t.id === this._activeId) ?? null
  }

  /**
   * Add a new tab record and activate it.
   * @param {string} type
   * @param {string} title
   * @returns {TabRecord}
   */
  addTab(type, title) {
    const id = `tab-${this._nextId++}`
    /** @type {TabRecord} */
    const tab = { id, type, title, leftPath: '', rightPath: '', basePath: '', state: null }
    this._tabs.push(tab)
    this._activeId = id
    this._render()
    return tab
  }

  /**
   * Activate a tab by id.
   * @param {string} id
   */
  activate(id) {
    if (!this._tabs.find(t => t.id === id)) return
    this._activeId = id
    this._render()
  }

  /**
   * Update paths stored in the active tab.
   * @param {{ leftPath?: string, rightPath?: string, basePath?: string }} paths
   */
  updateActivePaths(paths) {
    const tab = this.activeTab
    if (!tab) return
    if (paths.leftPath !== undefined) tab.leftPath = paths.leftPath
    if (paths.rightPath !== undefined) tab.rightPath = paths.rightPath
    if (paths.basePath !== undefined) tab.basePath = paths.basePath
  }

  /**
   * Update the title of the active tab.
   * @param {string} title
   */
  updateActiveTitle(title) {
    const tab = this.activeTab
    if (!tab) return
    tab.title = title
    this._render()
  }

  /**
   * Close a tab by id.
   * @param {string} id
   * @returns {TabRecord|null} the tab that should now be activated (or null → go home)
   */
  closeTab(id) {
    const idx = this._tabs.findIndex(t => t.id === id)
    if (idx === -1) return null
    this._tabs.splice(idx, 1)

    if (this._activeId === id) {
      const next = this._tabs[idx] ?? this._tabs[idx - 1] ?? null
      this._activeId = next?.id ?? null
    }
    this._render()
    return this._activeId ? (this._tabs.find(t => t.id === this._activeId) ?? null) : null
  }

  get count() { return this._tabs.length }

  /** All tab records (read-only access — do not mutate). */
  get tabs() { return this._tabs }

  /**
   * Return a lightweight, JSON-serialisable snapshot of all tabs.
   * The heavy `state` field is stripped so the result is safe to persist
   * to localStorage. Used by T63 Workspace save.
   * @returns {Array<{ type: string, title: string, leftPath: string, rightPath: string, basePath: string }>}
   */
  getSerialisableTabs() {
    return this._tabs.map(t => ({
      type: t.type,
      title: t.title,
      leftPath: t.leftPath,
      rightPath: t.rightPath,
      basePath: t.basePath,
    }))
  }

  /** Show or hide the tab bar depending on whether there are any tabs. */
  _render() {
    const tabBar = document.getElementById('tab-bar')
    if (!tabBar) return

    if (this._tabs.length === 0) {
      tabBar.style.display = 'none'
      tabBar.innerHTML = ''
      return
    }

    tabBar.style.display = 'flex'
    tabBar.innerHTML = ''

    this._tabs.forEach(tab => {
      const item = document.createElement('div')
      item.className = `tab-item${tab.id === this._activeId ? ' tab-item--active' : ''}`
      item.dataset.tabId = tab.id

      const titleEl = document.createElement('span')
      titleEl.className = 'tab-title'
      titleEl.textContent = tab.title
      titleEl.title = tab.title

      item.appendChild(titleEl)

      const closeBtn = document.createElement('button')
      closeBtn.className = 'tab-close'
      closeBtn.textContent = '×'
      closeBtn.title = '關閉分頁 (Ctrl+W)'
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        _handleCloseTab(tab.id)
      })
      item.appendChild(closeBtn)

      item.addEventListener('click', () => _handleActivateTab(tab.id))
      tabBar.appendChild(item)
    })
  }
}

/** @type {TabManager} */
const tabMgr = new TabManager()

/** User settings: keyboard bindings and preferences. */
const settings = new SettingsStore()

// ---------------------------------------------------------------------------
// 視圖狀態
// ---------------------------------------------------------------------------
/** @type {'home' | 'text' | 'folder' | 'table' | 'image' | 'hex' | 'merge3'} */
let currentView = 'home'; setActiveView('home')
/** @type {TextCompare | null} */
let textCompare = null
/** @type {FolderCompare | null} */
let folderCompare = null
/** @type {TableCompare | null} */
let tableCompare = null
/** @type {ImageCompare | null} */
let imageCompare = null
/** @type {HexCompare | null} */
let hexCompare = null
/** @type {ThreeWayCompare | null} */
let mergeCompare = null

/**
 * Passwords for remote profiles the user chose not to save, keyed by profile
 * id. In memory only, and dropped as soon as the session that needed them
 * closes — keeping them for the window's lifetime would leave the password of
 * every profile browsed since launch resident long after the user believed
 * they had disconnected.
 * @type {Map<string, string|undefined>}
 */
const _remoteSecrets = new Map()

/**
 * Forget the cached passwords for profiles whose sessions have closed.
 * @param {string[]} profileIds
 */
function forgetRemoteSecrets(profileIds) {
  for (const id of profileIds ?? []) _remoteSecrets.delete(id)
}

/** How to name a path's backing store in a message. */
const SOURCE_LABELS = Object.freeze({
  fs: '檔案',
  archive: '壓縮檔內的檔案',
  snapshot: '快照項目',
  remote: '遠端檔案',
})

// ---------------------------------------------------------------------------
// 公開入口
// ---------------------------------------------------------------------------
export function initApp() {
  setupTheme()
  setupViewSwitching()
  setupToolbarButtons()
  setupPathBarButtons()
  setupMenuActions()
  setupSettingsModal()
  setupDragAndDrop()
  setupKeyboardShortcuts()
  renderRecentSessions(openSession, removeSession)
  updateToolbar()

  if (window.electronAPI?.onOpenFiles) {
    window.electronAPI.onOpenFiles(({ left, right }) => {
      if (!left) return
      tabMgr.addTab('text', '文字比對')
      showTextCompare()
      if (textCompare && left) {
        window.electronAPI.readFile(left)
          .then(r => { if (r) textCompare.setLeft(r.path, r.content, r.encoding) })
          .catch(() => {})
      }
      if (textCompare && right) {
        window.electronAPI.readFile(right)
          .then(r => { if (r) textCompare.setRight(r.path, r.content, r.encoding) })
          .catch(() => {})
      }
    })
  }

  // E2E test hook — exposes minimal API for Playwright tests to inject data
  // S15-U01: extended with image/table/3way entry points so new e2e specs
  // can drive these views without a file dialog.
  window.__testAPI = {
    hexSetLeft:  (path, b64) => hexCompare?.setLeft(path, b64),
    hexSetRight: (path, b64) => hexCompare?.setRight(path, b64),
    hexGetScrollHeight: () => {
      const s = document.querySelector('.hx-pane .hx-scroll')
      return s ? s.clientHeight : -1
    },
    hexGetRowCount: () => document.querySelectorAll('.hx-row[data-row]').length,
    hexGetInnerHeight: () => {
      const inner = document.querySelector('.hx-pane .hx-inner')
      return inner ? inner.style.height : ''
    },

    // S15-U01 image
    imageSetLeft:  (path, b64, ext) => imageCompare?.setLeft(path, b64, ext),
    imageSetRight: (path, b64, ext) => imageCompare?.setRight(path, b64, ext),
    imageGetDiffCanvasSize: () => {
      const c = document.querySelector('.ic-canvas-diff canvas')
      return c ? { w: c.width, h: c.height } : null
    },
    imageGetStats: () => document.querySelector('.ic-stats')?.textContent ?? '',

    // S15-U01 table
    tableSetLeft:  (path, content) => tableCompare?.setLeft(path, content),
    tableSetRight: (path, content) => tableCompare?.setRight(path, content),
    tableGetRowCount: () => document.querySelectorAll('.tc-cell').length > 0
      ? document.querySelectorAll('.tc-table tr').length
      : 0,
    tableGetDiffCellCount: () => document.querySelectorAll('.cell-diff').length,

    // S15-U01 3-way
    mergeSetAll: (left, base, right) => {
      mergeCompare?.setSide('left',  left)
      mergeCompare?.setSide('base',  base)
      mergeCompare?.setSide('right', right)
    },
    mergeGetConflictCount: () => document.querySelectorAll('.mw-conflict-card').length,

    // S17: the wiring these specs exercise all sits behind a native dialog,
    // which cannot be driven headlessly; these are the same entry points the
    // menu items reach once the dialog has returned.
    openComparison: (opts) => openComparison(opts),
    openArchiveSide: async (side, archivePath) => {
      showFolderCompare()
      await folderCompare?.openArchiveSide(side, archivePath)
    },
    folderSetLeft: async (path) => { showFolderCompare(); await folderCompare?.setLeft(path) },
    folderSetRight: async (path) => { showFolderCompare(); await folderCompare?.setRight(path) },
    folderSetColumns: (columns) => folderCompare?.setColumns(columns),
    folderRows: () => [...document.querySelectorAll('.fc-row')].map((r) => ({
      name: r.dataset.name ?? '',
      status: r.dataset.status ?? '',
      isDir: r.dataset.isDir === 'true',
      leftPath: r.dataset.leftPath ?? '',
      rightPath: r.dataset.rightPath ?? '',
      attrs: r.querySelector('.fc-attrs')?.textContent ?? '',
      attrsTitle: r.querySelector('.fc-attrs')?.getAttribute('title') ?? '',
    })),
    folderDblClick: (name) => {
      const row = [...document.querySelectorAll('.fc-row')]
        .find((r) => r.dataset.name === name)
      row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    },
    folderClick: (name) => {
      const row = [...document.querySelectorAll('.fc-row')]
        .find((r) => r.dataset.name === name)
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    },
    openSnapshotCompare: (info) => openSnapshotCompare(info),
    openRegCompare: (left, right) => openRegCompare(left, right),
    openRemoteCompare: (profile, secret, startDir, side) =>
      openRemoteCompare(profile, secret, startDir, side),
    textGetContents: () => ({
      left: textCompare?.getContent('left') ?? '',
      right: textCompare?.getContent('right') ?? '',
    }),
    textGetStats: () => textCompare?.getDiffStats?.() ?? null,
    currentView: () => currentView,
    statusText: () => el('status-message')?.textContent ?? '',
    statusLevel: () => el('status-message')?.dataset.level ?? '',
  }

  // Remote sessions outlive the view unless something closes them; a window
  // going away is the last chance to do it.
  window.addEventListener('beforeunload', () => {
    void folderCompare?.disconnectAll()
  })
}

// ---------------------------------------------------------------------------
// 視圖切換
// ---------------------------------------------------------------------------
function showHome() {
  if (currentView === 'home') return
  currentView = 'home'; setActiveView('home')

  el('session-home').style.display = ''
  el('view-text').style.display = 'none'
  el('view-folder').style.display = 'none'
  el('view-table').style.display = 'none'
  el('view-image').style.display = 'none'
  el('view-hex').style.display = 'none'
  el('view-merge3').style.display = 'none'
  el('path-bar').style.display = 'none'
  el('diff-counter').style.display = 'none'

  // Refresh the recent list — sessions recorded since the last render would
  // otherwise not appear until the app restarts.
  renderRecentSessions(openSession, removeSession)

  updateToolbar()
}

function showTextCompare() {
  currentView = 'text'; setActiveView('text')

  el('session-home').style.display = 'none'
  el('view-folder').style.display = 'none'
  el('view-table').style.display = 'none'
  el('view-image').style.display = 'none'
  el('view-hex').style.display = 'none'
  el('view-merge3').style.display = 'none'
  el('view-text').style.display = 'flex'
  el('path-bar').style.display = ''

  if (!textCompare) {
    textCompare = new TextCompare({ container: el('view-text') })
    textCompare.mount()

    textCompare.on('diff-count', ({ total, currentIndex }) => {
      const counter = el('diff-counter')
      if (total > 0) {
        counter.textContent = `差異 ${currentIndex + 1} / ${total}`
        counter.style.display = ''
      } else {
        counter.textContent = '無差異'
        counter.style.display = ''
      }
      updateToolbar()
    })

    textCompare.on('paths-changed', ({ left, right }) => {
      recordSession('text', { leftPath: left ?? '', rightPath: right ?? '' })
      el('path-left').textContent = left || '（未選擇）'
      el('path-right').textContent = right || '（未選擇）'
      tabMgr.updateActivePaths({ leftPath: left ?? '', rightPath: right ?? '' })
      if (left || right) {
        const name = (p) => p ? p.replace(/\\/g, '/').split('/').pop() : ''
        tabMgr.updateActiveTitle(`${name(left)} ↔ ${name(right)}`)
      }
      updateToolbar()
    })

    textCompare.on('ready', () => {
      updateToolbar()
    })

    textCompare.on('edit-mode-changed', ({ editMode }) => {
      el('btn-edit-mode').classList.toggle('active', editMode)
      el('btn-edit-mode').title = editMode ? '退出編輯模式 (Ctrl+E)' : '切換編輯模式 (Ctrl+E)'
      updateToolbar()
    })
  }

  updateToolbar()
}

function showFolderCompare() {
  currentView = 'folder'; setActiveView('folder')

  el('session-home').style.display = 'none'
  el('view-text').style.display = 'none'
  el('view-table').style.display = 'none'
  el('view-image').style.display = 'none'
  el('view-hex').style.display = 'none'
  el('view-merge3').style.display = 'none'
  el('view-folder').style.display = 'flex'
  el('path-bar').style.display = 'none'
  el('diff-counter').style.display = 'none'

  if (!folderCompare) {
    folderCompare = new FolderCompare({})
    folderCompare.mount(el('view-folder'))

    folderCompare.on('paths-changed', ({ left, right }) => {
      recordSession('folder', { leftPath: left ?? '', rightPath: right ?? '' })
      el('path-left').textContent = left || '（未選擇）'
      el('path-right').textContent = right || '（未選擇）'
      tabMgr.updateActivePaths({ leftPath: left ?? '', rightPath: right ?? '' })
      if (left || right) {
        const name = (p) => p ? p.replace(/\\/g, '/').split('/').pop() : ''
        tabMgr.updateActiveTitle(`${name(left)} ↔ ${name(right)}`)
      }
      updateToolbar()
    })

    folderCompare.on('open-file-compare', async (payload) => {
      await openComparison(payload)
    })
  }

  updateToolbar()
}

function showTableCompare() {
  currentView = 'table'; setActiveView('table')
  el('session-home').style.display = 'none'
  el('view-text').style.display = 'none'
  el('view-folder').style.display = 'none'
  el('view-image').style.display = 'none'
  el('view-hex').style.display = 'none'
  el('view-merge3').style.display = 'none'
  el('view-table').style.display = 'flex'
  el('path-bar').style.display = 'none'
  el('diff-counter').style.display = 'none'

  if (!tableCompare) {
    tableCompare = new TableCompare({})
    tableCompare.mount(el('view-table'))
    tableCompare.on('paths-changed', ({ left, right }) => {
      recordSession('table', { leftPath: left ?? '', rightPath: right ?? '' })
      el('path-left').textContent = left || '（未選擇）'
      el('path-right').textContent = right || '（未選擇）'
      updateToolbar()
    })
  }
  updateToolbar()
}

function showImageCompare() {
  currentView = 'image'; setActiveView('image')
  el('session-home').style.display = 'none'
  el('view-text').style.display = 'none'
  el('view-folder').style.display = 'none'
  el('view-table').style.display = 'none'
  el('view-hex').style.display = 'none'
  el('view-merge3').style.display = 'none'
  el('view-image').style.display = 'flex'
  el('path-bar').style.display = 'none'
  el('diff-counter').style.display = 'none'

  if (!imageCompare) {
    imageCompare = new ImageCompare({})
    imageCompare.mount(el('view-image'))
    imageCompare.on('paths-changed', ({ left, right }) => {
      recordSession('image', { leftPath: left ?? '', rightPath: right ?? '' })
      el('path-left').textContent = left || '（未選擇）'
      el('path-right').textContent = right || '（未選擇）'
      updateToolbar()
    })
  }
  updateToolbar()
}

function showHexCompare() {
  currentView = 'hex'; setActiveView('hex')
  el('session-home').style.display = 'none'
  el('view-text').style.display = 'none'
  el('view-folder').style.display = 'none'
  el('view-table').style.display = 'none'
  el('view-image').style.display = 'none'
  el('view-merge3').style.display = 'none'
  el('view-hex').style.display = 'flex'
  el('path-bar').style.display = ''
  el('diff-counter').style.display = 'none'

  if (!hexCompare) {
    hexCompare = new HexCompare({})
    hexCompare.mount(el('view-hex'))
    hexCompare.on('paths-changed', ({ left, right }) => {
      recordSession('hex', { leftPath: left ?? '', rightPath: right ?? '' })
      el('path-left').textContent = left || '（未選擇）'
      el('path-right').textContent = right || '（未選擇）'
      updateToolbar()
    })
  }
  updateToolbar()
}

function showMerge3() {
  currentView = 'merge3'; setActiveView('merge3')
  el('session-home').style.display = 'none'
  el('view-text').style.display = 'none'
  el('view-folder').style.display = 'none'
  el('view-table').style.display = 'none'
  el('view-image').style.display = 'none'
  el('view-hex').style.display = 'none'
  el('view-merge3').style.display = 'flex'
  el('path-bar').style.display = 'none'
  el('diff-counter').style.display = 'none'

  if (!mergeCompare) {
    mergeCompare = new ThreeWayCompare()
    mergeCompare.mount(el('view-merge3'))

    mergeCompare.on('paths-changed', ({ left, base, right }) => {
      recordSession('merge3', { leftPath: left ?? '', rightPath: right ?? '', basePath: base ?? '' })
      tabMgr.updateActivePaths({ leftPath: left, rightPath: right, basePath: base })
      // derive a short title from file names
      if (left || right) {
        const name = (p) => p ? p.replace(/\\/g, '/').split('/').pop() : ''
        tabMgr.updateActiveTitle(`${name(left)} ↔ ${name(right)}`)
      }
      updateToolbar()
    })

    mergeCompare.on('ready', () => {
      updateToolbar()
    })
  }

  updateToolbar()
}

// ---------------------------------------------------------------------------
// Tab activation / close handlers (forward-declared so TabManager can reference)
// ---------------------------------------------------------------------------

/**
 * Capture current view state into the tab record.
 * @param {TabRecord} tab
 */
function _saveTabState(tab) {
  if (!tab) return
  switch (tab.type) {
    case 'text':
      if (textCompare) {
        tab.state = {
          leftPath: textCompare._leftPath,
          rightPath: textCompare._rightPath,
          leftContent: textCompare._leftContent,
          rightContent: textCompare._rightContent,
        }
      }
      break
    case 'folder':
      if (folderCompare) {
        tab.state = {
          leftPath: folderCompare._leftPath ?? '',
          rightPath: folderCompare._rightPath ?? '',
        }
      }
      break
    // table, image, hex, merge3: paths stored in tab.leftPath/rightPath already — no extra state
  }
}

/**
 * Restore a previously saved view state.
 * @param {TabRecord} tab
 */
function _restoreTabState(tab) {
  if (!tab?.state) return
  switch (tab.type) {
    case 'text':
      if (textCompare && tab.state.leftContent !== undefined) {
        // Directly set internal state to avoid double-render
        textCompare._leftPath = tab.state.leftPath
        textCompare._rightPath = tab.state.rightPath
        textCompare._leftContent = tab.state.leftContent
        textCompare._rightContent = tab.state.rightContent
        if (textCompare._pathLeft) textCompare._pathLeft.textContent = tab.state.leftPath || '（未選擇）'
        if (textCompare._pathRight) textCompare._pathRight.textContent = tab.state.rightPath || '（未選擇）'
        if (textCompare._leftContent && textCompare._rightContent) {
          textCompare._runDiff()
        } else {
          // Clear the display if one side is empty
          textCompare._diffResult = []
          textCompare._rows = []
          textCompare._diffBlocks = []
          if (textCompare._contentLeft) textCompare._contentLeft.replaceChildren()
          if (textCompare._contentRight) textCompare._contentRight.replaceChildren()
          textCompare._emit('diff-count', { total: 0, currentIndex: -1 })
        }
        textCompare._emit('paths-changed', { left: tab.state.leftPath, right: tab.state.rightPath })
      }
      break
    case 'folder':
      if (folderCompare && tab.state.leftPath !== undefined) {
        // Use public setters to trigger scan
        if (tab.state.leftPath && tab.state.leftPath !== folderCompare._leftPath) {
          folderCompare.setLeft(tab.state.leftPath).catch(() => {})
        }
        if (tab.state.rightPath && tab.state.rightPath !== folderCompare._rightPath) {
          folderCompare.setRight(tab.state.rightPath).catch(() => {})
        }
      }
      break
  }
}

/**
 * Called when user clicks a tab.
 * @param {string} id
 * @param {boolean} [force] - skip the "already active" early-return (used after tab close)
 */
function _handleActivateTab(id, force = false) {
  const prevActive = tabMgr.activeTab

  // If already showing this tab and not forced, nothing to do
  if (!force && prevActive?.id === id) return

  // Save current view state before switching
  if (prevActive && prevActive.id !== id) {
    _saveTabState(prevActive)
  }

  tabMgr.activate(id)
  const tab = tabMgr.activeTab
  if (!tab) { showHome(); return }

  switch (tab.type) {
    case 'text': {
      showTextCompare()
      if (tab.state) {
        // Restore from in-memory state (fast, no disk I/O)
        _restoreTabState(tab)
      } else if (tab.leftPath || tab.rightPath) {
        // First activation with paths but no state yet (e.g., opened from session)
        if (tab.leftPath && textCompare) {
          window.electronAPI.readFile(tab.leftPath).then(r => {
            if (r) textCompare?.setLeft(r.path, r.content, r.encoding)
          }).catch(() => {})
        }
        if (tab.rightPath && textCompare) {
          window.electronAPI.readFile(tab.rightPath).then(r => {
            if (r) textCompare?.setRight(r.path, r.content, r.encoding)
          }).catch(() => {})
        }
      } else {
        // Brand new empty tab — clear the view
        if (textCompare) {
          textCompare._leftPath = ''
          textCompare._rightPath = ''
          textCompare._leftContent = ''
          textCompare._rightContent = ''
          textCompare._diffResult = []
          textCompare._rows = []
          textCompare._diffBlocks = []
          if (textCompare._contentLeft) textCompare._contentLeft.replaceChildren()
          if (textCompare._contentRight) textCompare._contentRight.replaceChildren()
          if (textCompare._pathLeft) textCompare._pathLeft.textContent = '（未選擇）'
          if (textCompare._pathRight) textCompare._pathRight.textContent = '（未選擇）'
          textCompare._emit('diff-count', { total: 0, currentIndex: -1 })
        }
      }
      break
    }
    case 'folder': {
      showFolderCompare()
      if (tab.state) {
        _restoreTabState(tab)
      } else {
        if (tab.leftPath && folderCompare) folderCompare.setLeft(tab.leftPath).catch(() => {})
        if (tab.rightPath && folderCompare) folderCompare.setRight(tab.rightPath).catch(() => {})
      }
      break
    }
    case 'table':
      showTableCompare()
      break
    case 'image':
      showImageCompare()
      break
    case 'hex':
      showHexCompare()
      break
    case 'merge3':
      showMerge3()
      break
    default:
      showHome()
  }
}

/**
 * Called when user clicks close on a tab.
 * @param {string} id
 */
function _handleCloseTab(id) {
  // S14-M03: dispose the matching view if it has no more open tabs of its type.
  const closing = tabMgr.tabs.find(t => t.id === id)
  const nextTab = tabMgr.closeTab(id)
  _disposeViewIfUnused(closing?.type ?? '')
  if (nextTab) {
    _handleActivateTab(nextTab.id, true)
  } else {
    showHome()
  }
}

/**
 * S14-M03: tear down a view instance when no tabs of its type remain. The
 * views own `document`-level listeners (keydown, click) that otherwise leak
 * across tab open/close cycles.
 * @param {string} type
 */
function _disposeViewIfUnused(type) {
  if (!type) return
  const stillUsed = tabMgr.tabs.some(t => t.type === type)
  if (stillUsed) return
  if (type === 'text' && textCompare) {
    try { textCompare.destroy() } catch { /* ignore */ }
    textCompare = null
  } else if (type === 'folder' && folderCompare) {
    try { folderCompare.destroy() } catch { /* ignore */ }
    folderCompare = null
  } else if (type === 'hex' && hexCompare) {
    try { hexCompare.destroy() } catch { /* ignore */ }
    hexCompare = null
  } else if (type === 'image' && imageCompare) {
    try { imageCompare.destroy?.() } catch { /* ignore */ }
    imageCompare = null
  } else if (type === 'table' && tableCompare) {
    try { tableCompare.destroy?.() } catch { /* ignore */ }
    tableCompare = null
  } else if (type === 'merge3' && mergeCompare) {
    try { mergeCompare.destroy?.() } catch { /* ignore */ }
    mergeCompare = null
  }
}

// ---------------------------------------------------------------------------
// Session 首頁按鈕（.session-type-btn）
// ---------------------------------------------------------------------------
/**
 * Open a new session of the given type in a fresh tab.
 * Shared by the home-screen buttons and the Session menu.
 *
 * @param {string} type
 * @param {string} [labelText] fallback label for the unsupported-type message
 */
function newSession(type, labelText) {
  switch (type) {
    case 'text':
      tabMgr.addTab('text', '文字比對')
      showTextCompare()
      break
    case 'folder':
      tabMgr.addTab('folder', '資料夾比對')
      showFolderCompare()
      break
    case 'table':
      tabMgr.addTab('table', '表格比對')
      showTableCompare()
      break
    case 'image':
      tabMgr.addTab('image', '圖片比對')
      showImageCompare()
      break
    case 'hex':
      tabMgr.addTab('hex', 'Hex 比對')
      showHexCompare()
      break
    case 'merge3':
      tabMgr.addTab('merge3', '三向合併')
      showMerge3()
      break
    default:
      showStatus(`${labelText ?? type} 功能開發中`)
      break
  }
}

function setupViewSwitching() {
  document.querySelectorAll('.session-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      newSession(btn.dataset.type, btn.querySelector('.label')?.textContent)
    })
  })

  // Ctrl+N → 回到首頁（新增比對）
  el('btn-new-session').addEventListener('click', () => showHome())
}

// ---------------------------------------------------------------------------
// Toolbar 按鈕
// ---------------------------------------------------------------------------
function setupToolbarButtons() {
  el('btn-first-diff').addEventListener('click', () => textCompare?.navigateFirst())
  el('btn-prev-diff').addEventListener('click', () => textCompare?.navigatePrev())
  el('btn-next-diff').addEventListener('click', () => textCompare?.navigateNext())
  el('btn-last-diff').addEventListener('click', () => textCompare?.navigateLast())

  el('btn-copy-left').addEventListener('click', () => textCompare?.copyToLeft())
  el('btn-copy-right').addEventListener('click', () => textCompare?.copyToRight())
  el('btn-copy-all-left')?.addEventListener('click', () => textCompare?.copyAllToLeft())
  el('btn-copy-all-right')?.addEventListener('click', () => textCompare?.copyAllToRight())

  el('btn-edit-mode').addEventListener('click', () => {
    if (currentView !== 'text' || !textCompare) return
    const isEdit = textCompare.toggleEditMode()
    el('btn-edit-mode').classList.toggle('active', isEdit)
    el('btn-edit-mode').title = isEdit ? '退出編輯模式 (Ctrl+E)' : '切換編輯模式 (Ctrl+E)'
  })

  el('btn-swap').addEventListener('click', () => {
    if (currentView === 'text') textCompare?.swap()
  })

  el('btn-refresh').addEventListener('click', () => {
    if (currentView === 'text') textCompare?.refresh()
    else if (currentView === 'folder') folderCompare?.refresh()
    else if (currentView === 'table') tableCompare?.refresh()
    else if (currentView === 'image') imageCompare?.refresh()
    else if (currentView === 'hex') hexCompare?.refresh()
    // merge3 has its own open buttons; no global refresh needed
  })

  el('btn-export').addEventListener('click', () => {
    if (currentView === 'text') textCompare?.exportHtml()
    else if (currentView === 'folder') folderCompare?.exportHtml()
  })

  el('btn-ignore-rules').addEventListener('click', openIgnoreRulesModal)
  el('btn-modal-close').addEventListener('click', closeIgnoreRulesModal)
  el('btn-modal-cancel').addEventListener('click', closeIgnoreRulesModal)
  el('btn-modal-apply').addEventListener('click', () => {
    const chkUnimportant = el('chk-ignore-unimportant')
    if (chkUnimportant) textCompare?.setIgnoreUnimportant(chkUnimportant.checked)
    const ctxInput = el('input-context-lines')
    if (ctxInput && ctxInput.value !== '') textCompare?.setContextLines(ctxInput.value)
    const ignorePatterns = el('input-ignore-patterns').value
      .split('\n').map(s => s.trim()).filter(Boolean)
    const unimportantPatterns = el('input-unimportant-patterns').value
      .split('\n').map(s => s.trim()).filter(Boolean)
    textCompare?.setIgnorePatterns(ignorePatterns, unimportantPatterns)
    closeIgnoreRulesModal()
  })

  // T62: Print / PDF export
  el('btn-print-report')?.addEventListener('click', () => {
    if (currentView === 'text') textCompare?.exportHtml({ print: true })
    else if (currentView === 'folder') folderCompare?.exportHtml({ print: true })
  })

  // T61: Session Settings Dialog (Named Configs)
  el('btn-config-modal')?.addEventListener('click', openConfigModal)
  el('btn-config-modal-close')?.addEventListener('click', closeConfigModal)
  el('btn-config-modal-cancel')?.addEventListener('click', closeConfigModal)
  el('btn-config-save')?.addEventListener('click', handleConfigSave)

  // T63: Workspaces
  el('btn-workspaces')?.addEventListener('click', openWorkspacesModal)
  el('btn-workspaces-modal-close')?.addEventListener('click', closeWorkspacesModal)
  el('btn-workspaces-modal-cancel')?.addEventListener('click', closeWorkspacesModal)
  el('btn-workspace-save')?.addEventListener('click', handleWorkspaceSave)
}

// ---------------------------------------------------------------------------
// T61: Named Config Store + modal handlers
// ---------------------------------------------------------------------------

const namedConfigStore = new NamedConfigStore()
const workspaceStore = new WorkspaceStore()

/**
 * Return the active view object that supports getConfig/applyConfig.
 * Currently only TextCompare implements the contract.
 * @returns {{ view: object, type: 'text' | null }}
 */
/**
 * The view whose settings the named-config modal should read and write.
 *
 * Configs are keyed by session type, so a folder config is never offered while
 * a text comparison is open.
 */
function _getActiveConfigurableView() {
  const byType = {
    text: textCompare,
    folder: folderCompare,
    table: tableCompare,
    image: imageCompare,
    hex: hexCompare,
  }
  const view = byType[currentView]
  return view && typeof view.getConfig === 'function'
    ? { view, type: currentView }
    : { view: null, type: null }
}

function openConfigModal() {
  const overlay = el('config-modal')
  if (!overlay) return
  overlay.style.display = 'flex'
  refreshConfigList()
  const status = el('config-modal-status')
  if (status) status.textContent = ''
  const input = el('input-config-name')
  if (input) input.value = ''
}

function closeConfigModal() {
  const overlay = el('config-modal')
  if (overlay) overlay.style.display = 'none'
}

function refreshConfigList() {
  const list = el('config-list')
  if (!list) return
  const { type } = _getActiveConfigurableView()
  const items = namedConfigStore.list(type ?? undefined)
  list.replaceChildren()
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'config-list-empty'
    empty.textContent = type === null
      ? '（請先進入文字比對視圖以管理設定）'
      : '（尚未儲存任何設定）'
    list.appendChild(empty)
    return
  }
  for (const entry of items) {
    list.appendChild(_buildConfigListItem(entry))
  }
}

/**
 * @param {{ name: string, viewType: string, createdAt: string, settings: object }} entry
 * @returns {HTMLElement}
 */
function _buildConfigListItem(entry) {
  const row = document.createElement('div')
  row.className = 'config-list-item'

  const nameEl = document.createElement('span')
  nameEl.className = 'name'
  nameEl.textContent = entry.name

  const metaEl = document.createElement('span')
  metaEl.className = 'meta'
  const created = (() => {
    try { return new Date(entry.createdAt).toLocaleString('zh-TW') } catch { return entry.createdAt }
  })()
  metaEl.textContent = `${entry.viewType} · ${created}`

  const btnLoad = document.createElement('button')
  btnLoad.textContent = '載入'
  btnLoad.addEventListener('click', () => {
    const { view } = _getActiveConfigurableView()
    if (!view) return
    view.applyConfig(entry.settings)
    _setConfigStatus(`已套用設定「${entry.name}」`)
  })

  const btnDelete = document.createElement('button')
  btnDelete.className = 'danger'
  btnDelete.textContent = '刪除'
  btnDelete.addEventListener('click', () => {
    namedConfigStore.remove(entry.name)
    refreshConfigList()
    _setConfigStatus(`已刪除設定「${entry.name}」`)
  })

  row.appendChild(nameEl)
  row.appendChild(metaEl)
  row.appendChild(btnLoad)
  row.appendChild(btnDelete)
  return row
}

function handleConfigSave() {
  const input = el('input-config-name')
  const name = (input?.value ?? '').trim()
  if (!name) {
    _setConfigStatus('請輸入設定名稱')
    return
  }
  const { view, type } = _getActiveConfigurableView()
  if (!view || !type) {
    _setConfigStatus('目前視圖不支援設定管理')
    return
  }
  const settings = view.getConfig()
  namedConfigStore.save(name, type, settings)
  if (input) input.value = ''
  refreshConfigList()
  _setConfigStatus(`已儲存設定「${name}」`)
}

function _setConfigStatus(msg) {
  const status = el('config-modal-status')
  if (status) status.textContent = msg
}

// ---------------------------------------------------------------------------
// T63: Workspaces modal handlers
// ---------------------------------------------------------------------------

function openWorkspacesModal() {
  const overlay = el('workspaces-modal')
  if (!overlay) return
  overlay.style.display = 'flex'
  refreshWorkspacesList()
  const status = el('workspace-modal-status')
  if (status) status.textContent = ''
  const input = el('input-workspace-name')
  if (input) input.value = ''
}

function closeWorkspacesModal() {
  const overlay = el('workspaces-modal')
  if (overlay) overlay.style.display = 'none'
}

function refreshWorkspacesList() {
  const list = el('workspaces-list')
  if (!list) return
  const items = workspaceStore.list()
  list.replaceChildren()
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'config-list-empty'
    empty.textContent = '（尚未儲存任何工作區）'
    list.appendChild(empty)
    return
  }
  for (const entry of items) {
    list.appendChild(_buildWorkspaceListItem(entry))
  }
}

function _buildWorkspaceListItem(entry) {
  const row = document.createElement('div')
  row.className = 'config-list-item'

  const nameEl = document.createElement('span')
  nameEl.className = 'name'
  nameEl.textContent = entry.name

  const metaEl = document.createElement('span')
  metaEl.className = 'meta'
  const count = Array.isArray(entry.tabs) ? entry.tabs.length : 0
  const created = (() => {
    try { return new Date(entry.createdAt).toLocaleString('zh-TW') } catch { return entry.createdAt }
  })()
  metaEl.textContent = `${count} 個分頁 · ${created}`

  const btnLoad = document.createElement('button')
  btnLoad.textContent = '載入'
  btnLoad.addEventListener('click', async () => {
    closeWorkspacesModal()
    await loadWorkspace(entry)
  })

  const btnDelete = document.createElement('button')
  btnDelete.className = 'danger'
  btnDelete.textContent = '刪除'
  btnDelete.addEventListener('click', () => {
    workspaceStore.remove(entry.name)
    refreshWorkspacesList()
    _setWorkspaceStatus(`已刪除工作區「${entry.name}」`)
  })

  row.appendChild(nameEl)
  row.appendChild(metaEl)
  row.appendChild(btnLoad)
  row.appendChild(btnDelete)
  return row
}

function handleWorkspaceSave() {
  const input = el('input-workspace-name')
  const name = (input?.value ?? '').trim()
  if (!name) {
    _setWorkspaceStatus('請輸入工作區名稱')
    return
  }
  const tabs = tabMgr.getSerialisableTabs()
  if (tabs.length === 0) {
    _setWorkspaceStatus('目前沒有分頁可儲存')
    return
  }
  workspaceStore.save(name, tabs)
  if (input) input.value = ''
  refreshWorkspacesList()
  _setWorkspaceStatus(`已儲存工作區「${name}」（${tabs.length} 個分頁）`)
}

function _setWorkspaceStatus(msg) {
  const status = el('workspace-modal-status')
  if (status) status.textContent = msg
}

/**
 * Restore tabs from a workspace entry. Closes all current tabs, then opens
 * each saved tab and re-reads its files. Missing/failed files are skipped.
 * @param {{ tabs: Array<{ type: string, title: string, leftPath: string, rightPath: string, basePath: string }> }} entry
 */
async function loadWorkspace(entry) {
  if (!entry || !Array.isArray(entry.tabs)) return
  // Close all current tabs (iterate over a copy of ids)
  const currentIds = tabMgr.tabs.map(t => t.id)
  for (const id of currentIds) tabMgr.closeTab(id)

  let failures = 0
  for (const saved of entry.tabs) {
    try {
      await _restoreOneWorkspaceTab(saved)
    } catch {
      failures++
    }
  }

  // Activate the first restored tab (if any)
  const first = tabMgr.tabs[0]
  if (first) {
    _handleActivateTab(first.id, true)
  } else {
    showHome()
  }

  if (failures > 0) {
    showStatus(`工作區載入：${failures} 個分頁無法還原`)
  }
}

/**
 * @param {{ type: string, title: string, leftPath: string, rightPath: string, basePath: string }} saved
 */
async function _restoreOneWorkspaceTab(saved) {
  const type = saved.type
  const title = saved.title || _titleFromPaths(saved.leftPath, saved.rightPath) || _defaultTitleForType(type)

  switch (type) {
    case 'text': {
      tabMgr.addTab('text', title)
      tabMgr.updateActivePaths({ leftPath: saved.leftPath, rightPath: saved.rightPath })
      showTextCompare()
      if (textCompare) {
        if (saved.leftPath) {
          try {
            const r = await window.electronAPI.readFile(saved.leftPath)
            if (r) textCompare.setLeft(r.path, r.content, r.encoding)
          } catch { /* skip */ }
        }
        if (saved.rightPath) {
          try {
            const r = await window.electronAPI.readFile(saved.rightPath)
            if (r) textCompare.setRight(r.path, r.content, r.encoding)
          } catch { /* skip */ }
        }
      }
      break
    }
    case 'folder': {
      tabMgr.addTab('folder', title)
      tabMgr.updateActivePaths({ leftPath: saved.leftPath, rightPath: saved.rightPath })
      showFolderCompare()
      if (folderCompare) {
        if (saved.leftPath)  await folderCompare.setLeft(saved.leftPath).catch(() => {})
        if (saved.rightPath) await folderCompare.setRight(saved.rightPath).catch(() => {})
      }
      break
    }
    case 'table': {
      tabMgr.addTab('table', title)
      tabMgr.updateActivePaths({ leftPath: saved.leftPath, rightPath: saved.rightPath })
      showTableCompare()
      if (tableCompare) {
        if (saved.leftPath) {
          try {
            const r = await window.electronAPI.readFile(saved.leftPath)
            if (r) tableCompare.setLeft(r.path, r.content)
          } catch { /* skip */ }
        }
        if (saved.rightPath) {
          try {
            const r = await window.electronAPI.readFile(saved.rightPath)
            if (r) tableCompare.setRight(r.path, r.content)
          } catch { /* skip */ }
        }
      }
      break
    }
    case 'image': {
      tabMgr.addTab('image', title)
      tabMgr.updateActivePaths({ leftPath: saved.leftPath, rightPath: saved.rightPath })
      showImageCompare()
      if (imageCompare) {
        if (saved.leftPath) {
          try {
            const r = await window.electronAPI.readFileBinary(saved.leftPath, MAX_IMAGE_BYTES)
            if (r) await imageCompare.setLeft(r.path, r.base64, r.ext)
          } catch { /* skip */ }
        }
        if (saved.rightPath) {
          try {
            const r = await window.electronAPI.readFileBinary(saved.rightPath, MAX_IMAGE_BYTES)
            if (r) await imageCompare.setRight(r.path, r.base64, r.ext)
          } catch { /* skip */ }
        }
      }
      break
    }
    case 'hex': {
      tabMgr.addTab('hex', title)
      tabMgr.updateActivePaths({ leftPath: saved.leftPath, rightPath: saved.rightPath })
      showHexCompare()
      if (hexCompare) {
        if (saved.leftPath) {
          try {
            const r = await window.electronAPI.readFileBinary(saved.leftPath)
            if (r) hexCompare.setLeft(r.path, r.base64)
          } catch { /* skip */ }
        }
        if (saved.rightPath) {
          try {
            const r = await window.electronAPI.readFileBinary(saved.rightPath)
            if (r) hexCompare.setRight(r.path, r.base64)
          } catch { /* skip */ }
        }
      }
      break
    }
    case 'merge3': {
      tabMgr.addTab('merge3', title)
      tabMgr.updateActivePaths({ leftPath: saved.leftPath, rightPath: saved.rightPath, basePath: saved.basePath })
      showMerge3()
      // 3-way restore requires base+left+right files; we skip silently if any missing
      break
    }
    default:
      // Unknown type — skip
      break
  }
}

function _titleFromPaths(left, right) {
  if (!left && !right) return ''
  const name = (p) => p ? p.replace(/\\/g, '/').split('/').pop() : ''
  return `${name(left)} ↔ ${name(right)}`
}

function _defaultTitleForType(type) {
  switch (type) {
    case 'text':   return '文字比對'
    case 'folder': return '資料夾比對'
    case 'table':  return '表格比對'
    case 'image':  return '圖片比對'
    case 'hex':    return 'Hex 比對'
    case 'merge3': return '三向合併'
    default:       return '分頁'
  }
}

// ---------------------------------------------------------------------------
// Path Bar 按鈕
// ---------------------------------------------------------------------------
function setupPathBarButtons() {
  el('btn-open-left').addEventListener('click', () => {
    if (currentView === 'text') textCompare?.openLeft()
    else if (currentView === 'folder') folderCompare?.openLeft()
    else if (currentView === 'table') tableCompare?.openLeft()
    else if (currentView === 'image') imageCompare?.openLeft()
    else if (currentView === 'hex') hexCompare?.openLeft()
  })

  el('btn-open-right').addEventListener('click', () => {
    if (currentView === 'text') textCompare?.openRight()
    else if (currentView === 'folder') folderCompare?.openRight()
    else if (currentView === 'table') tableCompare?.openRight()
    else if (currentView === 'image') imageCompare?.openRight()
    else if (currentView === 'hex') hexCompare?.openRight()
  })
}

// ---------------------------------------------------------------------------
// Toolbar 狀態更新
// ---------------------------------------------------------------------------
function updateToolbar() {
  const isHome = currentView === 'home'
  const isText = currentView === 'text'
  const isFolder = currentView === 'folder'
  // merge3 doesn't use the toolbar diff controls

  // 取得 diff 資訊（僅 text 模式）
  const diffInfo = isText && textCompare ? textCompare.getDiffInfo() : { total: 0, currentIndex: -1 }
  const hasDiff = diffInfo.total > 0
  const hasContent = isText && textCompare != null

  // 導航按鈕：text 模式且有 diff 時啟用
  setDisabled('btn-first-diff', !hasDiff)
  setDisabled('btn-prev-diff', !hasDiff)
  setDisabled('btn-next-diff', !hasDiff)
  setDisabled('btn-last-diff', !hasDiff)

  // Copy 按鈕：text 模式且有 diff 時啟用
  setDisabled('btn-copy-left', !hasDiff)
  setDisabled('btn-copy-right', !hasDiff)
  setDisabled('btn-copy-all-left', !hasDiff)
  setDisabled('btn-copy-all-right', !hasDiff)

  // Edit mode button: text mode only, requires content
  setDisabled('btn-edit-mode', !hasContent)

  // Swap / Refresh / Export
  setDisabled('btn-swap', !hasContent)
  setDisabled('btn-refresh', isHome)
  setDisabled('btn-export', isHome || (isText && !textCompare?._diffResult?.length) && currentView !== 'folder')
}

// ---------------------------------------------------------------------------
// 鍵盤快捷鍵
// ---------------------------------------------------------------------------
/**
 * Global keyboard shortcuts.
 *
 * Bindings come from SettingsStore rather than being hard-coded, so the
 * customisation UI actually has an effect. That store, its default table and
 * the settings modal all existed but nothing consulted them, leaving the
 * feature inert.
 *
 * Shortcuts owned by a view's own handler (the text find bar, go-to-line,
 * bookmarks, font size) stay there and are not customisable yet; registering
 * them here as well would fire both handlers.
 */
function setupKeyboardShortcuts() {
  /** @type {Record<string, () => void>} */
  const actions = {
    nextDiff:  () => navigateDiff('next'),
    prevDiff:  () => navigateDiff('prev'),
    firstDiff: () => navigateDiff('first'),
    lastDiff:  () => navigateDiff('last'),
    copyLeft:  () => { if (currentView === 'text') textCompare?.copyToLeft() },
    copyRight: () => { if (currentView === 'text') textCompare?.copyToRight() },
    copyAllLeft:  () => { if (currentView === 'text') textCompare?.copyAllToLeft() },
    copyAllRight: () => { if (currentView === 'text') textCompare?.copyAllToRight() },
    undo: () => { if (currentView === 'text') textCompare?.undo() },
    redo: () => { if (currentView === 'text') textCompare?.redo() },
    editToggle: () => {
      if (currentView !== 'text' || !textCompare) return
      const isEdit = textCompare.toggleEditMode()
      el('btn-edit-mode').classList.toggle('active', isEdit)
      el('btn-edit-mode').title = isEdit ? '退出編輯模式 (Ctrl+E)' : '切換編輯模式 (Ctrl+E)'
    },
    saveLeft:  () => { if (currentView === 'text') void textCompare?.saveLeft() },
    saveRight: () => { if (currentView === 'text') void textCompare?.saveRight() },
    refresh: () => {
      if (currentView === 'text') textCompare?.refresh()
      else if (currentView === 'folder') void folderCompare?.refresh()
    },
    newSession: () => showHome(),
    closeTab: () => {
      const active = tabMgr.activeTab
      if (active) _handleCloseTab(active.id)
    },
    fullscreen: () => { void window.electronAPI?.toggleFullScreen?.() },
    print: () => {
      if (currentView === 'text') void textCompare?.exportHtml({ print: true })
      else if (currentView === 'folder') void folderCompare?.exportHtml({ print: true })
    },
  }

  document.addEventListener('keydown', (e) => {
    // 在 edit-textarea 中允許 Ctrl+S / Ctrl+Shift+S / Ctrl+E 觸發；其他 input/textarea 則略過
    const isEditTextarea = e.target.classList?.contains('edit-textarea')
    if (e.target.matches?.('input, textarea') && !isEditTextarea) return
    if (isEditTextarea) {
      if (!((e.key === 's' && e.ctrlKey) || (e.key === 'e' && e.ctrlKey))) return
    }

    const combo = eventToCombo(e)
    if (!combo) return

    for (const [action, fn] of Object.entries(actions)) {
      if (!keyComboMatches(e, settings.getShortcut(action))) continue
      e.preventDefault()
      fn()
      return
    }
  })
}

/**
 * Tell the user a side could not be read, naming the side and the store.
 *
 * Every caller used to swallow this, which is how comparing two files inside
 * an archive could show two empty panes and announce that they matched.
 *
 * @param {string} side
 * @param {string} path
 * @param {unknown} err
 */
function reportReadFailure(side, path, err) {
  const what = SOURCE_LABELS[sourceKindOf(path)] ?? '檔案'
  const message = err instanceof Error ? err.message : String(err)
  showError(`無法讀取${side === 'right' ? '右' : side === 'base' ? '中' : '左'}側${what}「${path}」：${message}`, err)
}

/**
 * Open a comparison of the given paths in a new tab.
 *
 * Shared by folder-compare double-click and by opening a stored session, so
 * every session type loads through one path instead of only text and folder.
 *
 * @param {{ type?: string, leftPath?: string, rightPath?: string, basePath?: string,
 *           leftContent?: string, rightContent?: string, algorithm?: string }} opts
 */
async function openComparison({ type, leftPath, rightPath, basePath, leftContent, rightContent, algorithm } = {}) {
  // An explicit type (from a stored session) wins; otherwise route on the
  // file extension as a folder-compare double-click does.
  const viewType = type && type !== 'auto' ? type : getViewTypeForPath(leftPath || rightPath)

  if (viewType === 'folder') {
    tabMgr.addTab('folder', '資料夾比對')
    showFolderCompare()
    if (leftPath) await folderCompare?.setLeft(leftPath)
    if (rightPath) await folderCompare?.setRight(rightPath)
    return
  }

  if (viewType === 'merge3') {
    tabMgr.addTab('merge3', '三向合併')
    showMerge3()
    for (const [side, path] of [['left', leftPath], ['base', basePath], ['right', rightPath]]) {
      if (!path) continue
      try {
        const r = await readPathText(path)
        mergeCompare?.setSide(side, r.content, path)
      } catch (err) {
        reportReadFailure(side, path, err)
      }
    }
    return
  }

  if (viewType === 'image') {
    tabMgr.addTab('image', '圖片比對')
    showImageCompare()
    // image 需要 base64
    if (leftPath) {
      try {
        const r = await readPathBinary(leftPath, MAX_IMAGE_BYTES)
        if (r) await imageCompare?.setLeft(r.path, r.base64, r.ext)
      } catch (err) { reportReadFailure('left', leftPath, err) }
    }
    if (rightPath) {
      try {
        const r = await readPathBinary(rightPath, MAX_IMAGE_BYTES)
        if (r) await imageCompare?.setRight(r.path, r.base64, r.ext)
      } catch (err) { reportReadFailure('right', rightPath, err) }
    }
    return
  }

  if (viewType === 'table') {
    tabMgr.addTab('table', '表格比對')
    showTableCompare()
    // TableCompare.setLeft(path, content)
    let lContent = leftContent
    let rContent = rightContent
    if (lContent === undefined && leftPath) {
      try { lContent = (await readPathText(leftPath)).content }
      catch (err) { reportReadFailure('left', leftPath, err) }
    }
    if (rContent === undefined && rightPath) {
      try { rContent = (await readPathText(rightPath)).content }
      catch (err) { reportReadFailure('right', rightPath, err) }
    }
    if (leftPath)  tableCompare?.setLeft(leftPath, lContent ?? '')
    if (rightPath) tableCompare?.setRight(rightPath, rContent ?? '')
    return
  }

  if (viewType === 'hex') {
    tabMgr.addTab('hex', 'Hex 比對')
    showHexCompare()
    // hex 需要 base64
    if (leftPath) {
      try {
        const r = await readPathBinary(leftPath)
        if (r) hexCompare?.setLeft(r.path, r.base64)
      } catch (err) { reportReadFailure('left', leftPath, err) }
    }
    if (rightPath) {
      try {
        const r = await readPathBinary(rightPath)
        if (r) hexCompare?.setRight(r.path, r.base64)
      } catch (err) { reportReadFailure('right', rightPath, err) }
    }
    return
  }

  // Default: text
  let lContent = leftContent
  let rContent = rightContent
  let lEncoding
  let rEncoding
  if (lContent === undefined && leftPath) {
    try {
      const result = await readPathText(leftPath)
      lContent = result.content
      lEncoding = result.encoding
    } catch (err) {
      reportReadFailure('left', leftPath, err)
    }
  }
  if (rContent === undefined && rightPath) {
    try {
      const result = await readPathText(rightPath)
      rContent = result.content
      rEncoding = result.encoding
    } catch (err) {
      reportReadFailure('right', rightPath, err)
    }
  }
  tabMgr.addTab('text', '文字比對')
  showTextCompare()
  if (textCompare) {
    textCompare.setLeft(leftPath, lContent ?? '', lEncoding)
    textCompare.setRight(rightPath, rContent ?? '', rEncoding)
    if (algorithm) textCompare.setAlgorithm(algorithm)
  }
}

/**
 * Accept files or folders dropped anywhere on the app and start a comparison.
 *
 * A drop names paths the renderer is not yet allowed to read, so the paths go
 * through the main process first to be registered — the same trust step a file
 * dialog performs.
 */
function setupDragAndDrop() {
  const home = el('session-home')
  if (!home) return

  const stop = (e) => { e.preventDefault(); e.stopPropagation() }
  for (const type of ['dragenter', 'dragover']) {
    home.addEventListener(type, (e) => {
      stop(e)
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      home.classList.add('session-home--drag-over')
    })
  }
  home.addEventListener('dragleave', (e) => {
    if (!home.contains(e.relatedTarget)) home.classList.remove('session-home--drag-over')
  })

  home.addEventListener('drop', async (e) => {
    stop(e)
    home.classList.remove('session-home--drag-over')

    // The File objects go across as they are. Electron 32 removed `File.path`,
    // and resolving it in preload is also what keeps this honest: a path can
    // only come from a File the user really dropped, and the renderer cannot
    // manufacture one for a file it was never given.
    const dropped = [...(e.dataTransfer?.files ?? [])]
    if (!dropped.length) return

    let entries
    try {
      entries = await window.electronAPI?.acceptDroppedFiles?.(dropped)
    } catch (err) {
      console.error('[drop] could not accept paths:', err)
      return
    }
    if (!entries?.length) return

    const [left, right] = entries
    // A single drop opens that item against nothing, letting the user pick the
    // other side; two open straight into a comparison.
    await openComparison({
      type: left.isDirectory ? 'folder' : undefined,
      leftPath: left.path,
      rightPath: right?.path ?? '',
    })
  })
}

/**
 * Re-read one side of a text comparison with an explicit encoding.
 *
 * @param {'left'|'right'} side
 * @param {string} encoding
 */
async function reloadEncoding(side, encoding) {
  if (currentView !== 'text' || !textCompare) {
    showStatus('請先開啟文字比對')
    return
  }
  try {
    const ok = await textCompare.reloadWithEncoding(side, encoding)
    showStatus(ok ? `${side === 'left' ? '左' : '右'}側已以 ${encoding} 重新載入` : '該側尚未開啟檔案')
  } catch (err) {
    showStatus(`以 ${encoding} 讀取失敗：${err.message}`)
  }
}

/**
 * Take a snapshot of the folder currently open on the left.
 *
 * @param {boolean} crc  also hash file contents, so later content drift is
 *   detectable — a snapshot stores no file data, which is the whole point of
 *   it, so without a hash only size and timestamp can be compared.
 */
async function createSnapshot(crc) {
  const folder = folderCompare?._leftPath || folderCompare?._rightPath
  if (currentView !== 'folder' || !folder) {
    showStatus('請先開啟資料夾比對並選擇資料夾')
    return
  }
  showStatus(crc ? '建立快照中（計算雜湊，可能較久）…' : '建立快照中…')
  try {
    const result = await window.electronAPI?.createSnapshot?.(folder, crc)
    if (!result) { showStatus('已取消'); return }
    showStatus(result.truncated
      ? `快照已建立（${result.count} 項，已達上限而截斷）`
      : `快照已建立：${result.count} 項`)
  } catch (err) {
    showStatus(`建立快照失敗：${err.message}`)
  }
}

/**
 * Export a live registry key and report what came back.
 *
 * Windows only: the export goes through reg.exe, which is where the data
 * actually lives.
 */
async function exportRegistry() {
  const keyPath = prompt('登錄機碼路徑（例如 HKCU\Software\MyApp）：')
  if (!keyPath) return
  try {
    const result = await window.electronAPI?.exportRegistryKey?.(keyPath)
    if (!result) { showStatus('已取消'); return }
    showStatus(`已匯出 ${result.rows.length} 個項目到 ${result.path}`)
  } catch (err) {
    showStatus(`匯出登錄機碼失敗：${err.message}`)
  }
}

/**
 * Manage remote connection profiles.
 *
 * Creating a profile is the point at which the user supplies a host and
 * credentials; nothing connects until a comparison is actually opened.
 */
async function manageRemoteProfiles() {
  const api = window.electronAPI
  if (!api?.remoteListProfiles) { showStatus('此版本未包含遠端連線功能'); return }

  let profiles
  try {
    profiles = await api.remoteListProfiles()
  } catch (err) {
    showStatus(`讀取連線設定失敗：${err.message}`)
    return
  }

  const summary = profiles.length
    ? profiles.map((p, i) => `${i + 1}. ${p.name}（${p.kind} ${p.host || p.bucket || ''}）`).join('\n')
    : '（尚無連線設定）'
  const choice = prompt(
    `目前的遠端連線：
${summary}

` +
    '輸入 new 新增，或輸入編號後加 del 刪除（例如「1 del」）：')
  if (!choice) return

  if (choice.trim().toLowerCase() === 'new') {
    await createRemoteProfile()
    return
  }
  const del = /^(\d+)\s+del$/i.exec(choice.trim())
  if (del) {
    const target = profiles[Number(del[1]) - 1]
    if (!target) { showStatus('沒有該編號'); return }
    try {
      await api.remoteDeleteProfile(target.id)
      showStatus(`已刪除「${target.name}」`)
    } catch (err) {
      showStatus(`刪除失敗：${err.message}`)
    }
  }
}

/** Collect a new profile from the user. */
async function createRemoteProfile() {
  const kind = prompt('連線類型（ftp / ftps / s3）：', 'ftp')?.trim().toLowerCase()
  if (!kind) return
  const name = prompt('這個連線的名稱：')?.trim()
  if (!name) return

  /** @type {Record<string, unknown>} */
  const profile = { name, kind, saveSecret: false }
  if (kind === 's3') {
    profile.bucket = prompt('Bucket：')?.trim()
    profile.region = prompt('Region（例如 us-east-1）：')?.trim()
    profile.user = prompt('Access Key ID：')?.trim()
  } else {
    profile.host = prompt('主機：')?.trim()
    profile.user = prompt('使用者名稱：')?.trim()
    profile.path = prompt('起始路徑（可留空）：')?.trim() ?? ''
  }

  // The password is deliberately not persisted unless asked for: it can only
  // be stored encrypted, and where the OS cannot encrypt it must not be stored
  // at all.
  profile.saveSecret = confirm('要記住密碼嗎？（只會以作業系統加密後儲存；無法加密時不會儲存）')
  if (profile.saveSecret) {
    profile.secret = prompt(kind === 's3' ? 'Secret Access Key：' : '密碼：') ?? ''
  }

  try {
    const saved = await window.electronAPI.remoteSaveProfile(profile)
    showStatus(`已儲存連線「${saved.name}」`)
  } catch (err) {
    showStatus(`儲存失敗：${err.message}`)
  }
}

/**
 * Open a remote folder as one side of a comparison.
 *
 * This is where the app first reaches the network, and only because the user
 * picked a profile and asked for it.
 */
async function openRemoteFolder() {
  const api = window.electronAPI
  if (!api?.remoteListDir) { showStatus('此版本未包含遠端連線功能'); return }

  let profiles = []
  try {
    profiles = await api.remoteListProfiles()
  } catch { /* fall through to the empty case */ }
  if (!profiles.length) {
    showStatus('尚無遠端連線設定，請先從「遠端連線設定…」新增')
    return
  }

  const pick = prompt(
    `選擇連線：
${profiles.map((p, i) => `${i + 1}. ${p.name}`).join('\n')}`, '1')
  const profile = profiles[Number(pick) - 1]
  if (!profile) return

  const secret = profile.hasSecret
    ? undefined
    : (prompt(`「${profile.name}」的密碼：`) ?? undefined)

  const startDir = prompt(`「${profile.name}」的起始路徑（可留空）：`, profile.path ?? '') ?? ''
  const side = (prompt('放在哪一側？（left / right）：', 'left') ?? 'left').trim().toLowerCase() === 'right'
    ? 'right' : 'left'

  await openRemoteCompare(profile, secret, startDir, side)
}

/**
 * Browse a remote profile as one side of a folder comparison.
 *
 * Separated from the profile picker so the dialogs are not in the way of a
 * restored session or a test.
 *
 * @param {{ id: string, name: string }} profile
 * @param {string|undefined} secret
 * @param {string} [startDir]
 * @param {'left'|'right'} [side]
 */
async function openRemoteCompare(profile, secret, startDir = '', side = 'left') {
  showStatus(`連線至 ${profile.name}…`)
  try {
    // The secret is needed again by every later call (listing a subdirectory,
    // reading a file), so it is kept for this window rather than re-prompted.
    _remoteSecrets.set(profile.id, secret)

    tabMgr.addTab('folder', `遠端：${profile.name}`)
    showFolderCompare()
    if (folderCompare) folderCompare._onRemoteClosed = forgetRemoteSecrets
    await folderCompare?.setSource(side, {
      kind: 'remote',
      root: `remote://${profile.id}/${startDir}`.replace(/\/+$/, '/'),
      profileId: profile.id,
      secret,
      startDir,
      label: `${profile.name} [遠端]`,
    })
    showStatus(`${profile.name}：已連線。選擇另一側資料夾即可比對（遠端側為唯讀）`)
  } catch (err) {
    _remoteSecrets.delete(profile.id)
    showError(`連線 ${profile.name} 失敗：${err.message}`, err)
  }
}

/** Open one or two .reg files and compare them as normalised text. */
async function openRegFile() {
  try {
    const left = await window.electronAPI?.openFile?.({
      filters: [{ name: '登錄檔', extensions: ['reg'] }],
    })
    if (!left) return
    const right = await window.electronAPI?.openFile?.({
      filters: [{ name: '登錄檔', extensions: ['reg'] }],
    })
    await openRegCompare(left.path, right?.path)
  } catch (err) {
    showError(`讀取登錄檔失敗：${err.message}`, err)
  }
}

/**
 * Compare two .reg exports as text.
 *
 * The text view is the right carrier: a registry export is a sorted list of
 * `key\name = value` triples, and once both sides are rendered in that canonical
 * form the existing line diff answers the question the user actually has.
 *
 * @param {string} leftPath
 * @param {string} [rightPath]
 */
async function openRegCompare(leftPath, rightPath) {
  const api = window.electronAPI
  const [left, right] = await Promise.all([
    leftPath ? api.readRegFile(leftPath) : Promise.resolve(null),
    rightPath ? api.readRegFile(rightPath) : Promise.resolve(null),
  ])

  tabMgr.addTab('text', '登錄檔比對')
  showTextCompare()
  textCompare?.setLeft(leftPath ?? '', formatRegRows(left?.rows))
  textCompare?.setRight(rightPath ?? '', formatRegRows(right?.rows))
  showStatus(
    `登錄檔比對：左 ${left?.rows?.length ?? 0} 項` +
    (right ? `，右 ${right.rows.length} 項` : '（未選擇右側）'))
}

/**
 * Render flattened registry rows as one comparable line per value.
 *
 * @param {Array<{ path: string, name: string, type: string, value: string }>|null|undefined} rows
 * @returns {string}
 */
function formatRegRows(rows) {
  if (!rows?.length) return ''
  const out = []
  let currentKey = null
  for (const row of rows) {
    if (row.path !== currentKey) {
      if (currentKey !== null) out.push('')
      out.push(`[${row.path}]`)
      currentKey = row.path
    }
    if (row.type === 'KEY') continue
    out.push(`${row.name === '' ? '@' : `"${row.name}"`} = ${row.type}: ${row.value}`)
  }
  return `${out.join('\n')}\n`
}

/** Load a snapshot file and compare it against a folder. */
async function openSnapshot() {
  try {
    const info = await window.electronAPI?.loadSnapshot?.()
    if (!info) return
    await openSnapshotCompare(info)
    // Compared against what? A snapshot on its own says nothing, so the folder
    // picker follows immediately instead of leaving a half-set-up view.
    const folder = await window.electronAPI?.openFolder?.()
    if (folder?.path) await folderCompare?.setRight(folder.path)
  } catch (err) {
    showError(`開啟快照失敗：${err.message}`, err)
  }
}

/**
 * Show a loaded snapshot as the left side of a folder comparison.
 *
 * @param {{ path: string, name: string, count: number, createdAt: string, hasCrc: boolean }} info
 */
async function openSnapshotCompare(info) {
  tabMgr.addTab('folder', `快照：${info.name}`)
  showFolderCompare()
  await folderCompare?.setSource('left', {
    kind: 'snapshot',
    root: info.path,
    label: `${info.name} [快照]`,
  })
  const when = new Date(info.createdAt).toLocaleString('zh-TW')
  showStatus(`快照「${info.name}」：${info.count} 項，建立於 ${when}` +
    (info.hasCrc ? '（含內容雜湊）' : '（僅結構與時間戳）') + '，請選擇要比對的資料夾')
}

/**
 * Route difference navigation to whichever view is showing.
 *
 * Hex, table and 3-way merge all grew their own navigation; without this the
 * menu items and F7/F8 would still only ever drive the text view.
 *
 * @param {'next'|'prev'|'first'|'last'} where
 */
function navigateDiff(where) {
  const cap = where[0].toUpperCase() + where.slice(1)
  if (currentView === 'text') {
    textCompare?.[`navigate${cap}`]?.()
  } else if (currentView === 'merge3') {
    mergeCompare?.[`${where}Conflict`]?.()
  } else {
    const view = { hex: hexCompare, table: tableCompare }[currentView]
    view?.[`${where}Difference`]?.()
  }
}

// ---------------------------------------------------------------------------
// Session 持久化
// ---------------------------------------------------------------------------

/**
 * Create or update the stored session behind the active tab.
 *
 * The session store, its schema and the Recent Sessions UI were all in place,
 * but nothing ever called store.save(), so the list could only ever be empty.
 * Recording on every path change keeps the entry current without asking the
 * user to save explicitly, which is how BC's automatic recent list behaves.
 *
 * @param {string} type   session type ('text' | 'folder' | …)
 * @param {{ leftPath?: string, rightPath?: string, basePath?: string }} paths
 */
function recordSession(type, paths) {
  const tab = tabMgr.activeTab
  if (!tab) return
  const { leftPath = '', rightPath = '', basePath = '' } = paths
  // Nothing worth remembering until at least one side points somewhere.
  if (!leftPath && !rightPath) return
  // A virtual path cannot be reopened later: the archive listing, the loaded
  // snapshot and the remote session all live only in this window. Recording
  // one would put an entry in "最近的 Session" that fails when clicked.
  if ([leftPath, rightPath, basePath].some((p) => p && sourceKindOf(p) !== 'fs')) return

  const name = (p) => (p ? p.replace(/\\/g, '/').split('/').pop() : '')
  const label = [name(leftPath), name(rightPath)].filter(Boolean).join(' ↔ ') || type

  try {
    if (tab.sessionId) {
      const existing = store.getById(tab.sessionId)
      if (existing) {
        store.save(updateSession(existing, {
          name: label,
          options: { ...existing.options, leftPath, rightPath, basePath },
        }))
        return
      }
    }
    const created = store.save(
      createSession(type, label, { leftPath, rightPath, basePath }))
    tab.sessionId = created.id
  } catch (err) {
    // Persistence must never break the comparison itself.
    console.error('[session] could not record session:', err)
  }
}

// ---------------------------------------------------------------------------
// 應用程式選單
// ---------------------------------------------------------------------------

/**
 * Wire the native menu to renderer actions.
 *
 * The main process only knows command ids; every mapping to a view method
 * lives here. Commands that do not apply to the active view are no-ops rather
 * than errors, matching how BC greys out inapplicable items.
 */
function setupMenuActions() {
  if (!window.electronAPI?.onMenuAction) return

  /** @param {number} delta */
  const zoom = (delta) => {
    if (currentView === 'text' && textCompare) {
      textCompare.setFontSize(textCompare._fontSize + delta)
    } else if (currentView === 'image') {
      if (delta > 0) imageCompare?.zoomIn?.()
      else imageCompare?.zoomOut?.()
    }
  }

  /** @type {Record<string, () => void>} */
  const commands = {
    'session.new.text':   () => newSession('text'),
    'session.new.folder': () => newSession('folder'),
    'session.new.table':  () => newSession('table'),
    'session.new.hex':    () => newSession('hex'),
    'session.new.image':  () => newSession('image'),
    'session.new.merge3': () => newSession('merge3'),
    'session.home':       () => showHome(),
    'session.settings':   () => openConfigModal(),
    'session.workspaces': () => openWorkspacesModal(),
    'session.snapshot.create':    () => void createSnapshot(false),
    'session.snapshot.createCrc': () => void createSnapshot(true),
    'session.snapshot.open':      () => void openSnapshot(),
    'session.registry.export':    () => void exportRegistry(),
    'session.registry.open':      () => void openRegFile(),
    'session.remote.profiles':    () => void manageRemoteProfiles(),
    'session.remote.open':        () => void openRemoteFolder(),

    'session.swap': () => {
      const view = { text: textCompare, folder: folderCompare, hex: hexCompare, table: tableCompare }[currentView]
      void view?.swap?.()
    },
    'session.recompare':  () => {
      if (currentView === 'text') textCompare?.refresh()
      else if (currentView === 'folder') folderCompare?.refresh()
    },
    'session.close':      () => {
      const active = tabMgr.activeTab
      if (active) _handleCloseTab(active.id)
    },

    'file.openLeft':  () => {
      if (currentView === 'text') void textCompare?.openLeft()
      else if (currentView === 'hex') void hexCompare?.openLeft()
      else if (currentView === 'image') void imageCompare?.openLeft()
      else if (currentView === 'folder') void folderCompare?.openLeft?.()
    },
    'file.openRight': () => {
      if (currentView === 'text') void textCompare?.openRight()
      else if (currentView === 'hex') void hexCompare?.openRight()
      else if (currentView === 'image') void imageCompare?.openRight()
      else if (currentView === 'folder') void folderCompare?.openRight?.()
    },
    'file.saveLeft':  () => { if (currentView === 'text') void textCompare?.saveLeft() },
    'file.saveRight': () => { if (currentView === 'text') void textCompare?.saveRight() },
    'file.exportHtml': () => {
      if (currentView === 'text') void textCompare?.exportHtml()
      else if (currentView === 'folder') void folderCompare?.exportHtml()
    },
    'file.encoding.left.UTF-8': () => reloadEncoding('left', 'UTF-8'),
    'file.encoding.left.UTF-16LE': () => reloadEncoding('left', 'UTF-16LE'),
    'file.encoding.left.UTF-16BE': () => reloadEncoding('left', 'UTF-16BE'),
    'file.encoding.left.Big5': () => reloadEncoding('left', 'Big5'),
    'file.encoding.left.GBK': () => reloadEncoding('left', 'GBK'),
    'file.encoding.left.GB18030': () => reloadEncoding('left', 'GB18030'),
    'file.encoding.left.Shift_JIS': () => reloadEncoding('left', 'Shift_JIS'),
    'file.encoding.left.EUC-JP': () => reloadEncoding('left', 'EUC-JP'),
    'file.encoding.left.EUC-KR': () => reloadEncoding('left', 'EUC-KR'),
    'file.encoding.left.windows-1252': () => reloadEncoding('left', 'windows-1252'),
    'file.encoding.left.ISO-8859-1': () => reloadEncoding('left', 'ISO-8859-1'),
    'file.encoding.right.UTF-8': () => reloadEncoding('right', 'UTF-8'),
    'file.encoding.right.UTF-16LE': () => reloadEncoding('right', 'UTF-16LE'),
    'file.encoding.right.UTF-16BE': () => reloadEncoding('right', 'UTF-16BE'),
    'file.encoding.right.Big5': () => reloadEncoding('right', 'Big5'),
    'file.encoding.right.GBK': () => reloadEncoding('right', 'GBK'),
    'file.encoding.right.GB18030': () => reloadEncoding('right', 'GB18030'),
    'file.encoding.right.Shift_JIS': () => reloadEncoding('right', 'Shift_JIS'),
    'file.encoding.right.EUC-JP': () => reloadEncoding('right', 'EUC-JP'),
    'file.encoding.right.EUC-KR': () => reloadEncoding('right', 'EUC-KR'),
    'file.encoding.right.windows-1252': () => reloadEncoding('right', 'windows-1252'),
    'file.encoding.right.ISO-8859-1': () => reloadEncoding('right', 'ISO-8859-1'),

    'file.exportText': () => {
      if (currentView === 'text') void textCompare?.exportTextReport()
      else if (currentView === 'hex') void hexCompare?.exportTextReport()
      else if (currentView === 'table') void tableCompare?.exportTextReport()
      else showStatus('此視圖尚未支援純文字報告')
    },
    'file.exportPatch': () => {
      if (currentView === 'text') void textCompare?.exportUnifiedDiff()
      else showStatus('Unified Diff 僅適用於文字比對')
    },
    'file.print': () => {
      if (currentView === 'text') void textCompare?.exportHtml({ print: true })
      else if (currentView === 'folder') void folderCompare?.exportHtml({ print: true })
    },

    'edit.undo': () => { if (currentView === 'text') textCompare?.undo() },
    'edit.redo': () => { if (currentView === 'text') textCompare?.redo() },
    'edit.toggleEditMode': () => {
      if (currentView !== 'text' || !textCompare) return
      const isEdit = textCompare.toggleEditMode()
      el('btn-edit-mode').classList.toggle('active', isEdit)
      el('btn-edit-mode').title = isEdit ? '退出編輯模式 (Ctrl+E)' : '切換編輯模式 (Ctrl+E)'
    },
    'edit.copyToLeft':     () => { if (currentView === 'text') textCompare?.copyToLeft() },
    'edit.copyToRight':    () => { if (currentView === 'text') textCompare?.copyToRight() },
    'edit.copyAllToLeft':  () => { if (currentView === 'text') textCompare?.copyAllToLeft() },
    'edit.copyAllToRight': () => { if (currentView === 'text') textCompare?.copyAllToRight() },

    'merge.resolveAll.left':  () => { mergeCompare?.resolveAll?.('left') },
    'merge.resolveAll.right': () => { mergeCompare?.resolveAll?.('right') },
    'merge.resolveAll.base':  () => { mergeCompare?.resolveAll?.('base') },
    'merge.resolveAll.both':  () => { mergeCompare?.resolveAll?.('both') },
    'view.merge.conflictsOnly': () => {
      if (!mergeCompare?.getShowFilter) return
      const next = mergeCompare.getShowFilter() === 'conflicts' ? 'all' : 'conflicts'
      mergeCompare.setShowFilter(next)
      showStatus(next === 'conflicts' ? '只顯示衝突' : '顯示全部')
    },

    'search.find': () => {
      if (currentView === 'text') textCompare?.openFind()
      else if (currentView === 'hex') hexCompare?.openFind?.()
      else if (currentView === 'table') tableCompare?.openFind?.()
      else if (currentView === 'folder') folderCompare?.openFindBar?.()
    },
    'search.replace':  () => { if (currentView === 'text') textCompare?.openReplace() },
    'search.gotoLine': () => { if (currentView === 'text') textCompare?.openGoto() },
    'search.nextDiff':  () => navigateDiff('next'),
    'search.prevDiff':  () => navigateDiff('prev'),
    'search.firstDiff': () => navigateDiff('first'),
    'search.lastDiff':  () => navigateDiff('last'),
    'search.toggleBookmark': () => { if (currentView === 'text') textCompare?.toggleBookmark() },
    'search.nextBookmark':   () => { if (currentView === 'text') textCompare?.nextBookmark() },
    'search.prevBookmark':   () => { if (currentView === 'text') textCompare?.prevBookmark() },

    'view.showAll':  () => {
      if (currentView === 'text') textCompare?.setShowFilter('all')
      else if (currentView === 'folder') folderCompare?.setViewPreset('all')
    },
    'view.showDiff': () => {
      if (currentView === 'text') textCompare?.setShowFilter('diff')
      else if (currentView === 'folder') folderCompare?.setViewPreset('differences')
    },
    'view.showSame': () => {
      if (currentView === 'text') textCompare?.setShowFilter('same')
      else if (currentView === 'folder') folderCompare?.setViewPreset('same')
    },
    'view.showNone': () => {
      if (currentView === 'text') textCompare?.setShowFilter('none')
      else if (currentView === 'folder') folderCompare?.setViewPreset('none')
    },
    'view.folder.orphans':        () => folderCompare?.setViewPreset('orphans'),
    'view.folder.noOrphans':      () => folderCompare?.setViewPreset('no-orphans'),
    'view.folder.diffNoOrphans':  () => folderCompare?.setViewPreset('diff-no-orphans'),
    'view.folder.leftNewer':      () => folderCompare?.setViewPreset('left-newer'),
    'view.folder.rightNewer':     () => folderCompare?.setViewPreset('right-newer'),
    'view.folder.leftOrphans':    () => folderCompare?.setViewPreset('left-orphans'),
    'view.folder.rightOrphans':   () => folderCompare?.setViewPreset('right-orphans'),
    'view.toggleIgnoreUnimportant': () => {
      if (currentView !== 'text' || !textCompare) return
      const on = textCompare.setIgnoreUnimportant()
      const chk = el('chk-ignore-unimportant')
      if (chk) chk.checked = on
      showStatus(on ? '已忽略不重要差異' : '已顯示不重要差異')
    },
    'view.toggleLineNumbers': () => { if (currentView === 'text') textCompare?.toggleLineNumbers() },
    'view.toggleWhitespace':  () => { if (currentView === 'text') textCompare?.toggleWhitespace() },
    'view.toggleWordWrap':    () => { if (currentView === 'text') textCompare?.toggleWordWrap() },
    'view.toggleLayout':      () => { if (currentView === 'text') textCompare?.toggleLayout() },
    'view.zoomIn':    () => zoom(1),
    'view.zoomOut':   () => zoom(-1),
    'view.zoomReset': () => {
      if (currentView === 'text') textCompare?.setFontSize(13)
      else if (currentView === 'image') imageCompare?.resetZoom?.()
    },
    'view.toggleTheme': () => el('btn-theme').click(),
    'view.fullScreen':  () => { void window.electronAPI?.toggleFullScreen?.() },

    'tools.ignoreRules':  () => openIgnoreRulesModal(),
    'tools.namedConfigs': () => openConfigModal(),
    'tools.shortcuts':    () => el('btn-settings-modal')?.click(),
    'tools.algorithm.myers':     () => { if (currentView === 'text') textCompare?.setAlgorithm('myers') },
    'tools.algorithm.patience':  () => { if (currentView === 'text') textCompare?.setAlgorithm('patience') },
    'tools.algorithm.histogram': () => { if (currentView === 'text') textCompare?.setAlgorithm('histogram') },

    'help.about': () => showStatus('MyCompare — Electron 版 BeyondCompare 複製品'),
  }

  window.electronAPI.onMenuAction(({ command }) => {
    const fn = commands[command]
    if (!fn) {
      console.warn('[menu] unhandled command:', command)
      return
    }
    try {
      fn()
    } catch (err) {
      console.error(`[menu] ${command} failed:`, err)
    }
  })
}

// ---------------------------------------------------------------------------
// 設定 Modal（自訂快捷鍵 + 偏好）
// ---------------------------------------------------------------------------

/** Human-readable labels for the customisable actions. */
const SHORTCUT_LABELS = {
  nextDiff: '下一個差異',
  prevDiff: '上一個差異',
  firstDiff: '第一個差異',
  lastDiff: '最後一個差異',
  copyLeft: '複製區塊到左側',
  copyRight: '複製區塊到右側',
  copyAllLeft: '複製全部差異到左側',
  copyAllRight: '複製全部差異到右側',
  undo: '復原',
  redo: '取消復原',
  editToggle: '切換編輯模式',
  saveLeft: '儲存左側',
  saveRight: '儲存右側',
  refresh: '重新整理',
  newSession: '回到首頁 / 新增比對',
  closeTab: '關閉分頁',
  fullscreen: '全螢幕',
  print: '列印 / 匯出 PDF',
}

/**
 * Populate the settings modal.
 *
 * The modal markup, SettingsStore and the default binding table all shipped
 * previously, but nothing ever rendered the list or read a binding back, so
 * the feature did nothing at all.
 */
function setupSettingsModal() {
  const modal = el('settings-modal')
  const list = el('settings-shortcuts-list')
  if (!modal || !list) return

  const status = el('settings-modal-status')
  /** @param {string} msg */
  const setStatus = (msg) => { if (status) status.textContent = msg }

  /** @type {{ action: string, cleanup: () => void } | null} */
  let recording = null

  const stopRecording = () => {
    recording?.cleanup()
    recording = null
  }

  function render() {
    list.replaceChildren()
    for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
      const label = SHORTCUT_LABELS[action]
      if (!label) continue

      const row = document.createElement('div')
      row.className = 'settings-row'

      const nameEl = document.createElement('span')
      nameEl.className = 'settings-row-name'
      nameEl.textContent = label

      const comboEl = document.createElement('code')
      comboEl.className = 'settings-row-combo'
      comboEl.textContent = settings.getShortcut(action) || '（未設定）'

      const btnRecord = document.createElement('button')
      btnRecord.textContent = '錄製'
      btnRecord.addEventListener('click', () => {
        stopRecording()
        btnRecord.textContent = '按下按鍵…'
        setStatus('按下想要的組合鍵，Esc 取消')

        /** @param {KeyboardEvent} e */
        const onKey = (e) => {
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'Escape') {
            stopRecording()
            render()
            setStatus('已取消')
            return
          }
          const combo = eventToCombo(e)
          if (!combo) return // modifier-only press; keep waiting
          const clash = Object.keys(DEFAULT_SHORTCUTS)
            .find((a) => a !== action && settings.getShortcut(a) === combo)
          settings.setShortcut(action, combo)
          stopRecording()
          render()
          setStatus(clash
            ? `已設定 ${combo}，但與「${SHORTCUT_LABELS[clash] ?? clash}」衝突`
            : `已設定 ${combo}`)
        }

        document.addEventListener('keydown', onKey, true)
        recording = {
          action,
          cleanup: () => document.removeEventListener('keydown', onKey, true),
        }
      })

      const btnClear = document.createElement('button')
      btnClear.textContent = '清除'
      btnClear.addEventListener('click', () => {
        settings.setShortcut(action, '')
        render()
        setStatus(`已清除「${label}」`)
      })

      row.append(nameEl, comboEl, btnRecord, btnClear)
      list.appendChild(row)
    }
  }

  const open = () => { render(); setStatus(''); modal.style.display = 'flex' }
  const close = () => { stopRecording(); modal.style.display = 'none' }

  el('btn-settings-modal')?.addEventListener('click', open)
  el('btn-settings-modal-close')?.addEventListener('click', close)
  el('btn-settings-modal-cancel')?.addEventListener('click', close)
  el('btn-settings-reset')?.addEventListener('click', () => {
    settings.reset()
    render()
    setStatus('已恢復預設')
  })
}

// ---------------------------------------------------------------------------
// 忽略規則 Modal
// ---------------------------------------------------------------------------
function openIgnoreRulesModal() {
  el('ignore-rules-modal').style.display = 'flex'
}

function closeIgnoreRulesModal() {
  el('ignore-rules-modal').style.display = 'none'
}

// ---------------------------------------------------------------------------
// 主題切換
// ---------------------------------------------------------------------------

/**
 * T20: Detect system colour scheme on first load (no user preference stored).
 * Also listens for system theme changes while the app is running.
 */
function initSystemTheme() {
  const stored = localStorage.getItem('mycompare:theme')
  if (!stored) {
    // No user preference yet: follow system
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light'
  }
  // Listen for system theme changes (only if user hasn't overridden)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('mycompare:theme')) {
      document.documentElement.dataset.theme = e.matches ? 'dark' : 'light'
    }
  })
}

function setupTheme() {
  initSystemTheme()
  el('btn-theme').addEventListener('click', () => {
    const html = document.documentElement
    const next = html.dataset.theme === 'dark' ? 'light' : 'dark'
    html.dataset.theme = next
    localStorage.setItem('mycompare:theme', next)  // T20: persist user choice
  })
}

// ---------------------------------------------------------------------------
// Session 開啟 / 移除
// ---------------------------------------------------------------------------
async function openSession(session) {
  if (!session) return

  // createSession() nests paths under `options`, while some callers hand over
  // an already-flattened record. Reading only the top level meant a stored
  // session opened an empty tab.
  const leftPath = session.options?.leftPath ?? session.leftPath ?? ''
  const rightPath = session.options?.rightPath ?? session.rightPath ?? ''
  const basePath = session.options?.basePath ?? session.basePath ?? ''

  if (!leftPath && !rightPath) {
    showStatus('此 session 沒有記錄任何路徑')
    return
  }

  // Every type routes through the same loader, so opening a stored hex, image,
  // table or merge session works rather than reporting "功能開發中".
  await openComparison({
    type: session.type,
    leftPath,
    rightPath,
    basePath,
    algorithm: session.options?.algorithm,
  })
}

function removeSession(id) {
  store.remove(id)
  // 重新渲染 recent sessions
  renderRecentSessions(openSession, removeSession)
}

// ---------------------------------------------------------------------------
// 工具函式
// ---------------------------------------------------------------------------
function el(id) {
  return document.getElementById(id)
}

function setDisabled(id, disabled) {
  const btn = el(id)
  if (btn) btn.disabled = disabled
}

function showStatus(message) {
  const statusEl = el('status-message')
  if (statusEl) {
    statusEl.textContent = message
    statusEl.removeAttribute('data-level')
    statusEl.style.fontWeight = ''
    statusEl.style.color = ''
    // 3 秒後恢復
    setTimeout(() => {
      // An error raised in the meantime must not be wiped by this timer.
      if (statusEl.dataset.level === 'error') return
      statusEl.textContent = '就緒'
    }, 3000)
  }
}

/**
 * Report a failure the user can see and act on.
 *
 * Deliberately sticky: the reason a file opened blank on both sides went
 * unnoticed for so long is that the failure was swallowed, and a message that
 * clears itself after three seconds is barely better than none.
 *
 * @param {string} message
 * @param {unknown} [cause]
 */
function showError(message, cause) {
  if (cause) console.error(message, cause)
  else console.error(message)
  const statusEl = el('status-message')
  if (!statusEl) return
  statusEl.textContent = `⚠ ${message}`
  statusEl.dataset.level = 'error'
  // The status bar has no error styling of its own and its stylesheet is not
  // this module's to extend, so the emphasis is applied directly.
  statusEl.style.color = '#ffd7d5'
  statusEl.style.fontWeight = '600'
}

/**
 * Read a path as text, whichever store it lives in.
 *
 * `readFile` only accepts filesystem paths — the path validator rejects the
 * `::`, `snapshot://` and `remote://` forms outright — so routing by scheme is
 * what makes a file inside an archive or on a remote host openable at all.
 *
 * @param {string} path
 * @returns {Promise<{ content: string, encoding?: string }>}
 */
async function readPathText(path) {
  const bin = await readPathBinaryOrNull(path)
  if (bin) {
    const bytes = Uint8Array.from(atob(bin.base64), (c) => c.charCodeAt(0))
    return { content: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8' }
  }
  const r = await window.electronAPI.readFile(path)
  return { content: r?.content ?? '', encoding: r?.encoding }
}

/**
 * Read a path as base64 bytes, whichever store it lives in.
 *
 * @param {string} path
 * @param {number} [maxBytes]
 * @returns {Promise<{ path: string, base64: string, ext?: string }>}
 */
async function readPathBinary(path, maxBytes) {
  const virtual = await readPathBinaryOrNull(path, maxBytes)
  if (virtual) return virtual
  return window.electronAPI.readFileBinary(path, maxBytes)
}

/**
 * Bytes for a virtual path, or null when the path is an ordinary file.
 * @param {string} path
 * @param {number} [maxBytes]
 * @returns {Promise<{ path: string, base64: string, ext?: string }|null>}
 */
async function readPathBinaryOrNull(path, maxBytes) {
  const { kind, container, entry } = parseVirtualPath(path)
  const ext = (path.split('.').pop() ?? '').toLowerCase()

  if (kind === 'archive') {
    const base64 = await window.electronAPI.readArchiveEntry(container, entry)
    return { path, base64, ext }
  }
  if (kind === 'remote') {
    const r = await window.electronAPI.remoteReadFile(container, entry, maxBytes, _remoteSecrets.get(container))
    return { path, base64: r?.base64 ?? '', ext }
  }
  if (kind === 'snapshot') {
    // A snapshot records structure and timestamps only; there is nothing to
    // read back, and pretending otherwise would show an empty file as "same".
    throw new Error('快照未儲存檔案內容，只能比對結構與時間戳')
  }
  return null
}
