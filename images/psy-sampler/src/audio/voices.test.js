import { beforeEach, describe, expect, it } from "vitest";
import { FakeAudioContext, FakeNode, FakeParam, FakeSource } from "../test/fakeAudio.js";
import { DEFAULTS, KICK_LONG, KICK_PUNCHY, LOOP_VARIANTS, eventsAt } from "./patterns.js";
import { PARAMS, SYNTH_IDS } from "./params.js";
import {
  ACID_SWEEP_PERIOD,
  FX,
  GLITCH,
  INSTRUMENTS,
  PD_ALPHAS,
  SAMPLE_ROOT,
  VOICES,
  acidCutoff,
  choirBuffer,
  kick,
  pdSpectrum,
  sample,
} from "./voices.js";

const T = 1;
const STEP = 60 / 145 / 4;

let ctx;
let out;
beforeEach(() => {
  ctx = new FakeAudioContext();
  out = ctx.createGain();
});

// Follows a source's single output chain to the lane gain (`out`). Returns
// the automated gain nodes on the way, or null if the chain feeds an
// AudioParam instead (an LFO modulating pitch, not an audible path).
function envelopesOf(source) {
  const envs = [];
  let node = source;
  while (node !== out) {
    const next = node.outputs[0];
    if (next instanceof FakeParam) return null;
    if (!(next instanceof FakeNode)) throw new Error(`dangling ${node.kind}`);
    if (next.kind === "gain" && next.gain.events.length) envs.push(next.gain.events);
    node = next;
  }
  return envs;
}

// Every audible source must start and end at zero gain: a note boundary
// at non-zero amplitude is a click.
function expectClickFree(start) {
  const sources = ctx.sources();
  expect(sources.length).toBeGreaterThan(0);
  for (const src of sources) {
    expect(src.startTime).toBeGreaterThanOrEqual(start);
    const envs = envelopesOf(src);
    if (envs === null) continue;
    expect(envs.length).toBeGreaterThan(0);
    const env = envs.at(-1);
    const [kind0, v0, t0] = env[0];
    expect([kind0, v0]).toEqual(["set", 0]);
    expect(t0).toBeLessThanOrEqual(src.startTime);
    const [, vEnd, tEnd] = env.at(-1);
    expect(vEnd).toBe(0);
    expect(src.stopTime).toBeGreaterThanOrEqual(tEnd);
  }
}

describe("kick", () => {
  it("sweeps the sine 170 -> 50 Hz in 70 ms with a noise click", () => {
    kick(ctx, out, T, KICK_PUNCHY);
    const [body, click] = ctx.sources();
    expect(body.frequency.events).toEqual([
      ["set", 170, T],
      ["exp", 50, T + 0.07],
    ]);
    expect(click).toBeInstanceOf(FakeSource);
    expect(click.kind).toBe("buffer");
    const hp = click.outputs[0];
    expect(hp.type).toBe("highpass");
  });

  it("long body: 120 -> 42 Hz in 160 ms, 340 ms decay, no click", () => {
    kick(ctx, out, T, KICK_LONG);
    const sources = ctx.sources();
    expect(sources).toHaveLength(1);
    expect(sources[0].frequency.events).toEqual([
      ["set", 120, T],
      ["exp", 42, T + 0.16],
    ]);
    const env = envelopesOf(sources[0])[0];
    expect(env.find(([k]) => k === "exp")[2]).toBeCloseTo(T + 0.002 + 0.34, 9);
  });

  it("the click slider scales the noise transient", () => {
    kick(ctx, out, T, { ...KICK_PUNCHY, click: 0.5 });
    const noiseGain = ctx.sources()[1].outputs[0].outputs[0];
    expect(noiseGain.gain.events[1]).toEqual(["linear", 0.25, T + 0.0005]);
  });
});

describe("loop voices are click-free", () => {
  for (const variant of LOOP_VARIANTS) {
    it(variant, () => {
      for (let step = 0; step < 32; step++) {
        for (const ev of eventsAt(variant, step)) VOICES[ev.voice](ctx, out, T + step * STEP, ev, STEP);
      }
      expectClickFree(T);
    });
  }
});

describe("entry notes (lane opened mid-phrase) are click-free", () => {
  for (const variant of LOOP_VARIANTS.filter((v) => DEFAULTS[v].kind === "notes")) {
    it(variant, () => {
      // Every possible entry point, including the 1-step remainder.
      for (let step = 0; step < 32; step++) {
        for (const ev of eventsAt(variant, step, true)) VOICES[ev.voice](ctx, out, T + step * STEP, ev, STEP);
      }
      expectClickFree(T);
    });
  }
});

describe("every synth plays any note length click-free", () => {
  it("covers the editor's synth list", () => {
    expect(Object.keys(INSTRUMENTS).sort()).toEqual([...SYNTH_IDS].sort());
  });

  for (const id of SYNTH_IDS) {
    it(id, () => {
      let t = T;
      for (const steps of [1, 2, 4, 8, 16, 32]) {
        for (const [freq, bright, accent] of [[55, 0.25, false], [440, 4, true], [1760, 1, false]]) {
          INSTRUMENTS[id](ctx, out, t, { freq, steps, bright, accent }, STEP);
          t += steps * STEP;
        }
      }
      expectClickFree(T);
      for (const f of ctx.nodes.filter((n) => n.kind === "filter")) {
        expect(f.frequency.value).toBeLessThanOrEqual(18000); // under Nyquist at 44.1 kHz
      }
    });
  }
});

describe("keys", () => {
  it("a sheet clang at the hit, then 3-5 keys landing about `spread` apart", () => {
    VOICES.keys(ctx, out, T, { tone: 3200, decay: 0.09, spread: 0.01 });
    const sheet = ctx.sources().filter((s) => s.type === "triangle");
    expect(sheet).toHaveLength(5);
    expect(sheet.every((s) => s.startTime === T)).toBe(true);
    const ticks = ctx.sources().filter((s) => s.kind === "buffer").map((s) => s.startTime);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(5);
    expect(ticks[0]).toBe(T);
    for (let i = 1; i < ticks.length; i++) {
      const gap = ticks[i] - ticks[i - 1];
      expect(gap).toBeGreaterThanOrEqual(0.006 - 1e-9);
      expect(gap).toBeLessThanOrEqual(0.014 + 1e-9);
    }
    expect(ctx.sources().filter((s) => s.type === "sine")).toHaveLength(ticks.length * 2);
    expectClickFree(T);
  });
});

describe("drum voices stay click-free across their sliders", () => {
  for (const voice of ["kick", "hat", "chat", "shaker", "clap", "snare", "ride", "rim", "keys", ...Object.keys(GLITCH)]) {
    it(voice, () => {
      const spec = PARAMS[voice];
      const at = (pick) => Object.fromEntries(spec.map((p) => [p.key, p[pick]]));
      VOICES[voice](ctx, out, T, { ...at("min"), accent: false }, STEP);
      VOICES[voice](ctx, out, T + 1, { ...at("max"), accent: true }, STEP);
      expectClickFree(T);
    });
  }
});

describe("FX", () => {
  for (const [id, fx] of Object.entries(FX)) {
    for (const pick of ["def", "min", "max"]) {
      it(`${id} (${pick} params) is click-free and reports its end`, () => {
        const params = Object.fromEntries(PARAMS[id].map((p) => [p.key, p[pick]]));
        const end = fx(ctx, out, T, STEP, params);
        expectClickFree(T);
        expect(end).toBeGreaterThan(T);
        expect(Math.max(...ctx.sources().map((s) => s.stopTime))).toBeGreaterThanOrEqual(end - 1e-9);
      });
    }
  }

  it("length follows the bars slider", () => {
    expect(FX["fx.sweep"](ctx, out, T, STEP, { bars: 4 })).toBeCloseTo(T + 64 * STEP, 9);
  });

  it("riser lasts 2 bars and sweeps the band 300 -> 9000 Hz with rising gain", () => {
    const end = FX["fx.riser"](ctx, out, T, STEP);
    expect(end).toBeCloseTo(T + 32 * STEP + 0.03, 9);
    const bp = ctx.nodes.find((n) => n.kind === "filter" && n.type === "bandpass");
    expect(bp.frequency.events).toEqual([
      ["set", 300, T],
      ["exp", 9000, T + 32 * STEP],
    ]);
  });

  it("riser + impact lands the impact on the riser's end", () => {
    FX["fx.riserImpact"](ctx, out, T, STEP);
    const boom = ctx.sources().find((s) => s.kind === "oscillator");
    expect(boom.startTime).toBeCloseTo(T + 32 * STEP, 9);
    const [set, exp] = boom.frequency.events;
    expect(set).toEqual(["set", 90, boom.startTime]);
    expect(exp[1]).toBeCloseTo(28, 0);
    expect(exp[2]).toBeCloseTo(boom.startTime + 0.8, 9);
  });
});

describe("glitch voices", () => {
  it("every one has its sliders", () => {
    for (const voice of Object.keys(GLITCH)) expect(PARAMS[voice], voice).toBeDefined();
  });

  it("stutter squeezes its repeats into one step", () => {
    VOICES.stutter(ctx, out, T, { tone: 2500, repeats: 4, decay: 0.012 }, STEP);
    const starts = ctx.sources().map((s) => s.startTime);
    expect(starts).toHaveLength(4);
    starts.forEach((t, i) => expect(t).toBeCloseTo(T + (i * STEP) / 4, 9));
  });

  it("crush runs its sine through a quantizer of `bits`", () => {
    VOICES.crush(ctx, out, T, { tone: 3000, bits: 2, decay: 0.05 }, STEP);
    const shaper = ctx.nodes.find((n) => n.kind === "waveshaper");
    expect(new Set(shaper.curve).size).toBe(5); // 2 bits, mid-tread
    expect(shaper.curve[512]).toBe(0);
  });

  it("crackle scatters its clicks inside the step", () => {
    VOICES.crackle(ctx, out, T, { tone: 4000, density: 7 }, STEP);
    const starts = ctx.sources().map((s) => s.startTime);
    expect(starts).toHaveLength(7);
    for (const t of starts) expect(t).toBeLessThan(T + STEP);
  });
});

describe("phase modulation", () => {
  const ev = { freq: 220, steps: 1, bright: 1, accent: false };

  it("squelch: carrier and modulator fall an octave onto the note, the index from 7 to 0.8", () => {
    INSTRUMENTS.squelch(ctx, out, T, ev, STEP);
    const [carrier, mod] = ctx.sources();
    expect(carrier.frequency.events).toEqual([["set", 440, T], ["target", 220, T, 0.012]]);
    expect(mod.frequency.events).toEqual([["set", 880, T], ["target", 440, T, 0.012]]);
    const depth = mod.outputs[0];
    expect(depth.outputs[0]).toBe(carrier.frequency);
    expect(depth.gain.events).toEqual([["set", 880 * 7, T], ["target", 440 * 0.8, T, 0.035]]);
  });

  it("insect runs its modulator at 7:4, off the harmonics", () => {
    INSTRUMENTS.insect(ctx, out, T, ev, STEP);
    const [, mod] = ctx.sources();
    expect(mod.frequency.events.at(-1)[1]).toBeCloseTo(220 * 1.75, 9);
  });

  it("notes in a row start their modulator on different phases", () => {
    for (let i = 0; i < 4; i++) INSTRUMENTS.squelch(ctx, out, T + i * STEP, ev, STEP);
    const mods = ctx.sources().filter((_, i) => i % 2 === 1);
    expect(mods.every((m) => m.type === "custom" && m.wave.disableNormalization)).toBe(true);
    expect(new Set(mods.map((m) => m.wave)).size).toBeGreaterThan(1);
    for (const { wave } of mods) expect(Math.hypot(wave.real[1], wave.imag[1])).toBeCloseTo(1, 6);
  });

  it("the deviation stays under 12 kHz however bright and high", () => {
    INSTRUMENTS.squelch(ctx, out, T, { freq: 1760, steps: 1, bright: 4, accent: true }, STEP);
    const depth = ctx.sources()[1].outputs[0];
    expect(depth.gain.events[0][1]).toBeLessThanOrEqual(12000 + 1e-6);
  });
});

describe("phase-distortion wavetable", () => {
  const energy = ({ real, imag }, from) =>
    real.slice(from).reduce((sum, r, i) => sum + r * r + imag[from + i] ** 2, 0);

  it("α = 0 is a plain sine, and every table bites harder than the last", () => {
    const sine = pdSpectrum(0);
    expect(sine.imag[1]).toBeCloseTo(1, 6);
    expect(energy(sine, 2)).toBeCloseTo(0, 9);
    const upper = PD_ALPHAS.map((a) => energy(pdSpectrum(a), 2) / energy(pdSpectrum(a), 1));
    for (let i = 1; i < upper.length; i++) expect(upper[i]).toBeGreaterThan(upper[i - 1]);
  });

  // The table weights along a scan: one gain per oscillator, by time.
  const weights = () =>
    ctx.sources().map((o) => ({ wave: o.wave, events: o.outputs[0].gain.events }));

  it("wavetable scans down to the round table inside the step, weights summing to 1", () => {
    INSTRUMENTS.wavetable(ctx, out, T, { freq: 55, steps: 1, bright: 1, accent: false }, STEP);
    const ws = weights();
    expect(ws).toHaveLength(3); // tables 2, 1, 0
    const times = [...new Set(ws.flatMap((w) => w.events.map(([, , t]) => t)))];
    for (const t of times) {
      const at = ws.map((w) => w.events.find(([, , tt]) => tt === t)?.[1]).filter((v) => v !== undefined);
      expect(at.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    }
    const last = ws.map((w) => w.events.at(-1)[1]);
    expect(last).toEqual([1, 0, 0]);
  });

  it("morph opens from the round table to the top one over the note", () => {
    INSTRUMENTS.morph(ctx, out, T, { freq: 220, steps: 4, bright: 1, accent: false }, STEP);
    const ws = weights();
    expect(ws).toHaveLength(PD_ALPHAS.length);
    expect(ws.map((w) => w.events[0][1])).toEqual([1, 0, 0, 0]);
    expect(ws.map((w) => w.events.at(-1)[1])).toEqual([0, 0, 0, 1]);
  });
});

describe("grains", () => {
  const ev = { freq: 220, steps: 8, bright: 1, accent: false };

  it("a sung buffer, made once per context and normalized", () => {
    const buf = choirBuffer(ctx);
    expect(choirBuffer(ctx)).toBe(buf);
    expect(buf.duration).toBe(2);
    expect(Math.max(...buf.getChannelData(0).map(Math.abs))).toBeCloseTo(0.9, 6);
  });

  it("Hann grains on a 32nd-note clock, scattered inside the buffer and the stereo field", () => {
    INSTRUMENTS.grains(ctx, out, T, ev, STEP);
    const grains = ctx.sources();
    expect(grains.length).toBeGreaterThan(20);
    const gap = grains[1].startTime - grains[0].startTime;
    expect(gap).toBeCloseTo(STEP / 2, 9);
    for (const g of grains) {
      const win = g.outputs[0].gain.events;
      expect(win).toHaveLength(9);
      expect(win[0][1]).toBe(0);
      expect(win.at(-1)[1]).toBe(0);
      expect(g.offset).toBeGreaterThanOrEqual(0);
      expect(g.offset + 0.1 * g.playbackRate.value).toBeLessThanOrEqual(2);
      expect(Math.abs(g.outputs[0].outputs[0].pan.value)).toBeLessThanOrEqual(0.7);
    }
    expect(new Set(grains.map((g) => g.outputs[0].outputs[0].pan.value)).size).toBeGreaterThan(10);
  });

  it("at a slow BPM the clock halves to 64ths, and grains stay 20-100 ms", () => {
    const slow = 60 / 60 / 4;
    INSTRUMENTS.grains(ctx, out, T, ev, slow);
    const [a, b] = ctx.sources();
    expect(b.startTime - a.startTime).toBeCloseTo(slow / 4, 9);
    const len = a.outputs[0].gain.events.at(-1)[2] - a.startTime;
    expect(len).toBeGreaterThanOrEqual(0.02);
    expect(len).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it("the same note scatters the same way: a replay sounds the same", () => {
    INSTRUMENTS.grains(ctx, out, T, ev, STEP);
    const first = ctx.sources().map((g) => [g.offset, g.playbackRate.value]);
    const again = new FakeAudioContext();
    INSTRUMENTS.grains(again, again.createGain(), T, ev, STEP);
    expect(again.sources().map((g) => [g.offset, g.playbackRate.value])).toEqual(first);
  });
});

describe("sample", () => {
  // One second of a 48 kHz buffer.
  const buffer = () => ctx.createBuffer(2, 48000, 48000);
  const settings = { pitch: 0, start: 0, length: 1, reverse: false };

  it("a hit plays the sample out, from `start`, cut to `length`, click-free", () => {
    const end = sample(ctx, out, T, { sample: { ...settings, start: 0.5, length: 0.5 }, buffer: buffer() }, STEP);
    const [src] = ctx.sources();
    expect(src.offset).toBe(0.5);
    expect(end).toBeCloseTo(T + 0.25, 9);
    expectClickFree(T);
  });

  it("pitch and the note transpose it; a note lasts as long as the note", () => {
    sample(ctx, out, T, { sample: { ...settings, pitch: 12 }, buffer: buffer() }, STEP);
    expect(ctx.sources()[0].playbackRate.value).toBe(2);
    const end = sample(ctx, out, T, { sample: settings, buffer: buffer(), freq: SAMPLE_ROOT / 2, steps: 2 }, STEP);
    expect(ctx.sources()[1].playbackRate.value).toBe(0.5);
    expect(end).toBeCloseTo(T + 2 * STEP - 0.05 * STEP, 9);
    expectClickFree(T);
  });

  it("never outlasts the audio it has left", () => {
    const end = sample(ctx, out, T, { sample: { ...settings, pitch: 24 }, buffer: buffer(), freq: SAMPLE_ROOT, steps: 32 }, STEP);
    expect(end).toBeCloseTo(T + 0.25, 9); // 1 s at 4× speed
  });

  it("reverse plays a reversed copy, made once per buffer", () => {
    const b = buffer();
    b.getChannelData(0)[0] = 1;
    sample(ctx, out, T, { sample: { ...settings, reverse: true }, buffer: b }, STEP);
    sample(ctx, out, T + 1, { sample: { ...settings, reverse: true }, buffer: b }, STEP);
    const [a, c] = ctx.sources();
    expect(a.buffer).not.toBe(b);
    expect(a.buffer).toBe(c.buffer);
    expect(a.buffer.getChannelData(0).at(-1)).toBe(1);
  });
});

describe("acidCutoff", () => {
  it("drifts slowly between 300 Hz and 1.5 kHz", () => {
    expect(acidCutoff(0)).toBeCloseTo(300, 6);
    expect(acidCutoff(ACID_SWEEP_PERIOD / 2)).toBeCloseTo(1500, 6);
    expect(acidCutoff(ACID_SWEEP_PERIOD * 3 + 1)).toBeCloseTo(acidCutoff(1), 6);
    for (let t = 0; t < ACID_SWEEP_PERIOD; t += 0.37) {
      expect(acidCutoff(t)).toBeGreaterThanOrEqual(300 - 1e-9);
      expect(acidCutoff(t)).toBeLessThanOrEqual(1500 + 1e-9);
    }
  });
});
