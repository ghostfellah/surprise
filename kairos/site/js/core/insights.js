// Bilan de Kairos : statistiques sur 7 / 28 jours, constats chiffrés en français et ajustement personnel du modèle.
//
// Hypothèses et choix (documentés pour rester honnête) :
//  - « Nuit » = sommeil de ≥ 3 h hors sieste ; elle est rattachée au JOUR DU RÉVEIL (convention de sleep.js).
//  - Régularité : écart-type de l'heure de coucher (en minutes, mesurée depuis 18 h pour éviter le saut de minuit).
//    ≤ 15 min → 100/100 ; ≥ 90 min → 0/100 (interpolation linéaire). Repère de lecture, pas une norme médicale.
//  - « Jet lag social » : écart des milieux de sommeil jours libres / jours travaillés (Roenneberg et al. 2006).
//  - Caféine au coucher : on rejoue les prises réelles avec la demi-vie du profil (caffeine.js) à l'heure de coucher
//    RÉELLE de chaque nuit des 14 derniers jours. Le repère « ≈ 25 mg » vient de caffeine.js (CAFFEINE.bedThresholdMg).
//  - « Pic » : une session de concentration est dite « dans un pic » si l'alerte prédite moyenne pendant la session
//    dépasse le 75e centile de l'alerte éveillée des 6 dernières semaines (soit les 25 % meilleurs moments) ;
//    le hasard donnerait ≈ 25 %. La part n'est affichée qu'à partir de 3 sessions.
//  - Précision du modèle : prédit (buildModel) vs ressenti (check-in 1..5 → 0..100 via checkinToAlert). RMSE, biais,
//    corrélation de Pearson. Le « ressenti » est une échelle grossière à 5 niveaux : un RMSE de 10-12 points est déjà
//    proche du plancher imposé par l'arrondi.
//  - personalizeFromState ajuste chronoShiftMin (± 3 h) et sleepNeedH (6-10 h) par Nelder–Mead (personalize.js).
//    La sensibilité à la caféine n'est PAS ajustée : avec quelques dizaines de check-ins elle n'est pas identifiable
//    (essai sur les données de démo : elle part n'importe où sans améliorer l'erreur) — on préfère ne pas inventer.
//    L'évaluateur rejoue chrono.js + caffeine.js comme buildModel, mais sur une grille de 30 min (et lecture par
//    interpolation) pour rester rapide ; l'écart avec buildModel (grille de 5 min) est vérifié dans les tests.
//  - Outil de confort et d'organisation, pas un dispositif médical : aucun constat n'est formulé en termes de santé.
// Module pur : ni DOM, ni stockage, ni horloge implicite (nowMs est toujours passé).
import {
  MIN, HOUR, DAY, startOfDay, addDays, minutesOfDay, toHHMM, dayKey, clamp, fmtDuration, JOURS_FR,
} from './time.js';
import { buildModel, valueAt } from './model.js';
import { simulateProcessesRaw } from './chrono.js';
import { caffeineCurveRaw, caffeineAt, alertnessBoost, CAFFEINE } from './caffeine.js';
import { chronotypeEstimate, sleepDebt, sleepNeedH, MAIN_SLEEP_MIN_H } from './sleep.js';
import { fitParams, checkinToAlert, MIN_OBSERVATIONS } from './personalize.js';

/** Objectifs par défaut des anneaux du Bilan. */
export const GOALS = Object.freeze({ focusMinPerWorkDay: 120 });
/** Nombre de jours d'historique du modèle de bilan (6 semaines : stabilise le centile « pic » et la calibration). */
export const MODEL_WINDOW_DAYS = 42;

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const stdev = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
const round1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
const plural = (n, one, many) => (n > 1 ? many : one);

/** Minutes d'horloge (0..1439) → « 16:40 ». */
const hm = (min) => toHHMM(Math.round(min));
/** « 09:30 » → 570 (valeur de repli si le texte est invalide). */
function hhmmToMin(s, dflt) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : dflt;
}

// ---------------------------------------------------------------------------------------------
// Utilitaires de jours
// ---------------------------------------------------------------------------------------------

/** Minuits locaux des `n` derniers jours, du plus ancien à aujourd'hui. */
export function lastDays(nowMs, n) {
  const today = startOfDay(nowMs);
  return Array.from({ length: n }, (_, i) => addDays(today, -(n - 1 - i)));
}

/** Nuits (≥ 3 h, hors siestes) triées par réveil, avec milieu de sommeil et jour libre/travaillé. */
function nightsOf(sleeps, profile) {
  const workDays = Array.isArray(profile?.workDays) ? profile.workDays : [1, 2, 3, 4, 5];
  const out = [];
  for (const s of sleeps || []) {
    const durH = (s.wakeMs - s.bedMs) / HOUR;
    if (s.nap || !(durH >= MAIN_SLEEP_MIN_H) || durH > 16) continue;
    const mid = new Date((s.bedMs + s.wakeMs) / 2);
    let midMin = mid.getHours() * 60 + mid.getMinutes();
    if (midMin >= 1080) midMin -= 1440; // évite le saut de minuit (même convention que chronotypeEstimate)
    out.push({
      ...s, durH, midMin, free: !workDays.includes(new Date(s.wakeMs).getDay()),
      bedFrom18: (minutesOfDay(s.bedMs) - 18 * 60 + 1440) % 1440, // minutes écoulées depuis 18 h
      dayMs: startOfDay(s.wakeMs),
    });
  }
  return out.sort((a, b) => a.wakeMs - b.wakeMs);
}

// ---------------------------------------------------------------------------------------------
// computeInsights
// ---------------------------------------------------------------------------------------------

/**
 * Statistiques du bilan. Ne lève jamais : un état vide donne des champs `null` / 0 et `coverage` à zéro.
 * @param {object} state état (voir ARCHITECTURE.md)
 * @param {number} nowMs
 */
export function computeInsights(state, nowMs) {
  const profile = state.profile || {};
  const sleeps = state.sleeps || [];
  const caffeine = state.caffeine || [];
  const checkins = state.checkins || [];
  const tasks = state.tasks || [];
  const focus = state.focus || [];
  const today = startOfDay(nowMs);
  const d7 = lastDays(nowMs, 7);
  const d14 = lastDays(nowMs, 14);
  const d28 = lastDays(nowMs, 28);
  const from7 = d7[0];
  const from14 = d14[0];
  const from28 = d28[0];
  const needH = sleepNeedH(profile);

  // ------------------------------------------------------------------ sommeil
  const nights = nightsOf(sleeps.filter((s) => s.wakeMs <= nowMs), profile);
  const n28 = nights.filter((n) => n.wakeMs >= from28);
  const n7 = nights.filter((n) => n.wakeMs >= from7);
  const nPrev7 = nights.filter((n) => n.wakeMs >= addDays(from7, -7) && n.wakeMs < from7);
  const sleepByDay = new Map(); // dayKey du réveil → heures (nuits cumulées du jour)
  for (const n of nights) sleepByDay.set(dayKey(n.dayMs), (sleepByDay.get(dayKey(n.dayMs)) || 0) + n.durH);
  const debt = sleepDebt(sleeps.filter((s) => s.wakeMs <= nowMs), profile, nowMs, 14);
  const bedSd = stdev(n28.map((n) => n.bedFrom18));
  const bedMean = mean(n28.map((n) => n.bedFrom18));
  const wakeMeanMin = n28.length ? mean(n28.map((n) => minutesOfDay(n.wakeMs))) : null;
  const regularity = bedSd === null ? null : Math.round(clamp(100 - ((bedSd - 15) * 100) / 75, 0, 100));
  const work = n28.filter((n) => !n.free);
  const free = n28.filter((n) => n.free);
  const midWork = mean(work.map((n) => n.midMin));
  const midFree = mean(free.map((n) => n.midMin));
  const socialJetlagMin = midWork !== null && midFree !== null ? Math.round(Math.abs(midFree - midWork)) : null;
  const chrono = chronotypeEstimate(sleeps.filter((s) => s.wakeMs <= nowMs && s.wakeMs >= from28 - 14 * DAY), profile);
  const qualities = n28.filter((n) => Number.isFinite(n.quality)).map((n) => n.quality);
  const sleep = {
    needH,
    avgH7: round1(mean(n7.map((n) => n.durH))),
    avgH28: round1(mean(n28.map((n) => n.durH))),
    avgHPrev7: round1(mean(nPrev7.map((n) => n.durH))),
    nights7: n7.length, nights28: n28.length,
    debtH: round1(debt.debtH), debtRawH: round1(debt.rawDebtH),
    debtPerNight: debt.perNight.map((p) => ({ dayMs: p.dayMs, sleptH: p.sleptH, deficitH: p.deficitH, logged: p.logged })).reverse(), // ancien → récent
    bedMeanMin: bedMean === null ? null : (bedMean + 18 * 60) % 1440,
    wakeMeanMin: wakeMeanMin === null ? null : Math.round(wakeMeanMin),
    bedSdMin: bedSd === null ? null : Math.round(bedSd),
    regularity,
    midWorkMin: midWork === null ? null : Math.round(midWork),
    midFreeMin: midFree === null ? null : Math.round(midFree),
    socialJetlagMin,
    shortNights28: n28.filter((n) => n.durH < 6.5).length,
    shortNights7: n7.filter((n) => n.durH < 6.5).length,
    quality: round1(mean(qualities)),
    series14: d14.map((d) => (sleepByDay.has(dayKey(d)) ? round1(sleepByDay.get(dayKey(d))) : null)),
  };

  // ------------------------------------------------------------------ chronotype
  const chronotype = {
    ...chrono,
    msfscLabel: chrono.msfscMin === null ? null : hm(chrono.msfscMin),
    explanation: explainChronotype(chrono),
  };

  // ------------------------------------------------------------------ caféine
  const cafDays = new Map();
  for (const c of caffeine) {
    if (c.tMs > nowMs || c.tMs < from28) continue;
    const k = dayKey(c.tMs);
    if (!cafDays.has(k)) cafDays.set(k, []);
    cafDays.get(k).push(c);
  }
  const cafSeries = (days) => days.map((d) => (cafDays.has(dayKey(d)) ? cafDays.get(dayKey(d)).reduce((s, c) => s + c.mg, 0) : null));
  const cafMg28 = cafSeries(d28);
  const cafMg7 = cafSeries(d7);
  const cafMg14 = cafSeries(d14);
  const lastIntakes = d28.filter((d) => cafDays.has(dayKey(d))).map((d) => {
    const l = cafDays.get(dayKey(d)).reduce((a, c) => (c.tMs > a.tMs ? c : a));
    return { dayMs: d, minutes: minutesOfDay(l.tMs), tMs: l.tMs };
  });
  const lastMeanMin = lastIntakes.length ? Math.round(mean(lastIntakes.map((l) => l.minutes))) : null;
  // Caféine résiduelle au coucher réel des 14 dernières nuits (nuit commençant le jour d ou la veille au soir).
  const bedResiduals = nights.filter((n) => n.bedMs >= from14 && n.bedMs <= nowMs)
    .map((n) => caffeineAt(caffeine.filter((c) => c.tMs < n.bedMs && c.tMs > n.bedMs - DAY), profile, n.bedMs));
  const atBedMgMean = bedResiduals.length ? mean(bedResiduals) : null;
  const cutoffMin = caffeineCutoffFromHistory({ nights: nights.filter((n) => n.bedMs >= from14 && n.bedMs <= nowMs), caffeine, profile, lastMeanMin });
  const dailyMean28 = mean(cafMg28.filter((v) => v !== null));
  const caffeineStats = {
    daysLogged28: cafDays.size,
    perDayMg7: round1(mean(cafMg7.filter((v) => v !== null))),
    perDayMg28: round1(dailyMean28),
    drinksPerDay28: cafDays.size ? round1([...cafDays.values()].reduce((s, l) => s + l.length, 0) / cafDays.size) : null,
    lastIntakeMeanMin: lastMeanMin,
    lastIntakeLabel: lastMeanMin === null ? null : hm(lastMeanMin),
    atBedMgMean: atBedMgMean === null ? null : round1(atBedMgMean),
    atBedMgMax: bedResiduals.length ? round1(Math.max(...bedResiduals)) : null,
    lateDaysShare: lastIntakes.length ? lastIntakes.filter((l) => l.minutes >= 16 * 60).length / lastIntakes.length : null,
    daysOverLimit28: [...cafDays.values()].filter((l) => l.reduce((s, c) => s + c.mg, 0) > CAFFEINE.maxDailyMg).length,
    suggestedCutoffMin: cutoffMin,
    suggestedCutoffLabel: cutoffMin === null ? null : hm(cutoffMin),
    halfLifeH: Number(profile.caffeineHalfLifeH) || 5,
    series14: cafMg14,
  };

  // ------------------------------------------------------------------ modèle sur 6 semaines (précision + pics)
  const modelFrom = startOfDay(addDays(nowMs, -(MODEL_WINDOW_DAYS - 1)));
  const model = buildModel({
    profile, sleeps, caffeine, fromMs: modelFrom, hours: Math.ceil((nowMs - modelFrom) / HOUR) + 1, stepMin: 15, nowMs,
  });
  // Les « pics » se jugent sur les heures de travail du profil (c'est là qu'on place des tâches), pas à 21 h.
  const workA = hhmmToMin(profile.workStart, 9 * 60);
  const workB = hhmmToMin(profile.workEnd, 18 * 60);
  const inWork = (ms) => { const m = minutesOfDay(ms); return m >= workA && m < workB; };
  const awakeVals = [];
  for (let i = 0; i < model.n; i++) {
    if (!model.asleep[i] && model.AW[i] >= 0.999 && inWork(model.t0 + i * model.stepMin * MIN)) awakeVals.push(model.alert[i]);
  }
  awakeVals.sort((a, b) => a - b);
  const peakThreshold = awakeVals.length ? awakeVals[Math.min(awakeVals.length - 1, Math.floor(0.75 * awakeVals.length))] : null;

  // meilleur créneau de 2 h (moyenne de l'alerte éveillée par heure de la journée)
  const hourSum = new Array(24).fill(0);
  const hourCnt = new Array(24).fill(0);
  for (let i = 0; i < model.n; i++) {
    if (model.asleep[i] || model.AW[i] < 0.999 || !inWork(model.t0 + i * model.stepMin * MIN)) continue;
    const h = new Date(model.t0 + i * model.stepMin * MIN).getHours();
    hourSum[h] += model.alert[i];
    hourCnt[h]++;
  }
  let bestWindow = null;
  for (let h = Math.floor(workA / 60); h + 1 < Math.ceil(workB / 60); h++) {
    if (hourCnt[h] < 5 || hourCnt[h + 1] < 5) continue;
    const m = (hourSum[h] + hourSum[h + 1]) / (hourCnt[h] + hourCnt[h + 1]);
    if (!bestWindow || m > bestWindow.mean) bestWindow = { startMin: h * 60, endMin: (h + 2) * 60, mean: Math.round(m) };
  }
  if (bestWindow) bestWindow.label = `${hm(bestWindow.startMin)}–${hm(bestWindow.endMin)}`;

  // ------------------------------------------------------------------ précision prédit vs ressenti
  const ckWindow = checkins.filter((c) => c.tMs >= modelFrom && c.tMs <= nowMs);
  const points = ckWindow.map((c) => ({
    tMs: c.tMs, predicted: valueAt(model.alert, model, c.tMs), felt: checkinToAlert(c.alertness), checkin: c.alertness,
  }));
  const accuracy = accuracyOf(points);
  accuracy.needed = Math.max(0, MIN_OBSERVATIONS - points.length);
  accuracy.status = points.length === 0 ? 'none' : points.length < MIN_OBSERVATIONS ? 'few' : 'ok';
  accuracy.points = points;
  accuracy.fit = profile.fit || null;
  accuracy.checkins7 = checkins.filter((c) => c.tMs >= from7 && c.tMs <= nowMs).length;

  // ------------------------------------------------------------------ concentration
  const focusDone = focus.filter((f) => f.endMs <= nowMs);
  const focusByDay = (days) => days.map((d) => focusDone
    .filter((f) => dayKey(f.startMs) === dayKey(d)).reduce((s, f) => s + (f.endMs - f.startMs) / MIN, 0));
  const fm7 = focusByDay(d7);
  const fm14 = focusByDay(d14);
  const fmPrev7 = fm14.slice(0, 7).reduce((s, v) => s + v, 0);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const sessions28 = focusDone.filter((f) => f.startMs >= from28);
  const heavySessions = sessions28.filter((f) => (taskById.get(f.taskId)?.load ?? 0) >= 4);
  const peakPool = heavySessions.length >= 3 ? heavySessions : sessions28;
  const inPeak = peakPool.filter((f) => peakThreshold !== null && meanAlertBetween(model, f.startMs, f.endMs) >= peakThreshold);
  const ratings = sessions28.filter((f) => Number.isFinite(f.rating)).map((f) => f.rating);
  const focusStats = {
    min7: Math.round(fm7.reduce((s, v) => s + v, 0)),
    min28: Math.round(focusByDay(d28).reduce((s, v) => s + v, 0)),
    minPrev7: Math.round(fmPrev7),
    sessions7: focusDone.filter((f) => f.startMs >= from7).length,
    sessions28: sessions28.length,
    avgRating: round1(mean(ratings)),
    byDay7: fm7.map(Math.round),
    series14: fm14.map(Math.round),
    peakThreshold: peakThreshold === null ? null : Math.round(peakThreshold),
    inPeakShare: peakPool.length >= 3 ? inPeak.length / peakPool.length : null,
    inPeakCount: inPeak.length,
    peakPoolCount: peakPool.length,
    peakPoolHeavy: peakPool === heavySessions && heavySessions.length > 0,
    bestWindow,
  };

  // ------------------------------------------------------------------ tâches
  const done7 = tasks.filter((t) => t.done && Number.isFinite(t.doneMs) && t.doneMs >= from7 && t.doneMs <= nowMs);
  const open = tasks.filter((t) => !t.done);
  const weekEnd = addDays(today, 7);
  const dueWeek = open.filter((t) => Number.isFinite(t.deadlineMs) && t.deadlineMs >= nowMs && t.deadlineMs < weekEnd);
  const overdue = open.filter((t) => Number.isFinite(t.deadlineMs) && t.deadlineMs < nowMs);
  const soon = open.filter((t) => Number.isFinite(t.deadlineMs) && t.deadlineMs >= nowMs && t.deadlineMs < addDays(today, 3));
  const tasksByDay = d7.map((d) => done7.filter((t) => dayKey(t.doneMs) === dayKey(d)).length);
  const tasksStats = {
    done7: done7.length,
    doneMin7: done7.reduce((s, t) => s + t.durMin, 0),
    deepDone7: done7.filter((t) => t.load >= 4).length,
    open: open.length,
    dueWeek: dueWeek.length,
    dueWeekMin: dueWeek.reduce((s, t) => s + t.durMin, 0),
    overdue: overdue.length,
    soon: soon.length,
    soonMin: soon.reduce((s, t) => s + t.durMin, 0),
    soonDeep: soon.filter((t) => t.load >= 4).length,
    byDay7: tasksByDay,
    completion: done7.length + dueWeek.length + overdue.length ? done7.length / (done7.length + dueWeek.length + overdue.length) : null,
  };

  // ------------------------------------------------------------------ semaine, série, anneaux
  const week = d7.map((d, i) => ({
    dayMs: d, label: JOURS_FR[new Date(d).getDay()].slice(0, 3), isToday: d === today,
    focusMin: Math.round(fm7[i]), tasksDone: tasksByDay[i], sleepH: sleep.series14[7 + i], caffeineMg: cafMg7[i],
  }));
  const activeDays28 = d28.map((d) => {
    const k = dayKey(d);
    const f = focusDone.some((x) => dayKey(x.startMs) === k && (x.endMs - x.startMs) >= 20 * MIN)
      || tasks.some((t) => t.done && Number.isFinite(t.doneMs) && dayKey(t.doneMs) === k);
    return f;
  });
  let streak = 0;
  for (let i = 27; i >= 0; i--) {
    if (activeDays28[i]) streak++;
    else if (i === 27) continue; // aujourd'hui pas encore commencé : la série n'est pas cassée
    else break;
  }
  let best = 0; let run = 0;
  for (const a of activeDays28) { run = a ? run + 1 : 0; best = Math.max(best, run); }

  const workDaysPerWeek = Array.isArray(profile.workDays) ? profile.workDays.length : 5;
  const focusTarget = Math.max(60, workDaysPerWeek * GOALS.focusMinPerWorkDay);
  const taskTotal = done7.length + dueWeek.length + overdue.length;
  const rings = {
    focus: { value: focusStats.min7, target: focusTarget, frac: clamp(focusStats.min7 / focusTarget, 0, 1) },
    tasks: { value: done7.length, total: taskTotal, frac: taskTotal ? clamp(done7.length / taskTotal, 0, 1) : 0 },
    sleep: { value: sleep.avgH7, target: needH, frac: sleep.avgH7 === null ? 0 : clamp(sleep.avgH7 / needH, 0, 1) },
  };

  // ------------------------------------------------------------------ tendances (sparklines)
  const feltByDay = d14.map((d) => {
    const v = checkins.filter((c) => c.tMs <= nowMs && dayKey(c.tMs) === dayKey(d)).map((c) => c.alertness);
    return v.length ? round1(mean(v)) : null;
  });
  const delta = (a, b) => (a === null || b === null ? null : round1(a - b));
  const trends = {
    sleepH: { series: sleep.series14, now: sleep.avgH7, delta: delta(sleep.avgH7, sleep.avgHPrev7), unit: 'h' },
    caffeineMg: { series: cafMg14, now: caffeineStats.perDayMg7, delta: delta(caffeineStats.perDayMg7, round1(mean(cafSeries(lastDays(addDays(nowMs, -7), 7)).filter((v) => v !== null)))), unit: 'mg' },
    focusMin: { series: fm14, now: focusStats.min7, delta: focusStats.min7 - focusStats.minPrev7, unit: 'min' },
    felt: { series: feltByDay, now: round1(mean(feltByDay.slice(7).filter((v) => v !== null))), delta: delta(round1(mean(feltByDay.slice(7).filter((v) => v !== null))), round1(mean(feltByDay.slice(0, 7).filter((v) => v !== null)))), unit: '/5' },
  };

  return {
    nowMs,
    profile: {
      sleepNeedH: needH, caffeineHalfLifeH: caffeineStats.halfLifeH, chronoShiftMin: Number(profile.chronoShiftMin) || 0,
      workDays: Array.isArray(profile.workDays) ? profile.workDays : [1, 2, 3, 4, 5],
    },
    coverage: {
      sleepNights28: n28.length, checkins: points.length, caffeineDays28: cafDays.size, focusSessions28: sessions28.length,
      tasks: tasks.length, hasAnyData: n28.length + points.length + cafDays.size + sessions28.length + tasks.length > 0,
    },
    sleep, chronotype, caffeine: caffeineStats, accuracy, focus: focusStats, tasks: tasksStats,
    week, streak: { days: streak, best, active28: activeDays28 }, rings, trends,
  };
}

/**
 * Dernière heure de prise qui ramènerait la caféine résiduelle MOYENNE au coucher sous le repère de ≈ 25 mg,
 * en rejouant les 14 dernières nuits : pour chaque heure candidate, on ne garde que les prises d'avant cette heure.
 * Arrondi au quart d'heure inférieur ; jamais après la dernière prise moyenne moins 30 min quand un excès existe.
 */
function caffeineCutoffFromHistory({ nights, caffeine, profile, lastMeanMin }) {
  if (nights.length < 3 || lastMeanMin === null) return null;
  const meanResidual = (cMin) => mean(nights.map((n) => {
    const logs = caffeine.filter((c) => c.tMs < n.bedMs && c.tMs > n.bedMs - DAY && minutesOfDay(c.tMs) <= cMin);
    return caffeineAt(logs, profile, n.bedMs);
  }));
  for (let c = 20 * 60; c >= 9 * 60; c -= 15) {
    if (meanResidual(c) <= CAFFEINE.bedThresholdMg) return Math.min(c, Math.floor((lastMeanMin - 30) / 15) * 15);
  }
  return 9 * 60;
}

/** Moyenne de l'alerte du modèle sur [aMs, bMs] (échantillonnage à la grille du modèle). */
function meanAlertBetween(model, aMs, bMs) {
  const step = model.stepMin * MIN;
  let sum = 0; let c = 0;
  for (let t = aMs; t <= bMs; t += step) { sum += valueAt(model.alert, model, t); c++; }
  return c ? sum / c : valueAt(model.alert, model, aMs);
}

/** RMSE, biais, corrélation et référence « constante » d'une liste {predicted, felt} (0..100). */
export function accuracyOf(points) {
  const p = points.filter((q) => Number.isFinite(q.predicted) && Number.isFinite(q.felt));
  const n = p.length;
  if (!n) return { n: 0, rmse: null, bias: null, r: null, baselineRmse: null, skill: null };
  const mp = mean(p.map((q) => q.predicted));
  const mf = mean(p.map((q) => q.felt));
  let sxx = 0; let syy = 0; let sxy = 0; let se = 0;
  for (const q of p) {
    sxx += (q.predicted - mp) ** 2; syy += (q.felt - mf) ** 2; sxy += (q.predicted - mp) * (q.felt - mf);
    se += (q.predicted - q.felt) ** 2;
  }
  const rmse = Math.sqrt(se / n);
  const baselineRmse = Math.sqrt(syy / n);
  return {
    n, rmse: round1(rmse), bias: round1(mf - mp),
    r: sxx > 1e-9 && syy > 1e-9 ? Math.round((sxy / Math.sqrt(sxx * syy)) * 100) / 100 : null,
    baselineRmse: round1(baselineRmse),
    skill: baselineRmse > 1e-9 ? Math.round((1 - rmse / baselineRmse) * 100) / 100 : null,
  };
}

function explainChronotype(c) {
  if (c.msfscMin === null) return 'Pas encore de nuit enregistrée : note ton sommeil quelques jours (week-end compris) pour estimer ton chronotype.';
  const when = hm(c.msfscMin);
  const base = c.label === 'chouette'
    ? `Le milieu de ton sommeil des jours libres, corrigé du rattrapage, tombe vers ${when} : plutôt « chouette ».`
    : c.label === 'alouette'
      ? `Le milieu de ton sommeil des jours libres, corrigé du rattrapage, tombe vers ${when} : plutôt « alouette ».`
      : `Le milieu de ton sommeil des jours libres, corrigé du rattrapage, tombe vers ${when} : un profil intermédiaire.`;
  const conf = c.confidence < 0.4 ? ' Estimation encore fragile : il faut davantage de nuits, avec des jours libres.'
    : !c.freeNights ? ' Sans nuit de week-end, la correction est impossible : l\'estimation est approximative.' : '';
  return `${base} (Méthode MSFsc de Roenneberg, sur ${c.n} nuit${plural(c.n, '', 's')}.)${conf}`;
}

// ---------------------------------------------------------------------------------------------
// Cartes de constats
// ---------------------------------------------------------------------------------------------

/**
 * Constats lisibles, chiffrés et actionnables, triés par impact décroissant.
 * @param {ReturnType<typeof computeInsights>} I
 * @param {{max?:number}} [opts]
 * @returns {{id:string, level:'info'|'conseil'|'alerte', impact:number, icon:string, title:string, text:string,
 *            stat?:{value:string, unit?:string, label?:string}, action?:{label:string, hash:string}}[]}
 */
export function insightCards(I, { max = 6 } = {}) {
  const cards = [];
  const add = (c) => cards.push({ ...c, impact: clamp(Math.round(c.impact ?? 30), 0, 100) });
  const { sleep, caffeine: caf, accuracy: acc, focus, tasks, chronotype } = I;

  // --- caféine ---
  if (caf.daysLogged28 >= 5 && caf.lastIntakeMeanMin !== null) {
    const bedMg = caf.atBedMgMean ?? 0;
    if (bedMg >= 15) {
      const cut = caf.suggestedCutoffLabel;
      add({
        id: 'caffeine-late', level: bedMg >= 50 ? 'alerte' : 'conseil', icon: 'coffee', impact: 38 + bedMg * 1.3,
        title: 'Ta dernière caféine arrive tard',
        text: `Ta dernière caféine est en moyenne à ${caf.lastIntakeLabel} ; avec une demi-vie de ${String(caf.halfLifeH).replace('.', ',')} h, `
          + `il t'en reste ≈ ${Math.round(bedMg)} mg au coucher${cut ? ` : essaie de t'arrêter vers ${cut}` : ''}. `
          + 'Le repère habituel est d\'arriver sous ≈ 25 mg, mais la sensibilité varie beaucoup d\'une personne à l\'autre.',
        stat: { value: String(Math.round(bedMg)), unit: 'mg', label: 'au coucher' },
        action: { label: 'Voir la caféine', hash: '#/lab' },
      });
    } else {
      add({
        id: 'caffeine-ok', level: 'info', icon: 'coffee', impact: 22,
        title: 'Tes cafés s\'arrêtent à temps',
        text: `Dernière prise vers ${caf.lastIntakeLabel} en moyenne, ≈ ${Math.round(bedMg)} mg restants au coucher : rien à changer de ce côté.`,
        stat: { value: String(Math.round(bedMg)), unit: 'mg', label: 'au coucher' },
      });
    }
    if (caf.perDayMg28 !== null && caf.perDayMg28 > CAFFEINE.maxDailyMg * 0.9) {
      add({
        id: 'caffeine-volume', level: 'conseil', icon: 'coffee', impact: 45,
        title: 'Un volume de caféine élevé',
        text: `Tu en prends ≈ ${Math.round(caf.perDayMg28)} mg par jour ; le repère de l'EFSA pour un adulte est de 400 mg. Réduire un peu l'après-midi est le plus utile.`,
        stat: { value: String(Math.round(caf.perDayMg28)), unit: 'mg/j' },
      });
    }
  }

  // --- dette de sommeil ---
  if (sleep.nights28 >= 4) {
    const d = sleep.debtH ?? 0;
    if (d >= 1.5) {
      const extra = 30;
      const nightsNeeded = Math.ceil((d * 60) / extra);
      add({
        id: 'sleep-debt', level: d >= 8 ? 'alerte' : 'conseil', icon: 'moon', impact: 34 + d * 9,
        title: 'Une dette de sommeil se creuse',
        text: `Sur 14 jours, tu cumules ≈ ${fmtDuration(Math.round(d * 60))} de déficit pondéré par rapport à ton besoin de ${fmtDuration(Math.round(sleep.needH * 60))}. `
          + `En ajoutant ${extra} min de sommeil par nuit (coucher plus tôt), compte environ ${nightsNeeded} nuits pour la résorber : le sommeil ne se stocke pas vraiment, mais il se rattrape par petites touches.`,
        stat: { value: fmtDuration(Math.round(d * 60)).replace(' ', ' '), label: 'de dette' },
        action: { label: 'Mon coucher idéal', hash: '#/sleep' },
      });
    } else if (d < 1) {
      add({
        id: 'sleep-debt-ok', level: 'info', icon: 'moon', impact: 20,
        title: 'Dette de sommeil quasi nulle',
        text: `Tu dors en moyenne ${fmtDuration(Math.round((sleep.avgH28 ?? sleep.needH) * 60))} pour un besoin de ${fmtDuration(Math.round(sleep.needH * 60))} : c'est ce qui rend ton énergie prévisible.`,
        stat: { value: fmtDuration(Math.round(d * 60)), label: 'de dette' },
      });
    }
  }

  // --- régularité / jet lag social ---
  if (sleep.socialJetlagMin !== null) {
    const j = sleep.socialJetlagMin;
    if (j >= 60) {
      add({
        id: 'social-jetlag', level: 'conseil', icon: 'plane', impact: 28 + j / 2.2,
        title: 'Tes week-ends décalent ton horloge',
        text: `Le milieu de ton sommeil passe de ${hm(sleep.midWorkMin)} en semaine à ${hm(sleep.midFreeMin)} le week-end : ${fmtDuration(j)} d'écart, `
          + 'comme un petit vol vers l\'ouest chaque samedi. Limiter ce décalage à ≈ 1 h (réveil du week-end au plus tard une heure après celui de la semaine) rend le lundi nettement plus facile.',
        stat: { value: fmtDuration(j).replace(' ', ' '), label: 'de jet lag social' },
        action: { label: 'Voir mon chronotype', hash: '#/sleep' },
      });
    } else {
      add({
        id: 'social-jetlag-ok', level: 'info', icon: 'plane', impact: 18,
        title: 'Un rythme semaine / week-end cohérent',
        text: `Seulement ${fmtDuration(j)} d'écart entre le milieu de sommeil de la semaine et celui du week-end : ton horloge reste stable.`,
        stat: { value: fmtDuration(j), label: 'd\'écart' },
      });
    }
  }
  if (sleep.bedSdMin !== null && sleep.nights28 >= 7) {
    if (sleep.bedSdMin >= 60) {
      add({
        id: 'bed-irregular', level: 'conseil', icon: 'clock', impact: 25 + sleep.bedSdMin / 3,
        title: 'Des heures de coucher très variables',
        text: `Ton coucher varie de ±${sleep.bedSdMin} min autour de ${hm(sleep.bedMeanMin)}. Un horaire plus constant aide autant que quelques minutes de sommeil en plus : vise une fenêtre de 30 min.`,
        stat: { value: `±${sleep.bedSdMin}`, unit: 'min' },
      });
    } else if (sleep.bedSdMin <= 30) {
      add({
        id: 'bed-regular', level: 'info', icon: 'clock', impact: 17,
        title: 'Un coucher régulier',
        text: `Tu te couches vers ${hm(sleep.bedMeanMin)} à ±${sleep.bedSdMin} min près : c'est une vraie force pour la prévisibilité de ton énergie.`,
        stat: { value: `±${sleep.bedSdMin}`, unit: 'min' },
      });
    }
  }
  if (sleep.shortNights7 >= 2) {
    add({
      id: 'short-nights', level: 'conseil', icon: 'bed', impact: 36 + sleep.shortNights7 * 5,
      title: `${sleep.shortNights7} nuits courtes cette semaine`,
      text: `${sleep.shortNights7} nuits de moins de 6 h 30 sur 7 jours. Si la semaine est chargée, protège au moins l'heure du coucher : c'est elle qui saute en premier.`,
      stat: { value: String(sleep.shortNights7), label: 'nuits < 6 h 30' },
    });
  }
  if (sleep.nights7 < 4) {
    add({
      id: 'log-sleep', level: 'info', icon: 'moon', impact: 40,
      title: 'Note tes nuits pour des constats fiables',
      text: `Seulement ${sleep.nights7} nuit${plural(sleep.nights7, '', 's')} enregistrée${plural(sleep.nights7, '', 's')} cette semaine : la dette, la régularité et ton chronotype ont besoin d'au moins 4 nuits (et d'un week-end).`,
      action: { label: 'Noter ma nuit', hash: '#/sleep' },
    });
  }

  // --- pics d'énergie et concentration ---
  if (focus.inPeakShare !== null) {
    const pct = Math.round(focus.inPeakShare * 100);
    const kind = focus.peakPoolHeavy ? 'tes sessions sur des tâches lourdes' : 'tes sessions de concentration';
    if (pct >= 50) {
      add({
        id: 'peaks-good', level: 'info', icon: 'bolt', impact: 24,
        title: 'Tu travailles dans tes bons moments',
        text: `${pct} % de ${kind} tombent dans tes 25 % meilleurs créneaux d'énergie (le hasard donnerait ≈ 25 %).`
          + (focus.bestWindow ? ` Ton meilleur créneau : ${focus.bestWindow.label}.` : ''),
        stat: { value: String(pct), unit: '%', label: 'dans les pics' },
      });
    } else {
      const better = pct >= 35;
      add({
        id: 'peaks-low', level: better ? 'info' : 'conseil', icon: 'bolt', impact: 30 + (50 - pct) / 2,
        title: better ? 'Tu es à mi-chemin de tes pics' : 'Tes tâches lourdes ratent leurs pics',
        text: `${pct} % de ${kind} tombent dans tes meilleurs créneaux${better ? ' : déjà bien au-dessus du hasard (≈ 25 %), mais il reste de la marge' : ' (le hasard donnerait ≈ 25 %)'}. `
          + (focus.bestWindow ? `Essaie de caser le plus exigeant vers ${focus.bestWindow.label} (alerte prévue ≈ ${focus.bestWindow.mean}/100) et laisse le léger pour les creux.` : 'Laisse le planificateur placer le plus exigeant au sommet de ta courbe.'),
        stat: { value: String(pct), unit: '%', label: 'dans les pics' },
        action: { label: 'Replanifier', hash: '#/plan' },
      });
    }
  }
  if (focus.minPrev7 > 0 || focus.min7 > 0) {
    const diff = focus.min7 - focus.minPrev7;
    if (focus.minPrev7 > 0 && Math.abs(diff) >= 30) {
      add({
        id: 'focus-trend', level: 'info', icon: 'target', impact: 26 + Math.min(14, Math.abs(diff) / 15),
        title: diff > 0 ? 'Plus de concentration que la semaine dernière' : 'Un peu moins de concentration cette semaine',
        text: `${fmtDuration(focus.min7)} de focus sur 7 jours contre ${fmtDuration(focus.minPrev7)} la semaine précédente (${diff > 0 ? '+' : '−'}${fmtDuration(Math.abs(diff))}).`
          + (diff < 0 ? ' Rien d\'alarmant : une semaine de réunions ou de fatigue suffit à l\'expliquer.' : ''),
        stat: { value: fmtDuration(focus.min7).replace(' ', ' '), label: '7 jours' },
      });
    }
  }

  // --- tâches ---
  if (tasks.overdue > 0) {
    add({
      id: 'tasks-overdue', level: 'alerte', icon: 'alert', impact: 55 + tasks.overdue * 4,
      title: `${tasks.overdue} tâche${plural(tasks.overdue, '', 's')} en retard`,
      text: 'Choisis la plus courte et termine-la aujourd\'hui : un retard qui rétrécit se gère mieux qu\'une liste qui grossit. Le planificateur peut aussi les placer en priorité.',
      stat: { value: String(tasks.overdue), label: 'en retard' },
      action: { label: 'Voir le plan', hash: '#/plan' },
    });
  } else if (tasks.soon >= 2) {
    add({
      id: 'tasks-soon', level: 'conseil', icon: 'calendar', impact: 33 + tasks.soonDeep * 6,
      title: `${tasks.soon} échéances dans les 3 jours`,
      text: `≈ ${fmtDuration(tasks.soonMin)} de travail à terminer d'ici 3 jours${tasks.soonDeep ? `, dont ${tasks.soonDeep} tâche${plural(tasks.soonDeep, '', 's')} exigeante${plural(tasks.soonDeep, '', 's')}` : ''}. Réserve tes pics d'énergie pour elles.`,
      stat: { value: String(tasks.soon), label: 'échéances' },
      action: { label: 'Voir le plan', hash: '#/plan' },
    });
  }

  // --- précision du modèle ---
  if (acc.status !== 'ok') {
    add({
      id: 'calibrate-more', level: 'info', icon: 'brain', impact: 44,
      title: acc.n === 0 ? 'Réponds à « comment te sens-tu ? » pour calibrer Kairos' : `Encore ${acc.needed} check-in${plural(acc.needed, '', 's')} pour calibrer`,
      text: `Il faut au moins ${MIN_OBSERVATIONS} check-ins (tu en as ${acc.n}) pour comparer la prédiction à ton ressenti et ajuster ton décalage de chronotype. Trois par jour pendant quelques jours suffisent.`,
      stat: { value: `${acc.n}/${MIN_OBSERVATIONS}`, label: 'check-ins' },
    });
  } else {
    const fit = acc.fit;
    const good = acc.skill !== null && acc.skill >= 0.3;
    add({
      id: 'model-accuracy', level: 'info', icon: 'brain', impact: good ? 26 : 40,
      title: good ? 'Le modèle colle à ton ressenti' : 'Le modèle peut mieux faire',
      text: `Sur ${acc.n} check-ins, l'écart typique entre prédit et ressenti est de ≈ ${Math.round(acc.rmse)} points (corrélation ${acc.r === null ? 'n.d.' : String(acc.r).replace('.', ',')}), contre ≈ ${Math.round(acc.baselineRmse)} en devinant toujours ta moyenne. `
        + (fit && fit.confidence > 0 ? 'Un ajustement personnel est déjà appliqué.' : 'Un ajustement personnel peut encore réduire cet écart : lance « Calibrer sur mes check-ins ».'),
      stat: { value: String(Math.round(acc.rmse)), unit: 'pts', label: 'd\'écart' },
      action: fit && fit.confidence > 0 ? undefined : { label: 'Calibrer', hash: '#/insights' },
    });
  }

  // --- chronotype ---
  if (chronotype.msfscMin !== null && chronotype.confidence >= 0.4) {
    add({
      id: 'chronotype', level: 'info', icon: 'moon-star', impact: 21,
      title: `Chronotype : ${chronotype.label}`,
      text: chronotype.explanation,
      stat: { value: chronotype.msfscLabel, label: 'milieu de sommeil' },
    });
  }

  // On trie par impact ; on garantit 3 constats au minimum avec des compléments neutres.
  cards.sort((a, b) => b.impact - a.impact);
  if (cards.length < 3) {
    const fillers = [
      { id: 'tip-light', level: 'info', icon: 'sun', impact: 10, title: 'La lumière du matin cale ton horloge', text: 'Dix à trente minutes de lumière naturelle dans l\'heure qui suit le réveil avancent et stabilisent ta phase : c\'est le réglage le plus simple et le mieux documenté.' },
      { id: 'tip-checkin', level: 'info', icon: 'heart', impact: 9, title: 'Trois check-ins par jour suffisent', text: 'Matin, après-midi, soirée : en quelques secondes chacun, ils permettent à Kairos de calibrer ta courbe sur toi plutôt que sur la moyenne.' },
      { id: 'tip-nap', level: 'info', icon: 'leaf', impact: 8, title: 'Une sieste de 20 minutes, ça marche', text: 'Dans le creux de l\'après-midi, 20 min évitent le sommeil profond (donc la « gueule de bois » au réveil) et relèvent l\'alerte sans gêner la nuit.' },
    ];
    for (const f of fillers) if (cards.length < 3 && !cards.some((c) => c.id === f.id)) cards.push(f);
  }
  return cards.slice(0, Math.max(3, Math.min(6, max)));
}

// ---------------------------------------------------------------------------------------------
// Ajustement personnel à partir de l'état
// ---------------------------------------------------------------------------------------------

const FIT_WINDOW_DAYS = 28;
const FIT_MAX_CHECKINS = 150;
const FIT_STEP_MIN = 30;

/** Alerte finale (même formule que buildModel) à partir des sorties brutes de chrono.js + caffeine.js. */
const topClip = (x) => (x <= 90 ? x : 90 + 10 * Math.tanh((x - 90) / 10));

/**
 * Évaluateur rapide : `evaluate(values)` → alerte prédite (0..100) à l'instant de chaque check-in.
 * Même moteur que buildModel (chrono + caféine) mais grille de 30 min et lecture par interpolation linéaire.
 */
export function makeEvaluator({ profile, sleeps, caffeine, times, fromMs, toMs, stepMin = FIT_STEP_MIN }) {
  const hours = Math.ceil((toMs - fromMs) / HOUR) + 1;
  const endMs = fromMs + hours * HOUR;
  const n = Math.max(1, Math.round((endMs - fromMs) / (stepMin * MIN)) + 1);
  const step = stepMin * MIN;
  return (values) => {
    const p = { ...profile, ...values };
    const sim = simulateProcessesRaw({ sleeps, profile: p, fromMs, toMs: endMs, stepMin });
    const mg = caffeineCurveRaw(caffeine, p, fromMs, stepMin, n);
    const alert = new Float64Array(n);
    for (let i = 0; i < n; i++) alert[i] = clamp(topClip(sim.alertBase[i] + alertnessBoost(mg[i], p, { S: sim.S[i] }) * sim.AW[i]), 0, 100);
    return times.map((t) => {
      const x = clamp((t - fromMs) / step, 0, n - 1);
      const i = Math.floor(x);
      return i >= n - 1 ? alert[n - 1] : alert[i] + (x - i) * (alert[i + 1] - alert[i]);
    });
  };
}

/** Précision (rmse, r²) de prédictions contre des cibles. */
function scoreOf(pred, targets) {
  const n = targets.length;
  const m = mean(targets);
  let se = 0; let st = 0;
  for (let i = 0; i < n; i++) { se += (pred[i] - targets[i]) ** 2; st += (targets[i] - m) ** 2; }
  return { rmse: Math.sqrt(se / n), r2: st > 1e-12 ? 1 - se / st : 0 };
}

/**
 * Ajuste le profil sur les check-ins des 28 derniers jours. Ne modifie jamais `state`.
 * Sans effet de bord : l'appelant applique `actions.setProfile({ ...profilePatch, fit })`.
 *
 * @returns {{
 *   verdict: 'refused'|'weak'|'moderate'|'good', applicable: boolean, reason: string,
 *   profilePatch: {chronoShiftMin?:number, sleepNeedH?:number},
 *   fit: {fittedMs:number, n:number, rmse:number, baselineRmse:number, r2:number, confidence:number},
 *   before: {rmse:number, r2:number, chronoShiftMin:number, sleepNeedH:number},
 *   after:  {rmse:number, r2:number, chronoShiftMin:number, sleepNeedH:number},
 *   needed: number, cv?: object, values: object
 * }}
 */
export function personalizeFromState(state, nowMs, { windowDays = FIT_WINDOW_DAYS, seed = 1 } = {}) {
  const profile = state.profile || {};
  const from = startOfDay(addDays(nowMs, -(windowDays - 1)));
  const cks = (state.checkins || []).filter((c) => c.tMs >= from && c.tMs <= nowMs).slice(-FIT_MAX_CHECKINS);
  const cur = { chronoShiftMin: Number(profile.chronoShiftMin) || 0, sleepNeedH: sleepNeedH(profile) };
  const emptyFit = (n, rmse = 0, baseline = 0, r2 = 0) => ({ fittedMs: nowMs, n, rmse, baselineRmse: baseline, r2, confidence: 0 });

  if (cks.length < MIN_OBSERVATIONS) {
    return {
      verdict: 'refused', applicable: false, needed: MIN_OBSERVATIONS - cks.length, profilePatch: {}, values: cur,
      reason: `Pas assez de check-ins (${cks.length} sur ${MIN_OBSERVATIONS} nécessaires) : en dessous, tout ajustement ne serait que du bruit. Encore ${MIN_OBSERVATIONS - cks.length}, et on y est.`,
      fit: emptyFit(cks.length),
      before: { rmse: 0, r2: 0, ...cur }, after: { rmse: 0, r2: 0, ...cur },
    };
  }

  const targets = cks.map((c) => checkinToAlert(c.alertness));
  const evaluate = makeEvaluator({
    profile, sleeps: state.sleeps || [], caffeine: state.caffeine || [], times: cks.map((c) => c.tMs),
    fromMs: startOfDay(cks[0].tMs), toMs: cks[cks.length - 1].tMs,
  });
  const before = scoreOf(evaluate(cur), targets);
  const res = fitParams({
    params: {
      chronoShiftMin: { value: clamp(cur.chronoShiftMin, -180, 180), min: -180, max: 180 },
      sleepNeedH: { value: clamp(cur.sleepNeedH, 6, 10), min: 6, max: 10 },
    },
    evaluate, targets, restarts: 3, maxIter: 100, seed,
  });
  const values = {
    chronoShiftMin: Math.round(res.values.chronoShiftMin),
    sleepNeedH: Math.round(res.values.sleepNeedH * 10) / 10,
  };
  const after = scoreOf(evaluate(values), targets);
  const fit = { fittedMs: nowMs, n: res.n, rmse: after.rmse, baselineRmse: res.baselineRmse, r2: after.r2, confidence: res.confidence };
  const gain = before.rmse - after.rmse;
  const beats = after.rmse < res.baselineRmse * 0.97;
  const afterOut = { rmse: after.rmse, r2: after.r2, ...values };
  const beforeOut = { rmse: before.rmse, r2: before.r2, ...cur };

  let verdict;
  let reason;
  if (res.confidence < 0.15 || !beats) {
    verdict = 'weak';
    reason = `L'ajustement ne bat pas nettement une simple moyenne de tes réponses (confiance ${Math.round(res.confidence * 100)} %) : je ne touche à rien. Continue de noter ton ressenti quelques jours et réessaie.`;
  } else {
    verdict = res.confidence >= 0.5 ? 'good' : 'moderate';
    const shiftTxt = values.chronoShiftMin === 0 ? 'aucun décalage' : `ton horloge est ${Math.abs(values.chronoShiftMin)} min ${values.chronoShiftMin > 0 ? 'plus tardive' : 'plus précoce'} que le modèle standard`;
    reason = `D'après ${res.n} check-ins, ${shiftTxt}. L'erreur passe de ${Math.round(before.rmse)} à ${Math.round(after.rmse)} points`
      + `${gain < 1 ? ' (gain modeste)' : ''}. Confiance ${Math.round(res.confidence * 100)} % : ${verdict === 'good' ? 'solide' : 'correcte mais perfectible'}.`;
  }
  const applicable = verdict === 'good' || verdict === 'moderate';
  return {
    verdict, applicable, reason, needed: 0,
    profilePatch: applicable ? { ...values } : {},
    fit, before: beforeOut, after: afterOut, values, cv: res.cv,
  };
}

// ---------------------------------------------------------------------------------------------
// Bilan partageable
// ---------------------------------------------------------------------------------------------

/** Texte du bilan de la semaine, prêt à être copié (messages, notes…). */
export function weeklySummaryText(I, cards = insightCards(I), nowMs = I.nowMs) {
  const d0 = addDays(startOfDay(nowMs), -6);
  const fmtDay = (ms) => `${new Date(ms).getDate()}/${String(new Date(ms).getMonth() + 1).padStart(2, '0')}`;
  const L = [];
  L.push(`Bilan Kairos · ${fmtDay(d0)} → ${fmtDay(nowMs)}`);
  L.push('');
  if (I.sleep.avgH7 !== null) L.push(`Sommeil : ${fmtDuration(Math.round(I.sleep.avgH7 * 60))} en moyenne (besoin ${fmtDuration(Math.round(I.sleep.needH * 60))}), dette ${fmtDuration(Math.round((I.sleep.debtH ?? 0) * 60))}${I.sleep.regularity !== null ? `, régularité ${I.sleep.regularity}/100` : ''}.`);
  if (I.focus.min7 > 0) L.push(`Focus : ${fmtDuration(I.focus.min7)} sur ${I.focus.sessions7} session${plural(I.focus.sessions7, '', 's')}${I.focus.inPeakShare !== null ? `, ${Math.round(I.focus.inPeakShare * 100)} % dans mes pics` : ''}.`);
  L.push(`Tâches : ${I.tasks.done7} terminée${plural(I.tasks.done7, '', 's')} (${fmtDuration(I.tasks.doneMin7)}), ${I.tasks.dueWeek} à venir cette semaine.`);
  if (I.caffeine.perDayMg7 !== null) L.push(`Caféine : ≈ ${Math.round(I.caffeine.perDayMg7)} mg/jour${I.caffeine.lastIntakeLabel ? `, dernière prise vers ${I.caffeine.lastIntakeLabel}` : ''}.`);
  if (I.streak.days > 0) L.push(`Série : ${I.streak.days} jour${plural(I.streak.days, '', 's')} d'affilée.`);
  L.push('');
  for (const c of cards.slice(0, 4)) L.push(`• ${c.title} — ${c.text}`);
  L.push('');
  L.push('Outil de confort et d\'organisation, pas un avis médical.');
  return L.join('\n');
}
