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
          squelch(false);
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
  u.onend = () => squelch(false);
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

  $("speed").textContent = p.speed ?? 0;
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

  // Wheel arrays are FL FR RL RR from the bridge now, so data-i is 0,1,2,3 in
  // display order and no reordering happens here.
  document.querySelectorAll(".tyre").forEach((el) => {
    const i = +el.dataset.i;
    const t = p.tyreSurfaceTemps?.[i];
    const w = p.damage?.tyreWear?.[i];
    el.querySelector(".tt").textContent = t != null ? `${t}°` : "–";
    el.querySelector(".tw").textContent = w != null ? `${w}% wear` : "";
    el.classList.toggle("warm", t > 100 && t <= 110);
    el.classList.toggle("hot", t > 110);
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
      `${st.fuelInTank} kg${st.fuelRemainingLaps != null ? ` · ${st.fuelRemainingLaps} laps` : ""}`,
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
      `Turn <b>${c.cornerIndex}</b> in <b>${c.brakeInM} m</b> — down to <b>gear ${c.gear}</b>, entry <b>${c.entrySpeedKph} km/h</b>, apex ~<b>${c.minSpeedKph} km/h</b>`;
  }
}
