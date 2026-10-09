// Web Audio voice builders. Each one schedules a single note starting at `t`
// into `out` and stops its own sources; none of them reads the clock, so the
// scheduler alone decides timing. Loop voices share the signature
// (ctx, out, t, event, stepDur); FX take (ctx, out, t, stepDur) and return the
// time their sound ends.
import { centsToRatio } from "./music.js";
import { acidCutoff } from "./patterns.js";

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
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setValueAtTime(peak, t + hold);
  param.linearRampToValueAtTime(0, t + hold + release);
  return t + hold + release;
}

/* ---------------------------------------------------------------- kick -- */

export function kick(ctx, out, t, { f0, f1, sweep, decay, click }) {
  const body = osc(ctx, "sine", f0);
  // The pitch drop is the punch: fast sweep, then the tail rings at f1.
  body.frequency.setValueAtTime(f0, t);
  body.frequency.exponentialRampToValueAtTime(f1, t + sweep);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, 1, 0.002, decay);
  body.connect(amp).connect(out);
  body.start(t);
  body.stop(end);

  if (click) {
    // A few ms of high-passed noise on top: the beater transient.
    const src = noise(ctx, t, 0.03);
    const g = ctx.createGain();
    percEnv(g.gain, t, 0.5, 0.0005, 0.012);
    src.connect(filter(ctx, "highpass", 3000)).connect(g).connect(out);
  }
}

/* ---------------------------------------------------------------- bass -- */

export function bass(ctx, out, t, { freq }, stepDur) {
  const dur = stepDur * 0.85; // ends before the next 16th: no overlap with the kick
  const saw = osc(ctx, "sawtooth", freq);
  const lp = filter(ctx, "lowpass", 1600, 5);
  // Filter envelope opens on the attack and closes inside the note: the pluck.
  lp.frequency.setValueAtTime(1600, t);
  lp.frequency.exponentialRampToValueAtTime(140, t + dur);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(0.9, t + 0.003);
  amp.gain.linearRampToValueAtTime(0.6, t + dur * 0.6);
  amp.gain.linearRampToValueAtTime(0, t + dur);
  saw.connect(lp).connect(amp).connect(out);
  saw.start(t);
  saw.stop(t + dur + 0.01);
}

/* ---------------------------------------------------------- percussion -- */

export function hat(ctx, out, t) {
  const src = noise(ctx, t, 0.2);
  const g = ctx.createGain();
  percEnv(g.gain, t, 0.6, 0.001, 0.14);
  src.connect(filter(ctx, "highpass", 7000)).connect(g).connect(out);
}

export function shaker(ctx, out, t, { accent }) {
  const src = noise(ctx, t, 0.1);
  const g = ctx.createGain();
  // The soft 4 ms attack is what reads as "shaker" rather than "hat".
  percEnv(g.gain, t, accent ? 0.8 : 0.32, 0.004, 0.045);
  src.connect(filter(ctx, "bandpass", 6500, 0.9)).connect(g).connect(out);
}

export function clap(ctx, out, t) {
  const src = noise(ctx, t, 0.25);
  const g = ctx.createGain();
  // Two bursts 12 ms apart (hands slightly out of sync); the second carries
  // the tail.
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1.6, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.011);
  g.gain.linearRampToValueAtTime(1.6, t + 0.013);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  g.gain.linearRampToValueAtTime(0, t + 0.185);
  src.connect(filter(ctx, "bandpass", 1800, 1.4)).connect(g).connect(out);
}

/* ---------------------------------------------------------------- lead -- */

export function acid(ctx, out, t, { freq, accent }, stepDur) {
  const dur = stepDur * 0.9;
  const saw = osc(ctx, "sawtooth", freq);
  const lp = filter(ctx, "lowpass", 1000, 14);
  // Per-note filter envelope riding on the slowly drifting base cutoff; the
  // high Q makes the sweep "talk". Accents open further and close slower.
  const base = acidCutoff(t);
  lp.frequency.setValueAtTime(base * (accent ? 6 : 3.5), t);
  lp.frequency.setTargetAtTime(base, t, accent ? 0.09 : 0.05);
  const amp = ctx.createGain();
  holdEnv(amp.gain, t, accent ? 0.9 : 0.6, 0.002, dur - 0.012, 0.01);
  saw.connect(lp).connect(amp).connect(out);
  saw.start(t);
  saw.stop(t + dur + 0.01);
}

export function arp(ctx, out, t, { freq }, stepDur) {
  const sq = osc(ctx, "square", freq);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, 0.9, 0.002, stepDur * 0.9);
  sq.connect(filter(ctx, "lowpass", 3500, 1)).connect(amp).connect(out);
  sq.start(t);
  sq.stop(end);
}

export function lead(ctx, out, t, { freq, steps }, stepDur) {
  const dur = steps * stepDur;
  const release = 0.12;
  const saw = osc(ctx, "sawtooth", freq);
  // Delayed vibrato: 5.5 Hz, depth fading in to +-8 cents over 400 ms.
  const lfo = osc(ctx, "sine", 5.5);
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(8, t + 0.4);
  lfo.connect(depth).connect(saw.detune);
  const amp = ctx.createGain();
  const end = holdEnv(amp.gain, t, 0.7, 0.03, dur, release);
  saw.connect(filter(ctx, "lowpass", 2400, 1.5)).connect(amp).connect(out);
  for (const node of [saw, lfo]) {
    node.start(t);
    node.stop(end + 0.01);
  }
}

/* ----------------------------------------------------------------- pad -- */

export function pad(ctx, out, t, { freqs, steps }, stepDur) {
  const dur = steps * stepDur;
  const lp = filter(ctx, "lowpass", 1400, 0.5);
  const amp = ctx.createGain();
  // Slow attack; the release overlaps the next retrigger so it swells back in
  // instead of gapping.
  const end = holdEnv(amp.gain, t, 0.25, Math.min(0.6, dur * 0.4), dur, 0.5);
  lp.connect(amp).connect(out);
  for (const f of freqs) {
    for (const cents of [-7, 7]) {
      const saw = osc(ctx, "sawtooth", f * centsToRatio(cents));
      saw.connect(lp);
      saw.start(t);
      saw.stop(end + 0.01);
    }
  }
}

/* ------------------------------------------------------------------ FX -- */

export function riser(ctx, out, t, stepDur) {
  const dur = 32 * stepDur; // 2 bars at the BPM in force when triggered
  const src = noise(ctx, t, dur + 0.05);
  const bp = filter(ctx, "bandpass", 300, 3);
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
  const g = ctx.createGain();
  // ~30 dB exponential rise: the build is felt mostly in the last bar.
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.03, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.9, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.03);
  src.connect(bp).connect(g).connect(out);
  return t + dur + 0.03;
}

export function impact(ctx, out, t) {
  const boom = osc(ctx, "sine", 90);
  boom.frequency.setValueAtTime(90, t);
  boom.frequency.exponentialRampToValueAtTime(28, t + 0.8);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, 1, 0.003, 1.5);
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

export function riserImpact(ctx, out, t, stepDur) {
  riser(ctx, out, t, stepDur);
  return impact(ctx, out, t + 32 * stepDur);
}

export function downlifter(ctx, out, t, stepDur) {
  const dur = 16 * stepDur;
  // A riser in reverse: band falls 8 kHz -> 150 Hz while the level decays...
  const src = noise(ctx, t, dur + 0.05);
  const bp = filter(ctx, "bandpass", 8000, 2);
  bp.frequency.setValueAtTime(8000, t);
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

export function sweep(ctx, out, t, stepDur) {
  const dur = 16 * stepDur;
  const half = dur / 2;
  // Narrow band going up and back down over one bar, level following it.
  const src = noise(ctx, t, dur + 0.05);
  const bp = filter(ctx, "bandpass", 400, 6);
  bp.frequency.setValueAtTime(400, t);
  bp.frequency.exponentialRampToValueAtTime(6000, t + half);
  bp.frequency.exponentialRampToValueAtTime(400, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1.2, t + half);
  g.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(bp).connect(g).connect(out);
  return t + dur;
}

export const VOICES = { kick, bass, hat, shaker, clap, acid, arp, lead, pad };

export const FX = {
  "fx.riser": riser,
  "fx.riserImpact": riserImpact,
  "fx.down": downlifter,
  "fx.sweep": sweep,
  "fx.impact": impact,
};
