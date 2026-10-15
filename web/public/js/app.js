import { CTRL, FrameParser } from "./frame.js";
import { Link } from "./link.js";
import { MSG, MSG_INFO, decode, describeFields, hex, hexBytes, msgName, payload } from "./messages.js";
import { findBands, peqGraph } from "./peq.js";
import { UNKNOWN_MODEL } from "./models.js";
import { Network } from "./network.js";
import { SIM_MODELS, SimulatedDriveRack } from "./sim.js";
import { SerialTransport, createLoopback } from "./transport.js";
import { findCrossover, xoverGraph } from "./xover.js";

// Tiny DOM helper

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const $ = (id) => document.getElementById(id);
const addr = (n) => (n == null ? "?" : `0x${hex(n)}`);
const parseNum = (s) => {
  const v = Number(String(s).trim());
  return Number.isInteger(v) && v >= 0 ? v : null;
};

// Widget ranges by input type for the connected model (models.js). The device does not report
// ranges, so other types get a plain stepper.
const rangeOf = (inputType) => (model()?.profile ?? UNKNOWN_MODEL).ranges[inputType];

// Connection state

let ctx = null; // { transport, link?, network?, sim?, kind }
let selectedFx = 0;
const drafts = { deviceName: null, programName: null }; // text being typed survives re-renders
const log = createLog();

async function connectSerial() {
  if (!SerialTransport.supported) {
    alert("This browser has no Web Serial API. Use Chrome or Edge on desktop.");
    return;
  }
  const transport = new SerialTransport();
  try {
    const info = await transport.open({ baudRate: Number($("opt-baud").value) });
    log.note(`Opened serial port ${info.usbVendorId ? `USB ${hex(info.usbVendorId, 4)}:${hex(info.usbProductId, 4)}` : ""} at ${$("opt-baud").value} 8N1`);
  } catch (err) {
    if (err.name !== "NotFoundError") alert(`Could not open the port: ${err.message}`);
    return;
  }
  transport.onClose((why) => {
    if (ctx?.transport === transport) teardown(`Serial port ${why}.`);
  });
  start(transport, { kind: "serial", passive: $("opt-passive").checked });
}

function runSimulator() {
  const noise = $("opt-sim-noise").checked;
  const corrupt = noise
    ? (bytes) => bytes.map((b) => (Math.random() < 1 / 400 ? b ^ (1 << Math.floor(Math.random() * 8)) : b))
    : null;
  const [hostEnd, devEnd] = createLoopback({ bytesPerMs: $("opt-sim-baud").checked ? 3.84 : Infinity, corrupt });
  const units = Math.max(1, Math.min(8, parseNum($("opt-sim-units").value) ?? 1));
  const sim = new SimulatedDriveRack(devEnd, { model: $("opt-sim-model").value, units, remote: units > 1 });
  const what = sim.network ? `${sim.profile.name} network (${units} unit${units > 1 ? "s" : ""}${units > 1 ? " and a 480R remote" : ""})` : sim.profile.name;
  log.note(`Simulated ${what} started${noise ? " with line noise" : ""}. Its signal chain is invented, not captured from a device.`);
  start(hostEnd, { kind: "simulator", sim });
}

function start(transport, { kind, passive = false, sim = null }) {
  ctx = { transport, kind, sim };
  if (passive) {
    const parser = new FrameParser({
      onControl: (b) => log.ctrl("rx", b),
      onFrame: (f) => log.frame("rx", f),
    });
    transport.onData((bytes) => parser.push(bytes));
    setStatus("Listening only. Nothing is sent; incoming bytes appear in the traffic log.");
    setPill("listening", "Listening");
  } else {
    const link = new Link({ write: (b) => transport.write(b) });
    transport.onData((bytes) => link.feed(bytes));
    link.on("tx", (bytes, info) => (info.ctrl != null ? log.ctrl("tx", info.ctrl, bytes.length) : log.frame("tx", parseOne(bytes), info.resend)));
    link.on("rxctrl", (b) => log.ctrl("rx", b));
    link.on("rxframe", (f, { duplicate }) => log.frame("rx", f, false, duplicate));
    link.on("state", (state, reason) => {
      setPill(state, { idle: "Linking…", active: "Linked", stopped: "Disconnected" }[state]);
      if (reason) log.note(`Link ${state}: ${reason}`);
    });
    const network = new Network(link, {
      fallbackHostAddr: parseNum($("opt-host").value) ?? 0,
      fallbackDeviceAddr: parseNum($("opt-dev").value) ?? 1,
    });
    network.on("status", setStatus);
    network.on("change", onNetworkChange);
    network.on("session-status", (s, text) => s === session() && setStatus(text));
    network.on("session-change", (s, kind, detail) => {
      if (s === session()) onModelChange(kind, detail);
      else if (kind === "model") queueRender("side"); // names and models in the unit list
    });
    ctx.link = link;
    ctx.network = network;
    link.start();
    setStatus(`Sending hello (16 × FF every 250 ms) and waiting for the ${kind === "simulator" ? "simulator" : "DriveRack"}…`);
  }
  selectedFx = 0;
  updateButtons();
  renderAll();
}

async function disconnect() {
  teardown("Disconnected.");
}

function teardown(message) {
  if (!ctx) return;
  const { link, sim, transport } = ctx;
  ctx = null;
  link?.stop();
  sim?.stop();
  transport.close();
  setPill("stopped", "Disconnected");
  setStatus(message);
  log.note(message);
  updateButtons();
  renderAll();
}

function updateButtons() {
  $("connect-group").hidden = !!ctx;
  $("btn-disconnect").hidden = !ctx;
  $("btn-serial").title = SerialTransport.supported ? "" : "Web Serial is not available in this browser";
}

function setPill(state, text) {
  $("link-pill").dataset.state = state;
  $("link-pill").textContent = text;
}

function setStatus(text) {
  $("status").textContent = text;
  $("spinner").hidden = !session()?.busy;
}

function parseOne(bytes) {
  let frame = null;
  new FrameParser({ onControl() {}, onFrame: (f) => (frame = f) }).push(bytes);
  return frame;
}

// Run an action and surface failures instead of losing them in a rejected promise.
function act(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      setStatus(err.message);
      log.note(`Error: ${err.message}`);
    }
  };
}

// Rendering

let renderQueued = new Set();
let shownSession = null;

function queueRender(...what) {
  for (const w of what) renderQueued.add(w);
  if (!renderQueued.scheduled) {
    renderQueued.scheduled = true;
    requestAnimationFrame(flushRender);
  }
}

// Units appeared or went away, or another unit was selected.
function onNetworkChange() {
  if (session() !== shownSession) {
    shownSession = session();
    selectedFx = 0;
    drafts.deviceName = drafts.programName = null;
    if (shownSession?.status) setStatus(shownSession.status);
  }
  queueRender("side", "chain");
}

function onModelChange(kind, detail) {
  if (kind === "param") {
    if (detail.fx === selectedFx) updateParamRow(detail.fx, detail.param);
    const chip = $("chain").querySelector(`[data-fx="${detail.fx}"]`);
    if (chip) paintChip(chip, model().fx[detail.fx]);
    return;
  }
  if (kind === "busy") $("spinner").hidden = !session()?.busy;
  if (kind !== "fx") renderQueued.add("side");
  if (kind === "fx" || kind === "all" || kind === "supports" || kind === "busy" || (kind === "model" && ("fxCount" in detail || "profile" in detail)))
    renderQueued.add("chain");
  queueRender();
}

function flushRender() {
  const q = renderQueued;
  renderQueued = new Set();
  if (q.has("side")) renderSidebar();
  if (q.has("chain")) {
    renderChain();
    renderBlock();
  }
}

function renderAll() {
  renderSidebar();
  renderChain();
  renderBlock();
}

function renderSidebar() {
  renderDevice();
  renderOutputs();
  renderPrograms();
}

const session = () => ctx?.network?.selected ?? null;
const model = () => session()?.model ?? null;

function kv(label, value, title, cls = "kv") {
  return h("div", { class: cls, title }, h("span", { class: "k" }, label), h("span", { class: "v" }, value ?? "?"));
}

// Units found on the link. Shown when there is more than one address, i.e. a 48x/442 network.
function unitList() {
  const net = ctx?.network;
  if (!net || net.addresses.length < 2) return null;
  const busy = !!session()?.busy;
  return h("ol", { class: "program-list unit-list", "aria-label": "Units on this link" },
    net.nodes.map(({ addr: a, label, session: s }) => {
      const current = s && s === session();
      const what = s ? [s.model.model ?? "…", s.model.deviceName].filter(Boolean).join(" · ") : "not editable";
      return h("li", { class: current ? "current" : "" },
        h("button", {
          class: "link", disabled: !s || current || busy,
          title: s ? (current ? "Unit being edited" : "Edit this unit") : "Only DriveRack units (ID 0-99) can be edited",
          onclick: () => net.select(a),
        }, h("span", { class: "num" }, addr(a)), h("span", { class: "pname" }, h("b", {}, label), " ", h("small", {}, what))));
    }));
}

function renderDevice() {
  const m = model();
  const el = $("device-card");
  el.replaceChildren(h("h2", {}, ctx?.network?.addresses.length > 1 ? "Network" : "Device"));
  const units = unitList();
  if (units) el.append(units);
  if (!m) {
    el.append(h("p", { class: "muted" }, !ctx ? "Connect a DriveRack over a null-modem cable, or run the simulator."
      : ctx.network ? "Waiting for a unit to identify itself…" : "Listening only."));
    return;
  }
  const p = m.profile;
  const yesNo = (v) => (v === true ? "yes" : v === false ? "no reply" : "not asked yet");
  const nameInput = h("input", {
    value: drafts.deviceName ?? m.deviceName ?? "", maxlength: 16, "aria-label": "Device name", disabled: m.deviceName == null,
    oninput: (e) => (drafts.deviceName = e.target.value),
  });
  el.append(
    kv("Model", m.model, null, "kv big"),
    kv("Firmware", m.firmware, p.firmware && m.firmware && p.firmware !== m.firmware
      ? `DriveWare 2.6.2 was built for firmware ${p.firmware}; other versions may differ` : null),
    h("form", { class: "inline-form", onsubmit: act(async (e) => { e.preventDefault(); drafts.deviceName = null; await session().renameDevice(nameInput.value); }) },
      h("span", { class: "k" }, "Name"), nameInput, h("button", { disabled: m.deviceName == null }, "Rename")),
    h("details", { class: "supports" }, h("summary", {}, "Link details"),
      kv("Addresses", m.hostAddr == null ? null : `host ${addr(m.hostAddr)} · device ${addr(m.deviceAddr)}`,
        { fallback: "No NETWORK_IDENTIFY or DID_CONFIG received; using the fallback addresses from Options",
          identify: "From NETWORK_IDENTIFY", network: "From the network master's NETWORK_DID_CONFIG" }[m.addressesFrom]),
      kv("Address source", m.addressesFrom),
      kv("Model family", p.family, "Models DriveWare handles alike (re/PROTOCOL.md 4.1)"),
      kv("DriveWare built for", p.firmware && `firmware ${p.firmware}`),
      kv("Protocol gen.", m.generation ?? (m.addressesFrom === "network" ? "not sent on a network" : null)),
      kv("Utility block", m.utilityBytes == null ? null
        : `${m.utilityBytes} bytes (${m.utilityLayout ?? "unknown"} layout${m.securityLevel != null ? `, security level ${m.securityLevel}` : ""})`,
        p.utility && m.utilityBytes != null && p.utility !== m.utilityBytes ? `DriveWare expects ${p.utility} bytes from this model` : null),
      h("h3", {}, "Optional requests answered"),
      kv("Input type (0x97)", yesNo(m.supports.inputType)),
      kv("Prompt (0x99)", yesNo(m.supports.prompt)),
      kv("Value text (0xA3)", yesNo(m.supports.valueText))),
  );
  if (m.errors.length) {
    el.append(h("div", { class: "errors" }, m.errors.slice(-4).map((e) => h("div", {}, `${e.at.toLocaleTimeString()} ${e.text}`))));
  }
}

function renderOutputs() {
  const m = model();
  const el = $("outputs-card");
  el.replaceChildren(h("h2", {}, "Outputs"));
  paintMuteLeds();
  if (!m) {
    el.append(h("p", { class: "muted" }, ctx ? "Mute state is not read in listen-only mode." : "Mute switches appear after connecting."));
    return;
  }
  const busy = m.muteMask == null;
  const outputs = outputCount(m);
  const grid = h("div", { class: "mute-grid" });
  grid.style.gridTemplateColumns = `repeat(${outputs % 3 === 0 ? 3 : Math.min(outputs, 4)}, 1fr)`;
  for (let i = 0; i < outputs; i++) {
    const muted = !!(m.muteMask & (1 << i));
    grid.append(h("button", {
      class: `mute ${muted ? "on" : ""}`,
      "aria-pressed": String(muted),
      disabled: busy,
      onclick: act(() => session().setMute(i, !muted)),
    }, h("span", {}, `Out ${i + 1}`), h("small", { class: "led" }, muted ? "MUTED" : "ON")));
  }
  el.append(grid, h("p", { class: "muted small" }, "Mute bit order is inferred: bit 0 = Out 1."), h("button", {
    class: `mute system ${m.systemMute ? "on" : ""}`,
    "aria-pressed": String(!!m.systemMute),
    disabled: m.systemMute == null,
    onclick: act(() => session().setSystemMute(!m.systemMute)),
  }, m.systemMute ? "System muted. Click to unmute" : "Mute all outputs"));
}

// From the model table; for an unknown model, from the highest output channel in the chain.
function outputCount(m) {
  if (m.profile.outputs) return m.profile.outputs;
  const chans = m.fx.map((b) => b.out).filter((c) => c != null);
  return chans.length ? Math.min(8, Math.max(...chans) + 1) : 6;
}

function renderPrograms() {
  const m = model();
  const el = $("programs-card");
  el.replaceChildren(h("h2", {}, "Programs"));
  if (!m) {
    el.append(h("p", { class: "muted" }, ctx ? "Programs are not read in listen-only mode." : "The program list loads after connecting."));
    return;
  }
  // 260 manual 3.4 / A.6: programs 1-25 are User, 26-50 Factory (read-only; from the factory the
  // user programs are copies of them). The wire index is taken as the panel number minus one and
  // the first GLOBAL_DATA count as the user count (inferred, see re/PROTOCOL.md 4.2), for every model.
  const users = m.counts?.a ?? m.programs.length;
  if (m.counts) el.append(h("p", { class: "muted small" }, `${m.counts.a} user + ${m.counts.b} factory programs (global data ${m.counts.a}/${m.counts.b}/${m.counts.c})`));
  const busy = !!session().busy;
  const list = h("ol", { class: "program-list", start: 1 });
  m.programs.forEach((name, n) => {
    const current = n === m.currentProgram;
    if (n === 0 || n === users) list.append(h("li", { class: "group", "aria-hidden": "true" }, n === 0 ? "User" : "Factory"));
    list.append(h("li", { class: current ? "current" : "" },
      h("button", {
        class: "link",
        disabled: busy || current,
        title: current ? "Current program" : "Retrieve and load this program",
        onclick: act(() => session().loadProgram(n)),
      },
      h("span", { class: "num", title: n < users ? "User program" : "Factory program (read-only)" }, String(n + 1)),
      h("span", { class: "pname" }, name == null ? "…" : name || "(empty)"))));
  });
  el.append(list);

  // Store: user slots only. The 260 redirects a store aimed at factory program 26-50 to user 1-25.
  const slots = m.programs.map((name, n) => ({ name, n })).filter(({ n }) => n < users);
  if (!slots.length) return;
  const slot = h("select", { "aria-label": "User program slot" },
    slots.map(({ name, n }) => h("option", { value: n, selected: n === m.currentProgram }, `${n + 1} ${name || "(empty)"}`)));
  const name = h("input", {
    placeholder: "Program name", maxlength: 16, required: true, value: drafts.programName ?? m.currentName ?? "",
    oninput: (e) => (drafts.programName = e.target.value),
  });
  el.append(h("form", {
    class: "store-form",
    onsubmit: act(async (e) => {
      e.preventDefault();
      const n = Number(slot.value);
      const existing = m.programs[n];
      if (existing && !confirm(`Overwrite user program ${n + 1} “${existing}” on the device?`)) return;
      drafts.programName = null;
      await session().storeProgram(n, name.value.trim());
    }),
  }, h("h3", {}, "Store current settings"), slot, name, h("button", { disabled: busy }, "Store")));
}

// Signal flow, drawn like the manual's block diagram (A.7): input lanes, the routing block, then
// one lane per output strip. Everything comes from each block's in/out channels; until those are
// known, or if the chain has no output strips, the blocks fall back to a plain row.
function renderChain() {
  const m = model();
  const el = $("chain");
  const focused = document.activeElement?.dataset?.fx;
  el.replaceChildren();
  el.hidden = !m;
  if (!m || !m.fx.length) {
    if (m) el.append(h("p", { class: "muted" }, m.fxCount == null ? "Waiting for the signal chain…" : "No blocks reported."));
    return;
  }
  if (selectedFx >= m.fx.length) selectedFx = 0;
  const { input, strips } = m.fx.some((b) => b.in == null) ? { input: [], strips: [] } : splitChain(m.fx);
  if (!strips.length) {
    el.append(h("div", { class: "chain-row" }, m.fx.map((b) => blockButton(b, b.name ?? `Block ${b.index + 1}`, true))));
  } else {
    const jack = () => h("span", { class: "jack", "aria-hidden": "true" });
    const stub = () => h("span", { class: "stub" }); // a bit of wire into and out of the routing block
    // The last block before the strips (the crossover) is where the inputs split into outputs,
    // so it is drawn as one tall block between the two sides.
    // ponytail: picked by position, not type; check against a real device's chain.
    const router = input.length > 1 && input.pop();
    el.append(h("div", { class: "flow" },
      h("div", { class: "flow-section" }, h("h3", {}, "Inputs"),
        laneGrid(input, { start: (ch) => h("span", { class: "lane-cap" }, `In ${ch + 1}`, jack()), end: router && stub })),
      router && h("div", { class: "flow-section router" }, h("h3", {}, "Routing"),
        blockButton(router, router.name ?? `Block ${router.index + 1}`)),
      h("div", { class: "flow-section" }, h("h3", {}, "Outputs"),
        laneGrid(strips.flat(), {
          start: router && stub,
          end: (ch, name) => h("span", { class: "lane-cap" },
            h("span", { class: "lane-led", "data-out": ch, title: "Mute state (bit order inferred)" }), jack(),
            h("span", {}, h("b", {}, `Out ${ch + 1}`), name && h("small", {}, name))),
        }))));
    paintMuteLeds();
  }
  if (focused != null) el.querySelector(`[data-fx="${focused}"]`)?.focus();
}

// Output strips are the trailing runs of equal length, one per output channel, in channel
// order (PEQ, Limiter, Delay, Output in the simulator). Everything before them is the input side.
// ponytail: shape inferred from in/out only; returns no strips when the chain does not fit it.
function splitChain(fx) {
  const last = fx.at(-1);
  let len = 1;
  while (len < fx.length && fx.at(-1 - len).out === last.out) len++;
  const strips = [];
  let end = fx.length;
  while (end - len >= 0) {
    const run = fx.slice(end - len, end);
    const ch = run[0].out;
    if (!run.every((b) => b.in === ch && b.out === ch)) break;
    if (strips.length && ch !== strips[0][0].out - 1) break;
    strips.unshift(run);
    end -= len;
  }
  return len >= 2 && strips.length >= 2 ? { input: fx.slice(0, end), strips } : { input: fx, strips: [] };
}

// One grid row per channel, blocks packed left to right in device order. A block whose in and
// out channels differ spans the rows between them. A lane whose blocks share a name suffix
// ("PEQ Low L", "Delay Low L") shows the suffix once on the lane instead.
function laneGrid(blocks, { start, end }) {
  const chans = [...new Set(blocks.flatMap((b) => [b.in, b.out]))].sort((a, b) => a - b);
  const row = new Map(chans.map((c, i) => [c, i]));
  const next = chans.map(() => 0);
  const suffix = chans.map((c) => commonSuffix(blocks.filter((b) => b.in === c && b.out === c).map((b) => b.name ?? "")));
  const offset = start ? 2 : 1;
  const cells = blocks.map((b) => {
    const [r0, r1] = [row.get(Math.min(b.in, b.out)), row.get(Math.max(b.in, b.out))];
    const col = Math.max(...next.slice(r0, r1 + 1));
    next.fill(col + 1, r0, r1 + 1);
    const name = b.name ?? `Block ${b.index + 1}`;
    const s = b.in === b.out && suffix[r0];
    const el = blockButton(b, s ? name.slice(0, -s.length).trim() : name);
    el.style.gridRow = `${r0 + 1} / span ${r1 - r0 + 1}`;
    el.style.gridColumn = String(col + offset);
    return el;
  });
  const cols = Math.max(...next);
  const grid = h("div", { class: "lanes" });
  grid.style.gridTemplateColumns = `${start ? "max-content " : ""}repeat(${cols}, minmax(var(--block-min), 1fr))${end ? " max-content" : ""}`;
  chans.forEach((c, i) => {
    const wire = h("div", { class: "wire" });
    wire.style.gridRow = String(i + 1);
    grid.append(wire);
    for (const [cap, colStart] of [[start, 1], [end, cols + offset]]) {
      if (!cap) continue;
      const el = cap(c, suffix[i]);
      el.style.gridRow = String(i + 1);
      el.style.gridColumn = String(colStart);
      grid.append(el);
    }
  });
  grid.append(...cells);
  return grid;
}

function commonSuffix(names) {
  if (names.length < 2) return "";
  const words = names.map((n) => n.split(" "));
  const out = [];
  for (let i = 1; words.every((w) => w.length > i && w.at(-i) === words[0].at(-i)); i++) out.unshift(words[0].at(-i));
  return out.join(" ");
}

function blockButton(b, label, withRouting = false) {
  const el = h("button", {
    class: `chip ${b.index === selectedFx ? "selected" : ""}`,
    "aria-pressed": String(b.index === selectedFx),
    "data-fx": b.index,
    title: b.name ?? "",
    onclick: () => selectBlock(b.index),
  }, h("span", { class: "chip-name" }, label), h("span", { class: "chip-meta" }));
  el.withRouting = withRouting;
  paintChip(el, b);
  return el;
}

// A block whose first on/off parameter is 0 is drawn bypassed (dashed outline).
function paintChip(el, b) {
  const off = b.params.find((p) => rangeOf(p.inputType)?.toggle)?.value === 0;
  el.classList.toggle("off", off);
  el.querySelector(".chip-meta").textContent =
    `${el.withRouting && b.in != null ? `in ${b.in + 1} → out ${b.out + 1} · ` : ""}${off ? "off · " : ""}${b.params.length} param${b.params.length === 1 ? "" : "s"}`;
}

function paintMuteLeds() {
  const m = model();
  for (const led of document.querySelectorAll(".lane-led")) {
    led.classList.toggle("on", !!m && (!!m.systemMute || !!(m.muteMask & (1 << Number(led.dataset.out)))));
  }
}

function selectBlock(fx) {
  selectedFx = fx;
  renderChain();
  renderBlock();
  const editor = $("block-editor");
  if (editor.getBoundingClientRect().top > innerHeight - 80) {
    editor.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
}

const rowUpdaters = new Map(); // "fx:param" -> [update functions]
const addUpdater = (key, fn) => rowUpdaters.set(key, [...(rowUpdaters.get(key) ?? []), fn]);
let graphShown = false;

// Blocks that get a graph: PEQ bands or crossover filters, recognised by the device display text.
const hasGraph = (params) => findBands(params).bands.length > 0 || findCrossover(params).bands.length > 0;

function renderBlock() {
  const m = model();
  const el = $("block-editor");
  rowUpdaters.clear();
  el.replaceChildren();
  const b = m?.fx[selectedFx];
  if (!m) {
    el.hidden = false;
    el.append(h("div", { class: "empty" },
      h("h2", {}, ctx ? "Listening only" : "No device connected"),
      h("p", { class: "muted" }, ctx
        ? "Nothing is sent in this mode. Incoming bytes appear in the traffic log below."
        : "Connect a DriveRack (480, 481, 482, 442, 240, 241, 260 or 220i) with a null-modem DB-9 cable (38400 8N1), or run the simulator to try the editor. The signal flow appears here once the chain has been read."),
      !ctx && h("button", { onclick: runSimulator }, "Run simulator")));
    return;
  }
  if (!b) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.append(h("header", { class: "block-head" },
    h("div", {},
      h("h2", {}, b.name ?? `Block ${b.index + 1}`),
      h("p", { class: "muted small" },
        `FX ${b.index} · type ${b.type == null ? "?" : `0x${hex(b.type)}`} · descriptor ${b.descriptor ? hexBytes(b.descriptor) : "?"}`)),
    h("button", { disabled: !!session().busy, onclick: act(() => session().refreshFx(b.index)) }, "Re-read from device")));

  const faders = b.params.filter((p) => rangeOf(p.inputType)?.fader);
  if (faders.length >= 8) {
    const bank = h("div", { class: "fader-bank" });
    for (const p of faders) bank.append(faderStrip(b.index, p));
    el.append(h("div", { class: "fader-scroll" }, bank));
  }
  const peq = findBands(b.params);
  const xover = peq.bands.length ? { bands: [] } : findCrossover(b.params);
  graphShown = peq.bands.length > 0 || xover.bands.length > 0;
  if (xover.bands.length) {
    const graph = xoverGraph(xover, {
      write: (p, v) => session()?.setParam(b.index, p.index, v),
      limit: (p) => rangeOf(p.inputType)?.max ?? 65535,
    });
    el.append(graph.el);
    for (const p of graph.params) addUpdater(`${b.index}:${p.index}`, graph.update);
  }
  if (peq.bands.length) {
    const sw = b.params.find((p) => rangeOf(p.inputType)?.toggle);
    const graph = peqGraph(peq, {
      write: (p, v) => session()?.setParam(b.index, p.index, v),
      limit: (p) => rangeOf(p.inputType)?.max ?? 65535,
      enabled: () => sw?.value !== 0,
    });
    el.append(graph.el);
    for (const p of [...graph.params, ...(sw ? [sw] : [])]) addUpdater(`${b.index}:${p.index}`, graph.update);
  }
  const rest = faders.length >= 8 ? b.params.filter((p) => !faders.includes(p)) : b.params;
  if (rest.length) {
    el.append(h("table", { class: "params" },
      h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Parameter"), h("th", {}, "Value"), h("th", {}, "Device shows"), h("th", { title: "PARAM_REPLY_INPUT_TYPE" }, "Type"))),
      h("tbody", {}, rest.map((p) => paramRow(b.index, p)))));
  }
}

function paramRow(fx, p) {
  const range = rangeOf(p.inputType);
  const readout = h("span");
  const text = h("td", { class: "devtext" }, readout);
  const raw = h("span", { class: "raw" });
  let control;
  const write = (v) => session()?.setParam(fx, p.index, v);

  if (range?.toggle) {
    control = h("input", { type: "checkbox", class: "switch", onchange: (e) => write(e.target.checked ? 1 : 0), "aria-label": p.prompt ?? `Parameter ${p.index}` });
  } else if (range) {
    control = h("input", { type: "range", min: 0, max: range.max, step: 1, oninput: (e) => write(Number(e.target.value)), "aria-label": p.prompt ?? `Parameter ${p.index}` });
  } else {
    const num = h("input", {
      type: "number", min: 0, max: 65535, class: "num", onchange: (e) => write(clamp(Number(e.target.value))), "aria-label": p.prompt ?? `Parameter ${p.index}`,
      onkeydown: (e) => {
        const d = { PageUp: 10, PageDown: -10 }[e.key];
        if (d) {
          e.preventDefault();
          write(clamp((p.value ?? 0) + d));
        }
      },
    });
    const step = (d) => (e) => write(clamp((p.value ?? 0) + d * (e.shiftKey ? 10 : 1)));
    control = h("span", { class: "stepper", title: "Range unknown for this input type. Shift-click or Page Up/Down steps by 10." },
      h("button", { type: "button", onclick: step(-1), "aria-label": "Decrease" }, "−"), num,
      h("button", { type: "button", onclick: step(1), "aria-label": "Increase" }, "+"));
  }
  const row = h("tr", {},
    h("td", { class: "muted" }, p.index),
    h("td", {}, p.prompt ?? h("span", { class: "muted" }, `Parameter ${p.index}`)),
    h("td", { class: "control" }, control, raw),
    text,
    h("td", { class: "muted small" }, p.inputType == null ? "?" : `0x${hex(p.inputType)}`));

  const update = () => {
    const input = control.matches("input") ? control : control.querySelector("input");
    if (document.activeElement !== input || input.type !== "range") {
      if (input.type === "checkbox") input.checked = !!p.value;
      else input.value = p.value ?? "";
    }
    raw.textContent = p.value == null ? "" : `= ${p.value}`;
    showReadout(readout, p, p.text ?? "");
  };
  update();
  addUpdater(`${fx}:${p.index}`, update);
  return row;
}

function faderStrip(fx, p) {
  const range = rangeOf(p.inputType);
  const label = (p.prompt ?? `#${p.index}`).replace(/ Hz$/, "");
  const text = h("output", { class: "fader-text" });
  const centre = () => {
    input.value = range.max / 2;
    session()?.setParam(fx, p.index, range.max / 2);
  };
  const input = h("input", {
    type: "range", min: 0, max: range.max, step: 1, class: "vfader",
    "aria-label": p.prompt ?? `Parameter ${p.index}`,
    oninput: (e) => session()?.setParam(fx, p.index, Number(e.target.value)),
    ondblclick: centre,
    onkeydown: (e) => e.key === "0" && centre(),
    title: "Double-click or press 0 to centre",
  });
  const update = () => {
    if (document.activeElement !== input) input.value = p.value ?? 0;
    showReadout(text, p, p.text?.replace(/\s*dB$/, "") ?? "");
  };
  update();
  addUpdater(`${fx}:${p.index}`, update);
  return h("div", { class: "fader", title: p.prompt ?? "" }, text, input, h("span", { class: "fader-label" }, label));
}

// The session clears p.text on every write until the device's reply arrives. Keep the last
// device text on screen, dimmed, instead of blanking it on every fader move.
function showReadout(el, p, text) {
  const pending = p.text == null && p.value != null;
  if (!pending || !el.textContent) el.textContent = text;
  el.classList.toggle("stale", pending && !!el.textContent);
}

function updateParamRow(fx, param) {
  const updates = rowUpdaters.get(`${fx}:${param}`);
  // The graphs need the device's display text; draw them once that text has arrived.
  if (!updates || (!graphShown && hasGraph(model().fx[fx].params))) renderBlock();
  else for (const update of updates) update();
}

const clamp = (v) => Math.max(0, Math.min(65535, Math.round(Number.isFinite(v) ? v : 0)));

// Traffic log

function createLog() {
  const MAX_ROWS = 1500;
  const entries = [];
  const body = $("log-body");
  const t0 = performance.now();
  let lastCtrl = null;
  const stats = { tx: 0, rx: 0 };

  const visible = (e) => {
    if (e.kind !== "ctrl") return true;
    if (e.byte === CTRL.KEEPALIVE) return $("log-keepalive").checked;
    return $("log-ctrl").checked;
  };

  function add(e) {
    e.t = performance.now() - t0;
    entries.push(e);
    if (entries.length > 20000) entries.splice(0, 5000);
    if (visible(e)) appendRow(e);
    $("log-stats").textContent = `${stats.tx} frames sent · ${stats.rx} received`;
  }

  function appendRow(e) {
    e.row = h("div", { class: `log-row ${e.dir} ${e.kind} ${e.bad ? "bad" : ""}` },
      h("span", { class: "t" }, (e.t / 1000).toFixed(3)),
      h("span", { class: "dir" }, e.dir === "tx" ? "→" : e.dir === "rx" ? "←" : "•"),
      h("span", { class: "what" }, e.summary),
      h("span", { class: "bytes" }, e.hex ?? ""));
    body.append(e.row);
    while (body.childElementCount > MAX_ROWS) body.firstElementChild.remove();
    if ($("log-autoscroll").checked) body.scrollTop = body.scrollHeight;
  }

  const CTRL_NAMES = { [CTRL.ACK]: "ACK", [CTRL.NAK]: "NAK", [CTRL.HELLO]: "HELLO", [CTRL.RESYNC]: "RESYNC", [CTRL.KEEPALIVE]: "keepalive" };

  return {
    ctrl(dir, byte, count = 1) {
      // Merge runs (e.g. 261 × F0) into one row.
      if (lastCtrl && lastCtrl.dir === dir && lastCtrl.byte === byte && performance.now() - t0 - lastCtrl.t < 300) {
        lastCtrl.count += count;
        lastCtrl.summary = `${CTRL_NAMES[byte] ?? "bad flag"} × ${lastCtrl.count}`;
        if (lastCtrl.row) lastCtrl.row.querySelector(".what").textContent = lastCtrl.summary;
        return;
      }
      lastCtrl = { dir, kind: "ctrl", byte, count, summary: `${CTRL_NAMES[byte] ?? "bad flag"}${count > 1 ? ` × ${count}` : ""}`, hex: hex(byte), bad: !CTRL_NAMES[byte] };
      add(lastCtrl);
    },
    frame(dir, f, resend = false, duplicate = false) {
      lastCtrl = null;
      if (!f) return;
      stats[dir]++;
      const d = decode(f.payload);
      const flags = [f.reliable ? `seq ${f.seq}` : "unreliable", resend && "RESEND", duplicate && "DUPLICATE", !f.crcOk && "BAD CRC", d.warning]
        .filter(Boolean).join(", ");
      add({
        dir, kind: "frame", bad: !f.crcOk || !!d.warning,
        summary: `${addr(f.src)}→${addr(f.dst)} ${d.name} ${describeFields(d.fields)} (${flags})`,
        hex: hexBytes(f.raw),
      });
    },
    note(text) {
      lastCtrl = null;
      add({ dir: "note", kind: "note", summary: text });
    },
    rerender() {
      body.replaceChildren();
      for (const e of entries.slice(-MAX_ROWS)) if (visible(e)) appendRow(e);
    },
    clear() {
      entries.length = 0;
      body.replaceChildren();
    },
    export() {
      const lines = entries.map((e) => `${(e.t / 1000).toFixed(3)}\t${e.dir}\t${e.summary}\t${e.hex ?? ""}`);
      const blob = new Blob([`# DriveWare web port traffic log, ${new Date().toISOString()}\n${lines.join("\n")}\n`], { type: "text/plain" });
      const a = h("a", { href: URL.createObjectURL(blob), download: `driverack-log-${Date.now()}.txt` });
      a.click();
      URL.revokeObjectURL(a.href);
    },
  };
}

// Raw sender

function setupRawSender() {
  $("msg-names").append(...[...MSG_INFO.values()].map((i) => h("option", { value: i.name.replace(/^MSG_/, "") }, `0x${hex(i.id, 4)} ${i.min}–${i.max} bytes`)));
  $("raw-form").addEventListener("submit", act(async (e) => {
    e.preventDefault();
    $("raw-error").textContent = "";
    const unit = session();
    if (!unit || ctx.link.state !== "active") throw new Error("Link is not up.");
    const msgText = $("raw-msg").value.trim().replace(/^MSG_/, "");
    const id = MSG[msgText] ?? parseNum(msgText);
    if (id == null || id > 0xffff) {
      $("raw-error").textContent = "Unknown message";
      return;
    }
    const data = $("raw-data").value.trim().split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x, 16));
    if (data.some((b) => !(b >= 0 && b <= 255))) {
      $("raw-error").textContent = "Data must be hex bytes";
      return;
    }
    const m = unit.model;
    const dst = $("raw-dst").value.trim() ? parseNum($("raw-dst").value) : m.deviceAddr;
    await unit.send(payload(id, data), {
      dst: dst ?? parseNum($("opt-dev").value),
      src: m.hostAddr ?? parseNum($("opt-host").value),
      reliable: $("raw-reliable").checked,
    });
    log.note(`Sent ${msgName(id)} by hand`);
  }));
}

// Boot

$("btn-serial").addEventListener("click", connectSerial);
$("btn-sim").addEventListener("click", () => {
  $("btn-sim").closest("details").open = false;
  runSimulator();
});
$("btn-disconnect").addEventListener("click", disconnect);
$("log-clear").addEventListener("click", () => log.clear());
$("log-export").addEventListener("click", () => log.export());
function showTraffic(show) {
  $("log-panel").hidden = !show;
  $("btn-traffic").setAttribute("aria-expanded", String(show));
  try { localStorage.setItem("traffic", show ? "shown" : "hidden"); } catch {}
}
try { if (localStorage.getItem("traffic") === "hidden") showTraffic(false); } catch {}
$("btn-traffic").addEventListener("click", () => showTraffic($("log-panel").hidden));
const popovers = document.querySelectorAll("details.options, details.split-menu");
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const d of popovers) {
    if (!d.open) continue;
    d.open = false;
    d.querySelector("summary").focus();
  }
});
document.addEventListener("click", (e) => {
  for (const d of popovers) if (d.open && !d.contains(e.target)) d.open = false;
});
for (const id of ["log-ctrl", "log-keepalive"]) $(id).addEventListener("change", () => log.rerender());
setupRawSender();
$("opt-sim-model").append(...SIM_MODELS.map((name) => h("option", { value: name, selected: name === "DriveRack 260" }, name)));
updateButtons();
renderAll();
if (!SerialTransport.supported) {
  $("banner").append(" ", h("strong", {}, "This browser has no Web Serial API; only the simulator will work here (use desktop Chrome or Edge)."));
}
// ?sim starts the simulator; ?sim=480&units=3 picks the model and network size.
const query = new URLSearchParams(location.search);
if (query.has("sim")) {
  const want = query.get("sim");
  if (want) $("opt-sim-model").value = SIM_MODELS.find((n) => n.endsWith(` ${want}`)) ?? "DriveRack 260";
  if (query.get("units")) $("opt-sim-units").value = query.get("units");
  runSimulator();
}
