// Utilitaires de temps partagés. Tout le modèle manipule des millisecondes epoch (UTC)
// et le « jour » est le jour civil LOCAL de l'appareil. Aucune dépendance.
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');

/** Minuit local du jour contenant `ms`. */
export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Ajoute `n` jours civils (sûr vis-à-vis des changements d'heure) et conserve l'heure locale. */
export function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Millisecondes pour l'heure locale `minutes` (depuis minuit) du jour de `dayMs`. */
export function atMinutes(dayMs, minutes) {
  const d = new Date(startOfDay(dayMs));
  d.setMinutes(minutes, 0, 0);
  return d.getTime();
}

/** Minutes depuis minuit local pour `ms`. */
export function minutesOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** "07:30" -> 450 */
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Heure invalide : ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 450 -> "07:30" */
export function toHHMM(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** epoch -> "14:05" (heure locale) */
export function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 90 -> "1 h 30", 45 -> "45 min", 120 -> "2 h" */
export function fmtDuration(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${pad(r)}` : `${h} h`;
}

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
// Abréviations usuelles (« janv. », « févr. », « sept. »…) : un simple slice(0, 4) donnerait « nove. ».
const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export const JOURS_FR = JOURS;
export const MOIS_FR = MOIS;

/** "lundi 23 novembre" */
export function fmtDateFR(ms, { year = false, short = false } = {}) {
  const d = new Date(ms);
  const j = short ? JOURS[d.getDay()].slice(0, 3) + '.' : JOURS[d.getDay()];
  const mo = short ? MOIS_COURTS[d.getMonth()] : MOIS[d.getMonth()];
  return `${j} ${d.getDate()} ${mo}${year ? ' ' + d.getFullYear() : ''}`;
}

/** "2026-11-22" (jour local) */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-11-22" -> minuit local en epoch */
export function fromDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Identifiant court, unique en pratique. */
export function uid(prefix = 'x') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
