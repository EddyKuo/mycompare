/**
 * S15 UX core module tests:
 *   U03 toast & modal
 *   U09 i18n scaffold
 *   U10 schema-version envelopes
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { toast } from '../../src/renderer/src/core/toast.js'
import { confirm, prompt } from '../../src/renderer/src/core/modal.js'
import { t, setLocale, _registerStrings } from '../../src/renderer/src/core/i18n.js'

beforeEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('S15-U09 i18n', () => {
  it('returns the table value when key exists', () => {
    expect(t('common.ok')).toBe('確定')
    expect(t('common.cancel')).toBe('取消')
  })

  it('returns the fallback when key is missing', () => {
    expect(t('does.not.exist', 'foo')).toBe('foo')
  })

  it('returns the key itself when no fallback and no entry', () => {
    expect(t('does.not.exist')).toBe('does.not.exist')
  })

  it('respects locale changes', () => {
    _registerStrings('en-US', { 'common.ok': 'OK' })
    setLocale('en-US')
    expect(t('common.ok')).toBe('OK')
    setLocale('zh-TW')
    expect(t('common.ok')).toBe('確定')
  })

  it('ignores setLocale for an unknown locale', () => {
    setLocale('zh-TW')
    setLocale('xx-YY')
    expect(t('common.ok')).toBe('確定')
  })
})

describe('S15-U03 toast', () => {
  it('appends a toast element with role=status', () => {
    toast('hello')
    const el = document.querySelector('.mc-toast')
    expect(el).toBeTruthy()
    expect(el.getAttribute('role')).toBe('status')
    expect(el.textContent).toBe('hello')
  })

  it('uses the requested type as a class modifier', () => {
    toast('boom', { type: 'error' })
    expect(document.querySelector('.mc-toast--error')).toBeTruthy()
  })

  it('dismiss() removes the toast on click', () => {
    toast('clickable', { durationMs: 99999 })
    const el = document.querySelector('.mc-toast')
    el.click()
    // The leaving class is applied immediately.
    expect(el.classList.contains('mc-toast--leaving')).toBe(true)
  })
})

describe('S15-U03/U05 modal — promise-based confirm', () => {
  it('resolves true on OK click', async () => {
    const p = confirm({ message: 'are you sure?' })
    const okBtn = document.querySelector('.mc-modal-btn--primary')
    okBtn.click()
    expect(await p).toBe(true)
  })

  it('resolves false on cancel click', async () => {
    const p = confirm({ message: 'are you sure?' })
    const cancelBtn = document.querySelector('.mc-modal-btn:not(.mc-modal-btn--primary)')
    cancelBtn.click()
    expect(await p).toBe(false)
  })

  it('resolves false on Escape', async () => {
    const p = confirm({ message: 'esc me' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(await p).toBe(false)
  })

  it('removes the modal DOM on close (no leak)', async () => {
    const p = confirm({ message: 'cleanup' })
    document.querySelector('.mc-modal-btn--primary').click()
    await p
    expect(document.querySelector('.mc-modal-overlay')).toBeNull()
  })

  it('returns focus to the triggering element on close', async () => {
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.focus()
    expect(document.activeElement).toBe(btn)

    const p = confirm({ message: 'focus restore' })
    document.querySelector('.mc-modal-btn--primary').click()
    await p
    expect(document.activeElement).toBe(btn)
  })
})

describe('S15-U03 modal — prompt', () => {
  it('resolves with the input value on OK', async () => {
    const p = prompt({ message: 'name?', defaultValue: 'foo' })
    const input = document.querySelector('.mc-modal-input')
    input.value = 'bar'
    document.querySelector('.mc-modal-btn--primary').click()
    expect(await p).toBe('bar')
  })

  it('resolves with null on cancel', async () => {
    const p = prompt({ message: 'name?' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(await p).toBeNull()
  })

  it('initial focus lands on the input', async () => {
    const p = prompt({ message: 'name?', defaultValue: 'foo' })
    const input = document.querySelector('.mc-modal-input')
    expect(document.activeElement).toBe(input)
    // tidy up
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await p
  })
})
