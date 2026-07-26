/**
 * @vitest-environment jsdom
 *
 * Session folder organisation.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  ROOT_GROUP,
  loadGroups,
  saveGroups,
  normalizeGroupState,
  addGroup,
  removeGroup,
  renameGroup,
  assignSession,
  buildGroupTree,
  flattenGroups,
} from '../../src/renderer/src/core/session-groups.js'

beforeEach(() => localStorage.clear())

const sessions = (...ids) => ids.map((id) => ({ id }))

describe('persistence', () => {
  it('starts empty', () => {
    expect(loadGroups()).toEqual({ groups: [], membership: {} })
  })

  it('round-trips', () => {
    const { state } = addGroup({ groups: [], membership: {} }, '專案 A')
    saveGroups(state)
    expect(loadGroups().groups.map((g) => g.name)).toEqual(['專案 A'])
  })

  it('survives corrupt storage rather than throwing', () => {
    localStorage.setItem('mycompare:sessionGroups', '{not json')
    expect(loadGroups()).toEqual({ groups: [], membership: {} })
  })

  it('reads a bare legacy shape without the schema envelope', () => {
    localStorage.setItem('mycompare:sessionGroups', JSON.stringify({
      groups: [{ id: 'g1', name: 'Old', parentId: '' }],
      membership: { s1: 'g1' },
    }))
    const state = loadGroups()
    expect(state.groups).toHaveLength(1)
    expect(state.membership.s1).toBe('g1')
  })
})

describe('normalizeGroupState', () => {
  it('drops entries with no id or no name', () => {
    const { groups } = normalizeGroupState({
      groups: [
        { id: 'g1', name: 'ok' },
        { id: '', name: 'no id' },
        { id: 'g2', name: '   ' },
        null,
      ],
    })
    expect(groups.map((g) => g.id)).toEqual(['g1'])
  })

  it('trims names', () => {
    expect(normalizeGroupState({ groups: [{ id: 'g', name: '  x  ' }] }).groups[0].name)
      .toBe('x')
  })

  it('de-duplicates ids', () => {
    const { groups } = normalizeGroupState({
      groups: [{ id: 'g', name: 'first' }, { id: 'g', name: 'second' }],
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].name).toBe('first')
  })

  it('re-parents a group whose parent does not exist', () => {
    const { groups } = normalizeGroupState({
      groups: [{ id: 'g1', name: 'x', parentId: 'ghost' }],
    })
    expect(groups[0].parentId).toBe(ROOT_GROUP)
  })

  it('breaks a parent cycle rather than looping forever', () => {
    // Hand-edited storage can produce this; a tree walk over it never ends.
    const { groups } = normalizeGroupState({
      groups: [
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' },
      ],
    })
    const roots = groups.filter((g) => g.parentId === ROOT_GROUP)
    expect(roots.length).toBeGreaterThan(0)
    // The tree must terminate.
    expect(() => buildGroupTree({ groups, membership: {} }, [])).not.toThrow()
  })

  it('discards membership pointing at a group that is gone', () => {
    const { membership } = normalizeGroupState({
      groups: [{ id: 'g1', name: 'x' }],
      membership: { s1: 'g1', s2: 'ghost' },
    })
    expect(membership).toEqual({ s1: 'g1' })
  })

  it('tolerates junk input', () => {
    expect(normalizeGroupState(undefined)).toEqual({ groups: [], membership: {} })
    expect(normalizeGroupState({ groups: 'nope', membership: 5 }))
      .toEqual({ groups: [], membership: {} })
  })
})

describe('addGroup', () => {
  it('adds a top-level group', () => {
    const { state, group } = addGroup({ groups: [], membership: {} }, 'A')
    expect(group.parentId).toBe(ROOT_GROUP)
    expect(state.groups).toHaveLength(1)
  })

  it('nests under an existing parent', () => {
    const first = addGroup({ groups: [], membership: {} }, 'A')
    const second = addGroup(first.state, 'B', first.group.id)
    expect(second.group.parentId).toBe(first.group.id)
  })

  it('falls back to the root for an unknown parent', () => {
    const { group } = addGroup({ groups: [], membership: {} }, 'A', 'ghost')
    expect(group.parentId).toBe(ROOT_GROUP)
  })

  it('refuses a blank name', () => {
    const { group, state } = addGroup({ groups: [], membership: {} }, '   ')
    expect(group).toBeNull()
    expect(state.groups).toEqual([])
  })
})

describe('removeGroup', () => {
  it('moves children and sessions up rather than deleting them', () => {
    // Losing a folder must not lose the work filed under it.
    let s = { groups: [], membership: {} }
    const parent = addGroup(s, 'Parent'); s = parent.state
    const child = addGroup(s, 'Child', parent.group.id); s = child.state
    s = assignSession(s, 'sess1', parent.group.id)

    s = removeGroup(s, parent.group.id)
    expect(s.groups.map((g) => g.name)).toEqual(['Child'])
    expect(s.groups[0].parentId).toBe(ROOT_GROUP)
    expect(s.membership.sess1).toBeUndefined()

    const tree = buildGroupTree(s, sessions('sess1'))
    expect(tree.sessions.map((x) => x.id)).toEqual(['sess1'])
  })

  it('ignores an unknown id', () => {
    const { state } = addGroup({ groups: [], membership: {} }, 'A')
    expect(removeGroup(state, 'ghost').groups).toHaveLength(1)
  })
})

describe('renameGroup', () => {
  it('renames', () => {
    const { state, group } = addGroup({ groups: [], membership: {} }, 'A')
    expect(renameGroup(state, group.id, 'B').groups[0].name).toBe('B')
  })

  it('refuses a blank name', () => {
    const { state, group } = addGroup({ groups: [], membership: {} }, 'A')
    expect(renameGroup(state, group.id, '  ').groups[0].name).toBe('A')
  })
})

describe('assignSession', () => {
  it('files and un-files a session', () => {
    let s = { groups: [], membership: {} }
    const g = addGroup(s, 'A'); s = g.state
    s = assignSession(s, 'sess1', g.group.id)
    expect(s.membership.sess1).toBe(g.group.id)
    s = assignSession(s, 'sess1', ROOT_GROUP)
    expect(s.membership.sess1).toBeUndefined()
  })

  it('ignores an unknown group', () => {
    const s = assignSession({ groups: [], membership: {} }, 'sess1', 'ghost')
    expect(s.membership.sess1).toBeUndefined()
  })
})

describe('buildGroupTree', () => {
  it('nests groups and files sessions into them', () => {
    let s = { groups: [], membership: {} }
    const a = addGroup(s, 'A'); s = a.state
    const b = addGroup(s, 'B', a.group.id); s = b.state
    s = assignSession(s, 's1', a.group.id)
    s = assignSession(s, 's2', b.group.id)

    const tree = buildGroupTree(s, sessions('s1', 's2', 's3'))
    expect(tree.sessions.map((x) => x.id)).toEqual(['s3'])
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].group.name).toBe('A')
    expect(tree.children[0].sessions.map((x) => x.id)).toEqual(['s1'])
    expect(tree.children[0].children[0].sessions.map((x) => x.id)).toEqual(['s2'])
  })

  it('surfaces a session whose group is unknown at the root', () => {
    const tree = buildGroupTree(
      { groups: [], membership: { s1: 'ghost' } }, sessions('s1'))
    expect(tree.sessions.map((x) => x.id)).toEqual(['s1'])
  })

  it('sorts sibling groups by name', () => {
    let s = { groups: [], membership: {} }
    s = addGroup(s, 'Zeta').state
    s = addGroup(s, 'Alpha').state
    expect(buildGroupTree(s, []).children.map((c) => c.group.name))
      .toEqual(['Alpha', 'Zeta'])
  })

  it('tolerates a missing session list', () => {
    expect(buildGroupTree({ groups: [], membership: {} }, undefined).sessions).toEqual([])
  })
})

describe('flattenGroups', () => {
  it('lists groups depth-first with their depth', () => {
    let s = { groups: [], membership: {} }
    const a = addGroup(s, 'A'); s = a.state
    const b = addGroup(s, 'B', a.group.id); s = b.state

    expect(flattenGroups(s)).toEqual([
      { id: a.group.id, name: 'A', depth: 0 },
      { id: b.group.id, name: 'B', depth: 1 },
    ])
  })

  it('is empty when there are no groups', () => {
    expect(flattenGroups({ groups: [], membership: {} })).toEqual([])
  })
})
