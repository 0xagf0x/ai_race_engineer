// Strategy engine.
//
// This is the part no competitor does: not "your tyres are at 55 percent" but a
// computed model of what a stop costs, what the tyres are actually doing, and
// what happens to the gap if you box now against boxing in three laps.
//
// Every number in here carries a source, because the engineer has to be able to
// show his working when the driver asks why:
//
//   measured  regressed from this driver's own stints at this circuit
//   game      the game's own prediction from the tyre sets packet
//   seeded    a static estimate from TRACK_META, roughly right at best
//
// The rule that matters most: when the inputs do not make physical sense, the
// engine refuses to advise rather than producing a confident number. A wrong
// byte offset upstream should make the engineer go quiet, not lie at 250 km/h.

const MIN_STINT_LAPS = 4; // below this a regression is noise
const MIN_LAPS_FOR_MEASURED = 6; // total laps on a compound before we trust our own slope
const OUTLIER_SEC = 3; // laps this far off the stint median are traffic or a mistake

// Carrying fuel costs lap time, so raw lap times get quicker through a stint as
// the tank empties, which hides degradation. This is the one assumed constant
// in the file: roughly 0.03 s/lap per kg on a modern F1 car, and burn is about
// 1.6 kg/lap, so a lap is worth about 0.05s of fuel effect. Marked as an
// assumption because it is not measured from anything the game sends.
const FUEL_EFFECT_SEC_PER_LAP = 0.05;

// Physical sanity bounds. Anything outside these means an input is wrong.
const SANE = {
  pitLossSec: [10, 40],
  degSecPerLap: [-0.05, 0.5],
  stintLaps: [1, 80],
  lapMs: [30000, 300000],
};

const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Least squares slope of y against x. Returns seconds of lap time added per lap
 * of tyre age, plus how well the line fits.
 */
function regress(points) {
  const n = points.length;
  if (n < 3) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  const intercept = my - slope * mx;

  // r squared, so a stint of pure traffic noise can be told apart from real deg
  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    ssRes += (p.y - (slope * p.x + intercept)) ** 2;
    ssTot += (p.y - my) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2, n };
}

/**
 * Tracks the current stint lap by lap and keeps completed stints for the
 * degradation model. One instance per session; stints are persisted into the
 * session record so priors can aggregate across visits.
 */
export class Strategy {
  constructor() {
    this.reset();
  }

  reset() {
    this.stints = []; // completed: {compound, laps:[{age, ms}], startLap, endLap}
    this.current = null;
    this.priorStints = []; // from previous sessions at this circuit
    this._lastLapSeen = -1;
    this._lastTyreAge = null;
  }

  /** Load degradation history from previous visits, via SessionStore.priors(). */
  loadPriors(priors) {
    this.priorStints = Array.isArray(priors?.stints) ? priors.stints : [];
  }

  /**
   * Called once per completed lap. Everything here is per-lap, not per-packet.
   * @param {object} state live bridge state
   */
  onLapComplete(state) {
    const lap = state.player?.lap ?? {};
    const st = state.player?.status ?? {};
    const s = state.session ?? {};

    const lapNum = lap.currentLapNum;
    const lastMs = lap.lastLapMs;
    const age = st.tyreAgeLaps;
    const compound = st.tyreCompound ?? st.tyre ?? null;

    if (lapNum == null || lapNum === this._lastLapSeen) return;
    this._lastLapSeen = lapNum;

    // A tyre age that went backwards means a new set: close the stint.
    if (this._lastTyreAge != null && age != null && age < this._lastTyreAge) {
      this._closeStint(lapNum - 1);
    }
    this._lastTyreAge = age;

    if (!this.current && compound) {
      this.current = { compound, laps: [], startLap: lapNum, endLap: null };
    }
    if (!this.current) return;

    // Only laps that say something about pace: valid, green flag, not an
    // out-lap or in-lap, and within reason. A stint average built from an
    // in-lap is what makes a deg model quietly wrong.
    const usable =
      inRange(lastMs, SANE.lapMs) &&
      !lap.invalid &&
      (s.safetyCar === "none" || !s.safetyCar) &&
      !lap.pit &&
      age != null &&
      age > 0;

    if (usable) {
      this.current.laps.push({ age, ms: lastMs, at: state.sessionTime ?? 0 });
    }
  }

  _closeStint(endLap) {
    if (this.current?.laps?.length) {
      this.current.endLap = endLap;
      this.stints.push(this.current);
    }
    this.current = null;
  }

  /**
   * Undo a flashback. Everything recorded after the rewound-to session time
   * did not happen, so it comes out of the model.
   *
   * This matters more here than anywhere else: without it, a driver who
   * flashbacks three times records the same lap three times at the same tyre
   * age with three different lap times, and the degradation regression fits a
   * line through laps that were never driven.
   */
  rewindTo(sessionTime) {
    const keep = (l) => (l.at ?? 0) <= sessionTime;

    for (const stint of this.stints) {
      stint.laps = stint.laps.filter(keep);
    }
    if (this.current) this.current.laps = this.current.laps.filter(keep);

    // A stint with nothing left never happened.
    this.stints = this.stints.filter((s) => s.laps.length);

    // If the rewind went back past a pit stop, the stint that was closed is
    // live again. Reopening it is what stops the next lap opening a third
    // stint on the same set of tyres.
    if (!this.current && this.stints.length) {
      this.current = this.stints.pop();
      this.current.endLap = null;
    }

    // The lap and tyre age guards have to move back too, or the next lap looks
    // like a repeat and gets dropped, or looks like a new set and closes the
    // stint.
    this._lastLapSeen = -1;
    this._lastTyreAge = null;
  }

  /** Stints in a form the session record can persist. */
  export() {
    const all = [...this.stints];
    if (this.current?.laps?.length) {
      all.push({ ...this.current, endLap: this._lastLapSeen });
    }
    return all.map((s) => ({
      compound: s.compound,
      startLap: s.startLap,
      endLap: s.endLap,
      laps: s.laps,
    }));
  }

  /**
   * Degradation for a compound: seconds of lap time added per lap of tyre age.
   *
   * Own stints first, this session and previous visits pooled, because deg is a
   * property of the circuit and the compound rather than of one afternoon. The
   * game's own prediction is the cold start.
   */
  degradation(compound, state) {
    const pool = [...this.priorStints, ...this.export()].filter(
      (s) => s.compound === compound && s.laps?.length >= MIN_STINT_LAPS,
    );
    const totalLaps = pool.reduce((a, s) => a + s.laps.length, 0);

    if (totalLaps >= MIN_LAPS_FOR_MEASURED) {
      const points = [];
      for (const stint of pool) {
        // Outliers are traffic, mistakes and lock-ups, not degradation.
        const med = median(stint.laps.map((l) => l.ms));
        for (const l of stint.laps) {
          if (Math.abs(l.ms - med) / 1000 > OUTLIER_SEC) continue;
          // Add back the fuel effect so the slope is tyre, not tank.
          points.push({
            x: l.age,
            y: l.ms / 1000 + l.age * FUEL_EFFECT_SEC_PER_LAP,
          });
        }
      }
      const fit = regress(points);
      if (fit && inRange(fit.slope, SANE.degSecPerLap) && fit.r2 > 0.3) {
        return {
          secPerLap: +fit.slope.toFixed(3),
          source: "measured",
          basis: `${points.length} laps across ${pool.length} stints`,
          confidence: fit.r2 > 0.6 ? "good" : "rough",
          fuelCorrected: true,
        };
      }
    }

    // Cold start: the game's own lifespan prediction for the fitted set.
    const fitted = state.tyreSets?.sets?.find((x) => x.fitted);
    if (fitted?.usableLifeLaps > 0) {
      return {
        usableLifeLaps: fitted.usableLifeLaps,
        source: "game",
        basis: "the game's own prediction for this set",
        confidence: "rough",
      };
    }

    return { source: "none", confidence: "none" };
  }

  /** What a stop costs here, and how we know. */
  pitLoss(state) {
    const s = state.session ?? {};
    if (inRange(s.measuredPitLossSec, SANE.pitLossSec)) {
      return {
        sec: s.measuredPitLossSec,
        source: "measured",
        basis: "timed on your own stop here",
      };
    }
    if (inRange(s.typicalPitLossSec, SANE.pitLossSec)) {
      return {
        sec: s.typicalPitLossSec,
        source: "measured",
        basis: "median of your previous stops here",
      };
    }
    if (inRange(s.pitLossSec, SANE.pitLossSec)) {
      return { sec: s.pitLossSec, source: "seeded", basis: "circuit estimate" };
    }
    return { sec: null, source: "none" };
  }

  /**
   * Undercut maths against a specific rival.
   *
   * The undercut works because fresh tyres are quicker than the old ones the
   * rival stays out on. Gain is the per lap advantage multiplied by the laps he
   * stays out, minus whatever the gap costs you.
   */
  undercut(state, rival) {
    const loss = this.pitLoss(state);
    const deg = this.degradation(
      state.player?.status?.tyreCompound ?? state.player?.status?.tyre,
      state,
    );
    if (!loss.sec || deg.source === "none" || !deg.secPerLap) return null;

    const myAge = state.player?.status?.tyreAgeLaps ?? 0;
    const theirAge = rival?.tyreAge ?? null;
    if (theirAge == null) return null;

    // Pace advantage a fresh set gives you over his current set, per lap.
    const perLapGain = +(deg.secPerLap * theirAge).toFixed(2);
    if (perLapGain <= 0) return null;

    return {
      // The resolved name, so an undercut call does not say "Player".
      rival: rival.spokenName ?? rival.name,
      pitLossSec: loss.sec,
      pitLossSource: loss.source,
      degSecPerLap: deg.secPerLap,
      degSource: deg.source,
      yourTyreAge: myAge,
      theirTyreAge: theirAge,
      gainPerLapSec: perLapGain,
      // Two laps out is the standard undercut window.
      netAfterTwoLapsSec: +(perLapGain * 2).toFixed(1),
      advise: deg.confidence === "good" && loss.source === "measured",
    };
  }

  /**
   * Fuel target: how much per lap he needs to save to finish.
   * fuelDeltaLaps is a surplus, so a negative value is the shortfall.
   */
  fuelTarget(state) {
    const st = state.player?.status ?? {};
    const lap = state.player?.lap ?? {};
    const s = state.session ?? {};
    if (st.fuelDeltaLaps == null || !s.totalLaps || !lap.currentLapNum) {
      return null;
    }
    const lapsLeft = s.totalLaps - lap.currentLapNum;
    if (lapsLeft <= 0 || st.fuelDeltaLaps >= 0) return null;

    // Burn per lap from what is in the tank against what it has to cover.
    const burnPerLap = st.fuelInTank / Math.max(1, lapsLeft + st.fuelDeltaLaps);
    const saveKgPerLap = (Math.abs(st.fuelDeltaLaps) * burnPerLap) / lapsLeft;

    return {
      shortfallLaps: Math.abs(st.fuelDeltaLaps),
      lapsRemaining: lapsLeft,
      saveKgPerLap: +saveKgPerLap.toFixed(2),
      source: "measured",
    };
  }

  /**
   * The block handed to the engineer. Deliberately quiet when it has nothing
   * trustworthy: an empty brief is better than a confident guess.
   */
  brief(state) {
    const s = state.session ?? {};
    if (s.mode !== "race") return null;

    const st = state.player?.status ?? {};
    const compound = st.tyreCompound ?? st.tyre;
    const deg = this.degradation(compound, state);
    const loss = this.pitLoss(state);
    const fuel = this.fuelTarget(state);

    const me = state.opponents?.find((o) => o.isPlayer);
    const ahead = me
      ? state.opponents.find((o) => o.position === me.position - 1)
      : null;
    const behind = me
      ? state.opponents.find((o) => o.position === me.position + 1)
      : null;

    const out = {
      tyreAgeLaps: st.tyreAgeLaps ?? null,
      compound: compound ?? null,
      degradation:
        deg.source === "none"
          ? null
          : {
              ...deg,
              // Spelled out so the engineer can quote the reasoning, not just
              // the conclusion.
              explanation:
                deg.source === "measured"
                  ? `losing ${deg.secPerLap} seconds a lap per lap of tyre age, from ${deg.basis}`
                  : `the game predicts ${deg.usableLifeLaps} usable laps on this set`,
            },
      pitLoss: loss.sec
        ? { sec: loss.sec, source: loss.source, basis: loss.basis }
        : null,
      fuel,
    };

    const undercutAhead = ahead ? this.undercut(state, ahead) : null;
    const undercutBehind = behind ? this.undercut(state, behind) : null;
    if (undercutAhead) out.undercutOnCarAhead = undercutAhead;
    if (undercutBehind) out.threatFromCarBehind = undercutBehind;

    // If nothing in here is trustworthy, say so rather than handing over a
    // block of nulls the model will try to make something of.
    const hasAnything =
      out.degradation || out.pitLoss || out.fuel || undercutAhead;
    if (!hasAnything) {
      return {
        available: false,
        reason: "not enough data to advise on strategy yet",
      };
    }
    return out;
  }
}
