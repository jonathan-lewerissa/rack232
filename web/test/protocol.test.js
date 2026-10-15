import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { CTRL, FrameParser, crc8, encodeFrame } from "../public/js/frame.js";
import { Link } from "../public/js/link.js";
import { MSG, decode, payload, readU16, req } from "../public/js/messages.js";
import { Network } from "../public/js/network.js";
import { MODELS } from "../public/js/models.js";
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

const SESSION = { replyTimeoutMs: 300, quietMs: 60 };

// Host link + Network against a simulator; resolves once the selected unit is fully read.
async function connect(simOptions = {}, networkOptions = {}, tweakSim = () => {}) {
  const [hostEnd, devEnd] = createLoopback();
  const sim = new SimulatedDriveRack(devEnd, { timing: FAST, ...simOptions });
  tweakSim(sim);
  const link = track(new Link({ write: (b) => hostEnd.write(b), timing: FAST }), sim);
  hostEnd.onData((b) => link.feed(b));
  const network = new Network(link, { session: SESSION, ...networkOptions });
  link.start();
  await until(() => network.selected?.model.loaded && !network.selected.busy, 10000);
  return { sim, network, session: network.selected };
}

test("session connects to the simulator, discovers the chain and edits it", async () => {
  const { sim, network, session } = await connect();

  const m = session.model;
  assert.equal(network.addressesFrom, "identify");
  assert.deepEqual(network.addresses, [0x01]);
  assert.equal(m.hostAddr, 0x10);
  assert.equal(m.deviceAddr, 0x01);
  assert.equal(m.model, "DriveRack 260");
  assert.equal(m.profile.outputs, 6);
  assert.equal(m.firmware, "1.510");
  assert.equal(m.generation, 3);
  assert.deepEqual([m.utilityBytes, m.utilityLayout], [0xdb, "260/220i"]);
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
  assert.deepEqual(m.errors, []);

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
  // Make the simulator ignore prompt requests, as a real 260 might.
  const { session } = await connect({}, { session: { ...SESSION, replyTimeoutMs: 100 } }, (sim) => {
    const unit = sim.units[0];
    const handle = unit.handle.bind(unit);
    unit.handle = (f) => (readU16(f.payload, 0) === MSG.PARAM_REQUEST_PROMPT_STRING ? undefined : handle(f));
  });
  assert.equal(session.model.supports.prompt, false);
  assert.equal(session.model.supports.inputType, true);
  assert.equal(session.model.fx[0].params[1].prompt, null);
});

test("every single-unit model identifies with its own type, generation and utility layout", async () => {
  const cases = [
    ["DriveRack 240", "24x", 2, 4, "24x"],
    ["DriveRack 241", "24x", 2, 4, "24x"],
    ["DriveRack 261", "260", 3, 6, "260/220i"],
    ["DriveRack 220i", "220i", 4, 2, "260/220i"],
  ];
  for (const [name, family, generation, outputs, layout] of cases) {
    const { sim, session } = await connect({ model: name });
    const m = session.model;
    assert.deepEqual([m.model, m.profile.family, m.generation, m.profile.outputs, m.utilityLayout], [name, family, generation, outputs, layout], name);
    assert.deepEqual(m.errors, [], name);
    assert.equal(m.fx.length, sim.chain.length, name);
    // A mute bit beyond the model's outputs is not kept by the device.
    await session.setMute(outputs, true);
    assert.equal(m.muteMask, 0, name);
    await session.setMute(outputs - 1, true);
    assert.equal(m.muteMask, 1 << (outputs - 1), name);
    running.splice(0).forEach((x) => x.stop());
  }
});

test("a 480 network: master's DID_CONFIG lists the units, each unit is edited at its own address", async () => {
  const { sim, network, session: master } = await connect({ model: "DriveRack 480", units: 3, remote: true });
  assert.equal(network.addressesFrom, "network");
  assert.equal(network.hostAddr, 0x10);
  assert.deepEqual(network.addresses, [0, 1, 2, 0x7d]);
  assert.deepEqual(network.nodes.map((n) => [n.label, !!n.session]),
    [["Master (ID 0)", true], ["ID 1", true], ["ID 2", true], ["480R remote", false]]);
  assert.equal(master.model.deviceAddr, 0);
  assert.deepEqual([master.model.profile.outputs, master.model.utilityLayout], [8, "48x/442"]);

  // The slaves only identify until selected. Replies are kept apart by source address.
  const slave = network.sessions.get(2);
  await until(() => slave.model.deviceName === "Sim 480 #2" && !slave.busy);
  assert.equal(master.model.deviceName, "Sim 480 #0");
  assert.deepEqual(master.model.errors, []);
  assert.equal(network.sessions.get(1).model.model, "DriveRack 480");
  assert.equal(slave.model.loaded, false);
  assert.equal(sim.units[2].received.includes(MSG.CONFIG_REQUEST_ALL), false);

  network.select(2);
  assert.equal(network.selected, slave);
  await until(() => slave.model.loaded && !slave.busy, 10000);
  assert.equal(slave.model.fx.length, sim.units[2].chain.length);

  // Edits go to the selected unit only.
  slave.setParam(0, 5, 30);
  await slave.setMute(7, true);
  assert.equal(sim.units[2].chain[0].params[5].value, 30);
  assert.equal(sim.units[0].chain[0].params[5].value, 24);
  assert.deepEqual(sim.units.map((u) => u.muteMask), [0, 0, 0b10000000]);
  assert.equal(master.model.muteMask, 0);
});

test("without IDENTIFY or DID_CONFIG the fallback addresses are used", async () => {
  const { network, session } = await connect({}, { identifyWaitMs: 50, fallbackHostAddr: 0x10, fallbackDeviceAddr: 0x01 },
    (sim) => (sim.announce = () => {}));
  assert.equal(network.addressesFrom, "fallback");
  assert.equal(session.model.model, "DriveRack 260");
});

test("decode flags lengths outside the message table", () => {
  assert.equal(decode(payload(MSG.PARAM_WRITE, 1, 2)).warning, "length 4 outside 6..6");
  // UTILITY_REPLY length depends on the model family instead.
  for (const len of [0x10, 0x4c, 0x65, 0xdb]) assert.equal(decode(payload(MSG.UTILITY_REPLY, new Array(len - 2).fill(0))).warning, null);
  assert.match(decode(payload(MSG.UTILITY_REPLY, new Array(75).fill(0))).warning, /not one of/);
  assert.equal(decode(payload(0x1234)).warning, "unknown message ID");
  assert.deepEqual(decode(payload(MSG.SYSTEM_REPLY_DEVICE_DATA, 0, 0x31, 0x35, 0x31, 0x30, 0x45, 0, 0)).fields, {
    firmware: "1.510",
    typeChar: "E",
    model: "DriveRack 260",
  });
});

test("device types and the network bitmap decode", () => {
  const type = (c) => decode(payload(MSG.SYSTEM_REPLY_DEVICE_DATA, 0, 0x32, 0x35, 0x30, 0x30, c.charCodeAt(0), 0, 0)).fields.model;
  assert.deepEqual(["0", "2", "C", "A", "B", "F", "'", "Z"].map(type),
    ["DriveRack 480", "DriveRack 482", "DriveRack 442", "DriveRack 240", "DriveRack 241", "DriveRack 261", "DriveRack 220i", "unknown type 'Z'"]);
  assert.equal(new Set(MODELS.map((m) => m.typeChar)).size, MODELS.length);
  // Bit n of [2..17] = address n: addresses 0, 9 and 0x7D.
  const bitmap = new Array(16).fill(0);
  bitmap[0] = 0b1;
  bitmap[1] = 0b10;
  bitmap[15] = 0b100000;
  assert.deepEqual(decode(payload(MSG.NETWORK_DID_CONFIG, bitmap)).fields.addresses, [0, 9, 0x7d]);
});
