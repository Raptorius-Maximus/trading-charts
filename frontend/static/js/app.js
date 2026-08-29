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
    return { ...base, indicators: [], chartType: "candle_solid", scale: "normal", drawings: [] };
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

  // KLineChart v10 has no applyNewData/updateData. Data goes in through a
  // "data loader" the chart pulls from whenever its symbol or period changes
  // (or on resetData()), and live bars are pushed through the callback the
  // chart hands us in subscribeBar. These helpers hide that behind two
  // calls: setChartData (full refresh) and pushLiveBar (one bar).
  const PERIOD_BY_INTERVAL = {
    "1m": { type: "minute", span: 1 }, "5m": { type: "minute", span: 5 },
    "15m": { type: "minute", span: 15 }, "1h": { type: "hour", span: 1 },
    "4h": { type: "hour", span: 4 }, "1D": { type: "day", span: 1 },
    "1W": { type: "week", span: 1 }, "1M": { type: "month", span: 1 },
  };
  // How many bars to ask for. Intraday stays a screenful; daily and up
  // fetch the whole history so you can scroll back to the listing date.
  function limitFor(interval) {
    return (interval === "1D" || interval === "1W" || interval === "1M") ? 20000 : 300;
  }
  function pricePrecisionFor(candles) {
    const last = candles[candles.length - 1];
    const px = last ? last.close : 0;
    if (px >= 100) return 2;
    if (px >= 1) return 3;
    return 5;
  }
  function installDataLoader(state) {
    state.chart.setDataLoader({
      getBars: ({ type, callback }) => {
        // The chart asks for history when scrolling to the edge; we hold
        // one fixed window from the backend, so only the initial load has data.
        const src = state.replay ? state.candles.slice(0, state.replay.pos) : state.candles;
        callback(type === "init" ? toKLineData(src) : [], false);
      },
      subscribeBar: ({ callback }) => { state.liveCb = callback; },
      unsubscribeBar: () => { state.liveCb = null; },
    });
  }
  function setChartData(state, candles) {
    state.candles = candles;
    if (!state.chart) return;
    const key = `${state.config.source}|${state.config.symbol}|${state.config.interval}`;
    if (state.chartKey !== key) {
      state.chartKey = key;
      state.chart.setSymbol({
        ticker: state.config.symbol,
        pricePrecision: pricePrecisionFor(candles),
        volumePrecision: 0,
      });
      state.chart.setPeriod(PERIOD_BY_INTERVAL[state.config.interval] || { type: "hour", span: 1 });
      // setSymbol/setPeriod each trigger a load; resetData guarantees one
      // final pass with the data we hold now.
    }
    state.chart.resetData();
  }
  function pushLiveBar(state, candle) {
    if (!state.chart) return;
    const bar = toKLineData([candle])[0];
    if (state.liveCb) state.liveCb(bar);
    else state.chart.resetData();
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

  // /?scratch=1 -- load the saved layout but never write it back. Used by
  // the automated browser checks so they cannot disturb the operator's view.
  const SCRATCH = new URLSearchParams(location.search).get("scratch") === "1";

  function scheduleSave() {
    if (SCRATCH || window.READ_ONLY) return;
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
      if (res.status === 403) {
        // The public hostname is read-only by design: viewing works, saving
        // is only possible from the LAN address. Say so, once, and stop trying.
        window.READ_ONLY = true;
        saveIndicator.textContent = "read-only (public link) — changes are not saved";
        saveIndicator.classList.add("show", "sticky");
        return;
      }
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
      replay: "replay",
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
  // Indicators -- all computed by KLineChart's built-in engine.
  // config.indicators = [{ name, params: [..] | null }]
  // ---------------------------------------------------------------------

  // Overlay indicators draw on the price chart; the rest get their own pane.
  const INDICATORS = {
    overlay: [
      ["MA", "Moving averages", "5,10,30,60"],
      ["EMA", "Exponential MAs", "6,12,20"],
      ["SMA", "Smoothed MA", "12,2"],
      ["BOLL", "Bollinger bands", "20,2"],
      ["SAR", "Parabolic SAR", "2,2,20"],
      ["BBI", "Bull-bear index", "3,6,12,24"],
    ],
    pane: [
      ["MACD", "MACD", "12,26,9"],
      ["RSI", "RSI", "6,12,24"],
      ["KDJ", "Stochastic KDJ", "9,3,3"],
      ["OBV", "On-balance volume", "30"],
      ["CCI", "Commodity channel", "20"],
      ["DMI", "Directional (ADX)", "14,6"],
      ["WR", "Williams %R", "6,10,14"],
      ["ROC", "Rate of change", "12,6"],
      ["MTM", "Momentum", "6,10"],
      ["TRIX", "TRIX", "12,9"],
      ["AO", "Awesome oscillator", "5,34"],
      ["BIAS", "Bias", "6,12,24"],
      ["PSY", "Psychological line", "12,6"],
      ["VR", "Volume ratio", "26,6"],
      ["CR", "CR energy", "26,10,20,40,60"],
      ["DMA", "MA difference", "10,50,10"],
      ["EMV", "Ease of movement", "14,9"],
      ["PVT", "Price-volume trend", ""],
      ["AVP", "Average price", ""],
      ["BRAR", "BRAR sentiment", "26"],
    ],
  };
  const OVERLAY_NAMES = new Set(INDICATORS.overlay.map((x) => x[0]));

  function parseParams(text) {
    if (!text) return null;
    const nums = text.split(/[,\s]+/).map((x) => parseFloat(x)).filter((x) => !isNaN(x));
    return nums.length ? nums : null;
  }

  // Old layouts stored ema20/ema50/rsi booleans; turn them into the list.
  function migrateIndicators(config) {
    if (Array.isArray(config.indicators)) return;
    const list = [];
    const emas = [];
    if (config.ema20) emas.push(20);
    if (config.ema50) emas.push(50);
    if (emas.length) list.push({ name: "EMA", params: emas });
    if (config.rsi) list.push({ name: "RSI", params: null });
    config.indicators = list;
    delete config.ema20; delete config.ema50; delete config.rsi;
  }

  function syncIndicators(state) {
    if (!state.chart) return;
    const chart = state.chart;
    // Drop everything we created before (VOL stays -- it is part of the base chart).
    (state.indPaneIds || []).forEach((pid) => { try { chart.removeIndicator({ paneId: pid }); } catch (_) {} });
    OVERLAY_NAMES.forEach((n) => { try { chart.removeIndicator({ name: n, paneId: "candle_pane" }); } catch (_) {} });
    state.indPaneIds = [];
    (state.config.indicators || []).forEach((ind) => {
      const spec = { name: ind.name };
      if (ind.params && ind.params.length) spec.calcParams = ind.params;
      try {
        if (OVERLAY_NAMES.has(ind.name)) {
          chart.createIndicator(Object.assign(spec, { paneId: "candle_pane" }), true);
        } else {
          const pid = chart.createIndicator(spec, false);
          if (pid) state.indPaneIds.push(pid);
        }
      } catch (e) { console.warn("indicator failed", ind.name, e); }
    });
  }

  function buildIndicatorMenu(state, menuEl) {
    const cfg = state.config;
    menuEl.innerHTML = "";
    const groups = [["On the price chart", INDICATORS.overlay], ["In their own panel", INDICATORS.pane]];
    groups.forEach(([title, items]) => {
      const h = document.createElement("h6"); h.textContent = title; menuEl.appendChild(h);
      items.forEach(([name, desc, defParams]) => {
        const cur = (cfg.indicators || []).find((i) => i.name === name);
        const label = document.createElement("label");
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!cur;
        const txt = document.createElement("span"); txt.textContent = name + " ";
        const d = document.createElement("span"); d.className = "desc"; d.textContent = desc;
        const params = document.createElement("input"); params.className = "params"; params.type = "text";
        params.placeholder = defParams; params.title = "Periods (comma-separated)";
        params.value = cur && cur.params ? cur.params.join(",") : "";
        if (!defParams) params.style.visibility = "hidden";
        const apply = () => {
          cfg.indicators = (cfg.indicators || []).filter((i) => i.name !== name);
          if (cb.checked) cfg.indicators.push({ name, params: parseParams(params.value) });
          syncIndicators(state);
          scheduleSave();
        };
        cb.addEventListener("change", apply);
        params.addEventListener("change", () => { if (cb.checked) apply(); });
        params.addEventListener("click", (e) => e.stopPropagation());
        label.append(cb, txt, d, params);
        menuEl.appendChild(label);
      });
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const m = document.querySelector(".pane.maximized");
      if (m) { m.classList.remove("maximized"); document.body.classList.remove("has-max"); Object.values(paneStates).forEach((s) => s.chart && s.chart.resize()); }
      document.querySelectorAll(".menu").forEach((x) => x.classList.add("hidden"));
    }
  });

  // Close any open menu on outside click.
  document.addEventListener("mousedown", (e) => {
    document.querySelectorAll(".menu:not(.hidden)").forEach((m) => {
      if (!m.parentElement.contains(e.target)) m.classList.add("hidden");
    });
  });

  // ---------------------------------------------------------------------
  // Chart type / price scale / maximize / snapshot
  // ---------------------------------------------------------------------

  function applyChartType(state) {
    if (!state.chart) return;
    state.chart.setStyles({ candle: { type: state.config.chartType || "candle_solid" } });
  }

  const SCALES = ["normal", "logarithm", "percentage"];
  const SCALE_LABEL = { normal: "Lin", logarithm: "Log", percentage: "%" };
  function applyScale(state) {
    if (!state.chart) return;
    const name = state.config.scale || "normal";
    try { state.chart.overrideYAxis({ paneId: "candle_pane", name }); } catch (e) { console.warn("scale", e); }
    const btn = state.el.querySelector(".pane-scale");
    btn.textContent = SCALE_LABEL[name];
    btn.classList.toggle("active", name !== "normal");
  }

  function toggleMaximize(state) {
    const on = !state.el.classList.contains("maximized");
    document.querySelectorAll(".pane.maximized").forEach((p) => p.classList.remove("maximized"));
    state.el.classList.toggle("maximized", on);
    document.body.classList.toggle("has-max", on);
    setTimeout(() => state.chart && state.chart.resize(), 30);
  }

  function snapshot(state) {
    if (!state.chart) return;
    const url = state.chart.getConvertPictureUrl(true, "png", "#0e1117");
    const a = document.createElement("a");
    a.href = url; a.download = `${state.config.symbol}-${state.config.interval}.png`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------------------------------------------------------------------
  // Compare: a second symbol drawn as a line on the price pane, rebased so
  // both start at the same value (i.e. a relative-performance overlay).
  // ---------------------------------------------------------------------

  window.klinecharts.registerIndicator({
    name: "CMP",
    shortName: "Compare",
    series: "price",
    precision: 2,
    figures: [{ key: "cmp", title: "", type: "line" }],
    calc: (dataList, indicator) => {
      // Bars of two exchanges rarely share exact timestamps (different
      // midnights / session opens), so match each of our bars to the latest
      // bar of the other series that is not later than ours + half a bar.
      const ext = indicator.extendData || {};
      const times = ext.times || [], vals = ext.vals || [];
      const tol = ext.tol || 0;
      let j = 0;
      return dataList.map((d) => {
        const limit = d.timestamp + tol;
        while (j + 1 < times.length && times[j + 1] <= limit) j++;
        const ok = times.length && times[j] <= limit && (j === 0 ? true : times[j] > d.timestamp - 2 * tol - 1);
        return { cmp: ok ? vals[j] : null };
      });
    },
  });

  async function setCompare(state, symbol) {
    const chart = state.chart;
    try { chart.removeIndicator({ name: "CMP", paneId: "candle_pane" }); } catch (_) {}
    state.config.compare = symbol || null;
    // A relative-performance overlay reads best on the percent scale.
    if (symbol && (state.config.scale || "normal") === "normal") { state.config.scale = "percentage"; applyScale(state); }
    state.el.querySelector(".pane-cmp").classList.toggle("active", !!symbol);
    state.el.querySelector(".pane-cmp").textContent = symbol ? `vs ${symbol}` : "Compare";
    scheduleSave();
    if (!symbol) return;
    let body;
    try {
      body = await fetchCandles({ source: "yfinance", symbol, interval: state.config.interval });
    } catch (e) { setConnState(state, "error", `compare: ${e.message}`); return; }
    const other = body.candles || [];
    const base = state.candles;
    if (!other.length || !base.length) return;
    // Rebase: scale the other series so its first overlapping close equals ours.
    const firstTs = Math.max(base[0].time, other[0].time);
    const b0 = base.find((c) => c.time >= firstTs), o0 = other.find((c) => c.time >= firstTs);
    const k = b0 && o0 && o0.close ? b0.close / o0.close : 1;
    const times = other.map((c) => c.time * 1000);
    const vals = other.map((c) => c.close * k);
    const step = base.length > 1 ? (base[1].time - base[0].time) * 1000 : 3600000;
    chart.createIndicator({ name: "CMP", paneId: "candle_pane", extendData: { times, vals, tol: step / 2 }, shortName: `vs ${symbol}` }, true);
  }

  // ---------------------------------------------------------------------
  // Bar replay: show the first N bars and step / play forward.
  // ---------------------------------------------------------------------

  function replayRender(state) {
    const rp = state.replay; if (!rp) return;
    const n = state.candles.length;
    rp.pos = Math.max(10, Math.min(n, rp.pos));
    state.chart.resetData();
    const bar = state.candles[rp.pos - 1];
    state.el.querySelector(".rp-pos").max = String(n);
    state.el.querySelector(".rp-pos").value = String(rp.pos);
    state.el.querySelector(".rp-info").textContent = bar ? `${rp.pos}/${n} · ${new Date(bar.time * 1000).toLocaleString()} · ${fmtPrice(bar.close)}` : "";
    flashTicker(state, bar ? bar.close : null, null);
    if (rp.pos >= n) replayPause(state);
  }
  function replayPause(state) {
    const rp = state.replay; if (!rp) return;
    clearInterval(rp.timer); rp.timer = null;
    state.el.querySelector(".rp-play").textContent = "▶";
  }
  function replayPlay(state) {
    const rp = state.replay; if (!rp || rp.timer) return;
    const speed = parseInt(state.el.querySelector(".rp-speed").value, 10) || 400;
    rp.timer = setInterval(() => { rp.pos += 1; replayRender(state); }, speed);
    state.el.querySelector(".rp-play").textContent = "⏸";
  }
  function replayStart(state) {
    if (!state.candles.length) return;
    teardownFeed(state); // no live updates while replaying
    state.replay = { pos: Math.floor(state.candles.length / 2), timer: null };
    state.el.querySelector(".pane-replay").classList.add("active");
    state.el.querySelector(".pane-replay-bar").classList.remove("hidden");
    setConnState(state, "replay");
    replayRender(state);
  }
  function replayExit(state) {
    if (!state.replay) return;
    replayPause(state);
    state.replay = null;
    state.el.querySelector(".pane-replay").classList.remove("active");
    state.el.querySelector(".pane-replay-bar").classList.add("hidden");
    loadAndSubscribe(state);
  }
  function wireReplay(state) {
    const el = state.el;
    el.querySelector(".pane-replay").addEventListener("click", () => state.replay ? replayExit(state) : replayStart(state));
    el.querySelector(".rp-exit").addEventListener("click", () => replayExit(state));
    el.querySelector(".rp-play").addEventListener("click", () => state.replay && (state.replay.timer ? replayPause(state) : replayPlay(state)));
    el.querySelector(".rp-fwd").addEventListener("click", () => { if (state.replay) { state.replay.pos += 1; replayRender(state); } });
    el.querySelector(".rp-back").addEventListener("click", () => { if (state.replay) { state.replay.pos -= 1; replayRender(state); } });
    el.querySelector(".rp-start").addEventListener("click", () => { if (state.replay) { state.replay.pos = 10; replayRender(state); } });
    el.querySelector(".rp-pos").addEventListener("input", (e) => { if (state.replay) { state.replay.pos = parseInt(e.target.value, 10); replayRender(state); } });
    el.querySelector(".rp-speed").addEventListener("change", () => { if (state.replay && state.replay.timer) { replayPause(state); replayPlay(state); } });
  }

  // ---------------------------------------------------------------------
  // Saved layouts (named snapshots of the whole grid)
  // ---------------------------------------------------------------------

  const layoutsBtn = document.getElementById("layouts-btn");
  const layoutsMenu = document.getElementById("layouts-menu");
  async function buildLayoutsMenu() {
    let list = [];
    try { list = (await (await fetch("/api/layouts")).json()).layouts || []; } catch (_) {}
    layoutsMenu.innerHTML = "";
    if (!list.length) { const d = document.createElement("div"); d.className = "row meta"; d.textContent = "No saved layouts yet."; layoutsMenu.appendChild(d); }
    list.forEach((l) => {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<span>${l.name} <span class="meta">${l.numCharts || ""} · ${(l.symbols || []).join(", ")}</span></span><span class="rm" title="Delete">×</span>`;
      row.querySelector(".rm").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete layout "${l.name}"?`)) return;
        const r = await fetch(`/api/layouts/${encodeURIComponent(l.name)}`, { method: "DELETE" });
        if (r.status === 403) { flashSaveIndicator("read-only (public link)"); return; }
        buildLayoutsMenu();
      });
      row.addEventListener("click", async () => {
        const d = await (await fetch(`/api/layouts/${encodeURIComponent(l.name)}`)).json();
        if (!d || !Array.isArray(d.panes)) return;
        numCharts = d.numCharts || 4;
        paneConfigs = d.panes.slice(0, MAX_PANES);
        while (paneConfigs.length < MAX_PANES) paneConfigs.push(defaultPaneConfig(paneConfigs.length));
        countSelect.value = String(numCharts);
        layoutsMenu.classList.add("hidden");
        scheduleSave();
        rebuildGrid();
      });
      layoutsMenu.appendChild(row);
    });
    const save = document.createElement("div"); save.className = "save-row";
    save.innerHTML = `<input type="text" placeholder="Save current as…" maxlength="40"><button type="button">Save</button>`;
    const doSaveNamed = async () => {
      const name = save.querySelector("input").value.trim(); if (!name) return;
      const r = await fetch(`/api/layouts/${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ numCharts, panes: paneConfigs.slice(0, MAX_PANES) }) });
      if (r.status === 403) { flashSaveIndicator("read-only (public link)"); return; }
      if (!r.ok) { flashSaveIndicator((await r.json().catch(() => ({}))).detail || "could not save"); return; }
      flashSaveIndicator(`saved "${name}"`);
      buildLayoutsMenu();
    };
    save.querySelector("button").addEventListener("click", doSaveNamed);
    save.querySelector("input").addEventListener("keydown", (e) => { if (e.key === "Enter") doSaveNamed(); });
    save.addEventListener("mousedown", (e) => e.stopPropagation());
    layoutsMenu.appendChild(save);
  }
  layoutsBtn.addEventListener("click", () => {
    const open = layoutsMenu.classList.contains("hidden");
    document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
    if (open) { buildLayoutsMenu(); layoutsMenu.classList.remove("hidden"); }
  });

  // ---------------------------------------------------------------------
  // Range buttons (1M ... 30Y, All): pick a sensible bar size for the span
  // and fit that span to the pane width -- TradingView's bottom-bar ranges.
  // ---------------------------------------------------------------------

  const RANGES = {
    "1M": { days: 31, interval: "1D" }, "3M": { days: 92, interval: "1D" }, "6M": { days: 183, interval: "1D" },
    "YTD": { days: null, interval: "1D" }, "1Y": { days: 366, interval: "1D" }, "2Y": { days: 731, interval: "1D" },
    "5Y": { days: 1827, interval: "1W" }, "10Y": { days: 3653, interval: "1W" }, "20Y": { days: 7305, interval: "1M" },
    "30Y": { days: 10958, interval: "1M" }, "ALL": { days: Infinity, interval: "1M" },
  };

  function rangeStartSec(key) {
    const r = RANGES[key];
    if (key === "YTD") return Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
    if (!isFinite(r.days)) return 0;
    return Math.floor(Date.now() / 1000) - r.days * 86400;
  }

  function fitRange(state, key) {
    const chart = state.chart; if (!chart || !state.candles.length) return;
    const start = rangeStartSec(key);
    const firstIdx = state.candles.findIndex((c) => c.time >= start);
    const bars = firstIdx < 0 ? state.candles.length : state.candles.length - firstIdx;
    const size = chart.getSize("candle_pane", "main");
    const width = size ? size.width : state.el.clientWidth;
    const space = Math.max(1, Math.min(50, Math.floor((width - 8) / Math.max(bars, 1))));
    chart.setBarSpace(space);
    chart.setOffsetRightDistance(6);
    chart.scrollToRealTime(0);
    const first = state.candles[Math.max(firstIdx, 0)];
    const info = state.el.querySelector(".pane-range-info");
    const from = first ? new Date(first.time * 1000) : null;
    const dataStart = new Date(state.candles[0].time * 1000);
    const wanted = isFinite(RANGES[key].days) && key !== "YTD" ? Math.round(RANGES[key].days / 365.25) : null;
    const covered = from ? ((Date.now() / 1000 - from.getTime() / 1000) / (365.25 * 86400)) : 0;
    info.textContent = (wanted && covered < wanted - 1 ? `Yahoo only has this stock since ${dataStart.getFullYear()} · ` : "") +
      (from ? `${from.toISOString().slice(0, 10)} → today · ${bars} bars` : "");
    state.el.querySelectorAll(".pane-ranges button").forEach((b) => b.classList.toggle("active", b.dataset.range === key));
  }

  function wireRanges(state) {
    state.el.querySelectorAll(".pane-ranges button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.range;
        const want = RANGES[key].interval;
        state.pendingRange = key;
        if (state.config.interval !== want) {
          state.config.interval = want;
          state.el.querySelector(".pane-interval").value = want;
          scheduleSave();
          await loadAndSubscribe(state); // fitRange runs after the load
        } else {
          fitRange(state, key);
        }
      });
    });
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

  // A stock ticker (has an exchange suffix like .CO/.ST or a share-class
  // dash like NOVO-B) can never be a Hyperliquid coin. If a pane ends up
  // with that combination, quietly route it to the stock source instead of
  // letting the crypto feed time out on it.
  function looksLikeStock(symbol) {
    return /[.\-]/.test(symbol || "");
  }
  function normalizeSource(state) {
    if (state.config.source === "hyperliquid" && looksLikeStock(state.config.symbol)) {
      state.config.source = "yfinance";
      const sel = state.el.querySelector(".pane-source");
      if (sel) sel.value = "yfinance";
      scheduleSave();
    }
  }

  const FETCH_TIMEOUT_MS = 15000;

  async function fetchCandles(config) {
    const url = `/api/candles?source=${encodeURIComponent(config.source)}&symbol=${encodeURIComponent(config.symbol)}&interval=${encodeURIComponent(config.interval)}&limit=${limitFor(config.interval)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "no answer from data source (timed out)" : e.message);
    } finally {
      clearTimeout(timer);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    return body;
  }

  async function loadAndSubscribe(state) {
    teardownFeed(state);
    normalizeSource(state);
    setConnState(state, "connecting");
    state.el.querySelector(".ticker-symbol").textContent = `${state.config.symbol} · ${state.config.interval}`;
    state.el.dataset.symbol = state.config.symbol;
    window.dispatchEvent(new CustomEvent("pane-symbol", { detail: state.config.symbol }));
    try {
      const body = await fetchCandles(state.config);
      setQualityBadge(state, body.quality, body.quality_label);
      setChartData(state, body.candles || []);
      if (state.chart) {
        restoreDrawings(state);
        syncIndicators(state);
        if (state.config.compare) setCompare(state, state.config.compare);
        if (state.pendingRange) { const k = state.pendingRange; state.pendingRange = null; setTimeout(() => fitRange(state, k), 50); }
        else state.el.querySelectorAll(".pane-ranges button").forEach((b) => b.classList.remove("active"));
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
      try { setChartData(state, []); } catch (_) { state.candles = []; }
      setConnState(state, "error", e.message);
    }
  }

  async function pollOnce(state) {
    try {
      const body = await fetchCandles(state.config);
      setQualityBadge(state, body.quality, body.quality_label);
      const prevLast = state.el.dataset.lastClose ? parseFloat(state.el.dataset.lastClose) : null;
      setChartData(state, body.candles || []);
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
    pushLiveBar(state, candle);
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
    migrateIndicators(config);
    el.querySelector(".pane-chart-type").value = config.chartType || "candle_solid";

    const chartEl = el.querySelector(".pane-chart");
    const chart = window.klinecharts.init(chartEl, { styles: DARK_STYLES });
    state.chart = chart;
    installDataLoader(state);
    chart.createIndicator("VOL", false);
    applyChartType(state);
    applyScale(state);

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
    el.querySelector(".pane-chart-type").addEventListener("change", (e) => {
      config.chartType = e.target.value;
      applyChartType(state);
      scheduleSave();
    });
    const indBtn = el.querySelector(".pane-ind-btn");
    const indMenu = el.querySelector(".pane-ind-menu");
    indBtn.addEventListener("click", () => {
      const open = indMenu.classList.contains("hidden");
      document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
      if (open) { buildIndicatorMenu(state, indMenu); indMenu.classList.remove("hidden"); }
    });
    el.querySelector(".pane-scale").addEventListener("click", () => {
      const i = SCALES.indexOf(config.scale || "normal");
      config.scale = SCALES[(i + 1) % SCALES.length];
      applyScale(state);
      scheduleSave();
    });
    el.querySelector(".pane-snap").addEventListener("click", () => snapshot(state));
    el.querySelector(".pane-cmp").addEventListener("click", () => {
      if (config.compare) { setCompare(state, null); return; }
      const v = prompt("Compare with which symbol? (e.g. MAERSK-B.CO, ^OMXC25, SPY)", "");
      if (v && v.trim()) setCompare(state, v.trim().toUpperCase());
    });
    wireReplay(state);
    wireRanges(state);
    el.querySelector(".pane-analyse").addEventListener("click", () => window.stockAnalysis && window.stockAnalysis.open(config.symbol));
    if (config.compare) { const b = el.querySelector(".pane-cmp"); b.classList.add("active"); b.textContent = `vs ${config.compare}`; }
    el.querySelector(".pane-max").addEventListener("click", () => toggleMaximize(state));
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

  // Small public surface for the sidebar (watchlist click -> chart).
  window.chartsApp = {
    setSymbol(index, symbol) {
      const state = paneStates[index] || paneStates[Object.keys(paneStates)[0]];
      if (!state) return;
      state.config.symbol = String(symbol).toUpperCase();
      state.config.source = "yfinance";
      state.el.querySelector(".pane-symbol").value = state.config.symbol;
      state.el.querySelector(".pane-source").value = "yfinance";
      scheduleSave();
      loadAndSubscribe(state);
    },
  };

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
    // /?symbol=X (from the screener) puts X in the first chart.
    const linked = new URLSearchParams(location.search).get("symbol");
    if (linked) {
      paneConfigs[0] = Object.assign({}, paneConfigs[0], { symbol: linked.toUpperCase(), source: "yfinance" });
      history.replaceState(null, "", "/");
    }
    countSelect.value = String(numCharts);
    rebuildGrid();
  })();
})();
