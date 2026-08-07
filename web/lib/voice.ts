"use client";

// Speech in and out. Input uses the browser SpeechRecognition API. Output
// prefers a server TTS voice (ElevenLabs, if a key is configured) and falls
// back to the OS speech synthesiser with a British voice picked automatically.

let recognition: any = null;
let finalTranscript = "";

export function sttSupported(): boolean {
  if (typeof window === "undefined") return false;
  return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
}

export function startListening(onInterim: (text: string) => void) {
  const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  if (!SR) return;
  finalTranscript = "";
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-GB";
  recognition.onresult = (e: any) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalTranscript += r[0].transcript;
      else interim += r[0].transcript;
    }
    onInterim((finalTranscript + " " + interim).trim());
  };
  recognition.start();
}

export function stopListening(): Promise<string> {
  return new Promise((resolve) => {
    if (!recognition) return resolve("");
    const r = recognition;
    recognition = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(finalTranscript.trim());
    };
    r.onend = finish;
    setTimeout(finish, 900);
    try {
      r.stop();
    } catch {
      finish();
    }
  });
}

// ---- voice selection ----

// Ranked by how close each is to a calm British pit-wall engineer. Names vary
// by OS and browser, so this is a preference order, not a guarantee.
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

let cachedVoices: SpeechSynthesisVoice[] = [];

export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve([]);
    const got = speechSynthesis.getVoices();
    if (got.length) {
      cachedVoices = got;
      return resolve(got);
    }
    // Chrome populates the list asynchronously
    const handler = () => {
      cachedVoices = speechSynthesis.getVoices();
      speechSynthesis.removeEventListener("voiceschanged", handler);
      resolve(cachedVoices);
    };
    speechSynthesis.addEventListener("voiceschanged", handler);
    setTimeout(() => resolve(speechSynthesis.getVoices()), 1200);
  });
}

export function englishVoices(): SpeechSynthesisVoice[] {
  const list = cachedVoices.length ? cachedVoices : (typeof window !== "undefined" ? speechSynthesis.getVoices() : []);
  return list
    .filter((v) => v.lang.toLowerCase().startsWith("en"))
    .sort((a, b) => {
      const gb = (v: SpeechSynthesisVoice) => (/en[-_]GB/i.test(v.lang) ? 0 : 1);
      if (gb(a) !== gb(b)) return gb(a) - gb(b);
      const rank = (v: SpeechSynthesisVoice) => {
        const i = BRITISH_PREFERENCE.indexOf(v.name);
        return i === -1 ? 99 : i;
      };
      return rank(a) - rank(b);
    });
}

export function defaultVoiceName(): string {
  const voices = englishVoices();
  for (const name of BRITISH_PREFERENCE) {
    const hit = voices.find((v) => v.name === name);
    if (hit) return hit.name;
  }
  const gb = voices.find((v) => /en[-_]GB/i.test(v.lang));
  return gb?.name ?? voices[0]?.name ?? "";
}

// ---- radio effects ----

let audioCtx: AudioContext | null = null;
function ctx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

export function squelch(open: boolean) {
  const ac = ctx();
  const dur = 0.07;
  const noise = ac.createBufferSource();
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.25;
  noise.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = open ? 2200 : 1400;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.4, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, ac.currentTime + dur);
  noise.connect(bp).connect(gain).connect(ac.destination);
  noise.start();
}

// ---- output ----

export interface SpeakOptions {
  voiceName?: string;
  serverTts?: boolean; // try the ElevenLabs route first
}

let currentAudio: HTMLAudioElement | null = null;

export function cancelSpeech() {
  speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

export async function speak(text: string, opts: SpeakOptions = {}, onDone?: () => void) {
  cancelSpeech();
  squelch(true);

  if (opts.serverTts) {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudio = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          currentAudio = null;
          squelch(false);
          onDone?.();
        };
        await audio.play();
        return;
      }
    } catch {
      // fall through to the browser voice
    }
  }

  const u = new SpeechSynthesisUtterance(text);
  // Measured and level, the way a real engineer talks over the radio.
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;
  u.lang = "en-GB";
  const voices = englishVoices();
  const chosen = voices.find((v) => v.name === opts.voiceName) ?? voices.find((v) => v.name === defaultVoiceName());
  if (chosen) u.voice = chosen;
  u.onend = () => {
    squelch(false);
    onDone?.();
  };
  speechSynthesis.speak(u);
}
