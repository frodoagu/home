import { beforeEach, describe, expect, it, vi } from "vitest";
import { STEMS_MAX_SECONDS, createRecorder, createStemsRecorder, stemsMaxSeconds } from "./recorder.js";
import { STEMS } from "./engine.js";

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

describe("createStemsRecorder", () => {
  let listener;
  beforeEach(() => {
    listener = null;
    engine.listen = vi.fn((fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    });
    engine.tapStems = engine.tap;
  });
  // Every stem, the kick's at `level`.
  const stems = (n, level) => STEMS.flatMap((id) => [0, 1].map(() => new Float32Array(n).fill(id === "kick" ? level : 0)));

  it("starts on the next bar line, with its tempo, and ends every stem together", async () => {
    const rec = createStemsRecorder(engine);
    await rec.start();
    feed(stems(1000, 0.5), 0);
    expect(rec.state()).toBe("waiting");
    listener({ kind: "hit", time: 0.2 });
    listener({ kind: "bar", time: 1.5, bpm: 140 });
    expect(listener).toBeNull();
    feed(stems(1000, 0.5), 1000);
    feed(stems(1000, 0.5), 2000);
    expect(rec.state()).toBe("recording");
    expect(rec.seconds()).toBe(1.5);

    const { stems: files, seconds, bpm } = await rec.stop();
    expect(bpm).toBe(140);
    expect(seconds).toBe(1.5);
    expect(files.map((f) => [f.id, f.blob.size])).toEqual([["kick", 44 + 1500 * 6]]);
    expect(untapped).toBe(1);
    expect(rec.state()).toBe("idle");
  });

  it("lets a bar announced before the tap connects go by, and starts on the next", async () => {
    const rec = createStemsRecorder(engine);
    const starting = rec.start();
    listener({ kind: "bar", time: 0.5, bpm: 145 }); // the worklet still loading
    await starting;
    feed(stems(1000, 0.5), 0);
    expect(rec.state()).toBe("waiting");
    listener({ kind: "bar", time: 1.5, bpm: 145 });
    feed(stems(1000, 0.5), 1000);
    expect(rec.seconds()).toBe(0.5);
  });

  it("takes 10 minutes at 48 kHz, and less at a faster device rate, so the zip stays under 4 GB", () => {
    expect(stemsMaxSeconds(48000)).toBe(STEMS_MAX_SECONDS);
    expect(stemsMaxSeconds(96000)).toBe(STEMS_MAX_SECONDS); // ~3.1 GB
    const seconds = stemsMaxSeconds(192000);
    expect(seconds).toBeLessThan(STEMS_MAX_SECONDS);
    expect(seconds * 192000 * 6 * STEMS.length).toBeLessThan(2 ** 32 - 2 ** 20);
    const rec = createStemsRecorder(engine);
    engine.ensureContext = () => ({ sampleRate: 192000 });
    rec.start();
    expect(rec.maxSeconds()).toBe(stemsMaxSeconds(192000));
  });

  it("stops listening for the bar when stopped before it", async () => {
    const rec = createStemsRecorder(engine);
    await rec.start();
    expect(await rec.stop()).toBeNull();
    expect(listener).toBeNull();
  });

  it("calls onFull once at the maximum length", async () => {
    const rec = createStemsRecorder(engine, { maxSeconds: 1 });
    const full = vi.fn();
    rec.onFull(full);
    await rec.start();
    listener({ kind: "bar", time: 0, bpm: 145 });
    for (let at = 0; at < 3000; at += 600) feed(stems(600, 0.5), at);
    expect(full).toHaveBeenCalledTimes(1);
    expect((await rec.stop()).seconds).toBe(1);
  });

  it("goes back to idle where the browser can't record", async () => {
    engine.tapStems = async () => {
      throw new Error("no AudioWorklet");
    };
    const rec = createStemsRecorder(engine);
    await expect(rec.start()).rejects.toThrow();
    expect(rec.state()).toBe("idle");
    expect(listener).toBeNull();
  });
});
