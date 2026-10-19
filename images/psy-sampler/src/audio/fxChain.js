// The 🎙 take's effects as a streaming chain: every stage keeps its state
// between blocks, so the same code renders a whole take (takeFx.js) and
// plays the microphone live, 128 frames at a time (takeFx.worklet.js).
// What the live preview plays is what goes up. Plain math, no AudioContext
// and nothing a worklet's scope lacks.
//
//   pitch ─> robot ─> whisper ─> ring ─> filter ─> drive ─> chorus ─> echo ─> reverb
//
// A stage only runs while it is on; switched off, it forgets its state. The
// chorus and the reverb make it stereo. Pitch, robot and whisper read ahead
// (`latency` samples): live that is a delay, a render takes it back out.
import { DRIVE_TYPES, driveCurve, driveGains } from "./insert.js";

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


/* ---- building blocks ---- */

const pow2 = (n) => 2 ** Math.ceil(Math.log2(n));

// An output buffer a stage reuses while the block length holds: the
// worklet's quanta allocate nothing.
const reuse = () => {
  let buf = null;
  return (n) => (buf?.length === n ? buf : (buf = new Float32Array(n)));
};

// The last `length` samples, read back `delay` samples (fractional) behind
// the newest one; zeros before anything came in.
function history(length) {
  const size = pow2(length + 2);
  const mask = size - 1;
  const buf = new Float32Array(size);
  let at = -1;
  return {
    push(x) {
      at = (at + 1) & mask;
      buf[at] = x;
    },
    read(delay) {
      const pos = at - delay;
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = buf[i & mask];
      return frac ? a + frac * (buf[(i + 1) & mask] - a) : a;
    },
  };
}

// A stage's wet signal against its dry one, delayed to line up.
function mixed(stage, mixOf) {
  const dry = history(stage.latency);
  const out = reuse();
  return {
    latency: stage.latency,
    process(block, s) {
      const wet = stage.process(block, s);
      const mix = mixOf(s);
      const y = out(block.length);
      for (let n = 0; n < block.length; n++) {
        dry.push(block[n]);
        y[n] = dry.read(stage.latency) * (1 - mix) + wet[n] * mix;
      }
      return y;
    },
  };
}

/* ---- pitch: two read heads sliding through a delay, crossfaded ---- */

const GRAIN = 0.05; // seconds a head spans before it jumps back

function pitchStage(sampleRate) {
  const span = Math.round(GRAIN * sampleRate);
  const past = history(span + 1);
  const out = reuse();
  let phase = 0;
  return {
    latency: Math.round(span / 2),
    // Each head reads 2^(pitch/12) samples a step; sin² windows half a cycle
    // apart add up to 1.
    process(block, s) {
      const slide = (1 - 2 ** (s.pitch / 12)) / span;
      const y = out(block.length);
      for (let n = 0; n < block.length; n++) {
        past.push(block[n]);
        const other = (phase + 0.5) % 1;
        y[n] = Math.sin(Math.PI * phase) ** 2 * past.read(phase * span) + Math.sin(Math.PI * other) ** 2 * past.read(other * span);
        phase = (((phase + slide) % 1) + 1) % 1;
      }
      return y;
    },
  };
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

// Overlap-add of the last `size` samples every `hopOf(s)`, each frame's
// spectrum passed through `phases(re, im)` and normalized by the windows'
// own overlap. A sample comes out `size` later, once no frame can touch it.
function stftStage(size, hopOf, phases) {
  const win = hann(size);
  const past = new Float32Array(size);
  const acc = new Float64Array(size);
  const norm = new Float64Array(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const out = reuse();
  let slot = 0; // where the next sample goes, and where the one `size` before it comes out
  let since = 0;
  function frame(start) {
    for (let i = 0; i < size; i++) {
      re[i] = past[(start + i) % size] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    phases(re, im);
    fft(re, im, true);
    for (let i = 0; i < size; i++) {
      const k = (start + i) % size;
      acc[k] += re[i] * win[i];
      norm[k] += win[i] * win[i];
    }
  }
  return {
    latency: size,
    process(block, s) {
      const hop = hopOf(s);
      const y = out(block.length);
      for (let n = 0; n < block.length; n++) {
        y[n] = norm[slot] > 1e-3 ? acc[slot] / norm[slot] : 0;
        acc[slot] = 0;
        norm[slot] = 0;
        past[slot] = block[n];
        slot = (slot + 1) % size;
        if (++since >= hop) {
          since = 0;
          frame(slot);
        }
      }
      return y;
    },
  };
}

// Every frame's phase set to zero, one frame a period of the robot's note:
// the words on a single buzzing pitch. The frame fits the lowest note's two
// periods, so the note moves live without a new chain.
function robotStage(sampleRate) {
  const size = pow2(2 * Math.round(sampleRate / FX_RANGES.robotHz[0]));
  return stftStage(size, (s) => Math.max(1, Math.round(sampleRate / s.robotHz)), (re, im) => {
    // Zero phase puts each frame's pulse at index 0; flipping every other
    // bin's sign (a half-frame shift) centres it under the window.
    for (let i = 0; i < re.length; i++) {
      re[i] = Math.hypot(re[i], im[i]) * (i % 2 ? -1 : 1);
      im[i] = 0;
    }
  });
}

// Random phases over frames too short to hear the harmonics: the pitch
// goes, the breath stays.
function whisperStage(sampleRate) {
  const size = pow2(sampleRate / 200);
  const random = prng(0x5eed);
  return stftStage(size, () => size / 4, (re, im) => {
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

function ringStage(sampleRate) {
  const out = reuse();
  let phase = 0;
  return {
    latency: 0,
    process(block, s) {
      const step = (2 * Math.PI * s.ringHz) / sampleRate;
      const y = out(block.length);
      for (let n = 0; n < block.length; n++) {
        y[n] = block[n] * (1 - s.ring + s.ring * Math.sin(phase));
        phase = (phase + step) % (2 * Math.PI);
      }
      return y;
    },
  };
}

// RBJ cookbook biquad; the bandpass peaks at 0 dB.
function filterStage(sampleRate) {
  const out = reuse();
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return {
    latency: 0,
    process(block, s) {
      const w = (2 * Math.PI * Math.min(s.cutoff, sampleRate * 0.45)) / sampleRate;
      const cos = Math.cos(w);
      const alpha = Math.sin(w) / (2 * s.res);
      const [b0, b1, b2] =
        s.filter === "lowpass"
          ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
          : s.filter === "highpass"
            ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
            : [alpha, 0, -alpha];
      const a0 = 1 + alpha;
      const a1 = -2 * cos;
      const a2 = 1 - alpha;
      const y = out(block.length);
      for (let n = 0; n < block.length; n++) {
        const x = block[n];
        const v = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = v;
        y[n] = v;
      }
      return y;
    },
  };
}

// The insert's distortion (insert.js), as its WaveShaper plays it.
function driveStage() {
  const out = reuse();
  return {
    latency: 0,
    process(block, s) {
      const curve = driveCurve(s.drive, s.amount);
      const { pre, post } = driveGains(s.drive, s.amount);
      const last = curve.length - 1;
      const y = out(block.length);
      for (let n = 0; n < block.length; n++) {
        const at = ((Math.max(-1, Math.min(1, block[n] * pre)) + 1) / 2) * last;
        const i = Math.min(last - 1, Math.floor(at));
        y[n] = post * (curve[i] + (at - i) * (curve[i + 1] - curve[i]));
      }
      return y;
    },
  };
}

/* ---- chorus, echo and reverb: channels in, channels out ---- */

// Per voice: base delay (s), LFO rate (Hz), LFO phase; the right side reads
// the same voices half a cycle apart.
const VOICES = [
  [0.012, 0.31, 0],
  [0.019, 0.47, 0.33],
  [0.026, 0.73, 0.67],
];
const CHORUS_SWING = 0.006; // seconds of delay swing at full depth

const monoOf = (channels, n) => (channels.length === 1 ? channels[0][n] : (channels[0][n] + channels[1][n]) / 2);

// Three detuned copies a side.
function chorusStage(sampleRate) {
  const past = history(Math.ceil((VOICES.at(-1)[0] + CHORUS_SWING) * sampleRate) + 1);
  const outs = [reuse(), reuse()];
  let t = 0;
  return {
    process(channels, s) {
      const length = channels[0].length;
      const swing = s.chorusDepth * CHORUS_SWING * sampleRate;
      const [left, right] = outs.map((o) => o(length));
      const wetAt = (side) => {
        let wet = 0;
        for (let v = 0; v < VOICES.length; v++) {
          const [base, rate, phase] = VOICES[v];
          const lfo = Math.sin(2 * Math.PI * ((rate * t) / sampleRate + phase + side));
          wet += past.read(base * sampleRate + (swing * (1 + lfo)) / 2);
        }
        return wet / VOICES.length;
      };
      for (let n = 0; n < length; n++) {
        const x = monoOf(channels, n);
        past.push(x);
        left[n] = x * (1 - s.chorus) + wetAt(0) * s.chorus;
        right[n] = x * (1 - s.chorus) + wetAt(0.5) * s.chorus;
        t++;
      }
      return [left, right];
    },
  };
}

// A feedback delay per channel.
function echoStage(sampleRate) {
  const longest = Math.ceil(FX_RANGES.echoTime[1] * sampleRate) + 1;
  const lines = [];
  const outs = [reuse(), reuse()];
  return {
    process(channels, s) {
      const gap = Math.max(1, Math.round(s.echoTime * sampleRate));
      return channels.map((data, c) => {
        const line = (lines[c] ??= history(longest));
        const y = outs[c](data.length);
        for (let n = 0; n < data.length; n++) {
          const wet = line.read(gap - 1);
          line.push(data[n] + s.echoFb * wet);
          y[n] = data[n] * (1 - s.echo) + wet * s.echo;
        }
        return y;
      });
    },
  };
}

// Freeverb (Jezar's tunings at 44.1 kHz): eight damped combs in parallel,
// four allpasses in series; the right side's lines are 23 samples longer.
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;
const DAMP = 0.2;
const REVERB_IN = 0.015;
const REVERB_OUT = 3;

function freeverb(sampleRate, side) {
  const scale = sampleRate / 44100;
  const line = (len) => ({ buf: new Float32Array(Math.round((len + side * SPREAD) * scale)), i: 0, low: 0 });
  const combs = COMBS.map(line);
  const allpasses = ALLPASSES.map(line);
  return (input, room) => {
    const x = input * REVERB_IN;
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
    return y * REVERB_OUT;
  };
}

function reverbStage(sampleRate) {
  const sides = [freeverb(sampleRate, 0), freeverb(sampleRate, 1)];
  const outs = [reuse(), reuse()];
  return {
    process(channels, s) {
      const length = channels[0].length;
      const room = 0.7 + s.reverbSize * 0.28;
      const [left, right] = outs.map((o) => o(length));
      for (let n = 0; n < length; n++) {
        const x = monoOf(channels, n);
        left[n] = channels[0][n] * (1 - s.reverb) + sides[0](x, room) * s.reverb;
        right[n] = channels.at(-1)[n] * (1 - s.reverb) + sides[1](x, room) * s.reverb;
      }
      return [left, right];
    },
  };
}

/* ---- the chain ---- */

// [key, on?, make]: the mono stages, then the ones over channels.
const VOICE = [
  ["pitch", (s) => s.pitch !== 0, pitchStage],
  ["robot", (s) => s.robot > 0, (rate) => mixed(robotStage(rate), (s) => s.robot)],
  ["whisper", (s) => s.whisper > 0, (rate) => mixed(whisperStage(rate), (s) => s.whisper)],
  ["ring", (s) => s.ring > 0, ringStage],
  ["filter", (s) => s.filter !== "off", filterStage],
  ["drive", (s) => s.drive !== "off", driveStage],
];
const SPACE = [
  ["chorus", (s) => s.chorus > 0, chorusStage],
  ["echo", (s) => s.echo > 0, echoStage],
  ["reverb", (s) => s.reverb > 0, reverbStage],
];

/** One chain's state: process(mono block, settings) -> its channels (one, or two once spread). */
export function createChain(sampleRate) {
  const running = new Map();
  const stage = ([key, on, make], s) => {
    if (!on(s)) {
      running.delete(key);
      return null;
    }
    if (!running.has(key)) running.set(key, make(sampleRate));
    return running.get(key);
  };
  return {
    /** Samples the output trails the input by, with `s` (sanitized). */
    latency: (s) => VOICE.reduce((sum, def) => sum + (stage(def, s)?.latency ?? 0), 0),
    process(block, s) {
      let data = block;
      for (const def of VOICE) data = stage(def, s)?.process(data, s) ?? data;
      let channels = [data];
      for (const def of SPACE) channels = stage(def, s)?.process(channels, s) ?? channels;
      return channels;
    },
  };
}

/* ---- one stage over a whole buffer, its latency taken back out (tests) ---- */

function once(stage, data, s) {
  const input = new Float32Array(data.length + stage.latency);
  input.set(data);
  return stage.process(input, s).slice(stage.latency);
}
const full = (s) => sanitizeFx({ ...FX_DEFAULT, ...s });

export const pitchShift = (data, sampleRate, semis) => once(pitchStage(sampleRate), data, full({ pitch: semis }));
export const robotize = (data, sampleRate, hz) => once(robotStage(sampleRate), data, full({ robotHz: hz }));
export const whisperize = (data, sampleRate) => once(whisperStage(sampleRate), data, full({}));
export const biquad = (data, sampleRate, filter, cutoff, res) => once(filterStage(sampleRate), data, { filter, cutoff, res });
export const drive = (data, type, amount) => once(driveStage(), data, { drive: type, amount });
export const chorus = (data, sampleRate, mix, depth) => chorusStage(sampleRate).process([data], full({ chorus: mix, chorusDepth: depth })).map((c) => c.slice());
export const echo = (data, sampleRate, mix, time, feedback) => echoStage(sampleRate).process([data], full({ echo: mix, echoTime: time, echoFb: feedback }))[0].slice();
