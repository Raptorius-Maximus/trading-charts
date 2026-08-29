/* Watchlist + price alerts sidebar, and the per-pane change / 52-week strip. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (v, d) => v == null ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const digitsFor = (v) => Math.abs(v || 0) >= 100 ? 2 : Math.abs(v || 0) >= 1 ? 3 : 5;

  // ---- open/close, remembered per browser
  const body = document.body;
  try { if (localStorage.getItem("charts.side") === "1") body.classList.add("side-open"); } catch (_) {}
  $("side-toggle").addEventListener("click", () => {
    body.classList.toggle("side-open");
    try { localStorage.setItem("charts.side", body.classList.contains("side-open") ? "1" : "0"); } catch (_) {}
    window.dispatchEvent(new Event("resize"));
  });

  // ---- watchlist
  let symbols = [];
  async function loadWatchlist() {
    const r = await fetch("/api/watchlist"); symbols = (await r.json()).symbols || [];
    renderWatchlist({}); refreshQuotes();
  }
  function readOnly(r) {
    if (r.status !== 403) return false;
    toast("Read-only", "You are on the public link. Changes can only be saved from the home-wifi address.");
    return true;
  }
  async function saveWatchlist() {
    const r = await fetch("/api/watchlist", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols }) });
    if (readOnly(r)) { await loadWatchlist(); return; }
    symbols = (await r.json()).symbols || symbols;
    renderWatchlist(lastQuotes); refreshQuotes();
  }
  let lastQuotes = {};
  function renderWatchlist(quotes) {
    $("wl-count").textContent = symbols.length ? `(${symbols.length})` : "";
    $("wl").querySelector("tbody").innerHTML = symbols.map((s) => {
      const q = quotes[s] || {};
      const c = q.change_pct;
      const cls = c == null ? "" : c >= 0 ? "up" : "down";
      return `<tr data-sym="${esc(s)}"><td class="sym">${esc(s)}</td><td class="px">${fmt(q.price, digitsFor(q.price))}</td>` +
        `<td class="chg ${cls}">${c == null ? "–" : (c >= 0 ? "+" : "") + c.toFixed(2) + "%"}</td><td class="rm" title="Remove">×</td></tr>`;
    }).join("");
  }
  async function refreshQuotes() {
    if (!symbols.length) return;
    try {
      const r = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
      const rows = (await r.json()).quotes || [];
      lastQuotes = {}; rows.forEach((q) => { lastQuotes[q.symbol] = q; });
      renderWatchlist(lastQuotes);
    } catch (_) { /* keep old numbers */ }
  }
  $("wl").addEventListener("click", (e) => {
    const tr = e.target.closest("tr"); if (!tr) return;
    const sym = tr.dataset.sym;
    if (e.target.classList.contains("rm")) { symbols = symbols.filter((s) => s !== sym); saveWatchlist(); return; }
    if (window.chartsApp) window.chartsApp.setSymbol(0, sym);
  });
  function addWatch() {
    const v = $("wl-add").value.trim().toUpperCase(); if (!v) return;
    if (!symbols.includes(v)) symbols.push(v);
    $("wl-add").value = ""; saveWatchlist();
  }
  $("wl-add-btn").addEventListener("click", addWatch);
  $("wl-add").addEventListener("keydown", (e) => { if (e.key === "Enter") addWatch(); });

  // ---- alerts
  let alerts = [];
  const known = new Set();
  async function loadAlerts() {
    try {
      const r = await fetch("/api/alerts"); alerts = (await r.json()).alerts || [];
    } catch (_) { return; }
    renderAlerts();
    alerts.filter((a) => a.triggered_at && !a.seen).forEach((a) => {
      if (known.has(a.id)) return;
      known.add(a.id);
      notify(a);
      fetch(`/api/alerts/${a.id}/seen`, { method: "POST" });
    });
  }
  function renderAlerts() {
    const list = alerts.slice().sort((a, b) => (b.triggered_at || 0) - (a.triggered_at || 0) || b.created - a.created);
    $("al-list").innerHTML = list.map((a) => {
      const when = a.triggered_at ? `fired ${new Date(a.triggered_at * 1000).toLocaleString()} @ ${fmt(a.triggered_price, digitsFor(a.triggered_price))}` : "waiting";
      return `<div class="al ${a.triggered_at ? "fired" : ""}"><div><b>${esc(a.symbol)}</b> ${a.condition === "above" ? "▲ above" : "▼ below"} ${fmt(a.price, digitsFor(a.price))}<div class="when">${when}</div></div><span class="rm" data-id="${a.id}" title="Delete">×</span></div>`;
    }).join("") || '<div class="dim">No alerts yet.</div>';
  }
  $("al-list").addEventListener("click", async (e) => {
    const id = e.target.dataset.id; if (!id) return;
    const r = await fetch(`/api/alerts/${id}`, { method: "DELETE" }); if (readOnly(r)) return; loadAlerts();
  });
  $("al-add-btn").addEventListener("click", async () => {
    const symbol = $("al-sym").value.trim().toUpperCase(); const price = parseFloat($("al-price").value);
    if (!symbol || isNaN(price)) { toast("Alert", "Give a symbol and a price."); return; }
    const r = await fetch("/api/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, condition: $("al-cond").value, price }) });
    if (readOnly(r)) return;
    if (!r.ok) { toast("Alert", (await r.json().catch(() => ({}))).detail || "could not set alert"); return; }
    $("al-price").value = ""; loadAlerts();
  });
  $("al-notify").addEventListener("click", (e) => {
    e.preventDefault();
    if (!("Notification" in window)) { toast("Notifications", "This browser does not support them."); return; }
    Notification.requestPermission().then((p) => toast("Notifications", p === "granted" ? "Enabled." : "Blocked by the browser."));
  });
  function notify(a) {
    const text = `${a.symbol} ${a.condition === "above" ? "rose above" : "fell below"} ${fmt(a.price, digitsFor(a.price))} (now ${fmt(a.triggered_price, digitsFor(a.triggered_price))})`;
    toast("Price alert", text);
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification("Price alert", { body: text }); } catch (_) {}
    }
  }
  function toast(title, text) {
    const el = document.createElement("div"); el.className = "toast";
    el.innerHTML = `<b>${esc(title)}</b><br>${esc(text)}`;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), 9000);
  }
  // A symbol picked in a pane pre-fills the alert form.
  window.addEventListener("pane-symbol", (e) => { if (!$("al-sym").value) $("al-sym").value = e.detail; });

  // ---- per-pane info strip (change vs previous close, 52-week range)
  async function refreshInfo() {
    const panes = document.querySelectorAll(".pane");
    const syms = [...new Set([...panes].map((p) => p.dataset.symbol).filter(Boolean))];
    if (!syms.length) return;
    let rows = [];
    try { rows = (await (await fetch(`/api/quotes?symbols=${encodeURIComponent(syms.join(","))}`)).json()).quotes || []; } catch (_) { return; }
    const byS = {}; rows.forEach((q) => { byS[q.symbol] = q; });
    panes.forEach((p) => {
      const q = byS[p.dataset.symbol]; const el = p.querySelector(".ticker-info"); if (!el) return;
      if (!q || !q.ok) { el.textContent = ""; return; }
      const d = digitsFor(q.price);
      const cls = q.change >= 0 ? "up" : "down";
      el.innerHTML = `<span class="${cls}">${q.change >= 0 ? "▲" : "▼"} ${fmt(Math.abs(q.change), d)} (${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%)</span>` +
        ` · day ${fmt(q.day_low, d)}–${fmt(q.day_high, d)} · 52w ${fmt(q.year_low, d)}–${fmt(q.year_high, d)}`;
    });
  }
  window.addEventListener("pane-symbol", () => setTimeout(refreshInfo, 300));

  loadWatchlist(); loadAlerts(); setTimeout(refreshInfo, 1500);
  setInterval(refreshQuotes, 60000);
  setInterval(loadAlerts, 30000);
  setInterval(refreshInfo, 60000);
})();
