// Per-sound insert: a filter with a tempo-synced LFO on its cutoff, then a
// distortion, between a lane's notes and its gain. Every variant carries one
// as data (`data.insert`); the engine builds a chain per lane, FX shot and
// audition, and updates it live.
//
//   input ─> filter ─> pre ─> shaper ─> post ─> output
//              ▲ detune
//   lfo ─> depth
//
// Continuous values glide. Switching a type (filter or distortion) needs
// other nodes, so the engine builds a fresh chain and crossfades it in:
// `kindOf()` tells the two cases apart.
//
// Also here: the DJ filter on the master bus, one bipolar knob.

export const FILTER_TYPES = ["off", "lowpass", "highpass", "bandpass"];
export const DRIVE_TYPES = ["off", "soft", "hard", "fold", "crush"];
export const LFO_RATES = [2, 4, 8, 16, 32, 64]; // steps per LFO cycle
export const LFO_CENTS = 2400; // full depth: ±2 octaves around the cutoff

export const INSERT_DEFAULT = { filter: "off", cutoff: 1200, res: 1, lfo: 0, rate: 16, drive: "off", amount: 0.4 };

const GLIDE = 0.02;
const CURVE_SIZE = 4097; // odd: the middle point is exactly 0 in, 0 out
const RANGE = 4; // soft/hard/fold: the shaper's ±1 spans ±RANGE of the curve

export const kindOf = (insert) => `${insert.filter}|${insert.drive}`;
export const isBypass = (insert) => insert.filter === "off" && insert.drive === "off";

// Crush: 8 bits at 0 % down to 2 bits at 100 %.
export const bitsFor = (amount) => Math.round(8 - amount * 6);

// Small-signal gain of soft/hard/fold: 1 (0 dB) to ~32 (+30 dB).
const driveOf = (amount) => 10 ** (amount * 1.5);

/**
 * Gains around the shaper. `pre` scales the input onto the curve; `post`
 * roughly matches a half-scale input's level, so turning the drive up adds
 * grit rather than volume. Crush quantizes at full scale: no gain.
 */
export function driveGains(type, amount) {
  if (type === "off" || type === "crush") return { pre: 1, post: 1 };
  const g = driveOf(amount);
  // Folding spreads energy into folds that partly cancel: measured in Chrome,
  // it reads 2.6 dB hot at 0 % and 6.6 dB quiet at 100 % without this.
  const fold = type === "fold" ? 10 ** ((-2.6 + 9.2 * amount) / 20) : 1;
  return { pre: g / RANGE, post: (0.5 / Math.tanh(0.5 * g)) * fold };
}

const SHAPES = {
  soft: (u) => Math.tanh(u),
  hard: (u) => Math.max(-1, Math.min(1, u)),
  fold: (u) => Math.sin((u * Math.PI) / 2),
};

const curveCache = new Map();

/** The shaper curve for `type` (null: no curve, the shaper passes through). */
export function driveCurve(type, amount) {
  if (type === "off") return null;
  const key = type === "crush" ? `crush${bitsFor(amount)}` : type;
  let curve = curveCache.get(key);
  if (!curve) {
    curve = new Float32Array(CURVE_SIZE);
    const step = type === "crush" ? 2 / 2 ** bitsFor(amount) : 0;
    for (let i = 0; i < CURVE_SIZE; i++) {
      const x = (i / (CURVE_SIZE - 1)) * 2 - 1;
      curve[i] = step ? Math.max(-1, Math.min(1, Math.round(x / step) * step)) : SHAPES[type](x * RANGE);
    }
    curveCache.set(key, curve);
  }
  return curve;
}

/** LFO frequency for `rate` steps per cycle. */
export const lfoHz = (rate, stepDur) => 1 / (rate * stepDur);

/**
 * One insert chain. `at` is when its LFO starts (a lane's entry step, so
 * the wobble starts on the grid). Returns { input, output, kind, update,
 * setStepDur, stop }; the caller wires input/output and owns the fades.
 */
export function buildInsert(ctx, insert, { stepDur, at = ctx.currentTime }) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const pre = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const post = ctx.createGain();
  input.connect(filter).connect(pre).connect(shaper).connect(post).connect(output);

  const nyquist = ctx.sampleRate / 2;
  // "off" is a lowpass at Nyquist, which the spec defines as an identity.
  filter.type = insert.filter === "off" ? "lowpass" : insert.filter;
  filter.frequency.value = insert.filter === "off" ? nyquist : Math.min(insert.cutoff, nyquist);
  filter.Q.value = insert.filter === "off" ? 0 : insert.res;
  shaper.oversample = insert.drive === "off" || insert.drive === "crush" ? "none" : "2x";
  shaper.curve = driveCurve(insert.drive, insert.amount);
  const gains = driveGains(insert.drive, insert.amount);
  pre.gain.value = gains.pre;
  post.gain.value = gains.post;

  let lfo = null;
  let depth = null;
  if (insert.filter !== "off") {
    lfo = ctx.createOscillator();
    lfo.frequency.value = lfoHz(insert.rate, stepDur);
    depth = ctx.createGain();
    depth.gain.value = insert.lfo * LFO_CENTS;
    lfo.connect(depth).connect(filter.detune);
    lfo.start(at);
  }

  let current = insert;
  return {
    input,
    output,
    kind: kindOf(insert),
    // Same kind only: values glide, a crush depth swaps its curve.
    update(next, now) {
      if (next.filter !== "off") {
        filter.frequency.setTargetAtTime(Math.min(next.cutoff, nyquist), now, GLIDE);
        filter.Q.setTargetAtTime(next.res, now, GLIDE);
        depth.gain.setTargetAtTime(next.lfo * LFO_CENTS, now, GLIDE);
        if (next.rate !== current.rate) lfo.frequency.setTargetAtTime(lfoHz(next.rate, stepDur), now, GLIDE);
      }
      if (next.drive === "crush") {
        if (bitsFor(next.amount) !== bitsFor(current.amount)) shaper.curve = driveCurve("crush", next.amount);
      } else if (next.drive !== "off") {
        const g = driveGains(next.drive, next.amount);
        pre.gain.setTargetAtTime(g.pre, now, GLIDE);
        post.gain.setTargetAtTime(g.post, now, GLIDE);
      }
      current = next;
    },
    // The BPM moved: the LFO stays locked to the grid's speed.
    setStepDur(next, now) {
      stepDur = next;
      lfo?.frequency.setTargetAtTime(lfoHz(current.rate, stepDur), now, 0.05);
    },
    stop(when) {
      lfo?.stop(when);
    },
  };
}

/* ---------------------------------------------------------- DJ filter -- */

export const DJ_Q = 1.2;

/**
 * Cutoffs for the master filter knob, -1..1: left closes a lowpass
 * (Nyquist -> 150 Hz), right opens a highpass (0 -> 6 kHz), both on a log
 * scale. At 0 both sit where the spec makes them an identity.
 */
export function djCutoffs(v, nyquist) {
  if (v < 0) return { low: Math.min(nyquist, 18000 * (150 / 18000) ** -v), high: 0 };
  if (v > 0) return { low: nyquist, high: 20 * (6000 / 20) ** v };
  return { low: nyquist, high: 0 };
}
