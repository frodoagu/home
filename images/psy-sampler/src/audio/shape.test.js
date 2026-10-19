import { describe, expect, it } from "vitest";
import { FakeAudioContext } from "../test/fakeAudio.js";
import { CUT_RAMP, SHAPE_DEFAULT, cleanShape, fadesOnly, isFlat, shaped } from "./shape.js";

// A voice that rings `seconds` from t, into whatever it is handed.
const voice = (ctx, seconds) => (into) => {
  const src = ctx.createOscillator();
  src.connect(into);
  return ctx.currentTime + seconds;
};

describe("cleanShape", () => {
  it("falls back to the flat shape and clamps every share", () => {
    expect(cleanShape(null)).toEqual(SHAPE_DEFAULT);
    expect(cleanShape({ length: 0, fadeIn: -1, fadeOut: "x" })).toEqual({ length: 0.02, fadeIn: 0, fadeOut: 0 });
    expect(cleanShape({ length: 3 }).length).toBe(1);
  });

  it("lets the fade-in win when the fades overlap", () => {
    expect(cleanShape({ fadeIn: 0.7, fadeOut: 0.6 })).toEqual({ length: 1, fadeIn: 0.7, fadeOut: 0.3 });
  });
});

describe("isFlat / fadesOnly", () => {
  it("is flat with no cut and no fades, or no shape at all", () => {
    expect(isFlat(SHAPE_DEFAULT)).toBe(true);
    expect(isFlat(undefined)).toBe(true);
    expect(isFlat({ ...SHAPE_DEFAULT, length: 0.5 })).toBe(false);
    expect(isFlat({ ...SHAPE_DEFAULT, fadeOut: 0.1 })).toBe(false);
  });

  it("a sample keeps the fades and drops the voice's cut", () => {
    expect(fadesOnly({ length: 0.3, fadeIn: 0.1, fadeOut: 0.2 })).toEqual({ length: 1, fadeIn: 0.1, fadeOut: 0.2 });
    expect(isFlat(fadesOnly({ ...SHAPE_DEFAULT, length: 0.3 }))).toBe(true);
  });
});

describe("shaped", () => {
  it("adds no node for a flat shape", () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();
    const end = shaped(ctx, out, 0, SHAPE_DEFAULT, voice(ctx, 1));
    expect(end).toBe(1);
    expect(ctx.sources()[0].outputs).toEqual([out]);
  });

  it("cuts at its share of the voice with a short ramp, so the cut never clicks", () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();
    const end = shaped(ctx, out, 0, { length: 0.5, fadeIn: 0, fadeOut: 0 }, voice(ctx, 2));
    expect(end).toBe(1);
    const amp = ctx.sources()[0].outputs[0];
    expect(amp.outputs).toEqual([out]);
    expect(amp.gain.events).toEqual([
      ["set", 1, 0],
      ["set", 1, 1 - CUT_RAMP],
      ["linear", 0, 1],
    ]);
  });

  it("fades in from silence and out to it, over shares of what is kept", () => {
    const ctx = new FakeAudioContext();
    shaped(ctx, ctx.destination, 1, { length: 1, fadeIn: 0.25, fadeOut: 0.5 }, (into) => {
      ctx.createOscillator().connect(into);
      return 3;
    });
    const { events } = ctx.sources()[0].outputs[0].gain;
    expect(events).toEqual([
      ["set", 0, 1],
      ["linear", 1, 1.5],
      ["set", 1, 2],
      ["linear", 0, 3],
    ]);
  });
});
