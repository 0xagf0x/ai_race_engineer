// Enum tables for the F1 UDP feed.
//
// Ids that changed with the 2026 season pack are resolved through the helper
// functions at the bottom rather than by raw lookup, because the same numeric
// id means different things depending on the packet format the game is sending.
// Anything we don't recognise falls back to a readable placeholder and gets
// logged once by unknownId() so it can be filled in from `npm run inspect`.

export const TRACKS = {
  0: "Melbourne",
  1: "Paul Ricard",
  2: "Shanghai",
  3: "Bahrain",
  4: "Barcelona",
  5: "Monaco",
  6: "Montreal",
  7: "Silverstone",
  8: "Hockenheim",
  9: "Hungaroring",
  10: "Spa",
  11: "Monza",
  12: "Singapore",
  13: "Suzuka",
  14: "Abu Dhabi",
  15: "COTA",
  16: "Interlagos",
  17: "Red Bull Ring",
  18: "Sochi",
  19: "Mexico City",
  20: "Baku",
  21: "Bahrain Short",
  22: "Silverstone Short",
  23: "COTA Short",
  24: "Suzuka Short",
  25: "Hanoi",
  26: "Zandvoort",
  27: "Imola",
  28: "Portimao",
  29: "Jeddah",
  30: "Miami",
  31: "Las Vegas",
  32: "Losail",
};

// 2026 season pack additions. The id for Madring is not in any spec we've
// confirmed, so it stays here as a candidate: run `npm run inspect` on a
// Madring session, read the trackId it prints, and correct this number.
// Until then an unknown id renders as "Track <n>" and the engineer just
// won't know the circuit name, which is harmless.
export const TRACKS_2026 = {
  ...TRACKS,
  39: "Madring", // UNCONFIRMED, verify with npm run inspect
};

export const SESSION_TYPES = {
  0: "Unknown",
  1: "P1",
  2: "P2",
  3: "P3",
  4: "Short Practice",
  5: "Q1",
  6: "Q2",
  7: "Q3",
  8: "Short Quali",
  9: "One-Shot Quali",
  10: "Sprint Shootout 1",
  11: "Sprint Shootout 2",
  12: "Sprint Shootout 3",
  13: "Short Sprint Shootout",
  14: "One-Shot Sprint Shootout",
  15: "Race",
  16: "Race 2",
  17: "Race 3",
  18: "Time Trial",
};

// Sessions where the engineer should behave differently. Used by state.js to
// set session.mode, which the engineer prompt branches on.
export const SESSION_MODE = {
  practice: [1, 2, 3, 4],
  quali: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  race: [15, 16, 17],
  timetrial: [18],
};

export const WEATHER = {
  0: "Clear",
  1: "Light cloud",
  2: "Overcast",
  3: "Light rain",
  4: "Heavy rain",
  5: "Storm",
};

export const SAFETY_CAR = {
  0: "none",
  1: "full",
  2: "virtual",
  3: "formation",
};

// What the driver sees on the sidewall.
export const VISUAL_TYRES = {
  16: "Soft",
  17: "Medium",
  18: "Hard",
  7: "Inter",
  8: "Wet",
  19: "Soft",
  20: "Medium",
  21: "Hard", // F2 visual compounds
};

// The real compound underneath. This is the number that matters for
// degradation modelling: C1 is the hardest, C5 the softest.
export const ACTUAL_TYRES = {
  16: "C5",
  17: "C4",
  18: "C3",
  19: "C2",
  20: "C1",
  21: "C0",
  7: "Inter",
  8: "Wet",
  9: "Dry (classic)",
  10: "Wet (classic)",
  11: "Super Soft (F2)",
  12: "Soft (F2)",
  13: "Medium (F2)",
  14: "Hard (F2)",
  15: "Wet (F2)",
};

export const DRIVER_STATUS = {
  0: "In garage",
  1: "Flying lap",
  2: "In lap",
  3: "Out lap",
  4: "On track",
};

export const RESULT_STATUS = {
  0: "Invalid",
  1: "Inactive",
  2: "Active",
  3: "Finished",
  4: "DNF",
  5: "DSQ",
  6: "Not classified",
  7: "Retired",
};

export const PIT_STATUS = { 0: "", 1: "PIT", 2: "PIT AREA" };

export const FUEL_MIX = { 0: "Lean", 1: "Standard", 2: "Rich", 3: "Max" };

export const ERS_DEPLOY_MODE = {
  0: "None",
  1: "Medium",
  2: "Hotlap",
  3: "Overtake",
};

// Energy store capacity in joules, used to turn the raw ersStoreEnergy float
// into a percentage. The 2026 regulations move to a much larger store, so this
// is format dependent. If the reported store ever exceeds the constant we
// widen it at runtime (see state.js) rather than clamping to a wrong maximum.
export const ERS_MAX_J = { default: 4e6, 2026: 8.5e6 };

export const FLAGS = {
  "-1": "unknown",
  0: "none",
  1: "green",
  2: "blue",
  3: "yellow",
  4: "red",
};

export const TEAMS = {
  0: "Mercedes",
  1: "Ferrari",
  2: "Red Bull",
  3: "Williams",
  4: "Aston Martin",
  5: "Alpine",
  6: "RB",
  7: "Haas",
  8: "McLaren",
  9: "Sauber",
};

// The 2026 grid: Sauber becomes Audi and Cadillac is the eleventh team. The
// Cadillac id is unconfirmed for the same reason as Madring above.
export const TEAMS_2026 = {
  ...TEAMS,
  9: "Audi",
  10: "Cadillac", // UNCONFIRMED, verify with npm run inspect
};

// Seed values for strategy maths. trackLength is overwritten by the session
// packet as soon as one arrives, so it only matters before the first packet.
// pitLossSec is a starting estimate for undercut calculations; the bridge
// measures your actual pit lane time from lap data and replaces it per track
// as soon as it has seen one of your stops, so these only need to be roughly
// right on lap one of a race you have never run.
export const TRACK_META = {
  0: { length: 5278, pitLossSec: 19 },
  3: { length: 5412, pitLossSec: 22 },
  4: { length: 4675, pitLossSec: 21 },
  5: { length: 3337, pitLossSec: 19 },
  6: { length: 4361, pitLossSec: 17 },
  7: { length: 5891, pitLossSec: 21 },
  9: { length: 4381, pitLossSec: 19 },
  10: { length: 7004, pitLossSec: 18 },
  11: { length: 5793, pitLossSec: 25 },
  12: { length: 4940, pitLossSec: 26 },
  13: { length: 5807, pitLossSec: 22 },
  14: { length: 5281, pitLossSec: 21 },
  15: { length: 5513, pitLossSec: 20 },
  16: { length: 4309, pitLossSec: 21 },
  17: { length: 4318, pitLossSec: 20 },
  19: { length: 4304, pitLossSec: 21 },
  20: { length: 6003, pitLossSec: 18 },
  26: { length: 4259, pitLossSec: 20 },
  27: { length: 4909, pitLossSec: 26 },
  28: { length: 4653, pitLossSec: 20 },
  29: { length: 6174, pitLossSec: 20 },
  30: { length: 5412, pitLossSec: 20 },
  31: { length: 6201, pitLossSec: 20 },
  32: { length: 5419, pitLossSec: 22 },
};

// BUTN event bit flags
export const BUTTONS = {
  CROSS: 0x0001,
  TRIANGLE: 0x0002,
  CIRCLE: 0x0004,
  SQUARE: 0x0008,
  DPAD_LEFT: 0x0010,
  DPAD_RIGHT: 0x0020,
  DPAD_UP: 0x0040,
  DPAD_DOWN: 0x0080,
  OPTIONS: 0x0100,
  L1: 0x0200,
  R1: 0x0400,
  L2: 0x0800,
  R2: 0x1000,
  L3: 0x2000,
  R3: 0x4000,
  UDP_ACTION_1: 0x00100000,
  UDP_ACTION_2: 0x00200000,
  UDP_ACTION_3: 0x00400000,
  UDP_ACTION_4: 0x00800000,
};

// ---------- format-aware lookups ----------

const warned = new Set();
function unknownId(kind, id) {
  const k = `${kind}:${id}`;
  if (warned.has(k)) return;
  warned.add(k);
  console.warn(
    `[enums] unknown ${kind} id ${id} — add it to src/f1/enums.js (run npm run inspect to confirm)`,
  );
}

export function trackName(id, format) {
  const table = format >= 2026 ? TRACKS_2026 : TRACKS;
  const name = table[id];
  if (!name) {
    unknownId("track", id);
    return `Track ${id}`;
  }
  return name;
}

export function teamName(id, format) {
  const table = format >= 2026 ? TEAMS_2026 : TEAMS;
  const name = table[id];
  if (!name && id != null && id < 100) unknownId("team", id);
  return name ?? "";
}

export function sessionMode(sessionType) {
  for (const [mode, ids] of Object.entries(SESSION_MODE)) {
    if (ids.includes(sessionType)) return mode;
  }
  return "unknown";
}

export function ersMaxJoules(format) {
  return format >= 2026 ? ERS_MAX_J[2026] : ERS_MAX_J.default;
}
