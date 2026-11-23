// Boîte à outils DOM de Kairos : création d'éléments, icônes SVG inline, petits utilitaires
// d'interaction (compteurs animés, confettis, retour haptique). Zéro dépendance.
// Importable dans Node (aucun accès à `document` au chargement) pour les tests des fonctions pures.
import * as T from '../core/time.js';

/** Réexport de time.js + deux helpers d'affichage. */
const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export const fmt = {
  ...T,
  /** « lun. 23 nov. » */
  dateShort: (ms) => { const d = new Date(ms); return `${T.JOURS_FR[d.getDay()].slice(0, 3)}. ${d.getDate()} ${MOIS_COURTS[d.getMonth()]}`; },
  pct: (x, d = 0) => `${(x * 100).toFixed(d).replace('.', ',')} %`,
  num: (x, d = 0) => Number(x).toFixed(d).replace('.', ','),
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const hasDoc = typeof document !== 'undefined';

export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** clsx minimal : chaînes, tableaux, objets {classe: bool}. */
export function clsx(...args) {
  const out = [];
  for (const a of args) {
    if (!a) continue;
    if (typeof a === 'string' || typeof a === 'number') out.push(a);
    else if (Array.isArray(a)) { const s = clsx(...a); if (s) out.push(s); }
    else if (typeof a === 'object') for (const k in a) if (a[k]) out.push(k);
  }
  return out.join(' ');
}

/** Écoute un événement ; retourne la fonction de désabonnement. */
export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

/** Anti-rebond ; `.cancel()` et `.flush()` disponibles. */
export function debounce(fn, ms = 150) {
  let t = null, lastArgs = null;
  const d = (...args) => { lastArgs = args; clearTimeout(t); t = setTimeout(() => { t = null; fn(...lastArgs); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.flush = () => { if (t) { clearTimeout(t); t = null; fn(...lastArgs); } };
  return d;
}

let uidN = 0;
/** Identifiant DOM unique (aria-labelledby, for=…). */
export const uniqueId = (prefix = 'k') => `${prefix}-${(++uidN).toString(36)}`;

// ---------------------------------------------------------------------------
// h() / svg()
// ---------------------------------------------------------------------------
const PROP_KEYS = new Set(['value', 'checked', 'selected', 'disabled', 'indeterminate', 'readOnly', 'multiple', 'htmlFor', 'tabIndex', 'textContent', 'innerHTML', 'scrollTop']);

function applyProps(el, props, isSvg) {
  if (!props) return;
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (v === undefined || v === null || v === false) {
      if (key === 'value' || key === 'checked') el[key] = key === 'value' ? '' : false;
      continue;
    }
    if (key === 'class' || key === 'className') el.setAttribute('class', Array.isArray(v) || typeof v === 'object' ? clsx(v) : String(v));
    else if (key === 'style') {
      if (typeof v === 'string') el.setAttribute('style', v);
      else for (const s in v) { if (v[s] == null) continue; s.startsWith('--') ? el.style.setProperty(s, v[s]) : (el.style[s] = v[s]); }
    }
    else if (key === 'dataset') for (const d in v) { if (v[d] != null) el.dataset[d] = v[d]; }
    else if (key === 'ref') v(el);
    else if (key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v);
    else if (!isSvg && PROP_KEYS.has(key)) el[key === 'htmlFor' ? 'htmlFor' : key] = v;
    else if (v === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(v));
  }
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (typeof c === 'object' && c.nodeType) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** h('div', {class:'card', onclick}, 'texte', h('span'), [..]) */
export function h(tag, props, ...children) {
  if (props && (typeof props !== 'object' || props.nodeType || Array.isArray(props))) { children.unshift(props); props = null; }
  const el = document.createElement(tag);
  applyProps(el, props, false);
  appendChildren(el, children);
  if (tag === 'input' && el.type === 'range') syncRange(el);
  return el;
}

/** Élément SVG (espace de noms correct, enfants créés en SVG par l'appelant via svg()). */
export function svg(tag, props, ...children) {
  if (props && (typeof props !== 'object' || props.nodeType || Array.isArray(props))) { children.unshift(props); props = null; }
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  appendChildren(el, children);
  return el;
}

/** Remplace le contenu de `el` (sûr : accepte texte, Node, tableaux, null). */
export function replaceChildren(el, ...children) {
  while (el.firstChild) el.removeChild(el.firstChild);
  appendChildren(el, children);
  return el;
}

/** Garde la variable --pct d'un input.range synchronisée (remplissage de la piste). */
export function syncRange(input) {
  const min = Number(input.min || 0), max = Number(input.max || 100), v = Number(input.value || 0);
  input.style.setProperty('--pct', String(max > min ? ((v - min) / (max - min)) * 100 : 0));
}
if (hasDoc) {
  const upd = (e) => { const t = e.target; if (t && t.tagName === 'INPUT' && t.type === 'range') syncRange(t); };
  document.addEventListener('input', upd, true);
  document.addEventListener('change', upd, true);
}

// ---------------------------------------------------------------------------
// Mouvement, haptique, compteurs, confettis
// ---------------------------------------------------------------------------
export const prefersReducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Petite vibration (si disponible et si le mouvement n'est pas réduit). */
export function haptic(pattern = 8) {
  try { if (typeof navigator !== 'undefined' && navigator.vibrate && !prefersReducedMotion()) navigator.vibrate(pattern); } catch { /* ignoré */ }
}

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

/**
 * Compteur animé : fait défiler le texte de `el` de sa valeur courante à `to`.
 * format(v) -> string (défaut : entier). Retourne {cancel}.
 */
export function animateNumber(el, to, { from, duration = 700, format = (v) => String(Math.round(v)) } = {}) {
  if (el.__anim) el.__anim.cancel();
  const start = from ?? (Number(el.dataset.value) || 0);
  el.dataset.value = String(to);
  if (prefersReducedMotion() || duration <= 0 || start === to) { el.textContent = format(to); return { cancel() {} }; }
  let raf = 0; const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / duration);
    el.textContent = format(start + (to - start) * easeOutCubic(k));
    if (k < 1) raf = requestAnimationFrame(step); else el.__anim = null;
  };
  raf = requestAnimationFrame(step);
  el.__anim = { cancel() { cancelAnimationFrame(raf); el.__anim = null; el.textContent = format(to); } };
  return el.__anim;
}

/** Confettis sobres (or, bleu-vert, ivoire) depuis le point (x, y) en px viewport. */
export function confetti(x, y, { count = 56, spread = 1 } = {}) {
  if (!hasDoc || prefersReducedMotion()) return;
  const cv = document.createElement('canvas'); cv.className = 'confetti'; cv.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = innerWidth, H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr; document.body.appendChild(cv);
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  if (x == null) { x = W / 2; y = H * 0.7; }
  const css = getComputedStyle(document.documentElement);
  const cols = ['--sun', '--sun-hot', '--night', '--text', '--coral'].map((n) => css.getPropertyValue(n).trim() || '#f7b93e');
  const ps = Array.from({ length: count }, (_, i) => {
    const a = -Math.PI / 2 + (Math.random() - .5) * 2.2 * spread, s = 240 + Math.random() * 380;
    return { x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: 3 + Math.random() * 4, rot: Math.random() * 6, vr: (Math.random() - .5) * 14, c: cols[i % cols.length], w: Math.random() < .5 };
  });
  let last = performance.now(); const t0 = last;
  const frame = (now) => {
    const dt = Math.min(.04, (now - last) / 1000); last = now; const age = (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    for (const p of ps) {
      p.vy += 900 * dt; p.vx *= 1 - 1.6 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - (age - .9) / .7); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
      p.w ? ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r) : (ctx.beginPath(), ctx.arc(0, 0, p.r / 1.6, 0, 6.3), ctx.fill()); ctx.restore();
    }
    if (age < 1.7) requestAnimationFrame(frame); else cv.remove();
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Icônes : grille 24×24, trait 1.75, extrémités rondes. Contenu = balises internes.
// ---------------------------------------------------------------------------
export const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',
  sunrise: '<path d="M3 18.5h18M6.6 18.5a5.4 5.4 0 0 1 10.8 0"/><path d="M12 6v3.6M8.4 9.6 7 8.2M15.6 9.6 17 8.2M9.6 5.4 12 3l2.4 2.4"/>',
  sunset: '<path d="M3 18.5h18M6.6 18.5a5.4 5.4 0 0 1 10.8 0"/><path d="M12 3v3.6M8.4 9.6 7 8.2M15.6 9.6 17 8.2M9.6 6.2 12 8.6l2.4-2.4"/>',
  moon: '<path d="M20 14.4A8.5 8.5 0 0 1 9.6 4a8.5 8.5 0 1 0 10.4 10.4z"/>',
  'moon-star': '<path d="M19.4 13.8A7.8 7.8 0 0 1 10.2 4.6a7.8 7.8 0 1 0 9.2 9.2z"/><path d="M17 3v3M15.5 4.5h3"/>',
  coffee: '<path d="M4.5 9.5h11v4.8a4.7 4.7 0 0 1-4.7 4.7H9.2a4.7 4.7 0 0 1-4.7-4.7V9.5z"/><path d="M15.5 10.8h1.4a2.6 2.6 0 0 1 0 5.2h-1.8"/><path d="M8 3.6c-.9 1 .9 1.7 0 2.8M12 3.6c-.9 1 .9 1.7 0 2.8"/>',
  bolt: '<path d="M13.2 2.8 5.2 13.2h5.9l-1 8 8-10.4H12.2l1-8z"/>',
  brain: '<path d="M9.4 4.4A3 3 0 0 0 6.5 7a3 3 0 0 0-2 2.8 3 3 0 0 0 1 2.2 3.2 3.2 0 0 0 1.6 4.5A3 3 0 0 0 12 17.6V6.9a2.5 2.5 0 0 0-2.6-2.5z"/><path d="M14.6 4.4A3 3 0 0 1 17.5 7a3 3 0 0 1 2 2.8 3 3 0 0 1-1 2.2 3.2 3.2 0 0 1-1.6 4.5A3 3 0 0 1 12 17.6"/><path d="M12 9H10.4M12 12.4h1.8M12 15.2h-1.4"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3.2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  'calendar-check': '<rect x="3.5" y="5" width="17" height="15.5" rx="3.2"/><path d="M3.5 10h17M8 3v4M16 3v4M9 15l2.2 2.2L15.4 13"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.2 6.5h.01M4.2 12h.01M4.2 17.5h.01" stroke-width="2.6"/>',
  flask: '<path d="M9.5 3h5M10.4 3v6.1L5.2 18a2.1 2.1 0 0 0 1.8 3.1h10a2.1 2.1 0 0 0 1.8-3.1l-5.2-8.9V3"/><path d="M7.6 15h8.8"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2a.8.8 0 0 0-.9.3l-.3.5a.8.8 0 0 0 .2 1L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3a.8.8 0 0 0 1.2.1l.5-.4a.8.8 0 0 0 .1-.9z"/>',
  chart: '<path d="M5 20v-6M12 20V5M19 20v-10"/>',
  'chart-line': '<path d="M3.5 4v16.5H20.5"/><path d="M7.5 15.5l3.6-4.6 3 2.6 5-6.3"/>',
  gear: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M8.4 12.4l2.5 2.5 4.8-5.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  'x-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l.9 11.6A2 2 0 0 0 8.9 20.4h6.2a2 2 0 0 0 2-1.8L18 7M9 7V4.6A1.1 1.1 0 0 1 10.1 3.5h3.8A1.1 1.1 0 0 1 15 4.6V7"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.6"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2.4"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="10" rx="2.6"/><path d="M8 10.5V8a4 4 0 0 1 7.6-1.7M12 14.5v2.4"/>',
  play: '<path d="M7.5 4.9v14.2a.9.9 0 0 0 1.4.8l11-7.1a.9.9 0 0 0 0-1.5l-11-7.1a.9.9 0 0 0-1.4.7z"/>',
  pause: '<rect x="6.2" y="4.8" width="4" height="14.4" rx="1.4"/><rect x="13.8" y="4.8" width="4" height="14.4" rx="1.4"/>',
  stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  search: '<circle cx="11" cy="11" r="6.6"/><path d="m20 20-4.1-4.1"/>',
  download: '<path d="M12 4v11M7.5 10.6 12 15l4.5-4.4M5 19.5h14"/>',
  upload: '<path d="M12 15V4M7.5 8.4 12 4l4.5 4.4M5 19.5h14"/>',
  sparkle: '<path d="M11 3.5c.7 4.8 2.7 6.8 7.5 7.5-4.8.7-6.8 2.7-7.5 7.5-.7-4.8-2.7-6.8-7.5-7.5 4.8-.7 6.8-2.7 7.5-7.5z"/><path d="M19 2.8v3M17.5 4.3h3"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.1 2"/>',
  alert: '<path d="M12 3.8 2.9 19.6h18.2L12 3.8z"/><path d="M12 10v4.2M12 17.2h.01"/>',
  'alert-circle': '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.8v4.6M12 16.2h.01"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.2M12 7.9h.01"/>',
  battery: '<rect x="2.8" y="7.4" width="16.4" height="9.2" rx="2.6"/><path d="M21.6 10.8v2.4M6.4 10.4v3.2M9.8 10.4v3.2"/>',
  heart: '<path d="M12 20s-7.6-4.6-7.6-10.3A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 7.6 2.5C19.6 15.4 12 20 12 20z"/>',
  leaf: '<path d="M5 19.5c0-8.2 4-13.4 14.4-14.5 0 9.3-4.6 14.4-12.4 13.8"/><path d="M5 19.5c1.9-4.2 5-7.2 9.2-9.2"/>',
  target: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4.6"/><path d="M12 12h.01" stroke-width="2.6"/>',
  flame: '<path d="M12 21.2c4 0 6.6-2.7 6.6-6.3 0-3-2-4.9-3-7.2-.9 1.3-1.5 1.9-2.6 2.1.3-2.8-.8-5.1-3.1-6.9-.2 3.1-4.2 5.7-5 10.4-.7 4 2 7.9 7.1 7.9z"/><path d="M12 21.2c-1.8 0-3.1-1.2-3.1-3 0-1.9 1.4-2.7 2.1-4.1 1 1 3.9 2.3 3.9 4.6 0 1.5-1.3 2.5-2.9 2.5z"/>',
  wand: '<path d="M5 19 16 8"/><path d="M14.4 6.4l3.2 3.2"/><path d="M19 2.8v3M17.5 4.3h3M7.2 3.4v2.2M6.1 4.5h2.2M19.8 13.6v2.2M18.7 14.7h2.2"/>',
  edit: '<path d="M4 20l.9-4.2L16.6 4.1a2.1 2.1 0 0 1 3 0l.3.3a2.1 2.1 0 0 1 0 3L8.2 19.1 4 20z"/><path d="M14.4 6.4l3.2 3.2"/>',
  'chevron-left': '<path d="M14.5 6 8.5 12l6 6"/>',
  'chevron-right': '<path d="M9.5 6l6 6-6 6"/>',
  'chevron-up': '<path d="M6 14.5l6-6 6 6"/>',
  'chevron-down': '<path d="M6 9.5l6 6 6-6"/>',
  'arrow-left': '<path d="M19.5 12h-15M10.5 6l-6 6 6 6"/>',
  'arrow-right': '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  'arrow-up': '<path d="M12 19.5v-15M6 10.5l6-6 6 6"/>',
  'arrow-down': '<path d="M12 4.5v15M6 13.5l6 6 6-6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  bell: '<path d="M6 17.5V11a6 6 0 0 1 12 0v6.5l1.6 1.5H4.4L6 17.5z"/><path d="M10 21.4h4"/>',
  'bell-off': '<path d="M8.4 4.6A6 6 0 0 1 18 11v4M6 11v6.5L4.4 19h13.2M10 21.4h4M3 3l18 18"/>',
  home: '<path d="M4 11 12 4l8 7v8.5a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1V11z"/>',
  star: '<path d="M12 3.6l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17.4l-5.4 2.9 1.1-6.1L3.2 10l6.1-.8L12 3.6z"/>',
  filter: '<path d="M4 5.5h16l-6.2 7.2v5.6l-3.6 2v-7.6L4 5.5z"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.6"/><path d="M15.5 8.5V6.1a2.6 2.6 0 0 0-2.6-2.6H6.1a2.6 2.6 0 0 0-2.6 2.6v6.8a2.6 2.6 0 0 0 2.6 2.6h2.4"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.4-4M4 5v3.6h3.6"/><path d="M4 13a8 8 0 0 0 14.4 4M20 19v-3.6h-3.6"/>',
  bed: '<path d="M3 18.5V6M3 14.5h18v4M21 14.5v-2A3.5 3.5 0 0 0 17.5 9H11v5.5"/><circle cx="7" cy="11.2" r="2"/>',
  timer: '<circle cx="12" cy="13.6" r="7.4"/><path d="M12 13.6V9.6M9.5 3h5M18.6 6l1.2-1.2"/>',
  globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2M12 3.4c2.5 2.4 3.7 5.3 3.7 8.6s-1.2 6.2-3.7 8.6c-2.5-2.4-3.7-5.3-3.7-8.6S9.5 5.8 12 3.4z"/>',
  tag: '<path d="M3.5 12V4.6a1.1 1.1 0 0 1 1.1-1.1H12a1.1 1.1 0 0 1 .8.3l7.4 7.4a1.1 1.1 0 0 1 0 1.5l-7.4 7.4a1.1 1.1 0 0 1-1.5 0L3.8 12.8a1.1 1.1 0 0 1-.3-.8z"/><path d="M8 8h.01" stroke-width="2.6"/>',
  link: '<path d="M10 14a4.2 4.2 0 0 0 5.9 0l3.2-3.2a4.2 4.2 0 0 0-5.9-5.9l-1 1"/><path d="M14 10a4.2 4.2 0 0 0-5.9 0l-3.2 3.2a4.2 4.2 0 0 0 5.9 5.9l1-1"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.9"/>',
  shield: '<path d="M12 3 4.6 6v5.6c0 4.4 3 7.9 7.4 9.4 4.4-1.5 7.4-5 7.4-9.4V6L12 3z"/><path d="m9 12 2.2 2.2L15.4 10"/>',
  share: '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="6" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="m8.3 10.8 7.4-3.6M8.3 13.2l7.4 3.6"/>',
  'wifi-off': '<path d="M3 3l18 18M5 10.4a11 11 0 0 1 3.6-2M10 5.2A11 11 0 0 1 21 10M8.6 14a6.5 6.5 0 0 1 3-1.5M15.5 14.2a6.4 6.4 0 0 0-1-.6"/><path d="M12 18h.01" stroke-width="2.6"/>',
  flag: '<path d="M5 21V4M5 4.5h11.5l-2 4 2 4H5"/>',
  repeat: '<path d="M17 3.5l3 3-3 3"/><path d="M4 11V9.5a3 3 0 0 1 3-3h13M7 20.5l-3-3 3-3"/><path d="M20 13v1.5a3 3 0 0 1-3 3H4"/>',
  keyboard: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.8"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7 14h10"/>',
  command: '<path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15zm0 0v6m0 0h2.5a2.5 2.5 0 1 1-2.5 2.5V15zm0 0H9m0 0H6.5A2.5 2.5 0 1 0 9 17.5V15z"/>',
  layers: '<path d="M12 3.5 3 8.5l9 5 9-5-9-5z"/><path d="M3 12.5l9 5 9-5M3 16.5l9 5 9-5"/>',
  book: '<path d="M12 6.5C10.5 5 8 4.5 4.5 4.5v13c3.5 0 6 .5 7.5 2 1.5-1.5 4-2 7.5-2v-13c-3.5 0-6 .5-7.5 2z"/><path d="M12 6.5v13"/>',
  pill: '<rect x="3.5" y="8.5" width="17" height="7" rx="3.5" transform="rotate(-35 12 12)"/><path d="m9.4 8 5.2 8" transform="rotate(0 12 12)"/>',
  pin: '<path d="M12 21s6.5-5.6 6.5-11A6.5 6.5 0 0 0 5.5 10C5.5 15.4 12 21 12 21z"/><circle cx="12" cy="10" r="2.3"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 4v4.5H8M12 8v4.2l2.8 1.6"/>',
  smartphone: '<rect x="6.5" y="2.8" width="11" height="18.4" rx="3"/><path d="M11 18h2"/>',
  zap: '<path d="M13 3 5 14h6l-1 7 8-11h-6l1-7z"/>',
  drop: '<path d="M12 3.5s6 6.2 6 10.6a6 6 0 0 1-12 0C6 9.7 12 3.5 12 3.5z"/>',
  wind: '<path d="M3 9h11a2.8 2.8 0 1 0-2.8-2.8M3 14h15a2.8 2.8 0 1 1-2.8 2.8M3 19h7"/>',
  thermometer: '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
  activity: '<path d="M3 12h4l2.6-7 4.8 14 2.6-7H21"/>',
  eyeoff: '<path d="M3 3l18 18M10.3 5.7A8.7 8.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.6 7.4A16 16 0 0 0 2.5 12S6 18.5 12 18.5a8.6 8.6 0 0 0 3.6-.8M9.9 9.9a2.9 2.9 0 0 0 4.2 4.2"/>',
};
export const iconNames = Object.keys(ICONS);

/**
 * icon('sun', { size = 20, stroke = 1.75, class, label }) -> <svg>.
 * `label` → role="img" + aria-label ; sinon masqué aux lecteurs d'écran.
 */
export function icon(name, { size = 20, stroke = 1.75, class: cls, label, style } = {}) {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', size); el.setAttribute('height', size);
  el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', stroke); el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('class', clsx('icon', `icon-${name}`, cls));
  if (style) el.setAttribute('style', style);
  if (label) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', label); } else el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  el.innerHTML = ICONS[name] || ICONS.info;
  return el;
}
