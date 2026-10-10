import { beforeEach, describe, expect, it } from "vitest";
import { FakeAudioContext, FakeNode, FakeParam, FakeSource } from "../test/fakeAudio.js";
import { DEFAULTS, KICK_LONG, KICK_PUNCHY, LOOP_VARIANTS, eventsAt } from "./patterns.js";
import { PARAMS, SYNTH_IDS } from "./params.js";
import { ACID_SWEEP_PERIOD, FX, GLITCH, INSTRUMENTS, SAMPLE_ROOT, VOICES, acidCutoff, kick, sample } from "./voices.js";

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

describe("drum voices stay click-free across their sliders", () => {
  for (const voice of ["kick", "hat", "chat", "shaker", "clap", "snare", "ride", "rim", ...Object.keys(GLITCH)]) {
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
