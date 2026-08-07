// Learns brake points from your own laps. Records (lapDistance, speed, gear, brake)
// samples for the current lap; when a lap completes faster than the stored
// reference, extracts braking zones and persists them per track.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { state, type BrakeZone } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

interface Sample {
  d: number; // lapDistance m
  v: number; // speed kph
  g: number; // gear
  b: number; // brake 0..1
}

interface TrackRef {
  lapTimeMs: number;
  zones: BrakeZone[];
}

let currentLapSamples: Sample[] = [];
let currentLapNum = -1;
let ref: TrackRef | null = null;
let refKey = "";

// live braking-event tracking, compared against the reference lap
let braking = false;
let onsetDistance = 0;
let onsetSpeed = 0;
let minSpeedInZone = Infinity;
let minGearInZone = 9;
let matchedZone: BrakeZone | null = null;

function keyFor(): string {
  const s = state.session;
  return `${s.game}-track${s.trackId ?? "unknown"}`;
}

function refPath(key: string) {
  return path.join(DATA_DIR, `${key}.json`);
}

function loadRef(key: string) {
  refKey = key;
  try {
    ref = JSON.parse(fs.readFileSync(refPath(key), "utf8"));
    console.log(`[corners] loaded reference lap ${ref!.lapTimeMs}ms, ${ref!.zones.length} zones for ${key}`);
  } catch {
    ref = null;
  }
}

export function recordSample() {
  const p = state.player;
  if (p.lapDistanceM == null || p.lapDistanceM < 0) return;

  const key = keyFor();
  if (key !== refKey) loadRef(key);

  // lap rollover
  if (p.currentLapNum != null && p.currentLapNum !== currentLapNum) {
    if (
      currentLapNum >= 0 &&
      p.lastLapTimeMs &&
      currentLapSamples.length > 100 &&
      !state.player.currentLapInvalid
    ) {
      maybePromoteReference(p.lastLapTimeMs);
    }
    currentLapSamples = [];
    currentLapNum = p.currentLapNum;
  }

  const s: Sample = { d: p.lapDistanceM, v: p.speedKph, g: p.gear, b: p.brake };
  currentLapSamples.push(s);
  if (currentLapSamples.length > 60000) currentLapSamples.shift();

  trackBrakingEvent(s);
}

// Compare each braking event to the nearest reference zone and store a verdict.
function trackBrakingEvent(s: Sample) {
  if (!braking && s.b > 0.4 && s.v > 60) {
    braking = true;
    onsetDistance = s.d;
    onsetSpeed = s.v;
    minSpeedInZone = s.v;
    minGearInZone = s.g > 0 ? s.g : 9;
    matchedZone = nearestZone(s.d);
    return;
  }
  if (!braking) return;

  minSpeedInZone = Math.min(minSpeedInZone, s.v);
  if (s.g > 0) minGearInZone = Math.min(minGearInZone, s.g);

  if (s.b < 0.05 && s.v > minSpeedInZone + 15) {
    braking = false;
    if (!matchedZone) return;
    const z = matchedZone;
    const deltaM = Math.round(onsetDistance - z.brakeAtM); // + = braked later
    const speedDelta = Math.round(minSpeedInZone - z.minSpeedKph);
    const parts: string[] = [];
    if (Math.abs(deltaM) >= 8) {
      parts.push(`braked ${Math.abs(deltaM)}m ${deltaM > 0 ? "later" : "earlier"} than reference`);
    }
    if (Math.abs(speedDelta) >= 5) {
      parts.push(`${Math.abs(speedDelta)} kph ${speedDelta > 0 ? "more" : "less"} minimum speed`);
    }
    if (minGearInZone !== z.gear && minGearInZone < 9) {
      parts.push(`used gear ${minGearInZone} vs reference ${z.gear}`);
    }
    state.coaching = {
      ...(state.coaching ?? {}),
      lastCornerFeedback: parts.length
        ? `corner ${z.cornerIndex}: ${parts.join(", ")} (entry ${Math.round(onsetSpeed)} kph)`
        : `corner ${z.cornerIndex}: on reference`,
      lastCornerIndex: z.cornerIndex,
      lastCornerTs: Date.now(),
    };
  }
}

function nearestZone(d: number): BrakeZone | null {
  if (!ref) return null;
  let best: BrakeZone | null = null;
  let bestDist = 150; // within 150m counts as the same corner
  for (const z of ref.zones) {
    const dist = Math.abs(z.brakeAtM - d);
    if (dist < bestDist) {
      bestDist = dist;
      best = z;
    }
  }
  return best;
}

function maybePromoteReference(lapTimeMs: number) {
  if (ref && lapTimeMs >= ref.lapTimeMs) return;
  const zones = extractZones(currentLapSamples);
  if (zones.length === 0) return;
  ref = { lapTimeMs, zones };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(refPath(refKey), JSON.stringify(ref, null, 2));
  console.log(`[corners] new reference lap ${lapTimeMs}ms with ${zones.length} braking zones`);
}

function extractZones(samples: Sample[]): BrakeZone[] {
  const zones: BrakeZone[] = [];
  let inZone = false;
  let zoneStart: Sample | null = null;
  let minSpeed = Infinity;
  let minGear = 8;

  for (const s of samples) {
    if (!inZone && s.b > 0.4 && s.v > 60) {
      inZone = true;
      zoneStart = s;
      minSpeed = s.v;
      minGear = s.g;
    } else if (inZone) {
      minSpeed = Math.min(minSpeed, s.v);
      if (s.g > 0) minGear = Math.min(minGear, s.g);
      // zone ends once back hard on throttle and off the brakes
      if (s.b < 0.05 && s.v > minSpeed + 15) {
        zones.push({
          cornerIndex: zones.length + 1,
          brakeAtM: Math.round(zoneStart!.d),
          entrySpeedKph: Math.round(zoneStart!.v),
          minSpeedKph: Math.round(minSpeed),
          gear: minGear,
        });
        inZone = false;
      }
    }
  }
  return zones;
}

export function updateCoaching() {
  const p = state.player;
  const prev = state.coaching;
  if (!ref || p.lapDistanceM == null) {
    state.coaching = ref ? { ...prev, referenceLapTimeMs: ref.lapTimeMs } : prev;
    return;
  }
  const lapLen = state.session.trackLengthM ?? Math.max(...ref.zones.map((z) => z.brakeAtM), 1);
  let next: BrakeZone | null = null;
  let bestDelta = Infinity;
  for (const z of ref.zones) {
    let delta = z.brakeAtM - p.lapDistanceM;
    if (delta < -50) delta += lapLen; // wrap to next lap
    if (delta >= -50 && delta < bestDelta) {
      bestDelta = delta;
      next = z;
    }
  }
  state.coaching = {
    ...prev,
    referenceLapTimeMs: ref.lapTimeMs,
    nextZone: next ? { ...next, distanceToBrakePointM: Math.round(bestDelta) } : undefined,
  };
}
