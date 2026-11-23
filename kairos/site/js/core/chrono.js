// Chronobiologie : processus S (homéostatique) + C (circadien) + inertie du sommeil W + creux post-prandial.
//
// Modèle (références complètes et limites dans docs/science.md) :
//  - S : modèle à deux processus de Borbély (1982) ; Daan, Beersma & Borbély (1984). S monte à l'éveil avec une
//    constante de temps τi ≈ 18,2 h et décroît pendant le sommeil avec τd ≈ 4,2 h (valeurs d'Achermann et al.
//    1993 / Borbély & Achermann 1999). S est normalisé 0..1. Le besoin de sommeil individuel k = besoin/8 h met
//    ces constantes à l'échelle (τi/k, τd·k) : dormir exactement son besoin dissipe toujours la même fraction de S.
//  - C : somme d'une harmonique de 24 h et d'une 2e harmonique de 12 h (Dijk & Czeisler ; Borbély 1982 ;
//    Folkard & Åkerstedt). Le minimum de température centrale (CBTmin) est ancré sur le réveil : il survient ≈ 2,5 h
//    avant le réveil habituel (Burgess & Eastman). La phase SUIT les horaires de sommeil réels avec un entraînement
//    lent (≤ 1 h par jour), ce qui produit naturellement le « jet-lag social » des week-ends.
//  - W : inertie du sommeil (Tassi & Muzet 2000 ; Åkerstedt & Folkard 1995) : décroissance exponentielle après le
//    réveil, plus forte après un sommeil profond (sieste longue, forte pression de sommeil) ou au creux circadien.
//  - Creux post-prandial : composante circasemidienne (Monk 2005) — gaussienne modeste centrée ≈ 10 h après CBTmin.
//  - Dette de sommeil chronique : pénalité saturante (Van Dongen et al. 2003 : le déficit cumulé dépasse ce que S
//    seul prédit).
//  - Alerte = combinaison pondérée normalisée 0..100 (modèle à trois processus, Åkerstedt & Folkard 1995).
// Hypothèse forte : les poids (wS, wC…) sont des choix de modélisation calibrés sur la forme typique d'une journée,
// pas des constantes mesurées. L'ajustement personnel (personalize.js) peut les moduler via chronoShiftMin etc.
import { MIN, HOUR, DAY, startOfDay, clamp } from './time.js';
import {
  buildEpisodes, sleepNeedH, usualSchedule, debtAsOf, debtPenaltyPts, MAIN_SLEEP_MIN_H,
} from './sleep.js';

export const DEFAULT_PARAMS = Object.freeze({
  // --- processus S ---
  tauWakeH: 18.2,      // constante de montée de S à l'éveil (h)
  tauSleepH: 4.2,      // constante de décroissance de S pendant le sommeil (h)
  S0: 0.35,            // S initial avant l'échauffement
  warmupDays: 6,       // jours simulés avant fromMs : S oublie son état initial en ≈ 3 jours
  debtDays: 14,
  // --- phase circadienne ---
  cbtAnchorBeforeWakeH: 0.5, // CBTmin = réveil − 0,5 − durée/4 (= réveil − 2,5 h pour 8 h de sommeil)
  phaseKappa: 0.45,    // fraction de l'écart de phase rattrapée à chaque nuit
  phaseMaxStepH: 1,    // décalage maximal de la phase par jour (h) — cf. courbes de réponse à la lumière
  acroAfterCbtH: 11.6, // acrophase de l'harmonique 24 h, en heures après CBTmin
  h2Amp: 0.47,         // amplitude relative de la 2e harmonique (12 h)
  h2PeakAfterCbtH: 5.0,
  // --- composition de l'alerte (points sur 0..100) ---
  base: 69.5,
  wC: 63,
  wS: 55,
  postprandial: { centerAfterCbtH: 9.5, sigmaH: 1.1, depth: 7 },
  // --- inertie du sommeil ---
  inertia: { baseW: 15, tauMinH: 0.45, tauSpanH: 0.55, wakeRampMin: 8, preSleepRampMin: 20 },
  // --- alerte pendant le sommeil (toujours ≤ 15) ---
  sleepAlert: { min: 3, span: 7 },
});

const TWO_PI = 2 * Math.PI;

/** Heure locale (0..24) de `ms`, sûre vis-à-vis des changements d'heure. */
export function hourOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

const wrap24 = (h) => ((h % 24) + 24) % 24;
const wrap12 = (h) => ((h + 12) % 24 + 24) % 24 - 12;

/** C(τ) ∈ [-1,1] où τ = heures depuis le CBTmin. */
export function circadianC(tauH, p = DEFAULT_PARAMS) {
  const c1 = Math.cos((TWO_PI * (tauH - p.acroAfterCbtH)) / 24);
  const c2 = Math.cos((TWO_PI * (tauH - p.h2PeakAfterCbtH)) / 12);
  return (c1 + p.h2Amp * c2) / (1 + p.h2Amp);
}

/** Lissage doux au sommet (évite un plateau à 100) et plancher à 0. */
const softClip = (x) => (x <= 88 ? Math.max(0, x) : 88 + 12 * Math.tanh((x - 88) / 12));

/**
 * Cœur de la simulation, tableaux typés (utilisé par model.js).
 * @param {object} o
 * @param {Array} o.sleeps journaux (déjà fusionnés avec les scénarios si besoin)
 * @param {Array} [o.extra] sommeils de scénario (priorité absolue)
 */
export function simulateProcessesRaw({ sleeps = [], extra = [], profile = {}, fromMs, toMs, stepMin = 5, params = DEFAULT_PARAMS }) {
  const p = params;
  const stepMs = stepMin * MIN;
  const n = Math.max(1, Math.round((toMs - fromMs) / stepMs) + 1);
  const needH = sleepNeedH(profile);
  const k = needH / 8;
  const tauI = p.tauWakeH / k;
  const tauD = p.tauSleepH * k;
  const shiftH = (Number(profile.chronoShiftMin) || 0) / 60;

  const warmStart = startOfDay(fromMs) - p.warmupDays * DAY;
  const eps = buildEpisodes({
    sleeps, extra, profile, fromMs: Math.min(warmStart, fromMs - (p.debtDays + 2) * DAY), toMs: toMs + DAY,
  });

  // --- S aux frontières des épisodes (solution analytique exacte par morceaux) ---
  const m = eps.length;
  const sOn = new Float64Array(m);
  const sEnd = new Float64Array(m);
  let sPrev = p.S0;
  let tPrev = warmStart;
  for (let i = 0; i < m; i++) {
    const e = eps[i];
    const gapH = Math.max(0, (e.startMs - tPrev) / HOUR);
    sOn[i] = 1 - (1 - sPrev) * Math.exp(-gapH / tauI);
    sEnd[i] = sOn[i] * Math.exp(-((e.endMs - e.startMs) / HOUR) / tauD);
    sPrev = sEnd[i];
    tPrev = e.endMs;
  }

  // --- phase circadienne : nœuds à chaque réveil de « nuit », interpolation linéaire entre eux ---
  const knotT = [];
  const knotPhi = [];
  const knotCbt = [];
  const sched = usualSchedule(profile);
  const fallbackAnchor = wrap24(sched.wakeMin / 60 - p.cbtAnchorBeforeWakeH - sched.durMin / 60 / 4);
  let phi = null;
  for (const e of eps) {
    const durH = (e.endMs - e.startMs) / HOUR;
    if (e.nap || durH < MAIN_SLEEP_MIN_H) continue;
    const anchor = hourOfDay(e.endMs) - p.cbtAnchorBeforeWakeH - durH / 4;
    phi = phi === null ? anchor : phi + clamp(p.phaseKappa * wrap12(anchor - phi), -p.phaseMaxStepH, p.phaseMaxStepH);
    knotT.push(e.endMs);
    knotPhi.push(phi);
    // CBTmin absolu de cette nuit : le dernier passage à l'heure φ avant le réveil.
    knotCbt.push(e.endMs - wrap24(hourOfDay(e.endMs) - (phi + shiftH)) * HOUR);
  }
  if (!knotT.length) { knotT.push(fromMs); knotPhi.push(fallbackAnchor); knotCbt.push(fromMs); }
  let kj = 0;
  const phaseAtSeq = (ms) => { // appelé en temps croissant
    while (kj + 1 < knotT.length && knotT[kj + 1] <= ms) kj++;
    if (ms <= knotT[0]) return knotPhi[0] + shiftH;
    if (kj + 1 >= knotT.length) return knotPhi[kj] + shiftH;
    const f = (ms - knotT[kj]) / (knotT[kj + 1] - knotT[kj]);
    return knotPhi[kj] + f * (knotPhi[kj + 1] - knotPhi[kj]) + shiftH;
  };
  const phaseAtRandom = (ms) => { // recherche dichotomique (pour les réveils passés)
    let lo = 0; let hi = knotT.length - 1;
    if (ms <= knotT[0]) return knotPhi[0] + shiftH;
    if (ms >= knotT[hi]) return knotPhi[hi] + shiftH;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (knotT[mid] <= ms) lo = mid; else hi = mid; }
    const f = (ms - knotT[lo]) / (knotT[hi] - knotT[lo]);
    return knotPhi[lo] + f * (knotPhi[hi] - knotPhi[lo]) + shiftH;
  };

  // --- inertie et dette par épisode (valeurs « après le réveil ») ---
  const w0 = new Float64Array(m);
  const wTau = new Float64Array(m);
  const debtAfter = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const e = eps[i];
    const durH = (e.endMs - e.startMs) / HOUR;
    let depth;
    if (durH >= MAIN_SLEEP_MIN_H + 0.5) {
      depth = 0.75 + 0.25 * clamp((sOn[i] - 0.4) / 0.3, 0, 1); // nuit : on se réveille souvent après du sommeil lent
    } else {
      // Sieste : l'inertie n'apparaît qu'avec du sommeil lent (≳ 20-30 min) et grandit avec la pression de sommeil.
      depth = (0.1 + 0.9 * clamp((durH * 60 - 12) / 50, 0, 1)) * (0.75 + 0.5 * clamp(sOn[i], 0, 1));
    }
    const cWake = circadianC(wrap24(hourOfDay(e.endMs) - phaseAtRandom(e.endMs)), p);
    w0[i] = p.inertia.baseW * depth * (1 + 0.4 * Math.max(0, -cWake));
    wTau[i] = p.inertia.tauMinH + p.inertia.tauSpanH * depth;
    debtAfter[i] = debtAsOf(eps, e.endMs, needH, p.debtDays).debtH;
  }

  // --- échantillonnage ---
  const S = new Float64Array(n);
  const C = new Float64Array(n);
  const W = new Float64Array(n);
  const D = new Float64Array(n); // dette en heures
  const asleep = new Uint8Array(n);
  const alertBase = new Float64Array(n);
  const AW = new Float64Array(n); // poids « éveillé » 0..1 (rampes de réveil et d'endormissement)
  const pp = p.postprandial;
  const wakeRamp = p.inertia.wakeRampMin * MIN;
  const bedRamp = p.inertia.preSleepRampMin * MIN;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = fromMs + i * stepMs;
    while (j < m && eps[j].endMs <= t) j++;
    const inSleep = j < m && eps[j].startMs <= t;
    const prevEnd = j > 0 ? eps[j - 1].endMs : warmStart;
    const sPrevEnd = j > 0 ? sEnd[j - 1] : p.S0;

    let s;
    if (inSleep) s = sOn[j] * Math.exp(-((t - eps[j].startMs) / HOUR) / tauD);
    else s = 1 - (1 - sPrevEnd) * Math.exp(-((t - prevEnd) / HOUR) / tauI);
    S[i] = s;
    asleep[i] = inSleep ? 1 : 0;

    const tau = wrap24(hourOfDay(t) - phaseAtSeq(t));
    const c = circadianC(tau, p);
    C[i] = c;
    D[i] = j > 0 ? debtAfter[j - 1] : 0;

    let w = 0;
    if (j > 0 && !inSleep) w = w0[j - 1] * Math.exp(-((t - prevEnd) / HOUR) / wTau[j - 1]);
    W[i] = w;

    const dip = pp.depth * Math.exp(-0.5 * ((wrap12(tau - pp.centerAfterCbtH)) / pp.sigmaH) ** 2);
    const awake = softClip(p.base + p.wC * c - p.wS * s - dip - debtPenaltyPts(D[i]) - w);
    const sleepVal = p.sleepAlert.min + p.sleepAlert.span * (c + 1) / 2;
    // Transitions douces : l'alerte se construit après le réveil et s'effondre avant l'endormissement.
    let aw = 1;
    if (inSleep) aw = 0;
    else {
      if (j > 0) aw = Math.min(aw, clamp((t - prevEnd) / wakeRamp, 0, 1));
      if (j < m) aw = Math.min(aw, clamp((eps[j].startMs - t) / bedRamp, 0, 1));
    }
    AW[i] = aw;
    alertBase[i] = sleepVal + (awake - sleepVal) * aw;
  }
  return { t0: fromMs, stepMin, n, S, C, W, D, AW, asleep, alertBase, episodes: eps, knotCbt, params: p, tauWakeH: tauI, tauSleepH: tauD };
}

/** Heures de CBTmin (ms) des nuits connues dans [fromMs, toMs] (+1 nuit de marge). */
export function cbtMinTimes(sim, fromMs, toMs) {
  return sim.knotCbt.filter((t) => t >= fromMs - DAY && t <= toMs + DAY);
}

/**
 * API du contrat : tableaux simples. `sleeps` = journaux ; `extra` (optionnel) = scénario prioritaire.
 * @returns {{t0,stepMin,n,S:number[],C:number[],W:number[],D:number[],asleep:boolean[],alertBase:number[],episodes:object[]}}
 */
export function simulateProcesses({ sleeps, extra, profile, fromMs, toMs, stepMin = 5, params }) {
  const r = simulateProcessesRaw({ sleeps, extra, profile, fromMs, toMs, stepMin, params });
  return {
    ...r,
    S: Array.from(r.S), C: Array.from(r.C), W: Array.from(r.W), D: Array.from(r.D), AW: Array.from(r.AW),
    alertBase: Array.from(r.alertBase), asleep: Array.from(r.asleep, Boolean),
  };
}
