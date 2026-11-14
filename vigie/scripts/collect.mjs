// Vigie : relève les signaux précoces sur des sources publiques et mesure leur couverture presse.
// Écrit vigie/site/signaux.json. Usage : node vigie/scripts/collect.mjs
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../site/signaux.json');
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; vigie-signals/1.0)', accept: '*/*' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now(), H = 36e5, D = 864e5;
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

async function get(url, as = 'json', tries = 2) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return as === 'json' ? await r.json() : await r.text();
    } catch (e) { if (i >= tries) throw e; await sleep(1500 * (i + 1)); }
  }
}
async function source(name, fn) {
  try { const a = await fn(); console.log(`${name}: ${a.length}`); return a; }
  catch (e) { console.error(`${name}: indisponible (${e.message})`); return []; }
}

// --- Terme distinctif à chercher dans la presse ---
const STOP = new Set('The A An Why How What When Where Who I We My Our Your You It Its Is Are Was Do Does Did Can Will In On For To Of And Or But New This That These With From At By As If Not No All Show Ask Tell HN Launch Now Just More Most Has Have Been Be After Before Into Over Under About Using Use Used Building Built Introducing Announcing Released Release Open Source Free First Big Tech AI US UK EU Inc Ltd PDF Video'.split(' '));
function termFromTitle(title) {
  const show = title.match(/^(?:Show|Launch) HN:\s*([^–—:,(|-]+?)(?:\s+[–—:|-]|,|\(|$)/);
  if (show) { const t = show[1].trim().split(/\s+(?:in|for|to|with|on|is|that|a|an|the)\s+/)[0].split(/\s+/).slice(0, 3).join(' '); if (t.length >= 3) return t; }
  const tok = title.replace(/[“”"()\[\],:;!?]/g, ' ').split(/\s+/).filter(Boolean);
  const cap = tok.filter((w) => /^[A-Z]/.test(w)).length;
  if (tok.length > 4 && cap / tok.length > 0.7) return null; // titre tout en capitales initiales : rien de fiable
  for (let i = 0; i < tok.length; i++) {
    const w = tok[i].replace(/['’]s$/, '').replace(/\.$/, '');
    const special = /[a-z][A-Z]|\d/.test(w) && /^[A-Za-z]/.test(w) && w.length >= 3;
    const proper = /^[A-Z][A-Za-z0-9.+-]{2,}$/.test(w) && !STOP.has(w) && (i > 0 || special);
    if (!(proper || special) || STOP.has(w)) continue;
    const run = [w];
    for (let j = i + 1; j < tok.length && run.length < 3; j++) { const n = tok[j].replace(/['’]s$/, ''); if (/^[A-Z0-9][A-Za-z0-9.+-]*$/.test(n) && !STOP.has(n)) run.push(n); else break; }
    const term = run.join(' ');
    if (/^v?\d[\d.]*$/i.test(term) || /^(GPUs?|APIs?|CPUs?|LLMs?|PDFs?|Island|Mac|Web|App|Apps|Data|Code)$/.test(term)) continue;
    return term;
  }
  return null;
}

// --- Sources ---
const hn = () => source('Hacker News', async () => {
  const q = encodeURIComponent(`created_at_i>${Math.floor((now - 2 * D) / 1000)},points>40`);
  const j = await get(`https://hn.algolia.com/api/v1/search?tags=story&numericFilters=${q}&hitsPerPage=120`);
  return j.hits.map((h) => {
    const hours = Math.max(1, (now - h.created_at_i * 1000) / H);
    return { id: 'hn' + h.objectID, src: 'hn', title: clip(h.title, 140), desc: '', url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, talk: `https://news.ycombinator.com/item?id=${h.objectID}`, t: h.created_at_i * 1000, vel: h.points / Math.pow(hours + 2, 1.3), n: h.points, unit: 'points', extra: `${h.num_comments || 0} commentaires`, term: termFromTitle(h.title) };
  });
});
const lobsters = () => source('Lobsters', async () => {
  const j = await get('https://lobste.rs/hottest.json');
  return j.filter((s) => s.score >= 15).map((s) => {
    const t = Date.parse(s.created_at), hours = Math.max(1, (now - t) / H);
    return { id: 'lb' + s.short_id, src: 'lb', title: clip(s.title, 140), desc: (s.tags || []).join(', '), url: s.url || s.short_id_url, talk: s.short_id_url, t, vel: s.score / Math.pow(hours + 2, 1.3), n: s.score, unit: 'votes', extra: `${s.comment_count || 0} commentaires`, term: termFromTitle(s.title) };
  });
});
const github = () => source('GitHub', async () => {
  const since = new Date(now - 14 * D).toISOString().slice(0, 10);
  const j = await get(`https://api.github.com/search/repositories?q=${encodeURIComponent('created:>' + since)}&sort=stars&order=desc&per_page=60`);
  return j.items.map((r) => {
    const t = Date.parse(r.created_at), days = Math.max(0.5, (now - t) / D);
    return { id: 'gh' + r.id, src: 'gh', title: r.full_name, desc: clip(r.description, 220), url: r.html_url, t, vel: r.stargazers_count / days, n: r.stargazers_count, unit: 'étoiles', extra: r.language || '', term: r.name.length >= 4 ? r.name : null };
  });
});
const hfModels = () => source('Hugging Face (modèles)', async () => {
  const j = await get('https://huggingface.co/api/models?sort=trendingScore&limit=40&full=false');
  return j.filter((m) => m.createdAt && now - Date.parse(m.createdAt) < 30 * D).map((m) => {
    const t = Date.parse(m.createdAt), days = Math.max(0.5, (now - t) / D), name = m.id.split('/').pop();
    return { id: 'hm' + m.id, src: 'hf', title: m.id, desc: clip([m.pipeline_tag, m.library_name].filter(Boolean).join(' · '), 120), url: 'https://huggingface.co/' + m.id, t, vel: (m.likes || 0) / days, n: m.likes || 0, unit: 'mentions J\'aime', extra: `${(m.downloads || 0).toLocaleString('fr-FR')} téléchargements`, term: name.replace(/[-_.](GGUF|AWQ|MLX|bnb|4bit|8bit|fp8|fp16).*$/i, '') };
  });
});
const hfPapers = () => source('Hugging Face (articles)', async () => {
  const j = await get('https://huggingface.co/api/daily_papers?limit=50');
  return j.map((p) => {
    const t = Date.parse(p.publishedAt || p.paper?.publishedAt), days = Math.max(0.5, (now - t) / D), title = p.title || p.paper?.title || '';
    const head = title.includes(':') ? title.split(':')[0].trim() : '';
    return { id: 'hp' + p.paper.id, src: 'ar', title: clip(title, 160), desc: clip(p.paper.ai_summary || p.summary || p.paper.summary, 260), url: 'https://arxiv.org/abs/' + p.paper.id, talk: 'https://huggingface.co/papers/' + p.paper.id, t, vel: (p.paper.upvotes || 0) / Math.pow(days + 0.5, 0.8), n: p.paper.upvotes || 0, unit: 'votes de chercheurs', extra: 'arXiv ' + p.paper.id, term: head && head.split(/\s+/).length <= 3 && head.length >= 4 ? head : null };
  }).filter((p) => Number.isFinite(p.t) && now - p.t < 21 * D);
});
const trends = async () => {
  try {
    const x = await get('https://trends.google.com/trending/rss?geo=FR', 'text');
    return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({ t: clip(m[1].match(/<title>(.*?)<\/title>/)?.[1].replace(/&amp;/g, '&').replace(/&(#39|apos);/g, "'") || '', 60), n: m[1].match(/<ht:approx_traffic>(.*?)<\/ht:approx_traffic>/)?.[1] || '' })).filter((t) => t.t).slice(0, 12);
  } catch (e) { console.error('Google Trends : indisponible', e.message); return []; }
};

// --- Couverture presse sur 7 jours (Google Actualités) ---
async function coverage(term, lang) {
  const loc = lang === 'fr' ? 'hl=fr&gl=FR&ceid=FR:fr' : 'hl=en-US&gl=US&ceid=US:en';
  const x = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(`"${term}" when:7d`)}&${loc}`, 'text', 1);
  return (x.match(/<item>/g) || []).length;
}

const lists = await Promise.all([hn(), lobsters(), github(), hfModels(), hfPapers()]);
// Force : rang relatif dans sa propre source, pour comparer des métriques différentes
for (const l of lists) { const s = [...l].sort((a, b) => a.vel - b.vel); s.forEach((x, i) => { x.force = Math.round(((i + 1) / s.length) * 100); }); }
let all = lists.flat();

// Convergence : un même projet repéré sur plusieurs sources
const key = (s) => (s.url.match(/github\.com\/([^/]+\/[^/#?]+)/i)?.[1] || s.term || '').toLowerCase().replace(/\.git$/, '');
const groups = new Map();
for (const s of all) { const k = s.src === 'gh' ? s.title.toLowerCase() : key(s); if (!k || k.length < 4) continue; (groups.get(k) || groups.set(k, []).get(k)).push(s); }
for (const g of groups.values()) { const srcs = new Set(g.map((s) => s.src)); if (srcs.size > 1) g.forEach((s) => { s.conv = [...srcs].filter((x) => x !== s.src); }); }

all.sort((a, b) => b.force * (b.conv ? 1.25 : 1) - a.force * (a.conv ? 1.25 : 1));
const cache = new Map();
let measured = 0, failed = 0;
for (const s of all.slice(0, 90)) {
  if (!s.term || failed > 6) continue;
  const k = s.term.toLowerCase();
  if (!cache.has(k)) {
    try { const fr = await coverage(s.term, 'fr'); await sleep(350); const en = await coverage(s.term, 'en'); await sleep(350); cache.set(k, { fr, en }); measured++; }
    catch (e) { failed++; cache.set(k, null); }
  }
  const c = cache.get(k); if (c) { s.fr = c.fr; s.en = c.en; }
}
console.log(`couverture mesurée pour ${measured} termes, ${failed} échecs`);

const signals = all.slice(0, 160).map(({ vel, ...s }) => { for (const k of Object.keys(s)) if (s[k] == null || s[k] === '') delete s[k]; return s; });
if (signals.length < 20) { console.error('Trop peu de signaux, instantané précédent conservé.'); process.exit(1); }
writeFileSync(OUT, JSON.stringify({ ts: now, signals, trends: await trends() }));
console.log(`${signals.length} signaux -> ${OUT}`);
