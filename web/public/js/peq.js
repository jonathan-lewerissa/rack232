// Visual parametric EQ. Bands are found by the device's own display text (an "Hz" parameter
// followed by a "dB" and a "Q" one), and the curve is drawn from those
// values, so the graph shows what the device reports rather than what the app assumes.
// Manual 4.1 / 4.8: bands are 20 Hz..20 kHz, -12..+12 dB, Q 0.2..16; the post-crossover PEQ
// has a Type (Bell / LShelf / HShelf / LHShelf) that turns the outer bands into shelves.

export const FS = 48000; // 260 sample rate (manual, specifications)
export const F_MIN = 20;
export const F_MAX = 20000;
const DB_RANGE = 15; // graph spans +-15 dB so a few +12 dB bands still fit

// Raw value steps used while dragging, before the device reports the new text. Taken from the
// simulator and DriveWare's 24x bank (1/12 octave, 0.5 dB); check them on hardware. A wrong
// value only changes drag speed: the point settles where the device says once it answers.
export const STEP = { octaves: 1 / 12, dB: 0.5, qPx: 14 };

export const parseHz = (t) => {
  const m = /^\s*([\d.]+)\s*(k?)Hz\b/.exec(t ?? "");
  return m ? Number(m[1]) * (m[2] ? 1000 : 1) : null;
};
export const parseDb = (t) => {
  const m = /^\s*([+-]?[\d.]+)\s*dB\b/.exec(t ?? "");
  return m ? Number(m[1]) : null;
};
export const parseQ = (t) => {
  const m = /^\s*Q\s*([\d.]+)/.exec(t ?? "");
  return m ? Number(m[1]) : null;
};
const TYPES = ["Bell", "HShelf", "LShelf", "LHShelf"];

// The session clears p.text while a write is unconfirmed; keep drawing the last known text.
const lastText = new WeakMap();
export function textOf(p) {
  if (p.text != null) lastText.set(p, p.text);
  return lastText.get(p) ?? null;
}

export function findBands(params) {
  const bands = [];
  // A band starts with its frequency (manual and simulator order), then gain and Q in either order.
  for (let i = 0; i + 2 < params.length; ) {
    const freq = parseHz(textOf(params[i])) != null && params[i];
    const rest = params.slice(i + 1, i + 3);
    const gain = rest.find((p) => parseDb(textOf(p)) != null);
    const q = rest.find((p) => parseQ(textOf(p)) != null);
    if (freq && gain && q) {
      bands.push({ freq, gain, q });
      i += 3;
    } else i++;
  }
  const type = params.find((p) => TYPES.includes(textOf(p)?.trim()));
  return { bands, type };
}

// RBJ audio-EQ-cookbook biquads, magnitude in dB at frequency f.
export function bandDb(f, { hz, db, q, kind = "bell" }) {
  const A = 10 ** (db / 40);
  const w0 = (2 * Math.PI * hz) / FS;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let c;
  if (kind === "bell") {
    c = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  } else {
    const s = kind === "low" ? 1 : -1;
    const k = 2 * Math.sqrt(A) * alpha;
    c = [
      A * (A + 1 - s * (A - 1) * cos + k), 2 * s * A * (A - 1 - s * (A + 1) * cos), A * (A + 1 - s * (A - 1) * cos - k),
      A + 1 + s * (A - 1) * cos + k, -2 * s * (A - 1 + s * (A + 1) * cos), A + 1 + s * (A - 1) * cos - k,
    ];
  }
  const w = (2 * Math.PI * f) / FS;
  const mag2 = (c0, c1, c2) => {
    const re = c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
    const im = c1 * Math.sin(w) + c2 * Math.sin(2 * w);
    return re * re + im * im;
  };
  return 10 * Math.log10(mag2(c[0], c[1], c[2]) / mag2(c[3], c[4], c[5]));
}

export const xOf = (hz) => Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN);
export const hzOf = (x) => F_MIN * (F_MAX / F_MIN) ** x;
const yOf = (db) => 0.5 - db / (2 * DB_RANGE);
export const clamp01 = (v) => Math.min(1, Math.max(0, v));

export const svg = (tag, attrs = {}) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// bands from findBands(); write(param, raw) sends a value; limit(param) is the highest raw value;
// enabled() says whether the block's on/off switch is on.
export function peqGraph({ bands, type }, { write, limit, enabled }) {
  const W = 1000;
  const H = 300;
  const root = document.createElement("div");
  root.className = "peq";
  const plot = document.createElement("div");
  plot.className = "peq-plot";
  const graph = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = xOf(hz) * W;
    graph.append(svg("line", { x1: x, x2: x, y1: 0, y2: H, class: [100, 1000, 10000].includes(hz) ? "major" : "" }));
  }
  for (const db of [-12, -6, 0, 6, 12]) graph.append(svg("line", { x1: 0, x2: W, y1: yOf(db) * H, y2: yOf(db) * H, class: db ? "" : "major" }));
  const fill = svg("path", { class: "fill" });
  const curve = svg("path", { class: "curve" });
  graph.append(fill, curve);
  plot.append(graph);
  for (const [label, hz] of [["100", 100], ["1k", 1000], ["10k", 10000]]) {
    const t = document.createElement("span");
    t.className = "peq-axis x";
    t.textContent = label;
    t.style.left = `${xOf(hz) * 100}%`;
    plot.append(t);
  }
  for (const db of [12, 0, -12]) {
    const t = document.createElement("span");
    t.className = "peq-axis y";
    t.textContent = db > 0 ? `+${db}` : String(db);
    t.style.top = `${yOf(db) * 100}%`;
    plot.append(t);
  }

  const readout = document.createElement("output");
  readout.className = "peq-readout";
  let active = 0;
  const drag = new Map(); // band index -> { hz, db, q } shown until the device confirms

  const kindOf = (i) => {
    const t = textOf(type ?? {})?.trim();
    if (i === 0 && (t === "LShelf" || t === "LHShelf")) return "low";
    if (i === bands.length - 1 && (t === "HShelf" || t === "LHShelf")) return "high";
    return "bell";
  };
  const values = (b, i) => {
    const confirmed = b.freq.text != null && b.gain.text != null && b.q.text != null;
    if (confirmed) drag.delete(i);
    return drag.get(i) ?? { hz: parseHz(textOf(b.freq)), db: parseDb(textOf(b.gain)), q: parseQ(textOf(b.q)) };
  };

  const handles = bands.map((b, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "peq-handle";
    el.textContent = String(i + 1);
    let start = null;
    const set = (p, raw) => write(p, Math.max(0, Math.min(limit(p), raw)));
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, v: values(b, i), raw: [b.freq.value, b.gain.value, b.q.value] };
      select(i);
    });
    el.addEventListener("pointermove", (e) => {
      if (!start || !el.hasPointerCapture(e.pointerId)) return;
      const r = plot.getBoundingClientRect();
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (e.altKey) {
        const steps = Math.round(-dy / STEP.qPx);
        set(b.q, start.raw[2] + steps);
        drag.set(i, { ...start.v, q: start.v.q * 1.15 ** steps });
      } else {
        const hz = hzOf(clamp01(xOf(start.v.hz) + dx / r.width));
        const db = Math.max(-12, Math.min(12, start.v.db - (dy / r.height) * 2 * DB_RANGE));
        set(b.freq, start.raw[0] + Math.round(Math.log2(hz / start.v.hz) / STEP.octaves));
        set(b.gain, start.raw[1] + Math.round((db - start.v.db) / STEP.dB));
        drag.set(i, { hz, db, q: start.v.q });
      }
      update();
    });
    const end = () => (start = null);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      set(b.q, b.q.value + (e.deltaY < 0 ? 1 : -1));
      select(i);
    }, { passive: false });
    el.addEventListener("keydown", (e) => {
      const [p, d] = {
        ArrowLeft: [b.freq, -1], ArrowRight: [b.freq, 1],
        ArrowUp: [e.shiftKey ? b.q : b.gain, 1], ArrowDown: [e.shiftKey ? b.q : b.gain, -1],
      }[e.key] ?? [];
      if (!p) return;
      e.preventDefault();
      set(p, p.value + d);
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
    const vals = bands.map(values);
    const on = enabled();
    const ok = vals.every((v) => v.hz != null && v.db != null && v.q != null);
    const pts = [];
    for (let x = 0; x <= W; x += 4) {
      const f = hzOf(x / W);
      const db = ok && on ? vals.reduce((sum, v, i) => sum + bandDb(f, { ...v, kind: kindOf(i) }), 0) : 0;
      pts.push(`${x},${(clamp01(yOf(db)) * H).toFixed(1)}`);
    }
    curve.setAttribute("d", `M${pts.join("L")}`);
    fill.setAttribute("d", `M0,${yOf(0) * H}L${pts.join("L")}L${W},${yOf(0) * H}Z`);
    root.classList.toggle("bypassed", !on);
    handles.forEach((el, i) => {
      const v = vals[i];
      el.style.left = `${clamp01(xOf(v.hz ?? 1000)) * 100}%`;
      el.style.top = `${clamp01(yOf(v.db ?? 0)) * 100}%`;
      el.classList.toggle("active", i === active);
      el.classList.toggle("pending", drag.has(i));
      const desc = `${textOf(bands[i].freq) ?? "?"}, ${textOf(bands[i].gain) ?? "?"}, ${textOf(bands[i].q) ?? "?"}`;
      el.setAttribute("aria-label", `Band ${i + 1}${kindOf(i) === "bell" ? "" : ` (${kindOf(i)} shelf)`}: ${desc}. Arrows change frequency and gain, Shift+Up/Down changes Q.`);
    });
    const b = bands[active];
    readout.textContent = `Band ${active + 1} · ${textOf(b.freq) ?? "?"} · ${textOf(b.gain) ?? "?"} · ${textOf(b.q) ?? "?"}`;
    readout.classList.toggle("stale", drag.has(active));
  }

  const help = document.createElement("p");
  help.className = "muted small";
  help.textContent = "Drag a point for frequency and gain. Scroll or Alt-drag for Q. Arrow keys work too; Shift+Up/Down changes Q.";
  root.append(plot, readout, help);
  update();
  return { el: root, update, params: [...bands.flatMap((b) => [b.freq, b.gain, b.q]), ...(type ? [type] : [])] };
}
