// Normalized game state. Both the F1 and GT7 adapters write into this shape,
// so the web app and the engineer prompt only ever deal with one schema.

export interface TyreState {
  surfaceTempC: [number, number, number, number]; // FL FR RL RR (F1: RL RR FL FR reordered to this)
  innerTempC?: [number, number, number, number];
  wearPct?: [number, number, number, number];
  compound?: string;
  ageLaps?: number;
}

export interface PlayerState {
  speedKph: number;
  gear: number; // -1 reverse, 0 neutral
  suggestedGear?: number;
  rpm: number;
  throttle: number; // 0..1
  brake: number; // 0..1
  drs?: boolean;
  fuelLevel?: number; // kg (F1) or liters (GT7)
  fuelCapacity?: number;
  fuelRemainingLaps?: number;
  ersStoreEnergyPct?: number;
  ersDeployMode?: string;
  tyres: TyreState;
  engineTempC?: number;
  position?: number;
  currentLapNum?: number;
  lapDistanceM?: number; // distance around lap; GT7 approximates by integrating speed
  currentLapTimeMs?: number;
  lastLapTimeMs?: number;
  bestLapTimeMs?: number;
  currentLapInvalid?: boolean;
  penaltiesSec?: number;
  warnings?: number;
  pitStatus?: "none" | "pitting" | "in_pit_area";
  damage?: {
    frontLeftWingPct?: number;
    frontRightWingPct?: number;
    rearWingPct?: number;
    floorPct?: number;
    gearboxPct?: number;
  };
}

export interface OpponentState {
  name: string;
  position: number;
  currentLapNum: number;
  lastLapTimeMs: number;
  gapToPlayerMs?: number; // negative = behind player
  deltaToCarInFrontMs?: number;
  tyreCompound?: string;
  tyreAgeLaps?: number;
  pitStatus?: "none" | "pitting" | "in_pit_area";
  numPitStops?: number;
  resultStatus?: string;
  teamId?: number;
  isPlayer?: boolean;
}

export interface SessionState {
  game: "f1" | "gt7";
  sessionType?: string; // P, Q, R, TT...
  trackId?: number;
  trackName?: string;
  trackLengthM?: number;
  totalLaps?: number;
  weather?: string;
  trackTempC?: number;
  airTempC?: number;
  safetyCar?: "none" | "full" | "virtual" | "formation";
  sessionTimeLeftSec?: number;
  pitSpeedLimitKph?: number;
}

export interface BrakeZone {
  cornerIndex: number;
  brakeAtM: number; // lapDistance where braking began on reference lap
  entrySpeedKph: number;
  minSpeedKph: number;
  gear: number;
}

export interface CoachingState {
  referenceLapTimeMs?: number;
  nextZone?: BrakeZone & { distanceToBrakePointM: number };
  lastCornerFeedback?: string; // e.g. "corner 3: braked 40m earlier than reference"
  lastCornerIndex?: number;
  lastCornerTs?: number;
}

export interface Snapshot {
  ts: number;
  session: SessionState;
  player: PlayerState;
  opponents: OpponentState[]; // sorted by position; empty for GT7
  coaching?: CoachingState;
}

export interface RaceEvent {
  ts: number;
  kind:
    | "lap_completed"
    | "pitting"
    | "penalty"
    | "overtake"
    | "fastest_lap"
    | "drs_enabled"
    | "safety_car"
    | "chequered_flag"
    | "low_fuel"
    | "tyre_temp_warning";
  message: string;
}

// ---- store ----

export const state: Snapshot = {
  ts: 0,
  session: { game: "f1" },
  player: {
    speedKph: 0,
    gear: 0,
    rpm: 0,
    throttle: 0,
    brake: 0,
    tyres: { surfaceTempC: [0, 0, 0, 0] },
  },
  opponents: [],
};

type Listener = (ev: RaceEvent) => void;
const eventListeners: Listener[] = [];
export function onRaceEvent(fn: Listener) {
  eventListeners.push(fn);
}
export function pushRaceEvent(kind: RaceEvent["kind"], message: string) {
  const ev: RaceEvent = { ts: Date.now(), kind, message };
  for (const fn of eventListeners) fn(ev);
}

export function touch() {
  state.ts = Date.now();
}
