// Driver names, as displayed and as spoken.
//
// Two problems, both from public lobbies rather than from the game's own AI.
//
// Every human whose profile name is not shared comes through as "Player". In a
// twenty car online race that can be most of the grid, and it produced radio
// like "Player has gone past" and "stop for Player", which is worse than
// saying nothing: it sounds like the app is broken, and it is unusable as an
// identifier because it names half the field at once.
//
// The rest are gamertags, which are written to be read and not to be said.
// "[JBT] Tim Uhlmann" has a clan tag the driver does not care about, and
// "King_Diam" has an underscore a voice model will either skip or spell.
//
// So each driver gets two names. `display` keeps the gamertag as it is, for
// the timing tower, because that is what the driver sees on his own screen in
// game. `spoken` is what the engineer says. Where a name cannot identify one
// car, the spoken form falls back to the race number, which is painted on the
// car and is the identifier a real engineer would use anyway.

// Names the game hands out to more than one car. Matched whole, case
// insensitively, with any trailing digits the game may have appended.
const PLACEHOLDERS =
  /^(player|driver|racer|guest|human|ai|unknown|anonymous|network player)\s*\d*$/i;

// A clan tag wrapped in brackets at either end of the name.
const LEADING_TAG = /^\s*[[({<|][^\])}>|]{0,12}[\])}>|]\s*/;
const TRAILING_TAG = /\s*[[({<|][^\])}>|]{0,12}[\])}>|]\s*$/;

/**
 * Make one name sayable, without trying to make it different from anyone
 * else's. Deduplication happens later, once the whole roster is known.
 */
export function sayable(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";

  // Tags are stripped only when a name survives them, so a driver called
  // "[FAST]" is left alone rather than reduced to nothing.
  const withoutLeading = s.replace(LEADING_TAG, "").trim();
  if (withoutLeading) s = withoutLeading;
  const withoutTrailing = s.replace(TRAILING_TAG, "").trim();
  if (withoutTrailing) s = withoutTrailing;

  // Separators that are read as punctuation or silence.
  s = s
    .replace(/[_.\-+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return s;
}

const isPlaceholder = (name) => !name || PLACEHOLDERS.test(name);

/**
 * Resolve the whole roster at once.
 *
 * Deduplication has to see every driver together: whether "Player" is
 * ambiguous is not a fact about that row, it is a fact about the grid. Called
 * once per participants packet rather than per name.
 *
 * @param {Array<{name:string, raceNumber:number}>} drivers by car index
 * @returns {Map<number, {display:string, spoken:string, ambiguous:boolean}>}
 */
export function buildNameTable(drivers = []) {
  const cleaned = drivers.map((d) => sayable(d?.name));

  // How many cars answer to each name. A name shared by two cars identifies
  // neither of them.
  const counts = new Map();
  for (const name of cleaned) {
    if (!name) continue;
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const table = new Map();
  for (let i = 0; i < drivers.length; i++) {
    const d = drivers[i];
    if (!d) continue;
    const name = cleaned[i];
    const shared = name ? counts.get(name.toLowerCase()) > 1 : true;
    const needsNumber = isPlaceholder(name) || shared;
    const number = Number(d.raceNumber);
    const hasNumber = Number.isFinite(number) && number > 0;

    table.set(i, {
      // The tower keeps the gamertag. Changing what the driver reads on his
      // own screen to something we invented would be its own confusion.
      display:
        String(d.name ?? "").trim() || (hasNumber ? `Car ${number}` : ""),
      spoken: needsNumber && hasNumber ? `car ${number}` : name,
      // True when nothing here identifies one car: a shared name and no race
      // number to fall back on. Callers should avoid naming this driver rather
      // than name him wrongly.
      ambiguous: needsNumber && !hasNumber,
    });
  }
  return table;
}

/**
 * The name to say for one car, or null when no name identifies it.
 * @param {Map} table from buildNameTable
 */
export function spokenName(table, idx, fallback = null) {
  const entry = table?.get(idx);
  if (!entry) return fallback;
  if (entry.ambiguous || !entry.spoken) return fallback;
  return entry.spoken;
}
