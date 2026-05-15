/**
 * Lightweight custom context menu for MyCompare.
 *
 * Usage:
 *   import { showContextMenu } from '../core/context-menu.js'
 *   showContextMenu(e, [
 *     { label: '開啟', action: () => {} },
 *     { separator: true },
 *     { label: '刪除', action: () => {}, disabled: true },
 *   ])
 */

/** @type {HTMLElement | null} */
let _activeMenu = null
/** @type {((e: MouseEvent) => void) | null} */
let _mouseDownHandler = null
/** @type {((e: KeyboardEvent) => void) | null} */
let _keyDownHandler = null

/**
 * @typedef {{
 *   label?: string,
 *   action?: () => void,
 *   separator?: boolean,
 *   disabled?: boolean
 * }} MenuItem
 */

/**
 * Show a context menu anchored at the mouse event position.
 * @param {MouseEvent} e
 * @param {MenuItem[]} items
 */
export function showContextMenu(e, items) {
  e.preventDefault()
  e.stopPropagation()
  closeContextMenu()

  if (!items.length) return

  const menu = document.createElement('div')
  menu.className = 'ctx-menu'

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div')
      sep.className = 'ctx-sep'
      menu.appendChild(sep)
      continue
    }
    const btn = document.createElement('button')
    btn.className = 'ctx-item' + (item.disabled ? ' ctx-item--disabled' : '')
    btn.textContent = item.label ?? ''
    btn.type = 'button'
    if (!item.disabled && item.action) {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        closeContextMenu()
        item.action()
      })
    }
    menu.appendChild(btn)
  }

  document.body.appendChild(menu)
  _activeMenu = menu

  // Initial position
  let x = e.clientX
  let y = e.clientY
  menu.style.left = `${x}px`
  menu.style.top  = `${y}px`

  // After paint: adjust if the menu overflows the viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect()
    if (rect.right  > window.innerWidth)  { x = Math.max(0, window.innerWidth  - rect.width  - 4); menu.style.left = `${x}px` }
    if (rect.bottom > window.innerHeight) { y = Math.max(0, window.innerHeight - rect.height - 4); menu.style.top  = `${y}px` }
    menu.classList.add('ctx-menu--visible')
  })

  // Close on outside click — keep listener alive until menu is actually closed
  _mouseDownHandler = (ev) => {
    if (_activeMenu && !_activeMenu.contains(/** @type {Node} */ (ev.target))) {
      closeContextMenu()
    }
  }
  document.addEventListener('mousedown', _mouseDownHandler)

  // Close on Escape
  _keyDownHandler = (ev) => {
    if (ev.key === 'Escape') closeContextMenu()
  }
  document.addEventListener('keydown', _keyDownHandler)
}

export function closeContextMenu() {
  if (_activeMenu) {
    _activeMenu.remove()
    _activeMenu = null
  }
  if (_mouseDownHandler) {
    document.removeEventListener('mousedown', _mouseDownHandler)
    _mouseDownHandler = null
  }
  if (_keyDownHandler) {
    document.removeEventListener('keydown', _keyDownHandler)
    _keyDownHandler = null
  }
}
