// Tests des fonctions pures de l'interface : maths de graphiques (échelles, graduations, splines monotones,
// extrema, couloirs, description accessible) et recherche floue de la palette. Pas de DOM en Node :
// seuls les exports purs sont couverts ; le dessin est vérifié visuellement (dev/gallery.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  linearScale, niceNum, niceTicks, seriesAt, monotoneTangents, monotoneSegments, decimate, timeTicks, assignLanes,
  chartLayout, lanesHeight, findExtrema, probeAt, describeAlertness, calibrationStats, parseColor, rgba, mixColors, pickInk, rampColor,
} from '../site/js/ui/charts.js';
import { fuzzyScore, fold, describeEntry } from '../site/js/ui/palette.js';
import { clsx } from '../site/js/ui/dom.js';
import { HOUR, MIN } from '../site/js/core/time.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// Modèle synthétique : pic à 10:20 (≈86), creux à 14:40 (≈41), sommeil avant 07:00 et après 23:00.
function fakeModel() {
  const t0 = new Date(2026, 10, 23, 0).getTime(), n = 289, alert = [], asleep = [];
  const g = (x, m, s) => Math.exp(-0.5 * ((x - m) / s) ** 2);
  for (let i = 0; i < n; i++) {
    const hr = i / 12, sl = hr < 7 || hr >= 23;
    asleep.push(sl);
    alert.push(sl ? 8 : 40 + 46 * g(hr, 10 + 1 / 3, 1.4) + 30 * g(hr, 18, 1.6) - 0 * g(hr, 14.67, 1));
  }
  // creux net à 14:40
  const k = Math.round(14.667 * 12); alert[k] = 41; alert[k - 1] = 42; alert[k + 1] = 42;
  alert[Math.round((10 + 1 / 3) * 12)] = 86;
  return { t0, stepMin: 5, n, alert, alertBase: alert, caffeineMg: new Array(n).fill(0), asleep, zones: [{ kind: 'golden', startMs: t0 + 9.5 * HOUR, endMs: t0 + 11.5 * HOUR, label: 'Fenêtre d\'or' }] };
}

test('linearScale : projection et inverse', () => {
  const s = linearScale(0, 100, 200, 0);
  close(s(0), 200); close(s(100), 0); close(s(25), 150); close(s.invert(150), 25);
});

test('niceNum / niceTicks : graduations rondes qui couvrent les données', () => {
  assert.equal(niceNum(97, true), 100);
  const t = niceTicks(0, 97, 5);
  assert.ok(t.min <= 0 && t.max >= 97);
  assert.ok(t.ticks.length >= 4 && t.ticks.length <= 8);
  const step = t.ticks[1] - t.ticks[0];
  for (let i = 1; i < t.ticks.length; i++) close(t.ticks[i] - t.ticks[i - 1], step, 1e-6);
  assert.ok([1, 2, 5].includes(step / Math.pow(10, Math.floor(Math.log10(step)))));
  assert.doesNotThrow(() => niceTicks(5, 5));
});

test('seriesAt : interpolation linéaire bornée', () => {
  const s = [0, 10, 20], t0 = 1000;
  close(seriesAt(s, t0, 5, t0 + 2.5 * MIN), 5);
  close(seriesAt(s, t0, 5, t0 - 99999), 0);
  close(seriesAt(s, t0, 5, t0 + 99 * MIN), 20);
  assert.ok(Number.isNaN(seriesAt([], t0, 5, t0)));
});

test('spline monotone : pas de dépassement, plateaux préservés', () => {
  const xs = [0, 1, 2, 3, 4], ys = [0, 1, 1, 5, 6];
  const segs = monotoneSegments(xs, ys);
  assert.equal(segs.length, 4);
  segs.forEach((s, i) => {
    const lo = Math.min(ys[i], ys[i + 1]) - 1e-9, hi = Math.max(ys[i], ys[i + 1]) + 1e-9;
    assert.ok(s[1] >= lo && s[1] <= hi && s[3] >= lo && s[3] <= hi, `segment ${i} dépasse`);
    assert.equal(s[4], xs[i + 1]); assert.equal(s[5], ys[i + 1]);
  });
  const t = monotoneTangents(xs, ys);
  assert.equal(t[1], 0); assert.equal(t[2], 0); // extrema locaux / plateau
  assert.deepEqual(monotoneTangents([0], [1]), [0]);
});

test('decimate : conserve le dernier point et respecte la taille', () => {
  const xs = Array.from({ length: 289 }, (_, i) => i), ys = xs.map((x) => x * 2);
  const d = decimate(xs, ys, 100);
  assert.ok(d.xs.length <= 102);
  assert.equal(d.xs[d.xs.length - 1], 288);
  assert.equal(decimate([1, 2], [1, 2], 10).xs.length, 2);
});

test('timeTicks : graduations d\'heures locales alignées, minuit en major', () => {
  const a = new Date(2026, 10, 23, 0).getTime(), b = a + 24 * HOUR;
  const t = timeTicks(a, b, 330);
  assert.ok(t.length >= 5 && t.length <= 9);
  for (const k of t) assert.equal(new Date(k.ms).getHours() % (24 / 6 === 4 ? 4 : 1), 0);
  assert.equal(t[0].major, true);
  assert.ok(/^lun\./.test(t[0].label));
  for (let i = 1; i < t.length; i++) assert.ok(t[i].ms > t[i - 1].ms);
  // plusieurs jours : graduations par jour
  const w = timeTicks(a, a + 7 * 24 * HOUR, 600);
  assert.ok(w.length >= 3);
  assert.ok(w.every((k) => new Date(k.ms).getHours() === 0));
});

test('assignLanes : chevauchements sur des couloirs distincts', () => {
  const r = assignLanes([{ startMs: 0, endMs: 10 }, { startMs: 5, endMs: 15 }, { startMs: 10, endMs: 20 }, { startMs: 12, endMs: 14 }]);
  assert.equal(r.lanes[0], 0); assert.equal(r.lanes[1], 1); assert.equal(r.lanes[2], 0); assert.equal(r.lanes[3], 2);
  assert.equal(r.count, 3);
  assert.equal(assignLanes([{ startMs: 0, endMs: 5 }, { startMs: 5, endMs: 9 }]).count, 1);
  assert.equal(assignLanes([], 3).count, 0);
});

test('chartLayout / lanesHeight : géométrie cohérente', () => {
  assert.equal(lanesHeight(0, 0), 0);
  assert.ok(lanesHeight(1, 1) > lanesHeight(0, 1));
  const L = chartLayout(390, 300, { showCaffeine: true, eventLanes: 1, blockLanes: 1 });
  assert.ok(L.x1 > L.x0 && L.y1 > L.y0 && L.lanesTop >= L.y1 && L.blocksTop > L.eventsTop && L.axisTop > L.blocksTop);
  const noCaf = chartLayout(390, 300, { showCaffeine: false });
  assert.ok(noCaf.x1 > L.x1);
});

test('findExtrema : ignore l\'inertie du réveil et ne sort pas du sommeil', () => {
  const m = fakeModel(), { peak, trough } = findExtrema(m);
  assert.equal(new Date(peak.ms).getHours(), 10); assert.equal(new Date(peak.ms).getMinutes(), 20); assert.equal(Math.round(peak.value), 86);
  assert.equal(Math.round(trough.value), 41);
  assert.equal(new Date(trough.ms).getHours(), 14); assert.equal(new Date(trough.ms).getMinutes(), 40);
  const r = findExtrema(m, [m.t0 + 12 * HOUR, m.t0 + 20 * HOUR]);
  assert.ok(r.peak.ms >= m.t0 + 12 * HOUR && r.peak.ms <= m.t0 + 20 * HOUR);
});

test('describeAlertness : description textuelle accessible', () => {
  const m = fakeModel(), t0 = m.t0;
  const d = describeAlertness(m, { blocks: [{ taskId: 'a', startMs: t0 + 9 * HOUR, endMs: t0 + 10 * HOUR }], tasks: [{ id: 'a', title: 'Rédiger' }] });
  assert.match(d, /Pic à 10:20 \(86\/100\)/);
  assert.match(d, /creux à 14:40 \(41\/100\)/);
  assert.match(d, /Fenêtres d'or : 09:30–11:30/);
  assert.match(d, /1 bloc de tâches planifié : Rédiger à 09:00/);
  assert.match(describeAlertness(null), /indisponible/);
});

test('probeAt : valeurs, bloc, tâche et événement au survol', () => {
  const m = fakeModel(), t0 = m.t0, ms = t0 + 10 * HOUR + 20 * MIN;
  const p = probeAt(ms, { model: m, blocks: [{ taskId: 'a', startMs: t0 + 10 * HOUR, endMs: t0 + 11 * HOUR }], events: [{ id: 'e', title: 'RDV', startMs: t0 + 10 * HOUR, endMs: t0 + 10.5 * HOUR }], tasks: [{ id: 'a', title: 'X', load: 4 }] });
  assert.equal(Math.round(p.alert), 86); assert.equal(p.asleep, false); assert.equal(p.task.load, 4); assert.equal(p.event.title, 'RDV');
  assert.equal(probeAt(t0 + 3 * HOUR, { model: m }).asleep, true);
  assert.ok(Number.isNaN(p.compare));
});

test('calibrationStats : droite parfaite, biais et RMSE', () => {
  const perfect = calibrationStats([10, 40, 70, 90].map((v) => ({ predicted: v, felt: v })));
  close(perfect.rmse, 0); close(perfect.bias, 0); close(perfect.r, 1, 1e-9); close(perfect.slope, 1, 1e-9);
  const off = calibrationStats([10, 40, 70].map((v) => ({ predicted: v, felt: v + 10 })));
  close(off.bias, 10); close(off.rmse, 10);
  assert.equal(calibrationStats([]).n, 0);
  assert.equal(calibrationStats([{ predicted: 1, felt: NaN }]).n, 0);
});

test('couleurs : parseColor, rgba, mixColors, pickInk, rampColor', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('#f7b93e'), [247, 185, 62, 1]);
  close(parseColor('#00000080')[3], 128 / 255, 1e-6);
  assert.deepEqual(parseColor('rgba(255, 255, 255, .075)'), [255, 255, 255, 0.075]);
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)').slice(0, 3), [10, 20, 30]);
  assert.equal(rgba([10, 20, 30, 1], 0.5), 'rgba(10,20,30,0.5)');
  assert.deepEqual(mixColors([0, 0, 0, 1], [100, 200, 50, 1], 0.5), [50, 100, 25, 1]);
  assert.deepEqual(pickInk([255, 255, 255, 1]), [10, 13, 19, 1]);
  assert.deepEqual(pickInk([0, 0, 0, 1]), [255, 255, 255, 1]);
  assert.deepEqual(rampColor([[0, 0, 0, 1], [100, 100, 100, 1]], 0.5), [50, 50, 50, 1]);
  assert.deepEqual(rampColor([[0, 0, 0, 1], [100, 100, 100, 1]], 9), [100, 100, 100, 1]);
});

test('palette : recherche floue insensible aux accents et à la casse', () => {
  assert.equal(fold('Café ÉTÉ'), 'cafe ete');
  assert.ok(fuzzyScore('cafe', 'Nouveau café'));
  assert.ok(fuzzyScore('nouv caf', 'Nouveau café · 80 mg'));
  assert.equal(fuzzyScore('xyz', 'Nouveau café'), null);
  assert.equal(fuzzyScore('', 'tout').score, 0);
  const prefix = fuzzyScore('plan', 'Planifier ma semaine'), loose = fuzzyScore('plan', 'Page lancée annoncée');
  assert.ok(prefix && loose && prefix.score > loose.score);
  assert.deepEqual(fuzzyScore('plan', 'Plan').idx, [0, 1, 2, 3]);
});

test('describeEntry : résumé lisible d\'une saisie analysée', () => {
  const now = new Date(2026, 10, 23, 9).getTime();
  const s = describeEntry({ kind: 'task', durMin: 120, load: 4, priority: 1, deadlineMs: new Date(2026, 10, 27, 17).getTime(), tags: ['deep'] }, now);
  assert.deepEqual(s.map((x) => x.type), ['duration', 'load', 'priority', 'date', 'tag']);
  assert.equal(s[0].text, '2 h'); assert.equal(s[1].text, 'charge 4'); assert.equal(s[2].text, 'Urgent'); assert.match(s[3].text, /ven\. 27 nov\. 17:00/); assert.equal(s[4].text, '#deep');
  const e = describeEntry({ kind: 'event', startMs: new Date(2026, 10, 24, 12, 30).getTime(), endMs: new Date(2026, 10, 24, 13, 30).getTime(), tags: [] }, now);
  assert.match(e[0].text, /demain 12:30–13:30/);
  assert.deepEqual(describeEntry(null), []);
});

test('clsx : chaînes, tableaux et objets', () => {
  assert.equal(clsx('a', null, ['b', false, 'c'], { d: true, e: false }), 'a b c d');
});
