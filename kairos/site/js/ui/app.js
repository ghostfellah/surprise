// Amorçage de Kairos : crée le store, construit le Ctx du contrat, la coque (navigation, barre du haut,
// aurore vivante), le routeur par hash, l'onboarding, les modales métier (tâche, saisie rapide, check-in,
// focus), les raccourcis clavier, le thème, le service worker, l'invite d'installation et les rappels.
// Les modules de données (store, model, scheduler) sont importés dynamiquement : s'ils manquent,
// on affiche une carte d'erreur lisible au lieu d'un écran blanc.
import { h, svg, icon, fmt, $, $$, on, debounce, clsx, syncRange, animateNumber, confetti, haptic, prefersReducedMotion, uniqueId } from './dom.js';
import * as charts from './charts.js';
import { openModal, confirmDialog, modalIsOpen } from './modal.js';
import { toast } from './toast.js';
import { NAV, openPalette, loadNlp, renderTokens, describeEntry, createFromParsed, LOAD_LABELS, PRIO_LABELS } from './palette.js';
import { MIN, HOUR, DAY, startOfDay, fmtTime, fmtDateFR, fmtDuration, parseHHMM, toHHMM, clamp } from '../core/time.js';

const VIEW_IDS = NAV.map((n) => n.id);
const NAV_BAR = NAV.filter((n) => n.id !== 'science'); // « science » : via Réglages et palette
const THEME_COLORS = { dark: '#060910', light: '#f7f1e5' };

// ===========================================================================
// Aurore : couleurs selon l'heure de la journée, intensité selon l'énergie prédite
// ===========================================================================
const AURORA = [
  // [heure, [A, B, C]] — nuit profonde, aube dorée, jour clair, crépuscule violet, soirée
  [0, ['#16206b', '#0a5a6b', '#3a1a62']], [4.5, ['#1a2478', '#0e6270', '#47206e']], [6, ['#ff9d5c', '#f6b73c', '#c9457a']],
  [8, ['#ffc65c', '#3fc0b0', '#ff9b6a']], [12, ['#ffd36b', '#35c6bd', '#ffb04a']], [16.5, ['#ffbf55', '#2fb3b3', '#ff8a5c']],
  [18.5, ['#ff7458', '#a24ed8', '#f6a93c']], [20.5, ['#6a3fba', '#233f9d', '#d9553f']], [22.5, ['#1c2575', '#0b5c6c', '#3d1d66']], [24, ['#16206b', '#0a5a6b', '#3a1a62']],
];
const hexRgb = (hx) => [1, 3, 5].map((i) => parseInt(hx.slice(i, i + 2), 16));
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

export function auroraAt(hour) {
  let i = AURORA.findIndex((s, k) => hour >= s[0] && hour < (AURORA[k + 1] ? AURORA[k + 1][0] : 25));
  if (i < 0) i = 0;
  const a = AURORA[i], b = AURORA[Math.min(AURORA.length - 1, i + 1)], t = b[0] === a[0] ? 0 : (hour - a[0]) / (b[0] - a[0]);
  const e = t * t * (3 - 2 * t);
  return a[1].map((c, k) => mixRgb(hexRgb(c), hexRgb(b[1][k]), e));
}
export const phaseAt = (hour) => (hour < 5 || hour >= 22 ? 'night' : hour < 8 ? 'dawn' : hour < 17.5 ? 'day' : 'dusk');

// ===========================================================================
// Petits assemblages visuels
// ===========================================================================
function logo(size = 32) {
  const gid = uniqueId('lg');
  return svg('svg', { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
    svg('defs', null, svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' }, svg('stop', { offset: '0', 'stop-color': '#ffe190' }), svg('stop', { offset: '.55', 'stop-color': '#f7b93e' }), svg('stop', { offset: '1', 'stop-color': '#e9822a' }))),
    svg('circle', { cx: 32, cy: 32, r: 29.5, fill: 'none', stroke: `url(#${gid})`, 'stroke-width': 1.6, 'stroke-dasharray': '.8 3.6', 'stroke-linecap': 'round', opacity: '.7' }),
    svg('path', { d: 'M23 17v30M24 35l13-14M29 33l12 14', fill: 'none', stroke: 'currentColor', 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    svg('circle', { cx: 42.5, cy: 16.5, r: 5.4, fill: `url(#${gid})` }));
}

/** Chemin d'arc SVG (angles en degrés, 0° = droite, sens horaire). */
export function arcPath(cx, cy, r, a0, a1) {
  const rad = (a) => (a * Math.PI) / 180, span = ((a1 - a0) % 360 + 360) % 360 || 360;
  const p = (a) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))], [x0, y0] = p(a0), [x1, y1] = p(a0 + span);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Cadran 24 h : arc de sommeil (bleu-vert) et d'éveil (or). minuit en bas, midi en haut. */
function sleepDial({ wake = 420, bed = 1380, need = 8 } = {}) {
  const C = 100, R = 78, ang = (min) => (min / 1440) * 360 + 90;
  const ticks = []; for (let i = 0; i < 96; i++) { const a = (i / 96) * 2 * Math.PI, big = i % 8 === 0, r1 = 94, r2 = big ? 86 : i % 4 === 0 ? 89 : 91.5; ticks.push(svg('line', { class: 'dial-tick', x1: C + Math.cos(a) * r1, y1: C + Math.sin(a) * r1, x2: C + Math.cos(a) * r2, y2: C + Math.sin(a) * r2, 'stroke-width': big ? 1.6 : 1, 'stroke-linecap': 'round' })); }
  const gradId = uniqueId('dg');
  const sleepArc = svg('path', { class: 'dial-sleep', fill: 'none', 'stroke-width': 9, 'stroke-linecap': 'round' });
  const awakeArc = svg('path', { class: 'dial-awake', fill: 'none', 'stroke-width': 9, 'stroke-linecap': 'round' });
  const sun = svg('circle', { r: 7, fill: '#ffe190', stroke: 'var(--bg)', 'stroke-width': 2.5 }), moon = svg('circle', { r: 7, fill: 'var(--night)', stroke: 'var(--bg)', 'stroke-width': 2.5 });
  const big = svg('text', { class: 'dial-center-big', x: C, y: C + 4, 'text-anchor': 'middle' }), sub = svg('text', { class: 'dial-center-sub', x: C, y: C + 22, 'text-anchor': 'middle' }, 'DE SOMMEIL');
  const needArc = svg('path', { fill: 'none', stroke: 'var(--ok)', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-dasharray': '1 5', opacity: '.9' });
  const labels = [[0, '00'], [360, '06'], [720, '12'], [1080, '18']].map(([m, t]) => { const a = (ang(m) * Math.PI) / 180; return svg('text', { class: 'dial-label', x: C + Math.cos(a) * 66, y: C + Math.sin(a) * 66 + 3, 'text-anchor': 'middle' }, t); });
  const el = svg('svg', { class: 'dial', viewBox: '0 0 200 200', role: 'img', 'aria-label': 'Cadran de 24 heures : sommeil et éveil' },
    svg('defs', null, svg('radialGradient', { id: gradId }, svg('stop', { offset: '0', 'stop-color': 'var(--sun)', 'stop-opacity': '.16' }), svg('stop', { offset: '1', 'stop-color': 'var(--sun)', 'stop-opacity': '0' }))),
    svg('circle', { cx: C, cy: C, r: 96, fill: `url(#${gradId})` }), ...ticks, needArc, sleepArc, awakeArc, ...labels, sun, moon, big, sub);
  function update(w, b, n) {
    const dur = ((w - b) % 1440 + 1440) % 1440 || 1440, aw = ang(w), ab = ang(b);
    sleepArc.setAttribute('d', arcPath(C, C, R, ab + 3, ab + (dur / 1440) * 360 - 3)); awakeArc.setAttribute('d', arcPath(C, C, R, aw + 3, ab - 3 + (aw >= ab ? 0 : 0)));
    const p = (a, r) => [C + Math.cos((a * Math.PI) / 180) * r, C + Math.sin((a * Math.PI) / 180) * r];
    const [sx, sy] = p(aw, R), [mx, my] = p(ab, R); sun.setAttribute('cx', sx); sun.setAttribute('cy', sy); moon.setAttribute('cx', mx); moon.setAttribute('cy', my);
    big.textContent = fmtDuration(dur).replace(' ', ' '); needArc.setAttribute('d', n ? arcPath(C, C, 62, ab, ab + (n * 60 / 1440) * 360) : '');
  }
  update(wake, bed, need);
  return { el, update };
}

// ===========================================================================
// Démarrage
// ===========================================================================
const appRoot = document.getElementById('app');
const splash = document.getElementById('splash');
const reduce = prefersReducedMotion;

main().catch(fatal);

function hideSplash() { if (!splash) return; splash.classList.add('is-out'); setTimeout(() => splash.remove(), 700); }

function fatal(err) {
  console.error(err);
  hideSplash();
  appRoot.replaceChildren(h('div', { class: 'view', style: { maxWidth: '560px', paddingTop: '12vh' } },
    h('div', { class: 'card card--coral stack' },
      h('div', { class: 'row' }, icon('alert-circle', { size: 26 }), h('h1', { class: 'h2' }, 'Kairos n\'a pas pu démarrer')),
      h('p', { class: 'muted' }, 'Un module essentiel est introuvable ou a échoué au chargement. Tes données ne sont pas touchées.'),
      h('pre', { class: 'mono small faint', style: { whiteSpace: 'pre-wrap', margin: 0 } }, String(err && err.message ? err.message : err)),
      h('div', { class: 'row' }, h('button', { class: 'btn btn--primary', onclick: () => location.reload() }, icon('refresh'), 'Réessayer')))));
}

async function main() {
  // Fond vivant (avant tout, pour ne jamais voir un écran vide)
  const aurora = h('div', { class: 'aurora', id: 'aurora', 'aria-hidden': 'true' }, h('div', { class: 'aurora__blob' }), h('div', { class: 'aurora__blob' }), h('div', { class: 'aurora__blob' }));
  document.body.prepend(aurora);

  const [storeMod, modelMod, schedMod] = await Promise.all([import('../store.js'), import('../core/model.js'), import('../core/scheduler.js')]);
  const store = storeMod.createStore({});
  await store.ready;
  const { buildModel, valueAt } = modelMod, { schedule } = schedMod;
  const actions = store.actions;

  // ---------------------------------------------------------------------
  // Horloge de l'app (voyage dans le temps) et abonnés
  // ---------------------------------------------------------------------
  let offsetMs = 0, version = 0;
  const clock = () => Date.now() + offsetMs;
  const listeners = new Set();
  const notify = (state, change) => { for (const fn of [...listeners]) { try { fn(state, change); } catch (e) { console.error(e); } } };
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  // ---------------------------------------------------------------------
  // Modèle mémoïsé
  // ---------------------------------------------------------------------
  const cache = new Map();
  function model(opts = {}) {
    const now = opts.nowMs ?? clock(), fromMs = opts.fromMs ?? startOfDay(now), hours = opts.hours ?? 24, stepMin = opts.stepMin ?? 5;
    const bucket = Math.floor(now / (10 * MIN)) * 10 * MIN;
    const key = `${fromMs}|${hours}|${stepMin}|${opts.whatIf ? JSON.stringify(opts.whatIf) : ''}|${version}|${bucket}`;
    let m = cache.get(key); if (m) return m;
    const st = store.getState();
    m = buildModel({ profile: st.profile, sleeps: st.sleeps, caffeine: st.caffeine, fromMs, hours, stepMin, nowMs: bucket, whatIf: opts.whatIf });
    cache.set(key, m); if (cache.size > 14) cache.delete(cache.keys().next().value);
    return m;
  }
  const planHorizon = (days = 7) => model({ hours: days * 24 });
  function runPlanner(opts = {}) {
    const days = opts.days ?? 7, st = store.getState(), m = planHorizon(days), nowMs = clock();
    const res = schedule({
      tasks: (opts.tasks || st.tasks).filter((t) => !t.done), events: opts.events || st.events, curve: { t0: m.t0, stepMin: m.stepMin, alert: m.alert },
      nowMs, horizonEndMs: m.t0 + days * DAY, profile: st.profile, locked: ((st.plan && st.plan.blocks) || []).filter((b) => b.locked), options: opts.options,
    });
    res.horizonDays = days; return res;
  }
  const applyPlan = (res) => actions.setPlan({ generatedMs: clock(), horizonDays: res.horizonDays || 7, blocks: res.blocks });

  // ---------------------------------------------------------------------
  // Contexte
  // ---------------------------------------------------------------------
  let currentRoute = { id: 'today', params: {} }, deferredInstall = null;
  const navigate = (hash) => { const t = String(hash).startsWith('#') ? hash : `#/${hash}`; if (location.hash === t) route(); else location.hash = t; };
  const ctx = {
    store, actions, get state() { return store.getState(); }, subscribe, nowMs: clock, clock, model, planHorizon, runPlanner, applyPlan, navigate,
    toast, confirm: (msg, o = {}) => confirmDialog(msg, { okLabel: o.okLabel || 'Confirmer', danger: o.danger, title: o.title || (o.danger ? 'Attention' : 'Confirmer') }),
    openTaskEditor, openQuickAdd, openPalette: (o) => openPalette(ctx, o), startFocus, openCheckIn, openHelp, toggleTimeTravel,
    h, svg, icon, charts, fmt, openModal, confetti, haptic, animateNumber, syncRange,
    get route() { return currentRoute; },
    canInstall: () => !!deferredInstall, install, enableNotifications,
    setTheme: (theme) => actions.setPrefs({ theme }),
  };

  // ---------------------------------------------------------------------
  // Thème
  // ---------------------------------------------------------------------
  const metaTheme = $$('meta[name="theme-color"]'); metaTheme.forEach((m) => { m.dataset.orig = m.getAttribute('content'); });
  const lightNow = () => { const t = document.documentElement.dataset.theme; return t === 'light' || (t !== 'dark' && matchMedia('(prefers-color-scheme: light)').matches); };
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme; else delete root.dataset.theme;
    try { localStorage.setItem('kairos.theme', theme || 'auto'); } catch { /* stockage indisponible */ }
    metaTheme.forEach((m) => m.setAttribute('content', theme === 'light' || theme === 'dark' ? THEME_COLORS[theme] : m.dataset.orig));
    updateAtmosphere();
  }

  // ---------------------------------------------------------------------
  // Atmosphère : l'aurore suit l'heure et l'énergie prédite
  // ---------------------------------------------------------------------
  function updateAtmosphere() {
    const now = clock(), d = new Date(now), hour = d.getHours() + d.getMinutes() / 60;
    let e = .5; try { const m = model(); e = clamp(valueAt(m.alert, m, now) / 100, 0, 1); } catch { /* modèle indisponible */ }
    const light = lightNow(), cols = auroraAt(hour).map((c) => (light ? mixRgb(c, [255, 241, 214], .38) : c)), st = document.documentElement.style;
    st.setProperty('--aurora-a', `rgb(${cols[0]})`); st.setProperty('--aurora-b', `rgb(${cols[1]})`); st.setProperty('--aurora-c', `rgb(${cols[2]})`);
    st.setProperty('--aurora-o', String(+(.42 + .58 * e).toFixed(2)));
    document.documentElement.dataset.phase = phaseAt(hour);
  }

  // ---------------------------------------------------------------------
  // Coque
  // ---------------------------------------------------------------------
  const navIndex = (id) => Math.max(0, NAV_BAR.findIndex((n) => n.id === (id === 'science' ? 'settings' : id)));
  const navItems = NAV_BAR.map((n) => h('a', { class: 'nav__item', href: `#/${n.id}`, 'data-id': n.id, 'data-short': n.id === 'today' ? 'Jour' : null, 'aria-label': n.title, onclick: () => haptic(6) }, h('span', { class: 'nav__icon' }, icon(n.icon, { size: 22 })), h('span', { class: 'nav__label', 'data-short': n.id === 'today' ? 'Jour' : null }, n.id === 'today' ? 'Aujourd\'hui' : n.title)));
  const navInd = h('span', { class: 'nav__ind', 'aria-hidden': 'true' });
  const fitBadge = h('button', { class: 'fit-badge', type: 'button', hidden: true, 'data-tip': 'Le modèle a appris de tes check-ins', onclick: () => navigate('#/insights') }, icon('sparkle', { size: 14 }), h('span'));
  const installBtn = h('button', { class: 'iconbtn hide-sm', type: 'button', hidden: true, 'aria-label': 'Installer l\'application', 'data-tip': 'Installer', onclick: () => install() }, icon('download'));
  const titleEl = h('h1', { class: 'topbar__title', id: 'page-title' }, 'Kairos');
  const eyebrow = h('span', { class: 'eyebrow topbar__eyebrow' });
  const topbar = h('header', { class: 'topbar' },
    h('span', { class: 'topbar__brand', style: { color: 'var(--text)' } }, logo(34)),
    h('div', { class: 'topbar__titles' }, eyebrow, titleEl),
    h('div', { class: 'topbar__actions' }, fitBadge, installBtn,
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Palette de commandes (Ctrl+K)', 'data-tip': 'Rechercher · Ctrl K', onclick: () => ctx.openPalette() }, icon('search')),
      h('button', { class: 'iconbtn iconbtn--primary', type: 'button', 'aria-label': 'Ajouter une tâche (N)', 'data-tip': 'Saisie rapide', onclick: () => { haptic(8); ctx.openQuickAdd(); } }, icon('plus', { size: 22, stroke: 2.2 }))));
  const ttBar = h('div', { class: 'timetravel', hidden: true, role: 'group', 'aria-label': 'Voyage dans le temps' });
  const viewEl = h('main', { class: 'view', id: 'view', tabindex: '-1', 'aria-labelledby': 'page-title' });
  const nav = h('nav', { class: 'nav', 'aria-label': 'Navigation principale' },
    h('div', { class: 'nav__brand' }, h('span', { style: { color: 'var(--text)', display: 'grid' } }, logo(40)), h('span', { class: 'nav__brand-name' }, 'Kairos')),
    h('div', { class: 'nav__list' }, navInd, ...navItems),
    h('div', { class: 'nav__foot hide-sm' },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Voyage dans le temps (Maj+T)', 'data-tip': 'Voyage dans le temps', onclick: () => toggleTimeTravel() }, icon('history')),
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Raccourcis clavier (?)', 'data-tip': 'Raccourcis', onclick: () => openHelp() }, icon('keyboard'))));
  appRoot.replaceChildren(h('a', { class: 'skip-link', href: '#view', onclick: (e) => { e.preventDefault(); viewEl.focus(); } }, 'Aller au contenu'), nav, h('div', { class: 'main' }, topbar, ttBar, viewEl));
  viewEl.style.viewTransitionName = 'view';

  function updateEyebrow() {
    const now = clock(), tail = `${fmtTime(now)}${offsetMs ? ' · simulé' : ''}`;
    eyebrow.replaceChildren(h('span', { class: 'long' }, `${fmtDateFR(now)} · ${tail}`.toUpperCase()), h('span', { class: 'short' }, `${fmt.dateShort(now)} · ${tail}`.toUpperCase()));
    const fit = ctx.state.profile && ctx.state.profile.fit;
    if (fit && fit.confidence != null) { fitBadge.hidden = false; fitBadge.lastChild.textContent = `Ajusté à toi · ${Math.round(fit.confidence * 100)} %`; fitBadge.setAttribute('aria-label', `Modèle ajusté à toi, confiance ${Math.round(fit.confidence * 100)} pour cent`); } else fitBadge.hidden = true;
  }

  // ---------------------------------------------------------------------
  // Routeur
  // ---------------------------------------------------------------------
  const modules = new Map(); const cssLoaded = new Set();
  let cleanup = null, navToken = 0, mounted = false, offs = [];
  const parseHash = () => { const raw = location.hash.replace(/^#\/?/, ''), [p, q = ''] = raw.split('?'); const id = VIEW_IDS.includes(p) ? p : 'today'; return { id, params: Object.fromEntries(new URLSearchParams(q)), valid: !p || VIEW_IDS.includes(p) }; };
  function ensureCss(id) {
    if (cssLoaded.has(id)) return; cssLoaded.add(id);
    const link = h('link', { rel: 'stylesheet', href: `css/views-${id}.css` }); link.onerror = () => link.remove(); document.head.appendChild(link);
  }
  async function loadView(id) {
    if (modules.has(id)) return modules.get(id);
    ensureCss(id);
    const p = import(`./views/${id}.js`).then((m) => ({ ok: true, view: m.default }), (error) => ({ ok: false, error }));
    modules.set(id, p); return p;
  }
  const trackedCtx = () => { const c = Object.create(ctx); c.subscribe = (fn) => { const off = subscribe(fn); offs.push(off); return off; }; return c; };
  function teardown() { for (const o of offs.splice(0)) o(); if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error(e); } } cleanup = null; }

  function soonCard(id, why) {
    const meta = NAV.find((n) => n.id === id);
    return h('div', { class: 'card card--glow empty' },
      h('div', { class: 'empty__art' }, dialArt()),
      h('h2', { class: 'empty__title' }, `${meta ? meta.title : id} — bientôt`),
      h('p', { class: 'empty__text' }, 'Cet écran arrive très vite. En attendant, tout le reste de Kairos fonctionne.'),
      h('div', { class: 'row row--center' }, h('button', { class: 'btn btn--primary', onclick: () => navigate('#/today') }, icon('sun'), 'Retour à Aujourd\'hui')),
      why ? h('details', { class: 'tiny faint' }, h('summary', null, 'Détail technique'), h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', textAlign: 'left' } }, String(why.message || why))) : null);
  }
  function errorCard(id, err) {
    return h('div', { class: 'card card--coral stack' }, h('div', { class: 'row' }, icon('alert-circle', { size: 24 }), h('h2', { class: 'h3' }, 'Cet écran a rencontré un problème')),
      h('p', { class: 'muted small' }, 'Tes données sont intactes. Tu peux réessayer ou revenir à l\'accueil.'), h('pre', { class: 'mono tiny faint', style: { whiteSpace: 'pre-wrap', margin: 0 } }, String(err && err.message ? err.message : err)),
      h('div', { class: 'row' }, h('button', { class: 'btn btn--primary', onclick: () => { modules.delete(id); route(); } }, icon('refresh'), 'Réessayer'), h('button', { class: 'btn btn--ghost', onclick: () => navigate('#/today') }, 'Accueil')));
  }

  function chrome(id, viewMeta) {
    const meta = NAV.find((n) => n.id === id), title = (viewMeta && viewMeta.title) || (meta && meta.title) || 'Kairos';
    titleEl.textContent = title; document.title = `${title} · Kairos`;
    nav.querySelector('.nav__list').style.setProperty('--i', String(navIndex(id)));
    navItems.forEach((a) => { const act = a.dataset.id === (id === 'science' ? 'settings' : id); act ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
    updateEyebrow();
  }

  async function route() {
    const r = parseHash(); if (!r.valid) { history.replaceState(null, '', '#/today'); }
    const token = ++navToken; const res = await loadView(r.id);
    if (token !== navToken) return;
    currentRoute = r;
    const swap = () => {
      teardown(); viewEl.replaceChildren(); const inner = h('div', { class: 'view__inner' }); viewEl.appendChild(inner); chrome(r.id, res.ok ? res.view : null);
      if (!res.ok) { inner.appendChild(soonCard(r.id, res.error)); return; }
      try {
        const ret = res.view.mount(inner, trackedCtx());
        if (ret && typeof ret.then === 'function') ret.then((fn) => { if (token === navToken) cleanup = fn; else if (typeof fn === 'function') fn(); }, (e) => { console.error(e); inner.replaceChildren(errorCard(r.id, e)); });
        else cleanup = ret;
      } catch (e) { console.error(e); inner.replaceChildren(errorCard(r.id, e)); }
    };
    if (mounted && document.startViewTransition && !reduce()) {
      document.documentElement.classList.add('is-vt'); const vt = document.startViewTransition(swap);
      vt.finished.finally(() => document.documentElement.classList.remove('is-vt')); await vt.updateCallbackDone.catch(() => {});
    } else swap();
    if (mounted) { window.scrollTo(0, 0); viewEl.focus({ preventScroll: true }); }
    if (!mounted) { mounted = true; hideSplash(); }
  }

  // ---------------------------------------------------------------------
  // Voyage dans le temps
  // ---------------------------------------------------------------------
  const toLocalInput = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  function renderTimeTravel() {
    const input = h('input', { class: 'input', type: 'datetime-local', 'aria-label': 'Date et heure simulées', value: toLocalInput(clock()), style: { width: 'auto', minHeight: '38px' }, onchange: (e) => { const t = new Date(e.target.value).getTime(); if (Number.isFinite(t)) setClock(t); } });
    const step = (label, ms) => h('button', { class: 'btn btn--sm btn--secondary', type: 'button', onclick: () => setClock(clock() + ms) }, label);
    ttBar.replaceChildren(icon('history', { size: 18 }), h('strong', { class: 'timetravel__time', 'data-role': 'tt-time' }, `${fmt.dateShort(clock())} ${fmtTime(clock())}`), input,
      step('−1 j', -DAY), step('−1 h', -HOUR), step('+1 h', HOUR), step('+6 h', 6 * HOUR), step('+1 j', DAY), h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--sm btn--primary', type: 'button', onclick: () => toggleTimeTravel(false) }, 'Revenir au présent'));
  }
  function setClock(ms) { offsetMs = ms - Date.now(); renderTimeTravel(); updateEyebrow(); updateAtmosphere(); armReminder(); notify(ctx.state, { type: 'clock' }); }
  function toggleTimeTravel(force) {
    const on = force ?? ttBar.hidden;
    if (on) { ttBar.hidden = false; renderTimeTravel(); toast('Voyage dans le temps activé : l\'horloge de l\'app est décalée', { kind: 'warn', duration: 3200 }); }
    else { ttBar.hidden = true; if (offsetMs) { offsetMs = 0; updateEyebrow(); updateAtmosphere(); armReminder(); notify(ctx.state, { type: 'clock' }); } }
  }

  // ---------------------------------------------------------------------
  // Éditeur de tâche
  // ---------------------------------------------------------------------
  const toLocalOrEmpty = (ms) => (ms ? toLocalInput(ms) : '');
  const fromLocal = (v) => { if (!v) return undefined; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : undefined; };
  const LOAD_HELP = ['Routine : mails, rangement, admin', 'Léger : peu de réflexion', 'Soutenu : travail courant', 'Exigeant : analyse, rédaction', 'Concentration profonde : code, problème difficile'];
  const PRIOS = [[1, 'Urgent'], [2, 'Important'], [3, 'Normal'], [4, 'Un jour']];

  function openTaskEditor(taskId, preset) {
    return new Promise((resolve) => {
      const existing = taskId ? ctx.state.tasks.find((t) => t.id === taskId) : null;
      const t = { title: '', durMin: 30, load: 3, priority: 3, tags: [], notes: '', ...(existing || {}), ...(preset || {}) };
      let tags = [...(t.tags || [])], priority = t.priority || 3, result = null;
      const splitDefault = t.splittable ?? (t.durMin > 90);

      const title = h('input', { class: 'input', type: 'text', required: true, maxlength: '140', placeholder: 'Que dois-tu faire ?', value: t.title, 'aria-label': 'Titre', autocomplete: 'off', 'data-select': '1' });
      const dur = h('input', { class: 'input', type: 'number', min: '5', max: '720', step: '5', value: String(t.durMin || 30), 'aria-label': 'Durée en minutes', style: { width: '112px' } });
      const durLabel = h('span', { class: 'muted num' });
      const syncDur = () => { const v = Number(dur.value) || 0; durLabel.textContent = v ? fmtDuration(v) : ''; $$('.chip[data-dur]', form).forEach((c) => c.setAttribute('aria-pressed', String(Number(c.dataset.dur) === v))); };
      const load = h('input', { class: 'range', type: 'range', min: '1', max: '5', step: '1', value: String(t.load || 3), 'aria-label': 'Charge cognitive', 'aria-valuetext': LOAD_HELP[(t.load || 3) - 1] });
      const loadVal = h('span', { class: 'row', style: { '--gap': '8px' } });
      const syncLoad = () => { const v = Number(load.value); loadVal.replaceChildren(h('span', { class: 'dot', style: { background: `var(--load-${v})`, boxShadow: `0 0 10px var(--load-${v})` } }), h('strong', { class: 'num' }, `${v}/5`), h('span', { class: 'muted small' }, LOAD_HELP[v - 1])); load.setAttribute('aria-valuetext', LOAD_HELP[v - 1]); };
      const prioBtns = PRIOS.map(([v, l]) => h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': String(priority === v), onclick: () => { priority = v; prioBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(PRIOS[i][0] === v))); } }, l));
      const deadline = h('input', { class: 'input', type: 'datetime-local', value: toLocalOrEmpty(t.deadlineMs), 'aria-label': 'Échéance' });
      const earliest = h('input', { class: 'input', type: 'datetime-local', value: toLocalOrEmpty(t.earliestMs), 'aria-label': 'Pas avant' });
      const split = h('input', { type: 'checkbox', checked: !!splitDefault, onchange: () => { minRow.hidden = !split.checked; } });
      const minBlock = h('input', { class: 'input', type: 'number', min: '10', max: '240', step: '5', value: String(t.minBlockMin || 25), 'aria-label': 'Taille minimale d\'un bloc en minutes', style: { width: '112px' } });
      const minRow = h('div', { class: 'row', hidden: !splitDefault }, h('span', { class: 'muted small' }, 'Bloc minimum'), minBlock, h('span', { class: 'muted small' }, 'min'));
      const tagBox = h('div', { class: 'row row--wrap', style: { '--gap': '6px' } });
      const tagInput = h('input', { class: 'input', type: 'text', placeholder: 'Ajouter un tag (Entrée)', 'aria-label': 'Tags', style: { flex: '1 1 140px', minHeight: '36px', width: 'auto' } });
      const renderTags = () => { tagBox.replaceChildren(...tags.map((g) => h('span', { class: 'chip chip--sun' }, `#${g}`, h('button', { type: 'button', 'aria-label': `Retirer ${g}`, style: { display: 'grid', placeItems: 'center' }, onclick: () => { tags = tags.filter((x) => x !== g); renderTags(); } }, icon('x', { size: 14 }))))); tagBox.appendChild(tagInput); };
      const addTag = () => { const v = tagInput.value.trim().replace(/^#/, '').toLowerCase(); if (v && !tags.includes(v)) tags.push(v); tagInput.value = ''; renderTags(); };
      tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); e.stopPropagation(); addTag(); if (e.key === 'Enter') tagInput.focus(); } else if (e.key === 'Backspace' && !tagInput.value && tags.length) { tags.pop(); renderTags(); tagInput.focus(); } });
      const notes = h('textarea', { class: 'textarea', placeholder: 'Contexte, liens, critères de réussite…', 'aria-label': 'Notes', value: t.notes || '' });
      const done = existing ? h('input', { type: 'checkbox', checked: !!existing.done }) : null;
      const err = h('div', { class: 'error', role: 'alert', hidden: true }, 'Donne un titre à ta tâche.');
      const F = (label, ...kids) => h('div', { class: 'field' }, h('span', { class: 'label' }, label), ...kids);

      const form = h('form', { class: 'stack', novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
        F('Titre', title, err),
        F('Durée', h('div', { class: 'row row--wrap' }, dur, durLabel), h('div', { class: 'row row--wrap', style: { '--gap': '6px' } }, ...[15, 25, 45, 60, 90, 120, 180].map((m) => h('button', { class: 'chip', type: 'button', 'data-dur': String(m), 'aria-pressed': 'false', onclick: () => { dur.value = String(m); syncDur(); } }, fmtDuration(m))))),
        F('Charge cognitive', load, loadVal, h('span', { class: 'hint' }, 'Plus la charge est haute, plus Kairos cherche un pic d\'énergie.')),
        F('Priorité', h('div', { class: 'seg', role: 'group', 'aria-label': 'Priorité' }, ...prioBtns)),
        h('div', { class: 'grid grid--2', style: { '--gap': '12px' } }, F('Échéance', deadline), F('Pas avant', earliest)),
        h('div', { class: 'stack stack--sm' }, h('label', { class: 'switch' }, split, h('span', { class: 'switch__ui' }), h('span', null, 'Peut être découpée en plusieurs blocs')), minRow),
        F('Tags', tagBox),
        F('Notes', notes),
        done ? h('label', { class: 'switch' }, done, h('span', { class: 'switch__ui' }), h('span', null, 'Terminée')) : null,
        h('button', { type: 'submit', hidden: true }));

      function submit() {
        const ttl = title.value.trim(); if (!ttl) { err.hidden = false; title.parentElement.classList.add('field--error'); title.focus(); haptic([8, 30, 8]); return; }
        if (tagInput.value.trim()) addTag();
        const patch = { title: ttl, durMin: clamp(Math.round((Number(dur.value) || 30) / 5) * 5, 5, 720), load: Number(load.value), priority, deadlineMs: fromLocal(deadline.value), earliestMs: fromLocal(earliest.value), splittable: split.checked, minBlockMin: split.checked ? Number(minBlock.value) || 25 : undefined, tags, notes: notes.value.trim() || undefined };
        if (existing) { actions.updateTask(existing.id, patch); if (done && done.checked !== !!existing.done) actions.completeTask(existing.id, done.checked); result = ctx.state.tasks.find((x) => x.id === existing.id) || null; toast('Tâche enregistrée', { kind: 'ok', duration: 2200 }); }
        else { result = actions.addTask(patch); toast('Tâche ajoutée', { kind: 'ok', undoLabel: 'Annuler', onUndo: () => store.undo() }); }
        modal.close(result);
      }
      const del = existing ? h('button', { class: 'btn btn--danger', type: 'button', onclick: () => { const snapshot = existing.title; actions.removeTask(existing.id); toast(`« ${snapshot} » supprimée`, { kind: 'warn', undoLabel: 'Annuler', onUndo: () => store.undo() }); modal.close(null); } }, icon('trash', { size: 18 }), 'Supprimer') : null;
      const modal = openModal({
        title: existing ? 'Modifier la tâche' : 'Nouvelle tâche', size: 'md', content: form,
        footer: (api) => [del, h('span', { class: 'spacer' }), h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => api.close(null) }, 'Annuler'), h('button', { class: 'btn btn--primary', type: 'button', onclick: submit }, icon('check', { size: 18 }), existing ? 'Enregistrer' : 'Ajouter')],
        initialFocus: title, onClose: (r) => resolve(r === undefined ? null : r),
      });
      title.addEventListener('input', () => { err.hidden = true; title.parentElement.classList.remove('field--error'); });
      form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
      dur.addEventListener('input', syncDur); load.addEventListener('input', syncLoad); renderTags(); syncDur(); syncLoad();
    });
  }

  // ---------------------------------------------------------------------
  // Saisie rapide
  // ---------------------------------------------------------------------
  function openQuickAdd() {
    let nlp = null, parsed = null;
    const input = h('input', { class: 'input', type: 'text', placeholder: 'Rédiger le rapport 2h avant vendredi 17h #deep', autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'done', 'aria-label': 'Nouvelle tâche ou événement', style: { minHeight: '56px', fontSize: '1.125rem', borderRadius: 'var(--r-lg)' } });
    const preview = h('div', { class: 'stack stack--sm', 'aria-live': 'polite', style: { minHeight: '72px' } });
    const examples = ['Appeler le garagiste demain 15 min', 'Déjeuner avec Paul jeudi 12h30 1h', 'Réviser le cours 45 min ce soir !!', 'Rédiger la note de synthèse 2h avant vendredi #deep'];
    const refresh = () => {
      const text = input.value; parsed = null;
      if (!text.trim()) { preview.replaceChildren(h('div', { class: 'eyebrow' }, 'Exemples'), h('div', { class: 'row row--wrap', style: { '--gap': '8px' } }, ...examples.map((x) => h('button', { class: 'chip', type: 'button', onclick: () => { input.value = x; refresh(); input.focus(); } }, x)))); return; }
      if (nlp) { try { parsed = nlp.parseEntry(text, clock()); } catch { parsed = null; } }
      const sum = parsed ? describeEntry(parsed, clock()) : [];
      preview.replaceChildren(
        h('div', { class: 'row row--wrap', style: { '--gap': '8px' } }, h('span', { class: `chip ${parsed && parsed.kind === 'event' ? 'chip--night' : 'chip--sun'}` }, icon(parsed && parsed.kind === 'event' ? 'calendar' : 'check-circle', { size: 15 }), parsed && parsed.kind === 'event' ? 'Événement' : 'Tâche'), ...sum.map((s) => h('span', { class: `tok tok--${s.type}` }, s.text))),
        parsed && parsed.tokens && parsed.tokens.length ? h('p', { class: 'muted small', style: { lineHeight: 1.9 } }, ...renderTokens(text, parsed.tokens)) : null);
    };
    const go = () => {
      const text = input.value.trim(); if (!text) { input.focus(); haptic([8, 30, 8]); return; }
      const p = parsed || { kind: 'task', title: text, tags: [] };
      const r = createFromParsed(ctx, p); modal.close(r);
      toast(`${r.kind === 'event' ? 'Événement ajouté' : 'Tâche ajoutée'} : ${p.title}`, { undoLabel: 'Annuler', onUndo: () => store.undo() });
    };
    const more = () => { const p = parsed || { title: input.value.trim() }; modal.close(); openTaskEditor(null, { title: p.title, durMin: p.durMin, load: p.load, priority: p.priority, deadlineMs: p.deadlineMs, earliestMs: p.earliestMs, tags: p.tags || [] }); };
    const modal = openModal({
      title: 'Saisie rapide', size: 'md', content: h('div', { class: 'stack' }, input, preview),
      footer: () => [h('button', { class: 'btn btn--ghost', type: 'button', onclick: more }, icon('sliders', { size: 18 }), 'Plus d\'options'), h('span', { class: 'spacer' }), h('button', { class: 'btn btn--primary', type: 'button', onclick: go }, icon('plus', { size: 18 }), 'Ajouter')],
      initialFocus: input,
    });
    input.addEventListener('input', refresh); input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    refresh(); loadNlp().then((m) => { nlp = m; refresh(); });
    return modal;
  }

  // ---------------------------------------------------------------------
  // Check-in, aide
  // ---------------------------------------------------------------------
  function openCheckIn() {
    const labels = ['Épuisé·e', 'Fatigué·e', 'Correct', 'En forme', 'Au top'];
    let predicted = null; try { const m = model(); predicted = Math.round(valueAt(m.alert, m, clock())); } catch { /* ignoré */ }
    const note = h('input', { class: 'input', type: 'text', placeholder: 'Une note ? (optionnel)', 'aria-label': 'Note' });
    const modal = openModal({
      title: 'Comment te sens-tu ?', size: 'sm', kind: 'auto',
      content: h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, 'Quelques secondes suffisent : chaque réponse affine le modèle sur toi.'),
        h('div', { class: 'focus-rate', style: { width: '100%' } }, ...labels.map((l, i) => h('button', { type: 'button', onclick: () => { actions.logCheckIn({ tMs: clock(), alertness: i + 1, note: note.value.trim() || undefined }); haptic(12); modal.close(i + 1); toast('Merci, check-in enregistré', { undoLabel: 'Annuler', onUndo: () => store.undo() }); } }, h('b', { class: 'num' }, String(i + 1)), h('span', null, l)))),
        note, predicted !== null ? h('p', { class: 'tiny faint' }, `Kairos prédisait ${predicted}/100 pour cet instant.`) : null),
      initialFocus: (d) => d.querySelector('.focus-rate button:nth-child(3)'),
    });
    return modal;
  }

  function openHelp() {
    const rows = [[['⌘/Ctrl', 'K'], 'Palette de commandes'], [['N'], 'Nouvelle tâche'], [['C'], 'Café rapide (80 mg)'], [['g', 't'], 'Aujourd\'hui'], [['g', 'p'], 'Plan'], [['g', 'l'], 'Labo'], [['g', 's'], 'Sommeil'], [['g', 'v'], 'Voyage'], [['g', 'b'], 'Bilan'], [['g', 'r'], 'Réglages'], [['g', 'c'], 'La science'], [['⇧', 'T'], 'Voyage dans le temps'], [['⌘/Ctrl', 'Z'], 'Annuler'], [['⌘/Ctrl', '⇧', 'Z'], 'Rétablir'], [['?'], 'Cette aide'], [['Échap'], 'Fermer']];
    return openModal({ title: 'Raccourcis clavier', size: 'md', content: h('table', { class: 'table table--tight' }, h('tbody', null, ...rows.map(([k, l]) => h('tr', null, h('td', { style: { whiteSpace: 'nowrap' } }, h('span', { class: 'row', style: { '--gap': '4px' } }, ...k.map((x) => h('span', { class: 'kbd' }, x)))), h('td', { class: 'muted' }, l))))) });
  }

  // ---------------------------------------------------------------------
  // Focus plein écran
  // ---------------------------------------------------------------------
  let focusOn = false;
  function startFocus({ taskId, minutes = 25 } = {}) {
    if (focusOn) return; focusOn = true;
    const task = taskId ? ctx.state.tasks.find((x) => x.id === taskId) : null;
    const total = minutes * 60000, startApp = clock(); let startPerf = performance.now(), pausedAt = null, pausedTotal = 0, bonus = 0, phase = 'run', lock = null, timer = 0, beeped = false;
    const R = 92, CIRC = 2 * Math.PI * R, gid = uniqueId('fg');
    const arc = svg('circle', { class: 'focus-ring__arc', cx: 100, cy: 100, r: R, fill: 'none', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': CIRC, 'stroke-dashoffset': CIRC });
    const timeEl = h('div', { class: 'focus-time', role: 'timer', 'aria-live': 'off' }), stateEl = h('div', { class: 'eyebrow' }, 'Focus');
    const ringWrap = h('div', { class: 'focus-ring' }, svg('svg', { viewBox: '0 0 200 200', 'aria-hidden': 'true' }, svg('defs', null, svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--sun-deep)' }), svg('stop', { offset: '1', 'stop-color': 'var(--sun-hot)' }))), svg('circle', { class: 'focus-ring__track', cx: 100, cy: 100, r: R, fill: 'none', 'stroke-width': 7 }), arc), h('div', { class: 'focus-ring__time' }, stateEl, timeEl));
    ringWrap.querySelector('.focus-ring__arc').style.stroke = `url(#${gid})`;
    const body = h('div', { class: 'focus-body' }), controls = h('div', { class: 'focus-controls' });
    const root = h('div', { class: 'focus-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Session de focus' },
      h('div', { class: 'focus-head' }, h('span', { class: 'eyebrow eyebrow--sun' }, 'Mode focus'), h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Quitter le focus', onclick: () => quitAsk() }, icon('x'))), body, controls);
    const activeMs = () => (pausedAt ?? performance.now()) - startPerf - pausedTotal;
    const remaining = () => Math.max(0, total + bonus - activeMs());
    const fmtClock = (ms) => { const s = Math.ceil(ms / 1000), m = Math.floor(s / 60); return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

    function paintRun() {
      phase = 'run'; root.classList.toggle('is-paused', pausedAt !== null);
      body.replaceChildren(h('p', { class: 'focus-task' }, task ? task.title : 'Concentration libre'), ringWrap);
      const pauseBtn = h('button', { class: 'btn btn--primary btn--lg', type: 'button', onclick: togglePause }, icon(pausedAt !== null ? 'play' : 'pause'), pausedAt !== null ? 'Reprendre' : 'Pause');
      controls.replaceChildren(pauseBtn, h('button', { class: 'btn btn--secondary btn--lg', type: 'button', onclick: () => { bonus += 5 * MIN; tick(); } }, icon('plus'), '5 min'), h('button', { class: 'btn btn--ghost btn--lg', type: 'button', onclick: () => finish(false) }, icon('check'), 'Terminer'));
      pauseBtn.focus({ preventScroll: true }); tick();
    }
    function tick() {
      if (phase !== 'run') return; const rem = remaining(), full = total + bonus;
      timeEl.textContent = fmtClock(rem); stateEl.textContent = pausedAt !== null ? 'En pause' : `${Math.round((1 - rem / full) * 100)} %`;
      arc.setAttribute('stroke-dashoffset', String(CIRC * (rem / full))); document.title = `${fmtClock(rem)} · Focus`;
      if (rem <= 0 && pausedAt === null) finish(true);
    }
    function togglePause() { if (pausedAt === null) pausedAt = performance.now(); else { pausedTotal += performance.now() - pausedAt; pausedAt = null; } paintRun(); haptic(10); }
    function beep() {
      try { const A = window.AudioContext || window.webkitAudioContext, c = new A(); [0, .22, .44].forEach((d, i) => { const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.value = [659, 784, 988][i]; g.gain.setValueAtTime(0, c.currentTime + d); g.gain.linearRampToValueAtTime(.12, c.currentTime + d + .03); g.gain.exponentialRampToValueAtTime(.0001, c.currentTime + d + .5); o.connect(g).connect(c.destination); o.start(c.currentTime + d); o.stop(c.currentTime + d + .55); }); } catch { /* audio indisponible */ }
    }
    function finish(natural) {
      if (phase === 'rate') return; const elapsed = activeMs(); phase = 'rate'; clearInterval(timer); document.title = `${NAV.find((n) => n.id === currentRoute.id).title} · Kairos`;
      if (natural && !beeped) { beeped = true; beep(); haptic([200, 100, 200, 100, 300]); if (document.hidden) notifyNow('Focus terminé', task ? task.title : 'Bien joué !'); }
      const mins = Math.max(1, Math.round(elapsed / 60000)); if (natural) confetti(innerWidth / 2, innerHeight * .42, { count: 70 });
      stateEl.textContent = '';
      body.replaceChildren(h('div', { class: 'eyebrow eyebrow--sun' }, natural ? 'Session terminée' : 'Session arrêtée'), h('h2', { class: 'display', style: { fontSize: 'clamp(3rem, 14vw, 6rem)' } }, `${mins} min`), h('p', { class: 'lead' }, 'Comment était ta concentration ?'),
        h('div', { class: 'focus-rate' }, ...['Dispersé', 'Moyen', 'Correct', 'Bon', 'Flow'].map((l, i) => h('button', { type: 'button', onclick: () => end(i + 1) }, h('b', { class: 'num' }, String(i + 1)), h('span', null, l)))));
      controls.replaceChildren(h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => end(undefined) }, 'Passer'));
      body.querySelector('.focus-rate button:nth-child(4)').focus({ preventScroll: true });
      function end(rating) {
        if (elapsed >= 60000) actions.logFocus({ taskId: task ? task.id : undefined, startMs: startApp, endMs: startApp + Math.round(elapsed), plannedMin: minutes, rating });
        if (task && !task.done) {
          body.replaceChildren(h('h2', { class: 'display', style: { fontSize: 'clamp(2rem, 8vw, 3.4rem)' } }, 'Tâche terminée ?'), h('p', { class: 'lead' }, task.title));
          controls.replaceChildren(h('button', { class: 'btn btn--primary btn--lg', type: 'button', onclick: () => { actions.completeTask(task.id, true); close(true); } }, icon('check'), 'Oui, terminée'), h('button', { class: 'btn btn--secondary btn--lg', type: 'button', onclick: () => close(false) }, 'Pas encore'));
          controls.querySelector('.btn--primary').focus({ preventScroll: true });
        } else close(false);
      }
    }
    function quitAsk() {
      if (phase === 'rate') { close(false); return; } if (pausedAt === null) pausedAt = performance.now(); phase = 'quit';
      body.replaceChildren(h('h2', { class: 'display', style: { fontSize: 'clamp(2rem, 8vw, 3.4rem)' } }, 'Quitter le focus ?'), h('p', { class: 'lead' }, 'Tu peux reprendre, terminer et noter la session, ou l\'abandonner.'));
      controls.replaceChildren(h('button', { class: 'btn btn--primary btn--lg', type: 'button', onclick: () => { phase = 'run'; togglePause(); } }, icon('play'), 'Reprendre'), h('button', { class: 'btn btn--secondary btn--lg', type: 'button', onclick: () => { phase = 'run'; finish(false); } }, 'Terminer et noter'), h('button', { class: 'btn btn--ghost btn--lg', type: 'button', onclick: () => close(false) }, 'Abandonner'));
      controls.firstChild.focus({ preventScroll: true });
    }
    function close(celebrate) {
      clearInterval(timer); document.removeEventListener('keydown', onKey, true); document.removeEventListener('visibilitychange', onVis);
      if (lock) { lock.release().catch(() => {}); lock = null; }
      document.title = `${NAV.find((n) => n.id === currentRoute.id).title} · Kairos`;
      appRoot.inert = false; root.style.transition = 'opacity .3s'; root.style.opacity = '0'; setTimeout(() => { root.remove(); focusOn = false; }, 320);
      if (celebrate) { confetti(innerWidth / 2, innerHeight * .6); haptic([10, 40, 20]); }
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); phase === 'quit' ? (phase = 'run', togglePause()) : quitAsk(); } else if (e.key === ' ' && phase === 'run' && document.activeElement === document.body) { e.preventDefault(); togglePause(); } };
    const requestLock = async () => { try { if ('wakeLock' in navigator && phase !== 'rate') lock = await navigator.wakeLock.request('screen'); } catch { /* refusé */ } };
    const onVis = () => { if (!document.hidden) { requestLock(); tick(); } };
    document.addEventListener('keydown', onKey, true); document.addEventListener('visibilitychange', onVis);
    document.body.appendChild(root); appRoot.inert = true; requestLock(); paintRun(); timer = setInterval(tick, 250);
    startPerf = performance.now(); haptic(12);
  }

  // ---------------------------------------------------------------------
  // PWA : installation, notifications, service worker
  // ---------------------------------------------------------------------
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; installBtn.hidden = false; });
  window.addEventListener('appinstalled', () => { deferredInstall = null; installBtn.hidden = true; toast('Kairos est installé', { kind: 'ok' }); });
  async function install() { if (!deferredInstall) return; deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch { /* ignoré */ } deferredInstall = null; installBtn.hidden = true; }

  async function enableNotifications() {
    if (!('Notification' in window)) { toast('Les notifications ne sont pas disponibles sur ce navigateur', { kind: 'warn' }); return false; }
    let p = Notification.permission; if (p === 'default') p = await Notification.requestPermission();
    const ok = p === 'granted'; actions.setPrefs({ notifications: ok });
    toast(ok ? 'Rappels activés : tu seras prévenu·e 5 min avant chaque bloc' : 'Notifications refusées par le navigateur', { kind: ok ? 'ok' : 'warn' }); return ok;
  }
  async function notifyNow(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg && reg.showNotification) return void reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'kairos' }); new Notification(title, { body, icon: 'icons/icon-192.png' }); } catch { /* ignoré */ }
  }
  let reminderTimer = 0;
  function armReminder() {
    clearTimeout(reminderTimer); const st = ctx.state; if (!(st.prefs && st.prefs.notifications) || !st.plan) return;
    const now = clock(), done = new Set(st.tasks.filter((x) => x.done).map((x) => x.id));
    const next = (st.plan.blocks || []).filter((b) => !done.has(b.taskId) && b.startMs - 5 * MIN > now).sort((a, b) => a.startMs - b.startMs)[0]; if (!next) return;
    const wait = Math.min(2 ** 31 - 1, next.startMs - 5 * MIN - now);
    reminderTimer = setTimeout(() => { const task = ctx.state.tasks.find((x) => x.id === next.taskId), title = task ? task.title : 'Prochain bloc'; if (!document.hidden) toast(`Prochain bloc dans 5 min : ${title}`, { kind: 'warn', duration: 8000, icon: 'bell' }); notifyNow('Prochain bloc dans 5 min', `${title} · ${fmtTime(next.startMs)}`); armReminder(); }, Math.max(1000, wait));
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => { const w = reg.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Une nouvelle version de Kairos est prête', { kind: 'ok', undoLabel: 'Recharger', duration: 12000, onUndo: () => { w.postMessage('SKIP_WAITING'); setTimeout(() => location.reload(), 150); } }); }); });
    }).catch(() => { /* hors-ligne ou contexte non sécurisé */ });
  }

  // ---------------------------------------------------------------------
  // Raccourcis clavier
  // ---------------------------------------------------------------------
  let chord = null, chordTimer = 0;
  const typing = (t) => t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !['checkbox', 'radio', 'range', 'button'].includes(t.type));
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const k = e.key, low = k.length === 1 ? k.toLowerCase() : k, mod = e.ctrlKey || e.metaKey;
    if (mod && low === 'k') { e.preventDefault(); if (!focusOn && !document.querySelector('.palette')) ctx.openPalette(); return; }
    if (focusOn || modalIsOpen()) return;
    if (mod && low === 'z' && !typing(e.target)) { e.preventDefault(); if (e.shiftKey ? store.redo() : store.undo()) toast(e.shiftKey ? 'Rétabli' : 'Annulé', { duration: 1600 }); return; }
    if (mod && low === 'y' && !typing(e.target)) { e.preventDefault(); if (store.redo()) toast('Rétabli', { duration: 1600 }); return; }
    if (mod || e.altKey || typing(e.target)) return;
    if (chord) { clearTimeout(chordTimer); chord = null; const n = NAV.find((x) => x.key === low); if (n) { e.preventDefault(); navigate(`#/${n.id}`); } return; }
    if (low === 'g' && !e.shiftKey) { chord = 'g'; chordTimer = setTimeout(() => { chord = null; }, 1200); return; }
    if (low === 'n') { e.preventDefault(); ctx.openTaskEditor(); }
    else if (low === 'c') { e.preventDefault(); actions.logCaffeine({ tMs: clock(), mg: 80, kind: 'café' }); toast('Café enregistré · 80 mg', { undoLabel: 'Annuler', onUndo: () => store.undo() }); }
    else if (k === '?') { e.preventDefault(); openHelp(); }
    else if (k === '/') { e.preventDefault(); ctx.openPalette(); }
    else if (k === 'T') { e.preventDefault(); toggleTimeTravel(); }
  });

  // ---------------------------------------------------------------------
  // Abonnement au store : thème, célébrations, rappels
  // ---------------------------------------------------------------------
  let doneIds = new Set(store.getState().tasks.filter((x) => x.done).map((x) => x.id)), lastTheme = null;
  const afterChange = debounce(() => { updateAtmosphere(); armReminder(); updateEyebrow(); }, 80);
  store.subscribe((state, change) => {
    version++;
    const t = state.prefs && state.prefs.theme; if (t !== lastTheme) { lastTheme = t; applyTheme(t); }
    const now = new Set(state.tasks.filter((x) => x.done).map((x) => x.id)); const added = [...now].filter((id) => !doneIds.has(id)); doneIds = now;
    const bulk = change && /load|import|reset|demo/i.test(change.type || '');
    if (added.length && added.length <= 2 && !bulk) { confetti(innerWidth / 2, innerHeight * .78, { count: 48 }); haptic([10, 40, 18]); }
    afterChange(); notify(state, change);
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', updateAtmosphere);
  lastTheme = ctx.state.prefs && ctx.state.prefs.theme; applyTheme(lastTheme);

  // Horloge : tic à chaque minute pile
  (function loop() { const wait = 60000 - (Date.now() % 60000) + 40; setTimeout(() => { updateEyebrow(); updateAtmosphere(); const tt = ttBar.querySelector('[data-role="tt-time"]'); if (tt) tt.textContent = `${fmt.dateShort(clock())} ${fmtTime(clock())}`; notify(ctx.state, { type: 'tick' }); loop(); }, wait); })();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateEyebrow(); updateAtmosphere(); notify(ctx.state, { type: 'tick' }); } });

  // ---------------------------------------------------------------------
  // Onboarding
  // ---------------------------------------------------------------------
  window.kairos = ctx; // exposé tôt : débogage et tests de bout en bout (avant même l'onboarding)
  if (!(ctx.state.prefs && ctx.state.prefs.onboarded)) { hideSplash(); appRoot.hidden = true; await runOnboarding(); appRoot.hidden = false; appRoot.animate && !reduce() && appRoot.animate([{ opacity: 0, transform: 'scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' }); }

  function runOnboarding() {
    return new Promise((resolve) => {
      const prof = ctx.state.profile || {}, data = { wake: parseHHMM(prof.usualWake || '07:00'), bed: parseHHMM(prof.usualBed || '23:00'), need: prof.sleepNeedH || 8, demo: true };
      const root = h('div', { class: 'onboard', id: 'onboard-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bienvenue dans Kairos' });
      document.body.appendChild(root); let step = 0, dir = 1; const STEPS = 4;
      const dial = sleepDial({ wake: data.wake, bed: data.bed, need: data.need });
      const timeInput = (id, val, onch) => h('input', { class: 'input num', id, type: 'time', value: toHHMM(val), step: '300', onchange: (e) => { try { onch(parseHHMM(e.target.value)); } catch { /* saisie incomplète */ } } });
      const dur = () => ((data.wake - data.bed) % 1440 + 1440) % 1440 || 1440;
      const sync = () => dial.update(data.wake, data.bed, data.need);
      const panels = [
        () => h('div', { class: 'onboard__panel' }, introArt(),
          h('h1', { class: 'display' }, 'Ton cerveau a un ', h('em', null, 'emploi du temps'), '.'),
          h('p', { class: 'lead' }, 'Kairos prédit ton énergie heure par heure (rythme circadien, pression de sommeil, caféine) et place chaque tâche là où tu seras au meilleur de toi.'),
          h('p', { class: 'small faint' }, 'Tout reste sur cet appareil. Pas de compte, pas de serveur.')),
        () => { const sub = h('p', { class: 'muted num' }); const upd = () => { sub.textContent = `${fmtDuration(dur())} entre ${toHHMM(data.bed)} et ${toHHMM(data.wake)}`; sync(); };
          upd(); return h('div', { class: 'onboard__panel' }, h('h1', { class: 'h1' }, 'Tes heures habituelles'), dial.el,
            h('div', { class: 'pair' }, h('label', { class: 'timebox' }, h('span', { class: 'label' }, 'Coucher'), timeInput('ob-bed', data.bed, (v) => { data.bed = v; upd(); })), h('label', { class: 'timebox' }, h('span', { class: 'label' }, 'Réveil'), timeInput('ob-wake', data.wake, (v) => { data.wake = v; upd(); }))), sub); },
        () => { const big = h('div', { class: 'stat__value gradient-text', style: { fontSize: '3.4rem' } }), hint = h('p', { class: 'muted small' });
          const range = h('input', { class: 'range', type: 'range', min: '6', max: '10', step: '0.25', value: String(data.need), 'aria-label': 'Besoin de sommeil en heures', style: { maxWidth: '420px' } });
          const upd = () => { data.need = Number(range.value); big.textContent = fmtDuration(data.need * 60); const gap = (dur() / 60) - data.need; hint.textContent = gap >= -.25 ? 'Tes horaires couvrent ton besoin. Parfait.' : `Tes horaires te laissent ${fmtDuration(-gap * 60)} de moins que ton besoin : Kairos en tiendra compte.`; sync(); };
          range.addEventListener('input', upd); upd();
          return h('div', { class: 'onboard__panel' }, h('h1', { class: 'h1' }, 'Combien de sommeil te faut-il ?'), dial.el, big, range, hint, h('p', { class: 'tiny faint' }, 'Sans réveil et reposé·e, c\'est probablement ta valeur. La plupart des adultes : 7 à 9 h.')); },
        () => { const sw = h('input', { type: 'checkbox', checked: data.demo, onchange: (e) => { data.demo = e.target.checked; } });
          return h('div', { class: 'onboard__panel' }, h('div', { style: { color: 'var(--accent-text)' } }, icon('sparkle', { size: 44, stroke: 1.5 })), h('h1', { class: 'h1' }, 'Prêt·e à explorer ?'),
            h('p', { class: 'lead' }, 'Kairos s\'affine avec tes check-ins : plus tu en notes, plus la courbe te ressemble.'),
            h('div', { class: 'card card--sun', style: { textAlign: 'left', width: '100%' } }, h('label', { class: 'switch' }, sw, h('span', { class: 'switch__ui' }), h('span', null, h('strong', null, 'Charger des données de démo'), h('span', { class: 'muted small', style: { display: 'block' } }, 'Une semaine fictive pour tout essayer. Effaçable dans Réglages.')))),
            h('p', { class: 'tiny faint' }, 'Kairos est un outil d\'organisation et de confort, pas un dispositif médical.')); },
      ];
      function paint() {
        root.replaceChildren(
          h('div', { class: 'onboard__steps', 'aria-hidden': 'true' }, ...Array.from({ length: STEPS }, (_, i) => h('span', { class: clsx('onboard__step', i === step && 'is-on', i < step && 'is-done') }))),
          h('div', { class: 'onboard__stage', style: { '--dir': `${dir * 40}px` } }, panels[step]()),
          h('div', { class: 'onboard__foot' }, step > 0 ? h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => { dir = -1; step--; paint(); } }, icon('arrow-left', { size: 18 }), 'Retour') : h('span'),
            h('button', { class: 'btn btn--primary btn--lg', type: 'button', onclick: next }, step === STEPS - 1 ? 'Entrer dans Kairos' : step === 0 ? 'Commencer' : 'Continuer', icon('arrow-right', { size: 20 }))));
        $$('input.range', root).forEach(syncRange); const first = root.querySelector('input, .btn--primary'); (root.querySelector('.btn--primary') || first).focus({ preventScroll: true });
      }
      async function next() {
        if (step < STEPS - 1) { dir = 1; step++; paint(); haptic(8); return; }
        actions.setProfile({ usualWake: toHHMM(data.wake), usualBed: toHHMM(data.bed), sleepNeedH: data.need });
        if (data.demo) { try { const m = await import('../core/demo.js'); actions.loadDemo(m.makeDemoState(clock(), 7)); } catch { toast('Les données de démo ne sont pas disponibles pour l\'instant', { kind: 'warn' }); data.demo = false; } }
        actions.setPrefs({ onboarded: true, demo: !!data.demo }); haptic([10, 30, 20]);
        root.style.transition = 'opacity .5s, transform .5s'; root.style.opacity = '0'; root.style.transform = 'scale(1.03)'; setTimeout(() => { root.remove(); resolve(); }, 480);
      }
      root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); next(); } });
      paint();
    });
  }

  // ---------------------------------------------------------------------
  // Lancement
  // ---------------------------------------------------------------------
  window.addEventListener('hashchange', route);
  if (!location.hash || !parseHash().valid) history.replaceState(null, '', '#/today');
  updateEyebrow(); updateAtmosphere(); armReminder();
  import('./views/settings.js').then((m) => m.applyHapticsPref && m.applyHapticsPref()).catch(() => {}); // préférence « retour haptique » dès le lancement
  await route();
  window.kairos = ctx; // utile pour le débogage et les tests de bout en bout
}

/** Illustration d'accueil : cadrans qui tournent lentement autour d'un soleil qui respire. */
function introArt() {
  const ring = (r, n, len, cls, op) => svg('g', { class: cls, opacity: op }, ...Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2, big = i % 5 === 0; return svg('line', { x1: 100 + Math.cos(a) * r, y1: 100 + Math.sin(a) * r, x2: 100 + Math.cos(a) * (r - (big ? len * 1.9 : len)), y2: 100 + Math.sin(a) * (r - (big ? len * 1.9 : len)), stroke: big ? 'var(--sun)' : 'currentColor', 'stroke-width': big ? 1.8 : 1, 'stroke-linecap': 'round' }); }));
  return h('div', { class: 'intro-art', 'aria-hidden': 'true' }, svg('svg', { viewBox: '0 0 200 200' }, ring(98, 120, 4, 'ring-a', .5), ring(80, 60, 5, 'ring-b', .35), svg('circle', { cx: 100, cy: 100, r: 62, fill: 'none', stroke: 'var(--night)', 'stroke-width': 1, 'stroke-dasharray': '2 6', opacity: .6 })), h('span', { class: 'orb' }), h('span', { class: 'intro-art__k' }, logo(70)));
}

/** Illustration d'état vide : petit cadran. */
function dialArt() {
  const ticks = []; for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2, big = i % 4 === 0; ticks.push(svg('line', { x1: 60 + Math.cos(a) * 54, y1: 60 + Math.sin(a) * 54, x2: 60 + Math.cos(a) * (big ? 46 : 50), y2: 60 + Math.sin(a) * (big ? 46 : 50), stroke: 'currentColor', 'stroke-width': big ? 1.6 : 1, 'stroke-linecap': 'round', opacity: big ? .8 : .45 })); }
  return svg('svg', { viewBox: '0 0 120 120', width: '112', height: '112', 'aria-hidden': 'true' }, svg('g', { class: 'spin-slow' }, ...ticks), svg('circle', { cx: 60, cy: 60, r: 22, fill: 'none', stroke: 'var(--sun)', 'stroke-width': 1.6, opacity: .9 }), svg('circle', { cx: 60, cy: 60, r: 7, fill: 'var(--sun)' }));
}
