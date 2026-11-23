import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadVar, loadMeter, fitTone, alertLabel, clampSel, weekOffset, viewDays, weekTitle, dayHead, clipToDay, visibleRange,
  hourLabels, yToMin, minToY, slotStartMs, layoutColumns, energySamples, haloGradient, energyPaths, workBand, capacityMin,
  blockMetrics, eventWorkOverlap, annotateParts, dayLoad, deepInPeaks, summarizePlan, remainingMin, unplacedFromPlan, dueInfo, sortTasks,
  filterTasks, countFilters, groupTasks, tokenSegments, describeParsed, entryToItem, gestureStep, swipeIntent, keyMove,
  moveVerdict, fixMonths, applyMove, withoutBlock, icsRange, planToText, plural, blockKey, navStep,
} from '../site/js/ui/plan-helpers.js';
import { MIN, HOUR, DAY } from '../site/js/core/time.js';

const at = (y, m, d, h = 0, mi = 0) => new Date(y, m, d, h, mi).getTime();
const NOW = at(2026, 10, 23, 10, 0); // lundi 23 novembre 2026, 10:00
const D0 = at(2026, 10, 23);
const profile = { workStart: '09:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5] };
// courbe plate à 80 le jour, 20 la nuit — sur 2 jours à partir de D0
const curve = (() => { const alert = []; for (let i = 0; i <= 2 * 288; i++) { const h = (i * 5) / 60 % 24; alert.push(h >= 8 && h < 20 ? 80 : 20); } return { t0: D0, stepMin: 5, alert }; })();

test('charge : couleur, jauge, tonalité', () => {
  assert.equal(loadVar(4), 'var(--load-4)');
  assert.equal(loadVar(99), 'var(--load-5)');
  assert.deepEqual(loadMeter(3), [true, true, true, false, false]);
  assert.deepEqual(loadMeter(0), [false, false, false, false, false]);
  assert.equal(fitTone(0.95), 'great');
  assert.equal(fitTone(0.7), 'good');
  assert.equal(fitTone(0.5), 'ok');
  assert.equal(fitTone(0.1), 'poor');
  assert.equal(alertLabel(90), 'Pic');
  assert.equal(alertLabel(10), 'Creux');
});

test('fenêtre affichée : semaine alignée sur aujourd\'hui, mode jour', () => {
  assert.equal(clampSel(-3), 0);
  assert.equal(clampSel(100), 27);
  assert.equal(weekOffset(0), 0);
  assert.equal(weekOffset(6), 0);
  assert.equal(weekOffset(7), 7);
  const w = viewDays(NOW, 9, 'week');
  assert.equal(w.length, 7);
  assert.equal(w[0], at(2026, 10, 30));
  assert.equal(w[6], at(2026, 11, 6));
  const d = viewDays(NOW, 9, 'day');
  assert.deepEqual(d, [at(2026, 11, 2)]);
  assert.equal(navStep('week'), 7);
  assert.equal(navStep('day'), 1);
});

test('titres de semaine et en-têtes de jour', () => {
  assert.equal(weekTitle(viewDays(NOW, 0)), '23 – 29 novembre');
  assert.equal(weekTitle(viewDays(NOW, 7)), '30 nov. – 6 déc.');
  assert.match(weekTitle([D0]), /lundi 23 novembre/);
  const h = dayHead(D0);
  assert.equal(h.dow, 'LUN');
  assert.equal(h.num, 23);
});

test('clipToDay : découpe un intervalle sur un jour', () => {
  assert.deepEqual(clipToDay(at(2026, 10, 23, 9), at(2026, 10, 23, 10, 30), D0), { startMin: 540, endMin: 630 });
  assert.deepEqual(clipToDay(at(2026, 10, 22, 22), at(2026, 10, 23, 2), D0), { startMin: 0, endMin: 120 });
  assert.deepEqual(clipToDay(at(2026, 10, 23, 22), at(2026, 10, 24, 2), D0), { startMin: 1320, endMin: 1440 });
  assert.equal(clipToDay(at(2026, 10, 24, 9), at(2026, 10, 24, 10), D0), null);
});

test('plage visible : travail élargi puis étendue aux éléments', () => {
  const r = visibleRange({ profile, days: [D0] });
  assert.equal(r.startMin, 7 * 60);
  assert.equal(r.endMin, 20 * 60);
  assert.equal(r.span, 13 * 60);
  const r2 = visibleRange({ profile, days: [D0], blocks: [{ startMs: at(2026, 10, 23, 5, 30), endMs: at(2026, 10, 23, 6), taskId: 'a' }], events: [{ startMs: at(2026, 10, 23, 21), endMs: at(2026, 10, 23, 22, 30) }] });
  assert.equal(r2.startMin, 5 * 60);
  assert.equal(r2.endMin, 23 * 60);
  const r3 = visibleRange({ profile, days: [D0], events: [{ startMs: at(2026, 10, 23, 1), endMs: at(2026, 10, 23, 2), allDay: true }] });
  assert.equal(r3.startMin, 7 * 60); // les événements « toute la journée » n'étendent pas la plage
  const labels = hourLabels({ startMin: 420, endMin: 600 });
  assert.deepEqual(labels.map((l) => l.label), ['07:00', '08:00', '09:00', '10:00']);
});

test('conversions pixel ↔ minute', () => {
  const range = { startMin: 420, endMin: 1200 };
  assert.equal(minToY(540, range, 1), 120);
  assert.equal(yToMin(120, range, 1), 540);
  assert.equal(yToMin(122, range, 1, 5), 540);
  assert.equal(yToMin(123, range, 1, 5), 545);
  assert.equal(yToMin(60, range, 2), 450);
  assert.equal(slotStartMs(D0, 541, 5), at(2026, 10, 23, 9));
  assert.equal(slotStartMs(D0, 543, 5), at(2026, 10, 23, 9, 5), 'arrondi à 5 min');
});

test('layoutColumns : chevauchements répartis en colonnes', () => {
  const out = layoutColumns([
    { id: 'a', startMin: 540, endMin: 600 },
    { id: 'b', startMin: 570, endMin: 630 },
    { id: 'c', startMin: 600, endMin: 660 },
    { id: 'd', startMin: 700, endMin: 760 },
  ]);
  const by = Object.fromEntries(out.map((o) => [o.id, o]));
  assert.equal(by.a.cols, 2);
  assert.equal(by.b.cols, 2);
  assert.notEqual(by.a.col, by.b.col);
  assert.equal(by.c.col, by.a.col); // c reprend la colonne libérée par a
  assert.equal(by.d.cols, 1);
  assert.equal(by.d.col, 0);
  assert.deepEqual(out.map((o) => o.id), ['a', 'b', 'c', 'd'], 'ordre d\'entrée conservé');
});

test('courbe d\'énergie : échantillons, halo et chemins', () => {
  const range = { startMin: 420, endMin: 1200 };
  const s = energySamples(curve, D0, range, 60);
  assert.equal(s[0].min, 420);
  assert.equal(s[0].v, 20);
  assert.equal(s.find((x) => x.min === 600).v, 80);
  assert.equal(s[s.length - 1].min, 1200);
  assert.deepEqual(energySamples(null, D0, range), []);
  const g = haloGradient(s, range);
  assert.match(g, /^linear-gradient\(180deg, /);
  assert.match(g, /var\(--sun\)/);
  assert.match(g, /var\(--dip\)/);
  assert.equal(haloGradient([], range), 'none');
  const p = energyPaths(s, range);
  assert.match(p.line, /^M20\.00 0 L/);
  assert.match(p.area, /Z$/);
  assert.ok(p.area.includes(`L0 ${range.endMin - range.startMin}`));
});

test('plages de travail et capacité', () => {
  const w = workBand(profile, D0);
  assert.equal(w.isWorkDay, true);
  assert.equal(capacityMin(profile, D0), 9 * 60 - 90);
  assert.equal(capacityMin(profile, D0, false), 9 * 60);
  assert.equal(capacityMin(profile, at(2026, 10, 28)), 0); // samedi
  assert.equal(workBand(profile, at(2026, 10, 28)).isWorkDay, false);
});

test('événements dans les plages de travail', () => {
  const ev = [
    { startMs: at(2026, 10, 23, 8), endMs: at(2026, 10, 23, 10) }, // 1 h dans la plage
    { startMs: at(2026, 10, 23, 11, 30), endMs: at(2026, 10, 23, 14) }, // 30 min avant déjeuner + 30 min après
    { startMs: at(2026, 10, 23, 16), endMs: at(2026, 10, 23, 17), allDay: true }, // ignoré
  ];
  assert.equal(eventWorkOverlap(ev, profile, D0), 120);
  assert.equal(eventWorkOverlap(ev, profile, at(2026, 10, 28)), 0, 'jour non travaillé');
});

test('métriques de bloc et numéros de partie', () => {
  const task = { id: 't1', load: 5 };
  const b = { taskId: 't1', startMs: at(2026, 10, 23, 10), endMs: at(2026, 10, 23, 11) };
  const m = blockMetrics(b, task, curve);
  assert.equal(m.alert, 80);
  assert.ok(m.fit > 0.9);
  assert.equal(m.tone, 'great');
  const night = blockMetrics({ taskId: 't1', startMs: at(2026, 10, 23, 2), endMs: at(2026, 10, 23, 3) }, task, curve);
  assert.equal(night.tone, 'poor');
  const parts = annotateParts([
    { taskId: 'x', startMs: 3, endMs: 4 }, { taskId: 'x', startMs: 1, endMs: 2 }, { taskId: 'y', startMs: 2, endMs: 3 },
  ]);
  assert.deepEqual(parts.get(blockKey({ taskId: 'x', startMs: 1 })), { part: 1, parts: 2 });
  assert.deepEqual(parts.get(blockKey({ taskId: 'x', startMs: 3 })), { part: 2, parts: 2 });
  assert.deepEqual(parts.get(blockKey({ taskId: 'y', startMs: 2 })), { part: 1, parts: 1 });
});

test('charge par jour, travail profond dans les pics', () => {
  const tasks = [{ id: 'a', load: 5, durMin: 120 }, { id: 'b', load: 2, durMin: 60 }];
  const blocks = [
    { taskId: 'a', startMs: at(2026, 10, 23, 10), endMs: at(2026, 10, 23, 12) },
    { taskId: 'b', startMs: at(2026, 10, 23, 14), endMs: at(2026, 10, 23, 15) },
    { taskId: 'a', startMs: at(2026, 10, 24, 6), endMs: at(2026, 10, 24, 7) },
  ];
  const l = dayLoad(blocks, tasks, D0, [{ startMs: at(2026, 10, 23, 16), endMs: at(2026, 10, 23, 17) }, { allDay: true, startMs: D0, endMs: D0 + DAY }]);
  assert.deepEqual(l.byLoad, [0, 60, 0, 0, 120]);
  assert.equal(l.total, 180);
  assert.equal(l.events, 60);
  const d = deepInPeaks({ blocks, tasks, curve });
  assert.equal(d.deepMin, 180);
  assert.equal(d.peakMin, 120);
  assert.ok(Math.abs(d.ratio - 120 / 180) < 1e-9);
  const s = summarizePlan({ blocks: blocks.slice(0, 2), tasks, curve });
  assert.equal(s.placedMin, 180);
  assert.equal(s.count, 2);
  assert.ok(s.meanFit > 0.5 && s.meanFit <= 1);
});

test('minutes restantes et tâches non placées', () => {
  const tasks = [
    { id: 'a', durMin: 120, done: false },
    { id: 'b', durMin: 30, done: false },
    { id: 'c', durMin: 60, done: true },
  ];
  const blocks = [{ taskId: 'a', startMs: 0, endMs: 90 * MIN }, { taskId: 'b', startMs: 0, endMs: 30 * MIN }];
  assert.equal(remainingMin(tasks[0], blocks), 30);
  assert.equal(remainingMin(tasks[1], blocks), 0);
  assert.equal(remainingMin(tasks[2], []), 0);
  assert.deepEqual(unplacedFromPlan(tasks, blocks), [{ taskId: 'a', minutes: 30 }]);
});

test('échéances relatives', () => {
  assert.equal(dueInfo(undefined, NOW), null);
  assert.deepEqual(dueInfo(NOW - HOUR, NOW), { text: 'en retard', tone: 'late', days: -1 });
  assert.equal(dueInfo(NOW - 3 * DAY, NOW).text, 'en retard de 3 j');
  assert.equal(dueInfo(at(2026, 10, 23, 17), NOW).text, 'aujourd\'hui 17:00');
  assert.equal(dueInfo(at(2026, 10, 24, 9), NOW).text, 'demain 09:00');
  const d2 = dueInfo(at(2026, 10, 25, 12), NOW);
  assert.equal(d2.text, 'dans 2 j');
  assert.equal(d2.tone, 'warm');
  assert.equal(dueInfo(at(2026, 11, 3, 12), NOW).tone, 'calm');
});

test('tri, filtres et regroupements', () => {
  const tasks = [
    { id: 'a', title: 'A', priority: 3, load: 2, done: false, createdMs: 1, tags: ['admin'] },
    { id: 'b', title: 'B', priority: 1, load: 5, done: false, createdMs: 2, tags: ['deep'], deadlineMs: at(2026, 10, 24, 17) },
    { id: 'c', title: 'C', priority: 1, load: 4, done: false, createdMs: 3, tags: [], deadlineMs: at(2026, 10, 22, 17) },
    { id: 'd', title: 'D', priority: 2, load: 1, done: true, createdMs: 4, tags: ['admin'] },
    { id: 'e', title: 'E', priority: 1, load: 3, done: false, createdMs: 5, tags: ['deep'], deadlineMs: at(2026, 10, 30, 17) },
  ];
  assert.deepEqual(sortTasks(tasks).map((t) => t.id), ['c', 'b', 'e', 'a', 'd']);
  assert.deepEqual(filterTasks(tasks, 'todo', NOW).map((t) => t.id), ['a', 'b', 'c', 'e']);
  assert.deepEqual(filterTasks(tasks, 'done', NOW).map((t) => t.id), ['d']);
  assert.deepEqual(filterTasks(tasks, 'late', NOW).map((t) => t.id), ['c']);
  assert.deepEqual(filterTasks(tasks, 'deep', NOW).map((t) => t.id), ['b', 'c']);
  assert.deepEqual(countFilters(tasks, NOW), { all: 5, todo: 4, late: 1, deep: 2, done: 1 });
  const g = groupTasks(sortTasks(tasks), 'day', NOW);
  assert.deepEqual(g.map((x) => x.key), ['late', 'tomorrow', 'week', 'none', 'done']);
  assert.equal(g[0].label, 'En retard');
  const gt = groupTasks(sortTasks(tasks), 'tag', NOW);
  assert.deepEqual(gt.map((x) => x.label), ['#admin', '#deep', 'Sans tag']);
  assert.equal(groupTasks(tasks, 'none', NOW).length, 1);
});

test('jetons de saisie et résumé', () => {
  const text = 'Finir le rapport 2h avant vendredi 17h';
  const segs = tokenSegments(text, [{ start: 17, end: 19, type: 'duration', text: '2h' }, { start: 20, end: 38, type: 'date', text: 'avant vendredi 17h' }]);
  assert.equal(segs.map((s) => s.text).join(''), text);
  assert.deepEqual(segs.map((s) => s.type), [null, 'duration', null, 'date']);
  // jetons qui se recoupent : le second est ignoré, le texte reste intact
  const s2 = tokenSegments('abcdef', [{ start: 0, end: 4, type: 'date' }, { start: 2, end: 5, type: 'tag' }]);
  assert.equal(s2.map((s) => s.text).join(''), 'abcdef');
  assert.equal(s2[0].type, 'date');
  assert.equal(tokenSegments('', []).length, 0);

  const d = describeParsed({ kind: 'task', title: 'Finir le rapport', durMin: 120, load: 4, priority: 1, deadlineMs: at(2026, 10, 27, 17), tags: ['deep'] }, NOW);
  assert.equal(d.label, 'Tâche');
  assert.equal(d.ok, true);
  assert.deepEqual(d.parts.map((p) => p.text), ['2 h', 'charge 4', 'urgent', 'avant ven. 27 nov. 17:00', '#deep']);
  const e = describeParsed({ kind: 'event', title: 'Déjeuner', startMs: at(2026, 10, 26, 12, 30), endMs: at(2026, 10, 26, 13, 30), tags: [] }, NOW);
  assert.equal(e.label, 'Événement');
  assert.equal(e.parts[0].text, 'jeu. 26 nov. 12:30–13:30'.replace('jeu.', 'jeu.'));
  assert.equal(describeParsed({ kind: 'task', title: '  ' }, NOW).ok, false);
});

test('entryToItem : tâche et événement', () => {
  assert.equal(entryToItem({ kind: 'task', title: '' }), null);
  const t = entryToItem({ kind: 'task', title: ' Écrire ', durMin: 45, load: 4, tags: ['x'], deadlineMs: 5 });
  assert.deepEqual(t, { kind: 'task', data: { title: 'Écrire', durMin: 45, load: 4, priority: 3, tags: ['x'], deadlineMs: 5 } });
  const e = entryToItem({ kind: 'event', title: 'RDV', startMs: 1000, tags: [] });
  assert.equal(e.kind, 'event');
  assert.equal(e.data.endMs, 1000 + HOUR, 'durée par défaut : 1 h');
  assert.equal(e.data.source, 'manual');
  assert.equal(entryToItem({ kind: 'event', title: 'RDV', tags: [] }).kind, 'task', 'événement sans date : tâche');
});

test('gestes : glisser, appui long, défilement, balayage, clavier', () => {
  assert.equal(gestureStep({ pointerType: 'mouse', dx: 2, dy: 1 }), 'pending');
  assert.equal(gestureStep({ pointerType: 'mouse', dx: 0, dy: 6 }), 'drag');
  assert.equal(gestureStep({ pointerType: 'touch', onGrip: true, dx: 0, dy: 4 }), 'drag');
  assert.equal(gestureStep({ pointerType: 'touch', onGrip: false, dx: 0, dy: 14 }), 'cancel');
  assert.equal(gestureStep({ pointerType: 'touch', onGrip: false, dx: 1, dy: 1, elapsedMs: 300 }), 'pending');
  assert.equal(gestureStep({ pointerType: 'touch', onGrip: false, dx: 1, dy: 1, elapsedMs: 520 }), 'longpress');
  assert.equal(swipeIntent({ dx: -90, dy: 10, dt: 300 }), 'next');
  assert.equal(swipeIntent({ dx: 90, dy: 10, dt: 300 }), 'prev');
  assert.equal(swipeIntent({ dx: 90, dy: 80, dt: 300 }), null, 'trop vertical');
  assert.equal(swipeIntent({ dx: 40, dy: 0, dt: 400 }), null, 'trop court et lent');
  assert.equal(swipeIntent({ dx: -40, dy: 0, dt: 40 }), 'next', 'court mais vif');
  assert.deepEqual(keyMove('ArrowUp'), { dMin: -15, dDay: 0 });
  assert.deepEqual(keyMove('ArrowDown', true), { dMin: 60, dDay: 0 });
  assert.deepEqual(keyMove('ArrowRight'), { dMin: 0, dDay: 1 });
  assert.equal(keyMove('Enter'), null);
});

test('verdict de déplacement et application', () => {
  assert.equal(moveVerdict({ ok: true, deltaScore: 12, reason: 'Pic' }).tone, 'good');
  assert.equal(moveVerdict({ ok: true, deltaScore: 12 }).headline, '+12 pts');
  assert.equal(moveVerdict({ ok: true, deltaScore: -7 }).tone, 'bad');
  assert.equal(moveVerdict({ ok: true, deltaScore: -7 }).headline, '−7 pts');
  assert.equal(moveVerdict({ ok: true, deltaScore: 0 }).tone, 'same');
  const r = moveVerdict({ ok: false, why: 'Chevauche un autre bloc du plan' });
  assert.equal(r.tone, 'refused');
  assert.equal(r.detail, 'Chevauche un autre bloc du plan');
  assert.equal(moveVerdict(null).tone, 'refused');
  assert.equal(fixMonths('avant lun. 23 nove. 19:00 et mar. 1 déce.'), 'avant lun. 23 nov. 19:00 et mar. 1 déc.');
  assert.equal(moveVerdict({ ok: false, why: 'Dépasse (mer. 25 nove. 18:00)' }).detail, 'Dépasse (mer. 25 nov. 18:00)');

  const a = { taskId: 'a', startMs: 100, endMs: 200, score: 50, reason: 'x' };
  const b = { taskId: 'b', startMs: 300, endMs: 400, score: 60, reason: 'y' };
  const out = applyMove([a, b], a, { startMs: 500, endMs: 600, score: 90, reason: 'mieux' });
  assert.deepEqual(out.map((x) => x.taskId), ['b', 'a'], 'trié par début');
  assert.equal(out[1].locked, true);
  assert.equal(out[1].score, 90);
  assert.equal(out[1].reason, 'mieux');
  assert.equal(a.locked, undefined, 'immuable');
  assert.deepEqual(withoutBlock([a, b], a), [b]);
});

test('import / export : fenêtre ICS, texte, pluriel', () => {
  const r = icsRange(NOW);
  assert.equal(r.fromMs, at(2026, 10, 22));
  assert.equal(r.toMs, at(2027, 0, 22)); // +60 jours
  const tasks = [{ id: 'a', title: 'Rapport', load: 4 }];
  const txt = planToText({ blocks: [{ taskId: 'a', startMs: at(2026, 10, 24, 9), endMs: at(2026, 10, 24, 10, 30), locked: true }, { taskId: 'gone', startMs: at(2026, 10, 24, 11), endMs: at(2026, 10, 24, 12) }], tasks, nowMs: NOW });
  assert.match(txt, /^Plan Kairos/);
  assert.match(txt, /Mardi 24 novembre/);
  assert.match(txt, /09:00–10:30 {2}Rapport \(charge 4\) \(verrouillé\)/);
  assert.match(txt, /Tâche supprimée/);
  assert.equal(planToText({ blocks: [], tasks, nowMs: NOW }), 'Aucun bloc planifié.');
  assert.equal(plural(1, 'événement'), '1 événement');
  assert.equal(plural(3, 'événement'), '3 événements');
  assert.equal(plural(2, 'cheval', 'chevaux'), '2 chevaux');
});
