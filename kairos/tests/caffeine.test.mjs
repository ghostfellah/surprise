// Tests de la caféine : pharmacocinétique, effet, coupure, suggestions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  caffeineRates, caffeineAmount, caffeineCurve, caffeineAt, alertnessBoost, caffeineCutoff, suggestCaffeine, CAFFEINE,
} from '../site/js/core/caffeine.js';
import { buildModel } from '../site/js/core/model.js';
import { HOUR, MIN } from '../site/js/core/time.js';

const profile = { usualWake: '07:00', usualBed: '23:00', sleepNeedH: 8, caffeineSensitivity: 1, caffeineHalfLifeH: 5 };
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

test('tmax ≈ 40 min quelle que soit la demi-vie', () => {
  for (const hl of [3, 5, 9]) {
    const r = caffeineRates(hl);
    let best = 0; let tBest = 0;
    for (let t = 0.01; t < 4; t += 0.005) { const a = caffeineAmount(100, t, r); if (a > best) { best = a; tBest = t; } }
    assert.ok(Math.abs(tBest * 60 - CAFFEINE.tmaxMin) < 1.5, `tmax=${tBest * 60} min pour t½=${hl}`);
  }
});

test('demi-vie exacte de la queue d\'élimination', () => {
  for (const hl of [3, 5, 9]) {
    const r = caffeineRates(hl);
    const a1 = caffeineAmount(200, 12 * hl / 5 + 6, r);
    const a2 = caffeineAmount(200, 12 * hl / 5 + 6 + hl, r);
    assert.ok(Math.abs(a2 / a1 - 0.5) < 1e-3, `t½=${hl} ratio=${a2 / a1}`);
  }
});

test('caffeineCurve : conforme à la forme analytique, additive, nulle avant la prise', () => {
  const t0 = at(24, 6);
  const logs = [{ tMs: at(24, 8), mg: 100 }, { tMs: at(24, 13), mg: 60 }];
  const n = 12 * 18 + 1;
  const c = caffeineCurve(logs, profile, t0, 5, n);
  assert.equal(c.length, n);
  assert.equal(c[0], 0);
  assert.equal(c[12 * 2], 0); // à l'instant exact de la prise
  const r = caffeineRates(5);
  for (const i of [30, 80, 150, 200]) {
    const t = t0 + i * 5 * MIN;
    const exp = logs.reduce((s, l) => s + caffeineAmount(l.mg, (t - l.tMs) / HOUR, r), 0);
    assert.ok(Math.abs(c[i] - exp) < 1e-9);
  }
  const a = caffeineCurve([logs[0]], profile, t0, 5, n);
  const b = caffeineCurve([logs[1]], profile, t0, 5, n);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(c[i] - a[i] - b[i]) < 1e-9);
});

test('prises antérieures à t0 prises en compte', () => {
  const c = caffeineCurve([{ tMs: at(23, 20), mg: 200 }], profile, at(24, 6), 5, 13);
  assert.ok(c[0] > 30 && c[0] < 100);
  assert.ok(Math.abs(c[0] - caffeineAt([{ tMs: at(23, 20), mg: 200 }], profile, at(24, 6))) < 1e-9);
});

test('demi-vie plus longue : il en reste plus au coucher', () => {
  const logs = [{ tMs: at(24, 16), mg: 100 }];
  const fast = caffeineAt(logs, { ...profile, caffeineHalfLifeH: 3 }, at(24, 23));
  const slow = caffeineAt(logs, { ...profile, caffeineHalfLifeH: 9 }, at(24, 23));
  assert.ok(slow > 2 * fast);
});

test('effet : nul à 0 mg, croissant, saturant, proportionnel à la sensibilité, plus fort si fatigué', () => {
  assert.equal(alertnessBoost(0, profile), 0);
  let prev = 0;
  for (const mg of [20, 50, 100, 200, 400, 800]) {
    const b = alertnessBoost(mg, profile);
    assert.ok(b > prev); prev = b;
  }
  const d1 = alertnessBoost(100, profile) - alertnessBoost(50, profile);
  const d2 = alertnessBoost(800, profile) - alertnessBoost(750, profile);
  assert.ok(d2 < d1 / 5, 'rendements décroissants');
  assert.ok(alertnessBoost(100, { ...profile, caffeineSensitivity: 2 }) > alertnessBoost(100, { ...profile, caffeineSensitivity: 0.5 }));
  assert.ok(alertnessBoost(100, profile, { S: 0.7 }) > alertnessBoost(100, profile, { S: 0.1 }));
  assert.ok(alertnessBoost(1e6, profile, { S: 1 }) < 40);
});

test('coupure : une tasse à l\'heure de coupure laisse ≈ 25 mg au coucher', () => {
  const bedMs = at(24, 23);
  const cut = caffeineCutoff({ logs: [], profile, bedMs });
  assert.ok(cut < bedMs - 6 * HOUR && cut > bedMs - 14 * HOUR, `coupure ${new Date(cut)}`);
  const left = caffeineAt([{ tMs: cut, mg: CAFFEINE.refDoseMg }], profile, bedMs);
  assert.ok(Math.abs(left - 25) < 0.05, `reste ${left}`);
});

test('coupure : plus tôt pour une longue demi-vie, plus tôt quand on a déjà bu, passée si déjà trop', () => {
  const bedMs = at(24, 23);
  const c3 = caffeineCutoff({ logs: [], profile: { ...profile, caffeineHalfLifeH: 3 }, bedMs });
  const c9 = caffeineCutoff({ logs: [], profile: { ...profile, caffeineHalfLifeH: 9 }, bedMs });
  assert.ok(c3 > c9);
  const base = caffeineCutoff({ logs: [], profile, bedMs });
  const withLog = caffeineCutoff({ logs: [{ tMs: at(24, 12), mg: 80 }], profile, bedMs });
  assert.ok(withLog < base);
  const over = caffeineCutoff({ logs: [{ tMs: at(24, 20), mg: 300 }], profile, bedMs });
  assert.ok(over <= at(24, 20));
  const lower = caffeineCutoff({ logs: [], profile, bedMs, thresholdMg: 10 });
  assert.ok(lower < base);
});

test('suggestCaffeine : créneaux éveillés, espacés, sans dépasser le seuil au coucher', () => {
  const s = suggestCaffeine({ profile, sleeps: [], caffeine: [], fromMs: at(24, 0), hours: 24, nowMs: at(24, 7, 30) });
  assert.ok(s.length >= 1 && s.length <= 3);
  const bed = at(24, 23);
  for (let i = 0; i < s.length; i++) {
    assert.ok(s[i].tMs >= at(24, 7, 30) && s[i].tMs < bed - 6 * HOUR, `prise à ${new Date(s[i].tMs)}`);
    assert.ok(s[i].atBedMg <= 25 + 1e-6);
    assert.ok(typeof s[i].why === 'string' && s[i].why.length > 20);
    if (i) assert.ok(s[i].tMs - s[i - 1].tMs >= 3 * HOUR);
  }
  const again = suggestCaffeine({ profile, sleeps: [], caffeine: [], fromMs: at(24, 0), hours: 24, nowMs: at(24, 7, 30) });
  assert.deepEqual(s, again);
});

test('suggestCaffeine : wantPeakAtMs place le pic d\'effet près de la cible', () => {
  const target = at(24, 15);
  const s = suggestCaffeine({ profile, sleeps: [], caffeine: [], fromMs: at(24, 0), hours: 24, nowMs: at(24, 8), wantPeakAtMs: target, maxDoses: 1 });
  assert.equal(s.length, 1);
  assert.ok(Math.abs(s[0].tMs + 45 * MIN - target) <= 90 * MIN, `prise ${new Date(s[0].tMs)}`);
});

test('suggestCaffeine : accepte un modèle déjà construit et ne propose rien tard le soir', () => {
  const model = buildModel({ profile, sleeps: [], caffeine: [], fromMs: at(24, 0), hours: 24 });
  const s = suggestCaffeine({ profile, model, nowMs: at(24, 19), fromMs: at(24, 0) });
  assert.deepEqual(s, []);
});
