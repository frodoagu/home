// Effects on a 🎙 take before it goes up: the sample is stored with them, so
// it sounds the same in every sound that plays it. Plain math over Float32
// channels (no AudioContext), so a take renders the same anywhere and is
// tested without audio.
//
//   pitch ─> robot / whisper ─> ring ─> filter ─> drive ─> chorus ─> echo ─> reverb ─> level ─> reverse
//
// The chorus and the reverb make it stereo. The output keeps the take's peak,
// lasts MAX_SECONDS at most (a tail past it fades out) and has no silence at
// the end; reversed, that tail swells into the take.
import { MAX_SECONDS } from "../samples.js";
import { DRIVE_TYPES, driveCurve, driveGains } from "./insert.js";
import { trimTail } from "./wav.js";

export const FX_FILTERS = ["off", "lowpass", "highpass", "bandpass"];
export const FX_DRIVES = DRIVE_TYPES;

export const FX_DEFAULT = {
  pitch: 0, // semitones, keeping the length
  robot: 0, // mix
  robotHz: 110, // the monotone the robot speaks on
  whisper: 0, // mix
  ring: 0, // mix
  ringHz: 30,
  filter: "off",
  cutoff: 1500,
  res: 1, // Q
  drive: "off",
  amount: 0.4,
  chorus: 0, // mix
  chorusDepth: 0.5,
  echo: 0, // mix
  echoTime: 0.25, // seconds
  echoFb: 0.4,
  reverb: 0, // mix
  reverbSize: 0.6,
  reverse: false,
};

// [min, max] of every number; the selects are their lists above.
export const FX_RANGES = {
  pitch: [-12, 12],
  robot: [0, 1],
  robotHz: [50, 300],
  whisper: [0, 1],
  ring: [0, 1],
  ringHz: [10, 1000],
  cutoff: [100, 12000],
  res: [0.5, 12],
  amount: [0, 1],
  chorus: [0, 1],
  chorusDepth: [0, 1],
  echo: [0, 1],
  echoTime: [0.05, 1],
  echoFb: [0, 0.9],
  reverb: [0, 1],
  reverbSize: [0, 1],
};

// Starting points: each one sets these over FX_DEFAULT.
export const FX_PRESETS = {
  none: {},
  chorus: { chorus: 0.7, chorusDepth: 0.6, reverb: 0.25, reverbSize: 0.5 },
  robot: { robot: 1, robotHz: 110, ring: 0.3, ringHz: 55, reverb: 0.15, reverbSize: 0.3 },
  dalek: { ring: 1, ringHz: 30, filter: "highpass", cutoff: 250, drive: "soft", amount: 0.3 },
  radio: { filter: "bandpass", cutoff: 1800, res: 0.8, drive: "soft", amount: 0.5 },
  megaphone: { filter: "bandpass", cutoff: 2200, res: 2, drive: "hard", amount: 0.6, reverb: 0.15, reverbSize: 0.2 },
  monster: { pitch: -7, drive: "soft", amount: 0.3, reverb: 0.25, reverbSize: 0.4 },
  chipmunk: { pitch: 9 },
  alien: { pitch: 5, ring: 0.5, ringHz: 600, echo: 0.35, echoTime: 0.18, echoFb: 0.5 },
  whisper: { whisper: 1, reverb: 0.3, reverbSize: 0.5 },
  underwater: { filter: "lowpass", cutoff: 450, res: 4, chorus: 0.6, chorusDepth: 1 },
  cathedral: { reverb: 0.6, reverbSize: 0.95 },
  space: { echo: 0.45, echoTime: 0.375, echoFb: 0.6, reverb: 0.35, reverbSize: 0.8, chorus: 0.3 },
  lofi: { drive: "crush", amount: 0.6, filter: "lowpass", cutoff: 3500 },
  ghost: { reverse: true, reverb: 0.55, reverbSize: 0.85 },
};

const clamp = (v, [min, max]) => Math.min(max, Math.max(min, v));

/** Any object -> complete, in-range settings (what the UI and a preset hand in). */
export function sanitizeFx(fx) {
  const out = { ...FX_DEFAULT };
  for (const [key, range] of Object.entries(FX_RANGES)) {
    const v = Number(fx?.[key]);
    if (Number.isFinite(v)) out[key] = clamp(v, range);
  }
  if (FX_FILTERS.includes(fx?.filter)) out.filter = fx.filter;
  if (FX_DRIVES.includes(fx?.drive)) out.drive = fx.drive;
  out.reverse = fx?.reverse === true;
  return out;
}

export const presetFx = (name) => sanitizeFx({ ...FX_DEFAULT, ...(Object.hasOwn(FX_PRESETS, name) ? FX_PRESETS[name] : {}) });

/** Nothing to do: the take goes up as recorded. */
export const isDry = (fx) => {
  const s = sanitizeFx(fx);
  return (
    s.pitch === 0 && !s.robot && !s.whisper && !s.ring && s.filter === "off" && s.drive === "off" &&
    !s.chorus && !s.echo && !s.reverb && !s.reverse
  );
};

/* ---- pitch: two read heads sliding through a delay, crossfaded ---- */

const GRAIN = 0.05; // seconds a head spans before it jumps back

// Linear read of `data` at fractional index `at`; 0 outside it.
function readAt(data, at) {
  const i = Math.floor(at);
  if (i < 0 || i >= data.length) return 0;
  const frac = at - i;
  return data[i] + frac * ((i + 1 < data.length ? data[i + 1] : 0) - data[i]);
}

/** Moves every partial by `semis` and keeps the length. */
export function pitchShift(data, sampleRate, semis) {
  const ratio = 2 ** (semis / 12);
  const span = Math.round(GRAIN * sampleRate);
  const out = new Float32Array(data.length);
  // Each head reads `ratio` samples a step, `span / 2` around now on average;
  // sin² windows half a cycle apart add up to 1.
  const slide = (1 - ratio) / span;
  for (let n = 0; n < data.length; n++) {
    let y = 0;
    for (const offset of [0, 0.5]) {
      const p = (((n * slide + offset) % 1) + 1) % 1;
      const w = Math.sin(Math.PI * p) ** 2;
      y += w * readAt(data, n + span / 2 - p * span);
    }
    out[n] = y;
  }
  return out;
}

/* ---- robot and whisper: the spectrum's phases thrown away or scrambled ---- */

// In-place radix-2 FFT; `inverse` scales by 1/N.
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
  if (!inverse) return;
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] /= n;
  }
}

const hann = (n) => Float64Array.from({ length: n }, (_, i) => Math.sin((Math.PI * i) / n) ** 2);

// mulberry32: the whisper's phases, the same on every render.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Overlap-add of frames of `size` every `hop`, each one's spectrum passed
// through `phases(re, im)`; normalized by the windows' own overlap.
function respectrum(data, size, hop, phases) {
  const win = hann(size);
  const out = new Float64Array(data.length + size);
  const norm = new Float64Array(data.length + size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const half = size / 2;
  for (let start = -half; start < data.length; start += hop) {
    for (let i = 0; i < size; i++) {
      const at = start + i;
      re[i] = at >= 0 && at < data.length ? data[at] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    phases(re, im);
    fft(re, im, true);
    for (let i = 0; i < size; i++) {
      const at = start + i;
      if (at < 0) continue;
      out[at] += re[i] * win[i];
      norm[at] += win[i] * win[i];
    }
  }
  return Float32Array.from(data, (_, i) => (norm[i] > 1e-3 ? out[i] / norm[i] : 0));
}

const pow2 = (n) => 2 ** Math.ceil(Math.log2(n));

/** Every frame's phase set to zero, one frame a period: the voice's words on a single buzzing note. */
export function robotize(data, sampleRate, hz) {
  const hop = Math.max(1, Math.round(sampleRate / hz));
  const size = Math.max(1024, pow2(2 * hop));
  return respectrum(data, size, hop, (re, im) => {
    // Zero phase puts each frame's pulse at index 0; flipping every other
    // bin's sign (a half-frame shift) centres it under the window.
    for (let i = 0; i < re.length; i++) {
      re[i] = Math.hypot(re[i], im[i]) * (i % 2 ? -1 : 1);
      im[i] = 0;
    }
  });
}

/** Random phases over frames too short to hear the harmonics: the pitch goes, the breath stays. */
export function whisperize(data, sampleRate) {
  const size = pow2(sampleRate / 200);
  const random = prng(0x5eed);
  return respectrum(data, size, size / 4, (re, im) => {
    const n = re.length;
    for (let i = 0; i <= n / 2; i++) {
      const mag = Math.hypot(re[i], im[i]);
      const phase = i === 0 || i === n / 2 ? 0 : random() * 2 * Math.PI;
      re[i] = mag * Math.cos(phase);
      im[i] = mag * Math.sin(phase);
      if (i > 0 && i < n / 2) {
        re[n - i] = re[i];
        im[n - i] = -im[i];
      }
    }
  });
}

/* ---- ring, filter and drive ---- */

export const ringMod = (data, sampleRate, hz) => data.map((x, n) => x * Math.sin((2 * Math.PI * hz * n) / sampleRate));

// RBJ cookbook biquad; the bandpass peaks at 0 dB.
export function biquad(data, sampleRate, type, hz, q) {
  const w = (2 * Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const [b0, b1, b2] =
    type === "lowpass" ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : type === "highpass" ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [alpha, 0, -alpha];
  const [a0, a1, a2] = [1 + alpha, -2 * cos, 1 - alpha];
  const out = new Float32Array(data.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let n = 0; n < data.length; n++) {
    const x = data[n];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    [x2, x1, y2, y1] = [x1, x, y1, y];
    out[n] = y;
  }
  return out;
}

/** The insert's distortion (insert.js), as its WaveShaper would play it. */
export function drive(data, type, amount) {
  const curve = driveCurve(type, amount);
  if (!curve) return data;
  const { pre, post } = driveGains(type, amount);
  const last = curve.length - 1;
  return data.map((x) => {
    const at = ((Math.max(-1, Math.min(1, x * pre)) + 1) / 2) * last;
    const i = Math.min(last - 1, Math.floor(at));
    return post * (curve[i] + (at - i) * (curve[i + 1] - curve[i]));
  });
}

/* ---- chorus, echo and reverb ---- */

// Per voice: base delay (s), LFO rate (Hz), LFO phase; the right side reads
// the same voices half a cycle apart.
const VOICES = [
  [0.012, 0.31, 0],
  [0.019, 0.47, 0.33],
  [0.026, 0.73, 0.67],
];
const CHORUS_SWING = 0.006; // seconds of delay swing at full depth

/** Mono in, [left, right] out: three detuned copies a side. */
export function chorus(data, sampleRate, mix, depth) {
  const swing = depth * CHORUS_SWING * sampleRate;
  return [0, 0.5].map((side) =>
    data.map((x, n) => {
      let wet = 0;
      for (const [base, rate, phase] of VOICES) {
        const lfo = Math.sin(2 * Math.PI * ((rate * n) / sampleRate + phase + side));
        wet += readAt(data, n - base * sampleRate - swing * (1 + lfo) / 2);
      }
      return x * (1 - mix) + (wet / VOICES.length) * mix;
    }),
  );
}

export function echo(data, sampleRate, mix, time, feedback) {
  const gap = Math.round(time * sampleRate);
  const wet = new Float32Array(data.length);
  for (let n = gap; n < data.length; n++) wet[n] = data[n - gap] + feedback * wet[n - gap];
  return data.map((x, n) => x * (1 - mix) + wet[n] * mix);
}

// Freeverb (Jezar's tunings at 44.1 kHz): eight damped combs in parallel,
// four allpasses in series; the right side's lines are 23 samples longer.
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;
const DAMP = 0.2;
const REVERB_IN = 0.015;
const REVERB_OUT = 3;

function freeverb(input, sampleRate, size, side) {
  const scale = sampleRate / 44100;
  const room = 0.7 + size * 0.28;
  const line = (len) => ({ buf: new Float32Array(Math.round((len + side * SPREAD) * scale)), i: 0, low: 0 });
  const combs = COMBS.map(line);
  const allpasses = ALLPASSES.map(line);
  const out = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) {
    const x = input[n] * REVERB_IN;
    let y = 0;
    for (const c of combs) {
      const v = c.buf[c.i];
      c.low = v * (1 - DAMP) + c.low * DAMP;
      c.buf[c.i] = x + c.low * room;
      c.i = (c.i + 1) % c.buf.length;
      y += v;
    }
    for (const a of allpasses) {
      const v = a.buf[a.i];
      a.buf[a.i] = y + v * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      y = v - y;
    }
    out[n] = y * REVERB_OUT;
  }
  return out;
}

/** Channels in, [left, right] out. */
export function reverb(channels, sampleRate, mix, size) {
  const mono = channels[0].map((_, n) => channels.reduce((sum, c) => sum + c[n], 0) / channels.length);
  return [0, 1].map((side) => {
    const wet = freeverb(mono, sampleRate, size, side);
    const dry = channels[Math.min(side, channels.length - 1)];
    return dry.map((x, n) => x * (1 - mix) + wet[n] * mix);
  });
}

/* ---- the chain ---- */

const FADE = 0.02; // seconds: a tail cut at MAX_SECONDS fades out

const peakOf = (channels) => channels.reduce((p, c) => c.reduce((q, x) => Math.max(q, Math.abs(x)), p), 0);

// Seconds the echo and the reverb ring past the take.
function tailOf(s) {
  const echoTail = s.echo ? Math.min(4, s.echoTime * (s.echoFb > 0 ? Math.log(0.001) / Math.log(s.echoFb) : 1)) : 0;
  const reverbTail = s.reverb ? 1 + s.reverbSize * 3 : 0;
  return Math.max(echoTail, reverbTail);
}

/**
 * A take ({ sampleRate, channels }) through `fx` -> the same shape. Dry
 * settings hand the take back as it is.
 */
export function renderFx(take, fx) {
  const s = sanitizeFx(fx);
  if (isDry(s)) return take;
  const { sampleRate } = take;
  const maxFrames = Math.round(MAX_SECONDS * sampleRate);
  const frames = Math.min(maxFrames, take.channels[0].length + Math.round(tailOf(s) * sampleRate));
  let channels = take.channels.map((c) => {
    const data = new Float32Array(frames);
    data.set(c.subarray(0, frames));
    return data;
  });
  const each = (fn) => (channels = channels.map(fn));
  const mixed = (dry, wet, mix) => dry.map((x, n) => x * (1 - mix) + wet[n] * mix);

  if (s.pitch) each((c) => pitchShift(c, sampleRate, s.pitch));
  if (s.robot) each((c) => mixed(c, robotize(c, sampleRate, s.robotHz), s.robot));
  if (s.whisper) each((c) => mixed(c, whisperize(c, sampleRate), s.whisper));
  if (s.ring) each((c) => mixed(c, ringMod(c, sampleRate, s.ringHz), s.ring));
  if (s.filter !== "off") each((c) => biquad(c, sampleRate, s.filter, s.cutoff, s.res));
  if (s.drive !== "off") each((c) => drive(c, s.drive, s.amount));
  if (s.chorus) channels = chorus(channels.length === 1 ? channels[0] : channels[0].map((x, n) => (x + channels[1][n]) / 2), sampleRate, s.chorus, s.chorusDepth);
  if (s.echo) each((c) => echo(c, sampleRate, s.echo, s.echoTime, s.echoFb));
  if (s.reverb) channels = reverb(channels, sampleRate, s.reverb, s.reverbSize);

  const was = peakOf(take.channels);
  const now = peakOf(channels);
  if (now > 0) each((c) => c.map((x) => (x * was) / now));
  channels = trimTail(channels, sampleRate);
  if (channels[0].length === maxFrames) {
    const fade = Math.round(FADE * sampleRate);
    for (const c of channels) for (let i = 0; i < fade; i++) c[c.length - 1 - i] *= i / fade;
  }
  if (s.reverse) each((c) => c.slice().reverse());
  return { sampleRate, channels };
}

/** renderFx in a worker (inline where there are none); the take is copied, not moved. */
export function renderFxOffThread(take, fx) {
  if (typeof Worker === "undefined") return Promise.resolve().then(() => renderFx(take, fx));
  const worker = new Worker(new URL("./takeFx.worker.js", import.meta.url), { type: "module" });
  const copy = { sampleRate: take.sampleRate, channels: take.channels.map((c) => c.slice()) };
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = (e) => reject(e.error ?? new Error(e.message));
    worker.postMessage({ take: copy, fx: sanitizeFx(fx) }, copy.channels.map((c) => c.buffer));
  }).finally(() => worker.terminate());
}
