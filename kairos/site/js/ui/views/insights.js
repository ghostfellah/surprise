// Vue « Bilan » : le tableau de bord de ta semaine et de ton modèle.
// Anneaux concentriques (focus, tâches, sommeil), « Ton modèle » avec calibration personnelle honnête (avant / après,
// confiance, R², n, refus poli sous 8 check-ins), graphique prédit vs ressenti, constats chiffrés, tendances,
// semaine en barres, série de jours et bilan partageable.
//
// Honnêteté : l'incertitude est affichée partout (n, confiance, « estimation, pas une mesure »). La calibration tourne
// dans un Worker (la validation croisée prend quelques secondes) avec repli sur le fil principal. Outil de confort et
// d'organisation, pas un dispositif médical.
import { h, svg, icon, replaceChildren, animateNumber, prefersReducedMotion, haptic, uniqueId, confetti } from '../dom.js';
import { calibrationChart, sparkline, barChart } from '../charts.js';
import { computeInsights, insightCards, personalizeFromState, weeklySummaryText } from '../../core/insights.js';
import { MIN, startOfDay, addDays, fmtDuration, fmtDateFR, clamp, MOIS_FR } from '../../core/time.js';
import { MIN_OBSERVATIONS } from '../../core/personalize.js';

const CSS = 'css/views-insights.css';

function ensureCss() {
  const href = new URL(CSS, document.baseURI).href;
  if (Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((l) => l.href === href)) return;
  const link = h('link', { rel: 'stylesheet', href: CSS });
  link.onerror = () => link.remove();
  document.head.appendChild(link);
}

const TAU = Math.PI * 2;
const fr1 = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
const durLabel = (min) => fmtDuration(Math.max(0, Math.round(min)));
const signed = (v, unit = '') => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fr1(Math.abs(v))}${unit}`;
const confLabel = (c) => (c < 0.15 ? 'trop faible' : c < 0.35 ? 'faible' : c < 0.6 ? 'correcte' : 'bonne');
const stopStyle = (v) => ({ style: `stop-color: var(${v})` });

// ---------------------------------------------------------------------------------------------
// Calibration dans un Worker (repli sur le fil principal)
// ---------------------------------------------------------------------------------------------
function runPersonalize(state, nowMs) {
  const slim = JSON.parse(JSON.stringify({ profile: state.profile, sleeps: state.sleeps, caffeine: state.caffeine, checkins: state.checkins }));
  return new Promise((resolve, reject) => {
    const local = () => setTimeout(() => { try { resolve(personalizeFromState(slim, nowMs)); } catch (e) { reject(e); } }, 80);
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') { local(); return; }
    let w; let url; let done = false; let timer = 0;
    const finish = (fn, v) => { if (done) return false; done = true; clearTimeout(timer); try { w.terminate(); URL.revokeObjectURL(url); } catch { /* ignoré */ } if (fn) fn(v); return true; };
    try {
      const mod = new URL('js/core/insights.js', document.baseURI).href;
      const src = `import { personalizeFromState } from ${JSON.stringify(mod)};\n`
        + 'self.onmessage = (e) => { try { self.postMessage({ ok: true, r: personalizeFromState(e.data.state, e.data.nowMs) }); } catch (err) { self.postMessage({ ok: false, e: String((err && err.message) || err) }); } };';
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      w = new Worker(url, { type: 'module' });
    } catch { local(); return; }
    timer = setTimeout(() => { if (finish(null)) local(); }, 40_000);
    w.onmessage = (e) => (e.data && e.data.ok ? finish(resolve, e.data.r) : finish(reject, new Error((e.data && e.data.e) || 'Calibration impossible')));
    w.onerror = () => { if (finish(null)) local(); };
    w.postMessage({ state: slim, nowMs });
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* repli ci-dessous */ }
  try {
    const ta = h('textarea', { value: text, readOnly: true, style: { position: 'fixed', opacity: '0', top: '0' } });
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Anneaux concentriques
// ---------------------------------------------------------------------------------------------
function triRings(I) {
  const specs = [
    { key: 'focus', r: 112, c1: '--sun-hot', c2: '--sun-deep', glow: '--sun-glow' },
    { key: 'tasks', r: 86, c1: '--ok', c2: '--load-1', glow: '--ok-soft' },
    { key: 'sleep', r: 60, c1: '--night-text', c2: '--night-deep', glow: '--night-glow' },
  ];
  const arcs = [];
  const defs = svg('defs');
  const els = specs.map((s, i) => {
    const id = uniqueId('tr');
    defs.appendChild(svg('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' }, svg('stop', { offset: '0', ...stopStyle(s.c1) }), svg('stop', { offset: '1', ...stopStyle(s.c2) })));
    const C = TAU * s.r;
    const track = svg('circle', { class: 'bl-ring__track', cx: 130, cy: 130, r: s.r, fill: 'none', 'stroke-width': 20 });
    const arc = svg('circle', { class: `bl-ring__arc bl-ring__arc--${s.key}`, cx: 130, cy: 130, r: s.r, fill: 'none', 'stroke-width': 20, 'stroke-linecap': 'round', stroke: `url(#${id})`,
      'stroke-dasharray': `${C} ${C}`, 'stroke-dashoffset': C, transform: 'rotate(-90 130 130)', style: `transition-delay:${i * 140}ms` });
    arcs.push({ arc, C, frac: I.rings[s.key].frac });
    return [track, arc];
  });
  const el = svg('svg', { class: 'bl-rings__svg', viewBox: '0 0 260 260', role: 'img',
    'aria-label': `Anneaux de la semaine : concentration ${Math.round(I.rings.focus.frac * 100)} % de l'objectif, tâches ${Math.round(I.rings.tasks.frac * 100)} %, sommeil ${Math.round(I.rings.sleep.frac * 100)} % du besoin.` }, defs, ...els.flat());
  requestAnimationFrame(() => requestAnimationFrame(() => { for (const a of arcs) a.arc.setAttribute('stroke-dashoffset', String(a.C * (1 - a.frac))); }));
  return el;
}

// ---------------------------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------------------------
export default {
  id: 'insights',
  title: 'Bilan',
  icon: 'chart',

  mount(root, ctx) {
    ensureCss();
    const reduce = prefersReducedMotion();
    let kills = [];
    const cleanups = [];
    const ui = { metric: 'focus', compare: 'after', calib: null /* {state:'running'|'done'|'error', r?, beforePoints?, prev?} */ };

    const page = h('div', { class: 'bl bl--enter' });
    root.appendChild(page);
    setTimeout(() => page.classList.remove('bl--enter'), 1800);
    const heroBox = h('section', { class: 'card card--hero bl-hero', style: { '--o': 0 }, 'aria-label': 'Ta semaine en un coup d\'œil' });
    const modelBox = h('section', { class: 'card bl-model', id: 'bl-model', style: { '--o': 1 }, 'aria-label': 'Ton modèle' });
    const cardsBox = h('section', { class: 'bl-cards', style: { '--o': 2 }, 'aria-label': 'Constats' });
    const trendBox = h('section', { class: 'card bl-trends', style: { '--o': 3 } });
    const weekBox = h('section', { class: 'card bl-week', style: { '--o': 4 } });
    const streakBox = h('section', { class: 'card bl-streak card--sun', style: { '--o': 5 } });
    const shareBox = h('section', { class: 'card bl-share', style: { '--o': 6 } });
    const colL = h('div', { class: 'bl-col' }, modelBox, cardsBox);
    const colR = h('div', { class: 'bl-col' }, trendBox, weekBox, streakBox, shareBox);
    page.append(heroBox, colL, colR);

    const killCharts = () => { for (const k of kills) { try { k(); } catch { /* déjà détruit */ } } kills = []; };
    const canvas = (label) => h('canvas', { role: 'img', 'aria-label': label });
    const head = (ico, title, sub, extra) => h('div', { class: 'card__head bl-head' },
      h('div', { class: 'row' }, h('span', { class: 'bl-head__ico' }, icon(ico, { size: 18 })), h('div', null, h('h2', { class: 'card__title' }, title), sub ? h('div', { class: 'card__sub' }, sub) : null)), extra || null);

    // ===========================================================================
    // HÉROS
    // ===========================================================================
    function renderHero(I) {
      const now = ctx.nowMs();
      const d0 = addDays(startOfDay(now), -6);
      const range = `${new Date(d0).getDate()} ${new Date(d0).getMonth() === new Date(now).getMonth() ? '' : MOIS_FR[new Date(d0).getMonth()].slice(0, 4) + '. '}→ ${new Date(now).getDate()} ${MOIS_FR[new Date(now).getMonth()]}`.replace(/\s+/g, ' ');
      if (!I.coverage.hasAnyData) {
        replaceChildren(heroBox, h('div', { class: 'empty bl-empty' },
          h('div', { class: 'empty__art' }, svg('svg', { viewBox: '0 0 112 112', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' },
            svg('g', { class: 'spin-slow' }, svg('circle', { cx: 56, cy: 56, r: 48, 'stroke-dasharray': '1 6' })), svg('circle', { cx: 56, cy: 56, r: 34, opacity: '.6' }), svg('circle', { cx: 56, cy: 56, r: 20, opacity: '.4' }),
            svg('path', { d: 'M56 56V30', 'stroke-width': 2.4 }))),
          h('div', { class: 'empty__title' }, 'Ton premier bilan arrive'),
          h('p', { class: 'empty__text' }, 'Note une nuit, un check-in ou une session de concentration : les anneaux, les tendances et les constats se construisent dès les premières données.'),
          h('div', { class: 'row row--center row--wrap' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => ctx.navigate('#/sleep') }, icon('moon', { size: 18 }), 'Noter ma nuit'),
            h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => ctx.navigate('#/today') }, icon('sun', { size: 18 }), 'Aller à Aujourd\'hui'))));
        return;
      }
      const R = I.rings;
      const score = Math.round(((R.focus.frac + R.tasks.frac + R.sleep.frac) / 3) * 100);
      const headline = score >= 80 ? 'Une semaine en grande forme' : score >= 60 ? 'Une semaine bien tenue' : score >= 40 ? 'Une semaine en demi-teinte' : 'Une semaine à rythme doux';
      const lever = [['la concentration', R.focus.frac], ['les tâches', R.tasks.frac], ['le sommeil', R.sleep.frac]].sort((a, b) => a[1] - b[1])[0];
      const sub = lever[1] >= 0.95 ? 'Les trois anneaux sont presque fermés : profite-en.' : `Ton meilleur levier : ${lever[0]} (${Math.round(lever[1] * 100)} % de l'objectif).`;
      const focusDelta = I.focus.min7 - I.focus.minPrev7;
      const sleepDelta = I.sleep.avgH7 !== null && I.sleep.avgHPrev7 !== null ? I.sleep.avgH7 - I.sleep.avgHPrev7 : null;
      const mkNum = () => h('b', { class: 'bl-leg__num num' }, '0');
      const nF = mkNum(); const nT = mkNum(); const nS = mkNum(); const nStreak = h('b', { class: 'bl-rings__streak num' }, '0'); const nScore = h('b', { class: 'bl-hero__score num' }, '0');
      const delta = (v, unit, goodUp = true) => (v === null || Math.abs(v) < 0.05 ? null : h('span', { class: 'bl-delta', 'data-good': String((v > 0) === goodUp) }, icon(v > 0 ? 'arrow-up' : 'arrow-down', { size: 12 }), signed(v, unit), ' vs sem. préc.'));
      const leg = (cls, label, num, unit, sub2, dl) => h('li', { class: `bl-leg bl-leg--${cls}` }, h('span', { class: 'bl-leg__dot' }),
        h('div', { class: 'bl-leg__main' }, h('span', { class: 'bl-leg__label' }, label), h('div', { class: 'bl-leg__val' }, num, h('span', { class: 'bl-leg__unit' }, unit)), h('span', { class: 'bl-leg__sub' }, sub2), dl));
      replaceChildren(heroBox,
        h('div', { class: 'bl-hero__copy' },
          h('div', { class: 'hero__eyebrow' }, `Semaine du ${range}`),
          h('h2', { class: 'hero__title bl-hero__title' }, headline),
          h('p', { class: 'lead' }, sub),
          h('div', { class: 'bl-hero__scorebox', 'data-tip': 'Moyenne de tes trois anneaux : un repère d\'organisation, pas une note de santé' }, nScore, h('span', null, '/ 100'), h('em', null, 'indice de la semaine')),
          h('ul', { class: 'bl-legs' },
            leg('focus', 'Concentration', nF, '', `objectif ${durLabel(R.focus.target)}`, delta(focusDelta, ' min')),
            leg('tasks', 'Tâches', nT, R.tasks.total ? ` / ${R.tasks.total}` : '', R.tasks.total ? 'terminées · à finir cette semaine' : 'terminées cette semaine', null),
            leg('sleep', 'Sommeil', nS, '', `besoin ${durLabel(I.sleep.needH * 60)} par nuit`, delta(sleepDelta, ' h')))),
        h('div', { class: 'bl-rings' }, triRings(I),
          h('div', { class: 'bl-rings__center' }, icon('flame', { size: 26, class: 'bl-flame' }), nStreak, h('span', { class: 'bl-rings__lbl' }, I.streak.days > 1 ? 'jours de suite' : 'jour'))));
      animateNumber(nF, I.focus.min7, { duration: 1300, format: (v) => durLabel(v) });
      animateNumber(nT, R.tasks.value, { duration: 1100 });
      animateNumber(nS, I.sleep.avgH7 ?? 0, { duration: 1300, format: (v) => (I.sleep.avgH7 === null ? '—' : durLabel(v * 60)) });
      animateNumber(nStreak, I.streak.days, { duration: 1100 });
      animateNumber(nScore, score, { duration: 1400 });
    }

    // ===========================================================================
    // TON MODÈLE
    // ===========================================================================
    async function calibrate(I) {
      if (ui.calib && ui.calib.state === 'running') return;
      const prev = { chronoShiftMin: ctx.state.profile.chronoShiftMin, sleepNeedH: ctx.state.profile.sleepNeedH, fit: ctx.state.profile.fit };
      ui.calib = { state: 'running', prev, beforePoints: I.accuracy.points };
      ui.compare = 'after';
      renderModel(I);
      const t0 = performance.now();
      let r = null; let err = null;
      try { r = await runPersonalize(ctx.state, ctx.nowMs()); } catch (e) { err = e; }
      const wait = 1500 - (performance.now() - t0); // laisse l'animation « je réfléchis » se jouer un instant
      if (wait > 0 && !reduce) await new Promise((res) => setTimeout(res, wait));
      if (!page.isConnected) return;
      if (err || !r) { ui.calib = { state: 'error', message: err ? err.message : 'inconnue' }; renderAll(); return; }
      ui.calib = { state: 'done', r, prev, beforePoints: ui.calib.beforePoints };
      if (r.applicable) {
        ctx.actions.setProfile({ ...r.profilePatch, fit: r.fit });
        haptic([10, 40, 20]);
        if (r.verdict === 'good') confetti(window.innerWidth / 2, window.innerHeight * 0.45, { count: 44 });
        ctx.toast('Ton modèle est calibré', { kind: 'ok', icon: 'sparkle', undoLabel: 'Annuler', onUndo: () => { ctx.actions.setProfile({ chronoShiftMin: prev.chronoShiftMin, sleepNeedH: prev.sleepNeedH, fit: prev.fit }); ui.calib = null; renderAll(); } });
      } else {
        ctx.toast(r.verdict === 'refused' ? 'Pas encore assez de check-ins' : 'Ajustement trop incertain : rien n\'a été modifié', { kind: 'warn' });
        renderAll();
      }
    }

    function resetFit() {
      const p = ctx.state.profile;
      const prev = { chronoShiftMin: p.chronoShiftMin, sleepNeedH: p.sleepNeedH, fit: p.fit };
      ctx.actions.setProfile({ chronoShiftMin: 0, fit: null });
      ui.calib = null;
      ctx.toast('Retour au modèle standard', { kind: 'warn', undoLabel: 'Annuler', onUndo: () => ctx.actions.setProfile(prev) });
    }

    function metricTile(label, value, unit, note) {
      return h('div', { class: 'bl-metric' }, h('span', { class: 'bl-metric__label' }, label), h('div', { class: 'bl-metric__val' }, h('b', { class: 'num' }, value), unit ? h('span', null, unit) : null), note ? h('span', { class: 'bl-metric__note' }, note) : null);
    }

    function renderModel(I) {
      const acc = I.accuracy;
      const prof = ctx.state.profile;
      const calib = ui.calib;
      const fit = prof.fit;
      const enough = acc.n >= MIN_OBSERVATIONS;
      const done = calib && calib.state === 'done' ? calib.r : null;

      // --- graphique de calibration
      const showBefore = done && ui.compare === 'before' && calib.beforePoints;
      const pts = showBefore ? calib.beforePoints : acc.points;
      const cv = canvas(`Calibration : ${acc.n} check-ins, prédit contre ressenti`);
      const chartWrap = h('div', { class: 'chart bl-model__chart' }, cv);

      // --- état courant du modèle
      const status = h('div', { class: 'bl-model__status' },
        h('span', { class: `chip ${fit && fit.confidence > 0 ? 'chip--night' : ''}` }, icon(fit && fit.confidence > 0 ? 'sparkle' : 'brain', { size: 14 }), fit && fit.confidence > 0 ? 'Calibré sur toi' : 'Modèle standard'),
        prof.chronoShiftMin ? h('span', { class: 'chip chip--sun' }, `Décalage ${signed(prof.chronoShiftMin, ' min')}`) : null);

      const metrics = h('div', { class: 'bl-metrics' },
        metricTile('Check-ins', String(acc.n), `/ ${MIN_OBSERVATIONS} min`, enough ? 'assez pour calibrer' : `encore ${acc.needed}`),
        metricTile('Écart typique', acc.rmse === null ? '—' : String(Math.round(acc.rmse)), 'pts', acc.baselineRmse === null ? 'prédit vs ressenti' : `contre ${Math.round(acc.baselineRmse)} en devinant ta moyenne`),
        metricTile('Corrélation', acc.r === null ? '—' : String(acc.r).replace('.', ','), '', acc.r === null ? '' : acc.r >= 0.7 ? 'forte' : acc.r >= 0.4 ? 'moyenne' : 'faible'),
        metricTile('Biais', acc.bias === null ? '—' : signed(acc.bias), 'pts', acc.bias === null ? '' : Math.abs(acc.bias) < 3 ? 'bien centré' : acc.bias > 0 ? 'tu te sens mieux que prévu' : 'tu te sens moins bien que prévu'));

      // --- zone d'action
      let action;
      if (calib && calib.state === 'running') {
        const msgs = ['Je rejoue tes 28 derniers jours…', 'Je décale ton horloge de −3 h à +3 h…', 'Je compare avec ton ressenti, check-in par check-in…', 'Je vérifie que ce n\'est pas du hasard (validation croisée)…'];
        const line = h('p', { class: 'bl-run__msg', 'aria-live': 'polite' }, msgs[0]);
        let i = 0; const iv = setInterval(() => { i = (i + 1) % msgs.length; if (!line.isConnected) { clearInterval(iv); return; } line.textContent = msgs[i]; }, 1500);
        kills.push(() => clearInterval(iv));
        action = h('div', { class: 'bl-run', role: 'status' }, h('div', { class: 'bl-run__orb', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), line,
          h('p', { class: 'hint' }, 'Quelques secondes : ça calcule en arrière-plan, l\'application reste fluide.'));
      } else if (calib && calib.state === 'error') {
        action = h('div', { class: 'banner banner--coral' }, icon('alert-circle', { size: 18 }), h('div', null, h('strong', null, 'La calibration a échoué. '), `Rien n'a été modifié (${calib.message}).`,
          h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn btn--sm btn--secondary', type: 'button', onclick: () => calibrate(I) }, icon('refresh', { size: 16 }), 'Réessayer'))));
      } else if (done) {
        action = renderResult(I, done, calib);
      } else {
        const btn = h('button', { class: 'btn btn--primary btn--lg bl-cta', type: 'button', disabled: !enough, onclick: () => calibrate(I) }, icon('wand', { size: 20 }), 'Calibrer sur mes check-ins');
        action = h('div', { class: 'bl-act' },
          enough ? h('p', { class: 'bl-act__text' }, fit && fit.confidence > 0
            ? `Dernier ajustement le ${fmtDateFR(fit.fittedMs, { short: true })} sur ${fit.n} check-ins (confiance ${Math.round(fit.confidence * 100)} %, écart ${Math.round(fit.rmse)} pts). Tu peux le refaire quand tu as de nouveaux check-ins.`
            : `Kairos peut décaler ton horloge interne pour mieux coller à tes ${acc.n} réponses. C'est une estimation : je te montre l'avant/après et la confiance.`)
            : h('div', { class: 'bl-need' }, h('p', { class: 'bl-act__text' }, `Il faut ${MIN_OBSERVATIONS} check-ins pour comparer prédiction et ressenti sans se raconter d'histoires. ${acc.n === 0 ? 'Réponds à « comment te sens-tu ? » trois fois par jour : ça prend dix secondes.' : `Encore ${acc.needed} et c'est bon.`}`),
              h('div', { class: 'progress', style: { '--pct': Math.round((acc.n / MIN_OBSERVATIONS) * 100) } }, h('div', { class: 'progress__bar' }))),
          btn,
          fit && fit.confidence > 0 ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: resetFit }, icon('undo', { size: 15 }), 'Revenir au modèle standard') : null);
      }

      replaceChildren(modelBox,
        head('brain', 'Ton modèle', 'Prédit contre ressenti, honnêtement', status),
        h('div', { class: 'bl-model__grid' },
          h('div', { class: 'bl-model__left' }, done && calib.beforePoints ? h('div', { class: 'seg bl-cmp', role: 'group', 'aria-label': 'Comparer avant et après' },
            h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': String(ui.compare === 'before'), onclick: () => { ui.compare = 'before'; renderModel(I); } }, 'Avant'),
            h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': String(ui.compare === 'after'), onclick: () => { ui.compare = 'after'; renderModel(I); } }, 'Après')) : null,
          chartWrap, h('p', { class: 'hint' }, 'Chaque point est un check-in : s\'il est sur la diagonale, le modèle avait raison. La ligne dorée résume la tendance par tranches.')),
          h('div', { class: 'bl-model__right' }, metrics, action)));
      const c = calibrationChart(cv, { points: pts, feltScale: 'percent', bins: 5, height: 300 });
      kills.push(() => c.destroy());
    }

    function renderResult(I, r, calib) {
      const ok = r.applicable;
      const bar = (label, rmse, max, cls) => h('div', { class: `bl-bar bl-bar--${cls}` }, h('span', { class: 'bl-bar__lbl' }, label),
        h('div', { class: 'bl-bar__track' }, h('i', { style: { '--w': `${clamp((rmse / max) * 100, 4, 100)}%` } })), h('b', { class: 'num' }, `${fr1(rmse)} pts`));
      const maxR = Math.max(r.before.rmse, r.after.rmse, 1) * 1.08;
      const cf = r.fit.confidence;
      const shift = r.values.chronoShiftMin;
      return h('div', { class: `bl-result bl-result--${r.verdict}` },
        h('div', { class: 'bl-result__head' },
          ok ? h('div', { class: 'bl-result__shift' }, h('span', { class: 'bl-result__lbl' }, 'Décalage trouvé'), h('b', { class: 'num' }, shift === 0 ? '0' : `${shift > 0 ? '+' : '−'}${Math.abs(shift)}`), h('span', { class: 'bl-result__unit' }, 'min'))
            : h('div', { class: 'bl-result__shift' }, h('span', { class: 'bl-result__lbl' }, r.verdict === 'refused' ? 'Pas assez de données' : 'Trop incertain'), icon(r.verdict === 'refused' ? 'info' : 'alert-circle', { size: 34, stroke: 1.4 })),
          h('p', { class: 'bl-result__reason' }, r.reason)),
        r.verdict !== 'refused' ? h('div', { class: 'bl-result__bars' }, bar('Avant', r.before.rmse, maxR, 'before'), bar('Après', r.after.rmse, maxR, 'after'),
          h('div', { class: 'bl-result__note' }, 'Écart typique entre prédit et ressenti : plus petit = meilleur.')) : null,
        r.verdict !== 'refused' ? h('div', { class: 'bl-conf' },
          h('div', { class: 'bl-conf__top' }, h('span', { class: 'label' }, 'Confiance'), h('b', { class: 'num' }, `${Math.round(cf * 100)} % · ${confLabel(cf)}`)),
          h('div', { class: 'bl-conf__meter', style: { '--pct': Math.round(cf * 100) }, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(cf * 100), 'aria-label': 'Confiance de l\'ajustement' }, h('i'), h('s', { style: { left: '15%' } }), h('s', { style: { left: '35%' } }), h('s', { style: { left: '60%' } })),
          h('dl', { class: 'bl-result__stats' },
            h('div', null, h('dt', null, 'R²'), h('dd', { class: 'num' }, `${fr1(r.fit.r2)}`.replace('-', '−'))),
            h('div', null, h('dt', null, 'n'), h('dd', { class: 'num' }, String(r.fit.n))),
            h('div', null, h('dt', null, 'Besoin de sommeil'), h('dd', { class: 'num' }, ok ? `${fr1(r.values.sleepNeedH)} h` : '—')),
            r.cv ? h('div', null, h('dt', null, 'Validation croisée'), h('dd', { class: 'num' }, `${Math.round(r.cv.rmse)} pts`)) : null)) : null,
        h('div', { class: 'row row--wrap bl-result__actions' },
          ok ? h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: () => { ctx.actions.setProfile({ chronoShiftMin: calib.prev.chronoShiftMin, sleepNeedH: calib.prev.sleepNeedH, fit: calib.prev.fit }); ui.calib = null; ctx.toast('Ajustement annulé', { kind: 'warn' }); } }, icon('undo', { size: 15 }), 'Annuler cet ajustement') : null,
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { ui.calib = null; renderAll(); } }, 'Fermer')),
        h('p', { class: 'hint' }, 'Une estimation sur quelques dizaines de réponses : elle bouge si ton sommeil change. Outil de confort, pas un dispositif médical.'));
    }

    // ===========================================================================
    // CONSTATS
    // ===========================================================================
    function renderCards(I) {
      const cards = insightCards(I);
      const levelLabel = { info: 'À savoir', conseil: 'Conseil', alerte: 'À surveiller' };
      replaceChildren(cardsBox,
        h('div', { class: 'bl-sectionhead' }, h('h2', { class: 'h3' }, 'Ce que Kairos remarque'), h('span', { class: 'eyebrow' }, `${cards.length} constats · triés par impact`)),
        h('div', { class: 'bl-cardgrid' }, cards.map((c, i) => h('article', { class: `bl-card bl-card--${c.level}`, style: { '--i': i } },
          h('div', { class: 'bl-card__top' }, h('span', { class: 'bl-card__ico' }, icon(c.icon || 'sparkle', { size: 20 })), h('span', { class: 'bl-card__lvl' }, levelLabel[c.level]),
            c.stat ? h('div', { class: 'bl-card__stat', 'aria-hidden': 'true' }, h('b', { class: 'num' }, c.stat.value), c.stat.unit ? h('span', null, c.stat.unit) : null, c.stat.label ? h('em', null, c.stat.label) : null) : null),
          h('h3', { class: 'bl-card__title' }, c.title),
          h('p', { class: 'bl-card__text' }, c.text),
          c.action ? h('button', { class: 'btn btn--ghost btn--sm bl-card__act', type: 'button', onclick: () => { if (c.action.hash === '#/insights') { modelBox.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); } else ctx.navigate(c.action.hash); } }, c.action.label, icon('arrow-right', { size: 15 })) : null))));
    }

    // ===========================================================================
    // TENDANCES, SEMAINE, SÉRIE, PARTAGE
    // ===========================================================================
    function renderTrends(I) {
      const T = I.trends;
      const defs = [
        { key: 'sleepH', label: 'Sommeil', ico: 'moon', color: 'night', fmt: (v) => (v === null ? '—' : durLabel(v * 60)), unitDelta: ' h', good: true },
        { key: 'focusMin', label: 'Concentration', ico: 'target', color: 'sun', fmt: (v) => durLabel(v), unitDelta: ' min', good: true },
        { key: 'caffeineMg', label: 'Caféine', ico: 'coffee', color: 'coral', fmt: (v) => (v === null ? '—' : `${Math.round(v)} mg/j`), unitDelta: ' mg', good: false },
        { key: 'felt', label: 'Ressenti moyen', ico: 'heart', color: 'night', fmt: (v) => (v === null ? '—' : `${fr1(v)} / 5`), unitDelta: '', good: true },
      ];
      const tiles = defs.map((d) => {
        const t = T[d.key]; const cv = canvas(`Tendance ${d.label} sur 14 jours`);
        const ok = t.delta === null || Math.abs(t.delta) < 0.05 ? null : (t.delta > 0) === d.good;
        const tile = h('div', { class: 'bl-tile' }, h('div', { class: 'bl-tile__top' }, h('span', { class: 'bl-tile__ico' }, icon(d.ico, { size: 16 })), h('span', { class: 'bl-tile__label' }, d.label)),
          h('b', { class: 'bl-tile__val num' }, d.fmt(t.now)),
          t.delta !== null && Math.abs(t.delta) >= 0.05 ? h('span', { class: 'bl-delta', 'data-good': String(ok) }, icon(t.delta > 0 ? 'arrow-up' : 'arrow-down', { size: 12 }), signed(Math.round(t.delta * 10) / 10, d.unitDelta)) : h('span', { class: 'bl-delta bl-delta--flat' }, 'stable'),
          h('div', { class: 'chart bl-tile__spark' }, cv));
        const vals = t.series.map((v) => (v === null ? NaN : v));
        queueMicrotask(() => { const filled = []; let lastV = null; vals.forEach((v) => { if (Number.isFinite(v)) { lastV = v; filled.push(v); } else if (lastV !== null) filled.push(lastV); }); const sp = sparkline(cv, { values: filled.length >= 2 ? filled : [0, 0], color: d.color, height: 46 }); kills.push(() => sp.destroy()); });
        return tile;
      });
      replaceChildren(trendBox, head('chart-line', 'Tendances', '14 derniers jours, trait = valeur du jour'), h('div', { class: 'bl-tiles' }, tiles));
    }

    const METRICS = {
      focus: { label: 'Focus', color: 'sun', unit: 'h', fmt: (v) => fr1(v), pick: (d) => d.focusMin / 60, total: (a) => durLabel(a.reduce((s, v) => s + v, 0) * 60), note: 'Heures de concentration par jour' },
      sleep: { label: 'Sommeil', color: 'night', unit: 'h', fmt: (v) => fr1(v), pick: (d) => d.sleepH ?? 0, total: (a) => { const n = a.filter((v) => v > 0); return n.length ? `${fr1(n.reduce((s, v) => s + v, 0) / n.length)} h en moyenne` : '—'; } },
      caffeine: { label: 'Caféine', color: 'coral', unit: 'mg', fmt: (v) => String(Math.round(v)), pick: (d) => d.caffeineMg ?? 0, total: (a) => { const n = a.filter((v) => v > 0); return n.length ? `${Math.round(n.reduce((s, v) => s + v, 0) / n.length)} mg/jour en moyenne` : '—'; } },
      tasks: { label: 'Tâches', color: 'sun', unit: '', fmt: (v) => String(Math.round(v)), pick: (d) => d.tasksDone, total: (a) => { const t = a.reduce((s, v) => s + v, 0); return `${t} terminée${t > 1 ? 's' : ''}`; } },
    };
    function renderWeek(I) {
      const m = METRICS[ui.metric];
      const vals = I.week.map(m.pick);
      const cv = canvas(`Semaine : ${m.label} par jour`);
      const seg = h('div', { class: 'seg bl-seg', role: 'group', 'aria-label': 'Choisir la mesure' }, Object.entries(METRICS).map(([k, v]) => h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': String(ui.metric === k), onclick: () => { ui.metric = k; haptic(4); renderWeek(I); } }, v.label)));
      replaceChildren(weekBox, head('calendar', 'La semaine en un coup d\'œil', null), seg,
        h('div', { class: 'bl-week__sum' }, h('b', { class: 'num' }, m.total(vals)), h('span', null, '7 derniers jours')), h('div', { class: 'chart bl-week__chart' }, cv));
      const target = ui.metric === 'sleep' ? I.sleep.needH : ui.metric === 'focus' ? I.rings.focus.target / 5 / 60 : undefined;
      const c = barChart(cv, { values: vals, labels: I.week.map((d) => d.label), color: m.color, format: m.fmt, height: 200, target, targetLabel: ui.metric === 'sleep' ? 'besoin' : ui.metric === 'focus' ? 'objectif/jour' : undefined });
      kills.push(() => c.destroy());
    }

    function renderStreak(I) {
      const S = I.streak;
      const n = h('b', { class: 'bl-streak__num num' }, '0');
      const today = S.active28.length - 1;
      const cells = S.active28.map((a, i) => h('i', { class: 'bl-dayc', 'data-on': a ? '1' : '0', 'data-today': i === today ? '1' : null, style: { '--i': i }, title: fmtDateFR(addDays(startOfDay(ctx.nowMs()), i - today), { short: true }) + (a ? ' · actif' : '') }));
      replaceChildren(streakBox, head('flame', 'Ta série', 'Jours avec au moins 20 min de focus ou une tâche terminée'),
        h('div', { class: 'bl-streak__top' }, h('div', { class: 'bl-streak__flame', 'aria-hidden': 'true' }, icon('flame', { size: 46, stroke: 1.4 })), h('div', null, n, h('span', { class: 'bl-streak__unit' }, S.days > 1 ? 'jours d\'affilée' : 'jour d\'affilée')),
          h('div', { class: 'bl-streak__best' }, h('span', { class: 'eyebrow' }, 'Meilleure série'), h('b', { class: 'num' }, `${S.best} j`))),
        h('div', { class: 'bl-days', role: 'img', 'aria-label': `${S.active28.filter(Boolean).length} jours actifs sur 28` }, cells),
        h('div', { class: 'bl-days__legend' }, h('span', null, 'il y a 28 jours'), h('span', null, 'aujourd\'hui')));
      animateNumber(n, S.days, { duration: 1000 });
    }

    function renderShare(I) {
      const text = weeklySummaryText(I, insightCards(I), ctx.nowMs());
      const pre = h('pre', { class: 'bl-share__txt', tabindex: 0, 'aria-label': 'Texte du bilan' }, text);
      const copy = h('button', { class: 'btn btn--primary', type: 'button', onclick: async (e) => {
        const ok = await copyText(text);
        ctx.toast(ok ? 'Bilan copié, prêt à coller' : 'Copie impossible : sélectionne le texte à la main', { kind: ok ? 'ok' : 'warn', icon: ok ? 'copy' : 'alert' });
        if (ok) { haptic(8); const r = e.currentTarget.getBoundingClientRect(); confetti(r.left + r.width / 2, r.top, { count: 22, spread: .6 }); }
      } }, icon('copy', { size: 18 }), 'Copier le bilan');
      const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
      replaceChildren(shareBox, head('share', 'Bilan à partager', 'Texte simple, sans aucune donnée brute'), pre,
        h('div', { class: 'row row--wrap' }, copy, canShare ? h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => { navigator.share({ title: 'Mon bilan Kairos', text }).catch(() => {}); } }, icon('upload', { size: 18 }), 'Partager') : null));
    }

    // ===========================================================================
    // Orchestration
    // ===========================================================================
    let I = null;
    function renderAll() {
      killCharts();
      try { I = computeInsights(ctx.state, ctx.nowMs()); } catch (e) { console.error(e); replaceChildren(heroBox, h('div', { class: 'banner banner--coral' }, 'Le bilan n\'a pas pu être calculé : ' + e.message)); return; }
      renderHero(I); renderModel(I); renderCards(I); renderTrends(I); renderWeek(I); renderStreak(I); renderShare(I);
    }
    renderAll();

    let lastDay = startOfDay(ctx.nowMs());
    cleanups.push(ctx.subscribe((_st, change) => {
      const t = change && change.type;
      if (t === 'tick') { if (startOfDay(ctx.nowMs()) !== lastDay) { lastDay = startOfDay(ctx.nowMs()); renderAll(); } return; }
      if (ui.calib && ui.calib.state === 'running') return; // pas de redessin pendant le calcul
      renderAll();
    }));
    void MIN;
    return () => { killCharts(); for (const c of cleanups) { try { c(); } catch { /* ignoré */ } } };
  },
};
