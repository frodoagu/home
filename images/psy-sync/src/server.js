// Entry point: SQLite and the session key on the data volume, then Bun.serve.
// The key is generated on first boot, so there is no Secret to create; losing
// the volume loses the data anyway, and with it every session. /metrics has a
// port of its own, which the IngressRoute never routes to.
import { existsSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { googleKeys } from "./google.js";
import { parseQuantity, renderMetrics } from "./metrics.js";
import { hmacKey } from "./session.js";

const HOUR = 3600 * 1000;
const VISITOR_RETENTION_MS = 90 * 24 * HOUR;

const dataDir = process.env.DATA_DIR ?? "/data";
const clientId = process.env.GOOGLE_CLIENT_ID;
const origins = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
if (!clientId || !origins.length) throw new Error("GOOGLE_CLIENT_ID and ALLOWED_ORIGINS are required");

const keyFile = join(dataDir, "session.key");
if (!existsSync(keyFile)) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  writeFileSync(keyFile, Buffer.from(bytes).toString("hex"), { mode: 0o600 });
}

const dbFile = join(dataDir, "psy-sync.db");
const db = openDb(dbFile);
const app = createApp({
  db,
  clientId,
  key: await hmacKey(readFileSync(keyFile, "utf8").trim()),
  origins,
  getKey: googleKeys(),
  maxUsers: Number(process.env.MAX_USERS ?? 5000),
});

const server = Bun.serve({ port: Number(process.env.PORT ?? 8787), fetch: app.fetch, maxRequestBodySize: 512 * 1024 });
console.log(`psy-sync listening on :${server.port}`);

const prune = () => db.pruneVisitors(Date.now() - VISITOR_RETENTION_MS);
prune();
setInterval(prune, HOUR);

const topUsers = Number(process.env.METRICS_TOP_USERS ?? 20);
const volumeRequest = parseQuantity(process.env.DATA_VOLUME_SIZE);
const sizeOf = (file) => (existsSync(file) ? statSync(file).size : 0);
const metrics = Bun.serve({
  port: Number(process.env.METRICS_PORT ?? 9787),
  fetch(req) {
    if (new URL(req.url).pathname !== "/metrics") return new Response("not found", { status: 404 });
    const fs = statfsSync(dataDir);
    const body = renderMetrics({
      stats: db.stats(Date.now(), topUsers),
      requests: app.requests,
      limits: { ...app.limits, volumeRequest },
      files: { db: sizeOf(dbFile), wal: sizeOf(`${dbFile}-wal`) },
      volume: { size: fs.blocks * fs.bsize, avail: fs.bavail * fs.bsize },
    });
    return new Response(body, { headers: { "content-type": "text/plain; version=0.0.4" } });
  },
});
console.log(`psy-sync metrics on :${metrics.port}`);
