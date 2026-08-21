// F1 UDP telemetry parser.
//
// Supports packet formats 2023, 2024, 2025 and the 2026 season pack.
//
// Two things make this tolerant of format changes:
//
// 1. Per-car structs are read from the front with a cursor, then we jump to the
//    next car using a stride computed from the packet size. Codemasters append
//    new fields to the END of these structs, so leading fields stay put.
// 2. The grid size is solved, not assumed. The 2026 season pack runs a 24-car
//    grid in My Team, and the old hardcoded 22 meant every per-car packet
//    failed the divisibility check and was silently dropped — a total telemetry
//    blackout with no error. solveLayout() now tries the plausible grid sizes
//    and keeps whichever produces a sane stride, caching the answer per packet.
//
// Anything we can't make sense of returns null and is counted, not thrown.
// Run `npm run inspect` against a live session to dump real sizes.

const DEFAULT_HEADER_SIZE = 29;
const KNOWN_FORMATS = [2023, 2024, 2025, 2026];
const GRID_CANDIDATES = [22, 24, 20];

// Resolved layouts, keyed by `${format}:${packetId}:${length}` so a mid-session
// format switch or a different session size re-solves instead of reusing a
// stale answer.
const layoutCache = new Map();
const warned = new Set();

function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[f1] ${msg}`);
}

export const stats = {
  packets: 0,
  unparsed: 0,
  unknownFormat: 0,
  unknownPacketIds: new Set(),
};

class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.o = offset;
  }
  left() {
    return this.buf.length - this.o;
  }
  u8() {
    return this.buf.readUInt8(this.o++);
  }
  i8() {
    return this.buf.readInt8(this.o++);
  }
  u16() {
    const v = this.buf.readUInt16LE(this.o);
    this.o += 2;
    return v;
  }
  i16() {
    const v = this.buf.readInt16LE(this.o);
    this.o += 2;
    return v;
  }
  u32() {
    const v = this.buf.readUInt32LE(this.o);
    this.o += 4;
    return v;
  }
  i32() {
    const v = this.buf.readInt32LE(this.o);
    this.o += 4;
    return v;
  }
  u64() {
    const v = this.buf.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  f32() {
    const v = this.buf.readFloatLE(this.o);
    this.o += 4;
    return v;
  }
  f64() {
    const v = this.buf.readDoubleLE(this.o);
    this.o += 8;
    return v;
  }
  skip(n) {
    this.o += n;
    return this;
  }
  seek(o) {
    this.o = o;
    return this;
  }
}

export function headerSize(_format) {
  // No format has moved the header so far. Kept as a function so that if 2027
  // does, there is one place to change.
  return DEFAULT_HEADER_SIZE;
}

export function parseHeader(buf) {
  if (buf.length < DEFAULT_HEADER_SIZE) return null;
  const r = new Reader(buf);
  const h = {
    packetFormat: r.u16(),
    gameYear: r.u8(),
    majorVersion: r.u8(),
    minorVersion: r.u8(),
    packetVersion: r.u8(),
    packetId: r.u8(),
    sessionUID: r.u64().toString(),
    sessionTime: r.f32(),
    frameId: r.u32(),
    overallFrameId: r.u32(),
    playerCarIndex: r.u8(),
    secondaryPlayerCarIndex: r.u8(),
  };
  if (!KNOWN_FORMATS.includes(h.packetFormat)) {
    stats.unknownFormat++;
    warnOnce(
      `format-${h.packetFormat}`,
      `packet format ${h.packetFormat} is not one we know about. Set UDP Format to 2025 or 2026 in the game, or add it to KNOWN_FORMATS once verified.`,
    );
    return null;
  }
  stats.packets++;
  return h;
}

/**
 * Work out how many cars are in this packet and how wide each per-car struct is.
 * @param {Buffer} buf
 * @param {object} opts
 * @param {number} opts.format packet format from the header
 * @param {number} opts.packetId
 * @param {number} [opts.leading] bytes between header and the car array
 * @param {number} [opts.trailing] bytes after the car array
 * @param {number} [opts.minStride] sanity bound, rules out false divisors
 * @param {number} [opts.maxStride]
 * @returns {{numCars:number, stride:number, base:number}|null}
 */
export function solveLayout(
  buf,
  {
    format,
    packetId,
    leading = 0,
    trailing = 0,
    minStride = 8,
    maxStride = 400,
  },
) {
  const key = `${format}:${packetId}:${buf.length}`;
  const hit = layoutCache.get(key);
  if (hit !== undefined) return hit;

  const base = headerSize(format) + leading;
  const payload = buf.length - base - trailing;
  const preferred = format >= 2026 ? 24 : 22;
  const order = [preferred, ...GRID_CANDIDATES.filter((n) => n !== preferred)];

  let solved = null;
  for (const numCars of order) {
    if (payload <= 0 || payload % numCars !== 0) continue;
    const stride = payload / numCars;
    if (stride < minStride || stride > maxStride) continue;
    solved = { numCars, stride, base };
    break;
  }

  if (!solved) {
    stats.unparsed++;
    warnOnce(
      key,
      `could not solve layout for packet ${packetId} (format ${format}, ${buf.length} bytes). Run npm run inspect and send the output.`,
    );
  } else if (solved.numCars !== preferred) {
    warnOnce(
      `grid-${key}`,
      `packet ${packetId}: reading a ${solved.numCars}-car grid (stride ${solved.stride})`,
    );
  }

  layoutCache.set(key, solved);
  return solved;
}

// Read the same leading fields for every car in the packet.
function perCar(buf, layout, fn) {
  const out = [];
  for (let i = 0; i < layout.numCars; i++) {
    out.push(fn(new Reader(buf, layout.base + i * layout.stride), i));
  }
  return out;
}

// ---- Packet 0: Motion ----
// World positions for every car. This is what a real spotter is built on:
// who is alongside, which side, and how fast they are closing.
export function parseMotion(buf, h) {
  const layout = solveLayout(buf, {
    format: h.packetFormat,
    packetId: 0,
    minStride: 40,
    maxStride: 80,
  });
  if (!layout) return null;
  const cars = perCar(buf, layout, (r) => ({
    worldPosition: [r.f32(), r.f32(), r.f32()],
    worldVelocity: [r.f32(), r.f32(), r.f32()],
  }));
  return { cars };
}

// ---- Packet 1: Session ----
// Read sequentially: everything we want sits in front of the variable-length
// marshal zone and weather forecast arrays. Values are sanity checked because
// a layout change upstream would otherwise feed the engineer garbage.
export function parseSession(buf, h) {
  const r = new Reader(buf, headerSize(h.packetFormat));
  const s = {
    weather: r.u8(),
    trackTemp: r.i8(),
    airTemp: r.i8(),
    totalLaps: r.u8(),
    trackLength: r.u16(),
    sessionType: r.u8(),
    trackId: r.i8(),
    formula: r.u8(),
    sessionTimeLeft: r.u16(),
    sessionDuration: r.u16(),
    pitSpeedLimit: r.u8(),
  };

  try {
    r.skip(4); // gamePaused, isSpectating, spectatorCarIndex, sliProNativeSupport
    const numMarshalZones = r.u8();
    r.skip(21 * 5); // fixed-size marshal zone array
    const safetyCarStatus = r.u8();
    r.skip(1); // networkGame
    const numWeatherForecastSamples = r.u8();

    if (
      numMarshalZones <= 21 &&
      safetyCarStatus <= 3 &&
      numWeatherForecastSamples <= 64
    ) {
      s.safetyCarStatus = safetyCarStatus;
      s.forecast = [];
      for (let i = 0; i < numWeatherForecastSamples && r.left() >= 8; i++) {
        s.forecast.push({
          sessionType: r.u8(),
          timeOffsetMin: r.u8(),
          weather: r.u8(),
          trackTemp: r.i8(),
          trackTempChange: r.i8(),
          airTemp: r.i8(),
          airTempChange: r.i8(),
          rainPercent: r.u8(),
        });
      }
    } else {
      warnOnce(
        "session-tail",
        "session packet tail did not look right; safety car and forecast disabled",
      );
    }
  } catch {
    // short or reshaped packet, keep the leading fields and move on
  }
  return s;
}

// ---- Packet 2: Lap Data ----
// Trailing: timeTrialPBCarIdx u8, timeTrialRivalCarIdx u8
export function parseLapData(buf, h) {
  const layout = solveLayout(buf, {
    format: h.packetFormat,
    packetId: 2,
    trailing: 2,
    minStride: 40,
    maxStride: 90,
  });
  if (!layout) return null;
  return perCar(buf, layout, (r) => ({
    lastLapMs: r.u32(),
    currentLapMs: r.u32(),
    s1Ms: r.u16(),
    s1Min: r.u8(),
    s2Ms: r.u16(),
    s2Min: r.u8(),
    deltaAheadMs: r.u16(),
    deltaAheadMin: r.u8(),
    deltaLeaderMs: r.u16(),
    deltaLeaderMin: r.u8(),
    lapDistance: r.f32(),
    totalDistance: r.f32(),
    safetyCarDelta: r.f32(),
    position: r.u8(),
    currentLapNum: r.u8(),
    pitStatus: r.u8(),
    numPitStops: r.u8(),
    sector: r.u8(),
    currentLapInvalid: r.u8(),
    penalties: r.u8(),
    totalWarnings: r.u8(),
    cornerCuttingWarnings: r.u8(),
    unservedDriveThrough: r.u8(),
    unservedStopGo: r.u8(),
    gridPosition: r.u8(),
    driverStatus: r.u8(),
    resultStatus: r.u8(),
    pitLaneTimerActive: r.u8(),
    // Measured pit lane time. This is what replaces the guessed pit loss in
    // TRACK_META once you have made one stop at a circuit.
    pitLaneTimeMs: r.u16(),
    pitStopTimerMs: r.u16(),
  }));
}

// ---- Packet 3: Event ----
export function parseEvent(buf, h) {
  const base = headerSize(h.packetFormat);
  const code = buf.toString("ascii", base, base + 4);
  const r = new Reader(buf, base + 4);
  const ev = { code };
  try {
    switch (code) {
      case "BUTN":
        ev.buttonStatus = r.u32();
        break;
      case "FTLP":
        ev.vehicleIdx = r.u8();
        ev.lapTime = r.f32();
        break;
      case "PENA":
        ev.penaltyType = r.u8();
        ev.infringementType = r.u8();
        ev.vehicleIdx = r.u8();
        ev.otherVehicleIdx = r.u8();
        ev.time = r.u8();
        ev.lapNum = r.u8();
        ev.placesGained = r.u8();
        break;
      case "SPTP":
        ev.vehicleIdx = r.u8();
        ev.speed = r.f32();
        break;
      case "RTMT":
      case "TMPT":
      case "RCWN":
      case "DTSV":
      case "SGSV":
        ev.vehicleIdx = r.u8();
        break;
      case "OVTK":
        ev.overtakingVehicleIdx = r.u8();
        ev.overtakenVehicleIdx = r.u8();
        break;
      case "COLL":
        ev.vehicle1Idx = r.u8();
        ev.vehicle2Idx = r.u8();
        break;
      case "SCAR":
        ev.safetyCarType = r.u8();
        ev.eventType = r.u8();
        break;
      case "STLG":
        ev.numLights = r.u8();
        break;
      case "FLBK":
        ev.frameId = r.u32();
        ev.sessionTime = r.f32();
        break;
      default:
        break; // SSTA, SEND, CHQF, DRSE, DRSD, LGOT, RDFL carry nothing we need
    }
  } catch {
    // truncated event payload, the code alone is still useful
  }
  return ev;
}

// ---- Packet 4: Participants ----
// Leading: numActiveCars u8. Name is a null-terminated UTF-8 string at the end
// of each struct, so it is read from the raw bytes rather than the cursor.
export function parseParticipants(buf, h) {
  const layout = solveLayout(buf, {
    format: h.packetFormat,
    packetId: 4,
    leading: 1,
    minStride: 40,
    maxStride: 90,
  });
  if (!layout) return null;
  const numActive = buf.readUInt8(headerSize(h.packetFormat));
  const drivers = perCar(buf, layout, (r, i) => {
    const start = layout.base + i * layout.stride;
    const aiControlled = r.u8();
    const driverId = r.u8();
    r.u8(); // networkId
    const teamId = r.u8();
    r.u8(); // myTeam
    const raceNumber = r.u8();
    r.u8(); // nationality
    const nameBytes = buf.subarray(start + 7, start + layout.stride);
    const nul = nameBytes.indexOf(0);
    const name = nameBytes
      .toString("utf8", 0, nul === -1 ? nameBytes.length : nul)
      .trim();
    return { aiControlled, driverId, teamId, raceNumber, name };
  });
  return { numActive, drivers };
}

// ---- Packet 5: Car Setups ----
// Only the leading fields, which are the ones worth talking about on the radio.
//
// 1133 bytes in F1 25 resolves to 22 cars x 50b with 4 trailing. Note that
// 20 x 55 also divides cleanly, so the solver is right here because it tries
// the preferred grid size first, not because the size alone proves it. If a
// future format changes the trailing byte count this is the first place to
// check.
export function parseCarSetups(buf, h) {
  const layout =
    solveLayout(buf, {
      format: h.packetFormat,
      packetId: 5,
      trailing: 4,
      minStride: 40,
      maxStride: 90,
    }) ??
    solveLayout(buf, {
      format: h.packetFormat,
      packetId: 5,
      trailing: 0,
      minStride: 40,
      maxStride: 90,
    });
  if (!layout) return null;
  return perCar(buf, layout, (r) => ({
    frontWing: r.u8(),
    rearWing: r.u8(),
    onThrottleDiff: r.u8(),
    offThrottleDiff: r.u8(),
    frontCamber: r.f32(),
    rearCamber: r.f32(),
    frontToe: r.f32(),
    rearToe: r.f32(),
    frontSuspension: r.u8(),
    rearSuspension: r.u8(),
    frontAntiRollBar: r.u8(),
    rearAntiRollBar: r.u8(),
    frontRideHeight: r.u8(),
    rearRideHeight: r.u8(),
    brakePressure: r.u8(),
    brakeBias: r.u8(),
  }));
}

// ---- Packet 6: Car Telemetry ----
// Trailing: mfdPanelIndex u8, mfdPanelIndexSecondary u8, suggestedGear i8
export function parseCarTelemetry(buf, h) {
  const layout = solveLayout(buf, {
    format: h.packetFormat,
    packetId: 6,
    trailing: 3,
    minStride: 50,
    maxStride: 100,
  });
  if (!layout) return null;
  const cars = perCar(buf, layout, (r) => ({
    speed: r.u16(),
    throttle: r.f32(),
    steer: r.f32(),
    brake: r.f32(),
    clutch: r.u8(),
    gear: r.i8(),
    rpm: r.u16(),
    drs: r.u8(),
    revLightsPercent: r.u8(),
    revLightsBits: r.u16(),
    brakeTemps: [r.u16(), r.u16(), r.u16(), r.u16()],
    // Wheel order in the wire format is RL RR FL FR. state.js reorders to
    // FL FR RL RR so nothing downstream has to think about it.
    tyreSurfaceTemps: [r.u8(), r.u8(), r.u8(), r.u8()],
    tyreInnerTemps: [r.u8(), r.u8(), r.u8(), r.u8()],
    engineTemp: r.u16(),
    tyrePressures: [r.f32(), r.f32(), r.f32(), r.f32()],
  }));
  return { cars, suggestedGear: buf.readInt8(buf.length - 1) };
}

// ---- Packet 7: Car Status ----
// Now reads through the ERS block. The old parser stopped at fiaFlags, which is
// why state.js was reading an undefined ersDeployMode and the coach's ERS rules
// never fired.
export function parseCarStatus(buf, h) {
  const layout = solveLayout(buf, {
    format: h.packetFormat,
    packetId: 7,
    minStride: 40,
    maxStride: 90,
  });
  if (!layout) return null;
  return perCar(buf, layout, (r) => ({
    tractionControl: r.u8(),
    abs: r.u8(),
    fuelMix: r.u8(),
    frontBrakeBias: r.u8(),
    pitLimiter: r.u8(),
    fuelInTank: r.f32(),
    fuelCapacity: r.f32(),
    fuelRemainingLaps: r.f32(),
    maxRPM: r.u16(),
    idleRPM: r.u16(),
    maxGears: r.u8(),
    drsAllowed: r.u8(),
    drsActivationDistance: r.u16(),
    actualTyreCompound: r.u8(),
    visualTyreCompound: r.u8(),
    tyresAgeLaps: r.u8(),
    fiaFlags: r.i8(),
    // enginePowerICE and enginePowerMGUK sit between the flags and the ers
    // block from 2023 onward. without them the cursor lands 8 bytes early and
    // ersStoreEnergy reads ice power in watts, which is why a full store read
    // as twelve percent and an idling car on the grid read as two.
    enginePowerICE: r.f32(),
    enginePowerMGUK: r.f32(),
    ersStoreEnergy: r.f32(),
    ersDeployMode: r.u8(),
    ersHarvestedMGUK: r.f32(),
    ersHarvestedMGUH: r.f32(),
    ersDeployedThisLap: r.f32(),
  }));
}

// ---- Packet 8: Final Classification ----
// Leading: numCars u8. The end-of-session debrief is built from this.
export function parseFinalClassification(buf, h) {
  const layout = solveLayout(buf, {
    format: h.packetFormat,
    packetId: 8,
    leading: 1,
    minStride: 30,
    maxStride: 60,
  });
  if (!layout) return null;
  const numCars = buf.readUInt8(headerSize(h.packetFormat));
  const cars = perCar(buf, layout, (r) => ({
    position: r.u8(),
    numLaps: r.u8(),
    gridPosition: r.u8(),
    points: r.u8(),
    numPitStops: r.u8(),
    resultStatus: r.u8(),
  }));
  return { numCars, cars };
}

// ---- Packet 10: Car Damage ----
export function parseCarDamage(buf, h) {
  const layout = solveLayout(buf, {
    format: h.packetFormat,
    packetId: 10,
    minStride: 30,
    maxStride: 80,
  });
  if (!layout) return null;
  return perCar(buf, layout, (r) => ({
    tyreWear: [r.f32(), r.f32(), r.f32(), r.f32()],
    tyreDamage: [r.u8(), r.u8(), r.u8(), r.u8()],
    brakeDamage: [r.u8(), r.u8(), r.u8(), r.u8()],
    frontLeftWingDamage: r.u8(),
    frontRightWingDamage: r.u8(),
    rearWingDamage: r.u8(),
    floorDamage: r.u8(),
    diffuserDamage: r.u8(),
    sidepodDamage: r.u8(),
  }));
}

// ---- Packet 11: Session History ----
// One car per packet, cycled by the game. Gives per-lap sector times and the
// tyre stint history, which is how we learn rival degradation without guessing.
export function parseSessionHistory(buf, h) {
  const r = new Reader(buf, headerSize(h.packetFormat));
  try {
    const out = {
      carIdx: r.u8(),
      numLaps: r.u8(),
      numTyreStints: r.u8(),
      bestLapNum: r.u8(),
      bestS1LapNum: r.u8(),
      bestS2LapNum: r.u8(),
      bestS3LapNum: r.u8(),
      laps: [],
      stints: [],
    };
    if (out.numLaps > 100 || out.numTyreStints > 8) return null;
    for (let i = 0; i < out.numLaps && r.left() >= 14; i++) {
      out.laps.push({
        lapMs: r.u32(),
        s1Ms: r.u16() + r.u8() * 60000,
        s2Ms: r.u16() + r.u8() * 60000,
        s3Ms: r.u16() + r.u8() * 60000,
        validFlags: r.u8(),
      });
    }
    // skip the unused remainder of the fixed 100-lap array
    r.skip((100 - out.numLaps) * 14);
    for (let i = 0; i < out.numTyreStints && r.left() >= 3; i++) {
      out.stints.push({
        endLap: r.u8(),
        actualCompound: r.u8(),
        visualCompound: r.u8(),
      });
    }
    return out;
  } catch {
    return null;
  }
}

// ---- Packet 13: Motion Ex ----
// Player car only, so no grid array to solve. 273 bytes in F1 25, which is
// 244 of payload: four float[4] suspension and wheel speed arrays before the
// slip data.
//
// These offsets are inferred from the packet size rather than confirmed byte
// by byte, so the result is sanity checked. A slip ratio outside what a tyre
// can physically do means the layout moved, and returning null is the right
// answer: a beep on a wrong offset is worse than no beep.
export function parseMotionEx(buf, h) {
  const base = headerSize(h.packetFormat);
  // suspensionPosition, suspensionVelocity, suspensionAcceleration, wheelSpeed
  const SLIP_RATIO_OFFSET = base + 4 * 4 * 4;
  if (buf.length < SLIP_RATIO_OFFSET + 16) return null;
  try {
    const r = new Reader(buf, SLIP_RATIO_OFFSET);
    const slipRatio = [r.f32(), r.f32(), r.f32(), r.f32()];
    // A tyre turning at twice road speed is a huge slide; ten times it is a
    // misread float.
    if (!slipRatio.every((v) => Number.isFinite(v) && Math.abs(v) < 10)) {
      warnOnce(
        `motionex-${buf.length}`,
        `motion ex slip ratios out of range, offsets are wrong for this format`,
      );
      return null;
    }
    return { slipRatio };
  } catch {
    return null;
  }
}

// ---- Packet 12: Tyre Sets ----
// One car per packet. The game's own wear and lifespan numbers per set, which
// is the cheapest good strategy input available.
export function parseTyreSets(buf, h) {
  const r = new Reader(buf, headerSize(h.packetFormat));
  try {
    const carIdx = r.u8();
    const sets = [];
    for (let i = 0; i < 20 && r.left() >= 10; i++) {
      sets.push({
        actualCompound: r.u8(),
        visualCompound: r.u8(),
        wearPct: r.u8(),
        available: !!r.u8(),
        recommendedSession: r.u8(),
        lifeSpanLaps: r.u8(),
        usableLifeLaps: r.u8(),
        lapDeltaMs: r.i16(),
        fitted: !!r.u8(),
      });
    }
    const fittedIdx = r.left() >= 1 ? r.u8() : null;
    return { carIdx, sets, fittedIdx };
  } catch {
    return null;
  }
}

export const PacketId = {
  MOTION: 0,
  SESSION: 1,
  LAP_DATA: 2,
  EVENT: 3,
  PARTICIPANTS: 4,
  CAR_SETUPS: 5,
  CAR_TELEMETRY: 6,
  CAR_STATUS: 7,
  FINAL_CLASSIFICATION: 8,
  LOBBY: 9,
  CAR_DAMAGE: 10,
  SESSION_HISTORY: 11,
  TYRE_SETS: 12,
  MOTION_EX: 13,
  TIME_TRIAL: 14,
  // The 2026 season pack adds at least one packet (a second car telemetry
  // packet carrying the new-regulation channels). Its id is not confirmed here,
  // so ids we don't recognise are recorded by noteUnknownPacket and reported by
  // npm run inspect rather than being guessed at.
  // Confirmed present in F1 25 at 1131 bytes, and not per-car: the payload
  // divides by no plausible grid size. Named so it stops reporting as UNKNOWN,
  // but deliberately not parsed, because guessing offsets on a packet whose
  // layout we have not verified is how the engineer starts saying confident
  // wrong things.
  LAP_POSITIONS: 15,
};

export function noteUnknownPacket(packetId, length) {
  const key = `${packetId}:${length}`;
  if (stats.unknownPacketIds.has(key)) return;
  stats.unknownPacketIds.add(key);
  console.log(
    `[f1] unhandled packet id ${packetId} (${length} bytes) — likely a 2026 addition`,
  );
}
