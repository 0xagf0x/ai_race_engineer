// Callout rules and phrase bank tests. Run with `npm test`.
//
// The test that matters most here is bank coverage. A rule added without a
// phrasing does not throw and does not look wrong: phrase() returns null, the
// call quietly falls back to engineer.callout(), and the only symptom is a
// model round trip per fire that nobody notices until the bill arrives. So
// every id the rules can emit is driven here and asserted to resolve.
//
// The rest cover the gates. Every one of these rules exists because it once
// misfired, and a threshold is easy to break without noticing: the engineer
// still says something plausible, just at the wrong moment or twice.

import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  freshMemory,
  pick,
  words,
  secWords,
  kilos,
  Callouts,
  LEVELS,
  INSTANT,
} from "../src/callouts.js";
import { phrase, makePhraseMemory } from "../src/phrases.js";

// ---------- fixtures ----------

function baseState(over = {}) {
  return {
    session: { mode: "race", safetyCar: "none", ...(over.session ?? {}) },
    player: {
      speed: 250,
      lap: { currentLapNum: 10, position: 5, penalties: 0, warnings: 0 },
      status: {},
      ...(over.player ?? {}),
    },
    opponents: over.opponents ?? [],
    ...over,
  };
}

/** Player plus a car ahead and a car behind, with gaps in ms. */
function withField(aheadMs, behindMs) {
  return [
    { name: "LECLERC", position: 4, isPlayer: false, deltaAheadMs: 0 },
    { name: "YOU", position: 5, isPlayer: true, deltaAheadMs: aheadMs },
    { name: "NORRIS", position: 6, isPlayer: false, deltaAheadMs: behindMs },
  ];
}

const strategyBlock = (over = {}) => ({
  available: true,
  tyreAgeLaps: 18,
  degradation: { source: "measured", secPerLap: 0.09, explanation: "from x" },
  pitLoss: { sec: 19.4, basis: "timed on your last stop" },
  ...over,
});

/** Run evaluate and index the result by id. */
function byId(state, mem = freshMemory()) {
  const out = {};
  for (const c of evaluate(state, mem)) out[c.id] = c;
  return out;
}

// ---------- bank coverage ----------

// Each scenario drives one region of the rules. Collected together they should
// emit every id the engine is capable of producing.
const SCENARIOS = {
  "personal best": () => {
    const mem = freshMemory();
    mem.lastLapSeen = 9;
    mem.bestLapMs = 92000;
    const s = baseState();
    s.player.lap = { ...s.player.lap, lastLapMs: 91000, idealLapMs: 90000 };
    return [s, mem];
  },
  "slower lap": () => {
    const mem = freshMemory();
    mem.lastLapSeen = 9;
    mem.bestLapMs = 90000;
    const s = baseState();
    s.player.lap = { ...s.player.lap, lastLapMs: 91500, idealLapMs: 89000 };
    return [s, mem];
  },
  "place gained": () => {
    const mem = freshMemory();
    mem.lastPosition = 6;
    return [baseState(), mem];
  },
  "place lost": () => {
    const mem = freshMemory();
    mem.lastPosition = 4;
    return [baseState(), mem];
  },
  coaching: () => {
    const s = baseState();
    s.coachFeedback = { ts: 1, onReference: false, text: "braked late there" };
    s.coach = { brakeInM: 150, gear: 3, minSpeedKph: 95 };
    return [s, freshMemory()];
  },
  "fuel shortfall": () => {
    const s = baseState();
    s.player.status = { fuelDeltaLaps: -1.5 };
    return [s, freshMemory()];
  },
  "fuel tight": () => {
    const s = baseState();
    s.player.status = { fuelDeltaLaps: 0.3 };
    return [s, freshMemory()];
  },
  "fuel margin": () => {
    const s = baseState();
    s.player.status = { fuelDeltaLaps: 1.0 };
    return [s, freshMemory()];
  },
  "fuel by tank percentage": () => {
    const s = baseState();
    s.player.status = { fuelInTank: 15, fuelCapacity: 100 };
    return [s, freshMemory()];
  },
  "fuel critical": () => {
    const s = baseState();
    s.player.status = { fuelInTank: 5, fuelCapacity: 100 };
    return [s, freshMemory()];
  },
  "tyres overheating and unbalanced": () => {
    const s = baseState();
    s.player.tyreSurfaceTemps = [125, 95, 98, 96];
    s.player.damage = { tyreWear: [72, 40, 51, 44] };
    s.player.status = { tyreAgeLaps: 18, tyre: "soft" };
    return [s, freshMemory()];
  },
  "tyres warm": () => {
    const s = baseState();
    s.player.tyreSurfaceTemps = [110, 108, 106, 107];
    return [s, freshMemory()];
  },
  "tyres cold": () => {
    const s = baseState();
    s.player.tyreSurfaceTemps = [60, 58, 62, 59];
    return [s, freshMemory()];
  },
  "tyres in the window": () => {
    const s = baseState();
    s.player.tyreSurfaceTemps = [95, 93, 96, 94];
    return [s, freshMemory()];
  },
  "battle, DRS range": () => {
    const s = baseState();
    s.opponents = withField(800, 5000);
    return [s, freshMemory()];
  },
  "battle, closing and under pressure": () => {
    const s = baseState();
    s.opponents = withField(2000, 900);
    s.opponents[0].pit = "PIT";
    return [s, freshMemory()];
  },
  "car condition": () => {
    const s = baseState();
    s.player.damage = { frontWing: 30, rearWing: 15, floor: 12 };
    s.player.engineTemp = 130;
    s.player.status = { ersStorePct: 4 };
    return [s, freshMemory()];
  },
  officials: () => {
    const s = baseState({
      session: {
        safetyCar: "virtual",
        forecast: [{ rainPercent: 60, inMin: 15, weather: "Light rain" }],
      },
    });
    s.player.lap = { ...s.player.lap, penalties: 5, warnings: 3 };
    return [s, freshMemory()];
  },
  "strategy, full": () => {
    const s = baseState();
    s.player.status = { tyreAgeLaps: 18 };
    s.strategy = strategyBlock({
      undercutOnCarAhead: {
        advise: true,
        rival: "LECLERC",
        theirTyreAge: 24,
        yourTyreAge: 18,
        gainPerLapSec: 0.6,
        netAfterTwoLapsSec: 4.2,
        pitLossSec: 19.4,
        pitLossSource: "measured",
      },
      threatFromCarBehind: {
        advise: true,
        rival: "NORRIS",
        theirTyreAge: 20,
        netAfterTwoLapsSec: 3.0,
      },
      fuel: { saveKgPerLap: 0.35, shortfallLaps: 1.5, lapsRemaining: 10 },
    });
    return [s, freshMemory()];
  },
  "strategy, no measured pit loss": () => {
    const s = baseState();
    s.player.status = { tyreAgeLaps: 18 };
    s.strategy = strategyBlock({ pitLoss: null });
    return [s, freshMemory()];
  },
};

test("every id the rules can emit resolves to a spoken line", () => {
  const mem = makePhraseMemory();
  const missing = [];
  const seen = new Set();

  for (const [name, build] of Object.entries(SCENARIOS)) {
    const [state, ruleMem] = build();
    for (const c of evaluate(state, ruleMem)) {
      const key = c.phrase ?? c.id;
      seen.add(key);
      // A fixed line is a deliberate choice, not a gap in the bank.
      if (INSTANT[c.id]) continue;
      if (!phrase(key, c.data, mem)) missing.push(`${key} (from "${name}")`);
    }
  }

  assert.equal(
    missing.length,
    0,
    `these callouts fall back to the model:\n  ${missing.join("\n  ")}`,
  );
  // Guards the scenarios themselves: if a rewrite stops most rules firing, the
  // coverage assertion above passes vacuously.
  assert.ok(seen.size >= 20, `only ${seen.size} ids exercised`);
});

test("a rule with no phrasing falls back rather than speaking nonsense", () => {
  assert.equal(phrase("no_such_callout", {}, makePhraseMemory()), null);
});

test("a template missing a field falls back instead of saying undefined", () => {
  // undercut needs six fields; one name is not enough to build the arithmetic.
  assert.equal(
    phrase("undercut", { rival: "LECLERC" }, makePhraseMemory()),
    null,
  );
});

// ---------- phrasing ----------

test("consecutive calls on the same id do not repeat wording", () => {
  const mem = makePhraseMemory();
  const d = { rival: "NORRIS", gap: "four tenths" };
  let prev = null;
  for (let i = 0; i < 12; i++) {
    const line = phrase("under_pressure", d, mem);
    assert.ok(line);
    assert.notEqual(line, prev, "the same line twice in a row");
    prev = line;
  }
});

test("every phrasing of an id is reachable", () => {
  const mem = makePhraseMemory();
  const lines = new Set();
  for (let i = 0; i < 200; i++) {
    lines.add(phrase("position_up", { pos: 4 }, mem));
  }
  assert.ok(lines.size >= 4, `only ${lines.size} distinct lines`);
});

test("a line never opens on a lowercase spelled-out number", () => {
  const mem = makePhraseMemory();
  for (let i = 0; i < 60; i++) {
    const line = phrase(
      "lap_pace",
      {
        lap: "eleven",
        time: "1:31.600",
        delta: "six tenths",
        best: "1:31.000",
      },
      mem,
    );
    assert.match(line, /^[A-Z0-9]/, `line started lowercase: ${line}`);
  }
});

// ---------- numbers ----------

test("numbers are spelled out the way they are said", () => {
  assert.equal(words(7), "seven");
  assert.equal(words(28), "twenty eight");
  assert.equal(words(118), "one hundred and eighteen");
  assert.equal(secWords(0.4), "four tenths");
  assert.equal(secWords(0.1), "one tenth");
  assert.equal(secWords(0.02), "level");
  assert.equal(secWords(1.2), "one point two");
  assert.equal(secWords(19), "nineteen");
});

test("fuel under a kilo is spoken in grams", () => {
  // secWords would round 0.35 to "four tenths", and "four tenths of a kilo a
  // lap" is not something anyone says on a pit wall.
  assert.equal(kilos(0.35), "three hundred and fifty grams");
  assert.equal(kilos(1.2), "one point two kilos");
});

// ---------- gates ----------

test("a gap that holds steady is not re-announced", () => {
  const mem = freshMemory();
  const state = baseState();
  state.opponents = withField(900, 5000);

  assert.ok(byId(state, mem).gap_ahead, "first sighting should fire");
  assert.equal(
    byId(state, mem).gap_ahead,
    undefined,
    "unchanged gap is silent",
  );

  // Three tenths of movement is worth another sentence.
  state.opponents = withField(1300, 5000);
  assert.ok(byId(state, mem).gap_ahead, "a moved gap should fire");
});

test("crossing into DRS range is worth saying even on a small change", () => {
  const mem = freshMemory();
  const state = baseState();
  state.opponents = withField(1100, 5000);
  assert.ok(byId(state, mem).gap_ahead);

  // Only two tenths, but it crosses the line that changes what he can do.
  state.opponents = withField(900, 5000);
  const c = byId(state, mem).gap_ahead;
  assert.ok(c, "the DRS crossing should fire");
  assert.equal(c.phrase, "gap_ahead_drs");
});

test("a tyre parked in one band produces one call, not one per cooldown", () => {
  const mem = freshMemory();
  const state = baseState();
  state.player.tyreSurfaceTemps = [120, 95, 98, 96];

  assert.ok(byId(state, mem).tyre_temp, "the crossing should fire");
  assert.equal(byId(state, mem).tyre_temp, undefined, "still hot is not news");

  state.player.tyreSurfaceTemps = [95, 93, 96, 94];
  const back = byId(state, mem).tyre_temp;
  assert.ok(back, "coming back into the window should fire");
  assert.equal(back.phrase, "tyre_temp_ok");
});

test("outstanding penalties are announced when the total moves, then rest", () => {
  const mem = freshMemory();
  const state = baseState();
  state.player.lap = { ...state.player.lap, penalties: 5 };

  assert.ok(byId(state, mem).penalty);
  assert.equal(byId(state, mem).penalty, undefined, "same total is not news");

  // Served: the next penalty has to be announced again.
  state.player.lap = { ...state.player.lap, penalties: 0 };
  byId(state, mem);
  state.player.lap = { ...state.player.lap, penalties: 5 };
  assert.ok(byId(state, mem).penalty, "a new penalty should fire again");
});

test("the two fuel_low branches speak their own numbers", () => {
  const laps = baseState();
  laps.player.status = { fuelDeltaLaps: 1.0 };
  assert.equal(byId(laps).fuel_low.phrase, "fuel_margin");

  const tank = baseState();
  tank.player.status = { fuelInTank: 15, fuelCapacity: 100 };
  assert.equal(byId(tank).fuel_low.phrase, "fuel_pct");
});

test("the stint window drops the pit loss clause when there is no measured stop", () => {
  const state = baseState();
  state.player.status = { tyreAgeLaps: 18 };
  state.strategy = strategyBlock({ pitLoss: null });
  const c = byId(state).stint_window;
  assert.equal(c.phrase, "stint_window_nopit");
  assert.equal(c.data.pitLoss, null);
  assert.ok(
    !phrase("stint_window_nopit", c.data, makePhraseMemory()).includes("stop"),
  );
});

// ---------- selection ----------

test("level gates by priority", () => {
  const now = Date.now();
  const cands = [
    { id: "chatter", priority: 1, cooldownMs: 0, at: now },
    { id: "useful", priority: 2, cooldownMs: 0, at: now },
    { id: "urgent", priority: 4, cooldownMs: 0, at: now },
  ];
  assert.equal(pick(cands, "high", {}).id, "urgent", "highest priority wins");
  assert.equal(pick([cands[0]], "medium", {}), null, "chatter is below medium");
  assert.equal(pick([cands[1]], "low", {}), null, "useful is below low");
  assert.equal(pick(cands, "off", {}), null, "off says nothing");
});

test("a callout on cooldown is skipped in favour of the next one", () => {
  const now = Date.now();
  const cands = [
    { id: "a", priority: 4, cooldownMs: 60000, at: now },
    { id: "b", priority: 3, cooldownMs: 0, at: now },
  ];
  assert.equal(pick(cands, "medium", { a: now - 1000 }).id, "b");
});

// ---------- events and lifecycle ----------

function makeCallouts() {
  const spoken = [];
  const engineer = { busy: false, callout: async () => "model line" };
  const c = new Callouts(baseState(), engineer, (t) => spoken.push(t), {
    level: "medium",
  });
  return { c, spoken };
}

test("queued race events carry everything the bank needs", () => {
  const { c } = makeCallouts();
  const mem = makePhraseMemory();
  const name = (i) => (i === 1 ? "VERSTAPPEN" : "someone");

  c.onEvent({ code: "FTLP", vehicleIdx: 1 }, name);
  c.onEvent({ code: "RDFL" }, name);
  c.onEvent({ code: "PENA" }, name, () => ({
    serious: false,
    text: "track limits warning",
  }));

  assert.equal(c.pendingEvents.length, 3);
  for (const e of c.pendingEvents) {
    const line = phrase(e.phrase ?? e.id, e.data, mem);
    assert.ok(line, `${e.phrase ?? e.id} did not resolve`);
  }

  // The suffix is load bearing: without it a warning gets heard as a stop-go.
  const pena = c.pendingEvents.find((e) => e.id === "penalty_event");
  assert.match(pena.data.text, /no action needed/);
});

test("the queue is bounded and stamped", () => {
  const { c } = makeCallouts();
  for (let i = 0; i < 30; i++)
    c.onEvent({ code: "FTLP", vehicleIdx: i }, () => "X");
  assert.ok(c.pendingEvents.length <= 12);
  assert.ok(c.pendingEvents.every((e) => e.at > 0));
});

test("a flashback clears the rolling memory and the wording history", () => {
  const { c } = makeCallouts();
  c.mem.bestLapMs = 88000;
  c.mem.lastPosition = 3;
  c.phraseMem.set("under_pressure", [0, 1]);
  c.onEvent({ code: "RDFL" }, () => "X");

  c.rewind();

  assert.equal(c.mem.bestLapMs, 0);
  assert.equal(c.mem.lastPosition, -1);
  assert.equal(c.pendingEvents.length, 0);
  assert.equal(c.phraseMem.size, 0);
});

test("the chequered flag speaks immediately rather than queueing", () => {
  const { c, spoken } = makeCallouts();
  c.onEvent({ code: "CHQF" }, () => "X");
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0], INSTANT.chequered);
  assert.equal(c.pendingEvents.length, 0);
});

test("levels are ordered: quieter levels wait longer and say less", () => {
  assert.ok(LEVELS.low.minGapMs > LEVELS.medium.minGapMs);
  assert.ok(LEVELS.medium.minGapMs > LEVELS.high.minGapMs);
  assert.ok(LEVELS.low.minPriority > LEVELS.medium.minPriority);
  assert.ok(LEVELS.medium.minPriority > LEVELS.high.minPriority);
});

test("a rival's stop is announced once, not for as long as he is in the lane", () => {
  const mem = freshMemory();
  const state = baseState();
  state.opponents = withField(5000, 5000);
  state.opponents[0].pit = "PIT";

  assert.ok(byId(state, mem).rivals_pit, "the stop should fire");
  assert.equal(
    byId(state, mem).rivals_pit,
    undefined,
    "still in the lane is not news",
  );

  // Out of the lane and back in later is a second stop.
  state.opponents[0].pit = "";
  byId(state, mem);
  state.opponents[0].pit = "PIT";
  assert.ok(byId(state, mem).rivals_pit, "a second stop should fire again");
});
