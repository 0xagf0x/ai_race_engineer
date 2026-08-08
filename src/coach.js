// Lap learner and corner grader.
//
// Two jobs, sharing one sample stream:
//   1. record laps, keep the fastest valid one as reference, extract its
//      braking zones, persist per track
//   2. grade every braking event you make against the matching reference zone
//      and produce "braked 40m later than reference"
//
// F1: uses lapDistance straight from telemetry.
// GT7: integrates speed over time into a pseudo lap distance, reset each lap.
// Zones persist per track in data/tracks/.

import fs from "node:fs";
import path from "node:path";

// Must match delta.js and gt7/track-model.js: everything track-scoped lives in
// <root>/tracks so a test run pointed at RACE_DATA_DIR can't reach real data.
const DATA_DIR = process.env.RACE_DATA_DIR
  ? path.resolve(process.env.RACE_DATA_DIR, "tracks")
  : path.resolve("data/tracks");

// A braking event has to be meaningful before we grade it, otherwise every
// dab on the brakes produces radio chatter.
const BRAKE_ON = 0.4;
const BRAKE_OFF = 0.05;
const MIN_SPEED_KPH = 60;
const ZONE_MATCH_M = 150; // within this of a reference zone counts as the same corner
const MIN_ZONE_GAP_M = 60; // two zones closer than this are the same corner

export class Coach {
  constructor() {
    this.trackKey = null;
    this.reference = null; // { lapMs, zones: [{cornerIndex, start, entrySpeed, minSpeed, gear}] }
    this.trackLength = null;
    this.samples = [];
    this.lapNum = null;
    this.gt7Dist = 0;
    this.gt7LastT = 0;
    this.gt7LapStart = 0;
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
    this.gt7Dist = 0;
    this.gt7LastT = 0;
    this.gt7LapStart = 0;
    this.reference = this._load(key);
    this.trackLength = this.reference?.trackLength ?? null;
    if (this.reference?.zones?.length) {
      console.log(
        `[coach] loaded reference lap ${this.reference.lapMs ?? "unknown"}ms with ${this.reference.zones.length} zones for ${key}`,
      );
    }
  }

  /**
   * Circuit length, used to wrap the distance to the next braking zone past the
   * start line. Held on the Coach rather than only on the reference so it
   * survives the first visit, when there is no reference yet to hang it on.
   */
  setTrackLength(m) {
    if (!m || m <= 0) return;
    this.trackLength = m;
    if (this.reference) this.reference.trackLength = m;
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

    // GT7 sends no in-lap timer, so we keep our own. Without it every GT7
    // sample carried an undefined lap time, which made _completeLap read
    // lapMs as null and lock the very first lap in as the reference forever.
    if (!this.gt7LapStart) this.gt7LapStart = now;
    if (this.lapNum !== null && lapCount !== this.lapNum) {
      this.gt7Dist = 0;
      this.gt7LapStart = now;
    }

    this.sample({
      dist: this.gt7Dist,
      speed: speedMs * 3.6,
      brake,
      gear,
      lapNum: lapCount,
      lapMsAtSample: now - this.gt7LapStart,
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
    this.samples = [];
    this._braking = false;
    this._matched = null;

    if (laps.length < 100) return;

    const invalid = laps.some((s) => s.inv);
    const lapMs = laps[laps.length - 1].t ?? null;
    const zones = extractZones(laps);
    if (invalid || !zones.length) return;

    // Replace the reference when it has no times to compare against, which is
    // how an older record written without a lap time gets healed rather than
    // blocking every future lap.
    const better =
      !this.reference?.zones?.length ||
      this.reference.lapMs == null ||
      lapMs == null ||
      lapMs < this.reference.lapMs;
    if (!better) return;

    this.reference = {
      lapMs,
      zones,
      trackLength: this.trackLength ?? this.reference?.trackLength ?? null,
      updatedAt: Date.now(),
    };
    this._save();
    console.log(
      `[coach] new reference lap ${lapMs ?? "unknown"}ms with ${zones.length} braking zones`,
    );
  }

  // What should the driver know right now?
  next(dist) {
    if (!this.reference?.zones?.length || dist == null) return null;
    const zones = this.reference.zones;
    const z = zones.find((z) => z.start > dist + 20) ?? zones[0];
    if (!z) return null;

    let inMeters = z.start - dist;
    if (inMeters < 0) {
      const len = this.trackLength ?? this.reference.trackLength;
      // Without a circuit length there is no way to wrap past the start line,
      // and a negative distance to the next corner is worse than no answer.
      if (!len) return null;
      inMeters += len;
    }

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
      minGear = s.g > 0 ? s.g : 9;
    } else if (inZone) {
      if (s.v < minSpeed) minSpeed = s.v;
      // Lowest gear used anywhere in the zone, which is what _gradeBraking
      // measures. Recording the gear at the minimum-speed sample instead put
      // the two on different definitions, so a corner where the driver was
      // already back on the throttle at the apex reported a gear mismatch
      // against a lap it exactly matched.
      if (s.g > 0) minGear = Math.min(minGear, s.g);
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

  // Merge zones closer than MIN_ZONE_GAP_M, measuring against the last zone we
  // kept rather than the last one seen. Comparing against a dropped neighbour
  // chains the exclusions and eats corners that are genuinely separate.
  const kept = [];
  for (const z of zones) {
    const prev = kept[kept.length - 1];
    if (!prev || z.start - prev.start > MIN_ZONE_GAP_M) kept.push(z);
  }
  return kept.map((z, i) => ({ ...z, cornerIndex: i + 1 }));
}
