/**
 * @vitest-environment jsdom
 *
 * Drag & drop for the hex, table and three-way views, plus the three-way
 * merge's report generators.
 *
 * The drop path is tested through the DOM events a real drop fires, not by
 * calling the private handler, because the part that regressed before was the
 * wiring: listeners that were never attached, and listeners that were never
 * removed on destroy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HexCompare } from '../../src/renderer/src/views/hex-compare.js'
import { TableCompare, MAX_TABLE_CHARS } from '../../src/renderer/src/views/table-compare.js'
import { ThreeWayCompare, MAX_MERGE_CHARS } from '../../src/renderer/src/views/three-way-compare.js'

/** @type {HTMLElement[]} */
let hosts = []

/**
 * A File the page constructs carries no path — which is the whole point of
 * handing File objects to preload rather than strings. Tests therefore assert
 * on what the view does with what preload answers.
 * @returns {File}
 */
function fakeFile() {
  return new File(['x'], 'dropped.txt')
}

/**
 * @param {HTMLElement} node
 * @param {string} type
 * @param {File[]} [files]
 * @returns {Event}
 */
function fireDrag(node, type, files = []) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, dropEffect: 'none' } })
  node.dispatchEvent(event)
  return event
}

/** @returns {HTMLElement} */
function newHost() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  hosts.push(host)
  return host
}

beforeEach(() => {
  vi.stubGlobal('alert', vi.fn())
  window.electronAPI = {
    acceptDroppedFiles: vi.fn(async () => [{ path: '/tmp/dropped.txt', isDirectory: false }]),
    readFile: vi.fn(async (path) => ({ path, content: 'a,b\n1,2\n' })),
    readFileBinary: vi.fn(async (path) => ({
      path, base64: 'AAECAw==', ext: 'bin', size: 4, truncated: false,
    })),
    readExcel: vi.fn(async () => ({ sheetNames: ['S1'], sheets: { S1: 'a,b\n1,2\n' } })),
    saveFile: vi.fn(async () => ({ saved: true })),
    openFile: vi.fn(async () => null),
  }
})

afterEach(() => {
  for (const host of hosts) host.remove()
  hosts = []
  vi.unstubAllGlobals()
  delete window.electronAPI
})

/**
 * Mount each view and hand back the pane elements a drop can land on, so the
 * shared expectations below can be written once.
 *
 * @returns {Array<{
 *   name: string, view: any, panes: Array<{ side: string, node: HTMLElement }>,
 *   dragClass: string
 * }>}
 */
function mountAll() {
  const hex = new HexCompare()
  hex.mount(newHost())

  const table = new TableCompare()
  table.mount(newHost())

  const merge = new ThreeWayCompare()
  merge.mount(newHost())

  return [
    {
      name: 'hex', view: hex, dragClass: 'hx-drop-target',
      panes: [
        { side: 'left', node: hex._dom.pane_left },
        { side: 'right', node: hex._dom.pane_right },
      ],
    },
    {
      name: 'table', view: table, dragClass: 'tc-drop-target',
      panes: [
        { side: 'left', node: table._dom.leftPane },
        { side: 'right', node: table._dom.rightPane },
      ],
    },
    {
      name: 'merge3', view: merge, dragClass: 'mw-drop-target',
      panes: ['left', 'base', 'right'].map((side) => ({
        side, node: merge._container.querySelector(`.mw-pane--${side}`),
      })),
    },
  ]
}

describe('drag & drop wiring', () => {
  it('every input pane of every view is a drop target', () => {
    for (const { name, panes, dragClass } of mountAll()) {
      for (const { side, node } of panes) {
        expect(node, `${name}/${side} pane exists`).toBeTruthy()
        fireDrag(node, 'dragover')
        expect(node.classList.contains(dragClass), `${name}/${side} highlights`).toBe(true)
        fireDrag(node, 'dragleave')
        expect(node.classList.contains(dragClass), `${name}/${side} un-highlights`).toBe(false)
      }
    }
  })

  it('dragover is cancelled so the OS does not navigate away', () => {
    for (const { panes } of mountAll()) {
      const event = fireDrag(panes[0].node, 'dragover')
      expect(event.defaultPrevented).toBe(true)
    }
  })

  it('destroy removes the listeners', () => {
    for (const { name, view, panes, dragClass } of mountAll()) {
      // Held from before destroy: the view empties its container, so after
      // destroy the node is only reachable through a reference like this one —
      // which is exactly what a leaked listener would keep alive.
      const node = panes[0].node
      view.destroy()
      fireDrag(node, 'dragover')
      expect(node.classList.contains(dragClass), `${name} listener removed`).toBe(false)
    }
  })
})

describe('drag & drop error reporting', () => {
  /**
   * @param {any} view
   * @returns {Array<{ message: string, level: string }>}
   */
  function captureStatus(view) {
    /** @type {Array<{ message: string, level: string }>} */
    const seen = []
    view.on('status', (payload) => seen.push(payload))
    return seen
  }

  it('reports a refused authorisation', async () => {
    for (const { name, view, panes } of mountAll()) {
      const seen = captureStatus(view)
      window.electronAPI.acceptDroppedFiles = vi.fn(async () => { throw new Error('拒絕') })
      fireDrag(panes[0].node, 'drop', [fakeFile()])
      await vi.waitFor(() => expect(seen.length, name).toBe(1))
      expect(seen[0].level).toBe('error')
      expect(seen[0].message).toContain('拒絕')
    }
  })

  it('reports a File whose path could not be resolved', async () => {
    for (const { name, view, panes } of mountAll()) {
      const seen = captureStatus(view)
      window.electronAPI.acceptDroppedFiles = vi.fn(async () => [])
      fireDrag(panes[0].node, 'drop', [fakeFile()])
      await vi.waitFor(() => expect(seen.length, name).toBe(1))
      expect(seen[0]).toEqual({ message: '無法取得拖放檔案的路徑', level: 'error' })
    }
  })

  it('reports a dropped folder instead of silently loading nothing', async () => {
    for (const { name, view, panes } of mountAll()) {
      const seen = captureStatus(view)
      window.electronAPI.acceptDroppedFiles =
        vi.fn(async () => [{ path: '/tmp/dir', isDirectory: true }])
      fireDrag(panes[0].node, 'drop', [fakeFile()])
      await vi.waitFor(() => expect(seen.length, name).toBe(1))
      expect(seen[0].message).toContain('資料夾')
      expect(seen[0].level).toBe('error')
    }
  })

  it('falls back to a visible toast when the host wired no status listener', async () => {
    for (const { name, panes } of mountAll()) {
      window.electronAPI.acceptDroppedFiles = vi.fn(async () => [])
      fireDrag(panes[0].node, 'drop', [fakeFile()])
      await vi.waitFor(() => {
        const toasts = [...document.querySelectorAll('.mc-toast--error')]
        expect(toasts.some((t) => t.textContent?.includes('無法取得拖放檔案的路徑')), name).toBe(true)
      })
      document.querySelectorAll('.mc-toast').forEach((t) => t.remove())
    }
    // A native dialog from a drop handler would block the renderer.
    expect(window.alert).not.toHaveBeenCalled()
  })

  it('reports a file over the size ceiling', async () => {
    const [hex, table, merge] = mountAll()

    const hexSeen = []
    hex.view.on('status', (p) => hexSeen.push(p))
    window.electronAPI.readFileBinary = vi.fn(async (path) => ({
      path, base64: 'AAECAw==', ext: 'bin', size: 99, truncated: true,
    }))
    fireDrag(hex.panes[0].node, 'drop', [fakeFile()])
    await vi.waitFor(() => expect(hexSeen.length).toBe(1))
    expect(hexSeen[0].message).toContain('超過大小上限')

    const tableSeen = []
    table.view.on('status', (p) => tableSeen.push(p))
    window.electronAPI.readFile =
      vi.fn(async (path) => ({ path, content: 'x'.repeat(MAX_TABLE_CHARS + 1) }))
    fireDrag(table.panes[0].node, 'drop', [fakeFile()])
    await vi.waitFor(() => expect(tableSeen.length).toBe(1))
    expect(tableSeen[0].message).toContain('超過大小上限')

    const mergeSeen = []
    merge.view.on('status', (p) => mergeSeen.push(p))
    window.electronAPI.readFile =
      vi.fn(async (path) => ({ path, content: 'x'.repeat(MAX_MERGE_CHARS + 1) }))
    fireDrag(merge.panes[0].node, 'drop', [fakeFile()])
    await vi.waitFor(() => expect(mergeSeen.length).toBe(1))
    expect(mergeSeen[0].message).toContain('超過大小上限')
    // Refused, not half-loaded.
    expect(merge.view.getPaneRows('left')).toEqual([])
  })
})

describe('drag & drop loading', () => {
  it('the pane that took the drop decides the side', async () => {
    const [hex, table, merge] = mountAll()

    fireDrag(hex.panes[1].node, 'drop', [fakeFile()])
    await vi.waitFor(() => expect(hex.view._rightPath).toBe('/tmp/dropped.txt'))
    expect(hex.view._leftPath).toBe(null)

    fireDrag(table.panes[1].node, 'drop', [fakeFile()])
    await vi.waitFor(() => expect(table.view._rightPath).toBe('/tmp/dropped.txt'))

    // The middle pane is reachable on its own: a three-way merge is unusable
    // if the base can only be set through the file dialog.
    fireDrag(merge.panes[1].node, 'drop', [fakeFile()])
    await vi.waitFor(() => expect(merge.view._basePath).toBe('/tmp/dropped.txt'))
    expect(merge.view._leftPath).toBe('')
    expect(merge.view._rightPath).toBe('')
  })

  it('two files fill both sides of a two-pane view', async () => {
    const [hex] = mountAll()
    window.electronAPI.acceptDroppedFiles = vi.fn(async () => [
      { path: '/tmp/one.bin', isDirectory: false },
      { path: '/tmp/two.bin', isDirectory: false },
    ])
    window.electronAPI.readFileBinary =
      vi.fn(async (path) => ({ path, base64: 'AAECAw==', ext: 'bin', size: 4, truncated: false }))

    fireDrag(hex.panes[0].node, 'drop', [fakeFile(), fakeFile()])
    await vi.waitFor(() => expect(hex.view._rightPath).toBe('/tmp/two.bin'))
    expect(hex.view._leftPath).toBe('/tmp/one.bin')
  })

  it('three files fill left, base and right of the merge view', async () => {
    const [, , merge] = mountAll()
    window.electronAPI.acceptDroppedFiles = vi.fn(async () => [
      { path: '/tmp/l.txt', isDirectory: false },
      { path: '/tmp/b.txt', isDirectory: false },
      { path: '/tmp/r.txt', isDirectory: false },
    ])
    fireDrag(merge.panes[0].node, 'drop', [fakeFile(), fakeFile(), fakeFile()])
    await vi.waitFor(() => expect(merge.view._rightPath).toBe('/tmp/r.txt'))
    expect(merge.view._leftPath).toBe('/tmp/l.txt')
    expect(merge.view._basePath).toBe('/tmp/b.txt')
  })

  it('a dropped workbook goes through the Excel reader', async () => {
    const [, table] = mountAll()
    window.electronAPI.acceptDroppedFiles =
      vi.fn(async () => [{ path: '/tmp/book.xlsx', isDirectory: false }])
    fireDrag(table.panes[0].node, 'drop', [fakeFile()])
    await vi.waitFor(() => expect(window.electronAPI.readExcel).toHaveBeenCalledWith('/tmp/book.xlsx'))
    expect(window.electronAPI.readFile).not.toHaveBeenCalled()
  })

  it('a large dropped file still renders only the visible rows', async () => {
    const [, , merge] = mountAll()
    const base = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n')
    window.electronAPI.readFile = vi.fn(async (path) => ({ path, content: base }))
    fireDrag(merge.panes[1].node, 'drop', [fakeFile()])
    await vi.waitFor(() => expect(merge.view.getPaneRows('base').length).toBe(20_000))

    const painted = merge.panes[1].node.querySelectorAll('.mw-line').length
    expect(painted).toBeGreaterThan(0)
    expect(painted).toBeLessThan(200)
  })
})

describe('three-way merge report', () => {
  const BASE = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
  const LEFT = ['a', 'L1', 'c', 'd', 'e', 'L2', 'g'].join('\n')
  const RIGHT = ['a', 'R1', 'c', 'd', 'e', 'R2', 'g'].join('\n')

  /** @returns {ThreeWayCompare} */
  function mountMerge() {
    const view = new ThreeWayCompare()
    view.mount(newHost())
    view.setSide('base', BASE, '/tmp/base.txt')
    view.setSide('left', LEFT, '/tmp/left.txt')
    view.setSide('right', RIGHT, '/tmp/right.txt')
    return view
  }

  it('duck-typing finds both generators, which is how the host detects support', () => {
    const view = mountMerge()
    expect(typeof view.buildTextReport).toBe('function')
    expect(typeof view.buildHtmlReport).toBe('function')
    expect(typeof view.exportHtml).toBe('function')
    expect(typeof view.exportTextReport).toBe('function')
  })

  it('summarises resolved and unresolved conflicts', () => {
    const view = mountMerge()
    expect(view.getConflictCount()).toBe(2)

    let summary = view.getConflictSummary()
    expect(summary).toMatchObject({ total: 2, resolved: 0, unresolved: 2 })
    expect(summary.items[0].baseLine).toBe(2)

    view.setConflictChoice(summary.items[0].id, 'left')
    summary = view.getConflictSummary()
    expect(summary).toMatchObject({ total: 2, resolved: 1, unresolved: 1 })
    expect(summary.items[0].choice).toBe('left')
  })

  it('the text report names all three sources and counts the conflicts', () => {
    const view = mountMerge()
    view.setConflictChoice(view.getConflictSummary().items[0].id, 'right')
    const text = view.buildTextReport({ generatedAt: new Date('2026-01-02T03:04:05Z') })

    expect(text).toContain('/tmp/left.txt')
    expect(text).toContain('/tmp/base.txt')
    expect(text).toContain('/tmp/right.txt')
    expect(text).toContain('2026-01-02 03:04:05')
    expect(text).toContain('衝突 2，已解決 1，未解決 1')
    expect(text).toContain('採用右側')
    expect(text).toContain('未解決')
    // Conflict content, so the report can be read without the files at hand.
    expect(text).toContain('L2')
  })

  it('a conflict-free merge says so instead of printing an empty table', () => {
    const view = new ThreeWayCompare()
    view.mount(newHost())
    view.setSide('base', BASE, '/tmp/base.txt')
    view.setSide('left', BASE, '/tmp/left.txt')
    view.setSide('right', BASE, '/tmp/right.txt')

    expect(view.buildTextReport()).toContain('沒有衝突')
    expect(view.buildHtmlReport()).toContain('沒有衝突')
  })

  it('caps the listing and says how many were left out', () => {
    // Every other line conflicts, which is more conflicts than any listing
    // should print in full.
    const n = 60
    const base = Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')
    const left = base.split('\n').map((l, i) => (i % 2 ? `L${i}` : l)).join('\n')
    const right = base.split('\n').map((l, i) => (i % 2 ? `R${i}` : l)).join('\n')

    const view = new ThreeWayCompare()
    view.mount(newHost())
    view.setSide('base', base, '/tmp/base.txt')
    view.setSide('left', left, '/tmp/left.txt')
    view.setSide('right', right, '/tmp/right.txt')

    const total = view.getConflictCount()
    expect(total).toBeGreaterThan(5)

    const text = view.buildTextReport({ maxConflicts: 5 })
    expect(text).toContain(`另有 ${total - 5} 個衝突未列出`)

    const html = view.buildHtmlReport({ maxConflicts: 5 })
    expect(html).toContain(`另有 ${total - 5} 個衝突未列出`)
    // One cell per listed conflict; the header row has no preview cell.
    expect(html.match(/<td class="preview">/g)?.length).toBe(5)
  })

  it('the HTML report is self-contained and escapes file content', () => {
    const view = new ThreeWayCompare()
    view.mount(newHost())
    view.setSide('base', 'a\nb\nc', '/tmp/base.txt')
    view.setSide('left', 'a\n<script>alert(1)</script>\nc', '/tmp/left.txt')
    view.setSide('right', 'a\nR\nc', '/tmp/right.txt')

    const html = view.buildHtmlReport()
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('@media print')
    // Nothing may be fetched from outside the file itself.
    expect(html).not.toMatch(/<(script|link)\s/i)
  })

  it('exportTextReport writes through the save IPC', async () => {
    const view = mountMerge()
    await view.exportTextReport()
    expect(window.electronAPI.saveFile).toHaveBeenCalledWith(
      'merge-report.txt', expect.stringContaining('三向合併報告'), expect.any(Array))
  })

  it('exportHtml writes through the save IPC', async () => {
    const view = mountMerge()
    await view.exportHtml()
    expect(window.electronAPI.saveFile).toHaveBeenCalledWith(
      'merge-report.html', expect.stringContaining('<!DOCTYPE html>'), expect.any(Array))
  })
})
