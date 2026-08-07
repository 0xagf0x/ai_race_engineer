// Lap learner: records your laps, keeps the fastest valid one as reference,
// extracts braking zones from it, and coaches you toward the next corner.
//
// F1: uses lapDistance straight from telemetry.
// GT7: integrates speed over time into a pseudo lap distance (reset each lap).
// Zones persist per track in data/tracks/.

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data/tracks");

export class Coach {
  constructor() {
    this.trackKey = null;
    this.reference = null; // { lapMs, zones: [{start, entrySpeed, minSpeed, gear}] }
    this.samples = [];
    this.lapNum = null;
    this.lapStartTime = 0;
    this.gt7Dist = 0;
    this.gt7LastT = 0;
  }

  setTrack(key) {
    if (key === this.trackKey) return;
    this.trackKey = key;
    this.samples = [];
    this.reference = this._load(key);
  }

  _file(key) { return path.join(DATA_DIR, `${String(key).replace(/[^\w-]/g, "_")}.json`); }
  _load(key) {
    try { return JSON.parse(fs.readFileSync(this._file(key), "utf8")); } catch { return null; }
  }
  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(this._file(this.trackKey), JSON.stringify(this.reference));
    } catch { /* non-fatal */ }
  }

  // Called at telemetry rate. dist = lap distance in meters.
  sample({ dist, speed, brake, gear, lapNum, lapMsAtSample, invalid }) {
    if (this.trackKey == null || dist == null || dist < 0) return;

    if (this.lapNum !== null && lapNum !== this.lapNum) {
      this._completeLap();
    }
    this.lapNum = lapNum;
    this.samples.push({ d: dist, v: speed, b: brake, g: gear, inv: !!invalid, t: lapMsAtSample });
    if (this.samples.length > 20000) this.samples.shift();
  }

  gt7Sample({ speedMs, brake, gear, lapCount, now }) {
    if (this.gt7LastT) this.gt7Dist += speedMs * ((now - this.gt7LastT) / 1000);
    this.gt7LastT = now;
    if (this.lapNum !== null && lapCount !== this.lapNum) this.gt7Dist = 0;
    this.sample({ dist: this.gt7Dist, speed: speedMs * 3.6, brake, gear, lapNum: lapCount });
  }

  _completeLap() {
    const laps = this.samples;
    if (laps.length < 100) { this.samples = []; return; }
    const invalid = laps.some((s) => s.inv);
    const lapMs = laps[laps.length - 1].t ?? null;
    const zones = extractZones(laps);
    const better = !this.reference || (lapMs && this.reference.lapMs && lapMs < this.reference.lapMs) || !this.reference.zones?.length;
    if (!invalid && zones.length && better) {
      this.reference = { lapMs, zones, updatedAt: Date.now() };
      this._save();
    }
    this.samples = [];
  }

  // What should the driver know right now?
  next(dist) {
    if (!this.reference?.zones?.length || dist == null) return null;
    const z = this.reference.zones.find((z) => z.start > dist + 20) ?? this.reference.zones[0];
    if (!z) return null;
    let inMeters = z.start - dist;
    if (inMeters < 0 && this.reference.trackLength) inMeters += this.reference.trackLength;
    return {
      brakeInM: Math.round(inMeters),
      entrySpeedKph: Math.round(z.entrySpeed),
      minSpeedKph: Math.round(z.minSpeed),
      gear: z.gear,
      zoneStartM: Math.round(z.start),
      referenceLap: this.reference.lapMs,
    };
  }
}

// Find sustained braking zones (brake > 0.25 for >= ~0.2s of samples).
function extractZones(samples) {
  const zones = [];
  let inZone = false, start = 0, entrySpeed = 0, minSpeed = Infinity, minGear = 9;
  for (const s of samples) {
    if (!inZone && s.b > 0.25) {
      inZone = true; start = s.d; entrySpeed = s.v; minSpeed = s.v; minGear = s.g;
    } else if (inZone) {
      if (s.v < minSpeed) { minSpeed = s.v; minGear = s.g; }
      if (s.b < 0.1 && s.v <= minSpeed + 2) {
        if (entrySpeed - minSpeed > 25) {
          zones.push({ start: Math.round(start), entrySpeed, minSpeed, gear: Math.max(1, minGear) });
        }
        inZone = false;
      }
    }
  }
  // De-dupe zones closer than 60m apart
  return zones.filter((z, i) => i === 0 || z.start - zones[i - 1].start > 60);
}
