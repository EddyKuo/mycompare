import { contextBridge, ipcRenderer } from 'electron'

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
  // T60: Toggle window full-screen mode
  toggleFullScreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, data) => cb(data)),
  // T33: File Watcher
  watchFile: (path) => ipcRenderer.invoke('watch-file', path),
  unwatchFile: (path) => ipcRenderer.invoke('unwatch-file', path),
  onFileChanged: (cb) => ipcRenderer.on('file-changed', (_e, data) => cb(data)),
})
