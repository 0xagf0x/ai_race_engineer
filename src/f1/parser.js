// F1 25 UDP telemetry parser (packetFormat 2025, header-compatible with 2023/2024).
//
// Strategy: parse the leading fields of each per-car struct sequentially with a
// cursor, then jump to the next car using a computed stride. This makes the
// parser tolerant of fields Codemasters appends to the END of per-car structs
// between game years. If a packet's size doesn't divide cleanly, we log once
// and skip it rather than corrupting state. Run `npm run inspect` to dump
// live packet sizes if something looks off.

const HEADER_SIZE = 29;
const NUM_CARS = 22;

class Reader {
  constructor(buf, offset = 0) { this.buf = buf; this.o = offset; }
  u8() { return this.buf.readUInt8(this.o++); }
  i8() { return this.buf.readInt8(this.o++); }
  u16() { const v = this.buf.readUInt16LE(this.o); this.o += 2; return v; }
  i16() { const v = this.buf.readInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.o); this.o += 4; return v; }
  i32() { const v = this.buf.readInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.buf.readBigUInt64LE(this.o); this.o += 8; return v; }
  f32() { const v = this.buf.readFloatLE(this.o); this.o += 4; return v; }
  bytes(n) { const v = this.buf.subarray(this.o, this.o + n); this.o += n; return v; }
  seek(o) { this.o = o; }
}

export function parseHeader(buf) {
  if (buf.length < HEADER_SIZE) return null;
  const r = new Reader(buf);
  return {
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
}

function carStride(buf, trailingBytes) {
  const payload = buf.length - HEADER_SIZE - trailingBytes;
  if (payload <= 0 || payload % NUM_CARS !== 0) return null;
  return payload / NUM_CARS;
}

// ---- Packet 1: Session ----
export function parseSession(buf) {
  const r = new Reader(buf, HEADER_SIZE);
  return {
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
}

// ---- Packet 2: Lap Data ----
// Trailing: timeTrialPBCarIdx u8, timeTrialRivalCarIdx u8
export function parseLapData(buf) {
  const stride = carStride(buf, 2);
  if (!stride) return null;
  const cars = [];
  for (let i = 0; i < NUM_CARS; i++) {
    const base = HEADER_SIZE + i * stride;
    const r = new Reader(buf, base);
    const c = {
      lastLapMs: r.u32(),
      currentLapMs: r.u32(),
      s1Ms: r.u16(), s1Min: r.u8(),
      s2Ms: r.u16(), s2Min: r.u8(),
      deltaAheadMs: r.u16(), deltaAheadMin: r.u8(),
      deltaLeaderMs: r.u16(), deltaLeaderMin: r.u8(),
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
    };
    cars.push(c);
  }
  return cars;
}

// ---- Packet 3: Event ----
export function parseEvent(buf) {
  const code = buf.toString("ascii", HEADER_SIZE, HEADER_SIZE + 4);
  const r = new Reader(buf, HEADER_SIZE + 4);
  const ev = { code };
  switch (code) {
    case "BUTN": ev.buttonStatus = r.u32(); break;
    case "FTLP": ev.vehicleIdx = r.u8(); ev.lapTime = r.f32(); break;
    case "PENA":
      ev.penaltyType = r.u8(); ev.infringementType = r.u8();
      ev.vehicleIdx = r.u8(); ev.otherVehicleIdx = r.u8();
      ev.time = r.u8(); ev.lapNum = r.u8(); ev.placesGained = r.u8();
      break;
    case "SPTP": ev.vehicleIdx = r.u8(); ev.speed = r.f32(); break;
    case "RTMT": ev.vehicleIdx = r.u8(); break;
    default: break; // SSTA, SEND, CHQF, DRSE, DRSD, etc. carry no payload we need
  }
  return ev;
}

// ---- Packet 4: Participants ----
// numActiveCars u8, then per-driver structs. Name is a null-terminated UTF-8
// string inside the struct; struct sizes changed between years so we compute stride.
export function parseParticipants(buf) {
  const payload = buf.length - HEADER_SIZE - 1;
  if (payload <= 0 || payload % NUM_CARS !== 0) return null;
  const stride = payload / NUM_CARS;
  const numActive = buf.readUInt8(HEADER_SIZE);
  const drivers = [];
  for (let i = 0; i < NUM_CARS; i++) {
    const base = HEADER_SIZE + 1 + i * stride;
    const r = new Reader(buf, base);
    const aiControlled = r.u8();
    const driverId = r.u8();
    r.u8(); // networkId
    const teamId = r.u8();
    r.u8(); // myTeam
    const raceNumber = r.u8();
    r.u8(); // nationality
    const nameBytes = buf.subarray(base + 7, base + stride);
    const nul = nameBytes.indexOf(0);
    const name = nameBytes.toString("utf8", 0, nul === -1 ? nameBytes.length : nul).trim();
    drivers.push({ aiControlled, driverId, teamId, raceNumber, name });
  }
  return { numActive, drivers };
}

// ---- Packet 6: Car Telemetry ----
// Trailing: mfdPanelIndex u8, mfdPanelIndexSecondary u8, suggestedGear i8
export function parseCarTelemetry(buf) {
  const stride = carStride(buf, 3);
  if (!stride) return null;
  const cars = [];
  for (let i = 0; i < NUM_CARS; i++) {
    const r = new Reader(buf, HEADER_SIZE + i * stride);
    cars.push({
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
      tyreSurfaceTemps: [r.u8(), r.u8(), r.u8(), r.u8()],
      tyreInnerTemps: [r.u8(), r.u8(), r.u8(), r.u8()],
      engineTemp: r.u16(),
      tyrePressures: [r.f32(), r.f32(), r.f32(), r.f32()],
    });
  }
  const suggestedGear = buf.readInt8(buf.length - 1);
  return { cars, suggestedGear };
}

// ---- Packet 7: Car Status ----
export function parseCarStatus(buf) {
  const stride = carStride(buf, 0);
  if (!stride) return null;
  const cars = [];
  for (let i = 0; i < NUM_CARS; i++) {
    const r = new Reader(buf, HEADER_SIZE + i * stride);
    cars.push({
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
    });
  }
  return cars;
}

// ---- Packet 10: Car Damage ----
export function parseCarDamage(buf) {
  const stride = carStride(buf, 0);
  if (!stride) return null;
  const cars = [];
  for (let i = 0; i < NUM_CARS; i++) {
    const r = new Reader(buf, HEADER_SIZE + i * stride);
    cars.push({
      tyreWear: [r.f32(), r.f32(), r.f32(), r.f32()],
      tyreDamage: [r.u8(), r.u8(), r.u8(), r.u8()],
      brakeDamage: [r.u8(), r.u8(), r.u8(), r.u8()],
      frontLeftWingDamage: r.u8(),
      frontRightWingDamage: r.u8(),
      rearWingDamage: r.u8(),
      floorDamage: r.u8(),
      diffuserDamage: r.u8(),
      sidepodDamage: r.u8(),
    });
  }
  return cars;
}

export const PacketId = {
  MOTION: 0, SESSION: 1, LAP_DATA: 2, EVENT: 3, PARTICIPANTS: 4,
  CAR_SETUPS: 5, CAR_TELEMETRY: 6, CAR_STATUS: 7, FINAL_CLASSIFICATION: 8,
  LOBBY: 9, CAR_DAMAGE: 10, SESSION_HISTORY: 11, TYRE_SETS: 12,
};
