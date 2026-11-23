// Tests de insights.js : statistiques, constats chiffrés, honnêteté sur le manque de données, ajustement personnel.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeInsights, insightCards, personalizeFromState, makeEvaluator, accuracyOf, weeklySummaryText, lastDays,
} from '../site/js/core/insights.js';
import { makeDemoState, DEMO_HIDDEN_SHIFT_MIN } from '../site/js/core/demo.js';
import { normalizeProfilePatch } from '../site/js/store.js';
import { buildModel, valueAt } from '../site/js/core/model.js';
import { startOfDay, addDays, HOUR } from '../site/js/core/time.js';

const NOW = new Date(2026, 10, 23, 14, 0).getTime();

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}
const demo = () => makeDemoState(NOW, 7);
const empty = () => ({ profile: {}, sleeps: [], caffeine: [], checkins: [], tasks: [], events: [], focus: [], plan: null, prefs: {} });

test('computeInsights sur la démo : sommeil, caféine, focus, tâches', () => {
  const I = computeInsights(deepFreeze(demo()), NOW);
  assert.ok(I.sleep.avgH28 > 6.5 && I.sleep.avgH28 < 7.8, `sommeil moyen ${I.sleep.avgH28}`);
  assert.ok(I.sleep.debtH >= 2, `dette ${I.sleep.debtH}`);
  assert.equal(I.sleep.debtPerNight.length, 14);
  assert.ok(I.sleep.debtPerNight[0].dayMs < I.sleep.debtPerNight[13].dayMs, 'ancien → récent');
  assert.ok(I.sleep.socialJetlagMin > 60, `jet lag social ${I.sleep.socialJetlagMin}`);
  assert.ok(I.sleep.bedSdMin > 20 && I.sleep.regularity >= 0 && I.sleep.regularity <= 100);
  assert.equal(I.chronotype.label, 'chouette');
  assert.match(I.chronotype.explanation, /chouette/);
  assert.ok(I.caffeine.perDayMg28 > 120 && I.caffeine.perDayMg28 < 320);
  assert.ok(I.caffeine.lastIntakeMeanMin > 14 * 60 && I.caffeine.lastIntakeMeanMin < 18 * 60);
  assert.ok(I.caffeine.atBedMgMean > 10, `caféine au coucher ${I.caffeine.atBedMgMean}`);
  assert.ok(I.caffeine.suggestedCutoffMin < I.caffeine.lastIntakeMeanMin, 'la coupure suggérée est avant la dernière prise moyenne');
  assert.equal(I.caffeine.series14.length, 14);
  assert.ok(I.focus.min28 > 600 && I.focus.sessions28 > 15);
  assert.ok(I.focus.inPeakShare >= 0 && I.focus.inPeakShare <= 1);
  assert.match(I.focus.bestWindow.label, /^\d\d:\d\d–\d\d:\d\d$/);
  assert.ok(I.tasks.done7 >= 4 && I.tasks.dueWeek >= 4 && I.tasks.overdue === 0);
  assert.equal(I.week.length, 7);
  assert.ok(I.week[6].isToday);
  assert.ok(I.streak.days >= 1);
  for (const k of ['focus', 'tasks', 'sleep']) assert.ok(I.rings[k].frac >= 0 && I.rings[k].frac <= 1);
});

test('précision du modèle : points de calibration, RMSE, corrélation', () => {
  const I = computeInsights(demo(), NOW);
  const a = I.accuracy;
  assert.equal(a.status, 'ok');
  assert.equal(a.points.length, a.n);
  assert.ok(a.n >= 60 && a.rmse > 0 && a.rmse < a.baselineRmse, `rmse ${a.rmse} vs ${a.baselineRmse}`);
  assert.ok(a.r > 0.4);
  const p = a.points[0];
  assert.ok(p.predicted >= 0 && p.predicted <= 100 && p.felt >= 10 && p.felt <= 90 && p.checkin >= 1);
  const t = accuracyOf([{ predicted: 10, felt: 10 }, { predicted: 50, felt: 50 }, { predicted: 90, felt: 90 }]);
  assert.equal(t.rmse, 0);
  assert.equal(t.r, 1);
  assert.equal(accuracyOf([]).n, 0);
});

test('insightCards : 3 à 6 constats chiffrés, triés par impact, avec un niveau valide', () => {
  const I = computeInsights(demo(), NOW);
  const cards = insightCards(I);
  assert.ok(cards.length >= 3 && cards.length <= 6, `${cards.length} cartes`);
  for (let i = 1; i < cards.length; i++) assert.ok(cards[i - 1].impact >= cards[i].impact, 'tri par impact');
  for (const c of cards) {
    assert.ok(['info', 'conseil', 'alerte'].includes(c.level));
    assert.ok(c.title.length > 3 && c.text.length > 20 && c.icon);
    assert.ok(c.impact >= 0 && c.impact <= 100);
  }
  assert.ok(cards.some((c) => /\d/.test(c.text)), 'au moins un constat chiffré');
  const caf = cards.find((c) => c.id === 'caffeine-late');
  assert.ok(caf, 'la démo a une caféine tardive');
  assert.match(caf.text, /Ta dernière caféine est en moyenne à \d\d:\d\d/);
  assert.match(caf.text, /\d+ mg au coucher/);
  assert.match(caf.text, /essaie de t'arrêter vers \d\d:\d\d/);
  assert.equal(insightCards(I, { max: 3 }).length, 3);
  // jamais de ton médical anxiogène
  for (const c of insightCards(I)) assert.doesNotMatch(c.text, /danger|maladie|grave|pathologi|diagnostic/i);
});

test('manque de données : pas de crash, messages honnêtes', () => {
  const I = computeInsights(empty(), NOW);
  assert.equal(I.coverage.hasAnyData, false);
  assert.equal(I.sleep.avgH7, null);
  assert.equal(I.chronotype.msfscMin, null);
  assert.equal(I.accuracy.status, 'none');
  assert.equal(I.accuracy.needed, 8);
  const cards = insightCards(I);
  assert.ok(cards.length >= 3);
  assert.ok(cards.some((c) => /calibrer/.test(c.title)));
  // quelques check-ins seulement
  const s = demo();
  s.checkins = s.checkins.slice(-3);
  const J = computeInsights(s, NOW);
  assert.equal(J.accuracy.status, 'few');
  assert.ok(insightCards(J).some((c) => c.title === 'Encore 5 check-ins pour calibrer'));
  assert.ok(weeklySummaryText(I).includes('Bilan Kairos'));
});

test('personalizeFromState : retrouve le décalage caché, ne mute pas l\'état, patch et fit valides pour le store', () => {
  const s = deepFreeze(demo());
  const r = personalizeFromState(s, NOW);
  assert.ok(['good', 'moderate'].includes(r.verdict), r.verdict);
  assert.equal(r.applicable, true);
  assert.ok(r.profilePatch.chronoShiftMin >= 15 && r.profilePatch.chronoShiftMin <= 90, `décalage ${r.profilePatch.chronoShiftMin}`);
  assert.ok(Math.abs(r.profilePatch.chronoShiftMin - DEMO_HIDDEN_SHIFT_MIN) < 35);
  assert.ok(r.profilePatch.sleepNeedH >= 6 && r.profilePatch.sleepNeedH <= 10);
  assert.ok(r.after.rmse < r.before.rmse, 'après < avant');
  assert.ok(r.fit.n >= 60 && r.fit.confidence > 0.3 && r.fit.r2 > 0.3 && r.fit.rmse < r.fit.baselineRmse);
  // accepté tel quel par le store (strict) : toutes les clés numériques de fit présentes
  const patch = normalizeProfilePatch({ ...r.profilePatch, fit: r.fit });
  assert.ok(patch.fit, 'fit conservé par normalizeFit');
  assert.equal(patch.chronoShiftMin, r.profilePatch.chronoShiftMin);
  assert.match(r.reason, /plus tardive/);
});

test('personalizeFromState refuse poliment sous 8 check-ins, et refuse le bruit pur', () => {
  const s = demo();
  s.checkins = s.checkins.slice(-5);
  const r = personalizeFromState(s, NOW);
  assert.equal(r.verdict, 'refused');
  assert.equal(r.applicable, false);
  assert.deepEqual(r.profilePatch, {});
  assert.equal(r.fit.confidence, 0);
  assert.equal(r.needed, 3);
  assert.match(r.reason, /Pas assez de check-ins \(5 sur 8/);
  // bruit pur : réponses sans rapport avec l'heure → on ne touche à rien
  const noisy = demo();
  noisy.checkins = noisy.checkins.map((c, i) => ({ ...c, alertness: 1 + ((i * 7 + 3) % 5) }));
  const q = personalizeFromState(noisy, NOW);
  assert.equal(q.applicable, false, `verdict ${q.verdict}`);
  assert.deepEqual(q.profilePatch, {});
});

test('l\'évaluateur rapide colle à buildModel (grille 30 min vs 5 min)', () => {
  const s = demo();
  const from = startOfDay(addDays(NOW, -28));
  const times = s.checkins.map((c) => c.tMs);
  const ev = makeEvaluator({ profile: s.profile, sleeps: s.sleeps, caffeine: s.caffeine, times, fromMs: from, toMs: NOW });
  const fast = ev({ chronoShiftMin: 30, sleepNeedH: 8.5 });
  const m = buildModel({ profile: { ...s.profile, chronoShiftMin: 30, sleepNeedH: 8.5 }, sleeps: s.sleeps, caffeine: s.caffeine, fromMs: from, hours: Math.ceil((NOW - from) / HOUR) + 1, stepMin: 5 });
  const ref = times.map((t) => valueAt(m.alert, m, t));
  const diffs = fast.map((v, i) => Math.abs(v - ref[i])).sort((a, b) => a - b);
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  assert.ok(meanDiff < 0.8, `écart moyen ${meanDiff.toFixed(2)}`);
  // les rares écarts forts sont des check-ins pris à quelques minutes d'un réveil (rampe de 8 min que la grille lisse)
  assert.ok(diffs[Math.floor(diffs.length * 0.95)] < 3, `95e centile ${diffs[Math.floor(diffs.length * 0.95)].toFixed(2)}`);
});

test('weeklySummaryText et lastDays', () => {
  const I = computeInsights(demo(), NOW);
  const txt = weeklySummaryText(I);
  assert.match(txt, /^Bilan Kairos · 17\/11 → 23\/11/);
  assert.match(txt, /Sommeil : /);
  assert.match(txt, /Tâches : \d+ terminée/);
  assert.match(txt, /pas un avis médical/);
  const d = lastDays(NOW, 7);
  assert.equal(d.length, 7);
  assert.equal(d[6], startOfDay(NOW));
});
