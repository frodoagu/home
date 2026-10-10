// The signed-in user's samples, kept by psy-sync (/api/samples): the list,
// uploads, deletes, and the decoded audio the engine plays (engine.js
// `sampleBuffer`). Decoding happens on demand, for the samples the sounds
// use and the ones being previewed, so a big library does not sit in memory.
//
// An upload is decoded here first: what the browser cannot play, or what
// runs longer than MAX_SECONDS, never leaves the page. The server checks the
// bytes again and enforces the per-account limits it reports.

export const MAX_SECONDS = 15;

export class SampleError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code; // tooBig | tooLong | format | quota | count | full | failed
    this.detail = detail;
  }
}

// "Kick 909.wav" -> "Kick 909"
export const nameOf = (file) =>
  String(file?.name ?? "")
    .replace(/\.[^.]+$/, "")
    .trim()
    .slice(0, 60) || "sample";

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

export function createSamples({ fetch = globalThis.fetch?.bind(globalThis), base = "/api", decode = defaultDecode } = {}) {
  const info = { ready: false, samples: [], used: { count: 0, bytes: 0 }, limits: null };
  const buffers = new Map(); // id -> AudioBuffer
  const loading = new Map(); // id -> Promise<AudioBuffer | null>
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(info));

  const byId = (id) => info.samples.find((s) => s.id === id);

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

    /** Fetch + decode once; null when it is gone, foreign or undecodable. */
    load(id) {
      if (buffers.has(id)) return Promise.resolve(buffers.get(id));
      if (!loading.has(id)) {
        const job = (async () => {
          try {
            const res = await fetch(`${base}/samples/${id}`, { credentials: "same-origin" });
            if (!res.ok) return null;
            const buffer = await decode(await res.arrayBuffer());
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

    /** Uploads a File; resolves to the stored sample or throws a SampleError. */
    async upload(file) {
      const limits = info.limits;
      if (limits && file.size > limits.bytes) throw new SampleError("tooBig", limits.bytes);
      const bytes = await file.arrayBuffer();
      let buffer;
      try {
        buffer = await decode(bytes.slice(0)); // decoding detaches what it reads
      } catch {
        throw new SampleError("format");
      }
      if (buffer.duration > MAX_SECONDS) throw new SampleError("tooLong", MAX_SECONDS);
      let res;
      try {
        res = await fetch(`${base}/samples?name=${encodeURIComponent(nameOf(file))}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: bytes,
        });
      } catch {
        throw new SampleError("failed");
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 413) throw new SampleError("tooBig", limits?.bytes);
      if (res.status === 415) throw new SampleError("format");
      if (res.status === 507) throw new SampleError(["quota", "count", "full"].includes(data.error) ? data.error : "full", limits);
      if (res.status !== 201) throw new SampleError("failed");
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
