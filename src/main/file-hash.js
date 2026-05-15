import { createHash } from 'crypto'

/**
 * 計算 buffer 的 MD5 hex digest。
 * @param {Buffer} buffer
 * @returns {string} 32 位元 hex 字串
 */
export function computeMd5(buffer) {
  return createHash('md5').update(buffer).digest('hex')
}
