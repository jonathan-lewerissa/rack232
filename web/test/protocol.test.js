import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { CTRL, FrameParser, crc8, encodeFrame } from "../public/js/frame.js";
import { Link } from "../public/js/link.js";
import { MSG, decode, payload, req } from "../public/js/messages.js";
import { Session } from "../public/js/session.js";
import { SimulatedDriveRack } from "../public/js/sim.js";
import { createLoopback } from "../public/js/transport.js";

const running = [];
const track = (...xs) => (running.push(...xs), xs[0]);
afterEach(() => running.splice(0).forEach((x) => x.stop()));

const FAST = { helloMs: 10, ackTimeoutMs: 40, keepaliveMs: 200, rxSilenceMs: 2000 };
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

// Bit-at-a-time Dallas/Maxim CRC-8 as an independent reference for the table version.
function crcBitwise(bytes, crc) {
  for (const byte of bytes) {
    let b = byte;
    for (let i = 0; i < 8; i++) {
      const mix = (crc ^ b) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      b >>= 1;
    }
  }
  return crc;
}

test("crc8 is Dallas/Maxim with init 0xFF", () => {
  const check = Array.from("123456789", (c) => c.charCodeAt(0));
  assert.equal(crc8(check, 0x00), 0xa1); // published CRC-8/MAXIM check value
  const sample = [0x01, 0x90, 0x07, 0x06, 0x94, 0x00, 0x03, 0x05, 0x18, 0x00];
  assert.equal(crc8(sample), crcBitwise(sample, 0xff));
  assert.notEqual(crc8(sample), crcBitwise(sample, 0x00));
});

test("frames round-trip, including len 0 = 256 and control bytes between frames", () => {
  const got = [];
  const ctrl = [];
  const parser = new FrameParser({ onFrame: (f) => got.push(f), onControl: (b) => ctrl.push(b) });
  const big = new Uint8Array(256).map((_, i) => i); // payload bytes >= 0x80 must not be treated as control
  const a = encodeFrame({ dst: 0x01, src: 0x10, reliable: true, seq: 7, payload: req.paramWrite(3, 5, 24) });
  const b = encodeFrame({ dst: 0x10, src: 0x01, payload: big });
  assert.deepEqual([...a.slice(0, 4)], [0x01, 0x90, 0x07, 0x06]);
  assert.equal(b[2], 0);
  parser.push([CTRL.ACK, ...a, CTRL.KEEPALIVE, ...b]);
  assert.deepEqual(ctrl, [CTRL.ACK, CTRL.KEEPALIVE]);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((f) => [f.dst, f.src, f.reliable, f.seq, f.crcOk]), [[1, 0x10, true, 7, true], [0x10, 1, false, null, true]]);
  assert.deepEqual(decode(got[0].payload).name, "PARAM_WRITE");
  assert.deepEqual([...got[1].payload], [...big]);

  const corrupted = Uint8Array.from(a);
  corrupted[5] ^= 0x01;
  parser.push(corrupted);
  assert.equal(got[2].crcOk, false);
});

function linkPair({ hostToDevice, deviceToHost } = {}) {
  const [h, d] = createLoopback();
  const hostEnd = { write: (b) => h.write(hostToDevice ? hostToDevice(b) : b), onData: (f) => h.onData(f) };
  const devEnd = { write: (b) => d.write(deviceToHost ? deviceToHost(b) : b), onData: (f) => d.onData(f) };
  const host = new Link({ write: (b) => hostEnd.write(b), timing: FAST });
  const dev = new Link({ write: (b) => devEnd.write(b), timing: FAST, initiate: false });
  hostEnd.onData((b) => host.feed(b));
  devEnd.onData((b) => dev.feed(b));
  track(host, dev);
  return { host, dev };
}

test("link comes up from hello/resync and a NAKed frame is resent and delivered once", async () => {
  let corruptNext = true;
  const { host, dev } = linkPair({
    hostToDevice: (b) => {
      if (corruptNext && b[0] < 0x80) {
        corruptNext = false;
        const c = Uint8Array.from(b);
        c[c.length - 2] ^= 0xff;
        return c;
      }
      return b;
    },
  });
  const delivered = [];
  dev.on("frame", (f) => delivered.push(f));
  host.start();
  dev.start();
  await until(() => host.state === "active" && dev.state === "active");
  const seq0 = host.txSeq;
  await host.send({ dst: 1, src: 0x10, payload: req.deviceData() });
  await host.send({ dst: 1, src: 0x10, payload: req.deviceName() });
  assert.deepEqual(delivered.map((f) => decode(f.payload).name), ["SYSTEM_REQUEST_DEVICE_DATA", "SYSTEM_REQUEST_DEVICE_NAME"]);
  assert.deepEqual(delivered.map((f) => f.seq), [seq0, seq0 + 1]);
  assert.equal(host.stats.naks, 1);
  assert.equal(dev.stats.crcErrors, 1);
});

test("a lost ACK causes a resend that the receiver ACKs but drops as a duplicate", async () => {
  let dropAck = true;
  const { host, dev } = linkPair({
    deviceToHost: (b) => {
      if (dropAck && b.length === 1 && b[0] === CTRL.ACK) {
        dropAck = false;
        return new Uint8Array(0);
      }
      return b;
    },
  });
  const delivered = [];
  dev.on("frame", (f) => delivered.push(f));
  host.start();
  dev.start();
  await until(() => host.state === "active" && dev.state === "active");
  await host.send({ dst: 1, src: 0x10, payload: req.muteStatus() });
  assert.equal(delivered.length, 1);
  assert.equal(host.stats.resends, 1);
  assert.equal(dev.stats.duplicates, 1);
});

test("link gives up and drops to idle when the peer never ACKs", async () => {
  const { host, dev } = linkPair({ deviceToHost: (b) => (b.length === 1 && b[0] === CTRL.ACK ? new Uint8Array(0) : b) });
  host.timing.maxResends = 1;
  host.timing.maxResyncs = 1;
  host.start();
  dev.start();
  await until(() => host.state === "active");
  await assert.rejects(host.send({ dst: 1, src: 0x10, payload: req.utility() }), /no ACK/);
  assert.equal(host.state, "idle");
});

test("session connects to the simulator, discovers the chain and edits it", async () => {
  const [hostEnd, devEnd] = createLoopback();
  const sim = new SimulatedDriveRack(devEnd, { timing: FAST });
  const link = track(new Link({ write: (b) => hostEnd.write(b), timing: FAST }), sim);
  hostEnd.onData((b) => link.feed(b));
  const session = new Session(link, { replyTimeoutMs: 300, quietMs: 60 });
  let ready = false;
  session.on("status", (s) => (ready = s === "Ready"));
  link.start();
  await until(() => ready, 10000);

  const m = session.model;
  assert.equal(m.addressesFrom, "identify");
  assert.equal(m.hostAddr, 0x10);
  assert.equal(m.deviceAddr, 0x01);
  assert.equal(m.model, "DriveRack 260");
  assert.equal(m.firmware, "1.510");
  assert.equal(m.programs.length, 50);
  assert.equal(m.programs[1], "LCRw/Cluster");
  assert.equal(m.programs[26], "LCRw/Cluster");
  assert.equal(m.counts.a, 25);
  assert.equal(m.fx.length, sim.chain.length);
  const geq = m.fx[0];
  assert.equal(geq.name, "GEQ Ch 1");
  assert.equal(geq.params.length, 29);
  assert.deepEqual([geq.params[16].prompt, geq.params[16].value, geq.params[16].inputType, geq.params[16].text], ["1k Hz", 24, 0x14, "0.0 dB"]);
  assert.deepEqual(m.supports, { inputType: true, prompt: true, valueText: true });

  // Rapid edits coalesce; the device ends at the last value and reports its text.
  for (let v = 25; v <= 40; v++) session.setParam(0, 16, v);
  await until(() => geq.params[16].text === "+8.0 dB");
  assert.equal(sim.chain[0].params[16].value, 40);
  const writes = sim.received.filter((id) => id === MSG.PARAM_WRITE).length;
  assert.ok(writes < 16, `expected coalesced writes, got ${writes}`);

  await session.setMute(4, true);
  assert.equal(sim.muteMask, 0b10000);
  assert.equal(m.muteMask, 0b10000);

  // Factory program 28 (index 27) is read-only: the store lands in user program 3 (index 2).
  await session.storeProgram(27, "My Gig");
  assert.equal(m.programs[2], "My Gig");
  assert.equal(m.programs[27], "1x4w/2Zones");
  assert.equal(m.currentProgram, 2);

  await session.loadProgram(25);
  assert.equal(m.currentProgram, 25);
  // Labels are cached by block, so a program change does not ask for every prompt again.
  const totalParams = sim.chain.reduce((n, b) => n + b.params.length, 0);
  assert.equal(sim.received.filter((id) => id === MSG.PARAM_REQUEST_PROMPT_STRING).length, totalParams);
  assert.equal(m.fx[5].params[2].prompt, "Band 1 Gain");
  assert.equal(m.fx[0].params[16].value, 24); // factory program restored
  await session.loadProgram(2);
  assert.equal(m.fx[0].params[16].value, 40); // stored edit came back

});

test("unanswered optional requests are asked once and then skipped", async () => {
  const [hostEnd, devEnd] = createLoopback();
  const sim = new SimulatedDriveRack(devEnd, { timing: FAST });
  // Make the simulator ignore prompt requests, as a real 260 might.
  const handle = sim.link;
  const silenced = MSG.PARAM_REQUEST_PROMPT_STRING;
  const origEmit = handle.emit.bind(handle);
  handle.emit = (name, f, ...rest) => (name === "frame" && f.payload[0] === silenced ? undefined : origEmit(name, f, ...rest));
  const link = track(new Link({ write: (b) => hostEnd.write(b), timing: FAST }), sim);
  hostEnd.onData((b) => link.feed(b));
  const session = new Session(link, { replyTimeoutMs: 100, quietMs: 60 });
  let ready = false;
  session.on("status", (s) => (ready = s === "Ready"));
  link.start();
  await until(() => ready, 10000);
  assert.equal(session.model.supports.prompt, false);
  assert.equal(session.model.supports.inputType, true);
  assert.equal(session.model.fx[0].params[1].prompt, null);
});

test("decode flags lengths outside the message table", () => {
  assert.equal(decode(payload(MSG.PARAM_WRITE, 1, 2)).warning, "length 4 outside 6..6");
  assert.equal(decode(payload(0x1234)).warning, "unknown message ID");
  assert.deepEqual(decode(payload(MSG.SYSTEM_REPLY_DEVICE_DATA, 0, 0x31, 0x35, 0x31, 0x30, 0x45, 0, 0)).fields, {
    firmware: "1.510",
    typeChar: "E",
    model: "DriveRack 260",
  });
});
