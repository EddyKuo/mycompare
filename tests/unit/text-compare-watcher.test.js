/**
 * @vitest-environment jsdom
 *
 * T33 — File Watcher tests for TextCompare renderer logic.
 *
 * Tests:
 *  1. _showFileChangedToast creates a .tc-toast element in document.body
 *  2. _showFileChangedToast removes the toast after 2 seconds
 *  3. onFileChanged callback for left-side path re-reads file and calls _runDiff
 *  4. onFileChanged callback for right-side path re-reads file and calls _runDiff
 *  5. setLeft calls watchFile on electronAPI with the given path
 *  6. setRight calls watchFile on electronAPI with the given path
 *  7. setLeft unwatches old path when switching to a new path
 *  8. setRight unwatches old path when switching to a new path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks required before import ─────────────────────────────────────────────

/** Captured onFileChanged callback registered via electronAPI.onFileChanged */
let _fileChangedCb = null

const mockElectronAPI = {
  openFile: vi.fn(),
  saveFile: vi.fn(),
  readFile: vi.fn(),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  onFileChanged: vi.fn((cb) => { _fileChangedCb = cb }),
}

Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: mockElectronAPI,
    getSelection: vi.fn(() => null),
  },
  writable: true,
})

// ── Helper ────────────────────────────────────────────────────────────────────

let TextCompare

async function makeTC() {
  if (!TextCompare) {
    const mod = await import('../../src/renderer/src/views/text-compare.js')
    TextCompare = mod.TextCompare
  }

  const tc = new TextCompare()
  // Bypass mount() — wire only the fields our tests need
  tc._mounted = true
  tc._contentLeft  = { querySelectorAll: vi.fn(() => []), contains: vi.fn(() => true), scrollTop: 0 }
  tc._contentRight = { querySelectorAll: vi.fn(() => []), contains: vi.fn(() => false), scrollTop: 0 }
  tc._findBar    = null
  tc._findInput  = null
  tc._findCount  = null
  tc._statusEol  = null
  tc._statusEncoding = null
  tc._statusLines    = null
  tc._statusMessage  = null
  tc._diffCounter    = null
  tc._minimap        = null
  tc._minimapViewport = null
  tc._pathLeft   = null
  tc._pathRight  = null
  return tc
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('T33 — _showFileChangedToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Reset body
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('test_showFileChangedToast_left_creates_tc-toast_element', async () => {
    const tc = await makeTC()
    tc._showFileChangedToast('left')

    const toast = document.body.querySelector('.tc-toast')
    expect(toast).not.toBeNull()
    expect(toast.textContent).toBe('左側檔案已更新，已自動重新比對')
  })

  it('test_showFileChangedToast_right_creates_tc-toast_element', async () => {
    const tc = await makeTC()
    tc._showFileChangedToast('right')

    const toast = document.body.querySelector('.tc-toast')
    expect(toast).not.toBeNull()
    expect(toast.textContent).toBe('右側檔案已更新，已自動重新比對')
  })

  it('test_showFileChangedToast_removes_element_after_2000ms', async () => {
    const tc = await makeTC()
    tc._showFileChangedToast('left')

    expect(document.body.querySelector('.tc-toast')).not.toBeNull()
    vi.advanceTimersByTime(2000)
    expect(document.body.querySelector('.tc-toast')).toBeNull()
  })
})

describe('T33 — onFileChanged callback triggers _runDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _fileChangedCb = null
    document.body.innerHTML = ''
  })

  it('test_onFileChanged_left_path_reloads_content_and_runs_diff', async () => {
    const tc = await makeTC()
    const runDiffSpy = vi.spyOn(tc, '_runDiff').mockImplementation(() => {})
    const toastSpy   = vi.spyOn(tc, '_showFileChangedToast').mockImplementation(() => {})

    tc._leftPath    = '/tmp/left.txt'
    tc._leftContent = 'old content\n'
    tc._rightPath   = '/tmp/right.txt'
    tc._rightContent = 'right content\n'

    // Simulate registering the onFileChanged handler (as mount() would do)
    window.electronAPI.onFileChanged(({ path }) => {
      if (!tc._mounted) return
      if (path === tc._leftPath) {
        window.electronAPI.readFile(path).then(result => {
          if (!result) return
          tc._leftContent = result.content
          tc._runDiff()
          tc._showFileChangedToast('left')
        })
      }
    })

    mockElectronAPI.readFile.mockResolvedValueOnce({ path: '/tmp/left.txt', content: 'new content\n' })

    // Fire the callback and flush all pending microtasks (two ticks for the .then chain)
    await _fileChangedCb({ path: '/tmp/left.txt' })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockElectronAPI.readFile).toHaveBeenCalledWith('/tmp/left.txt')
    expect(tc._leftContent).toBe('new content\n')
    expect(runDiffSpy).toHaveBeenCalled()
    expect(toastSpy).toHaveBeenCalledWith('left')
  })

  it('test_onFileChanged_right_path_reloads_content_and_runs_diff', async () => {
    const tc = await makeTC()
    const runDiffSpy = vi.spyOn(tc, '_runDiff').mockImplementation(() => {})
    const toastSpy   = vi.spyOn(tc, '_showFileChangedToast').mockImplementation(() => {})

    tc._leftPath     = '/tmp/left.txt'
    tc._leftContent  = 'left content\n'
    tc._rightPath    = '/tmp/right.txt'
    tc._rightContent = 'old right\n'

    window.electronAPI.onFileChanged(({ path }) => {
      if (!tc._mounted) return
      if (path === tc._rightPath) {
        window.electronAPI.readFile(path).then(result => {
          if (!result) return
          tc._rightContent = result.content
          tc._runDiff()
          tc._showFileChangedToast('right')
        })
      }
    })

    mockElectronAPI.readFile.mockResolvedValueOnce({ path: '/tmp/right.txt', content: 'new right\n' })

    await _fileChangedCb({ path: '/tmp/right.txt' })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockElectronAPI.readFile).toHaveBeenCalledWith('/tmp/right.txt')
    expect(tc._rightContent).toBe('new right\n')
    expect(runDiffSpy).toHaveBeenCalled()
    expect(toastSpy).toHaveBeenCalledWith('right')
  })

  it('test_onFileChanged_unrelated_path_does_not_call_runDiff', async () => {
    const tc = await makeTC()
    const runDiffSpy = vi.spyOn(tc, '_runDiff').mockImplementation(() => {})

    tc._leftPath  = '/tmp/left.txt'
    tc._rightPath = '/tmp/right.txt'

    window.electronAPI.onFileChanged(({ path }) => {
      if (!tc._mounted) return
      if (path === tc._leftPath || path === tc._rightPath) {
        window.electronAPI.readFile(path).then(result => {
          if (!result) return
          tc._runDiff()
        })
      }
    })

    await _fileChangedCb({ path: '/tmp/unrelated.txt' })
    await Promise.resolve()

    expect(mockElectronAPI.readFile).not.toHaveBeenCalled()
    expect(runDiffSpy).not.toHaveBeenCalled()
  })
})

describe('T33 — setLeft / setRight watchFile integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('test_setLeft_calls_watchFile_with_path', async () => {
    const tc = await makeTC()
    // Prevent actual diff from running
    vi.spyOn(tc, '_runDiff').mockImplementation(() => {})

    tc.setLeft('/tmp/a.txt', 'content a\n')

    expect(mockElectronAPI.watchFile).toHaveBeenCalledWith('/tmp/a.txt')
  })

  it('test_setRight_calls_watchFile_with_path', async () => {
    const tc = await makeTC()
    vi.spyOn(tc, '_runDiff').mockImplementation(() => {})

    tc.setRight('/tmp/b.txt', 'content b\n')

    expect(mockElectronAPI.watchFile).toHaveBeenCalledWith('/tmp/b.txt')
  })

  it('test_setLeft_unwatches_old_path_when_switching', async () => {
    const tc = await makeTC()
    vi.spyOn(tc, '_runDiff').mockImplementation(() => {})

    tc._leftPath = '/tmp/old-left.txt'
    tc.setLeft('/tmp/new-left.txt', 'new content\n')

    expect(mockElectronAPI.unwatchFile).toHaveBeenCalledWith('/tmp/old-left.txt')
    expect(mockElectronAPI.watchFile).toHaveBeenCalledWith('/tmp/new-left.txt')
  })

  it('test_setRight_unwatches_old_path_when_switching', async () => {
    const tc = await makeTC()
    vi.spyOn(tc, '_runDiff').mockImplementation(() => {})

    tc._rightPath = '/tmp/old-right.txt'
    tc.setRight('/tmp/new-right.txt', 'new content\n')

    expect(mockElectronAPI.unwatchFile).toHaveBeenCalledWith('/tmp/old-right.txt')
    expect(mockElectronAPI.watchFile).toHaveBeenCalledWith('/tmp/new-right.txt')
  })
})
