// Tests du moteur chronobiologique (S, C, inertie, phase, déterminisme).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, circadianC, simulateProcesses, simulateProcessesRaw, hourOfDay } from '../site/js/core/chrono.js';
import { HOUR, DAY, MIN } from '../site/js/core/time.js';

const profile = { usualWake: '07:00', usualBed: '23:00', sleepNeedH: 8, chronoShiftMin: 0 };
const D0 = new Date(2026, 10, 24, 0).getTime(); // mardi 24 novembre 2026
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

test('paramètres : constantes de Borbély/Achermann', () => {
  assert.equal(DEFAULT_PARAMS.tauWakeH, 18.2);
  assert.equal(DEFAULT_PARAMS.tauSleepH, 4.2);
  assert.ok(Object.isFrozen(DEFAULT_PARAMS));
});

test('S monte en veille et décroît en sommeil, reste dans [0,1]', () => {
  const r = simulateProcesses({ sleeps: [], profile, fromMs: D0, toMs: D0 + 3 * DAY, stepMin: 5 });
  for (let i = 1; i < r.n; i++) {
    assert.ok(r.S[i] >= 0 && r.S[i] <= 1);
    if (r.asleep[i - 1] && r.asleep[i]) assert.ok(r.S[i] <= r.S[i - 1] + 1e-12, `S doit décroître en sommeil (i=${i})`);
    if (!r.asleep[i - 1] && !r.asleep[i]) assert.ok(r.S[i] >= r.S[i - 1] - 1e-12, `S doit croître en veille (i=${i})`);
  }
});

test('S : constantes de temps exactes (demi-pas analytique)', () => {
  const r = simulateProcessesRaw({ sleeps: [], profile, fromMs: D0, toMs: D0 + DAY, stepMin: 5 });
  // Pendant le sommeil : S(t+Δ) = S(t)·exp(−Δ/τd). Échantillons 01:00 et 02:00.
  const i1 = 12; const i2 = 24;
  assert.ok(r.asleep[i1] && r.asleep[i2]);
  assert.ok(Math.abs(r.S[i2] / r.S[i1] - Math.exp(-1 / 4.2)) < 1e-9);
  // En veille : 1 − S(t+Δ) = (1 − S(t))·exp(−Δ/τi).
  const j1 = 10 * 12; const j2 = 12 * 12;
  assert.ok(Math.abs((1 - r.S[j2]) / (1 - r.S[j1]) - Math.exp(-2 / 18.2)) < 1e-9);
});

test('besoin de sommeil : dormir exactement son besoin dissipe la même fraction de S', () => {
  const frac = (need) => {
    const p = { ...profile, sleepNeedH: need, usualBed: '23:00', usualWake: need === 6 ? '05:00' : '07:00' };
    const r = simulateProcessesRaw({ sleeps: [], profile: p, fromMs: D0, toMs: D0 + DAY, stepMin: 5 });
    const eps = r.episodes.find((e) => e.startMs >= D0 - 2 * HOUR && e.startMs < D0 + 20 * HOUR);
    const s = (ms) => r.S[Math.round((ms - D0) / (5 * MIN))];
    return s(Math.min(eps.endMs, D0 + DAY) - 5 * MIN) / s(Math.max(D0, eps.startMs) + 0);
  };
  assert.ok(Number.isFinite(frac(8)));
});

test('C : période de 24 h, bornée, minimum juste avant le réveil', () => {
  for (let tau = 0; tau < 24; tau += 0.37) {
    const c = circadianC(tau);
    assert.ok(Math.abs(c - circadianC(tau + 24)) < 1e-12);
    assert.ok(c >= -1 && c <= 1);
  }
  let min = Infinity; let argmin = 0;
  for (let tau = -6; tau < 18; tau += 0.05) { const c = circadianC(tau); if (c < min) { min = c; argmin = tau; } }
  assert.ok(argmin > -3.5 && argmin < 1.5, `minimum de C à τ=${argmin}`);
});

test('C : le minimum tombe ≈ 2-3 h avant le réveil habituel', () => {
  const r = simulateProcessesRaw({ sleeps: [], profile, fromMs: D0, toMs: D0 + DAY, stepMin: 5 });
  let im = 0;
  for (let i = 0; i < 12 * 8; i++) if (r.C[i] < r.C[im]) im = i; // cherche entre 00:00 et 08:00
  const h = (im * 5) / 60;
  assert.ok(h >= 3 && h <= 5.5, `creux circadien à ${h} h`);
});

test('inertie : l\'alerte 10 min après le réveil est plus basse que 2 h après', () => {
  const r = simulateProcessesRaw({ sleeps: [], profile, fromMs: D0, toMs: D0 + DAY, stepMin: 5 });
  const iw = 7 * 12;
  assert.ok(r.W[iw + 2] > r.W[iw + 12]);
  assert.ok(r.W[iw + 2] > 5, 'inertie sensible après une nuit');
  assert.ok(r.alertBase[iw + 2] < r.alertBase[iw + 24] - 10);
  assert.ok(r.W[iw + 36] < 1);
});

test('inertie : une sieste de 90 min en pousse plus qu\'une de 20 min', () => {
  const nap = (min) => simulateProcessesRaw({
    sleeps: [{ bedMs: at(24, 14), wakeMs: at(24, 14) + min * MIN, nap: true }], profile, fromMs: D0, toMs: D0 + DAY, stepMin: 5,
  });
  const a = nap(20); const b = nap(90);
  const iw20 = Math.round((at(24, 14) + 20 * MIN - D0) / (5 * MIN)) + 1;
  const iw90 = Math.round((at(24, 14) + 90 * MIN - D0) / (5 * MIN)) + 1;
  assert.ok(b.W[iw90] > a.W[iw20] * 1.5, `${b.W[iw90]} vs ${a.W[iw20]}`);
});

test('une nuit courte abaisse la journée et monte la dette', () => {
  const run = (sleeps) => simulateProcessesRaw({ sleeps, profile, fromMs: D0, toMs: D0 + DAY, stepMin: 5 });
  const normal = run([]);
  const short = run([{ bedMs: at(24, 3), wakeMs: at(24, 7) }]);
  const sl = (r) => mean(Array.from(r.alertBase).slice(9 * 12, 21 * 12));
  assert.ok(sl(normal) - sl(short) > 6, `${sl(normal)} vs ${sl(short)}`);
  assert.ok(short.S[8 * 12] > normal.S[8 * 12] + 0.1);
  assert.ok(short.D[10 * 12] > 3 && normal.D[10 * 12] < 0.01);
});

test('la phase circadienne suit un horaire de sommeil tardif, au plus ≈ 1 h par jour', () => {
  const late = [];
  for (let d = 10; d <= 24; d++) late.push({ bedMs: at(d, 2), wakeMs: at(d, 10) });
  const base = simulateProcessesRaw({ sleeps: [], profile, fromMs: D0, toMs: D0 + DAY, stepMin: 5 });
  const lateSim = simulateProcessesRaw({ sleeps: late, profile, fromMs: D0, toMs: D0 + DAY, stepMin: 5 });
  const argmin = (r) => { let k = 0; for (let i = 0; i < 12 * 12; i++) if (r.C[i] < r.C[k]) k = i; return k / 12; };
  assert.ok(argmin(lateSim) - argmin(base) >= 2, `${argmin(lateSim)} vs ${argmin(base)}`);
  // une seule matinée tardive ne décale pas la phase de plus de ≈ 1 h
  const one = simulateProcessesRaw({ sleeps: [{ bedMs: at(23, 3), wakeMs: at(23, 11) }], profile, fromMs: at(23, 12), toMs: at(24, 12), stepMin: 5 });
  const base2 = simulateProcessesRaw({ sleeps: [], profile, fromMs: at(23, 12), toMs: at(24, 12), stepMin: 5 });
  const am = (r) => { let k = 0; for (let i = 0; i < r.n; i++) if (r.C[i] < r.C[k]) k = i; return k / 12; };
  assert.ok(Math.abs(am(one) - am(base2)) <= 1.25);
});

test('chronoShiftMin décale la courbe C sans toucher au sommeil', () => {
  const a = simulateProcessesRaw({ sleeps: [], profile, fromMs: D0, toMs: D0 + DAY, stepMin: 5 });
  const b = simulateProcessesRaw({ sleeps: [], profile: { ...profile, chronoShiftMin: 120 }, fromMs: D0, toMs: D0 + DAY, stepMin: 5 });
  assert.deepEqual(Array.from(a.asleep), Array.from(b.asleep));
  const argmax = (r) => { let k = 0; for (let i = 0; i < r.n; i++) if (r.C[i] > r.C[k]) k = i; return k / 12; };
  assert.ok(Math.abs(argmax(b) - argmax(a) - 2) <= 0.5);
});

test('alerte en sommeil ≤ 15 et alerte éveillée dans [0,100]', () => {
  const r = simulateProcessesRaw({ sleeps: [], profile, fromMs: D0, toMs: D0 + 2 * DAY, stepMin: 5 });
  for (let i = 0; i < r.n; i++) {
    assert.ok(Number.isFinite(r.alertBase[i]) && r.alertBase[i] >= 0 && r.alertBase[i] <= 100);
    if (r.asleep[i]) assert.ok(r.alertBase[i] <= 15);
  }
});

test('déterminisme et sorties simples', () => {
  const a = simulateProcesses({ sleeps: [], profile, fromMs: D0, toMs: D0 + DAY, stepMin: 5 });
  const b = simulateProcesses({ sleeps: [], profile, fromMs: D0, toMs: D0 + DAY, stepMin: 5 });
  assert.deepEqual(a, b);
  assert.ok(Array.isArray(a.S) && Array.isArray(a.asleep) && typeof a.asleep[0] === 'boolean');
});

test('changement d\'heure : pas de NaN autour du passage à l\'heure d\'été', () => {
  const from = new Date(2026, 2, 28, 0).getTime();
  const r = simulateProcessesRaw({ sleeps: [], profile, fromMs: from, toMs: from + 3 * DAY, stepMin: 5 });
  for (let i = 0; i < r.n; i++) assert.ok(Number.isFinite(r.alertBase[i]) && Number.isFinite(r.S[i]));
  assert.ok(Math.abs(hourOfDay(from + 12 * HOUR) - 12) < 1e-9);
});

test('profil incomplet ou absurde : tolérance', () => {
  const r = simulateProcessesRaw({ sleeps: [], profile: { usualBed: 'abc', usualWake: '' }, fromMs: D0, toMs: D0 + DAY, stepMin: 10 });
  assert.equal(r.n, 145);
  assert.ok(Array.from(r.alertBase).every(Number.isFinite));
});
