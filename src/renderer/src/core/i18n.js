/**
 * @file i18n.js
 * @description Minimal i18n scaffold (S15-U09).
 *
 *   The goal of this module is NOT to translate the UI today — every string
 *   currently in the codebase remains hardcoded zh-TW. Instead, this module
 *   provides a `t(key, fallback)` API so future UI work can incrementally
 *   migrate hardcoded strings into a central table. Until then, every call
 *   site can pass a `fallback` that matches the existing text, so swapping
 *   `'確定'` for `t('common.ok', '確定')` is a no-op for users.
 *
 *   Usage:
 *     t('common.ok')              → '確定'  (from table)
 *     t('common.ok', '確定')      → '確定'  (fallback wins if key missing)
 *     t('unknown.key', 'foo')     → 'foo'
 */

/** @type {Record<string, Record<string, string>>} */
const STRINGS = {
  'zh-TW': {
    'common.ok':       '確定',
    'common.cancel':   '取消',
    'common.close':    '關閉',
    'common.delete':   '刪除',
    'common.save':     '儲存',
    'common.error':    '錯誤',
    'common.success':  '成功',
    'workspace.no_tabs': '目前沒有分頁可儲存',
    'storage.quota_exceeded': 'localStorage 空間不足，無法儲存',
  },
}

let _locale = 'zh-TW'

/**
 * Set the active locale.
 * @param {string} loc
 */
export function setLocale(loc) {
  if (STRINGS[loc]) _locale = loc
}

/** @returns {string} */
export function getLocale() { return _locale }

/**
 * Look up a translation key.
 *
 * @param {string} key
 * @param {string} [fallback]  Returned when the key is not present in the
 *   active locale. If omitted and the key is unknown, returns the key itself.
 * @returns {string}
 */
export function t(key, fallback) {
  const table = STRINGS[_locale]
  if (table && Object.prototype.hasOwnProperty.call(table, key)) {
    return table[key]
  }
  return fallback ?? key
}

/** Test-only: extend or override the active locale table. */
export function _registerStrings(loc, entries) {
  STRINGS[loc] = { ...(STRINGS[loc] ?? {}), ...entries }
}
