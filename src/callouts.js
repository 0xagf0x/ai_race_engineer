// Automatic engineer callouts, template-based for zero latency.
// Each fires at most once per condition, rate-limited globally.

export class Callouts {
  constructor(state, speak) {
    this.state = state;
    this.speak = speak; // (text) => void  broadcasts + TTS in the browser
    this.lastAt = 0;
    this.fired = new Set();
    this.lastLapNum = null;
  }

  _say(key, text, cooldownKeySuffix = "") {
    const k = key + cooldownKeySuffix;
    const now = Date.now();
    if (this.fired.has(k) || now - this.lastAt < 8000) return;
    this.fired.add(k);
    this.lastAt = now;
    this.speak(text);
  }

  tick() {
    const p = this.state.player;
    if (!p?.status) return;
    const lap = p.lap?.currentLapNum;

    // reset per-lap keys on new lap
    if (lap !== this.lastLapNum) {
      this.lastLapNum = lap;
      for (const k of [...this.fired]) if (k.startsWith("lap:")) this.fired.delete(k);
    }

    const fuel = p.status.fuelRemainingLaps;
    if (fuel != null && fuel > 0 && fuel < 2.5) {
      this._say("fuel-critical", `Fuel is critical, ${fuel.toFixed(1)} laps remaining. We need to box or lift and coast.`);
    }

    const wear = p.damage?.tyreWear;
    if (wear) {
      const worst = Math.max(...wear);
      if (worst > 75) this._say("tyre-75", `Tyres are gone, worst corner at ${Math.round(worst)} percent wear. Box when you can.`);
      else if (worst > 55) this._say("tyre-55", `Tyre wear at ${Math.round(worst)} percent on the worst corner. Start thinking about the stop.`);
    }

    if (this.state.game === "f1" && p.status.drsAllowed) {
      this._say("drs-enabled", "DRS is enabled.");
    }

    // Gap pressure (F1 only)
    const me = this.state.opponents.find((o) => o.isPlayer);
    if (me && me.position > 1 && me.deltaAheadMs > 0 && me.deltaAheadMs < 800) {
      this._say("lap:attack", `Car ahead is inside eight tenths, DRS range. Let's have him.`);
    }
  }

  onEvent(ev, resolveName) {
    switch (ev.code) {
      case "FTLP": {
        const name = resolveName?.(ev.vehicleIdx) ?? "someone";
        this._say(`ftlp-${ev.vehicleIdx}-${Math.round(ev.lapTime)}`, `Fastest lap of the session, ${name}.`);
        break;
      }
      case "PENA": {
        this._say(`pena-${Date.now()}`, `Penalty flagged. Keep it clean.`);
        break;
      }
      case "CHQF":
        this._say("chqf", "Chequered flag, chequered flag. Good job today.");
        break;
    }
  }
}
