"use client";
import type { Snapshot } from "./types";
import { fmtLap } from "./types";

// Rules engine for continuous feedback. Runs a few times a second against the
// live snapshot and returns candidate observations. The picker in RadioPanel
// chooses the highest-priority candidate that isn't on cooldown, then Claude
// phrases it as radio. Nothing here calls the API directly.

export type FeedbackLevel = "off" | "low" | "medium" | "high";

export interface Candidate {
  id: string;          // dedupe/cooldown key
  priority: number;    // 1 = chatter, 2 = useful, 3 = important, 4 = urgent
  fact: string;        // plain observation handed to Claude to voice
  cooldownMs: number;  // minimum gap before this id can fire again
}

export const LEVELS: Record<Exclude<FeedbackLevel, "off">, { minGapMs: number; minPriority: number; label: string }> = {
  low:    { minGapMs: 45000, minPriority: 3, label: "Low · key moments only" },
  medium: { minGapMs: 18000, minPriority: 2, label: "Medium · regular updates" },
  high:   { minGapMs: 7000,  minPriority: 1, label: "High · constant coaching" },
};

export interface CoachMemory {
  lastLapSeen: number;
  bestLapMs: number;
  lastPosition: number;
  lastCornerTs: number;
  lastFuelWarnLap: number;
}

export const freshMemory = (): CoachMemory => ({
  lastLapSeen: -1,
  bestLapMs: 0,
  lastPosition: -1,
  lastCornerTs: 0,
  lastFuelWarnLap: -1,
});

const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

export function evaluate(snap: Snapshot, mem: CoachMemory): Candidate[] {
  const out: Candidate[] = [];
  const p = snap.player;
  const s = snap.session;

  // --- lap pace ---
  if (p.currentLapNum != null && p.currentLapNum !== mem.lastLapSeen) {
    if (mem.lastLapSeen > 0 && p.lastLapTimeMs && p.lastLapTimeMs > 0) {
      const lap = p.lastLapTimeMs;
      if (mem.bestLapMs === 0 || lap < mem.bestLapMs) {
        const improvement = mem.bestLapMs ? ((mem.bestLapMs - lap) / 1000).toFixed(1) : null;
        out.push({
          id: "lap_best",
          priority: 3,
          cooldownMs: 0,
          fact: `personal best lap ${fmtLap(lap)}${improvement ? `, ${improvement}s quicker than the previous best` : ""}`,
        });
        mem.bestLapMs = lap;
      } else {
        const delta = ((lap - mem.bestLapMs) / 1000).toFixed(1);
        out.push({
          id: "lap_pace",
          priority: 3,
          cooldownMs: 0,
          fact: `lap ${mem.lastLapSeen} in ${fmtLap(lap)}, ${delta}s off the best of ${fmtLap(mem.bestLapMs)}`,
        });
      }
    }
    mem.lastLapSeen = p.currentLapNum;
  }

  // --- position changes ---
  if (p.position != null && p.position > 0) {
    if (mem.lastPosition > 0 && p.position !== mem.lastPosition) {
      const gained = p.position < mem.lastPosition;
      out.push({
        id: "position",
        priority: 3,
        cooldownMs: 3000,
        fact: `${gained ? "gained" : "lost"} a place, now P${p.position}`,
      });
    }
    mem.lastPosition = p.position;
  }

  // --- corner feedback from the bridge's reference comparison ---
  const c = snap.coaching;
  if (c?.lastCornerFeedback && c.lastCornerTs && c.lastCornerTs !== mem.lastCornerTs) {
    mem.lastCornerTs = c.lastCornerTs;
    const onRef = c.lastCornerFeedback.includes("on reference");
    if (!onRef) {
      out.push({
        id: "corner",
        priority: 1,
        cooldownMs: 6000,
        fact: c.lastCornerFeedback,
      });
    }
  }

  // --- upcoming braking zone (only when actually approaching it) ---
  if (c?.nextZone && p.speedKph > 80) {
    const d = c.nextZone.distanceToBrakePointM;
    if (d > 60 && d < 260) {
      out.push({
        id: "next_corner",
        priority: 1,
        cooldownMs: 5000,
        fact: `corner ${c.nextZone.cornerIndex} coming up in ${d}m: reference is gear ${c.nextZone.gear}, minimum ${c.nextZone.minSpeedKph} kph`,
      });
    }
  }

  // --- fuel ---
  if (p.fuelRemainingLaps != null) {
    if (p.fuelRemainingLaps < 0.5) {
      out.push({ id: "fuel_critical", priority: 4, cooldownMs: 20000, fact: `fuel critical, under half a lap of margin` });
    } else if (p.fuelRemainingLaps < 2) {
      out.push({ id: "fuel_low", priority: 3, cooldownMs: 60000, fact: `fuel margin down to ${p.fuelRemainingLaps.toFixed(1)} laps` });
    }
  } else if (p.fuelLevel != null && p.fuelCapacity) {
    const pct = (p.fuelLevel / p.fuelCapacity) * 100;
    if (pct < 8) out.push({ id: "fuel_critical", priority: 4, cooldownMs: 20000, fact: `fuel at ${pct.toFixed(0)} percent` });
    else if (pct < 20) out.push({ id: "fuel_low", priority: 3, cooldownMs: 60000, fact: `fuel at ${pct.toFixed(0)} percent` });
  }

  // --- tyres ---
  const temps = p.tyres.surfaceTempC;
  if (temps.some((t) => t > 0)) {
    const hottest = Math.max(...temps);
    const coldest = Math.min(...temps);
    const names = ["front left", "front right", "rear left", "rear right"];
    if (hottest > 115) {
      out.push({ id: "tyre_hot", priority: 3, cooldownMs: 40000, fact: `${names[temps.indexOf(hottest)]} tyre at ${Math.round(hottest)} degrees, overheating` });
    } else if (hottest > 105) {
      out.push({ id: "tyre_warm", priority: 2, cooldownMs: 60000, fact: `${names[temps.indexOf(hottest)]} running warm at ${Math.round(hottest)} degrees` });
    } else if (coldest < 65 && avg(temps) < 75) {
      out.push({ id: "tyre_cold", priority: 2, cooldownMs: 60000, fact: `tyres still cold, averaging ${Math.round(avg(temps))} degrees` });
    }
    const spread = hottest - coldest;
    if (spread > 25) {
      out.push({ id: "tyre_balance", priority: 2, cooldownMs: 90000, fact: `${Math.round(spread)} degree spread across the tyres, hottest is ${names[temps.indexOf(hottest)]}` });
    }
  }
  if (p.tyres.wearPct) {
    const worst = Math.max(...p.tyres.wearPct);
    if (worst > 60) out.push({ id: "tyre_wear", priority: 3, cooldownMs: 90000, fact: `tyre wear up to ${worst} percent after ${p.tyres.ageLaps ?? "?"} laps on ${p.tyres.compound ?? "these"}` });
  }

  // --- gaps and traffic (F1 only) ---
  const me = snap.opponents.find((o) => o.isPlayer);
  if (me) {
    const ahead = snap.opponents.find((o) => o.position === me.position - 1);
    const behind = snap.opponents.find((o) => o.position === me.position + 1);
    if (ahead?.gapToPlayerMs != null) {
      const gap = ahead.gapToPlayerMs / 1000;
      if (gap < 1) {
        out.push({ id: "drs_range", priority: 3, cooldownMs: 15000, fact: `${ahead.name} is ${gap.toFixed(1)}s ahead, inside DRS range` });
      } else if (gap < 3) {
        out.push({ id: "gap_ahead", priority: 2, cooldownMs: 25000, fact: `closing on ${ahead.name}, ${gap.toFixed(1)}s ahead` });
      }
    }
    if (behind?.gapToPlayerMs != null) {
      const gap = Math.abs(behind.gapToPlayerMs) / 1000;
      if (gap < 1.2) {
        out.push({ id: "under_pressure", priority: 3, cooldownMs: 15000, fact: `${behind.name} is ${gap.toFixed(1)}s behind and in range` });
      }
    }
    const pitting = snap.opponents.filter(
      (o) => !o.isPlayer && (o.pitStatus === "pitting" || o.pitStatus === "in_pit_area")
    );
    if (pitting.length) {
      out.push({ id: "rivals_pit", priority: 3, cooldownMs: 30000, fact: `${pitting.map((o) => o.name).join(", ")} in the pits` });
    }
  }

  // --- car condition ---
  if (p.damage) {
    const dmg = Object.entries(p.damage).filter(([, v]) => (v ?? 0) > 10);
    if (dmg.length) {
      out.push({ id: "damage", priority: 4, cooldownMs: 60000, fact: `damage reported: ${dmg.map(([k, v]) => `${k.replace("Pct", "")} ${v}%`).join(", ")}` });
    }
  }
  if (p.ersStoreEnergyPct != null && p.ersStoreEnergyPct < 15) {
    out.push({ id: "ers_low", priority: 2, cooldownMs: 45000, fact: `ERS store down to ${p.ersStoreEnergyPct} percent` });
  }
  if (p.engineTempC != null && p.engineTempC > 120) {
    out.push({ id: "engine_hot", priority: 3, cooldownMs: 60000, fact: `engine temperature ${p.engineTempC} degrees` });
  }
  if (p.penaltiesSec != null && p.penaltiesSec > 0) {
    out.push({ id: "penalty", priority: 4, cooldownMs: 60000, fact: `${p.penaltiesSec} seconds of penalties outstanding` });
  }
  if (s.safetyCar && s.safetyCar !== "none") {
    out.push({ id: "safety_car", priority: 4, cooldownMs: 30000, fact: `${s.safetyCar === "virtual" ? "virtual safety car" : "safety car"} deployed` });
  }

  // --- strategy prompt near the stint window ---
  if (s.totalLaps && p.currentLapNum && p.tyres.ageLaps != null) {
    const remaining = s.totalLaps - p.currentLapNum;
    if (remaining > 2 && p.tyres.ageLaps > 12) {
      out.push({
        id: "stint_window",
        priority: 2,
        cooldownMs: 120000,
        fact: `${p.tyres.ageLaps} laps on this set with ${remaining} to go, worth thinking about the stop`,
      });
    }
  }

  return out;
}

export function pick(candidates: Candidate[], level: Exclude<FeedbackLevel, "off">, lastFired: Record<string, number>): Candidate | null {
  const cfg = LEVELS[level];
  const now = Date.now();
  const eligible = candidates
    .filter((c) => c.priority >= cfg.minPriority)
    .filter((c) => now - (lastFired[c.id] ?? 0) >= c.cooldownMs)
    .sort((a, b) => b.priority - a.priority);
  return eligible[0] ?? null;
}
