/*
 * Minimal drawing-tool overlays for KLineChart.
 *
 * KLineChart's core package (the one vendored here, no separate "pro"
 * package) ships the low-level Figure primitives (line, rect, text, ...)
 * and the registerOverlay/createOverlay plumbing, but it does NOT ship
 * ready-made drawing tools like a trendline or a Fibonacci retracement --
 * those exist only in TradingView-style demo apps built on top of it. We
 * define the three tools the dashboard needs (trend line, horizontal
 * line, fib retracement) here using that public plugin API. This is the
 * intended, supported way to add drawing tools to KLineChart; it just
 * isn't literally "for free" out of the core package.
 */
(function (global) {
  const kline = global.klinecharts;

  function fmtPrice(v) {
    const abs = Math.abs(v);
    const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
    return v.toFixed(digits);
  }

  kline.registerOverlay({
    name: "trend_line",
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: { line: { color: "#4f8ff7", size: 2 } },
    createPointFigures: ({ coordinates }) => {
      if (coordinates.length < 2) return [];
      return {
        type: "line",
        attrs: { coordinates: [coordinates[0], coordinates[1]] },
        styles: { color: "#4f8ff7", size: 2 },
      };
    },
  });

  kline.registerOverlay({
    name: "horizontal_line",
    totalStep: 2,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      if (coordinates.length < 1) return [];
      const y = coordinates[0].y;
      const price = overlay.points[0] ? overlay.points[0].value : null;
      const figs = [
        {
          type: "line",
          attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
          styles: { color: "#d29922", size: 1, style: "dashed" },
        },
      ];
      if (price != null) {
        figs.push({
          type: "text",
          attrs: { x: bounding.width - 4, y: y - 14, text: fmtPrice(price), align: "right" },
          styles: { color: "#d29922", size: 11, backgroundColor: "rgba(14,17,23,0.7)" },
        });
      }
      return figs;
    },
  });

  const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_COLOR = "#7ee8d8";

  kline.registerOverlay({
    name: "fib_retracement",
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates, bounding, overlay, yAxis }) => {
      if (coordinates.length < 2 || !yAxis) return [];
      const p0 = overlay.points[0];
      const p1 = overlay.points[1];
      if (!p0 || p1 == null || p1.value == null) return [];
      const diff = p1.value - p0.value;
      const xLeft = Math.min(coordinates[0].x, coordinates[1].x);
      const xRight = bounding.width;
      const figs = [];
      FIB_LEVELS.forEach((level) => {
        const price = p0.value + diff * level;
        const y = yAxis.convertToPixel(price);
        figs.push({
          type: "line",
          attrs: { coordinates: [{ x: xLeft, y }, { x: xRight, y }] },
          styles: { color: FIB_COLOR, size: 1, style: "dashed" },
        });
        figs.push({
          type: "text",
          attrs: { x: xRight - 4, y: y - 14, text: `${level.toFixed(3)}  ${fmtPrice(price)}`, align: "right" },
          styles: { color: FIB_COLOR, size: 10, backgroundColor: "rgba(14,17,23,0.7)" },
        });
      });
      return figs;
    },
  });
})(window);

/* Rectangle and circle drawing tools. KLineChart's core build registers
   neither (they live in its paid extension), so the Draw menu entries and
   the volume profile need our own. Two-point tools; points may sit beyond
   the last bar (dataIndex-based), which the profile relies on. */
(function (global) {
  const kline = global.klinecharts;
  kline.registerOverlay({
    name: "rect",
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates }) => {
      if (coordinates.length < 2) return [];
      const [a, b] = coordinates;
      return [{
        type: "polygon",
        attrs: { coordinates: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }] },
        styles: { style: "stroke_fill" },
      }];
    },
  });
  kline.registerOverlay({
    name: "circle",
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates }) => {
      if (coordinates.length < 2) return [];
      const [a, b] = coordinates;
      const r = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
      return [{ type: "circle", attrs: { x: a.x, y: a.y, r }, styles: { style: "stroke_fill" } }];
    },
  });
})(window);
