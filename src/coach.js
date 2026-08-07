// Lap learner and corner grader.
//
// Two jobs, sharing one sample stream:
//   1. record laps, keep the fastest valid one as reference, extract its
//      braking zones, persist per track  (this was already here)
//   2. grade every braking event you make against the matching reference zone
//      and produce "braked 40m later than reference"  (ported from
//      bridge/src/corners.ts trackBrakingEvent)
//
// F1: uses lapDistance straight from telemetry.
// GT7: integrates speed over time into a pseudo lap distance, reset each lap.
// Zones persist per track in data/tracks/.

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data/tracks");

// A braking event has to be meaningful before we grade it, otherwise every
// dab on the brakes produces radio chatter.
const BRAKE_ON = 0.4;
const BRAKE_OFF = 0.05;
const MIN_SPEED_KPH = 60;
const ZONE_MATCH_M = 150; // within this of a reference zone counts as the same corner

export class Coach {
  constructor() {
    this.trackKey = null;
    this.reference = null; // { lapMs, zones: [{cornerIndex, start, entrySpeed, minSpeed, gear}] }
    this.samples = [];
    this.lapNum = null;
    this.gt7Dist = 0;
    this.gt7LastT = 0;
    this.feedback = null; // { text, cornerIndex, onReference, ts }

    // live braking event state
    this._braking = false;
    this._onsetDist = 0;
    this._onsetSpeed = 0;
    this._minSpeed = Infinity;
    this._minGear = 9;
    this._matched = null;
  }

  setTrack(key) {
    if (key === this.trackKey) return;
    this.trackKey = key;
    this.samples = [];
    this.feedback = null;
    this.reference = this._load(key);
    if (this.reference?.zones?.length) {
      console.log(
        `[coach] loaded reference lap ${this.reference.lapMs}ms with ${this.reference.zones.length} zones for ${key}`,
      );
    }
  }

  _file(key) {
    return path.join(DATA_DIR, `${String(key).replace(/[^\w-]/g, "_")}.json`);
  }
  _load(key) {
    try {
      return JSON.parse(fs.readFileSync(this._file(key), "utf8"));
    } catch {
      return null;
    }
  }
  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        this._file(this.trackKey),
        JSON.stringify(this.reference, null, 2),
      );
    } catch {
      /* non-fatal */
    }
  }

  // Called at telemetry rate. dist = lap distance in meters.
  sample({ dist, speed, brake, gear, lapNum, lapMsAtSample, invalid }) {
    if (this.trackKey == null || dist == null || dist < 0) return;

    if (this.lapNum !== null && lapNum !== this.lapNum) this._completeLap();
    this.lapNum = lapNum;

    const s = {
      d: dist,
      v: speed,
      b: brake,
      g: gear,
      inv: !!invalid,
      t: lapMsAtSample,
    };
    this.samples.push(s);
    if (this.samples.length > 20000) this.samples.shift();

    this._gradeBraking(s);
  }

  gt7Sample({ speedMs, brake, gear, lapCount, now }) {
    if (this.gt7LastT) this.gt7Dist += speedMs * ((now - this.gt7LastT) / 1000);
    this.gt7LastT = now;
    if (this.lapNum !== null && lapCount !== this.lapNum) this.gt7Dist = 0;
    this.sample({
      dist: this.gt7Dist,
      speed: speedMs * 3.6,
      brake,
      gear,
      lapNum: lapCount,
    });
  }

  // Compare each braking event to the nearest reference zone and store a verdict.
  _gradeBraking(s) {
    if (!this._braking) {
      if (s.b > BRAKE_ON && s.v > MIN_SPEED_KPH) {
        this._braking = true;
        this._onsetDist = s.d;
        this._onsetSpeed = s.v;
        this._minSpeed = s.v;
        this._minGear = s.g > 0 ? s.g : 9;
        this._matched = this._nearestZone(s.d);
      }
      return;
    }

    this._minSpeed = Math.min(this._minSpeed, s.v);
    if (s.g > 0) this._minGear = Math.min(this._minGear, s.g);

    // zone ends once off the brakes and accelerating again
    if (s.b < BRAKE_OFF && s.v > this._minSpeed + 15) {
      this._braking = false;
      const z = this._matched;
      this._matched = null;
      if (!z) return;

      const deltaM = Math.round(this._onsetDist - z.start); // positive = braked later
      const speedDelta = Math.round(this._minSpeed - z.minSpeed);
      const parts = [];
      if (Math.abs(deltaM) >= 8) {
        parts.push(
          `braked ${Math.abs(deltaM)} metres ${deltaM > 0 ? "later" : "earlier"} than reference`,
        );
      }
      if (Math.abs(speedDelta) >= 5) {
        parts.push(
          `${Math.abs(speedDelta)} kph ${speedDelta > 0 ? "more" : "less"} minimum speed`,
        );
      }
      if (this._minGear !== z.gear && this._minGear < 9) {
        parts.push(
          `used gear ${this._minGear} against reference gear ${z.gear}`,
        );
      }

      this.feedback = {
        cornerIndex: z.cornerIndex,
        onReference: parts.length === 0,
        text: parts.length
          ? `corner ${z.cornerIndex}: ${parts.join(", ")}, entry ${Math.round(this._onsetSpeed)} kph`
          : `corner ${z.cornerIndex}: on reference`,
        ts: Date.now(),
      };
    }
  }

  _nearestZone(d) {
    if (!this.reference?.zones?.length) return null;
    let best = null;
    let bestDist = ZONE_MATCH_M;
    for (const z of this.reference.zones) {
      const gap = Math.abs(z.start - d);
      if (gap < bestDist) {
        bestDist = gap;
        best = z;
      }
    }
    return best;
  }

  _completeLap() {
    const laps = this.samples;
    if (laps.length < 100) {
      this.samples = [];
      return;
    }
    const invalid = laps.some((s) => s.inv);
    const lapMs = laps[laps.length - 1].t ?? null;
    const zones = extractZones(laps);
    const better =
      !this.reference ||
      !this.reference.zones?.length ||
      (lapMs && this.reference.lapMs && lapMs < this.reference.lapMs);
    if (!invalid && zones.length && better) {
      const trackLength = this.reference?.trackLength;
      this.reference = { lapMs, zones, trackLength, updatedAt: Date.now() };
      this._save();
      console.log(
        `[coach] new reference lap ${lapMs}ms with ${zones.length} braking zones`,
      );
    }
    this.samples = [];
    this._braking = false;
  }

  // What should the driver know right now?
  next(dist) {
    if (!this.reference?.zones?.length || dist == null) return null;
    const z =
      this.reference.zones.find((z) => z.start > dist + 20) ??
      this.reference.zones[0];
    if (!z) return null;
    let inMeters = z.start - dist;
    if (inMeters < 0 && this.reference.trackLength)
      inMeters += this.reference.trackLength;
    return {
      cornerIndex: z.cornerIndex,
      brakeInM: Math.round(inMeters),
      entrySpeedKph: Math.round(z.entrySpeed),
      minSpeedKph: Math.round(z.minSpeed),
      gear: z.gear,
      zoneStartM: Math.round(z.start),
      referenceLap: this.reference.lapMs,
    };
  }
}

// Find sustained braking zones on a completed lap.
function extractZones(samples) {
  const zones = [];
  let inZone = false,
    start = 0,
    entrySpeed = 0,
    minSpeed = Infinity,
    minGear = 9;
  for (const s of samples) {
    if (!inZone && s.b > BRAKE_ON && s.v > MIN_SPEED_KPH) {
      inZone = true;
      start = s.d;
      entrySpeed = s.v;
      minSpeed = s.v;
      minGear = s.g;
    } else if (inZone) {
      if (s.v < minSpeed) {
        minSpeed = s.v;
        minGear = s.g;
      }
      if (s.b < BRAKE_OFF && s.v > minSpeed + 15) {
        if (entrySpeed - minSpeed > 25) {
          zones.push({
            cornerIndex: zones.length + 1,
            start: Math.round(start),
            entrySpeed,
            minSpeed,
            gear: Math.max(1, minGear),
          });
        }
        inZone = false;
      }
    }
  }
  // de-dupe zones closer than 60m apart, then renumber
  return zones
    .filter((z, i, a) => i === 0 || z.start - a[i - 1].start > 60)
    .map((z, i) => ({ ...z, cornerIndex: i + 1 }));
}
