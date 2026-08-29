/* Volume profile from the bars on screen: each bar's volume is spread
   evenly across its high-low range into price bins. POC = the bin with
   the most volume; value area = the bins around POC holding 70% of it.
   Approximate by nature (daily bars, not tick data) -- good for "where did
   the crowd agree on price this year", not for intraday trading. */
(function () {
  "use strict";
  const GROUP = "auto-vp";
  const BINS = 48, VALUE_AREA = 0.70;

  function compute(c) {
    if (!c || c.length < 20) return null;
    let lo = Infinity, hi = -Infinity;
    for (const b of c) { if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; }
    if (!(hi > lo)) return null;
    const step = (hi - lo) / BINS;
    const vol = new Array(BINS).fill(0);
    for (const b of c) {
      const v = b.volume || 0; if (!v) continue;
      const a = Math.max(0, Math.floor((b.low - lo) / step)), z = Math.min(BINS - 1, Math.floor((b.high - lo) / step));
      const n = z - a + 1;
      for (let i = a; i <= z; i++) vol[i] += v / n;
    }
    const total = vol.reduce((s, x) => s + x, 0);
    if (!total) return null;
    let poc = 0;
    for (let i = 1; i < BINS; i++) if (vol[i] > vol[poc]) poc = i;
    // value area: grow from POC, taking the bigger neighbour each step
    let a = poc, z = poc, acc = vol[poc];
    while (acc < total * VALUE_AREA && (a > 0 || z < BINS - 1)) {
      const up = z < BINS - 1 ? vol[z + 1] : -1, dn = a > 0 ? vol[a - 1] : -1;
      if (up >= dn) { z++; acc += up; } else { a--; acc += dn; }
    }
    const mid = (i) => lo + (i + 0.5) * step;
    const price = c[c.length - 1].close;
    const pocP = mid(poc), vah = lo + (z + 1) * step, val = lo + a * step;
    // acceptance / rejection over the last 10 bars vs POC
    const tail = c.slice(-10);
    const above = tail.filter((b) => b.close > pocP).length;
    let status;
    if (price > vah) status = "above value — expensive vs where the crowd agreed; watch for a pull back to VAH/POC";
    else if (price < val) status = "below value — cheap vs where the crowd agreed; a reclaim of VAL puts POC back in play as target";
    else if (Math.abs(price - pocP) / price < 0.015) status = "sitting at the fair price (POC) — a decision spot: bounce = old rules hold, break-and-hold = new rules";
    else status = above >= 8 ? "inside value, holding above POC — buyers accepting these prices" : above <= 2 ? "inside value, held below POC — sellers in charge for now" : "inside value, chopping around POC — no decision yet";
    return { lo, hi, step, vol, total, max: Math.max(...vol), poc, a, z, pocP, vah, val, price, status, bars: c.length };
  }

  function draw(chart, c, r) {
    clear(chart);
    // Bars sit to the right of the last candle, positioned by bar index so
    // they can extend past the data. Width = share of the biggest bin.
    const n = chart.getDataList().length;
    const x0 = n + 1, maxW = 24;
    const items = [];
    for (let i = 0; i < BINS; i++) {
      if (!r.vol[i]) continue;
      const w = Math.max(1, Math.round(maxW * r.vol[i] / r.max));
      const inVA = i >= r.a && i <= r.z;
      const col = i === r.poc ? "rgba(171,102,255,0.85)" : inVA ? "rgba(171,102,255,0.45)" : "rgba(171,102,255,0.18)";
      items.push({
        name: "rect", groupId: GROUP, lock: true,
        points: [{ dataIndex: x0, value: r.lo + (i + 1) * r.step }, { dataIndex: x0 + w, value: r.lo + i * r.step }],
        styles: { polygon: { color: col, borderColor: col, borderSize: 0 } },
      });
    }
    const line = (v, dashed) => ({ name: "horizontalStraightLine", groupId: GROUP, lock: true, points: [{ dataIndex: n - 1, value: v }],
      styles: { line: { color: "#ab66ff", style: dashed ? "dashed" : "solid", size: dashed ? 1 : 2 } } });
    items.push(line(r.pocP, false), line(r.vah, true), line(r.val, true));
    chart.createOverlay(items);
    // leave room to the right of the last candle so the profile is visible
    const bs = chart.getBarSpace ? chart.getBarSpace().bar : 6;
    chart.setOffsetRightDistance(Math.max(chart.getOffsetRightDistance(), (maxW + 4) * bs));
  }
  function clear(chart) { try { chart.removeOverlay({ groupId: GROUP }); } catch (_) {} }

  function readout(r) {
    if (!r) return "Not enough bars for a profile (need 20+).";
    const f = (v) => v.toFixed(v >= 100 ? 2 : 3);
    return `<b class="vp-tag">Volume profile</b> · POC (fair price) <b>${f(r.pocP)}</b> · value area <b>${f(r.val)}–${f(r.vah)}</b> (70% of volume) · price <b>${f(r.price)}</b> is ${r.status}. <span class="dim">${r.bars} bars, daily-bar approximation.</span>`;
  }

  window.volProfile = { compute, draw, clear, readout };
})();
