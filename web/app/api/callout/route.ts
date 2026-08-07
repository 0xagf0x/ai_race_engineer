import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Turns a rules-engine observation into one line of natural team radio.
// Kept separate from /api/engineer: no conversation history, tight token
// budget, and a strong instruction to never pad.

const SYSTEM = (driver: string) => `You are ${driver}'s race engineer, speaking unprompted over team radio during a live session.

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

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no api key" }, { status: 500 });

  const { fact, recent, snapshot } = await req.json();
  const driver = process.env.DRIVER_NAME ?? "mate";
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

  const context = [
    snapshot?.session?.trackName ? `Track: ${snapshot.session.trackName}` : null,
    snapshot?.player?.position ? `Running P${snapshot.player.position}` : null,
    snapshot?.player?.currentLapNum ? `Lap ${snapshot.player.currentLapNum}${snapshot.session?.totalLaps ? ` of ${snapshot.session.totalLaps}` : ""}` : null,
  ]
    .filter(Boolean)
    .join(". ");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 80,
      system: SYSTEM(driver),
      messages: [
        {
          role: "user",
          content: `${context ? `Context: ${context}\n` : ""}Observation: ${fact}\n\nYour recent calls (do not repeat these):\n${
            (recent ?? []).slice(-5).map((r: string) => `- ${r}`).join("\n") || "- none yet"
          }`,
        },
      ],
    }),
  });

  if (!res.ok) {
    console.error("[callout] anthropic error", res.status, await res.text());
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
  const data = await res.json();
  const line = (data.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ")
    .trim()
    .replace(/^["']|["']$/g, "");
  return NextResponse.json({ line });
}
