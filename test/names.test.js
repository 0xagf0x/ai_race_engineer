// Driver name tests. Run with `npm test`.
//
// The roster below is a real public lobby, taken from a Bahrain race where the
// engineer said "stop for Player" and "Player has gone past" about nine
// different cars. Nine of the twenty were called Player, including the driver.

import test from "node:test";
import assert from "node:assert/strict";
import { buildNameTable, sayable, spokenName } from "../src/names.js";

// name, race number, in finishing order from the timing tower
const LOBBY = [
  ["Wappler3000", 3],
  ["[JBT] Tim Uhlmann", 7],
  ["ricewolf78", 11],
  ["Tannenzapfen693", 14],
  ["TRT Robin", 16],
  ["Player", 22],
  ["Tyler Paulmann", 27],
  ["Player", 31],
  ["KimiRaikkonen98", 44],
  ["Player", 55],
  ["Player", 63],
  ["Player", 77],
  ["Player", 81],
  ["Player", 88],
  ["Player", 4],
  ["kratigno0", 9],
  ["King_Diam", 18],
  ["WeresMyRizlasAt", 23],
  ["Player", 40],
  ["Player", 99],
];

const roster = LOBBY.map(([name, raceNumber]) => ({ name, raceNumber }));

test("every car in a real lobby gets a name that identifies only it", () => {
  const table = buildNameTable(roster);
  const spoken = [...table.values()].map((e) => e.spoken);

  assert.equal(spoken.length, 20);
  assert.equal(new Set(spoken).size, 20, "two cars answer to the same name");
  assert.ok(
    !spoken.some((s) => /^player$/i.test(s)),
    "nobody is still called Player",
  );
});

test("a shared name falls back to the number painted on the car", () => {
  const table = buildNameTable(roster);
  assert.equal(table.get(5).spoken, "car 22");
  assert.equal(table.get(19).spoken, "car 99");
});

test("the timing tower keeps the gamertag the driver sees in game", () => {
  const table = buildNameTable(roster);
  assert.equal(table.get(5).display, "Player");
  assert.equal(table.get(1).display, "[JBT] Tim Uhlmann");
});

test("clan tags are dropped from the spoken name but a bare tag survives", () => {
  assert.equal(sayable("[JBT] Tim Uhlmann"), "Tim Uhlmann");
  assert.equal(sayable("(TRT) Robin"), "Robin");
  assert.equal(sayable("|FAST| Kowalski"), "Kowalski");
  assert.equal(sayable("Hamilton [GOAT]"), "Hamilton");
  // Stripping this one would leave nothing at all, so it stays as it is.
  assert.equal(sayable("[FAST]"), "[FAST]");
});

test("separators a voice model would spell out become spaces", () => {
  assert.equal(sayable("King_Diam"), "King Diam");
  assert.equal(sayable("max.verstappen"), "max verstappen");
  assert.equal(sayable("Lewis--Hamilton"), "Lewis Hamilton");
  assert.equal(sayable("  spaced   out  "), "spaced out");
});

test("an ordinary unique name is left exactly as it is", () => {
  const table = buildNameTable(roster);
  assert.equal(table.get(0).spoken, "Wappler3000");
  assert.equal(table.get(6).spoken, "Tyler Paulmann");
  assert.equal(table.get(17).spoken, "WeresMyRizlasAt");
});

test("placeholders are replaced even when only one car uses them", () => {
  const table = buildNameTable([
    { name: "Player", raceNumber: 44 },
    { name: "Hamilton", raceNumber: 44 },
  ]);
  assert.equal(table.get(0).spoken, "car 44");
  assert.equal(table.get(1).spoken, "Hamilton");
});

test("two drivers sharing a real name both fall back to their numbers", () => {
  const table = buildNameTable([
    { name: "Schumacher", raceNumber: 47 },
    { name: "Schumacher", raceNumber: 5 },
    { name: "Alonso", raceNumber: 14 },
  ]);
  assert.equal(table.get(0).spoken, "car 47");
  assert.equal(table.get(1).spoken, "car 5");
  assert.equal(table.get(2).spoken, "Alonso", "a unique name is untouched");
});

test("a car with no usable name and no number is flagged rather than named", () => {
  const table = buildNameTable([
    { name: "Player", raceNumber: 0 },
    { name: "Player", raceNumber: 0 },
  ]);
  assert.equal(table.get(0).ambiguous, true);
  // The caller is expected to say nothing rather than invent an identifier.
  assert.equal(spokenName(table, 0), null);
  assert.equal(spokenName(table, 0, "a car"), "a car");
});

test("spokenName falls back for a car that is not on the roster", () => {
  const table = buildNameTable(roster);
  assert.equal(spokenName(table, 99, "a car"), "a car");
  assert.equal(spokenName(table, 0, "a car"), "Wappler3000");
});

test("an empty or missing roster does not throw", () => {
  assert.equal(buildNameTable().size, 0);
  assert.equal(buildNameTable([]).size, 0);
  assert.equal(buildNameTable([null, undefined]).size, 0);
  assert.equal(sayable(null), "");
  assert.equal(sayable(undefined), "");
});
