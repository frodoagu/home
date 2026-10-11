import { describe, expect, it } from "vitest";
import { TAP_RESET_MS, addTap, clampBpm, rampAt, tapBpm } from "./tempo.js";

describe("rampAt", () => {
  it("moves linearly one slice per bar and lands exactly on the target", () => {
    const ramp = { from: 145, to: 150, bars: 4 };
    expect([0, 1, 2, 3, 4, 9].map((done) => rampAt(ramp, done))).toEqual([145, 146.25, 147.5, 148.75, 150, 150]);
    expect(rampAt({ from: 150, to: 140, bars: 2 }, 1)).toBe(145);
  });
});

describe("clampBpm", () => {
  it("rounds into the slider's range", () => {
    expect([clampBpm(149.6), clampBpm(10), clampBpm(999), clampBpm(NaN)]).toEqual([150, 60, 180, 145]);
  });
});

describe("tap tempo", () => {
  const tap = (...times) => times.reduce(addTap, []);

  it("averages the taps, starting over after a pause, and keeps the last eight", () => {
    expect(tapBpm(tap(0))).toBeNull();
    expect(tapBpm(tap(0, 400, 800, 1200))).toBe(150);
    expect(tap(0, 400, 400 + TAP_RESET_MS + 1)).toEqual([2401]);
    expect(tap(...Array.from({ length: 12 }, (_, i) => i * 400))).toHaveLength(8);
  });

  it("brings half and double time into range by octaves, and clamps the rest", () => {
    expect(tapBpm(tap(0, 800, 1600))).toBe(75); // in range: no octave move
    expect(tapBpm(tap(0, 2000, 4000))).toBe(60); // 30 BPM
    expect(tapBpm(tap(0, 200, 400))).toBe(150); // 300 BPM
    expect(tapBpm(tap(0, 1200))).toBe(60); // 50: no octave fits
    expect(tapBpm(tap(0, 300))).toBe(180); // 200: no octave fits
    expect(tapBpm(tap(0, 0))).toBeNull();
  });
});
