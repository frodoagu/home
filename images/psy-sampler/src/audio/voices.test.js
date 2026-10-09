import { beforeEach, describe, expect, it } from "vitest";
import { FakeAudioContext, FakeNode, FakeParam, FakeSource } from "../test/fakeAudio.js";
import { LOOP_VARIANTS, notesAt } from "./patterns.js";
import { FX, VOICES, kick } from "./voices.js";
import { KICK_LONG, KICK_PUNCHY } from "./patterns.js";

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
});

describe("loop voices are click-free", () => {
  for (const variant of LOOP_VARIANTS) {
    it(variant, () => {
      for (let step = 0; step < 32; step++) {
        for (const ev of notesAt(variant, step)) VOICES[ev.voice](ctx, out, T + step * STEP, ev, STEP);
      }
      expectClickFree(T);
    });
  }
});

describe("entry notes (lane opened mid-phrase) are click-free", () => {
  for (const variant of ["lead.melodic", "pad.chord"]) {
    it(variant, () => {
      // Every possible entry point, including the 1-step remainder.
      for (let step = 0; step < 32; step++) {
        for (const ev of notesAt(variant, step, true)) VOICES[ev.voice](ctx, out, T + step * STEP, ev, STEP);
      }
      expectClickFree(T);
    });
  }
});

describe("FX", () => {
  for (const [id, fx] of Object.entries(FX)) {
    it(`${id} is click-free and reports its end`, () => {
      const end = fx(ctx, out, T, STEP);
      expectClickFree(T);
      expect(end).toBeGreaterThan(T);
      expect(Math.max(...ctx.sources().map((s) => s.stopTime))).toBeGreaterThanOrEqual(end - 1e-9);
    });
  }

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
    expect(boom.frequency.events).toEqual([
      ["set", 90, boom.startTime],
      ["exp", 28, boom.startTime + 0.8],
    ]);
  });
});
