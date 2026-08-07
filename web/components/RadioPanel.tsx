"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMsg, RaceEvent, Snapshot } from "@/lib/types";
import {
  sttSupported, startListening, stopListening, speak, squelch, cancelSpeech,
  loadVoices, englishVoices, defaultVoiceName,
} from "@/lib/voice";
import { evaluate, pick, freshMemory, LEVELS, type FeedbackLevel, type CoachMemory } from "@/lib/coach";

interface Props {
  snapRef: React.MutableRefObject<Snapshot | null>;
  registerPttHandler: (fn: (pressed: boolean) => void) => void;
  registerEventHandler: (fn: (ev: RaceEvent) => void) => void;
}

type LogItem =
  | (ChatMsg & { kind: "chat" })
  | { kind: "event"; content: string; ts: number }
  | { kind: "callout"; content: string; ts: number };

export default function RadioPanel({ snapRef, registerPttHandler, registerEventHandler }: Props) {
  const [log, setLog] = useState<LogItem[]>([]);
  const [live, setLive] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [interim, setInterim] = useState("");
  const [typed, setTyped] = useState("");
  const [level, setLevel] = useState<FeedbackLevel>("medium");
  const [voiceOut, setVoiceOut] = useState(true);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState("");
  const [serverTts, setServerTts] = useState(false);
  const [mounted, setMounted] = useState(false);

  const historyRef = useRef<ChatMsg[]>([]);
  const busyRef = useRef(false); // true while the radio is occupied
  const scrollRef = useRef<HTMLDivElement>(null);
  const memRef = useRef<CoachMemory>(freshMemory());
  const lastFiredRef = useRef<Record<string, number>>({});
  const lastCalloutAtRef = useRef(0);
  const recentLinesRef = useRef<string[]>([]);

  const levelRef = useRef(level); levelRef.current = level;
  const voiceOutRef = useRef(voiceOut); voiceOutRef.current = voiceOut;
  const voiceNameRef = useRef(voiceName); voiceNameRef.current = voiceName;
  const serverTtsRef = useRef(serverTts); serverTtsRef.current = serverTts;

  useEffect(() => {
    setMounted(true);
    loadVoices().then(() => {
      const list = englishVoices();
      setVoices(list);
      setVoiceName(defaultVoiceName());
    });
    fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "" }) })
      .then((r) => setServerTts(r.status !== 501))
      .catch(() => setServerTts(false));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [log, interim]);

  const say = useCallback((text: string) => {
    if (!voiceOutRef.current) return;
    speak(text, { voiceName: voiceNameRef.current, serverTts: serverTtsRef.current });
  }, []);

  // --- driver-initiated conversation ---
  const ask = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || busyRef.current) return;
      busyRef.current = true;
      const userMsg: ChatMsg = { role: "user", content: clean, ts: Date.now() };
      historyRef.current = [...historyRef.current, userMsg].slice(-20);
      setLog((l) => [...l, { ...userMsg, kind: "chat" }]);
      setThinking(true);
      try {
        const res = await fetch("/api/engineer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: historyRef.current, snapshot: snapRef.current }),
        });
        const data = await res.json();
        const reply: string = data.reply ?? data.error ?? "Radio failure, say again.";
        const engMsg: ChatMsg = { role: "assistant", content: reply, ts: Date.now() };
        historyRef.current = [...historyRef.current, engMsg].slice(-20);
        setLog((l) => [...l, { ...engMsg, kind: "chat" }]);
        say(reply);
      } catch {
        setLog((l) => [...l, { kind: "event", content: "Lost the link to the engineer. Check the web server logs.", ts: Date.now() }]);
      } finally {
        setThinking(false);
        busyRef.current = false;
        lastCalloutAtRef.current = Date.now(); // don't talk over the answer
      }
    },
    [snapRef, say]
  );

  // --- continuous feedback loop ---
  useEffect(() => {
    const tick = setInterval(async () => {
      const lvl = levelRef.current;
      if (lvl === "off") return;
      const snap = snapRef.current;
      if (!snap || !snap.ts) return;
      if (busyRef.current) return;

      const cfg = LEVELS[lvl];
      const now = Date.now();
      if (now - lastCalloutAtRef.current < cfg.minGapMs) {
        // still evaluate so memory (best lap, position) stays current
        evaluate(snap, memRef.current);
        return;
      }

      const candidates = evaluate(snap, memRef.current);
      const chosen = pick(candidates, lvl, lastFiredRef.current);
      if (!chosen) return;

      lastFiredRef.current[chosen.id] = now;
      lastCalloutAtRef.current = now;
      busyRef.current = true;
      try {
        const res = await fetch("/api/callout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fact: chosen.fact, recent: recentLinesRef.current, snapshot: snap }),
        });
        const data = await res.json();
        const line: string | undefined = data.line;
        if (line) {
          recentLinesRef.current = [...recentLinesRef.current, line].slice(-6);
          const calloutMsg: ChatMsg = { role: "assistant", content: line, ts: Date.now() };
          historyRef.current = [...historyRef.current, calloutMsg].slice(-20);
          setLog((l) => [...l.slice(-100), { kind: "callout", content: line, ts: Date.now() }]);
          say(line);
        }
      } catch {
        /* skip this call, try again next tick */
      } finally {
        busyRef.current = false;
        lastCalloutAtRef.current = Date.now();
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [snapRef, say]);

  // --- push to talk ---
  const pttDown = useCallback(() => {
    if (busyRef.current || !sttSupported()) return;
    cancelSpeech();
    setLive(true);
    squelch(true);
    startListening(setInterim);
  }, []);

  const pttUp = useCallback(async () => {
    setLive(false);
    squelch(false);
    const text = await stopListening();
    setInterim("");
    if (text) ask(text);
  }, [ask]);

  useEffect(() => {
    const held = { v: false };
    registerPttHandler((pressed) => {
      if (pressed && !held.v) {
        held.v = true;
        pttDown();
      } else if (!pressed && held.v) {
        held.v = false;
        pttUp();
      }
    });
    registerEventHandler((ev) => {
      setLog((l) => [...l.slice(-100), { kind: "event", content: ev.message, ts: ev.ts }]);
    });
  }, [registerPttHandler, registerEventHandler, pttDown, pttUp]);

  useEffect(() => {
    const isTyping = (t: EventTarget | null) => (t as HTMLElement)?.tagName === "INPUT" || (t as HTMLElement)?.tagName === "SELECT";
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTyping(e.target)) {
        e.preventDefault();
        pttDown();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e.target)) {
        e.preventDefault();
        pttUp();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [pttDown, pttUp]);

  return (
    <div className="radio">
      <div className={`onair ${live ? "live" : thinking ? "thinking" : ""}`}>
        {live ? "● ON AIR" : thinking ? "engineer thinking…" : "radio idle · hold PTT or space"}
      </div>

      <div className="transcript" ref={scrollRef}>
        {log.length === 0 && (
          <div className="msg event"><div className="bubble">
            Hold your PTT button or spacebar and talk. Your engineer will also call in on his own, as often as the feedback setting below allows.
          </div></div>
        )}
        {log.map((m, i) =>
          m.kind === "event" ? (
            <div className="msg event" key={i}><div className="bubble">{m.content}</div></div>
          ) : m.kind === "callout" ? (
            <div className="msg eng" key={i}>
              <div className="who">ENGINEER · UNPROMPTED</div>
              <div className="bubble">{m.content}</div>
            </div>
          ) : (
            <div className={`msg ${m.role === "user" ? "user" : "eng"}`} key={i}>
              <div className="who">{m.role === "user" ? "YOU" : "ENGINEER"}</div>
              <div className="bubble">{m.content}</div>
            </div>
          )
        )}
        {interim && (
          <div className="msg user"><div className="who">YOU · LIVE</div><div className="bubble">{interim}…</div></div>
        )}
      </div>

      <div className="radiofoot">
        <input
          type="text"
          placeholder="Type to your engineer…"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typed.trim()) {
              ask(typed);
              setTyped("");
            }
          }}
        />
        <button onClick={() => { if (typed.trim()) { ask(typed); setTyped(""); } }}>Send</button>
      </div>

      <div className="settings">
        <label className="setting">
          <span className="k">Auto feedback</span>
          <select value={level} onChange={(e) => setLevel(e.target.value as FeedbackLevel)}>
            <option value="off">Off · only when asked</option>
            <option value="low">{LEVELS.low.label}</option>
            <option value="medium">{LEVELS.medium.label}</option>
            <option value="high">{LEVELS.high.label}</option>
          </select>
        </label>
        <label className="setting">
          <span className="k">Voice</span>
          <select value={voiceName} onChange={(e) => setVoiceName(e.target.value)} disabled={serverTts}>
            {serverTts && <option>ElevenLabs (server)</option>}
            {!serverTts && voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} {/en[-_]GB/i.test(v.lang) ? "· UK" : `· ${v.lang}`}
              </option>
            ))}
          </select>
        </label>
        <div className="settingrow">
          <label className="toggle">
            <input type="checkbox" checked={voiceOut} onChange={(e) => setVoiceOut(e.target.checked)} /> Speak replies
          </label>
          <button className="ghost" onClick={() => { cancelSpeech(); say("Radio check, loud and clear."); }}>
            Test voice
          </button>
        </div>
        {mounted && !sttSupported() && <span className="hint">Mic input needs Chrome or Edge</span>}
        {mounted && voices.length > 0 && !serverTts && !/en[-_]GB/i.test(voices.find((v) => v.name === voiceName)?.lang ?? "") && (
          <span className="hint">No UK voice installed. On macOS add one in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices (Daniel or Oliver).</span>
        )}
      </div>
    </div>
  );
}
