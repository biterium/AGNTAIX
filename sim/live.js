'use strict';
/* AIX AGNTfi · the live tape: real trades over WebSocket.
   - Binance public stream (no key): wss://stream.binance.com:9443/ws — spot trade prices, free and open to all.
   - CoinGecko's WebSocket needs a paid plan; its API key is only used for REST here (/market_chart history for
     the Core Model chart and the Monte-Carlo fan). The key is read from the environment, never committed:
       COINGECKO_API_KEY  (demo keys starting with "CG-" are not valid on pro-api; see docs)
   Everything degrades to null when offline — an unknown number stays N/A, never $0. */

const CG_REST = 'https://api.coingecko.com/api/v3';
const CG_PRO = 'https://pro-api.coingecko.com/api/v3';
const cgKey = () => process.env.COINGECKO_API_KEY || null;

/* ---------- CoinGecko REST (history behind the Core Model chart) ---------- */
async function cg(pathname, params) {
  const url = new URL(cgKey() ? CG_PRO : CG_REST);                  /* a key switches to pro-api automatically */
  url.pathname = pathname; Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = {}; const key = cgKey(); if (key) headers['x-cg-pro-api-key'] = key;
  const res = await fetch(url, { headers }); if (!res.ok) return null;
  return res.json();
}
/* days=7 → hourly prices, exactly what the fan continues from */
const marketChart = (coinId, days = 7) => cg('/coins/market_chart', { vs_currency: 'usd', days: String(days), interval: days <= 2 ? 'daily' : 'hourly' })
  .then(j => Array.isArray(j?.prices) ? j.prices.map(p => ({ t: p[0], price: p[1] })) : null);

/* ---------- Binance WebSocket: one connection, many symbols ---------- */
/* usage: const tape = openTape(['solusdt','bonausdt']); tape.on('trade', t => …); tape.close(); */
function openTape(symbols, { url = 'wss://stream.binance.com:9443/stream' } = {}) {
  const listeners = { trade: [], status: [] };
  const emit = (k, v) => listeners[k].forEach(f => { try { f(v); } catch { /* a bad listener never kills the tape */ } });
  let ws = null, paused = false, buffer = [];                        /* pause keeps the feed but holds it back */
  const decode = raw => { try { const m = JSON.parse(raw); if (!m.data) return null; const d = m.data;
    return { symbol: d.s, price: +d.p, qty: +d.q, t: d.T, side: d.m ? 'sell' : 'buy', src: 'binance.ws' }; } catch { return null; } };
  const connect = () => {
    if (typeof WebSocket === 'undefined') { emit('status', { status: 'offline (no WebSocket in this runtime)' }); return null; }
    ws = new WebSocket(`${url}?ws=${symbols.map(s => s + '@trade').join('/')}`);
    ws.onopen = () => emit('status', { status: 'open' });
    ws.onclose = () => emit('status', { status: 'closed' });
    ws.onerror = () => emit('status', { status: 'error' });
    ws.onmessage = e => {
      if (paused) { buffer.push(e.data); return; }
      while (buffer.length) { const t = decode(buffer.shift()); if (t) emit('trade', t); }
      const t = decode(e.data); if (t) emit('trade', t);
    };
    return ws;
  };
  connect();
  return {
    on(ev, fn) { (listeners[ev] || (listeners[ev] = [])).push(fn); return this; },
    pause() { paused = true; }, resume() { paused = false; const b = buffer.splice(0); b.forEach(r => { const t = decode(r); if (t) emit('trade', t); }); },
    get paused() { return paused; },
    close() { if (ws) try { ws.close(); } catch { /* already gone */ } }
  };
}

module.exports = { cg, marketChart, openTape, cgKey };
