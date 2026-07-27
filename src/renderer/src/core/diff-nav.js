/**
 * @file diff-nav.js
 * @description The one place that decides what "next difference" means.
 *
 *   Beyond Compare exposes this as Options ▸ Next Difference rather than
 *   fixing it: wrapping, jumping to the first difference on load, advancing
 *   after a copy and the "no difference" message are all user switches.
 *   Every view therefore asks this module instead of hard-coding a rule, so
 *   text / folder / table / image / hex / merge3 cannot drift apart again.
 */

import { SettingsStore } from './settings-store.js'

/**
 * Result of a difference-navigation call, shared by every comparison view.
 *
 * `moved: false` with a non-zero `total` is what the status bar renders as
 * "already at the last/first difference"; with wrap-around enabled it only
 * happens when there is a single difference to sit on.
 *
 * @typedef {object} NavResult
 * @property {number} index  0-based position, -1 when nothing is selected
 * @property {number} total
 * @property {boolean} moved
 */

/**
 * @typedef {object} NavOptions
 * @property {boolean} wrapAround
 * @property {boolean} firstDiffOnLoad
 * @property {boolean} nextAfterCopy
 * @property {boolean} showNoDiffMessage
 */

const store = new SettingsStore()

/**
 * Current Next-Difference options.
 *
 * Read per call rather than cached: the settings modal writes straight to
 * localStorage, and a cache would leave already-mounted views on stale rules.
 *
 * @returns {NavOptions}
 */
export function getNavOptions() {
  return {
    wrapAround:        Boolean(store.getPref('navWrapAround')),
    firstDiffOnLoad:   Boolean(store.getPref('navFirstDiffOnLoad')),
    nextAfterCopy:     Boolean(store.getPref('navNextAfterCopy')),
    showNoDiffMessage: Boolean(store.getPref('navShowNoDiffMessage')),
  }
}

/**
 * Where a step lands, honouring the wrap-around option.
 *
 * @param {number} current  current index, -1 when nothing is selected yet
 * @param {number} total
 * @param {number} delta    +1 for next, -1 for prev
 * @param {boolean} [wrap]  defaults to the stored option
 * @returns {number} -1 when there is nothing to navigate to
 */
export function stepDiffIndex(current, total, delta, wrap = getNavOptions().wrapAround) {
  if (total <= 0) return -1
  // Nothing selected yet: the first press picks an end rather than stepping
  // off it, so Next lands on the first difference and Prev on the last.
  if (current < 0) return delta > 0 ? 0 : (wrap ? total - 1 : 0)
  const next = current + delta
  if (next >= total) return wrap ? 0 : total - 1
  if (next < 0) return wrap ? total - 1 : 0
  return next
}

/**
 * @param {number} from  index before the move, -1 when nothing was selected
 * @param {number} to    index returned by stepDiffIndex
 * @param {number} total
 * @returns {NavResult}
 */
export function navResult(from, to, total) {
  const safeTotal = Math.max(0, total | 0)
  if (safeTotal === 0 || to < 0) return { index: -1, total: safeTotal, moved: false }
  return { index: to, total: safeTotal, moved: to !== from }
}

/**
 * Status-bar text for a navigation result, or null when the user has turned
 * the message off (BC's "Show message panel").
 *
 * @param {'next'|'prev'|'first'|'last'} where
 * @param {NavResult | null | undefined} result
 * @param {boolean} [showMessage] defaults to the stored option
 * @returns {string | null}
 */
export function describeNavResult(where, result, showMessage = getNavOptions().showNoDiffMessage) {
  if (!result || typeof result !== 'object') return null
  const { index, total, moved } = result
  if (!total) return showMessage ? '沒有差異' : null
  if (!moved) {
    if (!showMessage) return null
    return (where === 'next' || where === 'last')
      ? `已到最後一個差異（共 ${total} 個）`
      : `已到第一個差異（共 ${total} 個）`
  }
  return `差異 ${index + 1} / ${total}`
}
