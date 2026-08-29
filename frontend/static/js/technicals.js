/* Auto technicals, Verified-Investing style: swing pivots -> trendlines that
   touch 3+ times, horizontal support/resistance, unfilled gaps, trend
   structure, and a plain-language setup read with a 0-100 score.

   Pure pattern detection on the candles already loaded. No prediction is
   implied beyond "this is what the method looks for". */
(function () {
  "use strict";

  // ---------- helpers
  function atr(c, n) {
    let s = 0, k = 0;
    for (let i = Math.max(1, c.length - n); i < c.length; i++) {
      const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
      s += tr; k++;
    }
    return k ? s / k : 0;
  }
  function pivots(c, k) {
    const highs = [], lows = [];
    for (let i = k; i < c.length - k; i++) {
      let isH = true, isL = true;
      for (let j = i - k; j <= i + k && (isH || isL); j++) {
        if (j === i) continue;
        if (c[j].high >= c[i].high) isH = false;
        if (c[j].low <= c[i].low) isL = false;
      }
      if (isH) highs.push({ i, v: c[i].high, t: c[i].time });
      if (isL) lows.push({ i, v: c[i].low, t: c[i].time });
    }
    return { highs, lows };
  }

  // Trendline through two pivots; count other pivots within tol; require price
  // to respect it (resistance: closes not above line+tol between first touch and now).
  function findTrendlines(c, piv, kind, tol) {
    const n = c.length, out = [];
    const recentFrom = Math.floor(n * 0.4);
    for (let a = 0; a < piv.length; a++) {
      for (let b = a + 1; b < piv.length; b++) {
        const p = piv[a], q = piv[b];
        if (q.i - p.i < 5) continue;
        if (q.i < recentFrom && b !== piv.length - 1) continue; // must be relevant now
        const slope = (q.v - p.v) / (q.i - p.i);
        const at = (i) => p.v + slope * (i - p.i);
        const touches = [];
        let violated = 0;
        for (const r of piv) {
          if (r.i < p.i) continue;
          if (Math.abs(r.v - at(r.i)) <= tol) touches.push(r.i);
        }
        for (let i = p.i; i < n; i++) {
          const v = at(i);
          if (kind === "res" && c[i].close > v + tol * 1.5) violated++;
          if (kind === "sup" && c[i].close < v - tol * 1.5) violated++;
        }
        if (touches.length >= 3 && violated <= Math.max(1, Math.floor((n - p.i) * 0.015))) {
          out.push({ kind, p, q, slope, touches: touches.length, at, from: p.i, last: touches[touches.length - 1] });
        }
      }
    }
    // relevance: the line must still be near the action today and have been
    // touched in the recent half of the window
    const price = c[n - 1].close;
    const relevant = out.filter((l) => {
      const gap = Math.abs(l.at(n - 1) - price) / price;
      const movingAway = (kind === "res" && l.slope > 0 && gap > 0.08) || (kind === "sup" && l.slope < 0 && gap > 0.08);
      return gap <= 0.2 && l.last >= n * 0.5 && !movingAway;
    });
    // dedupe: near-duplicate if both ends are within a few tolerances
    relevant.sort((x, y) => y.touches - x.touches || y.last - x.last);
    const keep = [];
    for (const l of relevant) {
      const dup = keep.some((k) => Math.abs(k.at(n - 1) - l.at(n - 1)) < tol * 4 && Math.abs(k.at(l.from) - l.at(l.from)) < tol * 4);
      if (dup) continue;
      keep.push(l);
      if (keep.length >= 2) break;
    }
    return keep;
  }

  function levels(c, piv, tol) {
    const pts = piv.slice().sort((a, b) => a.v - b.v);
    const clusters = [];
    for (const p of pts) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(p.v - last.mean) <= tol) { last.pts.push(p); last.mean = last.pts.reduce((s, x) => s + x.v, 0) / last.pts.length; }
      else clusters.push({ pts: [p], mean: p.v });
    }
    return clusters.filter((k) => k.pts.length >= 2).map((k) => ({ price: k.mean, touches: k.pts.length, last: Math.max(...k.pts.map((x) => x.i)) }));
  }

  function gaps(c, minPct) {
    const out = [];
    for (let i = 1; i < c.length; i++) {
      const up = c[i].low > c[i - 1].high, dn = c[i].high < c[i - 1].low;
      if (!up && !dn) continue;
      const top = up ? c[i].low : c[i - 1].low, bot = up ? c[i - 1].high : c[i].high;
      if ((top - bot) / bot < minPct) return out.concat([]), out;
      let filled = false;
      for (let j = i + 1; j < c.length; j++) { if (up ? c[j].low <= bot : c[j].high >= top) { filled = true; break; } }
      if (!filled) out.push({ i, up, top, bot, t0: c[i - 1].time, t1: c[c.length - 1].time });
    }
    return out.slice(-4);
  }

  function analyse(candles) {
    const c = candles;
    const n = c.length;
    if (n < 40) return null;
    const k = Math.max(3, Math.min(8, Math.round(n / 50)));
    const a = atr(c, 14);
    const price = c[n - 1].close;
    const tol = Math.max(a * 0.6, price * 0.004);
    const { highs, lows } = pivots(c, k);
    const res = findTrendlines(c, highs, "res", tol);
    const sup = findTrendlines(c, lows, "sup", tol);
    const lv = levels(c, highs.concat(lows), tol * 1.5).filter((l) => l.touches >= 3);
    const below = lv.filter((l) => l.price < price - tol).sort((x, y) => y.price - x.price).slice(0, 2);
    const above = lv.filter((l) => l.price >= price + tol).sort((x, y) => x.price - y.price).slice(0, 2);
    const gp = gaps(c, 0.004);

    // trend structure from the last pivots
    const h2 = highs.slice(-2), l2 = lows.slice(-2);
    let trend = "range";
    if (h2.length === 2 && l2.length === 2) {
      if (h2[1].v > h2[0].v && l2[1].v > l2[0].v) trend = "up";
      else if (h2[1].v < h2[0].v && l2[1].v < l2[0].v) trend = "down";
    }

    // nearest support / resistance now (lines evaluated at the last bar)
    const supNow = sup.map((l) => ({ v: l.at(n - 1), touches: l.touches, kind: "trendline" })).filter((x) => x.v <= price + tol)
      .concat(below.map((l) => ({ v: l.price, touches: l.touches, kind: "level" }))).sort((x, y) => y.v - x.v);
    const resNow = res.map((l) => ({ v: l.at(n - 1), touches: l.touches, kind: "trendline" })).filter((x) => x.v >= price - tol)
      .concat(above.map((l) => ({ v: l.price, touches: l.touches, kind: "level" }))).sort((x, y) => x.v - y.v);
    const ns = supNow[0], nr = resNow[0];
    const dS = ns ? (price - ns.v) / price : null, dR = nr ? (nr.v - price) / price : null;
    const confluenceS = supNow.length >= 2 && Math.abs(supNow[0].v - supNow[1].v) <= tol * 2;
    const confluenceR = resNow.length >= 2 && Math.abs(resNow[0].v - resNow[1].v) <= tol * 2;

    // score: the method's own logic -- buy at multi-touch support in an uptrend, not into resistance
    let score = 50; const why = [];
    if (trend === "up") { score += 10; why.push("higher highs and higher lows (uptrend)"); }
    if (trend === "down") { score -= 10; why.push("lower highs and lower lows (downtrend)"); }
    if (ns && dS <= 0.02) { score += 10 + Math.min(15, ns.touches * 4); why.push(`sitting on ${ns.kind === "trendline" ? "a support trendline" : "horizontal support"} touched ${ns.touches}×`); }
    else if (ns && dS <= 0.05) { score += 5; why.push(`support ${(dS * 100).toFixed(1)}% below`); }
    if (confluenceS) { score += 15; why.push("confluence: two supports meet here"); }
    if (nr && dR <= 0.02) { score -= 20; why.push(`right under ${nr.kind === "trendline" ? "a resistance trendline" : "horizontal resistance"} touched ${nr.touches}×`); }
    if (confluenceR) { score -= 10; why.push("confluence of resistance overhead"); }
    if (ns && dS > 0.10) { score -= 10; why.push(`extended ${(dS * 100).toFixed(0)}% above support`); }
    if (dR != null && dS != null && dR > dS * 2 && dR > 0.05) { score += 5; why.push("more room up to resistance than down to support"); }
    const gapBelow = gp.find((g) => g.up && g.top < price), gapAbove = gp.find((g) => !g.up && g.bot > price);
    if (gapBelow) why.push(`unfilled gap below at ${gapBelow.bot.toFixed(2)}–${gapBelow.top.toFixed(2)} (gaps tend to fill)`);
    if (gapAbove) why.push(`unfilled gap above at ${gapAbove.bot.toFixed(2)}–${gapAbove.top.toFixed(2)} (a magnet if it breaks out)`);
    // Wedge / apex: a falling resistance line and a rising support line
    // converging near today's price. The method's read: the breakout
    // direction decides -- don't front-run it.
    let wedge = null;
    for (const r of res) for (const su of sup) {
      if (r.slope < 0 && su.slope > 0 && (r.at(n - 1) - su.at(n - 1)) / price < 0.08) wedge = { top: r.at(n - 1), bot: su.at(n - 1) };
    }
    if (wedge) {
      score = Math.min(score, 65);
      why.push(`coiling at the apex of a wedge (${wedge.bot.toFixed(2)}–${wedge.top.toFixed(2)}): a close above the top line is the buy signal, a close below the bottom line is the failure`);
    }
    score = Math.max(0, Math.min(100, score));
    const label = score >= 75 ? "High-probability long setup" : score >= 60 ? "Constructive" : score >= 40 ? "Neutral — wait" : "Poor location to buy";

    return { n, tol, price, trend, res, sup, below, above, gaps: gp, ns, nr, dS, dR, confluenceS, confluenceR, wedge, score, label, why };
  }

  // ---------- drawing (KLineChart overlays, grouped so they can be removed together)
  const GROUP = "auto-ta";
  const C = { res: "#ef5350", sup: "#26a69a", lvl: "#d29922", gap: "#4f8ff7" };
  function draw(chart, candles, r) {
    clear(chart);
    const items = [];
    const last = candles[candles.length - 1].time * 1000;
    const mk = (l) => ({
      name: "rayLine", groupId: GROUP, lock: true,
      points: [{ timestamp: l.p.t * 1000, value: l.p.v }, { timestamp: l.q.t * 1000, value: l.q.v }],
      styles: { line: { color: l.kind === "res" ? C.res : C.sup, size: 1.5 } },
    });
    r.res.forEach((l) => items.push(mk(l)));
    r.sup.forEach((l) => items.push(mk(l)));
    r.below.concat(r.above).forEach((l) => items.push({
      name: "horizontalStraightLine", groupId: GROUP, lock: true,
      points: [{ timestamp: last, value: l.price }],
      styles: { line: { color: C.lvl, style: "dashed", size: 1 } },
    }));
    r.gaps.forEach((g) => items.push({
      name: "rect", groupId: GROUP, lock: true,
      points: [{ timestamp: g.t0 * 1000, value: g.top }, { timestamp: g.t1 * 1000, value: g.bot }],
      styles: { polygon: { color: "rgba(79,143,247,0.12)", borderColor: C.gap, borderSize: 1 } },
    }));
    if (items.length) chart.createOverlay(items);
  }
  function clear(chart) { try { chart.removeOverlay({ groupId: GROUP }); } catch (_) {} }

  function readout(r, cur) {
    if (!r) return "Not enough bars for a read (need 40+). Try a longer range.";
    const f = (v) => v.toFixed(v >= 100 ? 2 : 3);
    const parts = [];
    parts.push(`<b class="ta-score s${r.score >= 60 ? "hi" : r.score >= 40 ? "mid" : "lo"}">${r.score}/100 · ${r.label}</b>`);
    parts.push(`Trend: <b>${r.trend === "up" ? "up (HH/HL)" : r.trend === "down" ? "down (LH/LL)" : "sideways"}</b>`);
    if (r.ns) parts.push(`Support: <b>${f(r.ns.v)}</b> (${r.ns.kind}, ${r.ns.touches}×, ${(r.dS * 100).toFixed(1)}% below)`);
    if (r.nr) parts.push(`Resistance: <b>${f(r.nr.v)}</b> (${r.nr.kind}, ${r.nr.touches}×, ${(r.dR * 100).toFixed(1)}% above)`);
    parts.push(`Lines: ${r.sup.length} support, ${r.res.length} resistance (3+ touches), ${r.below.length + r.above.length} levels, ${r.gaps.length} open gaps`);
    return parts.join(" · ") + (r.why.length ? `<div class="ta-why">${r.why.join("; ")}.</div>` : "") +
      `<div class="ta-why dim">Score = how well this spot matches the method (buy at multi-touch support in an uptrend, not into resistance). Pattern detection on past prices — not a forecast.</div>`;
  }

  window.autoTA = { analyse, draw, clear, readout };
})();
