// Live session state, merged from whichever game is currently sending packets.
// This is the single source of truth for the dashboard and the engineer.
//
// One convention worth knowing: every four-element wheel array in here is
// FL FR RL RR. The F1 wire format sends RL RR FL FR, so it gets reordered on
// the way in and nothing downstream has to remember which game it came from.

import {
  SESSION_TYPES,
  WEATHER,
  SAFETY_CAR,
  VISUAL_TYRES,
  ACTUAL_TYRES,
  PIT_STATUS,
  FUEL_MIX,
  ERS_DEPLOY_MODE,
  DRIVER_STATUS,
  RESULT_STATUS,
  TRACK_META,
  trackName,
  teamName,
  sessionMode,
  ersMaxJoules,
} from "./f1/enums.js";

export function createState() {
  return {
    game: null, // "f1" | "gt7"
    format: null, // packet format the game is sending, e.g. 2025 or 2026
    lastPacketAt: 0,
    session: {}, // track, type, mode, weather, forecast, temps, safety car
    player: {}, // live car: speed, gear, rpm, pedals, tyres, fuel, ers, damage
    opponents: [], // F1 only: sorted timing tower
    coach: null, // next braking zone from the lap learner
    coachFeedback: null, // grading of the last braking zone against reference
    delta: null, // live delta to the reference lap
    priors: null, // what we know from previous visits to this circuit
    trackKey: null, // circuit identity: F1 track id, or GT7 geometric fingerprint
    history: {}, // per-car lap/sector history from packet 11
    tyreSets: null, // player's available sets from packet 12
    events: [], // rolling log of notable events
  };
}

const ms = (v) => (v > 0 ? v : null);

// wire order RL RR FL FR -> FL FR RL RR
const wheels = (a) =>
  Array.isArray(a) && a.length === 4 ? [a[2], a[3], a[0], a[1]] : a;

function fmtLap(msVal) {
  if (!msVal || msVal <= 0) return null;
  const m = Math.floor(msVal / 60000);
  const s = ((msVal % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

// Track the widest energy store we have actually seen, so a regulation change
// that raises the cap can't pin the gauge at 100 percent forever.
let ersObservedMax = 0;

export function applyF1(state, kind, data, header) {
  state.game = "f1";
  state.format = header.packetFormat;
  state.lastPacketAt = Date.now();
  const p = header.playerCarIndex;
  const fmt = header.packetFormat;

  switch (kind) {
    case "session": {
      const meta = TRACK_META[data.trackId];
      state.session = {
        sessionUID: header.sessionUID,
        track: trackName(data.trackId, fmt),
        trackId: data.trackId,
        trackLength: data.trackLength || meta?.length || null,
        type: SESSION_TYPES[data.sessionType] ?? "Session",
        mode: sessionMode(data.sessionType),
        weather: WEATHER[data.weather] ?? "",
        trackTemp: data.trackTemp,
        airTemp: data.airTemp,
        totalLaps: data.totalLaps,
        timeLeft: data.sessionTimeLeft,
        pitSpeedLimit: data.pitSpeedLimit,
        safetyCar: SAFETY_CAR[data.safetyCarStatus] ?? "none",
        // Pit loss starts as the seeded estimate and is replaced by a measured
        // value the first time the player completes a stop here.
        pitLossSec:
          state.session.measuredPitLossSec ?? meta?.pitLossSec ?? null,
        measuredPitLossSec: state.session.measuredPitLossSec ?? null,
        forecast: summariseForecast(data.forecast),
      };
      break;
    }

    case "lap": {
      const me = data[p];
      const lap = (state.player.lap ??= {});
      Object.assign(lap, {
        position: me.position,
        gridPosition: me.gridPosition,
        currentLapNum: me.currentLapNum,
        currentLap: fmtLap(me.currentLapMs),
        currentLapMs: me.currentLapMs,
        lastLap: fmtLap(me.lastLapMs),
        lastLapMs: ms(me.lastLapMs),
        s1Ms: ms(me.s1Ms + me.s1Min * 60000),
        s2Ms: ms(me.s2Ms + me.s2Min * 60000),
        lapDistance: me.lapDistance,
        totalDistance: me.totalDistance,
        sector: me.sector + 1,
        invalid: !!me.currentLapInvalid,
        penalties: me.penalties,
        warnings: me.totalWarnings,
        cornerCuttingWarnings: me.cornerCuttingWarnings,
        driverStatus: DRIVER_STATUS[me.driverStatus] ?? "",
        resultStatus: RESULT_STATUS[me.resultStatus] ?? "",
        pit: PIT_STATUS[me.pitStatus] ?? "",
        pitStops: me.numPitStops,
        pitLaneTimeMs: me.pitLaneTimeMs,
        deltaAheadMs: me.deltaAheadMs + (me.deltaAheadMin || 0) * 60000,
        deltaLeaderMs: me.deltaLeaderMs + (me.deltaLeaderMin || 0) * 60000,
        safetyCarDelta: me.safetyCarDelta,
      });
      learnPitLoss(state, me);
      state._lapDataRaw = data;
      break;
    }

    case "participants":
      state._participants = data;
      break;

    case "setups":
      state.player.setup = data[p] ?? null;
      break;

    case "telemetry": {
      const me = data.cars[p];
      Object.assign(state.player, {
        speed: me.speed,
        gear: me.gear,
        rpm: me.rpm,
        throttle: me.throttle,
        brake: me.brake,
        steer: me.steer,
        drs: !!me.drs,
        suggestedGear: data.suggestedGear,
        tyreSurfaceTemps: wheels(me.tyreSurfaceTemps),
        tyreInnerTemps: wheels(me.tyreInnerTemps),
        tyrePressures: wheels(me.tyrePressures)?.map((x) => +x.toFixed(1)),
        brakeTemps: wheels(me.brakeTemps),
        engineTemp: me.engineTemp,
      });
      break;
    }

    case "status": {
      const me = data[p];
      const cap = Math.max(
        ersMaxJoules(fmt),
        (ersObservedMax = Math.max(ersObservedMax, me.ersStoreEnergy || 0)),
      );
      state.player.status = {
        fuelInTank: +me.fuelInTank.toFixed(2),
        fuelCapacity: +me.fuelCapacity.toFixed(1),
        // The MFD value, which is a surplus and not a range: laps of fuel
        // beyond what finishing requires. Negative means genuinely short. Named
        // for what it is, because the old name had the engineer reporting a
        // healthy +2.8 lap margin as "under three laps of fuel left".
        fuelDeltaLaps: +me.fuelRemainingLaps.toFixed(2),
        fuelMix: FUEL_MIX[me.fuelMix] ?? "",
        tyre: VISUAL_TYRES[me.visualTyreCompound] ?? "?",
        tyreCompound: ACTUAL_TYRES[me.actualTyreCompound] ?? "?",
        tyreAgeLaps: me.tyresAgeLaps,
        drsAllowed: !!me.drsAllowed,
        drsActivationDistance: me.drsActivationDistance,
        brakeBias: me.frontBrakeBias,
        pitLimiter: !!me.pitLimiter,
        ersStorePct: cap
          ? +(((me.ersStoreEnergy || 0) / cap) * 100).toFixed(1)
          : null,
        ersDeployMode: ERS_DEPLOY_MODE[me.ersDeployMode] ?? "",
        ersDeployedThisLapPct: cap
          ? +(((me.ersDeployedThisLap || 0) / cap) * 100).toFixed(1)
          : null,
        ersHarvestedThisLapPct: cap
          ? +(
              (((me.ersHarvestedMGUK || 0) + (me.ersHarvestedMGUH || 0)) /
                cap) *
              100
            ).toFixed(1)
          : null,
        maxRPM: me.maxRPM,
      };
      state._statusRaw = data;
      break;
    }

    case "damage": {
      const me = data[p];
      state.player.damage = {
        tyreWear: wheels(me.tyreWear).map((w) => +w.toFixed(1)),
        tyreDamage: wheels(me.tyreDamage),
        brakeDamage: wheels(me.brakeDamage),
        frontWing: Math.max(me.frontLeftWingDamage, me.frontRightWingDamage),
        rearWing: me.rearWingDamage,
        floor: me.floorDamage,
        diffuser: me.diffuserDamage,
        sidepod: me.sidepodDamage,
      };
      state._damageRaw = data;
      break;
    }

    case "history": {
      if (data?.carIdx == null) break;
      const best = data.laps[data.bestLapNum - 1];
      state.history[data.carIdx] = {
        bestLapMs: ms(best?.lapMs),
        bestS1Ms: ms(data.laps[data.bestS1LapNum - 1]?.s1Ms),
        bestS2Ms: ms(data.laps[data.bestS2LapNum - 1]?.s2Ms),
        bestS3Ms: ms(data.laps[data.bestS3LapNum - 1]?.s3Ms),
        laps: data.laps.map((l) => l.lapMs).filter(Boolean),
        stints: data.stints.map((s) => ({
          endLap: s.endLap,
          compound: VISUAL_TYRES[s.visualCompound] ?? "?",
          actual: ACTUAL_TYRES[s.actualCompound] ?? "?",
        })),
      };
      if (data.carIdx === p) {
        state.player.lap ??= {};
        state.player.lap.bestLapMs = state.history[p].bestLapMs;
        state.player.lap.bestLap = fmtLap(state.history[p].bestLapMs);
        // The theoretical best from your own session bests, which is the number
        // every timing screen shows and we previously didn't have.
        const h = state.history[p];
        if (h.bestS1Ms && h.bestS2Ms && h.bestS3Ms) {
          const ideal = h.bestS1Ms + h.bestS2Ms + h.bestS3Ms;
          state.player.lap.idealLapMs = ideal;
          state.player.lap.idealLap = fmtLap(ideal);
        }
      }
      break;
    }

    case "tyreSets": {
      if (data?.carIdx !== p) break;
      state.tyreSets = {
        fittedIdx: data.fittedIdx,
        sets: data.sets
          .filter((s) => s.available)
          .map((s) => ({
            compound: VISUAL_TYRES[s.visualCompound] ?? "?",
            actual: ACTUAL_TYRES[s.actualCompound] ?? "?",
            wearPct: s.wearPct,
            usableLifeLaps: s.usableLifeLaps,
            lapDeltaMs: s.lapDeltaMs,
            fitted: s.fitted,
          })),
      };
      break;
    }
  }

  rebuildOpponents(state, p, fmt);
}

function summariseForecast(forecast) {
  if (!forecast?.length) return null;
  // Only the samples for the session we are actually in, and only the ones
  // close enough to matter on the radio.
  return forecast
    .filter((f) => f.timeOffsetMin > 0 && f.timeOffsetMin <= 60)
    .slice(0, 4)
    .map((f) => ({
      inMin: f.timeOffsetMin,
      weather: WEATHER[f.weather] ?? "",
      rainPercent: f.rainPercent,
      trackTemp: f.trackTemp,
    }));
}

// Measure how long a real stop costs at this circuit. pitLaneTimeMs counts up
// while the player is in the lane; when it resets to zero we keep the peak.
let pitLanePeak = 0;
function learnPitLoss(state, me) {
  if (me.pitLaneTimerActive && me.pitLaneTimeMs > pitLanePeak) {
    pitLanePeak = me.pitLaneTimeMs;
    return;
  }
  if (!me.pitLaneTimerActive && pitLanePeak > 5000) {
    const sec = +(pitLanePeak / 1000).toFixed(1);
    state.session.measuredPitLossSec = sec;
    state.session.pitLossSec = sec;
    pitLanePeak = 0;
  }
}

function rebuildOpponents(state, playerIdx, fmt) {
  const laps = state._lapDataRaw;
  const parts = state._participants;
  if (!laps || !parts) return;
  const status = state._statusRaw;

  const rows = [];
  for (let i = 0; i < laps.length; i++) {
    const L = laps[i];
    const P = parts.drivers[i];
    if (!P?.name || L.position === 0) continue;
    rows.push({
      idx: i,
      isPlayer: i === playerIdx,
      position: L.position,
      name: P.name,
      team: teamName(P.teamId, fmt),
      lastLap: fmtLap(L.lastLapMs),
      lastLapMs: ms(L.lastLapMs),
      bestLapMs: state.history[i]?.bestLapMs ?? null,
      tyre: status?.[i]
        ? (VISUAL_TYRES[status[i].visualTyreCompound] ?? "?")
        : "?",
      tyreAge: status?.[i]?.tyresAgeLaps ?? null,
      pit: PIT_STATUS[L.pitStatus] ?? "",
      pitStops: L.numPitStops,
      deltaAheadMs: L.deltaAheadMs + (L.deltaAheadMin || 0) * 60000,
      deltaLeaderMs: L.deltaLeaderMs + (L.deltaLeaderMin || 0) * 60000,
      penalties: L.penalties,
      lapNum: L.currentLapNum,
      status: RESULT_STATUS[L.resultStatus] ?? "",
    });
  }
  rows.sort((a, b) => a.position - b.position);
  state.opponents = rows;
}

export function applyGT7(state, t) {
  state.game = "gt7";
  state.lastPacketAt = Date.now();
  state.session = {
    ...state.session,
    track: state.session.track ?? "GT7 session",
    type: t.lapsInRace > 0 ? "Race" : "Session",
    mode: t.lapsInRace > 0 ? "race" : "practice",
    totalLaps: t.lapsInRace || null,
    safetyCar: "none",
  };
  Object.assign(state.player, {
    speed: Math.round(t.speedMs * 3.6),
    gear: t.gear,
    suggestedGear: t.suggestedGear === 15 ? null : t.suggestedGear,
    rpm: Math.round(t.rpm),
    throttle: t.throttle,
    brake: t.brake,
    // GT7 sends FL FR RL RR already
    tyreSurfaceTemps: t.tyreTemps.map((x) => Math.round(x)),
    onTrack: t.onTrack,
    paused: t.paused,
    // World coordinates, used by the track model. Deliberately not called
    // "position": that name means grid/race position everywhere else in here,
    // and the collision is a bug waiting to happen.
    worldPosition: t.position,
  });
  state.player.status = {
    fuelInTank: +t.fuelLevel.toFixed(2),
    fuelCapacity: t.fuelCapacity,
    maxRPM: t.maxAlertRPM,
  };
  state.player.lap = {
    ...state.player.lap,
    position: t.startPosition > 0 ? t.startPosition : null,
    currentLapNum: t.lapCount,
    lastLapMs: t.lastLapMs > 0 ? t.lastLapMs : null,
    lastLap: fmtLap(t.lastLapMs),
    bestLapMs: t.bestLapMs > 0 ? t.bestLapMs : null,
    bestLap: fmtLap(t.bestLapMs),
  };
  state.opponents = []; // GT7 telemetry is own-car only
}

// Compact snapshot injected into the engineer's context window. Keep this tight:
// it is sent on every radio message, so anything that isn't worth a sentence on
// the radio doesn't belong here.
export function engineerSnapshot(state) {
  const st = state.player.status ?? {};
  const s = {
    game: state.game,
    session: {
      ...state.session,
      forecast: state.session.forecast ?? undefined,
    },
    car: {
      speedKph: state.player.speed,
      gear: state.player.gear,
      rpm: state.player.rpm,
      drs: state.player.drs,
      tyreOrder: "FL FR RL RR",
      tyreSurfaceTempsC: state.player.tyreSurfaceTemps,
      tyrePressuresPsi: state.player.tyrePressures,
      engineTempC: state.player.engineTemp,
      damage: state.player.damage,
      ...st,
    },
    lap: state.player.lap,
    coach: state.coach,
  };

  // Live delta to the reference lap, and where the time is going.
  if (state.delta) s.delta = state.delta;
  // What happened on previous visits to this circuit.
  if (state.priors) s.priors = state.priors;

  if (state.tyreSets?.sets?.length) {
    s.tyreSetsAvailable = state.tyreSets.sets;
  }
  if (state.game === "f1" && state.opponents.length) {
    s.timingTower = state.opponents.map((o) => ({
      pos: o.position,
      name: o.name + (o.isPlayer ? " (YOU)" : ""),
      team: o.team,
      lastLap: o.lastLap,
      tyre: `${o.tyre}${o.tyreAge != null ? ` (${o.tyreAge} laps)` : ""}`,
      gapToCarAhead:
        o.position === 1 ? "-" : `${(o.deltaAheadMs / 1000).toFixed(1)}s`,
      pit: o.pit || undefined,
      pitStops: o.pitStops,
      penaltiesSec: o.penalties || undefined,
    }));
  }
  return s;
}
