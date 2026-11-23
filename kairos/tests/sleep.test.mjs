// Tests du sommeil : épisodes, dette, coucher en cycles, sieste, chronotype.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEpisodes, sleepDebt, suggestBedtime, planNap, chronotypeEstimate, CYCLE_MIN, SLEEP_LATENCY_MIN,
} from '../site/js/core/sleep.js';
import { buildModel } from '../site/js/core/model.js';
import { HOUR, DAY, MIN } from '../site/js/core/time.js';

const profile = { usualWake: '07:00', usualBed: '23:00', sleepNeedH: 8, workDays: [1, 2, 3, 4, 5] };
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

function nights(from, to, bedH, wakeH, { bedNext = false } = {}) {
  const out = [];
  for (let d = from; d <= to; d++) {
    const bed = bedNext ? at(d + 1, bedH) : at(d, bedH);
    out.push({ id: `n${d}`, bedMs: bedH >= 12 ? at(d - 1, bedH) : at(d, bedH), wakeMs: at(d, wakeH) });
    void bed;
  }
  return out;
}

test('épisodes : nuits supposées conformes au profil, triées, sans chevauchement', () => {
  const eps = buildEpisodes({ sleeps: [], profile, fromMs: at(24, 0), toMs: at(27, 0) });
  assert.ok(eps.length >= 3);
  for (let i = 0; i < eps.length; i++) {
    assert.equal(eps[i].src, 'assumed');
    assert.equal((eps[i].endMs - eps[i].startMs) / HOUR, 8);
    if (i) assert.ok(eps[i].startMs >= eps[i - 1].endMs);
  }
  assert.ok(eps.some((e) => e.startMs === at(24, 23)));
});

test('épisodes : un journal remplace la nuit supposée correspondante', () => {
  const log = { bedMs: at(24, 2), wakeMs: at(24, 6), id: 'x' };
  const eps = buildEpisodes({ sleeps: [log], profile, fromMs: at(24, 0), toMs: at(26, 0) });
  const around = eps.filter((e) => e.endMs > at(23, 20) && e.startMs < at(24, 12));
  assert.equal(around.length, 1);
  assert.equal(around[0].src, 'real');
  assert.equal(around[0].startMs, at(24, 2));
});

test('épisodes : un scénario (extra) l\'emporte sur le réel', () => {
  const real = { bedMs: at(24, 0), wakeMs: at(24, 7) };
  const extra = [{ bedMs: at(24, 3), wakeMs: at(24, 6) }];
  const eps = buildEpisodes({ sleeps: [real], extra, profile, fromMs: at(24, 0), toMs: at(25, 0) });
  const e = eps.find((x) => x.startMs === at(24, 3));
  assert.ok(e && e.src === 'whatif');
  assert.ok(!eps.some((x) => x.src === 'real' && x.startMs === real.bedMs));
});

test('épisodes : une sieste n\'écrase pas la nuit supposée', () => {
  const nap = { bedMs: at(24, 14), wakeMs: at(24, 14, 20), nap: true };
  const eps = buildEpisodes({ sleeps: [nap], profile, fromMs: at(24, 0), toMs: at(25, 12) });
  assert.ok(eps.some((e) => e.nap && e.startMs === nap.bedMs));
  assert.ok(eps.some((e) => !e.nap && e.startMs === at(24, 23)));
});

test('dette : nulle avec l\'horaire habituel de 8 h', () => {
  const r = sleepDebt([], profile, at(24, 12));
  assert.ok(Math.abs(r.debtH) < 1e-9);
  assert.equal(r.perNight.length, 14);
});

test('dette : croît avec le déficit, pondère les nuits récentes, créditée à moitié en cas d\'excédent', () => {
  const short = (n, h) => {
    const out = [];
    for (let d = 24 - n + 1; d <= 24; d++) out.push({ bedMs: at(d, 7) - h * HOUR, wakeMs: at(d, 7) });
    return out;
  };
  const d1 = sleepDebt(short(1, 5), profile, at(24, 12)).debtH;
  const d3 = sleepDebt(short(3, 5), profile, at(24, 12)).debtH;
  const d7 = sleepDebt(short(7, 5), profile, at(24, 12)).debtH;
  assert.ok(Math.abs(d1 - 3) < 0.05, `1 nuit de 5 h → ≈ 3 h (${d1})`);
  assert.ok(d3 > d1 && d7 > d3);
  // récent pèse plus qu'ancien
  const recent = sleepDebt([{ bedMs: at(24, 7) - 4 * HOUR, wakeMs: at(24, 7) }], profile, at(24, 12)).debtH;
  const old = sleepDebt([{ bedMs: at(17, 7) - 4 * HOUR, wakeMs: at(17, 7) }], profile, at(24, 12)).debtH;
  assert.ok(recent > old * 1.5);
  // un excédent n'efface qu'à moitié
  const long = [{ bedMs: at(24, 7) - 10 * HOUR, wakeMs: at(24, 7) }];
  const mixed = sleepDebt([...short(2, 5).slice(0, 1), ...long], profile, at(24, 12));
  assert.ok(mixed.debtH >= 0);
});

test('dette : le besoin personnel compte', () => {
  const logs = [{ bedMs: at(24, 7) - 7 * HOUR, wakeMs: at(24, 7) }];
  assert.ok(sleepDebt(logs, { ...profile, sleepNeedH: 9 }, at(24, 12)).debtH > sleepDebt(logs, { ...profile, sleepNeedH: 7 }, at(24, 12)).debtH);
  assert.ok(sleepDebt(logs, { ...profile, sleepNeedH: 7 }, at(24, 12)).debtH < 1e-9);
});

test('dette du modèle = sleepDebt() (même source de vérité)', () => {
  const logs = [{ bedMs: at(24, 1), wakeMs: at(24, 6) }, { bedMs: at(23, 0), wakeMs: at(23, 6) }];
  const m = buildModel({ profile, sleeps: logs, caffeine: [], fromMs: at(24, 0), hours: 24, nowMs: at(24, 12) });
  assert.ok(Math.abs(m.stats.sleepDebtH - sleepDebt(logs, profile, at(24, 12)).debtH) < 1e-9);
});

test('coucher en cycles de 90 min + latence de 15 min', () => {
  const wakeMs = at(25, 7);
  const r = suggestBedtime({ wakeMs, profile, nowMs: at(24, 18) });
  assert.equal(r.cycles, 5);
  assert.equal(r.durationMin, 5 * CYCLE_MIN);
  assert.equal(wakeMs - r.bedMs, (5 * CYCLE_MIN + SLEEP_LATENCY_MIN) * MIN);
  assert.equal(r.bedMs, at(24, 23, 15));
  assert.ok(r.feasible);
  assert.ok(r.alternatives.length >= 2);
  assert.ok(r.alternatives.some((a) => a.cycles === 4) && r.alternatives.some((a) => a.cycles === 6));
  for (const a of r.alternatives) assert.equal(wakeMs - a.bedMs, (a.cycles * CYCLE_MIN + SLEEP_LATENCY_MIN) * MIN);
});

test('coucher : un grand besoin pousse à 6 cycles ; trop tard → on le dit', () => {
  assert.equal(suggestBedtime({ wakeMs: at(25, 7), profile: { ...profile, sleepNeedH: 9 }, nowMs: at(24, 18) }).cycles, 6);
  const late = suggestBedtime({ wakeMs: at(25, 7), profile, nowMs: at(25, 3) });
  assert.equal(late.feasible, false);
  assert.ok(late.cycles <= 2 && late.bedMs >= at(25, 3));
  assert.match(late.why, /tard/);
});

test('sieste : courte, dans le creux, ≥ 8 h avant le coucher, après le réveil + 4 h', () => {
  const m = buildModel({ profile, sleeps: [], caffeine: [], fromMs: at(24, 0), hours: 48, nowMs: at(24, 9) });
  const nap = planNap({ model: m, nowMs: at(24, 9) });
  assert.ok(nap);
  assert.equal(nap.durMin, 20);
  assert.ok(nap.startMs >= at(24, 11) && nap.startMs <= at(24, 15), `sieste à ${new Date(nap.startMs)}`);
  assert.ok(at(24, 23) - nap.endMs >= 7.5 * HOUR);
  assert.equal(nap.endMs - nap.startMs, 20 * MIN);
  assert.ok(nap.why.length > 20);
});

test('sieste : 90 min si grosse dette, rien si on dort ou s\'il est trop tard', () => {
  const debtLogs = [];
  for (let d = 18; d <= 24; d++) debtLogs.push({ bedMs: at(d, 6) - 4 * HOUR, wakeMs: at(d, 6) });
  const m = buildModel({ profile, sleeps: debtLogs, caffeine: [], fromMs: at(24, 0), hours: 48, nowMs: at(24, 8) });
  assert.ok(m.stats.sleepDebtH >= 3);
  const nap = planNap({ model: m, nowMs: at(24, 8) });
  assert.ok(nap && nap.durMin === 90);
  const m2 = buildModel({ profile, sleeps: [], caffeine: [], fromMs: at(24, 0), hours: 48, nowMs: at(24, 3) });
  assert.equal(planNap({ model: m2, nowMs: at(24, 3) }), null); // endormi
  assert.equal(planNap({ model: m2, nowMs: at(24, 20) }), null); // trop tard
});

test('chronotype : alouette, intermédiaire, chouette ; confiance croissante', () => {
  const mk = (bedH, wakeH, days, freeBedH, freeWakeH) => {
    const out = [];
    for (const d of days) {
      const dow = new Date(2026, 10, d).getDay();
      const free = dow === 0 || dow === 6;
      const bH = free ? freeBedH : bedH; const wH = free ? freeWakeH : wakeH;
      out.push({ bedMs: bH >= 12 ? at(d - 1, bH) : at(d, bH), wakeMs: at(d, wH) });
    }
    return out;
  };
  const days = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const lark = chronotypeEstimate(mk(21.5, 5.5, days(2, 22), 21.5, 6), profile);
  const mid = chronotypeEstimate(mk(23.5, 7, days(2, 22), 0.5, 8.5), profile);
  const owl = chronotypeEstimate(mk(2, 9.5, days(2, 22), 3.5, 11.5), profile);
  assert.equal(lark.label, 'alouette');
  assert.equal(mid.label, 'intermédiaire');
  assert.equal(owl.label, 'chouette');
  assert.ok(lark.msfscMin < mid.msfscMin && mid.msfscMin < owl.msfscMin);
  const few = chronotypeEstimate(mk(23.5, 7, days(2, 6), 0.5, 8.5).slice(0, 3), profile);
  assert.ok(few.confidence < mid.confidence);
  assert.ok(mid.confidence > 0.7 && mid.confidence <= 1);
});

test('chronotype : correction MSFsc des week-ends qui rattrapent du sommeil', () => {
  // semaine 23:30-06:30 (7 h), week-end 23:30-09:30 (10 h) : la dette rattrapée décale MSF vers le tôt.
  const logs = [];
  for (let d = 2; d <= 22; d++) {
    const dow = new Date(2026, 10, d).getDay();
    const free = dow === 0 || dow === 6;
    logs.push({ bedMs: at(d - 1, 23, 30), wakeMs: at(d, free ? 9 : 6, free ? 30 : 30) });
  }
  const r = chronotypeEstimate(logs, profile);
  assert.ok(r.msfscMin < r.msfMin - 20, `${r.msfscMin} vs ${r.msfMin}`);
  assert.ok(r.socialJetlagMin > 60);
});

test('chronotype : pas de données → inconnu, confiance 0 ; siestes ignorées', () => {
  assert.deepEqual(chronotypeEstimate([]).label, 'inconnu');
  assert.equal(chronotypeEstimate([]).confidence, 0);
  assert.equal(chronotypeEstimate([{ bedMs: at(24, 14), wakeMs: at(24, 14, 20), nap: true }]).n, 0);
});
