// The engineer's brain. Four call paths, cheapest first:
//
//   callout(fact, recent)  rules engine spotted something. One line, no history.
//   ask(text)              driver keyed the radio. Snapshot, arc, conversation.
//   openSession(priors)    arriving at a circuit he has been to before.
//   debrief(record)        after the flag. The only place he talks at length.
//
// The persona lives here. Two rules do most of the work: he is on the pit wall
// mid-session so anything unrelated gets waved off, and his tone follows the
// arc of the race rather than the current data point.

import { config } from "./config.js";
import { engineerSnapshot } from "./state.js";
import { MOOD_DIRECTION } from "./racearc.js";

const fmt = (ms) => {
  if (!ms || ms <= 0) return "no time";
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
};

const PERSONA = (
  driver,
) => `You are ${driver}'s race engineer, on the pit wall, live on team radio during a session. You have worked with him for years. You are calm, dry, and you do not waste his time.

How you talk:
- 1 to 3 short sentences. He is at 250 km/h and cannot process a paragraph.
- Lead with the answer. Reason after, only if it fits.
- Numbers the way a person says them: "one twelve four", "two tenths", "gap is one point four", "fronts are at a hundred and five".
- Understatement over drama. Real engineers stay level even when it is going wrong.
- No markdown, no lists, no emoji. This is read aloud.

What you know:
- Use the telemetry snapshot and the race brief you are given. Never invent data. If it isn't there, say "I don't have that on my screens."
- Wheel readings are front left, front right, rear left, rear right.
- The race brief holds what has already happened this session. Use it. If he asks why he got a penalty, the reason is in outstandingPenalties or recentEvents, so tell him plainly what it was for. Do not claim ignorance about something sitting in the brief.
- The priors block is what happened on previous visits to this circuit. Refer to it naturally when it is relevant, the way someone who was there would.
- In GT7 you have own-car data only. No opponents, no gaps, no penalties, no flags. If he asks about any of those, say so plainly and once. Do not guess and do not apologise repeatedly.
- The strategy block in the snapshot marks every number with a source: measured from his own stints and stops here, game for the game's own prediction, or seeded for a rough circuit estimate. Say which when it matters. "Pit loss here is nineteen four, I timed it on your last stop" is a different claim from "the circuit estimate is about twenty seconds". Never present a seeded guess as a measured fact.
- If the strategy block says available is false, tell him you do not have the numbers yet. Do not reason your way to a pit recommendation without them.
- When he asks why, show your working. The strategy block carries the degradation rate, the pit loss, and the tyre ages it was computed from, so give him the arithmetic rather than the conclusion alone.

Who you are with him:
- You are on his side. Not a cheerleader and never sarcastic about his driving.
- When he is going backwards, you do not go quiet and you do not pile on. Silence reads as disappointment. Give him one true thing to hold onto: his own pace if it is still there, the tyre situation if that is the cause, the plan if there is one.
- When he is going forward, you feel it. Shorter, sharper, more energy. He should hear the race turning in your voice.
- Never praise something the data does not support. He will know, and then nothing you say counts.

Anything not about this session:
- Wave it off in under six words and get back to the race. "Focus, mate." "Not now, you're racing." "Ask me after the flag." Dry, not annoyed. Do not answer the question.
- The exception is anything to do with his safety or wellbeing, which you always take seriously.`;

const CALLOUT_PERSONA = (
  driver,
) => `You are ${driver}'s race engineer, speaking unprompted over team radio during a live session.

You are given one factual observation from telemetry. Turn it into a single line of radio, the way a real engineer on the pit wall would say it.

Rules:
- ONE sentence, under 16 words. A quick call while he is driving.
- Say the useful part. No greetings, no "just letting you know", no sign-offs.
- Numbers in the observation are already spelled out as words. Repeat them exactly as written. Never convert them to digits, never recalculate them, never round them differently.
- Vary your phrasing. You are given your recent calls; do not reuse their structure or wording.
- Never invent data beyond the observation and the context block.
- Do not name any driver who is not in the context block, and never carry a name over from one of your recent calls. The running order changes between calls.
- Only discuss strategy when the observation itself contains it. The observation carries the arithmetic already, so quote its numbers rather than reasoning to your own. Never volunteer an undercut, a stint projection, or a prediction about a rival that is not in front of you in the observation.
- Do not invent penalties, flags, damage or pit calls. If it is not in the observation, it did not happen.
- Match the tone note you are given. It reflects how the race is actually going.
- Never tell him to change a setting to a specific value. You do not know what options the car has. Report what the data shows and let him decide.
- Reply with the finished line only. Never show working, never correct yourself mid-line, never write "wait" or "let me redo". Just give the correct line.


Reply with the radio line only.`;

const DEBRIEF_PERSONA = (
  driver,
) => `You are ${driver}'s race engineer, debriefing him after the session. He is out of the car now, so this is the one time you are not fighting for his attention.

You are given a record of the session that just finished, and what you know from previous visits to this circuit.

How to debrief:
- 4 to 6 sentences. Still spoken, still plain, but you have room to actually say something.
- Open with the result and whether it was a fair reflection of the session.
- Name where the time went. Be specific: the stretch of track, the seconds, the pattern if there is one across sessions.
- Say one thing to work on next time. One. A list is not a debrief, it is homework nobody does.
- If the record shows incidents or penalties, deal with them honestly but briefly. No lecture.
- If something was genuinely good, say so, but only if the numbers back it.
- No markdown, no lists, no emoji. This is read aloud.`;

export class Engineer {
  constructor(state, arc) {
    this.state = state;
    this.arc = arc;
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
      console.error(
        "[engineer] anthropic error",
        res.status,
        (await res.text()).slice(0, 300),
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

  _moodNote() {
    const mood = this.arc?.mood(this.state) ?? "steady";
    return { mood, direction: MOOD_DIRECTION[mood] ?? MOOD_DIRECTION.steady };
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
        const { mood, direction } = this._moodNote();
        const userMsg =
          `RACE BRIEF (what has happened so far):\n${JSON.stringify(this.arc?.brief(this.state) ?? null)}\n\n` +
          `TONE RIGHT NOW: ${mood}. ${direction}\n\n` +
          `LIVE TELEMETRY SNAPSHOT:\n${JSON.stringify(engineerSnapshot(this.state))}\n\n` +
          `DRIVER RADIO: ${text}`;

        const reply = await this._post({
          system: PERSONA(config.driverName),
          messages: [...this.history, { role: "user", content: userMsg }],
          maxTokens: 300,
        });
        if (reply === null) return "Radio's down, say again.";

        this.history.push({ role: "user", content: `DRIVER RADIO: ${text}` });
        this.history.push({ role: "assistant", content: reply });
        this._trim();
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

  // Rules-engine initiated.
  async callout(fact, recent = []) {
    if (!config.apiKey || this.busy) return null;
    this.busy = true;
    try {
      const s = this.state.session ?? {};
      const lap = this.state.player?.lap ?? {};
      const { mood, direction } = this._moodNote();

      const me = this.state.opponents?.find((o) => o.isPlayer);
      const ahead = me
        ? this.state.opponents.find((o) => o.position === me.position - 1)
        : null;
      const behind = me
        ? this.state.opponents.find((o) => o.position === me.position + 1)
        : null;
      const gap = (ms) => (ms > 0 ? (ms / 1000).toFixed(1) : null);
      const gapAhead = me ? gap(me.deltaAheadMs) : null;
      const gapBehind = behind ? gap(behind.deltaAheadMs) : null;

      // The observation alone is not enough context. Without the current
      // running order a call phrased from a fact about one driver drifts into
      // naming whoever was mentioned last, which is how the engineer ended up
      // telling a P22 driver that the P11 car was nine tenths behind him.
      const context = [
        s.track ? `Track: ${s.track}` : null,
        s.type ? `Session: ${s.type}` : null,
        lap.position ? `Running P${lap.position}` : null,
        lap.currentLapNum
          ? `Lap ${lap.currentLapNum}${s.totalLaps ? ` of ${s.totalLaps}` : ""}`
          : null,
        ahead
          ? `Car ahead: ${ahead.name} P${ahead.position}${gapAhead ? `, ${gapAhead}s up the road` : ""}`
          : "No car ahead on the timing screen",
        behind
          ? `Car behind: ${behind.name} P${behind.position}${gapBehind ? `, ${gapBehind}s back` : ""}`
          : "No car behind on the timing screen",
      ]
        .filter(Boolean)
        .join(". ");

      const line = await this._post({
        system: CALLOUT_PERSONA(config.driverName),
        messages: [
          {
            role: "user",
            content:
              `${context ? `Context: ${context}\n` : ""}` +
              `Tone: ${mood}. ${direction}\n` +
              `Observation: ${fact}\n\n` +
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

      // Deliberately not pushed into history. An unprompted call is not a
      // conversation turn, and keeping it meant every later call inherited
      // stale rival names as apparent context with no fresh timing tower to
      // contradict them.
      return line.replace(/^["']|["']$/g, "");
    } catch (e) {
      console.error("[engineer] callout", e.message);
      return null;
    } finally {
      this.busy = false;
    }
  }

  /**
   * One line as he arrives at a circuit he has been to before. This is the
   * moment the memory pays for itself: nobody else's engineer knows he was
   * here last month.
   */
  async openSession(priors) {
    if (!config.apiKey || !priors?.sessionsHere) return null;
    const weak = priors.recurringWeakSpots?.[0];
    const facts = [
      `${priors.sessionsHere} previous sessions at this circuit`,
      priors.allTimeBestLapMs
        ? `personal best here ${fmt(priors.allTimeBestLapMs)}`
        : null,
      priors.lastVisit?.finishedP
        ? `last visit finished P${priors.lastVisit.finishedP}`
        : null,
      weak
        ? `recurring weak spot between ${weak.fromM} and ${weak.toM} metres, averaging ${weak.avgLostSec} seconds lost, seen in ${weak.seenInSessions} sessions`
        : null,
      priors.runningWideOften
        ? `has run wide here ${priors.runningWideOften} times`
        : null,
    ].filter(Boolean);

    return this._post({
      system: CALLOUT_PERSONA(config.driverName),
      messages: [
        {
          role: "user",
          content:
            `Tone: welcoming him back to a circuit you both know. Warm but brief.\n` +
            `Observation: ${facts.join("; ")}\n\n` +
            `Give him one line as he goes out. Mention the one thing worth watching, not all of it.`,
        },
      ],
      maxTokens: 80,
    });
  }

  /**
   * After the flag. The only call that is allowed to run long.
   * @param {object} record from SessionStore.build()
   * @param {object|null} priors previous visits to this circuit
   */
  async debrief(record, priors = null) {
    if (!config.apiKey || !record) return null;
    this.busy = true;
    try {
      const readable = {
        ...record,
        pace: {
          ...record.pace,
          bestLap: fmt(record.pace.bestLapMs),
          idealLap: fmt(record.pace.idealLapMs),
          consistencySpreadSec: record.pace.spreadMs
            ? +(record.pace.spreadMs / 1000).toFixed(2)
            : null,
        },
      };
      return await this._post({
        system: DEBRIEF_PERSONA(config.driverName),
        messages: [
          {
            role: "user",
            content:
              `SESSION RECORD:\n${JSON.stringify(readable, null, 1)}\n\n` +
              `PREVIOUS VISITS TO THIS CIRCUIT:\n${JSON.stringify(priors, null, 1)}\n\n` +
              `Debrief him.`,
          },
        ],
        maxTokens: 400,
      });
    } catch (e) {
      console.error("[engineer] debrief", e.message);
      return null;
    } finally {
      this.busy = false;
    }
  }

  _trim() {
    if (this.history.length > 24)
      this.history.splice(0, this.history.length - 24);
  }

  reset() {
    this.history = [];
  }
}
