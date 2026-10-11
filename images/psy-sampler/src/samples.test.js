import { describe, expect, it, vi } from "vitest";
import { MAX_SOURCE_BYTES } from "./import/gather.js";
import { decodeWav } from "./import/pcm.js";
import { aiff, ramp, wav16 } from "./test/audioFiles.js";
import { MAX_SECONDS, createSamples, formatBytes, nameOf } from "./samples.js";

const LIMITS = { bytes: 100000, count: 3, quota: 200000 };
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(8) });

// A tiny psy-sync: one user, samples in a map (with their bytes).
function server(limits = LIMITS) {
  const stored = new Map();
  const files = new Map();
  let n = 0;
  const fetch = vi.fn(async (url, { method = "GET", body } = {}) => {
    const path = url.split("?")[0];
    if (method === "GET" && path === "/api/samples") {
      const samples = [...stored.values()].map((s) => ({ ...s }));
      return json(200, { samples, used: { count: samples.length, bytes: samples.reduce((a, s) => a + s.bytes, 0) }, limits });
    }
    if (method === "POST") {
      if (stored.size >= limits.count) return json(507, { error: "count" });
      const id = `sample${String(++n).padStart(12, "0")}`;
      const name = new URLSearchParams(url.split("?")[1]).get("name");
      stored.set(id, { id, name, type: "audio/wav", bytes: body.byteLength, createdAt: n });
      files.set(id, body);
      return json(201, stored.get(id));
    }
    const id = path.split("/").pop();
    if (method === "DELETE") return json(stored.delete(id) ? 204 : 404, {});
    if (!stored.has(id)) return json(404, {});
    const bytes = files.get(id);
    return { ...json(200, {}), arrayBuffer: async () => bytes.slice().buffer };
  });
  return { fetch, stored, files };
}

const file = (name, bytes) => new File([bytes], name);
const buffer = ({ sampleRate, channels }) => ({
  sampleRate,
  length: channels[0].length,
  duration: channels[0].length / sampleRate,
  numberOfChannels: channels.length,
  getChannelData: (c) => channels[c],
});
// A browser like Chrome: WAV yes, AIFF no.
const chrome = () => vi.fn(async (ab) => {
  const pcm = decodeWav(new Uint8Array(ab));
  if (!pcm) throw new Error("EncodingError");
  return buffer(pcm);
});
const tone = (seconds, rate = 8000) => wav16([ramp(Math.round(seconds * rate))], rate);
const wavOf = (bytes) => String.fromCharCode(...bytes.subarray(0, 4)) + String.fromCharCode(...bytes.subarray(8, 12));

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
    const { fetch, files } = server();
    const decode = chrome();
    const samples = createSamples({ fetch, decode });
    const changes = vi.fn();
    samples.on(changes);
    await samples.refresh();
    expect(samples.info).toMatchObject({ ready: true, samples: [], limits: LIMITS });

    const bytes = tone(0.5);
    const s = await samples.upload(file("Clap.wav", bytes));
    expect(s.name).toBe("Clap");
    // A plain WAV goes up as it came.
    expect(files.get(s.id)).toEqual(bytes);
    expect(samples.info.used).toEqual({ count: 1, bytes: bytes.length });
    // Decoded before the upload; that buffer serves playback without a fetch.
    expect(samples.get(s.id).duration).toBe(0.5);
    expect(await samples.load(s.id)).toBe(samples.get(s.id));
    expect(fetch.mock.calls.filter(([url]) => url.endsWith(s.id))).toHaveLength(0);

    await samples.remove(s.id);
    expect(samples.info.samples).toEqual([]);
    expect(samples.info.used).toEqual({ count: 0, bytes: 0 });
    expect(samples.get(s.id)).toBeNull();
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("what the browser can't decode goes through our decoder and up as WAV", async () => {
    const { fetch, files } = server();
    const samples = createSamples({ fetch, decode: chrome() });
    await samples.refresh();
    const s = await samples.upload(file("Loop.aif", aiff([ramp(4410)])));
    const stored = files.get(s.id);
    expect(wavOf(stored)).toBe("RIFFWAVE");
    expect(decodeWav(stored).channels[0][0]).toBeCloseTo(-16000 / 32768, 4);
    expect(samples.get(s.id).duration).toBe(0.1);
  });

  it("a format not every browser decodes is re-encoded even when this one could", async () => {
    const { fetch, files } = server();
    // Safari: decodes AIFF too.
    const safari = vi.fn(async (ab) => buffer(decodeWav(new Uint8Array(ab)) ?? { sampleRate: 44100, channels: [new Float32Array(441)] }));
    const samples = createSamples({ fetch, decode: safari });
    await samples.refresh();
    const s = await samples.upload(file("Loop.aiff", aiff([ramp(441)])));
    expect(wavOf(files.get(s.id))).toBe("RIFFWAVE");
  });

  it("an Ableton slice uploads only its frames, counted at the file's rate", async () => {
    const { fetch, files } = server();
    const samples = createSamples({ fetch, decode: chrome() });
    await samples.refresh();
    const candidate = { key: "a", name: "Kick 1", region: { start: 4000, end: 6000, rate: 8000 }, load: async () => ({ bytes: tone(1) }) };
    const s = await samples.upload(candidate);
    expect(s.name).toBe("Kick 1");
    expect(decodeWav(files.get(s.id)).channels[0]).toHaveLength(2000);
    expect(samples.get(s.id).length).toBe(2000);
  });

  it("refuses long, huge and undecodable files before uploading anything", async () => {
    const { fetch } = server();
    const samples = createSamples({ fetch, decode: chrome() });
    await samples.refresh();
    await expect(samples.upload(file("long.wav", tone(MAX_SECONDS + 1, 1000)))).rejects.toMatchObject({ code: "tooLong", detail: MAX_SECONDS });
    const huge = { name: "huge.wav", size: MAX_SOURCE_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) };
    await expect(samples.upload(huge)).rejects.toMatchObject({ code: "tooBig", detail: MAX_SOURCE_BYTES });
    await expect(samples.upload(file("x.txt", new Uint8Array(64)))).rejects.toMatchObject({ code: "format" });
    expect(fetch.mock.calls.some(([, opts]) => opts?.method === "POST")).toBe(false);
  });

  it("over the server's per-file limit: re-encoded smaller, 16-bit if need be, or refused", async () => {
    const limits = { ...LIMITS, bytes: 130000 };
    const { fetch, files } = server(limits);
    const samples = createSamples({ fetch, decode: chrome() });
    await samples.refresh();
    // 2 s at 32 kHz: 128 kB of 16-bit audio, plus trailing bytes that put the file over the limit.
    // Re-encoded: 192 kB at 24 bits doesn't fit either; 16 bits does.
    const big = new Uint8Array([...wav16([ramp(64000)], 32000), ...new Uint8Array(3000)]);
    const s = await samples.upload(file("big.wav", big));
    expect(files.get(s.id).length).toBe(44 + 64000 * 2);
    limits.bytes = 1000;
    await samples.refresh();
    await expect(samples.upload(file("still.wav", tone(1)))).rejects.toMatchObject({ code: "tooBig", detail: 1000 });
  });

  it("passes the server's limits on as error codes", async () => {
    const { fetch } = server();
    const samples = createSamples({ fetch, decode: chrome() });
    await samples.refresh();
    for (const name of ["a", "b", "c"]) await samples.upload(file(`${name}.wav`, tone(0.1)));
    await expect(samples.upload(file("d.wav", tone(0.1)))).rejects.toMatchObject({ code: "count" });
  });

  it("loads a stored sample once, even when asked twice at the same time", async () => {
    const { fetch, stored, files } = server();
    stored.set("abcdefghijklmnop", { id: "abcdefghijklmnop", name: "x", bytes: 8 });
    files.set("abcdefghijklmnop", tone(0.1));
    const decode = chrome();
    const samples = createSamples({ fetch, decode });
    const [a, b] = await Promise.all([samples.load("abcdefghijklmnop"), samples.load("abcdefghijklmnop")]);
    expect(a).toBe(b);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(await samples.load("missingmissingmi")).toBeNull();
  });

  it("an AIFF stored from Safari still plays where the browser can't decode it", async () => {
    const { fetch, stored, files } = server();
    stored.set("aiffaiffaiffaiff", { id: "aiffaiffaiffaiff", name: "x", type: "audio/aiff", bytes: 8 });
    files.set("aiffaiffaiffaiff", aiff([ramp(441)]));
    const samples = createSamples({ fetch, decode: chrome() });
    expect((await samples.load("aiffaiffaiffaiff")).length).toBe(441);
  });

  it("auditions a candidate without uploading it, and reuses the decode for the upload", async () => {
    const { fetch } = server();
    const decode = chrome();
    const samples = createSamples({ fetch, decode });
    await samples.refresh();
    const candidate = { key: "k", name: "Hat", load: vi.fn(async () => ({ bytes: tone(0.2) })) };
    const id = await samples.audition(candidate);
    expect(samples.get(id).duration).toBe(0.2);
    await samples.upload(candidate);
    expect(candidate.load).toHaveBeenCalledTimes(1);
    samples.endAuditions();
    expect(samples.get(id)).toBeNull();
  });

  it("signed out: the list comes back empty", async () => {
    const samples = createSamples({ fetch: vi.fn(async () => json(401, {})), decode: chrome() });
    await samples.refresh();
    expect(samples.info).toMatchObject({ ready: false, samples: [] });
  });
});
