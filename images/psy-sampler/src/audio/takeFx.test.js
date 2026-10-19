import { describe, expect, it } from "vitest";
import { MAX_SECONDS } from "../samples.js";
import { driveCurve, driveGains } from "./insert.js";
import {
  FX_DEFAULT,
  FX_PRESETS,
  FX_RANGES,
  biquad,
  chorus,
  createChain,
  drive,
  echo,
  fft,
  isDry,
  pitchShift,
  presetFx,
  renderFx,
  robotize,
  sanitizeFx,
  whisperize,
} from "./takeFx.js";

const RATE = 8000;
const sine = (hz, seconds, amp = 0.5) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, n) => amp * Math.sin((2 * Math.PI * hz * n) / RATE));
const noise = (seconds) => {
  let a = 1;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    a = (a * 16807) % 2147483647;
    return (a / 2147483647) * 2 - 1;
  });
};
const peak = (data) => data.reduce((p, x) => Math.max(p, Math.abs(x)), 0);
const rms = (data, from = 0, to = data.length) => Math.sqrt(data.slice(from, to).reduce((s, x) => s + x * x, 0) / (to - from));
// Upward zero crossings a second, over the middle of `data` (away from the edges).
function hzOf(data) {
  const from = Math.floor(data.length / 4);
  const to = Math.floor((3 * data.length) / 4);
  let n = 0;
  for (let i = from + 1; i < to; i++) if (data[i - 1] < 0 && data[i] >= 0) n++;
  return n / ((to - from) / RATE);
}
// The lag (in [min, max]) where `data` best matches itself.
function period(data, min, max) {
  let best = min;
  let score = -Infinity;
  for (let lag = min; lag <= max; lag++) {
    let s = 0;
    for (let i = 0; i + lag < data.length; i++) s += data[i] * data[i + lag];
    if (s > score) [best, score] = [lag, s];
  }
  return best;
}

describe("settings", () => {
  it("sanitize fills, clamps and drops what isn't a setting", () => {
    expect(sanitizeFx(undefined)).toEqual(FX_DEFAULT);
    const s = sanitizeFx({ pitch: 40, robot: -1, filter: "comb", drive: "fold", reverse: "yes", cutoff: "nan", extra: 1 });
    expect(s).toEqual({ ...FX_DEFAULT, pitch: 12, robot: 0, drive: "fold" });
  });

  it("every preset stays in range and only the dry one is dry", () => {
    for (const [name, preset] of Object.entries(FX_PRESETS)) {
      const fx = presetFx(name);
      for (const key of Object.keys(preset)) expect(fx[key], `${name}.${key}`).toBe(preset[key]);
      for (const [key, [min, max]] of Object.entries(FX_RANGES)) expect(fx[key]).toBeGreaterThanOrEqual(min) && expect(fx[key]).toBeLessThanOrEqual(max);
      expect(isDry(fx), name).toBe(name === "none");
    }
    expect(presetFx("__proto__")).toEqual(FX_DEFAULT);
  });

  it("dry settings hand the take back untouched", () => {
    const take = { sampleRate: RATE, channels: [sine(200, 0.5)] };
    expect(renderFx(take, FX_DEFAULT)).toBe(take);
  });
});

describe("the stages", () => {
  it("fft and its inverse round-trip, and find a bin's tone", () => {
    const re = Float64Array.from({ length: 64 }, (_, n) => Math.cos((2 * Math.PI * 5 * n) / 64));
    const im = new Float64Array(64);
    const original = re.slice();
    fft(re, im);
    expect(Math.hypot(re[5], im[5])).toBeCloseTo(32);
    expect(Math.hypot(re[6], im[6])).toBeCloseTo(0);
    fft(re, im, true);
    re.forEach((x, i) => expect(x).toBeCloseTo(original[i]));
  });

  it("pitch moves a tone an octave and keeps the length", () => {
    const up = pitchShift(sine(200, 1), RATE, 12);
    expect(up).toHaveLength(RATE);
    expect(hzOf(up)).toBeGreaterThan(380);
    expect(hzOf(up)).toBeLessThan(420);
    expect(hzOf(pitchShift(sine(400, 1), RATE, -12))).toBeCloseTo(200, -1);
  });

  it("the robot speaks on one note whatever goes in", () => {
    for (const hz of [80, 160]) {
      const out = robotize(noise(1), RATE, hz);
      expect(period(out.subarray(2000, 6000), 20, 120)).toBe(Math.round(RATE / hz));
    }
  });

  it("the whisper keeps the level and loses the voice's period", () => {
    // A buzz at 200 Hz: a pulse every 40 samples, matching itself a period later.
    const buzz = biquad(Float32Array.from({ length: RATE }, (_, n) => (n % 40 ? 0 : 1)), RATE, "lowpass", 1500, 0.7);
    const self = (d, lag) => d.slice(2000, 6000).reduce((s, x, i) => s + x * d[2000 + i + lag], 0);
    expect(self(buzz, 40) / self(buzz, 0)).toBeGreaterThan(0.9);
    const out = whisperize(buzz, RATE);
    expect(rms(out, 2000, 6000)).toBeGreaterThan(rms(buzz, 2000, 6000) * 0.5);
    expect(self(out, 40) / self(out, 0)).toBeLessThan(0.3);
  });

  it("a lowpass keeps lows and cuts highs; a highpass, the reverse", () => {
    const low = sine(100, 0.5);
    const high = sine(3000, 0.5);
    expect(rms(biquad(low, RATE, "lowpass", 800, 0.7), 1000)).toBeCloseTo(rms(low, 1000), 1);
    expect(rms(biquad(high, RATE, "lowpass", 800, 0.7), 1000)).toBeLessThan(rms(high) * 0.1);
    expect(rms(biquad(low, RATE, "highpass", 800, 0.7), 1000)).toBeLessThan(rms(low) * 0.1);
    expect(rms(biquad(sine(800, 0.5), RATE, "bandpass", 800, 2), 1000)).toBeCloseTo(rms(low, 1000), 1);
  });

  it("the drive is the insert's curve", () => {
    const out = drive(Float32Array.of(0, 0.1, -0.5, 1), "hard", 0.5);
    const { pre, post } = driveGains("hard", 0.5);
    const curve = driveCurve("hard", 0.5);
    const at = (x) => curve[Math.round(((Math.max(-1, Math.min(1, x * pre)) + 1) / 2) * (curve.length - 1))] * post;
    [0, 0.1, -0.5, 1].forEach((x, i) => expect(out[i]).toBeCloseTo(at(x), 2));
  });

  it("the chorus spreads one channel into two different ones", () => {
    const [left, right] = chorus(sine(300, 1), RATE, 0.7, 1);
    expect(left).toHaveLength(RATE);
    expect(rms(left.map((x, i) => x - right[i]), 1000)).toBeGreaterThan(0.01);
  });

  it("an echo repeats every gap, quieter each time", () => {
    const click = new Float32Array(RATE);
    click[0] = 1;
    const out = echo(click, RATE, 0.5, 0.25, 0.5);
    expect([out[0], out[2000], out[4000], out[6000]]).toEqual([0.5, 0.5, 0.25, 0.125]);
  });
});

describe("the chain", () => {
  it("plays the same 128 frames at a time as in one block: the live preview is the render", () => {
    const s = sanitizeFx({ pitch: -3, robot: 0.5, whisper: 0.3, ring: 0.4, filter: "bandpass", drive: "soft", chorus: 0.5, echo: 0.4, echoTime: 0.1, reverb: 0.4 });
    const input = noise(0.5);
    const whole = createChain(RATE).process(input, s).map((c) => c.slice());
    const live = createChain(RATE);
    const parts = [[], []];
    for (let at = 0; at < input.length; at += 128) live.process(input.subarray(at, at + 128), s).forEach((c, i) => parts[i].push(...c));
    for (const c of [0, 1]) parts[c].forEach((x, i) => expect(x).toBeCloseTo(whole[c][i], 5));
  });

  it("trails by what pitch, robot and whisper read ahead", () => {
    const chain = createChain(RATE);
    expect(chain.latency(sanitizeFx({ reverb: 1, chorus: 1, drive: "hard" }))).toBe(0);
    expect(chain.latency(sanitizeFx({ pitch: 2 }))).toBe(200); // half of 50 ms
    expect(chain.latency(sanitizeFx({ pitch: 2, whisper: 1 }))).toBe(200 + 64);
  });

  it("a stage switched off forgets its tail", () => {
    const chain = createChain(RATE);
    const click = new Float32Array(128);
    click[0] = 1;
    chain.process(click, sanitizeFx({ echo: 1, echoTime: 0.05, echoFb: 0.9 }));
    chain.process(new Float32Array(128), sanitizeFx({}));
    const [again] = chain.process(new Float32Array(800), sanitizeFx({ echo: 1, echoTime: 0.05, echoFb: 0.9 }));
    expect(peak(again)).toBe(0);
  });
});

describe("renderFx", () => {
  const take = () => ({ sampleRate: RATE, channels: [sine(220, 1, 0.4)] });

  it("keeps the take's peak", () => {
    for (const name of Object.keys(FX_PRESETS).filter((n) => n !== "none")) {
      const out = renderFx(take(), presetFx(name));
      expect(Math.max(...out.channels.map(peak)), name).toBeCloseTo(0.4, 5);
    }
  });

  it("the chorus and the reverb make it stereo; a reverb rings past the take", () => {
    expect(renderFx(take(), { pitch: 3 }).channels).toHaveLength(1);
    expect(renderFx(take(), { chorus: 0.5 }).channels).toHaveLength(2);
    const wet = renderFx(take(), { reverb: 0.5, reverbSize: 1 });
    expect(wet.channels).toHaveLength(2);
    expect(wet.channels[0].length).toBeGreaterThan(RATE * 1.5);
  });

  it("never lasts more than a sample may, and fades out where it is cut", () => {
    const long = { sampleRate: RATE, channels: [sine(220, MAX_SECONDS, 0.4)] };
    const { channels } = renderFx(long, { echo: 0.6, echoTime: 1, echoFb: 0.9 });
    expect(channels[0]).toHaveLength(MAX_SECONDS * RATE);
    expect(Math.abs(channels[0].at(-1))).toBe(0);
  });

  it("reversed, it ends where the take began", () => {
    const click = new Float32Array(RATE);
    click[0] = 0.5;
    click[100] = 0.25;
    const out = renderFx({ sampleRate: RATE, channels: [click] }, { reverse: true });
    const data = out.channels[0];
    expect(data.at(-1)).toBe(0.5);
    expect(data.at(-101)).toBe(0.25);
  });
});
