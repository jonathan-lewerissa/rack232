import assert from "node:assert/strict";
import { test } from "node:test";
import { bandDb, findBands, parseDb, parseHz, parseQ } from "../public/js/peq.js";

test("parses the device's display text", () => {
  assert.equal(parseHz("226.3 Hz"), 226.3);
  assert.equal(parseHz("1.81 kHz"), 1810);
  assert.equal(parseDb("+3.0 dB"), 3);
  assert.equal(parseDb("-Inf"), null);
  assert.equal(parseQ("Q 2.8"), 2.8);
});

test("finds Fc/Gain/Q triples in any order and skips shelf bands", () => {
  const P = (text) => ({ text });
  const params = [P("On"), P("100 Hz"), P("BW 12"), P("+2.0 dB"), P("1.00 kHz"), P("Q 2"), P("-3.0 dB"), P("LShelf")];
  const { bands, type } = findBands(params);
  assert.equal(bands.length, 1);
  assert.deepEqual([bands[0].freq.text, bands[0].q.text, bands[0].gain.text], ["1.00 kHz", "Q 2", "-3.0 dB"]);
  assert.equal(type.text, "LShelf");
});

test("biquad curves hit their gain where they should", () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.05, `${a} vs ${b}`);
  near(bandDb(1000, { hz: 1000, db: 6, q: 1 }), 6);
  near(bandDb(10000, { hz: 1000, db: 6, q: 4 }), 0);
  near(bandDb(20, { hz: 1000, db: -9, q: 0.7, kind: "low" }), -9);
  near(bandDb(18000, { hz: 1000, db: -9, q: 0.7, kind: "low" }), 0);
  near(bandDb(18000, { hz: 1000, db: 5, q: 0.7, kind: "high" }), 5);
  near(bandDb(20, { hz: 1000, db: 5, q: 0.7, kind: "high" }), 0);
});
