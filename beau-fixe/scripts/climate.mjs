// Construit beau-fixe/site/climat.json à partir des climatologies NASA POWER (2001-2025).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => Math.round(x * 10) / 10;

const dests = readFileSync(resolve(here, 'destinations.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
  const [n, c, r, lat, lon, alt, t] = l.split('|');
  return { n, c, r, lat: +lat, lon: +lon, alt: +alt, t };
});

async function climate(d) {
  const url = `https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=T2M,T2M_RANGE,PRECTOTCORR,CLOUD_AMT,RH2M&community=AG&longitude=${d.lon}&latitude=${d.lat}&format=JSON`;
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const p = j.properties.parameter, cell = j.geometry.coordinates[2];
      // Recale la température de la maille sur l'altitude du lieu, avec un plafond côté réchauffement
      const lapse = Math.min(2.5, ((cell - d.alt) / 1000) * 6.5);
      const ok = (v) => v > -900;
      if (!MONTHS.every((m) => ok(p.T2M[m]) && ok(p.T2M_RANGE[m]) && ok(p.PRECTOTCORR[m]))) throw new Error('valeurs manquantes');
      return {
        n: d.n, c: d.c, r: d.r, lat: d.lat, lon: d.lon, t: d.t,
        hi: MONTHS.map((m) => r1(p.T2M[m] + p.T2M_RANGE[m] / 2 + lapse)),
        lo: MONTHS.map((m) => r1(p.T2M[m] - p.T2M_RANGE[m] / 2 + lapse)),
        rain: MONTHS.map((m, k) => Math.round(p.PRECTOTCORR[m] * DAYS[k])),
        cl: MONTHS.map((m) => (ok(p.CLOUD_AMT[m]) ? Math.round(p.CLOUD_AMT[m]) : 50)),
        rh: MONTHS.map((m) => (ok(p.RH2M[m]) ? Math.round(p.RH2M[m]) : 60)),
      };
    } catch (e) {
      if (i >= 4) { console.error('échec', d.n, e.message); return null; }
      await sleep(2000 * (i + 1));
    }
  }
}

const out = [];
let k = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (k < dests.length) { const d = dests[k++]; const c = await climate(d); if (c) out.push(c); }
}));
out.sort((a, b) => a.n.localeCompare(b.n, 'fr'));
writeFileSync(resolve(here, '../site/climat.json'), JSON.stringify(out));
console.log(`${out.length}/${dests.length} destinations`);
