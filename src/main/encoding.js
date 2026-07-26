import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const chardet = require('chardet')
const iconv = require('iconv-lite')

/**
 * 自動偵測 buffer 的編碼並解碼為字串。
 * @param {Buffer} buffer
 * @returns {{ content: string, encoding: string }}
 */
export function decodeBuffer(buffer) {
  if (!buffer || buffer.length === 0) return { content: '', encoding: 'UTF-8' }
  const detected = chardet.detect(buffer) || 'UTF-8'
  const encoding = iconv.encodingExists(detected) ? detected : 'UTF-8'
  const content = iconv.decode(buffer, encoding)
  return { content, encoding }
}

/**
 * 以指定編碼把字串編成 Buffer，供寫檔使用。
 *
 * 存檔時必須寫回原始編碼；一律以 UTF-8 覆寫會讓 Big5 / Shift-JIS 等
 * 非 UTF-8 檔案在其他工具中變成亂碼，且是靜默發生的。
 *
 * 未知或不支援的編碼一律退回 UTF-8。
 *
 * @param {string} content
 * @param {string} [encoding]
 * @returns {Buffer}
 */
export function encodeContent(content, encoding = 'UTF-8') {
  const target = encoding && iconv.encodingExists(encoding) ? encoding : 'UTF-8'
  return iconv.encode(content ?? '', target)
}
