/**
 * @file eol-detect.js
 * @description Utility to detect dominant line-ending style in text content.
 */

/**
 * Detect the dominant line ending in text content.
 * @param {string} content
 * @returns {'CRLF' | 'LF' | 'CR'}
 */
export function detectEol(content) {
  if (!content) return 'LF'
  const crlfCount = (content.match(/\r\n/g) ?? []).length
  // Count LF not preceded by CR
  const lfCount = (content.match(/(?<!\r)\n/g) ?? []).length
  const crCount = (content.match(/\r(?!\n)/g) ?? []).length
  if (crlfCount >= lfCount && crlfCount >= crCount && crlfCount > 0) return 'CRLF'
  if (crCount > lfCount && crCount > crlfCount) return 'CR'
  return 'LF'
}
