import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e5) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Ported from web/app/api/tts/route.ts. With ELEVENLABS_API_KEY and
// ELEVENLABS_VOICE_ID set, the engineer speaks through a real voice model.
// Without them this returns 501 and public/app.js falls back to the best local
// UK voice, which is exactly how the browser probes for availability on load.
async function handleTts(req, res, log) {
  const { apiKey, voiceId, model } = config.elevenlabs;
  if (!apiKey || !voiceId) {
    res.writeHead(501);
    return res.end();
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  // An empty text is the browser's capability probe: we got this far, so the
  // route is configured. Answer 204 rather than burning a character quota.
  if (!body.text) {
    res.writeHead(204);
    return res.end();
  }

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_22050_32`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          text: body.text,
          model_id: model,
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.75,
            style: 0.15,
            use_speaker_boost: true,
          },
        }),
      },
    );

    if (!upstream.ok) {
      log.error(
        "[tts] elevenlabs",
        upstream.status,
        (await upstream.text()).slice(0, 200),
      );
      res.writeHead(502);
      return res.end();
    }

    res.writeHead(200, {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
    });
    // Stream it through rather than buffering, so playback can start early.
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (e) {
    log.error("[tts]", e.message);
    res.writeHead(502);
    res.end();
  }
}

export function startServer(port, onClientMessage, log = console) {
  const server = http.createServer(async (req, res) => {
    const url = req.url.split("?")[0];

    if (url === "/api/tts") {
      if (req.method !== "POST") {
        res.writeHead(405);
        return res.end();
      }
      return handleTts(req, res, log);
    }

    const file = url === "/" ? "/index.html" : url;
    const full = path.join(PUBLIC, path.normalize(file));
    if (!full.startsWith(PUBLIC)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(full)] || "application/octet-stream",
      });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    log.info("Dashboard connected");
    ws.on("message", (raw) => {
      try {
        onClientMessage(JSON.parse(raw.toString()), ws);
      } catch (e) {
        log.error("Bad client message:", e.message);
      }
    });
  });

  server.listen(port, () => log.info(`Dashboard: http://localhost:${port}`));

  return {
    broadcast(obj) {
      const s = JSON.stringify(obj);
      for (const c of wss.clients) if (c.readyState === 1) c.send(s);
    },
  };
}
