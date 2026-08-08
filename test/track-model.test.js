// Track model tests. A synthetic ellipse stands in for a circuit: we know its
// true arc length analytically, so we can check the learned centreline against
// ground truth rather than against itself.

import test from "node:test";
import assert from "node:assert/strict";
import { TrackModel } from "../src/gt7/track-model.js";

const A = 400,
  B = 200;
const point = (t) => ({ x: A * Math.cos(t), z: B * Math.sin(t) });

const trueLength = (() => {
  let L = 0;
  for (let i = 1; i <= 4000; i++) {
    const p = point(((i - 1) / 4000) * 2 * Math.PI);
    const q = point((i / 4000) * 2 * Math.PI);
    L += Math.hypot(p.x - q.x, p.z - q.z);
  }
  return L;
})();

function drivenModel() {
  const m = new TrackModel();
  for (let i = 0; i < 2000; i++) {
    const p = point((i / 2000) * 2 * Math.PI);
    m.addSample({ x: p.x, z: p.z, lapCount: 0 });
  }
  m.addSample({ x: A, z: 0, lapCount: 1 }); // lap rollover builds the model
  return m;
}

test("learns a centreline from one lap", () => {
  const m = drivenModel();
  assert.ok(m.ready);
  assert.ok(
    Math.abs(m.lengthM - trueLength) / trueLength < 0.01,
    `length ${m.lengthM} vs ${trueLength}`,
  );
});

test("projects a point on the line to near-zero lateral", () => {
  const m = drivenModel();
  const q = point(Math.PI / 2);
  const p = m.project(q.x, q.z);
  assert.ok(p.lateralM < 1);
  assert.ok(Math.abs(p.distanceM - trueLength / 4) / trueLength < 0.03);
});

test("measures lateral offset off the line and flags it wide", () => {
  const m = drivenModel();
  const q = point(Math.PI / 2);
  const p = m.project(q.x, q.z + 12);
  assert.ok(Math.abs(p.lateralM - 12) < 1.5);
  assert.equal(p.wide, true);
});

test("tracks a full lap without losing the line", () => {
  const m = drivenModel();
  let maxErr = 0;
  for (let i = 0; i < 2000; i++) {
    const p = point((i / 2000) * 2 * Math.PI);
    maxErr = Math.max(maxErr, m.project(p.x, p.z).lateralM);
  }
  assert.ok(maxErr < 1.5, `max lateral error ${maxErr}`);
});

test("distance increases monotonically around the lap", () => {
  const m = drivenModel();
  let jumps = 0,
    prev = -1;
  for (let i = 0; i < 2000; i++) {
    const p = point((i / 2000) * 2 * Math.PI);
    const d = m.project(p.x, p.z).distanceM;
    if (prev >= 0 && d < prev - 50) jumps++;
    prev = d;
  }
  assert.ok(jumps <= 1, "only the start/finish wrap should go backwards");
});
