// Race arc: the engineer's memory and emotional read of the session.
//
// The snapshot in state.js is a photograph. This is the film. It answers the
// questions a real engineer answers without thinking about it:
//   what just happened to me, and why
//   am I going forwards or backwards, and over what timescale
//   is my pace the problem, or is it something else
//   is this a good day or a salvage job
//
// Everything here is derived, cheap, and lives in memory. Nothing is persisted
// yet; that comes with the post-session debrief.

const LOG_MAX = 40;
const RECENT_LAPS = 6; // window for the position trend

export class RaceArc {
  constructor() {
    this.log = []; // rolling notable events, newest last
    this.positions = []; // {lap, position}
    this.lapTimes = []; // {lap, ms, invalid}
    this.startPosition = null;
    this.bestLapMs = 0;
    this.lastLapSeen = -1;
    this.lastPosition = null;
    this.penalties = []; // described PENA events
  }

  reset() {
    const fresh = new RaceArc();
    Object.assign(this, fresh);
  }

  /** Record something worth remembering. kind is used for filtering, text is what the engineer reads. */
  note(kind, text, extra = {}) {
    this.log.push({
      kind,
      text,
      lap: this.currentLap ?? null,
      ts: Date.now(),
      at: this._sessionTime ?? 0,
      ...extra,
    });
    if (this.log.length > LOG_MAX) this.log.shift();
  }

  notePenalty(described) {
    this.penalties.push({ ...described, at: this._sessionTime ?? 0 });
    this.note("penalty", `picked up ${described.text}`, {
      blameless: described.blameless,
    });
  }

  /** Called from the broadcast loop with the live state. */
  update(state) {
    const lap = state.player?.lap;
    if (!lap?.currentLapNum) return;
    this.currentLap = lap.currentLapNum;
    this._sessionTime = state.sessionTime ?? 0;

    if (this.startPosition == null && lap.gridPosition > 0) {
      this.startPosition = lap.gridPosition;
    }

    // position changes, recorded the moment they happen rather than per lap
    if (lap.position > 0) {
      if (this.lastPosition && lap.position !== this.lastPosition) {
        const gained = lap.position < this.lastPosition;
        this.note(
          gained ? "overtake" : "lost_place",
          `${gained ? "gained" : "lost"} a place, P${this.lastPosition} to P${lap.position}`,
        );
      }
      this.lastPosition = lap.position;
    }

    // per-lap bookkeeping
    if (lap.currentLapNum !== this.lastLapSeen) {
      if (this.lastLapSeen > 0 && lap.lastLapMs > 0) {
        this.lapTimes.push({
          lap: this.lastLapSeen,
          ms: lap.lastLapMs,
          invalid: false,
        });
        if (this.lapTimes.length > 60) this.lapTimes.shift();
        if (!this.bestLapMs || lap.lastLapMs < this.bestLapMs)
          this.bestLapMs = lap.lastLapMs;
      }
      if (lap.position > 0) {
        this.positions.push({ lap: lap.currentLapNum, position: lap.position });
        if (this.positions.length > 60) this.positions.shift();
      }
      this.lastLapSeen = lap.currentLapNum;
    }
  }

  // --- derived reads ---

  /** Places gained or lost over the recent window. Positive means moving forward. */
  positionTrend() {
    if (this.positions.length < 2) return 0;
    const window = this.positions.slice(-RECENT_LAPS);
    return window[0].position - window[window.length - 1].position;
  }

  /** Places gained or lost since the start. */
  netFromStart() {
    if (this.startPosition == null || this.lastPosition == null) return 0;
    return this.startPosition - this.lastPosition;
  }

  /**
   * Is the driver's own pace the problem? Compares the last few laps to their
   * best. This is the difference between "you're slipping, dig in" and
   * "you're slipping but you're still quick, it's the tyres".
   */
  paceTrend() {
    const valid = this.lapTimes.filter((l) => l.ms > 0).slice(-3);
    if (valid.length < 2 || !this.bestLapMs) return null;
    const avg = valid.reduce((a, l) => a + l.ms, 0) / valid.length;
    const offBestMs = avg - this.bestLapMs;
    return {
      offBestMs: Math.round(offBestMs),
      offBestSec: +(offBestMs / 1000).toFixed(2),
      // Within three tenths of your own best is still driving well.
      strong: offBestMs < 300,
      fading: offBestMs > 800,
    };
  }

  /** Close battles at either end change how much the engineer should be talking. */
  battle(state) {
    const me = state.opponents?.find((o) => o.isPlayer);
    if (!me) return null;
    const ahead = state.opponents.find((o) => o.position === me.position - 1);
    const behind = state.opponents.find((o) => o.position === me.position + 1);
    const gapAhead = me.deltaAheadMs > 0 ? me.deltaAheadMs / 1000 : null;
    const gapBehind =
      behind?.deltaAheadMs > 0 ? behind.deltaAheadMs / 1000 : null;
    return {
      ahead: ahead ? { name: ahead.name, gapSec: gapAhead } : null,
      behind: behind ? { name: behind.name, gapSec: gapBehind } : null,
      attacking: gapAhead != null && gapAhead < 1.5,
      defending: gapBehind != null && gapBehind < 1.5,
      clearAir:
        (gapAhead == null || gapAhead > 4) &&
        (gapBehind == null || gapBehind > 4),
    };
  }

  /**
   * The single word that sets the engineer's tone. Everything above feeds this.
   * Order matters: the most emotionally significant read wins.
   */
  mood(state) {
    const lap = state.player?.lap ?? {};
    const s = state.session ?? {};
    const trend = this.positionTrend();
    const pace = this.paceTrend();
    const b = this.battle(state);
    const lapsLeft =
      s.totalLaps && lap.currentLapNum ? s.totalLaps - lap.currentLapNum : null;

    if (s.mode === "quali") return "quali";
    if (s.mode === "practice") return "practice";
    if (lap.resultStatus === "Retired" || lap.resultStatus === "DNF")
      return "retired";
    if (s.safetyCar && s.safetyCar !== "none") return "neutralised";

    // A recent penalty or heavy contact reframes everything for a while.
    const recentTrouble = this.log
      .slice(-4)
      .some((e) => e.kind === "penalty" || e.kind === "incident");
    if (recentTrouble) return "salvage";

    if (lapsLeft != null && lapsLeft <= 3 && (b?.attacking || b?.defending))
      return "endgame";
    if (trend >= 2) return "charging";
    if (trend <= -2) return "slipping";
    if (b?.attacking) return "attacking";
    if (b?.defending) return "defending";
    if (b?.clearAir) return "cruising";
    return "steady";
  }

  /**
   * Compact narrative block for the engineer prompt. This is what turns
   * "you're P11" into "you were P8 six laps ago and your pace is still there".
   */
  brief(state) {
    const pace = this.paceTrend();
    const b = this.battle(state);
    const trend = this.positionTrend();
    const net = this.netFromStart();

    return {
      mood: this.mood(state),
      startedP: this.startPosition,
      netPlaces: net,
      trendLastLaps: trend,
      pace: pace
        ? {
            offOwnBestSec: pace.offBestSec,
            strong: pace.strong,
            fading: pace.fading,
          }
        : null,
      battle: b
        ? {
            ahead: b.ahead?.name
              ? `${b.ahead.name} ${b.ahead.gapSec?.toFixed(1) ?? "?"}s ahead`
              : null,
            behind: b.behind?.name
              ? `${b.behind.name} ${b.behind.gapSec?.toFixed(1) ?? "?"}s behind`
              : null,
          }
        : null,
      outstandingPenalties: this.penalties.map((p) => p.text),
      recentEvents: this.log
        .slice(-8)
        .map((e) => (e.lap ? `lap ${e.lap}: ${e.text}` : e.text)),
    };
  }

  /**
   * Undo a flashback. The contact that was rewound away did not happen, and an
   * engineer who keeps bringing it up is describing a race the driver did not
   * drive.
   */
  rewindTo(sessionTime) {
    this.log = this.log.filter((e) => (e.at ?? 0) <= sessionTime);
    this.penalties = this.penalties.filter((p) => (p.at ?? 0) <= sessionTime);

    // Lap times and positions are not stamped individually, so they are cut by
    // the lap the rewind landed on rather than by time.
    if (this.currentLap != null) {
      this.lapTimes = this.lapTimes.filter((l) => l.lap < this.currentLap);
      this.positions = this.positions.filter((p) => p.lap < this.currentLap);
    }

    // The best lap has to be recomputed: it may have been set on a lap that no
    // longer exists.
    this.bestLapMs = this.lapTimes.reduce(
      (best, l) => (l.ms > 0 && (!best || l.ms < best) ? l.ms : best),
      0,
    );
    this.lastLapSeen = -1;
    this.lastPosition = null;
  }
}

// How the engineer should sound in each mood. Kept here rather than in the
// prompt string so it can be tuned without touching the rest of the persona.
export const MOOD_DIRECTION = {
  charging:
    "He is moving forward. Be energised. Short, urgent, feed the momentum. Name who is next.",
  slipping:
    "He is losing places. Do not pile on and do not go quiet, which reads as disappointment. Give him one concrete thing to hold onto: his own pace if it is still there, or the reason if it isn't. Keep him in the fight.",
  attacking:
    "He is closing on a car. Clipped and useful. Where the other car is weak, when to make the move.",
  defending:
    "Someone is on him. Calm, protective, precise. Where to cover, how long until the pressure eases.",
  salvage:
    "Something has just gone wrong. Steady and matter of fact, no blame, no drama. Tell him what it costs and what the plan is now. One short reassurance at most, then straight to business.",
  endgame: "Final laps of a fight. Tight, urgent, every word earns its place.",
  neutralised:
    "Under caution. Procedural and calm. Delta, position, what happens at the restart.",
  cruising:
    "Clear air. Talk less. Tyres, fuel, pace management. Let him drive.",
  steady: "Nothing dramatic. Normal working tone.",
  quali:
    "Qualifying. Track position, clear air, when to start the lap, when to push.",
  practice: "Practice. Programme focused. Technique, reference laps, run plan.",
  retired: "He is out. Brief, human, no analysis unless he asks for it.",
};
