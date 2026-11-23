// Vue « La science » : le modèle de Kairos expliqué par des schémas qu'on peut manipuler.
//  01 · Deux horloges : S (pression de sommeil) et C (horloge interne) tracés en direct, avec trois curseurs
//       (heures de veille, nuit précédente, décalage de chronotype) et la formule de l'alerte avec les vrais poids du moteur.
//  02 · La caféine : décroissance d'ordre 1 (dose, heure, demi-vie) avec une tasse qui se vide.
//  03 · Les trois processus : S, C et l'inertie du sommeil de TA journée, puis leur somme (données de buildModel).
//  04 · Ce qu'on sait, ce qu'on suppose : statut de chaque paramètre, limites, honnêteté.
//  05 · Références (celles de docs/science.md) et glossaire.
//
// Les courbes du §01 utilisent les MÊMES équations et constantes que chrono.js (DEFAULT_PARAMS, circadianC) mais sans
// inertie, dette ni caféine : une version volontairement simplifiée pour qu'on voie chaque ingrédient.
// Aucun chiffre n'est inventé : ce qui n'est pas dans docs/science.md n'est pas affiché.
import { h, svg, icon, replaceChildren, animateNumber, haptic, prefersReducedMotion, uniqueId } from '../dom.js';
import { DEFAULT_PARAMS, circadianC, simulateProcessesRaw } from '../../core/chrono.js';
import { caffeineCurve, caffeineCutoff, alertnessBoost, CAFFEINE } from '../../core/caffeine.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const P = DEFAULT_PARAMS;

// ---------------------------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------------------------
function ensureCss(file) {
  const url = new URL(file, document.baseURI).href;
  const found = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find((l) => l.href === url);
  if (found) return found.sheet ? Promise.resolve() : new Promise((r) => { found.addEventListener('load', r, { once: true }); setTimeout(r, 1200); });
  return new Promise((resolve) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = url;
    l.addEventListener('load', resolve, { once: true }); l.addEventListener('error', resolve, { once: true });
    document.head.appendChild(l); setTimeout(resolve, 1200);
  });
}

// ---------------------------------------------------------------------------------------------
// Petits utilitaires
// ---------------------------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const wrap24 = (x) => ((x % 24) + 24) % 24;
const wrap12 = (x) => ((x + 12) % 24 + 24) % 24 - 12;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const f1 = (x) => (Math.round(x * 10) / 10).toString().replace('.', ',');
const f2 = (x) => x.toFixed(2).replace('.', ',');
const clock = (hh) => { const m = Math.round(wrap24(hh) * 60) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const dur = (hh) => { const m = Math.round(hh * 60), a = Math.floor(m / 60), r = m % 60; return a === 0 ? `${r} min` : r ? `${a} h ${pad(r)}` : `${a} h`; };
const softClip = (x) => (x <= 88 ? Math.max(0, x) : 88 + 12 * Math.tanh((x - 88) / 12));
const hhmmToH = (s, d) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? +m[1] + +m[2] / 60 : d; };

const path = (xs, ys) => xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${ys[i].toFixed(1)}`).join('');

/** Dessine `draw(width)` dans `host` et le redessine quand la largeur change. Renvoie { redraw, stop }. */
function responsive(host, draw) {
  let w = 0, raf = 0;
  const run = (force) => { const nw = Math.round(host.clientWidth); if (nw < 40) return; if (!force && Math.abs(nw - w) < 2) return; w = nw; draw(nw); };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => run(false)); }) : null;
  if (ro) ro.observe(host);
  run(true);
  return { redraw: () => run(true), stop: () => { cancelAnimationFrame(raf); if (ro) ro.disconnect(); } };
}

// ---------------------------------------------------------------------------------------------
// § 01 — Simulation pédagogique de S et C (mêmes équations que chrono.js, version simplifiée)
// ---------------------------------------------------------------------------------------------
/**
 * Temps t en heures à partir du réveil du jour 0 (t = 0). Renvoie des échantillons tous les 15 min.
 * - nuit précédente : [−prevNightH, 0] ; tonight : [awakeH, awakeH + needH] ; nuits plus anciennes : régulières.
 * - C : phase ancrée sur l'horaire habituel (CBTmin = réveil − 0,5 h − besoin/4) + décalage de chronotype.
 */
export function toySim({ wake = 7, awakeH = 16, prevNightH = 8, shiftMin = 0, needH = 8, dip = true } = {}) {
  const k = needH / 8, tauI = P.tauWakeH / k, tauD = P.tauSleepH * k;
  const eps = [];
  for (let j = 5; j >= 2; j--) eps.push([-24 * j - needH, -24 * j]);
  eps.push([-24 - needH, -24]);
  eps.push([-prevNightH, 0]);
  eps.push([awakeH, awakeH + needH]);
  // S aux frontières des épisodes
  let sPrev = P.S0, tPrev = -24 * 7;
  const sOn = [], sEnd = [];
  for (const [a, b] of eps) {
    const on = 1 - (1 - sPrev) * Math.exp(-Math.max(0, a - tPrev) / tauI);
    const end = on * Math.exp(-(b - a) / tauD);
    sOn.push(on); sEnd.push(end); sPrev = end; tPrev = b;
  }
  const sAt = (t) => {
    let j = 0; while (j < eps.length && eps[j][1] <= t) j++;
    if (j < eps.length && eps[j][0] <= t) return { s: sOn[j] * Math.exp(-(t - eps[j][0]) / tauD), asleep: true };
    const prevEnd = j > 0 ? eps[j - 1][1] : -24 * 7, sp = j > 0 ? sEnd[j - 1] : P.S0;
    return { s: 1 - (1 - sp) * Math.exp(-(t - prevEnd) / tauI), asleep: false };
  };
  const cbt = wake - P.cbtAnchorBeforeWakeH - needH / 4 + shiftMin / 60;
  const t0 = -prevNightH - 0.5, t1 = Math.min(t0 + 56, awakeH + needH + 1.5);
  const ts = [], S = [], C = [], A = [], asleep = [], parts = [];
  for (let t = t0; t <= t1 + 1e-9; t += 0.25) {
    const { s, asleep: sl } = sAt(t);
    const tau = wrap24(wake + t - cbt), c = circadianC(tau, P);
    const dp = dip ? P.postprandial.depth * Math.exp(-0.5 * (wrap12(tau - P.postprandial.centerAfterCbtH) / P.postprandial.sigmaH) ** 2) : 0;
    ts.push(t); S.push(s); C.push(c); asleep.push(sl);
    A.push(sl ? null : softClip(P.base + P.wC * c - P.wS * s - dp));
    parts.push({ dip: dp });
  }
  return { ts, S, C, A, asleep, parts, eps, t0, t1, wake, cbt, needH, awakeH, prevNightH };
}

// ---------------------------------------------------------------------------------------------
// § 02 — Courbe de caféine
// ---------------------------------------------------------------------------------------------
function caffeineSim({ doseMg, drinkH, halfLifeH, sensitivity, bedH }) {
  const profile = { caffeineHalfLifeH: halfLifeH, caffeineSensitivity: sensitivity };
  const stepMin = 10, startH = 5, hours = 24, n = hours * 6 + 1;
  const t0 = 0;
  const logs = [{ tMs: (drinkH - startH) * HOUR, mg: doseMg }];
  const mg = caffeineCurve(logs, profile, t0, stepMin, n);
  const ts = mg.map((_, i) => startH + (i * stepMin) / 60);
  let pk = 0; mg.forEach((v, i) => { if (v > mg[pk]) pk = i; });
  const peak = mg[pk], peakH = ts[pk];
  let halfH = null; for (let i = pk; i < n; i++) if (mg[i] <= peak / 2) { halfH = ts[i]; break; }
  const bedIdx = Math.round(((bedH < startH ? bedH + 24 : bedH) - startH) * 6);
  const atBed = mg[Math.min(n - 1, Math.max(0, bedIdx))] ?? 0;
  const bedAbs = (((bedH < startH ? bedH + 24 : bedH) - startH) * HOUR);
  const cutoffMs = caffeineCutoff({ logs: [], profile, bedMs: bedAbs, doseMg });
  const cutoffH = startH + cutoffMs / HOUR;
  const boosts = mg.map((m) => alertnessBoost(m, profile, { S: 0.5 }));
  return { ts, mg, peak, peakH, halfH, atBed, cutoffH, boosts, startH, hours, bedH: bedH < startH ? bedH + 24 : bedH, drinkH, peakBoost: Math.max(...boosts) };
}

// ---------------------------------------------------------------------------------------------
// Contenus : paramètres, limites, références, glossaire (tirés de docs/science.md)
// ---------------------------------------------------------------------------------------------
const STATUS = { mesure: ['Mesuré', 'chip--night'], ordre: ['Ordre de grandeur', 'chip--sun'], choix: ['Choix de modélisation', 'chip--coral'] };
const PARAMS = [
  ['Montée de S en veille', 'τ ≈ 18,2 h', 'mesure', 'Achermann et al. 1993 ; Borbély & Achermann 1999'],
  ['Décroissance de S en sommeil', 'τ ≈ 4,2 h', 'mesure', 'Achermann et al. 1993'],
  ['Période de l\'horloge', '24 h (entraînée)', 'choix', 'La période intrinsèque est ≈ 24,2 h (Czeisler 1999)'],
  ['Minimum de température (CBTmin)', 'réveil − 0,5 h − durée/4', 'ordre', 'Burgess & Eastman ; Roenneberg'],
  ['Inertie du sommeil', '15 à 60 min', 'ordre', 'Tassi & Muzet 2000'],
  ['Poids de C, de S, base', '63 · 55 · 69,5 points', 'choix', 'Ajustés à la main sur une courbe cible'],
  ['Creux d\'après-midi', '7 points, vers 14 h', 'choix', 'Monk 2005 pour l\'existence du creux'],
  ['Demi-vie de la caféine', '≈ 5 h (3 à 9 h)', 'mesure', 'Nehlig 2018 — très variable'],
  ['Pic de caféine', '≈ 40 min (30 à 60)', 'ordre', 'Blanchard & Sawers 1983'],
  ['Seuil de caféine au coucher', '25 mg', 'choix', 'Prudent, inspiré de Drake et al. 2013'],
  ['Effet maximal de la caféine', '16 points, EC50 70 mg', 'choix', 'Smith 2002, Lieberman 2002 pour l\'ordre de grandeur'],
  ['Vitesse d\'adaptation au décalage', '0,85 h/j (est) · 1,0 h/j (ouest)', 'ordre', 'Eastman & Burgess 2009 donnent des maxima plus élevés'],
];

const LIMITS = [
  ['alert', 'Pas un dispositif médical', 'Kairos est un outil de confort et d\'organisation. Il ne diagnostique rien, ne remplace pas un avis médical et ne doit jamais servir à décider de conduire ou d\'opérer une machine en étant fatigué. Si tu dors mal durablement, as une somnolence dangereuse ou des ronflements avec pauses respiratoires, parles-en à un professionnel de santé.'],
  ['target', 'Un modèle de population, pas toi', 'Les équations viennent d\'études sur des groupes. La forme d\'une journée type (pic en fin de matinée, creux d\'après-midi, second souffle en soirée) est bien documentée ; les amplitudes précises ne le sont pas. Sur un individu, compte plusieurs points d\'alerte et environ ± 1 h sur l\'heure des pics et des creux : Kairos affiche donc des fenêtres, pas des instants.'],
  ['sliders', 'Des poids ajustés à la main', 'Les poids relatifs de S, de C, de l\'inertie et du creux d\'après-midi ont été calés sur une courbe cible dessinée à la main (erreur d\'environ 1,4 point sur 12 repères), pas sur un jeu de données. Ils ne sont pas personnalisés : seuls ton chronotype, ta sensibilité à la caféine et ton besoin de sommeil le sont, grâce à tes check-ins.'],
  ['brain', 'L\'alerte est subjective', 'Vigilance, humeur, créativité et mémoire n\'ont pas le même rythme. Kairos modélise une alerte « générale », proche de la somnolence subjective. Le travail créatif peut parfois mieux marcher hors des pics.'],
  ['globe', 'Validité externe limitée', 'Pas de modèle de lumière (écrans, extérieur), de saisons, de stress, d\'alcool, d\'exercice, de repas, de cycle menstruel ni de maladie. Pas de tolérance à la caféine ni de stades de sommeil ; les nuits non renseignées sont des hypothèses. Le plan anti-décalage suppose que tu suis réellement les fenêtres de lumière.'],
  ['eye', 'Des idées populaires faiblement étayées', 'Attendre 60 à 90 min après le réveil pour le café, ou se réveiller « en fin de cycle » de 90 min : les preuves sont minces et l\'effet est modeste. Kairos ne les applique qu\'avec une légère pondération et le dit.'],
];

// [auteurs, année, titre, revue, thèmes]
const REFS = [
  ['Åkerstedt T, Folkard S', 1995, 'Validation of the S and C components of the three-process model of alertness regulation', 'Sleep 18:1–6', ['s', 'c']],
  ['Achermann P, Dijk DJ, Brunner DP, Borbély AA', 1993, 'A model of human sleep homeostasis based on EEG slow-wave activity', 'Brain Res Bull 31:97–113', ['s']],
  ['Benloucif S et al.', 2005, 'Stability of melatonin and temperature as circadian phase markers', 'J Biol Rhythms 20:178–188', ['c']],
  ['Blanchard J, Sawers SJ', 1983, 'The absolute bioavailability of caffeine in man', 'J Pharmacokinet Biopharm 11:109–126', ['caf']],
  ['Borbély AA', 1982, 'A two process model of sleep regulation', 'Hum Neurobiol 1:195–204', ['s', 'c']],
  ['Borbély AA, Achermann P', 1999, 'Sleep homeostasis and models of sleep regulation', 'J Biol Rhythms 14:559–570', ['s']],
  ['Brooks A, Lack L', 2006, 'A brief afternoon nap following nocturnal sleep restriction', 'Sleep 29:831–840', ['nap']],
  ['Czeisler CA et al.', 1999, 'Stability, precision, and near-24-hour period of the human circadian pacemaker', 'Science 284:2177–2181', ['c']],
  ['Daan S, Beersma DGM, Borbély AA', 1984, 'Timing of human sleep: recovery process gated by a circadian pacemaker', 'Am J Physiol 246:R161–R183', ['s', 'c']],
  ['Dijk DJ, Czeisler CA', 1995, 'Contribution of the circadian pacemaker and the sleep homeostat to sleep propensity, sleep structure, EEG slow waves and sleep spindles in humans', 'J Neurosci 15:3526–3538', ['s', 'c']],
  ['Drake C, Roehrs T, Shambroom J, Roth T', 2013, 'Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed', 'J Clin Sleep Med 9:1195–1200', ['caf']],
  ['Eastman CI, Burgess HJ', 2009, 'How to travel the world without jet lag', 'Sleep Med Clin 4:241–255', ['jet']],
  ['EFSA', 2015, 'Scientific opinion on the safety of caffeine', 'EFSA Journal 13:4102', ['caf']],
  ['Fredholm BB et al.', 1999, 'Actions of caffeine in the brain with special reference to factors that contribute to its widespread use', 'Pharmacol Rev 51:83–133', ['caf']],
  ['Hilditch CJ, Dorrian J, Banks S', 2016, 'A review of short naps and sleep inertia', 'Sleep Med 25:157–165', ['nap']],
  ['Hirshkowitz M et al.', 2015, 'National Sleep Foundation\'s sleep time duration recommendations', 'Sleep Health 1:40–43', ['s']],
  ['Khalsa SBS, Jewett ME, Cajochen C, Czeisler CA', 2003, 'A phase response curve to single bright light pulses in human subjects', 'J Physiol 549:945–952', ['jet', 'c']],
  ['Kitamura S et al.', 2016, 'Estimating individual optimal sleep duration and potential sleep debt', 'Sci Rep 6:35812', ['s']],
  ['Lieberman HR et al.', 2002, 'Effects of caffeine, sleep loss, and stress on cognitive performance and mood during U.S. Navy SEAL training', 'Psychopharmacology 164:250–261', ['caf']],
  ['Minors DS, Waterhouse JM, Wirz-Justice A', 1991, 'A human phase-response curve to light', 'Neurosci Lett 133:36–40', ['jet', 'c']],
  ['Monk TH', 2005, 'The post-lunch dip in performance', 'Clin Sports Med 24:e15–e23', ['c']],
  ['Nehlig A', 2018, 'Interindividual differences in caffeine metabolism and factors driving caffeine consumption', 'Pharmacol Rev 70:384–411', ['caf']],
  ['Porkka-Heiskanen T, Kalinchuk AV', 2011, 'Adenosine, energy metabolism and sleep homeostasis', 'Sleep Med Rev 15:123–135', ['s', 'caf']],
  ['Revell VL, Eastman CI', 2005, 'How to trick mother nature into letting you fly around or stay up all night', 'J Biol Rhythms 20:353–365', ['jet', 'c']],
  ['Roenneberg T, Wirz-Justice A, Merrow M', 2003, 'Life between clocks: daily temporal patterns of human chronotypes', 'J Biol Rhythms 18:80–90', ['c']],
  ['Roenneberg T et al.', 2004, 'A marker for the end of adolescence', 'Curr Biol 14:R1038–R1039', ['c']],
  ['Smith A', 2002, 'Effects of caffeine on human behavior', 'Food Chem Toxicol 40:1243–1255', ['caf']],
  ['Strogatz SH, Kronauer RE, Czeisler CA', 1987, 'Circadian pacemaker interferes with sleep onset at specific times each day', 'Am J Physiol 253:R172–R178', ['c']],
  ['Tassi P, Muzet A', 2000, 'Sleep inertia', 'Sleep Med Rev 4:341–353', ['nap']],
  ['Van Dongen HPA, Maislin G, Mullington JM, Dinges DF', 2003, 'The cumulative cost of additional wakefulness', 'Sleep 26:117–126', ['s']],
  ['Waterhouse J, Reilly T, Atkinson G, Edwards B', 2007, 'Jet lag: trends and coping strategies', 'Lancet 369:1117–1129', ['jet']],
];
const THEMES = [['all', 'Tout'], ['s', 'Pression de sommeil'], ['c', 'Horloge'], ['caf', 'Caféine'], ['nap', 'Inertie et siestes'], ['jet', 'Décalage horaire']];

const GLOSSARY = [
  ['Alerte', 'Ton niveau d\'éveil et de disponibilité mentale, de 0 à 100. C\'est une estimation de ce que tu ressentirais, pas une mesure.'],
  ['Pression de sommeil (S)', 'Le « besoin de dormir » qui s\'accumule tant que tu es éveillé et se dissipe pendant le sommeil. L\'adénosine en est un acteur clé.'],
  ['Horloge interne (C)', 'Le rythme d\'environ 24 h produit par ton cerveau, qui monte et descend ton éveil indépendamment du temps passé éveillé.'],
  ['Processus à deux composantes', 'L\'idée de Borbély (1982) : le sommeil et l\'éveil sont réglés par S et C, qui s\'additionnent.'],
  ['Trois processus', 'Le modèle d\'Åkerstedt & Folkard : S, C et l\'inertie du sommeil (W).'],
  ['Inertie du sommeil', 'La brume des 15 à 60 premières minutes après le réveil, plus forte après un sommeil profond ou au creux de l\'horloge.'],
  ['CBTmin', 'Le minimum de température centrale, vers 2 à 3 h avant le réveil habituel. C\'est le repère de phase de l\'horloge.'],
  ['DLMO', 'Le début de la montée de la mélatonine en lumière faible, vers 2 à 3 h avant le coucher habituel.'],
  ['Mélatonine', 'L\'hormone de la nuit biologique. Kairos n\'en recommande jamais : si tu t\'interroges, demande à un professionnel de santé.'],
  ['Demi-vie', 'Le temps pour éliminer la moitié d\'une substance. Celle de la caféine tourne autour de 5 h, mais varie beaucoup d\'une personne à l\'autre.'],
  ['Adénosine', 'Une molécule qui s\'accumule pendant l\'éveil. La caféine l\'empêche d\'agir, ce qui masque une partie de la pression de sommeil.'],
  ['Chronotype', 'Ta préférence naturelle : alouette (tôt), chouette (tard) ou intermédiaire. Estimé par le milieu de ton sommeil les jours libres (MSFsc).'],
  ['Jet lag social', 'Le décalage entre ton rythme de semaine et celui du week-end : quelques grasses matinées suffisent à décaler ton horloge.'],
  ['Dette de sommeil', 'Le manque de sommeil accumulé sur plusieurs jours par rapport à ton besoin. Les nuits récentes pèsent plus que les anciennes.'],
  ['Courbe de réponse de phase', 'Comment la lumière décale l\'horloge selon le moment où on la reçoit : avant le CBTmin elle retarde, après elle avance.'],
  ['Creux post-prandial', 'La baisse d\'alerte du début d\'après-midi, présente même sans repas.'],
  ['Prime time', 'Une fenêtre d\'au moins une heure où ton alerte prédite est dans le quart supérieur de ta journée.'],
];

// ---------------------------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------------------------
export default {
  id: 'science',
  title: 'La science',
  icon: 'brain',
  async mount(root, ctx) {
    await ensureCss('css/views-science.css');
    const reduced = prefersReducedMotion();
    const cleanups = [];
    const uid = uniqueId('sc');
    const profile = () => ctx.state.profile || {};

    // =======================================================================================
    // Héros
    // =======================================================================================
    const heroArt = h('div', { class: 'sc-hero__art', 'aria-hidden': 'true' });
    const hero = h('section', { class: 'card card--hero sc-hero', 'aria-labelledby': `${uid}-h` },
      heroArt,
      h('div', { class: 'sc-hero__copy' },
        h('span', { class: 'hero__eyebrow' }, 'Comment Kairos devine ton énergie'),
        h('h2', { class: 'hero__title', id: `${uid}-h` }, 'Deux horloges, ', h('em', null, 'une courbe'), '.'),
        h('p', { class: 'lead' }, 'Ton énergie vient d\'un duel entre une pression de sommeil qui monte et une horloge interne qui danse sur 24 h. Ici, tu peux les manipuler et voir ce que Kairos voit.'),
        h('div', { class: 'sc-hero__chips' },
          h('span', { class: 'chip chip--coral' }, h('i', { class: 'sc-dot sc-dot--s' }), 'S · pression de sommeil'),
          h('span', { class: 'chip chip--night' }, h('i', { class: 'sc-dot sc-dot--c' }), 'C · horloge interne'),
          h('span', { class: 'chip chip--sun' }, h('i', { class: 'sc-dot sc-dot--a' }), 'Alerte'))));

    const nav = [['deux', 'Les deux horloges'], ['cafe', 'La caféine'], ['trois', 'Trois processus'], ['savoir', 'Ce qu\'on sait'], ['refs', 'Références'], ['gloss', 'Glossaire']];
    const quick = h('nav', { class: 'sc-quick', 'aria-label': 'Aller à une section' }, ...nav.map(([id, label], i) => h('a', { class: 'chip', href: '#/science', onclick: (e) => { e.preventDefault(); const el = root.querySelector(`#${uid}-${id}`); if (el) el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' }); } }, h('span', { class: 'num sc-quick__n' }, pad(i + 1)), label)));

    const section = (id, n, eyebrow, title, intro, ...body) => h('section', { class: 'sc-section', id: `${uid}-${id}`, 'aria-labelledby': `${uid}-${id}-t` },
      h('header', { class: 'sc-section__head' }, h('span', { class: 'sc-section__n num', 'aria-hidden': 'true' }, n), h('div', null, h('span', { class: 'eyebrow eyebrow--sun' }, eyebrow), h('h2', { class: 'h1 sc-section__t', id: `${uid}-${id}-t` }, title), intro ? h('p', { class: 'lead sc-section__lead' }, intro) : null)),
      ...body);

    // =======================================================================================
    // § 01 — Deux horloges
    // =======================================================================================
    const T = { awakeH: 16, prevNightH: 8, shiftMin: 0, dip: false, cursor: 8 };
    const wakeH = 7;
    const toyHost = h('div', { class: 'sc-plot', tabindex: '0', role: 'group', 'aria-label': 'Courbes de S, C et de l\'alerte. Flèches gauche et droite pour déplacer le curseur.' });
    const readout = h('div', { class: 'sc-readout', 'aria-live': 'polite' });
    const story = h('p', { class: 'sc-story' });
    let toy = toySim({ wake: wakeH });
    let toyW = 0, curEl = null, tipEls = null;

    const sliderRow = ({ label, min, max, step, value, fmtv, note, onInput, color }) => {
      const out = h('output', { class: 'sc-slider__v num' });
      const noteEl = h('span', { class: 'sc-slider__n' });
      const input = h('input', { class: `range ${color === 'night' ? 'range--night' : ''}`, type: 'range', min, max, step, value, 'aria-label': label, oninput: (e) => { const v = +e.target.value; paint(v); onInput(v); } });
      const paint = (v) => { out.textContent = fmtv(v); noteEl.textContent = note ? note(v) : ''; input.setAttribute('aria-valuetext', fmtv(v)); };
      paint(value);
      return { el: h('div', { class: 'sc-slider' }, h('div', { class: 'row row--between row--baseline' }, h('span', { class: 'label' }, label), out), input, noteEl), input, paint };
    };

    const sAwake = sliderRow({ label: 'Heures de veille', min: 10, max: 40, step: 0.5, value: T.awakeH, fmtv: (v) => `${dur(v)}`, note: (v) => `Tu te couches à ${clock(wakeH + v)}${v > 24 ? ' (le lendemain)' : ''}`, onInput: (v) => { T.awakeH = v; recompute(); } });
    const sPrev = sliderRow({ label: 'Nuit précédente', min: 3, max: 10, step: 0.25, value: T.prevNightH, fmtv: (v) => dur(v), note: (v) => (v < 6 ? 'Nuit courte : S démarre haut' : v < 7.5 ? 'Un peu juste' : 'Récupération complète'), onInput: (v) => { T.prevNightH = v; recompute(); }, color: 'night' });
    const sShift = sliderRow({ label: 'Décalage de chronotype', min: -120, max: 180, step: 5, value: T.shiftMin, fmtv: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} min`, note: (v) => (v < -40 ? 'Alouette : ton horloge avance' : v > 40 ? 'Chouette : ton horloge retarde' : 'Dans la moyenne'), onInput: (v) => { T.shiftMin = v; recompute(); } });
    const dipSwitch = h('label', { class: 'switch sc-dipsw' }, h('input', { type: 'checkbox', onchange: (e) => { T.dip = e.target.checked; recompute(); } }), h('span', { class: 'switch__ui' }), h('span', null, 'Ajouter le creux d\'après-midi'));
    const presets = [['Journée type', { awakeH: 16, prevNightH: 8, shiftMin: 0 }], ['Nuit courte', { awakeH: 16, prevNightH: 4.5, shiftMin: 0 }], ['Nuit blanche', { awakeH: 40, prevNightH: 8, shiftMin: 0 }], ['Chouette', { awakeH: 17, prevNightH: 8, shiftMin: 90 }], ['Alouette', { awakeH: 15, prevNightH: 8, shiftMin: -60 }]];
    const presetBar = h('div', { class: 'sc-presets', role: 'group', 'aria-label': 'Scénarios' }, ...presets.map(([name, v]) => h('button', { class: 'chip', type: 'button', onclick: () => { Object.assign(T, v); sAwake.input.value = String(v.awakeH); sPrev.input.value = String(v.prevNightH); sShift.input.value = String(v.shiftMin); [sAwake, sPrev, sShift].forEach((s) => { s.paint(+s.input.value); s.input.dispatchEvent(new Event('input')); }); haptic(6); } }, name)));
    // les 'input' redéclenchés ci-dessus appellent déjà recompute() ; on évite un double travail en ne recalculant qu'une fois par frame
    let recRaf = 0;
    function recompute() { cancelAnimationFrame(recRaf); recRaf = requestAnimationFrame(() => { toy = toySim({ wake: wakeH, awakeH: T.awakeH, prevNightH: T.prevNightH, shiftMin: T.shiftMin, dip: T.dip }); drawToy(); }); }
    cleanups.push(() => cancelAnimationFrame(recRaf));

    function drawToy() {
      const w = toyW || Math.round(toyHost.clientWidth); if (w < 40) return;
      toyW = w;
      const small = w < 520, L = small ? 34 : 44, R = 12, rows = [{ id: 'C', h: 92, min: -1, max: 1 }, { id: 'S', h: 92, min: 0, max: 1 }, { id: 'A', h: 118, min: 0, max: 100 }];
      const gap = 26, top = 10, axisH = 28, H = top + rows.reduce((a, r) => a + r.h, 0) + gap * 2 + axisH;
      const x = (t) => L + ((t - toy.t0) / (toy.t1 - toy.t0)) * (w - L - R);
      let y0 = top; rows.forEach((r) => { r.y0 = y0; r.y1 = y0 + r.h; y0 += r.h + gap; });
      const yv = (r, v) => r.y1 - ((v - r.min) / (r.max - r.min)) * r.h;
      const ids = uniqueId('toy');
      const kids = [];
      kids.push(svg('defs', null,
        svg('linearGradient', { id: `${ids}-a`, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--sun)', 'stop-opacity': '.45' }), svg('stop', { offset: '1', 'stop-color': 'var(--sun)', 'stop-opacity': '0' })),
        svg('linearGradient', { id: `${ids}-al`, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--sun-hot)' }), svg('stop', { offset: '1', 'stop-color': 'var(--sun-deep)' })),
        svg('linearGradient', { id: `${ids}-s`, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--coral)', 'stop-opacity': '.38' }), svg('stop', { offset: '1', 'stop-color': 'var(--coral)', 'stop-opacity': '0' })),
        svg('linearGradient', { id: `${ids}-c`, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--night)', 'stop-opacity': '.34' }), svg('stop', { offset: '1', 'stop-color': 'var(--night)', 'stop-opacity': '0' })),
        svg('pattern', { id: `${ids}-h`, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, svg('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: 'var(--night)', 'stroke-width': 2, opacity: '.28' }))));
      // bandes de sommeil sur les trois rangées
      const sleepRuns = []; let a = null;
      toy.ts.forEach((t, i) => { if (toy.asleep[i] && a === null) a = t; if ((!toy.asleep[i] || i === toy.ts.length - 1) && a !== null) { sleepRuns.push([a, toy.asleep[i] ? t : toy.ts[i - 1] + 0.25]); a = null; } });
      for (const r of rows) {
        kids.push(svg('rect', { class: 'sc-plot__panel', x: L, y: r.y0, width: w - L - R, height: r.h, rx: 10 }));
        for (const [s0, s1] of sleepRuns) { const xa = clamp(x(s0), L, w - R), xb = clamp(x(s1), L, w - R); if (xb > xa) kids.push(svg('rect', { class: 'sc-plot__sleep', x: xa, y: r.y0, width: xb - xa, height: r.h, fill: `url(#${ids}-h)` })); }
      }
      // axes : ticks toutes les 6 h d'horloge
      const ticks = []; for (let t = Math.ceil((toy.t0 + wakeH) / 6) * 6 - wakeH; t <= toy.t1; t += 6) ticks.push(t);
      for (const t of ticks) { const hh = wrap24(wakeH + t); const major = hh === 0; kids.push(svg('line', { class: major ? 'sc-plot__grid sc-plot__grid--major' : 'sc-plot__grid', x1: x(t), x2: x(t), y1: top, y2: rows[2].y1 })); kids.push(svg('text', { class: 'sc-plot__tick', x: x(t), y: H - 8, 'text-anchor': 'middle' }, major ? 'minuit' : `${pad(hh)} h`)); }
      // C
      const rc = rows[0], rS = rows[1], rA = rows[2];
      const X = toy.ts.map(x);
      const CY = toy.C.map((v) => yv(rc, v)), SY = toy.S.map((v) => yv(rS, v));
      kids.push(svg('line', { class: 'sc-plot__zero', x1: L, x2: w - R, y1: yv(rc, 0), y2: yv(rc, 0) }));
      kids.push(svg('path', { class: 'sc-fill', d: `${path(X, CY)}L${X[X.length - 1]} ${yv(rc, 0)}L${X[0]} ${yv(rc, 0)}Z`, fill: `url(#${ids}-c)` }));
      kids.push(svg('path', { class: 'sc-line sc-line--c', d: path(X, CY) }));
      kids.push(svg('path', { class: 'sc-fill', d: `${path(X, SY)}L${X[X.length - 1]} ${rS.y1}L${X[0]} ${rS.y1}Z`, fill: `url(#${ids}-s)` }));
      kids.push(svg('path', { class: 'sc-line sc-line--s', d: path(X, SY) }));
      // CBTmin repères
      for (let t = Math.ceil(toy.t0 / 24 - 1) * 24 + (toy.cbt - wakeH); t <= toy.t1; t += 24) if (t >= toy.t0) { kids.push(svg('line', { class: 'sc-plot__cbt', x1: x(t), x2: x(t), y1: rc.y0, y2: rc.y1 })); kids.push(svg('text', { class: 'sc-plot__cbt-l', x: x(t) + 4, y: rc.y0 + 12 }, 'minimum de température')); }
      // Alerte : segments éveillés
      let seg = []; const segs = [];
      toy.A.forEach((v, i) => { if (v === null) { if (seg.length) segs.push(seg); seg = []; } else seg.push(i); }); if (seg.length) segs.push(seg);
      for (const sg of segs) {
        const xs = sg.map((i) => X[i]), ys = sg.map((i) => yv(rA, toy.A[i]));
        kids.push(svg('path', { class: 'sc-fill', d: `${path(xs, ys)}L${xs[xs.length - 1]} ${rA.y1}L${xs[0]} ${rA.y1}Z`, fill: `url(#${ids}-a)` }));
        kids.push(svg('path', { class: 'sc-line sc-line--glow', d: path(xs, ys) }));
        kids.push(svg('path', { class: 'sc-line sc-line--a', d: path(xs, ys), stroke: `url(#${ids}-al)` }));
      }
      // étiquettes de rangées
      const lab = (r, txt, cls, sub) => { kids.push(svg('text', { class: `sc-plot__row ${cls}`, x: L + 8, y: r.y0 + 17 }, txt)); if (sub) kids.push(svg('text', { class: 'sc-plot__sub', x: L + 8, y: r.y0 + 31 }, sub)); };
      lab(rc, 'C · horloge interne', 'sc-plot__row--c', w > 420 ? 'monte le jour, redescend la nuit' : '');
      lab(rS, 'S · pression de sommeil', 'sc-plot__row--s', w > 420 ? 'monte éveillé, retombe endormi' : '');
      lab(rA, 'Alerte', 'sc-plot__row--a', w > 420 ? 'base + 63 × C − 55 × S' : '');
      for (const [r, ticksY] of [[rc, [-1, 0, 1]], [rS, [0, 0.5, 1]], [rA, [0, 50, 100]]]) for (const v of ticksY) kids.push(svg('text', { class: 'sc-plot__ytick', x: L - 6, y: yv(r, v) + 3, 'text-anchor': 'end' }, r === rc ? (v === 0 ? '0' : v > 0 ? '+1' : '−1') : r === rS ? String(v).replace('.', ',') : String(v)));
      // curseur
      const cur = svg('g', { class: 'sc-cursor' }, svg('line', { x1: 0, x2: 0, y1: top, y2: rA.y1 }), svg('circle', { class: 'sc-cursor__c', r: 5 }), svg('circle', { class: 'sc-cursor__s', r: 5 }), svg('circle', { class: 'sc-cursor__a', r: 6 }));
      kids.push(cur);
      const hit = svg('rect', { class: 'sc-plot__hit', x: L, y: top, width: w - L - R, height: rA.y1 - top, fill: 'transparent' });
      kids.push(hit);
      const el = svg('svg', { class: 'sc-svg', viewBox: `0 0 ${w} ${H}`, width: w, height: H, 'aria-hidden': 'true' }, ...kids);
      replaceChildren(toyHost, el);
      curEl = { cur, x, yv, rows, L, R, w, hit };
      const move = (e) => { const r = el.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * w; T.cursor = clamp(toy.t0 + ((px - L) / (w - L - R)) * (toy.t1 - toy.t0), toy.t0, toy.t1); paintCursor(); };
      let down = false;
      hit.addEventListener('pointerdown', (e) => { down = true; hit.setPointerCapture(e.pointerId); move(e); });
      hit.addEventListener('pointermove', (e) => { if (down || e.pointerType === 'mouse') move(e); });
      hit.addEventListener('pointerup', () => { down = false; }); hit.addEventListener('pointercancel', () => { down = false; });
      paintCursor();
    }

    function toyAt(t) {
      const i = clamp(Math.round((t - toy.t0) / 0.25), 0, toy.ts.length - 1);
      return { i, t: toy.ts[i], S: toy.S[i], C: toy.C[i], A: toy.A[i], asleep: toy.asleep[i], dip: toy.parts[i].dip };
    }
    function paintCursor() {
      if (!curEl) return;
      T.cursor = clamp(T.cursor, toy.t0, toy.t1);
      const q = toyAt(T.cursor), cx = curEl.x(q.t), [rc, rS, rA] = curEl.rows;
      curEl.cur.querySelector('line').setAttribute('x1', cx); curEl.cur.querySelector('line').setAttribute('x2', cx);
      const set = (cls, y) => { const c = curEl.cur.querySelector(cls); c.setAttribute('cx', cx); c.setAttribute('cy', y); };
      set('.sc-cursor__c', curEl.yv(rc, q.C)); set('.sc-cursor__s', curEl.yv(rS, q.S));
      const ca = curEl.cur.querySelector('.sc-cursor__a'); if (q.A === null) ca.setAttribute('display', 'none'); else { ca.removeAttribute('display'); ca.setAttribute('cx', cx); ca.setAttribute('cy', curEl.yv(rA, q.A)); }
      // lecture chiffrée
      const since = (() => { let lastWake = 0; for (const [a, b] of toy.eps) if (b <= q.t && b > lastWake - 1e-9) lastWake = b; return q.t - lastWake; })();
      const hh = wakeH + q.t;
      const num = (v, cls) => h('b', { class: `sc-num ${cls}` }, v);
      if (q.asleep) {
        replaceChildren(readout, h('div', { class: 'sc-readout__time' }, h('span', { class: 'num' }, clock(hh)), h('small', null, 'Tu dors')), h('p', { class: 'sc-readout__eq' }, 'Pendant le sommeil, ', num(`S = ${f2(q.S)}`, 'sc-num--s'), ' se dissipe : plus tu dors, plus la pression retombe. C\'est ce qui rend l\'éveil possible.'));
        story.textContent = 'Le sommeil vide le réservoir de pression : la courbe rouge descend vite au début, puis ralentit.';
      } else {
        const aC = P.wC * q.C, aS = -P.wS * q.S;
        replaceChildren(readout,
          h('div', { class: 'sc-readout__time' }, h('span', { class: 'num' }, clock(hh)), h('small', null, `éveillé depuis ${dur(Math.max(0, since))}`)),
          h('div', { class: 'sc-eq', role: 'math', 'aria-label': `Alerte égale ${f1(P.base)} plus ${P.wC} fois ${f2(q.C)} moins ${P.wS} fois ${f2(q.S)}${T.dip ? ` moins creux ${f1(q.dip)}` : ''}, soit ${Math.round(q.A)}` },
            h('span', { class: 'sc-eq__t' }, f1(P.base)), h('span', { class: 'sc-eq__op' }, '+'),
            h('span', { class: 'sc-eq__t sc-eq__t--c' }, P.wC, ' × ', h('b', null, f2(q.C))), h('span', { class: 'sc-eq__op' }, '−'),
            h('span', { class: 'sc-eq__t sc-eq__t--s' }, P.wS, ' × ', h('b', null, f2(q.S))),
            T.dip ? [h('span', { class: 'sc-eq__op' }, '−'), h('span', { class: 'sc-eq__t' }, f1(q.dip))] : null,
            h('span', { class: 'sc-eq__op' }, '='), h('span', { class: 'sc-eq__res' }, String(Math.round(q.A)))),
          h('p', { class: 'sc-readout__eq small muted' }, h('span', { class: 'sc-key sc-key--c' }), ` L'horloge ${aC >= 0 ? 'ajoute' : 'retire'} ${f1(Math.abs(aC))} points, `, h('span', { class: 'sc-key sc-key--s' }), ` la pression en retire ${f1(Math.abs(aS))}.`));
        story.textContent = storyFor(q, since);
      }
      toyHost.setAttribute('aria-label', q.asleep ? `Il est ${clock(hh)}, tu dors. S vaut ${f2(q.S)}.` : `Il est ${clock(hh)}. S vaut ${f2(q.S)}, C vaut ${f2(q.C)}, alerte ${Math.round(q.A)} sur 100. Flèches gauche et droite pour déplacer le curseur.`);
    }
    function storyFor(q, since) {
      if (since > 24) return `Après ${dur(since)} d'éveil, la pression de sommeil est écrasante : même quand l'horloge te pousse vers le haut, l'alerte reste basse. C'est la nuit blanche.`;
      if (q.C < -0.6 && since > 12) return 'Tu cumules les deux : l\'horloge est au plus bas et la pression au plus haut. C\'est le pire moment pour la concentration.';
      if (q.C < -0.5) return 'L\'horloge interne est au creux : l\'alerte est basse même si la pression de sommeil est faible.';
      if (q.S > 0.7) return 'La pression de sommeil est forte. Elle tire l\'alerte vers le bas, même si l\'horloge soutient encore.';
      if (q.A > 80) return 'Les deux se coordonnent : horloge haute, pression encore modérée. C\'est une fenêtre idéale pour les tâches exigeantes.';
      return 'Plus tu restes éveillé, plus la courbe rouge monte ; pendant ce temps, l\'horloge fait varier la courbe turquoise. L\'alerte est leur différence.';
    }
    toyHost.addEventListener('keydown', (e) => { const d = e.key === 'ArrowRight' ? 0.25 : e.key === 'ArrowLeft' ? -0.25 : 0; if (!d) return; e.preventDefault(); T.cursor += d * (e.shiftKey ? 8 : 1); paintCursor(); });

    const toyCard = h('div', { class: 'card sc-lab' },
      h('div', { class: 'sc-lab__plot' }, toyHost, h('div', { class: 'sc-plot__legend small' }, h('span', null, h('i', { class: 'sc-key sc-key--c' }), 'horloge C'), h('span', null, h('i', { class: 'sc-key sc-key--s' }), 'pression S'), h('span', null, h('i', { class: 'sc-key sc-key--a' }), 'alerte'), h('span', null, h('i', { class: 'sc-key sc-key--z' }), 'sommeil'))),
      h('div', { class: 'sc-lab__side' }, readout, story),
      h('div', { class: 'sc-lab__ctrl' }, presetBar, sAwake.el, sPrev.el, sShift.el, dipSwitch),
      h('p', { class: 'tiny faint sc-lab__foot' }, 'Version simplifiée du moteur : mêmes équations et constantes que chrono.js (S de Borbély, C à deux harmoniques), sans inertie, dette ni caféine. Les poids 69,5 · 63 · 55 sont des choix de modélisation, pas des mesures.'));

    const twoCards = h('div', { class: 'sc-explain' },
      h('article', { class: 'card sc-ex sc-ex--s' }, h('span', { class: 'sc-ex__ic' }, icon('battery', { size: 20 })), h('h3', null, 'S : un réservoir qui se remplit'), h('p', { class: 'small muted' }, 'Éveillé, la pression monte de plus en plus lentement vers un plafond (constante de temps ≈ 18 h). Endormi, elle se vide vite (≈ 4 h). C\'est le processus homéostatique de Borbély (1982).')),
      h('article', { class: 'card sc-ex sc-ex--c' }, h('span', { class: 'sc-ex__ic' }, icon('clock', { size: 20 })), h('h3', null, 'C : une horloge qui ne s\'arrête pas'), h('p', { class: 'small muted' }, 'Elle ne dépend pas du temps passé éveillé. Elle suit un cycle de 24 h avec un creux vers 2 à 3 h avant ton réveil habituel et un « second souffle » en début de soirée.')),
      h('article', { class: 'card sc-ex sc-ex--a' }, h('span', { class: 'sc-ex__ic' }, icon('bolt', { size: 20 })), h('h3', null, 'Alerte : leur différence'), h('p', { class: 'small muted' }, 'On additionne l\'horloge et on retranche la pression. D\'où la nuit blanche : à 5 h du matin, les deux jouent contre toi. Daan, Beersma & Borbély (1984) montrent comment elles se combinent.')));

    // =======================================================================================
    // § 02 — Caféine
    // =======================================================================================
    const Cf = { doseMg: 120, drinkH: 9, halfLifeH: Number(profile().caffeineHalfLifeH) || 5, sensitivity: Number(profile().caffeineSensitivity) || 1, cursor: 9 };
    const bedH = hhmmToH(profile().usualBed, 23);
    const cafPlot = h('div', { class: 'sc-plot sc-plot--caf', tabindex: '0', role: 'group', 'aria-label': 'Courbe de la caféine dans le sang' });
    const cup = buildCup();
    const cafRead = h('div', { class: 'sc-cafread', 'aria-live': 'polite' });
    let cs = caffeineSim({ ...Cf, bedH }), cafW = 0, cafCur = null, playing = false, playRaf = 0;
    const playBtn = h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => togglePlay() }, icon('play', { size: 18 }), 'Voir la décroissance');
    const cafSliders = [
      sliderRow({ label: 'Dose', min: 20, max: 300, step: 10, value: Cf.doseMg, fmtv: (v) => `${v} mg`, note: (v) => (v <= 50 ? 'Un thé' : v <= 100 ? 'Un café filtre (≈ 80–100 mg)' : v <= 160 ? 'Un grand café' : 'Beaucoup : le repère officiel est 400 mg par jour'), onInput: (v) => { Cf.doseMg = v; recomputeCaf(); } }),
      sliderRow({ label: 'Heure de la prise', min: 6, max: 20, step: 0.25, value: Cf.drinkH, fmtv: (v) => clock(v), note: (v) => (v < 9 ? 'Au réveil' : v < 13 ? 'En matinée' : v < 16 ? 'L\'après-midi' : 'Tard : attention au coucher'), onInput: (v) => { Cf.drinkH = v; Cf.cursor = Math.max(Cf.cursor, v); recomputeCaf(); }, color: 'night' }),
      sliderRow({ label: 'Demi-vie', min: 3, max: 9, step: 0.25, value: Cf.halfLifeH, fmtv: (v) => `${f2(v)} h`, note: (v) => (v < 4 ? 'Élimination rapide' : v < 6 ? 'Valeur courante' : 'Élimination lente'), onInput: (v) => { Cf.halfLifeH = v; recomputeCaf(); } }),
    ];
    function recomputeCaf() { cs = caffeineSim({ ...Cf, bedH }); drawCaf(); }

    function drawCaf() {
      const w = cafW || Math.round(cafPlot.clientWidth); if (w < 40) return; cafW = w;
      const small = w < 520, L = small ? 34 : 44, R = 12, top = 16, bot = 30, H = small ? 250 : 290;
      const x = (hh) => L + ((hh - cs.startH) / cs.hours) * (w - L - R);
      const ymax = Math.max(60, Math.ceil(cs.peak / 40) * 40 + 20), y = (v) => H - bot - (v / ymax) * (H - bot - top);
      const ids = uniqueId('caf'), kids = [];
      kids.push(svg('defs', null, svg('linearGradient', { id: `${ids}-g`, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--caffeine)', 'stop-opacity': '.55' }), svg('stop', { offset: '1', 'stop-color': 'var(--caffeine)', 'stop-opacity': '0' }))));
      for (let v = 0; v <= ymax; v += ymax <= 120 ? 20 : 40) { kids.push(svg('line', { class: 'sc-plot__grid', x1: L, x2: w - R, y1: y(v), y2: y(v) })); kids.push(svg('text', { class: 'sc-plot__ytick', x: L - 6, y: y(v) + 3, 'text-anchor': 'end' }, String(v))); }
      for (let hh = 6; hh <= 29; hh += 3) { const lab = wrap24(hh); kids.push(svg('text', { class: 'sc-plot__tick', x: x(hh), y: H - 10, 'text-anchor': 'middle' }, `${pad(lab)} h`)); }
      // nuit : après l'heure de coucher
      kids.push(svg('rect', { class: 'sc-caf__night', x: x(cs.bedH), y: top, width: Math.max(0, w - R - x(cs.bedH)), height: H - bot - top }));
      // seuil de 25 mg
      const thr = CAFFEINE.bedThresholdMg; kids.push(svg('line', { class: 'sc-caf__thr', x1: L, x2: w - R, y1: y(thr), y2: y(thr) })); kids.push(svg('text', { class: 'sc-caf__thr-l', x: w - R - 4, y: y(thr) - 5, 'text-anchor': 'end' }, `seuil au coucher · ${thr} mg`));
      const X = cs.ts.map(x), Y = cs.mg.map(y);
      kids.push(svg('path', { class: 'sc-fill', d: `${path(X, Y)}L${X[X.length - 1]} ${y(0)}L${X[0]} ${y(0)}Z`, fill: `url(#${ids}-g)` }));
      kids.push(svg('path', { class: 'sc-line sc-line--glow sc-line--caf-glow', d: path(X, Y) }));
      kids.push(svg('path', { class: 'sc-line sc-line--caf', d: path(X, Y) }));
      // effet sur l'alerte (pointillés, échelle propre)
      const bmax = Math.max(1, cs.peakBoost), BY = cs.boosts.map((b) => y((b / bmax) * ymax * 0.55));
      kids.push(svg('path', { class: 'sc-line sc-line--boost', d: path(X, BY) }));
      // repères : pic, demi-vie, heure de la prise, coucher, dernière heure
      const mark = (hh, cls, txt, yy, anchor = 'middle') => { kids.push(svg('line', { class: `sc-caf__m ${cls}`, x1: x(hh), x2: x(hh), y1: top, y2: H - bot })); if (txt) kids.push(svg('text', { class: `sc-caf__ml ${cls}`, x: x(hh) + (anchor === 'start' ? 4 : anchor === 'end' ? -4 : 0), y: yy, 'text-anchor': anchor }, txt)); };
      mark(cs.drinkH, 'sc-caf__m--drink', 'prise', top + 10, small ? 'end' : 'end');
      if (cs.peak > 0) { kids.push(svg('circle', { class: 'sc-caf__pk', cx: x(cs.peakH), cy: y(cs.peak), r: 5 })); kids.push(svg('text', { class: 'sc-caf__ml sc-caf__ml--pk', x: x(cs.peakH) + 9, y: y(cs.peak) - 6 }, `pic ≈ ${Math.round(cs.peak)} mg`)); }
      if (cs.halfH) { kids.push(svg('line', { class: 'sc-caf__half', x1: x(cs.peakH), x2: x(cs.halfH), y1: y(cs.peak / 2), y2: y(cs.peak / 2) })); kids.push(svg('circle', { class: 'sc-caf__pk sc-caf__pk--half', cx: x(cs.halfH), cy: y(cs.peak / 2), r: 4.5 })); kids.push(svg('text', { class: 'sc-caf__ml', x: x(cs.halfH) + 8, y: y(cs.peak / 2) - 8 }, `÷ 2 en ${dur(cs.halfH - cs.peakH)}`)); }
      mark(cs.bedH, 'sc-caf__m--bed', `coucher · ${Math.round(cs.atBed)} mg`, H - bot - 8, 'end');
      const cur = svg('g', { class: 'sc-cursor sc-cursor--caf' }, svg('line', { x1: 0, x2: 0, y1: top, y2: H - bot }), svg('circle', { class: 'sc-cursor__a', r: 6 }));
      kids.push(cur);
      const hit = svg('rect', { class: 'sc-plot__hit', x: L, y: top, width: w - L - R, height: H - bot - top, fill: 'transparent' });
      kids.push(hit);
      const el = svg('svg', { class: 'sc-svg', viewBox: `0 0 ${w} ${H}`, width: w, height: H, 'aria-hidden': 'true' }, ...kids);
      replaceChildren(cafPlot, el);
      cafCur = { x, y, cur };
      const move = (e) => { const r = el.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * w; Cf.cursor = clamp(cs.startH + ((px - L) / (w - L - R)) * cs.hours, cs.startH, cs.startH + cs.hours); if (playing) stopPlay(); paintCaf(); };
      let down = false; hit.addEventListener('pointerdown', (e) => { down = true; hit.setPointerCapture(e.pointerId); move(e); }); hit.addEventListener('pointermove', (e) => { if (down || e.pointerType === 'mouse') move(e); }); hit.addEventListener('pointerup', () => { down = false; }); hit.addEventListener('pointercancel', () => { down = false; });
      paintCaf();
    }
    function mgAt(hh) { const i = clamp(Math.round((hh - cs.startH) * 6), 0, cs.mg.length - 1); return cs.mg[i]; }
    function paintCaf() {
      if (!cafCur) return;
      Cf.cursor = clamp(Cf.cursor, cs.startH, cs.startH + cs.hours);
      const m = mgAt(Cf.cursor), cx = cafCur.x(Cf.cursor);
      const ln = cafCur.cur.querySelector('line'); ln.setAttribute('x1', cx); ln.setAttribute('x2', cx);
      const c = cafCur.cur.querySelector('circle'); c.setAttribute('cx', cx); c.setAttribute('cy', cafCur.y(m));
      cup.set(cs.peak > 0 ? m / Math.max(cs.peak, Cf.doseMg * 0.6) : 0, m);
      const pct = cs.peak > 0 ? Math.round((m / cs.peak) * 100) : 0, late = cs.atBed > CAFFEINE.bedThresholdMg;
      replaceChildren(cafRead,
        h('div', { class: 'sc-cafread__t' }, h('span', { class: 'num' }, clock(Cf.cursor)), h('small', null, Cf.cursor < Cf.drinkH ? 'avant la prise' : `${dur(Cf.cursor - Cf.drinkH)} après la prise`)),
        h('div', { class: 'sc-cafread__v' }, h('b', { class: 'num' }, String(Math.round(m))), h('small', null, ' mg dans ton sang')),
        h('p', { class: 'small muted' }, Cf.cursor < Cf.drinkH ? 'Rien encore.' : `${pct} % du pic : l'organisme élimine la caféine en continu (ordre 1), la moitié toutes les ${f1(Cf.halfLifeH)} h.`));
      cafSummary.replaceChildren(
        h('div', { class: `sc-chip-big ${late ? 'sc-chip-big--warn' : 'sc-chip-big--ok'}` }, icon(late ? 'alert' : 'check-circle', { size: 20 }), h('div', null, h('b', null, `${Math.round(cs.atBed)} mg au coucher (${clock(cs.bedH)})`), h('small', null, late ? `Au-dessus du seuil de ${CAFFEINE.bedThresholdMg} mg : ça peut raccourcir ou fragmenter ton sommeil.` : `Sous le seuil de ${CAFFEINE.bedThresholdMg} mg : tu devrais pouvoir t'endormir sans gêne.`))),
        h('div', { class: 'sc-chip-big' }, icon('clock', { size: 20 }), h('div', null, h('b', null, `Dernière prise de ${Cf.doseMg} mg avant ${clock(cs.cutoffH)}`), h('small', null, 'Pour rester sous le seuil au coucher (choix prudent de Kairos).'))),
        h('div', { class: 'sc-chip-big' }, icon('bolt', { size: 20 }), h('div', null, h('b', null, `Jusqu'à +${Math.round(cs.peakBoost)} points d'alerte`), h('small', null, 'Si tu es déjà un peu fatigué·e ; l\'effet est plus net quand la pression de sommeil est haute.'))));
      cafPlot.setAttribute('aria-label', `À ${clock(Cf.cursor)}, ${Math.round(m)} mg de caféine dans le sang. Pic ${Math.round(cs.peak)} mg vers ${clock(cs.peakH)}. ${Math.round(cs.atBed)} mg au coucher.`);
    }
    const cafSummary = h('div', { class: 'sc-chips-big' });
    cafPlot.addEventListener('keydown', (e) => { const d = e.key === 'ArrowRight' ? 1 / 6 : e.key === 'ArrowLeft' ? -1 / 6 : 0; if (!d) return; e.preventDefault(); if (playing) stopPlay(); Cf.cursor += d * (e.shiftKey ? 6 : 1); paintCaf(); });
    function togglePlay() { playing ? stopPlay() : startPlay(); }
    function startPlay() {
      playing = true; Cf.cursor = Cf.drinkH - 0.1; syncPlayBtn();
      let last = 0;
      const step = (ts) => { if (!playing) return; const dt = last ? ts - last : 16; last = ts; Cf.cursor += (dt / 1000) * 1.8; if (Cf.cursor >= Math.min(cs.startH + cs.hours, cs.bedH + 3)) { stopPlay(); return; } paintCaf(); playRaf = requestAnimationFrame(step); };
      playRaf = requestAnimationFrame(step);
    }
    function stopPlay() { playing = false; cancelAnimationFrame(playRaf); syncPlayBtn(); }
    function syncPlayBtn() { replaceChildren(playBtn, icon(playing ? 'pause' : 'play', { size: 18 }), playing ? 'Pause' : 'Voir la décroissance'); }
    cleanups.push(() => { playing = false; cancelAnimationFrame(playRaf); });

    const cafCard = h('div', { class: 'card sc-lab sc-lab--caf' },
      h('div', { class: 'sc-lab__plot' }, cafPlot, h('div', { class: 'sc-plot__legend small' }, h('span', null, h('i', { class: 'sc-key sc-key--caf' }), 'caféine dans le sang'), h('span', null, h('i', { class: 'sc-key sc-key--boost' }), 'effet sur l\'alerte'), h('span', null, h('i', { class: 'sc-key sc-key--z' }), 'nuit'))),
      h('div', { class: 'sc-lab__side sc-lab__side--caf' }, cup.el, cafRead, playBtn),
      h('div', { class: 'sc-lab__ctrl' }, ...cafSliders.map((s) => s.el)),
      cafSummary,
      h('p', { class: 'tiny faint sc-lab__foot' }, 'Modèle d\'ordre 1 : absorption puis élimination exponentielle, pic ≈ 40 min (30 à 60 selon Blanchard & Sawers 1983), demi-vie très variable (Nehlig 2018). Le seuil de 25 mg et l\'effet maximal de 16 points sont des choix de Kairos. Drake et al. (2013) : 400 mg encore pris 6 h avant le coucher réduisent le sommeil de plus d\'une heure.'));

    // =======================================================================================
    // § 03 — Trois processus, sur TA journée
    // =======================================================================================
    const triHost = h('div', { class: 'sc-tri' });
    const sumHost = h('div', { class: 'sc-sum' });
    function drawTri() {
      let m = null, sim = null;
      try { m = ctx.model(); sim = simulateProcessesRaw({ sleeps: ctx.state.sleeps, profile: profile(), fromMs: m.t0, toMs: m.t0 + (m.n - 1) * m.stepMin * MIN, stepMin: m.stepMin }); } catch { m = null; }
      if (!m) { replaceChildren(triHost, h('p', { class: 'muted' }, 'Le modèle n\'est pas disponible pour le moment.')); return; }
      const nowMs = ctx.nowMs();
      const mini = (title, sub, color, values, { min, max, fill = true, tag }) => {
        const host = h('div', { class: 'sc-mini__plot' });
        const card = h('article', { class: `sc-mini sc-mini--${color}` }, h('header', null, h('span', { class: 'sc-mini__tag num' }, tag), h('div', null, h('h3', null, title), h('p', { class: 'tiny muted' }, sub))), host);
        const rs = responsive(host, (w) => miniPlot(host, w, m, values, { min, max, fill, color, asleep: m.asleep, nowMs }));
        cleanupsLive.push(rs.stop);
        return card;
      };
      const W = Array.from(sim.W);
      const minis = [
        mini('Pression de sommeil', 'monte éveillé, retombe endormi', 's', m.S, { min: 0, max: 1, tag: 'S' }),
        mini('Horloge interne', 'cycle de 24 h, indépendant', 'c', m.C, { min: -1, max: 1, tag: 'C' }),
        mini('Inertie du sommeil', 'la brume des premières minutes', 'w', W, { min: 0, max: Math.max(5, Math.max(...W) * 1.15), tag: 'W' }),
      ];
      replaceChildren(triHost, h('div', { class: 'sc-tri__row' }, minis[0], h('span', { class: 'sc-op', 'aria-hidden': 'true' }, '−'), minis[1], h('span', { class: 'sc-op', 'aria-hidden': 'true' }, '+'), minis[2]));
      const host = h('div', { class: 'sc-sum__plot' });
      const pk = m.stats.peak, tr = m.stats.trough;
      replaceChildren(sumHost,
        h('div', { class: 'sc-sum__eq', 'aria-hidden': 'true' }, h('span', { class: 'sc-op sc-op--big' }, '='), h('span', { class: 'sc-sum__eqt' }, 'Ton alerte prédite'), h('span', { class: 'sc-sum__plus' }, '+ caféine')),
        host,
        h('div', { class: 'sc-sum__facts' },
          h('span', { class: 'chip chip--sun' }, icon('bolt', { size: 15 }), `Pic ≈ ${Math.round(pk.value)}/100 vers ${new Date(pk.ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`),
          h('span', { class: 'chip chip--night' }, icon('battery', { size: 15 }), `Creux ≈ ${Math.round(tr.value)}/100 vers ${new Date(tr.ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`),
          m.stats.goldenWindows.length ? h('span', { class: 'chip' }, icon('star', { size: 15 }), `${m.stats.goldenWindows.length} fenêtre${m.stats.goldenWindows.length > 1 ? 's' : ''} prime time`) : null));
      const rs2 = responsive(host, (w) => sumPlot(host, w, m, nowMs));
      cleanupsLive.push(rs2.stop);
    }
    let cleanupsLive = [];
    function redrawLive() { for (const c of cleanupsLive.splice(0)) c(); drawTri(); drawHeroArt(); }

    function drawHeroArt() {
      let m = null; try { m = ctx.model(); } catch { m = null; }
      if (!m) { replaceChildren(heroArt); return; }
      const w = 720, H = 220, x = (i) => (i / (m.n - 1)) * w;
      const vals = m.alert, ys = vals.map((v) => H - 30 - (v / 100) * (H - 70)), xs = vals.map((_, i) => x(i));
      const sy = m.S.map((v) => H - 30 - v * (H - 70) * 0.9), cy = m.C.map((v) => H - 30 - ((v + 1) / 2) * (H - 70) * 0.9);
      const gid = uniqueId('ha');
      replaceChildren(heroArt, svg('svg', { viewBox: `0 0 ${w} ${H}`, preserveAspectRatio: 'none', class: 'sc-heroart' },
        svg('defs', null,
          svg('linearGradient', { id: `${gid}-f`, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--sun)', 'stop-opacity': '.38' }), svg('stop', { offset: '1', 'stop-color': 'var(--sun)', 'stop-opacity': '0' })),
          svg('linearGradient', { id: `${gid}-l`, x1: '0', y1: '0', x2: '1', y2: '0' }, svg('stop', { offset: '0', 'stop-color': 'var(--night)' }), svg('stop', { offset: '.5', 'stop-color': 'var(--sun-hot)' }), svg('stop', { offset: '1', 'stop-color': 'var(--sun-deep)' }))),
        svg('path', { class: 'sc-ha__s', d: path(xs, sy) }), svg('path', { class: 'sc-ha__c', d: path(xs, cy) }),
        svg('path', { class: 'sc-ha__fill', d: `${path(xs, ys)}L${w} ${H}L0 ${H}Z`, fill: `url(#${gid}-f)` }),
        svg('path', { class: 'sc-ha__glow', d: path(xs, ys), stroke: `url(#${gid}-l)` }), svg('path', { class: 'sc-ha__line', d: path(xs, ys), stroke: `url(#${gid}-l)`, pathLength: '1' })));
    }

    // =======================================================================================
    // § 04 — Ce qu'on sait
    // =======================================================================================
    const legend = h('div', { class: 'sc-legend' }, ...Object.entries(STATUS).map(([k, [name, cls]]) => h('span', { class: `chip ${cls}` }, name)));
    const paramTable = h('div', { class: 'card sc-params' },
      h('div', { class: 'card__head' }, h('div', null, h('h3', { class: 'card__title' }, 'Les paramètres, un par un'), h('p', { class: 'card__sub' }, 'Chaque valeur est classée : mesurée, ordre de grandeur de la littérature, ou choix de modélisation (le plus honnête quand on n\'a pas de mesure).'))),
      legend,
      h('ul', { class: 'sc-params__list' }, ...PARAMS.map(([name, val, st, src]) => h('li', null, h('div', { class: 'sc-params__n' }, h('strong', null, name), h('small', null, src)), h('span', { class: 'sc-params__v num' }, val), h('span', { class: `chip ${STATUS[st][1]} sc-params__s` }, STATUS[st][0])))));
    const limits = h('div', { class: 'sc-limits' }, ...LIMITS.map(([ic, title, text], i) => h('details', { class: `card sc-limit${i === 0 ? ' sc-limit--key' : ''}`, open: i === 0 }, h('summary', null, h('span', { class: 'sc-limit__ic' }, icon(ic, { size: 20 })), h('span', { class: 'sc-limit__t' }, title), h('span', { class: 'sc-limit__chev', 'aria-hidden': 'true' }, icon('chevron-down', { size: 18 }))), h('p', { class: 'sc-limit__p' }, text))));
    const verdict = h('aside', { class: 'banner banner--warn sc-verdict', role: 'note' }, icon('shield', { size: 22 }), h('div', null, h('strong', null, 'Notre engagement : '), 'Kairos affiche des fenêtres et des tendances, jamais de certitudes. Quand une valeur est un choix de modélisation, on le dit ; quand une source est incertaine, on n\'en tire pas de chiffre. Le détail complet, avec le statut de vérification de chaque valeur, est dans le document ', h('code', null, 'docs/science.md'), '.'));

    // =======================================================================================
    // § 05 — Références et glossaire
    // =======================================================================================
    let theme = 'all', query = '';
    const refList = h('ol', { class: 'sc-refs__list' });
    const refCount = h('span', { class: 'tiny faint', 'aria-live': 'polite' });
    const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    function paintRefs() {
      const q = fold(query.trim());
      const rows = REFS.filter((r) => (theme === 'all' || r[4].includes(theme)) && (!q || fold(`${r[0]} ${r[1]} ${r[2]} ${r[3]}`).includes(q)));
      refCount.textContent = `${rows.length} référence${rows.length > 1 ? 's' : ''}`;
      replaceChildren(refList, rows.length ? rows.map((r, i) => h('li', { class: 'sc-ref', style: { '--i': Math.min(i, 12) } }, h('span', { class: 'sc-ref__y num' }, String(r[1])), h('div', null, h('p', { class: 'sc-ref__a' }, r[0]), h('p', { class: 'sc-ref__t' }, r[2]), h('p', { class: 'sc-ref__j' }, r[3])))) : [h('li', { class: 'sc-ref sc-ref--none' }, 'Aucune référence ne correspond.')]);
    }
    const themeBar = h('div', { class: 'sc-themes', role: 'group', 'aria-label': 'Filtrer par thème' }, ...THEMES.map(([id, name]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': id === 'all' ? 'true' : 'false', 'data-id': id, onclick: () => { theme = id; themeBar.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', b.dataset.id === id ? 'true' : 'false')); paintRefs(); } }, name)));
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Chercher un auteur, un sujet, une année…', 'aria-label': 'Chercher dans les références', oninput: (e) => { query = e.target.value; paintRefs(); } });
    paintRefs();
    const refsCard = h('div', { class: 'card sc-refs' }, h('div', { class: 'sc-refs__bar' }, search, refCount), themeBar, refList,
      h('p', { class: 'tiny faint' }, 'Les références sont réelles ; les valeurs numériques citées de mémoire sont à revérifier avant toute publication scientifique (voir le statut de vérification dans docs/science.md). Aucun lien n\'est fourni : cherche le titre et la revue.'));

    const glossHost = h('dl', { class: 'sc-gloss' }, ...GLOSSARY.map(([term, def], i) => h('div', { class: 'sc-term', style: { '--i': i % 6 } }, h('dt', null, term), h('dd', null, def))));

    // =======================================================================================
    // Assemblage
    // =======================================================================================
    root.append(hero, quick,
      section('deux', '01', 'Le cœur du modèle', 'Deux horloges qui se disputent ton énergie', 'Fais glisser les curseurs : tu verras exactement pourquoi une nuit courte, un coucher tardif ou un chronotype de chouette changent ta journée.', toyCard, twoCards),
      section('cafe', '02', 'Un coup de pouce temporaire', 'La caféine : un décompte qui ne s\'arrête jamais', 'Elle masque une partie de la pression de sommeil sans la supprimer. Et elle met des heures à partir.', cafCard),
      section('trois', '03', 'Le modèle à trois processus', 'Ta journée, décomposée', 'Voici les ingrédients de TA courbe d\'aujourd\'hui, calculés par le vrai moteur de Kairos avec ton profil et tes nuits enregistrées.', triHost, sumHost,
        h('div', { class: 'sc-also' }, h('span', { class: 'eyebrow' }, 'Et aussi dans le moteur'), h('div', { class: 'sc-also__chips' }, ...['Creux d\'après-midi (Monk 2005)', 'Dette de sommeil (Van Dongen 2003)', 'Caféine (Fredholm 1999)', 'Mélatonine et DLMO', 'Phase qui suit tes réveils (Roenneberg 2003)'].map((t) => h('span', { class: 'chip' }, t))))),
      section('savoir', '04', 'Honnêteté', 'Ce qu\'on sait, ce qu\'on suppose, ce qu\'on ignore', 'Un modèle est une carte, pas le territoire. Voici où elle est fiable, où elle est approximative, et où elle s\'arrête.', paramTable, limits, verdict),
      section('refs', '05', 'Sources', 'Références', 'Celles de docs/science.md, classées par thème.', refsCard),
      section('gloss', '06', 'Vocabulaire', 'Glossaire', null, glossHost),
      h('div', { class: 'sc-end card card--glow' }, icon('sparkle', { size: 22 }), h('p', null, 'Prêt à voir tout ça sur ta propre journée ?'), h('a', { class: 'btn btn--primary', href: '#/today' }, icon('sun', { size: 18 }), 'Retour à Aujourd\'hui')));

    // premier rendu
    const rsToy = responsive(toyHost, () => { toyW = 0; drawToy(); });
    const rsCaf = responsive(cafPlot, () => { cafW = 0; drawCaf(); });
    cleanups.push(rsToy.stop, rsCaf.stop);
    drawTri(); drawHeroArt();
    // les données « live » se rafraîchissent quand le profil ou les nuits changent (pas à chaque tic d'horloge)
    let key = '';
    const keyOf = () => JSON.stringify([profile(), ctx.state.sleeps.length, ctx.state.sleeps[ctx.state.sleeps.length - 1], Math.floor(ctx.nowMs() / 3_600_000)]);
    key = keyOf();
    const off = ctx.subscribe(() => { const k = keyOf(); if (k !== key) { key = k; redrawLive(); } });
    cleanups.push(off, () => { for (const c of cleanupsLive.splice(0)) c(); });

    return () => { for (const c of cleanups.splice(0)) { try { c(); } catch { /* nettoyage best effort */ } } };
  },
};

// ---------------------------------------------------------------------------------------------
// Petits graphiques (SVG) de la section « trois processus »
// ---------------------------------------------------------------------------------------------
function bandsOf(asleep) { const runs = []; let a = null; asleep.forEach((s, i) => { if (s && a === null) a = i; if ((!s || i === asleep.length - 1) && a !== null) { runs.push([a, s ? i : i - 1]); a = null; } }); return runs; }

function miniPlot(host, w, m, values, { min, max, fill, color, asleep, nowMs }) {
  const H = 112, L = 4, R = 4, T = 10, B = 22, n = m.n, x = (i) => L + (i / (n - 1)) * (w - L - R), y = (v) => H - B - ((v - min) / (max - min || 1)) * (H - B - T);
  const gid = uniqueId('mp'), xs = values.map((_, i) => x(i)), ys = values.map((v) => y(v)), kids = [];
  kids.push(svg('defs', null, svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': `var(--mc-${color})`, 'stop-opacity': '.38' }), svg('stop', { offset: '1', 'stop-color': `var(--mc-${color})`, 'stop-opacity': '0' }))));
  for (const [a, b] of bandsOf(asleep)) kids.push(svg('rect', { class: 'sc-mini__sleep', x: x(a), y: T, width: Math.max(1, x(b) - x(a)), height: H - B - T }));
  if (min < 0) kids.push(svg('line', { class: 'sc-plot__zero', x1: L, x2: w - R, y1: y(0), y2: y(0) }));
  if (fill) kids.push(svg('path', { d: `${path(xs, ys)}L${xs[n - 1]} ${y(Math.max(min, 0))}L${xs[0]} ${y(Math.max(min, 0))}Z`, fill: `url(#${gid})` }));
  kids.push(svg('path', { class: `sc-mini__line sc-mini__line--${color}`, d: path(xs, ys) }));
  for (const hh of [0, 6, 12, 18]) { const i = Math.round((hh * 60) / m.stepMin); kids.push(svg('text', { class: 'sc-plot__tick', x: x(i), y: H - 6, 'text-anchor': hh === 0 ? 'start' : 'middle' }, `${pad(hh)} h`)); }
  const ni = (nowMs - m.t0) / (m.stepMin * MIN);
  if (ni >= 0 && ni <= n - 1) kids.push(svg('line', { class: 'sc-mini__now', x1: x(ni), x2: x(ni), y1: T, y2: H - B }));
  replaceChildren(host, svg('svg', { class: 'sc-svg', viewBox: `0 0 ${w} ${H}`, width: w, height: H, role: 'img', 'aria-label': `Courbe sur 24 heures, de ${values[0].toFixed(2)} à ${values[n - 1].toFixed(2)}` }, ...kids));
}

function sumPlot(host, w, m, nowMs) {
  const H = 190, L = 30, R = 8, T = 12, B = 24, n = m.n, x = (i) => L + (i / (n - 1)) * (w - L - R), y = (v) => H - B - (v / 100) * (H - B - T);
  const gid = uniqueId('sp'), kids = [], xs = m.alert.map((_, i) => x(i));
  kids.push(svg('defs', null, svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--sun)', 'stop-opacity': '.5' }), svg('stop', { offset: '1', 'stop-color': 'var(--sun)', 'stop-opacity': '0' })),
    svg('linearGradient', { id: `${gid}-l`, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--sun-hot)' }), svg('stop', { offset: '1', 'stop-color': 'var(--sun-deep)' }))));
  for (const v of [0, 50, 100]) { kids.push(svg('line', { class: 'sc-plot__grid', x1: L, x2: w - R, y1: y(v), y2: y(v) })); kids.push(svg('text', { class: 'sc-plot__ytick', x: L - 5, y: y(v) + 3, 'text-anchor': 'end' }, String(v))); }
  for (const [a, b] of bandsOf(m.asleep)) kids.push(svg('rect', { class: 'sc-mini__sleep', x: x(a), y: T, width: Math.max(1, x(b) - x(a)), height: H - B - T }));
  for (const g of m.stats.goldenWindows) { const a = (g.startMs - m.t0) / (m.stepMin * MIN), b = (g.endMs - m.t0) / (m.stepMin * MIN); kids.push(svg('rect', { class: 'sc-sum__gold', x: x(a), y: T, width: Math.max(2, x(b) - x(a)), height: H - B - T, rx: 6 })); }
  const ys = m.alert.map(y), yb = m.alertBase.map(y);
  kids.push(svg('path', { d: `${path(xs, ys)}L${xs[n - 1]} ${y(0)}L${xs[0]} ${y(0)}Z`, fill: `url(#${gid})` }));
  kids.push(svg('path', { class: 'sc-line sc-line--base', d: path(xs, yb) }));
  kids.push(svg('path', { class: 'sc-line sc-line--glow', d: path(xs, ys) }));
  kids.push(svg('path', { class: 'sc-line sc-line--a', d: path(xs, ys), stroke: `url(#${gid}-l)` }));
  for (const hh of [0, 3, 6, 9, 12, 15, 18, 21]) { const i = Math.round((hh * 60) / m.stepMin); kids.push(svg('text', { class: 'sc-plot__tick', x: x(i), y: H - 7, 'text-anchor': 'middle' }, `${pad(hh)} h`)); }
  const ni = (nowMs - m.t0) / (m.stepMin * MIN);
  if (ni >= 0 && ni <= n - 1) kids.push(svg('line', { class: 'sc-mini__now', x1: x(ni), x2: x(ni), y1: T, y2: H - B }));
  replaceChildren(host, svg('svg', { class: 'sc-svg', viewBox: `0 0 ${w} ${H}`, width: w, height: H, role: 'img', 'aria-label': `Alerte prédite sur 24 heures : pic ${Math.round(m.stats.peak.value)} sur 100, creux ${Math.round(m.stats.trough.value)}.` }, ...kids));
}

// ---------------------------------------------------------------------------------------------
// Tasse qui se vide
// ---------------------------------------------------------------------------------------------
function buildCup() {
  const gid = uniqueId('cup');
  const liquid = svg('rect', { class: 'sc-cup__liq', x: 18, y: 20, width: 64, height: 0, fill: `url(#${gid})` });
  const wave = svg('path', { class: 'sc-cup__wave', d: '', fill: 'var(--caffeine)' });
  const el = svg('svg', { class: 'sc-cup', viewBox: '0 0 130 120', role: 'img', 'aria-label': 'Tasse : niveau de caféine restant' },
    svg('defs', null, svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--caffeine)' }), svg('stop', { offset: '1', 'stop-color': 'var(--sun-deep)' })),
      svg('clipPath', { id: `${gid}-c` }, svg('path', { d: 'M16 22h68v36a28 28 0 0 1-28 28h-12a28 28 0 0 1-28-28z' }))),
    svg('path', { class: 'sc-cup__handle', d: 'M84 32h8a12 12 0 0 1 0 28h-10', fill: 'none', 'stroke-width': 5, 'stroke-linecap': 'round' }),
    svg('g', { 'clip-path': `url(#${gid}-c)` }, svg('rect', { x: 10, y: 14, width: 80, height: 80, fill: 'var(--surface-3)', opacity: '.5' }), liquid, wave),
    svg('path', { class: 'sc-cup__body', d: 'M16 22h68v36a28 28 0 0 1-28 28h-12a28 28 0 0 1-28-28z', fill: 'none', 'stroke-width': 3, 'stroke-linejoin': 'round' }),
    svg('path', { class: 'sc-cup__saucer', d: 'M8 98h84', fill: 'none', 'stroke-width': 4, 'stroke-linecap': 'round' }),
    svg('g', { class: 'sc-cup__steam' }, svg('path', { d: 'M38 12c-4-4 4-6 0-10M52 12c-4-4 4-6 0-10M66 12c-4-4 4-6 0-10', fill: 'none', 'stroke-width': 2.4, 'stroke-linecap': 'round' })));
  const level = h('span', { class: 'sc-cupwrap__v num' }, '0');
  return {
    el: h('div', { class: 'sc-cupwrap' }, el, h('div', { class: 'sc-cupwrap__t' }, level, h('small', null, 'mg'))),
    set(frac, mg) {
      const f = clamp(frac, 0, 1), top = 86 - f * 64;
      liquid.setAttribute('y', String(top)); liquid.setAttribute('height', String(Math.max(0, 90 - top)));
      wave.setAttribute('d', f > 0.02 ? `M14 ${top}q9 -4 18 0t18 0t18 0t18 0v6H14z` : '');
      level.textContent = String(Math.round(mg));
      el.style.setProperty('--steam', String(clamp(f * 1.2, 0, 1)));
    },
  };
}
