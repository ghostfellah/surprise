import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseICS, buildICS, foldLine, unfoldLines } from '../site/js/core/ics.js';

const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const U = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi, 0, 0);
const cal = (...vevents) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//FR', ...vevents.flat(), 'END:VCALENDAR'].join('\r\n');
const ev = (...props) => ['BEGIN:VEVENT', ...props, 'END:VEVENT'];
const WIDE = { fromMs: U(2026, 1, 1), toMs: U(2028, 1, 1) };

// ─────────────── Lecture : bases ───────────────

test('dépliage des lignes et échappements', () => {
  const ics = cal(ev('UID:a1', 'DTSTART:20261123T130000Z', 'DTEND:20261123T140000Z',
    'SUMMARY:Dîner\\, chez Paul\\; 20h\\nsuite de la\r\n  ligne pliée \\\\ fin'));
  const [e] = parseICS(ics, WIDE);
  assert.equal(e.title, 'Dîner, chez Paul; 20h suite de la ligne pliée \\ fin');
  assert.deepEqual(unfoldLines('A:1\r\n 2\r\nB:3'), ['A:12', 'B:3']);
});

test('UTC « Z », durée, source, uid, id stable', () => {
  const ics = cal(ev('UID:abc@x', 'DTSTART:20261123T130000Z', 'DURATION:PT1H30M', 'SUMMARY:Point'));
  const a = parseICS(ics, WIDE);
  const b = parseICS(ics, WIDE);
  assert.equal(a.length, 1);
  assert.equal(a[0].startMs, U(2026, 11, 23, 13));
  assert.equal(a[0].endMs, U(2026, 11, 23, 14, 30));
  assert.equal(a[0].source, 'ics');
  assert.equal(a[0].uid, 'abc@x');
  assert.equal(a[0].id, b[0].id);
  assert.equal(a[0].allDay, undefined);
});

test('DTSTART;TZID : Europe/Paris et America/New_York via Intl, bascule d\'heure comprise', () => {
  const ics = cal(
    ev('UID:p', 'DTSTART;TZID=Europe/Paris:20261123T090000', 'DTEND;TZID=Europe/Paris:20261123T100000', 'SUMMARY:Paris'),
    ev('UID:n', 'DTSTART;TZID=America/New_York:20261123T090000', 'DTEND;TZID=America/New_York:20261123T100000', 'SUMMARY:NY'),
    ev('UID:s', 'DTSTART;TZID=Europe/Paris:20260715T090000', 'DTEND;TZID=Europe/Paris:20260715T100000', 'SUMMARY:Ete'),
  );
  const r = Object.fromEntries(parseICS(ics, WIDE).map((e) => [e.title, e]));
  assert.equal(r.Paris.startMs, U(2026, 11, 23, 8)); // CET = UTC+1
  assert.equal(r.NY.startMs, U(2026, 11, 23, 14)); // EST = UTC-5
  assert.equal(r.Ete.startMs, U(2026, 7, 15, 7)); // CEST = UTC+2
});

test('noms de fuseau Windows (Outlook) et préfixe Mozilla', () => {
  const ics = cal(
    ev('UID:w', 'DTSTART;TZID=Romance Standard Time:20261123T090000', 'DTEND;TZID=Romance Standard Time:20261123T100000', 'SUMMARY:Outlook'),
    ev('UID:m', 'DTSTART;TZID=/mozilla.org/20050126_1/Europe/Paris:20261123T090000', 'DTEND;TZID=/mozilla.org/20050126_1/Europe/Paris:20261123T100000', 'SUMMARY:Thunderbird'),
    ev('UID:q', 'DTSTART;TZID="Pacific Standard Time":20261123T090000', 'DTEND;TZID="Pacific Standard Time":20261123T100000', 'SUMMARY:Quoted'),
  );
  const r = Object.fromEntries(parseICS(ics, WIDE).map((e) => [e.title, e]));
  assert.equal(r.Outlook.startMs, U(2026, 11, 23, 8));
  assert.equal(r.Thunderbird.startMs, U(2026, 11, 23, 8));
  assert.equal(r.Quoted.startMs, U(2026, 11, 23, 17));
});

test('heure flottante = heure locale de l\'appareil ; fuseau inconnu aussi', () => {
  const ics = cal(
    ev('UID:f', 'DTSTART:20261123T090000', 'DTEND:20261123T100000', 'SUMMARY:Flottant'),
    ev('UID:u', 'DTSTART;TZID=Mars/Olympus:20261123T090000', 'DTEND;TZID=Mars/Olympus:20261123T100000', 'SUMMARY:Inconnu'),
  );
  for (const e of parseICS(ics, WIDE)) assert.equal(e.startMs, L(2026, 11, 23, 9), e.title);
});

test('journée entière : VALUE=DATE, DTEND exclusif, allDay', () => {
  const ics = cal(
    ev('UID:j1', 'DTSTART;VALUE=DATE:20261125', 'DTEND;VALUE=DATE:20261126', 'SUMMARY:Férié'),
    ev('UID:j2', 'DTSTART;VALUE=DATE:20261125', 'DTEND;VALUE=DATE:20261128', 'SUMMARY:Séminaire'),
    ev('UID:j3', 'DTSTART;VALUE=DATE:20261125', 'SUMMARY:Sans fin'),
    ev('UID:j4', 'DTSTART;VALUE=DATE:20261125', 'DURATION:P2D', 'SUMMARY:Deux jours'),
  );
  const r = Object.fromEntries(parseICS(ics, WIDE).map((e) => [e.title, e]));
  assert.equal(r['Férié'].allDay, true);
  assert.equal(r['Férié'].startMs, L(2026, 11, 25));
  assert.equal(r['Férié'].endMs, L(2026, 11, 26));
  assert.equal(r['Séminaire'].endMs, L(2026, 11, 28));
  assert.equal(r['Sans fin'].endMs, L(2026, 11, 26));
  assert.equal(r['Deux jours'].endMs, L(2026, 11, 27));
});

test('sans DTEND ni DURATION : 30 min ; STATUS:CANCELLED ignoré ; DTSTART invalide ignoré', () => {
  const ics = cal(
    ev('UID:a', 'DTSTART:20261123T100000Z', 'SUMMARY:Court'),
    ev('UID:b', 'DTSTART:20261123T100000Z', 'DTEND:20261123T110000Z', 'STATUS:CANCELLED', 'SUMMARY:Annulé'),
    ev('UID:c', 'DTSTART:pas-une-date', 'SUMMARY:Cassé'),
    ev('UID:d', 'SUMMARY:Sans date'),
  );
  const r = parseICS(ics, WIDE);
  assert.deepEqual(r.map((e) => e.title), ['Court']);
  assert.equal(r[0].endMs - r[0].startMs, 30 * 60000);
});

test('borne [fromMs, toMs] : les événements hors plage sont ignorés, ceux qui chevauchent sont gardés', () => {
  const ics = cal(
    ev('UID:1', 'DTSTART:20261110T100000Z', 'DTEND:20261110T110000Z', 'SUMMARY:Avant'),
    ev('UID:2', 'DTSTART:20261122T230000Z', 'DTEND:20261123T020000Z', 'SUMMARY:Chevauche'),
    ev('UID:3', 'DTSTART:20261124T100000Z', 'DTEND:20261124T110000Z', 'SUMMARY:Dedans'),
    ev('UID:4', 'DTSTART:20261201T100000Z', 'DTEND:20261201T110000Z', 'SUMMARY:Après'),
  );
  const r = parseICS(ics, { fromMs: U(2026, 11, 23), toMs: U(2026, 11, 30) });
  assert.deepEqual(r.map((e) => e.title), ['Chevauche', 'Dedans']);
});

test('entrées vides, absurdes ou tronquées : jamais d\'exception', () => {
  for (const x of ['', null, undefined, 'n importe quoi', 'BEGIN:VCALENDAR', 'BEGIN:VEVENT\r\nDTSTART:2026', '﻿BEGIN:VCALENDAR\r\nEND:VCALENDAR']) {
    assert.deepEqual(parseICS(x, WIDE), []);
  }
  const trunc = cal(ev('UID:t', 'DTSTART:20261123T100000Z', 'SUMMARY:Ok')).slice(0, -30); // tronqué avant END
  assert.doesNotThrow(() => parseICS(trunc, WIDE));
});

test('les VTODO et les VALARM imbriqués ne polluent pas les événements', () => {
  const ics = cal(
    ['BEGIN:VTODO', 'UID:todo', 'DTSTART:20261123T100000Z', 'SUMMARY:À faire', 'END:VTODO'],
    ev('UID:e', 'DTSTART:20261123T100000Z', 'DTEND:20261123T110000Z', 'SUMMARY:Réunion',
      'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Rappel', 'SUMMARY:Alarme', 'END:VALARM'),
  );
  const r = parseICS(ics, WIDE);
  assert.equal(r.length, 1);
  assert.equal(r[0].title, 'Réunion');
});

// ─────────────── Récurrences ───────────────

test('DAILY + COUNT + INTERVAL', () => {
  const r = parseICS(cal(ev('UID:d', 'DTSTART:20261123T090000Z', 'DTEND:20261123T100000Z', 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=4', 'SUMMARY:Un jour sur deux')), WIDE);
  assert.deepEqual(r.map((e) => e.startMs), [U(2026, 11, 23, 9), U(2026, 11, 25, 9), U(2026, 11, 27, 9), U(2026, 11, 29, 9)]);
});

test('WEEKLY + BYDAY + UNTIL + EXDATE', () => {
  const ics = cal(ev('UID:w', 'DTSTART;TZID=Europe/Paris:20261123T090000', 'DTEND;TZID=Europe/Paris:20261123T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261209T235959Z', 'EXDATE;TZID=Europe/Paris:20261125T090000', 'SUMMARY:Cours'));
  const r = parseICS(ics, WIDE);
  const days = r.map((e) => new Date(e.startMs).toISOString().slice(0, 10));
  assert.deepEqual(days, ['2026-11-23', '2026-11-30', '2026-12-02', '2026-12-07', '2026-12-09']);
});

test('WEEKLY INTERVAL=2 sans BYDAY : le jour de DTSTART', () => {
  const r = parseICS(cal(ev('UID:w2', 'DTSTART:20261123T090000Z', 'DTEND:20261123T100000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3', 'SUMMARY:Bimensuel')), WIDE);
  assert.deepEqual(r.map((e) => e.startMs), [U(2026, 11, 23, 9), U(2026, 12, 7, 9), U(2026, 12, 21, 9)]);
});

test('l\'heure murale est conservée à travers le passage à l\'heure d\'hiver (25/10/2026)', () => {
  const ics = cal(ev('UID:dst', 'DTSTART;TZID=Europe/Paris:20261019T090000', 'DTEND;TZID=Europe/Paris:20261019T100000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:DST'));
  const r = parseICS(ics, WIDE);
  assert.equal(r[0].startMs, U(2026, 10, 19, 7)); // CEST
  assert.equal(r[1].startMs, U(2026, 10, 26, 8)); // CET : toujours 9:00 à Paris
});

test('MONTHLY : jour du mois, 2e mardi, dernier vendredi, jour 31 (mois courts ignorés)', () => {
  const mk = (rule, count) => parseICS(cal(ev('UID:m' + rule, 'DTSTART:20261001T100000Z', 'DTEND:20261001T110000Z', `RRULE:${rule}`, 'SUMMARY:M')), WIDE).slice(0, count).map((e) => new Date(e.startMs).toISOString().slice(0, 10));
  assert.deepEqual(mk('FREQ=MONTHLY;COUNT=3', 3), ['2026-10-01', '2026-11-01', '2026-12-01']);
  assert.deepEqual(mk('FREQ=MONTHLY;BYDAY=2TU;COUNT=3', 3), ['2026-10-13', '2026-11-10', '2026-12-08']);
  assert.deepEqual(mk('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', 3), ['2026-10-30', '2026-11-27', '2026-12-25']);
  assert.deepEqual(mk('FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3', 3), ['2026-10-31', '2026-12-31', '2027-01-31']);
  assert.deepEqual(mk('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3', 3), ['2026-10-30', '2026-11-30', '2026-12-31']);
});

test('YEARLY (extension)', () => {
  const r = parseICS(cal(ev('UID:y', 'DTSTART;VALUE=DATE:20260314', 'RRULE:FREQ=YEARLY;COUNT=3', 'SUMMARY:Anniversaire')), { fromMs: U(2026, 1, 1), toMs: U(2030, 1, 1) });
  assert.deepEqual(r.map((e) => new Date(e.startMs).getFullYear()), [2026, 2027, 2028]);
  assert.ok(r.every((e) => e.allDay));
});

test('expansion bornée à la fenêtre, avec saut direct (série démarrée en 2015)', () => {
  const ics = cal(ev('UID:old', 'DTSTART:20150105T080000Z', 'DTEND:20150105T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Vieille série'));
  const r = parseICS(ics, { fromMs: U(2026, 11, 23), toMs: U(2026, 12, 14) });
  assert.deepEqual(r.map((e) => new Date(e.startMs).toISOString().slice(0, 10)), ['2026-11-23', '2026-11-30', '2026-12-07']);
});

test('garde-fou : jamais plus de 2000 occurrences par série', () => {
  const ics = cal(ev('UID:inf', 'DTSTART:20200101T080000Z', 'DTEND:20200101T083000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Sans fin'));
  const r = parseICS(ics, { fromMs: U(2020, 1, 1), toMs: U(2035, 1, 1) });
  assert.equal(r.length, 2000);
  const r2 = parseICS(cal(ev('UID:big', 'DTSTART:20200101T080000Z', 'DTEND:20200101T083000Z', 'RRULE:FREQ=DAILY;COUNT=100000', 'SUMMARY:Énorme')), { fromMs: U(2020, 1, 1), toMs: U(2040, 1, 1) });
  assert.equal(r2.length, 2000);
});

test('RECURRENCE-ID : instance déplacée et instance annulée', () => {
  const ics = cal(
    ev('UID:s', 'DTSTART:20261123T090000Z', 'DTEND:20261123T100000Z', 'RRULE:FREQ=DAILY;COUNT=4', 'SUMMARY:Stand-up'),
    ev('UID:s', 'RECURRENCE-ID:20261124T090000Z', 'DTSTART:20261124T150000Z', 'DTEND:20261124T153000Z', 'SUMMARY:Stand-up (déplacé)'),
    ev('UID:s', 'RECURRENCE-ID:20261125T090000Z', 'DTSTART:20261125T090000Z', 'DTEND:20261125T100000Z', 'STATUS:CANCELLED', 'SUMMARY:Stand-up'),
  );
  const r = parseICS(ics, WIDE);
  assert.deepEqual(r.map((e) => [e.title, e.startMs]), [
    ['Stand-up', U(2026, 11, 23, 9)],
    ['Stand-up (déplacé)', U(2026, 11, 24, 15)],
    ['Stand-up', U(2026, 11, 26, 9)],
  ]);
});

test('EXDATE en journée entière et RDATE', () => {
  const ics = cal(
    ev('UID:ad', 'DTSTART;VALUE=DATE:20261123', 'DTEND;VALUE=DATE:20261124', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;VALUE=DATE:20261124', 'SUMMARY:Jour'),
    ev('UID:rd', 'DTSTART:20261123T090000Z', 'DTEND:20261123T100000Z', 'RDATE:20261130T090000Z,20261207T090000Z', 'SUMMARY:Ponctuel'),
  );
  const r = parseICS(ics, WIDE);
  assert.deepEqual(r.filter((e) => e.title === 'Jour').map((e) => e.startMs), [L(2026, 11, 23), L(2026, 11, 25)]);
  assert.equal(r.filter((e) => e.title === 'Ponctuel').length, 3);
});

test('FREQ non géré (HOURLY) : une seule occurrence, sans boucle infinie', () => {
  const r = parseICS(cal(ev('UID:h', 'DTSTART:20261123T090000Z', 'DTEND:20261123T093000Z', 'RRULE:FREQ=HOURLY;COUNT=5', 'SUMMARY:Horaire')), WIDE);
  assert.equal(r.length, 1);
});

// ─────────────── Vrais exports (fixtures) ───────────────

const GOOGLE = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:Perso
X-WR-TIMEZONE:Europe/Paris
BEGIN:VTIMEZONE
TZID:Europe/Paris
X-LIC-LOCATION:Europe/Paris
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART:20261123T130000Z
DTEND:20261123T140000Z
DTSTAMP:20261120T101500Z
UID:7q2k9m3n4p5r6s7t8u9v0w@google.com
CREATED:20261101T080000Z
DESCRIPTION:Préparer les slides\\nApporter l'ordinateur
LAST-MODIFIED:20261110T120000Z
LOCATION:Salle Pasteur\\, 2e étage
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Point d'équipe hebdo
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261211
DTEND;VALUE=DATE:20261212
DTSTAMP:20261120T101500Z
UID:allday1@google.com
SUMMARY:Anniversaire de Léa 🎂
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Paris:20261124T180000
DTEND;TZID=Europe/Paris:20261124T193000
RRULE:FREQ=WEEKLY;UNTIL=20261215T165959Z;BYDAY=TU
EXDATE;TZID=Europe/Paris:20261201T180000
DTSTAMP:20261120T101500Z
UID:yoga-series@google.com
SUMMARY:Yoga
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:This is an event reminder
TRIGGER:-P0DT0H30M0S
END:VALARM
END:VEVENT
BEGIN:VEVENT
DTSTART:20261126T090000Z
DTEND:20261126T100000Z
DTSTAMP:20261120T101500Z
UID:cancelled@google.com
STATUS:CANCELLED
SUMMARY:Annulé par l'organisateur
END:VEVENT
END:VCALENDAR
`;

test('export Google Agenda typique', () => {
  const r = parseICS(GOOGLE, { fromMs: U(2026, 11, 1), toMs: U(2027, 1, 1) });
  const byTitle = (t) => r.filter((e) => e.title === t);
  assert.equal(byTitle("Point d'équipe hebdo").length, 1);
  assert.equal(byTitle("Point d'équipe hebdo")[0].startMs, U(2026, 11, 23, 13));
  assert.equal(byTitle('Anniversaire de Léa 🎂')[0].allDay, true);
  assert.equal(byTitle('Anniversaire de Léa 🎂')[0].startMs, L(2026, 12, 11));
  // Yoga : mardis 24/11, (01/12 exclu), 08/12, 15/12 → UNTIL 15/12 16:59:59Z exclut 18:00 Paris du 15/12 (17:00Z)
  const yoga = byTitle('Yoga').map((e) => e.startMs);
  assert.deepEqual(yoga, [U(2026, 11, 24, 17), U(2026, 12, 8, 17)]);
  assert.equal(byTitle("Annulé par l'organisateur").length, 0);
  assert.ok(r.every((e) => e.source === 'ics' && typeof e.id === 'string' && e.endMs > e.startMs));
});

const APPLE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//macOS 14.5//EN
CALSCALE:GREGORIAN
BEGIN:VTIMEZONE
TZID:Europe/Paris
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
DTSTART:19810329T020000
TZNAME:UTC+2
TZOFFSETTO:+0200
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
DTSTART:19961027T030000
TZNAME:UTC+1
TZOFFSETTO:+0100
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
CREATED:20261015T091500Z
DTEND;TZID=Europe/Paris:20261125T120000
DTSTAMP:20261120T100000Z
DTSTART;TZID=Europe/Paris:20261125T110000
LAST-MODIFIED:20261015T091700Z
SEQUENCE:0
SUMMARY:Rendez-vous chez le dentiste
TRANSP:OPAQUE
UID:E2A5B1C0-1111-2222-3333-444455556666
BEGIN:VALARM
ACTION:AUDIO
TRIGGER:-PT1H
X-WR-ALARMUID:AAAA
END:VALARM
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261130
DTEND;VALUE=DATE:20261203
DTSTAMP:20261120T100000Z
SEQUENCE:0
SUMMARY:Congrès à Lyon
TRANSP:TRANSPARENT
UID:E2A5B1C0-7777-8888-9999-000011112222
END:VEVENT
END:VCALENDAR
`;

test('export Apple Calendrier typique (VTIMEZONE + VALARM + multi-jours)', () => {
  const r = parseICS(APPLE, WIDE);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'Rendez-vous chez le dentiste');
  assert.equal(r[0].startMs, U(2026, 11, 25, 10));
  assert.equal(r[0].endMs, U(2026, 11, 25, 11));
  assert.equal(r[1].allDay, true);
  assert.equal(r[1].endMs, L(2026, 12, 3)); // 3 jours : 30/11, 01/12, 02/12
});

const OUTLOOK = `BEGIN:VCALENDAR
METHOD:PUBLISH
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
X-WR-CALNAME:Calendrier
BEGIN:VTIMEZONE
TZID:Romance Standard Time
BEGIN:STANDARD
DTSTART:16010101T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
CLASS:PUBLIC
DESCRIPTION:Ordre du jour :\\n- Budget\\n- Recrutement\\n\\n
DTEND;TZID=Romance Standard Time:20261124T153000
DTSTAMP:20261120T091500Z
DTSTART;TZID=Romance Standard Time:20261124T140000
LAST-MODIFIED:20261120T091500Z
LOCATION:Teams
PRIORITY:5
RRULE:FREQ=WEEKLY;COUNT=3;INTERVAL=1;BYDAY=TU;WKST=MO
SEQUENCE:0
SUMMARY:Comité de pilotage - Direction des Systèmes d'Information et de la Transformation Numérique
TRANSP:OPAQUE
UID:040000008200E00074C5B7101A82E00800000000AABBCCDD
X-MICROSOFT-CDO-BUSYSTATUS:BUSY
X-MICROSOFT-CDO-IMPORTANCE:1
END:VEVENT
BEGIN:VEVENT
DTEND;TZID=Romance Standard Time:20261201T153000
DTSTART;TZID=Romance Standard Time:20261201T160000
RECURRENCE-ID;TZID=Romance Standard Time:20261201T140000
DTSTAMP:20261120T091500Z
SUMMARY:Comité de pilotage (reporté)
UID:040000008200E00074C5B7101A82E00800000000AABBCCDD
END:VEVENT
END:VCALENDAR
`;

test('export Outlook/Exchange typique (fuseau Windows, série + instance modifiée)', () => {
  const r = parseICS(OUTLOOK.replace(/\n/g, '\r\n'), WIDE);
  assert.equal(r.length, 3);
  assert.equal(r[0].startMs, U(2026, 11, 24, 13));
  assert.equal(r[0].title.startsWith('Comité de pilotage - Direction'), true);
  // 01/12 : l'instance déplacée (16:00 Paris = 15:00Z) remplace celle de 14:00 ; 08/12 normale
  assert.deepEqual(r.map((e) => e.startMs), [U(2026, 11, 24, 13), U(2026, 12, 1, 15), U(2026, 12, 8, 13)]);
  assert.equal(r[1].title, 'Comité de pilotage (reporté)');
});

// ─────────────── Écriture ───────────────

test('buildICS : structure RFC 5545, CRLF, lignes ≤ 75 octets, UID stables', () => {
  const now = U(2026, 11, 22, 14);
  const events = [
    { id: 'e1', title: 'Déjeuner, avec Paul; "chez Léa"\nsuite', startMs: U(2026, 11, 26, 11, 30), endMs: U(2026, 11, 26, 12, 30), source: 'manual' },
    { id: 'e2', title: 'Férié', startMs: L(2026, 12, 25), endMs: L(2026, 12, 26), source: 'manual', allDay: true },
    { id: 'e3', title: 'x'.repeat(200) + ' « accents éèà » 🎂🎂🎂', startMs: U(2026, 11, 27, 8), endMs: U(2026, 11, 27, 9), source: 'ics', uid: 'orig-uid@exemple.fr' },
  ];
  const tasks = [{ id: 't1', title: 'Rédiger le rapport', load: 5, tags: ['deep'], deadlineMs: U(2026, 11, 28, 17), done: false, priority: 1, durMin: 120 }];
  const blocks = [{ taskId: 't1', startMs: U(2026, 11, 23, 8), endMs: U(2026, 11, 23, 10), score: 88, reason: "Pic d'alerte (88/100), idéal pour du travail profond" }];
  const out = buildICS({ blocks, tasks, events, calName: 'Mon, plan', nowMs: now });
  const out2 = buildICS({ blocks, tasks, events, calName: 'Mon, plan', nowMs: now });
  assert.equal(out, out2, 'reproductible');
  assert.ok(out.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(out.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(out), 'uniquement des CRLF');
  for (const line of out.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, `ligne trop longue : ${line}`);
  assert.match(out, /X-WR-CALNAME:Mon\\, plan/);
  assert.match(out, /DTSTAMP:20261122T140000Z/);
  assert.match(out, /UID:block-t1-\d+@kairos/);
  assert.match(out, /UID:orig-uid@exemple\.fr/);
  assert.match(out, /UID:e1@kairos/);
  assert.match(out, /DTSTART;VALUE=DATE:20261225/);
  assert.match(out, /DTEND;VALUE=DATE:20261226/);
  assert.equal((out.match(/BEGIN:VEVENT/g) || []).length, 4);
  assert.equal((out.match(/END:VEVENT/g) || []).length, 4);
  assert.ok(!out.includes('BEGIN:VTODO'));
  assert.ok(buildICS({ tasks, includeTodos: true, nowMs: now }).includes('BEGIN:VTODO'));
});

test('foldLine ne coupe jamais un caractère multi-octets et se déplie à l\'identique', () => {
  const line = 'SUMMARY:' + 'é🎂à'.repeat(40);
  const folded = foldLine(line);
  assert.ok(folded.includes('\r\n '));
  for (const l of folded.split('\r\n')) assert.ok(new TextEncoder().encode(l).length <= 75);
  assert.equal(unfoldLines(folded)[0], line);
  assert.equal(foldLine('court'), 'court');
});

test('aller-retour buildICS -> parseICS', () => {
  const events = [
    { id: 'e1', title: 'Déjeuner, avec Paul; "chez Léa"', startMs: U(2026, 11, 26, 11, 30), endMs: U(2026, 11, 26, 12, 30), source: 'manual' },
    { id: 'e2', title: 'Férié', startMs: L(2026, 12, 25), endMs: L(2026, 12, 26), source: 'manual', allDay: true },
    { id: 'e3', title: 'L'.repeat(150) + ' 🎂', startMs: U(2026, 11, 27, 8), endMs: U(2026, 11, 27, 9), source: 'ics', uid: 'orig-uid@exemple.fr' },
  ];
  const tasks = [{ id: 't1', title: 'Rédiger le rapport', load: 5, tags: ['deep'], done: false }];
  const blocks = [{ taskId: 't1', startMs: U(2026, 11, 23, 8), endMs: U(2026, 11, 23, 10), score: 88, reason: 'Pic' }];
  const ics = buildICS({ blocks, tasks, events, calName: 'Kairos', nowMs: U(2026, 11, 22) });
  const back = parseICS(ics, WIDE);
  assert.equal(back.length, 4);
  const by = (t) => back.find((e) => e.title === t);
  assert.equal(by('Déjeuner, avec Paul; "chez Léa"').startMs, events[0].startMs);
  assert.equal(by('Déjeuner, avec Paul; "chez Léa"').endMs, events[0].endMs);
  assert.equal(by('Férié').allDay, true);
  assert.equal(by('Férié').startMs, events[1].startMs);
  assert.equal(by('Férié').endMs, events[1].endMs);
  assert.equal(by('L'.repeat(150) + ' 🎂').uid, 'orig-uid@exemple.fr');
  const b = by('Rédiger le rapport');
  assert.equal(b.startMs, blocks[0].startMs);
  assert.equal(b.endMs, blocks[0].endMs);
  // deuxième passage : mêmes identifiants (UID stables => replaceEvents idempotent)
  assert.deepEqual(parseICS(ics, WIDE).map((e) => e.id), back.map((e) => e.id));
});

test('buildICS tolère les entrées vides ou incomplètes', () => {
  assert.doesNotThrow(() => buildICS());
  assert.doesNotThrow(() => buildICS({ blocks: [{}], events: [{ title: 'x' }, null], tasks: [null] }));
  const empty = buildICS({});
  assert.deepEqual(parseICS(empty, WIDE), []);
});
