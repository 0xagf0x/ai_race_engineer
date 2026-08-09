// Strategy engine tests. Synthetic stints with a known degradation slope, so
// the expected numbers are exact rather than eyeballed.
//
// The reason this file exists: the strategy engine produces plausible-looking
// numbers from any input. A wrong sign or a fuel correction applied backwards
// does not throw, it just quietly tells the driver to box at the wrong moment.

import test from "node:test";
import assert from "node:assert/strict";
import { Strategy } from "../src/strategy.js";

const BASE_MS = 90000;
const DEG = 0.12; // seconds per lap of tyre age
const FUEL_EFFECT = 0.05; // must match the constant in strategy.js

// Build state for one completed lap.
function lapState({
  lapNum,
  lastLapMs,
  tyreAge,
  compound = "C3",
  mode = "race",
  invalid = false,
  pit = "",
  safetyCar = "none",
  totalLaps = 20,
  extraSession = {},
  extraStatus = {},
  opponents = [],
}) {
  return {
    game: "f1",
    session: { mode, totalLaps, safetyCar, ...extraSession },
    player: {
      lap: { currentLapNum: lapNum, lastLapMs, invalid, pit },
      status: { tyreCompound: compound, tyreAgeLaps: tyreAge, ...extraStatus },
    },
    opponents,
  };
}

/**
 * Drive a stint at a known degradation rate.
 *
 * Lap time rises by DEG per lap of tyre age and falls by FUEL_EFFECT per lap as
 * the tank empties, which is what the real telemetry looks like. The engine has
 * to add the fuel effect back to recover DEG, so a correct implementation
 * returns DEG and a broken one returns DEG minus FUEL_EFFECT.
 */
function driveStint(strat, { fromLap, laps, compound = "C3", opts = {} }) {
  for (let i = 0; i < laps; i++) {
    const age = i + 1;
    const ms = BASE_MS + age * DEG * 1000 - age * FUEL_EFFECT * 1000;
    strat.onLapComplete(
      lapState({
        lapNum: fromLap + i,
        lastLapMs: Math.round(ms),
        tyreAge: age,
        compound,
        ...opts,
      }),
    );
  }
}

test("no degradation model before there is enough data", () => {
  const s = new Strategy();
  driveStint(s, { fromLap: 1, laps: 3 });
  const deg = s.degradation("C3", { tyreSets: null });
  assert.equal(deg.source, "none");
});

test("falls back to the game's own prediction as a cold start", () => {
  const s = new Strategy();
  const state = {
    tyreSets: { sets: [{ fitted: true, usableLifeLaps: 14, compound: "C3" }] },
  };
  const deg = s.degradation("C3", state);
  assert.equal(deg.source, "game");
  assert.equal(deg.usableLifeLaps, 14);
});

test("measures degradation from own stints and corrects for fuel", () => {
  const s = new Strategy();
  driveStint(s, { fromLap: 1, laps: 10 });
  const deg = s.degradation("C3", { tyreSets: null });
  assert.equal(deg.source, "measured", "ten clean laps should be enough");
  assert.ok(
    Math.abs(deg.secPerLap - DEG) < 0.02,
    `slope was ${deg.secPerLap}, expected about ${DEG}. If it is near ${DEG - FUEL_EFFECT} the fuel correction is missing or has the wrong sign.`,
  );
  assert.equal(deg.confidence, "good");
});

test("own measurement beats the game's prediction once it exists", () => {
  const s = new Strategy();
  driveStint(s, { fromLap: 1, laps: 10 });
  const state = {
    tyreSets: { sets: [{ fitted: true, usableLifeLaps: 14 }] },
  };
  assert.equal(s.degradation("C3", state).source, "measured");
});

test("laps that say nothing about pace are excluded", () => {
  const s = new Strategy();
  // in-lap, invalid lap, and a safety car lap all land in the same stint
  s.onLapComplete(lapState({ lapNum: 1, lastLapMs: 90000, tyreAge: 1 }));
  s.onLapComplete(
    lapState({ lapNum: 2, lastLapMs: 140000, tyreAge: 2, pit: "PIT" }),
  );
  s.onLapComplete(
    lapState({ lapNum: 3, lastLapMs: 99000, tyreAge: 3, invalid: true }),
  );
  s.onLapComplete(
    lapState({ lapNum: 4, lastLapMs: 130000, tyreAge: 4, safetyCar: "full" }),
  );
  s.onLapComplete(lapState({ lapNum: 5, lastLapMs: 90500, tyreAge: 5 }));

  const stints = s.export();
  assert.equal(stints.length, 1);
  assert.equal(stints[0].laps.length, 2, "only the two green valid laps count");
});

test("a new set closes the stint and starts another", () => {
  const s = new Strategy();
  driveStint(s, { fromLap: 1, laps: 6, compound: "C3" });
  // tyre age resets: a stop happened
  driveStint(s, { fromLap: 7, laps: 6, compound: "C2" });

  const stints = s.export();
  assert.equal(stints.length, 2);
  assert.equal(stints[0].compound, "C3");
  assert.equal(stints[1].compound, "C2");
});

test("degradation is per compound, not pooled across them", () => {
  const s = new Strategy();
  driveStint(s, { fromLap: 1, laps: 8, compound: "C3" });
  driveStint(s, { fromLap: 9, laps: 8, compound: "C1" });
  assert.equal(s.degradation("C3", { tyreSets: null }).source, "measured");
  assert.equal(s.degradation("C1", { tyreSets: null }).source, "measured");
  // A compound never run has nothing to say about it.
  assert.equal(s.degradation("C5", { tyreSets: null }).source, "none");
});

test("previous visits feed the model", () => {
  const first = new Strategy();
  driveStint(first, { fromLap: 1, laps: 8 });
  const carried = first.export();

  const next = new Strategy();
  next.loadPriors({ stints: carried });
  // No laps driven this session at all, but the model still knows the circuit.
  const deg = next.degradation("C3", { tyreSets: null });
  assert.equal(deg.source, "measured");
  assert.ok(Math.abs(deg.secPerLap - DEG) < 0.02);
});

test("pit loss prefers a measured stop over the seeded estimate", () => {
  const s = new Strategy();
  assert.equal(s.pitLoss({ session: { pitLossSec: 20 } }).source, "seeded");
  assert.equal(
    s.pitLoss({ session: { pitLossSec: 20, measuredPitLossSec: 19.4 } }).source,
    "measured",
  );
  // A stop time that is not physically possible is not trusted at all.
  assert.equal(
    s.pitLoss({ session: { measuredPitLossSec: 2.1 } }).source,
    "none",
  );
});

test("fuel target is null when there is margin, and a rate when short", () => {
  const s = new Strategy();
  const fine = s.fuelTarget(
    lapState({
      lapNum: 5,
      lastLapMs: 90000,
      tyreAge: 5,
      extraStatus: { fuelDeltaLaps: 2.8, fuelInTank: 60 },
    }),
  );
  assert.equal(fine, null, "surplus fuel needs no target");

  const short = s.fuelTarget(
    lapState({
      lapNum: 10,
      lastLapMs: 90000,
      tyreAge: 5,
      totalLaps: 20,
      extraStatus: { fuelDeltaLaps: -1.5, fuelInTank: 30 },
    }),
  );
  assert.ok(short, "a shortfall should produce a target");
  assert.equal(short.shortfallLaps, 1.5);
  assert.equal(short.lapsRemaining, 10);
  assert.ok(
    short.saveKgPerLap > 0 && short.saveKgPerLap < 2,
    `saveKgPerLap was ${short.saveKgPerLap}`,
  );
});

test("brief is silent outside a race", () => {
  const s = new Strategy();
  driveStint(s, { fromLap: 1, laps: 10 });
  assert.equal(
    s.brief(
      lapState({ lapNum: 11, lastLapMs: 90000, tyreAge: 1, mode: "quali" }),
    ),
    null,
  );
});

test("brief reports that it cannot advise rather than guessing", () => {
  const s = new Strategy();
  const state = lapState({ lapNum: 2, lastLapMs: 90000, tyreAge: 2 });
  state.tyreSets = null;
  const b = s.brief(state);
  assert.equal(b.available, false, "no deg, no pit loss, no fuel target");
});

test("undercut refuses to advise on a seeded pit loss", () => {
  const s = new Strategy();
  driveStint(s, { fromLap: 1, laps: 10 });
  const state = lapState({
    lapNum: 11,
    lastLapMs: 90000,
    tyreAge: 10,
    extraSession: { pitLossSec: 20 }, // seeded only
    opponents: [
      { name: "YOU", position: 2, isPlayer: true, deltaAheadMs: 1200 },
      { name: "LECLERC", position: 1, isPlayer: false, tyreAge: 18 },
    ],
  });
  const u = s.undercut(state, {
    name: "LECLERC",
    tyreAge: 18,
  });
  assert.ok(u, "the numbers should still be computed");
  assert.equal(u.pitLossSource, "seeded");
  assert.equal(u.advise, false, "a guessed pit loss must not drive a call");
});

test("undercut advises once pit loss is measured and deg is confident", () => {
  const s = new Strategy();
  driveStint(s, { fromLap: 1, laps: 12 });
  const state = lapState({
    lapNum: 13,
    lastLapMs: 90000,
    tyreAge: 12,
    extraSession: { measuredPitLossSec: 19.4 },
  });
  const u = s.undercut(state, { name: "LECLERC", tyreAge: 20 });
  assert.ok(u);
  assert.equal(u.advise, true);
  assert.ok(u.gainPerLapSec > 0);
  assert.equal(u.pitLossSec, 19.4);
});
