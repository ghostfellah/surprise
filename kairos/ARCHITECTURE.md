# Kairos — contrat d'architecture

> **Kairos** : l'emploi du temps de ton cerveau. Un planificateur de journée qui prédit ton énergie
> (rythme circadien + pression de sommeil + caféine) et place chaque tâche là où ton cerveau est le meilleur.
> 100 % local, hors-ligne, sans compte, sans serveur, sans dépendance. Interface en **français**.

Ce document est le **contrat** entre les modules. Chaque agent écrit ses propres fichiers (voir « Propriété »)
et respecte les signatures ci-dessous. Si une signature doit évoluer, on l'**étend** (nouveaux champs
optionnels), on ne casse jamais l'existant.

## Règles générales

- JavaScript **ESM** (`"type":"module"` à la racine du dépôt), **zéro dépendance** npm, aucun CDN, aucune police externe
  (piles de polices système uniquement). Tout doit marcher hors-ligne une fois la page chargée.
- `site/js/core/**` = logique **pure** : aucun accès à `window`, `document`, `localStorage`. Importable dans Node 22
  et dans le navigateur. Testée avec `node:test` (`kairos/tests/*.test.mjs`, lancés par `npm test`, `TZ=Europe/Paris`).
- Temps : **millisecondes epoch**. Jour = jour civil local. Utiliser `core/time.js` (déjà écrit, ne pas le modifier
  sans l'étendre). Les tests construisent leurs dates avec `new Date(y, m, d, h)` (heure locale) ou `fromDayKey`.
- Le code est commenté en **français** (le « pourquoi », pas le « quoi »). Textes UI en français, ton direct et chaleureux, vouvoiement évité (tutoiement).
- Déterminisme : toute aléa passe par `rng(seed)` de `time.js`.
- Honnêteté scientifique : l'app est un outil de **confort et d'organisation**, pas un dispositif médical. Les
  limites du modèle sont affichées (docs/science.md + écran « La science »).
- Style de code : pas de classes inutiles, fonctions petites, noms explicites. Pas de `console.log` en production.

## Arborescence et propriété

```
kairos/
  ARCHITECTURE.md            (ce fichier — lecture seule pour les agents)
  README.md                  agent DOCS
  docs/science.md            agent MOTEUR      docs/etude.md   agent ÉTUDE
  site/
    index.html               agent SHELL (page complète, charge css/app.css et js/ui/app.js en module)
    manifest.webmanifest, sw.js, icons/*       agent SHELL
    css/app.css              agent SHELL (design system, tokens, composants)  [les vues ajoutent leurs styles dans css/views-<nom>.css]
    js/core/
      time.js                (fait)
      chrono.js caffeine.js sleep.js jetlag.js model.js          agent MOTEUR
      scheduler.js personalize.js                                 agent PLANIF
      nlp-fr.js ics.js crypto.js                                  agent DONNÉES
      demo.js insights.js                                         agent VUES-3
    js/store.js              agent DONNÉES
    js/ui/
      dom.js, charts.js, palette.js, app.js, modal.js, toast.js   agent SHELL
      views/today.js views/lab.js                                 agent VUES-1
      views/plan.js                                               agent VUES-2
      views/sleep.js views/travel.js views/insights.js views/settings.js views/science.js   agent VUES-3
  tests/*.test.mjs           chaque agent teste SES modules
```

## Modèle de données (état persistant)

```js
State = {
  version: 1,
  profile: Profile,
  sleeps:   SleepLog[],      // triés par wakeMs croissant
  caffeine: CaffeineLog[],   // triés par tMs
  checkins: CheckIn[],       // triés par tMs
  tasks:    Task[],
  events:   Event[],         // événements fixes (agenda)
  plan:     { generatedMs: number, horizonDays: number, blocks: Block[] } | null,
  focus:    FocusSession[],
  prefs:    Prefs,
}

Profile = {
  chronoShiftMin: 0,        // décalage personnel de la phase circadienne en minutes (+ = plus tard / « oiseau de nuit »)
  sleepNeedH: 8,            // besoin de sommeil (h), 6–10
  caffeineSensitivity: 1,   // multiplicateur d'effet 0.4–2
  caffeineHalfLifeH: 5,     // demi-vie de la caféine (h), 3–9
  usualWake: "07:00",       // HH:MM, utilisés pour simuler le futur
  usualBed:  "23:00",
  workStart: "09:00", workEnd: "18:00",   // plages où l'on accepte de planifier des tâches
  workDays: [1,2,3,4,5],    // 0 = dimanche
  tz: "Europe/Paris",
  fit: null | { fittedMs, n, rmse, baselineRmse, r2, confidence } // dernier ajustement personnel
}
SleepLog    = { id, bedMs, wakeMs, quality?: 1..5, nap?: boolean }   // nap=true pour une sieste
CaffeineLog = { id, tMs, mg, kind?: "café"|"thé"|"expresso"|"maté"|"boisson énergisante"|"autre" }
CheckIn     = { id, tMs, alertness: 1..5, note? }                     // « comment te sens-tu ? »
Task = {
  id, title, durMin,                 // durée totale en minutes
  load: 1..5,                        // exigence cognitive (1 = routine, 5 = concentration profonde)
  priority: 1..4,                    // 1 = urgent … 4 = un jour
  deadlineMs?, earliestMs?,          // contraintes de fenêtre
  splittable?: boolean,              // peut être découpée en blocs (défaut true si durMin > 90)
  minBlockMin?: number,              // taille mini d'un bloc (défaut 25)
  done: boolean, doneMs?, tags: string[], notes?: string, createdMs: number,
}
Event = { id, title, startMs, endMs, source: "manual"|"ics", allDay?: boolean, uid?: string }
Block = { taskId, startMs, endMs, score: number, reason: string, locked?: boolean }
FocusSession = { id, taskId?, startMs, endMs, plannedMin, rating?: 1..5 }
Prefs = { theme: "auto"|"light"|"dark", notifications: boolean, weekStart: 1, demo: boolean, onboarded: boolean }
```

## Moteur scientifique (agent MOTEUR) — `site/js/core/`

Modèle : **processus à deux composantes de Borbély** (S homéostatique + C circadien) + inertie du sommeil + creux
post-prandial/ultradien en option + **caféine** (pharmacocinétique d'ordre 1, antagonisme de l'adénosine).
Chaque paramètre doit être justifié dans `docs/science.md` avec une source (auteur, année).

```js
// model.js — LE point d'entrée utilisé par toute l'UI
buildModel({ profile, sleeps, caffeine, fromMs, hours = 24, stepMin = 5, nowMs = fromMs,
             whatIf?: { sleeps?: SleepLog[], caffeine?: CaffeineLog[], extraNaps?: {startMs,endMs}[] } }) => Model
Model = {
  t0: number,            // = fromMs
  stepMin: number, n: number,        // n = round(hours*60/stepMin)+1 échantillons : t(i) = t0 + i*stepMin*60000
  alert: number[],       // 0..100 — alerte prédite finale (avec caféine). Pendant le sommeil : valeur basse (≤ 15)
  alertBase: number[],   // 0..100 — sans caféine
  caffeineMg: number[],  // caféine active dans le sang (mg)
  S: number[],           // pression de sommeil 0..1
  C: number[],           // composante circadienne −1..1
  asleep: boolean[],     // dormir : réel (journaux) ou supposé (profile.usualBed/usualWake pour le futur)
  zones: Zone[],         // pics, creux, fenêtre de coupure caféine, mélatonine, sommeil…
  stats: { peak: {ms,value}, trough: {ms,value}, dlmoMs: number, sleepDebtH: number,
           caffeineAtBedMg: number, goldenWindows: {startMs,endMs,mean}[] }  // fenêtres « prime time »
}
Zone = { kind: "peak"|"dip"|"sleep"|"winddown"|"caffeine-cutoff"|"melatonin"|"golden", startMs, endMs, label }
valueAt(series: number[], model, ms) => number          // interpolation linéaire, bornée
meanAlert(model, startMs, endMs, { series = "alert" } = {}) => number
slotIndex(model, ms) => number                          // index d'échantillon le plus proche (borné)

// chrono.js    : DEFAULT_PARAMS, simulateProcesses({sleeps, profile, fromMs, toMs, stepMin}) -> {S,C,asleep,...}
// caffeine.js  : caffeineCurve(logs, profile, t0, stepMin, n) -> number[]   (mg)
//                alertnessBoost(mg, profile) -> number (points d'alerte)
//                caffeineCutoff({logs, profile, bedMs, thresholdMg = 25}) -> ms  (dernière heure raisonnable)
//                suggestCaffeine({model inputs, wantPeakAtMs?}) -> [{tMs, mg, why}]
// sleep.js     : sleepDebt(sleeps, profile, nowMs, days = 14) -> {debtH, perNight[]}
//                suggestBedtime({wakeMs, profile, nowMs}) -> {bedMs, cycles, durationMin, alternatives[]}
//                planNap({model, nowMs}) -> {startMs, durMin, why} | null     (évite l'inertie, ≤ 25 min ou 90 min)
//                chronotypeEstimate(sleeps) -> {msfscMin, label, confidence}   (MSFsc de Roenneberg)
// jetlag.js    : tzOffsetMin(tz, ms) -> number ; planJetlag({originTz, destTz, departMs, arriveMs, profile})
//                -> { shiftH, direction: "est"|"ouest", days: [{dayMs, sleepBed, sleepWake, seekLight:[{start,end}],
//                     avoidLight:[{start,end}], advice: string, residualH}] }
```

`stepMin` vaut 5 par défaut ; les durées de tâches sont multiples de 5.

## Planificateur (agent PLANIF) — `site/js/core/scheduler.js`, `personalize.js`

Le planificateur **ne dépend pas** de model.js : il reçoit un tableau d'alerte (ex. `model.alert`).

```js
// scheduler.js
schedule({
  tasks: Task[], events: Event[],
  curve: { t0, stepMin, alert: number[] },        // couvre tout l'horizon (ex. 7 jours)
  nowMs, horizonEndMs,
  profile,                                          // workStart/workEnd/workDays
  locked?: Block[],                                 // blocs verrouillés à conserver
  options?: { seed = 1, iterations = 4000, breakMin = 10, maxBlockMin = 120, protectLunch = true }
}) => {
  blocks: Block[],                                   // triés par startMs ; reason en français : « Pic d'alerte (84/100), idéal pour du travail profond »
  unplaced: { taskId, why: string }[],               // « Pas assez de créneaux avant l'échéance »
  score: number, baselineScore: number,              // score total vs. planification naïve (chronologique) → gain %
  stats: { placedMin, unplacedMin, meanFit, lift }   // lift = (score/baselineScore − 1)
}
// Fonction de coût : adéquation charge cognitive ↔ alerte (tâche exigeante dans un creux = pénalité forte),
// respect des échéances (dur), priorités, fragmentation, pauses, déjeuner protégé, pas de chevauchement avec les événements.
// Algorithme : construction gloutonne + recuit simulé déterministe (seed). Temps d'exécution < 400 ms pour 40 tâches × 7 jours.
explainBlock(block, task, curve) -> string

// personalize.js — ajustement personnel, générique et testé
fitParams({
  params: { [name]: { value, min, max } },
  evaluate: (values: {[name]:number}) => number[],   // prédictions aux instants des check-ins (même ordre que `targets`)
  targets: number[],                                  // observations (alerte ramenée sur 0..100)
  regularization?: number, maxIter?: number
}) => { values, rmse, baselineRmse, r2, n, confidence: 0..1, converged: boolean, history }
// Nelder-Mead borné + validation croisée « leave-one-out » pour la confiance ; refuse (confidence 0) si n < 8.
checkinToAlert(v: 1..5) => 0..100 ; alertToCheckin(a) => 1..5
```

## Données (agent DONNÉES)

```js
// nlp-fr.js
parseEntry(text, nowMs) => {
  kind: "task"|"event", title, durMin?, load?, priority?, deadlineMs?, earliestMs?,
  startMs?, endMs?, tags: string[], confidence: 0..1,
  tokens: { text, type: "date"|"time"|"duration"|"priority"|"tag"|"load", start, end }[]   // pour surligner la saisie
}
// Comprend : « demain », « lundi prochain », « dans 3 jours », « le 12 décembre », « ce soir », « avant 17h »,
// « à 14h30 », « 2h », « 45 min », « 1h30 », « #deep », « !!/!1 », « urgent », « @tag », verbes → charge cognitive
// (rédiger, coder, réfléchir, analyser = 4–5 ; répondre aux mails, ranger, appeler = 1–2).
// « Déjeuner avec Paul jeudi 12h30 1h » → event. « Finir le rapport 2h avant vendredi 17h » → task.

// ics.js
parseICS(text, { fromMs, toMs }) => Event[]            // VEVENT, DTSTART/DTEND/DURATION, all-day, UTC "Z", TZID (Intl), RRULE FREQ=DAILY|WEEKLY|MONTHLY + INTERVAL/BYDAY/COUNT/UNTIL, EXDATE
buildICS({ blocks, tasks, events, calName }) => string   // RFC 5545, CRLF, repli des lignes à 75 octets

// crypto.js (WebCrypto : globalThis.crypto.subtle, dispo dans Node 22)
encryptJSON(obj, passphrase) => Promise<string>         // PBKDF2-SHA256 (≥ 250 000 itérations) + AES-GCM, base64url, préfixe "kairos1."
decryptJSON(payload, passphrase) => Promise<any>        // rejette avec Error("Mot de passe incorrect ou données corrompues")

// store.js
createStore({ backend?, now? = Date.now }) => Store
Backend = { load(): Promise<string|null>, save(json: string): Promise<void> }   // défaut : IndexedDB, repli localStorage, repli mémoire
Store = {
  ready: Promise<void>,
  getState(): State,
  subscribe(fn: (state, change: {type: string}) => void): () => void,
  undo(): boolean, redo(): boolean, canUndo(): boolean, canRedo(): boolean,
  actions: {
    addTask(partial) -> Task, updateTask(id, patch), removeTask(id), completeTask(id, done = true),
    addEvent(partial) -> Event, updateEvent(id, patch), removeEvent(id), replaceEvents(source, events),
    logSleep({bedMs, wakeMs, quality?, nap?}) -> SleepLog, removeSleep(id),
    logCaffeine({tMs, mg, kind?}) -> CaffeineLog, removeCaffeine(id),
    logCheckIn({tMs, alertness, note?}) -> CheckIn, removeCheckIn(id),
    setProfile(patch), setPrefs(patch),
    setPlan(plan|null), lockBlock(taskId, startMs, locked = true),
    logFocus(session) -> FocusSession,
    loadState(state), loadDemo(demoState), resetAll(),
    exportJSON() -> string, importJSON(str), exportEncrypted(pass) -> Promise<string>, importEncrypted(str, pass) -> Promise<void>,
  },
}
// Persistance : sauvegarde différée (debounce 150 ms) + à chaque `visibilitychange`; migrations par `version`; validation défensive à l'import
// (jamais de crash sur un JSON malformé : lever une Error française lisible).
```

## Vues (agents VUES-*) et shell (agent SHELL)

Routage par hash : `#/today` (défaut), `#/plan`, `#/lab`, `#/sleep`, `#/travel`, `#/insights`, `#/settings`, `#/science`.

Chaque vue est un module `site/js/ui/views/<nom>.js` avec un export par défaut :

```js
export default {
  id: "today", title: "Aujourd'hui", icon: "sun",         // icon = nom d'une icône SVG de dom.js
  mount(root: HTMLElement, ctx: Ctx) -> (() => void) | void   // retourne la fonction de nettoyage
}
```
La vue se redessine elle-même : `const off = ctx.subscribe(render)` (le shell appelle déjà `off` au démontage si la vue le renvoie via cleanup).

```js
Ctx = {
  store, actions /* = store.actions */, get state(),
  subscribe(fn) -> off,                              // changements d'état + de l'horloge (tick chaque minute)
  nowMs(): number,                                   // horloge de l'app (remontable dans le temps avec la barre « voyage dans le temps »)
  model(opts?) -> Model                              // buildModel mémoïsé : opts = { fromMs, hours, whatIf }, par défaut aujourd'hui 00:00 → +24 h
  planHorizon(days = 7) -> Model                     // modèle étendu pour le planificateur
  runPlanner(opts?) -> ScheduleResult                // applique scheduler.schedule avec l'état courant ; ne sauvegarde pas
  applyPlan(result)                                  // actions.setPlan(...)
  navigate(hash), toast(msg, { kind: "ok"|"warn"|"err", undoLabel?, onUndo? }),
  confirm(msg, { okLabel?, danger? }) -> Promise<boolean>,
  openTaskEditor(taskId?: string, preset?: Partial<Task>) -> Promise<Task|null>,
  openQuickAdd(), openPalette(), startFocus({taskId?, minutes}), 
  h, svg, icon, charts,                              // dom.js + charts.js
}
```

**dom.js** : `h(tag, props?, ...children)` (props : `class`, `style` objet, `on*`, `dataset`, `aria-*`, booléens ; enfants texte/Node/tableaux/null),
`svg(tag, props, ...children)`, `icon(name, {size})` (≥ 40 icônes SVG inline soignées : sun, moon, coffee, bolt, brain, calendar, list, flask, plane,
chart, gear, plus, check, trash, lock, unlock, play, pause, undo, redo, search, download, upload, sparkle, clock, alert, info, battery, heart, leaf, target, flame, wand…),
`fmt` (réexport de time.js), `$`, `$$`, `on`, `debounce`, `clsx`.

**charts.js** (canvas 2D, haute densité de pixels, thème clair/sombre via variables CSS lues à chaque rendu, accessible : `aria-label` + description texte) :
- `alertnessChart(canvas, { model, compareModel?, nowMs, blocks?, events?, hoverMs?, onScrub?, range?: [startMs, endMs], showCaffeine, showSleep, showZones })` → `{ update(opts), destroy() }`. Le visage de l'app : ruban lumineux dégradé, zones d'or, courbe de caféine en pointillés, hachures de sommeil, curseur « maintenant », info-bulle au survol/toucher, blocs de tâches empilés sous la courbe colorés par charge.
- `heatmap(canvas, { rows, cols, values, ... })`, `barChart`, `sparkline`, `ringGauge`, `calibrationChart` (prédit vs. ressenti).
- Toutes les fonctions : redimensionnement auto (`ResizeObserver`), DPR, `destroy()` propre.

**Design** : identité « instrument de précision » — fond nuit profond, accent or ambré (`--sun`) pour l'énergie, bleu-vert (`--night`) pour le sommeil,
rouge corail pour alertes, typographie système (`ui-sans-serif` + `ui-monospace` pour les chiffres, `font-variant-numeric: tabular-nums`),
thèmes clair/sombre/auto, `prefers-reduced-motion` respecté, cibles tactiles ≥ 44 px, mobile d'abord (barre d'onglets en bas ≤ 760 px, rail latéral au-delà),
focus visibles, contrastes AA, `lang="fr"`.

PWA : `manifest.webmanifest` (nom Kairos, icônes SVG + maskable, `display: standalone`, `theme_color`), `sw.js` (cache-first versionné,
stale-while-revalidate pour les assets, page hors-ligne), `index.html` enregistre le SW seulement en `https:`/localhost.
Chemins **relatifs** partout (le site est servi sous `/kairos/` sur GitHub Pages).

## Qualité

- `npm test` doit passer (tous les modules `core/` + `store.js` sont couverts).
- Aucune erreur dans la console au chargement ni à la navigation (vérifié par Playwright en fin de chaîne).
- Chaque module `core/` documente ses hypothèses en tête de fichier.
