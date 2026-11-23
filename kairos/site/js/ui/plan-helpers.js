// Fonctions PURES de la vue « Plan » : aucune dépendance au DOM, importables dans Node (tests node:test).
// Hypothèses :
// - Le temps est en millisecondes epoch ; un « jour » est le jour civil local (voir core/time.js).
// - La grille horaire est verticale : 1 minute = `ppm` pixels. Les positions sont calculées en minutes
//   depuis minuit local (les jours à 23 h / 25 h de changement d'heure sont approximés à 1440 min).
// - Les blocs persistés ne gardent que {taskId,startMs,endMs,score,reason,locked} : l'alerte moyenne,
//   l'adéquation et le « bloc i/n » sont donc recalculés ici à partir de la courbe d'énergie.
import {
  MIN, DAY, startOfDay, addDays, atMinutes, minutesOfDay, fmtTime, fmtDuration, fmtDateFR, dayKey, clamp,
  parseHHMM, JOURS_FR, MOIS_FR,
} from '../core/time.js';
import { fitScore, meanAlertMs, alertAt, LUNCH } from '../core/scheduler.js';

// ───────────────────────── Charge cognitive ─────────────────────────

export const LOAD_NAMES = ['', 'Routine', 'Léger', 'Soutenu', 'Exigeant', 'Concentration profonde'];
export const PRIO_NAMES = ['', 'Urgent', 'Important', 'Normal', 'Un jour'];

/** Variable CSS de la couleur d'une charge 1..5. */
export const loadVar = (load) => `var(--load-${clamp(Math.round(Number(load) || 3), 1, 5)})`;

/** Jauge à 5 segments : [true,true,true,false,false] pour une charge 3. */
export const loadMeter = (load) => { const n = clamp(Math.round(Number(load) || 0), 0, 5); return Array.from({ length: 5 }, (_, i) => i < n); };

/** Tonalité d'une adéquation 0..1. */
export function fitTone(fit) {
  if (fit >= 0.85) return 'great';
  if (fit >= 0.65) return 'good';
  if (fit >= 0.45) return 'ok';
  return 'poor';
}

/** Libellé court d'un niveau d'alerte 0..100. */
export function alertLabel(a) {
  if (a >= 80) return 'Pic';
  if (a >= 65) return 'Bonne forme';
  if (a >= 50) return 'Correcte';
  if (a >= 35) return 'Basse';
  return 'Creux';
}

// ───────────────────────── Fenêtre affichée ─────────────────────────

export const MAX_SEL = 27; // on peut regarder 4 semaines devant soi

export const clampSel = (sel) => clamp(Math.round(Number(sel) || 0), 0, MAX_SEL);
/** Décalage (en jours depuis aujourd'hui) du début de la semaine qui contient `sel`. */
export const weekOffset = (sel) => 7 * Math.floor(clampSel(sel) / 7);

/**
 * Jours affichés. Mode « week » : 7 jours consécutifs alignés sur aujourd'hui (la fenêtre du
 * planificateur) ; mode « day » : un seul jour. `sel` = jours depuis aujourd'hui.
 */
export function viewDays(nowMs, sel, mode = 'week') {
  const today = startOfDay(nowMs);
  const s = clampSel(sel);
  if (mode === 'day') return [addDays(today, s)];
  const off = weekOffset(s);
  return Array.from({ length: 7 }, (_, i) => addDays(today, off + i));
}

/** Les 7 jours de la bande de sélection (mode jour) autour de `sel`. */
export const stripDays = (nowMs, sel) => viewDays(nowMs, sel, 'week');

/** Pas de navigation (jours) selon le mode. */
export const navStep = (mode) => (mode === 'day' ? 1 : 7);

const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export const monthShort = (ms) => MOIS_COURTS[new Date(ms).getMonth()];
/** « ven. 27 nov. » (fmtDateFR court tronque mal les mois : on a notre propre abréviation). */
export const shortDate = (ms) => { const d = new Date(ms); return `${JOURS_FR[d.getDay()].slice(0, 3)}. ${d.getDate()} ${MOIS_COURTS[d.getMonth()]}`; };

/** « 23 – 29 novembre » ou « 28 nov. – 4 déc. ». */
export function weekTitle(days) {
  if (!days.length) return '';
  const a = new Date(days[0]), b = new Date(days[days.length - 1]);
  if (days.length === 1) return fmtDateFR(days[0]);
  const short = (d) => MOIS_COURTS[d.getMonth()];
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} – ${b.getDate()} ${MOIS_FR[b.getMonth()]}`;
  return `${a.getDate()} ${short(a)} – ${b.getDate()} ${short(b)}`;
}

/** {dow:'LUN', num:23, month:'nov.', long:'lundi'} pour l'en-tête d'un jour. */
export function dayHead(dayMs) {
  const d = new Date(dayMs);
  return { dow: JOURS_FR[d.getDay()].slice(0, 3).toUpperCase(), num: d.getDate(), month: MOIS_COURTS[d.getMonth()], long: JOURS_FR[d.getDay()] };
}

// ───────────────────────── Géométrie de la grille ─────────────────────────

/** Découpe un intervalle [startMs,endMs] sur le jour `dayMs` : {startMin,endMin} ou null. */
export function clipToDay(startMs, endMs, dayMs) {
  const next = addDays(dayMs, 1);
  if (endMs <= dayMs || startMs >= next) return null;
  const startMin = startMs <= dayMs ? 0 : minutesOfDay(startMs);
  const endMin = endMs >= next ? 1440 : minutesOfDay(endMs);
  if (endMin <= startMin) return null;
  return { startMin, endMin };
}

/**
 * Plage horaire visible (en minutes, alignée sur l'heure) : plages de travail élargies pour montrer
 * le matin et la soirée, étendues pour contenir tout bloc / événement des jours affichés.
 */
export function visibleRange({ profile = {}, blocks = [], events = [], days = [] } = {}) {
  const safe = (s, d) => { try { return parseHHMM(s); } catch { return d; } };
  const ws = safe(profile.workStart, 9 * 60), we = safe(profile.workEnd, 18 * 60);
  let lo = Math.floor((ws - 90) / 60) * 60;
  let hi = Math.ceil((we + 120) / 60) * 60;
  if (we <= ws) { lo = 7 * 60; hi = 21 * 60; } // poste de nuit : on montre simplement la journée
  const items = [...blocks, ...events.filter((e) => !e.allDay)];
  for (const it of items) {
    for (const d of days) {
      const c = clipToDay(it.startMs, it.endMs, d);
      if (!c) continue;
      lo = Math.min(lo, Math.floor(c.startMin / 60) * 60);
      hi = Math.max(hi, Math.ceil(c.endMin / 60) * 60);
    }
  }
  lo = clamp(lo, 0, 1440 - 480);
  hi = clamp(hi, lo + 480, 1440);
  return { startMin: lo, endMin: hi, span: hi - lo };
}

/** Étiquettes d'heures [{min,label}] pour la gouttière. */
export function hourLabels(range) {
  const out = [];
  for (let m = range.startMin; m <= range.endMin; m += 60) out.push({ min: m, label: `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:00` });
  return out;
}

/** Ordonnée (en minutes depuis le haut de la plage) d'une minute-du-jour. */
export const minToOffset = (min, range) => min - range.startMin;

/** Position pixel d'une minute-du-jour. */
export const minToY = (min, range, ppm) => (min - range.startMin) * ppm;

/** y (px depuis le haut du corps du jour) -> minute-du-jour, alignée sur `snap` minutes. */
export function yToMin(y, range, ppm, snap = 5) {
  const raw = range.startMin + y / ppm;
  return Math.round(raw / snap) * snap;
}

/** Début (ms) d'un bloc déposé : `dayMs` + minute-du-jour du haut du bloc, alignée sur `snap`. */
export function slotStartMs(dayMs, topMin, snap = 5) {
  const m = Math.round(topMin / snap) * snap;
  return atMinutes(dayMs, m);
}

/**
 * Répartition en colonnes d'éléments qui se chevauchent : renvoie [{...item, col, cols}].
 * Les éléments doivent porter startMin / endMin.
 */
export function layoutColumns(items) {
  const sorted = items.map((it, i) => ({ ...it, _i: i })).sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const colsEnd = [];
    for (const it of cluster) {
      let c = colsEnd.findIndex((e) => e <= it.startMin);
      if (c < 0) { c = colsEnd.length; colsEnd.push(0); }
      colsEnd[c] = it.endMin;
      it.col = c;
    }
    for (const it of cluster) it.cols = colsEnd.length;
    out.push(...cluster);
    cluster = []; clusterEnd = -1;
  };
  for (const it of sorted) {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    cluster.push(it); clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  flush();
  return out.sort((a, b) => a._i - b._i).map(({ _i, ...rest }) => rest);
}

// ───────────────────────── Courbe d'énergie en arrière-plan ─────────────────────────

/** Échantillons d'alerte [{min, v}] sur la plage visible d'un jour (pas de `stepMin`). */
export function energySamples(curve, dayMs, range, stepMin = 10) {
  const out = [];
  if (!curve || !curve.alert || !curve.alert.length) return out;
  for (let m = range.startMin; m <= range.endMin; m += stepMin) out.push({ min: m, v: alertAt(curve, atMinutes(dayMs, m)) });
  if (out.length && out[out.length - 1].min !== range.endMin) out.push({ min: range.endMin, v: alertAt(curve, atMinutes(dayMs, range.endMin)) });
  return out;
}

/**
 * Dégradé vertical « halo » : or lumineux dans les pics, bleu froid dans les creux, transparent entre
 * les deux. Utilise color-mix sur les variables du thème (clair et sombre).
 */
export function haloGradient(samples, range) {
  if (!samples.length) return 'none';
  const span = range.endMin - range.startMin;
  const stops = samples.map((s) => {
    const pos = ((s.min - range.startMin) / span) * 100;
    let col;
    if (s.v >= 55) col = `color-mix(in srgb, var(--sun) ${Math.round(((s.v - 55) / 45) * 24 + 1)}%, transparent)`;
    else col = `color-mix(in srgb, var(--dip) ${Math.round(((55 - s.v) / 55) * 22 + 1)}%, transparent)`;
    return `${col} ${pos.toFixed(1)}%`;
  });
  return `linear-gradient(180deg, ${stops.join(', ')})`;
}

/**
 * Chemins SVG de la silhouette d'énergie. Repère : x = alerte 0..100 (depuis la gauche), y = minutes
 * depuis le haut de la plage. Renvoie { area, line } à utiliser avec viewBox="0 0 100 span".
 */
export function energyPaths(samples, range) {
  if (!samples.length) return { area: '', line: '' };
  const pts = samples.map((s) => [clamp(s.v, 0, 100), s.min - range.startMin]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y}`).join(' ');
  const span = range.endMin - range.startMin;
  return { line, area: `M0 0 L${pts.map(([x, y]) => `${x.toFixed(2)} ${y}`).join(' L')} L0 ${span} Z` };
}

/** Fenêtres « prime time » d'un modèle découpées sur un jour : [{startMin,endMin,mean}]. */
export function goldenBands(model, dayMs) {
  const g = model && model.stats && model.stats.goldenWindows;
  if (!Array.isArray(g)) return [];
  const out = [];
  for (const w of g) { const c = clipToDay(w.startMs, w.endMs, dayMs); if (c) out.push({ ...c, mean: w.mean }); }
  return out;
}

// ───────────────────────── Plages de travail, capacité, charge ─────────────────────────

/** {isWorkDay,startMin,endMin,lunch} pour un jour. */
export function workBand(profile = {}, dayMs, protectLunch = true) {
  const safe = (s, d) => { try { return parseHHMM(s); } catch { return d; } };
  const days = Array.isArray(profile.workDays) ? profile.workDays : [1, 2, 3, 4, 5];
  const startMin = safe(profile.workStart, 540), endMin = safe(profile.workEnd, 1080);
  const isWorkDay = days.includes(new Date(dayMs).getDay()) && endMin > startMin;
  return { isWorkDay, startMin, endMin, lunch: protectLunch ? { startMin: LUNCH.startMin, endMin: LUNCH.endMin } : null };
}

/** Minutes de travail disponibles un jour (déjeuner protégé retiré). */
export function capacityMin(profile, dayMs, protectLunch = true) {
  const w = workBand(profile, dayMs, protectLunch);
  if (!w.isWorkDay) return 0;
  let cap = w.endMin - w.startMin;
  if (w.lunch) cap -= Math.max(0, Math.min(w.endMin, w.lunch.endMin) - Math.max(w.startMin, w.lunch.startMin));
  return Math.max(0, cap);
}

/** Minutes d'événements horodatés qui tombent dans les plages de travail (déjeuner exclu) d'un jour. */
export function eventWorkOverlap(events, profile, dayMs, protectLunch = true) {
  const w = workBand(profile, dayMs, protectLunch);
  if (!w.isWorkDay) return 0;
  let segs = [[w.startMin, w.endMin]];
  if (w.lunch) segs = segs.flatMap(([a, b]) => (w.lunch.endMin <= a || w.lunch.startMin >= b ? [[a, b]] : [[a, Math.max(a, w.lunch.startMin)], [Math.min(b, w.lunch.endMin), b]].filter(([x, y]) => y > x)));
  let total = 0;
  for (const e of events) {
    if (e.allDay) continue;
    const c = clipToDay(e.startMs, e.endMs, dayMs);
    if (!c) continue;
    for (const [a, b] of segs) total += Math.max(0, Math.min(b, c.endMin) - Math.max(a, c.startMin));
  }
  return total;
}

const minutesOf = (b) => Math.max(0, Math.round((b.endMs - b.startMs) / MIN));

/** Alerte moyenne, adéquation et tonalité d'un bloc. */
export function blockMetrics(block, task, curve) {
  const alert = curve && curve.alert && curve.alert.length ? meanAlertMs(curve, block.startMs, block.endMs) : 50;
  const fit = fitScore(task ? task.load : 3, alert);
  return { alert: Math.round(alert), fit, score: Math.round(fit * 100), tone: fitTone(fit) };
}

/** Numéro de bloc « i/n » par tâche : Map clé `${taskId}@${startMs}` -> {part, parts}. */
export function annotateParts(blocks) {
  const byTask = new Map();
  for (const b of [...blocks].sort((x, y) => x.startMs - y.startMs)) {
    if (!byTask.has(b.taskId)) byTask.set(b.taskId, []);
    byTask.get(b.taskId).push(b);
  }
  const out = new Map();
  for (const list of byTask.values()) list.forEach((b, i) => out.set(blockKey(b), { part: i + 1, parts: list.length }));
  return out;
}

export const blockKey = (b) => `${b.taskId}@${b.startMs}`;

/** Minutes planifiées un jour, réparties par charge : {byLoad:[l1..l5], total, events}. */
export function dayLoad(blocks, tasks, dayMs, events = []) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const byLoad = [0, 0, 0, 0, 0];
  let total = 0;
  for (const b of blocks) {
    const c = clipToDay(b.startMs, b.endMs, dayMs);
    if (!c) continue;
    const m = c.endMin - c.startMin;
    const t = byId.get(b.taskId);
    byLoad[clamp((t ? t.load : 3) - 1, 0, 4)] += m;
    total += m;
  }
  let ev = 0;
  for (const e of events) { if (e.allDay) continue; const c = clipToDay(e.startMs, e.endMs, dayMs); if (c) ev += c.endMin - c.startMin; }
  return { byLoad, total, events: ev };
}

/** Minutes de travail profond (charge ≥ 4) placées dans une zone de forte alerte (moyenne ≥ 62 : « bonne forme » ou mieux). */
export function deepInPeaks({ blocks, tasks, curve, peakThreshold = 62, deepLoad = 4 }) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let deepMin = 0, peakMin = 0;
  for (const b of blocks) {
    const t = byId.get(b.taskId);
    if (!t || t.load < deepLoad) continue;
    const m = minutesOf(b);
    deepMin += m;
    if (meanAlertMs(curve, b.startMs, b.endMs) >= peakThreshold) peakMin += m;
  }
  return { deepMin, peakMin, ratio: deepMin ? peakMin / deepMin : 0 };
}

/** Résumé du plan : minutes placées et adéquation moyenne (pondérée par la durée). */
export function summarizePlan({ blocks, tasks, curve }) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let placed = 0, fitSum = 0;
  for (const b of blocks) {
    const m = minutesOf(b); placed += m;
    fitSum += m * fitScore(byId.get(b.taskId)?.load ?? 3, meanAlertMs(curve, b.startMs, b.endMs));
  }
  return { placedMin: placed, meanFit: placed ? fitSum / placed : 0, count: blocks.length };
}

// ───────────────────────── Tâches : restant, tri, filtres, échéances ─────────────────────────

/** Minutes de la tâche qui ne sont couvertes par aucun bloc. */
export function remainingMin(task, blocks) {
  if (task.done) return 0;
  const placed = blocks.filter((b) => b.taskId === task.id).reduce((s, b) => s + minutesOf(b), 0);
  return Math.max(0, task.durMin - placed);
}

/** Tâches actives dont une part (≥ 5 min) n'est pas placée : [{taskId, minutes}]. */
export function unplacedFromPlan(tasks, blocks) {
  const out = [];
  for (const t of tasks) { const r = remainingMin(t, blocks); if (r >= 5) out.push({ taskId: t.id, minutes: r }); }
  return out;
}

/** Échéance relative : {text, tone: 'late'|'soon'|'warm'|'calm', days}. */
export function dueInfo(deadlineMs, nowMs) {
  if (deadlineMs == null) return null;
  if (deadlineMs < nowMs) {
    const late = Math.floor((nowMs - deadlineMs) / DAY);
    return { text: late >= 1 ? `en retard de ${late} j` : 'en retard', tone: 'late', days: -Math.max(1, late) };
  }
  const d = Math.round((startOfDay(deadlineMs) - startOfDay(nowMs)) / DAY);
  if (d === 0) return { text: `aujourd'hui ${fmtTime(deadlineMs)}`, tone: 'soon', days: 0 };
  if (d === 1) return { text: `demain ${fmtTime(deadlineMs)}`, tone: 'soon', days: 1 };
  return { text: `dans ${d} j`, tone: d <= 3 ? 'warm' : 'calm', days: d };
}

/** Tri : à faire d'abord, priorité (1 = urgent), puis échéance la plus proche, puis ancienneté. */
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    const da = a.deadlineMs ?? Infinity, db = b.deadlineMs ?? Infinity;
    if (da !== db) return da - db;
    return (a.createdMs || 0) - (b.createdMs || 0);
  });
}

export const FILTERS = [
  { id: 'all', label: 'Tout' },
  { id: 'todo', label: 'À faire' },
  { id: 'late', label: 'En retard' },
  { id: 'deep', label: 'Profondes' },
  { id: 'done', label: 'Faites' },
];

export function matchFilter(task, filter, nowMs) {
  switch (filter) {
    case 'todo': return !task.done;
    case 'done': return !!task.done;
    case 'late': return !task.done && task.deadlineMs != null && task.deadlineMs < nowMs;
    case 'deep': return !task.done && task.load >= 4;
    default: return true;
  }
}

export const filterTasks = (tasks, filter, nowMs) => tasks.filter((t) => matchFilter(t, filter, nowMs));

export function countFilters(tasks, nowMs) {
  const c = {};
  for (const f of FILTERS) c[f.id] = tasks.filter((t) => matchFilter(t, f.id, nowMs)).length;
  return c;
}

export const GROUPS = [
  { id: 'none', label: 'Liste' },
  { id: 'day', label: 'Échéance' },
  { id: 'tag', label: 'Tag' },
];

/** Regroupe des tâches DÉJÀ triées : [{key,label,items}] dans un ordre stable et lisible. */
export function groupTasks(tasks, mode, nowMs) {
  if (mode === 'day') {
    const order = ['late', 'today', 'tomorrow', 'week', 'later', 'none', 'done'];
    const label = { late: 'En retard', today: 'Aujourd\'hui', tomorrow: 'Demain', week: 'Cette semaine', later: 'Plus tard', none: 'Sans échéance', done: 'Faites' };
    const bucket = (t) => {
      if (t.done) return 'done';
      if (t.deadlineMs == null) return 'none';
      if (t.deadlineMs < nowMs) return 'late';
      const d = Math.round((startOfDay(t.deadlineMs) - startOfDay(nowMs)) / DAY);
      return d === 0 ? 'today' : d === 1 ? 'tomorrow' : d <= 7 ? 'week' : 'later';
    };
    return bucketize(tasks, bucket, order, label);
  }
  if (mode === 'tag') {
    const tagOf = (t) => (t.tags && t.tags[0]) || '';
    const tags = [...new Set(tasks.map(tagOf))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'fr'));
    const order = [...tags, ''];
    const label = Object.fromEntries(order.map((k) => [k, k ? `#${k}` : 'Sans tag']));
    return bucketize(tasks, tagOf, order, label);
  }
  return [{ key: 'all', label: '', items: tasks }];
}

function bucketize(tasks, keyOf, order, label) {
  const map = new Map(order.map((k) => [k, []]));
  for (const t of tasks) { const k = keyOf(t); (map.get(k) || map.set(k, []).get(k)).push(t); }
  return order.filter((k) => map.get(k).length).map((k) => ({ key: k, label: label[k], items: map.get(k) }));
}

// ───────────────────────── Saisie rapide ─────────────────────────

/** Découpe `text` selon les jetons de parseEntry : [{text, type|null}] (jetons recoupés ignorés). */
export function tokenSegments(text, tokens = []) {
  const toks = [...tokens].filter((t) => t && t.end > t.start).sort((a, b) => a.start - b.start);
  const out = [];
  let pos = 0;
  for (const t of toks) {
    if (t.start < pos) continue;
    if (t.start > pos) out.push({ text: text.slice(pos, t.start), type: null });
    out.push({ text: text.slice(t.start, t.end), type: t.type });
    pos = t.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), type: null });
  return out;
}

function dayWord(ms, nowMs) {
  const d = Math.round((startOfDay(ms) - startOfDay(nowMs)) / DAY);
  if (d === 0) return 'aujourd\'hui';
  if (d === 1) return 'demain';
  return shortDate(ms);
}

/**
 * Résumé lisible d'une saisie analysée :
 * { kind:'task'|'event', label:'Tâche'|'Événement', title, parts:[{type,text}], ok }
 * « Tâche : Finir le rapport · 2 h · charge 4 · avant ven. 17:00 ».
 */
export function describeParsed(p, nowMs) {
  if (!p || !String(p.title || '').trim()) return { kind: p?.kind || 'task', label: p?.kind === 'event' ? 'Événement' : 'Tâche', title: '', parts: [], ok: false };
  const parts = [];
  if (p.kind === 'event') {
    if (p.startMs != null) {
      const end = p.endMs != null ? `–${fmtTime(p.endMs)}` : '';
      parts.push({ type: 'date', text: `${dayWord(p.startMs, nowMs)} ${fmtTime(p.startMs)}${end}` });
      if (p.endMs != null) parts.push({ type: 'duration', text: fmtDuration(Math.round((p.endMs - p.startMs) / MIN)) });
    }
  } else {
    if (p.durMin) parts.push({ type: 'duration', text: fmtDuration(p.durMin) });
    if (p.load) parts.push({ type: 'load', text: `charge ${p.load}` });
    if (p.priority && p.priority < 3) parts.push({ type: 'priority', text: PRIO_NAMES[p.priority].toLowerCase() });
    if (p.deadlineMs != null) parts.push({ type: 'date', text: `avant ${dayWord(p.deadlineMs, nowMs)} ${fmtTime(p.deadlineMs)}` });
    if (p.earliestMs != null) parts.push({ type: 'date', text: `dès ${dayWord(p.earliestMs, nowMs)} ${fmtTime(p.earliestMs)}` });
  }
  for (const t of p.tags || []) parts.push({ type: 'tag', text: `#${t}` });
  return { kind: p.kind, label: p.kind === 'event' ? 'Événement' : 'Tâche', title: String(p.title).trim(), parts, ok: true };
}

/** Objet prêt pour actions.addTask / actions.addEvent à partir d'une saisie analysée (ou null). */
export function entryToItem(p) {
  if (!p || !String(p.title || '').trim()) return null;
  if (p.kind === 'event' && p.startMs != null) {
    return { kind: 'event', data: { title: p.title.trim(), startMs: p.startMs, endMs: p.endMs != null && p.endMs > p.startMs ? p.endMs : p.startMs + 60 * MIN, source: 'manual' } };
  }
  const data = { title: p.title.trim(), durMin: p.durMin || 30, load: p.load || 3, priority: p.priority || 3, tags: p.tags || [] };
  if (p.deadlineMs != null) data.deadlineMs = p.deadlineMs;
  if (p.earliestMs != null) data.earliestMs = p.earliestMs;
  return { kind: 'task', data };
}

// ───────────────────────── Glisser-déposer & gestes ─────────────────────────

/**
 * Décide ce que devient un appui : 'drag' | 'longpress' | 'cancel' | 'pending'.
 * - souris / stylet : glisser dès 4 px ;
 * - tactile sur la poignée (touch-action:none) : glisser dès 3 px ;
 * - tactile ailleurs : bouger de plus de 10 px = défilement (annule) ; appui ≥ 500 ms = édition.
 */
export function gestureStep({ pointerType = 'mouse', onGrip = false, dx = 0, dy = 0, elapsedMs = 0 }) {
  const dist = Math.hypot(dx, dy);
  if (pointerType !== 'touch') return dist > 4 ? 'drag' : 'pending';
  if (onGrip) return dist > 3 ? 'drag' : 'pending';
  if (dist > 10) return 'cancel';
  return elapsedMs >= 500 ? 'longpress' : 'pending';
}

/** Balayage horizontal : 'next' (vers la gauche) | 'prev' | null. */
export function swipeIntent({ dx = 0, dy = 0, dt = 1 }) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < 30 || ax < ay * 1.5) return null;
  const speed = ax / Math.max(1, dt);
  if (ax < 64 && speed < 0.5) return null;
  return dx < 0 ? 'next' : 'prev';
}

/** Déplacement clavier : flèches ↑↓ = ±15 min (Maj = ±60), ←→ = jour précédent / suivant. */
export function keyMove(key, shift = false) {
  switch (key) {
    case 'ArrowUp': return { dMin: shift ? -60 : -15, dDay: 0 };
    case 'ArrowDown': return { dMin: shift ? 60 : 15, dDay: 0 };
    case 'ArrowLeft': return { dMin: 0, dDay: -1 };
    case 'ArrowRight': return { dMin: 0, dDay: 1 };
    default: return null;
  }
}

/** time.js abrège mal certains mois (« nove. ») : on corrige les textes venus du planificateur. */
export const fixMonths = (t) => String(t || '').replace(/\bavri\./g, 'avr.').replace(/\bocto\./g, 'oct.').replace(/\bnove\./g, 'nov.').replace(/\bdéce\./g, 'déc.');

/**
 * Verdict affichable d'un résultat de validateMove :
 * { tone: 'good'|'bad'|'same'|'refused', headline, detail }.
 */
export function moveVerdict(res) {
  if (!res) return { tone: 'refused', headline: 'Indisponible', detail: '' };
  if (!res.ok) return { tone: 'refused', headline: 'Impossible ici', detail: fixMonths(res.why) };
  const d = res.deltaScore || 0;
  if (d > 0) return { tone: 'good', headline: `+${d} pts`, detail: fixMonths(res.reason) };
  if (d < 0) return { tone: 'bad', headline: `−${Math.abs(d)} pts`, detail: fixMonths(res.reason) };
  return { tone: 'same', headline: '= même adéquation', detail: fixMonths(res.reason) };
}

/** Plan après déplacement : le bloc devient verrouillé (la main de l'utilisateur prime). */
export function applyMove(blocks, block, res) {
  const out = blocks.map((b) => (b.taskId === block.taskId && b.startMs === block.startMs && b.endMs === block.endMs
    ? { ...b, startMs: res.startMs, endMs: res.endMs, score: res.score ?? b.score, reason: res.reason || b.reason, locked: true }
    : b));
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Plan sans un bloc. */
export const withoutBlock = (blocks, block) => blocks.filter((b) => !(b.taskId === block.taskId && b.startMs === block.startMs));

// ───────────────────────── Import / export ─────────────────────────

/** Fenêtre d'import d'un .ics : [aujourd'hui − 1 jour ; +60 jours]. */
export function icsRange(nowMs) {
  const today = startOfDay(nowMs);
  return { fromMs: addDays(today, -1), toMs: addDays(today, 60) };
}

/** Le plan en texte brut (à coller dans un message), jour par jour. */
export function planToText({ blocks, tasks, nowMs }) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (!blocks.length) return 'Aucun bloc planifié.';
  const days = new Map();
  for (const b of [...blocks].sort((a, c) => a.startMs - c.startMs)) {
    const k = dayKey(b.startMs);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(b);
  }
  const lines = [`Plan Kairos — généré le ${fmtDateFR(nowMs)} à ${fmtTime(nowMs)}`];
  for (const [, list] of days) {
    lines.push('', fmtDateFR(list[0].startMs).replace(/^./, (c) => c.toUpperCase()));
    for (const b of list) {
      const t = byId.get(b.taskId);
      lines.push(`  ${fmtTime(b.startMs)}–${fmtTime(b.endMs)}  ${t ? t.title : 'Tâche supprimée'}${t ? ` (charge ${t.load})` : ''}${b.locked ? ' (verrouillé)' : ''}`);
    }
  }
  return lines.join('\n');
}

/** Nom de fichier .ics daté. */
export const icsFileName = (nowMs) => `kairos-plan-${dayKey(nowMs)}.ics`;

/** Pluriel français simple : plural(2, 'événement') → « 2 événements ». */
export const plural = (n, word, pl = `${word}s`) => `${n} ${n > 1 ? pl : word}`;
