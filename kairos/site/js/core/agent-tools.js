// Surface « agents » de Kairos : sémantique des outils qu'un serveur MCP (ou tout autre transport) exposera.
// Fonctions PURES : elles reçoivent l'état et l'heure, ne lisent rien, n'écrivent rien. Le serveur, lui, reste à écrire :
// il n'aura qu'à envelopper ces fonctions (voir docs/agents.md pour le protocole, les permissions et la menace).
//
// Principes (détaillés dans docs/agents.md) :
//  1. Un agent ne modifie JAMAIS l'état : il PROPOSE, l'utilisateur accepte (boîte de réception).
//  2. Les droits sont des « scopes » étroits ; sans `read:energy`, aucune valeur d'énergie ne sort.
//  3. Tout texte venu d'un agent est une donnée affichée, jamais une instruction (borné, nettoyé).
import { buildModel } from './model.js';
import { slotsFree, fitScore, meanAlertMs } from './scheduler.js';
import { startOfDay, addDays, HOUR, MIN, DAY } from './time.js';

export const PROPOSAL_SCHEMA_ID = 'kairos.proposal/1';

export const SCOPES = Object.freeze({
  'read:energy': "Courbe d'énergie prédite et fenêtres d'or (donnée dérivée du sommeil : sensible).",
  'read:busy': "Créneaux occupés ou libres, sans titres ni détails.",
  'read:tasks': 'Titres, durées et échéances des tâches ouvertes.',
  'propose:event': 'Proposer un événement d\'agenda.',
  'propose:task': 'Proposer une tâche.',
  'propose:sleep': 'Proposer une nuit ou une sieste.',
  'propose:caffeine': 'Proposer une prise de caféine.',
});

const KINDS = ['event', 'task', 'sleep', 'caffeine'];
const clampInt = (x, lo, hi, d) => (Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Math.round(Number(x)))) : d);
const round1 = (x) => Math.round(x * 10) / 10;
const step5 = (x, d) => Math.max(5, Math.min(60, Math.round(clampInt(x, 5, 60, d) / 5) * 5));

/** Texte venu d'un agent : sans caractères de contrôle, espaces normalisés, borné. Jamais interprété. */
export function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ───────────────────────────── Outils de lecture ─────────────────────────────

function modelFor(state, fromMs, hours, stepMin, nowMs) {
  return buildModel({ profile: state.profile, sleeps: state.sleeps, caffeine: state.caffeine, fromMs, hours, stepMin, nowMs });
}

/** kairos_get_energy : courbe d'alerte (0-100) et fenêtres d'or. Exige `read:energy`. */
export function getEnergy(state, { fromMs, hours = 24, stepMin = 15 } = {}, nowMs = Date.now()) {
  const from = Number.isFinite(fromMs) ? fromMs : startOfDay(nowMs);
  const step = step5(stepMin, 15);
  const h = clampInt(hours, 1, 168, 24);
  const m = modelFor(state, from, h, step, nowMs);
  return {
    t0: m.t0,
    stepMin: m.stepMin,
    alert: Array.from(m.alert, (v) => Math.round(v)),
    goldenWindows: (m.stats.goldenWindows || []).map((w) => ({ startMs: w.startMs, endMs: w.endMs, mean: Math.round(w.mean) })),
    note: 'Prédiction de confort, pas un avis médical. Confiance : modèle de population ajusté sur les check-ins.',
  };
}

/** kairos_get_free_busy : intervalles occupés (agenda + blocs planifiés), sans aucun titre. Exige `read:busy`. */
export function getFreeBusy(state, { fromMs, toMs } = {}, nowMs = Date.now()) {
  const from = Number.isFinite(fromMs) ? fromMs : nowMs;
  const to = Number.isFinite(toMs) ? Math.min(toMs, from + 31 * DAY) : from + 7 * DAY;
  const busy = [...(state.events || []), ...((state.plan && state.plan.blocks) || [])]
    .filter((b) => b && Number.isFinite(b.startMs) && Number.isFinite(b.endMs) && b.endMs > from && b.startMs < to && !b.allDay)
    .map((b) => ({ startMs: Math.max(b.startMs, from), endMs: Math.min(b.endMs, to) }))
    .sort((a, b) => a.startMs - b.startMs);
  // fusion des chevauchements : l'agent n'a pas à savoir combien d'éléments se cachent derrière
  const merged = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (last && b.startMs <= last.endMs) last.endMs = Math.max(last.endMs, b.endMs);
    else merged.push({ ...b });
  }
  return { fromMs: from, toMs: to, busy: merged };
}

/** kairos_list_tasks : tâches ouvertes. Exige `read:tasks`. Pas de notes, pas de tags. */
export function listTasks(state, { limit = 50 } = {}) {
  return {
    tasks: (state.tasks || []).filter((t) => !t.done).slice(0, clampInt(limit, 1, 200, 50)).map((t) => ({
      id: t.id, title: cleanText(t.title, 200), durMin: t.durMin, load: t.load, priority: t.priority, deadlineMs: t.deadlineMs ?? null,
    })),
  };
}

/**
 * kairos_find_slots : les meilleurs créneaux libres pour une activité de durée et de charge cognitive données.
 * Une réunion légère (load 1-2) évite les pics ; un travail profond (load 4-5) les vise. Exige `read:busy` ;
 * le libellé d'énergie n'est renvoyé qu'avec `read:energy` (sinon le seul classement sort, sans valeur).
 */
export function findSlots(state, args = {}, { nowMs = Date.now(), scopes = [] } = {}) {
  const durationMin = clampInt(args.durationMin, 5, 480, 30);
  const load = clampInt(args.load, 1, 5, 2);
  const count = clampInt(args.count, 1, 20, 5);
  const gran = step5(args.granularityMin, 15);
  const earliest = Number.isFinite(args.earliestMs) ? Math.max(args.earliestMs, nowMs) : nowMs;
  const latest = Math.min(Number.isFinite(args.latestMs) ? args.latestMs : earliest + 7 * DAY, earliest + 14 * DAY);
  if (!(latest > earliest)) return { slots: [], note: 'Fenêtre vide.' };

  const day0 = startOfDay(earliest);
  const hours = Math.min(14 * 24 + 24, Math.ceil((latest - day0) / HOUR) + 1);
  const m = modelFor(state, day0, hours, 5, nowMs);
  const curve = { t0: m.t0, stepMin: m.stepMin, alert: m.alert };

  const free = slotsFree({
    events: state.events, blocks: (state.plan && state.plan.blocks) || [], profile: state.profile,
    nowMs: earliest, horizonEndMs: latest, curve, minMin: durationMin,
  });

  const cands = [];
  for (const seg of free) {
    const first = Math.ceil(seg.startMs / (gran * MIN)) * gran * MIN;
    for (let s = Math.max(first, seg.startMs); s + durationMin * MIN <= seg.endMs; s += gran * MIN) {
      const mean = meanAlertMs(curve, s, s + durationMin * MIN);
      cands.push({ startMs: s, endMs: s + durationMin * MIN, mean, fit: fitScore(load, mean) });
    }
  }
  cands.sort((a, b) => b.fit - a.fit || a.startMs - b.startMs);

  const picked = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    if (picked.every((p) => c.endMs <= p.startMs || c.startMs >= p.endMs)) picked.push(c);
  }
  picked.sort((a, b) => b.fit - a.fit || a.startMs - b.startMs);

  const withEnergy = scopes.includes('read:energy');
  return {
    slots: picked.map((c, i) => {
      const o = { rank: i + 1, startMs: c.startMs, endMs: c.endMs };
      if (withEnergy) { o.fit = Math.round(c.fit * 100) / 100; o.energy = c.mean >= 70 ? 'haute' : c.mean >= 50 ? 'moyenne' : 'basse'; }
      return o;
    }),
    note: withEnergy ? undefined : "Classement seul : la valeur d'énergie n'est pas divulguée sans le droit read:energy.",
  };
}

// ───────────────────────────── Propositions ─────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9._-]{1,48}$/;

/**
 * Valide une proposition d'agent. Ne lève jamais : renvoie { ok, errors, proposal } ; `proposal` est la
 * version normalisée (bornée, nettoyée) à stocker dans la boîte de réception, jamais l'objet d'origine.
 */
export function validateProposal(p, { nowMs = Date.now(), scopes = null } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, errors: ['La proposition doit être un objet.'], proposal: null };
  if (p.schema !== PROPOSAL_SCHEMA_ID) err(`schema doit valoir « ${PROPOSAL_SCHEMA_ID} ».`);
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) err('id : 8 à 64 caractères parmi lettres, chiffres, _ et -.');
  const agent = p.source && p.source.agent;
  if (typeof agent !== 'string' || !AGENT_RE.test(agent)) err('source.agent : identifiant en minuscules (a-z, 0-9, ., _, -), 2 à 49 caractères.');
  if (!KINDS.includes(p.kind)) err(`kind doit valoir ${KINDS.join(', ')}.`);
  if (scopes && KINDS.includes(p.kind) && !scopes.includes(`propose:${p.kind}`)) err(`Droit manquant : propose:${p.kind}.`);
  const pl = p.payload;
  if (!pl || typeof pl !== 'object') err('payload manquant.');
  const out = { schema: PROPOSAL_SCHEMA_ID, id: p.id, source: { agent, run: p.source && p.source.run ? cleanText(p.source.run, 80) : undefined }, kind: p.kind };

  const inRange = (ms) => Number.isFinite(ms) && ms > nowMs - 400 * DAY && ms < nowMs + 800 * DAY;
  if (pl && typeof pl === 'object' && KINDS.includes(p.kind)) {
    if (p.kind === 'event') {
      const title = cleanText(pl.title, 200);
      if (!title) err('payload.title requis.');
      if (!inRange(pl.startMs) || !inRange(pl.endMs)) err('payload.startMs et endMs : horodatages plausibles (entre −400 j et +800 j).');
      else if (!(pl.endMs > pl.startMs) || pl.endMs - pl.startMs > 14 * DAY) err('payload : endMs doit suivre startMs, durée ≤ 14 jours.');
      out.payload = { title, startMs: pl.startMs, endMs: pl.endMs, location: pl.location ? cleanText(pl.location, 200) : undefined };
    } else if (p.kind === 'task') {
      const title = cleanText(pl.title, 200);
      if (!title) err('payload.title requis.');
      if (!Number.isFinite(pl.durMin) || pl.durMin < 5 || pl.durMin > 2400) err('payload.durMin : 5 à 2400 minutes.');
      if (pl.deadlineMs != null && !inRange(pl.deadlineMs)) err('payload.deadlineMs : horodatage plausible.');
      out.payload = {
        title, durMin: clampInt(pl.durMin, 5, 2400, 30), load: clampInt(pl.load, 1, 5, 3), priority: clampInt(pl.priority, 1, 4, 3),
        deadlineMs: pl.deadlineMs ?? undefined, tags: Array.isArray(pl.tags) ? pl.tags.slice(0, 8).map((t) => cleanText(t, 30)).filter(Boolean) : undefined,
      };
    } else if (p.kind === 'sleep') {
      if (!inRange(pl.bedMs) || !inRange(pl.wakeMs)) err('payload.bedMs et wakeMs : horodatages plausibles.');
      else if (!(pl.wakeMs > pl.bedMs) || pl.wakeMs - pl.bedMs > 18 * HOUR) err('payload : wakeMs doit suivre bedMs, durée ≤ 18 h.');
      else if (pl.wakeMs > nowMs + 5 * MIN) err('payload.wakeMs : une nuit ne peut pas être dans le futur.');
      out.payload = { bedMs: pl.bedMs, wakeMs: pl.wakeMs, quality: pl.quality != null ? clampInt(pl.quality, 1, 5, 3) : undefined, nap: pl.nap ? true : undefined };
    } else if (p.kind === 'caffeine') {
      if (!inRange(pl.tMs) || pl.tMs > nowMs + HOUR) err('payload.tMs : horodatage plausible, au plus 1 h dans le futur.');
      if (!Number.isFinite(pl.mg) || pl.mg < 1 || pl.mg > 1000) err('payload.mg : 1 à 1000.');
      out.payload = { tMs: pl.tMs, mg: clampInt(pl.mg, 1, 1000, 80), kind: pl.kind ? cleanText(pl.kind, 40) : undefined };
    }
  }
  if (p.rationale != null) out.rationale = cleanText(p.rationale, 500);
  if (p.dedupeKey != null) out.dedupeKey = cleanText(p.dedupeKey, 80);
  if (p.confidence != null) { if (!(p.confidence >= 0 && p.confidence <= 1)) err('confidence : entre 0 et 1.'); else out.confidence = p.confidence; }
  if (p.expiresMs != null) { if (!Number.isFinite(p.expiresMs)) err('expiresMs : horodatage.'); else out.expiresMs = p.expiresMs; }
  out.createdMs = Number.isFinite(p.createdMs) ? p.createdMs : nowMs;
  return { ok: errors.length === 0, errors, proposal: errors.length ? null : JSON.parse(JSON.stringify(out)) };
}

/** kairos_propose : valide un lot (≤ 50) ; renvoie ce qui entrerait dans la boîte de réception, sans rien appliquer. */
export function proposeBatch(proposals, { nowMs = Date.now(), scopes = [] } = {}) {
  if (!Array.isArray(proposals)) return { queued: [], rejected: [{ index: -1, errors: ['proposals doit être un tableau.'] }] };
  if (proposals.length > 50) return { queued: [], rejected: [{ index: -1, errors: ['Au plus 50 propositions par appel.'] }] };
  const queued = [];
  const rejected = [];
  const seen = new Set();
  proposals.forEach((p, index) => {
    const r = validateProposal(p, { nowMs, scopes });
    if (!r.ok) { rejected.push({ index, errors: r.errors }); return; }
    const key = r.proposal.dedupeKey || r.proposal.id;
    if (seen.has(key)) { rejected.push({ index, errors: ['Doublon dans le lot (id ou dedupeKey).'] }); return; }
    seen.add(key);
    queued.push({ ...r.proposal, status: 'pending' });
  });
  return { queued, rejected };
}

// ───────────────────────────── Catalogue d'outils (schéma MCP) ─────────────────────────────

const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
export const TOOLS = Object.freeze([
  {
    name: 'kairos_get_energy',
    description: "Courbe d'énergie prédite (0-100) de l'utilisateur et ses fenêtres d'or. Donnée dérivée de son sommeil : à n'utiliser que pour décider, pas à redistribuer.",
    requires: ['read:energy'],
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      fromMs: num('Début (epoch ms). Défaut : minuit du jour courant.'),
      hours: num('Durée en heures, 1 à 168. Défaut 24.', { minimum: 1, maximum: 168 }),
      stepMin: num('Pas en minutes, multiple de 5, 5 à 60. Défaut 15.', { minimum: 5, maximum: 60 }),
    } },
  },
  {
    name: 'kairos_get_free_busy',
    description: "Intervalles occupés (agenda et blocs planifiés), fusionnés, sans titre. Pour ne jamais proposer un créneau pris.",
    requires: ['read:busy'],
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      fromMs: num('Début (epoch ms). Défaut : maintenant.'),
      toMs: num('Fin (epoch ms), au plus 31 jours après le début.'),
    } },
  },
  {
    name: 'kairos_find_slots',
    description: "Meilleurs créneaux libres, dans les heures de travail, pour une activité de durée et de charge cognitive données (1 = réunion légère, 5 = travail profond). Les créneaux sont classés selon l'énergie prédite ; sans le droit read:energy, seul le classement sort.",
    requires: ['read:busy'],
    inputSchema: { type: 'object', additionalProperties: false, required: ['durationMin'], properties: {
      durationMin: num('Durée en minutes, 5 à 480.', { minimum: 5, maximum: 480 }),
      load: num('Charge cognitive 1 à 5. Défaut 2.', { minimum: 1, maximum: 5 }),
      earliestMs: num('Plus tôt (epoch ms). Défaut : maintenant.'),
      latestMs: num('Plus tard (epoch ms). Défaut : +7 jours, maximum +14 jours.'),
      count: num('Nombre de créneaux, 1 à 20. Défaut 5.', { minimum: 1, maximum: 20 }),
      granularityMin: num('Pas de départ, multiple de 5, 5 à 60. Défaut 15.', { minimum: 5, maximum: 60 }),
    } },
  },
  {
    name: 'kairos_list_tasks',
    description: 'Tâches ouvertes (titre, durée, charge, priorité, échéance). Sans notes ni étiquettes.',
    requires: ['read:tasks'],
    inputSchema: { type: 'object', additionalProperties: false, properties: { limit: num('1 à 200. Défaut 50.', { minimum: 1, maximum: 200 }) } },
  },
  {
    name: 'kairos_propose',
    description: "Dépose des propositions (événement, tâche, nuit, caféine) dans la boîte de réception de l'utilisateur. Rien n'est appliqué sans son accord. Jusqu'à 50 par appel.",
    requires: ['propose:*'],
    inputSchema: { type: 'object', additionalProperties: false, required: ['proposals'], properties: {
      proposals: { type: 'array', maxItems: 50, items: { $ref: 'proposal.schema.json' }, description: 'Propositions au format kairos.proposal/1.' },
    } },
  },
]);

/** Les droits couvrent-ils l'outil ? `propose:*` = au moins un droit propose:… */
export function toolAllowed(toolName, scopes) {
  const t = TOOLS.find((x) => x.name === toolName);
  if (!t) return false;
  return t.requires.every((r) => (r === 'propose:*' ? scopes.some((s) => s.startsWith('propose:')) : scopes.includes(r)));
}

/** Schéma JSON (draft 2020-12) d'une proposition, dérivé du code pour rester d'équerre avec validateProposal. */
export function proposalJsonSchema() {
  const ms = { type: 'integer', description: 'Epoch en millisecondes (UTC).' };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'proposal.schema.json',
    title: 'Proposition d\'agent pour Kairos',
    description: "Un agent propose, l'utilisateur dispose : la proposition entre dans la boîte de réception et n'est appliquée qu'après son accord.",
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'id', 'source', 'kind', 'payload'],
    properties: {
      schema: { const: PROPOSAL_SCHEMA_ID },
      id: { type: 'string', pattern: ID_RE.source, description: 'Identifiant unique choisi par l\'agent.' },
      createdMs: ms,
      source: { type: 'object', additionalProperties: false, required: ['agent'], properties: {
        agent: { type: 'string', pattern: AGENT_RE.source, description: "Identifiant de l'agent, affiché à l'utilisateur." },
        run: { type: 'string', maxLength: 80, description: "Identifiant d'exécution (traçabilité)." },
      } },
      kind: { enum: KINDS },
      payload: { type: 'object', description: 'Dépend de kind : voir oneOf ci-dessous.' },
      rationale: { type: 'string', maxLength: 500, description: "Pourquoi l'agent propose cela. Texte affiché, jamais interprété." },
      dedupeKey: { type: 'string', maxLength: 80, description: 'Une proposition de même clé remplace la précédente en attente.' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      expiresMs: ms,
    },
    oneOf: [
      { properties: { kind: { const: 'event' }, payload: { type: 'object', additionalProperties: false, required: ['title', 'startMs', 'endMs'], properties: { title: { type: 'string', maxLength: 200 }, startMs: ms, endMs: ms, location: { type: 'string', maxLength: 200 } } } } },
      { properties: { kind: { const: 'task' }, payload: { type: 'object', additionalProperties: false, required: ['title', 'durMin'], properties: { title: { type: 'string', maxLength: 200 }, durMin: { type: 'integer', minimum: 5, maximum: 2400 }, load: { type: 'integer', minimum: 1, maximum: 5 }, priority: { type: 'integer', minimum: 1, maximum: 4 }, deadlineMs: ms, tags: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 30 } } } } } },
      { properties: { kind: { const: 'sleep' }, payload: { type: 'object', additionalProperties: false, required: ['bedMs', 'wakeMs'], properties: { bedMs: ms, wakeMs: ms, quality: { type: 'integer', minimum: 1, maximum: 5 }, nap: { type: 'boolean' } } } } },
      { properties: { kind: { const: 'caffeine' }, payload: { type: 'object', additionalProperties: false, required: ['tMs', 'mg'], properties: { tMs: ms, mg: { type: 'integer', minimum: 1, maximum: 1000 }, kind: { type: 'string', maxLength: 40 } } } } },
    ],
  };
}

/** Catalogue au format attendu par un serveur MCP (`tools/list`). */
export function mcpToolList() {
  return TOOLS.map(({ name, description, inputSchema, requires }) => ({ name, description, inputSchema, annotations: { readOnlyHint: name !== 'kairos_propose', requiresScopes: requires } }));
}
