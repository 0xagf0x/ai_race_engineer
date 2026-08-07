// The engineer's brain. Two call paths:
//
//   ask(text)             the driver pressed PTT. Full snapshot, conversation
//                         history, up to a few sentences.
//   callout(fact, recent) the rules engine spotted something. One observation,
//                         no history, tight token budget. Ported from
//                         web/app/api/callout/route.ts.
//
// The old ask() returned null when busy, which silently swallowed the driver's
// question mid-race. Questions now queue behind whatever is in flight.

import { config } from "./config.js";
import { engineerSnapshot } from "./state.js";

const SYSTEM = (
  driver,
) => `You are a professional race engineer on the pit wall, speaking to your driver over team radio mid-session. Your driver is ${driver}.

Rules of the radio:
- Be concise. Real radio messages are 1-3 short sentences. The driver is at 250 km/h.
- Lead with the answer, then the reason if it fits.
- Use the live telemetry snapshot provided with each message. Never invent data that isn't in it. If the data isn't there, say "I don't have that on my screens."
- Speak numbers the way an engineer would: "box this lap", "gap to the car behind is one point four", "fronts are at 105, manage them through the high speed stuff".
- Wheel readings are given in the order front left, front right, rear left, rear right.
- For strategy questions, reason from fuel remaining, tyre wear and age, gaps, the forecast, and laps left. If a pit loss figure is in the snapshot, use it rather than guessing what a stop costs.
- If the coach block shows an upcoming braking zone, you can call it: brake distance, gear, entry speed.
- In practice and qualifying, talk about track position and clear air. In a race, talk about gaps and strategy.
- In GT7 sessions you have no opponent data; be upfront about that if asked about other cars.
- No markdown, no lists, no emoji. Plain spoken sentences only. Your reply is read aloud.`;

const CALLOUT_SYSTEM = (
  driver,
) => `You are ${driver}'s race engineer, speaking unprompted over team radio during a live session.

You are given one factual observation from telemetry. Turn it into a single line of radio, the way a British F1 engineer on the pit wall would say it.

Rules:
- ONE sentence. Under 16 words. This is a quick call while he's driving.
- Say the useful part. No greetings, no "just letting you know", no sign-offs.
- Sound calm and matter of fact. Understatement over drama.
- Use his name sparingly, roughly one call in four.
- Speak numbers the way a person says them out loud: "one twelve four" for a lap time, "two tenths", "a hundred and ten degrees".
- Vary your phrasing. You are given your recent calls; do not repeat their structure or wording.
- Never invent data beyond the observation.

Reply with the radio line only.`;

export class Engineer {
  constructor(state) {
    this.state = state;
    this.history = [];
    this.busy = false;
    this.queue = Promise.resolve();
  }

  async _post({ system, messages, maxTokens }) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        system,
        messages,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(
        "[engineer] anthropic error",
        res.status,
        err.slice(0, 300),
      );
      return null;
    }
    const data = await res.json();
    return (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
  }

  // Driver-initiated. Serialised rather than dropped, so a question asked while
  // the engineer is mid-sentence still gets answered.
  ask(text) {
    if (!config.apiKey) {
      return Promise.resolve(
        "No API key configured. Set ANTHROPIC_API_KEY in .env and restart the bridge.",
      );
    }
    const run = async () => {
      this.busy = true;
      try {
        const snapshot = engineerSnapshot(this.state);
        const userMsg = `LIVE TELEMETRY SNAPSHOT:\n${JSON.stringify(snapshot)}\n\nDRIVER RADIO: ${text}`;
        const reply = await this._post({
          system: SYSTEM(config.driverName),
          messages: [...this.history, { role: "user", content: userMsg }],
          maxTokens: 300,
        });
        if (reply === null) return "Radio's down, say again.";

        // Keep the conversation, but store the driver's words without the
        // snapshot so history doesn't balloon.
        this.history.push({ role: "user", content: `DRIVER RADIO: ${text}` });
        this.history.push({ role: "assistant", content: reply });
        if (this.history.length > 24)
          this.history.splice(0, this.history.length - 24);
        return reply || "Copy.";
      } catch (e) {
        console.error("[engineer]", e.message);
        return "Radio's breaking up, say again.";
      } finally {
        this.busy = false;
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  // Rules-engine initiated. No history, no snapshot dump, just enough session
  // context to make the line sound situated.
  async callout(fact, recent = []) {
    if (!config.apiKey || this.busy) return null;
    this.busy = true;
    try {
      const s = this.state.session ?? {};
      const lap = this.state.player?.lap ?? {};
      const context = [
        s.track ? `Track: ${s.track}` : null,
        s.type ? `Session: ${s.type}` : null,
        lap.position ? `Running P${lap.position}` : null,
        lap.currentLapNum
          ? `Lap ${lap.currentLapNum}${s.totalLaps ? ` of ${s.totalLaps}` : ""}`
          : null,
      ]
        .filter(Boolean)
        .join(". ");

      const line = await this._post({
        system: CALLOUT_SYSTEM(config.driverName),
        messages: [
          {
            role: "user",
            content:
              `${context ? `Context: ${context}\n` : ""}Observation: ${fact}\n\n` +
              `Your recent calls (do not repeat these):\n${
                recent
                  .slice(-5)
                  .map((r) => `- ${r}`)
                  .join("\n") || "- none yet"
              }`,
          },
        ],
        maxTokens: 80,
      });
      if (!line) return null;

      // Unprompted calls still belong in the conversation, otherwise the driver
      // asking "say again?" gets a blank look.
      this.history.push({ role: "assistant", content: line });
      if (this.history.length > 24)
        this.history.splice(0, this.history.length - 24);
      return line.replace(/^["']|["']$/g, "");
    } catch (e) {
      console.error("[engineer] callout", e.message);
      return null;
    } finally {
      this.busy = false;
    }
  }

  reset() {
    this.history = [];
  }
}
