import dgram from "node:dgram";
import { config } from "./config.js";
import { createState, applyF1, applyGT7 } from "./state.js";
import * as F1 from "./f1/parser.js";
import { startGT7 } from "./gt7/client.js";
import { startServer } from "./server.js";
import { Engineer } from "./engineer.js";
import { Coach } from "./coach.js";
import { Callouts } from "./callouts.js";
import { RaceArc } from "./racearc.js";
import { describePenalty } from "./f1/penalties.js";
import { TrackModel } from "./gt7/track-model.js";
import { Delta } from "./delta.js";
import { SessionStore } from "./sessions.js";

const log = {
  info: (...a) => console.log("[bridge]", ...a),
  error: (...a) => console.error("[bridge]", ...a),
};

// Order matters: engineer holds references to state and arc, so both exist
// first. const is hoisted but not initialised, so getting this wrong is a
// ReferenceError at boot rather than a silent undefined.
const state = createState();
const arc = new RaceArc();
const engineer = new Engineer(state, arc);
const coach = new Coach();
const track = new TrackModel();
const delta = new Delta();
const sessions = new SessionStore();

let pttDown = false;

// GT7 sends no lap timer, so we keep our own for the delta.
let gt7Lap = null;
let gt7LapStart = Date.now();

const say = (text) =>
  text && server.broadcast({ type: "engineer", text, auto: true });

// Record the session that just ended, debrief it, then clear down for the next
// one. Order is the whole point: building the record reads the arc, so saving
// has to happen before the reset or every record comes out empty.
function endSession(reason) {
  const record = sessions.build(state, arc, delta);
  const saved = sessions.save(record);
  if (saved) {
    log.info(`Session recorded (${reason})`);
    // Not awaited: the debrief is in flight while history clears, which is fine
    // because it reads the record rather than the conversation.
    engineer.debrief(record, state.priors).then(say);
  }
  arc.reset();
  engineer.reset();
  sessions.begin();
  return saved;
}

// Load what we know about a circuit and, if we have been here before, have the
// engineer say so as the driver goes out.
function loadPriors(trackKey, label) {
  if (!trackKey || state._priorsKey === trackKey) return;
  state._priorsKey = trackKey;
  state.trackKey = trackKey;
  state.priors = sessions.priors(trackKey);
  if (!state.priors) return;
  log.info(
    `Priors: ${state.priors.sessionsHere} previous sessions at ${label}`,
  );
  engineer.openSession(state.priors).then(say);
}

// ---------- Dashboard server ----------
const server = startServer(
  config.httpPort,
  async (msg) => {
    switch (msg.type) {
      case "ask": {
        server.broadcast({ type: "engineer-thinking" });
        const reply = await engineer.ask(msg.text);
        if (reply)
          server.broadcast({ type: "engineer", text: reply, ask: msg.text });
        break;
      }
      case "reset-conversation":
        engineer.reset();
        break;
      case "feedback-level":
        callouts.setLevel(msg.level);
        log.info(`Feedback level: ${callouts.level}`);
        break;
      case "ptt":
        server.broadcast({ type: "ptt", pressed: !!msg.pressed, source: "ui" });
        break;
    }
  },
  log,
);

const callouts = new Callouts(
  state,
  engineer,
  (text) => server.broadcast({ type: "engineer", text, auto: true }),
  { level: config.feedbackLevel },
);

// ---------- F1 UDP ----------
const f1sock = dgram.createSocket("udp4");
f1sock.on("message", (buf) => {
  const header = F1.parseHeader(buf);
  if (!header) return;

  switch (header.packetId) {
    case F1.PacketId.MOTION: {
      const d = F1.parseMotion(buf, header);
      if (d) state._motionRaw = d;
      break;
    }
    case F1.PacketId.SESSION: {
      // A new session id means quali became the race: bank the old session
      // before wiping the arc that the record is built from.
      if (
        state.session.sessionUID &&
        state.session.sessionUID !== header.sessionUID
      ) {
        endSession("new session id");
      }
      const s = F1.parseSession(buf, header);
      applyF1(state, "session", s, header);

      loadPriors(`f1-${s.trackId}`, state.session.track);

      coach.setTrack(`f1-${header.packetFormat}-${s.trackId}`);
      coach.setTrackLength(state.session.trackLength);
      break;
    }
    case F1.PacketId.LAP_DATA: {
      const d = F1.parseLapData(buf, header);
      if (d) applyF1(state, "lap", d, header);
      break;
    }
    case F1.PacketId.PARTICIPANTS: {
      const d = F1.parseParticipants(buf, header);
      if (d) applyF1(state, "participants", d, header);
      break;
    }
    case F1.PacketId.CAR_SETUPS: {
      const d = F1.parseCarSetups(buf, header);
      if (d) applyF1(state, "setups", d, header);
      break;
    }
    case F1.PacketId.CAR_TELEMETRY: {
      const d = F1.parseCarTelemetry(buf, header);
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
        delta.setTrack(
          `f1-${header.packetFormat}-${state.session.trackId}`,
          state.session.trackLength,
        );
        delta.update(
          lap.lapDistance,
          lap.currentLapMs,
          lap.currentLapNum,
          lap.invalid,
        );
        state.coach = coach.next(lap.lapDistance);
        state.coachFeedback = coach.feedback;
        state.delta = delta.brief();
      }
      break;
    }
    case F1.PacketId.CAR_STATUS: {
      const d = F1.parseCarStatus(buf, header);
      if (d) applyF1(state, "status", d, header);
      break;
    }
    case F1.PacketId.CAR_DAMAGE: {
      const d = F1.parseCarDamage(buf, header);
      if (d) applyF1(state, "damage", d, header);
      break;
    }
    case F1.PacketId.SESSION_HISTORY: {
      const d = F1.parseSessionHistory(buf, header);
      if (d) applyF1(state, "history", d, header);
      break;
    }
    case F1.PacketId.TYRE_SETS: {
      const d = F1.parseTyreSets(buf, header);
      if (d) applyF1(state, "tyreSets", d, header);
      break;
    }
    case F1.PacketId.FINAL_CLASSIFICATION: {
      const d = F1.parseFinalClassification(buf, header);
      if (d) state.finalClassification = d;
      // Backstop in case the chequered flag event was missed. save() is
      // idempotent per session, so a double fire costs nothing.
      endSession("final classification");
      break;
    }
    case F1.PacketId.EVENT: {
      handleF1Event(F1.parseEvent(buf, header));
      break;
    }
    case F1.PacketId.LOBBY:
    case F1.PacketId.MOTION_EX:
    case F1.PacketId.TIME_TRIAL:
      break;
    default:
      F1.noteUnknownPacket(header.packetId, buf.length);
  }
});
f1sock.on("error", (e) => log.error("F1 socket:", e.message));
f1sock.bind(config.f1.port, () =>
  log.info(`F1: listening on UDP :${config.f1.port}`),
);

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
    } else if (pressed !== pttDown) {
      pttDown = pressed;
      server.broadcast({ type: "ptt", pressed, source: "controller" });
    }
    return;
  }

  // Only our own penalties and incidents go into the arc; everyone else's are
  // timing tower noise.
  const me = state.opponents?.find((o) => o.isPlayer);
  if (ev.code === "PENA" && ev.vehicleIdx === me?.idx) {
    arc.notePenalty(describePenalty(ev));
  }
  if (
    ev.code === "COLL" &&
    (ev.vehicle1Idx === me?.idx || ev.vehicle2Idx === me?.idx)
  ) {
    const otherIdx =
      ev.vehicle1Idx === me?.idx ? ev.vehicle2Idx : ev.vehicle1Idx;
    const other = state._participants?.drivers?.[otherIdx]?.name;
    arc.note(
      "incident",
      `contact${other ? ` with ${other}` : " with another car"}`,
    );
  }

  callouts.onEvent(ev, (idx) => state._participants?.drivers?.[idx]?.name);

  // The flag is the natural end of a session; final classification follows as
  // a backstop a moment later.
  if (ev.code === "CHQF") setTimeout(() => endSession("chequered flag"), 2000);
}

// ---------- GT7 ----------
if (config.gt7.ps5Ip) {
  startGT7(
    config.gt7,
    (t) => {
      if (t.paused) return;
      applyGT7(state, t);

      // Geometry first: the track model turns world position into an exact lap
      // distance, which is what the coach and the delta both key off. Until a
      // full lap has been learned, fall back to the integrated estimate.
      track.addSample({
        x: t.position.x,
        z: t.position.z,
        lapCount: t.lapCount,
      });
      const proj = track.project(t.position.x, t.position.z);

      if (t.lapCount !== gt7Lap) {
        gt7Lap = t.lapCount;
        gt7LapStart = Date.now();
      }

      coach.setTrack(track.key ?? "gt7-learning");
      // Null until the first full lap builds the centreline, so this has to run
      // every packet rather than once at setTrack.
      coach.setTrackLength(track.lengthM);
      coach.gt7Sample({
        speedMs: t.speedMs,
        brake: t.brake,
        gear: t.gear,
        lapCount: t.lapCount,
        now: Date.now(),
      });

      const distM = proj?.distanceM ?? coach.gt7Dist;
      state.coach = coach.next(distM);
      state.coachFeedback = coach.feedback;

      if (proj) {
        state.player.lap.lapDistance = proj.distanceM;
        state.player.lateralM = proj.lateralM;

        // Once the circuit is identified by geometry it can carry priors and a
        // delta reference the same way an F1 track id does.
        loadPriors(track.key, "this circuit");

        delta.setTrack(track.key, track.lengthM);
        delta.update(
          proj.distanceM,
          Date.now() - gt7LapStart,
          t.lapCount,
          false,
        );
        state.delta = delta.brief();

        // GT7 never reports track limits, so we measure them: a lateral offset
        // well outside this driver's own normal line at this point of the
        // circuit is a genuine excursion.
        if (proj.wide)
          arc.note("wide", `ran wide at ${Math.round(proj.distanceM)} metres`);
        else track.learnSpread(proj.distanceM, proj.lateralM);
      }
    },
    log,
  );
} else {
  log.info("GT7: disabled (set GT7_PS5_IP in .env to enable)");
}

// ---------- Broadcast loop ----------
let wasLive = false;
setInterval(() => {
  const live = Date.now() - state.lastPacketAt < 3000;

  server.broadcast({
    type: "state",
    live,
    game: live ? state.game : null,
    format: state.format,
    session: state.session,
    player: state.player,
    opponents: state.opponents,
    coach: state.coach,
    delta: state.delta,
    tyreSets: state.tyreSets,
    feedbackLevel: callouts.level,
  });

  if (live) {
    // The arc has to be updated before the callouts run, or the mood the
    // engineer speaks with is one tick stale.
    arc.update(state);
    callouts.tick();
  } else if (wasLive && state.game === "gt7") {
    // GT7 has no chequered flag event, so the session ends when the packets do.
    endSession("gt7 telemetry stopped");
  }
  wasLive = live;
}, 100);

// A clean exit should still bank the session rather than throwing it away.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    endSession("bridge shutting down");
    process.exit(0);
  });
}

log.info(
  `PTT: ${config.pttMode} mode, F1 button mask 0x${config.f1.pttMask.toString(16)} (bind "UDP Action 1" in F1's controls)`,
);
log.info(`Feedback: ${callouts.level}`);
if (!config.apiKey) {
  log.error(
    "ANTHROPIC_API_KEY not set — the engineer will not be able to talk.",
  );
}
