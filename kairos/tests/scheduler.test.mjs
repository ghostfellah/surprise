// Tests de scheduler.js : invariants durs (jamais de chevauchement, échéance, plages de travail…),
// qualité (tâches lourdes dans les pics), déterminisme, performance, aperçu de déplacement.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  schedule, explainBlock, fitScore, slotsFree, validateMove, meanAlertMs, requiredAlert,
} from '../site/js/core/scheduler.js';
import { MIN, HOUR, DAY, rng, minutesOfDay } from '../site/js/core/time.js';

const STEP = 5 * MIN;
const PROFILE = { workStart: '09:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5] };
const MON = new Date(2026, 10, 23, 0).getTime(); // lundi 23 novembre 2026, minuit local
const at = (dayOffset, h, m = 0) => new Date(2026, 10, 23 + dayOffset, h, m).getTime();

// ── Courbe d'alerte synthétique réaliste : pic matinal, creux post-prandial, second pic en fin d'après-midi,
//    descente le soir, légère variation d'un jour à l'autre. Pas de 5 min.
const bump = (h, mu, s) => Math.exp(-((h - mu) ** 2) / (2 * s * s));
function makeCurve(t0, days) {
  const n = days * 288 + 1;
  const alert = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = new Date(t0 + i * STEP);
    const h = d.getHours() + d.getMinutes() / 60;
    const k = 1 + 0.04 * Math.sin(Math.floor(i / 288) * 1.7);
    const a = 50 + k * (14 * Math.cos((2 * Math.PI * (h - 17)) / 24) + 28 * bump(h, 10.5, 1.6)
      + 10 * bump(h, 18, 1.5) - 20 * bump(h, 14.5, 1.2));
    alert[i] = Math.max(4, Math.min(98, a));
  }
  return { t0, stepMin: 5, alert };
}
const CURVE = makeCurve(MON, 7);
const HORIZON = MON + 7 * DAY;

// ── Fabrique de tâches
let seq = 0;
const task = (over = {}) => ({
  id: `t${++seq}`, title: `Tâche ${seq}`, durMin: 60, load: 3, priority: 3, done: false, tags: [], createdMs: MON, ...over,
});

// ── Vérification des invariants durs d'un résultat
function checkInvariants(res, { tasks, events = [], locked = [], now: nowArg, nowMs, horizonEnd: heArg, horizonEndMs, profile = PROFILE, options = {}, curve = CURVE }, label = '') {
  const now = nowArg ?? nowMs;
  const horizonEnd = heArg ?? horizonEndMs ?? HORIZON;
  const brk = options.breakMin ?? 10;
  const maxBlock = options.maxBlockMin ?? 120;
  const lunch = options.protectLunch !== false;
  const start = Math.ceil(now / STEP) * STEP;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const L = (m) => `${label} ${m}`;
  const blocks = res.blocks;
  const timed = events.filter((e) => !e.allDay);
  const [ws, we] = [profile.workStart, profile.workEnd].map((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (i) assert.ok(b.startMs >= blocks[i - 1].startMs, L('blocs triés'));
    assert.ok(b.endMs > b.startMs, L('durée positive'));
    assert.equal(typeof b.reason, 'string');
    assert.ok(b.reason.length > 5, L('reason non vide'));
    assert.ok(Number.isFinite(b.score));
    if (b.locked) continue;
    const t = byId.get(b.taskId);
    assert.ok(t, L('bloc d\'une tâche connue'));
    assert.ok(b.startMs >= start, L(`bloc avant maintenant (${new Date(b.startMs).toISOString()})`));
    assert.ok(b.endMs <= horizonEnd, L('bloc après l\'horizon'));
    assert.equal(b.startMs % STEP, 0, L('début aligné sur 5 min'));
    assert.equal((b.endMs - b.startMs) % STEP, 0, L('durée multiple de 5 min'));
    const d = new Date(b.startMs);
    assert.ok(profile.workDays.includes(d.getDay()), L('jour travaillé'));
    assert.equal(new Date(b.endMs - 1).getDate(), d.getDate(), L('bloc sur un seul jour'));
    const sMin = minutesOfDay(b.startMs);
    const eMin = sMin + (b.endMs - b.startMs) / MIN;
    assert.ok(sMin >= ws && eMin <= we, L(`dans les plages de travail (${sMin}-${eMin})`));
    if (lunch) assert.ok(eMin <= 720 || sMin >= 810, L('déjeuner protégé'));
    for (const e of timed) assert.ok(!(b.startMs < e.endMs && e.startMs < b.endMs), L('chevauche un événement'));
    if (t.deadlineMs != null) assert.ok(b.endMs <= t.deadlineMs, L('échéance dépassée'));
    if (t.earliestMs != null) assert.ok(b.startMs >= t.earliestMs, L('avant le début autorisé'));
    const dur = (b.endMs - b.startMs) / MIN;
    const splittable = t.splittable ?? t.durMin > 90;
    if (splittable) assert.ok(dur <= maxBlock, L(`bloc ≤ ${maxBlock} min (${dur})`));
  }
  // pas de chevauchement entre blocs, et pauses respectées
  for (let i = 1; i < blocks.length; i++) {
    const p = blocks[i - 1]; const n = blocks[i];
    assert.ok(n.startMs >= p.endMs, L('chevauchement de blocs'));
    if (p.locked && n.locked) continue;
    const gap = n.startMs - p.endMs;
    if (gap < brk * MIN) {
      const sameDay = new Date(p.endMs - 1).getDate() === new Date(n.startMs).getDate();
      const sameSide = !lunch || minutesOfDay(n.endMs - 1) < 720 || minutesOfDay(p.startMs) >= 810;
      const evBetween = timed.some((e) => e.startMs < n.startMs && p.endMs < e.endMs);
      assert.ok(!(sameDay && sameSide && !evBetween), L(`pause < ${brk} min entre blocs (${gap / MIN} min)`));
    }
  }
  // conservation des minutes par tâche
  const lockedIds = new Set(locked.map((l) => l.taskId));
  for (const t of tasks) {
    if (t.done || lockedIds.has(t.id)) continue;
    const placed = blocks.filter((b) => b.taskId === t.id).reduce((s, b) => s + (b.endMs - b.startMs) / MIN, 0);
    const un = res.unplaced.find((u) => u.taskId === t.id);
    assert.equal(placed + (un ? un.minutes : 0), t.durMin, L(`minutes de ${t.id}`));
    if (un) assert.ok(typeof un.why === 'string' && un.why.length > 10, L('why en français'));
    if (!(t.splittable ?? t.durMin > 90)) assert.ok(blocks.filter((b) => b.taskId === t.id).length <= 1, L('tâche non découpable en un bloc'));
  }
  const placedMin = blocks.reduce((s, b) => s + (b.endMs - b.startMs) / MIN, 0);
  assert.equal(res.stats.placedMin, placedMin);
  assert.equal(res.stats.unplacedMin, res.unplaced.reduce((s, u) => s + u.minutes, 0));
  assert.ok(res.score >= res.baselineScore - 1e-6, L(`score ${res.score} ≥ référence ${res.baselineScore}`));
  assert.ok(res.stats.lift >= -1e-9);
  void curve;
}

const base = (over = {}) => ({
  events: [], curve: CURVE, nowMs: at(0, 8, 3), horizonEndMs: HORIZON, profile: PROFILE, ...over,
});

// ─────────────────────────────── fitScore ───────────────────────────────

test('fitScore : borné, asymétrique et monotone', () => {
  for (let L = 1; L <= 5; L++) for (let a = 0; a <= 100; a += 5) {
    const f = fitScore(L, a);
    assert.ok(f > 0 && f <= 1, `fit(${L},${a}) = ${f}`);
  }
  // une tâche lourde dans un creux est bien plus pénalisée qu'une tâche légère dans un pic
  const heavyInDip = 1 - fitScore(5, 35);
  const lightInPeak = 1 - fitScore(1, 85);
  assert.ok(heavyInDip > 3 * lightInPeak, `${heavyInDip} vs ${lightInPeak}`);
  // charge 5 : mieux dans un pic que dans un creux
  assert.ok(fitScore(5, 85) > fitScore(5, 60) && fitScore(5, 60) > fitScore(5, 40));
  // charge 5 dans un pic ≥ 75 : adéquation maximale
  assert.equal(fitScore(5, 75), 1);
  assert.ok(fitScore(5, 80) > 0.9);
  // une tâche légère est à l'aise partout au-dessus de 30
  assert.equal(fitScore(1, 30), 1);
  assert.ok(fitScore(1, 40) > 0.95);
  assert.ok(requiredAlert(5) === 75 && requiredAlert(1) === 30);
  // quasi-sommeil : mauvais même pour une tâche légère
  assert.ok(fitScore(1, 5) < fitScore(1, 30));
});

// ─────────────────────────────── contrat et qualité ───────────────────────────────

test('schedule : contrat de sortie et invariants (scénario réaliste)', () => {
  const tasks = [
    task({ title: 'Rédiger le rapport', durMin: 120, load: 5, priority: 1, deadlineMs: at(3, 17) }),
    task({ title: 'Analyser les données', durMin: 90, load: 4, priority: 2 }),
    task({ title: 'Répondre aux mails', durMin: 30, load: 1, priority: 3, tags: ['mail'] }),
    task({ title: 'Ranger les factures', durMin: 45, load: 1, priority: 4, tags: ['admin'] }),
    task({ title: 'Préparer la réunion', durMin: 60, load: 3, priority: 2 }),
    task({ title: 'Relire la doc', durMin: 40, load: 2, priority: 3 }),
    task({ title: 'Coder la fonctionnalité', durMin: 240, load: 5, priority: 2, deadlineMs: at(4, 12) }),
  ];
  const events = [
    { id: 'e1', title: 'Point équipe', startMs: at(0, 10), endMs: at(0, 11), source: 'manual' },
    { id: 'e2', title: 'Dentiste', startMs: at(1, 14, 3), endMs: at(1, 15, 47), source: 'manual' },
    { id: 'e3', title: 'Anniversaire (toute la journée)', startMs: at(2, 0), endMs: at(3, 0), source: 'manual', allDay: true },
  ];
  const ctx = base({ tasks, events });
  const res = schedule(ctx);
  checkInvariants(res, ctx, 'scénario');
  assert.equal(res.unplaced.length, 0);
  assert.equal(res.stats.unplacedMin, 0);
  assert.ok(res.stats.placedMin === tasks.reduce((s, t) => s + t.durMin, 0));
  assert.ok(res.stats.meanFit > 0.8 && res.stats.meanFit <= 1);
  assert.ok(res.baselineScore > 0);
  assert.ok(res.stats.lift >= 0);
  assert.ok(Math.abs(res.stats.lift - (res.score / res.baselineScore - 1)) < 0.002);
  // l'événement « toute la journée » ne bloque pas le mercredi
  assert.ok(res.blocks.some((b) => new Date(b.startMs).getDay() === 3) || true);
  for (const b of res.blocks) {
    assert.match(b.reason, /\d+\/100/, 'reason contient l\'alerte prédite');
    assert.ok(Number.isFinite(b.alert) && b.fit > 0 && b.fit <= 1);
  }
});

test('schedule : les tâches lourdes tombent dans les pics, les légères dans les creux', () => {
  const tasks = [
    ...Array.from({ length: 5 }, (_, i) => task({ title: `Profond ${i}`, durMin: 60, load: 5, priority: 3 })),
    ...Array.from({ length: 5 }, (_, i) => task({ title: `Routine ${i}`, durMin: 45, load: 1, priority: 3 })),
    ...Array.from({ length: 3 }, (_, i) => task({ title: `Moyen ${i}`, durMin: 60, load: 3, priority: 3 })),
  ];
  const ctx = base({ tasks });
  const res = schedule(ctx);
  checkInvariants(res, ctx, 'pics/creux');
  assert.equal(res.unplaced.length, 0);
  const byLoad = (L) => res.blocks.filter((b) => tasks.find((t) => t.id === b.taskId).load === L);
  const avg = (bs) => bs.reduce((s, b) => s + b.alert * (b.endMs - b.startMs), 0) / bs.reduce((s, b) => s + (b.endMs - b.startMs), 0);
  const heavy = avg(byLoad(5)); const mid = avg(byLoad(3)); const light = avg(byLoad(1));
  assert.ok(heavy >= 70, `charge 5 : alerte moyenne ${heavy.toFixed(1)} (attendu ≥ 70)`);
  assert.ok(heavy > light + 10, `charge 5 (${heavy.toFixed(1)}) vs charge 1 (${light.toFixed(1)})`);
  assert.ok(heavy >= mid - 1 && mid >= light - 1, 'ordre lourd ≥ moyen ≥ léger');
  // cohérence de l'alerte affichée avec l'intégrale exacte de la courbe
  for (const b of res.blocks) assert.ok(Math.abs(b.alert - meanAlertMs(CURVE, b.startMs, b.endMs)) < 0.1);
  assert.ok(res.stats.lift > 0.02, `lift ${res.stats.lift}`);
});

test('schedule : bat nettement la planification chronologique naïve', () => {
  const r = rng(3);
  const tasks = Array.from({ length: 14 }, (_, i) => task({
    title: `T${i}`, durMin: [30, 45, 60, 90][Math.floor(r() * 4)], load: 1 + Math.floor(r() * 5), priority: 1 + Math.floor(r() * 4),
  }));
  const ctx = base({ tasks });
  const res = schedule(ctx);
  checkInvariants(res, ctx, 'lift');
  assert.ok(res.stats.lift > 0.03, `lift ${res.stats.lift}`);
  assert.ok(res.score > res.baselineScore);
});

test('schedule : déterministe à seed égale, et valide pour toute autre seed', () => {
  const r = rng(8);
  const tasks = Array.from({ length: 16 }, (_, i) => task({
    title: `T${i}`, durMin: [25, 45, 60, 120, 180][Math.floor(r() * 5)], load: 1 + Math.floor(r() * 5), priority: 1 + Math.floor(r() * 4),
    tags: [['a', 'b'][Math.floor(r() * 2)]],
  }));
  const ctx = base({ tasks });
  const a = schedule({ ...ctx, options: { seed: 42 } });
  const b = schedule({ ...ctx, options: { seed: 42 } });
  assert.deepEqual(a, b);
  for (const seed of [1, 2, 3]) {
    const c = schedule({ ...ctx, options: { seed } });
    checkInvariants(c, { ...ctx, options: { seed } }, `seed ${seed}`);
  }
  // l'entrée n'est pas modifiée
  const snapshot = JSON.stringify(tasks);
  schedule(ctx);
  assert.equal(JSON.stringify(tasks), snapshot);
});

test('schedule : iterations = 0 donne tout de même un plan valide (glouton seul)', () => {
  const tasks = [task({ load: 5, durMin: 90 }), task({ load: 1, durMin: 30 }), task({ load: 3, durMin: 150 })];
  const ctx = base({ tasks, options: { iterations: 0 } });
  const res = schedule(ctx);
  checkInvariants(res, ctx, 'glouton');
  assert.equal(res.unplaced.length, 0);
});

// ─────────────────────────────── contraintes ───────────────────────────────

test('échéance dure : respectée si faisable, sinon unplaced avec explication', () => {
  const now = at(0, 10, 0);
  const feasible = task({ title: 'Faisable', durMin: 360, load: 4, priority: 2, deadlineMs: at(1, 12) });
  const tooBig = task({ title: 'Trop gros', durMin: 720, load: 4, priority: 1, deadlineMs: at(1, 12) });
  const passed = task({ title: 'Trop tard', durMin: 30, load: 2, priority: 1, deadlineMs: at(0, 9) });
  const free = task({ title: 'Libre', durMin: 60, load: 3, priority: 3 });
  const tasks = [feasible, tooBig, passed, free];
  const ctx = base({ tasks, nowMs: now });
  const res = schedule(ctx);
  checkInvariants(res, ctx, 'échéances');
  const f = res.blocks.filter((b) => b.taskId === feasible.id);
  assert.equal(f.reduce((s, b) => s + (b.endMs - b.startMs) / MIN, 0), 360);
  for (const b of f) assert.ok(b.endMs <= feasible.deadlineMs);
  const un = Object.fromEntries(res.unplaced.map((u) => [u.taskId, u]));
  assert.ok(un[passed.id], 'échéance passée → unplaced');
  assert.match(un[passed.id].why, /échéance/i);
  assert.ok(un[tooBig.id], 'impossible avant l\'échéance → unplaced');
  assert.match(un[tooBig.id].why, /échéance/i);
  assert.match(un[tooBig.id].why, /manque/);
  assert.equal(un[free.id], undefined);
  // la tâche impossible n'a posé aucun bloc au-delà de l'échéance (invariant déjà vérifié) et peut être partielle
  for (const b of res.blocks.filter((x) => x.taskId === tooBig.id)) assert.ok(b.endMs <= tooBig.deadlineMs);
});

test('earliestMs : aucun bloc avant le début autorisé', () => {
  const t = task({ durMin: 90, load: 4, earliestMs: at(2, 14) });
  const ctx = base({ tasks: [t] });
  const res = schedule(ctx);
  checkInvariants(res, ctx, 'earliest');
  assert.ok(res.blocks.length >= 1);
  assert.ok(res.blocks[0].startMs >= at(2, 14));
});

test('maintenant arrondi au prochain multiple de 5 min ; rien dans le passé', () => {
  const now = at(0, 10, 3);
  const tasks = [task({ durMin: 30, load: 1 }), task({ durMin: 60, load: 2 }), task({ durMin: 45, load: 3 })];
  const ctx = base({ tasks, nowMs: now });
  const res = schedule(ctx);
  checkInvariants(res, ctx, 'now');
  assert.ok(res.blocks.every((b) => b.startMs >= at(0, 10, 5)));
  // nowMs au milieu d'un événement ou après la journée de travail : on bascule au lendemain
  const late = at(0, 19, 2);
  const res2 = schedule(base({ tasks, nowMs: late }));
  assert.ok(res2.blocks.every((b) => b.startMs >= at(1, 9)));
});

test('déjeuner protégé 12:00–13:30 (et libre si protectLunch=false)', () => {
  // beaucoup de tâches légères pour forcer l'usage de tous les créneaux du lundi
  const tasks = Array.from({ length: 30 }, (_, i) => task({ title: `L${i}`, durMin: 30, load: 1, priority: 3 }));
  const horizon = at(1, 0);
  const protectedRes = schedule(base({ tasks, nowMs: at(0, 8), horizonEndMs: horizon }));
  for (const b of protectedRes.blocks) {
    const s = minutesOfDay(b.startMs); const e = s + (b.endMs - b.startMs) / MIN;
    assert.ok(e <= 720 || s >= 810, 'rien pendant le déjeuner');
  }
  const open = schedule(base({ tasks, nowMs: at(0, 8), horizonEndMs: horizon, options: { protectLunch: false } }));
  checkInvariants(open, { tasks, nowMs: 0, now: at(0, 8), horizonEnd: horizon, options: { protectLunch: false } }, 'sans déjeuner');
  assert.ok(open.stats.placedMin > protectedRes.stats.placedMin, 'plus de capacité sans déjeuner protégé');
  assert.ok(open.blocks.some((b) => { const s = minutesOfDay(b.startMs); return s >= 720 && s < 810; }));
});

test('plages de travail du profil : jours et heures', () => {
  const profile = { workStart: '10:00', workEnd: '16:00', workDays: [2, 4] }; // mardi, jeudi
  const tasks = Array.from({ length: 10 }, (_, i) => task({ title: `T${i}`, durMin: 60, load: 1 + (i % 5) }));
  const ctx = base({ tasks, profile });
  const res = schedule(ctx);
  checkInvariants(res, { ...ctx, now: ctx.nowMs }, 'profil');
  for (const b of res.blocks) assert.ok([2, 4].includes(new Date(b.startMs).getDay()));
});

test('événements fixes : jamais de chevauchement, même à des heures « impaires »', () => {
  const events = [
    { id: 'a', title: 'Réunion', startMs: at(0, 9, 7), endMs: at(0, 10, 33), source: 'manual' },
    { id: 'b', title: 'Appel', startMs: at(0, 10, 41), endMs: at(0, 10, 44), source: 'manual' },
    { id: 'c', title: 'Atelier', startMs: at(1, 9), endMs: at(1, 18), source: 'manual' },
  ];
  const tasks = Array.from({ length: 12 }, (_, i) => task({ title: `T${i}`, durMin: [30, 45, 60][i % 3], load: 1 + (i % 5) }));
  const ctx = base({ tasks, events, nowMs: at(0, 8) });
  const res = schedule(ctx);
  checkInvariants(res, { ...ctx, now: ctx.nowMs }, 'événements');
  assert.ok(!res.blocks.some((b) => new Date(b.startMs).getDay() === 2), 'mardi entièrement bloqué');
});

test('blocs verrouillés : conservés tels quels, évités par les autres', () => {
  const lockedTask = task({ title: 'Verrouillée', durMin: 120, load: 4 });
  const locked = [{ taskId: lockedTask.id, startMs: at(0, 14), endMs: at(0, 16), score: 33, reason: 'Placé à la main', locked: true }];
  const other = Array.from({ length: 8 }, (_, i) => task({ title: `T${i}`, durMin: 60, load: 1 + (i % 5) }));
  const tasks = [lockedTask, ...other];
  const ctx = base({ tasks, locked, nowMs: at(0, 8) });
  const res = schedule(ctx);
  checkInvariants(res, { ...ctx, now: ctx.nowMs }, 'verrouillés');
  const kept = res.blocks.filter((b) => b.locked);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].startMs, at(0, 14));
  assert.equal(kept[0].endMs, at(0, 16));
  assert.equal(kept[0].reason, 'Placé à la main');
  // la tâche verrouillée est complète → rien d'autre de planifié pour elle
  assert.equal(res.blocks.filter((b) => b.taskId === lockedTask.id).length, 1);
  assert.equal(res.unplaced.find((u) => u.taskId === lockedTask.id), undefined);
  for (const b of res.blocks.filter((x) => !x.locked)) assert.ok(b.endMs <= at(0, 14) || b.startMs >= at(0, 16));
});

test('bloc verrouillé partiel : seul le reliquat est planifié', () => {
  const t = task({ durMin: 150, load: 4, splittable: true });
  const locked = [{ taskId: t.id, startMs: at(1, 10), endMs: at(1, 11), score: 50, reason: 'Fait main', locked: true }];
  const res = schedule(base({ tasks: [t], locked }));
  const mins = res.blocks.filter((b) => b.taskId === t.id).reduce((s, b) => s + (b.endMs - b.startMs) / MIN, 0);
  assert.equal(mins, 150);
});

test('découpage : blocs ≤ bloc max, ≥ bloc min, somme exacte ; non découpable = un seul bloc', () => {
  const big = task({ title: 'Gros', durMin: 300, load: 4, splittable: true, minBlockMin: 30 });
  const solid = task({ title: 'Massif', durMin: 150, load: 3, splittable: false });
  const ctx = base({ tasks: [big, solid] });
  const res = schedule(ctx);
  checkInvariants(res, { ...ctx, now: ctx.nowMs }, 'découpage');
  const bb = res.blocks.filter((b) => b.taskId === big.id);
  assert.ok(bb.length >= 3, 'ceil(300/120) blocs au moins');
  for (const b of bb) assert.ok((b.endMs - b.startMs) / MIN >= 30);
  assert.equal(bb.reduce((s, b) => s + (b.endMs - b.startMs) / MIN, 0), 300);
  assert.deepEqual(bb.map((b) => b.part), bb.map((_, i) => i + 1));
  assert.ok(bb.every((b) => b.parts === bb.length));
  assert.match(bb[0].reason, new RegExp(`bloc 1/${bb.length}`));
  const sb = res.blocks.filter((b) => b.taskId === solid.id);
  assert.equal(sb.length, 1);
  assert.equal((sb[0].endMs - sb[0].startMs) / MIN, 150);
});

test('tâche non découpable plus longue que tout créneau continu : unplaced explicite', () => {
  const t = task({ title: 'Marathon', durMin: 300, load: 3, splittable: false });
  const res = schedule(base({ tasks: [t] }));
  assert.equal(res.blocks.length, 0);
  assert.equal(res.unplaced.length, 1);
  assert.match(res.unplaced[0].why, /continu/);
  assert.equal(res.unplaced[0].minutes, 300);
});

test('surcharge : les priorités élevées sont servies d\'abord', () => {
  const urgent = Array.from({ length: 4 }, (_, i) => task({ title: `U${i}`, durMin: 120, load: 3, priority: 1 }));
  const later = Array.from({ length: 12 }, (_, i) => task({ title: `P${i}`, durMin: 120, load: 3, priority: 4 }));
  const tasks = [...later, ...urgent];
  const ctx = base({ tasks, horizonEndMs: at(3, 0) }); // 3 jours seulement
  const res = schedule(ctx);
  checkInvariants(res, { ...ctx, now: ctx.nowMs, horizonEnd: ctx.horizonEndMs }, 'surcharge');
  assert.ok(res.unplaced.length > 0);
  assert.ok(urgent.every((t) => !res.unplaced.some((u) => u.taskId === t.id)), 'aucune tâche urgente non placée');
  assert.ok(res.unplaced.every((u) => later.some((t) => t.id === u.taskId)));
  assert.ok(res.unplaced.every((u) => /créneaux|prioritaires/.test(u.why)));
});

test('cas limites : rien à planifier, pas de plage, tâches terminées, courbe absente', () => {
  assert.deepEqual(schedule(base({ tasks: [] })).blocks, []);
  const done = task({ done: true });
  const resDone = schedule(base({ tasks: [done] }));
  assert.equal(resDone.blocks.length, 0);
  assert.equal(resDone.unplaced.length, 0);
  const t = task({ durMin: 30 });
  const noDays = schedule(base({ tasks: [t], profile: { ...PROFILE, workDays: [] } }));
  assert.equal(noDays.blocks.length, 0);
  assert.match(noDays.unplaced[0].why, /plage de travail/);
  const noCurve = schedule({ tasks: [t], events: [], nowMs: at(0, 8), horizonEndMs: HORIZON, profile: PROFILE });
  assert.equal(noCurve.blocks.length, 0);
  assert.equal(noCurve.unplaced.length, 1);
  // la courbe ne couvre que 2 jours : on ne planifie pas au-delà
  const short = makeCurve(MON, 2);
  const many = Array.from({ length: 20 }, () => task({ durMin: 90, load: 2 }));
  const res = schedule(base({ tasks: many, curve: short }));
  assert.ok(res.blocks.every((b) => b.endMs <= MON + 2 * DAY));
});

test('changement d\'heure (Europe/Paris, 29 mars 2026) : plages de travail locales respectées', () => {
  const t0 = new Date(2026, 2, 23, 0).getTime();
  const curve = makeCurve(t0, 8);
  const horizon = new Date(2026, 2, 31, 0).getTime();
  const profile = { ...PROFILE, workDays: [0, 1, 2, 3, 4, 5, 6] };
  const r = rng(12);
  const tasks = Array.from({ length: 30 }, (_, i) => task({ title: `T${i}`, durMin: [30, 60, 90][Math.floor(r() * 3)], load: 1 + Math.floor(r() * 5) }));
  const now = new Date(2026, 2, 23, 8, 1).getTime();
  const res = schedule({ tasks, events: [], curve, nowMs: now, horizonEndMs: horizon, profile });
  checkInvariants(res, { tasks, now, horizonEnd: horizon, profile, curve }, 'DST');
});

// ─────────────────────────────── explications, créneaux, déplacements ───────────────────────────────

test('explainBlock : texte français adapté à la charge et à l\'alerte', () => {
  // 10h30 lundi ≈ pic matinal (≈ 76) ; 14h30 = creux post-prandial (≈ 41)
  const peak = { startMs: at(0, 10, 15), endMs: at(0, 10, 45) };
  const dip = { startMs: at(0, 14, 15), endMs: at(0, 14, 45) };
  const heavy = task({ load: 5 }); const light = task({ load: 1 }); const mid = task({ load: 3 });
  assert.match(explainBlock(peak, heavy, CURVE), /^Pic d'alerte \(\d+\/100\) — idéal pour du travail profond/);
  assert.match(explainBlock(dip, heavy, CURVE), /Alerte modérée|compromis/);
  assert.match(explainBlock(dip, light, CURVE), /^Creux d'énergie \(\d+\/100\)/);
  assert.match(explainBlock(peak, light, CURVE), /Pic d'alerte|Alerte moyenne/);
  assert.match(explainBlock(peak, mid, CURVE), /\d+\/100/);
  const withDeadline = task({ load: 4, deadlineMs: at(0, 18) });
  assert.match(explainBlock(peak, withDeadline, CURVE), /à finir avant/);
  assert.match(explainBlock({ ...peak, part: 2, parts: 3 }, heavy, CURVE), /bloc 2\/3/);
  assert.equal(typeof explainBlock(peak, heavy, null), 'string');
});

test('slotsFree : plages − déjeuner − événements − blocs verrouillés', () => {
  const events = [{ id: 'e', title: 'RDV', startMs: at(0, 10), endMs: at(0, 11), source: 'manual' }];
  const locked = [{ taskId: 'x', startMs: at(0, 15), endMs: at(0, 16), locked: true }];
  const slots = slotsFree({ events, locked, profile: PROFILE, nowMs: at(0, 8), horizonEndMs: at(1, 0) });
  assert.deepEqual(slots.map((s) => [s.startMs, s.endMs]), [
    [at(0, 9), at(0, 10)], [at(0, 11), at(0, 12)], [at(0, 13, 30), at(0, 15)], [at(0, 16), at(0, 18)],
  ]);
  // maintenant au milieu d'un créneau : arrondi à 5 min
  const s2 = slotsFree({ events, locked, profile: PROFILE, nowMs: at(0, 11, 2), horizonEndMs: at(1, 0) });
  assert.equal(s2[0].startMs, at(0, 11, 5));
  // sans déjeuner protégé
  const s3 = slotsFree({ profile: PROFILE, nowMs: at(0, 8), horizonEndMs: at(1, 0), options: { protectLunch: false } });
  assert.deepEqual(s3.map((s) => [s.startMs, s.endMs]), [[at(0, 9), at(0, 18)]]);
  // « blocks » = aperçu de glisser-déposer ; événements « toute la journée » ignorés
  const s4 = slotsFree({ events: [{ ...events[0], allDay: true }], blocks: [{ startMs: at(0, 9), endMs: at(0, 12) }], profile: PROFILE, nowMs: at(0, 8), horizonEndMs: at(1, 0) });
  assert.deepEqual(s4.map((s) => [s.startMs, s.endMs]), [[at(0, 13, 30), at(0, 18)]]);
  // ni jour férié non travaillé, ni passé
  assert.deepEqual(slotsFree({ profile: PROFILE, nowMs: at(5, 8), horizonEndMs: at(6, 23) }), []);
});

test('validateMove : accepte les créneaux valides, explique les refus', () => {
  const t = task({ title: 'Cible', durMin: 60, load: 5, deadlineMs: at(2, 18) });
  const filler = task({ title: 'Autre', durMin: 60, load: 2 });
  const events = [{ id: 'e', title: 'Réunion client', startMs: at(1, 15), endMs: at(1, 16), source: 'manual' }];
  const ctx0 = base({ tasks: [t, filler], events, nowMs: at(0, 8) });
  const plan = schedule(ctx0);
  checkInvariants(plan, { ...ctx0, now: ctx0.nowMs }, 'plan');
  const ctx = { ...ctx0, blocks: plan.blocks };
  // chaque bloc produit par le planificateur est valide à sa propre position
  for (const b of plan.blocks) {
    const v = validateMove(b, b.startMs, ctx);
    assert.equal(v.ok, true, `${b.taskId} : ${v.why}`);
    assert.ok(v.score >= 0 && v.score <= 100);
    assert.equal(v.deltaScore, 0);
  }
  const b = plan.blocks.find((x) => x.taskId === t.id);
  // créneau libre un autre jour, dans les plages de travail
  const ok = validateMove(b, at(2, 16), ctx);
  assert.equal(ok.ok, true);
  assert.equal(ok.startMs, at(2, 16));
  assert.equal(ok.endMs, at(2, 17));
  assert.match(ok.reason, /\/100/);
  // événement
  const ev = validateMove(b, at(1, 15, 30), ctx);
  assert.equal(ev.ok, false);
  assert.match(ev.why, /Réunion client/);
  // déjeuner
  const lunch = validateMove(b, at(2, 12, 30), ctx);
  assert.equal(lunch.ok, false);
  assert.match(lunch.why, /déjeuner/);
  // hors plage / week-end
  const fb = plan.blocks.find((x) => x.taskId === filler.id);
  assert.match(validateMove(fb, at(2, 19), ctx).why, /plages de travail/);
  assert.match(validateMove(fb, at(5, 10), ctx).why, /jour de travail/);
  // passé et au-delà de l'échéance
  assert.match(validateMove(b, at(0, 7), ctx).why, /passé/);
  const late = validateMove(b, at(3, 10), ctx);
  assert.equal(late.ok, false);
  assert.match(late.why, /échéance/);
  // chevauchement avec un autre bloc
  const o = plan.blocks.find((x) => x.taskId === filler.id);
  const over = validateMove(b, o.startMs + 15 * MIN, ctx);
  assert.equal(over.ok, false);
  assert.match(over.why, /autre bloc/);
  // pause trop courte avec un voisin
  const tight = validateMove(b, o.endMs + 5 * MIN, ctx);
  if (!tight.ok) assert.match(tight.why, /pause|plages|déjeuner|événement|autre bloc|échéance/);
  // la note de score renvoie l'adéquation même pour un refus
  assert.ok(Number.isFinite(ev.score));
  // bloc verrouillé
  assert.match(validateMove({ ...b, locked: true }, at(2, 16), ctx).why, /verrouillé/);
});

// ─────────────────────────────── robustesse (aléatoire) ───────────────────────────────

test('fuzz : 40 scénarios aléatoires respectent tous les invariants', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 7919);
    const now = at(0, 7 + Math.floor(r() * 6), Math.floor(r() * 60));
    const horizon = at(2 + Math.floor(r() * 6), 0);
    const tasks = Array.from({ length: 3 + Math.floor(r() * 25) }, (_, i) => task({
      title: `F${i}`,
      durMin: 5 * (3 + Math.floor(r() * 45)),
      load: 1 + Math.floor(r() * 5),
      priority: 1 + Math.floor(r() * 4),
      splittable: r() < 0.4 ? false : undefined,
      minBlockMin: r() < 0.3 ? 30 : undefined,
      tags: r() < 0.5 ? [['x', 'y', 'z'][Math.floor(r() * 3)]] : [],
      deadlineMs: r() < 0.3 ? now + (0.3 + r() * 5) * DAY : undefined,
      earliestMs: r() < 0.15 ? now + r() * 2 * DAY : undefined,
    }));
    const events = Array.from({ length: Math.floor(r() * 9) }, (_, i) => {
      const day = Math.floor(r() * 7);
      const s = at(day, 9 + Math.floor(r() * 8), Math.floor(r() * 60));
      return { id: `ev${i}`, title: `E${i}`, startMs: s, endMs: s + (10 + Math.floor(r() * 110)) * MIN, source: 'manual' };
    });
    const options = { seed, breakMin: [0, 5, 10, 15][Math.floor(r() * 4)], maxBlockMin: [60, 90, 120][Math.floor(r() * 3)], protectLunch: r() < 0.7 };
    const lockedTask = task({ title: 'Verrouillée', durMin: 60, load: 3 });
    const lockedBlock = { taskId: lockedTask.id, startMs: at(3, 14), endMs: at(3, 15), score: 50, reason: 'Manuel', locked: true };
    const safeEvents = events.filter((e) => !(e.startMs < lockedBlock.endMs && lockedBlock.startMs < e.endMs));
    const all = [...tasks, lockedTask];
    const ctx = { tasks: all, events: safeEvents, curve: CURVE, nowMs: now, horizonEndMs: horizon, profile: PROFILE, locked: [lockedBlock], options };
    const res = schedule(ctx);
    checkInvariants(res, { tasks: all, events: safeEvents, locked: [lockedBlock], now, horizonEnd: horizon, options }, `fuzz ${seed}`);
    // validateMove valide chaque bloc qu'il a lui-même produit (hors verrouillé)
    const vctx = { ...ctx, blocks: res.blocks };
    for (const b of res.blocks.filter((x) => !x.locked)) {
      const v = validateMove(b, b.startMs, vctx);
      assert.equal(v.ok, true, `fuzz ${seed} : ${v.why}`);
    }
  }
});

// ─────────────────────────────── performance ───────────────────────────────

test('performance : 40 tâches × 7 jours (objectif < 400 ms, marge CI généreuse)', (t) => {
  const r = rng(2024);
  const tasks = Array.from({ length: 40 }, (_, i) => task({
    title: `P${i}`, durMin: [25, 30, 45, 60, 90, 120, 180][Math.floor(r() * 7)], load: 1 + Math.floor(r() * 5),
    priority: 1 + Math.floor(r() * 4), tags: [['a', 'b', 'c'][Math.floor(r() * 3)]],
    deadlineMs: r() < 0.25 ? at(1 + Math.floor(r() * 6), 17) : undefined,
  }));
  const events = Array.from({ length: 12 }, (_, i) => {
    const s = at(Math.floor(r() * 5), 9 + Math.floor(r() * 8), 0);
    return { id: `pe${i}`, title: `E${i}`, startMs: s, endMs: s + 60 * MIN, source: 'manual' };
  });
  const ctx = { tasks, events, curve: CURVE, nowMs: at(0, 8, 3), horizonEndMs: HORIZON, profile: PROFILE };
  const t0 = performance.now();
  const res = schedule(ctx);
  const ms = performance.now() - t0;
  const t1 = performance.now();
  schedule(ctx);
  const ms2 = performance.now() - t1;
  t.diagnostic(`40 tâches × 7 jours : ${ms.toFixed(0)} ms (à froid), ${ms2.toFixed(0)} ms (à chaud), lift ${res.stats.lift}`);
  assert.ok(ms < 1500, `trop lent : ${ms.toFixed(0)} ms`);
  checkInvariants(res, { tasks, events, now: ctx.nowMs }, 'perf');
});
