// Graphiques canvas 2D de Kairos : haute densité de pixels, thème lu dans les variables CSS à chaque
// rendu, accessibles (role="img" + description générée), animations sobres (désactivées si
// prefers-reduced-motion). Zéro dépendance ; seules les fonctions pures (échelles, graduations,
// splines monotones, extrema, couloirs) sont testées en Node — le dessin n'est utilisé que dans le navigateur.
import { MIN, HOUR, DAY, startOfDay, fmtTime, JOURS_FR, clamp, lerp } from '../core/time.js';

// ===========================================================================
// 1. Fonctions pures
// ===========================================================================
export const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a || 1)); return t * t * (3 - 2 * t); };
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const pad2 = (n) => String(n).padStart(2, '0');

/** Échelle linéaire d0..d1 -> r0..r1 avec `.invert`. */
export function linearScale(d0, d1, r0, r1) {
  const k = (r1 - r0) / ((d1 - d0) || 1);
  const f = (v) => r0 + (v - d0) * k;
  f.invert = (p) => d0 + (p - r0) / k;
  f.domain = [d0, d1]; f.range = [r0, r1];
  return f;
}

/** Nombre « rond » le plus proche (algorithme de Heckbert). */
export function niceNum(range, round) {
  if (!(range > 0)) return 1;
  const exp = Math.floor(Math.log10(range)), f = range / Math.pow(10, exp);
  const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
  return nf * Math.pow(10, exp);
}

/** Graduations « rondes » couvrant [min, max]. */
export function niceTicks(min, max, count = 5) {
  if (!(max > min)) { max = min + 1; }
  const step = niceNum(niceNum(max - min, false) / Math.max(1, count - 1), true);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, min: lo, max: hi, step };
}

/** Interpolation linéaire d'une série échantillonnée (t0, stepMin) à l'instant ms, bornée. */
export function seriesAt(series, t0, stepMin, ms) {
  if (!series || !series.length) return NaN;
  const x = clamp((ms - t0) / (stepMin * MIN), 0, series.length - 1);
  const i = Math.floor(x), j = Math.min(series.length - 1, i + 1);
  return series[i] + (series[j] - series[i]) * (x - i);
}

/** Tangentes de Fritsch–Carlson : spline cubique monotone (pas de dépassement). */
export function monotoneTangents(xs, ys) {
  const n = xs.length; if (n < 2) return new Array(n).fill(0);
  const m = new Array(n - 1), t = new Array(n);
  for (let i = 0; i < n - 1; i++) m[i] = (ys[i + 1] - ys[i]) / ((xs[i + 1] - xs[i]) || 1e-9);
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); t[i] = tau * a * m[i]; t[i + 1] = tau * b * m[i]; }
  }
  return t;
}

/** Segments de Bézier [c1x,c1y,c2x,c2y,x,y] d'une spline monotone passant par les points. */
export function monotoneSegments(xs, ys) {
  const t = monotoneTangents(xs, ys), segs = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    segs.push([xs[i] + dx, ys[i] + t[i] * dx, xs[i + 1] - dx, ys[i + 1] - t[i + 1] * dx, xs[i + 1], ys[i + 1]]);
  }
  return segs;
}

/** Trace la spline monotone dans le chemin courant de `ctx` (lineTo si `move` = false). */
export function traceMonotone(ctx, xs, ys, move = true) {
  if (!xs.length) return;
  move ? ctx.moveTo(xs[0], ys[0]) : ctx.lineTo(xs[0], ys[0]);
  for (const s of monotoneSegments(xs, ys)) ctx.bezierCurveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
}

/** Réduit (xs, ys) à ~maxPts points par pas régulier, en conservant le dernier. */
export function decimate(xs, ys, maxPts) {
  const n = xs.length; if (n <= maxPts) return { xs, ys };
  const step = Math.ceil(n / maxPts), ox = [], oy = [];
  for (let i = 0; i < n; i += step) { ox.push(xs[i]); oy.push(ys[i]); }
  if (ox[ox.length - 1] !== xs[n - 1]) { ox.push(xs[n - 1]); oy.push(ys[n - 1]); }
  return { xs: ox, ys: oy };
}

/** Graduations d'heures locales : {ms, label, major}. Au-delà de 40 h : graduations par jour. */
export function timeTicks(startMs, endMs, widthPx, minGapPx = 46) {
  const span = endMs - startMs, out = [];
  if (!(span > 0) || !(widthPx > 0)) return out;
  if (span <= 40 * HOUR) {
    const steps = [1, 2, 3, 4, 6, 12];
    const step = steps.find((s) => (s * HOUR / span) * widthPx >= minGapPx) || 12;
    let d = new Date(startOfDay(startMs));
    for (let guard = 0; guard < 4 && d.getTime() <= endMs; guard++) {
      for (let hh = 0; hh < 24; hh += step) {
        const ms = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh).getTime();
        if (ms < startMs || ms > endMs) continue;
        const dd = new Date(ms);
        out.push({ ms, major: hh === 0, label: hh === 0 ? `${JOURS_FR[dd.getDay()].slice(0, 3)}. ${dd.getDate()}` : `${pad2(hh)}:00` });
      }
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
    return out;
  }
  const days = span / DAY, steps = [1, 2, 3, 7, 14];
  const step = steps.find((s) => (s / days) * widthPx >= minGapPx * 1.2) || 14;
  let d = new Date(startOfDay(startMs)); if (d.getTime() < startMs) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  for (let k = 0; d.getTime() <= endMs && k < 400; k++) {
    if (k % step === 0) out.push({ ms: d.getTime(), major: d.getDay() === 1, label: `${JOURS_FR[d.getDay()].slice(0, 3)}. ${d.getDate()}` });
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return out;
}

/** Affecte un couloir à chaque intervalle {startMs,endMs} (premier couloir libre) ; max `maxLanes`. */
export function assignLanes(items, maxLanes = 3) {
  const order = items.map((it, i) => i).sort((a, b) => items[a].startMs - items[b].startMs || items[a].endMs - items[b].endMs);
  const ends = [], lanes = new Array(items.length).fill(0);
  for (const i of order) {
    let l = ends.findIndex((e) => e <= items[i].startMs);
    if (l < 0) l = ends.length < maxLanes ? ends.length : maxLanes - 1;
    ends[l] = Math.max(ends[l] || 0, items[i].endMs); lanes[i] = l;
  }
  return { lanes, count: ends.length };
}

const LANE = { event: 12, block: 20, gap: 3, top: 8 };
/** Hauteur occupée sous la courbe par les bandes d'événements / de tâches. */
export function lanesHeight(eventLanes, blockLanes) {
  let h = 0;
  if (eventLanes) h += eventLanes * (LANE.event + LANE.gap);
  if (blockLanes) h += blockLanes * (LANE.block + LANE.gap);
  return h ? h + LANE.top : 0;
}

/** Géométrie de l'alertnessChart (px CSS). */
export function chartLayout(w, h, { showCaffeine = true, eventLanes = 0, blockLanes = 0 } = {}) {
  const small = w < 520;
  const x0 = small ? 30 : 38, x1 = w - (showCaffeine ? (small ? 32 : 42) : (small ? 12 : 18));
  const axisH = 24, y0 = 30, lh = lanesHeight(eventLanes, blockLanes);
  const y1 = Math.max(y0 + 60, h - axisH - lh - 4);
  const lanesTop = y1 + LANE.top;
  return { x0, x1, y0, y1, axisH, axisTop: h - axisH, lanesTop, eventsTop: lanesTop, blocksTop: lanesTop + (eventLanes ? eventLanes * (LANE.event + LANE.gap) : 0), small };
}

/** Pic et creux d'alerte dans [a, b] en ignorant l'inertie du réveil et l'endormissement. */
export function findExtrema(model, range) {
  const { t0, stepMin, alert, asleep } = model, n = alert.length;
  const [a, b] = range || [t0, t0 + (n - 1) * stepMin * MIN];
  const idx = (ms) => clamp(Math.round((ms - t0) / (stepMin * MIN)), 0, n - 1);
  const i0 = idx(a), i1 = idx(b), headSkip = Math.ceil(90 / stepMin), tailSkip = Math.ceil(45 / stepMin);
  let peak = null, trough = null, i = i0;
  const consider = (lo, hi) => {
    for (let k = lo; k <= hi; k++) {
      const v = alert[k];
      if (!peak || v > peak.value) peak = { i: k, ms: t0 + k * stepMin * MIN, value: v };
      if (!trough || v < trough.value) trough = { i: k, ms: t0 + k * stepMin * MIN, value: v };
    }
  };
  while (i <= i1) {
    if (asleep && asleep[i]) { i++; continue; }
    let j = i; while (j + 1 <= i1 && !(asleep && asleep[j + 1])) j++;
    const afterSleep = i > 0 && asleep && asleep[i - 1], beforeSleep = j < n - 1 && asleep && asleep[j + 1];
    let lo = afterSleep ? i + headSkip : i, hi = beforeSleep ? j - tailSkip : j;
    if (lo > hi) { lo = i; hi = j; }
    consider(lo, hi); i = j + 1;
  }
  return { peak, trough };
}

/** Données du survol à l'instant ms (pur, testable). */
export function probeAt(ms, { model, compareModel, blocks = [], events = [], tasks = [] }) {
  const { t0, stepMin } = model, k = clamp(Math.round((ms - t0) / (stepMin * MIN)), 0, model.alert.length - 1);
  const block = blocks.find((b) => ms >= b.startMs && ms < b.endMs) || null;
  const task = block ? tasks.find((t) => t.id === block.taskId) || null : null;
  const event = events.find((e) => ms >= e.startMs && ms < e.endMs) || null;
  return {
    ms, alert: seriesAt(model.alert, t0, stepMin, ms), base: model.alertBase ? seriesAt(model.alertBase, t0, stepMin, ms) : NaN,
    caffeineMg: model.caffeineMg ? seriesAt(model.caffeineMg, t0, stepMin, ms) : 0, asleep: !!(model.asleep && model.asleep[k]),
    compare: compareModel ? seriesAt(compareModel.alert, compareModel.t0, compareModel.stepMin, ms) : NaN, block, task, event,
  };
}

/** Description textuelle (aria-label) : « Pic à 10:20 (86/100), creux à 14:40 (41/100) ». */
export function describeAlertness(model, { range, blocks = [], tasks = [], events = [], compareModel } = {}) {
  if (!model || !model.alert || !model.alert.length) return 'Courbe d\'alerte indisponible.';
  const n = model.alert.length, r = range || [model.t0, model.t0 + (n - 1) * model.stepMin * MIN];
  const { peak, trough } = findExtrema(model, r);
  const parts = [`Courbe d'alerte prédite de ${fmtTime(r[0])} à ${fmtTime(r[1])}.`];
  if (peak && trough) parts.push(`Pic à ${fmtTime(peak.ms)} (${Math.round(peak.value)}/100), creux à ${fmtTime(trough.ms)} (${Math.round(trough.value)}/100).`);
  const gold = (model.zones || []).filter((z) => z.kind === 'golden' && z.endMs > r[0] && z.startMs < r[1]);
  if (gold.length) parts.push(`Fenêtres d'or : ${gold.map((z) => `${fmtTime(z.startMs)}–${fmtTime(z.endMs)}`).join(', ')}.`);
  const bl = blocks.filter((b) => b.endMs > r[0] && b.startMs < r[1]);
  if (bl.length) parts.push(`${bl.length} bloc${bl.length > 1 ? 's' : ''} de tâches planifié${bl.length > 1 ? 's' : ''}${bl.length <= 4 ? ` : ${bl.map((b) => `${(tasks.find((t) => t.id === b.taskId) || {}).title || 'tâche'} à ${fmtTime(b.startMs)}`).join(', ')}` : ''}.`);
  const ev = events.filter((e) => e.endMs > r[0] && e.startMs < r[1]);
  if (ev.length) parts.push(`${ev.length} événement${ev.length > 1 ? 's' : ''} fixe${ev.length > 1 ? 's' : ''}.`);
  if (compareModel) parts.push('Une courbe de comparaison est affichée en pointillés.');
  return parts.join(' ');
}

/** Statistiques de calibration prédit/ressenti (valeurs 0..100). */
export function calibrationStats(points) {
  const p = points.filter((q) => Number.isFinite(q.predicted) && Number.isFinite(q.felt)), n = p.length;
  if (!n) return { n: 0, rmse: NaN, bias: NaN, r: NaN, slope: NaN, intercept: NaN };
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, se = 0, sb = 0;
  for (const q of p) { sx += q.predicted; sy += q.felt; sxx += q.predicted ** 2; syy += q.felt ** 2; sxy += q.predicted * q.felt; se += (q.predicted - q.felt) ** 2; sb += q.felt - q.predicted; }
  const vx = sxx - sx * sx / n, vy = syy - sy * sy / n, cxy = sxy - sx * sy / n;
  const slope = vx > 1e-9 ? cxy / vx : NaN;
  return { n, rmse: Math.sqrt(se / n), bias: sb / n, r: vx > 1e-9 && vy > 1e-9 ? cxy / Math.sqrt(vx * vy) : NaN, slope, intercept: Number.isFinite(slope) ? sy / n - slope * sx / n : NaN };
}

// --- Couleurs ---------------------------------------------------------------
export function parseColor(s) {
  s = String(s || '').trim();
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/i.exec(s))) {
    let h = m[1]; if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x)));
    return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? (String(m[1]).includes('%') && p[3] > 1 ? p[3] / 2.55 : p[3]) : 1];
  }
  return [128, 128, 128, 1];
}
/** Chaîne CSS rgba() d'une couleur parsée avec un alpha multiplicatif. */
export const rgba = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${+(c[3] * a).toFixed(3)})`;
export const mixColors = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
export const luminance = (c) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
/** Couleur de texte (claire ou sombre) lisible sur `bg`. */
export const pickInk = (bg, light = [255, 255, 255, 1], dark = [10, 13, 19, 1]) => (luminance(bg) > .36 ? dark : light);
/** Couleur d'une rampe (liste de couleurs parsées équi-réparties) à t ∈ [0,1]. */
export function rampColor(stops, t) {
  t = clamp01(t); const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x));
  return mixColors(stops[i], stops[i + 1], x - i);
}

const FALLBACK = { bg: '#060910', surface: '#0f1623', 'surface-2': '#151e2f', 'surface-3': '#1e2940', text: '#f0ebdd', 'text-2': '#b1b5bd', 'text-3': '#7e8795', line: 'rgba(255,255,255,.075)', 'line-strong': 'rgba(255,255,255,.17)',
  sun: '#f7b93e', 'sun-hot': '#ffe190', 'sun-deep': '#e9822a', night: '#38c0b3', 'night-deep': '#127e86', coral: '#ff6e5c', caffeine: '#dba17a', dip: '#7f90c0', ok: '#86d28a', 'sun-ink': '#1c1303',
  'load-1': '#4fc1b0', 'load-2': '#97cf8f', 'load-3': '#f2c45e', 'load-4': '#f0894a', 'load-5': '#ea5a52' };

/** Lit les variables CSS du thème courant sur l'élément (hérité du thème clair/sombre). */
export function readTheme(el) {
  const cs = typeof getComputedStyle === 'function' && el ? getComputedStyle(el) : null;
  const v = (name) => parseColor((cs && cs.getPropertyValue(`--${name}`).trim()) || FALLBACK[name]);
  const font = (name, fb) => (cs && cs.getPropertyValue(name).trim()) || fb;
  const th = {};
  for (const k of Object.keys(FALLBACK)) th[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v(k);
  th.load = [1, 2, 3, 4, 5].map((i) => th[`load${i}`]);
  th.isDark = luminance(th.bg) < .25;
  th.fontSans = font('--font-sans', 'system-ui, sans-serif'); th.fontMono = font('--font-mono', 'ui-monospace, monospace'); th.fontSerif = font('--font-serif', 'Georgia, serif');
  return th;
}

// ===========================================================================
// 2. Surface canvas : DPR, ResizeObserver, thème, boucle d'animation
// ===========================================================================
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function createSurface(canvas, { getHeight, resized, draw, loop, label, interactive = false }) {
  const ctx = canvas.getContext('2d');
  const S = { ctx, w: 0, h: 0, dpr: 1, theme: readTheme(canvas), t: 0, dt: 0, visible: true, canvas };
  let raf = 0, dirty = true, destroyed = false, last = 0, lastDraw = 0;
  if (!canvas.style.width) canvas.style.width = '100%';
  canvas.style.display = 'block';
  if (label !== false) canvas.setAttribute('role', 'img');
  if (interactive) canvas.setAttribute('tabindex', '0');

  const schedule = () => { if (!raf && !destroyed) raf = requestAnimationFrame(tick); };
  const invalidate = () => { dirty = true; schedule(); };
  const measure = () => {
    const r = canvas.getBoundingClientRect(); const w = Math.max(1, Math.round(r.width));
    const hh = getHeight ? getHeight(w) : (canvas.dataset.height ? +canvas.dataset.height : r.height || 160);
    if (getHeight || canvas.dataset.height) canvas.style.height = `${Math.round(hh)}px`;
    const dpr = Math.min(3, window.devicePixelRatio || 1), h = Math.max(1, Math.round(hh));
    if (w === S.w && h === S.h && dpr === S.dpr) return;
    S.w = w; S.h = h; S.dpr = dpr; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    S.theme = readTheme(canvas); if (resized) resized(S); invalidate();
  };
  const tick = (ts) => {
    raf = 0; if (destroyed) return;
    S.dt = last ? Math.min(.05, (ts - last) / 1000) : 0; last = ts; S.t = ts;
    const mode = loop ? loop(S) : 0; // 0 = repos, 1 = pleine cadence, 2 = cadence réduite (ambiance)
    if (!dirty && mode === 2 && ts - lastDraw < 32) { schedule(); return; }
    if (dirty || mode) {
      dirty = false; lastDraw = ts;
      ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); ctx.clearRect(0, 0, S.w, S.h);
      draw(ctx, S);
    }
    if (mode && S.visible && !document.hidden) schedule(); else last = 0;
  };
  const refreshTheme = () => { S.theme = readTheme(canvas); if (resized) resized(S, true); invalidate(); };

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null; ro && ro.observe(canvas);
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { S.visible = es[es.length - 1].isIntersecting; if (S.visible) invalidate(); }) : null; io && io.observe(canvas);
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(refreshTheme) : null;
  mo && mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  mq && mq.addEventListener && mq.addEventListener('change', refreshTheme);
  const vis = () => { if (!document.hidden) invalidate(); }; document.addEventListener('visibilitychange', vis);
  measure(); schedule();

  return {
    S, invalidate, measure, refreshTheme,
    destroy() { destroyed = true; cancelAnimationFrame(raf); ro && ro.disconnect(); io && io.disconnect(); mo && mo.disconnect(); mq && mq.removeEventListener && mq.removeEventListener('change', refreshTheme); document.removeEventListener('visibilitychange', vis); },
  };
}

const roundRect = (g, x, y, w, h, r) => { r = Math.max(0, Math.min(r, w / 2, h / 2)); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
const setLS = (g, v) => { if ('letterSpacing' in g) g.letterSpacing = v; };

/** Info-bulle dessinée sur le canvas : lines = [{dot?, sq?, text, value?, muted?, bold?}]. */
function drawTooltip(g, th, anchorX, anchorY, lines, bounds) {
  g.save();
  const pad = 11, lh = 19, font = `500 12px ${th.fontSans}`, mono = `600 12px ${th.fontMono}`;
  let wMax = 0;
  for (const l of lines) {
    g.font = l.bold ? `700 13px ${th.fontMono}` : font; const a = g.measureText(l.text).width;
    g.font = mono; const b = l.value ? g.measureText(l.value).width + 18 : 0;
    wMax = Math.max(wMax, a + b + (l.dot || l.sq ? 16 : 0));
  }
  const w = Math.min(bounds.w - 8, Math.ceil(wMax + pad * 2)), hh = lines.length * lh + pad * 2 - 4;
  let x = anchorX + 16; if (x + w > bounds.w - 4) x = anchorX - 16 - w; x = clamp(x, 4, bounds.w - w - 4);
  let y = anchorY - hh - 14; if (y < 4) y = Math.min(bounds.h - hh - 4, anchorY + 18); y = Math.max(4, y);
  g.shadowColor = 'rgba(0,0,0,.4)'; g.shadowBlur = 22; g.shadowOffsetY = 8;
  roundRect(g, x, y, w, hh, 12); g.fillStyle = rgba(th.surface2, .96); g.fill();
  g.shadowColor = 'transparent'; g.lineWidth = 1; g.strokeStyle = rgba(th.lineStrong, 1); g.stroke();
  lines.forEach((l, i) => {
    const cy = y + pad - 2 + i * lh + lh / 2; let tx = x + pad;
    if (l.dot) { g.beginPath(); g.arc(tx + 4, cy, 3.5, 0, 7); g.fillStyle = rgba(l.dot, 1); g.fill(); tx += 16; }
    if (l.sq) { roundRect(g, tx, cy - 5, 10, 10, 3); g.fillStyle = rgba(l.sq, 1); g.fill(); tx += 16; }
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.font = l.bold ? `700 13px ${th.fontMono}` : font; g.fillStyle = rgba(l.muted ? th.text3 : l.bold ? th.text : th.text2, 1);
    let txt = l.text; const room = w - pad * 2 - (tx - x - pad) - (l.value ? g.measureText(l.value).width + 18 : 0);
    while (txt.length > 3 && g.measureText(txt).width > room) txt = txt.slice(0, -2);
    if (txt !== l.text) txt += '…';
    g.fillText(txt, tx, cy);
    if (l.value) { g.font = mono; g.textAlign = 'right'; g.fillStyle = rgba(th.text, 1); g.fillText(l.value, x + w - pad, cy); }
  });
  g.restore();
}

// ===========================================================================
// 3. alertnessChart — la pièce maîtresse
// ===========================================================================
/**
 * alertnessChart(canvas, { model, compareModel?, nowMs, blocks?, events?, tasks?, hoverMs?, onScrub?, onScrubEnd?,
 *   range?: [startMs, endMs], showCaffeine = true, showSleep = true, showZones = true, height? }) -> { update(opts), destroy() }
 */
export function alertnessChart(canvas, options = {}) {
  let o = { showCaffeine: true, showSleep: true, showZones: true, blocks: [], events: [], tasks: [], ...options };
  let L = null, xs = null, ys = null, cs = null, cafTicks = null, range = [0, 1], extrema = null, evLanes = null, blLanes = null, evs = [], bls = [];
  let stat = null, statDirty = true, disp = null, target = null, morph = null, intro = reduced() ? 1 : 0, introT0 = null, ptr = null, kb = null, clearTimer = 0;
  const parts = [], motes = []; let acc = 0, seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  const seriesOf = (m) => (m ? { alert: Float32Array.from(m.alert), base: Float32Array.from(m.alertBase || m.alert), caf: Float32Array.from(m.caffeineMg || new Array(m.alert.length).fill(0)) } : null);
  const alignCompare = (m, cm) => { if (!cm) return null; const out = new Float32Array(m.alert.length); for (let i = 0; i < out.length; i++) out[i] = seriesAt(cm.alert, cm.t0, cm.stepMin, m.t0 + i * m.stepMin * MIN); return out; };

  function setTarget(initial) {
    const m = o.model; if (!m) { disp = target = null; return; }
    const nt = { ...seriesOf(m), cmp: alignCompare(m, o.compareModel) };
    const compat = disp && disp.alert.length === nt.alert.length && target && target.t0 === m.t0 && target.step === m.stepMin;
    nt.t0 = m.t0; nt.step = m.stepMin;
    if (!compat || initial || reduced()) { disp = { alert: nt.alert.slice(), base: nt.base.slice(), caf: nt.caf.slice(), cmp: nt.cmp ? nt.cmp.slice() : null }; morph = null; }
    else { morph = { from: { alert: disp.alert.slice(), base: disp.base.slice(), caf: disp.caf.slice(), cmp: disp.cmp ? disp.cmp.slice() : null }, t0: null, dur: 520 }; if (nt.cmp && !disp.cmp) disp.cmp = nt.cmp.slice(); }
    target = nt;
  }

  function prepare() {
    const m = o.model;
    if (!m || !m.alert || !m.alert.length) { range = [0, 1]; return; }
    range = o.range || [m.t0, m.t0 + (m.alert.length - 1) * m.stepMin * MIN];
    const vis = (it) => it.endMs > range[0] && it.startMs < range[1];
    evs = (o.events || []).filter(vis); bls = (o.blocks || []).filter(vis);
    evLanes = assignLanes(evs, 2); blLanes = assignLanes(bls, 3);
    extrema = findExtrema(m, range);
    let mx = 0; const cm = m.caffeineMg; if (cm) for (let i = 0; i < cm.length; i++) if (cm[i] > mx) mx = cm[i];
    cafTicks = niceTicks(0, Math.max(100, mx * 1.12), 4);
    canvas.setAttribute('aria-label', describeAlertness(m, { range, blocks: bls, tasks: o.tasks, events: evs, compareModel: o.compareModel }));
  }

  const heightFor = (w) => {
    if (o.height) return o.height + lanesHeight(evLanes ? Math.min(2, evLanes.count) : 0, blLanes ? Math.min(3, blLanes.count) : 0);
    return clamp(w * .5, 250, 400) + lanesHeight(evLanes ? evLanes.count : 0, blLanes ? blLanes.count : 0);
  };

  function relayout(S) {
    L = chartLayout(S.w, S.h, { showCaffeine: o.showCaffeine && !!(o.model && o.model.caffeineMg), eventLanes: evs.length ? evLanes.count : 0, blockLanes: bls.length ? blLanes.count : 0 });
    xs = linearScale(range[0], range[1], L.x0, L.x1); ys = linearScale(0, 100, L.y1, L.y0);
    cs = cafTicks ? linearScale(0, cafTicks.max, L.y1, L.y0) : null;
    statDirty = true;
    // poussières de lumière ambiantes dans les zones d'or
    motes.length = 0;
    if (o.model && o.showZones && !reduced()) for (const z of (o.model.zones || [])) {
      if ((z.kind !== 'golden' && z.kind !== 'peak') || z.endMs < range[0] || z.startMs > range[1]) continue;
      const xa = xs(Math.max(z.startMs, range[0])), xb = xs(Math.min(z.endMs, range[1]));
      for (let k = 0; k < Math.min(9, Math.ceil((xb - xa) / 18)); k++) motes.push({ xa, xb, x: xa + rnd() * (xb - xa), y: L.y0 + rnd() * (L.y1 - L.y0), v: 5 + rnd() * 9, r: .7 + rnd() * 1.3, ph: rnd() * 6.28 });
    }
  }

  const surf = createSurface(canvas, {
    interactive: true,
    getHeight: heightFor,
    resized: (S) => { relayout(S); },
    loop: (S) => {
      if (!S.visible) return 0;
      let active = 0;
      if (intro < 1) { if (introT0 === null) introT0 = S.t; intro = clamp01((S.t - introT0) / 1300); active = 1; }
      if (morph) {
        if (morph.t0 === null) morph.t0 = S.t;
        const k = clamp01((S.t - morph.t0) / morph.dur), e = easeInOutCubic(k);
        for (const key of ['alert', 'base', 'caf']) { const f = morph.from[key], tg = target[key], d = disp[key]; for (let i = 0; i < d.length; i++) d[i] = f[i] + (tg[i] - f[i]) * e; }
        if (target.cmp && disp.cmp) { const f = morph.from.cmp || target.cmp, d = disp.cmp; for (let i = 0; i < d.length; i++) d[i] = f[i] + (target.cmp[i] - f[i]) * e; }
        statDirty = true; active = 1; if (k >= 1) morph = null;
      }
      if (ptr || kb !== null) active = 1;
      if (!active && !reduced() && o.model && ((o.nowMs >= range[0] && o.nowMs <= range[1]) || motes.length)) active = 2;
      return active;
    },
    draw: (g, S) => render(g, S),
  });
  prepare(); setTarget(true); relayout(surf.S);

  // ---------- Dessin statique (mis en cache) ----------
  function buildStatic(S) {
    if (!stat) stat = document.createElement('canvas');
    stat.width = Math.round(S.w * S.dpr); stat.height = Math.round(S.h * S.dpr);
    const g = stat.getContext('2d'); g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); g.clearRect(0, 0, S.w, S.h);
    paintStatic(g, S); statDirty = false;
  }

  function samplePath(arr, m, maxPts) {
    const px = [], py = [], step = m.stepMin * MIN;
    const i0 = Math.max(0, Math.floor((range[0] - m.t0) / step)), i1 = Math.min(arr.length - 1, Math.ceil((range[1] - m.t0) / step));
    for (let i = i0; i <= i1; i++) { px.push(xs(m.t0 + i * step)); py.push(ys.f ? 0 : 0); }
    return { px, i0, i1, step, maxPts };
  }

  function curvePoints(arr, scaleY) {
    const m = o.model, step = m.stepMin * MIN, X = [], Y = [];
    const i0 = Math.max(0, Math.floor((range[0] - m.t0) / step)), i1 = Math.min(arr.length - 1, Math.ceil((range[1] - m.t0) / step));
    for (let i = i0; i <= i1; i++) { X.push(clamp(xs(m.t0 + i * step), L.x0, L.x1)); Y.push(scaleY(arr[i])); }
    return decimate(X, Y, Math.max(30, Math.floor((L.x1 - L.x0) / 2.6)));
  }

  function paintStatic(g, S) {
    const th = S.theme, m = o.model; if (!m || !L) return;
    const { x0, x1, y0, y1 } = L, W = S.w, dark = th.isDark;
    const stepMs = m.stepMin * MIN, tAt = (i) => m.t0 + i * stepMs;
    const clipPlot = () => { g.beginPath(); g.rect(x0, y0 - 2, x1 - x0, y1 - y0 + 4); g.clip(); };

    // 1. Sommeil : teinte + hachures
    if (o.showSleep) {
      const runs = []; const as = m.asleep;
      if (as) { let i = 0; while (i < as.length) { if (!as[i]) { i++; continue; } let j = i; while (j + 1 < as.length && as[j + 1]) j++; runs.push([tAt(i), tAt(j)]); i = j + 1; } }
      else for (const z of (m.zones || [])) if (z.kind === 'sleep') runs.push([z.startMs, z.endMs]);
      for (const [a, b] of runs) {
        if (b < range[0] || a > range[1]) continue;
        const xa = clamp(xs(a), x0, x1), xb = clamp(xs(b), x0, x1); if (xb - xa < 1) continue;
        g.save(); g.beginPath(); g.rect(xa, y0, xb - xa, y1 - y0); g.clip();
        const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, rgba(th.night, dark ? .13 : .1)); gr.addColorStop(1, rgba(th.night, dark ? .03 : .04));
        g.fillStyle = gr; g.fillRect(xa, y0, xb - xa, y1 - y0);
        g.strokeStyle = rgba(th.night, dark ? .2 : .22); g.lineWidth = 1; g.beginPath();
        for (let k = -(y1 - y0); k < xb - xa; k += 9) { g.moveTo(xa + k, y1); g.lineTo(xa + k + (y1 - y0), y0); }
        g.stroke(); g.restore();
        g.strokeStyle = rgba(th.night, .35); g.lineWidth = 1; g.beginPath(); g.moveTo(xa + .5, y0); g.lineTo(xa + .5, y1); g.moveTo(xb - .5, y0); g.lineTo(xb - .5, y1); g.stroke();
        if (xb - xa > 74) { g.font = `600 9.5px ${th.fontMono}`; setLS(g, '1.6px'); g.fillStyle = rgba(th.nightDeep.length ? mixColors(th.night, th.text, dark ? 0 : .1) : th.night, .85); g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText('SOMMEIL', (xa + xb) / 2, y0 + 14); setLS(g, '0px'); }
      }
    }

    // 2. Grille
    g.lineWidth = 1; g.font = `500 10px ${th.fontMono}`; g.textBaseline = 'middle'; g.textAlign = 'right';
    for (const v of [25, 50, 75]) {
      const y = Math.round(ys(v)) + .5; g.strokeStyle = rgba(th.line, .9); g.setLineDash([2, 5]); g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = rgba(th.text3, .9); g.fillText(String(v), x0 - 7, y);
    }
    g.strokeStyle = rgba(th.lineStrong, .9); g.beginPath(); g.moveTo(x0, Math.round(y1) + .5); g.lineTo(x1, Math.round(y1) + .5); g.stroke();
    const ticks = timeTicks(range[0], range[1], x1 - x0);
    for (const t of ticks) { const x = Math.round(xs(t.ms)) + .5; g.strokeStyle = rgba(th.line, t.major ? 1.8 : .8); g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1 + (t.major ? 6 : 3)); g.stroke(); }

    // 3. Zones
    if (o.showZones) {
      g.save(); clipPlot();
      for (const z of (m.zones || [])) {
        if (z.endMs < range[0] || z.startMs > range[1]) continue;
        const xa = clamp(xs(z.startMs), x0, x1), xb = clamp(xs(z.endMs), x0, x1), w = xb - xa; if (w < 2) continue;
        const cx = (xa + xb) / 2;
        if (z.kind === 'golden' || z.kind === 'peak') {
          const gold = z.kind === 'golden', yc = ys(clamp(seriesAt(target.alert, m.t0, m.stepMin, (z.startMs + z.endMs) / 2), 0, 100));
          const rx = w / 2 * 1.3 + 26, ry = (y1 - y0) * .95;
          g.save(); g.translate(cx, yc); g.scale(1, ry / rx);
          const rg = g.createRadialGradient(0, 0, 0, 0, 0, rx); const a0 = gold ? (dark ? .34 : .36) : (dark ? .16 : .16);
          rg.addColorStop(0, rgba(th.sunHot, a0)); rg.addColorStop(.5, rgba(th.sun, a0 * .38)); rg.addColorStop(1, rgba(th.sun, 0));
          g.fillStyle = rg; g.fillRect(-rx, -rx, rx * 2, rx * 2); g.restore();
          if (gold) {
            const cg = g.createLinearGradient(0, y0, 0, y1); cg.addColorStop(0, rgba(th.sun, 0)); cg.addColorStop(1, rgba(th.sun, dark ? .1 : .12));
            g.fillStyle = cg; g.fillRect(xa, y0, w, y1 - y0);
            g.strokeStyle = rgba(th.sun, .5); g.lineWidth = 1; g.setLineDash([1, 4]); g.beginPath(); g.moveTo(xa + .5, y0 + 8); g.lineTo(xa + .5, y1); g.moveTo(xb - .5, y0 + 8); g.lineTo(xb - .5, y1); g.stroke(); g.setLineDash([]);
          }
        } else if (z.kind === 'dip') {
          const dg = g.createLinearGradient(0, y0, 0, y1); dg.addColorStop(0, rgba(th.dip, 0)); dg.addColorStop(1, rgba(th.dip, dark ? .16 : .15));
          g.fillStyle = dg; g.fillRect(xa, y0, w, y1 - y0);
        } else if (z.kind === 'winddown' || z.kind === 'melatonin') {
          const wg = g.createLinearGradient(0, y0, 0, y1); wg.addColorStop(0, rgba(th.night, .0)); wg.addColorStop(1, rgba(th.night, z.kind === 'melatonin' ? .12 : .07));
          g.fillStyle = wg; g.fillRect(xa, y0, w, y1 - y0);
        } else if (z.kind === 'caffeine-cutoff') {
          g.strokeStyle = rgba(th.caffeine, .8); g.lineWidth = 1.2; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(xa + .5, y0 + 2); g.lineTo(xa + .5, y1); g.stroke(); g.setLineDash([]);
        }
      }
      g.restore();
      // cartouches (hors clip)
      for (const z of (m.zones || [])) {
        if (z.endMs < range[0] || z.startMs > range[1]) continue;
        const xa = clamp(xs(z.startMs), x0, x1), xb = clamp(xs(z.endMs), x0, x1), w = xb - xa; if (w < 2) continue;
        g.textBaseline = 'alphabetic';
        if (z.kind === 'golden') {
          const yb = y0 - 9; g.strokeStyle = rgba(th.sunHot, .95); g.lineWidth = 1.6; g.lineCap = 'round'; g.beginPath(); g.moveTo(xa + 1, yb + 4); g.lineTo(xa + 1, yb); g.lineTo(xb - 1, yb); g.lineTo(xb - 1, yb + 4); g.stroke();
          const label = (z.label || 'Fenêtre d\'or').toUpperCase(); g.font = `600 9px ${th.fontMono}`; setLS(g, '1.4px');
          if (g.measureText(label).width < w - 10) { g.fillStyle = rgba(dark ? th.sunHot : mixColors(th.sunDeep, th.text, .25), 1); g.textAlign = 'center'; g.fillText(label, (xa + xb) / 2, yb - 5); }
          setLS(g, '0px');
        } else if (z.kind === 'caffeine-cutoff' && w < 3) {
          g.font = `500 9.5px ${th.fontMono}`; g.fillStyle = rgba(th.caffeine, .95); g.textAlign = 'right'; g.fillText('dernière caféine', xa - 5, y0 + 8);
        } else if (z.kind === 'dip' && w > 70) {
          g.font = `italic 500 11px ${th.fontSerif}`; g.fillStyle = rgba(th.dip, .95); g.textAlign = 'center'; g.fillText('creux', (xa + xb) / 2, y1 - 9);
        } else if (z.kind === 'winddown' && w > 90) {
          g.font = `italic 500 11px ${th.fontSerif}`; g.fillStyle = rgba(th.night, .9); g.textAlign = 'center'; g.fillText('décompression', (xa + xb) / 2, y1 - 9);
        }
      }
    }

    // 4. Comparaison fantôme
    if (disp.cmp) {
      const c = curvePoints(disp.cmp, (v) => ys(clamp(v, 0, 100)));
      g.save(); clipPlot(); g.strokeStyle = rgba(th.text, dark ? .5 : .5); g.lineWidth = 1.6; g.setLineDash([2, 5]); g.lineCap = 'round'; g.beginPath(); traceMonotone(g, c.xs, c.ys); g.stroke(); g.setLineDash([]); g.restore();
    }

    // 5. Courbe d'alerte : halo de caféine, aire, ruban lumineux
    const A = curvePoints(disp.alert, (v) => ys(clamp(v, 0, 100)));
    if (o.showCaffeine && o.model.caffeineMg) {
      const B = curvePoints(disp.base, (v) => ys(clamp(v, 0, 100)));
      g.save(); clipPlot(); g.beginPath(); traceMonotone(g, A.xs, A.ys); const rb = B.xs.slice().reverse(), ryb = B.ys.slice().reverse(); g.lineTo(rb[0], ryb[0]); traceMonotone(g, rb, ryb, false); g.closePath();
      const bg = g.createLinearGradient(0, y0, 0, y1); bg.addColorStop(0, rgba(th.caffeine, dark ? .5 : .4)); bg.addColorStop(1, rgba(th.caffeine, dark ? .18 : .16)); g.fillStyle = bg; g.fill();
      g.strokeStyle = rgba(th.text3, .8); g.lineWidth = 1; g.setLineDash([1, 3]); g.beginPath(); traceMonotone(g, B.xs, B.ys); g.stroke(); g.setLineDash([]); g.restore();
    }
    g.save(); clipPlot();
    g.beginPath(); traceMonotone(g, A.xs, A.ys); g.lineTo(A.xs[A.xs.length - 1], y1); g.lineTo(A.xs[0], y1); g.closePath();
    const ag = g.createLinearGradient(0, ys(100), 0, y1); ag.addColorStop(0, rgba(th.sunHot, dark ? .5 : .5)); ag.addColorStop(.45, rgba(th.sun, dark ? .2 : .24)); ag.addColorStop(1, rgba(th.sun, 0)); g.fillStyle = ag; g.fill();
    const lg = g.createLinearGradient(0, ys(100), 0, ys(0)); lg.addColorStop(0, rgba(th.sunHot, 1)); lg.addColorStop(.36, rgba(th.sun, 1)); lg.addColorStop(.66, rgba(th.sunDeep, 1)); lg.addColorStop(1, rgba(th.coral, 1));
    g.lineJoin = 'round'; g.lineCap = 'round';
    if (dark) g.globalCompositeOperation = 'lighter';
    for (const [lw, al] of [[16, .05], [10, .08], [5.5, .16]]) { g.strokeStyle = lg; g.globalAlpha = al * (dark ? 1 : 1.5); g.lineWidth = lw; g.beginPath(); traceMonotone(g, A.xs, A.ys); g.stroke(); }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.strokeStyle = lg; g.lineWidth = 2.8; g.beginPath(); traceMonotone(g, A.xs, A.ys); g.stroke();
    g.strokeStyle = rgba([255, 255, 255, 1], dark ? .28 : .35); g.lineWidth = .9; g.beginPath(); traceMonotone(g, A.xs, A.ys.map((y) => y - .6)); g.stroke();
    g.restore();

    // 6. Caféine (axe secondaire)
    if (o.showCaffeine && m.caffeineMg && cs) {
      const mgMax = Math.max(...disp.caf);
      if (mgMax > .5) {
        const C = curvePoints(disp.caf, (v) => cs(Math.min(v, cafTicks.max)));
        g.save(); clipPlot(); g.strokeStyle = rgba(th.caffeine, 1); g.lineWidth = 1.7; g.setLineDash([6, 4]); g.lineCap = 'butt'; g.beginPath(); traceMonotone(g, C.xs, C.ys); g.stroke(); g.setLineDash([]); g.restore();
        g.font = `500 9.5px ${th.fontMono}`; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = rgba(th.caffeine, .9);
        const tk = cafTicks.ticks.filter((v) => v <= cafTicks.max); const every = tk.length > 4 ? 2 : 1;
        tk.forEach((v, i) => { if (i % every === 0 || i === tk.length - 1) g.fillText(String(v), x1 + 6, cs(v)); });
        g.textBaseline = 'alphabetic'; g.fillText('mg', x1 + 6, y0 - 6);
      }
    }

    // 7. Pic / creux
    if (o.showZones && extrema && extrema.peak && !L.small) {
      const mk = (e, up, txt, col) => {
        const x = xs(e.ms), y = ys(clamp(seriesAt(disp.alert, m.t0, m.stepMin, e.ms), 0, 100));
        g.beginPath(); g.arc(x, y, 3.6, 0, 7); g.fillStyle = rgba(th.bg, 1); g.fill(); g.lineWidth = 1.8; g.strokeStyle = rgba(col, 1); g.stroke();
        g.font = `600 9.5px ${th.fontMono}`; setLS(g, '.8px'); g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = rgba(col, 1);
        g.fillText(txt, clamp(x, x0 + 24, x1 - 24), up ? y - 10 : Math.min(y1 - 4, y + 18)); setLS(g, '0px');
      };
      mk(extrema.peak, true, `PIC ${Math.round(extrema.peak.value)}`, dark ? th.sunHot : mixColors(th.sunDeep, th.text, .2));
      if (extrema.trough && Math.abs(extrema.trough.ms - extrema.peak.ms) > 2 * HOUR) mk(extrema.trough, false, `CREUX ${Math.round(extrema.trough.value)}`, th.text2);
    }

    // 8. Couloirs : événements (gris) puis blocs de tâches (colorés par charge)
    evs.forEach((e, i) => {
      const xa = clamp(xs(Math.max(e.startMs, range[0])), x0, x1), xb = clamp(xs(Math.min(e.endMs, range[1])), x0, x1), w = Math.max(3, xb - xa), y = L.eventsTop + evLanes.lanes[i] * (LANE.event + LANE.gap);
      roundRect(g, xa, y, w, LANE.event, 4); g.fillStyle = rgba(th.text, dark ? .12 : .1); g.fill(); g.lineWidth = 1; g.strokeStyle = rgba(th.text, dark ? .2 : .2); g.stroke();
      if (w > 44) { g.save(); g.beginPath(); g.rect(xa + 4, y, w - 8, LANE.event); g.clip(); g.font = `500 9.5px ${th.fontSans}`; g.fillStyle = rgba(th.text2, 1); g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(e.title || 'Événement', xa + 5, y + LANE.event / 2 + .5); g.restore(); }
    });
    bls.forEach((b, i) => {
      const task = (o.tasks || []).find((t) => t.id === b.taskId), col = th.load[clamp((task && task.load) || 3, 1, 5) - 1];
      const xa = clamp(xs(Math.max(b.startMs, range[0])), x0, x1), xb = clamp(xs(Math.min(b.endMs, range[1])), x0, x1), w = Math.max(3, xb - xa - 1), y = L.blocksTop + blLanes.lanes[i] * (LANE.block + LANE.gap);
      roundRect(g, xa, y, w, LANE.block, 6);
      const bg = g.createLinearGradient(0, y, 0, y + LANE.block); bg.addColorStop(0, rgba(mixColors(col, [255, 255, 255, 1], .18), dark ? .95 : .92)); bg.addColorStop(1, rgba(col, dark ? .82 : .85)); g.fillStyle = bg;
      if (dark) { g.shadowColor = rgba(col, .45); g.shadowBlur = 10; } g.fill(); g.shadowColor = 'transparent'; g.shadowBlur = 0;
      if (b.locked) { g.lineWidth = 1.5; g.strokeStyle = rgba([255, 255, 255, 1], .75); g.stroke(); }
      if (w > 34) { g.save(); g.beginPath(); g.rect(xa + 5, y, w - 9, LANE.block); g.clip(); g.font = `650 10.5px ${th.fontSans}`; g.fillStyle = rgba(pickInk(col), 1); g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText((task && task.title) || b.reason || 'Bloc', xa + 6, y + LANE.block / 2 + .5); g.restore(); }
    });

    // 9. Axe des heures
    g.textBaseline = 'alphabetic'; g.textAlign = 'center';
    for (const t of ticks) {
      const x = xs(t.ms); g.font = `${t.major ? 700 : 500} 10.5px ${th.fontMono}`; g.fillStyle = rgba(t.major ? th.text : th.text3, 1);
      const lw = g.measureText(t.label).width; g.fillText(t.label, clamp(x, x0 - 6 + lw / 2, W - lw / 2 - 2), L.axisTop + 16);
    }
  }

  // ---------- Dessin à chaque image : cache + curseur « maintenant » + survol ----------
  function render(g, S) {
    const th = S.theme;
    if (!o.model || !L || !disp) { return; }
    if (statDirty) buildStatic(S);
    g.save();
    if (intro < 1) { const rx = lerp(L.x0 - 24, L.x1 + 40, easeOutCubic(intro)); g.beginPath(); g.rect(0, 0, rx, S.h); g.clip(); }
    g.drawImage(stat, 0, 0, S.w, S.h); g.restore();
    const m = o.model, dark = th.isDark;
    if (intro < 1) {
      const rx = lerp(L.x0 - 24, L.x1 + 40, easeOutCubic(intro)), gr = g.createLinearGradient(rx - 40, 0, rx + 2, 0);
      gr.addColorStop(0, rgba(th.sunHot, 0)); gr.addColorStop(1, rgba(th.sunHot, dark ? .35 : .3)); g.fillStyle = gr; g.fillRect(rx - 40, L.y0, 42, L.y1 - L.y0);
    }
    const oa = smoothstep(.55, 1, intro);
    const anim = !reduced();
    // poussières ambiantes
    if (anim && oa > 0) {
      g.save(); if (dark) g.globalCompositeOperation = 'lighter';
      for (const p of motes) {
        p.y -= p.v * S.dt; p.x += Math.sin(S.t / 1200 + p.ph) * 4 * S.dt; if (p.y < L.y0) { p.y = L.y1 - rnd() * 24; p.x = p.xa + rnd() * (p.xb - p.xa); }
        const tw = .5 + .5 * Math.sin(S.t / 600 + p.ph), edge = smoothstep(L.y0, L.y0 + 34, p.y) * smoothstep(L.y1, L.y1 - 40, p.y);
        g.fillStyle = rgba(th.sunHot, (dark ? .55 : .8) * tw * edge * oa); g.beginPath(); g.arc(p.x, p.y, p.r, 0, 7); g.fill();
      }
      g.restore();
    }
    // curseur « maintenant »
    const nowOk = o.nowMs != null && o.nowMs >= range[0] && o.nowMs <= range[1];
    if (nowOk && oa > 0) {
      const x = xs(o.nowMs), yv = ys(clamp(seriesAt(disp.alert, m.t0, m.stepMin, o.nowMs), 0, 100)), bot = L.axisTop;
      g.save(); g.globalAlpha = oa;
      const lg = g.createLinearGradient(0, L.y0, 0, bot); lg.addColorStop(0, rgba(th.sunHot, .95)); lg.addColorStop(1, rgba(th.sun, .12));
      g.strokeStyle = lg; g.lineWidth = 1.4; g.beginPath(); g.moveTo(Math.round(x) + .5, L.y0 - 4); g.lineTo(Math.round(x) + .5, bot); g.stroke();
      const label = fmtTime(o.nowMs); g.font = `700 10.5px ${th.fontMono}`; const pw = g.measureText(label).width + 16, px = clamp(x - pw / 2, 2, S.w - pw - 2), py = 3;
      roundRect(g, px, py, pw, 19, 9.5); const pg = g.createLinearGradient(0, py, 0, py + 19); pg.addColorStop(0, rgba(th.sunHot, 1)); pg.addColorStop(1, rgba(th.sun, 1)); g.fillStyle = pg;
      g.shadowColor = rgba(th.sun, .55); g.shadowBlur = 14; g.fill(); g.shadowBlur = 0; g.shadowColor = 'transparent';
      g.fillStyle = rgba(th.sunInk, 1); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, px + pw / 2, py + 10.5);
      // halo, anneau pulsant et point
      const ph = anim ? (S.t % 2000) / 2000 : 0, br = anim ? .5 + .5 * Math.sin(S.t / 700) : .5;
      const hg = g.createRadialGradient(x, yv, 0, x, yv, 26); hg.addColorStop(0, rgba(th.sunHot, .5 + .15 * br)); hg.addColorStop(1, rgba(th.sun, 0)); g.fillStyle = hg; g.beginPath(); g.arc(x, yv, 26, 0, 7); g.fill();
      if (anim) { g.strokeStyle = rgba(th.sunHot, .6 * (1 - ph)); g.lineWidth = 1.4; g.beginPath(); g.arc(x, yv, 5 + 15 * easeOutCubic(ph), 0, 7); g.stroke(); }
      g.fillStyle = rgba(th.sunHot, 1); g.strokeStyle = rgba(th.bg, 1); g.lineWidth = 2.2; g.beginPath(); g.arc(x, yv, 4.6, 0, 7); g.fill(); g.stroke();
      // particules : poussières de lumière qui s'élèvent du point
      if (anim && S.visible) {
        acc += S.dt * 15; while (acc >= 1 && parts.length < 48) { acc -= 1; parts.push({ x: x + (rnd() - .5) * 5, y: yv - 2, vx: (rnd() - .5) * 16, vy: -(14 + rnd() * 34), life: 0, ttl: 1.2 + rnd() * 1.6, r: .7 + rnd() * 1.5 }); }
        acc = Math.min(acc, 2);
        if (dark) g.globalCompositeOperation = 'lighter';
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i]; p.life += S.dt; if (p.life >= p.ttl) { parts.splice(i, 1); continue; }
          p.x += p.vx * S.dt + Math.sin(p.life * 5 + i) * .25; p.y += p.vy * S.dt; p.vy *= 1 - .35 * S.dt;
          const k = 1 - p.life / p.ttl; g.fillStyle = rgba(th.sunHot, (dark ? .8 : .9) * k * k); g.beginPath(); g.arc(p.x, p.y, p.r * (.6 + k * .6), 0, 7); g.fill();
        }
        g.globalCompositeOperation = 'source-over';
      }
      g.restore();
    }
    // survol / toucher / clavier
    const hv = ptr ? ptr.ms : kb !== null ? kb : o.hoverMs;
    if (hv != null && hv >= range[0] && hv <= range[1]) {
      const x = xs(hv), pr = probeAt(hv, { model: m, compareModel: o.compareModel, blocks: bls, events: evs, tasks: o.tasks });
      const yv = ys(clamp(pr.alert, 0, 100));
      g.save(); g.strokeStyle = rgba(th.text, .38); g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(Math.round(x) + .5, L.y0); g.lineTo(Math.round(x) + .5, L.axisTop); g.stroke(); g.setLineDash([]);
      if (o.showCaffeine && cs && pr.caffeineMg > .5) { g.fillStyle = rgba(th.caffeine, 1); g.beginPath(); g.arc(x, cs(Math.min(pr.caffeineMg, cafTicks.max)), 3.2, 0, 7); g.fill(); }
      g.fillStyle = rgba(th.sunHot, 1); g.strokeStyle = rgba(th.bg, 1); g.lineWidth = 2.2; g.beginPath(); g.arc(x, yv, 5, 0, 7); g.fill(); g.stroke(); g.restore();
      const multi = range[1] - range[0] > 30 * HOUR, d = new Date(hv);
      const lines = [{ text: (multi ? `${JOURS_FR[d.getDay()].slice(0, 3)}. ${d.getDate()} · ` : '') + fmtTime(hv), bold: true }];
      lines.push({ dot: th.sun, text: pr.asleep ? 'Alerte (sommeil)' : 'Alerte', value: `${Math.round(pr.alert)}/100` });
      if (o.showCaffeine && pr.caffeineMg >= 1) lines.push({ dot: th.caffeine, text: 'Caféine active', value: `${Math.round(pr.caffeineMg)} mg` });
      if (o.showCaffeine && pr.caffeineMg >= 1 && Number.isFinite(pr.base) && Math.abs(pr.alert - pr.base) >= 1) lines.push({ text: 'Sans caféine', value: `${Math.round(pr.base)}`, muted: true });
      if (Number.isFinite(pr.compare)) lines.push({ dot: th.text2, text: 'Comparaison', value: `${Math.round(pr.compare)} (${pr.alert - pr.compare >= 0 ? '+' : '−'}${Math.abs(Math.round(pr.alert - pr.compare))})` });
      if (pr.block) lines.push({ sq: th.load[clamp((pr.task && pr.task.load) || 3, 1, 5) - 1], text: (pr.task && pr.task.title) || 'Tâche planifiée', value: pr.task && pr.task.load ? `charge ${pr.task.load}` : '' });
      if (pr.block && pr.block.reason) lines.push({ text: pr.block.reason, muted: true });
      if (pr.event) lines.push({ sq: th.text3, text: pr.event.title || 'Événement' });
      drawTooltip(g, th, x, yv, lines, { w: S.w, h: S.h });
    }
  }

  // ---------- Interactions ----------
  const snap = (ms) => { const m = o.model, st = m.stepMin * MIN; return clamp(Math.round((ms - m.t0) / st) * st + m.t0, range[0], range[1]); };
  const xOf = (e) => { const r = canvas.getBoundingClientRect(); return e.clientX - r.left; };
  let dragging = false;
  const msFromEvent = (e) => snap(xs.invert(clamp(xOf(e), L.x0, L.x1)));
  const inPlot = (e) => { const x = xOf(e); return x >= L.x0 - 6 && x <= L.x1 + 6; };
  const scrub = (ms) => { if (o.onScrub) o.onScrub(ms); };
  const onDown = (e) => {
    if (!o.model || !L || (e.button != null && e.button > 0)) return;
    clearTimeout(clearTimer); kb = null; dragging = true;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignoré */ }
    ptr = { ms: msFromEvent(e), touch: e.pointerType !== 'mouse' }; scrub(ptr.ms); surf.invalidate();
  };
  const onMove = (e) => {
    if (!o.model || !L) return;
    if (dragging) { ptr = { ms: msFromEvent(e), touch: ptr ? ptr.touch : false }; scrub(ptr.ms); surf.invalidate(); return; }
    if (e.pointerType === 'mouse') { if (inPlot(e)) { ptr = { ms: msFromEvent(e), touch: false }; } else ptr = null; surf.invalidate(); }
  };
  const onUp = (e) => {
    if (!dragging) return; dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignoré */ }
    if (o.onScrubEnd) o.onScrubEnd();
    if (ptr && ptr.touch) { clearTimeout(clearTimer); clearTimer = setTimeout(() => { ptr = null; surf.invalidate(); }, 2400); } else if (e.type === 'pointercancel') ptr = null;
    surf.invalidate();
  };
  const onLeave = (e) => { if (!dragging && e.pointerType === 'mouse') { ptr = null; surf.invalidate(); } };
  const onKey = (e) => {
    if (!o.model || !L) return;
    const st = (e.shiftKey ? 60 : 15) * MIN; let cur = kb !== null ? kb : (o.nowMs >= range[0] && o.nowMs <= range[1] ? o.nowMs : (range[0] + range[1]) / 2);
    if (e.key === 'ArrowRight') cur += st; else if (e.key === 'ArrowLeft') cur -= st; else if (e.key === 'Home') cur = range[0]; else if (e.key === 'End') cur = range[1];
    else if (e.key === 'Escape') { kb = null; surf.invalidate(); return; } else return;
    e.preventDefault(); kb = snap(cur); scrub(kb); surf.invalidate();
  };
  const onBlur = () => { if (kb !== null) { kb = null; surf.invalidate(); } };
  canvas.style.touchAction = 'pan-y'; canvas.style.userSelect = 'none'; canvas.style.webkitUserSelect = 'none';
  canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('pointerleave', onLeave); canvas.addEventListener('keydown', onKey); canvas.addEventListener('blur', onBlur);

  return {
    update(next = {}) {
      const modelChanged = 'model' in next && next.model !== o.model, cmpChanged = 'compareModel' in next && next.compareModel !== o.compareModel;
      const layoutKeys = ['model', 'range', 'blocks', 'events', 'tasks', 'showCaffeine', 'showSleep', 'showZones', 'compareModel', 'height'];
      const relay = layoutKeys.some((k) => k in next && next[k] !== o[k]);
      o = { ...o, ...next };
      if (relay) {
        prepare();
        if (modelChanged || cmpChanged) setTarget(false);
        const hh = heightFor(surf.S.w); canvas.style.height = `${Math.round(hh)}px`; surf.measure();
        relayout(surf.S); statDirty = true;
      }
      surf.invalidate();
    },
    destroy() {
      clearTimeout(clearTimer); surf.destroy();
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('keydown', onKey); canvas.removeEventListener('blur', onBlur);
    },
  };
}

// ===========================================================================
// 4. heatmap
// ===========================================================================
function rampFor(th, name) {
  const base = mixColors(th.surface2, th.surface3, .6);
  switch (name) {
    case 'night': return [base, mixColors(base, th.nightDeep, .8), th.night, mixColors(th.night, [255, 255, 255, 1], .55)];
    case 'alert': return [th.coral, th.sunDeep, th.sun, th.night];
    case 'load': return th.load;
    default: return [base, mixColors(base, th.sunDeep, .75), th.sun, th.sunHot];
  }
}

/**
 * heatmap(canvas, { rows, cols, values, rowLabels?, colLabels?, min?, max?, ramp = 'sun'|'night'|'alert'|'load', showValues?,
 *   format?, legend = true, tip?(r,c,v), onSelect?({row,col,value}), cellHeight? }) -> { update, destroy }
 * `rows`/`cols` : nombre ou tableau de libellés ; `values` : matrice [r][c] ou tableau à plat ; null = case vide.
 */
export function heatmap(canvas, options = {}) {
  let o = { legend: true, gap: 3, ramp: 'sun', ...options }, hover = null, anim = reduced() ? 1 : 0, t0 = null, geom = null, selected = null;
  const dims = () => ({ R: Array.isArray(o.rows) ? o.rows.length : o.rows | 0, C: Array.isArray(o.cols) ? o.cols.length : o.cols | 0 });
  const val = (r, c) => { const v = Array.isArray(o.values[0]) ? (o.values[r] || [])[c] : o.values[r * dims().C + c]; return Number.isFinite(v) ? v : null; };
  const describe = () => { const { R, C } = dims(); const flat = []; for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const v = val(r, c); if (v !== null) flat.push({ r, c, v }); } if (!flat.length) return 'Carte de chaleur vide.'; flat.sort((a, b) => b.v - a.v); const lab = (q) => `${(o.rowLabels || o.rows)[q.r] ?? q.r} ${(o.colLabels || o.cols)[q.c] ?? q.c}`; return `Carte de chaleur ${R} par ${C}. Valeur maximale ${Math.round(flat[0].v)} (${lab(flat[0])}), minimale ${Math.round(flat[flat.length - 1].v)} (${lab(flat[flat.length - 1])}).`; };
  const heightFor = (w) => { if (o.height) return o.height; const { R, C } = dims(); const cw = (w - 40) / Math.max(1, C); return Math.round(R * clamp(o.cellHeight || cw * .85, 18, 38) + 26 + (o.legend ? 26 : 0)); };
  const surf = createSurface(canvas, {
    getHeight: heightFor,
    loop: (S) => { if (anim >= 1) return 0; if (t0 === null) t0 = S.t; anim = clamp01((S.t - t0) / 900); return 1; },
    draw: (g, S) => {
      const th = S.theme, { R, C } = dims(); if (!R || !C) return;
      const rl = o.rowLabels || (Array.isArray(o.rows) ? o.rows : null), cl = o.colLabels || (Array.isArray(o.cols) ? o.cols : null);
      g.font = `500 10.5px ${th.fontMono}`; let lw = 0; if (rl) for (const s of rl) lw = Math.max(lw, g.measureText(String(s)).width); const left = rl ? lw + 10 : 4;
      const topH = cl ? 18 : 2, botH = o.legend ? 26 : 0, gap = o.gap, cw = (S.w - left - 2) / C, ch = (S.h - topH - botH) / R;
      geom = { left, topH, cw, ch, R, C };
      let mn = o.min, mx = o.max; if (mn == null || mx == null) { let a = Infinity, b = -Infinity; for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const v = val(r, c); if (v !== null) { a = Math.min(a, v); b = Math.max(b, v); } } mn = mn ?? (a === Infinity ? 0 : a); mx = mx ?? (b === -Infinity ? 1 : b); }
      const ramp = rampFor(th, o.ramp);
      g.textBaseline = 'middle';
      if (cl) { g.textAlign = 'center'; g.fillStyle = rgba(th.text3, 1); const every = Math.ceil(30 / cw); for (let c = 0; c < C; c += every) g.fillText(String(cl[c]), left + (c + .5) * cw, 8); }
      if (rl) { g.textAlign = 'right'; g.fillStyle = rgba(th.text3, 1); for (let r = 0; r < R; r++) g.fillText(String(rl[r]), left - 8, topH + (r + .5) * ch); }
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
        const v = val(r, c), x = left + c * cw + gap / 2, y = topH + r * ch + gap / 2, w = cw - gap, hh = ch - gap;
        const k = clamp01((anim * 1.6) - (c / C) * .6 - (r / R) * .3);
        const sc = easeOutCubic(k); if (sc <= 0) continue;
        g.save(); g.translate(x + w / 2, y + hh / 2); g.scale(sc, sc); g.globalAlpha = sc;
        roundRect(g, -w / 2, -hh / 2, w, hh, Math.min(6, w / 3, hh / 3));
        if (v === null) { g.fillStyle = rgba(th.text, .04); g.fill(); }
        else { const col = rampColor(ramp, (v - mn) / ((mx - mn) || 1)); g.fillStyle = rgba(col, 1); g.fill(); if (o.showValues && w > 24) { g.font = `600 10px ${th.fontMono}`; g.textAlign = 'center'; g.fillStyle = rgba(pickInk(col), .9); g.fillText(o.format ? o.format(v) : String(Math.round(v)), 0, .5); } }
        g.restore();
      }
      const mark = (cell, col, lwid) => { if (!cell) return; const x = left + cell.c * cw + gap / 2, y = topH + cell.r * ch + gap / 2; roundRect(g, x - 1, y - 1, cw - gap + 2, ch - gap + 2, 7); g.strokeStyle = col; g.lineWidth = lwid; g.stroke(); };
      mark(selected, rgba(th.text, .95), 2); mark(hover, rgba(th.sunHot, 1), 2);
      if (o.legend) {
        const lx = left, ly = S.h - 12, lwd = Math.min(160, S.w - left - 60), gr = g.createLinearGradient(lx, 0, lx + lwd, 0); ramp.forEach((c, i) => gr.addColorStop(i / (ramp.length - 1), rgba(c, 1)));
        roundRect(g, lx, ly - 3, lwd, 6, 3); g.fillStyle = gr; g.fill(); g.font = `500 10px ${th.fontMono}`; g.fillStyle = rgba(th.text3, 1); g.textAlign = 'left'; g.fillText(o.format ? o.format(mn) : String(Math.round(mn)), lx + lwd + 8, ly); g.textAlign = 'right'; g.fillText(o.format ? o.format(mx) : String(Math.round(mx)), lx - 8, ly);
      }
      if (hover) {
        const v = val(hover.r, hover.c); const x = left + (hover.c + .5) * cw, y = topH + (hover.r + .5) * ch;
        const txt = o.tip ? o.tip(hover.r, hover.c, v) : `${rl ? rl[hover.r] : hover.r} · ${cl ? cl[hover.c] : hover.c}`;
        drawTooltip(g, th, x, y - ch / 2, [{ text: String(txt), bold: true }, ...(v !== null ? [{ dot: rampColor(ramp, (v - mn) / ((mx - mn) || 1)), text: 'Valeur', value: o.format ? o.format(v) : String(Math.round(v * 10) / 10) }] : [{ text: 'Pas de donnée', muted: true }])], { w: S.w, h: S.h });
      }
    },
  });
  canvas.setAttribute('aria-label', describe());
  const cell = (e) => { if (!geom) return null; const r = canvas.getBoundingClientRect(), c = Math.floor((e.clientX - r.left - geom.left) / geom.cw), rr = Math.floor((e.clientY - r.top - geom.topH) / geom.ch); return c >= 0 && c < geom.C && rr >= 0 && rr < geom.R ? { r: rr, c } : null; };
  const mv = (e) => { const c = cell(e); if (!hover !== !c || (hover && c && (hover.r !== c.r || hover.c !== c.c))) { hover = c; surf.invalidate(); } };
  const lv = () => { hover = null; surf.invalidate(); };
  const click = (e) => { const c = cell(e); if (!c) return; selected = c; surf.invalidate(); if (o.onSelect) o.onSelect({ row: c.r, col: c.c, value: val(c.r, c.c) }); };
  canvas.addEventListener('pointermove', mv); canvas.addEventListener('pointerleave', lv); canvas.addEventListener('click', click); canvas.style.cursor = o.onSelect ? 'pointer' : 'default';
  return { update(next = {}) { o = { ...o, ...next }; canvas.setAttribute('aria-label', describe()); surf.measure(); surf.invalidate(); }, destroy() { surf.destroy(); canvas.removeEventListener('pointermove', mv); canvas.removeEventListener('pointerleave', lv); canvas.removeEventListener('click', click); } };
}

// ===========================================================================
// 5. barChart
// ===========================================================================
/**
 * barChart(canvas, { values | series:[{values,color?,name}], labels?, color = 'sun'|'night'|'coral'|css, colors?: string[],
 *   target?, targetLabel?, format?, max?, highlight?, onSelect?(i), showValues?, height? }) -> { update, destroy }
 */
export function barChart(canvas, options = {}) {
  let o = { color: 'sun', ...options }, hover = null, anim = reduced() ? 1 : 0, t0 = null, geom = null;
  const seriesList = () => (o.series ? o.series : [{ values: o.values || [], color: o.color, name: '' }]);
  const n = () => Math.max(0, ...seriesList().map((s) => s.values.length));
  const totals = () => Array.from({ length: n() }, (_, i) => seriesList().reduce((a, s) => a + (Number(s.values[i]) || 0), 0));
  const fmtV = (v) => (o.format ? o.format(v) : String(Math.round(v * 10) / 10).replace('.', ','));
  const colorOf = (th, c) => (c === 'night' ? th.night : c === 'coral' ? th.coral : c === 'sun' || !c ? th.sun : /^(#|rgb)/i.test(c) ? parseColor(c) : th.sun);
  const surf = createSurface(canvas, {
    getHeight: () => o.height || 190,
    loop: (S) => { if (anim >= 1) return 0; if (t0 === null) t0 = S.t; anim = clamp01((S.t - t0) / 800); return 1; },
    draw: (g, S) => {
      const th = S.theme, N = n(); if (!N) return; const tot = totals();
      const mxData = Math.max(o.target || 0, ...tot, 1), tk = niceTicks(o.min ?? 0, o.max ?? mxData * 1.08, 4), top = 14, bot = 24, left = 34, right = 8;
      const y = linearScale(tk.min, tk.max, S.h - bot, top), slot = (S.w - left - right) / N, bw = Math.min(40, slot * .62);
      geom = { left, slot, bw, N, y, top, bot };
      g.font = `500 10px ${th.fontMono}`; g.textBaseline = 'middle'; g.textAlign = 'right';
      for (const v of tk.ticks) { const yy = Math.round(y(v)) + .5; g.strokeStyle = rgba(th.line, v === tk.min ? 2 : 1); g.setLineDash(v === tk.min ? [] : [2, 5]); g.beginPath(); g.moveTo(left, yy); g.lineTo(S.w - right, yy); g.stroke(); g.setLineDash([]); g.fillStyle = rgba(th.text3, 1); g.fillText(fmtV(v), left - 7, yy); }
      const sl = seriesList();
      for (let i = 0; i < N; i++) {
        const k = easeOutCubic(clamp01(anim * 1.5 - (i / N) * .5)); if (k <= 0) continue;
        const cx = left + (i + .5) * slot; let acc = 0; const isHi = o.highlight == null || o.highlight === i || hover === i;
        sl.forEach((s, si) => {
          const v = Number(s.values[i]) || 0; if (v <= 0) return; const base = colorOf(th, o.colors && o.colors[i] && !o.series ? o.colors[i] : s.color || o.color);
          const y1 = y(acc + v * k), y0 = y(acc), last = si === sl.length - 1 || sl.slice(si + 1).every((q) => !(Number(q.values[i]) > 0));
          g.save(); g.globalAlpha = isHi ? 1 : .5;
          const gr = g.createLinearGradient(0, y1, 0, y0); gr.addColorStop(0, rgba(mixColors(base, [255, 255, 255, 1], .22), 1)); gr.addColorStop(1, rgba(base, th.isDark ? .55 : .8)); g.fillStyle = gr;
          if (th.isDark && (o.highlight === i || o.highlight == null) && sl.length === 1) { g.shadowColor = rgba(base, .4); g.shadowBlur = 14; }
          const r = last ? Math.min(8, bw / 2) : 0; g.beginPath(); g.moveTo(cx - bw / 2, y0); g.lineTo(cx - bw / 2, y1 + r); g.arcTo(cx - bw / 2, y1, cx - bw / 2 + r, y1, r); g.lineTo(cx + bw / 2 - r, y1); g.arcTo(cx + bw / 2, y1, cx + bw / 2, y1 + r, r); g.lineTo(cx + bw / 2, y0); g.closePath(); g.fill(); g.restore();
          acc += v;
        });
        if ((o.showValues || hover === i) && slot >= 30 && anim >= 1) { g.font = `600 10.5px ${th.fontMono}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = rgba(th.text, .95); g.fillText(fmtV(tot[i]), cx, y(tot[i]) - 6); }
        if (o.labels && o.labels[i] != null) { const every = Math.ceil(34 / slot); if (i % every === 0 || i === N - 1 && every === 1) { g.font = `${o.highlight === i ? 700 : 500} 10.5px ${th.fontMono}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = rgba(o.highlight === i ? th.text : th.text3, 1); g.fillText(String(o.labels[i]), cx, S.h - 7); } }
      }
      if (o.target != null) { const yy = Math.round(y(o.target)) + .5; g.strokeStyle = rgba(th.coral, .9); g.lineWidth = 1.2; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(left, yy); g.lineTo(S.w - right, yy); g.stroke(); g.setLineDash([]);
        if (o.targetLabel) { g.font = `600 9.5px ${th.fontMono}`; g.textAlign = 'right'; g.textBaseline = 'alphabetic'; g.fillStyle = rgba(th.coral, 1); g.fillText(o.targetLabel, S.w - right - 2, yy - 5); } }
      if (hover !== null && tot[hover] != null) { const cx = left + (hover + .5) * slot; const lines = [{ text: o.labels ? String(o.labels[hover]) : `#${hover + 1}`, bold: true }]; sl.forEach((s) => lines.push({ dot: colorOf(th, s.color || o.color), text: s.name || 'Valeur', value: fmtV(Number(s.values[hover]) || 0) })); drawTooltip(g, th, cx, y(tot[hover]), lines, { w: S.w, h: S.h }); }
    },
  });
  const desc = () => { const t = totals(); if (!t.length) return 'Graphique en barres vide.'; const mi = t.indexOf(Math.max(...t)); return `Graphique en barres, ${t.length} valeurs. Maximum ${fmtV(t[mi])}${o.labels ? ` (${o.labels[mi]})` : ''}, dernière valeur ${fmtV(t[t.length - 1])}.`; };
  canvas.setAttribute('aria-label', desc());
  const idx = (e) => { if (!geom) return null; const r = canvas.getBoundingClientRect(), i = Math.floor((e.clientX - r.left - geom.left) / geom.slot); return i >= 0 && i < geom.N ? i : null; };
  const mv = (e) => { const i = idx(e); if (i !== hover) { hover = i; surf.invalidate(); } };
  const lv = () => { hover = null; surf.invalidate(); };
  const click = (e) => { const i = idx(e); if (i !== null && o.onSelect) o.onSelect(i); };
  canvas.addEventListener('pointermove', mv); canvas.addEventListener('pointerleave', lv); canvas.addEventListener('click', click);
  return { update(next = {}) { o = { ...o, ...next }; canvas.setAttribute('aria-label', desc()); surf.measure(); surf.invalidate(); }, destroy() { surf.destroy(); canvas.removeEventListener('pointermove', mv); canvas.removeEventListener('pointerleave', lv); canvas.removeEventListener('click', click); } };
}

// ===========================================================================
// 6. sparkline
// ===========================================================================
/** sparkline(canvas, { values, color = 'sun'|'night'|'coral'|css, fill = true, min?, max?, strokeWidth = 2, band?: [lo,hi], height = 40 }) */
export function sparkline(canvas, options = {}) {
  let o = { color: 'sun', fill: true, strokeWidth: 2, height: 40, ...options }, anim = reduced() ? 1 : 0, t0 = null;
  const surf = createSurface(canvas, {
    getHeight: () => o.height,
    loop: (S) => { if (anim >= 1) return 0; if (t0 === null) t0 = S.t; anim = clamp01((S.t - t0) / 800); return 1; },
    draw: (g, S) => {
      const th = S.theme, v = (o.values || []).filter((x) => Number.isFinite(x)); if (v.length < 2) return;
      const base = o.color === 'night' ? th.night : o.color === 'coral' ? th.coral : /^(#|rgb)/i.test(o.color) ? parseColor(o.color) : th.sun, hot = mixColors(base, [255, 255, 255, 1], .35);
      const mn = o.min ?? Math.min(...v), mx = o.max ?? Math.max(...v), padY = 6, padX = 4, x = linearScale(0, v.length - 1, padX, S.w - padX), y = linearScale(mn, mx === mn ? mn + 1 : mx, S.h - padY, padY);
      if (o.band) { g.fillStyle = rgba(th.text, .06); const a = y(o.band[1]), b = y(o.band[0]); g.fillRect(padX, a, S.w - 2 * padX, b - a); }
      const X = v.map((_, i) => x(i)), Y = v.map((q) => y(q)); const reveal = lerp(0, S.w + 6, easeOutCubic(anim));
      g.save(); g.beginPath(); g.rect(0, 0, reveal, S.h); g.clip();
      if (o.fill) { g.beginPath(); traceMonotone(g, X, Y); g.lineTo(X[X.length - 1], S.h); g.lineTo(X[0], S.h); g.closePath(); const gr = g.createLinearGradient(0, 0, 0, S.h); gr.addColorStop(0, rgba(base, th.isDark ? .38 : .3)); gr.addColorStop(1, rgba(base, 0)); g.fillStyle = gr; g.fill(); }
      g.lineJoin = 'round'; g.lineCap = 'round';
      if (th.isDark) { g.strokeStyle = rgba(base, .2); g.lineWidth = o.strokeWidth * 3.2; g.beginPath(); traceMonotone(g, X, Y); g.stroke(); }
      g.strokeStyle = rgba(hot, 1); g.lineWidth = o.strokeWidth; g.beginPath(); traceMonotone(g, X, Y); g.stroke(); g.restore();
      if (anim >= 1) { const lx = X[X.length - 1], ly = Y[Y.length - 1]; const hg = g.createRadialGradient(lx, ly, 0, lx, ly, 10); hg.addColorStop(0, rgba(base, .5)); hg.addColorStop(1, rgba(base, 0)); g.fillStyle = hg; g.beginPath(); g.arc(lx, ly, 10, 0, 7); g.fill(); g.fillStyle = rgba(hot, 1); g.strokeStyle = rgba(th.bg, 1); g.lineWidth = 1.8; g.beginPath(); g.arc(lx, ly, 3.2, 0, 7); g.fill(); g.stroke(); }
    },
  });
  const desc = () => { const v = o.values || []; return v.length ? `Courbe de tendance, ${v.length} points, de ${Math.round(v[0] * 10) / 10} à ${Math.round(v[v.length - 1] * 10) / 10}.` : 'Courbe de tendance vide.'; };
  canvas.setAttribute('aria-label', desc());
  return { update(next = {}) { o = { ...o, ...next }; canvas.setAttribute('aria-label', desc()); surf.measure(); surf.invalidate(); }, destroy() { surf.destroy(); } };
}

// ===========================================================================
// 7. ringGauge : anneau d'instrument vivant (chiffre géant, graduations, respiration)
// ===========================================================================
/**
 * ringGauge(canvas, { value, max = 100, label?, sub?, unit?, color = 'sun'|'night'|'coral'|css, format?, breathe = true, height? })
 * -> { update, destroy }. Le canvas est carré par défaut (hauteur = largeur, plafonnée à 360 px).
 */
export function ringGauge(canvas, options = {}) {
  let o = { max: 100, color: 'sun', breathe: true, value: 0, ...options };
  let shown = reduced() ? o.value : 0, from = 0, toV = o.value, t0 = null;
  const surf = createSurface(canvas, {
    getHeight: (w) => o.height || Math.min(360, w),
    loop: (S) => {
      if (!S.visible) return 0;
      if (shown !== toV) { if (t0 === null) t0 = S.t; const k = clamp01((S.t - t0) / 1100); shown = from + (toV - from) * easeOutCubic(k); if (k >= 1) { shown = toV; t0 = null; } return 1; }
      return o.breathe && !reduced() ? 2 : 0;
    },
    draw: (g, S) => {
      const th = S.theme, cx = S.w / 2, cy = S.h / 2, R = Math.min(S.w, S.h) / 2 - 14, breath = o.breathe && !reduced() ? Math.sin(S.t / 5500 * Math.PI * 2) : 0;
      const base = o.color === 'night' ? th.night : o.color === 'coral' ? th.coral : /^(#|rgb)/i.test(o.color) ? parseColor(o.color) : th.sun, hot = mixColors(base, [255, 255, 255, 1], .45), deep = o.color === 'night' ? th.nightDeep : o.color === 'coral' ? mixColors(th.coral, [0, 0, 0, 1], .2) : th.sunDeep;
      const frac = clamp01(shown / o.max), a0 = -Math.PI / 2, th0 = Math.max(8, R * .13), r = R - 16;
      // halo respirant
      const hg = g.createRadialGradient(cx, cy, r * .3, cx, cy, R + 12 + breath * 5); hg.addColorStop(0, rgba(base, 0)); hg.addColorStop(.72, rgba(base, (th.isDark ? .14 : .12) * (1 + breath * .5))); hg.addColorStop(1, rgba(base, 0));
      g.fillStyle = hg; g.beginPath(); g.arc(cx, cy, R + 14, 0, 7); g.fill();
      // 60 graduations, allumées jusqu'à la valeur
      const nt = 60; g.lineCap = 'round';
      for (let i = 0; i < nt; i++) {
        const a = a0 + (i / nt) * Math.PI * 2, on = i / nt < frac, big = i % 5 === 0, r1 = R, r2 = R - (big ? 9 : 5);
        g.strokeStyle = on ? rgba(mixColors(deep, hot, i / nt), 1) : rgba(th.text, big ? .22 : .12); g.lineWidth = big ? 2 : 1.2;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
      }
      // piste + arc dégradé
      g.lineWidth = th0; g.strokeStyle = rgba(th.surface3, 1); g.beginPath(); g.arc(cx, cy, r - 6, 0, 7); g.stroke();
      if (frac > 0.002) {
        let stroke; if (g.createConicGradient) { stroke = g.createConicGradient(a0, cx, cy); stroke.addColorStop(0, rgba(deep, 1)); stroke.addColorStop(Math.max(.01, frac), rgba(hot, 1)); stroke.addColorStop(Math.min(1, frac + .001), rgba(hot, 1)); stroke.addColorStop(1, rgba(hot, 1)); } else stroke = rgba(base, 1);
        g.save(); if (th.isDark) { g.shadowColor = rgba(base, .7); g.shadowBlur = 18 + breath * 6; }
        g.lineWidth = th0; g.lineCap = 'round'; g.strokeStyle = stroke; g.beginPath(); g.arc(cx, cy, r - 6, a0, a0 + frac * Math.PI * 2); g.stroke(); g.restore();
        const ea = a0 + frac * Math.PI * 2; g.fillStyle = rgba([255, 255, 255, 1], .9); g.beginPath(); g.arc(cx + Math.cos(ea) * (r - 6), cy + Math.sin(ea) * (r - 6), th0 * .2, 0, 7); g.fill();
      }
      // chiffre géant
      const txt = o.format ? o.format(shown) : String(Math.round(shown)), fs = Math.max(28, r * .78);
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `400 ${fs}px ${th.fontSerif}`;
      const tg = g.createLinearGradient(0, cy - fs / 2, 0, cy + fs / 2); tg.addColorStop(0, rgba(hot, 1)); tg.addColorStop(.55, rgba(base, 1)); tg.addColorStop(1, rgba(deep, 1));
      g.save(); if (th.isDark) { g.shadowColor = rgba(base, .45); g.shadowBlur = 24; } g.fillStyle = tg; g.fillText(txt, cx, cy - (o.label || o.sub ? fs * .06 : 0)); g.restore();
      if (o.unit) { const tw = g.measureText(txt).width; g.font = `500 ${Math.max(11, fs * .2)}px ${th.fontMono}`; g.fillStyle = rgba(th.text3, 1); g.textAlign = 'left'; g.fillText(o.unit, cx + tw / 2 + 4, cy - fs * .22); g.textAlign = 'center'; }
      if (o.label) { g.font = `600 ${Math.max(10, r * .105)}px ${th.fontMono}`; setLS(g, '2px'); g.fillStyle = rgba(th.text2, 1); g.fillText(String(o.label).toUpperCase(), cx, cy + fs * .5); setLS(g, '0px'); }
      if (o.sub) { g.font = `400 ${Math.max(11, r * .12)}px ${th.fontSerif}`; g.fillStyle = rgba(th.text3, 1); g.fillText(String(o.sub), cx, cy + fs * .5 + Math.max(16, r * .17)); }
    },
  });
  const desc = () => `${o.label || 'Jauge'} : ${Math.round(o.value)} sur ${o.max}${o.sub ? `, ${o.sub}` : ''}.`;
  canvas.setAttribute('aria-label', desc());
  return {
    update(next = {}) { o = { ...o, ...next }; if ('value' in next) { from = shown; toV = o.value; t0 = null; } canvas.setAttribute('aria-label', desc()); surf.measure(); surf.invalidate(); },
    destroy() { surf.destroy(); },
  };
}

// ===========================================================================
// 8. calibrationChart : prédit vs ressenti
// ===========================================================================
/**
 * calibrationChart(canvas, { points:[{predicted, felt, tMs?}], feltScale = 'percent'|'checkin', bins = 5, height? }) -> { update, destroy }
 * `felt` = 0..100 (percent) ou 1..5 (checkin, converti en 0..100).
 */
export function calibrationChart(canvas, options = {}) {
  let o = { feltScale: 'percent', bins: 5, ...options }, hover = null, anim = reduced() ? 1 : 0, t0 = null, geom = null;
  const pts = () => (o.points || []).map((p) => ({ ...p, felt: o.feltScale === 'checkin' ? (p.felt - 1) * 25 : p.felt })).filter((p) => Number.isFinite(p.predicted) && Number.isFinite(p.felt));
  const surf = createSurface(canvas, {
    getHeight: (w) => o.height || clamp(w * .78, 240, 360),
    loop: (S) => { if (anim >= 1) return 0; if (t0 === null) t0 = S.t; anim = clamp01((S.t - t0) / 900); return 1; },
    draw: (g, S) => {
      const th = S.theme, P = pts(), left = 38, bot = 34, top = 12, right = 14, side = Math.min(S.w - left - right, S.h - top - bot), ox = left + (S.w - left - right - side) / 2;
      const x = linearScale(0, 100, ox, ox + side), y = linearScale(0, 100, top + side, top); geom = { x, y, P };
      g.font = `500 10px ${th.fontMono}`; g.textBaseline = 'middle';
      for (const v of [0, 25, 50, 75, 100]) { g.strokeStyle = rgba(th.line, v === 0 ? 2 : 1); g.setLineDash(v === 0 ? [] : [2, 5]); g.beginPath(); g.moveTo(ox, Math.round(y(v)) + .5); g.lineTo(ox + side, Math.round(y(v)) + .5); g.moveTo(Math.round(x(v)) + .5, top); g.lineTo(Math.round(x(v)) + .5, top + side); g.stroke(); g.setLineDash([]); g.fillStyle = rgba(th.text3, 1); g.textAlign = 'right'; g.fillText(String(v), ox - 7, y(v)); g.textAlign = 'center'; g.fillText(String(v), x(v), top + side + 12); }
      g.fillStyle = rgba(th.text2, 1); g.font = `600 9.5px ${th.fontMono}`; setLS(g, '1.4px'); g.textAlign = 'center'; g.fillText('PRÉDIT', ox + side / 2, S.h - 6); g.save(); g.translate(10, top + side / 2); g.rotate(-Math.PI / 2); g.fillText('RESSENTI', 0, 0); g.restore(); setLS(g, '0px');
      // diagonale idéale
      g.strokeStyle = rgba(th.night, .85); g.lineWidth = 1.4; g.setLineDash([6, 5]); g.beginPath(); g.moveTo(x(0), y(0)); g.lineTo(x(100), y(100)); g.stroke(); g.setLineDash([]);
      const k = easeOutCubic(anim);
      // nuage
      P.forEach((p, i) => { const a = clamp01(anim * 2 - (i / Math.max(1, P.length)) * 1); if (a <= 0) return; g.fillStyle = rgba(th.sun, .5 * a); g.strokeStyle = rgba(th.sunHot, .85 * a); g.lineWidth = 1; g.beginPath(); g.arc(x(p.predicted), y(p.felt), 3.4 + (hover === i ? 2.4 : 0), 0, 7); g.fill(); g.stroke(); });
      // moyennes par classes
      const nb = o.bins, bins = Array.from({ length: nb }, () => ({ n: 0, sp: 0, sf: 0 })); P.forEach((p) => { const b = bins[Math.min(nb - 1, Math.floor(clamp(p.predicted, 0, 99.99) / (100 / nb)))]; b.n++; b.sp += p.predicted; b.sf += p.felt; });
      const bp = bins.filter((b) => b.n >= 2).map((b) => [x(b.sp / b.n), y(b.sf / b.n)]);
      if (bp.length >= 2) { g.save(); g.beginPath(); g.rect(0, 0, S.w * k + 4, S.h); g.clip(); if (th.isDark) { g.strokeStyle = rgba(th.sun, .25); g.lineWidth = 8; g.lineCap = 'round'; g.beginPath(); traceMonotone(g, bp.map((q) => q[0]), bp.map((q) => q[1])); g.stroke(); } g.strokeStyle = rgba(th.sunHot, 1); g.lineWidth = 2.6; g.lineCap = 'round'; g.beginPath(); traceMonotone(g, bp.map((q) => q[0]), bp.map((q) => q[1])); g.stroke(); g.restore(); bp.forEach((q) => { g.fillStyle = rgba(th.sunHot, 1); g.strokeStyle = rgba(th.bg, 1); g.lineWidth = 2; g.beginPath(); g.arc(q[0], q[1], 4.6, 0, 7); g.fill(); g.stroke(); }); }
      const st = calibrationStats(P);
      if (st.n) { const txt = `n = ${st.n}  ·  biais ${st.bias >= 0 ? '+' : '−'}${Math.abs(Math.round(st.bias))}  ·  RMSE ${Math.round(st.rmse)}`; g.font = `600 10px ${th.fontMono}`; g.textAlign = 'right'; g.textBaseline = 'alphabetic'; g.fillStyle = rgba(th.text2, 1); g.fillText(txt, ox + side - 6, top + side - 8); }
      else { g.font = `italic 400 14px ${th.fontSerif}`; g.textAlign = 'center'; g.fillStyle = rgba(th.text3, 1); g.fillText('Pas encore de check-in à comparer', ox + side / 2, top + side / 2); }
      if (hover !== null && P[hover]) { const p = P[hover], lines = [{ text: p.tMs ? `${fmtTime(p.tMs)}` : 'Point', bold: true }, { dot: th.sun, text: 'Prédit', value: String(Math.round(p.predicted)) }, { dot: th.night, text: 'Ressenti', value: String(Math.round(p.felt)) }]; drawTooltip(g, th, x(p.predicted), y(p.felt), lines, { w: S.w, h: S.h }); }
    },
  });
  const desc = () => { const st = calibrationStats(pts()); return st.n ? `Calibration : ${st.n} check-ins comparés à la prédiction. Biais ${Math.round(st.bias)} points, erreur quadratique moyenne ${Math.round(st.rmse)}.` : 'Calibration : aucun check-in à comparer.'; };
  canvas.setAttribute('aria-label', desc());
  const near = (e) => { if (!geom) return null; const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top; let best = null, bd = 18 * 18; geom.P.forEach((p, i) => { const d = (geom.x(p.predicted) - px) ** 2 + (geom.y(p.felt) - py) ** 2; if (d < bd) { bd = d; best = i; } }); return best; };
  const mv = (e) => { const i = near(e); if (i !== hover) { hover = i; surf.invalidate(); } };
  const lv = () => { hover = null; surf.invalidate(); };
  canvas.addEventListener('pointermove', mv); canvas.addEventListener('pointerleave', lv);
  return { update(next = {}) { o = { ...o, ...next }; canvas.setAttribute('aria-label', desc()); surf.measure(); surf.invalidate(); }, destroy() { surf.destroy(); canvas.removeEventListener('pointermove', mv); canvas.removeEventListener('pointerleave', lv); } };
}
