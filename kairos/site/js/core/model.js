// Point d'entrée du moteur : assemble sommeil + chrono + caféine en un « Model » consommé par toute l'UI.
//
// Contrat : voir kairos/ARCHITECTURE.md (buildModel, valueAt, meanAlert, slotIndex). Ajouts compatibles :
//   - Model.AW (poids « éveillé » 0..1), Model.episodes (sommeils connus + supposés), Model.params ;
//   - stats.nextBedMs, stats.cutoffMs, stats.dlmoList, stats.p75, stats.caffeineBoostMax.
// Hypothèses : voir chrono.js (S/C/W), caffeine.js (PK + effet), sleep.js (épisodes, dette) et docs/science.md.
// Déterminisme : aucune source d'aléa, aucune lecture de l'horloge ; deux appels identiques donnent le même résultat.
import { MIN, HOUR, clamp, fmtTime, fmtDuration } from './time.js';
import { simulateProcessesRaw } from './chrono.js';
import { caffeineCurveRaw, caffeineAt, alertnessBoost, caffeineCutoff, CAFFEINE } from './caffeine.js';
import { debtAsOf, sleepNeedH, usualSchedule, MAIN_SLEEP_MIN_H } from './sleep.js';

/** Hauteur au-delà de laquelle l'alerte sature en douceur (évite un plafond plat à 100). */
const topClip = (x) => (x <= 90 ? x : 90 + 10 * Math.tanh((x - 90) / 10));

const DLMO_BEFORE_CBTMIN_H = 7.5; // Burgess & Eastman : DLMO ≈ 6-7 h avant le minimum de température
const WINDDOWN_MIN = 90;
const GOLDEN_MIN = 60;

function longestRuns(flags, n) {
  const runs = [];
  let i = 0;
  while (i < n) {
    if (!flags[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && flags[j + 1]) j++;
    runs.push([i, j]);
    i = j + 1;
  }
  return runs;
}

/**
 * Construit le modèle d'alerte sur [fromMs, fromMs + hours h].
 * @returns {object} Model (voir ARCHITECTURE.md)
 */
export function buildModel({
  profile, sleeps = [], caffeine = [], fromMs, hours = 24, stepMin = 5, nowMs = fromMs, whatIf,
}) {
  const stepMs = stepMin * MIN;
  const n = Math.round((hours * 60) / stepMin) + 1;
  const toMs = fromMs + hours * HOUR;
  const t = (i) => fromMs + i * stepMs;

  // --- scénario « et si » : prioritaire sur le réel ---
  const extra = [
    ...(whatIf?.sleeps || []),
    ...(whatIf?.extraNaps || []).map((x) => ({ bedMs: x.startMs, wakeMs: x.endMs, nap: true })),
  ];
  const logs = [...(caffeine || []), ...(whatIf?.caffeine || [])];

  const sim = simulateProcessesRaw({ sleeps, extra, profile, fromMs, toMs, stepMin });
  const mg = caffeineCurveRaw(logs, profile, fromMs, stepMin, n);

  // --- alerte finale : base + effet de la caféine (uniquement éveillé) ---
  const alert = new Float64Array(n);
  let boostMax = 0;
  for (let i = 0; i < n; i++) {
    const b = alertnessBoost(mg[i], profile, { S: sim.S[i] }) * sim.AW[i];
    if (b > boostMax) boostMax = b;
    alert[i] = clamp(topClip(sim.alertBase[i] + b), 0, 100);
  }

  // --- statistiques ---
  const needH = sleepNeedH(profile);
  const sleepDebtH = debtAsOf(sim.episodes, nowMs, needH).debtH;
  const mainEps = sim.episodes.filter((e) => !e.nap && (e.endMs - e.startMs) / HOUR >= MAIN_SLEEP_MIN_H);
  const nextMain = mainEps.find((e) => e.startMs > nowMs) || null; // prochain coucher (une nuit déjà commencée ne compte pas)
  const nextBedMs = nextMain ? nextMain.startMs : null;
  const caffeineAtBedMg = nextBedMs === null ? 0 : caffeineAt(logs.filter((l) => l.tMs < nextBedMs), profile, nextBedMs);
  const cutoffMs = nextBedMs === null ? null : caffeineCutoff({ logs, profile, bedMs: nextBedMs });

  // Pic et creux sur les échantillons éveillés (creux : on écarte la montée du matin — 3 h après le réveil — et la chute d'avant-coucher — 2 h).
  let wakeIdx = -1;
  const lastWakeIdx = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (i > 0 && sim.asleep[i - 1] && !sim.asleep[i]) wakeIdx = i;
    lastWakeIdx[i] = wakeIdx;
  }
  const nextBedIdx = new Int32Array(n);
  let bedIdx = n + 1e9;
  for (let i = n - 1; i >= 0; i--) {
    if (i < n - 1 && !sim.asleep[i] && sim.asleep[i + 1]) bedIdx = i + 1;
    nextBedIdx[i] = bedIdx;
  }
  let peakI = -1; let troughI = -1; let anyAwakeMinI = -1;
  const awakeVals = [];
  for (let i = 0; i < n; i++) {
    if (sim.asleep[i]) continue;
    if (peakI < 0 || alert[i] > alert[peakI]) peakI = i;
    if (anyAwakeMinI < 0 || alert[i] < alert[anyAwakeMinI]) anyAwakeMinI = i;
    if (sim.AW[i] >= 0.999) awakeVals.push(alert[i]);
    const sinceWake = lastWakeIdx[i] >= 0 ? (i - lastWakeIdx[i]) * stepMs : Infinity;
    const toBed = nextBedIdx[i] < n ? (nextBedIdx[i] - i) * stepMs : Infinity;
    if (sinceWake >= 180 * MIN && toBed >= 120 * MIN && (troughI < 0 || alert[i] < alert[troughI])) troughI = i;
  }
  if (peakI < 0) peakI = 0;
  if (troughI < 0) troughI = anyAwakeMinI >= 0 ? anyAwakeMinI : 0;

  // Fenêtres « prime time » : ≥ 60 min au-dessus du 75e centile de l'alerte éveillée.
  const sorted = awakeVals.slice().sort((a, b) => a - b);
  const p75 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.75 * sorted.length))] : Infinity;
  const hot = new Uint8Array(n);
  for (let i = 0; i < n; i++) hot[i] = !sim.asleep[i] && sim.AW[i] >= 0.999 && alert[i] >= p75 ? 1 : 0;
  const rawRuns = longestRuns(hot, n);
  const merged = []; // on recolle les interruptions ≤ 10 min (bruit autour du seuil)
  for (const r of rawRuns) {
    const last = merged[merged.length - 1];
    if (last && (r[0] - last[1] - 1) * stepMs <= 10 * MIN) last[1] = r[1]; else merged.push([...r]);
  }
  const goldenWindows = [];
  for (const [a, b] of merged) {
    if ((b - a + 1) * stepMs < GOLDEN_MIN * MIN) continue;
    let sum = 0;
    for (let i = a; i <= b; i++) sum += alert[i];
    goldenWindows.push({ startMs: t(a), endMs: Math.min(t(b) + stepMs, t(n - 1)), mean: sum / (b - a + 1) });
  }

  // DLMO : ≈ CBTmin − 7 h, pour chaque nuit connue.
  const dlmoList = sim.knotCbt.map((c) => c - DLMO_BEFORE_CBTMIN_H * HOUR).filter((d) => d > fromMs - 12 * HOUR && d < toMs + 24 * HOUR);
  let dlmoMs = dlmoList.find((d) => d >= fromMs);
  if (dlmoMs === undefined) {
    const s = usualSchedule(profile);
    dlmoMs = fromMs + ((s.bedMin - 150) / 60) * HOUR;
  }

  const model = {
    t0: fromMs, stepMin, n,
    alert: Array.from(alert),
    alertBase: Array.from(sim.alertBase),
    caffeineMg: Array.from(mg),
    S: Array.from(sim.S),
    C: Array.from(sim.C),
    asleep: Array.from(sim.asleep, Boolean),
    AW: Array.from(sim.AW),
    zones: [],
    stats: {
      peak: { ms: t(peakI), value: alert[peakI] },
      trough: { ms: t(troughI), value: alert[troughI] },
      dlmoMs, dlmoList, sleepDebtH, caffeineAtBedMg, goldenWindows,
      nextBedMs, cutoffMs, p75: Number.isFinite(p75) ? p75 : null, caffeineBoostMax: boostMax,
    },
    episodes: sim.episodes,
    params: sim.params,
  };
  model.zones = buildZones(model, sim, alert, { stepMs, fromMs, toMs, nextBedMs, cutoffMs, caffeineAtBedMg });
  return model;
}

// ---------------------------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------------------------

/** Extrema alternés (« zigzag ») avec une prominence minimale, sur une plage d'indices [a, b]. */
function zigzag(vals, a, b, minProm) {
  const ext = [];
  let dir = 0; // +1 : on monte (dernier extremum = creux), -1 : on descend
  let candI = a;
  for (let i = a + 1; i <= b; i++) {
    if (dir >= 0 && vals[i] > vals[candI]) { candI = i; if (dir === 0 && vals[i] - vals[a] >= minProm) dir = 1; continue; }
    if (dir <= 0 && vals[i] < vals[candI]) { candI = i; if (dir === 0 && vals[a] - vals[i] >= minProm) dir = -1; continue; }
    if (dir === 1 && vals[candI] - vals[i] >= minProm) { ext.push({ i: candI, kind: 'peak' }); dir = -1; candI = i; }
    else if (dir === -1 && vals[i] - vals[candI] >= minProm) { ext.push({ i: candI, kind: 'dip' }); dir = 1; candI = i; }
  }
  return ext;
}

function buildZones(model, sim, alert, { stepMs, fromMs, toMs, nextBedMs, cutoffMs, caffeineAtBedMg }) {
  const { n } = model;
  const zones = [];
  const clampRange = (s, e) => ({ startMs: Math.max(s, fromMs), endMs: Math.min(e, toMs) });
  const push = (kind, s, e, label) => {
    const r = clampRange(s, e);
    if (r.endMs > r.startMs) zones.push({ kind, ...r, label });
  };

  // Sommeil (bornes exactes, pas celles de la grille).
  for (const e of sim.episodes) {
    if (e.endMs <= fromMs || e.startMs >= toMs) continue;
    const d = (e.endMs - e.startMs) / MIN;
    push('sleep', e.startMs, e.endMs, e.nap ? `Sieste · ${fmtDuration(d)}` : `Sommeil · ${fmtDuration(d)}`);
    if (!e.nap && d / 60 >= MAIN_SLEEP_MIN_H) push('winddown', e.startMs - WINDDOWN_MIN * MIN, e.startMs, 'Ralentis : lumière douce, écrans en pause');
  }

  // Mélatonine : du début de la montée (DLMO) jusqu'au coucher (au moins 1 h).
  for (const d of model.stats.dlmoList) {
    const bed = sim.episodes.find((e) => !e.nap && e.startMs > d && e.startMs - d < 8 * HOUR);
    push('melatonin', d, bed ? Math.max(bed.startMs, d + HOUR) : d + 3 * HOUR, 'Montée de la mélatonine');
  }

  // Coupure de la caféine : de la dernière heure raisonnable jusqu'au coucher.
  if (nextBedMs !== null && cutoffMs !== null && cutoffMs < nextBedMs) {
    const late = caffeineAtBedMg > CAFFEINE.bedThresholdMg;
    push('caffeine-cutoff', cutoffMs, nextBedMs,
      late ? `Caféine encore élevée au coucher (≈ ${Math.round(caffeineAtBedMg)} mg)` : `Après ${fmtTime(cutoffMs)}, un café risque de gêner ton sommeil`);
  }

  // Prime time.
  for (const g of model.stats.goldenWindows) push('golden', g.startMs, g.endMs, `Prime time · ${Math.round(g.mean)}/100`);

  // Pics et creux : extrema alternés par période d'éveil, hors inertie du réveil et chute d'avant-coucher.
  const smooth = new Float64Array(n);
  const w = Math.max(1, Math.round((20 * MIN) / stepMs));
  for (let i = 0; i < n; i++) {
    let s = 0; let c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { s += alert[k]; c++; }
    smooth[i] = s / c;
  }
  let i = 0;
  while (i < n) {
    if (model.asleep[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && !model.asleep[j + 1]) j++;
    // Période d'éveil [i, j] : on enlève 75 min après un réveil observé et 100 min avant un coucher observé.
    const a = i > 0 ? i + Math.round((75 * MIN) / stepMs) : i;
    const b = j < n - 1 ? j - Math.round((100 * MIN) / stepMs) : j;
    if (b - a >= Math.round((3 * HOUR) / stepMs)) {
      for (const ex of zigzag(smooth, a, b, 4)) {
        const v = smooth[ex.i];
        let lo = ex.i; let hi = ex.i;
        const near = (k) => (ex.kind === 'peak' ? smooth[k] >= v - 4 : smooth[k] <= v + 4);
        while (lo > a && near(lo - 1)) lo--;
        while (hi < b && near(hi + 1)) hi++;
        const label = ex.kind === 'peak' ? `Pic d'alerte · ${Math.round(v)}/100` : `Creux · ${Math.round(v)}/100`;
        push(ex.kind, fromMs + lo * stepMs, fromMs + (hi + 1) * stepMs, label);
      }
    }
    i = j + 1;
  }

  zones.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  return zones;
}

// ---------------------------------------------------------------------------------------------
// Accès aux séries
// ---------------------------------------------------------------------------------------------

/** Index d'échantillon le plus proche (borné). */
export function slotIndex(model, ms) {
  return clamp(Math.round((ms - model.t0) / (model.stepMin * MIN)), 0, model.n - 1);
}

/** Interpolation linéaire, bornée aux extrémités. */
export function valueAt(series, model, ms) {
  const x = clamp((ms - model.t0) / (model.stepMin * MIN), 0, model.n - 1);
  const i = Math.floor(x);
  if (i >= model.n - 1) return Number(series[model.n - 1]);
  const f = x - i;
  const a = Number(series[i]);
  return f === 0 ? a : a + f * (Number(series[i + 1]) - a);
}

const cumCache = new WeakMap();
/** Intégrale cumulée (trapèzes, en unités d'échantillon) mémoïsée par tableau. */
function cumulative(series, n) {
  let c = cumCache.get(series);
  if (c && c.length === n) return c;
  c = new Float64Array(n);
  for (let i = 1; i < n; i++) c[i] = c[i - 1] + (Number(series[i - 1]) + Number(series[i])) / 2;
  cumCache.set(series, c);
  return c;
}

/**
 * Moyenne (exacte pour une interpolation linéaire) d'une série sur [startMs, endMs].
 * Les parties hors du modèle sont ignorées ; si l'intervalle est entièrement dehors, on renvoie la valeur du bord.
 */
export function meanAlert(model, startMs, endMs, { series = 'alert' } = {}) {
  const s = model[series];
  if (!s) throw new Error(`Série inconnue : ${series}`);
  const step = model.stepMin * MIN;
  const xa = clamp((Math.min(startMs, endMs) - model.t0) / step, 0, model.n - 1);
  const xb = clamp((Math.max(startMs, endMs) - model.t0) / step, 0, model.n - 1);
  if (xb - xa < 1e-9) return valueAt(s, model, startMs);
  const cum = cumulative(s, model.n);
  const integ = (x) => {
    const i = Math.min(model.n - 2, Math.floor(x));
    const f = x - i;
    const a = Number(s[i]);
    const b = Number(s[i + 1]);
    return cum[i] + f * (a + (a + f * (b - a))) / 2;
  };
  return (integ(xb) - integ(xa)) / (xb - xa);
}
