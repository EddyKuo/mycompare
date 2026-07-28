/**
 * Turn a flat per-value registry comparison into the tree the grid draws.
 *
 * The comparison itself lives in the main process (`diffRegistry`), so this
 * module only decides shape and visibility — never whether two values match.
 * Keeping that split means there is one definition of equality, not two that
 * drift.
 */

/**
 * @typedef {object} RegDiffRow
 * @property {string} path
 * @property {string} name
 * @property {'same'|'different'|'left-only'|'right-only'} status
 * @property {{ type: string, value: string, raw?: string, truncated?: boolean, fullLength?: number }|null} left
 * @property {{ type: string, value: string, raw?: string, truncated?: boolean, fullLength?: number }|null} right
 */

/**
 * @typedef {object} RegNode
 * @property {'key'|'value'} kind
 * @property {string} path      full key path
 * @property {string} name      value name; '' is the key's default value
 * @property {string} label     what the Name column shows
 * @property {number} depth
 * @property {'same'|'different'|'left-only'|'right-only'} status
 * @property {RegNode[]} children
 * @property {RegDiffRow|null} row
 */

/** Rank used when folding child statuses into the key that holds them. */
const STATUS_RANK = { same: 0, 'left-only': 1, 'right-only': 1, different: 2 }

/**
 * Build the key tree.
 *
 * A key present on only one side has to stay distinguishable from a key whose
 * values merely differ, because those are different colours and BC treats them
 * as different things — so a key's status is folded from its children rather
 * than assumed.
 *
 * @param {RegDiffRow[]} rows
 * @returns {RegNode[]} root nodes
 */
export function buildRegistryTree(rows) {
  /** @type {Map<string, RegNode>} */
  const keys = new Map()
  /** @type {RegNode[]} */
  const roots = []

  /**
   * @param {string} path
   * @returns {RegNode}
   */
  const keyNode = (path) => {
    const found = keys.get(path.toLowerCase())
    if (found) return found

    const cut = path.lastIndexOf('\\')
    const node = /** @type {RegNode} */ ({
      kind: 'key',
      path,
      name: '',
      label: cut === -1 ? path : path.slice(cut + 1),
      depth: 0,
      status: 'same',
      children: [],
      row: null,
    })
    keys.set(path.toLowerCase(), node)

    if (cut === -1) {
      roots.push(node)
    } else {
      const parent = keyNode(path.slice(0, cut))
      node.depth = parent.depth + 1
      parent.children.push(node)
    }
    return node
  }

  for (const row of rows ?? []) {
    const key = keyNode(row.path)
    // A key with no values at all arrives as a placeholder row; it creates the
    // key node and nothing else, otherwise the tree would lose empty keys.
    if (row.name === '' && (row.left?.type === 'KEY' || row.right?.type === 'KEY')) {
      // Its status has to come across too. Without this an empty key that
      // exists on one side only reports 'same' — it draws uncoloured, and the
      // differences filter removes it altogether, which is the plainest thing
      // a registry diff has to be able to show. `foldStatus` cannot repair it
      // either, because a childless key has nothing to fold.
      key.status = row.status ?? key.status
      continue
    }
    key.children.push({
      kind: 'value',
      path: row.path,
      name: row.name,
      label: row.name === '' ? '（預設）' : row.name,
      depth: key.depth + 1,
      status: row.status,
      children: [],
      row,
    })
  }

  for (const root of roots) foldStatus(root)
  return roots
}

/**
 * Give every key the strongest status found beneath it.
 *
 * @param {RegNode} node
 * @returns {string}
 */
function foldStatus(node) {
  if (node.kind === 'value') return node.status
  if (!node.children.length) return node.status

  let seenLeft = false
  let seenRight = false
  let worst = 'same'
  for (const child of node.children) {
    const s = foldStatus(child)
    if (s === 'left-only') seenLeft = true
    else if (s === 'right-only') seenRight = true
    if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s
  }
  // Orphans on both sides mean the key exists on both and its contents differ,
  // which is a difference — not two orphans.
  node.status = seenLeft && seenRight ? 'different' : worst
  return node.status
}

/**
 * Flatten the tree into the rows the virtual scroller draws.
 *
 * @param {RegNode[]} roots
 * @param {object} opts
 * @param {Set<string>} opts.expanded      lower-cased key paths that are open
 * @param {boolean} [opts.showSame]
 * @param {boolean} [opts.showDiff]
 * @param {string} [opts.find]             case-insensitive substring on the name
 * @returns {RegNode[]}
 */
export function flattenRegistryTree(roots, opts) {
  const expanded = opts?.expanded ?? new Set()
  const showSame = opts?.showSame !== false
  const showDiff = opts?.showDiff !== false
  const needle = String(opts?.find ?? '').toLowerCase()

  /** @type {RegNode[]} */
  const out = []

  /**
   * @param {RegNode} node
   * @returns {boolean} whether the node or anything under it was emitted
   */
  const visit = (node) => {
    if (node.kind === 'value') {
      if (!visible(node)) return false
      out.push(node)
      return true
    }

    // A key is drawn when something under it is drawn. Deciding that needs the
    // children rendered first, so they go to a scratch list and only move
    // across once the key itself has been pushed — otherwise a filtered view
    // shows values with no key above them.
    const mark = out.length
    out.push(node)
    let any = false
    if (expanded.has(node.path.toLowerCase())) {
      for (const child of node.children) any = visit(child) || any
    } else {
      // Collapsed: the key still has to appear if it would match, and the
      // filter still has to be able to hide it entirely.
      any = node.children.some(anyVisible)
    }
    if (!any && !visible(node)) {
      out.length = mark
      return false
    }
    return true
  }

  /**
   * @param {RegNode} node
   * @returns {boolean}
   */
  function visible(node) {
    if (needle && !node.label.toLowerCase().includes(needle)) return false
    return node.status === 'same' ? showSame : showDiff
  }

  /**
   * @param {RegNode} node
   * @returns {boolean}
   */
  function anyVisible(node) {
    if (visible(node)) return true
    return node.children.some(anyVisible)
  }

  for (const root of roots) visit(root)
  return out
}

/**
 * Count each status across every value in the tree.
 *
 * Keys are left out: a key's status is derived from its values, so counting
 * both would report every difference twice.
 *
 * @param {RegNode[]} roots
 * @returns {{ same: number, different: number, 'left-only': number, 'right-only': number }}
 */
export function countRegistryStatuses(roots) {
  const counts = { same: 0, different: 0, 'left-only': 0, 'right-only': 0 }
  const walk = (node) => {
    if (node.kind === 'value') counts[node.status] = (counts[node.status] ?? 0) + 1
    for (const child of node.children) walk(child)
  }
  for (const root of roots ?? []) walk(root)
  return counts
}

/**
 * Every key path in the tree, for expand-all.
 *
 * @param {RegNode[]} roots
 * @returns {string[]} lower-cased paths
 */
export function allKeyPaths(roots) {
  /** @type {string[]} */
  const out = []
  const walk = (node) => {
    if (node.kind !== 'key') return
    out.push(node.path.toLowerCase())
    for (const child of node.children) walk(child)
  }
  for (const root of roots ?? []) walk(root)
  return out
}
