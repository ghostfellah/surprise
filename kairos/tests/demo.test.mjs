// Tests de demo.js : forme valide, déterminisme, cohérence temporelle, et surtout la « démo de la personnalisation » :
// un ajustement sur les check-ins générés doit retrouver le décalage de chronotype caché.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDemoState, demoProfile, DEMO_HIDDEN_SHIFT_MIN } from '../site/js/core/demo.js';
import { normalizeState, normalizeProfilePatch } from '../site/js/store.js';
import { buildModel, valueAt } from '../site/js/core/model.js';
import { fitParams, checkinToAlert } from '../site/js/core/personalize.js';
import { sleepDebt, chronotypeEstimate } from '../site/js/core/sleep.js';
import { startOfDay, addDays, HOUR, DAY, MIN } from '../site/js/core/time.js';

const NOW = new Date(2026, 10, 23, 14, 0).getTime(); // lundi 23 novembre 2026, 14 h

test('forme valide : passe normalizeState sans rien écarter', () => {
  const s = makeDemoState(NOW, 7);
  const { state, dropped } = normalizeState(JSON.parse(JSON.stringify(s)));
  assert.equal(dropped, 0);
  assert.equal(s.version, 1);
  for (const k of ['sleeps', 'caffeine', 'checkins', 'tasks', 'events', 'focus']) {
    assert.equal(state[k].length, s[k].length, `${k} : rien ne doit être écarté`);
    assert.ok(s[k].length > 0, `${k} non vide`);
  }
  assert.equal(s.plan, null);
  assert.equal(s.prefs.demo, true);
  assert.equal(s.prefs.onboarded, true);
  assert.deepEqual(Object.keys(normalizeProfilePatch(s.profile)).sort(), Object.keys(s.profile).sort());
  assert.equal(s.profile.fit, null);
  assert.equal(s.profile.chronoShiftMin, 0, 'le décalage caché n\'est PAS dans le profil');
});

test('déterministe à graine égale, différent sinon', () => {
  const a = JSON.stringify(makeDemoState(NOW, 7));
  assert.equal(a, JSON.stringify(makeDemoState(NOW, 7)));
  assert.equal(a, JSON.stringify(makeDemoState(NOW))); // graine par défaut = 7
  assert.notEqual(a, JSON.stringify(makeDemoState(NOW, 8)));
});

test('cohérence temporelle : tout le passé est dans le passé, rien ne se chevauche', () => {
  for (const now of [NOW, new Date(2026, 10, 21, 6, 30).getTime(), new Date(2026, 10, 22, 23, 50).getTime()]) {
    const s = makeDemoState(now, 7);
    const start = startOfDay(addDays(now, -28));
    const ids = new Set();
    const uniq = (id) => { assert.ok(!ids.has(id), `id en double : ${id}`); ids.add(id); };
    s.sleeps.forEach((x) => { uniq(x.id); assert.ok(x.bedMs < x.wakeMs && x.wakeMs <= now && x.bedMs >= start); });
    for (let i = 1; i < s.sleeps.length; i++) assert.ok(s.sleeps[i].bedMs >= s.sleeps[i - 1].wakeMs, 'sommeils sans chevauchement');
    s.caffeine.forEach((x) => { uniq(x.id); assert.ok(x.tMs <= now && x.tMs >= start && x.mg > 0); });
    s.checkins.forEach((x) => { uniq(x.id); assert.ok(x.tMs <= now && x.tMs >= start && x.alertness >= 1 && x.alertness <= 5); });
    s.focus.forEach((x) => { uniq(x.id); assert.ok(x.startMs < x.endMs && x.endMs <= now); assert.ok(s.tasks.some((t) => t.id === x.taskId)); });
    s.tasks.forEach((t) => {
      uniq(t.id);
      if (t.done) assert.ok(t.doneMs <= now && t.doneMs > t.createdMs);
      else if (t.deadlineMs) assert.ok(t.deadlineMs >= startOfDay(now) && t.deadlineMs <= now + 11 * DAY, 'échéances sur les 10 prochains jours');
    });
    s.events.forEach((e) => { uniq(e.id); assert.ok(e.endMs > e.startMs); });
    for (const k of ['sleeps', 'caffeine', 'checkins', 'events', 'focus']) {
      const key = k === 'sleeps' ? 'wakeMs' : k === 'events' || k === 'focus' ? 'startMs' : 'tMs';
      for (let i = 1; i < s[k].length; i++) assert.ok(s[k][i][key] >= s[k][i - 1][key], `${k} trié`);
    }
  }
});

test('persona : ~7 h en semaine, week-ends décalés, 2-3 cafés, dette visible, chouette', () => {
  const s = makeDemoState(NOW, 7);
  const nights = s.sleeps.filter((x) => !x.nap);
  assert.ok(s.sleeps.some((x) => x.nap), 'une sieste');
  assert.ok(nights.length >= 27);
  const dur = (x) => (x.wakeMs - x.bedMs) / HOUR;
  const free = (x) => [0, 6].includes(new Date(x.wakeMs).getDay());
  const avg = (a) => a.reduce((t, x) => t + dur(x), 0) / a.length;
  const wk = avg(nights.filter((x) => !free(x)));
  const we = avg(nights.filter(free));
  assert.ok(wk > 6.4 && wk < 7.6, `semaine ${wk.toFixed(2)} h`);
  assert.ok(we > wk + 0.7, `week-end ${we.toFixed(2)} h`);
  assert.ok(nights.filter((x) => dur(x) < 6.2).length >= 3, 'quelques nuits courtes');
  const perDay = s.caffeine.length / 28;
  assert.ok(perDay >= 2 && perDay <= 3.2, `${perDay.toFixed(2)} prises/jour`);
  assert.ok(sleepDebt(s.sleeps, s.profile, NOW).debtH >= 2, 'dette de sommeil visible');
  assert.equal(chronotypeEstimate(s.sleeps, s.profile).label, 'chouette');
  const perDayCk = s.checkins.length / 28;
  assert.ok(perDayCk > 2 && perDayCk <= 3, `${perDayCk.toFixed(2)} check-ins/jour`);
  assert.ok(s.tasks.filter((t) => t.done).length >= 4 && s.tasks.filter((t) => !t.done).length >= 8);
  assert.ok(s.tasks.some((t) => t.load >= 5) && s.tasks.some((t) => t.load <= 1));
  assert.ok(s.events.some((e) => e.startMs > NOW) && s.focus.length >= 20);
});

test('check-ins issus du vrai modèle : ils collent mieux au décalage caché qu\'au profil déclaré', () => {
  const s = makeDemoState(NOW, 7);
  const from = startOfDay(addDays(NOW, -28));
  const rmseWith = (shift) => {
    const m = buildModel({ profile: { ...s.profile, chronoShiftMin: shift }, sleeps: s.sleeps, caffeine: s.caffeine, fromMs: from, hours: Math.ceil((NOW - from) / HOUR) + 1, stepMin: 10 });
    let se = 0;
    for (const c of s.checkins) se += (valueAt(m.alert, m, c.tMs) - checkinToAlert(c.alertness)) ** 2;
    return Math.sqrt(se / s.checkins.length);
  };
  assert.ok(rmseWith(DEMO_HIDDEN_SHIFT_MIN) < rmseWith(0) - 0.5, 'le vrai décalage explique mieux les réponses');
});

test('fitParams retrouve un décalage de chronotype positif sur les check-ins générés', () => {
  const s = makeDemoState(NOW, 7);
  const from = startOfDay(addDays(NOW, -28));
  const hours = Math.ceil((NOW - from) / HOUR) + 1;
  const targets = s.checkins.map((c) => checkinToAlert(c.alertness));
  const evaluate = (v) => {
    const m = buildModel({ profile: { ...s.profile, ...v }, sleeps: s.sleeps, caffeine: s.caffeine, fromMs: from, hours, stepMin: 30 });
    return s.checkins.map((c) => valueAt(m.alert, m, c.tMs));
  };
  const res = fitParams({ params: { chronoShiftMin: { value: 0, min: -180, max: 180 } }, evaluate, targets, restarts: 2, maxIter: 80, cv: false });
  assert.ok(res.values.chronoShiftMin > 10, `décalage retrouvé : ${res.values.chronoShiftMin.toFixed(1)} min`);
  assert.ok(Math.abs(res.values.chronoShiftMin - DEMO_HIDDEN_SHIFT_MIN) < 35, `proche de ${DEMO_HIDDEN_SHIFT_MIN} min`);
  assert.ok(res.rmse < res.baselineRmse);
});

test('demoProfile : copie fraîche à chaque appel', () => {
  const a = demoProfile(); a.workDays.push(6);
  assert.deepEqual(demoProfile().workDays, [1, 2, 3, 4, 5]);
  void MIN;
});
