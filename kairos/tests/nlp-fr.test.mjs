// Tests de l'analyseur de saisie rapide. « Maintenant » = dimanche 22 novembre 2026, 14:00 (heure locale).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry, inferLoad } from '../site/js/core/nlp-fr.js';

const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const NOW = L(2026, 11, 22, 14, 0); // dimanche
const NOW_TUE = L(2026, 11, 24, 14, 0); // mardi
const NOW_LATE = L(2026, 11, 22, 23, 30); // dimanche, 23:30
const NOW_EVE = L(2026, 11, 22, 18, 0);

test('le calendrier de référence est bien un dimanche', () => {
  assert.equal(new Date(NOW).getDay(), 0);
  assert.equal(new Date(NOW_TUE).getDay(), 2);
});

// [phrase, attendu (sous-ensemble des champs), nowMs?]
const CASES = [
  // — événements : heure de début précise —
  ['Appeler le médecin demain à 14h', { kind: 'event', title: 'Appeler le médecin', startMs: L(2026, 11, 23, 14), endMs: L(2026, 11, 23, 15), durMin: 60 }],
  ['APPELER LE MEDECIN DEMAIN A 14H', { kind: 'event', title: 'APPELER LE MEDECIN', startMs: L(2026, 11, 23, 14) }],
  ['Déjeuner avec Paul jeudi 12h30 1h', { kind: 'event', title: 'Déjeuner avec Paul', startMs: L(2026, 11, 26, 12, 30), endMs: L(2026, 11, 26, 13, 30), durMin: 60 }],
  ['Dentiste après-demain 9h15', { kind: 'event', title: 'Dentiste', startMs: L(2026, 11, 24, 9, 15) }],
  ['dentiste apres demain a 9h15', { kind: 'event', title: 'Dentiste', startMs: L(2026, 11, 24, 9, 15) }],
  ['Réunion équipe dans 3 jours à 10h', { kind: 'event', title: 'Réunion équipe', startMs: L(2026, 11, 25, 10) }],
  ['Prendre un verre ce soir à 20h', { kind: 'event', title: 'Prendre un verre', startMs: L(2026, 11, 22, 20) }],
  ['Dîner ce soir 8h', { kind: 'event', title: 'Dîner', startMs: L(2026, 11, 22, 20) }],
  ['Cinéma samedi 20h30', { kind: 'event', title: 'Cinéma', startMs: L(2026, 11, 28, 20, 30) }],
  ['Réunion de 14h à 16h demain', { kind: 'event', title: 'Réunion', startMs: L(2026, 11, 23, 14), endMs: L(2026, 11, 23, 16), durMin: 120 }],
  ['Cours 9h-11h30 mardi', { kind: 'event', title: 'Cours', startMs: L(2026, 11, 24, 9), endMs: L(2026, 11, 24, 11, 30), durMin: 150 }],
  ['Atelier de 10 à 12h jeudi', { kind: 'event', title: 'Atelier', startMs: L(2026, 11, 26, 10), endMs: L(2026, 11, 26, 12) }],
  ['rdv dentiste le 15 décembre à 10h30', { kind: 'event', title: 'Rdv dentiste', startMs: L(2026, 12, 15, 10, 30) }],
  ['Yoga à 18h pendant 45 min', { kind: 'event', title: 'Yoga', startMs: L(2026, 11, 22, 18), endMs: L(2026, 11, 22, 18, 45), durMin: 45 }],
  ['Appel client demain 9h30 !2', { kind: 'event', title: 'Appel client', startMs: L(2026, 11, 23, 9, 30), priority: 2 }],
  ['Déjeuner à midi', { kind: 'event', title: 'Déjeuner', startMs: L(2026, 11, 23, 12) }], // 12:00 aujourd'hui est passé
  ['Café demain midi', { kind: 'event', title: 'Café', startMs: L(2026, 11, 23, 12) }],
  ['Pot de départ vendredi 17:30', { kind: 'event', title: 'Pot de départ', startMs: L(2026, 11, 27, 17, 30) }],
  ['Appeler Paul dans 20 min', { kind: 'event', title: 'Appeler Paul', startMs: L(2026, 11, 22, 14, 20) }],
  ['Sieste dans 1h', { kind: 'event', title: 'Sieste', startMs: L(2026, 11, 22, 15) }],
  ['Négocier le contrat avec Paul vendredi 14h', { kind: 'event', title: 'Négocier le contrat avec Paul', startMs: L(2026, 11, 27, 14) }],
  ['Réunion lundi prochain 10h', { kind: 'event', title: 'Réunion', startMs: L(2026, 11, 23, 10) }],

  // — tâches : échéances, fenêtres, charge —
  ['Finir le rapport 2h avant vendredi 17h', { kind: 'task', title: 'Finir le rapport', durMin: 120, deadlineMs: L(2026, 11, 27, 17), load: 4 }],
  ['Rendre le rapport vendredi 17h', { kind: 'task', title: 'Rendre le rapport', deadlineMs: L(2026, 11, 27, 17) }],
  ['Finir le dossier pour vendredi', { kind: 'task', title: 'Finir le dossier', deadlineMs: L(2026, 11, 27, 18) }],
  ['Répondre aux mails demain 30 min', { kind: 'task', title: 'Répondre aux mails', durMin: 30, load: 1, deadlineMs: L(2026, 11, 23, 18) }],
  ['rédiger le rapport trimestriel vendredi #deep !!', { kind: 'task', title: 'Rédiger le rapport trimestriel', load: 5, priority: 1, tags: ['deep'], deadlineMs: L(2026, 11, 27, 18) }],
  ['Ranger le bureau #leger', { kind: 'task', title: 'Ranger le bureau', load: 1, tags: ['leger'] }],
  ['Coder la page de login 3h', { kind: 'task', title: 'Coder la page de login', load: 5, durMin: 180 }],
  ['Réviser chimie ce soir', { kind: 'task', title: 'Réviser chimie', load: 4, earliestMs: L(2026, 11, 22, 18), deadlineMs: L(2026, 11, 22, 23) }],
  ['Sport demain matin 45 min', { kind: 'task', title: 'Sport', durMin: 45, earliestMs: L(2026, 11, 23, 8), deadlineMs: L(2026, 11, 23, 12) }],
  ['Appeler maman lundi prochain', { kind: 'task', title: 'Appeler maman', load: 1, deadlineMs: L(2026, 11, 23, 18) }],
  ['Rendre le devoir pour le 12 décembre', { kind: 'task', title: 'Rendre le devoir', deadlineMs: L(2026, 12, 12, 18) }],
  ['Payer la facture le 3/12 !1', { kind: 'task', title: 'Payer la facture', priority: 1, load: 1, deadlineMs: L(2026, 12, 3, 18) }],
  ['Projet final dans 2 semaines', { kind: 'task', title: 'Projet final', deadlineMs: L(2026, 12, 6, 18) }],
  ['Envoyer la facture fin de semaine', { kind: 'task', title: 'Envoyer la facture', deadlineMs: L(2026, 11, 27, 18) }],
  ['Faire le bilan fin du mois', { kind: 'task', title: 'Faire le bilan', deadlineMs: L(2026, 11, 30, 18) }],
  ['Appeler le plombier avant 17h', { kind: 'task', title: 'Appeler le plombier', deadlineMs: L(2026, 11, 22, 17), load: 1 }],
  ['Réviser chimie après 14h', { kind: 'task', title: 'Réviser chimie', earliestMs: L(2026, 11, 22, 14), load: 4 }],
  ['Écrire le chapitre à rendre avant demain', { kind: 'task', title: 'Écrire le chapitre à rendre', deadlineMs: L(2026, 11, 23, 18), load: 4 }],
  ['Dîner chez Paul samedi soir', { kind: 'task', title: 'Dîner chez Paul', earliestMs: L(2026, 11, 28, 18), deadlineMs: L(2026, 11, 28, 23) }],
  ['Sortie vélo ce week-end', { kind: 'task', title: 'Sortie vélo', earliestMs: L(2026, 11, 22), deadlineMs: L(2026, 11, 22, 18) }], // dimanche : il reste aujourd'hui
  ['Sortie vélo ce week-end', { kind: 'task', title: 'Sortie vélo', earliestMs: L(2026, 11, 28), deadlineMs: L(2026, 11, 29, 18) }, NOW_TUE],
  ['Faire les courses samedi', { kind: 'task', title: 'Faire les courses', load: 1, deadlineMs: L(2026, 11, 28, 18) }],
  ['Brainstorm projet une heure', { kind: 'task', title: 'Brainstorm projet', durMin: 60, load: 4 }],
  ['Lire le chapitre 12 1h30', { kind: 'task', title: 'Lire le chapitre 12', durMin: 90 }],
  ['Sport 1 h 30', { kind: 'task', title: 'Sport', durMin: 90 }],
  ['Méditer pendant 2h', { kind: 'task', title: 'Méditer', durMin: 120 }],
  ['Marche une demi-heure', { kind: 'task', title: 'Marche', durMin: 30 }],
  ['Analyser les ventes 2h #deep demain', { kind: 'task', title: 'Analyser les ventes', durMin: 120, load: 5, tags: ['deep'], deadlineMs: L(2026, 11, 23, 18) }],
  ['Appeler le client urgent', { kind: 'task', title: 'Appeler le client', priority: 1, load: 1 }],
  ['Acheter du pain @maison', { kind: 'task', title: 'Acheter du pain', tags: ['maison'], load: 3 }],
  ['pas urgent ranger le garage', { kind: 'task', title: 'Ranger le garage', priority: 4, load: 1 }],
  ['Révision examen jeudi prochain 2h', { kind: 'task', title: 'Révision examen', durMin: 120, load: 4, deadlineMs: L(2026, 11, 26, 18) }], // dimanche : la semaine suivante commence demain
  ['Bilan 1er décembre', { kind: 'task', title: 'Bilan', deadlineMs: L(2026, 12, 1, 18) }],
  ['Examen le 15', { kind: 'task', title: 'Examen', deadlineMs: L(2026, 12, 15, 18) }],
  ['Finir ça aujourd\'hui', { kind: 'task', title: 'Finir ça', deadlineMs: L(2026, 11, 22, 18) }],
  ['Planifier la semaine', { kind: 'task', title: 'Planifier la semaine', load: 4 }],
  ['Appeler Sam demain', { kind: 'task', title: 'Appeler Sam', deadlineMs: L(2026, 11, 23, 18) }],
  ['Penser à l\'idée du siècle', { kind: 'task', title: 'Penser à l\'idée du siècle', load: 3 }],

  // — cas limites —
  ['Rapport mardi', { kind: 'task', title: 'Rapport', deadlineMs: L(2026, 12, 1, 18) }, NOW_TUE], // « mardi » dit un mardi = mardi prochain
  ['Rapport ce mardi', { kind: 'task', title: 'Rapport', deadlineMs: L(2026, 11, 24, 18) }, NOW_TUE],
  ['Rapport aujourd\'hui', { kind: 'task', deadlineMs: L(2026, 11, 22, 23, 59) }, L(2026, 11, 22, 20)], // 18:00 déjà passé
  ['Appeler à 7h', { kind: 'event', title: 'Appeler', startMs: L(2026, 11, 23, 7) }, NOW_LATE], // passage minuit
  ['Veille à minuit', { kind: 'event', title: 'Veille', startMs: L(2026, 11, 23, 0) }, NOW_LATE],
  ['Rapport à finir avant 17h', { kind: 'task', title: 'Rapport à finir', deadlineMs: L(2026, 11, 23, 17) }, NOW_EVE], // 17h est passé : demain
  ['Soirée de 22h à 2h demain', { kind: 'event', startMs: L(2026, 11, 23, 22), endMs: L(2026, 11, 24, 2), durMin: 240 }],
  ['Acheter un cadeau pour Paul', { kind: 'task', title: 'Acheter un cadeau pour Paul' }], // « pour » sans date : pas un jeton
  ['Appeler le 15 minutes', { kind: 'task' }],
];

for (const [text, expected, now] of CASES) {
  test(`« ${text} »`, () => {
    const r = parseEntry(text, now ?? NOW);
    for (const [k, v] of Object.entries(expected)) {
      assert.deepEqual(r[k], v, `${k} : attendu ${JSON.stringify(v)}, obtenu ${JSON.stringify(r[k])} (résultat ${JSON.stringify(r)})`);
    }
    // Invariants communs
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    assert.ok(Array.isArray(r.tags));
    for (const t of r.tokens) assert.equal(text.slice(t.start, t.end), t.text);
    if (r.kind === 'event') {
      assert.ok(r.endMs > r.startMs);
      assert.equal(r.durMin, Math.round((r.endMs - r.startMs) / 60000));
      assert.equal(r.deadlineMs, undefined);
    }
  });
}

test('le nombre de cas de la table dépasse 40', () => {
  assert.ok(CASES.length >= 40, `seulement ${CASES.length}`);
});

test('phrase vide ou invalide', () => {
  for (const x of ['', '   ', undefined, null, 42, {}]) {
    const r = parseEntry(x, NOW);
    assert.equal(r.kind, 'task');
    assert.equal(r.title, '');
    assert.equal(r.confidence, 0);
    assert.deepEqual(r.tokens, []);
    assert.deepEqual(r.tags, []);
  }
});

test('durée absente : pas de durMin pour une tâche, 60 min par défaut pour un événement', () => {
  assert.equal(parseEntry('Acheter du pain', NOW).durMin, undefined);
  assert.equal(parseEntry('Dentiste demain à 9h', NOW).durMin, 60);
});

test('jetons : types, ordre et surlignage', () => {
  const text = 'Finir le rapport 2h avant vendredi 17h #deep !!';
  const r = parseEntry(text, NOW);
  const types = r.tokens.map((t) => t.type);
  for (const ty of ['duration', 'date', 'time', 'tag', 'priority', 'load']) assert.ok(types.includes(ty), ty);
  for (let i = 1; i < r.tokens.length; i++) assert.ok(r.tokens[i].start >= r.tokens[i - 1].start);
  const nonLoad = r.tokens.filter((t) => t.type !== 'load');
  for (let i = 1; i < nonLoad.length; i++) assert.ok(nonLoad[i].start >= nonLoad[i - 1].end, 'pas de chevauchement');
  assert.equal(r.tokens.find((t) => t.type === 'tag').text, '#deep');
});

test('le titre ne contient aucun jeton reconnu (hors mots de charge)', () => {
  const r = parseEntry('Dentiste jeudi à 9h #sante !!', NOW);
  assert.equal(r.title, 'Dentiste');
  assert.deepEqual(r.tags, ['sante']);
});

test('confiance : plus on reconnaît d\'éléments, plus elle monte', () => {
  const a = parseEntry('Acheter du pain', NOW).confidence;
  const b = parseEntry('Acheter du pain demain', NOW).confidence;
  const c = parseEntry('Rédiger le rapport 2h avant vendredi 17h #deep', NOW).confidence;
  assert.ok(a < b && b < c, `${a} ${b} ${c}`);
  assert.ok(a < 0.6);
  assert.ok(c > 0.8);
});

test('#deep = charge 5, #leger = charge 1, même contre les mots du titre', () => {
  assert.equal(parseEntry('Répondre aux mails #deep', NOW).load, 5);
  assert.equal(parseEntry('Concevoir l\'architecture #leger', NOW).load, 1);
});

test('inferLoad : verbes exigeants, tâches routinières, défaut', () => {
  for (const t of ['rédiger', 'coder une API', 'concevoir', 'réfléchir à la stratégie', 'analyser', 'étudier', 'réviser', 'écrire', 'négocier']) {
    assert.ok(inferLoad(t) >= 4, t);
  }
  for (const t of ['répondre aux mails', 'ranger', 'appeler le garage', 'rembourser Paul', 'tâche admin']) {
    assert.ok(inferLoad(t) <= 2, t);
  }
  assert.equal(inferLoad('Promener le chien'), 3);
  assert.equal(inferLoad(''), 3);
});

test('une échéance avec « avant » n\'est jamais un événement', () => {
  const r = parseEntry('Dossier avant vendredi 17h', NOW);
  assert.equal(r.kind, 'task');
  assert.equal(r.deadlineMs, L(2026, 11, 27, 17));
});

test('« dès lundi » = au plus tôt lundi ; « après lundi » = mardi', () => {
  assert.equal(parseEntry('Commencer dès lundi', NOW).earliestMs, L(2026, 11, 23));
  assert.equal(parseEntry('Commencer après lundi', NOW).earliestMs, L(2026, 11, 24));
});

test('date absolue passée : année suivante', () => {
  const r = parseEntry('Anniversaire le 3 mars', NOW);
  assert.equal(r.deadlineMs, L(2027, 3, 3, 18));
});

test('robustesse : entrées bizarres ne plantent jamais', () => {
  const weird = ['!!!!!!', '#', '@', '## ##', '99h99', '32 décembre', '31/02', 'à à à', 'avant', 'pour', '2h 2h 2h', '🙂 demain 🙂 à 14h', 'x'.repeat(5000), '0h', '24h', '25h', 'le 0', 'dans -3 jours', 'dans 99999 jours'];
  for (const t of weird) {
    const r = parseEntry(t, NOW);
    assert.ok(['task', 'event'].includes(r.kind), t);
    for (const k of ['startMs', 'endMs', 'deadlineMs', 'earliestMs']) {
      if (r[k] !== undefined) assert.ok(Number.isFinite(r[k]), `${t} -> ${k}`);
    }
    for (const tok of r.tokens) assert.equal(t.slice(tok.start, tok.end), tok.text);
  }
});
