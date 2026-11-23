// Vue « Labo » : le simulateur « et si ? ».
// On manipule un scénario (nuit, caféine, sieste) ; le modèle est recalculé en direct avec buildModel({whatIf})
// et dessiné par-dessus la référence (courbe fantôme). L'optimiseur pur de core/lab.js propose le meilleur plan.
// Rien n'est enregistré tant que l'utilisateur n'appuie pas sur « Ajouter à mon agenda ».
import { h, svg, icon, replaceChildren, animateNumber, confetti, haptic, prefersReducedMotion, uniqueId, syncRange } from '../dom.js';
import { alertnessChart, chartLayout } from '../charts.js';
import { MIN, HOUR, startOfDay, addDays, fmtTime, fmtDuration, fmtDateFR, clamp, uid } from '../../core/time.js';
import {
  LAB, referenceScenario, buildScenarioModel, scenarioMetrics, optimizeDay, kindForMg, planText, workWindow,
} from '../../core/lab.js';
import { CAFFEINE } from '../../core/caffeine.js';

const CSS = 'css/views-lab.css';
function ensureCss() {
  try {
    const href = new URL(CSS, document.baseURI).href;
    if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) return;
    const link = h('link', { rel: 'stylesheet', href: CSS }); link.onerror = () => link.remove(); document.head.appendChild(link);
  } catch { /* le style est aussi chargé par le shell */ }
}

const decimal = (x, d = 1) => Number(x).toFixed(d).replace('.', ',');
const signed = (x, d = 1) => `${x > 0.0499 ? '+' : x < -0.0499 ? '−' : '±'}${decimal(Math.abs(x), d)}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const hhmmToMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const RANGE_H = [4, 30]; // fenêtre du graphique : 04:00 → 06:00 le lendemain
const KINDS = [{ kind: 'café', mg: 80, label: 'Café' }, { kind: 'thé', mg: 40, label: 'Thé' }, { kind: 'expresso', mg: 63, label: 'Expresso' }];

// Rappels (Notification API) : conservés hors de la vue, ils survivent à la navigation tant que l'onglet reste ouvert.
let reminderTimers = [];

// ===========================================================================
// Panneau pédagogique : courbes illustratives (pas des données de l'utilisateur)
// ===========================================================================
function curvePath(fn, { w = 220, h: hh = 80, n = 72, pad = 6, lo = 0, hi = 1 } = {}) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const t = i / n, v = clamp((fn(t) - lo) / (hi - lo), 0, 1); pts.push([pad + t * (w - 2 * pad), hh - pad - v * (hh - 2 * pad)]); }
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
}
// t ∈ [0,1] représente 24 h à partir de 06:00
const S_FN = (t) => { const hr = t * 24; return hr < 16 ? 1 - Math.exp(-hr / 11) * 0.88 - 0.12 + 0.12 : 0.62 * Math.exp(-(hr - 16) / 3.2) + 0.04; };
const C_FN = (t) => { const hr = (t * 24 + 6) % 24; return 0.5 + 0.5 * (Math.cos(2 * Math.PI * (hr - 17) / 24) + 0.4 * Math.cos(2 * Math.PI * (hr - 10) / 12)) / 1.4; };
const CAF_FN = (t) => { const hr = t * 24, f = (d) => (hr > d ? Math.exp(-(hr - d) / 7) - Math.exp(-(hr - d) / 0.7) : 0); return Math.min(1, 0.95 * f(2.5) + 0.8 * f(7.5)); };
const ALERT_FN = (t) => { const hr = t * 24; const a = 0.52 + 0.55 * (C_FN(t) - 0.5) - 0.5 * (S_FN(t) - 0.4) + 0.2 * CAF_FN(t); return hr > 17.5 ? a * Math.max(0.15, 1 - (hr - 17.5) / 3.5) : a; };

function learnTile({ cls, title, kicker, fn, extra, text, lo = 0, hi = 1 }) {
  const gid = uniqueId('lg');
  const path = curvePath(fn, { lo, hi });
  return h('figure', { class: `lab-tile ${cls}` },
    svg('svg', { viewBox: '0 0 220 80', class: 'lab-tile__svg', role: 'img', 'aria-label': `${title} : ${text}` },
      svg('defs', null, svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'currentColor', 'stop-opacity': '.34' }), svg('stop', { offset: '1', 'stop-color': 'currentColor', 'stop-opacity': '0' }))),
      extra || null,
      svg('path', { d: `${path}L214 74L6 74Z`, fill: `url(#${gid})` }),
      svg('path', { d: path, class: 'lab-tile__line', pathLength: '1', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })),
    h('figcaption', null, h('span', { class: 'lab-tile__kicker' }, kicker), h('b', null, title), h('span', { class: 'lab-tile__text' }, text)));
}

function buildLearnPanel() {
  const sleepBand = svg('rect', { x: 6 + (16 / 24) * 208, y: 6, width: (8 / 24) * 208, height: 68, rx: 4, fill: 'currentColor', opacity: '.1' });
  const thr = svg('line', { x1: 6, x2: 214, y1: 60, y2: 60, stroke: 'currentColor', 'stroke-dasharray': '3 4', opacity: '.45' });
  const gold = svg('rect', { x: 6 + (4 / 24) * 208, y: 6, width: 50, height: 68, rx: 6, fill: 'var(--sun)', opacity: '.14' });
  const legend = [
    ['lab-key lab-key--line', 'Ligne dorée : ton alerte prédite (0–100)'],
    ['lab-key lab-key--ghost', 'Pointillés clairs : ta référence (ce que dit ton état réel)'],
    ['lab-key lab-key--caf', 'Pointillés caramel : caféine active dans le sang (axe de droite, en mg)'],
    ['lab-key lab-key--sleep', 'Hachures bleues : sommeil (réel ou habituel)'],
    ['lab-key lab-key--gold', 'Halo or : fenêtre d\'or, tes meilleures heures'],
  ];
  return h('details', { class: 'card lab-learn' },
    h('summary', { class: 'lab-learn__sum' },
      h('span', { class: 'lab-learn__ico' }, icon('book', { size: 20 })),
      h('span', { class: 'grow' }, h('b', { class: 'serif' }, 'Comment lire ce graphique'), h('span', { class: 'small muted lab-learn__hint' }, 'Trois forces se combinent : S, C et la caféine')),
      h('span', { class: 'lab-learn__chev' }, icon('chevron-down', { size: 20 }))),
    h('div', { class: 'lab-learn__body' },
      h('p', { class: 'lead' }, 'Ton énergie du moment n\'est pas un hasard : c\'est la rencontre de deux horloges et d\'une molécule.'),
      h('div', { class: 'lab-tiles' },
        learnTile({ cls: 'lab-tile--s', kicker: 'S', title: 'La pression de sommeil', fn: S_FN, text: 'Elle monte tant que tu es éveillé·e, et ne retombe que pendant le sommeil. Plus tu es éveillé·e longtemps, plus elle tire ton énergie vers le bas.', extra: sleepBand }),
        learnTile({ cls: 'lab-tile--c', kicker: 'C', title: 'L\'horloge du corps', fn: C_FN, text: 'Ton rythme circadien : un pic en fin de matinée, un petit creux après le déjeuner, un second souffle en fin d\'après-midi, puis la nuit.' }),
        learnTile({ cls: 'lab-tile--caf', kicker: 'mg', title: 'La caféine', fn: CAF_FN, extra: thr, text: 'Elle masque l\'adénosine (le signal de fatigue) en ~40 min, puis s\'élimine lentement : la moitié reste encore 5 h après. Sous le seuil au coucher, ton sommeil est protégé.' }),
        learnTile({ cls: 'lab-tile--r', kicker: '= alerte', title: 'Le résultat', fn: ALERT_FN, extra: gold, text: 'Horloge moins fatigue, plus un coup de pouce de caféine. Les plus hauts sommets sont tes fenêtres d\'or : garde-les pour ce qui compte.' })),
      h('ul', { class: 'lab-keys' }, ...legend.map(([c, t]) => h('li', null, h('span', { class: c, 'aria-hidden': 'true' }), t))),
      h('p', { class: 'tiny faint' }, 'Modèle de Borbély (deux processus), calibré sur des ordres de grandeur de la littérature : une aide à l\'organisation, pas un avis médical. Détails dans « La science ».')));
}

// ===========================================================================
// Vue
// ===========================================================================
export default {
  id: 'lab',
  title: 'Labo',
  icon: 'flask',
  mount(root, ctx) {
    ensureCss();
    const reduced = prefersReducedMotion();
    let dayOffset = 0;
    let ref = null; // { scenario, model, metrics, thr }
    let sc = null; // scénario de travail
    let met = null; // métriques du scénario
    let opt = null; // dernier résultat de l'optimiseur
    let dirty = false;
    let busy = false;
    let rafId = 0;
    let chart = null;
    let disposed = false;
    const offs = [];

    const dayMs = () => addDays(startOfDay(ctx.nowMs()), dayOffset);
    const rangeOf = (d) => [d + RANGE_H[0] * HOUR, d + RANGE_H[1] * HOUR];
    const tag = (c) => { c._id = c._id || uid('c'); return c; };
    const stripIds = (s) => JSON.stringify({ ...s, caffeine: s.caffeine.map((c) => ({ tMs: c.tMs, mg: c.mg, kind: c.kind || kindForMg(c.mg) })) });
    const isDirty = () => stripIds(sc) !== stripIds(ref.scenario);
    const objective = () => (dayOffset === 0 ? { earliestMs: ctx.nowMs() } : {});

    // -------------------------------------------------------------- données
    function loadRef(resetScenario) {
      const st = ctx.state, d = dayMs();
      const r = referenceScenario({ profile: st.profile, sleeps: st.sleeps, caffeine: st.caffeine, dayMs: d });
      const thr = r.model.stats.p75 ?? 75;
      ref = { scenario: r.scenario, model: r.model, thr, metrics: scenarioMetrics({ model: r.model, profile: st.profile, dayMs: d, scenario: r.scenario, goldenThr: thr }) };
      if (resetScenario || !sc) { sc = clone(r.scenario); sc.caffeine.forEach(tag); dirty = false; }
    }
    function computeScenario() {
      const st = ctx.state, d = dayMs();
      const model = buildScenarioModel({ profile: st.profile, sleeps: st.sleeps, caffeine: st.caffeine, dayMs: d, scenario: sc });
      met = scenarioMetrics({ model, profile: st.profile, dayMs: d, scenario: sc, goldenThr: ref.thr });
      return model;
    }

    // -------------------------------------------------------------- squelette
    const canvas = h('canvas', { role: 'img', tabindex: '0', 'aria-label': 'Courbe d\'alerte du scénario' });
    const chartBox = h('div', { class: 'chart lab-chart__plot' }, canvas);
    const rail = h('div', { class: 'lab-rail', role: 'group', 'aria-label': 'Frise du scénario : glisse les cafés et la sieste' });
    const railTrack = h('div', { class: 'lab-rail__track' });
    rail.appendChild(railTrack);

    // ---- héros
    const deltaNum = h('span', { class: 'lab-delta__num num' }, '±0');
    const deltaUnit = h('span', { class: 'lab-delta__unit' }, '%');
    const deltaCap = h('p', { class: 'lab-delta__cap' }, 'Déplace un café, avance ton coucher : regarde ce que ça change.');
    const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
    const optBtn = h('button', { class: 'btn btn--primary btn--lg lab-opt', type: 'button', onclick: () => runOptimize() },
      h('span', { class: 'lab-opt__spark', 'aria-hidden': 'true' }, icon('wand', { size: 20 })), h('span', { class: 'lab-opt__txt' }, 'Optimiser pour moi'));
    const resetBtn = h('button', { class: 'btn btn--ghost', type: 'button', disabled: true, onclick: () => resetAll() }, icon('undo', { size: 18 }), 'Réinitialiser');
    const dayBtns = [[0, 'Aujourd\'hui'], [1, 'Demain']].map(([o, l]) => h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': String(o === dayOffset), onclick: () => setDay(o) }, l));
    const hero = h('section', { class: 'card card--hero lab-hero', 'aria-labelledby': 'lab-title' },
      h('div', { class: 'lab-hero__glow', 'aria-hidden': 'true' }),
      h('div', { class: 'lab-hero__grid' },
        h('div', { class: 'lab-hero__copy stack' },
          h('span', { class: 'eyebrow eyebrow--sun' }, 'Le laboratoire'),
          h('h2', { class: 'lab-hero__title', id: 'lab-title' }, 'Et si tu ', h('em', null, 'rejouais'), ' ta journée ?'),
          h('p', { class: 'lead lab-hero__lead' }, 'Change une nuit, un café, une sieste : l\'énergie se recalcule sous tes doigts, comparée à ta journée de référence.'),
          h('div', { class: 'row row--wrap lab-hero__actions' }, optBtn, resetBtn),
          h('div', { class: 'seg lab-hero__seg', role: 'group', 'aria-label': 'Jour simulé' }, ...dayBtns)),
        h('div', { class: 'lab-delta', 'aria-hidden': 'false' },
          h('div', { class: 'lab-delta__ring', 'aria-hidden': 'true' }),
          h('div', { class: 'lab-delta__val' }, deltaNum, deltaUnit),
          deltaCap)),
      live);

    // ---- graphique
    const readout = h('span', { class: 'lab-chart__read num' });
    const chartCard = h('section', { class: 'card lab-chart', 'aria-label': 'Courbe d\'alerte du scénario' },
      h('div', { class: 'card__head' },
        h('div', null, h('h3', { class: 'card__title' }, 'Ton énergie, scénario contre référence'), h('p', { class: 'card__sub', id: 'lab-day' }, '')),
        readout),
      chartBox, rail,
      h('div', { class: 'chart__legend' },
        h('span', { class: 'legend-item', style: { '--c': 'var(--sun)' } }, 'Scénario'),
        h('span', { class: 'legend-item legend-item--dash', style: { '--c': 'var(--text-2)' } }, 'Référence'),
        h('span', { class: 'legend-item legend-item--dash', style: { '--c': 'var(--caffeine)' } }, 'Caféine (mg)'),
        h('span', { class: 'legend-item legend-item--block', style: { '--c': 'var(--night)' } }, 'Sommeil')));

    // ---- contrôles
    const mkSlider = ({ id, label, min, max, step, icn, fmtV, tone, onInput }) => {
      const out = h('output', { class: 'lab-sl__val num', for: id }, '');
      const input = h('input', { class: `range ${tone === 'night' ? 'range--night' : ''}`, id, type: 'range', min: String(min), max: String(max), step: String(step), value: String(min), 'aria-label': label,
        oninput: (e) => { const v = Number(e.target.value); out.textContent = fmtV(v); onInput(v); } });
      const el = h('label', { class: 'lab-sl', for: id }, h('span', { class: 'lab-sl__head' }, h('span', { class: `lab-sl__ico lab-sl__ico--${tone || 'sun'}` }, icon(icn, { size: 16 })), h('span', { class: 'lab-sl__lbl' }, label), out), input);
      return { el, input, out };
    };
    const minOf = (ms) => Math.round((ms - dayMs()) / MIN);
    const tm = (m) => fmtTime(dayMs() + m * MIN);

    const slWake = mkSlider({ id: 'lab-wake', label: 'Réveil ce matin', min: 240, max: 660, step: 5, icn: 'sunrise', fmtV: tm, onInput: (v) => { const dur = sc.lastNight.wakeMs - sc.lastNight.bedMs; sc.lastNight.wakeMs = dayMs() + v * MIN; sc.lastNight.bedMs = sc.lastNight.wakeMs - dur; touched(); } });
    const slDur = mkSlider({ id: 'lab-dur', label: 'Nuit dernière', min: 3, max: 10, step: 0.25, icn: 'moon', tone: 'night', fmtV: (v) => fmtDuration(v * 60), onInput: (v) => { sc.lastNight.bedMs = sc.lastNight.wakeMs - v * HOUR; touched(); } });
    const slBed = mkSlider({ id: 'lab-bed', label: 'Coucher ce soir', min: 1200, max: 1620, step: 5, icn: 'bed', tone: 'night', fmtV: tm, onInput: (v) => { sc.tonight.bedMs = Math.min(dayMs() + v * MIN, sc.tonight.wakeMs - 2 * HOUR); touched(); } });
    const slWake2 = mkSlider({ id: 'lab-wake2', label: 'Réveil demain', min: 1680, max: 2100, step: 5, icn: 'sunrise', fmtV: tm, onInput: (v) => { sc.tonight.wakeMs = Math.max(dayMs() + v * MIN, sc.tonight.bedMs + 2 * HOUR); touched(); } });
    const napSwitch = h('input', { type: 'checkbox', id: 'lab-nap-on', onchange: (e) => toggleNap(e.target.checked) });
    const slNapAt = mkSlider({ id: 'lab-nap-at', label: 'Heure de la sieste', min: 660, max: 1050, step: 5, icn: 'clock', tone: 'sun', fmtV: tm, onInput: (v) => { if (!sc.nap) return; const dur = sc.nap.endMs - sc.nap.startMs; sc.nap.startMs = dayMs() + v * MIN; sc.nap.endMs = sc.nap.startMs + dur; touched(); } });
    const slNapDur = mkSlider({ id: 'lab-nap-dur', label: 'Durée', min: 10, max: 90, step: 5, icn: 'timer', fmtV: (v) => fmtDuration(v), onInput: (v) => { if (!sc.nap) return; sc.nap.endMs = sc.nap.startMs + v * MIN; touched(); } });
    const napBody = h('div', { class: 'lab-nap__body' }, slNapAt.el, slNapDur.el, h('p', { class: 'tiny faint' }, '20 min : tu évites le sommeil profond et l\'inertie du réveil. Plus de 30 min, compte 15 min pour te remettre en route.'));
    const napBox = h('div', { class: 'lab-nap' }, h('label', { class: 'switch lab-nap__sw', for: 'lab-nap-on' }, napSwitch, h('span', { class: 'switch__ui' }), h('span', null, h('b', null, 'Sieste'), h('span', { class: 'small muted' }, ' · facultative'))), napBody);

    const cafeList = h('ul', { class: 'lab-cafes', 'aria-label': 'Prises de caféine du scénario' });
    const addRow = h('div', { class: 'lab-add row row--wrap' }, ...KINDS.map((k) => h('button', { class: 'chip lab-add__btn', type: 'button', onclick: () => addCafe(k) }, icon('plus', { size: 14 }), `${k.label} ${k.mg} mg`)));
    const presetDefs = [
      { label: 'Nuit courte hier', emoji: '😵', run: () => { sc.lastNight.bedMs = sc.lastNight.wakeMs - 5 * HOUR; } },
      { label: 'Zéro caféine', emoji: '🚫', run: () => { sc.caffeine = []; } },
      { label: 'Sieste de 20 min', emoji: '😴', run: () => { const s = dayMs() + 13.5 * HOUR; sc.nap = { startMs: s, endMs: s + 20 * MIN }; } },
      { label: 'Coucher à 01:00', emoji: '🦉', run: () => { sc.tonight.bedMs = dayMs() + 25 * HOUR; sc.tonight.wakeMs = Math.max(sc.tonight.wakeMs, sc.tonight.bedMs + 6 * HOUR); } },
      { label: 'Café à 17:00', emoji: '☕', run: () => { sc.caffeine.push(tag({ tMs: dayMs() + 17 * HOUR, mg: 80, kind: 'café' })); } },
    ];
    const presets = h('div', { class: 'lab-presets', role: 'group', 'aria-label': 'Scénarios rapides' }, ...presetDefs.map((p) => h('button', { class: 'chip lab-preset', type: 'button', onclick: () => { p.run(); sc.caffeine.sort((a, b) => a.tMs - b.tMs); touched(true); haptic(8); } }, h('span', { 'aria-hidden': 'true' }, p.emoji), p.label)));

    const controls = h('section', { class: 'card lab-controls', 'aria-label': 'Réglages du scénario' },
      h('div', { class: 'card__head' }, h('div', null, h('h3', { class: 'card__title' }, 'Ton scénario'), h('p', { class: 'card__sub' }, 'Tout ce que tu changes ici n\'est pas enregistré.'))),
      presets,
      h('div', { class: 'lab-controls__grid' },
        h('div', { class: 'lab-group' }, h('h4', { class: 'lab-group__t' }, icon('moon', { size: 16 }), 'Nuits'), slWake.el, slDur.el, slBed.el, slWake2.el),
        h('div', { class: 'lab-group' }, h('h4', { class: 'lab-group__t' }, icon('coffee', { size: 16 }), 'Caféine'), cafeList, addRow),
        h('div', { class: 'lab-group' }, h('h4', { class: 'lab-group__t' }, icon('zap', { size: 16 }), 'Sieste'), napBox)));

    // ---- métriques
    const metricEls = {};
    const mkMetric = (key, label, tip, opts = {}) => {
      const val = h('b', { class: 'lab-m__val num' }, '–');
      const unit = h('span', { class: 'lab-m__unit' }, opts.unit || '');
      const refEl = h('span', { class: 'lab-m__ref' }, '');
      const chip = h('span', { class: 'lab-chip' }, '');
      const extra = opts.extra ? opts.extra(metricEls) : null;
      const el = h('article', { class: `lab-m lab-m--${key}` },
        h('span', { class: 'lab-m__label' }, label, h('button', { class: 'lab-m__tip', type: 'button', 'data-tip': tip, 'aria-label': tip }, icon('info', { size: 14 }))),
        h('div', { class: 'lab-m__row' }, val, unit), extra, h('div', { class: 'lab-m__cmp' }, refEl, chip));
      metricEls[key] = { el, val, unit, refEl, chip };
      return el;
    };
    const riskMeter = h('div', { class: 'lab-risk', 'aria-hidden': 'true' }, h('i', { class: 'lab-risk__mark' }));
    const riskWhy = h('p', { class: 'tiny muted lab-m__why' }, '');
    const cafBar = h('div', { class: 'lab-cafbar', 'aria-hidden': 'true' }, h('i', { class: 'lab-cafbar__fill' }), h('i', { class: 'lab-cafbar__thr', style: { left: `${(CAFFEINE.bedThresholdMg / 80) * 100}%` } }));
    const dlmoEl = h('p', { class: 'tiny muted lab-m__why' }, '');
    const metricsGrid = h('section', { class: 'lab-metrics', 'aria-label': 'Comparaison avec la référence' },
      mkMetric('mean', 'Alerte moyenne au travail', 'Moyenne de l\'alerte prédite pendant tes heures de travail', { unit: '/100' }),
      mkMetric('gold', 'Minutes en zone d\'or', 'Minutes éveillées où l\'alerte dépasse le 75e centile de ta journée de référence', { unit: 'min' }),
      mkMetric('caf', 'Caféine au coucher', 'Caféine encore active quand tu te couches. Repère de confort : 25 mg maximum', { unit: 'mg', extra: () => cafBar }),
      mkMetric('onset', 'Endormissement estimé', 'Heure de coucher + 15 min de latence, allongée par la caféine résiduelle (heuristique)', { extra: () => dlmoEl }),
      mkMetric('risk', 'Risque pour le sommeil', 'Combine caféine au coucher et durée de la nuit par rapport à ton besoin', { extra: () => h('div', { class: 'stack stack--sm' }, riskMeter, riskWhy) }));

    // ---- résultat de l'optimiseur
    const optHost = h('div', { class: 'lab-opt-host' });

    const learn = buildLearnPanel();
    root.append(hero, chartCard, metricsGrid, controls, optHost, learn);

    // -------------------------------------------------------------- graphique et frise
    chart = alertnessChart(canvas, { model: null, nowMs: ctx.nowMs(), range: rangeOf(dayMs()), showCaffeine: true, showSleep: true, showZones: true,
      onScrub: (ms) => { readout.textContent = `${fmtTime(ms)}`; }, onScrubEnd: () => { readout.textContent = ''; } });

    const trackBox = { left: 38, right: 42 };
    function measureTrack() {
      const w = chartBox.clientWidth || 360;
      const L = chartLayout(w, 300, { showCaffeine: true });
      trackBox.left = L.x0; trackBox.right = w - L.x1;
      rail.style.setProperty('--x0', `${trackBox.left}px`); rail.style.setProperty('--x1', `${trackBox.right}px`);
    }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measureTrack()) : null;
    if (ro) ro.observe(chartBox); measureTrack();

    const pct = (ms) => ((ms - rangeOf(dayMs())[0]) / ((RANGE_H[1] - RANGE_H[0]) * HOUR)) * 100;
    const pins = new Map(); // _id | 'nap' -> élément
    let napBar = null;

    function renderRail() {
      replaceChildren(railTrack); pins.clear();
      const d = dayMs(), [r0, r1] = rangeOf(d);
      const bar = (a, b, cls, label) => { const x0 = clamp(pct(a), 0, 100), x1 = clamp(pct(b), 0, 100); if (x1 - x0 < 0.3) return; railTrack.appendChild(h('span', { class: `lab-sleepbar ${cls}`, style: { left: `${x0}%`, width: `${x1 - x0}%` }, 'aria-hidden': 'true' }, label)); };
      if (sc.lastNight) bar(sc.lastNight.bedMs, sc.lastNight.wakeMs, '', 'Nuit');
      if (sc.tonight) bar(sc.tonight.bedMs, sc.tonight.wakeMs, '', 'Nuit');
      if (ctx.nowMs() >= r0 && ctx.nowMs() <= r1) railTrack.appendChild(h('span', { class: 'lab-now', style: { left: `${pct(ctx.nowMs())}%` }, 'aria-hidden': 'true' }));
      sc.caffeine.forEach((c) => { const p = pin({ id: c._id, kind: 'caf', item: c }); railTrack.appendChild(p); pins.set(c._id, p); });
      napBar = null;
      if (sc.nap) { napBar = h('span', { class: 'lab-napbar', 'aria-hidden': 'true' }); railTrack.appendChild(napBar); const p = pin({ id: 'nap', kind: 'nap', item: sc.nap }); railTrack.appendChild(p); pins.set('nap', p); }
      positionPins();
    }
    function positionPins() {
      for (const [id, el] of pins) {
        const item = id === 'nap' ? sc.nap : sc.caffeine.find((c) => c._id === id);
        if (!item) continue;
        const t = id === 'nap' ? item.startMs : item.tMs;
        el.style.left = `${clamp(pct(t), 0, 100)}%`;
        el.querySelector('.lab-pin__t').textContent = fmtTime(t);
        el.setAttribute('aria-valuetext', `${id === 'nap' ? 'Sieste' : (item.kind || 'café')} à ${fmtTime(t)}`);
        el.setAttribute('aria-valuenow', String(Math.round(t / MIN)));
      }
      if (napBar && sc.nap) { napBar.style.left = `${clamp(pct(sc.nap.startMs), 0, 100)}%`; napBar.style.width = `${Math.max(0.6, clamp(pct(sc.nap.endMs), 0, 100) - clamp(pct(sc.nap.startMs), 0, 100))}%`; }
    }
    function pin({ id, kind, item }) {
      const isNap = kind === 'nap';
      const get = () => (isNap ? item.startMs : item.tMs);
      const set = (ms) => {
        const d = dayMs(); const lo = isNap ? d + 9 * HOUR : d + 5 * HOUR, hi = (sc.tonight ? sc.tonight.bedMs : d + 23 * HOUR) - (isNap ? 4 * HOUR : 30 * MIN);
        const v = clamp(Math.round(ms / (5 * MIN)) * 5 * MIN, lo, Math.max(lo, hi));
        if (isNap) { const dur = item.endMs - item.startMs; item.startMs = v; item.endMs = v + dur; } else item.tMs = v;
      };
      const el = h('button', { class: `lab-pin lab-pin--${kind}`, type: 'button', role: 'slider', 'aria-label': isNap ? 'Sieste : glisse pour la déplacer' : `${item.kind || 'Café'} ${item.mg} mg : glisse pour le déplacer, touche Supprimer pour le retirer`, 'aria-valuemin': '0', 'aria-valuemax': '0' },
        h('span', { class: 'lab-pin__bub' }, icon(isNap ? 'zap' : 'coffee', { size: 17 })),
        h('span', { class: 'lab-pin__t num' }, ''), h('span', { class: 'lab-pin__stem', 'aria-hidden': 'true' }));
      let dragging = false, moved = false;
      const msAt = (e) => { const r = railTrack.getBoundingClientRect(); return rangeOf(dayMs())[0] + clamp((e.clientX - r.left) / r.width, 0, 1) * (RANGE_H[1] - RANGE_H[0]) * HOUR; };
      el.addEventListener('pointerdown', (e) => { dragging = true; moved = false; el.setPointerCapture(e.pointerId); el.classList.add('is-drag'); haptic(6); e.preventDefault(); });
      el.addEventListener('pointermove', (e) => { if (!dragging) return; moved = true; set(msAt(e)); positionPins(); sc.caffeine.sort((a, b) => a.tMs - b.tMs); touched(false, true); });
      const end = (e) => { if (!dragging) return; dragging = false; el.classList.remove('is-drag'); try { el.releasePointerCapture(e.pointerId); } catch { /* ignoré */ } if (moved) { renderCafes(); syncControls(); } };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      el.addEventListener('keydown', (e) => {
        const st = (e.shiftKey ? 60 : 15) * MIN;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') set(get() - st); else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') set(get() + st);
        else if (!isNap && (e.key === 'Delete' || e.key === 'Backspace')) { removeCafe(item._id); return; }
        else if (isNap && (e.key === 'Delete' || e.key === 'Backspace')) { toggleNap(false); return; }
        else return;
        e.preventDefault(); positionPins(); touched(false, true); renderCafes(); syncControls();
      });
      return el;
    }

    // -------------------------------------------------------------- liste des cafés
    function renderCafes() {
      replaceChildren(cafeList);
      if (!sc.caffeine.length) cafeList.appendChild(h('li', { class: 'lab-cafes__empty' }, h('span', { 'aria-hidden': 'true' }, '🫗'), 'Aucune caféine dans ce scénario. Ajoutes-en une, ou regarde ce que ça change sans.'));
      sc.caffeine.forEach((c, i) => {
        const d = dayMs();
        const timeIn = h('input', { class: 'input lab-cafe__time', type: 'time', 'aria-label': `Heure de la prise ${i + 1}`, value: fmtTime(c.tMs), step: '300',
          onchange: (e) => { const m = hhmmToMin(e.target.value); if (m === null) return; let ms = d + m * MIN; if (m < 4 * 60) ms += 24 * HOUR; c.tMs = ms; sc.caffeine.sort((a, b) => a.tMs - b.tMs); touched(true); } });
        const mgOut = h('b', { class: 'num lab-cafe__mg' }, String(c.mg));
        const step = (dm) => () => { c.mg = clamp(c.mg + dm, 10, 250); c.kind = kindForMg(c.mg); mgOut.textContent = String(c.mg); touched(false, true); haptic(4); };
        cafeList.appendChild(h('li', { class: `lab-cafe${c.planned ? ' is-planned' : ''}`, style: { '--i': String(i) } },
          h('span', { class: 'lab-cafe__ico', 'aria-hidden': 'true' }, icon('coffee', { size: 18 })),
          h('span', { class: 'lab-cafe__name' }, c.kind || 'café', c.planned ? h('span', { class: 'badge badge--sun' }, 'conseillé') : null),
          timeIn,
          h('span', { class: 'lab-cafe__step' }, h('button', { class: 'iconbtn lab-step', type: 'button', 'aria-label': 'Moins de caféine', onclick: step(-10) }, icon('minus', { size: 16 })), h('span', { class: 'lab-cafe__dose' }, mgOut, h('small', null, 'mg')), h('button', { class: 'iconbtn lab-step', type: 'button', 'aria-label': 'Plus de caféine', onclick: step(10) }, icon('plus', { size: 16 }))),
          h('button', { class: 'iconbtn lab-cafe__rm', type: 'button', 'aria-label': `Retirer la prise de ${fmtTime(c.tMs)}`, onclick: () => removeCafe(c._id) }, icon('x', { size: 16 }))));
      });
    }

    function addCafe(k) {
      const d = dayMs(); const bed = sc.tonight ? sc.tonight.bedMs : d + 23 * HOUR;
      let t = dayMs() + (dayOffset === 0 ? Math.max(9, Math.ceil((ctx.nowMs() - d) / HOUR) + 0.5) : 10) * HOUR;
      t = Math.round(t / (15 * MIN)) * 15 * MIN;
      while (sc.caffeine.some((c) => Math.abs(c.tMs - t) < 45 * MIN) && t < bed - HOUR) t += HOUR;
      sc.caffeine.push(tag({ tMs: Math.min(t, bed - 30 * MIN), mg: k.mg, kind: k.kind })); sc.caffeine.sort((a, b) => a.tMs - b.tMs);
      touched(true); haptic(8);
    }
    function removeCafe(id) { sc.caffeine = sc.caffeine.filter((c) => c._id !== id); touched(true); haptic(6); }
    function toggleNap(on) {
      if (on && !sc.nap) { const s = dayMs() + 13.5 * HOUR; sc.nap = { startMs: s, endMs: s + 20 * MIN }; } else if (!on) sc.nap = null;
      touched(true);
    }

    // -------------------------------------------------------------- synchronisation
    function syncControls() {
      if (!sc.lastNight || !sc.tonight) return;
      // on pose la valeur sans déclencher `input` (les gestionnaires modifieraient le scénario)
      const put = (sl, v, f) => { sl.input.value = String(v); syncRange(sl.input); sl.out.textContent = f(v); };
      put(slWake, minOf(sc.lastNight.wakeMs), tm);
      put(slDur, (sc.lastNight.wakeMs - sc.lastNight.bedMs) / HOUR, (v) => fmtDuration(v * 60));
      put(slBed, minOf(sc.tonight.bedMs), tm);
      put(slWake2, minOf(sc.tonight.wakeMs), tm);
      napSwitch.checked = !!sc.nap; napBox.classList.toggle('is-on', !!sc.nap);
      if (sc.nap) { put(slNapAt, minOf(sc.nap.startMs), tm); put(slNapDur, (sc.nap.endMs - sc.nap.startMs) / MIN, (v) => fmtDuration(v)); }
    }

    function updateMetrics() {
      const a = ref.metrics, b = met, thr = Math.round(ref.thr);
      const dm = (b.meanWork / a.meanWork - 1) * 100;
      const setNum = (key, v, fmtF) => { const m = metricEls[key]; animateNumber(m.val, v, { duration: reduced ? 0 : 420, format: fmtF }); };
      setNum('mean', b.meanWork, (v) => decimal(v, 1));
      setNum('gold', b.goldenMin, (v) => String(Math.round(v)));
      setNum('caf', b.atBedMg, (v) => String(Math.round(v)));
      const w = b.window;
      metricEls.mean.el.querySelector('.lab-m__label').firstChild.textContent = `Alerte moyenne ${fmtTime(w.startMs)}–${fmtTime(w.endMs)}`;
      const chip = (key, text, tone) => { const c = metricEls[key].chip; c.textContent = text; c.className = `lab-chip lab-chip--${tone}`; };
      const tone = (x, goodUp = true, eps = 0.05) => (Math.abs(x) < eps ? 'flat' : (x > 0) === goodUp ? 'up' : 'down');
      metricEls.mean.refEl.textContent = `réf. ${decimal(a.meanWork)}`; chip('mean', `${signed(dm)} %`, tone(dm));
      const dg = b.goldenMin - a.goldenMin;
      metricEls.gold.refEl.textContent = `réf. ${Math.round(a.goldenMin)} min · seuil ${thr}`; chip('gold', `${dg > 0 ? '+' : dg < 0 ? '−' : '±'}${Math.abs(Math.round(dg))} min`, tone(dg, true, 0.5));
      metricEls.caf.refEl.textContent = `réf. ${Math.round(a.atBedMg)} mg · seuil ${CAFFEINE.bedThresholdMg}`;
      const dc = b.atBedMg - a.atBedMg; chip('caf', `${dc > 0.5 ? '+' : dc < -0.5 ? '−' : '±'}${Math.abs(Math.round(dc))} mg`, tone(dc, false, 0.5));
      metricEls.caf.el.classList.toggle('is-over', b.atBedMg > CAFFEINE.bedThresholdMg);
      cafBar.firstChild.style.width = `${clamp((b.atBedMg / 80) * 100, 0, 100)}%`;
      const on = metricEls.onset; on.val.textContent = fmtTime(b.onsetMs); on.unit.textContent = '';
      const dOn = Math.round((b.onsetMs - a.onsetMs) / MIN); on.refEl.textContent = `réf. ${fmtTime(a.onsetMs)}`;
      chip('onset', `${dOn > 0 ? '+' : dOn < 0 ? '−' : '±'}${Math.abs(dOn)} min`, tone(dOn, false, 0.5));
      dlmoEl.textContent = `Mélatonine vers ${fmtTime(b.dlmoMs)} · couché·e à ${fmtTime(b.bedMs)}`;
      const r = metricEls.risk; r.val.textContent = b.risk.level; r.val.className = `lab-m__val lab-m__val--word is-${b.risk.level === 'faible' ? 'low' : b.risk.level === 'modéré' ? 'mid' : 'high'}`;
      r.refEl.textContent = `réf. ${a.risk.level}`; const dr = b.risk.score - a.risk.score; chip('risk', dr > 0.03 ? 'en hausse' : dr < -0.03 ? 'en baisse' : 'inchangé', tone(dr, false, 0.03));
      riskMeter.firstChild.style.left = `${clamp(b.risk.score, 0, 1) * 100}%`; riskWhy.textContent = b.risk.why;

      // héros
      const up = dm > 0.049, down = dm < -0.049;
      animateNumber(deltaNum, dm, { duration: reduced ? 0 : 500, format: (v) => signed(v) });
      hero.classList.toggle('is-up', up); hero.classList.toggle('is-down', down);
      const win = `${fmtTime(w.startMs)}–${fmtTime(w.endMs)}`;
      deltaCap.textContent = up ? `d'alerte moyenne sur ${win} par rapport à ta référence.` : down ? `d'alerte moyenne sur ${win} : ce scénario te coûte de l'énergie.` : 'Déplace un café, avance ton coucher : regarde ce que ça change.';
      live.textContent = `Alerte moyenne ${decimal(b.meanWork)} sur 100, ${signed(dm)} pour cent par rapport à la référence. Caféine au coucher ${Math.round(b.atBedMg)} milligrammes. Risque pour le sommeil ${b.risk.level}.`;
      dirty = isDirty(); resetBtn.disabled = !dirty;
    }

    function recalc() {
      rafId = 0; if (disposed) return;
      const model = computeScenario();
      const d = dayMs();
      chart.update({ model, compareModel: ref.model, nowMs: ctx.nowMs(), range: rangeOf(d) });
      updateMetrics();
    }
    const schedule = () => { if (!rafId) rafId = requestAnimationFrame(recalc); };
    /** `full` : reconstruit liste + frise + curseurs ; `light` : recalcul seulement (glissement en cours). */
    function touched(full, light) {
      if (opt) { opt = null; renderOpt(); }
      if (full) { renderCafes(); renderRail(); syncControls(); } else if (light) positionPins();
      schedule();
    }

    function setDay(o) {
      if (o === dayOffset) return; dayOffset = o; opt = null;
      dayBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === o)));
      loadRef(true); renderCafes(); renderRail(); syncControls(); renderOpt(); frameTitle(); recalc();
      haptic(6);
    }
    function frameTitle() { const el = chartCard.querySelector('#lab-day'); if (el) el.textContent = `${fmtDateFR(dayMs())} · de ${fmtTime(rangeOf(dayMs())[0])} à ${fmtTime(rangeOf(dayMs())[1])} le lendemain`; }
    function resetAll() { loadRef(true); opt = null; renderCafes(); renderRail(); syncControls(); renderOpt(); recalc(); haptic(8); }

    // -------------------------------------------------------------- optimiseur
    async function runOptimize() {
      if (busy) return; busy = true;
      optBtn.classList.add('is-busy'); optBtn.disabled = true; optBtn.querySelector('.lab-opt__txt').textContent = 'Je cherche le meilleur plan…';
      hero.classList.add('is-thinking');
      await new Promise((r) => setTimeout(r, reduced ? 0 : 750));
      if (disposed) return;
      let res = null;
      try { const st = ctx.state; res = optimizeDay({ profile: st.profile, sleeps: st.sleeps, caffeine: st.caffeine, dayMs: dayMs(), objective: objective() }); } catch (e) { console.error(e); }
      hero.classList.remove('is-thinking'); optBtn.classList.remove('is-busy'); optBtn.disabled = false; optBtn.querySelector('.lab-opt__txt').textContent = 'Optimiser pour moi'; busy = false;
      if (!res) { ctx.toast('L\'optimiseur a rencontré un souci. Réessaie dans un instant.', { kind: 'err' }); return; }
      opt = res; sc = clone(res.scenario); sc.caffeine.forEach(tag); renderCafes(); renderRail(); syncControls(); renderOpt(); recalc();
      if (res.changed) { const r = optBtn.getBoundingClientRect(); confetti(r.left + r.width / 2, r.top + 4, { count: 34, spread: .8 }); haptic([10, 30, 14]); setTimeout(() => optHost.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' }), 120); }
    }

    function renderOpt() {
      replaceChildren(optHost);
      if (!opt) return;
      const planned = sc.caffeine.filter((c) => c.planned);
      const items = [
        ...planned.map((c) => ({ t: c.tMs, ico: 'coffee', txt: `${c.kind || 'Café'} · ${c.mg} mg`, cls: 'caf' })),
        ...(opt.changed && sc.nap && !ref.scenario.nap ? [{ t: sc.nap.startMs, ico: 'zap', txt: `Sieste · ${Math.round((sc.nap.endMs - sc.nap.startMs) / MIN)} min`, cls: 'nap' }] : []),
        ...(opt.changed ? [{ t: sc.tonight.bedMs, ico: 'bed', txt: 'Coucher', cls: 'bed' }] : []),
      ].sort((a, b) => a.t - b.t);
      const actionable = items.filter((i) => i.cls !== 'bed' && i.t > ctx.nowMs());
      optHost.appendChild(h('section', { class: `card card--glow lab-result${opt.changed ? '' : ' is-flat'}`, 'aria-label': 'Plan optimisé', 'aria-live': 'polite' },
        h('div', { class: 'lab-result__head' },
          h('span', { class: 'lab-result__ico', 'aria-hidden': 'true' }, icon(opt.changed ? 'sparkle' : 'check-circle', { size: 22 })),
          h('div', { class: 'grow' }, h('h3', { class: 'card__title' }, opt.changed ? 'Ton plan optimisé' : 'Rien à améliorer'), h('p', { class: 'card__sub' }, opt.changed ? `Trouvé en un clin d'œil, sous le seuil de ${CAFFEINE.bedThresholdMg} mg au coucher.` : 'Ta journée de référence est déjà très bien placée.')),
          opt.changed ? h('span', { class: 'lab-result__gain num' }, `${signed(opt.gainPct)} %`) : null),
        opt.changed ? h('ol', { class: 'lab-result__plan' }, ...items.map((i, k) => h('li', { class: `lab-step-chip lab-step-chip--${i.cls}`, style: { '--i': String(k) } }, h('span', { class: 'lab-step-chip__t num' }, fmtTime(i.t)), h('span', { class: 'lab-step-chip__b' }, icon(i.ico, { size: 15 }), i.txt)))) : null,
        h('ul', { class: 'lab-result__why' }, ...opt.explain.map((t, k) => h('li', { style: { '--i': String(k) } }, t))),
        opt.changed ? h('div', { class: 'lab-result__actions row row--wrap' },
          h('button', { class: 'btn btn--primary', type: 'button', disabled: !actionable.length, onclick: () => applyToAgenda(actionable) }, icon('calendar-check', { size: 18 }), 'Ajouter à mon agenda'),
          h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => copyPlan() }, icon('copy', { size: 18 }), 'Copier le plan'),
          h('button', { class: 'btn btn--ghost', type: 'button', disabled: !actionable.length, onclick: () => remind(actionable) }, icon('bell', { size: 18 }), 'Me le rappeler')) : null));
    }

    function applyToAgenda(items) {
      const created = items.map((i) => ctx.actions.addEvent({
        title: i.cls === 'nap' ? `Sieste · ${i.txt.split('· ')[1]}` : `${i.txt.replace(' · ', ' · ')}`,
        startMs: i.t, endMs: i.t + (i.cls === 'nap' ? 20 : 10) * MIN, source: 'manual',
      }));
      ctx.toast(`${created.length} rappel${created.length > 1 ? 's' : ''} ajouté${created.length > 1 ? 's' : ''} à ton agenda`, { kind: 'ok', undoLabel: 'Annuler', onUndo: () => created.forEach((e) => e && ctx.actions.removeEvent(e.id)) });
    }
    async function copyPlan() {
      const txt = planText(sc, { dayMs: dayMs(), optimized: opt });
      let ok = false;
      try { await navigator.clipboard.writeText(txt); ok = true; } catch {
        try { const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }); ta.value = txt; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch { ok = false; }
      }
      ctx.toast(ok ? 'Plan copié dans le presse-papiers' : 'Copie impossible ici : sélectionne le texte du plan à la main', { kind: ok ? 'ok' : 'warn' });
    }
    async function remind(items) {
      if (!('Notification' in window)) { ctx.toast('Ce navigateur ne gère pas les notifications. « Ajouter à mon agenda » fait le même travail.', { kind: 'warn' }); return; }
      let perm = Notification.permission; if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') { ctx.toast('Notifications refusées : utilise « Ajouter à mon agenda » à la place.', { kind: 'warn' }); return; }
      reminderTimers.forEach(clearTimeout); reminderTimers = [];
      const now = Date.now(), offset = ctx.nowMs() - now; let n = 0;
      for (const i of items) {
        const delay = i.t - offset - now - 5 * MIN; if (delay < 0 || delay > 14 * HOUR) continue; n++;
        reminderTimers.push(setTimeout(() => { try { new Notification('Kairos', { body: `Dans 5 min : ${i.txt} (${fmtTime(i.t)})`, tag: `kairos-lab-${i.t}` }); } catch { /* ignoré */ } }, delay));
      }
      ctx.toast(n ? `${n} rappel${n > 1 ? 's' : ''} programmé${n > 1 ? 's' : ''} (5 min avant), tant que Kairos reste ouvert` : 'Rien à programmer : ces moments sont déjà passés.', { kind: n ? 'ok' : 'warn' });
    }

    // -------------------------------------------------------------- horloge et état
    function onCtx() {
      if (disposed || busy) return;
      const wasDirty = isDirty();
      loadRef(!wasDirty);
      if (!wasDirty) { renderCafes(); renderRail(); syncControls(); }
      frameTitle(); recalc();
    }
    offs.push(ctx.subscribe(onCtx));

    // -------------------------------------------------------------- démarrage
    loadRef(true); renderCafes(); renderRail(); syncControls(); frameTitle(); recalc();
    // le premier recalcul est synchrone : le graphique s'anime à l'entrée via son intro
    return () => {
      disposed = true; cancelAnimationFrame(rafId); offs.forEach((o) => o()); if (ro) ro.disconnect(); if (chart) chart.destroy();
    };
  },
};
