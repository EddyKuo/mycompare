import { TextCompare } from './views/text-compare.js'
import { FolderCompare } from './views/folder-compare.js'
import { TableCompare } from './views/table-compare.js'
import { ImageCompare } from './views/image-compare.js'
import { HexCompare } from './views/hex-compare.js'
import { ThreeWayCompare } from './views/three-way-compare.js'
import { renderRecentSessions, store } from './core/session-home-ui.js'
import { getViewTypeForPath } from './core/file-type.js'
import { NamedConfigStore } from './core/named-config-store.js'
import { WorkspaceStore } from './core/workspace-store.js'
import { setActiveView } from './core/active-view.js'

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

// ---------------------------------------------------------------------------
// 公開入口
// ---------------------------------------------------------------------------
export function initApp() {
  setupTheme()
  setupViewSwitching()
  setupToolbarButtons()
  setupPathBarButtons()
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
          .then(r => { if (r) textCompare.setLeft(r.path, r.content) })
          .catch(() => {})
      }
      if (textCompare && right) {
        window.electronAPI.readFile(right)
          .then(r => { if (r) textCompare.setRight(r.path, r.content) })
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
      mergeCompare?._setContents?.('left',  left)
      mergeCompare?._setContents?.('base',  base)
      mergeCompare?._setContents?.('right', right)
    },
    mergeGetConflictCount: () => document.querySelectorAll('.mw-conflict-card').length,
  }
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
      el('path-left').textContent = left || '（未選擇）'
      el('path-right').textContent = right || '（未選擇）'
      tabMgr.updateActivePaths({ leftPath: left ?? '', rightPath: right ?? '' })
      if (left || right) {
        const name = (p) => p ? p.replace(/\\/g, '/').split('/').pop() : ''
        tabMgr.updateActiveTitle(`${name(left)} ↔ ${name(right)}`)
      }
      updateToolbar()
    })

    folderCompare.on('open-file-compare', async ({ leftPath, leftContent, rightPath, rightContent, algorithm }) => {
      const viewType = getViewTypeForPath(leftPath || rightPath)

      if (viewType === 'image') {
        tabMgr.addTab('image', '圖片比對')
        showImageCompare()
        // image 需要 base64；透過 readFileBinary IPC 讀取
        if (leftPath) {
          try {
            const r = await window.electronAPI.readFileBinary(leftPath)
            if (r) await imageCompare?.setLeft(r.path, r.base64, r.ext)
          } catch { /* 讓使用者手動開啟 */ }
        }
        if (rightPath) {
          try {
            const r = await window.electronAPI.readFileBinary(rightPath)
            if (r) await imageCompare?.setRight(r.path, r.base64, r.ext)
          } catch { /* 讓使用者手動開啟 */ }
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
          try { lContent = (await window.electronAPI.readFile(leftPath))?.content ?? '' } catch { lContent = '' }
        }
        if (rContent === undefined && rightPath) {
          try { rContent = (await window.electronAPI.readFile(rightPath))?.content ?? '' } catch { rContent = '' }
        }
        if (leftPath)  tableCompare?.setLeft(leftPath, lContent ?? '')
        if (rightPath) tableCompare?.setRight(rightPath, rContent ?? '')
        return
      }

      if (viewType === 'hex') {
        tabMgr.addTab('hex', 'Hex 比對')
        showHexCompare()
        // hex 需要 base64；透過 readFileBinary IPC 讀取
        if (leftPath) {
          try {
            const r = await window.electronAPI.readFileBinary(leftPath)
            if (r) hexCompare?.setLeft(r.path, r.base64)
          } catch { /* 讓使用者手動開啟 */ }
        }
        if (rightPath) {
          try {
            const r = await window.electronAPI.readFileBinary(rightPath)
            if (r) hexCompare?.setRight(r.path, r.base64)
          } catch { /* 讓使用者手動開啟 */ }
        }
        return
      }

      // Default: text
      let lContent = leftContent
      let rContent = rightContent
      if (lContent === undefined && leftPath) {
        try {
          const result = await window.electronAPI.readFile(leftPath)
          lContent = result?.content ?? ''
        } catch {
          lContent = ''
        }
      }
      if (rContent === undefined && rightPath) {
        try {
          const result = await window.electronAPI.readFile(rightPath)
          rContent = result?.content ?? ''
        } catch {
          rContent = ''
        }
      }
      tabMgr.addTab('text', '文字比對')
      showTextCompare()
      if (textCompare) {
        textCompare.setLeft(leftPath, lContent ?? '')
        textCompare.setRight(rightPath, rContent ?? '')
        if (algorithm) textCompare.setAlgorithm(algorithm)
      }
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
            if (r) textCompare?.setLeft(r.path, r.content)
          }).catch(() => {})
        }
        if (tab.rightPath && textCompare) {
          window.electronAPI.readFile(tab.rightPath).then(r => {
            if (r) textCompare?.setRight(r.path, r.content)
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
function setupViewSwitching() {
  document.querySelectorAll('.session-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type
      const labelText = btn.querySelector('.label')?.textContent ?? type

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
          showStatus(`${labelText} 功能開發中`)
          break
      }
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
function _getActiveConfigurableView() {
  if (currentView === 'text' && textCompare) return { view: textCompare, type: 'text' }
  return { view: null, type: null }
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
            if (r) textCompare.setLeft(r.path, r.content)
          } catch { /* skip */ }
        }
        if (saved.rightPath) {
          try {
            const r = await window.electronAPI.readFile(saved.rightPath)
            if (r) textCompare.setRight(r.path, r.content)
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
            const r = await window.electronAPI.readFileBinary(saved.leftPath)
            if (r) await imageCompare.setLeft(r.path, r.base64, r.ext)
          } catch { /* skip */ }
        }
        if (saved.rightPath) {
          try {
            const r = await window.electronAPI.readFileBinary(saved.rightPath)
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
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // 在 edit-textarea 中允許 Ctrl+S / Ctrl+Shift+S / Ctrl+E 觸發；其他 input/textarea 則略過
    const isEditTextarea = e.target.classList?.contains('edit-textarea')
    if (e.target.matches('input, textarea') && !isEditTextarea) return
    // 在 edit-textarea 中，只處理特定快捷鍵，其餘讓瀏覽器正常處理
    if (isEditTextarea) {
      if (!((e.key === 's' && e.ctrlKey) || (e.key === 'e' && e.ctrlKey))) return
    }

    switch (true) {
      case e.key === 'F7' && !e.altKey && !e.ctrlKey:
        e.preventDefault()
        if (currentView === 'text') textCompare?.navigatePrev()
        break

      case e.key === 'F8' && !e.altKey && !e.ctrlKey:
        e.preventDefault()
        if (currentView === 'text') textCompare?.navigateNext()
        break

      case e.key === 'Home' && e.altKey:
        e.preventDefault()
        if (currentView === 'text') textCompare?.navigateFirst()
        break

      case e.key === 'End' && e.altKey:
        e.preventDefault()
        if (currentView === 'text') textCompare?.navigateLast()
        break

      case e.key === 'ArrowLeft' && e.altKey:
        e.preventDefault()
        if (currentView === 'text') textCompare?.copyToLeft()
        break

      case e.key === 'ArrowRight' && e.altKey:
        e.preventDefault()
        if (currentView === 'text') textCompare?.copyToRight()
        break

      case e.key === 'F5':
        e.preventDefault()
        if (currentView === 'text') textCompare?.refresh()
        else if (currentView === 'folder') folderCompare?.refresh()
        break

      case e.key === 'n' && e.ctrlKey:
        e.preventDefault()
        showHome()
        break

      case e.key === 'w' && e.ctrlKey: {
        e.preventDefault()
        const active = tabMgr.activeTab
        if (active) _handleCloseTab(active.id)
        break
      }

      case e.key === 'e' && e.ctrlKey:
        e.preventDefault()
        if (currentView === 'text' && textCompare) {
          const isEdit = textCompare.toggleEditMode()
          el('btn-edit-mode').classList.toggle('active', isEdit)
          el('btn-edit-mode').title = isEdit ? '退出編輯模式 (Ctrl+E)' : '切換編輯模式 (Ctrl+E)'
        }
        break

      case e.key === 's' && e.ctrlKey && !e.shiftKey:
        e.preventDefault()
        if (currentView === 'text') textCompare?.saveLeft()
        break

      case e.key === 's' && e.ctrlKey && e.shiftKey:
        e.preventDefault()
        if (currentView === 'text') textCompare?.saveRight()
        break

      // T60: F11 toggles application full-screen (works in all views)
      case e.key === 'F11':
        e.preventDefault()
        window.electronAPI?.toggleFullScreen?.()
        break

      // T62: Ctrl+P opens print preview of the current view's HTML report
      case e.key === 'p' && e.ctrlKey && !e.shiftKey:
        e.preventDefault()
        if (currentView === 'text') textCompare?.exportHtml({ print: true })
        else if (currentView === 'folder') folderCompare?.exportHtml({ print: true })
        break
    }
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

  switch (session.type) {
    case 'text': {
      tabMgr.addTab('text', '文字比對')
      showTextCompare()
      if (session.leftPath && session.rightPath && textCompare) {
        try {
          const [left, right] = await Promise.all([
            window.electronAPI.readFile(session.leftPath),
            window.electronAPI.readFile(session.rightPath)
          ])
          if (left) textCompare.setLeft(left.path, left.content)
          if (right) textCompare.setRight(right.path, right.content)
        } catch (err) {
          showStatus(`無法開啟 session：${err.message}`)
        }
      }
      break
    }
    case 'folder': {
      tabMgr.addTab('folder', '資料夾比對')
      showFolderCompare()
      if (session.leftPath && folderCompare) folderCompare.setLeft(session.leftPath)
      if (session.rightPath && folderCompare) folderCompare.setRight(session.rightPath)
      break
    }
    default:
      showStatus(`${session.type} session 功能開發中`)
  }
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
    // 3 秒後恢復
    setTimeout(() => {
      statusEl.textContent = '就緒'
    }, 3000)
  }
}
