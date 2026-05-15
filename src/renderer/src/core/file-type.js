/**
 * file-type.js — 依副檔名判斷適用的比對視圖類型
 * @module file-type
 */

const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tiff', 'tif', 'svg',
])

const TABLE_EXTS = new Set([
  'csv', 'tsv', 'xlsx', 'xls',
])

const HEX_EXTS = new Set([
  'exe', 'dll', 'bin', 'dat', 'so', 'dylib', 'obj', 'o', 'class', 'wasm',
  'zip', 'gz', 'tar', '7z', 'rar', 'pdf', 'doc', 'docx', 'ppt', 'pptx',
])

/**
 * 依路徑副檔名回傳對應的比對視圖類型。
 *
 * @param {string|null|undefined} path - 檔案路徑
 * @returns {'text'|'image'|'table'|'hex'} 視圖類型
 */
export function getViewTypeForPath(path) {
  if (!path) return 'text'
  const parts = path.replace(/\\/g, '/').split('/')
  const filename = parts[parts.length - 1] ?? ''
  const dotIdx = filename.lastIndexOf('.')
  if (dotIdx === -1) return 'text'
  const ext = filename.slice(dotIdx + 1).toLowerCase()
  if (!ext) return 'text'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (TABLE_EXTS.has(ext)) return 'table'
  if (HEX_EXTS.has(ext))   return 'hex'
  return 'text'
}
