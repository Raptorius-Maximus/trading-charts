/* "Analyse" panel: Graham / Buffett / Munger reading of one stock. Shared by the charts page and the screener. */
(function () {
  "use strict";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (v, d) => v == null ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const big = (v) => v == null ? "–" : Math.abs(v) >= 1e12 ? (v / 1e12).toFixed(2) + " T" : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + " B" : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(0) + " M" : fmt(v, 0);
  const ICON = { good: "✓", warn: "!", bad: "✗", info: "·" };

  let overlay = null;
  function ensure() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "an-overlay hidden";
    overlay.innerHTML = '<div class="an-panel"><div class="an-head"><div class="an-title"></div><div><button type="button" class="an-refresh" title="Recompute from fresh data">↻</button><button type="button" class="an-close" title="Close (Esc)">×</button></div></div><div class="an-body"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".an-close").addEventListener("click", close);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    return overlay;
  }
  function close() { if (overlay) overlay.classList.add("hidden"); }

  function section(title, items) {
    return `<h4>${title}</h4><ul class="an-list">` + items.map((i) => `<li class="k-${i.kind}"><span class="ic">${ICON[i.kind] || "·"}</span>${esc(i.text)}</li>`).join("") + "</ul>";
  }
  function histTable(f) {
    if (!f.years || !f.years.length) return "";
    const row = (label, arr, d, scale) => `<tr><td>${label}</td>` + f.years.map((_, i) => `<td>${arr && arr[i] != null ? (scale ? big(arr[i]) : fmt(arr[i], d)) : "–"}</td>`).join("") + "</tr>";
    return `<table class="an-hist"><tr><th></th>${f.years.map((y) => `<th>${y}</th>`).join("")}</tr>` +
      row("Revenue", f.revenue, 0, true) + row("Net income", f.net_income, 0, true) + row("EPS", f.eps_history, 2) +
      row("Free cash flow", f.fcf_history, 0, true) + row("Equity", f.equity, 0, true) + row("Debt", f.debt, 0, true) + "</table>";
  }
  function render(d) {
    const f = d.facts;
    const o = ensure();
    o.querySelector(".an-title").innerHTML = `<b>${esc(f.name)}</b> <span class="dim">${esc(f.symbol)} · ${esc(f.sector)}${f.industry ? " · " + esc(f.industry) : ""}</span>`;
    o.querySelector(".an-body").innerHTML =
      `<div class="an-verdict">${esc(d.verdict)}</div>` +
      `<div class="an-facts">` +
        `<span>Price <b>${fmt(f.price, 2)} ${esc(f.currency || "")}</b></span><span>Mkt cap <b>${big(f.market_cap)}</b></span>` +
        `<span>P/E <b>${fmt(f.pe, 1)}</b></span><span>P/B <b>${fmt(f.pb, 2)}</b></span><span>Graham # <b>${fmt(f.graham_number, 2)}</b></span>` +
        `<span>ROE <b>${f.roe == null ? "–" : (f.roe * 100).toFixed(0) + "%"}</b></span><span>FCF yield <b>${f.fcf_yield == null ? "–" : (f.fcf_yield * 100).toFixed(1) + "%"}</b></span>` +
        `<span>Div <b>${fmt(f.dividend_yield, 2)}%</b></span><span>D/E <b>${fmt(f.debt_to_equity, 0)}%</b></span>` +
        `<span>Scores <b>Graham ${f.graham_score}/7 · Quality ${f.quality_score}/7</b></span>` +
      `</div>` +
      section("Benjamin Graham — is it cheap and safe?", d.graham) +
      section("Warren Buffett — is it a wonderful business?", d.buffett) +
      section("Charlie Munger — invert, and would you hold it 20 years?", d.munger) +
      `<h4>The record (from Yahoo, fiscal years)</h4>` + histTable(f) +
      `<div class="dim tiny">${esc(d.note)} Generated ${new Date(d.generated * 1000).toLocaleString()}.</div>`;
    o.querySelector(".an-refresh").onclick = () => open(f.symbol, true);
    o.classList.remove("hidden");
  }
  async function open(symbol, force) {
    const o = ensure();
    o.querySelector(".an-title").textContent = `Analysing ${symbol}…`;
    o.querySelector(".an-body").innerHTML = '<div class="dim">Reading four years of statements from Yahoo — a few seconds.</div>';
    o.classList.remove("hidden");
    try {
      const r = await fetch(`/api/analysis/${encodeURIComponent(symbol)}${force ? "?force=1" : ""}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      render(d);
    } catch (e) {
      o.querySelector(".an-body").innerHTML = `<div class="k-bad">Could not analyse ${esc(symbol)}: ${esc(e.message)}</div>`;
    }
  }
  window.stockAnalysis = { open, close };
  // Any element with data-analyse="SYMBOL" opens the panel.
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-analyse]"); if (!el) return;
    e.preventDefault(); open(el.dataset.analyse);
  });
})();
