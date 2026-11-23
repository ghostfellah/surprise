// Vue « Réglages » : profil, préférences, modèle personnel, données (export/import, chiffré ou non, démo, effacement),
// installation PWA, raccourcis clavier, à propos. Chaque contrôle écrit immédiatement dans le store (annulable).
//
// Principe : on ne reconstruit JAMAIS les champs pendant la frappe (le curseur et le focus resteraient perdus) ;
// les contrôles sont « liés » à l'état et resynchronisés quand l'état change ailleurs (annuler, importer…).
//
// Retour haptique : le contrat de Prefs ne le prévoit pas ; la préférence est gardée dans localStorage
// (`kairos.haptics` = "off" pour couper) et appliquée en neutralisant navigator.vibrate. Le shell peut appeler
// `applyHapticsPref()` (export nommé) au démarrage pour que le choix vaille dès le lancement.
import { h, svg, icon, replaceChildren, animateNumber, haptic, prefersReducedMotion, uniqueId, syncRange } from '../dom.js';

const MIN = 60_000;
const HAPTICS_KEY = 'kairos.haptics';
const VERSION = '1.0';

// ---------------------------------------------------------------------------------------------
// CSS (une seule fois, depuis document.baseURI)
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
// Haptique
// ---------------------------------------------------------------------------------------------
let nativeVibrate = null;
export function hapticsEnabled() { try { return localStorage.getItem(HAPTICS_KEY) !== 'off'; } catch { return true; } }
export function applyHapticsPref() {
  if (typeof navigator === 'undefined') return;
  if (nativeVibrate === null) nativeVibrate = typeof navigator.vibrate === 'function' ? navigator.vibrate.bind(navigator) : false;
  if (!nativeVibrate) return;
  try { navigator.vibrate = hapticsEnabled() ? nativeVibrate : () => false; } catch { /* propriété non modifiable */ }
}

// ---------------------------------------------------------------------------------------------
// Utilitaires purs
// ---------------------------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const hhmmToMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? (+m[1] % 24) * 60 + +m[2] : null; };
const minToHHMM = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`; };
const durMin = (from, to) => { const d = (((to - from) % 1440) + 1440) % 1440; return d === 0 ? 1440 : d; };
const fmtDur = (min) => { const m = Math.round(min), hh = Math.floor(m / 60), r = m % 60; return m < 60 ? `${m} min` : r ? `${hh} h ${pad(r)}` : `${hh} h`; };
const num = (x, d = 1) => Number(x).toFixed(d).replace('.', ',');
const dayLabels = [[1, 'L', 'lundi'], [2, 'M', 'mardi'], [3, 'M', 'mercredi'], [4, 'J', 'jeudi'], [5, 'V', 'vendredi'], [6, 'S', 'samedi'], [0, 'D', 'dimanche']];

function fmtBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${num(n / 1024, n < 10240 ? 1 : 0)} Ko`;
  return `${num(n / 1024 / 1024, 1)} Mo`;
}

/** Estimation grossière de la robustesse d'un mot de passe (bits d'entropie, avec pénalités). Purement indicatif. */
export function passwordStrength(pw) {
  const s = String(pw || '');
  if (!s) return { score: 0, bits: 0, label: '', advice: '' };
  let pool = 0;
  if (/[a-zà-ÿ]/.test(s)) pool += 26;
  if (/[A-ZÀ-Ý]/.test(s)) pool += 26;
  if (/\d/.test(s)) pool += 10;
  if (/[^A-Za-z0-9à-ÿÀ-Ý]/.test(s)) pool += 33;
  let bits = s.length * Math.log2(Math.max(2, pool));
  const uniq = new Set(s).size;
  bits *= Math.min(1, uniq / Math.max(1, s.length * 0.65));          // caractères répétés
  if (/(.)\1{2,}/.test(s)) bits -= 8;
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|azer|wxcv)/i.test(s)) bits -= 14;
  if (/^(?:19|20)\d{2}$|^\d{4,8}$/.test(s)) bits = Math.min(bits, 18);   // une date ou un code PIN
  if (/(password|motdepasse|mot de passe|azerty|qwerty|kairos|soleil|123456|letmein|admin)/i.test(s)) bits = Math.min(bits, 22);
  bits = Math.max(0, bits);
  const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 56 ? 2 : bits < 72 ? 3 : 4;
  const label = ['Très faible', 'Faible', 'Correct', 'Solide', 'Excellent'][score];
  const advice = score >= 3 ? 'Bien joué. Garde-le dans un gestionnaire de mots de passe.'
    : s.length < 12 ? 'Allonge-le : une phrase de quatre ou cinq mots est plus solide qu\'un mot « compliqué ».'
      : 'Évite les suites (1234), les dates et les mots courants ; mélange des mots sans lien.';
  return { score, bits, label, advice };
}

function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

async function readFile(file) {
  if (!file) throw new Error('Aucun fichier choisi.');
  if (file.size > 40 * 1024 * 1024) throw new Error('Ce fichier est trop volumineux pour être une sauvegarde Kairos.');
  return file.text();
}

/** Arc SVG (degrés, 0° = droite, sens horaire). */
function arc(cx, cy, r, a0, a1) {
  const rad = (a) => (a * Math.PI) / 180, span = (((a1 - a0) % 360) + 360) % 360 || 360;
  const p = (a) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];
  const [x0, y0] = p(a0), [x1, y1] = p(a0 + span);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// ---------------------------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------------------------
export default {
  id: 'settings',
  title: 'Réglages',
  icon: 'gear',
  async mount(root, ctx) {
    await ensureCss('css/views-settings.css');
    applyHapticsPref();
    const cleanups = [];
    const { actions, store } = ctx;
    const profile = () => ctx.state.profile;
    const prefs = () => ctx.state.prefs;
    const uid = uniqueId('st');
    const bindings = [];           // { sync() } resynchronise un contrôle avec l'état
    const syncAll = () => bindings.forEach((b) => b.sync());

    // Écriture protégée : une erreur de validation du store devient un message lisible
    const setProfile = (patch) => { try { actions.setProfile(patch); flashSaved(); return true; } catch (e) { ctx.toast(e.message || 'Valeur refusée', { kind: 'err' }); syncAll(); return false; } };
    const setPrefs = (patch) => { try { actions.setPrefs(patch); flashSaved(); return true; } catch (e) { ctx.toast(e.message || 'Valeur refusée', { kind: 'err' }); syncAll(); return false; } };

    // ---------------------------------------------------------------------------------------
    // Héros : cadran 24 h vivant + annuler/rétablir
    // ---------------------------------------------------------------------------------------
    const dial = buildDial();
    const savedTag = h('span', { class: 'st-saved', 'aria-live': 'polite' }, icon('check', { size: 14 }), 'Enregistré');
    let savedTimer = 0;
    function flashSaved() { savedTag.classList.add('is-on'); clearTimeout(savedTimer); savedTimer = setTimeout(() => savedTag.classList.remove('is-on'), 1400); }
    cleanups.push(() => clearTimeout(savedTimer));

    const undoBtn = h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => { if (store.undo()) { ctx.toast('Annulé', { duration: 1600 }); haptic(8); } } }, icon('undo', { size: 18 }), 'Annuler');
    const redoBtn = h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => { if (store.redo()) { ctx.toast('Rétabli', { duration: 1600 }); haptic(8); } } }, icon('redo', { size: 18 }), 'Rétablir');
    const heroStats = h('div', { class: 'st-hero__stats' });
    const hero = h('section', { class: 'card card--hero st-hero', 'aria-labelledby': `${uid}-h` },
      h('div', { class: 'st-hero__dial' }, dial.el),
      h('div', { class: 'st-hero__copy' },
        h('span', { class: 'hero__eyebrow' }, 'Toi, ton rythme, tes données'),
        h('h2', { class: 'hero__title', id: `${uid}-h` }, 'Rends Kairos ', h('em', null, 'à ta mesure'), '.'),
        h('p', { class: 'lead' }, 'Chaque réglage s\'applique tout de suite et se rattrape d\'un geste : rien n\'est définitif.'),
        heroStats,
        h('div', { class: 'row row--wrap st-hero__actions' }, undoBtn, redoBtn, savedTag)));

    const sections = [['profil', 'Profil', 'sliders'], ['prefs', 'Préférences', 'sparkle'], ['modele', 'Modèle', 'brain'], ['donnees', 'Données', 'download'], ['installer', 'Installer', 'smartphone'], ['raccourcis', 'Raccourcis', 'keyboard'], ['apropos', 'À propos', 'info']];
    const quick = h('nav', { class: 'st-quick', 'aria-label': 'Aller à une section' }, ...sections.map(([id, label, ic]) => h('a', { class: 'chip', href: `#/settings`, onclick: (e) => { e.preventDefault(); const el = root.querySelector(`#${uid}-${id}`); if (el) el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }); } }, icon(ic, { size: 15 }), label)));

    // ---------------------------------------------------------------------------------------
    // Composants de formulaire liés à l'état
    // ---------------------------------------------------------------------------------------
    function card(id, title, subtitle, ic, ...body) {
      return h('section', { class: 'card st-card', id: `${uid}-${id}`, 'aria-labelledby': `${uid}-${id}-t` },
        h('header', { class: 'st-card__head' }, h('span', { class: 'st-card__ic' }, icon(ic, { size: 20 })), h('div', null, h('h3', { class: 'card__title', id: `${uid}-${id}-t` }, title), subtitle ? h('p', { class: 'card__sub' }, subtitle) : null)),
        ...body);
    }

    function timeField(label, key, hint) {
      const input = h('input', { class: 'input num', type: 'time', step: '300', id: `${uid}-${key}`, onchange: (e) => { if (e.target.value) setProfile({ [key]: e.target.value }); else syncAll(); } });
      bindings.push({ sync() { if (document.activeElement !== input) input.value = profile()[key] || ''; } });
      return h('div', { class: 'field' }, h('label', { class: 'label', for: `${uid}-${key}` }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
    }

    function rangeField({ label, key, min, max, step, format, note, hint }) {
      const out = h('output', { class: 'st-range__v num', for: `${uid}-${key}` });
      const noteEl = h('span', { class: 'st-range__note' });
      const input = h('input', { class: 'range', type: 'range', id: `${uid}-${key}`, min, max, step, 'aria-valuetext': '',
        oninput: (e) => { const v = +e.target.value; paint(v); setProfile({ [key]: v }); } });
      const paint = (v) => { out.textContent = format(v); noteEl.textContent = note ? note(v) : ''; input.setAttribute('aria-valuetext', format(v)); };
      bindings.push({ sync() { const v = Number(profile()[key]); if (Number.isFinite(v)) { input.value = String(v); paint(v); syncRange(input); } } });
      return h('div', { class: 'field st-range' }, h('div', { class: 'row row--between row--baseline' }, h('label', { class: 'label', for: `${uid}-${key}` }, label), out), input, h('div', { class: 'row row--between' }, noteEl, hint ? h('span', { class: 'hint' }, hint) : null));
    }

    // ---------------------------------------------------------------------------------------
    // Profil
    // ---------------------------------------------------------------------------------------
    const dayChips = h('div', { class: 'st-days', role: 'group', 'aria-label': 'Jours de travail' }, ...dayLabels.map(([d, short, long]) => {
      const b = h('button', { class: 'st-day', type: 'button', 'aria-label': long, 'aria-pressed': 'false', 'data-d': d, onclick: () => {
        const cur = new Set(profile().workDays || []); cur.has(d) ? cur.delete(d) : cur.add(d); haptic(6); setProfile({ workDays: [...cur].sort((a, c) => a - c) });
        b.setAttribute('aria-pressed', cur.has(d) ? 'true' : 'false');
      } }, short);
      return b;
    }));
    bindings.push({ sync() { const cur = new Set(profile().workDays || []); dayChips.querySelectorAll('.st-day').forEach((b) => b.setAttribute('aria-pressed', cur.has(+b.dataset.d) ? 'true' : 'false')); } });

    // fuseau : saisie libre avec liste de suggestions (Intl.supportedValuesOf si disponible)
    let zones = ['Europe/Paris', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
    try { if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone'); } catch { /* liste réduite */ }
    const tzList = h('datalist', { id: `${uid}-tzl` }, ...zones.map((z) => h('option', { value: z })));
    const tzHint = h('span', { class: 'hint' });
    const tzInput = h('input', { class: 'input', type: 'text', id: `${uid}-tz`, list: `${uid}-tzl`, autocomplete: 'off', spellcheck: 'false', placeholder: 'Europe/Paris',
      onchange: (e) => { const v = e.target.value.trim(); try { new Intl.DateTimeFormat('fr-FR', { timeZone: v }); } catch { ctx.toast(`« ${v} » n'est pas un fuseau horaire connu (exemple : Europe/Paris).`, { kind: 'warn' }); syncAll(); return; } setProfile({ tz: v }); paintTz(); } });
    const paintTz = () => { try { const now = ctx.nowMs(); const t = new Intl.DateTimeFormat('fr-FR', { timeZone: profile().tz, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(now); tzHint.textContent = `Là-bas, il est ${t}`; } catch { tzHint.textContent = ''; } };
    bindings.push({ sync() { if (document.activeElement !== tzInput) tzInput.value = profile().tz || ''; paintTz(); } });

    const sens = (v) => (v < 0.7 ? 'Peu sensible : un café te fait peu d\'effet' : v < 1.25 ? 'Dans la moyenne' : v < 1.7 ? 'Sensible : un seul café te réveille bien' : 'Très sensible : attention aux tasses tardives');
    const half = (v) => (v < 4 ? 'Élimination rapide' : v < 6 ? 'Valeur courante (≈ 5 h)' : v < 8 ? 'Élimination lente' : 'Très lente (tabac absent, grossesse, certains médicaments…)');
    const needNote = (v) => (v < 7 ? 'Court dormeur' : v <= 8.5 ? 'Besoin courant' : 'Gros dormeur');

    const profileCard = card('profil', 'Ton profil', 'Ces valeurs pilotent toutes tes courbes.', 'sliders',
      h('div', { class: 'st-grid2' }, timeField('Réveil habituel', 'usualWake'), timeField('Coucher habituel', 'usualBed')),
      rangeField({ label: 'Besoin de sommeil', key: 'sleepNeedH', min: 6, max: 10, step: 0.25, format: (v) => fmtDur(v * 60), note: needNote, hint: 'Entre 6 h et 10 h' }),
      h('div', { class: 'st-grid2' }, timeField('Début du travail', 'workStart'), timeField('Fin du travail', 'workEnd')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Jours de travail'), dayChips, h('span', { class: 'hint' }, 'Kairos ne planifie des tâches que sur ces jours et ces plages.')),
      h('hr', { class: 'sep' }),
      rangeField({ label: 'Sensibilité à la caféine', key: 'caffeineSensitivity', min: 0.4, max: 2, step: 0.05, format: (v) => `× ${num(v, 2)}`, note: sens }),
      rangeField({ label: 'Demi-vie de la caféine', key: 'caffeineHalfLifeH', min: 3, max: 9, step: 0.25, format: (v) => `${num(v, 2)} h`, note: half, hint: 'Temps pour éliminer la moitié' }),
      h('hr', { class: 'sep' }),
      h('div', { class: 'field' }, h('label', { class: 'label', for: `${uid}-tz` }, 'Fuseau horaire'), tzInput, tzList, tzHint));

    // ---------------------------------------------------------------------------------------
    // Préférences : thème avec aperçu, notifications, haptique
    // ---------------------------------------------------------------------------------------
    const themeDefs = [['auto', 'Auto', 'Suit ton appareil'], ['light', 'Clair', 'Aube d\'observatoire'], ['dark', 'Sombre', 'Nuit d\'observatoire']];
    const themeBtns = themeDefs.map(([val, name, sub]) => {
      const mini = (th) => h('span', { class: 'st-mini', 'data-theme': th, 'aria-hidden': 'true' }, h('span', { class: 'st-mini__bar' }), h('span', { class: 'st-mini__curve' }), h('span', { class: 'st-mini__sun' }), h('span', { class: 'st-mini__card' }));
      const prev = val === 'auto' ? h('span', { class: 'st-mini-split', 'aria-hidden': 'true' }, mini('light'), mini('dark')) : mini(val);
      return h('button', { class: 'st-theme', type: 'button', 'data-v': val, 'aria-pressed': 'false', onclick: () => { haptic(8); ctx.setTheme(val); themeBtns.forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === val ? 'true' : 'false')); flashSaved(); } },
        prev, h('span', { class: 'st-theme__name' }, name), h('span', { class: 'st-theme__sub' }, sub));
    });
    bindings.push({ sync() { const cur = prefs().theme || 'auto'; themeBtns.forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === cur ? 'true' : 'false')); } });

    const notifPerm = h('span', { class: 'hint' });
    const paintPerm = () => {
      const p = 'Notification' in window ? Notification.permission : 'unsupported';
      notifPerm.textContent = p === 'granted' ? 'Autorisées par ton navigateur.' : p === 'denied' ? 'Bloquées par ton navigateur : autorise-les dans les réglages du site.' : p === 'unsupported' ? 'Ce navigateur ne gère pas les notifications.' : 'On te demandera la permission à l\'activation.';
    };
    const notifInput = h('input', { type: 'checkbox', id: `${uid}-notif`, onchange: async (e) => {
      if (e.target.checked) { e.target.disabled = true; const ok = await ctx.enableNotifications(); e.target.disabled = false; e.target.checked = !!ok; paintPerm(); }
      else { setPrefs({ notifications: false }); }
    } });
    bindings.push({ sync() { notifInput.checked = !!prefs().notifications; paintPerm(); } });
    const hapticInput = h('input', { type: 'checkbox', id: `${uid}-hap`, onchange: (e) => { try { localStorage.setItem(HAPTICS_KEY, e.target.checked ? 'on' : 'off'); } catch { /* ignoré */ } applyHapticsPref(); if (e.target.checked) haptic([14, 40, 14]); flashSaved(); } });
    bindings.push({ sync() { hapticInput.checked = hapticsEnabled(); } });
    const hapticsSupported = typeof navigator !== 'undefined' && 'vibrate' in navigator;

    const prefsCard = card('prefs', 'Préférences', 'L\'apparence et les rappels.', 'sparkle',
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Thème'), h('div', { class: 'st-themes', role: 'group', 'aria-label': 'Thème' }, ...themeBtns), h('span', { class: 'hint' }, 'L\'aperçu est en direct : toute l\'application change quand tu choisis.')),
      h('hr', { class: 'sep' }),
      h('div', { class: 'st-switch' }, h('label', { class: 'switch' }, notifInput, h('span', { class: 'switch__ui' }), h('span', { class: 'st-switch__t' }, h('strong', null, 'Rappels de blocs'), h('small', null, 'Une notification 5 min avant chaque bloc du planning'))), notifPerm),
      h('div', { class: 'st-switch' }, h('label', { class: 'switch' }, hapticInput, h('span', { class: 'switch__ui' }), h('span', { class: 'st-switch__t' }, h('strong', null, 'Retour haptique'), h('small', null, hapticsSupported ? 'Une petite vibration sur les gestes importants' : 'Pas disponible sur cet appareil (iOS et la plupart des ordinateurs)')))));

    // ---------------------------------------------------------------------------------------
    // Modèle personnel
    // ---------------------------------------------------------------------------------------
    const modelHost = h('div', { class: 'st-model' });
    const modelCard = card('modele', 'Ton modèle personnel', 'Ce que Kairos a appris de tes check-ins.', 'brain', modelHost);
    let lastConf = 0;
    function paintModel() {
      const p = profile(), fit = p.fit, n = ctx.state.checkins.length, shift = Math.round(p.chronoShiftMin || 0);
      const resetBtn = h('button', { class: 'btn btn--secondary', type: 'button', disabled: !shift && !fit, onclick: async () => {
        const ok = await ctx.confirm('Remettre le décalage de chronotype à 0 et oublier l\'ajustement appris ? Tes check-ins restent en place.', { okLabel: 'Réinitialiser', danger: true });
        if (ok) { setProfile({ chronoShiftMin: 0, fit: null }); ctx.toast('Décalage réinitialisé', { kind: 'ok', undoLabel: 'Annuler', onUndo: () => store.undo() }); paintModel(); }
      } }, icon('refresh', { size: 18 }), 'Réinitialiser le décalage');
      if (!fit) {
        const prog = Math.min(100, (n / 8) * 100), ready = n >= 8;
        replaceChildren(modelHost,
          h('div', { class: 'st-empty' },
            h('div', { class: 'st-empty__art', 'aria-hidden': 'true' }, h('span', { class: 'orb', style: { '--orb-size': '84px', '--orb-color': 'var(--night)' } })),
            h('h4', { class: 'st-empty__t' }, ready ? 'Prêt à apprendre' : 'Pas encore appris'),
            h('p', { class: 'small muted' }, ready ? `Tu as ${n} check-ins : c'est assez pour que Kairos ajuste ton chronotype et ta sensibilité à la caféine. Regarde l'écran Bilan pour voir ce qu'il en ressort ; tout reste sur ton appareil.` : 'Après environ 8 check-ins (« comment te sens-tu ? »), Kairos ajuste ton chronotype et ta sensibilité à la caféine. Tout reste sur ton appareil.'),
            h('div', { class: 'st-empty__prog' }, h('div', { class: 'progress progress--night', style: { '--pct': String(prog) }, role: 'img', 'aria-label': `${Math.min(n, 8)} check-ins sur 8` }, h('div', { class: 'progress__bar' })), h('span', { class: 'num tiny muted' }, `${Math.min(n, 8)} / 8`)),
            ready ? h('button', { class: 'btn btn--primary', type: 'button', onclick: () => ctx.navigate('#/insights') }, icon('chart', { size: 18 }), 'Voir le bilan')
              : ctx.openCheckIn ? h('button', { class: 'btn btn--primary', type: 'button', onclick: () => ctx.openCheckIn() }, icon('plus', { size: 18 }), 'Faire un check-in') : null),
          shift ? h('p', { class: 'small muted st-shift' }, icon('clock', { size: 16 }), `Décalage de chronotype actuel : ${shift > 0 ? '+' : '−'}${Math.abs(shift)} min.`) : null,
          resetBtn);
        return;
      }
      const conf = Math.round((fit.confidence || 0) * 100), r2 = Number.isFinite(fit.r2) ? fit.r2 : null;
      const C = 2 * Math.PI * 44, gid = uniqueId('cg');
      const ring = svg('svg', { class: 'st-ring', viewBox: '0 0 110 110', role: 'img', 'aria-label': `Confiance du modèle : ${conf} %` },
        svg('defs', null, svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--night)' }), svg('stop', { offset: '1', 'stop-color': 'var(--sun-hot)' }))),
        svg('circle', { cx: 55, cy: 55, r: 44, fill: 'none', 'stroke-width': 9, class: 'st-ring__track' }),
        svg('circle', { cx: 55, cy: 55, r: 44, fill: 'none', 'stroke-width': 9, 'stroke-linecap': 'round', stroke: `url(#${gid})`, class: 'st-ring__arc', 'stroke-dasharray': C, 'stroke-dashoffset': C * (1 - lastConf / 100), transform: 'rotate(-90 55 55)', style: { '--c': C, '--to': C * (1 - conf / 100) } }));
      const big = h('span', { class: 'st-ring__n num' }, String(lastConf));
      animateNumber(big, conf, { from: lastConf, duration: 900 }); lastConf = conf;
      requestAnimationFrame(() => { const a = ring.querySelector('.st-ring__arc'); if (a) a.style.strokeDashoffset = String(C * (1 - conf / 100)); });
      const gain = fit.baselineRmse > 0 && Number.isFinite(fit.rmse) ? Math.round((1 - fit.rmse / fit.baselineRmse) * 100) : null;
      const stat = (label, value, sub) => h('div', { class: 'st-stat' }, h('span', { class: 'stat__label' }, label), h('span', { class: 'st-stat__v num' }, value), sub ? h('span', { class: 'tiny faint' }, sub) : null);
      const when = fit.fittedMs ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' }).format(fit.fittedMs) : null;
      replaceChildren(modelHost,
        h('div', { class: 'st-model__top' },
          h('div', { class: 'st-ring-wrap' }, ring, h('div', { class: 'st-ring__c' }, big, h('span', { class: 'st-ring__u' }, '% confiance'))),
          h('div', { class: 'st-model__stats' }, stat('R²', r2 === null ? '—' : num(r2, 2), 'part de variance expliquée'), stat('Observations', String(fit.n ?? n), 'check-ins utilisés'), stat('Erreur', Number.isFinite(fit.rmse) ? `${num(fit.rmse, 1)} pts` : '—', gain !== null ? (gain > 0 ? `${gain} % mieux qu'une moyenne` : 'pas mieux qu\'une moyenne') : null))),
        h('div', { class: 'st-shiftbox' }, icon('clock', { size: 18 }), h('p', { class: 'small' }, shift === 0 ? 'Aucun décalage appliqué : ton horloge suit ton horaire déclaré.' : h('span', null, 'Ton horloge interne est environ ', h('strong', null, `${Math.abs(shift)} min ${shift > 0 ? 'plus tard' : 'plus tôt'}`), ' que ton horaire déclaré.'), when ? h('span', { class: 'faint' }, ` Appris le ${when}.`) : null)),
        h('p', { class: 'tiny faint' }, 'L\'ajustement est borné et fait sur ton appareil. Il refuse de conclure avec moins de 8 observations.'),
        resetBtn);
    }

    // ---------------------------------------------------------------------------------------
    // Données
    // ---------------------------------------------------------------------------------------
    const sizeEl = h('span', { class: 'st-size__v num' }, '—');
    const countsEl = h('ul', { class: 'st-counts' });
    const dataMsg = h('div', { class: 'st-msg', role: 'status', 'aria-live': 'polite', hidden: true });
    const showMsg = (kind, text) => { dataMsg.hidden = !text; dataMsg.className = `banner st-msg ${kind === 'err' ? 'banner--coral' : kind === 'ok' ? 'banner--ok' : ''}`; replaceChildren(dataMsg, icon(kind === 'err' ? 'alert-circle' : 'check-circle', { size: 18 }), h('span', null, text)); };
    let sizeTimer = 0;
    function paintSize() {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => {
        const s = ctx.state; let bytes = 0;
        try { bytes = new Blob([actions.exportJSON()]).size; } catch { bytes = 0; }
        sizeEl.textContent = fmtBytes(bytes);
        const c = [['moon', s.sleeps.length, 'nuits'], ['coffee', s.caffeine.length, 'cafés'], ['heart', s.checkins.length, 'check-ins'], ['list', s.tasks.length, 'tâches'], ['calendar', s.events.length, 'événements']];
        replaceChildren(countsEl, ...c.map(([ic, n, l]) => h('li', null, icon(ic, { size: 15 }), h('b', { class: 'num' }, String(n)), h('span', null, l))));
      }, 80);
    }
    cleanups.push(() => clearTimeout(sizeTimer));

    const fileJson = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', onchange: async (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
      try {
        const text = await readFile(f);
        if (text.trim().startsWith('kairos1.')) throw new Error('Ce fichier est une sauvegarde chiffrée : utilise « Importer chiffré » et ton mot de passe.');
        const ok = await ctx.confirm(`Remplacer tes données actuelles par celles de « ${f.name} » ? Tu pourras annuler juste après.`, { okLabel: 'Importer' });
        if (!ok) return;
        actions.importJSON(text);
        showMsg('ok', `Import réussi : ${f.name}`); ctx.toast('Données importées', { kind: 'ok', undoLabel: 'Annuler', onUndo: () => store.undo() }); haptic([8, 30, 12]);
      } catch (err) { showMsg('err', err && err.message ? err.message : 'Ce fichier n\'a pas pu être lu.'); ctx.toast('Import impossible', { kind: 'err' }); }
    } });

    function exportJson() {
      try { download(`kairos-${stamp(ctx.nowMs())}.json`, actions.exportJSON()); showMsg('ok', 'Sauvegarde téléchargée. Elle n\'est pas chiffrée : garde-la en lieu sûr.'); haptic(10); }
      catch (e) { showMsg('err', e.message || 'Export impossible.'); }
    }

    function meter(getPw) {
      const segs = [0, 1, 2, 3].map(() => h('i'));
      const label = h('span', { class: 'st-meter__l' });
      const advice = h('p', { class: 'tiny muted st-meter__a' });
      const el = h('div', { class: 'st-meter', 'data-score': '0' }, h('div', { class: 'st-meter__bars', 'aria-hidden': 'true' }, ...segs), label);
      const update = () => { const r = passwordStrength(getPw()); el.dataset.score = String(r.score); el.dataset.empty = r.label ? '0' : '1'; label.textContent = r.label ? `${r.label} · estimation` : ''; advice.textContent = r.advice; el.setAttribute('aria-label', r.label ? `Robustesse : ${r.label}` : 'Robustesse du mot de passe'); const filled = r.label ? [1, 2, 2, 3, 4][r.score] : 0; segs.forEach((sg, i) => sg.classList.toggle('on', i < filled)); };
      return { el, advice, update };
    }

    function passField(label, id, { autocomplete = 'new-password', hint } = {}) {
      const input = h('input', { class: 'input', type: 'password', id, autocomplete, spellcheck: 'false', autocapitalize: 'off' });
      const eye = h('button', { class: 'st-eye iconbtn', type: 'button', 'aria-label': 'Afficher le mot de passe', 'aria-pressed': 'false', onclick: () => { const on = input.type === 'password'; input.type = on ? 'text' : 'password'; eye.setAttribute('aria-pressed', on ? 'true' : 'false'); eye.setAttribute('aria-label', on ? 'Masquer le mot de passe' : 'Afficher le mot de passe'); replaceChildren(eye, icon(on ? 'eyeoff' : 'eye', { size: 18 })); } }, icon('eye', { size: 18 }));
      return { input, node: h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), h('div', { class: 'st-pass' }, input, eye), hint ? h('span', { class: 'hint' }, hint) : null) };
    }

    function exportEncrypted() {
      const p1 = passField('Mot de passe', `${uid}-p1`), p2 = passField('Confirme le mot de passe', `${uid}-p2`);
      const m = meter(() => p1.input.value);
      const err = h('p', { class: 'error', role: 'alert', hidden: true });
      const go = h('button', { class: 'btn btn--primary', type: 'button', disabled: true }, icon('lock', { size: 18 }), 'Chiffrer et télécharger');
      const check = () => { m.update(); const ok = p1.input.value.length >= 8 && p1.input.value === p2.input.value; go.disabled = !ok; err.hidden = !(p2.input.value && p1.input.value !== p2.input.value); err.textContent = 'Les deux mots de passe sont différents.'; };
      p1.input.addEventListener('input', check); p2.input.addEventListener('input', check); check();
      const body = h('form', { class: 'st-form', onsubmit: (e) => { e.preventDefault(); if (!go.disabled) go.click(); } },
        h('p', { class: 'muted small' }, 'Tes données sont chiffrées sur cet appareil (AES-256-GCM, clé dérivée de ton mot de passe par PBKDF2) avant d\'être écrites dans un fichier.'),
        p1.node, m.el, m.advice, p2.node, err,
        h('div', { class: 'banner banner--warn' }, icon('alert', { size: 18 }), h('span', null, h('strong', null, 'Pas de récupération possible. '), 'Si tu perds ce mot de passe, la sauvegarde est définitivement illisible, pour toi comme pour n\'importe qui.')));
      const modal = ctx.openModal({ title: 'Export chiffré', size: 'sm', content: body, initialFocus: p1.input, footer: (api) => [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => api.close() }, 'Annuler'), go] });
      go.addEventListener('click', async () => {
        const label = go.lastChild; go.disabled = true; go.classList.add('is-busy'); label.textContent = 'Chiffrement…';
        try {
          const payload = await actions.exportEncrypted(p1.input.value);
          download(`kairos-${stamp(ctx.nowMs())}.kairos`, payload, 'text/plain');
          modal.close(); showMsg('ok', 'Sauvegarde chiffrée téléchargée (.kairos). Sans le mot de passe, elle est illisible.'); ctx.toast('Sauvegarde chiffrée prête', { kind: 'ok' }); haptic([8, 30, 12]);
        } catch (e) { go.disabled = false; go.classList.remove('is-busy'); label.textContent = 'Chiffrer et télécharger'; err.hidden = false; err.textContent = e.message || 'Le chiffrement a échoué.'; }
      });
    }

    function importEncrypted() {
      let file = null, text = null;
      const p = passField('Mot de passe', `${uid}-ip`, { autocomplete: 'current-password' });
      const fname = h('span', { class: 'st-file__n' }, 'Aucun fichier choisi');
      const err = h('p', { class: 'error', role: 'alert', hidden: true });
      const picker = h('input', { type: 'file', accept: '.kairos,.txt,text/plain', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', onchange: async (e) => {
        file = e.target.files && e.target.files[0]; err.hidden = true;
        try { text = file ? await readFile(file) : null; if (text && !text.trim().startsWith('kairos1.')) { err.hidden = false; err.textContent = 'Ce fichier ne ressemble pas à une sauvegarde chiffrée Kairos (il devrait commencer par « kairos1. »).'; text = null; } } catch (x) { err.hidden = false; err.textContent = x.message; text = null; }
        fname.textContent = file ? file.name : 'Aucun fichier choisi'; check();
      } });
      const go = h('button', { class: 'btn btn--primary', type: 'button', disabled: true }, icon('unlock', { size: 18 }), 'Déchiffrer et importer');
      const check = () => { go.disabled = !(text && p.input.value.length > 0); };
      p.input.addEventListener('input', check);
      const body = h('form', { class: 'st-form', onsubmit: (e) => { e.preventDefault(); if (!go.disabled) go.click(); } },
        h('p', { class: 'muted small' }, 'Choisis un fichier .kairos produit par « Exporter chiffré ». Il remplace tes données actuelles (tu pourras annuler).'),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Fichier'), h('div', { class: 'st-file' }, h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => picker.click() }, icon('upload', { size: 18 }), 'Choisir…'), fname, picker)),
        p.node, err);
      const modal = ctx.openModal({ title: 'Import chiffré', size: 'sm', content: body, initialFocus: (d) => d.querySelector('.st-file .btn'), footer: (api) => [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => api.close() }, 'Annuler'), go] });
      go.addEventListener('click', async () => {
        const label = go.lastChild; go.disabled = true; label.textContent = 'Déchiffrement…'; err.hidden = true;
        try {
          await actions.importEncrypted(text, p.input.value);
          modal.close(); showMsg('ok', `Import chiffré réussi : ${file ? file.name : ''}`); ctx.toast('Données importées', { kind: 'ok', undoLabel: 'Annuler', onUndo: () => store.undo() }); haptic([8, 30, 12]);
        } catch (e) { go.disabled = false; label.textContent = 'Déchiffrer et importer'; err.hidden = false; err.textContent = e.message || 'Mot de passe incorrect ou données corrompues'; p.input.focus(); p.input.select(); haptic([10, 40, 10]); }
      });
    }

    async function loadDemo() {
      const ok = await ctx.confirm('Charger les données de démonstration ? Elles remplacent tes données actuelles (tu pourras annuler juste après). Parfait pour explorer Kairos avec un mois d\'historique.', { okLabel: 'Charger la démo' });
      if (!ok) return;
      try {
        const mod = await import('../../core/demo.js');
        const make = mod.makeDemoState || mod.default;
        actions.loadDemo(make(ctx.nowMs(), 7));
        showMsg('ok', 'Démo chargée : un mois de sommeil, de cafés et de check-ins fictifs.');
        ctx.toast('Démo chargée', { kind: 'ok', undoLabel: 'Annuler', onUndo: () => store.undo() }); haptic([8, 30, 12]);
      } catch (e) { showMsg('err', `Impossible de charger la démo : ${e.message || e}`); }
    }

    function eraseAll() {
      ctx.confirm('Effacer toutes tes données (sommeil, cafés, check-ins, tâches, événements, profil) ? Cette action est destructrice.', { okLabel: 'Continuer', danger: true, title: 'Tout effacer ?' }).then((first) => {
        if (!first) return;
        const input = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Tape EFFACER pour confirmer', placeholder: 'EFFACER' });
        const go = h('button', { class: 'btn btn--danger btn--solid', type: 'button', disabled: true }, icon('trash', { size: 18 }), 'Effacer pour de bon');
        input.addEventListener('input', () => { go.disabled = input.value.trim().toUpperCase() !== 'EFFACER'; });
        const body = h('form', { class: 'st-form', onsubmit: (e) => { e.preventDefault(); if (!go.disabled) go.click(); } },
          h('p', { class: 'muted' }, 'Dernière vérification. Pour confirmer, tape ', h('strong', null, 'EFFACER'), ' ci-dessous.'),
          h('p', { class: 'small faint' }, 'Conseil : exporte une sauvegarde avant. Tu pourras aussi annuler juste après, mais seulement tant que tu ne quittes pas l\'application.'), input);
        const modal = ctx.openModal({ title: 'Dernière confirmation', size: 'sm', content: body, initialFocus: input, footer: (api) => [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => api.close() }, 'Garder mes données'), go] });
        go.addEventListener('click', () => { actions.resetAll(); modal.close(); showMsg('ok', 'Toutes tes données ont été effacées.'); ctx.toast('Tout est effacé', { kind: 'warn', undoLabel: 'Annuler', onUndo: () => store.undo(), duration: 9000 }); haptic([20, 40, 20]); });
      });
    }

    const tile = (ic, title, sub, onclick, cls = '') => h('button', { class: `st-tile ${cls}`, type: 'button', onclick }, h('span', { class: 'st-tile__ic' }, icon(ic, { size: 22 })), h('span', { class: 'st-tile__t' }, h('strong', null, title), h('small', null, sub)));
    const dataCard = card('donnees', 'Tes données', 'Tout vit dans ton navigateur, sur cet appareil.', 'download',
      h('div', { class: 'st-size' }, h('div', null, h('span', { class: 'stat__label' }, 'Taille des données'), sizeEl), countsEl),
      h('div', { class: 'st-tiles' },
        tile('download', 'Exporter', 'Fichier JSON, lisible', exportJson),
        tile('upload', 'Importer', 'Depuis un fichier JSON', () => fileJson.click()),
        tile('lock', 'Exporter chiffré', 'Protégé par mot de passe', exportEncrypted, 'st-tile--night'),
        tile('unlock', 'Importer chiffré', 'Fichier .kairos', importEncrypted, 'st-tile--night')),
      fileJson, dataMsg,
      h('hr', { class: 'sep' }),
      h('div', { class: 'st-tiles st-tiles--2' },
        tile('sparkle', 'Charger la démo', 'Un mois fictif pour explorer', loadDemo, 'st-tile--sun'),
        tile('trash', 'Tout effacer', 'Remet Kairos à zéro', eraseAll, 'st-tile--danger')));

    // ---------------------------------------------------------------------------------------
    // Installation (PWA)
    // ---------------------------------------------------------------------------------------
    const installHost = h('div', { class: 'st-install' });
    const installCard = card('installer', 'Installer Kairos', 'Comme une vraie appli, même sans réseau.', 'smartphone', installHost);
    function paintInstall() {
      const standalone = (matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
      const ua = navigator.userAgent || '', ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const android = /Android/.test(ua), firefox = /Firefox/.test(ua);
      const offline = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
      const canInstall = typeof ctx.canInstall === 'function' && ctx.canInstall();
      const rows = [];
      rows.push(h('div', { class: 'st-chips' }, h('span', { class: `chip ${standalone ? 'chip--night' : ''}` }, icon(standalone ? 'check-circle' : 'smartphone', { size: 15 }), standalone ? 'Installée' : 'Dans le navigateur'), h('span', { class: `chip ${offline ? 'chip--sun' : ''}` }, icon(offline ? 'wifi-off' : 'info', { size: 15 }), offline ? 'Prête hors-ligne' : 'Hors-ligne après le 1er chargement')));
      if (standalone) rows.push(h('p', { class: 'small muted' }, 'Tu utilises déjà Kairos comme une application. Elle fonctionne sans connexion.'));
      else if (canInstall) rows.push(h('button', { class: 'btn btn--primary btn--lg', type: 'button', onclick: async () => { haptic(10); await ctx.install(); paintInstall(); } }, icon('download', { size: 20 }), 'Installer Kairos'), h('p', { class: 'small muted' }, 'Une icône sur ton écran d\'accueil, un lancement plein écran, et tout reste en local.'));
      else {
        const steps = ios ? ['Touche le bouton Partager de Safari (le carré avec la flèche).', 'Fais défiler et choisis « Sur l\'écran d\'accueil ».', 'Valide avec « Ajouter ».']
          : android || firefox ? ['Ouvre le menu du navigateur (⋮).', 'Choisis « Installer l\'application » ou « Ajouter à l\'écran d\'accueil ».', 'Confirme : Kairos apparaît avec tes autres applis.']
            : ['Cherche l\'icône d\'installation à droite de la barre d\'adresse (Chrome, Edge), ou ouvre le menu du navigateur.', 'Choisis « Installer Kairos ».', 'Sur Safari (Mac) : Fichier, puis « Ajouter au Dock ».'];
        rows.push(h('p', { class: 'small muted' }, 'Ton navigateur ne propose pas l\'installation en un clic pour l\'instant. Voici comment faire à la main :'), h('ol', { class: 'st-steps' }, ...steps.map((s, i) => h('li', null, h('span', { class: 'st-steps__n num' }, String(i + 1)), h('span', null, s)))));
      }
      replaceChildren(installHost, ...rows);
    }
    const onInstallEvt = () => setTimeout(paintInstall, 50);
    window.addEventListener('beforeinstallprompt', onInstallEvt); window.addEventListener('appinstalled', onInstallEvt);
    cleanups.push(() => { window.removeEventListener('beforeinstallprompt', onInstallEvt); window.removeEventListener('appinstalled', onInstallEvt); });

    // ---------------------------------------------------------------------------------------
    // Raccourcis
    // ---------------------------------------------------------------------------------------
    const mod = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? '⌘' : 'Ctrl';
    const keys = [
      [[mod, 'K'], 'Palette de commandes'], [['N'], 'Nouvelle tâche'], [['C'], 'Café rapide (80 mg)'], [['/'], 'Rechercher'],
      [['g', 't'], 'Aujourd\'hui'], [['g', 'p'], 'Plan'], [['g', 'l'], 'Labo'], [['g', 's'], 'Sommeil'], [['g', 'v'], 'Voyage'], [['g', 'b'], 'Bilan'], [['g', 'r'], 'Réglages'], [['g', 'c'], 'La science'],
      [['⇧', 'T'], 'Voyage dans le temps'], [[mod, 'Z'], 'Annuler'], [[mod, '⇧', 'Z'], 'Rétablir'], [['?'], 'Aide'], [['Échap'], 'Fermer'],
    ];
    const keysCard = card('raccourcis', 'Raccourcis clavier', 'Pour aller vite quand tu as un clavier.', 'keyboard',
      h('ul', { class: 'st-keys' }, ...keys.map(([k, l]) => h('li', null, h('span', { class: 'st-keys__k' }, ...k.map((x, i) => [i ? h('span', { class: 'st-keys__plus', 'aria-hidden': 'true' }, k[0] === 'g' ? 'puis' : '+') : null, h('kbd', { class: 'kbd' }, x)]).flat()), h('span', { class: 'muted' }, l)))),
      typeof ctx.openHelp === 'function' ? h('button', { class: 'btn btn--ghost btn--sm st-keys__help', type: 'button', onclick: () => ctx.openHelp() }, icon('keyboard', { size: 16 }), 'Ouvrir l\'aide rapide') : null);

    // ---------------------------------------------------------------------------------------
    // À propos
    // ---------------------------------------------------------------------------------------
    const aboutCard = h('section', { class: 'card card--glow st-card st-about', id: `${uid}-apropos`, 'aria-labelledby': `${uid}-ap-t` },
      h('div', { class: 'st-about__mark', 'aria-hidden': 'true' }, aboutMark()),
      h('h3', { class: 'h2', id: `${uid}-ap-t` }, 'Kairos ', h('span', { class: 'st-ver num' }, `v${VERSION}`)),
      h('p', { class: 'lead' }, 'L\'emploi du temps de ton cerveau : une courbe d\'énergie calculée à partir de ton sommeil, de ton horloge interne et de ta caféine, pour mettre chaque tâche au bon moment.'),
      h('div', { class: 'st-privacy' }, icon('shield', { size: 22 }), h('p', null, h('strong', null, 'Local, hors-ligne, sans compte.'), ' Aucune donnée ne quitte ton appareil : pas de serveur, pas de pistage, pas de statistiques d\'usage.')),
      h('p', { class: 'small muted' }, 'Kairos est un outil de confort et d\'organisation, pas un dispositif médical. Il ne diagnostique rien et ne remplace pas l\'avis d\'un professionnel de santé.'),
      h('div', { class: 'row row--wrap' }, h('a', { class: 'btn btn--primary', href: '#/science' }, icon('brain', { size: 18 }), 'Comprendre le modèle'), h('a', { class: 'btn btn--ghost', href: '#/science' }, 'Limites et références', icon('arrow-right', { size: 16 }))));

    // ---------------------------------------------------------------------------------------
    // Assemblage
    // ---------------------------------------------------------------------------------------
    root.append(hero, quick,
      h('div', { class: 'st-cols' },
        h('div', { class: 'st-col' }, profileCard, modelCard),
        h('div', { class: 'st-col' }, prefsCard, dataCard, installCard)),
      h('div', { class: 'st-cols' }, keysCard, aboutCard));

    // ---------------------------------------------------------------------------------------
    // Synchronisation
    // ---------------------------------------------------------------------------------------
    function paintLive() {
      const p = profile(), wake = hhmmToMin(p.usualWake) ?? 420, bed = hhmmToMin(p.usualBed) ?? 1380, need = p.sleepNeedH || 8;
      const sleepMin = durMin(bed, wake);
      dial.update({ wake, bed, ws: hhmmToMin(p.workStart), we: hhmmToMin(p.workEnd), sleepMin, needMin: need * 60, workDays: p.workDays || [] });
      const gap = sleepMin - need * 60;
      replaceChildren(heroStats,
        h('span', { class: 'chip chip--night' }, icon('moon', { size: 15 }), `${fmtDur(sleepMin)} de sommeil prévu`),
        h('span', { class: `chip ${Math.abs(gap) < 20 ? 'chip--sun' : gap < 0 ? 'chip--coral' : 'chip--night'}` }, icon(gap < -20 ? 'alert' : 'check', { size: 15 }), Math.abs(gap) < 20 ? 'Pile ton besoin' : gap < 0 ? `${fmtDur(-gap)} sous ton besoin` : `${fmtDur(gap)} au-dessus de ton besoin`));
      undoBtn.disabled = !store.canUndo(); redoBtn.disabled = !store.canRedo();
      undoBtn.classList.toggle('is-off', undoBtn.disabled); redoBtn.classList.toggle('is-off', redoBtn.disabled);
    }
    let lastFitKey = '';
    const refresh = () => {
      paintLive(); paintSize();
      const fk = JSON.stringify([profile().fit, profile().chronoShiftMin, ctx.state.checkins.length]);
      if (fk !== lastFitKey) { lastFitKey = fk; paintModel(); }
      syncAll();
    };
    refresh();
    paintInstall();
    const off = ctx.subscribe(refresh);
    cleanups.push(off, () => dial.destroy());
    return () => { for (const c of cleanups.splice(0)) { try { c(); } catch { /* nettoyage best effort */ } } };
  },
};

// ---------------------------------------------------------------------------------------------
// Cadran 24 h du héros : sommeil (bleu-vert), travail (or), minuit en bas, midi en haut
// ---------------------------------------------------------------------------------------------
function buildDial() {
  const C = 100, ang = (min) => (min / 1440) * 360 + 90, gid = uniqueId('dl');
  const pol = (min, r) => { const a = (ang(min) * Math.PI) / 180; return [C + r * Math.cos(a), C + r * Math.sin(a)]; };
  const ticks = [];
  for (let i = 0; i < 96; i++) { const big = i % 4 === 0, a = ((i / 96) * 360 + 90) * Math.PI / 180, r1 = 96, r2 = big ? 90 : 93; ticks.push(svg('line', { class: big ? 'st-dial__tick st-dial__tick--big' : 'st-dial__tick', x1: C + Math.cos(a) * r1, y1: C + Math.sin(a) * r1, x2: C + Math.cos(a) * r2, y2: C + Math.sin(a) * r2 })); }
  const labels = [[0, '0 h'], [360, '6 h'], [720, '12 h'], [1080, '18 h']].map(([m, t]) => { const [x, y] = pol(m, 61); return svg('text', { class: 'st-dial__lbl', x, y: y + 2.6, 'text-anchor': 'middle' }, t); });
  const sleep = svg('path', { class: 'st-dial__sleep', fill: 'none', 'stroke-width': 13, 'stroke-linecap': 'round' });
  const work = svg('path', { class: 'st-dial__work', fill: 'none', 'stroke-width': 4, 'stroke-linecap': 'round' });
  const awake = svg('path', { class: 'st-dial__awake', fill: 'none', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-dasharray': '.5 5' });
  const bedDot = svg('g', { class: 'st-dial__h st-dial__h--bed' }, svg('circle', { r: 11 }), svg('path', { d: 'M-3.6-3.4a4.6 4.6 0 1 0 6 6 3.6 3.6 0 0 1-6-6z', class: 'st-dial__g' }));
  const wakeDot = svg('g', { class: 'st-dial__h st-dial__h--wake' }, svg('circle', { r: 11 }), svg('circle', { r: 3.2, class: 'st-dial__g' }), svg('path', { d: 'M0-6.6v1.8M0 4.8v1.8M-6.6 0h1.8M4.8 0h1.8', class: 'st-dial__g st-dial__g--l' }));
  const big = svg('text', { class: 'st-dial__big', x: C, y: C + 4, 'text-anchor': 'middle' }, '8 h');
  const sub = svg('text', { class: 'st-dial__sub', x: C, y: C + 22, 'text-anchor': 'middle' }, 'DE SOMMEIL');
  const sub2 = svg('text', { class: 'st-dial__sub2', x: C, y: C + 36, 'text-anchor': 'middle' }, '');
  const el = svg('svg', { class: 'st-dial', viewBox: '0 0 200 200', role: 'img', 'aria-label': 'Cadran de 24 heures de ton rythme' },
    svg('defs', null, svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--night)' }), svg('stop', { offset: '1', 'stop-color': 'var(--night-deep)' }))),
    svg('circle', { class: 'st-dial__disc', cx: C, cy: C, r: 88 }), ...ticks, svg('circle', { class: 'st-dial__ring', cx: C, cy: C, r: 70, fill: 'none', 'stroke-width': 13 }), awake, sleep, work, ...labels, bedDot, wakeDot, big, sub, sub2);
  sleep.setAttribute('stroke', `url(#${gid})`);
  let shown = 0, raf = 0;
  return {
    el,
    update({ wake, bed, ws, we, sleepMin, needMin, workDays }) {
      sleep.setAttribute('d', arc(C, C, 70, ang(bed), ang(wake)));
      awake.setAttribute('d', arc(C, C, 70, ang(wake), ang(bed)));
      if (ws !== null && we !== null && ws !== we) { work.setAttribute('d', arc(C, C, 90.5, ang(ws), ang(we))); work.style.display = ''; } else work.style.display = 'none';
      const [bx, by] = pol(bed, 70), [wx, wy] = pol(wake, 70);
      bedDot.setAttribute('transform', `translate(${bx} ${by})`); wakeDot.setAttribute('transform', `translate(${wx} ${wy})`);
      cancelAnimationFrame(raf);
      const to = sleepMin, from = shown || to, t0 = performance.now();
      const fmtH = (m) => { const mm = Math.round(m), hh = Math.floor(mm / 60), r = mm % 60; return r ? `${hh} h ${pad(r)}` : `${hh} h`; };
      const step = (now) => { const k = prefersReducedMotion() ? 1 : Math.min(1, (now - t0) / 500); shown = from + (to - from) * (1 - Math.pow(1 - k, 3)); big.textContent = fmtH(shown); if (k < 1) raf = requestAnimationFrame(step); };
      raf = requestAnimationFrame(step);
      sub2.textContent = `${minToHHMM(bed)} → ${minToHHMM(wake)}`;
      el.setAttribute('aria-label', `Cadran de 24 heures : sommeil de ${minToHHMM(bed)} à ${minToHHMM(wake)}, soit ${fmtH(sleepMin)}${ws !== null ? `, travail de ${minToHHMM(ws)} à ${minToHHMM(we)}` : ''}. Besoin de sommeil : ${fmtH(needMin)}.`);
      void workDays;
    },
    destroy() { cancelAnimationFrame(raf); },
  };
}

function aboutMark() {
  const gid = uniqueId('am');
  return svg('svg', { viewBox: '0 0 64 64', width: 72, height: 72, 'aria-hidden': 'true', focusable: 'false' },
    svg('defs', null, svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' }, svg('stop', { offset: '0', 'stop-color': '#ffe190' }), svg('stop', { offset: '.55', 'stop-color': '#f7b93e' }), svg('stop', { offset: '1', 'stop-color': '#e9822a' }))),
    svg('circle', { cx: 32, cy: 32, r: 29.5, fill: 'none', stroke: `url(#${gid})`, 'stroke-width': 1.6, 'stroke-dasharray': '.8 3.6', 'stroke-linecap': 'round', opacity: '.8' }),
    svg('path', { d: 'M23 17v30M24 35l13-14M29 33l12 14', fill: 'none', stroke: 'currentColor', 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    svg('circle', { cx: 42.5, cy: 16.5, r: 5.4, fill: `url(#${gid})` }));
}
