// Entry point: SQLite and the session key on the data volume, then Bun.serve.
// The key is generated on first boot, so there is no Secret to create; losing
// the volume loses the data anyway, and with it every session.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { googleKeys } from "./google.js";
import { hmacKey } from "./session.js";

const dataDir = process.env.DATA_DIR ?? "/data";
const clientId = process.env.GOOGLE_CLIENT_ID;
const origins = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
if (!clientId || !origins.length) throw new Error("GOOGLE_CLIENT_ID and ALLOWED_ORIGINS are required");

const keyFile = join(dataDir, "session.key");
if (!existsSync(keyFile)) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  writeFileSync(keyFile, Buffer.from(bytes).toString("hex"), { mode: 0o600 });
}

const app = createApp({
  db: openDb(join(dataDir, "psy-sync.db")),
  clientId,
  key: await hmacKey(readFileSync(keyFile, "utf8").trim()),
  origins,
  getKey: googleKeys(),
  maxUsers: Number(process.env.MAX_USERS ?? 5000),
});

const server = Bun.serve({ port: Number(process.env.PORT ?? 8787), fetch: app.fetch, maxRequestBodySize: 512 * 1024 });
console.log(`psy-sync listening on :${server.port}`);
