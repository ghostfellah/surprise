// Tests du modèle assemblé : contrat, plausibilité de la journée, caféine, scénarios, performance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, valueAt, meanAlert, slotIndex } from '../site/js/core/model.js';
import { caffeineAt } from '../site/js/core/caffeine.js';
import { HOUR, MIN, DAY } from '../site/js/core/time.js';

const profile = {
  usualWake: '07:00', usualBed: '23:00', sleepNeedH: 8, caffeineSensitivity: 1, caffeineHalfLifeH: 5,
  chronoShiftMin: 0, workDays: [1, 2, 3, 4, 5],
};
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
const day = (opts = {}) => buildModel({ profile, sleeps: [], caffeine: [], fromMs: at(24, 0), hours: 24, ...opts });
const KINDS = ['peak', 'dip', 'sleep', 'winddown', 'caffeine-cutoff', 'melatonin', 'golden'];

test('contrat : forme du modèle', () => {
  const m = day();
  assert.equal(m.t0, at(24, 0));
  assert.equal(m.stepMin, 5);
  assert.equal(m.n, 24 * 12 + 1);
  for (const k of ['alert', 'alertBase', 'caffeineMg', 'S', 'C', 'asleep']) {
    assert.ok(Array.isArray(m[k]), k);
    assert.equal(m[k].length, m.n, k);
  }
  assert.equal(typeof m.asleep[0], 'boolean');
  assert.ok(m.stats.peak.ms >= m.t0 && Number.isFinite(m.stats.peak.value));
  assert.ok(m.stats.trough.value <= m.stats.peak.value);
  assert.ok(Number.isFinite(m.stats.dlmoMs) && Number.isFinite(m.stats.sleepDebtH) && Number.isFinite(m.stats.caffeineAtBedMg));
  assert.ok(Array.isArray(m.stats.goldenWindows));
  for (const z of m.zones) {
    assert.ok(KINDS.includes(z.kind), z.kind);
    assert.ok(z.endMs > z.startMs && typeof z.label === 'string');
  }
  const odd = buildModel({ profile, sleeps: [], caffeine: [], fromMs: at(24, 6), hours: 10, stepMin: 15 });
  assert.equal(odd.n, Math.round((10 * 60) / 15) + 1);
});

test('bornes : alerte et alerteBase dans [0,100], S dans [0,1], C dans [-1,1], sommeil ≤ 15', () => {
  const m = buildModel({
    profile, sleeps: [], fromMs: at(24, 0), hours: 72,
    caffeine: [{ tMs: at(24, 8), mg: 400 }, { tMs: at(24, 9), mg: 400 }, { tMs: at(25, 7), mg: 300 }],
  });
  for (let i = 0; i < m.n; i++) {
    for (const k of ['alert', 'alertBase']) assert.ok(m[k][i] >= 0 && m[k][i] <= 100 && Number.isFinite(m[k][i]));
    assert.ok(m.S[i] >= 0 && m.S[i] <= 1 && m.C[i] >= -1 && m.C[i] <= 1);
    assert.ok(m.alert[i] >= m.alertBase[i] - 1e-9, 'la caféine ne baisse jamais l\'alerte');
    if (m.asleep[i]) assert.ok(m.alert[i] <= 15 && m.alertBase[i] <= 15);
  }
});

test('déterminisme', () => {
  const caf = [{ tMs: at(24, 8), mg: 90 }];
  assert.deepEqual(day({ caffeine: caf }), day({ caffeine: caf }));
});

test('forme d\'une journée : réveil modeste, pic de fin de matinée, creux 13-16 h, 2e pic le soir, chute au coucher', () => {
  const m = day();
  const A = (h, mi = 0) => valueAt(m.alert, m, at(24, h, mi));
  assert.ok(A(7, 20) < 55, `réveil ${A(7, 20)}`);
  assert.ok(A(7, 20) < A(10) - 15);
  const morning = Math.max(...[9, 10, 11, 12].map((h) => A(h)));
  const dip = Math.min(...[13, 14, 15, 16].map((h) => A(h)));
  const evening = Math.max(...[17, 18, 19, 20, 21].map((h) => A(h)));
  assert.ok(morning >= 70, `pic du matin ${morning}`);
  assert.ok(morning - dip >= 8, `creux ${dip} vs pic ${morning}`);
  assert.ok(evening - dip >= 5, `second pic ${evening} vs creux ${dip}`);
  assert.ok(A(22, 45) < evening - 20 || m.asleep[slotIndex(m, at(24, 22, 55))]);
  assert.ok(m.stats.peak.ms >= at(24, 9) && m.stats.peak.ms <= at(24, 21));
  const tr = new Date(m.stats.trough.ms).getHours();
  assert.ok(tr >= 13 && tr <= 16, `creux à ${tr} h`);
  // zones : un pic, un creux, du sommeil
  assert.ok(m.zones.some((z) => z.kind === 'peak') && m.zones.some((z) => z.kind === 'dip') && m.zones.some((z) => z.kind === 'sleep'));
});

test('sommeil : les nuits supposées suivent le profil', () => {
  const m = day();
  assert.equal(m.asleep[slotIndex(m, at(24, 3))], true);
  assert.equal(m.asleep[slotIndex(m, at(24, 12))], false);
  assert.equal(m.asleep[slotIndex(m, at(24, 23, 30))], true);
  assert.equal(m.asleep[slotIndex(m, at(24, 6, 55))], true);
  assert.equal(m.asleep[slotIndex(m, at(24, 7, 5))], false);
});

test('une nuit courte abaisse visiblement tout le lendemain', () => {
  const normal = day();
  const short = day({ sleeps: [{ bedMs: at(24, 3), wakeMs: at(24, 7) }], nowMs: at(24, 7) });
  const a = meanAlert(normal, at(24, 9), at(24, 21));
  const b = meanAlert(short, at(24, 9), at(24, 21));
  assert.ok(a - b >= 6, `${a} vs ${b}`);
  assert.ok(short.stats.sleepDebtH > normal.stats.sleepDebtH + 2);
  // chaque tranche de 3 h de la journée est plus basse
  for (let h = 9; h < 21; h += 3) assert.ok(meanAlert(short, at(24, h), at(24, h + 3)) < meanAlert(normal, at(24, h), at(24, h + 3)));
});

test('whatIf.sleeps équivaut à un journal', () => {
  const log = { bedMs: at(24, 3), wakeMs: at(24, 7) };
  const a = day({ sleeps: [log] });
  const b = day({ whatIf: { sleeps: [log] } });
  assert.deepEqual(a.alert, b.alert);
});

test('une caféine à 8 h relève visiblement la matinée, pas la base', () => {
  const base = day();
  const cof = day({ caffeine: [{ tMs: at(24, 8), mg: 100 }] });
  const lift = meanAlert(cof, at(24, 9), at(24, 12)) - meanAlert(base, at(24, 9), at(24, 12));
  assert.ok(lift >= 4 && lift <= 20, `gain ${lift}`);
  assert.deepEqual(cof.alertBase, base.alertBase);
  assert.ok(cof.caffeineMg[slotIndex(cof, at(24, 8, 45))] > 80);
  assert.equal(cof.caffeineMg[slotIndex(cof, at(24, 7, 55))], 0);
  // la caféine s'efface : fin de soirée proche de la base
  assert.ok(meanAlert(cof, at(24, 21), at(24, 22)) - meanAlert(base, at(24, 21), at(24, 22)) < 3);
});

test('whatIf.caffeine équivaut à un journal de caféine', () => {
  const l = [{ tMs: at(24, 8), mg: 100 }];
  assert.deepEqual(day({ caffeine: l }).alert, day({ whatIf: { caffeine: l } }).alert);
});

test('un café à 20 h se voit au coucher et dans la zone de coupure', () => {
  const ok = day({ caffeine: [{ tMs: at(24, 8), mg: 100 }] });
  const late = day({ caffeine: [{ tMs: at(24, 20), mg: 100 }] });
  assert.ok(ok.stats.caffeineAtBedMg < 1);
  assert.ok(late.stats.caffeineAtBedMg > 25, `${late.stats.caffeineAtBedMg}`);
  assert.ok(Math.abs(late.stats.caffeineAtBedMg - caffeineAt([{ tMs: at(24, 20), mg: 100 }], profile, at(24, 23))) < 1e-9);
  const zone = late.zones.find((z) => z.kind === 'caffeine-cutoff');
  assert.ok(zone, 'zone de coupure');
  assert.equal(zone.endMs, at(24, 23));
  assert.ok(zone.startMs < at(24, 20) && zone.startMs > at(24, 11));
  assert.ok(ok.zones.some((z) => z.kind === 'caffeine-cutoff'), 'la coupure est affichée même sans café tardif');
  assert.ok(late.stats.cutoffMs <= at(24, 20));
});

test('whatIf.extraNaps : une sieste réduit S et relève l\'après-midi tardif', () => {
  const base = day();
  const nap = day({ whatIf: { extraNaps: [{ startMs: at(24, 13), endMs: at(24, 13, 20) }] } });
  assert.ok(nap.asleep[slotIndex(nap, at(24, 13, 10))]);
  assert.ok(nap.S[slotIndex(nap, at(24, 16))] < base.S[slotIndex(base, at(24, 16))]);
  assert.ok(meanAlert(nap, at(24, 15), at(24, 19)) > meanAlert(base, at(24, 15), at(24, 19)));
  assert.ok(nap.zones.some((z) => z.kind === 'sleep' && /Sieste/.test(z.label)));
});

test('prime time : ≥ 60 min, éveillé, au-dessus du 75e centile', () => {
  const m = day();
  assert.ok(m.stats.goldenWindows.length >= 1);
  const awake = m.alert.filter((_, i) => !m.asleep[i] && m.AW[i] > 0.999).sort((a, b) => a - b);
  const p75 = awake[Math.floor(0.75 * awake.length)];
  for (const g of m.stats.goldenWindows) {
    assert.ok(g.endMs - g.startMs >= 60 * MIN);
    assert.ok(g.mean >= p75 - 1e-9);
    assert.ok(!m.asleep[slotIndex(m, (g.startMs + g.endMs) / 2)]);
  }
  assert.equal(m.zones.filter((z) => z.kind === 'golden').length, m.stats.goldenWindows.length);
});

test('DLMO ≈ 2 h avant le coucher habituel ; zone de mélatonine et de « wind-down » avant le coucher', () => {
  const m = day();
  const dlmoH = (m.stats.dlmoMs - at(24, 0)) / HOUR;
  assert.ok(dlmoH >= 20 && dlmoH <= 21.5, `DLMO ${dlmoH} h`);
  const w = m.zones.find((z) => z.kind === 'winddown');
  assert.ok(w && w.endMs === at(24, 23) && w.endMs - w.startMs === 90 * MIN);
  assert.ok(m.zones.some((z) => z.kind === 'melatonin'));
});

test('valueAt : interpolation linéaire bornée, y compris booléens', () => {
  const m = day();
  const t = m.t0 + 10 * 5 * MIN;
  assert.equal(valueAt(m.alert, m, t), m.alert[10]);
  const mid = valueAt(m.alert, m, t + 2.5 * MIN);
  assert.ok(Math.abs(mid - (m.alert[10] + m.alert[11]) / 2) < 1e-9);
  assert.equal(valueAt(m.alert, m, m.t0 - 5 * DAY), m.alert[0]);
  assert.equal(valueAt(m.alert, m, m.t0 + 5 * DAY), m.alert[m.n - 1]);
  assert.equal(valueAt(m.asleep, m, at(24, 3)), 1);
});

test('slotIndex : plus proche, borné', () => {
  const m = day();
  assert.equal(slotIndex(m, m.t0), 0);
  assert.equal(slotIndex(m, m.t0 + 7 * 60000), 1);
  assert.equal(slotIndex(m, m.t0 + 8 * 60000), 2);
  assert.equal(slotIndex(m, m.t0 - DAY), 0);
  assert.equal(slotIndex(m, m.t0 + 10 * DAY), m.n - 1);
});

test('meanAlert : moyenne exacte de la courbe interpolée, séries au choix, bornes', () => {
  const m = day();
  const a = at(24, 9, 7); const b = at(24, 12, 33);
  let s = 0; const N = 4000;
  for (let i = 0; i < N; i++) s += valueAt(m.alert, m, a + ((i + 0.5) / N) * (b - a));
  assert.ok(Math.abs(meanAlert(m, a, b) - s / N) < 1e-3);
  assert.equal(meanAlert(m, a, a), valueAt(m.alert, m, a));
  assert.ok(Math.abs(meanAlert(m, a, b) - meanAlert(m, b, a)) < 1e-12);
  const c = day({ caffeine: [{ tMs: at(24, 8), mg: 100 }] });
  assert.ok(meanAlert(c, at(24, 9), at(24, 11), { series: 'caffeineMg' }) > 50);
  assert.ok(meanAlert(c, at(24, 9), at(24, 11)) > meanAlert(c, at(24, 9), at(24, 11), { series: 'alertBase' }));
  assert.ok(meanAlert(m, m.t0 - DAY, m.t0 - DAY + HOUR) === m.alert[0]);
  assert.throws(() => meanAlert(m, a, b, { series: 'zzz' }), /Série inconnue/);
});

test('modèle de 7 jours : continu, périodique en gros, pas de saut anormal', () => {
  const m = buildModel({ profile, sleeps: [], caffeine: [], fromMs: at(23, 0), hours: 168 });
  assert.equal(m.n, 168 * 12 + 1);
  // d'un jour à l'autre, la forme se répète (nuits supposées identiques)
  const d3 = meanAlert(m, at(26, 9), at(26, 12));
  const d4 = meanAlert(m, at(27, 9), at(27, 12));
  assert.ok(Math.abs(d3 - d4) < 1);
  for (let i = 1; i < m.n; i++) {
    if (!m.asleep[i] && !m.asleep[i - 1] && m.AW[i] >= 0.999 && m.AW[i - 1] >= 0.999) assert.ok(Math.abs(m.alert[i] - m.alert[i - 1]) < 4, `saut en i=${i}`);
  }
});

test('un week-end tardif décale la phase : lundi plus difficile que samedi sans décalage', () => {
  const logs = [{ bedMs: at(20, 2), wakeMs: at(20, 10) }, { bedMs: at(21, 2), wakeMs: at(21, 10) }]; // sam 21 et dim 22 ? (jours 20, 21)
  const m = buildModel({ profile, sleeps: logs, caffeine: [], fromMs: at(22, 0), hours: 24, nowMs: at(22, 8) });
  const ref = buildModel({ profile, sleeps: [], caffeine: [], fromMs: at(22, 0), hours: 24, nowMs: at(22, 8) });
  // le matin est plus bas quand l'horloge a glissé vers le tard
  assert.ok(meanAlert(m, at(22, 8), at(22, 10)) < meanAlert(ref, at(22, 8), at(22, 10)));
});

test('performance : 7 jours à 5 min en moins de 30 ms', () => {
  const caf = [];
  for (let d = 18; d <= 24; d++) caf.push({ tMs: at(d, 8), mg: 90 }, { tMs: at(d, 14), mg: 80 });
  const sleeps = [];
  for (let d = 10; d <= 24; d++) sleeps.push({ bedMs: at(d - 1, 23, 30), wakeMs: at(d, 7) });
  const run = () => buildModel({ profile, sleeps, caffeine: caf, fromMs: at(24, 0), hours: 168 });
  for (let i = 0; i < 5; i++) run(); // échauffement JIT
  const times = [];
  for (let i = 0; i < 15; i++) { const t = performance.now(); run(); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  assert.ok(times[Math.floor(times.length / 2)] < 30, `médiane ${times[Math.floor(times.length / 2)]} ms`);
});

test('robustesse : profil minimal, pas de journaux, horizon court, pas de 1 min', () => {
  const m = buildModel({ profile: {}, fromMs: at(24, 12), hours: 1, stepMin: 1 });
  assert.equal(m.n, 61);
  assert.ok(m.alert.every(Number.isFinite));
  assert.ok(m.stats.goldenWindows.every((g) => g.endMs > g.startMs));
});
