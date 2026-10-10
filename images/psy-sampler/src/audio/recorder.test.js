import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecorder } from "./recorder.js";

// An engine whose output the test plays by hand through `feed`.
let feed;
let untapped;
let engine;
beforeEach(() => {
  feed = null;
  untapped = 0;
  engine = {
    ensureContext: () => ({ sampleRate: 1000 }),
    tap: vi.fn(async (onAudio) => {
      feed = onAudio;
      return async () => {
        untapped++;
      };
    }),
  };
});

const silence = (n) => [new Float32Array(n), new Float32Array(n)];
const sound = (n) => [new Float32Array(n).fill(0.5), new Float32Array(n).fill(0.5)];

describe("createRecorder", () => {
  it("waits for the first sound, then records until stopped", async () => {
    const rec = createRecorder(engine);
    expect(rec.state()).toBe("idle");
    await rec.start();
    expect(rec.state()).toBe("waiting");
    feed(silence(500));
    expect(rec.state()).toBe("waiting");
    feed(sound(2000));
    expect(rec.state()).toBe("recording");
    expect(rec.seconds()).toBe(2);

    const { blob, seconds } = await rec.stop();
    expect(seconds).toBe(2);
    expect(blob.size).toBe(44 + 2000 * 6);
    expect(untapped).toBe(1);
    expect(rec.state()).toBe("idle");
  });

  it("gives nothing back when nothing sounded", async () => {
    const rec = createRecorder(engine);
    await rec.start();
    feed(silence(500));
    expect(await rec.stop()).toBeNull();
    expect(untapped).toBe(1);
  });

  it("taps once however many times start is pressed", async () => {
    const rec = createRecorder(engine);
    rec.start();
    await rec.start();
    expect(engine.tap).toHaveBeenCalledTimes(1);
  });

  it("calls onFull once at the maximum length", async () => {
    const rec = createRecorder(engine, { maxSeconds: 1 });
    const full = vi.fn();
    rec.onFull(full);
    await rec.start();
    feed(sound(600));
    feed(sound(600));
    feed(sound(600));
    expect(full).toHaveBeenCalledTimes(1);
    expect((await rec.stop()).seconds).toBe(1);
  });

  it("goes back to idle where the browser can't record", async () => {
    engine.tap = async () => {
      throw new Error("no AudioWorklet");
    };
    const rec = createRecorder(engine);
    await expect(rec.start()).rejects.toThrow();
    expect(rec.state()).toBe("idle");
    expect(await rec.stop()).toBeNull();
  });
});
