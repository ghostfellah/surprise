import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, memoryBackend, DEFAULT_STATE, makeDefaultState, CURRENT_VERSION, createDefaultBackend, normalizeState, migrateState } from '../site/js/store.js';

const H = 3_600_000;
const T0 = new Date(2026, 10, 22, 14, 0).getTime();

/** Store prêt, horloge contrôlée, sauvegarde quasi immédiate. */
async function mk(opts = {}) {
  const clock = { t: T0 };
  const backend = opts.backend || memoryBackend(opts.initial ?? null);
  const store = createStore({ backend, now: () => clock.t, saveDelayMs: 5, ...opts.store });
  await store.ready;
  return { store, backend, clock, a: store.actions };
}

test('DEFAULT_STATE : profil du contrat, préférences, onboarded:false, immuable', () => {
  assert.equal(DEFAULT_STATE.version, CURRENT_VERSION);
  assert.deepEqual(DEFAULT_STATE.profile, {
    chronoShiftMin: 0, sleepNeedH: 8, caffeineSensitivity: 1, caffeineHalfLifeH: 5, usualWake: '07:00', usualBed: '23:00',
    workStart: '09:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5], tz: 'Europe/Paris', fit: null,
  });
  assert.deepEqual(DEFAULT_STATE.prefs, { theme: 'auto', notifications: false, weekStart: 1, demo: false, onboarded: false });
  assert.equal(DEFAULT_STATE.plan, null);
  for (const k of ['sleeps', 'caffeine', 'checkins', 'tasks', 'events', 'focus']) assert.deepEqual(DEFAULT_STATE[k], []);
  assert.throws(() => { 'use strict'; DEFAULT_STATE.tasks.push(1); });
  makeDefaultState().tasks.push(1); // l'usine, elle, rend des objets frais
});

test('démarrage sans données : état par défaut, prêt', async () => {
  const { store } = await mk();
  const s = store.getState();
  assert.equal(s.version, CURRENT_VERSION);
  assert.equal(s.prefs.onboarded, false);
  assert.equal(s.tasks.length, 0);
  assert.equal(store.canUndo(), false);
  assert.equal(store.canRedo(), false);
});

// ───────────── tâches : validation et normalisation ─────────────

test('addTask : valeurs par défaut, clamp, tags, champs inconnus ignorés', async () => {
  const { store, a } = await mk();
  const t = a.addTask({ title: '  Rédiger   le rapport ', durMin: 47, load: 9, priority: -3, tags: ['#Deep', '@maison', 'deep', 42, ''], hack: 'x', done: 'oui', notes: '  n  ' });
  assert.equal(t.title, 'Rédiger le rapport');
  assert.equal(t.durMin, 45); // multiple de 5
  assert.equal(t.load, 5);
  assert.equal(t.priority, 1);
  assert.deepEqual(t.tags, ['deep', 'maison']);
  assert.equal(t.done, false);
  assert.equal(t.createdMs, T0);
  assert.equal(t.notes, 'n');
  assert.equal('hack' in t, false);
  assert.match(t.id, /^t_/);
  assert.deepEqual(store.getState().tasks[0], t);
  const d = a.addTask({ title: 'Défauts' });
  assert.equal(d.durMin, 30);
  assert.equal(d.load, 3);
  assert.equal(d.priority, 3);
  assert.notEqual(d.id, t.id);
});

test('addTask : refus avec message français', async () => {
  const { a } = await mk();
  for (const bad of [undefined, null, 'texte', 5, [], {}, { title: '   ' }, { title: 42 }]) {
    assert.throws(() => a.addTask(bad), /titre|Données/i);
  }
});

test('addTask : identifiant fourni respecté, doublon régénéré, échéances incohérentes nettoyées', async () => {
  const { a } = await mk();
  const x = a.addTask({ id: 'mon-id', title: 'A', deadlineMs: T0 + H, earliestMs: T0 + 3 * H });
  assert.equal(x.id, 'mon-id');
  assert.equal(x.earliestMs, undefined, 'earliest > deadline : écarté');
  const y = a.addTask({ id: 'mon-id', title: 'B', deadlineMs: 'abc', earliestMs: '1000' });
  assert.notEqual(y.id, 'mon-id');
  assert.equal(y.deadlineMs, undefined);
  assert.equal(y.earliestMs, 1000);
});

test('updateTask / completeTask / removeTask', async () => {
  const { store, a, clock } = await mk();
  const t = a.addTask({ title: 'Faire', durMin: 60, deadlineMs: T0 + 5 * H });
  const u = a.updateTask(t.id, { title: 'Faire mieux', load: 4, deadlineMs: null, id: 'pirate', createdMs: 1 });
  assert.equal(u.id, t.id);
  assert.equal(u.createdMs, T0);
  assert.equal(u.title, 'Faire mieux');
  assert.equal(u.deadlineMs, undefined);
  assert.throws(() => a.updateTask('nope', { title: 'x' }), /introuvable/);
  assert.throws(() => a.updateTask(t.id, { title: '' }), /titre/);
  assert.equal(store.getState().tasks[0].title, 'Faire mieux', 'un refus ne modifie rien');
  clock.t += H;
  const c = a.completeTask(t.id);
  assert.equal(c.done, true);
  assert.equal(c.doneMs, T0 + H);
  assert.equal(a.completeTask(t.id, false).done, false);
  assert.equal(store.getState().tasks[0].doneMs, undefined);
  assert.throws(() => a.completeTask('nope'), /introuvable/);
  assert.equal(a.removeTask(t.id), true);
  assert.equal(a.removeTask(t.id), false);
  assert.equal(store.getState().tasks.length, 0);
});

test('removeTask retire aussi ses blocs du planning', async () => {
  const { store, a } = await mk();
  const t1 = a.addTask({ title: 'A' }), t2 = a.addTask({ title: 'B' });
  a.setPlan({ generatedMs: T0, horizonDays: 7, blocks: [
    { taskId: t1.id, startMs: T0, endMs: T0 + H, score: 80, reason: 'r' },
    { taskId: t2.id, startMs: T0 + H, endMs: T0 + 2 * H, score: 70, reason: 'r' },
  ] });
  a.removeTask(t1.id);
  assert.deepEqual(store.getState().plan.blocks.map((b) => b.taskId), [t2.id]);
});

// ───────────── événements ─────────────

test('événements : validation, tri, replaceEvents par source', async () => {
  const { store, a } = await mk();
  const e2 = a.addEvent({ title: 'Plus tard', startMs: T0 + 5 * H, endMs: T0 + 6 * H });
  const e1 = a.addEvent({ title: 'Plus tôt', startMs: T0 + H, endMs: T0 + 2 * H, source: 'ics', allDay: true, uid: 'u1' });
  assert.deepEqual(store.getState().events.map((e) => e.id), [e1.id, e2.id], 'trié par début');
  assert.equal(e1.source, 'ics');
  assert.equal(e1.allDay, true);
  assert.equal(e2.source, 'manual');
  assert.throws(() => a.addEvent({ title: 'X', startMs: T0, endMs: T0 }), /fin/);
  assert.throws(() => a.addEvent({ title: 'X', startMs: 'a', endMs: T0 }), /invalide/);
  assert.throws(() => a.addEvent({ title: '', startMs: T0, endMs: T0 + H }), /titre/);
  const added = a.replaceEvents('ics', [
    { id: 'i1', title: 'Importé 1', startMs: T0 + 10 * H, endMs: T0 + 11 * H },
    { id: 'i2', title: 'Cassé', startMs: 5, endMs: 1 },
    null,
    { id: 'i3', title: 'Importé 2', startMs: T0 + 8 * H, endMs: T0 + 9 * H, source: 'manual' }, // source forcée
  ]);
  assert.equal(added, 2);
  const evs = store.getState().events;
  assert.deepEqual(evs.map((e) => e.title), ['Plus tard', 'Importé 2', 'Importé 1']);
  assert.ok(evs.filter((e) => e.title.startsWith('Importé')).every((e) => e.source === 'ics'));
  assert.equal(a.updateEvent(e2.id, { title: 'Renommé' }).title, 'Renommé');
  assert.throws(() => a.updateEvent(e2.id, { endMs: 1 }), /fin/);
  assert.equal(a.removeEvent(e2.id), true);
});

// ───────────── journaux ─────────────

test('sommeil, caféine, bilans : validation, clamp, tri', async () => {
  const { store, a } = await mk();
  const s2 = a.logSleep({ bedMs: T0 + 24 * H, wakeMs: T0 + 32 * H, quality: 9, nap: false });
  const s1 = a.logSleep({ bedMs: T0, wakeMs: T0 + 7 * H, quality: 0.2, nap: true });
  assert.equal(s2.quality, 5);
  assert.equal(s1.quality, 1);
  assert.equal(s1.nap, true);
  assert.equal('nap' in s2, false);
  assert.deepEqual(store.getState().sleeps.map((s) => s.id), [s1.id, s2.id]);
  assert.throws(() => a.logSleep({ bedMs: T0, wakeMs: T0 }), /réveil/);
  assert.throws(() => a.logSleep({ bedMs: T0, wakeMs: T0 + 30 * H }), /24 h/);
  assert.throws(() => a.logSleep({ bedMs: 'x', wakeMs: T0 }), /invalide/);

  const c2 = a.logCaffeine({ tMs: T0 + H, mg: 80, kind: 'café' });
  const c1 = a.logCaffeine({ tMs: T0, mg: 5000, kind: 'licorne' });
  assert.equal(c1.mg, 1000);
  assert.equal(c1.kind, 'autre');
  assert.equal('kind' in a.logCaffeine({ tMs: T0, mg: 10 }), false);
  const tms = store.getState().caffeine.map((c) => c.tMs);
  assert.deepEqual(tms, [...tms].sort((x, y) => x - y));
  assert.ok(store.getState().caffeine.some((c) => c.id === c2.id));
  assert.throws(() => a.logCaffeine({ tMs: T0, mg: 0 }), /positif/);
  assert.throws(() => a.logCaffeine({ tMs: T0, mg: 'beaucoup' }), /positif/);
  assert.throws(() => a.logCaffeine({ mg: 50 }), /invalide/);

  const k = a.logCheckIn({ tMs: T0, alertness: 7.4, note: '  bof  ' });
  assert.equal(k.alertness, 5);
  assert.equal(k.note, 'bof');
  assert.equal(a.logCheckIn({ tMs: T0 - H, alertness: -3 }).alertness, 1);
  assert.equal(store.getState().checkins[0].tMs, T0 - H);
  assert.throws(() => a.logCheckIn({ tMs: T0, alertness: 'x' }), /alerte/);

  assert.equal(a.removeSleep(s1.id), true);
  assert.equal(a.removeSleep(s1.id), false);
  assert.equal(a.removeCaffeine(c1.id), true);
  assert.equal(a.removeCheckIn(k.id), true);
});

test('logFocus', async () => {
  const { store, a } = await mk();
  const f = a.logFocus({ taskId: 't1', startMs: T0, endMs: T0 + 25 * 60000, plannedMin: 25, rating: 9 });
  assert.equal(f.rating, 5);
  assert.equal(f.plannedMin, 25);
  assert.equal(a.logFocus({ startMs: T0, endMs: T0 + 10 * 60000 }).plannedMin, 10);
  assert.throws(() => a.logFocus({ startMs: T0, endMs: T0 - 1 }), /incohérentes/);
  assert.equal(store.getState().focus.length, 2);
});

// ───────────── profil, préférences, plan ─────────────

test('setProfile / setPrefs : bornes et refus', async () => {
  const { store, a } = await mk();
  const p = a.setProfile({ sleepNeedH: 14, caffeineSensitivity: 0.1, caffeineHalfLifeH: 50, chronoShiftMin: 9999.4, usualWake: '6:30', workDays: [1, 3, 3, 9, 'x', 0], inconnu: 1 });
  assert.equal(p.sleepNeedH, 10);
  assert.equal(p.caffeineSensitivity, 0.4);
  assert.equal(p.caffeineHalfLifeH, 9);
  assert.equal(p.chronoShiftMin, 360);
  assert.equal(p.usualWake, '06:30');
  assert.deepEqual(p.workDays, [0, 1, 3]);
  assert.equal('inconnu' in store.getState().profile, false);
  assert.throws(() => a.setProfile({ usualBed: '25:00' }), /HH:MM/);
  assert.throws(() => a.setProfile({ sleepNeedH: 'beaucoup' }), /nombre/);
  assert.throws(() => a.setProfile({ tz: 'Mars/Olympus' }), /fuseau/);
  assert.throws(() => a.setProfile(null), /invalides/);
  assert.equal(a.setProfile({ tz: 'America/New_York' }).tz, 'America/New_York');
  const fit = { fittedMs: T0, n: 12, rmse: 5, baselineRmse: 9, r2: 0.4, confidence: 3 };
  assert.equal(a.setProfile({ fit }).fit.confidence, 1);
  assert.equal(a.setProfile({ fit: { n: 1 } }).fit, null);

  assert.equal(a.setPrefs({ theme: 'dark', onboarded: true, weekStart: 0, zzz: 1 }).theme, 'dark');
  assert.equal(store.getState().prefs.onboarded, true);
  assert.equal(store.getState().prefs.weekStart, 0);
  assert.throws(() => a.setPrefs({ theme: 'rose' }), /thème/);
});

test('setPlan, lockBlock', async () => {
  const { store, a } = await mk();
  const plan = a.setPlan({ generatedMs: T0, horizonDays: 99, blocks: [
    { taskId: 'b', startMs: T0 + H, endMs: T0 + 2 * H, score: 70, reason: 'Pic' },
    { taskId: 'a', startMs: T0, endMs: T0 + H, score: 'x', reason: 5 },
    { taskId: 'z', startMs: 5, endMs: 5 },
    'pas un bloc',
  ] });
  assert.equal(plan.horizonDays, 60);
  assert.deepEqual(plan.blocks.map((b) => b.taskId), ['a', 'b']);
  assert.equal(plan.blocks[0].score, 0);
  assert.equal(plan.blocks[0].reason, '');
  assert.equal(a.lockBlock('a', T0).locked, true);
  assert.equal(store.getState().plan.blocks[0].locked, true);
  assert.equal('locked' in a.lockBlock('a', T0, false), false);
  assert.throws(() => a.lockBlock('a', 12345), /introuvable/);
  assert.equal(a.setPlan(null), null);
  assert.equal(store.getState().plan, null);
  assert.throws(() => a.lockBlock('a', T0), /introuvable/);
});

// ───────────── immutabilité, abonnements ─────────────

test('immutabilité : les anciens états ne changent jamais', async () => {
  const { store, a } = await mk();
  const before = store.getState();
  const snap = JSON.stringify(before);
  const t = a.addTask({ title: 'A' });
  a.updateTask(t.id, { title: 'B' });
  const mid = store.getState();
  a.removeTask(t.id);
  assert.equal(JSON.stringify(before), snap);
  assert.notEqual(store.getState(), mid);
  assert.equal(mid.tasks[0].title, 'B');
  // la valeur renvoyée est une copie : la modifier n'affecte pas l'état
  const x = a.addTask({ title: 'C' });
  x.title = 'piraté';
  assert.equal(store.getState().tasks[0].title, 'C');
});

test('subscribe : changement typé, désabonnement, abonné fautif isolé', async () => {
  const { store, a } = await mk();
  const seen = [];
  const off = store.subscribe((s, ch) => seen.push([ch.type, s.tasks.length]));
  store.subscribe(() => { throw new Error('boum'); });
  let ok = 0;
  store.subscribe(() => ok++);
  a.addTask({ title: 'A' });
  assert.deepEqual(seen, [['addTask', 1]]);
  assert.equal(ok, 1);
  store.undo();
  assert.deepEqual(seen[1], ['undo', 0]);
  off();
  a.addTask({ title: 'B' });
  assert.equal(seen.length, 2);
});

test('un refus ne notifie pas et ne remplit pas la pile d\'annulation', async () => {
  const { store, a } = await mk();
  let n = 0;
  store.subscribe(() => n++);
  assert.throws(() => a.addTask({ title: '' }));
  assert.equal(n, 0);
  assert.equal(store.canUndo(), false);
});

// ───────────── undo / redo ─────────────

test('undo / redo : aller-retour, redo effacé par une nouvelle action', async () => {
  const { store, a } = await mk();
  const t = a.addTask({ title: 'A' });
  a.completeTask(t.id);
  assert.equal(store.canUndo(), true);
  assert.equal(store.undo(), true);
  assert.equal(store.getState().tasks[0].done, false);
  assert.equal(store.canRedo(), true);
  assert.equal(store.redo(), true);
  assert.equal(store.getState().tasks[0].done, true);
  assert.equal(store.undo() && store.undo(), true);
  assert.equal(store.getState().tasks.length, 0);
  assert.equal(store.undo(), false);
  a.addTask({ title: 'B' });
  assert.equal(store.canRedo(), false);
  assert.equal(store.redo(), false);
});

test('undo : pile limitée à 50 étapes', async () => {
  const { store, a } = await mk();
  for (let i = 0; i < 70; i++) a.addTask({ title: `T${i}` });
  let n = 0;
  while (store.undo()) n++;
  assert.equal(n, 50);
  assert.equal(store.getState().tasks.length, 20);
});

test('undo : les rafales sur le même objet ne forment qu\'une étape', async () => {
  const { store, a, clock } = await mk();
  const t = a.addTask({ title: 'A' });
  clock.t += 5000;
  for (let i = 0; i < 10; i++) { clock.t += 100; a.updateTask(t.id, { title: `A${i}` }); }
  for (let i = 0; i < 10; i++) { clock.t += 50; a.setProfile({ sleepNeedH: 6 + i * 0.3 }); }
  assert.equal(store.getState().tasks[0].title, 'A9');
  store.undo(); // annule la rafale de profil
  assert.equal(store.getState().profile.sleepNeedH, 8);
  assert.equal(store.getState().tasks[0].title, 'A9');
  store.undo(); // annule la rafale de titre
  assert.equal(store.getState().tasks[0].title, 'A');
  // après une pause, une nouvelle étape
  clock.t += 5000;
  a.updateTask(t.id, { title: 'B' });
  clock.t += 5000;
  a.updateTask(t.id, { title: 'C' });
  store.undo();
  assert.equal(store.getState().tasks[0].title, 'B');
  // des objets différents ne se regroupent pas
  const u = a.addTask({ title: 'U' });
  a.updateTask(t.id, { title: 'D' });
  a.updateTask(u.id, { title: 'V' });
  store.undo();
  assert.equal(store.getState().tasks.find((x) => x.id === u.id).title, 'U');
  assert.equal(store.getState().tasks.find((x) => x.id === t.id).title, 'D');
});

test('une action sans effet n\'ajoute pas d\'étape', async () => {
  const { store, a } = await mk();
  const t = a.addTask({ title: 'A' });
  store.undo(); store.redo();
  const depth = () => { let n = 0; while (store.undo()) n++; while (store.redo());  return n; };
  a.updateTask(t.id, { title: 'A' });
  a.setPrefs({ theme: 'auto' });
  a.completeTask(t.id, false);
  assert.equal(depth(), 1);
});

// ───────────── persistance ─────────────

test('sauvegarde différée : regroupée, puis relue par un nouveau store', async () => {
  const backend = memoryBackend();
  const { store, a } = await mk({ backend, store: { saveDelayMs: 40 } });
  a.addTask({ title: 'A', durMin: 60, load: 4 });
  a.addTask({ title: 'B' });
  a.setPrefs({ onboarded: true });
  assert.equal(backend.saves, 0, 'rien n\'est écrit tout de suite');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(backend.saves, 1, 'une seule écriture pour la rafale');
  const store2 = createStore({ backend });
  await store2.ready;
  assert.deepEqual(store2.getState(), store.getState());
  assert.equal(store2.getState().prefs.onboarded, true);
  store.destroy(); store2.destroy();
});

test('flush écrit immédiatement ; undo est aussi sauvegardé', async () => {
  const { store, a, backend } = await mk({ store: { saveDelayMs: 10_000 } });
  a.addTask({ title: 'A' });
  await store.flush();
  assert.equal(JSON.parse(backend.data).tasks.length, 1);
  store.undo();
  await store.flush();
  assert.equal(JSON.parse(backend.data).tasks.length, 0);
  store.destroy();
});

test('backend qui plante : jamais d\'exception, l\'appli continue', async () => {
  const backend = { load: async () => { throw new Error('stockage bloqué'); }, save: async () => { throw new Error('quota'); } };
  const store = createStore({ backend, saveDelayMs: 1 });
  await store.ready;
  assert.ok(store.info.loadError);
  assert.doesNotThrow(() => store.actions.addTask({ title: 'A' }));
  await store.flush();
  assert.ok(store.info.saveError);
  assert.equal(store.getState().tasks.length, 1);
  const sync = { load() { throw new Error('sync'); }, save() { throw new Error('sync'); } };
  const s2 = createStore({ backend: sync, saveDelayMs: 1 });
  await s2.ready;
  s2.actions.addTask({ title: 'x' });
  await s2.flush();
  store.destroy(); s2.destroy();
});

test('backend par défaut sans IndexedDB ni localStorage (Node) : repli mémoire, aucun plantage', async () => {
  const b = createDefaultBackend();
  assert.equal(await b.load(), null);
  await b.save('{"a":1}');
  assert.equal(await b.load(), '{"a":1}');
  const store = createStore({ saveDelayMs: 1 });
  await store.ready;
  store.actions.addTask({ title: 'ok' });
  await store.flush();
  store.destroy();
});

test('backend par défaut : localStorage si IndexedDB est absent, y compris quand il lève', async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  try {
    const b = createDefaultBackend();
    await b.save('{"x":1}');
    assert.equal(mem.get('kairos.state.v1'), '{"x":1}');
    assert.equal(await createDefaultBackend().load(), '{"x":1}');
    globalThis.localStorage = { getItem() { throw new Error('bloqué'); }, setItem() { throw new Error('bloqué'); }, removeItem() { throw new Error('bloqué'); } };
    const b2 = createDefaultBackend();
    await b2.save('{"y":2}');
    assert.equal(await b2.load(), '{"y":2}', 'repli mémoire');
  } finally { delete globalThis.localStorage; }
});

test('données stockées corrompues : état par défaut + copie de secours, pas d\'écrasement aveugle', async () => {
  const backend = memoryBackend('{ceci n\'est pas du json');
  const { store } = await mk({ backend });
  assert.equal(store.getState().tasks.length, 0);
  assert.ok(store.info.loadError);
  assert.deepEqual(backend.backups, ['{ceci n\'est pas du json']);
});

test('données stockées d\'une version future : refus clair + copie de secours', async () => {
  const raw = JSON.stringify({ version: 99, tasks: [{ title: 'futur' }] });
  const backend = memoryBackend(raw);
  const { store } = await mk({ backend });
  assert.match(store.info.loadError.message, /plus récente/);
  assert.deepEqual(backend.backups, [raw]);
  assert.equal(store.getState().tasks.length, 0);
});

test('chargement tolérant : entrées invalides ignorées, données valides gardées, migration v0', async () => {
  const raw = JSON.stringify({
    tasks: [{ title: 'Valide', durMin: 61 }, { title: '' }, 7, null, { id: 'x', title: 'Doublon' }, { id: 'x', title: 'Doublon 2' }],
    events: [{ title: 'E', startMs: T0, endMs: T0 + H }, { title: 'KO', startMs: T0, endMs: T0 }],
    sleeps: [{ bedMs: T0, wakeMs: T0 + 8 * H }, { bedMs: 'a' }],
    profile: { sleepNeedH: 'x', usualWake: '08:15', zzz: 1 },
    prefs: { theme: 'nimporte', onboarded: true },
    plan: 'cassé',
    champInconnu: { a: 1 },
  });
  const { store } = await mk({ backend: memoryBackend(raw) });
  const s = store.getState();
  assert.equal(s.version, CURRENT_VERSION);
  assert.deepEqual(s.tasks.map((t) => t.title), ['Valide', 'Doublon', 'Doublon 2']);
  assert.equal(new Set(s.tasks.map((t) => t.id)).size, 3);
  assert.equal(s.tasks[0].durMin, 60);
  assert.equal(s.events.length, 1);
  assert.equal(s.sleeps.length, 1);
  assert.equal(s.profile.sleepNeedH, 8);
  assert.equal(s.profile.usualWake, '08:15');
  assert.equal(s.prefs.theme, 'auto');
  assert.equal(s.prefs.onboarded, true);
  assert.equal(s.plan, null);
  assert.equal('champInconnu' in s, false);
  assert.ok(store.info.dropped >= 6);
});

// ───────────── import / export ─────────────

async function populated() {
  const ctx = await mk();
  const { a } = ctx;
  const t = a.addTask({ title: 'Rédiger', durMin: 90, load: 5, tags: ['deep'], deadlineMs: T0 + 24 * H });
  a.addEvent({ title: 'Rdv', startMs: T0 + 2 * H, endMs: T0 + 3 * H });
  a.logSleep({ bedMs: T0 - 15 * H, wakeMs: T0 - 7 * H, quality: 4 });
  a.logCaffeine({ tMs: T0 - 5 * H, mg: 80, kind: 'café' });
  a.logCheckIn({ tMs: T0 - 3 * H, alertness: 4 });
  a.logFocus({ startMs: T0 - 2 * H, endMs: T0 - H, plannedMin: 60, taskId: t.id });
  a.setProfile({ usualWake: '06:45', sleepNeedH: 7.5 });
  a.setPrefs({ onboarded: true, theme: 'dark' });
  a.setPlan({ generatedMs: T0, horizonDays: 7, blocks: [{ taskId: t.id, startMs: T0 + H, endMs: T0 + 2 * H, score: 90, reason: 'Pic' }] });
  return ctx;
}
const strip = (s) => { const { app, exportedMs, ...rest } = s; return rest; };

test('exportJSON -> importJSON : aller-retour exact, undoable', async () => {
  const { store, a } = await populated();
  const json = a.exportJSON();
  const original = store.getState();
  const { store: other, a: a2 } = await mk();
  const res = a2.importJSON(json);
  assert.equal(res.dropped, 0);
  assert.deepEqual(other.getState(), original);
  assert.equal(other.canUndo(), true);
  other.undo();
  assert.equal(other.getState().tasks.length, 0);
});

test('importJSON : erreurs françaises lisibles', async () => {
  const { store, a } = await mk();
  const before = store.getState();
  for (const [input, re] of [
    ['', /vide/], ['   ', /vide/], [undefined, /vide/], ['{pas json', /JSON/], ['[1,2]', /sauvegarde Kairos/], ['42', /sauvegarde Kairos/], ['null', /sauvegarde Kairos/],
    ['{"foo":1}', /sauvegarde Kairos/], [JSON.stringify({ version: 2, tasks: [] }), /plus récente/],
  ]) assert.throws(() => a.importJSON(input), re, String(input));
  assert.equal(store.getState(), before, 'aucun changement après un refus');
});

test('importJSON tolérant : champs inconnus, entrées invalides, BOM', async () => {
  const { store, a } = await mk();
  const res = a.importJSON('﻿' + JSON.stringify({ version: 1, zzz: 1, tasks: [{ title: 'OK', bonus: 1 }, { title: 5 }], prefs: { onboarded: true, bonus: 1 } }));
  assert.equal(res.dropped, 1);
  assert.equal(store.getState().tasks.length, 1);
  assert.equal('bonus' in store.getState().tasks[0], false);
  assert.equal(store.getState().prefs.onboarded, true);
});

test('exportEncrypted -> importEncrypted ; mauvais mot de passe ; données altérées', async () => {
  const { store, a } = await populated();
  const enc = await a.exportEncrypted('secret é');
  assert.ok(enc.startsWith('kairos1.'));
  assert.ok(!enc.includes('Rédiger'));
  const { store: other, a: a2 } = await mk();
  await assert.rejects(() => a2.importEncrypted(enc, 'faux'), { message: 'Mot de passe incorrect ou données corrompues' });
  await assert.rejects(() => a2.importEncrypted(enc.slice(0, -8), 'secret é'), { message: 'Mot de passe incorrect ou données corrompues' });
  assert.equal(other.getState().tasks.length, 0);
  await a2.importEncrypted(enc, 'secret é');
  assert.deepEqual(other.getState(), store.getState());
});

test('exportEncrypted d\'un contenu chiffré mais pas Kairos : refus clair', async () => {
  const { encryptJSON } = await import('../site/js/core/crypto.js');
  const { a } = await mk();
  const foreign = await encryptJSON({ hello: 1 }, 'pw');
  await assert.rejects(() => a.importEncrypted(foreign, 'pw'), /sauvegarde Kairos/);
});

test('loadState', async () => {
  const { store, a } = await mk();
  a.loadState({ version: 1, tasks: [{ title: 'Via loadState' }] });
  assert.equal(store.getState().tasks[0].title, 'Via loadState');
  assert.throws(() => a.loadState('x'), /sauvegarde Kairos/);
});

test('loadDemo marque prefs.demo ; resetAll remet à zéro ; les deux sont annulables', async () => {
  const { store, a } = await populated();
  const demo = { version: 1, tasks: [{ title: 'Tâche démo', load: 4 }], sleeps: [{ bedMs: T0 - 10 * H, wakeMs: T0 - 2 * H }], prefs: { demo: false, onboarded: true } };
  a.loadDemo(demo);
  assert.equal(store.getState().prefs.demo, true);
  assert.equal(store.getState().prefs.onboarded, true);
  assert.equal(store.getState().tasks.length, 1);
  assert.equal(store.getState().events.length, 0, 'la démo remplace tout');
  assert.throws(() => a.loadDemo(null), /démonstration/);
  assert.equal(demo.prefs.demo, false, 'le jeu fourni n\'est pas modifié');
  a.resetAll();
  const s = store.getState();
  assert.equal(s.tasks.length, 0);
  assert.equal(s.prefs.onboarded, false);
  assert.equal(s.prefs.demo, false);
  assert.equal(s.profile.usualWake, '07:00');
  store.undo();
  assert.equal(store.getState().prefs.demo, true);
  store.undo();
  assert.equal(store.getState().prefs.onboarded, true);
  assert.equal(store.getState().tasks[0].title, 'Rédiger');
});

test('migrateState / normalizeState exposés', () => {
  assert.equal(migrateState({ tasks: [] }).version, 1);
  assert.throws(() => migrateState({ version: 3 }), /plus récente/);
  assert.throws(() => migrateState(null), /sauvegarde Kairos/);
  const { state, dropped } = normalizeState({ tasks: [{ title: 'a' }, {}] }, { now: T0 });
  assert.equal(state.tasks.length, 1);
  assert.equal(dropped, 1);
});

test('robustesse : charges volumineuses et entrées hostiles', async () => {
  const { store, a } = await mk();
  const many = Array.from({ length: 3000 }, (_, i) => ({ title: `T${i}`, durMin: 30 }));
  a.importJSON(JSON.stringify({ version: 1, tasks: many }));
  assert.equal(store.getState().tasks.length, 3000);
  const proto = JSON.parse('{"version":1,"__proto__":{"polluted":1},"tasks":[{"title":"x","__proto__":{"polluted":1}}]}');
  a.importJSON(JSON.stringify(proto));
  assert.equal({}.polluted, undefined);
  assert.equal(a.addTask({ title: 'sym', durMin: Symbol('s') }).durMin, 30);
  const t = a.addTask({ title: 'x'.repeat(1000) });
  assert.equal(t.title.length, 200);
});
