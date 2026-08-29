/*
 * Vanilla-JS dashboard controller.
 *
 * Layout (number of panes, and per-pane symbol/source/interval/indicator
 * toggles/drawings) lives in `paneConfigs` (always 8 slots so a slot's
 * settings survive switching the chart count down and back up) and is
 * persisted server-side via GET/PUT /api/layout -- not localStorage, so
 * any device on the LAN sees the same layout.
 */
(function () {
  "use strict";

  const MAX_PANES = 8;
  const YFINANCE_POLL_MS = 60_000;
  const SAVE_DEBOUNCE_MS = 600;
  const FLASH_MS = 550;

  const gridEl = document.getElementById("charts-grid");
  const countSelect = document.getElementById("chart-count");
  const saveIndicator = document.getElementById("save-indicator");
  const paneTemplate = document.getElementById("pane-template");

  /** @type {Array<object>} up to MAX_PANES pane configs, index-addressed */
  let paneConfigs = [];
  let numCharts = 4;
  /** live pane runtime state, keyed by index */
  const paneStates = {};
  let saveTimer = null;

  const DARK_STYLES = {
    grid: {
      horizontal: { color: "#20252f" },
      vertical: { color: "#20252f" },
    },
    candle: {
      bar: {
        upColor: "#26a69a",
        downColor: "#ef5350",
        noChangeColor: "#888888",
        upBorderColor: "#26a69a",
        downBorderColor: "#ef5350",
        noChangeBorderColor: "#888888",
        upWickColor: "#26a69a",
        downWickColor: "#ef5350",
        noChangeWickColor: "#888888",
      },
      priceMark: {
        last: {
          show: true,
          upColor: "#26a69a",
          downColor: "#ef5350",
          noChangeColor: "#888888",
        },
      },
    },
    indicator: {
      lines: [{ color: "#4f8ff7" }, { color: "#d29922" }, { color: "#7ee8d8" }],
      lastValueMark: { show: false },
    },
    xAxis: {
      axisLine: { color: "#262d38" },
      tickLine: { color: "#262d38" },
      tickText: { color: "#7d8590" },
    },
    yAxis: {
      axisLine: { color: "#262d38" },
      tickLine: { color: "#262d38" },
      tickText: { color: "#7d8590" },
    },
    separator: { color: "#262d38" },
    crosshair: {
      horizontal: { line: { color: "#5b6472" }, text: { backgroundColor: "#262d38", color: "#d8dee9" } },
      vertical: { line: { color: "#5b6472" }, text: { backgroundColor: "#262d38", color: "#d8dee9" } },
    },
  };

  function defaultPaneConfig(i) {
    // yfinance is the primary/default source -- it covers world exchanges
    // via Yahoo suffix symbols (.CO Copenhagen, .ST Stockholm, .OL Oslo,
    // .DE Xetra, .L London, no suffix = US). Hyperliquid crypto stays
    // available as a secondary source via the per-pane source picker, but
    // isn't part of the default view.
    const presets = [
      { symbol: "NOVO-B.CO", source: "yfinance", interval: "1h" },
      { symbol: "MAERSK-B.CO", source: "yfinance", interval: "1h" },
      { symbol: "ERIC-B.ST", source: "yfinance", interval: "1h" },
      { symbol: "AAPL", source: "yfinance", interval: "1D" },
    ];
    const base = presets[i % presets.length];
    return { ...base, ema20: false, ema50: false, rsi: false, drawings: [] };
  }

  function fmtPrice(v) {
    if (v == null || Number.isNaN(v)) return "--";
    const abs = Math.abs(v);
    const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
    return v.toFixed(digits);
  }

  function toKLineData(candles) {
    return candles.map((c) => ({
      timestamp: c.time * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  async function searchSymbols(query) {
    const res = await fetch(`/api/symbol-search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    return body.results || [];
  }

  async function fetchLayout() {
    try {
      const res = await fetch("/api/layout");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn("failed to load layout, using defaults", e);
      return null;
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
  }

  async function doSave() {
    const payload = { numCharts, panes: paneConfigs.slice(0, MAX_PANES) };
    try {
      const res = await fetch("/api/layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      flashSaveIndicator("saved");
    } catch (e) {
      console.warn("failed to save layout", e);
      flashSaveIndicator("save failed");
    }
  }

  function flashSaveIndicator(text) {
    saveIndicator.textContent = text;
    saveIndicator.classList.add("show");
    setTimeout(() => saveIndicator.classList.remove("show"), 1200);
  }

  // ---------------------------------------------------------------------
  // Connection / error UI
  // ---------------------------------------------------------------------

  function setConnState(state, connState, message) {
    const badge = state.el.querySelector(".conn-badge");
    badge.className = "conn-badge state-" + connState;
    const labels = {
      connecting: "connecting…",
      live: "live",
      reconnecting: "reconnecting…",
      polling: "polling",
      error: "error",
    };
    badge.textContent = labels[connState] || connState;
    const errEl = state.el.querySelector(".pane-error");
    if (connState === "error") {
      errEl.textContent = "⚠ " + (message || "unknown error");
      errEl.classList.remove("hidden");
    } else {
      errEl.classList.add("hidden");
    }
  }

  function setQualityBadge(state, quality, label) {
    const badge = state.el.querySelector(".quality-badge");
    badge.textContent = label || quality;
    badge.className = "quality-badge " + (quality === "live" ? "live" : "delayed");
  }

  function flashTicker(state, price, prevPrice) {
    const el = state.el.querySelector(".ticker-price");
    el.textContent = fmtPrice(price);
    if (prevPrice == null || price === prevPrice) return;
    el.classList.remove("flash-up", "flash-down");
    // force reflow so re-adding the class restarts the transition
    void el.offsetWidth;
    el.classList.add(price > prevPrice ? "flash-up" : "flash-down");
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(() => el.classList.remove("flash-up", "flash-down"), FLASH_MS);
  }

  // ---------------------------------------------------------------------
  // Indicators (built into KLineChart -- EMA/RSI computed by the library)
  // ---------------------------------------------------------------------

  function syncEMA(state) {
    if (!state.chart) return;
    state.chart.removeIndicator({ name: "EMA", paneId: "candle_pane" });
    const periods = [];
    if (state.config.ema20) periods.push(20);
    if (state.config.ema50) periods.push(50);
    if (periods.length) {
      state.chart.createIndicator({ name: "EMA", calcParams: periods }, true, { id: "candle_pane" });
    }
  }

  function syncRSI(state) {
    if (!state.chart) return;
    if (state.config.rsi && !state.rsiPaneId) {
      state.rsiPaneId = state.chart.createIndicator("RSI", false);
    } else if (!state.config.rsi && state.rsiPaneId) {
      state.chart.removeIndicator({ paneId: state.rsiPaneId });
      state.rsiPaneId = null;
    }
  }

  // ---------------------------------------------------------------------
  // Drawings (persisted per pane slot via chart.getOverlays/createOverlay)
  // ---------------------------------------------------------------------

  function resyncDrawings(state) {
    if (!state.chart) return;
    const overlays = state.chart.getOverlays();
    state.config.drawings = overlays.map((o) => ({
      name: o.name,
      points: (o.points || []).map((p) => ({ timestamp: p.timestamp, value: p.value })),
    }));
    scheduleSave();
  }

  function restoreDrawings(state) {
    if (!state.chart || !state.config.drawings || !state.config.drawings.length) return;
    const items = state.config.drawings.map((d) => ({
      name: d.name,
      points: d.points,
      onDrawEnd: () => resyncDrawings(state),
      onPressedMoveEnd: () => resyncDrawings(state),
      onRemoved: () => resyncDrawings(state),
    }));
    state.chart.createOverlay(items);
  }

  function startDrawing(state, toolName) {
    if (!state.chart || !toolName) return;
    state.chart.createOverlay({
      name: toolName,
      onDrawEnd: () => resyncDrawings(state),
      onPressedMoveEnd: () => resyncDrawings(state),
      onRemoved: () => resyncDrawings(state),
    });
  }

  function clearDrawings(state) {
    if (!state.chart) return;
    state.chart.removeOverlay();
    state.config.drawings = [];
    scheduleSave();
  }

  // ---------------------------------------------------------------------
  // Data loading / live feed
  // ---------------------------------------------------------------------

  function teardownFeed(state) {
    if (state.ws) {
      state.wsClosedByUs = true;
      try { state.ws.close(); } catch (_) { /* ignore */ }
      state.ws = null;
    }
    if (state.wsRetryTimer) { clearTimeout(state.wsRetryTimer); state.wsRetryTimer = null; }
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  async function fetchCandles(config) {
    const url = `/api/candles?source=${encodeURIComponent(config.source)}&symbol=${encodeURIComponent(config.symbol)}&interval=${encodeURIComponent(config.interval)}&limit=300`;
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    return body;
  }

  async function loadAndSubscribe(state) {
    teardownFeed(state);
    setConnState(state, "connecting");
    state.el.querySelector(".ticker-symbol").textContent = `${state.config.symbol} · ${state.config.interval}`;
    try {
      const body = await fetchCandles(state.config);
      state.candles = body.candles || [];
      setQualityBadge(state, body.quality, body.quality_label);
      if (state.chart) {
        state.chart.applyNewData(toKLineData(state.candles));
        restoreDrawings(state);
        syncEMA(state);
        syncRSI(state);
      }
      const last = state.candles[state.candles.length - 1];
      flashTicker(state, last ? last.close : null, null);

      if (state.config.source === "hyperliquid") {
        connectWS(state);
      } else {
        setConnState(state, "polling");
        state.pollTimer = setInterval(() => pollOnce(state), YFINANCE_POLL_MS);
      }
    } catch (e) {
      state.candles = [];
      if (state.chart) state.chart.applyNewData([]);
      setConnState(state, "error", e.message);
    }
  }

  async function pollOnce(state) {
    try {
      const body = await fetchCandles(state.config);
      state.candles = body.candles || [];
      setQualityBadge(state, body.quality, body.quality_label);
      const prevLast = state.el.dataset.lastClose ? parseFloat(state.el.dataset.lastClose) : null;
      if (state.chart) state.chart.applyNewData(toKLineData(state.candles));
      const last = state.candles[state.candles.length - 1];
      if (last) {
        flashTicker(state, last.close, prevLast);
        state.el.dataset.lastClose = String(last.close);
      }
      setConnState(state, "polling");
    } catch (e) {
      setConnState(state, "error", e.message);
    }
  }

  function connectWS(state) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/candles?source=hyperliquid&symbol=${encodeURIComponent(state.config.symbol)}&interval=${encodeURIComponent(state.config.interval)}`;
    state.wsClosedByUs = false;
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.onopen = () => {
      state.wsBackoff = 1000;
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === "status") {
        setConnState(state, msg.state === "live" ? "live" : "reconnecting");
      } else if (msg.type === "candle") {
        applyLiveCandle(state, msg.candle);
      } else if (msg.type === "error") {
        setConnState(state, "error", msg.message);
      }
    };
    ws.onclose = () => {
      if (state.destroyed) return;
      if (!state.wsClosedByUs) {
        setConnState(state, "reconnecting");
        const wait = state.wsBackoff || 1000;
        state.wsRetryTimer = setTimeout(() => connectWS(state), wait);
        state.wsBackoff = Math.min(wait * 2, 30000);
      }
    };
    ws.onerror = () => {
      try { ws.close(); } catch (_) { /* ignore, onclose will fire */ }
    };
  }

  function applyLiveCandle(state, candle) {
    const prev = state.candles[state.candles.length - 1];
    const prevClose = prev ? prev.close : null;
    if (prev && prev.time === candle.time) {
      state.candles[state.candles.length - 1] = candle;
    } else {
      state.candles.push(candle);
      if (state.candles.length > 500) state.candles.shift();
    }
    if (state.chart) {
      state.chart.updateData({
        timestamp: candle.time * 1000,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      });
    }
    flashTicker(state, candle.close, prevClose);
  }

  // ---------------------------------------------------------------------
  // Pane lifecycle
  // ---------------------------------------------------------------------

  function destroyPane(index) {
    const state = paneStates[index];
    if (!state) return;
    state.destroyed = true;
    teardownFeed(state);
    if (state.resizeObserver) state.resizeObserver.disconnect();
    if (state.chart) {
      try { window.klinecharts.dispose(state.chart); } catch (_) { /* ignore */ }
    }
    delete paneStates[index];
  }

  function createPane(index) {
    const config = paneConfigs[index];
    const frag = paneTemplate.content.cloneNode(true);
    const el = frag.querySelector(".pane");
    el.dataset.paneId = String(index);
    gridEl.appendChild(frag);

    const state = { index, config, el, candles: [], wsBackoff: 1000, rsiPaneId: null };
    paneStates[index] = state;

    el.querySelector(".pane-source").value = config.source;
    el.querySelector(".pane-symbol").value = config.symbol;
    el.querySelector(".pane-interval").value = config.interval;
    el.querySelector(".pane-ema20").checked = !!config.ema20;
    el.querySelector(".pane-ema50").checked = !!config.ema50;
    el.querySelector(".pane-rsi").checked = !!config.rsi;

    const chartEl = el.querySelector(".pane-chart");
    const chart = window.klinecharts.init(chartEl, { styles: DARK_STYLES });
    state.chart = chart;
    chart.createIndicator("VOL", false);

    // --- wiring ---
    const symbolInput = el.querySelector(".pane-symbol");
    const resultsEl = el.querySelector(".pane-symbol-results");

    function commitSymbol(v) {
      v = v.trim().toUpperCase();
      if (!v) return;
      config.symbol = v;
      symbolInput.value = v;
      hideResults();
      scheduleSave();
      loadAndSubscribe(state);
    }

    function hideResults() {
      resultsEl.classList.add("hidden");
      resultsEl.innerHTML = "";
    }

    function renderResults(results) {
      resultsEl.innerHTML = "";
      if (!results.length) { hideResults(); return; }
      results.forEach((r) => {
        const item = document.createElement("div");
        item.className = "symbol-result";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = r.name;
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = `${r.symbol}${r.exchange ? " · " + r.exchange : ""}`;
        item.appendChild(name);
        item.appendChild(meta);
        item.addEventListener("mousedown", (e) => {
          // mousedown (not click) fires before the input's blur handler
          e.preventDefault();
          commitSymbol(r.symbol);
        });
        resultsEl.appendChild(item);
      });
      resultsEl.classList.remove("hidden");
    }

    const debouncedSearch = debounce(async (query) => {
      if (config.source !== "yfinance" || query.trim().length < 2) { hideResults(); return; }
      try {
        const results = await searchSymbols(query.trim());
        renderResults(results);
      } catch (_) {
        hideResults();
      }
    }, 300);

    el.querySelector(".pane-source").addEventListener("change", (e) => {
      config.source = e.target.value;
      hideResults();
      scheduleSave();
      loadAndSubscribe(state);
    });
    symbolInput.addEventListener("input", (e) => debouncedSearch(e.target.value));
    symbolInput.addEventListener("change", (e) => {
      // Only commit on change (Enter/blur) for free-typed symbols, e.g.
      // Hyperliquid coin tickers, or a yfinance symbol typed directly
      // without picking a search result.
      if (!resultsEl.classList.contains("hidden")) return; // a click on a result is mid-flight
      commitSymbol(e.target.value);
    });
    symbolInput.addEventListener("blur", () => setTimeout(hideResults, 150));
    symbolInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideResults();
    });
    el.querySelector(".pane-interval").addEventListener("change", (e) => {
      config.interval = e.target.value;
      scheduleSave();
      loadAndSubscribe(state);
    });
    el.querySelector(".pane-ema20").addEventListener("change", (e) => {
      config.ema20 = e.target.checked;
      syncEMA(state);
      scheduleSave();
    });
    el.querySelector(".pane-ema50").addEventListener("change", (e) => {
      config.ema50 = e.target.checked;
      syncEMA(state);
      scheduleSave();
    });
    el.querySelector(".pane-rsi").addEventListener("change", (e) => {
      config.rsi = e.target.checked;
      syncRSI(state);
      scheduleSave();
    });
    el.querySelector(".pane-draw-tool").addEventListener("change", (e) => {
      const tool = e.target.value;
      e.target.value = "";
      if (tool) startDrawing(state, tool);
    });
    el.querySelector(".pane-draw-clear").addEventListener("click", () => clearDrawings(state));

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(chartEl);
    state.resizeObserver = ro;

    loadAndSubscribe(state);
  }

  // ---------------------------------------------------------------------
  // Grid rebuild
  // ---------------------------------------------------------------------

  function rebuildGrid() {
    Object.keys(paneStates).forEach((k) => destroyPane(Number(k)));
    gridEl.innerHTML = "";
    gridEl.dataset.count = String(numCharts);
    for (let i = 0; i < numCharts; i++) {
      if (!paneConfigs[i]) paneConfigs[i] = defaultPaneConfig(i);
      createPane(i);
    }
  }

  countSelect.addEventListener("change", (e) => {
    numCharts = parseInt(e.target.value, 10);
    scheduleSave();
    rebuildGrid();
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  (async function boot() {
    const saved = await fetchLayout();
    if (saved && Array.isArray(saved.panes) && saved.panes.length) {
      numCharts = saved.numCharts || 4;
      paneConfigs = saved.panes.slice(0, MAX_PANES);
    } else {
      numCharts = 4;
      paneConfigs = [];
    }
    while (paneConfigs.length < MAX_PANES) {
      paneConfigs.push(defaultPaneConfig(paneConfigs.length));
    }
    countSelect.value = String(numCharts);
    rebuildGrid();
  })();
})();
