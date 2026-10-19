import { describe, expect, it } from "vitest";
import { createTake } from "./take.js";
import { encodeWav } from "./wav.js";

const RATE = 1000; // 50 frames of tail pad
const block = (length, hits = {}) => {
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const [i, v] of Object.entries(hits)) right[i] = v;
  return [left, right];
};
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

describe("createTake", () => {
  it("records nothing while the output is silent", () => {
    const take = createTake({ sampleRate: RATE, maxSeconds: 60 });
    take.push(block(500));
    take.push(block(500, { 3: 1e-5 })); // under -80 dBFS
    expect(take.started()).toBe(false);
    expect(take.seconds()).toBe(0);
    expect(take.finish()).toBeNull();
  });

  it("starts on the first audible sample and cuts the silence after the last one", async () => {
    const take = createTake({ sampleRate: RATE, maxSeconds: 60 });
    const first = block(200, { 120: 0.5 });
    const second = block(200, { 10: -0.25 });
    const tail = block(400);
    for (const b of [block(200), first, second, tail]) take.push(b);
    expect(take.started()).toBe(true);
    expect(take.seconds()).toBeCloseTo((80 + 200 + 400) / RATE);

    const { blob, seconds } = take.finish();
    // From frame 120 of `first` to frame 10 of `second`, plus the pad.
    const frames = 80 + 11 + 50;
    expect(seconds).toBeCloseTo(frames / RATE);
    expect(blob.type).toBe("audio/wav");
    const flat = [0, 1].map((c) => new Float32Array([...first[c].slice(120), ...second[c], ...tail[c]]));
    const expected = new Uint8Array(encodeWav({ sampleRate: RATE, channels: flat.map((d) => d.slice(0, frames)) }));
    expect(await bytes(blob)).toEqual(expected);
  });

  it("stops at the maximum length", () => {
    const take = createTake({ sampleRate: RATE, maxSeconds: 0.3 });
    take.push(block(200, { 0: 0.5 }));
    expect(take.full()).toBe(false);
    take.push(block(200, { 99: 0.5, 150: 0.5 }));
    expect(take.full()).toBe(true);
    take.push(block(200, { 0: 0.5 }));
    expect(take.seconds()).toBeCloseTo(0.3);
    // Sound right up to the cap: no tail to trim, and nothing past it.
    expect(take.finish().seconds).toBeCloseTo(0.3);
  });

  it("starts over a threshold and keeps the preroll before it, across blocks", async () => {
    const take = createTake({ sampleRate: RATE, channelCount: 1, maxSeconds: 60, threshold: 0.1, preroll: 0.03 });
    const noise = new Float32Array(100).fill(0.05);
    take.push([noise]);
    expect(take.started()).toBe(false);
    const hit = new Float32Array(100).fill(0.05);
    hit[10] = 0.5;
    take.push([hit]);
    expect(take.started()).toBe(true);
    // 20 frames of the block before + 10 of this one + the hit and the rest of it.
    expect(take.seconds()).toBeCloseTo((20 + 100) / RATE);
    // The noise after the hit is under the threshold: only the pad stays.
    const { seconds } = take.finish();
    expect(seconds).toBeCloseTo((20 + 10 + 1 + 50) / RATE);
  });

  it("takes the preroll from the same block when it has room", () => {
    const take = createTake({ sampleRate: RATE, channelCount: 1, maxSeconds: 60, threshold: 0.1, preroll: 0.03 });
    const hit = new Float32Array(100);
    hit[60] = 0.5;
    take.push([new Float32Array(100)]);
    take.push([hit]);
    expect(take.seconds()).toBeCloseTo(70 / RATE);
  });
});
