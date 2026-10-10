// BPM changes that ramp bar by bar instead of jumping: the UI moves one slice
// of the way on every bar line, so a set can climb 145 -> 150 over 8 bars the
// way a DJ nudges the pitch fader.
import { BPM_DEFAULT, BPM_MAX, BPM_MIN } from "./audio/timing.js";

export const RAMP_BARS = [1, 2, 4, 8, 16, 32];
export const RAMP_DEFAULT = 8;

export const clampBpm = (v) => (Number.isFinite(v) ? Math.round(Math.min(BPM_MAX, Math.max(BPM_MIN, v))) : BPM_DEFAULT);

/** The BPM after `done` of a ramp's `bars` bar lines: linear, exact on the last one. */
export const rampAt = ({ from, to, bars }, done) => (done >= bars ? to : from + ((to - from) * done) / bars);

// Tap tempo: a pause longer than this starts a new count.
export const TAP_RESET_MS = 2000;
const TAP_KEEP = 8;

/** Adds a tap (ms) to the taps so far, oldest first, keeping the last few. */
export const addTap = (taps, now) =>
  taps.length && now - taps.at(-1) > TAP_RESET_MS ? [now] : [...taps, now].slice(-TAP_KEEP);

/**
 * The BPM the taps beat, null until there are two. A tempo far outside the
 * slider's range moves by octaves first, so tapping half or double time works.
 */
export function tapBpm(taps) {
  if (taps.length < 2) return null;
  let bpm = 60000 / ((taps.at(-1) - taps[0]) / (taps.length - 1));
  if (!Number.isFinite(bpm)) return null;
  while (bpm < BPM_MIN / Math.SQRT2) bpm *= 2;
  while (bpm > BPM_MAX * Math.SQRT2) bpm /= 2;
  return clampBpm(bpm);
}
