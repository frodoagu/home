// The signed-in user's samples, kept by psy-sync (/api/samples): the list,
// uploads, deletes, and the decoded audio the engine plays (engine.js
// `sampleBuffer`). Decoding happens on demand, for the samples the sounds
// use and the ones being previewed, so a big library does not sit in memory.
//
// What to upload comes from import/gather.js (loose files, folders, zips,
// SoundFonts, the samples an Ableton set uses…). Each one is decoded here
// first: the browser's decoder, then ours (import/pcm.js) for what it can't
// read. What runs longer than MAX_SECONDS never leaves the page; what not
// every browser decodes (or an Ableton slice) goes up re-encoded as WAV, so
// it plays wherever its owner signs in. The server checks the bytes again
// and enforces the per-account limits it reports.

import { encodeWav } from "./audio/wav.js";
import { TooBig } from "./import/bytes.js";
import { MAX_SOURCE_BYTES, gather, universal } from "./import/gather.js";
import { decodePcm } from "./import/pcm.js";

export const MAX_SECONDS = 15;

export class SampleError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code; // tooBig | tooLong | format | quota | count | full | failed
    this.detail = detail;
  }
}

const NAME_MAX = 60;
const cleanName = (name) => String(name ?? "").trim().slice(0, NAME_MAX) || "sample";

// "Kick 909.wav" -> "Kick 909"
export const nameOf = (file) => cleanName(String(file?.name ?? "").replace(/\.[^.]+$/, ""));

// 1536 -> "1,5 kB"; binary units, like the server's limits.
export function formatBytes(n, lang = "es") {
  const units = ["B", "kB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(lang, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

// Off the live AudioContext: an offline one decodes without a user gesture.
// The engine plays the result at any rate (sources resample).
const defaultDecode = (bytes) => new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes);

// A float file louder than full scale comes in scaled down to it, not clipped.
function underFullScale(channels) {
  let peak = 0;
  for (const data of channels) for (const x of data) peak = Math.max(peak, Math.abs(x));
  return peak > 1 ? channels.map((data) => data.map((x) => x / peak)) : channels;
}

const asWav = ({ sampleRate, channels }, bits) => encodeWav({ sampleRate: Math.round(sampleRate), channels: underFullScale(channels) }, bits);

// A File picked on its own, as a gather() candidate.
const fileCandidate = (file) => ({
  key: file.name,
  name: nameOf(file),
  load: async () => {
    if (file.size > MAX_SOURCE_BYTES) throw new TooBig();
    return { bytes: new Uint8Array(await file.arrayBuffer()) };
  },
});

export function createSamples({ fetch = globalThis.fetch?.bind(globalThis), base = "/api", decode = defaultDecode } = {}) {
  const info = { ready: false, samples: [], used: { count: 0, bytes: 0 }, limits: null };
  const buffers = new Map(); // id -> AudioBuffer
  const loading = new Map(); // id -> Promise<AudioBuffer | null>
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(info));

  const byId = (id) => info.samples.find((s) => s.id === id);

  // -> { buffer, keep }: keep when the bytes can be stored as they came.
  async function decodeAny(source) {
    if (source.pcm) return { buffer: await decode(asWav(source.pcm)), keep: false };
    const { bytes } = source;
    try {
      return { buffer: await decode(bytes.slice().buffer), keep: universal(bytes) };
    } catch {
      const pcm = decodePcm(bytes);
      if (!pcm) throw new SampleError("format");
      return { buffer: await decode(asWav(pcm)), keep: false };
    }
  }

  // A candidate -> { name, payload, buffer, wav }: what to upload, and what it sounds like.
  async function build(candidate) {
    let source;
    try {
      source = await candidate.load();
    } catch (err) {
      throw err instanceof TooBig ? new SampleError("tooBig", MAX_SOURCE_BYTES) : new SampleError("format");
    }
    let decoded;
    try {
      decoded = await decodeAny(source);
    } catch (err) {
      throw err instanceof SampleError ? err : new SampleError("format");
    }
    const { buffer, keep } = decoded;
    const rate = buffer.sampleRate;
    let from = 0;
    let to = buffer.length;
    if (candidate.region) {
      // Ableton counts the slice in frames of the file, before our resampling.
      const at = (frame) => Math.min(buffer.length, Math.round((frame / candidate.region.rate) * rate));
      from = at(candidate.region.start);
      to = at(candidate.region.end);
      if (to <= from) throw new SampleError("format");
    }
    if ((to - from) / rate > MAX_SECONDS) throw new SampleError("tooLong", MAX_SECONDS);
    const name = cleanName(candidate.name);
    const max = info.limits?.bytes ?? Infinity;
    if (keep && !candidate.region && source.bytes.length <= max) return { name, payload: source.bytes, buffer, wav: false };
    const pcm = {
      sampleRate: rate,
      channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice(from, to)),
    };
    // 24-bit when it fits; 15 s of stereo at 48 kHz only fits the 3 MiB default in 16.
    let payload = new Uint8Array(asWav(pcm));
    if (payload.length > max) payload = new Uint8Array(asWav(pcm, 16));
    if (payload.length > max) throw new SampleError("tooBig", max);
    return { name, payload, buffer: await decode(payload.slice().buffer), wav: true };
  }

  const built = new WeakMap(); // candidate -> Promise of build()
  const prepare = (candidate) => {
    if (!built.has(candidate)) {
      const job = build(candidate);
      job.catch(() => built.delete(candidate));
      built.set(candidate, job);
    }
    return built.get(candidate);
  };
  let auditions = 0;

  function clear() {
    if (!info.ready && !info.samples.length && !buffers.size) return;
    Object.assign(info, { ready: false, samples: [], used: { count: 0, bytes: 0 }, limits: null });
    buffers.clear();
    loading.clear();
    emit();
  }

  return {
    info,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** The list from the server; signed out (or no API) leaves it empty. */
    async refresh() {
      try {
        const res = await fetch(`${base}/samples`, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        Object.assign(info, { ready: true, samples: data.samples, used: data.used, limits: data.limits });
        emit();
      } catch {
        clear();
      }
      return info;
    },

    clear,

    /** Decoded audio, or null until load() has it. */
    get: (id) => buffers.get(id) ?? null,

    /** Files, folders' contents or archives -> what they hold (import/gather.js). */
    gather,

    /** Decodes a candidate to listen to before uploading it; resolves to an id for get(). */
    async audition(candidate) {
      const { buffer } = await prepare(candidate);
      const id = `~audition-${++auditions}`;
      buffers.set(id, buffer);
      return id;
    },

    /** Frees what audition() kept. */
    endAuditions() {
      for (const id of buffers.keys()) if (id.startsWith("~audition-")) buffers.delete(id);
    },

    /** Fetch + decode once; null when it is gone, foreign or undecodable. */
    load(id) {
      if (buffers.has(id)) return Promise.resolve(buffers.get(id));
      if (!loading.has(id)) {
        const job = (async () => {
          try {
            const res = await fetch(`${base}/samples/${id}`, { credentials: "same-origin" });
            if (!res.ok) return null;
            // An AIFF stored from Safari still plays in Chrome: our decoder takes over.
            const { buffer } = await decodeAny({ bytes: new Uint8Array(await res.arrayBuffer()) });
            buffers.set(id, buffer);
            return buffer;
          } catch {
            return null;
          } finally {
            loading.delete(id);
          }
        })();
        loading.set(id, job);
      }
      return loading.get(id);
    },

    /** Uploads a gather() candidate (or a File); resolves to the stored sample or throws a SampleError. */
    async upload(item) {
      const candidate = item.load ? item : fileCandidate(item);
      const { name, payload, buffer, wav } = await prepare(candidate);
      let res;
      try {
        res = await fetch(`${base}/samples?name=${encodeURIComponent(name)}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": wav ? "audio/wav" : "application/octet-stream" },
          body: payload,
        });
      } catch {
        throw new SampleError("failed");
      }
      const limits = info.limits;
      const data = await res.json().catch(() => ({}));
      if (res.status === 413) throw new SampleError("tooBig", limits?.bytes);
      if (res.status === 415) throw new SampleError("format");
      if (res.status === 507) throw new SampleError(["quota", "count", "full"].includes(data.error) ? data.error : "full", limits);
      if (res.status !== 201) throw new SampleError("failed");
      built.delete(candidate);
      buffers.set(data.id, buffer);
      info.samples = [...info.samples, data];
      info.used = { count: info.used.count + 1, bytes: info.used.bytes + data.bytes };
      emit();
      return data;
    },

    async remove(id) {
      const res = await fetch(`${base}/samples/${id}`, { method: "DELETE", credentials: "same-origin" });
      if (res.status !== 204 && res.status !== 404) throw new SampleError("failed");
      const gone = byId(id);
      info.samples = info.samples.filter((s) => s.id !== id);
      if (gone) info.used = { count: info.used.count - 1, bytes: info.used.bytes - gone.bytes };
      buffers.delete(id);
      emit();
    },
  };
}
