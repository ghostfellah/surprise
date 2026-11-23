// Labo « et si ? » : scénarios de journée et optimiseur déterministe.
//
// Module PUR (aucun accès à window/document/localStorage) : importable dans Node et dans le navigateur.
//
// Hypothèses (voir aussi docs/science.md pour le modèle sous-jacent) :
//  - Un scénario décrit ce qui est modifiable dans la journée de `dayMs` : la nuit dernière (réveil de ce matin),
//    la nuit prochaine, les prises de caféine du jour et une sieste facultative. Tout le reste (jours passés,
//    profil) vient de l'état réel. Le modèle est celui de buildModel : on ne réécrit aucune physiologie ici.
//  - Score = alerte moyenne prédite sur les heures de travail du profil. Les minutes de sieste y comptent à
//    `LAB.napCredit` (60/100) : dormir n'est pas du temps « perdu » mais ce n'est pas du travail non plus.
//    Sans ce crédit, l'optimiseur proposerait une sieste tous les jours (le sommeil fait baisser S gratuitement).
//  - Contrainte de sommeil : la caféine restante au coucher doit rester ≤ seuil (25 mg par défaut, cf. caffeine.js),
//    et le temps de sommeil (hors latence de 15 min) doit couvrir le besoin du profil — si le besoin est inatteignable
//    dans la fenêtre explorée (coucher habituel −2 h … +1 h), on prend le coucher le plus précoce testé.
//  - Optimisation : grille + descente par coordonnées, entièrement déterministe (aucun aléa). Pour tenir dans
//    quelques dizaines de ms, les processus S/C sont simulés une fois par variante (coucher × sieste) et l'effet de
//    la caféine est recalculé à la volée avec EXACTEMENT les formules de model.js (même résultat qu'un buildModel).
//  - Pénalité douce de 0,003 point par mg ajouté : à gain égal, on préfère moins de caféine.
//  - Le « risque pour le sommeil » et l'heure d'endormissement estimée sont des HEURISTIQUES de confort (la latence
//    d'endormissement augmente avec la caféine résiduelle : Drake et al. 2013 ; Clark & Landolt 2017), pas une mesure.
import { MIN, HOUR, startOfDay, atMinutes, parseHHMM, clamp, fmtTime, fmtDuration, fmtDateFR } from './time.js';
import { simulateProcessesRaw } from './chrono.js';
import { buildModel } from './model.js';
import { caffeineRates, caffeineAmount, alertnessBoost, caffeineAt, CAFFEINE } from './caffeine.js';
import { sleepNeedH, SLEEP_LATENCY_MIN, MAIN_SLEEP_MIN_H } from './sleep.js';

export const LAB = Object.freeze({
  horizonH: 36,          // de 00:00 du jour à midi le lendemain : on voit la nuit et le réveil suivant
  doses: [40, 60, 80, 100, 120],
  maxDoseMg: 120,        // une grande tasse ; au-delà, on conseille plutôt d'espacer
  maxDoses: 3,
  minGapMin: 120,        // écart minimal entre deux prises planifiées
  napCredit: 60,
  napDurMin: 20,
  mgPenalty: 0.003,
  minGain: 0.12,         // gain (pts d'alerte moyenne) en dessous duquel une prise n'est pas conseillée
  napMinGain: 0.3,
});

/** « Café » / « thé » / « expresso » d'après la dose (valeurs par défaut de l'app : 80 / 40 / 63 mg). */
export const kindForMg = (mg) => (mg <= 45 ? 'thé' : mg <= 70 ? 'expresso' : 'café');

const topClip = (x) => (x <= 90 ? x : 90 + 10 * Math.tanh((x - 90) / 10));

function safeHHMM(s, fallback) { try { return parseHHMM(s); } catch { return fallback; } }

// ---------------------------------------------------------------------------------------------
// Fenêtre de travail et métriques
// ---------------------------------------------------------------------------------------------

/** Heures de travail du profil, le jour de `dayMs`. */
export function workWindow(profile = {}, dayMs, objective = {}) {
  const day = startOfDay(dayMs);
  let s = objective.workStartMin ?? safeHHMM(profile.workStart, 540);
  let e = objective.workEndMin ?? safeHHMM(profile.workEnd, 1080);
  if (e <= s) { s = 540; e = 1080; }
  return { startMs: atMinutes(day, s), endMs: atMinutes(day, e) };
}

/** Alerte moyenne sur [startMs, endMs] ; les échantillons de sommeil comptent à `napCredit` (voir en-tête). */
export function workScore(model, startMs, endMs, napCredit = LAB.napCredit) {
  const step = model.stepMin * MIN;
  const i0 = Math.max(0, Math.ceil((startMs - model.t0) / step));
  const i1 = Math.min(model.alert.length - 1, Math.floor((endMs - model.t0) / step));
  let sum = 0; let n = 0;
  for (let i = i0; i <= i1; i++) { sum += model.asleep[i] ? napCredit : model.alert[i]; n++; }
  return n ? sum / n : 0;
}

/** Minutes éveillées de [startMs, endMs] où l'alerte atteint `thr` (la « zone d'or » du Labo). */
export function minutesAbove(model, startMs, endMs, thr) {
  const step = model.stepMin * MIN;
  const i0 = Math.max(0, Math.ceil((startMs - model.t0) / step));
  const i1 = Math.min(model.alert.length - 1, Math.floor((endMs - model.t0) / step));
  let n = 0;
  for (let i = i0; i <= i1; i++) if (!model.asleep[i] && model.alert[i] >= thr) n++;
  return n * model.stepMin;
}

/** Retard d'endormissement estimé (minutes) pour une caféine résiduelle donnée : heuristique, cf. en-tête. */
export const onsetLatencyMin = (atBedMg) => SLEEP_LATENCY_MIN + Math.max(0, atBedMg - 10) * 0.35;

/**
 * Risque pour le sommeil : combine caféine résiduelle au coucher et durée de sommeil vs besoin.
 * @returns {{level:'faible'|'modéré'|'élevé', score:number, why:string}}  score 0..1
 */
export function sleepRisk({ atBedMg = 0, sleepH = 8, needH = 8 } = {}) {
  const c = clamp((atBedMg - 10) / 60, 0, 1);              // 70 mg et plus : maximum
  const d = clamp((needH - sleepH) / 3, 0, 1);              // 3 h de moins que le besoin : maximum
  const score = clamp(0.65 * c + 0.45 * d, 0, 1);
  const level = score < 0.2 ? 'faible' : score < 0.5 ? 'modéré' : 'élevé';
  const parts = [];
  if (atBedMg > CAFFEINE.bedThresholdMg) parts.push(`${Math.round(atBedMg)} mg de caféine encore dans le sang au coucher`);
  if (needH - sleepH > 0.4) parts.push(`${fmtDuration(Math.round((needH - sleepH) * 60))} de moins que ton besoin`);
  const why = parts.length ? `${parts.join(' et ')}.` : 'Peu de caféine au coucher et une nuit qui couvre ton besoin.';
  return { level, score, why };
}

/**
 * Métriques comparables d'un scénario (même fonction pour la référence et le scénario).
 * `goldenThr` : seuil d'alerte de la « zone d'or », fixé par la référence (son 75e centile).
 */
export function scenarioMetrics({ model, profile, dayMs, scenario, objective = {}, goldenThr = 75 }) {
  const win = workWindow(profile, dayMs, objective);
  const day = startOfDay(dayMs);
  const tonight = scenario.tonight;
  const bedMs = tonight ? tonight.bedMs : day + 23 * HOUR;
  const wakeMs = tonight ? tonight.wakeMs : bedMs + 8 * HOUR;
  const logs = scenario.caffeine || [];
  const priorLogs = scenario.priorCaffeine || [];
  const atBedMg = caffeineAt([...priorLogs, ...logs].filter((l) => l.tMs < bedMs), profile, bedMs);
  const sleepH = Math.max(0, (wakeMs - bedMs) / HOUR - SLEEP_LATENCY_MIN / 60);
  const needH = sleepNeedH(profile);
  const onsetMs = bedMs + onsetLatencyMin(atBedMg) * MIN;
  const dl = (model.stats.dlmoList || []).find((d) => d >= day + 12 * HOUR) ?? model.stats.dlmoMs;
  const risk = sleepRisk({ atBedMg, sleepH, needH });
  const lastCaf = logs.length ? Math.max(...logs.map((l) => l.tMs)) : null;
  return {
    meanWork: workScore(model, win.startMs, win.endMs),
    goldenMin: minutesAbove(model, win.startMs, win.endMs, goldenThr),
    atBedMg, onsetMs, dlmoMs: dl, bedMs, wakeMs, sleepH, needH, risk,
    totalMg: logs.reduce((a, l) => a + (Number(l.mg) || 0), 0), lastCaffeineMs: lastCaf,
    window: win,
  };
}

// ---------------------------------------------------------------------------------------------
// Scénarios
// ---------------------------------------------------------------------------------------------

/**
 * Convertit un scénario en `whatIf` de buildModel.
 * Scénario : { lastNight: {bedMs, wakeMs}|null, tonight: {bedMs, wakeMs}|null, caffeine: [{tMs, mg, kind?}], nap: {startMs, endMs}|null }
 */
export function scenarioToWhatIf(sc) {
  const sleeps = [sc.lastNight, sc.tonight].filter(Boolean).map((s) => ({ bedMs: s.bedMs, wakeMs: s.wakeMs }));
  return {
    sleeps,
    caffeine: (sc.caffeine || []).filter((c) => c.mg > 0).map((c) => ({ tMs: c.tMs, mg: c.mg, kind: c.kind })),
    extraNaps: sc.nap ? [{ startMs: sc.nap.startMs, endMs: sc.nap.endMs }] : [],
  };
}

/** Données réelles qui NE sont PAS rejouées par le scénario (tout ce qui touche la journée est dans le scénario). */
function baseInputs(sleeps, caffeine, dayMs) {
  const day = startOfDay(dayMs);
  return {
    sleeps: (sleeps || []).filter((s) => !(s.wakeMs > day - 4 * HOUR)),
    caffeine: (caffeine || []).filter((c) => c.tMs < day),
  };
}

/** Modèle d'un scénario : le passé réel + le scénario pour la journée. */
export function buildScenarioModel({ profile, sleeps = [], caffeine = [], dayMs, scenario, hours = LAB.horizonH }) {
  const day = startOfDay(dayMs);
  const base = baseInputs(sleeps, caffeine, day);
  return buildModel({ profile, sleeps: base.sleeps, caffeine: base.caffeine, fromMs: day, hours, nowMs: day, whatIf: scenarioToWhatIf(scenario) });
}

/** Scénario « référence » : ce que dit l'état réel (journaux + habitudes du profil) pour le jour de `dayMs`. */
export function referenceScenario({ profile, sleeps = [], caffeine = [], dayMs, hours = LAB.horizonH }) {
  const day = startOfDay(dayMs);
  const model = buildModel({ profile, sleeps, caffeine, fromMs: day, hours, nowMs: day });
  const main = model.episodes.filter((e) => !e.nap && (e.endMs - e.startMs) / HOUR >= MAIN_SLEEP_MIN_H);
  const last = main.find((e) => e.endMs > day) || null;
  const tonight = main.find((e) => (last ? e.startMs >= last.endMs : e.startMs > day)) || null;
  const nap = model.episodes.find((e) => e.nap && e.endMs > day && e.startMs < day + hours * HOUR) || null;
  const scenario = {
    lastNight: last ? { bedMs: last.startMs, wakeMs: last.endMs } : null,
    tonight: tonight ? { bedMs: tonight.startMs, wakeMs: tonight.endMs } : null,
    caffeine: caffeine.filter((c) => c.tMs >= day && c.tMs < day + hours * HOUR).map((c) => ({ tMs: c.tMs, mg: c.mg, kind: c.kind })),
    nap: nap ? { startMs: nap.startMs, endMs: nap.endMs } : null,
    priorCaffeine: caffeine.filter((c) => c.tMs < day).map((c) => ({ tMs: c.tMs, mg: c.mg })),
  };
  return { scenario, model };
}

// ---------------------------------------------------------------------------------------------
// Optimiseur
// ---------------------------------------------------------------------------------------------

const roundTo = (ms, minutes) => Math.round(ms / (minutes * MIN)) * (minutes * MIN);

/** Prépare l'évaluation rapide d'une variante (coucher × sieste) : séries S/AW/alertBase échantillonnées sur la fenêtre. */
function prepareVariant({ profile, baseSleeps, scenario, win, keptLogs, rates }) {
  const day = startOfDay(win.startMs);
  const wi = scenarioToWhatIf({ ...scenario, caffeine: [] });
  const sim = simulateProcessesRaw({
    sleeps: baseSleeps, extra: [...wi.sleeps, ...wi.extraNaps.map((x) => ({ bedMs: x.startMs, wakeMs: x.endMs, nap: true }))],
    profile, fromMs: day, toMs: day + LAB.horizonH * HOUR, stepMin: 5,
  });
  const step = 5 * MIN;
  const i0 = Math.max(0, Math.ceil((win.startMs - sim.t0) / step));
  const i1 = Math.min(sim.n - 1, Math.floor((win.endMs - sim.t0) / step));
  const ts = []; const ab = []; const S = []; const aw = []; const asl = []; const baseMg = [];
  for (let i = i0; i <= i1; i += 2) { // un échantillon sur deux : suffisant pour classer les candidats
    const t = sim.t0 + i * step;
    ts.push(t); ab.push(sim.alertBase[i]); S.push(sim.S[i]); aw.push(sim.AW[i]); asl.push(sim.asleep[i] === 1);
    let mg = 0; for (const l of keptLogs) mg += caffeineAmount(l.mg, (t - l.tMs) / HOUR, rates);
    baseMg.push(mg);
  }
  const bedMs = scenario.tonight.bedMs;
  let baseAtBed = 0; for (const l of keptLogs) if (l.tMs < bedMs) baseAtBed += caffeineAmount(l.mg, (bedMs - l.tMs) / HOUR, rates);
  return { ts, ab, S, aw, asl, baseMg, baseAtBed, bedMs, nap: scenario.nap, n: ts.length };
}

/** Score interne d'un plan de prises (−∞ si une contrainte est violée). */
function evalPlan(v, plan, ctx) {
  const { profile, rates, thr } = ctx;
  let atBed = v.baseAtBed; let planned = 0;
  for (let a = 0; a < plan.length; a++) {
    const d = plan[a];
    if (d.tMs > v.bedMs - 2 * HOUR || d.tMs < ctx.earliestMs) return -Infinity;
    if (v.nap && d.tMs > v.nap.startMs - 30 * MIN && d.tMs < v.nap.endMs) return -Infinity;
    for (let b = a + 1; b < plan.length; b++) if (Math.abs(plan[b].tMs - d.tMs) < LAB.minGapMin * MIN) return -Infinity;
    atBed += caffeineAmount(d.mg, (v.bedMs - d.tMs) / HOUR, rates);
    planned += d.mg;
  }
  if (atBed > Math.max(thr, v.baseAtBed) + 1e-9) return -Infinity;
  if (ctx.keptMg + planned > CAFFEINE.maxDailyMg) return -Infinity;
  let sum = 0;
  for (let k = 0; k < v.n; k++) {
    if (v.asl[k]) { sum += LAB.napCredit; continue; }
    let mg = v.baseMg[k];
    for (const d of plan) { const dt = (v.ts[k] - d.tMs) / HOUR; if (dt > 0) mg += caffeineAmount(d.mg, dt, rates); }
    sum += clamp(topClip(v.ab[k] + alertnessBoost(mg, profile, { S: v.S[k] }) * v.aw[k]), 0, 100);
  }
  return sum / v.n - LAB.mgPenalty * planned;
}

/** Recherche du meilleur plan de prises pour une variante : gloutonne puis descente par coordonnées. */
function searchCaffeine(v, ctx) {
  let plan = [];
  let best = evalPlan(v, plan, ctx);
  const t0 = Math.ceil(Math.max(ctx.earliestMs, ctx.win.startMs - 3 * HOUR) / (15 * MIN)) * (15 * MIN);
  const tEnd = Math.min(ctx.win.endMs, v.bedMs - 3 * HOUR);
  for (let pick = 0; pick < ctx.maxDoses; pick++) {
    let cand = null;
    for (let t = t0; t <= tEnd; t += 30 * MIN) {
      for (const mg of LAB.doses) {
        const p = [...plan, { tMs: t, mg }];
        const s = evalPlan(v, p, ctx);
        if (s > (cand ? cand.s : best + LAB.minGain)) cand = { s, p };
      }
    }
    if (!cand) break;
    plan = cand.p; best = cand.s;
  }
  // descente : décaler de ±15/30 min, ajuster la dose de ±20 mg
  for (let pass = 0; pass < 5; pass++) {
    let improved = false;
    for (let j = 0; j < plan.length; j++) {
      for (const [dt, dm] of [[-30, 0], [-15, 0], [15, 0], [30, 0], [0, -20], [0, 20], [-15, 20], [15, 20], [-15, -20], [15, -20]]) {
        const mg = plan[j].mg + dm;
        if (mg < 30 || mg > LAB.maxDoseMg) continue;
        const p = plan.map((d, k) => (k === j ? { tMs: d.tMs + dt * MIN, mg } : d));
        const s = evalPlan(v, p, ctx);
        if (s > best + 1e-6) { plan = p; best = s; improved = true; }
      }
    }
    if (!improved) break;
  }
  // élagage : une prise qui rapporte moins que `minGain` est retirée
  for (let j = plan.length - 1; j >= 0; j--) {
    const p = plan.filter((_, k) => k !== j);
    const s = evalPlan(v, p, ctx);
    if (s > best - LAB.minGain) { plan = p; best = s; }
  }
  plan.sort((a, b) => a.tMs - b.tMs);
  return { plan, score: best };
}

const decimal = (x, d = 1) => x.toFixed(d).replace('.', ',');

/**
 * Meilleur plan de la journée pour maximiser l'alerte moyenne sur les heures de travail.
 * @param {object} p
 * @param {object} p.profile @param {Array} [p.sleeps] @param {Array} [p.caffeine] journaux réels
 * @param {number} p.dayMs un instant du jour visé
 * @param {object} [p.objective] { thresholdMg = 25, maxDoses = 3, allowNap = true, allowBedtime = true,
 *   earliestMs (pas de prise avant : « maintenant »), workStartMin, workEndMin }
 * @returns {{scenario, baselineScenario, baselineScore:number, score:number, gainPct:number, explain:string[], changed:boolean,
 *            plan:{caffeine:object[], bedMs:number, nap:object|null}}}
 */
export function optimizeDay({ profile, sleeps = [], caffeine = [], dayMs, objective = {} }) {
  const obj = { thresholdMg: CAFFEINE.bedThresholdMg, maxDoses: LAB.maxDoses, allowNap: true, allowBedtime: true, earliestMs: null, ...objective };
  const day = startOfDay(dayMs);
  const win = workWindow(profile, day, obj);
  const rates = caffeineRates(profile?.caffeineHalfLifeH);
  const { scenario: ref, model: refModel } = referenceScenario({ profile, sleeps, caffeine, dayMs: day });
  const baselineScore = workScore(refModel, win.startMs, win.endMs);
  const base = baseInputs(sleeps, caffeine, day);
  const keptLogs = [...ref.priorCaffeine, ...ref.caffeine].map((l) => ({ tMs: l.tMs, mg: l.mg }));
  const lastNight = ref.lastNight;
  const wakeMs = lastNight ? lastNight.wakeMs : day + 7 * HOUR;
  const earliestMs = Math.max(obj.earliestMs ?? -Infinity, wakeMs + 30 * MIN);
  const keptMg = keptLogs.filter((l) => l.tMs >= day).reduce((a, l) => a + l.mg, 0);
  const ctx = { profile, rates, thr: obj.thresholdMg, win, earliestMs, keptMg, maxDoses: obj.maxDoses };

  const tonight0 = ref.tonight || { bedMs: day + 23 * HOUR, wakeMs: day + 31 * HOUR };
  const needMin = sleepNeedH(profile) * 60;
  // Coucher : le plus TARD qui couvre encore le besoin de sommeil (dans [habituel −2 h, habituel +1 h]) — c'est lui
  // qui laisse le plus de marge à la dernière tasse. Règle plutôt que recherche : le modèle interpole la phase
  // circadienne entre deux réveils, donc la durée de la nuit prochaine « déborde » un peu sur l'alerte d'aujourd'hui,
  // un artefact qu'une recherche exploiterait (elle conseillerait de se coucher à 21 h pour gagner 0,3 point).
  let beds = [tonight0.bedMs];
  if (obj.allowBedtime) {
    const latest = tonight0.wakeMs - (needMin + SLEEP_LATENCY_MIN) * MIN;
    const lo = tonight0.bedMs - 120 * MIN; const hi = tonight0.bedMs + 60 * MIN;
    beds = [roundTo(clamp(latest, lo, hi), 15)];
    if (beds[0] > latest + 1) beds = [Math.floor(latest / (15 * MIN)) * 15 * MIN];
    beds = [Math.max(lo, beds[0])];
  }

  const variant = (bedMs, nap) => ({ ...ref, tonight: { bedMs, wakeMs: tonight0.wakeMs }, nap: nap || ref.nap });
  const run = (bedMs, nap) => {
    const sc = variant(bedMs, nap);
    const v = prepareVariant({ profile, baseSleeps: base.sleeps, scenario: sc, win, keptLogs, rates });
    return { ...searchCaffeine(v, ctx), bedMs, nap: sc.nap };
  };

  // 1. coucher × caféine
  let best = null;
  for (const bedMs of beds) {
    const r = run(bedMs, null);
    if (!best || r.score > best.score + 1e-9 || (Math.abs(r.score - best.score) <= 1e-9 && Math.abs(bedMs - tonight0.bedMs) < Math.abs(best.bedMs - tonight0.bedMs))) best = r;
  }
  // 2. sieste facultative (une seule durée : 20 min, qui évite l'inertie)
  if (obj.allowNap && !ref.nap) {
    let napBest = null;
    const nStart = Math.ceil(Math.max(earliestMs, wakeMs + 4 * HOUR) / (30 * MIN)) * (30 * MIN);
    for (let s = nStart; s + LAB.napDurMin * MIN <= best.bedMs - 6 * HOUR && s <= win.endMs; s += 30 * MIN) {
      const r = run(best.bedMs, { startMs: s, endMs: s + LAB.napDurMin * MIN });
      if (r.score > (napBest ? napBest.score : best.score + LAB.napMinGain)) napBest = r;
    }
    if (napBest) best = napBest;
  }

  const planned = best.plan.map((d) => ({ tMs: roundTo(d.tMs, 5), mg: Math.round(d.mg / 5) * 5, kind: kindForMg(d.mg), planned: true }));
  const scenario = {
    ...ref,
    tonight: { bedMs: best.bedMs, wakeMs: tonight0.wakeMs },
    caffeine: [...ref.caffeine, ...planned].sort((a, b) => a.tMs - b.tMs),
    nap: best.nap || null,
  };
  const model = buildScenarioModel({ profile, sleeps, caffeine, dayMs: day, scenario });
  let score = workScore(model, win.startMs, win.endMs);

  // Garde-fou : on ne propose jamais pire que la référence (la grille travaille sur 1 échantillon sur 2).
  const noChange = !(score > baselineScore + 1e-6);
  if (noChange) {
    return {
      scenario: { ...ref }, baselineScenario: ref, baselineScore, score: baselineScore, gainPct: 0, changed: false,
      explain: ['Ta journée est déjà bien calée : je ne trouve pas de plan qui fasse mieux sans abîmer ta nuit.'],
      plan: { caffeine: [], bedMs: tonight0.bedMs, nap: ref.nap },
    };
  }
  const gainPct = (score / baselineScore - 1) * 100;

  // --- explications en français ---
  const explain = [];
  const fmtWin = `${fmtTime(win.startMs)}–${fmtTime(win.endMs)}`;
  explain.push(`Alerte moyenne ${fmtWin} : ${decimal(baselineScore)} → ${decimal(score)} sur 100 (${gainPct >= 0 ? '+' : '−'}${decimal(Math.abs(gainPct))} %).`);
  const refModelBase = refModel.alertBase;
  planned.forEach((d, k) => {
    const idx = clamp(Math.round((d.tMs + 45 * MIN - refModel.t0) / (5 * MIN)), 0, refModelBase.length - 1);
    const lowish = refModelBase[idx];
    const first = k === 0; const last = k === planned.length - 1 && planned.length > 1;
    explain.push(`${fmtTime(d.tMs)} · ${d.kind} (${d.mg} mg) : ${first ? 'ton premier coup de pouce, ' : last ? 'le dernier, ' : ''}`
      + `ton énergie « naturelle » est à ${Math.round(lowish)}/100 vers ${fmtTime(d.tMs + 45 * MIN)}, c'est là qu'il sert le plus.`);
  });
  if (!planned.length) explain.push('Pas de café supplémentaire utile : le gain vient du coucher et de la sieste.');
  const m = scenarioMetrics({ model, profile, dayMs: day, scenario, objective: obj, goldenThr: refModel.stats.p75 ?? 75 });
  explain.push(`Caféine au coucher : ${Math.round(m.atBedMg)} mg (seuil ${obj.thresholdMg} mg) — ton sommeil est protégé.`);
  if (Math.abs(best.bedMs - tonight0.bedMs) >= 10 * MIN) {
    const later = best.bedMs > tonight0.bedMs;
    explain.push(`Coucher à ${fmtTime(best.bedMs)} au lieu de ${fmtTime(tonight0.bedMs)} : ${later ? 'un peu plus tard, ça laisse de la marge à ta dernière tasse tout en couvrant' : 'un peu plus tôt, pour couvrir'} ton besoin de ${fmtDuration(Math.round(needMin))} de sommeil.`);
  }
  if (best.nap && !ref.nap) explain.push(`Sieste de ${LAB.napDurMin} min à ${fmtTime(best.nap.startMs)} : assez courte pour éviter l'inertie, elle relève l'après-midi.`);
  const priorSum = ref.caffeine.reduce((a, c) => a + c.mg, 0);
  if (priorSum + planned.reduce((a, c) => a + c.mg, 0) > 300) explain.push('Attention : ça fait pas mal de caféine sur la journée. Le repère de santé reste 400 mg maximum.');

  return { scenario, baselineScenario: ref, baselineScore, score, gainPct, explain, changed: true, plan: { caffeine: planned, bedMs: best.bedMs, nap: best.nap || null } };
}

// ---------------------------------------------------------------------------------------------
// Texte du plan (copier / partager)
// ---------------------------------------------------------------------------------------------

/** Plan lisible d'un scénario, pour le presse-papiers ou un rappel. */
export function planText(scenario, { dayMs, optimized = null } = {}) {
  const lines = [`Mon plan énergie · ${fmtDateFR(dayMs)}`];
  const caf = (scenario.caffeine || []).filter((c) => c.planned || !optimized);
  if (caf.length) for (const c of caf) lines.push(`• ${fmtTime(c.tMs)} — ${c.kind || 'café'} (${c.mg} mg)`);
  else lines.push('• Pas de caféine prévue');
  if (scenario.nap) lines.push(`• ${fmtTime(scenario.nap.startMs)} — sieste de ${Math.round((scenario.nap.endMs - scenario.nap.startMs) / MIN)} min`);
  if (scenario.tonight) lines.push(`• ${fmtTime(scenario.tonight.bedMs)} — coucher (réveil ${fmtTime(scenario.tonight.wakeMs)})`);
  if (optimized && optimized.changed) lines.push(`Gain estimé : +${decimal(optimized.gainPct)} % d'alerte moyenne pendant les heures de travail.`);
  lines.push('Estimation Kairos : un outil de confort, pas un avis médical.');
  return lines.join('\n');
}
