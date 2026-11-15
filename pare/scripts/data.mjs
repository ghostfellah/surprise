// Construit pare/site/voyage.json : destinations (climat de Beau Fixe) + fiches pays.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(resolve(here, 'pays.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
const pays = {}, special = {}, tz = {};
for (const l of lines) {
  if (l.startsWith('>')) { const [n, z] = l.slice(1).split('|'); tz[n] = z; continue; }
  const f = l.split('|');
  if (f.length !== 14) throw new Error('ligne mal formée : ' + l);
  const o = { plugs: f[1].split(','), v: +f[2], cur: f[3], curName: f[4], drive: f[5], urg: f[6], tel: f[7], tz: f[8], eau: +f[9], entry: f[10], tip: +f[11], lang: f[12], note: f[13] };
  if (f[0].startsWith('@')) special[f[0].slice(1)] = o; else pays[f[0]] = o;
}
for (const z of [...Object.values(pays).map((p) => p.tz), ...Object.values(tz), ...Object.values(special).map((p) => p.tz)]) new Intl.DateTimeFormat('fr', { timeZone: z }); // lève une erreur si le fuseau est inconnu

const climat = JSON.parse(readFileSync(resolve(here, '../../beau-fixe/site/climat.json'), 'utf8'));
const missing = [...new Set(climat.map((d) => d.c))].filter((c) => !pays[c]);
if (missing.length) throw new Error('pays sans fiche : ' + missing.join(', '));
for (const n of [...Object.keys(tz), ...Object.keys(special)]) if (!climat.some((d) => d.n === n)) throw new Error('destination inconnue : ' + n);

const lieux = climat.map((d) => ({ n: d.n, c: d.c, r: d.r, lat: d.lat, hi: d.hi, lo: d.lo, rain: d.rain, ...(tz[d.n] ? { tz: tz[d.n] } : {}), ...(special[d.n] ? { fiche: d.n } : {}) }));
writeFileSync(resolve(here, '../site/voyage.json'), JSON.stringify({ lieux, pays, special }));
console.log(`${lieux.length} destinations, ${Object.keys(pays).length} pays`);
