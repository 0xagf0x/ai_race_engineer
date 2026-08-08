// Delta tests. Synthetic laps at a known pace, so the expected delta is exact
// rather than eyeballed.
//
// Each test gets a fresh data directory, because a promoted reference persists
// to disk and would otherwise leak into the next test.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Delta } from "../src/delta.js";

const LEN = 3000;
const DATA = path.resolve(
  process.env.RACE_DATA_DIR ?? ".tmp-test-data",
  "tracks",
);

function fresh(key) {
  fs.rmSync(path.join(DATA, `${key}-delta.json`), { force: true });
  const d = new Delta();
  d.setTrack(key, LEN);
  return d;
}

// Drive a lap at an even pace, optionally bleeding `loss.ms` between two points.
function drive(d, lapNum, lapMs, loss = null) {
  const steps = 600;
  for (let i = 0; i <= steps; i++) {
    const dist = (i / steps) * LEN;
    let t = (i / steps) * lapMs;
    if (loss && dist > loss.from) {
      const through = Math.min(1, (dist - loss.from) / (loss.to - loss.from));
      t += through * loss.ms;
    }
    d.update(dist, t, lapNum, false);
  }
}

test("no delta until a reference lap exists", () => {
  const d = fresh("t-empty");
  assert.equal(d.ready, false);
  assert.equal(d.value, null);
});

test("first clean lap becomes the reference", () => {
  const d = fresh("t-ref");
  drive(d, 1, 90000);
  d.update(0, 0, 2, false);
  assert.ok(d.ready);
  assert.ok(Math.abs(d.refLapMs - 90000) < 50);
});

test("an identical lap reads zero at the line", () => {
  const d = fresh("t-zero");
  drive(d, 1, 90000);
  d.update(0, 0, 2, false);
  drive(d, 2, 90000);
  assert.equal(typeof d.value, "number", "must not go null at the finish line");
  assert.ok(Math.abs(d.value) < 60, `delta was ${d.value}`);
});

test("a slower lap reads the right delta and blames the right stretch", () => {
  const d = fresh("t-loss");
  drive(d, 1, 90000);
  d.update(0, 0, 2, false);
  drive(d, 2, 90000, { from: 1000, to: 1400, ms: 1000 });
  assert.ok(Math.abs(d.value - 1000) < 150, `delta was ${d.value}`);

  d.update(0, 0, 3, false);
  const worst = d.worstSegments(3);
  assert.ok(worst.length > 0);
  assert.ok(
    worst[0].fromM >= 800 && worst[0].toM <= 1600,
    `blamed ${worst[0].fromM}-${worst[0].toM}`,
  );
  assert.ok(Math.abs(worst[0].lostSec - 1) < 0.2, `lost ${worst[0].lostSec}`);
});

test("only quicker, valid laps replace the reference", () => {
  const d = fresh("t-promote");
  drive(d, 1, 90000);
  d.update(0, 0, 2, false);

  drive(d, 2, 95000);
  d.update(0, 0, 3, false);
  assert.ok(Math.abs(d.refLapMs - 90000) < 50, "slower lap must not promote");

  drive(d, 3, 88500);
  d.update(0, 0, 4, false);
  assert.ok(Math.abs(d.refLapMs - 88500) < 50, "quicker lap must promote");

  drive(d, 4, 80000);
  d.update(0, 0, 5, true);
  assert.ok(Math.abs(d.refLapMs - 88500) < 50, "invalid lap must not promote");
});
