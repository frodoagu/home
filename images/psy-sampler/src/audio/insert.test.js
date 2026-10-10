import { describe, expect, it } from "vitest";
import { FakeAudioContext } from "../test/fakeAudio.js";
import {
  INSERT_DEFAULT,
  LFO_CENTS,
  bitsFor,
  buildInsert,
  djCutoffs,
  driveCurve,
  driveGains,
  kindOf,
  lfoHz,
} from "./insert.js";

const STEP = 60 / 145 / 4;

const chainOf = (ins) => {
  const filter = ins.input.outputs[0];
  const pre = filter.outputs[0];
  const shaper = pre.outputs[0];
  const post = shaper.outputs[0];
  return { filter, pre, shaper, post };
};

describe("driveCurve", () => {
  it("is null when off: the shaper passes through", () => {
    expect(driveCurve("off", 0.5)).toBeNull();
  });

  for (const type of ["soft", "hard", "fold", "crush"]) {
    it(`${type} maps silence to silence and stays within ±1`, () => {
      const curve = driveCurve(type, 0.7);
      expect(curve[(curve.length - 1) / 2]).toBe(0);
      for (const v of curve) expect(Math.abs(v)).toBeLessThanOrEqual(1);
      // Odd symmetry: no DC offset from a symmetric input.
      expect(curve[0]).toBeCloseTo(-curve.at(-1), 6);
    });
  }

  it("crush quantizes to fewer levels as the amount grows", () => {
    const levels = (amount) => new Set(driveCurve("crush", amount)).size;
    expect(bitsFor(0)).toBe(8);
    expect(bitsFor(1)).toBe(2);
    expect(levels(1)).toBeLessThan(levels(0.5));
    expect(levels(0.5)).toBeLessThan(levels(0));
    expect(levels(1)).toBe(5); // 2 bits, mid-tread: -1, -0.5, 0, 0.5, 1
  });
});

describe("driveGains", () => {
  it("is unity when off or crushing", () => {
    expect(driveGains("off", 1)).toEqual({ pre: 1, post: 1 });
    expect(driveGains("crush", 1)).toEqual({ pre: 1, post: 1 });
  });

  it("more drive pushes harder into the curve and turns the output down", () => {
    const low = driveGains("soft", 0);
    const high = driveGains("soft", 1);
    expect(high.pre).toBeGreaterThan(low.pre * 20);
    expect(high.post).toBeLessThan(low.post);
  });
});

describe("buildInsert", () => {
  it("bypassed: a lowpass at Nyquist, no curve, unity gains, no LFO", () => {
    const ctx = new FakeAudioContext();
    const ins = buildInsert(ctx, INSERT_DEFAULT, { stepDur: STEP });
    const { filter, pre, shaper, post } = chainOf(ins);
    expect(filter.type).toBe("lowpass");
    expect(filter.frequency.value).toBe(24000);
    expect(shaper.curve).toBeNull();
    expect([pre.gain.value, post.gain.value]).toEqual([1, 1]);
    expect(post.outputs[0]).toBe(ins.output);
    expect(ctx.sources()).toHaveLength(0);
  });

  it("a filter gets a tempo-synced LFO on its detune, started at `at`", () => {
    const ctx = new FakeAudioContext();
    const insert = { ...INSERT_DEFAULT, filter: "highpass", cutoff: 800, res: 6, lfo: 0.5, rate: 32 };
    const ins = buildInsert(ctx, insert, { stepDur: STEP, at: 2 });
    const { filter } = chainOf(ins);
    expect([filter.type, filter.frequency.value, filter.Q.value]).toEqual(["highpass", 800, 6]);
    const [lfo] = ctx.sources();
    expect(lfo.startTime).toBe(2);
    expect(lfo.frequency.value).toBeCloseTo(lfoHz(32, STEP), 9);
    expect(lfo.frequency.value).toBeCloseTo(145 / 60 / 8, 9); // 32 steps = 2 bars
    const depth = lfo.outputs[0];
    expect(depth.gain.value).toBe(0.5 * LFO_CENTS);
    expect(depth.outputs[0]).toBe(filter.detune);
    ins.stop(5);
    expect(lfo.stopTime).toBe(5);
  });

  it("updates glide, and the LFO follows the BPM", () => {
    const ctx = new FakeAudioContext();
    const insert = { ...INSERT_DEFAULT, filter: "lowpass", drive: "soft" };
    const ins = buildInsert(ctx, insert, { stepDur: STEP });
    const { filter, pre } = chainOf(ins);
    ins.update({ ...insert, cutoff: 3000, amount: 0.9 }, 1);
    expect(filter.frequency.events.at(-1)).toEqual(["target", 3000, 1, 0.02]);
    expect(pre.gain.events.at(-1)[1]).toBeCloseTo(driveGains("soft", 0.9).pre, 9);
    ins.setStepDur(60 / 180 / 4, 2);
    const [lfo] = ctx.sources();
    expect(lfo.frequency.events.at(-1)[1]).toBeCloseTo(180 / 60 / 4, 9);
  });

  it("crush swaps its curve only when the bit depth changes", () => {
    const ctx = new FakeAudioContext();
    const insert = { ...INSERT_DEFAULT, drive: "crush", amount: 0.5 };
    const ins = buildInsert(ctx, insert, { stepDur: STEP });
    const { shaper } = chainOf(ins);
    const first = shaper.curve;
    ins.update({ ...insert, amount: 0.51 }, 1);
    expect(shaper.curve).toBe(first);
    ins.update({ ...insert, amount: 1 }, 1);
    expect(shaper.curve).toBe(driveCurve("crush", 1));
  });

  it("kindOf changes only with a type", () => {
    expect(kindOf(INSERT_DEFAULT)).toBe(kindOf({ ...INSERT_DEFAULT, cutoff: 99, amount: 1 }));
    expect(kindOf(INSERT_DEFAULT)).not.toBe(kindOf({ ...INSERT_DEFAULT, drive: "fold" }));
  });
});

describe("djCutoffs", () => {
  it("is an identity at the centre and closes either side on a log scale", () => {
    expect(djCutoffs(0, 24000)).toEqual({ low: 24000, high: 0 });
    expect(djCutoffs(-1, 24000).low).toBeCloseTo(150, 6);
    expect(djCutoffs(1, 24000).high).toBeCloseTo(6000, 6);
    expect(djCutoffs(-0.5, 24000).low).toBeCloseTo(Math.sqrt(18000 * 150), 6);
    expect(djCutoffs(0.5, 24000).low).toBe(24000);
    expect(djCutoffs(-0.5, 24000).high).toBe(0);
  });
});
