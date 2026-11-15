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
// --- Crypto ---
const coingecko = () => source('CoinGecko', async () => {
  const j = await get('https://api.coingecko.com/api/v3/search/trending');
  return j.coins.map(({ item: c }, i) => {
    const chg = c.data?.price_change_percentage_24h?.usd;
    return { id: 'cg' + c.id, src: 'cg', sec: 'crypto', title: `${c.name} (${c.symbol})`, desc: clip([c.market_cap_rank ? `Rang ${c.market_cap_rank} par capitalisation` : 'Hors classement par capitalisation', Number.isFinite(chg) ? `${chg > 0 ? '+' : ''}${chg.toFixed(1)} % sur 24 h` : ''].filter(Boolean).join(' · '), 160), url: 'https://www.coingecko.com/fr/pièces/' + c.id, t: now, live: 1, vel: 100 - i, n: i + 1, big: 'n° ' + (i + 1), unit: 'des recherches CoinGecko', term: c.name.length >= 4 ? c.name : null };
  });
});
const llama = () => source('DefiLlama', async () => {
  const j = await get('https://api.llama.fi/protocols');
  return j.filter((p) => p.tvl > 1e7 && p.change_7d > 10 && p.change_7d < 1000 && !['CEX', 'Chain'].includes(p.category))
    .sort((a, b) => b.change_7d * Math.log10(b.tvl) - a.change_7d * Math.log10(a.tvl)).slice(0, 30)
    .map((p) => ({ id: 'dl' + p.slug, src: 'dl', sec: 'crypto', title: p.name, desc: clip(`${p.category || 'DeFi'} sur ${p.chain || 'plusieurs chaînes'}. ${p.description || ''}`, 220), url: 'https://defillama.com/protocol/' + p.slug, t: now, live: 1, vel: p.change_7d * Math.log10(p.tvl), n: Math.round(p.change_7d), big: '+' + Math.round(p.change_7d) + ' %', unit: `de valeur déposée en 7 j · ${(p.tvl / 1e6).toFixed(0)} M$`, term: p.name.replace(/\s+V\d+$/i, '').length >= 4 ? p.name.replace(/\s+V\d+$/i, '') : null }));
});

// --- Marchés de prédiction et attention mondiale ---
const polymarket = () => source('Polymarket', async () => {
  const j = [];
  for (let off = 0; off < 600; off += 100) { j.push(...(await get(`https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=100&offset=${off}`))); await sleep(150); }
  return j.filter((m) => !m.gameStartTime && !m.sportsMarketType && !/(price of|up or down|dip to|reach \$|above \$|below \$|hit \$|close (above|below)|all[- ]time high|\bvs\.?\b|o\/u|spread:|tweets? from|posts? from)/i.test(m.question) && Date.parse(m.endDate) - now > 2 * D && Math.abs(m.oneDayPriceChange || 0) >= 0.05 && (m.volume24hr || 0) > 8000 && m.question)
    .map((m) => {
      const d = m.oneDayPriceChange, now_ = Number(JSON.parse(m.outcomePrices || '[0]')[0]) || m.lastTradePrice || 0, pts = Math.round(d * 100);
      return { id: 'pm' + m.id, src: 'pm', sec: 'monde', title: clip(m.question, 150), desc: `Probabilité du « oui » : ${Math.round(now_ * 100)} %, contre ${Math.round((now_ - d) * 100)} % il y a 24 h.`, url: 'https://polymarket.com/market/' + m.slug, t: now, live: 1, vel: Math.abs(d) * Math.log10(m.volume24hr), n: pts, big: (pts > 0 ? '+' : '') + pts + ' pts', unit: `de probabilité en 24 h · ${Math.round(m.volume24hr / 1000)} k$ échangés`, term: termFromTitle(m.question) };
    }).sort((a, b) => b.vel - a.vel).slice(0, 25);
});
const wikipedia = () => source('Wikipédia', async () => {
  const day = (n) => new Date(now - n * D).toISOString().slice(0, 10).replace(/-/g, '/');
  const top = async (n) => (await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${day(n)}`)).items[0].articles;
  let a, b;
  try { [a, b] = [await top(1), await top(2)]; } catch { [a, b] = [await top(2), await top(3)]; }
  const before = new Map(b.map((x) => [x.article, x.views])), floor = b[b.length - 1].views;
  return a.filter((x) => !/^(Main_Page|Special:|Wikipedia:|File:|Portal:|Help:|Category:|Template:|\.xxx|XXX|Pornhub|XNXX|XVideos)/i.test(x.article) && !/^(Deaths_in_|List_of_|\d{4}$)/.test(x.article) && x.views > 40000)
    .map((x) => ({ x, ratio: x.views / (before.get(x.article) || floor) }))
    .filter((r) => r.ratio >= 2.5).sort((p, q) => q.ratio * Math.log10(q.x.views) - p.ratio * Math.log10(p.x.views)).slice(0, 25)
    .map(({ x, ratio }) => { const name = decodeURIComponent(x.article).replace(/_/g, ' '); return { id: 'wk' + x.article.slice(0, 60), src: 'wk', sec: 'monde', title: name, desc: `${x.views.toLocaleString('fr-FR')} lectures hier sur Wikipédia en anglais${before.has(x.article) ? '' : ', absent du classement la veille'}.`, url: 'https://en.wikipedia.org/wiki/' + x.article, t: now, live: 1, vel: ratio * Math.log10(x.views), n: Math.round(ratio * 10) / 10, big: '× ' + String(Math.round(ratio * 10) / 10).replace('.', ','), unit: 'de lectures en 24 h', term: name.split(' ').length <= 4 && name.length >= 4 ? name.replace(/\s*\(.*\)$/, '') : null }; });
});

// --- Posts à commenter : ce qui prend en ce moment sur les réseaux ouverts ---
const CRYPTO = /\b(bitcoin|btc|ethereum|eth|crypto\w*|defi|stablecoin\w*|solana|blockchain|onchain|on-chain|altcoin\w*|memecoin\w*|web3|hyperliquid|binance|coinbase|tether|usdc|usdt|airdrop\w*|staking|nft|nfts)\b/i;
const strip = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
async function bluesky() {
  const since = new Date(now - 30 * H).toISOString(), out = [];
  const qs = [['bitcoin', 'crypto'], ['ethereum', 'crypto'], ['crypto', 'crypto'], ['defi', 'crypto'], ['stablecoin', 'crypto'], ['solana', 'crypto'], ['AI', 'tech'], ['LLM', 'tech'], ['open source', 'tech'], ['startup', 'tech']];
  for (const [q, sec] of qs) for (const lang of ['en', 'fr']) {
    try {
      const j = await get(`https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&sort=top&limit=25&lang=${lang}&since=${encodeURIComponent(since)}`, 'json', 1);
      for (const p of j.posts || []) {
        if (p.record?.reply || (p.labels || []).length || (p.author?.labels || []).length) continue;
        const text = (p.record?.text || '').trim(); if (text.length < 50) continue;
        out.push({ id: 'bs' + p.uri.split('/').pop(), net: 'bs', sec, lang, who: p.author.displayName || p.author.handle, text: clip(text.replace(/\n{2,}/g, '\n'), 420), url: `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split('/').pop()}`, t: Date.parse(p.record.createdAt), likes: p.likeCount || 0, shares: (p.repostCount || 0) + (p.quoteCount || 0), replies: p.replyCount || 0 });
      }
    } catch (e) { console.error('Bluesky', q, lang, e.message); }
    await sleep(250);
  }
  return out;
}
async function mastodon() {
  const out = [], urls = ['https://mastodon.social/api/v1/trends/statuses?limit=40', ...['bitcoin', 'crypto', 'ethereum', 'ai', 'opensource'].map((t) => `https://mastodon.social/api/v1/timelines/tag/${t}?limit=40`)];
  for (const u of urls) {
    try {
      for (const m of await get(u, 'json', 1)) {
        if (m.sensitive || m.in_reply_to_id || m.reblog) continue;
        const text = strip(m.content); if (text.length < 50 || !['en', 'fr'].includes(m.language)) continue;
        out.push({ id: 'ms' + m.id, net: 'ms', sec: CRYPTO.test(text) ? 'crypto' : 'tech', lang: m.language, who: m.account.display_name || m.account.acct, text: clip(text.replace(/\n{2,}/g, '\n'), 420), url: m.url, t: Date.parse(m.created_at), likes: m.favourites_count || 0, shares: m.reblogs_count || 0, replies: m.replies_count || 0 });
      }
    } catch (e) { console.error('Mastodon', e.message); }
    await sleep(250);
  }
  return out;
}

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

const lists = await Promise.all([hn(), lobsters(), github(), hfModels(), hfPapers(), coingecko(), llama(), polymarket(), wikipedia()]);
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
for (const s of all.slice(0, 150)) {
  if (!s.term || failed > 6) continue;
  const k = s.term.toLowerCase();
  if (!cache.has(k)) {
    try { const fr = await coverage(s.term, 'fr'); await sleep(350); const en = await coverage(s.term, 'en'); await sleep(350); cache.set(k, { fr, en }); measured++; }
    catch (e) { failed++; cache.set(k, null); }
  }
  const c = cache.get(k); if (c) { s.fr = c.fr; s.en = c.en; }
}
console.log(`couverture mesurée pour ${measured} termes, ${failed} échecs`);

const signals = all.slice(0, 240).map(({ vel, ...s }) => { for (const k of Object.keys(s)) if (s[k] == null || s[k] === '') delete s[k]; return s; });
if (signals.length < 20) { console.error('Trop peu de signaux, instantané précédent conservé.'); process.exit(1); }
// Mémoire : reprend l'historique du relevé précédent pour mesurer l'accélération et l'arrivée de la presse
const PREV = process.env.VIGIE_PREV || 'https://ghostfellah.github.io/surprise/vigie/signaux.json';
let prev = null;
try { prev = await get(PREV + '?t=' + now, 'json', 1); } catch (e) { console.error('relevé précédent indisponible :', e.message); }
const old = new Map((prev?.signals || []).map((s) => [s.id, s]));
const sameHour = prev && now - prev.ts < 20 * 60000; // relevé trop proche : on remplace le dernier point au lieu d'en ajouter un
for (const s of signals) {
  const o = old.get(s.id), h = o?.h ? [...o.h] : o ? [o.n] : [], c = o?.c ? [...o.c] : o ? [o.fr ?? -1] : [];
  if (sameHour && h.length > 1) { h.pop(); c.pop(); }
  h.push(s.n); c.push(s.fr ?? -1);
  s.h = h.slice(-24); s.c = c.slice(-24);
  s.first = o ? (o.first || prev.ts) : (prev ? now : 0); // 0 = ancienneté inconnue (premier relevé)
  if (s.fr == null && o?.fr != null && o.term === s.term) { s.fr = o.fr; s.en = o.en; s.stale = 1; } // garde la dernière mesure connue
}
const scans = Math.max(1, (prev?.scans || 0) + (sameHour ? 0 : 1));
console.log(`mémoire : ${[...signals].filter((s) => old.has(s.id)).length} signaux déjà connus, relevé n° ${scans}`);

// Posts à commenter
let posts = [];
try {
  const seen = new Set();
  const raw = [...(await bluesky()), ...(await mastodon()),
    ...lists[0].filter((s) => now - s.t < 10 * H).map((s) => ({ id: 'p' + s.id, net: 'hn', sec: CRYPTO.test(s.title) ? 'crypto' : 'tech', lang: 'en', who: 'Hacker News', text: s.title, url: s.talk, t: s.t, likes: s.n, shares: 0, replies: parseInt(s.extra, 10) || 0 }))];
  posts = raw.filter((p) => Number.isFinite(p.t) && now - p.t < 36 * H && p.likes + p.shares >= (p.net === 'hn' ? 40 : 8) && !seen.has(p.id) && seen.add(p.id))
    .map((p) => ({ ...p, sec: p.sec === 'tech' && CRYPTO.test(p.text) ? 'crypto' : p.sec }))
    .sort((a, b) => (b.likes + 2 * b.shares) / Math.max(0.5, (now - b.t) / H) - (a.likes + 2 * a.shares) / Math.max(0.5, (now - a.t) / H)).slice(0, 150);
  console.log(`posts à commenter : ${posts.length}`);
} catch (e) { console.error('posts indisponibles', e.message); }

writeFileSync(OUT, JSON.stringify({ ts: now, prevTs: prev?.ts || 0, scans, signals, posts, trends: await trends() }));
console.log(`${signals.length} signaux -> ${OUT}`);
