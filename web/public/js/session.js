// Host session: address discovery, DriveWare's connect sequence, and the self-describing
// FX/parameter walk (PROTOCOL.md 4.1-4.3). Keeps a plain-object model and emits "change".

import { Emitter } from "./emitter.js";
import { MSG, decode, req } from "./messages.js";

const ERROR_IDS = new Set([MSG.ERROR_INVALID_MESSAGE, MSG.ERROR_INVALID_LENGTH, MSG.ERROR_INVALID_PARAMETER]);

export const DEFAULT_OPTIONS = Object.freeze({
  fallbackHostAddr: 0x00, // used only if the device never sends NETWORK_IDENTIFY
  fallbackDeviceAddr: 0x01, // DriveWare's first device slot is address 1
  identifyWaitMs: 2000,
  replyTimeoutMs: 1500,
  quietMs: 400, // "device has finished streaming" after this long without frames
});

function emptyModel() {
  return {
    hostAddr: null,
    deviceAddr: null,
    addressesFrom: null, // "identify" | "fallback"
    generation: null,
    firmware: null,
    model: null,
    deviceName: null,
    counts: null,
    programs: [],
    currentProgram: null,
    currentName: null,
    muteMask: null,
    systemMute: null,
    utilityBytes: null,
    fxCount: null,
    fx: [],
    // Which optional requests the device answered: true, false (timed out) or undefined.
    supports: {},
    errors: [],
  };
}

export class Session extends Emitter {
  #link;
  #waiters = [];
  #epoch = 0;
  #lastFrameAt = 0;
  #writes = new Map(); // "fx:param" -> pending value while a write is in flight
  #labels = new Map(); // "type|name|param" -> { prompt, inputType }, reused across program loads

  constructor(link, options = {}) {
    super();
    this.#link = link;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.model = emptyModel();
    this.busy = null;
    link.on("frame", (f) => this.#onFrame(f));
    link.on("state", (state) => {
      this.#epoch++;
      this.#rejectWaiters();
      if (state === "active") this.#bringUp(this.#epoch);
    });
  }

  // ---- public actions ----

  async refresh() {
    await this.#guard(this.#epoch, () => this.#connectSequence(this.#epoch));
  }

  async loadProgram(n) {
    const epoch = this.#epoch;
    await this.#guard(epoch, async () => {
      this.#status(`Loading program ${n + 1}…`);
      await this.request(req.retrieve(n), MSG.PROGRAM_DID_RETRIEVE);
      const loaded = await this.request(req.load(), MSG.PROGRAM_DID_LOAD);
      if (loaded) this.#set({ currentProgram: loaded.fields.program });
      await this.#loadProgramDetail(epoch);
    });
  }

  async storeProgram(n, name, insert = false) {
    await this.#guard(this.#epoch, async () => {
      this.#status(`Storing "${name}" to program ${n + 1}…`);
      const r = await this.request(req.store(n, name, insert), MSG.PROGRAM_DID_STORE);
      if (!r) throw new Error("device did not confirm the store");
      // The 260 moves a store aimed at a factory program to the matching user slot (manual 3.4).
      const stored = r.fields.program;
      await this.request(req.programName(stored), MSG.PROGRAM_REPLY_NAME, (d) => d.fields.program === stored);
      await this.request(req.currentProgram(), MSG.PROGRAM_REPLY_CURRENT);
    });
  }

  async renameDevice(name) {
    await this.send(req.writeDeviceName(name));
    await this.request(req.deviceName(), MSG.SYSTEM_REPLY_DEVICE_NAME);
  }

  // Parameter writes are coalesced per parameter: while one is in flight, only the newest
  // pending value is sent next, so dragging a slider does not queue hundreds of frames.
  setParam(fx, param, value) {
    const p = this.model.fx[fx]?.params[param];
    if (p) {
      p.value = value;
      p.text = null;
      this.emit("change", "param", { fx, param });
    }
    const key = `${fx}:${param}`;
    const inFlight = this.#writes.has(key);
    this.#writes.set(key, value);
    if (!inFlight) this.#flushWrite(fx, param, key);
  }

  async setMute(output, muted) {
    const mask = this.model.muteMask ?? 0;
    const next = muted ? mask | (1 << output) : mask & ~(1 << output);
    this.#set({ muteMask: next });
    await this.send(req.writeMuteStatus(next));
    await this.request(req.muteStatus(), MSG.CONFIG_MUTE_STATUS_REPLY);
  }

  async setSystemMute(muted) {
    this.#set({ systemMute: muted });
    await this.send(req.writeSystemMute(muted));
    await this.request(req.systemMute(), MSG.CONFIG_SYSTEM_MUTE_REPLY);
  }

  async refreshFx(fx) {
    const epoch = this.#epoch;
    await this.#guard(epoch, async () => {
      this.#status(`Refreshing ${this.model.fx[fx]?.name ?? `block ${fx}`}…`);
      await this.request(req.paramAllInFx(fx), MSG.PARAM_REPLY_ALL_IN_FX, (d) => d.fields.fx === fx);
      await this.#walkParams(epoch, [fx], true);
    });
  }

  send(payload, { dst = this.model.deviceAddr, src = this.model.hostAddr, reliable = true } = {}) {
    if (dst == null || src == null) return Promise.reject(new Error("addresses not known yet"));
    return this.#link.send({ dst, src, reliable, payload });
  }

  // Send a request and wait for a reply with message ID `expect` (and matching `match`).
  // Resolves to the decoded reply, or null on timeout or error reply.
  async request(payload, expect, match = () => true, timeoutMs = this.options.replyTimeoutMs) {
    const waiter = this.#wait(expect, match, timeoutMs);
    try {
      await this.send(payload);
    } catch (err) {
      waiter.cancel();
      throw err;
    }
    return waiter.promise;
  }

  // ---- bring-up ----

  async #bringUp(epoch) {
    this.model = emptyModel();
    this.emit("change", "all");
    await this.#guard(epoch, async () => {
      this.#status("Link up, waiting for NETWORK_IDENTIFY…");
      if (this.model.hostAddr == null) {
        await this.#wait(MSG.NETWORK_IDENTIFY, () => true, this.options.identifyWaitMs).promise;
      }
      this.#alive(epoch);
      if (this.model.hostAddr == null) {
        this.#set({
          hostAddr: this.options.fallbackHostAddr,
          deviceAddr: this.options.fallbackDeviceAddr,
          addressesFrom: "fallback",
        });
      }
      await this.send(req.guiIdentify());
      await this.send(req.attach());
      await this.#connectSequence(epoch);
    });
  }

  // DriveWare's connect sequence, plus the follow-ups its reply handlers trigger.
  async #connectSequence(epoch) {
    this.#status("Reading device data…");
    await this.request(req.deviceData(), MSG.SYSTEM_REPLY_DEVICE_DATA);
    await this.request(req.numberFx(), MSG.CONFIG_REPLY_NUMBER_FX);
    await this.request(req.deviceName(), MSG.SYSTEM_REPLY_DEVICE_NAME);
    const global = await this.request(req.globalData(), MSG.PROGRAM_REPLY_GLOBAL_DATA);
    this.#alive(epoch);
    if (global) {
      const total = Math.min(256, global.fields.a + global.fields.b);
      this.#set({ programs: Array.from({ length: total }, () => null) });
      for (let n = 0; n < total; n++) {
        this.#status(`Reading program names ${n + 1}/${total}…`);
        await this.request(req.programName(n), MSG.PROGRAM_REPLY_NAME, (d) => d.fields.program === n);
        this.#alive(epoch);
      }
    }
    await this.request(req.currentProgram(), MSG.PROGRAM_REPLY_CURRENT);
    await this.request(req.muteStatus(), MSG.CONFIG_MUTE_STATUS_REPLY);
    await this.request(req.systemMute(), MSG.CONFIG_SYSTEM_MUTE_REPLY);
    await this.request(req.utility(), MSG.UTILITY_REPLY);
    this.#alive(epoch);
    await this.#loadProgramDetail(epoch);
  }

  // REPLY_CURRENT -> REQUEST_NAME(n), CONFIG_REQUEST_ALL(n), PARAM_REQUEST_ALL, then fill gaps.
  async #loadProgramDetail(epoch) {
    const n = this.model.currentProgram ?? 0;
    this.#status("Reading signal chain…");
    this.#set({ fx: [], fxCount: null });
    await this.request(req.currentName(), MSG.PROGRAM_REPLY_CURRENT_NAME);
    await this.send(req.configAll(n));
    await this.send(req.paramAll());
    await this.#quiet(epoch);
    if (this.model.fxCount == null) await this.request(req.numberFx(), MSG.CONFIG_REPLY_NUMBER_FX);
    const count = this.model.fxCount ?? 0;
    for (let fx = 0; fx < count; fx++) {
      const block = this.#block(fx);
      this.#status(`Reading block ${fx + 1}/${count}…`);
      if (block.type == null) await this.request(req.fxData(fx), MSG.CONFIG_REPLY_FX_DATA, (d) => d.fields.fx === fx);
      if (block.name == null) await this.request(req.fxName(fx), MSG.CONFIG_REPLY_FX_NAME, (d) => d.fields.fx === fx);
      if (block.in == null) await this.request(req.fxInOut(fx), MSG.CONFIG_REPLY_FX_IN_OUT, (d) => d.fields.fx === fx);
      if (!block.params.length)
        await this.request(req.paramAllInFx(fx), MSG.PARAM_REPLY_ALL_IN_FX, (d) => d.fields.fx === fx);
      this.#alive(epoch);
    }
    await this.#walkParams(epoch, [...Array(count).keys()], false);
  }

  // Ask for each parameter's widget type, label and display text. A request type that goes
  // unanswered once is not asked again, so an unsupported request costs one timeout.
  async #walkParams(epoch, fxList, textOnly) {
    const ask = async (kind, payload, expect, fx, param) => {
      if (this.model.supports[kind] === false) return;
      const r = await this.request(payload, expect, (d) => d.fields.fx === fx && d.fields.param === param);
      if (this.model.supports[kind] === undefined) this.model.supports[kind] = !!r;
      this.#alive(epoch);
    };
    for (const fx of fxList) {
      const block = this.model.fx[fx];
      if (!block) continue;
      this.#status(`Reading parameters of ${block.name ?? `block ${fx + 1}`}…`);
      for (const p of block.params) {
        const key = `${block.type}|${block.name}|${p.index}`;
        const known = this.#labels.get(key);
        if (known) {
          p.prompt ??= known.prompt;
          p.inputType ??= known.inputType;
        }
        if (!textOnly) {
          if (p.inputType == null)
            await ask("inputType", req.paramInputType(fx, p.index), MSG.PARAM_REPLY_INPUT_TYPE, fx, p.index);
          if (p.prompt == null)
            await ask("prompt", req.paramPrompt(fx, p.index), MSG.PARAM_REPLY_PROMPT_STRING, fx, p.index);
        }
        await ask("valueText", req.paramText(fx, p.index), MSG.PARAM_REPLY_STRING, fx, p.index);
        if (p.prompt != null || p.inputType != null) this.#labels.set(key, { prompt: p.prompt, inputType: p.inputType });
      }
    }
    this.emit("change", "supports");
  }

  async #flushWrite(fx, param, key) {
    while (this.#writes.has(key)) {
      const value = this.#writes.get(key);
      try {
        await this.send(req.paramWrite(fx, param, value));
        if (this.model.supports.valueText && this.#writes.get(key) === value) {
          await this.request(req.paramText(fx, param), MSG.PARAM_REPLY_STRING, (d) => d.fields.fx === fx && d.fields.param === param);
        }
      } catch (err) {
        this.#writes.delete(key);
        this.#error(`write ${fx}:${param} failed: ${err.message}`);
        return;
      }
      if (this.#writes.get(key) === value) this.#writes.delete(key);
    }
  }

  // ---- receive path ----

  #onFrame(frame) {
    this.#lastFrameAt = Date.now();
    const d = decode(frame.payload);
    d.frame = frame;
    this.#apply(d, frame);
    const waiter = this.#waiters.find((w) => w.expect === d.id && w.match(d));
    if (waiter) waiter.resolve(d);
    else if (ERROR_IDS.has(d.id) && this.#waiters.length) this.#waiters[0].resolve(null);
  }

  #apply({ id, fields: f }, frame) {
    const m = this.model;
    switch (id) {
      case MSG.NETWORK_IDENTIFY:
        // The device tells us our address in dst and its own in src.
        this.#set({ hostAddr: frame.dst, deviceAddr: frame.src, addressesFrom: "identify", generation: f.generation ?? null });
        break;
      case MSG.NETWORK_DID_CONFIG:
        this.#set({ hostAddr: frame.dst });
        break;
      case MSG.SYSTEM_REPLY_DEVICE_DATA:
        this.#set({ firmware: f.firmware, model: f.model });
        break;
      case MSG.SYSTEM_REPLY_DEVICE_NAME:
        this.#set({ deviceName: f.name });
        break;
      case MSG.PROGRAM_REPLY_GLOBAL_DATA:
        this.#set({ counts: f });
        break;
      case MSG.PROGRAM_REPLY_NAME:
        m.programs[f.program] = f.name;
        this.emit("change", "programs");
        break;
      case MSG.PROGRAM_REPLY_CURRENT:
      case MSG.PROGRAM_DID_LOAD:
        this.#set({ currentProgram: f.program });
        break;
      case MSG.PROGRAM_REPLY_CURRENT_NAME:
        this.#set({ currentName: f.name });
        break;
      case MSG.CONFIG_REPLY_NUMBER_FX:
        if (m.fxCount !== f.count) {
          m.fx = [];
          this.#set({ fxCount: f.count });
        }
        break;
      case MSG.CONFIG_REPLY_FX_DATA:
        Object.assign(this.#block(f.fx), { type: f.type, descriptor: f.descriptor });
        this.emit("change", "fx", { fx: f.fx });
        break;
      case MSG.CONFIG_REPLY_FX_NAME:
        this.#block(f.fx).name = f.name;
        this.emit("change", "fx", { fx: f.fx });
        break;
      case MSG.CONFIG_REPLY_FX_IN_OUT:
        Object.assign(this.#block(f.fx), { in: f.in, out: f.out });
        this.emit("change", "fx", { fx: f.fx });
        break;
      case MSG.PARAM_REPLY_ALL_IN_FX: {
        const block = this.#block(f.fx);
        f.values.forEach((v, i) => {
          const p = this.#param(block, i);
          if (!this.#writes.has(`${f.fx}:${i}`)) p.value = v;
        });
        this.emit("change", "fx", { fx: f.fx });
        break;
      }
      case MSG.PARAM_REPLY:
        this.#param(this.#block(f.fx), f.param).value = f.value;
        this.emit("change", "param", f);
        break;
      case MSG.PARAM_REPLY_INPUT_TYPE:
        this.#param(this.#block(f.fx), f.param).inputType = f.inputType;
        this.emit("change", "param", f);
        break;
      case MSG.PARAM_REPLY_PROMPT_STRING:
        this.#param(this.#block(f.fx), f.param).prompt = f.prompt;
        this.emit("change", "param", f);
        break;
      case MSG.PARAM_REPLY_STRING:
        if (this.model.fx[f.fx]?.params[f.param]) {
          this.model.fx[f.fx].params[f.param].text = f.text;
          this.emit("change", "param", f);
        }
        break;
      case MSG.CONFIG_MUTE_STATUS_REPLY:
        this.#set({ muteMask: f.mask });
        break;
      case MSG.CONFIG_SYSTEM_MUTE_REPLY:
        this.#set({ systemMute: f.muted });
        break;
      case MSG.UTILITY_REPLY:
        this.#set({ utilityBytes: f.bytes });
        break;
      case MSG.ERROR_INVALID_MESSAGE:
      case MSG.ERROR_INVALID_LENGTH:
      case MSG.ERROR_INVALID_PARAMETER:
        this.#error(`device replied ${decode(frame.payload).name} (code ${f.code})`);
        break;
    }
  }

  #block(fx) {
    const blocks = this.model.fx;
    while (blocks.length <= fx) blocks.push({ index: blocks.length, type: null, descriptor: null, name: null, in: null, out: null, params: [] });
    return blocks[fx];
  }

  #param(block, i) {
    while (block.params.length <= i)
      block.params.push({ index: block.params.length, value: null, inputType: null, prompt: null, text: null });
    return block.params[i];
  }

  // ---- helpers ----

  #wait(expect, match, timeoutMs) {
    const w = { expect, match };
    w.promise = new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(w.timer);
        this.#waiters = this.#waiters.filter((x) => x !== w);
        resolve(v);
      };
      w.resolve = done;
      w.cancel = () => done(null);
      w.timer = setTimeout(() => done(null), timeoutMs);
    });
    this.#waiters.push(w);
    return w;
  }

  #rejectWaiters() {
    for (const w of [...this.#waiters]) w.cancel();
  }

  // Resolve once no frame has arrived for options.quietMs (the device streams FX data
  // and parameter blocks after CONFIG_REQUEST_ALL / PARAM_REQUEST_ALL).
  async #quiet(epoch, maxMs = 8000) {
    const start = Date.now();
    this.#lastFrameAt = Date.now();
    while (Date.now() - this.#lastFrameAt < this.options.quietMs && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 50));
      this.#alive(epoch);
    }
  }

  #alive(epoch) {
    if (epoch !== this.#epoch) throw new StaleEpoch();
  }

  // Runs one long operation at a time. A link drop bumps the epoch, which abandons the
  // operation at its next #alive() check without reporting it as an error.
  async #guard(epoch, fn) {
    if (this.busy?.epoch === this.#epoch) throw new Error("another operation is still running");
    const token = { epoch };
    this.busy = token;
    this.emit("change", "busy");
    try {
      await fn();
      this.#status("Ready");
    } catch (err) {
      if (epoch === this.#epoch && !(err instanceof StaleEpoch)) {
        this.#error(err.message);
        this.#status(`Stopped: ${err.message}`);
      }
    } finally {
      if (this.busy === token) {
        this.busy = null;
        this.emit("change", "busy");
      }
    }
  }

  #set(patch) {
    Object.assign(this.model, patch);
    this.emit("change", "model", patch);
  }

  #status(text) {
    this.status = text;
    this.emit("status", text);
  }

  #error(text) {
    this.model.errors.push({ at: new Date(), text });
    this.emit("change", "errors");
  }
}

class StaleEpoch extends Error {}
