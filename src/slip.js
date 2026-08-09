// src/slip.js
// Wheelspin detection.
//
// Neither game gives us a clean signal on the packets we currently read. F1
// sends per wheel slip in the Motion packet, but past fields whose offsets we
// have not verified against real bytes, and GT7 sends nothing at all on the
// "A" heartbeat. So this infers it instead: wheelspin is throttle applied
// without the speed responding.
//
// The inference is deliberately conservative. A false beep out of every slow
// corner trains the driver to ignore it, which is worse than missing some
// genuine slip. When the F1 Motion offsets are confirmed, F1 should switch to
// the real signal and this stays as the GT7 path.

const THROTTLE_ON = 0.6; // below this, any bogging is not wheelspin
const MIN_SPEED_KPH = 15; // standing starts are their own thing
const SUSTAIN_MS = 200; // a single noisy frame is not a slide
const REARM_MS = 800; // one beep per event, not per frame

// Expected acceleration in m/s2 at full throttle, by speed. Falls away as drag
// and gearing take over, so a car at 250 kph accelerating at 1 m/s2 is normal
// while the same figure at 60 kph means the rears are spinning.
function expectedAccel(speedKph) {
  if (speedKph < 60) return 6;
  if (speedKph < 120) return 4;
  if (speedKph < 200) return 2.5;
  return 1.2;
}

export class SlipDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this._lastSpeed = null;
    this._lastAt = 0;
    this._slipSince = 0;
    this._lastFiredAt = 0;
    this.slipping = false;
  }

  /**
   * One telemetry sample. Returns true on the rising edge of a slip event,
   * which is the moment worth a tone.
   *
   * @param {number} speedKph
   * @param {number} throttle 0..1
   * @param {number} now
   */
  update(speedKph, throttle, now = Date.now()) {
    this.slipping = false;
    if (!Number.isFinite(speedKph) || !Number.isFinite(throttle)) return false;

    const dt = (now - this._lastAt) / 1000;
    const prev = this._lastSpeed;
    this._lastSpeed = speedKph;
    this._lastAt = now;

    // A gap in the samples makes the derivative meaningless: a pause, a
    // flashback, or a dropped packet would read as violent deceleration.
    if (prev == null || dt <= 0 || dt > 0.5) {
      this._slipSince = 0;
      return false;
    }

    if (throttle < THROTTLE_ON || speedKph < MIN_SPEED_KPH) {
      this._slipSince = 0;
      return false;
    }

    const accel = (speedKph - prev) / 3.6 / dt;
    const expected = expectedAccel(speedKph) * throttle;

    // Under a third of what the throttle should be producing, and not braking
    // or lifting, means the drive is going into rotation rather than forward.
    const suspect = accel < expected * 0.33;
    if (!suspect) {
      this._slipSince = 0;
      return false;
    }

    if (!this._slipSince) this._slipSince = now;
    if (now - this._slipSince < SUSTAIN_MS) return false;

    this.slipping = true;
    if (now - this._lastFiredAt < REARM_MS) return false;
    this._lastFiredAt = now;
    return true;
  }

  /**
   * Real slip ratio, when the game gives us one. A wheel turning meaningfully
   * faster than road speed is wheelspin, no inference required.
   *
   * Wheel order is RL RR FL FR in the wire format; state.js normalises
   * elsewhere but this reads raw, so the rears are indices 0 and 1.
   */
  fromSlipRatio(slipRatio, throttle, speedKph, now = Date.now()) {
    this.slipping = false;
    if (!Array.isArray(slipRatio) || slipRatio.length < 4) return false;
    if (throttle < THROTTLE_ON || speedKph < MIN_SPEED_KPH) {
      this._slipSince = 0;
      return false;
    }

    // Positive ratio is the wheel outrunning the road. Fifteen percent over is
    // past what traction gives you and into smoke.
    const worst = Math.max(slipRatio[0], slipRatio[1]);
    if (worst < 0.15) {
      this._slipSince = 0;
      return false;
    }

    if (!this._slipSince) this._slipSince = now;
    if (now - this._slipSince < SUSTAIN_MS) return false;

    this.slipping = true;
    if (now - this._lastFiredAt < REARM_MS) return false;
    this._lastFiredAt = now;
    return true;
  }
}
