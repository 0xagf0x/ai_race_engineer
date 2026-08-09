// Automatic engineer callouts.
//
// Ported from web/lib/coach.ts. The rules engine is unchanged in shape:
// evaluate() turns the live state into candidate observations, pick() chooses
// the highest priority one that isn't on cooldown, and the caller has it phrased
// as radio. What changed is the schema underneath.
//
// The old version read fields that never existed on our side: p.fuelRemainingLaps
// (actually player.status.fuelRemainingLaps), p.tyres.wearPct (player.damage.tyreWear),
// p.ersStoreEnergyPct (nothing populated it at all until the parser fix), and
// o.gapToPlayerMs, which the F1 feed never sends. Gaps come from the delta chain
// instead: my own deltaAheadMs is the gap to the car in front of me, and the gap
// to the car behind is that car's deltaAheadMs. See gapRules().
//
// Priorities: 1 chatter, 2 useful, 3 important, 4 urgent.

export const LEVELS = {
  low: { minGapMs: 75000, minPriority: 3, label: "Low, key moments only" },
  medium: { minGapMs: 35000, minPriority: 2, label: "Medium, regular updates" },
  high: { minGapMs: 12000, minPriority: 1, label: "High, constant coaching" },
};

// Urgent calls that go out instantly as canned lines rather than waiting on a
// model round trip. Anything the driver needs to act on inside a corner belongs
// here; everything else is worth the latency to have phrased properly.
const INSTANT = {
  safety_car: "Safety car, safety car.",
  fuel_critical: "Fuel critical. Lift and coast, now.",
  chequered: "Chequered flag. Good job.",
};

// How long a queued event stays worth saying. Race events arrive out of band
// and can land inside a quiet gap or while the engineer is mid-sentence; a
// penalty is still worth hearing a few seconds late, a fastest lap is not.
const EVENT_TTL_MS = 12000;
const MAX_PENDING = 12;

// A fact that has sat in the queue through a model round trip and a quiet gap
// is no longer worth speaking. Three seconds at racing speed is two hundred
// metres, which is the difference between "he's four tenths back" and a lie.
const FACT_TTL_MS = 3000;

// Temperature bands. Rules fire on a crossing, not while sitting inside one,
// so a tyre parked at 108 degrees produces one call rather than one per
// cooldown for as long as it stays there.
const TYRE_BANDS = [
  { max: 65, name: "cold" },
  { max: 105, name: "working" },
  { max: 115, name: "warm" },
  { max: Infinity, name: "overheating" },
];
const bandOf = (t) => TYRE_BANDS.find((b) => t <= b.max).name;

export const freshMemory = () => ({
  lastLapSeen: -1,
  bestLapMs: 0,
  lastPosition: -1,
  lastCornerTs: 0,
  lastSafetyCar: "none",
  saidGapAhead: null,
  saidGapBehind: null,
  saidTyreBand: null,
  saidWearPct: null,
  saidErsPct: null,
  saidSpread: null,
  saidUndercut: null,
  saidStintWindow: null,
  saidFuelTarget: null,
  saidPenaltySec: 0,
});

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const WHEELS = ["front left", "front right", "rear left", "rear right"];

function fmtLap(ms) {
  if (!ms || ms <= 0) return "--:--.---";
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

/**
 * @param {object} state the live bridge state
 * @param {object} mem   rolling memory, mutated in place
 * @returns {Array<{id:string, priority:number, fact:string, cooldownMs:number}>}
 */
export function evaluate(state, mem) {
  const out = [];
  const p = state.player ?? {};
  const lap = p.lap ?? {};
  const st = p.status ?? {};
  const s = state.session ?? {};

  // --- lap pace ---
  if (lap.currentLapNum != null && lap.currentLapNum !== mem.lastLapSeen) {
    if (mem.lastLapSeen > 0 && lap.lastLapMs > 0) {
      const t = lap.lastLapMs;
      if (mem.bestLapMs === 0 || t < mem.bestLapMs) {
        const gain = mem.bestLapMs
          ? ((mem.bestLapMs - t) / 1000).toFixed(1)
          : null;
        out.push({
          id: "lap_best",
          priority: 3,
          cooldownMs: 0,
          fact: `personal best lap ${fmtLap(t)}${gain ? `, ${gain} seconds quicker than the previous best` : ""}`,
        });
        mem.bestLapMs = t;
      } else {
        const delta = ((t - mem.bestLapMs) / 1000).toFixed(1);
        out.push({
          id: "lap_pace",
          priority: 3,
          cooldownMs: 0,
          fact: `lap ${mem.lastLapSeen} in ${fmtLap(t)}, ${delta} off the best of ${fmtLap(mem.bestLapMs)}`,
        });
      }
      // New: we have sector history now, so we can point at where it went.
      if (
        lap.idealLapMs &&
        mem.bestLapMs &&
        lap.idealLapMs < mem.bestLapMs - 200
      ) {
        out.push({
          id: "ideal_lap",
          priority: 2,
          cooldownMs: 120000,
          fact: `theoretical best is ${fmtLap(lap.idealLapMs)}, ${((mem.bestLapMs - lap.idealLapMs) / 1000).toFixed(1)} under the actual best, so the sectors are there on separate laps`,
        });
      }
    }
    mem.lastLapSeen = lap.currentLapNum;
  }

  // --- position changes ---
  if (lap.position > 0) {
    if (mem.lastPosition > 0 && lap.position !== mem.lastPosition) {
      out.push({
        id: "position",
        priority: 3,
        cooldownMs: 3000,
        fact: `${lap.position < mem.lastPosition ? "gained" : "lost"} a place, now P${lap.position}`,
      });
    }
    mem.lastPosition = lap.position;
  }

  // --- corner grading against the reference lap ---
  const fb = state.coachFeedback;
  if (fb?.ts && fb.ts !== mem.lastCornerTs) {
    mem.lastCornerTs = fb.ts;
    if (!fb.onReference) {
      out.push({ id: "corner", priority: 1, cooldownMs: 6000, fact: fb.text });
    }
  }

  // --- upcoming braking zone, only while actually approaching it ---
  const c = state.coach;
  if (c && p.speed > 80 && c.brakeInM > 60 && c.brakeInM < 260) {
    out.push({
      id: "next_corner",
      priority: 1,
      cooldownMs: 4000,
      fact: `braking zone in ${c.brakeInM} metres, reference is gear ${c.gear} and ${c.minSpeedKph} kph minimum`,
    });
  }

  // --- fuel ---
  // fuelDeltaLaps is the MFD surplus: laps of fuel BEYOND what finishing
  // requires. Positive is margin, negative is a shortfall. It is not a range,
  // which is why the old "under half a lap left" wording read a healthy +2.8
  // as nearly dry.
  if (st.fuelDeltaLaps != null) {
    if (st.fuelDeltaLaps < 0) {
      out.push({
        id: "fuel_short",
        priority: 4,
        cooldownMs: 45000,
        fact: `fuel is ${Math.abs(st.fuelDeltaLaps).toFixed(1)} laps short of the finish, needs saving now`,
      });
    } else if (st.fuelDeltaLaps < 0.5) {
      out.push({
        id: "fuel_tight",
        priority: 3,
        cooldownMs: 60000,
        fact: `fuel margin down to ${st.fuelDeltaLaps.toFixed(1)} of a lap, no room left`,
      });
    } else if (st.fuelDeltaLaps < 1.5) {
      out.push({
        id: "fuel_low",
        priority: 2,
        cooldownMs: 90000,
        fact: `fuel margin ${st.fuelDeltaLaps.toFixed(1)} laps, worth a lift and coast`,
      });
    }
  } else if (st.fuelInTank != null && st.fuelCapacity) {
    // GT7 and any session without an MFD delta: tank percentage is all we have.
    const pct = (st.fuelInTank / st.fuelCapacity) * 100;
    if (pct < 8)
      out.push({
        id: "fuel_critical",
        priority: 4,
        cooldownMs: 20000,
        fact: `fuel at ${pct.toFixed(0)} percent`,
      });
    else if (pct < 20)
      out.push({
        id: "fuel_low",
        priority: 3,
        cooldownMs: 60000,
        fact: `fuel at ${pct.toFixed(0)} percent`,
      });
  }

  // --- tyres (arrays are FL FR RL RR after the state.js normalisation) ---
  const temps = p.tyreSurfaceTemps;
  if (temps?.some((t) => t > 0)) {
    const hottest = Math.max(...temps);
    const coldest = Math.min(...temps);
    const where = WHEELS[temps.indexOf(hottest)];
    const band = bandOf(hottest);

    // Temporary: confirms whether the cold-tyre rule is genuinely firing on hot
    // tyres late in a race, or whether those calls came from early laps and the
    // log was simply long. Remove once answered.
    if (band !== mem.saidTyreBand) {
      console.log(
        `[callouts] tyre band ${mem.saidTyreBand} -> ${band}, temps ${temps.join("/")}, lap ${lap.currentLapNum}`,
      );
    }

    // Only on a crossing. Sitting at a hundred and eight degrees is one call,
    // not one every cooldown for as long as it lasts.
    if (band !== mem.saidTyreBand) {
      mem.saidTyreBand = band;
      if (band === "overheating") {
        out.push({
          id: "tyre_temp",
          priority: 3,
          cooldownMs: 30000,
          fact: `${where} tyre at ${Math.round(hottest)} degrees, overheating`,
        });
      } else if (band === "warm") {
        out.push({
          id: "tyre_temp",
          priority: 2,
          cooldownMs: 30000,
          fact: `${where} running warm at ${Math.round(hottest)} degrees`,
        });
      } else if (band === "cold" && avg(temps) < 75) {
        out.push({
          id: "tyre_temp",
          priority: 2,
          cooldownMs: 30000,
          fact: `tyres still cold, averaging ${Math.round(avg(temps))} degrees`,
        });
      } else if (band === "working") {
        // Crossing into the working window is worth knowing after a cold start,
        // and it is the call that stops the cold warnings sounding unresolved.
        out.push({
          id: "tyre_temp",
          priority: 1,
          cooldownMs: 30000,
          fact: `tyres are in the window now, ${Math.round(avg(temps))} degrees average`,
        });
      }
    }

    const spread = Math.round(hottest - coldest);
    if (
      spread > 25 &&
      (mem.saidSpread == null || Math.abs(spread - mem.saidSpread) >= 8)
    ) {
      mem.saidSpread = spread;
      out.push({
        id: "tyre_balance",
        priority: 2,
        cooldownMs: 120000,
        fact: `${spread} degree spread across the tyres, hottest is the ${where}`,
      });
    }
  }

  const wear = p.damage?.tyreWear;
  if (wear?.length) {
    const worst = Math.max(...wear);
    // Every ten points of wear, not every ninety seconds.
    if (
      worst > 60 &&
      (mem.saidWearPct == null || worst - mem.saidWearPct >= 10)
    ) {
      mem.saidWearPct = worst;
      out.push({
        id: "tyre_wear",
        priority: 3,
        cooldownMs: 60000,
        fact: `tyre wear up to ${Math.round(worst)} percent on the ${WHEELS[wear.indexOf(worst)]} after ${st.tyreAgeLaps ?? "?"} laps on the ${st.tyre ?? "current set"}`,
      });
    }
  }

  out.push(...gapRules(state, mem));

  // --- car condition ---
  const d = p.damage;
  if (d) {
    const parts = [
      d.frontWing > 10 ? `front wing ${d.frontWing}%` : null,
      d.rearWing > 10 ? `rear wing ${d.rearWing}%` : null,
      d.floor > 10 ? `floor ${d.floor}%` : null,
    ].filter(Boolean);
    if (parts.length)
      out.push({
        id: "damage",
        priority: 4,
        cooldownMs: 60000,
        fact: `damage: ${parts.join(", ")}`,
      });
  }
  // Deploy mode is deliberately not in this fact. F1 25 reports mode 0 (None)
  // at racing speed, which we cannot yet explain, so quoting it would have the
  // engineer describing a car state that is probably not real.
  if (
    st.ersStorePct != null &&
    st.ersStorePct < 8 &&
    (mem.saidErsPct == null || Math.abs(st.ersStorePct - mem.saidErsPct) >= 3)
  ) {
    mem.saidErsPct = st.ersStorePct;
    out.push({
      id: "ers_low",
      priority: 2,
      cooldownMs: 90000,
      fact: `energy store down to ${st.ersStorePct} percent`,
    });
  }
  if (p.engineTemp > 120) {
    out.push({
      id: "engine_hot",
      priority: 3,
      cooldownMs: 60000,
      fact: `engine temperature ${p.engineTemp} degrees`,
    });
  }
  // Only when the total moves. Outstanding seconds are true for as long as they
  // are unserved, so under a cooldown alone this repeats a fact the driver
  // already acted on, and it can contradict penalty_event, which describes the
  // individual penalty rather than the running total.
  if (lap.penalties > 0 && lap.penalties !== mem.saidPenaltySec) {
    mem.saidPenaltySec = lap.penalties;
    out.push({
      id: "penalty",
      priority: 4,
      cooldownMs: 60000,
      fact: `${lap.penalties} seconds of penalties outstanding`,
    });
  } else if (lap.penalties === 0) {
    // Served or cleared: reset so a later penalty is announced again.
    mem.saidPenaltySec = 0;
  }
  if (lap.warnings >= 3) {
    out.push({
      id: "warnings",
      priority: 3,
      cooldownMs: 90000,
      fact: `${lap.warnings} track limits warnings, one more is a penalty`,
    });
  }
  if (
    s.safetyCar &&
    s.safetyCar !== "none" &&
    s.safetyCar !== mem.lastSafetyCar
  ) {
    mem.lastSafetyCar = s.safetyCar;
    out.push({
      id: "safety_car",
      priority: 4,
      cooldownMs: 30000,
      fact: `${s.safetyCar === "virtual" ? "virtual safety car" : "safety car"} deployed`,
    });
  } else if (s.safetyCar === "none") {
    mem.lastSafetyCar = "none";
  }

  // --- weather, new now that the session packet forecast is parsed ---
  const rain = s.forecast?.find((f) => f.rainPercent >= 40);
  if (rain) {
    out.push({
      id: "weather",
      priority: 3,
      cooldownMs: 120000,
      fact: `${rain.rainPercent} percent chance of rain in ${rain.inMin} minutes, ${rain.weather.toLowerCase()} forecast`,
    });
  }

  // --- strategy ---
  // Everything here comes from the computed model rather than a threshold on a
  // raw number. The engine already refuses to produce figures it does not
  // trust, so a null block means genuinely nothing to say, not a quiet failure.
  const strat = state.strategy;
  if (strat && strat.available !== false) {
    // Deg-based stint window. This replaces the old "tyres past 55 percent"
    // rule: what matters is how much lap time the set is costing now, not how
    // worn it looks.
    const deg = strat.degradation;
    if (deg?.source === "measured" && strat.tyreAgeLaps > 0) {
      const costNow = +(deg.secPerLap * strat.tyreAgeLaps).toFixed(1);
      if (
        costNow >= 0.5 &&
        (mem.saidStintWindow == null || costNow - mem.saidStintWindow >= 0.3)
      ) {
        mem.saidStintWindow = costNow;
        out.push({
          id: "stint_window",
          priority: 3,
          cooldownMs: 90000,
          fact:
            `this set is costing about ${costNow} seconds a lap against fresh rubber ` +
            `after ${strat.tyreAgeLaps} laps, ${deg.explanation}` +
            (strat.pitLoss
              ? `, and a stop here costs ${strat.pitLoss.sec} seconds, ${strat.pitLoss.basis}`
              : ""),
        });
      }
    }

    // An undercut only gets voiced when the engine is willing to advise on it,
    // which needs a measured pit loss and a confident deg slope. Below that bar
    // the numbers still exist for the driver to ask about, but the engineer
    // does not raise them.
    const uc = strat.undercutOnCarAhead;
    if (uc?.advise && uc.netAfterTwoLapsSec >= uc.pitLossSec * 0.15) {
      if (mem.saidUndercut !== uc.rival) {
        mem.saidUndercut = uc.rival;
        out.push({
          id: "undercut",
          priority: 3,
          cooldownMs: 120000,
          fact:
            `undercut is on ${uc.rival}: he is ${uc.theirTyreAge} laps on his set against your ${uc.yourTyreAge}, ` +
            `fresh tyres are worth about ${uc.gainPerLapSec} seconds a lap against him, ` +
            `so boxing now nets roughly ${uc.netAfterTwoLapsSec} seconds if he stays out two more laps. ` +
            `Pit loss ${uc.pitLossSec} seconds, ${uc.pitLossSource}`,
        });
      }
    } else if (!uc) {
      mem.saidUndercut = null;
    }

    // The threat version of the same maths.
    const threat = strat.threatFromCarBehind;
    if (threat?.advise && threat.netAfterTwoLapsSec >= 2) {
      out.push({
        id: "undercut_threat",
        priority: 3,
        cooldownMs: 120000,
        fact:
          `${threat.rival} behind is ${threat.theirTyreAge} laps on his set and can undercut us, ` +
          `worth about ${threat.netAfterTwoLapsSec} seconds if he boxes and we do not`,
      });
    }

    // Fuel target, which is the number he can act on rather than the shortfall.
    const f = strat.fuel;
    if (
      f?.saveKgPerLap > 0 &&
      (mem.saidFuelTarget == null ||
        Math.abs(f.saveKgPerLap - mem.saidFuelTarget) >= 0.03)
    ) {
      mem.saidFuelTarget = f.saveKgPerLap;
      out.push({
        id: "fuel_target",
        priority: 4,
        cooldownMs: 60000,
        fact: `${f.shortfallLaps.toFixed(1)} laps short with ${f.lapsRemaining} to go, needs ${f.saveKgPerLap} kilos a lap saved`,
      });
    }
  }

  // Stamped so tick() can discard anything that waited too long to be worth
  // saying. The rules are cheap and run at 10Hz; the model round trip is not.
  const at = Date.now();
  return out.map((c) => ({ ...c, at }));
}

// Gaps come from the delta-to-car-in-front chain, which is what the F1 feed
// actually sends. My gap to the car ahead is my own deltaAheadMs; the gap to
// the car behind is that car's deltaAheadMs.
//
// Gated on change rather than time. A gap that holds steady at four tenths is
// true for a minute, and under a pure cooldown it re-fired every time with
// fresh wording, which is how one battle produced eight near-identical calls.
function gapRules(state, mem) {
  const out = [];
  const me = state.opponents?.find((o) => o.isPlayer);
  if (!me) return out;

  const ahead = state.opponents.find((o) => o.position === me.position - 1);
  const behind = state.opponents.find((o) => o.position === me.position + 1);

  // Worth another sentence if it moved three tenths, or crossed into or out of
  // DRS range, which changes what he should actually do.
  //
  // The DRS comparison is on named booleans rather than inline. Written
  // inline, !== binds tighter than < and the expression parses as
  // now < (1 !== said) < 1, which is always false, and the formatter strips
  // the parentheses that would fix it.
  const moved = (now, said) => {
    if (said == null) return true;
    if (Math.abs(now - said) >= 0.3) return true;
    const inDrsNow = now < 1;
    const inDrsSaid = said < 1;
    return inDrsNow !== inDrsSaid;
  };

  if (ahead && me.deltaAheadMs > 0) {
    const gap = me.deltaAheadMs / 1000;
    if (gap < 3 && moved(gap, mem.saidGapAhead)) {
      mem.saidGapAhead = gap;
      out.push({
        id: "gap_ahead",
        priority: gap < 1 ? 3 : 2,
        cooldownMs: 12000,
        fact:
          gap < 1
            ? `${ahead.name} is ${gap.toFixed(1)} ahead, inside DRS range`
            : `closing on ${ahead.name}, ${gap.toFixed(1)} ahead`,
      });
    } else if (gap >= 3) {
      mem.saidGapAhead = null;
    }
  } else {
    mem.saidGapAhead = null;
  }

  if (behind?.deltaAheadMs > 0) {
    const gap = behind.deltaAheadMs / 1000;
    if (gap < 1.2 && moved(gap, mem.saidGapBehind)) {
      mem.saidGapBehind = gap;
      out.push({
        id: "under_pressure",
        priority: 3,
        cooldownMs: 12000,
        fact: `${behind.name} is ${gap.toFixed(1)} behind and in range`,
      });
    } else if (gap >= 1.2) {
      mem.saidGapBehind = null;
    }
  } else {
    mem.saidGapBehind = null;
  }

  const pitting = state.opponents.filter((o) => !o.isPlayer && o.pit);
  if (pitting.length) {
    out.push({
      id: "rivals_pit",
      priority: 3,
      cooldownMs: 30000,
      fact: `${pitting.map((o) => o.name).join(", ")} in the pits`,
    });
  }
  return out;
}

export function pick(candidates, level, lastFired) {
  const cfg = LEVELS[level];
  if (!cfg) return null;
  const now = Date.now();
  return (
    candidates
      .filter((c) => c.priority >= cfg.minPriority)
      .filter((c) => now - (lastFired[c.id] ?? 0) >= c.cooldownMs)
      .sort((a, b) => b.priority - a.priority)[0] ?? null
  );
}

/**
 * Runs the loop: evaluate, pick, phrase, speak. Owns its own timing so
 * src/index.js just calls tick() from the broadcast interval.
 */
export class Callouts {
  /**
   * @param {object} state
   * @param {import("./engineer.js").Engineer} engineer
   * @param {(text:string) => void} speak broadcasts to the browser
   * @param {object} opts
   */
  constructor(state, engineer, speak, opts = {}) {
    this.state = state;
    this.engineer = engineer;
    this.speak = speak;
    this.level = opts.level ?? "medium";
    this.mem = freshMemory();
    this.lastFired = {};
    this.lastCalloutAt = 0;
    this.recentLines = [];
    this.pendingEvents = [];
    this.busy = false;
    this.speaking = false;
  }

  setLevel(level) {
    if (level === "off" || LEVELS[level]) this.level = level;
  }

  // Race events arrive out of band; queue them as one-shot candidates so they
  // go through the same priority and cooldown gate as everything else.
  onEvent(ev, resolveName, describe) {
    switch (ev.code) {
      case "FTLP":
        this._queue({
          id: `ftlp_${ev.vehicleIdx}`,
          priority: 2,
          cooldownMs: 10000,
          fact: `fastest lap of the session set by ${resolveName?.(ev.vehicleIdx) ?? "someone"}`,
        });
        break;
      case "OVTK": {
        const me = this.state.opponents?.find((o) => o.isPlayer);
        if (me && ev.overtakenVehicleIdx === me.idx) {
          this._queue({
            id: "overtaken",
            priority: 3,
            cooldownMs: 8000,
            fact: `${resolveName?.(ev.overtakingVehicleIdx) ?? "a car"} has gone past`,
          });
        }
        break;
      }
      case "PENA": {
        // The event carries penaltyType and infringementType, and penalties.js
        // turns them into English. Ignoring both produced "a penalty has been
        // flagged", which was vague enough that the engineer invented a
        // five-second penalty and a pit stop to serve it after a warning.
        const described = describe?.(ev);
        if (!described) break;
        this._queue({
          id: "penalty_event",
          priority: described.serious ? 4 : 2,
          cooldownMs: 0,
          // describePenalty folds the reason into text already. The "no action
          // needed" suffix is load bearing: without it the model reasoned its
          // way from "a warning" to "five second penalty, box to serve it".
          fact: described.serious
            ? described.text
            : `${described.text}, no action needed`,
        });
        break;
      }
      case "CHQF":
        this.speak(INSTANT.chequered);
        break;
      case "RDFL":
        this._queue({
          id: "red_flag",
          priority: 4,
          cooldownMs: 0,
          fact: "red flag, session stopped",
        });
        break;
    }
  }

  // Stamped on arrival so tick() can age them out, and bounded so a stream of
  // events during a pile-up can't grow the queue without limit.
  _queue(candidate) {
    this.pendingEvents.push({ ...candidate, at: Date.now() });
    if (this.pendingEvents.length > MAX_PENDING) this.pendingEvents.shift();
  }

  /**
   * After a flashback the rolling memory describes a race that no longer
   * happened: a gap that has since changed, a position that was regained, a
   * best lap that was never set. Clearing the gates costs one repeated call
   * and avoids a run of calls about events that were undone.
   */
  rewind() {
    this.mem = freshMemory();
    this.pendingEvents = [];
  }

  /**
   * The browser reports when audio actually starts and stops. Model latency is
   * not speech duration: a two second response can take ten seconds to say, and
   * without this the next callout interrupts it.
   */
  setSpeaking(on) {
    clearTimeout(this._speakTimer);
    this.speaking = on;
    if (on) {
      // A tab that closes mid-sentence never sends the end marker, and the
      // engineer would go silent for the rest of the session.
      this._speakTimer = setTimeout(() => {
        this.speaking = false;
      }, 30000);
    } else {
      this.lastCalloutAt = Date.now();
    }
  }

  async tick() {
    const now = Date.now();

    // Evaluate on every tick regardless of whether we can speak. evaluate()
    // advances the rolling memory as a side effect, so skipping it while the
    // engineer is mid-sentence means a lap completed in that window is never
    // seen: the next tick reads a newer lap number and the old one is gone.
    const observed = evaluate(this.state, this.mem);

    // Age out stale events. Previously the queue was emptied unconditionally
    // at the top of the tick, so a red flag or a penalty landing inside the
    // quiet gap was discarded before pick() ever saw it.
    if (this.pendingEvents.length) {
      this.pendingEvents = this.pendingEvents.filter(
        (e) => now - (e.at ?? now) < EVENT_TTL_MS,
      );
    }

    if (this.level === "off" || this.busy || this.speaking) return;
    if (this.engineer.busy) return; // never talk over an answer to the driver

    const cfg = LEVELS[this.level];
    if (now - this.lastCalloutAt < cfg.minGapMs) return;

    const fresh = [...observed, ...this.pendingEvents].filter(
      (c) => now - (c.at ?? now) < FACT_TTL_MS,
    );
    const chosen = pick(fresh, this.level, this.lastFired);
    if (!chosen) return;

    // Only the one we are about to say leaves the queue.
    this.pendingEvents = this.pendingEvents.filter((e) => e !== chosen);

    this.lastFired[chosen.id] = now;
    this.lastCalloutAt = now;

    // Urgent calls skip the model entirely. A canned line now beats a better
    // worded one two seconds later.
    const instant = INSTANT[chosen.id];
    if (instant) {
      this.speak(instant);
      return;
    }

    this.busy = true;
    try {
      const line = await this.engineer.callout(chosen.fact, this.recentLines);
      if (line) {
        this.recentLines = [...this.recentLines, line].slice(-6);
        this.speak(line);
      }
    } finally {
      this.busy = false;
      this.lastCalloutAt = Date.now();
    }
  }
}
