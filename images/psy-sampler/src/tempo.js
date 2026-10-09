// BPM changes that ramp bar by bar instead of jumping: the UI moves one slice
// of the way on every bar line, so a set can climb 145 -> 150 over 8 bars the
// way a DJ nudges the pitch fader.
import { BPM_DEFAULT, BPM_MAX, BPM_MIN } from "./audio/timing.js";

export const RAMP_BARS = [1, 2, 4, 8, 16, 32];
export const RAMP_DEFAULT = 8;

export const clampBpm = (v) => (Number.isFinite(v) ? Math.round(Math.min(BPM_MAX, Math.max(BPM_MIN, v))) : BPM_DEFAULT);

/** The BPM after `done` of a ramp's `bars` bar lines: linear, exact on the last one. */
export const rampAt = ({ from, to, bars }, done) => (done >= bars ? to : from + ((to - from) * done) / bars);
