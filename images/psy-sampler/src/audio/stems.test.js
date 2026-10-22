import { describe, expect, it } from "vitest";
import { decodeWav } from "../import/pcm.js";
import { createStemsTake } from "./stems.js";

const RATE = 1000; // PAD_SECONDS (0.05) is 50 frames
const names = ["kick", "bass", "returns"];

// A block of every stem from `levels` (one per stem, a number or a function of the frame).
const block = (n, levels) =>
  levels.flatMap((level) => {
    const d = Float32Array.from({ length: n }, (_, i) => (typeof level === "function" ? level(i) : level));
    return [d, d.slice()];
  });

const read = async (stem) => decodeWav(new Uint8Array(await stem.blob.arrayBuffer()));

describe("createStemsTake", () => {
  it("keeps every stem from the start frame on, the same length, and leaves out the silent ones", async () => {
    const take = createStemsTake({ sampleRate: RATE, names, maxSeconds: 60 });
    take.push(block(500, [0.5, 0.5, 0]), 0); // before the start is known
    take.startAt(300);
    expect(take.started()).toBe(true);
    take.push(block(500, [0.5, 0, 0]), 500);
    take.push(block(500, [0, (i) => (i < 100 ? 0.25 : 0), 0]), 1000);
    expect(take.seconds()).toBe(1.2);

    const { stems, seconds } = take.finish();
    expect(stems.map((s) => s.id)).toEqual(["kick", "bass"]);
    const end = 1100 + 50 - 300; // the bass's last sound, the pad, from the start
    expect(seconds).toBe(end / RATE);
    const [kick, bass] = await Promise.all(stems.map(read));
    expect(kick.channels[0]).toHaveLength(end);
    expect(bass.channels[0]).toHaveLength(end);
    expect(kick.channels[0][0]).toBeCloseTo(0.5, 5);
    expect(kick.channels[0][699]).toBeCloseTo(0.5, 5);
    expect(kick.channels[0][700]).toBe(0);
    // The bass sounded before the start, then from frame 1000: silence in between.
    expect(bass.channels[1][0]).toBeCloseTo(0.5, 5);
    expect(bass.channels[1][199]).toBeCloseTo(0.5, 5);
    expect(bass.channels[1][200]).toBe(0);
    expect(bass.channels[1][700]).toBeCloseTo(0.25, 5);
  });

  it("stores a layer's silence before it first plays as zeros, and only encodes from there", async () => {
    const take = createStemsTake({ sampleRate: RATE, names, maxSeconds: 60 });
    take.startAt(0);
    for (let at = 0; at < 3000; at += 500) take.push(block(500, [0.5, 0, at >= 2000 ? 0.1 : 0]), at);
    const [kick, returns] = take.finish().stems;
    expect(returns.blob.size).toBe(kick.blob.size);
    const wav = await read(returns);
    expect(wav.channels[0][1999]).toBe(0);
    expect(wav.channels[0][2000]).toBeCloseTo(0.1, 5);
  });

  it("writes blocks it never got (before its first) as silence, so later ones keep their place", async () => {
    const take = createStemsTake({ sampleRate: RATE, names, maxSeconds: 60 });
    take.startAt(100);
    take.push(block(500, [0.5, 0, 0]), 400);
    const wav = await read(take.finish().stems[0]);
    expect(wav.channels[0]).toHaveLength(800);
    expect(wav.channels[0][299]).toBe(0);
    expect(wav.channels[0][300]).toBeCloseTo(0.5, 5);
  });

  it("waits for its start frame and stops at the maximum", () => {
    const take = createStemsTake({ sampleRate: RATE, names, maxSeconds: 1 });
    take.push(block(500, [0.5, 0, 0]), 0);
    expect(take.started()).toBe(false);
    take.startAt(1000); // after the block heard: none of it
    take.push(block(500, [0.5, 0, 0]), 500);
    expect(take.started()).toBe(false);
    for (let at = 1000; at < 3000; at += 500) take.push(block(500, [0.5, 0, 0]), at);
    expect(take.full()).toBe(true);
    expect(take.finish().seconds).toBe(1);
  });

  it("gives nothing back when nothing sounded", () => {
    const take = createStemsTake({ sampleRate: RATE, names, maxSeconds: 60 });
    take.startAt(0);
    take.push(block(500, [0, 0, 0]), 0);
    expect(take.finish()).toBeNull();
  });
});
