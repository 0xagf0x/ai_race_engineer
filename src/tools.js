// The engineer's tool surface.
//
// The model does not get the telemetry. It gets these.
//
// Everything the engineer can say a number about is computed here, in ordinary
// deterministic code, and handed over as a finished result. The model chooses
// which question to ask and how to say the answer out loud. It never sees a
// state object to interpret, which is the whole point: a model that reads a
// lap time out of a JSON blob and a model that invents one sound exactly the
// same at 250 km/h, and the driver has no way to tell them apart.
//
// Rules every tool in here follows:
//
//   - Never throw. A tool that throws mid-race is a radio that goes dead.
//     Failures come back as { available: false, reason } and the reason is
//     written to be said aloud.
//   - Never guess. If the data is not there, say which data and why, rather
//     than returning a plausible zero. GT7 sends no opponents at all, so every
//     rival tool refuses in GT7 with a reason the engineer can quote.
//   - Keep provenance. The strategy engine already tags its numbers measured,
//     game or seeded. That tag travels with the number to the model, because
//     "I timed it on your last stop" and "the circuit estimate" are different
//     claims and the driver deserves to know which he is getting.
//   - Round to what is sayable. Nobody says "one point four three seven".
//
// Args are validated before a handler runs. The model is a caller like any
// other and does not get to reach past the schema.

const round = (v, dp = 1) =>
  v == null || !Number.isFinite(v) ? null : +v.toFixed(dp);
const sec = (ms) => (ms > 0 ? round(ms / 1000, 1) : null);

function fmtLap(ms) {
  if (!ms || ms <= 0) return null;
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

const unavailable = (reason) => ({ available: false, reason });

/** Opponent data exists in F1 only, and only when telemetry is set to public. */
function needField(state) {
  if (state.game === "gt7") {
    return unavailable(
      "GT7 does not broadcast any opponent data, so there are no gaps or rival times in this game",
    );
  }
  if (!state.opponents?.length) {
    return unavailable(
      "no timing tower yet, which usually means Your Telemetry is set to Restricted in the game",
    );
  }
  return null;
}

const me = (state) => state.opponents?.find((o) => o.isPlayer) ?? null;
const at = (state, pos) =>
  state.opponents?.find((o) => o.position === pos) ?? null;

/**
 * Find a driver by name. Exact match first, then a unique prefix, so "LEC"
 * resolves but an ambiguous fragment does not silently pick the first row.
 */
function findDriver(state, name) {
  const q = String(name ?? "")
    .trim()
    .toUpperCase();
  if (!q) return null;
  const rows = state.opponents ?? [];
  // Matched on both names: the driver may ask by the gamertag he can see on
  // the tower, or by the race number the engineer has been saying to him.
  const namesOf = (o) =>
    [o.name, o.spokenName].filter(Boolean).map((n) => n.toUpperCase());
  const exact = rows.find((o) => namesOf(o).includes(q));
  if (exact) return exact;
  const partial = rows.filter((o) => namesOf(o).some((n) => n.startsWith(q)));
  return partial.length === 1 ? partial[0] : null;
}

/** One rival as the engineer would read them off the timing screen. */
function driverRow(state, o) {
  const p = me(state);
  return {
    // The resolved name, because everything here is going to be said aloud.
    name: o.spokenName ?? o.name,
    position: o.position,
    team: o.team || null,
    lastLap: fmtLap(o.lastLapMs),
    bestLap: fmtLap(o.bestLapMs),
    tyre: o.tyre !== "?" ? o.tyre : null,
    tyreAgeLaps: o.tyreAge,
    pitStops: o.pitStops,
    inPitLane: o.pit ? o.pit : null,
    penaltiesSec: o.penalties || null,
    // Positive means he is up the road, negative means he is behind.
    gapToYouSec: p ? gapBetween(state, p, o) : null,
    status: o.status || null,
  };
}

/**
 * Gap between two cars, summed along the delta-to-car-ahead chain.
 *
 * The F1 feed sends each car's gap to the car directly in front of it, not a
 * gap to the player. Summing the chain is the only way to answer "how far to
 * P3" once there is a car between you, and reading deltaAheadMs directly, as
 * the old snapshot invited, answers a different question entirely.
 */
function gapBetween(state, from, to) {
  if (!from || !to || from.position === to.position) return 0;
  const [lo, hi] =
    from.position < to.position
      ? [from.position, to.position]
      : [to.position, from.position];
  let total = 0;
  for (let pos = lo + 1; pos <= hi; pos++) {
    const car = at(state, pos);
    if (!car || !Number.isFinite(car.deltaAheadMs)) return null;
    total += car.deltaAheadMs;
  }
  // A car ahead of the player is a positive gap.
  const sign = to.position < from.position ? 1 : -1;
  return round((sign * total) / 1000, 1);
}

// ---------- handlers ----------

const HANDLERS = {
  get_gap(state, { to, name }) {
    const blocked = needField(state);
    if (blocked) return blocked;
    const p = me(state);
    if (!p) return unavailable("you are not on the timing tower yet");

    let target = null;
    if (to === "ahead") target = at(state, p.position - 1);
    else if (to === "behind") target = at(state, p.position + 1);
    else if (to === "leader") target = at(state, 1);
    else if (to === "driver") {
      target = findDriver(state, name);
      if (!target) {
        return unavailable(
          `no driver matching "${name}" on the timing tower right now`,
        );
      }
    }

    if (!target) {
      return unavailable(
        to === "ahead"
          ? "you are leading, there is no car ahead"
          : "there is no car behind you",
      );
    }
    if (target.isPlayer) return unavailable("that is you");

    const gapSec = gapBetween(state, p, target);
    return {
      available: true,
      rival: target.spokenName ?? target.name,
      theirPosition: target.position,
      yourPosition: p.position,
      gapSec,
      // Answered here rather than left to the model to work out from a number.
      theyAreAhead: target.position < p.position,
      // Deliberately two fields. One second covers both cars, but DRS only
      // helps the one behind, and a single "withinDrs" on a rival who is
      // chasing reads as the driver having it.
      withinOneSecond: gapSec != null && Math.abs(gapSec) < 1,
      youHaveDrsOnThem:
        gapSec != null && target.position < p.position && gapSec < 1,
      theyHaveDrsOnYou:
        gapSec != null && target.position > p.position && Math.abs(gapSec) < 1,
      theirTyre: target.tyre !== "?" ? target.tyre : null,
      theirTyreAgeLaps: target.tyreAge,
      theyArePitting: !!target.pit,
    };
  },

  get_rival(state, { name }) {
    const blocked = needField(state);
    if (blocked) return blocked;
    const o = findDriver(state, name);
    if (!o) {
      return unavailable(
        `no driver matching "${name}" on the timing tower right now`,
      );
    }
    return { available: true, ...driverRow(state, o) };
  },

  get_standings(state, { window }) {
    const blocked = needField(state);
    if (blocked) return blocked;
    const p = me(state);
    const rows = state.opponents;

    let selected = rows;
    if (window === "around_you" && p) {
      selected = rows.filter((o) => Math.abs(o.position - p.position) <= 2);
    } else if (window === "podium") {
      selected = rows.filter((o) => o.position <= 3);
    }

    return {
      available: true,
      yourPosition: p?.position ?? null,
      carsRunning: rows.length,
      order: selected.map((o) => ({
        position: o.position,
        name: o.spokenName ?? o.name,
        isYou: !!o.isPlayer,
        lastLap: fmtLap(o.lastLapMs),
        tyre: o.tyre !== "?" ? o.tyre : null,
        tyreAgeLaps: o.tyreAge,
        gapToYouSec: p ? gapBetween(state, p, o) : null,
        inPitLane: o.pit || null,
      })),
    };
  },

  get_tyres(state) {
    const p = state.player ?? {};
    const st = p.status ?? {};
    const temps = p.tyreSurfaceTemps;
    const wear = p.damage?.tyreWear;
    if (!temps?.length && !wear?.length && st.tyreAgeLaps == null) {
      return unavailable("no tyre data on the screens yet");
    }
    const order = ["frontLeft", "frontRight", "rearLeft", "rearRight"];
    const byWheel = (arr) =>
      arr?.length === 4
        ? Object.fromEntries(order.map((k, i) => [k, round(arr[i], 0)]))
        : null;

    const hottest = temps?.length ? Math.max(...temps) : null;
    return {
      available: true,
      compound: st.tyre ?? null,
      compoundCode: st.tyreCompound ?? null,
      ageLaps: st.tyreAgeLaps ?? null,
      surfaceTempC: byWheel(temps),
      pressurePsi: byWheel(p.tyrePressures),
      wearPct: byWheel(wear),
      hottestTempC: round(hottest, 0),
      // The same bands the dashboard colours by, so the engineer and the panel
      // never disagree about what "warm" means.
      condition:
        hottest == null
          ? null
          : hottest <= 65
            ? "cold"
            : hottest <= 105
              ? "in the window"
              : hottest <= 115
                ? "warm"
                : "overheating",
      spreadC:
        temps?.length === 4
          ? round(Math.max(...temps) - Math.min(...temps), 0)
          : null,
    };
  },

  get_fuel(state) {
    const st = state.player?.status ?? {};
    if (st.fuelInTank == null && st.fuelDeltaLaps == null) {
      return unavailable("no fuel data on the screens yet");
    }
    const target = state.strategy?.fuel ?? null;
    return {
      available: true,
      inTankKg: round(st.fuelInTank, 1),
      // Laps of fuel beyond what finishing requires. Negative is a shortfall.
      // Named at length because reading it as a range is the mistake that had
      // a healthy plus two point eight announced as nearly dry.
      lapsOfMarginBeyondFinish: round(st.fuelDeltaLaps, 1),
      short: st.fuelDeltaLaps != null ? st.fuelDeltaLaps < 0 : null,
      saveTarget: target
        ? {
            saveKgPerLap: target.saveKgPerLap,
            shortfallLaps: target.shortfallLaps,
            lapsRemaining: target.lapsRemaining,
          }
        : null,
    };
  },

  get_strategy(state) {
    const s = state.strategy;
    if (!s) return unavailable("the strategy model has nothing yet");
    if (s.available === false) {
      return unavailable(
        s.reason ?? "not enough data to advise on strategy yet",
      );
    }
    // Passed through with its provenance intact. degradation.source and
    // pitLoss.source are the difference between a measurement and a guess, and
    // stripping them here would let the engineer present one as the other.
    return { available: true, ...s };
  },

  get_lap(state) {
    const lap = state.player?.lap ?? {};
    const s = state.session ?? {};
    if (lap.currentLapNum == null) return unavailable("no lap data yet");
    return {
      available: true,
      currentLap: lap.currentLapNum,
      totalLaps: s.totalLaps ?? null,
      lapsRemaining:
        s.totalLaps && lap.currentLapNum
          ? Math.max(0, s.totalLaps - lap.currentLapNum)
          : null,
      position: lap.position ?? null,
      lastLap: fmtLap(lap.lastLapMs),
      bestLap: fmtLap(lap.bestLapMs),
      theoreticalBest: fmtLap(lap.idealLapMs),
      currentLapInvalid: !!lap.invalid,
      inPitLane: lap.pit || null,
      penaltiesSec: lap.penalties || null,
      trackLimitsWarnings: lap.warnings ?? null,
      // Delta to his own reference lap, and where the time went on the last one.
      deltaToReferenceSec:
        state.delta?.value != null ? round(state.delta.value / 1000, 2) : null,
      referenceLap: fmtLap(state.delta?.refLapMs),
    };
  },

  get_car(state) {
    const p = state.player ?? {};
    const st = p.status ?? {};
    if (p.speed == null) return unavailable("no car telemetry yet");
    return {
      available: true,
      speedKph: p.speed,
      gear: p.gear,
      rpm: p.rpm,
      drsOpen: p.drs ?? null,
      engineTempC: p.engineTemp ?? null,
      ersStorePct: st.ersStorePct ?? null,
      damagePct: p.damage
        ? {
            frontWing: p.damage.frontWing,
            rearWing: p.damage.rearWing,
            floor: p.damage.floor,
          }
        : null,
    };
  },

  get_corner(state) {
    const c = state.coach;
    const fb = state.coachFeedback;
    if (!c && !fb) {
      return unavailable(
        "no reference lap learned yet, so there is nothing to compare his braking against",
      );
    }
    return {
      available: true,
      nextZone: c
        ? {
            cornerNumber: c.cornerIndex,
            brakeInMetres: c.brakeInM,
            referenceGear: c.gear,
            referenceEntrySpeedKph: c.entrySpeedKph,
            referenceMinSpeedKph: c.minSpeedKph,
          }
        : null,
      lastCorner: fb
        ? {
            text: fb.text,
            cornerNumber: fb.cornerIndex,
            onReference: fb.onReference,
          }
        : null,
      referenceLap: fmtLap(c?.referenceLap),
    };
  },

  get_session(state) {
    const s = state.session ?? {};
    if (!s.track) return unavailable("no session data yet");
    return {
      available: true,
      game: state.game,
      track: s.track,
      sessionType: s.type ?? null,
      mode: s.mode ?? null,
      totalLaps: s.totalLaps ?? null,
      weather: s.weather ?? null,
      trackTempC: s.trackTemp ?? null,
      airTempC: s.airTemp ?? null,
      safetyCar: s.safetyCar ?? "none",
      forecast: s.forecast ?? null,
      pitLossSec: s.measuredPitLossSec ?? s.pitLossSec ?? null,
      pitLossIsMeasured: s.measuredPitLossSec != null,
    };
  },

  get_priors(state) {
    const p = state.priors;
    if (!p?.sessionsHere) {
      return unavailable("no previous sessions recorded at this circuit");
    }
    return {
      available: true,
      sessionsHere: p.sessionsHere,
      allTimeBestLap: fmtLap(p.allTimeBestLapMs),
      lastVisit: p.lastVisit ?? null,
      recurringWeakSpots: p.recurringWeakSpots ?? [],
      runningWideOften: p.runningWideOften ?? null,
    };
  },
};

// ---------- schemas ----------
//
// Descriptions are written for the model choosing between them, so each one
// says what the tool answers and, where it matters, what it does not.

export const TOOL_DEFS = [
  {
    name: "get_gap",
    description:
      "The gap in seconds between the driver and one other car. Use for any question about how far ahead or behind someone is. Positive means that car is up the road. F1 only.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          enum: ["ahead", "behind", "leader", "driver"],
          description: "Which car. Use 'driver' with a name for anyone else.",
        },
        name: {
          type: "string",
          description: "Driver surname, required when to is 'driver'.",
        },
      },
      required: ["to"],
    },
  },
  {
    name: "get_rival",
    description:
      "Everything on the timing screen about one named rival: position, last and best lap, tyre compound and age, stops, penalties, and their gap to the driver. F1 only.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Driver surname." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_standings",
    description:
      "The running order. Use 'around_you' for the driver's immediate battle, 'podium' for the top three, 'all' for the full field. F1 only.",
    input_schema: {
      type: "object",
      properties: {
        window: {
          type: "string",
          enum: ["around_you", "podium", "all"],
          description:
            "How much of the field to return. Defaults to around_you.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_tyres",
    description:
      "The driver's own tyres: compound, age in laps, surface temperature and wear per wheel, and whether they are cold, in the window, warm or overheating.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_fuel",
    description:
      "Fuel in the tank, laps of margin beyond what finishing needs, and the per-lap saving target if there is a shortfall.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_strategy",
    description:
      "The computed strategy picture: measured tyre degradation, pit loss, undercut maths on the cars ahead and behind, and the fuel target. Every number is tagged measured, game or seeded. Use this for any question about when to stop or whether a stop is worth it, and never work out a stop from tyre age yourself.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_lap",
    description:
      "Lap number, laps remaining, position, last and best lap, theoretical best, penalties, track limits warnings, and the live delta to the driver's own reference lap.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_car",
    description:
      "Live car state: speed, gear, rpm, DRS, engine temperature, energy store, and bodywork damage.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_corner",
    description:
      "The next braking zone measured against the driver's own reference lap, and how the last corner compared to it. Use for questions about braking points, gears and corner speed.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_session",
    description:
      "Circuit, session type, race length, weather and forecast, safety car state, and the pit lane loss at this track.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_priors",
    description:
      "What happened on previous visits to this circuit: sessions here, all-time best lap, last result, and weaknesses that recur across sessions.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

const SCHEMAS = new Map(TOOL_DEFS.map((t) => [t.name, t.input_schema]));

/**
 * Check args against the schema before a handler sees them.
 * @returns {string|null} an error message, or null if the args are fine
 */
export function validate(name, input) {
  const schema = SCHEMAS.get(name);
  if (!schema) return `no tool called ${name}`;
  const args = input ?? {};
  if (typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be an object";
  }

  for (const key of schema.required ?? []) {
    if (args[key] == null || args[key] === "") return `${key} is required`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    // Unknown keys are dropped rather than rejected: a stray argument is not
    // worth failing a question over, and dropping it keeps the handler's
    // inputs to exactly what the schema describes.
    if (!prop) continue;
    if (prop.type === "string" && typeof value !== "string") {
      return `${key} must be a string`;
    }
    if (prop.enum && !prop.enum.includes(value)) {
      return `${key} must be one of ${prop.enum.join(", ")}`;
    }
  }
  // get_gap's name argument is conditional on `to`, which the schema cannot
  // express, so it is checked here.
  if (name === "get_gap" && args.to === "driver" && !args.name) {
    return "name is required when asking about a specific driver";
  }
  return null;
}

/** Strip anything the schema does not describe, so handlers see clean input. */
function clean(name, input) {
  const schema = SCHEMAS.get(name);
  const out = {};
  for (const key of Object.keys(schema.properties ?? {})) {
    if (input?.[key] != null) out[key] = input[key];
  }
  return out;
}

/**
 * Run one tool. Never throws: a tool that dies mid-race is a radio that goes
 * dead, and the model can work with a stated reason but not with an exception.
 *
 * @param {object} state the live bridge state
 * @param {string} name tool name
 * @param {object} input arguments from the model
 */
export function runTool(state, name, input) {
  const problem = validate(name, input);
  if (problem) return unavailable(problem);
  try {
    return (
      HANDLERS[name](state, clean(name, input)) ?? unavailable("no result")
    );
  } catch (e) {
    console.error(`[tools] ${name} failed:`, e.message);
    return unavailable("that reading is not coming through");
  }
}

/** Exposed for tests. */
export const toolNames = () => TOOL_DEFS.map((t) => t.name);
