// Web Audio voice builders. Each one schedules a single note starting at `t`
// into `out` and stops its own sources; none of them reads the clock, so the
// scheduler alone decides timing. Loop voices share the signature
// (ctx, out, t, event, stepDur); FX take (ctx, out, t, stepDur, params) and
// return the time their sound ends.
//
// Events carry the variant's editable params (params.js), so every value
// below that has a default in the destructuring is a slider somewhere.
import { centsToRatio } from "./music.js";

const noiseCache = new WeakMap();

// 2 s of white noise per context, shared by every noise voice.
export function noiseBuffer(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 2), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

function noise(ctx, t, dur) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true; // FX outlast the 2 s buffer
  // Random read offset so back-to-back hits are not the same grain.
  src.start(t, Math.random() * 1.5);
  src.stop(t + dur);
  return src;
}

function osc(ctx, type, freq) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  return o;
}

function filter(ctx, type, freq, q = Math.SQRT1_2) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function constGain(ctx, value) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function play(sources, t, end) {
  for (const s of sources) {
    s.start(t);
    s.stop(end + 0.01);
  }
}

/**
 * Percussive envelope: linear attack to `peak`, exponential decay to -60 dB,
 * then 5 ms linear to true zero. Exponential ramps can never reach 0, and a
 * source stopped while its gain is still non-zero is exactly a click.
 * Returns the time the envelope is silent.
 */
function percEnv(param, t, peak, attack, decay) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(peak * 0.001, t + attack + decay);
  param.linearRampToValueAtTime(0, t + attack + decay + 0.005);
  return t + attack + decay + 0.005;
}

// Sustained envelope: attack -> hold -> release, all linear, starting and
// ending at 0. Long releases overlap the next note on purpose (legato).
function holdEnv(param, t, peak, attack, hold, release) {
  const h = Math.max(hold, attack); // a hold shorter than the attack would reorder the events
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setValueAtTime(peak, t + h);
  param.linearRampToValueAtTime(0, t + h + release);
  return t + h + release;
}

// Sounding length of a note `steps` 16ths long, leaving (1 - gate) of a step
// of air before the next one.
const noteLen = ({ steps = 1 }, stepDur, gate) => steps * stepDur - (1 - gate) * stepDur;
const vel = ({ accent }) => (accent ? 1.3 : 1);
// Cutoff scaled by the variant's "Brillo", kept under Nyquist.
const cut = (hz, { bright = 1 }) => Math.min(18000, hz * bright);

/* -------------------------------------------------------------- drums -- */

export function kick(ctx, out, t, { f0 = 170, f1 = 50, sweep = 0.07, decay = 0.2, click = 1, accent }) {
  const body = osc(ctx, "sine", f0);
  // The pitch drop is the punch: fast sweep, then the tail rings at f1.
  body.frequency.setValueAtTime(f0, t);
  body.frequency.exponentialRampToValueAtTime(f1, t + sweep);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, accent ? 1.2 : 1, 0.002, decay);
  body.connect(amp).connect(out);
  body.start(t);
  body.stop(end);

  if (click > 0) {
    // A few ms of high-passed noise on top: the beater transient.
    const src = noise(ctx, t, 0.03);
    const g = ctx.createGain();
    percEnv(g.gain, t, 0.5 * click, 0.0005, 0.012);
    src.connect(filter(ctx, "highpass", 3000)).connect(g).connect(out);
  }
}

export function hat(ctx, out, t, { tone = 7000, decay = 0.14, accent }) {
  const src = noise(ctx, t, decay + 0.06);
  const g = ctx.createGain();
  percEnv(g.gain, t, accent ? 0.85 : 0.6, 0.001, decay);
  src.connect(filter(ctx, "highpass", tone)).connect(g).connect(out);
}

export function chat(ctx, out, t, { tone = 9000, decay = 0.035, accent }) {
  const src = noise(ctx, t, decay + 0.04);
  const g = ctx.createGain();
  percEnv(g.gain, t, accent ? 0.9 : 0.6, 0.0005, decay);
  src.connect(filter(ctx, "highpass", tone)).connect(g).connect(out);
}

export function shaker(ctx, out, t, { tone = 6500, decay = 0.045, accent }) {
  const src = noise(ctx, t, decay + 0.06);
  const g = ctx.createGain();
  // The soft 4 ms attack is what reads as "shaker" rather than "hat".
  percEnv(g.gain, t, accent ? 0.8 : 0.32, 0.004, decay);
  src.connect(filter(ctx, "bandpass", tone, 0.9)).connect(g).connect(out);
}

export function clap(ctx, out, t, { tone = 1800, decay = 0.17, accent }) {
  const src = noise(ctx, t, decay + 0.08);
  const g = ctx.createGain();
  const peak = accent ? 2 : 1.6;
  // Two bursts 12 ms apart (hands slightly out of sync); the second carries
  // the tail.
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.001);
  g.gain.exponentialRampToValueAtTime(peak / 10, t + 0.011);
  g.gain.linearRampToValueAtTime(peak, t + 0.013);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.013 + decay);
  g.gain.linearRampToValueAtTime(0, t + 0.018 + decay);
  src.connect(filter(ctx, "bandpass", tone, 1.4)).connect(g).connect(out);
}

export function snare(ctx, out, t, { tone = 190, decay = 0.15, accent }) {
  const v = accent ? 1 : 0.7;
  // Body: a short triangle dropping a few semitones...
  const body = osc(ctx, "triangle", tone);
  body.frequency.setValueAtTime(tone, t);
  body.frequency.exponentialRampToValueAtTime(tone * 0.8, t + 0.05);
  const bg = ctx.createGain();
  const end = percEnv(bg.gain, t, 0.6 * v, 0.001, 0.08);
  body.connect(bg).connect(out);
  body.start(t);
  body.stop(end);
  // ...under the wires: band-passed noise carrying the decay.
  const src = noise(ctx, t, decay + 0.06);
  const ng = ctx.createGain();
  percEnv(ng.gain, t, 0.8 * v, 0.001, decay);
  src.connect(filter(ctx, "bandpass", 3000, 0.8)).connect(ng).connect(out);
}

// 808-style metal: six detuned squares at inharmonic ratios, band-passed.
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];

export function ride(ctx, out, t, { tone = 9000, decay = 0.45, accent }) {
  const bp = filter(ctx, "bandpass", tone, 1.2);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, accent ? 0.5 : 0.32, 0.001, decay);
  bp.connect(filter(ctx, "highpass", 6000)).connect(amp).connect(out);
  const squares = METAL.map((f) => osc(ctx, "square", f));
  for (const s of squares) s.connect(bp);
  play(squares, t, end);
}

export function rim(ctx, out, t, { tone = 1700, decay = 0.04, accent }) {
  // A short ringing triangle under a tick of noise: the stick on the rim.
  const body = osc(ctx, "triangle", tone);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, accent ? 0.7 : 0.5, 0.0005, decay);
  body.connect(filter(ctx, "bandpass", tone, 2)).connect(amp).connect(out);
  body.start(t);
  body.stop(end);
  const src = noise(ctx, t, 0.03);
  const g = ctx.createGain();
  percEnv(g.gain, t, accent ? 0.5 : 0.35, 0.0005, 0.008);
  src.connect(filter(ctx, "highpass", 4000)).connect(g).connect(out);
}

/* ------------------------------------------------------------- glitch -- */
// Hi-tech ear candy: digital artefacts rather than instruments. Several draw
// from Math.random on purpose (a different bleep per hit), like the noise.

// 2..8 bit mid-tread quantizer, shared per bit depth.
const quantizers = new Map();
function quantizer(bits) {
  let curve = quantizers.get(bits);
  if (!curve) {
    curve = new Float32Array(1025);
    const step = 2 / 2 ** bits;
    for (let i = 0; i < curve.length; i++) curve[i] = Math.round(((i / 512) - 1) / step) * step;
    quantizers.set(bits, curve);
  }
  return curve;
}

function shaper(ctx, curve) {
  const s = ctx.createWaveShaper();
  s.curve = curve;
  return s;
}

// Ratchet: `repeats` band-passed noise bursts squeezed into one step.
export function stutter(ctx, out, t, { tone = 2500, repeats = 4, decay = 0.012, accent }, stepDur) {
  const gap = stepDur / repeats;
  for (let i = 0; i < repeats; i++) {
    const at = t + i * gap;
    const len = Math.min(decay, gap * 0.8);
    const src = noise(ctx, at, len + 0.01);
    const g = ctx.createGain();
    // Each repeat a little quieter: the stutter decays like a bouncing ball.
    percEnv(g.gain, at, (accent ? 3.2 : 2.4) * (1 - (0.4 * i) / repeats), 0.0005, len);
    src.connect(filter(ctx, "bandpass", tone, 2.5)).connect(g).connect(out);
  }
}

// Computer bleep: a square on a random semitone up to `spread` octaves above `tone`.
export function blip(ctx, out, t, { tone = 1200, spread = 2, decay = 0.04, accent }) {
  const semis = Math.floor(Math.random() * (spread * 12 + 1));
  const sq = osc(ctx, "square", tone * 2 ** (semis / 12));
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, accent ? 0.8 : 0.58, 0.001, decay);
  sq.connect(filter(ctx, "lowpass", 7000)).connect(amp).connect(out);
  sq.start(t);
  sq.stop(end);
}

// "Pew": a sine diving four octaves onto `tone` in `sweep`.
export function zip(ctx, out, t, { tone = 180, sweep = 0.03, decay = 0.08, accent }) {
  const sine = osc(ctx, "sine", tone * 16);
  sine.frequency.setValueAtTime(tone * 16, t);
  sine.frequency.exponentialRampToValueAtTime(tone, t + sweep);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, accent ? 1 : 0.75, 0.0005, decay);
  sine.connect(amp).connect(out);
  sine.start(t);
  sine.stop(end);
}

// A falling sine through a few-bit quantizer: digital crunch.
export function crush(ctx, out, t, { tone = 3000, bits = 3, decay = 0.05, accent }) {
  const sine = osc(ctx, "sine", tone);
  sine.frequency.setValueAtTime(tone, t);
  sine.frequency.exponentialRampToValueAtTime(tone / 4, t + decay);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, accent ? 0.95 : 0.68, 0.0005, decay);
  sine.connect(shaper(ctx, quantizer(bits))).connect(amp).connect(out);
  sine.start(t);
  sine.stop(end);
}

// FM ping at an inharmonic ratio: struck metal, the index ringing down.
export function metal(ctx, out, t, { tone = 600, ratio = 2.76, decay = 0.12, accent }) {
  const carrier = osc(ctx, "sine", tone);
  const mod = osc(ctx, "sine", tone * ratio);
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(tone * 6, t);
  depth.gain.exponentialRampToValueAtTime(tone * 0.5, t + decay);
  mod.connect(depth).connect(carrier.frequency);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, accent ? 0.75 : 0.55, 0.0005, decay);
  carrier.connect(filter(ctx, "highpass", 300)).connect(amp).connect(out);
  play([carrier, mod], t, end);
}

// Ring modulation: a square times a sine, the robot voice of the 80s.
export function ring(ctx, out, t, { tone = 900, ring: ringHz = 1370, decay = 0.09, accent }) {
  const carrier = osc(ctx, "square", tone);
  const mod = osc(ctx, "sine", ringHz);
  const vca = constGain(ctx, 0);
  mod.connect(vca.gain);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, accent ? 0.7 : 0.5, 0.0005, decay);
  carrier.connect(vca).connect(filter(ctx, "lowpass", 9000)).connect(amp).connect(out);
  play([carrier, mod], t, end);
}

// `density` dust clicks at random spots inside the step.
export function crackle(ctx, out, t, { tone = 4000, density = 4, accent }, stepDur) {
  for (let i = 0; i < density; i++) {
    const at = t + Math.random() * stepDur * 0.9;
    const src = noise(ctx, at, 0.012);
    const g = ctx.createGain();
    percEnv(g.gain, at, (accent ? 1.4 : 0.8) * (0.4 + 0.6 * Math.random()), 0.0002, 0.002);
    src.connect(filter(ctx, "highpass", tone)).connect(g).connect(out);
  }
}

// "Bwip": a square rising three octaves from `tone` over `sweep`.
export function rise(ctx, out, t, { tone = 300, sweep = 0.08, accent }) {
  const sq = osc(ctx, "square", tone);
  sq.frequency.setValueAtTime(tone, t);
  sq.frequency.exponentialRampToValueAtTime(tone * 8, t + sweep);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, accent ? 0.8 : 0.56, 0.002, sweep);
  sq.connect(filter(ctx, "lowpass", 6000, 3)).connect(amp).connect(out);
  sq.start(t);
  sq.stop(end);
}

// Tape stop: a saw slowing to a halt, its filter closing with it.
export function tape(ctx, out, t, { tone = 800, decay = 0.18, accent }) {
  const saw = osc(ctx, "sawtooth", tone);
  saw.frequency.setValueAtTime(tone, t);
  saw.frequency.exponentialRampToValueAtTime(tone * 0.04, t + decay);
  const lp = filter(ctx, "lowpass", 5000, 2);
  lp.frequency.setValueAtTime(5000, t);
  lp.frequency.exponentialRampToValueAtTime(200, t + decay);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, accent ? 0.95 : 0.72, 0.002, decay);
  saw.connect(lp).connect(amp).connect(out);
  saw.start(t);
  saw.stop(end);
}

// Laser: a saw diving from `tone` to 60 Hz over most of its decay.
export function laser(ctx, out, t, { tone = 4000, decay = 0.15, accent }) {
  const saw = osc(ctx, "sawtooth", tone);
  saw.frequency.setValueAtTime(tone, t);
  saw.frequency.exponentialRampToValueAtTime(60, t + decay * 0.9);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, accent ? 0.6 : 0.45, 0.001, decay);
  saw.connect(filter(ctx, "lowpass", 8000, 4)).connect(amp).connect(out);
  saw.start(t);
  saw.stop(end);
}

/* --------------------------------------------------------- instruments -- */
// Melodic voices: { freq, steps, accent, bright }. Any of them can play any
// melodic variant (the editor's "Sinte" select).

export function bass(ctx, out, t, ev, stepDur) {
  const dur = noteLen(ev, stepDur, 0.85); // 1 step ends before the next 16th: no overlap with the kick
  const saw = osc(ctx, "sawtooth", ev.freq);
  const lp = filter(ctx, "lowpass", cut(1600, ev), 5);
  // Filter envelope opens on the attack and closes inside the first step: the pluck.
  lp.frequency.setValueAtTime(cut(1600, ev), t);
  lp.frequency.exponentialRampToValueAtTime(cut(140, ev), t + Math.min(dur, stepDur * 0.85));
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(0.9 * vel(ev), t + 0.003);
  amp.gain.linearRampToValueAtTime(0.6 * vel(ev), t + dur * 0.6);
  amp.gain.linearRampToValueAtTime(0, t + dur);
  saw.connect(lp).connect(amp).connect(out);
  play([saw], t, t + dur);
}

export function sub(ctx, out, t, ev, stepDur) {
  const dur = noteLen(ev, stepDur, 0.85);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.9 * vel(ev), 0.004, dur - 0.02, 0.02);
  const sine = osc(ctx, "sine", ev.freq);
  const tri = osc(ctx, "triangle", ev.freq * 2);
  sine.connect(amp);
  tri.connect(constGain(ctx, 0.2 * Math.min(ev.bright ?? 1, 2))).connect(amp);
  amp.connect(out);
  play([sine, tri], t, end);
}

export function fmBass(ctx, out, t, ev, stepDur) {
  const dur = noteLen(ev, stepDur, 0.85);
  const carrier = osc(ctx, "sine", ev.freq);
  const mod = osc(ctx, "sine", ev.freq);
  // Modulation index falls fast: bright "tok" on the attack, round tail.
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(ev.freq * 5 * (ev.bright ?? 1) * vel(ev), t);
  depth.gain.exponentialRampToValueAtTime(ev.freq * 0.3, t + Math.min(dur, 0.12));
  mod.connect(depth).connect(carrier.frequency);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.85, 0.003, dur - 0.015, 0.015);
  carrier.connect(filter(ctx, "lowpass", cut(4000, ev))).connect(amp).connect(out);
  play([carrier, mod], t, end);
}

export function reese(ctx, out, t, ev, stepDur) {
  const dur = noteLen(ev, stepDur, 0.9);
  const lp = filter(ctx, "lowpass", cut(700, ev), 1.5);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.55 * vel(ev), 0.005, dur - 0.02, 0.02);
  lp.connect(amp).connect(out);
  const saws = [-12, 12].map((c) => osc(ctx, "sawtooth", ev.freq * centsToRatio(c)));
  for (const s of saws) s.connect(lp);
  const subOsc = osc(ctx, "sine", ev.freq);
  subOsc.connect(constGain(ctx, 0.6)).connect(amp);
  play([...saws, subOsc], t, end);
}

// Slow drift of the acid filter's base cutoff: 300 Hz -> 1.5 kHz -> 300 Hz every
// ACID_SWEEP_PERIOD seconds, on a log scale so it moves evenly to the ear. It is
// driven by the audio clock, not the step, so it keeps evolving across loop
// repeats instead of restarting every 2 bars.
export const ACID_SWEEP_PERIOD = 16;
export function acidCutoff(t) {
  const phase = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / ACID_SWEEP_PERIOD);
  return 300 * 5 ** phase;
}

export function acid(ctx, out, t, ev, stepDur) {
  const dur = noteLen(ev, stepDur, 0.9);
  const saw = osc(ctx, "sawtooth", ev.freq);
  const lp = filter(ctx, "lowpass", 1000, 14);
  // Per-note filter envelope riding on the slowly drifting base cutoff; the
  // high Q makes the sweep "talk". Accents open further and close slower.
  const base = cut(acidCutoff(t), ev);
  lp.frequency.setValueAtTime(Math.min(18000, base * (ev.accent ? 6 : 3.5)), t);
  lp.frequency.setTargetAtTime(base, t, ev.accent ? 0.09 : 0.05);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, ev.accent ? 0.9 : 0.6, 0.002, dur - 0.012, 0.01);
  saw.connect(lp).connect(amp).connect(out);
  play([saw], t, end);
}

export function arp(ctx, out, t, ev, stepDur) {
  const sq = osc(ctx, "square", ev.freq);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, 0.9 * vel(ev), 0.002, noteLen(ev, stepDur, 0.9));
  sq.connect(filter(ctx, "lowpass", cut(3500, ev), 1)).connect(amp).connect(out);
  sq.start(t);
  sq.stop(end);
}

export function lead(ctx, out, t, ev, stepDur) {
  const dur = (ev.steps ?? 1) * stepDur;
  const saw = osc(ctx, "sawtooth", ev.freq);
  // Delayed vibrato: 5.5 Hz, depth fading in to +-8 cents over 400 ms.
  const lfo = osc(ctx, "sine", 5.5);
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(8, t + 0.4);
  lfo.connect(depth).connect(saw.detune);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.7 * vel(ev), 0.03, dur, 0.12);
  saw.connect(filter(ctx, "lowpass", cut(2400, ev), 1.5)).connect(amp).connect(out);
  play([saw, lfo], t, end);
}

export function supersaw(ctx, out, t, ev, stepDur) {
  const dur = noteLen(ev, stepDur, 0.9);
  const lp = filter(ctx, "lowpass", cut(5000, ev), 0.7);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.3 * vel(ev), 0.005, dur - 0.05, 0.06);
  lp.connect(amp).connect(out);
  const saws = [-18, -9, 0, 9, 18].map((c) => osc(ctx, "sawtooth", ev.freq * centsToRatio(c)));
  for (const s of saws) s.connect(lp);
  play(saws, t, end);
}

export function analog(ctx, out, t, ev, stepDur) {
  const dur = noteLen(ev, stepDur, 0.9);
  const base = cut(2800, ev);
  const lp = filter(ctx, "lowpass", base, 2);
  lp.frequency.setValueAtTime(Math.min(18000, base * 1.8), t);
  lp.frequency.setTargetAtTime(base, t, 0.05);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.4 * vel(ev), 0.008, dur - 0.04, 0.05);
  lp.connect(amp).connect(out);
  const squares = [-6, 6].map((c) => osc(ctx, "square", ev.freq * centsToRatio(c)));
  for (const s of squares) s.connect(lp);
  play(squares, t, end);
}

export function pluck(ctx, out, t, ev, stepDur) {
  const dur = noteLen(ev, stepDur, 0.9);
  const lp = filter(ctx, "lowpass", cut(6000, ev), 1);
  lp.frequency.setValueAtTime(cut(6000, ev), t);
  lp.frequency.exponentialRampToValueAtTime(cut(300, ev), t + Math.min(0.25, dur));
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, 1.1 * vel(ev), 0.002, Math.max(0.12, dur));
  lp.connect(amp).connect(out);
  const saw = osc(ctx, "sawtooth", ev.freq);
  const sq = osc(ctx, "square", ev.freq);
  saw.connect(lp);
  sq.connect(constGain(ctx, 0.5)).connect(lp);
  play([saw, sq], t, end);
}

export function fmBell(ctx, out, t, ev, stepDur) {
  const decay = Math.max(0.3, noteLen(ev, stepDur, 0.9) * 1.5);
  const carrier = osc(ctx, "sine", ev.freq);
  const mod = osc(ctx, "sine", ev.freq * 3.5);
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(ev.freq * 4 * (ev.bright ?? 1), t);
  depth.gain.exponentialRampToValueAtTime(ev.freq * 0.05, t + decay);
  mod.connect(depth).connect(carrier.frequency);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, vel(ev), 0.002, decay);
  carrier.connect(amp).connect(out);
  play([carrier, mod], t, end);
}

export function zap(ctx, out, t, ev, stepDur) {
  const dur = noteLen(ev, stepDur, 0.9);
  const saw = osc(ctx, "sawtooth", ev.freq * 4);
  saw.frequency.setValueAtTime(ev.freq * 4, t);
  saw.frequency.exponentialRampToValueAtTime(ev.freq, t + Math.min(0.04, dur));
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.7 * vel(ev), 0.002, dur - 0.01, 0.01);
  saw.connect(filter(ctx, "lowpass", cut(3000, ev), 6)).connect(amp).connect(out);
  play([saw], t, end);
}

// Square through a 3-bit quantizer: chiptune grit on a hi-tech line.
export function bitLead(ctx, out, t, ev, stepDur) {
  const dur = noteLen(ev, stepDur, 0.85);
  const sq = osc(ctx, "square", ev.freq);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.5 * vel(ev), 0.002, dur - 0.01, 0.01);
  sq.connect(constGain(ctx, 0.9))
    .connect(shaper(ctx, quantizer(3)))
    .connect(filter(ctx, "lowpass", cut(5000, ev), 1))
    .connect(amp)
    .connect(out);
  play([sq], t, end);
}

// FM chirp: pitch and index both drop in the first 25 ms, a squelchy "tchiu".
export function chirp(ctx, out, t, ev, stepDur) {
  const dur = noteLen(ev, stepDur, 0.9);
  const carrier = osc(ctx, "sine", ev.freq * 2);
  carrier.frequency.setValueAtTime(ev.freq * 2, t);
  carrier.frequency.exponentialRampToValueAtTime(ev.freq, t + Math.min(0.025, dur));
  const mod = osc(ctx, "sine", ev.freq * 2);
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(ev.freq * 8 * (ev.bright ?? 1), t);
  depth.gain.exponentialRampToValueAtTime(ev.freq * 0.5, t + Math.min(0.06, dur));
  mod.connect(depth).connect(carrier.frequency);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.7 * vel(ev), 0.001, dur - 0.012, 0.012);
  carrier.connect(amp).connect(out);
  play([carrier, mod], t, end);
}

export function pad(ctx, out, t, ev, stepDur) {
  const dur = (ev.steps ?? 1) * stepDur;
  const lp = filter(ctx, "lowpass", cut(1400, ev), 0.5);
  const amp = ctx.createGain();
  // Slow attack; the release overlaps the next retrigger so it swells back in
  // instead of gapping.
  const end = holdEnv(amp.gain, t, 0.25, Math.min(0.6, dur * 0.4), dur, 0.5);
  lp.connect(amp).connect(out);
  const saws = [-7, 7].map((c) => osc(ctx, "sawtooth", ev.freq * centsToRatio(c)));
  for (const s of saws) s.connect(lp);
  play(saws, t, end);
}

export function drone(ctx, out, t, ev, stepDur) {
  const dur = (ev.steps ?? 1) * stepDur;
  const lp = filter(ctx, "lowpass", cut(500, ev), 5);
  // 0.12 Hz LFO on the cutoff: the resonance slowly walks the harmonics.
  const lfo = osc(ctx, "sine", 0.12);
  lfo.connect(constGain(ctx, cut(300, ev))).connect(lp.frequency);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.3, Math.min(1.2, dur * 0.4), dur, 0.8);
  lp.connect(amp).connect(out);
  const saws = [-5, 5].map((c) => osc(ctx, "sawtooth", ev.freq * centsToRatio(c)));
  for (const s of saws) s.connect(lp);
  play([...saws, lfo], t, end);
}

export function air(ctx, out, t, ev, stepDur) {
  const dur = (ev.steps ?? 1) * stepDur;
  const center = Math.min(15000, ev.freq * 4);
  const bp = filter(ctx, "bandpass", center, 4);
  const lfo = osc(ctx, "sine", 0.2);
  lfo.connect(constGain(ctx, center * 0.5 * Math.min(ev.bright ?? 1, 1.5))).connect(bp.frequency);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 2, Math.min(1.5, dur * 0.4), dur, 1);
  noise(ctx, t, end + 0.01 - t).connect(bp).connect(amp).connect(out);
  play([lfo], t, end);
}

export function tom(ctx, out, t, ev) {
  const body = osc(ctx, "sine", ev.freq);
  body.frequency.setValueAtTime(ev.freq, t);
  body.frequency.exponentialRampToValueAtTime(ev.freq * 0.6, t + 0.25);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, 0.9 * vel(ev), 0.002, 0.28 * Math.min(ev.bright ?? 1, 2));
  body.connect(amp).connect(out);
  body.start(t);
  body.stop(end);
}

export const INSTRUMENTS = {
  bass,
  sub,
  fmBass,
  reese,
  acid,
  supersaw,
  analog,
  pluck,
  arp,
  lead,
  fmBell,
  zap,
  bitLead,
  chirp,
  pad,
  drone,
  air,
  tom,
};

export const GLITCH = { stutter, blip, zip, crush, metal, ring, crackle, rise, tape, laser };

export const VOICES = { kick, hat, chat, shaker, clap, snare, ride, rim, ...GLITCH, ...INSTRUMENTS };

/* ------------------------------------------------------------------ FX -- */

const barsDur = (bars, stepDur) => bars * 16 * stepDur;

export function riser(ctx, out, t, stepDur, { bars = 2, top = 9000 } = {}) {
  const dur = barsDur(bars, stepDur); // at the BPM in force when triggered
  const src = noise(ctx, t, dur + 0.05);
  const bp = filter(ctx, "bandpass", 300, 3);
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.exponentialRampToValueAtTime(top, t + dur);
  const g = ctx.createGain();
  // ~30 dB exponential rise: the build is felt mostly in the last bar.
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.03, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.9, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.03);
  src.connect(bp).connect(g).connect(out);
  return t + dur + 0.03;
}

export function impact(ctx, out, t, stepDur, { f0 = 90, decay = 1.5 } = {}) {
  const boom = osc(ctx, "sine", f0);
  boom.frequency.setValueAtTime(f0, t);
  boom.frequency.exponentialRampToValueAtTime(f0 * 0.31, t + 0.8);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, 1, 0.003, decay);
  boom.connect(amp).connect(out);
  boom.start(t);
  boom.stop(end);

  const src = noise(ctx, t, 0.7);
  const lp = filter(ctx, "lowpass", 1500);
  lp.frequency.setValueAtTime(1500, t);
  lp.frequency.exponentialRampToValueAtTime(150, t + 0.5);
  const g = ctx.createGain();
  percEnv(g.gain, t, 0.8, 0.002, 0.6);
  src.connect(lp).connect(g).connect(out);
  return end;
}

export function riserImpact(ctx, out, t, stepDur, { bars = 2 } = {}) {
  riser(ctx, out, t, stepDur, { bars });
  return impact(ctx, out, t + barsDur(bars, stepDur), stepDur);
}

export function downlifter(ctx, out, t, stepDur, { bars = 1, from = 8000 } = {}) {
  const dur = barsDur(bars, stepDur);
  // A riser in reverse: band falls to 150 Hz while the level decays...
  const src = noise(ctx, t, dur + 0.05);
  const bp = filter(ctx, "bandpass", from, 2);
  bp.frequency.setValueAtTime(from, t);
  bp.frequency.exponentialRampToValueAtTime(150, t + dur);
  const g = ctx.createGain();
  const end = percEnv(g.gain, t, 0.8, 0.01, dur);
  src.connect(bp).connect(g).connect(out);
  // ...plus a sine dive underneath for weight.
  const dive = osc(ctx, "sine", 400);
  dive.frequency.setValueAtTime(400, t);
  dive.frequency.exponentialRampToValueAtTime(40, t + dur);
  const dg = ctx.createGain();
  percEnv(dg.gain, t, 0.35, 0.01, dur);
  dive.connect(dg).connect(out);
  dive.start(t);
  dive.stop(end);
  return end;
}

export function sweep(ctx, out, t, stepDur, { bars = 1, top = 6000 } = {}) {
  const dur = barsDur(bars, stepDur);
  const half = dur / 2;
  // Narrow band going up and back down, level following it.
  const src = noise(ctx, t, dur + 0.05);
  const bp = filter(ctx, "bandpass", 400, 6);
  bp.frequency.setValueAtTime(400, t);
  bp.frequency.exponentialRampToValueAtTime(top, t + half);
  bp.frequency.exponentialRampToValueAtTime(400, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1.2, t + half);
  g.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(bp).connect(g).connect(out);
  return t + dur;
}

export function crash(ctx, out, t, stepDur, { tone = 6000, decay = 2 } = {}) {
  const src = noise(ctx, t, decay + 0.05);
  const g = ctx.createGain();
  const end = percEnv(g.gain, t, 0.7, 0.002, decay);
  src.connect(filter(ctx, "highpass", tone)).connect(g).connect(out);
  return end;
}

export function siren(ctx, out, t, stepDur, { bars = 1, rate = 7 } = {}) {
  const dur = barsDur(bars, stepDur);
  // Goa siren: a saw gliding up two octaves with a fast vibrato.
  const saw = osc(ctx, "sawtooth", 300);
  saw.frequency.setValueAtTime(300, t);
  saw.frequency.exponentialRampToValueAtTime(1200, t + dur);
  const lfo = osc(ctx, "sine", rate);
  lfo.connect(constGain(ctx, 80)).connect(saw.detune);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.35, 0.1, dur, 0.2);
  saw.connect(filter(ctx, "bandpass", 1500, 1.5)).connect(amp).connect(out);
  play([saw, lfo], t, end);
  return end;
}

// Reverse cymbal: high-passed noise swelling until it cuts on the bar line.
export function reverse(ctx, out, t, stepDur, { bars = 2, tone = 5000 } = {}) {
  const dur = barsDur(bars, stepDur);
  const src = noise(ctx, t, dur + 0.05);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.004, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.8, t + dur - 0.01);
  g.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(filter(ctx, "highpass", tone)).connect(g).connect(out);
  return t + dur;
}

// Stutter roll: noise bursts accelerating from eighths to 64ths, the band
// rising with them, cut on the bar line.
export function stutterRoll(ctx, out, t, stepDur, { bars = 1, top = 6000 } = {}) {
  const dur = barsDur(bars, stepDur);
  let at = t;
  let end = t;
  while (at < t + dur - 0.01) {
    const p = (at - t) / dur; // 0..1 through the roll
    const gap = Math.max(stepDur / 4, 2 * stepDur * (1 - p) ** 2);
    const len = Math.min(gap * 0.7, t + dur - at - 0.006);
    const src = noise(ctx, at, len + 0.01);
    const g = ctx.createGain();
    end = percEnv(g.gain, at, 0.6 + 1.6 * p, 0.0005, len);
    src.connect(filter(ctx, "bandpass", 400 * (top / 400) ** p, 3)).connect(g).connect(out);
    at += gap;
  }
  return end;
}

// Tape stop: saw + sub slowing from `f0` to nearly nothing over `decay`.
export function tapeStop(ctx, out, t, stepDur, { f0 = 600, decay = 0.8 } = {}) {
  const lp = filter(ctx, "lowpass", 4000, 1.5);
  lp.frequency.setValueAtTime(4000, t);
  lp.frequency.exponentialRampToValueAtTime(120, t + decay);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.45, 0.005, decay * 0.7, decay * 0.3);
  lp.connect(amp).connect(out);
  const voices = [osc(ctx, "sawtooth", f0), osc(ctx, "sine", f0 / 2)];
  voices.forEach((o, i) => {
    const f = f0 / (i + 1);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.03, t + decay);
    o.connect(lp);
  });
  play(voices, t, end);
  return end;
}

export const FX = {
  "fx.riser": riser,
  "fx.riserImpact": riserImpact,
  "fx.down": downlifter,
  "fx.sweep": sweep,
  "fx.impact": impact,
  "fx.crash": crash,
  "fx.siren": siren,
  "fx.reverse": reverse,
  "fx.stutter": stutterRoll,
  "fx.tapeStop": tapeStop,
};

/* ------------------------------------------------------------- sample -- */
// A user's sample (samples.js) as a one-shot: `ev.buffer` is the decoded
// audio, `ev.sample` its settings { pitch, start, length, reverse }. A note
// event (it has `freq`) plays it transposed from A3 and as long as the note;
// a hit or an FX plays it out. Returns when it is silent.

export const SAMPLE_ROOT = 220; // A3: a note there plays the sample as recorded

const reversedCache = new WeakMap();
function reversed(ctx, buffer) {
  let rev = reversedCache.get(buffer);
  if (!rev) {
    rev = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) rev.getChannelData(c).set(buffer.getChannelData(c).toReversed());
    reversedCache.set(buffer, rev);
  }
  return rev;
}

export function sample(ctx, out, t, ev, stepDur) {
  const { buffer, sample: s } = ev;
  const src = ctx.createBufferSource();
  src.buffer = s.reverse ? reversed(ctx, buffer) : buffer;
  const rate = 2 ** (s.pitch / 12) * (ev.freq ? ev.freq / SAMPLE_ROOT : 1);
  src.playbackRate.value = rate;
  const offset = s.start * buffer.duration;
  // Seconds of output the sample has left, cut to `length` of it.
  const left = ((buffer.duration - offset) * s.length) / rate;
  const want = ev.freq ? noteLen(ev, stepDur, 0.95) : left;
  const dur = Math.max(0.01, Math.min(left, want));
  const amp = ctx.createGain();
  // Fades of a few ms both ends: a slice taken mid-waveform would click.
  const end = holdEnv(amp.gain, t, vel(ev), 0.002, dur - 0.006, 0.006);
  src.connect(amp).connect(out);
  src.start(t, offset);
  src.stop(end + 0.01);
  return end;
}
