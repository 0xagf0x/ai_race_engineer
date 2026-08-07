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
  low: { minGapMs: 45000, minPriority: 3, label: "Low, key moments only" },
  medium: { minGapMs: 18000, minPriority: 2, label: "Medium, regular updates" },
  high: { minGapMs: 7000, minPriority: 1, label: "High, constant coaching" },
};

// Urgent calls that go out instantly as canned lines rather than waiting on a
// model round trip. Anything the driver needs to act on inside a corner belongs
// here; everything else is worth the latency to have phrased properly.
const INSTANT = {
  safety_car: "Safety car, safety car.",
  fuel_critical: "Fuel critical. Lift and coast, now.",
  chequered: "Chequered flag. Good job.",
};

export const freshMemory = () => ({
  lastLapSeen: -1,
  bestLapMs: 0,
  lastPosition: -1,
  lastCornerTs: 0,
  lastSafetyCar: "none",
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
      cooldownMs: 5000,
      fact: `braking zone in ${c.brakeInM} metres, reference is gear ${c.gear} and ${c.minSpeedKph} kph minimum`,
    });
  }

  // --- fuel ---
  if (st.fuelRemainingLaps != null) {
    if (st.fuelRemainingLaps < 0.5) {
      out.push({
        id: "fuel_critical",
        priority: 4,
        cooldownMs: 20000,
        fact: "fuel critical, under half a lap of margin",
      });
    } else if (st.fuelRemainingLaps < 2) {
      out.push({
        id: "fuel_low",
        priority: 3,
        cooldownMs: 60000,
        fact: `fuel margin down to ${st.fuelRemainingLaps.toFixed(1)} laps`,
      });
    }
  } else if (st.fuelInTank != null && st.fuelCapacity) {
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
    if (hottest > 115) {
      out.push({
        id: "tyre_hot",
        priority: 3,
        cooldownMs: 40000,
        fact: `${where} tyre at ${Math.round(hottest)} degrees, overheating`,
      });
    } else if (hottest > 105) {
      out.push({
        id: "tyre_warm",
        priority: 2,
        cooldownMs: 60000,
        fact: `${where} running warm at ${Math.round(hottest)} degrees`,
      });
    } else if (coldest < 65 && avg(temps) < 75) {
      out.push({
        id: "tyre_cold",
        priority: 2,
        cooldownMs: 60000,
        fact: `tyres still cold, averaging ${Math.round(avg(temps))} degrees`,
      });
    }
    if (hottest - coldest > 25) {
      out.push({
        id: "tyre_balance",
        priority: 2,
        cooldownMs: 90000,
        fact: `${Math.round(hottest - coldest)} degree spread across the tyres, hottest is the ${where}`,
      });
    }
  }
  const wear = p.damage?.tyreWear;
  if (wear?.length) {
    const worst = Math.max(...wear);
    if (worst > 60) {
      out.push({
        id: "tyre_wear",
        priority: 3,
        cooldownMs: 90000,
        fact: `tyre wear up to ${Math.round(worst)} percent on the ${WHEELS[wear.indexOf(worst)]} after ${st.tyreAgeLaps ?? "?"} laps on the ${st.tyre ?? "current set"}`,
      });
    }
  }

  out.push(...gapRules(state));

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
  if (st.ersStorePct != null && st.ersStorePct < 15) {
    out.push({
      id: "ers_low",
      priority: 2,
      cooldownMs: 45000,
      fact: `energy store down to ${st.ersStorePct} percent in ${st.ersDeployMode || "current"} mode`,
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
  if (lap.penalties > 0) {
    out.push({
      id: "penalty",
      priority: 4,
      cooldownMs: 60000,
      fact: `${lap.penalties} seconds of penalties outstanding`,
    });
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

  // --- stint window ---
  if (s.totalLaps && lap.currentLapNum && st.tyreAgeLaps != null) {
    const remaining = s.totalLaps - lap.currentLapNum;
    if (remaining > 2 && st.tyreAgeLaps > 12) {
      out.push({
        id: "stint_window",
        priority: 2,
        cooldownMs: 120000,
        fact: `${st.tyreAgeLaps} laps on this set with ${remaining} to go${s.pitLossSec ? `, a stop here costs about ${s.pitLossSec} seconds` : ""}`,
      });
    }
  }

  return out;
}

// Gaps come from the delta-to-car-in-front chain, which is what the F1 feed
// actually sends. My gap to the car ahead is my own deltaAheadMs; the gap to the
// car behind is that car's deltaAheadMs.
function gapRules(state) {
  const out = [];
  const me = state.opponents?.find((o) => o.isPlayer);
  if (!me) return out;

  const ahead = state.opponents.find((o) => o.position === me.position - 1);
  const behind = state.opponents.find((o) => o.position === me.position + 1);

  if (ahead && me.deltaAheadMs > 0) {
    const gap = me.deltaAheadMs / 1000;
    if (gap < 1) {
      out.push({
        id: "drs_range",
        priority: 3,
        cooldownMs: 15000,
        fact: `${ahead.name} is ${gap.toFixed(1)} ahead, inside DRS range`,
      });
    } else if (gap < 3) {
      out.push({
        id: "gap_ahead",
        priority: 2,
        cooldownMs: 25000,
        fact: `closing on ${ahead.name}, ${gap.toFixed(1)} ahead`,
      });
    }
  }
  if (behind?.deltaAheadMs > 0) {
    const gap = behind.deltaAheadMs / 1000;
    if (gap < 1.2) {
      out.push({
        id: "under_pressure",
        priority: 3,
        cooldownMs: 15000,
        fact: `${behind.name} is ${gap.toFixed(1)} behind and in range`,
      });
    }
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
  }

  setLevel(level) {
    if (level === "off" || LEVELS[level]) this.level = level;
  }

  // Race events arrive out of band; queue them as one-shot candidates so they
  // go through the same priority and cooldown gate as everything else.
  onEvent(ev, resolveName) {
    switch (ev.code) {
      case "FTLP":
        this.pendingEvents.push({
          id: `ftlp_${ev.vehicleIdx}`,
          priority: 2,
          cooldownMs: 10000,
          fact: `fastest lap of the session set by ${resolveName?.(ev.vehicleIdx) ?? "someone"}`,
        });
        break;
      case "OVTK": {
        const me = this.state.opponents?.find((o) => o.isPlayer);
        if (me && ev.overtakenVehicleIdx === me.idx) {
          this.pendingEvents.push({
            id: "overtaken",
            priority: 3,
            cooldownMs: 8000,
            fact: `${resolveName?.(ev.overtakingVehicleIdx) ?? "a car"} has gone past`,
          });
        }
        break;
      }
      case "PENA":
        this.pendingEvents.push({
          id: `pena_${Date.now()}`,
          priority: 4,
          cooldownMs: 0,
          fact: "a penalty has been flagged",
        });
        break;
      case "CHQF":
        this.speak(INSTANT.chequered);
        break;
      case "RDFL":
        this.pendingEvents.push({
          id: "red_flag",
          priority: 4,
          cooldownMs: 0,
          fact: "red flag, session stopped",
        });
        break;
    }
  }

  async tick() {
    if (this.level === "off" || this.busy) return;
    if (this.engineer.busy) return; // never talk over an answer to the driver

    const now = Date.now();
    const cfg = LEVELS[this.level];
    const candidates = [
      ...evaluate(this.state, this.mem),
      ...this.pendingEvents,
    ];
    this.pendingEvents = [];

    // Keep evaluating during the quiet gap so best lap and position memory stay
    // current, but only actually speak once the gap has elapsed.
    if (now - this.lastCalloutAt < cfg.minGapMs) return;

    const chosen = pick(candidates, this.level, this.lastFired);
    if (!chosen) return;

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
