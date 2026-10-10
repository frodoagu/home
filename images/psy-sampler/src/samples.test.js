import { describe, expect, it, vi } from "vitest";
import { MAX_SECONDS, createSamples, formatBytes, nameOf } from "./samples.js";

const LIMITS = { bytes: 1000, count: 3, quota: 2000 };
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(8) });

// A tiny psy-sync: one user, samples in a map.
function server() {
  const stored = new Map();
  let n = 0;
  const fetch = vi.fn(async (url, { method = "GET", body } = {}) => {
    const path = url.split("?")[0];
    if (method === "GET" && path === "/api/samples") {
      const samples = [...stored.values()].map((s) => ({ ...s }));
      return json(200, { samples, used: { count: samples.length, bytes: samples.reduce((a, s) => a + s.bytes, 0) }, limits: LIMITS });
    }
    if (method === "POST") {
      if (stored.size >= LIMITS.count) return json(507, { error: "count" });
      const id = `sample${String(++n).padStart(12, "0")}`;
      const name = new URLSearchParams(url.split("?")[1]).get("name");
      stored.set(id, { id, name, type: "audio/wav", bytes: body.byteLength, createdAt: n });
      return json(201, stored.get(id));
    }
    const id = path.split("/").pop();
    if (method === "DELETE") return json(stored.delete(id) ? 204 : 404, {});
    return stored.has(id) ? json(200, {}) : json(404, {});
  });
  return { fetch, stored };
}

const file = (name, size = 100) => ({ name, size, type: "audio/wav", arrayBuffer: async () => new ArrayBuffer(size) });
const decoded = (duration) => vi.fn(async () => ({ duration }));

describe("helpers", () => {
  it("names a sample after its file, without the extension", () => {
    expect(nameOf({ name: "Kick 909.wav" })).toBe("Kick 909");
    expect(nameOf({ name: ".wav" })).toBe("sample");
  });

  it("formats sizes in binary units", () => {
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(1536, "en")).toBe("1.5 kB");
    expect(formatBytes(3 * 2 ** 20, "es")).toBe("3 MB");
  });
});

describe("createSamples", () => {
  it("lists, uploads (decoded first), plays from cache, and deletes", async () => {
    const { fetch } = server();
    const decode = decoded(2);
    const samples = createSamples({ fetch, decode });
    const changes = vi.fn();
    samples.on(changes);
    await samples.refresh();
    expect(samples.info).toMatchObject({ ready: true, samples: [], limits: LIMITS });

    const s = await samples.upload(file("Clap.wav"));
    expect(s.name).toBe("Clap");
    expect(samples.info.used).toEqual({ count: 1, bytes: 100 });
    // Decoded before the upload; that buffer serves playback without a fetch.
    expect(samples.get(s.id)).toEqual({ duration: 2 });
    expect(await samples.load(s.id)).toEqual({ duration: 2 });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith(s.id))).toHaveLength(0);

    await samples.remove(s.id);
    expect(samples.info.samples).toEqual([]);
    expect(samples.info.used).toEqual({ count: 0, bytes: 0 });
    expect(samples.get(s.id)).toBeNull();
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("refuses big, long and undecodable files before uploading anything", async () => {
    const { fetch } = server();
    const samples = createSamples({ fetch, decode: decoded(MAX_SECONDS + 1) });
    await samples.refresh();
    await expect(samples.upload(file("big.wav", 1001))).rejects.toMatchObject({ code: "tooBig" });
    await expect(samples.upload(file("long.wav"))).rejects.toMatchObject({ code: "tooLong" });
    const broken = createSamples({ fetch, decode: vi.fn(async () => Promise.reject(new Error("bad"))) });
    await broken.refresh();
    await expect(broken.upload(file("x.txt"))).rejects.toMatchObject({ code: "format" });
    expect(fetch.mock.calls.some(([, opts]) => opts?.method === "POST")).toBe(false);
  });

  it("passes the server's limits on as error codes", async () => {
    const { fetch } = server();
    const samples = createSamples({ fetch, decode: decoded(1) });
    await samples.refresh();
    for (const name of ["a", "b", "c"]) await samples.upload(file(name));
    await expect(samples.upload(file("d"))).rejects.toMatchObject({ code: "count" });
  });

  it("loads a stored sample once, even when asked twice at the same time", async () => {
    const { fetch, stored } = server();
    stored.set("abcdefghijklmnop", { id: "abcdefghijklmnop", name: "x", bytes: 8 });
    const decode = decoded(1);
    const samples = createSamples({ fetch, decode });
    const [a, b] = await Promise.all([samples.load("abcdefghijklmnop"), samples.load("abcdefghijklmnop")]);
    expect(a).toBe(b);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(await samples.load("missingmissingmi")).toBeNull();
  });

  it("signed out: the list comes back empty", async () => {
    const samples = createSamples({ fetch: vi.fn(async () => json(401, {})), decode: decoded(1) });
    await samples.refresh();
    expect(samples.info).toMatchObject({ ready: false, samples: [] });
  });
});
