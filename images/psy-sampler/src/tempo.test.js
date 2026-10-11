import { describe, expect, it } from "vitest";
import { TAP_BOUNCE_MS, TAP_RESET_MS, addTap, clampBpm, rampAt, tapBeat } from "./tempo.js";

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
  const tap = (...times) => times.reduce(addTap, null);
  const bpmOf = (...times) => tapBeat(tap(...times))?.bpm ?? null;

  it("fits the BPM from the second tap on, starting over after a pause, and keeps the last 32", () => {
    expect(tapBeat(tap(0))).toBeNull();
    expect(tapBeat(tap(0, 400, 800, 1200))).toEqual({ bpm: 150, at: 0 });
    expect(tap(0, 400, 400 + TAP_RESET_MS + 1)).toEqual({ first: 0, times: [2401] });
    const long = tap(...Array.from({ length: 40 }, (_, i) => 1000 + i * 400));
    expect(long.times).toHaveLength(32);
    expect(long.first).toBe(8);
    // The 1 stays where the count began, after its tap is gone.
    expect(tapBeat(long)).toEqual({ bpm: 150, at: 1000 });
  });

  it("weighs every tap, not just the first and the last", () => {
    // 145 BPM with a late first tap and an early last one: first-to-last says 146.
    const beat = 60000 / 145;
    const jitter = [18, -6, 4, 9, -8, 2, -3, 7, -9, 5, -2, 6, -7, 3, -4, -18];
    const times = jitter.map((j, i) => i * beat + j);
    expect(Math.round(60000 / ((times.at(-1) - times[0]) / 15))).toBe(146);
    expect(bpmOf(...times)).toBe(145);
  });

  it("puts the 1 on the fitted line, at the rounded BPM", () => {
    // Every tap 30 ms late: the line, and the 1 on it, shift with them.
    expect(tapBeat(tap(1030, 1430, 1830))).toEqual({ bpm: 150, at: 1030 });
    // 151.5 BPM rounds to 152: the line runs at 152 through the taps' centre.
    const beat = 60000 / 151.5;
    const { bpm, at } = tapBeat(tap(0, beat, 2 * beat));
    expect(bpm).toBe(152);
    expect(at).toBeCloseTo(beat - 60000 / 152, 6);
  });

  it("drops a bounce", () => {
    const count = tap(0, 400);
    expect(addTap(count, 400 + TAP_BOUNCE_MS - 1)).toBe(count);
    expect(tap(0, 0)).toEqual({ first: 0, times: [0] });
  });

  it("brings half and double time into range by octaves, and clamps the rest", () => {
    expect(bpmOf(0, 800, 1600)).toBe(75); // in range: no octave move
    expect(bpmOf(0, 2000, 4000)).toBe(60); // 30 BPM
    expect(bpmOf(0, 200, 400)).toBe(150); // 300 BPM
    expect(bpmOf(0, 1200)).toBe(60); // 50: no octave fits
    expect(bpmOf(0, 300)).toBe(180); // 200: no octave fits
    // Half time: each tap is two beats, so the 1 stays on the first tap.
    expect(tapBeat(tap(500, 1300, 2100, 2900))).toEqual({ bpm: 75, at: 500 });
    expect(tapBeat(tap(500, 2100, 3700))).toEqual({ bpm: 75, at: 500 }); // 37.5 BPM, doubled
    expect(tapBeat(tap(500, 700, 900, 1100))).toEqual({ bpm: 150, at: 500 }); // double time
  });
});
