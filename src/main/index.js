import { app, BrowserWindow, Menu, ipcMain, dialog, shell } from 'electron'
import { join, extname, dirname } from 'path'
import { readFile, readdir, stat, copyFile, unlink, mkdir, writeFile, rename } from 'fs/promises'
import { watch } from 'fs'
import { decodeBuffer } from './encoding.js'
import { registerRoot, validatePath, validatePathPair } from './path-validator.js'

// ── T33 (S12-W): File Watcher — capped to avoid resource exhaustion ──
const MAX_WATCHERS = 64
/** @type {Map<string, import('fs').FSWatcher>} */
const _fileWatchers = new Map()

/**
 * 解析 CLI 參數，回傳非 flag 的檔案路徑（最多兩個）。
 * @param {string[]} argv - process.argv
 * @returns {string[]}
 */
export function parseCliArgs(argv) {
  return argv.slice(2).filter(a => !a.startsWith('--')).slice(0, 2)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // S12-S03 NOTE: `sandbox: true` regressed file dialogs on Electron 33
      // (showOpenDialog returned to a hung promise with no error). Reverted
      // to default (false) — the renderer still has contextIsolation,
      // nodeIntegration:false, CSP, will-navigate guards, and IPC path
      // validation, which together cover the threat model.
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    title: 'MyCompare',
    show: false
  })

  win.once('ready-to-show', () => win.show())

  // S12-debug: 允許 Ctrl+Shift+I 開關 DevTools，方便在 production 看 console。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.control && input.shift && (input.key === 'I' || input.key === 'i')) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    } else if (input.key === 'F12') {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  // S12-S02: Deny new-window creation; route external links through OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })

  // S12-S02: Refuse navigation to anything other than our renderer.
  win.webContents.on('will-navigate', (event, url) => {
    const allowedDev = process.env['ELECTRON_RENDERER_URL']
    const isDev = allowedDev && url === allowedDev
    const isFile = url.startsWith('file://')
    if (!isDev && !isFile) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {})
      }
    }
  })

  // S12-W: Close all file watchers owned by this window when it goes away.
  win.on('closed', () => {
    for (const w of _fileWatchers.values()) {
      try { w.close() } catch { /* ignore */ }
    }
    _fileWatchers.clear()
  })

  if (process.env.NODE_ENV === 'development') {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)

  const win = createWindow()
  const cliFiles = parseCliArgs(process.argv)
  // S12-S01: CLI args are user-trusted — register them as allowed roots.
  for (const f of cliFiles) registerRoot(f)
  if (cliFiles.length >= 1) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('open-files', {
        left: cliFiles[0] ?? '',
        right: cliFiles[1] ?? ''
      })
    })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ---------------------------------------------------------------------------
// IPC handlers — every handler that accepts a renderer-supplied path passes
// it through validatePath(). Paths produced by trusted dialogs are first
// registered as allowed roots via registerRoot().
// ---------------------------------------------------------------------------

// IPC: 開啟檔案對話框並讀取檔案（自動偵測編碼）
ipcMain.handle('open-file', async (event, options = {}) => {
  const dialogOptions = { properties: ['openFile'] }
  if (options.filters) dialogOptions.filters = options.filters
  const win = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePaths } = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  if (canceled || !filePaths.length) return null
  registerRoot(filePaths[0])
  const buffer = await readFile(filePaths[0])
  const { content, encoding } = decodeBuffer(buffer)
  return { path: filePaths[0], content, encoding }
})

// IPC: 開啟資料夾
ipcMain.handle('open-folder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = { properties: ['openDirectory'] }
  const { canceled, filePaths } = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts)
  if (canceled || !filePaths.length) return null
  registerRoot(filePaths[0])
  return { path: filePaths[0] }
})

// IPC: 讀取指定路徑的檔案內容（自動偵測編碼）
ipcMain.handle('read-file', async (_event, filePath) => {
  const safe = validatePath(filePath)
  const buffer = await readFile(safe)
  const { content, encoding } = decodeBuffer(buffer)
  return { path: safe, content, encoding }
})

// IPC: 開啟檔案對話框並讀取二進位（base64）
ipcMain.handle('open-file-binary', async (event, options = {}) => {
  const { filters } = options
  const dialogOptions = { properties: ['openFile'] }
  if (filters) dialogOptions.filters = filters
  const win = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePaths } = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  if (canceled || !filePaths.length) return null
  registerRoot(filePaths[0])
  const buffer = await readFile(filePaths[0])
  return {
    path: filePaths[0],
    base64: buffer.toString('base64'),
    size: buffer.length,
    ext: extname(filePaths[0]).slice(1).toLowerCase()
  }
})

// IPC: 讀取指定路徑的二進位檔案（base64）
ipcMain.handle('read-file-binary', async (_event, filePath) => {
  const safe = validatePath(filePath)
  const buffer = await readFile(safe)
  return {
    path: safe,
    base64: buffer.toString('base64'),
    size: buffer.length,
    ext: extname(safe).slice(1).toLowerCase()
  }
})

// IPC: 在作業系統檔案總管中顯示檔案位置
ipcMain.handle('show-in-explorer', (_event, filePath) => {
  const safe = validatePath(filePath)
  shell.showItemInFolder(safe)
})

// IPC: 複製檔案（自動建立目的資料夾）
ipcMain.handle('copy-file', async (_event, { src, dest }) => {
  const { src: safeSrc, dest: safeDest } = validatePathPair(src, dest)
  await mkdir(dirname(safeDest), { recursive: true })
  await copyFile(safeSrc, safeDest)
})

// IPC: 刪除檔案
ipcMain.handle('delete-file', async (_event, filePath) => {
  const safe = validatePath(filePath)
  await unlink(safe)
})

// IPC: 儲存檔案（顯示 Save 對話框）
ipcMain.handle('save-file', async (event, { defaultPath, content, filters }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = {
    defaultPath,
    filters: filters ?? [{ name: 'HTML', extensions: ['html'] }, { name: '所有檔案', extensions: ['*'] }],
  }
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts)
  if (canceled || !filePath) return false
  registerRoot(filePath)
  await writeFile(filePath, content, 'utf-8')
  return true
})

// IPC: 開啟 Zip 檔案並回傳虛擬目錄項目清單
ipcMain.handle('open-zip', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = {
    properties: ['openFile'],
    filters: [{ name: 'Zip 檔案', extensions: ['zip'] }, { name: '所有檔案', extensions: ['*'] }],
  }
  const { canceled, filePaths } = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts)
  if (canceled || !filePaths.length) return null

  const zipPath = filePaths[0]
  registerRoot(zipPath)
  const JSZip = (await import('jszip')).default
  const buffer = await readFile(zipPath)
  const zip = await JSZip.loadAsync(buffer)

  const entries = []
  zip.forEach((relativePath, file) => {
    const parts = relativePath.replace(/\/$/, '').split('/')
    const name = parts[parts.length - 1]
    if (!name) return
    entries.push({
      name,
      path: `${zipPath}::${relativePath}`,
      isDirectory: file.dir,
      size: file._data?.uncompressedSize ?? 0,
      mtime: (file.date ?? new Date()).toISOString(),
      zipPath,
      zipEntry: relativePath,
      depth: parts.length - 1,
      parentPath: parts.length > 1 ? `${zipPath}::${parts.slice(0, -1).join('/')}/` : zipPath,
    })
  })

  return { zipPath, entries }
})

// IPC: 讀取資料夾內容（一層）
ipcMain.handle('read-dir', async (_event, dirPath) => {
  const safe = validatePath(dirPath)
  const entries = await readdir(safe, { withFileTypes: true })
  const result = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(safe, entry.name)
      try {
        const s = await stat(fullPath)
        return {
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          size: s.size,
          mtime: s.mtime.toISOString()
        }
      } catch {
        // Permission denied / broken symlink — skip
        return null
      }
    })
  )
  return result.filter(Boolean)
})

// IPC: 計算檔案 MD5 hash
ipcMain.handle('hash-file', async (_event, filePath) => {
  const safe = validatePath(filePath)
  const { computeMd5 } = await import('./file-hash.js')
  const buffer = await readFile(safe)
  return computeMd5(buffer)
})

// IPC: T33 — 監視檔案變更（fs.watch，callback-based，非 promises）
ipcMain.handle('watch-file', (event, filePath) => {
  const safe = validatePath(filePath)
  if (_fileWatchers.has(safe)) return
  if (_fileWatchers.size >= MAX_WATCHERS) {
    throw new Error(`Watcher limit reached (${MAX_WATCHERS})`)
  }
  const watcher = watch(safe, { persistent: false }, () => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('file-changed', { path: safe })
    }
  })
  watcher.on('error', () => {
    _fileWatchers.delete(safe)
  })
  _fileWatchers.set(safe, watcher)
})

// IPC: T33 — 停止監視檔案
ipcMain.handle('unwatch-file', (_event, filePath) => {
  // Don't validate here — even if validation would fail (e.g. file deleted),
  // we still want to release the watcher entry.
  if (typeof filePath !== 'string') return
  _fileWatchers.get(filePath)?.close()
  _fileWatchers.delete(filePath)
})

// IPC: T52 — 重新命名檔案或資料夾
ipcMain.handle('rename-file', async (_e, oldPath, newPath) => {
  const { src: safeOld, dest: safeNew } = validatePathPair(oldPath, newPath)
  await rename(safeOld, safeNew)
})

// IPC: T53 — 建立資料夾（遞迴）
ipcMain.handle('mkdir-folder', async (_e, dirPath) => {
  const safe = validatePath(dirPath)
  await mkdir(safe, { recursive: true })
})

// IPC: T60 — 切換全螢幕模式
ipcMain.handle('toggle-fullscreen', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return false
  const next = !win.isFullScreen()
  win.setFullScreen(next)
  return next
})

// IPC: 讀取 Excel (.xlsx/.xls) 並回傳每個工作表的 CSV 字串
ipcMain.handle('read-excel', async (_event, filePath) => {
  const safe = validatePath(filePath)
  const XLSX = await import('xlsx')
  const buffer = await readFile(safe)            // S12-S05: async, not readFileSync
  const workbook = XLSX.read(buffer)
  /** @type {Record<string, string>} */
  const sheets = {}
  for (const sheetName of workbook.SheetNames) {
    sheets[sheetName] = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])
  }
  return { sheets, sheetNames: workbook.SheetNames }
})
