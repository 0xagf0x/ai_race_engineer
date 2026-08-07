// Live session state, merged from whichever game is currently sending packets.
// This is the single source of truth for the dashboard and the engineer's context.

import { TRACKS, SESSION_TYPES, WEATHER, VISUAL_TYRES, PIT_STATUS, TEAMS } from "./f1/enums.js";

export function createState() {
  return {
    game: null, // "f1" | "gt7"
    lastPacketAt: 0,
    session: {},      // track, sessionType, weather, temps, totalLaps
    player: {},       // live car: speed, gear, rpm, throttle, brake, tyres, fuel, damage
    opponents: [],    // F1 only: sorted timing tower
    coach: null,      // next braking zone info from the lap learner
    events: [],       // rolling log of notable events
  };
}

const ms = (v) => (v > 0 ? v : null);
function fmtLap(msVal) {
  if (!msVal || msVal <= 0) return null;
  const m = Math.floor(msVal / 60000);
  const s = ((msVal % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

export function applyF1(state, kind, data, header) {
  state.game = "f1";
  state.lastPacketAt = Date.now();
  const p = header.playerCarIndex;

  switch (kind) {
    case "session":
      state.session = {
        track: TRACKS[data.trackId] ?? `Track ${data.trackId}`,
        trackId: data.trackId,
        trackLength: data.trackLength,
        type: SESSION_TYPES[data.sessionType] ?? "Session",
        weather: WEATHER[data.weather] ?? "",
        trackTemp: data.trackTemp,
        airTemp: data.airTemp,
        totalLaps: data.totalLaps,
        timeLeft: data.sessionTimeLeft,
      };
      break;

    case "lap": {
      const me = data[p];
      Object.assign((state.player.lap ??= {}), {
        position: me.position,
        currentLapNum: me.currentLapNum,
        currentLap: fmtLap(me.currentLapMs),
        currentLapMs: me.currentLapMs,
        lastLap: fmtLap(me.lastLapMs),
        lastLapMs: ms(me.lastLapMs),
        lapDistance: me.lapDistance,
        sector: me.sector + 1,
        invalid: !!me.currentLapInvalid,
        penalties: me.penalties,
        pit: PIT_STATUS[me.pitStatus] ?? "",
        deltaAheadMs: me.deltaAheadMs + (me.deltaAheadMin || 0) * 60000,
      });
      state._lapDataRaw = data;
      break;
    }

    case "participants":
      state._participants = data;
      break;

    case "telemetry": {
      const me = data.cars[p];
      Object.assign(state.player, {
        speed: me.speed,
        gear: me.gear,
        rpm: me.rpm,
        throttle: me.throttle,
        brake: me.brake,
        drs: !!me.drs,
        suggestedGear: data.suggestedGear,
        tyreSurfaceTemps: me.tyreSurfaceTemps,
        tyreInnerTemps: me.tyreInnerTemps,
        brakeTemps: me.brakeTemps,
        engineTemp: me.engineTemp,
      });
      break;
    }

    case "status": {
      const me = data[p];
      state.player.status = {
        fuelInTank: +me.fuelInTank.toFixed(2),
        fuelRemainingLaps: +me.fuelRemainingLaps.toFixed(2),
        tyre: VISUAL_TYRES[me.visualTyreCompound] ?? "?",
        tyreAgeLaps: me.tyresAgeLaps,
        drsAllowed: !!me.drsAllowed,
        ersDeployMode: me.ersDeployMode,
        fuelMix: me.fuelMix,
        maxRPM: me.maxRPM,
      };
      state._statusRaw = data;
      break;
    }

    case "damage": {
      const me = data[p];
      state.player.damage = {
        tyreWear: me.tyreWear.map((w) => +w.toFixed(1)),
        frontWing: Math.max(me.frontLeftWingDamage, me.frontRightWingDamage),
        rearWing: me.rearWingDamage,
        floor: me.floorDamage,
      };
      state._damageRaw = data;
      break;
    }
  }

  rebuildOpponents(state, p);
}

function rebuildOpponents(state, playerIdx) {
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
      team: TEAMS[P.teamId] ?? "",
      lastLap: fmtLap(L.lastLapMs),
      tyre: status ? (VISUAL_TYRES[status[i].visualTyreCompound] ?? "?") : "?",
      tyreAge: status ? status[i].tyresAgeLaps : null,
      pit: PIT_STATUS[L.pitStatus] ?? "",
      pitStops: L.numPitStops,
      deltaAheadMs: L.deltaAheadMs + (L.deltaAheadMin || 0) * 60000,
      penalties: L.penalties,
      lapNum: L.currentLapNum,
    });
  }
  rows.sort((a, b) => a.position - b.position);
  state.opponents = rows;
}

export function applyGT7(state, t) {
  state.game = "gt7";
  state.lastPacketAt = Date.now();
  state.session = { track: "GT7 session", type: t.lapsInRace > 0 ? "Race" : "Session", totalLaps: t.lapsInRace || null };
  Object.assign(state.player, {
    speed: Math.round(t.speedMs * 3.6),
    gear: t.gear,
    suggestedGear: t.suggestedGear === 15 ? null : t.suggestedGear,
    rpm: Math.round(t.rpm),
    throttle: t.throttle,
    brake: t.brake,
    tyreSurfaceTemps: t.tyreTemps.map((x) => Math.round(x)),
    onTrack: t.onTrack,
    paused: t.paused,
  });
  state.player.status = {
    fuelInTank: +t.fuelLevel.toFixed(2),
    fuelCapacity: t.fuelCapacity,
    maxRPM: t.maxAlertRPM,
  };
  state.player.lap = {
    position: t.startPosition > 0 ? t.startPosition : null,
    currentLapNum: t.lapCount,
    lastLapMs: t.lastLapMs > 0 ? t.lastLapMs : null,
    lastLap: fmtLap(t.lastLapMs),
    bestLap: fmtLap(t.bestLapMs),
  };
  state.opponents = []; // GT7 telemetry is own-car only
}

// Compact snapshot injected into the engineer's context window.
export function engineerSnapshot(state) {
  const s = {
    game: state.game,
    session: state.session,
    car: {
      speedKph: state.player.speed,
      gear: state.player.gear,
      rpm: state.player.rpm,
      drs: state.player.drs,
      tyreSurfaceTempsC: state.player.tyreSurfaceTemps,
      engineTempC: state.player.engineTemp,
      damage: state.player.damage,
      ...state.player.status,
    },
    lap: state.player.lap,
    coach: state.coach,
  };
  if (state.game === "f1" && state.opponents.length) {
    s.timingTower = state.opponents.map((o) => ({
      pos: o.position,
      name: o.name + (o.isPlayer ? " (YOU)" : ""),
      team: o.team,
      lastLap: o.lastLap,
      tyre: `${o.tyre}${o.tyreAge != null ? ` (${o.tyreAge} laps)` : ""}`,
      gapToCarAhead: o.position === 1 ? "-" : `${(o.deltaAheadMs / 1000).toFixed(1)}s`,
      pit: o.pit || undefined,
      pitStops: o.pitStops,
      penaltiesSec: o.penalties || undefined,
    }));
  }
  return s;
}
