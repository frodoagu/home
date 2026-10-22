// The record buttons' models: start() taps the engine's output into a take
// (take.js), which waits for the first sound; stop() ends it. The stems
// recorder taps every stem into a stems take (stems.js) that starts on the
// next bar line queued. Both live as long as the engine, so a remount does
// not lose a recording.
import { STEMS } from "./engine.js";
import { createStemsTake } from "./stems.js";
import { createTake } from "./take.js";

// 24-bit stereo at 48 kHz is ~17 MB a minute: 15 minutes (~260 MB) holds a
// whole track or a short set and still fits a phone's tab.
export const MAX_SECONDS = 15 * 60;
// Stems take that for each layer that plays: 10 minutes of all nine is ~1.5 GB.
export const STEMS_MAX_SECONDS = 10 * 60;

export function createRecorder(engine, { maxSeconds = MAX_SECONDS } = {}) {
  let take = null;
  let tapping = null; // tap()'s promise for the running take
  let onFull = null;

  /** Starts listening. Call inside a click; rejects where recording can't work. */
  function start() {
    if (take) return tapping;
    const ctx = engine.ensureContext();
    const t = createTake({ sampleRate: ctx.sampleRate, maxSeconds });
    take = t;
    tapping = engine.tap((block) => {
      if (t.full()) return;
      t.push(block);
      if (t.full()) onFull?.();
    });
    tapping.catch(() => {
      if (take === t) take = null;
    });
    return tapping;
  }

  /** Ends the take: { blob, seconds } of the .wav, or null if nothing sounded. */
  async function stop() {
    const t = take;
    if (!t) return null;
    take = null;
    try {
      await (await tapping)();
    } catch {
      return null;
    }
    return t.finish();
  }

  return {
    start,
    stop,
    // "idle", "waiting" (for the first sound) or "recording"
    state: () => (!take ? "idle" : take.started() ? "recording" : "waiting"),
    seconds: () => take?.seconds() ?? 0,
    onFull: (fn) => {
      onFull = fn;
    },
  };
}

export function createStemsRecorder(engine, { maxSeconds = STEMS_MAX_SECONDS } = {}) {
  let take = null;
  let tapping = null;
  let bpm = null; // the tempo at the bar the take starts on
  let unlisten = null;
  let onFull = null;

  const stopListening = () => {
    unlisten?.();
    unlisten = null;
  };

  /** Starts listening. Call inside a click; rejects where recording can't work. */
  function start() {
    if (take) return tapping;
    const ctx = engine.ensureContext();
    const t = createStemsTake({ sampleRate: ctx.sampleRate, names: STEMS, maxSeconds });
    take = t;
    // Bar lines are announced as they are queued, ahead of the audio.
    unlisten = engine.listen((event) => {
      if (event.kind !== "bar") return;
      t.startAt(Math.round(event.time * ctx.sampleRate));
      bpm = event.bpm;
      stopListening();
    });
    tapping = engine.tapStems((channels, frame) => {
      if (t.full()) return;
      t.push(channels, frame);
      if (t.full()) onFull?.();
    });
    tapping.catch(() => {
      if (take !== t) return;
      take = null;
      stopListening();
    });
    return tapping;
  }

  /** Ends the take: { stems: [{ id, blob }], seconds, bpm }, or null if nothing sounded. */
  async function stop() {
    const t = take;
    if (!t) return null;
    take = null;
    stopListening();
    try {
      await (await tapping)();
    } catch {
      return null;
    }
    const done = t.finish();
    return done && { ...done, bpm };
  }

  return {
    start,
    stop,
    // "idle", "waiting" (for a bar line) or "recording"
    state: () => (!take ? "idle" : take.started() ? "recording" : "waiting"),
    seconds: () => take?.seconds() ?? 0,
    onFull: (fn) => {
      onFull = fn;
    },
  };
}
