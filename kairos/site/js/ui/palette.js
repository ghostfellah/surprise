// Palette de commandes (Ctrl/Cmd+K) : recherche floue sur la navigation et les actions rapides,
// plus analyse de saisie rapide (parseEntry) : « Finir le rapport 2h avant vendredi 17h » -> « Créer la tâche… ».
import { h, icon, uniqueId, fmt } from './dom.js';
import { openModal } from './modal.js';
import { fmtTime, fmtDuration, fmtDateFR, startOfDay, MIN } from '../core/time.js';

// --- chargement paresseux de l'analyseur (tolère son absence) ---
let nlpPromise = null;
export function loadNlp() { return (nlpPromise ||= import('../core/nlp-fr.js').catch(() => null)); }

// ---------------------------------------------------------------------------
// Recherche floue (pure, testable)
// ---------------------------------------------------------------------------
/** minuscules sans accents, longueur conservée (les indices restent valables pour l'original). */
export function fold(s) {
  return Array.from(String(s || '')).map((c) => { const f = c.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); return f[0] || c; }).join('');
}

function scoreToken(q, t) {
  const pos = t.indexOf(q);
  if (pos >= 0) {
    const wordStart = pos === 0 || /[\s\-:'’/(]/.test(t[pos - 1]);
    return { score: 100 - Math.min(pos, 40) * .6 + (pos === 0 ? 24 : 0) + (wordStart ? 16 : 0) - (t.length - q.length) * .15, idx: Array.from({ length: q.length }, (_, i) => pos + i) };
  }
  // sous-séquence : chaque lettre dans l'ordre, bonus début de mot / consécutif
  const idx = []; let ti = 0, score = 0, prev = -2;
  for (const ch of q) {
    const j = t.indexOf(ch, ti); if (j < 0) return null;
    score += 8 + (j === prev + 1 ? 9 : 0) + (j === 0 || /[\s\-:'’/(]/.test(t[j - 1]) ? 10 : 0) - Math.min(6, j - ti) * .5;
    idx.push(j); prev = j; ti = j + 1;
  }
  return { score: score - (t.length - q.length) * .1, idx };
}

/** Score flou de `query` dans `text` -> { score, idx } | null. Tous les mots de la requête doivent correspondre. */
export function fuzzyScore(query, text) {
  const q = fold(query).trim(), t = fold(text);
  if (!q) return { score: 0, idx: [] };
  let total = 0; const all = new Set();
  for (const tok of q.split(/\s+/)) { const r = scoreToken(tok, t); if (!r) return null; total += r.score; r.idx.forEach((i) => all.add(i)); }
  return { score: total, idx: [...all].sort((a, b) => a - b) };
}

/** Texte avec les lettres trouvées en <mark>. */
export function highlight(text, idx) {
  if (!idx || !idx.length) return [text];
  const set = new Set(idx), out = []; let buf = '', on = false; const chars = Array.from(text);
  chars.forEach((c, i) => { const m = set.has(i); if (m !== on) { if (buf) out.push(on ? h('mark', null, buf) : buf); buf = ''; on = m; } buf += c; });
  if (buf) out.push(on ? h('mark', null, buf) : buf);
  return out;
}

// ---------------------------------------------------------------------------
// Saisie rapide : jetons, résumé, création (partagés avec la feuille « saisie rapide »)
// ---------------------------------------------------------------------------
/** Texte saisi avec ses jetons surlignés (.tok .tok--type). */
export function renderTokens(text, tokens = []) {
  const toks = [...tokens].sort((a, b) => a.start - b.start), out = []; let pos = 0;
  for (const t of toks) {
    if (t.start < pos) continue;
    if (t.start > pos) out.push(text.slice(pos, t.start));
    out.push(h('span', { class: `tok tok--${t.type}`, title: t.type }, text.slice(t.start, t.end))); pos = t.end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

const LOAD_LABELS = ['', 'Routine', 'Léger', 'Soutenu', 'Exigeant', 'Concentration profonde'];
const PRIO_LABELS = ['', 'Urgent', 'Important', 'Normal', 'Un jour'];
export { LOAD_LABELS, PRIO_LABELS };

const dayWord = (ms, now) => { const d = Math.round((startOfDay(ms) - startOfDay(now)) / 86400000); return d === 0 ? 'aujourd\'hui' : d === 1 ? 'demain' : fmt.dateShort(ms); };

/** Résumé lisible d'une saisie analysée : [{ type, text }]. */
export function describeEntry(p, now = Date.now()) {
  const out = [];
  if (!p) return out;
  if (p.kind === 'event') {
    if (p.startMs) out.push({ type: 'date', text: `${dayWord(p.startMs, now)} ${fmtTime(p.startMs)}${p.endMs ? `–${fmtTime(p.endMs)}` : ''}` });
  } else {
    if (p.durMin) out.push({ type: 'duration', text: fmtDuration(p.durMin) });
    if (p.load) out.push({ type: 'load', text: `charge ${p.load}` });
    if (p.priority) out.push({ type: 'priority', text: PRIO_LABELS[p.priority] || `P${p.priority}` });
    if (p.deadlineMs) out.push({ type: 'date', text: `avant ${dayWord(p.deadlineMs, now)} ${fmtTime(p.deadlineMs)}` });
    if (p.earliestMs) out.push({ type: 'date', text: `dès ${dayWord(p.earliestMs, now)} ${fmtTime(p.earliestMs)}` });
  }
  for (const t of p.tags || []) out.push({ type: 'tag', text: `#${t}` });
  return out;
}

/** Crée la tâche/l'événement décrit par `parsed` ; retourne l'objet créé. */
export function createFromParsed(ctx, parsed, now = ctx.nowMs()) {
  const a = ctx.actions;
  if (parsed.kind === 'event' && parsed.startMs) {
    return { kind: 'event', item: a.addEvent({ title: parsed.title, startMs: parsed.startMs, endMs: parsed.endMs || parsed.startMs + 60 * MIN, source: 'manual' }) };
  }
  const partial = { title: parsed.title, durMin: parsed.durMin || 30, load: parsed.load || 3, priority: parsed.priority || 3, tags: parsed.tags || [] };
  if (parsed.deadlineMs) partial.deadlineMs = parsed.deadlineMs;
  if (parsed.earliestMs) partial.earliestMs = parsed.earliestMs;
  return { kind: 'task', item: a.addTask(partial) };
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------
export const NAV = [
  { id: 'today', title: "Aujourd'hui", icon: 'sun', key: 't', words: 'jour accueil maintenant énergie courbe' },
  { id: 'plan', title: 'Plan', icon: 'calendar', key: 'p', words: 'planning semaine agenda tâches' },
  { id: 'lab', title: 'Labo', icon: 'flask', key: 'l', words: 'simulateur et si expériences caféine' },
  { id: 'sleep', title: 'Sommeil', icon: 'moon', key: 's', words: 'nuit dormir sieste dette coucher' },
  { id: 'travel', title: 'Voyage', icon: 'plane', key: 'v', words: 'décalage horaire jetlag fuseau' },
  { id: 'insights', title: 'Bilan', icon: 'chart', key: 'b', words: 'statistiques tendances analyse résumé semaine' },
  { id: 'settings', title: 'Réglages', icon: 'gear', key: 'r', words: 'préférences profil thème export données' },
  { id: 'science', title: 'La science', icon: 'book', key: 'c', words: 'modèle borbély méthode comprendre sources limites' },
];

const COFFEES = [
  { label: 'Nouveau café', mg: 80, kind: 'café', icon: 'coffee', words: 'caféine boire tasse' },
  { label: 'Expresso', mg: 65, kind: 'expresso', icon: 'coffee', words: 'caféine court' },
  { label: 'Thé', mg: 40, kind: 'thé', icon: 'leaf', words: 'caféine tasse' },
  { label: 'Boisson énergisante', mg: 80, kind: 'boisson énergisante', icon: 'zap', words: 'caféine canette' },
];

function buildCommands(ctx) {
  const st = ctx.state, now = ctx.nowMs(), cmds = [];
  for (const n of NAV) cmds.push({ id: `nav-${n.id}`, group: 'Aller à', label: n.title, hint: 'Navigation', kbd: ['g', n.key], icon: n.icon, words: n.words, run: () => ctx.navigate(`#/${n.id}`) });
  for (const c of COFFEES) cmds.push({
    id: `coffee-${c.kind}`, group: 'Actions rapides', label: `${c.label} · ${c.mg} mg`, hint: c.kind === 'café' ? 'Ajoute une prise de caféine maintenant' : 'Caféine maintenant', icon: c.icon, words: `${c.words} cafe`, kbd: c.kind === 'café' ? ['c'] : null,
    run: () => { ctx.actions.logCaffeine({ tMs: ctx.nowMs(), mg: c.mg, kind: c.kind }); ctx.toast(`${c.label} enregistré · ${c.mg} mg`, { undoLabel: 'Annuler', onUndo: () => ctx.store.undo() }); },
  });
  cmds.push(
    { id: 'add-task', group: 'Actions rapides', label: 'Ajouter une tâche', hint: 'Éditeur complet', icon: 'plus', words: 'nouvelle créer todo', kbd: ['n'], run: () => ctx.openTaskEditor() },
    { id: 'quick-add', group: 'Actions rapides', label: 'Saisie rapide…', hint: 'Écris en langage naturel', icon: 'wand', words: 'ajout rapide texte nlp', run: () => ctx.openQuickAdd() },
    { id: 'checkin', group: 'Actions rapides', label: 'Noter mon énergie', hint: 'Check-in : comment te sens-tu ?', icon: 'heart', words: 'check-in ressenti humeur alerte fatigue', run: () => ctx.openCheckIn && ctx.openCheckIn() },
    {
      id: 'plan-week', group: 'Actions rapides', label: 'Planifier ma semaine', hint: 'Place chaque tâche au meilleur moment', icon: 'sparkle', words: 'optimiser planificateur agenda auto',
      run: () => {
        const prev = ctx.state.plan; const res = ctx.runPlanner();
        ctx.applyPlan(res); ctx.navigate('#/plan');
        const un = (res.unplaced || []).length;
        ctx.toast(un ? `Semaine planifiée · ${un} tâche${un > 1 ? 's' : ''} sans créneau` : 'Semaine planifiée', { kind: un ? 'warn' : 'ok', undoLabel: 'Annuler', onUndo: () => ctx.actions.setPlan(prev) });
      },
    },
    { id: 'review', group: 'Actions rapides', label: 'Bilan', hint: 'Tendances et enseignements', icon: 'chart-line', words: 'statistiques résumé semaine insights', run: () => ctx.navigate('#/insights') },
    { id: 'focus-25', group: 'Actions rapides', label: 'Lancer un focus · 25 min', hint: 'Minuteur plein écran', icon: 'timer', words: 'pomodoro concentration minuteur', run: () => ctx.startFocus({ minutes: 25 }) },
    { id: 'focus-50', group: 'Actions rapides', label: 'Lancer un focus · 50 min', hint: 'Minuteur plein écran', icon: 'timer', words: 'pomodoro concentration minuteur', run: () => ctx.startFocus({ minutes: 50 }) },
    { id: 'log-sleep', group: 'Actions rapides', label: 'Enregistrer ma nuit', hint: 'Heures de coucher et de lever', icon: 'bed', words: 'sommeil dormi sieste', run: () => ctx.navigate('#/sleep') },
  );
  for (const [theme, label, ic] of [['auto', 'Automatique', 'sparkle'], ['light', 'Clair', 'sun'], ['dark', 'Sombre', 'moon']]) {
    if (st.prefs && st.prefs.theme === theme) continue;
    cmds.push({ id: `theme-${theme}`, group: 'Apparence', label: `Thème : ${label}`, hint: 'Apparence de l\'app', icon: ic, words: 'mode couleur', run: () => ctx.actions.setPrefs({ theme }) });
  }
  cmds.push({ id: 'time-travel', group: 'Outils', label: 'Voyage dans le temps', hint: 'Décale l\'horloge de l\'app (démo)', icon: 'history', words: 'horloge démo simuler date heure', kbd: ['⇧', 'T'], run: () => ctx.toggleTimeTravel && ctx.toggleTimeTravel() });
  cmds.push({ id: 'help', group: 'Outils', label: 'Raccourcis clavier', hint: 'Aide', icon: 'keyboard', words: 'aide clavier touches', kbd: ['?'], run: () => ctx.openHelp && ctx.openHelp() });
  if (ctx.store.canUndo()) cmds.push({ id: 'undo', group: 'Outils', label: 'Annuler la dernière action', hint: 'Ctrl+Z', icon: 'undo', words: 'défaire retour', run: () => { ctx.store.undo(); ctx.toast('Annulé', { kind: 'ok' }); } });
  if (ctx.store.canRedo()) cmds.push({ id: 'redo', group: 'Outils', label: 'Rétablir', hint: 'Ctrl+Maj+Z', icon: 'redo', words: 'refaire', run: () => { ctx.store.redo(); ctx.toast('Rétabli', { kind: 'ok' }); } });
  if (ctx.canInstall && ctx.canInstall()) cmds.push({ id: 'install', group: 'Outils', label: 'Installer l\'application', hint: 'Ajouter Kairos à l\'écran d\'accueil', icon: 'download', words: 'pwa installer', run: () => ctx.install() });
  for (const t of (st.tasks || []).filter((x) => !x.done).slice(0, 60)) {
    cmds.push({ id: `task-${t.id}`, group: 'Tâches', label: t.title, hint: `Modifier · ${fmtDuration(t.durMin || 30)} · charge ${t.load || 3}`, icon: 'list', words: '', onlyQuery: true, run: () => ctx.openTaskEditor(t.id) });
    cmds.push({ id: `focus-${t.id}`, group: 'Tâches', label: `Focus : ${t.title}`, hint: `Minuteur de ${Math.min(50, t.durMin || 25)} min`, icon: 'timer', words: '', onlyQuery: true, run: () => ctx.startFocus({ taskId: t.id, minutes: Math.min(50, t.durMin || 25) }) });
  }
  void now;
  return cmds;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------
/** Ouvre la palette ; `initial` pré-remplit la recherche. Retourne le handle de modale. */
export function openPalette(ctx, { initial = '' } = {}) {
  const listId = uniqueId('pal-list'); let results = [], sel = 0, nlp = null;
  loadNlp().then((m) => { nlp = m; if (input && input.isConnected) refresh(); });
  const input = h('input', { class: 'palette__input', type: 'text', placeholder: 'Que veux-tu faire ? Tape une commande ou une tâche…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list', 'aria-label': 'Rechercher une commande' });
  input.value = initial;
  const list = h('div', { class: 'palette__list', id: listId, role: 'listbox', 'aria-label': 'Résultats' });
  const foot = h('div', { class: 'palette__foot' },
    h('span', null, h('span', { class: 'kbd' }, '↑'), h('span', { class: 'kbd' }, '↓'), 'naviguer'), h('span', null, h('span', { class: 'kbd' }, '↵'), 'valider'), h('span', null, h('span', { class: 'kbd' }, 'esc'), 'fermer'),
    h('span', { class: 'hide-sm', style: { marginLeft: 'auto' } }, 'Astuce : « Finir le rapport 2h avant vendredi 17h »'));
  const root = h('div', { class: 'palette' }, h('div', { class: 'palette__search' }, icon('search', { size: 22 }), input), list, foot);
  const handle = openModal({ kind: 'palette', raw: true, ariaLabel: 'Palette de commandes', content: root, initialFocus: input });
  let cmds = [];

  function compute() {
    const q = input.value.trim(); cmds = buildCommands(ctx); const out = [];
    if (!q) { for (const c of cmds) if (!c.onlyQuery) out.push({ ...c, idx: [] }); return out.slice(0, 14); }
    for (const c of cmds) {
      const a = fuzzyScore(q, c.label), b = c.words ? fuzzyScore(q, c.words) : null, g = fuzzyScore(q, c.group);
      const best = a ? a.score : b ? b.score * .55 : g ? g.score * .3 : -1; if (best < 0) continue;
      out.push({ ...c, idx: a ? a.idx : [], _s: best + (c.onlyQuery ? -6 : 0) });
    }
    out.sort((x, y) => y._s - x._s);
    const top = out.slice(0, 9);
    // analyse de la saisie : création de tâche / d'événement
    if (nlp && q.length >= 3 && /\S+\s+\S+|\S{4,}/.test(q)) {
      let parsed = null; try { parsed = nlp.parseEntry(q, ctx.nowMs()); } catch { /* ignoré */ }
      if (parsed && parsed.title) {
        const strong = (parsed.tokens || []).some((t) => t.type !== 'load'), summary = describeEntry(parsed, ctx.nowMs());
        const item = { id: 'create', group: 'Créer', create: true, parsed, icon: parsed.kind === 'event' ? 'calendar' : 'plus', label: `${parsed.kind === 'event' ? 'Créer l\'événement' : 'Créer la tâche'} : ${parsed.title}`, summary, tokens: parsed.tokens || [], text: q, idx: [], run: () => {
          const r = createFromParsed(ctx, parsed); ctx.toast(`${r.kind === 'event' ? 'Événement' : 'Tâche'} ajouté${r.kind === 'event' ? '' : 'e'} : ${parsed.title}`, { undoLabel: 'Annuler', onUndo: () => ctx.store.undo() });
        } };
        if (!top.length || top[0]._s < 40 || (strong && top[0]._s < 90)) top.unshift(item); else top.push(item);
      }
    }
    return top;
  }

  function refresh() {
    results = compute(); sel = Math.min(sel, Math.max(0, results.length - 1));
    list.replaceChildren(); let lastGroup = null;
    if (!results.length) { list.appendChild(h('div', { class: 'palette__empty' }, 'Aucun résultat. Essaie « café », « plan », « focus »…')); input.removeAttribute('aria-activedescendant'); return; }
    results.forEach((r, i) => {
      if (r.group !== lastGroup) { lastGroup = r.group; list.appendChild(h('div', { class: 'palette__group eyebrow', role: 'presentation' }, r.group)); }
      const id = `${listId}-${i}`;
      const hint = r.create ? h('span', { class: 'entry-preview' }, ...r.summary.map((s) => h('span', { class: `tok tok--${s.type}` }, s.text)), r.summary.length ? null : h('span', null, 'Entrée pour ajouter à ta liste')) : r.hint;
      const el = h('button', { type: 'button', class: 'palette__item', id, role: 'option', 'aria-selected': i === sel ? 'true' : 'false', tabindex: '-1', onclick: () => choose(i), onpointermove: () => { if (sel !== i) select(i, false); } },
        h('span', { class: 'palette__ico' }, icon(r.icon || 'sparkle', { size: 18 })),
        h('span', { class: 'palette__main' }, h('span', { class: 'palette__label' }, ...highlight(r.label, r.idx)), hint ? h('span', { class: 'palette__hint' }, hint) : null),
        r.kbd ? h('span', { class: 'row', style: { '--gap': '4px' } }, ...r.kbd.map((k) => h('span', { class: 'kbd' }, k))) : null);
      list.appendChild(el);
    });
    input.setAttribute('aria-activedescendant', `${listId}-${sel}`);
  }
  function select(i, scroll = true) {
    if (!results.length) return; sel = (i + results.length) % results.length;
    list.querySelectorAll('.palette__item').forEach((el, k) => el.setAttribute('aria-selected', k === sel ? 'true' : 'false'));
    const el = list.querySelector(`#${listId}-${sel}`); input.setAttribute('aria-activedescendant', `${listId}-${sel}`);
    if (el && scroll) el.scrollIntoView({ block: 'nearest' });
  }
  function choose(i) { const r = results[i]; if (!r) return; handle.close(r); }
  handle.closed.then((r) => { if (r && r.run) { try { r.run(); } catch (e) { console.error(e); ctx.toast('Cette action a échoué', { kind: 'err' }); } } });

  input.addEventListener('input', () => { sel = 0; refresh(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(sel - 1); }
    else if (e.key === 'Home' && !input.value) { e.preventDefault(); select(0); }
    else if (e.key === 'End' && !input.value) { e.preventDefault(); select(results.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
  });
  refresh();
  return handle;
}
