import { contextBridge, ipcRenderer } from 'electron'

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
  readDir: (path) => ipcRenderer.invoke('read-dir', path),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  openFileBinary: (options) => ipcRenderer.invoke('open-file-binary', options),
  readFileBinary: (path) => ipcRenderer.invoke('read-file-binary', path),
  showInExplorer: (path) => ipcRenderer.invoke('show-in-explorer', path),
  copyFile: (src, dest) => ipcRenderer.invoke('copy-file', { src, dest }),
  deleteFile: (path) => ipcRenderer.invoke('delete-file', path),
  saveFile: (defaultPath, content, filters) => ipcRenderer.invoke('save-file', { defaultPath, content, filters }),
  openZip: () => ipcRenderer.invoke('open-zip'),
  hashFile: (path) => ipcRenderer.invoke('hash-file', path),
  readExcel: (path) => ipcRenderer.invoke('read-excel', path),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('rename-file', oldPath, newPath),
  mkdirFolder: (dirPath) => ipcRenderer.invoke('mkdir-folder', dirPath),
  toggleFullScreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  watchFile: (path) => ipcRenderer.invoke('watch-file', path),
  unwatchFile: (path) => ipcRenderer.invoke('unwatch-file', path),

  // S13-C08: subscribers now return an unsubscribe handle so views can clean
  // up in destroy(). The old callback-only signature is preserved.
  onOpenFiles: (cb) => _onChannel('open-files', cb),
  onFileChanged: (cb) => _onChannel('file-changed', cb),
})
