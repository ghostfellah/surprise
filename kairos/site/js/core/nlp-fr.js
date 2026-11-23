// nlp-fr.js — analyseur de saisie rapide en français, 100 % local, sans dépendance.
//
// Hypothèses et conventions (à connaître pour comprendre les résultats) :
//  - On travaille sur une copie « pliée » du texte (minuscules, sans accents) de MÊME longueur que l'original :
//    les indices des jetons (start/end) valent donc pour le texte tel que saisi.
//  - Les jours sont des jours civils locaux (time.js). « lundi » = prochain lundi strictement après aujourd'hui
//    (un mardi, « mardi » = mardi prochain) ; « ce mardi » inclut aujourd'hui ; « lundi prochain » = le lundi de
//    la semaine civile suivante (semaine lundi→dimanche).
//  - Une heure de début précise (« à 14h », « jeudi 12h30 ») => événement. Une échéance (« avant », « pour »,
//    « d'ici », « jusqu'à », ou un verbe de remise : finir, rendre, envoyer…) => tâche avec deadlineMs.
//    « après 14h », « dès lundi » => tâche avec earliestMs. Un jour seul => tâche avec échéance en fin de journée
//    de travail (18:00, ou 23:59 si 18:00 est déjà passé).
//  - « 2h » nu est une durée ; une heure nue à partir de 7h (« 9h », « 12h30 ») est une heure. Avec « à »,
//    « avant », « après »… c'est toujours une heure. « pendant »/« min » forcent la durée.
//  - Une heure sans jour est celle d'aujourd'hui, ou de demain si elle est déjà passée (passage de minuit).
//    « minuit » = fin du jour considéré (00:00 du lendemain).
//  - Les tâches sans durée explicite n'ont pas de durMin (à la charge de l'appelant) ; les événements sans durée
//    durent 60 min. Les durées sont arrondies au multiple de 5 min (5–720).
//  - Les tags sont renvoyés sans le sigle (« #deep » -> "deep", « @maison » -> "maison"), en minuscules sans accents.
import { MIN, startOfDay, addDays, atMinutes } from './time.js';

// ───────────────────────── Tables ─────────────────────────

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const WD_RX = WEEKDAYS.join('|');

const MONTHS = {
  janvier: 0, janv: 0, fevrier: 1, fevr: 1, fev: 1, mars: 2, avril: 3, avr: 3, mai: 4, juin: 5,
  juillet: 6, juil: 6, aout: 7, septembre: 8, sept: 8, octobre: 9, oct: 9, novembre: 10, nov: 10,
  decembre: 11, dec: 11,
};
const MONTH_RX = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const NUM = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, 'vingt-cinq': 25,
  trente: 30, 'trente-cinq': 35, quarante: 40, 'quarante-cinq': 45, cinquante: 50, 'cinquante-cinq': 55,
  soixante: 60,
};
const NUMW = Object.keys(NUM).sort((a, b) => b.length - a.length).map((k) => k.replace(/-/g, '[- ]')).join('|');
const numWord = (s) => NUM[s.replace(/ /g, '-')];

// Fenêtres des moments de la journée (minutes depuis minuit) : [début, fin].
const DAYPART = { matin: [8 * 60, 12 * 60], 'apres-midi': [12 * 60, 18 * 60], soir: [18 * 60, 23 * 60] };
const normDaypart = (s) => (!s ? undefined : /^(apres|aprem)/.test(s) ? 'apres-midi' : s);
const DP_RX = 'matin|soir|apres[- ]?midi|aprem';

// Charge cognitive : [expression sur texte plié, charge]. La charge haute l'emporte sur la basse.
const LOAD_RULES = [
  [/(?<![a-z])(?:concev|conception|concept(?![a-z])|cod(?:e|er|es|age|ing)(?![a-z])|programm|develop|debug|refactor|modelis|reflechi|reflexion|analys|strateg|resoud|resolution|demontr|algorith|architectur)[a-z]*/g, 5],
  [/(?<![a-z])(?:redig|redaction|ecri(?:re|s|t|vez|ture)(?![a-z])|etudi|etude(?![a-z])|revis|appren|negoci|presentation|rapport|article|dissertation|expose(?![a-z])|memoire|brainstorm|planifi|synthes|contrat|budget)[a-z]*/g, 4],
  [/(?<![a-z])(?:organis|verifi|classe(?:r|ment)|commande|reserv|relanc|envoy|imprim)[a-z]*/g, 2],
  [/(?<![a-z])(?:repon[a-z]*|e?-?mails?|courriels?|courriers?|rang(?:er|ement)|appel[a-z]*|telephon[a-z]*|rembours[a-z]*|admin[a-z]*|factur[a-z]*|courses|menage|vaisselle|lessive|poubelles?|payer|paie(?:ment)?|trier|sms|whatsapp)(?![a-z])/g, 1],
];

// Verbes de remise : « Rendre le rapport vendredi 17h » est une échéance, pas un rendez-vous.
const DEADLINE_VERB = /^[^a-z]*(?:fini|termin|rend(?:re|s)(?![a-z])|envoy|livr|boucl|remet|soumet|finalis|depos|publi|retourn|payer)/;

const STOP_TAIL = new Set(['a', 'de', 'du', 'des', "d'", 'le', 'la', 'les', "l'", 'au', 'aux', 'pour', 'vers', 'avant', 'apres', 'et', 'ou', 'en', 'dans', 'sur', 'ce', 'cet', 'cette', 'par', 'jusqu', "jusqu'"]);

// ───────────────────────── Aides ─────────────────────────

/** Minuscules sans accents, MÊME longueur que l'entrée (les indices restent valides). */
function fold(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let d;
    if (c === '’' || c === '‘' || c === '`' || c === '´') d = "'";
    else if (/\s/.test(c)) d = ' ';
    else {
      d = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      if (d.length !== 1) d = c;
    }
    out += d;
  }
  return out;
}

const roundDur = (min) => Math.min(720, Math.max(5, Math.round(min / 5) * 5));
const round5ms = (ms) => Math.round(ms / (5 * MIN)) * 5 * MIN;
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const validYMD = (y, m, d) => { const t = new Date(y, m, d); return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d; };

function addMonths(dayMs, n) {
  const d = new Date(dayMs);
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const dd = Math.min(d.getDate(), daysInMonth(first.getFullYear(), first.getMonth()));
  return new Date(first.getFullYear(), first.getMonth(), dd).getTime();
}

// Préfixes qui qualifient un jour ou une heure : [nom, mode, expression, options].
const PREFIXES = [
  ['pas avant', 'after', 'pas\\s+avant'],
  ['avant', 'before', 'avant'],
  ['dici', 'before', "d'?\\s?ici"],
  ['jusque', 'before', "jusqu'\\s?(?:a|au)|jusque"],
  ['plus tard', 'before', 'au\\s+plus\\s+tard(?:\\s+(?:pour|avant|le))?'],
  ['deadline', 'before', 'deadline|echeance|date\\s+limite|delai'],
  ['apres', 'after', 'apres', { excl: true }],
  ['des', 'after', 'des', { accent: 'dès' }],
  ['a partir', 'after', "a\\s+partir\\s+(?:de|du|d')"],
  ['pour', 'before', 'pour', { soft: true }],
  ['a', 'at', 'a|vers'],
  ['pendant', 'dur', 'pendant|durant|environ'],
].map(([name, mode, rx, opt = {}]) => ({ name, mode, rx: new RegExp(`(?<![a-z])(?:${rx})\\s*$`), ...opt }));

const DATE_PREFIX = new Set(['pas avant', 'avant', 'dici', 'jusque', 'plus tard', 'deadline', 'apres', 'des', 'a partir', 'pour']);
const TIME_PREFIX = new Set([...DATE_PREFIX, 'a']);
const DUR_PREFIX = new Set(['pendant', 'pour']);

// ───────────────────────── Analyse principale ─────────────────────────

/**
 * Analyse une saisie rapide.
 * @param {string} text
 * @param {number} [nowMs]
 */
export function parseEntry(text, nowMs = Date.now()) {
  text = typeof text === 'string' ? text : '';
  const empty = { kind: 'task', title: '', tags: [], confidence: 0, tokens: [] };
  if (!text.trim()) return empty;

  const f = fold(text);
  let w = f; // copie masquée : les zones déjà reconnues deviennent \u0001
  const today = startOfDay(nowMs);
  const atoms = [];

  const mask = (s, e) => { w = w.slice(0, s) + '\u0001'.repeat(e - s) + w.slice(e); };
  const scan = (re, handler) => {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(w)) !== null) {
      if (m[0].length === 0) { rx.lastIndex++; continue; }
      const a = handler(m);
      if (a) { mask(a.s, a.e); atoms.push(a); }
    }
  };
  const prefixBefore = (pos, allowed) => {
    const head = w.slice(0, pos);
    for (const p of PREFIXES) {
      if (!allowed.has(p.name)) continue;
      const m = p.rx.exec(head);
      if (!m) continue;
      if (p.accent && text.slice(m.index, m.index + p.accent.length).toLowerCase() !== p.accent) continue;
      return { start: m.index, name: p.name, mode: p.mode, excl: !!p.excl, soft: !!p.soft };
    }
    return null;
  };
  const dateAtom = (m, extra) => {
    const p = prefixBefore(m.index, DATE_PREFIX);
    return { type: 'date', s: p ? p.start : m.index, e: m.index + m[0].length, mode: p ? p.mode : null, excl: p ? p.excl : false, ...extra };
  };

  // 1) Tags : #deep, @maison
  scan(/(?:^|(?<=[\s(]))([#@])([a-z0-9_][a-z0-9_-]*)/, (m) => ({
    type: 'tag', s: m.index, e: m.index + m[0].length, tag: m[2].replace(/[-_]+$/, ''),
  }));

  // 2) Priorité
  scan(/(?<![a-z])pas\s+(?:tres\s+)?(?:urgent|important|presse)(?:e|es|s)?(?![a-z])|(?<![a-z])(?:non\s+urgent|basse\s+priorite|pas\s+presse|quand\s+j'ai\s+le\s+temps)(?![a-z])/, (m) => ({ type: 'prio', s: m.index, e: m.index + m[0].length, prio: 4 }));
  scan(/(?:^|(?<=\s))(!{2,}|!\s?[1-4])(?=$|[\s.,;])/, (m) => {
    const d = /\d/.exec(m[1]);
    return { type: 'prio', s: m.index, e: m.index + m[0].length, prio: d ? Number(d[0]) : 1 };
  });
  scan(/(?<![a-z])(urgent(?:e|es|s)?|urgence|asap|critique|prioritaire|important(?:e|es|s)?|crucial(?:e|es|s)?)(?![a-z])/, (m) => ({
    type: 'prio', s: m.index, e: m.index + m[0].length, prio: /^(urgen|asap|critique)/.test(m[1]) ? 1 : 2,
  }));

  // 3) Décalage relatif en heures/minutes : « dans 20 min », « dans 2h »
  scan(new RegExp(`(?<![a-z])dans\\s+(?:(?:une\\s+)?(demi[- ]heure)|(un\\s+quart\\s+d'heure)|(\\d{1,3}|${NUMW})\\s*(min(?:ute)?s?|mn|h|heures?)(?![a-z])(?:\\s*(\\d{2})(?!\\d))?)`), (m) => {
    let off;
    if (m[1]) off = 30;
    else if (m[2]) off = 15;
    else {
      const n = /^\d/.test(m[3]) ? Number(m[3]) : numWord(m[3]);
      if (!(n >= 0)) return null;
      const isMin = /^(min|mn)/.test(m[4]);
      off = isMin ? n : n * 60 + (m[5] ? Number(m[5]) : 0);
    }
    return { type: 'time', s: m.index, e: m.index + m[0].length, mode: null, abs: round5ms(nowMs + off * MIN) };
  });

  // 4) Durées en toutes lettres et décimales
  const durAtom = (m, min) => {
    const p = prefixBefore(m.index, DUR_PREFIX);
    return { type: 'dur', s: p ? p.start : m.index, e: m.index + m[0].length, min };
  };
  scan(/(?<![a-z])(?:une?\s+)?demi[- ]?heure(?![a-z])|(?<![\d/])1\/2\s*(?:h|heures?)(?![a-z])/, (m) => durAtom(m, 30));
  scan(/(?<![a-z])(?:(un|trois)\s+)?quarts?\s+d'heure(?![a-z])/, (m) => durAtom(m, m[1] === 'trois' ? 45 : 15));
  scan(/(?<![\d:.,])(\d+[.,]\d+)\s*(?:h|heures?)(?![a-z\d])/, (m) => durAtom(m, Number(m[1].replace(',', '.')) * 60));

  // 5) Plages horaires : « de 14h à 16h », « 14h-15h30 », « de 10 à 12h »
  const rangeMinutes = (h, mi) => { const H = Number(h), M = mi ? Number(mi) : 0; return H <= 24 && M < 60 ? H * 60 + M : NaN; };
  scan(/(?:(?<![a-z])(?:de|entre|du)\s+)?(?<![\d:.,])(\d{1,2})\s*(?:h|:)\s*(\d{2})?\s*(?:a|et|-|–|—)\s*(\d{1,2})\s*(?:h|:)\s*(\d{2})?(?![a-z\d])/, (m) => {
    const a = rangeMinutes(m[1], m[2]), b = rangeMinutes(m[3], m[4]);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return { type: 'time', s: m.index, e: m.index + m[0].length, mode: null, min: a, endMin: b <= a ? b + 1440 : b, explicit: true };
  });
  scan(/(?<![a-z])(?:de|entre)\s+(\d{1,2})\s*(?:a|et|-|–)\s*(\d{1,2})\s*h(?:\s*(\d{2}))?(?![a-z\d])/, (m) => {
    const a = rangeMinutes(m[1], 0), b = rangeMinutes(m[2], m[3]);
    if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
    return { type: 'time', s: m.index, e: m.index + m[0].length, mode: null, min: a, endMin: b, explicit: true };
  });

  // 6) Dates
  const WDP = `(?:(?<![a-z])(?:${WD_RX})\\s+)?`;
  const resolveYear = (d, mo) => {
    const nowD = new Date(today);
    let y = nowD.getFullYear();
    if (new Date(y, mo, d).getTime() < today) y += 1;
    return y;
  };
  scan(new RegExp(`${WDP}(?<![\\d-])(\\d{4})-(\\d{2})-(\\d{2})(?![\\d-])`), (m) => {
    const y = +m[1], mo = +m[2] - 1, d = +m[3];
    if (!validYMD(y, mo, d)) return null;
    return dateAtom(m, { day: new Date(y, mo, d).getTime() });
  });
  scan(new RegExp(`${WDP}(?:(?<![a-z])(?:le|du)\\s+)?(?<![\\d/])(\\d{1,2})(?:er)?\\s+(${MONTH_RX})\\.?(?![a-z])(?:\\s+((?:19|20)\\d{2})(?!\\d|\\s*h(?![a-z])))?`), (m) => {
    const d = +m[1], mo = MONTHS[m[2]];
    const y = m[3] ? +m[3] : resolveYear(d, mo);
    if (!validYMD(y, mo, d)) return null;
    return dateAtom(m, { day: new Date(y, mo, d).getTime() });
  });
  scan(new RegExp(`${WDP}(?:(?<![a-z])(?:le|du)\\s+)?(?<![\\d/.])(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?(?![\\d/])`), (m) => {
    const d = +m[1], mo = +m[2] - 1;
    let y;
    if (m[3]) y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    else y = resolveYear(d, mo);
    if (mo < 0 || mo > 11 || !validYMD(y, mo, d)) return null;
    return dateAtom(m, { day: new Date(y, mo, d).getTime() });
  });
  scan(new RegExp(`(?<![a-z])(?:apres[- ]demain|surlendemain)(?![a-z])(?:\\s+(${DP_RX})(?![a-z]))?`), (m) => dateAtom(m, { day: addDays(today, 2), daypart: normDaypart(m[1]) }));
  scan(new RegExp(`(?<![a-z])demain(?![a-z])(?:\\s+(${DP_RX})(?![a-z]))?`), (m) => dateAtom(m, { day: addDays(today, 1), daypart: normDaypart(m[1]) }));
  scan(new RegExp(`(?<![a-z])(?:aujourd'?\\s?hui|ajd|auj)(?![a-z])(?:\\s+(${DP_RX})(?![a-z]))?`), (m) => dateAtom(m, { day: today, daypart: normDaypart(m[1]) }));
  scan(new RegExp(`(?<![a-z])hier(?![a-z])(?:\\s+(${DP_RX})(?![a-z]))?`), (m) => dateAtom(m, { day: addDays(today, -1), daypart: normDaypart(m[1]) }));
  scan(new RegExp(`(?<![a-z])(?:ce|cet|cette)\\s+(${DP_RX}|midi)(?![a-z])`), (m) => (
    m[1] === 'midi' ? dateAtom(m, { day: today, time: 720 }) : dateAtom(m, { day: today, daypart: normDaypart(m[1]) })));
  scan(new RegExp(`(?:(?<![a-z])(le|ce|cet|cette)\\s+)?(?<![a-z])(${WD_RX})(?![a-z])(?:\\s+(prochain|suivant)(?![a-z]))?(?:\\s+(${DP_RX})(?![a-z]))?`), (m) => {
    const wd = WEEKDAYS.indexOf(m[2]);
    const dow = new Date(today).getDay();
    let day;
    if (m[3]) {
      const dm = (dow + 6) % 7; // 0 = lundi
      day = addDays(addDays(today, 7 - dm), (wd + 6) % 7);
    } else {
      let d = (wd - dow + 7) % 7;
      if (d === 0 && !(m[1] && m[1] !== 'le')) d = 7; // « ce mardi » inclut aujourd'hui
      day = addDays(today, d);
    }
    return dateAtom(m, { day, daypart: normDaypart(m[4]) });
  });
  scan(new RegExp(`(?<![a-z])dans\\s+(\\d{1,3}|${NUMW})\\s+(jours?|semaines?|mois|ans?)(?![a-z])`), (m) => {
    const n = /^\d/.test(m[1]) ? +m[1] : numWord(m[1]);
    if (!(n >= 0)) return null;
    const u = m[2];
    const day = /^jour/.test(u) ? addDays(today, n) : /^semaine/.test(u) ? addDays(today, 7 * n) : /^mois/.test(u) ? addMonths(today, n) : addMonths(today, 12 * n);
    return dateAtom(m, { day });
  });
  scan(/(?:(?<![a-z])(?:la|le|en)\s+)?(?<![a-z])fin\s+(?:de\s+la\s+|de\s+l'|de\s+|du\s+|d')(semaine|mois|journee|annee)(?![a-z])/, (m) => {
    const dow = new Date(today).getDay();
    let day = today;
    if (m[1] === 'semaine') day = addDays(today, dow === 0 ? 5 : dow === 6 ? 6 : 5 - dow); // vendredi
    else if (m[1] === 'mois') { const d = new Date(today); day = new Date(d.getFullYear(), d.getMonth(), daysInMonth(d.getFullYear(), d.getMonth())).getTime(); }
    else if (m[1] === 'annee') day = new Date(new Date(today).getFullYear(), 11, 31).getTime();
    return dateAtom(m, { day });
  });
  scan(/(?<![a-z])(?:cette\s+semaine|ce\s+mois(?:[- ]ci)?)(?![a-z])/, (m) => {
    const dow = new Date(today).getDay();
    let day;
    if (/semaine/.test(m[0])) day = addDays(today, dow === 0 ? 5 : dow === 6 ? 6 : 5 - dow);
    else { const d = new Date(today); day = new Date(d.getFullYear(), d.getMonth(), daysInMonth(d.getFullYear(), d.getMonth())).getTime(); }
    return dateAtom(m, { day });
  });
  scan(/(?:(?<![a-z])la\s+)?(?<![a-z])semaine\s+(?:prochaine|suivante)(?![a-z])/, (m) => {
    const dm = (new Date(today).getDay() + 6) % 7;
    const mon = addDays(today, 7 - dm);
    return dateAtom(m, { day: mon, endDay: addDays(mon, 4) });
  });
  scan(/(?:(?<![a-z])le\s+)?(?<![a-z])mois\s+prochain(?![a-z])/, (m) => {
    const d = new Date(today);
    const first = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return dateAtom(m, { day: first.getTime(), endDay: new Date(first.getFullYear(), first.getMonth(), daysInMonth(first.getFullYear(), first.getMonth())).getTime() });
  });
  scan(/(?:(?<![a-z])(?:ce|le)\s+)?(?<![a-z])week-?end(?![a-z])(?:\s+(prochain))?/, (m) => {
    const dow = new Date(today).getDay();
    let sat;
    if (m[1]) sat = addDays(today, ((6 - dow + 7) % 7) || 7);
    else if (dow === 6) sat = today;
    else if (dow === 0) sat = addDays(today, -1);
    else sat = addDays(today, 6 - dow);
    const sun = addDays(sat, 1);
    return dateAtom(m, { day: sat < today ? today : sat, endDay: sun });
  });
  scan(/(?<![a-z])le\s+(\d{1,2})(?:er)?(?![\d/:.a-z])/, (m) => {
    if (/^\s*(?:h(?![a-z])|heures?|min|mn|%|€|euros?|kg|km|pages?|personnes?|fois|mails?)/.test(w.slice(m.index + m[0].length))) return null;
    const d = +m[1];
    if (d < 1 || d > 31) return null;
    const t = new Date(today);
    let y = t.getFullYear(), mo = t.getMonth();
    if (d < t.getDate()) { mo += 1; if (mo > 11) { mo = 0; y += 1; } }
    while (!validYMD(y, mo, d)) { mo += 1; if (mo > 11) { mo = 0; y += 1; } }
    return dateAtom(m, { day: new Date(y, mo, d).getTime() });
  });

  // 7) Heures et durées
  const timePrefix = (pos) => prefixBefore(pos, TIME_PREFIX);
  const withDayHint = (e) => {
    const m = /^\s+(?:du\s+(matin|soir)|de\s+l'(apres[- ]?midi|aprem))(?![a-z])/.exec(w.slice(e));
    return m ? { e: e + m[0].length, dp: normDaypart(m[1] || m[2]) } : { e, dp: undefined };
  };
  const timeAtom = (m, min, startFromPrefix = true) => {
    const p = timePrefix(m.index);
    const end = withDayHint(m.index + m[0].length);
    return {
      type: 'time', s: p && startFromPrefix ? p.start : m.index, e: end.e, mode: p && p.mode !== 'at' ? p.mode : null,
      excl: p ? p.excl : false, explicit: !!(p && !p.soft), min, dpHint: end.dp,
    };
  };
  scan(/(?<![\d:.,])(\d{1,2}):(\d{2})(?![\d:])/, (m) => {
    const min = rangeMinutes(m[1], m[2]);
    return Number.isNaN(min) ? null : timeAtom(m, min);
  });
  scan(/(?<![a-z])(midi|minuit)(?![a-z])(?:\s+et\s+(demi|demie|quart)(?![a-z]))?/, (m) => {
    const base = m[1] === 'midi' ? 720 : 1440;
    return timeAtom(m, base + (m[2] ? (m[2] === 'quart' ? 15 : 30) : 0));
  });
  scan(new RegExp(`(?:(?<![\\d:.,])(\\d{1,2})|(?<![a-z])(${NUMW}))\\s*(h|heures?)(?![a-z])(?:\\s*(\\d{2})(?!\\d)(\\s*(?:min(?:utes?)?|mn)(?![a-z]))?|\\s+et\\s+(demie?|quart)(?![a-z]))?`), (m) => {
    const isWord = m[2] != null;
    const unit = m[3];
    if (isWord && unit === 'h') return null;
    const H = isWord ? numWord(m[2]) : Number(m[1]);
    const mm = m[4] != null ? Number(m[4]) : m[6] ? (/quart/.test(m[6]) ? 15 : 30) : 0;
    if (mm > 59 || H > 24) return null;
    const hasMinSuffix = !!m[5];
    const p = timePrefix(m.index);
    const explicit = !!(p && !p.soft);
    const forcedDur = hasMinSuffix || (p && p.name === 'pendant') || (!!p && p.name === 'pour' && H < 7);
    const asTime = !forcedDur && (explicit || (unit === 'h' && !isWord && H >= 7) || (unit !== 'h' && H >= 9));
    if (asTime) return timeAtom(m, H * 60 + mm);
    const dp = prefixBefore(m.index, DUR_PREFIX);
    return { type: 'dur', s: dp ? dp.start : m.index, e: m.index + m[0].length, min: H * 60 + mm };
  });
  scan(new RegExp(`(?<![\\d:.,])(\\d{1,3})\\s*(?:min(?:utes?)?|mn)(?![a-z])|(?<![a-z])(${NUMW})\\s+minutes?(?![a-z])`), (m) => durAtom(m, m[1] != null ? Number(m[1]) : numWord(m[2])));

  // 8) Charge cognitive (jetons de surlignage uniquement : ces mots restent dans le titre)
  const loadTokens = findLoadWords(w);

  // ───────── Interprétation ─────────
  const tags = [...new Set(atoms.filter((a) => a.type === 'tag').map((a) => a.tag))];
  const prioAtoms = atoms.filter((a) => a.type === 'prio');
  const priority = prioAtoms.length ? Math.min(...prioAtoms.map((a) => a.prio)) : undefined;
  const durAtoms = atoms.filter((a) => a.type === 'dur').sort((a, b) => a.s - b.s);
  const explicitDur = durAtoms.length ? roundDur(durAtoms[0].min) : undefined;

  let { load, inferred: loadInferred } = combineLoad(loadTokens, tags);

  // Groupes « quand » : un jour + une heure voisins forment un seul groupe.
  const when = atoms.filter((a) => a.type === 'date' || a.type === 'time').sort((a, b) => a.s - b.s);
  const groups = [];
  const gapOk = (a, b) => /^[\s,;]*$/.test(f.slice(a, b));
  for (const a of when) {
    const last = groups[groups.length - 1];
    const modeA = a.mode, modeL = last && last.mode;
    const compatible = last && !(modeA && modeL && modeA !== modeL) && gapOk(last.e, a.s) && a.s >= last.e;
    if (compatible && a.type === 'time' && last.date && !last.time) { absorb(last, a); continue; }
    if (compatible && a.type === 'date' && last.time && !last.date) { absorb(last, a); continue; }
    groups.push(absorb({ date: null, time: null, mode: null, excl: false, e: a.e }, a));
  }
  function absorb(g, a) {
    if (a.type === 'date') g.date = a; else g.time = a;
    if (!g.mode && a.mode) { g.mode = a.mode; g.excl = a.excl; }
    g.e = Math.max(g.e, a.e);
    return g;
  }
  // Un groupe « heure seule » + un groupe « jour seul » ailleurs dans la phrase se rejoignent.
  const timeOnly = groups.filter((g) => !g.date && g.time);
  const dateOnly = groups.filter((g) => g.date && !g.time && !g.date.time);
  if (timeOnly.length === 1 && dateOnly.length === 1 && (!dateOnly[0].mode || !timeOnly[0].mode || dateOnly[0].mode === timeOnly[0].mode)) {
    const [t] = timeOnly, [d] = dateOnly;
    d.time = t.time;
    if (!d.mode && t.mode) { d.mode = t.mode; d.excl = t.excl; }
    groups.splice(groups.indexOf(t), 1);
  }

  const timeMinutes = (g) => {
    let min = g.time ? g.time.min : g.date.time;
    const dp = (g.time && g.time.dpHint) || (g.date && g.date.daypart);
    if ((dp === 'soir' || dp === 'apres-midi') && min >= 60 && min < 720) min += 720;
    return min;
  };
  const deadlineOfDay = (day) => {
    const six = atMinutes(day, 18 * 60);
    return six > nowMs ? six : atMinutes(day, 23 * 60 + 59);
  };
  const instant = (g, roll) => {
    if (g.time && g.time.abs != null) return g.time.abs;
    const hasDate = !!g.date;
    const day = hasDate ? g.date.day : today;
    const min = timeMinutes(g);
    let ms = atMinutes(day, min);
    if (!hasDate && roll && ms < nowMs) ms = atMinutes(addDays(day, 1), min);
    return ms;
  };
  const hasInstant = (g) => !!(g.time || (g.date && g.date.time != null));

  const flipToDeadline = DEADLINE_VERB.test(w.replace(/\u0001/g, ' '));
  let start = null, end = null, deadline = null, earliest = null;
  for (const g of groups) {
    let mode = g.mode || 'at';
    if (mode === 'at' && flipToDeadline && hasInstant(g) && !(g.time && g.time.endMin != null)) mode = 'before';
    if (mode === 'before') {
      if (deadline == null) {
        if (hasInstant(g)) deadline = instant(g, true);
        else if (g.date.daypart) deadline = atMinutes(g.date.day, DAYPART[g.date.daypart][1]);
        else if (g.date.endDay) deadline = deadlineOfDay(addDays(g.date.day, -1));
        else deadline = deadlineOfDay(g.date.day);
      }
    } else if (mode === 'after') {
      if (earliest == null) {
        if (hasInstant(g)) earliest = instant(g, false);
        else if (g.date.daypart) earliest = atMinutes(g.date.day, DAYPART[g.date.daypart][g.excl ? 1 : 0]);
        else earliest = g.excl ? addDays(g.date.day, 1) : g.date.day;
      }
    } else if (g.time && g.time.endMin != null) {
      if (start == null) {
        const day = g.date ? g.date.day : today;
        start = atMinutes(day, g.time.min);
        if (!g.date && start < nowMs) start = atMinutes(addDays(day, 1), g.time.min);
        end = start + (g.time.endMin - g.time.min) * MIN;
      }
    } else if (hasInstant(g)) {
      if (start == null) start = instant(g, true);
    } else if (g.date) {
      const d = g.date;
      if (d.daypart) {
        if (earliest == null) earliest = atMinutes(d.day, DAYPART[d.daypart][0]);
        if (deadline == null) deadline = atMinutes(d.day, DAYPART[d.daypart][1]);
      } else if (d.endDay) {
        if (earliest == null) earliest = d.day;
        if (deadline == null) deadline = deadlineOfDay(d.endDay);
      } else if (deadline == null) deadline = deadlineOfDay(d.day);
    }
  }

  const isEvent = start != null && deadline == null && earliest == null;
  const result = { kind: isEvent ? 'event' : 'task', title: '', tags };
  if (isEvent) {
    const dur = end != null ? Math.round((end - start) / MIN) : (explicitDur ?? 60);
    result.durMin = dur;
    result.startMs = start;
    result.endMs = end != null ? end : start + dur * MIN;
  } else {
    if (explicitDur != null) result.durMin = explicitDur;
    result.load = load;
    if (deadline != null) result.deadlineMs = deadline;
    if (earliest == null && start != null) earliest = start; // heure de début + échéance : début au plus tôt
    if (earliest != null) result.earliestMs = earliest;
  }
  if (priority != null) result.priority = priority;

  // Jetons (ordre du texte) et titre nettoyé.
  const typeName = { date: 'date', time: 'time', dur: 'duration', prio: 'priority', tag: 'tag' };
  const tokens = atoms.map((a) => ({ text: text.slice(a.s, a.e), type: typeName[a.type], start: a.s, end: a.e }));
  for (const t of loadTokens) tokens.push({ text: text.slice(t.s, t.e), type: 'load', start: t.s, end: t.e });
  tokens.sort((a, b) => a.start - b.start || a.end - b.end);

  let rest2 = '';
  let cursor = 0;
  for (const t of tokens) {
    if (t.type === 'load') continue;
    rest2 += text.slice(cursor, t.start) + ' ';
    cursor = Math.max(cursor, t.end);
  }
  rest2 += text.slice(cursor);
  result.title = cleanTitle(rest2);

  // Confiance : titre + chaque information structurée reconnue.
  let c = result.title ? 0.4 : 0.1;
  if (groups.length) c += isEvent ? 0.3 : 0.25;
  if (explicitDur != null || (isEvent && end != null)) c += 0.15;
  if (loadInferred) c += 0.1;
  if (priority != null || tags.length) c += 0.05;
  if (groups.some((g) => g.date && g.time)) c += 0.05;
  result.confidence = Math.round(Math.min(1, c) * 100) / 100;
  result.tokens = tokens;
  return result;
}

/** Nettoie le titre : espaces, ponctuation et mots de liaison orphelins, majuscule initiale. */
function cleanTitle(s) {
  let t = s.replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const strip = () => {
    const before = t;
    t = t.replace(/^[\s,;:.\-–—/]+/, '').replace(/[\s,;:.\-–—/]+$/, '');
    const m = /(?:^|\s)([^\s]+)$/.exec(t);
    if (m && STOP_TAIL.has(fold(m[1]))) t = t.slice(0, m.index).trim();
    return t !== before;
  };
  while (strip());
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

/** Mots-clés de charge cognitive trouvés dans un texte plié : [{s, e, load}] sans chevauchement. */
function findLoadWords(folded) {
  const hits = [];
  for (const [rx, load] of LOAD_RULES) {
    const r = new RegExp(rx.source, rx.flags);
    let m;
    while ((m = r.exec(folded)) !== null) hits.push({ s: m.index, e: m.index + m[0].length, load });
  }
  hits.sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  for (const h of hits) if (!out.length || h.s >= out[out.length - 1].e) out.push(h);
  return out;
}

/** Les mots exigeants l'emportent sur les mots légers ; #deep = 5, #leger = 1. */
function combineLoad(hits, tags) {
  let load = 3;
  let inferred = false;
  const heavy = hits.filter((t) => t.load >= 4).map((t) => t.load);
  const light = hits.filter((t) => t.load < 4).map((t) => t.load);
  const pool = heavy.length ? heavy : light;
  if (pool.length) { load = Math.round(pool.reduce((a, b) => a + b, 0) / pool.length); inferred = true; }
  if (tags.some((t) => /^(deep|profond)/.test(t))) { load = 5; inferred = true; }
  else if (tags.some((t) => /^(leger|light)/.test(t))) { load = 1; inferred = true; }
  return { load, inferred };
}

/** Charge cognitive (1–5) déduite d'un texte libre (verbes, #deep, #leger) ; 3 par défaut. */
export function inferLoad(text) {
  const folded = fold(typeof text === 'string' ? text : '');
  const tags = [...folded.matchAll(/(?:^|\s)[#@]([a-z0-9_-]+)/g)].map((m) => m[1]);
  return combineLoad(findLoadWords(folded.replace(/(?:^|\s)[#@][a-z0-9_-]+/g, ' ')), tags).load;
}
