// The record button's model: start() taps the engine's output into a take
// (take.js), which waits for the first sound; stop() ends it. Lives as long
// as the engine, so a remount does not lose a recording.
import { createTake } from "./take.js";

// 24-bit stereo at 48 kHz is ~17 MB a minute: 15 minutes (~260 MB) holds a
// whole track or a short set and still fits a phone's tab.
export const MAX_SECONDS = 15 * 60;

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
