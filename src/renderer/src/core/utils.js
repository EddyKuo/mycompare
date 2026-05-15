/**
 * Shared utility functions used across multiple view modules.
 * src/renderer/src/core/utils.js
 */

/**
 * 將 bytes 格式化為人類可讀大小字串
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  if (bytes == null) return ''
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1)
  const val = bytes / (1024 ** exp)
  return exp === 0 ? `${val} B` : `${val.toFixed(1)} ${units[exp]}`
}

/**
 * 防抖：延遲 delay ms 後才執行 fn，期間若再次呼叫則重置計時器
 * @template {(...args: unknown[]) => void} T
 * @param {T} fn
 * @param {number} delay
 * @returns {T}
 */
export function debounce(fn, delay) {
  let timer = null
  return (/** @type {Parameters<T>} */ ...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

/**
 * 建立 DOM 元素的便利函式
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {...(Node|string|null|undefined)} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v
    else if (k === 'textContent') node.textContent = v
    else node.setAttribute(k, v)
  }
  for (const child of children) {
    if (child == null) continue
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}
