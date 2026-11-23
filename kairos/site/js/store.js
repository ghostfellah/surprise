// store.js — état persistant de Kairos : validation défensive, undo/redo, persistance différée.
//
// Hypothèses et conventions :
//  - L'état est IMMUABLE : chaque action clone l'état courant (structuredClone), applique la modification, puis
//    publie le nouvel objet. Les anciens objets ne sont jamais modifiés (les undo/redo en dépendent) ; les vues ne
//    doivent donc jamais muter `getState()` (ex. pas de `state.tasks.sort(...)` : copier d'abord).
//  - Toute entrée est normalisée : types forcés, valeurs bornées (clamp), champs inconnus supprimés, identifiants
//    garantis uniques. Une entrée irrécupérable est REFUSÉE par une Error française (actions) ou IGNORÉE
//    (chargement/import, qui comptent ce qu'ils écartent).
//  - Undo/redo : pile de 50 instantanés ; les rafales d'une même action sur le même objet (ex. glisser un curseur
//    de profil, taper dans un titre) à moins de 1 s d'intervalle ne forment qu'une étape.
//  - Persistance : sauvegarde différée (150 ms) et à chaque passage en arrière-plan de la page. Backend par défaut :
//    IndexedDB, repli localStorage, repli mémoire ; aucune erreur de stockage ne remonte à l'interface.
//  - Attendre `store.ready` avant d'afficher : tant qu'il n'est pas résolu, l'état est celui par défaut.
import { MIN, uid, clamp } from './core/time.js';
import { encryptJSON, decryptJSON } from './core/crypto.js';

export const CURRENT_VERSION = 1;
export const UNDO_LIMIT = 50;
const BURST_MS = 1000;
const MAX_ITEMS = 20_000; // plafond par collection (import malveillant ou fichier géant)
const MAX_TS = 7.3e12; // ~ an 2200
const KINDS = ['café', 'thé', 'expresso', 'maté', 'boisson énergisante', 'autre'];
const THEMES = ['auto', 'light', 'dark'];

// ───────────────────────── État par défaut ─────────────────────────

function detectTz() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
  } catch { /* fuseau indisponible */ }
  return 'Europe/Paris';
}

/** Un état neuf (objet frais à chaque appel). */
export function makeDefaultState() {
  return {
    version: CURRENT_VERSION,
    profile: {
      chronoShiftMin: 0, sleepNeedH: 8, caffeineSensitivity: 1, caffeineHalfLifeH: 5,
      usualWake: '07:00', usualBed: '23:00', workStart: '09:00', workEnd: '18:00',
      workDays: [1, 2, 3, 4, 5], tz: 'Europe/Paris', fit: null,
    },
    sleeps: [], caffeine: [], checkins: [], tasks: [], events: [], plan: null, focus: [],
    prefs: { theme: 'auto', notifications: false, weekStart: 1, demo: false, onboarded: false },
  };
}

/** Modèle de référence (lecture seule). Le fuseau réel de l'appareil est appliqué à la création du store. */
export const DEFAULT_STATE = deepFreeze(makeDefaultState());

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ───────────────────────── Aides de validation ─────────────────────────

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const numOrNull = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  return null;
};
const tsOrNull = (x) => { const n = numOrNull(x); return n !== null && n >= 0 && n <= MAX_TS ? Math.round(n) : null; };
const intIn = (x, lo, hi, dflt) => { const n = numOrNull(x); return n === null ? dflt : Math.round(clamp(n, lo, hi)); };
const numIn = (x, lo, hi, dflt) => { const n = numOrNull(x); return n === null ? dflt : clamp(n, lo, hi); };
const text = (x, max) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const bool = (x) => x === true || x === 'true';
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const err = (msg) => new Error(msg);

function needObj(x) {
  if (!isObj(x)) throw err('Données manquantes ou invalides.');
  return x;
}

function normId(x, taken, prefix) {
  let id = typeof x === 'string' ? x.trim().slice(0, 80) : typeof x === 'number' && Number.isFinite(x) ? String(x) : '';
  while (!id || taken.has(id)) id = uid(prefix);
  taken.add(id);
  return id;
}

function normTags(x) {
  if (!Array.isArray(x)) return [];
  const out = [];
  for (const t of x) {
    const s = typeof t === 'string' ? t.trim().replace(/^[#@]+/, '').toLowerCase().slice(0, 24) : '';
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 12) break;
  }
  return out;
}

const HHMM = /^(\d{1,2}):(\d{2})$/;
function normHHMM(x) {
  const m = HHMM.exec(typeof x === 'string' ? x.trim() : '');
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0; } catch { return false; } };

// ───────────────────────── Normaliseurs d'entités ─────────────────────────
// Chaque normaliseur renvoie un objet propre ou LÈVE une Error française.

export function normalizeTask(raw, { taken = new Set(), now = Date.now() } = {}) {
  const r = needObj(raw);
  const title = text(r.title, 200);
  if (!title) throw err('Le titre de la tâche ne peut pas être vide.');
  const t = {
    id: normId(r.id, taken, 't'),
    title,
    durMin: Math.round(numIn(r.durMin, 5, 1440, 30) / 5) * 5 || 5,
    load: intIn(r.load, 1, 5, 3),
    priority: intIn(r.priority, 1, 4, 3),
    done: bool(r.done),
    tags: normTags(r.tags),
    createdMs: tsOrNull(r.createdMs) ?? now,
  };
  const dl = tsOrNull(r.deadlineMs), ea = tsOrNull(r.earliestMs);
  if (dl !== null) t.deadlineMs = dl;
  if (ea !== null && (dl === null || ea <= dl)) t.earliestMs = ea; // fenêtre incohérente : on garde l'échéance
  if (typeof r.splittable === 'boolean') t.splittable = r.splittable;
  const mb = numOrNull(r.minBlockMin);
  if (mb !== null) t.minBlockMin = Math.round(clamp(mb, 5, 240) / 5) * 5;
  if (t.done) t.doneMs = tsOrNull(r.doneMs) ?? now;
  const notes = typeof r.notes === 'string' ? r.notes.trim().slice(0, 2000) : '';
  if (notes) t.notes = notes;
  return t;
}

export function normalizeEvent(raw, { taken = new Set(), now = Date.now() } = {}) {
  const r = needObj(raw);
  const title = text(r.title, 200);
  if (!title) throw err('Le titre de l\'événement ne peut pas être vide.');
  const startMs = tsOrNull(r.startMs), endMs = tsOrNull(r.endMs);
  if (startMs === null || endMs === null) throw err('Date ou heure de l\'événement invalide.');
  if (endMs <= startMs) throw err('La fin de l\'événement doit être après son début.');
  const e = { id: normId(r.id, taken, 'e'), title, startMs, endMs, source: r.source === 'ics' ? 'ics' : 'manual' };
  if (bool(r.allDay)) e.allDay = true;
  if (typeof r.uid === 'string' && r.uid.trim()) e.uid = r.uid.trim().slice(0, 200);
  void now;
  return e;
}

export function normalizeSleep(raw, { taken = new Set() } = {}) {
  const r = needObj(raw);
  const bedMs = tsOrNull(r.bedMs), wakeMs = tsOrNull(r.wakeMs);
  if (bedMs === null || wakeMs === null) throw err('Heure de coucher ou de réveil invalide.');
  if (wakeMs <= bedMs) throw err('Le réveil doit être après le coucher.');
  if (wakeMs - bedMs > 24 * 60 * MIN) throw err('Un sommeil ne peut pas durer plus de 24 h.');
  const s = { id: normId(r.id, taken, 's'), bedMs, wakeMs };
  const q = numOrNull(r.quality);
  if (q !== null) s.quality = Math.round(clamp(q, 1, 5));
  if (bool(r.nap)) s.nap = true;
  return s;
}

export function normalizeCaffeine(raw, { taken = new Set() } = {}) {
  const r = needObj(raw);
  const tMs = tsOrNull(r.tMs);
  if (tMs === null) throw err('Heure de prise de caféine invalide.');
  const mg = numOrNull(r.mg);
  if (mg === null || mg <= 0) throw err('La quantité de caféine doit être un nombre de mg positif.');
  const c = { id: normId(r.id, taken, 'c'), tMs, mg: Math.round(Math.min(mg, 1000)) };
  if (typeof r.kind === 'string') c.kind = KINDS.includes(r.kind) ? r.kind : 'autre';
  return c;
}

export function normalizeCheckIn(raw, { taken = new Set() } = {}) {
  const r = needObj(raw);
  const tMs = tsOrNull(r.tMs);
  if (tMs === null) throw err('Heure du bilan invalide.');
  const a = numOrNull(r.alertness);
  if (a === null) throw err('Niveau d\'alerte invalide (de 1 à 5).');
  const c = { id: normId(r.id, taken, 'k'), tMs, alertness: Math.round(clamp(a, 1, 5)) };
  const note = typeof r.note === 'string' ? r.note.trim().slice(0, 500) : '';
  if (note) c.note = note;
  return c;
}

export function normalizeFocus(raw, { taken = new Set() } = {}) {
  const r = needObj(raw);
  const startMs = tsOrNull(r.startMs), endMs = tsOrNull(r.endMs);
  if (startMs === null || endMs === null || endMs < startMs) throw err('Session de concentration invalide : dates incohérentes.');
  const f = { id: normId(r.id, taken, 'f'), startMs, endMs, plannedMin: intIn(r.plannedMin, 1, 480, Math.max(1, Math.round((endMs - startMs) / MIN))) };
  if (typeof r.taskId === 'string' && r.taskId) f.taskId = r.taskId.slice(0, 80);
  const rt = numOrNull(r.rating);
  if (rt !== null) f.rating = Math.round(clamp(rt, 1, 5));
  return f;
}

function normalizeBlock(raw) {
  const r = needObj(raw);
  const startMs = tsOrNull(r.startMs), endMs = tsOrNull(r.endMs);
  if (typeof r.taskId !== 'string' || !r.taskId || startMs === null || endMs === null || endMs <= startMs) throw err('Bloc de planning invalide.');
  const b = { taskId: r.taskId.slice(0, 80), startMs, endMs, score: numIn(r.score, -1e6, 1e6, 0), reason: typeof r.reason === 'string' ? r.reason.slice(0, 400) : '' };
  if (r.locked === true) b.locked = true;
  return b;
}

export function normalizePlan(raw, now = Date.now()) {
  if (raw === null || raw === undefined) return null;
  const r = needObj(raw);
  const blocks = [];
  for (const b of Array.isArray(r.blocks) ? r.blocks.slice(0, MAX_ITEMS) : []) {
    try { blocks.push(normalizeBlock(b)); } catch { /* bloc écarté */ }
  }
  blocks.sort((a, b) => a.startMs - b.startMs);
  return { generatedMs: tsOrNull(r.generatedMs) ?? now, horizonDays: intIn(r.horizonDays, 1, 60, 7), blocks };
}

function normalizeFit(x) {
  if (!isObj(x)) return null;
  const f = {};
  for (const k of ['fittedMs', 'n', 'rmse', 'baselineRmse', 'r2', 'confidence']) {
    const n = numOrNull(x[k]);
    if (n === null) return null;
    f[k] = n;
  }
  f.confidence = clamp(f.confidence, 0, 1);
  return f;
}

/** Valide un correctif de profil. `strict` : lève une Error ; sinon ignore les champs invalides. */
export function normalizeProfilePatch(patch, strict = true) {
  const p = needObj(patch);
  const out = {};
  const bad = (k, why) => { if (strict) throw err(`Profil : « ${k} » ${why}.`); };
  const nums = { chronoShiftMin: [-360, 360, true], sleepNeedH: [6, 10, false], caffeineSensitivity: [0.4, 2, false], caffeineHalfLifeH: [3, 9, false] };
  for (const [k, [lo, hi, round]] of Object.entries(nums)) {
    if (!(k in p)) continue;
    const n = numOrNull(p[k]);
    if (n === null) { bad(k, 'doit être un nombre'); continue; }
    out[k] = round ? Math.round(clamp(n, lo, hi)) : clamp(n, lo, hi);
  }
  for (const k of ['usualWake', 'usualBed', 'workStart', 'workEnd']) {
    if (!(k in p)) continue;
    const v = normHHMM(p[k]);
    if (v === null) bad(k, 'doit être une heure au format HH:MM'); else out[k] = v;
  }
  if ('workDays' in p) {
    if (Array.isArray(p.workDays)) {
      out.workDays = [...new Set(p.workDays.map((d) => numOrNull(d)).filter((d) => d !== null && d >= 0 && d <= 6).map(Math.round))].sort((a, b) => a - b);
    } else bad('workDays', 'doit être une liste de jours (0 = dimanche)');
  }
  if ('tz' in p) {
    if (validTz(p.tz)) out.tz = p.tz; else bad('tz', 'n\'est pas un fuseau horaire connu');
  }
  if ('fit' in p) out.fit = normalizeFit(p.fit);
  return out;
}

export function normalizePrefsPatch(patch, strict = true) {
  const p = needObj(patch);
  const out = {};
  if ('theme' in p) {
    if (THEMES.includes(p.theme)) out.theme = p.theme;
    else if (strict) throw err('Préférences : le thème doit être « auto », « light » ou « dark ».');
  }
  for (const k of ['notifications', 'demo', 'onboarded']) if (k in p) out[k] = bool(p[k]);
  if ('weekStart' in p) out.weekStart = p.weekStart === 0 ? 0 : 1;
  return out;
}

// ───────────────────────── Migration et normalisation globale ─────────────────────────

// Chaque entrée v -> fonction qui amène un état de version v à v+1. Ajouter ici les futures migrations.
const MIGRATIONS = {
  0: (s) => ({ ...s, version: 1 }), // états sans numéro de version : même forme, on normalise ensuite
};

export function migrateState(raw) {
  if (!isObj(raw)) throw err('Ce fichier ne ressemble pas à une sauvegarde Kairos.');
  let v = typeof raw.version === 'number' && Number.isFinite(raw.version) ? Math.floor(raw.version) : 0;
  if (v > CURRENT_VERSION) {
    throw err(`Cette sauvegarde vient d'une version plus récente de Kairos (v${v}). Mets l'application à jour pour l'ouvrir.`);
  }
  let s = raw;
  while (v < CURRENT_VERSION) { s = MIGRATIONS[Math.max(0, v)](s); v = s.version; }
  return s;
}

/** Nettoie un état quelconque (migré) : renvoie { state, dropped } ; ne lève jamais pour du contenu invalide. */
export function normalizeState(raw, { now = Date.now(), tz = 'Europe/Paris' } = {}) {
  const base = makeDefaultState();
  base.profile.tz = tz;
  let dropped = 0;
  if (isObj(raw.profile)) Object.assign(base.profile, normalizeProfilePatch(raw.profile, false));
  if (isObj(raw.prefs)) Object.assign(base.prefs, normalizePrefsPatch(raw.prefs, false));

  const run = (key, fn) => {
    const list = Array.isArray(raw[key]) ? raw[key] : [];
    if (list.length > MAX_ITEMS) dropped += list.length - MAX_ITEMS;
    const taken = new Set();
    const out = [];
    for (const item of list.slice(0, MAX_ITEMS)) {
      try { out.push(fn(item, { taken, now })); } catch { dropped++; }
    }
    base[key] = out;
  };
  run('sleeps', normalizeSleep);
  run('caffeine', normalizeCaffeine);
  run('checkins', normalizeCheckIn);
  run('tasks', normalizeTask);
  run('events', normalizeEvent);
  run('focus', normalizeFocus);
  try { base.plan = normalizePlan(raw.plan, now); } catch { base.plan = null; dropped++; }
  sortAll(base);
  return { state: base, dropped };
}

function sortAll(s) {
  s.sleeps.sort((a, b) => a.wakeMs - b.wakeMs);
  s.caffeine.sort((a, b) => a.tMs - b.tMs);
  s.checkins.sort((a, b) => a.tMs - b.tMs);
  s.events.sort((a, b) => a.startMs - b.startMs);
  s.focus.sort((a, b) => a.startMs - b.startMs);
  if (s.plan) s.plan.blocks.sort((a, b) => a.startMs - b.startMs);
}

const KNOWN_KEYS = ['profile', 'sleeps', 'caffeine', 'checkins', 'tasks', 'events', 'plan', 'focus', 'prefs'];

// ───────────────────────── Backends de persistance ─────────────────────────

/** Backend en mémoire (tests, repli ultime). `backups` garde les copies de sécurité. */
export function memoryBackend(initial = null) {
  const b = {
    data: initial,
    backups: [],
    saves: 0,
    async load() { return b.data; },
    async save(json) { b.data = json; b.saves++; },
    async saveBackup(raw) { b.backups.push(raw); },
  };
  return b;
}

const LS_KEY = 'kairos.state.v1';
const LS_BACKUP_KEY = 'kairos.state.backup';
const withTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('délai dépassé')), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

function idbKV() {
  let dbp = null;
  const open = () => {
    if (!dbp) {
      dbp = withTimeout(new Promise((res, rej) => {
        const req = globalThis.indexedDB.open('kairos', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
        req.onblocked = () => rej(new Error('base bloquée'));
      }), 3000).catch((e) => { dbp = null; throw e; });
    }
    return dbp;
  };
  const tx = async (mode, fn) => {
    const db = await open();
    return withTimeout(new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const r = fn(t.objectStore('kv'));
      t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('transaction annulée'));
    }), 3000);
  };
  return { get: (k) => tx('readonly', (s) => s.get(k)), set: (k, v) => tx('readwrite', (s) => s.put(v, k)) };
}

/** IndexedDB -> localStorage -> mémoire, chaque niveau dans un try/catch : un stockage bloqué ne plante jamais. */
export function createDefaultBackend() {
  let mem = null;
  let idb = null;
  const getIdb = () => {
    if (idb === null) { try { idb = globalThis.indexedDB ? idbKV() : false; } catch { idb = false; } }
    return idb;
  };
  const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };
  return {
    async load() {
      const i = getIdb();
      if (i) { try { const v = await i.get('state'); if (typeof v === 'string') return v; } catch { /* repli */ } }
      try { const v = ls()?.getItem(LS_KEY); if (typeof v === 'string') return v; } catch { /* repli */ }
      return mem;
    },
    async save(json) {
      const i = getIdb();
      if (i) {
        try {
          await i.set('state', json);
          try { ls()?.removeItem(LS_KEY); } catch { /* ignoré */ } // évite une copie périmée
          return;
        } catch { /* repli */ }
      }
      try { const s = ls(); if (s) { s.setItem(LS_KEY, json); return; } } catch { /* repli */ }
      mem = json;
    },
    async saveBackup(raw) {
      try { const s = ls(); if (s) { s.setItem(LS_BACKUP_KEY, raw); return; } } catch { /* ignoré */ }
      try { const i = getIdb(); if (i) await i.set('backup', raw); } catch { /* ignoré */ }
    },
  };
}

// ───────────────────────── Le store ─────────────────────────

/**
 * @param {{backend?: {load(): Promise<string|null>, save(json: string): Promise<void>}, now?: () => number,
 *          saveDelayMs?: number}} [opts]
 */
export function createStore({ backend, now = Date.now, saveDelayMs = 150 } = {}) {
  const be = backend || createDefaultBackend();
  const tz = detectTz();
  const fresh = () => { const s = makeDefaultState(); s.profile.tz = tz; return s; };

  let state = fresh();
  let past = [];
  let future = [];
  let lastCommit = null; // { key, t } : sert au regroupement des rafales
  let mutated = false;
  let timer = null;
  let saving = Promise.resolve();
  let destroyed = false;
  const subs = new Set();
  const info = { loadError: null, saveError: null, dropped: 0 };

  const notify = (change) => {
    for (const fn of [...subs]) { try { fn(state, change); } catch { /* un abonné fautif ne bloque pas les autres */ } }
  };

  // — persistance —
  const serialize = () => JSON.stringify(state);
  const doSave = () => {
    timer = null;
    const json = serialize();
    saving = saving.then(() => be.save(json)).then(() => { info.saveError = null; }, (e) => { info.saveError = e; });
    return saving;
  };
  const scheduleSave = () => {
    if (destroyed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(doSave, saveDelayMs);
  };
  const flush = async () => {
    if (timer !== null) { clearTimeout(timer); doSave(); }
    await saving;
  };

  // — validation de l'identifiant d'une entité —
  const idSet = (list) => new Set(list.map((x) => x.id));

  /** Applique une modification sur un clone, enregistre l'étape d'annulation et publie. */
  function commit(type, mutator, { key = null, id } = {}) {
    const next = structuredClone(state);
    const result = mutator(next);
    if (result === NOOP) return undefined;
    sortAll(next);
    const t = now();
    const burst = key !== null && lastCommit && lastCommit.key === key && t - lastCommit.t < BURST_MS && past.length > 0;
    if (!burst) {
      past.push(state);
      if (past.length > UNDO_LIMIT) past.shift();
    }
    lastCommit = { key, t };
    future = [];
    state = next;
    mutated = true;
    notify(id === undefined ? { type } : { type, id });
    scheduleSave();
    return result;
  }
  const NOOP = Symbol('noop');
  const find = (list, id, label) => {
    const it = list.find((x) => x.id === id);
    if (!it) throw err(`${label} introuvable.`);
    return it;
  };
  const replaceIn = (list, id, value) => { list[list.findIndex((x) => x.id === id)] = value; };

  // — import / chargement —
  function parseJSONText(str) {
    if (typeof str !== 'string' || !str.trim()) throw err('Le fichier est vide.');
    try { return JSON.parse(str.replace(/^﻿/, '')); } catch { throw err('Fichier illisible : ce n\'est pas du JSON valide.'); }
  }
  function applyImport(raw, type) {
    if (!isObj(raw)) throw err('Ce fichier ne ressemble pas à une sauvegarde Kairos.');
    const migrated = migrateState(raw); // lève si version future
    if (!KNOWN_KEYS.some((k) => k in migrated)) throw err('Ce fichier ne ressemble pas à une sauvegarde Kairos.');
    const { state: clean, dropped } = normalizeState(migrated, { now: now(), tz });
    info.dropped = dropped;
    commit(type, (s) => { Object.assign(s, clean); });
    return { dropped };
  }
  const exportObject = () => ({ app: 'kairos', exportedMs: now(), ...structuredClone(state) });

  // — actions —
  const actions = {
    addTask(partial) {
      return commit('addTask', (s) => {
        const t = normalizeTask(partial, { taken: idSet(s.tasks), now: now() });
        s.tasks.push(t);
        return structuredClone(t);
      });
    },
    updateTask(id, patch) {
      needObj(patch);
      return commit('updateTask', (s) => {
        const old = find(s.tasks, id, 'Tâche');
        const merged = { ...old, ...patch, id: old.id, createdMs: old.createdMs };
        if (merged.done === false) delete merged.doneMs;
        if (merged.done === true && old.done && patch.doneMs === undefined) merged.doneMs = old.doneMs;
        const next = normalizeTask(merged, { taken: new Set(), now: now() });
        if (sameJSON(old, next)) return NOOP;
        replaceIn(s.tasks, id, next);
        return structuredClone(next);
      }, { key: `updateTask:${id}`, id });
    },
    removeTask(id) {
      return commit('removeTask', (s) => {
        const n = s.tasks.length;
        s.tasks = s.tasks.filter((t) => t.id !== id);
        if (s.tasks.length === n) return NOOP;
        if (s.plan) s.plan.blocks = s.plan.blocks.filter((b) => b.taskId !== id); // pas de blocs orphelins
        return true;
      }, { id }) === true;
    },
    completeTask(id, done = true) {
      return commit('completeTask', (s) => {
        const t = find(s.tasks, id, 'Tâche');
        const d = done !== false;
        if (t.done === d) return NOOP;
        t.done = d;
        if (d) t.doneMs = now(); else delete t.doneMs;
        return structuredClone(t);
      }, { id });
    },

    addEvent(partial) {
      return commit('addEvent', (s) => {
        const e = normalizeEvent(partial, { taken: idSet(s.events), now: now() });
        s.events.push(e);
        return structuredClone(e);
      });
    },
    updateEvent(id, patch) {
      needObj(patch);
      return commit('updateEvent', (s) => {
        const old = find(s.events, id, 'Événement');
        const next = normalizeEvent({ ...old, ...patch, id: old.id }, { taken: new Set(), now: now() });
        if (sameJSON(old, next)) return NOOP;
        replaceIn(s.events, id, next);
        return structuredClone(next);
      }, { key: `updateEvent:${id}`, id });
    },
    removeEvent(id) {
      return commit('removeEvent', (s) => {
        const n = s.events.length;
        s.events = s.events.filter((e) => e.id !== id);
        return s.events.length === n ? NOOP : true;
      }, { id }) === true;
    },
    /** Remplace tous les événements d'une source ("ics" ou "manual") ; les entrées invalides sont ignorées. Renvoie le nombre ajouté. */
    replaceEvents(source, events) {
      const src = source === 'ics' ? 'ics' : 'manual';
      const list = Array.isArray(events) ? events.slice(0, MAX_ITEMS) : [];
      return commit('replaceEvents', (s) => {
        s.events = s.events.filter((e) => e.source !== src);
        const taken = idSet(s.events);
        let added = 0;
        for (const raw of list) {
          try { s.events.push(normalizeEvent({ ...raw, source: src }, { taken, now: now() })); added++; } catch { /* ignoré */ }
        }
        return added;
      });
    },

    logSleep(partial) {
      return commit('logSleep', (s) => {
        const x = normalizeSleep(partial, { taken: idSet(s.sleeps) });
        s.sleeps.push(x);
        return structuredClone(x);
      });
    },
    removeSleep(id) {
      return commit('removeSleep', (s) => { const n = s.sleeps.length; s.sleeps = s.sleeps.filter((x) => x.id !== id); return s.sleeps.length === n ? NOOP : true; }, { id }) === true;
    },
    logCaffeine(partial) {
      return commit('logCaffeine', (s) => {
        const x = normalizeCaffeine(partial, { taken: idSet(s.caffeine) });
        s.caffeine.push(x);
        return structuredClone(x);
      });
    },
    removeCaffeine(id) {
      return commit('removeCaffeine', (s) => { const n = s.caffeine.length; s.caffeine = s.caffeine.filter((x) => x.id !== id); return s.caffeine.length === n ? NOOP : true; }, { id }) === true;
    },
    logCheckIn(partial) {
      return commit('logCheckIn', (s) => {
        const x = normalizeCheckIn(partial, { taken: idSet(s.checkins) });
        s.checkins.push(x);
        return structuredClone(x);
      });
    },
    removeCheckIn(id) {
      return commit('removeCheckIn', (s) => { const n = s.checkins.length; s.checkins = s.checkins.filter((x) => x.id !== id); return s.checkins.length === n ? NOOP : true; }, { id }) === true;
    },
    logFocus(session) {
      return commit('logFocus', (s) => {
        const x = normalizeFocus(session, { taken: idSet(s.focus) });
        s.focus.push(x);
        return structuredClone(x);
      });
    },

    setProfile(patch) {
      const clean = normalizeProfilePatch(patch, true);
      return commit('setProfile', (s) => {
        const next = { ...s.profile, ...clean };
        if (sameJSON(next, s.profile)) return NOOP;
        s.profile = next;
        return structuredClone(next);
      }, { key: 'setProfile' });
    },
    setPrefs(patch) {
      const clean = normalizePrefsPatch(patch, true);
      return commit('setPrefs', (s) => {
        const next = { ...s.prefs, ...clean };
        if (sameJSON(next, s.prefs)) return NOOP;
        s.prefs = next;
        return structuredClone(next);
      }, { key: 'setPrefs' });
    },
    setPlan(plan) {
      const clean = normalizePlan(plan, now());
      return commit('setPlan', (s) => {
        if (sameJSON(s.plan, clean)) return NOOP;
        s.plan = clean;
        return clean ? structuredClone(clean) : null;
      }, { key: 'setPlan' });
    },
    lockBlock(taskId, startMs, locked = true) {
      return commit('lockBlock', (s) => {
        const b = s.plan && s.plan.blocks.find((x) => x.taskId === taskId && x.startMs === startMs);
        if (!b) throw err('Bloc introuvable dans le planning.');
        if (locked !== false) b.locked = true; else delete b.locked;
        return structuredClone(b);
      });
    },

    loadState(next) { return applyImport(next, 'loadState'); },
    /** Charge un jeu de démonstration et le signale (prefs.demo = true). */
    loadDemo(demoState) {
      const raw = isObj(demoState) ? { ...demoState, prefs: { ...(isObj(demoState.prefs) ? demoState.prefs : {}), demo: true } } : demoState;
      if (!isObj(raw)) throw err('Jeu de démonstration invalide.');
      const migrated = migrateState(raw);
      const { state: clean } = normalizeState(migrated, { now: now(), tz });
      clean.prefs.demo = true;
      commit('loadDemo', (s) => { Object.assign(s, clean); });
    },
    resetAll() {
      const f = fresh();
      commit('resetAll', (s) => { Object.assign(s, f); });
    },

    exportJSON() { return JSON.stringify(exportObject(), null, 2); },
    importJSON(str) { return applyImport(parseJSONText(str), 'importJSON'); },
    exportEncrypted(pass) { return encryptJSON(exportObject(), pass); },
    async importEncrypted(str, pass) {
      const obj = await decryptJSON(str, pass); // rejette « Mot de passe incorrect ou données corrompues »
      return applyImport(obj, 'importEncrypted');
    },
  };

  // — undo / redo —
  const store = {
    ready: null,
    getState: () => state,
    subscribe(fn) {
      if (typeof fn !== 'function') throw err('Un abonné doit être une fonction.');
      subs.add(fn);
      return () => subs.delete(fn);
    },
    undo() {
      if (!past.length) return false;
      future.push(state);
      state = past.pop();
      lastCommit = null;
      notify({ type: 'undo' });
      scheduleSave();
      return true;
    },
    redo() {
      if (!future.length) return false;
      past.push(state);
      state = future.pop();
      lastCommit = null;
      notify({ type: 'redo' });
      scheduleSave();
      return true;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    actions,
    // — extensions —
    flush,
    info,
    destroy() {
      destroyed = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      for (const [target, ev, fn] of listeners) { try { target.removeEventListener(ev, fn); } catch { /* ignoré */ } }
      subs.clear();
    },
  };

  // — sauvegarde quand la page passe en arrière-plan —
  const listeners = [];
  const onHide = () => { if (!destroyed) flush(); };
  try {
    if (typeof document !== 'undefined' && document.addEventListener) {
      const fn = () => { if (document.visibilityState === 'hidden') onHide(); };
      document.addEventListener('visibilitychange', fn);
      listeners.push([document, 'visibilitychange', fn]);
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', onHide);
      listeners.push([window, 'pagehide', onHide]);
    }
  } catch { /* environnement sans DOM */ }

  // — chargement initial —
  store.ready = (async () => {
    let raw = null;
    try { raw = await be.load(); } catch (e) { info.loadError = err('Impossible de lire les données enregistrées sur cet appareil.'); info.loadError.cause = e; }
    if (typeof raw !== 'string' || !raw.trim() || mutated) return;
    try {
      const migrated = migrateState(JSON.parse(raw));
      const { state: clean, dropped } = normalizeState(migrated, { now: now(), tz });
      info.dropped = dropped;
      state = clean;
    } catch (e) {
      // Données illisibles ou d'une version future : on garde une copie de secours avant tout écrasement.
      info.loadError = e instanceof SyntaxError ? err('Les données enregistrées sont illisibles ; une copie de secours a été conservée.') : e;
      try { await be.saveBackup?.(raw); } catch { /* ignoré */ }
    }
    notify({ type: 'ready' });
  })();

  return store;
}
