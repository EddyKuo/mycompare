import { contextBridge, ipcRenderer, webUtils } from 'electron'

// S13-C08: keep handler references so callers can unsubscribe.
/** @type {Map<string, Set<(data: any) => void>>} */
const _listeners = new Map()

/**
 * Register a renderer-side listener and return an unsubscribe function.
 * Also tolerates a `null` callback in the consumer's unsubscribe path.
 */
function _onChannel(channel, cb) {
  if (typeof cb !== 'function') return () => {}
  const wrapped = (_e, data) => cb(data)
  ipcRenderer.on(channel, wrapped)
  let set = _listeners.get(channel)
  if (!set) { set = new Set(); _listeners.set(channel, set) }
  set.add(wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
    set?.delete(wrapped)
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: (options) => ipcRenderer.invoke('open-file', options),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  readDir: (path, options) => ipcRenderer.invoke('read-dir', path, options),
  createSnapshot: (folderPath, crc) => ipcRenderer.invoke('create-snapshot', { folderPath, crc }),
  loadSnapshot: () => ipcRenderer.invoke('load-snapshot'),
  readSnapshotDir: (snapshotPath, relDir) =>
    ipcRenderer.invoke('read-snapshot-dir', { snapshotPath, relDir }),
  readFile: (path, encoding) => ipcRenderer.invoke('read-file', path, encoding),
  acceptDroppedFiles: (files) => ipcRenderer.invoke(
    'accept-dropped-paths',
    Array.from(files ?? [], (f) => {
      try { return webUtils.getPathForFile(f) } catch { return '' }
    }).filter(Boolean)),
  openFileBinary: (options) => ipcRenderer.invoke('open-file-binary', options),
  readFileBinary: (path, maxBytes) => ipcRenderer.invoke('read-file-binary', path, maxBytes),
  showInExplorer: (path) => ipcRenderer.invoke('show-in-explorer', path),
  copyFile: (src, dest, backup) => ipcRenderer.invoke('copy-file', { src, dest, backup }),
  deleteFile: (path, options) => ipcRenderer.invoke('delete-file', path, options),
  setReadOnly: (path, readOnly) => ipcRenderer.invoke('set-read-only', path, readOnly),
  openWith: (path, options) => ipcRenderer.invoke('open-with', path, options),
  setHidden: (path, hidden) => ipcRenderer.invoke('set-hidden', path, hidden),
  setMtime: (path, mtime) => ipcRenderer.invoke('set-mtime', path, mtime),
  statFile: (path) => ipcRenderer.invoke('stat-file', path),
  getPortableInfo: () => ipcRenderer.invoke('get-portable-info'),
  saveFile: (defaultPath, content, filters, encoding, backup) =>
    ipcRenderer.invoke('save-file', { defaultPath, content, filters, encoding, backup }),
  readArchive: (archivePath) => ipcRenderer.invoke('read-archive', archivePath),
  readArchiveEntry: (archivePath, entryPath) =>
    ipcRenderer.invoke('read-archive-entry', { archivePath, entryPath }),
  hashFile: (path) => ipcRenderer.invoke('hash-file', path),
  readExcel: (path) => ipcRenderer.invoke('read-excel', path),
  readMetadata: (path) => ipcRenderer.invoke('read-metadata', path),
  exportRegistryKey: (keyPath) => ipcRenderer.invoke('export-registry-key', { keyPath }),
  readRegFile: (path) => ipcRenderer.invoke('read-reg-file', path),

  // Remote connections. Each call names a profile the user created; nothing
  // here reaches the network on its own.
  remoteListProfiles: () => ipcRenderer.invoke('remote-list-profiles'),
  remoteSaveProfile: (profile) => ipcRenderer.invoke('remote-save-profile', profile),
  remoteDeleteProfile: (id) => ipcRenderer.invoke('remote-delete-profile', id),
  remoteListDir: (profileId, dir, secret) =>
    ipcRenderer.invoke('remote-list-dir', { profileId, dir, secret }),
  remoteReadFile: (profileId, path, maxBytes, secret) =>
    ipcRenderer.invoke('remote-read-file', { profileId, path, maxBytes, secret }),
  remoteDisconnect: (profileId) => ipcRenderer.invoke('remote-disconnect', profileId),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('rename-file', oldPath, newPath),
  mkdirFolder: (dirPath) => ipcRenderer.invoke('mkdir-folder', dirPath),
  crc32File: (path) => ipcRenderer.invoke('crc32-file', path),
  vcsStatus: (dirPath) => ipcRenderer.invoke('vcs-status', dirPath),
  vcsRun: (req) => ipcRenderer.invoke('vcs-run', req),
  vcsText: (req) => ipcRenderer.invoke('vcs-text', req),
  fileOwners: (paths) => ipcRenderer.invoke('file-owners', paths),
  setOpenWithDefaults: (command, args) =>
    ipcRenderer.invoke('set-open-with-defaults', command, args),
  setArchiveLimits: (enabled, maxEntryMB) =>
    ipcRenderer.invoke('set-archive-limits', enabled, maxEntryMB),
  setMenuVisibility: (hidden) => ipcRenderer.invoke('set-menu-visibility', hidden),
  printToPdf: (html, suggestedName) => ipcRenderer.invoke('print-to-pdf', html, suggestedName),
  toggleFullScreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  watchFile: (path) => ipcRenderer.invoke('watch-file', path),
  unwatchFile: (path) => ipcRenderer.invoke('unwatch-file', path),

  // S13-C08: subscribers now return an unsubscribe handle so views can clean
  // up in destroy(). The old callback-only signature is preserved.
  onOpenFiles: (cb) => _onChannel('open-files', cb),
  onFileChanged: (cb) => _onChannel('file-changed', cb),
  onMenuAction: (cb) => _onChannel('menu-action', cb),
})
