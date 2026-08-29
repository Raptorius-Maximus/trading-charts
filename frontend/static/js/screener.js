/* Value screener: one table, sorted/filtered in the browser. */
(function () {
  "use strict";

  const COLS = [
    { key: "symbol", label: "Symbol", left: true, fmt: (v, r) => `<a href="/?symbol=${encodeURIComponent(v)}" title="Open in chart">${v}</a>` },
    { key: "name", label: "Name", left: true, fmt: (v) => esc(v || "") },
    { key: "market", label: "Market", left: true, fmt: (v) => esc(v || "") },
    { key: "sector", label: "Sector", left: true, fmt: (v) => esc(v || "") },
    { key: "price", label: "Price", fmt: (v, r) => num(v, 2) + (r.currency ? ` <span class="na">${esc(r.currency)}</span>` : "") },
    { key: "market_cap", label: "Mkt cap", fmt: big },
    { key: "graham_score", label: "Graham /7", fmt: (v, r) => score(v) + " " + checks(r.graham) },
    { key: "quality_score", label: "Quality /7", fmt: (v, r) => score(v) + " " + checks(r.quality) },
    { key: "pe", label: "P/E", fmt: (v) => cls(num(v, 1), v != null && v > 0 && v <= 15) },
    { key: "pb", label: "P/B", fmt: (v) => cls(num(v, 2), v != null && v <= 1.5) },
    { key: "pe_x_pb", label: "P/E×P/B", fmt: (v) => cls(num(v, 1), v != null && v <= 22.5) },
    { key: "graham_number", label: "Graham #", fmt: (v) => num(v, 1) },
    { key: "graham_margin", label: "Margin", fmt: (v) => cls(pct(v), v != null && v > 0, v != null && v < 0) },
    { key: "current_ratio", label: "Cur. ratio", fmt: (v) => cls(num(v, 2), v != null && v >= 2) },
    { key: "debt_to_equity", label: "D/E %", fmt: (v) => cls(num(v, 0), v != null && v <= 50, v != null && v > 150) },
    { key: "roe", label: "ROE", fmt: (v) => cls(pct(v), v != null && v >= 0.15, v != null && v < 0) },
    { key: "roa", label: "ROA", fmt: (v) => cls(pct(v), v != null && v >= 0.07, v != null && v < 0) },
    { key: "net_margin", label: "Net m.", fmt: (v) => cls(pct(v), v != null && v >= 0.10, v != null && v < 0) },
    { key: "gross_margin", label: "Gross m.", fmt: (v) => cls(pct(v), v != null && v >= 0.40) },
    { key: "fcf_yield", label: "FCF yld", fmt: (v) => cls(pct(v), v != null && v >= 0.05, v != null && v < 0) },
    { key: "dividend_yield", label: "Div yld", fmt: (v) => v == null ? na() : num(v, 2) + "%" },
    { key: "earnings_growth", label: "EPS g", fmt: (v) => cls(pct(v), v != null && v > 0, v != null && v < 0) },
    { key: "revenue_growth", label: "Rev g", fmt: (v) => cls(pct(v), v != null && v > 0, v != null && v < 0) },
    { key: "ev_ebitda", label: "EV/EBITDA", fmt: (v) => num(v, 1) },
  ];

  let rows = [];
  let sortKey = "graham_score", sortDir = -1, preset = "all";

  const $ = (id) => document.getElementById(id);
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function na() { return '<span class="na">·</span>'; }
  function num(v, d) { return v == null ? na() : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }); }
  function pct(v) { return v == null ? na() : (v * 100).toFixed(1) + "%"; }
  function big(v) {
    if (v == null) return na();
    const a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + " T";
    if (a >= 1e9) return (v / 1e9).toFixed(1) + " B";
    if (a >= 1e6) return (v / 1e6).toFixed(0) + " M";
    return num(v, 0);
  }
  function cls(html, good, bad) { return good ? `<span class="good">${html}</span>` : bad ? `<span class="bad">${html}</span>` : html; }
  function score(v) { const c = v >= 5 ? "s-hi" : v >= 3 ? "s-mid" : "s-lo"; return `<span class="score ${c}">${v == null ? "·" : v}/7</span>`; }
  function checks(obj) {
    if (!obj) return "";
    return '<span class="checks">' + Object.entries(obj).map(([k, v]) =>
      `<span class="${v === true ? "p" : v === false ? "f" : "n"}" title="${esc(k.replace(/_/g, " "))}">${v === true ? "✓" : v === false ? "✗" : "·"}</span>`).join("") + "</span>";
  }

  function passesPreset(r) {
    switch (preset) {
      case "graham": return (r.graham_score || 0) >= 5;
      case "quality": return (r.quality_score || 0) >= 5;
      case "both": return (r.graham_score || 0) >= 4 && (r.quality_score || 0) >= 4;
      case "under": return r.graham_margin != null && r.graham_margin > 0;
      default: return true;
    }
  }

  function render() {
    const q = $("q").value.trim().toLowerCase();
    const market = $("market").value;
    let list = rows.filter((r) => r.ok);
    if (market) list = list.filter((r) => r.market === market);
    if (q) list = list.filter((r) => `${r.symbol} ${r.name} ${r.sector} ${r.industry || ""}`.toLowerCase().includes(q));
    list = list.filter(passesPreset);
    list.sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === "string") return x.localeCompare(y) * sortDir;
      return (x - y) * sortDir;
    });
    $("head").innerHTML = COLS.map((c) =>
      `<th class="${c.left ? "l " : ""}${c.key === sortKey ? "sorted" : ""}" data-key="${c.key}">${c.label}${c.key === sortKey ? (sortDir < 0 ? " ▼" : " ▲") : ""}</th>`).join("");
    $("body").innerHTML = list.map((r) =>
      "<tr>" + COLS.map((c) => `<td class="${c.left ? "l" : ""}">${c.fmt(r[c.key], r)}</td>`).join("") + "</tr>").join("");
    const total = rows.filter((r) => r.ok).length;
    $("status").textContent = `${list.length} of ${total} stocks` + (statusText ? " · " + statusText : "");
  }

  let statusText = "";
  async function load() {
    const res = await fetch("/api/screener");
    const body = await res.json();
    rows = body.rows || [];
    const st = body.status || {};
    if (st.refreshing) statusText = `refreshing ${st.progress}/${st.total}…`;
    else if (st.cache_updated) statusText = "data " + new Date(st.cache_updated * 1000).toLocaleString();
    else statusText = "no data yet";
    const markets = [...new Set(rows.map((r) => r.market).filter(Boolean))].sort();
    const sel = $("market"); const cur = sel.value;
    sel.innerHTML = '<option value="">All markets</option>' + markets.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
    sel.value = cur;
    render();
    if (st.refreshing) setTimeout(load, 5000);
  }

  $("head").addEventListener("click", (e) => {
    const th = e.target.closest("th"); if (!th) return;
    const k = th.dataset.key;
    if (k === sortKey) sortDir = -sortDir; else { sortKey = k; sortDir = COLS.find((c) => c.key === k).left ? 1 : -1; }
    render();
  });
  $("q").addEventListener("input", render);
  $("market").addEventListener("change", render);
  document.querySelectorAll(".scr-presets button").forEach((b) => b.addEventListener("click", () => {
    preset = b.dataset.preset;
    document.querySelectorAll(".scr-presets button").forEach((x) => x.classList.toggle("active", x === b));
    render();
  }));
  $("add-btn").addEventListener("click", addSymbol);
  $("add").addEventListener("keydown", (e) => { if (e.key === "Enter") addSymbol(); });
  async function addSymbol() {
    const sym = $("add").value.trim().toUpperCase(); if (!sym) return;
    $("status").textContent = `fetching ${sym}…`;
    const res = await fetch(`/api/screener/add?symbol=${encodeURIComponent(sym)}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { $("status").textContent = body.detail || `could not add ${sym}`; return; }
    $("add").value = ""; $("q").value = sym;
    await load();
  }
  $("refresh-btn").addEventListener("click", async () => {
    await fetch("/api/screener/refresh", { method: "POST" });
    load();
  });

  load();
})();
