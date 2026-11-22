# AIX : AGNTfi — simulator and live tape

The open part of the new **AIX : AGNTfi** terminal: everything behind the Core Model chart, the market-regime
badge, the paper portfolio and the CSV export. No dependencies; the browser build is `sim/site/engine.js`
(the same file).

| File | What it is |
|---|---|
| [`engine.js`](engine.js) | Monte-Carlo GBM paths with the p10–p90 fan (continued from the 7-day close), TREND / FLAT regimes by rolling volatility, ORB's constant-product impact `Impact(q, R) = 1 − (R/(R+q))²`, the paper portfolio that opens and closes trades by TP / SL / horizon, CSV writers |
| [`live.js`](live.js) | The live tape: Binance public WebSocket for real trades; CoinGecko REST (`/market_chart`) for history when `COINGECKO_API_KEY` is set |
| [`site/index.html`](site/index.html) | The page itself: EN / RU switch, running tape (click a tick to pick the coin), coin list, decision cards (click one to simulate it), instant TP / SL / horizon sliders, pause, portfolio reset, equity curve, exports |

Run it: open `sim/site/index.html` in a browser, or `node -e "require('./sim/live').marketChart('solana').then(console.log)"`.
Tests: `test/sim.test.js` (`npm test`).

## API keys — read this before shipping

* **Never commit a key.** The key lives only in the environment (`COINGECKO_API_KEY`) or the server's secret store.
* Keys that appear in a chat, an issue or a screenshot are **revoked and reissued** — see [SECURITY.md](../SECURITY.md).
* CoinGecko's **WebSocket needs a paid plan**; demo keys (`CG-…`) do not work on `pro-api.coingecko.com`.
  The live tape therefore uses **Binance's public stream** (no key at all); CoinGecko's key is used only for
  REST `/market_chart` history. Unknown numbers stay N/A, never $0.

## Next steps (planned)

* Backtests over longer windows through `/market_chart`.
* Telegram alerts when a decision becomes TRADE ([@AIXAGNTfi_bot](https://t.me/AIXAGNTfi_bot)).
* Portfolio-wide VaR and correlations across every open position.
