# Race Engineer

AI race engineer for F1 25 and GT7 on PS5. Live telemetry dashboard, full voice conversations with an engineer that sees your car, your rivals, and your fuel/tyre picture, plus learned brake point coaching.

```
PS5 (F1 25 / GT7) --UDP--> bridge (Node) --WebSocket--> web (Next.js)
                                                          |
                                                 Claude API + voice
```

Two processes:

- `bridge/` listens for game UDP on your LAN, normalizes both games into one schema, learns brake zones from your laps, and broadcasts over WebSocket. Also watches F1 controller button events for push-to-talk.
- `web/` is the dashboard + radio. Push-to-talk mic input, Claude-powered engineer with the live snapshot in context, spoken replies, auto callouts on lap complete / safety car / low fuel.

## Setup

Requires Node 20+. The bridge machine must be on the same network as the PS5.

```bash
cd bridge && npm install
cd ../web && npm install
cp .env.local.example .env.local   # then edit: add your ANTHROPIC_API_KEY
```

### F1 25 (full experience: opponents + controller PTT)

In game: Settings → Telemetry Settings

- UDP Telemetry: On
- UDP Broadcast: Off, UDP IP Address: your bridge machine's LAN IP
- UDP Port: 20777
- **UDP Format: 2023** (required; the parser uses the 2023 packet layout, which F1 25 can emit natively)
- Your Telemetry: Public (otherwise opponent data is restricted)

Push-to-talk: in Controls → your controller preset, bind an unused button (or button combo) to **UDP Action 1**. The game streams that press over telemetry and the bridge opens the mic while you hold it. Change with `PTT_BUTTON` env (`udp1`..`udp4`, `r3`, `dpad_right`, etc, see `bridge/src/f1.ts`).

Run:

```bash
cd bridge && npm run dev          # defaults: MODE=f1, UDP 20777, WS 8765
cd web && npm run dev             # http://localhost:3000
```

### GT7 (own car only)

GT7 doesn't broadcast opponents or controller buttons; you get full car telemetry, lap timing, fuel, tyre temps, and coaching. Use spacebar, the on-screen mic, or typed input for the radio.

```bash
cd bridge && MODE=gt7 PS5_IP=192.168.x.x npm run dev
cd web && npm run dev
```

Find the PS5 IP in Settings → Network → Connection Status. GT7 must be in a session (not menus) before packets flow.

## Using it

- Open http://localhost:3000 in Chrome or Edge (mic dictation needs Chromium's speech API). Allow mic access.
- Hold PTT (controller UDP Action 1 in F1, or spacebar) and talk: "gap to the car behind?", "how are my tyres?", "when should I box?", "what gear for the next corner?" Release to send. The engineer answers in your headset.
- Auto callouts announce completed laps, safety cars, penalties, and low fuel without being asked. Toggle at the bottom of the radio panel.
- Brake coaching: drive one clean lap and the bridge learns your braking zones (stored in `bridge/data/` per track). From then on the dashboard shows the next zone with distance, gear, and entry speed, and the engineer can answer corner questions from it. Beat your reference lap and it re-learns.

## Config

| Var | Where | Default | Notes |
| --- | --- | --- | --- |
| `MODE` | bridge | `f1` | `f1` or `gt7` |
| `F1_PORT` | bridge | `20777` | must match in-game UDP port |
| `PS5_IP` | bridge | — | required for GT7 |
| `PTT_BUTTON` | bridge | `udp1` | F1 button flag for push-to-talk |
| `WS_PORT` | bridge | `8765` | WebSocket port |
| `ANTHROPIC_API_KEY` | web/.env.local | — | engineer brain |
| `ANTHROPIC_MODEL` | web/.env.local | `claude-sonnet-4-6` | |
| `DRIVER_NAME` | web/.env.local | `mate` | what the engineer calls you |
| `NEXT_PUBLIC_BRIDGE_WS_URL` | web/.env.local | `ws://localhost:8765` | point at the bridge machine if web runs elsewhere |

## Known limits

- GT7: no opponent data (the game doesn't send it) and lap distance is estimated by integrating speed, so brake point accuracy drifts slightly over a lap; F1's lapDistance is exact.
- F1 opponent gaps come from the delta-to-car-in-front chain, so they're gaps in race order, which is what you want in a race but less meaningful in practice/quali.
- Browser speech recognition needs Chrome or Edge. Typed input works everywhere.
- TTS uses the OS voice. For a proper engineer voice, swap `speak()` in `web/lib/voice.ts` for an ElevenLabs or OpenAI TTS call.
