import "dotenv/config";

const bool = (v, d) =>
  v === undefined || v === "" ? d : /^(1|true|yes)$/i.test(v);

export const config = {
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  model: process.env.ENGINEER_MODEL || "claude-sonnet-4-6",
  driverName: process.env.DRIVER_NAME || "mate",
  httpPort: Number(process.env.HTTP_PORT || 8080),

  f1: {
    port: Number(process.env.F1_UDP_PORT || 20777),
    pttMask: Number(process.env.F1_PTT_MASK || 0x00100000),
  },

  pttMode: (process.env.PTT_MODE || "hold").toLowerCase(),

  gt7: {
    ps5Ip: process.env.GT7_PS5_IP || "",
    receivePort: Number(process.env.GT7_RECEIVE_PORT || 33740),
    sendPort: Number(process.env.GT7_SEND_PORT || 33739),
  },

  // off | low | medium | high, see LEVELS in src/callouts.js
  feedbackLevel: (process.env.FEEDBACK_LEVEL || "medium").toLowerCase(),

  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || "",
    voiceId: process.env.ELEVENLABS_VOICE_ID || "",
    model: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
  },
};

// AUTO_CALLOUTS was a boolean; FEEDBACK_LEVEL replaces it with the four-way
// gate ported from the web app. Honour the old variable so existing .env files
// keep working.
if (bool(process.env.AUTO_CALLOUTS, true) === false)
  config.feedbackLevel = "off";
