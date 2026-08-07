// Packet inspector. Dumps what the game is actually sending so struct strides
// and new packet ids can be verified against a real build instead of guessed at.
//
//   node tools/inspect.js
//
// Stop the bridge first: both processes bind the same UDP ports.
// Leave it running for a lap or two, then quit with ctrl-c for the summary.

import dgram from "node:dgram";
import { parseHeader, headerSize, PacketId } from "../src/f1/parser.js";
import { decryptGT7, parseGT7 } from "../src/gt7/client.js";
import { config } from "../src/config.js";

const NAMES = Object.fromEntries(
  Object.entries(PacketId).map(([k, v]) => [v, k]),
);
const seen = new Map(); // `${format}:${id}:${len}` -> count
const formats = new Set();
let playerIdx = null;
let lastF1 = 0;
let lastGT7 = 0;
const lock = process.argv[2];
if (lock && !["A", "B", "~", "C"].includes(lock)) {
  console.error(`Unknown heartbeat "${lock}". Use A, B, ~ or C.`);
  process.exit(1);
}
const variants = lock ? [lock] : ["A", "B", "~", "C"];
let vi = 0;

// Candidate grid sizes and the leading/trailing byte counts per packet, so the
// inspector can show which combination divides cleanly. -1 means the extra byte
// is leading (before the car array) rather than trailing.
const EXTRA = { 2: 2, 4: -1, 5: 4, 6: 3, 8: -1 };

function solutions(len, format, id) {
  const e = EXTRA[id] ?? 0;
  const leading = e === -1 ? 1 : 0;
  const trailing = e === -1 ? 0 : e;
  const payload = len - headerSize(format) - leading - trailing;
  const out = [];
  for (const n of [20, 22, 24, 26]) {
    if (payload > 0 && payload % n === 0)
      out.push(`${n} cars x ${payload / n}b`);
  }
  return out.length ? out.join(" | ") : "no clean division";
}

function guard(sock, port, what) {
  sock.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(
        `\nPort ${port} is already in use. Stop the bridge (npm start) before running inspect.\n`,
      );
      process.exit(1);
    }
    console.error(`${what} socket error:`, e.message);
  });
}

// ---------- F1 ----------
const f1 = dgram.createSocket("udp4");
guard(f1, config.f1.port, "F1");
f1.on("message", (buf) => {
  lastF1 = Date.now();
  const h = parseHeader(buf);
  if (!h) {
    const fmt = buf.length >= 2 ? buf.readUInt16LE(0) : "?";
    const key = `unknown-format:${fmt}:${buf.length}`;
    if (!seen.has(key)) {
      seen.set(key, 0);
      console.log(`unrecognised packet format ${fmt}, ${buf.length} bytes`);
    }
    seen.set(key, seen.get(key) + 1);
    return;
  }
  formats.add(h.packetFormat);
  playerIdx = h.playerCarIndex;

  const key = `${h.packetFormat}:${h.packetId}:${buf.length}`;
  if (!seen.has(key)) {
    seen.set(key, 0);
    const name = NAMES[h.packetId] ?? "UNKNOWN";
    console.log(
      `format=${h.packetFormat} game=${h.gameYear} id=${String(h.packetId).padStart(2)} ${name.padEnd(21)} ` +
        `size=${String(buf.length).padStart(5)} v${h.packetVersion}  ${solutions(buf.length, h.packetFormat, h.packetId)}`,
    );
    if (name === "UNKNOWN") {
      console.log(
        `   ^ new packet id. If this is the 2026 pack, note the id and size so it can be wired into src/f1/parser.js`,
      );
    }
  }
  seen.set(key, seen.get(key) + 1);
});
f1.bind(config.f1.port, () =>
  console.log(`Listening for F1 on :${config.f1.port}...`),
);

// ---------- GT7 ----------
// GT7 exposes richer packets behind different heartbeat characters. "A" is the
// original 296-byte packet, "B" adds motion channels, "~" adds unfiltered pedal
// input and "C" was added later still. Cycle through them and report which
// answer, and at what size.

if (config.gt7.ps5Ip) {
  const gt = dgram.createSocket("udp4");
  guard(gt, config.gt7.receivePort, "GT7");
  gt.on("message", (buf) => {
    lastGT7 = Date.now();
    const key = `gt7:${variants[vi]}:${buf.length}`;
    if (seen.has(key)) {
      seen.set(key, seen.get(key) + 1);
      return;
    }
    seen.set(key, 1);
    const dec = decryptGT7(buf);
    let extra = "";
    if (dec) {
      try {
        const t = parseGT7(dec);
        extra = ` gear=${t.gear} speed=${Math.round(t.speedMs * 3.6)}kph lap=${t.lapCount} onTrack=${t.onTrack}`;
      } catch {
        /* the extended variants shift fields around, expected */
      }
    }
    console.log(
      `gt7 heartbeat="${variants[vi]}" size=${buf.length} decrypt=${dec ? "OK" : "FAILED"}${extra}`,
    );
    if (!dec && buf.length !== 296) {
      console.log(
        `   ^ decrypt failed on a ${buf.length}-byte packet. The extended variants use a different IV constant (0xDEADBEEF rather than 0xDEADBEAF).`,
      );
    }
  });

  gt.bind(config.gt7.receivePort, () =>
    console.log(
      `Heartbeating GT7 at ${config.gt7.ps5Ip}:${config.gt7.sendPort}, ` +
        (lock ? `locked to "${lock}"` : `cycling A / B / ~ / C...`),
    ),
  );

  setInterval(
    () =>
      gt.send(Buffer.from(variants[vi]), config.gt7.sendPort, config.gt7.ps5Ip),
    1500,
  );

  if (!lock) {
    setInterval(() => {
      vi = (vi + 1) % variants.length;
      console.log(`--- switching heartbeat to "${variants[vi]}" ---`);
    }, 9000);
  }
} else {
  console.log("GT7 disabled (set GT7_PS5_IP in .env to enable)");
}

// ---------- idle nudges ----------
// The most common confusion is a silent inspector that looks like a hang. Say
// something rather than sitting there.
console.log("\nWaiting for packets. Ctrl-c for the summary.\n");
let nagged = false;
setTimeout(() => {
  if (!lastF1 && !nagged) {
    nagged = true;
    console.log(
      `No F1 packets after 15s. Check: the game is in a session (not menus), Telemetry Settings > UDP Telemetry is On, ` +
        `UDP IP is this machine's LAN address, port is ${config.f1.port}, and UDP Format is 2025 or 2026.`,
    );
  }
  if (config.gt7.ps5Ip && !lastGT7) {
    console.log(
      `No GT7 packets after 15s. GT7 must be in a session, not in menus, and ${config.gt7.ps5Ip} must be the PS5's current IP.`,
    );
  }
}, 15000);

process.on("SIGINT", () => {
  console.log(`\n--- summary ---`);
  console.log(`F1 formats seen: ${[...formats].join(", ") || "none"}`);
  console.log(`player car index: ${playerIdx ?? "unknown"}`);
  const f1Keys = [...seen.entries()].filter(([k]) => !k.startsWith("gt7:"));
  const gtKeys = [...seen.entries()].filter(([k]) => k.startsWith("gt7:"));
  if (f1Keys.length) {
    console.log(`\nF1 packets (format:id:size  count):`);
    for (const [k, n] of f1Keys.sort()) console.log(`  ${k}  x${n}`);
  }
  if (gtKeys.length) {
    console.log(`\nGT7 packets (heartbeat:size  count):`);
    for (const [k, n] of gtKeys.sort())
      console.log(`  ${k.replace("gt7:", "")}  x${n}`);
  }
  process.exit(0);
});
