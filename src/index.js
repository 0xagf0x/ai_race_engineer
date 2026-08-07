import dgram from "node:dgram";
import { config } from "./config.js";
import { createState, applyF1, applyGT7 } from "./state.js";
import * as F1 from "./f1/parser.js";
import { startGT7 } from "./gt7/client.js";
import { startServer } from "./server.js";
import { Engineer } from "./engineer.js";
import { Coach } from "./coach.js";
import { Callouts } from "./callouts.js";

const log = {
  info: (...a) => console.log("[bridge]", ...a),
  error: (...a) => console.error("[bridge]", ...a),
};

const state = createState();
const engineer = new Engineer(state);
const coach = new Coach();

let pttDown = false;

// ---------- Dashboard server ----------
const server = startServer(config.httpPort, async (msg) => {
  switch (msg.type) {
    case "ask": {
      // Driver spoke; transcript arrives from the browser's STT
      server.broadcast({ type: "engineer-thinking" });
      const reply = await engineer.ask(msg.text);
      if (reply) server.broadcast({ type: "engineer", text: reply, ask: msg.text });
      break;
    }
    case "reset-conversation":
      engineer.reset();
      break;
    case "ptt": // on-screen / keyboard PTT from the browser
      server.broadcast({ type: "ptt", pressed: !!msg.pressed, source: "ui" });
      break;
  }
}, log);

const callouts = new Callouts(state, (text) => {
  if (config.autoCallouts) server.broadcast({ type: "engineer", text, auto: true });
});

// ---------- F1 25 UDP ----------
const f1sock = dgram.createSocket("udp4");
f1sock.on("message", (buf) => {
  const header = F1.parseHeader(buf);
  if (!header) return;

  switch (header.packetId) {
    case F1.PacketId.SESSION: {
      const s = F1.parseSession(buf);
      applyF1(state, "session", s, header);
      coach.setTrack(`f1-${s.trackId}`);
      if (coach.reference && s.trackLength) coach.reference.trackLength = s.trackLength;
      break;
    }
    case F1.PacketId.LAP_DATA: {
      const d = F1.parseLapData(buf);
      if (d) applyF1(state, "lap", d, header);
      break;
    }
    case F1.PacketId.PARTICIPANTS: {
      const d = F1.parseParticipants(buf);
      if (d) applyF1(state, "participants", d, header);
      break;
    }
    case F1.PacketId.CAR_TELEMETRY: {
      const d = F1.parseCarTelemetry(buf);
      if (!d) break;
      applyF1(state, "telemetry", d, header);
      const lap = state.player.lap;
      if (lap) {
        coach.sample({
          dist: lap.lapDistance,
          speed: state.player.speed,
          brake: state.player.brake,
          gear: state.player.gear,
          lapNum: lap.currentLapNum,
          lapMsAtSample: lap.currentLapMs,
          invalid: lap.invalid,
        });
        state.coach = coach.next(lap.lapDistance);
      }
      break;
    }
    case F1.PacketId.CAR_STATUS: {
      const d = F1.parseCarStatus(buf);
      if (d) applyF1(state, "status", d, header);
      break;
    }
    case F1.PacketId.CAR_DAMAGE: {
      const d = F1.parseCarDamage(buf);
      if (d) applyF1(state, "damage", d, header);
      break;
    }
    case F1.PacketId.EVENT: {
      const ev = F1.parseEvent(buf);
      handleF1Event(ev);
      break;
    }
  }
});
f1sock.on("error", (e) => log.error("F1 socket:", e.message));
f1sock.bind(config.f1.port, () => log.info(`F1 25: listening on UDP :${config.f1.port}`));

function handleF1Event(ev) {
  if (ev.code === "BUTN") {
    const pressed = (ev.buttonStatus & config.f1.pttMask) !== 0;
    if (config.pttMode === "toggle") {
      if (pressed && !pttDown) {
        pttDown = true;
        server.broadcast({ type: "ptt-toggle" });
      } else if (!pressed) {
        pttDown = false;
      }
    } else {
      if (pressed !== pttDown) {
        pttDown = pressed;
        server.broadcast({ type: "ptt", pressed, source: "controller" });
      }
    }
    return;
  }
  callouts.onEvent(ev, (idx) => state._participants?.drivers?.[idx]?.name);
}

// ---------- GT7 ----------
if (config.gt7.ps5Ip) {
  startGT7(config.gt7, (t) => {
    if (t.paused) return;
    applyGT7(state, t);
    coach.setTrack("gt7-current"); // GT7 doesn't broadcast a track id
    coach.gt7Sample({ speedMs: t.speedMs, brake: t.brake, gear: t.gear, lapCount: t.lapCount, now: Date.now() });
    state.coach = coach.next(coach.gt7Dist);
  }, log);
} else {
  log.info("GT7: disabled (set GT7_PS5_IP in .env to enable)");
}

// ---------- Broadcast loop ----------
setInterval(() => {
  const live = Date.now() - state.lastPacketAt < 3000;
  server.broadcast({
    type: "state",
    live,
    game: live ? state.game : null,
    session: state.session,
    player: state.player,
    opponents: state.opponents,
    coach: state.coach,
  });
  if (live) callouts.tick();
}, 100); // 10 Hz to the browser

log.info(`PTT: ${config.pttMode} mode, F1 button mask 0x${config.f1.pttMask.toString(16)} (bind "UDP Action 1" in F1's controls)`);
if (!config.apiKey) log.error("ANTHROPIC_API_KEY not set — the engineer will not be able to talk.");
