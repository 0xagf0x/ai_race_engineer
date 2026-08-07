import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Optional. With ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID set, the engineer
// speaks through a real voice model. Without them this returns 501 and the
// browser falls back to the best local UK voice.

export async function POST(req: NextRequest) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) return new NextResponse(null, { status: 501 });

  const { text } = await req.json();
  if (!text) return new NextResponse(null, { status: 400 });

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_22050_32`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5",
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75,
          style: 0.15,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!res.ok) {
    console.error("[tts] ElevenLabs error", res.status, await res.text());
    return new NextResponse(null, { status: 502 });
  }

  return new NextResponse(res.body, {
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
}
