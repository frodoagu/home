// The HTTP API, as a plain fetch handler (Bun.serve in server.js; tests call
// it directly). Everything lives under /api on psy.agu.com.ar:
//
//   GET    /api/health    { ok, clientId }: lets the page decide to show the cloud UI
//   POST   /api/session   { credential } (a Google ID token) -> session cookie
//   GET    /api/session   { email } ({ email: null } when signed out); an
//                         X-Psy-Visitor header (the page's random browser id)
//                         is recorded for the anonymous-visitor metrics
//   DELETE /api/session   sign out
//   GET    /api/state     { state, updatedAt } or 404
//   PUT    /api/state     { state, base, force?, device? } -> { updatedAt }, or
//                         409 with the newer stored copy when `base` is stale,
//                         or 409 { taken: true } when another device holds the
//                         account (see /api/device)
//   PUT    /api/device    { device, playing, take? }: claim the account for this
//                         device, and every beat after it -> { ok }, or 409
//                         { playing } while another device holds it (`take`
//                         takes it anyway)
//   DELETE /api/device    { device }: let go of it (the tab is closing)
//   DELETE /api/account   forget the user and their data
//   GET    /api/samples   { samples: [{ id, name, type, bytes, createdAt }], used, limits }
//   POST   /api/samples?name=…   the raw audio file -> 201 { id, … }; 413 too
//                         big, 415 not audio, 507 no room (`error`: quota,
//                         count or full)
//   GET    /api/samples/:id   the file, to its owner only
//   DELETE /api/samples/:id
//   POST   /api/stats     { visitor, played?, recordings?, … } (see USAGE in
//                         db.js): what this browser did since its last report,
//                         added to its day; 404 for a browser the session
//                         check never recorded
//
// The server never interprets a workspace: it stores an opaque JSON object
// (size-capped) and the page runs it through normalize() on the way back in.
// Samples are opaque too, past a check that they start like an audio file.
//
// An account plays on one device at a time. The device holding it beats
// every few seconds; one that has not beaten for ACTIVE_MS has left. The
// leases live in memory: a restart frees them all and the next beat takes
// each one back, so they never touch the SD card.
import { USAGE, dayOf } from "./db.js";
import { verifyIdToken } from "./google.js";
import { requestCounter } from "./metrics.js";
import { SAMPLE_PATH, cleanName, sampleId, sniffAudio } from "./samples.js";
import { SESSION_MS, cookieValue, readSession, setCookie, signSession } from "./session.js";

const MAX_BYTES = 256 * 1024;
const MAX_VISITORS = 100_000;
const MAX_USAGE_ROWS = 5000; // browsers reporting in one day
const VISITOR_ID = /^[\w-]{16,64}$/;
export const ACTIVE_MS = 70_000; // past a hidden tab's once-a-minute timers
const ROUTES = new Set([
  "GET /api/health",
  "POST /api/session",
  "GET /api/session",
  "DELETE /api/session",
  "GET /api/state",
  "PUT /api/state",
  "PUT /api/device",
  "DELETE /api/device",
  "DELETE /api/account",
  "GET /api/samples",
  "POST /api/samples",
  "GET /api/samples/:id",
  "DELETE /api/samples/:id",
  "POST /api/stats",
]);
const PUBLIC = ["GET /api/health", "POST /api/session", "GET /api/session", "DELETE /api/session", "POST /api/stats"];
const PRIVATE = new Set([...ROUTES].filter((r) => !PUBLIC.includes(r)));

const MiB = 2 ** 20;
export const SAMPLE_LIMITS = { bytes: 3 * MiB, count: 24, quota: 100 * MiB, total: 1024 * MiB };

// "/api/samples/<id>" counts as one route.
const routeOf = (method, pathname) => `${method} ${SAMPLE_PATH.test(pathname) ? "/api/samples/:id" : pathname}`;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
const empty = (status, headers = {}) => new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });

export function createApp({
  db,
  clientId,
  key,
  origins,
  getKey,
  now = Date.now,
  maxBytes = MAX_BYTES,
  maxUsers = 5000,
  maxVisitors = MAX_VISITORS,
  maxUsageRows = MAX_USAGE_ROWS,
  activeMs = ACTIVE_MS,
  samples: sampleLimits = {},
}) {
  const sampleMax = { ...SAMPLE_LIMITS, ...sampleLimits };
  const requests = requestCounter();
  const leases = new Map(); // sub -> { device, playing, seenAt }

  function holder(sub) {
    const lease = leases.get(sub);
    if (lease && now() - lease.seenAt < activeMs) return lease;
    leases.delete(sub);
    return null;
  }

  async function currentUser(req) {
    const sub = await readSession(key, cookieValue(req), now());
    const user = sub ? db.user(sub) : null;
    if (user) db.touchUser(user.sub, now());
    return user;
  }

  async function readBody(req) {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > maxBytes) return { error: 413 };
    const text = await req.text();
    if (new TextEncoder().encode(text).length > maxBytes) return { error: 413 };
    try {
      return { body: JSON.parse(text) };
    } catch {
      return { error: 400 };
    }
  }

  async function signIn(req) {
    const { body, error } = await readBody(req);
    if (error) return empty(error);
    let claims;
    try {
      claims = await verifyIdToken(body?.credential, { clientId, getKey, now });
    } catch {
      return json({ error: "invalid credential" }, 401);
    }
    if (!db.user(claims.sub) && db.countUsers() >= maxUsers) return json({ error: "full" }, 503);
    db.upsertUser(claims.sub, claims.email, now());
    const expires = now() + SESSION_MS;
    const cookie = setCookie(await signSession(key, claims.sub, expires), SESSION_MS / 1000);
    return json({ email: claims.email, name: claims.name ?? "" }, 200, { "set-cookie": cookie });
  }

  async function putState(req, user) {
    const { body, error } = await readBody(req);
    if (error) return empty(error);
    const { state, base = null, force = false, device = null } = body ?? {};
    if (!state || typeof state !== "object" || Array.isArray(state)) return json({ error: "state must be an object" }, 400);
    // A device that lost the account must not save over the one playing now.
    // With no lease (expired, or the pod restarted) nobody else claimed it:
    // the save takes it back, like a beat, rather than cutting off the only
    // device there is.
    const lease = holder(user.sub);
    if (device && lease && lease.device !== device) return json({ taken: true }, 409);
    if (device && !lease && VISITOR_ID.test(device)) leases.set(user.sub, { device, playing: false, seenAt: now() });
    const stored = db.state(user.sub);
    if (stored && !force && stored.updated_at !== base) {
      return json({ state: JSON.parse(stored.data), updatedAt: stored.updated_at }, 409);
    }
    // Strictly increasing, so two saves in the same millisecond never look equal.
    const updatedAt = Math.max(now(), (stored?.updated_at ?? 0) + 1);
    db.putState(user.sub, JSON.stringify(state), updatedAt);
    return json({ updatedAt });
  }

  async function putDevice(req, user) {
    const { body, error } = await readBody(req);
    if (error) return empty(error);
    const { device, playing = false, take = false } = body ?? {};
    if (!VISITOR_ID.test(device ?? "")) return json({ error: "bad device" }, 400);
    const lease = holder(user.sub);
    if (lease && lease.device !== device && !take) return json({ playing: lease.playing }, 409);
    leases.set(user.sub, { device, playing: playing === true, seenAt: now() });
    return json({ ok: true });
  }

  async function deleteDevice(req, user) {
    const { body, error } = await readBody(req);
    if (error) return empty(error);
    if (leases.get(user.sub)?.device === body?.device) leases.delete(user.sub);
    return empty(204);
  }

  // Usage numbers come from the page, so anyone can send them: each one is
  // clamped to what a real session could add, and USAGE caps the day.
  async function addStats(req) {
    const { body, error } = await readBody(req);
    if (error) return empty(error);
    if (!VISITOR_ID.test(body?.visitor ?? "")) return json({ error: "bad visitor" }, 400);
    const counts = {};
    for (const [name, { report }] of Object.entries(USAGE)) {
      const n = Number(body[name] ?? 0);
      counts[name] = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), report) : 0;
    }
    if (Object.values(counts).every((n) => n === 0)) return empty(204);
    const result = db.addUsage(body.visitor, dayOf(now()), counts, maxUsageRows);
    if (result === "unknown") return json({ error: "unknown visitor" }, 404);
    return result === "full" ? json({ error: "full" }, 507) : empty(204);
  }

  function listSamples(user) {
    const { count, bytes } = db.sampleUsage(user.sub);
    const { bytes: max, count: maxCount, quota } = sampleMax;
    return json({ samples: db.samples(user.sub), used: { count, bytes }, limits: { bytes: max, count: maxCount, quota } });
  }

  // The file is the body, as is. Every limit is checked before it is stored:
  // the file's own size, the user's count and bytes, the volume's share.
  async function uploadSample(req, user) {
    if (Number(req.headers.get("content-length") ?? 0) > sampleMax.bytes) return json({ error: "too big" }, 413);
    const data = new Uint8Array(await req.arrayBuffer());
    if (data.length > sampleMax.bytes) return json({ error: "too big" }, 413);
    const type = sniffAudio(data);
    if (!type) return json({ error: "not audio" }, 415);
    const used = db.sampleUsage(user.sub);
    if (used.count >= sampleMax.count) return json({ error: "count" }, 507);
    if (used.bytes + data.length > sampleMax.quota) return json({ error: "quota" }, 507);
    if (db.sampleBytesTotal() + data.length > sampleMax.total) return json({ error: "full" }, 507);
    const sample = { id: sampleId(), name: cleanName(new URL(req.url).searchParams.get("name")), type, createdAt: now() };
    db.putSample({ ...sample, sub: user.sub, data });
    return json({ ...sample, bytes: data.length }, 201);
  }

  function getSample(user, id) {
    const row = db.sample(user.sub, id);
    if (!row) return json({ error: "not found" }, 404);
    return new Response(row.data, {
      headers: {
        "content-type": row.type,
        // An id never changes its bytes.
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-disposition": "attachment",
      },
    });
  }

  async function handle(req) {
    const { pathname } = new URL(req.url);
    const route = routeOf(req.method, pathname);
    if (route === "GET /api/health") return json({ ok: true, clientId });

    // Cookies are SameSite=Lax, and every write must also come from our own page.
    if (req.method !== "GET" && !origins.includes(req.headers.get("origin"))) return json({ error: "bad origin" }, 403);

    if (route === "POST /api/session") return signIn(req);
    if (route === "DELETE /api/session") return empty(204, { "set-cookie": setCookie("", 0) });
    if (route === "POST /api/stats") return addStats(req);

    const user = await currentUser(req);
    // Asked on every page load: a signed-out visitor is not an error.
    if (route === "GET /api/session") {
      const visitor = req.headers.get("x-psy-visitor");
      if (VISITOR_ID.test(visitor ?? "")) db.visit(visitor, user?.sub ?? null, now(), maxVisitors);
      return json({ email: user?.email ?? null });
    }
    if (!user) return PRIVATE.has(route) ? json({ error: "signed out" }, 401) : json({ error: "not found" }, 404);
    if (route === "GET /api/state") {
      const stored = db.state(user.sub);
      return stored ? json({ state: JSON.parse(stored.data), updatedAt: stored.updated_at }) : json({ error: "none" }, 404);
    }
    if (route === "PUT /api/state") return putState(req, user);
    if (route === "PUT /api/device") return putDevice(req, user);
    if (route === "DELETE /api/device") return deleteDevice(req, user);
    if (route === "DELETE /api/account") {
      db.deleteUser(user.sub);
      leases.delete(user.sub);
      return empty(204, { "set-cookie": setCookie("", 0) });
    }
    if (route === "GET /api/samples") return listSamples(user);
    if (route === "POST /api/samples") return uploadSample(req, user);
    const id = SAMPLE_PATH.exec(pathname)?.[1];
    if (route === "GET /api/samples/:id") return getSample(user, id);
    if (route === "DELETE /api/samples/:id") {
      return db.deleteSample(user.sub, id) ? empty(204) : json({ error: "not found" }, 404);
    }
    return json({ error: "not found" }, 404);
  }

  return {
    requests,
    limits: { maxBytes, maxUsers, maxVisitors, maxUsageRows, samples: sampleMax },
    async fetch(req) {
      const route = routeOf(req.method, new URL(req.url).pathname);
      let res;
      try {
        res = await handle(req);
      } catch (err) {
        console.error(`${route}: ${err.message}`);
        res = json({ error: "internal" }, 500);
      }
      requests.add(ROUTES.has(route) ? route : "other", res.status);
      return res;
    },
  };
}
