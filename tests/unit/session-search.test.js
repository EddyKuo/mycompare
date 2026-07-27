/**
 * @vitest-environment jsdom
 *
 * Searching the saved sessions on the home view.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  filterSessions,
  renderRecentSessions,
  _resetSessionSearch,
  store,
} from '../../src/renderer/src/core/session-home-ui.js'

const session = (name, left = '', right = '', type = 'text') => ({
  id: name, name, type, updatedAt: new Date().toISOString(),
  options: { leftPath: left, rightPath: right },
})

describe('filterSessions', () => {
  const sessions = [
    session('Nightly build', 'C:/work/build-2024/out.log', 'C:/work/build-2023/out.log'),
    session('API schema', '/srv/api/schema.json', '/srv/api/schema.new.json'),
    session('Photos', 'D:/pics/2024', 'D:/pics/2023', 'image'),
  ]

  it('returns everything for an empty query', () => {
    expect(filterSessions(sessions, '')).toHaveLength(3)
    expect(filterSessions(sessions, '   ')).toHaveLength(3)
    expect(filterSessions(sessions, null)).toHaveLength(3)
  })

  it('matches the name', () => {
    expect(filterSessions(sessions, 'nightly').map((s) => s.name)).toEqual(['Nightly build'])
  })

  it('matches a fragment buried in a path', () => {
    // People remember a folder name, not the string a path starts with, so a
    // prefix match would miss the common case.
    expect(filterSessions(sessions, 'build-2023').map((s) => s.name)).toEqual(['Nightly build'])
    expect(filterSessions(sessions, 'schema.new').map((s) => s.name)).toEqual(['API schema'])
  })

  it('ignores case', () => {
    expect(filterSessions(sessions, 'PHOTOS')).toHaveLength(1)
  })

  it('matches the session type', () => {
    expect(filterSessions(sessions, 'image').map((s) => s.name)).toEqual(['Photos'])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterSessions(sessions, 'zzz')).toEqual([])
  })

  it('survives sessions with missing fields', () => {
    expect(() => filterSessions([{}, null, { options: null }], 'x')).not.toThrow()
  })
})

describe('the search box on the home view', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="session-home"></div>'
    _resetSessionSearch()
    vi.restoreAllMocks()
  })

  it('looks past the ten most recent, or it can only find what is already shown', () => {
    const spy = vi.spyOn(store, 'getRecent').mockReturnValue([])
    renderRecentSessions(() => {}, () => {})
    expect(spy).toHaveBeenLastCalledWith(10)

    const input = document.querySelector('.session-search')
    input.value = 'anything'
    input.dispatchEvent(new Event('input'))
    expect(spy.mock.calls.at(-1)[0]).toBeGreaterThan(10)
  })

  it('filters the rendered list', () => {
    vi.spyOn(store, 'getRecent').mockReturnValue([
      session('Alpha', '/a/one.txt', '/a/two.txt'),
      session('Beta', '/b/one.txt', '/b/two.txt'),
    ])
    renderRecentSessions(() => {}, () => {})
    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.textContent).toContain('Beta')

    const input = document.querySelector('.session-search')
    input.value = 'alpha'
    input.dispatchEvent(new Event('input'))

    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.textContent).not.toContain('Beta')
  })

  it('keeps the query and the focus across the re-render', () => {
    // Re-rendering replaces the input; without restoring focus every keystroke
    // after the first would land nowhere.
    vi.spyOn(store, 'getRecent').mockReturnValue([session('Alpha')])
    renderRecentSessions(() => {}, () => {})
    const input = document.querySelector('.session-search')
    input.value = 'alp'
    input.dispatchEvent(new Event('input'))

    const after = document.querySelector('.session-search')
    expect(after.value).toBe('alp')
    expect(document.activeElement).toBe(after)
  })

  it('says why the list is empty when a search excluded everything', () => {
    vi.spyOn(store, 'getRecent').mockReturnValue([session('Alpha')])
    renderRecentSessions(() => {}, () => {})
    const input = document.querySelector('.session-search')
    input.value = 'nothing matches this'
    input.dispatchEvent(new Event('input'))

    // "尚無最近記錄" would be a lie: there are sessions, just none matching.
    expect(document.body.textContent).toContain('找不到符合')
    expect(document.body.textContent).not.toContain('尚無最近記錄')
  })
})
