/**
 * @file toast.js
 * @description Non-blocking toast notification.
 *
 *   S15-U03: replaces `alert()` for short status messages. Toasts auto-dismiss
 *   after a few seconds and stack vertically. They never block the renderer,
 *   never trigger a native dialog, and are stylable / testable.
 */

const CONTAINER_ID = 'mc-toast-container'
const DEFAULT_DURATION = 3500

/**
 * Show a toast message. Returns a function that, when called, dismisses the
 * toast immediately.
 *
 * @param {string} message
 * @param {{ type?: 'info' | 'success' | 'error' | 'warn', durationMs?: number }} [opts]
 * @returns {() => void} dismiss
 */
export function toast(message, opts = {}) {
  const { type = 'info', durationMs = DEFAULT_DURATION } = opts
  const container = _ensureContainer()
  const el = document.createElement('div')
  el.className = `mc-toast mc-toast--${type}`
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')
  el.textContent = String(message)
  container.appendChild(el)

  let dismissed = false
  const dismiss = () => {
    if (dismissed) return
    dismissed = true
    el.classList.add('mc-toast--leaving')
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el) }, 200)
  }
  const timer = setTimeout(dismiss, Math.max(500, durationMs))
  el.addEventListener('click', () => { clearTimeout(timer); dismiss() })
  return dismiss
}

function _ensureContainer() {
  let c = document.getElementById(CONTAINER_ID)
  if (!c) {
    c = document.createElement('div')
    c.id = CONTAINER_ID
    c.setAttribute('aria-live', 'polite')
    document.body.appendChild(c)
  }
  return c
}
