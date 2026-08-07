import "dotenv/config";

const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes)$/i.test(v));

export const config = {
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  model: process.env.ENGINEER_MODEL || "claude-sonnet-4-6",
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

  autoCallouts: bool(process.env.AUTO_CALLOUTS, true),
};
