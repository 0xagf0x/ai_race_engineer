# Pit Wall

AI race engineer for F1 25 and Gran Turismo 7 on PS5. It reads the game's UDP
telemetry, computes the strategy, tyre and corner maths itself, and talks to you
over the radio while you drive.

```
PS5 (F1 25 / GT7) --UDP--> Pit Wall (Node) --WebSocket--> dashboard in the browser
                                    |
                          Claude API + ElevenLabs voice
```

One process. `npm start` binds the UDP sockets, serves the dashboard, and runs
the engineer. There is nothing else to start.

What it does beyond showing numbers:

- **Measures your tyre degradation** per compound from your own stints, corrected
  for fuel burn, and tags every figure with where it came from: measured, the
  game's own prediction, or a seeded circuit estimate. The engineer says which.
- **Measures your pit loss** from your actual stops rather than guessing, and
  refuses to advise on an undercut until it has one.
- **Remembers the circuit.** Sessions are recorded per track, so the engineer
  opens with what happened last time you were here and debriefs you after the
  flag against your own history.
- **Learns your braking zones** from a clean lap and grades every corner against
  them, in both games.
- **Builds a geometric model of GT7 circuits** from world position, which gives
  exact lap distance, circuit identity without a track id, and an inferred track
  limits call that GT7 never sends.

## Requirements

- Node 20 or newer (22 recommended)
- A PS5 running F1 25 or GT7, on the same network as this machine
- An Anthropic API key
- Chrome or Edge for the dashboard, if you want to talk to it. The mic uses the
  Chromium speech API. Typed input works in any browser.

## Setup

```bash
npm install
cp .env.example .env    # then edit: add your ANTHROPIC_API_KEY
npm start
```

Open http://localhost:8080.

### F1 25

In game: Settings, then Telemetry Settings.

| Setting            | Value                                          |
| ------------------ | ---------------------------------------------- |
| UDP Telemetry      | On                                             |
| UDP Broadcast Mode | Off                                            |
| UDP IP Address     | this machine's LAN IP                          |
| UDP Port           | 20777                                          |
| UDP Format         | 2025, or 2026 if you have the 2026 Season Pack |
| Your Telemetry     | Public                                         |

`Your Telemetry: Public` is not optional. On Restricted the game withholds
opponent data and the timing tower, and with it every gap, every rival tyre age
and the whole undercut calculation, goes away.

Formats 2023 and 2024 also parse, but 2025 and 2026 are the ones in use and the
ones tested. The 2026 pack runs a 24-car grid; the parser solves the grid size
from the packet rather than assuming it, so both work.

**Push-to-talk.** In Controls, in your controller or wheel preset, bind a spare
button to **UDP Action 1**. The game sends that press over telemetry and the
radio opens while you hold it. To use a different button, set `F1_PTT_MASK` to
one of the flags in `src/f1/enums.js` (`R3` is `0x4000`, d-pad down is `0x0080`).
Set `PTT_MODE=toggle` if you would rather press once to open and again to send.

### GT7

GT7 needs the PS5's IP address, because the game only sends telemetry to a
machine that heartbeats it:

```
GT7_PS5_IP=192.168.1.xx
```

Find it in the PS5's Settings, Network, Connection Status. GT7 must be in a
session rather than the menus before packets start.

GT7 broadcasts own-car data only: no opponents, no gaps, no flags, no controller
buttons. You get full car telemetry, lap timing, fuel, tyre temps, the delta, and
corner coaching. Key the radio with the on-screen button, the spacebar, the wake
word, or by typing.

Both games can be enabled at once. Whichever is sending packets is the one the
dashboard shows.

## Using it

- **Ask it anything about the session.** Hold the talk button and speak, or type
  in the box. "Gap to the car behind?" "How are my tyres?" "When should I box?"
  "Why did I get that penalty?"
- **Wake word.** Turn it on in the radio panel and say "radio", "engineer" or
  "box box". A pause ends the transmission. Useful in GT7, where there is no
  controller button to bind.
- **Engineer chatter** has four levels, set live from the dashboard or with
  `FEEDBACK_LEVEL`:

  | Level    | Behaviour                                |
  | -------- | ---------------------------------------- |
  | `off`    | only answers when asked                  |
  | `low`    | key moments only, 45 second minimum gap  |
  | `medium` | regular updates, 18 second gap           |
  | `high`   | constant, 7 second gap, corner by corner |

- **Corner coaching.** Drive one clean lap. The dashboard then shows the next
  braking zone with distance, gear and entry speed, and the engineer grades your
  braking against it. Beat the reference and it re-learns.
- **The delta box** shows live time to your reference lap, with a trace of where
  the last lap went.

## Config

Everything lives in `.env`. Defaults are in `src/config.js`.

| Variable              | Default             | Notes                                         |
| --------------------- | ------------------- | --------------------------------------------- |
| `ANTHROPIC_API_KEY`   | —                   | required; without it the engineer cannot talk |
| `ENGINEER_MODEL`      | `claude-sonnet-4-6` |                                               |
| `DRIVER_NAME`         | `mate`              | what the engineer calls you                   |
| `HTTP_PORT`           | `8080`              | dashboard and WebSocket share this port       |
| `F1_UDP_PORT`         | `20777`             | must match the game                           |
| `F1_PTT_MASK`         | `0x00100000`        | UDP Action 1                                  |
| `PTT_MODE`            | `hold`              | `hold` or `toggle`                            |
| `GT7_PS5_IP`          | —                   | leave blank to disable the GT7 listener       |
| `GT7_RECEIVE_PORT`    | `33740`             |                                               |
| `GT7_SEND_PORT`       | `33739`             |                                               |
| `FEEDBACK_LEVEL`      | `medium`            | startup value; changeable live                |
| `ELEVENLABS_API_KEY`  | —                   | optional, see below                           |
| `ELEVENLABS_VOICE_ID` | —                   | required alongside the key                    |
| `ELEVENLABS_MODEL`    | `eleven_flash_v2_5` |                                               |
| `RACE_DATA_DIR`       | `data/`             | where sessions and track data are written     |

### Voice

With no ElevenLabs key the engineer speaks through the operating system voice,
picking the best British one installed. With a key and a voice id set, he speaks
through ElevenLabs instead. The dashboard probes `/api/tts` on load and falls
back on its own; a rejected key or an unavailable voice disables the route for
the rest of the process rather than failing before every line.

## What it writes to disk

Under `data/`, or wherever `RACE_DATA_DIR` points:

- `data/sessions/` one small JSON record per session, per circuit. These are what
  the priors and the debrief are built from.
- `data/tracks/` the reference lap and braking zones per circuit, plus the
  learned GT7 centreline and fingerprint.

Delete either directory to start the engineer's memory over. Nothing here leaves
the machine except the compact snapshot sent with each radio message.

## Project layout

```
src/index.js          wiring: UDP sockets, broadcast loop, session lifecycle
src/config.js         env parsing and defaults
src/state.js          normalised live state, shared by dashboard and engineer
src/server.js         static dashboard, WebSocket, ElevenLabs TTS proxy
src/engineer.js       the persona and the four call paths into Claude
src/callouts.js       rules engine for unprompted radio
src/strategy.js       degradation, pit loss, undercut, fuel target
src/coach.js          braking zone learning and per-corner grading
src/delta.js          live delta to a stored reference lap
src/sessions.js       session records and cross-session priors
src/racearc.js        how the race is going, which sets the engineer's tone
src/slip.js           wheelspin detection
src/f1/parser.js      F1 UDP packet parser, formats 2023 to 2026
src/f1/enums.js       track, team, tyre and button tables
src/gt7/client.js     GT7 heartbeat, Salsa20 decrypt, packet parse
src/gt7/track-model.js  centreline, circuit fingerprint, lap distance
public/               the dashboard
tools/inspect.js      packet dumper for verifying a new game build
test/                 node --test, no dependencies
```

## Development

```bash
npm test           # runs test/*.test.js against a temp data dir
npm run inspect    # dumps what the game is actually sending
```

`npm run inspect` binds the same UDP ports as the app, so stop the app first. It
prints every packet id and size it sees, and how each one divides into a grid, so
a new game build can be checked against reality rather than guessed at. Leave it
running for a lap or two and press ctrl-c for the summary.

## Known limits

- GT7 sends no opponent data at all. Anything about rivals, gaps, flags or
  penalties is unavailable in GT7 and the engineer will say so.
- F1 opponent gaps come from the delta-to-car-in-front chain, so they are gaps in
  race order. Correct in a race, less meaningful in practice or qualifying.
- The mic needs Chrome or Edge. Typed input works everywhere.
- The dashboard and the `/api/tts` route bind on all network interfaces with no
  authentication. Fine on a trusted home network, not fine on a shared one.
- Packet 15 in F1 25 is recognised but not parsed. Its layout has not been
  verified, and guessing offsets is how an engineer starts saying confident wrong
  things.
- If the parser sees a packet it cannot make sense of it counts it and warns
  once, rather than throwing. A blackout with no error would be worse.

## Troubleshooting

**Nothing arrives from F1.** The game must be in a session rather than the menus.
Check that the UDP IP in the game is this machine's LAN address and not
`127.0.0.1`, that the port matches `F1_UDP_PORT`, and that the format is 2025 or 2026. Run `npm run inspect` to see whether packets are reaching the machine at
all.

**Telemetry arrives but the timing tower is empty.** `Your Telemetry` is set to
Restricted. Set it to Public.

**Nothing arrives from GT7.** The PS5's IP has probably changed; DHCP leases
expire. Check it in the PS5's network settings and give the console a static
reservation on your router if it keeps moving.

**`EADDRINUSE` on startup.** Something else owns the UDP port, usually a second
copy of the app or `npm run inspect` left running.

**The engineer says the radio is down.** `ANTHROPIC_API_KEY` is missing or
rejected. The startup log says so explicitly.
