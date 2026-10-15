// Link layer: link-up handshake, stop-and-wait reliable frames, keepalive and resync.
// Mirrors DriveWare's writer and reader threads.
// The same class runs the host side (initiate = true) and the simulated device.

import { CTRL, FrameParser, encodeFrame } from "./frame.js";
import { Emitter } from "./emitter.js";

export const DEFAULT_TIMING = Object.freeze({
  helloMs: 250, // idle: 16 x 0xFF every 250 ms
  ackTimeoutMs: 1000, // resend a reliable frame after 1 s without ACK
  maxResends: 4, // ... up to 4 times, then send a 16 x 0xFF resync request
  maxResyncs: 4, // ... up to 4 rounds, then drop the frame and declare the link down
  keepaliveMs: 1000, // 0x8C after 1 s with nothing to send
  rxSilenceMs: 8000, // reader times out after 8 s of silence -> link down
});

const HELLO_BURST = new Uint8Array(16).fill(CTRL.HELLO);
const RESYNC_BURST = new Uint8Array(261).fill(CTRL.RESYNC);

export class LinkDownError extends Error {}

export class Link extends Emitter {
  #write;
  #parser;
  #queue = [];
  #inFlight = null;
  #timers = {};
  #pending = new Set(); // coalesced control bursts, like Win32 auto-reset events

  constructor({ write, timing = {}, initiate = true }) {
    super();
    this.#write = write;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.initiate = initiate;
    this.state = "stopped";
    this.badRun = 0;
    this.stats = { tx: 0, rx: 0, acks: 0, naks: 0, resends: 0, crcErrors: 0, duplicates: 0, badFlags: 0, linkUps: 0 };
    this.#parser = new FrameParser({
      onControl: (b) => this.#onControl(b),
      onFrame: (f) => this.#onFrame(f),
    });
  }

  start() {
    if (this.state !== "stopped") return;
    this.txSeq = 1;
    this.lastRxAt = Date.now();
    this.lastTxAt = Date.now();
    const tick = Math.max(5, Math.min(this.timing.keepaliveMs, this.timing.rxSilenceMs) / 4);
    this.#timers.house = setInterval(() => this.#housekeeping(), tick);
    this.#goIdle(null);
  }

  stop() {
    if (this.state === "stopped") return;
    for (const t of Object.values(this.#timers)) clearInterval(t), clearTimeout(t);
    this.#timers = {};
    this.#failAll(new LinkDownError("link stopped"));
    this.state = "stopped";
    this.emit("state", this.state, "stopped");
  }

  feed(bytes) {
    if (this.state === "stopped") return;
    this.lastRxAt = Date.now();
    this.#parser.push(bytes);
  }

  // Queue a frame. Resolves when written (unreliable) or ACKed (reliable).
  send({ dst, src, reliable = true, payload }) {
    if (this.state === "stopped") return Promise.reject(new LinkDownError("link stopped"));
    return new Promise((resolve, reject) => {
      this.#queue.push({ dst, src, reliable, payload, resolve, reject, sends: 0 });
      this.#pump();
    });
  }

  // ---- internals ----

  #out(bytes, info) {
    this.lastTxAt = Date.now();
    this.emit("tx", bytes, info);
    this.#write(bytes);
  }

  #burst(kind) {
    if (this.#pending.has(kind)) return;
    this.#pending.add(kind);
    queueMicrotask(() => {
      this.#pending.delete(kind);
      if (this.state === "stopped") return;
      if (kind === "hello") this.#out(HELLO_BURST, { ctrl: CTRL.HELLO });
      else this.#out(RESYNC_BURST, { ctrl: CTRL.RESYNC });
    });
  }

  #goIdle(reason) {
    clearTimeout(this.#timers.ack);
    this.#parser.reset();
    if (this.#inFlight) {
      this.#inFlight.reject(new LinkDownError(reason ?? "link down"));
      this.#inFlight = null;
    }
    this.state = "idle";
    this.emit("state", this.state, reason);
    clearInterval(this.#timers.hello);
    if (this.initiate) {
      const hello = () => this.state === "idle" && this.#out(HELLO_BURST, { ctrl: CTRL.HELLO });
      hello();
      this.#timers.hello = setInterval(hello, this.timing.helloMs);
    }
  }

  #goActive() {
    clearInterval(this.#timers.hello);
    this.state = "active";
    this.lastRxSeq = 0;
    this.stats.linkUps++;
    this.emit("state", this.state, null);
    this.#pump();
  }

  #housekeeping() {
    if (this.state !== "active") return;
    const now = Date.now();
    if (now - this.lastRxAt >= this.timing.rxSilenceMs) {
      this.#goIdle("nothing received for " + this.timing.rxSilenceMs + " ms");
      return;
    }
    if (!this.#inFlight && !this.#queue.length && now - this.lastTxAt >= this.timing.keepaliveMs) {
      this.#out(Uint8Array.of(CTRL.KEEPALIVE), { ctrl: CTRL.KEEPALIVE });
    }
  }

  #onControl(b) {
    this.emit("rxctrl", b);
    switch (b) {
      case CTRL.ACK:
        if (!this.#inFlight) return;
        this.stats.acks++;
        clearTimeout(this.#timers.ack);
        this.#inFlight.resolve();
        this.#inFlight = null;
        this.#advanceSeq();
        this.#pump();
        return;
      case CTRL.NAK:
        if (!this.#inFlight) return;
        this.stats.naks++;
        this.#transmit(this.#inFlight);
        return;
      case CTRL.HELLO:
        if (this.state === "idle") {
          this.#out(RESYNC_BURST, { ctrl: CTRL.RESYNC });
          this.#goActive();
        } else {
          this.#burst("resync");
        }
        return;
      case CTRL.RESYNC:
        if (this.state === "idle") this.#goActive();
        return;
      case CTRL.KEEPALIVE:
        return;
      default:
        this.stats.badFlags++;
        if (this.state === "active") this.#burst("hello");
    }
  }

  #onFrame(f) {
    let duplicate = false;
    if (!f.crcOk) {
      this.stats.crcErrors++;
      if (f.reliable) {
        this.#out(Uint8Array.of(CTRL.NAK), { ctrl: CTRL.NAK });
      } else if (++this.badRun > 15) {
        this.badRun = 0;
        this.#burst("hello");
      }
    } else {
      this.stats.rx++;
      if (f.reliable) {
        this.#out(Uint8Array.of(CTRL.ACK), { ctrl: CTRL.ACK });
        duplicate = f.seq === this.lastRxSeq;
        if (duplicate) this.stats.duplicates++;
        else this.lastRxSeq = f.seq;
      } else {
        this.badRun = 0;
      }
    }
    this.emit("rxframe", f, { duplicate });
    if (f.crcOk && !duplicate) this.emit("frame", f);
  }

  #advanceSeq() {
    this.txSeq = this.txSeq === 0xff ? 1 : this.txSeq + 1;
  }

  #pump() {
    while (this.state === "active" && !this.#inFlight && this.#queue.length) {
      const item = this.#queue.shift();
      if (item.reliable) {
        item.resends = 0;
        item.resyncs = 0;
        this.#inFlight = item;
        this.#transmit(item);
      } else {
        this.#transmit(item);
        item.resolve();
      }
    }
  }

  #transmit(item) {
    const bytes = encodeFrame({ ...item, seq: this.txSeq });
    if (item.sends++ > 0) this.stats.resends++;
    this.stats.tx++;
    this.#out(bytes, { frame: true, resend: item.sends > 1 });
    if (item.reliable) {
      clearTimeout(this.#timers.ack);
      this.#timers.ack = setTimeout(() => this.#onAckTimeout(), this.timing.ackTimeoutMs);
    }
  }

  #onAckTimeout() {
    const item = this.#inFlight;
    if (!item) return;
    if (item.resends < this.timing.maxResends) {
      item.resends++;
      this.#transmit(item);
    } else if (item.resyncs < this.timing.maxResyncs) {
      item.resyncs++;
      item.resends = 0;
      this.#out(HELLO_BURST, { ctrl: CTRL.HELLO });
      this.#timers.ack = setTimeout(() => this.#onAckTimeout(), this.timing.ackTimeoutMs);
    } else {
      this.#inFlight = null;
      this.#advanceSeq();
      item.reject(new LinkDownError("no ACK after all resends and resyncs"));
      this.#goIdle("peer stopped acknowledging");
    }
  }

  #failAll(err) {
    if (this.#inFlight) this.#inFlight.reject(err);
    this.#inFlight = null;
    for (const item of this.#queue.splice(0)) item.reject(err);
  }
}
