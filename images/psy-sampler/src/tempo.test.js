import { describe, expect, it } from "vitest";
import { clampBpm, rampAt } from "./tempo.js";

describe("rampAt", () => {
  it("moves linearly one slice per bar and lands exactly on the target", () => {
    const ramp = { from: 145, to: 150, bars: 4 };
    expect([0, 1, 2, 3, 4, 9].map((done) => rampAt(ramp, done))).toEqual([145, 146.25, 147.5, 148.75, 150, 150]);
    expect(rampAt({ from: 150, to: 140, bars: 2 }, 1)).toBe(145);
  });
});

describe("clampBpm", () => {
  it("rounds into the slider's range", () => {
    expect([clampBpm(149.6), clampBpm(10), clampBpm(999), clampBpm(NaN)]).toEqual([150, 130, 180, 145]);
  });
});
