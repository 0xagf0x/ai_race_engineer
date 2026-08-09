// Penalty and infringement tables.
//
// The PENA event carries penaltyType and infringementType and we were throwing
// both away, which is why the engineer could never answer "why did I get a
// penalty". These turn the two numbers into something a person would say.
//
// Phrasing here is deliberately plain and non-judgemental. The engineer decides
// how to deliver it; this file only decides what happened.

export const PENALTY_TYPES = {
  0: "a drive through",
  1: "a stop go",
  2: "a grid penalty",
  3: "a penalty reminder",
  4: "a time penalty",
  5: "a warning",
  6: "a disqualification",
  7: "removal from the formation lap",
  8: "a parked too long timer",
  9: "a tyre regulation penalty",
  10: "this lap invalidated",
  11: "this and the next lap invalidated",
  12: "this lap invalidated",
  13: "this and the next lap invalidated",
  14: "this and the previous lap invalidated",
  15: "this and the previous lap invalidated",
  16: "a retirement",
  17: "a black flag timer",
};

export const INFRINGEMENTS = {
  0: "blocking by driving slowly",
  1: "blocking by driving the wrong way",
  2: "reversing off the start line",
  3: "a big collision",
  4: "a small collision",
  5: "not handing back a position after a collision",
  6: "not handing back positions after a collision",
  7: "cutting the corner and gaining time",
  8: "cutting the corner to overtake",
  9: "cutting the corner to overtake more than one car",
  10: "crossing the pit exit line",
  11: "ignoring blue flags",
  12: "ignoring yellow flags",
  13: "ignoring a drive through",
  14: "too many drive throughs",
  15: "an unserved drive through",
  16: "an unserved drive through",
  17: "speeding in the pit lane",
  18: "being parked too long",
  19: "ignoring the tyre regulations",
  20: "too many penalties",
  21: "repeated warnings",
  22: "approaching disqualification",
  23: "the tyre regulations",
  24: "the tyre regulations",
  25: "cutting the corner",
  26: "running wide",
  27: "running wide and gaining a little time",
  28: "running wide and gaining significant time",
  29: "running wide and gaining a lot of time",
  30: "riding the wall",
  31: "using a flashback",
  32: "resetting to track",
  33: "blocking the pit lane",
  34: "a jump start",
  35: "contact behind the safety car",
  36: "an illegal overtake behind the safety car",
  37: "exceeding the pace behind the safety car",
  38: "exceeding the pace under virtual safety car",
  39: "going too slowly on the formation lap",
  40: "parking on the formation lap",
  41: "a mechanical failure",
  42: "terminal damage",
  43: "dropping too far back behind the safety car",
  44: "a black flag timer",
  45: "an unserved stop go",
  46: "an unserved drive through",
  47: "an engine component change",
  48: "a gearbox change",
  49: "a parc ferme change",
  50: "a league grid penalty",
  51: "a retry penalty",
  52: "gaining time illegally",
  53: "the mandatory pit stop",
};

// Infringements that are the driver's own doing versus things that just happen
// to you. The engineer softens delivery on the second kind rather than reading
// out a charge sheet at someone who has just been punted.
const NOT_YOUR_FAULT = new Set([41, 42, 47, 48, 49, 50]);
const CONTACT = new Set([3, 4, 5, 6, 35]);
// Penalties that require the driver to do something, as opposed to being told
// something. A warning and a lap invalidation are worth one calm mention; a
// drive through changes the race. The engineer previously treated every PENA
// alike, which is how a warning for light contact became "five second penalty,
// box to serve it".
const ACTIONABLE = new Set([0, 1, 4, 6, 9, 16, 17]);

/**
 * Turn a PENA event into a sentence fragment plus enough metadata for the
 * engineer to pick a tone.
 * @param {{penaltyType:number, infringementType:number, time:number, lapNum:number}} ev
 */
export function describePenalty(ev) {
  const penalty = PENALTY_TYPES[ev.penaltyType] ?? "a penalty";
  const reason = INFRINGEMENTS[ev.infringementType];
  const seconds = ev.time && ev.time < 100 ? ev.time : null;

  let text =
    seconds && ev.penaltyType === 4 ? `a ${seconds} second penalty` : penalty;
  if (reason) text += ` for ${reason}`;

  return {
    text,
    penaltyType: ev.penaltyType,
    infringementType: ev.infringementType,
    seconds,
    lapNum: ev.lapNum,
    lapInvalidation: ev.penaltyType >= 10 && ev.penaltyType <= 15,
    serious: ACTIONABLE.has(ev.penaltyType),
    contact: CONTACT.has(ev.infringementType),
    blameless: NOT_YOUR_FAULT.has(ev.infringementType),
    known: reason != null,
  };
}
