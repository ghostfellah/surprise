// Moteur de détection des creux et des sommets locaux du bitcoin.
// Pur calcul, sans accès réseau : utilisé par le collecteur Node et inclus tel quel dans la page.
// Aucune anticipation : le score de la bougie i n'utilise que des données connues à sa clôture.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BtcEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAY = 864e5;
  const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
  const dayStart = (t) => Math.floor(t / DAY) * DAY;

  function ema(v, n) {
    const k = 2 / (n + 1), o = new Float64Array(v.length);
    let e = v[0];
    for (let i = 0; i < v.length; i++) { e = i ? v[i] * k + e * (1 - k) : v[0]; o[i] = e; }
    return o;
  }
  function sma(v, n) {
    const o = new Float64Array(v.length).fill(NaN);
    let s = 0;
    for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; }
    return o;
  }
  function stdev(v, n) {
    const o = new Float64Array(v.length).fill(NaN);
    let s = 0, q = 0;
    for (let i = 0; i < v.length; i++) {
      s += v[i]; q += v[i] * v[i];
      if (i >= n) { s -= v[i - n]; q -= v[i - n] * v[i - n]; }
      if (i >= n - 1) { const m = s / n; o[i] = Math.sqrt(Math.max(0, q / n - m * m)); }
    }
    return o;
  }
  function rsi(c, n = 14) {
    const o = new Float64Array(c.length).fill(NaN);
    if (c.length <= n) return o;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
    g /= n; l /= n; o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
      o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return o;
  }
  function atr(h, l, c, n = 14) {
    const o = new Float64Array(c.length).fill(NaN);
    let a = 0;
    for (let i = 1; i < c.length; i++) {
      const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      if (i <= n) { a += tr; if (i === n) { a /= n; o[i] = a; } } else { a = (a * (n - 1) + tr) / n; o[i] = a; }
    }
    return o;
  }
  function rollExtreme(v, n, fn) {
    const o = new Float64Array(v.length).fill(NaN);
    for (let i = n - 1; i < v.length; i++) { let m = v[i]; for (let j = i - n + 1; j < i; j++) m = fn(m, v[j]); o[i] = m; }
    return o;
  }

  // Poids fixés a priori (somme = 1). Ils ne sont jamais ajustés sur l'historique, pour limiter le surapprentissage.
  const WB = { rsi4: 0.12, rsiD: 0.10, bb: 0.10, stretch: 0.12, dd: 0.10, cap: 0.12, div: 0.12, fng: 0.12, mvrv: 0.10 };
  const WT = { rsi4: 0.12, rsiD: 0.10, bb: 0.10, stretch: 0.12, dd: 0.10, cap: 0.12, div: 0.12, fng: 0.12, mvrv: 0.10 };
  const LABELS = {
    rsi4: 'RSI 4 h', rsiD: 'RSI journalier', bb: 'Bandes de Bollinger 4 h', stretch: 'Écart à la moyenne 50',
    dd: 'Distance au plus haut / bas 60 j', cap: 'Mèche et volume de capitulation', div: 'Divergence du RSI',
    fng: 'Peur et avidité', mvrv: 'MVRV (valorisation on-chain)',
  };

  // Séries journalières indexées par jour UTC. 4h et journalier : { t, o, h, l, c, v } en tableaux.
  // ctx : { fng: {jourUTC: valeur}, mvrv: {jourUTC: valeur} } ; les deux sont décalées d'un jour.
  function build(c4, cd, ctx) {
    const n = c4.t.length;
    const rsi4 = rsi(c4.c, 14), atr4 = atr(c4.h, c4.l, c4.c, 14);
    const mid = sma(c4.c, 20), sd = stdev(c4.c, 20);
    const e50 = ema(c4.c, 50), e20 = ema(c4.c, 20);
    const dev = new Float64Array(n); for (let i = 0; i < n; i++) dev[i] = c4.c[i] - e50[i];
    const devSd = stdev(dev, 100), volMa = sma(c4.v, 30);
    const hi60 = rollExtreme(c4.h, 360, Math.max), lo60 = rollExtreme(c4.l, 360, Math.min);
    const rsiD = rsi(cd.c, 14);
    const dIdx = new Map(); cd.t.forEach((t, i) => dIdx.set(dayStart(t), i));
    const lag = (map, t) => { const v = map && map[dayStart(t) - DAY]; return v == null ? NaN : v; };

    const bot = new Float64Array(n).fill(NaN), top = new Float64Array(n).fill(NaN);
    const cb = {}, ct = {};
    for (const k of Object.keys(WB)) { cb[k] = new Float32Array(n).fill(NaN); ct[k] = new Float32Array(n).fill(NaN); }

    const K = 5, pl = [], ph = []; // pivots confirmés (indice, prix, rsi)
    const START = 400;
    for (let i = 0; i < n; i++) {
      // Pivots confirmés avec K bougies de retard : jamais d'anticipation.
      const j = i - K;
      if (j >= K && !isNaN(rsi4[j])) {
        let isL = true, isH = true;
        for (let q = j - K; q <= j + K; q++) { if (c4.l[q] < c4.l[j]) isL = false; if (c4.h[q] > c4.h[j]) isH = false; }
        if (isL) pl.push([j, c4.l[j], rsi4[j]]);
        if (isH) ph.push([j, c4.h[j], rsi4[j]]);
      }
      if (i < START || isNaN(devSd[i]) || isNaN(hi60[i])) continue;

      const dIndex = dIdx.get(dayStart(c4.t[i]) - DAY); // dernier jour clos
      const rd = dIndex != null ? rsiD[dIndex] : NaN;
      const pctB = sd[i] > 0 ? (c4.c[i] - (mid[i] - 2 * sd[i])) / (4 * sd[i]) : 0.5;
      const z = devSd[i] > 0 ? dev[i] / devSd[i] : 0;
      const dd = 1 - c4.c[i] / hi60[i], up = c4.c[i] / lo60[i] - 1;
      const fng = lag(ctx.fng, c4.t[i]), mv = lag(ctx.mvrv, c4.t[i]);

      // Mèche de capitulation (sur cette bougie ou la précédente), pondérée par le volume.
      let capB = 0, capT = 0;
      for (let q = Math.max(0, i - 1); q <= i; q++) {
        const rg = c4.h[q] - c4.l[q]; if (!(rg > 0) || !(atr4[q] > 0)) continue;
        const body = Math.min(1, rg / atr4[q]), vr = volMa[q - 1] > 0 ? c4.v[q] / volMa[q - 1] : 1;
        const lw = (Math.min(c4.o[q], c4.c[q]) - c4.l[q]) / rg, uw = (c4.h[q] - Math.max(c4.o[q], c4.c[q])) / rg;
        const vc = clamp((vr - 1) / 1.5);
        capB = Math.max(capB, Math.sqrt(clamp((lw - 0.45) / 0.4) * vc) * body);
        capT = Math.max(capT, Math.sqrt(clamp((uw - 0.45) / 0.4) * vc) * body);
      }
      // Divergences : nouveau extrême de prix récent sans confirmation du RSI.
      let divB = 0, divT = 0;
      if (pl.length >= 2) {
        const a = pl[pl.length - 2], b = pl[pl.length - 1];
        if (i - b[0] <= 48 && b[0] - a[0] >= 6 && b[0] - a[0] <= 120 && b[1] < a[1] * 0.998 && b[2] > a[2] + 2 && a[2] < 40) divB = clamp((b[2] - a[2]) / 12);
      }
      if (ph.length >= 2) {
        const a = ph[ph.length - 2], b = ph[ph.length - 1];
        if (i - b[0] <= 48 && b[0] - a[0] >= 6 && b[0] - a[0] <= 120 && b[1] > a[1] * 1.002 && b[2] < a[2] - 2 && a[2] > 60) divT = clamp((a[2] - b[2]) / 12);
      }
      const B = {
        rsi4: clamp((35 - rsi4[i]) / 20), rsiD: isNaN(rd) ? 0 : clamp((40 - rd) / 20), bb: clamp((0.1 - pctB) / 0.5),
        stretch: clamp((-z - 1) / 2), dd: clamp((dd - 0.15) / 0.25), cap: capB, div: divB,
        fng: isNaN(fng) ? 0 : clamp((30 - fng) / 20), mvrv: isNaN(mv) ? 0 : clamp((1.2 - mv) / 0.5),
      };
      const T = {
        rsi4: clamp((rsi4[i] - 65) / 20), rsiD: isNaN(rd) ? 0 : clamp((rd - 60) / 20), bb: clamp((pctB - 0.9) / 0.5),
        stretch: clamp((z - 1) / 2), dd: clamp((up - 0.25) / 0.5), cap: capT, div: divT,
        fng: isNaN(fng) ? 0 : clamp((fng - 70) / 20), mvrv: isNaN(mv) ? 0 : clamp((mv - 1.8) / 1.2),
      };
      let sb = 0, st = 0;
      for (const k of Object.keys(WB)) { sb += WB[k] * B[k]; st += WT[k] * T[k]; cb[k][i] = B[k]; ct[k][i] = T[k]; }
      bot[i] = Math.round(sb * 1000) / 10; top[i] = Math.round(st * 1000) / 10;
    }
    return {
      n, t: c4.t, o: c4.o, h: c4.h, l: c4.l, c: c4.c, v: c4.v, bot, top, cb, ct,
      ind: { rsi4, atr4, e20, e50, mid, sd, hi60, lo60, rsiD, dIdx, pl, ph },
    };
  }

  // Épisodes : un signal par vague de survente (ou de surachat), réarmé quand le score retombe de 15 points.
  function episodes(S, tb, tt, from = 0, to = S.n) {
    const out = [];
    let armB = true, armT = true;
    for (let i = from; i < to; i++) {
      if (isNaN(S.bot[i])) continue;
      if (S.bot[i] < tb - 15) armB = true;
      if (S.top[i] < tt - 15) armT = true;
      if (armB && S.bot[i] >= tb) { out.push({ i, side: 'bot' }); armB = false; }
      if (armT && S.top[i] >= tt) { out.push({ i, side: 'top' }); armT = false; }
    }
    return out;
  }

  // Stratégie « sats » : on part de 1 BTC. Au sommet on vend une fraction, au creux on rachète tout.
  // Exécution à l'ouverture de la bougie suivante, coût aller simple (frais + glissement) = cost.
  function backtest(S, p, from, to, wantCurve) {
    const cost = p.cost == null ? 0.0015 : p.cost;
    let btc = 1, usd = 0, trades = 0, wins = 0, lastSellPx = 0, minEq = 1, maxEq = 1, mdd = 0;
    const curve = [], log = [];
    let armB = true, armT = true;
    for (let i = from; i < to - 1; i++) {
      if (!isNaN(S.bot[i])) {
        if (S.bot[i] < p.tb - 15) armB = true;
        if (S.top[i] < p.tt - 15) armT = true;
        const px = S.o[i + 1];
        if (armT && S.top[i] >= p.tt && btc > 1e-9) {
          const sell = btc * p.frac; btc -= sell; usd += sell * px * (1 - cost); lastSellPx = px; armT = false; trades++;
          log.push({ i: i + 1, side: 'sell', px });
        } else if (armB && S.bot[i] >= p.tb && usd > 1e-9) {
          const got = usd / (px * (1 + cost)); if (lastSellPx && px < lastSellPx * (1 - 2 * cost)) wins++;
          btc += got; usd = 0; armB = false; trades++; log.push({ i: i + 1, side: 'buy', px, btc });
        }
      }
      const eq = btc + usd / S.c[i];
      if (eq > maxEq) maxEq = eq; mdd = Math.min(mdd, eq / maxEq - 1); if (eq < minEq) minEq = eq;
      if (wantCurve && (i - from) % 6 === 0) curve.push([S.t[i], eq]);
    }
    const final = btc + usd / S.c[to - 1];
    return { final, edge: final - 1, trades, wins, mdd, curve, log };
  }

  const HORIZONS = { d3: 18, d7: 42, d14: 84 };
  const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function forward(S, eps, side) {
    const rows = [];
    for (const e of eps) {
      if (e.side !== side || e.i + 1 >= S.n) continue;
      const px = S.o[e.i + 1], r = { i: e.i, t: S.t[e.i], px, score: side === 'bot' ? S.bot[e.i] : S.top[e.i] };
      for (const [k, h] of Object.entries(HORIZONS)) r[k] = e.i + h < S.n ? S.c[e.i + h] / px - 1 : null;
      const end = Math.min(S.n - 1, e.i + 42);
      let ext = px; for (let q = e.i + 1; q <= end; q++) ext = side === 'bot' ? Math.min(ext, S.l[q]) : Math.max(ext, S.h[q]);
      r.adverse = side === 'bot' ? ext / px - 1 : ext / px - 1; // creux atteint (bot) / sommet atteint (top) sur 7 j
      rows.push(r);
    }
    return rows;
  }
  function summarize(rows, side) {
    const o = { n: rows.length };
    for (const k of Object.keys(HORIZONS)) {
      const v = rows.map((r) => r[k]).filter((x) => x != null);
      o[k] = { n: v.length, med: median(v), right: v.length ? v.filter((x) => (side === 'bot' ? x > 0 : x < 0)).length / v.length : NaN };
    }
    const ad = rows.map((r) => r.adverse); o.adverseMed = median(ad);
    return o;
  }
  function baseline(S, from, to) {
    const o = {};
    for (const [k, h] of Object.entries(HORIZONS)) {
      const v = []; for (let i = from; i < to - h; i += 3) if (!isNaN(S.bot[i])) v.push(S.c[i + h] / S.o[i + 1] - 1);
      o[k] = { n: v.length, med: median(v), up: v.length ? v.filter((x) => x > 0).length / v.length : NaN };
    }
    return o;
  }

  // Sélection des seuils sur la période d'apprentissage, évaluation sur la période suivante (walk-forward simple).
  function optimize(S, splitIdx) {
    const first = S.bot.findIndex((x) => !isNaN(x)), grid = [];
    const TB = [45, 50, 55, 60, 65], TT = [45, 50, 55, 60, 65], FR = [0.25, 0.5, 1];
    for (const tb of TB) for (const tt of TT) for (const frac of FR) {
      const p = { tb, tt, frac };
      const a = backtest(S, p, first, splitIdx, false), b = backtest(S, p, splitIdx, S.n, false);
      grid.push({ ...p, inEdge: a.edge, inTrades: a.trades, outEdge: b.edge, outTrades: b.trades });
    }
    const ok = grid.filter((g) => g.inTrades >= 6);
    const best = [...(ok.length ? ok : grid)].sort((x, y) => y.inEdge - x.inEdge || x.inTrades - y.inTrades)[0];
    const beat = grid.filter((g) => g.outTrades > 0 && g.outEdge > 0).length;
    return { best, grid, beatShare: beat / grid.length };
  }

  // DCA hebdomadaire (1 unité par semaine) avec réserve de cash : on déploie la réserve sur signal de creux,
  // ou après `W` semaines sans signal. Le cash restant est valorisé au dernier prix. Retourne les BTC accumulés.
  function dcaTiming(S, from, to, T, W, cost = 0.0015) {
    const WEEK = 42; let cash = 0, btc = 0, since = 0, arm = true;
    for (let i = from; i < to - 1; i++) {
      const px = S.o[i + 1];
      if ((i - from) % WEEK === 0) { cash += 1; if (T == null) { btc += cash / (px * (1 + cost)); cash = 0; continue; } }
      if (T == null) continue;
      since++;
      if (S.bot[i] < T - 15) arm = true;
      const sig = arm && S.bot[i] >= T;
      if (cash > 0 && (sig || since >= W * WEEK)) { btc += cash / (px * (1 + cost)); cash = 0; since = 0; if (sig) arm = false; }
    }
    return btc + cash / S.c[to - 1];
  }
  // Filtre de tendance sur bougies journalières : BTC au-dessus de la moyenne mobile, dollars en dessous.
  function trendFilter(D, n, band, from, to, cost = 0.0015) {
    const m = sma(Float64Array.from(D.c), n);
    let btc = 1, usd = 0, trades = 0, inBtc = true;
    for (let i = Math.max(from, n); i < to - 1; i++) {
      if (isNaN(m[i])) continue;
      const px = D.o[i + 1];
      if (inBtc && D.c[i] < m[i] * (1 - band)) { usd = btc * px * (1 - cost); btc = 0; inBtc = false; trades++; }
      else if (!inBtc && D.c[i] > m[i] * (1 + band)) { btc = usd / (px * (1 + cost)); usd = 0; inBtc = true; trades++; }
    }
    return { final: btc + usd / D.c[to - 1], trades };
  }

  return { build, episodes, backtest, dcaTiming, trendFilter, forward, summarize, baseline, optimize, ema, sma, rsi, atr, clamp, dayStart, WB, WT, LABELS, HORIZONS, DAY };
});
