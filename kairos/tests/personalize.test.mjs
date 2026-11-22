// Tests de personalize.js : retrouver des paramètres connus, refuser le sur-ajustement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitParams, checkinToAlert, alertToCheckin, MIN_OBSERVATIONS } from '../site/js/core/personalize.js';
import { rng } from '../site/js/core/time.js';

// Bruit gaussien déterministe (Box–Muller sur rng(seed)).
function gaussian(seed) {
  const r = rng(seed);
  return () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

// Modèle jouet : rythme de 24 h avec niveau, amplitude et heure du pic.
const circ = (v, h) => v.level + v.amp * Math.cos((2 * Math.PI * (h - v.peak)) / 24);

function makeData({ n, truth, noise, seed }) {
  const g = gaussian(seed);
  const r = rng(seed + 1000);
  const hours = Array.from({ length: n }, () => 7 + r() * 15); // 7 h → 22 h, instants irréguliers
  const targets = hours.map((h) => circ(truth, h) + noise * g());
  return { hours, targets };
}

const PARAMS = {
  level: { value: 40, min: 20, max: 80 },
  amp: { value: 15, min: 0, max: 60 },
  peak: { value: 12, min: 6, max: 20 },
};

test('fitParams retrouve des paramètres connus (bruit modéré)', () => {
  const truth = { level: 52, amp: 28, peak: 16.5 };
  const { hours, targets } = makeData({ n: 60, truth, noise: 3, seed: 11 });
  const res = fitParams({ params: PARAMS, targets, evaluate: (v) => hours.map((h) => circ(v, h)) });
  assert.ok(Math.abs(res.values.level - truth.level) < 3, `level ${res.values.level}`);
  assert.ok(Math.abs(res.values.amp - truth.amp) < 3.5, `amp ${res.values.amp}`);
  assert.ok(Math.abs(res.values.peak - truth.peak) < 0.6, `peak ${res.values.peak}`);
  assert.equal(res.n, 60);
  assert.ok(res.rmse < 4.5, `rmse ${res.rmse}`);
  assert.ok(res.baselineRmse > res.rmse * 2, 'le modèle doit battre nettement le modèle constant');
  assert.ok(res.r2 > 0.8, `r2 ${res.r2}`);
  assert.ok(res.confidence > 0.6, `confiance ${res.confidence}`);
  assert.ok(res.history.length >= 1);
});

test('fitParams sans bruit : convergence quasi exacte', () => {
  const truth = { level: 47, amp: 33, peak: 14 };
  const { hours, targets } = makeData({ n: 30, truth, noise: 0, seed: 5 });
  const res = fitParams({ params: PARAMS, targets, regularization: 0, evaluate: (v) => hours.map((h) => circ(v, h)) });
  assert.ok(Math.abs(res.values.level - truth.level) < 0.05);
  assert.ok(Math.abs(res.values.amp - truth.amp) < 0.05);
  assert.ok(Math.abs(res.values.peak - truth.peak) < 0.02);
  assert.ok(res.rmse < 0.05);
  assert.ok(res.r2 > 0.999);
  assert.equal(res.converged, true);
});

test('fitParams : bruit pur → confiance basse, pas de sur-ajustement', () => {
  const g = gaussian(99);
  const r = rng(7);
  const n = 40;
  const hours = Array.from({ length: n }, () => 7 + r() * 15);
  const targets = hours.map(() => 55 + 12 * g()); // aucune structure horaire
  const res = fitParams({ params: PARAMS, targets, evaluate: (v) => hours.map((h) => circ(v, h)) });
  assert.ok(res.confidence < 0.2, `confiance ${res.confidence} devrait être basse`);
  assert.ok(res.cv.skill < 0.2, `compétence CV ${res.cv.skill}`);
  assert.ok(res.baselineRmse > 0);
});

test('fitParams : bruit pur, plusieurs graines → jamais de confiance élevée', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const g = gaussian(seed * 17);
    const r = rng(seed * 31);
    const hours = Array.from({ length: 24 }, () => 7 + r() * 15);
    const targets = hours.map(() => 50 + 15 * g());
    const res = fitParams({ params: PARAMS, targets, evaluate: (v) => hours.map((h) => circ(v, h)) });
    assert.ok(res.confidence < 0.3, `graine ${seed} : confiance ${res.confidence}`);
  }
});

test('fitParams refuse honnêtement si n < 8', () => {
  const truth = { level: 52, amp: 28, peak: 16.5 };
  const { hours, targets } = makeData({ n: MIN_OBSERVATIONS - 1, truth, noise: 0, seed: 3 });
  let calls = 0;
  const res = fitParams({ params: PARAMS, targets, evaluate: (v) => { calls++; return hours.map((h) => circ(v, h)); } });
  assert.equal(res.confidence, 0);
  assert.equal(res.converged, false);
  assert.deepEqual(res.values, { level: 40, amp: 15, peak: 12 }, 'valeurs initiales conservées');
  assert.equal(res.n, 7);
  assert.ok(res.note && /observations/.test(res.note));
  assert.ok(calls <= 3, 'aucune optimisation lancée');
});

test('fitParams avec exactement 8 observations : tente l\'ajustement mais reste prudent', () => {
  const truth = { level: 52, amp: 28, peak: 16.5 };
  const { hours, targets } = makeData({ n: 8, truth, noise: 2, seed: 4 });
  const res = fitParams({ params: PARAMS, targets, evaluate: (v) => hours.map((h) => circ(v, h)) });
  assert.equal(res.n, 8);
  assert.ok(res.confidence >= 0 && res.confidence <= 0.5, `confiance ${res.confidence}`);
});

test('la confiance augmente avec le nombre d\'observations', () => {
  const truth = { level: 52, amp: 28, peak: 16.5 };
  const conf = (n) => {
    const { hours, targets } = makeData({ n, truth, noise: 4, seed: 21 });
    return fitParams({ params: PARAMS, targets, evaluate: (v) => hours.map((h) => circ(v, h)) }).confidence;
  };
  const c10 = conf(10);
  const c60 = conf(60);
  assert.ok(c60 > c10, `${c60} > ${c10}`);
  assert.ok(c60 > 0.6);
});

test('fitParams respecte les bornes', () => {
  // vrai pic à 21 h, mais borné à 18 h → le paramètre doit rester dans [6, 18]
  const truth = { level: 50, amp: 30, peak: 21 };
  const { hours, targets } = makeData({ n: 40, truth, noise: 1, seed: 8 });
  const params = { ...PARAMS, peak: { value: 12, min: 6, max: 18 } };
  const res = fitParams({ params, targets, evaluate: (v) => hours.map((h) => circ(v, h)) });
  for (const [k, p] of Object.entries(params)) {
    assert.ok(res.values[k] >= p.min - 1e-9 && res.values[k] <= p.max + 1e-9, `${k}=${res.values[k]}`);
  }
  assert.ok(res.values.peak > 17.5, 'collé à la borne haute');
});

test('la régularisation rapproche les valeurs de la valeur initiale', () => {
  const truth = { level: 60, amp: 35, peak: 17 };
  const { hours, targets } = makeData({ n: 12, truth, noise: 6, seed: 9 });
  const run = (regularization) => fitParams({ params: PARAMS, targets, regularization, evaluate: (v) => hours.map((h) => circ(v, h)) });
  const dist = (v) => Math.abs((v.level - 40) / 60) + Math.abs((v.amp - 15) / 60) + Math.abs((v.peak - 12) / 14);
  assert.ok(dist(run(5).values) < dist(run(0).values), 'forte régularisation → plus proche du départ');
});

test('fitParams est déterministe (même graine → même résultat)', () => {
  const truth = { level: 52, amp: 28, peak: 16.5 };
  const { hours, targets } = makeData({ n: 25, truth, noise: 3, seed: 2 });
  const ev = (v) => hours.map((h) => circ(v, h));
  const a = fitParams({ params: PARAMS, targets, evaluate: ev, seed: 7 });
  const b = fitParams({ params: PARAMS, targets, evaluate: ev, seed: 7 });
  assert.deepEqual(a, b);
});

test('fitParams tolère un modèle qui renvoie NaN ponctuellement', () => {
  const truth = { level: 52, amp: 28, peak: 16.5 };
  const { hours, targets } = makeData({ n: 20, truth, noise: 2, seed: 6 });
  const res = fitParams({
    params: PARAMS, targets,
    evaluate: (v) => hours.map((h) => (v.amp > 59.9 ? NaN : circ(v, h))),
  });
  assert.ok(Number.isFinite(res.rmse));
  assert.ok(Math.abs(res.values.amp - truth.amp) < 5);
});

test('fitParams : erreurs d\'entrée lisibles en français', () => {
  assert.throws(() => fitParams({ params: {}, evaluate: () => [], targets: [] }), /paramètre/i);
  assert.throws(() => fitParams({ params: PARAMS, evaluate: null, targets: [] }), /prédiction/i);
  assert.throws(() => fitParams({ params: PARAMS, evaluate: () => [1], targets: Array(10).fill(50) }), /une valeur par observation/);
});

test('checkinToAlert / alertToCheckin : bornes, monotonie et réciprocité', () => {
  for (let v = 1; v <= 5; v++) {
    const a = checkinToAlert(v);
    assert.ok(a >= 0 && a <= 100);
    assert.ok(Math.abs(alertToCheckin(a) - v) < 1e-9);
    if (v > 1) assert.ok(a > checkinToAlert(v - 1));
  }
  assert.equal(checkinToAlert(3), 50);
  assert.equal(checkinToAlert(0), checkinToAlert(1));
  assert.equal(checkinToAlert(9), checkinToAlert(5));
  assert.equal(alertToCheckin(-20), 1);
  assert.equal(alertToCheckin(250), 5);
  assert.equal(checkinToAlert(NaN), 50);
  assert.equal(alertToCheckin(NaN), 3);
});
