// Vue « Aujourd'hui » : le cockpit.
// Héros (énergie du moment, tendance, phrase générée à partir du modèle), graphique d'alerte, puis des cartes :
// prochain bloc, fenêtres d'or, caféine, check-in, sommeil, sieste, tâches. Tout est dérivé de ctx.model() :
// la vue ne calcule aucune physiologie, elle la raconte. Elle se rafraîchit à chaque changement d'état et à
// chaque minute (ctx.subscribe) sans reconstruire le graphique ni rejouer les animations d'entrée.
import { h, svg, icon, animateNumber, confetti, haptic, prefersReducedMotion, uniqueId } from '../dom.js';
import { alertnessChart, ringGauge } from '../charts.js';
import { MIN, HOUR, DAY, startOfDay, addDays, fmtTime, fmtDuration, fmtDateFR, clamp } from '../../core/time.js';
import { valueAt } from '../../core/model.js';
import { planNap } from '../../core/sleep.js';
import { checkinToAlert } from '../../core/personalize.js';
import { CAFFEINE, caffeineRates, caffeineAmount } from '../../core/caffeine.js';

const CSS = 'css/views-today.css';
function ensureCss() {
  try {
    const href = new URL(CSS, document.baseURI).href;
    if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) return;
    const link = h('link', { rel: 'stylesheet', href: CSS }); link.onerror = () => link.remove(); document.head.appendChild(link);
  } catch { /* le style est aussi chargé par le shell */ }
}

const DRINKS = [{ kind: 'café', mg: 80, label: 'Café' }, { kind: 'thé', mg: 40, label: 'Thé' }, { kind: 'expresso', mg: 63, label: 'Expresso' }];
const FEELS = [{ v: 1, e: '😩', l: 'Épuisé·e' }, { v: 2, e: '🥱', l: 'Fatigué·e' }, { v: 3, e: '😐', l: 'Correct' }, { v: 4, e: '🙂', l: 'En forme' }, { v: 5, e: '🤩', l: 'Au top' }];
const LOAD_NAMES = ['', 'Routine', 'Léger', 'Moyen', 'Exigeant', 'Concentration profonde'];

/** Texte relatif : « maintenant », « dans 25 min », « dans 1 h 15 ». */
const inLabel = (deltaMs) => (deltaMs < 90_000 ? 'maintenant' : `dans ${fmtDuration(Math.round(deltaMs / MIN))}`);
const plural = (n, s, p = `${s}s`) => (n > 1 ? p : s);
const round = Math.round;

// ---------------------------------------------------------------------------
// Lecture du modèle (fonctions pures, sans DOM)
// ---------------------------------------------------------------------------
const slot = (m, ms) => clamp(Math.round((ms - m.t0) / (m.stepMin * MIN)), 0, m.n - 1);
const alertAt = (m, ms) => valueAt(m.alert, m, ms);

/** Libellé humain + ton visuel pour l'état à l'instant ms. */
export function moodAt(m, ms) {
  const v = alertAt(m, ms), i = slot(m, ms), hr = new Date(ms).getHours() + new Date(ms).getMinutes() / 60;
  const zone = (k) => (m.zones || []).find((z) => z.kind === k && ms >= z.startMs && ms < z.endMs);
  let lastWake = -Infinity; for (let k = i; k > 0; k--) if (m.asleep[k - 1] && !m.asleep[k]) { lastWake = m.t0 + k * m.stepMin * MIN; break; }
  if (m.asleep[i]) return { title: 'Repos en cours', tone: 'night', v };
  if (ms - lastWake < 75 * MIN && v < 66) return { title: 'Mise en route', tone: 'dawn', v };
  if (zone('winddown') || hr >= 21.5) return { title: 'La soirée ralentit', tone: 'night', v };
  if (zone('golden') && v >= 70) return { title: 'En pleine forme', tone: 'sun', v };
  if (zone('dip') || (hr >= 12.5 && hr < 17 && v < 62)) return { title: hr >= 12 && hr < 17.5 ? 'Creux de l\'après-midi' : 'Petit creux', tone: 'dip', v };
  if (v >= 80) return { title: 'En pleine forme', tone: 'sun', v };
  if (v >= 68) return { title: 'Bien en selle', tone: 'sun', v };
  if (v >= 55) return { title: 'Plutôt stable', tone: 'sun', v };
  if (v >= 42) return { title: 'Baisse de régime', tone: 'dip', v };
  return { title: 'Fatigue marquée', tone: 'coral', v };
}

/** Tendance sur ±15 min : { dir: 'up'|'down'|'flat', delta30 }. */
export function trendAt(m, ms) {
  const slope = alertAt(m, ms + 15 * MIN) - alertAt(m, ms - 15 * MIN);
  return { dir: slope > 3 ? 'up' : slope < -3 ? 'down' : 'flat', delta30: alertAt(m, ms + 30 * MIN) - alertAt(m, ms), slope };
}

const peakIn = (m, a, b) => { let best = { ms: a, v: -1 }; for (let t = a; t <= b; t += m.stepMin * MIN) { const v = alertAt(m, t); if (v > best.v) best = { ms: t, v }; } return best; };

// ---------------------------------------------------------------------------
// Petits éléments visuels
// ---------------------------------------------------------------------------
const chipTime = (txt) => h('span', { class: 'td-time num' }, txt);
const quote = (t) => h('em', { class: 'td-task' }, `« ${t} »`);

function loadDots(load) {
  return h('span', { class: 'td-load', role: 'img', 'aria-label': `Charge cognitive ${load} sur 5 : ${LOAD_NAMES[load] || ''}` },
    ...[1, 2, 3, 4, 5].map((i) => h('i', { class: i <= load ? 'is-on' : '', style: i <= load ? { '--c': `var(--load-${load})` } : null })));
}

function cupSvg(fill) {
  const id = uniqueId('cup');
  return svg('svg', { viewBox: '0 0 64 64', class: 'td-cup', 'aria-hidden': 'true', focusable: 'false' },
    svg('defs', null,
      svg('clipPath', { id }, svg('path', { d: 'M12 22h34v14a14 14 0 0 1-14 14h-6a14 14 0 0 1-14-14z' })),
      svg('linearGradient', { id: `${id}g`, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--sun-hot)' }), svg('stop', { offset: '.5', 'stop-color': 'var(--caffeine)' }), svg('stop', { offset: '1', 'stop-color': 'var(--sun-deep)' }))),
    svg('g', { 'clip-path': `url(#${id})` }, svg('rect', { class: 'td-cup__liq', x: 8, width: 46, height: 40, style: `transform: translateY(${50 - fill * 28}px)`, fill: `url(#${id}g)` }),
      svg('path', { class: 'td-cup__wave', d: 'M4 0q8-4 16 0t16 0 16 0 16 0v8H4z', style: `transform: translateY(${46 - fill * 28}px)`, fill: 'rgba(255,255,255,.28)' })),
    svg('path', { d: 'M12 22h34v14a14 14 0 0 1-14 14h-6a14 14 0 0 1-14-14z', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linejoin': 'round' }),
    svg('path', { d: 'M46 26h3a6 6 0 0 1 0 12h-4', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' }),
    svg('path', { class: 'td-cup__steam s1', d: 'M24 16c-3-3 3-5 0-9', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }),
    svg('path', { class: 'td-cup__steam s2', d: 'M34 16c-3-3 3-5 0-9', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }));
}

function moonRing(frac, label) {
  const R = 38, C = 2 * Math.PI * R, f = clamp(frac, 0, 1);
  return svg('svg', { viewBox: '0 0 100 100', class: 'td-moon', role: 'img', 'aria-label': label },
    svg('circle', { cx: 50, cy: 50, r: R, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': 9 }),
    svg('circle', { class: 'td-moon__arc', cx: 50, cy: 50, r: R, fill: 'none', stroke: 'var(--night)', 'stroke-width': 9, 'stroke-linecap': 'round', 'stroke-dasharray': `${C * f} ${C}`, transform: 'rotate(-90 50 50)' }),
    svg('path', { d: 'M58 36a15 15 0 1 0 6 22 12 12 0 0 1-6-22z', fill: 'var(--night)', opacity: '.9' }));
}

function welcomeArt() {
  const dots = []; for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; dots.push(svg('circle', { cx: 60 + Math.cos(a) * 52, cy: 60 + Math.sin(a) * 52, r: i % 6 === 0 ? 2.6 : 1.4, fill: 'currentColor', opacity: i % 6 === 0 ? 0.9 : 0.4 })); }
  return svg('svg', { viewBox: '0 0 120 120', class: 'td-welcome__art', 'aria-hidden': 'true', focusable: 'false' },
    svg('g', { class: 'td-spin' }, ...dots),
    svg('circle', { cx: 60, cy: 60, r: 33, fill: 'none', stroke: 'var(--sun)', 'stroke-width': 2, 'stroke-dasharray': '2 6', 'stroke-linecap': 'round', opacity: '.7' }),
    svg('circle', { class: 'td-welcome__sun', cx: 60, cy: 60, r: 16, fill: 'var(--sun)' }),
    svg('circle', { cx: 60, cy: 60, r: 22, fill: 'none', stroke: 'var(--sun-hot)', 'stroke-width': 1, opacity: '.6' }));
}

// ===========================================================================
export default {
  id: 'today',
  title: 'Aujourd\'hui',
  icon: 'sun',
  mount(root, ctx) {
    ensureCss();
    const reduced = prefersReducedMotion();
    const rates = () => caffeineRates(ctx.state.profile && ctx.state.profile.caffeineHalfLifeH);
    let dayOffset = 0;
    let disposed = false, rafId = 0, scrubTimer = 0, freshFeel = null;
    let ring = null, chart = null;
    const offs = [];

    const now = () => ctx.nowMs();
    const dayStart = () => addDays(startOfDay(now()), dayOffset);
    const isToday = () => dayOffset === 0;
    const model = () => ctx.model({ fromMs: dayStart() });
    /** Instant de référence pour les calculs « maintenant » : l'heure réelle aujourd'hui, un repère de journée ailleurs. */
    const refMs = () => (isToday() ? now() : dayStart() + 8 * HOUR);

    // ------------------------------------------------ données dérivées
    const blocksOfDay = () => {
      const st = ctx.state, a = dayStart(), b = a + DAY, byId = new Map(st.tasks.map((t) => [t.id, t]));
      return ((st.plan && st.plan.blocks) || []).filter((bl) => bl.endMs > a && bl.startMs < b && byId.has(bl.taskId) && !byId.get(bl.taskId).done).sort((x, y) => x.startMs - y.startMs);
    };
    const eventsOfDay = () => { const a = dayStart(), b = a + DAY; return ctx.state.events.filter((e) => !e.allDay && e.endMs > a && e.startMs < b); };
    const taskById = (id) => ctx.state.tasks.find((t) => t.id === id);
    /** Tâche à mettre en avant : celle du bloc en cours/suivant, sinon la plus exigeante à faire. */
    function featuredTask() {
      const n = refMs(), bl = blocksOfDay().find((b) => b.endMs > n);
      if (bl) return taskById(bl.taskId);
      const open = ctx.state.tasks.filter((t) => !t.done).sort((a, b) => a.priority - b.priority || b.load - a.load);
      return open[0] || null;
    }

    // ------------------------------------------------ squelette
    // Barre de jour
    const dayLabel = h('span', { class: 'td-day__label' });
    const dayEyebrow = h('span', { class: 'eyebrow' });
    const backBtn = h('button', { class: 'chip chip--sun td-day__back', type: 'button', onclick: () => setDay(0) }, icon('refresh', { size: 14 }), 'Aujourd\'hui');
    const prevBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Jour précédent', onclick: () => setDay(dayOffset - 1) }, icon('chevron-left'));
    const nextBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Jour suivant', onclick: () => setDay(dayOffset + 1) }, icon('chevron-right'));
    const dayBar = h('div', { class: 'td-day' }, prevBtn, h('div', { class: 'td-day__mid', 'aria-live': 'polite' }, dayEyebrow, dayLabel), nextBtn, backBtn);

    // Héros
    const ringCanvas = h('canvas', { role: 'img', 'aria-label': 'Énergie' });
    const heroEyebrow = h('span', { class: 'td-hero__eyebrow' });
    const heroTitle = h('h2', { class: 'td-hero__title' });
    const heroTrend = h('span', { class: 'td-trend' });
    const heroPhrase = h('p', { class: 'td-hero__phrase' });
    const heroStats = h('div', { class: 'td-hero__stats' });
    const ribbon = h('div', { class: 'td-ribbon', role: 'img', 'aria-label': 'Ruban d\'énergie de la journée' });
    const hero = h('section', { class: 'card card--hero td-hero', 'data-tone': 'sun', 'aria-labelledby': 'td-hero-title' },
      h('div', { class: 'td-hero__halo', 'aria-hidden': 'true' }),
      h('div', { class: 'td-hero__grid' },
        h('div', { class: 'td-ringbox' }, h('div', { class: 'td-ring' }, ringCanvas)),
        h('div', { class: 'td-hero__copy' }, heroEyebrow, heroTitle, heroTrend, heroPhrase)),
      heroStats, ribbon);
    heroTitle.id = 'td-hero-title';

    // Graphique
    const canvas = h('canvas', { tabindex: '0' });
    const scrubEl = h('span', { class: 'td-chart__read num', 'aria-hidden': 'true' });
    const chartSub = h('p', { class: 'card__sub' });
    const chartCard = h('section', { class: 'card td-chart', 'aria-label': 'Courbe d\'énergie de la journée' },
      h('div', { class: 'card__head' }, h('div', null, h('h3', { class: 'card__title' }, 'Ton énergie, heure par heure'), chartSub), scrubEl),
      h('div', { class: 'chart' }, canvas),
      h('div', { class: 'chart__legend' },
        h('span', { class: 'legend-item', style: { '--c': 'var(--sun)' } }, 'Alerte prédite'),
        h('span', { class: 'legend-item legend-item--block', style: { '--c': 'var(--sun-hot)' } }, 'Fenêtre d\'or'),
        h('span', { class: 'legend-item legend-item--dash', style: { '--c': 'var(--caffeine)' } }, 'Caféine'),
        h('span', { class: 'legend-item legend-item--block', style: { '--c': 'var(--night)' } }, 'Sommeil'),
        h('span', { class: 'legend-item legend-item--block', style: { '--c': 'var(--load-3)' } }, 'Tâches')));

    // Bienvenue (état vide)
    const welcome = h('section', { class: 'card card--glow td-welcome', hidden: true, 'aria-label': 'Bienvenue' });

    // Cartes
    const mkCard = (cls, label, i) => h('section', { class: `card td-card td-card--${cls}`, style: { '--i': String(i) }, 'aria-label': label });
    const cNext = mkCard('next', 'Prochain bloc', 0), cGold = mkCard('gold', 'Fenêtres d\'or', 1), cCaf = mkCard('caf', 'Caféine', 2), cFeel = mkCard('feel', 'Comment te sens-tu ?', 3),
      cSleep = mkCard('sleep', 'Sommeil de cette nuit', 4), cNap = mkCard('nap', 'Sieste conseillée', 5), cTasks = mkCard('tasks', 'Tâches du jour', 6);
    const grid = h('div', { class: 'td-grid' }, cNext, cGold, cCaf, cFeel, cSleep, cNap, cTasks);
    root.append(dayBar, hero, chartCard, welcome, grid);

    // Éléments persistants (les nombres s'animent d'une valeur à l'autre)
    const cafNum = h('b', { class: 'td-caf__num num', 'data-value': '0' }, '0');

    // ------------------------------------------------ HÉROS
    function renderHero(m) {
      const n = refMs(), today = isToday();
      const tone = today ? moodAt(m, n) : { title: 'Journée à venir', tone: 'sun', v: m.stats.peak.value };
      const value = today ? tone.v : m.stats.peak.value;
      hero.dataset.tone = tone.tone;
      heroEyebrow.replaceChildren(h('span', { class: 'dot dot--sun dot--pulse' }), today ? `Maintenant · ${fmtTime(n)}` : `${dayOffset > 0 ? 'Demain' : 'Ce jour-là'} · pic prévu ${fmtTime(m.stats.peak.ms)}`);
      heroTitle.textContent = today ? tone.title : (dayOffset > 0 ? 'Ce qui t\'attend' : 'Ce que le modèle prévoyait');
      const col = tone.tone === 'night' || tone.tone === 'dip' ? 'night' : tone.tone === 'coral' ? 'coral' : 'sun';
      const rv = clamp(Math.round(value), 0, 100);
      if (!ring) ring = ringGauge(ringCanvas, { value: rv, max: 100, label: today ? 'énergie' : 'pic prévu', color: col, breathe: true });
      else ring.update({ value: rv, label: today ? 'énergie' : 'pic prévu', color: col });

      if (today) {
        const tr = trendAt(m, n), up = tr.dir === 'up', down = tr.dir === 'down';
        heroTrend.className = `td-trend td-trend--${tr.dir}`;
        heroTrend.replaceChildren(icon(up ? 'arrow-up' : down ? 'arrow-down' : 'arrow-right', { size: 16, stroke: 2.2 }),
          h('span', null, up ? 'Ça monte' : down ? 'Ça descend' : 'Stable'), h('span', { class: 'td-trend__d num' }, `${tr.delta30 >= 0 ? '+' : '−'}${Math.abs(round(tr.delta30))} dans 30 min`));
        heroTrend.hidden = false;
      } else heroTrend.hidden = true;
      heroPhrase.replaceChildren(...phrase(m));

      // stats
      const st = m.stats, mk = (label, big, sub, cls) => h('div', { class: `stat td-stat ${cls || ''}` }, h('span', { class: 'stat__label' }, label), h('span', { class: 'stat__value num' }, big), h('span', { class: 'td-stat__sub num' }, sub));
      const gw = st.goldenWindows.filter((g) => g.endMs > n && g.startMs < dayStart() + DAY)[0];
      heroStats.replaceChildren(
        mk('Pic', String(round(st.peak.value)), fmtTime(st.peak.ms), 'td-stat--sun'),
        mk('Creux', String(round(st.trough.value)), fmtTime(st.trough.ms), 'td-stat--dip'),
        mk('Prime time', gw ? fmtTime(gw.startMs) : '—', gw ? (gw.startMs <= n && isToday() ? 'en cours' : isToday() ? inLabel(gw.startMs - n) : `${round(gw.mean)}/100`) : 'rien à venir', 'td-stat--gold'));

      // ruban 24 h
      const d0 = dayStart(), stops = [];
      for (let k = 0; k <= 48; k++) {
        const t = d0 + k * 30 * MIN, i = slot(m, t), v = alertAt(m, t), p = (k / 48) * 100;
        stops.push(m.asleep[i] ? `color-mix(in srgb, var(--night) 46%, transparent) ${p.toFixed(1)}%` : `color-mix(in oklab, var(--sun-hot) ${clamp(round(v * 1.05 - 8), 0, 100)}%, var(--dip)) ${p.toFixed(1)}%`);
      }
      ribbon.style.setProperty('--bar', `linear-gradient(90deg, ${stops.join(', ')})`);
      ribbon.replaceChildren(h('span', { class: 'td-ribbon__bar' }),
        ...(today ? [h('span', { class: 'td-ribbon__now', style: { left: `${clamp(((n - d0) / DAY) * 100, 0, 100)}%` } })] : []),
        h('span', { class: 'td-ribbon__ticks', 'aria-hidden': 'true' }, ...['00', '06', '12', '18', '24'].map((x) => h('span', null, x))));
      ribbon.setAttribute('aria-label', `Ruban d'énergie de la journée : pic ${round(st.peak.value)} à ${fmtTime(st.peak.ms)}, creux ${round(st.trough.value)} à ${fmtTime(st.trough.ms)}`);
    }

    /** La phrase du moment, tirée du modèle. */
    function phrase(m) {
      const n = refMs(), task = featuredTask(), T = (extra) => (task ? [' — garde-le pour ', quote(task.title), extra || '.'] : [extra || '.']);
      const gws = m.stats.goldenWindows;
      if (!isToday()) {
        const list = gws.filter((g) => g.endMs > dayStart() && g.startMs < dayStart() + DAY);
        if (!list.length) return ['Pas de fenêtre d\'or marquée ce jour-là : un rythme plutôt régulier.'];
        const out = [dayOffset > 0 ? 'Tes meilleures heures demain : ' : 'Tes meilleures heures : '];
        list.forEach((g, k) => { out.push(chipTime(`${fmtTime(g.startMs)}–${fmtTime(g.endMs)}`)); if (k < list.length - 1) out.push(' puis '); });
        out.push(task ? ' — de quoi y caser ' : '.'); if (task) out.push(quote(task.title), '.');
        return out;
      }
      const i = slot(m, n);
      if (m.asleep[i]) { let k = i; while (k < m.n - 1 && m.asleep[k]) k++; return ['Tu es censé·e dormir. Ton réveil est prévu à ', chipTime(fmtTime(m.t0 + k * m.stepMin * MIN)), ', repos bien mérité.']; }
      const inGold = gws.find((g) => n >= g.startMs && n < g.endMs);
      if (inGold) return ['Tu es dans ta fenêtre d\'or jusqu\'à ', chipTime(fmtTime(inGold.endMs)), ' : profites-en', ...(task ? [' pour '] : []), ...(task ? [quote(task.title)] : []), '.'];
      const nextG = gws.find((g) => g.startMs > n && g.startMs < dayStart() + DAY);
      const dip = (m.zones || []).find((z) => z.kind === 'dip' && n >= z.startMs && n < z.endMs);
      const lead = dip ? ['Petit creux jusqu\'à ', chipTime(fmtTime(dip.endMs)), ' : mails, rangement ou sieste de 20 min. '] : [];
      if (nextG) { const pk = peakIn(m, nextG.startMs, nextG.endMs); return [...lead, 'Ton prochain pic est à ', chipTime(fmtTime(pk.ms)), ` (${inLabel(pk.ms - n)})`, ...T()]; }
      const hr = new Date(n).getHours();
      if (hr >= 20 || hr < 5) { const bed = m.stats.nextBedMs; return [...lead, 'La journée se calme.', ...(bed ? [' Coucher conseillé vers ', chipTime(fmtTime(bed)), '.'] : [])]; }
      return [...lead, 'Plus de fenêtre d\'or aujourd\'hui : garde le léger pour la fin de journée, mails, appels, rangement.'];
    }

    // ------------------------------------------------ GRAPHIQUE
    function renderChart(m) {
      const d0 = dayStart(), range = [d0, d0 + DAY];
      const opts = { model: m, nowMs: isToday() ? now() : null, range, blocks: blocksOfDay(), events: eventsOfDay(), tasks: ctx.state.tasks };
      if (!chart) chart = alertnessChart(canvas, { showCaffeine: true, showSleep: true, showZones: true, ...opts, onScrub, onScrubEnd });
      else chart.update(opts);
      chartSub.textContent = `${fmtDateFR(d0)} · glisse le doigt ou la souris pour lire l'heure et l'alerte`;
    }
    function onScrub(ms) {
      clearTimeout(scrubTimer); const m = model(), a = alertAt(m, ms), mg = valueAt(m.caffeineMg, m, ms);
      scrubEl.textContent = `${fmtTime(ms)} · alerte ${round(a)}${mg >= 1 ? ` · ${round(mg)} mg` : ''}`;
    }
    function onScrubEnd() { clearTimeout(scrubTimer); scrubTimer = setTimeout(() => { scrubEl.textContent = ''; }, 2600); }

    // ------------------------------------------------ CARTES
    const head = (iconName, title, sub, right) => h('div', { class: 'card__head td-head' },
      h('span', { class: 'td-head__ico' }, icon(iconName, { size: 18 })), h('div', { class: 'grow' }, h('h3', { class: 'card__title' }, title), sub ? h('p', { class: 'card__sub' }, sub) : null), right || null);

    function renderNext() {
      const blocks = blocksOfDay(), n = refMs(), st = ctx.state;
      const cur = blocks.find((b) => b.startMs <= n && b.endMs > n && isToday()), bl = cur || blocks.find((b) => b.startMs > n || !isToday());
      const task = bl && taskById(bl.taskId);
      cNext.classList.toggle('card--sun', !!bl);
      if (bl && task) {
        const mins = round((bl.endMs - bl.startMs) / MIN), left = cur ? round((bl.endMs - n) / MIN) : null;
        cNext.replaceChildren(
          head('target', cur ? 'En ce moment' : 'Prochain bloc', cur ? `Encore ${fmtDuration(left)}` : isToday() ? inLabel(bl.startMs - n) : fmtDateFR(bl.startMs, { short: true }), cur ? h('span', { class: 'badge badge--sun' }, h('span', { class: 'dot dot--pulse', style: { background: 'var(--sun-ink)' } }), 'en cours') : null),
          h('h4', { class: 'td-next__title' }, task.title),
          h('div', { class: 'td-next__meta' }, chipTime(`${fmtTime(bl.startMs)}–${fmtTime(bl.endMs)}`), h('span', { class: 'muted small' }, fmtDuration(mins)), loadDots(task.load), h('span', { class: 'small muted' }, LOAD_NAMES[task.load])),
          bl.reason ? h('p', { class: 'td-next__why' }, h('span', { class: 'td-next__bulb', 'aria-hidden': 'true' }, icon('sparkle', { size: 15 })), bl.reason) : null,
          h('div', { class: 'row row--wrap td-next__actions' },
            h('button', { class: 'btn btn--primary', type: 'button', onclick: () => { haptic(10); ctx.startFocus({ taskId: task.id, minutes: clamp(cur ? left : mins, 5, 120) }); } }, icon('play', { size: 18 }), 'Démarrer le focus'),
            h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => ctx.navigate('#/plan') }, 'Voir le plan', icon('arrow-right', { size: 16 }))));
        return;
      }
      const open = st.tasks.filter((t) => !t.done);
      cNext.replaceChildren(head('target', 'Prochain bloc', 'Rien de planifié pour le moment'),
        h('div', { class: 'td-softempty' },
          h('p', { class: 'muted' }, open.length ? `Tu as ${open.length} ${plural(open.length, 'tâche')} à caser. Je les range là où ton cerveau est le meilleur.` : 'Dis-moi ce que tu as à faire : je trouverai pour chaque tâche l\'heure où tu seras le plus affûté·e.'),
          h('div', { class: 'row row--wrap' }, open.length
            ? h('button', { class: 'btn btn--primary', type: 'button', onclick: planDay }, icon('wand', { size: 18 }), 'Planifier ma journée')
            : h('button', { class: 'btn btn--primary', type: 'button', onclick: () => ctx.openQuickAdd() }, icon('plus', { size: 18 }), 'Ajouter une tâche'))));
    }
    function planDay() {
      try { const res = ctx.runPlanner(); ctx.applyPlan(res); const k = res.blocks.length; ctx.toast(k ? `${k} ${plural(k, 'bloc')} placé${k > 1 ? 's' : ''} aux meilleures heures` : 'Rien à placer pour l\'instant', { kind: k ? 'ok' : 'warn', undoLabel: k ? 'Annuler' : undefined, onUndo: () => ctx.store.undo() }); haptic(12); } catch (e) { console.error(e); ctx.toast('Impossible de planifier pour l\'instant', { kind: 'err' }); }
    }

    function renderGold(m) {
      const d0 = dayStart(), n = refMs(), list = m.stats.goldenWindows.filter((g) => g.endMs > d0 && g.startMs < d0 + DAY);
      const strip = h('div', { class: 'td-gold__strip', 'aria-hidden': 'true' },
        ...list.map((g) => h('span', { class: `td-gold__seg${isToday() && n >= g.startMs && n < g.endMs ? ' is-live' : ''}`, style: { left: `${((g.startMs - d0) / DAY) * 100}%`, width: `${((g.endMs - g.startMs) / DAY) * 100}%` } })),
        isToday() ? h('span', { class: 'td-gold__now', style: { left: `${clamp(((n - d0) / DAY) * 100, 0, 100)}%` } }) : null,
        h('span', { class: 'td-gold__ticks' }, ...['0', '6', '12', '18', '24'].map((x) => h('span', null, x))));
      cGold.replaceChildren(head('sparkle', 'Fenêtres d\'or', list.length ? 'Tes meilleures heures pour le travail exigeant' : 'Pas de pic net aujourd\'hui'), strip,
        list.length ? h('ul', { class: 'td-gold__list' }, ...list.map((g) => {
          const live = isToday() && n >= g.startMs && n < g.endMs, past = isToday() && g.endMs <= n;
          return h('li', { class: `td-gold__row${live ? ' is-live' : ''}${past ? ' is-past' : ''}` },
            h('span', { class: 'td-gold__time num' }, `${fmtTime(g.startMs)}–${fmtTime(g.endMs)}`),
            h('span', { class: 'td-gold__dur muted small' }, fmtDuration(round((g.endMs - g.startMs) / MIN))),
            h('span', { class: 'td-gold__when' }, live ? h('span', { class: 'badge badge--sun' }, 'en cours') : past ? h('span', { class: 'faint tiny' }, 'passée') : isToday() ? h('span', { class: 'small t-sun' }, inLabel(g.startMs - n)) : null),
            h('span', { class: 'td-gold__score num' }, round(g.mean)));
        })) : h('p', { class: 'muted small' }, 'Ton énergie reste assez plate : tu peux placer le travail exigeant à peu près n\'importe où sur les heures éveillées.'));
    }

    function renderCaf(m) {
      const st = ctx.state, n = refMs(), d0 = dayStart(), today = isToday();
      const active = today ? valueAt(m.caffeineMg, m, n) : 0, cutoff = m.stats.cutoffMs, bed = m.stats.nextBedMs;
      animateNumber(cafNum, active, { duration: reduced ? 0 : 700, format: (v) => String(round(v)) });
      const todays = st.caffeine.filter((c) => c.tMs >= d0 && c.tMs < d0 + DAY);
      const total = todays.reduce((a, c) => a + c.mg, 0);
      const past = cutoff != null && today && n > cutoff;
      const projected = today && bed ? m.stats.caffeineAtBedMg + caffeineAmount(80, (bed - n) / HOUR, rates()) : null;
      const quick = (d) => h('button', { class: 'chip td-drink', type: 'button', disabled: !today, onclick: () => addDrink(d) }, icon(d.kind === 'thé' ? 'leaf' : 'coffee', { size: 16 }), h('span', null, d.label), h('small', { class: 'num' }, `${d.mg} mg`));
      cCaf.replaceChildren(
        head('coffee', 'Caféine', today ? 'Active dans ton sang maintenant' : 'Disponible pour aujourd\'hui'),
        h('div', { class: 'td-caf__top' }, cupSvg(clamp(active / 160, 0, 1)), h('div', { class: 'td-caf__big' }, cafNum, h('span', { class: 'td-caf__unit' }, 'mg')),
          h('div', { class: 'td-caf__cut' }, h('span', { class: 'eyebrow' }, 'Dernier café conseillé'), h('b', { class: `num ${past ? 't-coral' : 't-ok'}` }, cutoff != null ? `avant ${fmtTime(cutoff)}` : '—'))),
        projected != null ? h('p', { class: `td-caf__proj${projected > CAFFEINE.bedThresholdMg ? ' is-warn' : ''}` }, icon(projected > CAFFEINE.bedThresholdMg ? 'alert' : 'check-circle', { size: 15 }), projected > CAFFEINE.bedThresholdMg ? `Un café maintenant laisserait ≈ ${round(projected)} mg au coucher (repère : ${CAFFEINE.bedThresholdMg} mg).` : `Un café maintenant : ≈ ${round(projected)} mg au coucher, c'est raisonnable.`) : null,
        h('div', { class: 'td-drinks', role: 'group', 'aria-label': 'Ajouter une boisson' }, ...DRINKS.map(quick)),
        todays.length ? h('ul', { class: 'td-caf__log', 'aria-label': 'Boissons du jour' }, ...todays.map((c) => h('li', null, chipTime(fmtTime(c.tMs)), h('span', { class: 'small' }, `${c.kind || 'café'} · ${c.mg} mg`), h('button', { class: 'td-x', type: 'button', 'aria-label': `Retirer la boisson de ${fmtTime(c.tMs)}`, onclick: () => removeDrink(c) }, icon('x', { size: 14 }))))) : null,
        total ? h('div', { class: 'td-caf__day' }, h('div', { class: 'progress', style: { '--pct': String(clamp((total / CAFFEINE.maxDailyMg) * 100, 0, 100)) } }, h('div', { class: 'progress__bar' })), h('span', { class: 'tiny faint num' }, `${total} / ${CAFFEINE.maxDailyMg} mg aujourd'hui`)) : null);
    }
    function addDrink(d) {
      const c = ctx.actions.logCaffeine({ tMs: now(), mg: d.mg, kind: d.kind }); haptic(10);
      ctx.toast(`${d.label} noté (${d.mg} mg)`, { kind: 'ok', icon: 'coffee', undoLabel: 'Annuler', onUndo: () => c && ctx.actions.removeCaffeine(c.id) });
    }
    function removeDrink(c) { ctx.actions.removeCaffeine(c.id); haptic(6); ctx.toast('Boisson retirée', { kind: 'ok', undoLabel: 'Rétablir', onUndo: () => ctx.actions.logCaffeine({ tMs: c.tMs, mg: c.mg, kind: c.kind }) }); }

    function renderFeel(m) {
      const st = ctx.state, n = now(), d0 = startOfDay(n), todays = st.checkins.filter((c) => c.tMs >= d0 && c.tMs <= n + HOUR), last = todays[todays.length - 1];
      const recent = last && n - last.tMs < 3 * HOUR ? last : null;
      let res = null;
      if (recent && isToday()) {
        const mm = ctx.model({ fromMs: d0 }), predicted = round(valueAt(mm.alert, mm, recent.tMs)), felt = round(checkinToAlert(recent.alertness)), diff = felt - predicted;
        res = { predicted, felt, diff, at: recent.tMs };
      }
      cFeel.replaceChildren(
        head('heart', 'Comment te sens-tu ?', recent ? `Noté à ${fmtTime(recent.tMs)} · merci !` : 'Un tap : le modèle apprend de toi'),
        h('div', { class: 'td-feels', role: 'group', 'aria-label': 'Ton niveau d\'énergie ressenti, de 1 à 5' },
          ...FEELS.map((f) => h('button', { class: `td-feel${recent && recent.alertness === f.v ? ' is-on' : ''}${freshFeel === f.v ? ' is-fresh' : ''}`, type: 'button', 'aria-pressed': String(!!recent && recent.alertness === f.v), 'aria-label': `${f.v} sur 5 : ${f.l}`, disabled: !isToday(), onclick: () => logFeel(f.v) },
            h('span', { class: 'td-feel__e', 'aria-hidden': 'true' }, f.e), h('span', { class: 'td-feel__l' }, f.l)))),
        res ? h('div', { class: 'td-calib' },
          h('div', { class: 'td-calib__track', 'aria-hidden': 'true' },
            h('span', { class: 'td-calib__link', style: { left: `${Math.min(res.predicted, res.felt)}%`, width: `${Math.abs(res.diff)}%` } }),
            h('span', { class: 'td-calib__pin td-calib__pin--p', style: { left: `${res.predicted}%` } }),
            h('span', { class: 'td-calib__pin td-calib__pin--f', style: { left: `${res.felt}%` } })),
          h('div', { class: 'td-calib__txt' }, h('span', null, h('i', { class: 'td-calib__k td-calib__k--p' }), 'Prédit ', h('b', { class: 'num' }, String(res.predicted))), h('span', null, h('i', { class: 'td-calib__k td-calib__k--f' }), 'Ressenti ', h('b', { class: 'num' }, String(res.felt)))),
          h('p', { class: 'small muted' }, Math.abs(res.diff) < 6 ? 'Le modèle tombe juste. Beau travail, vous deux.' : res.diff > 0 ? `Tu te sens mieux que prévu (+${res.diff}) : le modèle en tient compte.` : `Tu te sens moins bien que prévu (${res.diff}) : on affine.`)) : (isToday() ? h('p', { class: 'td-feel__hint tiny faint' }, 'Après ta réponse, tu verras ce que le modèle avait prédit.') : h('p', { class: 'td-feel__hint tiny faint' }, 'Le check-in se fait au jour même.')));
    }
    function logFeel(v) {
      freshFeel = v; const c = ctx.actions.logCheckIn({ tMs: now(), alertness: v }); haptic([8, 30, 8]);
      ctx.toast('Merci, check-in enregistré', { kind: 'ok', undoLabel: 'Annuler', onUndo: () => c && ctx.actions.removeCheckIn(c.id) });
      setTimeout(() => { freshFeel = null; }, 700);
    }

    function renderSleep(m) {
      const st = ctx.state, d0 = dayStart(), n = refMs(), needH = st.profile.sleepNeedH || 8;
      const mains = m.episodes.filter((e) => !e.nap && (e.endMs - e.startMs) >= 3 * HOUR);
      const ep = mains.filter((e) => e.endMs > d0 && e.endMs <= (isToday() ? Math.max(n, d0 + 1) : d0 + DAY)).pop() || mains.filter((e) => e.endMs <= d0 + DAY).pop();
      const debt = m.stats.sleepDebtH;
      if (!ep) { cSleep.replaceChildren(head('moon', 'Sommeil de cette nuit', 'Pas encore de nuit enregistrée'), h('p', { class: 'muted small' }, 'Saisis ta nuit pour que Kairos calcule ta dette et affine ta courbe.'), h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => ctx.navigate('#/sleep') }, 'Saisir ma nuit', icon('arrow-right', { size: 16 }))); return; }
      const dur = (ep.endMs - ep.startMs) / HOUR, frac = dur / needH, real = ep.src !== 'assumed';
      const log = st.sleeps.find((s) => !s.nap && s.wakeMs > ep.startMs && s.bedMs < ep.endMs), q = log && log.quality;
      cSleep.replaceChildren(
        head('moon', 'Sommeil de cette nuit', real ? 'Saisi par toi' : 'Estimé d\'après tes horaires habituels'),
        h('div', { class: 'td-sleep' }, h('div', { class: 'td-sleep__ring' }, moonRing(frac, `${fmtDuration(round(dur * 60))} dormis pour un besoin de ${needH} heures`), h('div', { class: 'td-sleep__dur' }, h('b', { class: 'num' }, fmtDuration(round(dur * 60))), h('span', { class: 'tiny faint' }, `sur ${needH} h`))),
          h('div', { class: 'td-sleep__info stack stack--sm' },
            h('div', { class: 'td-sleep__row' }, icon('bed', { size: 16 }), h('span', { class: 'num' }, fmtTime(ep.startMs)), icon('arrow-right', { size: 14 }), icon('sunrise', { size: 16 }), h('span', { class: 'num' }, fmtTime(ep.endMs))),
            q ? h('div', { class: 'td-stars', role: 'img', 'aria-label': `Qualité ${q} sur 5` }, ...[1, 2, 3, 4, 5].map((i) => h('i', { class: i <= q ? 'is-on' : '' }))) : null,
            h('div', { class: `td-debt${debt > 2 ? ' is-high' : debt > 0.5 ? ' is-mid' : ' is-ok'}` }, icon(debt > 0.5 ? 'battery' : 'check-circle', { size: 15 }), debt > 0.5 ? `Dette : ${fmtDuration(round(debt * 60))}` : 'Aucune dette de sommeil'))),
        !real ? h('button', { class: 'btn btn--ghost btn--sm td-sleep__cta', type: 'button', onclick: () => ctx.navigate('#/sleep') }, 'Saisir ma nuit réelle', icon('arrow-right', { size: 14 })) : null);
    }

    function renderNap(m) {
      let nap = null;
      if (dayOffset >= 0) { try { nap = planNap({ model: m, nowMs: isToday() ? now() : dayStart() + 7 * HOUR }); } catch { nap = null; } }
      if (!nap) {
        cNap.replaceChildren(head('zap', 'Sieste conseillée', dayOffset < 0 ? 'Jour passé' : 'Pas besoin pour l\'instant'),
          h('p', { class: 'muted small' }, dayOffset < 0 ? 'On ne planifie pas de sieste dans le passé.' : 'Ton énergie tient bien et ta nuit approche : une sieste ne ferait que décaler ton coucher.'));
        return;
      }
      cNap.replaceChildren(head('zap', 'Sieste conseillée', `${nap.durMin} min · ${isToday() ? inLabel(nap.startMs - now()) : fmtDateFR(nap.startMs, { short: true })}`),
        h('div', { class: 'td-nap__big' }, h('b', { class: 'num' }, fmtTime(nap.startMs)), h('span', { class: 'td-nap__dur' }, `→ ${fmtTime(nap.endMs)}`)),
        h('p', { class: 'td-nap__why small muted' }, nap.why),
        h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: () => addNap(nap) }, icon('calendar-check', { size: 16 }), 'Ajouter à l\'agenda'));
    }
    function addNap(nap) {
      const ev = ctx.actions.addEvent({ title: `Sieste · ${nap.durMin} min`, startMs: nap.startMs, endMs: nap.endMs, source: 'manual' }); haptic(8);
      ctx.toast(`Sieste ajoutée à ${fmtTime(nap.startMs)}`, { kind: 'ok', undoLabel: 'Annuler', onUndo: () => ev && ctx.actions.removeEvent(ev.id) });
    }

    function renderTasks() {
      const st = ctx.state, d0 = dayStart(), d1 = d0 + DAY, blocks = blocksOfDay(), firstBlock = new Map();
      for (const b of blocks) if (!firstBlock.has(b.taskId)) firstBlock.set(b.taskId, b);
      const open = st.tasks.filter((t) => !t.done);
      const todayOpen = open.filter((t) => firstBlock.has(t.id) || (t.deadlineMs && t.deadlineMs < d1));
      const filler = open.filter((t) => !todayOpen.includes(t)).sort((a, b) => a.priority - b.priority || b.load - a.load).slice(0, Math.max(0, 4 - todayOpen.length));
      const list = [...todayOpen.sort((a, b) => ((firstBlock.get(a.id) || { startMs: Infinity }).startMs - (firstBlock.get(b.id) || { startMs: Infinity }).startMs) || a.priority - b.priority), ...filler];
      const done = st.tasks.filter((t) => t.done && t.doneMs && t.doneMs >= d0 && t.doneMs < d1);
      const shown = list.slice(0, 7);
      cTasks.replaceChildren(
        head('list', 'Tâches du jour', list.length ? `${list.length} à faire${done.length ? ` · ${done.length} déjà faite${done.length > 1 ? 's' : ''}` : ''}` : done.length ? 'Tout est fait, bravo' : 'Rien d\'urgent'),
        h('button', { class: 'td-addbar', type: 'button', onclick: () => ctx.openQuickAdd() }, icon('plus', { size: 18, stroke: 2.2 }), h('span', { class: 'grow td-addbar__txt' }, 'Ajouter une tâche… « Rapport 2h demain »'), h('span', { class: 'kbd hide-sm' }, 'N')),
        shown.length || done.length ? h('ul', { class: 'td-tasks' },
          ...shown.map((t) => taskRow(t, firstBlock.get(t.id))), ...done.slice(0, 4).map((t) => taskRow(t, null))) : h('p', { class: 'td-softempty muted small' }, 'Ta liste est vide. Ajoute ce que tu as en tête : Kairos le place au bon moment.'),
        list.length > shown.length ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => ctx.navigate('#/plan') }, `Voir les ${list.length} tâches`, icon('arrow-right', { size: 14 })) : null);
    }
    function taskRow(t, block) {
      const late = !t.done && t.deadlineMs && t.deadlineMs < now();
      const box = h('button', { class: 'td-check', type: 'button', role: 'checkbox', 'aria-checked': String(!!t.done), 'aria-label': `${t.done ? 'Rouvrir' : 'Terminer'} : ${t.title}`,
        onclick: (e) => toggleTask(t, e.currentTarget) }, svg('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' }, svg('path', { d: 'M5 12.5l4.5 4.5L19 7.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1 })));
      return h('li', { class: `td-task-row${t.done ? ' is-done' : ''}` }, box,
        h('div', { class: 'td-task-row__main' }, h('span', { class: 'td-task-row__title' }, t.title), h('span', { class: 'td-task-row__meta' }, loadDots(t.load), h('span', { class: 'tiny faint num' }, fmtDuration(t.durMin)), late ? h('span', { class: 'badge badge--coral' }, 'en retard') : null)),
        block ? chipTime(fmtTime(block.startMs)) : (t.deadlineMs && !t.done ? h('span', { class: 'tiny faint num' }, `avant ${fmtTime(t.deadlineMs)}`) : null));
    }
    function toggleTask(t, btn) {
      const done = !t.done, r = btn.getBoundingClientRect();
      btn.classList.add(done ? 'is-popping' : 'is-unpopping');
      if (done) confetti(r.left + r.width / 2, r.top + r.height / 2, { count: 22, spread: .55 });
      haptic(done ? [10, 30, 10] : 6);
      setTimeout(() => { ctx.actions.completeTask(t.id, done); }, done && !reduced ? 260 : 0);
      if (done) ctx.toast('Bien joué ! Une de moins.', { kind: 'ok', undoLabel: 'Annuler', onUndo: () => ctx.actions.completeTask(t.id, false) });
    }

    // ------------------------------------------------ BIENVENUE (état vide)
    function renderWelcome() {
      const st = ctx.state, empty = !st.sleeps.length && !st.checkins.length && !st.tasks.length && !st.caffeine.length;
      welcome.hidden = !empty; if (!empty) return;
      welcome.replaceChildren(
        h('div', { class: 'td-welcome__grid' }, welcomeArt(),
          h('div', { class: 'stack' },
            h('span', { class: 'eyebrow eyebrow--sun' }, 'Bienvenue'),
            h('h3', { class: 'td-welcome__title' }, 'Ton cerveau a un emploi du temps. ', h('em', null, 'Faisons connaissance.')),
            h('p', { class: 'muted' }, 'La courbe ci-dessus vient de tes horaires habituels. Plus tu me racontes (nuits, cafés, tâches), plus elle devient la tienne.'),
            h('div', { class: 'row row--wrap' },
              h('button', { class: 'btn btn--primary', type: 'button', onclick: loadDemo }, icon('sparkle', { size: 18 }), 'Explorer avec une démo'),
              h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => ctx.navigate('#/sleep') }, icon('moon', { size: 18 }), 'Saisir ma nuit'),
              h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => ctx.openQuickAdd() }, icon('plus', { size: 18 }), 'Ajouter une tâche')))));
    }
    async function loadDemo() {
      try { const mod = await import('../../core/demo.js'); const make = mod.makeDemoState || mod.default; ctx.actions.loadDemo(make(now(), 7)); haptic(12); ctx.toast('Démo chargée : une vraie vie de 4 semaines pour jouer', { kind: 'ok', undoLabel: 'Annuler', onUndo: () => ctx.store.undo() }); }
      catch (e) { console.error(e); ctx.toast('La démo n\'est pas disponible pour l\'instant', { kind: 'warn' }); }
    }

    // ------------------------------------------------ jour et rendu global
    function setDay(o) {
      dayOffset = clamp(o, -7, 7); haptic(5); render(true);
    }
    function renderDayBar() {
      const d0 = dayStart(), n = now();
      dayEyebrow.textContent = dayOffset === 0 ? 'Aujourd\'hui' : dayOffset === 1 ? 'Demain' : dayOffset === -1 ? 'Hier' : dayOffset > 0 ? `Dans ${dayOffset} jours` : `Il y a ${-dayOffset} jours`;
      dayLabel.textContent = fmtDateFR(d0, { year: false });
      backBtn.hidden = dayOffset === 0; prevBtn.disabled = dayOffset <= -7; nextBtn.disabled = dayOffset >= 7;
      dayBar.classList.toggle('is-away', dayOffset !== 0);
      void n;
    }
    function render() {
      rafId = 0; if (disposed) return;
      let m; try { m = model(); } catch (e) { console.error(e); return; }
      renderDayBar(); renderHero(m); renderChart(m); renderWelcome();
      renderNext(); renderGold(m); renderCaf(m); renderFeel(m); renderSleep(m); renderNap(m); renderTasks();
    }
    const schedule = () => { if (!rafId) rafId = requestAnimationFrame(() => render()); };
    offs.push(ctx.subscribe(schedule));
    render();

    return () => {
      disposed = true; cancelAnimationFrame(rafId); clearTimeout(scrubTimer); offs.forEach((o) => o());
      if (chart) chart.destroy(); if (ring) ring.destroy();
    };
  },
};
