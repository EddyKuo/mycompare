import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron'
import { join, extname, dirname, basename } from 'path'
import { readFile, readdir, stat, copyFile, unlink, mkdir, writeFile, rename, open, chmod, utimes, rm } from 'fs/promises'
import { watch, existsSync, mkdirSync, accessSync, constants as fsConstants } from 'fs'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import { decodeBuffer, encodeContent } from './encoding.js'
import { registerRoot, validatePath, validatePathPair } from './path-validator.js'
import { buildOpenWithArgs } from './open-with.js'
import { buildAppMenu } from './menu.js'
import { parseCli, usageText } from './cli.js'
import { parseScript, describeScript, isMutating } from './script.js'
import { runScript } from './script-runner.js'
import { writeSnapshot, readSnapshot, snapshotLevel } from './snapshot.js'
import { readArchive, readArchiveEntry } from './archive.js'
import { registerRemoteIpc } from './remote-ipc.js'
import { backupFile, normaliseBackupOptions } from './backup.js'

// ── T33 (S12-W): File Watcher — capped to avoid resource exhaustion ──
const MAX_WATCHERS = 64
/** @type {Map<string, import('fs').FSWatcher>} */
const _fileWatchers = new Map()

// Re-exported so existing callers and tests keep the same import site.
export { parseCliArgs } from './cli.js'

/**
 * Parse and run a script file.
 *
 * Running is opt-in. A script reaches this function from a build hook or a
 * VCS trigger, where nobody is watching and the working directory is whatever
 * the caller happened to be in; defaulting to a dry run means the first
 * mistake costs a wasted invocation instead of a tree of files. `/execute`
 * is the point at which the operator states they have read the plan.
 *
 * @param {string} scriptPath
 * @param {boolean} [execute]
 * @returns {Promise<number>} process exit code
 */
async function runScriptFile(scriptPath, execute = false) {
  let source
  try {
    source = await readFile(scriptPath, 'utf-8')
  } catch (err) {
    process.stderr.write(`無法讀取腳本 ${scriptPath}：${err.message}\n`)
    return 2
  }

  const { commands, errors } = parseScript(source)
  if (errors.length) {
    for (const e of errors) {
      process.stderr.write(`${scriptPath}:${e.line}: ${e.message}\n`)
    }
    return 1
  }

  process.stdout.write(`${scriptPath} — ${commands.length} 個指令，語法正確\n`)
  process.stdout.write(`${describeScript(commands)}\n\n`)

  const result = await runScript(commands, {
    execute,
    validatePath,
    registerRoot,
    out: (line) => process.stdout.write(`${line}\n`),
  })

  if (!result.ok) {
    for (const e of result.errors) {
      process.stderr.write(`${scriptPath}:${e.line}: ${e.message}\n`)
    }
    return 1
  }
  if (!execute && isMutating(commands)) {
    process.stdout.write('\n提示：這是預演。確認上述操作無誤後，加上 /execute 重新執行。\n')
  }
  return 0
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

  // A renderer that cancels beforeunload makes the window unclosable unless
  // main answers this event — the window would simply refuse to close with no
  // dialog and no explanation. So the renderer may only raise the question;
  // the decision is taken here, and defaults to staying open.
  win.webContents.on('will-prevent-unload', (event) => {
    const { response } = dialog.showMessageBoxSync
      ? { response: dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['取消', '放棄變更並關閉'],
        defaultId: 0,
        cancelId: 0,
        title: '尚有未儲存的變更',
        message: '有編輯過的內容還沒有儲存。',
        detail: '關閉後這些變更就會遺失。',
      }) }
      : { response: 0 }
    if (response === 1) event.preventDefault() // proceed with the unload
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

/**
 * Where settings live, and whether this is a portable install.
 *
 * A portable copy keeps its data beside the executable so the whole thing can
 * live on a stick. That is opt-in via a marker file rather than a build flag,
 * so one download serves both; and it is decided before `whenReady`, because
 * everything after that point reads userData.
 *
 * Falls back to the normal location when the marker is there but the directory
 * cannot be written — a portable install on read-only media should still run,
 * not fail at startup with settings it cannot save.
 *
 * @returns {{portable: boolean, dataDir: string, reason: string}}
 */
function configurePortableMode() {
  const beside = dirname(app.getPath('exe'))
  const marker = join(beside, 'portable.txt')
  if (!existsSync(marker)) {
    return { portable: false, dataDir: app.getPath('userData'), reason: '' }
  }
  const dataDir = join(beside, 'mycompare-data')
  try {
    mkdirSync(dataDir, { recursive: true })
    accessSync(dataDir, fsConstants.W_OK)
  } catch (err) {
    return {
      portable: false,
      dataDir: app.getPath('userData'),
      reason: `找到 portable.txt，但無法寫入 ${dataDir}：${err instanceof Error ? err.message : err}`,
    }
  }
  app.setPath('userData', dataDir)
  return { portable: true, dataDir, reason: '' }
}

/**
 * Resolved once, at startup.
 *
 * Deliberately not computed at module load: this file is imported by tests for
 * its re-exports, where Electron's `app` is not a working object. A top-level
 * call made the whole module unimportable.
 *
 * @type {{portable: boolean, dataDir: string, reason: string}|null}
 */
let portableInfo = null

// IPC: 這是不是可攜式安裝，設定存在哪裡
ipcMain.handle('get-portable-info', () => portableInfo
  ?? { portable: false, dataDir: '', reason: '尚未初始化' })

app.whenReady().then(async () => {
  // Before anything reads userData. setPath is legal this early, and every
  // consumer below resolves the path lazily.
  portableInfo = configurePortableMode()
  const cli = parseCli(process.argv)

  // Help must not open a window: the point of asking for it is usually that
  // the invocation was wrong.
  if (cli.switches.help) {
    process.stdout.write(`${usageText()}\n`)
    app.quit()
    return
  }

  if (typeof cli.switches.script === 'string') {
    const code = await runScriptFile(cli.switches.script, cli.switches.execute === true)
    app.exit(code)
    return
  }

  const win = createWindow()
  buildAppMenu(win)

  // Remote support is registered but dormant: nothing here connects until a
  // profile exists and the renderer asks for it.
  registerRemoteIpc({
    ipcMain,
    userDataPath: () => app.getPath('userData'),
    fs: { readFile, writeFile, mkdir },
    crypto: safeStorage,
    // An unrecognised SSH host key is a decision only the user can make, and
    // it has to be made before the password is sent. Defaulting to "cancel"
    // means a mis-click refuses rather than trusts.
    onUnknownHostKey: async ({ fingerprint, keyType }) => {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['取消', '信任並繼續'],
        defaultId: 0,
        cancelId: 0,
        title: '無法辨識的主機金鑰',
        message: '這台伺服器的金鑰過去沒有見過。',
        detail: `金鑰類型：${keyType}\n指紋：${fingerprint}\n\n`
          + '請先用其他管道核對這串指紋。若不核對就繼續，無法分辨對方是伺服器本人還是中間人。',
      })
      return response === 1
    },
  })

  const cliFiles = cli.paths
  // S12-S01: CLI args are user-trusted — register them as allowed roots.
  for (const f of cliFiles) registerRoot(f)
  if (cliFiles.length >= 1) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('open-files', {
        left: cliFiles[0] ?? '',
        right: cliFiles[1] ?? '',
        base: cliFiles[2] ?? '',
        output: cliFiles[3] ?? '',
        options: cli.switches
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

/**
 * IPC: accept paths the user dropped onto the window.
 *
 * A drop is a user gesture that names specific files, exactly like picking
 * them in a dialog or passing them on the command line, both of which already
 * call registerRoot. Without this the renderer could see the dropped path but
 * every subsequent read failed validation — which is why drag-and-drop onto
 * the text panes never actually worked.
 *
 * Only the dropped entries are registered; nothing else is widened.
 */
ipcMain.handle('accept-dropped-paths', async (_event, paths) => {
  if (!Array.isArray(paths)) return []
  const out = []
  for (const p of paths.slice(0, 8)) {
    if (typeof p !== 'string' || !p) continue
    try {
      const info = await stat(p)
      registerRoot(p)
      out.push({ path: p, isDirectory: info.isDirectory() })
    } catch {
      // Vanished or unreadable between drop and handling — skip it.
    }
  }
  return out
})

// IPC: 讀取指定路徑的檔案內容（自動偵測編碼）
ipcMain.handle('read-file', async (_event, filePath, forcedEncoding) => {
  const safe = validatePath(filePath)
  const buffer = await readFile(safe)
  const { content, encoding, detected, confidence, hasBom } =
    decodeBuffer(buffer, forcedEncoding)
  // confidence travels so the view can mark a guess as a guess: a short
  // non-UTF-8 sample is genuinely ambiguous, and the honest response is to
  // point the user at the manual override rather than assert a label.
  return { path: safe, content, encoding, detected, confidence, hasBom }
})

/**
 * Hard ceiling for a single binary IPC payload. Renderer views truncate too,
 * but doing it here keeps the main process from reading — and base64-encoding,
 * which costs another 1.33x — a multi-hundred-MB file it is about to discard.
 */
const MAX_BINARY_BYTES = 10_485_760 // 10 MB

/**
 * Read at most `maxBytes` from a file, reporting the true on-disk size so the
 * renderer can still show an accurate "truncated" warning.
 *
 * @param {string} safePath  already validated by validatePath()
 * @param {number} maxBytes
 * @returns {Promise<{ base64: string, size: number, truncated: boolean }>}
 */
async function readBinaryBounded(safePath, requested = MAX_BINARY_BYTES) {
  // The caller asks for a ceiling; it does not get to raise the one set here.
  // Taking the requested value at face value lets a renderer pass a huge
  // number and have the main process read and base64-encode an arbitrarily
  // large file — the limit exists to bound memory, so it cannot be an opt-in.
  const maxBytes = Math.min(
    typeof requested === 'number' && requested > 0 ? requested : MAX_BINARY_BYTES,
    MAX_BINARY_BYTES)
  const info = await stat(safePath)
  if (info.size <= maxBytes) {
    const buffer = await readFile(safePath)
    return { base64: buffer.toString('base64'), size: buffer.length, truncated: false }
  }
  const handle = await open(safePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return {
      base64: buffer.subarray(0, bytesRead).toString('base64'),
      size: info.size,
      truncated: true
    }
  } finally {
    await handle.close()
  }
}

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
  const { base64, size, truncated } = await readBinaryBounded(filePaths[0], options.maxBytes)
  return {
    path: filePaths[0],
    base64,
    size,
    truncated,
    ext: extname(filePaths[0]).slice(1).toLowerCase()
  }
})

// IPC: 讀取指定路徑的二進位檔案（base64）
ipcMain.handle('read-file-binary', async (_event, filePath, maxBytes) => {
  const safe = validatePath(filePath)
  const { base64, size, truncated } = await readBinaryBounded(safe, maxBytes)
  return {
    path: safe,
    base64,
    size,
    truncated,
    ext: extname(safe).slice(1).toLowerCase()
  }
})

// IPC: 在作業系統檔案總管中顯示檔案位置
ipcMain.handle('show-in-explorer', (_event, filePath) => {
  const safe = validatePath(filePath)
  shell.showItemInFolder(safe)
})

// IPC: 複製檔案（自動建立目的資料夾）
ipcMain.handle('copy-file', async (_event, { src, dest, backup }) => {
  const { src: safeSrc, dest: safeDest } = validatePathPair(src, dest)
  // Copying over an existing file destroys it just as surely as saving over
  // it does, and a folder sync does it in bulk without the user looking at
  // each one — so the backup applies here at least as much as on save.
  const backupResult = await backupExisting(safeDest, backup)
  await mkdir(dirname(safeDest), { recursive: true })
  await copyFile(safeSrc, safeDest)
  return { copied: true, path: safeDest, backup: backupResult }
})

// IPC: 刪除檔案
ipcMain.handle('delete-file', async (_event, filePath, options) => {
  const safe = validatePath(filePath)
  // The recycle bin is the default because a folder comparison deletes in
  // bulk, from a list the user skimmed. unlink() on the wrong side of a
  // two-pane view has no undo; the bin does.
  if (options?.permanent !== true) {
    try {
      await shell.trashItem(safe)
      return { deleted: true, path: safe, permanent: false }
    } catch (err) {
      // No bin on this platform or filesystem (a network share, a container).
      // Falling through silently would delete permanently while the user
      // believed otherwise, so say which one happened.
      if (options?.fallbackToPermanent !== true) {
        throw new Error(`無法移至資源回收桶：${err instanceof Error ? err.message : err}`)
      }
    }
  }
  await unlink(safe)
  return { deleted: true, path: safe, permanent: true }
})

// IPC: 儲存檔案（顯示 Save 對話框）
ipcMain.handle('save-file', async (event, { defaultPath, content, filters, encoding, backup }) => {
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
  const backupResult = await backupExisting(filePath, backup)
  // Write back in the file's original encoding, not unconditionally UTF-8.
  await writeFile(filePath, encodeContent(content, encoding))
  // The caller decides what to do about a failed backup; hiding it would let
  // the user believe a previous version was kept when none was.
  return { saved: true, path: filePath, backup: backupResult }
})

/**
 * Keep a copy of a file that is about to be overwritten.
 *
 * Saving replaces the user's file in place with no way back; Beyond Compare
 * keeps a backup for the same reason. A failure here must not block the save
 * itself — losing the backup is better than refusing to write.
 *
 * @param {string} filePath already registered as an allowed root
 * @returns {Promise<void>}
 */
async function backupExisting(filePath, backup) {
  const options = normaliseBackupOptions(backup)
  // A custom backup folder is a renderer-supplied path, so it has to clear the
  // allow-list like any other write target — otherwise "where to keep backups"
  // becomes a way to write a copy of the file anywhere on disk.
  if (options.folder) {
    try {
      options.folder = validatePath(options.folder)
    } catch (err) {
      console.error('[save-file] backup folder rejected:', err)
      return { backedUp: false, path: null, reason: 'folder-not-allowed' }
    }
  }
  const result = await backupFile(filePath, options, { stat, copyFile, mkdir })
  if (!result.backedUp && result.reason && result.reason !== 'absent'
      && result.reason !== 'disabled') {
    console.error('[save-file] backup failed:', result.reason)
  }
  return result
}

// IPC: 讀取壓縮檔目錄（tar / gzip / tar.gz / zip 家族），回傳統一形狀
/**
 * Archive preferences pushed from the renderer.
 *
 * `enabled` is the set of formats the user wants treated as archives; a format
 * left out is refused by name rather than opened, so turning one off is
 * visible instead of looking like an empty folder. `maxEntryMB` is 0 when the
 * user has not set it, in which case the decoder's own default stands.
 *
 * @type {{ enabled: Set<string>, maxEntryMB: number }}
 */
let archivePrefs = { enabled: new Set(), maxEntryMB: 0 }

ipcMain.handle('set-archive-limits', (_event, enabled, maxEntryMB) => {
  archivePrefs = {
    enabled: new Set(String(enabled ?? '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    maxEntryMB: Number.isFinite(maxEntryMB) && maxEntryMB > 0 ? Number(maxEntryMB) : 0,
  }
  return { enabled: [...archivePrefs.enabled], maxEntryMB: archivePrefs.maxEntryMB }
})

/**
 * The limits override for one archive call, or `{}` to keep the defaults.
 * @returns {{ maxEntryBytes?: number }}
 */
function archiveLimitOverride() {
  return archivePrefs.maxEntryMB > 0
    ? { maxEntryBytes: archivePrefs.maxEntryMB * 1024 * 1024 }
    : {}
}

/**
 * The preference tokens that enable a detected format.
 *
 * `detectFormat` answers with decoder names (`gzip`, `bzip2`), while the
 * preference is spelled with the extensions a user recognises (`gz`, `bz2`).
 * Matching the two by string equality, or by taking the part after the last
 * dot, silently refused every plain `.gz` and `.bz2` archive while the list
 * appeared to allow them.
 *
 * A compound format is enabled by either half, so `tar.gz` opens for someone
 * who listed `tar` or `gz`.
 *
 * @param {string} format
 * @returns {string[]}
 */
function ARCHIVE_PREF_TOKENS(format) {
  /** @type {Record<string, string[]>} */
  const alias = {
    gzip: ['gz', 'gzip'],
    bzip2: ['bz2', 'bzip2'],
    'tar.gz': ['tar', 'gz', 'gzip'],
    'tar.bz2': ['tar', 'bz2', 'bzip2'],
    'tar.xz': ['tar', 'xz'],
  }
  return alias[format] ?? [format]
}

/**
 * Refuse a format the user has switched off, before anything is decoded.
 *
 * An empty set means the preference has not been pushed yet (the very first
 * open can race the renderer's startup), and refusing everything in that case
 * would break archive support outright.
 *
 * @param {string} filePath
 */
async function assertArchiveFormatEnabled(filePath) {
  if (archivePrefs.enabled.size === 0) return
  const { detectFormat } = await import('./archive.js')
  const handle = await open(filePath, 'r')
  try {
    const head = Buffer.alloc(64)
    const { bytesRead } = await handle.read(head, 0, 64, 0)
    const format = String(detectFormat(filePath, head.subarray(0, bytesRead)))
    if (!ARCHIVE_PREF_TOKENS(format).some((t) => archivePrefs.enabled.has(t))) {
      throw new Error(`「${format}」已在選項中停用，因此不以壓縮檔開啟。`)
    }
  } finally {
    await handle.close()
  }
}

ipcMain.handle('read-archive', async (_event, archivePath) => {
  const safe = validatePath(archivePath)
  await assertArchiveFormatEnabled(safe)
  return readArchive(safe, archiveLimitOverride())
})

// IPC: 讀取壓縮檔內單一 entry 的內容
//
// entryPath 不經過 validatePath()：它是壓縮檔內部的相對路徑，不是檔案系統
// 路徑，且 validatePath() 會拒絕含 "::" 的字串。穿越防護由 archive.js 的
// sanitizeEntryPath() 負責。
ipcMain.handle('read-archive-entry', async (_event, { archivePath, entryPath }) => {
  const safe = validatePath(archivePath)
  await assertArchiveFormatEnabled(safe)
  const buffer = await readArchiveEntry(safe, entryPath, archiveLimitOverride())
  return buffer.toString('base64')
})

/**
 * Attribute flags for a directory entry.
 *
 * Folder compare offers an Attributes column that could previously only report
 * "directory" and "symlink", because this handler returned nothing else.
 *
 * Read-only is derivable everywhere: Windows maps the read-only attribute onto
 * the mode's write bits, and on Unix the owner-write bit is the direct
 * equivalent. Hidden and system are not — Node's Stats carries no attribute
 * bits on any platform, so on Windows they would need a native call this app
 * does not make. `hidden` is therefore reported only where the dot convention
 * genuinely defines it, and left null elsewhere rather than guessed, so the UI
 * can distinguish "not hidden" from "cannot tell".
 *
 * @param {string} name
 * @param {import('fs').Stats} s
 * @returns {{ readOnly: boolean, hidden: boolean|null }}
 */
function fileAttributes(name, s) {
  return {
    readOnly: (s.mode & 0o200) === 0,
    hidden: process.platform === 'win32' ? null : name.startsWith('.'),
  }
}

/**
 * Windows file attributes for one directory, keyed by name.
 *
 * Node's Stats has no attribute bits on any platform, so the only way to read
 * this is to ask the OS. `attrib` answers for a whole directory in one process
 * — per-file would be unusable on a tree — and takes its argument through
 * execFile, so a directory name containing `&` stays a name.
 *
 * The path is located by searching for the directory we asked about rather
 * than by column offset, since the flag field's width is an implementation
 * detail of attrib's output.
 *
 * @param {string} dir absolute, already validated
 * @returns {Promise<Set<string>>} basenames; empty when the platform has no
 *   such attribute or the query fails, since "unknown" must not read as "yes"
 */
async function attributeNamesIn(dir) {
  if (process.platform !== 'win32') return new Map()
  /** @type {string} */
  let out
  try {
    out = await new Promise((resolve, reject) => {
      execFile('attrib', [join(dir, '*')], { windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
    })
  } catch {
    return new Map()
  }

  /** @type {Map<string, {hidden: boolean, system: boolean, archive: boolean}>} */
  const byName = new Map()
  for (const line of out.split(/\r?\n/)) {
    const at = line.indexOf(dir)
    if (at <= 0) continue
    const flags = line.slice(0, at)
    const name = basename(line.slice(at).trim())
    if (!name) continue
    // All three bits come from the one call that was already being made; only
    // H was being read, so the folder view's System and Archive columns had
    // nothing to show even though the answer was already on the line.
    byName.set(name, {
      hidden: /\bH\b/.test(flags),
      system: /\bS\b/.test(flags),
      archive: /\bA\b/.test(flags),
    })
  }
  return byName
}

// IPC: 讀取單一檔案的中繼資料
ipcMain.handle('stat-file', async (_event, filePath) => {
  const safe = validatePath(filePath)
  const s = await stat(safe)
  // The file-info panels previously listed the whole parent directory and
  // matched by path, which reads every sibling to answer about one file.
  return {
    path: safe,
    size: s.size,
    isDirectory: s.isDirectory(),
    mtime: s.mtime.toISOString(),
    ctime: s.ctime.toISOString(),
    atime: s.atime.toISOString(),
    ...fileAttributes(basename(safe), s),
  }
})

// IPC: 設定或清除 Windows 隱藏屬性
ipcMain.handle('set-hidden', async (_event, filePath, hidden) => {
  const safe = validatePath(filePath)
  if (process.platform !== 'win32') {
    throw new Error('此平台沒有隱藏屬性可設定')
  }
  await new Promise((resolve, reject) => {
    execFile('attrib', [hidden === false ? '-h' : '+h', safe], { windowsHide: true },
      (err) => (err ? reject(err) : resolve(undefined)))
  })
  return { path: safe, hidden: hidden !== false }
})

// IPC: 把一個檔案的修改時間套到另一個檔案（BC 的 Touch）
ipcMain.handle('set-mtime', async (_event, filePath, mtime) => {
  const safe = validatePath(filePath)
  const when = mtime == null ? new Date() : new Date(mtime)
  if (Number.isNaN(when.getTime())) {
    throw new Error(`無法解析的時間：${mtime}`)
  }
  // atime is preserved rather than stamped with "now": the point is to make
  // one file look like another's mtime, not to record that we touched it.
  const info = await stat(safe)
  await utimes(safe, info.atime, when)
  return { path: safe, mtime: when.toISOString() }
})

/**
 * Open a file in the OS's associated application, or let the user pick one.
 *
 * `withPicker` shells out to the Windows "Open with" dialog, which Electron
 * exposes no API for. It runs through execFile with a fixed argument list —
 * never a shell string — so a filename containing quotes or `&` is an argument
 * and not a command.
 */
/**
 * Menu commands the user has hidden, so every window agrees.
 * @type {string[]}
 */
let hiddenMenuCommands = []

/**
 * Finish a tab drag at a screen point: hand the session to whichever window is
 * under the cursor, or to a new one when the cursor is over none.
 *
 * HTML5 drag-and-drop cannot do this. Its events do not cross BrowserWindow
 * boundaries, so the window being dragged *into* never sees dragover or drop —
 * the source window holds pointer capture for the whole gesture. What does
 * work is asking, at mouse-up, which window contains the release point, which
 * is a question only main can answer.
 *
 * Dropping outside every window is the tear-off gesture and deliberately makes
 * a new one, matching what dragging a tab out of a browser does.
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {object} payload session descriptor
 * @param {number} x screen coordinate
 * @param {number} y screen coordinate
 */
ipcMain.handle('drop-tab-at', async (event, payload, x, y) => {
  if (!payload || typeof payload !== 'object') return { moved: false }

  const source = BrowserWindow.fromWebContents(event.sender)
  const px = Math.round(Number(x))
  const py = Math.round(Number(y))
  if (!Number.isFinite(px) || !Number.isFinite(py)) return { moved: false }

  const target = BrowserWindow.getAllWindows().find((w) => {
    if (w.isDestroyed() || w.isMinimized()) return false
    const b = w.getBounds()
    return px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height
  })

  // Released over its own window: an ordinary click-and-wobble, not a move.
  if (target && source && target.id === source.id) return { moved: false }

  if (target) {
    target.webContents.send('adopt-session', payload)
    target.focus()
    return { moved: true, newWindow: false }
  }

  const win = createWindow()
  buildAppMenu(win, hiddenMenuCommands)
  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.send('adopt-session', payload)
  })
  return { moved: true, newWindow: true }
})

/**
 * Open another top-level window, optionally handing it a session to adopt.
 *
 * BC lets a session live in its own window as well as in a tab, and lets a tab
 * be moved out into a new window. Both need a real second BrowserWindow; this
 * app had exactly one and no way to make another.
 *
 * The payload travels the same way CLI arguments do — sent once the new
 * renderer reports `did-finish-load`, because anything sent before that lands
 * in a page that has not yet subscribed and is silently lost.
 *
 * The window is created before the menu is rebuilt so the menu can bind to it.
 */
ipcMain.handle('open-new-window', async (_event, payload) => {
  const win = createWindow()
  buildAppMenu(win, hiddenMenuCommands)

  if (payload && typeof payload === 'object') {
    // Paths inside a moved session were already validated in the window that
    // opened them, but allowed roots are per-process rather than per-window,
    // so nothing needs re-registering — and re-registering here would widen
    // the allow-list from renderer-supplied data, which is the exact hole
    // validatePath exists to close.
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send('adopt-session', payload)
    })
  }
  return { id: win.id }
})

/**
 * The user's chosen external program for "Open With", pushed from the renderer
 * whenever the preference changes.
 *
 * It lives here rather than being passed per call because every call site is
 * in a view, and the preference would otherwise have to be threaded through
 * each of them. Launching a program is a main-process concern anyway.
 *
 * @type {{ command: string, args: string }}
 */
let openWithDefaults = { command: '', args: '"%1"' }

ipcMain.handle('set-open-with-defaults', (_event, command, args) => {
  openWithDefaults = {
    command: typeof command === 'string' ? command.trim() : '',
    args: typeof args === 'string' ? args : '"%1"',
  }
  return { command: openWithDefaults.command, args: openWithDefaults.args }
})

ipcMain.handle('open-with', async (_event, filePath, options) => {
  const safe = validatePath(filePath)
  await stat(safe) // fail here rather than in a dialog that shrugs

  // An explicit picker request outranks the configured program: the user asked
  // to choose this time.
  if (options?.withPicker !== true && openWithDefaults.command) {
    const args = buildOpenWithArgs(openWithDefaults.args, safe)
    await new Promise((resolve, reject) => {
      execFile(openWithDefaults.command, args, { windowsHide: true },
        (err) => (err ? reject(err) : resolve(undefined)))
    })
    return { opened: true, path: safe, picker: false, command: openWithDefaults.command }
  }

  if (options?.withPicker === true && process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', safe],
        (err) => (err ? reject(err) : resolve(undefined)))
    })
    return { opened: true, path: safe, picker: true }
  }

  // openPath resolves with a message rather than rejecting; an empty string
  // means success. Returning it as-is would report every failure as a success.
  const message = await shell.openPath(safe)
  if (message) throw new Error(message)
  return { opened: true, path: safe, picker: false }
})

// IPC: 清除或設定唯讀屬性
ipcMain.handle('set-read-only', async (_event, filePath, readOnly) => {
  const safe = validatePath(filePath)
  const info = await stat(safe)
  // Read-only is the write bits, on both platforms — Windows maps its
  // attribute onto them. Only those bits are touched, so an existing mode
  // (group/other permissions on Unix) survives having the flag cleared and
  // set again, which a fixed 0o644 would quietly discard.
  const mode = readOnly === false
    ? info.mode | 0o200
    : info.mode & ~0o222
  await chmod(safe, mode)
  return { path: safe, readOnly: readOnly !== false }
})

/**
 * Snapshots loaded this session, keyed by the file they came from.
 *
 * Held in memory because the folder view asks for one directory level at a
 * time and re-reading a multi-megabyte snapshot per level would be absurd.
 * @type {Map<string, import('./snapshot.js').Snapshot>}
 */
const _snapshots = new Map()

// IPC: 建立資料夾快照
ipcMain.handle('create-snapshot', async (event, { folderPath, crc } = {}) => {
  const safe = validatePath(folderPath)
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = {
    defaultPath: `${basename(safe) || 'snapshot'}.mcss`,
    filters: [{ name: 'MyCompare 快照', extensions: ['mcss'] }],
  }
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts)
  if (canceled || !filePath) return null
  registerRoot(filePath)
  return writeSnapshot(safe, filePath, { crc: !!crc })
})

// IPC: 載入快照檔
ipcMain.handle('load-snapshot', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = {
    properties: ['openFile'],
    filters: [{ name: 'MyCompare 快照', extensions: ['mcss'] }],
  }
  const { canceled, filePaths } = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts)
  if (canceled || !filePaths.length) return null
  registerRoot(filePaths[0])
  const snapshot = await readSnapshot(filePaths[0])
  _snapshots.set(filePaths[0], snapshot)
  return {
    path: filePaths[0],
    name: snapshot.name,
    root: snapshot.root,
    createdAt: snapshot.createdAt,
    hasCrc: snapshot.hasCrc,
    count: snapshot.entries.length,
  }
})

// IPC: 讀取快照中的某一層
ipcMain.handle('read-snapshot-dir', async (_event, { snapshotPath, relDir } = {}) => {
  // Load on demand rather than requiring load-snapshot to have run first:
  // ordering is not the caller's problem, and a restored session or workspace
  // has a snapshot path without ever having gone through the open dialog.
  let snapshot = _snapshots.get(snapshotPath)
  if (!snapshot) {
    const safe = validatePath(snapshotPath)
    snapshot = await readSnapshot(safe)
    _snapshots.set(snapshotPath, snapshot)
  }
  return snapshotLevel(snapshot, typeof relDir === 'string' ? relDir : '')
})

/**
 * IPC: export a live registry key, then read it back.
 *
 * Reading the registry directly would need a native binding; reg.exe ships
 * with Windows and emits the same data in a documented text format, so the
 * same parser serves both a live key and a .reg file the user already has.
 */
ipcMain.handle('export-registry-key', async (event, { keyPath } = {}) => {
  const { exportRegistryKey, readRegFile, validateRegistryPath } =
    await import('./registry.js')
  // Validate before opening the dialog: an unusable key should be reported
  // straight away rather than after the user has picked a destination.
  validateRegistryPath(keyPath)

  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = {
    defaultPath: 'registry-export.reg',
    filters: [{ name: '登錄檔', extensions: ['reg'] }],
  }
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts)
  if (canceled || !filePath) return null
  registerRoot(filePath)
  await exportRegistryKey(keyPath, filePath)
  const parsed = await readRegFile(filePath)
  return { path: filePath, format: parsed.format, rows: parsed.rows }
})

// IPC: 讀取 .reg 檔
ipcMain.handle('read-reg-file', async (_event, filePath) => {
  const safe = validatePath(filePath)
  const { readRegFile } = await import('./registry.js')
  const parsed = await readRegFile(safe)
  return { path: safe, format: parsed.format, rows: parsed.rows }
})

// IPC: 讀取資料夾內容（一層）
ipcMain.handle('read-dir', async (_event, dirPath, options) => {
  const safe = validatePath(dirPath)
  const entries = await readdir(safe, { withFileTypes: true })
  // Reading the hidden attribute costs a process per directory, so it is only
  // paid for when the caller says it needs it — a recursive scan asking for it
  // everywhere would spawn one per level.
  const attrs = options?.attributes === true ? await attributeNamesIn(safe) : null
  const result = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(safe, entry.name)
      try {
        const s = await stat(fullPath)
        return {
          name: entry.name,
          path: fullPath,
          // stat() follows symlinks; Dirent.isDirectory() does not, so using
          // the Dirent classified a symlinked directory as a plain file and
          // the row could never be expanded.
          isDirectory: s.isDirectory(),
          isSymbolicLink: entry.isSymbolicLink(),
          size: s.size,
          mtime: s.mtime.toISOString(),
          ctime: s.ctime.toISOString(),
          ...fileAttributes(entry.name, s),
          // Present only when actually read; otherwise the tri-state null
          // stands, so "not asked" never reads as "not set".
          ...(attrs ? (attrs.get(entry.name) ?? { hidden: false, system: false, archive: false }) : {})
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

// A real CRC-32, not MD5 under another name. The folder view offers both, each
// labelled for what it is, so a value checked against unzip or `7z l` matches.
ipcMain.handle('crc32-file', async (_event, filePath) => {
  const safe = validatePath(filePath)
  const { computeCrc32 } = await import('./file-hash.js')
  const buffer = await readFile(safe)
  return computeCrc32(buffer)
})

// IPC: 版本控制狀態欄與 Source Control 子選單（僅 git）。
//
// 每一條路徑都要經過 validatePath——vcs.js 的介面註明它收到的是「已驗證的
// 絕對路徑」，驗證是這一層的責任。批次操作特別容易漏：驗證了 root 卻讓
// paths 陣列裡的元素直接進去，等於開了一個以 root 為幌子的任意路徑通道。
ipcMain.handle('vcs-status', async (_event, dirPath) => {
  const safe = validatePath(dirPath)
  const { readVcsStatus } = await import('./vcs.js')
  return readVcsStatus(safe)
})

ipcMain.handle('vcs-run', async (_event, req) => {
  const root = validatePath(req?.root)
  const paths = (Array.isArray(req?.paths) ? req.paths : []).map((p) => validatePath(p))
  const { runVcsCommand } = await import('./vcs.js')
  return runVcsCommand({ action: req?.action, root, paths })
})

ipcMain.handle('vcs-text', async (_event, req) => {
  const root = validatePath(req?.root)
  const filePath = validatePath(req?.path)
  const { readVcsText } = await import('./vcs.js')
  return readVcsText({ action: req?.action, root, path: filePath })
})

// IPC: 擁有者 / 群組欄。批次上限由 file-owner.js 明確拒絕超出的部分，
// 不靜默截斷——被丟掉的列會顯示為「擁有者不明」而看不出原因。
ipcMain.handle('file-owners', async (_event, paths) => {
  const safe = (Array.isArray(paths) ? paths : []).map((p) => validatePath(p))
  const { readOwners } = await import('./file-owner.js')
  return readOwners(safe)
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
/**
 * Rebuild the application menu with the user's hidden commands removed.
 *
 * Command visibility was a renderer-only preference: toolbars honoured it and
 * the menu bar did not, so a command the user had turned off was still one
 * click away in the menu that shipped it. The list is rebuilt rather than
 * items toggled because hiding one can empty a whole submenu, and the pruning
 * that repairs separators has to see the finished template.
 */
ipcMain.handle('set-menu-visibility', (event, hidden) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return false
  const ids = Array.isArray(hidden) ? hidden.filter((h) => typeof h === 'string') : []
  // Remembered so a window opened later starts with the same menu. Without
  // this a second window would show commands the user had hidden, and the
  // difference between two windows of the same app would look like a bug.
  hiddenMenuCommands = ids
  buildAppMenu(win, ids)
  return true
})

/**
 * Print a finished report to PDF, with page numbers.
 *
 * The in-window print path cannot number pages: Chromium ignores `@page`
 * margin boxes, so CSS counters have nowhere to render. `printToPDF` is the
 * only route that takes a footer template, which is why this exists in main
 * rather than being another `window.print()` call.
 *
 * The HTML goes through a temp file instead of a data URL — reports run to
 * megabytes and a data URL of that size is silently truncated by the loader.
 */
let printSeq = 0

ipcMain.handle('print-to-pdf', async (event, html, suggestedName) => {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('沒有可列印的內容')
  }

  const parent = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePath } = await dialog.showSaveDialog(parent ?? undefined, {
    title: '匯出 PDF',
    defaultPath: typeof suggestedName === 'string' && suggestedName ? suggestedName : 'report.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (canceled || !filePath) return { saved: false, path: '' }

  const tmpHtml = join(tmpdir(), `mycompare-print-${process.pid}-${printSeq++}.html`)
  // Offscreen so printing never steals focus from the window the user is in.
  const worker = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true }
  })

  try {
    await writeFile(tmpHtml, html, 'utf-8')
    await worker.loadFile(tmpHtml)
    const pdf = await worker.webContents.printToPDF({
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;font-size:9px;padding:0 12mm;color:#666;'
        + 'display:flex;justify-content:space-between">'
        + '<span class="title"></span>'
        + '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>'
        + '</div>',
      margins: { top: 0.6, bottom: 0.6, left: 0.5, right: 0.5 }
    })
    await writeFile(filePath, pdf)
    return { saved: true, path: filePath }
  } finally {
    // Both cleanups must run even when printing threw, or a failed export
    // leaks an offscreen window and a temp file every attempt.
    if (!worker.isDestroyed()) worker.destroy()
    await rm(tmpHtml, { force: true }).catch(() => {})
  }
})

ipcMain.handle('toggle-fullscreen', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return false
  const next = !win.isFullScreen()
  win.setFullScreen(next)
  return next
})

// IPC: 讀取 Excel (.xlsx/.xls) 並回傳每個工作表的 CSV 字串
// IPC: MP3 / Version compare 的中繼資料（僅讀取檔頭與檔尾，不載入整個檔案）
ipcMain.handle('read-metadata', async (_event, filePath) => {
  const safe = validatePath(filePath)
  const { readMetadata } = await import('./metadata.js')
  return readMetadata(safe)
})

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
