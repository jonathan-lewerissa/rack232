// Visual crossover. Like the PEQ graph, filters are found by the device's own display text: a
// frequency parameter ("1.25 kHz", or "Out" when the filter is bypassed) next to a type parameter
// ("LR 24"). Manual 4.7: each output band has a high-pass and a low-pass filter, 20 Hz..20 kHz, of
// type BS (Bessel) 6/12/18/24, BW (Butterworth) 6/12/18/24 or LR (Linkwitz-Riley) 12/24/36/48
// dB/oct, plus a gain of -Inf..+20 dB. The exact text the 260 sends is not known yet, so the
// parsers below accept the obvious spellings.

import { F_MAX, F_MIN, STEP, clamp01, hzOf, parseDb, parseHz, svg, textOf, xOf } from "./peq.js";

const DB_TOP = 18;
const DB_BOTTOM = -54;
const yOf = (db) => (DB_TOP - db) / (DB_TOP - DB_BOTTOM);

const FAMILIES = { BS: "BS", BESSEL: "BS", BW: "BW", BUTTERWORTH: "BW", LR: "LR", "LINKWITZ-RILEY": "LR", LINKWITZ: "LR" };
export function parseSlope(t) {
  const m = /\b(BS|BW|LR|Bessel|Butterworth|Linkwitz(?:-Riley)?)\s*[-:]?\s*(\d+)/i.exec(t ?? "");
  if (!m) return null;
  const db = Number(m[2]);
  return db % 6 === 0 && db >= 6 && db <= 48 ? { family: FAMILIES[m[1].toUpperCase()], db } : null;
}
export const isOut = (t) => /^\s*(Out|Off|Bypass)\b/i.test(t ?? "");
const parseFreq = (t) => (isOut(t) ? "out" : parseHz(t));
const parseGain = (t) => (/^\s*-\s*Inf/i.test(t ?? "") ? -Infinity : parseDb(t));

function kindFromPrompt(prompt) {
  if (/\bHPF?\b|high[ -]?pass/i.test(prompt ?? "")) return "hp";
  if (/\bLPF?\b|low[ -]?pass/i.test(prompt ?? "")) return "lp";
  return null;
}

// Band name from a filter prompt: "Mid HPF Fc" -> "Mid".
const bandName = (prompt) =>
  (prompt ?? "").replace(/\s*\b(HPF?|LPF?|High[ -]?Pass|Low[ -]?Pass|Fc|Freq(uency)?|Type|Slope)\b.*$/i, "").trim();

export function findCrossover(params) {
  const bands = [];
  let band = null;
  const close = () => {
    if (band?.filters.length) bands.push(band);
    band = null;
  };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    const next = params[i + 1];
    const t = textOf(p);
    if (parseFreq(t) != null && next && parseSlope(textOf(next))) {
      const filter = { freq: p, slope: next, kind: kindFromPrompt(p.prompt) ?? kindFromPrompt(next.prompt) };
      if (band && (band.filters.length >= 2 || (filter.kind && band.filters.some((f) => f.kind === filter.kind)))) close();
      band ??= { filters: [], gain: null, name: bandName(p.prompt) };
      band.filters.push(filter);
      i++;
    } else if (band && parseGain(t) != null) {
      band.gain = p;
      close();
    }
  }
  close();
  // Filters whose prompt did not say HP or LP: in a pair the lower one is the high-pass; a lone
  // filter set to "Out" at its lowest value is taken as a high-pass, otherwise a low-pass.
  for (const b of bands) {
    const [a, c] = b.filters;
    if (c && !a.kind && c.kind) a.kind = c.kind === "hp" ? "lp" : "hp";
    if (c && a.kind && !c.kind) c.kind = a.kind === "hp" ? "lp" : "hp";
    if (c && !a.kind) {
      const fa = parseFreq(textOf(a.freq));
      const fc = parseFreq(textOf(c.freq));
      const aLow = fa === "out" ? a.freq.value === 0 : fc === "out" ? c.freq.value !== 0 : fa <= fc;
      [a.kind, c.kind] = aLow ? ["hp", "lp"] : ["lp", "hp"];
    }
    if (!c && !a.kind) a.kind = parseFreq(textOf(a.freq)) === "out" && a.freq.value === 0 ? "hp" : "lp";
    b.filters.sort((x, y) => (x.kind === "hp" ? -1 : 1) - (y.kind === "hp" ? -1 : 1));
  }
  bands.forEach((b, i) => (b.name ||= `Band ${i + 1}`));
  const filters = bands.reduce((n, b) => n + b.filters.length, 0);
  return { bands: filters >= 2 ? bands : [] };
}

// Analog prototype magnitudes. x = f/fc for a low-pass, fc/f for a high-pass.
const butterworthDb = (x, n) => -10 * Math.log10(1 + x ** (2 * n));
// Reverse Bessel polynomials (ascending powers), scaled so each order is -3 dB at fc.
const BESSEL = [null, [[1, 1], 1], [[3, 3, 1], 1.36165], [[15, 15, 6, 1], 1.75567], [[105, 105, 45, 10, 1], 2.11391]];
function besselDb(x, n) {
  const [c, k] = BESSEL[n];
  const w = x * k;
  let re = 0;
  let im = 0;
  c.forEach((ck, i) => {
    const m = ck * w ** i;
    [re, im] = [[re + m, im], [re, im + m], [re - m, im], [re, im - m]][i % 4];
  });
  return 20 * Math.log10(c[0] / Math.hypot(re, im));
}

export function filterDb(f, { kind, hz, family, db }) {
  if (hz === "out" || hz == null) return 0;
  const x = kind === "hp" ? hz / f : f / hz;
  const order = db / 6;
  if (family === "LR") return 2 * butterworthDb(x, order / 2);
  if (family === "BS" && BESSEL[order]) return besselDb(x, order);
  return butterworthDb(x, order);
}

// bands from findCrossover(); write(param, raw) sends a value; limit(param) is the highest raw value.
export function xoverGraph({ bands }, { write, limit }) {
  const W = 1000;
  const H = 300;
  const root = document.createElement("div");
  root.className = "peq xover";
  const plot = document.createElement("div");
  plot.className = "peq-plot";
  const graph = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = xOf(hz) * W;
    graph.append(svg("line", { x1: x, x2: x, y1: 0, y2: H, class: [100, 1000, 10000].includes(hz) ? "major" : "" }));
  }
  for (let db = 12; db >= -48; db -= 12) graph.append(svg("line", { x1: 0, x2: W, y1: yOf(db) * H, y2: yOf(db) * H, class: db ? "" : "major" }));
  const curves = bands.map((_, i) => {
    const fill = svg("path", { class: `fill band-${i % 6}` });
    const curve = svg("path", { class: `curve band-${i % 6}` });
    graph.append(fill, curve);
    return { fill, curve };
  });
  plot.append(graph);
  for (const [label, hz] of [["100", 100], ["1k", 1000], ["10k", 10000]]) {
    const t = document.createElement("span");
    t.className = "peq-axis x";
    t.textContent = label;
    t.style.left = `${xOf(hz) * 100}%`;
    plot.append(t);
  }
  for (const db of [12, 0, -24, -48]) {
    const t = document.createElement("span");
    t.className = "peq-axis y";
    t.textContent = db > 0 ? `+${db}` : String(db);
    t.style.top = `${yOf(db) * 100}%`;
    plot.append(t);
  }

  const readout = document.createElement("output");
  readout.className = "peq-readout";
  const filters = bands.flatMap((b, bi) => b.filters.map((f) => ({ ...f, band: bi })));
  let active = 0;
  const drag = new Map(); // filter index -> hz shown until the device confirms

  const edgeHz = (f) => (f.kind === "hp" ? F_MIN : F_MAX);
  const hzOfFilter = (f, i) => {
    if (f.freq.text != null) drag.delete(i);
    return drag.get(i) ?? parseFreq(textOf(f.freq));
  };
  const spec = (f, i) => ({ kind: f.kind, hz: hzOfFilter(f, i), ...(parseSlope(textOf(f.slope)) ?? { family: "BW", db: 12 }) });
  const gainOf = (b) => (b.gain ? parseGain(textOf(b.gain)) ?? 0 : 0);
  const bandDbAt = (bi, f) =>
    gainOf(bands[bi]) + filters.reduce((sum, flt, i) => (flt.band === bi ? sum + filterDb(f, spec(flt, i)) : sum), 0);
  const describe = (f) => `${f.kind === "hp" ? "High-pass" : "Low-pass"} ${textOf(f.freq) ?? "?"} ${textOf(f.slope) ?? "?"}`;

  const handles = filters.map((f, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `peq-handle xover-handle band-${f.band % 6}`;
    el.textContent = f.kind === "hp" ? "H" : "L";
    let start = null;
    const set = (p, raw) => write(p, Math.max(0, Math.min(limit(p), raw)));
    const stepSlope = (d) => {
      set(f.slope, f.slope.value + d);
      select(i);
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      const hz = hzOfFilter(f, i);
      start = { x: e.clientX, hz: typeof hz === "number" ? hz : edgeHz(f), raw: f.freq.value };
      select(i);
    });
    el.addEventListener("pointermove", (e) => {
      if (!start || !el.hasPointerCapture(e.pointerId)) return;
      const r = plot.getBoundingClientRect();
      const hz = hzOf(clamp01(xOf(start.hz) + (e.clientX - start.x) / r.width));
      set(f.freq, start.raw + Math.round(Math.log2(hz / start.hz) / STEP.octaves));
      drag.set(i, hz);
      update();
    });
    const end = () => (start = null);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      stepSlope(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    el.addEventListener("keydown", (e) => {
      const d = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 }[e.key];
      if (!d) return;
      e.preventDefault();
      if (e.key === "ArrowUp" || e.key === "ArrowDown") stepSlope(d);
      else set(f.freq, f.freq.value + d);
    });
    el.addEventListener("focus", () => select(i));
    plot.append(el);
    return el;
  });

  function select(i) {
    active = i;
    update();
  }

  function update() {
    bands.forEach((b, bi) => {
      const pts = [];
      for (let x = 0; x <= W; x += 4) {
        const db = bandDbAt(bi, hzOf(x / W));
        pts.push(`${x},${(clamp01(yOf(Number.isFinite(db) ? db : DB_BOTTOM - 1)) * H).toFixed(1)}`);
      }
      curves[bi].curve.setAttribute("d", `M${pts.join("L")}`);
      curves[bi].fill.setAttribute("d", `M0,${H}L${pts.join("L")}L${W},${H}Z`);
    });
    const pos = filters.map((f, i) => {
      const hz = hzOfFilter(f, i);
      const at = typeof hz === "number" ? hz : edgeHz(f);
      const db = bandDbAt(f.band, at);
      return { hz, x: clamp01(xOf(at)), y: clamp01(yOf(Number.isFinite(db) ? db : DB_BOTTOM)) };
    });
    handles.forEach((el, i) => {
      const f = filters[i];
      const { hz, x, y } = pos[i];
      // "Out" handles sit just inside the plot edge. A low-pass and a high-pass at the same point
      // (adjacent bands meeting) are pulled apart, low-pass to the left, so both stay grabbable.
      const twin = pos.some((q, j) => j !== i && filters[j].kind !== f.kind && Math.abs(q.x - x) < 0.02 && Math.abs(q.y - y) < 0.06);
      const dx = hz === "out" ? (f.kind === "hp" ? 14 : -14) : twin ? (f.kind === "hp" ? 13 : -13) : 0;
      el.style.left = `${x * 100}%`;
      el.style.top = `${y * 100}%`;
      el.style.translate = `${dx}px 0`;
      el.classList.toggle("active", i === active);
      el.classList.toggle("pending", drag.has(i));
      el.classList.toggle("out", hz === "out");
      el.setAttribute("aria-label", `${bands[f.band].name}: ${describe(f)}. Left/Right changes frequency, Up/Down changes filter type.`);
    });
    const f = filters[active];
    const b = bands[f.band];
    readout.textContent = `${b.name} · ${describe(f)}${b.gain ? ` · gain ${textOf(b.gain) ?? "?"}` : ""}`;
    readout.classList.toggle("stale", drag.has(active));
  }

  const legend = document.createElement("p");
  legend.className = "xover-legend small";
  bands.forEach((b, i) => {
    const s = document.createElement("span");
    s.className = `band-${i % 6}`;
    s.textContent = b.name;
    legend.append(s);
  });
  const help = document.createElement("p");
  help.className = "muted small";
  help.textContent = "Drag H (high-pass) or L (low-pass) sideways for frequency; past the edge is Out. Scroll or Up/Down steps the filter type (BS, BW, LR and slope).";
  root.append(plot, legend, readout, help);
  update();
  return {
    el: root,
    update,
    params: [...filters.flatMap((f) => [f.freq, f.slope]), ...bands.flatMap((b) => (b.gain ? [b.gain] : []))],
  };
}
