// GT7 track model.
//
// GT7 sends world position but no track id and no lap distance. The old
// approach integrated speed over time, which drifts over a lap and takes brake
// point accuracy with it. This builds a real geometric model instead:
//
//   1. record (x, z) while driving
//   2. on a completed lap, resample the path to fixed spacing -> centreline
//   3. fingerprint the geometry so the same circuit is recognised next time
//   4. project live position onto the centreline -> exact lap distance, plus
//      lateral offset from the reference line
//
// That last number is the interesting one. Lateral offset is how we know he ran
// wide without the game ever telling us, which is the closest GT7 gets to
// track limits data.
//
// y is vertical in GT7, so all of this works in the x/z ground plane.

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.RACE_DATA_DIR
  ? path.resolve(process.env.RACE_DATA_DIR, "tracks")
  : path.resolve("data/tracks");
const SPACING_M = 5; // centreline resolution
const SEARCH_WINDOW = 40; // points either side of the last match
const MIN_LAP_POINTS = 200;

// ---------- geometry helpers ----------

const dist2 = (ax, az, bx, bz) => (ax - bx) ** 2 + (az - bz) ** 2;

/**
 * Resample a polyline to even spacing along its arc length, carrying a running
 * cumulative distance. `acc` is the path length up to the start of the current
 * segment; `emitted` is the distance of the last point we wrote out.
 */
function resample(points, spacing = SPACING_M) {
  if (points.length < 2) return [];
  const out = [{ x: points[0].x, z: points[0].z, d: 0 }];
  let acc = 0; // path length up to points[i - 1]
  let emitted = 0; // distance of the last emitted point

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.sqrt(dist2(a.x, a.z, b.x, b.z));
    if (seg === 0) continue;

    let next = emitted + spacing;
    while (next <= acc + seg) {
      const t = (next - acc) / seg;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, d: next });
      emitted = next;
      next += spacing;
    }
    acc += seg;
  }
  return out;
}

/**
 * A signature that identifies a circuit without needing a track id. Bounding
 * box and length are cheap discriminators; the heading histogram catches the
 * case where two circuits happen to share a similar footprint.
 */
function fingerprint(centreline) {
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of centreline) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }

  // 16-bucket histogram of heading direction, normalised
  const buckets = new Array(16).fill(0);
  for (let i = 1; i < centreline.length; i++) {
    const a = centreline[i - 1];
    const b = centreline[i];
    const ang = Math.atan2(b.z - a.z, b.x - a.x);
    const idx = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 16) % 16;
    buckets[idx]++;
  }
  const sum = buckets.reduce((a, b) => a + b, 0) || 1;

  return {
    lengthM: Math.round(centreline[centreline.length - 1].d),
    widthM: Math.round(maxX - minX),
    depthM: Math.round(maxZ - minZ),
    headings: buckets.map((b) => +(b / sum).toFixed(3)),
  };
}

/** Two fingerprints describe the same circuit? */
function matches(a, b) {
  const near = (x, y, tol) => Math.abs(x - y) / Math.max(y, 1) < tol;
  if (!near(a.lengthM, b.lengthM, 0.04)) return false;
  if (!near(a.widthM, b.widthM, 0.08)) return false;
  if (!near(a.depthM, b.depthM, 0.08)) return false;
  // heading histograms: mean absolute difference
  const mad =
    a.headings.reduce((acc, v, i) => acc + Math.abs(v - b.headings[i]), 0) / 16;
  return mad < 0.02;
}

function fileKey(fp) {
  return `gt7-${fp.lengthM}-${fp.widthM}x${fp.depthM}`;
}

// ---------- model ----------

export class TrackModel {
  constructor() {
    this.centreline = null; // [{x, z, d}]
    this.fingerprint = null;
    this.key = null;
    this.samples = []; // current lap
    this.lapNum = null;
    this.lastIdx = 0; // projection hint
    this.cornerSpread = {}; // learned lateral spread per distance bucket
    this._loadedAll = null;
  }

  get ready() {
    return this.centreline != null;
  }

  get lengthM() {
    return this.centreline
      ? this.centreline[this.centreline.length - 1].d
      : null;
  }

  // Every stored GT7 model, loaded once, so a known circuit is recognised
  // partway through the first lap rather than at the end of it.
  _allStored() {
    if (this._loadedAll) return this._loadedAll;
    this._loadedAll = [];
    try {
      for (const f of fs.readdirSync(DATA_DIR)) {
        if (!f.startsWith("gt7-") || !f.endsWith(".json")) continue;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
          if (m.centreline?.length && m.fingerprint) this._loadedAll.push(m);
        } catch {
          /* skip unreadable model */
        }
      }
    } catch {
      /* no data dir yet */
    }
    return this._loadedAll;
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DATA_DIR, `${this.key}.json`),
        JSON.stringify({
          fingerprint: this.fingerprint,
          centreline: this.centreline,
          cornerSpread: this.cornerSpread,
          updatedAt: Date.now(),
        }),
      );
    } catch {
      /* non-fatal */
    }
  }

  /** Called at telemetry rate with GT7 world position. */
  addSample({ x, z, lapCount }) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;

    if (this.lapNum !== null && lapCount !== this.lapNum) {
      this._completeLap();
      this.samples = [];
    }
    this.lapNum = lapCount;

    // drop duplicates, the car is stationary or the packet repeated
    const last = this.samples[this.samples.length - 1];
    if (!last || dist2(last.x, last.z, x, z) > 0.25) {
      this.samples.push({ x, z });
    }

    // Try to recognise a stored circuit early in the first lap.
    if (!this.centreline && this.samples.length === 300)
      this._tryRecogniseEarly();
  }

  // Match the partial path against stored centrelines by how well the points
  // land on them. Cheap enough at 300 points and saves waiting a whole lap.
  _tryRecogniseEarly() {
    for (const stored of this._allStored()) {
      let hits = 0;
      for (let i = 0; i < this.samples.length; i += 10) {
        const s = this.samples[i];
        let best = Infinity;
        for (const p of stored.centreline) {
          const d = dist2(s.x, s.z, p.x, p.z);
          if (d < best) best = d;
        }
        if (best < 400) hits++; // within 20m of the reference line
      }
      if (hits / Math.ceil(this.samples.length / 10) > 0.8) {
        this.centreline = stored.centreline;
        this.fingerprint = stored.fingerprint;
        this.cornerSpread = stored.cornerSpread ?? {};
        this.key = fileKey(stored.fingerprint);
        console.log(
          `[track] recognised ${this.key}, ${this.lengthM}m centreline`,
        );
        return;
      }
    }
  }

  _completeLap() {
    if (this.samples.length < MIN_LAP_POINTS) return;
    const line = resample(this.samples);
    if (line.length < 50) return;
    const fp = fingerprint(line);

    // Sanity: circuits are between 500m and 30km, and the lap has to close
    // roughly back on itself or it wasn't a full lap.
    const closeM = Math.sqrt(
      dist2(
        line[0].x,
        line[0].z,
        line[line.length - 1].x,
        line[line.length - 1].z,
      ),
    );
    if (fp.lengthM < 500 || fp.lengthM > 30000 || closeM > 120) return;

    if (this.centreline && this.fingerprint && matches(fp, this.fingerprint))
      return; // already have it

    const known = this._allStored().find((m) => matches(fp, m.fingerprint));
    if (known) {
      this.centreline = known.centreline;
      this.fingerprint = known.fingerprint;
      this.cornerSpread = known.cornerSpread ?? {};
      this.key = fileKey(known.fingerprint);
      console.log(`[track] matched stored model ${this.key}`);
      return;
    }

    this.centreline = line;
    this.fingerprint = fp;
    this.key = fileKey(fp);
    this._save();
    this._loadedAll = null; // force reload so the new one is matchable
    console.log(
      `[track] learned new circuit ${this.key}, ${fp.lengthM}m from ${line.length} points`,
    );
  }

  /**
   * Project a live position onto the centreline.
   * @returns {{distanceM:number, lateralM:number, wide:boolean}|null}
   */
  project(x, z) {
    if (!this.centreline || !Number.isFinite(x)) return null;
    const line = this.centreline;
    const n = line.length;

    // Search a window around the last match first; the car moves a few metres
    // per packet, so this is almost always a hit.
    let bestIdx = -1;
    let bestD = Infinity;
    const scan = (from, to) => {
      for (let i = from; i < to; i++) {
        const p = line[(i + n) % n];
        const d = dist2(x, z, p.x, p.z);
        if (d < bestD) {
          bestD = d;
          bestIdx = (i + n) % n;
        }
      }
    };
    scan(this.lastIdx - SEARCH_WINDOW, this.lastIdx + SEARCH_WINDOW);
    // Lost the thread (reset to track, teleport, first sample): full sweep.
    if (bestD > 2500) {
      bestD = Infinity;
      bestIdx = -1;
      scan(0, n);
    }
    if (bestIdx < 0) return null;
    this.lastIdx = bestIdx;

    // Snapping to the nearest vertex inherits half the centreline spacing as
    // error, and quantises distance to 5m steps. Project onto the two adjacent
    // segments instead for sub-metre lateral and a continuous distance.
    let lateral = Math.sqrt(bestD);
    let distanceM = line[bestIdx].d;
    for (const [i, j] of [
      [(bestIdx - 1 + n) % n, bestIdx],
      [bestIdx, (bestIdx + 1) % n],
    ]) {
      const a = line[i];
      const b = line[j];
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const len2 = vx * vx + vz * vz;
      if (len2 === 0) continue;
      let t = ((x - a.x) * vx + (z - a.z) * vz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + vx * t;
      const pz = a.z + vz * t;
      const d = Math.sqrt(dist2(x, z, px, pz));
      if (d < lateral) {
        lateral = d;
        // b.d wraps to 0 at the start/finish line, so step forward from a
        distanceM = a.d + t * Math.sqrt(len2);
      }
    }
    distanceM = +distanceM.toFixed(1);

    const bucket = Math.floor(distanceM / 50) * 50;
    const spread = this.cornerSpread[bucket];

    return {
      distanceM,
      lateralM: +lateral.toFixed(1),
      // Wide relative to how this driver normally takes this part of the track,
      // falling back to a fixed cap before enough laps have been seen.
      wide:
        spread?.n > 30
          ? lateral > spread.mean + 3 * spread.sd + 1
          : lateral > 8,
    };
  }

  /** Fold a clean lap's lateral offsets into the learned spread. */
  learnSpread(distanceM, lateralM) {
    const bucket = Math.floor(distanceM / 50) * 50;
    const s = (this.cornerSpread[bucket] ??= { n: 0, mean: 0, m2: 0, sd: 0 });
    s.n++;
    const delta = lateralM - s.mean;
    s.mean += delta / s.n;
    s.m2 += delta * (lateralM - s.mean);
    s.sd = s.n > 1 ? Math.sqrt(s.m2 / (s.n - 1)) : 0;
    if (s.n % 500 === 0) this._save();
  }
}
