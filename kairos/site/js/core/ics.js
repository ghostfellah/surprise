// ics.js — lecture et écriture d'iCalendar (RFC 5545), sans dépendance, Node 22 + navigateur.
//
// Hypothèses et limites :
//  - parseICS lit les VEVENT (les VTODO/VJOURNAL/VALARM sont ignorés). Dates : « Z » (UTC), flottantes (heure
//    locale de l'appareil), TZID converti via Intl (noms IANA, noms Windows courants d'Outlook, préfixes
//    Mozilla « /mozilla.org/… »). Fuseau inconnu => heure locale de l'appareil.
//  - VALUE=DATE => événement « journée entière » (DTEND exclusif, comme dans la norme).
//  - Récurrences : FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (avec rang pour MONTHLY :
//    2MO, -1FR), BYMONTHDAY, BYMONTH, BYSETPOS, WKST, EXDATE, RDATE, RECURRENCE-ID (instances modifiées/annulées).
//    FREQ=HOURLY/MINUTELY/SECONDLY ne sont pas développées (une seule occurrence). Les occurrences gardent
//    leur heure murale locale à travers les changements d'heure (9:00 reste 9:00).
//  - Expansion bornée à [fromMs, toMs] (recouvrement) avec un garde-fou de 2000 occurrences par série.
//    Sans toMs, la borne haute est « maintenant + 400 jours » ; sans fromMs, aucune borne basse.
//  - Un événement sans DTEND ni DURATION dure 30 min (journée entière : 1 jour).
//  - buildICS écrit les heures en UTC (« Z »), sauf les journées entières (VALUE=DATE) ; lignes pliées à 75 octets,
//    séparateur CRLF, échappement de \ ; , et des retours à la ligne.
import { DAY, MIN } from './time.js';

const MAX_OCCURRENCES = 2000; // garde-fou par série
const MAX_STEPS = 60_000; // garde-fou sur le nombre de périodes parcourues

// ───────────────────────── Lignes ─────────────────────────

/** Déplie les lignes (RFC 5545 §3.1) : un CRLF suivi d'un espace/tabulation prolonge la ligne précédente. */
export function unfoldLines(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((l) => l.length > 0);
}

/** Sépare « NOM;PARAM=x;PARAM2="a:b":valeur » en { name, params, value } sans se faire piéger par les guillemets. */
function parseLine(line) {
  let inQ = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = [];
  let cur = '';
  inQ = false;
  for (const c of head) {
    if (c === '"') inQ = !inQ;
    if (c === ';' && !inQ) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const name = parts.shift().trim().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

const unescapeText = (s) => s.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

// ───────────────────────── Fuseaux (Intl) ─────────────────────────

// Noms Windows (Outlook/Exchange) -> IANA.
const WINDOWS_TZ = {
  'Romance Standard Time': 'Europe/Paris', 'W. Europe Standard Time': 'Europe/Berlin', 'GMT Standard Time': 'Europe/London',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev', 'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow', 'Turkey Standard Time': 'Europe/Istanbul', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles', 'US Mountain Standard Time': 'America/Phoenix', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'Newfoundland Standard Time': 'America/St_Johns',
  'Canada Central Standard Time': 'America/Regina', 'Central America Standard Time': 'America/Guatemala', 'Mexico Standard Time': 'America/Mexico_City',
  'SA Pacific Standard Time': 'America/Bogota', 'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Pacific SA Standard Time': 'America/Santiago', 'W. Central Africa Standard Time': 'Africa/Lagos', 'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo', 'Morocco Standard Time': 'Africa/Casablanca', 'Israel Standard Time': 'Asia/Jerusalem',
  'Arab Standard Time': 'Asia/Riyadh', 'Arabian Standard Time': 'Asia/Dubai', 'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul', 'Singapore Standard Time': 'Asia/Singapore', 'SE Asia Standard Time': 'Asia/Bangkok',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'E. Australia Standard Time': 'Australia/Brisbane', 'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC': 'UTC', 'GMT': 'UTC', 'Coordinated Universal Time': 'UTC',
};

const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const tzCache = new Map();

/** Nom de fuseau quelconque -> nom IANA valide, ou null. */
function resolveTz(raw) {
  if (!raw) return null;
  if (tzCache.has(raw)) return tzCache.get(raw);
  let out = null;
  const cands = [raw, raw.replace(/ /g, '_'), WINDOWS_TZ[raw]];
  const segs = raw.split('/').filter(Boolean);
  for (let n = 3; n >= 1; n--) if (segs.length >= n) cands.push(segs.slice(-n).join('/')); // « /mozilla.org/2005/Europe/Paris »
  for (const c of cands) if (c && validTz(c)) { out = c; break; }
  tzCache.set(raw, out);
  return out;
}

const fmtCache = new Map();
function tzOffsetMs(tz, ms) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmtCache.set(tz, f);
  }
  const p = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Heure murale (dans le fuseau `tz`) -> epoch. Gère les trous/doublons de changement d'heure. */
function wallToMsInTz(tz, y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  const off = tzOffsetMs(tz, guess);
  let ms = guess - off;
  const off2 = tzOffsetMs(tz, ms);
  if (off2 !== off) ms = guess - off2;
  return ms;
}

/** Une « zone » sait convertir une heure murale en epoch : UTC, fuseau IANA ou heure locale de l'appareil. */
const zoneUTC = { toMs: (y, mo, d, h, mi, s) => Date.UTC(y, mo, d, h, mi, s) };
const zoneLocal = { toMs: (y, mo, d, h, mi, s) => new Date(y, mo, d, h, mi, s).getTime() };
const zoneTz = (tz) => ({ toMs: (y, mo, d, h, mi, s) => wallToMsInTz(tz, y, mo, d, h, mi, s) });

// ───────────────────────── Dates iCal ─────────────────────────

/**
 * Valeur iCal -> { y, mo, d, h, mi, s, dateOnly, utc } ou null.
 * « 20261122 », « 20261122T140000 », « 20261122T140000Z ».
 */
function parseDateValue(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(String(v).trim());
  if (!m) return null;
  const r = { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0), dateOnly: m[4] === undefined, utc: !!m[7] };
  if (r.mo > 11 || r.d < 1 || r.d > 31 || r.h > 24 || r.mi > 59 || r.s > 60) return null;
  return r;
}

/** Choisit la zone d'une propriété date selon Z / TZID / flottant. */
function zoneFor(dv, params, defaultTz) {
  if (dv.utc) return zoneUTC;
  // TZID inconnu : on retombe sur X-WR-TIMEZONE si présent, sinon sur l'heure locale de l'appareil.
  const tz = params.TZID ? resolveTz(params.TZID) || defaultTz : null;
  return tz ? zoneTz(tz) : zoneLocal;
}

const dayNum = (y, mo, d) => Math.round(Date.UTC(y, mo, d) / DAY);
const fromDayNum = (dn) => { const t = new Date(dn * DAY); return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate(), wd: t.getUTCDay() }; };

/** Durée iCal « P1DT2H30M », « -PT15M », « P2W » -> ms (null si invalide). */
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(v).trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + (+m[4] || 0) * 3_600_000 + (+m[5] || 0) * MIN + (+m[6] || 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// ───────────────────────── Récurrences ─────────────────────────

const WD_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(value) {
  const r = { freq: null, interval: 1, count: null, until: null, byday: [], bymonthday: [], bymonth: [], bysetpos: [], wkst: 1 };
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim().toUpperCase();
    const v = part.slice(eq + 1).trim().toUpperCase();
    const ints = () => v.split(',').map(Number).filter((n) => Number.isInteger(n));
    if (k === 'FREQ') r.freq = v;
    else if (k === 'INTERVAL') r.interval = Math.max(1, parseInt(v, 10) || 1);
    else if (k === 'COUNT') r.count = Math.max(0, parseInt(v, 10) || 0);
    else if (k === 'UNTIL') r.until = v;
    else if (k === 'BYDAY') {
      for (const t of v.split(',')) {
        const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(t.trim());
        if (m) r.byday.push({ n: m[1] ? parseInt(m[1], 10) : 0, wd: WD_CODES[m[2]] });
      }
    } else if (k === 'BYMONTHDAY') r.bymonthday = ints();
    else if (k === 'BYMONTH') r.bymonth = ints().filter((n) => n >= 1 && n <= 12);
    else if (k === 'BYSETPOS') r.bysetpos = ints();
    else if (k === 'WKST' && v in WD_CODES) r.wkst = WD_CODES[v];
  }
  return r;
}

const daysIn = (y, mo) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();

/** Jours (1..31) d'un mois qui satisfont BYDAY / BYMONTHDAY / BYSETPOS ; `baseDay` = jour de DTSTART. */
function monthDays(y, mo, rule, baseDay) {
  const n = daysIn(y, mo);
  let days = [];
  const wdOf = (d) => new Date(Date.UTC(y, mo, d)).getUTCDay();
  if (rule.byday.length && !rule.bymonthday.length) {
    for (const { n: ord, wd } of rule.byday) {
      const all = [];
      for (let d = 1; d <= n; d++) if (wdOf(d) === wd) all.push(d);
      if (ord === 0) days.push(...all);
      else {
        const pick = ord > 0 ? all[ord - 1] : all[all.length + ord];
        if (pick) days.push(pick);
      }
    }
  } else {
    const list = rule.bymonthday.length ? rule.bymonthday : [baseDay];
    for (const x of list) {
      const d = x > 0 ? x : n + 1 + x;
      if (d >= 1 && d <= n) days.push(d);
    }
    if (rule.byday.length) days = days.filter((d) => rule.byday.some((b) => b.wd === wdOf(d)));
  }
  days = [...new Set(days)].sort((a, b) => a - b);
  if (rule.bysetpos.length) {
    days = [...new Set(rule.bysetpos.map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter((d) => d))].sort((a, b) => a - b);
  }
  return days;
}

/**
 * Génère, dans l'ordre, les numéros de jour (heure murale) des occurrences candidates, à partir de la période
 * contenant `skipTo` (si la règle n'a pas de COUNT) pour ne pas parcourir des années pour rien.
 */
function* candidateDays(rule, base, skipTo) {
  const fast = rule.count == null;
  if (rule.freq === 'DAILY') {
    let k = fast ? Math.max(0, Math.floor((skipTo - base.dn) / rule.interval) - 1) : 0;
    for (let steps = 0; steps < MAX_STEPS; steps++, k++) {
      const dn = base.dn + k * rule.interval;
      const { wd, mo, d } = fromDayNum(dn);
      if (rule.byday.length && !rule.byday.some((b) => b.wd === wd)) continue;
      if (rule.bymonthday.length && !rule.bymonthday.includes(d)) continue;
      if (rule.bymonth.length && !rule.bymonth.includes(mo + 1)) continue;
      yield dn;
    }
  } else if (rule.freq === 'WEEKLY') {
    const baseWd = fromDayNum(base.dn).wd;
    const weekStart0 = base.dn - ((baseWd - rule.wkst + 7) % 7);
    const wds = rule.byday.length ? [...new Set(rule.byday.map((b) => b.wd))] : [baseWd];
    const offsets = wds.map((wd) => (wd - rule.wkst + 7) % 7).sort((a, b) => a - b);
    let k = fast ? Math.max(0, Math.floor((skipTo - weekStart0) / (7 * rule.interval)) - 1) : 0;
    for (let steps = 0; steps < MAX_STEPS; steps++, k++) {
      const ws = weekStart0 + k * 7 * rule.interval;
      for (const o of offsets) if (ws + o >= base.dn) yield ws + o;
    }
  } else if (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') {
    const yearly = rule.freq === 'YEARLY';
    const months = yearly ? (rule.bymonth.length ? rule.bymonth.map((m) => m - 1).sort((a, b) => a - b) : [base.mo]) : null;
    const startIdx = base.y * 12 + base.mo;
    const skipDate = fromDayNum(skipTo);
    const skipIdx = skipDate.y * 12 + skipDate.mo;
    const per = yearly ? 12 * rule.interval : rule.interval;
    let k = fast ? Math.max(0, Math.floor((skipIdx - startIdx) / per) - 1) : 0;
    for (let steps = 0; steps < MAX_STEPS; steps++, k++) {
      if (yearly) {
        const y = base.y + k * rule.interval;
        for (const mo of months) {
          for (const d of monthDays(y, mo, rule, base.d)) {
            const dn = dayNum(y, mo, d);
            if (dn >= base.dn) yield dn;
          }
        }
      } else {
        const idx = startIdx + k * rule.interval;
        const y = Math.floor(idx / 12), mo = idx % 12;
        if (rule.bymonth.length && !rule.bymonth.includes(mo + 1)) continue;
        for (const d of monthDays(y, mo, rule, base.d)) {
          const dn = dayNum(y, mo, d);
          if (dn >= base.dn) yield dn;
        }
      }
    }
  }
}

// ───────────────────────── Identifiants ─────────────────────────

/** Hachage FNV-1a 32 bits en base 36 : suffisant pour des identifiants stables et courts. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// ───────────────────────── parseICS ─────────────────────────

/**
 * Lit un fichier .ics et renvoie des Event (source "ics").
 * @param {string} text
 * @param {{fromMs?: number, toMs?: number}} [range]
 */
export function parseICS(text, { fromMs = -Infinity, toMs = Date.now() + 400 * DAY } = {}) {
  const lines = unfoldLines(text);
  if (toMs === undefined || toMs === null) toMs = Date.now() + 400 * DAY;
  if (fromMs === undefined || fromMs === null) fromMs = -Infinity;

  // 1) découpage en VEVENT (les composants imbriqués, ex. VALARM, sont ignorés)
  let calTz = null;
  const raws = [];
  let cur = null;
  let depth = 0;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      if (cur) depth++;
      else if (p.value.toUpperCase() === 'VEVENT') { cur = []; depth = 0; }
      continue;
    }
    if (p.name === 'END') {
      if (cur) {
        if (depth > 0) depth--;
        else if (p.value.toUpperCase() === 'VEVENT') { raws.push(cur); cur = null; }
      }
      continue;
    }
    if (cur) { if (depth === 0) cur.push(p); } else if (p.name === 'X-WR-TIMEZONE') calTz = resolveTz(p.value);
  }

  // 2) lecture de chaque VEVENT
  const evs = [];
  for (const props of raws) {
    const get = (n) => props.find((p) => p.name === n);
    const all = (n) => props.filter((p) => p.name === n);
    const status = (get('STATUS')?.value || '').toUpperCase();
    const ds = get('DTSTART');
    const dv = ds && parseDateValue(ds.value);
    if (!dv) continue;
    const allDay = dv.dateOnly || (ds.params.VALUE || '').toUpperCase() === 'DATE';
    const zone = allDay ? zoneLocal : zoneFor(dv, ds.params, calTz);
    const startMs = zone.toMs(dv.y, dv.mo, dv.d, allDay ? 0 : dv.h, allDay ? 0 : dv.mi, allDay ? 0 : dv.s);

    let endMs = null, spanDays = 1;
    const de = get('DTEND') || get('DUE');
    const dur = get('DURATION') && parseDuration(get('DURATION').value);
    if (de) {
      const ev = parseDateValue(de.value);
      if (ev) {
        const ez = allDay ? zoneLocal : zoneFor(ev, de.params, calTz);
        endMs = ez.toMs(ev.y, ev.mo, ev.d, allDay ? 0 : ev.h, allDay ? 0 : ev.mi, allDay ? 0 : ev.s);
        if (allDay) spanDays = Math.max(1, dayNum(ev.y, ev.mo, ev.d) - dayNum(dv.y, dv.mo, dv.d));
      }
    }
    if (endMs == null && dur != null) {
      endMs = startMs + dur;
      if (allDay) spanDays = Math.max(1, Math.round(dur / DAY));
    }
    if (endMs == null || endMs < startMs) endMs = allDay ? zone.toMs(dv.y, dv.mo, dv.d + spanDays, 0, 0, 0) : startMs + 30 * MIN;
    if (!allDay && endMs === startMs) endMs = startMs + 30 * MIN;

    const summary = unescapeText(get('SUMMARY')?.value ?? '').replace(/\s*\n\s*/g, ' ').trim() || '(Sans titre)';
    const uid = (get('UID')?.value || '').trim() || `${hash(summary)}-${startMs}`;

    // RECURRENCE-ID : instance modifiée ou annulée d'une série
    let recKey = null;
    const rid = get('RECURRENCE-ID');
    if (rid) {
      const rv = parseDateValue(rid.value);
      if (rv) {
        if (rv.dateOnly) recKey = `d${dayNum(rv.y, rv.mo, rv.d)}`;
        else recKey = `m${zoneFor(rv, rid.params, calTz).toMs(rv.y, rv.mo, rv.d, rv.h, rv.mi, rv.s)}`;
      }
    }

    // EXDATE / RDATE
    const exMs = new Set(), exDays = new Set(), rdates = [];
    const eachDate = (p, fn) => {
      for (const v of p.value.split(',')) {
        const x = parseDateValue(v.split('/')[0]);
        if (!x) continue;
        const z = x.utc ? zoneUTC : (x.dateOnly ? zoneLocal : zoneFor(x, p.params, calTz));
        const useZone = !x.utc && !p.params.TZID && !x.dateOnly ? zone : z; // sans TZID, même zone que DTSTART
        fn(x, useZone);
      }
    };
    for (const p of all('EXDATE')) {
      eachDate(p, (x, z) => {
        if (x.dateOnly) exDays.add(dayNum(x.y, x.mo, x.d));
        else exMs.add(z.toMs(x.y, x.mo, x.d, x.h, x.mi, x.s));
      });
    }
    for (const p of all('RDATE')) {
      eachDate(p, (x, z) => {
        rdates.push(x.dateOnly ? zoneLocal.toMs(x.y, x.mo, x.d, 0, 0, 0) : z.toMs(x.y, x.mo, x.d, x.h, x.mi, x.s));
      });
    }

    evs.push({
      uid, summary, allDay, zone, dv, startMs, endMs, spanDays, status, recKey,
      rrule: get('RRULE') ? parseRRule(get('RRULE').value) : null,
      exMs, exDays, rdates,
    });
  }

  // 3) instances modifiées/annulées : elles retirent l'occurrence correspondante de la série maîtresse
  const overridden = new Map(); // uid -> Set(recKey)
  for (const e of evs) {
    if (!e.recKey) continue;
    if (!overridden.has(e.uid)) overridden.set(e.uid, new Set());
    overridden.get(e.uid).add(e.recKey);
  }

  // 4) expansion
  const out = [];
  const seen = new Set();
  const push = (e, startMs, endMs) => {
    if (!(endMs > fromMs && startMs < toMs) && !(startMs === endMs && startMs >= fromMs && startMs <= toMs)) return false;
    const id = `ics_${hash(e.uid)}_${startMs.toString(36)}`;
    if (seen.has(id)) return false;
    seen.add(id);
    const ev = { id, title: e.summary, startMs, endMs, source: 'ics', uid: e.uid };
    if (e.allDay) ev.allDay = true;
    out.push(ev);
    return true;
  };

  for (const e of evs) {
    if (e.status === 'CANCELLED') continue;
    const ov = overridden.get(e.uid);
    const excluded = (startMs, dn) => e.exMs.has(startMs) || e.exDays.has(dn) || (ov && !e.recKey && (ov.has(`m${startMs}`) || ov.has(`d${dn}`)));
    const dnStart = dayNum(e.dv.y, e.dv.mo, e.dv.d);
    const timeOf = e.allDay ? [0, 0, 0] : [e.dv.h, e.dv.mi, e.dv.s];
    const ymd = (dn) => { const t = fromDayNum(dn); return [t.y, t.mo, t.d]; };
    const endFor = (startMs, dn) => (e.allDay ? zoneLocal.toMs(...ymd(dn + e.spanDays), 0, 0, 0) : startMs + (e.endMs - e.startMs));
    const recurring = e.rrule && !e.recKey && ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(e.rrule.freq);

    if (!recurring) {
      push(e, e.startMs, e.endMs);
    } else {
      // première occurrence = DTSTART lui-même (compte dans COUNT)
      const rule = e.rrule;
      let until = Infinity;
      if (rule.until) {
        const uv = parseDateValue(rule.until);
        if (uv) until = uv.dateOnly ? e.zone.toMs(uv.y, uv.mo, uv.d, 23, 59, 59) : (uv.utc ? zoneUTC : e.zone).toMs(uv.y, uv.mo, uv.d, uv.h, uv.mi, uv.s);
      }
      const base = { dn: dnStart, ...fromDayNum(dnStart) };
      const skipTo = Number.isFinite(fromMs) ? Math.floor((fromMs - (e.endMs - e.startMs) - 2 * DAY) / DAY) : -Infinity;
      let n = 0, emitted = 0;
      const gen = candidateDays(rule, base, Number.isFinite(skipTo) ? skipTo : base.dn);
      for (const dn of gen) {
        const [y, mo, d] = ymd(dn);
        const startMs = e.zone.toMs(y, mo, d, ...timeOf);
        if (startMs < e.startMs) continue;
        n++;
        if (rule.count != null && n > rule.count) break;
        if (startMs > until || startMs >= toMs) break;
        if (excluded(startMs, dn)) continue;
        if (push(e, startMs, endFor(startMs, dn))) emitted++;
        if (emitted >= MAX_OCCURRENCES) break;
      }
    }
    if (!e.recKey) {
      for (const r of e.rdates) {
        if (!e.exMs.has(r)) push(e, r, r + (e.endMs - e.startMs));
      }
    }
  }

  out.sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title));
  return out;
}

// ───────────────────────── buildICS ─────────────────────────

const pad = (n, w = 2) => String(n).padStart(w, '0');
const utcStamp = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; };
const escapeText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
const encoder = new TextEncoder();

/** Plie une ligne à 75 octets (UTF-8) sans couper un caractère ; les suites commencent par une espace. */
export function foldLine(line) {
  if (encoder.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) { // for…of itère par point de code : pas de coupure au milieu d'une paire de substitution
    const b = encoder.encode(ch).length;
    if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0; limit = 74; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * Construit un fichier .ics (RFC 5545) : événements fixes + blocs planifiés (titre pris dans `tasks`).
 * Extensions : `nowMs` (DTSTAMP, pour des sorties reproductibles) et `includeTodos` (VTODO des tâches à échéance).
 */
export function buildICS({ blocks = [], tasks = [], events = [], calName = 'Kairos', nowMs = Date.now(), includeTodos = false } = {}) {
  const taskById = new Map((tasks || []).map((t) => [t.id, t]));
  const stamp = utcStamp(nowMs);
  const L = [];
  const add = (l) => L.push(foldLine(l));

  add('BEGIN:VCALENDAR');
  add('VERSION:2.0');
  add('PRODID:-//Kairos//Planificateur cérébral//FR');
  add('CALSCALE:GREGORIAN');
  add('METHOD:PUBLISH');
  add(`X-WR-CALNAME:${escapeText(calName)}`);

  const items = [];
  for (const ev of events || []) {
    if (!ev || !Number.isFinite(ev.startMs) || !Number.isFinite(ev.endMs)) continue;
    const uid = ev.uid || `${ev.id || hash(`${ev.title}${ev.startMs}`)}@kairos`;
    items.push({ startMs: ev.startMs, lines: eventLines({ uid, title: ev.title, startMs: ev.startMs, endMs: ev.endMs, allDay: ev.allDay }) });
  }
  for (const b of blocks || []) {
    if (!b || !Number.isFinite(b.startMs) || !Number.isFinite(b.endMs)) continue;
    const t = taskById.get(b.taskId);
    const desc = [b.reason, t ? `Charge cognitive : ${t.load}/5` : null, b.locked ? 'Créneau verrouillé' : null].filter(Boolean).join('\n');
    items.push({
      startMs: b.startMs,
      lines: eventLines({
        uid: `block-${b.taskId}-${b.startMs}@kairos`, title: t ? t.title : 'Tâche', startMs: b.startMs, endMs: b.endMs,
        description: desc, categories: ['Kairos', ...((t && t.tags) || [])],
      }),
    });
  }
  items.sort((a, b) => a.startMs - b.startMs);
  for (const it of items) for (const l of it.lines) add(l);

  if (includeTodos) {
    for (const t of tasks || []) {
      if (!t || t.done || !Number.isFinite(t.deadlineMs)) continue;
      add('BEGIN:VTODO');
      add(`UID:task-${t.id}@kairos`);
      add(`DTSTAMP:${stamp}`);
      add(`SUMMARY:${escapeText(t.title)}`);
      add(`DUE:${utcStamp(t.deadlineMs)}`);
      add(`PRIORITY:${[0, 1, 3, 5, 9][t.priority] ?? 5}`);
      add('STATUS:NEEDS-ACTION');
      add('END:VTODO');
    }
  }
  add('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';

  function eventLines({ uid, title, startMs, endMs, allDay, description, categories }) {
    const o = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`];
    if (allDay) {
      o.push(`DTSTART;VALUE=DATE:${localDate(startMs)}`);
      const end = endMs > startMs ? endMs : startMs + DAY;
      o.push(`DTEND;VALUE=DATE:${localDate(end)}`);
    } else {
      o.push(`DTSTART:${utcStamp(startMs)}`, `DTEND:${utcStamp(Math.max(endMs, startMs))}`);
    }
    o.push(`SUMMARY:${escapeText(title || '(Sans titre)')}`);
    if (description) o.push(`DESCRIPTION:${escapeText(description)}`);
    if (categories && categories.length) o.push(`CATEGORIES:${categories.map(escapeText).join(',')}`);
    o.push('TRANSP:OPAQUE', 'END:VEVENT');
    return o;
  }
}
