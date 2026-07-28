/**
 * file-type.js — 依副檔名判斷適用的比對視圖類型，以及路由用得到的路徑字串工具
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
 * 檔案本身只有中繼資料值得逐欄比對的副檔名。
 *
 * MP3 的音訊內容逐 byte 比對幾乎不會給出有用的答案——重新編碼一次就整份不同，
 * 而使用者想知道的是標籤欄位哪裡不一樣，這正是 BC 的 MP3 Compare。
 */
const METADATA_EXTS = new Set(['mp3'])

/**
 * 副檔名 → 一個以上同樣合理的視圖類型，第一個為預設。
 *
 * HTML 既是文字也是表格容器：表格比對能解析其中的 `<table>`，但一份手寫的
 * 網頁多半該逐行看。單靠副檔名無法判斷使用者想要哪一種，所以這裡不替他決定，
 * 由呼叫端詢問。
 *
 * 同理，一個 .exe 既是二進位檔（hex）也帶有版本資源（metadata）：兩種讀法都
 * 誠實，所以照樣問，而不是替使用者選一個。預設維持 hex，與過去一致。
 *
 * 一份 .reg 同時是純文字，也是可以逐值比對的登錄檔匯出。BC 兩種都給，
 * 而值的型別與「只存在於一側」這兩件事只有格狀檢視看得見，所以預設為它。
 * @type {Map<string, Array<'text'|'image'|'table'|'hex'|'metadata'|'registry'>>}
 */
const AMBIGUOUS_EXTS = new Map([
  ['reg',  ['registry', 'text']],
  ['html', ['text', 'table']],
  ['htm',  ['text', 'table']],
  ['exe',  ['hex', 'metadata']],
  ['dll',  ['hex', 'metadata']],
  ['ocx',  ['hex', 'metadata']],
  ['sys',  ['hex', 'metadata']],
])

/**
 * 取出路徑的副檔名（小寫，不含點）。
 *
 * @param {string|null|undefined} path
 * @returns {string} 沒有副檔名時回傳空字串
 */
function extensionOf(path) {
  if (!path) return ''
  const parts = String(path).replace(/\\/g, '/').split('/')
  const filename = parts[parts.length - 1] ?? ''
  const dotIdx = filename.lastIndexOf('.')
  if (dotIdx === -1) return ''
  return filename.slice(dotIdx + 1).toLowerCase()
}

/**
 * 依路徑副檔名回傳對應的比對視圖類型。
 *
 * 副檔名有多種合理解讀時回傳「預設」那一個，呼叫端若想讓使用者選擇，
 * 應先用 {@link getViewChoicesForPath} 判斷。
 *
 * @param {string|null|undefined} path - 檔案路徑
 * @returns {'text'|'image'|'table'|'hex'|'metadata'|'registry'} 視圖類型
 */
export function getViewTypeForPath(path) {
  const ext = extensionOf(path)
  if (!ext) return 'text'
  // 先問「有沒有多種讀法」：.exe 同時列在 HEX_EXTS 裡，若照舊順序就永遠不會
  // 走到多選，使用者也就永遠看不到版本比對這個選項。
  const ambiguous = AMBIGUOUS_EXTS.get(ext)
  if (ambiguous) return ambiguous[0]
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (TABLE_EXTS.has(ext)) return 'table'
  if (METADATA_EXTS.has(ext)) return 'metadata'
  if (HEX_EXTS.has(ext))   return 'hex'
  return 'text'
}

/**
 * 這個路徑有哪些同樣合理的視圖類型（第一個為預設）。
 *
 * @param {string|null|undefined} path
 * @returns {Array<'text'|'image'|'table'|'hex'|'metadata'|'registry'>} 只有單一解讀時回傳空陣列
 */
export function getViewChoicesForPath(path) {
  const choices = AMBIGUOUS_EXTS.get(extensionOf(path))
  return choices ? [...choices] : []
}

/**
 * 是否需要詢問使用者要用哪一種比對開啟。
 *
 * @param {string|null|undefined} path
 * @returns {boolean}
 */
export function isAmbiguousPath(path) {
  return getViewChoicesForPath(path).length > 1
}

/**
 * 取出路徑的上層資料夾（一律以正斜線表示）。
 *
 * 供「比對上層資料夾」使用：主程序接受正反斜線，但字串比較只有統一形式才可靠。
 *
 * @param {string|null|undefined} path
 * @returns {string} 沒有上層可言時回傳空字串
 */
export function parentFolderOf(path) {
  const norm = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = norm.lastIndexOf('/')
  if (idx < 0) return ''
  const parent = norm.slice(0, idx)
  // 磁碟機代號本身不是可用的資料夾（"C:/a.txt" → "C:" 需補成 "C:/"）。
  if (/^[a-z]:$/i.test(parent)) return `${parent}/`
  // POSIX 根目錄：切完是空字串，但根目錄確實存在。
  if (parent === '') return norm.startsWith('/') ? '/' : ''
  return parent
}
