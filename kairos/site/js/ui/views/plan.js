// Vue « Planning » de Kairos : saisie rapide, planificateur, semaine/jour à glisser-déposer, backlog,
// import/export .ics, statistiques. Tout le calcul « pur » vit dans ../plan-helpers.js (testé) ;
// ce fichier ne fait que dessiner et brancher les gestes.
//
// Choix de conception :
// - Le squelette est construit une fois ; chaque section se redessine seulement si sa « signature »
//   change (JSON des données utiles) → les ticks d'horloge ne reconstruisent rien, l'animation
//   d'assemblage n'est jamais interrompue.
// - Pendant un glisser-déposer on ne redessine pas (le bloc suit le pointeur par `transform`) ;
//   le rendu en attente part à la fin du geste.
// - Aperçu en direct : validateMove(…) à chaque case de 5 min survolée (mémoïsé), verdict dans un
//   bandeau fixe (le doigt ne le cache pas).
import { h, svg, icon, prefersReducedMotion, haptic, animateNumber, confetti, uniqueId } from '../dom.js';
import { openModal } from '../modal.js';
import { parseEntry } from '../../core/nlp-fr.js';
import { parseICS, buildICS } from '../../core/ics.js';
import { validateMove, explainBlock } from '../../core/scheduler.js';
import { MIN, HOUR, DAY, startOfDay, addDays, minutesOfDay, fmtTime, fmtDuration, fmtDateFR } from '../../core/time.js';
import * as P from '../plan-helpers.js';

const PPM = { week: 1, day: 1.15 }; // pixels par minute
const EXAMPLES = [
  'Finir le rapport 2h avant vendredi 17h #deep',
  'Appeler le comptable demain 20 min',
  'Réfléchir à la stratégie !! 1h30',
  'Déjeuner avec Paul jeudi 12h30',
  'Répondre aux mails ce soir',
];

// Mémoire de session (survit au changement d'écran) : dernier résultat du planificateur.
let lastRun = null; // { result, at, prevPlan }

// ───────────────────────── Utilitaires ─────────────────────────
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sig = (...parts) => JSON.stringify(parts);
const curves = new WeakMap();
const curveOf = (m) => { let c = curves.get(m); if (!c) { c = { t0: m.t0, stepMin: m.stepMin, alert: m.alert }; curves.set(m, c); } return c; };
const modelIds = new WeakMap(); let modelSeq = 0;
const modelId = (m) => { if (!m) return 0; let i = modelIds.get(m); if (!i) { i = ++modelSeq; modelIds.set(m, i); } return i; };
const pct = (x) => `${Math.round(x * 100)} %`;
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** replaceChildren natif qui ignore null/false (le natif écrirait « null »). */
const setKids = (el, ...kids) => { el.replaceChildren(...kids.filter((k) => k != null && k !== false)); return el; };

function ensureCss() {
  const href = new URL('css/views-plan.css', document.baseURI).href;
  if (Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((l) => l.href === href)) return;
  const link = h('link', { rel: 'stylesheet', href });
  link.onerror = () => link.remove();
  document.head.appendChild(link);
}

/** Visuel d'état vide : cadran solaire avec trois blocs qui s'y posent. */
function emptyArt() {
  const gid = uniqueId('pe');
  return svg('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true', focusable: 'false', width: 112, height: 112 },
    svg('defs', null, svg('linearGradient', { id: gid, x1: 0, y1: 0, x2: 1, y2: 1 }, svg('stop', { offset: 0, 'stop-color': 'var(--sun-hot)' }), svg('stop', { offset: 1, 'stop-color': 'var(--sun-deep)' }))),
    svg('g', { class: 'spin-slow' }, svg('circle', { cx: 60, cy: 60, r: 52, fill: 'none', stroke: `url(#${gid})`, 'stroke-width': 1.4, 'stroke-dasharray': '1 5.4', 'stroke-linecap': 'round', opacity: .8 })),
    svg('circle', { cx: 60, cy: 60, r: 36, fill: 'none', stroke: 'var(--line-strong)', 'stroke-width': 1 }),
    svg('path', { d: 'M24 60a36 36 0 0 1 72 0', fill: 'none', stroke: `url(#${gid})`, 'stroke-width': 3, 'stroke-linecap': 'round' }),
    svg('rect', { x: 34, y: 66, width: 28, height: 8, rx: 4, fill: 'var(--load-5)', opacity: .85 }),
    svg('rect', { x: 66, y: 66, width: 20, height: 8, rx: 4, fill: 'var(--load-2)', opacity: .85 }),
    svg('rect', { x: 44, y: 78, width: 34, height: 8, rx: 4, fill: 'var(--load-3)', opacity: .85 }),
    svg('circle', { cx: 60, cy: 38, r: 6, fill: `url(#${gid})` }));
}

/** Jauge de charge cognitive à 5 segments croissants. */
function loadGauge(load, { label = true } = {}) {
  const on = P.loadMeter(load);
  return h('span', { class: 'pl-gauge', style: { '--c': P.loadVar(load) }, role: 'img', 'aria-label': `Charge cognitive ${load} sur 5 : ${P.LOAD_NAMES[load] || ''}`, title: `Charge ${load}/5 · ${P.LOAD_NAMES[load] || ''}` },
    ...on.map((v, i) => h('i', { class: v ? 'is-on' : '', style: { '--n': i } })), label ? null : null);
}

/** Anneau de score (0..100) en SVG. */
function scoreRing(score, tone, size = 64) {
  const r = size / 2 - 5, c = 2 * Math.PI * r;
  return h('span', { class: `pl-ring pl-tone-${tone}`, style: { width: `${size}px`, height: `${size}px` } },
    svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true' },
      svg('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': 5, class: 'pl-ring__track' }),
      svg('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': 5, 'stroke-linecap': 'round', class: 'pl-ring__arc', 'stroke-dasharray': `${(c * Math.max(0, Math.min(100, score))) / 100} ${c}`, transform: `rotate(-90 ${size / 2} ${size / 2})` })),
    h('b', { class: 'pl-ring__n num' }, String(score)));
}

// ───────────────────────── Vue ─────────────────────────
export default {
  id: 'plan',
  title: 'Planning',
  icon: 'calendar',
  mount(root, ctx) {
    ensureCss();
    const { actions, store } = ctx;
    const toast = (m, o) => ctx.toast(m, o);
    const reduce = prefersReducedMotion;
    const mq = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)') : { matches: true, addEventListener() {}, removeEventListener() {} };
    const savedMode = lsGet('kairos.plan.mode', '');
    const narrowMq = typeof matchMedia === 'function' ? matchMedia('(max-width: 599px)') : { matches: false, addEventListener() {}, removeEventListener() {} };
    const S = {
      sel: 0, mode: savedMode === 'week' || savedMode === 'day' ? savedMode : (mq.matches ? 'week' : 'day'), userMode: !!savedMode,
      filter: lsGet('kairos.plan.filter', 'todo'), group: lsGet('kairos.plan.group', 'none'),
      busy: false, assemble: null, flashTask: null, landKey: null, focusKey: null, celebrate: false, dragging: false, pending: false,
      slide: null, sigs: {},
    };
    if (narrowMq.matches) S.mode = 'day';
    if (!P.FILTERS.some((f) => f.id === S.filter)) S.filter = 'todo';
    if (!P.GROUPS.some((g) => g.id === S.group)) S.group = 'none';
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
    let alive = true;

    // ─────────── Données dérivées ───────────
    function derive() {
      const st = ctx.state, nowMs = ctx.nowMs();
      const wk = P.viewDays(nowMs, S.sel, 'week');
      const days = S.mode === 'day' ? P.viewDays(nowMs, S.sel, 'day') : wk;
      let model = null;
      try { model = ctx.model({ fromMs: wk[0], hours: 168 }); } catch { model = null; }
      const blocks = (st.plan && st.plan.blocks) || [];
      return {
        st, nowMs, wk, days, model, curve: model ? curveOf(model) : null, blocks,
        tasksById: new Map(st.tasks.map((t) => [t.id, t])), ppm: PPM[S.mode],
        range: P.visibleRange({ profile: st.profile, blocks, events: st.events, days }),
      };
    }
    const vctx = (D) => ({ tasks: D.st.tasks, events: D.st.events, curve: D.curve, nowMs: D.nowMs, horizonEndMs: D.model ? D.model.t0 + 168 * HOUR : D.nowMs, profile: D.st.profile, blocks: D.blocks });
    const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
    const say = (m) => { live.textContent = ''; later(() => { live.textContent = m; }, 30); };

    // ═══════════════════════ 1. Saisie rapide ═══════════════════════
    const previewId = uniqueId('plqb');
    const input = h('input', { class: 'pl-qb__input', type: 'text', enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'false', maxlength: '200', 'aria-label': 'Ajouter une tâche ou un événement en langage naturel', 'aria-describedby': previewId, placeholder: EXAMPLES[0] });
    const mirror = h('div', { class: 'pl-qb__mirror', 'aria-hidden': 'true' });
    const goBtn = h('button', { class: 'pl-qb__go', type: 'button', 'aria-label': 'Ajouter', disabled: true }, icon('arrow-right', { size: 22, stroke: 2.2 }));
    const preview = h('div', { class: 'pl-qb__preview', id: previewId, role: 'status', 'aria-live': 'polite' });
    const qb = h('section', { class: 'card card--glow pl-qb', 'aria-label': 'Saisie rapide' },
      h('div', { class: 'pl-qb__field' }, h('span', { class: 'pl-qb__spark', 'aria-hidden': 'true' }, icon('wand', { size: 22 })), h('div', { class: 'pl-qb__wrap' }, mirror, input), goBtn),
      preview);
    let parsed = null;
    const syncMirror = () => { mirror.scrollLeft = input.scrollLeft; };
    function refreshEntry() {
      const text = input.value, now = ctx.nowMs();
      parsed = text.trim() ? parseEntry(text, now) : null;
      const segs = parsed ? P.tokenSegments(text, parsed.tokens || []) : [{ text, type: null }];
      mirror.replaceChildren(...segs.map((s) => (s.type ? h('span', { class: `pl-tk pl-tk--${s.type}` }, s.text) : s.text)));
      const d = parsed ? P.describeParsed(parsed, now) : null;
      goBtn.disabled = !(d && d.ok);
      qb.classList.toggle('is-ready', !!(d && d.ok));
      if (!d) {
        preview.replaceChildren(h('span', { class: 'pl-qb__hint' }, 'Écris comme tu parles : ', h('em', null, 'durée, échéance, charge'), ' sont comprises. ', h('kbd', { class: 'kbd' }, '↵'), ' pour créer · ', h('kbd', { class: 'kbd' }, '/'), ' pour revenir ici.'));
      } else if (!d.ok) {
        preview.replaceChildren(h('span', { class: 'pl-qb__hint' }, 'Il manque un titre…'));
      } else {
        preview.replaceChildren(
          h('span', { class: `pl-kind pl-kind--${d.kind}` }, icon(d.kind === 'event' ? 'calendar' : 'check-circle', { size: 14 }), d.label),
          h('strong', { class: 'pl-qb__title' }, d.title),
          ...d.parts.map((p) => h('span', { class: `pl-pchip pl-pchip--${p.type}` }, p.text)),
          h('span', { class: 'pl-qb__enter faint tiny hide-sm' }, h('kbd', { class: 'kbd' }, '↵'), ' créer'));
      }
      requestAnimationFrame(syncMirror);
    }
    function submitEntry() {
      const item = P.entryToItem(parsed);
      if (!item) { qb.classList.remove('is-shake'); void qb.offsetWidth; qb.classList.add('is-shake'); return; }
      try {
        if (item.kind === 'event') {
          const e = actions.addEvent(item.data);
          toast(`Événement ajouté · ${fmtDateFR(e.startMs, { short: false })} ${fmtTime(e.startMs)}`, { undoLabel: 'Annuler', onUndo: () => actions.removeEvent(e.id), icon: 'calendar' });
          S.sel = P.clampSel(Math.round((startOfDay(e.startMs) - startOfDay(ctx.nowMs())) / DAY));
        } else {
          const t = actions.addTask(item.data);
          S.flashTask = t.id; later(() => { S.flashTask = null; }, 2600);
          toast('Tâche ajoutée · place-la avec « Planifier »', { undoLabel: 'Annuler', onUndo: () => actions.removeTask(t.id), icon: 'check-circle' });
        }
        haptic(10);
        input.value = ''; refreshEntry();
      } catch (e) { toast(e.message || 'Impossible d\'ajouter', { kind: 'err' }); }
    }
    input.addEventListener('input', refreshEntry);
    input.addEventListener('scroll', syncMirror);
    input.addEventListener('keyup', syncMirror);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitEntry(); } else if (e.key === 'Escape') { input.value = ''; refreshEntry(); input.blur(); } });
    goBtn.addEventListener('click', () => { submitEntry(); input.focus(); });
    let exI = 0;
    const phTimer = setInterval(() => { if (document.activeElement !== input && !input.value) { exI = (exI + 1) % EXAMPLES.length; input.placeholder = EXAMPLES[exI]; } }, 4200);
    const onSlash = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('.overlay, .palette, .focus-screen')) return;
      e.preventDefault(); e.stopPropagation(); input.focus(); input.select();
    };
    window.addEventListener('keydown', onSlash, true); // en capture : la vue Planning prend « / » avant la palette

    // ═══════════════════════ 2. Planificateur & import/export ═══════════════════════
    const fileInput = h('input', { type: 'file', accept: '.ics,text/calendar', hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
    const goHint = h('span', { class: 'pl-go__hint' });
    const goBtnMain = h('button', { class: 'btn btn--primary btn--lg pl-go', type: 'button', onclick: () => planWeek() },
      h('span', { class: 'pl-go__orbit', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('span', { class: 'pl-go__ico' }, icon('sparkle', { size: 22 })), h('span', { class: 'pl-go__label' }, 'Planifier ma semaine'));
    const undoBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', hidden: true, 'aria-label': 'Annuler le dernier plan', onclick: () => undoPlan() }, icon('undo', { size: 16 }), 'Annuler');
    const icsChip = h('span', { class: 'pl-ics', hidden: true });
    const actionsBar = h('section', { class: 'pl-actions', 'aria-label': 'Planification et agenda' },
      h('div', { class: 'pl-actions__main' }, goBtnMain, goHint),
      h('div', { class: 'pl-actions__side' },
        undoBtn,
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': 'Importer un agenda .ics', onclick: () => fileInput.click() }, icon('upload', { size: 16 }), 'Importer', h('span', { class: 'hide-sm' }, ' .ics')),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': 'Exporter le plan en .ics', onclick: () => exportICS() }, icon('download', { size: 16 }), 'Exporter', h('span', { class: 'hide-sm' }, ' .ics')),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => copyPlan() }, icon('copy', { size: 16 }), 'Copier', h('span', { class: 'hide-sm' }, ' le plan')),
        icsChip));

    function updateActions(D) {
      const key = sig(S.busy, D.st.tasks.map((t) => [t.id, t.done, t.durMin]), D.blocks.length, D.blocks.map((b) => b.taskId + b.startMs + b.endMs), D.st.events.filter((e) => e.source === 'ics').length, !!(lastRun && lastRun.prevPlan !== undefined), D.st.plan && D.st.plan.generatedMs);
      if (S.sigs.actions === key) return; S.sigs.actions = key;
      const active = D.st.tasks.filter((t) => !t.done);
      const waiting = P.unplacedFromPlan(active, D.blocks).length;
      const conflicts = conflictCount(D);
      goBtnMain.classList.toggle('is-busy', S.busy);
      goBtnMain.classList.toggle('is-due', !S.busy && (waiting > 0 || conflicts > 0) && active.length > 0);
      goBtnMain.disabled = S.busy;
      goBtnMain.querySelector('.pl-go__label').textContent = S.busy ? 'Je place tes tâches…' : D.blocks.length ? 'Replanifier ma semaine' : 'Planifier ma semaine';
      let hint;
      if (!active.length) hint = 'Aucune tâche à placer : ajoute-en une ci-dessus.';
      else if (conflicts) hint = `${P.plural(conflicts, 'bloc chevauche', 'blocs chevauchent')} un événement : replanifie pour les écarter.`;
      else if (waiting) hint = D.blocks.length ? `${P.plural(waiting, 'tâche attend', 'tâches attendent')} encore un créneau.` : `${P.plural(active.length, 'tâche prête', 'tâches prêtes')} à trouver leur place.`;
      else hint = D.st.plan ? `Plan à jour · généré à ${fmtTime(D.st.plan.generatedMs)}` : '';
      goHint.textContent = hint;
      undoBtn.hidden = !(lastRun && lastRun.prevPlan !== undefined);
      const icsN = D.st.events.filter((e) => e.source === 'ics').length;
      icsChip.hidden = !icsN;
      if (icsN) icsChip.replaceChildren(icon('calendar-check', { size: 14 }), `Agenda · ${P.plural(icsN, 'événement')}`, h('button', { type: 'button', class: 'pl-ics__x', 'aria-label': 'Retirer l\'agenda importé', onclick: () => clearICS() }, icon('x', { size: 13, stroke: 2.2 })));
    }
    function conflictCount(D) {
      const evs = D.st.events.filter((e) => !e.allDay && e.endMs > D.nowMs);
      return D.blocks.filter((b) => evs.some((e) => b.startMs < e.endMs && e.startMs < b.endMs)).length;
    }

    async function planWeek() {
      if (S.busy) return;
      const st = ctx.state;
      if (!st.tasks.some((t) => !t.done)) { toast('Ajoute d\'abord une tâche : le planificateur n\'a rien à placer.', { kind: 'warn' }); input.focus(); return; }
      S.busy = true; S.sigs.actions = null; renderAll();
      board.classList.add('is-thinking');
      await sleep(reduce() ? 0 : 700); // laisse voir la « réflexion » ; le calcul lui-même dure < 400 ms
      if (!alive) return;
      let res;
      try { res = ctx.runPlanner(); } catch (e) { S.busy = false; board.classList.remove('is-thinking'); S.sigs.actions = null; renderAll(); toast(`Planification impossible : ${e.message || e}`, { kind: 'err' }); return; }
      const prev = st.plan ? structuredClone(st.plan) : null;
      const order = [...res.blocks].sort((a, b) => a.startMs - b.startMs);
      const old = new Set(((st.plan && st.plan.blocks) || []).map((b) => `${b.taskId}@${b.startMs}@${b.endMs}`));
      S.assemble = new Map(); let i = 0;
      for (const b of order) if (!old.has(`${b.taskId}@${b.startMs}@${b.endMs}`)) S.assemble.set(P.blockKey(b), i++);
      S.assembleN = Math.max(1, i);
      // si rien n'est visible dans la fenêtre courante, on saute au premier jour qui contient un bloc
      const nowMs = ctx.nowMs();
      if (order.length) { const first = Math.round((startOfDay(order[0].startMs) - startOfDay(nowMs)) / DAY); if (S.mode === 'day' || S.sel > 6) S.sel = P.clampSel(first); else S.sel = 0; }
      S.busy = false; S.celebrate = true; lastRun = { result: res, at: nowMs, prevPlan: prev };
      ctx.applyPlan(res);
      board.classList.remove('is-thinking');
      board.classList.add('is-sweeping'); later(() => board.classList.remove('is-sweeping'), 1900);
      later(() => { S.assemble = null; }, 3200);
      S.sigs = {}; renderAll();
      const lift = res.stats ? res.stats.lift : 0;
      if (lift >= 0.05) later(() => { const r = resultCard.querySelector('.pl-lift__n'); if (r) { const b = r.getBoundingClientRect(); confetti(b.left + b.width / 2, b.top + b.height / 2, { count: 42, spread: .9 }); } }, 500);
      haptic([12, 40, 18]);
      toast(res.blocks.length ? `${P.plural(res.blocks.length, 'bloc posé', 'blocs posés')} · ${lift > 0 ? `+${Math.round(lift * 100)} % d'alignement` : 'planning à jour'}` : 'Rien n\'a pu être placé', { kind: res.blocks.length ? 'ok' : 'warn', undoLabel: res.blocks.length ? 'Annuler' : undefined, onUndo: () => undoPlan(), icon: 'sparkle', duration: 8000 });
      say(`Planification terminée : ${P.plural(res.blocks.length, 'bloc')} placés.`);
    }
    function undoPlan() {
      if (!lastRun || lastRun.prevPlan === undefined) return;
      const prev = lastRun.prevPlan;
      actions.setPlan(prev); lastRun = null; S.assemble = null; S.sigs = {};
      toast('Plan précédent rétabli', { duration: 2200, icon: 'undo' });
      renderAll();
    }

    // — import / export —
    async function importFile(file) {
      if (!file) return;
      let text;
      try { text = await file.text(); } catch { toast('Impossible de lire ce fichier.', { kind: 'err' }); return; }
      if (!/BEGIN:VCALENDAR/i.test(text)) { toast('Ce fichier ne ressemble pas à un agenda .ics.', { kind: 'err' }); return; }
      const { fromMs, toMs } = P.icsRange(ctx.nowMs());
      let events;
      try { events = parseICS(text, { fromMs, toMs }); } catch (e) { toast(`Lecture de l'agenda impossible : ${e.message || e}`, { kind: 'err' }); return; }
      const before = ctx.state.events.filter((e) => e.source === 'ics');
      const n = actions.replaceEvents('ics', events);
      if (!n) { toast('Aucun événement dans les 60 prochains jours.', { kind: 'warn' }); return; }
      toast(`${P.plural(n, 'événement importé', 'événements importés')} · replanifie pour en tenir compte`, { undoLabel: 'Annuler', onUndo: () => actions.replaceEvents('ics', before), icon: 'calendar-check', duration: 8000 });
      haptic(10);
    }
    function clearICS() {
      const before = ctx.state.events.filter((e) => e.source === 'ics');
      actions.replaceEvents('ics', []);
      toast('Agenda importé retiré', { undoLabel: 'Annuler', onUndo: () => actions.replaceEvents('ics', before) });
    }
    function exportICS() {
      const st = ctx.state, blocks = (st.plan && st.plan.blocks) || [];
      if (!blocks.length) { toast('Rien à exporter : planifie d\'abord ta semaine.', { kind: 'warn' }); return; }
      try {
        const text = buildICS({ blocks, tasks: st.tasks, events: [], calName: 'Kairos', nowMs: ctx.nowMs() });
        const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
        const a = h('a', { href: url, download: P.icsFileName(ctx.nowMs()), style: { display: 'none' } });
        document.body.appendChild(a); a.click(); a.remove();
        later(() => URL.revokeObjectURL(url), 4000);
        toast(`${P.plural(blocks.length, 'bloc exporté', 'blocs exportés')} en .ics`, { icon: 'download' });
      } catch (e) { toast(`Export impossible : ${e.message || e}`, { kind: 'err' }); }
    }
    async function copyPlan() {
      const st = ctx.state, text = P.planToText({ blocks: (st.plan && st.plan.blocks) || [], tasks: st.tasks, nowMs: ctx.nowMs() });
      if (!(st.plan && st.plan.blocks.length)) { toast('Aucun plan à copier pour l\'instant.', { kind: 'warn' }); return; }
      try { await navigator.clipboard.writeText(text); }
      catch {
        const ta = h('textarea', { style: { position: 'fixed', opacity: '0', left: '-999px' }, 'aria-hidden': 'true' }); ta.value = text;
        document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch { /* ignoré */ } ta.remove();
      }
      toast('Plan copié dans le presse-papiers', { icon: 'copy', duration: 2200 });
    }
    fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; importFile(f); });

    // dépôt d'un fichier .ics n'importe où dans la vue
    const dropOv = h('div', { class: 'pl-drop', hidden: true, 'aria-hidden': 'true' }, h('div', { class: 'pl-drop__box' }, icon('upload', { size: 40, stroke: 1.5 }), h('strong', null, 'Dépose ton agenda ici'), h('span', null, 'Fichier .ics · les 60 prochains jours seront importés')));
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const onDragEnter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropOv.hidden = false; };
    const onDragOver = (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
    const onDragLeave = (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropOv.hidden = true; };
    const onDrop = (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; dropOv.hidden = true; const f = e.dataTransfer.files && e.dataTransfer.files[0]; importFile(f); };
    for (const [t, f] of [['dragenter', onDragEnter], ['dragover', onDragOver], ['dragleave', onDragLeave], ['drop', onDrop]]) document.addEventListener(t, f);

    // ═══════════════════════ 3. Résultat du planificateur ═══════════════════════
    const resultCard = h('section', { class: 'card card--sun pl-result', hidden: true, 'aria-label': 'Résultat de la planification' });
    function updateResult(D) {
      const active = D.st.tasks.filter((t) => !t.done);
      const unpl = P.unplacedFromPlan(active, D.blocks);
      const key = sig(D.blocks.map((b) => b.taskId + b.startMs + b.endMs), unpl, !!lastRun, lastRun && lastRun.at, S.celebrate, D.st.tasks.map((t) => [t.id, t.title, t.deadlineMs, t.durMin, t.splittable]), modelId(D.model));
      if (S.sigs.result === key) return; S.sigs.result = key;
      if (!D.blocks.length && !(lastRun && lastRun.result.blocks.length === 0 && unpl.length)) { resultCard.hidden = true; return; }
      resultCard.hidden = false;
      const H = ctx.planHorizon(7), hc = curveOf(H);
      const sum = P.summarizePlan({ blocks: D.blocks, tasks: D.st.tasks, curve: hc });
      const lift = lastRun && lastRun.result.stats ? lastRun.result.stats.lift : null;
      const why = new Map(((lastRun && lastRun.result.unplaced) || []).map((u) => [u.taskId, u.why]));
      const big = h('span', { class: 'pl-lift__n gradient-text num' }, lift != null ? `+${Math.round(lift * 100)}` : `${Math.round(sum.meanFit * 100)}`);
      const celebrate = S.celebrate; S.celebrate = false;
      if (celebrate && lift != null) animateNumber(big, Math.round(lift * 100), { from: 0, duration: 1200, format: (v) => `+${Math.round(v)}` });
      const left = h('div', { class: 'pl-lift' },
        h('div', { class: 'pl-lift__row' }, big, h('span', { class: 'pl-lift__unit' }, '%')),
        h('p', { class: 'pl-lift__cap' }, lift != null ? (lift > 0 ? 'd\'alignement énergie ↔ tâches' : 'Ton planning était déjà bien aligné') : 'd\'adéquation moyenne énergie ↔ tâches'),
        h('p', { class: 'pl-lift__sub tiny faint' }, lift != null ? 'par rapport à un placement chronologique naïf' : `plan généré à ${D.st.plan ? fmtTime(D.st.plan.generatedMs) : '—'}`));
      const tiles = h('div', { class: 'pl-tiles' },
        tile('Blocs', String(sum.count), icon('layers', { size: 16 })),
        tile('Placé', fmtDuration(sum.placedMin), icon('clock', { size: 16 })),
        tile('Adéquation', pct(sum.meanFit), icon('target', { size: 16 })));
      const list = unpl.length ? h('div', { class: 'pl-unpl' },
        h('h3', { class: 'pl-unpl__h' }, icon('alert', { size: 18 }), `${P.plural(unpl.length, 'tâche sans créneau', 'tâches sans créneau')}`),
        h('ul', { class: 'pl-unpl__list' }, ...unpl.map((u) => unplacedRow(u, D.tasksById.get(u.taskId), why.get(u.taskId))))) : null;
      setKids(resultCard, h('div', { class: 'pl-result__top' }, left, tiles), list);
      if (celebrate) { resultCard.classList.remove('is-pop'); void resultCard.offsetWidth; resultCard.classList.add('is-pop'); }
    }
    const tile = (label, value, ico) => h('div', { class: 'pl-tile' }, h('span', { class: 'pl-tile__l' }, ico, label), h('strong', { class: 'pl-tile__v num' }, value));
    function unplacedRow(u, t, why) {
      if (!t) return null;
      const kept = t.durMin - u.minutes;
      const canSplit = t.splittable !== true;
      return h('li', { class: 'pl-unpl__item', style: { '--c': P.loadVar(t.load) } },
        h('div', { class: 'pl-unpl__main' }, h('strong', null, t.title), h('span', { class: 'pl-unpl__min num' }, `${fmtDuration(u.minutes)} sans créneau`)),
        h('p', { class: 'pl-unpl__why small muted' }, why || 'Pas encore de créneau : relance la planification.'),
        h('div', { class: 'pl-unpl__acts' },
          t.deadlineMs != null ? h('button', { class: 'chip', type: 'button', onclick: () => { actions.updateTask(t.id, { deadlineMs: t.deadlineMs + DAY }); toast('Échéance repoussée d\'un jour', { duration: 2000 }); planWeek(); } }, icon('clock', { size: 14 }), 'Repousser d\'un jour') : null,
          canSplit ? h('button', { class: 'chip', type: 'button', onclick: () => { actions.updateTask(t.id, { splittable: true, minBlockMin: 25 }); toast('Tâche découpable en blocs', { duration: 2000 }); planWeek(); } }, icon('layers', { size: 14 }), 'Découper') : null,
          kept >= 5 ? h('button', { class: 'chip', type: 'button', onclick: () => { actions.updateTask(t.id, { durMin: kept }); toast(`Durée réduite à ${fmtDuration(kept)}`, { duration: 2200 }); } }, icon('minus', { size: 14 }), `Garder ${fmtDuration(kept)}`) : null,
          h('button', { class: 'chip', type: 'button', onclick: () => ctx.openTaskEditor(t.id) }, icon('edit', { size: 14 }), 'Éditer')));
    }

    // ═══════════════════════ 4. Semaine / jour ═══════════════════════
    const board = h('section', { class: 'card pl-board', 'aria-label': 'Planning' });
    const gradDefs = svg('svg', { width: 0, height: 0, 'aria-hidden': 'true', style: 'position:absolute' },
      svg('defs', null, svg('linearGradient', { id: 'pl-energy-fill', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 100, y2: 0 },
        svg('stop', { offset: 0, style: 'stop-color:var(--sun);stop-opacity:.36' }), svg('stop', { offset: 1, style: 'stop-color:var(--sun);stop-opacity:0' }))));
    let grid = null;

    const go = (delta, dir) => { const n = P.clampSel(S.sel + delta); if (n === S.sel) return; S.sel = n; S.slide = dir || (delta > 0 ? 'next' : 'prev'); S.sigs.board = null; renderAll(); };
    const setMode = (m) => { S.mode = m; S.userMode = true; lsSet('kairos.plan.mode', m); S.sigs.board = null; renderAll(); };

    function dayHead(day, D, i) {
      const hd = P.dayHead(day), isToday = day === startOfDay(D.nowMs);
      const load = P.dayLoad(D.blocks, D.st.tasks, day, D.st.events);
      const cap = Math.max(1, P.capacityMin(D.st.profile, day) - P.eventWorkOverlap(D.st.events, D.st.profile, day));
      const denom = Math.max(cap, load.total);
      const bar = h('span', { class: `pl-dayhead__bar${load.total > cap && P.capacityMin(D.st.profile, day) ? ' is-over' : ''}`, 'aria-hidden': 'true' },
        ...load.byLoad.map((m, k) => (m ? h('i', { style: { flexBasis: `${(m / denom) * 100}%`, '--c': `var(--load-${k + 1})` } }) : null)));
      const allDay = D.st.events.filter((e) => e.allDay && P.clipToDay(e.startMs, Math.max(e.endMs, e.startMs + 1), day) && e.startMs < addDays(day, 1) && e.endMs > day);
      const inner = [
        h('span', { class: 'pl-dayhead__dow' }, hd.dow),
        h('span', { class: 'pl-dayhead__num serif' }, String(hd.num)),
        h('span', { class: 'pl-dayhead__sub num' }, load.total ? fmtDuration(load.total) : '—'),
        bar,
        allDay.length ? h('span', { class: 'pl-allday', title: allDay.map((e) => e.title).join(' · ') }, icon('flag', { size: 11 }), allDay[0].title + (allDay.length > 1 ? ` +${allDay.length - 1}` : '')) : null,
      ];
      const props = { class: `pl-dayhead${isToday ? ' is-today' : ''}`, style: { '--i': i } };
      return S.mode === 'week'
        ? h('button', { ...props, type: 'button', 'aria-label': `${cap1(hd.long)} ${hd.num} ${hd.month} : voir le jour`, onclick: () => { S.sel = P.clampSel(Math.round((day - startOfDay(D.nowMs)) / DAY)); setMode('day'); } }, ...inner)
        : h('div', props, ...inner);
    }

    function dayBody(day, D) {
      const { range, ppm } = D;
      const isToday = day === startOfDay(D.nowMs), band = P.workBand(D.st.profile, day);
      const bg = h('div', { class: 'pl-day__bg', style: { background: P.haloGradient(P.energySamples(D.curve, day, range, 10), range) } });
      const samples = P.energySamples(D.curve, day, range, 10), paths = P.energyPaths(samples, range);
      if (paths.area) bg.appendChild(svg('svg', { class: 'pl-energy', viewBox: `0 0 100 ${range.span}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        svg('path', { d: paths.area, fill: 'url(#pl-energy-fill)' }), svg('path', { d: paths.line, class: 'pl-energy__line', fill: 'none', 'vector-effect': 'non-scaling-stroke' })));
      for (const g of P.goldenBands(D.model, day)) {
        const a = Math.max(g.startMin, range.startMin), b = Math.min(g.endMin, range.endMin);
        if (b > a) bg.appendChild(h('div', { class: 'pl-gold', title: `Prime time · alerte moyenne ${Math.round(g.mean)}`, style: { '--t': a - range.startMin, '--d': b - a } }));
      }
      if (!band.isWorkDay) bg.appendChild(h('div', { class: 'pl-off pl-off--all' }));
      else {
        if (band.startMin > range.startMin) bg.appendChild(h('div', { class: 'pl-off', style: { '--t': 0, '--d': band.startMin - range.startMin } }));
        if (band.endMin < range.endMin) bg.appendChild(h('div', { class: 'pl-off', style: { '--t': Math.max(0, band.endMin - range.startMin), '--d': range.endMin - band.endMin } }));
        if (band.lunch && band.lunch.startMin >= range.startMin) bg.appendChild(h('div', { class: 'pl-lunch', style: { '--t': band.lunch.startMin - range.startMin, '--d': band.lunch.endMin - band.lunch.startMin } }, h('span', null, 'déjeuner')));
      }
      const body = h('div', { class: `pl-day__body${isToday ? ' is-today' : ''}`, 'data-day': String(day), style: { '--span': range.span } }, bg);
      // éléments (événements fixes + blocs) répartis en colonnes s'ils se chevauchent
      const items = [];
      for (const e of D.st.events) { if (e.allDay) continue; const c = P.clipToDay(e.startMs, e.endMs, day); if (c) items.push({ ...c, kind: 'ev', ref: e }); }
      for (const b of D.blocks) { const c = P.clipToDay(b.startMs, b.endMs, day); if (c) items.push({ ...c, kind: 'blk', ref: b }); }
      const laid = P.layoutColumns(items);
      const parts = P.annotateParts(D.blocks);
      for (const it of laid) {
        const t = Math.max(0, it.startMin - range.startMin), d = it.endMin - Math.max(it.startMin, range.startMin);
        if (it.endMin <= range.startMin || it.startMin >= range.endMin) continue;
        const layout = { '--t': t, '--d': Math.min(d, range.endMin - Math.max(it.startMin, range.startMin)), '--col': it.col, '--cols': it.cols };
        if (it.kind === 'ev') body.appendChild(eventEl(it.ref, layout, D));
        else body.appendChild(blockEl(it.ref, layout, D, parts.get(P.blockKey(it.ref)), it.endMin - it.startMin));
      }
      if (!items.some((x) => x.kind === 'blk') && S.mode === 'day') body.appendChild(h('div', { class: 'pl-day__empty' }, h('span', null, 'Rien de prévu ce jour-là')));
      if (isToday) {
        body.appendChild(h('div', { class: 'pl-past', 'aria-hidden': 'true' }));
        body.appendChild(h('div', { class: 'pl-now', 'aria-hidden': 'true' }, h('span', { class: 'pl-now__t num' }, '')));
      }
      return body;
    }

    function eventEl(e, layout, D) {
      const mins = Math.round((e.endMs - e.startMs) / MIN);
      return h('div', { class: `pl-ev${mins < 40 ? ' is-sm' : ''}`, style: layout, role: 'button', tabindex: 0, 'data-ev': e.id, title: `${e.title} · ${fmtTime(e.startMs)}–${fmtTime(e.endMs)}`, 'aria-label': `Événement fixe : ${e.title}, ${fmtTime(e.startMs)} à ${fmtTime(e.endMs)}` },
        h('span', { class: 'pl-ev__t' }, e.title), mins >= 40 ? h('span', { class: 'pl-ev__time num' }, `${fmtTime(e.startMs)}–${fmtTime(e.endMs)}`) : null);
    }

    function blockEl(b, layout, D, part, visibleMin) {
      const task = D.tasksById.get(b.taskId);
      const m = P.blockMetrics(b, task, D.curve);
      const mins = Math.round((b.endMs - b.startMs) / MIN);
      const key = P.blockKey(b);
      const size = visibleMin < 35 ? 'xs' : visibleMin < 55 ? 'sm' : 'md';
      const idx = S.assemble && S.assemble.get(key);
      const isNew = idx != null;
      const step = Math.max(22, Math.min(90, 1500 / (S.assembleN || 1)));
      const title = task ? task.title : 'Tâche';
      const done = !!(task && task.done);
      const el = h('div', {
        class: `pl-blk pl-blk--${size}${b.locked ? ' is-locked' : ''}${done ? ' is-done' : ''}${isNew ? ' is-new' : ''}${S.landKey === key ? ' is-landed' : ''}`,
        style: { ...layout, '--c': P.loadVar(task ? task.load : 3), '--delay': `${isNew ? Math.round(idx * step) : 0}ms` },
        role: 'button', tabindex: 0, 'data-key': key, 'data-task': b.taskId,
        'aria-label': `${title}, ${fmtDateFR(b.startMs)} de ${fmtTime(b.startMs)} à ${fmtTime(b.endMs)}, charge ${task ? task.load : '?'} sur 5, adéquation ${m.score} pour cent${b.locked ? ', verrouillé' : ''}${part && part.parts > 1 ? `, bloc ${part.part} sur ${part.parts}` : ''}. Entrée : pourquoi ici. Flèches : déplacer. L : verrouiller. E : modifier.`,
        title: `${title} · ${fmtTime(b.startMs)}–${fmtTime(b.endMs)} · adéquation ${m.score} %`,
      },
      h('span', { class: 'pl-blk__grip', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'), h('i'), h('i')),
      h('div', { class: 'pl-blk__main' },
        h('span', { class: 'pl-blk__title' }, done ? icon('check', { size: 12, stroke: 2.6 }) : null, title, part && part.parts > 1 ? h('em', { class: 'pl-blk__part num' }, ` ${part.part}/${part.parts}`) : null),
        size !== 'xs' ? h('span', { class: 'pl-blk__time num' }, S.mode === 'week' ? fmtTime(b.startMs) : `${fmtTime(b.startMs)}–${fmtTime(b.endMs)}${size === 'md' ? ` · ${fmtDuration(mins)}` : ''}`) : null,
        size === 'md' && m.alert >= 78 ? h('span', { class: 'pl-blk__peak' }, icon('bolt', { size: 11 }), 'pic') : null),
      size === 'md' ? h('span', { class: `pl-blk__fit pl-tone-${m.tone} num`, title: `Adéquation ${m.score} %` }, String(m.score)) : null,
      h('button', { class: 'pl-blk__lock', type: 'button', tabindex: -1, 'aria-label': b.locked ? 'Déverrouiller ce bloc' : 'Verrouiller ce bloc', 'aria-pressed': String(!!b.locked), onclick: (e) => { e.stopPropagation(); toggleLock(b); } }, icon(b.locked ? 'lock' : 'unlock', { size: 13, stroke: 2 })));
      if (isNew) el.style.animationDelay = `${Math.round(idx * step)}ms`;
      return el;
    }

    function toggleLock(b) {
      try { actions.lockBlock(b.taskId, b.startMs, !b.locked); haptic(8); say(b.locked ? 'Bloc déverrouillé' : 'Bloc verrouillé'); S.focusKey = P.blockKey(b); } catch (e) { toast(e.message || 'Impossible de verrouiller', { kind: 'err' }); }
    }

    function updateBoard(D, force) {
      const key = sig(S.mode, S.sel, startOfDay(D.nowMs), D.blocks.map((b) => [b.taskId, b.startMs, b.endMs, b.locked, b.score]), D.st.events.map((e) => [e.id, e.title, e.startMs, e.endMs, e.allDay]),
        D.st.tasks.map((t) => [t.id, t.title, t.load, t.done]), [D.st.profile.workStart, D.st.profile.workEnd, D.st.profile.workDays], modelId(D.model), !!S.assemble, S.landKey);
      if (!force && S.sigs.board === key) return; S.sigs.board = key;
      const slide = S.slide; S.slide = null;
      const wk = D.wk, days = D.days;
      const head = h('div', { class: 'pl-board__head' },
        h('div', { class: 'pl-board__titles' }, h('span', { class: 'eyebrow eyebrow--sun' }, S.mode === 'week' ? (S.sel < 7 ? '7 prochains jours' : 'Semaine') : 'Jour'), h('h2', { class: 'pl-board__title' }, S.mode === 'week' ? P.weekTitle(days) : cap1(P.weekTitle(days)))),
        h('div', { class: 'pl-board__ctrl' },
          h('button', { class: 'iconbtn pl-nav', type: 'button', 'aria-label': S.mode === 'week' ? 'Semaine précédente' : 'Jour précédent', disabled: S.sel <= 0, onclick: () => go(-P.navStep(S.mode)) }, icon('chevron-left', { size: 20 })),
          h('button', { class: 'btn btn--sm btn--secondary pl-today', type: 'button', disabled: S.sel === 0, onclick: () => go(-S.sel, S.sel > 0 ? 'prev' : 'next') }, 'Aujourd\'hui'),
          h('button', { class: 'iconbtn pl-nav', type: 'button', 'aria-label': S.mode === 'week' ? 'Semaine suivante' : 'Jour suivant', disabled: S.sel >= P.MAX_SEL, onclick: () => go(P.navStep(S.mode)) }, icon('chevron-right', { size: 20 })),
          h('div', { class: 'seg pl-seg', role: 'group', 'aria-label': 'Affichage' },
            h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': String(S.mode === 'week'), onclick: () => setMode('week') }, 'Semaine'),
            h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': String(S.mode === 'day'), onclick: () => setMode('day') }, 'Jour'))));
      const strip = S.mode === 'day' ? h('div', { class: 'pl-strip', role: 'tablist', 'aria-label': 'Jours de la semaine' }, ...wk.map((d) => {
        const hd = P.dayHead(d), isSel = d === days[0], l = P.dayLoad(D.blocks, D.st.tasks, d, D.st.events);
        const ev = D.st.events.some((e) => e.startMs < addDays(d, 1) && e.endMs > d);
        return h('button', { class: `pl-strip__d${isSel ? ' is-sel' : ''}${d === startOfDay(D.nowMs) ? ' is-today' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(isSel), 'aria-label': `${cap1(hd.long)} ${hd.num} ${hd.month}${l.total ? `, ${fmtDuration(l.total)} planifiées` : ''}`, onclick: () => { const n = Math.round((d - startOfDay(D.nowMs)) / DAY); go(n - S.sel); } },
          h('span', { class: 'pl-strip__dow' }, hd.dow), h('span', { class: 'pl-strip__num serif' }, String(hd.num)),
          h('span', { class: 'pl-strip__dots', 'aria-hidden': 'true' }, l.total ? h('i', { class: 'is-b' }) : null, ev ? h('i', { class: 'is-e' }) : null));
      })) : null;
      const legend = h('div', { class: 'pl-legend', 'aria-hidden': 'true' },
        ...[1, 2, 3, 4, 5].map((n) => h('span', { class: 'pl-legend__i', style: { '--c': `var(--load-${n})` } }, h('i'), n === 1 ? 'Routine' : n === 5 ? 'Profonde' : '')),
        h('span', { class: 'pl-legend__i pl-legend__i--ev' }, h('i'), 'Événement fixe'), h('span', { class: 'pl-legend__i pl-legend__i--gold' }, h('i'), 'Prime time'));
      const colsStyle = { '--cols': days.length, '--ppm': `${D.ppm}px`, '--span': D.range.span };
      const gutter = h('div', { class: 'pl-gutter', style: { '--span': D.range.span }, 'aria-hidden': 'true' }, ...P.hourLabels(D.range).map((l) => h('span', { class: 'pl-hour num', style: { '--t': l.min - D.range.startMin } }, l.label)));
      grid = h('div', { class: `pl-grid${S.mode === 'day' ? ' pl-grid--day' : ''}${slide ? ` pl-slide-${slide}` : ''}`, style: colsStyle },
        h('div', { class: 'pl-corner' }), ...days.map((d, i) => dayHead(d, D, i)), gutter, ...days.map((d) => dayBody(d, D)));
      const scroller = h('div', { class: 'pl-scroller' }, grid);
      attachGridEvents(scroller);
      const overlay = boardOverlay(D);
      const foc = S.focusKey; S.focusKey = null;
      setKids(board, gradDefs, head, strip, legend, scroller, overlay, h('div', { class: 'pl-think', 'aria-hidden': 'true' }, h('span', null, 'Je cherche tes meilleurs créneaux…')));
      if (S.landKey) { const lk = S.landKey; later(() => { if (S.landKey === lk) S.landKey = null; }, 1200); }
      if (foc) { const el = grid.querySelector(`[data-key="${CSS.escape(foc)}"]`); if (el) el.focus({ preventScroll: true }); }
      updateNow(D);
    }

    function boardOverlay(D) {
      const active = D.st.tasks.filter((t) => !t.done);
      if (D.blocks.length || S.busy) return null;
      return h('div', { class: 'pl-board__empty' },
        h('div', { class: 'pl-board__emptycard' },
          h('div', { class: 'pl-board__art' }, emptyArt()),
          h('h3', { class: 'empty__title' }, active.length ? 'Ton énergie est prête' : 'Une semaine vierge'),
          h('p', { class: 'empty__text' }, active.length
            ? 'Les halos dorés sont tes pics d\'énergie prédits. Lance la planification : chaque tâche ira se poser là où ton cerveau est le meilleur.'
            : 'Les halos dorés sont tes pics d\'énergie prédits. Écris une tâche tout en haut (« Finir le rapport 2h avant vendredi 17h ») et regarde-la trouver sa place.'),
          active.length ? h('button', { class: 'btn btn--primary', type: 'button', onclick: () => planWeek() }, icon('sparkle', { size: 18 }), 'Planifier ma semaine')
            : h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => { input.focus(); } }, icon('plus', { size: 18 }), 'Ajouter une tâche')));
    }

    // ligne « maintenant » et voile du passé (mis à jour à chaque tick sans reconstruire la grille)
    function updateNow(D) {
      if (!grid) return;
      D = D || derive();
      const body = grid.querySelector('.pl-day__body.is-today');
      if (!body) return;
      const m = minutesOfDay(D.nowMs), off = m - D.range.startMin;
      const line = body.querySelector('.pl-now'), past = body.querySelector('.pl-past');
      const inRange = off >= 0 && off <= D.range.span;
      if (line) { line.hidden = !inRange; line.style.setProperty('--now', String(off)); const t = line.querySelector('.pl-now__t'); if (t) t.textContent = fmtTime(D.nowMs); }
      if (past) past.style.setProperty('--now', String(Math.max(0, Math.min(D.range.span, off))));
    }

    // ═══════════════════════ Gestes : clic, glisser-déposer, clavier, balayage ═══════════════════════
    let G = null, clickTimer = 0, suppressUntil = 0, dock = null;
    const blockOf = (el) => { const D = derive(); const k = el.dataset.key; const b = D.blocks.find((x) => P.blockKey(x) === k); return b ? { b, D } : null; };

    function attachGridEvents(scroller) {
      scroller.addEventListener('pointerdown', onPointerDown);
      scroller.addEventListener('click', onGridClick);
      scroller.addEventListener('dblclick', (e) => { const el = e.target.closest('.pl-blk'); if (!el) return; e.preventDefault(); clearTimeout(clickTimer); const r = blockOf(el); if (r) ctx.openTaskEditor(r.b.taskId); });
      scroller.addEventListener('keydown', onGridKey);
      // balayage horizontal (mode jour) pour changer de jour
      let sw = null;
      scroller.addEventListener('touchstart', (e) => { if (S.mode !== 'day' || e.touches.length !== 1 || e.target.closest('.pl-blk__grip') || G) { sw = null; return; } const t = e.touches[0]; sw = { x: t.clientX, y: t.clientY, t: performance.now() }; }, { passive: true });
      scroller.addEventListener('touchend', (e) => {
        if (!sw || G) { sw = null; return; }
        const t = e.changedTouches[0], intent = P.swipeIntent({ dx: t.clientX - sw.x, dy: t.clientY - sw.y, dt: performance.now() - sw.t }); sw = null;
        if (intent) go(intent === 'next' ? 1 : -1, intent);
      }, { passive: true });
    }

    function onGridClick(e) {
      if (performance.now() < suppressUntil) return;
      if (e.target.closest('.pl-blk__lock')) return;
      const el = e.target.closest('.pl-blk'), ev = e.target.closest('.pl-ev');
      if (ev) { openEventPanel(ev.dataset.ev); return; }
      if (!el) return;
      const r = blockOf(el); if (!r) return;
      clearTimeout(clickTimer);
      if (e.detail >= 2) return; // double-clic : l'éditeur s'ouvre via « dblclick »
      clickTimer = setTimeout(() => openExplain(r.b), 230);
    }

    function onGridKey(e) {
      const evEl = e.target.closest && e.target.closest('.pl-ev');
      if (evEl && e.target === evEl && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openEventPanel(evEl.dataset.ev); return; }
      const el = e.target.closest && e.target.closest('.pl-blk');
      if (!el || e.target !== el) return;
      const r = blockOf(el); if (!r) return;
      const { b, D } = r;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openExplain(b); return; }
      if (e.key === 'e' || e.key === 'E') { e.preventDefault(); ctx.openTaskEditor(b.taskId); return; }
      if (e.key === 'l' || e.key === 'L') { e.preventDefault(); toggleLock(b); return; }
      const mv = P.keyMove(e.key, e.shiftKey);
      if (!mv) return;
      e.preventDefault();
      const target = addDays(b.startMs, mv.dDay) + mv.dMin * MIN;
      const res = validateMove(b, target, vctx(D));
      if (!res.ok) { toast(P.fixMonths(res.why) || 'Déplacement impossible', { kind: 'warn', duration: 2400 }); say(P.fixMonths(res.why) || 'Déplacement impossible'); return; }
      commitMove(b, res, D, true);
    }

    function onPointerDown(e) {
      if (G || e.isPrimary === false) return;
      const el = e.target.closest && e.target.closest('.pl-blk');
      if (!el || e.target.closest('.pl-blk__lock')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const r = blockOf(el); if (!r) return;
      const rect = el.getBoundingClientRect();
      G = { el, block: r.b, pid: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), type: e.pointerType || 'mouse', grip: !!e.target.closest('.pl-blk__grip'),
        phase: 'pending', sy0: window.scrollY, grab: e.clientY - rect.top, memo: new Map(), res: null, lane: null, timer: 0, raf: 0 };
      if (G.type === 'touch' && !G.grip) G.timer = setTimeout(() => { if (G && G.phase === 'pending') { G.phase = 'long'; haptic(16); clearTimeout(clickTimer); ctx.openTaskEditor(G.block.taskId); endGesture(true); } }, 520);
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onDragKey, true);
    }
    function onPointerMove(e) {
      if (!G || e.pointerId !== G.pid) return;
      G.x = e.clientX; G.y = e.clientY;
      if (G.phase === 'pending') {
        const step = P.gestureStep({ pointerType: G.type, onGrip: G.grip, dx: G.x - G.x0, dy: G.y - G.y0, elapsedMs: performance.now() - G.t0 });
        if (step === 'cancel') { endGesture(true); return; }
        if (step !== 'drag') return;
        if (G.block.locked) { nudgeLock(G.el); toast('Ce bloc est verrouillé : touche le cadenas pour le libérer.', { kind: 'warn', duration: 2600 }); endGesture(true); return; }
        beginDrag();
      }
      if (G.phase === 'drag') { e.preventDefault(); updateDrag(); }
    }
    function onPointerUp(e) { if (!G || e.pointerId !== G.pid) return; if (G.phase === 'drag') finishDrag(true); else endGesture(true); }
    function onPointerCancel(e) { if (!G || e.pointerId !== G.pid) return; if (G.phase === 'drag') finishDrag(false); else endGesture(true); }
    function onDragKey(e) { if (e.key === 'Escape' && G && G.phase === 'drag') { e.preventDefault(); e.stopPropagation(); finishDrag(false); } }
    function nudgeLock(el) { const l = el.querySelector('.pl-blk__lock'); if (!l) return; l.classList.remove('is-nudge'); void l.offsetWidth; l.classList.add('is-nudge'); haptic([10, 30, 10]); }

    function beginDrag() {
      clearTimeout(G.timer);
      G.phase = 'drag'; S.dragging = true;
      try { G.el.setPointerCapture(G.pid); } catch { /* capture indisponible */ }
      G.D = derive();
      G.lanes = Array.from(grid.querySelectorAll('.pl-day__body')).map((el) => { const r = el.getBoundingClientRect(); return { el, dayMs: Number(el.dataset.day), left: r.left, right: r.right }; });
      G.ghost = h('div', { class: 'pl-ghost', style: { '--c': G.el.style.getPropertyValue('--c') } }, h('span', { class: 'pl-ghost__t num' }));
      G.el.classList.add('is-dragging');
      document.documentElement.classList.add('pl-is-dragging');
      dock = h('div', { class: 'pl-verdict', role: 'status' }, h('span', { class: 'pl-verdict__ico' }), h('div', { class: 'pl-verdict__txt' }, h('strong', { class: 'pl-verdict__h' }), h('span', { class: 'pl-verdict__t num' }), h('span', { class: 'pl-verdict__d' })));
      document.body.appendChild(dock);
      haptic(12);
      const tick = () => {
        if (!G || G.phase !== 'drag') return;
        const vh = window.innerHeight, edge = 96;
        const dy = G.y < edge ? -Math.ceil((edge - G.y) / 6) : G.y > vh - edge - 40 ? Math.ceil((G.y - (vh - edge - 40)) / 6) : 0;
        if (dy) { window.scrollBy({ top: dy, behavior: 'instant' }); updateDrag(); }
        G.raf = requestAnimationFrame(tick);
      };
      G.raf = requestAnimationFrame(tick);
    }

    function updateDrag() {
      const D = G.D, { range, ppm } = D;
      G.el.style.transform = `translate(${G.x - G.x0}px, ${G.y - G.y0 + (window.scrollY - G.sy0)}px)`;
      let lane = G.lanes[0], bestD = Infinity;
      for (const l of G.lanes) { const dd = G.x < l.left ? l.left - G.x : G.x > l.right ? G.x - l.right : 0; if (dd < bestD) { bestD = dd; lane = l; } }
      const r = lane.el.getBoundingClientRect();
      const topMin = range.startMin + (G.y - G.grab - r.top) / ppm;
      const startMs = P.slotStartMs(lane.dayMs, topMin, 5);
      const mk = `${lane.dayMs}:${startMs}`;
      let res = G.memo.get(mk);
      if (!res) { res = validateMove(G.block, startMs, vctx(D)); G.memo.set(mk, res); }
      G.res = res; G.lane = lane;
      const verdict = P.moveVerdict(res), dur = Math.round((G.block.endMs - G.block.startMs) / MIN);
      const gTop = P.clipToDay(res.startMs, res.endMs, lane.dayMs);
      const startMin = gTop ? gTop.startMin : topMin;
      G.ghost.style.setProperty('--t', String(Math.max(0, startMin - range.startMin)));
      G.ghost.style.setProperty('--d', String(dur));
      G.ghost.className = `pl-ghost is-${verdict.tone}`;
      G.ghost.firstChild.textContent = `${fmtTime(res.startMs)}${res.ok ? ` · ${res.score}` : ''}`;
      if (G.ghost.parentNode !== lane.el) lane.el.appendChild(G.ghost);
      for (const l of G.lanes) l.el.classList.toggle('is-target', l === lane);
      dock.className = `pl-verdict is-${verdict.tone}`;
      dock.querySelector('.pl-verdict__ico').replaceChildren(icon(verdict.tone === 'good' ? 'arrow-up' : verdict.tone === 'bad' ? 'arrow-down' : verdict.tone === 'same' ? 'minus' : 'x', { size: 22, stroke: 2.4 }));
      dock.querySelector('.pl-verdict__h').textContent = verdict.headline;
      dock.querySelector('.pl-verdict__t').textContent = `${cap1(fmtDateFR(res.startMs, { short: false }))} · ${fmtTime(res.startMs)}–${fmtTime(res.endMs)}`;
      dock.querySelector('.pl-verdict__d').textContent = verdict.detail;
      const sig2 = `${mk}:${verdict.tone}`;
      if (G.lastSig !== sig2) { G.lastSig = sig2; if (G.type === 'touch') haptic(5); }
    }

    function finishDrag(commit) {
      const g = G; if (!g) return;
      cancelAnimationFrame(g.raf);
      const D = g.D, res = g.res;
      suppressUntil = performance.now() + 350;
      if (!commit) window.addEventListener('pointerup', () => { suppressUntil = performance.now() + 300; }, { once: true, capture: true }); // pas de clic fantôme après Échap
      const moved = commit && res && res.startMs !== g.block.startMs;
      if (moved && res.ok) { endGesture(false); commitMove(g.block, res, D, false); return; }
      // retour élastique
      if (moved && !res.ok) { toast(P.fixMonths(res.why) || 'Déplacement impossible', { kind: 'warn', duration: 3000 }); haptic([14, 40, 14]); }
      g.el.style.transition = reduce() ? 'none' : 'transform 340ms var(--ease-spring)';
      g.el.style.transform = '';
      const el = g.el; later(() => { el.style.transition = ''; el.classList.remove('is-dragging'); }, 360);
      endGesture(false);
    }
    function endGesture(full) {
      const g = G; G = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onDragKey, true);
      if (!g) return;
      clearTimeout(g.timer);
      if (g.ghost) g.ghost.remove();
      if (g.lanes) for (const l of g.lanes) l.el.classList.remove('is-target');
      if (dock) { dock.remove(); dock = null; }
      document.documentElement.classList.remove('pl-is-dragging');
      S.dragging = false;
      if (full && g.el) { g.el.classList.remove('is-dragging'); g.el.style.transform = ''; }
      if (S.pending) { S.pending = false; requestAnimationFrame(renderAll); }
    }

    function commitMove(block, res, D, byKey) {
      const plan = D.st.plan; if (!plan) return;
      const prev = structuredClone(plan);
      const blocks = P.applyMove(plan.blocks, block, res);
      S.landKey = `${block.taskId}@${res.startMs}`; S.focusKey = byKey ? S.landKey : null;
      actions.setPlan({ generatedMs: plan.generatedMs, horizonDays: plan.horizonDays, blocks });
      haptic([10, 30, 16]);
      const d = res.deltaScore || 0;
      const task = D.tasksById.get(block.taskId);
      toast(`« ${task ? task.title : 'Bloc'} » déplacé à ${fmtTime(res.startMs)} · ${d > 0 ? `+${d} pts` : d < 0 ? `−${Math.abs(d)} pts` : 'même adéquation'} · verrouillé`, { kind: d < 0 ? 'warn' : 'ok', undoLabel: 'Annuler', onUndo: () => { actions.setPlan(prev); }, icon: 'lock', duration: 6000 });
      say(`Bloc déplacé à ${fmtTime(res.startMs)}, verrouillé.`);
      if (S.mode === 'day') { const n = P.clampSel(Math.round((startOfDay(res.startMs) - startOfDay(D.nowMs)) / DAY)); if (n !== S.sel) S.sel = n; }
    }

    // ═══════════════════════ Panneaux ═══════════════════════
    function sparkSvg(D, b) {
      const day = startOfDay(b.startMs), W = 300, Hh = 64;
      const range = { startMin: 5 * 60, endMin: 23 * 60 };
      const samples = P.energySamples(D.curve, day, range, 15);
      if (!samples.length) return null;
      const span = range.endMin - range.startMin;
      const X = (min) => ((min - range.startMin) / span) * W, Y = (v) => Hh - 6 - (v / 100) * (Hh - 14);
      const line = samples.map((s, i) => `${i ? 'L' : 'M'}${X(s.min).toFixed(1)} ${Y(s.v).toFixed(1)}`).join(' ');
      const c = P.clipToDay(b.startMs, b.endMs, day) || { startMin: 0, endMin: 0 };
      const x0 = X(Math.max(c.startMin, range.startMin)), x1 = X(Math.min(c.endMin, range.endMin));
      return svg('svg', { class: 'pl-spark', viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': 'Courbe d\'énergie prédite de la journée, bloc surligné' },
        svg('rect', { x: x0, y: 0, width: Math.max(2, x1 - x0), height: Hh, rx: 4, class: 'pl-spark__blk' }),
        svg('path', { d: `${line} L${W} ${Hh} L0 ${Hh} Z`, class: 'pl-spark__area' }), svg('path', { d: line, class: 'pl-spark__line', fill: 'none' }));
    }

    function openExplain(b) {
      const D = derive(), task = D.tasksById.get(b.taskId); if (!task) return;
      const m = P.blockMetrics(b, task, D.curve), parts = P.annotateParts(D.blocks).get(P.blockKey(b)) || {};
      const text = P.fixMonths(explainBlock({ ...b, ...parts }, task, D.curve));
      const due = P.dueInfo(task.deadlineMs, D.nowMs);
      const mins = Math.round((b.endMs - b.startMs) / MIN);
      const row = (k, v) => h('div', { class: 'pl-why__row' }, h('dt', null, k), h('dd', null, v));
      const spark = sparkSvg(D, b);
      let modal;
      const close = () => modal && modal.close();
      const content = h('div', { class: 'pl-why', style: { '--c': P.loadVar(task.load) } },
        h('div', { class: 'pl-why__hero' }, scoreRing(m.score, m.tone, 76),
          h('div', { class: 'pl-why__id' }, h('strong', { class: 'pl-why__task' }, task.title),
            h('span', { class: 'pl-why__when num' }, `${cap1(fmtDateFR(b.startMs))} · ${fmtTime(b.startMs)}–${fmtTime(b.endMs)}`),
            h('span', { class: 'pl-why__dur muted small' }, `${fmtDuration(mins)}${parts.parts > 1 ? ` · bloc ${parts.part}/${parts.parts}` : ''}`))),
        h('p', { class: 'pl-why__text' }, icon('sparkle', { size: 16 }), text),
        spark,
        h('dl', { class: 'pl-why__grid' },
          row('Alerte prédite', h('span', null, h('b', { class: 'num' }, `${m.alert}/100`), ` · ${P.alertLabel(m.alert)}`)),
          row('Adéquation', h('span', { class: `pl-tone-${m.tone}` }, h('b', { class: 'num' }, `${m.score} %`))),
          row('Charge', h('span', { class: 'pl-why__load' }, loadGauge(task.load), ` ${P.LOAD_NAMES[task.load]}`)),
          due ? row('Échéance', h('span', { class: `pl-due pl-due--${due.tone}` }, due.text)) : null,
          row('Priorité', P.PRIO_NAMES[task.priority] || '—')),
        b.locked ? h('div', { class: 'banner banner--warn' }, icon('lock', { size: 18 }), h('span', null, 'Verrouillé : le planificateur n\'y touchera pas. Déverrouille-le pour le laisser bouger.')) : null);
      const foot = [
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => { toggleLock(b); close(); } }, icon(b.locked ? 'unlock' : 'lock', { size: 18 }), b.locked ? 'Déverrouiller' : 'Verrouiller'),
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => { close(); ctx.openTaskEditor(task.id); } }, icon('edit', { size: 18 }), 'Modifier'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => { close(); ctx.startFocus && ctx.startFocus({ taskId: task.id, minutes: Math.min(mins, 90) }); } }, icon('play', { size: 18 }), 'Focus'),
        h('button', { class: 'btn btn--primary', type: 'button', onclick: () => { actions.completeTask(task.id, true); close(); toast('Bien joué ! Tâche terminée', { icon: 'check-circle', undoLabel: 'Annuler', onUndo: () => actions.completeTask(task.id, false) }); } }, icon('check', { size: 18 }), 'Fait'),
      ];
      modal = openModal({ title: 'Pourquoi ici ?', content, footer: foot, size: 'sm' });
    }

    function openEventPanel(id) {
      const e = ctx.state.events.find((x) => x.id === id); if (!e) return;
      let modal;
      const content = h('div', { class: 'stack stack--sm' },
        h('p', { class: 'h3' }, e.title),
        h('p', { class: 'num muted' }, `${cap1(fmtDateFR(e.startMs))} · ${fmtTime(e.startMs)}–${fmtTime(e.endMs)} · ${fmtDuration(Math.round((e.endMs - e.startMs) / MIN))}`),
        h('p', { class: 'small faint' }, e.source === 'ics' ? 'Importé depuis ton agenda (.ics). Les blocs du plan l\'évitent.' : 'Événement fixe ajouté à la main. Les blocs du plan l\'évitent.'));
      const foot = [
        h('button', { class: 'btn btn--danger', type: 'button', onclick: () => { const copy = structuredClone(e); actions.removeEvent(e.id); modal.close(); toast('Événement supprimé', { undoLabel: 'Annuler', onUndo: () => actions.addEvent(copy) }); } }, icon('trash', { size: 18 }), 'Supprimer'),
        h('span', { class: 'spacer' }), h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => modal.close() }, 'Fermer')];
      modal = openModal({ title: 'Événement fixe', content, footer: foot, size: 'sm' });
    }

    // ═══════════════════════ 5. Backlog ═══════════════════════
    const backlog = h('section', { class: 'card pl-backlog', 'aria-label': 'Tâches' });
    function placement(t, D) {
      const own = D.blocks.filter((b) => b.taskId === t.id).sort((a, b) => a.startMs - b.startMs);
      if (t.done) return null;
      const rem = P.remainingMin(t, D.blocks);
      if (!own.length) return D.st.plan ? h('span', { class: 'pl-pl pl-pl--none' }, h('i'), 'Sans créneau') : null;
      const first = own[0];
      const label = `${P.shortDate(first.startMs)} ${fmtTime(first.startMs)}${own.length > 1 ? ` · +${own.length - 1}` : ''}`;
      return h('button', { class: `pl-pl${rem >= 5 ? ' is-partial' : ''}`, type: 'button', title: rem >= 5 ? `${fmtDuration(rem)} encore sans créneau` : 'Voir dans le planning', onclick: (e) => { e.stopPropagation(); jumpTo(first, D); } }, icon('calendar-check', { size: 12 }), label);
    }
    function jumpTo(b, D) {
      const n = P.clampSel(Math.round((startOfDay(b.startMs) - startOfDay(D.nowMs)) / DAY));
      if (S.mode === 'day') S.sel = n; else S.sel = P.weekOffset(n);
      S.landKey = P.blockKey(b); S.sigs.board = null; renderAll();
      later(() => { const el = grid && grid.querySelector(`[data-key="${CSS.escape(P.blockKey(b))}"]`); if (el) { el.scrollIntoView({ block: 'center', behavior: reduce() ? 'auto' : 'smooth' }); el.focus({ preventScroll: true }); } }, 60);
    }
    function taskRow(t, D) {
      const due = P.dueInfo(t.deadlineMs, D.nowMs);
      const pl = placement(t, D);
      return h('li', { class: `pl-task${t.done ? ' is-done' : ''}${due && due.tone === 'late' && !t.done ? ' is-late' : ''}${S.flashTask === t.id ? ' is-flash' : ''}`, style: { '--c': P.loadVar(t.load) }, 'data-id': t.id },
        h('button', { class: 'pl-check', type: 'button', role: 'checkbox', 'aria-checked': String(!!t.done), 'aria-label': `${t.done ? 'Rouvrir' : 'Terminer'} : ${t.title}`, onclick: (e) => toggleDone(t, e.currentTarget) }, icon('check', { size: 16, stroke: 3 })),
        h('button', { class: 'pl-task__main', type: 'button', onclick: () => ctx.openTaskEditor(t.id), 'aria-label': `Modifier : ${t.title}` },
          h('span', { class: 'pl-task__title' }, t.title),
          h('span', { class: 'pl-task__meta' },
            h('span', { class: 'pl-m num' }, icon('timer', { size: 12 }), fmtDuration(t.durMin)),
            due ? h('span', { class: `pl-due pl-due--${due.tone}` }, icon(due.tone === 'late' ? 'alert' : 'clock', { size: 12 }), due.text) : null,
            t.priority <= 2 ? h('span', { class: `pl-prio pl-prio--${t.priority}` }, icon('flag', { size: 12 }), P.PRIO_NAMES[t.priority]) : null,
            ...(t.tags || []).slice(0, 3).map((g) => h('span', { class: 'pl-tag' }, `#${g}`)))),
        h('span', { class: 'pl-task__side' }, pl, loadGauge(t.load),
          h('button', { class: 'iconbtn pl-x', type: 'button', 'aria-label': `Supprimer : ${t.title}`, onclick: () => removeTask(t, D) }, icon('trash', { size: 16 }))));
    }
    function toggleDone(t, btn) {
      const done = !t.done;
      actions.completeTask(t.id, done);
      if (done) { haptic([8, 30, 12]); if (btn && !reduce()) { const r = btn.getBoundingClientRect(); confetti(r.left + r.width / 2, r.top + r.height / 2, { count: 18, spread: .7 }); } }
    }
    function removeTask(t, D) {
      const copy = structuredClone(t), plan = D.st.plan ? structuredClone(D.st.plan) : null;
      actions.removeTask(t.id);
      toast(`« ${t.title} » supprimée`, { undoLabel: 'Annuler', icon: 'trash', onUndo: () => { try { actions.addTask(copy); if (plan) actions.setPlan(plan); } catch (e) { toast(e.message, { kind: 'err' }); } } });
    }

    function updateBacklog(D) {
      const key = sig(S.filter, S.group, S.flashTask, startOfDay(D.nowMs), Math.floor(D.nowMs / HOUR),
        D.st.tasks.map((t) => [t.id, t.title, t.durMin, t.load, t.priority, t.deadlineMs, t.done, t.tags]), D.blocks.map((b) => b.taskId + b.startMs + b.endMs), !!D.st.plan);
      if (S.sigs.backlog === key) return; S.sigs.backlog = key;
      const all = D.st.tasks, counts = P.countFilters(all, D.nowMs);
      const rows = P.sortTasks(P.filterTasks(all, S.filter, D.nowMs));
      const groups = P.groupTasks(rows, S.group, D.nowMs);
      const head = h('div', { class: 'card__head pl-backlog__head' },
        h('div', null, h('h2', { class: 'card__title' }, 'Tâches'), h('p', { class: 'card__sub' }, all.length ? `${counts.todo} à faire · ${counts.done} faite${counts.done > 1 ? 's' : ''}` : 'Ton backlog est vide')),
        h('div', { class: 'row' },
          h('div', { class: 'seg pl-seg', role: 'group', 'aria-label': 'Regroupement' }, ...P.GROUPS.map((g) => h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': String(S.group === g.id), onclick: () => { S.group = g.id; lsSet('kairos.plan.group', g.id); S.sigs.backlog = null; renderAll(); } }, g.label))),
          h('button', { class: 'btn btn--sm btn--primary', type: 'button', onclick: () => ctx.openTaskEditor() }, icon('plus', { size: 16, stroke: 2.2 }), 'Ajouter')));
      const filters = h('div', { class: 'pl-filters', role: 'group', 'aria-label': 'Filtrer les tâches' }, ...P.FILTERS.map((f) => h('button', { class: `chip${f.id === 'late' && counts.late ? ' chip--coral' : ''}`, type: 'button', 'aria-pressed': String(S.filter === f.id), onclick: () => { S.filter = f.id; lsSet('kairos.plan.filter', f.id); S.sigs.backlog = null; renderAll(); } },
        f.label, h('span', { class: 'pl-filters__n num' }, String(counts[f.id])))));
      let body;
      if (!all.length) {
        body = h('div', { class: 'empty pl-empty' }, h('div', { class: 'empty__art' }, emptyArt()), h('h3', { class: 'empty__title' }, 'Rien à planifier… pour l\'instant'),
          h('p', { class: 'empty__text' }, 'Écris ta première tâche dans la barre en haut, comme tu la dirais à voix haute :'),
          h('div', { class: 'pl-examples' }, ...EXAMPLES.slice(0, 3).map((x) => h('button', { class: 'chip chip--sun', type: 'button', onclick: () => { input.value = x; refreshEntry(); input.focus(); window.scrollTo({ top: 0, behavior: reduce() ? 'auto' : 'smooth' }); } }, x))));
      } else if (!rows.length) {
        body = h('div', { class: 'empty pl-empty' }, h('h3', { class: 'empty__title' }, S.filter === 'late' ? 'Rien en retard' : S.filter === 'done' ? 'Rien de terminé pour l\'instant' : 'Aucune tâche ici'),
          h('p', { class: 'empty__text' }, S.filter === 'late' ? 'Bravo : toutes tes échéances sont tenues.' : 'Essaie un autre filtre.'),
          h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: () => { S.filter = 'all'; S.sigs.backlog = null; renderAll(); } }, 'Tout afficher'));
      } else {
        body = h('div', { class: 'pl-groups' }, ...groups.map((g) => h('div', { class: 'pl-group' }, g.label ? h('h3', { class: 'pl-group__h eyebrow' }, g.label, h('span', { class: 'num' }, String(g.items.length))) : null, h('ul', { class: 'pl-tasks' }, ...g.items.map((t) => taskRow(t, D))))));
      }
      setKids(backlog, head, filters, body);
    }

    // ═══════════════════════ 6. Statistiques ═══════════════════════
    const stats = h('section', { class: 'card pl-stats', 'aria-label': 'Statistiques du plan' });
    function updateStats(D) {
      const key = sig(D.blocks.map((b) => b.taskId + b.startMs + b.endMs), D.st.tasks.map((t) => [t.id, t.load, t.durMin, t.done]), D.st.events.map((e) => e.startMs + e.endMs), startOfDay(D.nowMs), D.st.profile);
      if (S.sigs.stats === key) return; S.sigs.stats = key;
      const H = ctx.planHorizon(7), hc = curveOf(H), days = P.viewDays(D.nowMs, 0, 'week'), tasks = D.st.tasks;
      const deep = P.deepInPeaks({ blocks: D.blocks, tasks, curve: hc });
      const per = days.map((d) => ({ d, load: P.dayLoad(D.blocks, tasks, d, D.st.events), cap: Math.max(0, P.capacityMin(D.st.profile, d) - P.eventWorkOverlap(D.st.events, D.st.profile, d)), head: P.dayHead(d) }));
      const demand = tasks.filter((t) => !t.done).reduce((s, t) => s + t.durMin, 0), capacity = per.reduce((s, x) => s + x.cap, 0);
      const maxV = Math.max(60, ...per.map((x) => Math.max(x.load.total, x.cap)));
      const ratio = capacity ? demand / capacity : demand ? 2 : 0;
      const ring = (() => {
        const size = 84, r = 34, c = 2 * Math.PI * r;
        return h('div', { class: 'pl-st__ring' }, svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true' },
          svg('circle', { cx: 42, cy: 42, r, fill: 'none', class: 'pl-ring__track', 'stroke-width': 7 }),
          svg('circle', { cx: 42, cy: 42, r, fill: 'none', class: 'pl-ring__arc pl-st__arc', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': `${c * deep.ratio} ${c}`, transform: 'rotate(-90 42 42)' })),
          h('b', { class: 'num' }, deep.deepMin ? pct(deep.ratio) : '—'));
      })();
      setKids(stats,
        h('div', { class: 'card__head' }, h('div', null, h('h2', { class: 'card__title' }, 'En un coup d\'œil'), h('p', { class: 'card__sub' }, 'Sur les 7 prochains jours'))),
        h('div', { class: 'pl-st' },
          h('div', { class: 'pl-st__row' }, ring, h('div', null, h('strong', { class: 'pl-st__h' }, 'Travail profond dans tes pics'),
            h('p', { class: 'small muted' }, deep.deepMin ? `${fmtDuration(deep.peakMin)} sur ${fmtDuration(deep.deepMin)} de travail profond tombent dans un pic d'énergie.` : 'Aucune tâche exigeante (charge 4–5) n\'est encore planifiée.'))),
          h('div', { class: 'pl-st__block' }, h('strong', { class: 'pl-st__h' }, 'Charge par jour'),
            h('div', { class: 'pl-bars', role: 'img', 'aria-label': `Charge planifiée par jour : ${per.map((x) => `${x.head.long} ${fmtDuration(x.load.total)}`).join(', ')}` },
              ...per.map((x) => h('div', { class: `pl-bar${x.cap === 0 ? ' is-off' : ''}`, style: { '--cap': `${(x.cap / maxV) * 100}%` } },
                h('div', { class: 'pl-bar__stack' }, ...x.load.byLoad.map((m, k) => (m ? h('i', { style: { height: `${(m / maxV) * 100}%`, '--c': `var(--load-${k + 1})` }, title: `${P.LOAD_NAMES[k + 1]} · ${fmtDuration(m)}` }) : null))),
                h('span', { class: 'pl-bar__l' }, x.head.dow.slice(0, 1)))))),
          h('div', { class: 'pl-st__block' }, h('strong', { class: 'pl-st__h' }, 'Charge vs capacité'),
            h('div', { class: `pl-cap${ratio > 1 ? ' is-over' : ''}`, style: { '--p': Math.min(100, ratio * 100) } }, h('div', { class: 'pl-cap__bar' }, h('i'))),
            h('p', { class: 'small muted' }, !demand ? 'Rien à faire : capacité libre.' : ratio > 1 ? `Tu vises ${fmtDuration(demand)} pour ${fmtDuration(capacity)} de capacité : ${fmtDuration(demand - capacity)} de trop.` : `${fmtDuration(demand)} à faire pour ${fmtDuration(capacity)} de capacité (${pct(ratio)}) — il te reste de la marge.`))));
    }

    // ═══════════════════════ Assemblage & rendu ═══════════════════════
    const lower = h('div', { class: 'pl-lower' }, backlog, stats);
    root.append(qb, actionsBar, resultCard, board, lower, fileInput, dropOv, live);

    function renderAll() {
      if (!alive) return;
      if (S.dragging) { S.pending = true; return; }
      const D = derive();
      updateActions(D); updateResult(D); updateBoard(D); updateBacklog(D); updateStats(D);
      updateNow(D);
    }
    let raf = 0;
    const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; renderAll(); }); };
    const off = ctx.subscribe((_state, change) => { if (change && (change.type === 'tick' || change.type === 'clock')) { if (!S.dragging) updateNow(); } schedule(); });
    const onMq = () => { if (narrowMq.matches) S.mode = 'day'; else if (!S.userMode) S.mode = mq.matches ? 'week' : 'day'; else return; S.sigs.board = null; schedule(); };
    if (narrowMq.addEventListener) narrowMq.addEventListener('change', onMq);
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    refreshEntry();
    renderAll();

    return () => {
      alive = false; off(); cancelAnimationFrame(raf); clearInterval(phTimer);
      clearTimeout(clickTimer); for (const t of timers) clearTimeout(t); timers.clear();
      if (G) endGesture(true);
      window.removeEventListener('keydown', onSlash, true);
      for (const [t, f] of [['dragenter', onDragEnter], ['dragover', onDragOver], ['dragleave', onDragLeave], ['drop', onDrop]]) document.removeEventListener(t, f);
      if (mq.removeEventListener) mq.removeEventListener('change', onMq);
      if (narrowMq.removeEventListener) narrowMq.removeEventListener('change', onMq);
      if (dock) dock.remove();
      document.documentElement.classList.remove('pl-is-dragging');
    };
  },
};
