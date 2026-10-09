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
//   PUT    /api/state     { state, base, force? } -> { updatedAt }, or 409 with
//                         the newer stored copy when `base` is stale
//   DELETE /api/account   forget the user and their data
//
// The server never interprets a workspace: it stores an opaque JSON object
// (size-capped) and the page runs it through normalize() on the way back in.
import { verifyIdToken } from "./google.js";
import { requestCounter } from "./metrics.js";
import { SESSION_MS, cookieValue, readSession, setCookie, signSession } from "./session.js";

const MAX_BYTES = 256 * 1024;
const MAX_VISITORS = 100_000;
const VISITOR_ID = /^[\w-]{16,64}$/;
const ROUTES = new Set([
  "GET /api/health",
  "POST /api/session",
  "GET /api/session",
  "DELETE /api/session",
  "GET /api/state",
  "PUT /api/state",
  "DELETE /api/account",
]);

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
}) {
  const requests = requestCounter();

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
    const { state, base = null, force = false } = body ?? {};
    if (!state || typeof state !== "object" || Array.isArray(state)) return json({ error: "state must be an object" }, 400);
    const stored = db.state(user.sub);
    if (stored && !force && stored.updated_at !== base) {
      return json({ state: JSON.parse(stored.data), updatedAt: stored.updated_at }, 409);
    }
    // Strictly increasing, so two saves in the same millisecond never look equal.
    const updatedAt = Math.max(now(), (stored?.updated_at ?? 0) + 1);
    db.putState(user.sub, JSON.stringify(state), updatedAt);
    return json({ updatedAt });
  }

  async function handle(req) {
    const { pathname } = new URL(req.url);
    const route = `${req.method} ${pathname}`;
    if (route === "GET /api/health") return json({ ok: true, clientId });

    // Cookies are SameSite=Lax, and every write must also come from our own page.
    if (req.method !== "GET" && !origins.includes(req.headers.get("origin"))) return json({ error: "bad origin" }, 403);

    if (route === "POST /api/session") return signIn(req);
    if (route === "DELETE /api/session") return empty(204, { "set-cookie": setCookie("", 0) });

    const user = await currentUser(req);
    // Asked on every page load: a signed-out visitor is not an error.
    if (route === "GET /api/session") {
      const visitor = req.headers.get("x-psy-visitor");
      if (VISITOR_ID.test(visitor ?? "")) db.visit(visitor, user?.sub ?? null, now(), maxVisitors);
      return json({ email: user?.email ?? null });
    }
    if (!user) {
      return ["GET /api/state", "PUT /api/state", "DELETE /api/account"].includes(route)
        ? json({ error: "signed out" }, 401)
        : json({ error: "not found" }, 404);
    }
    if (route === "GET /api/state") {
      const stored = db.state(user.sub);
      return stored ? json({ state: JSON.parse(stored.data), updatedAt: stored.updated_at }) : json({ error: "none" }, 404);
    }
    if (route === "PUT /api/state") return putState(req, user);
    if (route === "DELETE /api/account") {
      db.deleteUser(user.sub);
      return empty(204, { "set-cookie": setCookie("", 0) });
    }
    return json({ error: "not found" }, 404);
  }

  return {
    requests,
    limits: { maxBytes, maxUsers, maxVisitors },
    async fetch(req) {
      const route = `${req.method} ${new URL(req.url).pathname}`;
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
