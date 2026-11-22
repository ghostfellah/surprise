// Kairos — ajustement personnel du modèle (générique, sans dépendance).
//
// Idée : l'utilisateur répond de temps en temps à « comment te sens-tu ? » (1..5). On confronte ces
// réponses (ramenées sur 0..100) aux prédictions du modèle, et on ajuste quelques paramètres
// (décalage de phase, sensibilité à la caféine…) pour réduire l'écart.
//
// Choix et hypothèses :
// - Optimiseur : Nelder–Mead borné (espace normalisé [0,1]^d, projection sur les bornes), relancé
//   plusieurs fois de façon déterministe (rng(seed)) : départ = valeurs initiales, puis alternance
//   de points aléatoires de la boîte et de perturbations autour du meilleur. Sans gradient : la
//   fonction `evaluate` est une boîte noire (typiquement buildModel + lecture aux instants des check-ins).
// - Régularisation vers la valeur initiale : terme λ·var(cibles)·moyenne((u − u0)²) ajouté à l'EQM
//   — ramène les paramètres mal identifiés vers leur valeur de départ plutôt que vers un extrême.
// - Confiance honnête : validation croisée « leave-one-out » (par groupes si n > 40, pour borner le
//   coût), comparée au meilleur modèle CONSTANT (la moyenne). confiance = compétence de
//   validation croisée (Q², 0 si pas meilleure que la moyenne) × facteur de taille d'échantillon
//   × facteur « paramètres collés aux bornes ». Sur du bruit pur, la compétence est ≤ 0 → confiance 0.
// - Refus : moins de 8 observations → on ne touche à rien (valeurs initiales, confiance 0).
// - Rappel : outil de confort, pas un dispositif médical ; un ajustement sur quelques dizaines de
//   points reste une estimation grossière.
import { clamp, rng } from './time.js';

/** Nombre minimal d'observations pour tenter un ajustement. */
export const MIN_OBSERVATIONS = 8;

/** Check-in 1..5 → alerte 0..100 (1 → 10, 3 → 50, 5 → 90 : on évite les extrêmes 0 et 100, rarement ressentis). */
export function checkinToAlert(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 50;
  return clamp(10 + 20 * (clamp(x, 1, 5) - 1), 0, 100);
}

/** Alerte 0..100 → check-in continu 1..5 (réciproque de checkinToAlert ; arrondir côté UI si besoin). */
export function alertToCheckin(a) {
  const x = Number(a);
  if (!Number.isFinite(x)) return 3;
  return clamp(1 + (clamp(x, 0, 100) - 10) / 20, 1, 5);
}

const BIG = 1e18; // valeur d'objectif quand le modèle renvoie NaN/Infinity

/**
 * Nelder–Mead dans [0,1]^d (coefficients adaptatifs de Gao & Han, 2012). Retourne le meilleur point,
 * sa valeur, le nombre d'itérations et un indicateur de convergence.
 */
function nelderMead(f, start, maxIter, step = 0.12) {
  const d = start.length;
  const proj = (x) => x.map((v) => Math.min(1, Math.max(0, v)));
  const alpha = 1;
  const beta = 1 + 2 / d;
  const gamma = 0.75 - 1 / (2 * d);
  const delta = 1 - 1 / d;
  let simplex = [proj(start)];
  for (let i = 0; i < d; i++) {
    const p = simplex[0].slice();
    p[i] = p[i] + step <= 1 ? p[i] + step : p[i] - step;
    simplex.push(p);
  }
  let vals = simplex.map(f);
  let iter = 0;
  let converged = false;
  const order = () => {
    const idx = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b] || a - b);
    simplex = idx.map((i) => simplex[i]);
    vals = idx.map((i) => vals[i]);
  };
  const combine = (c, x, k) => proj(c.map((v, i) => v + k * (x[i] - v)));
  while (iter < maxIter) {
    order();
    let diam = 0;
    for (let i = 1; i <= d; i++) for (let j = 0; j < d; j++) diam = Math.max(diam, Math.abs(simplex[i][j] - simplex[0][j]));
    if (diam < 1e-7 && Math.abs(vals[d] - vals[0]) <= 1e-10 * (1 + Math.abs(vals[0]))) { converged = true; break; }
    iter++;
    const c = new Array(d).fill(0);
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) c[j] += simplex[i][j] / d;
    const xw = simplex[d];
    const xr = combine(c, xw, -alpha);
    const fr = f(xr);
    if (fr < vals[0]) {
      const xe = combine(c, xw, -beta);
      const fe = f(xe);
      if (fe < fr) { simplex[d] = xe; vals[d] = fe; } else { simplex[d] = xr; vals[d] = fr; }
    } else if (fr < vals[d - 1]) {
      simplex[d] = xr; vals[d] = fr;
    } else {
      const outside = fr < vals[d];
      const xc = outside ? combine(c, xw, -gamma) : combine(c, xw, gamma);
      const fc = f(xc);
      if (fc <= (outside ? fr : vals[d])) { simplex[d] = xc; vals[d] = fc; } else {
        for (let i = 1; i <= d; i++) {
          simplex[i] = combine(simplex[0], simplex[i], delta);
          vals[i] = f(simplex[i]);
        }
      }
    }
  }
  order();
  return { u: simplex[0], f: vals[0], iters: iter, converged };
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

/**
 * Ajuste des paramètres d'un modèle sur des observations.
 *
 * @param {object} args
 * @param {Object<string,{value:number,min:number,max:number}>} args.params paramètres, valeur initiale et bornes
 * @param {(values:Object<string,number>)=>number[]} args.evaluate prédictions (0..100) aux instants des observations
 * @param {number[]} args.targets observations (alerte ramenée sur 0..100), même ordre que `evaluate`
 * @param {number} [args.regularization=0.02] force du rappel vers la valeur initiale (0 = aucun)
 * @param {number} [args.maxIter=300] itérations Nelder–Mead maximum par départ
 * @param {number} [args.restarts=6] nombre de départs (≥ 1)
 * @param {number} [args.seed=1] graine des redémarrages aléatoires
 * @param {boolean} [args.cv=true] calcule la confiance par validation croisée (sinon confiance 0)
 * @returns {{values, rmse, baselineRmse, r2, n, confidence, converged, history, cv?, note?}}
 */
export function fitParams({
  params, evaluate, targets, regularization = 0.02, maxIter = 300, restarts = 6, seed = 1, cv = true,
} = {}) {
  if (!params || typeof params !== 'object' || !Object.keys(params).length) throw new Error('Aucun paramètre à ajuster');
  if (typeof evaluate !== 'function') throw new Error('Fonction de prédiction manquante');
  if (!Array.isArray(targets)) throw new Error('Observations manquantes');

  const names = Object.keys(params);
  const lo = names.map((k) => Math.min(Number(params[k].min), Number(params[k].max)));
  const hi = names.map((k) => Math.max(Number(params[k].min), Number(params[k].max)));
  const init = names.map((k, i) => clamp(Number(params[k].value), lo[i], hi[i]));
  if ([...lo, ...hi, ...init].some((v) => !Number.isFinite(v))) throw new Error('Paramètres ou bornes invalides');
  const free = names.map((_, i) => hi[i] > lo[i]);
  const freeIdx = free.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
  const d = freeIdx.length;

  const toValues = (u) => {
    const v = {};
    names.forEach((k, i) => { v[k] = init[i]; });
    freeIdx.forEach((i, j) => { v[names[i]] = lo[i] + u[j] * (hi[i] - lo[i]); });
    return v;
  };
  const u0 = freeIdx.map((i) => (init[i] - lo[i]) / (hi[i] - lo[i]));

  const valid = [];
  targets.forEach((y, i) => { if (Number.isFinite(y)) valid.push(i); });
  const n = valid.length;
  const y = valid.map((i) => targets[i]);
  const yMean = mean(y);
  const sst = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const baselineRmse = n ? Math.sqrt(sst / n) : 0;

  const predictAll = (values) => {
    const p = evaluate(values);
    if (!p || p.length !== targets.length) throw new Error('La fonction de prédiction doit renvoyer une valeur par observation');
    return p;
  };
  const metrics = (values) => {
    const p = predictAll(values);
    let sse = 0;
    for (const i of valid) { const e = Number.isFinite(p[i]) ? p[i] - targets[i] : 100; sse += e * e; }
    return { rmse: n ? Math.sqrt(sse / n) : 0, r2: sst > 1e-12 ? 1 - sse / sst : 0 };
  };

  const refuse = (note) => {
    const m = metrics(toValues(u0));
    return {
      values: toValues(u0), rmse: m.rmse, baselineRmse, r2: m.r2, n, confidence: 0, converged: false, history: [], note,
    };
  };
  if (n < MIN_OBSERVATIONS) return refuse(`Pas assez d'observations (${n} < ${MIN_OBSERVATIONS}) : ajustement refusé`);
  if (d === 0) return refuse('Aucun paramètre libre à ajuster');

  // objectif : EQM sur les observations `idx` + rappel vers la valeur initiale
  const makeObjective = (idx) => {
    const yy = idx.map((i) => targets[i]);
    const m = mean(yy);
    const varY = Math.max(1, mean(yy.map((v) => (v - m) ** 2)));
    return (u) => {
      const p = predictAll(toValues(u));
      let sse = 0;
      for (const i of idx) {
        const e = p[i] - targets[i];
        sse += Number.isFinite(e) ? e * e : BIG;
      }
      let pen = 0;
      for (let j = 0; j < d; j++) pen += (u[j] - u0[j]) ** 2;
      return sse / idx.length + regularization * varY * (pen / d);
    };
  };

  const rand = rng(seed);
  const history = [];
  const fFull = makeObjective(valid);
  let best = null;
  const nStarts = Math.max(1, Math.floor(restarts));
  for (let r = 0; r < nStarts; r++) {
    let start;
    if (r === 0) start = u0;
    else if (r % 2 === 1) start = u0.map(() => rand());
    else start = (best?.u ?? u0).map((v) => clamp(v + (rand() + rand() + rand() - 1.5) * 0.3, 0, 1));
    // relances locales : un simplexe rétréci par la projection sur les bornes redevient utile
    let run = nelderMead(fFull, start, maxIter);
    for (let k = 0; k < 2; k++) {
      const again = nelderMead(fFull, run.u, maxIter, 0.05);
      const improved = again.f < run.f - 1e-12 * (1 + Math.abs(run.f));
      run = { u: again.f <= run.f ? again.u : run.u, f: Math.min(run.f, again.f), iters: run.iters + again.iters, converged: again.converged };
      if (!improved) break;
    }
    history.push({ restart: r, f: run.f, iters: run.iters, converged: run.converged });
    if (!best || run.f < best.f) best = { ...run, restart: r };
  }
  const values = toValues(best.u);
  const m = metrics(values);

  // confiance : validation croisée leave-one-out (par groupes si n > 40) contre le modèle constant
  let confidence = 0;
  let cvInfo;
  if (cv) {
    const folds = n <= 40 ? n : 20;
    const cvIter = Math.max(60, Math.floor(maxIter / 2));
    let seM = 0; let seB = 0;
    for (let k = 0; k < folds; k++) {
      const held = []; const train = [];
      valid.forEach((i, pos) => (pos % folds === k ? held : train).push(i));
      if (!held.length || train.length < 2) continue;
      const f = makeObjective(train);
      const a = nelderMead(f, best.u, cvIter, 0.05);
      const b = nelderMead(f, u0, cvIter);
      const u = a.f <= b.f ? a.u : b.u;
      const p = predictAll(toValues(u));
      const mTrain = mean(train.map((i) => targets[i]));
      for (const i of held) {
        const e = Number.isFinite(p[i]) ? p[i] - targets[i] : 100;
        seM += e * e;
        seB += (mTrain - targets[i]) ** 2;
      }
    }
    const skill = seB > 1e-12 ? 1 - seM / seB : 0;
    const sizeFactor = 1 - Math.exp(-(n - 4) / 10);
    const pinned = freeIdx.filter((_, j) => best.u[j] < 1e-3 || best.u[j] > 1 - 1e-3).length / d;
    const boundFactor = 1 - 0.3 * pinned;
    confidence = m.r2 > 0 ? clamp(skill, 0, 1) * sizeFactor * boundFactor : 0;
    cvInfo = { rmse: Math.sqrt(seM / n), baselineRmse: Math.sqrt(seB / n), skill: clamp(skill, -1, 1), folds };
  }

  return {
    values, rmse: m.rmse, baselineRmse, r2: m.r2, n,
    confidence: Math.round(confidence * 1000) / 1000,
    converged: best.converged, history, cv: cvInfo,
  };
}
