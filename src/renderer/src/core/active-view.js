/**
 * @file active-view.js
 * @description S14-M07: single source of truth for "which view is on screen".
 *
 *   View classes attach document-level keyboard shortcuts (Ctrl+F, F7/F8,
 *   Ctrl+= / Ctrl+-, etc.) inside mount(). Without coordination those
 *   listeners fire for every view at once — when the user is staring at the
 *   folder tab and presses Ctrl+F, both folder-compare AND text-compare's
 *   listeners trigger.
 *
 *   This module exposes a global "active view tag" that view-mounted handlers
 *   check at the top: `if (!isActive('text')) return`. `app.js` calls
 *   `setActiveView(name)` exactly once whenever it switches views.
 */

/** @type {string} */
let _active = 'home'

/**
 * @returns {string} The active view tag (e.g. 'text', 'folder', 'hex')
 */
export function getActiveView() { return _active }

/**
 * @param {string} name
 */
export function setActiveView(name) {
  _active = typeof name === 'string' ? name : 'home'
}

/**
 * Convenience guard for handlers:
 *   document.addEventListener('keydown', e => { if (!isActive('text')) return; ... })
 * @param {string} name
 * @returns {boolean}
 */
export function isActive(name) { return _active === name }
