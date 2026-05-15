import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { formatSize, debounce, el } from '../../src/renderer/src/core/utils.js'

describe('formatSize', () => {
  it('returns empty string for null', () => {
    expect(formatSize(null)).toBe('')
  })
  it('returns empty string for undefined', () => {
    expect(formatSize(undefined)).toBe('')
  })
  it('returns "0 B" for 0', () => {
    expect(formatSize(0)).toBe('0 B')
  })
  it('formats bytes', () => {
    expect(formatSize(512)).toBe('512 B')
  })
  it('formats kilobytes', () => {
    expect(formatSize(1024)).toBe('1.0 KB')
  })
  it('formats megabytes', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
  })
  it('formats gigabytes', () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB')
  })
})

describe('debounce', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('delays fn execution by given ms', () => {
    const fn = vi.fn()
    const dFn = debounce(fn, 100)
    dFn('a')
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledWith('a')
  })

  it('resets timer on repeated calls', () => {
    const fn = vi.fn()
    const dFn = debounce(fn, 100)
    dFn('a')
    vi.advanceTimersByTime(50)
    dFn('b')
    vi.advanceTimersByTime(50)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith('b')
  })
})

describe('el', () => {
  it('creates element with tag', () => {
    const node = el('div')
    expect(node.tagName).toBe('DIV')
  })
  it('sets className', () => {
    const node = el('span', { className: 'foo' })
    expect(node.className).toBe('foo')
  })
  it('sets textContent', () => {
    const node = el('p', { textContent: 'hello' })
    expect(node.textContent).toBe('hello')
  })
  it('sets arbitrary attribute', () => {
    const node = el('input', { type: 'checkbox' })
    expect(node.getAttribute('type')).toBe('checkbox')
  })
  it('appends string children', () => {
    const node = el('div', {}, 'text')
    expect(node.textContent).toBe('text')
  })
  it('skips null children', () => {
    const node = el('div', {}, null, 'ok')
    expect(node.textContent).toBe('ok')
  })
  it('appends element children', () => {
    const child = el('span', { textContent: 'child' })
    const node = el('div', {}, child)
    expect(node.firstChild).toBe(child)
  })
})
