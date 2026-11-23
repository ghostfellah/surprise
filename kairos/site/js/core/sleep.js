// Sommeil : épisodes (connus + supposés), dette, heure de coucher, sieste, chronotype.
//
// Hypothèses (détaillées et sourcées dans docs/science.md) :
//  - Un « épisode » est un intervalle [startMs, endMs[ de sommeil. Les journaux (SleepLog) sont la vérité ;
//    les nuits sans journal sont SUPPOSÉES conformes à profile.usualBed / usualWake (c'est ce qui permet de
//    simuler le futur et les jours non renseignés). Les scénarios « et si ? » (whatIf) l'emportent sur tout.
//  - Dette de sommeil : déficit pondéré (poids exp(-âge/7 j)) des 14 derniers jours par rapport au besoin
//    individuel ; un excédent ne « rembourse » que la moitié (on ne stocke pas le sommeil, cf. Kitamura 2016).
//  - Cycle de sommeil ≈ 90 min, latence d'endormissement ≈ 15 min (Hirshkowitz 2015 ; Carskadon & Dement).
//  - Chronotype : MSFsc de Roenneberg et al. (2003, 2004) — milieu de sommeil des jours libres corrigé
//    du sommeil rattrapé.
// Module pur : aucun accès au DOM ni au stockage ; dépend seulement de time.js.
import {
  MIN, HOUR, DAY, startOfDay, addDays, atMinutes, parseHHMM, clamp, fmtTime, fmtDuration,
} from './time.js';

export const CYCLE_MIN = 90;
export const SLEEP_LATENCY_MIN = 15;
/** Constante de temps (jours) de la pondération de la dette. */
export const DEBT_TAU_DAYS = 7;
/** Un excédent de sommeil n'efface que cette fraction du déficit équivalent. */
export const DEBT_SURPLUS_CREDIT = 0.5;
/** Seuil (h) au-dessus duquel un épisode est une « nuit » (sinon sieste, pour l'inertie et la phase). */
export const MAIN_SLEEP_MIN_H = 3;

const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);

/** Horaire habituel du profil : minutes depuis minuit + durée (min). Tolère un profil incomplet. */
export function usualSchedule(profile = {}) {
  let bedMin = 23 * 60;
  let wakeMin = 7 * 60;
  try { bedMin = parseHHMM(profile.usualBed ?? '23:00'); } catch { /* défaut */ }
  try { wakeMin = parseHHMM(profile.usualWake ?? '07:00'); } catch { /* défaut */ }
  let durMin = (wakeMin - bedMin + 1440) % 1440;
  if (durMin < 60) durMin = 480; // bed == wake (ou absurde) : on retombe sur 8 h
  return { bedMin, wakeMin, durMin };
}

/** Besoin de sommeil (h), borné 4–12. */
export function sleepNeedH(profile = {}) {
  return clamp(num(profile.sleepNeedH, 8), 4, 12);
}

function cleanLog(s, src) {
  const startMs = Number(s?.bedMs ?? s?.startMs);
  const endMs = Number(s?.wakeMs ?? s?.endMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const dur = (endMs - startMs) / HOUR;
  return { startMs, endMs, nap: s.nap === true || dur < MAIN_SLEEP_MIN_H, src };
}

const overlaps = (a, b, pad = 0) => a.startMs < b.endMs + pad && b.startMs < a.endMs + pad;

/**
 * Construit la liste ordonnée et sans chevauchement des épisodes de sommeil sur [fromMs, toMs].
 * @param {object} o
 * @param {Array} o.sleeps journaux réels
 * @param {Array} [o.extra] scénario : sommeils/siestes qui l'emportent sur le réel et le supposé
 * @returns {{startMs:number,endMs:number,nap:boolean,src:'real'|'whatif'|'assumed'}[]}
 */
export function buildEpisodes({ sleeps = [], extra = [], profile, fromMs, toMs }) {
  const lo = fromMs - DAY;
  const hi = toMs + DAY;
  const inRange = (e) => e.endMs > lo && e.startMs < hi;
  const whatif = extra.map((s) => cleanLog(s, 'whatif')).filter(Boolean).filter(inRange);
  let real = sleeps.map((s) => cleanLog(s, 'real')).filter(Boolean).filter(inRange);
  if (whatif.length) real = real.filter((r) => !whatif.some((w) => overlaps(r, w)));
  const known = real.concat(whatif);

  // Nuits supposées : un épisode par jour civil, sauf si un sommeil connu occupe déjà la nuit (±1 h).
  const { bedMin, wakeMin, durMin } = usualSchedule(profile);
  const assumed = [];
  const firstDay = addDays(startOfDay(lo), -1);
  for (let d = firstDay; d <= hi; d = addDays(d, 1)) {
    const startMs = atMinutes(d, bedMin);
    const endMs = wakeMin > bedMin ? atMinutes(d, wakeMin) : atMinutes(addDays(d, 1), wakeMin);
    const e = { startMs, endMs: Math.max(endMs, startMs + durMin * MIN), nap: false, src: 'assumed' };
    if (!inRange(e)) continue;
    if (known.some((k) => overlaps(k, e, HOUR))) continue;
    assumed.push(e);
  }

  const all = known.concat(assumed).sort((a, b) => a.startMs - b.startMs);
  // Fusion des chevauchements résiduels (journaux en double, par ex.).
  const out = [];
  for (const e of all) {
    const last = out[out.length - 1];
    if (last && e.startMs < last.endMs) {
      last.endMs = Math.max(last.endMs, e.endMs);
      last.nap = last.nap && e.nap;
      if (e.src !== 'assumed') last.src = last.src === 'assumed' ? e.src : last.src;
    } else out.push({ ...e });
  }
  for (const e of out) e.nap = e.nap && (e.endMs - e.startMs) / HOUR < MAIN_SLEEP_MIN_H + 0.5;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dette de sommeil
// ---------------------------------------------------------------------------------------------

/** Poids d'une nuit d'âge k jours (0 = la plus récente). */
export const debtWeight = (k) => Math.exp(-k / DEBT_TAU_DAYS);

/**
 * Dette « à l'instant asOfMs » calculée sur les épisodes déjà terminés.
 * Le jour de référence (âge 0) est le jour du dernier réveil : la dette ne bouge donc qu'aux réveils.
 */
export function debtAsOf(episodes, asOfMs, needH, days = 14) {
  let lastEnd = -Infinity;
  for (const e of episodes) if (e.endMs <= asOfMs && e.endMs > lastEnd) lastEnd = e.endMs;
  const ref = startOfDay(Number.isFinite(lastEnd) ? lastEnd : asOfMs);
  const hours = new Array(days).fill(0);
  const seen = new Array(days).fill(false);
  const assumed = new Array(days).fill(true);
  for (const e of episodes) {
    if (e.endMs > asOfMs) continue;
    const age = Math.round((ref - startOfDay(e.endMs)) / DAY);
    if (age < 0 || age >= days) continue;
    // Une sieste entamée avant minuit est comptée le jour du réveil ; une nuit aussi.
    hours[age] += (e.endMs - e.startMs) / HOUR;
    seen[age] = true;
    if (e.src !== 'assumed') assumed[age] = false;
  }
  let debt = 0;
  let raw = 0;
  const perNight = [];
  for (let k = 0; k < days; k++) {
    const w = debtWeight(k);
    const slept = hours[k];
    const deficit = seen[k] ? needH - slept : 0;
    const contrib = deficit > 0 ? deficit : DEBT_SURPLUS_CREDIT * deficit;
    debt += w * contrib;
    raw += deficit;
    perNight.push({
      dayMs: addDays(ref, -k), ageDays: k, sleptH: slept, deficitH: deficit, weight: w,
      logged: seen[k] && !assumed[k], assumed: !seen[k] || assumed[k],
    });
  }
  return { debtH: Math.max(0, debt), rawDebtH: raw, perNight, refDayMs: ref };
}

/**
 * Dette de sommeil sur `days` jours (14 par défaut).
 * @returns {{debtH:number, rawDebtH:number, perNight:object[], needH:number, avgSleepH:number}}
 */
export function sleepDebt(sleeps, profile, nowMs, days = 14) {
  const needH = sleepNeedH(profile);
  const episodes = buildEpisodes({ sleeps, profile, fromMs: nowMs - (days + 2) * DAY, toMs: nowMs });
  const r = debtAsOf(episodes, nowMs, needH, days);
  const nights = r.perNight.filter((n) => n.sleptH > 0);
  const avg = nights.length ? nights.reduce((a, n) => a + n.sleptH, 0) / nights.length : needH;
  return { debtH: r.debtH, rawDebtH: r.rawDebtH, perNight: r.perNight, needH, avgSleepH: avg };
}

/** Pénalité d'alerte (points) associée à une dette (h) : saturante, ≈ 4 pts pour 4 h, max 11. */
export const debtPenaltyPts = (debtH) => 11 * (1 - Math.exp(-Math.max(0, debtH) / 8));

// ---------------------------------------------------------------------------------------------
// Heure de coucher
// ---------------------------------------------------------------------------------------------

/**
 * Meilleur coucher pour se réveiller à `wakeMs`, en cycles de 90 min + latence de 15 min.
 * @returns {{bedMs:number, sleepStartMs:number, cycles:number, durationMin:number, latencyMin:number,
 *            feasible:boolean, why:string, alternatives:object[]}}
 */
export function suggestBedtime({ wakeMs, profile, nowMs = -Infinity }) {
  const needMin = sleepNeedH(profile) * 60;
  const make = (cycles) => {
    const durationMin = cycles * CYCLE_MIN;
    const bedMs = wakeMs - (durationMin + SLEEP_LATENCY_MIN) * MIN;
    return {
      bedMs, sleepStartMs: bedMs + SLEEP_LATENCY_MIN * MIN, cycles, durationMin,
      latencyMin: SLEEP_LATENCY_MIN, feasible: bedMs >= nowMs,
      label: `${cycles} cycles · ${fmtDuration(durationMin)}`,
    };
  };
  const options = [4, 5, 6, 7].map(make);
  // Idéal : la durée qui colle au besoin ; à égalité, la plus longue (la dette pèse plus que l'excès).
  const byNeed = [...options].sort(
    (a, b) => Math.abs(a.durationMin - needMin) - Math.abs(b.durationMin - needMin) || b.cycles - a.cycles,
  );
  let best = byNeed.find((o) => o.feasible);
  let why;
  if (!best) {
    // Trop tard pour 4 cycles : on dort le plus possible à partir de maintenant.
    const avail = Math.max(0, wakeMs - nowMs - SLEEP_LATENCY_MIN * MIN) / MIN;
    const cycles = Math.max(1, Math.floor(avail / CYCLE_MIN));
    best = { ...make(cycles), bedMs: Math.max(nowMs, make(cycles).bedMs), feasible: false };
    why = `Il est tard : même en te couchant tout de suite, tu n'auras que ${cycles} cycle${cycles > 1 ? 's' : ''}. `
      + 'Une sieste courte demain et de la lumière au réveil aideront.';
  } else {
    const gap = best.durationMin - needMin;
    why = `Coucher à ${fmtTime(best.bedMs)} : ${best.cycles} cycles complets (${fmtDuration(best.durationMin)}) `
      + `+ ${SLEEP_LATENCY_MIN} min pour t'endormir, donc tu te réveilles à la fin d'un cycle`
      + (Math.abs(gap) <= 30 ? ', au plus près de ton besoin.' : gap < 0 ? ', un peu sous ton besoin.' : ', un peu au-dessus de ton besoin.');
  }
  const alternatives = options.filter((o) => o.cycles !== best.cycles)
    .sort((a, b) => Math.abs(a.durationMin - needMin) - Math.abs(b.durationMin - needMin) || b.cycles - a.cycles);
  return { ...best, why, alternatives };
}

// ---------------------------------------------------------------------------------------------
// Sieste
// ---------------------------------------------------------------------------------------------

/** Une sieste doit commencer au plus tard 8 h avant le coucher et au plus tôt 4 h après le réveil. */
const NAP_MIN_BEFORE_BED_H = 8;
const NAP_MIN_AFTER_WAKE_H = 4;

/**
 * Meilleure sieste à partir de `nowMs`, dans le creux d'alerte, loin du coucher.
 * - courte (20 min) : évite le sommeil profond donc l'inertie (Brooks & Lack 2006, Hilditch 2016) ;
 * - longue (90 min, un cycle complet) uniquement si la dette de sommeil est importante.
 * @returns {{startMs:number,endMs:number,durMin:number,why:string,alertAtStart:number}|null}
 */
export function planNap({ model, nowMs }) {
  if (!model || !model.n || !model.alertBase) return null;
  const step = model.stepMin * MIN;
  const idx = (ms) => clamp(Math.round((ms - model.t0) / step), 0, model.n - 1);
  const i0 = idx(nowMs);
  if (model.asleep[i0]) return null;

  // Dernier réveil et prochain endormissement « de nuit » (≥ 3 h de sommeil continu).
  let wakeMs = model.t0;
  for (let i = i0; i > 0; i--) if (model.asleep[i - 1] && !model.asleep[i]) { wakeMs = model.t0 + i * step; break; }
  const runLen = (i) => { let k = i; while (k < model.n && model.asleep[k]) k++; return (k - i) * step; };
  let bedMs = model.t0 + (model.n - 1) * step;
  for (let i = i0 + 1; i < model.n; i++) {
    if (model.asleep[i] && !model.asleep[i - 1] && runLen(i) >= 3 * HOUR) { bedMs = model.t0 + i * step; break; }
  }
  const latest = bedMs - NAP_MIN_BEFORE_BED_H * HOUR;
  const earliest = Math.max(nowMs, wakeMs + NAP_MIN_AFTER_WAKE_H * HOUR);
  if (latest < earliest) return null;

  const debtH = model.stats?.sleepDebtH ?? 0;
  const durMin = debtH >= 3 ? 90 : 20;
  const lookMin = durMin === 90 ? 60 : 40; // fenêtre où l'on évalue le creux
  let best = null;
  for (let s = Math.ceil(earliest / step) * step; s <= latest; s += step) {
    const i = idx(s);
    // Il faut être éveillé sur toute la fenêtre de la sieste.
    let ok = true;
    for (let t = s; t <= s + (durMin + 15) * MIN; t += step) if (model.asleep[idx(t)]) { ok = false; break; }
    if (!ok) continue;
    let sum = 0; let cnt = 0;
    for (let t = s; t <= s + lookMin * MIN; t += step) { sum += model.alertBase[idx(t)]; cnt++; }
    const mean = sum / cnt;
    // On vise le creux ; la pression de sommeil (S) départage : plus elle est haute, plus la sieste est utile.
    const score = (100 - mean) + 12 * (model.S?.[i] ?? 0.3);
    if (!best || score > best.score + 1e-9) best = { s, mean, score, alert: model.alertBase[i] };
  }
  if (!best) return null;
  // Si l'alerte reste élevée partout et que la dette est faible, la sieste n'apporte rien.
  if (best.mean >= 78 && debtH < 2) return null;

  const endMs = best.s + durMin * MIN;
  const hoursBefore = Math.round(((bedMs - endMs) / HOUR) * 10) / 10;
  const why = durMin === 20
    ? `Ton alerte plonge vers ${fmtTime(best.s)} (≈ ${Math.round(best.mean)}/100) : 20 min de sieste suffisent `
      + 'pour la relever sans entrer en sommeil profond (donc sans « gueule de bois » au réveil). '
      + `Elle finit ${hoursBefore} h avant le coucher, ce qui ne gêne pas ta nuit.`
    : `Tu as environ ${Math.round(debtH)} h de dette de sommeil : une sieste de 90 min (un cycle complet) `
      + `vers ${fmtTime(best.s)} t'évite de te réveiller en plein sommeil profond. `
      + `Elle finit ${hoursBefore} h avant le coucher.`;
  return { startMs: best.s, endMs, durMin, why, alertAtStart: Math.round(best.alert) };
}

// ---------------------------------------------------------------------------------------------
// Chronotype (MSFsc de Roenneberg)
// ---------------------------------------------------------------------------------------------

/** Minutes depuis minuit du milieu de nuit, ramenées sur [-360, 1080[ pour éviter le saut de minuit. */
function midSleepMin(startMs, endMs) {
  const mid = new Date((startMs + endMs) / 2);
  const m = mid.getHours() * 60 + mid.getMinutes();
  return m >= 1080 ? m - 1440 : m;
}

export const CHRONO_LARK_MAX_MIN = 3 * 60 + 30; // MSFsc < 03:30 → alouette
export const CHRONO_OWL_MIN_MIN = 5 * 60 + 15;  // MSFsc ≥ 05:15 → chouette

/**
 * Chronotype d'après les journaux. Utilise les nuits (≥ 3 h, hors siestes).
 * Jours libres = réveil un jour non travaillé (profile.workDays, par défaut lun–ven).
 * @returns {{msfscMin:number|null,label:string,confidence:number,n:number,freeNights:number,workNights:number,
 *            msfMin:number|null,socialJetlagMin:number|null}}
 */
export function chronotypeEstimate(sleeps, profile = {}) {
  const workDays = Array.isArray(profile.workDays) ? profile.workDays : [1, 2, 3, 4, 5];
  const nights = [];
  for (const s of sleeps || []) {
    const e = cleanLog(s, 'real');
    if (!e || e.nap) continue;
    const durH = (e.endMs - e.startMs) / HOUR;
    if (durH < MAIN_SLEEP_MIN_H || durH > 14) continue;
    nights.push({
      mid: midSleepMin(e.startMs, e.endMs), durH,
      free: !workDays.includes(new Date(e.endMs).getDay()),
    });
  }
  if (!nights.length) {
    return { msfscMin: null, label: 'inconnu', confidence: 0, n: 0, freeNights: 0, workNights: 0, msfMin: null, socialJetlagMin: null };
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const free = nights.filter((x) => x.free);
  const work = nights.filter((x) => !x.free);

  let msf;
  let msfsc;
  if (free.length) {
    msf = mean(free.map((x) => x.mid));
    const sdf = mean(free.map((x) => x.durH));
    const sdw = work.length ? mean(work.map((x) => x.durH)) : sdf;
    const nWork = workDays.length;
    const sdweek = (sdw * nWork + sdf * (7 - nWork)) / 7;
    // Correction : si on dort plus long les jours libres, on rattrape une dette → on décale le milieu de nuit.
    msfsc = sdf > sdweek ? msf - 0.5 * (sdf - sdweek) * 60 : msf;
  } else {
    // Pas de jour libre observé : on prend la moyenne de toutes les nuits, sans correction (moins fiable).
    msf = mean(nights.map((x) => x.mid));
    msfsc = msf;
  }
  const label = msfsc < CHRONO_LARK_MAX_MIN ? 'alouette' : msfsc >= CHRONO_OWL_MIN_MIN ? 'chouette' : 'intermédiaire';
  // Confiance : croît avec le nombre de nuits ; plafonnée si on n'a pas les deux types de jours.
  let confidence = 1 - Math.exp(-nights.length / 12);
  if (!free.length) confidence *= 0.5;
  else if (!work.length) confidence *= 0.75;
  const socialJetlagMin = free.length && work.length ? Math.abs(mean(free.map((x) => x.mid)) - mean(work.map((x) => x.mid))) : null;
  return {
    msfscMin: Math.round(msfsc), label, confidence: Math.round(confidence * 100) / 100,
    n: nights.length, freeNights: free.length, workNights: work.length,
    msfMin: Math.round(msf), socialJetlagMin: socialJetlagMin === null ? null : Math.round(socialJetlagMin),
  };
}
