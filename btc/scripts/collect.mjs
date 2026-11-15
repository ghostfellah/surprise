// Relève les données bitcoin, calcule les scores, lance le backtest et écrit btc/site/btc.json.
// Usage : node btc/scripts/collect.mjs
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const E = require('../src/engine.cjs');
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../site/btc.json');
const CACHE = resolve(here, '../.cache/histoire.json');
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; btc-signal/1.0)', accept: '*/*' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now(), H4 = 4 * 36e5, DAY = 864e5;
const r2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

async function get(url, init = {}, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000), ...init });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i >= tries - 1) throw e; await sleep(1500 * (i + 1)); }
  }
}
async function soft(name, fn) { try { return await fn(); } catch (e) { console.error(`${name} : indisponible (${e.message})`); return null; } }

// --- Chandeliers Bitstamp BTC/USD, par pages de 1000 en remontant le temps ---
async function candles(step, floor, cached) {
  const have = new Map((cached || []).map((c) => [c[0], c]));
  const maxHave = cached && cached.length ? cached[cached.length - 1][0] : 0;
  let end = Math.floor(now / 1000);
  for (let p = 0; p < 40; p++) {
    const j = await get(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=${step}&limit=1000&end=${end}`);
    const rows = j.data.ohlc;
    if (!rows.length) break;
    for (const r of rows) have.set(+r.timestamp * 1000, [+r.timestamp * 1000, +r.open, +r.high, +r.low, +r.close, +r.volume]);
    const first = +rows[0].timestamp;
    if (first * 1000 <= floor || (maxHave && first * 1000 <= maxHave)) break;
    end = first - 1; await sleep(250);
  }
  return [...have.values()].sort((a, b) => a[0] - b[0]);
}
const cols = (rows) => ({ t: rows.map((r) => r[0]), o: rows.map((r) => r[1]), h: rows.map((r) => r[2]), l: rows.map((r) => r[3]), c: rows.map((r) => r[4]), v: rows.map((r) => r[5]) });

let cache = {};
try { cache = JSON.parse(readFileSync(CACHE, 'utf8')); } catch {}
const FLOOR = Date.UTC(2017, 8, 1);
const rows4 = await candles(14400, FLOOR, cache.h4);
const rowsD = await candles(86400, FLOOR, cache.d1);
try { mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify({ h4: rows4.slice(0, -1), d1: rowsD.slice(0, -1) })); } catch {}
console.log(`bougies : ${rows4.length} (4 h), ${rowsD.length} (jour)`);
if (rows4.length < 3000) { console.error('historique insuffisant'); process.exit(1); }

// La bougie en cours n'est jamais notée (pas de repeinture) : on la garde seulement pour le prix affiché.
const forming = rows4[rows4.length - 1][0] + H4 > now;
const closed4 = forming ? rows4.slice(0, -1) : rows4;
const lastPx = rows4[rows4.length - 1][4];
const closedD = rowsD.filter((r) => r[0] + DAY <= now);

// --- Contexte quotidien ---
const fngRaw = await soft('Fear & Greed', () => get('https://api.alternative.me/fng/?limit=0&format=json'));
const fng = {};
for (const x of fngRaw?.data || []) fng[E.dayStart(+x.timestamp * 1000)] = +x.value;
const mv = await soft('MVRV', () => get('https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur&frequency=1d&start_time=2017-06-01&page_size=10000'));
const mvrv = {};
for (const x of mv?.data || []) if (x.CapMVRVCur) mvrv[E.dayStart(Date.parse(x.time))] = +x.CapMVRVCur;
console.log(`F&G ${Object.keys(fng).length} jours, MVRV ${Object.keys(mvrv).length} jours`);

// --- Scores et backtest ---
const S = E.build(cols(closed4), cols(closedD), { fng, mvrv });
const n = S.n, last = n - 1;
// Les scores ne sont publiés qu'à partir du moment où toutes les composantes existent (Fear & Greed démarre en février 2018).
const T0 = Date.UTC(2018, 2, 1);
for (let i = 0; i < n; i++) if (S.t[i] < T0) { S.bot[i] = NaN; S.top[i] = NaN; }
const split = S.t.findIndex((t) => t >= Date.UTC(2023, 0, 1));
const firstScored = S.bot.findIndex((x) => !Number.isNaN(x));
const opt = E.optimize(S, split);
const P = opt.best;
console.log('seuils retenus (période d\'apprentissage) :', JSON.stringify({ tb: P.tb, tt: P.tt, frac: P.frac }), `| ${Math.round(opt.beatShare * 100)} % des combinaisons battent HODL hors échantillon`);
const A = E.backtest(S, P, firstScored, split, true), B = E.backtest(S, P, split, n, true);
const full = E.backtest(S, P, firstScored, n, false);
const eps = E.episodes(S, P.tb, P.tt, firstScored, n);
const rowsBot = E.forward(S, eps, 'bot'), rowsTop = E.forward(S, eps, 'top');
const inRows = (rows, a, b) => rows.filter((r) => r.i >= a && r.i < b);
const stats = (rows, side) => E.summarize(rows, side);
const baseIn = E.baseline(S, firstScored, split), baseOut = E.baseline(S, split, n);
const trim = (r) => ({ t: r.t, px: r2(r.px, 0), score: r2(r.score, 1), d3: r2(r.d3 == null ? null : r.d3 * 100, 1), d7: r2(r.d7 == null ? null : r.d7 * 100, 1), d14: r2(r.d14 == null ? null : r.d14 * 100, 1), adverse: r2(r.adverse * 100, 1) });
const ds = (curve, k) => { const o = []; const step = Math.max(1, Math.floor(curve.length / 260)); for (let i = 0; i < curve.length; i += step) o.push([curve[i][0], r2(curve[i][1], 4)]); return o; };
// Tests complémentaires : DCA avec réserve de cash, filtre de tendance.
const dIn = closedD.findIndex((r) => r[0] >= T0), dSplit = closedD.findIndex((r) => r[0] >= Date.UTC(2023, 0, 1));
const DD = { t: closedD.map((r) => r[0]), o: closedD.map((r) => r[1]), c: closedD.map((r) => r[4]) };
const dcaRows = [];
for (const T of [30, 35, 40, 45, 50, 55, 60]) for (const W of [2, 4, 8, 13, 26]) {
  const a = E.dcaTiming(S, firstScored, split, T, W) / E.dcaTiming(S, firstScored, split, null) - 1;
  const b = E.dcaTiming(S, split, n, T, W) / E.dcaTiming(S, split, n, null) - 1;
  dcaRows.push([T, W, r2(a * 100, 1), r2(b * 100, 1)]);
}
const trendRows = [];
for (const len of [50, 100, 150, 200, 250, 300]) for (const band of [0, 0.02, 0.05, 0.1]) {
  const a = E.trendFilter(DD, len, band, dIn, dSplit), b = E.trendFilter(DD, len, band, dSplit, DD.t.length);
  trendRows.push([len, band, r2(a.final, 2), a.trades, r2(b.final, 2), b.trades]);
}
const med = (v) => { const x = [...v].sort((p, q) => p - q), m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
const tests = {
  dca: { combos: dcaRows.length, beatIn: dcaRows.filter((r) => r[2] > 0).length, beatOut: dcaRows.filter((r) => r[3] > 0).length, medIn: r2(med(dcaRows.map((r) => r[2])), 1), medOut: r2(med(dcaRows.map((r) => r[3])), 1) },
  trend: { combos: trendRows.length, beatIn: trendRows.filter((r) => r[2] > 1).length, beatOut: trendRows.filter((r) => r[4] > 1).length, medIn: r2(med(trendRows.map((r) => r[2])), 2), medOut: r2(med(trendRows.map((r) => r[4])), 2) },
};
// Qualité des signaux à deux niveaux de seuil (alerte 45, signal fort 60), sur tout l'historique et hors échantillon.
const evidence = { base: E.baseline(S, firstScored, n), baseOut: E.baseline(S, split, n) };
for (const side of ['bot', 'top']) {
  evidence[side] = {};
  for (const T of [45, 60]) {
    const ep = E.episodes(S, side === 'bot' ? T : 999, side === 'top' ? T : 999, firstScored, n).filter((e) => e.side === side);
    const rows = E.forward(S, ep, side);
    evidence[side][T] = { all: E.summarize(rows, side), out: E.summarize(rows.filter((r) => r.i >= split), side) };
  }
}
const hodl = (a, b) => ({ priceStart: r2(S.o[a], 0), priceEnd: r2(S.c[b - 1], 0) });
const period = (res, a, b) => ({ from: S.t[a], to: S.t[b - 1], btc: r2(res.final, 4), edge: r2(res.edge * 100, 1), trades: res.trades, mdd: r2(res.mdd * 100, 1), ...hodl(a, b) });

// --- État actuel détaillé ---
const I = S.ind;
const comp = (c) => Object.fromEntries(Object.keys(c).map((k) => [k, r2(c[k][last], 3)]));
const lastN = (a, k) => Math.min(...a.slice(last - k + 1, last + 1)), lastX = (a, k) => Math.max(...a.slice(last - k + 1, last + 1));
const atr = I.atr4[last], swingLo = lastN(S.l, 24), swingHi = lastX(S.h, 24);
const plan = {
  bot: { stop: r2(swingLo - 0.5 * atr, 0), t1: r2(Math.max(I.e20[last], lastPx), 0), t2: r2(Math.max(I.e50[last], lastPx), 0) },
  top: { stop: r2(swingHi + 0.5 * atr, 0), t1: r2(Math.min(I.e20[last], lastPx), 0), t2: r2(Math.min(I.e50[last], lastPx), 0) },
};
const sma200 = (() => { const c = closedD.map((r) => r[4]); return c.length >= 200 ? c.slice(-200).reduce((a, b) => a + b, 0) / 200 : null; })();
const fngNow = fng[E.dayStart(now)] ?? fng[E.dayStart(now - DAY)], mvNow = mvrv[E.dayStart(now - DAY)] ?? mvrv[E.dayStart(now - 2 * DAY)];
const pctB = (S.c[last] - (I.mid[last] - 2 * I.sd[last])) / (4 * I.sd[last]);

// --- Dérivés et on-chain (indicatifs : pas de longue histoire, donc hors score) ---
const hl = (b) => get('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { ...UA, 'content-type': 'application/json' }, body: JSON.stringify(b) });
const funding = await soft('Funding Hyperliquid', async () => {
  const rows = await hl({ type: 'fundingHistory', coin: 'BTC', startTime: now - 20 * DAY });
  const v = rows.map((x) => +x.fundingRate), cur = v[v.length - 1];
  const rank = v.filter((x) => x <= cur).length / v.length;
  const ctx = await hl({ type: 'metaAndAssetCtxs' });
  const a = ctx[1][0];
  return { apr: r2(cur * 24 * 365 * 100, 1), rank: r2(rank, 2), avgApr: r2((v.reduce((s, x) => s + x, 0) / v.length) * 24 * 365 * 100, 1), oiBtc: r2(+a.openInterest, 0), vol24: r2(+a.dayNtlVlm / 1e6, 0), premium: r2(+a.premium * 100, 3) };
});
const ls = await soft('Ratio long/short OKX', async () => {
  const j = await get('https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H');
  const v = j.data.map((x) => +x[1]), cur = v[0];
  return { ratio: r2(cur, 2), rank: r2(v.filter((x) => x <= cur).length / v.length, 2), days: r2(v.length / 24, 1) };
});
const dvol = await soft('DVOL Deribit', async () => {
  const j = await get(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${now - 30 * DAY}&end_timestamp=${now}&resolution=3600`);
  const v = j.result.data.map((x) => x[4]), cur = v[v.length - 1];
  return { now: r2(cur, 1), rank: r2(v.filter((x) => x <= cur).length / v.length, 2), min: r2(Math.min(...v), 1), max: r2(Math.max(...v), 1) };
});
const putcall = await soft('Put/call Deribit', async () => {
  const j = await get('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
  let p = 0, c = 0; for (const x of j.result) { if (/-P$/.test(x.instrument_name)) p += x.open_interest; else if (/-C$/.test(x.instrument_name)) c += x.open_interest; }
  return { ratio: r2(p / c, 2), puts: r2(p, 0), calls: r2(c, 0) };
});
const margin = await soft('Marge Bitfinex', async () => {
  const [l, s] = await Promise.all([get('https://api-pub.bitfinex.com/v2/stats1/pos.size:1m:tBTCUSD:long/last'), get('https://api-pub.bitfinex.com/v2/stats1/pos.size:1m:tBTCUSD:short/last')]);
  return { longs: r2(l[1], 0), shorts: r2(s[1], 0), shortShare: r2(s[1] / (l[1] + s[1]), 3) };
});
const ribbon = await soft('Hash ribbons', async () => {
  const j = await get('https://mempool.space/api/v1/mining/hashrate/1y');
  const h = j.hashrates.map((x) => x.avgHashrate), s30 = E.sma(Float64Array.from(h), 30), s60 = E.sma(Float64Array.from(h), 60), k = h.length - 1;
  let since = 0; for (let i = k; i > 60 && (s30[i] < s60[i]) === (s30[k] < s60[k]); i--) since++;
  return { capitulation: s30[k] < s60[k], days: since, ehs: r2(h[k] / 1e18, 0), gapPct: r2((s30[k] / s60[k] - 1) * 100, 1) };
});

const cycle = E.cycleAnalysis(closedD);
console.log(`DSS hebdo : ${cycle.sells.length} signaux de vente, ${cycle.buys.length} d'achat | ${cycle.tests.dss.both}/${cycle.tests.dss.combos} réglages battent HODL sur les deux périodes | DCA modulé : ${cycle.tests.tilt.both}/${cycle.tests.tilt.combos}`);
const KEEP = 1100, from = Math.max(0, n - KEEP);
const slice = (a, d = 1) => Array.from(a.slice(from), (x) => r2(x, d));
const ctxDays = (m) => Object.fromEntries(Object.entries(m).filter(([d]) => +d >= now - 450 * DAY));
const result = {
  ts: now, forming, price: r2(lastPx, 0), lastBar: S.t[last], source: 'Bitstamp BTC/USD',
  thresholds: { tb: P.tb, tt: P.tt, frac: P.frac },
  now: {
    bot: S.bot[last], top: S.top[last], rsi4: r2(I.rsi4[last], 1), atr: r2(atr, 0), e20: r2(I.e20[last], 0), e50: r2(I.e50[last], 0), hi60: r2(I.hi60[last], 0), lo60: r2(I.lo60[last], 0),
    pctB: r2(pctB, 2), rsiD: r2(I.rsiD[I.dIdx.get(E.dayStart(S.t[last]) - DAY)], 1), fng: fngNow ?? null, mvrv: r2(mvNow, 2), sma200: r2(sma200, 0), swingLo: r2(swingLo, 0), swingHi: r2(swingHi, 0),
    comp: { bot: comp(S.cb), top: comp(S.ct) }, plan,
  },
  bars: { t: Array.from(S.t.slice(from)), o: slice(S.o, 0), h: slice(S.h, 0), l: slice(S.l, 0), c: slice(S.c, 0), v: slice(S.v, 1), bot: slice(S.bot), top: slice(S.top) },
  ctx: { fng: ctxDays(fng), mvrv: ctxDays(mvrv) },
  daily: { t: closedD.slice(-130).map((r) => r[0]), o: closedD.slice(-130).map((r) => r[1]), h: closedD.slice(-130).map((r) => r[2]), l: closedD.slice(-130).map((r) => r[3]), c: closedD.slice(-130).map((r) => r[4]), v: closedD.slice(-130).map((r) => r[5]) },
  cycle, tests, evidence, overlays: { funding, ls, dvol, putcall, margin, ribbon },
  backtest: {
    split: S.t[split], first: S.t[firstScored], bars: n - firstScored, cost: 0.0015,
    in: period(A, firstScored, split), out: period(B, split, n), full: period(full, firstScored, n),
    curveIn: ds(A.curve), curveOut: ds(B.curve),
    beatShare: r2(opt.beatShare, 2), combos: opt.grid.length,
    grid: opt.grid.map((g) => [g.tb, g.tt, g.frac, r2(g.inEdge * 100, 1), g.inTrades, r2(g.outEdge * 100, 1), g.outTrades]),
    stats: {
      botIn: stats(inRows(rowsBot, 0, split), 'bot'), botOut: stats(inRows(rowsBot, split, n), 'bot'),
      topIn: stats(inRows(rowsTop, 0, split), 'top'), topOut: stats(inRows(rowsTop, split, n), 'top'),
      baseIn, baseOut,
    },
    events: { bot: rowsBot.slice(-40).map(trim), top: rowsTop.slice(-40).map(trim) },
  },
};
writeFileSync(OUT, JSON.stringify(result));
const q = (x) => (x == null ? '—' : x);
console.log(`BTC ${result.price} $ | bottom ${S.bot[last]} / top ${S.top[last]} | F&G ${q(fngNow)} MVRV ${q(r2(mvNow))}`);
console.log(`Apprentissage ${new Date(S.t[firstScored]).toISOString().slice(0, 10)} → 2022 : ${A.final.toFixed(3)} BTC pour 1 (${A.trades} ordres) | Hors échantillon 2023 → : ${B.final.toFixed(3)} BTC (${B.trades} ordres)`);
console.log(`DCA : ${tests.dca.beatOut}/${tests.dca.combos} combinaisons battent le DCA hors échantillon | tendance : ${tests.trend.beatIn}/${tests.trend.combos} en apprentissage, ${tests.trend.beatOut}/${tests.trend.combos} hors échantillon`);
console.log(`Signaux creux : ${rowsBot.length}, sommets : ${rowsTop.length} | écrit ${OUT}`);
