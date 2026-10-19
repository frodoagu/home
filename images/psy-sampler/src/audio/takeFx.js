// Effects on a 🎙 take before it goes up: the sample is stored with them, so
// it sounds the same in every sound that plays it. The chain itself is
// fxChain.js, the one the live preview plays; this renders a whole take
// through it.
//
// The output keeps the take's peak, lasts MAX_SECONDS at most (a tail past
// it fades out) and has no silence at the end; reversed, that tail swells
// into the take.
import { MAX_SECONDS } from "../samples.js";
import { createChain, isDry, sanitizeFx } from "./fxChain.js";
import { trimTail } from "./wav.js";

export * from "./fxChain.js";

const FADE = 0.02; // seconds: a tail cut at MAX_SECONDS fades out

const peakOf = (channels) => channels.reduce((p, c) => c.reduce((q, x) => Math.max(q, Math.abs(x)), p), 0);

// Seconds the echo and the reverb ring past the take.
function tailOf(s) {
  const echoTail = s.echo ? Math.min(4, s.echoTime * (s.echoFb > 0 ? Math.log(0.001) / Math.log(s.echoFb) : 1)) : 0;
  const reverbTail = s.reverb ? 1 + s.reverbSize * 3 : 0;
  return Math.max(echoTail, reverbTail);
}

/**
 * A take ({ sampleRate, channels }) through `fx` -> the same shape. Dry
 * settings hand the take back as it is.
 */
export function renderFx(take, fx) {
  const s = sanitizeFx(fx);
  if (isDry(s)) return take;
  const { sampleRate } = take;
  const maxFrames = Math.round(MAX_SECONDS * sampleRate);
  const frames = Math.min(maxFrames, take.channels[0].length + Math.round(tailOf(s) * sampleRate));
  const chain = createChain(sampleRate);
  const late = chain.latency(s);
  const input = new Float32Array(frames + late);
  const [first, second] = take.channels;
  input.set((second ? first.map((x, n) => (x + second[n]) / 2) : first).subarray(0, frames));
  let channels = chain.process(input, s).map((c) => c.subarray(late));
  const each = (fn) => (channels = channels.map(fn));

  const was = peakOf(take.channels);
  const now = peakOf(channels);
  each((c) => (now > 0 ? c.map((x) => (x * was) / now) : c.slice()));
  channels = trimTail(channels, sampleRate);
  if (channels[0].length === maxFrames) {
    const fade = Math.round(FADE * sampleRate);
    for (const c of channels) for (let i = 0; i < fade; i++) c[c.length - 1 - i] *= i / fade;
  }
  if (s.reverse) each((c) => c.slice().reverse());
  return { sampleRate, channels };
}

/** renderFx in a worker (inline where there are none); the take is copied, not moved. */
export function renderFxOffThread(take, fx) {
  if (typeof Worker === "undefined") return Promise.resolve().then(() => renderFx(take, fx));
  const worker = new Worker(new URL("./takeFx.worker.js", import.meta.url), { type: "module" });
  const copy = { sampleRate: take.sampleRate, channels: take.channels.map((c) => c.slice()) };
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = (e) => reject(e.error ?? new Error(e.message));
    worker.postMessage({ take: copy, fx: sanitizeFx(fx) }, copy.channels.map((c) => c.buffer));
  }).finally(() => worker.terminate());
}
