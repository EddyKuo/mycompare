import { app, BrowserWindow, Menu, ipcMain, dialog, shell } from 'electron'
import { join, extname, dirname } from 'path'
import { readFile, readdir, stat, copyFile, unlink, mkdir, writeFile, rename } from 'fs/promises'
import { readFileSync, watch } from 'fs'
import { decodeBuffer } from './encoding.js'

// ── T33: File Watcher ──
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
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'MyCompare',
    show: false
  })

  win.once('ready-to-show', () => win.show())

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

// IPC: 開啟檔案對話框並讀取檔案（自動偵測編碼）
ipcMain.handle('open-file', async (_event, options = {}) => {
  const dialogOptions = { properties: ['openFile'] }
  if (options.filters) dialogOptions.filters = options.filters
  const { canceled, filePaths } = await dialog.showOpenDialog(dialogOptions)
  if (canceled || !filePaths.length) return null
  const buffer = await readFile(filePaths[0])
  const { content, encoding } = decodeBuffer(buffer)
  return { path: filePaths[0], content, encoding }
})

// IPC: 開啟資料夾
ipcMain.handle('open-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (canceled || !filePaths.length) return null
  return { path: filePaths[0] }
})

// IPC: 讀取指定路徑的檔案內容（自動偵測編碼）
ipcMain.handle('read-file', async (_event, filePath) => {
  const buffer = await readFile(filePath)
  const { content, encoding } = decodeBuffer(buffer)
  return { path: filePath, content, encoding }
})

// IPC: 開啟檔案對話框並讀取二進位（base64）
ipcMain.handle('open-file-binary', async (_event, options = {}) => {
  const { filters } = options
  const dialogOptions = { properties: ['openFile'] }
  if (filters) dialogOptions.filters = filters
  const { canceled, filePaths } = await dialog.showOpenDialog(dialogOptions)
  if (canceled || !filePaths.length) return null
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
  const buffer = await readFile(filePath)
  return {
    path: filePath,
    base64: buffer.toString('base64'),
    size: buffer.length,
    ext: extname(filePath).slice(1).toLowerCase()
  }
})

// IPC: 在作業系統檔案總管中顯示檔案位置
ipcMain.handle('show-in-explorer', (_event, filePath) => {
  shell.showItemInFolder(filePath)
})

// IPC: 複製檔案（自動建立目的資料夾）
ipcMain.handle('copy-file', async (_event, { src, dest }) => {
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest)
})

// IPC: 刪除檔案
ipcMain.handle('delete-file', async (_event, filePath) => {
  await unlink(filePath)
})

// IPC: 儲存檔案（顯示 Save 對話框）
ipcMain.handle('save-file', async (_event, { defaultPath, content, filters }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath,
    filters: filters ?? [{ name: 'HTML', extensions: ['html'] }, { name: '所有檔案', extensions: ['*'] }]
  })
  if (canceled || !filePath) return false
  await writeFile(filePath, content, 'utf-8')
  return true
})

// IPC: 開啟 Zip 檔案並回傳虛擬目錄項目清單（扁平，含目錄結構）
ipcMain.handle('open-zip', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Zip 檔案', extensions: ['zip'] }, { name: '所有檔案', extensions: ['*'] }]
  })
  if (canceled || !filePaths.length) return null

  const zipPath = filePaths[0]
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
  const entries = await readdir(dirPath, { withFileTypes: true })
  const result = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dirPath, entry.name)
      const s = await stat(fullPath)
      return {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        size: s.size,
        mtime: s.mtime.toISOString()
      }
    })
  )
  return result
})

// IPC: 計算檔案 MD5 hash
ipcMain.handle('hash-file', async (_event, filePath) => {
  const { computeMd5 } = await import('./file-hash.js')
  const buffer = await readFile(filePath)
  return computeMd5(buffer)
})

// IPC: T33 — 監視檔案變更（fs.watch，callback-based，非 promises）
ipcMain.handle('watch-file', (event, filePath) => {
  if (_fileWatchers.has(filePath)) return
  const watcher = watch(filePath, { persistent: false }, () => {
    event.sender.send('file-changed', { path: filePath })
  })
  watcher.on('error', () => {
    _fileWatchers.delete(filePath)
  })
  _fileWatchers.set(filePath, watcher)
})

// IPC: T33 — 停止監視檔案
ipcMain.handle('unwatch-file', (_event, filePath) => {
  _fileWatchers.get(filePath)?.close()
  _fileWatchers.delete(filePath)
})

// IPC: T52 — 重新命名檔案或資料夾
ipcMain.handle('rename-file', async (_e, oldPath, newPath) => {
  await rename(oldPath, newPath)
})

// IPC: T53 — 建立資料夾（遞迴）
ipcMain.handle('mkdir-folder', async (_e, dirPath) => {
  await mkdir(dirPath, { recursive: true })
})

// IPC: 讀取 Excel (.xlsx/.xls) 並回傳每個工作表的 CSV 字串
ipcMain.handle('read-excel', async (_event, filePath) => {
  try {
    const XLSX = await import('xlsx')
    const workbook = XLSX.read(readFileSync(filePath))
    /** @type {Record<string, string>} */
    const sheets = {}
    for (const sheetName of workbook.SheetNames) {
      sheets[sheetName] = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])
    }
    return { sheets, sheetNames: workbook.SheetNames }
  } catch (err) {
    return { error: err.message }
  }
})
