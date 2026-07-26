/**
 * @file session-groups.js
 * @description Folder organisation for saved sessions.
 *
 *   Beyond Compare's home screen is a tree: sessions live in named folders the
 *   user creates. Once someone has more than a handful of comparisons a flat
 *   recent list stops being navigable, which is the problem this solves.
 *
 *   Group membership is stored separately from the sessions themselves so an
 *   existing session record needs no migration, and a session whose group has
 *   been deleted simply falls back to the root rather than disappearing.
 */

const KEY_GROUPS = 'mycompare:sessionGroups'
const SCHEMA_VERSION = 1

/** Sessions with no group, or with a group that no longer exists, live here. */
export const ROOT_GROUP = ''

/**
 * @typedef {object} SessionGroup
 * @property {string} id
 * @property {string} name
 * @property {string} parentId  ROOT_GROUP for a top-level folder
 */

/**
 * @typedef {object} GroupState
 * @property {SessionGroup[]} groups
 * @property {Record<string, string>} membership  sessionId → groupId
 */

/** @returns {GroupState} */
function emptyState() {
  return { groups: [], membership: {} }
}

/**
 * Read the stored state, tolerating anything malformed.
 *
 * Corrupt organisation must never stop the app opening — the sessions
 * themselves are the valuable part, and they live elsewhere.
 *
 * @returns {GroupState}
 */
export function loadGroups() {
  try {
    const raw = localStorage.getItem(KEY_GROUPS)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw)
    const src = (parsed && typeof parsed === 'object' && parsed.__schema)
      ? parsed
      : { groups: parsed?.groups, membership: parsed?.membership }
    return normalizeGroupState(src)
  } catch {
    return emptyState()
  }
}

/**
 * @param {GroupState} state
 * @returns {GroupState} the state as stored
 */
export function saveGroups(state) {
  const clean = normalizeGroupState(state)
  try {
    localStorage.setItem(KEY_GROUPS,
      JSON.stringify({ __schema: SCHEMA_VERSION, ...clean }))
  } catch {
    // Quota or private-mode failure: organisation is a convenience, so losing
    // it must not take the operation with it.
  }
  return clean
}

/**
 * Drop anything that is not a usable group or membership entry.
 *
 * Also breaks parent cycles: a group that is its own ancestor would make the
 * tree walk non-terminating, and hand-edited storage can produce one.
 *
 * @param {Partial<GroupState>} state
 * @returns {GroupState}
 */
export function normalizeGroupState(state) {
  const rawGroups = Array.isArray(state?.groups) ? state.groups : []
  /** @type {Map<string, SessionGroup>} */
  const byId = new Map()

  for (const g of rawGroups) {
    if (!g || typeof g.id !== 'string' || !g.id) continue
    if (typeof g.name !== 'string' || !g.name.trim()) continue
    if (byId.has(g.id)) continue
    byId.set(g.id, {
      id: g.id,
      name: g.name.trim(),
      parentId: typeof g.parentId === 'string' ? g.parentId : ROOT_GROUP,
    })
  }

  // A parent that does not exist, or that leads back to the group itself,
  // becomes the root.
  for (const g of byId.values()) {
    const seen = new Set([g.id])
    let cursor = g.parentId
    while (cursor && byId.has(cursor)) {
      if (seen.has(cursor)) { g.parentId = ROOT_GROUP; break }
      seen.add(cursor)
      cursor = byId.get(cursor).parentId
    }
    if (g.parentId && !byId.has(g.parentId)) g.parentId = ROOT_GROUP
  }

  /** @type {Record<string, string>} */
  const membership = {}
  const rawMembership = (state?.membership && typeof state.membership === 'object')
    ? state.membership
    : {}
  for (const [sessionId, groupId] of Object.entries(rawMembership)) {
    if (typeof sessionId !== 'string' || !sessionId) continue
    if (typeof groupId !== 'string') continue
    // Membership of a deleted group resolves to the root rather than hiding
    // the session.
    if (groupId && !byId.has(groupId)) continue
    membership[sessionId] = groupId
  }

  return { groups: [...byId.values()], membership }
}

/**
 * @param {GroupState} state
 * @param {string} name
 * @param {string} [parentId]
 * @returns {{ state: GroupState, group: SessionGroup }}
 */
export function addGroup(state, name, parentId = ROOT_GROUP) {
  const clean = normalizeGroupState(state)
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return { state: clean, group: null }

  const group = {
    id: `g-${Date.now().toString(36)}-${clean.groups.length}`,
    name: trimmed,
    parentId: clean.groups.some((g) => g.id === parentId) ? parentId : ROOT_GROUP,
  }
  return { state: { ...clean, groups: [...clean.groups, group] }, group }
}

/**
 * Remove a group. Its children and its sessions move up to the root rather
 * than being deleted along with it — losing a folder should not lose the work
 * filed under it.
 *
 * @param {GroupState} state
 * @param {string} groupId
 * @returns {GroupState}
 */
export function removeGroup(state, groupId) {
  const clean = normalizeGroupState(state)
  const groups = clean.groups
    .filter((g) => g.id !== groupId)
    .map((g) => (g.parentId === groupId ? { ...g, parentId: ROOT_GROUP } : g))

  /** @type {Record<string, string>} */
  const membership = {}
  for (const [sid, gid] of Object.entries(clean.membership)) {
    if (gid !== groupId) membership[sid] = gid
  }
  return normalizeGroupState({ groups, membership })
}

/**
 * @param {GroupState} state
 * @param {string} groupId
 * @param {string} name
 * @returns {GroupState}
 */
export function renameGroup(state, groupId, name) {
  const clean = normalizeGroupState(state)
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return clean
  return {
    ...clean,
    groups: clean.groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)),
  }
}

/**
 * File a session under a group, or move it back to the root.
 *
 * @param {GroupState} state
 * @param {string} sessionId
 * @param {string} groupId  ROOT_GROUP to un-file
 * @returns {GroupState}
 */
export function assignSession(state, sessionId, groupId) {
  const clean = normalizeGroupState(state)
  if (!sessionId) return clean
  const membership = { ...clean.membership }
  if (!groupId) delete membership[sessionId]
  else if (clean.groups.some((g) => g.id === groupId)) membership[sessionId] = groupId
  return { ...clean, membership }
}

/**
 * @typedef {object} GroupNode
 * @property {SessionGroup|null} group  null for the synthetic root
 * @property {GroupNode[]} children
 * @property {object[]} sessions
 */

/**
 * Build the tree the home screen renders.
 *
 * Sessions whose group is unknown surface at the root, so a session can never
 * be filed somewhere invisible.
 *
 * @param {GroupState} state
 * @param {Array<{ id: string }>} sessions
 * @returns {GroupNode}
 */
export function buildGroupTree(state, sessions) {
  const clean = normalizeGroupState(state)
  const list = Array.isArray(sessions) ? sessions : []

  /** @type {Map<string, GroupNode>} */
  const nodes = new Map()
  for (const g of clean.groups) {
    nodes.set(g.id, { group: g, children: [], sessions: [] })
  }
  /** @type {GroupNode} */
  const root = { group: null, children: [], sessions: [] }

  for (const g of clean.groups) {
    const node = nodes.get(g.id)
    const parent = g.parentId ? nodes.get(g.parentId) : null
    ;(parent ?? root).children.push(node)
  }

  for (const s of list) {
    const gid = clean.membership[s?.id]
    const node = gid ? nodes.get(gid) : null
    ;(node ?? root).sessions.push(s)
  }

  const sortNode = (n) => {
    n.children.sort((a, b) => a.group.name.localeCompare(b.group.name))
    n.children.forEach(sortNode)
  }
  sortNode(root)
  return root
}

/**
 * Depth-first list of groups with their depth, for a flat select control.
 * @param {GroupState} state
 * @returns {Array<{ id: string, name: string, depth: number }>}
 */
export function flattenGroups(state) {
  const tree = buildGroupTree(state, [])
  const out = []
  const walk = (node, depth) => {
    for (const child of node.children) {
      out.push({ id: child.group.id, name: child.group.name, depth })
      walk(child, depth + 1)
    }
  }
  walk(tree, 0)
  return out
}
