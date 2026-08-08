// Coach tests. Synthetic laps with brake points at known distances, so the
// expected grading is exact rather than eyeballed.
//
// These cover three fixes that are otherwise invisible: GT7 laps carrying a
// real lap time (without one, the first lap locked in as the reference
// forever), zone de-duping measured against the last zone kept rather than the
// last one seen, and next() refusing to report a negative distance.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Coach } from "../src/coach.js";

const LEN = 3000;
const DATA = path.resolve(
  process.env.RACE_DATA_DIR ?? ".tmp-test-data",
  "tracks",
);

function fresh(key, trackLength = LEN) {
  fs.rmSync(path.join(DATA, `${key}.json`), { force: true });
  const c = new Coach();
  c.setTrack(key);
  c.setTrackLength(trackLength);
  return c;
}

/**
 * Drive one lap, braking hard at each given distance.
 *
 * Each zone runs 150m: hard on the brakes shedding speed to `minSpeed`, then
 * off and accelerating away, which is what both extractZones and _gradeBraking
 * watch for. Everything outside a zone is flat out.
 */
function drive(coach, lapNum, brakePoints, opts = {}) {
  const {
    minSpeed = 90,
    entrySpeed = 250,
    lapMs = 90000,
    invalid = false,
  } = opts;
  const steps = 600;
  for (let i = 0; i <= steps; i++) {
    const d = (i / steps) * LEN;
    const zone = brakePoints.find((b) => d >= b && d < b + 150);
    let speed = entrySpeed;
    let brake = 0;
    let gear = 7;
    if (zone != null) {
      const through = (d - zone) / 150;
      if (through < 0.6) {
        brake = 0.8;
        speed = entrySpeed - (entrySpeed - minSpeed) * (through / 0.6);
        gear = 3;
      } else {
        speed = minSpeed + (entrySpeed - minSpeed) * ((through - 0.6) / 0.4);
        gear = 5;
      }
    }
    coach.sample({
      dist: d,
      speed,
      brake,
      gear,
      lapNum,
      lapMsAtSample: (i / steps) * lapMs,
      invalid,
    });
  }
}

// Same lap shape, fed through the GT7 path, which has no lap distance and no
// lap timer of its own.
function driveGt7(coach, lapCount, brakePoints, opts = {}) {
  const { minSpeed = 90, entrySpeed = 250, lapMs = 90000 } = opts;
  const steps = 600;
  let now = opts.startAt ?? 1_000_000;
  for (let i = 0; i <= steps; i++) {
    const d = (i / steps) * LEN;
    const zone = brakePoints.find((b) => d >= b && d < b + 150);
    let kph = entrySpeed;
    let brake = 0;
    let gear = 7;
    if (zone != null) {
      const through = (d - zone) / 150;
      if (through < 0.6) {
        brake = 0.8;
        kph = entrySpeed - (entrySpeed - minSpeed) * (through / 0.6);
        gear = 3;
      } else {
        kph = minSpeed + (entrySpeed - minSpeed) * ((through - 0.6) / 0.4);
        gear = 5;
      }
    }
    coach.gt7Sample({
      speedMs: kph / 3.6,
      brake,
      gear,
      lapCount,
      now,
    });
    now += lapMs / steps;
  }
  return now;
}

test("learns braking zones from a clean lap", () => {
  const c = fresh("c-learn");
  drive(c, 1, [600, 1500, 2400]);
  drive(c, 2, [600, 1500, 2400]); // lap change completes lap 1
  assert.ok(c.reference, "a clean lap should become the reference");
  assert.equal(c.reference.zones.length, 3);
  assert.ok(
    Math.abs(c.reference.zones[0].start - 600) < 20,
    `first zone at ${c.reference.zones[0].start}`,
  );
});

test("an invalid lap is not learned", () => {
  const c = fresh("c-invalid");
  drive(c, 1, [600, 1500, 2400], { invalid: true });
  drive(c, 2, [600, 1500, 2400], { invalid: true });
  assert.equal(c.reference, null);
});

test("zones closer than the merge gap collapse, separate ones survive", () => {
  // Three zones 50m apart are one corner. Measured against the last zone kept,
  // all three collapse; measured against the last zone seen, the chaining bug
  // let the third through.
  const tight = fresh("c-tight");
  drive(tight, 1, [600, 650, 700]);
  drive(tight, 2, [600, 650, 700]);
  assert.equal(tight.reference.zones.length, 1, "50m apart is one corner");

  const spread = fresh("c-spread");
  drive(spread, 1, [600, 800, 1000]);
  drive(spread, 2, [600, 800, 1000]);
  assert.equal(spread.reference.zones.length, 3, "200m apart is three corners");
});

test("only a quicker lap replaces the reference", () => {
  const c = fresh("c-promote");
  drive(c, 1, [600, 1500, 2400], { lapMs: 90000 });
  drive(c, 2, [600, 1500, 2400], { lapMs: 95000 });
  drive(c, 3, [600, 1500, 2400], { lapMs: 88000 });
  assert.ok(
    Math.abs(c.reference.lapMs - 90000) < 200,
    "slower must not promote",
  );
  drive(c, 4, [600, 1500, 2400]);
  assert.ok(Math.abs(c.reference.lapMs - 88000) < 200, "quicker must promote");
});

test("gt7 laps carry a real lap time and can be improved on", () => {
  const c = fresh("c-gt7");
  let at = driveGt7(c, 1, [600, 1500, 2400], { lapMs: 90000 });
  at = driveGt7(c, 2, [600, 1500, 2400], { lapMs: 90000, startAt: at });
  assert.ok(c.reference, "gt7 lap should become the reference");
  assert.ok(
    c.reference.lapMs > 80000 && c.reference.lapMs < 100000,
    `lap time was ${c.reference.lapMs}, should be near 90000`,
  );

  // Without a lap time on gt7 samples this second, quicker lap could never
  // promote and the first lap driven was the reference forever.
  driveGt7(c, 3, [600, 1500, 2400], { lapMs: 84000, startAt: at });
  driveGt7(c, 4, [600, 1500, 2400], { lapMs: 84000 });
  assert.ok(
    c.reference.lapMs < 88000,
    `quicker gt7 lap must promote, reference is ${c.reference.lapMs}`,
  );
});

test("grades a late brake against the reference", () => {
  const c = fresh("c-grade");
  drive(c, 1, [600, 1500, 2400]);
  // Late into the final corner: feedback holds the most recent graded event,
  // so the last zone of the lap is the one still on it when the lap ends.
  drive(c, 2, [600, 1500, 2440]);
  assert.ok(c.feedback, "a graded braking event should produce feedback");
  assert.equal(c.feedback.cornerIndex, 3);
  assert.match(c.feedback.text, /40 metres later than reference/);
  // An identical line through the corner must not report a gear mismatch.
  assert.doesNotMatch(c.feedback.text, /gear/);
});

test("next() reports the upcoming zone and wraps past the line", () => {
  const c = fresh("c-next");
  drive(c, 1, [600, 1500, 2400]);
  drive(c, 2, [600, 1500, 2400]);

  const mid = c.next(1000);
  assert.equal(mid.zoneStartM, c.reference.zones[1].start);
  assert.ok(mid.brakeInM > 0 && mid.brakeInM < 600);

  // Past the last zone: the next corner is turn 1 on the following lap.
  const wrapped = c.next(2900);
  assert.ok(wrapped.brakeInM > 0, `wrapped distance was ${wrapped.brakeInM}`);
  assert.equal(wrapped.cornerIndex, 1);
});

test("next() returns null rather than a negative distance", () => {
  const c = fresh("c-nolen", null);
  drive(c, 1, [600, 1500, 2400]);
  drive(c, 2, [600, 1500, 2400]);
  c.trackLength = null;
  c.reference.trackLength = null;
  assert.equal(
    c.next(2900),
    null,
    "no track length means no answer, not a negative one",
  );
});
