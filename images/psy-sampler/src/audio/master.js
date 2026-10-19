// Mastering: what the whole mix goes through after the drop's sweep, live
// and in renders alike.
//
//   input ─> subsonic ─> mono bass ─> 3 bands ─> drive ─> limiter ─> ceiling ─> output
//
// Cleanup first. The subsonic highpass takes out DC (distortion and folds
// leave plenty) and the rumble under the kick, which only eat headroom.
// Mono bass keeps the low end in the middle: the side signal (L - R) loses
// everything under MONO_HZ, so a panned sound or a reverb tail can't smear
// the kick and the bass across the speakers.
//
// Then a three-band compressor, split by Linkwitz-Riley crossovers (two
// Butterworth biquads each side), which sum back flat: the low band takes the
// kick and bass, the mids the leads and pads, the highs the hats and the
// fizz, so the kick no longer pumps the hats. Every band runs the same
// compressor, and a band's own threshold comes from the gain around it
// (`trim`, in dB: pushed in, taken back out).
//
// Last, `drive` sets the loudness into a fast limiter, and the ceiling, a
// waveshaper, rounds off whatever overshoots it and never lets a sample past
// CEILING_DB. Not oversampled: the 4x downsampling filter rings up to 0.5 dB
// over the curve.
//
// Web Audio compressors add an automatic makeup gain, from their threshold,
// knee and ratio alone; the gain after each one takes it back, so `drive` is
// the chain's whole gain below the thresholds.

const BUTTERWORTH_DB = -3.0103; // Q 1/√2, as a lowpass or highpass reads it (dB)
const BUTTERWORTH = Math.SQRT1_2; // as an allpass reads it (linear)
const SUBSONIC_HZ = 16;
const MONO_HZ = 120;
const CROSSOVERS = [150, 5000];
// The compressor every band shares: gentle, it only leans on stacks.
const BAND_COMP = { threshold: -24, knee: 12, ratio: 2 };
const BANDS = [
  { trim: -5, attack: 0.01, release: 0.12 }, // lows: lets the kick's click through
  { trim: -2, attack: 0.005, release: 0.15 },
  { trim: -9, attack: 0.004, release: 0.08 },
];
const BAND_MAKEUP_DB = 5.31; // measured in Chrome, a 1 kHz sine at -50 and -20 dBFS
const DRIVE_DB = 4.5;
const LIMITER = { threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.06 };
// Below its threshold a knee-less compressor gains 0.6 of what it takes off
// at 0 dBFS (the spec's makeup).
const LIMITER_MAKEUP_DB = -0.6 * LIMITER.threshold * (1 - 1 / LIMITER.ratio);
const CEILING_DB = -1;
const CEILING_KNEE_DB = -1.8; // the ceiling's curve is an identity up to here
const CEILING_POINTS = 4097;

const gainOf = (db) => 10 ** (db / 20);

function gain(ctx, value = 1) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function biquad(ctx, type, frequency, Q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  return f;
}

// One side of a Linkwitz-Riley crossover (24 dB/octave): [first, last].
function lr4(ctx, type, frequency) {
  const a = biquad(ctx, type, frequency, BUTTERWORTH_DB);
  const b = biquad(ctx, type, frequency, BUTTERWORTH_DB);
  a.connect(b);
  return [a, b];
}

// The phase a crossover at `frequency` leaves on both its sides, for what
// doesn't go through it.
const allpass = (ctx, frequency) => biquad(ctx, "allpass", frequency, BUTTERWORTH);

function compressor(ctx, settings) {
  const c = ctx.createDynamicsCompressor();
  for (const [name, value] of Object.entries(settings)) c[name].value = value;
  return c;
}

// Mid/side: the side loses its lows, the mid gets the same phase, so above
// MONO_HZ the stereo image comes back untouched.
function monoBass(ctx, input, output) {
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  const mid = gain(ctx, 0.5);
  const sideLeft = gain(ctx, 0.5);
  const sideRight = gain(ctx, -0.5);
  const midPhase = allpass(ctx, MONO_HZ);
  const [sideIn, sideOut] = lr4(ctx, "highpass", MONO_HZ);
  input.connect(split);
  split.connect(mid, 0);
  split.connect(mid, 1);
  split.connect(sideLeft, 0).connect(sideIn);
  split.connect(sideRight, 1).connect(sideIn);
  mid.connect(midPhase);
  const left = gain(ctx);
  const right = gain(ctx);
  const inverted = gain(ctx, -1);
  midPhase.connect(left);
  midPhase.connect(right);
  sideOut.connect(left);
  sideOut.connect(inverted).connect(right);
  left.connect(merge, 0, 0);
  right.connect(merge, 0, 1);
  merge.connect(output);
}

// Low, mid and high, each through its compressor, summed into `output`:
// lows + mids + highs is the input through two allpasses, flat.
function bands(ctx, input, output) {
  const [lowIn, lowOut] = lr4(ctx, "lowpass", CROSSOVERS[0]);
  const [restIn, restOut] = lr4(ctx, "highpass", CROSSOVERS[0]);
  const [midIn, midOut] = lr4(ctx, "lowpass", CROSSOVERS[1]);
  const [highIn, highOut] = lr4(ctx, "highpass", CROSSOVERS[1]);
  input.connect(lowIn);
  input.connect(restIn);
  restOut.connect(midIn);
  restOut.connect(highIn);
  // The lows skip the upper crossover, so they take its phase here.
  const lowPhase = allpass(ctx, CROSSOVERS[1]);
  lowOut.connect(lowPhase);
  [lowPhase, midOut, highOut].forEach((last, i) => {
    const { trim, attack, release } = BANDS[i];
    last
      .connect(gain(ctx, gainOf(trim)))
      .connect(compressor(ctx, { ...BAND_COMP, attack, release }))
      .connect(gain(ctx, gainOf(-trim - BAND_MAKEUP_DB)))
      .connect(output);
  });
}

// Identity up to the knee, then a tanh bend that tops out at the ceiling.
// Past ±1 a waveshaper holds its curve's ends: nothing gets through above it.
export function ceilingCurve(points = CEILING_POINTS, knee = gainOf(CEILING_KNEE_DB), top = gainOf(CEILING_DB)) {
  const room = top - knee;
  return Float32Array.from({ length: points }, (_, i) => {
    const x = (2 * i) / (points - 1) - 1;
    const a = Math.abs(x);
    return a <= knee ? x : Math.sign(x) * (knee + room * Math.tanh((a - knee) / room));
  });
}

/** The mastering chain on `ctx`: { input, output }. */
export function buildMaster(ctx) {
  // Explicit stereo, so a mono mix comes in on both sides of the splitter.
  const input = ctx.createGain();
  input.channelCount = 2;
  input.channelCountMode = "explicit";
  input.channelInterpretation = "speakers";
  const [subIn, subOut] = lr4(ctx, "highpass", SUBSONIC_HZ);
  input.connect(subIn);
  const mono = gain(ctx);
  monoBass(ctx, subOut, mono);
  const drive = gain(ctx, gainOf(DRIVE_DB));
  bands(ctx, mono, drive);
  const ceiling = ctx.createWaveShaper();
  ceiling.curve = ceilingCurve();
  ceiling.oversample = "none";
  const output = gain(ctx);
  drive
    .connect(compressor(ctx, LIMITER))
    .connect(gain(ctx, gainOf(-LIMITER_MAKEUP_DB)))
    .connect(ceiling)
    .connect(output);
  return { input, output };
}
