/* Theme picker: presets + custom background colour. Per-browser (localStorage),
   so it works on the public link too. Charts re-style to match via
   window.chartsApp.restyle(). */
(function () {
  "use strict";
  const PRESETS = {
    dark:  { label: "Dark (default)", bg: "#0e1117", panel: "#161b22", border: "#262d38", text: "#d8dee9", dim: "#7d8590", grid: "#20252f" },
    black: { label: "Black",          bg: "#000000", panel: "#0a0a0a", border: "#222222", text: "#e6e6e6", dim: "#8a8a8a", grid: "#161616" },
    slate: { label: "Slate blue",     bg: "#131a26", panel: "#1a2333", border: "#2a3547", text: "#dbe3ee", dim: "#8593a8", grid: "#232e40" },
    green: { label: "Terminal green", bg: "#0b120d", panel: "#101a13", border: "#1f3326", text: "#d6e9d9", dim: "#7fa088", grid: "#18251c" },
    light: { label: "Light",          bg: "#f4f6fa", panel: "#ffffff", border: "#d9dee7", text: "#1f2937", dim: "#6b7280", grid: "#e8ecf2" },
  };

  // Derive a full palette from one background colour (for the custom picker).
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgbToHex(r, g, b) { return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""); }
  function mix(hex, target, k) { const a = hexToRgb(hex), t = hexToRgb(target); return rgbToHex(a[0] + (t[0] - a[0]) * k, a[1] + (t[1] - a[1]) * k, a[2] + (t[2] - a[2]) * k); }
  function luma(hex) { const [r, g, b] = hexToRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
  function fromBackground(bg) {
    const dark = luma(bg) < 0.5;
    const towards = dark ? "#ffffff" : "#000000";
    return { label: "Custom", bg, panel: mix(bg, towards, dark ? 0.05 : 0.9), border: mix(bg, towards, dark ? 0.13 : 0.18),
      text: dark ? "#e2e8f0" : "#1f2937", dim: dark ? "#8b93a1" : "#6b7280", grid: mix(bg, towards, dark ? 0.09 : 0.12) };
  }

  function apply(theme) {
    const r = document.documentElement.style;
    r.setProperty("--bg", theme.bg); r.setProperty("--panel", theme.panel); r.setProperty("--panel-border", theme.border);
    r.setProperty("--text", theme.text); r.setProperty("--text-dim", theme.dim);
    document.body.style.background = theme.bg;
    window.currentTheme = theme;
    if (window.chartsApp && window.chartsApp.restyle) window.chartsApp.restyle();
  }
  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("charts.theme") || "null"); } catch (_) {}
    if (!saved) return;
    if (saved.preset && PRESETS[saved.preset]) apply(PRESETS[saved.preset]);
    else if (saved.bg) apply(fromBackground(saved.bg));
  }
  function save(obj) { try { localStorage.setItem("charts.theme", JSON.stringify(obj)); } catch (_) {} }

  function buildMenu(menu) {
    menu.innerHTML = "";
    Object.entries(PRESETS).forEach(([key, t]) => {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<span><span class="swatch" style="background:${t.bg};border-color:${t.border}"></span>${t.label}</span>`;
      row.addEventListener("click", () => { apply(t); save({ preset: key }); menu.classList.add("hidden"); });
      menu.appendChild(row);
    });
    const custom = document.createElement("div"); custom.className = "save-row";
    custom.innerHTML = `<label style="display:flex;align-items:center;gap:8px;flex:1">Custom background <input type="color" value="${(window.currentTheme || PRESETS.dark).bg}"></label>`;
    const input = custom.querySelector("input");
    input.addEventListener("input", () => { const t = fromBackground(input.value); apply(t); });
    input.addEventListener("change", () => { save({ bg: input.value }); });
    custom.addEventListener("mousedown", (e) => e.stopPropagation());
    menu.appendChild(custom);
  }

  window.chartsTheme = { PRESETS, apply, load };
  load();
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-btn"), menu = document.getElementById("theme-menu");
    if (!btn || !menu) return;
    btn.addEventListener("click", () => {
      const open = menu.classList.contains("hidden");
      document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
      if (open) { buildMenu(menu); menu.classList.remove("hidden"); }
    });
    document.addEventListener("mousedown", (e) => { if (!menu.parentElement.contains(e.target)) menu.classList.add("hidden"); });
  });
})();
