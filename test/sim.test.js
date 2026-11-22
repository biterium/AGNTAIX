'use strict';
/* Tests for sim/engine.js — AIX AGNTfi's open simulation engine: the Monte-Carlo fan, market regimes,
   ORB's impact equation and the paper portfolio behind the site's sliders. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../sim/engine');

test('monteCarlo: deterministic per seed, ordered percentiles, continued from the last close', async () => {
  const prices = Array.from({ length: 24 }, (_, i) => 100 * (1 + Math.sin(i / 3) * 0.05));
  const a = E.monteCarlo(prices, { steps: 10, paths: 300, seed: 7 });
  const b = E.monteCarlo(prices, { steps: 10, paths: 300, seed: 7 });
  assert.deepEqual(a.fan, b.fan);                                   /* same seed → same fan, so sliders are stable */
  assert.equal(a.start, prices[prices.length - 1]);                 /* the fan continues from the 7-day close */
  assert.equal(a.fan.length, 10);
  for (const f of a.fan) assert.ok(f.p10 <= f.p25 && f.p25 <= f.p50 && f.p50 <= f.p75 && f.p75 <= f.p90);
  assert.ok(a.var95 > -1 && a.probUp >= 0 && a.probUp <= 1);
});

test('regimes: FLAT on a quiet series, TREND on a fast one, hysteresis in between', () => {
  const flat = Array.from({ length: 30 }, (_, i) => 100 + i * 0.001);
  const trend = Array.from({ length: 30 }, (_, i) => 100 * Math.pow(1.05, i));
  assert.equal(E.currentRegime(E.regimes(flat)).regime, 'FLAT');
  assert.equal(E.currentRegime(E.regimes(trend, { high: 0.02 })).regime, 'TREND');
  assert.equal(E.regimes(flat).slice(0, 5).every(r => r.regime === 'WARMUP'), true);
});

test('impact: the constant-product equation matches by hand', () => {
  assert.equal(E.impact(1, 1), 0.75);                                /* 1 − (1/2)² */
  assert.equal(E.impact(0, 10), 0);
  assert.ok(E.impact(3, 1) > E.dangerImpact);                        /* q = 3R pushes past the 50% DANGER line */
});

test('paper portfolio: trades really close by TP, SL and time; capital is marked', async () => {
  const decs = []; let p = 100;
  for (let t = 1; t <= 60; t++) {
    p *= (t % 7 === 0 ? 1.3 : t % 11 === 0 ? 0.8 : 1.01);
    decs.push({ t: t * 3600e3, symbol: 'X', mint: 'm', score: t % 3 ? 80 : 50, verdict: 'CLEAN',
      impact: 0.1, regime: 'TREND', action: t % 3 ? 'TRADE' : 'AVOID', price: p });
  }
  const wide = await E.simulate(decs, { tpPct: .25, slPct: .15, horizon: 24 * 3600e3 });
  const tight = await E.simulate(decs, { tpPct: .05, slPct: .40, horizon: 2 * 3600e3 });
  assert.ok(wide.closed.length > 0 && wide.equity !== tight.equity);/* moving a slider recomputes the whole run */
  assert.ok(wide.closed.every(c => ['TP', 'SL', 'TIME'].includes(c.reason)));
  assert.ok(wide.closed.some(c => c.reason === 'TP') && wide.closed.some(c => c.reason === 'SL'));
  for (const tr of wide.closed) assert.equal(tr.pnl, (tr.exit - tr.entry) * tr.qty);
  assert.ok(Math.abs(wide.equity - wide.cash - wide.trades.reduce((a, t) => a + t.qty * (t.last ?? t.entry), 0)) < 1e-6);
});

test('openTrade guards the paper capital', () => {
  const st = E.makeState(100);
  assert.throws(() => E.openTrade(st, { id: 1, symbol: 'X', qty: 10, entry: 50, tp: 60, sl: 40, horizon: 5, openedAt: 0 }), /capital/);
});

test('CSV export: decisions and closed trades, quoted when needed', async () => {
  const decs = [{ t: 1, symbol: 'A,B', mint: 'm', score: 90, verdict: 'CLEAN', impact: 0.2, regime: 'TREND', action: 'TRADE', price: 1, reasons: ['x "y"'] }];
  const csv = E.decisionsCsv(decs);
  assert.ok(csv.startsWith('t,symbol,mint,score,verdict,impact,regime,action,price,reasons\n'));
  assert.ok(csv.includes('"A,B"'));                                  /* commas are quoted, never split a cell */
  const st = await E.simulate([{ ...decs[0], symbol: 'A' }, { t: 2, symbol: 'A', mint: 'm', score: 90, verdict: 'CLEAN', impact: 0.2, regime: 'TREND', action: 'AVOID', price: 2 }],
    { tpPct: 1.5, slPct: .5, horizon: 1 });
  assert.ok(E.tradesCsv(st).includes('reason,pnl'));
});
