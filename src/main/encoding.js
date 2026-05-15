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
