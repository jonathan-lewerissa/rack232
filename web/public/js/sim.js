// A simulated DriveRack 260 speaking the device side of the protocol, so the client can be
// exercised without hardware. The signal chain, ranges, prompts and addresses below are
// invented for testing, loosely after the 260 manual; they are NOT captured from a device.

import { Link } from "./link.js";
import { MSG, payload, readU16, u16 } from "./messages.js";

const ISO_BANDS = ["31.5", "40", "50", "63", "80", "100", "125", "160", "200", "250", "315", "400", "500", "630",
  "800", "1k", "1.25k", "1.6k", "2k", "2.5k", "3.15k", "4k", "5k", "6.3k", "8k", "10k", "12.5k", "16k"];

const freqText = (i) => {
  const f = 20 * 2 ** (i / 12);
  return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(1)} Hz`;
};
const XOVER_TYPES = ["BS 6", "BS 12", "BS 18", "BS 24", "BW 6", "BW 12", "BW 18", "BW 24", "LR 12", "LR 24", "LR 36", "LR 48"];
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

function defaultChain() {
  const geq = (ch) => ({
    name: `GEQ Ch ${ch}`, type: 0x10, in: ch - 1, out: ch - 1,
    params: [P("GEQ On", "onOff"), ...ISO_BANDS.map((b) => P(`${b} Hz`, "geqGain"))],
  });
  // Stereo 3-way, one set of filters per band (each band: high-pass, low-pass, gain).
  const xband = (name, hp, lp) => [
    P(`${name} HPF Fc`, "hpFreq", hp), P(`${name} HPF Type`, "slope"),
    P(`${name} LPF Fc`, "lpFreq", lp), P(`${name} LPF Type`, "slope"),
    P(`${name} Gain`, "xGain"),
  ];
  const xover = {
    name: "Crossover 2x6", type: 0x20, in: 0, out: 0,
    params: [...xband("Low", 0, 33), ...xband("Mid", 34, 77), ...xband("High", 78, 120)],
  };
  const band = (name, out) => [
    {
      name: `PEQ ${name}`, type: 0x30, in: out, out,
      params: [P("PEQ On", "onOff"), ...[1, 2, 3, 4].flatMap((b) => [
        P(`Band ${b} Fc`, "freq", 24 + b * 18), P(`Band ${b} Gain`, "peqGain"), P(`Band ${b} Q`, "q")])],
    },
    {
      name: `Limiter ${name}`, type: 0x40, in: out, out,
      params: [P("Limiter On", "onOff"), P("Threshold", "thresh"), P("OverEasy", "overEasy")],
    },
    { name: `Delay ${name}`, type: 0x50, in: out, out, params: [P("Delay On", "onOff", 0), P("Delay", "delay")] },
    { name: `Output ${name}`, type: 0x60, in: out, out, params: [P("Level", "outGain"), P("Phase", "phase")] },
  ];
  return [
    geq(1),
    geq(2),
    { name: "AFS", type: 0x11, in: 0, out: 1, params: [P("AFS On", "onOff", 0), P("Mode", "afsMode"), P("Fixed Filters", "filters")] },
    { name: "Subharmonic", type: 0x12, in: 0, out: 1, params: [P("Sub On", "onOff", 0), P("Subharmonics", "percent"), P("24-36 Hz", "percent"), P("36-56 Hz", "percent")] },
    xover,
    ...band("Low L", 0), ...band("Low R", 1),
    ...band("Mid L", 2), ...band("Mid R", 3),
    ...band("High L", 4), ...band("High R", 5),
  ];
}

// Program names from manual A.6. Programs 1-25 are User and start as copies of Factory 26-50.
const FACTORY = ["2x3w/3Zones", "LCRw/Cluster", "1x4w/2Zones", "2x5w/1Zone", "2x4Tri-Amped", "2x4w/2Zones",
  "LCRw/Monitor", "STw/2Delays", "Multi-Zone", "2x3w/Bal&Dly", "AM4315/64", "AC2215/64", "SRX738", "AM6340/95",
  "EON15G2", "AM4212/95", "MRX512M", "PRX525", "AC2212/00", "AM6315/64", "AC2215/00", "JRX125", "SRX712M",
  "AC2212/95", "AM6212/64"];
const USER_COUNT = 25;

export class SimulatedDriveRack {
  constructor(endpoint, { address = 0x01, hostAddress = 0x10, generation = 3, timing } = {}) {
    this.address = address;
    this.hostAddress = hostAddress;
    this.generation = generation;
    this.name = "Simulated 260";
    this.programs = [...FACTORY, ...FACTORY];
    this.stored = new Map(); // program -> saved values
    this.current = 0;
    this.chain = defaultChain();
    this.muteMask = 0;
    this.systemMute = false;
    this.received = [];
    this.link = new Link({ write: (b) => endpoint.write(b), initiate: false, timing });
    endpoint.onData((b) => this.link.feed(b));
    this.link.on("state", (s) => s === "active" && this.#reply(payload(MSG.NETWORK_IDENTIFY, this.generation)));
    this.link.on("frame", (f) => this.#handle(f));
    this.link.start();
  }

  stop() {
    this.link.stop();
  }

  #reply(p) {
    this.link.send({ dst: this.hostAddress, src: this.address, reliable: true, payload: p }).catch(() => {});
  }

  #snapshot() {
    return this.chain.map((b) => b.params.map((p) => p.value));
  }

  #restore(values) {
    const fresh = defaultChain();
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

  #handle(f) {
    if (f.dst !== this.address) return;
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
        return R(payload(MSG.NETWORK_IDENTIFY, this.generation));
      case MSG.SYSTEM_DO_ATTACH:
        return;
      case MSG.SYSTEM_REQUEST_DEVICE_DATA:
        return R(payload(MSG.SYSTEM_REPLY_DEVICE_DATA, 0, ..."1510".split("").map((c) => c.charCodeAt(0)), 0x45, 0, 0));
      case MSG.SYSTEM_REQUEST_DEVICE_NAME:
        return R(payload(MSG.SYSTEM_REPLY_DEVICE_NAME, str(this.name)));
      case MSG.SYSTEM_WRITE_DEVICE_NAME:
        this.name = String.fromCharCode(...p.slice(2)).replace(/\0.*$/, "");
        return;
      case MSG.CONFIG_REQUEST_NUMBER_FX:
        return R(payload(MSG.CONFIG_REPLY_NUMBER_FX, this.chain.length));
      case MSG.PROGRAM_REQUEST_GLOBAL_DATA:
        return R(payload(MSG.PROGRAM_REPLY_GLOBAL_DATA, u16(USER_COUNT), u16(FACTORY.length), u16(50)));
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
        const n = p[2] >= USER_COUNT ? p[2] - USER_COUNT : p[2];
        if (n >= USER_COUNT) return bad();
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
        this.muteMask = p[2] & 0x3f;
        return;
      case MSG.CONFIG_SYSTEM_MUTE_REQUEST:
        return R(payload(MSG.CONFIG_SYSTEM_MUTE_REPLY, this.systemMute ? 1 : 0));
      case MSG.CONFIG_WRITE_SYSTEM_MUTE:
        this.systemMute = p[2] !== 0;
        return;
      case MSG.UTILITY_REQUEST:
        return R(payload(MSG.UTILITY_REPLY, new Array(74).fill(0)));
      default:
        return R(payload(MSG.ERROR_INVALID_MESSAGE, u16(id), 0));
    }
  }
}
