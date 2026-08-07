// Pit Wall dashboard: renders bridge state, handles push-to-talk (controller,
// button, or spacebar), speech-to-text, and speaks the engineer's replies.

const $ = (id) => document.getElementById(id);

let ws = null;
let state = null;
let micActive = false;
let recognition = null;
let transcriptBuf = "";

// ---------------- WebSocket ----------------
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => console.log("bridge connected");
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "state": state = msg; render(); break;
      case "ptt": msg.pressed ? startTalking() : stopTalking(); break;
      case "ptt-toggle": micActive ? stopTalking() : startTalking(); break;
      case "engineer-thinking": setRadioState("thinking"); break;
      case "engineer": onEngineer(msg); break;
    }
  };
}
connect();

const send = (obj) => ws?.readyState === 1 && ws.send(JSON.stringify(obj));

// ---------------- Speech: mic in ----------------
function ensureRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = "en-US";
  r.onresult = (e) => {
    let final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript;
    }
    if (final) transcriptBuf += final;
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed") addMsg("eng", "Mic permission denied. Allow microphone access, or type below.");
  };
  return r;
}

function startTalking() {
  if (micActive) return;
  micActive = true;
  transcriptBuf = "";
  setRadioState("live");
  speechSynthesis.cancel(); // don't talk over the driver
  recognition = ensureRecognition();
  if (recognition) { try { recognition.start(); } catch {} }
  else addMsg("eng", "Speech recognition isn't supported in this browser. Use Chrome, or type below.");
}

function stopTalking() {
  if (!micActive) return;
  micActive = false;
  setRadioState("idle");
  if (recognition) {
    try { recognition.stop(); } catch {}
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
let engVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  engVoice =
    vs.find((v) => /en-GB/i.test(v.lang) && /male|daniel|arthur/i.test(v.name)) ||
    vs.find((v) => /en-GB/i.test(v.lang)) ||
    vs.find((v) => /^en/i.test(v.lang)) || null;
}
speechSynthesis.onvoiceschanged = pickVoice;
pickVoice();

function speak(text) {
  const u = new SpeechSynthesisUtterance(text);
  if (engVoice) u.voice = engVoice;
  u.rate = 1.05;
  u.pitch = 0.95;
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
  $("radioLabel").textContent = s === "live" ? "RADIO — ON AIR" : s === "thinking" ? "RADIO — STAND BY" : "RADIO";
  $("pttBtn").classList.toggle("live", s === "live");
}

function addMsg(who, text, auto = false) {
  const div = document.createElement("div");
  div.className = `msg ${who}${auto ? " auto" : ""}`;
  div.innerHTML = `<span class="who">${who === "you" ? "YOU" : auto ? "ENGINEER — AUTO" : "ENGINEER"}</span>${escapeHtml(text)}`;
  const chat = $("chat");
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// PTT: on-screen button + spacebar hold
const pttBtn = $("pttBtn");
const down = (e) => { e.preventDefault(); startTalking(); };
const up = (e) => { e.preventDefault(); stopTalking(); };
pttBtn.addEventListener("mousedown", down);
pttBtn.addEventListener("mouseup", up);
pttBtn.addEventListener("mouseleave", () => micActive && stopTalking());
pttBtn.addEventListener("touchstart", down, { passive: false });
pttBtn.addEventListener("touchend", up);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat && document.activeElement !== $("typeInput")) { e.preventDefault(); startTalking(); }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && document.activeElement !== $("typeInput")) { e.preventDefault(); stopTalking(); }
});

// Typed fallback
$("typeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("typeInput").value.trim();
  if (v) { askEngineer(v); $("typeInput").value = ""; }
});

// ---------------- Rendering ----------------
function render() {
  if (!state) return;

  // connection
  const conn = $("conn");
  conn.classList.toggle("live", !!state.live);
  $("connLabel").textContent = state.live ? (state.game === "f1" ? "F1 25 LIVE" : "GT7 LIVE") : "OFFLINE";

  // session line
  const s = state.session || {};
  const bits = [s.track, s.type, s.weather, s.trackTemp != null ? `Track ${s.trackTemp}°C` : null, s.totalLaps ? `${s.totalLaps} laps` : null].filter(Boolean);
  $("sessionInfo").textContent = bits.join("  ·  ") || "Waiting for telemetry";

  const p = state.player || {};

  // car
  $("speed").textContent = p.speed ?? 0;
  $("gear").textContent = p.gear === 0 ? "N" : p.gear === -1 ? "R" : (p.gear ?? "N");
  $("suggestGear").textContent = p.suggestedGear != null && p.suggestedGear > 0 && p.suggestedGear !== p.gear ? `→ ${p.suggestedGear}` : "";
  const maxRpm = p.status?.maxRPM || 13000;
  $("rpmBar").style.width = `${Math.min(100, ((p.rpm || 0) / maxRpm) * 100)}%`;
  $("rpmLabel").textContent = `${p.rpm ?? 0} rpm`;
  $("thrBar").style.width = `${(p.throttle || 0) * 100}%`;
  $("brkBar").style.width = `${(p.brake || 0) * 100}%`;

  // tyres: order FL FR RL RR displayed; telemetry arrays are [RL, RR, FL, FR]
  document.querySelectorAll(".tyre").forEach((el) => {
    const i = +el.dataset.i;
    const t = p.tyreSurfaceTemps?.[i];
    const w = p.damage?.tyreWear?.[i];
    el.querySelector(".tt").textContent = t != null ? `${t}°` : "–";
    el.querySelector(".tw").textContent = w != null ? `${w}% wear` : "";
    el.classList.toggle("warm", t > 100 && t <= 110);
    el.classList.toggle("hot", t > 110);
  });

  // status rows
  const rows = [];
  const st = p.status || {};
  if (st.tyre) rows.push(["Tyre", `${st.tyre}${st.tyreAgeLaps != null ? ` · ${st.tyreAgeLaps} laps` : ""}`]);
  if (st.fuelInTank != null) rows.push(["Fuel", `${st.fuelInTank} kg${st.fuelRemainingLaps != null ? ` · ${st.fuelRemainingLaps} laps` : ""}`]);
  if (p.drs != null) rows.push(["DRS", p.drs ? "OPEN" : st.drsAllowed ? "Available" : "—"]);
  if (p.damage) rows.push(["Wing dmg", `F ${p.damage.frontWing}% · R ${p.damage.rearWing}%`]);
  if (p.engineTemp) rows.push(["Engine", `${p.engineTemp}°C`]);
  $("statRows").innerHTML = rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join("");

  // timing
  const lap = p.lap || {};
  const lapBits = [
    lap.position ? `P<b>${lap.position}</b>` : null,
    lap.currentLapNum ? `Lap <b>${lap.currentLapNum}</b>${s.totalLaps ? `/${s.totalLaps}` : ""}` : null,
    lap.currentLap ? `Now <b>${lap.currentLap}</b>` : null,
    lap.lastLap ? `Last <b>${lap.lastLap}</b>` : null,
    lap.bestLap ? `Best <b>${lap.bestLap}</b>` : null,
    lap.invalid ? `<span style="color:var(--red)">LAP INVALID</span>` : null,
  ].filter(Boolean);
  $("lapLine").innerHTML = lapBits.join("  ·  ");

  const tower = $("tower");
  if (state.opponents?.length) {
    tower.innerHTML = state.opponents.map((o) => `
      <div class="trow${o.isPlayer ? " you" : ""}">
        <span class="pos">${o.position}</span>
        <span class="name">${escapeHtml(o.name)}<small>${escapeHtml(o.team)}${o.pit ? ` <span class="pitflag">${o.pit}</span>` : ""}</small></span>
        <span class="gap">${o.position === 1 ? "LEADER" : "+" + (o.deltaAheadMs / 1000).toFixed(1)}</span>
        <span class="lastlap">${o.lastLap ?? "—"}</span>
        <span class="tyrecell tyre-${(o.tyre || "?")[0]}">${o.tyre ?? "?"}${o.tyreAge != null ? ` ${o.tyreAge}` : ""}</span>
      </div>`).join("");
  }

  // coach
  if (state.coach) {
    const c = state.coach;
    $("coachText").innerHTML =
      `Next braking zone in <b>${c.brakeInM} m</b> — down to <b>gear ${c.gear}</b>, entry <b>${c.entrySpeedKph} km/h</b>, apex ~<b>${c.minSpeedKph} km/h</b>`;
  }
}
