import { beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { verifyIdToken } from "./google.js";
import { parseQuantity, renderMetrics } from "./metrics.js";
import { hmacKey, readSession, signSession } from "./session.js";

const CLIENT = "client-123.apps.googleusercontent.com";
const ORIGIN = "https://psy.agu.com.ar";
const enc = new TextEncoder();
const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// A stand-in for Google: one RSA key, tokens signed with it.
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const other = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const getKey = async (kid) => {
  if (kid !== "k1") throw new Error("unknown key");
  return pair.publicKey;
};

let clock;
async function token(claims = {}, signer = pair.privateKey, header = { alg: "RS256", kid: "k1" }) {
  const body = {
    iss: "https://accounts.google.com",
    aud: CLIENT,
    sub: "1001",
    email: "ana@example.com",
    email_verified: true,
    name: "Ana",
    exp: Math.floor(clock / 1000) + 3600,
    ...claims,
  };
  const data = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(body)))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

let app;
let db;
let key;
beforeEach(async () => {
  clock = 1_800_000_000_000;
  db = openDb(":memory:");
  key = await hmacKey("test-secret");
  app = createApp({ db, clientId: CLIENT, key, origins: [ORIGIN], getKey, now: () => clock, maxBytes: 2048, maxUsers: 2 });
});

const call = (method, path, { body, cookie, origin = ORIGIN, visitor } = {}) =>
  app.fetch(
    new Request(`https://psy.agu.com.ar${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
        ...(visitor ? { "x-psy-visitor": visitor } : {}),
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const cookieOf = (res) => res.headers.get("set-cookie").split(";")[0];
async function signIn(claims) {
  const res = await call("POST", "/api/session", { body: { credential: await token(claims) } });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

describe("Google ID tokens", () => {
  const verify = (t) => verifyIdToken(t, { clientId: CLIENT, getKey, now: () => clock });

  it("accepts a valid token and returns its claims", async () => {
    expect((await verify(await token())).email).toBe("ana@example.com");
  });

  it("rejects forged, foreign, expired and unverified tokens", async () => {
    const bad = [
      await token({}, other.privateKey),
      await token({ aud: "someone-else" }),
      await token({ iss: "https://evil.example" }),
      await token({ exp: Math.floor(clock / 1000) - 120 }),
      await token({ email_verified: false }),
      await token({}, pair.privateKey, { alg: "none", kid: "k1" }),
      await token({}, pair.privateKey, { alg: "RS256", kid: "k2" }),
      "not.a.token",
      "garbage",
    ];
    for (const t of bad) await expect(verify(t)).rejects.toThrow();
  });
});

describe("sessions", () => {
  it("sign and read back; tampered or expired cookies read as nobody", async () => {
    const value = await signSession(key, "1001", clock + 1000);
    expect(await readSession(key, value, clock)).toBe("1001");
    expect(await readSession(key, value.replace("1001", "1002"), clock)).toBeNull();
    expect(await readSession(key, value, clock + 1000)).toBeNull();
    expect(await readSession(await hmacKey("other"), value, clock)).toBeNull();
    expect(await readSession(key, null, clock)).toBeNull();
  });
});

describe("API", () => {
  it("health tells the page the client id", async () => {
    expect(await (await call("GET", "/api/health")).json()).toEqual({ ok: true, clientId: CLIENT });
  });

  it("signs in with a Google credential and sets an HttpOnly, Secure cookie on /api", async () => {
    const res = await call("POST", "/api/session", { body: { credential: await token() } });
    expect(await res.json()).toEqual({ email: "ana@example.com", name: "Ana" });
    const set = res.headers.get("set-cookie");
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api"]) expect(set).toContain(attr);
    const me = await call("GET", "/api/session", { cookie: cookieOf(res) });
    expect(await me.json()).toEqual({ email: "ana@example.com" });
  });

  it("refuses a bad credential, and everything private without a session", async () => {
    expect((await call("POST", "/api/session", { body: { credential: "x" } })).status).toBe(401);
    expect(await (await call("GET", "/api/session")).json()).toEqual({ email: null });
    expect((await call("GET", "/api/state")).status).toBe(401);
    expect((await call("PUT", "/api/state", { body: { state: {} } })).status).toBe(401);
  });

  it("refuses writes from another origin or without one", async () => {
    const cookie = await signIn();
    expect((await call("PUT", "/api/state", { cookie, body: { state: {} }, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("PUT", "/api/state", { cookie, body: { state: {} }, origin: null })).status).toBe(403);
    expect((await call("POST", "/api/session", { body: { credential: await token() }, origin: null })).status).toBe(403);
  });

  it("stores the workspace, returns it, and only to its owner", async () => {
    const ana = await signIn();
    const bob = await signIn({ sub: "2002", email: "bob@example.com" });
    expect((await call("GET", "/api/state", { cookie: ana })).status).toBe(404);
    const put = await call("PUT", "/api/state", { cookie: ana, body: { state: { bpm: 150 }, base: null } });
    expect(await put.json()).toEqual({ updatedAt: clock });
    expect(await (await call("GET", "/api/state", { cookie: ana })).json()).toEqual({ state: { bpm: 150 }, updatedAt: clock });
    expect((await call("GET", "/api/state", { cookie: bob })).status).toBe(404);
  });

  it("a stale base gets 409 with the newer copy; force overwrites", async () => {
    const cookie = await signIn();
    const first = await (await call("PUT", "/api/state", { cookie, body: { state: { v: 1 }, base: null } })).json();
    clock += 10;
    await call("PUT", "/api/state", { cookie, body: { state: { v: 2 }, base: first.updatedAt } });
    const stale = await call("PUT", "/api/state", { cookie, body: { state: { v: 3 }, base: first.updatedAt } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ state: { v: 2 }, updatedAt: clock });
    const forced = await call("PUT", "/api/state", { cookie, body: { state: { v: 3 }, base: first.updatedAt, force: true } });
    expect(forced.status).toBe(200);
    expect((await (await call("GET", "/api/state", { cookie })).json()).state).toEqual({ v: 3 });
  });

  it("timestamps only go up, even within the same millisecond", async () => {
    const cookie = await signIn();
    const a = await (await call("PUT", "/api/state", { cookie, body: { state: {}, base: null } })).json();
    const b = await (await call("PUT", "/api/state", { cookie, body: { state: {}, base: a.updatedAt } })).json();
    expect(b.updatedAt).toBe(a.updatedAt + 1);
  });

  it("rejects oversized, non-JSON and non-object states", async () => {
    const cookie = await signIn();
    const big = { state: { x: "a".repeat(3000) }, base: null };
    expect((await call("PUT", "/api/state", { cookie, body: big })).status).toBe(413);
    expect((await call("PUT", "/api/state", { cookie, body: "{nope" })).status).toBe(400);
    expect((await call("PUT", "/api/state", { cookie, body: { state: [1], base: null } })).status).toBe(400);
    expect((await call("PUT", "/api/state", { cookie, body: { state: "s", base: null } })).status).toBe(400);
  });

  it("caps the number of accounts, but existing ones keep signing in", async () => {
    await signIn({ sub: "1" });
    await signIn({ sub: "2" });
    const third = await call("POST", "/api/session", { body: { credential: await token({ sub: "3" }) } });
    expect(third.status).toBe(503);
    await signIn({ sub: "1" });
  });

  it("deleting the account forgets the data and voids the cookie", async () => {
    const cookie = await signIn();
    await call("PUT", "/api/state", { cookie, body: { state: { v: 1 }, base: null } });
    const del = await call("DELETE", "/api/account", { cookie });
    expect(del.status).toBe(204);
    expect(del.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await (await call("GET", "/api/session", { cookie })).json()).toEqual({ email: null });
    expect((await call("GET", "/api/state", { cookie })).status).toBe(401);
    expect(db.state("1001")).toBeNull();
  });

  it("signing out clears the cookie", async () => {
    const res = await call("DELETE", "/api/session");
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("answers JSON 404 for anything else, and never caches", async () => {
    expect((await call("GET", "/api/nope")).status).toBe(404);
    const cookie = await signIn();
    const nope = await call("GET", "/api/nope", { cookie });
    expect(nope.status).toBe(404);
    expect(nope.headers.get("cache-control")).toBe("no-store");
  });
});

describe("visitors and metrics", () => {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const A = "aaaaaaaaaaaaaaaa";
  const B = "bbbbbbbbbbbbbbbb";
  const stats = () => db.stats(clock, 10);

  it("records anonymous browsers from the session check, and ignores malformed ids", async () => {
    await call("GET", "/api/session", { visitor: A });
    await call("GET", "/api/session", { visitor: A });
    await call("GET", "/api/session", { visitor: "short" });
    await call("GET", "/api/session", { visitor: `${B}/../x` });
    await call("GET", "/api/health", { visitor: B });
    expect(stats()).toMatchObject({ visitors: 1, anonymous: 1, anonymousActive: { "1d": 1 } });
  });

  it("a signed-in check links the browser to the account; deleting the account makes it anonymous again", async () => {
    await call("GET", "/api/session", { visitor: A });
    const cookie = await signIn();
    await call("GET", "/api/session", { cookie, visitor: A });
    expect(stats()).toMatchObject({ visitors: 1, anonymous: 0 });
    await call("DELETE", "/api/account", { cookie });
    expect(stats()).toMatchObject({ visitors: 1, anonymous: 1 });
  });

  it("stops storing new browsers at the cap, and prunes stale anonymous ones", async () => {
    app = createApp({ db, clientId: CLIENT, key, origins: [ORIGIN], getKey, now: () => clock, maxVisitors: 1 });
    await call("GET", "/api/session", { visitor: A });
    await call("GET", "/api/session", { visitor: B });
    expect(stats().visitors).toBe(1);
    clock += 100 * DAY;
    expect(db.pruneVisitors(clock - 90 * DAY)).toBe(1);
    expect(stats().visitors).toBe(0);
  });

  it("counts accounts created and seen per window; seen_at moves at most hourly", async () => {
    const cookie = await signIn();
    clock += 2 * DAY;
    await signIn({ sub: "2002", email: "bo@example.com" });
    expect(stats()).toMatchObject({ users: 2, usersCreated: { "1d": 1, "7d": 2 }, usersActive: { "1d": 1, "7d": 2 } });
    await call("GET", "/api/session", { cookie });
    expect(stats().usersActive["1d"]).toBe(2);
    // A check 30 min later writes nothing, so a day after the first one Ana is no longer active.
    clock += 30 * 60 * 1000;
    await call("GET", "/api/session", { cookie });
    clock += DAY - 15 * 60 * 1000;
    expect(stats().usersActive["1d"]).toBe(0);
  });

  it("reports each workspace's size in bytes, largest first", async () => {
    const ana = await signIn();
    const bo = await signIn({ sub: "2002", email: "bo@example.com" });
    await call("PUT", "/api/state", { cookie: ana, body: { state: { n: "ñ".repeat(100) }, base: null } });
    await call("PUT", "/api/state", { cookie: bo, body: { state: { n: 1 }, base: null } });
    const { sizes, top } = stats();
    expect(sizes.length).toBe(2);
    expect(top.map((t) => t.email)).toEqual(["ana@example.com", "bo@example.com"]);
    expect(top[0].bytes).toBe(JSON.stringify({ n: "ñ".repeat(100) }).length + 100);
  });

  it("counts requests by known route and status, folding the rest into `other`", async () => {
    await call("GET", "/api/health");
    await call("GET", "/api/state");
    await call("GET", "/api/whatever-123");
    expect(app.requests.entries()).toEqual([
      ["GET /api/health", "200", 1],
      ["GET /api/state", "401", 1],
      ["other", "404", 1],
    ]);
  });

  it("renders the Prometheus text format", async () => {
    const cookie = await signIn({ email: 'we"ird@example.com' });
    await call("PUT", "/api/state", { cookie, body: { state: { v: 1 }, base: null } });
    const text = renderMetrics({
      stats: stats(),
      requests: app.requests,
      limits: { ...app.limits, volumeRequest: parseQuantity("2Gi") },
      files: { db: 4096, wal: 0 },
      volume: { size: 100, avail: 40 },
    });
    expect(text).toContain("psy_sync_users 1\n");
    expect(text).toContain('psy_sync_users_created{window="7d"} 1\n');
    expect(text).toContain('psy_sync_user_workspace_bytes{email="we\\"ird@example.com"} 7\n');
    expect(text).toContain('psy_sync_workspaces_by_size{le="4096"} 1\n');
    expect(text).toContain('psy_sync_workspaces_by_size{le="+Inf"} 1\n');
    expect(text).toContain("psy_sync_volume_request_bytes 2147483648\n");
    expect(text).toContain('psy_sync_http_requests_total{route="POST /api/session",status="200"} 1\n');
    expect(text).toContain("# TYPE psy_sync_http_requests_total counter\n");
  });

  it("parses Kubernetes quantities", () => {
    expect(parseQuantity("2Gi")).toBe(2 * 2 ** 30);
    expect(parseQuantity("500M")).toBe(5e8);
    expect(parseQuantity("1024")).toBe(1024);
    expect(parseQuantity("lots")).toBe(0);
    expect(parseQuantity(undefined)).toBe(0);
  });
});
