import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
};

export function startServer(port, onClientMessage, log = console) {
  const server = http.createServer((req, res) => {
    let file = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const full = path.join(PUBLIC, path.normalize(file));
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    log.info("Dashboard connected");
    ws.on("message", (raw) => {
      try { onClientMessage(JSON.parse(raw.toString()), ws); }
      catch (e) { log.error("Bad client message:", e.message); }
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
