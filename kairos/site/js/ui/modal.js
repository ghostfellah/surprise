// Modale et feuille basse accessibles : piège à focus, Échap, retour du focus, `inert` sur l'app,
// glisser pour fermer (feuille), animations coupées si prefers-reduced-motion.
import { h, icon, uniqueId, prefersReducedMotion, haptic } from './dom.js';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),summary';
const stack = [];

const isNarrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;
const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

function setBackgroundInert(on) {
  for (const id of ['app', 'onboard-root']) { const el = document.getElementById(id); if (el) el.inert = on; }
}

/**
 * openModal({ title, content, footer, kind = 'auto'|'dialog'|'sheet'|'palette', size = 'sm'|'md'|'lg'|'full',
 *   dismissible = true, initialFocus?, onClose?, raw = false, ariaLabel? })
 * -> { el, body, close(result), closed: Promise<result>, setTitle(t) }
 * `content` / `footer` : Node, tableau ou fonction(api) -> Node. `raw` : pas de chrome (utilisé par la palette).
 * 'auto' = feuille basse sur mobile (≤ 760 px), boîte centrée au-delà.
 */
export function openModal(opts = {}) {
  const { title, content, footer, kind = 'auto', size = 'md', dismissible = true, initialFocus, onClose, raw = false, ariaLabel } = opts;
  const previous = document.activeElement;
  const resolvedKind = kind === 'auto' ? (isNarrow() ? 'sheet' : 'dialog') : kind;
  const titleId = uniqueId('modal-title');
  let closing = false, resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });

  const overlay = h('div', { class: 'overlay', dataset: { kind: resolvedKind } });
  const api = { el: overlay, body: null, closed, close, setTitle: (t) => { const n = overlay.querySelector('.modal__title'); if (n) n.textContent = t; } };
  const build = (x) => (typeof x === 'function' ? x(api) : x);

  let dialog;
  if (raw) {
    dialog = build(content);
    overlay.appendChild(dialog);
  } else {
    const closeBtn = dismissible ? h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Fermer', onclick: () => close(undefined) }, icon('x')) : null;
    const body = h('div', { class: 'modal__body' }, build(content));
    api.body = body;
    const foot = footer ? h('div', { class: 'modal__foot' }, build(footer)) : null;
    dialog = h('div', { class: `modal modal--${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title ? titleId : null, 'aria-label': title ? null : ariaLabel || 'Boîte de dialogue', tabindex: '-1' },
      h('div', { class: 'sheet-handle', 'aria-hidden': 'true' }),
      title || closeBtn ? h('div', { class: 'modal__head' }, h('h2', { class: 'modal__title', id: titleId }, title || ''), closeBtn) : null,
      body, foot);
    overlay.appendChild(dialog);
    api.setFooter = (x) => { const f = dialog.querySelector('.modal__foot'); if (f) f.replaceChildren(...[].concat(build(x))); };
  }
  if (raw && !dialog.getAttribute('role')) { dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); if (ariaLabel) dialog.setAttribute('aria-label', ariaLabel); }

  // --- pile / arrière-plan inerte ---
  const below = stack[stack.length - 1];
  if (below) below.overlay.inert = true;
  else { setBackgroundInert(true); document.documentElement.classList.add('is-locked'); }
  const entry = { overlay, close };
  stack.push(entry);
  document.body.appendChild(overlay);

  // --- clavier : Échap + piège à focus ---
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dismissible) { e.preventDefault(); e.stopPropagation(); close(undefined); return; }
    if (e.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter(visible);
    if (!items.length) { e.preventDefault(); dialog.focus(); return; }
    const first = items[0], last = items[items.length - 1], act = document.activeElement;
    if (e.shiftKey && (act === first || act === dialog)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
  });
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay && dismissible) overlay.dataset.downOnBackdrop = '1'; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay && dismissible && overlay.dataset.downOnBackdrop) close(undefined); delete overlay.dataset.downOnBackdrop; });

  // --- glisser pour fermer (feuille basse) ---
  if (!raw && resolvedKind === 'sheet' && dismissible) {
    const zone = dialog.querySelector('.sheet-handle'), head = dialog.querySelector('.modal__head');
    let y0 = null, dy = 0, t0 = 0;
    const down = (e) => { if (e.target.closest('button')) return; y0 = e.clientY; dy = 0; t0 = performance.now(); dialog.style.transition = 'none'; dialog.style.animation = 'none'; e.currentTarget.setPointerCapture(e.pointerId); };
    const move = (e) => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); dialog.style.transform = `translateY(${dy}px)`; overlay.style.opacity = String(1 - Math.min(.6, dy / 500)); };
    const up = () => {
      if (y0 === null) return; const v = dy / Math.max(1, performance.now() - t0); y0 = null;
      if (dy > 110 || v > .6) { dialog.style.transition = 'transform .2s var(--ease)'; dialog.style.transform = 'translateY(100%)'; haptic(6); closeNow(undefined); }
      else { dialog.style.transition = 'transform .3s var(--ease-spring)'; dialog.style.transform = ''; overlay.style.opacity = ''; }
    };
    for (const z of [zone, head]) if (z) { z.addEventListener('pointerdown', down); z.addEventListener('pointermove', move); z.addEventListener('pointerup', up); z.addEventListener('pointercancel', up); z.style.touchAction = 'none'; }
  }

  // --- focus initial ---
  queueMicrotask(() => {
    let target = null;
    if (typeof initialFocus === 'string') target = dialog.querySelector(initialFocus);
    else if (typeof initialFocus === 'function') target = initialFocus(dialog);
    else if (initialFocus && initialFocus.nodeType) target = initialFocus;
    if (!target) target = dialog.querySelector('[autofocus]') || [...dialog.querySelectorAll(FOCUSABLE)].filter(visible).find((x) => !x.classList.contains('iconbtn')) || dialog;
    target.focus({ preventScroll: true });
    if (target.select && target.tagName === 'INPUT' && target.type === 'text' && target.dataset.select) target.select();
  });

  function closeNow(result) {
    if (closing) return; closing = true;
    const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1);
    const finish = () => {
      overlay.remove();
      const top = stack[stack.length - 1];
      if (top) top.overlay.inert = false;
      else { setBackgroundInert(false); document.documentElement.classList.remove('is-locked'); }
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
      if (onClose) onClose(result);
      resolveClosed(result);
    };
    if (prefersReducedMotion()) finish();
    else { overlay.classList.add('is-closing'); let done = false; const end = () => { if (!done) { done = true; finish(); } }; overlay.addEventListener('animationend', (e) => { if (e.target === overlay) end(); }); setTimeout(end, 260); }
  }
  function close(result) { closeNow(result); }
  return api;
}

/** Boîte de confirmation -> Promise<boolean>. */
export function confirmDialog(message, { title = 'Confirmer', okLabel = 'Confirmer', cancelLabel = 'Annuler', danger = false } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const m = openModal({
      title, size: 'sm', kind: 'auto',
      content: h('p', { class: 'muted', style: { lineHeight: 1.55 } }, message),
      footer: (api) => [
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => api.close(false) }, cancelLabel),
        h('button', { class: `btn ${danger ? 'btn--danger btn--solid' : 'btn--primary'}`, type: 'button', 'data-ok': '1', onclick: () => { answer = true; api.close(true); } }, okLabel),
      ],
      initialFocus: (d) => d.querySelector(danger ? '.btn--ghost' : '[data-ok]'),
      onClose: () => resolve(answer),
    });
    return m;
  });
}

export const modalIsOpen = () => stack.length > 0;
