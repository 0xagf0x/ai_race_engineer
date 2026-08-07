export interface TyreState {
  surfaceTempC: [number, number, number, number];
  innerTempC?: [number, number, number, number];
  wearPct?: [number, number, number, number];
  compound?: string;
  ageLaps?: number;
}

export interface PlayerState {
  speedKph: number;
  gear: number;
  suggestedGear?: number;
  rpm: number;
  throttle: number;
  brake: number;
  drs?: boolean;
  fuelLevel?: number;
  fuelCapacity?: number;
  fuelRemainingLaps?: number;
  ersStoreEnergyPct?: number;
  ersDeployMode?: string;
  tyres: TyreState;
  engineTempC?: number;
  position?: number;
  currentLapNum?: number;
  lapDistanceM?: number;
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
  gapToPlayerMs?: number;
  deltaToCarInFrontMs?: number;
  tyreCompound?: string;
  tyreAgeLaps?: number;
  pitStatus?: "none" | "pitting" | "in_pit_area";
  numPitStops?: number;
  isPlayer?: boolean;
}

export interface SessionState {
  game: "f1" | "gt7";
  sessionType?: string;
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
  brakeAtM: number;
  entrySpeedKph: number;
  minSpeedKph: number;
  gear: number;
}

export interface CoachingState {
  referenceLapTimeMs?: number;
  nextZone?: BrakeZone & { distanceToBrakePointM: number };
  lastCornerFeedback?: string;
  lastCornerIndex?: number;
  lastCornerTs?: number;
}

export interface Snapshot {
  ts: number;
  session: SessionState;
  player: PlayerState;
  opponents: OpponentState[];
  coaching?: CoachingState;
}

export interface RaceEvent {
  ts: number;
  kind: string;
  message: string;
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export function fmtLap(ms?: number): string {
  if (!ms || ms <= 0) return "--:--.---";
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

export function fmtGap(ms?: number): string {
  if (ms == null) return "";
  if (ms === 0) return "—";
  const sign = ms > 0 ? "+" : "-";
  return `${sign}${(Math.abs(ms) / 1000).toFixed(1)}s`;
}
