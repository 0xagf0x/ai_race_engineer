// Packet inspector: dumps live F1 packet ids/sizes and GT7 decrypt status.
// Use this to validate struct strides against the actual game build.
//   node tools/inspect.js

import dgram from "node:dgram";
import { parseHeader } from "../src/f1/parser.js";
import { decryptGT7 } from "../src/gt7/client.js";
import { config } from "../src/config.js";

const seen = new Map();

const f1 = dgram.createSocket("udp4");
f1.on("message", (buf) => {
  const h = parseHeader(buf);
  if (!h) return;
  const key = `f1 id=${h.packetId}`;
  if (!seen.has(key)) {
    seen.set(key, buf.length);
    const perCar = ((buf.length - 29) / 22).toFixed(2);
    console.log(`${key} format=${h.packetFormat} size=${buf.length} (payload/22 = ${perCar})`);
  }
});
f1.bind(config.f1.port, () => console.log(`Listening for F1 on :${config.f1.port}...`));

if (config.gt7.ps5Ip) {
  const gt = dgram.createSocket("udp4");
  gt.on("message", (buf) => {
    const key = "gt7";
    if (!seen.has(key)) {
      seen.set(key, buf.length);
      const dec = decryptGT7(buf);
      console.log(`gt7 size=${buf.length} decrypt=${dec ? "OK (magic G7S0)" : "FAILED"}`);
    }
  });
  gt.bind(config.gt7.receivePort);
  setInterval(() => gt.send(Buffer.from("A"), config.gt7.sendPort, config.gt7.ps5Ip), 1500);
  console.log(`Heartbeating GT7 at ${config.gt7.ps5Ip}:${config.gt7.sendPort}...`);
}
