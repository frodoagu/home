import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentHash, createCloud, reconcile, visitorId } from "./cloud.js";

describe("reconcile", () => {
  const a = { bpm: 150 };
  const b = { bpm: 160 };
  const meta = (state, at) => ({ at, hash: contentHash(state) });

  it("pushes when the server has nothing", () => {
    expect(reconcile({ remote: null, meta: null, local: a })).toBe("push");
  });

  it("adopts when both already hold the same content", () => {
    expect(reconcile({ remote: { state: a, updatedAt: 9 }, meta: null, local: a })).toBe("adopt");
  });

  it("does nothing, or pushes local edits, when the server is where we left it", () => {
    expect(reconcile({ remote: { state: a, updatedAt: 5 }, meta: meta(b, 5), local: b })).toBe("none");
    expect(reconcile({ remote: { state: a, updatedAt: 5 }, meta: meta(a, 5), local: b })).toBe("push");
  });

  it("pulls a newer server copy when nothing changed here", () => {
    expect(reconcile({ remote: { state: b, updatedAt: 8 }, meta: meta(a, 5), local: a })).toBe("pull");
    expect(reconcile({ remote: { state: b, updatedAt: 8 }, meta: null, local: a, pristine: true })).toBe("pull");
  });

  it("asks when both sides changed (or this browser never synced and is not pristine)", () => {
    const local = { bpm: 170 };
    expect(reconcile({ remote: { state: b, updatedAt: 8 }, meta: meta(a, 5), local })).toBe("conflict");
    expect(reconcile({ remote: { state: b, updatedAt: 8 }, meta: null, local })).toBe("conflict");
  });
});

describe("createCloud", () => {
  let server;
  let storage;
  let calls;

  // A tiny in-memory psy-sync.
  function fakeFetch(url, { method = "GET", body, headers = {} } = {}) {
    calls.push(`${method} ${url}`);
    if (headers["x-psy-visitor"]) server.visitors.add(headers["x-psy-visitor"]);
    const reply = (status, data) =>
      Promise.resolve({
        status,
        headers: { get: () => (data === undefined ? "" : "application/json") },
        json: async () => data,
      });
    if (server.down) return Promise.reject(new TypeError("offline"));
    if (url === "/api/health") return reply(200, { ok: true, clientId: "cid" });
    if (url === "/api/session" && method === "GET") return reply(200, server.user ?? { email: null });
    if (url === "/api/session" && method === "POST") {
      server.user = { email: "ana@example.com", name: "Ana" };
      return reply(200, server.user);
    }
    if (url === "/api/session" && method === "DELETE") return reply(204);
    if (url === "/api/account") {
      server.state = null;
      return reply(204);
    }
    if (url === "/api/state" && method === "GET") return server.state ? reply(200, server.state) : reply(404, {});
    if (url === "/api/state" && method === "PUT") {
      const { state, base, force } = JSON.parse(body);
      if (server.state && !force && server.state.updatedAt !== base) return reply(409, server.state);
      server.state = { state, updatedAt: (server.state?.updatedAt ?? 0) + 1 };
      return reply(200, { updatedAt: server.state.updatedAt });
    }
    return reply(404, {});
  }

  beforeEach(() => {
    vi.useFakeTimers();
    server = { user: null, state: null, down: false, visitors: new Set() };
    storage = new Map();
    storage.getItem = (k) => storage.get(k) ?? null;
    storage.setItem = (k, v) => storage.set(k, v);
    storage.removeItem = (k) => storage.delete(k);
    calls = [];
  });

  const make = () => createCloud({ fetch: fakeFetch, storage, debounceMs: 100 });

  it("init reports availability and the signed-in user", async () => {
    const cloud = make();
    expect(await cloud.init()).toMatchObject({ available: true, clientId: "cid", user: null });
    server.user = { email: "ana@example.com" };
    expect((await make().init()).user).toEqual({ email: "ana@example.com" });
  });

  it("the session check carries one stable random id per browser", async () => {
    await make().init();
    await make().init();
    expect(server.visitors.size).toBe(1);
    expect([...server.visitors][0]).toBe(storage.get("psy-sampler:visitor"));
    expect([...server.visitors][0]).toMatch(/^[\w-]{16,64}$/);
  });

  it("without storage there is no visitor id", () => {
    expect(visitorId(null)).toBeNull();
    const broken = { getItem: () => null, setItem: () => { throw new Error("blocked"); } };
    expect(visitorId(broken)).toBeNull();
  });

  it("an API that is not there (HTML fallback, network error) reads as unavailable", async () => {
    const html = () =>
      Promise.resolve({ status: 200, headers: { get: () => "text/html" }, json: async () => ({}) });
    expect((await createCloud({ fetch: html }).init()).available).toBe(false);
    server.down = true;
    expect((await make().init()).available).toBe(false);
  });

  it("debounces saves into one upload, and skips content already synced", async () => {
    const cloud = make();
    await cloud.signIn("token");
    cloud.changed({ bpm: 150 });
    cloud.changed({ bpm: 151 });
    cloud.changed({ bpm: 152 });
    await vi.advanceTimersByTimeAsync(150);
    expect(calls.filter((c) => c === "PUT /api/state")).toHaveLength(1);
    expect(server.state.state).toEqual({ bpm: 152 });
    expect(cloud.info.phase).toBe("saved");
    cloud.changed({ bpm: 152 });
    await vi.advanceTimersByTimeAsync(150);
    expect(calls.filter((c) => c === "PUT /api/state")).toHaveLength(1);
  });

  it("nothing is uploaded while signed out", async () => {
    const cloud = make();
    cloud.changed({ bpm: 150 });
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toEqual([]);
  });

  it("another device's save turns the next upload into a conflict event", async () => {
    const cloud = make();
    await cloud.signIn("token");
    cloud.changed({ bpm: 150 });
    await vi.advanceTimersByTimeAsync(150);
    server.state = { state: { bpm: 99 }, updatedAt: 50 }; // saved elsewhere
    const events = [];
    cloud.on((e, d) => e === "conflict" && events.push(d));
    cloud.changed({ bpm: 151 });
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toEqual([{ state: { bpm: 99 }, updatedAt: 50 }]);
    expect(cloud.info.phase).toBe("conflict");
    expect((await cloud.push({ bpm: 151 }, { force: true })).ok).toBe(true);
  });

  it("check() + adopt() record the sync, so the next check is a no-op", async () => {
    const cloud = make();
    await cloud.signIn("token");
    server.state = { state: { bpm: 140 }, updatedAt: 3 };
    const first = await cloud.check({ bpm: 120 }, true);
    expect(first.action).toBe("pull");
    cloud.adopt(first.remote, { bpm: 140 });
    expect((await cloud.check({ bpm: 140 }, false)).action).toBe("adopt");
    server.state.state = { bpm: 141 }; // same version number, different content: never happens, but stays safe
    expect((await cloud.check({ bpm: 140 }, false)).action).toBe("none");
  });

  it("the sync record belongs to one account: another email starts over", async () => {
    const cloud = make();
    await cloud.signIn("token");
    cloud.changed({ bpm: 150 });
    await vi.advanceTimersByTimeAsync(150);
    cloud.info.user = { email: "bob@example.com" };
    server.state = { state: { bpm: 77 }, updatedAt: 9 };
    expect((await cloud.check({ bpm: 150 }, false)).action).toBe("conflict");
  });

  it("offline uploads report it and do not lose the change", async () => {
    const cloud = make();
    await cloud.signIn("token");
    server.down = true;
    cloud.changed({ bpm: 150 });
    await vi.advanceTimersByTimeAsync(150);
    expect(cloud.info.phase).toBe("offline");
    server.down = false;
    cloud.changed({ bpm: 150 }); // the next save retries it
    await vi.advanceTimersByTimeAsync(150);
    expect(server.state.state).toEqual({ bpm: 150 });
  });

  it("sign out and account deletion forget the sync record", async () => {
    const cloud = make();
    await cloud.signIn("token");
    cloud.changed({ bpm: 150 });
    await vi.advanceTimersByTimeAsync(150);
    expect(storage.get("psy-sampler:cloud")).toBeDefined();
    await cloud.signOut();
    expect(storage.has("psy-sampler:cloud")).toBe(false);
    expect(cloud.info.user).toBeNull();
    await cloud.signIn("token");
    await cloud.deleteAccount();
    expect(server.state).toBeNull();
    expect(cloud.info.user).toBeNull();
  });
});
