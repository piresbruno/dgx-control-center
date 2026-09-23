/* Pulse DS mockup helpers: SVG charts from static/fake data. No dependencies. */

// seeded rng → stable "live" data across reloads
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
}
function series(n, { base = 50, amp = 20, drift = 0, seed = 7, spikes = 0 } = {}) {
  const r = rng(seed);
  const out = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    v += (r() - 0.5) * amp + drift;
    v = Math.max(0, v);
    out.push(v + (spikes && r() > 0.985 ? spikes * r() : 0));
  }
  return out;
}
const fmt = (x, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

function svgEl(w, h) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  return svg;
}

/** sparkline: single series line + gradient fill */
function sparkline(el, data, { color = "var(--series-1)", fill = true, w = 240, h = 60, sw = 1.8 } = {}) {
  el.innerHTML = "";
  const max = Math.max(...data) * 1.15 || 1, min = Math.min(...data) * 0.9;
  const dx = w / (data.length - 1);
  const y = (v) => h - 3 - ((v - min) / (max - min || 1)) * (h - 6);
  let d = `M ${data.map((v, i) => `${(i * dx).toFixed(1)} ${y(v).toFixed(1)}`).join(" L ")}`;
  const svg = svgEl(w, h);
  if (fill) {
    const gid = "g" + Math.random().toString(36).slice(2, 8);
    const defs = document.createElementNS(ns2(), "defs");
    defs.innerHTML = `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${cssColor(color)}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${cssColor(color)}" stop-opacity="0"/></linearGradient>`;
    svg.appendChild(defs);
    const p = document.createElementNS(ns2(), "path");
    p.setAttribute("d", `${d} L ${w} ${h} L 0 ${h} Z`);
    p.setAttribute("fill", `url(#${gid})`);
    svg.appendChild(p);
  }
  const line = document.createElementNS(ns2(), "path");
  line.setAttribute("d", d);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", cssColor(color));
  line.setAttribute("stroke-width", sw);
  line.setAttribute("stroke-linejoin", "round");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(line);
  el.appendChild(svg);
}

function ns2() { return "http://www.w3.org/2000/svg"; }
function cssColor(c) {
  const s = getComputedStyle(document.documentElement);
  return c.startsWith("var(") ? s.getPropertyValue(c.slice(4, -1)).trim() || "#3b6ff5" : c;
}

/** multi-series area/line chart with hairline grid + last-value labels */
function areaChart(el, seriesList, { w = 720, h = 220, grid = true, labels = true, yFmt = (v) => Math.round(v) } = {}) {
  el.innerHTML = "";
  const svg = svgEl(w, h);
  const padB = 18, padT = 8;
  const all = seriesList.flatMap((s) => s.data);
  const max = Math.max(...all) * 1.12 || 1;
  const n = Math.max(...seriesList.map((s) => s.data.length));
  if (grid) {
    for (let i = 1; i <= 3; i++) {
      const gy = padT + ((h - padB - padT) / 4) * (4 - i);
      const gl = document.createElementNS(ns2(), "line");
      gl.setAttribute("x1", 0); gl.setAttribute("x2", w);
      gl.setAttribute("y1", gy); gl.setAttribute("y2", gy);
      gl.setAttribute("stroke", "rgba(255,255,255,0.05)");
      gl.setAttribute("stroke-width", "1");
      gl.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(gl);
      if (labels) {
        const t = document.createElementNS(ns2(), "text");
        t.setAttribute("x", 4); t.setAttribute("y", gy - 3);
        t.setAttribute("fill", "rgba(154,164,181,0.75)");
        t.setAttribute("font-size", "9");
        t.setAttribute("font-family", "JetBrains Mono, monospace");
        t.textContent = yFmt((max / 4) * i);
        svg.appendChild(t);
      }
    }
  }
  const dx = w / (n - 1);
  for (const s of seriesList) {
    const m = Math.max(...s.data);
    const y = (v) => h - padB - (v / max) * (h - padB - padT);
    let d = `M ${s.data.map((v, i) => `${(i * dx).toFixed(1)} ${y(v).toFixed(1)}`).join(" L ")}`;
    const gid = "a" + Math.random().toString(36).slice(2, 8);
    const defs = document.createElementNS(ns2(), "defs");
    defs.innerHTML = `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${cssColor(s.color)}" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="${cssColor(s.color)}" stop-opacity="0"/></linearGradient>`;
    svg.appendChild(defs);
    if (s.area !== false) {
      const p = document.createElementNS(ns2(), "path");
      p.setAttribute("d", `${d} L ${(s.data.length - 1) * dx} ${h - padB} L 0 ${h - padB} Z`);
      p.setAttribute("fill", `url(#${gid})`);
      svg.appendChild(p);
    }
    const line = document.createElementNS(ns2(), "path");
    line.setAttribute("d", d);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", cssColor(s.color));
    line.setAttribute("stroke-width", "1.8");
    line.setAttribute("stroke-linejoin", "round");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    if (s.dash) line.setAttribute("stroke-dasharray", "4 3");
    svg.appendChild(line);
  }
  el.appendChild(svg);
}

/** horizontal grouped bar chart (per-client breakdown) */
function hbars(el, rows, { unit = "", color = "var(--series-2)", max: mx } = {}) {
  el.innerHTML = "";
  const max = mx ?? Math.max(...rows.map((r) => r.value)) * 1.05;
  for (const r of rows) {
    const line = document.createElement("div");
    line.className = "hbar-row";
    line.innerHTML = `
      <div class="hbar-label">${r.label}</div>
      <div class="hbar-track"><i style="width:${(r.value / max) * 100}%;background:${cssColor(r.color || color)}"></i></div>
      <div class="hbar-val num">${fmt(r.value, r.d ?? 0)}${unit}</div>`;
    el.appendChild(line);
  }
}

/** legend chips for charts */
function legend(el, items) {
  el.innerHTML = items
    .map((i) => `<span class="lgd"><i style="background:${cssColor(i.color)}"></i>${i.label}</span>`)
    .join("");
}

/** fake realtime clock in topbar */
function startClock() {
  document.querySelectorAll("[data-clock]").forEach((el) => {
    const tick = () => (el.textContent = new Date().toLocaleTimeString("en-US", { hour12: false }));
    tick();
    setInterval(tick, 1000);
  });
}

const NAV = [
  { sec: "Fleet" },
  { id: "overview", label: "Overview", icon: "M3 13h4v8H3zM10 3h4v18h-4zM17 9h4v12h-4z" },
  { id: "node", label: "Nodes", icon: "M4 4h16v6H4zM4 14h16v6H4z", count: "3" },
  { sec: "AI Plane" },
  { id: "serve", label: "Serve", icon: "M8 6L3 12l5 6M16 6l5 6-5 6" },
  { id: "models", label: "Models", icon: "M12 2l9 5v10l-9 5-9-5V7z", count: "62" },
  { id: "analysis", label: "Analysis", icon: "M3 3v18h18M7 14l4-6 3 4 5-8" },
  { sec: "Control" },
  { id: "alerts", label: "Alerts", icon: "M12 3a6 6 0 016 6v4l2 4H4l2-4V9a6 6 0 016-6z", count: "2" },
  { id: "design-system", label: "Design system", icon: "M12 3l9 9-9 9-9-9z" },
];

function renderNav(active) {
  const host = document.querySelector(".sidebar");
  if (!host) return;
  host.innerHTML = `
    <div class="brand">
      <div class="brand-mark">${ICONS.bolt}</div>
      <div><b>ControlCenter</b><span class="env">home.local · v0.1-mock</span></div>
    </div>
    ${NAV.map((n) =>
      n.sec
        ? `<div class="nav-sec">${n.sec}</div>`
        : `<a class="nav-item ${n.id === active ? "active" : ""}" href="${n.id}.html">
             ${n.id === "design-system" ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${n.icon}"/></svg>`
               : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${n.icon}"/></svg>`}
             ${n.label}${n.count ? `<span class="count">${n.count}</span>` : ""}</a>`
    ).join("")}
    <div class="foot">
      <div class="avatar">BP</div>
      <div style="min-width:0">
        <div class="tiny" style="font-weight:600">piresbruno</div>
        <div class="tiny faint">admin · session ok</div>
      </div>
    </div>`;
}

const ICONS = {
  bolt: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>`,
};

document.addEventListener("DOMContentLoaded", startClock);

/* mobile off-canvas nav: inject hamburger into topbar, wire scrim + link close */
document.addEventListener("DOMContentLoaded", () => {
  const tb = document.querySelector(".topbar");
  const sb = document.querySelector(".sidebar");
  if (!tb || !sb) return;
  const scrim = document.createElement("div");
  scrim.id = "navScrim";
  document.body.appendChild(scrim);
  const close = () => { sb.classList.remove("open"); scrim.classList.remove("show"); };
  if (!tb.querySelector(".menu-btn")) {
    const b = document.createElement("button");
    b.className = "btn ghost sm menu-btn";
    b.setAttribute("aria-label", "Menu");
    b.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`;
    b.addEventListener("click", () => {
      const open = sb.classList.toggle("open");
      scrim.classList.toggle("show", open);
    });
    tb.prepend(b);
  }
  scrim.addEventListener("click", close);
  sb.addEventListener("click", (e) => { if (e.target.closest("a.nav-item")) close(); });
});
