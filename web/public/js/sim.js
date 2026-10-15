// Simulated DriveRacks speaking the device side of the protocol, so the client can be exercised
// without hardware. One simulated link carries a single unit (260, 261, 220i, 24x), which sends
// NETWORK_IDENTIFY, or a 48x/442 network whose master sends NETWORK_DID_CONFIG. The signal chains,
// ranges, prompts, program names and counts below are invented for testing, loosely after the
// manuals and DriveWare's program banks; they are NOT captured from a device.

import { Link } from "./link.js";
import { MSG, payload, readU16, u16 } from "./messages.js";
import { ADDR, MODELS } from "./models.js";

const ISO_28 = ["31.5", "40", "50", "63", "80", "100", "125", "160", "200", "250", "315", "400", "500", "630",
  "800", "1k", "1.25k", "1.6k", "2k", "2.5k", "3.15k", "4k", "5k", "6.3k", "8k", "10k", "12.5k", "16k"];
const ISO_31 = ["20", "25", ...ISO_28, "20k"]; // DriveWare's 48x/24x/442 banks have 31 GEQ bands

const freqText = (i) => {
  const f = 20 * 2 ** (i / 12);
  return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(1)} Hz`;
};
const XOVER_TYPES = ["BS 6", "BS 12", "BS 18", "BS 24", "BW 6", "BW 12", "BW 18", "BW 24", "LR 12", "LR 24", "LR 36", "LR 48"];
const XOVER_TYPES_4 = ["BW 12", "BW 18", "BW 24", "LR 24"]; // 4 values as in the 24x/48x banks; names invented
const dB = (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;

// Parameter kinds: [inputType, max, default, render]. Input type IDs follow the 24x bank where
// FUNCTIONALITY.md lists one (0x0C on/off, 0x14 GEQ gain, 0x29 phase, 0x01 threshold, ...).
const K = {
  onOff: [0x0c, 1, 1, (v) => (v ? "On" : "Off")],
  geqGain: [0x14, 48, 24, (v) => dB((v - 24) / 2)],
  peqGain: [0x07, 48, 24, (v) => dB((v - 24) / 2)],
  freq: [0x24, 119, 60, freqText],
  q: [0x06, 15, 6, (v) => `Q ${[0.2, 0.3, 0.5, 0.7, 1, 1.4, 2, 2.8, 4, 5.6, 8, 10, 12, 14, 15, 16][v]}`],
  // Manual 4.7: BS and BW 6..24, LR 12..48 dB/oct. Value order and spelling are invented.
  slope: [0x58, 11, 9, (v) => XOVER_TYPES[v]],
  slope24x: [0x58, 3, 3, (v) => XOVER_TYPES_4[v]],
  slope48x: [0x21, 3, 3, (v) => XOVER_TYPES_4[v]],
  hpFreq: [0x24, 120, 0, (v) => (v ? freqText(v - 1) : "Out")],
  lpFreq: [0x24, 120, 120, (v) => (v < 120 ? freqText(v) : "Out")],
  xGain: [0x3f, 80, 40, (v) => (v ? dB((v - 40) / 2) : "-Inf")],
  thresh: [0x01, 60, 40, (v) => `${v - 40} dBu`],
  ratio: [0x02, 15, 3, (v) => `${[1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 40, 99][v]}:1`],
  overEasy: [0x04, 10, 0, (v) => (v ? `${v}` : "Off")],
  percent: [0x30, 100, 50, (v) => `${v} %`],
  afsMode: [0x5a, 1, 0, (v) => ["Live", "Fixed"][v]],
  filters: [0x31, 12, 6, (v) => `${v} filters`],
  delay: [0x1c, 999, 0, (v) => `${(v / 10).toFixed(1)} ms`],
  outGain: [0x3f, 54, 40, (v) => (v === 0 ? "-Inf" : dB(v - 40))],
  phase: [0x29, 36, 36, (v) => `${(v - 36) * 5}°`],
};

const P = (prompt, kind, value) => {
  const [inputType, max, def, render] = K[kind];
  return { prompt, inputType, max, value: value ?? def, render };
};

const geq = (ch, bands) => ({
  name: `GEQ Ch ${ch + 1}`, type: 0x10, in: ch, out: ch,
  params: [P("GEQ On", "onOff"), ...bands.map((b) => P(`${b} Hz`, "geqGain"))],
});

// One crossover band: high-pass, low-pass, gain. bands = [name, hp value, lp value].
const xover = (name, last, bands, slope) => ({
  name, type: 0x20, in: 0, out: last,
  params: bands.flatMap(([band, hp, lp]) => [
    P(`${band} HPF Fc`, "hpFreq", hp), P(`${band} HPF Type`, slope),
    P(`${band} LPF Fc`, "lpFreq", lp), P(`${band} LPF Type`, slope),
    P(`${band} Gain`, "xGain"),
  ]),
});

// Output strip: PEQ, limiter, delay and output level, all on one output channel.
const strip = (name, out, { delay = true } = {}) => [
  {
    name: `PEQ ${name}`, type: 0x30, in: out, out,
    params: [P("PEQ On", "onOff"), ...[1, 2, 3, 4].flatMap((b) => [
      P(`Band ${b} Fc`, "freq", 24 + b * 18), P(`Band ${b} Gain`, "peqGain"), P(`Band ${b} Q`, "q")])],
  },
  {
    name: `Limiter ${name}`, type: 0x40, in: out, out,
    params: [P("Limiter On", "onOff"), P("Threshold", "thresh"), P("OverEasy", "overEasy")],
  },
  delay && { name: `Delay ${name}`, type: 0x50, in: out, out, params: [P("Delay On", "onOff", 0), P("Delay", "delay")] },
  { name: `Output ${name}`, type: 0x60, in: out, out, params: [P("Level", "outGain"), P("Phase", "phase")] },
].filter(Boolean);

const afs = { name: "AFS", type: 0x11, in: 0, out: 1, params: [P("AFS On", "onOff", 0), P("Mode", "afsMode"), P("Fixed Filters", "filters")] };
const stereo = (bands) => bands.flatMap((b) => [`${b} L`, `${b} R`]);

const CHAINS = {
  // 2 in, stereo 3-way over 6 outputs.
  260: () => [
    geq(0, ISO_28), geq(1, ISO_28), afs,
    { name: "Subharmonic", type: 0x12, in: 0, out: 1, params: [P("Sub On", "onOff", 0), P("Subharmonics", "percent"), P("24-36 Hz", "percent"), P("36-56 Hz", "percent")] },
    xover("Crossover 2x6", 5, [["Low", 0, 33], ["Mid", 34, 77], ["High", 78, 120]], "slope"),
    ...stereo(["Low", "Mid", "High"]).flatMap((n, i) => strip(n, i)),
  ],
  // 2 in, 2 full-range outputs.
  "220i": () => [
    geq(0, ISO_28), geq(1, ISO_28), afs,
    { name: "Stereo Link", type: 0x13, in: 0, out: 1, params: [P("Link On", "onOff")] },
    ...["L", "R"].flatMap((n, i) => strip(n, i, { delay: false })),
  ],
  // 2 in, stereo 2-way over 4 outputs.
  "24x": () => [
    geq(0, ISO_31), geq(1, ISO_31),
    xover("Crossover 2x4", 3, [["Low", 0, 60], ["High", 61, 120]], "slope24x"),
    ...stereo(["Low", "High"]).flatMap((n, i) => strip(n, i)),
  ],
  // 4 in, stereo 4-way over 8 outputs.
  "48x": () => [
    ...[0, 1, 2, 3].map((ch) => geq(ch, ISO_31)),
    xover("Crossover 4x8", 7, [["Sub", 0, 20], ["Low", 21, 50], ["Mid", 51, 85], ["High", 86, 120]], "slope48x"),
    ...stereo(["Sub", "Low", "Mid", "High"]).flatMap((n, i) => strip(n, i)),
  ],
  // 4 in, 4 out through a matrix; no crossover blocks.
  442: () => [
    ...[0, 1, 2, 3].map((ch) => geq(ch, ISO_31)),
    { name: "Matrix 4x4", type: 0x14, in: 0, out: 3, params: [0, 1, 2, 3].flatMap((o) => [0, 1, 2, 3].map((i) => P(`In ${i + 1} > Out ${o + 1}`, "xGain", i === o ? 40 : 0))) },
    ...[1, 2, 3, 4].flatMap((n, i) => strip(`Out ${n}`, i)),
  ],
};

// 260 program names from manual A.6. Programs 1-25 are User and start as copies of Factory 26-50.
// Other models get numbered placeholders.
const FACTORY_260 = ["2x3w/3Zones", "LCRw/Cluster", "1x4w/2Zones", "2x5w/1Zone", "2x4Tri-Amped", "2x4w/2Zones",
  "LCRw/Monitor", "STw/2Delays", "Multi-Zone", "2x3w/Bal&Dly", "AM4315/64", "AC2215/64", "SRX738", "AM6340/95",
  "EON15G2", "AM4212/95", "MRX512M", "PRX525", "AC2212/00", "AM6315/64", "AC2215/00", "JRX125", "SRX712M",
  "AC2212/95", "AM6212/64"];
const factoryNames = (family) =>
  family === "260" ? FACTORY_260 : Array.from({ length: family === "48x" || family === "442" ? 20 : 25 }, (_, i) => `${family} Preset ${i + 1}`);

const FIRMWARE = { "48x": "2500", 442: "1000", "24x": "1060", 260: "1510", "220i": "1010" }; // 442: invented

export const SIM_MODELS = MODELS.map((m) => m.name);

// One simulated unit on a shared link. Answers only frames addressed to it.
export class SimulatedUnit {
  constructor(link, { model, address, hostAddress, name }) {
    this.link = link;
    this.profile = model;
    this.address = address;
    this.hostAddress = hostAddress;
    this.name = name;
    const factory = factoryNames(model.family);
    this.userCount = factory.length;
    this.programs = [...factory, ...factory];
    this.stored = new Map(); // program -> saved values
    this.current = 0;
    this.chain = CHAINS[model.family]();
    this.muteMask = 0;
    this.systemMute = false;
    this.received = [];
  }

  #reply(p) {
    this.link.send({ dst: this.hostAddress, src: this.address, reliable: true, payload: p }).catch(() => {});
  }

  #snapshot() {
    return this.chain.map((b) => b.params.map((p) => p.value));
  }

  #restore(values) {
    const fresh = CHAINS[this.profile.family]();
    fresh.forEach((b, i) => b.params.forEach((p, j) => (p.value = values?.[i]?.[j] ?? p.value)));
    this.chain = fresh;
  }

  #fxData(i) {
    const b = this.chain[i];
    return payload(MSG.CONFIG_REPLY_FX_DATA, i, b.type, b.in, b.out, b.params.length, 0, 0, 0);
  }

  #params(i) {
    const vals = this.chain[i].params.flatMap((p) => u16(p.value));
    return payload(MSG.PARAM_REPLY_ALL_IN_FX, this.current, i, this.chain[i].params.length, vals);
  }

  handle(f) {
    if (f.dst !== this.address && f.dst !== ADDR.BROADCAST) return;
    const p = f.payload;
    const id = readU16(p, 0);
    this.received.push(id);
    const R = (x) => this.#reply(x);
    const param = (fx, i) => this.chain[fx]?.params[i];
    const bad = () => R(payload(MSG.ERROR_INVALID_PARAMETER, u16(1), 0, 0, 0, 0, 0, 0));
    const pad16 = (s) => Array.from(s.padEnd(16).slice(0, 16), (c) => c.charCodeAt(0));
    const str = (s) => [...Array.from(s, (c) => c.charCodeAt(0)), 0];

    switch (id) {
      case MSG.GUI_IDENTIFY:
      case MSG.SYSTEM_DO_ATTACH:
        return;
      case MSG.SYSTEM_REQUEST_DEVICE_DATA: {
        const fw = Array.from(FIRMWARE[this.profile.family], (c) => c.charCodeAt(0));
        return R(payload(MSG.SYSTEM_REPLY_DEVICE_DATA, 0, fw, this.profile.typeChar.charCodeAt(0), 0, 0));
      }
      case MSG.SYSTEM_REQUEST_DEVICE_NAME:
        return R(payload(MSG.SYSTEM_REPLY_DEVICE_NAME, str(this.name)));
      case MSG.SYSTEM_WRITE_DEVICE_NAME:
        this.name = String.fromCharCode(...p.slice(2)).replace(/\0.*$/, "");
        return;
      case MSG.CONFIG_REQUEST_NUMBER_FX:
        return R(payload(MSG.CONFIG_REPLY_NUMBER_FX, this.chain.length));
      case MSG.PROGRAM_REQUEST_GLOBAL_DATA:
        return R(payload(MSG.PROGRAM_REPLY_GLOBAL_DATA, u16(this.userCount), u16(this.programs.length - this.userCount), u16(this.programs.length)));
      case MSG.PROGRAM_REQUEST_NAME:
        return p[2] < this.programs.length ? R(payload(MSG.PROGRAM_REPLY_NAME, p[2], 0, str(this.programs[p[2]]))) : bad();
      case MSG.PROGRAM_REQUEST_CURRENT:
        return R(payload(MSG.PROGRAM_REPLY_CURRENT, this.current));
      case MSG.PROGRAM_REQUEST_CURRENT_NAME:
        return R(payload(MSG.PROGRAM_REPLY_CURRENT_NAME, 0, 0, str(this.programs[this.current])));
      case MSG.PROGRAM_DO_RETRIEVE:
        if (p[2] >= this.programs.length) return bad();
        this.pendingProgram = p[2];
        return R(payload(MSG.PROGRAM_DID_RETRIEVE, p[2]));
      case MSG.PROGRAM_DO_LOAD:
        this.current = this.pendingProgram ?? this.current;
        this.#restore(this.stored.get(this.current));
        return R(payload(MSG.PROGRAM_DID_LOAD, this.current, 0, 0));
      case MSG.PROGRAM_DO_STORE: {
        // Factory programs are read-only; a store aimed at one goes to the same user slot.
        const n = p[2] >= this.userCount ? p[2] - this.userCount : p[2];
        if (n >= this.userCount) return bad();
        this.programs[n] = String.fromCharCode(...p.slice(4)).replace(/\0.*$/, "");
        this.stored.set(n, this.#snapshot());
        this.current = n;
        return R(payload(MSG.PROGRAM_DID_STORE, n, 0));
      }
      case MSG.CONFIG_REQUEST_ALL:
        R(payload(MSG.CONFIG_REPLY_NUMBER_FX, this.chain.length));
        return this.chain.forEach((_, i) => R(this.#fxData(i)));
      case MSG.CONFIG_REQUEST_FX_DATA:
        return this.chain[p[2]] ? R(this.#fxData(p[2])) : bad();
      case MSG.CONFIG_REQUEST_FX_NAME:
        return this.chain[p[2]] ? R(payload(MSG.CONFIG_REPLY_FX_NAME, p[2], 0, str(this.chain[p[2]].name))) : bad();
      case MSG.CONFIG_REQUEST_FX_IN_OUT:
        return this.chain[p[2]] ? R(payload(MSG.CONFIG_REPLY_FX_IN_OUT, p[2], this.chain[p[2]].in, this.chain[p[2]].out)) : bad();
      case MSG.PARAM_REQUEST_ALL:
        return this.chain.forEach((_, i) => R(this.#params(i)));
      case MSG.PARAM_REQUEST_ALL_IN_FX:
        return this.chain[p[2]] ? R(this.#params(p[2])) : bad();
      case MSG.PARAM_WRITE: {
        const prm = param(p[2], p[3]);
        if (!prm) return bad();
        prm.value = Math.min(prm.max, readU16(p, 4));
        return;
      }
      case MSG.PARAM_REQUEST: {
        const prm = param(p[2], p[3]);
        return prm ? R(payload(MSG.PARAM_REPLY, this.current, p[2], p[3], 0, u16(prm.value))) : bad();
      }
      case MSG.PARAM_REQUEST_INPUT_TYPE: {
        const prm = param(p[2], p[3]);
        return prm ? R(payload(MSG.PARAM_REPLY_INPUT_TYPE, p[2], p[3], prm.inputType)) : bad();
      }
      case MSG.PARAM_REQUEST_PROMPT_STRING: {
        const prm = param(p[2], p[3]);
        return prm ? R(payload(MSG.PARAM_REPLY_PROMPT_STRING, p[2], p[3], str(prm.prompt))) : bad();
      }
      case MSG.PARAM_REQUEST_REPLY_STRING: {
        const prm = param(p[2], p[3]);
        return prm ? R(payload(MSG.PARAM_REPLY_STRING, p[2], p[3], pad16(prm.render(prm.value)))) : bad();
      }
      case MSG.CONFIG_MUTE_STATUS_REQUEST:
        return R(payload(MSG.CONFIG_MUTE_STATUS_REPLY, this.muteMask));
      case MSG.CONFIG_WRITE_MUTE_STATUS:
        this.muteMask = p[2] & ((1 << this.profile.outputs) - 1);
        return;
      case MSG.CONFIG_SYSTEM_MUTE_REQUEST:
        return R(payload(MSG.CONFIG_SYSTEM_MUTE_REPLY, this.systemMute ? 1 : 0));
      case MSG.CONFIG_WRITE_SYSTEM_MUTE:
        this.systemMute = p[2] !== 0;
        return;
      case MSG.UTILITY_REQUEST:
        return R(payload(MSG.UTILITY_REPLY, new Array(this.profile.utility - 2).fill(0)));
      default:
        return R(payload(MSG.ERROR_INVALID_MESSAGE, u16(id), 0));
    }
  }
}

// The device end of a serial link: a single unit at address 1 that announces itself with
// NETWORK_IDENTIFY, or for 48x/442 models a network of `units` units (master at 0, slaves 1..n-1)
// whose master sends NETWORK_DID_CONFIG. `remote` adds a 480R remote to the network bitmap; it
// answers nothing. The first unit's state is also exposed directly (sim.chain, sim.received, ...).
export class SimulatedDriveRack {
  constructor(endpoint, { model = "DriveRack 260", units = 1, remote = false, hostAddress = 0x10, timing } = {}) {
    const profile = MODELS.find((m) => m.name === model);
    if (!profile) throw new Error(`unknown model ${model}`);
    this.profile = profile;
    this.network = profile.family === "48x" || profile.family === "442";
    this.hostAddress = hostAddress;
    this.link = new Link({ write: (b) => endpoint.write(b), initiate: false, timing });
    const addresses = this.network ? Array.from({ length: units }, (_, i) => i) : [ADDR.SINGLE];
    this.units = addresses.map((address) => new SimulatedUnit(this.link, {
      model: profile, address, hostAddress,
      name: `Sim ${profile.name.replace("DriveRack ", "")}${this.network ? ` #${address}` : ""}`,
    }));
    this.addresses = remote ? [...addresses, ADDR.REMOTE_480R] : addresses;
    endpoint.onData((b) => this.link.feed(b));
    this.link.on("state", (s) => s === "active" && this.announce());
    this.link.on("frame", (f) => this.units.forEach((u) => u.handle(f)));
    this.link.start();
  }

  announce() {
    const first = this.units[0];
    if (this.network) {
      const bitmap = new Array(16).fill(0);
      for (const a of this.addresses) bitmap[a >> 3] |= 1 << (a & 7);
      this.#send(ADDR.MASTER, payload(MSG.NETWORK_DID_CONFIG, bitmap));
    } else {
      this.#send(first.address, payload(MSG.NETWORK_IDENTIFY, this.profile.generation));
    }
  }

  #send(src, p) {
    this.link.send({ dst: this.hostAddress, src, reliable: true, payload: p }).catch(() => {});
  }

  get chain() { return this.units[0].chain; }
  get received() { return this.units[0].received; }
  get muteMask() { return this.units[0].muteMask; }

  stop() {
    this.link.stop();
  }
}
