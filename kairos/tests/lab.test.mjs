// Tests du Labo : optimiseur déterministe et scénarios « et si ? ».
// Lancer : TZ=Europe/Paris node --test kairos/tests/lab.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN, HOUR, startOfDay } from '../site/js/core/time.js';
import { buildModel } from '../site/js/core/model.js';
import { caffeineAt, CAFFEINE } from '../site/js/core/caffeine.js';
import {
  optimizeDay, referenceScenario, buildScenarioModel, workWindow, workScore, scenarioMetrics,
  sleepRisk, onsetLatencyMin, kindForMg, planText, LAB,
} from '../site/js/core/lab.js';

const profile = {
  chronoShiftMin: 0, sleepNeedH: 8, caffeineSensitivity: 1, caffeineHalfLifeH: 5,
  usualWake: '07:00', usualBed: '23:00', workStart: '09:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5], tz: 'Europe/Paris', fit: null,
};
const day = new Date(2026, 10, 23).getTime(); // lundi 23 novembre 2026
const at = (h, m = 0, d = day) => new Date(new Date(d).getFullYear(), new Date(d).getMonth(), new Date(d).getDate(), h, m).getTime();

// Une semaine de nuits réelles (légèrement courtes) + un café habituel.
function history() {
  const sleeps = []; const caffeine = [];
  for (let k = 1; k <= 7; k++) {
    const d = day - k * 86_400_000;
    sleeps.push({ id: `s${k}`, bedMs: at(23, 30, d - 86_400_000), wakeMs: at(6, 50, d) });
  }
  sleeps.sort((a, b) => a.wakeMs - b.wakeMs);
  caffeine.push({ id: 'c0', tMs: at(8, 15, day - 86_400_000), mg: 80, kind: 'café' });
  return { sleeps, caffeine };
}

test('workWindow : heures de travail du profil, repli sûr', () => {
  const w = workWindow(profile, day + 5 * HOUR);
  assert.equal(w.startMs, at(9)); assert.equal(w.endMs, at(18));
  const bad = workWindow({ workStart: '18:00', workEnd: '09:00' }, day);
  assert.equal(bad.startMs, at(9));
});

test('référence : le scénario issu de l\'état reproduit exactement le modèle réel', () => {
  const { sleeps, caffeine } = history();
  const { scenario, model } = referenceScenario({ profile, sleeps, caffeine, dayMs: day });
  assert.ok(scenario.lastNight && scenario.tonight);
  assert.ok(scenario.lastNight.wakeMs > day && scenario.lastNight.wakeMs < at(12));
  assert.ok(scenario.tonight.bedMs > at(20));
  const rebuilt = buildScenarioModel({ profile, sleeps, caffeine, dayMs: day, scenario });
  assert.equal(rebuilt.alert.length, model.alert.length);
  for (let i = 0; i < model.alert.length; i++) assert.ok(Math.abs(rebuilt.alert[i] - model.alert[i]) < 1e-9, `écart à l'index ${i}`);
});

test('scénario : un café de plus augmente l\'alerte moyenne ; une nuit courte la baisse', () => {
  const { sleeps, caffeine } = history();
  const { scenario, model } = referenceScenario({ profile, sleeps, caffeine, dayMs: day });
  const win = workWindow(profile, day);
  const base = workScore(model, win.startMs, win.endMs);
  const withCoffee = { ...scenario, caffeine: [...scenario.caffeine, { tMs: at(10), mg: 80 }] };
  const m1 = buildScenarioModel({ profile, sleeps, caffeine, dayMs: day, scenario: withCoffee });
  assert.ok(workScore(m1, win.startMs, win.endMs) > base);
  const short = { ...scenario, lastNight: { bedMs: scenario.lastNight.wakeMs - 4 * HOUR, wakeMs: scenario.lastNight.wakeMs } };
  const m2 = buildScenarioModel({ profile, sleeps, caffeine, dayMs: day, scenario: short });
  assert.ok(workScore(m2, win.startMs, win.endMs) < base, 'une nuit de 4 h doit coûter de l\'alerte');
});

test('optimizeDay : l\'optimum bat la référence', () => {
  const { sleeps, caffeine } = history();
  const r = optimizeDay({ profile, sleeps, caffeine, dayMs: day });
  assert.equal(r.changed, true);
  assert.ok(r.score > r.baselineScore, `${r.score} doit dépasser ${r.baselineScore}`);
  assert.ok(r.gainPct > 0);
  assert.ok(r.explain.length >= 2 && r.explain.every((s) => typeof s === 'string' && s.length > 10));
  // le score annoncé est bien celui du modèle complet
  const m = buildScenarioModel({ profile, sleeps, caffeine, dayMs: day, scenario: r.scenario });
  const win = workWindow(profile, day);
  assert.ok(Math.abs(workScore(m, win.startMs, win.endMs) - r.score) < 1e-9);
});

test('optimizeDay : caféine au coucher sous le seuil, 0 à 3 prises, ≤ 400 mg/jour', () => {
  const { sleeps, caffeine } = history();
  for (const thr of [25, 40, 10]) {
    const r = optimizeDay({ profile, sleeps, caffeine, dayMs: day, objective: { thresholdMg: thr } });
    const bed = r.scenario.tonight.bedMs;
    const logs = [...r.scenario.priorCaffeine, ...r.scenario.caffeine].filter((l) => l.tMs < bed);
    const atBed = caffeineAt(logs, profile, bed);
    assert.ok(atBed <= thr + 1e-6, `seuil ${thr} : ${atBed.toFixed(2)} mg au coucher`);
    assert.ok(r.plan.caffeine.length <= 3);
    assert.ok(r.scenario.caffeine.reduce((a, c) => a + c.mg, 0) <= CAFFEINE.maxDailyMg);
    for (const d of r.plan.caffeine) assert.ok(d.tMs < bed - 2 * HOUR);
  }
});

test('optimizeDay : préserve le besoin de sommeil', () => {
  const { sleeps, caffeine } = history();
  for (const needH of [7, 8, 9]) {
    const p = { ...profile, sleepNeedH: needH };
    const r = optimizeDay({ profile: p, sleeps, caffeine, dayMs: day });
    const { bedMs, wakeMs } = r.scenario.tonight;
    assert.ok((wakeMs - bedMs) / HOUR - 0.25 >= needH - 1 / 60 || bedMs <= r.baselineScenario.tonight.bedMs - 119 * MIN, `besoin ${needH} h non couvert`);
  }
});

test('optimizeDay : déterministe', () => {
  const { sleeps, caffeine } = history();
  const a = optimizeDay({ profile, sleeps, caffeine, dayMs: day });
  const b = optimizeDay({ profile, sleeps, caffeine, dayMs: day });
  assert.deepEqual(a, b);
});

test('optimizeDay : rapide (< 300 ms) même à froid', () => {
  const { sleeps, caffeine } = history();
  optimizeDay({ profile, sleeps, caffeine, dayMs: day }); // chauffe JIT
  const worst = Math.max(...[0, 1, 2].map((k) => {
    const t = performance.now();
    optimizeDay({ profile, sleeps, caffeine, dayMs: day + k * 86_400_000 });
    return performance.now() - t;
  }));
  assert.ok(worst < 300, `trop lent : ${worst.toFixed(0)} ms`);
});

test('optimizeDay : earliestMs interdit les prises dans le passé', () => {
  const { sleeps, caffeine } = history();
  const now = at(11, 40);
  const r = optimizeDay({ profile, sleeps, caffeine, dayMs: day, objective: { earliestMs: now } });
  for (const d of r.plan.caffeine) assert.ok(d.tMs >= now, 'prise planifiée avant maintenant');
});

test('optimizeDay : désactiver sieste et coucher les laisse intacts', () => {
  const { sleeps, caffeine } = history();
  const r = optimizeDay({ profile, sleeps, caffeine, dayMs: day, objective: { allowNap: false, allowBedtime: false } });
  assert.equal(r.scenario.nap, null);
  assert.equal(r.scenario.tonight.bedMs, r.baselineScenario.tonight.bedMs);
});

test('optimizeDay : sans journaux (état vide) ne plante pas et ne fait jamais pire', () => {
  const r = optimizeDay({ profile, sleeps: [], caffeine: [], dayMs: day });
  assert.ok(r.score >= r.baselineScore);
  assert.ok(Number.isFinite(r.gainPct));
});

test('optimizeDay : si la caféine déjà bue dépasse le seuil, rien n\'est ajouté', () => {
  const { sleeps } = history();
  const heavy = [{ id: 'x', tMs: at(19), mg: 200 }];
  const r = optimizeDay({ profile, sleeps, caffeine: heavy, dayMs: day, objective: { earliestMs: at(19, 30) } });
  assert.equal(r.plan.caffeine.length, 0);
});

test('métriques : cohérentes avec le modèle, delta de la référence nul', () => {
  const { sleeps, caffeine } = history();
  const { scenario, model } = referenceScenario({ profile, sleeps, caffeine, dayMs: day });
  const a = scenarioMetrics({ model, profile, dayMs: day, scenario, goldenThr: model.stats.p75 });
  const b = scenarioMetrics({ model: buildScenarioModel({ profile, sleeps, caffeine, dayMs: day, scenario }), profile, dayMs: day, scenario, goldenThr: model.stats.p75 });
  assert.equal(a.meanWork, b.meanWork);
  assert.ok(a.goldenMin >= 0 && a.goldenMin <= 540);
  assert.ok(a.onsetMs > a.bedMs);
  assert.ok(Number.isFinite(a.dlmoMs));
});

test('risque pour le sommeil et latence : monotones', () => {
  assert.equal(sleepRisk({ atBedMg: 0, sleepH: 8, needH: 8 }).level, 'faible');
  assert.equal(sleepRisk({ atBedMg: 90, sleepH: 5, needH: 8 }).level, 'élevé');
  assert.ok(sleepRisk({ atBedMg: 40, sleepH: 8, needH: 8 }).score > sleepRisk({ atBedMg: 20, sleepH: 8, needH: 8 }).score);
  assert.ok(onsetLatencyMin(80) > onsetLatencyMin(10));
  assert.equal(onsetLatencyMin(0), 15);
});

test('kindForMg et planText', () => {
  assert.equal(kindForMg(40), 'thé'); assert.equal(kindForMg(63), 'expresso'); assert.equal(kindForMg(80), 'café');
  const { sleeps, caffeine } = history();
  const r = optimizeDay({ profile, sleeps, caffeine, dayMs: day });
  const txt = planText(r.scenario, { dayMs: day, optimized: r });
  assert.match(txt, /Mon plan énergie · lundi 23 novembre/);
  assert.match(txt, /coucher/);
  assert.ok(LAB.doses.length > 0 && startOfDay(day) === day);
});

test('le modèle de référence est inchangé par le Labo (pas d\'effet de bord)', () => {
  const { sleeps, caffeine } = history();
  const before = buildModel({ profile, sleeps, caffeine, fromMs: day, hours: 36 }).alert.join();
  optimizeDay({ profile, sleeps, caffeine, dayMs: day });
  const after = buildModel({ profile, sleeps, caffeine, fromMs: day, hours: 36 }).alert.join();
  assert.equal(before, after);
});
