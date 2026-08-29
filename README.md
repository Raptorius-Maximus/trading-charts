# Charts — self-hosted trading dashboard

A small, self-hosted, multi-pane trading chart dashboard. Runs as one
process on `0.0.0.0:8850`, reachable from any device on the LAN.

Charts only — no order placement, no trading execution, no accounts, no
price predictions or signals.

## Stack, and why

- **Backend: FastAPI**, served by uvicorn. The live crypto feed needs a
  long-lived websocket proxy to Hyperliquid running its own reconnect
  loop concurrently with normal HTTP requests. FastAPI/Starlette's native
  asyncio support means that proxy is just another coroutine sharing the
  event loop with the HTTP routes — no extra thread/greenlet plumbing the
  way it would need under Flask's synchronous WSGI model. Flask would be
  fine for the static+HTTP half alone; the websocket half is where async
  earns its keep.
- **Frontend: plain HTML/CSS/vanilla JS.** No framework.
- **Charts: [KLineChart](https://klinecharts.com/)** (`klinecharts` on
  npm), vendored locally as a UMD build — see below.

### Chart library: KLineChart, not Lightweight Charts

This project originally used TradingView's Lightweight Charts. Per an
explicit later instruction, it was replaced end-to-end with **KLineChart**
(`klinecharts`, MIT-free **Apache-2.0**, independent of TradingView) so
that no TradingView-origin code ships anywhere in the project. Verified:

```
$ grep -i tradingview package.json frontend/static/vendor/*.js
(no output)
```

`node_modules/klinecharts/dist/umd/klinecharts.min.js` is vendored to
`frontend/static/vendor/klinecharts.min.js` and loaded with a plain
`<script>` tag — no CDN, no runtime network dependency for the chart
library itself.

**Indicators (EMA/RSI):** the spec's original phrasing ("computed
client-side") was written for a library with no indicator engine.
KLineChart's core ships a built-in indicator engine including EMA, RSI,
and VOL (volume) — they run in the browser, off the same OHLCV data the
backend returns, calculated by the vendored library rather than by
hand-rolled JS. This is the more correct reading of "computed
client-side" for this library and is what's implemented
(`frontend/static/js/app.js`, `syncEMA`/`syncRSI`).

**Drawing tools — an honest correction.** The instruction to switch
libraries assumed KLineChart ships ready-made drawing tools (trendline,
horizontal line, fib retracement) "for free." Having vendored and
inspected it: the **core** `klinecharts` package (the only one vendored
here — there is no separate "pro" package involved) ships the low-level
plugin API for drawing tools (`registerOverlay`/`createOverlay` plus
Figure primitives), but *not* pre-built tool definitions — those exist
only in TradingView-style demo apps built on top of core KLineChart. So
the three requested tools are implemented here using that public,
supported plugin API — see `frontend/static/js/overlays.js`. Functionally
this delivers exactly what was asked (a per-pane draw menu: Trend line /
Horizontal line / Fib retracement, plus Clear); it just isn't literally
zero code.

**Drawing persistence scope.** Serialization is cheap, as expected:
`chart.getOverlays()` gives back `{name, points}` per drawing and
`chart.createOverlay(...)` recreates them, so drawings *are* persisted
server-side in the same `data/layout.json` as the rest of the layout —
this is **not** session-only. One scoping simplification, done for time:
drawings are saved **per pane slot**, not per traded symbol. Moving a
different symbol into a pane starts that pane's drawings fresh, rather
than each symbol carrying its own drawing set around between panes. A
symbol-keyed drawing store is a natural follow-up if wanted.

## Data sources

**yfinance is the primary source and the default for new panes** — this
dashboard is built for global stocks (anything buyable from Denmark or
Sweden), not crypto. Yahoo suffix symbols cover world exchanges without
needing a broker per country: `.CO` Copenhagen, `.ST` Stockholm, `.OL`
Oslo, `.DE` Xetra, `.L` London, no suffix = US. Hyperliquid's live crypto
websocket is still fully wired up and labeled **live** — it's kept as a
secondary source, picked per-pane from the same source dropdown — but it
is no longer what a fresh install shows by default.

Two built-in sources, both pluggable through a single file,
`backend/data_sources.py`. Adding a new venue means writing one class
with one method, `get_candles(symbol, interval, limit) -> list[Candle]`,
and adding it to the `SOURCES` dict at the bottom of that file — nothing
else in the app changes.

| Source | `backend/data_sources.py` class | Quality label | Historical candles | Live updates |
|---|---|---|---|---|
| yfinance | `YFinanceSource` | **delayed ~15 min** | `yfinance` `Ticker.history()` | 60s polling (delayed anyway, so a websocket would be theatre) |
| Hyperliquid | `HyperliquidSource` | **live** | REST `candleSnapshot` (official candle endpoint — not aggregated from raw trades) | proxied websocket, see below |

Every pane's quality badge shows exactly one of these two labels, sourced
from the backend response — the frontend never guesses or upgrades a
label.

### Symbol search — type a company name, not a ticker

Nobody should have to already know that Novo Nordisk's B-shares trade as
`NOVO-B.CO`. `GET /api/symbol-search?q=...` (`YFinanceSource.search()` in
`backend/data_sources.py`) proxies Yahoo's public search endpoint and
returns `{symbol, name, exchange}` matches. The pane's symbol field
(`frontend/static/js/app.js`) is a type-ahead: typing 2+ characters (with
the source set to Yahoo Finance) debounces a search and shows a dropdown
of name + ticker + exchange; picking one commits that ticker to the pane.
Hyperliquid coins are a short fixed list (BTC, ETH, ...) typed directly —
search only applies to the yfinance path.

### On data freshness — why nothing here is real-time for stocks

Free stock/FX/index data is delayed everywhere, not just from this
dashboard — genuinely real-time quotes are a **per-exchange paid
license** (SIP/CTA feeds in the US, and separate paid feeds per European
exchange for Nordic tickers), and yfinance's free Yahoo-sourced data
reflects that: roughly a 15-minute delay, honestly labeled as such on
every pane. Hyperliquid crypto is the one source here that's genuinely
real-time, because Hyperliquid publishes its own order book/trade data
directly with no licensing intermediary. A future paid plug-in like
Alpaca would upgrade **US-listed** symbols to real-time (their data
agreements are with US exchanges); it wouldn't touch the Nordic-listed
tickers this dashboard defaults to — those would still need a
Nasdaq-Nordic-licensed feed to go real-time.

yfinance has no native "4h" bar. For that one timeframe the backend pulls
60m bars and resamples to 4h with pandas (`backend/data_sources.py`,
`YFINANCE_PLAN["4h"]`); every other timeframe (1m/5m/15m/1h/1D) comes
straight from yfinance.

### Why the crypto feed is proxied, not a direct browser→Hyperliquid socket

`backend/hyperliquid_stream.py` holds one upstream websocket per
`(coin, interval)` pair to Hyperliquid and fans updates out to however
many browser panes are watching that pair. This puts the
reconnect-with-backoff logic in one place (testable, loggable
server-side) and means N panes on the same symbol share one upstream
subscription instead of opening N.

Backend ↔ Hyperliquid link states (`connecting`/`live`/`reconnecting`)
are pushed to every subscribed pane the instant they change, so a pane
never shows a stale price while implying it's live — this is also what
drives the "reconnecting…" badge. The frontend's own websocket to *this*
backend has its own independent reconnect-with-backoff (in case the
backend itself restarts) — see `connectWS()` in
`frontend/static/js/app.js`.

## Honest failure states

- Pane badges: quality (`live` / `delayed ~15 min`) is always shown, plus
  a connection state (`connecting…` / `live` / `reconnecting…` /
  `polling` / `error`).
- An invalid symbol or an upstream error surfaces as a red banner over
  the pane with the actual error message — the chart is cleared, never
  left showing old data as current.
- The ticker price only flashes green/red when the price actually
  changed, not on every tick.

## Layout persistence

`GET/PUT /api/layout` reads/writes `data/layout.json` — server-side, not
localStorage, so any device on the LAN sees the same saved layout
(number of charts, and each pane's symbol/source/interval/indicator
toggles/drawings) after a reload *or* a full service restart. The
frontend debounces saves by 600ms after any change.

## Out of scope (explicit)

No order placement, no trading execution, no accounts, no price
predictions or signals. Charts and indicators only.

## Running it

```
./run.sh
```

Starts the backend bound to `0.0.0.0:8850`, restarting it automatically
if it ever dies, logging everything (with timestamps) to `./service.log`.
Two PID files are written for exact-PID shutdown (no `pkill`/`killall`):

```
kill "$(cat run.pid)"       # stop the restart loop first
kill "$(cat uvicorn.pid)"   # then stop the currently-running backend
```

Then open `http://<this-host>:8850/` from any device on the LAN.

### First-time setup

```
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

(`node_modules/` and the npm files are only needed if you want to
re-vendor a newer KLineChart build; the app itself only needs the
already-vendored `frontend/static/vendor/klinecharts.min.js` plus the
Python venv.)

## Project layout

```
run.sh                          supervised start/restart loop, logs to service.log
requirements.txt                pinned Python deps for the venv
package.json                    records the klinecharts version vendored in
backend/
  main.py                       FastAPI app: static serving, /health, /api/candles,
                                 /api/symbol-search, /api/layout, /ws/candles,
                                 /debug/drop-stream
  data_sources.py                pluggable DataSource interface + Hyperliquid/yfinance
  hyperliquid_stream.py          upstream Hyperliquid ws manager: reconnect+backoff, fan-out
  layout_store.py                server-side layout.json read/write
frontend/
  index.html                     page shell + pane template
  static/css/style.css           dark, phone-first responsive styling
  static/js/app.js                grid/pane lifecycle, data fetch+streaming, indicators, saves
  static/js/overlays.js           registers the 3 drawing-tool overlays with KLineChart
  static/vendor/klinecharts.min.js  vendored chart library (Apache-2.0, no CDN)
data/
  layout.default.json            fallback layout shipped in the repo
  layout.json                    live saved layout (gitignored; created at runtime)
tests/
  smoke_test.py                   verification step 2: candle fetch smoke test
  kill_ws_test.py                 verification step 3: forced-drop reconnect test
```

## Verification

See the project's task log / PR description for the four captured
verification runs (server up + `/health`, smoke test, reconnect test,
layout-survives-restart test). All four were run against a live instance
of this service, not asserted from reading the code.
