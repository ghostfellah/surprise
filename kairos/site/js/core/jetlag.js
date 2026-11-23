// Décalage horaire : fuseaux IANA (Intl) et plan d'adaptation jour par jour fondé sur la courbe de réponse
// de phase (PRC) à la lumière.
//
// Hypothèses (sourcées et nuancées dans docs/science.md) :
//  - La lumière est le synchroniseur dominant : lumière AVANT le minimum de température centrale (CBTmin) retarde
//    l'horloge, lumière APRÈS l'avance (Khalsa et al. 2003 ; Minors, Waterhouse & Wirz 1991 ; Revell & Eastman 2005).
//    La forme de la PRC utilisée ici est qualitative (deux gaussiennes : retard centré ≈ 4 h avant CBTmin, avance
//    ≈ 4 h après) ; seule son orientation est solidement établie, pas ses amplitudes individuelles.
//  - Vitesse réaliste du décalage, SANS protocole de laboratoire : ≈ 1,0 h/jour en retard (vers l'ouest) et
//    ≈ 0,85 h/jour en avance (vers l'est). Les plans stricts de Eastman & Burgess (2009) supposent 1,5 h/j (avance)
//    et 2 h/j (retard) avec de la lumière vive bien placée : c'est un maximum, pas un attendu.
//  - Au-delà de ≈ 9-11 h vers l'est, retarder (24 − x heures) peut être plus rapide qu'avancer : le plan choisit
//    le sens qui minimise le nombre de jours et signale l'alternative. Le risque de « mauvais sens » (lumière du
//    matin tombant dans la zone de retard) est géré en calculant les fenêtres à partir de la phase estimée.
//  - Le CBTmin habituel est ancré comme dans chrono.js : réveil − 0,5 h − durée/4 (≈ réveil − 2,5 h).
//  - AUCUN médicament n'est recommandé. La mélatonine est seulement mentionnée comme « à discuter avec un
//    professionnel de santé ».
// Module pur (Intl est disponible dans Node 22 et dans les navigateurs).
import { MIN, HOUR, DAY, clamp } from './time.js';
import { usualSchedule } from './sleep.js';

export const JET = Object.freeze({
  advanceRateH: 0.85,   // h/jour réaliste vers l'avance (est)
  delayRateH: 1.0,      // h/jour réaliste vers le retard (ouest)
  preDays: 2,           // jours d'anticipation avant le départ (si le décalage dépasse 3 h)
  preGainFactor: 0.75,  // part du rythme normal atteinte à la maison
  doneThresholdH: 0.5,  // en dessous : « calé »
  maxDays: 14,
  sleepOffsetBounds: { avance: [-1, 1.5], retard: [-1, 2.5] }, // écart borné du créneau de sommeil conseillé vs habitude (h)
  naturalFloor: 0.25,   // part du rythme atteinte même sans fenêtre de lumière idéale (jour/nuit locaux, repas, horaires)
});

// ---------------------------------------------------------------------------------------------
// Fuseaux horaires via Intl
// ---------------------------------------------------------------------------------------------

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
    } catch {
      throw new Error(`Fuseau horaire inconnu : ${tz}`);
    }
    dtfCache.set(tz, f);
  }
  return f;
}

/** Composantes de l'heure murale de `ms` dans le fuseau `tz`. */
export function zonedParts(tz, ms) {
  const o = {};
  for (const p of dtf(tz).formatToParts(ms)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}

/** Décalage (minutes) de `tz` par rapport à UTC à l'instant `ms` : heure locale − UTC. */
export function tzOffsetMin(tz, ms) {
  const p = zonedParts(tz, ms);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MIN);
}

/** Instant (ms) où l'heure murale de `tz` vaut y-mo-d + `hours` heures (peut dépasser 24 ou être négatif). */
export function zonedTime(tz, y, mo, d, hours) {
  const wall = Date.UTC(y, mo - 1, d, 0, 0, 0) + hours * HOUR;
  let guess = wall - tzOffsetMin(tz, wall) * MIN;
  guess = wall - tzOffsetMin(tz, guess) * MIN; // 2e passe : cas autour d'un changement d'heure
  return guess;
}

/** Minuit local (dans `tz`) du jour contenant `ms`. */
export function zonedMidnight(tz, ms) {
  const p = zonedParts(tz, ms);
  return zonedTime(tz, p.y, p.mo, p.d, 0);
}

const addZonedDays = (tz, midnightMs, n) => zonedMidnight(tz, midnightMs + n * DAY + 12 * HOUR);

/** "14:05" dans le fuseau `tz`. */
export function fmtTimeTz(tz, ms) {
  const p = zonedParts(tz, ms);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

/** "Europe/Paris" -> "Paris", "America/Argentina/Buenos_Aires" -> "Buenos Aires". */
export const tzCity = (tz) => String(tz).split('/').pop().replace(/_/g, ' ');

// ---------------------------------------------------------------------------------------------
// Courbe de réponse de phase à la lumière
// ---------------------------------------------------------------------------------------------

const gauss = (x, mu, sd) => Math.exp(-0.5 * ((x - mu) / sd) ** 2);
/**
 * Réponse normalisée (−1 = retard maximal, +1 = avance maximale) à de la lumière vive,
 * x = heures depuis le CBTmin (−12..12).
 */
export function prc(x) {
  const w = ((x + 12) % 24 + 24) % 24 - 12;
  return gauss(w, 4, 3) - gauss(w, -4, 2.8);
}

/** Intégrale de la PRC (orientée : +1 avance, −1 retard) sur [startMs, endMs] pour un CBTmin à cbtMs. */
function prcIntegral(sign, cbtMs, startMs, endMs) {
  let sum = 0;
  const step = 10 * MIN;
  for (let t = startMs + step / 2; t < endMs; t += step) {
    sum += Math.max(0, sign * prc((t - cbtMs) / HOUR)) * (step / HOUR);
  }
  return sum;
}

// Référence : meilleure fenêtre de 3 h (dans la zone d'avance, ou de retard).
const REF = { 1: 0, [-1]: 0 };
for (const sign of [1, -1]) {
  for (let off = -8; off <= 8; off += 0.25) REF[sign] = Math.max(REF[sign], prcIntegral(sign, 0, off * HOUR, (off + 3) * HOUR));
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

const wrap24 = (h) => ((h % 24) + 24) % 24;
const wrap12 = (h) => ((h + 12) % 24 + 24) % 24 - 12;
const r1 = (x) => Math.round(x * 10) / 10;

function chooseDirection(diffH) {
  const A = wrap24(diffH); // avance nécessaire (h)
  const D = 24 - A;        // retard nécessaire (h)
  const daysAdv = A / JET.advanceRateH;
  const daysDel = D / JET.delayRateH;
  const adv = { dir: 'avance', hours: A, days: daysAdv };
  const del = { dir: 'retard', hours: D, days: daysDel };
  return daysAdv <= daysDel ? { best: adv, other: del } : { best: del, other: adv };
}

/** Fenêtres de lumière pour un CBTmin à `cbtMs`, dans le sens `dir` ('avance' | 'retard'). */
function lightWindows(dir, cbtMs) {
  if (dir === 'avance') {
    return {
      seek: { start: cbtMs + 1 * HOUR, end: cbtMs + 4 * HOUR },
      avoid: { start: cbtMs - 5 * HOUR, end: cbtMs + 1 * HOUR },
    };
  }
  return {
    seek: { start: cbtMs - 5 * HOUR, end: cbtMs - 2 * HOUR },
    avoid: { start: cbtMs + 0 * HOUR, end: cbtMs + 5 * HOUR },
  };
}

const overlapRange = (a, lo, hi) => {
  const start = Math.max(a.start, lo);
  const end = Math.min(a.end, hi);
  return end - start >= 20 * MIN ? { start, end } : null;
};

/**
 * Plan d'adaptation.
 * Convention : pour une ligne `days[k]`, `sleepBed`/`sleepWake` décrivent la nuit qui COMMENCE ce jour-là
 * (coucher le soir de dayMs ou juste après minuit, réveil le lendemain matin).
 * @returns {{shiftH:number, direction:'est'|'ouest'|'aucun', phaseDirection:'avance'|'retard'|null, phaseShiftH:number,
 *   daysToAdapt:number, alternative:object|null, days:object[], summary:string, notes:string[], originTz:string, destTz:string}}
 */
export function planJetlag({ originTz, destTz, departMs, arriveMs, profile = {} }) {
  if (!(arriveMs > departMs)) throw new Error("L'arrivée doit être postérieure au départ.");
  const offO = tzOffsetMin(originTz, departMs);
  const offD = tzOffsetMin(destTz, arriveMs);
  const diffH = (offD - offO) / 60; // > 0 : la destination est en avance sur l'origine (voyage vers l'est)
  const base = {
    shiftH: diffH, direction: diffH > 0 ? 'est' : diffH < 0 ? 'ouest' : 'aucun',
    originTz, destTz, originOffsetMin: offO, destOffsetMin: offD,
  };
  const cityD = tzCity(destTz);
  const notes = [
    'Ce plan est un outil de confort, pas un avis médical. Les durées sont des ordres de grandeur : chacun s\'adapte à son rythme.',
    'La mélatonine est parfois utilisée pour les grands décalages : c\'est un sujet à discuter avec un professionnel de santé (dose, moment et contre-indications comptent).',
  ];
  if (Math.abs(diffH) < 0.5) {
    return {
      ...base, phaseDirection: null, phaseShiftH: 0, daysToAdapt: 0, alternative: null, days: [],
      summary: `Pas de décalage horaire entre ${tzCity(originTz)} et ${cityD} : rien à adapter.`, notes,
    };
  }

  const sched = usualSchedule(profile);
  const bedH = sched.bedMin / 60;
  const durH = sched.durMin / 60;
  const wakeH = bedH + durH;
  const cbtH = wrap24(sched.wakeMin / 60 - 0.5 - durH / 4 + (Number(profile.chronoShiftMin) || 0) / 60);

  const { best, other } = chooseDirection(diffH);
  const sign = best.dir === 'avance' ? 1 : -1;
  const rate = best.dir === 'avance' ? JET.advanceRateH : JET.delayRateH;
  const shiftSign = best.dir === 'avance' ? -1 : 1; // une avance déplace le CBTmin vers des heures plus petites

  const needPre = best.hours >= 3;
  const preDays = needPre ? JET.preDays : 0;
  const preGain = Math.min(1, rate * JET.preGainFactor);
  let R = Math.max(0, best.hours - preDays * preGain); // décalage interne restant à l'arrivée (h, dans le sens choisi)
  const days = [];

  const labelRange = (tz, r) => ({
    start: r.start, end: r.end, startLabel: fmtTimeTz(tz, r.start), endLabel: fmtTimeTz(tz, r.end),
  });
  const rangeTxt = (tz, r) => `${fmtTimeTz(tz, r.start)}-${fmtTimeTz(tz, r.end)}`;
  const sleepFor = (tz, midnightMs, offH) => {
    const p = zonedParts(tz, midnightMs + 12 * HOUR);
    const bedHour = (bedH < 12 ? bedH + 24 : bedH) + offH;
    const bed = zonedTime(tz, p.y, p.mo, p.d, bedHour);
    const wake = zonedTime(tz, p.y, p.mo, p.d, bedHour + durH);
    return { bed, wake };
  };
  const hhmm = (h) => { const m = Math.round(wrap24(h) * 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

  // --- Jours avant le départ (fuseau d'origine) ---
  const departMid = zonedMidnight(originTz, departMs);
  for (let i = preDays; i >= 1; i--) {
    const dayMs = addZonedDays(originTz, departMid, -i);
    const stepNo = preDays - i + 1;
    const cum = stepNo * preGain;
    const off = shiftSign * cum; // coucher de plus en plus tôt (avance) ou tard (retard)
    const { bed, wake } = sleepFor(originTz, dayMs, off);
    const phiBefore = cbtH + shiftSign * (cum - preGain);
    const cbt = zonedTime(originTz, ...ymd(originTz, dayMs), phiBefore);
    const w = lightWindows(best.dir, cbt);
    const dayEnd = dayMs + 26 * HOUR;
    // La lumière ne se cherche qu'éveillé : on découpe les fenêtres dans la journée éveillée.
    const awakeLo = wake - DAY;
    const seek = [-1, 0, 1].map((n) => overlapRange({ start: w.seek.start + n * DAY, end: w.seek.end + n * DAY }, Math.max(dayMs, awakeLo), Math.min(dayEnd - 2 * HOUR, bed))).find(Boolean) || null;
    const avoid = [-1, 0, 1].map((n) => overlapRange({ start: w.avoid.start + n * DAY, end: w.avoid.end + n * DAY }, Math.max(dayMs, awakeLo), Math.min(dayEnd - 2 * HOUR, bed))).find(Boolean) || null;
    const tipLight = best.dir === 'avance'
      ? 'Sors à la lumière naturelle dans la demi-heure qui suit ton réveil et baisse les lumières le soir.'
      : 'Profite de la lumière en fin d\'après-midi et en début de soirée ; évite de te lever trop tôt.';
    days.push({
      dayMs, tz: originTz, phase: 'avant', label: `J−${i} · avant le départ`,
      sleepBed: bed, sleepWake: wake, sleepBedLabel: fmtTimeTz(originTz, bed), sleepWakeLabel: fmtTimeTz(originTz, wake),
      seekLight: seek ? [labelRange(originTz, seek)] : [], avoidLight: avoid ? [labelRange(originTz, avoid)] : [],
      advice: `Prépare ton horloge : couche-toi vers ${fmtTimeTz(originTz, bed)} (${best.dir === 'avance' ? 'environ ' + r1(cum) + ' h plus tôt' : 'environ ' + r1(cum) + ' h plus tard'} que d'habitude). ${tipLight}`,
      residualH: r1(Math.max(0, best.hours - cum)), cbtMinMs: cbt,
    });
  }

  // --- Jour du départ ---
  {
    const dayMs = departMid;
    const cumPre = preDays * preGain;
    // Nuit conseillée dans l'avion : celle de la destination qui précède l'arrivée, si elle recoupe le vol.
    const arrMidD = zonedMidnight(destTz, arriveMs);
    const night = sleepFor(destTz, addZonedDays(destTz, arrMidD, -1), 0);
    const lo = Math.max(night.bed, departMs);
    const hi = Math.min(night.wake, arriveMs);
    const sleepOk = hi - lo >= 90 * MIN;
    days.push({
      dayMs, tz: originTz, phase: 'vol', label: 'Jour du vol',
      sleepBed: sleepOk ? lo : null, sleepWake: sleepOk ? hi : null,
      sleepBedLabel: sleepOk ? fmtTimeTz(destTz, lo) : null, sleepWakeLabel: sleepOk ? fmtTimeTz(destTz, hi) : null,
      seekLight: [], avoidLight: [],
      advice: `Règle ta montre sur l'heure de ${cityD} dès l'embarquement. `
        + (sleepOk
          ? `Dors dans l'avion seulement entre ${fmtTimeTz(destTz, lo)} et ${fmtTimeTz(destTz, hi)} (heure de ${cityD}), c'est la nuit là-bas ; le reste du temps, reste éveillé(e). `
          : `Le vol ne recoupe pas la nuit de ${cityD} : évite de t'endormir longtemps, pour arriver avec du sommeil à rattraper. `)
        + 'Bois de l\'eau, limite l\'alcool, et garde la caféine pour le « matin » de destination.',
      residualH: r1(best.hours - cumPre), cbtMinMs: null,
    });
  }

  // --- Jours à destination ---
  const arrMid = zonedMidnight(destTz, arriveMs);
  const usableFrom = arriveMs + 90 * MIN; // douane, bagages, trajet
  let adapted = false;
  for (let k = 0; k < JET.maxDays && !adapted; k++) {
    const dayMs = addZonedDays(destTz, arrMid, k);
    const p = zonedParts(destTz, dayMs + 12 * HOUR);
    // Position du CBTmin du corps (heure murale de destination) : cible + R (avance restante) ou − R (retard restant).
    const phiH = wrap24(cbtH + (best.dir === 'avance' ? R : -R));
    const cbt = zonedTime(destTz, p.y, p.mo, p.d, phiH);
    const [offLo, offHi] = JET.sleepOffsetBounds[best.dir];
    const off = clamp(wrap12(phiH - cbtH), offLo, offHi);
    const { bed, wake } = sleepFor(destTz, dayMs, off);
    const awakeFrom = wake - DAY; // réveil du matin de ce jour (même créneau que la nuit conseillée)
    const awakeTo = bed;
    const wins = [-1, 0, 1].map((n) => lightWindows(best.dir, cbt + n * DAY));
    const lo = Math.max(awakeFrom, k === 0 ? usableFrom : dayMs);
    const hi = Math.min(awakeTo, dayMs + 24 * HOUR);
    const seek = wins.map((w) => overlapRange(w.seek, lo, hi)).filter(Boolean);
    const avoid = wins.map((w) => overlapRange(w.avoid, k === 0 ? arriveMs : dayMs, dayMs + 24 * HOUR)).filter(Boolean);
    // Efficacité = part de la meilleure fenêtre de 3 h réellement exploitée (lumière uniquement éveillé).
    let eff = 0;
    for (const s of seek) eff += prcIntegral(sign, cbt, s.start, s.end); // la PRC est périodique (24 h)
    eff = clamp(eff / REF[sign], 0, 1);
    const gain = Math.min(R, rate * Math.max(eff, JET.naturalFloor));
    const Rnext = Math.max(0, R - gain);
    adapted = Rnext <= JET.doneThresholdH;

    const label = k === 0 ? `Jour d'arrivée · ${cityD}` : `Jour ${k + 1} · ${cityD}`;
    const seekTxt = seek.length ? seek.map((s) => rangeTxt(destTz, s)).join(' puis ') : null;
    const avoidTxt = avoid.length ? avoid.map((s) => rangeTxt(destTz, s)).join(' et ') : null;
    const parts = [];
    if (k === 0) parts.push(`Tu arrives avec environ ${r1(R)} h de décalage interne à rattraper (${best.dir === 'avance' ? 'ton horloge est en retard sur l\'heure locale' : 'ton horloge est en avance sur l\'heure locale'}).`);
    if (seekTxt) parts.push(`Cherche la lumière vive dehors (même nuageux) de ${seekTxt} : c'est la fenêtre qui ${best.dir === 'avance' ? 'avance' : 'retarde'} le plus ton horloge.`);
    else parts.push('Aucune fenêtre de lumière utile en journée aujourd\'hui : reste actif(ve) et sors quand même un moment.');
    if (avoidTxt) parts.push(`Évite la lumière forte (lunettes de soleil, écrans en veille) de ${avoidTxt} : elle pousserait ton horloge dans le mauvais sens.`);
    parts.push(`Couche-toi vers ${fmtTimeTz(destTz, bed)} et lève-toi vers ${fmtTimeTz(destTz, wake)}${Math.abs(off) >= 0.5 ? ' (créneau intermédiaire entre ton horloge et l\'heure locale)' : ''}.`);
    if (R > 2) parts.push('Si tu dois faire une sieste, 20 min max et avant 15 h (heure locale).');
    if (adapted) parts.push(`Tu es calé(e) à moins de 1 h : tu peux reprendre ton rythme local habituel.`);
    days.push({
      dayMs, tz: destTz, phase: k === 0 ? 'arrivée' : 'adaptation', label,
      sleepBed: bed, sleepWake: wake, sleepBedLabel: fmtTimeTz(destTz, bed), sleepWakeLabel: fmtTimeTz(destTz, wake),
      seekLight: seek.map((s) => labelRange(destTz, s)), avoidLight: avoid.map((s) => labelRange(destTz, s)),
      advice: parts.join(' '), residualH: r1(Rnext), cbtMinMs: cbt, efficiency: r1(eff),
    });
    R = Rnext;
  }

  const adaptDays = days.filter((d) => d.phase === 'arrivée' || d.phase === 'adaptation').length;
  const dirTxt = best.dir === 'avance' ? 'avancer' : 'retarder';
  const alt = {
    phaseDirection: other.dir, phaseShiftH: r1(other.hours), daysToAdapt: Math.ceil(other.days),
  };
  let summary = `${cityD} est ${diffH > 0 ? 'en avance' : 'en retard'} de ${r1(Math.abs(diffH))} h sur ${tzCity(originTz)}. `
    + `Il faut ${dirTxt} ton horloge d'environ ${r1(best.hours)} h : compte ≈ ${adaptDays} jours en suivant le plan `
    + '(sans stratégie, on compte grossièrement un jour par heure de décalage).';
  if (best.hours >= 9) summary += ` Avec un décalage aussi grand, ${other.dir === 'avance' ? 'avancer' : 'retarder'} de ${r1(other.hours)} h serait l'autre option (≈ ${Math.ceil(other.days)} jours).`;
  return {
    ...base, phaseDirection: best.dir, phaseShiftH: r1(best.hours), daysToAdapt: adaptDays,
    alternative: alt, days, summary, notes, preDays,
  };
}

/** [y, mo, d] du jour mural de `tz` contenant `ms` (+12 h pour rester dans la bonne date). */
function ymd(tz, midnightMs) {
  const p = zonedParts(tz, midnightMs + 12 * HOUR);
  return [p.y, p.mo, p.d];
}
