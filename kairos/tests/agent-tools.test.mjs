import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as A from '../site/js/core/agent-tools.js';
import { makeDemoState } from '../site/js/core/demo.js';

const docs = join(dirname(fileURLToPath(import.meta.url)), '../docs/agents');
const NOW = Date.parse('2026-11-23T12:00:00Z');
const ex = (f) => JSON.parse(readFileSync(join(docs, 'examples', f), 'utf8'));
const ALL = Object.keys(A.SCOPES);

test('les schémas publiés sont à jour avec le code (node kairos/scripts/agent-schema.mjs)', () => {
  assert.deepEqual(JSON.parse(readFileSync(join(docs, 'proposal.schema.json'), 'utf8')), A.proposalJsonSchema());
  assert.deepEqual(JSON.parse(readFileSync(join(docs, 'mcp-tools.json'), 'utf8')), { tools: A.mcpToolList() });
});

test('exemples valides : acceptés et normalisés', () => {
  for (const f of ['event.json', 'task.json', 'sleep.json', 'caffeine.json']) {
    const r = A.validateProposal(ex(f), { nowMs: NOW, scopes: ALL });
    assert.equal(r.ok, true, `${f} : ${r.errors.join(' | ')}`);
    assert.equal(r.proposal.schema, 'kairos.proposal/1');
  }
});

test('nuit dans le futur et droit manquant : refusés avec un message français', () => {
  const futur = A.validateProposal(ex('invalide-nuit-future.json'), { nowMs: NOW, scopes: ALL });
  assert.equal(futur.ok, false);
  assert.match(futur.errors.join(' '), /futur/);
  const sans = A.validateProposal(ex('invalide-droit-manquant.json'), { nowMs: NOW, scopes: ['propose:task'] });
  assert.equal(sans.ok, false);
  assert.match(sans.errors.join(' '), /propose:event/);
});

test('texte hostile : traité comme donnée (nettoyé, borné), jamais comme instruction', () => {
  const r = A.validateProposal(ex('hostile-injection.json'), { nowMs: NOW, scopes: ALL });
  assert.equal(r.ok, true);
  assert.equal(/[\u0000-\u001f‮]/.test(r.proposal.payload.title), false);
  assert.ok(r.proposal.rationale.length <= 500);
  // aucune propriété d'autorisation ne peut être introduite par le texte
  assert.deepEqual(Object.keys(r.proposal).filter((k) => /auto|trust|approve|scope/i.test(k)), []);
});

test('champs inconnus ignorés, entrées absurdes refusées sans lever', () => {
  for (const bad of [null, 42, 'x', [], {}, { schema: 'autre' }]) assert.equal(A.validateProposal(bad, { nowMs: NOW }).ok, false);
  const p = { ...ex('task.json'), pwned: true, payload: { ...ex('task.json').payload, admin: true } };
  const r = A.validateProposal(p, { nowMs: NOW, scopes: ALL });
  assert.equal(r.ok, true);
  assert.equal('pwned' in r.proposal, false);
  assert.equal('admin' in r.proposal.payload, false);
  assert.equal(A.validateProposal({ ...ex('task.json'), payload: { title: 'x', durMin: 1e9 } }, { nowMs: NOW }).ok, false);
});

test('lot : doublons et plafond de 50', () => {
  const t = ex('task.json');
  const r = A.proposeBatch([t, { ...t, id: 'tsk_autre_001' }], { nowMs: NOW, scopes: ALL });
  assert.equal(r.queued.length, 1);
  assert.match(r.rejected[0].errors[0], /Doublon/);
  assert.equal(A.proposeBatch(new Array(51).fill(t), { nowMs: NOW, scopes: ALL }).queued.length, 0);
  assert.equal(A.proposeBatch('pas un tableau', { nowMs: NOW }).queued.length, 0);
});

test('permissions : chaque outil exige les bons droits', () => {
  assert.equal(A.toolAllowed('kairos_get_energy', ['read:busy']), false);
  assert.equal(A.toolAllowed('kairos_get_energy', ['read:energy']), true);
  assert.equal(A.toolAllowed('kairos_propose', ['read:energy', 'read:busy', 'read:tasks']), false);
  assert.equal(A.toolAllowed('kairos_propose', ['propose:task']), true);
  assert.equal(A.toolAllowed('inconnu', ALL), false);
});

test('find_slots : libres, dans les heures de travail, sans chevauchement, déterministe', () => {
  const st = makeDemoState(NOW, 7);
  const args = { durationMin: 45, load: 2, count: 5 };
  const a = A.findSlots(st, args, { nowMs: NOW, scopes: ['read:busy', 'read:energy'] });
  const b = A.findSlots(st, args, { nowMs: NOW, scopes: ['read:busy', 'read:energy'] });
  assert.deepEqual(a, b);
  assert.ok(a.slots.length >= 3);
  const busy = A.getFreeBusy(st, { fromMs: NOW, toMs: NOW + 14 * 86400000 }, NOW).busy;
  for (const s of a.slots) {
    assert.equal(s.endMs - s.startMs, 45 * 60000);
    assert.ok(s.startMs >= NOW);
    assert.ok(busy.every((x) => s.endMs <= x.startMs || s.startMs >= x.endMs), 'chevauche un événement');
  }
  for (let i = 0; i < a.slots.length; i++) for (let j = i + 1; j < a.slots.length; j++) {
    assert.ok(a.slots[i].endMs <= a.slots[j].startMs || a.slots[j].endMs <= a.slots[i].startMs, 'créneaux qui se chevauchent');
  }
});

test('find_slots : sans read:energy, aucune valeur d\'énergie ne sort', () => {
  const st = makeDemoState(NOW, 7);
  const r = A.findSlots(st, { durationMin: 30 }, { nowMs: NOW, scopes: ['read:busy'] });
  assert.ok(r.slots.length > 0);
  for (const s of r.slots) assert.deepEqual(Object.keys(s).sort(), ['endMs', 'rank', 'startMs']);
  assert.match(r.note, /read:energy/);
});

test('find_slots : une tâche profonde vise de meilleures alertes qu\'une réunion légère', () => {
  const st = makeDemoState(NOW, 7);
  const sc = ['read:busy', 'read:energy'];
  const rank = { basse: 0, moyenne: 1, haute: 2 };
  const deep = A.findSlots(st, { durationMin: 60, load: 5, count: 1 }, { nowMs: NOW, scopes: sc }).slots[0];
  const light = A.findSlots(st, { durationMin: 60, load: 1, count: 1 }, { nowMs: NOW, scopes: sc }).slots[0];
  assert.ok(rank[deep.energy] >= rank[light.energy]);
});

test('free_busy : fusionne les chevauchements et ne divulgue aucun titre', () => {
  const st = makeDemoState(NOW, 7);
  const fb = A.getFreeBusy(st, { fromMs: NOW, toMs: NOW + 7 * 86400000 }, NOW);
  for (const b of fb.busy) assert.deepEqual(Object.keys(b).sort(), ['endMs', 'startMs']);
  for (let i = 1; i < fb.busy.length; i++) assert.ok(fb.busy[i].startMs > fb.busy[i - 1].endMs);
});

test('get_energy : borné et cohérent', () => {
  const st = makeDemoState(NOW, 7);
  const e = A.getEnergy(st, { hours: 24, stepMin: 60 }, NOW);
  assert.equal(e.alert.length, 25);
  assert.ok(e.alert.every((v) => v >= 0 && v <= 100));
  assert.equal(A.getEnergy(st, { hours: 9999, stepMin: 1 }, NOW).stepMin, 5);
});

test('list_tasks : seulement les tâches ouvertes, sans notes', () => {
  const st = makeDemoState(NOW, 7);
  const r = A.listTasks(st, {});
  assert.ok(r.tasks.length > 0);
  for (const t of r.tasks) assert.equal('notes' in t, false);
});
