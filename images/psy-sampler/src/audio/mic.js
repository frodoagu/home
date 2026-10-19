// 🎵 Samples' 🎙 button: start() opens the microphone and taps it
// (engine.tap) into a mono take (take.js) that starts on the first sound
// over the room's noise; stop() ends it and closes the microphone. A sample
// lasts MAX_SECONDS at most (samples.js), so the take is full there.
import { MAX_SECONDS } from "../samples.js";
import { createTake } from "./take.js";

// -46 dBFS: over what a quiet room and a mic's own hiss reach. The take
// starts PREROLL early, so the attack under it stays.
export const THRESHOLD = 0.005;
const PREROLL = 0.02;
// Voice-call processing (echo cancelling, denoising, auto gain) reshapes
// whatever is not a voice: all off.
export const CONSTRAINTS = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };

export const micAvailable = (media = globalThis.navigator?.mediaDevices) => typeof media?.getUserMedia === "function";

const mono = (block) => (block.length === 1 ? block[0] : block[0].map((x, i) => (x + block[1][i]) / 2));

export function createMicRecorder(engine, { media = globalThis.navigator?.mediaDevices, maxSeconds = MAX_SECONDS } = {}) {
  let run = null; // { take, stream, untap, opening, live, peak }
  let onFull = null;

  const close = (r) => r.stream?.getTracks().forEach((track) => track.stop());

  function feed(r, block) {
    if (run !== r || r.take.full()) return;
    const data = mono(block);
    let peak = 0;
    for (const x of data) peak = Math.max(peak, Math.abs(x));
    r.peak = peak;
    r.take.push([data]);
    if (r.take.full()) onFull?.();
  }

  /** Call inside a click (it may create the AudioContext); rejects when the microphone is refused or missing. */
  function start() {
    if (run) return run.opening;
    const ctx = engine.ensureContext();
    const take = createTake({ sampleRate: ctx.sampleRate, channelCount: 1, maxSeconds, threshold: THRESHOLD, preroll: PREROLL });
    const r = { take, stream: null, untap: null, live: false, peak: 0 };
    run = r;
    r.opening = (async () => {
      r.stream = await media.getUserMedia(CONSTRAINTS);
      r.untap = await engine.tap((block) => feed(r, block), ctx.createMediaStreamSource(r.stream));
      r.live = true;
    })();
    r.opening.catch(() => {
      close(r);
      if (run === r) run = null;
    });
    return r.opening;
  }

  /** Ends the take and closes the microphone: { blob, seconds } of the .wav, or null if nothing sounded. */
  async function stop() {
    const r = run;
    if (!r) return null;
    run = null;
    try {
      await r.opening;
      await r.untap();
    } catch {
      return null;
    } finally {
      close(r);
    }
    return r.take.finish();
  }

  return {
    start,
    stop,
    // "idle", "opening" (asking for the microphone), "waiting" (for the first sound) or "recording"
    state: () => (!run ? "idle" : !run.live ? "opening" : run.take.started() ? "recording" : "waiting"),
    seconds: () => run?.take.seconds() ?? 0,
    // The loudest sample of the last block, 0-1: for a meter.
    level: () => run?.peak ?? 0,
    maxSeconds,
    onFull: (fn) => {
      onFull = fn;
    },
  };
}

/**
 * 🎧: the microphone through the take's effects (engine.monitor), live,
 * to try them before recording. Its own stream, so ⏺ and 🎙 work under it.
 */
export function createMicMonitor(engine, { media = globalThis.navigator?.mediaDevices } = {}) {
  let run = null; // { stream, live, opening }
  let fx = null;

  const close = (r) => r.stream?.getTracks().forEach((track) => track.stop());

  /** Call inside a click; rejects when the microphone is refused or missing. */
  function start(settings) {
    fx = settings;
    if (run) return run.opening;
    const ctx = engine.ensureContext();
    const r = { stream: null, live: null };
    run = r;
    r.opening = (async () => {
      r.stream = await media.getUserMedia(CONSTRAINTS);
      if (run !== r) return close(r);
      const live = await engine.monitor(ctx.createMediaStreamSource(r.stream), fx);
      if (run !== r) return live.stop();
      r.live = live;
    })();
    r.opening.catch(() => {
      close(r);
      if (run === r) run = null;
    });
    return r.opening;
  }

  function stop() {
    const r = run;
    if (!r) return;
    run = null;
    r.live?.stop();
    close(r);
  }

  return {
    start,
    stop,
    set(settings) {
      fx = settings;
      run?.live?.set(settings);
    },
    // "idle", "opening" (asking for the microphone) or "live"
    state: () => (!run ? "idle" : run.live ? "live" : "opening"),
  };
}
