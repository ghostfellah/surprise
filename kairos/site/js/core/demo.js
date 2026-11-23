// Données de démonstration de Kairos : un état complet, crédible et DÉTERMINISTE (même graine → même état).
//
// Persona : Camille, développeuse freelance, plutôt « chouette » (milieu de sommeil libre ≈ 06 h),
// ~7 h de sommeil en semaine contre ~8 h 30 le week-end (jet lag social visible), 2-3 cafés par jour dont
// un trop tardif une fois sur deux, et une dette de sommeil qui se voit sans être dramatique.
//
// Hypothèse centrale (c'est la « démo de la personnalisation ») : les check-ins ne sont PAS tirés au hasard.
// Ils sont générés à partir du vrai modèle `buildModel` avec un décalage de chronotype CACHÉ de +40 min
// (la personne est un peu plus tardive que ce que son profil déclaré laisse croire), plus du bruit (humeur du
// jour + bruit de mesure), puis arrondis sur l'échelle 1..5. Le profil renvoyé garde chronoShiftMin = 0 :
// un `fitParams` sur ces check-ins doit donc retrouver un décalage positif. Voir insights.js (personalizeFromState).
//
// Module pur : aucune horloge implicite (nowMs est un paramètre), aucun accès au DOM ni au stockage.
import {
  MIN, HOUR, startOfDay, addDays, atMinutes, clamp, rng,
} from './time.js';
import { buildModel, valueAt, meanAlert } from './model.js';
import { alertToCheckin } from './personalize.js';

/** Décalage de chronotype caché utilisé pour générer les check-ins (min). */
export const DEMO_HIDDEN_SHIFT_MIN = 40;
/** Nombre de jours d'historique générés. */
export const DEMO_HISTORY_DAYS = 28;

/** Profil déclaré de la démo : chronoShiftMin = 0 (la personne ne sait pas encore qu'elle est plus tardive). */
export function demoProfile() {
  return {
    chronoShiftMin: 0, sleepNeedH: 8, caffeineSensitivity: 1, caffeineHalfLifeH: 5,
    usualWake: '07:45', usualBed: '00:15', workStart: '09:30', workEnd: '18:30',
    workDays: [1, 2, 3, 4, 5], tz: 'Europe/Paris', fit: null,
  };
}

/**
 * État de démonstration complet, conforme au contrat (ARCHITECTURE.md).
 * @param {number} nowMs instant « maintenant » (l'historique couvre les 28 jours qui précèdent)
 * @param {number} [seed=7]
 */
export function makeDemoState(nowMs, seed = 7) {
  const rand = rng(seed);
  // Gaussienne déterministe (Box–Muller) et entier dans [a, b].
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const between = (a, b) => a + (b - a) * rand();
  const chance = (p) => rand() < p;
  const round5 = (min) => Math.round(min / 5) * 5;

  const profile = demoProfile();
  const today = startOfDay(nowMs);
  const firstDay = addDays(today, -(DEMO_HISTORY_DAYS - 1));
  const isFree = (dayMs) => !profile.workDays.includes(new Date(dayMs).getDay()); // jour libre = week-end

  // ------------------------------------------------------------------ sommeil
  // Nuit i : réveil le jour (today − i). Quelques nuits courtes imposées pour que la dette se lise sur 14 jours.
  // Indexées par rang de « nuit de semaine » en remontant (0 = la plus récente) : les nuits du week-end restent longues.
  const SHORT_NIGHTS = { 0: 6.1, 1: 6.4, 3: 5.4, 6: 5.5, 9: 5.8, 12: 5.6, 14: 6.0 };
  let workRank = -1;
  const sleeps = [];
  const wakeByDay = new Map();
  const shortDays = new Set(); // jours qui suivent une nuit courte (on compense au café)
  for (let i = DEMO_HISTORY_DAYS - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    const free = isFree(day);
    if (!free) workRank++;
    let bedMin; let wakeMin;
    if (free) {
      bedMin = 24 * 60 + 125 + clamp(gauss() * 30, -60, 60); // ≈ 02 h 05
      wakeMin = 10 * 60 + 25 + clamp(gauss() * 30, -50, 50); // ≈ 10 h 25
    } else {
      bedMin = 24 * 60 + 40 + clamp(gauss() * 35, -70, 70); // ≈ 00 h 40
      wakeMin = 7 * 60 + 30 + clamp(gauss() * 14, -25, 25); // réveil au réveil-matin
    }
    // Les coucher « après minuit » sont exprimés en minutes depuis minuit de la veille du réveil.
    let wakeMs = atMinutes(day, round5(wakeMin));
    let bedMs = atMinutes(addDays(day, -1), round5(bedMin));
    if (!free && workRank in SHORT_NIGHTS) bedMs = wakeMs - Math.round(SHORT_NIGHTS[workRank] * 60 + gauss() * 8) * MIN;
    if (wakeMs > nowMs) continue; // le réveil n'a pas encore eu lieu
    const durH = (wakeMs - bedMs) / HOUR;
    const quality = Math.round(clamp(2.2 + (durH - 5.5) * 0.85 + gauss() * 0.7, 1, 5));
    wakeByDay.set(day, wakeMs);
    if (!free && workRank in SHORT_NIGHTS) shortDays.add(day);
    sleeps.push({ id: `demo-s-${String(DEMO_HISTORY_DAYS - i).padStart(2, '0')}`, bedMs, wakeMs, quality });
  }
  // Une sieste d'un samedi (20-25 min), classique pour la démo du planificateur.
  for (let i = 5; i < DEMO_HISTORY_DAYS; i++) {
    const day = addDays(today, -i);
    if (new Date(day).getDay() === 6) {
      const bedMs = atMinutes(day, 14 * 60 + 35);
      if (bedMs + 25 * MIN <= nowMs) sleeps.push({ id: 'demo-s-nap', bedMs, wakeMs: bedMs + 25 * MIN, quality: 4, nap: true });
      break;
    }
  }
  sleeps.sort((a, b) => a.wakeMs - b.wakeMs);

  // ------------------------------------------------------------------ caféine
  const caffeine = [];
  let cn = 0;
  const addCaf = (tMs, mg, kind) => {
    if (tMs > nowMs) return;
    caffeine.push({ id: `demo-c-${String(++cn).padStart(3, '0')}`, tMs, mg, kind });
  };
  for (let i = DEMO_HISTORY_DAYS - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    const free = isFree(day);
    const wake = wakeByDay.get(day) ?? atMinutes(day, 7 * 60 + 45);
    const wakeMin = (wake - day) / MIN;
    addCaf(atMinutes(day, round5(wakeMin + between(35, 75))), 85 + Math.round(between(-5, 10)), 'café');
    if (chance(0.85)) addCaf(atMinutes(day, round5(free ? between(13 * 60 + 15, 14 * 60 + 30) : between(12 * 60 + 40, 13 * 60 + 40))), 63, 'expresso');
    // Le troisième : trop tard une fois sur deux (c'est la leçon de l'écran Bilan).
    const shortNight = shortDays.has(day) || shortDays.has(addDays(day, -1));
    if (chance(shortNight ? 0.95 : 0.82)) {
      const late = chance(0.85);
      addCaf(atMinutes(day, round5(late ? between(16 * 60 + 5, 17 * 60 + 45) : between(15 * 60, 15 * 60 + 50))),
        chance(0.3) ? 40 : 80, chance(0.3) ? 'thé' : 'café');
    }
  }
  caffeine.sort((a, b) => a.tMs - b.tMs);

  // ------------------------------------------------------------------ check-ins (issus du VRAI modèle + décalage caché)
  const hidden = { ...profile, chronoShiftMin: DEMO_HIDDEN_SHIFT_MIN };
  const spanH = Math.ceil((nowMs - firstDay) / HOUR) + 2;
  const truth = buildModel({ profile: hidden, sleeps, caffeine, fromMs: firstDay, hours: spanH, stepMin: 10, nowMs });
  const idxAt = (ms) => Math.round((ms - truth.t0) / (truth.stepMin * MIN));
  const checkins = [];
  let kn = 0;
  const NOTES = { 1: 'Zombie, la tête dans le brouillard', 2: 'Un peu à plat', 4: 'Bien en forme', 5: 'En pleine forme, tout fluide' };
  for (let i = DEMO_HISTORY_DAYS - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    const lateShift = isFree(day) ? 75 : 0; // week-end : tout est décalé
    const dayMood = gauss() * 3; // humeur du jour, commune aux check-ins de la journée
    // Trois fenêtres où l'on pense à noter : matin (pente montante), après-midi (creux), soirée (pente descendante).
    const windows = [[8 * 60 + 15, 11 * 60 + 30], [13 * 60 + 45, 16 * 60 + 15], [17 * 60 + 30, 22 * 60 + 30]];
    for (const [a, b] of windows) {
      if (chance(0.1)) continue;
      const tMs = atMinutes(day, round5(between(a + lateShift * 0.8, b + lateShift * 0.3)));
      if (tMs > nowMs || truth.asleep[clamp(idxAt(tMs), 0, truth.n - 1)]) continue;
      const alert = clamp(valueAt(truth.alert, truth, tMs) + dayMood + gauss() * 6, 0, 100);
      const alertness = Math.round(clamp(alertToCheckin(alert), 1, 5));
      const c = { id: `demo-k-${String(++kn).padStart(3, '0')}`, tMs, alertness };
      if (NOTES[alertness] && chance(0.12)) c.note = NOTES[alertness];
      checkins.push(c);
    }
  }
  checkins.sort((a, b) => a.tMs - b.tMs);

  // ------------------------------------------------------------------ tâches
  const at = (dayOffset, hh, mm = 0) => atMinutes(addDays(today, dayOffset), hh * 60 + mm);
  const T = (n, title, durMin, load, priority, extra = {}) => ({
    id: `demo-t-${String(n).padStart(2, '0')}`, title, durMin, load, priority, done: false, tags: [], createdMs: at(-9, 10), ...extra,
  });
  const done = (n, title, durMin, load, priority, doneDay, doneHour, tags = []) => T(n, title, durMin, load, priority, {
    done: true, doneMs: at(doneDay, doneHour, 20), createdMs: at(doneDay - 5, 10), tags,
  });
  const tasks = [
    // À faire — du plus profond au plus léger, échéances étalées sur 10 jours
    T(1, 'Corriger le bug de synchronisation hors-ligne', 120, 5, 1, { deadlineMs: at(2, 17), tags: ['deep', 'atelier-nova'], notes: 'Reproduire d\'abord avec le jeu de données de Paul.' }),
    T(2, 'Refonte du module de facturation', 240, 5, 2, { deadlineMs: at(5, 18), tags: ['deep', 'boreal'], splittable: true, minBlockMin: 60 }),
    T(3, 'Écrire la spec de l\'API partenaires', 120, 4, 2, { deadlineMs: at(4, 12), tags: ['deep'] }),
    T(4, 'Préparer la démo pour Atelier Nova', 90, 3, 2, { deadlineMs: at(3, 16), tags: ['atelier-nova'] }),
    T(5, 'Revue de code : PR « export CSV »', 45, 3, 3, { deadlineMs: at(1, 18), tags: ['revue'] }),
    T(6, 'Rédiger l\'article de blog sur les tests', 90, 4, 3, { deadlineMs: at(9, 18), tags: ['blog'], splittable: true }),
    T(7, 'Migrer la CI vers le nouveau runner', 75, 4, 3, { deadlineMs: at(7, 18), tags: ['devops'] }),
    T(8, 'Répondre aux e-mails clients', 30, 1, 2, { deadlineMs: at(0, 18), tags: ['admin'] }),
    T(9, 'Facturer Boréal (octobre)', 20, 2, 1, { deadlineMs: at(1, 12), tags: ['admin', 'boreal'] }),
    T(10, 'Mettre à jour le devis du projet Nova', 40, 2, 3, { deadlineMs: at(6, 18), tags: ['admin'] }),
    T(11, 'Ranger les notes et tickets de la semaine', 25, 1, 4, { tags: ['admin'] }),
    T(12, 'Appeler le comptable', 15, 1, 3, { deadlineMs: at(4, 17), tags: ['admin'] }),
    T(13, 'Explorer la nouvelle API de notifications', 60, 3, 4, { deadlineMs: at(10, 18), tags: ['veille'] }),
    // Faites cette semaine (pour les anneaux et la série de jours du Bilan)
    done(14, 'Déployer la v2.3 en préproduction', 60, 4, 1, -1, 11, ['devops']),
    done(15, 'Relire le contrat de maintenance', 30, 2, 2, -1, 15, ['admin']),
    done(16, 'Concevoir le schéma de la base clients', 150, 5, 1, -2, 10, ['deep', 'boreal']),
    done(17, 'Réunion de cadrage — compte rendu', 30, 1, 3, -3, 16, ['admin']),
    done(18, 'Écrire les tests du module d\'export', 90, 4, 2, -4, 11, ['deep']),
    done(19, 'Trier la boîte de réception', 20, 1, 3, -4, 17, ['admin']),
    done(20, 'Optimiser la requête du tableau de bord', 90, 4, 2, -6, 10, ['deep', 'atelier-nova']),
  ];

  // ------------------------------------------------------------------ agenda (réunions récurrentes autour d'aujourd'hui)
  const events = [];
  let en = 0;
  const addEvent = (dayMs, title, hhmmStart, hhmmEnd) => {
    const startMs = atMinutes(dayMs, hhmmStart);
    events.push({ id: `demo-e-${String(++en).padStart(3, '0')}`, title, startMs, endMs: atMinutes(dayMs, hhmmEnd), source: 'manual', uid: `demo-${en}@kairos.local` });
  };
  const m = (h, mn = 0) => h * 60 + mn;
  for (let d = -7; d <= 9; d++) {
    const day = addDays(today, d);
    const wd = new Date(day).getDay();
    if (wd === 1 || wd === 4) addEvent(day, 'Point client — Atelier Nova', m(10), m(10, 30));
    if (wd === 2) addEvent(day, 'Visio Boréal — cadrage', m(11), m(11, 45));
    if (wd === 3) addEvent(day, 'Atelier design avec Inès', m(14), m(15, 30));
    if (wd === 5) addEvent(day, 'Rétro de la semaine & facturation', m(16, 30), m(17, 15));
    if (wd === 2 || wd === 4) addEvent(day, 'Escalade', m(19), m(20, 30));
    if (wd === 4) addEvent(day, 'Déjeuner avec Paul', m(12, 30), m(14));
  }
  events.sort((a, b) => a.startMs - b.startMs);

  // ------------------------------------------------------------------ sessions de concentration passées
  // Leur note de ressenti suit l'alerte prédite (bonne session dans un pic, plus dure dans un creux) + du bruit.
  const focus = [];
  let fn = 0;
  const taskPool = tasks.filter((t) => t.load >= 3);
  const windowsF = [[10 * 60 + 40, 13 * 60], [13 * 60 + 30, 15 * 60], [16 * 60 + 15, 17 * 60 + 40]];
  const durChoices = [25, 25, 45, 50, 90];
  for (let i = DEMO_HISTORY_DAYS - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    if (isFree(day)) continue;
    const perDay = chance(0.2) ? 1 : chance(0.65) ? 2 : 3;
    let cursor = 0;
    for (let k = 0; k < perDay; k++) {
      const [a, b] = windowsF[k];
      const plannedMin = durChoices[Math.floor(rand() * durChoices.length)];
      const startMs = atMinutes(day, round5(between(a, b - plannedMin) ));
      if (startMs < cursor + 10 * MIN) continue;
      const actual = Math.max(10, plannedMin - (chance(0.25) ? Math.round(between(5, 20)) : 0));
      const endMs = startMs + actual * MIN;
      cursor = endMs;
      if (endMs > nowMs) continue;
      const alert = meanAlert(truth, startMs, endMs);
      const rating = Math.round(clamp(1 + (alert - 10) / 20 + gauss() * 0.6, 1, 5));
      const task = taskPool[Math.floor(rand() * taskPool.length)];
      focus.push({ id: `demo-f-${String(++fn).padStart(3, '0')}`, taskId: task.id, startMs, endMs, plannedMin, rating });
    }
  }
  focus.sort((a, b) => a.startMs - b.startMs);

  return {
    version: 1,
    profile,
    sleeps, caffeine, checkins, tasks, events,
    plan: null,
    focus,
    prefs: { theme: 'auto', notifications: false, weekStart: 1, demo: true, onboarded: true },
  };
}

export default makeDemoState;
