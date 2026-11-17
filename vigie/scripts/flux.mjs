// Sonar : sources par flux RSS / Atom (presse et sites reconnus) et YouTube (flux public des chaînes, sans clé d'API).
// La liste est dans sources.json. Seuls le titre, la date, un court résumé et le lien sont repris : jamais le texte d'un article.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LISTE = resolve(dirname(fileURLToPath(import.meta.url)), 'sources.json');
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
export const dec = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
  .replace(/\s+/g, ' ').trim();
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };

// Découpe un flux RSS 2.0, RDF ou Atom en éléments { titre, lien, t, resume, vues }.
export function lire(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g)) {
    const b = m[0];
    const tag = (t) => { const r = b.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i')); return r ? r[1] : ''; };
    const atom = b.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i) || b.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"/i) || b.match(/<link[^>]*href="([^"]+)"/i);
    const lien = dec(tag('link')) || (atom && atom[1]) || dec(tag('guid'));
    const date = dec(tag('pubDate')) || dec(tag('published')) || dec(tag('updated')) || dec(tag('dc:date'));
    out.push({
      titre: dec(tag('title')), lien, t: Date.parse(date),
      resume: dec(tag('description')) || dec(tag('summary')) || dec(tag('media:description')) || dec(tag('content:encoded')),
      vues: Number((b.match(/<media:statistics[^>]*views="(\d+)"/i) || [])[1]) || 0,
      id: dec(tag('yt:videoId')),
    });
  }
  return out;
}

export const charger = () => JSON.parse(readFileSync(LISTE, 'utf8'));

// ctx : { get, clip, sleep, now, H, D, source }, fournis par collect.mjs.
export function presse({ get, clip, now, H, source }) {
  return source('Presse et sites', async () => {
    const vus = new Set(), out = [];
    for (const f of charger().presse) {
      try {
        const items = lire(await get(f.url, 'text', 1)).filter((x) => x.titre && x.lien && Number.isFinite(x.t) && x.t <= now + H && now - x.t < (f.jours || 2) * 24 * H);
        items.sort((a, b) => b.t - a.t);
        let n = 0;
        for (const x of items) {
          const clé = x.lien.replace(/[?#].*$/, '');
          if (vus.has(clé) || n >= (f.jours > 2 ? 4 : 6)) continue;
          vus.add(clé); n++;
          const frais = 1 - Math.min(1, Math.max(0, (now - x.t) / ((f.jours || 2) * 24 * H))); // fraîcheur relative à la fenêtre du flux : une note de la Fed vieille de 3 jours reste d'actualité
          out.push({ id: 'pr' + hash(clé), src: 'pr', ...(f.sec ? { sec: f.sec === 'macro' ? 'monde' : f.sec } : {}), ...(f.sec === 'macro' ? { mac: 1 } : {}), title: clip(x.titre, 150), desc: clip(x.resume, 220), url: x.lien, t: x.t, vel: 0.2 + 0.8 * frais, n: 1, big: f.nom, unit: 'source suivie', extra: '' });
        }
        if (!n) console.error(`Presse ${f.id} : aucun élément récent`);
      } catch (e) { console.error(`Presse ${f.id} : indisponible (${e.message})`); }
    }
    // Garde les plus récents sans laisser un flux prolixe tout prendre
    return out.sort((a, b) => b.vel - a.vel).slice(0, 90);
  });
}

export function youtube({ get, clip, sleep, now, H, D, source }) {
  return source('YouTube', async () => {
    const out = [];
    for (const c of charger().youtube) {
      try {
        const items = lire(await get('https://www.youtube.com/feeds/videos.xml?channel_id=' + c.channel, 'text', 1)).filter((x) => x.titre && x.id && Number.isFinite(x.t) && now - x.t < 7 * D);
        for (const x of items.slice(0, 4)) {
          const heures = Math.max(0.5, (now - x.t) / H);
          out.push({ id: 'yt' + x.id, src: 'yt', ...(c.sec ? { sec: c.sec === 'macro' ? 'monde' : c.sec } : {}), ...(c.sec === 'macro' ? { mac: 1 } : {}), title: clip(x.titre, 150), desc: clip(x.resume, 220), url: 'https://www.youtube.com/watch?v=' + x.id, t: x.t, vel: (x.vues + 1) / Math.pow(heures + 2, 1.3), n: x.vues, unit: 'vues', extra: c.nom });
        }
      } catch (e) { console.error(`YouTube ${c.id} : indisponible (${e.message})`); }
      await sleep(200);
    }
    return out.sort((a, b) => b.vel - a.vel).slice(0, 40);
  });
}
