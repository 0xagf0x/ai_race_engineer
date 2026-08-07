// GT7 telemetry client.
// GT7 sends encrypted 296-byte UDP packets to whoever heartbeats it:
//   - we send "A" to PS5:33739 every ~1.5s
//   - PS5 sends telemetry to our :33740
// Payload is Salsa20-encrypted with a fixed key; nonce derived from bytes 0x40-0x43.

import dgram from "node:dgram";
import { salsa20 } from "./salsa20.js";

const KEY = Buffer.from("Simulator Interface Packet GT7 ver 0.0").subarray(0, 32);
const MAGIC = 0x47375330; // "G7S0"

export function decryptGT7(buf) {
  if (buf.length < 0x94) return null;
  const iv1 = buf.readUInt32LE(0x40);
  const iv2 = (iv1 ^ 0xdeadbeaf) >>> 0;
  const nonce = Buffer.alloc(8);
  nonce.writeUInt32LE(iv2, 0);
  nonce.writeUInt32LE(iv1, 4);
  const dec = salsa20(KEY, nonce, buf);
  if (dec.readUInt32LE(0) !== MAGIC) return null;
  return dec;
}

export function parseGT7(dec) {
  const flags = dec.readUInt16LE(0x8e);
  const gearByte = dec.readUInt8(0x90);
  return {
    position: { x: dec.readFloatLE(0x04), y: dec.readFloatLE(0x08), z: dec.readFloatLE(0x0c) },
    rpm: dec.readFloatLE(0x3c),
    fuelLevel: dec.readFloatLE(0x44),
    fuelCapacity: dec.readFloatLE(0x48),
    speedMs: dec.readFloatLE(0x4c),
    boost: dec.readFloatLE(0x50) - 1,
    waterTemp: dec.readFloatLE(0x58),
    oilTemp: dec.readFloatLE(0x5c),
    tyreTemps: [dec.readFloatLE(0x60), dec.readFloatLE(0x64), dec.readFloatLE(0x68), dec.readFloatLE(0x6c)],
    packetId: dec.readInt32LE(0x70),
    lapCount: dec.readInt16LE(0x74),
    lapsInRace: dec.readInt16LE(0x76),
    bestLapMs: dec.readInt32LE(0x78),
    lastLapMs: dec.readInt32LE(0x7c),
    startPosition: dec.readInt16LE(0x84),
    numCarsAtStart: dec.readInt16LE(0x86),
    maxAlertRPM: dec.readInt16LE(0x8a),
    calculatedMaxSpeed: dec.readInt16LE(0x8c),
    onTrack: !!(flags & 0x0001),
    paused: !!(flags & 0x0002),
    inGear: !!(flags & 0x0008),
    revLimiter: !!(flags & 0x0020),
    gear: gearByte & 0x0f,
    suggestedGear: (gearByte >> 4) & 0x0f, // 15 = none
    throttle: dec.readUInt8(0x91) / 255,
    brake: dec.readUInt8(0x92) / 255,
  };
}

export function startGT7({ ps5Ip, receivePort, sendPort }, onPacket, log = console) {
  const sock = dgram.createSocket("udp4");
  let lastRx = 0;

  sock.on("message", (msg) => {
    const dec = decryptGT7(msg);
    if (!dec) return;
    lastRx = Date.now();
    try {
      onPacket(parseGT7(dec));
    } catch (e) {
      log.error("GT7 parse error:", e.message);
    }
  });

  sock.on("error", (e) => log.error("GT7 socket error:", e.message));

  sock.bind(receivePort, () => {
    log.info(`GT7: listening on :${receivePort}, heartbeating ${ps5Ip}:${sendPort}`);
  });

  const hb = setInterval(() => {
    sock.send(Buffer.from("A"), sendPort, ps5Ip);
  }, 1500);

  return {
    close() { clearInterval(hb); sock.close(); },
    isLive: () => Date.now() - lastRx < 3000,
  };
}
