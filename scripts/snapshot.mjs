// Collecte un instantané des données publiques Hyperliquid -> site/data.json
// Usage : node scripts/snapshot.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.hyperliquid.xyz/info';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../site/data.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function info(body, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}
const sig = (x, n = 6) => (Number.isFinite(x) ? Number(x.toPrecision(n)) : 0);

const [meta, ctxs] = await info({ type: 'metaAndAssetCtxs' });
const predicted = await info({ type: 'predictedFundings' });

const markets = {};
meta.universe.forEach((u, i) => {
  if (u.isDelisted) return;
  const c = ctxs[i];
  const mark = +c.markPx;
  markets[u.name] = {
    px: mark,
    chg: +c.prevDayPx ? sig((mark / +c.prevDayPx - 1) * 100, 4) : 0,
    oi: Math.round(+c.openInterest * mark),
    vol: Math.round(+c.dayNtlVlm),
    f: +c.funding, // taux horaire HL en cours
    lev: u.maxLeverage,
  };
});

// Taux prévus par venue, normalisés par heure
const VEN = { HlPerp: 'HL', BinPerp: 'BIN', BybitPerp: 'BYB' };
const pred = {};
for (const [coin, list] of predicted) {
  if (!markets[coin]) continue;
  const o = {};
  for (const [v, d] of list) {
    if (!d || !VEN[v] || d.fundingRate == null) continue;
    const h = d.fundingIntervalHours || (v === 'HlPerp' ? 1 : 8);
    o[VEN[v]] = { r: +d.fundingRate / h, h, n: d.nextFundingTime };
  }
  if (Object.keys(o).length) pred[coin] = o;
}

// Sélection des marchés dont on garde 7 jours d'historique
const spreadOf = (o) => {
  const rs = Object.values(o).map((x) => x.r);
  return rs.length > 1 ? Math.max(...rs) - Math.min(...rs) : 0;
};
const liquid = Object.keys(pred).filter((c) => markets[c].vol > 250_000 && markets[c].oi > 250_000);
const bySpread = [...liquid].sort((a, b) => spreadOf(pred[b]) - spreadOf(pred[a])).slice(0, 45);
const byVol = [...liquid].sort((a, b) => markets[b].vol - markets[a].vol).slice(0, 15);
const histCoins = [...new Set([...bySpread, ...byVol])];

const hist = {};
const start = Date.now() - 7 * 86400_000;
for (const coin of histCoins) {
  try {
    const rows = await info({ type: 'fundingHistory', coin, startTime: start });
    hist[coin] = rows.map((r) => sig(+r.fundingRate * 1e6, 5)); // en millionièmes par heure
  } catch (e) {
    console.error('historique indisponible', coin, e.message);
  }
  await sleep(120);
}

// Vaults
let vaults = [];
try {
  const all = await (await fetch('https://stats-data.hyperliquid.xyz/Mainnet/vaults')).json();
  const cand = all
    .filter((v) => !v.summary.isClosed && +v.summary.tvl >= 100_000 && v.summary.relationship?.type !== 'child')
    .sort((a, b) => +b.summary.tvl - +a.summary.tvl)
    .slice(0, 60);
  for (const v of cand) {
    const s = v.summary;
    let d;
    try { d = await info({ type: 'vaultDetails', vaultAddress: s.vaultAddress }); } catch { continue; }
    await sleep(120);
    const pf = Object.fromEntries(d.portfolio || []);
    const idx = (key) => {
      const p = pf[key];
      if (!p) return null;
      const av = p.accountValueHistory.map((x) => +x[1]);
      const pn = p.pnlHistory.map((x) => +x[1]);
      const t = p.pnlHistory.map((x) => x[0]);
      const out = [1];
      for (let i = 1; i < pn.length; i++) {
        const base = av[i - 1];
        const r = base > 1 ? (pn[i] - pn[i - 1]) / base : 0;
        out.push(out[i - 1] * (1 + Math.max(-0.99, Math.min(r, 5))));
      }
      return { out, t };
    };
    const mdd = (a) => { let peak = a[0], m = 0; for (const x of a) { peak = Math.max(peak, x); m = Math.min(m, x / peak - 1); } return m; };
    const month = idx('month'), all_ = idx('allTime');
    if (!month || !all_ || all_.out.length < 4) continue;
    const down = (a, n) => { if (a.length <= n) return a; const o = []; for (let i = 0; i < n; i++) o.push(a[Math.round((i * (a.length - 1)) / (n - 1))]); return o; };
    vaults.push({
      name: s.name,
      addr: s.vaultAddress,
      tvl: Math.round(+s.tvl),
      apr: sig(+d.apr * 100, 4),
      age: Math.round((Date.now() - s.createTimeMillis) / 86400_000),
      r30: sig((month.out.at(-1) - 1) * 100, 4),
      mdd30: sig(mdd(month.out) * 100, 4),
      mdd: sig(mdd(all_.out) * 100, 4),
      fee: sig((d.leaderCommission || 0) * 100, 3),
      fol: (d.followers || []).length,
      open: !!d.allowDeposits,
      s: down(all_.out, 40).map((x) => sig(x, 5)),
    });
  }
} catch (e) {
  console.error('vaults indisponibles', e.message);
}

const data = { ts: Date.now(), markets, pred, hist, vaults };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(data));
console.log(`OK ${Object.keys(markets).length} marchés, ${Object.keys(hist).length} historiques, ${vaults.length} vaults -> ${OUT}`);
