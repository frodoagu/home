// BPM changes that ramp bar by bar instead of jumping: the UI moves one slice
// of the way on every bar line, so a set can climb 145 -> 150 over 8 bars the
// way a DJ nudges the pitch fader.
import { BPM_DEFAULT, BPM_MAX, BPM_MIN } from "./audio/timing.js";

export const RAMP_BARS = [1, 2, 4, 8, 16, 32];
export const RAMP_DEFAULT = 8;

export const clampBpm = (v) => (Number.isFinite(v) ? Math.round(Math.min(BPM_MAX, Math.max(BPM_MIN, v))) : BPM_DEFAULT);

/** The BPM after `done` of a ramp's `bars` bar lines: linear, exact on the last one. */
export const rampAt = ({ from, to, bars }, done) => (done >= bars ? to : from + ((to - from) * done) / bars);

// Tap tempo. The first tap of a count is the 1: the app takes the loop back to
// its first step right there. Every tap after it refits one line through all
// the taps so far, and the BPM and the phase both follow that line, so the
// loop locks onto whatever the hand is tapping along to.
export const TAP_RESET_MS = 2000; // a pause longer than this starts a new count
export const TAP_BOUNCE_MS = 120; // closer than this to the last tap: a bounce (500 BPM), not a beat
// ~13 s at 145. The fit sharpens with every tap: eight land within about
// 1 BPM of the truth, twenty-odd on the exact whole BPM.
const TAP_KEEP = 32;

/**
 * Adds a tap (ms) to a count, or starts one: `{ first, times }`, the last
 * TAP_KEEP tap times oldest first and the index of times[0] in the count
 * (0 is the 1). Returns the same count for a bounce.
 */
export function addTap(count, now) {
  const last = count?.times.at(-1);
  if (last === undefined || now - last > TAP_RESET_MS) return { first: 0, times: [now] };
  if (now - last < TAP_BOUNCE_MS) return count;
  const times = [...count.times, now];
  const drop = Math.max(0, times.length - TAP_KEEP);
  return { first: count.first + drop, times: times.slice(drop) };
}

/**
 * The beat the taps lay down, null until there are two: `bpm`, whole and in
 * the slider's range, and `at`, when the count's first tap (the 1) falls on
 * the line fitted through every tap. A least-squares fit, so every tap counts,
 * not just the first and the last. A tempo far outside the range moves by
 * octaves first, so tapping half or double time works; the line then runs at
 * the rounded BPM, so the beat after the last tap is where that BPM puts it.
 */
export function tapBeat(count) {
  const n = count?.times.length ?? 0;
  if (n < 2) return null;
  const mx = count.first + (n - 1) / 2;
  const mt = count.times.reduce((a, t) => a + t, 0) / n;
  let sxx = 0;
  let sxt = 0;
  count.times.forEach((t, i) => {
    const dx = count.first + i - mx;
    sxx += dx * dx;
    sxt += dx * (t - mt);
  });
  let bpm = (60000 * sxx) / sxt;
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  let beatsPerTap = 1;
  while (bpm < BPM_MIN / Math.SQRT2) {
    bpm *= 2;
    beatsPerTap *= 2;
  }
  while (bpm > BPM_MAX * Math.SQRT2) {
    bpm /= 2;
    beatsPerTap /= 2;
  }
  bpm = clampBpm(bpm);
  return { bpm, at: mt - (mx * beatsPerTap * 60000) / bpm };
}
