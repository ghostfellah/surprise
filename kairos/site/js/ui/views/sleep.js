// Vue « Sommeil » : une fenêtre ouverte sur la nuit.
// Héros nocturne (étoiles, lune réelle et animée) avec « ton coucher idéal ce soir » et son compte à rebours,
// saisie ultra rapide de la nuit au cadran 24 h (poignées à glisser, clavier, ± 5 min), dette sur 14 jours,
// sieste conseillée, courbe de pression de sommeil S, régularité, chronotype, carte de chaleur de 8 semaines
// et journal des nuits.
//
// Honnêteté : tout est calculé par le moteur local (sleep.js, model.js, insights.js) ; ce sont des estimations de
// confort, pas un avis médical. Les nuits non notées sont « supposées habituelles » par le modèle, jamais inventées ici.
import { h, svg, icon, ICONS, replaceChildren, animateNumber, prefersReducedMotion, haptic, uniqueId } from '../dom.js';
import { heatmap, barChart } from '../charts.js';
import { suggestBedtime, planNap, sleepNeedH } from '../../core/sleep.js';
import { caffeineCutoff } from '../../core/caffeine.js';
import { computeInsights, sleepHeatmap } from '../../core/insights.js';
import {
  MIN, HOUR, DAY, startOfDay, addDays, atMinutes, minutesOfDay, parseHHMM, toHHMM, fmtTime, fmtDuration, fmtDateFR, clamp, JOURS_FR,
} from '../../core/time.js';

const CSS = 'css/views-sleep.css';

/** Injecte la feuille de style une seule fois (le shell peut déjà l'avoir ajoutée). */
function ensureCss() {
  const href = new URL(CSS, document.baseURI).href;
  if (Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((l) => l.href === href)) return;
  const link = h('link', { rel: 'stylesheet', href: CSS });
  link.onerror = () => link.remove();
  document.head.appendChild(link);
}

// ---------------------------------------------------------------------------------------------
// Petits utilitaires
// ---------------------------------------------------------------------------------------------
const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const fr1 = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
const hhmm = (ms) => fmtTime(ms);
const durLabel = (min) => fmtDuration(Math.max(0, Math.round(min)));
const QUALITY = ['', 'Agitée', 'Moyenne', 'Correcte', 'Bonne', 'Excellente'];
const mapRange = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);

/** « dans 3 h 20 », « dans 12 min », « maintenant », « il y a 25 min ». */
function countdown(ms, nowMs) {
  const d = Math.round((ms - nowMs) / MIN);
  if (Math.abs(d) < 1) return 'maintenant';
  if (d > 0) return `dans ${durLabel(d)}`;
  return `il y a ${durLabel(-d)}`;
}

/**
 * Réveil visé pour LA PROCHAINE nuit : l'occurrence de `str` (HH:MM) qui tombe au moins 4 h après maintenant
 * (à 07 h 07, on prépare ce soir pour demain, pas une nuit déjà terminée ; à 01 h on prépare encore la nuit en cours).
 */
function nextOccurrence(str, nowMs) {
  let min = 7 * 60;
  try { min = parseHHMM(str); } catch { /* défaut */ }
  const t = atMinutes(nowMs, min);
  return t - nowMs >= 4 * HOUR ? t : atMinutes(addDays(nowMs, 1), min);
}

/** Phase de la Lune (0 = nouvelle, 0,5 = pleine) d'après la lunaison moyenne (précision ≈ 1 jour : suffisant pour un décor). */
export function moonPhase(ms) {
  const SYN = 29.530588853;
  const NEW_MOON_2000 = Date.UTC(2000, 0, 6, 18, 14);
  const p = ((((ms - NEW_MOON_2000) / DAY) % SYN) + SYN) % SYN / SYN;
  return p;
}
const moonName = (p) => (p < 0.03 || p > 0.97 ? 'Nouvelle lune' : p < 0.22 ? 'Premier croissant' : p < 0.28 ? 'Premier quartier' : p < 0.47 ? 'Lune gibbeuse croissante'
  : p < 0.53 ? 'Pleine lune' : p < 0.72 ? 'Lune gibbeuse décroissante' : p < 0.78 ? 'Dernier quartier' : 'Dernier croissant');

/** Chemin SVG de la partie éclairée de la Lune (rayon r, centre cx, cy). */
function moonLitPath(p, cx, cy, r) {
  const waxing = p < 0.5;
  const rx = Math.abs(Math.cos(TAU * p)) * r;
  const limbSweep = waxing ? 1 : 0;
  const crescent = waxing ? p < 0.25 : p > 0.75;
  const termSweep = waxing ? (crescent ? 0 : 1) : (crescent ? 1 : 0);
  return `M ${cx} ${cy - r} A ${r} ${r} 0 0 ${limbSweep} ${cx} ${cy + r} A ${rx.toFixed(2)} ${r} 0 0 ${termSweep} ${cx} ${cy - r} Z`;
}

/** Lune animée (phase réelle du jour) : halo, cratères, flottement lent. */
function moonSvg(nowMs, size = 120) {
  const p = moonPhase(nowMs);
  const id = uniqueId('mn');
  const lit = (1 - Math.cos(TAU * p)) / 2;
  const el = svg('svg', { class: 'sl-moon', viewBox: '0 0 120 120', width: size, height: size, role: 'img', 'aria-label': `${moonName(p)}, ${Math.round(lit * 100)} % éclairée` },
    svg('defs', null,
      svg('radialGradient', { id: `${id}-g`, cx: '38%', cy: '34%', r: '75%' },
        svg('stop', { offset: '0', 'stop-color': '#fffdf2' }), svg('stop', { offset: '.55', 'stop-color': '#e9ecd9' }), svg('stop', { offset: '1', 'stop-color': '#b9c4c2' })),
      svg('radialGradient', { id: `${id}-h` },
        svg('stop', { offset: '.4', 'stop-color': '#9fe9de', 'stop-opacity': '.38' }), svg('stop', { offset: '1', 'stop-color': '#9fe9de', 'stop-opacity': '0' })),
      svg('clipPath', { id: `${id}-c` }, svg('path', { d: moonLitPath(p, 60, 60, 34) }))),
    svg('circle', { class: 'sl-moon__halo', cx: 60, cy: 60, r: 58, fill: `url(#${id}-h)` }),
    svg('circle', { cx: 60, cy: 60, r: 34, fill: 'rgba(120,150,170,.16)', stroke: 'rgba(190,230,230,.2)', 'stroke-width': 1 }),
    svg('g', { 'clip-path': `url(#${id}-c)` },
      svg('circle', { cx: 60, cy: 60, r: 34, fill: `url(#${id}-g)` }),
      svg('circle', { cx: 48, cy: 50, r: 6, fill: 'rgba(120,135,130,.22)' }),
      svg('circle', { cx: 70, cy: 68, r: 8.5, fill: 'rgba(120,135,130,.2)' }),
      svg('circle', { cx: 62, cy: 44, r: 3.6, fill: 'rgba(120,135,130,.18)' }),
      svg('circle', { cx: 52, cy: 75, r: 4.4, fill: 'rgba(120,135,130,.18)' })));
  return { el, phaseName: moonName(p), lit };
}

/** Champ d'étoiles déterministe (positions fixes, scintillement décalé). */
function starField(count = 46) {
  let a = 1234567;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const big = rnd() > 0.86;
    frag.appendChild(h('i', {
      class: big ? 'sl-star sl-star--big' : 'sl-star',
      style: { left: `${(rnd() * 100).toFixed(1)}%`, top: `${(rnd() * 78).toFixed(1)}%`, '--d': `${(2.2 + rnd() * 4).toFixed(1)}s`, '--delay': `${(-rnd() * 6).toFixed(1)}s`, '--o': (0.35 + rnd() * 0.6).toFixed(2) },
    }));
  }
  return frag;
}

/** Chemin d'arc SVG (angles en degrés, 0° = droite, sens horaire). */
function arcPath(cx, cy, r, a0, a1) {
  const span = ((a1 - a0) % 360 + 360) % 360 || 360;
  const pt = (a) => [cx + r * Math.cos(a * D2R), cy + r * Math.sin(a * D2R)];
  const [x0, y0] = pt(a0); const [x1, y1] = pt(a0 + span);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Anneau de score (0..100) : SVG, trait qui se remplit, chiffre au centre. */
function scoreRing({ value, label, color = 'var(--night)', size = 132 }) {
  const r = 52; const C = TAU * r; const id = uniqueId('rg');
  const arc = svg('circle', { class: 'sl-ring__arc', cx: 70, cy: 70, r, fill: 'none', 'stroke-width': 11, 'stroke-linecap': 'round', stroke: `url(#${id})`,
    'stroke-dasharray': `${C} ${C}`, 'stroke-dashoffset': C, transform: 'rotate(-90 70 70)' });
  const num = h('b', { class: 'sl-ring__num' }, '0');
  const el = h('div', { class: 'sl-ring', style: { width: `${size}px`, height: `${size}px`, '--rc': color } },
    svg('svg', { viewBox: '0 0 140 140', 'aria-hidden': 'true' },
      svg('defs', null, svg('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' }, svg('stop', { offset: '0', style: 'stop-color: var(--night-deep)' }), svg('stop', { offset: '1', style: `stop-color: ${color}` }))),
      svg('circle', { cx: 70, cy: 70, r, fill: 'none', 'stroke-width': 11, class: 'sl-ring__track' }), arc),
    h('div', { class: 'sl-ring__center' }, num, label ? h('span', { class: 'sl-ring__label' }, label) : null));
  const set = (v) => {
    const f = clamp(v / 100, 0, 1);
    requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', String(C * (1 - f)))));
    animateNumber(num, Math.round(v), { duration: 1100 });
  };
  set(value);
  return el;
}

// ---------------------------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------------------------
export default {
  id: 'sleep',
  title: 'Sommeil',
  icon: 'moon',

  mount(root, ctx) {
    ensureCss();
    const reduce = prefersReducedMotion();
    const cleanups = [];
    let chartKill = [];
    let timer = 0;

    // État éphémère de l'interface (survit aux redessins déclenchés par le store)
    const ui = {
      wakeStr: ctx.state.profile.usualWake || '07:30',
      cycles: null, // coucher choisi parmi les alternatives
      mode: 'night', // night | nap
      bedMin: parseHHMM(ctx.state.profile.usualBed || '23:30'),
      wakeMin: parseHHMM(ctx.state.profile.usualWake || '07:30'),
      dayOffset: 0,
      quality: 3,
      napDur: 20, napStart: null,
      journalAll: false,
      scrub: null,
    };

    const page = h('div', { class: 'sl sl--enter' });
    root.appendChild(page);
    const heroBox = h('section', { class: 'sl-hero card card--flat', 'aria-label': 'Ton coucher idéal ce soir' });
    const colL = h('div', { class: 'sl-col' });
    const colR = h('div', { class: 'sl-col' });
    const logBox = h('section', { class: 'card sl-log', style: { '--o': 2 } });
    const debtBox = h('section', { class: 'card sl-debt', style: { '--o': 3 } });
    const napBox = h('section', { class: 'card sl-nap card--night', style: { '--o': 4 } });
    const pressBox = h('section', { class: 'card sl-press', style: { '--o': 5 } });
    const regBox = h('section', { class: 'card sl-reg', style: { '--o': 6 } });
    const chronoBox = h('section', { class: 'card sl-chrono', style: { '--o': 7 } });
    const heatBox = h('section', { class: 'card sl-heat', style: { '--o': 8 } });
    const journalBox = h('section', { class: 'card sl-journal', style: { '--o': 9 } });
    colL.append(logBox, debtBox, pressBox, heatBox);
    colR.append(napBox, regBox, chronoBox, journalBox);
    heroBox.style.setProperty('--o', 1);
    page.append(heroBox, colL, colR);
    setTimeout(() => page.classList.remove('sl--enter'), 1800);

    const killCharts = () => { for (const k of chartKill) { try { k(); } catch { /* déjà détruit */ } } chartKill = []; };
    const canvas = (label) => h('canvas', { role: 'img', 'aria-label': label });
    const header = (iconName, title, sub, extra) => h('div', { class: 'card__head sl-head' },
      h('div', { class: 'row' }, h('span', { class: 'sl-head__ico' }, icon(iconName, { size: 18 })), h('div', null, h('h2', { class: 'card__title' }, title), sub ? h('div', { class: 'card__sub' }, sub) : null)),
      extra || null);

    // ===========================================================================
    // HÉROS : coucher idéal ce soir
    // ===========================================================================
    let heroRefs = null;
    function suggestion() {
      const now = ctx.nowMs();
      const wakeMs = nextOccurrence(ui.wakeStr, now);
      const s = suggestBedtime({ wakeMs, profile: ctx.state.profile, nowMs: now });
      const options = [s, ...s.alternatives].sort((a, b) => b.cycles - a.cycles);
      const chosen = options.find((o) => o.cycles === ui.cycles) || s;
      return { now, wakeMs, best: s, options, chosen };
    }

    function renderHero() {
      const { now, wakeMs, best, options, chosen } = suggestion();
      const st = ctx.state;
      const moon = moonSvg(now, 132);
      const cut = caffeineCutoff({ logs: [], profile: st.profile, bedMs: chosen.bedMs }); // pour une tasse de référence (80 mg)
      const late = !chosen.feasible;
      const time = h('div', { class: 'sl-hero__time', 'aria-live': 'polite' }, hhmm(chosen.bedMs));
      const count = h('div', { class: 'sl-hero__count' }, countdown(chosen.bedMs, now));
      const wakeInput = h('input', {
        class: 'input sl-hero__wake', type: 'time', value: ui.wakeStr, 'aria-label': 'Heure de réveil visée',
        onchange: (e) => { if (/^\d\d:\d\d$/.test(e.target.value)) { ui.wakeStr = e.target.value; ui.cycles = null; renderHero(); } },
      });
      const chips = options.map((o) => h('button', {
        class: 'sl-opt', type: 'button', 'aria-pressed': String(o.cycles === chosen.cycles), 'data-best': o.cycles === best.cycles ? '1' : null,
        onclick: () => { ui.cycles = o.cycles; haptic(6); renderHero(); },
      }, h('b', null, hhmm(o.bedMs)), h('span', null, `${o.cycles} cycle${o.cycles > 1 ? 's' : ''} · ${durLabel(o.durationMin)}`), o.cycles === best.cycles ? h('em', null, 'idéal') : null));
      const rows = h('ul', { class: 'sl-hero__steps' },
        h('li', null, icon('wind', { size: 16 }), h('span', null, 'Ralentis dès ', h('b', null, hhmm(chosen.bedMs - 90 * MIN)), ' : lumière douce, écrans en pause')),
        h('li', null, icon('coffee', { size: 16 }), cut <= now
          ? h('span', null, 'Plus de café d\'ici le coucher : le dernier utile était avant ', h('b', null, hhmm(cut)))
          : h('span', null, 'Dernier café avant ', h('b', null, hhmm(cut)), ' (une tasse de 80 mg)')),
        h('li', null, icon('sunrise', { size: 16 }), h('span', null, 'Réveil à ', h('b', null, hhmm(wakeMs)), ` après ${durLabel(chosen.durationMin)} de sommeil`)));
      replaceChildren(heroBox,
        h('div', { class: 'sl-sky', 'aria-hidden': 'true' }, starField(), h('i', { class: 'sl-shoot' }), h('i', { class: 'sl-shoot sl-shoot--b' }),
          svg('svg', { class: 'sl-hills', viewBox: '0 0 400 60', preserveAspectRatio: 'none' },
            svg('path', { d: 'M0 60V38C40 24 70 30 110 36s70-14 120-12 80 14 120 6 40-8 50-6v38z', class: 'sl-hills__a' }),
            svg('path', { d: 'M0 60V48c50-10 90-6 140 0s90 4 130-4 90-2 130 4v12z', class: 'sl-hills__b' }))),
        h('div', { class: 'sl-hero__moon', title: moon.phaseName }, moon.el, h('span', { class: 'sl-hero__phase' }, moon.phaseName)),
        h('div', { class: 'sl-hero__body' },
          h('div', { class: 'eyebrow sl-hero__eyebrow' }, late ? 'Il se fait tard' : 'Ton coucher idéal ce soir'),
          time, count,
          h('p', { class: 'sl-hero__why' }, late ? chosen.why : `${chosen.cycles} cycle${chosen.cycles > 1 ? 's' : ''} de 90 min + 15 min pour t'endormir : tu te réveilles à la fin d'un cycle, pas au milieu d'un sommeil profond.`),
          h('label', { class: 'sl-hero__wakeRow' }, h('span', null, 'Je dois me lever à'), wakeInput),
          h('div', { class: 'sl-opts', role: 'group', 'aria-label': 'Autres heures de coucher' }, chips),
          rows));
      if (!reduce) time.animate([{ opacity: 0, transform: 'translateY(10px) scale(.97)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
      heroRefs = { count, bedMs: chosen.bedMs };
    }

    // Le compte à rebours bat à la seconde près de la minute : on le rafraîchit sans reconstruire le héros.
    const tickCountdown = () => { if (heroRefs && heroRefs.count.isConnected) heroRefs.count.textContent = countdown(heroRefs.bedMs, ctx.nowMs()); };
    timer = setInterval(tickCountdown, 15_000);
    cleanups.push(() => clearInterval(timer));

    // ===========================================================================
    // SAISIE : cadran 24 h
    // ===========================================================================
    const dialEls = {};
    function buildLog() {
      const R = 88; const C0 = 120;
      const ang = (min) => (min / 1440) * 360 + 90;
      const pt = (min, r) => [C0 + Math.cos(ang(min) * D2R) * r, C0 + Math.sin(ang(min) * D2R) * r];
      const gid = uniqueId('dg');

      const ticks = [];
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * TAU + Math.PI / 2; const big = i % 4 === 0; const r1 = 111; const r2 = big ? 104 : 107.5;
        ticks.push(svg('line', { class: big ? 'sl-tick sl-tick--h' : 'sl-tick', x1: C0 + Math.cos(a) * r1, y1: C0 + Math.sin(a) * r1, x2: C0 + Math.cos(a) * r2, y2: C0 + Math.sin(a) * r2 }));
      }
      const labels = [[0, '00'], [360, '06'], [720, '12'], [1080, '18']].map(([m, t]) => { const [x, y] = pt(m, 74); return svg('text', { class: 'sl-dial__lbl', x, y: y + 3.5, 'text-anchor': 'middle' }, t); });
      const track = svg('circle', { class: 'sl-dial__track', cx: C0, cy: C0, r: R, fill: 'none', 'stroke-width': 18 });
      const sleepArc = svg('path', { class: 'sl-dial__sleep', fill: 'none', 'stroke-width': 18, 'stroke-linecap': 'round', stroke: `url(#${gid})` });
      const cyc = svg('g', { class: 'sl-dial__cycles' });
      const bed = svg('g', { class: 'sl-handle sl-handle--bed', tabindex: 0, role: 'slider', 'aria-label': 'Heure de coucher', 'aria-valuemin': 0, 'aria-valuemax': 1439 },
        svg('circle', { r: 17, class: 'sl-handle__halo' }), svg('circle', { r: 14, class: 'sl-handle__disc' }));
      const sun = svg('g', { class: 'sl-handle sl-handle--wake', tabindex: 0, role: 'slider', 'aria-label': 'Heure de réveil', 'aria-valuemin': 0, 'aria-valuemax': 1439 },
        svg('circle', { r: 17, class: 'sl-handle__halo' }), svg('circle', { r: 14, class: 'sl-handle__disc' }));
      const glyph = (name) => { const g = svg('g', { class: 'sl-handle__glyph', transform: 'translate(-8 -8) scale(.667)', stroke: 'currentColor', fill: 'none', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); g.innerHTML = ICONS[name]; return g; };
      bed.appendChild(glyph('moon')); sun.appendChild(glyph('sun'));
      const dial = svg('svg', { class: 'sl-dial__svg', viewBox: '0 0 240 240', role: 'group', 'aria-label': 'Cadran de 24 heures : glisse la lune pour le coucher et le soleil pour le réveil' },
        svg('defs', null, svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' }, svg('stop', { offset: '0', style: 'stop-color: var(--night-deep)' }), svg('stop', { offset: '1', style: 'stop-color: var(--night)' }))),
        svg('circle', { cx: C0, cy: C0, r: 100, class: 'sl-dial__disc' }), ...ticks, ...labels, track, sleepArc, cyc, bed, sun);

      const durNum = h('b', { class: 'sl-dial__dur' }, '0 h');
      const durSub = h('span', { class: 'sl-dial__sub' }, 'de sommeil');
      const durDelta = h('span', { class: 'sl-dial__delta' }, '');
      const center = h('div', { class: 'sl-dial__center', 'aria-live': 'polite' }, durNum, durSub, durDelta);
      const wrap = h('div', { class: 'sl-dial' }, dial, center);

      const need = sleepNeedH(ctx.state.profile);
      let lastDur = 0;
      function paint(animate = true) {
        const dur = (ui.wakeMin - ui.bedMin + 1440) % 1440;
        sleepArc.setAttribute('d', dur ? arcPath(C0, C0, R, ang(ui.bedMin), ang(ui.bedMin) + (dur / 1440) * 360) : '');
        const [bx, by] = pt(ui.bedMin, R); const [wx, wy] = pt(ui.wakeMin, R);
        bed.setAttribute('transform', `translate(${bx.toFixed(2)} ${by.toFixed(2)})`); sun.setAttribute('transform', `translate(${wx.toFixed(2)} ${wy.toFixed(2)})`);
        bed.setAttribute('aria-valuenow', ui.bedMin); bed.setAttribute('aria-valuetext', toHHMM(ui.bedMin));
        sun.setAttribute('aria-valuenow', ui.wakeMin); sun.setAttribute('aria-valuetext', toHHMM(ui.wakeMin));
        // repères de cycles de 90 min le long de l'arc
        cyc.replaceChildren();
        for (let m = 15 + 90; m < dur - 20; m += 90) { const [x, y] = pt(ui.bedMin + m, R); cyc.appendChild(svg('circle', { cx: x, cy: y, r: 2.4, class: 'sl-dial__cyc' })); }
        animateNumber(durNum, dur, { from: lastDur, duration: animate ? 260 : 0, format: (v) => durLabel(v) });
        lastDur = dur;
        const diff = dur - need * 60;
        durDelta.textContent = Math.abs(diff) < 10 ? 'pile ton besoin' : `${diff > 0 ? '+' : '−'}${durLabel(Math.abs(diff))} vs ton besoin`;
        durDelta.dataset.state = Math.abs(diff) < 10 ? 'ok' : diff > 0 ? 'plus' : diff > -60 ? 'bit' : 'less';
        if (dialEls.bedIn) { dialEls.bedIn.value = toHHMM(ui.bedMin); dialEls.wakeIn.value = toHHMM(ui.wakeMin); }
        if (dialEls.dayLabels) paintDays();
      }

      // glisser : la poignée la plus proche de l'angle du doigt suit
      let active = null;
      const minFromEvent = (e) => {
        const r = dial.getBoundingClientRect();
        const x = e.clientX - (r.left + r.width / 2); const y = e.clientY - (r.top + r.height / 2);
        const a = (Math.atan2(y, x) / D2R + 360) % 360;
        return Math.round((((a - 90 + 360) % 360) / 360 * 1440) / 5) * 5 % 1440;
      };
      const circ = (a, b) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d); };
      dial.addEventListener('pointerdown', (e) => {
        const m = minFromEvent(e);
        const t = e.target.closest && e.target.closest('.sl-handle');
        active = t ? (t === bed ? 'bed' : 'wake') : (circ(m, ui.bedMin) <= circ(m, ui.wakeMin) ? 'bed' : 'wake');
        dial.setPointerCapture(e.pointerId);
        dial.classList.add('is-drag');
        if (active === 'bed') ui.bedMin = m; else ui.wakeMin = m;
        paint(false); e.preventDefault();
      });
      dial.addEventListener('pointermove', (e) => {
        if (!active) return;
        const m = minFromEvent(e);
        if ((active === 'bed' ? ui.bedMin : ui.wakeMin) !== m) { if (active === 'bed') ui.bedMin = m; else ui.wakeMin = m; haptic(3); paint(false); }
      });
      const end = () => { active = null; dial.classList.remove('is-drag'); };
      dial.addEventListener('pointerup', end); dial.addEventListener('pointercancel', end);
      for (const [el, key] of [[bed, 'bedMin'], [sun, 'wakeMin']]) {
        el.addEventListener('keydown', (e) => {
          const step = e.shiftKey ? 30 : 5;
          if (['ArrowRight', 'ArrowUp'].includes(e.key)) ui[key] = (ui[key] + step) % 1440;
          else if (['ArrowLeft', 'ArrowDown'].includes(e.key)) ui[key] = (ui[key] - step + 1440) % 1440;
          else return;
          e.preventDefault(); paint(false);
        });
      }

      // contrôles fins : champs heure + boutons ± 5 min
      const stepBtn = (key, delta, label) => h('button', { class: 'iconbtn sl-step', type: 'button', 'aria-label': label, onclick: () => { ui[key] = (ui[key] + delta + 1440) % 1440; paint(false); haptic(4); } }, icon(delta > 0 ? 'plus' : 'minus', { size: 16 }));
      const timeCtl = (key, labelText, ico, inputKey) => {
        const input = h('input', { class: 'input sl-time', type: 'time', 'aria-label': labelText, value: toHHMM(ui[key]), onchange: (e) => { if (/^\d\d:\d\d$/.test(e.target.value)) { ui[key] = parseHHMM(e.target.value); paint(false); } } });
        dialEls[inputKey] = input;
        return h('div', { class: 'sl-ctl' }, h('div', { class: 'sl-ctl__lbl' }, icon(ico, { size: 15 }), labelText),
          h('div', { class: 'sl-ctl__row' }, stepBtn(key, -5, `${labelText} : 5 minutes plus tôt`), input, stepBtn(key, 5, `${labelText} : 5 minutes plus tard`)));
      };
      const controls = h('div', { class: 'sl-ctls' }, timeCtl('bedMin', 'Coucher', 'moon', 'bedIn'), timeCtl('wakeMin', 'Réveil', 'sun', 'wakeIn'));

      // jour du réveil
      const days = [0, 1, 2].map((o) => h('button', { class: 'seg__btn', type: 'button', 'data-o': o, onclick: () => { ui.dayOffset = o; paintDays(); haptic(4); } }));
      dialEls.dayLabels = days;
      const daySeg = h('div', { class: 'seg sl-days', role: 'group', 'aria-label': 'Jour du réveil' }, days);
      function paintDays() {
        const now = ctx.nowMs();
        days.forEach((b, i) => {
          const d = addDays(startOfDay(now), -i);
          b.textContent = i === 0 ? `Ce matin · ${JOURS_FR[new Date(d).getDay()].slice(0, 3)}.` : i === 1 ? `Hier · ${JOURS_FR[new Date(d).getDay()].slice(0, 3)}.` : fmtDateFR(d, { short: true });
          b.setAttribute('aria-pressed', String(ui.dayOffset === i));
        });
      }

      // qualité
      const qBtns = [1, 2, 3, 4, 5].map((q) => h('button', { class: 'sl-q', type: 'button', 'aria-label': `${q} sur 5 : ${QUALITY[q]}`, 'aria-pressed': String(ui.quality === q),
        onclick: () => { ui.quality = q; paintQ(); haptic(5); } }, icon('moon', { size: 22 })));
      const qLabel = h('span', { class: 'sl-q__label' });
      function paintQ() { qBtns.forEach((b, i) => { b.dataset.on = i < ui.quality ? '1' : '0'; b.setAttribute('aria-pressed', String(i + 1 === ui.quality)); }); qLabel.textContent = QUALITY[ui.quality]; }
      const qRow = h('div', { class: 'sl-qrow' }, h('div', { class: 'sl-ctl__lbl' }, icon('heart', { size: 15 }), 'Comment as-tu dormi ?'), h('div', { class: 'sl-q__wrap' }, h('div', { class: 'sl-q__stars', role: 'group', 'aria-label': 'Qualité du sommeil' }, qBtns), qLabel));

      const saveBtn = h('button', { class: 'btn btn--primary btn--lg btn--block sl-save', type: 'button', onclick: () => saveNight() }, icon('check', { size: 20 }), 'Enregistrer ma nuit');
      dialEls.nightPane = h('div', { class: 'sl-pane' }, wrap, controls, daySeg, qRow, saveBtn);

      // --- sieste ---
      const napDurs = [10, 20, 30, 45, 90];
      const napChips = napDurs.map((m) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(ui.napDur === m), onclick: () => { ui.napDur = m; napChips.forEach((c, i) => c.setAttribute('aria-pressed', String(napDurs[i] === m))); paintNap(); } }, m >= 60 ? '1 h 30' : `${m} min`));
      const napTime = h('input', { class: 'input sl-time', type: 'time', 'aria-label': 'Début de la sieste', onchange: (e) => { if (/^\d\d:\d\d$/.test(e.target.value)) { ui.napStart = parseHHMM(e.target.value); paintNap(); } } });
      const napSummary = h('div', { class: 'sl-nap__sum' });
      function paintNap() {
        if (ui.napStart === null) ui.napStart = Math.floor((minutesOfDay(ctx.nowMs()) - ui.napDur) / 5) * 5;
        ui.napStart = (ui.napStart + 1440) % 1440; napTime.value = toHHMM(ui.napStart);
        napSummary.textContent = `${toHHMM(ui.napStart)} → ${toHHMM(ui.napStart + ui.napDur)} · ${ui.napDur >= 60 ? '1 h 30' : `${ui.napDur} min`}`;
      }
      const napSave = h('button', { class: 'btn btn--primary btn--lg btn--block sl-save', type: 'button', onclick: () => saveNap() }, icon('leaf', { size: 20 }), 'Enregistrer la sieste');
      dialEls.napPane = h('div', { class: 'sl-pane sl-pane--nap', hidden: true },
        h('div', { class: 'sl-nap__art', 'aria-hidden': 'true' }, icon('leaf', { size: 38, stroke: 1.4 })),
        h('div', { class: 'sl-ctl__lbl' }, icon('timer', { size: 15 }), 'Durée'), h('div', { class: 'row row--wrap sl-nap__chips' }, napChips),
        h('div', { class: 'sl-ctl__lbl' }, icon('clock', { size: 15 }), 'Elle a commencé à'), h('div', { class: 'sl-nap__row' }, napTime, napSummary),
        h('p', { class: 'hint' }, 'Une sieste de 20 min relève l\'alerte sans entrer en sommeil profond ; au-delà de 30 min, compte 15 min de brouillard au réveil.'),
        napSave);
      dialEls.paintNap = paintNap;

      const modeSeg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Type de sommeil' },
        h('button', { class: 'seg__btn', type: 'button', role: 'tab', 'aria-selected': 'true', onclick: (e) => setMode('night', e.currentTarget) }, icon('moon', { size: 14 }), ' Nuit'),
        h('button', { class: 'seg__btn', type: 'button', role: 'tab', 'aria-selected': 'false', onclick: (e) => setMode('nap', e.currentTarget) }, icon('leaf', { size: 14 }), ' Sieste'));
      function setMode(m, btn) {
        ui.mode = m;
        modeSeg.querySelectorAll('.seg__btn').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
        dialEls.nightPane.hidden = m !== 'night'; dialEls.napPane.hidden = m !== 'nap';
        if (m === 'nap') paintNap();
        haptic(5);
      }

      replaceChildren(logBox,
        header('bed', 'Ma nuit', 'Deux gestes : coucher, réveil', modeSeg), dialEls.nightPane, dialEls.napPane);
      // jour par défaut : ce matin si aucune nuit ne s'y termine déjà, sinon hier
      const now = ctx.nowMs();
      const hasToday = ctx.state.sleeps.some((s) => !s.nap && startOfDay(s.wakeMs) === startOfDay(now));
      const hasYest = ctx.state.sleeps.some((s) => !s.nap && startOfDay(s.wakeMs) === startOfDay(addDays(now, -1)));
      ui.dayOffset = hasToday ? (hasYest ? 0 : 1) : 0;
      // pré-remplissage : la dernière nuit notée donne l'horaire de départ
      const last = [...ctx.state.sleeps].reverse().find((s) => !s.nap);
      if (last) { ui.bedMin = minutesOfDay(last.bedMs); ui.wakeMin = minutesOfDay(last.wakeMs); }
      paintQ(); paintDays(); paint(false);
      dialEls.paint = paint;
    }

    async function saveNight() {
      const now = ctx.nowMs();
      const wakeDay = addDays(startOfDay(now), -ui.dayOffset);
      const wakeMs = atMinutes(wakeDay, ui.wakeMin);
      const dur = (ui.wakeMin - ui.bedMin + 1440) % 1440;
      if (dur < 60) { ctx.toast('Une nuit d\'au moins 1 h, s\'il te plaît : ajuste le coucher ou le réveil.', { kind: 'warn' }); return; }
      if (dur > 16 * 60) { ctx.toast('Plus de 16 h de sommeil ? Vérifie les heures.', { kind: 'warn' }); return; }
      if (wakeMs > now + 5 * MIN) { ctx.toast('Ce réveil est dans le futur : choisis « Hier » ou ajuste l\'heure.', { kind: 'warn' }); return; }
      const bedMs = wakeMs - dur * MIN;
      const clash = ctx.state.sleeps.filter((s) => !s.nap && s.bedMs < wakeMs && s.wakeMs > bedMs);
      if (clash.length) {
        const ok = await ctx.confirm(`Une nuit est déjà notée sur ce créneau (${hhmm(clash[0].bedMs)} → ${hhmm(clash[0].wakeMs)}). La remplacer ?`, { okLabel: 'Remplacer' });
        if (!ok) return;
        for (const c of clash) ctx.actions.removeSleep(c.id);
      }
      try {
        ctx.actions.logSleep({ bedMs, wakeMs, quality: ui.quality });
        haptic([10, 40, 10]);
        ctx.toast(`Nuit enregistrée · ${durLabel(dur)}`, { kind: 'ok', icon: 'moon' });
        const d = dialEls.nightPane.querySelector('.sl-dial');
        if (d && !reduce) d.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(1.5) drop-shadow(0 0 30px var(--night-glow))' }, { filter: 'brightness(1)' }], { duration: 900, easing: 'ease-out' });
        ui.dayOffset = 0;
      } catch (e) { ctx.toast(e.message || 'Impossible d\'enregistrer cette nuit.', { kind: 'err' }); }
    }

    function saveNap() {
      const now = ctx.nowMs();
      let startMs = atMinutes(now, ui.napStart);
      if (startMs > now) startMs = addDays(startMs, -1);
      const endMs = startMs + ui.napDur * MIN;
      if (endMs > now + 5 * MIN) { ctx.toast('Cette sieste finit dans le futur : décale son début.', { kind: 'warn' }); return; }
      try {
        ctx.actions.logSleep({ bedMs: startMs, wakeMs: endMs, nap: true, quality: ui.quality });
        haptic([10, 40, 10]);
        ctx.toast(`Sieste enregistrée · ${ui.napDur >= 60 ? '1 h 30' : `${ui.napDur} min`}`, { kind: 'ok', icon: 'leaf' });
      } catch (e) { ctx.toast(e.message || 'Impossible d\'enregistrer cette sieste.', { kind: 'err' }); }
    }

    // ===========================================================================
    // DETTE
    // ===========================================================================
    function renderDebt(I) {
      const s = I.sleep;
      const d = s.debtH ?? 0;
      const level = s.nights28 < 4 ? null : d < 1 ? ['Quasi nulle', 'ok'] : d < 3 ? ['Légère', 'night'] : d < 6 ? ['Modérée', 'sun'] : ['À rembourser', 'coral'];
      const num = h('div', { class: 'sl-debt__num', 'data-state': level ? level[1] : 'none' }, '0 h');
      const need = s.needH;
      const vals = s.series14.map((v) => v ?? 0);
      const colors = s.series14.map((v) => (v === null ? 'night' : v >= need - 0.25 ? 'night' : v >= need - 1.5 ? 'sun' : 'coral'));
      const labels = I.sleep.debtPerNight.map((p) => String(new Date(p.dayMs).getDate()));
      const cv = canvas('Sommeil des 14 dernières nuits comparé à ton besoin');
      const box = h('div', { class: 'chart sl-debt__chart' }, cv);
      replaceChildren(debtBox,
        header('battery', 'Dette de sommeil', 'Pondérée sur 14 jours : les nuits récentes pèsent plus', level ? h('span', { class: `chip chip--${level[1] === 'ok' ? 'night' : level[1]}` }, level[0]) : null),
        h('div', { class: 'sl-debt__top' }, num,
          h('p', { class: 'sl-debt__text' }, s.nights28 < 4
            ? 'Note quelques nuits pour que Kairos calcule ta dette : au moins 4 sur les 28 derniers jours.'
            : d < 1 ? `Tu dors en moyenne ${durLabel(Math.round((s.avgH28 ?? need) * 60))} pour un besoin de ${durLabel(need * 60)} : ton énergie est prévisible.`
              : `En moyenne ${durLabel(Math.round((s.avgH28 ?? need) * 60))} par nuit pour un besoin de ${durLabel(need * 60)}. Avec +30 min par nuit, compte ≈ ${Math.ceil((d * 60) / 30)} nuits pour la résorber — le sommeil ne se stocke pas vraiment, il se rattrape par petites touches.`)),
        box,
        h('div', { class: 'chart__legend' }, h('span', { class: 'legend-item legend-item--block', style: { '--c': 'var(--night)' } }, 'Besoin couvert'), h('span', { class: 'legend-item legend-item--block', style: { '--c': 'var(--sun)' } }, 'Un peu court'),
          h('span', { class: 'legend-item legend-item--block', style: { '--c': 'var(--coral)' } }, 'Nuit courte'), h('span', { class: 'legend-item legend-item--dash', style: { '--c': 'var(--coral)' } }, `Besoin ${fr1(need)} h`)));
      animateNumber(num, d, { duration: 1200, format: (v) => durLabel(v * 60) });
      const c = barChart(cv, { values: vals, labels, colors, target: need, targetLabel: `${fr1(need)} h`, format: (v) => fr1(v), height: 190, max: Math.max(10, Math.ceil(Math.max(...vals, need) + 0.5)) });
      chartKill.push(() => c.destroy());
    }

    // ===========================================================================
    // SIESTE + PRESSION DE SOMMEIL
    // ===========================================================================
    let napPlan = null;
    function renderNap() {
      const now = ctx.nowMs();
      let plan = null; let model = null;
      try { model = ctx.model(); plan = planNap({ model, nowMs: now }); } catch { /* modèle indisponible */ }
      napPlan = plan;
      if (plan) {
        const past = plan.endMs <= now;
        replaceChildren(napBox,
          header('leaf', 'Sieste conseillée', 'Dans ton creux, loin du coucher'),
          h('div', { class: 'sl-nap__big' }, h('b', { class: 'num' }, hhmm(plan.startMs)), h('span', null, '→'), h('b', { class: 'num' }, hhmm(plan.endMs)), h('em', null, plan.durMin >= 60 ? `${plan.durMin >= 90 ? '1 h 30' : durLabel(plan.durMin)}` : `${plan.durMin} min`)),
          h('div', { class: 'sl-nap__when' }, countdown(plan.startMs, now), ` · alerte prévue ≈ ${plan.alertAtStart}/100`),
          h('p', { class: 'sl-nap__why' }, plan.why),
          h('div', { class: 'row row--wrap' },
            h('button', { class: 'btn btn--secondary btn--sm', type: 'button', disabled: past, onclick: () => {
              ctx.actions.addEvent({ title: plan.durMin >= 90 ? 'Sieste (1 cycle)' : `Sieste de ${plan.durMin} min`, startMs: plan.startMs, endMs: plan.endMs, source: 'manual' });
              ctx.toast('Sieste ajoutée à ton agenda', { kind: 'ok', icon: 'calendar-check' });
            } }, icon('calendar', { size: 16 }), 'Ajouter à l\'agenda'),
            h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => ctx.navigate('#/lab') }, icon('flask', { size: 16 }), 'Simuler dans le labo')));
      } else {
        replaceChildren(napBox,
          header('leaf', 'Sieste conseillée', 'Dans ton creux, loin du coucher'),
          h('div', { class: 'sl-nap__none' }, h('span', { class: 'sl-nap__zz', 'aria-hidden': 'true' }, 'z', h('i', null, 'z'), h('i', null, 'z')),
            h('p', null, 'Pas de sieste utile pour l\'instant : soit ton énergie tient la route aujourd\'hui, soit le créneau est trop proche de ton coucher (une sieste après 16 h peut retarder ton endormissement).')));
      }
    }

    // --- pression de sommeil S ---
    function renderPressure() {
      let model = null;
      try { model = ctx.model(); } catch { /* indisponible */ }
      const holder = h('div', { class: 'sl-press__plot' });
      const read = h('div', { class: 'sl-press__read', 'aria-live': 'off' });
      replaceChildren(pressBox,
        header('activity', 'Pression de sommeil', 'Le besoin de dormir qui s\'accumule depuis ton réveil'),
        read, holder,
        h('div', { class: 'chart__legend' }, h('span', { class: 'legend-item', style: { '--c': 'var(--night)' } }, 'Pression S'), h('span', { class: 'legend-item legend-item--dash', style: { '--c': 'var(--sun)' } }, 'Horloge circadienne'),
          h('span', { class: 'legend-item legend-item--block', style: { '--c': 'var(--night)' } }, 'Sommeil')),
        h('p', { class: 'hint' }, 'S monte tant que tu es éveillé (constante ≈ 18 h) et se vide pendant la nuit (≈ 4 h) : modèle à deux processus de Borbély. La courbe dorée est ton horloge interne ; l\'écart entre les deux fait ta vigilance.'));
      if (!model) { holder.appendChild(h('div', { class: 'empty' }, h('p', { class: 'empty__text' }, 'Le modèle n\'est pas disponible pour le moment.'))); return; }
      const now = ctx.nowMs();
      const t0 = model.t0; const t1 = model.t0 + (model.n - 1) * model.stepMin * MIN;
      const at = (arr, ms) => { const x = clamp((ms - t0) / (model.stepMin * MIN), 0, model.n - 1); const i = Math.floor(x); return i >= model.n - 1 ? arr[model.n - 1] : arr[i] + (x - i) * (arr[i + 1] - arr[i]); };
      const nowS = at(model.S, now);
      const slope = (at(model.S, now + 30 * MIN) - at(model.S, now - 30 * MIN)) * 100;
      const asleepNow = model.asleep[clamp(Math.round((now - t0) / (model.stepMin * MIN)), 0, model.n - 1)];
      const setRead = (ms) => {
        const S = at(model.S, ms); const Cc = at(model.C, ms);
        read.replaceChildren(
          h('div', { class: 'sl-press__big' }, h('b', { class: 'num' }, `${Math.round(S * 100)}`), h('span', null, '%')),
          h('div', { class: 'sl-press__meta' }, h('b', null, ms === now ? `Maintenant · ${hhmm(ms)}` : hhmm(ms)),
            h('span', null, ms === now ? (asleepNow ? 'Tu dors : S se vide' : `S ${slope >= 0 ? 'monte' : 'baisse'} de ${fr1(Math.abs(slope))} pts/h`) : `Horloge ${Cc > 0.35 ? 'haute' : Cc < -0.35 ? 'basse' : 'moyenne'} (${Cc >= 0 ? '+' : '−'}${fr1(Math.abs(Cc))})`)));
      };
      setRead(now);

      const draw = () => {
        const W = Math.max(260, holder.clientWidth || 320); const H = 190; const L = 8; const Rr = 8; const T = 14; const B = 24;
        const x = (ms) => mapRange(ms, t0, t1, L, W - Rr); const y = (v) => mapRange(v, 0, 1, H - B, T);
        const pathOf = (arr, f) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(t0 + i * model.stepMin * MIN).toFixed(1)} ${y(f(v)).toFixed(1)}`).join(' ');
        const idG = uniqueId('pg');
        const sleepBands = []; let i = 0;
        while (i < model.n) { if (!model.asleep[i]) { i++; continue; } let j = i; while (j + 1 < model.n && model.asleep[j + 1]) j++; sleepBands.push([i, j]); i = j + 1; }
        const hoursTicks = [];
        for (let hh = 0; hh <= 24; hh += 3) { const ms = atMinutes(t0, hh * 60); hoursTicks.push(svg('text', { class: 'sl-axis', x: x(ms), y: H - 6, 'text-anchor': hh === 0 ? 'start' : hh === 24 ? 'end' : 'middle' }, String(hh).padStart(2, '0'))); }
        const gridLines = [0, 0.25, 0.5, 0.75, 1].map((v) => svg('line', { class: 'sl-grid', x1: L, x2: W - Rr, y1: y(v), y2: y(v) }));
        const area = `${pathOf(model.S, (v) => v)} L${x(t1)} ${y(0)} L${x(t0)} ${y(0)} Z`;
        const nowX = x(clamp(now, t0, t1));
        const cursor = svg('g', { class: 'sl-press__cursor', transform: `translate(${nowX} 0)` }, svg('line', { y1: T - 4, y2: H - B, class: 'sl-press__line' }),
          svg('circle', { class: 'sl-press__dot', cy: y(nowS), r: 5 }), svg('circle', { class: 'sl-press__pulse', cy: y(nowS), r: 5 }));
        const napBand = napPlan && napPlan.endMs > t0 && napPlan.startMs < t1 ? svg('g', null,
          svg('rect', { class: 'sl-press__nap', x: x(napPlan.startMs), width: Math.max(4, x(napPlan.endMs) - x(napPlan.startMs)), y: T, height: H - B - T, rx: 4 }),
          svg('text', { class: 'sl-axis sl-axis--nap', x: x(napPlan.startMs) + 2, y: T + 10 }, 'sieste')) : null;
        const el = svg('svg', { class: 'sl-press__svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Pression de sommeil sur 24 heures : ${Math.round(nowS * 100)} % maintenant, ${slope >= 0 ? 'en hausse' : 'en baisse'}.` },
          svg('defs', null, svg('linearGradient', { id: idG, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', style: 'stop-color: var(--night); stop-opacity: .42' }), svg('stop', { offset: '1', style: 'stop-color: var(--night); stop-opacity: 0' }))),
          ...gridLines,
          ...sleepBands.map(([a, b]) => svg('rect', { class: 'sl-press__sleep', x: x(t0 + a * model.stepMin * MIN), width: Math.max(1, x(t0 + (b + 1) * model.stepMin * MIN) - x(t0 + a * model.stepMin * MIN)), y: T, height: H - B - T })),
          svg('path', { d: area, fill: `url(#${idG})`, class: 'sl-press__area' }),
          svg('path', { d: pathOf(model.C, (v) => (v + 1) / 2), class: 'sl-press__c', fill: 'none' }),
          svg('path', { d: pathOf(model.S, (v) => v), class: 'sl-press__s', fill: 'none', pathLength: 1 }),
          napBand, ...hoursTicks, cursor,
          svg('rect', { x: L, y: 0, width: W - L - Rr, height: H - B, fill: 'transparent', class: 'sl-press__hit' }));
        const hit = el.querySelector('.sl-press__hit');
        const scrub = (e) => { const r = el.getBoundingClientRect(); const ms = clamp(t0 + ((e.clientX - r.left - L) / (W - L - Rr)) * (t1 - t0), t0, t1); const cx = x(ms);
          cursor.setAttribute('transform', `translate(${cx} 0)`); cursor.querySelector('.sl-press__dot').setAttribute('cy', y(at(model.S, ms))); cursor.querySelector('.sl-press__pulse').setAttribute('cy', y(at(model.S, ms))); setRead(ms); };
        const reset = () => { cursor.setAttribute('transform', `translate(${nowX} 0)`); cursor.querySelector('.sl-press__dot').setAttribute('cy', y(nowS)); cursor.querySelector('.sl-press__pulse').setAttribute('cy', y(nowS)); setRead(now); };
        hit.addEventListener('pointermove', scrub); hit.addEventListener('pointerdown', scrub); hit.addEventListener('pointerleave', reset);
        replaceChildren(holder, el);
        if (!reduce) { const p = el.querySelector('.sl-press__s'); p.style.strokeDasharray = '1'; p.style.strokeDashoffset = '1'; p.getBoundingClientRect(); p.style.transition = 'stroke-dashoffset 1.4s cubic-bezier(.2,.8,.2,1)'; requestAnimationFrame(() => { p.style.strokeDashoffset = '0'; }); }
      };
      draw();
      let lastW = holder.clientWidth;
      const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (Math.abs(holder.clientWidth - lastW) > 6) { lastW = holder.clientWidth; draw(); } }) : null;
      ro && ro.observe(holder);
      chartKill.push(() => ro && ro.disconnect());
    }

    // ===========================================================================
    // RÉGULARITÉ + CHRONOTYPE
    // ===========================================================================
    function renderRegularity(I) {
      const s = I.sleep;
      if (s.regularity === null) {
        replaceChildren(regBox, header('clock', 'Régularité', 'Écart-type de ton heure de coucher'),
          h('div', { class: 'empty sl-empty' }, h('p', { class: 'empty__text' }, 'Note au moins 2 nuits pour mesurer la régularité de ton coucher.')));
        return;
      }
      const verdict = s.regularity >= 75 ? 'Très régulier' : s.regularity >= 50 ? 'Plutôt régulier' : s.regularity >= 30 ? 'Variable' : 'Très variable';
      const jl = s.socialJetlagMin;
      // petite règle 02:00 → 08:00 avec le milieu de sommeil semaine / week-end
      const lo = 120; const hi = 480;
      const pos = (m) => clamp(((m - lo) / (hi - lo)) * 100, 2, 98);
      const ruler = (s.midWorkMin !== null && s.midFreeMin !== null) ? h('div', { class: 'sl-mid', role: 'img', 'aria-label': `Milieu de sommeil : ${toHHMM(s.midWorkMin)} en semaine, ${toHHMM(s.midFreeMin)} le week-end` },
        h('div', { class: 'sl-mid__bar' }, h('i', { class: 'sl-mid__span', style: { left: `${pos(Math.min(s.midWorkMin, s.midFreeMin))}%`, width: `${Math.abs(pos(s.midFreeMin) - pos(s.midWorkMin))}%` } }),
          h('b', { class: 'sl-mid__pin sl-mid__pin--w', style: { left: `${pos(s.midWorkMin)}%` } }), h('b', { class: 'sl-mid__pin sl-mid__pin--f', style: { left: `${pos(s.midFreeMin)}%` } })),
        h('div', { class: 'sl-mid__ticks' }, ...[2, 4, 6, 8].map((hh) => h('span', null, `${String(hh).padStart(2, '0')}h`))),
        h('div', { class: 'sl-mid__legend' }, h('span', null, h('i', { class: 'dot dot--sun' }), ` Semaine ${toHHMM(s.midWorkMin)}`), h('span', null, h('i', { class: 'dot dot--night' }), ` Week-end ${toHHMM(s.midFreeMin)}`))) : null;
      replaceChildren(regBox,
        header('clock', 'Régularité', 'Plus ton horloge est stable, plus ton énergie est prévisible'),
        h('div', { class: 'sl-reg__top' }, scoreRing({ value: s.regularity, label: '/ 100' }),
          h('div', { class: 'sl-reg__facts' },
            h('div', { class: 'sl-reg__verdict' }, verdict),
            h('dl', { class: 'sl-facts' },
              h('div', null, h('dt', null, 'Coucher moyen'), h('dd', { class: 'num' }, `${toHHMM(s.bedMeanMin)} ± ${s.bedSdMin} min`)),
              h('div', null, h('dt', null, 'Réveil moyen'), h('dd', { class: 'num' }, toHHMM(s.wakeMeanMin))),
              h('div', null, h('dt', null, 'Jet lag social'), h('dd', { class: 'num' }, jl === null ? '—' : durLabel(jl))),
              h('div', null, h('dt', null, 'Nuits < 6 h 30'), h('dd', { class: 'num' }, `${s.shortNights28} sur ${s.nights28}`))))),
        ruler);
    }

    function renderChrono(I) {
      const c = I.chronotype;
      const spectrum = h('div', { class: 'sl-spec', role: 'img', 'aria-label': c.msfscMin === null ? 'Chronotype inconnu' : `Chronotype ${c.label}, milieu de sommeil corrigé ${c.msfscLabel}` },
        h('div', { class: 'sl-spec__bar' }, c.msfscMin !== null ? h('div', { class: 'sl-spec__pin', style: { left: `${clamp(((c.msfscMin - 120) / (420 - 120)) * 100, 3, 97)}%` } }, h('i'), h('b', { class: 'num' }, c.msfscLabel)) : null),
        h('div', { class: 'sl-spec__ends' }, h('span', null, icon('sunrise', { size: 14 }), ' Alouette'), h('span', null, 'Intermédiaire'), h('span', null, 'Chouette ', icon('moon-star', { size: 14 }))));
      replaceChildren(chronoBox,
        header('moon-star', 'Ton chronotype', 'Méthode MSFsc de Roenneberg'),
        h('div', { class: 'sl-chrono__label' }, c.msfscMin === null ? 'À découvrir' : c.label.charAt(0).toUpperCase() + c.label.slice(1)),
        spectrum,
        h('p', { class: 'sl-chrono__text' }, c.explanation),
        c.msfscMin !== null ? h('div', { class: 'sl-conf' }, h('span', { class: 'label' }, 'Fiabilité de l\'estimation'),
          h('div', { class: 'progress progress--night', style: { '--pct': Math.round(c.confidence * 100) } }, h('div', { class: 'progress__bar' })), h('span', { class: 'num small' }, `${Math.round(c.confidence * 100)} %`)) : null,
        ctx.state.profile.chronoShiftMin ? h('p', { class: 'hint' }, `Ton modèle applique un décalage personnel de ${ctx.state.profile.chronoShiftMin > 0 ? '+' : '−'}${Math.abs(ctx.state.profile.chronoShiftMin)} min (voir Bilan).`) : null);
    }

    // ===========================================================================
    // CARTE DE CHALEUR + JOURNAL
    // ===========================================================================
    function renderHeat() {
      const g = sleepHeatmap(ctx.state, ctx.nowMs(), 8, ctx.state.prefs.weekStart === 0 ? 0 : 1);
      const cv = canvas(`Carte de chaleur du sommeil sur 8 semaines : ${g.logged} nuits notées, moyenne ${g.avgH === null ? 'inconnue' : fr1(g.avgH) + ' heures'}.`);
      replaceChildren(heatBox,
        header('calendar', '8 semaines de nuits', g.logged ? `${g.logged} nuits notées · moyenne ${fr1(g.avgH)} h` : 'Chaque case est une nuit'),
        g.logged ? h('div', { class: 'chart sl-heat__chart' }, cv) : h('div', { class: 'empty sl-empty' }, h('div', { class: 'empty__art' }, moonArt()), h('div', { class: 'empty__title' }, 'Ton ciel est encore vide'), h('p', { class: 'empty__text' }, 'Chaque nuit notée allume une étoile ici : une semaine par ligne, un jour par colonne.')),
        g.logged ? h('p', { class: 'hint' }, 'Plus la case est claire, plus la nuit était longue (échelle 5 → 9 h). Les week-ends se repèrent aux colonnes de droite.') : null);
      if (!g.logged) return;
      const c = heatmap(cv, {
        rows: g.weeks.map((w) => w.label), cols: g.cols, values: g.values, ramp: 'night', min: 5, max: 9, showValues: true, legend: true,
        format: (v) => fr1(v), tip: (r, col) => fmtDateFR(addDays(g.weeks[r].startMs, col)),
      });
      chartKill.push(() => c.destroy());
    }

    function moonArt() {
      return svg('svg', { viewBox: '0 0 112 112', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' },
        svg('g', { class: 'spin-slow' }, svg('circle', { cx: 56, cy: 56, r: 48, 'stroke-dasharray': '1 6', opacity: '.6' })),
        svg('path', { d: 'M74 62A22 22 0 0 1 48 36a22 22 0 1 0 26 26z', fill: 'currentColor', 'fill-opacity': '.12' }),
        svg('path', { d: 'M82 28v8M78 32h8M30 80v6M27 83h6', opacity: '.8' }));
    }

    function renderJournal() {
      const all = [...ctx.state.sleeps].sort((a, b) => b.wakeMs - a.wakeMs);
      const shown = ui.journalAll ? all.slice(0, 60) : all.slice(0, 7);
      const stars = (q) => h('span', { class: 'sl-jq', 'aria-label': `Qualité ${q} sur 5` }, ...[1, 2, 3, 4, 5].map((i) => h('i', { class: i <= q ? 'is-on' : '' })));
      const row = (s) => {
        const dur = (s.wakeMs - s.bedMs) / MIN;
        const del = h('button', { class: 'iconbtn sl-del', type: 'button', 'aria-label': `Supprimer ${s.nap ? 'la sieste' : 'la nuit'} du ${fmtDateFR(s.wakeMs)}`, onclick: () => {
          const copy = { bedMs: s.bedMs, wakeMs: s.wakeMs, quality: s.quality, nap: s.nap };
          ctx.actions.removeSleep(s.id);
          ctx.toast(s.nap ? 'Sieste supprimée' : 'Nuit supprimée', { kind: 'warn', undoLabel: 'Annuler', onUndo: () => { try { ctx.actions.logSleep(copy); } catch { /* ignoré */ } } });
        } }, icon('trash', { size: 16 }));
        return h('li', { class: 'sl-jrow', 'data-nap': s.nap ? '1' : null },
          h('span', { class: 'list__lead sl-jrow__ico' }, icon(s.nap ? 'leaf' : 'moon', { size: 18 })),
          h('div', { class: 'list__main' }, h('div', { class: 'list__title' }, fmtDateFR(s.wakeMs, { short: true }), s.nap ? h('span', { class: 'badge badge--night', style: { marginLeft: '8px' } }, 'sieste') : null),
            h('div', { class: 'list__meta' }, `${hhmm(s.bedMs)} → ${hhmm(s.wakeMs)}`, s.quality ? [' · ', stars(s.quality)] : null)),
          h('div', { class: 'list__trail' }, h('b', { class: 'num sl-jrow__dur', 'data-short': !s.nap && dur < 390 ? '1' : null }, durLabel(dur)), del));
      };
      replaceChildren(journalBox,
        header('book', 'Journal des nuits', all.length ? `${all.length} entrée${all.length > 1 ? 's' : ''}` : null),
        all.length ? h('ul', { class: 'sl-jlist' }, shown.map(row)) : h('div', { class: 'empty sl-empty' }, h('div', { class: 'empty__art' }, moonArt()), h('div', { class: 'empty__title' }, 'Raconte-moi ta première nuit'), h('p', { class: 'empty__text' }, 'Deux curseurs sur le cadran, une note, et ton journal s\'écrit tout seul. Kairos en tirera ta dette, ta régularité et ton chronotype.')),
        all.length > 7 ? h('button', { class: 'btn btn--ghost btn--sm sl-more', type: 'button', onclick: () => { ui.journalAll = !ui.journalAll; renderJournal(); } }, ui.journalAll ? 'Réduire' : `Voir les ${Math.min(60, all.length) - 7} autres`, icon(ui.journalAll ? 'chevron-up' : 'chevron-down', { size: 16 })) : null);
    }

    // ===========================================================================
    // Orchestration
    // ===========================================================================
    let first = true;
    function renderData() {
      killCharts();
      let I;
      try { I = computeInsights(ctx.state, ctx.nowMs()); } catch (e) { console.error(e); I = null; }
      renderHero();
      if (first) { buildLog(); first = false; }
      if (I) { renderDebt(I); renderRegularity(I); renderChrono(I); }
      renderNap(); renderPressure(); renderHeat(); renderJournal();
    }
    renderData();

    let lastDay = startOfDay(ctx.nowMs());
    const off = ctx.subscribe((_st, change) => {
      const t = change && change.type;
      if (t === 'tick') {
        tickCountdown();
        if (startOfDay(ctx.nowMs()) !== lastDay) { lastDay = startOfDay(ctx.nowMs()); renderData(); if (dialEls.dayLabels) dialEls.paint(false); }
        return;
      }
      renderData();
      if (dialEls.paint) dialEls.paint(false);
    });
    cleanups.push(off);

    return () => { killCharts(); for (const c of cleanups) { try { c(); } catch { /* ignoré */ } } };
  },
};
