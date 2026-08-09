// Live delta to the reference lap, and where the time is actually going.
//
// Both games now have a trustworthy distance axis: F1 sends lapDistance, GT7
// gets it from the track model. So this is one implementation for both.
//
// The reference is stored as time-at-distance sampled every STEP_M metres.
// Delta is then a lookup: how long the reference took to reach where you are
// now, against how long you have taken.
//
// The segment breakdown is the part worth having. Sampling delta at fixed
// distance boundaries and differencing it tells you which stretch of track the
// time came from, which is the difference between "three tenths off" and
// "you're losing all of it between turn 4 and turn 5".

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.RACE_DATA_DIR
  ? path.resolve(process.env.RACE_DATA_DIR, "tracks")
  : path.resolve("data/tracks");
const STEP_M = 10; // reference resolution
const SEGMENT_M = 200; // loss attribution bucket

export class Delta {
  constructor() {
    this.key = null;
    this.ref = null; // Float32Array of ms, indexed by distance / STEP_M
    this.refLapMs = null;
    this.trackLengthM = null;

    this.current = []; // {d, t} for the lap in progress
    this.lapNum = null;
    this.value = null; // live delta in ms, negative is up on the reference
    this.lastDistance = 0;
    this.segments = []; // {fromM, toM, deltaMs} for the lap in progress
    this._segStartDelta = 0;
    this._segIndex = 0;
  }

  get ready() {
    return this.ref != null;
  }

  /**
   * A flashback invalidates the lap in progress: the sample array has distance
   * running forward, then jumping back, which makes the reference curve
   * non-monotonic and the segment attribution meaningless. The completed laps
   * behind it are untouched.
   */
  rewind() {
    this.current = [];
    this.lastDistance = 0;
    this.segments = [];
    this._segIndex = 0;
    this._segStartDelta = 0;
    this.value = null;
  }

  setTrack(key, trackLengthM) {
    if (key === this.key) {
      if (trackLengthM) this.trackLengthM = trackLengthM;
      return;
    }
    this.key = key;
    this.trackLengthM = trackLengthM ?? null;
    this.ref = null;
    this.refLapMs = null;
    this._load();
  }

  _file() {
    return path.join(
      DATA_DIR,
      `${String(this.key).replace(/[^\w-]/g, "_")}-delta.json`,
    );
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._file(), "utf8"));
      if (Array.isArray(raw.times) && raw.times.length > 10) {
        this.ref = Float32Array.from(raw.times);
        this.refLapMs = raw.lapMs;
        this.trackLengthM ??= raw.trackLengthM;
        console.log(
          `[delta] reference lap ${(raw.lapMs / 1000).toFixed(3)}s loaded for ${this.key}`,
        );
      }
    } catch {
      this.ref = null;
    }
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        this._file(),
        JSON.stringify({
          lapMs: this.refLapMs,
          trackLengthM: this.trackLengthM,
          stepM: STEP_M,
          times: Array.from(this.ref, (v) => Math.round(v)),
        }),
      );
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Feed one telemetry sample.
   * @param {number} distanceM distance around the lap
   * @param {number} elapsedMs time into the current lap
   * @param {number} lapNum
   * @param {boolean} invalid lap has been invalidated, don't promote it
   */
  update(distanceM, elapsedMs, lapNum, invalid = false) {
    if (!Number.isFinite(distanceM) || !Number.isFinite(elapsedMs)) return;

    if (this.lapNum !== null && lapNum !== this.lapNum) {
      this._completeLap(invalid);
    }
    this.lapNum = lapNum;

    // Distance can jog backwards a little on noisy samples; only record forward
    // progress or the reference curve ends up non-monotonic.
    if (distanceM > this.lastDistance || this.current.length === 0) {
      this.current.push({ d: distanceM, t: elapsedMs });
      this.lastDistance = distanceM;
    }

    this.value = this.at(distanceM, elapsedMs);
    this._trackSegment(distanceM);
  }

  /** Delta in ms at a given point, negative meaning up on the reference. */
  at(distanceM, elapsedMs) {
    if (!this.ref) return null;
    const maxIdx = this.ref.length - 1;
    let idx = distanceM / STEP_M;
    if (idx < 0) return null;
    // Clamp at the finish line rather than returning null for the last sample
    // of every lap, which is exactly the sample you most want.
    if (idx > maxIdx) idx = maxIdx;
    const i = Math.min(Math.floor(idx), maxIdx - 1);
    const frac = idx - i;
    const refMs = this.ref[i] + (this.ref[i + 1] - this.ref[i]) * frac;
    // A reference time of 0 is legitimate at the start line, so test for a
    // number rather than for truthiness.
    if (!Number.isFinite(refMs)) return null;
    return Math.round(elapsedMs - refMs);
  }

  // Close off a segment every SEGMENT_M and record how much time moved in it.
  _trackSegment(distanceM) {
    if (this.value == null) return;
    const idx = Math.floor(distanceM / SEGMENT_M);
    if (idx === this._segIndex) return;
    if (idx > this._segIndex) {
      this.segments.push({
        fromM: this._segIndex * SEGMENT_M,
        toM: idx * SEGMENT_M,
        deltaMs: Math.round(this.value - this._segStartDelta),
      });
    }
    this._segIndex = idx;
    this._segStartDelta = this.value;
  }

  _completeLap(invalid) {
    const lap = this.current;
    this.current = [];
    this.lastDistance = 0;
    this._segIndex = 0;
    this._segStartDelta = 0;
    this.lastLapSegments = this.segments;
    this.segments = [];

    if (invalid || lap.length < 50) return;
    const lapMs = lap[lap.length - 1].t;
    if (!lapMs || lapMs < 10000) return;

    // Only promote a genuinely quicker lap.
    if (this.refLapMs && lapMs >= this.refLapMs) return;

    const lengthM = this.trackLengthM ?? lap[lap.length - 1].d;
    const steps = Math.floor(lengthM / STEP_M) + 1;
    const times = new Float32Array(steps);

    // Walk the samples once, filling each step with an interpolated time.
    let si = 0;
    for (let step = 0; step < steps; step++) {
      const d = step * STEP_M;
      while (si < lap.length - 2 && lap[si + 1].d < d) si++;
      const a = lap[si];
      const b = lap[si + 1] ?? a;
      const span = b.d - a.d;
      times[step] = span > 0 ? a.t + ((d - a.d) / span) * (b.t - a.t) : a.t;
    }

    this.ref = times;
    this.refLapMs = lapMs;
    this._save();
    console.log(
      `[delta] new reference lap ${(lapMs / 1000).toFixed(3)}s for ${this.key}`,
    );
  }

  /**
   * The worst stretches of the last completed lap, for the debrief and for
   * answering "where am I losing time".
   *
   * Losses rarely respect bucket boundaries: one bad corner exit bleeds across
   * two segments and would otherwise be reported as two separate half-losses.
   * Adjacent losing segments are merged so the answer names one stretch.
   */
  worstSegments(n = 3) {
    if (!this.lastLapSegments?.length) return [];

    const merged = [];
    for (const s of this.lastLapSegments) {
      if (s.deltaMs <= 30) continue;
      const prev = merged[merged.length - 1];
      if (prev && prev.toM === s.fromM) {
        prev.toM = s.toM;
        prev.deltaMs += s.deltaMs;
      } else {
        merged.push({ ...s });
      }
    }

    return merged
      .sort((a, b) => b.deltaMs - a.deltaMs)
      .slice(0, n)
      .map((s) => ({ ...s, lostSec: +(s.deltaMs / 1000).toFixed(2) }));
  }

  /** Compact block for the engineer prompt. */
  brief() {
    if (!this.ready) return null;
    return {
      referenceLapSec: +(this.refLapMs / 1000).toFixed(3),
      liveDeltaSec: this.value != null ? +(this.value / 1000).toFixed(2) : null,
      losingMostTime: this.worstSegments(2).map(
        (s) => `${s.lostSec}s between ${s.fromM} and ${s.toM} metres`,
      ),
    };
  }
}
