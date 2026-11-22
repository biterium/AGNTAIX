'use strict';
/* AIX AGNTfi · Core Model's open engine (JavaScript, no dependencies): Monte-Carlo price paths with a p10–p90 fan,
   market regimes by rolling volatility, the constant-product impact equation behind ORB, and the paper portfolio
   that opens and closes real simulated trades by TP / SL / horizon. The web app (sim/site) calls these functions;
   tests live in test/sim.test.js. */

const rngFactory = seed => {                                        /* deterministic PRNG so every re-run of a slider matches */
  let s = (seed >>> 0) || 88172645;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
};
function gauss(rng) {                                               /* Box–Muller */
  let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const quantile = (sorted, q) => {                                   /* linear interpolation on a sorted array */
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

/* ---------- Monte-Carlo: GBM paths continued from the last known close ---------- */
/* prices: historical daily closes (the 7-day window of /market_chart). Returns per-step percentiles p10..p90,
   the median path, the probability of finishing above the entry and the VaR at the horizon. */
function monteCarlo(prices, { steps = 30, paths = 1000, seed = 1, vol = null } = {}) {
  const rets = []; for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]));
  const mu = rets.reduce((a, b) => a + b, 0) / Math.max(rets.length, 1);
  const sd = vol != null ? vol : Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(rets.length - 1, 1));
  const S0 = prices[prices.length - 1], rng = rngFactory(seed);
  const fans = [];                                                  /* fans[t] = raw path values, turned into percentiles below */
  const finals = new Array(paths);
  for (let p = 0; p < paths; p++) {
    let S = S0;
    for (let t = 1; t <= steps; t++) {
      S *= Math.exp(mu - sd * sd / 2 + sd * gauss(rng));
      (fans[t - 1] || (fans[t - 1] = [])).push(S);
    }
    finals[p] = S;
  }
  const rows = fans.map(a => { a.sort((x, y) => x - y);
    return { p10: quantile(a, .10), p25: quantile(a, .25), p50: quantile(a, .50), p75: quantile(a, .75), p90: quantile(a, .90) }; });
  finals.sort((x, y) => x - y);
  return { start: S0, steps, paths, vol: sd, fan: rows,
    probUp: finals.filter(v => v > S0).length / paths,
    var95: 1 - quantile(finals, .05) / S0 };                        /* one-sided 5% loss vs today's price */
}

/* ---------- Market regimes: TREND / FLAT by rolling realized volatility ---------- */
/* window: how many returns the rolling vol uses; high/low: the hysteresis band (average absolute per-step move). */
function regimes(prices, { window = 5, high = 0.06, low = 0.03 } = {}) {
  const out = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < window) { out.push({ i, vol: null, regime: 'WARMUP' }); continue; }
    const seg = prices.slice(i - window, i + 1), rets = [];
    for (let j = 1; j < seg.length; j++) rets.push(Math.abs(seg[j] / seg[j - 1] - 1));
    const vol = rets.reduce((a, b) => a + b, 0) / rets.length;
    out.push({ i, vol, regime: vol >= high ? 'TREND' : vol <= low ? 'FLAT' : 'TRANSITION' });
  }
  return out;
}
function currentRegime(list) {                                      /* last decisive regime, ignoring TRANSITION / WARMUP */
  for (let i = list.length - 1; i >= 0; i--)
    if (list[i].regime === 'TREND' || list[i].regime === 'FLAT') return list[i];
  return null;
}

/* ---------- ORB's constant-product impact ---------- */
/* Impact(q, R) = 1 − (R / (R + q))² ; R = token reserves in the pool, q = tokens an operator group can sell. */
const impact = (q, R) => R > 0 ? 1 - (R / (R + q)) ** 2 : 1;
const dangerImpact = 0.5;                                           /* a proven group that can push the price down ≥50% is DANGER */

/* ---------- Paper portfolio: trades really open and close by TP / SL / time ---------- */
function makeState(capital = 10000) { return { cash: capital, capital, equity: capital, trades: [], closed: [], history: [{ t: 0, equity: capital }] }; }
function openTrade(state, { id, symbol, side = 'long', qty, entry, tp, sl, horizon, openedAt }) {
  if (side !== 'long') throw new Error('paper mode is long-only');
  const cost = qty * entry; if (cost > state.cash + 1e-12) throw new Error('not enough paper capital');
  state.cash -= cost;
  state.trades.push({ id, symbol, side, qty, entry, tp, sl, horizon, openedAt, status: 'OPEN' });
  return state;
}
/* feed new price bars to every open trade; a close happens on the first touch of TP, SL or the horizon */
function stepPortfolio(state, bars) {                                /* bars: [{symbol, t, price}] */
  const done = [];
  for (const tr of state.trades) {
    const bar = bars.find(b => b.symbol === tr.symbol); if (!bar) continue;
    const age = bar.t - tr.openedAt, hitTp = bar.price >= tr.tp, hitSl = bar.price <= tr.sl;
    let exit = null, reason = null;
    if (hitTp && hitSl) { exit = bar.price < tr.entry ? tr.sl : tr.tp; reason = exit === tr.sl ? 'SL' : 'TP'; }
    else if (hitTp) { exit = tr.tp; reason = 'TP'; }
    else if (hitSl) { exit = tr.sl; reason = 'SL'; }
    else if (age >= tr.horizon) { exit = bar.price; reason = 'TIME'; }
    if (exit == null) { tr.last = bar.price; continue; }
    tr.exit = exit; tr.exitT = bar.t; tr.reason = reason; tr.status = 'CLOSED';
    tr.pnl = (exit - tr.entry) * tr.qty; state.cash += tr.qty * exit;
    state.closed.push(tr); done.push(tr);
  }
  state.trades = state.trades.filter(t => !done.includes(t));
  const mark = state.trades.reduce((a, t) => a + t.qty * (t.last ?? t.entry), 0);
  state.equity = state.cash + mark;
  state.history.push({ t: bars.length ? bars[bars.length - 1].t : null, equity: state.equity });
  return state;
}
/* Full replay of a decision stream: TP / SL / horizon are fractions of the entry, so the site's sliders can
   recompute the whole simulation instantly. A decision carries either a historical `price`, or a `path` array
   (the Monte-Carlo median path continued from the last known close) plus `now` — the live WebSocket trade
   price used while the path is not reached yet. `fetchLive` is an optional async hook: when a decision has no
   price at all, the engine asks it for one (the closed server uses CoinGecko /market_chart through it). */
async function simulate(decisions, { tpPct = 0.25, slPct = 0.15, horizon = 24, capital = 10000, stakeFrac = 0.1, fetchLive = null } = {}) {
  const state = makeState(capital);
  let n = 0;
  for (const d of decisions) {
    let price = d.price;
    if (price == null && d.path && d.now != null) {                   /* continue from the last known close */
      const past = Math.min(d.t - (d.lastT ?? d.t), d.path.length - 1);
      price = Math.max(d.now, past >= 0 ? d.path[Math.max(past, 0)] : d.path[0]);
    }
    if (price == null && fetchLive) price = await fetchLive(d);
    if (price == null) continue;                                     /* unknown stays unknown, never $0 */
    d.price = price;
    const bars = [{ symbol: d.symbol, t: d.t, price }];
    if (d.action === 'TRADE' && d.score >= 70) {                      /* only clean verdicts become paper trades */
      const entry = price, qty = (state.cash * stakeFrac) / entry;
      openTrade(state, { id: ++n, symbol: d.symbol, qty, entry, tp: entry * (1 + tpPct), sl: entry * (1 - slPct), horizon, openedAt: d.t });
    }
    stepPortfolio(state, bars);
  }
  return state;
}

/* ---------- CSV export of decisions and closed trades ---------- */
const csvCell = v => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function toCsv(rows, cols) {
  return [cols.join(',')].concat(rows.map(r => cols.map(c => csvCell(r[c])).join(','))).join('\n') + '\n';
}
function decisionsCsv(decisions) {
  const flat = decisions.map(d => ({ ...d, reasons: (d.reasons || []).join(' | ') }));
  return toCsv(flat, ['t', 'symbol', 'mint', 'score', 'verdict', 'impact', 'regime', 'action', 'price', 'reasons']);
}
function tradesCsv(state) {
  return toCsv(state.closed, ['id', 'symbol', 'side', 'qty', 'entry', 'exit', 'tp', 'sl', 'horizon', 'openedAt', 'exitT', 'reason', 'pnl']);
}

globalThis.AIXEngine = { monteCarlo, regimes, currentRegime, impact, dangerImpact,
  makeState, openTrade, stepPortfolio, simulate, toCsv, decisionsCsv, tradesCsv, rngFactory };
if (typeof module !== "undefined") module.exports = AIXEngine;
