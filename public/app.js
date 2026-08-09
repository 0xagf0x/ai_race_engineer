// Pit Wall dashboard: renders bridge state, handles push-to-talk (controller,
// button, or spacebar), speech-to-text, and speaks the engineer's replies.
//
// Voice handling is ported from web/lib/voice.ts: the British voice preference
// ranking, the squelch burst either side of a transmission, and the server TTS
// route with a fallback to the OS voice.

const $ = (id) => document.getElementById(id);

let ws = null;
let state = null;
let micActive = false;
let recognition = null;
let transcriptBuf = "";
let serverTts = false;

// GT7
let wakeRecognition = null;
let wakeEnabled = false;
let wakeRestartTimer = null;
let silenceTimer = null;
let wakeTriggered = false;

// How long a pause means "he has finished talking". Long enough not to cut off
// someone thinking mid-sentence, short enough that the answer does not feel
// delayed. Only used for the wake word: the button and the controller have an
// explicit release.
const SILENCE_MS = 1400;

// Spoken triggers. Kept short and distinctive: a long phrase is harder to catch
// mid-corner, and a common word fires on ordinary speech.
const WAKE_WORDS = ["radio", "engineer", "box box"];

// Display units. The bridge always sends metric; conversion is presentation
// only, so nothing downstream of the socket has to know about it.
let units = localStorage.getItem("units") === "mph" ? "mph" : "kmh";
const KPH_TO_MPH = 0.621371;
const M_TO_FT = 3.28084;

const speedOut = (kph) =>
  kph == null ? 0 : Math.round(units === "mph" ? kph * KPH_TO_MPH : kph);
const speedUnit = () => (units === "mph" ? "mph" : "km/h");
const distOut = (m) =>
  m == null ? 0 : Math.round(units === "mph" ? m * M_TO_FT : m);
const distUnit = () => (units === "mph" ? "ft" : "m");

// ---------------- WebSocket ----------------
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => console.log("bridge connected");
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "state":
        state = msg;
        render();
        break;
      case "ptt":
        msg.pressed ? startTalking() : stopTalking();
        break;
      case "ptt-toggle":
        micActive ? stopTalking() : startTalking();
        break;
      case "engineer-thinking":
        setRadioState("thinking");
        break;
      case "engineer":
        onEngineer(msg);
        break;
    }
  };
}
connect();

const send = (obj) => ws?.readyState === 1 && ws.send(JSON.stringify(obj));

// Probe the TTS route once. 501 means no ElevenLabs key configured, so we stay
// on the OS voice.
fetch("/api/tts", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "" }),
})
  .then((r) => {
    serverTts = r.status !== 501;
  })
  .catch(() => {
    serverTts = false;
  });

// ---------------- Speech: mic in ----------------
function ensureRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = "en-GB";
  r.onresult = (e) => {
    let final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript;
    }
    if (final) transcriptBuf += final;

    // Wake word transmissions have no release, so silence ends them. Any
    // result at all resets the clock, interim included, so a pause for breath
    // does not send half a question.
    if (wakeTriggered) {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(stopTalking, SILENCE_MS);
    }
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed")
      addMsg(
        "eng",
        "Mic permission denied. Allow microphone access, or type below.",
      );
  };
  return r;
}

// Always-on listener for the wake word. Separate from the push-to-talk
// recognition instance: this one runs continuously at low stakes, and hands
// over to the real one the moment it hears a trigger.
//
// GT7 sends no controller buttons, so without this a GT7 driver has no way to
// key the radio without reaching for a keyboard.
function startWakeListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !wakeEnabled) return;

  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = "en-GB";

  r.onresult = (e) => {
    // Never while the engineer is talking: on speakers his own voice comes
    // back through the mic and can carry the trigger.
    if (currentAudio || speechSynthesis.speaking || micActive) return;

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const said = e.results[i][0].transcript.trim().toLowerCase();
      // Trigger only at the start of an utterance, so the word appearing
      // mid-sentence in ordinary speech does not open the radio.
      const hit = WAKE_WORDS.find((w) => said.startsWith(w));
      if (hit) {
        r.stop();
        wakeTriggered = true;
        startTalking();
        // If he says the wake word and then nothing at all, the transmission
        // still has to close itself.
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(stopTalking, SILENCE_MS + 1500);
        return;
      }
    }
  };

  // Chrome ends recognition after a silence, so it has to be restarted for as
  // long as the feature is on.
  r.onend = () => {
    if (!wakeEnabled) return;
    clearTimeout(wakeRestartTimer);
    wakeRestartTimer = setTimeout(startWakeListening, 400);
  };

  r.onerror = (e) => {
    if (e.error === "not-allowed") {
      wakeEnabled = false;
      addMsg("eng", "Mic permission denied, so the wake word is off.");
      return;
    }
    // no-speech and aborted are routine; onend will restart.
  };

  wakeRecognition = r;
  try {
    r.start();
  } catch {
    /* already running */
  }
}

function stopWakeListening() {
  wakeEnabled = false;
  clearTimeout(wakeRestartTimer);
  try {
    wakeRecognition?.stop();
  } catch {}
  wakeRecognition = null;
}

function startTalking() {
  if (micActive) return;
  micActive = true;
  transcriptBuf = "";
  setRadioState("live");
  cancelSpeech(); // barge-in: the driver talking beats whatever we were saying
  squelch(true);
  recognition = ensureRecognition();
  if (recognition) {
    try {
      recognition.start();
    } catch {}
  } else
    addMsg(
      "eng",
      "Speech recognition isn't supported in this browser. Use Chrome, or type below.",
    );
}

function stopTalking() {
  if (!micActive) return;
  micActive = false;
  wakeTriggered = false;
  clearTimeout(silenceTimer);
  setRadioState("idle");
  squelch(false);
  if (recognition) {
    try {
      recognition.stop();
    } catch {}
    // final results can land just after stop()
    setTimeout(() => {
      const text = transcriptBuf.trim();
      if (text) askEngineer(text);
      if (wakeEnabled) startWakeListening();
    }, 350);
  }
}

function askEngineer(text) {
  addMsg("you", text);
  send({ type: "ask", text });
  setRadioState("thinking");
}

// ---------------- Speech: engineer out ----------------

// Ranked by how close each is to a calm British pit wall engineer. Names vary by
// OS and browser, so this is a preference order, not a guarantee.
const BRITISH_PREFERENCE = [
  "Google UK English Male",
  "Daniel",
  "Arthur",
  "Oliver",
  "Google UK English Female",
  "Serena",
  "Kate",
  "Stephanie",
];

let engVoice = null;
function englishVoices() {
  return speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith("en"))
    .sort((a, b) => {
      const gb = (v) => (/en[-_]GB/i.test(v.lang) ? 0 : 1);
      if (gb(a) !== gb(b)) return gb(a) - gb(b);
      const rank = (v) => {
        const i = BRITISH_PREFERENCE.indexOf(v.name);
        return i === -1 ? 99 : i;
      };
      return rank(a) - rank(b);
    });
}

function pickVoice() {
  const voices = englishVoices();
  engVoice =
    BRITISH_PREFERENCE.map((n) => voices.find((v) => v.name === n)).find(
      Boolean,
    ) ||
    voices.find((v) => /en[-_]GB/i.test(v.lang)) ||
    voices[0] ||
    null;
  if (engVoice && !/en[-_]GB/i.test(engVoice.lang) && !serverTts) {
    console.info(
      "No UK voice installed. On macOS: System Settings, Accessibility, Spoken Content, System Voice, Manage Voices (Daniel or Oliver).",
    );
  }
}
speechSynthesis.onvoiceschanged = pickVoice;
pickVoice();

// ---- radio squelch ----
let audioCtx = null;
function ctx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function squelch(open) {
  try {
    const ac = ctx();
    const dur = 0.07;
    const noise = ac.createBufferSource();
    const buf = ac.createBuffer(
      1,
      Math.floor(ac.sampleRate * dur),
      ac.sampleRate,
    );
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++)
      data[i] = (Math.random() * 2 - 1) * 0.25;
    noise.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = open ? 2200 : 1400;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.4, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ac.currentTime + dur);
    noise.connect(bp).connect(gain).connect(ac.destination);
    noise.start();
  } catch {
    /* audio context blocked until first interaction, ignore */
  }
}

let currentAudio = null;
function cancelSpeech() {
  speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

async function speak(text) {
  cancelSpeech();
  squelch(true);
  send({ type: "speaking", speaking: true });

  const done = () => {
    squelch(false);
    // The bridge cannot know how long a line takes to say, only how long the
    // model took to write it. Without this the next callout fires while the
    // driver is still hearing the last one, and cancelSpeech cuts it off.
    send({ type: "speaking", speaking: false });
  };

  if (serverTts) {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        const audio = new Audio(url);
        currentAudio = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          currentAudio = null;
          done();
        };
        await audio.play();
        return;
      }
    } catch {
      // fall through to the browser voice
    }
  }

  const u = new SpeechSynthesisUtterance(text);
  if (engVoice) u.voice = engVoice;
  u.lang = "en-GB";
  u.rate = 1.05;
  u.pitch = 0.95;
  u.onend = done;
  speechSynthesis.speak(u);
}

function onEngineer(msg) {
  setRadioState("idle");
  addMsg("eng", msg.text, msg.auto);
  speak(msg.text);
}

// ---------------- Radio UI ----------------
function setRadioState(s) {
  const strip = $("radioStrip");
  strip.classList.toggle("live", s === "live");
  strip.classList.toggle("thinking", s === "thinking");
  $("radioLabel").textContent =
    s === "live"
      ? "RADIO — ON AIR"
      : s === "thinking"
        ? "RADIO — STAND BY"
        : "RADIO";
  $("pttBtn").classList.toggle("live", s === "live");
}

function addMsg(who, text, auto = false) {
  const div = document.createElement("div");
  div.className = `msg ${who}${auto ? " auto" : ""}`;
  div.innerHTML = `<span class="who">${who === "you" ? "YOU" : auto ? "ENGINEER — UNPROMPTED" : "ENGINEER"}</span>${escapeHtml(text)}`;
  const chat = $("chat");
  chat.appendChild(div);
  while (chat.children.length > 100) chat.removeChild(chat.firstChild);
  chat.scrollTop = chat.scrollHeight;
}
const escapeHtml = (s) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// PTT: on-screen button + spacebar hold
const pttBtn = $("pttBtn");
const down = (e) => {
  e.preventDefault();
  startTalking();
};
const up = (e) => {
  e.preventDefault();
  stopTalking();
};
pttBtn.addEventListener("mousedown", down);
pttBtn.addEventListener("mouseup", up);
pttBtn.addEventListener("mouseleave", () => micActive && stopTalking());
pttBtn.addEventListener("touchstart", down, { passive: false });
pttBtn.addEventListener("touchend", up);

const typing = () =>
  document.activeElement === $("typeInput") ||
  document.activeElement?.tagName === "SELECT";
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat && !typing()) {
    e.preventDefault();
    startTalking();
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && !typing()) {
    e.preventDefault();
    stopTalking();
  }
});

// Typed fallback
$("typeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("typeInput").value.trim();
  if (v) {
    askEngineer(v);
    $("typeInput").value = "";
  }
});

// Feedback level, if the control exists in the markup
$("feedbackLevel")?.addEventListener("change", (e) => {
  send({ type: "feedback-level", level: e.target.value });
});

// Units. Persisted so the choice survives a reload, and applied immediately
// rather than waiting for the next telemetry frame.
$("units")?.addEventListener("change", (e) => {
  units = e.target.value === "mph" ? "mph" : "kmh";
  localStorage.setItem("units", units);
  $("speedUnit").textContent = speedUnit();
  render();
});
const unitSel = $("units");
if (unitSel) {
  unitSel.value = units;
  $("speedUnit").textContent = speedUnit();
}

// Wake word. Off by default: continuous recognition costs battery and CPU, and
// on speakers the engineer's own voice can come back through the mic.
$("wakeWord")?.addEventListener("change", (e) => {
  if (e.target.value === "on") {
    wakeEnabled = true;
    startWakeListening();
  } else {
    stopWakeListening();
  }
});

// Wear to colour. Green through amber to red across the range that actually
// matters: a set at thirty percent is fine, sixty is worth planning around,
// eighty is a problem. Interpolating rather than stepping means the bar moves
// continuously through a stint instead of jumping between three states.
function wearColour(pct) {
  const stops = [
    { at: 0, rgb: [61, 220, 151] },
    { at: 45, rgb: [255, 176, 32] },
    { at: 80, rgb: [255, 77, 77] },
  ];
  const p = Math.max(0, Math.min(100, pct));
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (p >= stops[i].at && p <= stops[i + 1].at) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi.at - lo.at || 1;
  const t = Math.max(0, Math.min(1, (p - lo.at) / span));
  const mix = lo.rgb.map((c, i) => Math.round(c + (hi.rgb[i] - c) * t));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

// Seconds to a lap time string, for the reference readout.
function fmtSec(s) {
  const m = Math.floor(s / 60);
  const rest = (s % 60).toFixed(3).padStart(6, "0");
  return `${m}:${rest}`;
}

// ---------------- Rendering ----------------
function render() {
  if (!state) return;

  const conn = $("conn");
  conn.classList.toggle("live", !!state.live);
  $("connLabel").textContent = state.live
    ? state.game === "f1"
      ? "F1 LIVE"
      : "GT7 LIVE"
    : "OFFLINE";

  // The bridge owns the level, so mirror it here rather than trusting the
  // markup default. Skipped while the select has focus so a live broadcast
  // cannot reset the dropdown mid-choice.
  const lvl = $("feedbackLevel");
  if (lvl && state.feedbackLevel && document.activeElement !== lvl) {
    lvl.value = state.feedbackLevel;
  }

  const s = state.session || {};
  const bits = [
    s.track,
    s.type,
    s.weather,
    s.trackTemp != null ? `Track ${s.trackTemp}°C` : null,
    s.totalLaps ? `${s.totalLaps} laps` : null,
    s.safetyCar && s.safetyCar !== "none"
      ? s.safetyCar.toUpperCase() + " SC"
      : null,
  ].filter(Boolean);
  $("sessionInfo").textContent = bits.join("  ·  ") || "Waiting for telemetry";

  const p = state.player || {};

  $("speed").textContent = speedOut(p.speed);
  $("gear").textContent =
    p.gear === 0 ? "N" : p.gear === -1 ? "R" : (p.gear ?? "N");
  $("suggestGear").textContent =
    p.suggestedGear > 0 && p.suggestedGear !== p.gear
      ? `→ ${p.suggestedGear}`
      : "";
  const maxRpm = p.status?.maxRPM || 13000;
  $("rpmBar").style.width = `${Math.min(100, ((p.rpm || 0) / maxRpm) * 100)}%`;
  $("rpmLabel").textContent = `${p.rpm ?? 0} rpm`;
  $("thrBar").style.width = `${(p.throttle || 0) * 100}%`;
  $("brkBar").style.width = `${(p.brake || 0) * 100}%`;

  // Live delta to the reference lap. Hidden entirely until a reference exists,
  // because an empty box on lap one reads as broken rather than as pending.
  const dbox = $("deltaBox");
  const d = state.delta;
  if (d && d.liveDeltaSec != null) {
    const v = d.liveDeltaSec;
    dbox.classList.add("on");
    // Two hundredths either side counts as level: the sample rate cannot
    // resolve finer than that, and a number flickering between +0.01 and
    // -0.01 is noise dressed as information.
    const sign = v < -0.02 ? "up" : v > 0.02 ? "down" : "level";
    dbox.classList.toggle("up", sign === "up");
    dbox.classList.toggle("down", sign === "down");
    dbox.classList.toggle("level", sign === "level");
    $("deltaVal").textContent =
      `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;
    $("deltaRef").textContent = d.referenceLapSec
      ? `best ${fmtSec(d.referenceLapSec)}`
      : "";

    // Losing stretches from the last completed lap, as a bar per segment.
    const worst = d.losingMostTime ?? [];
    const trace = $("deltaTrace");
    if (worst.length !== trace.children.length) {
      trace.innerHTML = worst.map(() => "<i></i>").join("");
    }
    worst.forEach((line, idx) => {
      const bar = trace.children[idx];
      if (!bar) return;
      // losingMostTime is a list of strings, so the seconds are pulled back
      // out for the height rather than being sent twice.
      const secs = parseFloat(line) || 0;
      bar.style.height = `${Math.min(100, secs * 60)}%`;
      bar.title = line;
    });
  } else {
    dbox.classList.remove("on");
  }

  // Wheel arrays are FL FR RL RR from the bridge, so data-i is 0,1,2,3 in
  // display order and no reordering happens here.
  document.querySelectorAll(".tyre").forEach((el) => {
    const i = +el.dataset.i;
    const t = p.tyreSurfaceTemps?.[i];
    const w = p.damage?.tyreWear?.[i];

    el.querySelector(".tt").textContent = t != null ? `${t}°` : "–";

    const tread = el.querySelector(".ttread");
    const clip = el.querySelector(".tclip");
    const label = el.querySelector(".tw");

    if (w != null) {
      // Tread runs y=6 to y=62 in the SVG. Wear eats it from the top, so a set
      // at 40 percent shows 60 percent of its rubber left.
      const worn = Math.max(0, Math.min(100, w));
      const top = 6 + (56 * worn) / 100;
      clip.setAttribute("y", top);
      clip.setAttribute("height", Math.max(1, 62 - top));
      tread.setAttribute("fill", wearColour(worn));
      label.textContent = `${Math.round(worn)}% worn`;
    } else {
      clip.setAttribute("y", 6);
      clip.setAttribute("height", 56);
      tread.setAttribute("fill", wearColour(0));
      label.textContent = "";
    }

    el.classList.toggle("cold", t != null && t > 0 && t < 65);
    el.classList.toggle("warm", t > 105 && t <= 115);
    el.classList.toggle("hot", t > 115);
  });

  const rows = [];
  const st = p.status || {};
  if (st.tyre)
    rows.push([
      "Tyre",
      `${st.tyre}${st.tyreCompound && st.tyreCompound !== "?" ? ` (${st.tyreCompound})` : ""}${st.tyreAgeLaps != null ? ` · ${st.tyreAgeLaps} laps` : ""}`,
    ]);
  if (st.fuelInTank != null)
    rows.push([
      "Fuel",
      `${st.fuelInTank} kg${st.fuelDeltaLaps != null ? ` · ${st.fuelDeltaLaps > 0 ? "+" : ""}${st.fuelDeltaLaps} laps` : ""}`,
    ]);
  if (st.ersStorePct != null)
    rows.push([
      "Energy",
      `${st.ersStorePct}%${st.ersDeployMode ? ` · ${st.ersDeployMode}` : ""}`,
    ]);
  if (p.drs != null)
    rows.push(["DRS", p.drs ? "OPEN" : st.drsAllowed ? "Available" : "—"]);
  if (p.damage)
    rows.push([
      "Wing dmg",
      `F ${p.damage.frontWing}% · R ${p.damage.rearWing}%`,
    ]);
  if (p.engineTemp) rows.push(["Engine", `${p.engineTemp}°C`]);
  $("statRows").innerHTML = rows
    .map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`)
    .join("");

  const lap = p.lap || {};
  const lapBits = [
    lap.position ? `P<b>${lap.position}</b>` : null,
    lap.currentLapNum
      ? `Lap <b>${lap.currentLapNum}</b>${s.totalLaps ? `/${s.totalLaps}` : ""}`
      : null,
    lap.currentLap ? `Now <b>${lap.currentLap}</b>` : null,
    lap.lastLap ? `Last <b>${lap.lastLap}</b>` : null,
    lap.bestLap ? `Best <b>${lap.bestLap}</b>` : null,
    lap.idealLap ? `Ideal <b>${lap.idealLap}</b>` : null,
    lap.invalid ? `<span style="color:var(--red)">LAP INVALID</span>` : null,
  ].filter(Boolean);
  $("lapLine").innerHTML = lapBits.join("  ·  ");

  const tower = $("tower");
  if (state.opponents?.length) {
    tower.innerHTML = state.opponents
      .map(
        (o) => `
      <div class="trow${o.isPlayer ? " you" : ""}">
        <span class="pos">${o.position}</span>
        <span class="name">${escapeHtml(o.name)}<small>${escapeHtml(o.team)}${o.pit ? ` <span class="pitflag">${o.pit}</span>` : ""}</small></span>
        <span class="gap">${o.position === 1 ? "LEADER" : "+" + (o.deltaAheadMs / 1000).toFixed(1)}</span>
        <span class="lastlap">${o.lastLap ?? "—"}</span>
        <span class="tyrecell tyre-${(o.tyre || "?")[0]}">${o.tyre ?? "?"}${o.tyreAge != null ? ` ${o.tyreAge}` : ""}</span>
      </div>`,
      )
      .join("");
  }

  if (state.coach) {
    const c = state.coach;
    $("coachText").innerHTML =
      `Turn <b>${c.cornerIndex}</b> in <b>${distOut(c.brakeInM)} ${distUnit()}</b> — down to <b>gear ${c.gear}</b>, entry <b>${speedOut(c.entrySpeedKph)} ${speedUnit()}</b>, apex ~<b>${speedOut(c.minSpeedKph)} ${speedUnit()}</b>`;
  }
}
