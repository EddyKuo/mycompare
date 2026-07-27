/**
 * @file window-manager.js
 * @description Second and subsequent application windows.
 *
 *   Beyond Compare lets a session live in its own window as well as in a tab,
 *   and lets a tab be pulled out into a new window. This app had exactly one
 *   window and no way to make another, which is the gap this closes.
 *
 *   The renderer cannot create a window itself — `setWindowOpenHandler` denies
 *   every `window.open` on purpose, and a renderer-created window would not
 *   get the preload bridge anyway. So this is a request to main, which owns
 *   window creation, the menu, and the path allow-list.
 *
 *   **What travels between windows.** Only a serialisable session descriptor:
 *   view type, paths, and the light per-view settings `getSerialisableTabs()`
 *   already produces for workspaces. Deliberately not the loaded file
 *   contents — a moved tab re-reads from disk, which is both cheaper than
 *   shipping megabytes over IPC and correct, since the file may have changed.
 *
 *   **Why moving a tab does not need re-authorisation.** Allowed roots live in
 *   the main process, per process rather than per window, so a path the first
 *   window was permitted to open stays permitted. Re-registering the incoming
 *   paths here would be the actual danger: it would widen the allow-list from
 *   renderer-supplied data, which is precisely what `validatePath` exists to
 *   prevent.
 */

/**
 * Whether this build can open another window.
 *
 * Older packaged builds lack the IPC, and the caller shows the command as
 * unavailable rather than letting a click do nothing.
 *
 * @returns {boolean}
 */
export function canOpenWindows() {
  return typeof window.electronAPI?.openNewWindow === 'function'
}

/**
 * Open an empty second window, on the home view.
 *
 * @returns {Promise<boolean>} false when the build cannot do it
 */
export async function openNewWindow() {
  if (!canOpenWindows()) return false
  await window.electronAPI.openNewWindow(null)
  return true
}

/**
 * Open a new window that adopts one session.
 *
 * The caller closes its own tab only after this resolves. Closing first would
 * lose the session outright if window creation failed, and a comparison the
 * user was in the middle of is not something to drop on an error path.
 *
 * @param {object} tabState a serialisable session descriptor
 * @returns {Promise<boolean>} false when the build cannot do it
 */
export async function moveTabToNewWindow(tabState) {
  if (!canOpenWindows() || !tabState) return false
  await window.electronAPI.openNewWindow(tabState)
  return true
}

/**
 * Finish a tab drag at a screen point.
 *
 * The renderer cannot tell which window is under the cursor — it does not know
 * where its own window sits on the desktop, let alone anyone else's — so the
 * point goes to main, which owns the window list. Released over another
 * window, the session moves there; released over no window at all, it tears
 * off into a new one, which is what dragging a tab out of a browser does.
 *
 * @param {object} tabState
 * @param {number} screenX
 * @param {number} screenY
 * @returns {Promise<{moved: boolean, newWindow?: boolean}>}
 */
export async function dropTabAt(tabState, screenX, screenY) {
  if (typeof window.electronAPI?.dropTabAt !== 'function' || !tabState) {
    return { moved: false }
  }
  return await window.electronAPI.dropTabAt(tabState, screenX, screenY) ?? { moved: false }
}

/**
 * Subscribe to a session handed over by whichever window opened this one.
 *
 * Main sends it once this window reports `did-finish-load`; anything sent
 * earlier would arrive before the renderer had subscribed and be lost, which
 * is the same reason the CLI file hand-off waits for that event.
 *
 * @param {(session: object) => void} handler
 * @returns {boolean} false when the build cannot do it
 */
export function onAdoptSession(handler) {
  if (typeof window.electronAPI?.onAdoptSession !== 'function') return false
  window.electronAPI.onAdoptSession((session) => {
    if (session && typeof session === 'object') handler(session)
  })
  return true
}
