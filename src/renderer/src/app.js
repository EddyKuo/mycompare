import { TextCompare, FONT_CHOICES } from './views/text-compare.js'
import { FolderCompare, parseVirtualPath, sourceKindOf } from './views/folder-compare.js'
import { TableCompare } from './views/table-compare.js'
import { ImageCompare, MAX_IMAGE_BYTES } from './views/image-compare.js'
import { HexCompare } from './views/hex-compare.js'
import { ThreeWayCompare } from './views/three-way-compare.js'
import { renderRecentSessions, store } from './core/session-home-ui.js'
import { createSession, updateSession } from './core/session.js'
import { getViewTypeForPath, getViewChoicesForPath, parentFolderOf } from './core/file-type.js'
import { NamedConfigStore } from './core/named-config-store.js'
import { describeNavResult } from './core/diff-nav.js'
import { WorkspaceStore } from './core/workspace-store.js'
import { setActiveView } from './core/active-view.js'
import {
  BUILTIN_GRAMMARS,
  compileGrammar,
  getUserGrammars,
  setUserGrammars,
} from './core/grammar.js'
import {
  SettingsStore,
  DEFAULT_SHORTCUTS,
  DEFAULT_FONTS,
  BACKUP_NAMING_OPTIONS,
  COLOR_TOKENS,
  PREF_PAGES,
  TOOLBAR_COMMANDS,
  applySettingsBundle,
  eventToCombo,
  exportSettingsJSON,
  findShortcutConflicts,
  keyComboMatches,
  loadUserGrammarDefs,
  saveUserGrammarDefs,
} from './core/settings-store.js'

// ---------------------------------------------------------------------------
// TabManager — session-record-based tab bar
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, type: string, title: string, leftPath: string, rightPath: string,
 *             basePath: string, state: object|null, locked: boolean, sessionId?: string }} TabRecord
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
    const tab = { id, type, title, leftPath: '', rightPath: '', basePath: '', state: null, locked: false }
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
   * Lock or unlock the active tab.
   * @param {boolean} locked
   * @returns {boolean} the resulting state
   */
  setActiveLocked(locked) {
    const tab = this.activeTab
    if (!tab) return false
    tab.locked = locked
    this._render()
    return locked
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
      // The padlock has to be visible on the tab itself: a lock the user cannot
      // see is indistinguishable from a refresh command that is simply broken.
      titleEl.textContent = tab.locked ? `🔒 ${tab.title}` : tab.title
      titleEl.title = tab.locked ? `${tab.title}（已鎖定）` : tab.title

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

/**
 * Opens the Options dialog on a named page. Replaced by setupSettingsModal;
 * until then a command that needs a page has to say so rather than do nothing.
 * @type {(pane: string) => void}
 */
let _openOptionsPane = () => showStatus('選項對話框尚未初始化')

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
  applyAppearance()
  applyDisplayPrefs()
  applyCommandVisibility()
  restoreUserGrammars()
  void refreshPortableState()
  setupViewSwitching()
  setupToolbarButtons()
  setupPathBarButtons()
  setupMenuActions()
  setupSettingsModal()
  setupGrammarModal()
  setupPrintPreview()
  setupViewPrintInterception()
  setupViewPicker()
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

    // Text injection. Without it a spec could only assert that an entry point
    // exists, never that the comparison it opens does the right thing.
    // These throw rather than no-op: a silently skipped injection would leave
    // the assertions passing against an empty view.
    textSetLeft: (path, content, encoding) => {
      if (!textCompare) throw new Error('文字比對尚未建立，請先切換到文字比對視圖')
      textCompare.setLeft(path, content, encoding)
    },
    textSetRight: (path, content, encoding) => {
      if (!textCompare) throw new Error('文字比對尚未建立，請先切換到文字比對視圖')
      textCompare.setRight(path, content, encoding)
    },
    textOpenPatch: (patchText, label) => {
      if (!textCompare) throw new Error('文字比對尚未建立，請先切換到文字比對視圖')
      return textCompare.openPatch(patchText, label).length
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
    // `paths` is optional so existing specs keep working; without it the view
    // has no parent folders and the parent-folders hand-off cannot be exercised.
    mergeSetAll: (left, base, right, paths) => {
      mergeCompare?.setSide('left',  left,  paths?.left)
      mergeCompare?.setSide('base',  base,  paths?.base)
      mergeCompare?.setSide('right', right, paths?.right)
    },
    mergeGetConflictCount: () => document.querySelectorAll('.mw-conflict-card').length,

    // S17: difference navigation is routed centrally, so the e2e check is
    // "does the key reach the active view", not per-view internals.
    navDiffIndex: () => {
      const view = {
        text: textCompare, hex: hexCompare, table: tableCompare,
        image: imageCompare, folder: folderCompare,
      }[currentView]
      if (currentView === 'merge3') return mergeCompare?.getCurrentConflictIndex?.() ?? -1
      if (currentView === 'text') return textCompare?._currentDiff ?? -1
      return view?.getCurrentDiffIndex?.() ?? -1
    },
    navStatusText: () => el('status-message')?.textContent ?? '',

    // Tab bookkeeping and the menu dispatch table, so a spec can drive commands
    // that only a native menu offers and then assert on what the tabs did.
    tabs: () => tabMgr.tabs.map((t) => ({
      id: t.id, type: t.type, title: t.title, locked: t.locked,
      leftPath: t.leftPath, rightPath: t.rightPath,
    })),
    menuCommand: (command) => {
      const fn = _menuCommands[command]
      if (!fn) throw new Error(`unhandled menu command: ${command}`)
      fn()
    },
    configListNames: () => [...document.querySelectorAll('#config-list .name')]
      .map((n) => n.textContent ?? ''),
    navSetPref: (name, value) => settings.setPref(name, value),

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

    // Backup outcome of a save — the file is written either way, so this is
    // information rather than a failure.
    // Text compare can hand its two files to a three-way merge. Only the host
    // can open a tab, so the view asks rather than trying to do it itself.
    textCompare.on('merge-files', ({ left, base, right }) => {
      tabMgr.addTab('merge3', '三向合併')
      showMerge3()
      mergeCompare?.setSide('left', left?.content ?? '', left?.path ?? '')
      mergeCompare?.setSide('base', base?.content ?? '', base?.path ?? '')
      mergeCompare?.setSide('right', right?.content ?? '', right?.path ?? '')
      showStatus(base?.path ? '已轉為三向合併' : '已轉為三向合併（無基準檔）')
    })

    textCompare.on('status', ({ message }) => {
      if (message) showStatus(message)
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
    // A failed drop or read has no other way to reach the user; without this
    // the view falls back to a toast, which is easy to miss.
    tableCompare.on('status', _viewStatus)
    tableCompare.on('paths-changed', ({ left, right }) => {
      recordSession('table', { leftPath: left ?? '', rightPath: right ?? '' })
      el('path-left').textContent = left || '（未選擇）'
      el('path-right').textContent = right || '（未選擇）'
      _syncActiveTabPaths(left, right)
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
      _syncActiveTabPaths(left, right)
      updateToolbar()
    })
    // A drop that fails has no other way to reach the user.
    imageCompare.on('status', _viewStatus)
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
    // A failed drop or read has no other way to reach the user; without this
    // the view falls back to a toast, which is easy to miss.
    hexCompare.on('status', _viewStatus)
    hexCompare.on('paths-changed', ({ left, right }) => {
      recordSession('hex', { leftPath: left ?? '', rightPath: right ?? '' })
      el('path-left').textContent = left || '（未選擇）'
      el('path-right').textContent = right || '（未選擇）'
      _syncActiveTabPaths(left, right)
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

    // A failed drop or read has no other way to reach the user; without this
    // the view falls back to a toast, which is easy to miss.
    mergeCompare.on('status', _viewStatus)

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

    // BC's Merge Parent Folders. The view deliberately does not choose which
    // pair to open — this app has no three-way folder compare, so the choice
    // only exists at this level. Subscribing is also what enables the view's
    // button, which stays disabled while nobody can service it.
    mergeCompare.on('open-parent-folders', ({ left, base, right }) => {
      void openMergeParentFolders({ left, base, right })
    })

    // BC's Compare to Output. Without this the view falls back to its own
    // read-only dialog; a real text-compare tab can be edited and saved.
    mergeCompare.on('compare-to-output', ({ side, sourcePath, sourceText, outputText }) => {
      void openMergeOutputCompare(side, sourcePath, sourceText, outputText)
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

  // Unsaved edits come first: losing typed bytes or edited cells is the only
  // irreversible thing closing a tab can do, so it is asked about even when the
  // generic confirmation preference is off.
  const guard = _confirmDiscardForTab(closing)
  if (!guard.ok) return

  // Having just answered a question about this very tab, the user does not need
  // a second, weaker one.
  if (!guard.asked && settings.getPref('confirmOnCloseTab') && closing
      && !window.confirm(`關閉「${closing.title}」？`)) {
    return
  }
  const nextTab = tabMgr.closeTab(id)
  _disposeViewIfUnused(closing?.type ?? '')
  if (nextTab) {
    _handleActivateTab(nextTab.id, true)
  } else {
    showHome()
  }
}

/**
 * Ask the view behind a tab whether its unsaved work may be thrown away.
 *
 * Only the table and hex views can hold unsaved edits today; both already
 * implemented the question and neither was ever asked, so closing a tab
 * discarded edited cells and typed bytes without a word.
 *
 * @param {TabRecord|null|undefined} tab
 * @returns {{ ok: boolean, asked: boolean }} `asked` reports whether the user
 *   was actually shown a dialog, so the caller can avoid stacking a second one.
 */
function _confirmDiscardForTab(tab) {
  if (!tab) return { ok: true, asked: false }

  if (tab.type === 'table' && typeof tableCompare?.confirmDiscardChanges === 'function') {
    const dirty = tableCompare.hasUnsavedChanges?.() === true
    return { ok: tableCompare.confirmDiscardChanges(), asked: dirty }
  }
  if (tab.type === 'hex' && typeof hexCompare?.confirmClose === 'function') {
    const dirty = hexCompare.hasUnsavedEdits?.() === true
    return { ok: hexCompare.confirmClose(), asked: dirty }
  }
  // The merge view's output pane became editable, so it now has unsaved work
  // to lose in exactly the way hex and table do.
  if (tab.type === 'merge3' && typeof mergeCompare?.confirmClose === 'function') {
    const dirty = mergeCompare.hasUnsavedEdits?.() === true
    return { ok: mergeCompare.confirmClose(), asked: dirty }
  }
  return { ok: true, asked: false }
}

/**
 * Ask once per view type before an operation that closes every tab.
 *
 * Views are shared between tabs of the same type, so asking per tab would put
 * the same question up several times for the same unsaved buffer.
 *
 * @returns {boolean} true when it is safe to proceed
 */
function _confirmDiscardAllTabs() {
  const seen = new Set()
  for (const tab of tabMgr.tabs) {
    if (seen.has(tab.type)) continue
    seen.add(tab.type)
    if (!_confirmDiscardForTab(tab).ok) return false
  }
  return true
}

/**
 * Record the paths a view just opened onto the active tab.
 *
 * The text and folder views did this; table, image and hex did not, which left
 * their tab records empty — so a saved workspace restored them blank and
 * anything reading the tab's paths (parent folders, re-open as…) had nothing
 * to work with.
 *
 * @param {string|undefined|null} left
 * @param {string|undefined|null} right
 */
function _syncActiveTabPaths(left, right) {
  tabMgr.updateActivePaths({ leftPath: left ?? '', rightPath: right ?? '' })
  const title = _titleFromPaths(left ?? '', right ?? '')
  if (title) tabMgr.updateActiveTitle(title)
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
    if (isActiveTabLocked('重新整理')) return
    if (currentView === 'text') textCompare?.refresh()
    else if (currentView === 'folder') folderCompare?.refresh()
    else if (currentView === 'table') tableCompare?.refresh()
    else if (currentView === 'image') imageCompare?.refresh()
    else if (currentView === 'hex') hexCompare?.refresh()
    // merge3 has its own open buttons; no global refresh needed
  })

  el('btn-export').addEventListener('click', openReportModal)

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

  // T62 / P2-28: print goes through the preview, not straight to the dialog.
  el('btn-print-report')?.addEventListener('click', openPrintPreview)

  // T61: Session Settings Dialog (Named Configs)
  el('btn-config-modal')?.addEventListener('click', openConfigModal)
  el('btn-config-modal-close')?.addEventListener('click', closeConfigModal)
  el('btn-config-modal-cancel')?.addEventListener('click', closeConfigModal)
  el('btn-config-save')?.addEventListener('click', handleConfigSave)

  // Report dialog (save / copy)
  el('btn-report-modal-close')?.addEventListener('click', closeReportModal)
  el('btn-report-modal-cancel')?.addEventListener('click', closeReportModal)
  el('btn-report-save-html')?.addEventListener('click', () => void runReportAction('save-html'))
  el('btn-report-save-text')?.addEventListener('click', () => void runReportAction('save-text'))
  el('btn-report-copy-html')?.addEventListener('click', () => void runReportAction('copy-html'))
  el('btn-report-copy-text')?.addEventListener('click', () => void runReportAction('copy-text'))

  // T63: Workspaces
  el('btn-workspaces')?.addEventListener('click', openWorkspacesModal)
  el('btn-workspaces-modal-close')?.addEventListener('click', closeWorkspacesModal)
  el('btn-workspaces-modal-cancel')?.addEventListener('click', closeWorkspacesModal)
  el('btn-workspace-save')?.addEventListener('click', handleWorkspaceSave)
}

// ---------------------------------------------------------------------------
// Report dialog — save or copy the active view's report
// ---------------------------------------------------------------------------

/**
 * What the active view can produce.
 *
 * Duck-typed rather than table-driven: views gain report builders one at a
 * time, and a table would silently keep a newly capable view greyed out.
 *
 * @returns {{ view: any, html: boolean, text: boolean, htmlFallback: boolean, textFallback: boolean }}
 */
/**
 * The view object backing the active tab, or null.
 *
 * One map rather than one per caller: a second copy is how a newly added view
 * ends up supported by reports and not by reload, or the reverse.
 *
 * @returns {object|null}
 */
function _activeViewInstance() {
  return {
    text: textCompare, folder: folderCompare, table: tableCompare,
    image: imageCompare, hex: hexCompare, merge3: mergeCompare,
  }[currentView] ?? null
}

function _activeReportSource() {
  const view = _activeViewInstance()
  return {
    view,
    html: typeof view?.buildHtmlReport === 'function',
    text: typeof view?.buildTextReport === 'function',
    // Some views only expose the whole save-to-disk operation; that still
    // covers "save", just not "copy".
    htmlFallback: typeof view?.exportHtml === 'function',
    textFallback: typeof view?.exportTextReport === 'function',
  }
}

/**
 * @param {ReturnType<typeof _activeReportSource>} src
 * @returns {boolean}
 */
function _hasAnyReport(src) {
  return Boolean(src.html || src.text || src.htmlFallback || src.textFallback)
}

function openReportModal() {
  const overlay = el('report-modal')
  if (!overlay) return
  const src = _activeReportSource()

  const subtitle = el('report-modal-view')
  if (subtitle) {
    subtitle.textContent = _hasAnyReport(src)
      ? `目前視圖：${VIEW_TYPE_LABELS[currentView] ?? currentView}`
      : '目前視圖不支援報告'
  }
  setDisabled('btn-report-save-html', !(src.html || src.htmlFallback))
  setDisabled('btn-report-save-text', !(src.text || src.textFallback))
  setDisabled('btn-report-copy-html', !src.html)
  setDisabled('btn-report-copy-text', !src.text)

  _setReportStatus('')
  overlay.style.display = 'flex'
}

function closeReportModal() {
  const overlay = el('report-modal')
  if (overlay) overlay.style.display = 'none'
}

/**
 * Report progress where the user is looking: inside the dialog when it is
 * open, and in the status bar when the same action came from the menu.
 *
 * @param {string} msg
 * @param {boolean} [isError]
 */
function _setReportStatus(msg, isError = false) {
  const status = el('report-modal-status')
  if (status) status.textContent = msg
  const overlay = el('report-modal')
  const modalVisible = overlay ? overlay.style.display !== 'none' : false
  if (!modalVisible && msg) {
    if (isError) showError(msg)
    else showStatus(msg)
  }
}

/**
 * @param {'save-html'|'save-text'|'copy-html'|'copy-text'} action
 * @returns {Promise<void>}
 */
/**
 * Print the active view's report.
 *
 * Routed through the same resolver the report dialog uses. The previous
 * hardcoded text/folder branch meant a view that gained a report still could
 * not print it, and said nothing when the menu item did nothing.
 */
/**
 * Route a view's status event to the status bar.
 *
 * @param {{message: string, level?: string}} evt
 */
function _viewStatus({ message, level }) {
  if (level === 'error') showError(message)
  else showStatus(message)
}

/**
 * Run something on the text view, or say why it did nothing.
 *
 * @param {(v: any) => void} fn
 * @param {string} label named in the message when the view is not active
 */
function _textView(fn, label) {
  if (currentView !== 'text' || !textCompare) {
    showStatus(`${label}僅適用於文字比對`)
    return
  }
  try {
    fn(textCompare)
  } catch (err) {
    showError(`${label}失敗：${err?.message ?? err}`, err)
  }
}

/**
 * Run a folder-view command from the menu.
 *
 * @param {string} method
 * @param {string} label for the message when the command does not apply
 */
async function _folderNav(method, label) {
  if (currentView !== 'folder' || typeof folderCompare?.[method] !== 'function') {
    showStatus(`${label}僅適用於資料夾比對`)
    return
  }
  try {
    await folderCompare[method]()
  } catch (err) {
    showError(`${label}失敗：${err?.message ?? err}`, err)
  }
}

/**
 * Copy one side's timestamps onto the other for the selected folder rows.
 *
 * @param {'left-to-right'|'right-to-left'} direction
 */
async function _folderTouch(direction) {
  if (currentView !== 'folder' || typeof folderCompare?.touchSelected !== 'function') {
    showStatus('同步時間戳僅適用於資料夾比對')
    return
  }
  try {
    await folderCompare.touchSelected(direction)
  } catch (err) {
    showError(`同步時間戳失敗：${err instanceof Error ? err.message : String(err)}`, err)
  }
}

/**
 * Diff the merge output against one of its sources.
 *
 * @param {'left'|'base'|'right'} side
 */
function _mergeCompareOutput(side) {
  if (currentView !== 'merge3' || !mergeCompare) {
    showStatus('與合併輸出比對僅適用於三向合併')
    return
  }
  // A false return means the view already told the user why; saying it twice
  // in two places would be worse than saying it once where they are looking.
  mergeCompare.compareToOutput(side)
}

/**
 * Text edit commands that also appear in the native menu.
 *
 * Listed rather than derived because the menu is built in the main process,
 * before any view exists. `tests/unit/text-menu-commands.test.js` asserts this
 * matches the view's own table, so adding a command without a menu entry — or
 * the reverse — fails rather than going unnoticed.
 */
/**
 * Whitespace comparison modes, as menu ids.
 *
 * Spelled out rather than built from a template so the wiring test can see
 * them: it reads ids out of the source, and a generated string is invisible to
 * it — which is precisely how a menu item ends up dispatching to nothing.
 */
const WHITESPACE_MODE_IDS = Object.freeze([
  'text.whitespaceMode.none',
  'text.whitespaceMode.all',
  'text.whitespaceMode.leading',
  'text.whitespaceMode.trailing',
  'text.whitespaceMode.amount',
])

/** Numbered bookmark jumps, as menu ids. Same reasoning as above. */
const BOOKMARK_GOTO_IDS = Object.freeze([
  'search.gotoBookmark1', 'search.gotoBookmark2', 'search.gotoBookmark3',
  'search.gotoBookmark4', 'search.gotoBookmark5', 'search.gotoBookmark6',
  'search.gotoBookmark7', 'search.gotoBookmark8', 'search.gotoBookmark9',
])

const TEXT_EDIT_COMMAND_IDS = Object.freeze([
  'text.copyLineRight', 'text.copyLineLeft', 'text.copyLineOther', 'text.copyOtherSide',
  'text.insertLineBefore', 'text.insertLineAfter',
  'text.deleteLine', 'text.deleteToStartOfLine', 'text.deleteToEndOfLine', 'text.deleteWord',
  'text.increaseIndent', 'text.decreaseIndent',
  'text.selectSection', 'text.selectAll',
  'text.alignWith', 'text.clearAlignAnchors', 'text.isolate',
  'text.nextInlineDiff', 'text.prevInlineDiff', 'text.nextEdit', 'text.prevEdit',
])

/**
 * Menu handlers for every text edit command, keyed by the view's own ids.
 *
 * Generated rather than listed: a hand-written copy is a third place the set
 * of commands has to be kept in step, and the one most likely to be forgotten.
 *
 * @returns {Record<string, () => void>}
 */
function _textEditCommandHandlers() {
  /** @type {Record<string, () => void>} */
  const out = {}
  for (const id of TEXT_EDIT_COMMAND_IDS) {
    out[id] = () => {
      if (currentView !== 'text' || !textCompare) {
        showStatus('此項目僅適用於文字比對')
        return
      }
      const cmd = textCompare.editCommands().find((c) => c.id === id)
      if (!cmd) { showStatus(`找不到指令：${id}`); return }
      cmd.run()
    }
  }
  return out
}

async function printActiveReport() {
  const src = _activeReportSource()
  if (!src.htmlFallback) { showStatus('目前視圖不支援列印報告'); return }
  try {
    await src.view.exportHtml({ print: true })
  } catch (err) {
    showError(`列印報告失敗：${err?.message ?? err}`, err)
  }
}

// ---------------------------------------------------------------------------
// Print pagination — how a report breaks across printed pages
// ---------------------------------------------------------------------------

/** Marks the injected block so a second pass cannot add it twice. */
export const PRINT_PAGINATION_STYLE_ID = 'mc-print-pagination'

/**
 * Page-break rules applied to every report on its way to the printer.
 *
 * Each view builds its own report and its own `@media print` block, so before
 * this a line could be cut in half by a page break in one view and not in
 * another. The rules live here, applied to the finished document, so the
 * behaviour is one decision rather than six.
 *
 * `display: table-header-group` is what makes a `<thead>` repeat on every
 * page; the promotion pass below exists because most of the reports write
 * their header row straight into the table with no `<thead>` around it, and
 * the rule has nothing to act on until they do.
 */
export const PRINT_PAGINATION_CSS = `
@page { margin: 14mm 12mm; }
@media print {
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  tr, img, figure, pre, blockquote, li, .row, .diff-row, .fc-row {
    break-inside: avoid; page-break-inside: avoid;
  }
  h1, h2, h3, h4 {
    break-inside: avoid; page-break-inside: avoid;
    break-after: avoid; page-break-after: avoid;
  }
  p { orphans: 3; widows: 3; }
  table { break-inside: auto; }
}
`.trim()

/**
 * Move a table's leading all-`<th>` row into a `<thead>`.
 *
 * @param {Document} doc
 * @returns {number} how many tables were changed
 */
function _promoteTableHeaders(doc) {
  let changed = 0
  for (const table of doc.querySelectorAll('table')) {
    if (table.tHead) continue
    const first = table.querySelector('tr')
    if (!first) continue
    const cells = [...first.children]
    if (cells.length === 0) continue
    if (!cells.every((c) => c.tagName === 'TH')) continue
    const thead = doc.createElement('thead')
    thead.appendChild(first)
    table.insertBefore(thead, table.firstChild)
    changed += 1
  }
  return changed
}

/**
 * Add the shared pagination rules to a finished report document.
 *
 * Returns the input unchanged if it cannot be parsed rather than throwing:
 * printing an un-paginated report is a worse result than an error only in the
 * sense that it still prints, which is what the user asked for.
 *
 * Page *numbers* are deliberately absent. Chromium implements neither `@page`
 * margin boxes nor `counter(page)` outside them, and the frame that renders
 * the preview runs no scripts, so anything this printed as a page number would
 * be a guess at where the breaks landed. The number the user gets comes from
 * the print dialog's own header/footer option, which is stated in the preview.
 *
 * @param {string} html
 * @returns {string}
 */
export function withPrintPagination(html) {
  const source = String(html ?? '')
  if (!source.trim()) return source
  let doc
  try {
    doc = new DOMParser().parseFromString(source, 'text/html')
  } catch (err) {
    console.error('[print] pagination rules not applied:', err)
    return source
  }
  const head = doc.head
  if (!head || !doc.documentElement) return source
  if (doc.getElementById(PRINT_PAGINATION_STYLE_ID)) return source

  _promoteTableHeaders(doc)

  const style = doc.createElement('style')
  style.id = PRINT_PAGINATION_STYLE_ID
  style.textContent = PRINT_PAGINATION_CSS
  head.appendChild(style)

  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}

// ---------------------------------------------------------------------------
// P2-28: print preview
// ---------------------------------------------------------------------------

/**
 * Blob URL backing the preview frame. Held so it can be revoked; leaving one
 * per preview alive pins the whole report in memory for the session.
 * @type {string}
 */
let _printPreviewUrl = ''

function _revokePrintPreviewUrl() {
  if (!_printPreviewUrl) return
  URL.revokeObjectURL(_printPreviewUrl)
  _printPreviewUrl = ''
}

/**
 * @param {string} msg
 * @param {boolean} [isError]
 */
function _setPrintPreviewStatus(msg, isError = false) {
  const node = el('print-preview-status')
  if (node) node.textContent = msg
  if (isError && msg) showError(msg)
}

/**
 * Show the report that would be printed, before opening the print dialog.
 *
 * Every view's print command routes through here, so what the user sees is
 * the same document that reaches the printer rather than a second rendering.
 */
function openPrintPreview() {
  const overlay = el('print-preview-modal')
  const frame = el('print-preview-frame')
  const src = _activeReportSource()

  if (!(src.html || src.htmlFallback)) {
    showStatus('目前視圖不支援列印報告')
    return
  }
  if (!overlay || !(frame instanceof HTMLIFrameElement)) {
    void printActiveReport()
    return
  }
  if (!src.html) {
    // The view can print but cannot hand over the HTML, so there is nothing to
    // preview. Say so rather than showing an empty frame.
    showStatus('目前視圖無法產生預覽，直接開啟列印')
    void printActiveReport()
    return
  }

  let html
  try {
    html = withPrintPagination(src.view.buildHtmlReport())
  } catch (err) {
    showError(`建立列印預覽失敗：${err instanceof Error ? err.message : String(err)}`, err)
    return
  }

  _revokePrintPreviewUrl()
  _printPreviewUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  frame.src = _printPreviewUrl

  const label = el('print-preview-view')
  if (label) label.textContent = `目前視圖：${VIEW_TYPE_LABELS[currentView] ?? currentView}`
  _setPrintPreviewStatus('')
  overlay.style.display = 'flex'
}

function closePrintPreview() {
  const overlay = el('print-preview-modal')
  if (overlay) overlay.style.display = 'none'
  const frame = el('print-preview-frame')
  if (frame instanceof HTMLIFrameElement) frame.removeAttribute('src')
  _revokePrintPreviewUrl()
}

/**
 * Is this the hex or table view's own 🖨 button?
 *
 * Matched structurally because those two views are owned elsewhere: the table
 * button carries an id, the hex one is identified by its class plus the printer
 * glyph it renders. See the report accompanying this change — the intended
 * end state is for both views to emit an event instead.
 *
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
function _isViewPrintButton(target) {
  if (!(target instanceof Element)) return false
  const btn = target.closest('button')
  if (!btn) return false
  if (btn.id === 'tc-btn-print') return true
  return btn.classList.contains('hx-btn-report') && btn.textContent.trim().startsWith('🖨')
}

/**
 * Route the hex and table views' print buttons through the shared preview.
 *
 * Both call `exportHtml({ print: true })` directly, which opens a second window
 * and goes straight to the print dialog — so the same command produced two
 * different experiences depending on which view was open. The listener runs in
 * the capture phase on the view container, which stops the event before the
 * button's own handler sees it.
 */
function setupViewPrintInterception() {
  for (const id of ['view-hex', 'view-table']) {
    el(id)?.addEventListener('click', (e) => {
      if (!_isViewPrintButton(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      openPrintPreview()
    }, true)
  }
}

function setupPrintPreview() {
  el('btn-print-preview-close')?.addEventListener('click', closePrintPreview)
  el('btn-print-preview-cancel')?.addEventListener('click', closePrintPreview)

  el('btn-print-preview-print')?.addEventListener('click', () => {
    const frame = el('print-preview-frame')
    if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) {
      _setPrintPreviewStatus('預覽尚未載入完成，無法列印', true)
      return
    }
    try {
      frame.contentWindow.focus()
      frame.contentWindow.print()
    } catch (err) {
      _setPrintPreviewStatus(
        `列印失敗：${err instanceof Error ? err.message : String(err)}`, true)
    }
  })

  // Printing from the frame cannot number pages — Chromium ignores `@page`
  // margin boxes, so the CSS counters the pagination rules set up have nowhere
  // to render. Main's printToPDF takes a footer template, which is the only
  // route to "3 / 12" on the page.
  el('btn-print-preview-pdf')?.addEventListener('click', () => {
    void (async () => {
      const src = _activeReportSource()
      if (!src.html) { _setPrintPreviewStatus('目前視圖無法產生報告', true); return }
      _setPrintPreviewStatus('正在輸出 PDF…')
      try {
        const html = withPrintPagination(src.view.buildHtmlReport())
        const name = `mycompare-${currentView}.pdf`
        const res = await window.electronAPI.printToPdf(html, name)
        _setPrintPreviewStatus(res?.saved ? `已儲存：${res.path}` : '已取消')
      } catch (err) {
        _setPrintPreviewStatus(
          `輸出 PDF 失敗：${err instanceof Error ? err.message : String(err)}`, true)
      }
    })()
  })

  // Kept as an escape hatch: if the frame cannot render the report, the user
  // still has the path that worked before the preview existed.
  el('btn-print-preview-window')?.addEventListener('click', () => {
    closePrintPreview()
    void printActiveReport()
  })
}

async function runReportAction(action) {
  const src = _activeReportSource()
  if (!_hasAnyReport(src)) { _setReportStatus('目前視圖不支援報告', true); return }

  try {
    switch (action) {
      case 'save-html':
        if (src.html) {
          await window.electronAPI.saveFile(
            'compare-report.html',
            withPrintPagination(src.view.buildHtmlReport()),
            [{ name: 'HTML', extensions: ['html'] }, { name: '所有檔案', extensions: ['*'] }])
        } else {
          await src.view.exportHtml()
        }
        _setReportStatus('HTML 報告已處理')
        return
      case 'save-text':
        if (src.text) {
          await window.electronAPI.saveFile(
            'compare-report.txt',
            src.view.buildTextReport(),
            [{ name: '純文字', extensions: ['txt'] }, { name: '所有檔案', extensions: ['*'] }])
        } else {
          await src.view.exportTextReport()
        }
        _setReportStatus('純文字報告已處理')
        return
      case 'copy-html':
        await copyTextToClipboard(withPrintPagination(src.view.buildHtmlReport()))
        _setReportStatus('HTML 報告已複製到剪貼簿')
        return
      case 'copy-text':
        await copyTextToClipboard(src.view.buildTextReport())
        _setReportStatus('純文字報告已複製到剪貼簿')
        return
    }
  } catch (err) {
    // The dialog stays open: the user asked for a report and needs to know it
    // did not happen, and why.
    _setReportStatus(`報告失敗：${err instanceof Error ? err.message : String(err)}`, true)
  }
}

/**
 * Put text on the system clipboard.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
async function copyTextToClipboard(text) {
  const write = navigator.clipboard?.writeText
  if (typeof write !== 'function') {
    throw new Error('此環境不提供剪貼簿寫入')
  }
  await navigator.clipboard.writeText(String(text ?? ''))
}

// ---------------------------------------------------------------------------
// T61: Named Config Store + modal handlers
// ---------------------------------------------------------------------------

const namedConfigStore = new NamedConfigStore()
const workspaceStore = new WorkspaceStore()

/**
 * Return the active view object that supports getConfig/applyConfig.
 * @returns {{ view: object | null, type: string | null }}
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
    // merge3 implements the same contract but was left out of this table, so
    // its settings could be neither saved nor loaded.
    merge3: mergeCompare,
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

/**
 * Names in this namespace belong to the app, not to the user.
 *
 * The folder view keeps its defaults under `__mycompare:folder-defaults__` in
 * the same store, so the shared dialog listed an entry the user never created
 * and could delete by mistake.
 */
const RESERVED_CONFIG_PREFIX = '__mycompare:'

/**
 * @param {string} name
 * @returns {boolean}
 */
function isReservedConfigName(name) {
  return String(name ?? '').startsWith(RESERVED_CONFIG_PREFIX)
}

function refreshConfigList() {
  const list = el('config-list')
  if (!list) return
  const { type } = _getActiveConfigurableView()
  const items = namedConfigStore.list(type ?? undefined)
    .filter((entry) => !isReservedConfigName(entry.name))
  list.replaceChildren()
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'config-list-empty'
    empty.textContent = type === null
      ? '（目前視圖不支援設定管理）'
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
  // Saving over a reserved name would overwrite the folder view's defaults with
  // whatever this view happens to expose, and the entry would then be invisible
  // in this list.
  if (isReservedConfigName(name)) {
    _setConfigStatus(`「${RESERVED_CONFIG_PREFIX}」開頭的名稱保留給應用程式使用，請換一個名稱`)
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
  // Loading a workspace closes everything that is open, so it is as destructive
  // as closing each tab by hand and asks the same question.
  if (!_confirmDiscardAllTabs()) {
    showStatus('已取消載入工作區')
    return
  }
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
// View picker — "which kind of comparison?"
// ---------------------------------------------------------------------------

/** Human name per session type. */
const VIEW_TYPE_LABELS = Object.freeze({
  text: '文字比對', folder: '資料夾比對', table: '表格比對',
  image: '圖片比對', hex: 'Hex 比對', merge3: '三向合併',
})

/**
 * Resolver for the dialog currently open, or null when it is closed.
 * @type {((value: string|null) => void) | null}
 */
let _viewPickerResolve = null

/**
 * @param {string|null} value the chosen type, or null when dismissed
 */
function _closeViewPicker(value) {
  const overlay = el('view-picker-modal')
  if (overlay) overlay.style.display = 'none'
  const resolve = _viewPickerResolve
  _viewPickerResolve = null
  // Settled before anything else runs: a caller awaiting this must never be
  // left hanging because a later dialog replaced the resolver.
  resolve?.(value)
}

function setupViewPicker() {
  el('btn-view-picker-close')?.addEventListener('click', () => _closeViewPicker(null))
  el('btn-view-picker-cancel')?.addEventListener('click', () => _closeViewPicker(null))
}

/**
 * Ask the user which comparison view to use.
 *
 * @param {string} description shown above the buttons
 * @param {string[]} choices session types, in the order they should be offered
 * @returns {Promise<string|null>} the chosen type, or null when cancelled
 */
function pickViewType(description, choices) {
  const overlay = el('view-picker-modal')
  const list = el('view-picker-list')
  if (!overlay || !list || choices.length === 0) return Promise.resolve(null)

  // A second call supersedes the first rather than stacking dialogs.
  _closeViewPicker(null)

  const desc = el('view-picker-desc')
  if (desc) desc.textContent = description

  list.replaceChildren()
  for (const type of choices) {
    const btn = document.createElement('button')
    btn.dataset.viewType = type
    btn.textContent = VIEW_TYPE_LABELS[type] ?? type
    btn.addEventListener('click', () => _closeViewPicker(type))
    list.appendChild(btn)
  }

  overlay.style.display = 'flex'
  return new Promise((resolve) => { _viewPickerResolve = resolve })
}

// ---------------------------------------------------------------------------
// BC Session menu — Save As / Clear / Locked / Parent Folders / Compare Using
// ---------------------------------------------------------------------------

/**
 * The active tab's two sides, or null with a message when there is nothing to
 * act on.
 *
 * @param {string} action named in the message, so the user knows what was
 *   refused rather than only that something was
 * @returns {{ tab: TabRecord, leftPath: string, rightPath: string } | null}
 */
function _activeTabPaths(action) {
  const tab = tabMgr.activeTab
  if (!tab) {
    showStatus(`${action}：目前沒有開啟的比對`)
    return null
  }
  const { leftPath, rightPath } = tab
  if (!leftPath && !rightPath) {
    showStatus(`${action}：目前的比對還沒有開啟任何檔案`)
    return null
  }
  // Archive entries, snapshots and remote files exist only inside this window's
  // session; neither a parent folder nor a re-open by path is meaningful.
  const virtual = [leftPath, rightPath].find((p) => p && sourceKindOf(p) !== 'fs')
  if (virtual) {
    showError(`${action}：「${virtual}」不是本機檔案，無法用於此操作`)
    return null
  }
  return { tab, leftPath, rightPath }
}

/**
 * Whether the active tab refuses commands that would reload or recompare it.
 *
 * @param {string} action named in the message
 * @returns {boolean} true when the command must not run
 */
function isActiveTabLocked(action) {
  const tab = tabMgr.activeTab
  if (!tab?.locked) return false
  showStatus(`${action}：此比對已鎖定（Session ▸ 鎖定 可解除）`)
  return true
}

/** Toggle the lock on the active tab. */
function toggleSessionLock() {
  const tab = tabMgr.activeTab
  if (!tab) {
    showStatus('鎖定：目前沒有開啟的比對')
    return
  }
  const locked = tabMgr.setActiveLocked(!tab.locked)
  showStatus(locked
    ? `已鎖定「${tab.title}」，重新整理與重新比對將被忽略`
    : `已解除鎖定「${tab.title}」`)
}

/**
 * Save the active comparison under a name the user chooses.
 *
 * Distinct from the automatic recording behind every path change: that keeps
 * one rolling entry per tab named after the files, this creates a separate,
 * durable entry the user named themselves.
 */
function saveSessionAs() {
  const found = _activeTabPaths('另存 Session')
  if (!found) return
  const { tab, leftPath, rightPath } = found

  const suggested = tab.title || _titleFromPaths(leftPath, rightPath)
  const name = window.prompt('Session 名稱：', suggested)
  if (name === null) return
  const trimmed = name.trim()
  if (!trimmed) {
    showStatus('另存 Session：名稱不可為空')
    return
  }

  try {
    const created = store.save(createSession(tab.type, trimmed, {
      leftPath, rightPath, basePath: tab.basePath ?? '',
    }))
    // The tab now belongs to the named entry, so later path changes update it
    // instead of leaving the user's named session frozen.
    tab.sessionId = created.id
    tabMgr.updateActiveTitle(trimmed)
    renderRecentSessions(openSession, removeSession)
    showStatus(`已儲存 Session「${trimmed}」`)
  } catch (err) {
    showError(`另存 Session 失敗：${err instanceof Error ? err.message : String(err)}`, err)
  }
}

/**
 * Empty the active comparison, keeping its kind.
 *
 * Implemented by replacing the tab rather than reaching into each view: every
 * view already knows how to start empty, and a per-view reset would be six
 * more code paths that can rot independently.
 */
function clearSession() {
  const tab = tabMgr.activeTab
  if (!tab) {
    showStatus('清空 Session：目前沒有開啟的比對')
    return
  }
  if (isActiveTabLocked('清空 Session')) return
  if (!_confirmDiscardForTab(tab).ok) return

  const { type } = tab
  tabMgr.closeTab(tab.id)
  _disposeViewIfUnused(type)
  newSession(type)
  showStatus(`已清空${_defaultTitleForType(type)}`)
}

/** Open a folder comparison of the directories holding the two current files. */
async function compareParentFolders() {
  const found = _activeTabPaths('比對上層資料夾')
  if (!found) return
  const { leftPath, rightPath } = found

  const left = parentFolderOf(leftPath)
  const right = parentFolderOf(rightPath)
  if (!left && !right) {
    showError('比對上層資料夾：目前的路徑沒有上層資料夾')
    return
  }
  await openComparison({ type: 'folder', leftPath: left, rightPath: right })
}

/**
 * Open a folder comparison for a three-way merge's parent folders.
 *
 * Left against right is the pair the merge is actually reconciling, so it is
 * the default; when one of those is missing, base stands in for it rather than
 * refusing outright. Which pair was used is said out loud — silently comparing
 * a different pair than the user expected is worse than not comparing at all.
 *
 * @param {{ left: string, base: string, right: string }} parents
 */
async function openMergeParentFolders({ left, base, right }) {
  /** @type {[string, string, string]|null} */
  let pair = null
  if (left && right) pair = [left, right, '左側與右側']
  else if (left && base) pair = [base, left, '基準與左側']
  else if (base && right) pair = [base, right, '基準與右側']

  if (!pair) {
    showError('比對上層資料夾：三向合併至少要有兩個已載入的來源檔案')
    return
  }

  const [leftPath, rightPath, label] = pair
  await openComparison({ type: 'folder', leftPath, rightPath })
  showStatus(`已開啟上層資料夾比對（${label}）`)
}

/**
 * Show a merge's output against one of its sources in a text-compare tab.
 *
 * The output side is deliberately given no path: it is not a file on disk yet,
 * and handing the text view a made-up path would make "儲存右側" overwrite
 * something that was never opened.
 *
 * @param {'left'|'base'|'right'} side
 * @param {string} sourcePath
 * @param {string} sourceText
 * @param {string} outputText
 */
async function openMergeOutputCompare(side, sourcePath, sourceText, outputText) {
  const sideLabel = { left: '左側', base: '基準', right: '右側' }[side] ?? side

  await openComparison({
    type: 'text',
    leftPath: sourcePath,
    leftContent: sourceText,
    rightPath: '',
    rightContent: outputText,
  })
  tabMgr.updateActiveTitle(`${sideLabel} ↔ 合併輸出`)
  showStatus(`已開啟「${sideLabel} ↔ 合併輸出」；右側尚未存檔，請用「另存」寫入檔案`)
}

/** Re-open the two current files in a comparison view the user picks. */
async function compareFilesUsing() {
  const found = _activeTabPaths('以其他方式比對')
  if (!found) return
  const { tab, leftPath, rightPath } = found

  const choices = ['text', 'table', 'hex', 'image'].filter((t) => t !== tab.type)
  const chosen = await pickViewType(
    `以哪一種比對重新開啟這兩個檔案？（目前為${VIEW_TYPE_LABELS[tab.type] ?? tab.type}）`,
    choices)
  if (!chosen) return

  await openComparison({ type: chosen, leftPath, rightPath })
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
  // merge3 doesn't use the toolbar diff controls

  // 取得 diff 資訊（僅 text 模式）
  const diffInfo = isText && textCompare ? textCompare.getDiffInfo() : { total: 0, currentIndex: -1 }
  const hasDiff = diffInfo.total > 0
  const hasContent = isText && textCompare != null

  // Navigation buttons dim per direction, not as a group: sitting on the last
  // difference with three live-looking arrows and one that does nothing is BC
  // behaviour this was missing. Views without the finer answer fall back to
  // "any difference at all", which is what every one of them did before.
  const nav = (isText && typeof textCompare?.getNavAvailability === 'function')
    ? textCompare.getNavAvailability()
    : { first: hasDiff, prev: hasDiff, next: hasDiff, last: hasDiff }
  setDisabled('btn-first-diff', !nav.first)
  setDisabled('btn-prev-diff', !nav.prev)
  setDisabled('btn-next-diff', !nav.next)
  setDisabled('btn-last-diff', !nav.last)

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
  // The export button now opens the report dialog, which every view with a
  // report builder can use — not just text and folder.
  setDisabled('btn-export', isHome || !_hasAnyReport(_activeReportSource()))
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
      if (isActiveTabLocked('重新整理')) return
      if (currentView === 'text') textCompare?.refresh()
      else if (currentView === 'folder') void folderCompare?.refresh()
    },
    newSession: () => showHome(),
    closeTab: () => {
      const active = tabMgr.activeTab
      if (active) _handleCloseTab(active.id)
    },
    fullscreen: () => { void window.electronAPI?.toggleFullScreen?.() },
    // P2-28: one preview for every view, instead of two hardcoded branches
    // that silently did nothing anywhere else.
    print: () => openPrintPreview(),
    reloadFromDisk: () => reloadActiveFromDisk(),
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
 * Re-read the active view's files from disk.
 *
 * The menu advertised Ctrl+Shift+R next to the hex reload command, but nothing
 * in the renderer bound it — and since menu accelerators are display-only here
 * (the renderer owns every keystroke), the key did nothing at all. Binding it
 * once and routing by view is what makes the label true, and it means the
 * table view's new reload gets the same key without a second binding to keep
 * in sync.
 */
function reloadActiveFromDisk() {
  const view = _activeViewInstance()
  if (typeof view?.reloadAll !== 'function') {
    showStatus('目前視圖不支援從磁碟重新載入')
    return
  }
  void Promise.resolve(view.reloadAll()).catch((err) => {
    showError(`從磁碟重新載入失敗：${err instanceof Error ? err.message : String(err)}`, err)
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
  let viewType = type && type !== 'auto' ? type : getViewTypeForPath(leftPath || rightPath)

  if (!type || type === 'auto') {
    // Some extensions have more than one honest reading — .html is both a text
    // file and a table container — so the choice is the user's, not a guess
    // made on their behalf and silently.
    const choices = getViewChoicesForPath(leftPath || rightPath)
    if (choices.length > 1) {
      const chosen = await pickViewType(
        `「${(leftPath || rightPath).split(/[\\/]/).pop()}」可以用多種方式比對，要用哪一種？`,
        choices)
      if (!chosen) return
      viewType = chosen
    }
  }

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

/** Remote kinds the profile editor can create, in the order it offers them. */
const REMOTE_KINDS = Object.freeze(['ftp', 'ftps', 'sftp', 's3', 'dropbox', 'onedrive'])

/** Kinds whose credential is an OAuth token obtained through the browser. */
const REMOTE_OAUTH_KINDS = Object.freeze(['dropbox', 'onedrive'])

/**
 * Collect a new profile from the user.
 *
 * Every kind the main process can actually connect to is offered here. The
 * list had been left at ftp/ftps/s3 while sftp, dropbox and onedrive were
 * added behind it, so three working transports had no way to be created — the
 * feature existed and no user could reach it.
 */
async function createRemoteProfile() {
  const kind = prompt(`連線類型（${REMOTE_KINDS.join(' / ')}）：`, 'ftp')?.trim().toLowerCase()
  if (!kind) return
  if (!REMOTE_KINDS.includes(kind)) {
    showError(`不支援的連線類型：${kind}`)
    return
  }
  const name = prompt('這個連線的名稱：')?.trim()
  if (!name) return

  /** @type {Record<string, unknown>} */
  const profile = { name, kind, saveSecret: false }

  if (REMOTE_OAUTH_KINDS.includes(kind)) {
    // The client ID is the user's own registered application. It is not a
    // secret — it is visible in the browser's address bar during sign-in — so
    // it is an ordinary field, and the save error carries the registration
    // instructions when it is missing or wrong.
    profile.clientId = prompt(
      [
        `${kind} 需要你自己申請的應用程式 client ID。`,
        '留空送出可看到申請步驟。',
        '',
        'client ID：',
      ].join('\n'))?.trim() ?? ''
    profile.path = prompt('起始路徑（可留空）：')?.trim() ?? ''
    // The refresh token is obtained on first connect and stored the same way a
    // password would be, so the same "only if the OS can encrypt it" rule
    // applies rather than a second, weaker path.
    profile.saveSecret = confirm(
      '要記住授權嗎？（只會以作業系統加密後儲存；無法加密時每次都要重新授權）')
  } else if (kind === 's3') {
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
  if (!REMOTE_OAUTH_KINDS.includes(kind)) {
    profile.saveSecret = confirm('要記住密碼嗎？（只會以作業系統加密後儲存；無法加密時不會儲存）')
    if (profile.saveSecret) {
      profile.secret = prompt(kind === 's3' ? 'Secret Access Key：' : '密碼：') ?? ''
    }
  }

  try {
    const saved = await window.electronAPI.remoteSaveProfile(profile)
    const note = REMOTE_OAUTH_KINDS.includes(kind)
      ? '；第一次連線會開啟瀏覽器完成授權'
      : ''
    showStatus(`已儲存連線「${saved.profile?.name ?? saved.name ?? name}」${note}`)
  } catch (err) {
    // Shown verbatim: for the OAuth kinds this message is where the client-ID
    // registration steps live, so trimming it would remove the only
    // instructions the user gets.
    showError(`儲存失敗：${err.message}`, err)
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
  /** @type {import('./core/diff-nav.js').NavResult | null} */
  let result = null

  if (currentView === 'text') {
    result = textCompare?.[`navigate${cap}`]?.() ?? null
  } else if (currentView === 'merge3') {
    // merge3 reports the landed index rather than a NavResult, so the before /
    // after pair is what tells "stepped" from "stopped at the end".
    const before = mergeCompare?.getCurrentConflictIndex?.() ?? -1
    const landed = mergeCompare?.[`${where}Conflict`]?.() ?? -1
    const total = mergeCompare?.getConflictCount?.() ?? 0
    result = landed < 0
      ? { index: -1, total, moved: false }
      : { index: landed, total, moved: landed !== before }
  } else {
    const view = {
      hex: hexCompare,
      table: tableCompare,
      image: imageCompare,
      folder: folderCompare,
    }[currentView]
    result = view?.[`${where}Difference`]?.() ?? null
  }

  const message = describeNavResult(where, result)
  if (message) showStatus(message)
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
/**
 * The renderer's menu dispatch table, filled in by {@link setupMenuActions}.
 * @type {Record<string, () => void>}
 */
let _menuCommands = {}

function setupMenuActions() {
  /** @param {number} delta */
  const zoom = (delta) => {
    if (currentView === 'text' && textCompare) {
      textCompare.setFontSize(textCompare._fontSize + delta)
    } else if (currentView === 'image') {
      if (delta > 0) imageCompare?.zoomIn?.()
      else imageCompare?.zoomOut?.()
    }
  }

  /**
   * Run `fn` against the text view, or say why nothing happened.
   * @param {(view: TextCompare) => void} fn
   * @param {string} [okMessage] status to show when the action itself says nothing
   */
  const _textPanel = (fn, okMessage) => {
    if (currentView !== 'text' || !textCompare) { showStatus('此項目僅適用於文字比對'); return }
    fn(textCompare)
    if (okMessage) showStatus(okMessage)
  }

  /** @param {number} index into FONT_CHOICES */
  const _textFont = (index) => {
    const choice = FONT_CHOICES[index]
    if (!choice) return
    _textPanel((v) => v.setFontFamily(choice.value), `字型：${choice.label}`)
  }

  /** @param {(view: HexCompare) => void} fn */
  const _hexPanel = (fn) => {
    if (currentView !== 'hex' || !hexCompare) { showStatus('此項目僅適用於 Hex 比對'); return }
    fn(hexCompare)
  }

  /** @param {(view: ThreeWayCompare) => void} fn */
  const _mergePanel = (fn) => {
    if (currentView !== 'merge3' || !mergeCompare) {
      showStatus('此項目僅適用於三向合併')
      return
    }
    fn(mergeCompare)
  }

  /** @param {(view: FolderCompare) => void} fn */
  const _folderPanel = (fn) => {
    if (currentView !== 'folder' || !folderCompare) {
      showStatus('此項目僅適用於資料夾比對')
      return
    }
    fn(folderCompare)
  }

  /** @param {(view: TableCompare) => void} fn */
  const _tablePanel = (fn) => {
    if (currentView !== 'table' || !tableCompare) { showStatus('此項目僅適用於表格比對'); return }
    fn(tableCompare)
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
      const view = {
        text: textCompare, folder: folderCompare, hex: hexCompare,
        table: tableCompare, image: imageCompare,
      }[currentView]
      void view?.swap?.()
    },
    'session.recompare':  () => {
      if (isActiveTabLocked('重新比對')) return
      if (currentView === 'text') textCompare?.refresh()
      else if (currentView === 'folder') folderCompare?.refresh()
    },
    'session.saveAs':               () => saveSessionAs(),
    'session.clear':                () => clearSession(),
    'session.locked':               () => toggleSessionLock(),
    'session.compareParentFolders': () => void compareParentFolders(),
    'session.compareUsing':         () => void compareFilesUsing(),
    // Folder navigation. Each says why it did nothing rather than leaving a
    // menu item that appears to do nothing at all.
    'session.folder.up': () => void _folderNav('upOneLevel', '上一層'),
    'session.folder.back': () => void _folderNav('goBack', '上一頁'),
    'session.folder.forward': () => void _folderNav('goForward', '下一頁'),

    'file.openArchiveLeft': () => void _folderNav('openArchiveLeft', '開啟封存檔'),
    'file.openArchiveRight': () => void _folderNav('openArchiveRight', '開啟封存檔'),

    'session.folder.info': () => void _folderNav('openInfoDialog', '資料夾比對資訊'),
    'file.copyTo': () => void _folderNav('copySelectedToFolder', '複製到指定資料夾'),
    'file.touch.leftToRight': () => void _folderTouch('left-to-right'),
    'file.touch.rightToLeft': () => void _folderTouch('right-to-left'),

    'session.merge.parentFolders': () => {
      if (currentView !== 'merge3' || !mergeCompare) {
        showStatus('合併上層資料夾僅適用於三向合併')
        return
      }
      // The view refuses when fewer than two sources are loaded, and its own
      // error path has already said so; only the silent case needs a word here.
      if (!mergeCompare.mergeParentFolders()) {
        showStatus('合併上層資料夾：需要至少兩個已載入的來源檔案')
      }
    },
    'session.merge.compareOutput.left':  () => _mergeCompareOutput('left'),
    'session.merge.compareOutput.base':  () => _mergeCompareOutput('base'),
    'session.merge.compareOutput.right': () => _mergeCompareOutput('right'),

    'view.image.info': () => {
      if (currentView !== 'image' || !imageCompare) {
        showStatus('圖片資訊僅適用於圖片比對')
        return
      }
      showStatus(imageCompare.toggleInfoPanel() ? '已顯示圖片資訊' : '已隱藏圖片資訊')
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
    'file.exportHtml': () => void runReportAction('save-html'),
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

    'file.exportText': () => void runReportAction('save-text'),
    'file.exportPatch': () => {
      if (currentView === 'text') void textCompare?.exportUnifiedDiff()
      else showStatus('Unified Diff 僅適用於文字比對')
    },
    'file.print': () => openPrintPreview(),
    // Wired ahead of the menu entries so main/menu.js can add Tools ▸ Options…
    // and the two settings-transfer items without a second round trip.
    'file.printPreview': () => openPrintPreview(),
    'tools.options': () => el('btn-settings-modal')?.click(),
    'tools.customizeCommands': () => _openOptionsPane('commands'),
    'tools.settings.export': () => el('btn-settings-export')?.click(),
    'tools.settings.import': () => el('btn-settings-import')?.click(),
    'view.toggleToolbar': () => _toggleChromePref('showToolbar', '工具列'),
    'view.toggleStatusBar': () => _toggleChromePref('showStatusBar', '狀態列'),

    'edit.undo': () => { if (currentView === 'text') textCompare?.undo() },
    'edit.redo': () => { if (currentView === 'text') textCompare?.redo() },
    'edit.toggleEditMode': () => {
      if (currentView !== 'text' || !textCompare) return
      const isEdit = textCompare.toggleEditMode()
      el('btn-edit-mode').classList.toggle('active', isEdit)
      el('btn-edit-mode').title = isEdit ? '退出編輯模式 (Ctrl+E)' : '切換編輯模式 (Ctrl+E)'
    },
    // The text view owns one table of edit commands; its keyboard handler and
    // context menu are both generated from it, so the menu dispatches by the
    // same id instead of keeping a third copy that can drift.
    ..._textEditCommandHandlers(),

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
    'edit.folder.selectAllFiles': () => void _folderNav('selectAllFiles', '選取全部檔案'),
    'edit.folder.selectOrphansBoth': () => void _folderNav('selectOrphansBoth', '選取兩側孤兒'),
    'session.folder.moveToFolder': () => void _folderNav('moveSelectedToFolder', '移動到其他資料夾'),
    'session.folder.archiveOptions': () => void _folderNav('openArchiveOptionsDialog', '封存檔比對設定'),
    'folder.quickCompare': () => void _folderNav('quickCompareSelected', '快速比對'),
    'folder.quickCompareAll': () => void _folderNav('quickCompareAll', '快速比對全部'),
    'folder.compareToLeft': () => {
      if (currentView !== 'folder' || !folderCompare) { showStatus('比對至…僅適用於資料夾比對'); return }
      void folderCompare.compareTo('left')
    },
    'folder.compareToRight': () => {
      if (currentView !== 'folder' || !folderCompare) { showStatus('比對至…僅適用於資料夾比對'); return }
      void folderCompare.compareTo('right')
    },

    'view.folder.filesOnly': () => void _folderNav('toggleFilesOnly', '只比對檔案'),
    'view.folder.flatten': () => void _folderNav('toggleFlatMode', '攤平比對'),
    'view.folder.ignoreUnimportant': () => void _folderNav('toggleIgnoreUnimportant', '忽略不重要差異'),

    'view.toggleIgnoreUnimportant': () => {
      // Folder compare has its own id: routing both through this one would
      // make the text-only guard below silently swallow the folder case.
      if (currentView !== 'text' || !textCompare) return
      const on = textCompare.setIgnoreUnimportant()
      const chk = el('chk-ignore-unimportant')
      if (chk) chk.checked = on
      showStatus(on ? '已忽略不重要差異' : '已顯示不重要差異')
    },
    'view.toggleLineNumbers': () => { if (currentView === 'text') textCompare?.toggleLineNumbers() },
    'view.toggleWhitespace':  () => { if (currentView === 'text') textCompare?.toggleWhitespace() },
    'view.toggleWordWrap':    () => { if (currentView === 'text') textCompare?.toggleWordWrap() },
    'view.toggleLayout': () => {
      // Every view that has the two layouts implements the same method name,
      // so the menu item works wherever it applies instead of only in text.
      const view = { text: textCompare, table: tableCompare, image: imageCompare }[currentView]
      if (view) view.toggleLayout()
      else showStatus('目前視圖沒有並排／上下佈局')
    },
    'view.zoomIn':    () => zoom(1),
    'view.zoomOut':   () => zoom(-1),
    'view.zoomReset': () => {
      if (currentView === 'text') textCompare?.setFontSize(13)
      else if (currentView === 'image') imageCompare?.resetZoom?.()
    },
    'view.toggleTheme': () => el('btn-theme').click(),
    'view.fullScreen':  () => { void window.electronAPI?.toggleFullScreen?.() },

    // View ▸ panels. These all existed as view methods reachable only from a
    // pane context menu; BC puts them on the View menu, which is also the only
    // way to reach them without a mouse.
    'view.text.details.text':      () => _textPanel((v) => v.setDetailsMode('text'), '詳細資料：文字'),
    'view.text.details.hex':       () => _textPanel((v) => v.setDetailsMode('hex'), '詳細資料：Hex'),
    'view.text.details.alignment': () => _textPanel((v) => v.setDetailsMode('alignment'), '詳細資料：對齊決策'),
    'view.text.details.off':       () => _textPanel((v) => v.setDetailsMode(null), '關閉詳細資料'),
    'text.info': () => _textView((v) => v.openInfoDialog(), '文字比對資訊'),
    'text.fileFormat': () => _textView((v) => v.openFileFormatDialog(), '檔案格式'),
    'text.unimportantText': () => _textView((v) => v.openUnimportantTextDialog(), '不重要文字規則'),
    'text.alignmentOptions': () => _textView((v) => v.openAlignmentDialog(), '對齊選項'),
    'text.toggleSyntax': () => _textView(
      (v) => showStatus(v.setSyntaxHighlighting() ? '已開啟語法高亮' : '已關閉語法高亮'), '語法高亮'),
    'text.orphansImportant': () => _textView(
      (v) => showStatus(v.setOrphansAlwaysImportant() ? '單側獨有的行一律視為重要' : '單側獨有的行可被規則降級'),
      '此設定'),
    ...Object.fromEntries(WHITESPACE_MODE_IDS.map((id) => [
      id,
      () => _textView((v) => v.setWhitespaceMode(id.split('.').pop()), '空白比對方式'),
    ])),
    ...Object.fromEntries(BOOKMARK_GOTO_IDS.map((id, i) => [
      id,
      () => _textView((v) => v.gotoBookmark(i + 1), '書籤'),
    ])),

    'view.text.ruler':       () => _textPanel((v) => showStatus(v.toggleRuler() ? '已顯示欄位標尺' : '已隱藏欄位標尺')),
    'view.text.fileInfo':    () => _textPanel((v) => showStatus(v.toggleFileInfo() ? '已顯示檔案資訊' : '已隱藏檔案資訊')),
    'view.text.description': () => _textPanel((v) => showStatus(v.toggleDescription() ? '已顯示說明欄' : '已隱藏說明欄')),
    'view.text.readOnly.left':  () => _textPanel((v) => showStatus(v.setSideReadOnly('left') ? '左側已鎖定' : '左側已解鎖')),
    'view.text.readOnly.right': () => _textPanel((v) => showStatus(v.setSideReadOnly('right') ? '右側已鎖定' : '右側已解鎖')),
    'view.text.font.default':   () => _textFont(0),
    'view.text.font.consolas':  () => _textFont(1),
    'view.text.font.cascadia':  () => _textFont(2),
    'view.text.font.fira':      () => _textFont(3),
    'view.text.font.courier':   () => _textFont(4),
    'view.text.font.jetbrains': () => _textFont(5),

    'view.hex.details':  () => _hexPanel((v) => showStatus(v.toggleDetails() ? '已顯示詳細資料' : '已隱藏詳細資料')),
    'view.hex.fileInfo': () => _hexPanel((v) => showStatus(v.toggleFileInfo() ? '已顯示檔案資訊' : '已隱藏檔案資訊')),
    'view.hex.ruler':    () => _hexPanel((v) => showStatus(v.toggleRuler() ? '已顯示位移標尺' : '已隱藏位移標尺')),

    'edit.table.goto':       () => _tablePanel((v) => v.openGoto()),
    'edit.table.copyToRight': () => _tablePanel((v) => { void v.copyRowToRight() }),
    'edit.table.copyToLeft':  () => _tablePanel((v) => { void v.copyRowToLeft() }),
    'edit.table.insertRow':  () => _tablePanel((v) => { v.insertRow('left') }),
    'view.hex.thumbnail': () => _hexPanel((v) => showStatus(v.toggleThumbnail() ? '已顯示縮圖' : '已隱藏縮圖')),
    'view.hex.layout': () => _hexPanel((v) => showStatus(v.toggleLayout() === 'over-under' ? '上下堆疊' : '左右並排')),
    'file.reload': () => reloadActiveFromDisk(),

    'view.folder.compareContentsSelected': () => _folderPanel((v) => {
      void v.compareContentsSelected()
    }),
    'view.folder.compareContentsAll': () => _folderPanel((v) => { void v.compareContentsAll() }),
    'view.folder.alwaysShowFolders': () => _folderPanel((v) => {
      showStatus(v.toggleAlwaysShowFolders() ? '一律顯示資料夾' : '資料夾依篩選顯示')
    }),
    'view.folder.suppressFilters': () => _folderPanel((v) => {
      showStatus(v.toggleSuppressFilters() ? '已暫停所有篩選' : '已恢復篩選')
    }),
    'view.folder.filterRegex': () => _folderPanel((v) => {
      showStatus(v.toggleFilterRegex() ? '快速篩選：正規表示式' : '快速篩選：一般文字')
    }),
    'view.folder.legend': () => _folderPanel((v) => {
      showStatus(v.toggleLegend() ? '已顯示圖例' : '已隱藏圖例')
    }),
    'view.folder.log': () => _folderPanel((v) => {
      showStatus(v.toggleLogPanel() ? '已顯示記錄' : '已隱藏記錄')
    }),

    // Table gained the commands every other view already had. The keys are
    // bound inside the view's own handler, so these menu entries are additive
    // and the accelerators stay hint-only as everywhere else here.
    'view.table.rowNumbers': () => _tablePanel((v) => {
      showStatus(v.toggleRowNumbers() ? '已顯示列號' : '已隱藏列號')
    }),
    'view.table.fontLarger':  () => _tablePanel((v) => v.increaseFontSize()),
    'view.table.fontSmaller': () => _tablePanel((v) => v.decreaseFontSize()),
    'view.table.fontReset':   () => _tablePanel((v) => v.resetFontSize()),
    'edit.table.selectAll':   () => _tablePanel((v) => v.selectAll()),
    'edit.table.copy':        () => _tablePanel((v) => { void v.copySelection() }),
    'edit.table.cut':         () => _tablePanel((v) => { void v.cutCell() }),
    'edit.table.paste':       () => _tablePanel((v) => { void v.pasteCell() }),
    'edit.table.delete':      () => _tablePanel((v) => v.deleteCell()),
    'search.table.nextEdit':  () => _tablePanel((v) => v.nextEdit()),
    'search.table.prevEdit':  () => _tablePanel((v) => v.prevEdit()),
    'file.table.explorerLeft':  () => _tablePanel((v) => { void v.revealInExplorer('left') }),
    'file.table.explorerRight': () => _tablePanel((v) => { void v.revealInExplorer('right') }),

    // Pane layout for three-way merge. Four panes on a small screen leaves the
    // output — where the actual work happens — with a quarter of the width.
    'view.merge.toggleBasePane': () => _mergePanel((v) => {
      showStatus(v.toggleBaseVisible() ? '已顯示基準窗格' : '已隱藏基準窗格')
    }),
    'view.merge.maximizeOutput': () => _mergePanel((v) => { v.toggleMaximizeOutput() }),
    'view.merge.maximizeSources': () => _mergePanel((v) => { v.toggleMaximizeSources() }),
    'view.merge.lineNumbers': () => _mergePanel((v) => {
      showStatus(v.toggleLineNumbers() ? '已顯示行號' : '已隱藏行號')
    }),
    'view.merge.resetLayout': () => _mergePanel((v) => { v.resetLayout() }),
    'view.text.thumbnail': () => _textPanel(
      (v) => showStatus(v.toggleThumbnail() ? '已顯示縮圖' : '已隱藏縮圖')),
    'text.editorOptions': () => _textView((v) => v.openEditorOptionsDialog(), '編輯器選項'),

    // Three-way folder merge. The view is fully usable from its own toolbar;
    // these exist so the merge commands sit where BC puts them, next to the
    // rest of the session actions.
    'session.folder.merge.toggle': () => _folderPanel((v) => {
      showStatus(v.toggleMergeMode() ? '已進入三向合併模式' : '已離開三向合併模式')
    }),
    'session.folder.merge.openBase': () => _folderPanel((v) => { void v.openBase() }),
    'session.folder.merge.openOutput': () => _folderPanel((v) => { void v.openOutput() }),
    'session.folder.merge.preview': () => _folderPanel((v) => { void v.previewMerge() }),
    'session.folder.merge.apply': () => _folderPanel((v) => { void v.applyMerge() }),
    'session.folder.merge.nextConflict': () => _folderPanel((v) => v.nextConflict()),
    'session.folder.merge.prevConflict': () => _folderPanel((v) => v.prevConflict()),
    'view.folder.merge.onlyConflicts': () => _folderPanel((v) => {
      showStatus(v.toggleShowOnlyConflicts() ? '只顯示衝突' : '顯示全部')
    }),
    'session.folder.merge.resolveAll.left': () => _folderPanel((v) => v.resolveAllConflicts('left')),
    'session.folder.merge.resolveAll.base': () => _folderPanel((v) => v.resolveAllConflicts('base')),
    'session.folder.merge.resolveAll.right': () => _folderPanel((v) => v.resolveAllConflicts('right')),
    'session.folder.merge.resolveAll.delete': () => _folderPanel((v) => v.resolveAllConflicts('delete')),
    'session.folder.merge.clearResolutions': () => _folderPanel((v) => v.clearMergeResolutions()),
    'search.hex.replace': () => _hexPanel((v) => v.setReplaceOpen(true)),
    'view.table.severity':   () => _tablePanel((v) => showStatus(v.toggleSeverityShading() ? '已顯示差異程度色階' : '已關閉差異程度色階')),
    'view.table.thumbnail':  () => _tablePanel((v) => showStatus(v.toggleThumbnail() ? '已顯示縮圖' : '已隱藏縮圖')),
    'view.table.details':    () => _tablePanel((v) => showStatus(v.toggleDetails() ? '已顯示詳細資料' : '已隱藏詳細資料')),
    'view.table.fileInfo':   () => _tablePanel((v) => showStatus(v.toggleFileInfo() ? '已顯示檔案資訊' : '已隱藏檔案資訊')),
    'view.table.whitespace': () => _tablePanel((v) => showStatus(v.toggleWhitespace() ? '已顯示空白字元' : '已隱藏空白字元')),

    'tools.grammar':      () => openGrammarModal(),
    'tools.ignoreRules':  () => openIgnoreRulesModal(),
    'tools.namedConfigs': () => openConfigModal(),
    'tools.shortcuts':    () => el('btn-settings-modal')?.click(),
    'tools.algorithm.myers':     () => { if (currentView === 'text') textCompare?.setAlgorithm('myers') },
    'tools.algorithm.patience':  () => { if (currentView === 'text') textCompare?.setAlgorithm('patience') },
    'tools.algorithm.histogram': () => { if (currentView === 'text') textCompare?.setAlgorithm('histogram') },

    'help.about': () => showStatus('MyCompare — Electron 版 BeyondCompare 複製品'),
  }

  // Published before the IPC listener is attached so an e2e test can drive a
  // menu command without a native menu, which Playwright cannot click.
  _menuCommands = commands

  if (!window.electronAPI?.onMenuAction) return

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

  const renderPrefs = setupPreferenceControls(setStatus)
  const renderAppearance = setupAppearanceControls(setStatus)
  const renderCommands = setupCommandControls(setStatus)
  const { current: selectPane, show: showPane } = setupOptionsTabs()

  function render() {
    list.replaceChildren()
    const bindings = settings.load().shortcuts
    for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
      const label = SHORTCUT_LABELS[action]
      if (!label) continue

      const row = document.createElement('div')
      row.className = 'settings-row'

      const nameEl = document.createElement('span')
      nameEl.className = 'settings-row-name'
      nameEl.textContent = label

      const combo = settings.getShortcut(action)
      const comboEl = document.createElement('code')
      comboEl.className = 'settings-row-combo'
      comboEl.textContent = combo || '（未設定）'

      // A clash is shown on every row that shares the key, not only on the one
      // that was just recorded: the user may open this dialog long afterwards
      // and needs to see why one of two identical bindings never fires.
      const clashes = findShortcutConflicts(bindings, action, combo)
      /** @type {HTMLElement | null} */
      let warnEl = null
      if (clashes.length) {
        row.classList.add('settings-row--conflict')
        warnEl = document.createElement('span')
        warnEl.className = 'settings-row-conflict'
        warnEl.textContent = `⚠ ${combo} 已被「${
          clashes.map((a) => SHORTCUT_LABELS[a] ?? a).join('、')}」佔用`
      }

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
          const clashes = findShortcutConflicts(settings.load().shortcuts, action, combo)
          settings.setShortcut(action, combo)
          stopRecording()
          render()
          setStatus(clashes.length
            ? `已設定 ${combo}，但「${
              clashes.map((a) => SHORTCUT_LABELS[a] ?? a).join('、')}」也綁在這個鍵位上`
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
      if (warnEl) row.appendChild(warnEl)
      list.appendChild(row)
    }
  }

  const refreshAll = () => {
    render(); renderPrefs(); renderAppearance(); renderCommands(); void refreshPortableState()
  }
  const open = () => { refreshAll(); setStatus(''); modal.style.display = 'flex' }
  const close = () => { stopRecording(); modal.style.display = 'none' }

  // Menu commands that want a specific page have to go through here; opening
  // the dialog and leaving the user to find the page is how "Customize
  // Commands…" would end up meaning "Options…".
  _openOptionsPane = (pane) => { open(); showPane(pane) }

  el('btn-settings-modal')?.addEventListener('click', open)
  el('btn-settings-modal-close')?.addEventListener('click', close)
  el('btn-settings-modal-cancel')?.addEventListener('click', close)

  // Reset is scoped to the visible page. A single button that wiped every page
  // would be the one control in the dialog whose blast radius is invisible.
  el('btn-settings-reset')?.addEventListener('click', () => {
    const pane = selectPane()
    if (pane === 'shortcuts') {
      settings.reset()
      setStatus('快捷鍵已恢復預設')
    } else if (pane === 'appearance') {
      settings.resetAppearance()
      applyAppearance()
      setStatus('色彩與字型已恢復預設')
    } else if (pane === 'general') {
      settings.resetPrefs(PREF_PAGES.general)
      setThemeMode('system')
      setStatus('一般設定已恢復預設')
    } else if (pane === 'commands') {
      settings.resetCommandVisibility()
      applyCommandVisibility()
      setStatus('所有指令已恢復顯示')
    } else {
      settings.resetPrefs(PREF_PAGES[pane] ?? [])
      applyDisplayPrefs()
      setStatus('本頁設定已恢復預設')
    }
    refreshAll()
  })

  setupSettingsTransfer(setStatus, refreshAll)
}

/**
 * Wire the Options tab strip.
 *
 * @returns {{ current: () => string, show: (pane: string) => void }}
 */
function setupOptionsTabs() {
  const strip = el('options-tabs')
  let current = 'general'
  if (!strip) return { current: () => current, show: () => {} }

  /** @type {HTMLButtonElement[]} */
  const tabs = [...strip.querySelectorAll('.options-tab')]

  /** @param {string} pane */
  const show = (pane) => {
    current = pane
    for (const tab of tabs) {
      const on = tab.dataset.pane === pane
      tab.classList.toggle('options-tab--active', on)
      tab.setAttribute('aria-selected', String(on))
    }
    for (const section of document.querySelectorAll('.options-pane')) {
      section.hidden = section.id !== `options-pane-${pane}`
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => show(tab.dataset.pane ?? 'general'))
  }
  show(current)
  return { current: () => current, show }
}

/**
 * Wire the "Menu and toolbar" page.
 *
 * Rows are generated from TOOLBAR_COMMANDS rather than from the toolbar's DOM:
 * a button that is currently hidden is not in the document to be scanned, so
 * building the list from what is on screen would make the checkbox that hid it
 * disappear along with it.
 *
 * @param {(msg: string) => void} setStatus
 * @returns {() => void} re-reads the store into the controls
 */
function setupCommandControls(setStatus) {
  const list = el('settings-commands-list')
  const filterInput = el('inp-command-filter')
  if (!list) return () => {}

  let filter = ''

  const render = () => {
    list.replaceChildren()
    const needle = filter.trim().toLowerCase()
    let shown = 0
    for (const cmd of TOOLBAR_COMMANDS) {
      if (needle && !cmd.label.toLowerCase().includes(needle)
          && !cmd.id.toLowerCase().includes(needle)) continue
      shown += 1

      const row = document.createElement('label')
      row.className = 'settings-check'

      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = settings.isCommandVisible(cmd.id)
      box.dataset.commandId = cmd.id
      box.addEventListener('change', () => {
        if (!settings.setCommandVisible(cmd.id, box.checked)) {
          setStatus(`無法設定「${cmd.label}」：不是已知的指令`)
          box.checked = settings.isCommandVisible(cmd.id)
          return
        }
        applyCommandVisibility()
        setStatus(box.checked ? `已顯示「${cmd.label}」` : `已從工具列隱藏「${cmd.label}」`)
      })

      const name = document.createElement('span')
      name.textContent = cmd.label
      row.append(box, name)

      if (cmd.menuId) {
        const note = document.createElement('span')
        note.className = 'settings-row-conflict'
        note.textContent = `選單（${cmd.menuId}）：尚未支援`
        row.appendChild(note)
      }
      list.appendChild(row)
    }

    if (shown === 0) {
      const empty = document.createElement('p')
      empty.className = 'settings-hint'
      empty.textContent = '沒有符合的指令'
      list.appendChild(empty)
    }
  }

  filterInput?.addEventListener('input', () => {
    filter = /** @type {HTMLInputElement} */ (filterInput).value
    render()
  })

  return () => {
    if (filterInput instanceof HTMLInputElement) filter = filterInput.value
    render()
  }
}

/**
 * Hide the toolbar buttons the user switched off.
 *
 * Separators are left alone: a run of them with nothing between is untidy, but
 * collapsing them would need to know which separator belongs to which group,
 * and guessing that wrongly removes a divider the user still needs.
 */
function applyCommandVisibility() {
  for (const cmd of TOOLBAR_COMMANDS) {
    const node = el(cmd.element)
    if (!node) continue
    node.style.display = settings.isCommandVisible(cmd.id) ? '' : 'none'
  }
  syncMenuVisibility()
}

/**
 * Hide the same commands in the menu bar.
 *
 * Visibility used to stop at the toolbar, so a command the user had switched
 * off was still one click away in the menu that shipped it — which reads as
 * the preference not working rather than as applying to toolbars only. Only
 * commands carrying a `menuId` have a menu counterpart; the rest are toolbar
 * buttons with no menu equivalent and simply have nothing to hide.
 */
function syncMenuVisibility() {
  const hidden = TOOLBAR_COMMANDS
    .filter((c) => c.menuId && !settings.isCommandVisible(c.id))
    .map((c) => c.menuId)
  // Best effort: failing to rebuild the menu must not take the toolbar update
  // down with it, but it should still be visible rather than swallowed.
  window.electronAPI?.setMenuVisibility?.(hidden)?.catch?.((err) => {
    console.error('選單可見性同步失敗', err)
  })
}

/**
 * Wire the Colors & Fonts page.
 *
 * The colour swatches are built from COLOR_TOKENS rather than from markup so
 * the set of customisable colours has exactly one definition; the *meaning* of
 * each slot is fixed by the project's colour semantics and is not editable.
 *
 * @param {(msg: string) => void} setStatus
 * @returns {() => void} re-reads the store into the controls
 */
function setupAppearanceControls(setStatus) {
  const grid = el('options-colors')
  const hint = el('colors-theme-hint')
  const inpUi = el('inp-font-ui')
  const inpMono = el('inp-font-mono')
  const inpSize = el('inp-font-ui-size')

  /** @returns {'light'|'dark'} */
  const activeTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

  /**
   * The value a swatch should show: the user's override if there is one, else
   * whatever the stylesheet currently resolves the token to.
   *
   * @param {string} cssVar
   * @param {string | undefined} override
   * @returns {string}
   */
  const swatchValue = (cssVar, override) => {
    if (override) return override
    const computed = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim()
    return /^#[0-9a-f]{6}$/i.test(computed) ? computed.toLowerCase() : '#000000'
  }

  const refresh = () => {
    const { colors, fonts } = settings.getAppearance()
    const theme = activeTheme()
    const overrides = colors[theme] ?? {}

    if (hint) {
      hint.textContent = `目前編輯的是「${theme === 'dark' ? '深色' : '淺色'}」主題的色彩；`
        + '另一個主題有自己的一組色彩。語意固定，可自訂的是色值。'
    }

    if (grid) {
      grid.replaceChildren()
      for (const token of COLOR_TOKENS) {
        const label = document.createElement('span')
        label.className = 'color-label'
        label.textContent = token.label

        const input = document.createElement('input')
        input.type = 'color'
        input.id = `color-${token.key}`
        input.value = swatchValue(token.cssVar, overrides[token.key])
        input.title = token.cssVar

        const value = document.createElement('code')
        value.className = 'color-value'
        value.textContent = overrides[token.key] ? input.value : '（預設）'

        input.addEventListener('input', () => {
          if (!settings.setColor(activeTheme(), token.key, input.value)) {
            setStatus(`色彩值 ${input.value} 無法使用`)
            return
          }
          applyAppearance()
          value.textContent = input.value
          setStatus(`已更新「${token.label}」`)
        })

        grid.append(label, input, value)
      }
    }

    if (inpUi instanceof HTMLInputElement) inpUi.value = fonts.ui
    if (inpMono instanceof HTMLInputElement) inpMono.value = fonts.mono
    if (inpSize instanceof HTMLInputElement) inpSize.value = String(fonts.uiSize)
  }

  /**
   * @param {HTMLElement | null} node
   * @param {'ui'|'mono'} name
   * @param {string} label
   */
  const wireFont = (node, name, label) => {
    if (!(node instanceof HTMLInputElement)) return
    node.addEventListener('change', () => {
      if (settings.setFontFamily(name, node.value)) {
        applyAppearance()
        setStatus(node.value.trim() ? `已套用${label}` : `${label}已回到預設`)
      } else {
        setStatus(`${label}字型設定無效（不可含 ; { } < > 或 url()）`)
        refresh()
      }
    })
  }
  wireFont(inpUi, 'ui', '介面字型')
  wireFont(inpMono, 'mono', '比對窗格字型')
  _refreshAppearanceControls = refresh

  if (inpSize instanceof HTMLInputElement) {
    inpSize.addEventListener('change', () => {
      const stored = settings.setUiFontSize(inpSize.value)
      inpSize.value = String(stored)
      applyAppearance()
      setStatus(`介面字型大小：${stored}px`)
    })
  }

  return refresh
}

// ---------------------------------------------------------------------------
// P2-38: export / import of every stored setting
// ---------------------------------------------------------------------------

/**
 * Wire the two buttons on the General page.
 *
 * @param {(msg: string) => void} setStatus
 * @param {() => void} refreshAll  re-reads every control after an import
 */
function setupSettingsTransfer(setStatus, refreshAll) {
  el('btn-settings-export')?.addEventListener('click', async () => {
    try {
      const json = exportSettingsJSON()
      const saved = await window.electronAPI.saveFile('mycompare-settings.json', json,
        [{ name: 'JSON', extensions: ['json'] }, { name: '所有檔案', extensions: ['*'] }])
      setStatus(saved ? `設定已匯出到 ${saved.path ?? ''}` : '已取消匯出')
    } catch (err) {
      const msg = `匯出設定失敗：${err instanceof Error ? err.message : String(err)}`
      setStatus(msg)
      showError(msg, err)
    }
  })

  el('btn-settings-import')?.addEventListener('click', async () => {
    try {
      const picked = await window.electronAPI.openFile?.({
        filters: [{ name: 'JSON', extensions: ['json'] }, { name: '所有檔案', extensions: ['*'] }],
      })
      if (!picked?.content) return

      const result = applySettingsBundle(picked.content)
      if (result.legacySessions) {
        // A pre-bundle export contained sessions only; hand it to the store
        // that knows how to validate each record.
        const { imported, skipped } = store.importJSON(picked.content)
        setStatus(`舊版 Sessions 匯出檔：匯入 ${imported} 個，跳過 ${skipped} 個`)
        renderRecentSessions(openSession, removeSession)
        return
      }

      applyAppearance()
      applyDisplayPrefs()
      applyCommandVisibility()
      restoreUserGrammars()
      refreshAll()
      renderRecentSessions(openSession, removeSession)
      setStatus(`已匯入 ${result.applied.length} 個設定區段；部分設定需重新開啟分頁才會生效`)
    } catch (err) {
      // Nothing was written: applySettingsBundle validates before it touches
      // storage, so the user still has the settings they had.
      const msg = `匯入設定失敗：${err instanceof Error ? err.message : String(err)}`
      setStatus(msg)
      showError(msg, err)
    }
  })
}

/**
 * Wire the non-shortcut halves of the settings dialog: the Next-Difference
 * options and the backup options.
 *
 * Both sets of preferences and every reader of them already existed; only the
 * controls that write them were missing, so the stored values never moved off
 * their defaults.
 *
 * @param {(msg: string) => void} setStatus
 * @returns {() => void} re-reads the store into the controls
 */
function setupPreferenceControls(setStatus) {
  /** @type {Array<[string, 'navWrapAround'|'navFirstDiffOnLoad'|'navNextAfterCopy'|'navShowNoDiffMessage'|'backupOnSave'|'confirmOnCloseTab'|'showToolbar'|'showStatusBar', string]>} */
  const CHECKS = [
    ['chk-nav-wrap',             'navWrapAround',        '環繞'],
    ['chk-nav-first-on-load',    'navFirstDiffOnLoad',   '載入後跳到第一個差異'],
    ['chk-nav-next-after-copy',  'navNextAfterCopy',     '複製後前進'],
    ['chk-nav-no-diff-message',  'navShowNoDiffMessage', '無差異訊息'],
    ['chk-backup-enabled',       'backupOnSave',         '儲存前備份'],
    ['chk-confirm-close-tab',    'confirmOnCloseTab',    '關閉分頁前確認'],
    ['chk-show-toolbar',         'showToolbar',          '顯示工具列'],
    ['chk-show-statusbar',       'showStatusBar',        '顯示狀態列'],
  ]

  const themeSel = el('sel-theme-mode')

  const namingSel = el('sel-backup-naming')
  if (namingSel instanceof HTMLSelectElement && namingSel.options.length === 0) {
    for (const { value, label } of BACKUP_NAMING_OPTIONS) {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      namingSel.appendChild(opt)
    }
  }

  const folderEl = el('txt-backup-folder')

  const refresh = () => {
    for (const [id, pref] of CHECKS) {
      const node = el(id)
      if (node instanceof HTMLInputElement) node.checked = Boolean(settings.getPref(pref))
    }
    const backup = settings.getBackupOptions()
    if (namingSel instanceof HTMLSelectElement) {
      namingSel.value = backup.naming
      namingSel.disabled = !backup.enabled
    }
    if (folderEl) folderEl.textContent = backup.folder || '（與原檔同一資料夾）'
    if (themeSel instanceof HTMLSelectElement) themeSel.value = getThemeMode()
  }

  for (const [id, pref, label] of CHECKS) {
    const node = el(id)
    if (!(node instanceof HTMLInputElement)) continue
    node.addEventListener('change', () => {
      settings.setPref(pref, node.checked)
      applyDisplayPrefs()
      refresh()
      setStatus(`${label}：${node.checked ? '開啟' : '關閉'}`)
    })
  }

  if (themeSel instanceof HTMLSelectElement) {
    themeSel.addEventListener('change', () => {
      const mode = themeSel.value
      setThemeMode(mode === 'light' || mode === 'dark' ? mode : 'system')
      setStatus(`主題：${themeSel.selectedOptions[0]?.textContent ?? mode}`)
    })
  }

  if (namingSel instanceof HTMLSelectElement) {
    namingSel.addEventListener('change', () => {
      settings.setPref('backupNaming', namingSel.value)
      refresh()
      setStatus('已更新備份命名規則')
    })
  }

  // The folder has to come from the dialog: the main process only reads under
  // roots the user authorised, so a typed path would be rejected on first use
  // rather than here, where the mistake is visible.
  el('btn-backup-folder')?.addEventListener('click', async () => {
    try {
      const picked = await window.electronAPI?.openFolder?.()
      if (!picked?.path) return
      settings.setPref('backupFolder', picked.path)
      refresh()
      setStatus(`備份資料夾：${picked.path}`)
    } catch (err) {
      setStatus(`無法選擇資料夾：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  el('btn-backup-folder-clear')?.addEventListener('click', () => {
    settings.setPref('backupFolder', '')
    refresh()
    setStatus('備份將放在原檔旁邊')
  })

  return refresh
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
// 文法（File Format）Modal
// ---------------------------------------------------------------------------

/** @typedef {import('./core/grammar.js').GrammarDef} GrammarDef */
/** @typedef {import('./core/grammar.js').GrammarItem} GrammarItem */
/** @typedef {import('./core/grammar.js').GrammarItemType} GrammarItemType */

/** Which editor fields and per-item options each item type actually uses. */
const GRAMMAR_TYPE_FIELDS = Object.freeze({
  basic:     { opts: ['matchCase', 'regex', 'wholeWord'] },
  delimited: { opts: ['matchCase'] },
  list:      { opts: ['matchCase', 'wholeWord'] },
  columns:   { opts: [] },
  lines:     { opts: ['matchCase', 'regex'] },
})

/**
 * The dialog edits a detached copy and only writes it back on 套用, so cancelling
 * leaves the registry — and therefore every open comparison — untouched.
 *
 * @type {{ defs: Array<GrammarDef & { builtin?: boolean }>, defIndex: number,
 *          itemIndex: number, ignored: Set<string>, dragFrom: number }}
 */
const _grammarEdit = {
  defs: [],
  defIndex: -1,
  itemIndex: -1,
  ignored: new Set(),
  dragFrom: -1,
}

/** @returns {(GrammarDef & { builtin?: boolean }) | null} */
function _grammarDef() {
  return _grammarEdit.defs[_grammarEdit.defIndex] ?? null
}

/** @returns {boolean} whether the selected definition may be edited */
function _grammarEditable() {
  const def = _grammarDef()
  return !!def && !def.builtin
}

/**
 * @param {GrammarDef & { builtin?: boolean }} def
 * @returns {GrammarDef & { builtin?: boolean }}
 */
function _cloneGrammarDef(def) {
  return {
    name: def.name,
    masks: [...(def.masks ?? [])],
    caseSensitive: def.caseSensitive !== false,
    builtin: !!def.builtin,
    items: (def.items ?? []).map((i) => ({ ...i })),
  }
}

function openGrammarModal() {
  const overlay = el('grammar-modal')
  if (!overlay) return

  const user = getUserGrammars().map((d) => _cloneGrammarDef({ ...d, builtin: false }))
  const builtin = BUILTIN_GRAMMARS.map((d) => _cloneGrammarDef(d))
  _grammarEdit.defs = [...user, ...builtin]
  _grammarEdit.defIndex = _grammarEdit.defs.length > 0 ? 0 : -1
  _grammarEdit.itemIndex = -1
  _grammarEdit.dragFrom = -1
  _grammarEdit.ignored = new Set(textCompare?.getGrammarInfo?.().ignored ?? [])

  overlay.style.display = 'flex'
  _setGrammarStatus('')
  renderGrammarModal()
}

function closeGrammarModal() {
  const overlay = el('grammar-modal')
  if (overlay) overlay.style.display = 'none'
}

/** @param {string} msg */
function _setGrammarStatus(msg) {
  const status = el('grammar-modal-status')
  if (status) status.textContent = msg
}

function renderGrammarModal() {
  renderGrammarDefList()
  renderGrammarDefFields()
  renderGrammarItemList()
  renderGrammarItemEditor()
  renderGrammarIgnoreList()
  renderGrammarErrors()
}

function renderGrammarDefList() {
  const list = el('grammar-def-list')
  if (!list) return
  list.replaceChildren()

  if (_grammarEdit.defs.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'config-list-empty'
    empty.textContent = '（沒有任何文法定義）'
    list.appendChild(empty)
    return
  }

  _grammarEdit.defs.forEach((def, index) => {
    const row = document.createElement('div')
    row.className = 'config-list-item'
    if (index === _grammarEdit.defIndex) row.classList.add('grammar-def-item--active')
    row.dataset.index = String(index)

    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = def.name || '（未命名）'

    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = def.builtin ? '內建' : '自訂'

    row.append(name, meta)
    row.addEventListener('click', () => {
      _grammarEdit.defIndex = index
      _grammarEdit.itemIndex = -1
      renderGrammarModal()
    })
    list.appendChild(row)
  })
}

function renderGrammarDefFields() {
  const def = _grammarDef()
  const editable = _grammarEditable()

  const name = el('input-grammar-name')
  const masks = el('input-grammar-masks')
  const caseChk = el('chk-grammar-case')
  if (name) { name.value = def?.name ?? ''; name.disabled = !editable }
  if (masks) { masks.value = (def?.masks ?? []).join(', '); masks.disabled = !editable }
  if (caseChk) { caseChk.checked = def?.caseSensitive !== false; caseChk.disabled = !editable }

  setDisabled('btn-grammar-def-copy', !def)
  setDisabled('btn-grammar-def-remove', !editable)
  for (const id of ['btn-grammar-item-add', 'btn-grammar-item-up',
    'btn-grammar-item-down', 'btn-grammar-item-remove']) {
    setDisabled(id, !editable)
  }
}

/**
 * One-line description of an item, so the ordering list is readable without
 * selecting every row in turn.
 * @param {GrammarItem} item
 * @returns {string}
 */
function _grammarItemSummary(item) {
  switch (item.type) {
    case 'basic':     return item.regex ? `/${item.text ?? ''}/` : `"${item.text ?? ''}"`
    case 'delimited': return `${item.start ?? ''} … ${item.end ?? (item.stopAtEol ? '行尾' : '')}`
    case 'list':      return `${(item.items ?? []).length} 個關鍵字`
    case 'columns':   return `第 ${item.startColumn ?? 1} – ${item.toEol ? '行尾' : (item.endColumn ?? '?')} 欄`
    case 'lines':     return item.regex ? `/${item.match ?? ''}/` : `"${item.match ?? ''}"`
    default:          return String(item.type ?? '')
  }
}

function renderGrammarItemList() {
  const list = el('grammar-item-list')
  if (!list) return
  list.replaceChildren()

  const def = _grammarDef()
  const items = def?.items ?? []
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'grammar-item-empty'
    empty.textContent = def ? '（這個文法沒有任何項目）' : '（尚未選擇文法）'
    list.appendChild(empty)
    return
  }

  const editable = _grammarEditable()
  items.forEach((item, index) => {
    const row = document.createElement('div')
    row.className = 'grammar-item-row'
    if (index === _grammarEdit.itemIndex) row.classList.add('grammar-item-row--active')
    row.dataset.index = String(index)
    row.draggable = editable

    const ord = document.createElement('span')
    ord.className = 'grammar-item-row__ord'
    ord.textContent = `${index + 1}.`

    const label = document.createElement('span')
    label.textContent = `${item.element ?? '(無名稱)'} — ${item.type ?? '?'}`

    const meta = document.createElement('span')
    meta.className = 'grammar-item-row__meta'
    meta.textContent = _grammarItemSummary(item)

    row.append(ord, label, meta)
    row.addEventListener('click', () => {
      _grammarEdit.itemIndex = index
      renderGrammarItemList()
      renderGrammarItemEditor()
    })

    if (editable) _wireGrammarItemDrag(row, index)
    list.appendChild(row)
  })
}

/**
 * Drag-to-reorder. Priority *is* array order in this engine, so reordering is
 * the only way to say "match /* before //".
 *
 * @param {HTMLElement} row
 * @param {number} index
 */
function _wireGrammarItemDrag(row, index) {
  row.addEventListener('dragstart', (e) => {
    _grammarEdit.dragFrom = index
    e.dataTransfer?.setData('text/plain', String(index))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  })
  row.addEventListener('dragover', (e) => {
    if (_grammarEdit.dragFrom < 0) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    row.classList.add('grammar-item-row--dropping')
  })
  row.addEventListener('dragleave', () => row.classList.remove('grammar-item-row--dropping'))
  row.addEventListener('drop', (e) => {
    e.preventDefault()
    row.classList.remove('grammar-item-row--dropping')
    const from = _grammarEdit.dragFrom
    _grammarEdit.dragFrom = -1
    if (from < 0 || from === index) return
    _reorderGrammarItem(from, index)
  })
  row.addEventListener('dragend', () => {
    _grammarEdit.dragFrom = -1
    row.classList.remove('grammar-item-row--dropping')
  })
}

/**
 * @param {number} from
 * @param {number} to
 */
function _reorderGrammarItem(from, to) {
  const def = _grammarDef()
  if (!def || !_grammarEditable()) return
  const items = def.items
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return
  const [moved] = items.splice(from, 1)
  items.splice(to, 0, moved)
  _grammarEdit.itemIndex = to
  renderGrammarItemList()
  renderGrammarErrors()
  _setGrammarStatus(`已將「${moved.element ?? ''}」移到第 ${to + 1} 順位`)
}

/** @param {number} delta -1 to move up, +1 to move down */
function moveGrammarItem(delta) {
  const def = _grammarDef()
  if (!def || !_grammarEditable()) return
  const from = _grammarEdit.itemIndex
  if (from < 0) { _setGrammarStatus('請先選擇一個項目'); return }
  const to = from + delta
  if (to < 0 || to >= def.items.length) { _setGrammarStatus('已經在邊界了'); return }
  _reorderGrammarItem(from, to)
}

function renderGrammarItemEditor() {
  const editor = el('grammar-item-editor')
  if (!editor) return
  const def = _grammarDef()
  const item = def?.items?.[_grammarEdit.itemIndex] ?? null
  const editable = _grammarEditable() && !!item

  editor.disabled = !editable
  editor.toggleAttribute('disabled', !editable)

  const type = /** @type {GrammarItemType} */ (item?.type ?? 'basic')

  for (const field of editor.querySelectorAll('.grammar-field')) {
    field.toggleAttribute('hidden', field.getAttribute('data-for') !== type)
  }
  const shown = GRAMMAR_TYPE_FIELDS[type]?.opts ?? []
  for (const opt of editor.querySelectorAll('[data-opt]')) {
    opt.toggleAttribute('hidden', !shown.includes(opt.getAttribute('data-opt') ?? ''))
  }

  /** @param {string} id @param {string} value */
  const setText = (id, value) => { const node = el(id); if (node) node.value = value }
  /** @param {string} id @param {boolean} value */
  const setChk = (id, value) => { const node = el(id); if (node) node.checked = value }

  setText('sel-grammar-item-type', type)
  setText('input-grammar-item-element', item?.element ?? '')
  setText('input-grammar-item-text', item?.text ?? '')
  setText('input-grammar-item-start', item?.start ?? '')
  setText('input-grammar-item-end', item?.end ?? '')
  setText('input-grammar-item-escape', item?.escape ?? '')
  setText('input-grammar-item-items', (item?.items ?? []).join('\n'))
  setText('input-grammar-item-startcol', item?.startColumn == null ? '' : String(item.startColumn))
  setText('input-grammar-item-endcol', item?.endColumn == null ? '' : String(item.endColumn))
  setText('input-grammar-item-match', item?.match ?? '')
  setText('input-grammar-item-heading', item?.headingLines == null ? '' : String(item.headingLines))
  setText('input-grammar-item-weight', item?.lineWeight == null ? '' : String(item.lineWeight))
  setChk('chk-grammar-item-stopateol', !!item?.stopAtEol)
  setChk('chk-grammar-item-multiline', !!item?.multiline)
  setChk('chk-grammar-item-toeol', !!item?.toEol)
  setChk('chk-grammar-item-orline1', !!item?.orLine1)
  setChk('chk-grammar-item-matchcase', item?.matchCase ?? (def?.caseSensitive !== false))
  setChk('chk-grammar-item-regex', !!item?.regex)
  setChk('chk-grammar-item-wholeword', !!item?.wholeWord)
}

/**
 * Read the editor back into the selected item.
 *
 * Fields belonging to other types are dropped rather than kept, so switching a
 * Basic item to Delimited cannot leave a stale `text` behind that compileGrammar
 * would then complain about.
 */
function commitGrammarItemEditor() {
  const def = _grammarDef()
  if (!def || !_grammarEditable()) return
  const index = _grammarEdit.itemIndex
  const current = def.items[index]
  if (!current) return

  /** @param {string} id @returns {string} */
  const text = (id) => String(el(id)?.value ?? '')
  /** @param {string} id @returns {boolean} */
  const chk = (id) => !!el(id)?.checked
  /** @param {string} id @returns {number|undefined} */
  const num = (id) => {
    const raw = text(id).trim()
    if (raw === '') return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }

  const type = /** @type {GrammarItemType} */ (text('sel-grammar-item-type') || 'basic')
  /** @type {GrammarItem} */
  const next = { type, element: text('input-grammar-item-element').trim() }

  const weight = num('input-grammar-item-weight')
  if (weight !== undefined) next.lineWeight = weight

  const opts = GRAMMAR_TYPE_FIELDS[type]?.opts ?? []
  if (opts.includes('matchCase')) next.matchCase = chk('chk-grammar-item-matchcase')
  if (opts.includes('regex')) next.regex = chk('chk-grammar-item-regex')
  if (opts.includes('wholeWord')) next.wholeWord = chk('chk-grammar-item-wholeword')

  switch (type) {
    case 'basic':
      next.text = text('input-grammar-item-text')
      break
    case 'delimited':
      next.start = text('input-grammar-item-start')
      next.end = text('input-grammar-item-end')
      next.escape = text('input-grammar-item-escape')
      next.stopAtEol = chk('chk-grammar-item-stopateol')
      next.multiline = chk('chk-grammar-item-multiline')
      break
    case 'list':
      next.items = text('input-grammar-item-items')
        .split('\n').map((s) => s.trim()).filter(Boolean)
      break
    case 'columns': {
      next.startColumn = num('input-grammar-item-startcol') ?? 1
      const end = num('input-grammar-item-endcol')
      if (end !== undefined) next.endColumn = end
      next.toEol = chk('chk-grammar-item-toeol')
      break
    }
    case 'lines': {
      next.match = text('input-grammar-item-match')
      const heading = num('input-grammar-item-heading')
      if (heading !== undefined) next.headingLines = heading
      next.orLine1 = chk('chk-grammar-item-orline1')
      break
    }
    default:
      break
  }

  def.items[index] = next
  renderGrammarItemList()
  renderGrammarIgnoreList()
  renderGrammarErrors()
}

function renderGrammarIgnoreList() {
  const list = el('grammar-ignore-list')
  if (!list) return
  list.replaceChildren()

  // The elements the user can currently act on: whatever the selected grammar
  // defines, whatever the loaded files' grammars define, plus anything already
  // ignored — otherwise an ignore set restored from a session would silently
  // become unreachable.
  /** @type {string[]} */
  const names = []
  const add = (name) => { if (name && !names.includes(name)) names.push(name) }
  for (const item of _grammarDef()?.items ?? []) add(item.element)
  for (const name of textCompare?.getGrammarElements?.() ?? []) add(name)
  for (const name of _grammarEdit.ignored) add(name)

  if (names.length === 0) {
    const empty = document.createElement('span')
    empty.className = 'grammar-ignore-empty'
    empty.textContent = '（目前的文法沒有定義任何元素）'
    list.appendChild(empty)
    return
  }

  for (const name of names) {
    const label = document.createElement('label')
    label.className = 'settings-check'
    label.dataset.element = name

    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = _grammarEdit.ignored.has(name)
    input.addEventListener('change', () => {
      if (input.checked) _grammarEdit.ignored.add(name)
      else _grammarEdit.ignored.delete(name)
      _setGrammarStatus(input.checked ? `比對時將忽略「${name}」` : `不再忽略「${name}」`)
    })

    const span = document.createElement('span')
    span.textContent = name

    label.append(input, span)
    list.appendChild(label)
  }
}

/**
 * Show why a rule is not running.
 *
 * compileGrammar drops invalid items and reports the reason; discarding that
 * would leave a rule visible in the list that silently does nothing.
 *
 * @param {string[]} [extra] messages from a write-back attempt
 */
function renderGrammarErrors(extra) {
  const box = el('grammar-errors')
  if (!box) return
  box.replaceChildren()

  /** @type {string[]} */
  const messages = [...(extra ?? [])]
  const def = _grammarDef()
  if (def) {
    for (const err of compileGrammar(def).errors) messages.push(`${def.name || '（未命名）'}：${err}`)
  }
  if (messages.length === 0) return

  const title = document.createElement('div')
  title.className = 'grammar-errors__title'
  title.textContent = `${messages.length} 個問題，對應的規則不會生效：`

  const ul = document.createElement('ul')
  for (const msg of messages) {
    const li = document.createElement('li')
    li.textContent = msg
    ul.appendChild(li)
  }
  box.append(title, ul)
}

/**
 * Load the user's grammars back into the registry at startup.
 *
 * The registry is memory-only, so without this every grammar a user wrote was
 * gone at the next launch — the dialog re-opened listing the built-ins alone
 * and never said why.
 */
function restoreUserGrammars() {
  const stored = loadUserGrammarDefs()
  if (stored.length === 0) return
  const rejected = setUserGrammars(stored)
  if (rejected.length > 0) {
    showError(`有 ${rejected.length} 個已儲存的自訂文法無法載入：${rejected.join('；')}`)
  }
}

function applyGrammarChanges() {
  const userDefs = _grammarEdit.defs
    .filter((d) => !d.builtin)
    .map((d) => ({
      name: d.name,
      masks: [...(d.masks ?? [])],
      caseSensitive: d.caseSensitive !== false,
      items: (d.items ?? []).map((i) => ({ ...i })),
    }))

  // Grammars with no usable item at all are refused outright by the registry;
  // those that merely lost an item still register, and compileGrammar reports
  // the loss below.
  const rejected = setUserGrammars(userDefs)

  // Store what the registry accepted, so a definition rejected here is not
  // reloaded as a failure on every launch.
  const saveError = saveUserGrammarDefs(getUserGrammars())
  if (saveError) showError(saveError)

  if (textCompare) {
    textCompare.applyConfig({ ...textCompare.getConfig(), grammarIgnore: [..._grammarEdit.ignored] })
  }

  renderGrammarErrors(rejected)
  const kept = getUserGrammars().length
  if (rejected.length > 0) {
    _setGrammarStatus(`${rejected.length} 個文法無法套用，其餘 ${kept} 個已生效`)
    return
  }
  _setGrammarStatus(textCompare
    ? `已套用 ${kept} 個自訂文法`
    : `已套用 ${kept} 個自訂文法（目前沒有開啟文字比對）`)
}

function setupGrammarModal() {
  const overlay = el('grammar-modal')
  if (!overlay) return

  el('btn-grammar-modal-close')?.addEventListener('click', closeGrammarModal)
  el('btn-grammar-modal-cancel')?.addEventListener('click', closeGrammarModal)
  el('btn-grammar-apply')?.addEventListener('click', applyGrammarChanges)

  el('btn-grammar-def-add')?.addEventListener('click', () => {
    const base = _grammarEdit.defs.filter((d) => !d.builtin).length + 1
    _grammarEdit.defs.unshift({
      name: `自訂文法 ${base}`,
      masks: [],
      caseSensitive: true,
      builtin: false,
      items: [],
    })
    _grammarEdit.defIndex = 0
    _grammarEdit.itemIndex = -1
    renderGrammarModal()
    _setGrammarStatus('已新增文法，請填入名稱與檔案遮罩')
  })

  el('btn-grammar-def-copy')?.addEventListener('click', () => {
    const def = _grammarDef()
    if (!def) { _setGrammarStatus('請先選擇一個文法'); return }
    const copy = _cloneGrammarDef(def)
    copy.builtin = false
    copy.name = `${def.name} (複本)`
    _grammarEdit.defs.unshift(copy)
    _grammarEdit.defIndex = 0
    _grammarEdit.itemIndex = -1
    renderGrammarModal()
    _setGrammarStatus(`已複製為「${copy.name}」`)
  })

  el('btn-grammar-def-remove')?.addEventListener('click', () => {
    if (!_grammarEditable()) { _setGrammarStatus('內建文法無法刪除，請先複製為自訂'); return }
    const [removed] = _grammarEdit.defs.splice(_grammarEdit.defIndex, 1)
    _grammarEdit.defIndex = Math.min(_grammarEdit.defIndex, _grammarEdit.defs.length - 1)
    _grammarEdit.itemIndex = -1
    renderGrammarModal()
    _setGrammarStatus(`已刪除「${removed?.name ?? ''}」（按「套用」後才會寫回）`)
  })

  /** @param {string} id @param {(def: GrammarDef & { builtin?: boolean }) => void} apply */
  const onDefField = (id, apply) => {
    el(id)?.addEventListener('input', () => {
      const def = _grammarDef()
      if (!def || !_grammarEditable()) return
      apply(def)
      renderGrammarDefList()
      renderGrammarErrors()
    })
  }
  onDefField('input-grammar-name', (def) => { def.name = String(el('input-grammar-name')?.value ?? '') })
  onDefField('input-grammar-masks', (def) => {
    def.masks = String(el('input-grammar-masks')?.value ?? '')
      .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  })
  el('chk-grammar-case')?.addEventListener('change', () => {
    const def = _grammarDef()
    if (!def || !_grammarEditable()) return
    def.caseSensitive = !!el('chk-grammar-case')?.checked
    renderGrammarErrors()
  })

  el('btn-grammar-item-add')?.addEventListener('click', () => {
    const def = _grammarDef()
    if (!def || !_grammarEditable()) { _setGrammarStatus('內建文法無法編輯，請先複製為自訂'); return }
    def.items.push({ type: 'basic', element: 'Element', text: '', lineWeight: 1 })
    _grammarEdit.itemIndex = def.items.length - 1
    renderGrammarItemList()
    renderGrammarItemEditor()
    renderGrammarIgnoreList()
    renderGrammarErrors()
    _setGrammarStatus('已新增項目，請填入元素名稱與內容')
  })

  el('btn-grammar-item-remove')?.addEventListener('click', () => {
    const def = _grammarDef()
    if (!def || !_grammarEditable()) return
    if (_grammarEdit.itemIndex < 0) { _setGrammarStatus('請先選擇一個項目'); return }
    def.items.splice(_grammarEdit.itemIndex, 1)
    _grammarEdit.itemIndex = Math.min(_grammarEdit.itemIndex, def.items.length - 1)
    renderGrammarItemList()
    renderGrammarItemEditor()
    renderGrammarIgnoreList()
    renderGrammarErrors()
  })

  el('btn-grammar-item-up')?.addEventListener('click', () => moveGrammarItem(-1))
  el('btn-grammar-item-down')?.addEventListener('click', () => moveGrammarItem(1))

  // The type select rebuilds which fields are visible, so it commits and then
  // re-renders rather than only committing.
  el('sel-grammar-item-type')?.addEventListener('change', () => {
    commitGrammarItemEditor()
    renderGrammarItemEditor()
  })

  const editor = el('grammar-item-editor')
  for (const input of editor?.querySelectorAll('input, textarea') ?? []) {
    const event = input.type === 'checkbox' ? 'change' : 'input'
    input.addEventListener(event, commitGrammarItemEditor)
  }
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
      applyAppearance()
    }
  })
}

function setupTheme() {
  initSystemTheme()
  el('btn-theme').addEventListener('click', () => {
    const html = document.documentElement
    const next = html.dataset.theme === 'dark' ? 'light' : 'dark'
    setThemeMode(next)
  })
}

/**
 * The theme the user chose, or 'system' when they have not chosen one.
 *
 * Kept in `mycompare:theme` rather than in the preferences object because the
 * inline script in index.html reads it before any module loads, to avoid a
 * flash of the wrong theme.
 *
 * @returns {'system'|'light'|'dark'}
 */
function getThemeMode() {
  const stored = localStorage.getItem('mycompare:theme')
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

/**
 * @param {'system'|'light'|'dark'} mode
 */
function setThemeMode(mode) {
  const html = document.documentElement
  if (mode === 'system') {
    localStorage.removeItem('mycompare:theme')
    html.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } else {
    localStorage.setItem('mycompare:theme', mode)
    html.dataset.theme = mode
  }
  // Colour overrides are stored per theme, so the switch has to re-apply them,
  // and the swatches in an open Options dialog now describe the other theme.
  applyAppearance()
  _refreshAppearanceControls()
}

/**
 * Re-reads the Colors & Fonts page. Replaced once that page is wired; the
 * no-op stands in until then and for tests that never open the dialog.
 * @type {() => void}
 */
let _refreshAppearanceControls = () => {}

// ---------------------------------------------------------------------------
// P2-34: user colours and fonts
// ---------------------------------------------------------------------------

/**
 * Push the stored colour and font overrides onto the document.
 *
 * Applied as inline custom properties on <html> so that clearing one simply
 * hands the token back to the stylesheet — there is no "default" value to
 * duplicate here and keep in step with variables.css.
 */
function applyAppearance() {
  const root = document.documentElement
  const { colors, fonts } = settings.getAppearance()
  const theme = root.dataset.theme === 'dark' ? 'dark' : 'light'
  const active = colors[theme] ?? {}

  for (const token of COLOR_TOKENS) {
    const value = active[token.key]
    if (value) root.style.setProperty(token.cssVar, value)
    else root.style.removeProperty(token.cssVar)
  }

  if (fonts.ui) root.style.setProperty('--ui-font-family', fonts.ui)
  else root.style.removeProperty('--ui-font-family')

  if (fonts.mono) root.style.setProperty('--mono-font-family', fonts.mono)
  else root.style.removeProperty('--mono-font-family')

  if (fonts.uiSize !== DEFAULT_FONTS.uiSize) {
    root.style.setProperty('--ui-font-size', `${fonts.uiSize}px`)
  } else {
    root.style.removeProperty('--ui-font-size')
  }
}

/**
 * Flip one of the Display page's visibility preferences from a menu command.
 *
 * @param {'showToolbar'|'showStatusBar'} pref
 * @param {string} label
 */
function _toggleChromePref(pref, label) {
  const next = settings.getPref(pref) === false
  settings.setPref(pref, next)
  applyDisplayPrefs()
  showStatus(`${label}：${next ? '顯示' : '隱藏'}`)
}

/** Show or hide the chrome the Display page controls. */
/**
 * Report whether the app is running as a portable install.
 *
 * Everything the renderer persists goes to localStorage, which Chromium keeps
 * inside `userData`; relocating that has to happen in the main process before
 * the app is ready, so the renderer can only ask and report. When the main
 * process does not answer, this says so plainly — showing "可攜式" because a
 * check could not run is exactly how a user would come to believe their
 * settings travel with the folder when they do not.
 */
async function refreshPortableState() {
  const state = el('txt-portable-state')
  const hint = el('portable-hint')
  if (!state || !hint) return

  const api = /** @type {Record<string, unknown> | undefined} */ (window.electronAPI)
  if (typeof api?.getPortableInfo !== 'function') {
    state.textContent = '不支援（一般安裝）'
    hint.textContent = '主程序尚未提供可攜式模式，設定仍存放在使用者資料夾。'
      + '在此之前，把設定帶到另一台機器的方式是上面的「匯出全部設定…」與「匯入設定…」。'
    return
  }

  try {
    const info = /** @type {{ portable?: boolean, dataDir?: string }} */ (
      await /** @type {() => Promise<unknown>} */ (api.getPortableInfo)())
    state.textContent = info?.portable ? '可攜式（設定隨程式目錄）' : '一般安裝'
    hint.textContent = info?.dataDir
      ? `設定存放位置：${info.dataDir}`
      : '主程序未回報設定存放位置。'
  } catch (err) {
    state.textContent = '（無法取得）'
    hint.textContent = ''
    showError(`無法讀取可攜式模式狀態：${err instanceof Error ? err.message : String(err)}`, err)
  }
}

function applyDisplayPrefs() {
  const toolbar = el('toolbar')
  if (toolbar) toolbar.style.display = settings.getPref('showToolbar') === false ? 'none' : ''
  const statusbar = el('statusbar')
  if (statusbar) statusbar.style.display = settings.getPref('showStatusBar') === false ? 'none' : ''
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
