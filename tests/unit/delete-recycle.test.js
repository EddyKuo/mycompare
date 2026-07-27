/**
 * Deleting through the recycle bin.
 *
 * The behaviour that matters is the failure path: when a platform or
 * filesystem has no bin, quietly unlinking instead would permanently delete a
 * file the user believed was recoverable. That has to be an explicit choice,
 * not a fallback.
 *
 * The handler lives in main/index.js, which pulls in Electron, so the logic is
 * exercised here through the same shape rather than by importing that module.
 */
import { describe, it, expect, vi } from 'vitest'

/**
 * The delete handler's decision procedure, matching main/index.js.
 *
 * @param {string} safe
 * @param {{permanent?: boolean, fallbackToPermanent?: boolean}|undefined} options
 * @param {{trashItem: Function, unlink: Function}} deps
 */
async function deleteFile(safe, options, deps) {
  if (options?.permanent !== true) {
    try {
      await deps.trashItem(safe)
      return { deleted: true, path: safe, permanent: false }
    } catch (err) {
      if (options?.fallbackToPermanent !== true) {
        throw new Error(`無法移至資源回收桶：${err instanceof Error ? err.message : err}`)
      }
    }
  }
  await deps.unlink(safe)
  return { deleted: true, path: safe, permanent: true }
}

const deps = (trashWorks = true) => ({
  trashItem: vi.fn(async () => {
    if (!trashWorks) throw new Error('no trash on this filesystem')
  }),
  unlink: vi.fn(async () => {}),
})

describe('delete-file', () => {
  it('uses the recycle bin by default', async () => {
    // A folder comparison deletes in bulk from a list the user skimmed;
    // unlink() on the wrong side has no undo.
    const d = deps()
    const r = await deleteFile('C:/x/a.txt', undefined, d)
    expect(d.trashItem).toHaveBeenCalledWith('C:/x/a.txt')
    expect(d.unlink).not.toHaveBeenCalled()
    expect(r.permanent).toBe(false)
  })

  it('deletes permanently only when asked', async () => {
    const d = deps()
    const r = await deleteFile('C:/x/a.txt', { permanent: true }, d)
    expect(d.trashItem).not.toHaveBeenCalled()
    expect(d.unlink).toHaveBeenCalledOnce()
    expect(r.permanent).toBe(true)
  })

  it('refuses rather than silently deleting when there is no bin', async () => {
    // This is the whole point. Falling through to unlink() here would destroy
    // a file the user believed they could recover.
    const d = deps(false)
    await expect(deleteFile('C:/x/a.txt', undefined, d)).rejects.toThrow(/資源回收桶/)
    expect(d.unlink).not.toHaveBeenCalled()
  })

  it('falls back to a permanent delete only on an explicit opt-in', async () => {
    const d = deps(false)
    const r = await deleteFile('C:/x/a.txt', { fallbackToPermanent: true }, d)
    expect(d.unlink).toHaveBeenCalledOnce()
    expect(r.permanent).toBe(true)
  })

  it('reports which kind of delete happened', async () => {
    // The caller has to be able to tell the user where the file went; "deleted"
    // alone does not distinguish recoverable from gone.
    expect((await deleteFile('a', undefined, deps())).permanent).toBe(false)
    expect((await deleteFile('a', { permanent: true }, deps())).permanent).toBe(true)
  })
})
