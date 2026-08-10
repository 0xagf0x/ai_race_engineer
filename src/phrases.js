// Radio phrasings for automatic callouts.
//
// Every candidate in callouts.js already knows exactly what it wants to say and
// has the numbers spelled out as words. Sending that through the model to have
// it reworded costs a round trip and a fraction of a cent per call, on a rule
// that fires every few seconds. This says it directly instead.
//
// The model stays as the fallback: a callout id with no entry here still goes
// through engineer.callout(), so a new rule works before anyone writes phrases
// for it.
//
// Contract with callouts.js:
//   - a candidate may carry `data`, an object of pre-formatted strings
//   - it may also carry `phrase`, a bank key, when one rule has several shapes
//     (tyre_temp says four different things). Without it the id is the key.
//   - numbers arrive already run through words(), secWords() or kilos().
//     Nothing in here formats a number, because a second formatter is a second
//     chance to disagree with the first.
//
// Writing new phrasings:
//   - one sentence, the length an engineer actually says at racing speed
//   - vary the structure, not just the adjectives. Four ways of saying the same
//     thing in the same order still reads as one line repeated.
//   - never add a number, a name or an instruction that is not in `data`
//   - never put a spelled-out number straight after a full stop. "Personal
//     best. four tenths up" is what that produces. Use a comma.

const PHRASES = {
  // ---------- pace ----------
  lap_best: [
    (d) =>
      `That's a personal best, ${d.time}${d.gain ? `, ${d.gain} up` : ""}.`,
    (d) => `${d.time}, best of the day.`,
    (d) => `Good lap. ${d.time}, quickest you've done.`,
    (d) => `Personal best that lap, ${d.time}.`,
    (d) => `${d.time}. That's the one to beat now.`,
  ],
  lap_pace: [
    (d) => `Lap ${d.lap}, ${d.time}, ${d.delta} off your best.`,
    (d) => `${d.time} that lap, ${d.delta} down on the benchmark.`,
    (d) => `${d.delta} off the best there, ${d.time}.`,
    (d) => `That's ${d.time}, ${d.delta} shy of ${d.best}.`,
  ],
  ideal_lap: [
    (d) =>
      `Your sectors add up to ${d.ideal}. It's ${d.gain} you're leaving out there.`,
    (d) =>
      `Theoretical best is ${d.ideal}, ${d.gain} under the actual. Put it together.`,
    (d) =>
      `${d.gain} available if you string the sectors together, ${d.ideal} on paper.`,
  ],

  // ---------- position ----------
  position_up: [
    (d) => `P${d.pos} now. Nice work.`,
    (d) => `That's P${d.pos}.`,
    (d) => `Up to P${d.pos}.`,
    (d) => `P${d.pos}. Keep it coming.`,
  ],
  position_down: [
    (d) => `We're P${d.pos} now.`,
    (d) => `Dropped to P${d.pos}.`,
    (d) => `P${d.pos}. Long way to go.`,
    (d) => `That's us P${d.pos}. Settle in.`,
  ],

  // ---------- coaching ----------
  // The corner grade arrives from coach.js as a finished sentence measured
  // against the driver's own reference lap. Relayed rather than rephrased:
  // there is nothing to add, and rewording a measurement risks changing it.
  corner: [(d) => d.text],
  next_corner: [
    (d) =>
      `Brake in ${d.inM} ${d.distUnit}, gear ${d.gear}, ${d.minSpeed} ${d.spdUnit} minimum.`,
    (d) =>
      `${d.inM} ${d.distUnit} to the brake point, reference is gear ${d.gear}.`,
    (d) =>
      `Braking in ${d.inM}, gear ${d.gear} and ${d.minSpeed} ${d.spdUnit} through there.`,
  ],

  // ---------- gaps ----------
  gap_ahead_drs: [
    (d) => `${d.rival} is ${d.gap} up the road. That's DRS.`,
    (d) => `You're inside DRS on ${d.rival}, ${d.gap}.`,
    (d) => `${d.gap} to ${d.rival}. Wing's open.`,
    (d) => `DRS range on ${d.rival}, ${d.gap}.`,
  ],
  gap_ahead_closing: [
    (d) => `Closing on ${d.rival}, ${d.gap} ahead.`,
    (d) => `${d.rival} is ${d.gap} up the road.`,
    (d) => `Gap to ${d.rival} ${d.gap}, and coming down.`,
    (d) => `You're taking time out of ${d.rival}, ${d.gap} now.`,
  ],
  under_pressure: [
    (d) => `${d.rival} is ${d.gap} behind and in range.`,
    (d) => `${d.gap} back to ${d.rival}. He'll have a look.`,
    (d) => `Watch your mirrors, ${d.rival} within ${d.gap}.`,
    (d) => `${d.rival} is close now, ${d.gap}.`,
  ],
  rivals_pit: [
    (d) => `${d.names} in the pits.`,
    (d) => `${d.names} boxing this lap.`,
    (d) => `Stop for ${d.names}.`,
  ],
  overtaken: [
    (d) => `${d.rival} has gone past.`,
    (d) => `That's ${d.rival} through.`,
    (d) => `Lost that one to ${d.rival}. Stay with him.`,
  ],
  fastest_lap: [
    (d) => `Fastest lap of the session, ${d.rival}.`,
    (d) => `${d.rival} has just gone quickest.`,
    (d) => `Purple for ${d.rival}.`,
  ],

  // ---------- tyres ----------
  tyre_temp_hot: [
    (d) => `${d.where} at ${d.temp} degrees. That's overheating.`,
    (d) => `You're cooking the ${d.where}, ${d.temp} degrees.`,
    (d) => `${d.temp} on the ${d.where}. Too hot.`,
  ],
  tyre_temp_warm: [
    (d) => `${d.where} running warm, ${d.temp} degrees.`,
    (d) => `${d.temp} on the ${d.where}. Keep an eye on it.`,
    (d) => `Warm on the ${d.where}, ${d.temp}.`,
  ],
  tyre_temp_cold: [
    (d) => `Tyres are still cold, ${d.temp} average.`,
    (d) => `No temperature in them yet, ${d.temp}.`,
    (d) => `${d.temp} average. Work them up.`,
  ],
  tyre_temp_ok: [
    (d) => `Tyres are in the window now, ${d.temp} average.`,
    (d) => `That's them up to temperature, ${d.temp}.`,
    (d) => `${d.temp} average. They're where we want them.`,
  ],
  tyre_balance: [
    (d) =>
      `The ${d.where} is ${d.spread} degrees hotter than the coldest corner.`,
    (d) =>
      `${d.spread} degrees of spread across the set, ${d.where} the hottest.`,
    (d) =>
      `You've got ${d.spread} degrees between hottest and coldest, it's the ${d.where}.`,
  ],
  tyre_wear: [
    (d) =>
      `Wear is up to ${d.pct} percent on the ${d.where}, ${d.laps} laps on the ${d.compound}.`,
    (d) =>
      `${d.laps} laps on that set and the ${d.where} is ${d.pct} percent worn.`,
    (d) => `${d.where} at ${d.pct} percent after ${d.laps} laps.`,
  ],

  // ---------- fuel ----------
  fuel_short: [
    (d) => `Fuel is ${d.laps} laps short of the finish. Start saving now.`,
    (d) => `We're ${d.laps} laps down on fuel. Needs saving from here.`,
    (d) => `${d.laps} laps short on fuel. Lift and coast.`,
  ],
  fuel_tight: [
    (d) => `Fuel margin down to ${d.laps} of a lap. No room left.`,
    (d) => `${d.laps} of a lap in hand, that's all of it.`,
    (d) => `Fuel's tight, ${d.laps} of a lap spare.`,
  ],
  fuel_margin: [
    (d) => `Fuel margin ${d.laps} laps. Worth a lift and coast.`,
    (d) => `${d.laps} laps of fuel in hand. Save where it's cheap.`,
    (d) => `We've got ${d.laps} laps spare on fuel.`,
  ],
  fuel_pct: [
    (d) => `Fuel at ${d.pct} percent.`,
    (d) => `${d.pct} percent left in the tank.`,
    (d) => `Tank's down to ${d.pct} percent.`,
  ],

  // ---------- car ----------
  damage: [
    (d) => `We've got damage, ${d.parts}.`,
    (d) => `Damage report, ${d.parts}.`,
    (d) => `${d.parts}. We'll live with it for now.`,
  ],
  ers_low: [
    (d) => `Energy store down to ${d.pct} percent.`,
    (d) => `${d.pct} percent left in the battery.`,
    (d) => `Running low on energy, ${d.pct} percent.`,
  ],
  engine_hot: [
    (d) => `Engine temperature ${d.temp} degrees.`,
    (d) => `${d.temp} on the engine. Bit warm.`,
    (d) => `Engine's up at ${d.temp}.`,
  ],

  // ---------- officials ----------
  // penalty_event carries a description built by f1/penalties.js, including the
  // "no action needed" suffix on a warning. Relayed exactly: the suffix is what
  // stops a warning being heard as a stop-go.
  penalty_event: [(d) => d.text],
  penalty: [
    (d) => `${d.sec} seconds of penalties outstanding.`,
    (d) => `You're carrying ${d.sec} seconds.`,
    (d) => `${d.sec} seconds to serve.`,
  ],
  warnings: [
    (d) => `${d.count} track limits warnings. One more is a penalty.`,
    (d) => `That's ${d.count} warnings. Next one costs us.`,
    (d) => `${d.count} for track limits. Keep it inside the white line.`,
  ],
  red_flag: [
    () => `Red flag. Session stopped.`,
    () => `Red flag, red flag. Slow down.`,
  ],
  weather: [
    (d) => `${d.chance} percent chance of rain in ${d.mins} minutes.`,
    (d) => `Rain risk ${d.chance} percent, ${d.mins} minutes out.`,
    (d) => `Watch the sky, ${d.chance} percent in ${d.mins} minutes.`,
  ],

  // ---------- strategy ----------
  // These quote arithmetic the strategy engine computed. The numbers are the
  // point of the call, so every phrasing carries all of them.
  stint_window: [
    (d) =>
      `This set is costing about ${d.cost} a lap after ${d.laps} laps. A stop here is ${d.pitLoss}.`,
    (d) =>
      `${d.laps} laps on it and you're giving away ${d.cost} a lap against fresh rubber. Pit loss ${d.pitLoss}.`,
    (d) =>
      `Tyres are ${d.cost} off fresh now, ${d.laps} laps in. A stop costs ${d.pitLoss}.`,
  ],
  stint_window_nopit: [
    (d) => `This set is costing about ${d.cost} a lap after ${d.laps} laps.`,
    (d) =>
      `${d.laps} laps in and you're losing ${d.cost} a lap to fresh tyres.`,
    (d) => `Tyres are ${d.cost} off fresh rubber, ${d.laps} laps on them.`,
  ],
  undercut: [
    (d) =>
      `Undercut is on ${d.rival}. He's ${d.theirAge} laps on his set against your ${d.yourAge}, worth ${d.perLap} a lap. Boxing now nets ${d.net}.`,
    (d) =>
      `${d.rival} is ${d.theirAge} laps into his set, you're ${d.yourAge}. Fresh tyres are ${d.perLap} a lap on him, so a stop now is worth ${d.net}.`,
    (d) =>
      `We can undercut ${d.rival}, ${d.perLap} a lap advantage on new rubber. That's ${d.net} if he stays out two more. Pit loss ${d.pitLoss}.`,
  ],
  undercut_threat: [
    (d) =>
      `${d.rival} behind is ${d.theirAge} laps on his set. He can undercut us, worth ${d.net}.`,
    (d) =>
      `Careful of ${d.rival}. His tyres are ${d.theirAge} laps old and a stop puts him ${d.net} up on us.`,
    (d) =>
      `${d.rival} has the undercut on us, ${d.net} if he boxes and we don't.`,
  ],
  fuel_target: [
    (d) =>
      `${d.short} laps short with ${d.left} to go. You need ${d.save} a lap saved.`,
    (d) =>
      `Fuel's ${d.short} laps down over the remaining ${d.left}. Save ${d.save} a lap.`,
    (d) => `We're ${d.short} short, ${d.save} a lap for the next ${d.left}.`,
  ],
};

/** Per-key ring of recently used variant indexes. */
export function makePhraseMemory() {
  return new Map();
}

/**
 * Turn a callout into a spoken line, or null if there is nothing in the bank
 * for it and the caller should fall back to the model.
 *
 * @param {string} key bank key, usually the callout id
 * @param {object} data pre-formatted fields, see the contract above
 * @param {Map<string, number[]>} [memory] from makePhraseMemory()
 * @returns {string|null}
 */
export function phrase(key, data, memory) {
  const bank = PHRASES[key];
  if (!bank?.length) return null;

  // Avoid anything used recently, but never so aggressively that a two-variant
  // key runs out of options and returns nothing.
  const recent = memory?.get(key) ?? [];
  const all = bank.map((_, i) => i);
  const pool = all.filter((i) => !recent.includes(i));
  const choices = pool.length ? pool : all;
  const idx = choices[Math.floor(Math.random() * choices.length)];

  let line;
  try {
    line = bank[idx](data ?? {});
  } catch {
    // A template reaching for a field the rule did not pass is a bug, but the
    // radio is not the place to surface it. Fall through to the model.
    return null;
  }
  if (typeof line !== "string") return null;
  line = line.trim();
  if (!line) return null;

  // An undefined slot renders as the literal string, which is worse than
  // silence: the driver hears "gap to undefined". Refuse it.
  if (line.includes("undefined") || line.includes("null")) return null;

  if (memory) {
    const keep = Math.max(1, Math.floor(bank.length / 2));
    memory.set(key, [...recent, idx].slice(-keep));
  }

  // Templates that open on a data slot start lowercase, because the numbers
  // arrive spelled out. Fixed here rather than in thirty templates.
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Exposed for tests: which keys the bank covers. */
export const phraseKeys = () => Object.keys(PHRASES);
