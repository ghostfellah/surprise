// Kairos — planificateur : place les tâches là où le cerveau est le plus apte à les accomplir.
//
// Hypothèses et choix de conception (à lire avant de modifier) :
// - Logique pure, ESM, aucune dépendance. Le planificateur ne connaît PAS model.js : il reçoit une
//   courbe d'alerte `{ t0, stepMin, alert[] }` (0..100) et rien d'autre sur la physiologie.
// - Le temps est discrétisé en cellules de 5 min, ancrées sur le prochain multiple de 5 min après
//   `nowMs`. Un bloc = suite contiguë de cellules libres → aucun bloc ne peut commencer avant
//   maintenant, chevaucher un événement fixe, sortir des plages de travail ou dépasser l'échéance.
// - Les événements « toute la journée » (allDay) ne bloquent PAS le créneau (ce sont des rappels,
//   des anniversaires, des jours fériés…) : un événement qui doit bloquer doit avoir des heures.
// - Adéquation charge ↔ alerte : chaque charge cognitive L (1..5) exige une alerte minimale
//   req(L) = 18,75 + 11,25·L (L=5 → 75, L=1 → 30). Un déficit est pénalisé de façon quadratique
//   (et d'autant plus que la tâche est lourde) ; un excédent (tâche légère dans un pic) n'est
//   que faiblement pénalisé : il « gaspille » un pic, il ne met pas en danger la tâche.
// - Objectif maximisé (en « minutes pondérées ») :
//     V = Σ durée·poids·fit − retard prioritaire − fragmentation − changements de contexte
//         + regroupement de tâches légères − dépassement du plafond de travail profond/jour
//   `score` renvoyé = V ; le recuit maximise V + bonus de complétion (placer vaut toujours mieux
//   que ne pas placer). `baselineScore` = V de la planification naïve chronologique par priorité.
// - Les échéances sont DURES : jamais de bloc qui finit après l'échéance ; sinon la tâche (ou son
//   reliquat) part dans `unplaced` avec une explication en français.
// - Algorithme : construction gloutonne (meilleure position par bloc, tâches triées par priorité)
//   puis recuit simulé déterministe (rng(seed)) avec mouvements déplacer / échanger / découper /
//   fusionner / transférer / insérer / remplacer. Aucune horloge dans la boucle : même seed → même
//   résultat. Si, par exception, la planification naïve valait mieux, elle est renvoyée (lift ≥ 0).
import {
  MIN, DAY, startOfDay, addDays, atMinutes, parseHHMM, fmtTime, fmtDateFR, fmtDuration, clamp, rng,
} from './time.js';

const CELL_MIN = 5;
const CELL = CELL_MIN * MIN;

/** Déjeuner protégé : 12:00 – 13:30 (minutes depuis minuit). */
export const LUNCH = { startMin: 12 * 60, endMin: 13 * 60 + 30 };

export const DEFAULT_OPTIONS = Object.freeze({
  seed: 1, iterations: 4000, breakMin: 10, maxBlockMin: 120, protectLunch: true,
});

// Poids de priorité (1 = urgent … 4 = un jour) et pénalité de retard par jour (par minute pondérée).
const PRIO_W = [1, 2.0, 1.4, 1.0, 0.7];
const PRIO_LAMBDA = [0.02, 0.10, 0.05, 0.02, 0.01];
const DEADLINE_BOOST = 1.4;     // une tâche avec échéance passe avant une tâche sans échéance
const COMPLETION = 0.6;         // bonus de complétion (optimisation seulement, pas dans `score`)
const FRAG_PENALTY = 6;         // par bloc excédentaire (au-delà du minimum nécessaire)
const SWITCH_PENALTY = 3;       // changement de contexte entre deux blocs voisins
const BATCH_BONUS = 5;          // deux tâches légères (charge ≤ 2) voisines
const DEEP_CAP_MIN = 240;       // au-delà, le travail profond du jour (charge ≥ 4) coûte cher
const DEEP_PENALTY = 0.6;
const MIN_USEFUL_C = 5;         // un trou libre plus court que 25 min est quasi inutilisable (glouton)
const WASTE_COST = 0.35;        // coût par minute de trou inutilisable créé par un placement (glouton)
const EFFORT = 6;               // un pas de recuit coûte ~1 µs : on en exécute iterations × EFFORT

// ───────────────────────── Adéquation charge cognitive ↔ alerte ─────────────────────────

/** Alerte minimale « confortable » pour une charge L (1..5) : 30 → 75. */
export function requiredAlert(load) {
  return 18.75 + 11.25 * clamp(Number(load) || 3, 1, 5);
}

/**
 * Désadéquation ≥ 0 (0 = parfait). Asymétrique : un déficit d'alerte est quadratique et d'autant
 * plus coûteux que la tâche est lourde ; un excédent n'est qu'un léger gaspillage de pic.
 */
export function mismatch(load, alert) {
  const L = clamp(Number(load) || 3, 1, 5);
  const a = clamp(Number.isFinite(alert) ? alert : 50, 0, 100);
  const d = requiredAlert(L) - a;
  let m = d > 0 ? (d / 25) ** 2 * (0.5 + 0.25 * L) : (0.35 * -d) / 100;
  if (a < 20) m += 0.5 * ((20 - a) / 20) ** 2; // quasi-sommeil : mauvais pour tout
  return m;
}

/** Adéquation 0..1 (1 = idéal) entre une charge 1..5 et une alerte 0..100. */
export function fitScore(load, alert) {
  return 1 / (1 + mismatch(load, alert));
}

// ───────────────────────── Courbe d'alerte (ms) ─────────────────────────

function curveStepMs(curve) {
  return (Number(curve.stepMin) > 0 ? curve.stepMin : 5) * MIN;
}

/** Alerte interpolée linéairement à l'instant `ms` (bornée aux extrémités de la courbe). */
export function alertAt(curve, ms) {
  const a = curve.alert;
  const n = a.length;
  if (!n) return 50;
  if (n === 1) return a[0];
  const x = clamp((ms - curve.t0) / curveStepMs(curve), 0, n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  return a[i] + (a[i + 1] - a[i]) * (x - i);
}

/** Alerte moyenne sur [aMs, bMs] (intégrale exacte de la courbe linéaire par morceaux). */
export function meanAlertMs(curve, aMs, bMs) {
  const n = curve.alert.length;
  if (!n) return 50;
  const step = curveStepMs(curve);
  const lo = clamp(aMs, curve.t0, curve.t0 + (n - 1) * step);
  const hi = clamp(bMs, curve.t0, curve.t0 + (n - 1) * step);
  if (hi - lo < 1) return alertAt(curve, aMs);
  let area = 0;
  let i = Math.floor((lo - curve.t0) / step);
  for (; i < n - 1; i++) {
    const x0 = Math.max(lo, curve.t0 + i * step);
    const x1 = Math.min(hi, curve.t0 + (i + 1) * step);
    if (x1 <= x0) { if (x0 >= hi) break; continue; }
    area += ((alertAt(curve, x0) + alertAt(curve, x1)) / 2) * (x1 - x0);
  }
  return area / (hi - lo);
}

// ───────────────────────── Plages de travail et créneaux libres ─────────────────────────

function normaliseProfile(profile = {}) {
  const safe = (s, dflt) => { try { return parseHHMM(s); } catch { return dflt; } };
  return {
    wsMin: safe(profile.workStart, 9 * 60),
    weMin: safe(profile.workEnd, 18 * 60),
    workDays: Array.isArray(profile.workDays) ? profile.workDays : [1, 2, 3, 4, 5],
  };
}

function normaliseOptions(options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  o.seed = Number.isFinite(o.seed) ? o.seed : 1;
  o.iterations = Math.max(0, Math.floor(Number.isFinite(o.iterations) ? o.iterations : 4000));
  o.breakMin = Math.max(0, Number.isFinite(o.breakMin) ? o.breakMin : 10);
  o.maxBlockMin = Math.max(CELL_MIN, Number.isFinite(o.maxBlockMin) ? o.maxBlockMin : 120);
  o.protectLunch = o.protectLunch !== false;
  return o;
}

const ceil5 = (ms) => Math.ceil(ms / CELL) * CELL;

/**
 * Plages de travail [{startMs,endMs}] dans [fromMs,toMs], déjeuner protégé retiré si demandé.
 * Une plage dont la fin ≤ début (poste de nuit) se termine le lendemain.
 */
export function workWindows(profile, fromMs, toMs, protectLunch = true) {
  const p = normaliseProfile(profile);
  const out = [];
  for (let day = addDays(startOfDay(fromMs), -1); day < toMs; day = addDays(day, 1)) {
    if (!p.workDays.includes(new Date(day).getDay())) continue;
    const ws = atMinutes(day, p.wsMin);
    const we = p.weMin > p.wsMin ? atMinutes(day, p.weMin) : atMinutes(addDays(day, 1), p.weMin);
    let segs = [[ws, we]];
    if (protectLunch && p.weMin > p.wsMin) {
      const ls = atMinutes(day, LUNCH.startMin);
      const le = atMinutes(day, LUNCH.endMin);
      segs = segs.flatMap(([a, b]) => {
        if (le <= a || ls >= b) return [[a, b]];
        const r = [];
        if (ls > a) r.push([a, ls]);
        if (le < b) r.push([le, b]);
        return r;
      });
    }
    for (const [a, b] of segs) {
      const s = Math.max(a, fromMs);
      const e = Math.min(b, toMs);
      if (e > s) out.push({ startMs: s, endMs: e, dayMs: day });
    }
  }
  return out;
}

const timedEvents = (events) => (events || []).filter((e) => e && !e.allDay && Number.isFinite(e.startMs) && Number.isFinite(e.endMs) && e.endMs > e.startMs);

function subtractIntervals(windows, busy) {
  const sorted = [...busy].sort((x, y) => x.startMs - y.startMs);
  const out = [];
  for (const w of windows) {
    let cur = w.startMs;
    for (const b of sorted) {
      if (b.endMs <= cur) continue;
      if (b.startMs >= w.endMs) break;
      if (b.startMs > cur) out.push({ startMs: cur, endMs: b.startMs });
      cur = Math.max(cur, b.endMs);
    }
    if (cur < w.endMs) out.push({ startMs: cur, endMs: w.endMs });
  }
  return out;
}

/**
 * Créneaux libres [{startMs,endMs}] : plages de travail − déjeuner − événements − blocs verrouillés
 * − `blocks` (blocs déjà posés, utile pour l'aperçu d'un glisser-déposer). Pas de marge de pause.
 */
export function slotsFree({
  events = [], locked = [], blocks = [], profile, nowMs, horizonEndMs, options, curve, minMin = CELL_MIN,
} = {}) {
  const o = normaliseOptions(options);
  const from = ceil5(nowMs);
  let to = horizonEndMs;
  if (curve && curve.alert?.length) to = Math.min(to, curve.t0 + (curve.alert.length - 1) * curveStepMs(curve));
  if (!(to > from)) return [];
  const windows = workWindows(profile, from, to, o.protectLunch);
  const busy = [...timedEvents(events), ...(locked || []), ...(blocks || [])]
    .filter((b) => b && Number.isFinite(b.startMs) && Number.isFinite(b.endMs) && b.endMs > b.startMs);
  return subtractIntervals(windows, busy).filter((s) => s.endMs - s.startMs >= minMin * MIN);
}

// ───────────────────────── Explications ─────────────────────────

/** Texte « pourquoi ici ? » en français pour un bloc (le bloc peut avoir été déplacé à la main). */
export function explainBlock(block, task, curve) {
  const load = clamp(Number(task?.load) || 3, 1, 5);
  const a = curve?.alert?.length ? Math.round(meanAlertMs(curve, block.startMs, block.endMs)) : null;
  let txt;
  if (a == null) {
    txt = load >= 4 ? 'Tâche exigeante : prévision d\'énergie indisponible ici'
      : 'Prévision d\'énergie indisponible ici';
  } else if (load >= 4) {
    if (a >= 75) txt = `Pic d'alerte (${a}/100) — idéal pour du travail profond`;
    else if (a >= 62) txt = `Bonne forme (${a}/100) — convient à une tâche exigeante`;
    else txt = `Alerte modérée (${a}/100) : meilleur compromis restant pour une tâche exigeante`;
  } else if (load === 3) {
    if (a >= 75) txt = `Pic d'alerte (${a}/100) — large marge pour une tâche de concentration moyenne`;
    else if (a >= 52) txt = `Alerte correcte (${a}/100) — suffisante pour une tâche de concentration moyenne`;
    else txt = `Alerte basse (${a}/100) : créneau de repli pour une tâche de concentration moyenne`;
  } else if (a < 55) {
    txt = `Creux d'énergie (${a}/100) — parfait pour une tâche légère, tes pics restent libres`;
  } else if (a < 75) {
    txt = `Alerte moyenne (${a}/100) — confortable pour une tâche légère`;
  } else {
    txt = `Pic d'alerte (${a}/100) disponible : une tâche légère s'y fait sans effort`;
  }
  if (task?.deadlineMs != null && task.deadlineMs - block.endMs < 36 * 3_600_000 && task.deadlineMs >= block.endMs) {
    txt += ` · à finir avant ${fmtDateFR(task.deadlineMs, { short: true })} ${fmtTime(task.deadlineMs)}`;
  }
  if (block.parts > 1 && block.part) txt += ` · bloc ${block.part}/${block.parts}`;
  return txt;
}

// ───────────────────────── Préparation : grille, tâches ─────────────────────────

/** Grille de cellules de 5 min : -2 = indisponible, -1 = libre, ≥ 0 = id de bloc. */
function buildGrid({ events, curve, nowMs, horizonEndMs, profile, options }) {
  const t0 = Number.isFinite(curve?.t0) ? curve.t0 : nowMs;
  const curveEnd = curve?.alert?.length ? curve.t0 + (curve.alert.length - 1) * curveStepMs(curve) : -Infinity;
  const base = ceil5(Math.max(nowMs, t0));
  const limit = Math.min(horizonEndMs, curveEnd);
  const N = limit > base ? Math.floor((limit - base) / CELL) : 0;
  const occ0 = new Int32Array(N).fill(-2);
  const dayOf = new Int16Array(N);
  if (N > 0) {
    const day0 = startOfDay(base);
    for (const w of workWindows(profile, base, base + N * CELL, options.protectLunch)) {
      const cs = Math.max(0, Math.ceil((w.startMs - base) / CELL));
      const ce = Math.min(N, Math.floor((w.endMs - base) / CELL));
      const di = Math.round((w.dayMs - day0) / DAY) + 1;
      for (let c = cs; c < ce; c++) { occ0[c] = -1; dayOf[c] = di; }
    }
    for (const e of timedEvents(events)) {
      const cs = Math.max(0, Math.floor((e.startMs - base) / CELL));
      const ce = Math.min(N, Math.ceil((e.endMs - base) / CELL));
      for (let c = cs; c < ce; c++) occ0[c] = -2;
    }
  }
  const alertCell = new Float64Array(N);
  const pre = new Float64Array(N + 1);
  for (let c = 0; c < N; c++) {
    alertCell[c] = alertAt(curve, base + c * CELL + CELL / 2);
    pre[c + 1] = pre[c] + alertCell[c];
  }
  // plages contiguës de cellules disponibles (pour parcourir vite) et leurs bornes par cellule
  const runs = [];
  const runStartOf = new Int32Array(N);
  const runEndOf = new Int32Array(N);
  const availList = [];
  for (let c = 0; c < N;) {
    if (occ0[c] === -2) { c++; continue; }
    let e = c;
    while (e < N && occ0[e] !== -2) e++;
    runs.push([c, e]);
    for (let k = c; k < e; k++) { runStartOf[k] = c; runEndOf[k] = e; availList.push(k); }
    c = e;
  }
  const brk = Math.ceil(options.breakMin / CELL_MIN);
  return {
    base, N, occ0, dayOf, alertCell, pre, runs, runStartOf, runEndOf,
    avail: Int32Array.from(availList), brk, adj: brk + 6, nDays: (N ? Math.ceil(N / 288) : 0) + 4,
  };
}

function activeTasks(tasks) {
  return (tasks || []).filter((t) => t && !t.done && Number(t.durMin) > 0);
}

function buildTaskInfos(tasks, G, o, nowMs) {
  const maxC = Math.max(1, Math.ceil(o.maxBlockMin / CELL_MIN));
  return activeTasks(tasks).map((t, i) => {
    const durC = Math.max(1, Math.ceil(Number(t.durMin) / CELL_MIN));
    const splittable = t.splittable ?? Number(t.durMin) > 90;
    const kmin = Math.max(1, Math.ceil(durC / maxC));
    const minReq = Math.max(1, Math.ceil((Number(t.minBlockMin) > 0 ? t.minBlockMin : 25) / CELL_MIN));
    const prio = clamp(Math.round(Number(t.priority) || 3), 1, 4);
    const hasDl = Number.isFinite(t.deadlineMs);
    const urgentDl = hasDl && t.deadlineMs - nowMs < 2 * DAY;
    return {
      i, id: t.id, raw: t, durC, splittable,
      load: clamp(Number(t.load) || 3, 1, 5),
      prio, effPrio: clamp(prio - (urgentDl ? 1 : 0), 1, 4),
      maxC: splittable ? maxC : durC,
      minC: splittable ? Math.max(1, Math.min(minReq, Math.floor(durC / kmin))) : durC,
      minBlocks: splittable ? kmin : 1,
      w: PRIO_W[prio] * (hasDl ? DEADLINE_BOOST : 1),
      lam: PRIO_LAMBDA[prio],
      tags: Array.isArray(t.tags) ? t.tags : [],
      deadlineMs: hasDl ? t.deadlineMs : null,
      earliestC: Number.isFinite(t.earliestMs) ? Math.max(0, Math.ceil((t.earliestMs - G.base) / CELL)) : 0,
      endC: hasDl ? clamp(Math.floor((t.deadlineMs - G.base) / CELL), 0, G.N) : G.N,
    };
  });
}

// ───────────────────────── État de planification ─────────────────────────

function makeState(G, T, lockedBlocks) {
  const nT = T.length;
  const S = {
    occ: Int32Array.from(G.occ0),
    byId: [],
    live: [],
    tb: Array.from({ length: nT + 1 }, () => []), // blocs par tâche (index nT = tâche inconnue)
    placedC: new Int32Array(nT + 1),              // cellules posées (hors blocs verrouillés)
    fixedC: new Int32Array(nT + 1),               // cellules déjà couvertes par des blocs verrouillés
    nextId: 0,
    journal: [],
  };
  const idx = new Map(T.map((ti) => [ti.id, ti.i]));
  for (const lb of lockedBlocks) {
    const t = idx.has(lb.taskId) ? idx.get(lb.taskId) : nT;
    S.fixedC[t] += Math.max(0, Math.round((lb.endMs - lb.startMs) / CELL));
    const s = Math.max(0, Math.floor((lb.startMs - G.base) / CELL));
    const e = Math.min(G.N, Math.ceil((lb.endMs - G.base) / CELL));
    if (e <= s) continue; // hors horizon : conservé en sortie, sans effet sur la grille
    const b = { id: S.nextId++, t, s, len: e - s, fixed: true, pos: -1 };
    S.byId[b.id] = b;
    for (let c = s; c < e; c++) if (S.occ[c] === -1) S.occ[c] = b.id;
    attach(S, b);
  }
  return S;
}

function attach(S, b) {
  b.pos = S.live.length;
  S.live.push(b);
  S.tb[b.t].push(b);
  if (!b.fixed) S.placedC[b.t] += b.len;
}

function detach(S, b) {
  const last = S.live.pop();
  if (last !== b) { S.live[b.pos] = last; last.pos = b.pos; }
  const arr = S.tb[b.t];
  arr.splice(arr.indexOf(b), 1);
  if (!b.fixed) S.placedC[b.t] -= b.len;
}

function addRaw(S, b) {
  for (let c = b.s, e = b.s + b.len; c < e; c++) S.occ[c] = b.id;
  attach(S, b);
}

function removeRaw(S, b) {
  for (let c = b.s, e = b.s + b.len; c < e; c++) if (S.occ[c] === b.id) S.occ[c] = -1;
  detach(S, b);
}

// versions journalisées (annulation d'un mouvement rejeté)
function jRemove(S, b) { S.journal.push({ op: 0, b, s: b.s, len: b.len }); removeRaw(S, b); }
function jAdd(S, b) { S.journal.push({ op: 1, b }); addRaw(S, b); }
function jNew(S, t, s, len) {
  const b = { id: S.nextId++, t, s, len, fixed: false, pos: -1 };
  S.byId[b.id] = b;
  jAdd(S, b);
  return b;
}
function undoAll(S) {
  for (let k = S.journal.length - 1; k >= 0; k--) {
    const j = S.journal[k];
    if (j.op === 1) removeRaw(S, j.b);
    else { j.b.s = j.s; j.b.len = j.len; addRaw(S, j.b); }
  }
  S.journal.length = 0;
}

const remaining = (S, ti) => ti.durC - S.fixedC[ti.i] - S.placedC[ti.i];

/** Un bloc [s, s+len) de la tâche `ti` est-il posable ? (cellules libres, pauses, fenêtre, échéance) */
function canPlace(S, G, ti, s, len) {
  if (s < 0 || s < ti.earliestC || s + len > ti.endC || s + len > G.N) return false;
  const occ = S.occ;
  for (let c = s, e = s + len; c < e; c++) if (occ[c] !== -1) return false;
  // pause minimale avec un bloc voisin (une cellule indisponible entre les deux compte comme pause)
  for (let c = s - 1, k = 0; k < G.brk && c >= 0; k++, c--) {
    const v = occ[c];
    if (v === -2) break;
    if (v >= 0) return false;
  }
  for (let c = s + len, k = 0; k < G.brk && c < G.N; k++, c++) {
    const v = occ[c];
    if (v === -2) break;
    if (v >= 0) return false;
  }
  return true;
}

// ───────────────────────── Évaluation ─────────────────────────

function makeEvaluator(G, T) {
  const nT = T.length;
  const load = new Float64Array(nT + 1).fill(3);
  const w = new Float64Array(nT + 1).fill(1);
  const lam = new Float64Array(nT + 1).fill(0.02);
  const minBlocks = new Float64Array(nT + 1).fill(1e9);
  for (const ti of T) { load[ti.i] = ti.load; w[ti.i] = ti.w; lam[ti.i] = ti.lam; minBlocks[ti.i] = ti.minBlocks; }
  // coût du voisinage de deux blocs de tâches différentes : regroupement (+) vs changement de contexte (−)
  const pair = new Float64Array((nT + 1) * (nT + 1));
  for (const a of T) {
    for (const b of T) {
      if (a.i === b.i) continue;
      const shared = a.tags.some((x) => b.tags.includes(x));
      const sw = SWITCH_PENALTY * (shared ? 0.3 : 1) * (1 + 0.25 * Math.abs(a.load - b.load));
      pair[a.i * (nT + 1) + b.i] = (a.load <= 2 && b.load <= 2 ? BATCH_BONUS : 0) - sw;
    }
  }
  const nbl = new Int32Array(nT + 1);
  const deep = new Int32Array(G.nDays + 2);

  /** Retourne { V, J } : V = score affiché, J = V + bonus de complétion (objectif du recuit). */
  return function evaluate(S) {
    let V = 0;
    let W = 0;
    nbl.fill(0);
    const live = S.live;
    for (let i = 0; i < live.length; i++) {
      const b = live[i];
      const mean = (G.pre[b.s + b.len] - G.pre[b.s]) / b.len;
      const lenMin = b.len * CELL_MIN;
      const fit = 1 / (1 + mismatch(load[b.t], mean));
      V += lenMin * w[b.t] * fit - lam[b.t] * lenMin * ((b.s * CELL_MIN) / 1440);
      W += lenMin * w[b.t];
      nbl[b.t]++;
    }
    for (let t = 0; t < nT; t++) if (nbl[t] > minBlocks[t]) V -= FRAG_PENALTY * (nbl[t] - minBlocks[t]);
    // voisinages + plafond de travail profond : un seul balayage des cellules disponibles
    deep.fill(0);
    let lastId = -1; let lastEnd = -1; let lastDay = -1; let lastT = -1;
    const occ = S.occ;
    for (let r = 0; r < G.runs.length; r++) {
      const run = G.runs[r];
      for (let c = run[0]; c < run[1]; c++) {
        const id = occ[c];
        if (id < 0) continue;
        const bt = S.byId[id].t;
        if (id !== lastId) {
          if (lastId >= 0 && G.dayOf[c] === lastDay && c - lastEnd <= G.adj) V += pair[lastT * (nT + 1) + bt];
          lastId = id; lastT = bt;
        }
        lastDay = G.dayOf[c]; lastEnd = c + 1;
        if (load[bt] >= 4) deep[lastDay]++;
      }
    }
    for (let d = 0; d < deep.length; d++) {
      const over = deep[d] * CELL_MIN - DEEP_CAP_MIN;
      if (over > 0) V -= DEEP_PENALTY * over;
    }
    return { V, J: V + COMPLETION * W };
  };
}

// ───────────────────────── Construction (gloutonne / naïve) ─────────────────────────

function blockValue(G, ti, s, len) {
  const mean = (G.pre[s + len] - G.pre[s]) / len;
  const lenMin = len * CELL_MIN;
  return lenMin * ti.w / (1 + mismatch(ti.load, mean)) - ti.lam * lenMin * ((s * CELL_MIN) / 1440);
}

/** Cellules libres rendues inutilisables (trou < 25 min) de part et d'autre d'un bloc [c, c+len). */
function wasteCells(S, G, c, len) {
  const occ = S.occ;
  const lim = G.brk + MIN_USEFUL_C;
  let w = 0;
  let k = 0; let x = c - 1;
  while (x >= 0 && k < lim && occ[x] === -1) { k++; x--; }
  if (k < lim) { const u = x >= 0 && occ[x] >= 0 ? k - G.brk : k; if (u > 0 && u < MIN_USEFUL_C) w += u; }
  k = 0; x = c + len;
  while (x < G.N && k < lim && occ[x] === -1) { k++; x++; }
  if (k < lim) { const u = x < G.N && occ[x] >= 0 ? k - G.brk : k; if (u > 0 && u < MIN_USEFUL_C) w += u; }
  return w;
}

/** Meilleure (mode "best") ou première (mode "first") position valide pour un bloc de `len` cellules. */
function findPosition(S, G, ti, len, mode) {
  let bestS = -1;
  let bestV = -Infinity;
  const occ = S.occ;
  for (let r = 0; r < G.runs.length; r++) {
    const re = G.runs[r][1];
    let c = Math.max(G.runs[r][0], ti.earliestC);
    while (c + len <= re) {
      if (c + len > ti.endC) return bestS < 0 ? null : bestS;
      let bad = -1;
      for (let i = len - 1; i >= 0; i--) if (occ[c + i] !== -1) { bad = c + i; break; }
      if (bad >= 0) { c = bad + 1; continue; }
      if (canPlace(S, G, ti, c, len)) {
        if (mode === 'first') return c;
        const v = blockValue(G, ti, c, len) - WASTE_COST * CELL_MIN * wasteCells(S, G, c, len);
        if (v > bestV + 1e-9) { bestV = v; bestS = c; }
      }
      c++;
    }
  }
  return bestS < 0 ? null : bestS;
}

/** Taille du prochain bloc : équilibrée (ex. 150 min → 75 + 75 si le bloc max est 120). */
function chunkLen(ti, R) {
  if (!ti.splittable) return R;
  const k = Math.ceil(R / ti.maxC);
  return Math.min(ti.maxC, Math.ceil(R / k));
}

/**
 * Tailles de bloc admissibles (en cellules, décroissantes) pour un reliquat R : ni trop courtes
 * (≥ minC, sauf si c'est tout ce qui reste), ni plus longues que le bloc max, et sans laisser
 * un reliquat inférieur à minC.
 */
function validLens(ti, R) {
  if (!ti.splittable) return [R];
  const out = [];
  for (let l = Math.min(R, ti.maxC); l >= 1; l--) {
    if (l >= Math.min(ti.minC, R) && (R - l === 0 || R - l >= ti.minC)) out.push(l);
  }
  return out;
}

function placeTask(S, G, ti, mode) {
  let R = remaining(S, ti);
  while (R > 0) {
    const lens = validLens(ti, R);
    const pref = chunkLen(ti, R);
    if (lens.includes(pref)) lens.splice(lens.indexOf(pref), 1), lens.unshift(pref);
    let placed = false;
    for (const len of lens) {
      const s = findPosition(S, G, ti, len, mode);
      if (s == null) continue;
      const b = { id: S.nextId++, t: ti.i, s, len, fixed: false, pos: -1 };
      S.byId[b.id] = b;
      addRaw(S, b);
      R -= len;
      placed = true;
      break;
    }
    if (!placed) break;
  }
}

function orderTasks(T) {
  return [...T].sort((a, b) => a.effPrio - b.effPrio
    || (a.deadlineMs ?? Infinity) - (b.deadlineMs ?? Infinity)
    || b.load - a.load || b.durC - a.durC || a.i - b.i);
}

function naiveOrder(T) {
  return [...T].sort((a, b) => a.prio - b.prio
    || (a.deadlineMs ?? Infinity) - (b.deadlineMs ?? Infinity) || a.i - b.i);
}

// ───────────────────────── Recuit simulé ─────────────────────────

function anneal(S, G, T, evaluate, o, rand) {
  const nT = T.length;
  const randInt = (n) => Math.floor(rand() * n);
  let cur = evaluate(S).J;
  let bestJ = cur;
  const snap = () => snapshotOf(S);
  let best = snap();
  if (!o.iterations || !G.avail.length) return { best, bestJ };

  const pickBlock = () => {
    const n = S.live.length;
    for (let k = 0; k < 8; k++) {
      const b = S.live[randInt(n)];
      if (b && !b.fixed) return b;
    }
    return null;
  };
  // départ « malin » : tournoi sur l'alerte (tâche lourde → pics, tâche légère → creux)
  const smartStart = (ti, len) => {
    let cand = G.avail[randInt(G.avail.length)];
    if (ti.load >= 4 || ti.load <= 2) {
      for (let k = 0; k < 2; k++) {
        const c2 = G.avail[randInt(G.avail.length)];
        if (ti.load >= 4 ? G.alertCell[c2] > G.alertCell[cand] : G.alertCell[c2] < G.alertCell[cand]) cand = c2;
      }
    }
    const r = rand();
    if (r < 0.5) return cand - (len >> 1);
    if (r < 0.65) return cand;
    if (r < 0.8) return cand - len + 1;
    return rand() < 0.5 ? G.runStartOf[cand] : G.runEndOf[cand] - len;
  };
  const siblings = (b) => S.tb[b.t].filter((x) => x !== b && !x.fixed);
  const unplacedTasks = () => T.filter((ti) => remaining(S, ti) > 0);

  const mvShift = () => {
    const b = pickBlock(); if (!b) return false;
    const ti = T[b.t];
    jRemove(S, b);
    const s2 = rand() < 0.5 ? b.s + (rand() < 0.5 ? -1 : 1) * (1 + randInt(12)) : smartStart(ti, b.len);
    if (s2 === b.s || !canPlace(S, G, ti, s2, b.len)) return false;
    b.s = s2; jAdd(S, b);
    return true;
  };

  const mvSwap = () => {
    const b1 = pickBlock(); if (!b1) return false;
    let b2 = null;
    for (let k = 0; k < 6 && !b2; k++) { const c = pickBlock(); if (c && c.t !== b1.t) b2 = c; }
    if (!b2) return false;
    const t1 = T[b1.t]; const t2 = T[b2.t];
    const e1 = b1.s + b1.len; const e2 = b2.s + b2.len;
    const variants = rand() < 0.5
      ? [[b2.s, b1.s], [e2 - b1.len, e1 - b2.len]]
      : [[e2 - b1.len, e1 - b2.len], [b2.s, b1.s]];
    jRemove(S, b1); jRemove(S, b2);
    for (const [n1, n2] of variants) {
      if (n1 < 0 || n2 < 0) continue;
      if (!canPlace(S, G, t1, n1, b1.len)) continue;
      b1.s = n1; jAdd(S, b1);
      if (canPlace(S, G, t2, n2, b2.len)) { b2.s = n2; jAdd(S, b2); return true; }
      jRemove(S, b1);
    }
    return false;
  };

  const mvSplit = () => {
    const b = pickBlock(); if (!b) return false;
    const ti = T[b.t];
    if (!ti.splittable || b.len < 2 * ti.minC) return false;
    const k = ti.minC + randInt(b.len - 2 * ti.minC + 1);
    const rest = b.len - k;
    if (rest > ti.maxC) return false;
    jRemove(S, b);
    b.len = k; jAdd(S, b);
    const s2 = smartStart(ti, rest);
    if (!canPlace(S, G, ti, s2, rest)) return false;
    jNew(S, b.t, s2, rest);
    return true;
  };

  const mvMerge = () => {
    const b1 = pickBlock(); if (!b1) return false;
    const sib = siblings(b1); if (!sib.length) return false;
    const b2 = sib[randInt(sib.length)];
    const ti = T[b1.t];
    const total = b1.len + b2.len;
    if (total > ti.maxC) return false;
    const e1 = b1.s + b1.len; const e2 = b2.s + b2.len;
    const cands = [b1.s, b2.s, e1 - total, e2 - total];
    if (rand() < 0.5) cands.reverse();
    jRemove(S, b1); jRemove(S, b2);
    for (const s of cands) {
      if (s >= 0 && canPlace(S, G, ti, s, total)) { b1.s = s; b1.len = total; jAdd(S, b1); return true; }
    }
    return false;
  };

  const mvTransfer = () => {
    const b1 = pickBlock(); if (!b1) return false;
    const sib = siblings(b1); if (!sib.length) return false;
    const b2 = sib[randInt(sib.length)];
    const ti = T[b1.t];
    const k = 1 + randInt(6);
    if (b1.len - k < ti.minC || b2.len + k > ti.maxC) return false;
    jRemove(S, b1); jRemove(S, b2);
    b1.len -= k; jAdd(S, b1);
    const len2 = b2.len + k;
    for (const s of rand() < 0.5 ? [b2.s, b2.s - k] : [b2.s - k, b2.s]) {
      if (canPlace(S, G, ti, s, len2)) { b2.s = s; b2.len = len2; jAdd(S, b2); return true; }
    }
    return false;
  };

  const lenFor = (ti, R) => {
    const lens = validLens(ti, R);
    if (!lens.length) return null;
    return rand() < 0.7 ? lens[0] : lens[randInt(lens.length)];
  };

  const mvInsert = () => {
    const un = unplacedTasks(); if (!un.length) return false;
    const ti = un[randInt(un.length)];
    const len = lenFor(ti, remaining(S, ti));
    if (len == null) return false;
    const s = smartStart(ti, len);
    if (!canPlace(S, G, ti, s, len)) return false;
    jNew(S, ti.i, s, len);
    return true;
  };

  const mvReplace = () => {
    const un = unplacedTasks(); if (!un.length) return false;
    const u = un[randInt(un.length)];
    const b = pickBlock(); if (!b || b.t === u.i) return false;
    const e = b.s + b.len;
    jRemove(S, b);
    const len = lenFor(u, remaining(S, u));
    if (len == null) return false;
    for (const s of [b.s, e - len, smartStart(u, len)]) {
      if (canPlace(S, G, u, s, len)) { jNew(S, u.i, s, len); return true; }
    }
    return false;
  };

  const T0 = 10;
  const T1 = 0.25;
  for (let it = 0; it < o.iterations; it++) {
    const temp = T0 * Math.pow(T1 / T0, it / o.iterations);
    S.journal.length = 0;
    const r = rand();
    const hasUn = nT > 0 && T.some((ti) => remaining(S, ti) > 0);
    let ok;
    if (hasUn && r < 0.12) ok = mvInsert();
    else if (hasUn && r < 0.24) ok = mvReplace();
    else if (r < 0.60) ok = mvShift();
    else if (r < 0.82) ok = mvSwap();
    else if (r < 0.88) ok = mvSplit();
    else if (r < 0.94) ok = mvMerge();
    else ok = mvTransfer();
    if (!ok) { undoAll(S); continue; }
    const J = evaluate(S).J;
    const d = J - cur;
    if (d >= 0 || rand() < Math.exp(d / temp)) {
      cur = J;
      if (J > bestJ + 1e-9) { bestJ = J; best = snap(); }
    } else undoAll(S);
  }
  S.journal.length = 0;
  return { best, bestJ };
}

const snapshotOf = (S) => S.live.filter((b) => !b.fixed).map((b) => [b.t, b.s, b.len]);

/** Reconstruit un état à partir d'un instantané [[t, s, len], …] (+ blocs verrouillés). */
function stateFrom(G, T, locked, snapshot) {
  const S = makeState(G, T, locked);
  for (const [t, s, len] of snapshot) {
    const b = { id: S.nextId++, t, s, len, fixed: false, pos: -1 };
    S.byId[b.id] = b;
    addRaw(S, b);
  }
  return S;
}

// ───────────────────────── Résultat ─────────────────────────

function unplacedWhy(ti, S, G, S0) {
  const R = remaining(S, ti);
  const placedMin = (ti.durC - S.fixedC[ti.i] - R) * CELL_MIN;
  const prefix = placedMin > 0 ? `Placée en partie (${fmtDuration(placedMin)} sur ${fmtDuration(ti.durC * CELL_MIN)}) : ` : '';
  const free = S0.availPre;
  const lo = Math.min(ti.earliestC, G.N);
  const hi = Math.max(lo, Math.min(ti.endC, G.N));
  const cap = free[hi] - free[lo];
  const missing = Math.max(0, R - cap) * CELL_MIN;
  let why;
  if (ti.deadlineMs != null && ti.endC <= 0) {
    why = 'L\'échéance est déjà passée ou n\'offre aucun créneau';
  } else if (!G.avail.length) {
    why = 'Aucune plage de travail libre sur l\'horizon';
  } else if (ti.earliestC >= G.N) {
    why = 'Ne peut pas commencer avant le début autorisé : hors de l\'horizon planifié';
  } else if (cap < R) {
    why = ti.deadlineMs != null
      ? `Pas assez de créneaux avant l'échéance (il manque ${fmtDuration(missing)})`
      : `Pas assez de créneaux libres sur l'horizon (il manque ${fmtDuration(missing)})`;
  } else if (!ti.splittable && S0.longestRun(lo, hi) < R) {
    why = `Aucun créneau continu de ${fmtDuration(R * CELL_MIN)} disponible (le plus long : ${fmtDuration(S0.longestRun(lo, hi) * CELL_MIN)}) — autoriser le découpage aiderait`;
  } else {
    why = ti.deadlineMs != null
      ? 'Les créneaux avant l\'échéance sont pris par des tâches plus prioritaires'
      : 'Les créneaux disponibles sont pris par des tâches plus prioritaires';
  }
  return prefix + why;
}

function makeAvailability(S0) {
  const occ = S0.occ;
  const N = occ.length;
  const availPre = new Int32Array(N + 1);
  for (let c = 0; c < N; c++) availPre[c + 1] = availPre[c] + (occ[c] === -1 ? 1 : 0);
  return {
    availPre,
    longestRun(lo, hi) {
      let best = 0; let cur = 0;
      for (let c = lo; c < hi; c++) { cur = occ[c] === -1 ? cur + 1 : 0; if (cur > best) best = cur; }
      return best;
    },
  };
}

function assemble(S, G, T, lockedAll, curve, taskById) {
  const out = [];
  const live = S.live.filter((b) => !b.fixed);
  for (const b of live) {
    const startMs = G.base + b.s * CELL;
    const endMs = startMs + b.len * CELL;
    out.push({ taskId: T[b.t].id, startMs, endMs });
  }
  for (const lb of lockedAll) out.push({ ...lb, locked: true });
  out.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  // numérotation des blocs d'une même tâche ; reason + score par bloc
  const count = new Map();
  for (const b of out) count.set(b.taskId, (count.get(b.taskId) || 0) + 1);
  const seen = new Map();
  for (const b of out) {
    const task = taskById.get(b.taskId);
    const alert = meanAlertMs(curve, b.startMs, b.endMs);
    const fit = fitScore(task?.load ?? 3, alert);
    const part = (seen.get(b.taskId) || 0) + 1;
    seen.set(b.taskId, part);
    b.part = part; b.parts = count.get(b.taskId);
    b.alert = Math.round(alert * 10) / 10;
    b.fit = Math.round(fit * 1000) / 1000;
    b.score = Math.round(fit * 100);
    if (!b.locked || !b.reason) b.reason = explainBlock(b, task, curve);
  }
  return out;
}

// ───────────────────────── API principale ─────────────────────────

/**
 * Place les tâches dans les créneaux libres pour maximiser l'adéquation charge ↔ alerte.
 * Voir ARCHITECTURE.md pour le contrat ; champs ajoutés : block.alert/fit/part/parts,
 * unplaced[].minutes, result.meta.
 */
export function schedule({
  tasks = [], events = [], curve, nowMs, horizonEndMs, profile = {}, locked = [], options = {},
} = {}) {
  const o = normaliseOptions(options);
  const empty = { blocks: [], unplaced: [], score: 0, baselineScore: 0, stats: { placedMin: 0, unplacedMin: 0, meanFit: 0, lift: 0 } };
  if (!curve || !curve.alert || !curve.alert.length || !Number.isFinite(nowMs) || !Number.isFinite(horizonEndMs)) {
    const act = activeTasks(tasks);
    return { ...empty, unplaced: act.map((t) => ({ taskId: t.id, why: 'Prévision d\'énergie indisponible : impossible de planifier', minutes: t.durMin })), stats: { ...empty.stats, unplacedMin: act.reduce((s, t) => s + t.durMin, 0) } };
  }
  const G = buildGrid({ events, curve, nowMs, horizonEndMs, profile, options: o });
  const T = buildTaskInfos(tasks, G, o, nowMs);
  const taskById = new Map((tasks || []).map((t) => [t.id, t]));
  const lockedAll = (locked || []).filter((b) => b && Number.isFinite(b.startMs) && Number.isFinite(b.endMs) && b.endMs > b.startMs && taskById.get(b.taskId)?.done !== true)
    .map((b) => ({ ...b }));
  const evaluate = makeEvaluator(G, T);
  const rand = rng(o.seed);

  // 1) planification naïve (référence) : ordre de priorité, premier créneau disponible
  const Sbase = makeState(G, T, lockedAll);
  const S0avail = makeAvailability(makeState(G, T, lockedAll)); // disponibilité initiale (après blocs verrouillés), pour les explications
  for (const ti of naiveOrder(T)) placeTask(Sbase, G, ti, 'first');
  const base = evaluate(Sbase);

  // 2) deux chaînes de recuit : l'une part de la construction gloutonne (meilleure adéquation),
  //    l'autre de la planification naïve (meilleur tassement quand la charge dépasse la capacité)
  const SA = makeState(G, T, lockedAll);
  for (const ti of orderTasks(T)) placeTask(SA, G, ti, 'best');
  const SB = stateFrom(G, T, lockedAll, snapshotOf(Sbase));
  const effort = { ...o, iterations: o.iterations * EFFORT };
  let Sfin = Sbase; let fin = base; let useBase = true;
  for (const S of [SA, SB]) {
    const { best } = anneal(S, G, T, evaluate, effort, rand);
    const cand = stateFrom(G, T, lockedAll, best);
    const ev = evaluate(cand);
    // on ne renvoie jamais pire que la planification naïve (ni qu'une chaîne précédente)
    if (ev.J > fin.J + 1e-9) { Sfin = cand; fin = ev; useBase = false; }
  }

  const blocks = assemble(Sfin, G, T, lockedAll, curve, taskById);
  const unplaced = [];
  let unplacedMin = 0;
  for (const ti of T) {
    const R = remaining(Sfin, ti);
    if (R > 0) {
      unplacedMin += R * CELL_MIN;
      unplaced.push({ taskId: ti.id, why: unplacedWhy(ti, Sfin, G, S0avail), minutes: R * CELL_MIN });
    }
  }
  let placedMin = 0; let fitSum = 0;
  for (const b of blocks) {
    const m = (b.endMs - b.startMs) / MIN;
    placedMin += m; fitSum += m * b.fit;
  }
  const score = Math.round(fin.V * 100) / 100;
  const baselineScore = Math.round(base.V * 100) / 100;
  return {
    blocks, unplaced, score, baselineScore,
    stats: {
      placedMin, unplacedMin,
      meanFit: placedMin ? Math.round((fitSum / placedMin) * 1000) / 1000 : 0,
      lift: baselineScore > 0 ? Math.round((score / baselineScore - 1) * 1000) / 1000 : 0,
    },
    meta: { seed: o.seed, iterations: o.iterations, usedBaseline: useBase, cells: G.N },
  };
}

// ───────────────────────── Aperçu d'un déplacement (glisser-déposer) ─────────────────────────

/**
 * Valide le déplacement d'un bloc vers `newStartMs` (arrondi à 5 min).
 * ctx = { tasks, events, curve, nowMs, horizonEndMs, profile, blocks (plan courant), locked?, options?, allowLocked? }
 * → { ok, why?, score, alert, fit, startMs, endMs, reason?, deltaScore? }
 * `score` = adéquation (0..100) du nouveau créneau, même si le déplacement est refusé.
 */
export function validateMove(block, newStartMs, ctx = {}) {
  const o = normaliseOptions(ctx.options);
  const dur = block.endMs - block.startMs;
  const startMs = Math.round(newStartMs / CELL) * CELL;
  const endMs = startMs + dur;
  const task = (ctx.tasks || []).find((t) => t.id === block.taskId);
  const curve = ctx.curve;
  const withScore = (res) => {
    if (curve?.alert?.length) {
      const alert = meanAlertMs(curve, startMs, endMs);
      const fit = fitScore(task?.load ?? 3, alert);
      const oldFit = fitScore(task?.load ?? 3, meanAlertMs(curve, block.startMs, block.endMs));
      Object.assign(res, {
        score: Math.round(fit * 100), alert: Math.round(alert * 10) / 10, fit: Math.round(fit * 1000) / 1000,
        deltaScore: Math.round((fit - oldFit) * 100),
      });
      if (res.ok) res.reason = explainBlock({ ...block, startMs, endMs }, task, curve);
    } else res.score = 0;
    return { startMs, endMs, ...res };
  };
  const refuse = (why) => withScore({ ok: false, why });

  if (block.locked && !ctx.allowLocked) return refuse('Ce bloc est verrouillé : déverrouille-le avant de le déplacer');
  if (startMs < ceil5(ctx.nowMs)) return refuse('Ce créneau est déjà passé');
  if (endMs > ctx.horizonEndMs) return refuse('Au-delà de l\'horizon planifié');
  if (curve?.alert?.length) {
    const cEnd = curve.t0 + (curve.alert.length - 1) * curveStepMs(curve);
    if (startMs < curve.t0 || endMs > cEnd) return refuse('Pas de prévision d\'énergie à cet endroit');
  }
  if (task?.earliestMs != null && startMs < task.earliestMs) return refuse(`Trop tôt : cette tâche ne peut pas commencer avant ${fmtDateFR(task.earliestMs, { short: true })} ${fmtTime(task.earliestMs)}`);
  if (task?.deadlineMs != null && endMs > task.deadlineMs) return refuse(`Dépasse l'échéance (${fmtDateFR(task.deadlineMs, { short: true })} ${fmtTime(task.deadlineMs)})`);

  // plages de travail (déjeuner inclus ou non selon l'option) et événements
  const wins = workWindows(ctx.profile, startMs - DAY, endMs + DAY, o.protectLunch);
  if (!wins.some((w) => w.startMs <= startMs && endMs <= w.endMs)) {
    if (o.protectLunch && workWindows(ctx.profile, startMs - DAY, endMs + DAY, false).some((w) => w.startMs <= startMs && endMs <= w.endMs)) {
      return refuse('Chevauche le déjeuner protégé (12:00–13:30)');
    }
    const p = normaliseProfile(ctx.profile);
    const dow = new Date(startMs).getDay();
    if (!p.workDays.includes(dow)) return refuse('Ce jour n\'est pas un jour de travail');
    return refuse('En dehors de tes plages de travail');
  }
  for (const e of timedEvents(ctx.events)) {
    if (startMs < e.endMs && e.startMs < endMs) return refuse(`Chevauche « ${e.title || 'un événement'} »`);
  }
  const others = [...(ctx.blocks || []), ...(ctx.locked || [])]
    .filter((b) => b && !(b.taskId === block.taskId && b.startMs === block.startMs && b.endMs === block.endMs));
  const brkMs = o.breakMin * MIN;
  for (const b of others) {
    if (startMs < b.endMs && b.startMs < endMs) return refuse('Chevauche un autre bloc du plan');
    const gap = b.endMs <= startMs ? startMs - b.endMs : b.startMs - endMs;
    if (gap < brkMs && gap >= 0) {
      const [ga, gb] = b.endMs <= startMs ? [b.endMs, startMs] : [endMs, b.startMs];
      const interrupted = timedEvents(ctx.events).some((e) => e.startMs < gb && ga < e.endMs)
        || !wins.some((w) => w.startMs <= ga && gb <= w.endMs);
      if (!interrupted) return refuse(`Laisse au moins ${o.breakMin} min de pause avec le bloc voisin`);
    }
  }
  return withScore({ ok: true });
}
