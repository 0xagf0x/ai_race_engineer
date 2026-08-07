// Parser regression tests. Run with `npm test` (node --test, no dependencies).
//
// The case that matters most here is the 24-car grid: before the layout solver,
// a 24-car packet failed the `payload % 22` check, parseLapData returned null,
// and the bridge went completely blind with nothing logged.

import test from "node:test";
import assert from "node:assert/strict";
import { parseHeader, parseLapData, parseCarStatus } from "../src/f1/parser.js";

function header({ format = 2025, packetId = 2, playerCarIndex = 0 }) {
  const b = Buffer.alloc(29);
  b.writeUInt16LE(format, 0);
  b.writeUInt8(25, 2);
  b.writeUInt8(1, 3);
  b.writeUInt8(0, 4);
  b.writeUInt8(1, 5);
  b.writeUInt8(packetId, 6);
  b.writeBigUInt64LE(1n, 7);
  b.writeFloatLE(12.5, 15);
  b.writeUInt32LE(9, 19);
  b.writeUInt32LE(9, 23);
  b.writeUInt8(playerCarIndex, 27);
  b.writeUInt8(255, 28);
  return b;
}

// lap data carries two trailing bytes after the car array
function lapPacket(numCars, stride, format) {
  const body = Buffer.alloc(numCars * stride + 2);
  for (let i = 0; i < numCars; i++) {
    const o = i * stride;
    body.writeUInt32LE(83456, o); // lastLapMs
    body.writeUInt32LE(41000, o + 4); // currentLapMs
    body.writeFloatLE(1234.5, o + 20); // lapDistance
    body.writeUInt8(i + 1, o + 32); // position
    body.writeUInt8(3, o + 33); // currentLapNum
  }
  const buf = Buffer.concat([header({ format, packetId: 2 }), body]);
  return { buf, header: parseHeader(buf) };
}

test("22-car grid parses", () => {
  const { buf, header: h } = lapPacket(22, 57, 2025);
  const cars = parseLapData(buf, h);
  assert.equal(cars.length, 22);
  assert.equal(cars[0].lastLapMs, 83456);
  assert.equal(cars[5].position, 6);
  assert.equal(Math.round(cars[0].lapDistance), 1235);
});

test("24-car grid parses instead of blacking out", () => {
  const { buf, header: h } = lapPacket(24, 57, 2026);
  const cars = parseLapData(buf, h);
  assert.equal(cars.length, 24);
  assert.equal(cars[23].position, 24);
});

test("24-car grid with a wider per-car struct still parses", () => {
  const { buf, header: h } = lapPacket(24, 64, 2026);
  assert.equal(parseLapData(buf, h).length, 24);
});

test("a 22-car session under the 2026 format still parses", () => {
  const { buf, header: h } = lapPacket(22, 57, 2026);
  assert.equal(parseLapData(buf, h).length, 22);
});

test("unknown packet format is rejected at the header", () => {
  const { buf } = lapPacket(22, 57, 2019);
  assert.equal(parseHeader(buf), null);
});

test("an unsolvable packet returns null rather than throwing", () => {
  const buf = Buffer.concat([
    header({ format: 2025, packetId: 2 }),
    Buffer.alloc(1003),
  ]);
  assert.equal(parseLapData(buf, parseHeader(buf)), null);
});

test("car status reads through to the ERS block", () => {
  const stride = 60;
  const n = 22;
  // walk the field order to get exact offsets
  let off = 0;
  const at = (size) => {
    const v = off;
    off += size;
    return v;
  };
  const F = {
    tc: at(1),
    abs: at(1),
    mix: at(1),
    bias: at(1),
    limiter: at(1),
    fuel: at(4),
    cap: at(4),
    remaining: at(4),
    maxRpm: at(2),
    idleRpm: at(2),
    gears: at(1),
    drs: at(1),
    drsDist: at(2),
    actual: at(1),
    visual: at(1),
    age: at(1),
    flags: at(1),
    ers: at(4),
    mode: at(1),
  };
  const body = Buffer.alloc(n * stride);
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    body.writeFloatLE(103.4, o + F.fuel);
    body.writeFloatLE(12.3, o + F.remaining);
    body.writeUInt8(18, o + F.visual);
    body.writeUInt8(14, o + F.age);
    body.writeFloatLE(3.2e6, o + F.ers);
    body.writeUInt8(3, o + F.mode);
  }
  const buf = Buffer.concat([header({ format: 2025, packetId: 7 }), body]);
  const cars = parseCarStatus(buf, parseHeader(buf));
  assert.ok(Math.abs(cars[0].fuelInTank - 103.4) < 0.01);
  assert.equal(cars[0].tyresAgeLaps, 14);
  assert.ok(Math.abs(cars[0].ersStoreEnergy - 3.2e6) < 1);
  assert.equal(cars[0].ersDeployMode, 3);
});
