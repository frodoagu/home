import { describe, expect, it } from "vitest";
import { bandsOf, beatOf, createListener } from "./listen.js";

describe("bandsOf", () => {
  it("averages the bins of each band", () => {
    const freq = new Uint8Array(1024); // 48 kHz: 23.4 Hz a bin
    freq.fill(255, 1, 7); // 23-164 Hz: the lows
    const b = bandsOf(freq, 48000);
    expect(b.low).toBeGreaterThan(0.8);
    expect(b.mid).toBeLessThan(0.05);
    expect(b.high).toBe(0);
  });
});

describe("beatOf", () => {
  it("finds the beat from the gaps between kicks, folding octaves", () => {
    const kicks = [0, 400, 800, 1600, 2000, 2400, 3200]; // 150 BPM with gaps missing
    expect(beatOf(kicks)).toBeCloseTo(400, 0);
    expect(beatOf([0, 200, 400, 600, 800])).toBeCloseTo(400, 0); // eighths read as beats
    expect(beatOf([0, 400])).toBe(null);
  });
});

// Kicks every `beat` ms from `from` for `beats` beats, through a listener
// fed at 60 fps; returns its events.
function hearKicks(hear, { from = 0, beats, beat = 400, until = from + beats * beat }) {
  const out = [];
  for (let t = from; t < until; t += 1000 / 60) {
    const sinceKick = (t - from) % beat;
    const kick = t - from < beats * beat && sinceKick < 1000 / 60;
    out.push(...hear(t, { low: kick ? 0.9 : 0.1, mid: 0.2, high: 0.1 }));
  }
  return out;
}

describe("createListener", () => {
  it("hears kicks, takes their tempo and lays bar lines four beats apart", () => {
    const hear = createListener({ bpm: 120 });
    const events = hearKicks(hear, { beats: 24 });
    const kicks = events.filter((e) => e.kind === "hit" && e.layer === "kick");
    expect(kicks.length).toBeGreaterThanOrEqual(22);
    const bars = events.filter((e) => e.kind === "bar");
    expect(bars.length).toBeGreaterThanOrEqual(5);
    expect(bars.at(-1).bpm).toBeCloseTo(150, -1);
    expect(bars.at(-1).time - bars.at(-2).time).toBeCloseTo(1600, -2);
    expect(events.filter((e) => e.kind === "levels").length).toBeGreaterThan(100);
  });

  it("calls a breakdown when the kick goes, and a drop when it comes back", () => {
    const hear = createListener();
    const events = [
      ...hearKicks(hear, { beats: 16 }),
      ...hearKicks(hear, { from: 6400, beats: 0, until: 6400 + 4000 }),
      ...hearKicks(hear, { from: 10400, beats: 8 }),
    ];
    const lanes = events.filter((e) => e.kind === "lanes").map((e) => e.variants.includes("kick"));
    expect(lanes).toEqual([true, false, true]);
    const drops = events.filter((e) => e.kind === "drop");
    expect(drops).toHaveLength(1);
    expect(drops[0].time).toBeGreaterThanOrEqual(10400);
  });
});
