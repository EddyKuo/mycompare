/**
 * @file modal.js
 * @description Promise-based confirm / prompt dialogs (S15-U03 + U05).
 *
 *   Replaces native `confirm()` / `prompt()` blocking calls with:
 *     - styleable HTML modals that match the app theme
 *     - Esc-to-cancel
 *     - Focus trap (Tab cycles inside the modal)
 *     - Return focus to the triggering element on close
 *
 *   API:
 *     await confirm({ title, message, okText?, cancelText? }) → boolean
 *     await prompt ({ title, message, defaultValue?, okText?, cancelText? }) → string | null
 */

import { t } from './i18n.js'

const Z_INDEX = 1000

/**
 * @param {{ title?: string, message: string, okText?: string, cancelText?: string }} opts
 * @returns {Promise<boolean>}
 */
export function confirm(opts) {
  return _openModal({
    title: opts.title ?? '',
    message: opts.message,
    okText: opts.okText ?? t('common.ok', '確定'),
    cancelText: opts.cancelText ?? t('common.cancel', '取消'),
    withInput: false,
  })
}

/**
 * @param {{ title?: string, message: string, defaultValue?: string, okText?: string, cancelText?: string }} opts
 * @returns {Promise<string | null>}
 */
export function prompt(opts) {
  return _openModal({
    title: opts.title ?? '',
    message: opts.message,
    okText: opts.okText ?? t('common.ok', '確定'),
    cancelText: opts.cancelText ?? t('common.cancel', '取消'),
    withInput: true,
    defaultValue: opts.defaultValue ?? '',
  })
}

function _openModal(cfg) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const overlay = document.createElement('div')
    overlay.className = 'mc-modal-overlay'
    overlay.style.cssText = `position:fixed;inset:0;z-index:${Z_INDEX};background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center`
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')

    const box = document.createElement('div')
    box.className = 'mc-modal-box'

    if (cfg.title) {
      const h = document.createElement('h3')
      h.className = 'mc-modal-title'
      h.textContent = cfg.title
      const titleId = 'mc-modal-title-' + Math.random().toString(36).slice(2)
      h.id = titleId
      overlay.setAttribute('aria-labelledby', titleId)
      box.appendChild(h)
    }

    const body = document.createElement('div')
    body.className = 'mc-modal-body'
    const msg = document.createElement('div')
    msg.textContent = cfg.message
    body.appendChild(msg)

    /** @type {HTMLInputElement | null} */
    let input = null
    if (cfg.withInput) {
      input = document.createElement('input')
      input.type = 'text'
      input.className = 'mc-modal-input'
      input.value = cfg.defaultValue
      body.appendChild(input)
    }
    box.appendChild(body)

    const footer = document.createElement('div')
    footer.className = 'mc-modal-footer'
    const btnCancel = document.createElement('button')
    btnCancel.className = 'mc-modal-btn'
    btnCancel.textContent = cfg.cancelText
    const btnOk = document.createElement('button')
    btnOk.className = 'mc-modal-btn mc-modal-btn--primary'
    btnOk.textContent = cfg.okText
    footer.appendChild(btnCancel)
    footer.appendChild(btnOk)
    box.appendChild(footer)
    overlay.appendChild(box)

    document.body.appendChild(overlay)

    const close = (result) => {
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      // S15-U05: restore focus to the element that triggered the modal.
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus() } catch { /* ignore */ }
      }
      resolve(result)
    }

    // S15-U05: focus trap. Cycle Tab within the modal.
    const focusable = () => {
      const els = box.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])')
      return Array.from(els).filter(el => !el.hasAttribute('disabled'))
    }

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        close(cfg.withInput ? null : false)
      } else if (e.key === 'Enter' && (!cfg.withInput || document.activeElement === input)) {
        e.preventDefault()
        close(cfg.withInput ? (input?.value ?? '') : true)
      } else if (e.key === 'Tab') {
        const list = focusable()
        if (list.length === 0) return
        const idx = list.indexOf(document.activeElement)
        if (e.shiftKey) {
          if (idx <= 0) { e.preventDefault(); list[list.length - 1].focus() }
        } else {
          if (idx === list.length - 1) { e.preventDefault(); list[0].focus() }
        }
      }
    }
    document.addEventListener('keydown', onKey, true)

    btnCancel.addEventListener('click', () => close(cfg.withInput ? null : false))
    btnOk.addEventListener('click', () => close(cfg.withInput ? (input?.value ?? '') : true))
    overlay.addEventListener('click', (e) => {
      // Click on backdrop (not the box) closes as cancel.
      if (e.target === overlay) close(cfg.withInput ? null : false)
    })

    // Initial focus
    if (input) { input.focus(); input.select() } else { btnOk.focus() }
  })
}
