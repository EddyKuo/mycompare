import { describe, it, expect, vi } from 'vitest'

// Mock electron so index.js can be imported in a Node test environment
vi.mock('electron', () => ({
  app: {
    whenReady: () => ({ then: () => {} }),
    on: () => {},
    quit: () => {},
  },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    on() {}
    once() {}
    loadURL() {}
    loadFile() {}
    webContents = { openDevTools() {}, once() {}, send() {} }
  },
  ipcMain: { handle: () => {} },
  dialog: {},
  shell: {},
}))

import { parseCliArgs } from '../../src/main/index.js'

describe('parseCliArgs', () => {
  it('should return empty array for no args', () => {
    expect(parseCliArgs(['electron', 'app.js'])).toEqual([])
  })

  it('should return one file path', () => {
    expect(parseCliArgs(['electron', 'app.js', '/path/to/file.txt'])).toEqual(['/path/to/file.txt'])
  })

  it('should return two file paths', () => {
    expect(parseCliArgs(['electron', 'app.js', '/left.txt', '/right.txt'])).toEqual(['/left.txt', '/right.txt'])
  })

  it('should skip flags starting with --', () => {
    expect(parseCliArgs(['electron', 'app.js', '--inspect', '/file.txt'])).toEqual(['/file.txt'])
  })

  it('should only return first two non-flag args', () => {
    expect(parseCliArgs(['electron', 'app.js', '/a.txt', '/b.txt', '/c.txt'])).toEqual(['/a.txt', '/b.txt'])
  })
})
