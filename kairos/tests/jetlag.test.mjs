// Tests du décalage horaire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tzOffsetMin, planJetlag, zonedMidnight, zonedTime, prc, JET } from '../site/js/core/jetlag.js';
import { HOUR, DAY } from '../site/js/core/time.js';

const profile = { usualWake: '07:00', usualBed: '23:00', sleepNeedH: 8 };
const utc = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h);

test('tzOffsetMin : fuseaux connus, heure d\'été comprise', () => {
  assert.equal(tzOffsetMin('Europe/Paris', utc(2026, 1, 15)), 60);
  assert.equal(tzOffsetMin('Europe/Paris', utc(2026, 7, 15)), 120);
  assert.equal(tzOffsetMin('Asia/Tokyo', utc(2026, 7, 15)), 540);
  assert.equal(tzOffsetMin('Asia/Kolkata', utc(2026, 1, 15)), 330);
  assert.equal(tzOffsetMin('America/New_York', utc(2026, 1, 15)), -300);
  assert.equal(tzOffsetMin('America/New_York', utc(2026, 7, 15)), -240);
  assert.equal(tzOffsetMin('UTC', utc(2026, 7, 15)), 0);
  // bascule : 29 mars 2026, 01:00 UTC = passage à l'heure d'été en Europe
  assert.equal(tzOffsetMin('Europe/Paris', utc(2026, 3, 29, 0)), 60);
  assert.equal(tzOffsetMin('Europe/Paris', utc(2026, 3, 29, 2)), 120);
});

test('tzOffsetMin : fuseau inconnu → erreur lisible', () => {
  assert.throws(() => tzOffsetMin('Mars/Olympus', 0), /Fuseau horaire inconnu/);
});

test('zonedTime/zonedMidnight : aller-retour en fuseaux lointains', () => {
  const ms = zonedTime('Asia/Tokyo', 2026, 11, 26, 13.5);
  assert.equal(ms, Date.UTC(2026, 10, 26, 4, 30));
  assert.equal(zonedMidnight('Asia/Tokyo', ms), Date.UTC(2026, 10, 25, 15, 0));
  assert.equal(zonedTime('Europe/Paris', 2026, 3, 29, 12), Date.UTC(2026, 2, 29, 10, 0));
});

test('Paris → Tokyo : +8 h en hiver, +7 h en été (heure d\'été)', () => {
  const dep = utc(2026, 1, 20, 10);
  const winter = planJetlag({ originTz: 'Europe/Paris', destTz: 'Asia/Tokyo', departMs: dep, arriveMs: dep + 14 * HOUR, profile });
  assert.equal(winter.shiftH, 8);
  assert.equal(winter.direction, 'est');
  const dep2 = utc(2026, 7, 20, 10);
  const summer = planJetlag({ originTz: 'Europe/Paris', destTz: 'Asia/Tokyo', departMs: dep2, arriveMs: dep2 + 14 * HOUR, profile });
  assert.equal(summer.shiftH, 7);
});

test('Paris → Tokyo : on avance l\'horloge, plan cohérent jour par jour', () => {
  const dep = utc(2026, 11, 25, 12);
  const p = planJetlag({ originTz: 'Europe/Paris', destTz: 'Asia/Tokyo', departMs: dep, arriveMs: dep + 14 * HOUR, profile });
  assert.equal(p.phaseDirection, 'avance');
  assert.equal(p.phaseShiftH, 8);
  assert.ok(p.daysToAdapt >= 6 && p.daysToAdapt <= 14, `${p.daysToAdapt} jours`);
  assert.ok(p.alternative && p.alternative.phaseDirection === 'retard');
  // résiduel décroissant, jamais négatif, finit ≤ 0,5 h
  let prev = Infinity;
  for (const d of p.days) {
    assert.ok(d.residualH >= 0 && d.residualH <= prev + 1e-9, `${d.label} ${d.residualH}`);
    prev = d.residualH;
  }
  assert.ok(p.days[p.days.length - 1].residualH <= 0.6);
  // jours consécutifs par phase
  const phases = p.days.map((d) => d.phase);
  assert.deepEqual(phases.slice(0, 2), ['avant', 'avant']);
  assert.ok(phases.includes('vol') && phases.includes('arrivée') && phases.includes('adaptation'));
  // fenêtres : bien formées, lumière à chercher ≠ lumière à éviter, texte français
  for (const d of p.days) {
    for (const w of [...d.seekLight, ...d.avoidLight]) assert.ok(w.end > w.start && w.end - w.start <= 6 * HOUR);
    for (const s of d.seekLight) for (const a of d.avoidLight) assert.ok(s.end <= a.start || a.end <= s.start, `chevauchement jour ${d.label}`);
    assert.ok(typeof d.advice === 'string' && d.advice.length > 30);
  }
  // la lumière à chercher vient après le CBTmin, l'évitement avant (sens avance)
  const arr = p.days.find((d) => d.phase === 'arrivée');
  assert.ok(arr.seekLight.length);
  for (const s of arr.seekLight) assert.ok(s.start >= arr.cbtMinMs);
  // la fenêtre de lumière se déplace vers le tôt à mesure que l'horloge avance
  const adapt = p.days.filter((d) => d.phase === 'adaptation' && d.seekLight.length);
  const startOf = (d) => (d.seekLight[0].start - d.dayMs) / HOUR;
  assert.ok(startOf(adapt[1]) < startOf(arr) + 1e-9);
  assert.ok(startOf(adapt[adapt.length - 1]) < startOf(adapt[0]));
});

test('Paris → Los Angeles : on retarde, lumière en fin d\'après-midi', () => {
  const dep = utc(2026, 11, 25, 9);
  const p = planJetlag({ originTz: 'Europe/Paris', destTz: 'America/Los_Angeles', departMs: dep, arriveMs: dep + 11 * HOUR, profile });
  assert.equal(p.shiftH, -9);
  assert.equal(p.direction, 'ouest');
  assert.equal(p.phaseDirection, 'retard');
  const arr = p.days.find((d) => d.phase === 'arrivée');
  const sh = (arr.seekLight[0].start - arr.dayMs) / HOUR;
  assert.ok(sh >= 12 && sh <= 21, `fenêtre de lumière à ${sh} h`);
  assert.ok(p.days.some((d) => d.phase === 'adaptation'));
});

test('grand décalage vers l\'est : choisit le sens le plus court en jours et annonce l\'alternative', () => {
  const dep = utc(2026, 11, 25, 9);
  const p = planJetlag({ originTz: 'Europe/Paris', destTz: 'Pacific/Auckland', departMs: dep, arriveMs: dep + 25 * HOUR, profile });
  assert.equal(p.shiftH, 12);
  const chosenDays = p.phaseShiftH / (p.phaseDirection === 'avance' ? JET.advanceRateH : JET.delayRateH);
  const altDays = p.alternative.phaseShiftH / (p.alternative.phaseDirection === 'avance' ? JET.advanceRateH : JET.delayRateH);
  assert.ok(chosenDays <= altDays + 1e-9);
  assert.equal(p.phaseShiftH + p.alternative.phaseShiftH, 24);
});

test('aucun médicament conseillé ; mélatonine seulement « à discuter avec un professionnel de santé »', () => {
  const dep = utc(2026, 11, 25, 9);
  const p = planJetlag({ originTz: 'Europe/Paris', destTz: 'Asia/Tokyo', departMs: dep, arriveMs: dep + 14 * HOUR, profile });
  const advice = p.days.map((d) => d.advice).join(' ') + p.summary;
  assert.doesNotMatch(advice, /mélatonine|somnifère|médicament|zolpidem|benzodiaz/i);
  const note = p.notes.find((n) => /mélatonine/i.test(n));
  assert.ok(note && /professionnel de santé/.test(note));
});

test('même fuseau : aucun plan', () => {
  const dep = utc(2026, 11, 25, 9);
  const p = planJetlag({ originTz: 'Europe/Paris', destTz: 'Europe/Berlin', departMs: dep, arriveMs: dep + 2 * HOUR, profile });
  assert.equal(p.shiftH, 0);
  assert.deepEqual(p.days, []);
  assert.equal(p.daysToAdapt, 0);
});

test('entrées invalides et déterminisme', () => {
  assert.throws(() => planJetlag({ originTz: 'Europe/Paris', destTz: 'Asia/Tokyo', departMs: 5, arriveMs: 1, profile }), /postérieure/);
  assert.throws(() => planJetlag({ originTz: 'Nope/Zone', destTz: 'Asia/Tokyo', departMs: 1, arriveMs: DAY, profile }), /Fuseau/);
  const dep = utc(2026, 11, 25, 9);
  const args = { originTz: 'Europe/Paris', destTz: 'Asia/Tokyo', departMs: dep, arriveMs: dep + 14 * HOUR, profile };
  assert.deepEqual(planJetlag(args), planJetlag(args));
});

test('PRC : retard avant le CBTmin, avance après, périodique', () => {
  assert.ok(prc(-4) < -0.8);
  assert.ok(prc(4) > 0.8);
  assert.ok(Math.abs(prc(0)) < 0.5);
  assert.ok(Math.abs(prc(3) - prc(27)) < 1e-12);
});
