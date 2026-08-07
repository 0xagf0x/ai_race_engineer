// The engineer's brain. Every radio message goes to Claude with a live
// telemetry snapshot injected, so it answers from real data.

import { config } from "./config.js";
import { engineerSnapshot } from "./state.js";

const SYSTEM = `You are a professional race engineer on the pit wall, speaking to your driver over team radio mid-session. Your driver is Charlie.

Rules of the radio:
- Be concise. Real radio messages are 1-3 short sentences. The driver is at 250 km/h.
- Lead with the answer, then the reason if it fits.
- Use the live telemetry snapshot provided with each message. Never invent data that isn't in it. If the data isn't there, say "I don't have that on my screens."
- Speak numbers the way an engineer would: "box this lap", "gap to the car behind is one point four", "fronts are at 105, manage them through the high speed stuff".
- For strategy questions, reason from fuel remaining, tyre wear/age, gaps, weather, and laps left.
- If the coach block shows an upcoming braking zone, you can call it: brake distance, gear, entry speed.
- In GT7 sessions you have no opponent data; be upfront about that if asked about other cars.
- No markdown, no lists, no emoji. Plain spoken sentences only. Your reply is read aloud via TTS.`;

export class Engineer {
  constructor(state) {
    this.state = state;
    this.history = []; // {role, content}
    this.busy = false;
  }

  async ask(text) {
    if (!config.apiKey) {
      return "No API key configured. Set ANTHROPIC_API_KEY in .env and restart the bridge.";
    }
    if (this.busy) return null;
    this.busy = true;
    try {
      const snapshot = engineerSnapshot(this.state);
      const userMsg = `LIVE TELEMETRY SNAPSHOT:\n${JSON.stringify(snapshot)}\n\nDRIVER RADIO: ${text}`;

      const messages = [...this.history, { role: "user", content: userMsg }];

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 300,
          system: SYSTEM,
          messages,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error("Anthropic API error:", res.status, err.slice(0, 300));
        return "Radio's down, say again. (API error — check the bridge console.)";
      }

      const data = await res.json();
      const reply = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();

      // Keep the conversation, but store the driver's words without the big snapshot
      this.history.push({ role: "user", content: `DRIVER RADIO: ${text}` });
      this.history.push({ role: "assistant", content: reply });
      if (this.history.length > 24) this.history.splice(0, this.history.length - 24);

      return reply || "Copy.";
    } catch (e) {
      console.error("Engineer error:", e.message);
      return "Radio's breaking up, say again.";
    } finally {
      this.busy = false;
    }
  }

  reset() { this.history = []; }
}
