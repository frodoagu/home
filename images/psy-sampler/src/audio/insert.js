// Per-sound insert: a filter with a tempo-synced LFO on its cutoff, then a
// distortion, between a lane's notes and its gain. Every variant carries one
// as data (`data.insert`); the engine builds a chain per lane, FX shot and
// audition, and updates it live.
//
//   input ─> filter ─> pre ─> shaper ─> post ─> [phaser] ─> [tremolo] ─> [panner ─> √2] ─> output
//              ▲ detune                                                    ▲ pan
//   lfo ─> depth  (+ a per-note envelope)                 panLfo ─> width
//
// The filter is one biquad, or three bandpasses in parallel for a vowel.
// The filter LFO has a shape (sine … a random sample & hold); the phaser,
// the tremolo and the panner only exist while they are on.
//
// Continuous values glide. Switching a type (filter or distortion) needs
// other nodes, so the engine builds a fresh chain and crossfades it in:
// `kindOf()` tells the two cases apart.
//
// Also here: the DJ filter on the master bus, one bipolar knob.

export const FILTER_TYPES = ["off", "lowpass", "highpass", "bandpass", "vowel"];
export const LFO_SHAPES = ["sine", "triangle", "sawtooth", "square", "random", "smooth"];
export const TREM_RATES = [1, 2, 4, 8]; // steps per tremolo cycle
// Formants (Hz, level) per vowel, Strudel's vowel(): a bandpass each. The
// levels carry each vowel's own makeup, so A E I O U sit within ~1 dB of
// the dry sound (measured in Chrome on the melodic lead).
export const VOWELS = {
  a: [[800, 1.07], [1150, 0.54], [2900, 0.27]],
  e: [[400, 0.8], [2000, 0.28], [2800, 0.16]],
  i: [[300, 1.17], [2200, 0.35], [3000, 0.23]],
  o: [[450, 0.77], [800, 0.46], [2830, 0.12]],
  u: [[325, 0.93], [700, 0.37], [2700, 0.09]],
};
export const ENV_CENTS = 4800; // full filter envelope: ±4 octaves
export const DRIVE_TYPES = ["off", "soft", "hard", "fold", "crush"];
export const LFO_RATES = [2, 4, 8, 16, 32, 64]; // steps per LFO cycle
export const LFO_CENTS = 2400; // full depth: ±2 octaves around the cutoff

export const INSERT_DEFAULT = {
  filter: "off",
  cutoff: 1200,
  res: 1,
  lfo: 0,
  rate: 16,
  drive: "off",
  amount: 0.4,
  pan: 0, // -1 left .. 1 right
  width: 0, // autopan: how far the pan LFO swings around `pan`
  panRate: 32, // steps per autopan cycle
  shape: "sine", // the filter LFO's
  vowel: "a",
  env: 0, // per-note filter envelope, -1..1 of ENV_CENTS
  envDecay: 0.2, // seconds
  phaser: 0, // mix
  phaserRate: 16,
  trem: 0, // depth
  tremRate: 2,
};

const GLIDE = 0.02;
const CURVE_SIZE = 4097; // odd: the middle point is exactly 0 in, 0 out
const RANGE = 4; // soft/hard/fold: the shaper's ±1 spans ±RANGE of the curve

// The autopan's LFO only exists while it swings: switching it on or off
// builds a fresh chain, like a filter or distortion type.
export const isPanned = (insert) => insert.pan !== 0 || insert.width > 0;
export const kindOf = (insert) =>
  [insert.filter, insert.drive, isPanned(insert), insert.width > 0, insert.shape, insert.phaser > 0, insert.trem > 0].join("|");
export const isBypass = (insert) =>
  insert.filter === "off" && insert.drive === "off" && !insert.pan && !insert.width && !insert.phaser && !insert.trem;

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

// The random LFOs read a looping table: NOISE_POINTS values a cycle (one
// second of table, so the playback rate is the LFO's Hz), NOISE_CYCLES
// cycles before it repeats. A fixed seed: a WAV export wobbles the same.
const NOISE_RATE = 3000;
const NOISE_POINTS = 8;
const NOISE_CYCLES = 16;
const noiseTables = new WeakMap(); // ctx -> { random, smooth }

export function noiseValues(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return Array.from({ length: NOISE_POINTS * NOISE_CYCLES }, () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  });
}

function noiseTable(ctx, shape) {
  let tables = noiseTables.get(ctx);
  if (!tables) noiseTables.set(ctx, (tables = {}));
  if (!tables[shape]) {
    const points = noiseValues();
    const per = NOISE_RATE / NOISE_POINTS;
    const buf = ctx.createBuffer(1, NOISE_RATE * NOISE_CYCLES, NOISE_RATE);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const k = Math.floor(i / per);
      if (shape === "random") d[i] = points[k];
      else {
        // Cosine between neighbours: smooth, and it still wraps seamlessly.
        const f = (1 - Math.cos(((i % per) / per) * Math.PI)) / 2;
        d[i] = points[k] + (points[(k + 1) % points.length] - points[k]) * f;
      }
    }
    tables[shape] = buf;
  }
  return tables[shape];
}

// A tempo-synced LFO of any shape, started at `at`: { out, setHz, stop }.
function tempoLfo(ctx, shape, hz, at) {
  if (shape === "random" || shape === "smooth") {
    const src = ctx.createBufferSource();
    src.buffer = noiseTable(ctx, shape);
    src.loop = true;
    src.playbackRate.value = hz;
    src.start(at);
    return { out: src, setHz: (v, now, tau) => src.playbackRate.setTargetAtTime(v, now, tau), stop: (t) => src.stop(t) };
  }
  const osc = ctx.createOscillator();
  osc.type = shape;
  osc.frequency.value = hz;
  osc.start(at);
  return { out: osc, setHz: (v, now, tau) => osc.frequency.setTargetAtTime(v, now, tau), stop: (t) => osc.stop(t) };
}

// One gain node at `value`.
const gainOf = (ctx, value) => {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
};

const VOWEL_GAIN = 2.5; // makeup: three narrow bands keep little of the input
const vowelQ = (res) => 4 + res;

/**
 * The filter: one biquad, or a vowel's three bandpasses side by side.
 * `detunes` are the params the LFO and the envelope move.
 */
function filterStage(ctx, insert) {
  const nyquist = ctx.sampleRate / 2;
  if (insert.filter === "vowel") {
    const input = ctx.createGain();
    const output = gainOf(ctx, VOWEL_GAIN);
    const bands = VOWELS[insert.vowel].map(([hz, level]) => {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = hz;
      bp.Q.value = vowelQ(insert.res);
      const g = gainOf(ctx, level);
      input.connect(bp).connect(g).connect(output);
      return { bp, g };
    });
    return {
      input,
      output,
      detunes: bands.map((b) => b.bp.detune),
      update(next, now) {
        VOWELS[next.vowel].forEach(([hz, level], i) => {
          bands[i].bp.frequency.setTargetAtTime(hz, now, GLIDE);
          bands[i].bp.Q.setTargetAtTime(vowelQ(next.res), now, GLIDE);
          bands[i].g.gain.setTargetAtTime(level, now, GLIDE);
        });
      },
    };
  }
  const filter = ctx.createBiquadFilter();
  // "off" is a lowpass at Nyquist, which the spec defines as an identity.
  filter.type = insert.filter === "off" ? "lowpass" : insert.filter;
  filter.frequency.value = insert.filter === "off" ? nyquist : Math.min(insert.cutoff, nyquist);
  filter.Q.value = insert.filter === "off" ? 0 : insert.res;
  return {
    input: filter,
    output: filter,
    detunes: [filter.detune],
    update(next, now) {
      filter.frequency.setTargetAtTime(Math.min(next.cutoff, nyquist), now, GLIDE);
      filter.Q.setTargetAtTime(next.res, now, GLIDE);
    },
  };
}

const PHASER_STAGES = 4;
const PHASER_HZ = 900; // where the allpasses sit; the LFO sweeps them ±2 octaves
const PHASER_CENTS = 2400;
const phaserSum = (mix) => 1 / Math.sqrt(1 + mix);

/**
 * One insert chain. `at` is when its LFOs start (a lane's entry step, so
 * the wobble starts on the grid). Returns { input, output, kind, update,
 * trigger, setStepDur, stop }; the caller wires input/output and owns the
 * fades, and calls trigger(t) on every note for the filter envelope.
 */
export function buildInsert(ctx, insert, { stepDur, at = ctx.currentTime }) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const filter = filterStage(ctx, insert);
  const pre = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const post = ctx.createGain();
  input.connect(filter.input);
  filter.output.connect(pre).connect(shaper).connect(post);

  shaper.oversample = insert.drive === "off" || insert.drive === "crush" ? "none" : "2x";
  shaper.curve = driveCurve(insert.drive, insert.amount);
  const gains = driveGains(insert.drive, insert.amount);
  pre.gain.value = gains.pre;
  post.gain.value = gains.post;

  const lfos = []; // [lfo, rate key]: they follow the BPM
  const lfo = (shape, rateKey, into, amount) => {
    const l = tempoLfo(ctx, shape, lfoHz(insert[rateKey], stepDur), at);
    const depth = gainOf(ctx, amount);
    l.out.connect(depth);
    for (const p of into) depth.connect(p);
    lfos.push([l, rateKey]);
    return { l, depth };
  };

  const filtered = insert.filter !== "off";
  const sweep = filtered ? lfo(insert.shape, "rate", filter.detunes, insert.lfo * LFO_CENTS) : null;

  // Phaser: allpasses in series, mixed back with the dry signal. The notches
  // cancel about half the power, so the sum is scaled by 1/√(1 + mix).
  let tail = post;
  let phaser = null;
  if (insert.phaser > 0) {
    const sum = gainOf(ctx, phaserSum(insert.phaser));
    const wet = gainOf(ctx, insert.phaser);
    let node = post;
    const stages = Array.from({ length: PHASER_STAGES }, () => {
      const ap = ctx.createBiquadFilter();
      ap.type = "allpass";
      ap.frequency.value = PHASER_HZ;
      ap.Q.value = 0.7;
      node = node.connect(ap);
      return ap;
    });
    node.connect(wet).connect(sum);
    post.connect(sum);
    phaser = { sum, wet, ...lfo("sine", "phaserRate", stages.map((ap) => ap.detune), PHASER_CENTS) };
    tail = sum;
  }

  // Tremolo: the level swings between 1 and 1 - trem.
  let trem = null;
  if (insert.trem > 0) {
    const amp = gainOf(ctx, 1 - insert.trem / 2);
    tail.connect(amp);
    trem = { amp, ...lfo("sine", "tremRate", [amp.gain], insert.trem / 2) };
    tail = amp;
  }
  // Pan, only on a panned sound: a StereoPannerNode spreads a mono input
  // equal-power (each side ×0.707 at the centre), so an unpanned sound skips
  // it and stays an identity, and a panned one gets √2 back: the centre is
  // unity again and a sweep keeps its power. (A stereo sample, panned, comes
  // out 3 dB hotter.)
  let panner = null;
  if (isPanned(insert)) {
    panner = ctx.createStereoPanner();
    panner.pan.value = insert.pan;
    tail.connect(panner).connect(gainOf(ctx, Math.SQRT2)).connect(output);
  } else tail.connect(output);

  // Autopan: a sine around `pan`. The panner clamps whatever passes ±1.
  const pan = insert.width > 0 ? lfo("sine", "panRate", [panner.pan], insert.width) : null;

  let current = insert;
  return {
    input,
    output,
    kind: kindOf(insert),
    // Same kind only: values glide, a crush depth swaps its curve.
    update(next, now) {
      if (next.filter !== "off") {
        filter.update(next, now);
        sweep.depth.gain.setTargetAtTime(next.lfo * LFO_CENTS, now, GLIDE);
      }
      panner?.pan.setTargetAtTime(next.pan, now, GLIDE);
      pan?.depth.gain.setTargetAtTime(next.width, now, GLIDE);
      if (phaser) {
        phaser.wet.gain.setTargetAtTime(next.phaser, now, GLIDE);
        phaser.sum.gain.setTargetAtTime(phaserSum(next.phaser), now, GLIDE);
      }
      if (trem) {
        trem.amp.gain.setTargetAtTime(1 - next.trem / 2, now, GLIDE);
        trem.depth.gain.setTargetAtTime(next.trem / 2, now, GLIDE);
      }
      for (const [l, key] of lfos) if (next[key] !== current[key]) l.setHz(lfoHz(next[key], stepDur), now, GLIDE);
      if (next.drive === "crush") {
        if (bitsFor(next.amount) !== bitsFor(current.amount)) shaper.curve = driveCurve("crush", next.amount);
      } else if (next.drive !== "off") {
        const g = driveGains(next.drive, next.amount);
        pre.gain.setTargetAtTime(g.pre, now, GLIDE);
        post.gain.setTargetAtTime(g.post, now, GLIDE);
      }
      current = next;
    },
    // A note starts at `t`: the filter envelope jumps to its depth and
    // decays back (lpenv / lpdecay), on top of the LFO.
    trigger(t) {
      if (current.filter === "off" || !current.env) return;
      for (const p of filter.detunes) {
        p.setTargetAtTime(current.env * ENV_CENTS, t, 0.002);
        p.setTargetAtTime(0, t + 0.008, current.envDecay / 3);
      }
    },
    // The BPM moved: the LFOs stay locked to the grid's speed.
    setStepDur(next, now) {
      stepDur = next;
      for (const [l, key] of lfos) l.setHz(lfoHz(current[key], stepDur), now, 0.05);
    },
    stop(when) {
      for (const [l] of lfos) l.stop(when);
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
