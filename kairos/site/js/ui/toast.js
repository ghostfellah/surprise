// Notifications éphémères avec bouton « Annuler ». Pause au survol/focus, annoncées aux lecteurs d'écran.
import { h, icon, haptic } from './dom.js';

let host = null;
const live = [];
const ICON = { ok: 'check-circle', warn: 'alert', err: 'alert-circle' };

function ensureHost() {
  if (host && host.isConnected) return host;
  host = h('div', { class: 'toasts', 'aria-live': 'polite', 'aria-atomic': 'false' });
  document.body.appendChild(host);
  return host;
}

/**
 * toast(msg, { kind = 'ok'|'warn'|'err', undoLabel?, onUndo?, duration?, icon? }) -> { dismiss }
 * Avec `undoLabel`, la durée par défaut passe de 4 s à 7 s.
 */
export function toast(msg, { kind = 'ok', undoLabel, onUndo, duration, icon: iconName } = {}) {
  const root = ensureHost();
  const total = duration ?? (undoLabel ? 7000 : kind === 'err' ? 6000 : 4000);
  let remaining = total, startedAt = performance.now(), timer = 0, gone = false;
  const el = h('div', { class: `toast toast--${kind}`, role: kind === 'err' ? 'alert' : 'status', style: { '--toast-dur': `${total}ms` } },
    h('span', { class: 'toast__icon' }, icon(iconName || ICON[kind] || 'info', { size: 20 })),
    h('span', { class: 'toast__msg' }, msg),
    undoLabel ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', style: { color: 'var(--accent-text)' }, onclick: (e) => { e.stopPropagation(); try { onUndo && onUndo(); } finally { dismiss(); } } }, undoLabel) : null,
    h('span', { class: 'toast__bar', 'aria-hidden': 'true' }));
  const entry = { dismiss };

  function dismiss() {
    if (gone) return; gone = true; clearTimeout(timer);
    const i = live.indexOf(entry); if (i >= 0) live.splice(i, 1);
    el.classList.add('is-closing'); const rm = () => el.remove(); el.addEventListener('animationend', rm, { once: true }); setTimeout(rm, 320);
  }
  const arm = () => { clearTimeout(timer); startedAt = performance.now(); timer = setTimeout(dismiss, remaining); };
  const pause = () => { clearTimeout(timer); remaining -= performance.now() - startedAt; };
  el.addEventListener('pointerenter', pause); el.addEventListener('pointerleave', arm);
  el.addEventListener('focusin', pause); el.addEventListener('focusout', arm);
  el.addEventListener('click', dismiss);

  while (live.length >= 3) live[0].dismiss();
  live.push(entry);
  root.appendChild(el);
  arm();
  if (kind !== 'ok') haptic(kind === 'err' ? [12, 40, 12] : 10);
  return entry;
}

export const clearToasts = () => { for (const t of [...live]) t.dismiss(); };
