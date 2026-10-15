import assert from "node:assert/strict";
import { test } from "node:test";
import { filterDb, findCrossover, parseSlope } from "../public/js/xover.js";

const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test("parses the 12 crossover types the manual lists", () => {
  assert.deepEqual(parseSlope("LR 24"), { family: "LR", db: 24 });
  assert.deepEqual(parseSlope("BS6"), { family: "BS", db: 6 });
  assert.deepEqual(parseSlope("Butterworth 18 dB/oct"), { family: "BW", db: 18 });
  assert.equal(parseSlope("24 dB"), null);
  assert.equal(parseSlope("LR 25"), null);
});

test("filter shapes: BW and BS are -3 dB at fc, LR is -6 dB, slopes are right", () => {
  for (const db of [6, 12, 18, 24]) {
    near(filterDb(1000, { kind: "lp", hz: 1000, family: "BW", db }), -3.01);
    near(filterDb(1000, { kind: "hp", hz: 1000, family: "BS", db }), -3.01);
  }
  for (const db of [12, 24, 36, 48]) near(filterDb(1000, { kind: "hp", hz: 1000, family: "LR", db }), -6.02);
  // Two octaves past fc a 24 dB/oct LR is about 48 dB down.
  near(filterDb(4000, { kind: "lp", hz: 1000, family: "LR", db: 24 }), -48.2, 0.5);
  near(filterDb(250, { kind: "hp", hz: 1000, family: "BW", db: 12 }), -24.1, 0.5);
  assert.equal(filterDb(50, { kind: "hp", hz: "out", family: "LR", db: 48 }), 0);
});

test("groups filters into bands by prompt, gain closing each band", () => {
  const P = (prompt, text, value = 1) => ({ prompt, text, value });
  const { bands } = findCrossover([
    P("Low HPF Fc", "Out", 0), P("Low HPF Type", "LR 24"), P("Low LPF Fc", "134.5 Hz"), P("Low LPF Type", "LR 24"), P("Low Gain", "0.0 dB"),
    P("High HPF Fc", "134.5 Hz"), P("High HPF Type", "BW 12"), P("High LPF Fc", "Out", 120), P("High LPF Type", "LR 24"), P("High Gain", "-Inf"),
  ]);
  assert.deepEqual(bands.map((b) => b.name), ["Low", "High"]);
  assert.deepEqual(bands.map((b) => b.filters.map((f) => f.kind)), [["hp", "lp"], ["hp", "lp"]]);
  assert.equal(bands[1].gain.text, "-Inf");
});

test("without HP/LP in the prompt, the lower filter of a pair is the high-pass", () => {
  const P = (text, value = 1) => ({ prompt: "", text, value });
  const { bands } = findCrossover([P("2.00 kHz"), P("LR 24"), P("200 Hz"), P("LR 24"), P("+1.0 dB")]);
  assert.equal(bands.length, 1);
  assert.deepEqual(bands[0].filters.map((f) => [f.kind, f.freq.text]), [["hp", "200 Hz"], ["lp", "2.00 kHz"]]);
  assert.equal(bands[0].name, "Band 1");
});

test("PEQ and GEQ blocks are not mistaken for a crossover", () => {
  const P = (text) => ({ text, value: 0 });
  assert.equal(findCrossover([P("On"), P("100 Hz"), P("+2.0 dB"), P("Q 2"), P("1.00 kHz"), P("0.0 dB"), P("Q 1")]).bands.length, 0);
});
