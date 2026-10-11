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
  ENV_CENTS,
  HP_OPEN,
  LP_OPEN,
  VOWELS,
  isBypass,
  kindOf,
  lfoHz,
  noiseValues,
} from "./insert.js";

const STEP = 60 / 145 / 4;

const chainOf = (ins) => {
  const filter = ins.input.outputs[0];
  const pre = filter.outputs[0];
  const shaper = pre.outputs[0];
  const post = shaper.outputs[0];
  const hp = post.outputs[0];
  const lp = hp.outputs[0];
  const panner = lp.outputs[0].kind === "panner" ? lp.outputs[0] : null;
  return { filter, pre, shaper, post, hp, lp, panner };
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

describe("tone: the sound's own highpass and lowpass", () => {
  const tone = (insert) => chainOf(buildInsert(new FakeAudioContext(), { ...INSERT_DEFAULT, ...insert }, { stepDur: STEP }));

  it("runs at its cutoffs once closed, and stays out of kindOf and bypass only when open", () => {
    const { hp, lp } = tone({ hp: 300, lp: 5000 });
    expect([hp.frequency.value, lp.frequency.value]).toEqual([300, 5000]);
    expect([hp.Q.value, lp.Q.value]).toEqual([0, 0]);
    expect(kindOf({ ...INSERT_DEFAULT, hp: 300, lp: 5000 })).toBe(kindOf(INSERT_DEFAULT)); // a ride never swaps the chain
    expect(isBypass(INSERT_DEFAULT)).toBe(true);
    expect(isBypass({ ...INSERT_DEFAULT, lp: 5000 })).toBe(false);
    expect([HP_OPEN, LP_OPEN]).toEqual([INSERT_DEFAULT.hp, INSERT_DEFAULT.lp]);
  });

  it("a knob glides; a ride runs an exponential line over the ramp, landing the identity when it opens", () => {
    const ctx = new FakeAudioContext();
    const ins = buildInsert(ctx, INSERT_DEFAULT, { stepDur: STEP });
    const { hp, lp } = chainOf(ins);
    ins.update({ ...INSERT_DEFAULT, lp: 2000 }, 0);
    expect(lp.frequency.events).toEqual([["target", 2000, 0, 0.02]]);
    expect(hp.frequency.events).toEqual([]); // untouched: it did not move
    lp.frequency.events = [];
    lp.frequency.value = 2000;
    ins.update({ ...INSERT_DEFAULT, lp: 2000, hp: 400 }, 1, 3);
    expect(hp.frequency.events).toEqual([
      ["cancel", 1],
      ["set", 20, 1], // from 0 Hz an exponential line starts at the floor
      ["exp", 400, 4],
    ]);
    expect(lp.frequency.events).toEqual([]);
    hp.frequency.events = [];
    hp.frequency.value = 400;
    ins.update({ ...INSERT_DEFAULT, lp: 20000, hp: 20 }, 4, 3);
    expect(hp.frequency.events).toEqual([["cancel", 4], ["set", 400, 4], ["exp", 20, 7], ["set", 0, 7]]);
    expect(lp.frequency.events).toEqual([["cancel", 4], ["set", 2000, 4], ["exp", 24000, 7]]);
  });
});

describe("buildInsert", () => {
  it("bypassed: a lowpass at Nyquist, no curve, unity gains, no LFO", () => {
    const ctx = new FakeAudioContext();
    const ins = buildInsert(ctx, INSERT_DEFAULT, { stepDur: STEP });
    const { filter, pre, shaper, post, hp, lp, panner } = chainOf(ins);
    expect(filter.type).toBe("lowpass");
    expect(filter.frequency.value).toBe(24000);
    expect(shaper.curve).toBeNull();
    expect([pre.gain.value, post.gain.value]).toEqual([1, 1]);
    // The open tone: a highpass at 0 Hz and a lowpass at Nyquist, both identities.
    expect([hp.type, hp.frequency.value, lp.type, lp.frequency.value]).toEqual(["highpass", 0, "lowpass", 24000]);
    expect(panner).toBeNull(); // a StereoPannerNode at 0 is -3 dB on a mono input, not an identity
    expect(lp.outputs[0]).toBe(ins.output);
    expect(ctx.sources()).toHaveLength(0);
  });

  it("pans, and an autopan swings the pan with its own tempo LFO", () => {
    const ctx = new FakeAudioContext();
    const plain = buildInsert(ctx, { ...INSERT_DEFAULT, pan: -0.4 }, { stepDur: STEP });
    const { panner } = chainOf(plain);
    expect(panner.pan.value).toBe(-0.4);
    expect(panner.outputs[0].gain.value).toBe(Math.SQRT2); // equal-power back to unity at the centre
    expect(panner.outputs[0].outputs[0]).toBe(plain.output);
    expect(ctx.sources()).toHaveLength(0);
    expect(kindOf({ ...INSERT_DEFAULT, pan: -0.4 })).not.toBe(kindOf(INSERT_DEFAULT));
    const swung = buildInsert(ctx, { ...INSERT_DEFAULT, width: 0.8, panRate: 16 }, { stepDur: STEP, at: 1 });
    const [lfo] = ctx.sources();
    expect(lfo.startTime).toBe(1);
    expect(lfo.frequency.value).toBeCloseTo(lfoHz(16, STEP), 9);
    expect(lfo.outputs[0].gain.value).toBe(0.8);
    expect(lfo.outputs[0].outputs[0]).toBe(chainOf(swung).panner.pan);
    expect(kindOf({ ...INSERT_DEFAULT, width: 0.8 })).not.toBe(kindOf(INSERT_DEFAULT));
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

describe("buildInsert: shapes, vowel, envelope, phaser, tremolo", () => {
  const filtered = { ...INSERT_DEFAULT, filter: "lowpass", lfo: 0.5 };

  it("the filter LFO takes an oscillator shape, or loops a random table at the LFO's Hz", () => {
    const ctx = new FakeAudioContext();
    buildInsert(ctx, { ...filtered, shape: "sawtooth" }, { stepDur: STEP });
    expect(ctx.sources()[0].type).toBe("sawtooth");
    const ctx2 = new FakeAudioContext();
    buildInsert(ctx2, { ...filtered, shape: "random", rate: 16 }, { stepDur: STEP, at: 3 });
    const [table] = ctx2.sources();
    expect([table.kind, table.loop, table.startTime]).toEqual(["buffer", true, 3]);
    expect(table.playbackRate.value).toBeCloseTo(lfoHz(16, STEP), 9);
    expect(kindOf({ ...filtered, shape: "random" })).not.toBe(kindOf(filtered));
  });

  it("the random tables repeat from a fixed seed, inside -1..1", () => {
    const v = noiseValues();
    expect(noiseValues()).toEqual(v);
    expect(v.every((x) => x >= -1 && x < 1)).toBe(true);
  });

  it("a vowel is three bandpasses at its formants, and the LFO moves all three", () => {
    const ctx = new FakeAudioContext();
    buildInsert(ctx, { ...INSERT_DEFAULT, filter: "vowel", vowel: "o", lfo: 0.5 }, { stepDur: STEP });
    const bands = ctx.nodes.filter((n) => n.kind === "filter" && n.type === "bandpass");
    expect(bands.map((b) => b.frequency.value)).toEqual(VOWELS.o.map(([hz]) => hz));
    const depth = ctx.sources()[0].outputs[0];
    expect(depth.outputs).toEqual(bands.map((b) => b.detune));
  });

  it("trigger() opens the filter by the envelope and lets it decay, only with a filter and an envelope", () => {
    const ctx = new FakeAudioContext();
    const ins = buildInsert(ctx, { ...filtered, env: 0.5, envDecay: 0.3 }, { stepDur: STEP });
    ins.trigger(2);
    const filter = ctx.nodes.find((n) => n.kind === "filter");
    const [open, close] = filter.detune.events;
    expect(open).toEqual(["target", 0.5 * ENV_CENTS, 2, 0.002]);
    expect(close.slice(0, 3)).toEqual(["target", 0, 2.008]);
    expect(close[3]).toBeCloseTo(0.1, 9);
    const plain = buildInsert(ctx, { ...INSERT_DEFAULT, env: 0.5 }, { stepDur: STEP });
    plain.trigger(1); // filter off: nothing to move
  });

  it("phaser and tremolo only exist while on, and follow the BPM", () => {
    const ctx = new FakeAudioContext();
    buildInsert(ctx, INSERT_DEFAULT, { stepDur: STEP });
    expect(ctx.nodes.filter((n) => n.type === "allpass")).toHaveLength(0);
    const ins = buildInsert(ctx, { ...INSERT_DEFAULT, phaser: 0.6, trem: 0.4, tremRate: 1 }, { stepDur: STEP });
    expect(ctx.nodes.filter((n) => n.type === "allpass")).toHaveLength(4);
    const [phaserLfo, tremLfo] = ctx.sources();
    expect(tremLfo.frequency.value).toBeCloseTo(lfoHz(1, STEP), 9);
    const amp = tremLfo.outputs[0].outputs[0];
    expect(amp.constructor.name).toBe("FakeParam");
    ins.setStepDur(STEP / 2, 1);
    expect(phaserLfo.frequency.events.at(-1)).toEqual(["target", lfoHz(16, STEP / 2), 1, 0.05]);
    expect(kindOf({ ...INSERT_DEFAULT, phaser: 0.6 })).not.toBe(kindOf(INSERT_DEFAULT));
  });
});
