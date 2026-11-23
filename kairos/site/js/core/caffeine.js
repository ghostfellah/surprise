// Caféine : pharmacocinétique d'ordre 1, effet saturable, coupure avant le coucher, suggestions.
//
// Hypothèses (sourcées dans docs/science.md) :
//  - Absorption d'ordre 1, élimination d'ordre 1 : quantité dans l'organisme
//      A(t) = D · ka/(ka − ke) · (e^{−ke·t} − e^{−ka·t}),  ke = ln 2 / demi-vie.
//    ka est calculé pour que le pic survienne ≈ 40 min après la prise (tmax 30–60 min : Blanchard & Sawers 1983 ;
//    Fredholm et al. 1999). Biodisponibilité ≈ 100 %. Demi-vie par défaut 5 h (3–9 h selon les individus,
//    le tabac, la grossesse, les contraceptifs oraux, le CYP1A2 : Nehlig 2018).
//  - Effet : antagonisme des récepteurs de l'adénosine (A1/A2A) ⇒ comme si la pression de sommeil S était réduite
//    (Fredholm 1999 ; Porkka-Heiskanen 2011). Courbe dose-effet saturable (Emax) :
//      points = EMAX · (mg·sens)/(EC50 + mg·sens) · g(S),   g(S) = 0,55 + 1,3·S
//    g(S) traduit que l'effet est plus marqué quand on est fatigué (Smith 2002 ; Lieberman 2002).
//    Valeurs EMAX = 16 pts, EC50 = 70 mg : choix de modélisation (ordres de grandeur d'études sur la vigilance
//    et le temps de réaction : 75–200 mg donnent l'essentiel de l'effet), pas des constantes mesurées.
//  - Pas de modèle de tolérance ni de « rebond » : voir « limites » dans docs/science.md.
//  - Coupure : dernier moment où une tasse de référence (80 mg) laisse ≤ seuil (25 mg) dans le sang au coucher
//    (Drake et al. 2013 : 400 mg encore 6 h avant le coucher réduisent le sommeil de > 1 h).
import { MIN, HOUR, DAY, clamp, fmtTime } from './time.js';
import { simulateProcessesRaw } from './chrono.js';

export const CAFFEINE = Object.freeze({
  tmaxMin: 40,
  emaxPts: 16,
  ec50Mg: 70,
  refDoseMg: 80,       // une tasse de café filtre ≈ 80–100 mg
  bedThresholdMg: 25,
  maxDailyMg: 400,     // repère EFSA 2015 pour l'adulte
});

const clampHalfLife = (h) => clamp(Number.isFinite(Number(h)) ? Number(h) : 5, 2, 12);
const sensitivity = (profile) => clamp(Number(profile?.caffeineSensitivity) || 1, 0.2, 3);

const rateCache = new Map();
/** { ke, ka } en 1/h pour une demi-vie donnée, tmax = CAFFEINE.tmaxMin. */
export function caffeineRates(halfLifeH = 5) {
  const hl = clampHalfLife(halfLifeH);
  let r = rateCache.get(hl);
  if (r) return r;
  const ke = Math.LN2 / hl;
  const target = CAFFEINE.tmaxMin / 60;
  const tmax = (ka) => Math.log(ka / ke) / (ka - ke);
  // tmax décroît quand ka croît : bissection.
  let lo = ke * 1.0001;
  let hi = 200;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (tmax(mid) > target) lo = mid; else hi = mid;
  }
  r = { ke, ka: (lo + hi) / 2 };
  rateCache.set(hl, r);
  return r;
}

/** Quantité (mg) dans l'organisme `dtH` heures après une prise de `mg`. */
export function caffeineAmount(mg, dtH, rates) {
  if (dtH <= 0) return 0;
  const { ka, ke } = rates;
  return (mg * ka) / (ka - ke) * (Math.exp(-ke * dtH) - Math.exp(-ka * dtH));
}

/** Tableau typé de caféine active (mg) sur n échantillons à partir de t0. */
export function caffeineCurveRaw(logs, profile, t0, stepMin, n) {
  const out = new Float64Array(n);
  const rates = caffeineRates(profile?.caffeineHalfLifeH);
  const stepMs = stepMin * MIN;
  const tEnd = t0 + (n - 1) * stepMs;
  const horizonH = (14 * Math.LN2) / rates.ke; // 14 demi-vies : < 0,01 % restant
  for (const l of logs || []) {
    const mg = Number(l?.mg);
    const tMs = Number(l?.tMs);
    if (!(mg > 0) || !Number.isFinite(tMs) || tMs > tEnd) continue;
    const i0 = Math.max(0, Math.ceil((tMs - t0) / stepMs));
    for (let i = i0; i < n; i++) {
      const dtH = (t0 + i * stepMs - tMs) / HOUR;
      if (dtH > horizonH) break;
      out[i] += caffeineAmount(mg, dtH, rates);
    }
  }
  return out;
}

/** caffeineCurve(logs, profile, t0, stepMin, n) -> number[] (mg dans l'organisme). */
export function caffeineCurve(logs, profile, t0, stepMin, n) {
  return Array.from(caffeineCurveRaw(logs, profile, t0, stepMin, n));
}

/** Caféine active (mg) à un instant donné. */
export function caffeineAt(logs, profile, ms) {
  const rates = caffeineRates(profile?.caffeineHalfLifeH);
  let sum = 0;
  for (const l of logs || []) {
    const mg = Number(l?.mg);
    if (mg > 0) sum += caffeineAmount(mg, (ms - Number(l.tMs)) / HOUR, rates);
  }
  return sum;
}

/**
 * Gain d'alerte (points) pour `mg` de caféine active. `S` (0..1) module l'effet : fatigué, on en profite plus.
 * Sans `S`, on suppose un niveau moyen (0,35) pour lequel g = 1.
 */
export function alertnessBoost(mg, profile, { S = 0.35 } = {}) {
  if (!(mg > 0)) return 0;
  const m = mg * sensitivity(profile);
  const sat = m / (CAFFEINE.ec50Mg + m);
  return CAFFEINE.emaxPts * sat * (0.55 + 1.3 * clamp(S, 0, 1));
}

/**
 * Dernière heure raisonnable pour une tasse de référence : après elle, la caféine restante au coucher
 * dépasserait `thresholdMg`, compte tenu des prises déjà enregistrées.
 * Si les prises existantes dépassent déjà le seuil, renvoie l'heure de la première prise concernée
 * (« c'était déjà trop tard »).
 */
export function caffeineCutoff({ logs = [], profile, bedMs, thresholdMg = CAFFEINE.bedThresholdMg, doseMg = CAFFEINE.refDoseMg }) {
  const rates = caffeineRates(profile?.caffeineHalfLifeH);
  const existing = caffeineAt(logs.filter((l) => Number(l.tMs) < bedMs), profile, bedMs);
  const room = thresholdMg - existing;
  if (room <= 0) {
    const times = logs.filter((l) => Number(l.mg) > 0 && Number(l.tMs) < bedMs && Number(l.tMs) > bedMs - DAY).map((l) => Number(l.tMs));
    return times.length ? Math.min(...times) : bedMs - 12 * HOUR;
  }
  // A(dt) croissante puis décroissante : on cherche le plus petit dt ≥ tmax tel que A(dt) ≤ room/dose.
  let lo = CAFFEINE.tmaxMin / 60;
  let hi = 72;
  if (caffeineAmount(doseMg, lo, rates) <= room) return bedMs - lo * HOUR; // dose si faible que toute prise passe
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (caffeineAmount(doseMg, mid, rates) > room) lo = mid; else hi = mid;
  }
  return bedMs - hi * HOUR;
}

/**
 * Prises recommandées : maximisent l'alerte utile (là où l'alerte de base est basse) sans dépasser le seuil au coucher.
 * Accepte soit un `model` déjà construit, soit les entrées de buildModel.
 * Nuance honnête : l'idée d'attendre 60-90 min après le réveil (pic de cortisol) est faiblement étayée
 * (peu d'essais contrôlés) ; on n'applique qu'un léger malus à cette plage, jamais une interdiction.
 * @returns {{tMs:number, mg:number, why:string, peakBoostPts:number, atBedMg:number}[]}
 */
export function suggestCaffeine({
  profile, sleeps = [], caffeine = [], fromMs, hours = 24, stepMin = 5, nowMs = fromMs,
  whatIf, wantPeakAtMs, model, doseMg = CAFFEINE.refDoseMg, maxDoses = 3,
}) {
  let m = model;
  if (!m) {
    const n0 = Math.round((hours * 60) / stepMin) + 1;
    const sim = simulateProcessesRaw({
      sleeps, extra: [...(whatIf?.sleeps || []), ...(whatIf?.extraNaps || []).map((x) => ({ bedMs: x.startMs, wakeMs: x.endMs, nap: true }))],
      profile, fromMs, toMs: fromMs + hours * HOUR, stepMin,
    });
    const logs = [...caffeine, ...(whatIf?.caffeine || [])];
    m = { t0: sim.t0, stepMin, n: n0, S: sim.S, alertBase: sim.alertBase, asleep: sim.asleep, caffeineMg: caffeineCurveRaw(logs, profile, sim.t0, stepMin, n0) };
  }
  const n = m.n;
  const stepMs = m.stepMin * MIN;
  const idx = (ms) => clamp(Math.round((ms - m.t0) / stepMs), 0, n - 1);
  const rates = caffeineRates(profile?.caffeineHalfLifeH);
  const i0 = idx(nowMs);

  // Dernier réveil et prochain coucher « de nuit ».
  let wakeMs = m.t0;
  for (let i = i0; i > 0; i--) if (m.asleep[i - 1] && !m.asleep[i]) { wakeMs = m.t0 + i * stepMs; break; }
  let bedMs = m.t0 + (n - 1) * stepMs;
  for (let i = i0 + 1; i < n; i++) {
    if (m.asleep[i] && !m.asleep[i - 1]) {
      let k = i; while (k < n && m.asleep[k]) k++;
      if ((k - i) * stepMs >= 3 * HOUR) { bedMs = m.t0 + i * stepMs; break; }
    }
  }
  const thr = CAFFEINE.bedThresholdMg;
  const chosen = [];
  const mg = Float64Array.from(m.caffeineMg);
  const bedIdx = idx(bedMs);
  const stride = Math.max(1, Math.round(15 / m.stepMin));
  // Utilité d'un instant : plus l'alerte de base est basse, plus un coup de pouce sert (éveillé seulement).
  const peakW = (t) => (wantPeakAtMs ? 0.25 + 4 * Math.exp(-0.5 * ((t - wantPeakAtMs) / (45 * MIN)) ** 2) : 1);

  for (let pick = 0; pick < maxDoses; pick++) {
    let best = null;
    const earliest = Math.max(nowMs, wakeMs + 20 * MIN);
    for (let i = Math.ceil((earliest - m.t0) / stepMs); i < bedIdx; i += stride) {
      if (i < 0 || m.asleep[i]) continue;
      const T = m.t0 + i * stepMs;
      if (chosen.some((c) => Math.abs(c.tMs - T) < 3 * HOUR)) continue;
      // Contrainte coucher : résidu existant + cette prise ≤ seuil.
      const atBed = mg[bedIdx] + caffeineAmount(doseMg, (bedMs - T) / HOUR, rates);
      if (atBed > thr) continue;
      let gain = 0;
      const iEnd = Math.min(bedIdx, i + Math.round((8 * HOUR) / stepMs));
      for (let k = i; k <= iEnd; k++) {
        if (m.asleep[k]) continue;
        const e = caffeineAmount(doseMg, (m.t0 + k * stepMs - T) / HOUR, rates);
        if (e <= 0) continue;
        const use = (1 - m.alertBase[k] / 100) * peakW(m.t0 + k * stepMs);
        gain += use * (alertnessBoost(mg[k] + e, profile, { S: m.S[k] }) - alertnessBoost(mg[k], profile, { S: m.S[k] })) * (m.stepMin / 60);
      }
      if (T - wakeMs < 90 * MIN) gain *= 0.85; // léger malus « cortisol du réveil » (faiblement étayé)
      if (!best || gain > best.gain) best = { i, T, gain, atBed };
    }
    if (!best || best.gain < 1.5) break;
    // Intègre la prise choisie dans la courbe pour les suivantes.
    for (let k = best.i; k < n; k++) mg[k] += caffeineAmount(doseMg, (m.t0 + k * stepMs - best.T) / HOUR, rates);
    // Pic d'effet : on le lit sur la courbe.
    let peak = 0; let peakI = best.i;
    for (let k = best.i; k <= Math.min(n - 1, best.i + Math.round((3 * HOUR) / stepMs)); k++) {
      const b = alertnessBoost(caffeineAmount(doseMg, (m.t0 + k * stepMs - best.T) / HOUR, rates), profile, { S: m.S[k] });
      if (b > peak) { peak = b; peakI = k; }
    }
    chosen.push({ tMs: best.T, mg: doseMg, peakBoostPts: Math.round(peak * 10) / 10, atBedMg: Math.round(best.atBed * 10) / 10, peakMs: m.t0 + peakI * stepMs, base: m.alertBase[idx(best.T + 45 * MIN)] });
  }

  chosen.sort((a, b) => a.tMs - b.tMs);
  return chosen.map((c, k) => {
    const early = c.tMs - wakeMs < 90 * MIN;
    let why = `Ton alerte de base est prévue à ${Math.round(c.base)}/100 vers ${fmtTime(c.tMs + 45 * MIN)} : `
      + `${c.mg} mg (≈ une tasse) te donnent ≈ +${Math.round(c.peakBoostPts)} pts, avec un pic d'effet vers ${fmtTime(c.peakMs)}. `
      + `Il n'en restera que ${Math.round(c.atBedMg)} mg au coucher.`;
    if (wantPeakAtMs && Math.abs(c.peakMs - wantPeakAtMs) < 60 * MIN) why = `Pour être au mieux vers ${fmtTime(wantPeakAtMs)} : ${why}`;
    if (early) why += ' (Attendre 60-90 min après le réveil est parfois conseillé, mais c\'est peu démontré : à toi de voir.)';
    if (k > 0) why += ' À espacer d\'au moins 3 h de la prise précédente.';
    return { tMs: c.tMs, mg: c.mg, why, peakBoostPts: c.peakBoostPts, atBedMg: c.atBedMg };
  });
}
