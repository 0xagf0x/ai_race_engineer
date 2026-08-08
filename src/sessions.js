// Session records and priors.
//
// Everything the bridge learns during a session currently dies with the
// process. This writes a record at the flag and reads the accumulated history
// back at the start of the next session at the same circuit, which is what lets
// the engineer say "last time here you were losing two tenths at turn 4"
// instead of starting every session cold.
//
// Records are deliberately small and human readable. They are the raw material
// for the debrief now and for degradation modelling later.

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.RACE_DATA_DIR
  ? path.resolve(process.env.RACE_DATA_DIR, "sessions")
  : path.resolve("data/sessions");

const KEEP = 60; // most recent sessions retained per circuit

const safe = (s) => String(s ?? "unknown").replace(/[^\w-]/g, "_");

// Two sessions can end inside the same millisecond, and a record ordered only
// by a tied timestamp sorts arbitrarily. Ordering matters here because
// lastVisit and the prune both depend on it, so stamps are forced strictly
// upward within a process. Across processes real time still dominates, and
// history() breaks any remaining tie on the filename.
let lastStamp = 0;
function stamp() {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

export class SessionStore {
  constructor() {
    this.startedAt = Date.now();
    this.written = false;
  }

  /** New session starting: forget that we already wrote a record. */
  begin() {
    this.startedAt = Date.now();
    this.written = false;
  }

  /**
   * Assemble a record from everything the bridge has been tracking.
   * @param {object} state
   * @param {import("./racearc.js").RaceArc} arc
   * @param {import("./delta.js").Delta} delta
   */
  build(state, arc, delta) {
    const s = state.session ?? {};
    const lap = state.player?.lap ?? {};
    const st = state.player?.status ?? {};
    const finishedAt = stamp();
    const wear = state.player?.damage?.tyreWear;

    return {
      trackKey: this.trackKey(state),
      track: s.track ?? "unknown",
      game: state.game,
      sessionType: s.type ?? null,
      mode: s.mode ?? null,
      finishedAt,
      durationMin: +((finishedAt - this.startedAt) / 60000).toFixed(1),

      result: {
        startedP: arc.startPosition,
        finishedP: lap.position ?? null,
        netPlaces: arc.netFromStart(),
        totalLaps: lap.currentLapNum ?? null,
        status: lap.resultStatus || null,
      },

      pace: {
        bestLapMs: arc.bestLapMs || null,
        idealLapMs: lap.idealLapMs ?? null,
        referenceLapMs: delta?.refLapMs ?? null,
        // Consistency is how tightly the laps cluster, which says more about
        // race craft than a single quick lap does.
        spreadMs: spread(arc.lapTimes.map((l) => l.ms)),
        lapCount: arc.lapTimes.length,
      },

      // Where the time actually went on the last representative lap.
      weakSegments: delta?.worstSegments(4) ?? [],

      tyres: {
        compound: st.tyre ?? null,
        actual: st.tyreCompound ?? null,
        ageLaps: st.tyreAgeLaps ?? null,
        // Math.max() of an empty array is -Infinity, which would go straight
        // into permanent memory.
        worstWearPct: wear?.length ? Math.max(...wear) : null,
      },

      incidents: arc.log
        .filter((e) => ["penalty", "incident", "wide"].includes(e.kind))
        .map((e) => ({ kind: e.kind, lap: e.lap, text: e.text })),

      penalties: arc.penalties.map((p) => p.text),
      pitLossSec: s.measuredPitLossSec ?? null,
    };
  }

  /**
   * The circuit identity used to group sessions. F1 has a track id; GT7 uses
   * the geometric fingerprint key from the track model.
   */
  trackKey(state) {
    if (state.game === "f1") return `f1-${state.session?.trackId ?? "unknown"}`;
    return state.trackKey ?? "gt7-unknown";
  }

  /** Write the record. Idempotent per session so a repeated flag doesn't duplicate. */
  save(record) {
    if (this.written) return null;
    if (!record.pace.lapCount) return null; // nothing happened, not worth a file
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });

      // Stamps are unique within a process, but a second bridge writing to the
      // same folder could still land on this name. A session record is
      // permanent memory and must never silently overwrite another one.
      const base = `${safe(record.trackKey)}-${record.finishedAt}`;
      let file = path.join(DATA_DIR, `${base}.json`);
      for (let n = 1; fs.existsSync(file); n++) {
        file = path.join(DATA_DIR, `${base}-${n}.json`);
      }

      fs.writeFileSync(file, JSON.stringify(record, null, 2));
      this.written = true;
      this._prune(record.trackKey);
      console.log(
        `[session] recorded ${record.track}, ${record.pace.lapCount} laps`,
      );
      return file;
    } catch (e) {
      console.error("[session] could not write record:", e.message);
      return null;
    }
  }

  _prune(trackKey) {
    try {
      const entries = forTrack(trackKey); // oldest first
      for (const { file } of entries.slice(
        0,
        Math.max(0, entries.length - KEEP),
      )) {
        fs.rmSync(path.join(DATA_DIR, file), { force: true });
      }
    } catch {
      /* non-fatal */
    }
  }

  /** Every past record for a circuit, oldest first. */
  history(trackKey) {
    return forTrack(trackKey).map((e) => e.rec);
  }

  /**
   * What the engineer should already know when you arrive at a circuit.
   * This is the payload that makes him sound like he was there last time.
   */
  priors(trackKey) {
    const past = this.history(trackKey);
    if (!past.length) return null;

    const bests = past.map((p) => p.pace?.bestLapMs).filter(Boolean);
    const allTimeBest = bests.length ? Math.min(...bests) : null;

    // A weakness that shows up once is a bad lap. One that shows up across
    // sessions is something to work on, so only recurring stretches count.
    const buckets = new Map();
    for (const p of past) {
      for (const seg of p.weakSegments ?? []) {
        const key = `${seg.fromM}-${seg.toM}`;
        const b = buckets.get(key) ?? {
          key,
          fromM: seg.fromM,
          toM: seg.toM,
          n: 0,
          totalSec: 0,
        };
        b.n++;
        b.totalSec += seg.lostSec ?? 0;
        buckets.set(key, b);
      }
    }
    const recurring = [...buckets.values()]
      .filter((b) => b.n >= 2)
      .sort((a, b) => b.totalSec / b.n - a.totalSec / a.n)
      .slice(0, 3)
      .map((b) => ({
        fromM: b.fromM,
        toM: b.toM,
        seenInSessions: b.n,
        avgLostSec: +(b.totalSec / b.n).toFixed(2),
      }));

    const incidents = past.flatMap((p) => p.incidents ?? []);
    const wideCount = incidents.filter((i) => i.kind === "wide").length;
    const last = past[past.length - 1];

    return {
      sessionsHere: past.length,
      allTimeBestLapMs: allTimeBest,
      lastVisit: {
        when: last.finishedAt,
        finishedP: last.result?.finishedP ?? null,
        bestLapMs: last.pace?.bestLapMs ?? null,
      },
      recurringWeakSpots: recurring,
      typicalPitLossSec: median(past.map((p) => p.pitLossSec).filter(Boolean)),
      runningWideOften: wideCount >= 3 ? wideCount : null,
      penaltiesHere: past.flatMap((p) => p.penalties ?? []).slice(-4),
    };
  }
}

/**
 * Records for one circuit, oldest first.
 *
 * Grouping is by the trackKey stored inside each record, not by filename
 * prefix. safe() keeps hyphens, so the hyphen used as the filename delimiter
 * is also legal inside a key and a prefix match can pull in a different
 * circuit's sessions.
 *
 * The filename is the final tiebreak. Stamps are unique within a process, so
 * this only matters for records written by separate runs in the same
 * millisecond, but ordering must be total or lastVisit is a coin flip.
 */
function forTrack(trackKey) {
  const out = [];
  try {
    for (const file of fs.readdirSync(DATA_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(
          fs.readFileSync(path.join(DATA_DIR, file), "utf8"),
        );
        if (rec?.trackKey === trackKey) out.push({ file, rec });
      } catch {
        /* skip unreadable record */
      }
    }
  } catch {
    /* no sessions yet */
  }
  return out.sort(
    (a, b) =>
      (a.rec.finishedAt ?? 0) - (b.rec.finishedAt ?? 0) ||
      a.file.localeCompare(b.file),
  );
}

function spread(times) {
  const clean = times.filter((t) => t > 0);
  if (clean.length < 3) return null;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const sd = Math.sqrt(
    clean.reduce((a, t) => a + (t - mean) ** 2, 0) / (clean.length - 1),
  );
  return Math.round(sd);
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(1);
}
