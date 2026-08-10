// Tool surface tests. Run with `npm test`.
//
// These tools are the only thing the engineer's model ever sees. Everything it
// says out loud is downstream of a return value in here, so a wrong number is
// not a wrong number, it is the engineer confidently saying a wrong number on
// the radio mid-corner.
//
// Two things get the most attention. Gaps, because the F1 feed sends each car's
// delta to the car directly ahead and answering "how far to the leader" means
// summing a chain, which is the exact sum the old state dump invited the model
// to do for itself. And refusals, because a tool that returns a plausible zero
// when it has no data is worse than one that says it has none.

import test from "node:test";
import assert from "node:assert/strict";
import { runTool, validate, toolNames, TOOL_DEFS } from "../src/tools.js";

// ---------- fixtures ----------

// Chain of gaps to the car ahead: P2 1.5s, P3 2.0s, P4 3.0s, P5 0.8s, P6 0.9s.
// So the player in P5 is 0.8 behind P4 and 7.3 behind the leader.
const FIELD = [
  ["VERSTAPPEN", 1, 0, "H", 20],
  ["HAMILTON", 2, 1500, "M", 10],
  ["RUSSELL", 3, 2000, "M", 12],
  ["LECLERC", 4, 3000, "H", 24],
  ["YOU", 5, 800, "S", 18],
  ["NORRIS", 6, 900, "S", 6],
];

function f1State(over = {}) {
  return {
    game: "f1",
    session: {
      track: "Silverstone",
      type: "Race",
      mode: "race",
      totalLaps: 20,
      safetyCar: "none",
      measuredPitLossSec: 19.4,
    },
    player: {
      speed: 250,
      gear: 6,
      rpm: 11000,
      engineTemp: 95,
      lap: {
        currentLapNum: 12,
        position: 5,
        lastLapMs: 91600,
        bestLapMs: 91000,
        idealLapMs: 90500,
        penalties: 0,
        warnings: 1,
      },
      status: {
        tyre: "soft",
        tyreCompound: "C4",
        tyreAgeLaps: 18,
        ersStorePct: 40,
        fuelInTank: 30,
        fuelDeltaLaps: -1.5,
      },
      tyreSurfaceTemps: [118, 96, 99, 97],
      damage: {
        tyreWear: [72, 40, 51, 44],
        frontWing: 15,
        rearWing: 0,
        floor: 0,
      },
    },
    opponents: FIELD.map(([name, position, deltaAheadMs, tyre, tyreAge]) => ({
      name,
      position,
      deltaAheadMs,
      tyre,
      tyreAge,
      isPlayer: name === "YOU",
      lastLapMs: 91000,
      bestLapMs: 90500,
      pitStops: 1,
      penalties: 0,
      pit: "",
      status: "",
      team: "Team",
    })),
    ...over,
  };
}

const gt7State = () => ({
  game: "gt7",
  session: { track: "GT7 session", mode: "race" },
  player: {
    speed: 200,
    lap: { currentLapNum: 4, position: 3 },
    status: { fuelInTank: 40, fuelCapacity: 100 },
    tyreSurfaceTemps: [90, 88, 92, 89],
  },
  opponents: [],
});

// ---------- gaps ----------

test("the gap to the car ahead is read straight off the chain", () => {
  const r = runTool(f1State(), "get_gap", { to: "ahead" });
  assert.equal(r.available, true);
  assert.equal(r.rival, "LECLERC");
  assert.equal(r.gapSec, 0.8);
  assert.equal(r.theyAreAhead, true);
});

test("the gap to the leader sums every car in between", () => {
  const r = runTool(f1State(), "get_gap", { to: "leader" });
  // 0.8 to P4, 3.0 to P3, 2.0 to P2, 1.5 to P1
  assert.equal(r.gapSec, 7.3);
  assert.equal(r.rival, "VERSTAPPEN");
});

test("a car behind comes back as a negative gap", () => {
  const r = runTool(f1State(), "get_gap", { to: "behind" });
  assert.equal(r.rival, "NORRIS");
  assert.equal(r.gapSec, -0.9);
  assert.equal(r.theyAreAhead, false);
});

test("DRS is attributed to whoever is actually behind", () => {
  const ahead = runTool(f1State(), "get_gap", { to: "ahead" });
  assert.equal(ahead.youHaveDrsOnThem, true, "0.8 behind P4 is DRS for us");
  assert.equal(ahead.theyHaveDrsOnYou, false);

  const behind = runTool(f1State(), "get_gap", { to: "behind" });
  assert.equal(behind.theyHaveDrsOnYou, true, "0.9 back is DRS for him");
  assert.equal(
    behind.youHaveDrsOnThem,
    false,
    "a car chasing does not give us DRS",
  );
});

test("the leader is told there is no car ahead rather than given a zero", () => {
  const s = f1State();
  s.opponents = s.opponents.map((o) => ({ ...o, isPlayer: o.position === 1 }));
  const r = runTool(s, "get_gap", { to: "ahead" });
  assert.equal(r.available, false);
  assert.match(r.reason, /leading/);
});

test("a driver can be found by surname or a unique prefix", () => {
  assert.equal(
    runTool(f1State(), "get_gap", { to: "driver", name: "hamilton" }).rival,
    "HAMILTON",
  );
  assert.equal(
    runTool(f1State(), "get_rival", { name: "lec" }).name,
    "LECLERC",
  );
});

test("an unknown driver is refused, not resolved to the nearest row", () => {
  const r = runTool(f1State(), "get_rival", { name: "SCHUMACHER" });
  assert.equal(r.available, false);
  assert.match(r.reason, /SCHUMACHER/);
  assert.equal(r.name, undefined, "nothing about a driver who is not there");
});

test("an ambiguous prefix is refused rather than guessed", () => {
  const s = f1State();
  s.opponents.push({
    ...s.opponents[0],
    name: "VERSCHOOR",
    position: 7,
    isPlayer: false,
    deltaAheadMs: 1000,
  });
  assert.equal(runTool(s, "get_rival", { name: "VERS" }).available, false);
});

// ---------- refusals ----------

test("GT7 says it has no opponent data instead of returning nothing", () => {
  for (const call of [
    ["get_gap", { to: "ahead" }],
    ["get_rival", { name: "ANYONE" }],
    ["get_standings", {}],
  ]) {
    const r = runTool(gt7State(), ...call);
    assert.equal(r.available, false, `${call[0]} should refuse in GT7`);
    assert.match(r.reason, /GT7/);
  }
});

test("an empty tower points at the setting that causes it", () => {
  const s = f1State();
  s.opponents = [];
  const r = runTool(s, "get_gap", { to: "ahead" });
  assert.equal(r.available, false);
  assert.match(r.reason, /Restricted/);
});

test("own-car tools still work in GT7", () => {
  assert.equal(runTool(gt7State(), "get_tyres").available, true);
  assert.equal(runTool(gt7State(), "get_car").available, true);
  assert.equal(runTool(gt7State(), "get_lap").available, true);
});

test("a missing strategy model refuses with its own reason", () => {
  const s = f1State();
  s.strategy = { available: false, reason: "not enough data yet" };
  const r = runTool(s, "get_strategy");
  assert.equal(r.available, false);
  assert.equal(r.reason, "not enough data yet");
});

test("no priors at a new circuit is a refusal, not an empty history", () => {
  const r = runTool(f1State(), "get_priors");
  assert.equal(r.available, false);
  assert.equal(r.sessionsHere, undefined);
});

// ---------- provenance ----------

test("strategy numbers keep the tag that says whether they were measured", () => {
  const s = f1State();
  s.strategy = {
    available: true,
    degradation: { source: "measured", secPerLap: 0.09 },
    pitLoss: {
      sec: 19.4,
      source: "measured",
      basis: "timed on your last stop",
    },
  };
  const r = runTool(s, "get_strategy");
  assert.equal(r.degradation.source, "measured");
  assert.equal(r.pitLoss.source, "measured");
  assert.equal(r.pitLoss.basis, "timed on your last stop");
});

test("a seeded pit loss is not presentable as a measured one", () => {
  const s = f1State();
  delete s.session.measuredPitLossSec;
  s.session.pitLossSec = 20;
  const r = runTool(s, "get_session");
  assert.equal(r.pitLossSec, 20);
  assert.equal(r.pitLossIsMeasured, false);
});

// ---------- own car ----------

test("tyre condition uses the same bands as the dashboard", () => {
  const r = runTool(f1State(), "get_tyres");
  assert.equal(r.condition, "overheating");
  assert.equal(r.hottestTempC, 118);
  assert.equal(r.spreadC, 22);
  assert.equal(r.surfaceTempC.frontLeft, 118);
  assert.equal(r.wearPct.frontLeft, 72);
});

test("fuel margin is named as margin, not as a range", () => {
  const r = runTool(f1State(), "get_fuel");
  assert.equal(r.lapsOfMarginBeyondFinish, -1.5);
  assert.equal(r.short, true);
});

test("lap data carries the delta to his own reference lap", () => {
  const s = f1State();
  s.delta = { value: 640, refLapMs: 91000 };
  const r = runTool(s, "get_lap");
  assert.equal(r.deltaToReferenceSec, 0.64);
  assert.equal(r.referenceLap, "1:31.000");
  assert.equal(r.lapsRemaining, 8);
});

test("no reference lap means no corner advice rather than invented advice", () => {
  const r = runTool(f1State(), "get_corner");
  assert.equal(r.available, false);
  assert.match(r.reason, /reference lap/);
});

// ---------- validation ----------

test("arguments are checked before a handler runs", () => {
  assert.equal(validate("get_gap", { to: "ahead" }), null);
  assert.match(validate("get_gap", {}), /required/);
  assert.match(validate("get_gap", { to: "sideways" }), /must be one of/);
  assert.match(validate("get_gap", { to: "driver" }), /name is required/);
  assert.match(validate("get_rival", { name: 42 }), /must be a string/);
  assert.match(validate("not_a_tool", {}), /no tool called/);
});

test("an unknown tool name is refused, not thrown", () => {
  const r = runTool(f1State(), "drop_database", {});
  assert.equal(r.available, false);
  assert.match(r.reason, /no tool called/);
});

test("stray arguments are dropped rather than failing the question", () => {
  const r = runTool(f1State(), "get_gap", { to: "ahead", limit: 999 });
  assert.equal(r.available, true);
});

test("no tool throws on an empty state", () => {
  for (const name of toolNames()) {
    const r = runTool({}, name, { to: "ahead", name: "X" });
    assert.equal(typeof r, "object", `${name} returned nothing`);
    assert.equal(r.available, false, `${name} claimed data it does not have`);
    assert.ok(r.reason, `${name} refused without saying why`);
  }
});

// ---------- schema hygiene ----------

test("every tool is declared, described and runnable", () => {
  assert.equal(TOOL_DEFS.length, toolNames().length);
  for (const def of TOOL_DEFS) {
    assert.ok(
      def.description.length > 40,
      `${def.name} needs a fuller description`,
    );
    assert.equal(def.input_schema.type, "object");
    assert.ok(Array.isArray(def.input_schema.required));
    // Anything required has to be described, or the model is guessing at it.
    for (const key of def.input_schema.required) {
      assert.ok(
        def.input_schema.properties[key],
        `${def.name}.${key} undeclared`,
      );
    }
  }
});
