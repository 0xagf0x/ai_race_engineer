// Session store tests. RACE_DATA_DIR keeps these out of the real data folder,
// so a test run can never clobber a reference lap you actually earned.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SessionStore } from "../src/sessions.js";

const DIR = path.resolve(
  process.env.RACE_DATA_DIR ?? ".tmp-test-data",
  "sessions",
);
const wipe = () => fs.rmSync(DIR, { recursive: true, force: true });

// minimal stand-ins for the live objects
const fakeState = (over = {}) => ({
  game: "f1",
  session: {
    track: "Spa",
    trackId: 10,
    type: "Race",
    mode: "race",
    measuredPitLossSec: 18.4,
  },
  player: {
    lap: {
      position: 4,
      currentLapNum: 12,
      resultStatus: "Finished",
      idealLapMs: 104200,
    },
    status: { tyre: "Medium", tyreCompound: "C3", tyreAgeLaps: 12 },
    damage: { tyreWear: [31, 28, 40, 38] },
  },
  ...over,
});

const fakeArc = (over = {}) => ({
  startPosition: 8,
  bestLapMs: 104800,
  lapTimes: [{ ms: 105200 }, { ms: 104800 }, { ms: 105400 }, { ms: 105000 }],
  penalties: [],
  log: [],
  netFromStart: () => 4,
  ...over,
});

const fakeDelta = (worst = []) => ({
  refLapMs: 104800,
  worstSegments: () => worst,
});

test("builds and saves a record", () => {
  wipe();
  const store = new SessionStore();
  const rec = store.build(fakeState(), fakeArc(), fakeDelta());
  assert.equal(rec.track, "Spa");
  assert.equal(rec.result.startedP, 8);
  assert.equal(rec.result.netPlaces, 4);
  assert.equal(rec.pace.lapCount, 4);
  assert.ok(rec.pace.spreadMs > 0, "consistency spread should be computed");
  assert.ok(store.save(rec));
});

test("saving is idempotent within a session", () => {
  wipe();
  const store = new SessionStore();
  const rec = store.build(fakeState(), fakeArc(), fakeDelta());
  assert.ok(store.save(rec));
  assert.equal(
    store.save(rec),
    null,
    "a repeated flag must not duplicate the record",
  );
});

test("a session with no laps is not recorded", () => {
  wipe();
  const store = new SessionStore();
  const rec = store.build(fakeState(), fakeArc({ lapTimes: [] }), fakeDelta());
  assert.equal(store.save(rec), null);
});

test("no priors before the first visit", () => {
  wipe();
  assert.equal(new SessionStore().priors("f1-10"), null);
});

test("priors surface only weaknesses that recur across sessions", () => {
  wipe();
  const oneOff = { fromM: 200, toM: 400, lostSec: 0.9 };
  const chronic = { fromM: 1200, toM: 1400, lostSec: 0.3 };

  for (const worst of [[chronic, oneOff], [chronic], [chronic]]) {
    const store = new SessionStore();
    store.begin();
    store.save(store.build(fakeState(), fakeArc(), fakeDelta(worst)));
  }

  const p = new SessionStore().priors("f1-10");
  assert.equal(p.sessionsHere, 3);
  assert.equal(
    p.recurringWeakSpots.length,
    1,
    "the one-off should be filtered out",
  );
  assert.equal(p.recurringWeakSpots[0].fromM, 1200);
  assert.equal(p.recurringWeakSpots[0].seenInSessions, 3);
  assert.equal(p.typicalPitLossSec, 18.4);
});

test("priors track the all-time best lap across visits", () => {
  wipe();
  for (const best of [105500, 103900, 104600]) {
    const store = new SessionStore();
    store.begin();
    store.save(
      store.build(fakeState(), fakeArc({ bestLapMs: best }), fakeDelta()),
    );
  }
  const p = new SessionStore().priors("f1-10");
  assert.equal(p.allTimeBestLapMs, 103900);
  assert.equal(
    p.lastVisit.bestLapMs,
    104600,
    "last visit is the most recent, not the best",
  );
  wipe();
});
