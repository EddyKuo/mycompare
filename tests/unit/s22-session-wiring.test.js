/**
 * Sprint 22 — the wiring this round was supposed to add.
 *
 * Two kinds of check live here, for two different failure modes:
 *
 *  - Pure logic (file-type routing, parent folders) is exercised directly.
 *  - The renderer's wiring is asserted against app.js's source, the same way
 *    menu-wiring.test.js does. Nothing at runtime compares a view's public
 *    guard with the host that is supposed to call it, which is precisely how
 *    `confirmDiscardChanges()` came to exist for a whole sprint without a
 *    single caller. A behavioural test would need the whole Electron window;
 *    the e2e specs cover that side.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

import {
  getViewTypeForPath,
  getViewChoicesForPath,
  isAmbiguousPath,
  parentFolderOf,
} from '../../src/renderer/src/core/file-type.js'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const APP = read('../../src/renderer/src/app.js')
const HTML = read('../../src/renderer/index.html')

describe('Smart Routing — .html is not unambiguously text', () => {
  it('keeps text as the default so nothing regresses', () => {
    expect(getViewTypeForPath('index.html')).toBe('text')
    expect(getViewTypeForPath('page.HTM')).toBe('text')
  })

  it('offers both readings for html and htm', () => {
    expect(getViewChoicesForPath('index.html')).toEqual(['text', 'table'])
    expect(getViewChoicesForPath('C:\\site\\page.HTM')).toEqual(['text', 'table'])
    expect(isAmbiguousPath('index.html')).toBe(true)
  })

  it('offers both readings for a PE image, defaulting to hex as before', () => {
    // An .exe is honestly both a binary blob and a versioned resource, so the
    // metadata view has to be offered rather than silently skipped — but the
    // default must not change under anyone who was relying on hex.
    expect(getViewChoicesForPath('a.exe')).toEqual(['hex', 'metadata'])
    expect(getViewChoicesForPath('C:\win\a.DLL')).toEqual(['hex', 'metadata'])
    expect(isAmbiguousPath('a.exe')).toBe(true)
    expect(getViewTypeForPath('a.exe')).toBe('hex')
  })

  it('routes an MP3 to the metadata view, which is its only useful reading', () => {
    expect(getViewTypeForPath('song.mp3')).toBe('metadata')
    expect(isAmbiguousPath('song.mp3')).toBe(false)
  })

  it('leaves every unambiguous extension alone', () => {
    for (const p of ['a.txt', 'a.csv', 'a.png', 'a.zip', 'noext', '', null]) {
      expect(getViewChoicesForPath(p)).toEqual([])
      expect(isAmbiguousPath(p)).toBe(false)
    }
  })

  it('hands back a fresh array so a caller cannot corrupt the table', () => {
    const first = getViewChoicesForPath('a.html')
    first.push('hex')
    expect(getViewChoicesForPath('a.html')).toEqual(['text', 'table'])
  })

  it('routes the choice through the picker rather than guessing', () => {
    expect(APP).toMatch(/getViewChoicesForPath\(leftPath \|\| rightPath\)/)
    expect(APP).toMatch(/choices\.length > 1/)
  })
})

describe('parentFolderOf', () => {
  it('normalises separators', () => {
    expect(parentFolderOf('C:\\proj\\src\\a.txt')).toBe('C:/proj/src')
    expect(parentFolderOf('/home/me/a.txt')).toBe('/home/me')
  })

  it('keeps a drive root usable', () => {
    expect(parentFolderOf('C:/a.txt')).toBe('C:/')
    expect(parentFolderOf('D:\\a.txt')).toBe('D:/')
  })

  it('keeps the posix root usable', () => {
    expect(parentFolderOf('/a.txt')).toBe('/')
  })

  it('ignores a trailing separator', () => {
    expect(parentFolderOf('C:/proj/src/')).toBe('C:/proj')
  })

  it('returns empty when there is no parent to speak of', () => {
    expect(parentFolderOf('a.txt')).toBe('')
    expect(parentFolderOf('')).toBe('')
    expect(parentFolderOf(null)).toBe('')
  })
})

describe('closing a tab asks the view about unsaved work', () => {
  it('calls both views\' guards', () => {
    expect(APP).toMatch(/tableCompare\.confirmDiscardChanges\(\)/)
    expect(APP).toMatch(/hexCompare\.confirmClose\(\)/)
  })

  it('runs the guard before the tab is actually removed', () => {
    const guard = APP.indexOf('const guard = _confirmDiscardForTab(closing)')
    const close = APP.indexOf('const nextTab = tabMgr.closeTab(id)')
    expect(guard).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(guard)
    // A refusal must stop there, not fall through to the close.
    expect(APP.slice(guard, close)).toMatch(/if \(!guard\.ok\) return/)
  })

  it('does not stack a second, weaker confirmation on top of it', () => {
    expect(APP).toMatch(/if \(!guard\.asked && settings\.getPref\('confirmOnCloseTab'\)/)
  })

  it('guards the workspace load, which closes every tab at once', () => {
    const load = APP.indexOf('async function loadWorkspace')
    expect(load).toBeGreaterThan(-1)
    expect(APP.slice(load, load + 600)).toMatch(/_confirmDiscardAllTabs\(\)/)
  })
})

describe('named configs — reserved names stay out of the user\'s list', () => {
  it('uses the same prefix the folder view reserves', () => {
    const folder = read('../../src/renderer/src/views/folder-compare.js')
    const reserved = /FOLDER_DEFAULTS_NAME = '([^']+)'/.exec(folder)?.[1]
    expect(reserved).toBeTruthy()
    const prefix = /RESERVED_CONFIG_PREFIX = '([^']+)'/.exec(APP)?.[1]
    expect(prefix).toBe('__mycompare:')
    expect(reserved.startsWith(prefix)).toBe(true)
  })

  it('filters the list and refuses to save into the namespace', () => {
    expect(APP).toMatch(/\.filter\(\(entry\) => !isReservedConfigName\(entry\.name\)\)/)
    const save = APP.indexOf('function handleConfigSave')
    expect(APP.slice(save, save + 800)).toMatch(/isReservedConfigName\(name\)/)
  })
})

describe('hex and table print buttons reach the shared preview', () => {
  it('intercepts them in the capture phase on the view container', () => {
    const fn = APP.indexOf('function setupViewPrintInterception')
    expect(fn).toBeGreaterThan(-1)
    const body = APP.slice(fn, fn + 700)
    expect(body).toMatch(/'view-hex', 'view-table'/)
    expect(body).toMatch(/openPrintPreview\(\)/)
    // Without capture + stopPropagation the view's own handler still runs and
    // the second print window appears anyway.
    expect(body).toMatch(/e\.stopPropagation\(\)/)
    expect(body).toMatch(/\}, true\)/)
  })

  it('recognises both buttons as they are actually built', () => {
    const table = read('../../src/renderer/src/views/table-compare.js')
    const hex = read('../../src/renderer/src/views/hex-compare.js')
    expect(table).toMatch(/id: 'tc-btn-print'/)
    expect(hex).toMatch(/className: 'hx-btn-report'[^)]*'🖨 列印'/)
    expect(APP).toMatch(/btn\.id === 'tc-btn-print'/)
    expect(APP).toMatch(/hx-btn-report/)
  })

  it('is installed at start-up', () => {
    expect(APP).toMatch(/setupViewPrintInterception\(\)/)
  })
})

describe('BC Session menu commands', () => {
  const NEW_IDS = [
    'session.saveAs',
    'session.clear',
    'session.locked',
    'session.compareParentFolders',
    'session.compareUsing',
  ]

  it('each has a dispatch entry', () => {
    const handled = new Set(
      [...APP.matchAll(/'([a-z][\w-]*(?:\.[\w-]+)+)'\s*:/g)].map((m) => m[1]))
    expect(NEW_IDS.filter((id) => !handled.has(id))).toEqual([])
  })

  it('each reaches a real implementation, not a placeholder', () => {
    for (const name of ['saveSessionAs', 'clearSession', 'toggleSessionLock',
      'compareParentFolders', 'compareFilesUsing']) {
      expect(APP).toMatch(new RegExp(`function ${name}\\(`))
    }
  })

  it('reports failures instead of swallowing them', () => {
    const save = APP.indexOf('function saveSessionAs')
    expect(APP.slice(save, save + 1200)).toMatch(/showError\(`另存 Session 失敗/)
  })

  it('refuses paths that only exist inside this window', () => {
    const fn = APP.indexOf('function _activeTabPaths')
    expect(APP.slice(fn, fn + 900)).toMatch(/sourceKindOf\(p\) !== 'fs'/)
  })
})

describe('Locked', () => {
  it('blocks the commands that would reload or recompare', () => {
    expect(APP).toMatch(/isActiveTabLocked\('重新整理'\)/)
    expect(APP).toMatch(/isActiveTabLocked\('重新比對'\)/)
    expect(APP).toMatch(/isActiveTabLocked\('清空 Session'\)/)
  })

  it('is visible on the tab', () => {
    expect(APP).toMatch(/tab\.locked \? `🔒 \$\{tab\.title\}`/)
  })

  it('starts unlocked on every new tab', () => {
    expect(APP).toMatch(/state: null, locked: false/)
  })
})

describe('view picker markup', () => {
  it('exists and is wired to both cancel paths', () => {
    expect(HTML).toMatch(/id="view-picker-modal"/)
    expect(HTML).toMatch(/id="view-picker-list"/)
    expect(APP).toMatch(/btn-view-picker-close/)
    expect(APP).toMatch(/btn-view-picker-cancel/)
  })

  it('carries no inline handlers', () => {
    const modal = /id="view-picker-modal"[\s\S]*?<\/div>\s*<\/div>/.exec(HTML)?.[0] ?? ''
    expect(modal).not.toMatch(/onclick=/i)
  })

  it('settles the pending promise when it closes, so no caller hangs', () => {
    const fn = APP.indexOf('function _closeViewPicker')
    expect(APP.slice(fn, fn + 400)).toMatch(/resolve\?\.\(value\)/)
  })
})

describe('three-way merge hand-offs the view cannot service itself', () => {
  const MERGE3 = read('../../src/renderer/src/views/three-way-compare.js')

  it('subscribes to open-parent-folders, which is what enables the button', () => {
    // The view keeps that button disabled until someone subscribes, so an
    // unwired host leaves a permanently dead control.
    expect(MERGE3).toMatch(/_listeners\.get\('open-parent-folders'\)\?\.size/)
    expect(APP).toMatch(/mergeCompare\.on\('open-parent-folders'/)
  })

  it('chooses left vs right, and falls back to base rather than refusing', () => {
    const fn = APP.indexOf('async function openMergeParentFolders')
    expect(fn).toBeGreaterThan(-1)
    const body = APP.slice(fn, fn + 1200)
    expect(body).toMatch(/if \(left && right\)/)
    expect(body).toMatch(/else if \(left && base\)/)
    expect(body).toMatch(/else if \(base && right\)/)
    // Which pair was actually opened has to be stated.
    expect(body).toMatch(/showStatus\(`已開啟上層資料夾比對/)
    expect(body).toMatch(/showError\('比對上層資料夾/)
  })

  it('opens compare-to-output in a real text tab with no path on the output', () => {
    expect(APP).toMatch(/mergeCompare\.on\('compare-to-output'/)
    const fn = APP.indexOf('async function openMergeOutputCompare')
    expect(fn).toBeGreaterThan(-1)
    const body = APP.slice(fn, fn + 900)
    // A made-up path would make "save right" overwrite a file nobody opened.
    expect(body).toMatch(/rightPath: '',/)
    expect(body).toMatch(/rightContent: outputText/)
  })

  it('has dispatch entries for the merge and folder commands', () => {
    const handled = new Set(
      [...APP.matchAll(/'([a-z][\w-]*(?:\.[\w-]+)+)'\s*:/g)].map((m) => m[1]))
    for (const id of [
      'session.merge.parentFolders',
      'session.merge.compareOutput.left',
      'session.merge.compareOutput.base',
      'session.merge.compareOutput.right',
      'session.folder.info',
      'file.copyTo',
      'file.touch.leftToRight',
      'file.touch.rightToLeft',
      'view.image.info',
    ]) {
      expect(handled.has(id), `missing dispatch entry: ${id}`).toBe(true)
    }
  })

  it('calls the methods those views actually expose', () => {
    const folder = read('../../src/renderer/src/views/folder-compare.js')
    const image = read('../../src/renderer/src/views/image-compare.js')
    expect(folder).toMatch(/\n  openInfoDialog\(\)/)
    expect(folder).toMatch(/\n  async copySelectedToFolder\(/)
    expect(folder).toMatch(/\n  async touchSelected\(/)
    expect(image).toMatch(/\n  toggleInfoPanel\(/)
    expect(MERGE3).toMatch(/\n  mergeParentFolders\(\)/)
    expect(MERGE3).toMatch(/\n  compareToOutput\(/)
  })

  it('includes the image view in the layout toggle it now implements', () => {
    expect(APP).toMatch(/text: textCompare, table: tableCompare, image: imageCompare/)
  })
})

describe('table, image, hex and metadata tabs record their paths', () => {
  it('all four sync the active tab', () => {
    // Only text and folder did, so a saved workspace restored the others
    // blank and nothing could ask "which files is this tab showing?".
    // Call sites only — the declaration line starts with `function`.
    const occurrences = [...APP.matchAll(/^\s+_syncActiveTabPaths\(left, right\)$/gm)]
    expect(occurrences.length).toBe(4)
  })
})
